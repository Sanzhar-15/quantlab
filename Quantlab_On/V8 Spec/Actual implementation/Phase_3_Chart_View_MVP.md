# Quantlab Phase 3 Chart View MVP - Full Implementation Plan

Version: 1.1
Owner: Quantlab PM/Eng
Timebox: 3-5 weeks
Goal: Implement the Chart view webview, parameter system, complexity gating, and Delta charting integration per V8.1, with data pipeline and visualization execution.

## References (Source of Truth)
- Quantlab V8.1 UI/UX spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 3 plan: `Quantlab_On/Deeper_implementation_plan/Phase_3_Chart_View_MVP.md`
- Phase 1 implementation plan: `Quantlab_On/Actual implementation/Phase_1_Core_View_System.md`
- Phase 2 implementation plan: `Quantlab_On/Actual implementation/Phase_2_Window_Chrome_Activity_Bar_History.md`
- Charting engine and docs: `Charts/`
- Workbench patches Phase 1 and 2: `extensions/quantlab/docs/PATCHES_PHASE_1.md`, `extensions/quantlab/docs/PATCHES_PHASE_2.md`

Note: The Quantlab extension root is `extensions/quantlab` (built-in extension per Phase 1 decisions). If this extension folder does not yet exist in the repo, Phase 3 scaffolding includes creating it.

## Phase 3 Objectives
1. Integrate the Delta charting engine into a Chart view webview that replaces the editor pane for Chart view tabs.
2. Implement Chart toolbar controls (symbol, timeframe, date range, refresh, screenshot, settings) with per-tab overrides.
3. Build the parameter system end-to-end: extraction from `ql.param`, rendering sliders, overrides, reset, and Apply to Code.
4. Implement visualization code detection and safe execution with a chart proxy and command application.
5. Implement complexity analysis and the Safe, Partial, View-Only UX gating with banners and disabled controls.
6. Implement a data pipeline for OHLCV, signals, and equity curves with binary transfer and caching.
7. Support drag and drop targets for symbol and history run artifacts in Chart view.
8. Provide error handling and recovery for chart crashes, visualization errors, and missing data.
9. Ensure keyboard and screen reader accessibility for Chart view controls.
10. Add unit and integration tests for chart view behavior, parameter system, and complexity analysis.

## Scope
In scope:
- Chart view webview and custom editor wiring.
- Delta chart engine bundling and API wrapper.
- Parameter extractor and webview parameter panel.
- Visualization detector and execution pipeline.
- Complexity analyzer and view-only gating UX.
- OHLCV data load stub plus binary transfer path.
- Signal overlays, equity curve overlay, and run artifact loading.
- Drag and drop targets for symbol and history runs.
- Screenshot export and chart settings baseline UI.
- Error states and recovery for Chart view.
- Unit and integration tests for Chart view.

Out of scope:
- Action view full workflow (Phase 4).
- Trade view live sessions (Phase 5).
- Full engine job queue and broker adapters (Phase 5).
- History compare view (Phase 4).
- Notifications system and onboarding (Phase 6).
- Deep chart drawing tools and advanced indicator library (post-MVP).

## Backend Optimization Principles (Non-UX)
- Prefer binary data transfer for OHLCV and signal payloads with transferable ArrayBuffers.
- Debounce parameter changes and throttle refreshes to avoid rerunning strategy on every slider tick.
- Cache last successful chart data per tab with a bounded LRU to avoid redundant loads.
- Avoid full webview reloads on minor state changes; patch data via postMessage.
- Defer heavy visualization execution until data is loaded and the webview signals readiness.
- Dispose idle chart instances and reclaim buffers after inactivity.
- Use request IDs and cancellation tokens so stale data/visualization results are ignored.
- Cache ParameterExtractor results by document version to avoid re-parsing on every keystroke.
- Throttle document change handling and run heavy analysis on idle or save.
- Dedupe chart update messages (skip no-op updates to the webview).
- Cap in-memory artifact caches and free buffers immediately after transfer.

