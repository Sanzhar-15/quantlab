"""
Order Management System.

Handles order creation, lifecycle, and tracking.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from enum import Enum
from typing import TYPE_CHECKING
from typing import Any
from typing import Callable

if TYPE_CHECKING:
    from quantlab.logging.audit import AuditLog

from quantlab.precision.policy import AssetClass, PrecisionPolicy


logger = logging.getLogger(__name__)


# Default precision policy (US equities)
_DEFAULT_PRECISION = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)


class OrderType(Enum):
    """Order types."""

    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


from quantlab.orders.base import OrderSide  # noqa: E402 — canonical definition in orders/base.py


class OrderStatus(Enum):
    """Order status."""

    PENDING = "pending"  # Created, not submitted
    SUBMITTED = "submitted"  # Sent to broker
    ACCEPTED = "accepted"  # Accepted by broker
    PARTIAL = "partial"  # Partially filled
    FILLED = "filled"  # Completely filled
    CANCEL_PENDING = "cancel_pending"  # Cancel requested, awaiting broker confirmation
    CANCELLED = "cancelled"  # Cancelled (confirmed by broker)
    REJECTED = "rejected"  # Rejected by broker
    EXPIRED = "expired"  # Expired


from quantlab.orders.tif import TimeInForce  # noqa: E402 — canonical definition in orders/tif.py


def generate_order_id() -> str:
    """Generate a unique order ID."""
    return f"order-{uuid.uuid4().hex[:12]}"


@dataclass
class Fill:
    """A fill (execution) of an order."""

    fill_id: str
    order_id: str
    quantity: Decimal
    price: Decimal
    timestamp: datetime
    commission: Decimal = Decimal("0")

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "fillId": self.fill_id,
            "orderId": self.order_id,
            "quantity": float(self.quantity),
            "price": float(self.price),
            "timestamp": self.timestamp.isoformat(),
            "commission": float(self.commission),
        }


@dataclass
class Order:
    """
    Represents a trading order.

    Tracks order state, fills, and execution details.
    """

    order_id: str
    session_id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: Decimal
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: TimeInForce = TimeInForce.DAY

    # Status
    status: OrderStatus = OrderStatus.PENDING
    filled_quantity: Decimal = Decimal("0")
    avg_fill_price: Decimal | None = None

    # Timestamps
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    submitted_at: datetime | None = None
    filled_at: datetime | None = None
    cancelled_at: datetime | None = None

    # Broker reference
    broker_order_id: str | None = None

    # Fills
    fills: list[Fill] = field(default_factory=list)

    # Error info
    reject_reason: str | None = None

    @property
    def is_open(self) -> bool:
        """Check if order is still open (including cancel pending)."""
        return self.status in (
            OrderStatus.PENDING,
            OrderStatus.SUBMITTED,
            OrderStatus.ACCEPTED,
            OrderStatus.PARTIAL,
            OrderStatus.CANCEL_PENDING,
        )

    @property
    def is_complete(self) -> bool:
        """Check if order is complete (filled or cancelled)."""
        return self.status in (
            OrderStatus.FILLED,
            OrderStatus.CANCELLED,
            OrderStatus.REJECTED,
            OrderStatus.EXPIRED,
        )

    @property
    def remaining_quantity(self) -> Decimal:
        """Get remaining quantity to fill."""
        return self.quantity - self.filled_quantity

    @property
    def notional_value(self) -> Decimal:
        """Get notional value of order."""
        price = self.limit_price or self.avg_fill_price or Decimal("0")
        return self.quantity * price

    def add_fill(self, fill: Fill) -> None:
        """Add a fill to the order."""
        self.fills.append(fill)
        self.filled_quantity += fill.quantity

        # Update average fill price
        total_value = sum(
            f.quantity * f.price for f in self.fills
        )
        if self.filled_quantity > 0:
            self.avg_fill_price = total_value / self.filled_quantity

        # Update status
        if self.filled_quantity >= self.quantity:
            self.status = OrderStatus.FILLED
            self.filled_at = fill.timestamp
        elif self.filled_quantity > 0:
            self.status = OrderStatus.PARTIAL

    def submit(self, broker_order_id: str | None = None) -> None:
        """Mark order as submitted."""
        self.status = OrderStatus.SUBMITTED
        self.submitted_at = datetime.now(timezone.utc)
        self.broker_order_id = broker_order_id

    def accept(self) -> None:
        """Mark order as accepted by broker."""
        self.status = OrderStatus.ACCEPTED

    def request_cancel(self) -> None:
        """Mark order as cancel pending (awaiting broker confirmation)."""
        self.status = OrderStatus.CANCEL_PENDING

    def cancel(self) -> None:
        """Mark order as cancelled (broker confirmed)."""
        self.status = OrderStatus.CANCELLED
        self.cancelled_at = datetime.now(timezone.utc)

    def reject(self, reason: str) -> None:
        """Mark order as rejected."""
        self.status = OrderStatus.REJECTED
        self.reject_reason = reason

    def expire(self) -> None:
        """Mark order as expired."""
        self.status = OrderStatus.EXPIRED

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "orderId": self.order_id,
            "sessionId": self.session_id,
            "symbol": self.symbol,
            "side": self.side.value,
            "orderType": self.order_type.value,
            "quantity": float(self.quantity),
            "limitPrice": float(self.limit_price) if self.limit_price else None,
            "stopPrice": float(self.stop_price) if self.stop_price else None,
            "timeInForce": self.time_in_force.value,
            "status": self.status.value,
            "filledQuantity": float(self.filled_quantity),
            "avgFillPrice": float(self.avg_fill_price) if self.avg_fill_price else None,
            "remainingQuantity": float(self.remaining_quantity),
            "createdAt": self.created_at.isoformat(),
            "submittedAt": self.submitted_at.isoformat() if self.submitted_at else None,
            "filledAt": self.filled_at.isoformat() if self.filled_at else None,
            "brokerOrderId": self.broker_order_id,
            "fills": [f.to_dict() for f in self.fills],
            "rejectReason": self.reject_reason,
        }


@dataclass
class OrderRequest:
    """Request to create an order."""

    session_id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: Decimal
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: TimeInForce = TimeInForce.DAY
    precision_policy: PrecisionPolicy = field(default_factory=lambda: _DEFAULT_PRECISION)

    def validate(self) -> list[str]:
        """Validate the order request, including precision (per §14.5)."""
        errors = []

        if self.quantity <= 0:
            errors.append("Quantity must be positive")

        # Validate precision (per §14.5)
        if not self.precision_policy.validate_quantity(self.quantity):
            rounded = self.precision_policy.round_quantity(self.quantity)
            errors.append(
                f"Quantity precision invalid: {self.quantity} should be {rounded}"
            )

        if self.limit_price is not None:
            if not self.precision_policy.validate_price(self.limit_price):
                rounded = self.precision_policy.round_price(self.limit_price)
                errors.append(
                    f"Limit price precision invalid: {self.limit_price} should be {rounded}"
                )

        if self.stop_price is not None:
            if not self.precision_policy.validate_price(self.stop_price):
                rounded = self.precision_policy.round_price(self.stop_price)
                errors.append(
                    f"Stop price precision invalid: {self.stop_price} should be {rounded}"
                )

        if self.order_type == OrderType.LIMIT and self.limit_price is None:
            errors.append("Limit price required for limit orders")

        if self.order_type == OrderType.STOP and self.stop_price is None:
            errors.append("Stop price required for stop orders")

        if self.order_type == OrderType.STOP_LIMIT:
            if self.limit_price is None:
                errors.append("Limit price required for stop-limit orders")
            if self.stop_price is None:
                errors.append("Stop price required for stop-limit orders")

        return errors

    def normalize_precision(self) -> "OrderRequest":
        """
        Return a new OrderRequest with prices/quantities rounded per precision policy.

        Use this before submitting orders to ensure compliance with §14.5.
        """
        return OrderRequest(
            session_id=self.session_id,
            symbol=self.symbol,
            side=self.side,
            order_type=self.order_type,
            quantity=self.precision_policy.round_quantity(self.quantity),
            limit_price=self.precision_policy.round_price(self.limit_price) if self.limit_price else None,
            stop_price=self.precision_policy.round_price(self.stop_price) if self.stop_price else None,
            time_in_force=self.time_in_force,
            precision_policy=self.precision_policy,
        )


class OrderManager:
    """
    Manages orders for trading sessions.

    Handles order creation, tracking, and lifecycle management.
    """

    def __init__(self, audit_log: "AuditLog | None" = None) -> None:
        """Initialize order manager.

        Args:
            audit_log: Optional audit log for compliance logging
        """
        self._orders: dict[str, Order] = {}
        self._orders_by_session: dict[str, list[str]] = {}
        self._lock = threading.Lock()
        self._audit_log = audit_log

        # Event callbacks
        self._on_order_update: list[Callable[[Order], None]] = []
        self._on_fill: list[Callable[[Order, Fill], None]] = []

    def set_audit_log(self, audit_log: "AuditLog") -> None:
        """Set the audit log for compliance logging."""
        self._audit_log = audit_log

    def create_order(self, request: OrderRequest) -> Order:
        """
        Create a new order.

        Args:
            request: Order request

        Returns:
            Created order

        Raises:
            ValueError: If request is invalid
        """
        errors = request.validate()
        if errors:
            raise ValueError(f"Invalid order: {'; '.join(errors)}")

        order = Order(
            order_id=generate_order_id(),
            session_id=request.session_id,
            symbol=request.symbol,
            side=request.side,
            order_type=request.order_type,
            quantity=request.quantity,
            limit_price=request.limit_price,
            stop_price=request.stop_price,
            time_in_force=request.time_in_force,
        )

        with self._lock:
            self._orders[order.order_id] = order

            if request.session_id not in self._orders_by_session:
                self._orders_by_session[request.session_id] = []
            self._orders_by_session[request.session_id].append(order.order_id)

        return order

    def get_order(self, order_id: str) -> Order | None:
        """Get order by ID."""
        with self._lock:
            return self._orders.get(order_id)

    def get_orders_for_session(self, session_id: str) -> list[Order]:
        """Get all orders for a session."""
        with self._lock:
            order_ids = self._orders_by_session.get(session_id, [])
            return [self._orders[oid] for oid in order_ids if oid in self._orders]

    def get_open_orders(self, session_id: str | None = None) -> list[Order]:
        """Get all open orders, optionally filtered by session."""
        with self._lock:
            orders = self._orders.values()
            if session_id:
                orders = [o for o in orders if o.session_id == session_id]
            return [o for o in orders if o.is_open]

    def submit_order(
        self,
        order_id: str,
        broker_order_id: str | None = None,
    ) -> None:
        """Mark order as submitted."""
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        order.submit(broker_order_id)
        self._notify_order_update(order)

        # Audit log: order submission
        if self._audit_log:
            try:
                from quantlab.logging.audit import audit_order_submit

                audit_order_submit(
                    self._audit_log,
                    session_id=order.session_id,
                    order_id=order.order_id,
                    symbol=order.symbol,
                    side=order.side.value,
                    quantity=str(order.quantity),
                    order_type=order.order_type.value,
                    price=str(order.limit_price) if order.limit_price else None,
                    broker_order_id=broker_order_id,
                    time_in_force=order.time_in_force.value,
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for order submit: {e}")

    def accept_order(self, order_id: str) -> None:
        """Mark order as accepted."""
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        order.accept()
        self._notify_order_update(order)

    def fill_order(
        self,
        order_id: str,
        quantity: Decimal,
        price: Decimal,
        commission: Decimal = Decimal("0"),
    ) -> Fill:
        """
        Record a fill for an order.

        Args:
            order_id: Order ID
            quantity: Fill quantity
            price: Fill price
            commission: Commission amount

        Returns:
            Created fill
        """
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        fill = Fill(
            fill_id=f"fill-{uuid.uuid4().hex[:8]}",
            order_id=order_id,
            quantity=quantity,
            price=price,
            timestamp=datetime.now(timezone.utc),
            commission=commission,
        )

        # Check if this is a partial fill before adding
        is_partial = (order.filled_quantity + quantity) < order.quantity

        order.add_fill(fill)
        self._notify_order_update(order)
        self._notify_fill(order, fill)

        # Audit log: order fill
        if self._audit_log:
            try:
                from quantlab.logging.audit import audit_order_fill

                audit_order_fill(
                    self._audit_log,
                    session_id=order.session_id,
                    order_id=order.order_id,
                    fill_quantity=str(quantity),
                    fill_price=str(price),
                    is_partial=is_partial,
                    fill_id=fill.fill_id,
                    commission=str(commission),
                    total_filled=str(order.filled_quantity),
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for order fill: {e}")

        return fill

    def request_cancel_order(self, order_id: str) -> None:
        """
        Request cancellation of an order (two-phase cancel).

        Use this when sending cancel to broker. The order will be in
        CANCEL_PENDING state until broker confirms with confirm_cancel_order().

        Args:
            order_id: Order ID to cancel
        """
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        if not order.is_open or order.status == OrderStatus.CANCEL_PENDING:
            raise ValueError(f"Cannot cancel order in status {order.status.value}")

        order.request_cancel()
        self._notify_order_update(order)

        logger.info(f"Cancel requested for order {order_id}, awaiting broker confirmation")

    def confirm_cancel_order(self, order_id: str) -> None:
        """
        Confirm cancellation of an order (broker confirmed).

        Called when broker confirms the cancel was executed.

        Args:
            order_id: Order ID that was cancelled
        """
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        # Allow confirming cancel from CANCEL_PENDING or open states
        # (broker may confirm cancel without us requesting it first)
        if order.status not in (
            OrderStatus.CANCEL_PENDING,
            OrderStatus.SUBMITTED,
            OrderStatus.ACCEPTED,
            OrderStatus.PARTIAL,
        ):
            logger.warning(
                f"Unexpected cancel confirmation for order {order_id} "
                f"in status {order.status.value}"
            )
            return

        order.cancel()
        self._notify_order_update(order)

        # Audit log: order cancellation confirmed
        if self._audit_log:
            try:
                from quantlab.logging.audit import AuditAction

                self._audit_log.log(
                    AuditAction.ORDER_CANCEL,
                    order.session_id,
                    {
                        "order_id": order.order_id,
                        "symbol": order.symbol,
                        "side": order.side.value,
                        "filled_quantity": str(order.filled_quantity),
                        "remaining_quantity": str(order.remaining_quantity),
                        "broker_confirmed": True,
                    },
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for order cancel: {e}")

        logger.info(f"Cancel confirmed for order {order_id}")

    def cancel_order(self, order_id: str) -> None:
        """
        Cancel an order immediately (single-phase, for backtest/simulation).

        For live trading, use request_cancel_order() + confirm_cancel_order()
        to implement proper broker verification.

        Args:
            order_id: Order ID to cancel
        """
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        if not order.is_open:
            raise ValueError(f"Cannot cancel order in status {order.status.value}")

        order.cancel()
        self._notify_order_update(order)

        # Audit log: order cancellation
        if self._audit_log:
            try:
                from quantlab.logging.audit import AuditAction

                self._audit_log.log(
                    AuditAction.ORDER_CANCEL,
                    order.session_id,
                    {
                        "order_id": order.order_id,
                        "symbol": order.symbol,
                        "side": order.side.value,
                        "filled_quantity": str(order.filled_quantity),
                        "remaining_quantity": str(order.remaining_quantity),
                    },
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for order cancel: {e}")

    def reject_order(self, order_id: str, reason: str) -> None:
        """Reject an order."""
        order = self.get_order(order_id)
        if order is None:
            raise ValueError(f"Order not found: {order_id}")

        order.reject(reason)
        self._notify_order_update(order)

        # Audit log: order rejection
        if self._audit_log:
            try:
                from quantlab.logging.audit import AuditAction

                self._audit_log.log(
                    AuditAction.ORDER_REJECT,
                    order.session_id,
                    {
                        "order_id": order.order_id,
                        "symbol": order.symbol,
                        "side": order.side.value,
                        "quantity": str(order.quantity),
                        "reject_reason": reason,
                    },
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for order reject: {e}")

    def cancel_all_orders(self, session_id: str) -> list[str]:
        """
        Cancel all open orders for a session.

        Args:
            session_id: Session ID

        Returns:
            List of cancelled order IDs
        """
        cancelled = []
        for order in self.get_open_orders(session_id):
            try:
                order.cancel()
                self._notify_order_update(order)
                cancelled.append(order.order_id)
            except Exception as e:
                logger.warning(
                    f"Failed to cancel order {order.order_id}: {e}",
                    exc_info=True,
                )
        return cancelled

    def on_order_update(self, callback: Callable[[Order], None]) -> None:
        """Register order update callback."""
        self._on_order_update.append(callback)

    def on_fill(self, callback: Callable[[Order, Fill], None]) -> None:
        """Register fill callback."""
        self._on_fill.append(callback)

    def _notify_order_update(self, order: Order) -> None:
        """Notify order update listeners."""
        for callback in self._on_order_update:
            try:
                callback(order)
            except Exception as e:
                logger.warning(
                    f"Order update callback failed for order {order.order_id}: {e}",
                    exc_info=True,
                )

    def _notify_fill(self, order: Order, fill: Fill) -> None:
        """Notify fill listeners."""
        for callback in self._on_fill:
            try:
                callback(order, fill)
            except Exception as e:
                logger.warning(
                    f"Fill callback failed for order {order.order_id}: {e}",
                    exc_info=True,
                )
