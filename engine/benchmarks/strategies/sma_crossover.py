"""
SMA Crossover Benchmark Strategy.

Used for bench_small and bench_medium benchmarks.
Simple moving average crossover with configurable periods.
"""

import quantlab as ql

fast_period = ql.param("fast_period", default=10, min=5, max=50)
slow_period = ql.param("slow_period", default=20, min=10, max=100)


def strategy(data):
    """SMA crossover strategy for benchmarking."""
    fast_sma = data.close.rolling(window=fast_period).mean()
    slow_sma = data.close.rolling(window=slow_period).mean()

    signals = ql.Signals()

    # Buy when fast crosses above slow
    buy_signal = (fast_sma > slow_sma) & (fast_sma.shift(1) <= slow_sma.shift(1))
    signals.buy(buy_signal)

    # Sell when fast crosses below slow
    sell_signal = (fast_sma < slow_sma) & (fast_sma.shift(1) >= slow_sma.shift(1))
    signals.sell(sell_signal)

    return signals
