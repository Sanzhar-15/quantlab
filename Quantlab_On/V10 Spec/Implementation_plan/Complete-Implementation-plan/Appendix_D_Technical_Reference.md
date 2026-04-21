# Appendix: Technical Details

**Last Updated**: 2026-01-26
**Decisions Reference**: `Answers_to_Questions_and_more/Quantlab_Implementation_Decisions.md`

---

## A. Current Codebase Architecture

### A.1 Directory Structure

```
/home/steppen0mad/Desktop/quantlab/quantlab/
├── src/                           # VS Code core source (TypeScript)
│   └── vs/                        # VS Code base
├── extensions/
│   └── quantlab/                  # Main Quantlab extension
│       ├── src/
│       │   ├── commands/          # VS Code commands
│       │   ├── core/
│       │   │   ├── broker/        # Broker adapters
│       │   │   ├── engine/        # Job execution
│       │   │   ├── state/         # State management
│       │   │   ├── strategy/      # Strategy validation
│       │   │   └── trading/       # Session management
│       │   ├── panels/            # Activity bar panels
│       │   ├── types/             # TypeScript types
│       │   ├── ui/                # UI components
│       │   ├── utils/             # Utilities
│       │   └── views/             # Custom editors
│       ├── webview/               # Webview UI
│       │   ├── chart/
│       │   ├── action/
│       │   ├── trade/
│       │   └── shared/
│       └── media/                 # Icons, assets
├── Charts/                        # Charting library
│   └── packages/
│       ├── chart/                 # Main package
│       ├── chart-core/            # Core utilities
│       ├── chart-render-canvas2d/ # Canvas rendering
│       ├── chart-render-webgpu/   # WebGPU rendering
│       ├── chart-indicators/      # Technical indicators
│       └── chart-trading/         # Trading visualizations
├── cli/                           # Rust CLI
├── product.json                   # Product configuration
└── package.json                   # Workspace dependencies
```

### A.2 Existing Components

| Component | Location | Status |
|-----------|----------|--------|
| Extension framework | `extensions/quantlab/` | ✅ Complete |
| Activity bar panels | `src/panels/` | ✅ Complete (5 panels) |
| Custom editors | `src/views/` | ✅ Basic (3 editors) |
| Session management | `src/core/trading/SessionManager.ts` | ✅ Working |
| Broker adapters | `src/core/broker/` | ✅ Alpaca + Mock |
| Data service | `src/core/engine/DataService.ts` | ✅ Basic caching |
| Chart library | `/Charts/packages/` | ✅ Advanced |
| State management | `src/core/state/` | ✅ Basic |

### A.3 Key Files to Modify

| File | Size | Purpose | Phase |
|------|------|---------|-------|
| `SessionManager.ts` | 28KB | Session lifecycle | 1, 4 |
| `ChartViewProvider.ts` | — | Chart webview | 3 |
| `TradeViewProvider.ts` | — | Trade webview | 3, 4 |
| `BrokerAdapter.ts` | — | Broker interface | 4 |
| `AlpacaAdapter.ts` | 8KB | Alpaca implementation | 4 |

---

## B. New File Locations

### B.1 Phase 1 - Critical Infrastructure

```
NEW FILES:
├── engine/                        # Python engine (NEW directory)
│   └── daemon/
│       ├── main.py                # Daemon entry point
│       ├── lifecycle.py           # PID management
│       ├── ipc.py                 # IPC communication
│       ├── watchdog.py            # Process monitoring
│       ├── checkpoint.py          # State persistence
│       └── power.py               # Sleep/wake handling
│
├── extensions/quantlab/src/
│   └── core/
│       ├── trading/
│       │   └── DaemonClient.ts    # UI-daemon communication
│       ├── risk/
│       │   └── ExposureManager.ts # Exposure reservation
│       └── secrets/
│           ├── backend.ts         # Secrets backend selection
│           ├── encrypted.ts       # Encrypted file backend
│           └── migration.ts       # Migration utilities
│
└── benchmarks/                    # Benchmark suite (NEW directory)
    ├── data/
    ├── strategies/
    ├── runner.py
    └── check.py
```

