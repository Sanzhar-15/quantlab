# Quantlab V8.1 — Optimal Implementation Plan (Final)
## Cursor-Ready Engineering Specification

**Document type**: Engineering Implementation Plan  
**Applies to**: Quantlab UI/UX Specification V8.1 Final  
**Date**: 2026-01-19  
**Estimated Duration**: 14-18 weeks (solo) / 8-10 weeks (2 developers)

---

## Table of Contents

1. Cursor Execution Instructions
2. Non-Negotiable V8.1 Invariants
3. Architecture Decisions
4. Project Structure
5. Phased Implementation Plan
6. Detailed Engineering Checklist
7. Test Plan
8. Risk Register
9. Definition of Done
10. Common Pitfalls to Avoid
11. Spec Coverage Checklist
12. Cursor Prompting Guide

---

# 1. Cursor Execution Instructions

## 1.1 Core Principles

1. **Spec is source of truth.** Implement what V8.1 specifies verbatim. Do not invent UI.

2. **Thin-fork + extension architecture.** Keep VS Code upstream drift manageable:
   - Implement most logic as extensions/webviews
   - Patch workbench only where extension APIs cannot satisfy V8.1

3. **Vertical slices.** Every phase ends with a demoable, testable loop—not a half-finished subsystem.

4. **Test as you build.** Add integration tests per phase that assert key behaviors.

5. **Performance is a feature.** Use control/data plane split:
   - Control plane: Small JSON (commands, state, progress)
   - Data plane: Binary/Arrow (OHLCV, signals, equity curves)

## 1.2 When You're Stuck

1. Check V8.1 spec section referenced in the task
2. If spec is ambiguous, document the ambiguity and make a reasonable choice
3. If implementation is infeasible, document deviation with rationale
4. Never silently deviate from spec

---

# 2. Non-Negotiable V8.1 Invariants

These invariants MUST hold at all times. If any cannot be satisfied, escalate.

## 2.1 Views System

| Invariant | Reference |
|-----------|-----------|
| Views are **per-tab states**, not global modes | §1.1 |
| Four views: Editor / Chart / Action / Trade | §1.1 |
| View buttons at **right side of tab bar** | §2.3.2 |
| Tab stripe is **3px left border**, not full fill | §2.3.4 |
| Right-click tab → "Open as [View]" creates new tab | §3.3.1 |
| Disabled buttons show toast, not error | §6.3 |

## 2.2 Activity Bar

| Invariant | Reference |
|-----------|-----------|
| Activity Bar = navigation only | §1.2, §4.1 |
| Quantlab panels: Data, Resources, History, Trade, Settings | §4.1 |
| NO Visualiser or Tester icons in Activity Bar | §1.2 |

## 2.3 Window Chrome

| Invariant | Reference |
|-----------|-----------|
| Global Symbol/Timeframe selectors in chrome | §2.2.2 |
| History dropdown button in chrome | §2.2.3 |
| Both persist per-workspace | §2.7.1 |

## 2.4 Keyboard Shortcuts

| Invariant | Reference |
|-----------|-----------|
| All Quantlab shortcuts use **`Ctrl+Q` prefix** | §7.1 |
| VS Code default bindings remain intact | §7.6 |
| No shortcut collisions | §7 |

## 2.5 Safety & Degradation

| Invariant | Reference |
|-----------|-----------|
| Complexity indicator: Safe / Partial / View-Only | §3.6 |
| View-Only shows artifacts only, Trade blocked | §3.6.4 |
| Kill Switch reflects configured policy | §3.1.4 |

---

# 3. Architecture Decisions

## 3.1 Target Architecture

**Thin VS Code fork + first-party extension**

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Fork (Minimal Patches)           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Workbench Patches:                                   │    │
│  │  • Title bar: Symbol/TF selectors + History button   │    │
│  │  • Tab bar: View buttons position + stripe CSS       │    │
│  │  • Hide/relocate layout buttons                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│                              ▼                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Quantlab Extension (Most Logic):                     │    │
│  │  • View state manager                                │    │
│  │  • Commands & keybindings                            │    │
│  │  • Activity Bar panels (TreeViews)                   │    │
│  │  • Webviews for Chart/Action/Trade                   │    │
│  │  • Strategy validation & complexity analysis         │    │
│  │  • Engine communication layer                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│                              ▼                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Engine Host (Separate Process):                      │    │
│  │  • Backtest runner                                   │    │
│  │  • Job queue                                         │    │
│  │  • Data service                                      │    │
│  │  • Broker adapters                                   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 3.2 View Rendering Strategy

**Single "Quantlab Multi-View Editor" concept:**

| View | Rendering |
|------|-----------|
| Editor | Native Monaco editor (default) |
| Chart | Webview replacing editor pane |
| Action | Webview replacing editor pane |
| Trade | Webview replacing editor pane |

**In-place switching:**
- Switching view does NOT create new tab
- Same tab, different content
- Requires fork-level support if extension API cannot swap editor pane

**"Open as View" (new tab):**
- Creates separate tab instance
- Tab naming: `filename.py (Chart)`
- Independent state

## 3.3 UI ↔ Engine Contract

**Control Plane (JSON):**
```typescript
// Commands
{ type: 'runBacktest', strategyPath: string, config: BacktestConfig }
{ type: 'cancelJob', jobId: string }
{ type: 'subscribeSymbol', symbol: string, timeframe: string }

// Events
{ type: 'jobProgress', jobId: string, progress: number, message: string }
{ type: 'jobComplete', jobId: string, result: JobResult }
{ type: 'tick', symbol: string, price: number, timestamp: number }
```

**Data Plane (Binary/Arrow preferred):**
```
OHLCV bars:     Arrow IPC or MessagePack
Signals:        Arrow IPC or JSON array
Equity curve:   Arrow IPC or Float64Array
Chart updates:  Incremental patches
```

If engine supports Arrow IPC, adopt from day one for chart payloads.

## 3.4 State Persistence

| State | Scope | Storage |
|-------|-------|---------|
| Global Symbol/TF | Per-workspace | `workspaceState` |
| Tab View State | Per-workspace | `workspaceState` |
| History Entries | Per-user | `globalState` |
| Watchlists | Per-user | `globalState` |
| Settings | Per-user | VS Code settings |

---

# 4. Project Structure

