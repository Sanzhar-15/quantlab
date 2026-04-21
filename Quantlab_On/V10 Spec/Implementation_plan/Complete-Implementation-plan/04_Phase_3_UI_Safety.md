# Phase 3: UI & Safety Systems

**Duration**: 7 weeks
**Priority**: HIGH - User-facing safety features
**Spec References**: Product Spec §2-5, §8, §10, §14; Technical Spec §18-20
**Decisions Reference**: G37-G43, H44-H49, H52, K64, N92-N94

---

## Objectives

This phase implements user-facing safety features and UI enhancements:

1. **Pre-Trade Validation Checklist** - Required checks before live trading
2. **Time-Travel Debugger** - Bar stepping, state inspection
3. **Workspace/Extension Trust** - Security model for live trading
4. **Live Session UI Behaviors** - Status display, reconnection
5. **AI Panel with Security** - Anthropic Claude default, pluggable (Decision G37)
6. **Pyright Integration** - Python type checking (bundled in Phase 0)
7. **Report Export** - HTML/CSV required, PDF optional (Decision K64)
8. **Accessibility** - WCAG 2.1 Level AA (Product Spec §13)
9. **Internationalization** - English only V1, i18n-ready (Decision N92)
10. **Disk Space Management** - Warn at 90%, block at 95% (Decision N93)
11. **Backup/Migration Export** - Settings and pinned run metadata (Decision N94)

---

## 1. Pre-Trade Validation Checklist

### 1.1 Background

**Spec Reference**: Product Spec §4.5

Before starting a live trading session, users must pass a validation checklist. This prevents common mistakes that could cause financial loss.

### 1.2 Validation Items

| Check | Blocking | Warning |
|-------|----------|---------|
| Broker connection alive | ✅ | |
| API credentials valid | ✅ | |
| Sufficient buying power | ✅ | |
| Data feed connected | ✅ | |
| Market open (or user override) | | ⚠️ |
| Risk limits configured | ✅ | |
| Strategy trusted | ✅ | |
| Extensions reviewed | ✅ | |
| No look-ahead warnings | | ⚠️ |
| No deprecated API warnings | | ⚠️ |

### 1.3 UI Design

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PRE-TRADE CHECKLIST                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ ✓ Broker Connection              Connected to Alpaca (paper)                │
│ ✓ API Credentials                Valid, expires in 89 days                  │
│ ✓ Buying Power                   $50,000 available                          │
│ ✓ Data Feed                      Alpaca connected, 50ms latency             │
│ ⚠ Market Status                  Market closed (opens in 2h 15m)            │
│ ✓ Risk Limits                    Daily loss: $1,000 | Max DD: 5%            │
│ ✓ Strategy Trust                 strategy.py trusted on 2024-01-20          │
│ ✓ Extensions                     3 extensions reviewed                      │
│ ⚠ Look-Ahead Detection           1 warning (line 45)                        │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ ☐ I understand this will trade real money (LIVE mode)                       │
│                                                                              │
│                                         [Cancel]  [Start Paper]  [Start Live]│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Checklist data model | 1d | `extensions/quantlab/src/core/trading/checklist.ts` (NEW) |
| Individual check implementations | 3d | `extensions/quantlab/src/core/trading/checks/` (NEW) |
| Checklist UI component (webview) | 2d | `extensions/quantlab/webview/trade/checklist.ts` (NEW) |
| Blocking vs warning logic | 1d | `extensions/quantlab/src/core/trading/checklist.ts` |
| Integration with session start | 1d | `extensions/quantlab/src/core/trading/SessionManager.ts` |
| Checklist bypass for paper mode | 0.5d | Same |

### 1.5 Individual Checks

