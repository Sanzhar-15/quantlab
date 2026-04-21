# Estimated Effort by Component

**Assumptions**:
- 1 day = 8 hours of focused development
- Includes unit tests for each component
- Does NOT include integration testing time (add 20%)
- Estimates are for experienced developer familiar with codebase

---

## Summary by Phase

| Phase | Estimated Effort | Current Completion |
|-------|------------------|-------------------|
| Phase 3: UI & Safety | 63 days | ~20% |
| Phase 4: Live Trading | 53 days | ~25% |
| Phase 5: Testing & Release | 55 days | ~5% |
| **TOTAL REMAINING** | **~171 days** | |

With 20% buffer for integration: **~205 days**

---

## Phase 3: UI & Safety Systems

### Pre-Trade Checklist
| Component | File | Effort |
|-----------|------|--------|
| Broker connection check | `checks/broker.ts` | 0.5d |
| API credentials check | `checks/credentials.ts` | 0.5d |
| Buying power check | `checks/buyingPower.ts` | 0.5d |
| Data feed check | `checks/dataFeed.ts` | 0.5d |
| Market status check | `checks/marketStatus.ts` | 0.5d |
| Risk limits check | `checks/riskLimits.ts` | 0.5d |
| Strategy trust check | `checks/strategyTrust.ts` | 0.5d |
| Extensions review check | `checks/extensions.ts` | 0.5d |
| Look-ahead warning check | `checks/lookAhead.ts` | 0.5d |
| Checklist data model | `checklist.ts` | 1d |
| SessionManager integration | Update existing | 1d |
| **Subtotal** | | **6d** |

### Time-Travel Debugger
| Component | File | Effort |
|-----------|------|--------|
| Debug file format (Arrow) | `debug/format.py` | 3d |
| Debug file index | `debug/index.py` | 2d |
| Memory-mapped reader | `debug/mmap.py` | 2d |
| Bar state capture | `debug/capture.py` | 3d |
| Condition capture | `debug/conditions.py` | 2d |
| Debugger controls UI | `webview/chart/debugger.ts` | 2d |
| State panel component | `webview/chart/statePanel.ts` | 2d |
| Code highlighting sync | `views/chart/CodeSync.ts` | 2d |
| Trade jump navigation | `webview/chart/navigation.ts` | 1d |
| **Subtotal** | | **19d** |

### Trust System
| Component | File | Effort |
|-----------|------|--------|
| Trust storage | `trust/store.ts` | 1d |
| Strategy hash computation | `trust/hash.ts` | 1d |
| Trust dialog UI | `ui/TrustDialog.ts` | 2d |
| Extension trust tracking | `trust/extensions.ts` | 2d |
| File watcher for revocation | `trust/watcher.ts` | 1d |
| SessionManager integration | Update existing | 1d |
| **Subtotal** | | **8d** |

### Live Session UI
| Component | File | Effort |
|-----------|------|--------|
| System tray integration | `ui/SystemTray.ts` | 2d |
| Tray icon states | Same | 1d |
| Recovery dialog UI | `ui/RecoveryDialog.ts` | 1d |
| Daemon detection on startup | Update `DaemonClient.ts` | 1d |
| Session status bar | `ui/SessionStatus.ts` | 1d |
| Out-of-hours warning | `ui/MarketStatus.ts` | 1d |
| **Subtotal** | | **7d** |

### AI Panel
| Component | File | Effort |
|-----------|------|--------|
| AI panel view | `panels/AIPanelProvider.ts` | 2d |
| Input sanitization | `ai/sanitize.ts` | 1d |
| Consent tracking | `ai/consent.ts` | 1d |
| Audit logging | `ai/audit.ts` | 1d |
| Anthropic integration | `ai/provider.ts` | 2d |
| Context builder | `ai/context.ts` | 2d |
| Response display | `webview/ai/panel.ts` | 1d |
| **Subtotal** | | **10d** |

### Report Export
| Component | File | Effort |
|-----------|------|--------|
| JSON export schema | `export/json.py` | 0.5d |
| CSV export | `export/csv.py` | 1d |
| HTML report generator | `export/html.py` | 2d |
| Export command UI | `commands/export.ts` | 1d |
| **Subtotal** | | **4.5d** |

### Miscellaneous Phase 3
| Component | Effort |
|-----------|--------|
| Disk space management | 1.5d |
| Backup/Migration export | 2.5d |
| Hot-reload dialog | 2.5d |
| First-run risk wizard | 2d |
| **Subtotal** | **8.5d** |

