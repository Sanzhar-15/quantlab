# Phase 8: Testing & CI (14 fixes)

**Quality gates** -- Test suite, benchmarks, CI pipelines, and security scanning.

## Phase Overview

This phase builds out the test infrastructure: live trading test suite, golden test verification, mock broker enhancements, chaos tests, benchmark wiring, and CI/CD workflows.

## Prerequisites

- Phase 0 (IPC Integration) -- IPC tests need working protocol
- Phase 3 (Engine Correctness) -- engine must be correct before golden tests are meaningful
- Can start in parallel with Phases 4-6

---

## Fix List (Execution Order)

### FIX-TEST-001 [P1] Implement live trading test suite (L001-L070)

**Problem**: Live trading test suite is specified (70 tests) but needs implementation against mock broker.

**Files to create**:
- `engine/tests/live/test_session_lifecycle.py`
- `engine/tests/live/test_order_flow.py`
- `engine/tests/live/test_risk_controls.py`
- `engine/tests/live/test_reconciliation.py`
- `engine/tests/live/conftest.py`

**Implementation**:

```python
# engine/tests/live/conftest.py

import pytest
import asyncio
from quantlab.daemon.main import LiveTradingDaemon, SessionConfig
from quantlab.daemon.ipc import IPCServer, IPCClient

@pytest.fixture
def session_config():
    return SessionConfig(
        session_id="test-session-001",
        strategy_path="tests/fixtures/strategies/simple_momentum.py",
        broker="mock",
        symbols=["AAPL", "MSFT"],
        risk_limits={
            "max_exposure": 100000,
            "daily_loss_limit": 0.02,
            "consecutive_loss_limit": 3,
        },
    )

@pytest.fixture
async def daemon(session_config):
    """Create and start a test daemon."""
    d = LiveTradingDaemon(session_config)
    await d.start()
    yield d
    await d.stop()

@pytest.fixture
async def ipc_client(daemon, session_config):
    """Create connected IPC client."""
    client = IPCClient(session_config.session_id)
    await client.connect()
    yield client
    await client.disconnect()
```

```python
# engine/tests/live/test_session_lifecycle.py

import pytest

# L001-L010: Session lifecycle tests
class TestSessionLifecycle:
    @pytest.mark.asyncio
    async def test_L001_session_starts(self, daemon):
        """L001: Daemon starts and enters ACTIVE state."""
        assert daemon.state == "active"

    @pytest.mark.asyncio
    async def test_L002_session_pause_resume(self, daemon, ipc_client):
        """L002: Session can be paused and resumed."""
        result = await ipc_client.call("session.pause")
        assert result["success"]
        assert daemon.state == "paused"

        result = await ipc_client.call("session.resume")
        assert result["success"]
        assert daemon.state == "active"

    @pytest.mark.asyncio
    async def test_L003_session_stop(self, daemon, ipc_client):
        """L003: Session stops gracefully."""
        result = await ipc_client.call("session.stop", {"timeout": 5.0})
        assert result["success"]
        assert daemon.state == "stopped"

    @pytest.mark.asyncio
    async def test_L004_health_check(self, ipc_client):
        """L004: Health check returns ok."""
        result = await ipc_client.call("health")
        assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_L005_status_check(self, ipc_client):
        """L005: Status returns session info."""
        result = await ipc_client.call("status")
        assert "session_id" in result
        assert "state" in result
```

```python
# engine/tests/live/test_order_flow.py

import pytest

# L011-L030: Order flow tests
class TestOrderFlow:
    @pytest.mark.asyncio
    async def test_L011_submit_market_order(self, ipc_client):
        """L011: Submit market order via IPC."""
        result = await ipc_client.call("order.submit", {
            "symbol": "AAPL",
            "side": "buy",
            "quantity": 10,
            "order_type": "market",
        })
        assert result["success"]
        assert "order_id" in result

    @pytest.mark.asyncio
    async def test_L012_submit_limit_order(self, ipc_client):
        """L012: Submit limit order via IPC."""
        result = await ipc_client.call("order.submit", {
            "symbol": "AAPL",
            "side": "buy",
            "quantity": 10,
            "order_type": "limit",
            "limit_price": 150.00,
        })
        assert result["success"]

    @pytest.mark.asyncio
    async def test_L013_cancel_order(self, ipc_client):
        """L013: Cancel an open order."""
        # Submit then cancel
        submit_result = await ipc_client.call("order.submit", {
            "symbol": "AAPL", "side": "buy", "quantity": 10,
            "order_type": "limit", "limit_price": 100.00,
        })
        cancel_result = await ipc_client.call("order.cancel", {
            "order_id": submit_result["order_id"],
        })
        assert cancel_result["success"]

    @pytest.mark.asyncio
    async def test_L014_get_positions(self, ipc_client):
        """L014: Get positions returns list."""
        result = await ipc_client.call("positions.get")
        assert "positions" in result
        assert isinstance(result["positions"], list)

    @pytest.mark.asyncio
    async def test_L015_get_orders(self, ipc_client):
        """L015: Get orders returns list."""
        result = await ipc_client.call("orders.get")
        assert "orders" in result

    @pytest.mark.asyncio
    async def test_L016_get_fills(self, ipc_client):
        """L016: Get fills returns list."""
        result = await ipc_client.call("fills.get")
        assert "fills" in result
```

