# Quantlab Product Specification V10.5
## Complete User Interface & Experience Design

**Product**: Quantlab — Quantitative Trading Development Environment  
**Company**: Delta Plus  
**Version**: 10.5 FINAL  
**Date**: 2026-01-25  
**Status**: Approved for Implementation

---

## Document Control

### Canonical Document Set
| Document | Version | Audience | Status |
|----------|---------|----------|--------|
| **This Document** | V10.5 | Product, Design, Frontend | **CURRENT** |
| Technical Specification | V2.5 | Backend, Engine, QA | Current |
| Operations Specification | V1.3 | DevOps, Release, Support | Current |
| Test Specification | V1.2 | QA, Engineering | Current |
| Design System | V1.0 | Design, Frontend | Current |

### Changes from V10.4
| Section | Change | Severity |
|---------|--------|----------|
| §2.3 | **CRITICAL**: Replaced Pylance with Pyright | Breaking |
| §2.4 | NEW: Pyright vs Pylance feature comparison | Info |
| §4.5 | NEW: Pre-Trade Validation Checklist | High |
| §5.7 | NEW: Extension Trust Model | High |
| §12.1 | Added backup retention policy | Medium |
| §14 | NEW: Live Session UI Behaviors | Critical |

### Supersedes
All previous specifications are **ARCHIVED — DO NOT IMPLEMENT**:
- ~~Feature Specification V1.0~~
- ~~UX Specification V9.0~~
- ~~Product Specification V10.0 through V10.4~~

### Normative Language
- **MUST**: Absolute requirement
- **SHOULD**: May be omitted with documented reason
- **MAY**: Truly optional

---

## Table of Contents

1. Product Overview
2. Platform Foundation
3. Window Architecture
4. View System
5. Activity Bar Panels
6. History System
7. Data File Handling
8. Keyboard Shortcuts
9. Notifications & Errors
10. Onboarding
11. Regulatory Disclosures
12. Code Modification Safety
13. Accessibility Requirements
14. Live Session UI Behaviors
15. Non-Goals & Deferred

---

# §1. Product Overview

## 1.1 What Is Quantlab?

Quantlab is a specialized development environment for quantitative trading strategies, built on Visual Studio Code. It provides:

- **Strategy Development** — Write and validate trading strategies
- **Visualization** — Interactive charts with signal markers
- **Testing** — Backtest, optimize, stress-test
- **Execution** — Paper and live trading with safety controls
- **Reproducibility** — Full data and environment snapshots

## 1.2 Design Principles

| Principle | Description |
|-----------|-------------|
| Views, Not Modes | Each tab maintains independent view state |
| Navigation vs Work | Activity Bar for browsing, Editor Area for work |
| Progressive Disclosure | Complexity reveals as users demonstrate need |
| No VS Code Conflicts | All shortcuts use unique prefix |
| Graceful Degradation | Clear guidance when features can't work |

## 1.3 Supported Asset Classes (V1)

| Asset Class | Status |
|-------------|--------|
| US Equities | ✓ Supported |
| US ETFs | ✓ Supported |
| Crypto Spot | ✓ Supported |
| Options/Futures | ✗ V2 |
| Forex | ✗ V2 |

## 1.4 Scope Boundaries

### What Quantlab Does
- Strategy development with real-time validation
- Long AND short strategies (100% collateral model)
- Multiple order types (Market, Limit, Stop, Stop-Limit)
- Paper and live trading with safety controls
- Full reproducibility via pinned data snapshots

### What Quantlab Does NOT Do (V1)
- Leverage (100% collateral = no margin)
- Multi-broker sessions
- Team collaboration
- Tick-level simulation

---

# §2. Platform Foundation

## 2.1 VS Code Inheritance

| Feature | Status |
|---------|--------|
| Explorer | ✓ Unchanged |
| Source Control | ✓ Unchanged |
| Search | ✓ Unchanged |
| Terminal | ✓ Unchanged |
| Command Palette | ✓ Unchanged |
| Extensions | ✓ Via Open VSX |

## 2.2 Quantlab Additions

| Feature | Location |
|---------|----------|
| Data Panel | Activity Bar |
| Resources Panel | Activity Bar |
| History Panel | Activity Bar |
| Trade Panel | Activity Bar |
| Settings Panel | Activity Bar |
| View Buttons | Tab Bar (right) |
| Global Symbol/TF | Window Chrome |
| AI Panel | Secondary Sidebar |

## 2.3 Extension Ecosystem [CRITICAL REVISION]

**Source**: Open VSX Registry (NOT Microsoft Marketplace)

| Extension | Status | Notes |
|-----------|--------|-------|
| Python (Open VSX) | MUST bundle | `ms-python.python` equivalent |
| **Pyright** (Open VSX) | MUST bundle | Type checking + IntelliSense |
| Jupyter (Open VSX) | SHOULD bundle | Notebook support |

**⚠️ IMPORTANT**: Pylance is Microsoft-proprietary and **NOT available** on Open VSX.
Pyright provides equivalent type checking functionality with full open-source availability.

