# Quantlab Phase 2 Window Chrome + Activity Bar + History - Full Implementation Plan

Version: 1.1
Owner: Quantlab PM/Eng
Timebox: 2-3 weeks
Goal: Implement window chrome controls, global state, Activity Bar navigation panels, and the History system with persistence and UX wiring.

## References (Source of Truth)
- Quantlab V8.1 UI/UX spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 2 plan: `Quantlab_On/Deeper_implementation_plan/Phase_2_Window_Chrome_Activity_Bar_History.md`
- Phase 1 implementation plan (state manager + view system): `Quantlab_On/Actual implementation/Phase_1_Core_View_System.md`
- Workbench patches Phase 1: `extensions/quantlab/docs/PATCHES_PHASE_1.md`
- Charting engine and docs (Phase 3+ only): `Charts/`

Note: The Quantlab extension root is `extensions/quantlab` (built-in extension per Phase 1 decisions). If this extension folder does not yet exist in the repo, Phase 2 scaffolding includes creating it.

## Phase 2 Objectives
1. Implement global Symbol/Timeframe state with workspace persistence and events.
2. Place Symbol/Timeframe selectors and the History button in the window chrome (title bar), with a spec-compliant layout.
3. Implement the History state manager (CRUD, persistence, unviewed count, max entries).
4. Build the History dropdown (running + recent, actions, quick access).
5. Ship all 5 Activity Bar panels (Data, Resources, History, Trade, Settings) with baseline interactions.
6. Provide drag-and-drop infrastructure for symbols and history runs.
7. Add keybindings and commands for History and panel focus (Ctrl+Q prefix).

## Scope
In scope:
- Global market state manager and event plumbing.
- Title bar UI for Symbol/Timeframe selectors and History button.
- History store and dropdown UI.
- Activity Bar panels with TreeViews and minimal interactions.
- Drag-and-drop sources for symbols and history runs.
- Commands, keybindings, and context menu wiring.
- Unit and integration test coverage for GlobalState and HistoryState.

Out of scope:
- Chart, Action, Trade webviews and engine integration (Phase 3+).
- Full trade session logic (Phase 5).
- Backtest engine job execution (Phase 3/4).
- Advanced History compare view (Phase 4).

## Backend Optimization Principles (Non-UX)
These improvements do not alter the UI or workflows; they only tighten correctness, performance, and maintainability:
- Coalesce and debounce persistence writes to avoid storage thrash (especially for progress updates).
- Update title bar state only when values change (idempotent updates, minimal reflow).
- Normalize and validate persisted state on load; recover gracefully from corrupt or unknown data.
- Prefer stable IDs and deterministic ordering for TreeViews to preserve expansion/selection state.
- Refresh only affected TreeView branches when possible, not the full tree.
- Keep in-memory caches small and bounded (max entries already capped at 1000).

## Phase 2 Decisions (Locked)
1. Window chrome UI is implemented in the fork (workbench patch) to meet the spec. Extension-only status bar controls are kept as a fallback for unpatched builds.
2. Global market state persists in extension `workspaceState` and is bridged to the title bar via a workbench command.
3. History data persists in extension `globalState` (user-level) with FIFO eviction (keep pinned).
4. Activity Bar panels are implemented as separate view containers so each appears as its own icon (matching the spec).
5. History dropdown uses a QuickPick for speed and consistency with VS Code UI, triggered by the title bar History button and `Ctrl+Q H`.

## Non-Negotiable V8.1 Requirements (Phase 2 Relevant)
- Global Symbol/Timeframe selectors in the window chrome center-right area. (Spec 2.2.2)
- History button in the window chrome right area. (Spec 2.2.3)
- Activity Bar is navigation-only. (Spec 1.2, 4.1)
- Quantlab Activity Bar panels: Data, Resources, History, Trade, Settings. (Spec 4.1)
- No Visualizer or Tester icons in Activity Bar. (Spec 1.2)
- History dropdown and History panel share the same store. (Spec 5.1)
- All Quantlab shortcuts use Ctrl+Q prefix. (Spec 7.1)

