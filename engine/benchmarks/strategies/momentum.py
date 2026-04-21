"""
Momentum Benchmark Strategy.

Used for bench_large (minute data) benchmarks.
Simple price momentum with configurable lookback.
"""

import quantlab as ql

lookback = ql.param("lookback", default=20, min=5, max=100)
threshold = ql.param("threshold", default=0.02, min=0.005, max=0.10)


def strategy(data):
    """Momentum strategy for minute-level benchmarking."""
    # Calculate momentum
    momentum = (data.close - data.close.shift(lookback)) / data.close.shift(lookback)

    signals = ql.Signals()

    # Buy on strong positive momentum
    buy_signal = momentum > threshold
    signals.buy(buy_signal)

    # Sell on negative momentum
    sell_signal = momentum < -threshold
    signals.sell(sell_signal)

    return signals
