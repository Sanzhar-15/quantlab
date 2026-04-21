# Phase 0: Feasibility Spike — Detailed Implementation Plan

**Duration**: 3-5 days
**Goal**: Validate architectural assumptions before committing to implementation approach
**Prerequisites**: Quantlab VS Code fork is buildable and runnable

---

## Table of Contents

1. [Overview](#1-overview)
2. [Spike 0.1: View Button Placement](#2-spike-01-view-button-placement)
3. [Spike 0.2: Tab Stripe Styling](#3-spike-02-tab-stripe-styling)
4. [Spike 0.3: In-Place View Switching](#4-spike-03-in-place-view-switching)
5. [Spike 0.4: Window Chrome Elements](#5-spike-04-window-chrome-elements)
6. [Spike 0.5: macOS Ctrl+Q Keybinding](#6-spike-05-macos-ctrlq-keybinding)
7. [Spike 0.6: Tab Instance Identity](#7-spike-06-tab-instance-identity)
8. [Spike 0.7: Tab View State Persistence](#8-spike-07-tab-view-state-persistence)
9. [Deliverables](#8-deliverables)
10. [Exit Gates](#9-exit-gates)

---

## 1. Overview

### 1.1 Purpose of Phase 0

Phase 0 is a **feasibility spike** — a time-boxed investigation to determine what can be achieved through VS Code's extension APIs vs. what requires workbench patches to the fork.

**Why This Matters:**
- Many V8.1 features (view buttons, tab stripes, window chrome elements) may or may not be achievable via extension APIs
- Identifying fork patches early prevents wasted effort on impossible extension approaches
- Documents the thin-fork boundary cleanly

### 1.2 Spike Mindset

Each spike follows this pattern:
1. **Attempt** the extension-first approach
2. **Document** what works and what fails
3. **If fails**, identify the specific workbench patch required
4. **Create** a minimal proof-of-concept (not production code)

### 1.3 Files to Create

```
quantlab-extension/
├── src/
│   └── spike/                    # Temporary spike code (delete after Phase 0)
│       ├── viewButtonTest.ts
│       ├── tabStripeTest.ts
│       ├── viewSwitchTest.ts
│       ├── windowChromeTest.ts
│       ├── keybindingTest.ts
│       ├── tabInstanceTest.ts
│       └── statePersistenceTest.ts
└── docs/
    └── FEASIBILITY_REPORT.md     # Main deliverable
```

---

## 2. Spike 0.1: View Button Placement

### 2.1 Requirement (from V8.1 §2.3.2)

View buttons (`[Chart]`, `[Action]`, `[Trade]`) must appear at the **right side of the tab bar**, replacing VS Code's default layout buttons.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ strategy.py × │ tab2.py × │                      [Chart] [Action] [Trade] │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Extension-First Attempt

**Approach**: Use `contributes.menus["editor/title"]` in `package.json`

#### Step 1: Create Test Extension Entry

```typescript
// src/spike/viewButtonTest.ts
import * as vscode from 'vscode';

export function activateViewButtonSpike(context: vscode.ExtensionContext) {
  // Register test commands
  context.subscriptions.push(
    vscode.commands.registerCommand('spike.chartButton', () => {
      vscode.window.showInformationMessage('Chart button clicked!');
    }),
    vscode.commands.registerCommand('spike.actionButton', () => {
      vscode.window.showInformationMessage('Action button clicked!');
    }),
    vscode.commands.registerCommand('spike.tradeButton', () => {
      vscode.window.showInformationMessage('Trade button clicked!');
    })
  );
}
```

#### Step 2: Update `package.json`

```json
{
  "contributes": {
    "commands": [
      {
        "command": "spike.chartButton",
        "title": "Chart",
        "icon": "$(graph)"
      },
      {
        "command": "spike.actionButton",
        "title": "Action",
        "icon": "$(beaker)"
      },
      {
        "command": "spike.tradeButton",
        "title": "Trade",
        "icon": "$(pulse)"
      }
    ],
    "menus": {
      "editor/title": [
        {
          "command": "spike.chartButton",
          "when": "resourceExtname == .py",
          "group": "navigation@1"
        },
        {
          "command": "spike.actionButton",
          "when": "resourceExtname == .py",
          "group": "navigation@2"
        },
        {
          "command": "spike.tradeButton",
          "when": "resourceExtname == .py",
          "group": "navigation@3"
        }
      ]
    }
  }
}
```

### 2.3 Verification Checklist

```
□ Buttons appear in editor title area for .py files
□ Buttons are positioned on the RIGHT side of the tab bar
□ Buttons do NOT appear for non-.py files
□ Buttons show icons (not just text)
□ Clicking buttons triggers the commands
```

### 2.4 Expected Outcome Analysis

| Scenario | Result | Next Step |
|----------|--------|-----------|
| Buttons appear at tab bar RHS | ✅ PASS | Extension approach works |
| Buttons appear but wrong position | ⚠️ PARTIAL | May need CSS tweaks or group ordering |
| Buttons appear in editor header (not tab bar) | ❌ FAIL | Need workbench patch |
| Buttons don't appear at all | ❌ FAIL | Check `when` clause, command registration |

### 2.5 Fork Patch Path (if extension fails)

If extension API cannot position buttons in tab bar RHS:

**File to patch**: `src/vs/workbench/browser/parts/editor/editorTabsControl.ts`

```typescript
// Look for tab bar rendering logic
// Add custom button container after tabs, before layout buttons
// Reference: EditorTitleBarControl class
```

**Key Classes to Investigate:**
- `EditorTabsControl` — Renders tab strip
- `EditorTitleBarControl` — Renders title bar with buttons
- `TabsModel` — Tab state management

### 2.6 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] Extension approach works: YES / NO
- [ ] If NO: Specific patch location and description
- [ ] Screenshots of button placement

---

## 3. Spike 0.2: Tab Stripe Styling

### 3.1 Requirement (from V8.1 §2.3.4)

Each tab should show a **3px left border stripe** indicating its view:
- Editor: No stripe
- Chart: Green (`#059669`)
- Action: Orange (`#D97706`)
- Trade: Red (`#DC2626`)

```
┌──────────────────┐
│▌strategy.py    × │  ← Green stripe = Chart view
└──────────────────┘
```

### 3.2 Extension-First Attempt

**Approach A**: CSS injection via extension

```typescript
// src/spike/tabStripeTest.ts
import * as vscode from 'vscode';

export function activateTabStripeSpike(context: vscode.ExtensionContext) {
  // Attempt: Use window.createWebviewPanel to inject CSS
  // This is a stretch — unlikely to work for tab styling

  // Alternative: Use file decoration API
  const decorationProvider: vscode.FileDecorationProvider = {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
      if (uri.fsPath.endsWith('.py')) {
        return {
          badge: '🟢',  // Fallback emoji indicator
          color: new vscode.ThemeColor('charts.green'),
          tooltip: 'Chart View'
        };
      }
      return undefined;
    }
  };

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );
}
```

**Approach B**: Tab rename with emoji prefix

```typescript
// In view switch handler:
function updateTabLabel(editor: vscode.TextEditor, view: ViewType) {
  // VS Code does NOT allow renaming tabs via extension API
  // This approach will NOT work
}
```

### 3.3 Verification Checklist

```
□ Can apply visual indicator to specific tabs
□ Indicator persists when switching between tabs
□ Indicator correctly reflects view state
□ Works for multiple tabs of the same file
```

### 3.4 Expected Outcome Analysis

| Approach | Likely Result | Notes |
|----------|---------------|-------|
| FileDecorationProvider | Badge only, no stripe | Badges appear in explorer, NOT tabs |
| CSS injection | ❌ FAIL | No extension API for tab CSS |
| Tab rename | ❌ FAIL | No extension API for tab labels |

**Most likely outcome**: Extension API CANNOT style individual tabs. Fork patch required.

### 3.5 Fork Patch Path

**File to patch**: `src/vs/workbench/browser/parts/editor/media/tabstitlecontrol.css`

```css
/* Add new CSS rules for Quantlab tab stripes */
.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-container > .tab[data-quantlab-view="chart"]::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #059669;
}

.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-container > .tab[data-quantlab-view="action"]::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #D97706;
}

.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-container > .tab[data-quantlab-view="trade"]::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #DC2626;
}
```

**TypeScript patch**: `src/vs/workbench/browser/parts/editor/tabsTitleControl.ts`

```typescript
// Add data attribute to tab elements based on Quantlab view state
// Look for: createTab() or renderTab() method
// Add: tabElement.dataset.quantlabView = getViewState(editor);
```

### 3.6 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] Extension approach works: YES / NO (likely NO)
- [ ] Fallback emoji approach acceptable: YES / NO
- [ ] Fork patch CSS location confirmed
- [ ] Fork patch TS location confirmed

---

## 4. Spike 0.3: In-Place View Switching

### 4.1 Requirement (from V8.1 §3.2)

When user clicks a view button:
- Tab content changes (Editor → Chart → Action → Trade)
- **Same tab instance** — no new tab created
- Tab stripe updates to reflect new view

### 4.2 Architecture Challenge

This is the **most complex spike**. VS Code's editor model assumes:
- One editor type per tab
- Tab content = file content
- Switching content type = new editor

V8.1 requires:
- Same tab
- Content can be: Monaco editor OR webview OR custom panel
- Switch happens in-place

### 4.3 Investigation Approaches

#### Approach A: CustomTextEditorProvider

```typescript
// src/spike/viewSwitchTest.ts
import * as vscode from 'vscode';

class QuantlabEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomTextEditorProvider(
      'quantlab.strategyEditor',
      new QuantlabEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true
      }
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Key insight: CustomTextEditorProvider gives us a webview
    // We could switch between:
    // - Rendering Monaco in the webview
    // - Rendering Chart in the webview
    // - Rendering Action UI in the webview
    // - Rendering Trade UI in the webview

    // BUT: Monaco in webview has limitations (no full IntelliSense)
  }
}
```

**Pros**:
- Single tab, multiple views
- State persistence handled by VS Code

**Cons**:
- Monaco in webview loses native IntelliSense, extensions
- May not feel like "real" VS Code editor

#### Approach B: EditorPane Replacement (Fork Required)

```typescript
// Concept: Replace editor pane content without changing tab
// This requires patching VS Code's editor service

// File: src/vs/workbench/browser/parts/editor/editorPanes.ts
// Look for: openEditor() method
// Modify: Allow swapping pane content while keeping tab identity
```

**Pros**:
- Native Monaco for Editor view
- Full IntelliSense support

**Cons**:
- Complex fork patch
- May break on VS Code updates

#### Approach C: Webview Overlay

```typescript
// Concept: Keep native editor, overlay webview on top
// For Chart/Action/Trade views, show webview covering editor
// For Editor view, hide webview and show native editor

export function activateViewSwitchSpike(context: vscode.ExtensionContext) {
  const editors = new WeakMap<vscode.TextEditor, vscode.WebviewPanel>();

  context.subscriptions.push(
    vscode.commands.registerCommand('spike.switchToChart', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      // Create webview in same column
      const panel = vscode.window.createWebviewPanel(
        'quantlab.chart',
        `${path.basename(editor.document.fileName)} (Chart)`,
        editor.viewColumn!,
        { enableScripts: true }
      );

      panel.webview.html = '<h1>Chart View</h1>';
      editors.set(editor, panel);
    })
  );
}
```

**Pros**:
- Simple implementation
- Works via extension API

**Cons**:
- Creates new panel (might appear as new "tab")
- May not satisfy "same tab" requirement

### 4.4 Verification Checklist

```
□ Switch Editor → Chart: Same tab, content changes
□ Switch Chart → Action: Same tab, content changes
□ Switch to Editor: Native Monaco editor (not webview-wrapped)
□ Tab identity preserved (no tab close/reopen flicker)
□ View state preserved when switching back
```

### 4.5 Decision Matrix

| Approach | Same Tab | Native Monaco | Complexity | Recommended |
|----------|----------|---------------|------------|-------------|
| CustomTextEditorProvider | ✅ | ❌ Webview Monaco | Medium | ⚠️ Maybe |
| EditorPane Replacement | ✅ | ✅ | High | ✅ Best UX |
| Webview Overlay | ⚠️ Appears as new tab | ✅ (hidden) | Low | ❌ No |

### 4.6 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] Which approach chosen and why
- [ ] If fork patch needed: exact files and changes
- [ ] If CustomTextEditorProvider: document Monaco limitations
- [ ] Screenshots/video of switching behavior

---

## 5. Spike 0.4: Window Chrome Elements

### 5.1 Requirement (from V8.1 §2.2.2, §2.2.3)

Window chrome must contain:
- **Symbol/Timeframe selectors** (center-right): `[AAPL ▼][1D ▼]`
- **History button** (right): `[⏱ History ▼]`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  File  Edit  Selection  View  ...       [AAPL ▼][1D ▼]      [⏱ History ▼]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Extension-First Attempt

**Approach A**: StatusBarItem (easiest, but wrong position)

```typescript
// src/spike/windowChromeTest.ts
import * as vscode from 'vscode';

export function activateWindowChromeSpike(context: vscode.ExtensionContext) {
  // Symbol selector
  const symbolItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000 // High priority = more to the right
  );
  symbolItem.text = '$(graph) AAPL';
  symbolItem.tooltip = 'Click to change symbol';
  symbolItem.command = 'spike.selectSymbol';
  symbolItem.show();

  // Timeframe selector
  const tfItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    999
  );
  tfItem.text = '1D';
  tfItem.tooltip = 'Click to change timeframe';
  tfItem.command = 'spike.selectTimeframe';
  tfItem.show();

  // History button
  const historyItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    998
  );
  historyItem.text = '$(history) History';
  historyItem.tooltip = 'View run history';
  historyItem.command = 'spike.toggleHistory';
  historyItem.show();

  context.subscriptions.push(symbolItem, tfItem, historyItem);
}
```

**Problem**: Status bar is at the BOTTOM, not in window chrome (title bar area).

**Approach B**: Activity Bar + Command Palette

If chrome is not achievable, use:
- Activity Bar panel for symbol/TF selection
- Quick Pick for history dropdown

### 5.3 Verification Checklist

```
□ Elements appear in window chrome area (title bar)
□ Symbol selector opens dropdown on click
□ Timeframe selector opens dropdown on click
□ History button opens history panel/dropdown
□ Position is center-right for symbol/TF, right for history
```

### 5.4 Expected Outcome Analysis

**Most likely outcome**: Extension API CANNOT add elements to title bar. Options:

| Approach | Location | Acceptable? |
|----------|----------|-------------|
| StatusBarItem | Bottom status bar | ⚠️ Functional but not spec-compliant |
| Fork patch | Title bar | ✅ Spec-compliant |

### 5.5 Fork Patch Path

**File to patch**: `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`

```typescript
// Look for: TitlebarPart class
// Find: createContentArea() or similar
// Add: Custom container for Quantlab chrome elements
// Style: Position center-right and right

// Key methods:
// - createContentArea()
// - updateStyles()
// - layout()
```

**CSS File**: `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`

```css
.quantlab-chrome-symbol-tf {
  display: flex;
  gap: 4px;
  align-items: center;
  position: absolute;
  right: 300px; /* Adjust based on layout */
}

.quantlab-chrome-history {
  position: absolute;
  right: 150px; /* Before window controls */
}
```

### 5.6 Alternative: Status Bar Fallback

If fork patch is deemed too invasive, document this alternative:

```typescript
// Use status bar but make it visually prominent
const chromeItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  10000 // Very high priority
);
chromeItem.text = '$(symbol-class) AAPL | 1D | $(history)';
chromeItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
```

### 5.7 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] Title bar access via extension: YES / NO (likely NO)
- [ ] Status bar fallback acceptable: YES / NO
- [ ] If fork patch: exact files and changes
- [ ] Decision: Title bar patch OR status bar fallback

---

## 6. Spike 0.5: macOS Ctrl+Q Keybinding

### 6.1 Requirement (from V8.1 §7)

All Quantlab shortcuts use `Ctrl+Q` prefix:
- `Ctrl+Q C` — Switch to Chart
- `Ctrl+Q A` — Switch to Action
- `Ctrl+Q T` — Switch to Trade

**Problem on macOS**: `Cmd+Q` is OS-level "Quit Application" and cannot be intercepted.

### 6.2 Investigation

#### Test 1: Verify Cmd+Q Interception

```typescript
// src/spike/keybindingTest.ts
import * as vscode from 'vscode';

export function activateKeybindingSpike(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('spike.testCmdQ', () => {
      vscode.window.showInformationMessage('Cmd+Q was intercepted!');
    })
  );
}

// In package.json:
// {
//   "keybindings": [
//     { "key": "cmd+q c", "mac": "cmd+q c", "command": "spike.testCmdQ" }
//   ]
// }
```

#### Test 2: Try Ctrl+Q on macOS

```json
{
  "keybindings": [
    { "key": "ctrl+q c", "mac": "ctrl+q c", "command": "spike.testCmdQ" }
  ]
}
```

Note: `Ctrl` on macOS is `Control` key (not `Cmd`), so this might work!

### 6.3 Verification Checklist

```
□ On macOS: Does Cmd+Q prefix work? (unlikely)
□ On macOS: Does Ctrl+Q prefix work? (test Control key)
□ On Linux/Windows: Does Ctrl+Q prefix work?
□ Document any conflicts with existing VS Code bindings
```

### 6.4 Alternative Prefix Options

If `Ctrl+Q` fails on any platform:

| Alternative | Platform | Conflict Risk |
|-------------|----------|---------------|
| `Ctrl+K Q` | All | Low (uses VS Code's Ctrl+K prefix convention) |
| `Ctrl+Shift+Q` | All | Medium |
| `Alt+Q` | All | Low, but Alt is awkward |
| `Ctrl+\` | All | Medium |

### 6.5 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] `Ctrl+Q` works on: Windows / Linux / macOS (circle all that apply)
- [ ] macOS alternative chosen (if needed): `[prefix]`
- [ ] Any VS Code conflicts identified

---

## 7. Spike 0.6: Tab Instance Identity

### 7.1 Requirement (from V8.1 §3.3.2)

Multiple tabs of the SAME file must have INDEPENDENT view states:
- `strategy.py` (Editor view) = Tab A
- `strategy.py` (Chart view via "Open as Chart") = Tab B
- Both tabs must maintain their own state

**Critical**: If state is keyed only by file URI, tabs will share state (BUG).

### 7.2 Investigation

#### Explore VS Code TabGroups API

```typescript
// src/spike/tabInstanceTest.ts
import * as vscode from 'vscode';

export function activateTabInstanceSpike(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('spike.inspectTabs', () => {
      const tabGroups = vscode.window.tabGroups;

      for (const group of tabGroups.all) {
        console.log(`Group ${tabGroups.all.indexOf(group)}:`);

        for (const tab of group.tabs) {
          console.log(`  Tab: ${tab.label}`);
          console.log(`    isActive: ${tab.isActive}`);
          console.log(`    isDirty: ${tab.isDirty}`);
          console.log(`    isPinned: ${tab.isPinned}`);

          if (tab.input instanceof vscode.TabInputText) {
            console.log(`    URI: ${tab.input.uri.toString()}`);
          }

          // KEY QUESTION: Is there a unique tab ID?
          // Answer: tab.input might provide identity via instanceof check
        }
      }
    })
  );
}
```

### 7.3 Tab Identity Options

#### Option A: URI + Group + Index

```typescript
function getTabInstanceId(editor: vscode.TextEditor): string {
  const tabGroups = vscode.window.tabGroups;

  for (const group of tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        if (tab.input.uri.toString() === editor.document.uri.toString()) {
          const groupIdx = tabGroups.all.indexOf(group);
          const tabIdx = group.tabs.indexOf(tab);
          return `${editor.document.uri.toString()}::${groupIdx}::${tabIdx}`;
        }
      }
    }
  }

  // Fallback
  return editor.document.uri.toString();
}
```

**Problem**: Tab index changes when tabs are reordered or closed.

#### Option B: URI + View Type + Timestamp

```typescript
function createTabInstanceId(uri: vscode.Uri, view: ViewType): string {
  return `${uri.toString()}::${view}::${Date.now()}`;
}
```

**Pros**: Stable for tab lifetime
**Cons**: Hard to restore after reload

#### Option C: URI + Custom Editor ID (if using CustomTextEditorProvider)

If we use CustomTextEditorProvider, VS Code may track document-to-webview mappings internally.

### 7.4 Verification Checklist

```
□ Open strategy.py → Tab A
□ "Open as Chart (new tab)" → Tab B (same file)
□ Tab A state vs Tab B state are independent
□ Change Tab A to Action view → Tab B still Chart
□ Close Tab A → Tab B state preserved
□ Reload window → Both tabs restore their states correctly
```

### 7.5 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] Tab identity approach chosen: `[approach]`
- [ ] Stable across session: YES / NO
- [ ] Caveats or limitations

---

## 8. Spike 0.7: Tab View State Persistence

### 8.1 Requirement

Tab view states must persist across:
- Extension reload
- Window reload
- VS Code restart

### 8.2 Implementation Test

```typescript
// src/spike/statePersistenceTest.ts
import * as vscode from 'vscode';

type TabViewState = {
  tabInstanceId: string;
  filePath: string;
  currentView: 'editor' | 'chart' | 'action' | 'trade';
};

export function activateStatePersistenceSpike(context: vscode.ExtensionContext) {
  // Load saved states
  const savedStates = context.workspaceState.get<Record<string, TabViewState>>(
    'spike.tabViewStates',
    {}
  );
  console.log('Loaded states:', savedStates);

  // Test saving state
  context.subscriptions.push(
    vscode.commands.registerCommand('spike.saveState', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const id = getTabInstanceId(editor);
      const state: TabViewState = {
        tabInstanceId: id,
        filePath: editor.document.uri.fsPath,
        currentView: 'chart' // Test value
      };

      savedStates[id] = state;
      await context.workspaceState.update('spike.tabViewStates', savedStates);
      vscode.window.showInformationMessage(`State saved for ${id}`);
    }),

    vscode.commands.registerCommand('spike.loadState', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const id = getTabInstanceId(editor);
      const state = savedStates[id];

      if (state) {
        vscode.window.showInformationMessage(
          `Loaded state: ${state.currentView} for ${state.filePath}`
        );
      } else {
        vscode.window.showWarningMessage('No saved state found');
      }
    })
  );
}

function getTabInstanceId(editor: vscode.TextEditor): string {
  // Use approach from Spike 0.6
  return editor.document.uri.toString();
}
```

### 8.3 Verification Checklist

```
□ Save state for Tab A (Chart view)
□ Reload window (Developer: Reload Window)
□ Load state for Tab A → Should show "chart"
□ Save state for Tab B (Action view)
□ Quit and reopen VS Code
□ Both Tab A and Tab B states restored correctly
```

### 8.4 Cleanup Orphaned States

When tabs are closed, we need to clean up their states:

```typescript
// Listen for tab close events
vscode.window.tabGroups.onDidChangeTabs((event) => {
  for (const closedTab of event.closed) {
    // Remove state for closed tab
    // Note: Need to map closedTab back to tabInstanceId
  }
});
```

### 8.5 Document Findings

Record in `FEASIBILITY_REPORT.md`:
- [ ] workspaceState persistence works: YES / NO
- [ ] Tab close cleanup works: YES / NO
- [ ] Orphan cleanup strategy documented

---

## 8. Deliverables

### 8.1 Primary Deliverable: `FEASIBILITY_REPORT.md`

Create this file at `quantlab-extension/docs/FEASIBILITY_REPORT.md` with:

```markdown
# Quantlab V8.1 Feasibility Report

**Date**: [DATE]
**Author**: [NAME]
**Duration**: [DAYS]

## Executive Summary

Brief summary of what works via extension API vs. what requires fork patches.

## Spike Results

### 0.1 View Button Placement
- Extension approach: [WORKS / FAILS]
- If fails, fork patch required: [FILE] + [DESCRIPTION]

### 0.2 Tab Stripe Styling
- Extension approach: [WORKS / FAILS]
- Fallback (emoji): [ACCEPTABLE / NOT ACCEPTABLE]
- If fails, fork patch required: [FILE] + [DESCRIPTION]

### 0.3 In-Place View Switching
- Chosen approach: [CustomTextEditorProvider / Fork Patch / Other]
- Native Monaco preserved: [YES / NO]
- Complexity: [LOW / MEDIUM / HIGH]

### 0.4 Window Chrome Elements
- Title bar access: [WORKS / FAILS]
- Fallback (status bar): [ACCEPTABLE / NOT ACCEPTABLE]
- If fails, fork patch required: [FILE] + [DESCRIPTION]

### 0.5 macOS Ctrl+Q Keybinding
- Ctrl+Q on macOS: [WORKS / FAILS]
- Alternative chosen: [PREFIX]
- Conflicts: [LIST]

### 0.6 Tab Instance Identity
- Approach: [URI+GROUP+IDX / URI+VIEW+TIMESTAMP / OTHER]
- Stable: [YES / NO]
- Caveats: [LIST]

### 0.7 Tab View State Persistence
- workspaceState: [WORKS / FAILS]
- Cleanup: [IMPLEMENTED / TODO]

## Recommended Architecture

Based on findings, the recommended architecture is:
- [THIN FORK / FULL FORK / PURE EXTENSION]

## Fork Patch Summary

List all required fork patches:

1. **[FILE]**: [DESCRIPTION]
2. **[FILE]**: [DESCRIPTION]
...

## Next Steps

1. Implement fork patches before Phase 1
2. [OTHER ACTIONS]
```

### 8.2 Secondary Deliverable: Spike Code (Temporary)

All spike code in `src/spike/` should be:
- Well-commented with findings
- Deletable after Phase 0
- NOT production code

---

## 9. Exit Gates

Phase 0 is complete when:

- [ ] **View switching proven**: At least one approach works (hacky is OK)
- [ ] **State persists**: Tab states survive window reload
- [ ] **Fork patches documented**: Every required patch has file + description
- [ ] **macOS keybinding decided**: Either Ctrl+Q works or alternative chosen
- [ ] **FEASIBILITY_REPORT.md complete**: All sections filled in
- [ ] **Architecture confirmed**: Thin-fork + extension OR alternative documented

---

## 10. Time Estimates by Spike

| Spike | Estimated Time | Risk |
|-------|----------------|------|
| 0.1 View Buttons | 2-4 hours | Low |
| 0.2 Tab Stripe | 2-4 hours | Medium |
| 0.3 View Switching | 4-8 hours | High |
| 0.4 Window Chrome | 2-4 hours | Medium |
| 0.5 Keybinding | 1-2 hours | Low |
| 0.6 Tab Identity | 2-4 hours | Medium |
| 0.7 State Persistence | 2-4 hours | Low |
| **Documentation** | 2-4 hours | — |
| **Total** | **17-34 hours** | **3-5 days** |

---

## 11. Common Pitfalls to Avoid

1. **Don't build production code** — This is a spike. Write throwaway code.

2. **Don't skip documentation** — The report is the main deliverable.

3. **Don't assume extension API limits** — Always try the extension approach first, even if you expect it to fail.

4. **Don't forget macOS testing** — Keybindings must work on Mac.

5. **Don't conflate "works" with "works well"** — Document even partial successes.

6. **Don't forget to test with multiple tabs of the same file** — This is the critical edge case for state management.