**Known Limitations**:
- GitHub Copilot: User installs separately (requires Microsoft account)
- Live Share: Not available (Microsoft-exclusive)
- Pylance: Not available (use Pyright instead)

**Fallback Strategy**:
| Extension | If Unavailable |
|-----------|----------------|
| Pyright | Bundle Pyright LSP directly in app |
| Python | Bundle minimal Python tooling |
| Jupyter | Disable notebook features, show message |

## 2.4 Pyright vs Pylance Feature Comparison [NEW]

Users should understand the tradeoffs of using Pyright instead of Pylance:

| Feature | Pylance | Pyright | User Impact |
|---------|---------|---------|-------------|
| Type checking | ✓ | ✓ | None |
| Hover information | ✓ | ✓ | None |
| Go to definition | ✓ | ✓ | None |
| Find references | ✓ | ✓ | None |
| Rename symbol | ✓ | ✓ | None |
| Code completion | ✓✓ | ✓ | Slightly less context-aware |
| Auto-imports | ✓✓ | ✓ | Less comprehensive suggestions |
| Semantic highlighting | ✓ | ✗ | No semantic token coloring |
| Inlay hints | ✓ | ✓ | None |
| Docstring generation | ✓ | ✗ | Manual docstrings only |

**User Impact Summary**: 
- Most type checking and navigation features work identically
- Auto-import suggestions may be less comprehensive
- No semantic highlighting (syntax highlighting still works normally)
- Advanced refactoring may require manual steps

**Recommendation**: These limitations are acceptable tradeoffs for Open VSX compliance and open-source licensing.

---

# §3. Window Architecture

## 3.1 Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ WINDOW CHROME                                                                │
│  File  Edit  View  Run  Help          [AAPL ▼][1D ▼]      [⏱ History ▼]    │
├─────────────────────────────────────────────────────────────────────────────┤
│ TAB BAR                                                                      │
│  ▌strategy.py × │                            [Chart] [Action] [Trade]       │
├───────┬─────────────────────────────────────────────────────────────┬───────┤
│       │                                                             │       │
│  A    │                      EDITOR AREA                            │  A    │
│  C    │                                                             │  I    │
│  T    │            (content determined by active view)              │       │
│  I    │                                                             │  P    │
│  V    │                                                             │  A    │
│  I    │                                                             │  N    │
│  T    ├─────────────────────────────────────────────────────────────┤  E    │
│  Y    │                      BOTTOM PANEL                           │  L    │
│       │  Output │ Terminal │ Problems │                             │       │
│  B    │                                                             │       │
│  A    │                                                             │       │
│  R    │                                                             │       │
└───────┴─────────────────────────────────────────────────────────────┴───────┘
```

## 3.2 Tab Indicator Stripes

| View | Color (Light/Dark) | Icon |
|------|-------------------|------|
| Editor | None | Standard file icon |
| Chart | Green (`#059669` / `#10B981`) | 📊 |
| Action | Orange (`#D97706` / `#F59E0B`) | ▶ |
| Trade | Red (`#DC2626` / `#EF4444`) | 💹 |

---

# §4. View System

## 4.1 Editor View

Standard code editing with quantitative validation:

| Check | Severity | Example |
|-------|----------|---------|
| Missing entry point | Error | No `strategy()` function |
| Look-ahead bias | Error | Using `data.close.shift(-1)` |
| Unused parameter | Info | `ql.param()` never referenced |
| Deprecated API | Warning | Using removed function |

## 4.2 Chart View

### Strategy Chart
- OHLCV candlesticks with configurable colors
- Signal markers (▲ entry, ▼ exit)
- Indicator overlays (up to 5)
- Equity curve (secondary axis)
- Volume bars (optional)

### Time-Travel Debugger

**Activation**: `[🕐 Debug]` button or `Cmd/Ctrl+Shift+K D`

**Controls**:
| Control | Action |
|---------|--------|
| `←` / `→` | Step backward/forward one bar |
| `Shift+←` / `Shift+→` | Step 10 bars |
| `Home` / `End` | Jump to start/end |
| Click chart | Jump to specific bar |
| `[Next Trade ►]` | Jump to next trade |
| `[◄ Prev Trade]` | Jump to previous trade |

**Debug Console** shows synchronized state:
```
STATE AT 2022-03-15 (Bar 542 of 2520)

MARKET DATA
├── open: 98.20 │ high: 99.45 │ low: 97.80 │ close: 99.10
└── volume: 14.2M

INDICATORS
├── fast_ma: 98.72
├── slow_ma: 97.15
└── rsi: 62.4

CONDITIONS EVALUATED                                    SOURCE
├── fast_ma > slow_ma → True                           [Line 23 ↗]
└── rsi < 70 → True                                    [Line 24 ↗]

SIGNAL: BUY (conditions met)

PORTFOLIO (after this bar)
├── Cash: $89,090 │ Position: LONG 100 AAPL
├── Equity: $99,000 │ P&L: -$1,000 (-1.0%)
└── Buying Power: $89,090
```

## 4.3 Action View

