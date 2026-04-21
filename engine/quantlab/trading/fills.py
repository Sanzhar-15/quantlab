"""
Fill Reconciliation Module.

Provides fill tracking and idempotent fill processing to ensure
each fill is applied exactly once, even across reconnections.

Spec Reference: Technical Spec §8, Fill Idempotency Requirements
"""

import json
import logging
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any
from typing import Callable

from .positions import PositionTracker


logger = logging.getLogger(__name__)


class FillStatus(Enum):
    """Status of a fill in the reconciliation system."""

    PENDING = "pending"  # Received but not yet applied
    APPLIED = "applied"  # Successfully applied to position
    DUPLICATE = "duplicate"  # Already processed (idempotency check)
    REJECTED = "rejected"  # Rejected (e.g., stale, invalid)
    ERROR = "error"  # Error during processing


@dataclass
class Fill:
    """Represents a trade fill from the broker."""

    fill_id: str
    broker_order_id: str
    client_order_id: str
    symbol: str
    side: str  # "buy" or "sell"
    quantity: Decimal
    price: Decimal
    commission: Decimal = Decimal("0")
    timestamp: datetime = field(default_factory=datetime.now)
    execution_venue: str = ""
    liquidity: str = ""  # "maker" or "taker"
    raw_data: dict[str, Any] = field(default_factory=dict)
    # Sequence number for ordering validation (broker-provided or derived)
    sequence_number: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result = {
            "fillId": self.fill_id,
            "brokerOrderId": self.broker_order_id,
            "clientOrderId": self.client_order_id,
            "symbol": self.symbol,
            "side": self.side,
            "quantity": str(self.quantity),
            "price": str(self.price),
            "commission": str(self.commission),
            "timestamp": self.timestamp.isoformat(),
            "executionVenue": self.execution_venue,
            "liquidity": self.liquidity,
        }
        if self.sequence_number is not None:
            result["sequenceNumber"] = self.sequence_number
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Fill":
        """Create from dictionary."""
        return cls(
            fill_id=data["fillId"],
            broker_order_id=data["brokerOrderId"],
            client_order_id=data["clientOrderId"],
            symbol=data["symbol"],
            side=data["side"],
            quantity=Decimal(data["quantity"]),
            price=Decimal(data["price"]),
            commission=Decimal(data.get("commission", "0")),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            execution_venue=data.get("executionVenue", ""),
            liquidity=data.get("liquidity", ""),
            sequence_number=data.get("sequenceNumber"),
        )


@dataclass
class FillReconciliationResult:
    """Result of processing a fill."""

    fill_id: str
    status: FillStatus
    message: str = ""
    position_updated: bool = False
    previous_quantity: Decimal | None = None
    new_quantity: Decimal | None = None


