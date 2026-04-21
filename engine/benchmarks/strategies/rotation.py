"""
Sector Rotation Benchmark Strategy.

Used for bench_multi (10-symbol) benchmarks.
Rotates into top N performers by momentum.
"""

import quantlab as ql


class RotationStrategy(ql.Strategy):
    """Sector rotation strategy for multi-symbol benchmarking."""

    lookback = ql.param("lookback", default=20, min=5, max=60)
    top_n = ql.param("top_n", default=3, min=1, max=5)
    rebalance_freq = ql.param("rebalance_freq", default=5, min=1, max=20)

    def initialize(self):
        """Initialize strategy state."""
        self.bar_count = 0

    def on_bar(self, ctx):
        """Called on each bar."""
        self.bar_count += 1

        # Only rebalance at specified frequency
        if self.bar_count % self.rebalance_freq != 0:
            return

        # Calculate momentum for each symbol
        momentum_scores = {}
        for symbol in ctx.universe:
            data = ctx.data[symbol]
            if len(data) < self.lookback:
                continue

            # Calculate momentum (return over lookback period)
            current_price = data.close.iloc[-1]
            past_price = data.close.iloc[-self.lookback]
            momentum = (current_price - past_price) / past_price
            momentum_scores[symbol] = momentum

        if not momentum_scores:
            return

        # Rank by momentum
        ranked = sorted(momentum_scores.items(), key=lambda x: x[1], reverse=True)
        top_symbols = set(sym for sym, _ in ranked[: self.top_n])

        # Close positions not in top N
        for symbol in list(ctx.portfolio.positions.keys()):
            if symbol not in top_symbols:
                position = ctx.portfolio.position(symbol)
                ctx.orders.market_sell(symbol, quantity=position.quantity)

        # Open positions in top N (equal weight)
        target_weight = 1.0 / self.top_n
        for symbol in top_symbols:
            if not ctx.portfolio.has_position(symbol):
                data = ctx.data[symbol]
                current_price = data.close.iloc[-1]
                target_value = ctx.portfolio.equity * target_weight * 0.95  # 95% to avoid margin
                quantity = int(target_value / current_price)
                if quantity > 0:
                    ctx.orders.market_buy(symbol, quantity=quantity)
