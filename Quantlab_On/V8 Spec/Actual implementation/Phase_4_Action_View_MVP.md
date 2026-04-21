# Quantlab Phase 4 Action View MVP - Full Implementation Plan

Version: 1.1
Owner: Quantlab PM/Eng
Timebox: 3-5 weeks
Goal: Implement the Action view webview as the test runner and results surface with a four-state machine, engine job wiring, and full History/Resources integration per V8.1.

## References (Source of Truth)
- Quantlab V8.1 UI/UX spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 4 plan: `Quantlab_On/Deeper_implementation_plan/Phase_4_Action_View_MVP.md`
- Phase 1 implementation plan: `Quantlab_On/Actual implementation/Phase_1_Core_View_System.md`
- Phase 2 implementation plan: `Quantlab_On/Actual implementation/Phase_2_Window_Chrome_Activity_Bar_History.md`
- Phase 3 implementation plan: `Quantlab_On/Actual implementation/Phase_3_Chart_View_MVP.md`
- Charting engine and docs: `Charts/`

Note: The Quantlab extension root is `extensions/quantlab` (built-in extension per Phase 1 decisions). If this extension folder does not yet exist in the repo, Phase 4 scaffolding includes creating it.

## Phase 4 Objectives
1. Implement the Action view webview and four-state UI: Selection, Configuration, Running, Results.
2. Wire Action view into the view system as a CustomTextEditorProvider with per-tab persistence.
3. Implement Quick Actions (Backtest, Optimize, Monte Carlo, WFA) with spec-compliant defaults.
4. Build schema-driven configuration forms with validation and parameter source options.
5. Wire Action view to the engine job system with progress, logs, cancel, and completion.
6. Integrate History: record runs, update progress, pin, export, and open results.
7. Integrate Resources panel: double-click a test opens Action configuration.
8. Implement View in Chart flow and load run artifacts into Chart view.
9. Provide baseline results export (JSON, CSV, HTML) and compare selection.
10. Add unit, integration, and manual verification coverage for Action view flows.

## Scope
In scope:
- Action view webview UI and state machine.
- Quick Actions defaults and execution.
- Configuration form rendering, validation, and parameter source handling.
- Engine job start/cancel/progress/completion with live logs.
- Results view with metrics, details, warnings, and action buttons.
- HistoryState integration for runs and artifacts.
- Resources panel integration and auto-expand on Action view entry.
- View in Chart flow with artifact loading.
- Minimal compare selection wiring and export functionality.
- Accessibility and reduced motion handling in Action view.

Out of scope:
- Full compare analysis UI with charts (stub or minimal table only).
- Trade view session management (Phase 5).
- Notifications system beyond basic VS Code toasts (Phase 6).
- Advanced risk analytics or multi-asset backtest orchestration (post-MVP).
- Data sourcing beyond existing Phase 2 stubs.

## Backend Optimization Principles (Non-UX)
- Avoid full webview reloads; drive UI via postMessage state updates.
- Batch progress and log updates to prevent UI churn (coalesce every 100-250ms).
- Rate-limit state pushes to the webview (target <= 10 Hz) and prefer partial updates.
- Keep HistoryState writes debounced except terminal updates (completed, failed, cancelled).
- Store only summary metrics and artifact paths in HistoryState; keep large payloads on disk.
- Cache per-document config schemas and parameter definitions by document version.
- Use stable run IDs and ignore stale engine events by checking jobId and strategyHash.
- Route engine events by jobId and strategyPath; drop events for disposed panels.
- Keep log buffers bounded (last N lines) and avoid re-rendering full logs.
- Write artifacts atomically (temp then rename) to avoid partial reads.
- Parse NDJSON with chunk buffering to handle partial lines safely.

## Phase 4 Decisions (Locked)
1. Action view is implemented as a CustomTextEditorProvider webview, matching Chart view architecture.
2. Extension host maintains the Action state machine; webview is a renderer driven by state messages.
3. Quick Actions run immediately with default settings (spec-compliant); advanced config flows come from Resources panel.
4. Action view state persistence stores only minimal identifiers (state type, runId, lastConfig) and relies on HistoryState for details.
5. View in Chart uses History artifacts and ChartViewProvider.loadRunArtifacts for overlays and banner.
6. Compare action adds runs to History compare selection and opens a minimal compare view (table-only MVP).
7. No new workbench patches are planned; any required patch must be recorded in `extensions/quantlab/docs/PATCHES_PHASE_4.md`.

