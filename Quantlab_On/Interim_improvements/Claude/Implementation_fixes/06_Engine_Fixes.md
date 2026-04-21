# Core Backtest Engine Fixes

---

## FIX-E001: Parquet Data Loader Missing (P1 - High)

**File**: `engine/quantlab/data/` (new file needed)
**Issue**: Only CSV loading exists. Parquet is the preferred format for large datasets but no loader exists.

**Fix**: Create `parquet_loader.py`:
```python
"""
Parquet Data Loader.

Uses Apache Arrow for efficient columnar data reading.
"""

import pyarrow.parquet as pq
from decimal import Decimal
from datetime import datetime
from pathlib import Path
from typing import Iterator

from quantlab.backtest.bar import BarSeries, Bar


class ParquetLoader:
    """Load bar data from Parquet files."""

    def __init__(self, path: Path | str):
        self._path = Path(path)
        self._table = None

    def load(self) -> BarSeries:
        """Load entire file into BarSeries."""
        self._table = pq.read_table(self._path)
        return self._table_to_bar_series(self._table)

    def load_lazy(self, batch_size: int = 10000) -> Iterator[list[Bar]]:
        """Load data in batches for memory efficiency."""
        parquet_file = pq.ParquetFile(self._path)

        for batch in parquet_file.iter_batches(batch_size=batch_size):
            yield self._batch_to_bars(batch)

    def load_range(
        self,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> BarSeries:
        """Load data within a date range."""
        filters = []
        if start:
            filters.append(("timestamp", ">=", start))
        if end:
            filters.append(("timestamp", "<=", end))

        table = pq.read_table(self._path, filters=filters if filters else None)
        return self._table_to_bar_series(table)

    def _table_to_bar_series(self, table) -> BarSeries:
        """Convert PyArrow table to BarSeries."""
        df = table.to_pandas()

        bars = []
        for _, row in df.iterrows():
            bar = Bar(
                timestamp=row["timestamp"].to_pydatetime(),
                open=Decimal(str(row["open"])),
                high=Decimal(str(row["high"])),
                low=Decimal(str(row["low"])),
                close=Decimal(str(row["close"])),
                volume=int(row["volume"]),
            )
            bars.append(bar)

        return BarSeries(bars=bars)

    def _batch_to_bars(self, batch) -> list[Bar]:
        """Convert record batch to list of Bars."""
        df = batch.to_pandas()
        return [
            Bar(
                timestamp=row["timestamp"].to_pydatetime(),
                open=Decimal(str(row["open"])),
                high=Decimal(str(row["high"])),
                low=Decimal(str(row["low"])),
                close=Decimal(str(row["close"])),
                volume=int(row["volume"]),
            )
            for _, row in df.iterrows()
        ]


def write_parquet(bars: BarSeries, path: Path | str) -> None:
    """Write BarSeries to Parquet file."""
    import pyarrow as pa

    arrays = {
        "timestamp": pa.array([b.timestamp for b in bars]),
        "open": pa.array([float(b.open) for b in bars]),
        "high": pa.array([float(b.high) for b in bars]),
        "low": pa.array([float(b.low) for b in bars]),
        "close": pa.array([float(b.close) for b in bars]),
        "volume": pa.array([b.volume for b in bars]),
    }

    table = pa.table(arrays)
    pq.write_table(table, path, compression="snappy")
```

---

## FIX-E002: Strategy Validation Before Run Missing (P1 - High)

**File**: `engine/quantlab/api/` (new file or add to existing)
**Issue**: No validation step before running a strategy. Invalid strategies fail during execution with unclear error messages.

