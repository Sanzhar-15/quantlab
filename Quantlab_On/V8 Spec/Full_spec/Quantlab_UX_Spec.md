# Quantlab UI/UX Specification V8.1
## Complete Product Interface Design — Final

**Product**: Quantlab  
**Company**: Delta Plus  
**Document type**: UI/UX Specification (Implementation-Ready)  
**Version**: 8.1 (Final)  
**Status**: Final — Handoff Ready  
**Date**: 2026-01-19  
**Supersedes**: V7.0.1 Sections 2.1–2.5, V8.0

---

## Document Control

### Change Log
- **V8.0 → V8.1** (this document):
  - Fixed keyboard shortcut collisions (§7)
  - Adopted VS Code-compatible keybinding policy with `Ctrl+Q` prefix
  - Corrected accessibility contrast approach (§9.3) — switched to indicator stripe
  - Broadened strategy validation to include event-driven entrypoints (§6.2)
  - Added Parameter System specification (§3.5)
  - Added Symbol/Timeframe Global State (§2.7)
  - Added Complexity Indicator for safety gating (§3.6)
  - Added Data Flow Between Views (§3.7)
  - Added Visualization Code specification (§3.8)
  - Added Error States and Recovery (§10)
  - Added Notifications System (§11)
  - Added Drag-and-Drop Behaviors (§12)
  - Added Onboarding Flow (§13)
  - Clarified Kill Switch reflects configured policy (§3.1.4)
  - Preserved layout controls via Command Palette (§2.3.2)
  - Fixed footnote formatting throughout

- **V7.0.1 → V8.0** (prior):
  - Removed Chart Mode / Editor Mode paradigm entirely
  - Introduced four-view system: Editor, Chart, Action, Trade
  - Restructured Activity Bar to navigation-only

### RFC 2119 Keywords
- **MUST / MUST NOT**: Required for implementation
- **SHOULD / SHOULD NOT**: Recommended default behavior
- **MAY**: Optional or deferred

### Scope
This specification defines the complete user interface architecture for Quantlab. It supersedes all UI/UX definitions in prior specifications. Implementation MUST follow this document.

---

## Table of Contents

1. Overview & Design Principles
2. Window Architecture
3. View System
4. Activity Bar
5. History System
6. Tab Behavior & Compatibility
7. Keyboard Shortcuts
8. Visual Design Tokens
9. Accessibility Requirements
10. Error States and Recovery
11. Notifications System
12. Drag-and-Drop Behaviors
13. Onboarding Flow
14. Appendices

---

# 1. Overview & Design Principles

## 1.1 Core Paradigm

Quantlab uses a **view-based architecture** where each open strategy file can be displayed in one of four views:

| View | Purpose | Tab Indicator | Color |
|------|---------|---------------|-------|
| **Editor** | Code editing | None (default) | — |
| **Chart** | Visualization | Green stripe | `#059669` |
| **Action** | Test configuration & results | Orange stripe | `#D97706` |
| **Trade** | Live trading interface | Red stripe | `#DC2626` |

Views are **per-tab states**, not global modes. Users switch views using buttons or open additional tabs in different views for multi-pane layouts.

## 1.2 Design Principles

### Principle 1: Views, Not Modes
There is no global "Chart Mode" or "Editor Mode". Each tab independently maintains its view state. This eliminates mode confusion and supports flexible workflows.

### Principle 2: Activity Bar = Navigation, Editor Area = Work
The Activity Bar contains panels for **browsing and navigation** only. All **content creation and interaction** happens in the Editor Area through views.

### Principle 3: Focus by Default, Multi-Pane by Choice
Clicking view buttons switches the active tab in-place (focused workflow). Right-clicking enables opening views as new tabs for side-by-side layouts (power-user workflow).

### Principle 4: Clear Visual Feedback
Tab indicator stripe immediately communicates view state. Users always know what view they're in.

### Principle 5: Graceful Degradation
When strategy complexity exceeds safe thresholds, views degrade gracefully with clear user guidance rather than failing silently.

### Principle 6: No VS Code Conflicts
Keyboard shortcuts MUST NOT conflict with standard VS Code bindings. Quantlab shortcuts use a dedicated prefix (`Ctrl+Q`).

## 1.3 Personas Supported

| Persona | Primary Workflow |
|---------|------------------|
| **Beginner** | Editor → Chart → Action (sequential, focused) |
| **Intermediate** | Editor + Chart side-by-side, occasional Action |
| **Professional** | Multiple strategies, multiple views, Trade monitoring |

---

# 2. Window Architecture

## 2.1 Window Layout (Normative)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            WINDOW CHROME                                     │
│  File  Edit  Selection  View  ...       [AAPL ▼][1D ▼]      [⏱ History ▼]  │
├─────────────────────────────────────────────────────────────────────────────┤
│                              TAB BAR                                         │
│  ▌strategy.py × │ tab2.py × │                      [Chart] [Action] [Trade] │
│  ↑ Green stripe = Chart view                                                │
├───────┬─────────────────────────────────────────────────────────────┬───────┤
│       │                                                             │       │
│   A   │                                                             │  A    │
│   C   │                      EDITOR AREA                            │  I    │
│   T   │                                                             │       │
│   I   │            (content determined by active view)              │  P    │
│   V   │                                                             │  A    │
│   I   │                                                             │  N    │
│   T   │                                                             │  E    │
│   Y   │                                                             │  L    │
│       ├─────────────────────────────────────────────────────────────┤       │
│   B   │                      BOTTOM PANEL                           │       │
│   A   │  Output │ Terminal │ Problems │ Debug Console │             │       │
│   R   │                                                             │       │
└───────┴─────────────────────────────────────────────────────────────┴───────┘
```

## 2.2 Window Chrome

### 2.2.1 Menu Bar (LHS)
Standard VS Code menu bar with Quantlab additions:
- **File → New Strategy from Template**
- **File → New Strategy from AI**
- **Run → Run Backtest** (`Ctrl+Q B`)
- **Run → Run Last Action** (`Ctrl+Q R`)
- **View → Toggle AI Panel**

### 2.2.2 Global Symbol/Timeframe Selector (Center-Right)
Location: Window chrome, center-right area.

```
[AAPL ▼] [1D ▼]
```

**Behavior**:
- Displays currently selected symbol and timeframe
- Click opens dropdown with recent symbols / search
- Changes apply to:
  - Chart view (immediately updates chart)
  - Action view (pre-fills data configuration)
  - New backtests (uses as default)
- Does NOT affect:
  - Active Trade sessions (locked to session symbol)
  - Editor view (code is symbol-agnostic)

**Persistence**: Per-workspace, saved in workspace state.

### 2.2.3 History Button (RHS)
Location: Window chrome, right side, before window controls.

Label: `[⏱ History ▼]`

Behavior: Click opens History Dropdown (see §5.2).

## 2.3 Tab Bar

### 2.3.1 Tab Bar Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ▌tab.py × │ tab2.py × │ tab3.py × │                [Chart] [Action] [Trade] │
│ ↑                                                                           │
│ Colored left stripe indicates view                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.3.2 View Buttons Position
View buttons MUST be positioned at the **right side of the tab bar**, in the area currently occupied by VS Code's layout buttons.

**Standard VS Code layout buttons**:
- Split Editor, Toggle Panel, Toggle Side Bars → **Relocated to View menu and Command Palette**
- Customize Layout → **Available via Command Palette only**

These controls remain accessible for power users but do not clutter the tab bar.

### 2.3.3 View Buttons Appearance

**Default state (Editor view, compatible file):**
```
[Chart] [Action] [Trade]
```

**Chart view active:**
```
[Editor] [Action] [Trade]
```

**Action view active:**
```
[Chart] [Editor] [Trade]
```

**Trade view active:**
```
[Chart] [Action] [Editor]
```

**Button styling:**
- Default: Standard VS Code secondary button
- Hover: Slight highlight
- Disabled: 50% opacity, cursor: not-allowed

### 2.3.4 Tab Indicator Stripe

Instead of coloring the entire tab background (which creates contrast issues), views are indicated by a **3px left border stripe**:

```
┌──────────────────┐
│▌strategy.py    × │  ← Green stripe = Chart view
└──────────────────┘