```
quantlab-extension/
├── package.json                      # Extension manifest
├── tsconfig.json
├── webpack.config.js
├── src/
│   ├── extension.ts                  # Entry point
│   │
│   ├── types/
│   │   ├── index.ts                  # Re-exports
│   │   ├── views.ts                  # ViewType, TabViewState, etc.
│   │   ├── strategy.ts               # StrategyEntrypoint, ValidationResult, etc.
│   │   ├── history.ts                # HistoryEntry, RunType, RunStatus
│   │   ├── trading.ts                # Session, Position, Order, KillSwitchPolicy
│   │   └── engine.ts                 # Control/data plane message types
│   │
│   ├── core/
│   │   ├── state/
│   │   │   ├── GlobalState.ts        # Symbol/TF + events
│   │   │   ├── TabViewState.ts       # Per-tab view state + persistence
│   │   │   └── HistoryState.ts       # Run history + persistence
│   │   │
│   │   ├── strategy/
│   │   │   ├── StrategyValidator.ts  # Detect entrypoints, validate
│   │   │   ├── ParameterExtractor.ts # Parse ql.param() calls
│   │   │   ├── ComplexityAnalyzer.ts # Safe/Partial/ViewOnly
│   │   │   └── VisualizationDetector.ts
│   │   │
│   │   └── engine/
│   │       ├── EngineHost.ts         # IPC to engine process
│   │       ├── JobQueue.ts           # Job management
│   │       └── DataService.ts        # Market data requests
│   │
│   ├── views/
│   │   ├── ViewManager.ts            # Orchestrates view switching
│   │   │
│   │   ├── editor/
│   │   │   ├── EditorEnhancements.ts # IntelliSense, diagnostics
│   │   │   └── completions.json      # ql.* API completions
│   │   │
│   │   ├── chart/
│   │   │   ├── ChartViewProvider.ts  # CustomTextEditorProvider
│   │   │   ├── ChartWebview.ts       # Webview management
│   │   │   ├── ChartAPI.ts           # QuantlabChartAPI wrapper
│   │   │   └── webview/
│   │   │       ├── index.html
│   │   │       ├── chart.ts          # Webview script
│   │   │       ├── chart.css
│   │   │       └── parameterPanel.ts # Slider controls
│   │   │
│   │   ├── action/
│   │   │   ├── ActionViewProvider.ts
│   │   │   ├── ActionWebview.ts
│   │   │   ├── QuickActions.ts       # Default configurations
│   │   │   └── webview/
│   │   │       ├── index.html
│   │   │       ├── action.ts
│   │   │       ├── action.css
│   │   │       ├── selectionState.ts
│   │   │       ├── configState.ts
│   │   │       ├── runningState.ts
│   │   │       └── resultsState.ts
│   │   │
│   │   └── trade/
│   │       ├── TradeViewProvider.ts
│   │       ├── TradeWebview.ts
│   │       ├── KillSwitch.ts         # Policy execution
│   │       └── webview/
│   │           ├── index.html
│   │           ├── trade.ts
│   │           └── trade.css
│   │
│   ├── panels/
│   │   ├── data/
│   │   │   ├── DataPanelProvider.ts
│   │   │   ├── SymbolTreeProvider.ts
│   │   │   └── WatchlistManager.ts
│   │   │
│   │   ├── resources/
│   │   │   ├── ResourcesPanelProvider.ts
│   │   │   ├── ResourcesTreeProvider.ts
│   │   │   └── resourcesCatalog.json # Static catalog
│   │   │
│   │   ├── history/
│   │   │   ├── HistoryPanelProvider.ts
│   │   │   ├── HistoryTreeProvider.ts
│   │   │   └── HistoryDropdown.ts    # Window chrome dropdown
│   │   │
│   │   ├── trade/
│   │   │   ├── TradePanelProvider.ts
│   │   │   ├── TradeTreeProvider.ts
│   │   │   └── SessionManager.ts
│   │   │
│   │   └── settings/
│   │       ├── SettingsPanelProvider.ts
│   │       └── SettingsTreeProvider.ts
│   │
│   ├── ui/
│   │   ├── ViewButtons.ts            # Tab bar buttons
│   │   ├── TabDecorator.ts           # Stripe colors
│   │   ├── GlobalSelectors.ts        # Symbol/TF in chrome
│   │   ├── Notifications.ts          # Toasts, badges
│   │   └── Onboarding.ts             # First-run experience
│   │
│   ├── commands/
│   │   ├── index.ts                  # Register all commands
│   │   ├── viewCommands.ts           # switchTo*, openAs*
│   │   ├── actionCommands.ts         # runBacktest, rerun, etc.
│   │   ├── tradeCommands.ts          # startSession, killSwitch
│   │   └── historyCommands.ts        # pin, delete, compare
│   │
│   └── utils/
│       ├── logger.ts                 # Output channel logging
│       ├── config.ts                 # Settings access
│       ├── constants.ts              # Colors, patterns
│       └── contextKeys.ts            # Context key management
│
├── media/
│   ├── icons/                        # Panel icons, button icons
│   └── styles/
│       └── tabStripe.css             # Injected CSS for stripes
│
├── test/
│   ├── unit/
│   │   ├── state/
│   │   ├── strategy/
│   │   └── views/
│   ├── integration/
│   │   ├── viewSwitching.test.ts
│   │   ├── historyFlow.test.ts
│   │   └── parameterSync.test.ts
│   └── e2e/
│       ├── beginnerFlow.test.ts
│       ├── intermediateFlow.test.ts
│       └── proFlow.test.ts
│
└── docs/
    ├── DEVELOPMENT.md
    ├── ARCHITECTURE.md
    ├── USER_GUIDE.md
    └── DEVIATIONS.md                 # Any spec deviations + rationale
```

---

# 5. Phased Implementation Plan

## Phase 0: Feasibility Spike (3-5 days)

### Goal
Validate architectural assumptions before committing to implementation approach.

### Spike Tasks

#### 0.1 View Button Placement
```
□ Attempt: Add view buttons via contributes.menus["editor/title"]
□ Verify: Buttons appear at tab bar RHS for .py files
□ If FAIL: Document that workbench patch is required
```

#### 0.2 Tab Stripe Styling
```
□ Attempt: Inject CSS via extension for tab stripe
□ Test: Apply 3px left border to active tab
□ If FAIL: Document workbench patch requirement
```

#### 0.3 In-Place View Switching
```
□ Attempt: Replace editor pane content without new tab
□ Test: Switch Editor → Chart → Editor, same tab instance
□ If FAIL: Document fork patch requirement (this is likely)
```

#### 0.4 Window Chrome Elements
```
□ Attempt: Add StatusBarItem for Symbol/TF selectors
□ Verify: Positioned center-right in title area
□ If positioning impossible: Document StatusBar alternative
```

#### 0.5 Ctrl+Q Prefix (macOS Critical)
```
□ Test on macOS: Does Cmd+Q get intercepted by OS?
□ If YES: Test alternative (Cmd+K Q or Cmd+Shift+Q prefix)
□ Document: macOS keybinding deviation if required
```

#### 0.6 Tab Instance Identity (CRITICAL)
```
V8.1 requires multiple tab instances of the SAME file with INDEPENDENT state:
- strategy.py (Editor view) = Tab A
- strategy.py (Chart view via "Open as Chart") = Tab B
- Both tabs must have independent view state

□ Spike: Determine how to generate stable tab instance IDs
  
  Option A (Fork path):
  - Patch workbench to expose internal tab ID
  
  Option B (Extension path):
  - Generate: tabInstanceId = `${uri}#${viewType}#${openTimestamp}`
  - Or use VS Code's TabGroups API if sufficient
  
□ Test: Open same file twice, verify different IDs
□ Test: "Open as Chart (new tab)" creates third distinct ID
□ Document: Chosen approach in FEASIBILITY_REPORT.md
```

**WHY THIS IS CRITICAL**: If state is keyed only by file URI, tabs of the same file will overwrite each other's state. This breaks the entire "Open as View (new tab)" feature.

#### 0.7 Tab View State Persistence
```
□ Implement: Save view state to workspaceState keyed by tabInstanceId
□ Test: Reload window, verify state restored
□ Verify: Multiple tabs of same file persist independently
```

### Exit Gate
- [ ] View switching works (even if hacky)
- [ ] State persists across reload
- [ ] **Documented**: Fork patch list with rationale
- [ ] **Documented**: macOS keybinding decision

### Deliverable
`docs/FEASIBILITY_REPORT.md` containing:
- What works via extension API
- What requires fork patches
- macOS keybinding decision
- Recommended architecture confirmation

---

## Phase 1: Core View System (1-2 weeks)

### Goal
Fully implement V8.1 view framework (without full Chart/Action/Trade internals).

### 1.1 Type Definitions

```typescript
// src/types/views.ts

