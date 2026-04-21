# Resources Panel & Statistics System - Master Plan V3 (Final)

**Version:** 3.0 (Post-Comprehensive Audit)
**Status:** Ready for Implementation

---

## 1. User Flow (Unchanged from V2)

### Strategy Files (Existing)
```
1. Open strategy.py → RHS buttons: [Chart] [Action] [Trade]
2. Click [Action] → Opens ActionView + focuses Resources panel (Strategy section)
3. Click test in Resources → ActionView updates
```

### Data Files (New)
```
1. Open data.csv/xlsx/parquet → RHS buttons: [Visualise] [Action]
2. Click [Visualise] → Opens VisualiseView (custom editor)
3. Click [Action] → ONLY focuses Resources panel (Pure Stats section)
4. Click test in Resources → NOW Stats view opens with test config
5. Configure → Run → See results
```

---

## 2. Corrected Architecture

### 2.1 File Structure (CORRECTED)

```
extensions/quantlab/
├── src/
│   ├── types/
│   │   ├── data.ts                    # NEW: Data file types
│   │   ├── stats.ts                   # NEW: Stats types
│   │   ├── views.ts                   # MODIFY: Add visualise, stats
│   │   └── engine.ts                  # MODIFY: Add StatsJobRequest
│   │
│   ├── views/
│   │   ├── DataViewManager.ts         # NEW: Data view management
│   │   ├── stats/
│   │   │   ├── StatsViewProvider.ts   # NEW: Custom editor provider
│   │   │   └── StatsWebview.ts        # NEW: Webview communication
│   │   └── visualise/
│   │       ├── VisualiseViewProvider.ts  # NEW
│   │       └── VisualiseWebview.ts       # NEW
│   │
│   ├── panels/
│   │   └── resources/
│   │       ├── ResourcesPanelProvider.ts  # REWRITE: WebviewViewProvider
│   │       ├── ResourcesTreeProvider.ts   # KEEP: For strategy section
│   │       ├── StatsCatalog.ts            # NEW: Stats test catalog
│   │       └── statsCatalog.json          # NEW: Test definitions
│   │
│   ├── core/
│   │   └── engine/
│   │       ├── StatsEngine.ts         # NEW: Stats execution
│   │       └── DataService.ts         # MODIFY: Add loadDataFrame
│   │
│   ├── utils/
│   │   └── contextKeys.ts             # MODIFY: Add data file support
│   │
│   └── commands/
│       ├── viewCommands.ts            # MODIFY: Add data view commands
│       └── dataCommands.ts            # NEW: Stats commands
│
├── webview/                           # ← CORRECT LOCATION (not src/webview)
│   ├── resources/                     # NEW
│   │   ├── index.ts
│   │   └── resources.css
│   ├── stats/                         # NEW
│   │   ├── index.ts
│   │   ├── states/
│   │   │   ├── idle.ts
│   │   │   ├── configuration.ts
│   │   │   ├── running.ts
│   │   │   └── results.ts
│   │   └── stats.css
│   ├── visualise/                     # NEW
│   │   ├── index.ts
│   │   └── visualise.css
│   └── shared/
│       └── plotly.ts                  # NEW: Shared Plotly utils
│
├── python/
│   └── stats/                         # NEW
│       ├── __init__.py
│       ├── runner.py                  # Entry point
│       ├── descriptive.py
│       ├── stationarity.py
│       ├── distribution.py
│       ├── dependence.py
│       ├── volatility.py
│       ├── regression.py
│       └── risk.py
│
├── esbuild-webview.mjs                # MODIFY: Add new entries
└── package.json                       # MODIFY: Registration
```

---

### 2.2 Type Definitions (CORRECTED)

#### `types/data.ts` (NEW)
```typescript
export type DataFileType = 'csv' | 'parquet' | 'xlsx';

export interface DataFileInfo {
    path: string;
    type: DataFileType;
    columns: ColumnInfo[];
    rowCount: number;
    dateRange?: { start: Date; end: Date };
}

export interface ColumnInfo {
    name: string;
    dtype: 'float64' | 'int64' | 'datetime64' | 'object' | 'bool';
    nullCount: number;
    uniqueCount: number;
    min?: number;
    max?: number;
    sampleValues?: unknown[];
}

export interface DataFrameResult {
    columns: ColumnInfo[];
    data: Record<string, unknown[]>;
    rowCount: number;
}
```

