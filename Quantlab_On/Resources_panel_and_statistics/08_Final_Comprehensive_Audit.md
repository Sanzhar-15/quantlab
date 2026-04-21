# Final Comprehensive Audit Report

**Audit Date:** 2026-02-04
**Status:** ADDITIONAL ISSUES FOUND - Plan needs corrections before implementation prompts

---

## Executive Summary

The corrected plan (v2) fixed the major flow issues but still contains **12 technical inaccuracies** when compared against the actual codebase. These must be fixed before creating implementation prompts.

---

## CATEGORY A: Path & Structure Errors

### A1. Wrong Webview Source Path

**Plan says:**
```
src/panels/resources/webview/resources.ts
src/views/stats/webview/stats.ts
```

**Actual codebase pattern:**
```
webview/chart/index.ts
webview/action/index.ts
webview/trade/index.ts
```

Webviews are at **extension root `/webview/`**, not under `/src/`.

**Correction:**
```
webview/resources/index.ts       (NEW)
webview/stats/index.ts           (NEW)
webview/visualise/index.ts       (NEW)
```

---

### A2. Esbuild Config Already Exists

**Plan says:** Create `esbuild.webview.js`

**Reality:** `esbuild-webview.mjs` already exists with this structure:
```javascript
run({
    entryPoints: {
        'chart': path.join(chartDir, 'index.ts'),
        'action': path.join(actionDir, 'index.ts'),
        'trade': path.join(tradeDir, 'index.ts')
    },
    // ...
});
```

**Correction:** ADD entries to existing file:
```javascript
// Add to esbuild-webview.mjs
const resourcesDir = path.join(srcDir, 'resources');
const statsDir = path.join(srcDir, 'stats');
const visualiseDir = path.join(srcDir, 'visualise');

run({
    entryPoints: {
        // existing...
        'resources': path.join(resourcesDir, 'index.ts'),
        'resources-style': path.join(resourcesDir, 'resources.css'),
        'stats': path.join(statsDir, 'index.ts'),
        'stats-style': path.join(statsDir, 'stats.css'),
        'visualise': path.join(visualiseDir, 'index.ts'),
        'visualise-style': path.join(visualiseDir, 'visualise.css')
    },
    // ...
});
```

---

## CATEGORY B: Registration & Pattern Errors

### B1. Resources Panel Registration Pattern Wrong

**Current implementation:**
```typescript
// ResourcesPanelProvider.ts - wraps TreeDataProvider
export class ResourcesPanelProvider {
    private readonly treeView: vscode.TreeView<unknown>;
    constructor(context: vscode.ExtensionContext) {
        const provider = new ResourcesTreeProvider(context.extensionUri);
        this.treeView = vscode.window.createTreeView('quantlab.resourcesView', { treeDataProvider: provider });
    }
}
```

**Package.json registration:**
```json
"views": {
    "quantlab-resources": [
        {
            "id": "quantlab.resourcesView",
            "name": "%view.resources.title%"
        }
    ]
}
```

**To change to WebviewView:**

1. Update package.json:
```json
"views": {
    "quantlab-resources": [
        {
            "type": "webview",
            "id": "quantlab.resourcesView",
            "name": "%view.resources.title%"
        }
    ]
}
```

2. Change provider to implement `WebviewViewProvider`:
```typescript
export class ResourcesPanelProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(webviewView: vscode.WebviewView, ...): void { ... }
}
```

3. Register in extension.ts:
```typescript
context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
        'quantlab.resourcesView',
        resourcesProvider
    )
);
```

---

### B2. Custom Editor Registration Missing Data File Patterns

**Current package.json:**
```json
"customEditors": [
    {
        "viewType": "quantlab.chartView",
        "selector": [{ "filenamePattern": "*.py" }],
        "priority": "option"
    }
]
```

