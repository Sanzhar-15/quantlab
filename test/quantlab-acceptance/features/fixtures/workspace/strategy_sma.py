"""
Sample SMA Crossover Strategy for Testing.

This is a simple moving average crossover strategy used for testing
the strategy API and backtest engine.
"""

import quantlab as ql

# Strategy parameters (use simple values for backtesting, Param for class-based)
fast_period = 10  # Optimize range: 5-50
slow_period = 20  # Optimize range: 10-100


def strategy(data):
    """
    Vectorized SMA crossover strategy.

    Generates buy signal when fast SMA crosses above slow SMA.
    Generates sell signal when fast SMA crosses below slow SMA.
    """
    # Calculate moving averages
    fast_sma = data.close.rolling(window=fast_period).mean()
    slow_sma = data.close.rolling(window=slow_period).mean()

    # Generate signals
    signals = ql.Signals()

    # Buy when fast crosses above slow
    buy_signal = (fast_sma > slow_sma) & (fast_sma.shift(1) <= slow_sma.shift(1))
    signals.buy(buy_signal)

    # Sell when fast crosses below slow
    sell_signal = (fast_sma < slow_sma) & (fast_sma.shift(1) >= slow_sma.shift(1))
    signals.sell(sell_signal)

    return signals
