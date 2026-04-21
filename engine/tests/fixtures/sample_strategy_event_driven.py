"""
Sample Event-Driven Strategy for Testing.

This demonstrates the event-driven strategy API form.
"""

import quantlab as ql

# Strategy parameters
threshold = ql.param("threshold", default=0.02, min=0.01, max=0.10)


def on_bar(ctx):
    """
    Event-driven strategy that buys on dips and sells on rallies.

    Args:
        ctx: Strategy context with access to data, portfolio, and orders.
    """
    if len(ctx.data) < 2:
        return

    # Calculate daily return
    prev_close = ctx.data.close[-2]
    curr_close = ctx.data.close[-1]
    daily_return = (curr_close - prev_close) / prev_close

    symbol = ctx.data.symbol

    # Buy on dip
    if daily_return < -threshold and not ctx.portfolio.has_position(symbol):
        ctx.orders.market_buy(symbol, quantity=100)

    # Sell on rally
    if daily_return > threshold and ctx.portfolio.has_position(symbol):
        ctx.orders.market_sell(symbol, quantity=ctx.portfolio.position(symbol).quantity)