## Workbench Patch Plan (Phase 2)
All workbench patches are recorded in `extensions/quantlab/docs/PATCHES_PHASE_2.md`.

1. Title bar injection for Symbol/Timeframe selectors and History button:
   - Update `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` to add:
     - A Quantlab market container in the center-right cluster (symbol/timeframe).
     - A Quantlab history container in the right cluster (before window controls).
   - Add DOM elements:
     - `button.quantlab-symbol` (label: symbol)
     - `button.quantlab-timeframe` (label: timeframe)
     - `button.quantlab-history` (label: "History", with count badge)
   - Wire buttons to commands:
     - `quantlab.selectSymbol`
     - `quantlab.selectTimeframe`
     - `quantlab.toggleHistoryDropdown`
   - Add a command handler in workbench:
     - `quantlab.updateTitlebarState` (payload: `{ symbol, timeframe, historyCount }`)
2. Title bar styling:
   - Update `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css` to:
     - Align the market container center-right and the history container right-most.
     - Match VS Code title bar typography and height.
     - Style a compact badge for history count.
     - Provide hover/active states.
3. Activity Bar separator (optional enhancement):
   - Add a CSS divider above the first Quantlab container in `src/vs/workbench/browser/parts/activitybar/activitybarPart.css`.
   - This is a visual separator only; no functional dependency.

## Implementation Plan

### 1. Phase 2 file layout (extension)
Create or extend the extension structure under `extensions/quantlab`:

```
extensions/quantlab/
  package.json
  src/
    core/
      state/
        GlobalState.ts
        HistoryState.ts
    types/
      market.ts
      history.ts
    ui/
      GlobalSelectors.ts             # Status bar fallback + title bar bridge
    panels/
      data/
        DataPanelProvider.ts
        DataTreeProvider.ts
        WatchlistManager.ts
      resources/
        ResourcesPanelProvider.ts
        ResourcesTreeProvider.ts
        resourcesCatalog.json
      history/
        HistoryPanelProvider.ts
        HistoryTreeProvider.ts
        HistoryDropdown.ts
      trade/
        TradePanelProvider.ts
        TradeTreeProvider.ts
      settings/
        SettingsPanelProvider.ts
        SettingsTreeProvider.ts
    commands/
      globalStateCommands.ts
      historyCommands.ts
      panelCommands.ts
    utils/
      dragDrop.ts
  media/icons/
    data.svg
    resources.svg
    history.svg
    trade.svg
    settings.svg
  docs/
    PATCHES_PHASE_2.md
```

### 2. Global State Manager
Implement global market state per spec (Symbol + Timeframe, optional date range).

File: `extensions/quantlab/src/types/market.ts`
- `Timeframe` union type (1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M).
- `GlobalMarketState` interface with `symbol`, `timeframe`, optional `dateRange`.

File: `extensions/quantlab/src/core/state/GlobalState.ts`
- Singleton with:
  - `getSymbol`, `setSymbol`
  - `getTimeframe`, `setTimeframe`
  - `getDateRange`, `setDateRange`
  - Events: `onDidChangeSymbol`, `onDidChangeTimeframe`, `onDidChange`
- Persistence:
  - `workspaceState` key: `quantlab.globalMarketState`
  - Serialize dateRange as ISO strings.
- Default values: `AAPL`, `1D`.
- Backend optimizations:
  - Normalize symbol input (`trim`, uppercase) and ignore no-op updates.
  - Validate timeframe against the allowed union; fallback to default if invalid.
  - Persist on a short debounce (e.g., 200ms) to coalesce rapid updates.
  - Keep a cached snapshot and emit events only when the snapshot changes.
  - On activation, push the initial state to the title bar once to avoid stale chrome.