**Phase 3 Total: 63 days**

---

## Phase 4: Live Trading Polish

### Emergency Flatten Protocol
| Component | File | Effort |
|-----------|------|--------|
| Quote validation module | `trading/quote.ts` | 1d |
| Stage 1 (marketable limit) | `trading/flatten.ts` | 2d |
| Stage 2 (market fallback) | Same | 1d |
| Retry strategy | Same | 1d |
| Out-of-hours detection | `trading/marketHours.ts` | 1d |
| Kill switch dialog | `ui/KillSwitchDialog.ts` | 1d |
| Kill switch dropdown | `webview/trade/killswitch.ts` | 1d |
| Daemon integration | `daemon/flatten.py` | 1d |
| Flatten logging | Same | 0.5d |
| **Subtotal** | | **9.5d** |

### Position Reconciliation
| Component | File | Effort |
|-----------|------|--------|
| Reconciliation algorithm | `trading/reconcile.ts` | 2d |
| Discrepancy diagnosis | Same | 2d |
| Reconciliation dialog | `ui/ReconcileDialog.ts` | 2d |
| "Accept broker truth" | Same | 1d |
| "Investigate" action | Same | 0.5d |
| Reconnect integration | Update `DaemonClient.ts` | 1d |
| **Subtotal** | | **8.5d** |

### Broker Disconnect Handling
| Component | File | Effort |
|-----------|------|--------|
| Disconnect detection | `broker/BrokerAdapter.ts` | 1d |
| Exponential backoff | `broker/reconnect.ts` | 1d |
| Circuit breaker trigger | Same | 1d |
| Status indicator UI | `ui/BrokerStatus.ts` | 1d |
| Offline mode handling | `trading/offline.ts` | 1d |
| **Subtotal** | | **5d** |

### Fill Reconciliation
| Component | File | Effort |
|-----------|------|--------|
| FillReconciler class | `trading/fills.ts` | 2d |
| Idempotency tracking | Same | 1d |
| Out-of-order buffering | Same | 1d |
| Unknown order handling | Same | 1d |
| Broker adapter integration | Update existing | 1d |
| **Subtotal** | | **6d** |

### Session Ledger
| Component | File | Effort |
|-----------|------|--------|
| SessionLedger class | `ledger/session.py` | 2d |
| Entry serialization | Same | 1d |
| Write-ahead logging | Same | 1d |
| CRC32 corruption detection | Same | 1d |
| Recovery from ledger | `daemon/recovery.py` | 2d |
| **Subtotal** | | **7d** |

### Data Provider Adapter
| Component | File | Effort |
|-----------|------|--------|
| DataProviderAdapter interface | `data/DataProviderAdapter.ts` | 1d |
| Alpaca data adapter | `data/AlpacaDataAdapter.ts` | 2d |
| Quote staleness monitoring | `data/staleness.ts` | 1d |
| Flatten integration | Update flatten module | 1d |
| **Subtotal** | | **5d** |

### Trade Drift Detection
| Component | File | Effort |
|-----------|------|--------|
| DriftDetector class | `metrics/drift.py` | 2d |
| Win rate z-test | Same | 0.5d |
| Mean return t-test | Same | 0.5d |
| Bootstrap Sharpe comparison | Same | 1d |
| Drift analysis panel | `panels/DriftPanel.ts` | 2d |
| **Subtotal** | | **6d** |

### Miscellaneous Phase 4
| Component | Effort |
|-----------|--------|
| Network monitor | 3d |
| Auto-update protection | 1.5d |
| Concurrent session limit | 1.5d |
| **Subtotal** | **6d** |

**Phase 4 Total: 53 days**

---

## Phase 5: Testing & Release

### Golden Test Suite
| Component | File | Effort |
|-----------|------|--------|
| Generate 88 test vectors | `tests/golden/vectors/` | 3d |
| Synthetic data generators | `tests/golden/data.py` | 2d |
| Tolerance comparison | `tests/golden/compare.py` | 1d |
| CI integration | `.github/workflows/golden.yml` | 1d |
| Golden update workflow | `tests/golden/update.py` | 1d |
| **Subtotal** | | **8d** |

### Live Trading Tests
| Component | File | Effort |
|-----------|------|--------|
| Live test harness | `tests/live/harness.py` | 3d |
| Mock broker | `tests/live/mock_broker.py` | 2d |
| Paper trading tests | `tests/live/paper.py` | 2d |
| Safety tests | `tests/live/safety.py` | 2d |
| Failure/chaos tests | `tests/live/failure.py` | 3d |
| Flatten tests | `tests/live/flatten.py` | 2d |
| **Subtotal** | | **14d** |