## Non-Negotiable V8.1 Requirements (Phase 4 Relevant)
- Action view is a per-tab state with orange stripe `#D97706`.
- Action view has four states: Selection -> Configuration -> Running -> Results.
- Quick Actions are Backtest, Optimize, Monte Carlo, WFA with spec defaults.
- Resources panel auto-expands on Action view entry.
- Action view supports parameter sources: code defaults, chart overrides, or run-specific.
- Results view supports View in Chart and shows a run banner in Chart view.
- All runs are recorded in History and appear in recent lists.
- Action view error states show inline validation and job failure details.
- All Quantlab commands use Ctrl+Q prefix (existing Phase 1 bindings).

## Dependencies from Phases 1-3
- TabViewState and ViewManager (per-tab view state and switching).
- Chart view provider and run artifact overlay path.
- GlobalState for symbol and timeframe defaults.
- HistoryState, History panel, and History dropdown (run storage and selection).
- Resources panel TreeView and catalog data.
- ParameterExtractor and Chart parameter overrides (Phase 3).

## Workbench Patch Plan (Phase 4)
No workbench patches expected. If required for Action view layout or accessibility, record in `extensions/quantlab/docs/PATCHES_PHASE_4.md` with file paths and rationale.

## Implementation Plan

### 1. Phase 4 file layout and build pipeline
Extend the Quantlab extension under `extensions/quantlab` with Action view code and webview assets.

```
extensions/quantlab/
  package.json
  src/
    extension.ts
    types/
      action.ts
      engine.ts
      history.ts
      strategy.ts
    core/
      engine/
        EngineHost.ts
        JobQueue.ts
        JobRunner.ts
      state/
        HistoryState.ts
    views/
      action/
        ActionViewProvider.ts
        ActionWebview.ts
        ActionStateMachine.ts
        QuickActions.ts
        ResultsExporter.ts
    panels/
      resources/ResourcesTreeProvider.ts
      history/HistoryTreeProvider.ts
    views/chart/ChartViewProvider.ts
  webview/
    action/
      index.ts
      action.ts
      action.css
      states/
        selection.ts
        configuration.ts
        running.ts
        results.ts
      components/
        quickActionCard.ts
        configForm.ts
        progressBar.ts
        liveLog.ts
        metricsCard.ts
  dist/
    webview/
      action.js
  docs/
    PATCHES_PHASE_4.md (if needed)
```

Build pipeline:
- Add a webview bundler entry for Action view (webpack or esbuild) to output `dist/webview/action.js`.
- Keep extension host bundle separate from webview bundle.
- Reuse shared webview utilities (theme, message bridge) if present from Phase 3.

### 2. Extension registrations and contributions
Update `extensions/quantlab/package.json`:
- `contributes.customEditors`:
  - viewType: `quantlab.actionView`
  - selector: `*.py`
  - priority: `option`
- Commands (new or expanded):
  - `quantlab.action.open`
  - `quantlab.action.run`
  - `quantlab.action.cancel`
  - `quantlab.action.viewInChart`
  - `quantlab.action.exportResults`
  - `quantlab.action.pinRun`
  - `quantlab.action.addToCompare`
  - `quantlab.action.openRun` (open results by runId)
- Menus:
  - Context menu entries on History items for open in Action view.
  - Optional command palette entries for Action view actions.
- Keybindings:
  - No new bindings required beyond existing `Ctrl+Q A` (Phase 1).

### 3. Types and contracts
Create `extensions/quantlab/src/types/action.ts` with Action state and schema types.
- `ActionStateType`: `selection | configuration | running | results`.
- `ActionState` union with state-specific payloads.
- `ConfigSchema`, `ConfigSection`, `ConfigField` for dynamic forms.
- `MetricValue`, `ResultDetail`, `LogEntry`, `ValidationResult`.

Create `extensions/quantlab/src/types/engine.ts`:
- `JobRequest`, `JobProgressEvent`, `JobCompleteEvent`, `JobFailedEvent`.
- Include `artifactPath` in completion payload.

### 4. Webview message protocol
Define a strict message protocol used between extension and webview.

Extension -> Webview:
```typescript
{ type: 'init', strategy: StrategyInfo, recentRuns: HistoryEntry[] }
{ type: 'setState', state: ActionState }
{ type: 'progress', jobId: string, progress: number, message: string, eta?: string }
{ type: 'log', jobId: string, timestamp: string, message: string, level?: 'info' | 'warn' | 'error' }
{ type: 'complete', jobId: string, result: JobResult }
{ type: 'failed', jobId: string, error: string, stack?: string }
```

