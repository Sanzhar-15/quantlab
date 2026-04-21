# Files to Create - Complete List

**Total New Files**: ~95
**Total Files to Modify**: ~15

---

## Python Engine Files

### daemon/
```
engine/quantlab/daemon/flatten.py          # Emergency flatten protocol
engine/quantlab/daemon/network.py          # Network connectivity monitor
engine/quantlab/daemon/recovery.py         # Recovery from ledger
```

### ledger/
```
engine/quantlab/ledger/__init__.py         # Module init
engine/quantlab/ledger/session.py          # Session ledger class
engine/quantlab/ledger/entry.py            # Ledger entry types
```

### debug/
```
engine/quantlab/debug/format.py            # Arrow IPC debug file format
engine/quantlab/debug/index.py             # Debug file index
engine/quantlab/debug/mmap.py              # Memory-mapped reader
engine/quantlab/debug/capture.py           # Bar state capture
engine/quantlab/debug/conditions.py        # Condition capture
```

### export/
```
engine/quantlab/export/__init__.py         # Module init
engine/quantlab/export/json.py             # JSON export schema
engine/quantlab/export/csv.py              # CSV export
engine/quantlab/export/html.py             # HTML report generator
```

### metrics/
```
engine/quantlab/metrics/drift.py           # Trade drift detection
```

---

## TypeScript Extension Files

### core/trading/
```
extensions/quantlab/src/core/trading/flatten.ts         # Flatten protocol
extensions/quantlab/src/core/trading/quote.ts           # Quote validation
extensions/quantlab/src/core/trading/marketHours.ts     # Market hours detection
extensions/quantlab/src/core/trading/reconcile.ts       # Position reconciliation
extensions/quantlab/src/core/trading/fills.ts           # Fill reconciliation
extensions/quantlab/src/core/trading/offline.ts         # Offline mode handling
extensions/quantlab/src/core/trading/checklist.ts       # Checklist data model
extensions/quantlab/src/core/trading/StrategyWatcher.ts # Hot-reload watcher
```

### core/trading/checks/
```
extensions/quantlab/src/core/trading/checks/broker.ts       # Broker connection
extensions/quantlab/src/core/trading/checks/credentials.ts  # API credentials
extensions/quantlab/src/core/trading/checks/buyingPower.ts  # Buying power
extensions/quantlab/src/core/trading/checks/dataFeed.ts     # Data feed
extensions/quantlab/src/core/trading/checks/marketStatus.ts # Market status
extensions/quantlab/src/core/trading/checks/riskLimits.ts   # Risk limits
extensions/quantlab/src/core/trading/checks/strategyTrust.ts # Strategy trust
extensions/quantlab/src/core/trading/checks/extensions.ts   # Extensions review
extensions/quantlab/src/core/trading/checks/lookAhead.ts    # Look-ahead warning
```

### core/trust/
```
extensions/quantlab/src/core/trust/store.ts       # Trust storage
extensions/quantlab/src/core/trust/hash.ts        # Strategy hash computation
extensions/quantlab/src/core/trust/extensions.ts  # Extension trust tracking
extensions/quantlab/src/core/trust/watcher.ts     # File watcher for revocation
```

### core/broker/
```
extensions/quantlab/src/core/broker/reconnect.ts  # Exponential backoff retry
```

### core/data/
```
extensions/quantlab/src/core/data/DataProviderAdapter.ts  # Data provider interface
extensions/quantlab/src/core/data/AlpacaDataAdapter.ts    # Alpaca data adapter
extensions/quantlab/src/core/data/staleness.ts            # Quote staleness monitor
```

### core/storage/
```
extensions/quantlab/src/core/storage/disk.ts      # Disk space monitor
```

### core/state/
```
extensions/quantlab/src/core/state/firstRun.ts    # First-run detection
```

### ui/
```
extensions/quantlab/src/ui/SystemTray.ts          # System tray integration
extensions/quantlab/src/ui/RecoveryDialog.ts      # Recovery dialog
extensions/quantlab/src/ui/SessionStatus.ts       # Session status bar
extensions/quantlab/src/ui/MarketStatus.ts        # Out-of-hours warning
extensions/quantlab/src/ui/TrustDialog.ts         # Trust dialog
extensions/quantlab/src/ui/KillSwitchDialog.ts    # Kill switch dialog
extensions/quantlab/src/ui/ReconcileDialog.ts     # Reconciliation dialog
extensions/quantlab/src/ui/BrokerStatus.ts        # Broker status indicator
extensions/quantlab/src/ui/ConnectionStatus.ts    # Connection status
extensions/quantlab/src/ui/DiskCleanupDialog.ts   # Disk cleanup dialog
extensions/quantlab/src/ui/HotReloadDialog.ts     # Hot-reload dialog
extensions/quantlab/src/ui/RiskWizard.ts          # Risk wizard
extensions/quantlab/src/ui/UpdateBlockedDialog.ts # Update blocked dialog
extensions/quantlab/src/ui/SessionLimitDialog.ts  # Session limit dialog
extensions/quantlab/src/ui/MigrationWizard.ts     # Migration wizard
```