#### `types/stats.ts` (NEW)
```typescript
export type StatsCategory =
    | 'descriptive'
    | 'stationarity'
    | 'distribution'
    | 'dependence'
    | 'volatility'
    | 'regression'
    | 'risk';

export interface StatsTestDefinition {
    id: string;
    label: string;
    description: string;
    category: StatsCategory;
    requiredColumns: {
        count: number | '1+' | '2+';
        types: Array<'float64' | 'int64'>;
    };
    parameters: StatsParameterDefinition[];
}

export interface StatsParameterDefinition {
    id: string;
    label: string;
    type: 'number' | 'select' | 'boolean';
    default: unknown;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
}

export interface StatsTestConfig {
    testId: string;
    dataPath: string;
    columns: string[];
    parameters: Record<string, unknown>;
}

export interface StatsTestResult {
    testId: string;
    testName: string;
    statistic: number;
    pValue: number;
    criticalValues?: Record<string, number>;
    conclusion: string;
    interpretation: string;
    details: Record<string, unknown>;
    visualizations?: StatsVisualization[];
}

export interface StatsVisualization {
    type: 'line' | 'bar' | 'scatter' | 'heatmap' | 'histogram';
    title: string;
    data: unknown;  // Plotly data format
    layout?: unknown;  // Plotly layout
}
```

#### `types/engine.ts` (MODIFY - Add)
```typescript
// Add to existing file

export interface StatsJobRequest {
    jobId: string;
    action: 'stats';
    testId: string;
    dataPath: string;
    columns: string[];
    parameters: Record<string, unknown>;
    createdAt: string;
}

export interface StatsJobResult {
    testId: string;
    testName: string;
    statistic: number;
    pValue: number;
    criticalValues?: Record<string, number>;
    conclusion: string;
    details: Record<string, unknown>;
    visualizations?: Array<{
        type: string;
        data: unknown;
        layout?: unknown;
    }>;
}

export interface StatsCompleteEvent {
    type: 'stats-complete';
    jobId: string;
    result: StatsJobResult;
}

// Update EngineEvent union
export type EngineEvent =
    | JobProgressEvent
    | JobLogEvent
    | JobCompleteEvent
    | JobFailedEvent
    | StatsCompleteEvent;  // ADD
```

#### `types/views.ts` (MODIFY)
```typescript
// Change from:
export type ViewType = 'editor' | 'chart' | 'action' | 'trade';

// To:
export type ViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

export type DataViewType = 'editor' | 'visualise' | 'stats';
```

---

### 2.3 Package.json Changes (CORRECTED)

```json
{
  "contributes": {
    "customEditors": [
      // ... existing chart, action, trade ...
      {
        "viewType": "quantlab.visualiseView",
        "displayName": "%view.visualiseEditor.title%",
        "selector": [
          { "filenamePattern": "*.csv" },
          { "filenamePattern": "*.parquet" },
          { "filenamePattern": "*.xlsx" }
        ],
        "priority": "option"
      },
      {
        "viewType": "quantlab.statsView",
        "displayName": "%view.statsEditor.title%",
        "selector": [
          { "filenamePattern": "*.csv" },
          { "filenamePattern": "*.parquet" },
          { "filenamePattern": "*.xlsx" }
        ],
        "priority": "option"
      }
    ],
    "views": {
      "quantlab-resources": [
        {
          "type": "webview",
          "id": "quantlab.resourcesView",
          "name": "%view.resources.title%"
        }
      ]
    },
    "commands": [
      {
        "command": "quantlab.switchToVisualise",
        "title": "%command.switchToVisualise%",
        "category": "QuantLab"
      },
      {
        "command": "quantlab.openDataAction",
        "title": "%command.openDataAction%",
        "category": "QuantLab"
      },
      {
        "command": "quantlab.stats.openTest",
        "title": "%command.stats.openTest%",
        "category": "QuantLab"
      },
      {
        "command": "quantlab.setResourcesSection",
        "title": "%command.setResourcesSection%",
        "category": "QuantLab"
      }
    ],
    "keybindings": [
      {
        "command": "quantlab.switchToVisualise",
        "key": "ctrl+q v",
        "when": "quantlab.isDataFile"
      },
      {
        "command": "quantlab.openDataAction",
        "key": "ctrl+q a",
        "when": "quantlab.isDataFile"
      }
    ]
  },
  "dependencies": {
    "xlsx": "^0.18.5"
  }
}
```