### B.2 Phase 2 - Core Engine

```
NEW FILES:
├── engine/
│   ├── backtest/
│   │   ├── core.py                # Main backtest loop
│   │   ├── fills.py               # Fill logic
│   │   ├── slippage.py            # Slippage models
│   │   ├── commission.py          # Commission models
│   │   ├── data.py                # Data handling
│   │   └── alignment.py           # Multi-asset alignment
│   │
│   ├── orders/
│   │   ├── market.py              # Market orders
│   │   ├── limit.py               # Limit orders
│   │   ├── stop.py                # Stop orders
│   │   ├── stop_limit.py          # Stop-limit orders
│   │   ├── tif.py                 # Time-in-force
│   │   ├── partials.py            # Partial fills
│   │   └── priority.py            # Order priority
│   │
│   ├── portfolio/
│   │   ├── state.py               # Portfolio state
│   │   ├── short.py               # Short selling
│   │   ├── fees.py                # Borrow fees
│   │   ├── validation.py          # Equity identity
│   │   └── limits.py              # Buying power
│   │
│   ├── data/
│   │   ├── rev.py                 # DataRev schema
│   │   ├── hash.py                # Content hashing
│   │   ├── universe.py            # UniverseRev
│   │   └── corporate.py           # Corporate actions (V1.1 - DEFERRED per L71)
│   │
│   ├── calendar/
│   │   ├── schema.py              # Calendar schema
│   │   ├── loader.py              # Calendar loading
│   │   ├── builtin/               # NYSE, NASDAQ, Crypto
│   │   ├── custom.py              # Custom calendars
│   │   └── timezone.py            # Timezone handling
│   │
│   ├── features/
│   │   ├── cache.py               # Feature cache keys
│   │   ├── store.py               # Feature storage
│   │   ├── leakage.py             # Look-ahead detection
│   │   └── deps.py                # Dependency tracking
│   │
│   ├── metrics/
│   │   ├── returns.py             # Return calculations
│   │   ├── risk.py                # Sharpe, Sortino, etc.
│   │   ├── trade.py               # Win rate, profit factor
│   │   ├── drawdown.py            # Max drawdown
│   │   ├── stability.py           # Stability score
│   │   ├── drift.py               # Trade drift detection
│   │   └── annualize.py           # Annualization
│   │
│   ├── api/
│   │   ├── vectorized.py          # Vectorized API
│   │   ├── event.py               # Event-driven API
│   │   ├── class_based.py         # Class-based API
│   │   ├── params.py              # Parameter extraction
│   │   └── state.py               # State serialization
│   │
│   ├── protocol/
│   │   ├── sequence.py            # Sequence numbers
│   │   ├── ordering.py            # Message ordering
│   │   ├── ack.py                 # Acknowledgments
│   │   └── version.py             # Protocol versioning
│   │
│   └── precision/
│       ├── policy.py              # Precision rules
│       └── compare.py             # Tolerance helpers
```

### B.3 Phase 3 - UI & Safety