export type ViewType = 'editor' | 'chart' | 'action' | 'trade';

export interface TabViewState {
  filePath: string;
  currentView: ViewType;
  chartState?: ChartState;
  actionState?: ActionState;
  tradeState?: TradeState;
}

export interface ChartState {
  symbol?: string;           // Override global
  timeframe?: string;        // Override global
  parameterOverrides: Record<string, any>;
  scrollPosition?: number;
}

export interface ActionState {
  selectedAction: string | null;
  configuration: Record<string, any>;
  lastRunId: string | null;
}

export interface TradeState {
  sessionId: string | null;
}
```

```typescript
// src/types/strategy.ts

export type StrategyEntrypoint = 
  | { type: 'vectorized'; functionName: 'strategy' }
  | { type: 'eventDriven'; functionName: 'on_bar' }
  | { type: 'classBased'; className: string };

export type ComplexityLevel = 'safe' | 'partial' | 'viewOnly';

export interface StrategyValidationResult {
  isValid: boolean;
  entrypoint: StrategyEntrypoint | null;
  complexity: ComplexityLevel;
  parameters: ParameterDefinition[];
  hasVisualizationCode: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ParameterDefinition {
  id: string;
  default: any;
  min?: number;
  max?: number;
  step?: number;
  choices?: any[];
  name?: string;
  group?: string;
  description?: string;
  format?: 'percent' | 'currency' | 'number';
}
```

### 1.2 Strategy Detection & Validation

```
□ Create src/core/strategy/StrategyValidator.ts

Methods:
- isStrategyFile(doc: TextDocument): boolean
- validateStrategy(doc: TextDocument): StrategyValidationResult
- detectEntrypoint(doc: TextDocument): StrategyEntrypoint | null

Detection patterns (§6.2):
- /def\s+strategy\s*\(\s*data\s*\)/
- /def\s+on_bar\s*\(\s*ctx\s*\)/
- /class\s+\w+\s*\(\s*ql\.Strategy\s*\)/

Triggers: onOpen, onSave, onViewSwitch
```

### 1.3 View State Manager (CRITICAL: Per-Tab-Instance, NOT Per-File)

```
□ Create src/core/state/TabViewState.ts

⚠️ CRITICAL: State MUST be keyed by tab instance ID, NOT by file URI alone!

V8.1 requires:
- strategy.py (Editor) = Tab A with own state
- strategy.py (Chart via "Open as") = Tab B with INDEPENDENT state
- Keying by URI alone causes state collisions

Tab Instance ID Generation:
- Use VS Code's tab identity if available via API
- Otherwise: tabInstanceId = `${uri}::${viewKind}::${openTimestamp}`
- Must be stable for a tab's lifetime but unique per instance

Implement:
- Map<tabInstanceId, TabViewState> keyed by instance ID
- Methods:
  - getState(tabInstanceId: string): TabViewState
  - setState(tabInstanceId: string, state: Partial<TabViewState>): void
  - getCurrentView(tabInstanceId: string): ViewType
  - setCurrentView(tabInstanceId: string, view: ViewType): void
  - removeState(tabInstanceId: string): void  // Call on tab close
  - getTabInstanceId(editor: TextEditor): string  // Derive from editor

Events:
- onDidChangeView: Event<{ tabInstanceId: string, uri: string, view: ViewType }>

Persistence:
- Save to context.workspaceState on every change
- Restore in activate()
- Clean up orphaned entries (tabs that no longer exist)

VERIFICATION TEST (must pass before proceeding):
1. Open strategy.py → Tab A
2. Open strategy.py again → Tab B (same file, new tab)
3. Right-click Tab A → "Open as Chart" → Tab C
4. Switch Tab A to Action view
5. ASSERT: Tab B is still Editor view
6. ASSERT: Tab C is still Chart view
7. Reload window
8. ASSERT: All three tabs restore their independent states
```

**Reference**: V8.1 §2.7.2, §3.3.2

**Acceptance**: 
- View state is per-tab-instance, NOT per-file
- Same file in multiple tabs maintains independent state
- "Open as View (new tab)" creates new instance with own state

### 1.4 View Manager (Orchestrator)

```
□ Create src/views/ViewManager.ts

Implement:
- switchView(editor: TextEditor, view: ViewType): Promise<void>
- canSwitchToView(editor: TextEditor, view: ViewType): boolean
- openAsView(uri: Uri, view: ViewType): Promise<void>

Logic:
1. Check file compatibility (isStrategyFile)
2. If incompatible, show toast (§6.3)
3. Update TabViewState
4. Fire onDidChangeView event
5. Auto-expand Activity Bar panel:
   - Action → Resources
   - Trade → Trade

Context Keys (update on switch):
- quantlab.isStrategy: boolean
- quantlab.currentView: ViewType
- quantlab.canSwitchToChart: boolean
- quantlab.canSwitchToAction: boolean
- quantlab.canSwitchToTrade: boolean
```

### 1.5 View Buttons

```
□ Create src/ui/ViewButtons.ts

Register in package.json:
{
  "contributes": {
    "menus": {
      "editor/title": [
        {
          "command": "quantlab.switchToChart",
          "when": "resourceExtname == .py && quantlab.isStrategy && quantlab.currentView != chart",
          "group": "navigation@1"
        },
        {
          "command": "quantlab.switchToAction",
          "when": "resourceExtname == .py && quantlab.isStrategy && quantlab.currentView != action",
          "group": "navigation@2"
        },
        {
          "command": "quantlab.switchToTrade",
          "when": "resourceExtname == .py && quantlab.isStrategy && quantlab.currentView != trade",
          "group": "navigation@3"
        },
        {
          "command": "quantlab.switchToEditor",
          "when": "resourceExtname == .py && quantlab.isStrategy && quantlab.currentView != editor",
          "group": "navigation@0"
        }
      ]
    }
  }
}

Button icons:
- Chart: $(graph)
- Action: $(beaker)
- Trade: $(pulse)
- Editor: $(code)
```

### 1.6 Tab Stripe

```
□ Create src/ui/TabDecorator.ts

Implementation (choose based on Phase 0 findings):

Option A (CSS injection):
- Inject CSS: .tab[data-ql-view="chart"]::before { ... }
- Set data attribute on tab DOM element

Option B (Tab rename prefix):
- Editor: "strategy.py"
- Chart: "🟢 strategy.py"
- Action: "🟠 strategy.py"
- Trade: "🔴 strategy.py"

Option C (Workbench patch):
- Modify tab rendering to include stripe based on view state

Colors (§6.5):
- Chart: #059669
- Action: #D97706
- Trade: #DC2626
```

### 1.7 Tab Context Menu

```
□ Register in package.json

{
  "contributes": {
    "menus": {
      "editor/title/context": [
        {
          "command": "quantlab.openAsChart",
          "when": "resourceExtname == .py && quantlab.isStrategy",
          "group": "quantlab@1"
        },
        {
          "command": "quantlab.openAsAction",
          "when": "resourceExtname == .py && quantlab.isStrategy",
          "group": "quantlab@2"
        },
        {
          "command": "quantlab.openAsTrade",
          "when": "resourceExtname == .py && quantlab.isStrategy",
          "group": "quantlab@3"
        }
      ]
    }
  }
}
```

### 1.8 Keybindings

```
□ Register in package.json (§7)

{
  "contributes": {
    "keybindings": [
      // View switching
      { "key": "ctrl+q c", "command": "quantlab.switchToChart", "when": "editorFocus" },
      { "key": "ctrl+q a", "command": "quantlab.switchToAction", "when": "editorFocus" },
      { "key": "ctrl+q t", "command": "quantlab.switchToTrade", "when": "editorFocus" },
      { "key": "ctrl+q e", "command": "quantlab.switchToEditor", "when": "editorFocus" },
      { "key": "escape", "command": "quantlab.switchToEditor", "when": "quantlab.currentView != editor" },
      
      // Quick actions
      { "key": "ctrl+q b", "command": "quantlab.runBacktest" },
      { "key": "ctrl+q r", "command": "quantlab.rerunLastAction" },
      { "key": "ctrl+q h", "command": "quantlab.toggleHistoryDropdown" },
      { "key": "ctrl+q k", "command": "quantlab.killSwitch", "when": "quantlab.currentView == trade" },
      { "key": "ctrl+q p", "command": "quantlab.toggleAIPanel" },
      
      // Panel focus
      { "key": "ctrl+q 1", "command": "quantlab.focusDataPanel" },
      { "key": "ctrl+q 2", "command": "quantlab.focusResourcesPanel" },
      { "key": "ctrl+q 3", "command": "quantlab.focusHistoryPanel" },
      { "key": "ctrl+q 4", "command": "quantlab.focusTradePanel" },
      
      // Multi-pane
      { "key": "ctrl+q shift+c", "command": "quantlab.openAsChart" },
      { "key": "ctrl+q shift+a", "command": "quantlab.openAsAction" },
      { "key": "ctrl+q shift+t", "command": "quantlab.openAsTrade" }
    ]
  }
}

// macOS: If Cmd+Q intercept fails, use:
{ "key": "cmd+k q c", "command": "quantlab.switchToChart", "when": "editorFocus && isMac" }
// Document in DEVIATIONS.md
```

### 1.9 Commands Implementation

```
□ Create src/commands/viewCommands.ts

export function registerViewCommands(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand('quantlab.switchToChart', async () => {
      const editor = window.activeTextEditor;
      if (!editor) return;
      
      const viewManager = ViewManager.getInstance();
      if (!viewManager.canSwitchToView(editor, 'chart')) {
        showIncompatibleToast('Chart');
        return;
      }
      
      await viewManager.switchView(editor, 'chart');
    }),
    
    commands.registerCommand('quantlab.openAsChart', async () => {
      const editor = window.activeTextEditor;
      if (!editor) return;
      
      const viewManager = ViewManager.getInstance();
      await viewManager.openAsView(editor.document.uri, 'chart');
    }),
    
    // ... similar for action, trade, editor
  );
}

