"""
Quantlab Engine - Core Python trading engine for backtesting and live trading.

This package provides:
- Backtest engine with signal bar/execution bar semantics
- Live trading daemon with IPC communication
- Order type simulation (MARKET, LIMIT, STOP, STOP_LIMIT)
- Short selling with 100% collateral model
- Risk management with exposure reservation
- Data provenance tracking (DataRev, UniverseRev)
- Market calendar handling with timezone support
- Metrics calculation (Sharpe, Sortino, Calmar, etc.)
- Strategy API (vectorized, event-driven, class-based)

Quick Start:
    import quantlab as ql

    # Run a backtest
    results = ql.backtest(
        strategy="my_strategy.py",
        data="AAPL.csv",
    )
    print(results.summary())

    # Load data
    bars = ql.load_data("SPY.parquet")

Version: 1.0.0-alpha
Python: 3.11+
"""

__version__ = "1.0.0-alpha"
__author__ = "Quantlab Team"

# Version tuple for programmatic access
VERSION = (1, 0, 0, "alpha")

# API version for strategy compatibility
API_VERSION = "1.0"

# =============================================================================
# Public API Exports
# =============================================================================

# High-level backtest function
from quantlab.backtest.runner import backtest, BacktestResults

# Data loading
from quantlab.data.loader import load_data, load_multi
from quantlab.data.csv_loader import CSVLoader, load_csv
from quantlab.data.parquet_loader import ParquetLoader

# Strategy API
from quantlab.api.params import param, Param, ParamSpec, extract_params
from quantlab.api.vectorized import VectorizedSignals, VectorizedStrategy
from quantlab.api.event import Context, BarEvent, event_strategy
from quantlab.api.class_based import Strategy, SMACrossover, MeanReversion

# Core types
from quantlab.providers.base import Bar, Quote
from quantlab.backtest.core import Order, OrderSide, OrderType, OrderStatus

# Risk management
from quantlab.risk.circuit_breaker import CircuitBreaker, RiskManager as RiskLimits

# Metrics
from quantlab.metrics.types import PerformanceMetrics
from quantlab.metrics.calculator import MetricsCalculator

# Signals helper class for strategies
class Signals:
    """
    Simple signals container for vectorized strategies.

    Usage in strategy:
        def strategy(data):
            signals = ql.Signals()
            signals.buy(data.close > data.close.shift(1))
            signals.sell(data.close < data.close.shift(1))
            return signals
    """

    def __init__(self):
        self.buy_signals = []
        self.sell_signals = []
        self._buy_mask = None
        self._sell_mask = None

    def buy(self, condition):
        """Mark buy signals where condition is True."""
        self._buy_mask = condition

    def sell(self, condition):
        """Mark sell signals where condition is True."""
        self._sell_mask = condition

    @property
    def buy_signals(self):
        if self._buy_mask is not None:
            return self._buy_mask
        return []

    @buy_signals.setter
    def buy_signals(self, value):
        self._buy_mask = value

    @property
    def sell_signals(self):
        if self._sell_mask is not None:
            return self._sell_mask
        return []

    @sell_signals.setter
    def sell_signals(self, value):
        self._sell_mask = value


# =============================================================================
# Technical Analysis Helpers
# =============================================================================

def rsi(series, period=14):
    """
    Calculate Relative Strength Index using Wilder's smoothing.

    Args:
        series: pandas Series of prices (typically close)
        period: RSI lookback period (default: 14)

    Returns:
        pandas Series of RSI values (0-100)
    """
    import pandas as pd
    import numpy as np

    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)

    # Wilder's smoothing: start with SMA, then apply exponential smoothing
    avg_gain = pd.Series(np.nan, index=series.index, dtype=float)
    avg_loss = pd.Series(np.nan, index=series.index, dtype=float)

    # Initial SMA over first `period` price changes (indices 1 through period)
    avg_gain.iloc[period] = gain.iloc[1:period + 1].mean()
    avg_loss.iloc[period] = loss.iloc[1:period + 1].mean()

    # Wilder's smoothing for remaining values
    for i in range(period + 1, len(series)):
        avg_gain.iloc[i] = (avg_gain.iloc[i - 1] * (period - 1) + gain.iloc[i]) / period
        avg_loss.iloc[i] = (avg_loss.iloc[i - 1] * (period - 1) + loss.iloc[i]) / period

    rs = avg_gain / avg_loss
    rsi_values = 100 - (100 / (1 + rs))

    # Handle edge case: avg_loss == 0 → RSI = 100
    rsi_values = rsi_values.where(avg_loss > 0, other=np.where(avg_gain > 0, 100.0, 50.0))

    return rsi_values


