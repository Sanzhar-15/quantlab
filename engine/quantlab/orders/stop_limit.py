"""
Stop-Limit Order Handler.

Handles stop-limit order execution with trigger and limit constraints.

Spec Reference: Technical Spec §3.3
"""

from decimal import Decimal

from quantlab.backtest.bar import Bar
from quantlab.orders.base import FillInfo
from quantlab.orders.base import FillResult
from quantlab.orders.base import NoFill
from quantlab.orders.base import OrderHandler
from quantlab.orders.base import OrderSide
from quantlab.orders.base import OrderType


class StopLimitOrderHandler(OrderHandler):
    """
    Stop-limit order handler.

    Stop-limit orders combine stop and limit functionality:
    1. Order activates when stop price is reached
    2. Once activated, becomes a limit order
    3. Only fills if price is within the limit constraint

    This provides slippage protection compared to stop orders,
    but may not fill in fast-moving markets.
    """

    @property
    def order_type(self) -> OrderType:
        return OrderType.STOP_LIMIT

    def can_fill(
        self,
        side: OrderSide,
        quantity: Decimal,  # noqa: ARG002
        bar: Bar,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,
    ) -> bool:
        """
        Check if stop-limit can fill on this bar.

        Both conditions must be met:
        1. Stop price must be triggered
        2. After trigger, limit price must be achievable
        """
        if stop_price is None or limit_price is None:
            return False

        if bar.volume == Decimal("0"):
            return False

        # Check stop trigger
        if side == OrderSide.BUY:
            if bar.high < stop_price:
                return False  # Stop not triggered
            # After trigger, check if limit achievable
            return bar.low <= limit_price
        else:  # SELL
            if bar.low > stop_price:
                return False  # Stop not triggered
            # After trigger, check if limit achievable
            return bar.high >= limit_price

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
        Calculate stop-limit fill.

        Stop-limit orders have two phases:
        1. Trigger phase: wait for stop price
        2. Fill phase: execute as limit order
        """
        if stop_price is None:
            return NoFill("Stop price not specified")

        if limit_price is None:
            return NoFill("Limit price not specified")

        if bar.volume == Decimal("0"):
            return NoFill("Zero volume bar")

        if side == OrderSide.BUY:
            # Buy stop-limit
            # Step 1: Check if stop is triggered
            if bar.high < stop_price:
                return NoFill(f"Stop {stop_price} not triggered (high={bar.high})")

            # Stop is triggered, now apply limit order logic
            # For same-bar trigger+fill, we need limit to be reachable
            if bar.low > limit_price:
                return NoFill(
                    f"Stop triggered but limit {limit_price} not reached (low={bar.low})"
                )

            # Fill at better of: stop price, open, or limit
            # If gap through stop, use open (up to limit)
            if bar.open >= stop_price:
                # Opened above stop, fill at open if within limit
                if bar.open <= limit_price:
                    fill_price = bar.open
                else:
                    return NoFill(f"Open {bar.open} above limit {limit_price}")
            else:
                # Stop triggered during bar, fill at stop or limit
                fill_price = min(stop_price, limit_price)

        else:  # SELL
            # Sell stop-limit
            # Step 1: Check if stop is triggered
            if bar.low > stop_price:
                return NoFill(f"Stop {stop_price} not triggered (low={bar.low})")

            # Stop is triggered, now apply limit order logic
            if bar.high < limit_price:
                return NoFill(
                    f"Stop triggered but limit {limit_price} not reached (high={bar.high})"
                )

            # Fill at better of: stop price, open, or limit
            # If gap through stop, use open (down to limit)
            if bar.open <= stop_price:
                # Opened below stop, fill at open if within limit
                if bar.open >= limit_price:
                    fill_price = bar.open
                else:
                    return NoFill(f"Open {bar.open} below limit {limit_price}")
            else:
                # Stop triggered during bar, fill at stop or limit
                fill_price = max(stop_price, limit_price)

        # Apply volume participation limit
        max_fill = bar.volume * max_participation
        fill_qty = min(quantity, max_fill)

        if fill_qty <= Decimal("0"):
            return NoFill("Volume participation limit exceeded")

        remaining = quantity - fill_qty

        return FillInfo(
            fill_price=fill_price,
            fill_quantity=fill_qty,
            remaining_quantity=remaining,
            reason=f"Stop-limit triggered at {stop_price}, filled at {fill_price}",
        )


class StopLimitState:
    """
    Track stop-limit order state.

    Stop-limit orders can be in two states:
    1. Pending: waiting for stop trigger
    2. Activated: stop triggered, now acting as limit order
    """

    def __init__(self) -> None:
        self._activated: set[str] = set()  # order_ids that have been triggered

    def is_activated(self, order_id: str) -> bool:
        """Check if stop has been triggered for this order."""
        return order_id in self._activated

    def activate(self, order_id: str) -> None:
        """Mark order as activated (stop triggered)."""
        self._activated.add(order_id)

    def clear(self, order_id: str) -> None:
        """Remove order from tracking."""
        self._activated.discard(order_id)

    def check_trigger(
        self,
        order_id: str,
        side: OrderSide,
        stop_price: Decimal,
        bar: Bar,
    ) -> bool:
        """
        Check if stop is triggered and update state.

        Returns True if order is now activated (either newly or previously).
        """
        if self.is_activated(order_id):
            return True

        triggered = False
        if side == OrderSide.BUY:
            triggered = bar.high >= stop_price
        else:
            triggered = bar.low <= stop_price

        if triggered:
            self.activate(order_id)

        return triggered
