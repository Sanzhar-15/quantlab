"""
Tests for Message Reliability and Retry Logic.

Tests reliability guarantees for different message classes.
"""

import asyncio
import time
from datetime import datetime

import pytest

from quantlab.protocol.reliability import (
    RetryState,
    AckTracker,
    MessageBuffer,
    StateSnapshot,
    ReliabilityManager,
    MAX_RETRIES,
    IMPORTANT_BUFFER_SIZE,
    TELEMETRY_BUFFER_SIZE,
)
from quantlab.protocol.message import (
    Message,
    MessageType,
    ReliabilityClass,
)


class TestRetryState:
    """Tests for RetryState dataclass."""

    def test_creation(self) -> None:
        """Test retry state creation."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={"session_id": "test"},
        )
        state = RetryState(message=message)

        assert state.message == message
        assert state.attempt == 0
        assert state.next_retry_time == 0
        assert state.created_at > 0

    def test_with_retry_time(self) -> None:
        """Test retry state with custom retry time."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )
        state = RetryState(
            message=message,
            attempt=2,
            next_retry_time=time.time() + 5.0,
        )

        assert state.attempt == 2
        assert state.next_retry_time > time.time()


class TestAckTracker:
    """Tests for AckTracker class."""

    @pytest.fixture
    def tracker(self) -> AckTracker:
        """Create an ACK tracker."""
        return AckTracker()

    @pytest.mark.asyncio
    async def test_track_message(self, tracker) -> None:
        """Test tracking a message."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )

        await tracker.track(message)

        assert message.id in tracker.pending
        assert tracker.pending_count() == 1

    @pytest.mark.asyncio
    async def test_acknowledge_success(self, tracker) -> None:
        """Test acknowledging a pending message."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )
        await tracker.track(message)

        result = await tracker.acknowledge(message.id)

        assert result is True
        assert message.id not in tracker.pending

    @pytest.mark.asyncio
    async def test_acknowledge_unknown(self, tracker) -> None:
        """Test acknowledging unknown message."""
        result = await tracker.acknowledge("unknown-id")
        assert result is False

    @pytest.mark.asyncio
    async def test_get_retry_messages_none_ready(self, tracker) -> None:
        """Test getting retry messages when none ready."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )
        await tracker.track(message)

        # Set retry time in the future
        tracker.pending[message.id].next_retry_time = time.time() + 100

        messages = await tracker.get_retry_messages()
        assert len(messages) == 0

    @pytest.mark.asyncio
    async def test_get_retry_messages_ready(self, tracker) -> None:
        """Test getting retry messages when ready."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )
        await tracker.track(message)

        # Set retry time in the past
        tracker.pending[message.id].next_retry_time = time.time() - 1

        messages = await tracker.get_retry_messages()
        assert len(messages) == 1
        assert messages[0].id == message.id
        # Attempt should be incremented
        assert tracker.pending[message.id].attempt == 1

    @pytest.mark.asyncio
    async def test_get_retry_messages_max_retries(self, tracker) -> None:
        """Test that messages exceeding max retries are removed."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )
        await tracker.track(message)

        # Set attempt to max retries
        tracker.pending[message.id].attempt = MAX_RETRIES
        tracker.pending[message.id].next_retry_time = time.time() - 1

        messages = await tracker.get_retry_messages()

        # Message should be removed, not returned
        assert len(messages) == 0
        assert message.id not in tracker.pending

    def test_pending_count(self, tracker) -> None:
        """Test pending count."""
        assert tracker.pending_count() == 0

        message = Message(type=MessageType.SESSION_START, payload={})
        tracker.pending[message.id] = RetryState(message=message)

        assert tracker.pending_count() == 1

    def test_clear(self, tracker) -> None:
        """Test clearing pending messages."""
        message = Message(type=MessageType.SESSION_START, payload={})
        tracker.pending[message.id] = RetryState(message=message)

        tracker.clear()

        assert tracker.pending_count() == 0


class TestMessageBuffer:
    """Tests for MessageBuffer class."""

    @pytest.fixture
    def buffer(self) -> MessageBuffer:
        """Create a message buffer."""
        return MessageBuffer(max_size=10, drop_on_full=False)

    @pytest.fixture
    def drop_buffer(self) -> MessageBuffer:
        """Create a drop-on-full buffer."""
        return MessageBuffer(max_size=3, drop_on_full=True)

    @pytest.mark.asyncio
    async def test_push(self, buffer) -> None:
        """Test pushing to buffer."""
        message = Message(type=MessageType.POSITIONS_UPDATE, payload={})

        result = await buffer.push(message)

        assert result is True
        assert buffer.size() == 1

    @pytest.mark.asyncio
    async def test_push_reject_when_full(self, buffer) -> None:
        """Test rejecting messages when buffer is full."""
        buffer.max_size = 2

        msg1 = Message(type=MessageType.POSITIONS_UPDATE, payload={})
        msg2 = Message(type=MessageType.ORDERS_UPDATE, payload={})
        msg3 = Message(type=MessageType.FILLS_UPDATE, payload={})

        await buffer.push(msg1)
        await buffer.push(msg2)
        result = await buffer.push(msg3)

        assert result is False
        assert buffer.size() == 2

    @pytest.mark.asyncio
    async def test_push_drop_oldest(self, drop_buffer) -> None:
        """Test dropping oldest when buffer is full."""
        msg1 = Message(type=MessageType.POSITIONS_UPDATE, payload={"n": 1})
        msg2 = Message(type=MessageType.ORDERS_UPDATE, payload={"n": 2})
        msg3 = Message(type=MessageType.FILLS_UPDATE, payload={"n": 3})
        msg4 = Message(type=MessageType.HEARTBEAT, payload={"n": 4})

        await drop_buffer.push(msg1)
        await drop_buffer.push(msg2)
        await drop_buffer.push(msg3)
        result = await drop_buffer.push(msg4)

        assert result is True
        assert drop_buffer.size() == 3

        # First message should be msg2 (msg1 was dropped)
        first = await drop_buffer.peek()
        assert first.payload.get("n") == 2

    @pytest.mark.asyncio
    async def test_pop(self, buffer) -> None:
        """Test popping from buffer."""
        msg1 = Message(type=MessageType.POSITIONS_UPDATE, payload={"n": 1})
        msg2 = Message(type=MessageType.ORDERS_UPDATE, payload={"n": 2})

        await buffer.push(msg1)
        await buffer.push(msg2)

        popped = await buffer.pop()
        assert popped.id == msg1.id
        assert buffer.size() == 1

    @pytest.mark.asyncio
    async def test_pop_empty(self, buffer) -> None:
        """Test popping from empty buffer."""
        result = await buffer.pop()
        assert result is None

    @pytest.mark.asyncio
    async def test_peek(self, buffer) -> None:
        """Test peeking at buffer."""
        msg1 = Message(type=MessageType.POSITIONS_UPDATE, payload={})
        await buffer.push(msg1)

        peeked = await buffer.peek()
        assert peeked.id == msg1.id
        assert buffer.size() == 1  # Not removed

    @pytest.mark.asyncio
    async def test_peek_empty(self, buffer) -> None:
        """Test peeking at empty buffer."""
        result = await buffer.peek()
        assert result is None

    @pytest.mark.asyncio
    async def test_get_all(self, buffer) -> None:
        """Test getting all messages."""
        msg1 = Message(type=MessageType.POSITIONS_UPDATE, payload={})
        msg2 = Message(type=MessageType.ORDERS_UPDATE, payload={})

        await buffer.push(msg1)
        await buffer.push(msg2)

        messages = await buffer.get_all()
        assert len(messages) == 2
        assert buffer.size() == 2  # Still in buffer

    @pytest.mark.asyncio
    async def test_clear(self, buffer) -> None:
        """Test clearing buffer."""
        msg = Message(type=MessageType.POSITIONS_UPDATE, payload={})
        await buffer.push(msg)

        await buffer.clear()

        assert buffer.size() == 0

    def test_is_empty(self, buffer) -> None:
        """Test is_empty."""
        assert buffer.is_empty() is True

        msg = Message(type=MessageType.POSITIONS_UPDATE, payload={})
        buffer._buffer.append(msg)

        assert buffer.is_empty() is False


class TestStateSnapshot:
    """Tests for StateSnapshot dataclass."""

    def test_creation(self) -> None:
        """Test snapshot creation."""
        snapshot = StateSnapshot()

        assert snapshot.positions == {}
        assert snapshot.orders == {}
        assert snapshot.performance == {}
        assert snapshot.timestamp > 0

    def test_update_positions(self) -> None:
        """Test updating positions."""
        snapshot = StateSnapshot()
        old_timestamp = snapshot.timestamp

        positions = {"AAPL": {"quantity": 100, "price": 150}}
        time.sleep(0.01)  # Ensure timestamp changes
        snapshot.update_positions(positions)

        assert snapshot.positions == positions
        assert snapshot.timestamp > old_timestamp

    def test_update_orders(self) -> None:
        """Test updating orders."""
        snapshot = StateSnapshot()

        orders = {"order-001": {"symbol": "AAPL", "quantity": 100}}
        snapshot.update_orders(orders)

        assert snapshot.orders == orders

    def test_update_performance(self) -> None:
        """Test updating performance."""
        snapshot = StateSnapshot()

        performance = {"total_return": 0.15, "sharpe": 1.2}
        snapshot.update_performance(performance)

        assert snapshot.performance == performance

    def test_to_dict(self) -> None:
        """Test converting to dictionary."""
        snapshot = StateSnapshot()
        snapshot.positions = {"AAPL": {"qty": 100}}
        snapshot.orders = {"order-001": {}}

        result = snapshot.to_dict()

        assert "positions" in result
        assert "orders" in result
        assert "performance" in result
        assert "connection_status" in result
        assert "timestamp" in result


class TestReliabilityManager:
    """Tests for ReliabilityManager class."""

    @pytest.fixture
    def manager(self) -> ReliabilityManager:
        """Create a reliability manager."""
        return ReliabilityManager()

    def test_init(self, manager) -> None:
        """Test manager initialization."""
        assert manager.ack_tracker is not None
        assert manager.important_buffer is not None
        assert manager.telemetry_buffer is not None
        assert manager.state_snapshot is not None
        assert manager._running is False

    @pytest.mark.asyncio
    async def test_start_stop(self, manager) -> None:
        """Test starting and stopping manager."""
        await manager.start()

        assert manager._running is True
        assert manager._retry_task is not None

        await manager.stop()

        assert manager._running is False

    @pytest.mark.asyncio
    async def test_on_message_sent_critical(self, manager) -> None:
        """Test handling critical message sent."""
        message = Message(
            type=MessageType.SESSION_START,  # Critical type
            payload={},
        )

        await manager.on_message_sent(message)

        # Should be tracked in ACK tracker
        assert manager.ack_tracker.pending_count() == 1

    @pytest.mark.asyncio
    async def test_on_message_sent_important(self, manager) -> None:
        """Test handling important message sent."""
        message = Message(
            type=MessageType.POSITIONS_UPDATE,  # Important type
            payload={"AAPL": {"quantity": 100}},
        )

        await manager.on_message_sent(message)

        # Should be buffered
        assert manager.important_buffer.size() == 1
        # Snapshot should be updated
        assert "AAPL" in manager.state_snapshot.positions

    @pytest.mark.asyncio
    async def test_on_message_sent_telemetry(self, manager) -> None:
        """Test handling telemetry message sent (fire and forget)."""
        message = Message(
            type=MessageType.HEARTBEAT,  # Telemetry type
            payload={},
        )

        await manager.on_message_sent(message)

        # Should not be tracked or buffered
        assert manager.ack_tracker.pending_count() == 0

    @pytest.mark.asyncio
    async def test_on_ack_received(self, manager) -> None:
        """Test handling ACK received."""
        message = Message(
            type=MessageType.SESSION_START,
            payload={},
        )
        await manager.ack_tracker.track(message)

        result = await manager.on_ack_received(message.id)

        assert result is True
        assert manager.ack_tracker.pending_count() == 0

    @pytest.mark.asyncio
    async def test_get_reconnect_snapshot(self, manager) -> None:
        """Test getting reconnect snapshot."""
        manager.state_snapshot.positions = {"AAPL": {"qty": 100}}

        snapshot = await manager.get_reconnect_snapshot()

        assert snapshot.positions == {"AAPL": {"qty": 100}}

    @pytest.mark.asyncio
    async def test_update_snapshot_positions(self, manager) -> None:
        """Test snapshot update for positions message."""
        message = Message(
            type=MessageType.POSITIONS_UPDATE,
            payload={"AAPL": {"quantity": 200}},
        )

        manager._update_snapshot(message)

        assert manager.state_snapshot.positions == {"AAPL": {"quantity": 200}}

    @pytest.mark.asyncio
    async def test_update_snapshot_orders(self, manager) -> None:
        """Test snapshot update for orders message."""
        message = Message(
            type=MessageType.ORDERS_UPDATE,
            payload={"order-001": {"symbol": "AAPL"}},
        )

        manager._update_snapshot(message)

        assert manager.state_snapshot.orders == {"order-001": {"symbol": "AAPL"}}

    @pytest.mark.asyncio
    async def test_update_snapshot_performance(self, manager) -> None:
        """Test snapshot update for performance message."""
        message = Message(
            type=MessageType.PERFORMANCE_UPDATE,
            payload={"total_return": 0.25},
        )

        manager._update_snapshot(message)

        assert manager.state_snapshot.performance == {"total_return": 0.25}