```typescript
// checks/broker.ts
export async function checkBrokerConnection(adapter: BrokerAdapter): Promise<CheckResult> {
  try {
    const status = await adapter.getConnectionStatus();
    if (status === 'connected') {
      return { passed: true, message: `Connected to ${adapter.name}` };
    }
    return { passed: false, blocking: true, message: 'Broker not connected' };
  } catch (error) {
    return { passed: false, blocking: true, message: `Connection error: ${error}` };
  }
}

// checks/market.ts
export async function checkMarketStatus(calendar: Calendar): Promise<CheckResult> {
  const now = new Date();
  const isOpen = calendar.isMarketOpen(now);

  if (isOpen) {
    return { passed: true, message: 'Market is open' };
  }

  const nextOpen = calendar.getNextOpen(now);
  const timeUntil = formatDuration(nextOpen.getTime() - now.getTime());

  return {
    passed: true,  // Warning, not blocking
    warning: true,
    message: `Market closed (opens in ${timeUntil})`
  };
}
```

### 1.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| PC001 | All blocking checks prevent session start |
| PC002 | Warnings allow start with acknowledgment |
| PC003 | Paper mode skips some checks |
| PC004 | Live mode requires explicit checkbox |

---

## 2. Time-Travel Debugger

### 2.1 Background

**Spec Reference**: Product Spec §4.2, Technical Spec §19

The debugger enables step-through replay of backtest execution with full state inspection.

### 2.2 Debugger Features

| Feature | Description |
|---------|-------------|
| Bar stepping | Navigate forward/backward by bar |
| Trade jumping | Jump to bars with trades |
| State inspection | View portfolio, indicators, signals |
| Code highlighting | Show decision points in code |
| Bi-directional sync | Chart ↔ Code synchronization |

### 2.3 UI Components

```
┌────────────────────────────────────────────────────────────────────────────┐
│ DEBUGGER CONTROLS                                      Bar 127 of 252      │
├────────────────────────────────────────────────────────────────────────────┤
│ [|◄] [◄] [▌▌] [►] [►|]  [◄ Trade] [Trade ►]  [⟳ Reset]                    │
├────────────────────────────────────────────────────────────────────────────┤
│ STATE @ BAR 127 (2024-06-15 16:00)                                        │
│ ─────────────────────────────────────────────────────────────────────────  │
│ Position: 100 AAPL @ $185.50 avg                                          │
│ P&L: +$2,340.00 (+2.34%)                                                  │
│ Cash: $81,450.00                                                          │
│                                                                            │
│ INDICATORS                                                                 │
│ ─────────────────────────────────────────────────────────────────────────  │
│ fast_ma: 187.23                                                           │
│ slow_ma: 184.56                                                           │
│ rsi: 62.4                                                                 │
│                                                                            │
│ CONDITION @ LINE 23                                                        │
│ ─────────────────────────────────────────────────────────────────────────  │
│ fast_ma > slow_ma                                                         │
│    187.23 > 184.56 → TRUE                                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Debug file format with Arrow | 3d | `engine/debug/format.py` (NEW) |
| Debug file index for random access | 2d | `engine/debug/index.py` (NEW) |
| Memory-mapped file reader | 2d | `engine/debug/mmap.py` (NEW) |
| Debugger controls UI | 2d | `extensions/quantlab/webview/chart/debugger.ts` (NEW) |
| State panel component | 2d | Same |
| Code highlighting sync | 2d | `extensions/quantlab/src/views/chart/CodeSync.ts` (NEW) |
| Trade jump navigation | 1d | `extensions/quantlab/webview/chart/navigation.ts` (NEW) |
| Condition capture in engine | 3d | `engine/debug/capture.py` (NEW) |

### 2.5 Debug File Format

```
Debug File (Apache Arrow IPC format):
├── Header
│   ├── schema_version: "1.0"
│   ├── strategy_hash: string
│   └── bar_count: int
│
├── Bars Table
│   ├── bar_index: int
│   ├── timestamp: timestamp[us]
│   ├── open, high, low, close, volume: decimal
│   └── indicators: map<string, decimal>
│
├── Conditions Table
│   ├── bar_index: int
│   ├── line_number: int
│   ├── expression: string
│   ├── left_value: string
│   ├── right_value: string
│   └── result: bool
│
├── Signals Table
│   ├── bar_index: int
│   ├── signal_type: string
│   └── details: json
│
└── Portfolio Table
    ├── bar_index: int
    ├── cash: decimal
    ├── positions: json
    └── equity: decimal
