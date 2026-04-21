# Testing Infrastructure Fixes

---

## FIX-T001: Live Trading Tests Not Implemented (P1 - High)

**Directory**: `engine/tests/live/` (MISSING)
**Issue**: The plan specifies 43 live trading tests (L001-L070). None exist.

**Fix**: Create live trading test infrastructure:

```python
# tests/live/__init__.py
"""Live trading tests using mock broker and daemon."""

# tests/live/conftest.py
"""Fixtures for live trading tests."""

import asyncio
import pytest
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

from quantlab.daemon.main import LiveTradingDaemon
from quantlab.daemon.ipc import IPCClient, TokenManager
from quantlab.providers.mock import MockBroker


@pytest.fixture
def mock_broker():
    """Create a mock broker for testing."""
    broker = MockBroker()
    broker.account_equity = Decimal("100000")
    broker.positions = {}
    return broker


@pytest.fixture
async def daemon(mock_broker, tmp_path):
    """Start a daemon with mock broker for testing."""
    from quantlab.daemon.checkpoint import SessionCheckpoint, CheckpointManager

    config = SessionConfig(
        session_id="test-session",
        strategy_path="/dev/null",
        broker_config={"type": "mock"},
        risk_limits={"max_exposure": Decimal("50000")},
    )

    daemon = LiveTradingDaemon(config)
    daemon._broker = mock_broker

    await daemon.start()
    yield daemon
    await daemon.stop()


@pytest.fixture
async def ipc_client(daemon):
    """Create IPC client connected to daemon."""
    token = daemon._token_manager.generate()
    client = IPCClient(daemon.session_id, token)
    await client.connect()
    yield client
    await client.disconnect()


# tests/live/test_session_lifecycle.py
"""Session lifecycle tests (L001-L010)."""

import pytest
from decimal import Decimal


@pytest.mark.live
class TestSessionLifecycle:
    """Test session start, stop, pause, resume."""

    async def test_L001_session_start(self, daemon, ipc_client):
        """L001: Session starts successfully."""
        result = await ipc_client.call("session.status")
        assert result["state"] == "active"

    async def test_L002_session_pause(self, daemon, ipc_client):
        """L002: Session can be paused."""
        result = await ipc_client.call("session.pause")
        assert result["status"] == "paused"

        status = await ipc_client.call("session.status")
        assert status["state"] == "paused"

    async def test_L003_session_resume(self, daemon, ipc_client):
        """L003: Paused session can be resumed."""
        await ipc_client.call("session.pause")
        result = await ipc_client.call("session.resume")
        assert result["status"] == "resumed"

        status = await ipc_client.call("session.status")
        assert status["state"] == "active"

    async def test_L004_session_stop(self, daemon, ipc_client):
        """L004: Session stops gracefully."""
        result = await ipc_client.call("session.stop")
        assert result["status"] == "stopped"

    async def test_L005_session_stop_flattens_positions(self, daemon, ipc_client, mock_broker):
        """L005: Stopping session flattens positions if configured."""
        # Set up position
        mock_broker.positions = {"AAPL": Decimal("100")}

        result = await ipc_client.call("session.stop", {"flatten": True})
        assert result["status"] == "stopped"
        assert result["positions_flattened"] == True


# tests/live/test_order_flow.py
"""Order flow tests (L011-L020)."""

@pytest.mark.live
class TestOrderFlow:
    """Test order submission, cancellation, modification."""

    async def test_L011_order_submit(self, daemon, ipc_client):
        """L011: Order can be submitted."""
        result = await ipc_client.call("order.submit", {
            "symbol": "AAPL",
            "quantity": 100,
            "side": "buy",
            "order_type": "market",
        })
        assert result["status"] == "submitted"
        assert "order_id" in result

    async def test_L012_order_cancel(self, daemon, ipc_client):
        """L012: Pending order can be cancelled."""
        # Submit limit order that won't fill
        submit_result = await ipc_client.call("order.submit", {
            "symbol": "AAPL",
            "quantity": 100,
            "side": "buy",
            "order_type": "limit",
            "limit_price": "1.00",  # Very low, won't fill
        })

        cancel_result = await ipc_client.call("order.cancel", {
            "order_id": submit_result["order_id"],
        })
        assert cancel_result["status"] == "cancelled"


# tests/live/test_emergency_flatten.py
"""Emergency flatten tests (L030-L035)."""

@pytest.mark.live
class TestEmergencyFlatten:
    """Test emergency flatten functionality."""

    async def test_L030_emergency_flatten(self, daemon, ipc_client, mock_broker):
        """L030: Emergency flatten closes all positions."""
        mock_broker.positions = {
            "AAPL": Decimal("100"),
            "GOOG": Decimal("50"),
        }

        result = await ipc_client.call("flatten.request", {
            "reason": "test",
        })

        assert result["status"] == "flattened"
        assert result["positions_closed"] == 2

    async def test_L031_flatten_cancels_orders(self, daemon, ipc_client):
        """L031: Emergency flatten cancels all pending orders."""
        # Submit some orders
        await ipc_client.call("order.submit", {
            "symbol": "AAPL",
            "quantity": 100,
            "side": "buy",
            "order_type": "limit",
            "limit_price": "1.00",
        })

        result = await ipc_client.call("flatten.request", {"reason": "test"})
        assert result["orders_cancelled"] >= 1
```