---

### 2.4 Esbuild Configuration (MODIFY existing file)

```javascript
// esbuild-webview.mjs - ADD these entries

const resourcesDir = path.join(srcDir, 'resources');
const statsDir = path.join(srcDir, 'stats');
const visualiseDir = path.join(srcDir, 'visualise');

run({
    entryPoints: {
        // Existing
        'chart': path.join(chartDir, 'index.ts'),
        'chart-style': path.join(chartDir, 'chart.css'),
        'action': path.join(actionDir, 'index.ts'),
        'action-style': path.join(actionDir, 'action.css'),
        'trade': path.join(tradeDir, 'index.ts'),
        'trade-style': path.join(tradeDir, 'trade.css'),

        // NEW
        'resources': path.join(resourcesDir, 'index.ts'),
        'resources-style': path.join(resourcesDir, 'resources.css'),
        'stats': path.join(statsDir, 'index.ts'),
        'stats-style': path.join(statsDir, 'stats.css'),
        'visualise': path.join(visualiseDir, 'index.ts'),
        'visualise-style': path.join(visualiseDir, 'visualise.css')
    },
    srcDir,
    outdir: outDir,
    additionalOptions: {
        plugins: [chartsAliasPlugin],
        external: ['plotly.js-dist-min']  // Load Plotly separately
    }
}, process.argv);
```

---

### 2.5 Context Keys (CORRECTED)

```typescript
// src/utils/contextKeys.ts - ADD

export function updateDataContextKeys(
    view: ViewType,
    dataFileType: DataFileType | null
): void {
    void vscode.commands.executeCommand('setContext', 'quantlab.currentView', view);
    void vscode.commands.executeCommand('setContext', 'quantlab.isDataFile', Boolean(dataFileType));
    void vscode.commands.executeCommand('setContext', 'quantlab.dataFileType', dataFileType);
    // Clear strategy flags when on data file
    void vscode.commands.executeCommand('setContext', 'quantlab.isStrategy', false);
}
```

---

### 2.6 DataViewManager (CORRECTED with pending pattern)