┌──────────────────┐
│▌strategy.py    × │  ← Orange stripe = Action view
└──────────────────┘

┌──────────────────┐
│▌strategy.py    × │  ← Red stripe = Trade view
└──────────────────┘

┌──────────────────┐
│ strategy.py    × │  ← No stripe = Editor view (default)
└──────────────────┘
```

This approach:
- Maintains full WCAG contrast compliance
- Provides clear visual differentiation
- Works in both light and dark themes

## 2.4 Editor Area

The Editor Area displays content based on the active tab's current view. See §3 for view-specific content.

## 2.5 Bottom Panel

Standard VS Code bottom panel with tabs:

| Tab | Purpose |
|-----|---------|
| **Output** | Engine logs, print statements, system messages |
| **Terminal** | Interactive shell, Python REPL |
| **Problems** | Linting errors, validation warnings, passive validation |
| **Debug Console** | Time Travel Debugger output, variable inspection |

## 2.6 AI Panel (RHS)

Location: Right side bar (secondary side bar).

**Default state**: Collapsed.

**Content**:
- AI assistant chat interface
- Context-aware suggestions based on current view:
  - Editor view: Code completion, explanation, refactoring
  - Chart view: Visualization code generation
  - Action view: Test configuration suggestions
  - Trade view: Risk analysis, position suggestions

**Trigger**: 
- Toggle via View menu or `Ctrl+Q A`
- Auto-opens when "Generate with AI" selected in Chart view

## 2.7 Global State

### 2.7.1 Symbol/Timeframe State

```typescript
interface GlobalMarketState {
  symbol: string;           // e.g., "AAPL"
  timeframe: string;        // e.g., "1D", "1H", "5m"
  dateRange?: {
    start: Date;
    end: Date;
  };
}
```

**Scope**: Per-workspace
**Persistence**: Saved in workspace state, restored on reopen

### 2.7.2 View State Per Tab

```typescript
interface TabViewState {
  filePath: string;
  currentView: 'editor' | 'chart' | 'action' | 'trade';
  
  // Chart view state
  chartState?: {
    symbol: string;           // Can override global
    timeframe: string;
    indicators: IndicatorConfig[];
    drawings: Drawing[];
    scrollPosition: number;
  };
  
  // Action view state
  actionState?: {
    selectedAction: string | null;
    configuration: Record<string, any>;
    lastResult: ActionResult | null;
  };
  
  // Trade view state
  tradeState?: {
    sessionId: string | null;
    scrollPosition: number;
  };
}
```

**Persistence**: Saved in workspace state, restored on reopen.

---

# 3. View System

## 3.1 View Definitions

### 3.1.1 Editor View

**Purpose**: Code editing using Monaco editor.

**Tab indicator**: None (default).

**Content**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   [Standard Monaco Editor]                                                  │
│                                                                             │
│   - Syntax highlighting for Python                                          │
│   - IntelliSense for quantlab.ql API                                        │
│   - Parameter hints and documentation                                       │
│   - Go to definition                                                        │
│   - Inline validation warnings (look-ahead bias, etc.)                      │
│   - All standard VS Code editor features                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Available for**: All text files.

### 3.1.2 Chart View

**Purpose**: Visualization of strategy signals on price chart.

**Tab indicator**: 🟢 Green stripe (`#059669`).

**First-time content** (no visualization code):
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                                                                     │   │
│   │         This strategy doesn't have visualization code yet.          │   │
│   │                                                                     │   │
│   │         Visualization code tells Quantlab how to display your       │   │
│   │         strategy's signals, indicators, and overlays on the chart.  │   │
│   │                                                                     │   │
│   │         ┌─────────────────────┐  ┌─────────────────────┐            │   │
│   │         │  📝 Add Manually    │  │  🤖 Generate with AI │            │   │
│   │         └─────────────────────┘  └─────────────────────┘            │   │
│   │                                                                     │   │
│   │         [Learn about visualization code]                            │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Standard content** (visualization code exists):
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ [AAPL ▼] [1D ▼] [2020-01-01 → 2024-12-31]    [Complexity: ●●●○○ Safe]  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                         │ │
│ │                        CHARTING SOFTWARE                                │ │
│ │                                                                         │ │
│ │   - OHLCV candlesticks/bars                                             │ │
│ │   - Strategy signal overlays (entry/exit markers)                       │ │
│ │   - Indicator plots (MAs, RSI, etc.)                                    │ │
│ │   - Equity curve (optional pane)                                        │ │
│ │   - Drawing tools                                                       │ │
│ │                                                                         │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ PARAMETERS                                                    [▼ Hide] │ │
│ │ ┌─────────────────────────────────────────────────────────────────────┐ │ │
│ │ │ fast_period    [10]  ├────────●────────────┤  [5 ─ 50]             │ │ │
│ │ │ slow_period    [20]  ├──────────────●──────┤  [10 ─ 100]           │ │ │
│ │ │ stop_loss      [2%]  ├──●──────────────────┤  [0.5% ─ 10%]         │ │ │
│ │ └─────────────────────────────────────────────────────────────────────┘ │ │
│ │                                    [Reset to Defaults] [Apply to Code] │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Chart toolbar elements**:
- Symbol selector (can override global)
- Timeframe selector (can override global)
- Date range selector
- Complexity indicator (see §3.6)
- Settings (⚙️): Chart type, colors, indicators
- Refresh (🔄): Re-run visualization
- Screenshot (📷): Export chart image