```
NEW FILES:
├── extensions/quantlab/src/
│   ├── core/
│   │   ├── trading/
│   │   │   ├── checklist.ts       # Pre-trade checklist
│   │   │   └── checks/            # Individual checks
│   │   └── trust/
│   │       ├── store.ts           # Trust storage
│   │       ├── hash.ts            # Strategy hashing
│   │       ├── extensions.ts      # Extension trust
│   │       └── watcher.ts         # File watcher
│   │
│   ├── views/
│   │   └── chart/
│   │       └── CodeSync.ts        # Code highlighting sync
│   │
│   ├── ui/
│   │   ├── TrustDialog.ts         # Trust dialog
│   │   ├── SystemTray.ts          # Tray integration
│   │   ├── RecoveryDialog.ts      # Session recovery
│   │   ├── SessionStatus.ts       # Status bar item
│   │   ├── MarketStatus.ts        # Market hours banner
│   │   └── MasterKeyPrompt.ts     # Secrets prompt
│   │
│   ├── ai/
│   │   ├── panel.ts               # AI panel provider
│   │   ├── sanitize.ts            # Input sanitization
│   │   ├── consent.ts             # Consent tracking
│   │   ├── audit.ts               # AI audit log
│   │   ├── provider.ts            # API integration
│   │   └── context.ts             # Context builder
│   │
│   └── panels/
│       └── AIPanelProvider.ts     # AI Activity Bar panel
│
├── extensions/quantlab/webview/
│   ├── chart/
│   │   ├── debugger.ts            # Debugger controls
│   │   └── navigation.ts          # Trade jumping
│   ├── trade/
│   │   └── checklist.ts           # Checklist UI
│   └── ai/
│       └── panel.ts               # AI panel webview
│
└── engine/
    └── debug/
        ├── format.py              # Debug file format
        ├── index.py               # Random access index
        ├── mmap.py                # Memory-mapped reader
        └── capture.py             # Condition capture
```

### B.4 Phase 4 - Live Trading

```
NEW FILES:
├── extensions/quantlab/src/
│   ├── core/
│   │   ├── trading/
│   │   │   ├── flatten.ts         # Emergency flatten
│   │   │   ├── reconcile.ts       # Position reconciliation
│   │   │   ├── fills.ts           # Fill reconciliation
│   │   │   ├── quote.ts           # Quote validation
│   │   │   ├── marketHours.ts     # Market hours detection
│   │   │   └── offline.ts         # Offline handling
│   │   │
│   │   └── broker/
│   │       ├── reconnect.ts       # Reconnection logic
│   │       └── BrokerStatus.ts    # Status indicator
│   │
│   ├── ui/
│   │   ├── KillSwitchDialog.ts    # Kill switch dialog
│   │   └── ReconcileDialog.ts     # Reconciliation dialog
│   │
│   └── panels/
│       └── AuditLogPanel.ts       # Audit log viewer
│
├── extensions/quantlab/webview/
│   └── trade/
│       └── killswitch.ts          # Kill switch dropdown
│
└── engine/
    ├── daemon/
    │   └── flatten.py             # Flatten in daemon
    │
    └── audit/
        ├── log.py                 # Tamper-evident log
        └── export.py              # Audit export
```

### B.5 Phase 5 - Testing & Release

```
NEW FILES:
├── tests/
│   ├── golden/
│   │   ├── runner.py              # Golden test runner
│   │   ├── vectors/               # Test vectors
│   │   ├── data.py                # Data generators
│   │   ├── compare.py             # Tolerance comparison
│   │   └── update.py              # Golden update workflow
│   │
│   ├── live/
│   │   ├── harness.py             # Live test harness
│   │   ├── mock_broker.py         # Mock broker
│   │   ├── paper.py               # Paper trading tests
│   │   ├── safety.py              # Safety tests
│   │   ├── failure.py             # Failure/chaos tests
│   │   └── flatten.py             # Flatten tests
│   │
│   ├── security/
│   │   ├── secrets.py             # Secrets tests
│   │   ├── sandbox.py             # Sandbox tests
│   │   ├── trust.py               # Trust tests
│   │   ├── paths.py               # Path traversal
│   │   └── ai.py                  # AI panel tests
│   │
│   └── perf/
│       ├── ui.py                  # UI responsiveness
│       ├── live.py                # Live latency
│       ├── debug.py               # Debug file perf
│       ├── profile.py             # Profiling
│       └── report.py              # Regression reports
│
├── docs/
│   ├── getting-started.md
│   ├── risk.md
│   ├── architecture.md
│   ├── deployment.md
│   ├── api/
│   └── runbooks/
│       └── p1.md
│
└── .github/workflows/
    ├── golden.yml                 # Golden test CI
    ├── benchmark.yml              # (from Phase 1)
    └── security.yml               # Security scan CI
```

