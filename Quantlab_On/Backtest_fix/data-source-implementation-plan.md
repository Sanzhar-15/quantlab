# Data Source Dropdown Implementation Plan

## Summary

Replace the hardcoded AAPL/1D buttons in the chrome titlebar and the symbol-centric data model with a **file-based data source** system. Users select local CSV/Parquet files via a dropdown in the chart toolbar and action view. The chart stays empty until a valid file is chosen. This fixes the backtest failure ("No data file found for symbol 'AAPL'") by ensuring a real data file is always explicitly selected.

---

## Architecture Change

**Before**: `GlobalState { symbol: 'AAPL', timeframe: '1D' }` → DataService generates mock data → chart shows fake data → backtest fails looking for AAPL files.

**After**: `GlobalState { dataSource: undefined }` → user selects a file → DataService loads that file → chart shows real data → backtest uses the same file path.

**File picker approach**: Use VS Code's native `showOpenDialog` (triggered from webview via postMessage). The webview dropdown only shows previously-selected files plus a "Browse Local Files..." option. This avoids building a custom file browser in the webview (which can't access the filesystem).

---

## Phase 1: Type Definitions

### 1.1 `extensions/quantlab/src/types/market.ts`
- Add `LocalFileDataSource` interface: `{ kind: 'localFile'; filePath: string; displayName: string }`
- Add `DataSourceDescriptor` type alias (= `LocalFileDataSource` for now, extensible later)
- Update `GlobalMarketState`: remove `symbol: string`, add `dataSource?: DataSourceDescriptor`, make `timeframe` optional

### 1.2 `extensions/quantlab/src/types/chart.ts`
- `ChartToolbarState`: replace `symbol: string` with `dataSource?: DataSourceDescriptor`, add `recentSources?: DataSourceDescriptor[]`, make `timeframe` optional
- Add inbound messages: `'requestFilePicker'`, `'selectDataSource' { filePath: string }`
- Remove inbound message: `'overrideSymbol'`
- Add outbound message: `'setRecentSources' { sources: DataSourceDescriptor[] }`
- Update error action: replace `'changeSymbol'` with `'selectData'`

### 1.3 `extensions/quantlab/src/types/action.ts`
- Add `'file'` to `ConfigField.type` union
- Add optional `fileFilter?: string[]` to `ConfigField`

---

## Phase 2: Global State & Persistence

### 2.1 `extensions/quantlab/src/core/state/GlobalState.ts`
- Change default: `{ dataSource: undefined, timeframe: undefined }` (no more AAPL/1D)
- Remove: `getSymbol()`, `setSymbol()`, `normalizeSymbol()`, `_onDidChangeSymbol`
- Add: `getDataSource()`, `setDataSource()`, `_onDidChangeDataSource`
- Add: `getRecentDataSources()`, `addRecentDataSource()` (persisted to `'quantlab.recentDataSources'` in workspaceState, max 10)
- `getTimeframe()` / `setTimeframe()` remain but timeframe is now optional

### 2.2 `extensions/quantlab/src/ui/GlobalSelectors.ts`
- Remove: `selectSymbol()`, `selectTimeframe()`, `symbolItem`, `timeframeItem` status bar items
- Add: `selectDataSource()` method:
  1. Show QuickPick with recent sources + "Browse Local Files..."
  2. If browse: call `vscode.window.showOpenDialog({ filters: { 'Data Files': ['csv', 'parquet'] } })`
  3. Set selected source via `globalState.setDataSource()`
- `updateTitlebar()`: only send `{ historyCount }` (no symbol/timeframe)
- `updateUI()`: no symbol/timeframe status bar items needed

### 2.3 `extensions/quantlab/src/commands/globalStateCommands.ts`
- Replace `quantlab.selectSymbol` with `quantlab.selectDataSource`
- Remove `quantlab.selectTimeframe`
- Replace `quantlab.setGlobalSymbol` with `quantlab.setGlobalDataSource`
- Keep `quantlab.searchSymbol` as alias for `quantlab.selectDataSource`

