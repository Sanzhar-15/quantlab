# Phase 3: UI & Safety Systems - Gap Analysis

**Spec Reference**: `04_Phase_3_UI_Safety.md`
**Current Completion**: ~20%

---

## 1. Pre-Trade Validation Checklist

**Spec Section**: Phase 3, §1
**Status**: PARTIAL

### What Exists
- `extensions/quantlab/src/ui/dialogs/PreTradeChecklist.ts` - Basic dialog structure

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Broker connection check | `src/core/trading/checks/broker.ts` | 0.5d |
| API credentials check | `src/core/trading/checks/credentials.ts` | 0.5d |
| Buying power check | `src/core/trading/checks/buyingPower.ts` | 0.5d |
| Data feed check | `src/core/trading/checks/dataFeed.ts` | 0.5d |
| Market status check | `src/core/trading/checks/marketStatus.ts` | 0.5d |
| Risk limits check | `src/core/trading/checks/riskLimits.ts` | 0.5d |
| Strategy trust check | `src/core/trading/checks/strategyTrust.ts` | 0.5d |
| Extensions review check | `src/core/trading/checks/extensions.ts` | 0.5d |
| Look-ahead warning check | `src/core/trading/checks/lookAhead.ts` | 0.5d |
| Checklist data model | `src/core/trading/checklist.ts` | 1d |
| Integration with SessionManager | Update existing | 1d |

### Tests Required
- PC001: All blocking checks prevent session start
- PC002: Warnings allow start with acknowledgment
- PC003: Paper mode skips some checks
- PC004: Live mode requires explicit checkbox

---

## 2. Time-Travel Debugger

**Spec Section**: Phase 3, §2
**Status**: NOT IMPLEMENTED (stub only)

### What Exists
- `engine/quantlab/debug/__init__.py` - Empty stub with docstring

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Debug file format (Arrow IPC) | `engine/quantlab/debug/format.py` | 3d |
| Debug file index | `engine/quantlab/debug/index.py` | 2d |
| Memory-mapped file reader | `engine/quantlab/debug/mmap.py` | 2d |
| Bar state capture | `engine/quantlab/debug/capture.py` | 3d |
| Condition capture | `engine/quantlab/debug/conditions.py` | 2d |
| Debugger controls UI | `extensions/.../webview/chart/debugger.ts` | 2d |
| State panel component | `extensions/.../webview/chart/statePanel.ts` | 2d |
| Code highlighting sync | `extensions/.../src/views/chart/CodeSync.ts` | 2d |
| Trade jump navigation | `extensions/.../webview/chart/navigation.ts` | 1d |

### Debug File Schema (Required)
```
Debug File (Apache Arrow IPC):
├── Header (schema_version, strategy_hash, bar_count)
├── Bars Table (bar_index, timestamp, OHLCV, indicators)
├── Conditions Table (bar_index, line_number, expression, values, result)
├── Signals Table (bar_index, signal_type, details)
└── Portfolio Table (bar_index, cash, positions, equity)
```

### Tests Required
- DB001: Jump to bar < 500ms for files under 1GB
- DB002: Jump to bar < 1000ms for files 1-4GB
- DB003: State render < 200ms
- DB004: Condition values captured correctly
- DB005: Code line numbers match source

---

## 3. Workspace/Extension Trust

**Spec Section**: Phase 3, §3
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Trust storage | `extensions/.../src/core/trust/store.ts` | 1d |
| Strategy hash computation | `extensions/.../src/core/trust/hash.ts` | 1d |
| Trust dialog UI | `extensions/.../src/ui/TrustDialog.ts` | 2d |
| Extension trust tracking | `extensions/.../src/core/trust/extensions.ts` | 2d |
| File watcher for revocation | `extensions/.../src/core/trust/watcher.ts` | 1d |
| Integration with SessionManager | Update existing | 1d |

### Trust Storage Format
```json
{
  "workspaceTrusted": true,
  "trustedAt": "2024-01-20T10:00:00Z",
  "strategyHashes": {
    "strategy.py": "sha256:abc123..."
  },
  "trustedExtensions": [
    { "id": "ms-python.python", "version": "2024.1.0", "reviewedAt": "..." }
  ]
}
```

### Tests Required
- TR001: Live trading blocked without trust
- TR002: Code edit revokes strategy trust
- TR003: Extension update prompts re-review
- TR004: Trust persists across sessions

---

## 4. Live Session UI Behaviors

**Spec Section**: Phase 3, §4
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| System tray integration | `extensions/.../src/ui/SystemTray.ts` | 2d |
| Tray icon states | Same file | 1d |
| Recovery dialog UI | `extensions/.../src/ui/RecoveryDialog.ts` | 1d |
| Daemon detection on startup | Update `DaemonClient.ts` | 1d |
| Session status bar item | `extensions/.../src/ui/SessionStatus.ts` | 1d |
| Out-of-hours warning banner | `extensions/.../src/ui/MarketStatus.ts` | 1d |