---

## C. Type Definitions

### C.1 Trading Types

```typescript
// types/trading.ts (existing, to be extended)

interface SessionConfig {
  id: string;
  strategyPath: string;
  strategyHash: string;
  type: 'paper' | 'live';
  brokerId: string;
  riskLimits: RiskLimits;
  dataProviders: string[];
}

interface RiskLimits {
  maxOrderSize: number;
  maxPositionSize: number;
  maxGrossExposure: number;  // As percentage of equity
  dailyLossLimit: number;
  maxDrawdown: number;
}

interface ExposureReservation {
  orderId: string;
  amount: number;
  expiresAt: Date;
  symbol: string;
}

interface PreTradeCheck {
  id: string;
  name: string;
  passed: boolean;
  blocking: boolean;
  warning?: boolean;
  message: string;
  details?: string;
}

interface ReconciliationResult {
  matches: boolean;
  discrepancies: Discrepancy[];
  diagnosed: boolean;
}

interface Discrepancy {
  symbol: string;
  engineQty: number;
  brokerQty: number;
  delta: number;
  cause: DiscrepancyCause;
}

type DiscrepancyCause =
  | 'missed_fills'
  | 'corporate_action'
  | 'external_trade'
  | 'unknown';
```

### C.2 Engine Types

```typescript
// types/engine.ts (existing, to be extended)

interface BacktestConfig {
  initialCapital: number;
  fillAssumption: 'next_open' | 'next_close' | 'typical_price';
  slippageModel: SlippageModel;
  commissionModel: CommissionModel;
  participationRate: number;
  allowSignalsOnForwardFill: boolean;
  calendar: string;
}

interface SlippageModel {
  type: 'none' | 'fixed_bps' | 'volatility';
  params: {
    bps?: number;
    k?: number;
  };
}

interface CommissionModel {
  type: 'none' | 'per_share' | 'per_trade';
  cost: number;
}

interface DataRev {
  id: string;
  hash: string;
  hashMethod: 'full' | 'sampled';
  symbol: string;
  timeframe: string;
  dateRange: DateRange;
  source: DataSource;
  rowCount: number;
  schema: ColumnSchema[];
}

interface DebugState {
  barIndex: number;
  timestamp: Date;
  ohlcv: OhlcvBar;
  indicators: Record<string, number>;
  conditions: ConditionCapture[];
  portfolio: PortfolioSnapshot;
  signals: Signal[];
}

interface ConditionCapture {
  lineNumber: number;
  expression: string;
  leftValue: string;
  rightValue: string;
  result: boolean;
}
```

### C.3 Daemon Types

```typescript
// types/daemon.ts (NEW)

interface DaemonHandle {
  pid: number;
  sessionId: string;
  socketPath: string;
  logPath: string;
}

interface DaemonCommand {
  type: 'start' | 'stop' | 'pause' | 'resume' | 'flatten' | 'status';
  payload?: unknown;
}

interface DaemonState {
  status: 'running' | 'paused' | 'stopping' | 'stopped';
  sessionInfo: SessionInfo;
  positions: Position[];
  openOrders: Order[];
  metrics: SessionMetrics;
  lastCheckpoint: Date;
}

interface CheckpointData {
  version: string;
  timestamp: Date;
  state: DaemonState;
  portfolioSnapshot: PortfolioSnapshot;
  pendingOrders: Order[];
}
```

---

## D. Configuration Schema

### D.1 Risk Limits Settings (Decision L74)

