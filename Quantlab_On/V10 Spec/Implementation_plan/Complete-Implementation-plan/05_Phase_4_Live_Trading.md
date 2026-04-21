# Phase 4: Live Trading Polish

**Duration**: 6 weeks
**Priority**: HIGH - Production readiness for live trading
**Spec References**: Technical Spec §9.7, §10-12; Operations Spec §2.6
**Decisions Reference**: B11, B12, C16, E31, H50, H51, H53, N81, N82, N95

---

## Objectives

This phase polishes live trading features for production use:

1. **Emergency Flatten Protocol** - Safe position exit in emergencies
2. **Position Reconciliation** - Handle broker/engine state mismatches
3. **Broker Disconnect Handling** - Graceful degradation
4. **Tamper-Evident Audit Log** - Compliance-ready, **7-year retention** (Decision E31)
5. **Fill Reconciliation** - Handle out-of-order/duplicate fills
6. **Session Ledger** - Durable append-only record
7. **Data Provider Adapter** - **Alpaca Data API** for V1 (Decision B12)
8. **Trade Drift Detection** - Statistical backtest-vs-live comparison
9. **Network Connectivity Handling** - Circuit breaker (Decision N82)
10. **Sleep/Wake Handling** - Pause daemon, reconcile on wake (Decision N81)
11. **Auto-Update Protection** - Belt and suspenders (Decision C16)
12. **Concurrent Session Limit** - Max 3 live sessions (Decision N95)

---

## 1. Emergency Flatten Protocol

### 1.1 Background

**Spec Reference**: Operations Spec §2.6

Emergency flatten must close all positions quickly and reliably, even in adverse market conditions.

### 1.2 Two-Stage Approach

| Stage | Order Type | Timeout | Use Case |
|-------|------------|---------|----------|
| Stage 1 | Marketable Limit IOC | 2s | Normal conditions |
| Stage 2 | Market Order | Fallback | Stage 1 incomplete |

### 1.3 Stage 1: Marketable Limit

```python
def calculate_marketable_limit(position: Position, quote: Quote) -> Decimal:
    """Calculate aggressive limit price."""
    spread = quote.ask - quote.bid

    if position.is_long:
        # Sell below bid to ensure fill
        return quote.bid - 2 * spread
    else:
        # Buy above ask to ensure fill
        return quote.ask + 2 * spread
```

### 1.4 Quote Validation

Before sending flatten orders, validate quote quality:

```python
class QuoteStatus(Enum):
    VALID = 'valid'
    MISSING = 'missing'
    STALE = 'stale'
    INVALID = 'invalid'
    WIDE = 'wide'

def validate_quote(symbol: str, quote: Quote) -> QuoteStatus:
    if quote is None:
        return QuoteStatus.MISSING

    if quote.age_seconds > 30:
        return QuoteStatus.STALE

    if quote.bid <= 0 or quote.ask <= 0:
        return QuoteStatus.INVALID

    if quote.spread_pct > 10.0:  # > 10% spread
        return QuoteStatus.WIDE

    return QuoteStatus.VALID
```

### 1.5 Retry Strategy

| Attempt | Delay | Order Type |
|---------|-------|------------|
| 1 | 0ms | Stage 1 (limit) |
| 2 | 100ms | Stage 1 (limit) |
| 3 | 500ms | Stage 2 (market) |
| 4 | 1s | Stage 2 (market) |
| 5 | 2s | Stage 2 (market) |
| 6 | 5s | Stage 2 (market) |

### 1.6 Out-of-Hours Handling

| Market State | Flatten Behavior |
|--------------|------------------|
| Regular hours | Normal two-stage protocol |
| Pre/post market | Market order only |
| Market closed | Queue for next open + ALERT |