function showIncompatibleToast(viewName: string) {
  window.showInformationMessage(
    `${viewName} view requires a valid strategy file.`,
    'Learn about strategies'
  ).then(selection => {
    if (selection) {
      env.openExternal(Uri.parse('https://docs.quantlab.dev/strategies'));
    }
  });
}
```

### Exit Gate
- [ ] View switching works in-place
- [ ] "Open as View" creates new tab with correct naming
- [ ] Tab stripe/indicator shows correctly
- [ ] Disabled button shows toast
- [ ] All keybindings work (document macOS deviation if any)
- [ ] State persists across reload

### Tests (Phase 1)
```typescript
// test/integration/viewSwitching.test.ts

describe('View Switching', () => {
  it('switches view in-place without creating new tab', async () => {
    const doc = await openStrategyFile('momentum.py');
    const initialTabCount = getTabCount();
    
    await commands.executeCommand('quantlab.switchToChart');
    
    expect(getTabCount()).toBe(initialTabCount);
    expect(getCurrentView()).toBe('chart');
  });
  
  it('shows toast for non-strategy file', async () => {
    const doc = await openFile('utils.py'); // Not a strategy
    
    await commands.executeCommand('quantlab.switchToChart');
    
    expect(getLastNotification()).toContain('requires a valid strategy');
  });
  
  it('persists view state across reload', async () => {
    await openStrategyFile('momentum.py');
    await commands.executeCommand('quantlab.switchToChart');
    
    await reloadWindow();
    
    expect(getCurrentView()).toBe('chart');
  });
});
```

---

## Phase 2: Window Chrome + Activity Bar + History (2-3 weeks)

### Goal
Implement navigation surfaces and global state.

### 2.1 Global State Manager

```
□ Create src/core/state/GlobalState.ts

interface GlobalMarketState {
  symbol: string;      // Default: "AAPL"
  timeframe: string;   // Default: "1D"
  dateRange?: { start: Date; end: Date };
}

Implement:
- Singleton pattern
- getSymbol(), setSymbol(s)
- getTimeframe(), setTimeframe(tf)
- Events: onDidChangeSymbol, onDidChangeTimeframe
- Persist to workspaceState
- Restore on activate()

Consumers:
- Chart view: Reloads data on change
- Action view: Pre-fills defaults
- Trade view: Does NOT change active sessions
```

### 2.2 Global Selectors UI

```
□ Create src/ui/GlobalSelectors.ts

Implementation (based on Phase 0):

Option A (StatusBarItem):
- Two items: symbolItem, timeframeItem
- Priority: 100 (center-right)
- Click → QuickPick

Option B (Title bar via fork):
- Custom title bar contribution
- Dropdown menus

QuickPick contents:
- Symbol: Recent symbols, Watchlist symbols, Search
- Timeframe: 1m, 5m, 15m, 1H, 4H, 1D, 1W, 1M
```

### 2.3 History State Manager

```
□ Create src/core/state/HistoryState.ts

interface HistoryEntry {
  id: string;                    // "backtest-20260119-abc123"
  type: RunType;                 // backtest | wfa | monte_carlo | ...
  status: RunStatus;             // running | queued | completed | failed | cancelled
  strategyPath: string;
  strategyHash: string;
  config: Record<string, any>;
  startedAt: Date;
  completedAt?: Date;
  progress?: number;
  metrics?: Record<string, number>;
  warnings?: string[];
  errorMessage?: string;
  artifactPath?: string;
  pinned: boolean;
  tags: string[];
}

Implement:
- Max 1000 entries (FIFO eviction, keep pinned)
- CRUD operations
- Query: byStrategy, byType, byStatus, recent
- Events: onAdd, onUpdate, onDelete
- Persist to globalState (user-level)

Integration:
- Engine job events populate history
- UI reads from history
```

### 2.4 History Dropdown

```
□ Create src/panels/history/HistoryDropdown.ts

Implementation: StatusBarItem + QuickPick

StatusBarItem:
- Text: "$(history) History"
- Badge: Count of unviewed completed jobs
- Tooltip: "View running jobs and history"

On click → QuickPick with sections:
- RUNNING (with progress bars via description)
- ────────────────────
- Filter: [All ▼]
- ────────────────────
- TODAY
- YESTERDAY
- ────────────────────
- [Open History Panel]

QuickPick items:
- Running: "▶ Backtest: strategy.py (78%)" + [Cancel] button
- Completed: "✓ Backtest #52 — Sharpe: 1.24 — 2h ago"
- Failed: "✗ Backtest #51 — Error — 3h ago"

Actions:
- Select completed → Open Action view with results
- Select failed → Open Action view with error
- Cancel → Cancel job via engine
```

### 2.5 Activity Bar Panels

#### 2.5.1 Data Panel
```
□ Create src/panels/data/DataPanelProvider.ts
□ Create src/panels/data/SymbolTreeProvider.ts