```python
# engine/tests/live/test_risk_controls.py

import pytest

# L031-L050: Risk control tests
class TestRiskControls:
    @pytest.mark.asyncio
    async def test_L031_exposure_limit_enforced(self, ipc_client):
        """L031: Order exceeding exposure limit is rejected."""
        result = await ipc_client.call("order.submit", {
            "symbol": "AAPL",
            "side": "buy",
            "quantity": 10000,  # Exceeds max exposure
            "order_type": "market",
        })
        assert not result["success"]
        assert "exposure" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_L032_circuit_breaker_blocks_orders(self, daemon, ipc_client):
        """L032: After circuit breaker trip, orders are blocked."""
        # Trigger circuit breaker
        await daemon._handle_circuit_breaker_trip({"reason": "test"})

        result = await ipc_client.call("order.submit", {
            "symbol": "AAPL", "side": "buy", "quantity": 10,
            "order_type": "market",
        })
        assert not result["success"]
        assert "circuit breaker" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_L033_flatten_all(self, ipc_client):
        """L033: Flatten all positions."""
        result = await ipc_client.call("flatten.all")
        assert result["success"]

    @pytest.mark.asyncio
    async def test_L034_risk_status(self, ipc_client):
        """L034: Risk status returns exposure info."""
        result = await ipc_client.call("risk.status")
        assert "exposure" in result
```

**Verification**:
1. `pytest engine/tests/live/ -v` -- all tests pass against mock broker
2. Tests cover: session lifecycle, order flow, risk controls, reconciliation
3. No external broker connections required

**Dependencies**: Phase 0, Phase 2

---

### FIX-TEST-002 [P1] Verify golden test pass/fail status

**Problem**: Golden tests (G001-G105) exist but may not all pass after engine fixes.

**Files to modify**:
- `engine/tests/golden/` -- verify and fix failing tests

**Implementation**:

```python
# Run all golden tests and categorize:
# pytest engine/tests/golden/ -v --tb=short 2>&1 | tee golden_results.txt

# For each failing test, determine if:
# 1. Test expectation is wrong (update expected values)
# 2. Engine bug (already fixed in Phase 3)
# 3. Missing feature (deferred)

# Update golden test expectations where engine behavior has correctly changed:
# Example: stop order gap-through now fills at open price (NEW-ENG-001)
# Update expected fill price in affected golden tests
```

**Verification**:
1. `pytest engine/tests/golden/ -v` -- all G001-G105 pass
2. Any updated expectations documented with rationale

**Dependencies**: Phase 3 (engine fixes)

---

### FIX-TEST-003 [P1] Enhance mock broker fixture

**Problem**: Mock broker needs to simulate more realistic scenarios (partial fills, delays, errors).

**Files to modify**:
- `engine/tests/fixtures/`

**Implementation**:

