# Phase 4: Live Trading Polish - Gap Analysis

**Spec Reference**: `05_Phase_4_Live_Trading.md`
**Current Completion**: ~25%

---

## 1. Emergency Flatten Protocol

**Spec Section**: Phase 4, §1
**Status**: NOT IMPLEMENTED
**Priority**: P0 - CRITICAL

### What Exists
- `extensions/.../src/ui/menus/KillSwitchMenu.ts` - Basic menu structure

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Quote validation module | `extensions/.../src/core/trading/quote.ts` | 1d |
| Stage 1 (marketable limit) | `extensions/.../src/core/trading/flatten.ts` | 2d |
| Stage 2 (market fallback) | Same | 1d |
| Retry strategy with backoff | Same | 1d |
| Out-of-hours detection | `extensions/.../src/core/trading/marketHours.ts` | 1d |
| Kill switch dialog UI | `extensions/.../src/ui/KillSwitchDialog.ts` | 1d |
| Kill switch dropdown | `extensions/.../webview/trade/killswitch.ts` | 1d |
| Flatten logging | Same as flatten.ts | 0.5d |
| Daemon integration | `engine/quantlab/daemon/flatten.py` | 1d |

### Two-Stage Flatten Protocol
```
Stage 1: Marketable Limit IOC (2s timeout)
  - Calculate aggressive limit: bid - 2*spread (for sells)
  - If quote stale/missing → skip to Stage 2

Stage 2: Market Order (fallback)
  - Retry: 100ms, 500ms, 1s, 2s, 5s delays
  - Log all attempts
```

### Quote Validation
```python
class QuoteStatus(Enum):
    VALID = 'valid'
    MISSING = 'missing'
    STALE = 'stale'      # > 30s old
    INVALID = 'invalid'  # bid/ask <= 0
    WIDE = 'wide'        # spread > 10%
```

### Tests Required (L060-L070)
- L060: Flatten single long position
- L061: Flatten single short position
- L062: Flatten multiple positions
- L063: Flatten with stage 1 success
- L064: Flatten with stage 2 fallback
- L065: Flatten with stale quote → market immediately
- L066: Flatten with missing quote → market immediately
- L067: Flatten idempotency (no duplicate orders)
- L068: All flatten actions logged
- L069: Flatten completes within 10s
- L070: Type "FLATTEN" required for confirmation

---

## 2. Position Reconciliation

**Spec Section**: Phase 4, §2
**Status**: NOT IMPLEMENTED
**Priority**: P0 - CRITICAL

### What Exists
- `engine/quantlab/trading/reconciliation.py` - Basic Python reconciler
- Missing: TypeScript UI components

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Reconciliation algorithm (TS) | `extensions/.../src/core/trading/reconcile.ts` | 2d |
| Discrepancy diagnosis | Same | 2d |
| Reconciliation dialog UI | `extensions/.../src/ui/ReconcileDialog.ts` | 2d |
| "Accept broker truth" action | Same | 1d |
| "Investigate" action | Same | 0.5d |
| Integration with reconnect | Update `DaemonClient.ts` | 1d |

### Discrepancy Causes
```python
class DiscrepancyCause(Enum):
    MISSED_FILLS = 'missed_fills'
    CORPORATE_ACTION = 'corporate_action'  # Deferred to V1.1
    EXTERNAL_TRADE = 'external_trade'
    NETWORK_ISSUE = 'network_issue'
    UNKNOWN = 'unknown'
```

### Tests Required
- L046: Position mismatch shows dialog
- L047: "Accept broker truth" updates engine state
- L048: Missed fills diagnosed correctly

---

## 3. Broker Disconnect Handling

**Spec Section**: Phase 4, §3
**Status**: PARTIAL (Python done, TS missing)

### What Exists
- `engine/quantlab/daemon/main.py` - Broker reconnection with exponential backoff

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Disconnect detection (TS) | `extensions/.../src/core/broker/BrokerAdapter.ts` | 1d |
| Exponential backoff (TS) | `extensions/.../src/core/broker/reconnect.ts` | 1d |
| Circuit breaker trigger (TS) | Same | 1d |
| Status indicator UI | `extensions/.../src/ui/BrokerStatus.ts` | 1d |
| Offline mode handling | `extensions/.../src/core/trading/offline.ts` | 1d |

### Disconnect Thresholds
| Duration | Behavior |
|----------|----------|
| < 30s | Auto-reconnect, silent |
| 30s - 5min | Warning, continue retry |
| > 5min | Circuit breaker triggers |