### 1.7 Kill Switch UI

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ EMERGENCY FLATTEN                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ This will immediately close ALL positions in your live session.             │
│                                                                              │
│ Current positions:                                                          │
│ • 100 AAPL @ $185.50 (+$234.00)                                             │
│ • 50 MSFT @ $410.20 (-$45.00)                                               │
│ • -25 NVDA @ $890.00 (+$125.00)                                             │
│                                                                              │
│ Estimated market value: $23,456.00                                          │
│                                                                              │
│ To confirm, type "FLATTEN" below:                                           │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │                                                                       │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│                                                   [Cancel]  [Confirm Flatten]│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.8 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Quote validation module | 1d | `extensions/quantlab/src/core/trading/quote.ts` (NEW) |
| Stage 1 (marketable limit) logic | 2d | `extensions/quantlab/src/core/trading/flatten.ts` (NEW) |
| Stage 2 (market fallback) logic | 1d | Same |
| Retry strategy with backoff | 1d | Same |
| Out-of-hours detection | 1d | `extensions/quantlab/src/core/trading/marketHours.ts` (NEW) |
| Kill switch dialog UI | 1d | `extensions/quantlab/src/ui/KillSwitchDialog.ts` (NEW) |
| Kill switch dropdown (pause/flatten/alert) | 1d | `extensions/quantlab/webview/trade/killswitch.ts` (NEW) |
| Flatten logging | 1d | `extensions/quantlab/src/core/trading/flatten.ts` |
| Integration with daemon | 1d | `engine/daemon/flatten.py` (NEW) |

### 1.9 Testing Requirements

| Test ID | Description |
|---------|-------------|
| L060 | Flatten single long position |
| L061 | Flatten single short position |
| L062 | Flatten multiple positions |
| L063 | Flatten with stage 1 success |
| L064 | Flatten with stage 2 fallback |
| L065 | Flatten with stale quote → market immediately |
| L066 | Flatten with missing quote → market immediately |
| L067 | Flatten idempotency (no duplicate orders) |
| L068 | All flatten actions logged |
| L069 | Flatten completes within 10s |
| L070 | Type "FLATTEN" required for confirmation |

---

## 2. Position Reconciliation

### 2.1 Background

**Spec Reference**: Technical Spec §10.7

Position mismatches between engine and broker can occur due to:
- Missed fills
- Corporate actions
- External trades
- Network issues

### 2.2 Reconciliation Flow

```
UI/Daemon Reconnects
        │
        ▼
Fetch broker positions
        │
        ▼
Compare to engine state
        │
        ├─── Match → Continue normally
        │
        └─── Mismatch → Show reconciliation dialog
                                │
                                ▼
        ┌───────────────────────────────────────────────────┐
        │ POSITION MISMATCH DETECTED                         │
        │                                                    │
        │ Symbol  Engine    Broker    Difference             │
        │ ─────────────────────────────────────────────────  │
        │ AAPL    100       150       +50 (missed fill?)     │
        │ MSFT    50        50        Match                  │
        │ NVDA    -25       0         +25 (external trade?)  │
        │                                                    │
        │ [Accept Broker Truth]  [Investigate]  [Flatten All]│
        └───────────────────────────────────────────────────┘
```

### 2.3 Discrepancy Causes

```python
class DiscrepancyCause(Enum):
    MISSED_FILLS = 'missed_fills'
    CORPORATE_ACTION = 'corporate_action'
    EXTERNAL_TRADE = 'external_trade'
    NETWORK_ISSUE = 'network_issue'
    UNKNOWN = 'unknown'

def diagnose_cause(symbol: str, last_sync: datetime) -> DiscrepancyCause:
    # Check for missed fills
    unprocessed = broker.get_fills_since(last_sync)
    if any(f.symbol == symbol for f in unprocessed):
        return DiscrepancyCause.MISSED_FILLS

    # Check for corporate actions
    corp_actions = data_provider.get_corporate_actions(symbol, last_sync)
    if corp_actions:
        return DiscrepancyCause.CORPORATE_ACTION

    return DiscrepancyCause.EXTERNAL_TRADE
```

### 2.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Reconciliation algorithm | 2d | `extensions/quantlab/src/core/trading/reconcile.ts` (NEW) |
| Discrepancy diagnosis | 2d | Same |
| Reconciliation dialog UI | 2d | `extensions/quantlab/src/ui/ReconcileDialog.ts` (NEW) |
| "Accept broker truth" action | 1d | `extensions/quantlab/src/core/trading/reconcile.ts` |
| "Investigate" action (open log) | 0.5d | Same |
| Integration with reconnect flow | 1d | `extensions/quantlab/src/core/trading/DaemonClient.ts` |
| ~~Corporate action detection~~ | ~~2d~~ | **DEFERRED to V1.1 (L71)** - Use adjusted data only in V1 |

