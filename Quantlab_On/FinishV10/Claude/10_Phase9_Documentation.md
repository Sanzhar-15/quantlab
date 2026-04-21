# Phase 9: Documentation & Polish (6 fixes)

**Final polish** -- Documentation, minor fixes, and cleanup.

## Phase Overview

This is the last phase -- documentation, minor watchdog fixes, reliability verification, and test suite documentation.

## Prerequisites

- All other phases should be substantially complete before this phase.

---

## Fix List (Execution Order)

### FIX-D007 [P2] Fix watchdog alert callback (async support)

**Problem**: Watchdog alert callback may not support async handlers, causing errors when async operations are needed in the callback.

**Evidence**:
- `engine/quantlab/daemon/watchdog.py:268` -- alert callback invocation

**Files to modify**:
- `engine/quantlab/daemon/watchdog.py`

**Implementation**:

```python
# engine/quantlab/daemon/watchdog.py
# Update alert callback to support async:

import asyncio
import inspect

class Watchdog:
    """System watchdog for daemon health monitoring."""

    def __init__(self, timeout_seconds: float = 30.0, on_alert=None):
        self._timeout = timeout_seconds
        self._on_alert = on_alert
        self._last_heartbeat = None
        self._running = False

    async def _check_health(self):
        """Periodic health check."""
        while self._running:
            await asyncio.sleep(self._timeout / 2)

            if self._last_heartbeat is None:
                continue

            elapsed = (asyncio.get_event_loop().time() - self._last_heartbeat)
            if elapsed > self._timeout:
                # FIX-D007: Support async alert callbacks
                if self._on_alert:
                    if inspect.iscoroutinefunction(self._on_alert):
                        await self._on_alert({
                            "type": "watchdog_timeout",
                            "elapsed_seconds": elapsed,
                            "timeout": self._timeout,
                        })
                    else:
                        self._on_alert({
                            "type": "watchdog_timeout",
                            "elapsed_seconds": elapsed,
                            "timeout": self._timeout,
                        })

    def heartbeat(self):
        """Record a heartbeat from the monitored process."""
        self._last_heartbeat = asyncio.get_event_loop().time()

    async def start(self):
        self._running = True
        asyncio.create_task(self._check_health())

    async def stop(self):
        self._running = False
```

**Verification**:
1. Async callback -> called with `await`
2. Sync callback -> called directly
3. No "coroutine was never awaited" warnings

**Dependencies**: None

---

### FIX-P002 [P1] Verify reliability manager tracks all critical message types

**Problem**: Reliability manager may not track all message types that require delivery confirmation.

**Evidence**:
- `engine/quantlab/protocol/reliability.py` -- reliability tracking

**Files to modify**:
- `engine/quantlab/protocol/reliability.py`

**Implementation**:

```python
# engine/quantlab/protocol/reliability.py
# Verify all critical message types are tracked:

CRITICAL_MESSAGE_TYPES = {
    "positions.update",
    "orders.update",
    "fills.update",
    "risk.alert",
    "circuit_breaker.trip",
    "connection.update",
    "session.state_change",
}

class ReliabilityManager:
    """Ensures reliable delivery of critical messages.

    FIX-P002: All critical message types tracked.
    """

    def __init__(self):
        self._sequence = 0
        self._pending: dict[int, dict] = {}
        self._delivered: set[int] = set()

    def wrap_message(self, method: str, params: dict) -> dict:
        """Add reliability metadata to message."""
        self._sequence += 1

        message = {
            "method": method,
            "params": params,
            "_meta": {
                "sequence": self._sequence,
                "timestamp": datetime.utcnow().isoformat(),
                "requires_ack": method in CRITICAL_MESSAGE_TYPES,
            },
        }

        if method in CRITICAL_MESSAGE_TYPES:
            self._pending[self._sequence] = message

        return message

    def acknowledge(self, sequence: int):
        """Mark a message as delivered."""
        self._pending.pop(sequence, None)
        self._delivered.add(sequence)

    def get_undelivered(self) -> list[dict]:
        """Get messages that haven't been acknowledged."""
        return list(self._pending.values())

    @property
    def pending_count(self) -> int:
        return len(self._pending)
```