Tree structure:
├── 🔍 Symbol Search (welcomeView with input)
├── ⭐ Watchlists
│   ├── Tech Giants (5)
│   │   ├── AAPL
│   │   └── ...
│   └── [+ New Watchlist]
├── 📋 Universes
│   ├── S&P 500
│   └── NASDAQ 100
└── 🔌 Data Sources
    ├── ● Alpaca (connected)
    └── [+ Add Source]

Interactions:
- Double-click symbol → setGlobalSymbol()
- Drag symbol → DataTransfer with symbol string
- Right-click → "Open Chart", "Add to Watchlist"
```

#### 2.5.2 Resources Panel
```
□ Create src/panels/resources/ResourcesPanelProvider.ts
□ Create src/panels/resources/ResourcesTreeProvider.ts

Tree structure (static from resourcesCatalog.json):
├── 📊 Backtesting
│   ├── Standard Backtest
│   └── Streaming Backtest
├── ⚡ Optimization
│   ├── Grid Search
│   └── Bayesian
├── 🎲 Overfitting Tests
│   ├── Walk-Forward Analysis
│   ├── Monte Carlo
│   ├── CPCV
│   ├── PBO
│   └── Deflated Sharpe
├── 📈 Statistical Tests
│   └── ...
├── 📄 Templates
│   └── ...
└── 📚 Guides
    └── ...

Interactions:
- Double-click test → switchToAction() with test preselected
- Double-click template → Create new file from template
- Hover → Description tooltip
```

#### 2.5.3 History Panel
```
□ Create src/panels/history/HistoryPanelProvider.ts
□ Create src/panels/history/HistoryTreeProvider.ts

Tree structure:
├── 🔍 Search (welcomeView)
├── 📌 Pinned
│   └── ...
├── 📅 Recent
│   ├── Today
│   ├── Yesterday
│   └── This Week
├── 📁 By Strategy
│   └── ...
└── 🔄 Compare ([0] selected)

Interactions:
- Double-click → Open Action view with results
- Multi-select + Compare → Open comparison view
- Right-click → Pin, Delete, Export, View Artifacts
- Drag to Chart → Load artifacts
```

#### 2.5.4 Trade Panel
```
□ Create src/panels/trade/TradePanelProvider.ts
□ Create src/panels/trade/TradeTreeProvider.ts

Tree structure:
├── 🎮 Session Control
│   ├── Strategy: [dropdown]
│   ├── Account: [dropdown]
│   └── [▶ Start Paper] [▶ Start Live]
├── 📊 Active Sessions
│   └── ● strategy.py (Paper)
│       └── Running 2h | +$380
├── 💰 Positions
│   └── AAPL: 100 (+$380)
├── 📋 Open Orders
│   └── ...
├── ⚠️ Risk Status
│   └── Daily Loss: 45%
└── 🔌 Connections
    └── ● Alpaca
```

#### 2.5.5 Settings Panel
```
□ Create src/panels/settings/SettingsPanelProvider.ts

Tree structure:
├── 🔌 Broker Connections
├── 📊 Data Sources
├── 🎨 Appearance
├── ⚡ Performance
├── 🔒 Safety
└── 📁 Storage

Click → Opens relevant VS Code settings or custom webview
```

### 2.6 Drag-and-Drop Infrastructure

```
□ Implement drag sources

DataPanel symbols:
- TreeDragAndDropController
- DataTransfer: text/plain = symbol string

History runs:
- DataTransfer: application/quantlab-run = runId
```

### Exit Gate
- [ ] Global Symbol/TF selectors work and persist
- [ ] History dropdown shows running/recent, actions work
- [ ] All 5 Activity Bar panels render
- [ ] Basic panel interactions work
- [ ] Drag-and-drop symbols to Chart view works

### Tests (Phase 2)
```typescript
describe('Global State', () => {
  it('symbol change updates Chart view', async () => {
    await openChartView('momentum.py');
    
    await setGlobalSymbol('MSFT');
    
    expect(getChartSymbol()).toBe('MSFT');
  });
});

describe('History', () => {
  it('completed job appears in dropdown', async () => {
    await runBacktest('momentum.py');
    await waitForJobComplete();
    
    const dropdown = await openHistoryDropdown();
    
    expect(dropdown.items).toContainMatch(/Backtest.*momentum\.py/);
  });
});
```

---

## Phase 3: Chart View MVP (3-5 weeks)

### Goal
Integrate charting engine as Chart view with full V8.1 features.

### 3.1 Chart Webview Shell

```
□ Create src/views/chart/ChartViewProvider.ts

Implement CustomTextEditorProvider:
- resolveCustomTextEditor(doc, webviewPanel, token)
- Create webview with enableScripts: true
- Load chart.html
- Set up message passing

□ Create src/views/chart/webview/index.html

Structure:
┌─────────────────────────────────────────────────────────────┐
│ [AAPL ▼] [1D ▼] [Date Range]     [Complexity: ●●●○○ Safe]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    CHART CONTAINER                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ PARAMETERS                                        [▼ Hide]  │
│ fast_period  [10] ├────●────────┤ [5-50]                   │
│ slow_period  [20] ├──────────●──┤ [10-100]                 │
│                           [Reset] [Apply to Code]           │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Chart API Wrapper

```
□ Create src/views/chart/ChartAPI.ts

interface QuantlabChartAPI {
  // Lifecycle
  initialize(container: HTMLElement, options: ChartOptions): void;
  dispose(): void;
  
  // Data
  setData(bars: OHLCVBar[]): void;
  appendBar(bar: OHLCVBar): void;
  
  // Overlays
  addSignals(signals: SignalMarker[]): void;
  clearSignals(): void;
  setEquityCurve(curve: EquityPoint[]): void;
  
  // Interaction
  highlightBar(index: number): void;
  setTheme(theme: 'light' | 'dark'): void;
  
  // Export
  screenshot(): Promise<Blob>;
}

Wrap your charting software to implement this interface.
```

### 3.3 Data Pipeline

```
□ Implement chart data loading

On entering Chart view:
1. Get symbol/TF (global state or tab override)
2. Request data from DataService
3. Send to webview via postMessage
4. Chart renders

On global symbol/TF change:
1. If Chart view is active
2. Reload data
3. Update chart

Data format (prefer binary):
- Arrow IPC if supported
- Fallback: JSON with typed arrays
```

### 3.4 First-Time UX (No Visualization Code)

```
□ Implement "no visualization code" state

Detect: !hasVisualizationCode(document)

Show prompt:
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   This strategy doesn't have visualization code yet.        │
│                                                             │
│   [📝 Add Manually]    [🤖 Generate with AI]                │
│                                                             │
│   [Learn about visualization code]                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘

"Add Manually" → Insert template visualize() function
"Generate with AI" → Open AI panel, generate code
```

### 3.5 Visualization Code Execution

```
□ Implement safe visualization execution

If visualize(chart) exists:
1. Execute in sandboxed Python context
2. chart proxy records commands: plot(), mark_entries(), etc.
3. Commands serialized to JSON
4. Sent to webview
5. ChartAPI applies commands

If absent:
- Basic OHLCV chart
- Default entry/exit markers from signals
```

### 3.6 Parameter Panel

```
□ Create src/views/chart/webview/parameterPanel.ts

Extract parameters from ParameterExtractor.
Render:
- Grouped by param.group
- Slider for numeric (min/max/step)
- Dropdown for choices
- Checkbox for boolean
- Format display (percent, etc.)

State:
- Track overrides vs defaults
- Persist in TabViewState.chartState.parameterOverrides

Actions:
- Slider change → Update chart (debounced)
- "Reset to Defaults" → Clear overrides, reload
- "Apply to Code" → Rewrite source file with new values
```

