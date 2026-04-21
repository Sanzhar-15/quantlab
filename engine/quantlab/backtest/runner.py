"""
High-Level Backtest Runner.

Provides a simple interface to run backtests with strategies and data.

This is the main entry point for running backtests programmatically.

Usage:
    import quantlab as ql

    # Simple backtest
    results = ql.backtest(
        strategy="my_strategy.py",
        data="AAPL.csv",
    )

    # With configuration
    results = ql.backtest(
        strategy="my_strategy.py",
        data="AAPL.csv",
        initial_capital=100000,
        commission=0.001,
        start="2023-01-01",
        end="2023-12-31",
    )

    # Print results
    print(results.summary())
"""

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from quantlab.backtest.bar import Bar, BarSeries
from quantlab.backtest.commission import CommissionModel
from quantlab.backtest.config import BacktestConfig
from quantlab.backtest.core import BacktestEngine, Order, OrderSide, OrderType
from quantlab.backtest.fills import FillAssumption
from quantlab.backtest.slippage import SlippageModel
from quantlab.data.loader import load_data
from quantlab.metrics.calculator import MetricsCalculator
from quantlab.metrics.types import PerformanceMetrics
from quantlab.providers.base import Bar as ProviderBar


logger = logging.getLogger(__name__)


@dataclass
class Fill:
    """Fill record from backtest execution."""

    order_id: str
    symbol: str
    side: OrderSide
    quantity: int
    price: Decimal
    commission: Decimal
    timestamp: datetime


@dataclass
class BacktestResults:
    """Results from a backtest run."""

    # Configuration
    strategy_name: str
    symbol: str
    start_date: datetime
    end_date: datetime
    initial_capital: Decimal
    final_equity: Decimal

    # Performance
    total_return: Decimal
    total_return_pct: Decimal
    trades: list[dict[str, Any]]
    fills: list[Fill]

    # Metrics
    metrics: PerformanceMetrics | None = None

    # Equity curve
    equity_curve: list[tuple[datetime, Decimal]] = field(default_factory=list)

    # Errors/warnings
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        """Generate a text summary of results."""
        lines = [
            "=" * 60,
            f"BACKTEST RESULTS: {self.strategy_name}",
            "=" * 60,
            f"Symbol:          {self.symbol}",
            f"Period:          {self.start_date.date()} to {self.end_date.date()}",
            f"Initial Capital: ${self.initial_capital:,.2f}",
            f"Final Equity:    ${self.final_equity:,.2f}",
            f"Total Return:    ${self.total_return:,.2f} ({self.total_return_pct:.2f}%)",
            f"Total Trades:    {len(self.trades)}",
            "-" * 60,
        ]

        if self.metrics:
            lines.extend([
                "METRICS:",
                f"  Sharpe Ratio:     {self.metrics.sharpe_ratio:.3f}" if self.metrics.sharpe_ratio else "  Sharpe Ratio:     N/A",
                f"  Sortino Ratio:    {self.metrics.sortino_ratio:.3f}" if self.metrics.sortino_ratio else "  Sortino Ratio:    N/A",
                f"  Max Drawdown:     {self.metrics.max_drawdown_pct:.2f}%" if self.metrics.max_drawdown_pct else "  Max Drawdown:     N/A",
                f"  Win Rate:         {self.metrics.win_rate:.1f}%" if self.metrics.win_rate else "  Win Rate:         N/A",
                f"  Profit Factor:    {self.metrics.profit_factor:.2f}" if self.metrics.profit_factor else "  Profit Factor:    N/A",
            ])

        if self.warnings:
            lines.extend(["-" * 60, "WARNINGS:"])
            for w in self.warnings:
                lines.append(f"  - {w}")

        lines.append("=" * 60)
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        """Convert results to dictionary."""
        return {
            "strategy_name": self.strategy_name,
            "symbol": self.symbol,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "initial_capital": float(self.initial_capital),
            "final_equity": float(self.final_equity),
            "total_return": float(self.total_return),
            "total_return_pct": float(self.total_return_pct),
            "num_trades": len(self.trades),
            "trades": self.trades,
            "metrics": self.metrics.to_dict() if self.metrics else None,
            "warnings": self.warnings,
        }