**Fix**: Create `api/validation.py`:
```python
"""
Strategy Validation.

Validates strategy code before execution to catch common errors early.
"""

import ast
import inspect
from dataclasses import dataclass
from typing import Any, Type

from quantlab.api.class_based import Strategy
from quantlab.api.event import EventDrivenStrategy


@dataclass
class ValidationResult:
    """Result of strategy validation."""
    valid: bool
    errors: list[str]
    warnings: list[str]


class StrategyValidator:
    """Validate strategy code before execution."""

    def validate(self, strategy: Strategy | EventDrivenStrategy) -> ValidationResult:
        """Validate a strategy instance."""
        errors = []
        warnings = []

        # Check required methods
        if isinstance(strategy, Strategy):
            if not hasattr(strategy, "on_bar") or not callable(strategy.on_bar):
                errors.append("Strategy must implement on_bar(ctx) method")

        # Check parameters have valid defaults
        params = self._get_params(strategy)
        for name, value in params.items():
            if value is None:
                warnings.append(f"Parameter '{name}' has None default")

        # Check for common mistakes
        source = inspect.getsource(type(strategy))
        tree = ast.parse(source)

        # Look for bare except clauses
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is None:
                warnings.append(
                    f"Line {node.lineno}: Bare 'except:' clause may hide errors"
                )

        # Look for time.sleep (blocks event loop)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and
                isinstance(node.func, ast.Attribute) and
                node.func.attr == "sleep"):
                errors.append(
                    f"Line {node.lineno}: time.sleep() blocks event loop. "
                    "Use asyncio.sleep() in async code or avoid sleeping."
                )

        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    def validate_source(self, source_code: str) -> ValidationResult:
        """Validate strategy source code without instantiating."""
        errors = []
        warnings = []

        # Parse syntax
        try:
            tree = ast.parse(source_code)
        except SyntaxError as e:
            errors.append(f"Syntax error at line {e.lineno}: {e.msg}")
            return ValidationResult(valid=False, errors=errors, warnings=warnings)

        # Check for Strategy subclass
        has_strategy_class = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                for base in node.bases:
                    if isinstance(base, ast.Name) and base.id == "Strategy":
                        has_strategy_class = True
                        break

        if not has_strategy_class:
            errors.append("No Strategy subclass found in source")

        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    def _get_params(self, strategy: Strategy) -> dict[str, Any]:
        """Extract parameter values from strategy."""
        from quantlab.api.params import extract_params
        return {name: getattr(strategy, name) for name in extract_params(strategy)}


def validate_strategy(strategy: Strategy) -> ValidationResult:
    """Convenience function for strategy validation."""
    return StrategyValidator().validate(strategy)
```

---

## FIX-E003: Metrics Annualization May Use Wrong Factor (P2 - Medium)

**File**: `engine/quantlab/metrics/annualize.py`
**Issue**: Need to verify annualization uses calendar-specific factors (252 for equities, 365 for crypto) rather than hardcoding 252.

**Fix**: Ensure annualization accepts calendar parameter:
```python
def get_annualization_factor(calendar_name: str | None = None) -> float:
    """
    Get the appropriate annualization factor for a calendar.

    Args:
        calendar_name: Calendar name (e.g., "nyse", "crypto_24_7")

    Returns:
        Annualization factor (sqrt of trading days per year)
    """
    from quantlab.calendar.loader import CalendarLoader

    KNOWN_FACTORS = {
        "nyse": 252,
        "nasdaq": 252,
        "crypto_24_7": 365,
    }

    if calendar_name is None:
        return math.sqrt(252)  # Default to equity

    factor = KNOWN_FACTORS.get(calendar_name.lower())
    if factor:
        return math.sqrt(factor)

    # Try to calculate from calendar definition
    try:
        calendar = CalendarLoader.load(calendar_name)
        trading_days = calendar.trading_days_per_year()
        return math.sqrt(trading_days)
    except Exception:
        logger.warning(f"Unknown calendar '{calendar_name}', using 252")
        return math.sqrt(252)


def annualize_returns(
    returns: list[Decimal],
    calendar_name: str | None = None,
) -> Decimal:
    """Annualize returns using calendar-appropriate factor."""
    factor = get_annualization_factor(calendar_name)
    mean_return = sum(returns) / len(returns)
    return mean_return * Decimal(str(factor))


def annualize_volatility(
    returns: list[Decimal],
    calendar_name: str | None = None,
) -> Decimal:
    """Annualize volatility using calendar-appropriate factor."""
    factor = get_annualization_factor(calendar_name)
    std = _calculate_std(returns)
    return std * Decimal(str(factor))
```

---

## FIX-E004: Some Metrics May Use Float Internally (P2 - Medium)