```typescript
// src/views/DataViewManager.ts

import * as vscode from 'vscode';
import * as path from 'path';
import { DataFileType, DataViewType } from '../types/data';
import { updateDataContextKeys } from '../utils/contextKeys';

export class DataViewManager {
    private static instance: DataViewManager;

    // Track active data file for stats test selection
    private lastActiveDataFile: vscode.Uri | undefined;

    // Pending test to open (solves race condition)
    private readonly pendingTestByUri = new Map<string, string>();

    private constructor() {}

    static getInstance(): DataViewManager {
        if (!DataViewManager.instance) {
            DataViewManager.instance = new DataViewManager();
        }
        return DataViewManager.instance;
    }

    /**
     * Switch to Visualise view
     */
    async switchToVisualise(resource: vscode.Uri): Promise<void> {
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.visualiseView');
        updateDataContextKeys('visualise', this.getDataFileType(resource));
    }

    /**
     * Open Data Action - focuses Resources panel, does NOT open Stats view
     */
    async openDataAction(resource: vscode.Uri): Promise<void> {
        this.lastActiveDataFile = resource;

        // Switch Resources to Pure Stats section
        await vscode.commands.executeCommand('quantlab.setResourcesSection', 'stats');

        // Focus Resources panel
        await vscode.commands.executeCommand('workbench.view.extension.quantlab-resources');
    }

    /**
     * Open a specific stats test - called when user clicks test in Resources
     */
    async openStatsTest(testId: string): Promise<void> {
        const resource = this.lastActiveDataFile ?? this.getActiveDataFileFromEditor();

        if (!resource) {
            void vscode.window.showWarningMessage(
                'No data file selected. Please open a data file first.'
            );
            return;
        }

        // Store pending test BEFORE opening editor (solves race condition)
        this.pendingTestByUri.set(resource.toString(), testId);

        // Open Stats view as custom editor
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.statsView');

        updateDataContextKeys('stats', this.getDataFileType(resource));
    }

    /**
     * Consume pending test for a resource (called by StatsViewProvider)
     */
    consumePendingTest(resource: vscode.Uri): string | undefined {
        const key = resource.toString();
        const testId = this.pendingTestByUri.get(key);
        if (testId) {
            this.pendingTestByUri.delete(key);
        }
        return testId;
    }

    /**
     * Switch to Editor view (with binary file handling)
     */
    async switchToEditor(resource: vscode.Uri): Promise<void> {
        const fileType = this.getDataFileType(resource);

        if (fileType === 'parquet' || fileType === 'xlsx') {
            const choice = await vscode.window.showWarningMessage(
                'Binary data files cannot be viewed as text.',
                'Open Visualise',
                'Cancel'
            );
            if (choice === 'Open Visualise') {
                await this.switchToVisualise(resource);
            }
            return;
        }

        // CSV can be viewed as text
        await vscode.commands.executeCommand('vscode.openWith', resource, 'default');
        updateDataContextKeys('editor', fileType);
    }

    /**
     * Get the data file type from URI
     */
    getDataFileType(resource: vscode.Uri): DataFileType | null {
        const ext = path.extname(resource.path).toLowerCase();
        switch (ext) {
            case '.csv': return 'csv';
            case '.parquet': return 'parquet';
            case '.xlsx': return 'xlsx';
            default: return null;
        }
    }

    /**
     * Check if a resource is a data file
     */
    isDataFile(resource: vscode.Uri): boolean {
        return this.getDataFileType(resource) !== null;
    }

    private getActiveDataFileFromEditor(): vscode.Uri | undefined {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (!activeTab) return undefined;

        let uri: vscode.Uri | undefined;
        if (activeTab.input instanceof vscode.TabInputText) {
            uri = activeTab.input.uri;
        } else if (activeTab.input instanceof vscode.TabInputCustom) {
            uri = activeTab.input.uri;
        }

        if (uri && this.isDataFile(uri)) {
            return uri;
        }
        return undefined;
    }
}
```

---

### 2.7 Resources Panel Provider (CORRECTED - WebviewViewProvider)