### Quick Actions
```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  Backtest  │  │  Optimize  │  │   Monte    │  │    WFA     │
│            │  │            │  │   Carlo    │  │            │
└────────────┘  └────────────┘  └────────────┘  └────────────┘
```

### Presets
| Preset | Slippage | Commission | Use Case |
|--------|----------|------------|----------|
| Default | volatility 0.1 | $0.005/share | Standard backtesting |
| Pessimistic | volatility 0.2 | $0.01/share | Stress testing |
| Clean Room | volatility 0.1 | $0.005/share | Verify no look-ahead |
| Zero Cost | none | none | Theoretical analysis |

## 4.4 Trade View

### Active Session Display
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LIVE TRADING — strategy.py                        [🔴 KILL SWITCH ▼]       │
├─────────────────────────────────────────────────────────────────────────────┤
│ SESSION                                                                      │
│ Mode: [● LIVE] │ Status: ● RUNNING │ Started: 2h 15m ago                   │
│ Engine: Daemon (PID 12345) │ Broker: Alpaca (45ms)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ PERFORMANCE                        │ SYSTEM HEALTH                          │
│ Session P&L:  +$380.50 (+1.9%)     │ Engine:     ● Running                  │
│ Realized:     +$280.00             │ Broker:     ● Connected (45ms)         │
│ Unrealized:   +$100.50             │ Data Feed:  ● Fresh (2s ago)           │
│ Buying Power: $48,250              │ Last Signal: 15m ago                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ RISK STATUS                                                                  │
│ Daily Loss:     ████░░░░░░░░░░░░  $300 / $1,000 (30%)                      │
│ Drawdown:       ██░░░░░░░░░░░░░░  4% / 10%                                  │
│ Gross Exposure: ████████████████  95% / 100%                                │
│ Consec. Losses: ██░░░░░░░░░░░░░░  2 / 5                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Kill Switch Menu

```
[🔴 KILL SWITCH ▼]
├── Flatten All Positions     (requires confirmation)
├── Cancel All Open Orders    (immediate)
├── Pause Strategy            (no new signals)
└── Stop Session              (graceful shutdown)
```

### Emergency Flatten Protocol

**Two-stage approach** (see Tech Spec §2.6 for implementation):

1. **Stage 1**: Marketable limit orders (IOC)
   - Price: bid - 2×spread (for longs), ask + 2×spread (for shorts)
   - Timeout: 2 seconds
   - **Skip if quote invalid/stale** (immediate market order)
   
2. **Stage 2**: Market order fallback
   - Triggered if Stage 1 incomplete
   - No price protection

**Confirmation required**: Type "FLATTEN" to confirm

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ CONFIRM EMERGENCY FLATTEN                                                  │
│                                                                              │
│ This will IMMEDIATELY close ALL positions using aggressive orders.          │
│                                                                              │
│ RISKS:                                                                       │
│ • Market orders may fill at unfavorable prices                              │
│ • Slippage may be significant, especially in volatile markets               │
│ • This action CANNOT be undone                                              │
│                                                                              │
│ Current positions:                                                          │
│ • AAPL: +100 shares (≈$18,292)                                             │
│ • MSFT: -50 shares (≈$20,722)                                              │
│                                                                              │
│ Type "FLATTEN" to confirm: [____________]                                    │
│                                                                              │
│                                            [Cancel] [Confirm Flatten]        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 4.5 Pre-Trade Validation Checklist [NEW]

Before starting any live trading session, the following checks MUST pass:

### Checklist Items

| Check | Category | Blocking | Validation |
|-------|----------|----------|------------|
| Broker connected | Connection | Yes | `broker.isConnected() && latency < 5000ms` |
| Account authorized | Auth | Yes | `account.tradingEnabled == true` |
| Sufficient buying power | Capital | Yes | `buyingPower >= configuredMinimum` |
| Strategy parsed | Code | Yes | No syntax errors |
| No look-ahead bias | Code | Yes | Static analysis passed |
| Data loaded | Data | Yes | All required symbols available |
| Data fresh | Data | Warning | `lastUpdate < 1 hour ago` |
| Risk limits configured | Risk | Yes | All limits have valid non-zero values |
| Paper test completed | Safety | Warning | At least 1 paper session in history |

### UI Presentation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PRE-TRADE VALIDATION                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ ✓ Broker connected (Alpaca, 45ms latency)                                   │
│ ✓ Account authorized for trading                                            │
│ ✓ Buying power: $48,250 (minimum: $10,000)                                  │
│ ✓ Strategy parsed successfully                                              │
│ ✓ No look-ahead bias detected                                               │
│ ✓ Data loaded: AAPL (252 bars)                                              │
│ ✓ Data fresh: updated 15 minutes ago                                        │
│ ✓ Risk limits configured                                                    │
│ ⚠ No paper trading history (recommended)                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 8/9 checks passed (1 warning)                                               │
│                                                                              │
│ ⚠ Warnings do not block trading but indicate potential issues               │
│                                                                              │
│                              [Cancel] [Start Live Trading]                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Blocking vs Warning