```

### 2.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| DB001 | Jump to bar < 500ms for files under 1GB |
| DB002 | Jump to bar < 1000ms for files 1-4GB |
| DB003 | State render < 200ms |
| DB004 | Condition values captured correctly |
| DB005 | Code line numbers match source |

---

## 3. Workspace/Extension Trust

### 3.1 Background

**Spec Reference**: Product Spec §5.7

Live trading requires explicit trust of strategy code and extensions to prevent malicious execution.

### 3.2 Trust Model (Decisions H44, H45, H46)

| Entity | Trust Requirement | Revocation | Decision |
|--------|-------------------|------------|----------|
| Strategy file | Hash-based trust | Strategy file edit only | H46 |
| Workspace | Per-workspace trust | Strategy file change only (not any file) | H44, H46 |
| Extensions | Review required | Minor OR Major update (patch retains) | H45 |

### 3.3 Trust Flow

```
User opens live trading
        │
        ▼
Check workspace trust
        │
        ├─── Not trusted → Show trust dialog
        │                        │
        │                        ▼
        │                  [Review Code]
        │                        │
        │                        ▼
        │                  [Trust Workspace]
        │                        │
        └──────── ← ─────────────┘
        │
        ▼
Check strategy hash
        │
        ├─── Hash changed → Revoke trust, re-prompt
        │
        └─── Hash matches → Proceed
        │
        ▼
Check extensions
        │
        ├─── Untrusted extensions → Block with list
        │
        └─── All trusted → Proceed to checklist
```

### 3.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Trust storage (per-workspace only, H44) | 1d | `extensions/quantlab/src/core/trust/store.ts` (NEW) |
| Strategy hash computation | 1d | `extensions/quantlab/src/core/trust/hash.ts` (NEW) |
| Trust dialog UI | 2d | `extensions/quantlab/src/ui/TrustDialog.ts` (NEW) |
| Extension trust tracking | 2d | `extensions/quantlab/src/core/trust/extensions.ts` (NEW) |
| File watcher for trust revocation | 1d | `extensions/quantlab/src/core/trust/watcher.ts` (NEW) |
| Integration with session start | 1d | `extensions/quantlab/src/core/trading/SessionManager.ts` |

### 3.5 Trust Storage

```json
// .quantlab/trust.json
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

### 3.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| TR001 | Live trading blocked without trust |
| TR002 | Code edit revokes strategy trust |
| TR003 | Extension update prompts re-review |
| TR004 | Trust persists across sessions |

---

## 4. Live Session UI Behaviors

### 4.1 Background

**Spec Reference**: Product Spec §14

Live trading sessions need clear status display and robust reconnection handling.

### 4.2 System Tray Icon

| State | Icon | Tooltip |
|-------|------|---------|
| No session | Gray dot | "Quantlab - Idle" |
| Paper trading | Yellow dot | "Paper: strategy.py" |
| Live trading | Green pulsing dot | "LIVE: strategy.py (+$234)" |
| Paused | Orange dot | "PAUSED: strategy.py" |
| Error | Red dot | "ERROR: Check Quantlab" |

### 4.3 UI Reconnection Flow

```
UI Crash/Restart
        │
        ▼
Detect running daemon
        │
        ├─── No daemon → Normal startup
        │
        └─── Daemon found → Show recovery dialog
                                │
                                ▼
        ┌───────────────────────────────────────────────────┐
        │ ACTIVE SESSION DETECTED                            │
        │                                                    │
        │ A live trading session is running:                 │
        │ • Strategy: momentum_v2.py                         │
        │ • Started: 2024-01-20 09:30                        │
        │ • Positions: 3 open                                │
        │ • P&L: +$1,234.56                                  │
        │                                                    │
        │ [Reconnect to Session]  [View Only]  [Stop Session]│
        └───────────────────────────────────────────────────┘
```