```typescript
// src/panels/resources/ResourcesPanelProvider.ts

import * as vscode from 'vscode';

export type ResourcesSection = 'strategy' | 'stats';

interface ResourcesState {
    section: ResourcesSection;
    expandedNodes: string[];
    strategyTree: TreeNode[];
    statsTree: TreeNode[];
}

interface TreeNode {
    id: string;
    label: string;
    description?: string;
    icon: string;
    collapsible: boolean;
    children?: TreeNode[];
}

export class ResourcesPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'quantlab.resourcesView';
    private static instance: ResourcesPanelProvider;

    private view?: vscode.WebviewView;
    private state: ResourcesState;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly globalState: vscode.Memento
    ) {
        ResourcesPanelProvider.instance = this;

        this.state = {
            section: globalState.get('quantlab.resourcesSection', 'strategy'),
            expandedNodes: [],
            strategyTree: [],
            statsTree: []
        };
    }

    static getInstance(): ResourcesPanelProvider {
        return ResourcesPanelProvider.instance;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        this.disposables.push(
            webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg))
        );

        // Load catalogs and send initial state
        void this.initialize();
    }

    private async initialize(): Promise<void> {
        this.state.strategyTree = await this.loadStrategyCatalog();
        this.state.statsTree = await this.loadStatsCatalog();
        this.sendState();
    }

    /**
     * Set the active section (called by commands)
     */
    async setSection(section: ResourcesSection): Promise<void> {
        if (this.state.section !== section) {
            this.state.section = section;
            await this.globalState.update('quantlab.resourcesSection', section);
            this.sendState();
        }
    }

    private handleMessage(message: { type: string; [key: string]: unknown }): void {
        switch (message.type) {
            case 'ready':
                this.sendState();
                break;
            case 'switchSection':
                void this.setSection(message.section as ResourcesSection);
                break;
            case 'toggleNode':
                this.toggleNode(message.nodeId as string);
                break;
            case 'selectNode':
                this.handleNodeSelect(message.nodeId as string);
                break;
        }
    }

    private toggleNode(nodeId: string): void {
        const idx = this.state.expandedNodes.indexOf(nodeId);
        if (idx >= 0) {
            this.state.expandedNodes.splice(idx, 1);
        } else {
            this.state.expandedNodes.push(nodeId);
        }
        this.sendState();
    }

    private handleNodeSelect(nodeId: string): void {
        if (this.state.section === 'strategy') {
            // Existing behavior for strategy resources
            void vscode.commands.executeCommand('quantlab.action.openResource', nodeId);
        } else {
            // NEW: Open stats test
            void vscode.commands.executeCommand('quantlab.stats.openTest', { testId: nodeId });
        }
    }

    private sendState(): void {
        this.view?.webview.postMessage({
            type: 'setState',
            state: {
                section: this.state.section,
                expandedNodes: this.state.expandedNodes,
                tree: this.state.section === 'strategy'
                    ? this.state.strategyTree
                    : this.state.statsTree
            }
        });
    }

    private async loadStrategyCatalog(): Promise<TreeNode[]> {
        // Load existing resourcesCatalog.json
        const catalogUri = vscode.Uri.joinPath(
            this.extensionUri, 'src', 'panels', 'resources', 'resourcesCatalog.json'
        );
        try {
            const data = await vscode.workspace.fs.readFile(catalogUri);
            const catalog = JSON.parse(Buffer.from(data).toString('utf8'));
            return this.buildStrategyTree(catalog);
        } catch {
            return [];
        }
    }

    private async loadStatsCatalog(): Promise<TreeNode[]> {
        const catalogUri = vscode.Uri.joinPath(
            this.extensionUri, 'src', 'panels', 'resources', 'statsCatalog.json'
        );
        try {
            const data = await vscode.workspace.fs.readFile(catalogUri);
            const catalog = JSON.parse(Buffer.from(data).toString('utf8'));
            return this.buildStatsTree(catalog);
        } catch {
            return [];
        }
    }

    private buildStrategyTree(catalog: { tests: any[]; templates: any[]; guides: any[] }): TreeNode[] {
        return [
            {
                id: 'tests',
                label: 'Tests',
                icon: 'beaker',
                collapsible: true,
                children: catalog.tests.map((t: any) => ({
                    id: t.id,
                    label: t.label,
                    icon: 'play',
                    collapsible: false
                }))
            },
            {
                id: 'templates',
                label: 'Templates',
                icon: 'file-code',
                collapsible: true,
                children: catalog.templates.map((t: any) => ({
                    id: t.id,
                    label: t.label,
                    icon: 'file',
                    collapsible: false
                }))
            },
            {
                id: 'guides',
                label: 'Guides',
                icon: 'book',
                collapsible: true,
                children: catalog.guides.map((g: any) => ({
                    id: g.id,
                    label: g.label,
                    icon: 'link-external',
                    collapsible: false
                }))
            }
        ];
    }

    private buildStatsTree(catalog: { categories: any[] }): TreeNode[] {
        return catalog.categories.map((cat: any) => ({
            id: cat.id,
            label: cat.label,
            icon: cat.icon,
            collapsible: true,
            children: cat.tests.map((test: any) => ({
                id: test.id,
                label: test.label,
                description: test.description,
                icon: 'symbol-method',
                collapsible: false
            }))
        }));
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'resources.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'resources-style.css')
        );
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link href="${codiconsUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Resources</title>
</head>
<body>
    <div id="resources-root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return text;
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
```

---