- **Blocking checks**: MUST pass before "Start Live Trading" is enabled
- **Warning checks**: Show ⚠ but allow proceeding with acknowledgment
- **Failed checks**: Show ✗ with specific remediation steps

---

# §5. Activity Bar Panels

## 5.1 Data Panel

- **Symbols & Watchlists**: Add/remove symbols, create watchlists
- **Data Sources**: Configure data providers, API keys
- **Universe Manager**: Create/edit universes, point-in-time membership
- **Feature Store**: Cached computed features, dependencies

## 5.2 Resources Panel

- **Strategy Templates**: Built-in and user templates
- **Documentation**: Integrated help and API reference
- **Sample Data**: Example datasets for learning

## 5.3 History Panel

- **Run History**: Last 100 runs with quick metrics
- **Pinned Runs**: Locked runs for reproducibility
- **Comparison Tool**: Side-by-side run comparison

## 5.4 Trade Panel

- **Active Sessions**: Currently running paper/live sessions
- **Session History**: Past sessions with full logs
- **Positions Overview**: Aggregate view across sessions

## 5.5 Settings Panel

### Risk Limit Definitions

#### Daily Loss Limit
```
Daily Loss = (Starting Equity - Current Equity) / Starting Equity × 100%

Includes: Realized P&L + Unrealized P&L + Commissions + Borrow fees
Reset: Session start (default) or configurable time (e.g., 9:30 AM ET)
```

#### Max Drawdown Limit
```
Drawdown = (Peak Equity - Current Equity) / Peak Equity × 100%

Peak: Highest equity during session (not lifetime)
Calculated: After every fill and bar close
```

#### Consecutive Losing Trades
```
Counter increments on each trade with P&L < 0
Resets to 0 after any winning trade (P&L > 0)
Break-even (P&L = 0) counts as loss (conservative)
```

#### Gross Exposure Limit
```
Gross Exposure = (Long Value + |Short Value|) / Equity × 100%

V1 Maximum: 100% (no leverage)
Checked: Before every order submission (with reservation model)
```

### Risk Limit Actions

| Limit | Action Options |
|-------|----------------|
| Daily Loss | Pause & Alert, Flatten & Stop, Alert Only |
| Max Drawdown | Pause & Alert, Flatten & Stop, Alert Only |
| Consecutive Losses | Pause & Alert, Alert Only |
| Gross Exposure | Reject Order (automatic) |

## 5.6 Workspace Trust Model

### Trust Levels
| Level | Capabilities |
|-------|--------------|
| Untrusted | View code only, no execution |
| Development | Backtest, paper trading |
| **Trusted** | Live trading enabled |

### Trust Requirements for Live Trading
1. Workspace is local filesystem (not remote/network)
2. Extensions reviewed and approved (§5.7)
3. Strategy code explicitly trusted
4. Broker connected and authorized