---

## FIX-T002: Golden Test Pass/Fail Status Unknown (P1 - High)

**Issue**: 105 golden test vectors exist but their pass/fail status is not documented.

**Fix**: Create test execution report:
```bash
# Run this to get current status
cd engine
pytest -v -m golden tests/golden/ --tb=short > golden_test_report.txt 2>&1

# Add to CI as a required check
```

---

## FIX-T003: Mock Broker Fixture Incomplete (P1 - High)

**File**: `engine/tests/fixtures/` or `engine/quantlab/providers/mock.py`
**Issue**: While `MockBroker` exists in `providers/mock.py`, it needs additional methods for live trading tests.

**Fix**: Enhance MockBroker:
```python
class MockBroker:
    """Enhanced mock broker for testing."""

    def __init__(self):
        self.positions: dict[str, Decimal] = {}
        self.orders: dict[str, dict] = {}
        self.fills: list[dict] = []
        self.account_equity = Decimal("100000")
        self.connected = True

        # Configurable behaviors
        self.order_delay_ms = 0
        self.fill_probability = 1.0
        self.reject_orders = False
        self.reject_reason = ""

    async def submit_order(self, order: dict) -> dict:
        """Submit order to mock broker."""
        if not self.connected:
            raise ConnectionError("Broker not connected")

        if self.reject_orders:
            return {"status": "rejected", "reason": self.reject_reason}

        if self.order_delay_ms > 0:
            await asyncio.sleep(self.order_delay_ms / 1000)

        order_id = f"mock-{len(self.orders):06d}"
        self.orders[order_id] = {
            **order,
            "order_id": order_id,
            "status": "submitted",
            "submitted_at": datetime.now(),
        }

        # Simulate immediate fill for market orders
        if order["order_type"] == "market":
            if random.random() <= self.fill_probability:
                await self._fill_order(order_id, order)

        return {"status": "submitted", "order_id": order_id}

    async def cancel_order(self, order_id: str) -> dict:
        """Cancel a pending order."""
        if order_id not in self.orders:
            return {"status": "error", "message": "Order not found"}

        order = self.orders[order_id]
        if order["status"] != "submitted":
            return {"status": "error", "message": f"Cannot cancel order in {order['status']} state"}

        order["status"] = "cancelled"
        return {"status": "cancelled", "order_id": order_id}

    async def get_positions(self) -> dict[str, Decimal]:
        """Get current positions."""
        return self.positions.copy()

    async def get_account(self) -> dict:
        """Get account info."""
        return {
            "equity": self.account_equity,
            "buying_power": self.account_equity * 2,
            "cash": self.account_equity - sum(self.positions.values()),
        }

    def disconnect(self) -> None:
        """Simulate broker disconnection."""
        self.connected = False

    def reconnect(self) -> None:
        """Simulate broker reconnection."""
        self.connected = True

    async def _fill_order(self, order_id: str, order: dict) -> None:
        """Simulate order fill."""
        fill = {
            "order_id": order_id,
            "symbol": order["symbol"],
            "quantity": order["quantity"],
            "side": order["side"],
            "price": Decimal("100.00"),  # Mock price
            "filled_at": datetime.now(),
        }
        self.fills.append(fill)
        self.orders[order_id]["status"] = "filled"

        # Update positions
        symbol = order["symbol"]
        qty = Decimal(str(order["quantity"]))
        if order["side"] == "sell":
            qty = -qty

        self.positions[symbol] = self.positions.get(symbol, Decimal("0")) + qty
        if self.positions[symbol] == Decimal("0"):
            del self.positions[symbol]
```