### 2.5 Testing Requirements

| Test ID | Description |
|---------|-------------|
| L046 | Position mismatch shows dialog |
| L047 | "Accept broker truth" updates engine state |
| L048 | Missed fills diagnosed correctly |
| ~~L049~~ | ~~Corporate actions diagnosed correctly~~ **DEFERRED to V1.1 (L71)** |

---

## 3. Broker Disconnect Handling

### 3.1 Background

**Spec Reference**: Technical Spec §12.2

Broker disconnections must be handled gracefully without losing trades.

### 3.2 Disconnect Thresholds

| Duration | Behavior |
|----------|----------|
| < 30s | Auto-reconnect, silent |
| 30s - 5min | Warning, continue retry |
| > 5min | Circuit breaker triggers |

### 3.3 Reconnection Strategy

```python
class BrokerReconnector:
    MAX_BACKOFF_SECONDS = 60
    CIRCUIT_BREAKER_THRESHOLD = 300  # 5 minutes

    async def handle_disconnect(self):
        start_time = time.time()
        backoff = 1

        while True:
            elapsed = time.time() - start_time

            if elapsed > self.CIRCUIT_BREAKER_THRESHOLD:
                await self.trigger_circuit_breaker("broker_disconnect_timeout")
                return

            try:
                await self.broker.reconnect()
                await self.reconcile_positions()
                self.notify_user("Broker reconnected")
                return
            except ConnectionError:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.MAX_BACKOFF_SECONDS)
```

### 3.4 UI States

| State | Indicator | Action Available |
|-------|-----------|------------------|
| Connected | Green dot | Normal trading |
| Reconnecting | Yellow pulsing | View positions |
| Disconnected > 5min | Red dot | Reconnect / Flatten |

### 3.5 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Disconnect detection | 1d | `extensions/quantlab/src/core/broker/BrokerAdapter.ts` |
| Exponential backoff retry | 1d | `extensions/quantlab/src/core/broker/reconnect.ts` (NEW) |
| Circuit breaker trigger | 1d | Same |
| Status indicator UI | 1d | `extensions/quantlab/src/ui/BrokerStatus.ts` (NEW) |
| Offline mode handling | 1d | `extensions/quantlab/src/core/trading/offline.ts` (NEW) |

### 3.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| L040 | Disconnect < 30s auto-reconnects |
| L041 | Disconnect > 5min triggers circuit breaker |
| CH-010 | Auto-reconnect succeeds |
| CH-011 | Circuit breaker activates at threshold |

---

## 4. Tamper-Evident Audit Log

### 4.1 Background

**Spec Reference**: Technical Spec §12.3

Live trading requires tamper-evident logging for compliance and debugging.

### 4.2 Hash Chaining

```python
class TamperEvidentLog:
    GENESIS_HASH = 'genesis'

    def __init__(self, path: str):
        self.path = path
        self.prev_hash = self._load_last_hash() or self.GENESIS_HASH

    def append(self, entry: dict) -> str:
        # Serialize deterministically
        entry_json = json.dumps(entry, sort_keys=True, default=str)

        # Compute hash including previous hash
        hash_input = f"{self.prev_hash}:{entry_json}"
        entry_hash = hashlib.sha256(hash_input.encode()).hexdigest()

        # Build record
        record = {
            'timestamp': datetime.now(UTC).isoformat(),
            'sequence': self._get_next_sequence(),
            'entry': entry,
            'prev_hash': self.prev_hash,
            'hash': entry_hash
        }

        # Write with fsync for durability
        with open(self.path, 'a') as f:
            f.write(json.dumps(record) + '\n')
            f.flush()
            os.fsync(f.fileno())

        self.prev_hash = entry_hash
        return entry_hash
```

### 4.3 Integrity Verification

```python
def verify_integrity(self) -> IntegrityResult:
    prev_hash = self.GENESIS_HASH

    with open(self.path, 'r') as f:
        for line_num, line in enumerate(f, 1):
            record = json.loads(line)

            # Verify chain continuity
            if record['prev_hash'] != prev_hash:
                return IntegrityResult(
                    valid=False,
                    broken_at=line_num,
                    reason=f"Chain broken at line {line_num}"
                )

            # Verify hash correctness
            entry_json = json.dumps(record['entry'], sort_keys=True, default=str)
            expected = hashlib.sha256(f"{prev_hash}:{entry_json}".encode()).hexdigest()

            if record['hash'] != expected:
                return IntegrityResult(
                    valid=False,
                    broken_at=line_num,
                    reason='Hash mismatch - possible tampering'
                )

            prev_hash = record['hash']

    return IntegrityResult(valid=True)
```