### Trust Flow
```
User clicks "Start Live Trading"
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🔒 WORKSPACE TRUST REQUIRED                                                  │
│                                                                              │
│ CHECKLIST                                                                    │
│ ✓ Workspace is local                                                        │
│ ⚠ Extensions need review                     [Review Extensions]            │
│ ○ Strategy code not reviewed                 [Review & Trust Strategy]      │
│ ✓ Broker connected                                                          │
│                                                                              │
│                                          [Cancel] [Complete Trust Setup]     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Code Change Detection
When trusted strategy code is modified:
- Live trading automatically disabled
- User must re-review and re-trust
- Warning banner displayed: "Strategy modified — trust revoked"

## 5.7 Extension Trust Model [NEW]

### Extension Review Process

Before enabling live trading, all installed extensions MUST be reviewed:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🔍 EXTENSION REVIEW                                                          │
│                                                                              │
│ The following extensions are installed. Review each for live trading:       │
│                                                                              │
│ BUNDLED (Pre-approved)                                                      │
│ ✓ Python                               Quantlab-bundled                     │
│ ✓ Pyright                              Quantlab-bundled                     │
│ ✓ Jupyter                              Quantlab-bundled                     │
│                                                                              │
│ USER-INSTALLED                                                              │
│ ⚠ Prettier                             [Review] [Trust] [Disable]          │
│ ⚠ GitLens                              [Review] [Trust] [Disable]          │
│ ✗ Unknown Publisher Extension          [Review] [Trust] [Disable]          │
│                                                                              │
│ ⚠ 2 extensions need review before live trading                              │
│                                                                              │
│                                          [Cancel] [Trust All Listed]         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Extension Capabilities Warning

Extensions with these capabilities show additional warnings:

| Capability | Warning Message |
|------------|-----------------|
| File system access | "Can read/write files in workspace" |
| Network access | "Can make network requests" |
| Process spawning | "Can run external programs" |
| Clipboard access | "Can read/write clipboard" |

### Extension Update Policy

When a trusted extension updates:
- Trust is **retained** for patch versions (1.0.1 → 1.0.2)
- Trust is **revoked** for minor/major versions (1.0 → 1.1 or 2.0)
- User notified: "Extension X updated. Review required for live trading."

---

# §6. History System

## 6.1 Run Comparison

Compare any two runs side-by-side:
- Metrics diff with color coding (green=better, red=worse)
- Code diff (always available, even for deleted files)
- Config diff (parameter changes highlighted)
- Trade-by-trade comparison with deviation analysis

## 6.2 Pinning

Pinned runs preserve:
- Code snapshot (mandatory, full package)
- Data snapshot (full hash, not sampled)
- Environment snapshot (all package versions)
- All artifacts (trades, equity, debug files)

**Pinned runs cannot be deleted** without explicit unpinning.

---

# §7. Data File Handling

## 7.1 Supported Formats

| Format | Read | Write | Notes |
|--------|------|-------|-------|
| CSV | ✓ | ✓ | Auto-detect delimiter |
| Parquet | ✓ | ✓ | Preferred for large files |
| JSON | ✓ | — | For config/metadata only |

## 7.2 Schema Mapper

Auto-detects and maps columns:
- `date`, `time`, `timestamp`, `datetime` → DateTime
- `open`, `o`, `Open` → Open price
- `high`, `h`, `High` → High price
- `low`, `l`, `Low` → Low price
- `close`, `c`, `Close`, `last`, `price` → Close price
- `volume`, `vol`, `v`, `Volume` → Volume

**Manual override available** when auto-detection fails.

## 7.3 Universe Warning

**When using static universe for backtesting:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ SURVIVORSHIP BIAS WARNING                                                  │
│                                                                              │
│ You are backtesting with a static universe (S&P 500 current members).       │
│                                                                              │
│ This introduces survivorship bias because:                                  │
│ • Companies that were delisted or removed are excluded                      │
│ • Bankrupt companies are not represented                                    │
│ • Results will be optimistically biased                                     │
│                                                                              │
│ For unbiased results, use point-in-time universe membership.                │
│                                                                              │
│ [Use Point-in-Time] [Continue with Warning] [Learn More]                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# §8. Keyboard Shortcuts

## 8.1 Platform-Specific Prefix

| Platform | Prefix | Rationale |
|----------|--------|-----------|
| Windows/Linux | `Ctrl+Shift+Q` | Avoids VS Code conflicts |
| macOS | `Cmd+Shift+K` | `Cmd+Q` is OS quit, `K` for "Quant" |

## 8.2 View Navigation

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| Editor view | `Ctrl+Shift+Q E` | `Cmd+Shift+K E` |
| Chart view | `Ctrl+Shift+Q C` | `Cmd+Shift+K C` |
| Action view | `Ctrl+Shift+Q A` | `Cmd+Shift+K A` |
| Trade view | `Ctrl+Shift+Q T` | `Cmd+Shift+K T` |
| Debug view | `Ctrl+Shift+Q D` | `Cmd+Shift+K D` |

## 8.3 Actions

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| Quick Backtest | `Ctrl+Shift+Q B` | `Cmd+Shift+K B` |
| Kill Switch | `Ctrl+Shift+Q K` | `Cmd+Shift+K K` |
| Pin Run | `Ctrl+Shift+Q P` | `Cmd+Shift+K P` |
| Compare Runs | `Ctrl+Shift+Q R` | `Cmd+Shift+K R` |

**Note**: All shortcuts are two-key sequences (press prefix, release, press action key).

## 8.4 Shortcut Customization

Users MAY remap shortcuts in Settings → Keyboard Shortcuts.

**Conflict detection**: If user remaps to a conflicting shortcut, show warning.

---

# §9. Notifications & Errors

## 9.1 Notification Types

| Type | Duration | Dismissal | Use Case |
|------|----------|-----------|----------|
| Toast (Info) | 5 seconds | Auto | Success messages |
| Toast (Warning) | 10 seconds | Auto or click | Warnings |
| Toast (Error) | Manual | Click required | Recoverable errors |
| Modal | Manual | Button click | Blocking decisions |
| Banner | Manual | X button | System-wide notices |

## 9.2 Error Codes

All errors include code for support:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ✗ Error: DATA_SCHEMA_MISMATCH                                                │
│                                                                              │
│ Expected 'close' column but found 'last_price'.                             │
│                                                                              │
│ Suggestions:                                                                │
│ • Use Schema Mapper to rename 'last_price' to 'close'                       │
│ • Or modify your data file to use standard column names                     │
│                                                                              │
│ [Copy Error Code] [Open Schema Mapper] [View Documentation]                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# §10. Onboarding

## 10.1 First-Run Experience

**Step 0**: Risk Disclosure (MUST come first, cannot be skipped)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        IMPORTANT DISCLOSURES                                 │
│                                                                              │
│ [Full disclosure text - see §11.1]                                          │
│                                                                              │
│ ☐ I have read and understand these disclosures                              │
│                                                                              │
│                                                              [I Understand]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Step 1**: Setup (only after disclosure acknowledged)

```
┌───────────────────────────────────────────────────────────────────────┐
│                     WELCOME TO QUANTLAB                               │
│                                                                       │
│  Let's get you set up:                                               │
│                                                                       │
│  1. Connect Data Source                              [Set Up]         │
│  2. Connect Broker (Optional)                        [Skip]           │
│  3. Create First Strategy                            [Start]          │
│                                                                       │
│  [View Documentation]    ☐ Don't show again          [Get Started]   │
└───────────────────────────────────────────────────────────────────────┘
```

## 10.2 Contextual Tips

Behavior-triggered suggestions:
| Trigger | Suggestion |
|---------|------------|
| 10+ backtests same strategy | "Consider Walk-Forward Analysis for robustness testing" |
| First live attempt | "Recommend testing in paper trading first" |
| High Sharpe, few trades | "Warning: Small sample size may not be statistically significant" |
| No stops in strategy | "Consider adding stop-loss orders for risk management" |
| Backtest > 5 min | "Tip: Use Clean Room preset to verify no look-ahead bias" |

---

# §11. Regulatory Disclosures

## 11.1 Required Disclosure Surfaces

### First Launch Disclosure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        IMPORTANT DISCLOSURES                                 │
│                                                                              │
│ RISK WARNING                                                                 │
│ Trading securities involves substantial risk of loss. Past performance,     │
│ including backtested results, does not guarantee future results. You may    │
│ lose some or all of your invested capital.                                  │
│                                                                              │
│ NOT FINANCIAL ADVICE                                                         │
│ Quantlab is a software tool. Nothing in this application constitutes        │
│ financial, investment, legal, or tax advice. Consult qualified              │
│ professionals before making investment decisions.                            │
│                                                                              │
│ BACKTESTING LIMITATIONS                                                      │
│ Backtested results are hypothetical and have inherent limitations:          │
│ • They do not reflect actual trading                                        │
│ • They cannot account for all market factors                                │
│ • They may benefit from hindsight bias                                      │
│ • Actual results may differ materially                                      │
│                                                                              │
│ EXECUTION RISK                                                               │
│ Live trading carries execution risks including but not limited to:          │
│ • Slippage and price movement                                               │
│ • System failures and connectivity issues                                   │
│ • Broker or exchange outages                                                │
│ • Delayed or failed order execution                                         │
│                                                                              │
│ By using Quantlab, you acknowledge these risks and accept full              │
│ responsibility for your trading decisions.                                  │
│                                                                              │
│ ☐ I have read and understand these disclosures                              │
│                                                                              │
│                                                              [I Understand]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Behavior**: MUST be acknowledged before first use. Cannot be bypassed. Checkbox must be checked.

### Before Enabling Live Trading

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ LIVE TRADING RISK ACKNOWLEDGMENT                                          │
│                                                                              │
│ You are about to enable LIVE TRADING with real money.                       │
│                                                                              │
│ PLEASE CONFIRM YOU UNDERSTAND:                                               │
│                                                                              │
│ □ I may lose some or all of my invested capital                             │
│ □ Backtested performance does not guarantee live results                    │
│ □ System failures can result in unexpected losses                           │
│ □ I am solely responsible for my trading decisions                          │
│ □ I have tested this strategy in paper trading                              │
│                                                                              │
│ Connected Account: Alpaca (*****1234)                                       │
│ Account Value: $50,000                                                      │
│                                                                              │
│                                              [Cancel] [Enable Live Trading]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Behavior**: All 5 checkboxes MUST be checked before "Enable Live Trading" button activates.

## 11.2 Persistent Disclaimers

### Results Display Footer

All backtest and live trading results MUST display:

```
────────────────────────────────────────────────────────────────────────────────
⚠ Past performance does not guarantee future results. Backtested results are
hypothetical and do not reflect actual trading. See Risk Disclosures.
────────────────────────────────────────────────────────────────────────────────
```

### Export Footer

All exported reports (PDF, HTML, CSV) MUST include:

```
DISCLAIMER: This report was generated by Quantlab and contains hypothetical
backtested results. Past performance is not indicative of future results.
Trading securities involves substantial risk of loss. This is not financial advice.