---

## FIX-T004: Chaos Tests Missing (P2 - Medium)

**Directory**: `engine/tests/chaos/` (MISSING)
**Issue**: The plan mentions chaos tests for failure scenarios (network failures, broker disconnects, etc.).

**Fix**: Create chaos test suite:
```python
# tests/chaos/test_network_failures.py
"""Chaos tests for network failure scenarios."""

import pytest
import asyncio


@pytest.mark.chaos
class TestNetworkFailures:
    """Test behavior under network failure conditions."""

    async def test_broker_disconnect_during_order(self, daemon, ipc_client, mock_broker):
        """Order submission handles broker disconnect."""
        # Start submitting order
        submit_task = asyncio.create_task(
            ipc_client.call("order.submit", {"symbol": "AAPL", "quantity": 100, ...})
        )

        # Disconnect broker mid-request
        await asyncio.sleep(0.01)
        mock_broker.disconnect()

        # Verify error handling
        result = await submit_task
        assert result["status"] in ("error", "timeout")

    async def test_ipc_disconnect_preserves_positions(self, daemon, ipc_client, mock_broker):
        """UI disconnect doesn't affect daemon positions."""
        mock_broker.positions = {"AAPL": Decimal("100")}

        # Disconnect IPC client
        await ipc_client.disconnect()

        # Verify daemon still has positions
        assert daemon._broker.positions == {"AAPL": Decimal("100")}

    async def test_daemon_survives_ui_crash(self, daemon):
        """Daemon continues after UI process dies."""
        # Simulate UI crash by not cleanly disconnecting
        # Daemon should continue running

        await asyncio.sleep(0.5)
        assert daemon._running == True
```

---

## FIX-T005: Test Coverage Report Not Generated (P2 - Medium)

**File**: `engine/pyproject.toml` or `engine/pytest.ini`
**Issue**: No coverage configuration for generating test coverage reports.

**Fix**: Add coverage configuration to `pyproject.toml`:
```toml
[tool.coverage.run]
source = ["quantlab"]
branch = true
omit = [
    "quantlab/__main__.py",
    "**/tests/**",
]

[tool.coverage.report]
exclude_lines = [
    "pragma: no cover",
    "def __repr__",
    "raise NotImplementedError",
    "if TYPE_CHECKING:",
    "if __name__ == .__main__.:",
]
fail_under = 80
show_missing = true

[tool.coverage.html]
directory = "htmlcov"
```

---

## FIX-T006: Test Documentation Not Written (P3 - Low)

**File**: `engine/tests/README.md` (MISSING)
**Issue**: No documentation for running tests, test categories, or test conventions.

**Fix**: Create test documentation:
```markdown
# Quantlab Engine Tests

## Test Categories

| Marker | Description | Command |
|--------|-------------|---------|
| `golden` | Golden test vectors (backtest correctness) | `pytest -m golden` |
| `live` | Live trading tests (daemon/IPC) | `pytest -m live` |
| `benchmark` | Performance benchmarks | `pytest -m benchmark` |
| `chaos` | Failure/chaos scenarios | `pytest -m chaos` |
| `slow` | Tests >1 second | `pytest -m slow` |
| `integration` | Integration tests | `pytest -m integration` |

## Running Tests

```bash
# All tests
pytest

# With coverage
pytest --cov=quantlab --cov-report=html

# Specific category
pytest -m golden

# Parallel execution
pytest -n auto
```

## Writing Tests

- Place unit tests in `tests/{module}/test_{file}.py`
- Place golden vectors in `tests/golden/vectors/`
- Use appropriate markers for test categorization
- Follow existing test patterns for consistency
```