### Tests Required
- L040: Disconnect < 30s auto-reconnects
- L041: Disconnect > 5min triggers circuit breaker
- CH-010: Auto-reconnect succeeds
- CH-011: Circuit breaker activates at threshold

---

## 4. Tamper-Evident Audit Log

**Spec Section**: Phase 4, §4
**Status**: IMPLEMENTED ✓

### What Exists
- `engine/quantlab/logging/audit.py` - Full implementation with hash chain

### Verification Needed
- [ ] 7-year retention policy enforced
- [ ] Log rotation preserves chain
- [ ] Export functionality

---

## 5. Fill Reconciliation

**Spec Section**: Phase 4, §5
**Status**: NOT IMPLEMENTED
**Priority**: P0 - CRITICAL

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| FillReconciler class | `extensions/.../src/core/trading/fills.ts` | 2d |
| Idempotency tracking | Same | 1d |
| Out-of-order buffering | Same | 1d |
| Unknown order handling | Same | 1d |
| Broker adapter integration | Update `BrokerAdapter.ts` | 1d |

### Fill Processing Logic
```typescript
class FillReconciler {
  private processedFills: Set<string> = new Set();
  private pendingFills: Map<string, Fill> = new Map();

  processFill(fill: Fill): boolean {
    // 1. Idempotency check
    if (this.processedFills.has(fill.fillId)) {
      return false; // Duplicate
    }

    // 2. Sequence check
    const order = this.orders.get(fill.orderId);
    if (order && fill.sequence !== order.expectedFillSequence) {
      this.pendingFills.set(fill.fillId, fill);
      return false; // Out of order
    }

    // 3. Apply fill
    this.applyFill(fill);
    this.processedFills.add(fill.fillId);
    return true;
  }
}
```

### Tests Required
- FR001: Duplicate fills ignored
- FR002: Out-of-order fills buffered
- FR003: Unknown order fills logged
- FR004: Fills applied correctly

---

## 6. Session Ledger

**Spec Section**: Phase 4, §6
**Status**: NOT IMPLEMENTED
**Priority**: P0 - CRITICAL

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| SessionLedger class | `engine/quantlab/ledger/session.py` | 2d |
| Entry serialization | Same | 1d |
| Write-ahead logging | Same | 1d |
| CRC32 corruption detection | Same | 1d |
| Recovery from ledger | `engine/quantlab/daemon/recovery.py` | 2d |

### Ledger Entry Types
```python
@dataclass
class LedgerEntry:
    entry_type: str  # session_start, bar, signal, order, fill, position_snapshot, error
    timestamp: datetime
    sequence: int
    data: dict
    crc32: int
```

### Durability Guarantees
| Guarantee | Requirement |
|-----------|-------------|
| Write-ahead | Entry written BEFORE action |
| Sync | fsync after OrderEntry and FillEntry |
| Corruption detection | CRC32 per entry |

### Tests Required
- SL001: Entry written before order sent
- SL002: fsync called for order/fill entries
- SL003: Corruption detected on read
- SL004: Recovery restores state from ledger

---

## 7. Data Provider Adapter (Alpaca)

**Spec Section**: Phase 4, §7
**Status**: NOT IMPLEMENTED

### What Exists
- `engine/quantlab/trading/alpaca.py` - Broker adapter (orders only)

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| DataProviderAdapter interface | `extensions/.../src/core/data/DataProviderAdapter.ts` | 1d |
| Alpaca data adapter | `extensions/.../src/core/data/AlpacaDataAdapter.ts` | 2d |
| Quote staleness monitoring | `extensions/.../src/core/data/staleness.ts` | 1d |
| Integration with flatten | Update flatten module | 1d |

### Interface
```typescript
interface DataProviderAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(symbols: string[]): void;
  getQuote(symbol: string): Quote | null;
  onQuote(callback: (quote: Quote) => void): Disposable;
  getQuoteAge(symbol: string): number;  // milliseconds
}
```

### Tests Required
- DP001: Quote subscription works
- DP002: Staleness detected after 30s
- DP004: Flatten uses fresh quotes

---

## 8. Trade Drift Detection

**Spec Section**: Phase 4, §8
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| DriftDetector class | `engine/quantlab/metrics/drift.py` | 2d |
| Win rate z-test | Same | 0.5d |
| Mean return t-test | Same | 0.5d |
| Bootstrap Sharpe comparison | Same | 1d |
| Drift analysis panel UI | `extensions/.../src/panels/DriftPanel.ts` | 2d |