Integration points:
- `ViewManager` subscribes to `onDidChangeSymbol/timeframe`:
  - Chart view reloads on change.
  - Action view pre-fills defaults.
  - Trade view does not alter active sessions.

### 3. Window Chrome UI (Title Bar)
Implement spec-compliant controls in the title bar.

Workbench UI (primary path):
- Add Quantlab title bar containers in `titlebarPart.ts`.
- The containers render:
  - Symbol button: `AAPL ▼`
  - Timeframe button: `1D ▼`
  - History button: `History ▼` with optional badge `(n)`
- Button clicks execute extension commands:
  - `quantlab.selectSymbol`
  - `quantlab.selectTimeframe`
  - `quantlab.toggleHistoryDropdown`
- Workbench listens for `quantlab.updateTitlebarState` to update labels and badge.
  - Update only the mutated fields to reduce DOM churn.
  - Guard against null/undefined payloads to avoid inconsistent title bar state.

Extension bridge:
- In `GlobalSelectors.ts`, on state changes call:
  - `vscode.commands.executeCommand('quantlab.updateTitlebarState', { symbol, timeframe, historyCount })`
- If the command is missing (unpatched build), show fallback status bar items.
- Optimization: track last-sent values and avoid sending duplicate updates.

Fallback UI (unpatched builds):
- Status bar items aligned to the right:
  - Symbol selector (priority 100)
  - Timeframe selector (priority 99)
  - History button (priority 98)
- This fallback is hidden when the workbench title bar is present.
- Backend optimizations:
  - Recent symbols are stored per workspace (`quantlab.recentSymbols`) and capped (e.g., 10).
  - Symbol QuickPick uses recent symbols first, then manual input.

### 4. History State Manager
Implement the History store with persistence and events.

File: `extensions/quantlab/src/types/history.ts`
- `RunType`, `RunStatus`, `HistoryEntry`, `HistoryQuery`.
- Include: `progress`, `progressMessage`, `metrics`, `warnings`, `errorMessage`, `artifactPath`, `pinned`, `tags`, `viewed`.

File: `extensions/quantlab/src/core/state/HistoryState.ts`
- Singleton with CRUD + queries:
  - `createEntry`, `getEntry`, `updateEntry`, `deleteEntry`
  - `query`, `getRunningJobs`, `getRecent`, `getByStrategy`
  - `getUnviewedCount`, `markAsViewed`, `togglePin`
- Persistence:
  - `globalState` key: `quantlab.historyEntries`
  - Max entries: 1000, FIFO eviction, keep pinned.
- Events:
  - `onDidAdd`, `onDidUpdate`, `onDidDelete`, `onDidChange`.
- Backend optimizations:
  - Debounce persistence (e.g., 250ms) and persist immediately on terminal status changes (completed/failed/cancelled).
  - Store `startedAt` and `completedAt` as ISO strings; compute numeric timestamps on load to avoid repeated `Date` parsing in hot paths.
  - Keep a cached `unviewedCount` that updates incrementally (avoid full scans on each update).
  - Reject updates that would regress status (e.g., `completed` -> `running`) unless explicitly allowed.
  - Sanitize restored entries (required fields, known enums) and drop invalid entries gracefully.
  - Clamp `progress` to 0-100 and ignore `NaN` values.
  - Compute `strategyHash` on entry creation (prefer Git HEAD hash; fallback to content hash).
  - Store only summary metrics and artifact paths in state; large payloads remain on disk.

### 5. History Dropdown
Implement a QuickPick-based History dropdown.

File: `extensions/quantlab/src/panels/history/HistoryDropdown.ts`
- Command: `quantlab.toggleHistoryDropdown` (`Ctrl+Q H`)
- Sections:
  - RUNNING (progress + cancel button)
  - Filter row (All + RunType categories from HistoryState)
  - TODAY, YESTERDAY, EARLIER (recent runs)
  - Open History Panel