```python
# engine/tests/fixtures/mock_broker.py

import asyncio
from typing import Optional
from dataclasses import dataclass, field

@dataclass
class MockBrokerConfig:
    fill_delay_ms: float = 0  # Simulated network delay
    partial_fill_rate: float = 0  # 0-1, probability of partial fill
    reject_rate: float = 0  # 0-1, probability of rejection
    slippage_bps: float = 0  # Slippage in basis points

class MockBroker:
    """Enhanced mock broker for testing.

    FIX-TEST-003: Supports partial fills, delays, errors.
    """

    def __init__(self, config: MockBrokerConfig = None):
        self._config = config or MockBrokerConfig()
        self._positions: dict[str, int] = {}
        self._orders: dict[str, dict] = {}
        self._fills: list[dict] = []
        self._prices: dict[str, float] = {"AAPL": 150.0, "MSFT": 350.0}
        self._connected = False
        self._fill_callbacks: list = []

    async def connect(self, api_key: str, api_secret: str):
        if not api_key or not api_secret:
            raise ConnectionError("Invalid credentials")
        self._connected = True

    async def disconnect(self):
        self._connected = False

    async def submit_order(self, order: dict) -> dict:
        import random

        if not self._connected:
            raise ConnectionError("Not connected")

        # Simulate delay
        if self._config.fill_delay_ms > 0:
            await asyncio.sleep(self._config.fill_delay_ms / 1000)

        # Simulate rejection
        if random.random() < self._config.reject_rate:
            return {"success": False, "error": "Order rejected by broker"}

        order_id = f"mock-{len(self._orders) + 1}"
        self._orders[order_id] = {**order, "order_id": order_id, "status": "submitted"}

        # Simulate fill
        price = self._prices.get(order["symbol"], 100.0)
        slippage = price * self._config.slippage_bps / 10000
        fill_price = price + slippage if order["side"] == "buy" else price - slippage

        quantity = order["quantity"]
        if random.random() < self._config.partial_fill_rate:
            quantity = max(1, quantity // 2)  # Partial fill

        fill = {
            "order_id": order_id,
            "symbol": order["symbol"],
            "side": order["side"],
            "quantity": quantity,
            "price": fill_price,
            "timestamp": "2024-01-15T10:30:00Z",
        }
        self._fills.append(fill)

        for callback in self._fill_callbacks:
            await callback(fill)

        return {"success": True, "order_id": order_id}

    def set_price(self, symbol: str, price: float):
        self._prices[symbol] = price

    def on_fill(self, callback):
        self._fill_callbacks.append(callback)

    async def get_positions(self) -> list[dict]:
        return [
            {"symbol": s, "quantity": q, "avg_price": self._prices.get(s, 0)}
            for s, q in self._positions.items() if q != 0
        ]

    async def reconnect(self):
        self._connected = True
```

**Verification**:
1. Mock broker with `fill_delay_ms=100` -> fills arrive after 100ms
2. Mock broker with `partial_fill_rate=0.5` -> ~50% partial fills
3. Mock broker with `reject_rate=0.1` -> ~10% rejections

**Dependencies**: None

---

### FIX-TEST-004 [P2] Implement chaos/failure tests

**Problem**: No tests for failure scenarios (network drops, crashes, resource exhaustion).

**Files to create**:
- `engine/tests/chaos/test_network_failure.py`
- `engine/tests/chaos/test_resource_exhaustion.py`

**Implementation**:

```python
# engine/tests/chaos/test_network_failure.py

import pytest
import asyncio

class TestNetworkFailure:
    @pytest.mark.asyncio
    async def test_broker_disconnect_recovery(self, daemon, mock_broker):
        """Daemon recovers from broker disconnect."""
        mock_broker.disconnect()
        await asyncio.sleep(2)
        mock_broker.connect("key", "secret")
        await asyncio.sleep(5)
        assert daemon.state == "active"

    @pytest.mark.asyncio
    async def test_ipc_client_crash(self, daemon, ipc_client):
        """Daemon handles IPC client crash gracefully."""
        # Force disconnect client
        await ipc_client._transport.close()
        # Daemon should continue running
        await asyncio.sleep(1)
        assert daemon.state == "active"

    @pytest.mark.asyncio
    async def test_rapid_reconnect(self, daemon):
        """Daemon handles rapid connect/disconnect cycles."""
        for _ in range(10):
            client = IPCClient(daemon._config.session_id)
            await client.connect()
            await client.call("health")
            await client.disconnect()
        assert daemon.state == "active"
```

**Verification**:
1. `pytest engine/tests/chaos/ -v` -- all chaos tests pass
2. Daemon survives all failure scenarios
3. No resource leaks (file handles, memory)

**Dependencies**: FIX-TEST-003

---

### FIX-TEST-005 [P2] Configure coverage reporting

**Problem**: Coverage reporting not configured for the test suite.

**Files to modify**:
- `engine/pyproject.toml`

**Implementation**:

```toml
# engine/pyproject.toml
# Add coverage configuration:

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.coverage.run]
source = ["quantlab"]
omit = [
    "tests/*",
    "benchmarks/*",
    "*/test_*.py",
]

[tool.coverage.report]
precision = 2
show_missing = true
fail_under = 70

[tool.coverage.html]
directory = "htmlcov"
```