Webview -> Extension:
```typescript
{ type: 'ready' }
{ type: 'quickAction', action: 'backtest' | 'optimize' | 'monteCarlo' | 'wfa' }
{ type: 'selectResource', resourceId: string }
{ type: 'selectRun', runId: string }
{ type: 'runAction', actionType: string, config: ActionConfig }
{ type: 'updateConfig', values: Record<string, any> }
{ type: 'cancelJob', jobId: string }
{ type: 'viewInChart', runId: string }
{ type: 'exportResults', runId: string, format: 'json' | 'csv' | 'html' }
{ type: 'pinRun', runId: string }
{ type: 'addToCompare', runId: string }
{ type: 'back' }
{ type: 'rerun', runId: string }
```

### 5. Action state machine
Implement `ActionStateMachine` (extension host):
- Keep current state, history stack, and onStateChange event.
- Transition helpers: `toSelection`, `toConfiguration`, `toRunning`, `toResults`.
- Validation of configuration on each update (required, min/max).
- Back behavior:
  - From configuration -> selection.
  - From running -> selection while job continues (run stays in History).
  - From results -> selection.
- Persist minimal state in TabViewState: `lastActionStateType`, `lastRunId`, `lastConfig`.
- Scope state per tabInstanceId; track `activeJobId` to filter engine events.
- On restore, validate `lastRunId` exists in History; fallback to Selection if missing.
- Avoid redundant state broadcasts when the state payload is unchanged.

### 6. ActionViewProvider and lifecycle
Implement `ActionViewProvider` as a CustomTextEditorProvider:
- Resolve webview for the active document and tab instance ID.
- Load HTML from `ActionWebview.getHtml()` with local resource roots.
- Wait for webview `ready` event before sending state.
- Maintain a per-tab webview registry and message queue until ready.
- Seed state:
  - If runId is passed (History selection), open Results or Running.
  - Otherwise start in Selection with recent runs.
- Subscribe to:
  - HistoryState updates (refresh recent list, update results if active run).
  - EngineHost progress/log/complete/failed events.
  - GlobalState changes (update defaults in config as needed).
- Auto-expand Resources panel on entering Action view.
- Route engine events by jobId + strategyPath; ignore mismatches to avoid cross-tab leakage.
- Dispose cleanly: remove listeners, clear timers, and drop queued messages.
- On re-open, rehydrate running or last results state from History by runId.
- Validate incoming webview messages against a strict allowlist of types.
- Use CSP with nonce for webview scripts and avoid inline event handlers.

### 7. Selection state
Implement `webview/action/states/selection.ts`:
- Quick Actions grid with 4 cards (Backtest, Optimize, Monte Carlo, WFA).
- Text hint: quick actions use global symbol/timeframe; resources panel for advanced config.
- Recent list for this strategy (filter HistoryState by strategy path).
- Actions:
  - Quick action click -> immediate run with default config.
  - Recent view -> open results state.
  - Recent re-run -> run with stored config.
- Failed run shows "View Logs" and opens Results with error details.
- If strategy validation fails, disable Quick Actions and show the Phase 1 toast on attempt.

### 8. Quick Actions defaults
Implement `QuickActions.ts`:
- Define default config + schema for each action.
- Resolve `symbol` and `timeframe` from GlobalState when set to `global`.
- Defaults (per spec):
  - Backtest: global symbol/timeframe, dateRange max, code defaults.
  - Optimize: grid search, metric sharpe, use ql.param ranges.
  - Monte Carlo: 1000 simulations, shuffle trades, 95 percent CI.
  - WFA: 5 splits, 70/30 train/test, metric sharpe.

### 9. Configuration state (schema-driven form)
Implement `webview/action/states/configuration.ts` with a dynamic form builder.
- Sections:
  - Configuration (action-specific fields)
  - Data (symbol, timeframe, date range, data source, pin revision)
  - Strategy Parameters (code defaults, chart overrides, run-specific)
- Compose schema by merging action-specific fields with shared Data and Parameters sections.
- Data source list comes from settings or Data panel connections; default to last-used source.
- Normalize values on submit (dates to ISO, numbers to numeric, enums to string).
- Resolve `dateRange: max` in the engine and persist the resolved range in History for reproducibility.
- Parameter source handling:
  - Code defaults: use ParameterExtractor defaults.
  - Chart overrides: copy from Chart view state for the same document, preferring the most recent chart overrides; if none, fall back to code defaults.
  - Run-specific: render input controls for each parameter without mutating Chart state.
  - Partial extraction: fall back to code defaults for missing params and record a warning in run metadata.
- Validation:
  - Required fields and number ranges.
  - Clamp invalid numeric ranges before submission and surface inline errors.
  - Disable Run when invalid and show inline error text.