**Parameter panel**:
- Displays all `ql.param()` definitions from strategy
- Sliders for numeric parameters
- Dropdowns for choice parameters
- Checkboxes for boolean parameters
- "Reset to Defaults": Reverts to code defaults
- "Apply to Code": Writes current values back to source file

**Available for**: `.py` files with valid strategy structure.

### 3.1.3 Action View

**Purpose**: Configure and run tests, view results.

**Tab indicator**: 🟠 Orange stripe (`#D97706`).

**State 1: Selection (initial)**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   QUICK ACTIONS                                                             │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│   │     ▶      │  │     ⚡     │  │     🎲     │  │     📈     │           │
│   │  Backtest  │  │  Optimize  │  │   Monte    │  │    WFA     │           │
│   │            │  │            │  │   Carlo    │  │            │           │
│   └────────────┘  └────────────┘  └────────────┘  └────────────┘           │
│                                                                             │
│   Quick Actions run with default settings using the global symbol/TF.      │
│   For advanced configuration, select from Resources panel.                  │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   MORE FROM RESOURCES                                                       │
│   Select a test or analysis from the Resources panel (auto-expanded).       │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   RECENT FOR THIS STRATEGY                                                  │
│   ├── ✓ Backtest #52 — 2 hours ago — Sharpe: 1.24        [View] [Re-run]   │
│   ├── ✓ WFA #8 — Yesterday — Stability: 0.72             [View] [Re-run]   │
│   └── ✗ Backtest #51 — 2 days ago — Error                [View Logs]       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Quick Actions Definitions**:

| Action | Default Behavior |
|--------|------------------|
| **Backtest** | Standard backtest with code defaults, global symbol/TF, max available history |
| **Optimize** | Grid search over all `ql.param()` ranges, optimize for Sharpe |
| **Monte Carlo** | 1000 simulations, shuffle trades method, 95% CI |
| **WFA** | 5 splits, 70/30 train/test, Sharpe optimization |

**State 2: Configuration (after selecting action)**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   WALK-FORWARD ANALYSIS                                          [← Back]  │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   CONFIGURATION                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Number of splits        [5        ▼]                                │   │
│   │ Training ratio          [0.7      ▼]    (70% train, 30% test)       │   │
│   │ Optimization metric     [Sharpe Ratio ▼]                            │   │
│   │ Min trades per split    [10         ]                               │   │
│   │ Stability threshold     [0.5      ▼]    (minimum to pass)           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   DATA                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Symbol                  [AAPL      ▼]    (from global)              │   │
│   │ Timeframe               [1D        ▼]    (from global)              │   │
│   │ Date range              [2020-01-01] to [2024-12-31]                │   │
│   │ Data source             [Alpaca    ▼]                               │   │
│   │ ☑ Pin data revision (for reproducibility)                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   STRATEGY PARAMETERS                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ○ Use code defaults                                                 │   │
│   │ ○ Use current Chart view overrides                                  │   │
│   │ ● Specify for this run:                                             │   │
│   │   fast_period           [10       ]                                 │   │
│   │   slow_period           [20       ]                                 │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│                                                    [▶ Run Walk-Forward]     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**State 3: Running (job in progress)**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   WALK-FORWARD ANALYSIS                                 [Cancel] [← Back]   │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   Status: ● RUNNING                         Run ID: wfa-2026011942          │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  45%      │   │
│   │                                                                     │   │
│   │ Processing split 3 of 5...                                          │   │
│   │ Elapsed: 1m 23s │ Estimated remaining: 1m 45s                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   LIVE LOG                                                      [▼ Expand] │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ [10:45:32] Starting Walk-Forward Analysis                           │   │
│   │ [10:45:33] Split 1: Training 2020-01 → 2021-02                      │   │
│   │ [10:45:45] Split 1: Optimization complete, best Sharpe: 1.45        │   │
│   │ [10:45:46] Split 1: Testing 2021-02 → 2021-06                       │   │
│   │ [10:45:52] Split 1: OOS Sharpe: 1.12                                │   │
│   │ [10:45:53] Split 2: Training 2021-02 → 2022-03                      │   │
│   │ ...                                                                 │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**State 4: Results (job complete)**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   WALK-FORWARD ANALYSIS — RESULTS              [↻ Re-run] [← New Analysis] │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  ✓ PASSED                                    Completed: 2 min ago   │   │
│   │  Run ID: wfa-2026011942                      Duration: 3m 08s       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   SUMMARY METRICS                                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Avg Out-of-Sample Sharpe     1.24        ████████████░░░░          │   │
│   │ Stability Score              0.72        ██████████░░░░░░          │   │
│   │ Degradation Ratio            0.85        ███████████░░░░░          │   │
│   │ Total Trades                 142                                    │   │
│   │ Avg Trades per Split         28.4                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   SPLIT DETAILS                                                 [▼ Expand] │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Split │ Train Period       │ Test Period        │IS Sharpe│OOS Sharpe│ │
│   │───────┼────────────────────┼────────────────────┼─────────┼──────────│ │
│   │   1   │ 2020-01 → 2021-02  │ 2021-02 → 2021-06  │  1.45   │   1.12   │ │
│   │   2   │ 2021-02 → 2022-03  │ 2022-03 → 2022-07  │  1.38   │   1.28   │ │
│   │   3   │ 2022-03 → 2023-04  │ 2023-04 → 2023-08  │  1.52   │   1.31   │ │
│   │   4   │ 2023-04 → 2024-05  │ 2024-05 → 2024-09  │  1.41   │   1.18   │ │
│   │   5   │ 2024-05 → 2024-10  │ 2024-10 → 2024-12  │  1.33   │   1.31   │ │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   WARNINGS                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ⚠ Split 4 has 18 trades (below recommended minimum of 20)          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │
│   │ 📈 View in   │ │ 💾 Export    │ │ 📌 Pin Run   │ │ 🔗 Compare   │      │
│   │    Chart     │ │    Results   │ │              │ │              │      │
│   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Available for**: `.py` files with valid strategy structure.

### 3.1.4 Trade View

**Purpose**: Live trading monitoring and control.

**Tab indicator**: 🔴 Red stripe (`#DC2626`).