**Verification**:
1. `pytest --cov=quantlab --cov-report=html engine/tests/` produces coverage report
2. Coverage > 70% for core modules
3. HTML report viewable at `engine/htmlcov/index.html`

**Dependencies**: None

---

### FIX-B001 [P1] Wire benchmark strategies to actual BacktestEngine

**Problem**: Benchmark runner exists but may not use the actual BacktestEngine for performance testing.

**Files to modify**:
- `engine/benchmarks/runner.py`

**Implementation**:

```python
# engine/benchmarks/runner.py

import time
import json
from pathlib import Path
from quantlab.backtest.core import BacktestEngine

class BenchmarkRunner:
    """Run performance benchmarks against BacktestEngine.

    FIX-B001: Wires benchmarks to actual engine.
    """

    def __init__(self, data_dir: str = "benchmarks/data"):
        self._data_dir = Path(data_dir)
        self._results: list[dict] = []

    def run_benchmark(self, name: str, strategy, data: dict, config: dict = None) -> dict:
        """Run a single benchmark and measure performance."""
        engine = BacktestEngine(config or {})
        engine.load_data(data)

        start_time = time.perf_counter()
        result = engine.run(strategy)
        elapsed = time.perf_counter() - start_time

        bench_result = {
            "name": name,
            "elapsed_seconds": elapsed,
            "bar_count": len(next(iter(data.values()))),
            "bars_per_second": len(next(iter(data.values()))) / elapsed,
            "total_trades": result.total_trades,
            "final_equity": result.final_equity,
        }

        self._results.append(bench_result)
        return bench_result

    def save_results(self, filepath: str = "benchmarks/results/latest.json"):
        """Save benchmark results for comparison."""
        Path(filepath).parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, "w") as f:
            json.dump(self._results, f, indent=2)

    def compare_to_baseline(self, baseline_path: str) -> list[dict]:
        """Compare current results to baseline."""
        with open(baseline_path) as f:
            baseline = json.load(f)

        comparisons = []
        baseline_by_name = {r["name"]: r for r in baseline}

        for result in self._results:
            base = baseline_by_name.get(result["name"])
            if base:
                regression = result["elapsed_seconds"] / base["elapsed_seconds"]
                comparisons.append({
                    "name": result["name"],
                    "current": result["elapsed_seconds"],
                    "baseline": base["elapsed_seconds"],
                    "ratio": regression,
                    "regressed": regression > 1.1,  # 10% threshold
                })

        return comparisons
```

**Verification**:
1. `python -m benchmarks.runner` runs all benchmarks
2. Results saved to JSON
3. Comparison to baseline detects regressions

**Dependencies**: Phase 3

---

### FIX-B002 [P1] Add benchmark data generation to CI

**Files to modify**:
- `.github/workflows/engine-benchmark.yml`

**Implementation**:

```yaml
# .github/workflows/engine-benchmark.yml
name: Engine Benchmarks

on:
  push:
    branches: [main]
    paths:
      - 'engine/**'
  pull_request:
    paths:
      - 'engine/**'

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Install dependencies
        run: |
          cd engine
          pip install -e ".[dev]"
      - name: Generate benchmark data
        run: |
          cd engine
          python benchmarks/generate_data.py
      - name: Run benchmarks
        run: |
          cd engine
          python -m benchmarks.runner --output benchmarks/results/current.json
      - name: Compare to baseline
        run: |
          cd engine
          python benchmarks/check.py --baseline benchmarks/results/baseline.json --current benchmarks/results/current.json
      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results
          path: engine/benchmarks/results/
```

**Verification**:
1. CI runs benchmarks on engine changes
2. Results uploaded as artifacts
3. Regressions flagged in PR

**Dependencies**: FIX-B001

---

### FIX-B003 [P1] Implement git-based baseline comparison

**Files to modify**:
- `engine/benchmarks/check.py`

**Implementation**:

```python
# engine/benchmarks/check.py

import json
import sys
from pathlib import Path

def check_regression(baseline_path: str, current_path: str, threshold: float = 0.1):
    """Check for performance regressions.

    FIX-B003: Git-based baseline comparison.
    """
    with open(baseline_path) as f:
        baseline = json.load(f)
    with open(current_path) as f:
        current = json.load(f)

    baseline_by_name = {r["name"]: r for r in baseline}
    regressions = []

    for result in current:
        base = baseline_by_name.get(result["name"])
        if not base:
            continue

        ratio = result["elapsed_seconds"] / base["elapsed_seconds"]
        if ratio > 1 + threshold:
            regressions.append({
                "name": result["name"],
                "baseline_ms": base["elapsed_seconds"] * 1000,
                "current_ms": result["elapsed_seconds"] * 1000,
                "regression_pct": (ratio - 1) * 100,
            })

    if regressions:
        print("PERFORMANCE REGRESSIONS DETECTED:")
        for r in regressions:
            print(f"  {r['name']}: {r['baseline_ms']:.1f}ms -> {r['current_ms']:.1f}ms "
                  f"(+{r['regression_pct']:.1f}%)")
        sys.exit(1)
    else:
        print("No regressions detected.")
        sys.exit(0)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--current", required=True)
    parser.add_argument("--threshold", type=float, default=0.1)
    args = parser.parse_args()
    check_regression(args.baseline, args.current, args.threshold)
```

**Verification**:
1. No regression -> exit 0, "No regressions detected"
2. 15% regression -> exit 1, regression details printed
3. CI fails on regression

**Dependencies**: FIX-B002

---

### FIX-B004 [P2] Fix benchmark module exports

**Files to modify**:
- `engine/benchmarks/__init__.py`

**Implementation**:

```python
# engine/benchmarks/__init__.py
from .runner import BenchmarkRunner
from .check import check_regression

__all__ = ["BenchmarkRunner", "check_regression"]
```

**Verification**: `from benchmarks import BenchmarkRunner` works.

**Dependencies**: FIX-B001

---

### FIX-CI001 [P1] Create engine PR validation workflow

**Files to create**:
- `.github/workflows/engine-pr.yml`

**Implementation**:

```yaml
# .github/workflows/engine-pr.yml
name: Engine PR Validation

on:
  pull_request:
    paths:
      - 'engine/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install ruff mypy
      - run: cd engine && ruff check quantlab/
      - run: cd engine && mypy quantlab/ --ignore-missing-imports

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: cd engine && pip install -e ".[dev]"
      - run: cd engine && pytest tests/ -v --tb=short --cov=quantlab --cov-report=xml
      - uses: codecov/codecov-action@v4
        with:
          files: engine/coverage.xml

  golden:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: cd engine && pip install -e ".[dev]"
      - run: cd engine && pytest tests/golden/ -v
```

**Verification**: PR to engine/ triggers lint + test + golden test jobs.

**Dependencies**: None

---

### FIX-CI002 [P1] Implement benchmark regression check

Already covered in FIX-B002 and FIX-B003. Verify the workflow runs correctly.

---

### FIX-CI003 [P2] Create security scanning workflow

**Files to create**:
- `.github/workflows/engine-security.yml`

**Implementation**:

```yaml
# .github/workflows/engine-security.yml
name: Engine Security Scan

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6am

jobs:
  dependency-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install safety bandit
      - name: Check dependencies for vulnerabilities
        run: cd engine && safety check
      - name: Static security analysis
        run: cd engine && bandit -r quantlab/ -f json -o security-report.json || true
      - uses: actions/upload-artifact@v4
        with:
          name: security-report
          path: engine/security-report.json

  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check for hardcoded secrets
        run: |
          # Check for common credential patterns
          ! grep -rn "api_key\s*=\s*['\"]" engine/quantlab/ --include="*.py" | grep -v "test" | grep -v "#" | grep -v "get("
          ! grep -rn "api_secret\s*=\s*['\"]" engine/quantlab/ --include="*.py" | grep -v "test" | grep -v "#" | grep -v "get("
          echo "No hardcoded secrets found"
```

**Verification**:
1. Security scan runs weekly and on push to main
2. Bandit findings reported as artifact
3. Hardcoded secret check catches credential leaks

**Dependencies**: None

---

### FIX-CI004 [P2] Implement memory profiling job

**Files to modify**:
- `.github/workflows/engine-benchmark.yml`

**Implementation**: Add memory profiling step to benchmark workflow:

```yaml
      - name: Memory profiling
        run: |
          cd engine
          pip install memory_profiler
          python -m memory_profiler benchmarks/memory_test.py
```

**Verification**: Memory usage tracked in CI, alerts on leaks.

**Dependencies**: FIX-B002

---

### FIX-CGP-017 [P2] Implement debug mmap reader for O(1) bar access