```json
// settings.json contribution
{
  "quantlab.trading.riskLimits.dailyLossPercent": {
    "type": "number",
    "default": 0.02,
    "minimum": 0.01,
    "maximum": 0.10,
    "description": "Maximum daily loss as percentage of equity (0.02 = 2%)"
  },
  "quantlab.trading.riskLimits.maxDrawdown": {
    "type": "number",
    "default": 0.05,
    "minimum": 0.02,
    "maximum": 0.20,
    "description": "Maximum drawdown percentage (0.05 = 5%)"
  },
  "quantlab.trading.riskLimits.consecutiveLosses": {
    "type": "integer",
    "default": 3,
    "minimum": 2,
    "maximum": 10,
    "description": "Maximum consecutive losing trades before circuit breaker"
  },
  "quantlab.trading.riskLimits.maxGrossExposure": {
    "type": "number",
    "default": 1.0,
    "minimum": 0.5,
    "maximum": 1.0,
    "description": "Maximum gross exposure as fraction of equity (1.0 = 100%)"
  }
}
```

### D.2 Calendar YAML Schema

```yaml
# Schema for calendars/*.yaml
$schema: http://json-schema.org/draft-07/schema#
type: object
required:
  - name
  - timezone
  - regular_hours
  - holidays
  - trading_days_per_year

properties:
  name:
    type: string
    description: Calendar name (e.g., "NYSE")

  timezone:
    type: string
    description: IANA timezone (e.g., "America/New_York")

  regular_hours:
    type: object
    required: [open, close]
    properties:
      open: { type: string, pattern: "^\\d{2}:\\d{2}$" }
      close: { type: string, pattern: "^\\d{2}:\\d{2}$" }

  extended_hours:
    type: object
    properties:
      pre_market: { type: string, pattern: "^\\d{2}:\\d{2}$" }
      after_hours: { type: string, pattern: "^\\d{2}:\\d{2}$" }

  holidays:
    type: array
    items:
      type: object
      required: [date, name]
      properties:
        date: { type: string, format: date }
        name: { type: string }

  early_closes:
    type: array
    items:
      type: object
      required: [date, close, name]
      properties:
        date: { type: string, format: date }
        close: { type: string, pattern: "^\\d{2}:\\d{2}$" }
        name: { type: string }

  trading_days_per_year:
    type: integer
    minimum: 200
    maximum: 366
```

---

## E. Dependencies to Add

### E.1 Python Dependencies

```
# requirements.txt additions

# Phase 1
argon2-cffi>=21.0.0       # Key derivation
psutil>=5.9.0             # Process management

# Phase 2
libcst>=1.0.0             # Code modification (CST)
pyarrow>=14.0.0           # Debug file format
zoneinfo                  # Timezone (stdlib in 3.9+)

# Phase 3
# (No new dependencies)

# Testing
pytest>=7.0.0
pytest-cov>=4.0.0
hypothesis>=6.0.0         # Property-based testing
```

### E.2 Node Dependencies

```json
// package.json additions
{
  "dependencies": {
    "apache-arrow": "^14.0.0"  // Debug file reading (Phase 3)
  },
  "devDependencies": {
    "@types/apache-arrow": "^0.0.1"
  }
}
```

---

## F. API Endpoints

### F.1 Daemon IPC Protocol (Decision N96)

**Protocol**: JSON-RPC 2.0 over Unix sockets (Linux/macOS) or Named pipes (Windows)

```
Socket (Unix): ~/.quantlab/sockets/{session_id}.sock
Pipe (Windows): \\.\pipe\quantlab-{session_id}

Request format (JSON-RPC 2.0):
{
  "jsonrpc": "2.0",
  "method": "start" | "stop" | "pause" | "resume" | "flatten" | "status",
  "params": {...},
  "id": "uuid"
}

Response format (JSON-RPC 2.0):
{
  "jsonrpc": "2.0",
  "result": {...},
  "id": "uuid"
}

Error format (JSON-RPC 2.0):
{
  "jsonrpc": "2.0",
  "error": { "code": -32600, "message": "Invalid Request" },
  "id": "uuid"
}

Notification format (no response expected):
{
  "jsonrpc": "2.0",
  "method": "progress",
  "params": { "percent": 45, "jobId": "abc123" }
}

Event format (daemon → UI):
{
  "jsonrpc": "2.0",
  "method": "state_changed" | "position_update" | "fill" | "error",
  "params": {...}
}
```