---

## Phase 3: Data Service

### 3.1 `extensions/quantlab/src/core/engine/DataService.ts`
- Add: `getOHLCVFromFile(filePath: string, range?: ChartDateRange): Promise<MarketDataResult>`
  - Validates file exists (`fs.existsSync`)
  - Routes to `loadCsvFile()` or `loadParquetFile()` based on extension
  - Infers timeframe from data timestamps via `inferTimeframe()`
  - Caches by file path + mtime
- Add: `loadCsvFile(filePath: string)` — generalizes existing `loadBtcCsv()` to accept any path
- Add: `loadParquetFile(filePath: string)` — MVP: throw "convert to CSV" error; future: delegate to Python
- Add: `inferTimeframe(data: OhlcvBar[]): Timeframe` — median interval between first ~50 bars, mapped to nearest standard timeframe
- Deprecate: `getOHLCV(symbol, timeframe)` — keep for backward compat but log warning
- Remove: `resolveBtcCsvPath()`, `isBtcSymbol()`, `loadBtcCsv()` (replaced by generic file loading)

---

## Phase 4: Chart View (Extension Host)

### 4.1 `extensions/quantlab/src/views/chart/ChartViewProvider.ts`

**Constructor**: Replace `onDidChangeSymbol` listener with `onDidChangeDataSource`

**`buildToolbarState()`**:
- Get `dataSource` from tab-level chart state or `globalState.getDataSource()` fallback
- Get `recentSources` from `globalState.getRecentDataSources()`
- `timeframe` from tab state or `globalState.getTimeframe()` (may be undefined)

**`reloadData()`**:
- If `!toolbar.dataSource`: send `showError` with message "No data source selected" and action `'selectData'`; return (no chart render)
- Call `dataService.getOHLCVFromFile(toolbar.dataSource.filePath, toolbar.dateRange)`
- Update tab state with `meta.effectiveTimeframe` from inferred timeframe
- On file-not-found error: show descriptive error with `'selectData'` action

**`onMessage()`**:
- Add `'requestFilePicker'` handler: opens `showOpenDialog`, sets `globalState.setDataSource()`, updates tab chart state, refreshes toolbar + reloads data
- Add `'selectDataSource'` handler: sets data source from `filePath` in payload, refreshes
- Remove `'overrideSymbol'` handler
- Update `'dropSymbol'` to set data source if dropped data is a file path

**`initializeSession()`** / **`sendInit()`**:
- Send `{ type: 'setRecentSources', sources }` after init

**`refreshFromGlobal()`**:
- Replace `'symbol'` kind with `'dataSource'` kind, reacting to `onDidChangeDataSource`

---

## Phase 5: Chart Webview (UI)

### 5.1 `extensions/quantlab/webview/chart/index.ts`

**Remove**: `symbolButton`, `timeframeButton` creation and their event listeners

**Add**:
- `dataSourceContainer` (div, relative positioned)
- `dataSourceButton` (button, text "No Data", click toggles dropdown)
- `dataSourceDropdown` (div, absolutely positioned below button, hidden by default)
  - Contains recent source options (populated by `setRecentSources` message)
  - Contains separator + "Browse Local Files..." option (sends `requestFilePicker`)
- `timeframeLabel` (span, read-only display of inferred timeframe)
- Click-outside handler to close dropdown

**Update `leftGroup`**: `[dataSourceContainer, timeframeLabel, strategyButton, dateStart, dateEnd]`

**Update toolbar context** passed to `createMessageHandler`:
- Replace `symbolButton`, `timeframeButton` with `dataSourceButton`, `dataSourceDropdown`, `timeframeLabel`

### 5.2 `extensions/quantlab/webview/chart/messageHandler.ts`

**Update `MessageHandlerContext.toolbar`**:
- `dataSourceButton: HTMLButtonElement`
- `dataSourceDropdown: HTMLElement`
- `timeframeLabel: HTMLElement`
- (remove `symbolButton`, `timeframeButton`)