### 3.7 Apply to Code

```
□ Implement source code rewriting

On "Apply to Code":
1. Parse ql.param() calls in source
2. Replace default values with current overrides
3. Preserve formatting (best effort)
4. Apply edit via WorkspaceEdit
5. Clear overrides (now they're defaults)
```

### 3.8 Complexity Indicator

```
□ Implement complexity display

Compute via ComplexityAnalyzer.

Display in toolbar:
- Safe: ●●●○○ (green) "Safe"
- Partial: ●●●●○ (yellow) "Partial"
- View-Only: ●●●●● (red) "View-Only"

View-Only behavior:
- Show banner: "Showing results from last backtest"
- Disable parameter sliders
- [Run New Backtest] button in banner
```

### 3.9 Chart Toolbar

```
□ Implement toolbar controls

- Symbol dropdown (can override global)
- Timeframe dropdown (can override global)
- Date range picker
- Refresh button
- Screenshot button
- Settings button (chart type, colors)
```

### Exit Gate
- [ ] Chart renders with OHLCV data
- [ ] Signals overlay correctly
- [ ] Parameter sliders work
- [ ] Apply to Code modifies source
- [ ] Complexity indicator shows correctly
- [ ] View-Only mode shows artifacts + banner
- [ ] Symbol/TF changes reload chart

### Tests (Phase 3)
```typescript
describe('Chart View', () => {
  it('renders strategy signals on chart', async () => {
    await openChartView('momentum.py');
    await runBacktest(); // Generate signals
    
    const signals = getChartSignals();
    
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].type).toMatch(/entry|exit/);
  });
  
  it('parameter slider updates chart', async () => {
    await openChartView('momentum.py');
    const initialSignals = getChartSignals();
    
    await setParameter('fast_period', 5);
    
    const newSignals = getChartSignals();
    expect(newSignals).not.toEqual(initialSignals);
  });
});
```

---

## Phase 4: Action View MVP (3-5 weeks)

### Goal
Make Action view the test runner and results surface.

### 4.1 Action View Provider

```
□ Create src/views/action/ActionViewProvider.ts

Similar to ChartViewProvider.
Webview with 4 states (Selection, Configuration, Running, Results).
```

### 4.2 Selection State

```
□ Implement selection state UI

Quick Actions grid:
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│ ▶ Backtest │ │ ⚡Optimize │ │ 🎲 Monte   │ │ 📈 WFA    │
└────────────┘ └────────────┘ │   Carlo    │ └────────────┘
                              └────────────┘

"More from Resources" section.
"Recent for this Strategy" list (from HistoryState).

Quick action click → Configuration state with defaults
Resource item click → Configuration state with that test
Recent item click → Results state with that run
```

### 4.3 Configuration State

```
□ Implement configuration state UI

Header: Test name + [← Back]

Sections:
- Configuration (test-specific fields, schema-driven)
- Data (Symbol, TF, Date range, Source, Pin revision checkbox)
- Strategy Parameters (radio: code defaults / chart overrides / specify)

[▶ Run {Test Name}] button
```

### 4.4 Running State

```
□ Implement running state UI

Status: ● RUNNING + Run ID
Progress bar with percentage
ETA display
Live log (scrolling, expandable)
[Cancel] button

Updates via engine IPC:
- jobProgress events → Update bar, ETA, log
```

### 4.5 Results State

```
□ Implement results state UI

Status badge: ✓ PASSED / ✗ FAILED
Run metadata (ID, duration, completion time)
Summary metrics (test-type specific)
Split details (expandable table)
Warnings section

Actions:
- [📈 View in Chart] → Switch to Chart, load artifacts
- [💾 Export] → Save results to file
- [📌 Pin Run] → Pin in history
- [🔗 Compare] → Open comparison view

[↻ Re-run] [← New Analysis]
```

### 4.6 Quick Action Defaults

```
□ Create src/views/action/QuickActions.ts

const QUICK_ACTION_DEFAULTS = {
  backtest: {
    useCodeDefaults: true,
    symbol: 'global',      // From GlobalState
    timeframe: 'global',
    dateRange: 'max',      // All available
  },
  optimize: {
    method: 'grid',
    metric: 'sharpe',
    useParamRanges: true,  // From ql.param min/max
  },
  monteCarlo: {
    simulations: 1000,
    method: 'shuffleTrades',
    confidenceInterval: 0.95,
  },
  wfa: {
    splits: 5,
    trainRatio: 0.7,
    metric: 'sharpe',
  },
};
```

### 4.7 View in Chart Flow

```
□ Implement "View in Chart" action

On click:
1. Get run artifacts (signals, equity curve, etc.)
2. Switch to Chart view
3. Load artifacts onto chart
4. Show banner: "Showing results from {Run Name}"
```

### 4.8 Resources → Action Binding

```
□ Implement Resources panel integration

Double-click test in Resources:
1. switchToAction()
2. Pre-select that test
3. Show Configuration state
```

### 4.9 History Integration

```
□ Implement history updates

On job start:
- Add entry with status: 'running'

On progress:
- Update entry progress

On complete:
- Update entry with results, metrics, artifacts

On cancel:
- Update entry with status: 'cancelled'
```

### Exit Gate
- [ ] Quick Actions work end-to-end
- [ ] Full state machine: Selection → Config → Running → Results
- [ ] View in Chart loads artifacts
- [ ] Results searchable/pinnable in History
- [ ] Resources double-click opens Action with test

### Tests (Phase 4)
```typescript
describe('Action View', () => {
  it('quick backtest runs end-to-end', async () => {
    await openActionView('momentum.py');
    await clickQuickAction('backtest');
    
    await waitForJobComplete();
    
    expect(getCurrentActionState()).toBe('results');
    expect(getResultsMetrics()).toHaveProperty('sharpe');
  });
  
  it('View in Chart loads run artifacts', async () => {
    await runBacktest('momentum.py');
    await clickResultsAction('viewInChart');
    
    expect(getCurrentView()).toBe('chart');
    expect(getChartBanner()).toContain('Showing results from');
  });
});
```

---

## Phase 5: Trade View MVP (4-7 weeks)

### Goal
Paper/live trading management surfaces.

### 5.1 Trade Panel Session Control

```
□ Implement session control in Trade panel

UI:
- Strategy dropdown (open strategy files)
- Account dropdown (configured brokers)
- [▶ Start Paper] [▶ Start Live] buttons

On Start:
1. Validate strategy (complexity check)
2. Create session via engine
3. Update panel state
4. If in Trade view, show active session UI
```

### 5.2 Trade View - No Session State

```
□ Implement no-session state

Content:
- "No active trading session" message
- [Open Trade Panel] button
- Requirements checklist with status indicators:
  - ✓/○ Valid strategy structure
  - ✓/○ Complexity Safe or Partial
  - ✓/○ Broker configured
  - ✓/○ At least one successful backtest
  - ○ Paper trading completed (recommended)
```

### 5.3 Trade View - Active Session State

```
□ Implement active session state

Header:
- Session type (Paper/Live)
- Account info
- Status: ● RUNNING
- Heartbeat indicator
- [🔴 KILL SWITCH: {Policy}]

Sections:
- Performance (Session P&L, Today, Open, Realized)
- Positions table (Symbol, Qty, Avg, Current, P&L, [Close])
- Open Orders table (ID, Type, Side, Qty, Price, Status, [Modify][Cancel])
- Recent Activity log

Footer:
- [⏸ Pause Session]
- [📊 View in Chart]
- [⚙️ Session Settings]
```

