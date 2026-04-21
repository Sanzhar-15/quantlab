"""
Limit Order Handler.

Handles limit order execution with price constraints and price improvement.

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


class LimitOrderHandler(OrderHandler):
    """
    Limit order handler.

    Limit orders fill only when price reaches the limit price.
    Price improvement is given when market opens through the limit.
    """

    @property
    def order_type(self) -> OrderType:
        return OrderType.LIMIT

    def try_fill(
        self,
        request: "OrderRequest",
        market_price: Decimal,
    ) -> "FillResult":
        """
        Try to fill a limit order at the given market price.

        Simple API for tests - checks limit conditions.

        Args:
            request: Order request with symbol, side, quantity, limit_price
            market_price: Current market price

        Returns:
            FillInfo if filled, NoFill if not
        """
        from quantlab.orders.base import OrderRequest  # noqa: F811

        if request.limit_price is None:
            return NoFill("Limit price not specified")

        if request.side == OrderSide.BUY:
            # Buy limit fills when market price <= limit price
            if market_price > request.limit_price:
                return NoFill(f"Market price {market_price} above limit {request.limit_price}")
            fill_price = market_price  # Price improvement
        else:
            # Sell limit fills when market price >= limit price
            if market_price < request.limit_price:
                return NoFill(f"Market price {market_price} below limit {request.limit_price}")
            fill_price = market_price  # Price improvement

        return FillInfo(
            fill_price=fill_price,
            fill_quantity=request.quantity,
            remaining_quantity=Decimal("0"),
            reason=f"Limit order filled at {fill_price}",
        )

    def can_fill(
        self,
        side: OrderSide,
        quantity: Decimal,  # noqa: ARG002
        bar: Bar,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,  # noqa: ARG002
    ) -> bool:
        """
        Check if limit order can fill on this bar.

        Buy limit: fills when price falls to or below limit (bar low <= limit)
        Sell limit: fills when price rises to or above limit (bar high >= limit)
        """
        if limit_price is None:
            return False

        if bar.volume == Decimal("0"):
            return False

        if side == OrderSide.BUY:
            return bar.low <= limit_price
        else:  # SELL
            return bar.high >= limit_price

    def calculate_fill(
        self,
        side: OrderSide,
        quantity: Decimal,
        bar: Bar,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,  # noqa: ARG002
        max_participation: Decimal = Decimal("1.0"),
    ) -> FillResult:
        """
        Calculate limit order fill with price improvement.

        Price improvement occurs when the market opens through the limit price.
        """
        if limit_price is None:
            return NoFill("Limit price not specified")

        if bar.volume == Decimal("0"):
            return NoFill("Zero volume bar")

        if side == OrderSide.BUY:
            # Buy limit: fill when bar low <= limit price
            if bar.low > limit_price:
                return NoFill(f"Low {bar.low} above limit {limit_price}")

            # Price improvement: fill at better of open or limit
            # If market gaps down through limit, fill at open (better price)
            fill_price = min(bar.open, limit_price)

        else:  # SELL
            # Sell limit: fill when bar high >= limit price
            if bar.high < limit_price:
                return NoFill(f"High {bar.high} below limit {limit_price}")

            # Price improvement: fill at better of open or limit
            # If market gaps up through limit, fill at open (better price)
            fill_price = max(bar.open, limit_price)

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
            reason=f"Limit order filled at {fill_price}",
        )


class AggressiveLimitOrderHandler(LimitOrderHandler):
    """
    Aggressive limit order handler.

    For marketable limit orders (limit price that would fill immediately
    as a market order), fills at the limit price rather than the open.
    """

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
        Calculate aggressive limit order fill.

        Always fills at the limit price, not at open (no price improvement).
        """
        if limit_price is None:
            return NoFill("Limit price not specified")

        if bar.volume == Decimal("0"):
            return NoFill("Zero volume bar")

        if side == OrderSide.BUY:
            if bar.low > limit_price:
                return NoFill(f"Low {bar.low} above limit {limit_price}")
            fill_price = limit_price  # No price improvement
        else:
            if bar.high < limit_price:
                return NoFill(f"High {bar.high} below limit {limit_price}")
            fill_price = limit_price  # No price improvement

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
            reason=f"Aggressive limit filled at {fill_price}",
        )
