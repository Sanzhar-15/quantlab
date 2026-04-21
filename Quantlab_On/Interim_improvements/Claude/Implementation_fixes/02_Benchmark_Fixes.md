# Benchmark System Fixes

---

## FIX-B001: Benchmark Strategies Not Wired to Runner (P1 - High)

**Files**:
- `engine/benchmarks/runner.py`
- `engine/benchmarks/strategies/sma_crossover.py`
- `engine/benchmarks/strategies/rsi_macd.py`
- `engine/benchmarks/strategies/momentum.py`
- `engine/benchmarks/strategies/rotation.py`

**Issue**: The benchmark runner's `_run_backtest()` method ignores the strategy file parameter entirely and uses a hardcoded inline `BenchmarkStrategyAdapter` with simple SMA 10/20 logic. All 4 benchmarks run the same strategy. The strategy files in `strategies/` use a high-level `ql.param()`/`ql.Signals()` API that isn't connected to anything.

**Fix**: Rewrite the strategy files to use the actual engine API (class-based strategy via `quantlab.api.class_based.Strategy`), then update the runner to load and execute the correct strategy per benchmark:

```python
# In runner.py, replace _run_backtest:
def _run_backtest(self, benchmark: BenchmarkDefinition) -> BenchmarkResult:
    """Run a complete backtest benchmark."""
    from quantlab.api.class_based import StrategyRunner
    import importlib.util

    # Dynamically load the strategy module
    spec = importlib.util.spec_from_file_location(
        benchmark.strategy_name,
        benchmark.strategy_path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # Get the strategy class (first Strategy subclass found)
    strategy_cls = None
    for attr_name in dir(module):
        attr = getattr(module, attr_name)
        if isinstance(attr, type) and issubclass(attr, Strategy) and attr is not Strategy:
            strategy_cls = attr
            break

    if strategy_cls is None:
        raise ValueError(f"No Strategy subclass found in {benchmark.strategy_path}")

    strategy = strategy_cls()
    runner = StrategyRunner(strategy)
    # ... rest of execution
```

Rewrite each strategy file to use the engine API:
```python
# strategies/rsi_macd.py - Example fix
from quantlab.api.class_based import Strategy
from quantlab.api.event import Context
from decimal import Decimal

class RSIMACDStrategy(Strategy):
    name = "RSI + MACD"
    rsi_period: int = 14
    macd_fast: int = 12
    macd_slow: int = 26
    macd_signal: int = 9

    def on_bar(self, ctx: Context) -> None:
        # ... actual implementation using ctx API
```

---

## FIX-B002: Benchmark Data Not Generated in CI (P1 - High)

**File**: `.github/workflows/engine-benchmark.yml`

**Issue**: The benchmark workflow does not generate test data before running benchmarks. The CSV files don't exist on disk.

**Fix**: Add data generation step before benchmark execution:
```yaml
- name: Generate benchmark data
  run: |
    cd engine
    python -m benchmarks.data.generate_data
    ls -la benchmarks/data/*.csv  # Verify files created
```

---

## FIX-B003: Git-Based Baseline Comparison Not Implemented (P1 - High)

**File**: `engine/benchmarks/check.py:~123`

**Issue**: The explicit TODO at line 123 - passing a git ref as `--baseline` fails.

**Fix**: Implement git-based baseline fetching:
```python
def _fetch_git_baseline(ref: str, output_path: str) -> str:
    """Fetch benchmark results from a git ref."""
    import subprocess

    # Try to fetch the baseline results artifact from the ref
    result = subprocess.run(
        ["git", "show", f"{ref}:benchmarks/baseline.json"],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        # Try GitHub Actions artifact API
        # Fallback: run benchmarks against the ref
        raise FileNotFoundError(
            f"No baseline found for ref '{ref}'. "
            f"Run benchmarks on {ref} first and commit baseline.json"
        )

    Path(output_path).write_text(result.stdout)
    return output_path
```

---

## FIX-B004: Benchmark __init__.py Missing Exports (P2 - Medium)

**File**: `engine/benchmarks/__init__.py`

**Issue**: Contains only a docstring. Cannot import benchmark classes directly.

**Fix**:
```python
"""Quantlab Engine Benchmark Suite."""

from benchmarks.runner import BenchmarkRunner, BenchmarkResult, BenchmarkDefinition
from benchmarks.analysis import AnalysisResult, compare_results
from benchmarks.check import check_regression

__all__ = [
    "BenchmarkRunner",
    "BenchmarkResult",
    "BenchmarkDefinition",
    "AnalysisResult",
    "compare_results",
    "check_regression",
]
```

---

## FIX-B005: Benchmark Strategies Directory Missing __init__.py (P2 - Medium)

**File**: `engine/benchmarks/strategies/__init__.py` (MISSING)

**Issue**: No `__init__.py` in strategies directory. Cannot import strategies as a Python package.

**Fix**: Create the file:
```python
"""Benchmark strategy definitions."""
```

---

## FIX-B006: Benchmark Runner CLI Missing --strategy Flag (P3 - Low)

**File**: `engine/benchmarks/runner.py`

**Issue**: The CLI `main()` function allows `--name` to select a benchmark but doesn't allow overriding the strategy file.

**Fix**: Add `--strategy` argument:
```python
parser.add_argument("--strategy", help="Override strategy file for benchmark")
```
