"""
Sample Class-Based Strategy for Testing.

This demonstrates the class-based strategy API form.
"""

import quantlab as ql


class MomentumStrategy(ql.Strategy):
    """
    Momentum strategy that goes long when price is above its moving average.
    """

    # Parameters defined as class attributes
    lookback = ql.param("lookback", default=20, min=5, max=100)
    position_size = ql.param("position_size", default=0.10, min=0.01, max=0.50)

    def initialize(self):
        """Called once at strategy start."""
        self.sma = {}

    def on_bar(self, ctx):
        """Called on each bar."""
        for symbol in ctx.universe:
            data = ctx.data[symbol]
            if len(data) < self.lookback:
                continue

            # Calculate SMA
            sma = data.close.rolling(window=self.lookback).mean().iloc[-1]
            current_price = data.close.iloc[-1]

            has_position = ctx.portfolio.has_position(symbol)

            # Enter long if price above SMA
            if current_price > sma and not has_position:
                target_value = ctx.portfolio.equity * self.position_size
                quantity = int(target_value / current_price)
                if quantity > 0:
                    ctx.orders.market_buy(symbol, quantity=quantity)

            # Exit if price below SMA
            elif current_price < sma and has_position:
                position = ctx.portfolio.position(symbol)
                ctx.orders.market_sell(symbol, quantity=position.quantity)

    def on_fill(self, fill):
        """Called when an order is filled."""
        self.log(f"Filled: {fill.symbol} {fill.side} {fill.quantity} @ {fill.price}")