### 4.4 Log Entries

| Entry Type | Logged Data |
|------------|-------------|
| session_start | session_id, strategy, mode, risk_limits |
| order_submit | order_id, symbol, side, type, quantity, price |
| order_fill | order_id, fill_id, quantity, price |
| order_cancel | order_id, reason |
| position_change | symbol, old_qty, new_qty |
| circuit_breaker | trigger_reason, action_taken |
| session_end | reason, final_equity |

### 4.5 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| TamperEvidentLog class | 2d | `engine/audit/log.py` (NEW) |
| Hash chain verification | 1d | Same |
| Log rotation with chain preservation | 1d | Same |
| Export for audit | 1d | `engine/audit/export.py` (NEW) |
| Integration with daemon | 1d | `engine/daemon/main.py` |
| Log viewer UI | 1d | `extensions/quantlab/src/panels/AuditLogPanel.ts` (NEW) |

### 4.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| AL001 | Log entries written with fsync |
| AL002 | Hash chain verifies correctly |
| AL003 | Tampering detected |
| AL004 | Log rotation preserves chain |
| AL005 | Export includes all entries |

---

## 5. Fill Reconciliation

### 5.1 Background

**Spec Reference**: Technical Spec §10.6

Fills can arrive out of order or be duplicated during network issues.

### 5.2 Fill Processing

```python
class FillReconciler:
    def __init__(self):
        self.processed_fills: Set[str] = set()
        self.pending_fills: Dict[str, Fill] = {}

    def process_fill(self, fill: Fill) -> bool:
        # Idempotency check
        if fill.fill_id in self.processed_fills:
            log.warning(f"Duplicate fill ignored: {fill.fill_id}")
            return False

        # Sequence check
        order = self.orders.get(fill.order_id)
        if order and fill.sequence != order.expected_fill_sequence:
            self.pending_fills[fill.fill_id] = fill
            log.warning(f"Out-of-order fill buffered: {fill.fill_id}")
            return False

        # Process in order
        self._apply_fill(fill)
        self.processed_fills.add(fill.fill_id)
        return True
```

### 5.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| FillReconciler class | 2d | `extensions/quantlab/src/core/trading/fills.ts` (NEW) |
| Idempotency tracking | 1d | Same |
| Out-of-order buffering | 1d | Same |
| Unknown order handling | 1d | Same |
| Integration with broker adapter | 1d | `extensions/quantlab/src/core/broker/BrokerAdapter.ts` |

### 5.4 Testing Requirements

| Test ID | Description |
|---------|-------------|
| FR001 | Duplicate fills ignored |
| FR002 | Out-of-order fills buffered |
| FR003 | Unknown order fills logged |
| FR004 | Fills applied correctly |

---

## 6. Session Ledger [NEW]

### 6.1 Background

**Spec Reference**: Technical Spec §12.1

Durable, append-only record for all live sessions. Different from Audit Log - Ledger is for recovery, Audit Log is for compliance.

### 6.2 Ledger Entries

```typescript
interface SessionLedger {
  sessionId: string;
  mode: 'paper' | 'live';
  entries: LedgerEntry[];  // Append-only
}

type LedgerEntry =
  | SessionStartEntry
  | BarEntry
  | SignalEntry
  | OrderEntry
  | FillEntry
  | PositionSnapshotEntry
  | ErrorEntry;
```

### 6.3 Durability Guarantees

| Guarantee | Requirement |
|-----------|-------------|
| Write-ahead | Entry written BEFORE action |
| Sync | fsync after OrderEntry and FillEntry |
| Corruption detection | CRC32 per entry |

### 6.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| SessionLedger class | 2d | `engine/ledger/session.py` (NEW) |
| Entry serialization | 1d | Same |
| Write-ahead logging | 1d | Same |
| CRC32 corruption detection | 1d | Same |
| Recovery from ledger | 2d | `engine/daemon/recovery.py` (NEW) |

