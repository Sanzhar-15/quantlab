"""
RSI + MACD Benchmark Strategy.

Used for bench_medium benchmarks.
Combines RSI and MACD indicators for signal generation.
"""

import quantlab as ql

# RSI parameters
rsi_period = ql.param("rsi_period", default=14, min=5, max=30)
rsi_oversold = ql.param("rsi_oversold", default=30, min=20, max=40)
rsi_overbought = ql.param("rsi_overbought", default=70, min=60, max=80)

# MACD parameters
macd_fast = ql.param("macd_fast", default=12, min=5, max=20)
macd_slow = ql.param("macd_slow", default=26, min=15, max=40)
macd_signal = ql.param("macd_signal", default=9, min=5, max=15)


def calculate_rsi(close, period):
    """Calculate RSI indicator."""
    delta = close.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


def calculate_macd(close, fast, slow, signal):
    """Calculate MACD indicator."""
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def strategy(data):
    """RSI + MACD combined strategy for benchmarking."""
    # Calculate indicators
    rsi = calculate_rsi(data.close, rsi_period)
    macd_line, signal_line, histogram = calculate_macd(
        data.close, macd_fast, macd_slow, macd_signal
    )

    signals = ql.Signals()

    # Buy: RSI oversold AND MACD crosses above signal
    buy_signal = (
        (rsi < rsi_oversold)
        & (macd_line > signal_line)
        & (macd_line.shift(1) <= signal_line.shift(1))
    )
    signals.buy(buy_signal)

    # Sell: RSI overbought OR MACD crosses below signal
    sell_signal = (rsi > rsi_overbought) | (
        (macd_line < signal_line) & (macd_line.shift(1) >= signal_line.shift(1))
    )
    signals.sell(sell_signal)

    return signals
