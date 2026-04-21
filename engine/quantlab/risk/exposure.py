"""
Exposure Reservation Model.

Provides thread-safe exposure management for concurrent order handling.

This is the AUTHORITATIVE implementation (Python/daemon-side).
A TypeScript advisory implementation exists in the UI for early feedback.

Spec Reference: Technical Spec §11.1, Decision E27, E28
"""

import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from decimal import Decimal
from typing import Any


logger = logging.getLogger(__name__)


class ExposureError(Exception):
    """Base exception for exposure errors."""

    pass


class ExposureLimitBreach(ExposureError):
    """Order would breach exposure limits."""

    pass


class ReservationNotFound(ExposureError):
    """Reservation does not exist."""

    pass


class ReservationExpired(ExposureError):
    """Reservation has expired."""

    pass


from quantlab.orders.base import OrderSide  # noqa: E402 — canonical definition in orders/base.py


@dataclass
class OrderRequest:
    """Order request for exposure calculation."""

    order_id: str
    symbol: str
    side: OrderSide
    quantity: Decimal
    price: Decimal | None = None  # None for market orders
    order_type: str = "market"


@dataclass
class Fill:
    """Fill event for exposure commitment."""

    order_id: str
    symbol: str
    side: OrderSide
    fill_quantity: Decimal
    fill_price: Decimal
    is_partial: bool = False


@dataclass
class ReservationHandle:
    """Handle for a reserved exposure amount."""

    reservation_id: str
    order_id: str
    amount: Decimal
    symbol: str
    side: OrderSide
    created_at: datetime
    expires_at: datetime
    # Track original order quantity for partial fill calculations
    original_quantity: Decimal = Decimal("0")
    filled_quantity: Decimal = Decimal("0")

    def is_expired(self) -> bool:
        """Check if reservation has expired."""
        return datetime.now() >= self.expires_at

    @property
    def remaining_quantity(self) -> Decimal:
        """Get remaining quantity to be filled."""
        return self.original_quantity - self.filled_quantity


@dataclass
class ReservationResult:
    """Result of a reservation attempt."""

    success: bool
    handle: ReservationHandle | None = None
    reason: str | None = None
    available: Decimal = Decimal("0")
    requested: Decimal = Decimal("0")


@dataclass
class ExposureSnapshot:
    """Snapshot of current exposure state."""

    current_exposure: Decimal
    reserved_exposure: Decimal
    max_exposure: Decimal
    available_exposure: Decimal
    reservation_count: int
    positions: dict[str, Decimal] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "current_exposure": str(self.current_exposure),
            "reserved_exposure": str(self.reserved_exposure),
            "max_exposure": str(self.max_exposure),
            "available_exposure": str(self.available_exposure),
            "reservation_count": self.reservation_count,
            "positions": {k: str(v) for k, v in self.positions.items()},
        }