**Update `updateToolbar()`**:
- Set `dataSourceButton.textContent` to `toolbar.dataSource?.displayName ?? 'No Data'`
- Set `dataSourceButton.title` to full file path (tooltip)
- Set `timeframeLabel.textContent` to `toolbar.timeframe ?? ''`

**Add `'setRecentSources'` handler**:
- Clear existing dropdown options (keep browse button)
- For each source: create `.data-source-option` div with displayName + file-path subtitle
- Click sends `{ type: 'selectDataSource', filePath }`
- Re-append browse button at bottom with separator

**Update error actions**: replace `'changeSymbol'` → `'selectData'` button that sends `requestFilePicker`

### 5.3 `extensions/quantlab/webview/chart/chart.css`

Add styles for:
- `.data-source-container` — relative positioning
- `.data-source-button` — min-width 120px, text-overflow ellipsis, chevron indicator
- `.data-source-dropdown` — absolute positioned, z-index 100, dropdown-background, shadow, max-height with scroll
- `.data-source-option` — hover highlight, active selection, ellipsis overflow
- `.data-source-option.browse` — italic, top border separator
- `.data-source-option .file-path` — smaller font, muted color subtitle
- `.timeframe-label` — read-only appearance, muted text

---

## Phase 6: Titlebar Cleanup

### 6.1 `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`

- Reduce `IQuantlabTitlebarState` to `{ historyCount?: number }` only
- Remove member fields: `quantlabMarketContainer`, `quantlabSymbolButton`, `quantlabTimeframeButton`
- In `createQuantlabControls()`: remove creation of market container and symbol/timeframe buttons; keep history container + button
- Remove all drag-and-drop handlers on the symbol button
- In `updateQuantlabTitlebarState()`: remove symbol/timeframe text updates; keep history badge update
- Update default state: `{ historyCount: 0 }`

### 6.2 `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`

- Remove `.quantlab-market` rules
- Remove `.quantlab-drop-target` rules
- Keep `.quantlab-history`, `.quantlab-titlebar-button`, `.quantlab-history-badge` rules

---

## Phase 7: Action View / Backtest

### 7.1 `extensions/quantlab/src/views/action/QuickActions.ts`

**`buildSchema()`**: Replace data fields section:
- Remove: `symbol` (text), `timeframe` (select), `dataSource` (text)
- Add: `dataSource` (file type, required, filter: `['*.csv', '*.parquet']`)
- Keep: `dateStart`, `dateEnd`

**`buildDefaults()`**:
- Replace `symbol: globalState.getSymbol()` with `dataSource: globalState.getDataSource()?.filePath ?? ''`
- Remove `timeframe` default (inferred from file)
- Remove `dataSource: 'Default'`

### 7.2 `extensions/quantlab/src/views/action/ActionViewProvider.ts`

**`onMessage()`**: Add `'requestFilePicker'` handler (same pattern as chart: open dialog, send result back to webview, update global state)

**`runQuickAction()`** / **`runAction()`**: Validate `dataSource` is set before proceeding; show warning if empty

### 7.3 `extensions/quantlab/webview/action/states/configuration.ts`

**`renderField()`**: Add `case 'file'`:
- Render a button showing the current file name or "Select File..."
- Hidden input holding the file path value
- Click sends `{ type: 'requestFilePicker', fieldId: field.id }` to extension host

**Add message handler** for `'setFieldValue'` from extension host:
- Updates the hidden input and display button text
- Triggers form change event for validation

### 7.4 `extensions/quantlab/src/core/engine/JobRunner.ts`

**`buildStdinConfig()`**:
- `dataSource`: now sends the actual file path (`values.dataSource`)
- `symbol`: send empty string (file-based, no symbol needed)
- `timeframe`: send empty string (inferred from file in Python)

### 7.5 `engine/quantlab/cli/run_backtest.py`

