"""
Message Reliability and Retry Logic.

Implements reliability guarantees for different message classes:
- Critical: ACK required, retry 3x with exponential backoff
- Important: Best-effort + snapshot on reconnect
- Telemetry: Fire-and-forget

Spec Reference: Technical Spec §15.3, Decision E30
"""

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Callable

from .message import Message
from .message import MessageType
from .message import ReliabilityClass
from .message import Response


logger = logging.getLogger(__name__)


# Retry configuration
MAX_RETRIES = 3
INITIAL_BACKOFF_MS = 100
MAX_BACKOFF_MS = 5000
BACKOFF_MULTIPLIER = 2
# Maximum messages to retry per cycle to prevent flooding
MAX_RETRIES_PER_CYCLE = 5

# Buffer limits
IMPORTANT_BUFFER_SIZE = 1000
TELEMETRY_BUFFER_SIZE = 100


@dataclass
class RetryState:
    """Tracks retry state for a message."""

    message: Message
    attempt: int = 0
    next_retry_time: float = 0
    created_at: float = field(default_factory=time.time)


@dataclass
class AckTracker:
    """
    Tracks acknowledgments for critical messages.

    Implements exponential backoff retry logic.
    """

    pending: dict[str, RetryState] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def track(self, message: Message) -> None:
        """
        Start tracking a message for acknowledgment.

        Only CRITICAL messages should be tracked - they require ACK and retry.
        Tracking non-critical messages would waste resources.

        Args:
            message: Message to track

        Note:
            Messages with TELEMETRY or IMPORTANT reliability class are
            skipped as they don't require ACK.
        """
        # Only track messages that require ACK (CRITICAL reliability)
        if message.reliability != ReliabilityClass.CRITICAL:
            logger.debug(
                f"Skipping ACK tracking for non-critical message {message.id} "
                f"(reliability: {message.reliability})"
            )
            return

        async with self._lock:
            self.pending[message.id] = RetryState(
                message=message,
                next_retry_time=time.time() + (INITIAL_BACKOFF_MS / 1000),
            )

    async def acknowledge(self, message_id: str) -> bool:
        """
        Mark a message as acknowledged.

        Returns True if message was pending, False otherwise.
        """
        async with self._lock:
            if message_id in self.pending:
                del self.pending[message_id]
                return True
            return False

    async def get_retry_messages(self) -> list[Message]:
        """
        Get messages that need to be retried.

        Returns messages whose retry time has passed and haven't
        exceeded max retries. Limited to MAX_RETRIES_PER_CYCLE to
        prevent flooding the connection.
        """
        now = time.time()
        retry_messages = []

        async with self._lock:
            expired = []

            for msg_id, state in self.pending.items():
                if state.attempt >= MAX_RETRIES:
                    # Max retries exceeded
                    logger.error(
                        f"Message {msg_id} failed after {MAX_RETRIES} retries"
                    )
                    expired.append(msg_id)
                    continue

                # Rate limit: stop if we've collected enough messages for this cycle
                if len(retry_messages) >= MAX_RETRIES_PER_CYCLE:
                    break

                if now >= state.next_retry_time:
                    # Calculate next backoff
                    backoff_ms = min(
                        INITIAL_BACKOFF_MS * (BACKOFF_MULTIPLIER ** state.attempt),
                        MAX_BACKOFF_MS,
                    )
                    state.attempt += 1
                    state.next_retry_time = now + (backoff_ms / 1000)

                    retry_messages.append(state.message)
                    logger.debug(
                        f"Retrying message {msg_id} (attempt {state.attempt})"
                    )

            # Remove expired messages
            for msg_id in expired:
                del self.pending[msg_id]

        return retry_messages

    def pending_count(self) -> int:
        """Get number of pending messages."""
        return len(self.pending)

    async def get_ready_count(self) -> int:
        """Get number of messages ready to retry (past their retry time)."""
        now = time.time()
        count = 0
        async with self._lock:
            for state in self.pending.values():
                if state.attempt < MAX_RETRIES and now >= state.next_retry_time:
                    count += 1
        return count

    def clear(self) -> None:
        """Clear all pending messages."""
        self.pending.clear()