**State 1: No active session**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   LIVE TRADING — strategy.py                                                │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                                                                     │   │
│   │                    No active trading session                        │   │
│   │                                                                     │   │
│   │         Use the Trade panel in the Activity Bar to start            │   │
│   │         a Paper or Live trading session for this strategy.          │   │
│   │                                                                     │   │
│   │                  [Open Trade Panel]                                 │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   REQUIREMENTS CHECKLIST                                                    │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ✓ Strategy has valid structure                                      │   │
│   │ ✓ Strategy complexity is Safe or Partial (not View-Only)            │   │
│   │ ✓ Broker connection configured (Alpaca)                             │   │
│   │ ✓ At least one successful backtest                                  │   │
│   │ ○ Paper trading session completed (recommended)                     │   │
│   │ ○ Risk parameters reviewed                                          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**State 2: Active session**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   LIVE TRADING — strategy.py                    [🔴 KILL SWITCH: Flatten]  │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Session: Paper Trading          Status: ● RUNNING                   │   │
│   │ Account: Alpaca (paper-abc123)  Started: 10:32 AM (2h 15m ago)      │   │
│   │ Strategy: strategy.py @ abc1234 Heartbeat: ● OK (2s ago)            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   [... performance, positions, orders, activity log as in V8.0 ...]        │
│                                                                             │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                       │
│   │ ⏸ Pause      │ │ 📊 View in   │ │ ⚙️ Session   │                       │
│   │   Session    │ │    Chart     │ │   Settings   │                       │
│   └──────────────┘ └──────────────┘ └──────────────┘                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Kill Switch Behavior**:

The Kill Switch button displays the **configured emergency policy**:
- `[🔴 KILL SWITCH: Flatten]` — Cancel all + flatten positions
- `[🔴 KILL SWITCH: Cancel Only]` — Cancel orders, preserve positions
- `[🔴 KILL SWITCH: Custom...]` — User-defined policy

**On click**:
- Paper trading: Executes immediately
- Live trading: Shows confirmation dialog with policy summary

Policy is configured in Trade panel → Risk Settings.

**Available for**: `.py` files with valid strategy structure and broker configured.

## 3.2 View Switching

### 3.2.1 Button Click Behavior

When user clicks a view button:

1. **Active tab only**: Only the currently selected tab is affected
2. **In-place switch**: Tab content changes, no new tab created
3. **Button update**: Clicked button is replaced by `[Editor]` button
4. **Tab indicator update**: Left stripe color changes
5. **Activity Bar behavior**: 
   - Chart view: No auto-expand
   - Action view: Resources panel expands
   - Trade view: Trade panel expands

### 3.2.2 State Transitions

```
                    ┌─────────────┐
          ┌────────►│   Editor    │◄────────┐
          │         │    View     │         │
          │         └──────┬──────┘         │
          │                │                │
    [Editor]          [Chart/Action/Trade]  [Editor]
          │                │                │
          │    ┌───────────┼───────────┐    │
          │    ▼           ▼           ▼    │
       ┌──┴────────┐ ┌───────────┐ ┌───────┴──┐
       │   Chart   │ │   Action  │ │   Trade  │
       │   View    │ │   View    │ │   View   │
       └───────────┘ └───────────┘ └──────────┘
             ▲             ▲             ▲
             └─────────────┴─────────────┘
                   [Direct switching]
```

All views can switch directly to any other view.

## 3.3 Multi-Pane Layouts (Right-Click)

### 3.3.1 Tab Context Menu

```
┌─────────────────────────────────────┐
│ Close                          ⌘W   │
│ Close Others                        │
│ Close All                           │
│ Close Saved                         │
│ ─────────────────────────────────── │
│ Open as Chart              (new tab)│  ← Quantlab
│ Open as Action             (new tab)│  ← Quantlab
│ Open as Trade              (new tab)│  ← Quantlab
│ ─────────────────────────────────── │
│ Split Up                            │
│ Split Down                          │
│ Split Left                          │
│ Split Right                         │
│ ─────────────────────────────────── │
│ Copy Path                           │
│ Copy Relative Path                  │
│ Reveal in Explorer                  │
└─────────────────────────────────────┘
```

### 3.3.2 "Open as [View]" Behavior

1. **New tab created**: Same file, different tab instance
2. **Tab naming**: `filename.py (Chart)` / `filename.py (Action)` / `filename.py (Trade)`
3. **View pre-selected**: New tab opens in specified view
4. **Independent state**: Each tab maintains its own view state

### 3.3.3 Common Multi-Pane Layouts

**Code + Chart (side-by-side):**
```
┌─────────────────────────────────┬─────────────────────────────────┐
│ strategy.py ×                   │▌strategy.py (Chart) ×           │
├─────────────────────────────────┼─────────────────────────────────┤
│                                 │                                 │
│   def strategy(data):           │   ┌─────────────────────────┐   │
│       fast = ql.param(...)      │   │      CHART              │   │
│       ...                       │   └─────────────────────────┘   │
│                                 │                                 │
└─────────────────────────────────┴─────────────────────────────────┘
```

## 3.4 Activity Bar Auto-Expand

| View Entered | Panel Auto-Expanded |
|--------------|---------------------|
| Editor | None |
| Chart | None |
| Action | Resources |
| Trade | Trade |

Auto-expand only occurs if the panel is not already visible.

## 3.5 Parameter System

### 3.5.1 Parameter Definition (in Strategy Code)

```python
from quantlab import ql

def strategy(data):
    # Parameters with full metadata
    fast = ql.param(
        id="fast_period",
        default=10,
        min=5,
        max=50,
        step=1,
        name="Fast MA Period",
        group="Moving Averages",
        description="Period for the fast moving average"
    )
    
    slow = ql.param(
        id="slow_period",
        default=20,
        min=10,
        max=100,
        step=1,
        name="Slow MA Period",
        group="Moving Averages"
    )
    
    stop_pct = ql.param(
        id="stop_loss",
        default=0.02,
        min=0.005,
        max=0.10,
        step=0.005,
        name="Stop Loss %",
        group="Risk",
        format="percent"  # Displays as "2%" not "0.02"
    )
```

### 3.5.2 Parameter Display (Chart View)

Parameters appear in a collapsible panel at the bottom of Chart view:
- Grouped by `group` field
- Sliders for numeric with `min`/`max`
- Dropdowns for `choices` parameters
- Checkboxes for boolean

### 3.5.3 Parameter Override Flow

```
Code Defaults
     │
     ▼ (user adjusts slider)
Chart View Overrides (temporary)
     │
     ├──► [Reset to Defaults] → Reverts to code
     │
     └──► [Apply to Code] → Writes values to source file
              │
              ▼
         Code Updated (permanent)
```

