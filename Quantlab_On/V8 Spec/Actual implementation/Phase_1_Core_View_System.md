# Quantlab Phase 1 Core View System - Full Implementation Plan

Version: 1.1
Owner: Quantlab PM/Eng
Timebox: 1-2 weeks
Goal: Implement the V8.1 view framework (Editor, Chart, Action, Trade) with per-tab state, UI controls, commands, and keybindings. No feature views yet.

## References (Source of Truth)
- Quantlab V8.1 UI/UX spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 1 plan: `Quantlab_On/Deeper_implementation_plan/Phase_1_Core_View_System.md`
- Phase 0 feasibility report and decision log: `extensions/quantlab/docs/FEASIBILITY_REPORT.md`
- Charting engine and docs (Phase 3+ only): `Charts/`

Note: The path `/home/s/quantlab/Complete_spec/Start_antigravity` is not present in this repo. This plan uses `Quantlab_On/Full_spec/Quantlab_UX_Spec.md` as the source of truth.
Note: Phase 0 artifacts are not present in this repo; decisions are locked below for Phase 1 execution.

## Phase 1 Objectives
1. Implement per-tab view state (Editor, Chart, Action, Trade) with persistence.
2. Provide view switching in-place and "Open as [View]" new tab behavior.
3. Surface view buttons on the right side of the tab bar with correct behavior and accessibility.
4. Apply tab stripe indicator (3px left border) with correct colors.
5. Implement Ctrl+Q prefixed keybindings and command wiring.
6. Provide disabled button toast behavior and basic validation feedback for non-strategy files.
7. Establish unit and integration tests for view and strategy detection.

## Scope
In scope:
- Core types, state manager, and view manager.
- Strategy detection and minimal validation stubs.
- Tab UI integration: view buttons, stripe, and context menu entries.
- Commands and keybindings for view switching and open-as view.
- Context keys for command enablement and menu visibility.
- State persistence and reload behavior.
- View content placeholder (state-only, no webview) for Chart, Action, and Trade.

Out of scope:
- Chart, Action, Trade feature UIs or engine integration.
- Global symbol/timeframe selectors and history button.
- Activity bar panels beyond auto-expand behavior.
- Parameter system extraction beyond stub.
- Complexity analysis beyond stub.
- Drag and drop behaviors.

## Phase 1 Decisions (Locked)
1. Extension location: `extensions/quantlab` as a built-in extension bundled with the fork.
2. Workbench patches are required for view buttons placement, tab stripe indicators, and per-tab ARIA labels.
3. In-place view switching is state-only in Phase 1; editor content remains Monaco until Phase 3 webviews.
4. Tab identity algorithm: `tabInstanceId = ${uri.toString()}::${groupIndex}::${tabIndex}` (use `untitled:<id>` for unsaved resources). Both extension and workbench use the same algorithm.
5. macOS keybinding: remap `workbench.action.quit` to `Cmd+Shift+Q`, freeing `Cmd+Q` for Quantlab chords.
6. View state source of truth: a workbench `QuantlabTabViewService` persists to workspace storage and drives tab UI; the extension mirrors state and updates via `quantlab.setTabViewState`.
7. All Phase 1 workbench patch paths and rationales are recorded in `extensions/quantlab/docs/PATCHES_PHASE_1.md`.

## Non-Negotiable V8.1 Requirements (Phase 1 Relevant)
- Views are per-tab states, not global modes. (Spec 1.1)
- Four views: Editor, Chart, Action, Trade. (Spec 1.1)
- View buttons at right side of tab bar, layout buttons relocated. (Spec 2.3.2)
- Tab stripe is a 3px left border, not full tab fill. (Spec 2.3.4, 8.1)
- "Open as [View]" creates a new tab with independent state. (Spec 3.3.2)
- Disabled view actions show a toast, not a hard error. (Spec 6.3)
- Ctrl+Q prefix for all Quantlab keybindings. (Spec 7.1)
- View buttons are keyboard accessible and screen reader friendly. (Spec 9.1, 9.2)

## Workbench Patch Plan (Phase 1)
All workbench patches live in the fork under `src/vs/` and are tracked in `extensions/quantlab/docs/PATCHES_PHASE_1.md`.

1. Quantlab view state service and commands:
   - New: `src/vs/workbench/browser/parts/editor/quantlabViewStateService.ts` (per-tab view state, workspace persistence, events)
   - New: `src/vs/workbench/browser/parts/editor/quantlabViewEditorInput.ts` (wrapper input with view suffix and MultipleEditors)
   - Register service and editor input in `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
   - Add commands `quantlab.setTabViewState`, `quantlab.clearTabViewState`, `quantlab.getTabViewState`, `quantlab.openAsView`
2. Tab stripe and ARIA labeling:
   - Update `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`
   - Update `src/vs/workbench/browser/parts/editor/singleEditorTabsControl.ts`
   - CSS updates in `src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css`
   - CSS updates in `src/vs/workbench/browser/parts/editor/media/singleeditortabscontrol.css`
3. View buttons in the tab bar right side:
   - Add a Quantlab actions container in `multiEditorTabsControl.ts` and `singleEditorTabsControl.ts`
   - Remove layout buttons from the tab bar by trimming `MenuId.EditorTitle` in `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
   - Update tab bar CSS to reserve width for the Quantlab actions container (avoid overlap with tabs)
