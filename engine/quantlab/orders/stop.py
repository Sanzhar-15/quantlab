"""
Stop Order Handler.

Handles stop (stop-market) order execution with trigger logic.

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


class StopOrderHandler(OrderHandler):
    """
    Stop order handler.

    Stop orders become market orders when the stop price is triggered.
    - Buy stop: triggers when price rises to stop price (momentum entry)
    - Sell stop: triggers when price falls to stop price (stop loss)

    Gap handling:
    - If price gaps through the stop, fills at the open price
    - Otherwise fills at the stop price
    """

    @property
    def order_type(self) -> OrderType:
        return OrderType.STOP

    def is_triggered(
        self,
        request: "OrderRequest",
        market_price: Decimal,
    ) -> bool:
        """
        Check if a stop order is triggered at the given market price.

        Simple API for tests.

        Args:
            request: Order request with stop_price and side
            market_price: Current market price

        Returns:
            True if stop is triggered
        """
        from quantlab.orders.base import OrderRequest  # noqa: F811

        if request.stop_price is None:
            return False

        if request.side == OrderSide.BUY:
            # Buy stop triggers when price >= stop price
            return market_price >= request.stop_price
        else:
            # Sell stop triggers when price <= stop price
            return market_price <= request.stop_price

    def can_fill(
        self,
        side: OrderSide,
        quantity: Decimal,  # noqa: ARG002
        bar: Bar,
        limit_price: Decimal | None = None,  # noqa: ARG002
        stop_price: Decimal | None = None,
    ) -> bool:
        """
        Check if stop is triggered on this bar.

        Buy stop: triggers when bar high >= stop price
        Sell stop: triggers when bar low <= stop price
        """
        if stop_price is None:
            return False

        if bar.volume == Decimal("0"):
            return False

        if side == OrderSide.BUY:
            return bar.high >= stop_price
        else:  # SELL
            return bar.low <= stop_price

    def calculate_fill(
        self,
        side: OrderSide,
        quantity: Decimal,
        bar: Bar,
        limit_price: Decimal | None = None,  # noqa: ARG002
        stop_price: Decimal | None = None,
        max_participation: Decimal = Decimal("1.0"),
    ) -> FillResult:
        """
        Calculate stop order fill.

        When triggered, becomes a market order and fills at trigger or open.
        """
        if stop_price is None:
            return NoFill("Stop price not specified")

        if bar.volume == Decimal("0"):
            return NoFill("Zero volume bar")

        triggered = False
        fill_price = stop_price

        if side == OrderSide.BUY:
            # Buy stop: trigger when price rises to stop
            if bar.high >= stop_price:
                triggered = True
                # Gap through: fill at open if it's above the stop
                if bar.open >= stop_price:
                    fill_price = bar.open  # Slippage happens here
                # Otherwise price touched stop during the bar
        else:  # SELL
            # Sell stop: trigger when price falls to stop
            if bar.low <= stop_price:
                triggered = True
                # Gap through: fill at open if it's below the stop
                if bar.open <= stop_price:
                    fill_price = bar.open  # Slippage happens here

        if not triggered:
            return NoFill(f"Stop {stop_price} not triggered")

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
            reason=f"Stop triggered at {stop_price}, filled at {fill_price}",
        )


class TrailingStopHandler(OrderHandler):
    """
    Trailing stop order handler.

    The stop price trails the market by a fixed amount or percentage.
    Requires tracking the highest/lowest price since order placement.
    """

    def __init__(
        self,
        trail_amount: Decimal | None = None,
        trail_percent: Decimal | None = None,
    ) -> None:
        """
        Initialize trailing stop handler.

        Args:
            trail_amount: Fixed dollar amount to trail
            trail_percent: Percentage to trail (0.01 = 1%)
        """
        if trail_amount is None and trail_percent is None:
            raise ValueError("Either trail_amount or trail_percent must be specified")

        self.trail_amount = trail_amount
        self.trail_percent = trail_percent
        self._high_water_mark: dict[str, Decimal] = {}
        self._low_water_mark: dict[str, Decimal] = {}

    @property
    def order_type(self) -> OrderType:
        return OrderType.STOP  # Trailing stop is a variant

    def update_watermark(
        self,
        order_id: str,
        side: OrderSide,
        current_price: Decimal,
    ) -> Decimal:
        """
        Update watermark and return current stop price.

        Args:
            order_id: Unique order identifier
            side: Order side
            current_price: Current market price

        Returns:
            Updated stop price
        """
        if side == OrderSide.SELL:
            # Sell stop trails the high
            current_high = self._high_water_mark.get(order_id, current_price)
            new_high = max(current_high, current_price)
            self._high_water_mark[order_id] = new_high

            if self.trail_amount:
                return new_high - self.trail_amount
            else:
                return new_high * (Decimal("1") - self.trail_percent)  # type: ignore
        else:
            # Buy stop trails the low
            current_low = self._low_water_mark.get(order_id, current_price)
            new_low = min(current_low, current_price)
            self._low_water_mark[order_id] = new_low

            if self.trail_amount:
                return new_low + self.trail_amount
            else:
                return new_low * (Decimal("1") + self.trail_percent)  # type: ignore

    def can_fill(
        self,
        side: OrderSide,
        quantity: Decimal,  # noqa: ARG002
        bar: Bar,
        limit_price: Decimal | None = None,  # noqa: ARG002
        stop_price: Decimal | None = None,
    ) -> bool:
        """Check if trailing stop would trigger."""
        if stop_price is None:
            return False

        if bar.volume == Decimal("0"):
            return False

        if side == OrderSide.BUY:
            return bar.high >= stop_price
        else:
            return bar.low <= stop_price

    def calculate_fill(
        self,
        side: OrderSide,
        quantity: Decimal,
        bar: Bar,
        limit_price: Decimal | None = None,  # noqa: ARG002
        stop_price: Decimal | None = None,
        max_participation: Decimal = Decimal("1.0"),
    ) -> FillResult:
        """Calculate trailing stop fill using standard stop logic."""
        # Delegate to standard stop handler logic
        stop_handler = StopOrderHandler()
        return stop_handler.calculate_fill(
            side=side,
            quantity=quantity,
            bar=bar,
            stop_price=stop_price,
            max_participation=max_participation,
        )

    def clear_watermark(self, order_id: str) -> None:
        """Clear watermarks for a completed order."""
        self._high_water_mark.pop(order_id, None)
        self._low_water_mark.pop(order_id, None)