**Verification**:
1. All 7 critical message types listed in `CRITICAL_MESSAGE_TYPES`
2. Critical messages tracked in pending until acknowledged
3. Non-critical messages not tracked (no memory buildup)

**Dependencies**: None

---

### FIX-E004 [P2] Document float conversion points in metrics

**Problem**: Metrics calculations have implicit float conversions that should be documented.

**Files to modify**:
- `engine/quantlab/metrics/risk.py`

**Implementation**:

```python
# engine/quantlab/metrics/risk.py
# Add docstrings documenting float conversion points:

def sharpe_ratio(
    returns: list[float],
    risk_free_rate: float = 0.0,
    annualization_factor: float = 252.0,
) -> float:
    """Calculate annualized Sharpe ratio.

    FIX-E004: Float precision notes:
    - Returns are stored as float64 (Python default)
    - Standard deviation uses Bessel's correction (ddof=1)
    - Division by near-zero std dev returns 0.0 (not inf)
    - Annualization: multiply by sqrt(factor), not factor

    Args:
        returns: List of period returns (e.g., daily returns as decimals)
        risk_free_rate: Risk-free rate per period (same frequency as returns)
        annualization_factor: Number of periods per year (252 for daily)

    Returns:
        Annualized Sharpe ratio (float64)

    Precision considerations:
        For very small returns (< 1e-10), the ratio may be unreliable
        due to floating-point division. Use Decimal for critical calculations.
    """
    import numpy as np

    excess = np.array(returns) - risk_free_rate
    mean_excess = np.mean(excess)
    std_excess = np.std(excess, ddof=1)

    if std_excess < 1e-10:
        return 0.0

    return float(mean_excess / std_excess * np.sqrt(annualization_factor))


def sortino_ratio(
    returns: list[float],
    target_return: float = 0.0,
    annualization_factor: float = 252.0,
) -> float:
    """Calculate annualized Sortino ratio.

    FIX-E004: Float precision notes:
    - Downside deviation uses only negative excess returns
    - Empty downside returns yield 0.0 (strategy has no downside)
    - Same annualization as Sharpe (sqrt of factor)
    """
    import numpy as np

    excess = np.array(returns) - target_return
    mean_excess = np.mean(excess)
    downside = excess[excess < 0]

    if len(downside) == 0:
        return 0.0  # No downside deviation

    downside_std = np.sqrt(np.mean(downside ** 2))

    if downside_std < 1e-10:
        return 0.0

    return float(mean_excess / downside_std * np.sqrt(annualization_factor))
```

**Verification**:
1. Docstrings explain float precision considerations
2. Edge cases (zero std dev, empty returns) documented and handled
3. No NaN or Inf returned from any metric

**Dependencies**: None

---

### FIX-B005 [P2] Add strategies directory __init__.py

**Problem**: Benchmarks strategies directory missing `__init__.py`.

**Files to create**:
- `engine/benchmarks/strategies/__init__.py`

**Implementation**:

```python
# engine/benchmarks/strategies/__init__.py

"""Benchmark strategies for performance testing."""

from pathlib import Path

STRATEGIES_DIR = Path(__file__).parent

def list_strategies() -> list[str]:
    """List available benchmark strategy files."""
    return [f.stem for f in STRATEGIES_DIR.glob("*.py") if f.stem != "__init__"]
```

**Verification**:
1. `from benchmarks.strategies import list_strategies` works
2. `list_strategies()` returns available benchmark strategies

**Dependencies**: None

---

### FIX-B006 [P3] Add --strategy CLI flag to benchmark runner

**Problem**: Benchmark runner runs all strategies. Need option to run a specific one.

**Files to modify**:
- `engine/benchmarks/runner.py`

**Implementation**:

```python
# engine/benchmarks/runner.py
# Add CLI interface:

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run engine benchmarks")
    parser.add_argument(
        "--strategy",
        help="Run specific strategy benchmark (default: all)",
    )
    parser.add_argument(
        "--output",
        default="benchmarks/results/latest.json",
        help="Output file for results",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=3,
        help="Number of iterations per benchmark",
    )

    args = parser.parse_args()

    runner = BenchmarkRunner()

    if args.strategy:
        # Run specific strategy
        strategies = [args.strategy]
    else:
        from benchmarks.strategies import list_strategies
        strategies = list_strategies()

    for name in strategies:
        print(f"Running benchmark: {name}")
        for i in range(args.iterations):
            result = runner.run_benchmark(f"{name}_iter{i}", ...)
            print(f"  Iteration {i+1}: {result['elapsed_seconds']:.3f}s "
                  f"({result['bars_per_second']:.0f} bars/s)")

    runner.save_results(args.output)
    print(f"Results saved to {args.output}")
```

