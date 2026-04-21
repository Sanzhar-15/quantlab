# Quantlab V10 Integration Checklist

## Overview

This checklist tracks remaining integration work between the Python engine and TypeScript VS Code extension.

**Status Legend:**
- [x] Complete
- [ ] Pending
- [~] Partial (needs work)

---

## 1. Python Engine Components

### 1.1 Core Modules (IMPLEMENTED)

| Module | Status | Files | Notes |
|--------|--------|-------|-------|
| API Layer | [x] | `api/params.py`, `api/complexity.py`, `api/vectorized.py` | Parameter extraction, complexity analysis |
| Backtest Engine | [x] | `backtest/core.py`, `backtest/config.py`, `backtest/fills.py` | Core backtesting logic |
| Job Execution | [x] | `jobs/base.py`, `jobs/protocol.py`, `jobs/backtest.py` | NDJSON job protocol |
| Optimize Runner | [x] | `jobs/optimize.py` | Grid search optimization |
| Monte Carlo | [x] | `jobs/montecarlo.py` | Trade shuffling simulations |
| Walk-Forward | [x] | `jobs/wfa.py` | Walk-forward analysis |
| Trading Session | [x] | `trading/session.py` | Session lifecycle |
| Order Management | [x] | `trading/orders.py` | Order CRUD operations |
| Position Tracking | [x] | `trading/positions.py` | P&L calculation |
| Risk Monitoring | [x] | `trading/risk.py` | Limit enforcement |
| Broker Adapter | [x] | `trading/broker.py` | Paper broker, adapter interface |
| CodeMod Engine | [x] | `codemod/engine.py`, `codemod/protocol.py` | LibCST-based transformations |
| Visualization | [x] | `protocol/visualization.py`, `runtime/visualization.py` | Chart data protocol |
| Data Service | [x] | `data/service.py` | Data revision tracking |
| Daemon Core | [x] | `daemon/main.py`, `daemon/ipc.py`, `daemon/lifecycle.py` | IPC and process management |

### 1.2 Missing/Incomplete Python Components

| Component | Status | Required For | Priority |
|-----------|--------|--------------|----------|
| Alpaca Live Adapter | [ ] | Live trading | HIGH |
| Real-time Quote Fetching | [ ] | Live trading | HIGH |
| Position Reconciliation | [ ] | Live trading safety | HIGH |
| Audit Log (hash-chain) | [~] | Compliance | MEDIUM |
| Debug State Capture | [ ] | Time-travel debugger | MEDIUM |
| Corporate Actions | [ ] | V1.1 deferred | LOW |

---

## 2. TypeScript Extension Components (NOT YET STARTED)

### 2.1 IPC Layer

| Component | Status | File Location | Description |
|-----------|--------|---------------|-------------|
| JSON-RPC Parser | [ ] | `src/core/ipc/JsonRpcParser.ts` | Parse/serialize JSON-RPC 2.0 |
| Socket Transport | [ ] | `src/core/ipc/SocketTransport.ts` | Unix sockets / Named pipes |
| Token Auth | [ ] | `src/core/ipc/TokenAuth.ts` | Per-request authentication |
| Retry Logic | [ ] | `src/core/ipc/RetryHandler.ts` | Exponential backoff |
| Message Buffering | [ ] | `src/core/ipc/MessageBuffer.ts` | 1000 Important, 100 Telemetry |

### 2.2 Session Management

| Component | Status | File Location | Description |
|-----------|--------|---------------|-------------|
| DaemonClient | [ ] | `src/core/trading/DaemonClient.ts` | Socket connection management |
| LiveDaemonManager | [ ] | `src/core/trading/LiveDaemonManager.ts` | Daemon lifecycle |
| SessionManager | [ ] | `src/core/trading/SessionManager.ts` | Session CRUD |
| ExposureManager | [ ] | `src/core/risk/ExposureManager.ts` | Reservation tracking |

### 2.3 UI Components

| Component | Status | File Location | Description |
|-----------|--------|---------------|-------------|
| Trade View | [ ] | `src/views/trade/TradeViewProvider.ts` | Real-time trading UI |
| Chart View | [ ] | `src/views/chart/ChartViewProvider.ts` | Candlesticks, indicators |
| History Panel | [ ] | `src/views/history/HistoryPanel.ts` | Backtest history |
| Pre-Trade Checklist | [ ] | `src/ui/dialogs/PreTradeChecklist.ts` | Validation modal |
| Trust Dialog | [ ] | `src/ui/dialogs/TrustDialog.ts` | Extension/strategy trust |
| Kill Switch Menu | [ ] | `src/ui/menus/KillSwitchMenu.ts` | Emergency controls |
| System Tray | [ ] | `src/ui/tray/SystemTray.ts` | Background notifications |

### 2.4 State Synchronization

| Stream | Status | Messages | Buffer Size |
|--------|--------|----------|-------------|
| Control | [ ] | `session.*`, `order.*`, `flatten.*` | ACK required |
| State | [ ] | `positions.update`, `orders.update`, `fills.update` | 1000 |
| Status | [ ] | `heartbeat`, `connection.status`, `risk.alert` | 100 |
| Logs | [ ] | `log.entry` | 100 |

---

## 3. IPC Message Implementation

### 3.1 Control Messages (Critical - ACK Required)