**Need to add for data files:**
```json
"customEditors": [
    // ... existing ...
    {
        "viewType": "quantlab.visualiseView",
        "displayName": "Visualise",
        "selector": [
            { "filenamePattern": "*.csv" },
            { "filenamePattern": "*.parquet" },
            { "filenamePattern": "*.xlsx" }
        ],
        "priority": "option"
    },
    {
        "viewType": "quantlab.statsView",
        "displayName": "Stats",
        "selector": [
            { "filenamePattern": "*.csv" },
            { "filenamePattern": "*.parquet" },
            { "filenamePattern": "*.xlsx" }
        ],
        "priority": "option"
    }
]
```

---

## CATEGORY C: Type System Errors

### C1. JobRequest Type Incompatible with Stats

**Current JobRequest:**
```typescript
export interface JobRequest {
    jobId: string;
    action: QuickActionType | string;
    strategyPath: string;        // ← Required! Not applicable for stats
    strategyHash: string;        // ← Required! Not applicable for stats
    config: ActionConfig;
    createdAt: string;
}
```

**Problem:** Stats tests don't have a strategy.

**Solution Options:**

Option A: Create separate `StatsJobRequest`:
```typescript
export interface StatsJobRequest {
    jobId: string;
    action: 'stats';
    testId: string;
    dataPath: string;
    columns: string[];
    parameters: Record<string, unknown>;
    createdAt: string;
}
```

Option B: Make strategy fields optional (worse - pollutes existing type).

**Recommendation:** Option A - new type.

---

### C2. EngineEvent Types Need Stats Support

**Current events:**
```typescript
export type EngineEvent = JobProgressEvent | JobLogEvent | JobCompleteEvent | JobFailedEvent;
```

**Need to add stats-specific result handling:**
```typescript
export interface StatsCompleteEvent {
    type: 'complete';
    jobId: string;
    result: StatsJobResult;  // Different from JobResult
}

export interface StatsJobResult {
    testId: string;
    testName: string;
    statistic: number;
    pValue: number;
    criticalValues?: Record<string, number>;
    conclusion: string;
    details: Record<string, unknown>;
    visualizations?: StatsVisualization[];
}
```

---

### C3. contextKeys.ts Needs Data File Support

**Current:**
```typescript
export function updateContextKeys(view: ViewType, validation?: StrategyValidationResult | null): void {
    const isStrategy = Boolean(validation?.entrypoint);
    // ...
    void vscode.commands.executeCommand('setContext', 'quantlab.isStrategy', isStrategy);
}
```

**Need to add:**
```typescript
export function updateDataContextKeys(view: ViewType, dataFileType?: string | null): void {
    const isDataFile = Boolean(dataFileType);
    void vscode.commands.executeCommand('setContext', 'quantlab.currentView', view);
    void vscode.commands.executeCommand('setContext', 'quantlab.isDataFile', isDataFile);
    void vscode.commands.executeCommand('setContext', 'quantlab.dataFileType', dataFileType ?? null);
}
```

---

## CATEGORY D: Data Service Gaps

### D1. DataService Only Handles OHLCV

**Current DataService methods:**
```typescript
async getOHLCVFromFile(filePath: string, ...): Promise<MarketDataResult>
private async loadCsvFile(filePath: string): Promise<OhlcvBar[]>
private async loadParquetFile(filePath: string): Promise<OhlcvBar[]>
```

**Problem:** Stats need arbitrary columns, not just OHLCV.

**Need new service or extended methods:**
```typescript
// New: GenericDataService or extend DataService
interface DataFrameResult {
    columns: ColumnInfo[];
    data: Record<string, unknown[]>;  // Column name → values
    rowCount: number;
}

interface ColumnInfo {
    name: string;
    dtype: 'float64' | 'int64' | 'datetime64' | 'object' | 'bool';
    nullCount: number;
    uniqueCount: number;
}

async loadDataFrame(filePath: string): Promise<DataFrameResult>
async getColumnMetadata(filePath: string): Promise<ColumnInfo[]>
```

---

### D2. No XLSX Support in DataService

**Current:** Only CSV and Parquet.