Generated: {timestamp} | Quantlab v{version} | Run ID: {run_id}
```

## 11.3 Help Menu

Help → Risk Disclosures: Opens full disclosure document (same as first-launch).

---

# §12. Code Modification Safety

## 12.1 "Apply to Code" Feature

The Parameter Panel allows users to adjust parameters via sliders/inputs, then apply changes to source code.

### Safety Requirements

| Requirement | Implementation |
|-------------|----------------|
| Parse validation | MUST parse successfully before apply |
| Preview diff | MUST show diff before applying |
| Undo support | MUST be undoable (Ctrl+Z / Cmd+Z) |
| Formatting preservation | MUST use CST library (see Tech Spec §18.6) |
| Backup | MUST create backup before modification |

### Backup Retention Policy

| Policy | Value |
|--------|-------|
| Max backups per file | 5 |
| Naming scheme | `{filename}.bak.{timestamp}` |
| Auto-cleanup | Delete oldest when > 5 |
| Location | Same directory as original |

### Apply Flow

```
User adjusts parameter slider
         │
         ▼
[Apply to Code] clicked
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PREVIEW CODE CHANGE                                                          │
│                                                                              │
│ File: strategy.py                                                           │
│ ─────────────────────────────────────────────────────────────────────────── │
│   4 │ -fast_period = ql.param('fast_period', default=10, min=5, max=50)     │
│   4 │ +fast_period = ql.param('fast_period', default=8, min=5, max=50)      │
│ ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│ ☑ Create backup (strategy.py.bak.20260125T143022)                           │
│                                                                              │
│                                              [Cancel] [Apply Change]         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Error Handling