- Actions:
  - Select run: open Action view with results (stub in Phase 2).
  - Cancel: call `quantlab.cancelHistoryRun` (engine integration stub).
  - Prioritize: call `quantlab.prioritizeHistoryRun` (stub).
- Ensure `HistoryState.markAsViewed(id)` is called when a run is opened.
- Update the title bar badge with `HistoryState.getUnviewedCount()`.
- Optimization: build items lazily on open and avoid refreshing the QuickPick while it is open unless the user triggers a refresh.
- Persist the filter selection in workspace state (`quantlab.historyFilter`) so it restores on reload.
- Filtering uses `HistoryState.query({ type })` to avoid loading unrelated entries.

### 6. Activity Bar Panels (5)
Implement five separate view containers (one icon per panel).

Package contributions in `extensions/quantlab/package.json`:
- `viewsContainers.activitybar`:
  - `quantlab.dataContainer` (Data)
  - `quantlab.resourcesContainer` (Resources)
  - `quantlab.historyContainer` (History)
  - `quantlab.tradeContainer` (Trade)
  - `quantlab.settingsContainer` (Settings)
- `views`:
  - Each container has a single view with matching ID.

#### 6.1 Data Panel
File: `extensions/quantlab/src/panels/data/DataTreeProvider.ts`
- Sections: Symbol Search, Watchlists, Universes, Data Sources.
- Symbol items:
  - Command: `quantlab.setGlobalSymbol`
  - Context menu: open Chart, add to watchlist, remove from watchlist.
- Watchlists persist in `globalState` (user-level).
- Highlight the active symbol (description: "current" or a `check` icon).
- Drag-and-drop source for symbol items (`application/quantlab-symbol`).
- Symbol search:
  - Command: `quantlab.searchSymbol` invokes the symbol search input from the panel entry point.
  - Results update the global symbol when selected (no workflow change).
- Backend optimizations:
  - Provide stable `TreeItem.id` values to keep expansion state.
  - On symbol change, refresh only the affected watchlist branch when feasible.
  - Keep watchlist data in a small in-memory cache; persist on a short debounce.

File: `extensions/quantlab/src/panels/data/WatchlistManager.ts`
- CRUD on watchlists (add, rename, delete, add/remove symbol).
- Persistence key: `quantlab.watchlists`.

#### 6.2 Resources Panel
File: `extensions/quantlab/src/panels/resources/resourcesCatalog.json`
- Static catalog of tests, templates, guides per spec.

File: `extensions/quantlab/src/panels/resources/ResourcesTreeProvider.ts`
- Render catalog as tree.
- Commands:
  - Tests: open Action view with selected test (stub).
  - Templates: create a new strategy file (stub).
  - Guides: open documentation (stub).
- Auto-expand when entering Action view (use `ViewManager` to focus panel).
- Backend optimizations:
  - Load `resourcesCatalog.json` once and keep it in memory.
  - Assign `TreeItem.id` for stable expand/collapse behavior.

#### 6.3 History Panel
File: `extensions/quantlab/src/panels/history/HistoryTreeProvider.ts`
- Sections:
  - Search (panel entry point for filtering)
  - Pinned
  - Recent
  - By Strategy
  - Compare (placeholder)
- Multi-select enabled for compare (Phase 4).
- Context menu actions: Pin/Unpin, Delete, Export, View Artifacts.
- Drag-and-drop source for history entries (`application/quantlab-run`).
- Backend optimizations:
  - Build section children lazily on expand and avoid re-sorting when not needed.
  - Use `TreeItem.id` to preserve selection and expanded sections.
  - Search command filters in-memory results only (no disk scan in Phase 2).

#### 6.4 Trade Panel
File: `extensions/quantlab/src/panels/trade/TradeTreeProvider.ts`
- Sections:
  - Session Control (strategy + account selectors, start buttons)
  - Active Sessions
  - Positions
  - Open Orders
  - Risk Status
  - Connections