**File**: `engine/quantlab/metrics/risk.py`, `metrics/returns.py`
**Issue**: Some metrics use `math.sqrt()` which requires float conversion. This is technically correct but should be documented.

**Fix**: Add precision documentation and use Decimal where practical:
```python
def sharpe_ratio(
    returns: list[Decimal],
    risk_free_rate: Decimal = Decimal("0"),
    calendar_name: str | None = None,
) -> Decimal:
    """
    Calculate Sharpe ratio.

    Note: Intermediate calculations use float for performance.
    Final result is Decimal with 6 decimal places precision.

    Args:
        returns: List of period returns
        risk_free_rate: Risk-free rate (same period as returns)
        calendar_name: Calendar for annualization

    Returns:
        Annualized Sharpe ratio as Decimal
    """
    if len(returns) < 2:
        return Decimal("0")

    # Convert to float for calculation (documented behavior)
    float_returns = [float(r) for r in returns]
    rf = float(risk_free_rate)

    excess_returns = [r - rf for r in float_returns]
    mean_excess = sum(excess_returns) / len(excess_returns)
    std = (sum((r - mean_excess) ** 2 for r in excess_returns) / (len(excess_returns) - 1)) ** 0.5

    if std == 0:
        return Decimal("0")

    factor = float(get_annualization_factor(calendar_name))
    sharpe = (mean_excess / std) * factor

    # Return as Decimal, rounded to 6 places
    return Decimal(str(round(sharpe, 6)))
```

---

## FIX-E005: Custom Metrics Registration Not Supported (P2 - Medium)

**File**: `engine/quantlab/metrics/__init__.py`
**Issue**: No mechanism for users to register custom metrics functions.

**Fix**: Add registry:
```python
_custom_metrics: dict[str, Callable] = {}


def register_metric(name: str, func: Callable) -> None:
    """
    Register a custom metric function.

    The function should accept a BacktestResult and return a Decimal.

    Example:
        def my_metric(result):
            return Decimal(str(len(result.trades)))

        register_metric("trade_count", my_metric)
    """
    if name in _custom_metrics:
        raise ValueError(f"Metric '{name}' is already registered")
    _custom_metrics[name] = func


def get_metric(name: str) -> Callable:
    """Get a metric function by name."""
    if name in _custom_metrics:
        return _custom_metrics[name]

    # Check built-in metrics
    builtin = {
        "sharpe": sharpe_ratio,
        "sortino": sortino_ratio,
        "max_drawdown": max_drawdown,
        # ... etc
    }
    if name in builtin:
        return builtin[name]

    raise ValueError(f"Unknown metric: {name}")


def calculate_all_metrics(result, custom_only: bool = False) -> dict[str, Decimal]:
    """Calculate all registered metrics."""
    metrics = {}

    if not custom_only:
        metrics["sharpe"] = sharpe_ratio(result.returns)
        metrics["sortino"] = sortino_ratio(result.returns)
        # ... etc

    for name, func in _custom_metrics.items():
        try:
            metrics[name] = func(result)
        except Exception as e:
            logger.warning(f"Custom metric '{name}' failed: {e}")

    return metrics
```

---

## FIX-E006: DataRev Chain Verification Not Exposed (P3 - Low)

**File**: `engine/quantlab/data/rev.py`
**Issue**: DataRev implements hashing but no public method to verify the chain integrity.

**Fix**: Add chain verification:
```python
def verify_chain(revisions: list[DataRevision]) -> bool:
    """
    Verify the integrity of a revision chain.

    Args:
        revisions: List of revisions in chronological order

    Returns:
        True if chain is valid
    """
    for i, rev in enumerate(revisions):
        # Verify hash matches content
        computed_hash = compute_revision_hash(rev.data_path, rev.metadata)
        if computed_hash != rev.hash:
            logger.error(f"Revision {rev.id} hash mismatch")
            return False

        # Verify parent link (except for first)
        if i > 0:
            expected_parent = revisions[i - 1].hash
            if rev.parent_hash != expected_parent:
                logger.error(f"Revision {rev.id} parent hash mismatch")
                return False

    return True
```