| Message | Python | TypeScript | Direction |
|---------|--------|------------|-----------|
| `session.start` | [x] | [ ] | UI→Daemon |
| `session.stop` | [x] | [ ] | UI→Daemon |
| `session.pause` | [x] | [ ] | UI→Daemon |
| `session.resume` | [x] | [ ] | UI→Daemon |
| `order.submit` | [x] | [ ] | UI→Daemon |
| `order.cancel` | [x] | [ ] | UI→Daemon |
| `order.modify` | [ ] | [ ] | UI→Daemon |
| `flatten.request` | [ ] | [ ] | UI→Daemon |
| `risk.action` | [ ] | [ ] | UI→Daemon |

### 3.2 State Messages (Important - Best Effort)

| Message | Python | TypeScript | Direction |
|---------|--------|------------|-----------|
| `positions.update` | [x] | [ ] | Daemon→UI |
| `orders.update` | [x] | [ ] | Daemon→UI |
| `fills.update` | [x] | [ ] | Daemon→UI |
| `performance.update` | [ ] | [ ] | Daemon→UI |
| `activity.update` | [ ] | [ ] | Daemon→UI |

### 3.3 Status Messages (Telemetry)

| Message | Python | TypeScript | Direction |
|---------|--------|------------|-----------|
| `heartbeat` | [x] | [ ] | Daemon→UI |
| `connection.status` | [ ] | [ ] | Daemon→UI |
| `risk.alert` | [x] | [ ] | Daemon→UI |
| `error.state` | [ ] | [ ] | Daemon→UI |

---

## 4. Artifact Integration

### 4.1 Backtest Artifacts

| Artifact | Python Writer | TypeScript Reader | Format |
|----------|---------------|-------------------|--------|
| `results.json` | [x] | [ ] | JSON metrics |
| `trades.csv` | [x] | [ ] | CSV trade log |
| `equity.csv` | [x] | [ ] | CSV equity curve |
| `signals.json` | [x] | [ ] | JSON entry/exit signals |
| `debug.parquet` | [ ] | [ ] | Arrow debug state |

### 4.2 Live Session Artifacts

| Artifact | Python Writer | TypeScript Reader | Format |
|----------|---------------|-------------------|--------|
| `session.token` | [x] | [ ] | Auth token |
| `session.checkpoint` | [x] | [ ] | Binary state |
| `audit.log` | [~] | [ ] | Append-only log |

---

## 5. Testing Requirements

### 5.1 Unit Tests

| Module | Tests Exist | Coverage Target | Actual |
|--------|-------------|-----------------|--------|
| `quantlab.jobs` | [x] | 80% | TBD |
| `quantlab.trading` | [x] | 80% | TBD |
| `quantlab.codemod` | [x] | 80% | TBD |
| `quantlab.protocol` | [x] | 80% | TBD |
| `quantlab.api` | [x] | 80% | TBD |
| `quantlab.data` | [x] | 80% | TBD |
| `quantlab.backtest` | [x] | 80% | TBD |
| `quantlab.daemon` | [x] | 80% | TBD |

### 5.2 Golden Test Vectors

| Vector Range | Description | Status |
|--------------|-------------|--------|
| G001-G049 | Backtest engine | [ ] Need to run |
| G050-G079 | Order types | [ ] Need to run |
| G080-G105 | Edge cases | [ ] Need to run |

### 5.3 Live Trading Test Vectors

| Vector Range | Description | Status |
|--------------|-------------|--------|
| L001-L030 | Session lifecycle | [ ] Need paper trading |
| L031-L050 | Order execution | [ ] Need paper trading |
| L051-L070 | Risk limits | [ ] Need paper trading |

---

## 6. Phase Gate Requirements

### Phase 1 → 2
- [ ] Engine unit tests ≥80% coverage
- [ ] IPC protocol implemented
- [ ] Daemon can start/stop

### Phase 2 → 3
- [ ] Golden vectors G001-G049 pass 100%
- [ ] Backtest produces correct artifacts

### Phase 3 → 4
- [ ] Integration tests ≥70% UI coverage
- [ ] Chart view renders correctly
- [ ] History panel shows runs

### Phase 4 → 5
- [ ] All L001-L070 vectors pass
- [ ] Paper trading works end-to-end
- [ ] Risk limits enforced

### Phase 5 → Release
- [ ] Security audit passed
- [ ] Documentation complete
- [ ] Performance benchmarks met

---

## 7. Dependencies to Install

```bash
# Python Engine
pip install -e ".[dev]"

# Key packages:
# - libcst>=1.1.0 (code modification)
# - argon2-cffi>=23.1.0 (secrets)
# - alpaca-py>=0.20.0 (broker)
# - pytest>=7.4.0 (testing)
```

---

## 8. Quick Start Commands

```bash
# Run all tests
pytest tests/ -v

# Run with coverage
pytest tests/ --cov=quantlab --cov-report=html

# Run specific module tests
pytest tests/trading/ -v
pytest tests/jobs/ -v
pytest tests/codemod/ -v

# Run codemod subprocess
python -m quantlab.codemod

# Start daemon (when implemented)
python -m quantlab.daemon start --config session.json
```

---

## Summary

**Python Engine:** ~85% complete (core trading/backtest done, live adapters needed)

**TypeScript Extension:** ~0% complete (all UI/IPC work pending)

**Integration:** Requires TypeScript implementation to test end-to-end

**Priority Actions:**
1. Install dependencies and run test suite
2. Implement Alpaca live adapter
3. Start TypeScript IPC layer
4. Create integration test harness