**Problem**: Time-travel debugger reads entire debug file into memory. Large backtests need O(1) random access.

**Files to create**:
- `engine/quantlab/debug/mmap_reader.py`

**Implementation**:

```python
# engine/quantlab/debug/mmap_reader.py

"""Memory-mapped debug file reader for O(1) bar access.

FIX-CGP-017: Enables time-travel debugging on large backtests
without loading the entire file into memory.
"""

import mmap
import struct
import json
from pathlib import Path
from typing import Optional

# File format:
# [4 bytes: version] [4 bytes: bar_count] [4 bytes: index_offset]
# [bar_data...] [index_table]
# Index table: [bar_count * (8 bytes offset + 4 bytes length)]

HEADER_SIZE = 12
INDEX_ENTRY_SIZE = 12  # 8 bytes offset + 4 bytes length
VERSION = 1

class MmapDebugReader:
    """O(1) random access to debug file bars via mmap."""

    def __init__(self, filepath: str | Path):
        self._filepath = Path(filepath)
        self._file = None
        self._mmap = None
        self._bar_count = 0
        self._index_offset = 0

    def open(self):
        """Open and memory-map the debug file."""
        self._file = open(self._filepath, "rb")
        self._mmap = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)

        # Read header
        version, self._bar_count, self._index_offset = struct.unpack(
            "<III", self._mmap[:HEADER_SIZE]
        )
        if version != VERSION:
            raise ValueError(f"Unsupported debug file version: {version}")

    def close(self):
        """Close the memory-mapped file."""
        if self._mmap:
            self._mmap.close()
        if self._file:
            self._file.close()

    @property
    def bar_count(self) -> int:
        return self._bar_count

    def read_bar(self, bar_index: int) -> Optional[dict]:
        """Read a single bar's debug data in O(1) time."""
        if bar_index < 0 or bar_index >= self._bar_count:
            return None

        # Read index entry
        idx_pos = self._index_offset + (bar_index * INDEX_ENTRY_SIZE)
        offset, length = struct.unpack(
            "<QL", self._mmap[idx_pos:idx_pos + INDEX_ENTRY_SIZE]
        )

        # Read bar data
        data = self._mmap[offset:offset + length]
        return json.loads(data)

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *args):
        self.close()

    def __len__(self):
        return self._bar_count


class MmapDebugWriter:
    """Write debug data in mmap-compatible format."""

    def __init__(self, filepath: str | Path):
        self._filepath = Path(filepath)
        self._bars: list[bytes] = []

    def add_bar(self, bar_data: dict):
        """Add a bar's debug data."""
        self._bars.append(json.dumps(bar_data).encode("utf-8"))

    def save(self):
        """Write the complete debug file with index."""
        with open(self._filepath, "wb") as f:
            bar_count = len(self._bars)

            # Reserve header space
            f.write(struct.pack("<III", VERSION, bar_count, 0))

            # Write bar data, track offsets
            offsets = []
            for bar_data in self._bars:
                offset = f.tell()
                f.write(bar_data)
                offsets.append((offset, len(bar_data)))

            # Write index table
            index_offset = f.tell()
            for offset, length in offsets:
                f.write(struct.pack("<QL", offset, length))

            # Update header with index offset
            f.seek(8)
            f.write(struct.pack("<I", index_offset))
```

**Verification**:
1. Write 1M bars, read bar 500,000 -> O(1) access (< 1ms)
2. Memory usage stays constant regardless of file size
3. File format round-trips correctly (write then read)

**Dependencies**: None

---

## Phase Verification Checklist

- [ ] `pytest engine/tests/live/ -v` -- all L001-L070 pass
- [ ] `pytest engine/tests/golden/ -v` -- all G001-G105 pass
- [ ] Mock broker supports partial fills, delays, errors
- [ ] Chaos tests pass (network failure, client crash)
- [ ] Coverage reporting configured and > 70%
- [ ] Benchmarks wired to actual BacktestEngine
- [ ] CI runs benchmarks with regression detection
- [ ] PR validation workflow runs lint + test + golden
- [ ] Security scanning runs weekly
- [ ] Debug mmap reader provides O(1) bar access

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "No tests" | tests/ directory has 25+ subdirectories with test files |
| "No CI" | .github/workflows/ has engine-ci.yml, engine-pr.yml already |
| "No benchmarks" | benchmarks/ directory exists, needs wiring to BacktestEngine |