### 4.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| System tray integration | 2d | `extensions/quantlab/src/ui/SystemTray.ts` (NEW) |
| Tray icon states and tooltips | 1d | Same |
| Recovery dialog UI | 1d | `extensions/quantlab/src/ui/RecoveryDialog.ts` (NEW) |
| Daemon detection on startup | 1d | `extensions/quantlab/src/core/trading/DaemonClient.ts` |
| Session status bar item | 1d | `extensions/quantlab/src/ui/SessionStatus.ts` (NEW) |
| Out-of-hours warning banner | 1d | `extensions/quantlab/src/ui/MarketStatus.ts` (NEW) |

### 4.5 Testing Requirements

| Test ID | Description |
|---------|-------------|
| LS001 | System tray shows correct state |
| LS002 | Recovery dialog appears on restart with active session |
| LS003 | Reconnect restores full UI state |
| LS004 | Out-of-hours banner shows when market closed |

---

## 5. AI Panel with Security

### 5.1 Background

**Spec Reference**: Technical Spec §20

The AI panel provides assistance but must protect sensitive data.

### 5.2 Input Sanitization

```typescript
const SENSITIVE_PATTERNS = [
  // Account identifiers
  /\b[A-Z0-9]{8,12}\b/g,                          // Account numbers
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,  // Card numbers

  // API keys
  /\b(APCA|pk_live|sk_live|api[_-]?key)[A-Za-z0-9_-]{10,}\b/gi,

  // Financial data
  /\$[\d,]+\.\d{2}\s*(profit|loss|p&l|balance)/gi,
];

function sanitizeInput(text: string): SanitizeResult {
  let sanitized = text;
  const warnings: string[] = [];

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
      warnings.push('Potentially sensitive data detected and redacted');
    }
  }

  return { sanitized, warnings, hadSensitiveData: warnings.length > 0 };
}
```

### 5.3 Data Categories

| Category | Sent to AI | Consent |
|----------|------------|---------|
| Strategy code | ✅ If user asks | Implicit |
| Error messages | ✅ If user asks | Implicit |
| Data samples | ⚠️ Opt-in | Explicit prompt |
| Broker credentials | ❌ NEVER | — |
| Trading history | ❌ NEVER | — |
| Personal data | ❌ NEVER | — |

### 5.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| AI panel view | 2d | `extensions/quantlab/src/panels/AIPanelProvider.ts` (NEW) |
| Input sanitization | 1d | `extensions/quantlab/src/ai/sanitize.ts` (NEW) |
| Consent tracking | 1d | `extensions/quantlab/src/ai/consent.ts` (NEW) |
| Audit logging | 1d | `extensions/quantlab/src/ai/audit.ts` (NEW) |
| API integration (Anthropic Claude only for V1, G37) | 2d | `extensions/quantlab/src/ai/provider.ts` (NEW) |
| Context builder | 2d | `extensions/quantlab/src/ai/context.ts` (NEW) |
| Response display | 1d | `extensions/quantlab/webview/ai/panel.ts` (NEW) |

### 5.5 Security Controls

| Control | Implementation |
|---------|---------------|
| Rate limiting | 100 requests/hour |
| Audit logging | All requests logged locally |
| Consent tracking | Per data type per session |
| Kill switch | User can disable in Settings |

### 5.6 Testing Requirements

| Test ID | Description |
|---------|-------------|
| AI001 | Account numbers redacted before send |
| AI002 | API keys redacted before send |
| AI003 | User warned when sensitive data detected |
| AI004 | Broker credentials never in request |
| AI005 | Audit log entry for every request |

---

## 6. Pyright Integration

### 6.1 Background

**Spec Reference**: Product Spec §2.3-2.4