class MessageBuffer:
    """
    Bounded buffer for important and telemetry messages.

    Important messages are buffered for replay on reconnect.
    Telemetry messages are dropped when buffer is full.

    Per IPC Protocol spec: Sets overflow flag when messages are dropped,
    which should be included in _meta.overflow of the next message sent.
    """

    def __init__(
        self,
        max_size: int = IMPORTANT_BUFFER_SIZE,
        drop_on_full: bool = False,
    ) -> None:
        """
        Initialize buffer.

        Args:
            max_size: Maximum buffer size
            drop_on_full: If True, drop oldest when full. If False, reject new.
        """
        self.max_size = max_size
        self.drop_on_full = drop_on_full
        self._buffer: deque[Message] = deque(maxlen=max_size if drop_on_full else None)
        self._lock = asyncio.Lock()
        self._overflow_occurred = False  # Track if overflow happened
        self._dropped_count = 0  # Count of dropped messages

    @property
    def overflow_occurred(self) -> bool:
        """Check if overflow has occurred since last clear."""
        return self._overflow_occurred

    @property
    def dropped_count(self) -> int:
        """Number of messages dropped due to overflow."""
        return self._dropped_count

    def clear_overflow_flag(self) -> None:
        """Clear the overflow flag (call after including in next message)."""
        self._overflow_occurred = False

    async def push(self, message: Message) -> bool:
        """
        Add message to buffer.

        Returns True if message was added, False if rejected.
        Sets overflow flag if messages are dropped.
        """
        async with self._lock:
            if not self.drop_on_full and len(self._buffer) >= self.max_size:
                logger.warning(f"Buffer full, rejecting message {message.id}")
                self._overflow_occurred = True
                self._dropped_count += 1
                return False

            # Check if deque will drop oldest (when maxlen is set)
            if self.drop_on_full and len(self._buffer) >= self.max_size:
                self._overflow_occurred = True
                self._dropped_count += 1
                logger.debug(f"Buffer overflow: dropping oldest message")

            self._buffer.append(message)
            return True

    async def pop(self) -> Message | None:
        """Remove and return oldest message."""
        async with self._lock:
            if self._buffer:
                return self._buffer.popleft()
            return None

    async def peek(self) -> Message | None:
        """Return oldest message without removing."""
        async with self._lock:
            if self._buffer:
                return self._buffer[0]
            return None

    async def get_all(self) -> list[Message]:
        """Get all messages (for replay on reconnect)."""
        async with self._lock:
            return list(self._buffer)

    async def clear(self) -> None:
        """Clear all messages."""
        async with self._lock:
            self._buffer.clear()

    def size(self) -> int:
        """Get current buffer size."""
        return len(self._buffer)

    def is_empty(self) -> bool:
        """Check if buffer is empty."""
        return len(self._buffer) == 0


@dataclass
class StateSnapshot:
    """
    Snapshot of current state for reconnection.

    Important messages support snapshot replay on reconnect.
    """

    positions: dict[str, Any] = field(default_factory=dict)
    orders: dict[str, Any] = field(default_factory=dict)
    performance: dict[str, Any] = field(default_factory=dict)
    connection_status: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def update_positions(self, positions: dict[str, Any]) -> None:
        """Update positions snapshot."""
        self.positions = positions
        self.timestamp = time.time()

    def update_orders(self, orders: dict[str, Any]) -> None:
        """Update orders snapshot."""
        self.orders = orders
        self.timestamp = time.time()

    def update_performance(self, performance: dict[str, Any]) -> None:
        """Update performance snapshot."""
        self.performance = performance
        self.timestamp = time.time()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "positions": self.positions,
            "orders": self.orders,
            "performance": self.performance,
            "connection_status": self.connection_status,
            "timestamp": self.timestamp,
        }