- Commands are stubs in Phase 2; click opens Trade view or settings.
- Auto-expand when entering Trade view.
- Backend optimizations:
  - Use placeholder nodes that are cheap to render (no live polling in Phase 2).

#### 6.5 Settings Panel
File: `extensions/quantlab/src/panels/settings/SettingsTreeProvider.ts`
- Sections:
  - Broker Connections
  - Data Sources
  - Appearance
  - Performance
  - Safety
  - Storage
- Each item opens settings UI with an appropriate query:
  - `workbench.action.openSettings` + `quantlab.<section>` query.

### 7. Drag-and-Drop Infrastructure
Implement drag controllers for symbols and history runs:

- Data panel drag:
  - MIME types: `text/plain`, `application/quantlab-symbol`
  - Payload: ticker symbol(s)
- History panel drag:
  - MIME type: `application/quantlab-run`
  - Payload: HistoryEntry ID

Drop handling will be wired in Phase 3 (Chart view) and Phase 4 (Action view).
Optimization: payloads are intentionally small (IDs/symbols only) to avoid memory churn and keep drag operations fast.

### 8. Commands and Keybindings
Commands (add to `extensions/quantlab/package.json`):
- Global state:
  - `quantlab.selectSymbol`
  - `quantlab.selectTimeframe`
  - `quantlab.setGlobalSymbol`
  - `quantlab.searchSymbol`
- History:
  - `quantlab.toggleHistoryDropdown`
  - `quantlab.openHistoryEntry`
  - `quantlab.cancelHistoryRun`
  - `quantlab.prioritizeHistoryRun`
  - `quantlab.searchHistory`
- Panels:
  - `quantlab.focusDataPanel`
  - `quantlab.focusResourcesPanel`
  - `quantlab.focusHistoryPanel`
  - `quantlab.focusTradePanel`

Keybindings:
- `Ctrl+Q H` → toggle History dropdown.
- `Ctrl+Q 1` → focus Data panel.
- `Ctrl+Q 2` → focus Resources panel.
- `Ctrl+Q 3` → focus History panel.
- `Ctrl+Q 4` → focus Trade panel.

### 9. Activation and Wiring
Update `extensions/quantlab/src/extension.ts`:
- Initialize GlobalState and HistoryState.
- Register GlobalSelectors (title bar bridge + fallback).
- Register HistoryDropdown.
- Register TreeDataProviders for all panels.
- Register symbol and history search commands.
- Wire auto-expand behaviors:
  - On Action view activation, focus Resources panel.
  - On Trade view activation, focus Trade panel.
- Update title bar badge when HistoryState changes.
- Optimization: coalesce rapid HistoryState updates and only push title bar badge updates when the count changes.

### 10. Implementation Checklist (File-by-file)

Workbench patches:
- [ ] `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`
  - Add Quantlab market container (symbol/timeframe) in center-right cluster.
  - Add Quantlab history container (history button + badge) in right cluster.
  - Wire button clicks to `quantlab.selectSymbol`, `quantlab.selectTimeframe`, `quantlab.toggleHistoryDropdown`.
  - Register `quantlab.updateTitlebarState` and update labels/badge idempotently.
- [ ] `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`
  - Style containers, buttons, hover/focus, and badge.
- [ ] `src/vs/workbench/browser/parts/activitybar/activitybarPart.css`
  - Optional visual separator above Quantlab Activity Bar items.

Extension core:
- [ ] `extensions/quantlab/src/types/market.ts`
- [ ] `extensions/quantlab/src/core/state/GlobalState.ts`
- [ ] `extensions/quantlab/src/types/history.ts`
- [ ] `extensions/quantlab/src/core/state/HistoryState.ts`

Extension UI bridge:
- [ ] `extensions/quantlab/src/ui/GlobalSelectors.ts`
  - Title bar update command bridge.
  - Fallback status bar selectors.
  - Recent symbol handling and QuickPick flows.