- Back button returns to Selection.
- Run button sends `runAction` message with validated config.

### 10. Running state
Implement `webview/action/states/running.ts`:
- Status line with jobId, progress bar, ETA, and elapsed time.
- Live log with expand/collapse and auto-scroll.
- Cancel button triggers `cancelJob`.
- Back button returns to Selection without cancelling job.
- Throttle UI updates to avoid log churn and keep progress monotonic (clamp 0-100).
- Keep log rendering incremental (append only) and cap at last N lines.

### 11. Results state
Implement `webview/action/states/results.ts`:
- Status card (passed/failed), run metadata (id, duration, completion).
- Summary metrics grid with optional visual bars.
- Details section with tables or text blocks.
- Warnings list.
- Actions:
  - View in Chart
  - Export Results
  - Pin Run
  - Compare
  - Re-run
  - New Analysis
- Disable or warn on actions that require artifacts when artifactPath is missing.

### 12. Engine communication
Implement `EngineHost` and job execution pipeline:
- Start engine process or mock runner (Phase 4 can use a stub engine for tests).
- NDJSON message protocol with event routing:
  - `progress`, `log`, `complete`, `failed`.
- `runJob` and `cancelJob` support.
- `JobQueue` tracks active jobs and dedupes duplicate job IDs.
- Surface errors to Action view and HistoryState.
- Guard against unknown job events and ignore events after job completion.
- On engine startup failure, transition to Results with error details and update History.
- Provide a lightweight backoff restart path when the engine exits unexpectedly.

### 12.1 Run IDs and artifact storage (backend only)
- Run ID format is stable and human-readable (example: `backtest-20260119-00042`).
- Artifact root uses extension storage: `context.globalStorageUri/quantlab/runs/<workspaceId>/`.
- Each run folder stores results and references:
  - `result.json` (metrics, warnings, details summary)
  - `signals.json`, `equity.json` (if produced)
  - `config.json` (resolved config and parameter source)
  - `log.txt` (optional, if engine provides)
- Update History entry only after artifact writes complete.

### 13. History integration
Wire Action view to HistoryState:
- On run start: create HistoryEntry with status `running` and config.
- On progress: update progress and progressMessage.
- On log: optionally store last N lines for debugging (bounded).
- On completion: update status, metrics, warnings, artifactPath, completedAt.
- On failure: update status, errorMessage, stack, completedAt.
- On cancel: update status `cancelled`.
- On open results: call `HistoryState.markAsViewed(runId)`.
- Selection state uses `HistoryState.query({ strategyPath, limit: 5 })` to build recents efficiently.
- Include `strategyHash`, `parameterSource`, and `configHash` for reproducibility.
- Enforce monotonic status updates (do not regress from completed to running).
- History dropdown and panel selections call `quantlab.action.openRun` to open results.

### 14. Resources integration
Connect Resources panel to Action view:
- Add event emitter in `ResourcesTreeProvider` for double-click selection.
- ActionViewProvider listens and opens configuration for that resource.
- Ensure Resources panel auto-expands when Action view is entered.
- Cache `resourcesCatalog.json` in memory and resolve resource schema by ID.

### 15. View in Chart flow
Implement Action -> Chart artifact loading:
- Load artifactPath from HistoryState for runId.
- Switch to Chart view for the same document using ViewManager.
- Call `ChartViewProvider.loadRunArtifacts` with signals/equity curve and banner text.
- Show error if artifacts missing or path invalid.
- Cache recently loaded artifacts per runId to avoid repeat disk reads.

### 16. Export and compare
Implement `ResultsExporter.ts`:
- Export JSON: full result object and config.
- Export CSV: summary metrics and key details.
- Export HTML: basic report layout with metrics and tables.
- Use `vscode.window.showSaveDialog` for output location.
- Stream large exports to disk to avoid loading full payloads into memory.

Compare (MVP):
- `addToCompare` stores runId in HistoryState compare list.
- If 2+ runs selected, open a minimal compare view (table of metrics).
- Defer rich compare charts to Phase 6.

### 17. Drag-and-drop support
Support run drag to Action view (Phase 2 expectation):
- Accept `application/quantlab-run` payload in webview.
- On drop, call `selectRun` to open results or running state.
- Validate runId exists in History before switching state; show error if missing.

### 18. Error handling and notifications
- Job failed -> Results state with error details and retry action.
- Data unavailable -> inline error in Configuration state.
- Use VS Code toast notifications for job completion/failure (Phase 6 notification system later).
- If engine is not running, show error and offer retry (restart engine).
- If a running job disappears (engine restart), mark as failed with "Engine restarted".