### 6.5 Testing Requirements

| Test ID | Description |
|---------|-------------|
| SL001 | Entry written before order sent |
| SL002 | fsync called for order/fill entries |
| SL003 | Corruption detected on read |
| SL004 | Recovery restores state from ledger |

---

## 7. Data Provider Adapter

### 7.1 Background

**Spec Reference**: Technical Spec §10.5
**Decision Reference**: B12 — Alpaca Data API for V1

Live trading requires real-time quote data for flatten protocol and position valuation.

**V1 Provider**: Alpaca Data API (included with Alpaca brokerage account)
**NOT in V1**: Polygon, Yahoo Finance, multi-provider failover (deferred to V1.1)

### 7.2 Interface

```typescript
interface DataProviderAdapter {
  // Connection
  connect(): Promise<void>;
  disconnect(): void;
  getConnectionStatus(): ConnectionStatus;

  // Quotes
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  getQuote(symbol: string): Quote | null;
  onQuote(callback: (quote: Quote) => void): Disposable;

  // Bars
  getBars(symbol: string, timeframe: string, start: Date, end: Date): Promise<Bar[]>;
  onBar(callback: (bar: Bar) => void): Disposable;

  // Staleness
  getQuoteAge(symbol: string): number;  // milliseconds
}

interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  timestamp: Date;
}
```

### 7.3 Staleness Detection

```python
class QuoteStalenessMonitor:
    STALE_THRESHOLD_MS = 30_000  # 30 seconds

    def check_quote(self, symbol: str) -> QuoteHealth:
        quote = self.provider.get_quote(symbol)

        if quote is None:
            return QuoteHealth.MISSING

        age_ms = (datetime.now() - quote.timestamp).total_seconds() * 1000

        if age_ms > self.STALE_THRESHOLD_MS:
            return QuoteHealth.STALE

        return QuoteHealth.FRESH
```

### 7.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| DataProviderAdapter interface | 1d | `extensions/quantlab/src/core/data/DataProviderAdapter.ts` (NEW) |
| **Alpaca adapter implementation** | 2d | `extensions/quantlab/src/core/data/AlpacaDataAdapter.ts` (NEW) |
| Quote staleness monitoring | 1d | `extensions/quantlab/src/core/data/staleness.ts` (NEW) |
| ~~Failover between providers~~ | — | **Deferred to V1.1** |
| Integration with flatten protocol | 1d | `extensions/quantlab/src/core/trading/flatten.ts` |

### 7.5 Testing Requirements

| Test ID | Description |
|---------|-------------|
| DP001 | Quote subscription works |
| DP002 | Staleness detected after 30s |
| ~~DP003~~ | ~~Failover to backup provider~~ — **Deferred** |
| DP004 | Flatten uses fresh quotes |

---

## 8. Trade Drift Detection [NEW]

### 8.1 Background

**Spec Reference**: Technical Spec §9.7

Statistical methodology for detecting whether live trading results differ significantly from backtest expectations.

### 8.2 Statistical Tests

| Test | Purpose | Threshold |
|------|---------|-----------|
| Two-proportion z-test | Win rate comparison | p < 0.05 |
| Welch's t-test | Mean return comparison | p < 0.05 |
| Bootstrap confidence interval | Sharpe ratio comparison | Non-overlapping 95% CI |

### 8.3 Implementation

```python
import numpy as np
from scipy import stats

class DriftDetector:
    def __init__(self, backtest_trades: List[Trade], live_trades: List[Trade]):
        self.backtest = backtest_trades
        self.live = live_trades

    def test_win_rate_drift(self) -> DriftResult:
        """Two-proportion z-test for win rate."""
        bt_wins = sum(1 for t in self.backtest if t.pnl > 0)
        bt_total = len(self.backtest)
        bt_rate = bt_wins / bt_total

        live_wins = sum(1 for t in self.live if t.pnl > 0)
        live_total = len(self.live)
        live_rate = live_wins / live_total

        # Pooled proportion
        pooled = (bt_wins + live_wins) / (bt_total + live_total)
        se = np.sqrt(pooled * (1 - pooled) * (1/bt_total + 1/live_total))

        z = (bt_rate - live_rate) / se
        p_value = 2 * (1 - stats.norm.cdf(abs(z)))

        return DriftResult(
            test='win_rate',
            backtest_value=bt_rate,
            live_value=live_rate,
            statistic=z,
            p_value=p_value,
            significant=p_value < 0.05
        )

    def test_mean_return_drift(self) -> DriftResult:
        """Welch's t-test for mean return."""
        bt_returns = [t.pnl_pct for t in self.backtest]
        live_returns = [t.pnl_pct for t in self.live]

        t_stat, p_value = stats.ttest_ind(bt_returns, live_returns, equal_var=False)

        return DriftResult(
            test='mean_return',
            backtest_value=np.mean(bt_returns),
            live_value=np.mean(live_returns),
            statistic=t_stat,
            p_value=p_value,
            significant=p_value < 0.05
        )
```