### 5.4 Kill Switch

```
□ Create src/views/trade/KillSwitch.ts

Read policy from settings:
- 'flatten': Cancel all orders + close all positions
- 'cancelOnly': Cancel orders, keep positions
- 'custom': User-defined sequence

Button label: "KILL SWITCH: {PolicyName}"

On click:
- Paper: Execute immediately
- Live: Show confirmation dialog
  "This will {policy description}. Are you sure?"
  [Cancel] [Confirm]

Execution:
- Send killSwitch command to engine
- Engine executes policy via broker adapter
- Update UI with results
```

### 5.5 Safety Gating

```
□ Implement trading safety checks

Complexity gating:
- View-Only → Block live trading entirely
- Partial → Show warning, require acknowledgment
- Safe → Allow

Pre-trade requirements (settings):
- Require backtest: boolean
- Require paper: boolean
- Review risk params: boolean
```

### 5.6 Trade → Chart Integration

```
□ Implement live chart overlays

When "View in Chart" from Trade view:
1. Switch to Chart view
2. Show live price data (streaming)
3. Overlay actual fills and orders
4. Real-time position visualization
```

### 5.7 Error States

```
□ Implement Trade view errors

Broker disconnected:
- Banner: "Broker connection lost. Reconnecting..."
- [Retry] button

Order rejected:
- Show reason in order row
- Red highlight

Session crashed:
- "Session ended unexpectedly"
- [View Logs] [Restart] buttons
```

### Exit Gate
- [ ] Paper session controllable
- [ ] Trade view shows live positions/orders
- [ ] Kill Switch works with correct policy
- [ ] View in Chart shows live data
- [ ] Complexity gating enforced
- [ ] Error states handled

### Tests (Phase 5)
```typescript
describe('Trade View', () => {
  it('blocks live trading for View-Only complexity', async () => {
    await openTradePanel();
    await selectStrategy('complex_strategy.py'); // View-Only
    
    expect(getStartLiveButton().disabled).toBe(true);
  });
  
  it('Kill Switch executes policy', async () => {
    await startPaperSession('momentum.py');
    await placeOrder('AAPL', 'buy', 100);
    
    await clickKillSwitch();
    
    expect(getOpenOrders()).toHaveLength(0);
  });
});
```

---

## Phase 6: Polish & Compliance (2-4 weeks)

### Goal
Complete remaining V8.1 requirements and polish.

### 6.1 Notifications System (§11)

```
□ Create src/ui/Notifications.ts

Toast types:
- Job complete: Info with [View Results] action
- Job failed: Error with [View Logs] action
- Trade executed: Info (if enabled in settings)
- Risk alert: Warning or modal (if critical)
- Session status: Info

Badge indicators:
- History dropdown: Unviewed completed count
- Trade panel: Open orders count

Optional sounds (settings):
- Fill sound
- Alert sound
```

### 6.2 Error Handling (§10)

```
□ Implement comprehensive error handling

Chart errors:
- No data: Message + change symbol option
- Visualization error: Error + line number + edit button
- Chart crash: Reload button

Action errors:
- Job failed: Error + stack trace + retry
- Config invalid: Inline validation
- Data unavailable: Adjust date range

Global errors:
- Engine crash: Modal with details
- Auto-save + pause sessions
- [Report Issue] [Restart Engine]
```

### 6.3 Drag-and-Drop (§12)

```
□ Complete drag-and-drop behaviors

Symbol drag:
- Data panel → Chart view: Change chart symbol
- Data panel → Global selector: Change global symbol
- Data panel → Editor: Insert symbol string
- Between watchlists: Move/copy

Run drag:
- History → Chart: Load run artifacts
- History → Editor: Insert run ID reference
```

### 6.4 Onboarding (§13)

```
□ Create src/ui/Onboarding.ts

First launch:
- Check globalState.onboardingComplete
- If false, show welcome modal
- Options: [Start with Template] [Open Existing] [Skip Tour]

View discovery:
- On first view switch, show tooltip
- Explain view buttons

Feature discovery triggers:
- First backtest complete → "View results in Chart" tip
- First param edit → "Apply to Code" tip
- First Trade view → "Complete checklist" tip
- 10+ runs → "Pin important runs" tip
```

### 6.5 Accessibility (§9)

```
□ Accessibility pass

Keyboard navigation:
- All view buttons Tab-focusable
- Enter/Space to activate
- Arrow keys in panels

Screen reader:
- View buttons: "Chart view button"
- Tab with stripe: "momentum.py, Chart view"
- History entries: "Backtest 52, momentum.py, completed, Sharpe 1.24"

Reduced motion:
- Check prefers-reduced-motion
- Disable animations if set
```

### 6.6 Final Polish

```
□ Polish tasks

- Review all UI text for consistency
- Verify icons in all themes
- Test light/dark/high-contrast themes
- Performance profiling
- Memory leak check
- Documentation review
```

### Exit Gate
- [ ] All V8.1 sections implemented
- [ ] Accessibility pass complete
- [ ] No regressions vs VS Code workflows
- [ ] Performance targets met

---

# 6. Detailed Engineering Checklist

## 6.1 View System
- [ ] `quantlab.switchView(tabId, view)` command
- [ ] `TabViewState` per tab instance, persisted
- [ ] Context keys and "when" clauses
- [ ] Disabled button toast (no throw)
- [ ] Right-click tab menu contributions
- [ ] "Open as View" creates second tab instance
- [ ] Tab stripe indicator (CSS or rename)

## 6.2 Global Symbol/Timeframe
- [ ] `GlobalMarketState` store (workspace-scoped)
- [ ] UI elements in title bar or status bar
- [ ] Events to Chart view on change

## 6.3 History System
- [ ] `HistoryEntry` store + persistence
- [ ] Engine job event integration
- [ ] Window chrome dropdown
- [ ] Activity Bar panel with full features
- [ ] Pin/tag/compare functionality

## 6.4 Chart Integration
- [ ] `QuantlabChartAPI` wrapper implemented
- [ ] OHLCV setData working
- [ ] Signal overlays working
- [ ] Equity curve working
- [ ] Chart state persistence
- [ ] Screenshot export

## 6.5 Parameter System
- [ ] Parse `ql.param` calls with metadata
- [ ] Render grouped sliders
- [ ] Overrides: in-memory, reset, apply-to-code
- [ ] Action view can read chart overrides

## 6.6 Action View
- [ ] Resource catalog in Activity Bar
- [ ] Adapter interface for tests
- [ ] State machine: selection → config → running → results
- [ ] Quick Actions with defaults
- [ ] View in Chart action
- [ ] Export, pin, compare actions

## 6.7 Trade View
- [ ] Trade panel session control
- [ ] Trade view UI states
- [ ] Kill Switch with policy + confirmation
- [ ] Complexity gating
- [ ] Live chart overlays

## 6.8 Cross-Cutting
- [ ] Notifications + optional sound
- [ ] Error recovery modals
- [ ] Onboarding tooltips
- [ ] Accessibility pass

---

# 7. Test Plan

## 7.1 Unit Tests

| Component | Tests |
|-----------|-------|
| StrategyValidator | Detect all 3 entrypoints, validation errors |
| ParameterExtractor | Extract params, handle edge cases |
| ComplexityAnalyzer | Categorize Safe/Partial/ViewOnly |
| GlobalState | Get/set, events, persistence |
| TabViewState | CRUD, persistence, multiple tabs |
| HistoryState | CRUD, max entries, persistence |

## 7.2 Integration Tests