### F.2 Streaming Protocol Messages

```typescript
// UI → Engine
type UICommand =
  | { type: 'run_backtest'; config: BacktestConfig }
  | { type: 'cancel_job'; jobId: string }
  | { type: 'start_session'; config: SessionConfig }
  | { type: 'stop_session'; sessionId: string; reason?: string };

// Engine → UI
type EngineMessage =
  | { type: 'progress'; jobId: string; percent: number }
  | { type: 'completed'; jobId: string; result: BacktestResult }
  | { type: 'failed'; jobId: string; error: ErrorInfo }
  | { type: 'state_update'; sessionId: string; state: DaemonState };
```

---

## G. Testing Fixtures

### G.1 Synthetic Data Generators

```python
def generate_linear_trend(bars: int = 252, trend: float = 0.0002) -> pd.DataFrame:
    """Generate trending price series."""
    returns = np.random.normal(trend, 0.02, bars)
    prices = 100 * np.cumprod(1 + returns)
    return create_ohlcv(prices)

def generate_mean_revert(bars: int = 252, mean: float = 100) -> pd.DataFrame:
    """Generate mean-reverting price series."""
    # Ornstein-Uhlenbeck process
    pass

def generate_gap_series(bars: int = 252, gap_prob: float = 0.05) -> pd.DataFrame:
    """Generate series with random gaps."""
    pass
```

### G.2 Mock Broker Fixtures

```python
class MockBrokerFixture:
    def __init__(self):
        self.positions = {}
        self.orders = {}
        self.fills = []

    def set_position(self, symbol: str, qty: int, avg_price: float):
        self.positions[symbol] = Position(symbol, qty, avg_price)

    def inject_fill(self, order_id: str, qty: int, price: float):
        self.fills.append(Fill(order_id, qty, price))

    def disconnect_for(self, seconds: float):
        """Simulate broker disconnect."""
        pass
```

---

## H. Error Codes

### H.1 Trading Errors

| Code | Name | Description |
|------|------|-------------|
| T001 | EXPOSURE_LIMIT | Order would breach exposure limit |
| T002 | POSITION_LIMIT | Order would breach position size limit |
| T003 | DAILY_LOSS | Daily loss limit reached |
| T004 | BROKER_DISCONNECT | Broker connection lost |
| T005 | ORDER_TIMEOUT | Order not acknowledged in time |
| T006 | FLATTEN_FAILED | Emergency flatten failed |

### H.2 Engine Errors

| Code | Name | Description |
|------|------|-------------|
| E001 | PARSE_ERROR | Strategy parse error |
| E002 | LOOKAHEAD | Look-ahead bias detected |
| E003 | DATA_MISSING | Required data not available |
| E004 | CHECKPOINT_CORRUPT | Checkpoint file corrupted |
| E005 | DAEMON_CRASH | Daemon process crashed |

### H.3 Security Errors

| Code | Name | Description |
|------|------|-------------|
| S001 | NOT_TRUSTED | Workspace/strategy not trusted |
| S002 | SANDBOX_VIOLATION | Strategy violated sandbox |
| S003 | SECRETS_LOCKED | Secrets backend locked |
| S004 | AUTH_EXPIRED | API credentials expired |

---

---

## I. Key Configuration Values (from Decisions)

### I.1 Limits and Thresholds

| Parameter | Value | Decision |
|-----------|-------|----------|
| Max concurrent backtests | 2 (configurable 1-4) | N89 |
| Max concurrent live sessions | 3 | N95 |
| Backtest memory limit | 4GB (max 16GB) | N88 |
| Live session memory limit | 2GB (max 8GB) | N88 |
| Debug file buffer | 1GB (max 4GB) | N88 |
| Network circuit breaker | 5 minutes | N82 |
| Quote staleness threshold | 30 seconds | §10.5 |
| Audit log retention | 7 years | E31 |
| Daemon log retention | 90 days | N87 |
| Engine log retention | 30 days | N87 |