**Overrides persist** within the session but are NOT saved to disk unless "Apply to Code" is clicked.

### 3.5.4 Parameters in Action View

Action view can use parameters from three sources:
1. **Code defaults**: As written in source
2. **Chart view overrides**: Current slider values from Chart view
3. **Run-specific**: Override just for this run

## 3.6 Complexity Indicator

### 3.6.1 Purpose

Some strategies are too complex for:
- Reliable parameter extraction
- Safe visualization hooks
- Live execution confidence

The Complexity Indicator provides clear UX boundaries.

### 3.6.2 Complexity Levels

| Level | Indicator | Meaning |
|-------|-----------|---------|
| **Safe** | `●●●○○` Green | Full features available |
| **Partial** | `●●●●○` Yellow | Chart works, some features limited |
| **View-Only** | `●●●●●` Red | Chart shows last-run artifacts only |

### 3.6.3 What Triggers Each Level

**Safe**:
- Single-file strategy
- All `ql.param()` calls are extractable
- No dynamic parameter generation
- Standard control flow

**Partial**:
- Multi-file strategy with imports
- Some parameters not extractable
- Complex but analyzable control flow

**View-Only**:
- Dynamic code generation
- External API calls in strategy logic
- Unparseable parameter definitions
- Strategy parse errors

### 3.6.4 UI Impact

| Feature | Safe | Partial | View-Only |
|---------|------|---------|-----------|
| Chart display | ✓ Live | ✓ Live | Artifacts only |
| Parameter sliders | ✓ All | ⚠ Some | ✗ None |
| Quick backtest | ✓ | ✓ | ✓ |
| Live trading | ✓ | ⚠ Warning | ✗ Blocked |