V10 requires Pyright for Python type checking (replacing Pylance which isn't available on Open VSX).

**NOTE**: Pyright bundling is done in **Phase 0** as part of initial setup. This section covers the type stubs and configuration.

### 6.2 Feature Comparison

| Feature | Pylance | Pyright |
|---------|---------|---------|
| Type checking | ✅ | ✅ |
| Auto-imports | ✅ | ✅ |
| Docstrings | ✅ | ✅ |
| Inlay hints | ✅ | ✅ |
| Semantic tokens | ✅ | ✅ |
| Stub packages | ✅ | ✅ |
| **Auto-completion quality** | Better | Good |
| **Performance** | Better | Good |

### 6.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Bundle Pyright extension (Phase 0) | — | `extensions/quantlab/package.json` |
| Configure Pyright settings | 0.5d | Same |
| Quantlab-specific type stubs | 2d | `extensions/quantlab/typestubs/quantlab/` (NEW) |
| Documentation for users | 0.5d | — |

### 6.4 Type Stubs for Quantlab API

```python
# typestubs/quantlab/__init__.pyi
from typing import Callable, Any, TypeVar
from decimal import Decimal
import pandas as pd

T = TypeVar('T')

def param(
    name: str,
    default: T,
    min: T | None = None,
    max: T | None = None
) -> T: ...

def sma(data: pd.Series, period: int) -> pd.Series: ...
def ema(data: pd.Series, period: int) -> pd.Series: ...
def rsi(data: pd.Series, period: int = 14) -> pd.Series: ...

class Signals:
    def __init__(
        self,
        entry_long: pd.Series | None = None,
        exit_long: pd.Series | None = None,
        entry_short: pd.Series | None = None,
        exit_short: pd.Series | None = None
    ) -> None: ...

def signals(
    entry_long: pd.Series | None = None,
    exit_long: pd.Series | None = None,
    entry_short: pd.Series | None = None,
    exit_short: pd.Series | None = None
) -> Signals: ...
```

---

## 7. Accessibility Requirements [NEW]

### 7.1 Background

**Spec Reference**: Product Spec §13

Quantlab must meet WCAG 2.1 Level AA accessibility requirements.

### 7.2 Requirements

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | All interactive elements focusable |
| Screen reader support | ARIA labels on custom components |
| Color-independent encoding | Icons/shapes alongside colors |
| Focus indicators | Visible focus rings |
| Text scaling | Support 200% text zoom |

### 7.3 Color-Independent Indicators

```
Chart Indicators:
- Buy signal: Green ▲ (triangle up)
- Sell signal: Red ▼ (triangle down)
- Long position: Blue ■ (filled square)
- Short position: Orange □ (hollow square)

Tab Colors:
- Chart: Blue stripe + chart icon
- Action: Green stripe + play icon
- Trade: Orange stripe + dollar icon
```

### 7.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Keyboard navigation audit | 1d | All UI components |
| ARIA labels for custom components | 2d | Webview components |
| Color-independent chart indicators | 1d | Chart library |
| Focus indicator styles | 0.5d | CSS |
| Screen reader testing | 1d | — |

### 7.5 Testing Requirements

| Test ID | Description |
|---------|-------------|
| A11Y001 | All interactive elements keyboard accessible |
| A11Y002 | Screen reader announces state changes |
| A11Y003 | Buy/sell distinguishable without color |
| A11Y004 | 200% zoom doesn't break layout |

---

## 8. Report Export Schemas [NEW]

### 8.1 Background

**Spec Reference**: Technical Spec §17.4

Backtest results must be exportable in standardized formats.

### 8.2 Export Formats

| Format | Use Case | Schema |
|--------|----------|--------|
| JSON | Programmatic access | Full results |
| CSV | Spreadsheet analysis | Trades, metrics |
| HTML | Sharing/archival | Visual report |
| PDF | Compliance/printing | Visual report |

### 8.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| JSON export schema | 0.5d | `engine/export/json.py` (NEW) |
| CSV export (trades, metrics) | 1d | `engine/export/csv.py` (NEW) |
| HTML report generator | 2d | `engine/export/html.py` (NEW) |
| Export command UI | 1d | `extensions/quantlab/src/commands/export.ts` (NEW) |

---

## 9. Offline Mode Handling [NEW]

### 9.1 Background

**Spec Reference**: Product Spec, Technical Spec §20.4

App must function fully offline after initial setup.

### 9.2 Offline Behavior

| Feature | Online | Offline |
|---------|--------|---------|
| Backtesting | ✅ | ✅ (local data) |
| Live trading | ✅ | ❌ |
| AI Panel | ✅ | Shows "Offline" |
| Updates | ✅ | ❌ |
| Documentation | ✅ | ✅ (bundled) |

### 9.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Network status detection | 0.5d | `extensions/quantlab/src/core/network.ts` (NEW) |
| AI Panel offline message | 0.5d | `extensions/quantlab/src/panels/AIPanelProvider.ts` |
| Graceful degradation UI | 0.5d | Various UI components |

---

## 10. Internationalization (Decision N92)

### 10.1 V1 Approach

**English only for V1, i18n-ready architecture.**

### 10.2 Implementation Requirements

- All user-facing strings in resource files (no hardcoded)
- Date/number formatting respects locale
- UI layout handles text expansion (for future translations)
- V2+: Add translations

### 10.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Extract strings to resource files | 2d | All UI components |
| Locale-aware date formatting | 0.5d | `extensions/quantlab/src/utils/date.ts` |
| Locale-aware number formatting | 0.5d | `extensions/quantlab/src/utils/number.ts` |

---

## 11. Disk Space Management (Decision N93)

### 11.1 Thresholds

| Threshold | Action |
|-----------|--------|
| 90% | Toast warning |
| 95% | Block new backtests |
| 99% | Emergency cleanup prompt |

### 11.2 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Disk space monitor | 0.5d | `extensions/quantlab/src/core/storage/disk.ts` (NEW) |
| Warning/blocking logic | 0.5d | Same |
| Cleanup prompt dialog | 0.5d | `extensions/quantlab/src/ui/DiskCleanupDialog.ts` (NEW) |

---

## 12. Backup & Migration Export (Decision N94)

### 12.1 Exportable Items

| Item | Included |
|------|----------|
| Settings | ✅ |
| Keybindings | ✅ |
| Trusted workspaces | ✅ |
| Pinned run metadata | ✅ |
| Full artifacts | ❌ (too large) |
| Cache | ❌ |
| Debug files | ❌ (too large) |

### 12.2 Format

ZIP file with JSON contents

### 12.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Export command | 1d | `extensions/quantlab/src/commands/backup.ts` (NEW) |
| Import command | 1d | Same |
| Migration wizard UI | 0.5d | `extensions/quantlab/src/ui/MigrationWizard.ts` (NEW) |

---

## 13. Strategy Hot-Reload During Live Session (Decision H52)

### 13.1 Background

When a user modifies the strategy file during a live trading session, they must be prompted with options. This prevents accidental code changes from affecting live trading without explicit user consent.

### 13.2 Detection and UI Flow

```
Strategy file saved during live session
        │
        ▼
Toast notification: "Strategy modified during live session"
        │
        ▼
Modal dialog appears:
        │
        ├── [Pause Session] → Pause strategy, keep positions
        │
        ├── [Continue (Code Unchanged)] → Ignore file change, keep running old code
        │
        └── [Restart with New Code] → Stop session, revoke trust, require re-trust, restart
```

### 13.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| File watcher for strategy during live session | 1d | `extensions/quantlab/src/core/trading/StrategyWatcher.ts` (NEW) |
| Hot-reload dialog UI | 1d | `extensions/quantlab/src/ui/HotReloadDialog.ts` (NEW) |
| Integration with trust system | 0.5d | `extensions/quantlab/src/core/trust/` |
| Integration with session manager | 0.5d | `extensions/quantlab/src/core/trading/SessionManager.ts` |

### 13.4 Testing Requirements

| Test ID | Description |
|---------|-------------|
| HR001 | Strategy change during live session shows dialog |
| HR002 | "Pause Session" pauses without closing positions |
| HR003 | "Continue" ignores change and keeps running old code |
| HR004 | "Restart" revokes trust and requires re-trust |

---

## 14. First-Run Risk Configuration Wizard (Decision L74)

### 14.1 Background

New users must review and confirm risk limits before live trading. This wizard appears on first launch and ensures users consciously set their risk parameters.

### 14.2 Wizard Flow

```
First launch detection
        │
        ▼
Welcome screen with risk disclosure
        │
        ▼
Risk Limits Configuration:
┌──────────────────────────────────────────────────────────────┐
│ CONFIGURE YOUR RISK LIMITS                                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Daily Loss Limit:        [____2___] %  (1-10%, default 2%)   │
│ Maximum Drawdown:        [____5___] %  (2-20%, default 5%)   │
│ Consecutive Losses:      [____3___]    (2-10, default 3)     │
│ Max Gross Exposure:      [___100__] %  (50-100%, default 100%)│
│                                                              │
│ ⚠️ These limits will trigger automatic circuit breakers.     │
│ You can change them later in Settings > Trading > Risk.      │
│                                                              │
│                              [Use Defaults]  [Save & Continue]│
└──────────────────────────────────────────────────────────────┘
```

### 14.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| First-run detection | 0.5d | `extensions/quantlab/src/core/state/firstRun.ts` (NEW) |
| Risk wizard UI | 1d | `extensions/quantlab/src/ui/RiskWizard.ts` (NEW) |
| Wizard flow controller | 0.5d | `extensions/quantlab/src/ui/onboarding/` |
| Default values from L74 | 0.5d | Configuration schema |

### 14.4 Testing Requirements

| Test ID | Description |
|---------|-------------|
| RW001 | First launch shows risk wizard |
| RW002 | Risk limits are persisted |
| RW003 | "Use Defaults" applies L74 defaults |
| RW004 | Subsequent launches skip wizard |

---

## Phase 3 Deliverables Checklist

**Note**: Phase 3 overlaps with Phase 2 (W12-18), running in parallel with backend work.

### Week 12-13
- [ ] Pre-trade validation checklist UI complete
- [ ] All individual checks implemented
- [ ] Trust dialog and storage working

### Week 14-15
- [ ] Debug file format with Arrow
- [ ] Debugger controls in chart view
- [ ] State panel showing portfolio/indicators
- [ ] Code highlighting sync working

### Week 16-17
- [ ] System tray integration (with Linux fallback)
- [ ] Recovery dialog on startup
- [ ] AI panel with Anthropic integration
- [ ] All security tests passing

### Week 18
- [ ] Accessibility audit (keyboard, screen reader)
- [ ] i18n string extraction complete
- [ ] Disk space management
- [ ] Backup/migration export
- [ ] **Gate: Integration tests 70% UI coverage**

---

## Testing Requirements Summary

| Test Suite | Count | Must Pass |
|------------|-------|-----------|
| Pre-Trade Checklist | 4 | ALL |
| Debugger | 5 | ALL |
| Trust Model | 4 | ALL |
| Live Session UI | 4 | ALL |
| AI Panel Security | 5 | ALL |
| Accessibility (A11Y001-004) | 4 | ALL |
| Disk Space (DS001-003) | 3 | ALL |
| Backup/Migration (BM001-002) | 2 | ALL |
| Hot-Reload (HR001-004) | 4 | ALL |
| Risk Wizard (RW001-004) | 4 | ALL |

**Total**: 39 tests

**Phase Gate**: Integration tests 70% UI coverage required to proceed to Phase 4

---

## Dependencies

### Extension Dependencies
- `ms-python.pyright` - Type checking (bundled)

### UI Dependencies
- System tray API (Electron)
- Arrow IPC reader (JavaScript)

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Pyright performance issues | Low | Medium | Configurable diagnostics level |
| System tray not available | Low | Low | Fallback to status bar |
| AI API rate limits | Medium | Low | Local caching, backoff |
| Debug file too large | Medium | Medium | Sampling for >100K bars |

---

*Phase 3 can begin after Phase 2 core engine is feature-complete. Some UI work can parallel Phase 2.*
*Phase Gate: Integration tests 70% UI coverage required to proceed.*