class SignalGenerator:
    """Generate trading signals from a strategy."""

    def __init__(self, strategy_func: Callable, position_size: int = 100):
        self.strategy_func = strategy_func
        self.position_size = position_size

    def generate(self, bars: list[ProviderBar]) -> list[dict[str, Any]]:
        """
        Generate signals from bars using the strategy function.

        Returns list of signal dicts with: bar_index, side
        """
        import pandas as pd

        # Convert bars to DataFrame for strategy
        data = pd.DataFrame([
            {
                "timestamp": b.timestamp,
                "open": float(b.open),
                "high": float(b.high),
                "low": float(b.low),
                "close": float(b.close),
                "volume": b.volume,
            }
            for b in bars
        ])
        data.set_index("timestamp", inplace=True)

        # Create a simple data wrapper
        class DataWrapper:
            def __init__(self, df):
                self._df = df
                self.open = df["open"]
                self.high = df["high"]
                self.low = df["low"]
                self.close = df["close"]
                self.volume = df["volume"]

        wrapped_data = DataWrapper(data)

        # Call strategy to get signals
        try:
            result = self.strategy_func(wrapped_data)
        except Exception as e:
            logger.error(f"Strategy execution error: {e}")
            raise

        # Parse signals from result
        signals = []
        if hasattr(result, "buy_signals") and hasattr(result, "sell_signals"):
            # VectorizedSignals-like object (pandas boolean series or list)
            buy_sigs = result.buy_signals
            sell_sigs = result.sell_signals

            for i in range(len(buy_sigs)):
                try:
                    if buy_sigs.iloc[i] if hasattr(buy_sigs, 'iloc') else buy_sigs[i]:
                        signals.append({"bar_index": i, "side": "buy"})
                except (IndexError, KeyError):
                    pass

            for i in range(len(sell_sigs)):
                try:
                    if sell_sigs.iloc[i] if hasattr(sell_sigs, 'iloc') else sell_sigs[i]:
                        signals.append({"bar_index": i, "side": "sell"})
                except (IndexError, KeyError):
                    pass

        elif isinstance(result, (list, tuple)):
            signals = list(result)
        elif hasattr(result, "__iter__"):
            signals = list(result)

        return signals