## Phase 3 Decisions (Locked)
1. Chart view uses a CustomTextEditorProvider with a webview and the Phase 1 in-place switching mechanism.
2. Chart engine is the Delta charting stack under `Charts/` and is bundled into the webview bundle.
3. Parameter extraction uses AST parsing with a regex fallback; unparseable params drive Complexity to Partial or View-Only.
4. Parameter overrides are session-only; they are not persisted to disk unless Apply to Code is used.
5. Symbol, timeframe, and date range overrides are per-tab and persisted in TabViewState.
6. Complexity View-Only skips live visualization execution and shows last run artifacts only.
7. Data transfer uses binary ArrayBuffer first; JSON fallback is allowed for small payloads or debugging.
8. No new workbench patches are planned; if required, they must be recorded in `extensions/quantlab/docs/PATCHES_PHASE_3.md`.

## Non-Negotiable V8.1 Requirements (Phase 3 Relevant)
- Chart view is a per-tab view state with a green stripe (#059669) and no global mode.
- Chart view is available only for .py files with a valid strategy structure.
- Chart toolbar includes symbol, timeframe, date range, complexity indicator, settings, refresh, and screenshot.
- Parameter panel shows all `ql.param()` definitions with Reset to Defaults and Apply to Code.
- Complexity indicator displays Safe, Partial, or View-Only with correct gating behavior.
- View-Only shows last run artifacts and disables parameter sliders with a banner.
- No visualization code prompts Add Manually and Generate with AI options.
- Symbol/timeframe changes reload chart data when no per-tab override exists.
- Drag symbol to Chart view changes chart symbol; drag history run loads run artifacts.

## Backend Invariants (No UX Changes)
- Chart view only applies data/visualization results for the latest request ID per tab.
- Parameter overrides are session-only and never persisted to disk unless Apply to Code is used.
- View-Only never executes visualization code; it uses last run artifacts only.
- Webview commands are processed only after `ready` is received; pre-ready messages are queued.
- Data is sorted by timestamp before rendering; invalid bars are dropped (with logs).
- Apply to Code uses a single WorkspaceEdit; if the document changed since extraction, abort and re-extract.

## Dependencies from Phases 1 and 2
- TabViewState and view switching commands exist and handle per-tab view state.
- GlobalState (symbol, timeframe, date range) with workspace persistence is available.
- HistoryState with run metadata and artifacts (or stub storage) is available.
- Activity Bar Data panel and History panel provide drag sources for symbols and runs.
- Workbench patches for tab stripe and title bar are already applied.

## Workbench Patch Plan (Phase 3)
No new workbench patches are expected. If a patch is required to support webview lifecycle, view-only banners, or accessibility labels, record it in `extensions/quantlab/docs/PATCHES_PHASE_3.md` with exact file paths and rationale.

## Implementation Plan

### 1. Phase 3 file layout and build pipeline
Extend the Quantlab extension under `extensions/quantlab` with Chart view code and webview assets.

```
extensions/quantlab/
  package.json
  src/
    extension.ts
    types/
      chart.ts
      visualization.ts
      strategy.ts
      market.ts
      history.ts
    core/
      strategy/
        ParameterExtractor.ts
        VisualizationDetector.ts
        ComplexityAnalyzer.ts
      engine/
        DataService.ts
        VisualizationRunner.ts
    views/
      chart/
        ChartViewProvider.ts
        ChartWebview.ts
        ChartStateStore.ts          # Per-tab caches, request IDs, overrides
    utils/
      applyToCode.ts
      binaryTransfer.ts
      debounce.ts
  webview/
    chart/
      index.ts
      chartApi.ts
      messageHandler.ts
      parameterPanel.ts
      errorBoundary.ts
      chart.css
  dist/
    webview/
      chart.js
  docs/
    PATCHES_PHASE_3.md (if needed)
```

Build pipeline:
- Add a dedicated webview bundler config (webpack or esbuild) to output `dist/webview/chart.js`.
- Bundle Delta charting packages from `Charts/packages/*` into the webview bundle.
- Keep the extension host bundle separate from the webview bundle.
- Provide build scripts for `build:extension`, `build:webview`, and `watch:webview`.
- Enable source maps in development only; disable in production to reduce load time.

### 2. Extension registrations and contributions
Update `extensions/quantlab/package.json`:

- `contributes.customEditors`:
  - viewType: `quantlab.chartView`
  - selector: `*.py`
  - priority: `option`
- `contributes.commands`:
  - `quantlab.chart.refresh`
  - `quantlab.chart.screenshot`
  - `quantlab.chart.applyParameters`
  - `quantlab.chart.resetParameters`
  - `quantlab.chart.toggleParameters`
  - `quantlab.chart.openSettings`
  - `quantlab.chart.addVisualizationTemplate`
  - `quantlab.chart.generateVisualization`
- `contributes.menus`:
  - Editor and tab context menus for Chart view actions when in Chart view.
- Keybindings:
  - Only if required, use Ctrl+Q prefix and avoid conflicts.

### 3. Chart view provider and lifecycle
Implement `ChartViewProvider` as a `CustomTextEditorProvider`.

Core responsibilities:
- Create and manage webview panels per tab instance ID.
- Bind to `TabViewState` and `GlobalState` updates.
- Initialize Chart view state and post `init` message to webview.
- Load OHLCV data and overlays after webview is ready.

Key behaviors:
- `resolveCustomTextEditor`:
  - Compute `tabInstanceId` using the Phase 1 algorithm.
  - Set `webview.options` with local resource roots and `enableScripts`.
  - Inject HTML from `ChartWebview.getHtml()`.
  - Wire `onDidReceiveMessage` to handle parameter changes, overrides, refresh, and screenshot.
- `initializeChart`:
  - Determine effective symbol/timeframe/dateRange (tab override else global).
  - Analyze strategy: `StrategyValidator`, `VisualizationDetector`, `ComplexityAnalyzer`.
  - Send `init` with theme, complexity, hasVisualization, and toolbar defaults.
  - Send parameters (if extractable) and current overrides.
- Webview readiness:
  - Queue outbound messages until the webview sends `ready`.
  - Drop queued messages if the webview is disposed before ready.
- Document change handling:
  - Debounce updates (e.g., 250ms) and re-run parameter extraction and visualization detection.
  - Recompute complexity and update the indicator in the webview.
  - If visualization code changed, re-run visualization execution when safe.
  - Avoid full re-renders if only non-visual code changed (use code hash).
- Chart state:
  - Persist per-tab overrides (symbol/timeframe/dateRange/panelCollapsed) via `TabViewState`.
  - Keep parameter overrides in a session-only store (`ChartStateStore`) not persisted to disk.
  - Track `lastDataRequestId`, `lastVizRequestId`, `lastDataFingerprint`, and `lastVizHash`.
- Cleanup:
  - Dispose chart instances and free buffers when webview is closed or inactive.
  - Cancel in-flight data/visualization requests on tab close.
- Global state changes:
  - On symbol/timeframe change, reload chart data only if the tab has no override.
  - On date range change, reload only when the effective range differs.
- Theme changes:
  - Listen for VS Code theme changes and send `setTheme` to the webview.

### 4. Webview shell and UI
Implement the Chart view webview HTML and styling.

Layout:
- Toolbar row with symbol selector, timeframe selector, date range, complexity indicator, refresh, screenshot, settings.
- Chart container fills the available space.
- View-Only banner area (hidden unless View-Only).
- No-visualization prompt overlay for missing `visualize()` function.
- Parameter panel at the bottom with collapse toggle, parameter controls, Reset, Apply to Code.

UI states:
- No visualization code:
  - If no prior run artifacts, show prompt as primary content.
  - If artifacts exist, show chart with default markers and prompt as an overlay.
- View-Only:
  - Show banner with last run info and "Run New Backtest" button.
  - Disable parameter controls and prevent Apply to Code.
- No data:
  - Show a friendly "No data for SYMBOL" state with action to change symbol.

### 5. Chart API wrapper and engine integration
Provide a stable chart API in the webview that wraps the Delta chart engine.

`QuantlabChartAPI` should include:
- Lifecycle: `initialize`, `dispose`.
- Data: `setData`, `appendBar`, `clearData`.
- Overlays: `addSignals`, `clearSignals`, `setEquityCurve`, `clearEquityCurve`.
- Indicators: `addIndicator`, `removeIndicator`, `clearIndicators`.
- Interaction: `setVisibleRange`, `highlightBar`.
- Appearance: `setTheme`.
- Export: `screenshot`.

Implementation notes:
- Use the chart engine from `Charts/` packages and set default candlestick colors.
- Support a secondary pane for equity curve.
- Convert strategy signals into entry and exit markers with standard colors.

### 6. Message protocol and shared types
Define message types in `types/chart.ts` and `types/visualization.ts` and reuse across extension and webview.

Extension to webview:
- `init`: theme, complexity, hasVisualization, toolbar defaults.
- `setData`: JSON or binary OHLCV payload (include `requestId`).
- `setSignals`: entry and exit signals for overlay (include `requestId`).
- `setEquityCurve`: equity curve points for secondary pane (include `requestId`).
- `setParameters`: extracted parameter definitions.
- `setOverrides`: current parameter overrides.
- `setComplexity`: safe, partial, viewOnly plus score and reasons.
- `setTheme`: light or dark.
- `showBanner`: view-only or run banner text.
- `showError`: chart or visualization error.

Webview to extension:
- `ready`
- `parameterChange`
- `resetDefaults`
- `applyToCode`
- `overrideSymbol`
- `overrideTimeframe`
- `overrideDateRange`
- `refresh`
- `screenshot`
- `addVisualization`
- `generateVisualization`
- `runBacktest`
- `error`
- `requestDataReload` (optional; used when user resets chart settings)

### 7. Data pipeline and run artifacts
Implement the data pipeline in the extension.

`DataService`:
- Provide `getOHLCV(symbol, timeframe, dateRange)` with a stub that returns mock data until the engine is wired.
- Provide `getLatestBars` for streaming updates (optional).
- Support binary encoding of OHLCV for webview transfer.
- Use request IDs and cancellation tokens to prevent stale responses from applying.
- Cache recent OHLCV payloads by `(symbol, timeframe, dateRange)` with a small LRU and TTL.

`StrategyRunner` or `VisualizationRunner` output:
- Run the strategy to generate signals and equity curve for the current data set.
- Return `signals` and `equity` arrays for overlays.
- Use strategy hash + data hash to skip redundant runs when nothing changed.

Run artifacts integration:
- Add `HistoryState.getRunArtifacts(runId)` to retrieve signals and equity curve.
- Support a `quantlab.chart.showRun` command for History and Action views to call.
- When run artifacts are loaded, show a banner: "Showing results from Run X".
- If no artifacts exist, show an empty chart state and keep the banner prompt to run a new backtest.

### 8. Visualization detection and execution
Implement visualization code support per spec.

`VisualizationDetector`:
- Detect `def visualize(chart)` and its location.
- Expose `hasVisualization` for UI state.

`VisualizationRunner`:
- Execute `visualize(chart)` in a sandboxed Python process.
- Provide a `ChartProxy` object that records commands like `plot`, `mark_entries`, `add_pane`, `plot_equity`.
- Return a `VisualizationCommand[]` to the extension.
- Enforce timeouts and memory limits; on timeout, fall back to default markers and log details.
- Cache visualization commands by strategy hash and data hash; reuse when inputs are unchanged.

Webview application:
- Translate `VisualizationCommand[]` into chart API calls.
- Apply commands after data is set and indicators are available.

No visualization code flows:
- Add Manually: insert a `visualize(chart)` template at end of file, switch to Editor view, and place cursor inside the template.
- Generate with AI: open the AI panel with a prompt seeded from the current strategy; insert on accept.
- Fallback: if no `visualize()` exists, render OHLCV with default entry/exit markers.

Error handling:
- For visualization exceptions, show an inline error state with the line number and "Edit visualization code" action.
- Errors do not crash the chart; default markers remain.

### 9. Parameter system and Apply to Code
Implement parameter extraction and UI.

`ParameterExtractor`:
- Parse `ql.param` calls and return a list of `ParameterDefinition` objects.
- Capture id, default, min, max, step, choices, name, group, description, format.
- If parsing is partial or fails, return warnings to the ComplexityAnalyzer.
- Preserve parameter order as defined in code to keep UI stable.
- Detect duplicate parameter IDs and downgrade Complexity to Partial with a warning.

Parameter panel:
- Render grouped parameters with proper controls (range, select, checkbox, text).
- Display formatted values for percent and currency.
- Debounce changes (300ms) before triggering chart updates.
- Only emit changes when value actually changes to avoid redundant updates.

Overrides:
- Store overrides in session-only `ChartStateStore` keyed by tabInstanceId.
- Reset to Defaults clears overrides and re-runs visualization.
- Apply to Code rewrites the source file defaults and clears overrides.

Apply to Code:
- Use AST or structured regex to replace default values in `ql.param`.
- Preserve formatting and comments where possible.
- Perform edits via `WorkspaceEdit` to integrate with undo and redo.
- If the document has unsaved changes, apply on the current in-memory version.

### 10. Complexity indicator and view-only gating
Implement `ComplexityAnalyzer` to classify strategies.

Rules:
- Safe: single-file, extractable params, no dynamic code or external API.
- Partial: imports or complex patterns but still analyzable.
- View-Only: dynamic code, external API, parse errors, or unextractable params.
  - Default to Partial (not Safe) if analysis is inconclusive.

UI behavior:
- Toolbar shows "Complexity: 3/5 Safe" style label with green, yellow, or red.
- View-Only disables parameter controls and blocks live visualization execution.
- View-Only banner shows last run details and a "Run New Backtest" action.
- Partial shows a tooltip with reasons; unparseable params are hidden or shown as read-only.

### 11. Chart toolbar and per-tab overrides
Implement toolbar interactions in the webview.

Symbol and timeframe:
- Populate lists from extension (recent symbols plus standard timeframes).
- On selection, send override message to extension.
- Overrides persist per tab until cleared.
  - Store overrides only when they differ from GlobalState to avoid redundant reloads.

Date range:
- Provide a date range control (text input or picker).
- Store override in TabViewState and reload data.
- Validate `start <= end`; ignore invalid updates and keep the last valid range.

Refresh:
- Reload data and rerun visualization with current overrides.
  - Ignore refresh if an identical request is already in flight.

Screenshot:
- Webview captures canvas to data URL or Blob.
- Extension opens save dialog and writes file.
  - Use a deterministic default filename (strategy + symbol + timeframe + date).

Settings:
- Provide a minimal settings popover for chart type and color theme.
- Persist settings per tab if possible.

### 12. Drag and drop integration
Implement Chart view drop targets for Data and History panels.

Symbol drag:
- Accept data type `application/quantlab-symbol`.
- Update chart symbol override and reload data.

History run drag:
- Accept data type `application/quantlab-history-run`.
- Load artifacts for the run and show run banner.

Implementation:
- Add drag handlers in the webview (`dragenter`, `dragover`, `drop`).
- Validate payloads and ignore unknown drop types.

### 13. Error handling, recovery, and memory management
Implement robust error handling for Chart view.

Webview:
- Global error boundary to catch exceptions and report to extension.
- Display in-webview error overlay with "Reload Chart".
- Recoverable errors trigger reinit requests.

Extension:
- Log errors to a dedicated output channel "Quantlab Chart".
- For fatal errors, show a VS Code error message with "View Logs" and "Reload".
- For missing data, show a non-fatal empty state and allow symbol changes.
- Deduplicate repeated errors within a short window to avoid notification spam.

Memory:
- Keep a bounded cache of chart instances (max 5).
- Dispose charts on tab close or after idle timeout (5 minutes).
- Release binary buffers after data is applied.
- Clear per-tab caches when the associated document is closed.

### 14. Accessibility and keyboard
Implement WCAG AA basics in the webview.

- All toolbar buttons and parameter controls have ARIA labels.
- Use `role="status"` live region for announcements (data loaded, parameter change, complexity).
- Focus rings visible on all interactive elements.
- Respect `prefers-reduced-motion` for animations.
- Support keyboard navigation within toolbar and parameter panel.

### 15. Cross-view integration hooks
Prepare interfaces for Phase 4 and 5 integrations.

- `quantlab.chart.showRun(runId, source)` command for Action and History.
- `quantlab.chart.showTradeSession(sessionId)` for Trade view in Phase 5.
- `quantlab.chart.getParameterOverrides(tabId)` for Action view parameter sync.

## Implementation Checklist (File-by-file)

Extension core:
- [ ] `extensions/quantlab/src/types/chart.ts`
- [ ] `extensions/quantlab/src/types/visualization.ts`
- [ ] `extensions/quantlab/src/types/strategy.ts` (ensure parameter/visualization types are aligned)
- [ ] `extensions/quantlab/src/core/strategy/ParameterExtractor.ts`
  - Document-version cache + duplicate ID detection.
- [ ] `extensions/quantlab/src/core/strategy/VisualizationDetector.ts`
- [ ] `extensions/quantlab/src/core/strategy/ComplexityAnalyzer.ts`
  - Conservative defaults + reasons output.
- [ ] `extensions/quantlab/src/core/engine/DataService.ts`
  - Request IDs + cancellation + LRU cache.
- [ ] `extensions/quantlab/src/core/engine/VisualizationRunner.ts`
  - Sandbox + timeout + command cache.

Chart view wiring:
- [ ] `extensions/quantlab/src/views/chart/ChartViewProvider.ts`
  - Webview readiness queue + request ID gating.
- [ ] `extensions/quantlab/src/views/chart/ChartWebview.ts`
  - HTML + CSP + asset URI helper.
- [ ] `extensions/quantlab/src/views/chart/ChartStateStore.ts`
  - Per-tab caches + overrides + in-flight request tracking.

Utilities:
- [ ] `extensions/quantlab/src/utils/applyToCode.ts`
  - Single WorkspaceEdit + version guard.
- [ ] `extensions/quantlab/src/utils/binaryTransfer.ts`
  - Encode/decode helpers for OHLCV.
- [ ] `extensions/quantlab/src/utils/debounce.ts`

Webview:
- [ ] `extensions/quantlab/webview/chart/index.ts`
- [ ] `extensions/quantlab/webview/chart/chartApi.ts`
- [ ] `extensions/quantlab/webview/chart/messageHandler.ts`
- [ ] `extensions/quantlab/webview/chart/parameterPanel.ts`
- [ ] `extensions/quantlab/webview/chart/errorBoundary.ts`
- [ ] `extensions/quantlab/webview/chart/chart.css`

Packaging/build:
- [ ] `extensions/quantlab/package.json`
  - `contributes.customEditors` + commands/menus.
- [ ] `extensions/quantlab/webpack.webview.js` (or esbuild config)
- [ ] `extensions/quantlab/tsconfig.webview.json` (if separate)

Docs:
- [ ] `extensions/quantlab/docs/PATCHES_PHASE_3.md` (only if patching workbench)

## Testing and Verification

### Unit tests
- `ComplexityAnalyzer` classification coverage for safe, partial, viewOnly.
- `VisualizationDetector` detects visualize function and line number.
- `ParameterExtractor` parses numeric, boolean, and choice params.
- `applyToCode` edits defaults correctly and preserves formatting.
- `DataService` cache hit/eviction and request ID handling.
- `binaryTransfer` encode/decode round-trip integrity.

### Integration tests
- Open a strategy file and switch to Chart view; chart renders OHLCV.
- Parameter slider change triggers a chart update and signal changes.
- Global symbol change reloads chart data when no override exists.
- View-Only strategy shows banner and disables parameter controls.
- No visualization code shows prompt and default markers when signals exist.
- Stale data responses do not override newer requests.
- Drag history run loads artifacts and shows run banner.

### Manual verification checklist
- Chart view toolbar displays symbol, timeframe, date range, and complexity.
- Refresh and screenshot buttons work; screenshot file is saved.
- Apply to Code updates the source file and clears overrides.
- Drag symbol from Data panel updates chart symbol.
- Drag history run into Chart view loads run artifacts and shows banner.
- Visualization errors show line number and "Edit visualization code".
- Add Manually inserts `visualize(chart)` template and moves cursor to it.
- Generate with AI opens the AI panel with the strategy context.

## Exit Gates
- Chart engine loads and renders OHLCV data in the webview.
- Parameter panel renders all `ql.param` definitions with controls.
- Apply to Code rewrites defaults and updates editor content.
- Complexity indicator reflects Safe, Partial, View-Only and gates UI.
- View-Only uses last run artifacts and disables live parameter changes.
- Symbol and timeframe overrides reload data; global changes propagate when no override.
- Chart screenshot export is functional.
- Error recovery paths for visualization errors and chart crashes are working.
- Unit and integration tests for Chart view are passing.
- No-visualization prompt and actions (Add Manually / Generate with AI) are functional.

## Performance Targets
- 10k candles render within 10ms P95 after data transfer.
- Pan and zoom interaction stays under 16.7ms frame time.
- Parameter update to chart response under 300ms P95.
- Binary data transfer for 10k candles under 50ms.
- Webview bundle size under 500KB gzipped (Chart view only).

## Appendix: Binary Data Transfer Summary
- Encode OHLCV into ArrayBuffer with fixed 48-byte layout per bar.
- Use `postMessage` with transferables to avoid copy.
- JSON fallback for small payloads or debugging.

## Appendix: Chart View Error States (V8.1)
- No data for symbol: show "No data available for SYMBOL" with symbol change action.
- Visualization error: show error with line number and "Edit visualization code".
- Chart crash: show "Chart failed to render" with "Reload Chart".