4. CSS variables:
   - Add `--ql-view-chart`, `--ql-view-action`, `--ql-view-trade`, and `--ql-view-stripe-width` to `src/vs/workbench/browser/media/style.css`
5. macOS quit keybinding:
   - Update `src/vs/workbench/electron-browser/desktop.contribution.ts` to set `workbench.action.quit` to `Cmd+Shift+Q` on macOS

## Implementation Plan

### 1. Establish Phase 1 file layout
Extension root is `extensions/quantlab`. Create or confirm this structure:

```
extensions/quantlab/
  package.json
  tsconfig.json
  webpack.config.js
  src/extension.ts
  src/
    types/
      index.ts
      views.ts
      strategy.ts
    core/
      state/
        TabViewState.ts
      strategy/
        StrategyValidator.ts
    views/
      ViewManager.ts
    ui/
      ViewButtons.ts
      TabDecorator.ts (optional fallback for non-patched builds)
    commands/
      viewCommands.ts
    utils/
      contextKeys.ts
  docs/
    PATCHES_PHASE_1.md
    DEVIATIONS.md (only if needed)
```

### 2. Type system
Implement core types aligned with V8.1:

- `ViewType` union and `TabViewState` interface.
- View-specific sub-state stubs (chartState, actionState, tradeState).
- Strategy metadata types: entrypoint, validation result, complexity level.
- View stripe colors using CSS token values:
  - Chart: `#059669`
  - Action: `#D97706`
  - Trade: `#DC2626`
  - Stripe width: 3px

Export types via `types/index.ts` to keep imports centralized.

### 3. Strategy detection and validation
Implement `StrategyValidator`:

- Detect entrypoints:
  - `def strategy(data):` (vectorized)
  - `def on_bar(ctx):` (event-driven)
  - `class X(ql.Strategy):` (class-based)
- Define two status layers:
  - `isStrategy` for entrypoint presence.
  - `isValid` for validation pass (Phase 1 only checks entrypoint and returns stubbed errors list).
- Validation triggers:
  - On file open
  - On save
  - On view switch
- Return a `StrategyValidationResult` containing:
  - `entrypoint`, `errors`, `warnings`, `complexity`, `hasVisualizationCode`
  - Stub `complexity` to `safe` for now.
- When `isStrategy` is false, set a specific error code for utility modules so the toast can differentiate.

### 4. Context keys
Implement context keys used by menus and keybindings:

- `quantlab.isStrategy` (boolean)
- `quantlab.currentView` (editor, chart, action, trade)
- Optional: `quantlab.hasValidationErrors` (boolean) to allow Chart and Action but show guidance

Update context keys:
- On editor focus change
- On strategy validation events
- On view switch

### 5. Tab view state manager
Implement `TabViewStateManager`:

- Track state by tab instance ID, not file path.
- Compute `tabInstanceId` as `${uri.toString()}::${groupIndex}::${tabIndex}` (use `untitled:<id>` for unsaved).
- Use the VS Code TabGroups API to derive `groupIndex` and `tabIndex`.
- Maintain an in-memory map in the extension for fast access.
- On set/remove, call workbench commands:
  - `quantlab.setTabViewState` (tabInstanceId, view, filePath)
  - `quantlab.clearTabViewState` (tabInstanceId)
- The workbench `QuantlabTabViewService` persists to workspace storage and drives UI updates.
- Cleanup orphaned entries when tabs close or when tabs are reordered.
- Provide `onDidChangeView` event for extension-level updates.

State model:
- `tabInstanceId`, `filePath`, `currentView`
- View-specific stubs to be filled in later phases.

State restoration strategy:
- On activation, the extension asks the workbench service for the current view per visible tab (`quantlab.getTabViewState`).
- If a tab has no stored state, default to Editor and write it back to the service.

### 6. View manager orchestrator
Implement `ViewManager`:

- `switchView(editor, view)`:
  - Validate file compatibility.
  - Update `TabViewStateManager`.
  - Update context keys.
  - Trigger activity bar auto-expand for Action and Trade.
- `openAsView(uri, view)`:
  - Call the workbench command `quantlab.openAsView` to create a new `QuantlabViewEditorInput` tab instance.
  - Prefer `ViewColumn.Beside` for multi-pane, but allow same group if user invoked "Open as" from a tab context menu.
  - Set view state for the new tab via `quantlab.setTabViewState`.
  - The workbench input supplies the `filename.py (Chart)` style suffix.
- Compatibility behavior:
  - If `isStrategy` is false, show toast and block Chart, Action, Trade.
  - If `isStrategy` is true but validation errors exist, allow Chart and Action, but show an error placeholder in view content.
  - Trade view is blocked for invalid strategy in Phase 1.

### 7. UI integration

#### 7.1 View buttons
Implement view buttons in the right side of the tab bar:

- Buttons: Chart, Action, Trade. When a view is active, replace it with Editor.
- Disabled appearance when file is not a strategy:
  - 50 percent opacity and not-allowed cursor.
  - Attempt to activate still shows toast with guidance.
- Layout buttons are relocated to the View menu and Command Palette (per spec).

Implementation:
- Workbench patch: add a Quantlab actions container into the tab bar right side in `multiEditorTabsControl.ts` and `singleEditorTabsControl.ts`.
- Buttons invoke `quantlab.switchToChart`, `quantlab.switchToAction`, `quantlab.switchToTrade`, and `quantlab.switchToEditor` via `ICommandService`.
- Remove layout buttons from the tab bar by trimming `MenuId.EditorTitle` contributions in `editor.contribution.ts`. Keep them in View menu and Command Palette.
- Enabled state is derived from the active tab's strategy status; disabled clicks still run the command so the toast is shown.

Accessibility:
- Buttons are keyboard focusable and have `aria-label` values like "Chart view button".
- On activation via keyboard, behavior matches mouse click.

#### 7.2 Tab stripe indicator
Implement a 3px left border stripe with CSS variables:

- Use `--ql-view-chart`, `--ql-view-action`, `--ql-view-trade`, `--ql-view-stripe-width`.
- Stripe applies only when view is Chart, Action, or Trade.
- Editor view has no stripe.

Implementation:
- Workbench patch adds `data-ql-view` on each tab element using the `QuantlabTabViewService` value for that tabInstanceId.
- CSS in `multieditortabscontrol.css` and `singleeditortabscontrol.css` renders the left stripe using `--ql-view-*` tokens.
- `QuantlabTabViewService` updates tab ARIA labels to append ", Chart view", ", Action view", or ", Trade view".

Accessibility:
- Update tab accessible label to include view name when stripe is present, for example "strategy.py, Chart view".

#### 7.3 Tab naming and labels
- In-place view switch keeps the tab label as `filename.py`.
- "Open as" new tabs use suffix: `filename.py (Chart)` etc.
- Implement a lightweight `QuantlabViewEditorInput` in the workbench that wraps the resource and returns a custom `getName()` with the suffix.
- Set `EditorInputCapabilities.MultipleEditors` on that input so duplicates are allowed.
- Ensure suffix is added only for the new tab instance, not the original.

#### 7.4 Tab context menu
Add context menu entries for "Open as Chart", "Open as Action", and "Open as Trade" (new tab) on strategy files.

### 8. Commands and keybindings
Add commands:

- `quantlab.switchToChart`, `quantlab.switchToAction`, `quantlab.switchToTrade`, `quantlab.switchToEditor`
- `quantlab.openAsChart`, `quantlab.openAsAction`, `quantlab.openAsTrade`
- Workbench-only: `quantlab.openAsView` (used internally by the open-as commands)

Keybindings:

- `Ctrl+Q C`, `Ctrl+Q A`, `Ctrl+Q T`, `Ctrl+Q E`
- `Escape` returns to Editor view
- `Ctrl+Q Shift+C`, `Ctrl+Q Shift+A`, `Ctrl+Q Shift+T`

macOS:
- Remap Quit to `Cmd+Shift+Q` in `src/vs/workbench/electron-browser/desktop.contribution.ts`.
- Bind Quantlab chords to `Cmd+Q` prefix in `extensions/quantlab/package.json`.

### 9. Toasts and error placeholders
Implement disabled view toast behavior:

- Message format:
  - Title: "Chart view is not available for this file."
  - Body: "Chart view requires a Python file with a valid strategy. This file appears to be a utility module."
- Include "Learn about strategies" and "Dismiss".
- Auto dismiss after 5 seconds.
- The same structure applies to Action and Trade views.

For invalid strategies:
- Allow Chart and Action views but show a placeholder panel that lists validation errors and a link to documentation.

### 10. Testing plan

Unit tests:
- `StrategyValidator` detection patterns and invalid cases.
- `TabViewStateManager` persistence and multiple tabs for same file.

Integration tests:
- View switch in place does not create new tab.
- Open as view creates new tab with suffix and independent state.
- View state persists across reload.
- Toast appears for non-strategy file.

Manual checklist:
1. Open valid strategy file, switch to Chart, observe stripe and button change.
2. Right-click tab, open as Action, confirm new tab and suffix.
3. Open utility .py file, attempt Chart, observe toast.
4. Reload window, confirm view state restored.

### 11. Exit gates
Phase 1 is complete when:

- All core types compile.
- View switching is per-tab and in-place.
- View buttons are placed on the right side of tab bar with correct states.
- Tab stripe appears with correct color and width.
- "Open as [View]" creates new tab with independent state and correct naming.
- Ctrl+Q keybindings work and do not conflict with VS Code defaults.
- Toast behavior and validation guidance are present.
- State persists across reload.
- Unit and integration tests pass.

## Deliverables
- Phase 1 code in `extensions/quantlab`.
- Workbench patches documented in `extensions/quantlab/docs/PATCHES_PHASE_1.md`.
- Tests covering validator, state manager, and view switching.
- `extensions/quantlab/docs/DEVIATIONS.md` only if macOS keybinding adjustments are blocked.