def backtest(
    strategy: str | Path | Callable,
    data: str | Path | list[ProviderBar],
    symbol: str | None = None,
    initial_capital: float | Decimal = 100000,
    commission: float | Decimal = 0.001,
    slippage_bps: float | Decimal = 5,
    start: str | datetime | None = None,
    end: str | datetime | None = None,
    fill_assumption: str = "next_open",
    position_size: int = 100,
    allow_short: bool = True,
    **kwargs,
) -> BacktestResults:
    """
    Run a backtest with given strategy and data.

    Args:
        strategy: Path to strategy file, or strategy function
        data: Path to data file (CSV/Parquet), or list of Bar objects
        symbol: Symbol name (auto-detected from filename if not specified)
        initial_capital: Starting capital (default: 100,000)
        commission: Commission rate as decimal (default: 0.001 = 0.1%)
        slippage_bps: Slippage in basis points (default: 5)
        start: Start date filter (string 'YYYY-MM-DD' or datetime)
        end: End date filter (string 'YYYY-MM-DD' or datetime)
        fill_assumption: Fill price assumption ('next_open', 'next_close', 'typical_price')
        position_size: Default position size for signals (default: 100)
        allow_short: Allow short selling (default: True)
        **kwargs: Additional configuration options

    Returns:
        BacktestResults object with performance metrics

    Example:
        # Basic usage
        results = backtest("sma_crossover.py", "AAPL.csv")
        print(results.summary())

        # With options
        results = backtest(
            strategy="momentum.py",
            data="SPY.parquet",
            initial_capital=50000,
            commission=0.0005,
            start="2023-01-01",
            end="2023-06-30",
        )
    """
    warnings: list[str] = []

    # Parse dates
    if isinstance(start, str):
        start = datetime.fromisoformat(start)
    if isinstance(end, str):
        end = datetime.fromisoformat(end)

    # Ensure timezone awareness
    if start and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end and end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    # Load data
    if isinstance(data, (str, Path)):
        data_path = Path(data)
        if symbol is None:
            symbol = data_path.stem.upper()
        bars = load_data(data_path, symbol, start, end)
    else:
        bars = data
        if symbol is None:
            symbol = bars[0].symbol if bars else "UNKNOWN"

    if not bars:
        raise ValueError("No data loaded for backtesting")

    # Determine date range from data if not specified
    if start is None:
        start = bars[0].timestamp
    if end is None:
        end = bars[-1].timestamp

    # Ensure start/end are timezone aware for config
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    logger.info(f"Loaded {len(bars)} bars for {symbol} from {start.date()} to {end.date()}")

    # Load/parse strategy, injecting parameter overrides when provided
    params: dict[str, Any] | None = kwargs.get("params")
    strategy_func = _load_strategy(strategy, params=params)
    strategy_name = _get_strategy_name(strategy)

    # Install parameter overrides so ql.param(id=...) calls pick them up
    if params:
        from quantlab.api.params import set_param_overrides
        set_param_overrides(params)

    # Generate signals
    signal_gen = SignalGenerator(strategy_func, position_size=position_size)
    try:
        signals = signal_gen.generate(bars)
    except Exception as e:
        warnings.append(f"Strategy execution error: {e}")
        signals = []
    finally:
        if params:
            from quantlab.api.params import clear_param_overrides
            clear_param_overrides()

    logger.info(f"Generated {len(signals)} signals")

    # Convert to Decimal
    initial_capital = Decimal(str(initial_capital))
    commission = Decimal(str(commission))
    slippage_bps = Decimal(str(slippage_bps))

    # Create backtest config
    config = BacktestConfig(
        start_date=start,
        end_date=end,
        initial_capital=initial_capital,
        commission_model=CommissionModel.PER_TRADE if commission > 0 else CommissionModel.NONE,
        commission_params={"rate": commission} if commission > 0 else {},
        slippage_model=SlippageModel.FIXED_BPS if slippage_bps > 0 else SlippageModel.NONE,
        slippage_params={"bps": slippage_bps} if slippage_bps > 0 else {},
        fill_assumption=_parse_fill_assumption(fill_assumption),
        allow_short=allow_short,
    )

    # Convert bars to engine format (volume needs Decimal for engine Bar)
    engine_bars = [
        Bar(
            symbol=b.symbol,
            timestamp=b.timestamp if b.timestamp.tzinfo else b.timestamp.replace(tzinfo=timezone.utc),
            open=b.open,
            high=b.high,
            low=b.low,
            close=b.close,
            volume=Decimal(str(b.volume)),
        )
        for b in bars
    ]

    # Pre-index signals by bar_index for O(1) lookup instead of O(n)
    signals_by_bar: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for sig in signals:
        bar_idx = sig.get("bar_index")
        if bar_idx is not None:
            signals_by_bar[bar_idx].append(sig)

    # Run backtest with signals
    equity_curve: list[tuple[datetime, Decimal]] = []
    trades: list[dict[str, Any]] = []
    fills: list[Fill] = []
    current_position = 0  # Positive = long, negative = short
    cash = initial_capital  # Track cash separately from equity

    for i, bar in enumerate(engine_bars):
        # Check for signals at this bar (O(1) lookup)
        bar_signals = signals_by_bar.get(i, [])

        for sig in bar_signals:
            side_str = sig.get("side", "").lower()
            quantity = sig.get("quantity", position_size)

            if side_str == "buy" and current_position <= 0:
                # Buy signal - go long or cover short
                if current_position < 0:
                    side = OrderSide.BUY_TO_COVER
                    quantity = abs(current_position)  # Cover exact short amount
                else:
                    side = OrderSide.BUY

                # Simulate fill at next bar's open
                if i + 1 < len(engine_bars):
                    next_bar = engine_bars[i + 1]
                    fill_price = next_bar.open
                    cost = fill_price * Decimal(str(quantity))
                    comm = cost * commission

                    if current_position < 0:
                        # Covering short: we owe the shares back
                        # Cash decreases by cost of buying back + commission
                        cash -= (cost + comm)
                    else:
                        # Opening long: cash decreases by purchase price + commission
                        cash -= (cost + comm)

                    current_position += quantity

                    fill = Fill(
                        order_id=f"order-{i}-buy",
                        symbol=symbol,
                        side=side,
                        quantity=quantity,
                        price=fill_price,
                        commission=comm,
                        timestamp=next_bar.timestamp,
                    )
                    fills.append(fill)
                    trades.append({
                        "timestamp": next_bar.timestamp.isoformat(),
                        "side": "buy",
                        "quantity": quantity,
                        "price": float(fill_price),
                        "commission": float(comm),
                    })

            elif side_str == "sell" and current_position >= 0:
                # Sell signal - close long or go short
                if current_position > 0:
                    side = OrderSide.SELL
                    qty = current_position  # Close entire long position
                elif allow_short:
                    side = OrderSide.SELL_SHORT
                    qty = position_size
                else:
                    continue  # Short selling not allowed

                # Simulate fill at next bar's open
                if i + 1 < len(engine_bars):
                    next_bar = engine_bars[i + 1]
                    fill_price = next_bar.open
                    proceeds = fill_price * Decimal(str(qty))
                    comm = proceeds * commission

                    # Cash increases by sale proceeds minus commission
                    cash += (proceeds - comm)
                    current_position -= qty

                    fill = Fill(
                        order_id=f"order-{i}-sell",
                        symbol=symbol,
                        side=side,
                        quantity=qty,
                        price=fill_price,
                        commission=comm,
                        timestamp=next_bar.timestamp,
                    )
                    fills.append(fill)
                    trades.append({
                        "timestamp": next_bar.timestamp.isoformat(),
                        "side": "sell",
                        "quantity": qty,
                        "price": float(fill_price),
                        "commission": float(comm),
                    })

        # Mark-to-market equity = cash + position_value
        # current_position is signed: positive for long, negative for short
        # For long: cash + pos * close (position has value)
        # For short: cash + pos * close (pos is negative, so subtracts obligation)
        mtm_equity = cash + Decimal(str(current_position)) * bar.close
        equity_curve.append((bar.timestamp, mtm_equity))

    # Calculate final equity (mark-to-market at last bar)
    if engine_bars:
        last_bar = engine_bars[-1]
        final_equity = cash + Decimal(str(current_position)) * last_bar.close
    else:
        final_equity = initial_capital

    # Calculate returns
    total_return = final_equity - initial_capital
    if initial_capital > 0:
        total_return_pct = (total_return / initial_capital) * Decimal("100")
    else:
        total_return_pct = Decimal("0")

    # Calculate metrics
    metrics = None
    if equity_curve and len(equity_curve) > 1:
        try:
            calculator = MetricsCalculator()
            equity_values = [float(e) for _, e in equity_curve]
            metrics = calculator.calculate(
                equity_curve=equity_values,
                trades=trades,
                initial_capital=float(initial_capital),
            )
        except Exception as e:
            warnings.append(f"Metrics calculation error: {e}")

    return BacktestResults(
        strategy_name=strategy_name,
        symbol=symbol,
        start_date=start,
        end_date=end,
        initial_capital=initial_capital,
        final_equity=final_equity,
        total_return=total_return,
        total_return_pct=total_return_pct,
        trades=trades,
        fills=fills,
        metrics=metrics,
        equity_curve=equity_curve,
        warnings=warnings,
    )