class ReliabilityManager:
    """
    Manages message reliability for different message classes.

    Coordinates:
    - ACK tracking for critical messages (FIX-P002: all critical messages verified)
    - Buffering for important messages
    - State snapshots for reconnection (FIX-P003)
    - Drop policy for telemetry messages
    """

    def __init__(self) -> None:
        self.ack_tracker = AckTracker()
        self.important_buffer = MessageBuffer(
            max_size=IMPORTANT_BUFFER_SIZE,
            drop_on_full=True,
        )
        self.telemetry_buffer = MessageBuffer(
            max_size=TELEMETRY_BUFFER_SIZE,
            drop_on_full=True,
        )
        self.state_snapshot = StateSnapshot()
        self._running = False
        self._retry_task: asyncio.Task | None = None
        # Callback for actually sending retry messages
        self._send_callback: Callable[[Message], Any] | None = None
        # FIX-P002: Track unacknowledged critical message types for monitoring
        self._critical_message_types: set[MessageType] = {
            MessageType.SESSION_START,
            MessageType.SESSION_STOP,
            MessageType.SESSION_PAUSE,
            MessageType.SESSION_RESUME,
            MessageType.ORDER_SUBMIT,
            MessageType.ORDER_CANCEL,
            MessageType.ORDER_MODIFY,
            MessageType.FLATTEN_REQUEST,
            MessageType.RISK_ACTION,
        }

    def set_send_callback(self, callback: Callable[[Message], Any]) -> None:
        """
        Set the callback for sending retry messages.

        The callback should accept a Message and send it over the transport.
        This is required for the retry mechanism to actually work.
        """
        self._send_callback = callback

    async def start(self) -> None:
        """Start the reliability manager."""
        self._running = True
        self._retry_task = asyncio.create_task(self._retry_loop())

    async def stop(self) -> None:
        """Stop the reliability manager."""
        self._running = False
        if self._retry_task:
            self._retry_task.cancel()
            try:
                await self._retry_task
            except asyncio.CancelledError:
                pass

        self.ack_tracker.clear()
        await self.important_buffer.clear()
        await self.telemetry_buffer.clear()

    async def on_message_sent(self, message: Message) -> None:
        """
        Called when a message is sent.

        Tracks critical messages for ACK, buffers important messages.
        """
        reliability = message.reliability

        if reliability == ReliabilityClass.CRITICAL:
            await self.ack_tracker.track(message)

        elif reliability == ReliabilityClass.IMPORTANT:
            await self.important_buffer.push(message)
            # Update snapshot based on message type
            self._update_snapshot(message)

        # Telemetry messages are fire-and-forget, no tracking

    async def on_ack_received(self, message_id: str) -> bool:
        """
        Called when an ACK is received.

        Returns True if message was pending.
        """
        return await self.ack_tracker.acknowledge(message_id)

    async def get_reconnect_snapshot(self) -> StateSnapshot:
        """Get current state snapshot for reconnection."""
        return self.state_snapshot

    async def get_fresh_reconnect_snapshot(self) -> StateSnapshot:
        """
        Get a fresh state snapshot for reconnection (FIX-P003).

        Ensures the snapshot is up-to-date at the time of reconnection,
        not stale from an earlier point in time.

        Returns:
            Fresh StateSnapshot with current timestamp
        """
        # Update timestamp to mark this as a fresh snapshot
        self.state_snapshot.timestamp = time.time()
        return self.state_snapshot

    def verify_critical_message_tracking(self, message: Message) -> bool:
        """
        Verify that critical messages are properly tracked (FIX-P002).

        All critical-class messages MUST be tracked for ACK to ensure
        reliable delivery.

        Args:
            message: Message to verify

        Returns:
            True if message is tracked or doesn't need tracking
        """
        if message.reliability != ReliabilityClass.CRITICAL:
            return True  # Non-critical messages don't need ACK

        # Verify the message is in the pending set
        return message.id in self.ack_tracker.pending

    def get_unacked_critical_count(self) -> int:
        """Get count of unacknowledged critical messages (FIX-P002)."""
        return self.ack_tracker.pending_count()

    def get_critical_message_stats(self) -> dict[str, Any]:
        """
        Get statistics about critical message tracking (FIX-P002).

        Returns:
            Dict with pending counts, oldest message age, etc.
        """
        pending = self.ack_tracker.pending
        stats = {
            "pending_count": len(pending),
            "oldest_age_seconds": 0.0,
            "message_types": {},
        }

        if pending:
            now = time.time()
            oldest_age = 0.0
            type_counts: dict[str, int] = {}

            for state in pending.values():
                age = now - state.created_at
                if age > oldest_age:
                    oldest_age = age
                msg_type = state.message.type.value
                type_counts[msg_type] = type_counts.get(msg_type, 0) + 1

            stats["oldest_age_seconds"] = oldest_age
            stats["message_types"] = type_counts

        return stats

    def check_overflow(self) -> bool:
        """
        Check if any buffer has experienced overflow.

        Per IPC Protocol spec, the next message should include
        _meta.overflow: true if messages were dropped.

        Returns:
            True if overflow occurred
        """
        return (
            self.important_buffer.overflow_occurred or
            self.telemetry_buffer.overflow_occurred
        )

    def get_overflow_info(self) -> dict[str, Any] | None:
        """
        Get overflow information for message metadata.

        Returns dict with overflow details if overflow occurred,
        None otherwise. Clears the overflow flag after reading.
        """
        if not self.check_overflow():
            return None

        info = {
            "overflow": True,
            "importantDropped": self.important_buffer.dropped_count,
            "telemetryDropped": self.telemetry_buffer.dropped_count,
        }

        # Clear flags after reading
        self.important_buffer.clear_overflow_flag()
        self.telemetry_buffer.clear_overflow_flag()

        return info

    def _update_snapshot(self, message: Message) -> None:
        """Update state snapshot based on message."""
        if message.type == MessageType.POSITIONS_UPDATE:
            self.state_snapshot.update_positions(message.payload)
        elif message.type == MessageType.ORDERS_UPDATE:
            self.state_snapshot.update_orders(message.payload)
        elif message.type == MessageType.PERFORMANCE_UPDATE:
            self.state_snapshot.update_performance(message.payload)

    async def _retry_loop(self) -> None:
        """Background loop to retry unacknowledged messages."""
        while self._running:
            try:
                messages = await self.ack_tracker.get_retry_messages()

                # Log if rate limiting is in effect
                if messages:
                    ready_count = await self.ack_tracker.get_ready_count()
                    if ready_count > 0:
                        logger.debug(
                            f"Rate limiting in effect: {len(messages)} retried, "
                            f"{ready_count} more waiting"
                        )

                for message in messages:
                    if self._send_callback is not None:
                        try:
                            # Actually resend the message
                            result = self._send_callback(message)
                            # Handle async callbacks
                            if asyncio.iscoroutine(result):
                                await result
                            logger.info(f"Retried message {message.id} (type: {message.type.value})")
                        except Exception as e:
                            logger.error(f"Failed to retry message {message.id}: {e}")
                    else:
                        logger.warning(
                            f"Cannot retry message {message.id}: no send callback configured"
                        )

                await asyncio.sleep(0.1)  # Check every 100ms

            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Error in retry loop")
                await asyncio.sleep(1)