@dataclass
class FillReconciliationState:
    """Persistent state for fill reconciliation."""

    session_id: str
    # Use list for FIFO ordering - new fills appended, oldest trimmed from front
    processed_fill_ids: list[str] = field(default_factory=list)
    # Set for O(1) membership checking (kept in sync with list)
    _processed_fill_ids_set: set[str] = field(default_factory=set, repr=False)
    pending_fills: list[Fill] = field(default_factory=list)
    last_fill_timestamp: datetime | None = None
    total_fills_processed: int = 0
    total_duplicates_rejected: int = 0
    # Sequence tracking for out-of-order detection
    last_sequence_number: int = 0
    out_of_order_fills: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for persistence."""
        return {
            "sessionId": self.session_id,
            "processedFillIds": self.processed_fill_ids,  # Already a list
            "pendingFills": [f.to_dict() for f in self.pending_fills],
            "lastFillTimestamp": (
                self.last_fill_timestamp.isoformat()
                if self.last_fill_timestamp
                else None
            ),
            "totalFillsProcessed": self.total_fills_processed,
            "totalDuplicatesRejected": self.total_duplicates_rejected,
            "lastSequenceNumber": self.last_sequence_number,
            "outOfOrderFills": self.out_of_order_fills,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FillReconciliationState":
        """Create from dictionary."""
        fill_ids_list = list(data.get("processedFillIds", []))
        state = cls(
            session_id=data["sessionId"],
            processed_fill_ids=fill_ids_list,
            _processed_fill_ids_set=set(fill_ids_list),
            total_fills_processed=data.get("totalFillsProcessed", 0),
            total_duplicates_rejected=data.get("totalDuplicatesRejected", 0),
            last_sequence_number=data.get("lastSequenceNumber", 0),
            out_of_order_fills=data.get("outOfOrderFills", 0),
        )
        if data.get("lastFillTimestamp"):
            state.last_fill_timestamp = datetime.fromisoformat(
                data["lastFillTimestamp"]
            )
        state.pending_fills = [
            Fill.from_dict(f) for f in data.get("pendingFills", [])
        ]
        return state


class FillReconciler:
    """
    Ensures idempotent fill processing.

    Key responsibilities:
    - Track all processed fill IDs to prevent duplicates
    - Apply fills to positions exactly once
    - Persist state for recovery after disconnections
    - Reconcile fills after reconnection

    Idempotency Guarantees:
    - Each fill_id is processed at most once
    - State is persisted before acknowledging a fill
    - After restart, pending fills are reprocessed
    """

    # Maximum fill IDs to keep in memory (rolling window)
    MAX_FILL_ID_HISTORY = 100000

    def __init__(
        self,
        session_id: str,
        position_tracker: PositionTracker,
        state_dir: Path | None = None,
        on_fill_applied: Callable[[Fill], None] | None = None,
    ) -> None:
        """
        Initialize fill reconciler.

        Args:
            session_id: Trading session ID
            position_tracker: Position tracker to update
            state_dir: Directory for state persistence
            on_fill_applied: Callback when fill is successfully applied
        """
        self._session_id = session_id
        self._position_tracker = position_tracker
        self._state_dir = state_dir or Path.home() / ".quantlab" / "sessions"
        self._on_fill_applied = on_fill_applied

        # Initialize state
        self._state = FillReconciliationState(session_id=session_id)

        # Load persisted state if available
        self._load_state()

    @property
    def total_processed(self) -> int:
        """Total fills processed."""
        return self._state.total_fills_processed

    @property
    def total_duplicates(self) -> int:
        """Total duplicate fills rejected."""
        return self._state.total_duplicates_rejected

    def process_fill(self, fill: Fill) -> FillReconciliationResult:
        """
        Process a fill with idempotency guarantee.

        Args:
            fill: Fill to process

        Returns:
            FillReconciliationResult with status
        """
        # Check for duplicate (use set for O(1) lookup)
        if fill.fill_id in self._state._processed_fill_ids_set:
            self._state.total_duplicates_rejected += 1
            logger.debug(f"Duplicate fill rejected: {fill.fill_id}")
            return FillReconciliationResult(
                fill_id=fill.fill_id,
                status=FillStatus.DUPLICATE,
                message="Fill already processed",
            )

        # Validate fill
        validation_error = self._validate_fill(fill)
        if validation_error:
            logger.warning(f"Fill validation failed: {validation_error}")
            return FillReconciliationResult(
                fill_id=fill.fill_id,
                status=FillStatus.REJECTED,
                message=validation_error,
            )

        # Check sequence ordering if sequence number is provided
        if fill.sequence_number is not None:
            if fill.sequence_number <= self._state.last_sequence_number:
                # Out of order fill detected - log warning but still process
                # (fills may legitimately arrive out of order from broker)
                self._state.out_of_order_fills += 1
                logger.warning(
                    f"Out-of-order fill detected: {fill.fill_id} "
                    f"seq={fill.sequence_number} (expected > {self._state.last_sequence_number})"
                )
            else:
                self._state.last_sequence_number = fill.sequence_number

        # Apply fill to position
        try:
            result = self._apply_fill(fill)

            # Mark as processed (add to both list and set)
            self._state.processed_fill_ids.append(fill.fill_id)
            self._state._processed_fill_ids_set.add(fill.fill_id)
            self._state.total_fills_processed += 1
            self._state.last_fill_timestamp = fill.timestamp

            # Trim history if needed
            self._trim_fill_history()

            # Persist state immediately
            self._save_state()

            # Callback
            if self._on_fill_applied:
                self._on_fill_applied(fill)

            logger.info(
                f"Fill processed: {fill.fill_id} - {fill.symbol} "
                f"{fill.side} {fill.quantity} @ {fill.price}"
            )

            return result

        except Exception as e:
            logger.error(f"Error applying fill {fill.fill_id}: {e}")
            return FillReconciliationResult(
                fill_id=fill.fill_id,
                status=FillStatus.ERROR,
                message=str(e),
            )

    def process_fills_batch(self, fills: list[Fill]) -> list[FillReconciliationResult]:
        """
        Process multiple fills.

        Args:
            fills: List of fills to process

        Returns:
            List of results for each fill
        """
        results = []
        for fill in fills:
            result = self.process_fill(fill)
            results.append(result)
        return results

    def is_fill_processed(self, fill_id: str) -> bool:
        """Check if a fill has already been processed."""
        return fill_id in self._state._processed_fill_ids_set

    def get_last_fill_timestamp(self) -> datetime | None:
        """Get timestamp of last processed fill."""
        return self._state.last_fill_timestamp

    def reconcile_after_reconnect(
        self,
        broker_fills: list[Fill],
        since: datetime | None = None,
    ) -> list[FillReconciliationResult]:
        """
        Reconcile fills after a reconnection.

        Fetches fills from broker since last known timestamp
        and processes any missed fills.

        Args:
            broker_fills: Fills from broker since reconnection
            since: Only process fills after this timestamp

        Returns:
            Results for any newly processed fills
        """
        results = []
        since_ts = since or self._state.last_fill_timestamp

        for fill in broker_fills:
            # Skip fills before our cutoff
            if since_ts and fill.timestamp <= since_ts:
                continue

            result = self.process_fill(fill)
            if result.status not in (FillStatus.DUPLICATE, FillStatus.REJECTED):
                results.append(result)

        logger.info(
            f"Reconnection reconciliation: processed {len(results)} new fills "
            f"out of {len(broker_fills)} broker fills"
        )

        return results

    def add_pending_fill(self, fill: Fill) -> None:
        """
        Add a fill to pending queue (for deferred processing).

        Used when fills arrive before orders are confirmed.
        """
        if fill.fill_id not in self._state._processed_fill_ids_set:
            self._state.pending_fills.append(fill)
            self._save_state()

    def process_pending_fills(self) -> list[FillReconciliationResult]:
        """Process all pending fills."""
        results = []
        pending = list(self._state.pending_fills)
        self._state.pending_fills.clear()

        for fill in pending:
            result = self.process_fill(fill)
            results.append(result)

        return results

    def get_state(self) -> FillReconciliationState:
        """Get current reconciliation state."""
        return self._state

    def reset(self) -> None:
        """Reset reconciliation state (use with caution)."""
        self._state = FillReconciliationState(session_id=self._session_id)
        self._save_state()
        logger.warning("Fill reconciliation state reset")

    def _validate_fill(self, fill: Fill) -> str | None:
        """Validate fill data. Returns error message or None."""
        if not fill.fill_id:
            return "Missing fill ID"
        if not fill.symbol:
            return "Missing symbol"
        # Case-insensitive side validation (brokers may send "BUY"/"SELL" or "buy"/"sell")
        if fill.side.lower() not in ("buy", "sell"):
            return f"Invalid side: {fill.side}"
        if fill.quantity <= 0:
            return f"Invalid quantity: {fill.quantity}"
        if fill.price <= 0:
            return f"Invalid price: {fill.price}"
        return None

    def _apply_fill(self, fill: Fill) -> FillReconciliationResult:
        """Apply fill to position tracker."""
        from .orders import OrderSide

        # Get or create position
        position = self._position_tracker.get_or_create_position(
            self._session_id, fill.symbol
        )
        previous_qty = position.quantity

        # Convert fill to internal Fill type and apply using proper method
        from .orders import Fill as OrderFill

        internal_fill = OrderFill(
            fill_id=fill.fill_id,
            order_id=fill.broker_order_id,
            quantity=fill.quantity,
            price=fill.price,
            commission=fill.commission,
            timestamp=fill.timestamp,
        )

        # Determine order side and apply fill (case-insensitive)
        if fill.side.lower() == "buy":
            position.apply_fill(internal_fill, OrderSide.BUY)
        else:  # sell
            position.apply_fill(internal_fill, OrderSide.SELL)

        return FillReconciliationResult(
            fill_id=fill.fill_id,
            status=FillStatus.APPLIED,
            message="Fill applied successfully",
            position_updated=True,
            previous_quantity=previous_qty,
            new_quantity=position.quantity,
        )

    def _trim_fill_history(self) -> None:
        """Trim fill ID history to prevent unbounded growth.

        Uses FIFO ordering - removes oldest fill IDs first to ensure
        recent fills are always protected from duplicate processing.
        """
        if len(self._state.processed_fill_ids) > self.MAX_FILL_ID_HISTORY:
            # Keep most recent half - remove oldest entries (front of list)
            to_remove = len(self._state.processed_fill_ids) - (
                self.MAX_FILL_ID_HISTORY // 2
            )
            # Remove oldest fill IDs (FIFO - from front of list)
            removed_ids = self._state.processed_fill_ids[:to_remove]
            self._state.processed_fill_ids = self._state.processed_fill_ids[to_remove:]
            # Update the set to match
            for fill_id in removed_ids:
                self._state._processed_fill_ids_set.discard(fill_id)

    def _load_state(self) -> None:
        """Load state from disk."""
        state_file = self._state_dir / f"{self._session_id}_fills.json"
        if state_file.exists():
            try:
                with open(state_file, "r") as f:
                    data = json.load(f)
                self._state = FillReconciliationState.from_dict(data)
                logger.info(
                    f"Loaded fill reconciliation state: "
                    f"{len(self._state.processed_fill_ids)} processed fills"
                )
            except Exception as e:
                logger.error(f"Failed to load fill state: {e}")

    def _save_state(self) -> None:
        """Save state to disk atomically (temp + rename)."""
        import os
        import tempfile

        self._state_dir.mkdir(parents=True, exist_ok=True)
        state_file = self._state_dir / f"{self._session_id}_fills.json"
        tmp_path = None

        try:
            # Write to temporary file first
            with tempfile.NamedTemporaryFile(
                mode="w",
                dir=self._state_dir,
                prefix=f"{self._session_id}_fills_",
                suffix=".tmp",
                delete=False,
            ) as tmp:
                json.dump(self._state.to_dict(), tmp, indent=2)
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_path = tmp.name

            # Atomic rename
            os.replace(tmp_path, state_file)

        except Exception as e:
            logger.error(f"Failed to save fill state: {e}")
            # Clean up temp file if it exists
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


class FillAggregator:
    """
    Aggregates partial fills for an order.

    Tracks multiple fills that may arrive for a single order
    and provides aggregate statistics.
    """

    def __init__(self) -> None:
        """Initialize aggregator."""
        self._order_fills: dict[str, list[Fill]] = {}

    def add_fill(self, fill: Fill) -> None:
        """Add a fill for aggregation."""
        order_id = fill.client_order_id or fill.broker_order_id
        if order_id not in self._order_fills:
            self._order_fills[order_id] = []
        self._order_fills[order_id].append(fill)

    def get_order_fills(self, order_id: str) -> list[Fill]:
        """Get all fills for an order."""
        return self._order_fills.get(order_id, [])

    def get_filled_quantity(self, order_id: str) -> Decimal:
        """Get total filled quantity for an order."""
        fills = self.get_order_fills(order_id)
        return sum((f.quantity for f in fills), Decimal("0"))

    def get_average_fill_price(self, order_id: str) -> Decimal | None:
        """Get volume-weighted average fill price."""
        fills = self.get_order_fills(order_id)
        if not fills:
            return None

        total_value = sum((f.quantity * f.price for f in fills), Decimal("0"))
        total_qty = sum((f.quantity for f in fills), Decimal("0"))

        if total_qty == 0:
            return None
        return total_value / total_qty

    def get_total_commission(self, order_id: str) -> Decimal:
        """Get total commission for an order."""
        fills = self.get_order_fills(order_id)
        return sum((f.commission for f in fills), Decimal("0"))

    def is_order_complete(self, order_id: str, expected_qty: Decimal) -> bool:
        """Check if order is completely filled."""
        filled = self.get_filled_quantity(order_id)
        return filled >= expected_qty

    def clear_order(self, order_id: str) -> None:
        """Clear fills for a completed order."""
        self._order_fills.pop(order_id, None)

    def clear_all(self) -> None:
        """Clear all aggregated fills."""
        self._order_fills.clear()