Panels:
- [ ] `extensions/quantlab/src/panels/data/DataPanelProvider.ts`
- [ ] `extensions/quantlab/src/panels/data/DataTreeProvider.ts`
- [ ] `extensions/quantlab/src/panels/data/WatchlistManager.ts`
- [ ] `extensions/quantlab/src/panels/resources/ResourcesPanelProvider.ts`
- [ ] `extensions/quantlab/src/panels/resources/ResourcesTreeProvider.ts`
- [ ] `extensions/quantlab/src/panels/resources/resourcesCatalog.json`
- [ ] `extensions/quantlab/src/panels/history/HistoryPanelProvider.ts`
- [ ] `extensions/quantlab/src/panels/history/HistoryTreeProvider.ts`
- [ ] `extensions/quantlab/src/panels/history/HistoryDropdown.ts`
- [ ] `extensions/quantlab/src/panels/trade/TradePanelProvider.ts`
- [ ] `extensions/quantlab/src/panels/trade/TradeTreeProvider.ts`
- [ ] `extensions/quantlab/src/panels/settings/SettingsPanelProvider.ts`
- [ ] `extensions/quantlab/src/panels/settings/SettingsTreeProvider.ts`
- [ ] `extensions/quantlab/src/utils/dragDrop.ts`

Commands and contributions:
- [ ] `extensions/quantlab/src/commands/globalStateCommands.ts`
- [ ] `extensions/quantlab/src/commands/historyCommands.ts`
- [ ] `extensions/quantlab/src/commands/panelCommands.ts`
- [ ] `extensions/quantlab/package.json`
  - `viewsContainers.activitybar` entries for 5 panels.
  - `views` registration for each panel.
  - `commands`, `menus`, and `keybindings` per Phase 2 spec.

Activation:
- [ ] `extensions/quantlab/src/extension.ts`
  - Initialize GlobalState and HistoryState.
  - Register UI bridge, History dropdown, and all panels.
  - Wire auto-expand behaviors and update title bar badge.

Tests:
- [ ] `test/unit/quantlab/GlobalState.test.ts`
- [ ] `test/unit/quantlab/HistoryState.test.ts`
- [ ] `test/integration/quantlab/globalState.test.ts`
- [ ] `test/integration/quantlab/historyDropdown.test.ts`

### 11. Testing Plan
Unit tests:
- `GlobalState` persistence and events.
- `HistoryState` CRUD, query filters, max-entry eviction, unviewed count.
- Corrupt-state recovery (invalid persisted payloads fall back to defaults).
- Persistence debouncing does not skip final state.

Integration tests:
- Title bar selectors update when symbol/timeframe changes (or fallback status bar).
- History dropdown shows running + recent sections and opens Action view.
- Activity Bar panels render and respond to commands.
- Drag data types are attached for symbol and history entries.

Manual checklist:
1. Symbol selector changes global state and updates title bar label.
2. Timeframe selector changes global state and updates label.
3. History button opens dropdown with running and recent runs.
4. History badge count decreases after viewing a run.
5. Data panel symbol double-click updates global symbol.
6. Resources panel auto-expands when switching to Action view.
7. Trade panel auto-expands when switching to Trade view.
8. Ctrl+Q shortcuts focus panels and open History dropdown.

### 12. Exit Gates
Phase 2 is complete when:
- Global Symbol/Timeframe selectors work and persist per workspace.
- History button in window chrome opens dropdown with running + recent runs.
- History store persists entries and tracks unviewed count.
- All 5 Activity Bar panels render with basic interactions.
- Drag-and-drop sources work for symbols and history runs.
- Ctrl+Q shortcuts function without conflicts.
- Unit and integration tests pass.
- No regressions in Phase 1 view system.

## Deliverables
- Phase 2 extension code under `extensions/quantlab`.
- Workbench patch list in `extensions/quantlab/docs/PATCHES_PHASE_2.md`.
- Unit and integration tests for GlobalState and HistoryState.
- Updated `extensions/quantlab/package.json` with views, commands, and keybindings.
