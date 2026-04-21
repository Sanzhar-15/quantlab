"""
Market Order Handler.

Handles market order execution with immediate fill at market price.

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


class MarketOrderHandler(OrderHandler):
    """
    Market order handler.

    Market orders fill at the next available price based on fill assumption.
    They always fill unless volume is zero.
    """

    @property
    def order_type(self) -> OrderType:
        return OrderType.MARKET

    def try_fill(
        self,
        request: "OrderRequest",
        market_price: Decimal,
    ) -> "FillResult":
        """
        Try to fill a market order at the given market price.

        Simple API for tests - market orders always fill at market price.

        Args:
            request: Order request with symbol, side, quantity
            market_price: Current market price

        Returns:
            FillInfo with the fill details
        """
        from quantlab.orders.base import OrderRequest  # noqa: F811

        return FillInfo(
            fill_price=market_price,
            fill_quantity=request.quantity,
            remaining_quantity=Decimal("0"),
            reason="Market order filled at market price",
        )

    def can_fill(
        self,
        side: OrderSide,  # noqa: ARG002
        quantity: Decimal,  # noqa: ARG002
        bar: Bar,
        limit_price: Decimal | None = None,  # noqa: ARG002
        stop_price: Decimal | None = None,  # noqa: ARG002
    ) -> bool:
        """Market orders can fill on any bar with volume."""
        return bar.volume > Decimal("0")

    def calculate_fill(
        self,
        side: OrderSide,  # noqa: ARG002
        quantity: Decimal,
        bar: Bar,
        limit_price: Decimal | None = None,  # noqa: ARG002
        stop_price: Decimal | None = None,  # noqa: ARG002
        max_participation: Decimal = Decimal("1.0"),
    ) -> FillResult:
        """
        Calculate market order fill.

        Market orders fill at open price (base assumption).
        Volume participation limits apply.
        """
        if bar.volume == Decimal("0"):
            return NoFill("Zero volume bar")

        # Calculate fill quantity based on volume participation
        max_fill = bar.volume * max_participation
        fill_qty = min(quantity, max_fill)

        if fill_qty <= Decimal("0"):
            return NoFill("Volume participation limit exceeded")

        remaining = quantity - fill_qty

        return FillInfo(
            fill_price=bar.open,  # Base price, slippage applied separately
            fill_quantity=fill_qty,
            remaining_quantity=remaining,
            reason="Market order filled at open",
        )


def get_market_fill_price(bar: Bar, fill_assumption: str) -> Decimal:
    """
    Get market fill price based on fill assumption.

    Args:
        bar: Execution bar
        fill_assumption: One of 'next_open', 'next_close', 'typical_price'

    Returns:
        Fill price before slippage
    """
    if fill_assumption == "next_close":
        return bar.close
    elif fill_assumption == "typical_price":
        return bar.typical_price
    else:  # next_open (default)
        return bar.open