### Statistical Tests
| Test | Purpose | Threshold |
|------|---------|-----------|
| Two-proportion z-test | Win rate comparison | p < 0.05 |
| Welch's t-test | Mean return comparison | p < 0.05 |
| Bootstrap CI | Sharpe ratio comparison | Non-overlapping 95% CI |

### Tests Required
- DD001: Z-test detects significant win rate drift
- DD002: T-test detects significant mean return drift
- DD003: Bootstrap CI correct for Sharpe
- DD004: No false positive on identical data

---

## 9. Network Connectivity Handling

**Spec Section**: Phase 4, §9
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| NetworkMonitor class | `engine/quantlab/daemon/network.py` | 1d |
| Heartbeat implementation | Same | 0.5d |
| Reconnection with backoff | Same | 0.5d |
| Circuit breaker trigger | Update `circuit_breaker.py` | 0.5d |
| Connection status UI | `extensions/.../src/ui/ConnectionStatus.ts` | 0.5d |

### Behavior by Duration
| Duration | Behavior |
|----------|----------|
| 0-30s | Retry connections, buffer signals |
| 30s-5min | Pause strategy, show warning |
| >5min | Circuit breaker, require manual intervention |

---

## 10. Sleep/Wake Handling

**Spec Section**: Phase 4, §10
**Status**: IMPLEMENTED ✓

### What Exists
- `engine/quantlab/daemon/power.py` - Sleep/wake detection

### Verification Needed
- [ ] Checkpoint written on sleep
- [ ] Reconcile on wake
- [ ] Resume strategy if market open

---

## 11. Auto-Update Protection

**Spec Section**: Phase 4, §11
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Daemon update lock | Update `daemon/main.py` | 0.5d |
| Update system check | `extensions/.../src/core/update.ts` | 0.5d |
| Update blocked dialog | `extensions/.../src/ui/UpdateBlockedDialog.ts` | 0.5d |

### Rules
| Mode | Update Behavior |
|------|-----------------|
| Live trading | BLOCKED until session ends |
| Paper trading | Warning only, update allowed |

---

## 12. Concurrent Session Limit

**Spec Section**: Phase 4, §12
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Session count enforcement | Update `daemon/main.py` | 0.5d |
| Broker account uniqueness | Same | 0.5d |
| Session limit dialog | `extensions/.../src/ui/SessionLimitDialog.ts` | 0.5d |

### Limits
- Maximum 3 concurrent live sessions
- Same broker account can only be used by one session

---

## Phase 4 Total Effort Estimate

| Category | Effort |
|----------|--------|
| Emergency Flatten | 9.5d |
| Position Reconciliation | 8.5d |
| Broker Disconnect | 5d |
| Fill Reconciliation | 6d |
| Session Ledger | 7d |
| Data Provider (Alpaca) | 5d |
| Trade Drift Detection | 6d |
| Network Connectivity | 3d |
| Auto-Update Protection | 1.5d |
| Concurrent Session Limit | 1.5d |
| **TOTAL** | **~53 days** |

---

## Phase 4 Test Requirements

| Test Suite | IDs | Count |
|------------|-----|-------|
| Paper Trading | L001-L010 | 10 |
| Live Safety | L020-L030 | 11 |
| Live Failure | L040-L050 | 11 |
| Emergency Flatten | L060-L070 | 11 |
| Position Reconciliation | PR001-PR004 | 4 |
| Broker Disconnect | BD001-BD004 | 4 |
| Fill Reconciliation | FR001-FR004 | 4 |
| Session Ledger | SL001-SL004 | 4 |
| Data Provider | DP001-DP004 | 4 |
| Drift Detection | DD001-DD004 | 4 |
| Network | NC001-NC003 | 3 |
| **TOTAL** | | **76 tests** |

---

## Critical Path for Live Trading

The following MUST be complete before any live trading:

1. **Emergency Flatten Protocol** - Cannot safely exit positions without this
2. **Session Ledger** - Cannot recover from crashes without this
3. **Fill Reconciliation** - State can become inconsistent without this
4. **Position Reconciliation** - Must handle broker/engine mismatches
5. **Network Monitor with Circuit Breaker** - Must handle connectivity issues

Estimated critical path effort: **~35 days**