| Flow | Assertions |
|------|------------|
| View switching in-place | Tab count unchanged, state updated |
| "Open as View" | New tab created, correct naming |
| Disabled button | Toast shown, no error thrown |
| Global symbol change | Chart view reloads |
| History dropdown | Running jobs shown, actions work |
| Quick backtest | Full flow to results |
| View in Chart | Artifacts loaded, banner shown |
| Parameter override | Chart updates |
| Apply to Code | Source modified correctly |

## 7.3 E2E Golden Path Tests

| Persona | Flow |
|---------|------|
| Beginner | Template → Edit → Chart → Quick Backtest → View Results |
| Intermediate | Code + Chart split → Param adjustment → Backtest with overrides |
| Pro | Multiple strategies → Multiple runs → Compare → Pin → Trade |

## 7.4 Non-Functional Tests

| Category | Tests |
|----------|-------|
| Performance | Chart payload size, UI freeze check |
| Memory | Memory cap, leak detection |
| Accessibility | Screen reader, reduced motion |

---

# 8. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **macOS Cmd+Q intercept** | High | High | Early spike; use `Cmd+K Q` prefix if needed; document deviation |
| **In-place view switching infeasible** | High | Medium | Fork patch for multi-view editor; document patch |
| **Tab stripe via extension impossible** | Medium | Medium | Use tab rename prefix; document approach |
| **Title bar elements via extension impossible** | Medium | Medium | Use StatusBar fallback; document deviation |
| **Chart webview performance** | High | Medium | Arrow/binary transport; incremental updates; downsampling |
| **VS Code upstream breaks patches** | Medium | Low | Minimize patches; feature flags; CI upstream tracking |

---

# 9. Definition of Done

Quantlab is V8.1-complete when:

- [ ] All UI/UX behaviors described in V8.1 exist and match spec
- [ ] View switching is per-tab, persistent, supports multi-pane
- [ ] Activity Bar is navigation only (no Visualiser/Tester icons)
- [ ] Chart view integrates charting engine with visualization code support
- [ ] Action view runs tests and shows results, integrated with History
- [ ] Trade view works for paper/live with Kill Switch policy
- [ ] Keyboard shortcuts are conflict-free using `Ctrl+Q` prefix
- [ ] All documented deviations are justified and signed off
- [ ] Test coverage > 80%
- [ ] Performance targets met (activation <500ms, view switch <100ms)
- [ ] Accessibility pass complete

---

# 10. Common Pitfalls to Avoid

These mistakes will cause rework. Explicitly avoid them:

| Pitfall | Why It's Wrong | Correct Approach |
|---------|----------------|------------------|
| **Keying view state only by `strategyPath`** | Breaks multi-tab "Open as (new tab)" — two tabs of same file collide | Key by `tabInstanceId` which includes URI + tab identity |
| **Storing parameter overrides by mutating source automatically** | V8.1 requires explicit "Apply to Code" action | Store overrides in `TabViewState.chartState`, only write on explicit action |
| **Making Chart view depend on Action view** | Views must be independent | Each view loads its own data; "View in Chart" passes artifacts, not dependencies |
| **Putting "Visualizer" or "Tester" in Activity Bar** | V8.1 explicitly removes these | Visualization is Chart view (tab), tests are Action view (tab) |
| **Global mode state** | V8.1 §1.1: "Views are per-tab states, not global modes" | Never have global `currentMode`, only per-tab `currentView` |
| **Assuming extension APIs can do everything** | Window chrome, tab stripe may require fork | Phase 0 spike decides; document deviations |
| **Using `Cmd+Q` on macOS without testing** | OS intercepts it as Quit | Test in Phase 0; use `Cmd+K Q` prefix if needed |

---

# 11. Spec Coverage Checklist

Use this to verify nothing is forgotten:

| V8.1 Section | Implemented In | Status | Notes |
|--------------|----------------|--------|-------|
| §1 Overview & Principles | All phases | ☐ | Core paradigm |
| §2.1-2.3 Window Layout | Phase 0, 2 | ☐ | Chrome requires feasibility decision |
| §2.3 Tab Bar | Phase 0, 1 | ☐ | View buttons + stripe |
| §2.7 Global/Tab State | Phase 1, 2 | ☐ | **Tab instance ID is critical** |
| §3.1.1 Editor View | Phase 1 | ☐ | IntelliSense enhancement |
| §3.1.2 Chart View | Phase 3 | ☐ | Charting engine integration |
| §3.1.3 Action View | Phase 4 | ☐ | 4-state machine |
| §3.1.4 Trade View | Phase 5 | ☐ | Kill Switch policy |
| §3.2 View Switching | Phase 1 | ☐ | In-place + new tab |
| §3.3 Multi-Pane | Phase 1 | ☐ | Right-click menu |
| §3.5 Parameter System | Phase 3 | ☐ | Sliders + Apply to Code |
| §3.6 Complexity Indicator | Phase 3 | ☐ | Safety gating |
| §3.7 Data Flow | Phase 3, 4 | ☐ | View in Chart |
| §3.8 Visualization Code | Phase 3 | ☐ | Optional visualize() |
| §4 Activity Bar | Phase 2 | ☐ | 5 panels, navigation-only |
| §5 History System | Phase 2, 4 | ☐ | Dropdown + panel |
| §6 Tab Compatibility | Phase 1 | ☐ | Validation + disabled UX |
| §7 Keyboard Shortcuts | Phase 1 | ☐ | Ctrl+Q chord + macOS |
| §8 Design Tokens | Phase 6 | ☐ | CSS variables |
| §9 Accessibility | Phase 6 | ☐ | Keyboard + screen reader |
| §10 Error States | Phase 6 | ☐ | Recovery flows |
| §11 Notifications | Phase 6 | ☐ | Toasts + badges |
| §12 Drag-and-Drop | Phase 2 | ☐ | Symbol + run drag |
| §13 Onboarding | Phase 6 | ☐ | First launch + tips |

---

# 12. Cursor Prompting Guide

## 12.1 Task Prompting Pattern

```
I'm implementing [Task X.Y: Task Name] for Quantlab.

Reference: V8.1 §[Section Number]

Files to create/modify:
- [File path 1]
- [File path 2]

Requirements:
- [Requirement 1 from spec]
- [Requirement 2 from spec]

Acceptance criteria:
- [Criterion 1]
- [Criterion 2]

Context files (already in project):
- [Related file 1]
- [Related file 2]

Please implement this following the V8.1 spec exactly.
```

## 12.2 Context Files Per Phase

| Phase | Context Files |
|-------|---------------|
| 0 | V8.1 spec, package.json |
| 1 | types/*.ts, V8.1 §2-3, §6-7 |
| 2 | core/state/*.ts, V8.1 §2.2, §4-5 |
| 3 | views/chart/*.ts, V8.1 §3.1.2, §3.5-3.8 |
| 4 | views/action/*.ts, V8.1 §3.1.3, §3.7 |
| 5 | views/trade/*.ts, V8.1 §3.1.4, §4.3.4 |
| 6 | ui/*.ts, V8.1 §9-13 |

## 12.3 When Stuck

1. Quote the exact V8.1 spec section
2. Describe what you've tried
3. Describe the specific failure
4. Ask for clarification or alternative approach

## 12.4 Deviation Documentation

If implementation cannot match spec:

```
// DEVIATION from V8.1 §X.Y
// Spec says: "..."
// Actual: "..."
// Reason: [Technical limitation / VS Code API constraint / etc.]
// Approved: [Yes/No/Pending]
```

---

*End of Optimal Implementation Plan*