**Need to add:**
```typescript
private async loadXlsxFile(filePath: string, sheetName?: string): Promise<DataFrameResult> {
    const XLSX = await import('xlsx');
    const workbook = XLSX.readFile(filePath);
    // ...
}
```

**Dependency:** Add `xlsx` to package.json dependencies.

---

## CATEGORY E: Visualization Gaps

### E1. No Plotly Integration

**Current:** Uses `@charts-plus` (Lightweight Charts) for candlestick charts.

**Plotly requires:**
1. Add `plotly.js-dist-min` to dependencies
2. Bundle in webview build
3. Create shared Plotly utilities

**esbuild config needs external handling for large Plotly bundle:**
```javascript
// May need to load Plotly from CDN or as separate chunk
```

---

## CATEGORY F: Missing Files from Plan

### F1. Files Not Mentioned in Plan

These existing files need modification but aren't listed:

| File | Required Change |
|------|-----------------|
| `types/views.ts` | Add `'visualise' | 'stats'` to `ViewType` |
| `types/engine.ts` | Add `StatsJobRequest`, `StatsJobResult` |
| `esbuild-webview.mjs` | Add new entry points |
| `src/commands/viewCommands.ts` | Add data view commands |
| `src/commands/panelCommands.ts` | Add `setResourcesSection` command |

---

## CATEGORY G: Logic Gaps

### G1. StatsViewProvider.getInstance() Race Condition

**Plan code:**
```typescript
async openStatsTest(testId: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.statsView');
    const statsProvider = StatsViewProvider.getInstance();
    statsProvider.configureTest(resource, testId);  // ← May not exist yet!
}
```

**Problem:** Custom editor may not be initialized when `configureTest` is called.

**Solution:** Use message passing pattern like existing ActionViewProvider:
```typescript
// In DataViewManager
async openStatsTest(testId: string): Promise<void> {
    // Store pending test to configure
    this.pendingTestByUri.set(resource.toString(), testId);
    await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.statsView');
}

// In StatsViewProvider.resolveCustomTextEditor()
const pendingTest = DataViewManager.getInstance().consumePendingTest(document.uri);
if (pendingTest) {
    this.configureTest(document.uri, pendingTest);
}
```

---

### G2. lastActiveDataFile Persistence

**Problem:** `lastActiveDataFile` is only in memory. If user closes and reopens VS Code, it's lost.

**Solution:** Not critical for MVP, but should consider persisting to `globalState`.

---

## SUMMARY OF REQUIRED CORRECTIONS

### Must Fix (Blocking)

| # | Issue | Fix |
|---|-------|-----|
| A1 | Wrong webview path | Use `webview/` at extension root |
| A2 | Esbuild config | Modify existing `esbuild-webview.mjs` |
| B1 | Resources panel pattern | Use `WebviewViewProvider` + package.json update |
| B2 | Custom editor registration | Add data file patterns |
| C1 | JobRequest type | Create `StatsJobRequest` |
| D1 | DataService columns | Add `loadDataFrame()` method |
| G1 | getInstance race | Use pending message pattern |

### Should Fix (Important)

| # | Issue | Fix |
|---|-------|-----|
| C2 | EngineEvent types | Add stats event types |
| C3 | contextKeys | Add `updateDataContextKeys` |
| D2 | XLSX support | Add xlsx library |
| E1 | Plotly | Add dependency and config |
| F1 | Missing file list | Update file inventory |

### Nice to Have

| # | Issue | Fix |
|---|-------|-----|
| G2 | lastActiveDataFile persistence | Use globalState |

---

## VERDICT

**The plan is NOT ready for implementation prompts.**

Required actions before proceeding:

1. Update all file paths to match actual codebase structure
2. Correct esbuild configuration approach
3. Add proper package.json registration for webview panel
4. Define proper type system for stats jobs
5. Define DataService extensions for column metadata
6. Document the pending message pattern for view initialization

**Estimated additional planning effort:** 1-2 hours to update the corrected master plan with these fixes.

---

## Shall I proceed with creating an updated plan that addresses all these issues?
