# Critical Path Priorities

**Purpose**: Define implementation order to reach minimum viable product (MVP) for live trading.

---

## Priority Levels

| Level | Definition | Timeline |
|-------|------------|----------|
| **P0** | Blocks all live trading | Must complete first |
| **P1** | Blocks production release | Must complete before release |
| **P2** | Required for V1.0 | Can be parallelized |
| **P3** | Nice to have | Can defer to V1.1 |

---

## P0: Live Trading Blockers

These components MUST be complete before ANY live trading is safe.

### 1. Emergency Flatten Protocol
**Effort**: 9.5 days
**Why P0**: Without this, users cannot safely exit positions in emergencies.

```
Files to create:
├── engine/quantlab/daemon/flatten.py
├── extensions/.../src/core/trading/flatten.ts
├── extensions/.../src/core/trading/quote.ts
├── extensions/.../src/core/trading/marketHours.ts
└── extensions/.../src/ui/KillSwitchDialog.ts
```

### 2. Session Ledger
**Effort**: 7 days
**Why P0**: Without write-ahead logging, crashes can cause state loss.

```
Files to create:
├── engine/quantlab/ledger/session.py
├── engine/quantlab/ledger/entry.py
└── engine/quantlab/daemon/recovery.py
```

### 3. Fill Reconciliation
**Effort**: 6 days
**Why P0**: Without idempotency, duplicate/out-of-order fills corrupt state.

```
Files to create:
└── extensions/.../src/core/trading/fills.ts
```

### 4. Position Reconciliation
**Effort**: 8.5 days
**Why P0**: Must handle broker/engine mismatches on reconnect.

```
Files to create:
├── extensions/.../src/core/trading/reconcile.ts
└── extensions/.../src/ui/ReconcileDialog.ts
```

### 5. Network Monitor + Circuit Breaker
**Effort**: 3 days
**Why P0**: Must detect and handle connectivity issues safely.

```
Files to create:
├── engine/quantlab/daemon/network.py
└── extensions/.../src/ui/ConnectionStatus.ts
```

**P0 Total Effort**: ~34 days

---

## P1: Production Release Blockers

These components MUST be complete before public release.

### 6. Trust System
**Effort**: 8 days
**Why P1**: Security requirement - must verify code before live execution.

```
Files to create:
├── extensions/.../src/core/trust/store.ts
├── extensions/.../src/core/trust/hash.ts
├── extensions/.../src/core/trust/extensions.ts
├── extensions/.../src/core/trust/watcher.ts
└── extensions/.../src/ui/TrustDialog.ts
```

### 7. Pre-Trade Checklist (Individual Checks)
**Effort**: 6 days
**Why P1**: Must validate broker/credentials/risk before live session.

```
Files to create:
├── extensions/.../src/core/trading/checks/broker.ts
├── extensions/.../src/core/trading/checks/credentials.ts
├── extensions/.../src/core/trading/checks/buyingPower.ts
├── extensions/.../src/core/trading/checks/dataFeed.ts
├── extensions/.../src/core/trading/checks/marketStatus.ts
├── extensions/.../src/core/trading/checks/riskLimits.ts
└── extensions/.../src/core/trading/checks/strategyTrust.ts
```

### 8. Golden Test Suite
**Effort**: 8 days
**Why P1**: Cannot verify backtest correctness without regression tests.

```
Files to create:
├── tests/golden/vectors/G001_buy_and_hold.json
├── tests/golden/vectors/G002_single_trade.json
├── ... (88 total vectors)
├── tests/golden/data.py
├── tests/golden/compare.py
└── .github/workflows/golden.yml
```

### 9. Live Trading Tests
**Effort**: 14 days
**Why P1**: Cannot verify live trading safety without tests.

```
Files to create:
├── tests/live/harness.py
├── tests/live/mock_broker.py
├── tests/live/paper.py
├── tests/live/safety.py
├── tests/live/failure.py
└── tests/live/flatten.py
```

### 10. Core Documentation
**Effort**: 6 days
**Why P1**: Users cannot onboard without documentation.

```
Files to create:
├── docs/getting-started.md
├── docs/api/strategy.md
├── docs/api/indicators.md
├── docs/risk.md
└── docs/runbooks/p1.md
```

### 11. Security Tests
**Effort**: 4.5 days
**Why P1**: Must verify secrets are protected.

```
Files to create:
├── tests/security/secrets.py
├── tests/security/sandbox.py
├── tests/security/trust.py
└── tests/security/paths.py
```

**P1 Total Effort**: ~46.5 days

---

## P2: V1.0 Required

These can be parallelized with P0/P1 work.

### 12. Time-Travel Debugger
**Effort**: 19 days
**Why P2**: Important for user experience but not safety-critical.