### 2.8 DataService Extension (ADD loadDataFrame)

```typescript
// src/core/engine/DataService.ts - ADD these methods

import * as XLSX from 'xlsx';
import { ColumnInfo, DataFrameResult } from '../../types/data';

/**
 * Load data file as a DataFrame with column metadata
 */
async loadDataFrame(filePath: string, options?: {
    sheetName?: string;
    maxRows?: number;
}): Promise<DataFrameResult> {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
        case '.csv':
            return this.loadCsvAsDataFrame(filePath, options?.maxRows);
        case '.parquet':
            return this.loadParquetAsDataFrame(filePath, options?.maxRows);
        case '.xlsx':
            return this.loadXlsxAsDataFrame(filePath, options?.sheetName, options?.maxRows);
        default:
            throw new Error(`Unsupported file format: ${ext}`);
    }
}

/**
 * Get column metadata without loading full data
 */
async getColumnMetadata(filePath: string): Promise<ColumnInfo[]> {
    const result = await this.loadDataFrame(filePath, { maxRows: 1000 });
    return result.columns;
}

private async loadCsvAsDataFrame(filePath: string, maxRows?: number): Promise<DataFrameResult> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    if (lines.length === 0) {
        return { columns: [], data: {}, rowCount: 0 };
    }

    const headers = this.parseCsvLine(lines[0]);
    const data: Record<string, unknown[]> = {};
    for (const header of headers) {
        data[header] = [];
    }

    const limit = maxRows ? Math.min(lines.length - 1, maxRows) : lines.length - 1;
    for (let i = 1; i <= limit; i++) {
        const values = this.parseCsvLine(lines[i]);
        for (let j = 0; j < headers.length; j++) {
            data[headers[j]].push(this.parseValue(values[j]));
        }
    }

    const columns = headers.map(name => this.inferColumnInfo(name, data[name]));

    return { columns, data, rowCount: limit };
}

private async loadXlsxAsDataFrame(
    filePath: string,
    sheetName?: string,
    maxRows?: number
): Promise<DataFrameResult> {
    const workbook = XLSX.readFile(filePath, { sheetRows: maxRows ? maxRows + 1 : undefined });
    const sheet = sheetName ?? workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheet];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];

    if (jsonData.length === 0) {
        return { columns: [], data: {}, rowCount: 0 };
    }

    const headers = (jsonData[0] as string[]).map(h => String(h));
    const data: Record<string, unknown[]> = {};
    for (const header of headers) {
        data[header] = [];
    }

    for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i] as unknown[];
        for (let j = 0; j < headers.length; j++) {
            data[headers[j]].push(row[j] ?? null);
        }
    }

    const columns = headers.map(name => this.inferColumnInfo(name, data[name]));

    return { columns, data, rowCount: jsonData.length - 1 };
}

private inferColumnInfo(name: string, values: unknown[]): ColumnInfo {
    const nonNull = values.filter(v => v !== null && v !== undefined);
    const nullCount = values.length - nonNull.length;

    // Infer type from first non-null values
    let dtype: ColumnInfo['dtype'] = 'object';
    const sample = nonNull.slice(0, 100);

    if (sample.every(v => typeof v === 'number')) {
        dtype = Number.isInteger(sample[0] as number) ? 'int64' : 'float64';
    } else if (sample.every(v => v instanceof Date)) {
        dtype = 'datetime64';
    } else if (sample.every(v => typeof v === 'boolean')) {
        dtype = 'bool';
    }

    const numericValues = nonNull.filter(v => typeof v === 'number') as number[];

    return {
        name,
        dtype,
        nullCount,
        uniqueCount: new Set(nonNull.map(String)).size,
        min: numericValues.length > 0 ? Math.min(...numericValues) : undefined,
        max: numericValues.length > 0 ? Math.max(...numericValues) : undefined,
        sampleValues: nonNull.slice(0, 5)
    };
}

private parseCsvLine(line: string): string[] {
    // Simple CSV parsing - production should use proper library
    return line.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
}

private parseValue(value: string): unknown {
    if (!value || value === '') return null;
    const num = Number(value);
    if (!isNaN(num)) return num;
    const date = Date.parse(value);
    if (!isNaN(date)) return new Date(date);
    return value;
}
```