### ai/
```
extensions/quantlab/src/ai/sanitize.ts     # Input sanitization
extensions/quantlab/src/ai/consent.ts      # Consent tracking
extensions/quantlab/src/ai/audit.ts        # AI audit logging
extensions/quantlab/src/ai/provider.ts     # Anthropic integration
extensions/quantlab/src/ai/context.ts      # Context builder
```

### panels/
```
extensions/quantlab/src/panels/AIPanelProvider.ts   # AI panel view
extensions/quantlab/src/panels/DriftPanel.ts        # Drift analysis panel
extensions/quantlab/src/panels/AuditLogPanel.ts     # Audit log viewer
```

### commands/
```
extensions/quantlab/src/commands/export.ts   # Export command
extensions/quantlab/src/commands/backup.ts   # Backup/import commands
```

### views/chart/
```
extensions/quantlab/src/views/chart/CodeSync.ts  # Code highlighting sync
```

### webview/
```
extensions/quantlab/webview/chart/debugger.ts     # Debugger controls
extensions/quantlab/webview/chart/statePanel.ts   # State panel
extensions/quantlab/webview/chart/navigation.ts   # Trade jump navigation
extensions/quantlab/webview/trade/killswitch.ts   # Kill switch dropdown
extensions/quantlab/webview/ai/panel.ts           # AI panel response display
```

---

## Test Files

### tests/golden/
```
tests/golden/vectors/G001_buy_and_hold.json
tests/golden/vectors/G002_single_trade.json
tests/golden/vectors/G003_sma_crossover.json
... (88 total vectors)
tests/golden/data.py       # Synthetic data generators
tests/golden/compare.py    # Tolerance comparison logic
tests/golden/update.py     # Golden update workflow
```

### tests/live/
```
tests/live/__init__.py
tests/live/harness.py      # Live test harness
tests/live/mock_broker.py  # Mock broker for tests
tests/live/paper.py        # Paper trading tests (L001-L010)
tests/live/safety.py       # Safety tests (L020-L030)
tests/live/failure.py      # Failure/chaos tests (L040-L050)
tests/live/flatten.py      # Flatten tests (L060-L070)
```

### tests/security/
```
tests/security/__init__.py
tests/security/secrets.py  # Secrets redaction tests
tests/security/sandbox.py  # Sandbox tests
tests/security/trust.py    # Trust model tests
tests/security/paths.py    # Path traversal tests
tests/security/ai.py       # AI panel security tests
```

### tests/perf/
```
tests/perf/__init__.py
tests/perf/ui.py           # UI responsiveness
tests/perf/live.py         # Live latency
tests/perf/debug.py        # Debug file performance
tests/perf/profile.py      # Profiling integration
tests/perf/report.py       # Regression reports
```

---

## Documentation Files

```
docs/getting-started.md
docs/risk.md
docs/troubleshooting.md
docs/faq.md
docs/architecture.md
docs/deployment.md
docs/api/strategy.md
docs/api/indicators.md
docs/api/orders.md
docs/api/risk.md
docs/runbooks/p1.md
docs/runbooks/rollback.md
```

---

## CI/CD Files

```
.github/workflows/golden.yml    # Golden test CI
.github/workflows/live.yml      # Live test CI (mock)
.github/workflows/security.yml  # Security tests
.github/workflows/perf.yml      # Performance benchmarks
scripts/sign.sh                 # Code signing
scripts/notarize.sh             # macOS notarization
scripts/manifest.py             # Update manifest generation
```

---

## Files to Modify

### Python
```
engine/quantlab/daemon/main.py         # Flatten integration, network, session limit
engine/quantlab/daemon/checkpoint.py   # Ledger integration
engine/quantlab/risk/circuit_breaker.py # Network trigger
```

### TypeScript
```
extensions/quantlab/src/core/trading/SessionManager.ts  # Multiple integrations
extensions/quantlab/src/core/trading/DaemonClient.ts    # Reconnect, reconciliation
extensions/quantlab/src/core/broker/BrokerAdapter.ts    # Fill reconciliation
extensions/quantlab/src/ui/dialogs/PreTradeChecklist.ts # Individual checks
extensions/quantlab/src/ui/menus/KillSwitchMenu.ts      # Flatten integration
extensions/quantlab/src/views/chart/ChartViewProvider.ts # Debugger
extensions/quantlab/src/views/trade/TradeViewProvider.ts # Real-time updates
```

---

## Summary

| Category | New Files | Modify |
|----------|-----------|--------|
| Python Engine | 15 | 3 |
| TypeScript Extension | 52 | 7 |
| Tests | 20+ | 0 |
| Documentation | 12 | 0 |
| CI/CD | 6 | 0 |
| **Total** | **~105** | **~10** |