```
Files to create:
├── engine/quantlab/debug/format.py
├── engine/quantlab/debug/index.py
├── engine/quantlab/debug/mmap.py
├── engine/quantlab/debug/capture.py
├── extensions/.../webview/chart/debugger.ts
├── extensions/.../webview/chart/statePanel.ts
└── extensions/.../src/views/chart/CodeSync.ts
```

### 13. Alpaca Data Adapter
**Effort**: 5 days
**Why P2**: Needed for real-time quotes in flatten protocol.

```
Files to create:
├── extensions/.../src/core/data/DataProviderAdapter.ts
├── extensions/.../src/core/data/AlpacaDataAdapter.ts
└── extensions/.../src/core/data/staleness.ts
```

### 14. Report Export
**Effort**: 4.5 days
**Why P2**: Users need to export backtest results.

```
Files to create:
├── engine/quantlab/export/json.py
├── engine/quantlab/export/csv.py
├── engine/quantlab/export/html.py
└── extensions/.../src/commands/export.ts
```

### 15. Live Session UI
**Effort**: 7 days
**Why P2**: System tray and recovery dialog improve UX.

```
Files to create:
├── extensions/.../src/ui/SystemTray.ts
├── extensions/.../src/ui/RecoveryDialog.ts
├── extensions/.../src/ui/SessionStatus.ts
└── extensions/.../src/ui/MarketStatus.ts
```

### 16. Accessibility Audit
**Effort**: 7.5 days
**Why P2**: Compliance requirement.

**P2 Total Effort**: ~43 days

---

## P3: Deferrable to V1.1

### 17. AI Panel
**Effort**: 10 days
**Why P3**: Nice to have, not core functionality.

### 18. Trade Drift Detection
**Effort**: 6 days
**Why P3**: Useful but not required for initial release.

### 19. Disk Space Management
**Effort**: 1.5 days
**Why P3**: Edge case handling.

### 20. Backup/Migration Export
**Effort**: 2.5 days
**Why P3**: Users can manually backup.

### 21. Hot-Reload Dialog
**Effort**: 2.5 days
**Why P3**: Can just restart session.

### 22. First-Run Risk Wizard
**Effort**: 2 days
**Why P3**: Can use settings panel instead.

**P3 Total Effort**: ~24.5 days

---

## Implementation Phases

### Phase A: Safety Foundation (P0)
**Duration**: ~7 weeks
**Effort**: 34 days

```
Week 1-2: Emergency Flatten + Session Ledger
Week 3-4: Fill Reconciliation + Position Reconciliation
Week 5: Network Monitor + Circuit Breaker
Week 6-7: Integration testing, bug fixes
```

### Phase B: Release Readiness (P1)
**Duration**: ~9 weeks
**Effort**: 46.5 days

```
Week 1-2: Trust System
Week 3: Pre-Trade Checklist Checks
Week 4-5: Golden Test Vectors
Week 6-7: Live Trading Tests
Week 8: Documentation
Week 9: Security Tests
```

### Phase C: Polish (P2)
**Duration**: ~8 weeks
**Effort**: 43 days

```
Week 1-3: Time-Travel Debugger
Week 4: Alpaca Data Adapter
Week 5: Report Export
Week 6: Live Session UI
Week 7-8: Accessibility Audit
```

---

## Recommended Team Allocation

### If 1 Developer
```
Phase A → Phase B → Phase C → Release
Total: ~24 weeks (6 months)
```

### If 2 Developers
```
Dev 1: Phase A (P0) → Phase B Tests
Dev 2: Phase B Trust/Checks → Phase C
Total: ~14 weeks (3.5 months)
```

### If 3 Developers
```
Dev 1: Emergency Flatten + Session Ledger (P0)
Dev 2: Reconciliation + Network (P0) → Trust (P1)
Dev 3: Tests (P1) → Debugger (P2)
Total: ~10 weeks (2.5 months)
```

---

## Dependency Graph

```
                    ┌─────────────────┐
                    │ Session Ledger  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
    ┌─────────────┐ ┌───────────────┐ ┌──────────────┐
    │ Fill        │ │ Position      │ │ Emergency    │
    │ Reconciler  │ │ Reconciler    │ │ Flatten      │
    └──────┬──────┘ └───────┬───────┘ └──────┬───────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ Network Monitor│
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ Trust System   │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ Pre-Trade      │
                   │ Checklist      │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ Tests & Docs   │
                   └────────────────┘
```

---

## Risk Mitigation

### If Behind Schedule
1. **Defer P3 entirely** - Saves 24.5 days
2. **Simplify debugger** - Basic stepping only, save 10 days
3. **Minimal docs** - Getting started + API only, save 4 days
4. **Paper trading only** - Skip L020-L070, save 7 days

### Absolute Minimum for Beta
- Emergency flatten (P0)
- Session ledger (P0)
- Fill reconciliation (P0)
- 20 golden tests (subset)
- Getting started doc

**Minimum Beta Effort**: ~25 days