def _load_strategy(
    strategy: str | Path | Callable,
    params: dict[str, Any] | None = None,
) -> Callable:
    """Load strategy function from file or return if already callable."""
    if callable(strategy):
        return strategy

    path = Path(strategy)
    if not path.exists():
        raise FileNotFoundError(f"Strategy file not found: {path}")

    # Execute strategy file and extract strategy function
    import importlib.util

    spec = importlib.util.spec_from_file_location("strategy_module", path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Could not load strategy from: {path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # Look for strategy function
    if hasattr(module, "strategy"):
        return module.strategy
    elif hasattr(module, "on_bar"):
        return module.on_bar
    elif hasattr(module, "Strategy"):
        # Class-based strategy — pass parameter overrides to constructor
        strategy_class = module.Strategy
        instance = strategy_class(**(params or {}))
        if hasattr(instance, "on_bar"):
            return instance.on_bar
        elif hasattr(instance, "strategy"):
            return instance.strategy

    raise ValueError(f"No strategy function found in {path}. Expected 'strategy(data)' or 'on_bar(ctx)'")


def _get_strategy_name(strategy: str | Path | Callable) -> str:
    """Get strategy name for display."""
    if callable(strategy):
        return getattr(strategy, "__name__", "custom_strategy")
    return Path(strategy).stem


def _parse_fill_assumption(fill_str: str) -> FillAssumption:
    """Parse fill assumption string to enum."""
    mapping = {
        "next_open": FillAssumption.NEXT_OPEN,
        "next_close": FillAssumption.NEXT_CLOSE,
        "typical_price": FillAssumption.TYPICAL_PRICE,
        "vwap": FillAssumption.TYPICAL_PRICE,  # Alias
    }
    result = mapping.get(fill_str.lower())
    if result is None:
        logger.warning(
            f"Unknown fill assumption '{fill_str}', defaulting to 'next_open'. "
            f"Valid options: {list(mapping.keys())}"
        )
        return FillAssumption.NEXT_OPEN
    return result