---

### 2.9 Extension Registration (MODIFY extension.ts)

```typescript
// Add to extension.ts

import { DataViewManager } from './views/DataViewManager';
import { ResourcesPanelProvider } from './panels/resources/ResourcesPanelProvider';
import { StatsViewProvider } from './views/stats/StatsViewProvider';
import { VisualiseViewProvider } from './views/visualise/VisualiseViewProvider';
import { registerDataCommands } from './commands/dataCommands';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // ... existing code ...

    // Initialize DataViewManager
    DataViewManager.getInstance();

    // Register Resources panel (WebviewViewProvider)
    const resourcesProvider = new ResourcesPanelProvider(
        context.extensionUri,
        context.globalState
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ResourcesPanelProvider.viewType,
            resourcesProvider
        )
    );

    // Register Stats view (CustomTextEditorProvider)
    const statsProvider = new StatsViewProvider(context, globalState, historyState);
    statsProvider.register(context);

    // Register Visualise view (CustomTextEditorProvider)
    const visualiseProvider = new VisualiseViewProvider(context);
    visualiseProvider.register(context);

    // Register data file commands
    registerDataCommands(context);

    // ... rest of existing code ...
}
```

---

## 3. Implementation Phases (Revised)

### Phase 0: Foundation (2 days)

**Create:**
- `types/data.ts`
- `types/stats.ts`

**Modify:**
- `types/views.ts` - Add view types
- `types/engine.ts` - Add stats types
- `utils/contextKeys.ts` - Add `updateDataContextKeys`

---

### Phase 1: Data File Detection & Buttons (2-3 days)

**Modify (VS Code core):**
- `quantlabContextKeys.ts` - Add data file context keys
- `multiEditorTabsControl.ts` - Add data file button rendering

**Create (Extension):**
- `views/DataViewManager.ts`
- `commands/dataCommands.ts`

**Modify (Extension):**
- `commands/viewCommands.ts` - Wire up data commands

---

### Phase 2: Resources Panel Redesign (3-4 days)

**Modify:**
- `package.json` - Change resources view to webview type

**Create:**
- `panels/resources/ResourcesPanelProvider.ts` (rewrite as WebviewViewProvider)
- `panels/resources/statsCatalog.json`
- `webview/resources/index.ts`
- `webview/resources/resources.css`

**Modify:**
- `esbuild-webview.mjs` - Add resources entry points
- `extension.ts` - Register WebviewViewProvider

---

### Phase 3: Stats View (4-5 days)

**Create:**
- `views/stats/StatsViewProvider.ts`
- `views/stats/StatsWebview.ts`
- `webview/stats/index.ts`
- `webview/stats/states/*.ts`
- `webview/stats/stats.css`

**Modify:**
- `package.json` - Register custom editor
- `esbuild-webview.mjs` - Add stats entry points
- `extension.ts` - Register StatsViewProvider

---

### Phase 4: Stats Execution (3-4 days)

**Create:**
- `core/engine/StatsEngine.ts`
- `python/stats/runner.py`
- `python/stats/stationarity.py`
- `python/stats/descriptive.py`
- (other Python modules)

**Modify:**
- `core/engine/EngineHost.ts` - Support stats action type
- `core/engine/DataService.ts` - Add `loadDataFrame`

---

### Phase 5: Visualise View (3-4 days)

**Create:**
- `views/visualise/VisualiseViewProvider.ts`
- `views/visualise/VisualiseWebview.ts`
- `webview/visualise/index.ts`
- `webview/visualise/visualise.css`
- `webview/shared/plotly.ts`

**Modify:**
- `package.json` - Add plotly.js-dist-min dependency
- `esbuild-webview.mjs` - Add visualise entry points

---

### Phase 6: Integration & Testing (2-3 days)

- Wire all commands
- Test full flow
- Handle edge cases
- Add xlsx dependency

---

## 4. Verification Checklist