def cross_over(series, threshold):
    """
    Detect when series crosses above a threshold.

    Args:
        series: pandas Series
        threshold: scalar value or Series to cross above

    Returns:
        pandas boolean Series (True at crossover points)
    """
    import pandas as pd

    if isinstance(threshold, (int, float)):
        prev = series.shift(1)
        return (series > threshold) & (prev <= threshold)
    else:
        prev_series = series.shift(1)
        prev_threshold = threshold.shift(1)
        return (series > threshold) & (prev_series <= prev_threshold)


def cross_under(series, threshold):
    """
    Detect when series crosses below a threshold.

    Args:
        series: pandas Series
        threshold: scalar value or Series to cross below

    Returns:
        pandas boolean Series (True at crossunder points)
    """
    import pandas as pd

    if isinstance(threshold, (int, float)):
        prev = series.shift(1)
        return (series < threshold) & (prev >= threshold)
    else:
        prev_series = series.shift(1)
        prev_threshold = threshold.shift(1)
        return (series < threshold) & (prev_series >= prev_threshold)


def signals(entry=None, exit=None, buy=None, sell=None):
    """
    Create a Signals object from entry/exit or buy/sell boolean series.

    Args:
        entry: boolean Series for entry (buy) signals
        exit: boolean Series for exit (sell) signals
        buy: alias for entry
        sell: alias for exit

    Returns:
        Signals object with buy_signals and sell_signals
    """
    sig = Signals()
    buy_mask = buy if buy is not None else entry
    sell_mask = sell if sell is not None else exit
    if buy_mask is not None:
        sig.buy(buy_mask)
    if sell_mask is not None:
        sig.sell(sell_mask)
    return sig


def sma(series, period):
    """Simple Moving Average."""
    return series.rolling(window=period).mean()


def ema(series, period):
    """Exponential Moving Average."""
    return series.ewm(span=period, adjust=False).mean()


def macd(series, fast=12, slow=26, signal=9):
    """
    Calculate MACD (Moving Average Convergence Divergence) indicator.

    The MACD is a trend-following momentum indicator that shows the relationship
    between two moving averages of a security's price.

    Args:
        series: pandas Series of prices (typically close prices)
        fast: Fast EMA period (default: 12)
        slow: Slow EMA period (default: 26)
        signal: Signal line EMA period (default: 9)

    Returns:
        Tuple of (macd_line, signal_line, histogram) as pandas Series
        - macd_line: Difference between fast and slow EMAs
        - signal_line: EMA of the MACD line
        - histogram: Difference between MACD line and signal line

    Example:
        >>> macd_line, signal_line, histogram = ql.macd(data.close)
        >>> buy_signal = ql.cross_over(macd_line, signal_line)
        >>> sell_signal = ql.cross_under(macd_line, signal_line)
    """
    import pandas as pd

    # Calculate fast and slow EMAs
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()

    # MACD line = fast EMA - slow EMA
    macd_line = ema_fast - ema_slow

    # Signal line = EMA of MACD line
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()

    # Histogram = MACD line - signal line
    histogram = macd_line - signal_line

    return macd_line, signal_line, histogram


# =============================================================================
# Convenience exports
# =============================================================================

__all__ = [
    # Version info
    "__version__",
    "VERSION",
    "API_VERSION",
    # High-level API
    "backtest",
    "BacktestResults",
    # Data loading
    "load_data",
    "load_multi",
    "load_csv",
    "CSVLoader",
    "ParquetLoader",
    # Strategy API
    "param",
    "Param",
    "ParamSpec",
    "extract_params",
    "Signals",
    "VectorizedSignals",
    "VectorizedStrategy",
    "Context",
    "BarEvent",
    "event_strategy",
    "Strategy",
    "SMACrossover",
    "MeanReversion",
    # Core types
    "Bar",
    "Quote",
    "Order",
    "OrderSide",
    "OrderType",
    "OrderStatus",
    # Risk
    "RiskLimits",
    "CircuitBreaker",
    # Metrics
    "PerformanceMetrics",
    "MetricsCalculator",
    # Technical Analysis
    "rsi",
    "sma",
    "ema",
    "macd",
    "cross_over",
    "cross_under",
    "signals",
]

# =============================================================================
# Support "from quantlab import ql" pattern
# =============================================================================
# Some strategies use "from quantlab import ql" then "ql.rsi(...)"
# We make 'ql' a reference to this module so both import styles work.
import sys as _sys
ql = _sys.modules[__name__]