### I.2 Order ID Format (Decision N100)

```
Format: {type}-{uuidv4}

Examples:
- ord-550e8400-e29b-41d4-a716-446655440000  (regular order)
- flat-550e8400-e29b-41d4-a716-446655440001 (flatten order)
- stop-550e8400-e29b-41d4-a716-446655440002 (stop loss)
```

### I.3 Disk Space Thresholds (Decision N93)

| Threshold | Action |
|-----------|--------|
| 90% | Toast warning |
| 95% | Block new backtests |
| 99% | Emergency cleanup prompt |

### I.4 Memory Thresholds (Decision N88)

| Usage | Action |
|-------|--------|
| 80% | Warning toast |
| 95% | Pause and prompt user |
| At limit | Graceful termination with checkpoint |

---

## J. VS Code Fork Integration Points (Decisions M77-M80)

### J.1 Extension API Preservation (M77)

**Decision**: Preserve all standard VS Code extension APIs

| Aspect | Approach |
|--------|----------|
| Extension host | Run standard extensions unchanged |
| Marketplace | Redirect marketplace.visualstudio.com → Open VSX |
| Keybindings | Unchanged system, add Quantlab prefix (`Ctrl+Shift+Q` / `Cmd+Shift+K`) |

### J.2 Git Integration (M78)

**Decision**: Use VS Code's built-in Git support unchanged

- Strategy versioning uses native Git UI
- No Quantlab-specific Git customization needed
- Source Control panel works as expected

### J.3 Terminal Integration (M79)

**Decision**: Use VS Code's integrated terminal unchanged

**Addition for V1**:
- Add "Run Backtest" command in terminal context menu
- Add "Run Live Session" command (if trusted workspace)

### J.4 Python Environment Management (M80)

**Decision**: Bundled Python is isolated, user can configure external

| Mode | Description |
|------|-------------|
| **Bundled** (default) | Use shipped Python 3.11 for engine |
| **Custom** | User points to external Python (advanced) |

**Setting**: `quantlab.python.path` (default: bundled)

### J.5 Fork Maintenance Notes (Decision C18)

| Task | Cadence | SLA |
|------|---------|-----|
| Upstream merge | Monthly | First Tuesday after VS Code release |
| Security patches | As needed | 48 hours for critical |
| Conflict resolution | Per merge | Document in PATCHES.md |
| Regression testing | Per merge | 1-2 days |

**Annual maintenance estimate**: 3-4 engineer-months

---

## K. V1 vs V1.1 Scope

### K.1 In V1 (Non-negotiable)

| Feature | Decision |
|---------|----------|
| Backtest engine with all order types | — |
| Live trading with Alpaca only | B11 |
| Alpaca Data API only | B12 |
| Daemon architecture with IPC | A4, A5 |
| Risk limits and safety controls | — |
| Time-travel debugger (bar state level) | — |
| AI panel with sanitization | G37 |
| OS Keychain + encrypted fallback | E27 |
| English only UI | N92 |

### K.2 Deferred to V1.1

| Feature | Decision | Reason |
|---------|----------|--------|
| Corporate action simulation | L71 | Use adjusted data instead |
| Multi-broker support | B11 | V1 focus |
| Multi-provider data failover | B12 | V1 focus |
| Per-strategy Python environments | N85 | Complexity |
| Non-English translations | N92 | V1 focus |
| External security audit | E26 | Recommended but optional |

### K.3 Explicitly Out of Scope (V2+)

- Options/futures
- Team collaboration
- Tick-level simulation
- Leverage/margin trading

---

*This appendix provides technical reference for implementation. Update as implementation progresses.*