### File Detection
- [ ] CSV file → `quantlab.isDataFile` = true, buttons appear
- [ ] Parquet file → same
- [ ] XLSX file → same
- [ ] Python file → `quantlab.isStrategy` logic unchanged

### Button Flow
- [ ] Click Visualise → VisualiseView opens
- [ ] Click Action → Resources panel opens with Pure Stats
- [ ] Buttons update on tab switch

### Resources Panel
- [ ] Horizontal mode switcher visible
- [ ] Strategy section has Tests/Templates/Guides
- [ ] Pure Stats section has 7 categories
- [ ] Trees expand/collapse
- [ ] Click test → Stats view opens

### Stats View
- [ ] Test config form renders
- [ ] Column selector works
- [ ] Run test → progress shown
- [ ] Results render correctly

### Edge Cases
- [ ] Click Action, switch tab, click test → warning shown
- [ ] Binary file + Editor → redirect to Visualise
- [ ] Large file → handles gracefully

---

## 5. Complete File Change Summary

### New Files (16)

| File | Purpose |
|------|---------|
| `src/types/data.ts` | Data file types |
| `src/types/stats.ts` | Stats test types |
| `src/views/DataViewManager.ts` | Data view management |
| `src/views/stats/StatsViewProvider.ts` | Stats custom editor |
| `src/views/stats/StatsWebview.ts` | Stats webview comm |
| `src/views/visualise/VisualiseViewProvider.ts` | Visualise custom editor |
| `src/views/visualise/VisualiseWebview.ts` | Visualise webview comm |
| `src/core/engine/StatsEngine.ts` | Stats execution |
| `src/commands/dataCommands.ts` | Data file commands |
| `src/panels/resources/statsCatalog.json` | Stats test catalog |
| `webview/resources/index.ts` | Resources webview |
| `webview/resources/resources.css` | Resources styles |
| `webview/stats/index.ts` | Stats webview |
| `webview/stats/stats.css` | Stats styles |
| `webview/visualise/index.ts` | Visualise webview |
| `webview/visualise/visualise.css` | Visualise styles |

### Modified Files (11)

| File | Changes |
|------|---------|
| `src/types/views.ts` | Add visualise, stats to ViewType |
| `src/types/engine.ts` | Add StatsJobRequest, StatsJobResult |
| `src/utils/contextKeys.ts` | Add updateDataContextKeys |
| `src/panels/resources/ResourcesPanelProvider.ts` | Rewrite as WebviewViewProvider |
| `src/core/engine/DataService.ts` | Add loadDataFrame, getColumnMetadata |
| `src/commands/viewCommands.ts` | Add data view commands |
| `src/extension.ts` | Register new providers |
| `quantlabContextKeys.ts` (VS Code core) | Add data file detection |
| `multiEditorTabsControl.ts` (VS Code core) | Add data file buttons |
| `esbuild-webview.mjs` | Add new entry points |
| `package.json` | Commands, keybindings, custom editors, dependencies |

### Python Files (8)

| File | Purpose |
|------|---------|
| `python/stats/__init__.py` | Package init |
| `python/stats/runner.py` | Entry point |
| `python/stats/descriptive.py` | Summary stats |
| `python/stats/stationarity.py` | ADF, KPSS, etc. |
| `python/stats/distribution.py` | Normality tests |
| `python/stats/dependence.py` | Correlation, ACF |
| `python/stats/volatility.py` | ARCH effects |
| `python/stats/regression.py` | OLS diagnostics |
| `python/stats/risk.py` | VaR, drawdown |

---

## 6. This Plan is Now Complete

All issues from the comprehensive audit have been addressed:

| Issue | Resolution |
|-------|------------|
| Wrong webview path | Corrected to `webview/` at extension root |
| Esbuild config exists | Plan now modifies existing file |
| WebviewViewProvider pattern | Full implementation provided |
| Custom editor registration | Package.json changes specified |
| JobRequest incompatibility | New StatsJobRequest type defined |
| DataService limitations | loadDataFrame method added |
| Race condition | Pending pattern implemented |
| Context keys | updateDataContextKeys added |

**Status: READY FOR IMPLEMENTATION PROMPTS**