### 19. Accessibility and reduced motion
- Provide ARIA labels for icon-only buttons.
- Ensure keyboard navigation order is logical.
- Respect `prefers-reduced-motion` by disabling progress animations and collapse transitions.

### 20. File checklist
Core:
- [ ] `extensions/quantlab/src/types/action.ts`
- [ ] `extensions/quantlab/src/types/engine.ts`
- [ ] `extensions/quantlab/src/views/action/ActionStateMachine.ts`
- [ ] `extensions/quantlab/src/views/action/QuickActions.ts`
- [ ] `extensions/quantlab/src/views/action/ActionViewProvider.ts`
- [ ] `extensions/quantlab/src/views/action/ActionWebview.ts`
- [ ] `extensions/quantlab/src/views/action/ResultsExporter.ts`

Engine:
- [ ] `extensions/quantlab/src/core/engine/EngineHost.ts`
- [ ] `extensions/quantlab/src/core/engine/JobQueue.ts`
- [ ] `extensions/quantlab/src/core/engine/JobRunner.ts`

Webview:
- [ ] `extensions/quantlab/webview/action/index.ts`
- [ ] `extensions/quantlab/webview/action/action.ts`
- [ ] `extensions/quantlab/webview/action/action.css`
- [ ] `extensions/quantlab/webview/action/states/selection.ts`
- [ ] `extensions/quantlab/webview/action/states/configuration.ts`
- [ ] `extensions/quantlab/webview/action/states/running.ts`
- [ ] `extensions/quantlab/webview/action/states/results.ts`
- [ ] `extensions/quantlab/webview/action/components/quickActionCard.ts`
- [ ] `extensions/quantlab/webview/action/components/configForm.ts`
- [ ] `extensions/quantlab/webview/action/components/progressBar.ts`
- [ ] `extensions/quantlab/webview/action/components/liveLog.ts`
- [ ] `extensions/quantlab/webview/action/components/metricsCard.ts`

Integrations:
- [ ] `extensions/quantlab/src/panels/resources/ResourcesTreeProvider.ts` (emit selection)
- [ ] `extensions/quantlab/src/panels/history/HistoryTreeProvider.ts` (compare selection)
- [ ] `extensions/quantlab/src/views/chart/ChartViewProvider.ts` (loadRunArtifacts hook)

Packaging:
- [ ] `extensions/quantlab/package.json` (custom editor, commands)
- [ ] `extensions/quantlab/webpack.webview.js` or esbuild config (Action webview)

## Testing and Verification

### Unit tests
- ActionStateMachine transitions and validation.
- QuickActions resolve global symbol/timeframe and defaults.
- ResultsExporter format correctness.
- HistoryState updates on run lifecycle.
- Configuration parameter source resolution (code vs chart vs run-specific).
- EngineHost NDJSON parsing with chunked input.

### Integration tests
- Quick action backtest runs end-to-end and shows Results state.
- Resource selection opens configuration with correct schema.
- View in Chart loads artifacts and shows banner.
- Run recorded in History with correct status and metrics.
- Cancel job updates History and returns to Selection.
- Running job updates only the matching Action tab (no cross-tab leakage).

### Manual verification checklist
- Action view shows four quick action cards and recent list.
- Quick action run uses global symbol/timeframe and transitions to Running.
- Configuration form validates required fields and disables Run when invalid.
- Running state updates progress and logs; cancel works.
- Results state shows metrics, warnings, and action buttons.
- View in Chart loads signals/equity overlays.
- Export results writes a file to disk.
- Compare adds runs to History compare list.
- Resources panel auto-expands on Action view entry.

## Exit Gates
- Action view four-state machine works end-to-end.
- Quick Actions execute with correct defaults.
- Configuration state supports parameter source selection and validation.
- Running state shows progress, ETA, and live logs.
- Results state shows metrics, warnings, and actions.
- History entries are created, updated, and viewable.
- Resources panel selection opens Action configuration.
- View in Chart flow loads artifacts and shows banner.
- Unit and integration tests pass.
- No cross-tab event leakage (job events update only the owning Action tab).

## Performance Targets
- Action view initial render under 200ms.
- State transitions under 50ms P95.
- Progress update render under 16ms P95.
- Log append and auto-scroll under 10ms P95.

## Appendix: Action View Error States (V8.1)
- Job failed: show error details and retry action.
- Configuration invalid: inline validation errors and disabled Run button.
- Data unavailable: clear message and prompt to adjust date range or data source.
