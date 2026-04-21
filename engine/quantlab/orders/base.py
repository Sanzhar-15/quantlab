"""
Order Type Base Classes.

Defines abstract base for order execution handlers.

Spec Reference: Technical Spec §3.3
"""

from abc import ABC
from abc import abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Any

from quantlab.backtest.bar import Bar


class OrderSide(Enum):
    """Order side."""

    BUY = "buy"
    SELL = "sell"
    SELL_SHORT = "sell_short"
    BUY_TO_COVER = "buy_to_cover"


class OrderType(Enum):
    """Order type."""

    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


from quantlab.orders.tif import TimeInForce  # noqa: E402 — canonical definition in tif.py


class OrderStatus(Enum):
    """Order status."""

    PENDING = "pending"
    OPEN = "open"  # Accepted, waiting to fill
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    EXPIRED = "expired"


@dataclass
class OrderRequest:
    """
    Order request from strategy.

    Contains all parameters needed to create an order.
    """

    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: Decimal
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: TimeInForce = TimeInForce.GFD
    session_id: str = ""  # Test compatibility
    client_order_id: str | None = None
    metadata: dict[str, Any] | None = None

    def validate(self) -> list[str]:
        """
        Validate order request.

        Returns:
            List of validation errors (empty if valid)
        """
        errors = []

        if self.quantity <= Decimal("0"):
            errors.append("Quantity must be positive")

        if self.order_type == OrderType.LIMIT:
            if self.limit_price is None:
                errors.append("Limit price required for limit orders")
            elif self.limit_price <= Decimal("0"):
                errors.append("Limit price must be positive")

        if self.order_type == OrderType.STOP:
            if self.stop_price is None:
                errors.append("Stop price required for stop orders")
            elif self.stop_price <= Decimal("0"):
                errors.append("Stop price must be positive")

        if self.order_type == OrderType.STOP_LIMIT:
            if self.stop_price is None:
                errors.append("Stop price required for stop-limit orders")
            if self.limit_price is None:
                errors.append("Limit price required for stop-limit orders")

        return errors


@dataclass
class FillInfo:
    """Information about an order fill."""

    fill_price: Decimal
    fill_quantity: Decimal
    remaining_quantity: Decimal
    reason: str = ""

    @property
    def is_complete(self) -> bool:
        """Check if order is completely filled."""
        return self.remaining_quantity == Decimal("0")


@dataclass
class NoFill:
    """Represents an order that did not fill."""

    reason: str


FillResult = FillInfo | NoFill


class OrderHandler(ABC):
    """
    Abstract base for order type handlers.

    Each order type implements its own fill logic.
    """

    @property
    @abstractmethod
    def order_type(self) -> OrderType:
        """Return the order type this handler processes."""
        pass

    @abstractmethod
    def can_fill(
        self,
        side: OrderSide,
        quantity: Decimal,
        bar: Bar,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,
    ) -> bool:
        """
        Check if order can potentially fill on this bar.

        Args:
            side: Buy or sell
            quantity: Order quantity
            bar: Execution bar
            limit_price: Limit price if applicable
            stop_price: Stop price if applicable

        Returns:
            True if fill is possible
        """
        pass

    @abstractmethod
    def calculate_fill(
        self,
        side: OrderSide,
        quantity: Decimal,
        bar: Bar,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,
        max_participation: Decimal = Decimal("1.0"),
    ) -> FillResult:
        """
        Calculate fill for this order type.

        Args:
            side: Buy or sell
            quantity: Order quantity
            bar: Execution bar
            limit_price: Limit price if applicable
            stop_price: Stop price if applicable
            max_participation: Maximum volume participation (0-1)

        Returns:
            FillInfo if filled, NoFill if not
        """
        pass