**Verification**:
1. `python -m benchmarks.runner --strategy momentum` runs only momentum
2. `python -m benchmarks.runner` runs all strategies
3. `--iterations 5` runs each 5 times

**Dependencies**: FIX-B005

---

### FIX-TEST-006 [P3] Write test suite documentation

**Problem**: Test suite lacks documentation for new contributors.

**Files to create**:
- `engine/tests/README.md`

**Implementation**:

```markdown
# Quantlab Engine Test Suite

## Structure

```
tests/
├── api/            # Strategy API tests
├── backtest/       # Backtest engine tests
├── daemon/         # Daemon IPC and lifecycle tests
├── golden/         # Golden output tests (G001-G105)
├── live/           # Live trading tests (L001-L070)
├── chaos/          # Failure scenario tests
├── fixtures/       # Shared test fixtures and mock broker
├── integration/    # End-to-end integration tests
├── risk/           # Risk management tests
├── trading/        # Trading logic tests
└── ...             # Other module-specific tests
```

## Running Tests

```bash
# All tests
pytest tests/ -v

# Specific module
pytest tests/backtest/ -v

# Golden tests only
pytest tests/golden/ -v

# Live trading tests (uses mock broker)
pytest tests/live/ -v

# With coverage
pytest tests/ --cov=quantlab --cov-report=html
```

## Test Categories

### Golden Tests (G001-G105)
Deterministic tests that verify backtest output matches known-good results.
Each test loads specific data, runs a strategy, and compares results to
saved baseline values. Changes to backtest engine require reviewing and
potentially updating golden test baselines.

### Live Trading Tests (L001-L070)
Tests that verify the live trading daemon using a mock broker. Cover:
- Session lifecycle (start, pause, resume, stop)
- Order flow (submit, cancel, modify, fill)
- Risk controls (exposure limits, circuit breaker, consecutive losses)
- Reconciliation (position/fill discrepancy detection)
- Failure scenarios (broker disconnect, client crash)

### Chaos Tests
Deliberately inject failures to verify resilience:
- Network disconnections during order flow
- Rapid connect/disconnect cycles
- Resource exhaustion scenarios

## Fixtures

### Mock Broker (`fixtures/mock_broker.py`)
Configurable mock broker supporting:
- `fill_delay_ms`: Simulated network latency
- `partial_fill_rate`: Probability of partial fills
- `reject_rate`: Probability of order rejection
- `slippage_bps`: Simulated slippage

## CI Integration

Tests run automatically via GitHub Actions:
- `engine-pr.yml`: Lint + tests + golden tests on PR
- `engine-ci.yml`: Full test suite on push to main
- `engine-benchmark.yml`: Performance benchmarks
- `engine-security.yml`: Security scanning (weekly)

## Writing New Tests

1. Place test in the appropriate subdirectory
2. Use `pytest.mark.asyncio` for async tests
3. Use fixtures from `conftest.py` for common setup
4. For golden tests, update baselines with: `pytest --update-golden`
5. For live tests, use the mock broker fixture
```

**Verification**:
1. README accurately describes test structure
2. All documented commands work
3. New contributors can understand and run tests

**Dependencies**: All test-related fixes

---

## Phase Verification Checklist

- [ ] Watchdog supports async alert callbacks
- [ ] Reliability manager tracks all 7 critical message types
- [ ] Metrics have float precision documentation
- [ ] Benchmarks strategies directory has __init__.py
- [ ] Benchmark runner supports --strategy flag
- [ ] Test suite README is complete and accurate

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "No documentation" | Multiple docs/ directories exist in engine, extensions, and Charts |
| "Watchdog not implemented" | watchdog.py exists, needs async callback fix |
| "Reliability not implemented" | reliability.py exists, needs critical type verification |