**`run()`**: Update data resolution logic:
1. If `dataSource` is a valid file path → use it directly
2. Else if `symbol` is provided → fallback to `discover_data_file()` (backward compat)
3. Else → raise `FileNotFoundError("No data source specified...")`

---

## Phase 8: Cleanup & Integration

### 8.1 Remove dead code
- `extensions/quantlab/src/panels/data/DataPanelProvider.ts`: Update drag-and-drop MIME types (symbol drag becomes data-source drag)
- `extensions/quantlab/src/panels/data/DataTreeProvider.ts`: Update if needed for data source display
- Remove `RECENT_SYMBOLS_KEY` usage from `GlobalSelectors.ts`
- Remove `updateRecentSymbols()` from `GlobalSelectors.ts`

### 8.2 Extension activation (`extension.ts`)
- Replace `globalState.onDidChangeSymbol` subscriptions with `onDidChangeDataSource`
- Update command registrations to match new command names

---

## Files Modified (Complete List)

| # | File | Change |
|---|------|--------|
| 1 | `extensions/quantlab/src/types/market.ts` | Add DataSourceDescriptor, update GlobalMarketState |
| 2 | `extensions/quantlab/src/types/chart.ts` | Update ChartToolbarState, add/remove message types |
| 3 | `extensions/quantlab/src/types/action.ts` | Add 'file' field type |
| 4 | `extensions/quantlab/src/core/state/GlobalState.ts` | Replace symbol with dataSource, add recents |
| 5 | `extensions/quantlab/src/ui/GlobalSelectors.ts` | Replace symbol selector with data source selector |
| 6 | `extensions/quantlab/src/commands/globalStateCommands.ts` | Replace symbol commands with data source commands |
| 7 | `extensions/quantlab/src/core/engine/DataService.ts` | Add file-based loading, timeframe inference |
| 8 | `extensions/quantlab/src/views/chart/ChartViewProvider.ts` | Data source message handling, toolbar, reload logic |
| 9 | `extensions/quantlab/webview/chart/index.ts` | Replace symbol/TF buttons with data source dropdown |
| 10 | `extensions/quantlab/webview/chart/messageHandler.ts` | Update toolbar context, add setRecentSources handler |
| 11 | `extensions/quantlab/webview/chart/chart.css` | Data source dropdown styles |
| 12 | `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` | Remove AAPL/1D buttons, keep History |
| 13 | `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css` | Remove .quantlab-market styles |
| 14 | `extensions/quantlab/src/views/action/QuickActions.ts` | File-based data field, remove symbol/timeframe |
| 15 | `extensions/quantlab/src/views/action/ActionViewProvider.ts` | File picker message handling, validation |
| 16 | `extensions/quantlab/webview/action/states/configuration.ts` | Render 'file' field type |
| 17 | `extensions/quantlab/src/core/engine/JobRunner.ts` | Pass file path as dataSource |
| 18 | `engine/quantlab/cli/run_backtest.py` | Prioritize dataSource file path |
| 19 | `extensions/quantlab/src/extension.ts` | Update event subscriptions and commands |

---

## Verification

1. **Chart with no data**: Open a strategy file in chart view. Should show "No data source selected" message with "Select Data" button. No chart renders.
2. **File selection via chart**: Click "No Data" dropdown → "Browse Local Files..." → select a CSV → chart renders with data. Dropdown now shows the file name.
3. **Recent sources**: Close and reopen chart. Dropdown shows previously selected file. Click to reload.
4. **Backtest execution**: Open action view → click Backtest → configuration shows file picker field pre-populated from chart selection → run succeeds with the selected file.
5. **Titlebar**: AAPL and 1D buttons are gone. History button remains.
6. **Timeframe inference**: Select a 1-minute CSV → timeframe label shows "1m". Select a daily CSV → shows "1D".
7. **Error handling**: Select a file, delete it from disk, refresh chart → shows "Unable to load data from file" error with file path detail.