class ExposureManager:
    """
    Thread-safe exposure reservation manager.

    Prevents concurrent orders from breaching exposure limits by:
    1. Reserving exposure BEFORE order submission
    2. Committing reservation on fill
    3. Releasing reservation on cancel/reject
    4. Handling partial fills correctly
    5. Cleaning up expired reservations

    Usage:
        manager = ExposureManager(max_exposure=Decimal("100000"))

        # Before submitting order
        result = manager.reserve(order_request)
        if not result.success:
            raise ExposureLimitBreach(result.reason)

        # Submit order to broker...

        # On fill
        manager.commit(order_id, fill)

        # On cancel/reject
        manager.release(order_id)
    """

    # Default reservation timeout (orders must fill/cancel within this time)
    DEFAULT_RESERVATION_TIMEOUT = timedelta(minutes=5)

    # Cleanup interval for expired reservations
    CLEANUP_INTERVAL = timedelta(seconds=30)

    def __init__(
        self,
        max_exposure: Decimal,
        reservation_timeout: timedelta | None = None,
    ) -> None:
        self._max_exposure = max_exposure
        self._reservation_timeout = reservation_timeout or self.DEFAULT_RESERVATION_TIMEOUT

        # Thread-safe state
        self._lock = threading.RLock()

        # Current committed exposure (from filled positions)
        self._current_exposure = Decimal("0")

        # Reserved exposure (pending orders)
        self._reserved_exposure = Decimal("0")

        # Active reservations by order_id
        self._reservations: dict[str, ReservationHandle] = {}

        # Position tracking (symbol -> net quantity)
        self._positions: dict[str, Decimal] = {}

        # Last known prices for exposure recomputation (FIX-C1)
        self._last_prices: dict[str, Decimal] = {}

        # Cleanup task
        self._cleanup_task: asyncio.Task[None] | None = None
        self._running = False

    @property
    def max_exposure(self) -> Decimal:
        """Maximum allowed exposure."""
        return self._max_exposure

    @property
    def current_exposure(self) -> Decimal:
        """Current committed exposure."""
        with self._lock:
            return self._current_exposure

    @property
    def reserved_exposure(self) -> Decimal:
        """Currently reserved exposure."""
        with self._lock:
            return self._reserved_exposure

    @property
    def available_exposure(self) -> Decimal:
        """Available exposure for new orders."""
        with self._lock:
            return self._max_exposure - self._current_exposure - self._reserved_exposure

    def snapshot(self) -> ExposureSnapshot:
        """Get current exposure snapshot."""
        with self._lock:
            return ExposureSnapshot(
                current_exposure=self._current_exposure,
                reserved_exposure=self._reserved_exposure,
                max_exposure=self._max_exposure,
                available_exposure=self.available_exposure,
                reservation_count=len(self._reservations),
                positions=dict(self._positions),
            )

    def get_metrics(self) -> dict[str, Any]:
        """Get exposure metrics for monitoring (FIX-R005)."""
        with self._lock:
            utilization = Decimal("0")
            if self._max_exposure > 0:
                utilization = (
                    (self._current_exposure + self._reserved_exposure) / self._max_exposure * 100
                )

            oldest_reservation_age = self._get_oldest_reservation_age()

            return {
                "max_exposure": str(self._max_exposure),
                "current_exposure": str(self._current_exposure),
                "reserved_exposure": str(self._reserved_exposure),
                "available_exposure": str(self._max_exposure - self._current_exposure - self._reserved_exposure),
                "utilization_pct": float(utilization),
                "reservation_count": len(self._reservations),
                # NEW-RISK-002: Handle None when no reservations exist
                "oldest_reservation_age_seconds": oldest_reservation_age if oldest_reservation_age is not None else 0.0,
                "position_count": len(self._positions),
            }

    def _get_oldest_reservation_age(self) -> float | None:
        """Get age of oldest reservation in seconds (FIX-R005)."""
        if not self._reservations:
            return None
        oldest = min(r.created_at for r in self._reservations.values())
        return (datetime.now() - oldest).total_seconds()

    def reserve(
        self,
        order: OrderRequest,
        price_estimate: Decimal | None = None,
    ) -> ReservationResult:
        """
        Reserve exposure for an order.

        Thread-safe. Checks if the order would breach limits and reserves
        the required exposure if successful.

        Args:
            order: Order request
            price_estimate: Estimated price for market orders (REQUIRED for market orders)

        Returns:
            ReservationResult with success status and handle if successful
        """
        with self._lock:
            # Calculate projected exposure for this order
            try:
                projected = self._calculate_projected_exposure(order, price_estimate)
            except ExposureError as e:
                logger.error(f"Exposure calculation failed for order {order.order_id}: {e}")
                return ReservationResult(
                    success=False,
                    reason="MISSING_PRICE_ESTIMATE",
                    available=self.available_exposure,
                    requested=Decimal("0"),
                )

            # Check against limits
            total = self._current_exposure + self._reserved_exposure + projected

            if total > self._max_exposure:
                available = self._max_exposure - self._current_exposure - self._reserved_exposure
                logger.warning(
                    f"Exposure limit breach: order {order.order_id} would require "
                    f"{projected}, only {available} available (max: {self._max_exposure})"
                )
                return ReservationResult(
                    success=False,
                    reason="EXPOSURE_LIMIT_BREACH",
                    available=available,
                    requested=projected,
                )

            # Create reservation
            now = datetime.now()
            handle = ReservationHandle(
                reservation_id=str(uuid.uuid4()),
                order_id=order.order_id,
                amount=projected,
                symbol=order.symbol,
                side=order.side,
                created_at=now,
                expires_at=now + self._reservation_timeout,
                # Track original order quantity for partial fill calculations
                original_quantity=order.quantity,
                filled_quantity=Decimal("0"),
            )

            # Track reservation
            self._reservations[order.order_id] = handle
            self._reserved_exposure += projected

            logger.info(
                f"Reserved {projected} exposure for order {order.order_id} "
                f"(total reserved: {self._reserved_exposure})"
            )

            return ReservationResult(
                success=True,
                handle=handle,
                available=self._max_exposure - self._current_exposure - self._reserved_exposure,
                requested=projected,
            )

    def commit(self, order_id: str, fill: Fill) -> None:
        """
        Commit a reservation on fill.

        Converts reserved exposure to actual exposure.
        For partial fills, adjusts the reservation proportionally.

        Args:
            order_id: Order ID
            fill: Fill event

        Raises:
            ReservationNotFound: If no reservation exists for this order
        """
        with self._lock:
            reservation = self._reservations.get(order_id)
            if not reservation:
                # Order may have been submitted without reservation (legacy)
                logger.warning(f"No reservation found for order {order_id}, adding directly")
                self._update_position(fill)
                self._recompute_current_exposure(fill.fill_price, fill.symbol)
                return

            # Update reserved exposure (release the reservation amount)
            self._reserved_exposure -= reservation.amount

            if fill.is_partial:
                # Update filled quantity tracking
                reservation.filled_quantity += fill.fill_quantity

                # Calculate remaining quantity using tracked values
                remaining_qty = reservation.remaining_quantity

                if remaining_qty > Decimal("0") and reservation.original_quantity > Decimal("0"):
                    # Calculate remaining reservation proportionally
                    # Guard against division by zero (should never happen with valid orders)
                    filled_ratio = reservation.filled_quantity / reservation.original_quantity
                    remaining_reservation = reservation.amount * (Decimal("1") - filled_ratio)

                    if remaining_reservation > Decimal("0"):
                        reservation.amount = remaining_reservation
                        self._reserved_exposure += remaining_reservation
                        committed_exposure = reservation.amount * filled_ratio
                        logger.info(
                            f"Partial fill for {order_id}: committed {committed_exposure}, "
                            f"remaining reservation: {remaining_reservation}, "
                            f"filled: {reservation.filled_quantity}/{reservation.original_quantity}"
                        )
                    else:
                        del self._reservations[order_id]
                else:
                    # All quantity filled, remove reservation
                    del self._reservations[order_id]
            else:
                # Full fill, remove reservation
                del self._reservations[order_id]

            # Update position tracking and recompute exposure from ground truth (FIX-C1)
            self._update_position(fill)
            self._recompute_current_exposure(fill.fill_price, fill.symbol)

            logger.info(
                f"Committed exposure for order {order_id} "
                f"(current: {self._current_exposure})"
            )

    def release(self, order_id: str) -> None:
        """
        Release a reservation (cancel/reject).

        Args:
            order_id: Order ID

        Raises:
            ReservationNotFound: If no reservation exists
        """
        with self._lock:
            reservation = self._reservations.get(order_id)
            if not reservation:
                logger.warning(f"No reservation to release for order {order_id}")
                return

            self._reserved_exposure -= reservation.amount
            del self._reservations[order_id]

            logger.info(
                f"Released {reservation.amount} exposure for order {order_id} "
                f"(reserved: {self._reserved_exposure})"
            )

    def modify(
        self,
        order_id: str,
        new_quantity: Decimal | None = None,
        new_price: Decimal | None = None,
    ) -> ReservationResult:
        """
        Modify an existing reservation.

        Used when order modification is supported by the broker.

        Args:
            order_id: Order ID
            new_quantity: New order quantity (if changed)
            new_price: New order price (if changed)

        Returns:
            ReservationResult with updated status
        """
        with self._lock:
            reservation = self._reservations.get(order_id)
            if not reservation:
                return ReservationResult(
                    success=False,
                    reason="RESERVATION_NOT_FOUND",
                )

            # Calculate new exposure
            old_amount = reservation.amount

            if new_quantity is not None or new_price is not None:
                # FIX-H4: Derive defaults from existing reservation instead of zero
                if reservation.original_quantity > Decimal("0"):
                    original_unit_price = reservation.amount / reservation.original_quantity
                else:
                    original_unit_price = Decimal("0")

                price = new_price if new_price is not None else original_unit_price
                quantity = new_quantity if new_quantity is not None else reservation.original_quantity
                new_amount = quantity * price

                # Check if increase would breach limits
                if new_amount > old_amount:
                    delta = new_amount - old_amount
                    total = self._current_exposure + self._reserved_exposure + delta

                    if total > self._max_exposure:
                        return ReservationResult(
                            success=False,
                            reason="EXPOSURE_LIMIT_BREACH",
                            available=self.available_exposure,
                            requested=new_amount,
                        )

                # Update reservation
                self._reserved_exposure = self._reserved_exposure - old_amount + new_amount
                reservation.amount = new_amount

                logger.info(
                    f"Modified reservation for {order_id}: {old_amount} -> {new_amount}"
                )

            return ReservationResult(
                success=True,
                handle=reservation,
                available=self.available_exposure,
                requested=reservation.amount,
            )

    async def start_cleanup(self) -> None:
        """Start background cleanup of expired reservations."""
        if self._running:
            return

        self._running = True
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        logger.info("Exposure cleanup task started")

    async def stop_cleanup(self) -> None:
        """Stop background cleanup."""
        self._running = False
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        logger.info("Exposure cleanup task stopped")

    async def _cleanup_loop(self) -> None:
        """Periodically clean up expired reservations."""
        while self._running:
            try:
                await asyncio.sleep(self.CLEANUP_INTERVAL.total_seconds())
                self._cleanup_expired()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Cleanup error: {e}")

    def _cleanup_expired(self) -> None:
        """Remove expired reservations."""
        with self._lock:
            expired = [
                order_id
                for order_id, handle in self._reservations.items()
                if handle.is_expired()
            ]

            for order_id in expired:
                handle = self._reservations.pop(order_id)
                self._reserved_exposure -= handle.amount
                logger.warning(
                    f"Expired reservation for order {order_id}: released {handle.amount}"
                )

            if expired:
                logger.info(f"Cleaned up {len(expired)} expired reservations")

    def _calculate_projected_exposure(
        self,
        order: OrderRequest,
        price_estimate: Decimal | None = None,
    ) -> Decimal:
        """
        Calculate the exposure this order would add.

        Args:
            order: Order request
            price_estimate: Estimated price for market orders (REQUIRED for market orders)

        Returns:
            Projected exposure amount

        Raises:
            ExposureError: If market order has no price estimate
        """
        price = order.price or price_estimate

        if price is None or price <= Decimal("0"):
            if order.order_type == "market":
                raise ExposureError(
                    f"Market order {order.order_id} requires a valid price_estimate "
                    f"for exposure calculation (got: {price_estimate})"
                )
            # For limit orders without price, use zero (shouldn't happen)
            price = Decimal("0")

        notional = order.quantity * price

        # For closing positions, exposure decreases
        current_position = self._positions.get(order.symbol, Decimal("0"))

        if order.side == OrderSide.SELL and current_position > Decimal("0"):
            # Selling long position reduces exposure
            close_amount = min(order.quantity, current_position)
            net_increase = order.quantity - close_amount
            return net_increase * price

        elif order.side == OrderSide.BUY and current_position < Decimal("0"):
            # Buying to cover short reduces exposure
            close_amount = min(order.quantity, abs(current_position))
            net_increase = order.quantity - close_amount
            return net_increase * price

        # Opening or extending position
        return notional

    def _recompute_current_exposure(self, latest_price: Decimal, symbol: str) -> None:
        """Recompute current exposure from positions (ground truth).

        Stores fill prices for mark-to-market.  O(n) in position count
        which is negligible (typically < 100 symbols).

        FIX-C1: Replaces the old running-total approach that only ever
        increased _current_exposure, never decreased it on position close.
        """
        self._last_prices[symbol] = latest_price
        self._current_exposure = sum(
            abs(qty) * self._last_prices.get(sym, Decimal("0"))
            for sym, qty in self._positions.items()
        )

    def _update_position(self, fill: Fill) -> None:
        """Update position tracking."""
        current = self._positions.get(fill.symbol, Decimal("0"))

        if fill.side == OrderSide.BUY:
            self._positions[fill.symbol] = current + fill.fill_quantity
        else:
            self._positions[fill.symbol] = current - fill.fill_quantity

        # Remove zero positions
        if self._positions[fill.symbol] == Decimal("0"):
            del self._positions[fill.symbol]

    def _get_remaining_quantity(
        self,
        reservation: ReservationHandle,
        fill: Fill,  # noqa: ARG002
    ) -> Decimal:
        """Get remaining quantity for partial fill.

        Uses the tracked original_quantity and filled_quantity on the reservation handle.
        """
        return reservation.remaining_quantity

    def update_max_exposure(self, new_max: Decimal) -> None:
        """Update maximum exposure limit."""
        with self._lock:
            old_max = self._max_exposure
            self._max_exposure = new_max
            logger.info(f"Max exposure updated: {old_max} -> {new_max}")

    def reset(self) -> None:
        """Reset all exposure tracking (for testing)."""
        with self._lock:
            self._current_exposure = Decimal("0")
            self._reserved_exposure = Decimal("0")
            self._reservations.clear()
            self._positions.clear()
            self._last_prices.clear()
            logger.info("Exposure manager reset")