### 8.4 UI Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DRIFT ANALYSIS                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ Comparing: 250 backtest trades vs 47 live trades                            │
│                                                                              │
│ Metric          Backtest    Live       Drift    Status                      │
│ ─────────────────────────────────────────────────────────────────────────   │
│ Win Rate        62.4%       58.3%      -4.1%    ✓ No significant drift     │
│ Mean Return     0.85%       0.72%      -0.13%   ✓ No significant drift     │
│ Sharpe Ratio    1.8         1.5        -0.3     ⚠ Monitor closely          │
│                                                                              │
│ [View Details]  [Export Report]                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.5 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| DriftDetector class | 2d | `engine/metrics/drift.py` (NEW) |
| Win rate z-test | 0.5d | Same |
| Mean return t-test | 0.5d | Same |
| Bootstrap Sharpe comparison | 1d | Same |
| Drift analysis panel UI | 2d | `extensions/quantlab/src/panels/DriftPanel.ts` (NEW) |

### 8.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| DD001 | Z-test detects significant win rate drift |
| DD002 | T-test detects significant mean return drift |
| DD003 | Bootstrap CI correct for Sharpe |
| DD004 | No false positive on identical data |

---

## 9. Network Connectivity Handling (Decision N82)

### 9.1 Behavior by Duration

| Duration | Behavior |
|----------|----------|
| 0-30s | Retry connections, buffer signals |
| 30s-5min | Pause strategy, show warning |
| >5min | **Circuit breaker**, require manual intervention |

### 9.2 Implementation

```python
class NetworkMonitor:
    HEARTBEAT_INTERVAL_S = 5
    MISSED_HEARTBEATS_THRESHOLD = 3

    async def monitor_loop(self):
        missed = 0
        while True:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL_S)
            if await self.broker.heartbeat():
                missed = 0
            else:
                missed += 1
                if missed >= self.MISSED_HEARTBEATS_THRESHOLD:
                    await self.handle_connection_lost()

    async def reconnect_with_backoff(self):
        delays = [1, 2, 4, 8, 16, 30]  # Exponential backoff, max 30s
        for delay in delays:
            if await self.broker.connect():
                return True
            await asyncio.sleep(delay)
        return False  # Trigger circuit breaker
```

### 9.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| NetworkMonitor class | 1d | `engine/daemon/network.py` (NEW) |
| Heartbeat implementation | 0.5d | Same |
| Reconnection with backoff | 0.5d | Same |
| Circuit breaker trigger | 0.5d | `engine/daemon/circuit.py` |
| Connection status UI | 0.5d | `extensions/quantlab/src/ui/ConnectionStatus.ts` |

---

## 10. Sleep/Wake Handling (Decision N81)

### 10.1 Sequence

```
Sleep detected (OS event)
    │
    ▼
Pause strategy (no new signals)
    │
    ▼
Close WebSocket connections gracefully
    │
    ▼
Write checkpoint state
    │
    ▼
[System sleeps]
    │
    ▼
Wake detected
    │
    ▼
Reconnect to broker (with retry)
    │
    ▼
Reconcile positions with broker
    │
    ▼
Resume strategy (if market open)
```

### 10.2 Risk

Orders submitted just before sleep may be in unknown state. On wake, **reconcile before resuming**.

### 10.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| OS sleep/wake event detection | 1d | `engine/daemon/power.py` |
| Checkpoint on sleep | 0.5d | `engine/daemon/checkpoint.py` |
| Reconcile on wake | 1d | `engine/daemon/recovery.py` |

---

## 11. Auto-Update Protection (Decision C16)