### Performance Benchmarks
| Component | File | Effort |
|-----------|------|--------|
| UI responsiveness | `tests/perf/ui.py` | 1d |
| Live latency | `tests/perf/live.py` | 1d |
| Debug file performance | `tests/perf/debug.py` | 1d |
| Profiling integration | `tests/perf/profile.py` | 1d |
| Regression reports | `tests/perf/report.py` | 1d |
| **Subtotal** | | **5d** |

### Security Tests
| Component | File | Effort |
|-----------|------|--------|
| Secrets redaction | `tests/security/secrets.py` | 1d |
| Sandbox tests | `tests/security/sandbox.py` | 1d |
| Trust model tests | `tests/security/trust.py` | 1d |
| Path traversal | `tests/security/paths.py` | 0.5d |
| AI panel tests | `tests/security/ai.py` | 1d |
| **Subtotal** | | **4.5d** |

### Documentation
| Document | Effort |
|----------|--------|
| Getting Started Guide | 2d |
| Strategy API Reference | 3d |
| Risk Management Guide | 1d |
| Architecture Overview | 1d |
| P1 Runbook | 1d |
| Deployment Guide | 1d |
| Troubleshooting Guide | 1d |
| FAQ | 0.5d |
| **Subtotal** | **10.5d** |

### Release Preparation
| Component | Effort |
|-----------|--------|
| Build scripts verification | 1d |
| Code signing setup | 1d |
| macOS notarization | 1d |
| Update manifest generation | 1d |
| Staged rollout config | 0.5d |
| Monitoring dashboard | 1d |
| **Subtotal** | **5.5d** |

### Accessibility Audit
| Component | Effort |
|-----------|--------|
| Keyboard navigation audit | 1d |
| ARIA labels | 2d |
| Color-independent indicators | 1d |
| Focus indicator styles | 0.5d |
| Screen reader testing | 1d |
| External review | 2d |
| **Subtotal** | **7.5d** |

**Phase 5 Total: 55 days**

---

## Grand Total

| Category | Days |
|----------|------|
| Phase 3: UI & Safety | 63 |
| Phase 4: Live Trading | 53 |
| Phase 5: Testing & Release | 55 |
| **Subtotal** | **171** |
| Integration buffer (20%) | 34 |
| **Grand Total** | **205 days** |

---

## By Priority

| Priority | Components | Days |
|----------|------------|------|
| P0 (Live Trading Blockers) | Flatten, Ledger, Reconciliation, Network | 34 |
| P1 (Release Blockers) | Trust, Checks, Tests, Docs, Security | 46.5 |
| P2 (V1.0 Required) | Debugger, Data Adapter, Export, UI, A11y | 43 |
| P3 (Deferrable) | AI Panel, Drift, Disk, Backup, Hot-Reload, Wizard | 24.5 |
| Integration Buffer | 20% overhead | 30 |
| **Total** | | **178 days** |

---

## Timeline Scenarios

### Scenario A: 1 Developer
- P0: 7 weeks
- P1: 10 weeks
- P2: 9 weeks
- Buffer: 4 weeks
- **Total: 30 weeks (7.5 months)**

### Scenario B: 2 Developers
- P0 + P1 parallel: 10 weeks
- P2: 5 weeks
- Buffer: 3 weeks
- **Total: 18 weeks (4.5 months)**

### Scenario C: 3 Developers
- P0 + P1 + P2 parallel: 10 weeks
- Buffer: 2 weeks
- **Total: 12 weeks (3 months)**

### Scenario D: Minimum Beta (Paper Trading Only)
- Emergency Flatten: 2 weeks
- Session Ledger: 1.5 weeks
- Fill Reconciliation: 1.5 weeks
- 20 Golden Tests: 1 week
- Basic Docs: 1 week
- **Total: 7 weeks**

---

## Cost Estimation

Assuming $150/hour developer rate:

| Scenario | Days | Hours | Cost |
|----------|------|-------|------|
| Full V1.0 (1 dev) | 205 | 1,640 | $246,000 |
| Full V1.0 (2 devs) | 205 | 1,640 | $246,000 |
| Full V1.0 (3 devs) | 205 | 1,640 | $246,000 |
| Minimum Beta | 35 | 280 | $42,000 |
| P0 Only | 34 | 272 | $40,800 |
| P0 + P1 | 80.5 | 644 | $96,600 |

Note: Parallel development doesn't reduce total hours, only calendar time.