**View-Only banner**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠️ This strategy is too complex for live visualization.                     │
│    Showing results from last backtest run (Backtest #52, 2 hours ago).      │
│    [Run New Backtest] to update.                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3.7 Data Flow Between Views

### 3.7.1 "View in Chart" (from Action View Results)

When user clicks "View in Chart" on Action view results:

1. Switch active tab to Chart view
2. Load the run's artifacts (signals, equity curve)
3. Display overlays on chart
4. Show banner: "Showing results from [Run Name]"

```
Action View                          Chart View
┌──────────────────┐                ┌──────────────────┐
│ Results:         │  [View in      │ Chart with:      │
│ - Signals        │   Chart]       │ - Price data     │
│ - Equity curve   │ ──────────────►│ - Signal overlays│
│ - Metrics        │                │ - Equity curve   │
└──────────────────┘                │ - Run banner     │
                                    └──────────────────┘
```

### 3.7.2 Parameter Sync (Chart ↔ Action)

When entering Action view with "Use Chart view overrides":
- Current Chart view parameter values are copied
- User can modify for this run only
- Does not affect Chart view state

### 3.7.3 Trade Session → Chart

When "View in Chart" from Trade view:
- Chart shows live price data
- Overlays show actual fills and orders
- Real-time position visualization

## 3.8 Visualization Code

### 3.8.1 What is Visualization Code?

Visualization code is an **optional section** in a strategy file that tells Quantlab how to display the strategy on a chart. It is NOT required for backtesting or trading.

### 3.8.2 Structure

```python
from quantlab import ql

def strategy(data):
    """Main strategy logic — required."""
    fast_ma = ql.sma(data.close, 10)
    slow_ma = ql.sma(data.close, 20)
    
    entry = ql.cross_over(fast_ma, slow_ma)
    exit = ql.cross_under(fast_ma, slow_ma)
    
    return ql.signals(entry=entry, exit=exit)


def visualize(chart):
    """Visualization logic — optional."""
    # Add indicators to chart
    chart.plot(fast_ma, color="blue", label="Fast MA")
    chart.plot(slow_ma, color="red", label="Slow MA")
    
    # Add custom markers
    chart.mark_entries(style="arrow_up", color="green")
    chart.mark_exits(style="arrow_down", color="red")
    
    # Add equity curve in separate pane
    chart.add_pane("equity", height=0.3)
    chart.plot_equity(pane="equity")
```

### 3.8.3 Auto-Generation

When user clicks "Generate with AI":
1. AI Panel opens
2. Strategy code is analyzed
3. AI generates `visualize()` function
4. User reviews and approves
5. Code is appended to strategy file

### 3.8.4 No Visualization Code Fallback

If no `visualize()` function exists:
- Chart view shows basic OHLCV chart
- Entry/exit signals shown as default markers
- No custom indicators or styling

---

# 4. Activity Bar

## 4.1 Structure (Normative)

```
ACTIVITY BAR:
│
├── 📁 Explorer                    [Standard VS Code]
├── 🔍 Search                      [Standard VS Code]
├── 🔀 Source Control              [Standard VS Code — ESSENTIAL]
├── 🐛 Run and Debug               [Standard VS Code]
├── 🧩 Extensions                  [Standard VS Code]
│
├── ──── QUANTLAB ────             [Visual separator]
│
├── 📊 Data                        [Quantlab]
├── 📚 Resources                   [Quantlab]
├── 📜 History                     [Quantlab]
├── 💹 Trade                       [Quantlab]
└── ⚙️ Settings                    [Quantlab]
```

## 4.2 Standard VS Code Panels

All standard VS Code panels remain available. **Source Control is especially important** for strategy versioning and reproducibility.

## 4.3 Quantlab Panels

### 4.3.1 Data Panel

**Purpose**: Browse and manage market data.

```
DATA
├── 🔍 Symbol Search
│     [Search: "AAPL"]
│     ┌─────────────────────────────────┐
│     │ 🔹 AAPL — Apple Inc.            │
│     │    NASDAQ · Equity · USD        │
│     └─────────────────────────────────┘
│
├── ⭐ Watchlists
│     ├── Tech Giants (5)
│     │     ├── AAPL
│     │     ├── GOOGL
│     │     └── ...
│     └── [+ New Watchlist]
│
├── 📋 Universes
│     ├── S&P 500
│     ├── NASDAQ 100
│     └── Custom Universe 1
│
└── 🔌 Data Sources
      ├── ● Alpaca (connected)
      └── [+ Add Source]
```

**Interactions**:
- Double-click symbol → Sets global symbol
- Drag symbol to Chart view → Changes chart symbol
- Right-click → Context menu with actions

### 4.3.2 Resources Panel

**Purpose**: Catalog of available tests, templates, and guides.

```
RESOURCES
├── 📊 Backtesting
│     ├── Standard Backtest
│     ├── Streaming Backtest
│     └── Multi-Asset Backtest
│
├── ⚡ Optimization
│     ├── Grid Search
│     ├── Bayesian Optimization
│     └── Genetic Algorithm
│
├── 🎲 Overfitting Tests
│     ├── Walk-Forward Analysis
│     ├── Monte Carlo Simulation
│     ├── Combinatorially Purged CV
│     ├── Probability of Overfitting (PBO)
│     └── Deflated Sharpe Ratio
│
├── 📈 Statistical Tests
│     ├── Regime Analysis
│     └── Sample Size Validation
│
├── 📄 Templates
│     ├── Momentum (SMA Crossover)
│     ├── Mean Reversion (RSI + BB)
│     └── Breakout (ATR-based)
│
└── 📚 Guides
      ├── Getting Started
      ├── Writing Strategies
      └── Avoiding Overfitting
```

**Interactions**:
- Double-click test → Opens Action view with that test selected
- Double-click template → Creates new file from template
- Double-click guide → Opens documentation

**Auto-expand**: Opens automatically when entering Action view.

### 4.3.3 History Panel

**Purpose**: Browse, search, and compare past runs.

```
HISTORY
├── 🔍 Search [                    ]
│
├── 📌 Pinned
│     ├── ⭐ WFA #8 — strategy.py
│     └── ⭐ Backtest #42 — momentum.py
│
├── 📅 Recent
│     ├── Today
│     │     ├── ✓ Backtest #52 — strategy.py
│     │     └── ✓ Monte Carlo #18 — strategy.py
│     │
│     ├── Yesterday
│     │     └── ✓ WFA #9 — strategy.py
│     │
│     └── This Week ...
│
├── 📁 By Strategy
│     ├── strategy.py (24 runs)
│     └── momentum.py (18 runs)
│
└── 🔄 Compare
      [Select 2+ runs to compare]
```

**Interactions**:
- Double-click run → Opens Action view with results
- Multi-select + Compare → Opens comparison view
- Right-click → Pin, Delete, Export, View Artifacts

### 4.3.4 Trade Panel

**Purpose**: Control trading sessions.

```
TRADE
├── 🎮 Session Control
│     ┌─────────────────────────────────┐
│     │ Strategy: [strategy.py    ▼]   │
│     │ Account:  [Alpaca Paper   ▼]   │
│     │                                 │
│     │ [▶ Start Paper] [▶ Start Live] │
│     └─────────────────────────────────┘
│
├── 📊 Active Sessions
│     └── ● strategy.py (Paper)
│           Running 2h 15m │ +$380.00
│           [Pause] [Stop] [View]
│
├── 💰 Positions (All)
│     └── AAPL: 100 (+$380.00)
│
├── 📋 Open Orders
│     └── AAPL: Limit Sell @ $185
│
├── ⚠️ Risk Status
│     ├── Daily Loss: 45% of limit
│     └── [Risk Settings]
│
└── 🔌 Connections
      └── ● Alpaca (connected)
```

**Auto-expand**: Opens automatically when entering Trade view.

### 4.3.5 Settings Panel

**Purpose**: Configure Quantlab settings.

```
SETTINGS
├── 🔌 Broker Connections
│     ├── Alpaca [Configure]
│     └── [+ Add Broker]
│
├── 📊 Data Sources
│     ├── Alpaca Data (active)
│     └── [+ Add Source]
│
├── 🎨 Appearance
│     ├── Chart Theme
│     └── View Indicators
│
├── ⚡ Performance
│     ├── Max Workers
│     └── Memory Limit
│
├── 🔒 Safety
│     ├── Pre-trade Requirements
│     ├── Kill Switch Policy
│     └── Daily Limits
│
└── 📁 Storage
      └── Artifact Locations
```

---

# 5. History System

## 5.1 Architecture

History is accessible from two locations:
1. **History Dropdown** (window chrome) — Quick access
2. **History Panel** (Activity Bar) — Full exploration

Both share the same data store.

## 5.2 History Dropdown

### 5.2.1 Content Structure

```
┌─────────────────────────────────────────────┐
│ RUNNING                                     │
│ ├── ▶ Backtest: strategy.py (78%)          │
│ │    ████████████████░░░░░░░░░░ [Cancel]   │
│ └── ⏸ WFA: momentum.py (queued)            │
│      [Cancel] [Prioritize]                  │
│                                             │
│ ─────────────────────────────────────────── │
│ Filter: [All            ▼]                  │
│ ─────────────────────────────────────────── │
│                                             │
│ TODAY                                       │
│ ├── ✓ Backtest #52 — strategy.py           │
│ │     Sharpe: 1.24 · 2 hours ago           │
│ └── ✗ Backtest #51 — strategy.py           │
│       Error: Division by zero              │
│                                             │
│ YESTERDAY                                   │
│ └── ✓ WFA #8 — strategy.py                 │
│                                             │
│ ─────────────────────────────────────────── │
│ [Open History Panel]                        │
└─────────────────────────────────────────────┘
```

### 5.2.2 Interactions

| Action | Behavior |
|--------|----------|
| Click run | Opens Action view with results |
| Click Cancel | Cancels job (with confirmation) |
| Click Prioritize | Moves to front of queue |
| Click filter | Filters by type |
| Click "Open History Panel" | Opens full panel |

## 5.3 Data Model

```typescript
interface HistoryEntry {
  id: string;                    // "backtest-20260119-abc123"
  type: RunType;
  status: 'running' | 'queued' | 'completed' | 'failed' | 'cancelled';
  strategyPath: string;
  strategyHash: string;
  startedAt: Date;
  completedAt?: Date;
  progress?: number;             // 0-100
  
  // Results
  passed?: boolean;
  metrics?: Record<string, number>;
  warnings?: string[];
  errorMessage?: string;
  
  // Artifacts
  artifactPath: string;
  
  // User state
  pinned: boolean;
  tags: string[];
}
```

---

# 6. Tab Behavior & Compatibility

## 6.1 File Compatibility Matrix

| File Type | Editor | Chart | Action | Trade |
|-----------|--------|-------|--------|-------|
| `.py` (valid strategy) | ✓ | ✓ | ✓ | ✓ |
| `.py` (invalid strategy) | ✓ | ⚠ [1] | ⚠ [1] | ✗ |
| `.py` (utility module) | ✓ | ✗ | ✗ | ✗ |
| `.json`, `.yaml` | ✓ | ✗ | ✗ | ✗ |
| `.md`, `.txt` | ✓ | ✗ | ✗ | ✗ |
| Other text | ✓ | ✗ | ✗ | ✗ |
| Binary | ✓ [2] | ✗ | ✗ | ✗ |

**Notes**:
- [1] Shows validation errors in view with guidance
- [2] Read-only hex view

## 6.2 Strategy Validation

A `.py` file is recognized as a strategy if it contains ANY of:

```python
# Vectorized API (Chart Mode style)
def strategy(data):
    return ql.signals(...)

# Event-driven API
def on_bar(ctx):
    ...

# Class-based API
class MyStrategy(ql.Strategy):
    def on_bar(self, ctx):
        ...
```

**Validation timing**: On file open, on save, on view switch.

## 6.3 Disabled Button Behavior

When user clicks a disabled view button, show toast notification:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠️  Chart view is not available for this file                               │
│                                                                             │
│     Chart view requires a Python file with a valid strategy.                │
│     This file appears to be a utility module.                               │
│                                                                             │
│     [Learn about strategies]                              [Dismiss]         │
└─────────────────────────────────────────────────────────────────────────────┘
```

Toast auto-dismisses after 5 seconds.

## 6.4 Tab Naming

| Scenario | Tab Name |
|----------|----------|
| File in Editor view | `filename.py` |
| File in other view (same tab) | `filename.py` (with colored stripe) |
| File opened as view (new tab) | `filename.py (Chart)` / `filename.py (Action)` / `filename.py (Trade)` |

## 6.5 Tab Indicator Colors

| View | Stripe Color | CSS Variable |
|------|--------------|--------------|
| Editor | None | — |
| Chart | `#059669` (darker green) | `--ql-view-chart` |
| Action | `#D97706` (darker orange) | `--ql-view-action` |
| Trade | `#DC2626` (darker red) | `--ql-view-trade` |

These darker shades ensure accessibility when combined with any tab background.

---

# 7. Keyboard Shortcuts

## 7.1 Design Principle

All Quantlab-specific shortcuts use the **`Ctrl+Q` prefix** (or `Cmd+Q` on macOS) to avoid conflicts with VS Code defaults.

**Note**: On macOS, `Cmd+Q` is "Quit". Quantlab MUST intercept this and use it as prefix. Quit is relocated to `Cmd+Shift+Q`.

## 7.2 View Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q C` | Switch to Chart view |
| `Ctrl+Q A` | Switch to Action view |
| `Ctrl+Q T` | Switch to Trade view |
| `Ctrl+Q E` | Switch to Editor view |
| `Escape` | Return to Editor view (from any view) |

## 7.3 Action Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q B` | Run Backtest (quick action) |
| `Ctrl+Q R` | Re-run last action |
| `Ctrl+Q H` | Toggle History dropdown |
| `Ctrl+Q K` | Kill Switch (Trade view only, with confirmation) |
| `Ctrl+Q P` | Toggle AI Panel |

## 7.4 Panel Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q 1` | Focus Data panel |
| `Ctrl+Q 2` | Focus Resources panel |
| `Ctrl+Q 3` | Focus History panel |
| `Ctrl+Q 4` | Focus Trade panel |

## 7.5 Multi-Pane Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q Shift+C` | Open as Chart in new tab |
| `Ctrl+Q Shift+A` | Open as Action in new tab |
| `Ctrl+Q Shift+T` | Open as Trade in new tab |

## 7.6 Standard VS Code Shortcuts (Preserved)

These shortcuts are NOT overridden:
- `Ctrl+Shift+T` — Reopen closed tab
- `Ctrl+Shift+H` — Replace in files
- `Ctrl+K Ctrl+S` — Keyboard shortcuts
- `Ctrl+\` — Split editor
- All other standard VS Code bindings

---

# 8. Visual Design Tokens

## 8.1 View Indicators

```css
:root {
  /* View stripe colors (darker for accessibility) */
  --ql-view-chart: #059669;    /* Darker green */
  --ql-view-action: #D97706;   /* Darker orange */
  --ql-view-trade: #DC2626;    /* Darker red */
  
  /* Stripe dimensions */
  --ql-view-stripe-width: 3px;
}
```

## 8.2 Status Colors

```css
:root {
  /* Run status */
  --ql-status-running: #3B82F6;
  --ql-status-queued: #6B7280;
  --ql-status-completed: #10B981;
  --ql-status-failed: #EF4444;
  --ql-status-cancelled: #F59E0B;
  
  /* Trading P&L */
  --ql-pnl-positive: #10B981;
  --ql-pnl-negative: #EF4444;
  --ql-pnl-neutral: #6B7280;
  
  /* Complexity indicator */
  --ql-complexity-safe: #10B981;
  --ql-complexity-partial: #F59E0B;
  --ql-complexity-view-only: #EF4444;
}
```

## 8.3 Typography

```css
:root {
  --ql-font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --ql-font-size-metric: 1.25rem;
  --ql-font-weight-metric: 600;
}
```

---

# 9. Accessibility Requirements

## 9.1 Keyboard Navigation

All functionality MUST be accessible via keyboard:
- View buttons: Tab-focusable, Enter/Space to activate
- History dropdown: Arrow keys to navigate, Enter to select
- All panels: Standard VS Code keyboard navigation

## 9.2 Screen Reader Support

- View buttons: "Chart view button", "Action view button", etc.
- Tab with stripe: "strategy.py, Chart view" (announces view name)
- History entries: "Backtest 52, strategy.py, completed, Sharpe 1.24"
- Progress: "Backtest 78% complete" (announced at 25% intervals)

## 9.3 Color Contrast

**Tab indicator approach** (stripe, not filled background):
- Stripe colors are decorative enhancement
- Tab text remains standard VS Code colors
- Full WCAG AA compliance maintained

**Status/metric colors**:
- All status text meets 4.5:1 contrast minimum
- Icons supplement color (not color alone)

## 9.4 Reduced Motion

When `prefers-reduced-motion` is enabled:
- View transitions: Instant
- Progress bars: Static percentage only
- Panel expand/collapse: Instant

---

# 10. Error States and Recovery

## 10.1 Chart View Errors

| Error | Display | Recovery |
|-------|---------|----------|
| No data for symbol | "No data available for [SYMBOL]" | Change symbol, check data source |
| Visualization code error | Error message + line number | "Edit visualization code" button |
| Charting library crash | "Chart failed to render" | "Reload Chart" button |

## 10.2 Action View Errors

| Error | Display | Recovery |
|-------|---------|----------|
| Job failed | Error message + stack trace | "View Logs", "Retry" |
| Configuration invalid | Inline validation errors | Fix highlighted fields |
| Data unavailable | "Cannot load data for date range" | Adjust date range |

## 10.3 Trade View Errors

| Error | Display | Recovery |
|-------|---------|----------|
| Broker disconnected | Banner: "Broker connection lost" | Auto-reconnect + manual retry |
| Order rejected | Order row shows rejection reason | Modify and resubmit |
| Session crashed | "Session ended unexpectedly" | View logs, restart option |

## 10.4 Global Error Handling

Critical errors show modal dialog:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠️  Quantlab Engine Error                                                    │
│                                                                             │
│ The Quantlab engine encountered an unexpected error.                        │
│                                                                             │
│ Error: [brief description]                                                  │
│                                                                             │
│ Your work has been auto-saved. Active trading sessions have been paused.    │
│                                                                             │
│ [View Details]  [Report Issue]  [Restart Engine]                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# 11. Notifications System

## 11.1 Notification Types

| Type | Trigger | Display |
|------|---------|---------|
| Job complete | Backtest/test finishes | Toast + History badge |
| Job failed | Job encounters error | Toast (error style) + History badge |
| Trade executed | Order filled | Toast + sound (optional) |
| Risk alert | Limit approached | Modal (if critical) or toast |
| Session status | Start/stop/pause | Toast |

## 11.2 Toast Notifications

Position: Bottom-right corner
Duration: 5 seconds (auto-dismiss), permanent for errors until dismissed

```
┌─────────────────────────────────────┐
│ ✓ Backtest Complete                 │
│   strategy.py — Sharpe: 1.24        │
│   [View Results]         [Dismiss]  │
└─────────────────────────────────────┘
```

## 11.3 Sound Notifications

Optional sounds for:
- Trade executed (fill)
- Risk alert
- Job complete (long-running)

Configurable in Settings → Notifications.

## 11.4 Badge Indicators

- History button: Shows count of unviewed completed jobs
- Trade panel: Shows count of open orders

---

# 12. Drag-and-Drop Behaviors

## 12.1 Symbol Drag

| Source | Target | Action |
|--------|--------|--------|
| Data panel symbol | Chart view | Change chart symbol |
| Data panel symbol | Global selector | Change global symbol |
| Data panel symbol | Editor | Insert symbol string at cursor |
| Watchlist symbol | Another watchlist | Move/copy symbol |

## 12.2 File Drag

| Source | Target | Action |
|--------|--------|--------|
| Explorer file | Tab bar | Open file |
| Explorer file | Editor group | Open in that group |
| Tab | Another group | Move tab |

## 12.3 Run Drag

| Source | Target | Action |
|--------|--------|--------|
| History run | Editor | Insert run ID reference |
| History run | Chart view | Load run artifacts |
| History run | Compare area | Add to comparison |

---

# 13. Onboarding Flow

## 13.1 First Launch

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                        Welcome to Quantlab                                  │
│                                                                             │
│   Quantlab is a quantitative trading IDE built on VS Code.                  │
│                                                                             │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                        │
│   │  📝 Editor  │  │  📈 Chart   │  │  ⚡ Action  │                        │
│   │             │  │             │  │             │                        │
│   │  Write      │  │  Visualize  │  │  Test &     │                        │
│   │  strategies │  │  signals    │  │  analyze    │                        │
│   └─────────────┘  └─────────────┘  └─────────────┘                        │
│                                                                             │
│   Each strategy file can be viewed in different ways using                  │
│   the view buttons in the tab bar.                                          │
│                                                                             │
│   [Start with a Template]    [Open Existing]    [Skip Tour]                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 13.2 View Discovery

On first view switch, show tooltip:

```
     ┌─────────────────────────────────────────┐
     │ 💡 View Buttons                         │
     │                                         │
     │ These buttons change how you see        │
     │ your strategy file.                     │
     │                                         │
     │ • Editor: Write code                    │
     │ • Chart: See signals on price chart     │
     │ • Action: Run tests and backtests       │
     │ • Trade: Monitor live trading           │
     │                                         │
     │ Right-click a tab to open multiple      │
     │ views side-by-side.                     │
     │                                         │
     │                        [Got it]         │
     └─────────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│ strategy.py × │                              [Chart] [Action]...│
└─────────────────────────────────────────────────────────────────┘
```

## 13.3 Feature Discovery Triggers

| Trigger | Tooltip |
|---------|---------|
| First backtest complete | "View results in Chart" |
| First parameter edit | "Apply to Code to save permanently" |
| First Trade view | "Complete checklist before live trading" |
| 10+ runs accumulated | "Pin important runs in History" |

---

# 14. Appendices

## Appendix A: Migration from V7.0.1

| V7.0.1 | V8.1 |
|--------|------|
| Chart Mode | Chart view |
| Editor Mode | Editor view |
| Mode switch | View buttons |
| Visualiser panel | Chart view |
| Tester panel | Action view + Resources panel |
| Jobs panel | History dropdown + panel |

## Appendix B: Implementation Notes

### B.1 View State Storage

```typescript
// workspace.state.json structure
{
  "quantlab.globalSymbol": "AAPL",
  "quantlab.globalTimeframe": "1D",
  "quantlab.tabViewStates": {
    "/path/to/strategy.py": {
      "currentView": "chart",
      "chartState": { ... },
      "actionState": { ... }
    }
  }
}
```

### B.2 View Button Implementation

View buttons are registered as a custom editor toolbar contribution:

```typescript
// package.json
{
  "contributes": {
    "menus": {
      "editor/title": [
        {
          "command": "quantlab.switchToChart",
          "when": "resourceExtname == .py && quantlab.isStrategy",
          "group": "navigation@1"
        }
      ]
    }
  }
}
```

### B.3 Tab Stripe CSS

```css
.tab[data-ql-view="chart"]::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--ql-view-stripe-width);
  background-color: var(--ql-view-chart);
}
```

## Appendix C: Charting Integration

The charting software integration follows the Charting Integration Specification (separate document). Key interface:

```typescript
interface QuantlabChartAPI {
  initialize(container: HTMLElement, options: ChartOptions): void;
  setData(bars: OHLCVBar[]): void;
  addSignals(signals: SignalMarker[]): void;
  setEquityCurve(curve: EquityPoint[]): void;
  highlightBar(index: number): void;
  // ... see full spec
}
```

## Appendix D: Resources Integration

Custom tests are added via the Resources adapter interface (separate document):

```python
class ResearchTestAdapter(ABC):
    @property
    def test_type(self) -> str: ...
    def get_config_schema(self) -> dict: ...
    def run(self, strategy_code, data, params, config) -> ResearchResult: ...
```

---

*End of Quantlab UI/UX Specification V8.1 — Final*