If parse fails after modification:
1. Automatically restore from backup
2. Show error: "Code modification would create invalid syntax. Reverted."
3. Log incident for debugging

### Unsupported Cases

"Apply to Code" is DISABLED when:
- File is read-only
- Multiple parameters on same line
- Parameter uses dynamic expression (e.g., `default=os.getenv(...)`)
- File has unsaved changes (ambiguous state)
- File is not Python (.py)

---

# §13. Accessibility Requirements

## 13.1 General Requirements

Quantlab MUST meet **WCAG 2.1 Level AA** for all standard UI components.

**Exception**: Chart visualizations MAY meet Level A with documented alternatives.

## 13.2 Chart Accessibility

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `Tab` | Focus chart area |
| `←` / `→` | Navigate between bars |
| `↑` / `↓` | Switch between data series |
| `Enter` | Read current bar details aloud |
| `S` | Jump to next signal |
| `Shift+S` | Jump to previous signal |
| `T` | Jump to next trade |
| `Shift+T` | Jump to previous trade |
| `Escape` | Exit chart focus |

### Screen Reader Support

When bar is focused, announce:
```
"Bar 542 of 2520. Date: March 15, 2022. 
Open: 98 dollars 20 cents. High: 99 dollars 45 cents. 
Low: 97 dollars 80 cents. Close: 99 dollars 10 cents.
Volume: 14 point 2 million.
Signal: Buy entry. 
Press Enter for more details."
```

### Non-Color Encodings

All color-coded information MUST have non-color alternative:

| Element | Color | Non-Color Indicator |
|---------|-------|---------------------|
| Buy signal | Green | ▲ (triangle up) |
| Sell signal | Red | ▼ (triangle down) |
| Up candle | Green | Filled body |
| Down candle | Red | Hollow body |
| Chart view tab | Green stripe | 📊 icon + "Chart" label |
| Trade view tab | Red stripe | 💹 icon + "Trade" label |
| Profit | Green | + prefix |
| Loss | Red | - prefix |

### Alternative Data View

For all charts, provide "View as Table" option:

```
[📊 Chart] [📋 Table]

Date       │ Open   │ High   │ Low    │ Close  │ Volume    │ Signal
───────────┼────────┼────────┼────────┼────────┼───────────┼────────
2022-03-14 │ 97.50  │ 98.80  │ 97.20  │ 98.20  │ 12.4M     │ —
2022-03-15 │ 98.20  │ 99.45  │ 97.80  │ 99.10  │ 14.2M     │ BUY ▲
2022-03-16 │ 99.10  │ 100.20 │ 98.50  │ 99.80  │ 11.8M     │ —
```

## 13.3 Focus Management

- Focus ring visible on all interactive elements (3px, high contrast color)
- Focus trapped in modals until dismissed
- Focus returns to trigger element after modal closes
- Skip links available for keyboard users

## 13.4 Motion and Animation

- All animations respect `prefers-reduced-motion` system setting
- No auto-playing animations
- Progress indicators use both motion AND text updates
- Chart animations can be disabled in Settings

## 13.5 Color Contrast

All text meets minimum contrast ratios:
- Normal text (< 18pt): 4.5:1
- Large text (≥ 18pt or ≥ 14pt bold): 3:1
- UI components and graphical objects: 3:1

---

# §14. Live Session UI Behaviors [NEW]

## 14.1 Window Close During Active Session

When user attempts to close Quantlab while a live session is active:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ LIVE SESSION ACTIVE                                                        │
│                                                                              │
│ You have an active live trading session running.                            │
│                                                                              │
│ Closing Quantlab will NOT stop your live trading session.                   │
│ The engine will continue running in the background as a daemon process.     │
│                                                                              │
│ Choose an action:                                                           │
│ ○ Minimize to System Tray (recommended)                                     │
│   Quantlab continues running in background with status indicator            │
│                                                                              │
│ ○ Stop Session and Close                                                    │
│   Gracefully stop strategy, close positions per settings, then quit         │
│                                                                              │
│ ○ Close UI Only (engine continues)                                          │
│   Engine daemon keeps running; reconnect by reopening Quantlab              │
│                                                                              │
│                                              [Cancel] [Proceed]              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 14.2 System Tray Mode

When minimized to system tray:

**Icon Status Indicators**:
- 🟢 Green dot: Running normally
- 🟡 Yellow dot: Warning (approaching risk limits)
- 🔴 Red dot: Error or circuit breaker triggered
- ⚪ Gray dot: Session paused

**Tooltip**: "Quantlab - AAPL Strategy - +$380 (+1.9%)"

