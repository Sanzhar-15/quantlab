"""
Partial Fill Management.

Handles partial fill logic, tracking, and order splitting.

Spec Reference: Technical Spec §3.3
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from typing import Any


@dataclass
class PartialFill:
    """Record of a partial fill."""

    fill_id: str
    order_id: str
    fill_number: int  # 1, 2, 3... for each partial
    quantity: Decimal
    price: Decimal
    timestamp: datetime
    bar_index: int
    commission: Decimal = Decimal("0")


@dataclass
class OrderFillState:
    """
    Track fill state for an order.

    Maintains running totals for partial fills.
    """

    order_id: str
    original_quantity: Decimal
    filled_quantity: Decimal = Decimal("0")
    fills: list[PartialFill] = field(default_factory=list)
    avg_fill_price: Decimal | None = None
    total_commission: Decimal = Decimal("0")

    @property
    def remaining_quantity(self) -> Decimal:
        """Calculate remaining unfilled quantity."""
        return self.original_quantity - self.filled_quantity

    @property
    def fill_ratio(self) -> Decimal:
        """Calculate percentage filled."""
        if self.original_quantity == Decimal("0"):
            return Decimal("0")
        return self.filled_quantity / self.original_quantity

    @property
    def is_complete(self) -> bool:
        """Check if order is completely filled."""
        return self.remaining_quantity == Decimal("0")

    @property
    def is_partially_filled(self) -> bool:
        """Check if order has partial fills but is not complete."""
        return self.filled_quantity > Decimal("0") and not self.is_complete

    @property
    def num_fills(self) -> int:
        """Number of partial fills."""
        return len(self.fills)

    def add_fill(self, fill: PartialFill) -> None:
        """
        Add a partial fill to this order.

        Updates running averages and totals.
        """
        self.fills.append(fill)
        self.filled_quantity += fill.quantity
        self.total_commission += fill.commission

        # Recalculate average fill price
        total_value = sum(f.quantity * f.price for f in self.fills)
        self.avg_fill_price = total_value / self.filled_quantity


class PartialFillTracker:
    """
    Track partial fills across all orders.

    Maintains fill state for pending and partially filled orders.
    """

    def __init__(self) -> None:
        self._orders: dict[str, OrderFillState] = {}
        self._fill_counter = 0

    def register_order(
        self,
        order_id: str,
        quantity: Decimal,
    ) -> OrderFillState:
        """Register a new order for fill tracking."""
        state = OrderFillState(
            order_id=order_id,
            original_quantity=quantity,
        )
        self._orders[order_id] = state
        return state

    # Alias for test compatibility
    def create_order(self, order_id: str, quantity: Decimal) -> OrderFillState:
        """Alias for register_order (test compatibility)."""
        return self.register_order(order_id, quantity)

    def record_fill(
        self,
        order_id: str,
        quantity: Decimal,
        price: Decimal | None = None,
        timestamp: datetime | None = None,
        bar_index: int = 0,
        commission: Decimal = Decimal("0"),
    ) -> PartialFill:
        """
        Record a fill for an order.

        Args:
            order_id: Order identifier
            quantity: Fill quantity
            price: Fill price
            timestamp: Fill timestamp
            bar_index: Bar index of fill
            commission: Commission for this fill

        Returns:
            PartialFill record
        """
        if order_id not in self._orders:
            # Auto-register if not tracked
            self.register_order(order_id, quantity)

        state = self._orders[order_id]

        # Generate fill ID
        self._fill_counter += 1
        fill_id = f"fill-{self._fill_counter:08d}"

        # Default values for optional params
        fill_price = price if price is not None else Decimal("0")
        fill_timestamp = timestamp if timestamp is not None else datetime.now()

        fill = PartialFill(
            fill_id=fill_id,
            order_id=order_id,
            fill_number=state.num_fills + 1,
            quantity=quantity,
            price=fill_price,
            timestamp=fill_timestamp,
            bar_index=bar_index,
            commission=commission,
        )

        state.add_fill(fill)
        return fill

    def get_state(self, order_id: str) -> OrderFillState | None:
        """Get fill state for an order."""
        return self._orders.get(order_id)

    def get_remaining(self, order_id: str) -> Decimal:
        """Get remaining quantity for an order."""
        state = self._orders.get(order_id)
        if state is None:
            return Decimal("0")
        return state.remaining_quantity

    def is_complete(self, order_id: str) -> bool:
        """Check if order is completely filled."""
        state = self._orders.get(order_id)
        if state is None:
            return False
        return state.is_complete

    def remove_order(self, order_id: str) -> OrderFillState | None:
        """Remove order from tracking and return final state."""
        return self._orders.pop(order_id, None)

    def get_all_incomplete(self) -> list[str]:
        """Get all order IDs with partial fills not yet complete."""
        return [
            order_id
            for order_id, state in self._orders.items()
            if not state.is_complete
        ]


@dataclass
class PartialFillConfig:
    """Configuration for partial fill behavior."""

    # Minimum fill size (smaller fills rejected)
    min_fill_quantity: Decimal = Decimal("1")

    # Maximum number of partial fills per order
    max_partial_fills: int = 10

    # Whether to allow fractional shares
    allow_fractional: bool = False

    # Round lot size (0 = no rounding)
    lot_size: Decimal = Decimal("0")


class PartialFillValidator:
    """
    Validate partial fills against configuration.

    Ensures fills meet minimum size and other constraints.
    """

    def __init__(self, config: PartialFillConfig | None = None) -> None:
        self.config = config or PartialFillConfig()

    def validate_fill(
        self,
        fill_quantity: Decimal,
        remaining_quantity: Decimal,
        fill_count: int,
    ) -> tuple[bool, str]:
        """
        Validate a proposed partial fill.

        Returns:
            Tuple of (is_valid, reason)
        """
        # Check minimum fill size
        if fill_quantity < self.config.min_fill_quantity:
            return False, f"Fill {fill_quantity} below minimum {self.config.min_fill_quantity}"

        # Check max partial fills
        if fill_count >= self.config.max_partial_fills:
            return False, f"Max partial fills ({self.config.max_partial_fills}) reached"

        # Check fractional shares
        if not self.config.allow_fractional:
            if fill_quantity != fill_quantity.to_integral_value():
                return False, "Fractional shares not allowed"

        # Check lot size
        if self.config.lot_size > Decimal("0"):
            if fill_quantity % self.config.lot_size != Decimal("0"):
                return False, f"Fill must be multiple of lot size {self.config.lot_size}"

        return True, ""

    def round_to_lot(self, quantity: Decimal) -> Decimal:
        """Round quantity to nearest lot size."""
        if self.config.lot_size <= Decimal("0"):
            return quantity

        return (quantity // self.config.lot_size) * self.config.lot_size

    def adjust_fill_quantity(
        self,
        proposed_fill: Decimal,
        remaining: Decimal,
        fill_count: int,
    ) -> Decimal:
        """
        Adjust fill quantity to meet constraints.

        Returns the adjusted (potentially reduced) fill quantity.
        """
        # Don't exceed remaining
        fill_qty = min(proposed_fill, remaining)

        # Round to lot size if needed
        fill_qty = self.round_to_lot(fill_qty)

        # Check minimum - if below, fill nothing or fill all remaining
        if fill_qty < self.config.min_fill_quantity:
            if remaining >= self.config.min_fill_quantity:
                fill_qty = Decimal("0")  # Wait for larger fill
            else:
                fill_qty = remaining  # Fill remaining (last fill exception)

        return fill_qty