### 11.1 Belt and Suspenders Approach

1. **Update system** checks for active daemon before downloading
2. **Daemon** refuses to allow update signal when session active
3. **UI** shows clear message explaining why update is blocked

### 11.2 Paper vs Live

| Mode | Update Behavior |
|------|-----------------|
| Live trading | **Blocked** until session ends |
| Paper trading | Warning only, update allowed |

### 11.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Daemon update lock | 0.5d | `engine/daemon/main.py` |
| Update system check | 0.5d | `extensions/quantlab/src/core/update.ts` |
| Update blocked dialog | 0.5d | `extensions/quantlab/src/ui/UpdateBlockedDialog.ts` (NEW) |

---

## 12. Concurrent Live Session Limit (Decision N95)

### 12.1 Configuration

- **Hard limit**: Maximum 3 concurrent live sessions (V1)
- **Constraint**: Same broker account can only be used by one session

### 12.2 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Session count enforcement | 0.5d | `engine/daemon/main.py` |
| Broker account uniqueness check | 0.5d | Same |
| Session limit exceeded dialog | 0.5d | `extensions/quantlab/src/ui/SessionLimitDialog.ts` (NEW) |

---

## Phase 4 Deliverables Checklist

### Week 19-20
- [ ] Emergency flatten protocol complete
- [ ] Quote validation working
- [ ] Kill switch dialog UI
- [ ] Out-of-hours handling
- [ ] Network connectivity handling

### Week 21-22
- [ ] Position reconciliation dialog
- [ ] Discrepancy diagnosis
- [ ] Broker disconnect handling
- [ ] Circuit breaker integration
- [ ] Sleep/wake handling

### Week 23-24
- [ ] Tamper-evident audit log (7-year retention)
- [ ] Log verification
- [ ] Fill reconciliation
- [ ] Session ledger with recovery
- [ ] Alpaca data adapter
- [ ] Trade drift detection
- [ ] Drift analysis panel UI
- [ ] Auto-update protection
- [ ] Session limit enforcement
- [ ] All live trading tests passing
- [ ] **Gate: L001-L070 100% pass**

---

## Testing Requirements Summary

### Live Trading Tests (Spec-Defined L-Series)

| Test Suite | IDs | Count | Must Pass |
|------------|-----|-------|-----------|
| Paper Trading | L001-L010 | 10 | ALL |
| Live Trading Safety | L020-L030 | 11 | ALL |
| Live Trading Failure | L040-L050 | 11 | ALL |
| Emergency Flatten | L060-L070 | 11 | ALL |

**L-Series Total**: 43 tests

### Phase 4 Implementation Tests (Additional)

| Test Suite | Count | Must Pass |
|------------|-------|-----------|
| Position Reconciliation (PR001-PR004) | 4 | ALL |
| Broker Disconnect (BD001-BD004) | 4 | ALL |
| Audit Log (AL001-AL005) | 5 | ALL |
| Fill Reconciliation (FR001-FR004) | 4 | ALL |
| Session Ledger (SL001-SL004) | 4 | ALL |
| Data Provider (DP001-DP003) | 3 | ALL |
| Drift Detection (DD001-DD004) | 4 | ALL |
| Network Connectivity (NC001-NC003) | 3 | ALL |
| Sleep/Wake (SW001-SW002) | 2 | ALL |

**Implementation Tests Total**: 33 tests

**Phase 4 Grand Total**: 76 tests (43 L-series + 33 implementation)

**Phase Gate**: L001-L070 must pass 100% before proceeding to Phase 5

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Flatten fails during network issue | Medium | HIGH | Multiple retry attempts, market fallback |
| Reconciliation wrong diagnosis | Low | Medium | Conservative "unknown" default |
| Audit log corruption | Low | HIGH | Hash verification, rotation |
| Fill processing race condition | Medium | Medium | Idempotency, sequence numbers |

---

## Dependencies

### Phase Dependencies
- Phase 1: Daemon architecture (for flatten integration)
- Phase 2: Order execution (for fill handling)
- Phase 3: Pre-trade checklist (for circuit breaker UI)

### External Dependencies
- Broker API (fill streaming)
- Market data (quote validation)

---

*Phase 4 completion means Quantlab is ready for production live trading (with thorough testing in Phase 5).*