### System Tray States
| State | Icon | Tooltip |
|-------|------|---------|
| No session | Gray dot | "Quantlab - Idle" |
| Paper trading | Yellow dot | "Paper: strategy.py" |
| Live trading | Green pulsing | "LIVE: strategy.py (+$234)" |
| Paused | Orange dot | "PAUSED: strategy.py" |
| Error | Red dot | "ERROR: Check Quantlab" |

### Tests Required
- LS001: System tray shows correct state
- LS002: Recovery dialog appears on restart with active session
- LS003: Reconnect restores full UI state
- LS004: Out-of-hours banner shows when market closed

---

## 5. AI Panel with Security

**Spec Section**: Phase 3, §5
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| AI panel view | `extensions/.../src/panels/AIPanelProvider.ts` | 2d |
| Input sanitization | `extensions/.../src/ai/sanitize.ts` | 1d |
| Consent tracking | `extensions/.../src/ai/consent.ts` | 1d |
| Audit logging | `extensions/.../src/ai/audit.ts` | 1d |
| Anthropic integration | `extensions/.../src/ai/provider.ts` | 2d |
| Context builder | `extensions/.../src/ai/context.ts` | 2d |
| Response display | `extensions/.../webview/ai/panel.ts` | 1d |

### Sensitive Patterns to Redact
```typescript
const SENSITIVE_PATTERNS = [
  /\b[A-Z0-9]{8,12}\b/g,                          // Account numbers
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,  // Card numbers
  /\b(APCA|pk_live|sk_live|api[_-]?key)[A-Za-z0-9_-]{10,}\b/gi,  // API keys
  /\$[\d,]+\.\d{2}\s*(profit|loss|p&l|balance)/gi,  // Financial data
];
```

### Tests Required
- AI001: Account numbers redacted before send
- AI002: API keys redacted before send
- AI003: User warned when sensitive data detected
- AI004: Broker credentials never in request
- AI005: Audit log entry for every request

---

## 6. Report Export Schemas

**Spec Section**: Phase 3, §8
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| JSON export schema | `engine/quantlab/export/json.py` | 0.5d |
| CSV export (trades, metrics) | `engine/quantlab/export/csv.py` | 1d |
| HTML report generator | `engine/quantlab/export/html.py` | 2d |
| Export command UI | `extensions/.../src/commands/export.ts` | 1d |

---

## 7. Additional Phase 3 Components

### Disk Space Management (§11)
| Component | File | Effort |
|-----------|------|--------|
| Disk space monitor | `extensions/.../src/core/storage/disk.ts` | 0.5d |
| Warning/blocking logic | Same | 0.5d |
| Cleanup dialog | `extensions/.../src/ui/DiskCleanupDialog.ts` | 0.5d |

### Backup/Migration Export (§12)
| Component | File | Effort |
|-----------|------|--------|
| Export command | `extensions/.../src/commands/backup.ts` | 1d |
| Import command | Same | 1d |
| Migration wizard | `extensions/.../src/ui/MigrationWizard.ts` | 0.5d |

### Strategy Hot-Reload (§13)
| Component | File | Effort |
|-----------|------|--------|
| Strategy file watcher | `extensions/.../src/core/trading/StrategyWatcher.ts` | 1d |
| Hot-reload dialog | `extensions/.../src/ui/HotReloadDialog.ts` | 1d |
| Trust integration | Update trust module | 0.5d |

### First-Run Risk Wizard (§14)
| Component | File | Effort |
|-----------|------|--------|
| First-run detection | `extensions/.../src/core/state/firstRun.ts` | 0.5d |
| Risk wizard UI | `extensions/.../src/ui/RiskWizard.ts` | 1d |
| Wizard flow controller | `extensions/.../src/ui/onboarding/` | 0.5d |

---

## Phase 3 Total Effort Estimate

| Category | Effort |
|----------|--------|
| Pre-Trade Checklist | 6d |
| Time-Travel Debugger | 19d |
| Trust System | 8d |
| Live Session UI | 7d |
| AI Panel | 10d |
| Report Export | 4.5d |
| Disk Space | 1.5d |
| Backup/Migration | 2.5d |
| Hot-Reload | 2.5d |
| Risk Wizard | 2d |
| **TOTAL** | **~63 days** |

---

## Phase 3 Test Requirements

| Test Suite | Count |
|------------|-------|
| Pre-Trade Checklist (PC001-PC004) | 4 |
| Debugger (DB001-DB005) | 5 |
| Trust Model (TR001-TR004) | 4 |
| Live Session UI (LS001-LS004) | 4 |
| AI Panel Security (AI001-AI005) | 5 |
| Hot-Reload (HR001-HR004) | 4 |
| Risk Wizard (RW001-RW004) | 4 |
| Accessibility (A11Y001-A11Y004) | 4 |
| Disk Space (DS001-DS003) | 3 |
| Backup/Migration (BM001-BM002) | 2 |
| **TOTAL** | **39 tests** |
