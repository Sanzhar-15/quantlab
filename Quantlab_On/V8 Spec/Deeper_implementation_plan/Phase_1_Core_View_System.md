# Phase 1: Core View System — Detailed Implementation Plan

**Duration**: 1-2 weeks
**Goal**: Fully implement V8.1 view framework (Editor/Chart/Action/Trade views) with proper state management, UI controls, and keybindings.
**Prerequisites**: Phase 0 Feasibility Spike completed

---

## Table of Contents

1. [Overview](#1-overview)
2. [Type System Implementation](#2-type-system-implementation)
3. [Strategy Detection & Validation](#3-strategy-detection--validation)
4. [Tab View State Manager](#4-tab-view-state-manager)
5. [View Manager Orchestrator](#5-view-manager-orchestrator)
6. [View Buttons UI](#6-view-buttons-ui)
7. [Tab Stripe Decorator](#7-tab-stripe-decorator)
8. [Tab Context Menu](#8-tab-context-menu)
9. [Keybindings](#9-keybindings)
10. [Commands Implementation](#10-commands-implementation)
11. [Verification Plan](#11-verification-plan)
12. [Exit Gates](#12-exit-gates)

---

## 1. Overview

### 1.1 What We're Building

Phase 1 establishes the foundational view system where each tab can independently display one of four views:

| View | Tab Indicator | Color | Purpose |
|------|---------------|-------|---------|
| **Editor** | None | — | Code editing (Monaco) |
| **Chart** | Green stripe | `#059669` | Visualization (placeholder) |
| **Action** | Orange stripe | `#D97706` | Test configuration (placeholder) |
| **Trade** | Red stripe | `#DC2626` | Live trading (placeholder) |

### 1.2 Key V8.1 Invariants (Must Hold)

- Views are **per-tab states**, NOT global modes
- View buttons at **right side of tab bar**
- Tab stripe is **3px left border**, not full fill
- Right-click tab → "Open as [View]" creates **new tab with independent state**
- Disabled buttons show **toast**, not error
- All keybindings use **`Ctrl+Q` prefix**

### 1.3 File Structure to Create

```
quantlab-extension/src/
├── types/
│   ├── index.ts              # Re-exports
│   ├── views.ts              # ViewType, TabViewState
│   └── strategy.ts           # StrategyEntrypoint, ComplexityLevel
├── core/
│   ├── state/
│   │   └── TabViewState.ts   # Per-tab view state manager
│   └── strategy/
│       └── StrategyValidator.ts
├── views/
│   └── ViewManager.ts        # Orchestrates view switching
├── ui/
│   ├── ViewButtons.ts        # Tab bar buttons
│   └── TabDecorator.ts       # Stripe colors
├── commands/
│   └── viewCommands.ts       # switchTo*, openAs*
└── utils/
    └── contextKeys.ts        # Context key management
```

---

## 2. Type System Implementation

### 2.1 Create `src/types/views.ts`

```typescript
export type ViewType = 'editor' | 'chart' | 'action' | 'trade';

export interface TabViewState {
  tabInstanceId: string;      // Unique per tab instance
  filePath: string;
  currentView: ViewType;
  chartState?: ChartState;
  actionState?: ActionState;
  tradeState?: TradeState;
}

export interface ChartState {
  symbol?: string;            // Override global
  timeframe?: string;         // Override global
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

export const VIEW_COLORS: Record<ViewType, string | null> = {
  editor: null,
  chart: '#059669',
  action: '#D97706',
  trade: '#DC2626',
};
```

### 2.2 Create `src/types/strategy.ts`

```typescript
export type StrategyEntrypoint =
  | { type: 'vectorized'; functionName: 'strategy' }
  | { type: 'eventDriven'; functionName: 'on_bar' }
  | { type: 'classBased'; className: string };

export type ComplexityLevel = 'safe' | 'partial' | 'viewOnly';

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

export interface StrategyValidationResult {
  isValid: boolean;
  entrypoint: StrategyEntrypoint | null;
  complexity: ComplexityLevel;
  parameters: ParameterDefinition[];
  hasVisualizationCode: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  line: number;
  message: string;
  code: string;
}

export interface ValidationWarning {
  line: number;
  message: string;
  code: string;
}
```

---

## 3. Strategy Detection & Validation

### 3.1 Create `src/core/strategy/StrategyValidator.ts`

**Purpose**: Detect if a file is a valid strategy and extract metadata.

```typescript
import * as vscode from 'vscode';
import { StrategyValidationResult, StrategyEntrypoint } from '../../types/strategy';

export class StrategyValidator {
  private static instance: StrategyValidator;

  // Detection patterns from V8.1 §6.2
  private readonly VECTORIZED_PATTERN = /def\s+strategy\s*\(\s*data\s*\)/;
  private readonly EVENT_DRIVEN_PATTERN = /def\s+on_bar\s*\(\s*ctx\s*\)/;
  private readonly CLASS_BASED_PATTERN = /class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)/;

  static getInstance(): StrategyValidator {
    if (!this.instance) {
      this.instance = new StrategyValidator();
    }
    return this.instance;
  }

  isStrategyFile(doc: vscode.TextDocument): boolean {
    if (doc.languageId !== 'python') return false;
    if (!doc.fileName.endsWith('.py')) return false;
    return this.detectEntrypoint(doc) !== null;
  }

  detectEntrypoint(doc: vscode.TextDocument): StrategyEntrypoint | null {
    const text = doc.getText();

    if (this.VECTORIZED_PATTERN.test(text)) {
      return { type: 'vectorized', functionName: 'strategy' };
    }

    if (this.EVENT_DRIVEN_PATTERN.test(text)) {
      return { type: 'eventDriven', functionName: 'on_bar' };
    }

    const classMatch = text.match(this.CLASS_BASED_PATTERN);
    if (classMatch) {
      return { type: 'classBased', className: classMatch[1] };
    }

    return null;
  }

  validateStrategy(doc: vscode.TextDocument): StrategyValidationResult {
    const entrypoint = this.detectEntrypoint(doc);

    if (!entrypoint) {
      return {
        isValid: false,
        entrypoint: null,
        complexity: 'viewOnly',
        parameters: [],
        hasVisualizationCode: false,
        errors: [{ line: 0, message: 'No valid strategy entrypoint found', code: 'NO_ENTRYPOINT' }],
        warnings: [],
      };
    }

    // TODO: Implement parameter extraction from ql.param() calls
    // TODO: Implement complexity analysis
    // TODO: Implement visualization code detection

    return {
      isValid: true,
      entrypoint,
      complexity: 'safe',
      parameters: [],
      hasVisualizationCode: false,
      errors: [],
      warnings: [],
    };
  }
}
```

**Triggers to Implement**:
- `onDidOpenTextDocument` — Validate on file open
- `onDidSaveTextDocument` — Re-validate on save
- View switch — Validate before switching

---

## 4. Tab View State Manager

### 4.1 Create `src/core/state/TabViewState.ts`

> **CRITICAL**: State MUST be keyed by tab instance ID, NOT by file URI alone!

```typescript
import * as vscode from 'vscode';
import { ViewType, TabViewState } from '../../types/views';

export class TabViewStateManager {
  private static instance: TabViewStateManager;
  private states: Map<string, TabViewState> = new Map();
  private context: vscode.ExtensionContext;

  private readonly _onDidChangeView = new vscode.EventEmitter<{
    tabInstanceId: string;
    uri: string;
    view: ViewType;
  }>();
  readonly onDidChangeView = this._onDidChangeView.event;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.restore();
  }

  static initialize(context: vscode.ExtensionContext): TabViewStateManager {
    if (!this.instance) {
      this.instance = new TabViewStateManager(context);
    }
    return this.instance;
  }

  static getInstance(): TabViewStateManager {
    if (!this.instance) {
      throw new Error('TabViewStateManager not initialized');
    }
    return this.instance;
  }

  /**
   * Generate unique tab instance ID.
   * Uses VS Code tab identity if available, otherwise generates from URI + timestamp.
   */
  getTabInstanceId(editor: vscode.TextEditor): string {
    // Try to use VS Code's TabGroups API
    const tabGroups = vscode.window.tabGroups;
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          if (tab.input.uri.toString() === editor.document.uri.toString()) {
            // Use tab's unique identity if we can derive it
            // Fallback: generate from URI + group index + tab index
            const groupIdx = tabGroups.all.indexOf(group);
            const tabIdx = group.tabs.indexOf(tab);
            return `${editor.document.uri.toString()}::${groupIdx}::${tabIdx}`;
          }
        }
      }
    }

    // Fallback: URI-based (may cause collisions with multi-tab same file)
    return editor.document.uri.toString();
  }

  getState(tabInstanceId: string): TabViewState | undefined {
    return this.states.get(tabInstanceId);
  }

  getCurrentView(tabInstanceId: string): ViewType {
    return this.states.get(tabInstanceId)?.currentView ?? 'editor';
  }

  setCurrentView(tabInstanceId: string, filePath: string, view: ViewType): void {
    const existing = this.states.get(tabInstanceId);
    const state: TabViewState = {
      tabInstanceId,
      filePath,
      currentView: view,
      chartState: existing?.chartState,
      actionState: existing?.actionState,
      tradeState: existing?.tradeState,
    };

    this.states.set(tabInstanceId, state);
    this.persist();

    this._onDidChangeView.fire({ tabInstanceId, uri: filePath, view });
  }

  removeState(tabInstanceId: string): void {
    this.states.delete(tabInstanceId);
    this.persist();
  }

  private persist(): void {
    const serialized = Object.fromEntries(this.states);
    this.context.workspaceState.update('quantlab.tabViewStates', serialized);
  }

  private restore(): void {
    const saved = this.context.workspaceState.get<Record<string, TabViewState>>('quantlab.tabViewStates');
    if (saved) {
      this.states = new Map(Object.entries(saved));
      this.cleanupOrphaned();
    }
  }

  private cleanupOrphaned(): void {
    // TODO: Remove entries for tabs that no longer exist
  }
}
```

---

## 5. View Manager Orchestrator

### 5.1 Create `src/views/ViewManager.ts`

```typescript
import * as vscode from 'vscode';
import { ViewType } from '../types/views';
import { TabViewStateManager } from '../core/state/TabViewState';
import { StrategyValidator } from '../core/strategy/StrategyValidator';
import { updateContextKeys } from '../utils/contextKeys';

export class ViewManager {
  private static instance: ViewManager;

  static getInstance(): ViewManager {
    if (!this.instance) {
      this.instance = new ViewManager();
    }
    return this.instance;
  }

  canSwitchToView(editor: vscode.TextEditor, view: ViewType): boolean {
    if (view === 'editor') return true;

    const validator = StrategyValidator.getInstance();
    return validator.isStrategyFile(editor.document);
  }

  async switchView(editor: vscode.TextEditor, view: ViewType): Promise<void> {
    if (!this.canSwitchToView(editor, view)) {
      this.showIncompatibleToast(view);
      return;
    }

    const stateManager = TabViewStateManager.getInstance();
    const tabInstanceId = stateManager.getTabInstanceId(editor);

    stateManager.setCurrentView(tabInstanceId, editor.document.uri.fsPath, view);

    // Update context keys for when-clause
    updateContextKeys(view, true);

    // Auto-expand Activity Bar panel
    this.autoExpandPanel(view);

    // TODO Phase 3+: Swap editor pane content for Chart/Action/Trade views
    // For now, this is a state-only change
  }

  async openAsView(uri: vscode.Uri, view: ViewType): Promise<void> {
    // Open new tab with view suffix
    const viewLabel = view.charAt(0).toUpperCase() + view.slice(1);

    // Open the document in a new editor group
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });

    // Set initial view state
    const stateManager = TabViewStateManager.getInstance();
    const tabInstanceId = stateManager.getTabInstanceId(editor);
    stateManager.setCurrentView(tabInstanceId, uri.fsPath, view);

    updateContextKeys(view, true);
  }

  private showIncompatibleToast(viewName: string): void {
    const capitalizedView = viewName.charAt(0).toUpperCase() + viewName.slice(1);
    vscode.window.showInformationMessage(
      `${capitalizedView} view requires a valid strategy file.`,
      'Learn about strategies'
    ).then(selection => {
      if (selection) {
        vscode.env.openExternal(vscode.Uri.parse('https://docs.quantlab.dev/strategies'));
      }
    });
  }

  private autoExpandPanel(view: ViewType): void {
    switch (view) {
      case 'action':
        vscode.commands.executeCommand('quantlab.resourcesPanel.focus');
        break;
      case 'trade':
        vscode.commands.executeCommand('quantlab.tradePanel.focus');
        break;
    }
  }
}
```

---

## 6. View Buttons UI

### 6.1 Update `package.json` Contributions

```json
{
  "contributes": {
    "commands": [
      {
        "command": "quantlab.switchToChart",
        "title": "Chart",
        "icon": "$(graph)",
        "category": "Quantlab"
      },
      {
        "command": "quantlab.switchToAction",
        "title": "Action",
        "icon": "$(beaker)",
        "category": "Quantlab"
      },
      {
        "command": "quantlab.switchToTrade",
        "title": "Trade",
        "icon": "$(pulse)",
        "category": "Quantlab"
      },
      {
        "command": "quantlab.switchToEditor",
        "title": "Editor",
        "icon": "$(code)",
        "category": "Quantlab"
      }
    ],
    "menus": {
      "editor/title": [
        {
          "command": "quantlab.switchToEditor",
          "when": "resourceExtname == .py && quantlab.isStrategy && quantlab.currentView != editor",
          "group": "navigation@0"
        },
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
        }
      ]
    }
  }
}
```

---

## 7. Tab Stripe Decorator

### 7.1 Create `src/ui/TabDecorator.ts`

**Option A: Emoji Prefix Fallback** (if CSS injection fails in Phase 0)

```typescript
import * as vscode from 'vscode';
import { ViewType, VIEW_COLORS } from '../types/views';

const VIEW_EMOJI: Record<ViewType, string> = {
  editor: '',
  chart: '🟢 ',
  action: '🟠 ',
  trade: '🔴 ',
};

export class TabDecorator {
  static getTabLabel(fileName: string, view: ViewType): string {
    const prefix = VIEW_EMOJI[view];
    const suffix = view !== 'editor' ? ` (${view.charAt(0).toUpperCase() + view.slice(1)})` : '';
    return `${prefix}${fileName}${suffix}`;
  }
}
```

**Option B: CSS Injection** (preferred, if Phase 0 proves feasible)

```typescript
// Inject CSS via workbench contributions or fork patch
// .tab[data-ql-view="chart"]::before {
//   content: '';
//   position: absolute;
//   left: 0;
//   top: 0;
//   bottom: 0;
//   width: 3px;
//   background: #059669;
// }
```

---

## 8. Tab Context Menu

### 8.1 Update `package.json`

```json
{
  "contributes": {
    "commands": [
      {
        "command": "quantlab.openAsChart",
        "title": "Open as Chart (new tab)",
        "category": "Quantlab"
      },
      {
        "command": "quantlab.openAsAction",
        "title": "Open as Action (new tab)",
        "category": "Quantlab"
      },
      {
        "command": "quantlab.openAsTrade",
        "title": "Open as Trade (new tab)",
        "category": "Quantlab"
      }
    ],
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

---

## 9. Keybindings

### 9.1 Update `package.json`

```json
{
  "contributes": {
    "keybindings": [
      {
        "key": "ctrl+q c",
        "command": "quantlab.switchToChart",
        "when": "editorFocus && quantlab.isStrategy"
      },
      {
        "key": "ctrl+q a",
        "command": "quantlab.switchToAction",
        "when": "editorFocus && quantlab.isStrategy"
      },
      {
        "key": "ctrl+q t",
        "command": "quantlab.switchToTrade",
        "when": "editorFocus && quantlab.isStrategy"
      },
      {
        "key": "ctrl+q e",
        "command": "quantlab.switchToEditor",
        "when": "editorFocus"
      },
      {
        "key": "escape",
        "command": "quantlab.switchToEditor",
        "when": "quantlab.currentView != editor && quantlab.isStrategy"
      },
      {
        "key": "ctrl+q shift+c",
        "command": "quantlab.openAsChart",
        "when": "editorFocus && quantlab.isStrategy"
      },
      {
        "key": "ctrl+q shift+a",
        "command": "quantlab.openAsAction",
        "when": "editorFocus && quantlab.isStrategy"
      },
      {
        "key": "ctrl+q shift+t",
        "command": "quantlab.openAsTrade",
        "when": "editorFocus && quantlab.isStrategy"
      }
    ]
  }
}
```

> **macOS Note**: If `Cmd+Q` conflicts with OS quit, use `Cmd+K Q` prefix as fallback. Document in `DEVIATIONS.md`.

---

## 10. Commands Implementation

### 10.1 Create `src/commands/viewCommands.ts`

```typescript
import * as vscode from 'vscode';
import { ViewManager } from '../views/ViewManager';
import { ViewType } from '../types/views';

export function registerViewCommands(context: vscode.ExtensionContext): void {
  const viewManager = ViewManager.getInstance();

  // Switch commands (in-place)
  context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.switchToChart', () =>
      switchToView('chart')),
    vscode.commands.registerCommand('quantlab.switchToAction', () =>
      switchToView('action')),
    vscode.commands.registerCommand('quantlab.switchToTrade', () =>
      switchToView('trade')),
    vscode.commands.registerCommand('quantlab.switchToEditor', () =>
      switchToView('editor')),
  );

  // Open as commands (new tab)
  context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.openAsChart', () =>
      openAsView('chart')),
    vscode.commands.registerCommand('quantlab.openAsAction', () =>
      openAsView('action')),
    vscode.commands.registerCommand('quantlab.openAsTrade', () =>
      openAsView('trade')),
  );

  async function switchToView(view: ViewType): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await viewManager.switchView(editor, view);
  }

  async function openAsView(view: ViewType): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await viewManager.openAsView(editor.document.uri, view);
  }
}
```

### 10.2 Create `src/utils/contextKeys.ts`

```typescript
import * as vscode from 'vscode';
import { ViewType } from '../types/views';

let currentViewContext: vscode.Disposable | undefined;
let isStrategyContext: vscode.Disposable | undefined;

export function updateContextKeys(view: ViewType, isStrategy: boolean): void {
  vscode.commands.executeCommand('setContext', 'quantlab.currentView', view);
  vscode.commands.executeCommand('setContext', 'quantlab.isStrategy', isStrategy);
}

export function clearContextKeys(): void {
  vscode.commands.executeCommand('setContext', 'quantlab.currentView', undefined);
  vscode.commands.executeCommand('setContext', 'quantlab.isStrategy', false);
}
```

---

## 11. Verification Plan

### 11.1 Unit Tests

**File**: `test/unit/core/StrategyValidator.test.ts`

```typescript
describe('StrategyValidator', () => {
  it('detects vectorized strategy pattern', () => {
    const code = `def strategy(data):\n    return data`;
    expect(detectEntrypoint(code)).toEqual({ type: 'vectorized', functionName: 'strategy' });
  });

  it('detects event-driven strategy pattern', () => {
    const code = `def on_bar(ctx):\n    pass`;
    expect(detectEntrypoint(code)).toEqual({ type: 'eventDriven', functionName: 'on_bar' });
  });

  it('detects class-based strategy pattern', () => {
    const code = `class MyStrategy(ql.Strategy):\n    pass`;
    expect(detectEntrypoint(code)).toEqual({ type: 'classBased', className: 'MyStrategy' });
  });

  it('returns null for non-strategy files', () => {
    const code = `def helper():\n    pass`;
    expect(detectEntrypoint(code)).toBeNull();
  });
});
```

**Run Command**: `npm test -- --grep "StrategyValidator"`

### 11.2 Integration Tests

**File**: `test/integration/viewSwitching.test.ts`

```typescript
describe('View Switching', () => {
  it('switches view in-place without creating new tab', async () => {
    const doc = await openStrategyFile('test_strategy.py');
    const initialTabCount = getTabCount();

    await vscode.commands.executeCommand('quantlab.switchToChart');

    expect(getTabCount()).toBe(initialTabCount);
    expect(getCurrentView()).toBe('chart');
  });

  it('shows toast for non-strategy file', async () => {
    await openFile('utils.py');
    await vscode.commands.executeCommand('quantlab.switchToChart');

    // Verify toast shown (check notification history)
  });

  it('independent state for multiple tabs of same file', async () => {
    await openStrategyFile('momentum.py');
    await vscode.commands.executeCommand('quantlab.openAsChart');

    // Tab A should still be Editor, Tab B should be Chart
    // Verify via state manager
  });

  it('persists view state across reload', async () => {
    await openStrategyFile('momentum.py');
    await vscode.commands.executeCommand('quantlab.switchToChart');

    await reloadWindow();

    expect(getCurrentView()).toBe('chart');
  });
});
```

**Run Command**: `npm run test:integration`

### 11.3 Manual Verification Checklist

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1 | View button visibility | Open `.py` strategy file | View buttons (Chart/Action/Trade) appear in tab bar RHS |
| 2 | View switch in-place | Click "Chart" button | Tab content changes, tab count unchanged, green stripe appears |
| 3 | Disabled button toast | Open non-strategy `.py` file, click Chart | Toast: "Chart view requires valid strategy" |
| 4 | "Open as View" context menu | Right-click tab → "Open as Chart" | New tab opens with "(Chart)" suffix |
| 5 | Independent tab state | Open same file twice, switch one to Chart | First tab = Editor, second = Chart |
| 6 | Keybinding Ctrl+Q C | Focus strategy file, press Ctrl+Q then C | Switches to Chart view |
| 7 | Escape returns to Editor | In Chart view, press Escape | Returns to Editor view |
| 8 | State persistence | Switch to Chart, reload window | View still Chart after reload |

---

## 12. Exit Gates

Phase 1 is complete when:

- [ ] Type definitions in `src/types/` compile without errors
- [ ] `StrategyValidator.isStrategyFile()` correctly detects all three patterns
- [ ] View switching works in-place (same tab, content changes)
- [ ] "Open as View" creates new tab with correct naming: `filename.py (Chart)`
- [ ] Tab stripe/indicator displays correct color for each view
- [ ] Disabled button shows informational toast (not error)
- [ ] All keybindings work (`Ctrl+Q C`, `Ctrl+Q A`, `Ctrl+Q T`, `Ctrl+Q E`, `Escape`)
- [ ] State persists across window reload
- [ ] macOS keybinding deviation documented if applicable
- [ ] All unit tests pass
- [ ] All integration tests pass

---

## Appendix A: Dependency Order

Build components in this order:

1. **Types** (`views.ts`, `strategy.ts`) — No dependencies
2. **ContextKeys** (`contextKeys.ts`) — No dependencies
3. **StrategyValidator** — Depends on types
4. **TabViewStateManager** — Depends on types
5. **TabDecorator** — Depends on types
6. **ViewManager** — Depends on all above
7. **viewCommands** — Depends on ViewManager
8. **package.json contributions** — Wire everything together

---

## Appendix B: Known Limitations for Phase 1

1. **View content is placeholder**: Chart/Action/Trade views show placeholder content (actual webviews come in later phases)
2. **Tab stripe may use emoji fallback**: CSS injection depends on Phase 0 findings
3. **No parameter panel**: Parameter extraction from `ql.param()` is stubbed
4. **No complexity analysis**: Always returns "safe" for valid strategies