**Right-click Menu**:
```
├── Open Quantlab
├── ─────────────
├── Session: strategy.py (LIVE)
├── Status: ● Running
├── P&L: +$380.50 (+1.9%)
├── ─────────────
├── Pause Strategy
├── Emergency Flatten
├── Stop Session
├── ─────────────
└── Exit (stops session)
```

## 14.3 Session Recovery

When UI reconnects to existing daemon session (after crash or restart):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ✓ SESSION RECOVERED                                                          │
│                                                                              │
│ Reconnected to live trading session started 2h 15m ago.                     │
│                                                                              │
│ Current Status:                                                             │
│ • Strategy: strategy.py                                                     │
│ • Mode: LIVE                                                                │
│ • P&L: +$380.50 (+1.9%)                                                     │
│ • Positions: AAPL +100, MSFT -50                                            │
│ • Last signal: 15 minutes ago                                               │
│                                                                              │
│ No actions were missed during UI downtime.                                  │
│                                                                              │
│                                                              [View Session]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 14.4 Out-of-Hours Flatten

If emergency flatten is requested outside market hours:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ MARKET CLOSED                                                              │
│                                                                              │
│ The market is currently closed (opens Mon 9:30 AM ET).                      │
│                                                                              │
│ Emergency flatten options:                                                  │
│                                                                              │
│ ○ Queue for Market Open                                                     │
│   Orders will execute immediately when market opens                         │
│   Positions remain open until then                                          │
│                                                                              │
│ ○ Use Extended Hours (if available)                                         │
│   Limited liquidity, wider spreads expected                                 │
│   Your broker: Alpaca (extended hours: ✓ available)                        │
│                                                                              │
│ ○ Cancel (keep positions overnight)                                         │
│                                                                              │
│                                              [Cancel] [Proceed]              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 14.5 Connection Loss Handling

When broker connection is lost:

| Duration | UI Behavior |
|----------|-------------|
| 0-30s | Yellow status indicator, "Reconnecting..." toast |
| 30s-5min | Warning banner, retry counter shown |
| > 5min | Circuit breaker triggers, modal with options |

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🔴 BROKER CONNECTION LOST                                                    │
│                                                                              │
│ Connection to Alpaca lost for 5 minutes 23 seconds.                         │
│ Last known positions: AAPL +100, MSFT -50                                   │
│                                                                              │
│ The strategy has been PAUSED to prevent unmanaged positions.                │
│                                                                              │
│ Options:                                                                    │
│ ○ Keep retrying (strategy paused)                                           │
│ ○ Stop session (positions remain at broker)                                 │
│ ○ Open broker web portal                                                    │
│                                                                              │
│                              [Retry Now] [Open Broker Portal]               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# §15. Non-Goals & Deferred (V2)

## 15.1 Explicitly Not in V1

| Feature | Reason | V2 Candidate |
|---------|--------|--------------|
| Tick-level backtesting | Bar-based focus for V1 | Yes |
| Team collaboration | Single-user first | Yes |
| Leverage / Margin | 100% collateral only | Unlikely |
| Options/Futures | Different asset class | Yes |
| Mobile app | Desktop-first | Maybe |
| OCO/Bracket orders | Complexity | Yes |
| Multi-broker single session | Complexity | Maybe |

## 15.2 Known Limitations

| Limitation | Workaround | Future Fix |
|------------|------------|------------|
| No intrabar simulation | Conservative slippage model | V2 tick data |
| Single broker per session | Use multiple sessions | V2 multi-broker |
| 100% collateral | Design market-neutral at 1x | Evaluate margin |
| No dividend modeling | Use adjusted data | V1.1 |

---

# Appendix A: Feature Index

| Feature | Primary Section |
|---------|-----------------|
| Accessibility | §13 |
| Action View | §4.3 |
| Chart View | §4.2 |
| Code Modification | §12 |
| Emergency Flatten | §4.4 |
| Extension Trust | §5.7 |
| Kill Switch | §4.4 |
| Keyboard Shortcuts | §8 |
| Live Session UI | §14 |
| Pre-Trade Validation | §4.5 |
| Pyright/Pylance | §2.3, §2.4 |
| Regulatory Disclosures | §11 |
| Risk Limits | §5.5 |
| Time-Travel Debugger | §4.2 |
| Workspace Trust | §5.6 |

---

# Appendix B: Glossary

| Term | Definition |
|------|------------|
| Circuit Breaker | Automated risk control that halts trading |
| Daemon | Background process that runs independently of UI |
| DataRev | Immutable data revision identifier |
| Gross Exposure | (Long Value + |Short Value|) / Equity |
| Kill Switch | Emergency position liquidation control |
| Net Exposure | (Long Value - Short Value) / Equity |
| Pin | Lock a run for guaranteed reproduction |
| Pyright | Open-source Python type checker (replaces Pylance) |
| Signal Bar | Bar whose data generates trading signals (bar t) |
| Execution Bar | Bar during which orders fill (bar t+1) |
| Trust | Security level required for live trading |
| WFA | Walk-Forward Analysis |

---

*End of Quantlab Product Specification V10.5 FINAL*
