# Resources Panel & Statistics System - CORRECTED Master Plan

**Version:** 2.0 (Post-Audit)
**Changes from v1:** Addresses all critical issues from audit report.

---

## 1. Corrected User Flow

### Strategy Files (Existing - No Change)

```
1. Open strategy.py → RHS buttons: [Chart] [Action] [Trade]
2. Click [Action]
   └─► Opens ActionView (custom editor replaces file in main area)
   └─► Also focuses Resources panel (Strategy section)
3. User clicks test in Resources
   └─► ActionView updates to show test configuration
```

### Data Files (NEW - CORRECTED)

```
1. Open data.csv/xlsx/parquet → RHS buttons: [Visualise] [Action]

2. Click [Visualise]
   └─► Opens VisualiseView (custom editor replaces file in main area)
   └─► Data exploration charts

3. Click [Action]
   └─► ONLY focuses Resources panel with Pure Stats selected
   └─► Does NOT open Stats view immediately
   └─► Data file stays in editor (or Visualise if already there)

4. User expands category in Resources (e.g., Stationarity)
5. User clicks test (e.g., ADF Test)
   └─► NOW Stats view opens as custom editor
   └─► Shows ADF configuration form
   └─► User configures and runs test
```

**Key Difference from v1:** Action button on data file does NOT open a view - it only opens the Resources panel.

---

## 2. Corrected Architecture

### 2.1 View Managers

**Existing:** `ViewManager` (strategy-coupled, validates strategy code)

**New:** `DataViewManager` (for data files, no strategy validation)

```typescript
// views/DataViewManager.ts
export class DataViewManager {
    private static instance: DataViewManager;
    private lastActiveDataFile: vscode.Uri | undefined;

    static getInstance(): DataViewManager {
        if (!DataViewManager.instance) {
            DataViewManager.instance = new DataViewManager();
        }
        return DataViewManager.instance;
    }

    /**
     * Called when user clicks [Visualise] button
     */
    async switchToVisualise(resource: vscode.Uri): Promise<void> {
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.visualiseView');
        updateDataContextKeys('visualise');
    }

    /**
     * Called when user clicks [Action] button on data file
     * Does NOT open a view - only focuses Resources panel
     */
    async openDataAction(resource: vscode.Uri): Promise<void> {
        // Remember which data file was active
        this.lastActiveDataFile = resource;

        // Switch Resources panel to Pure Stats section
        await vscode.commands.executeCommand('quantlab.setResourcesSection', 'stats');

        // Focus the Resources panel
        await vscode.commands.executeCommand('quantlab.focusResourcesPanel');

        // Do NOT open Stats view yet - wait for test selection
    }

    /**
     * Called when user clicks a test in Resources panel
     */
    async openStatsTest(testId: string): Promise<void> {
        const resource = this.lastActiveDataFile ?? this.getActiveDataFileFromEditor();

        if (!resource) {
            vscode.window.showWarningMessage('Please select a data file first.');
            return;
        }

        // NOW open the Stats view
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.statsView');

        // Tell the Stats view which test to configure
        const statsProvider = StatsViewProvider.getInstance();
        statsProvider.configureTest(resource, testId);
    }

    async switchToEditor(resource: vscode.Uri): Promise<void> {
        const ext = path.extname(resource.path).toLowerCase();

        // Binary files can't be viewed as text
        if (ext === '.parquet' || ext === '.xlsx') {
            const choice = await vscode.window.showWarningMessage(
                'Binary data files cannot be viewed as text.',
                'Open Visualise'
            );
            if (choice === 'Open Visualise') {
                await this.switchToVisualise(resource);
            }
            return;
        }

        // CSV is text, can open normally
        await vscode.commands.executeCommand('vscode.openWith', resource, 'default');
        updateDataContextKeys('editor');
    }

    private getActiveDataFileFromEditor(): vscode.Uri | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;

        const ext = path.extname(editor.document.uri.path).toLowerCase();
        if (['.csv', '.parquet', '.xlsx'].includes(ext)) {
            return editor.document.uri;
        }
        return undefined;
    }
}
```

---

### 2.2 Command Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA FILE COMMANDS                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Visualise] button                                             │
│       │                                                         │
│       ▼                                                         │
│  quantlab.switchToVisualise                                     │
│       │                                                         │
│       ▼                                                         │
│  DataViewManager.switchToVisualise(uri)                         │
│       │                                                         │
│       ▼                                                         │
│  Opens quantlab.visualiseView (custom editor)                   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Action] button                                                │
│       │                                                         │
│       ▼                                                         │
│  quantlab.openDataAction                                        │
│       │                                                         │
│       ▼                                                         │
│  DataViewManager.openDataAction(uri)                            │
│       │                                                         │
│       ├─► Stores lastActiveDataFile                             │
│       ├─► Sets resourcesSection = 'stats'                       │
│       └─► Focuses Resources panel                               │
│                                                                 │
│  (User is now viewing Resources panel with Pure Stats tree)     │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Click test in Resources                                        │
│       │                                                         │
│       ▼                                                         │
│  quantlab.stats.openTest { testId: 'adf' }                      │
│       │                                                         │
│       ▼                                                         │
│  DataViewManager.openStatsTest('adf')                           │
│       │                                                         │
│       ▼                                                         │
│  Opens quantlab.statsView with ADF configuration                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 2.3 Button Rendering (Corrected)

```typescript
// multiEditorTabsControl.ts

private updateQuantlabActions(): void {
    if (!this.quantlabActionsContainer) return;

    const disposables = this.ensureQuantlabActionsDisposables();
    disposables.clear();
    clearNode(this.quantlabActionsContainer);

    const currentView = this.getQuantlabCurrentView();
    const isStrategy = this.isQuantlabStrategy();
    const isDataFile = this.isQuantlabDataFile();

    if (isStrategy) {
        // Strategy: Chart, Action, Trade
        this.renderStrategyButtons(currentView, disposables);
    } else if (isDataFile) {
        // Data file: Visualise, Action
        this.renderDataFileButtons(currentView, disposables);
    }
    // Other files: no buttons
}

private renderDataFileButtons(currentView: QuantlabViewType, disposables: DisposableStore): void {
    const buttons: Array<{ label: string; command: string; view: string }> = [];

    // Order: non-current views first, then current view indicator
    if (currentView === 'visualise') {
        buttons.push(
            { label: 'Editor', command: 'quantlab.switchToDataEditor', view: 'editor' },
            { label: 'Action', command: 'quantlab.openDataAction', view: 'action' }
        );
        // Visualise is current, shown last or highlighted
    } else if (currentView === 'stats') {
        buttons.push(
            { label: 'Visualise', command: 'quantlab.switchToVisualise', view: 'visualise' },
            { label: 'Editor', command: 'quantlab.switchToDataEditor', view: 'editor' }
        );
    } else {
        // Default (editor view)
        buttons.push(
            { label: 'Visualise', command: 'quantlab.switchToVisualise', view: 'visualise' },
            { label: 'Action', command: 'quantlab.openDataAction', view: 'action' }
        );
    }

    for (const btn of buttons) {
        const button = document.createElement('button');
        button.className = 'quantlab-view-button';
        button.type = 'button';
        button.textContent = btn.label;

        disposables.add(addDisposableListener(button, EventType.CLICK, e => {
            EventHelper.stop(e, true);
            void this.commandService.executeCommand(btn.command);
        }));

        this.quantlabActionsContainer!.appendChild(button);
    }
}
```

---

## 3. Corrected Phase Structure

### Phase 0: Foundation (2 days)

**Files:**
- `types/data.ts` - Data file types
- `types/stats.ts` - Stats test types
- `views/DataViewManager.ts` - Data view management (NEW)
- `esbuild.webview.js` - Webview build configuration (NEW)

**DataViewManager skeleton:**
```typescript
export class DataViewManager {
    private static instance: DataViewManager;
    private lastActiveDataFile: vscode.Uri | undefined;

    static getInstance(): DataViewManager;
    async switchToVisualise(resource: vscode.Uri): Promise<void>;
    async openDataAction(resource: vscode.Uri): Promise<void>;  // Does NOT open view
    async openStatsTest(testId: string): Promise<void>;         // Opens Stats view
    async switchToEditor(resource: vscode.Uri): Promise<void>;
}
```

**Build configuration:**
```javascript
// esbuild.webview.js
const esbuild = require('esbuild');

const entryPoints = [
    'src/panels/resources/webview/resources.ts',
    'src/views/stats/webview/stats.ts',
    'src/views/visualise/webview/visualise.ts'
];

esbuild.build({
    entryPoints,
    bundle: true,
    outdir: 'dist/webview',
    format: 'iife',
    sourcemap: true
});
```

**package.json scripts:**
```json
{
  "scripts": {
    "build:webview": "node esbuild.webview.js",
    "watch:webview": "node esbuild.webview.js --watch",
    "build": "npm run build:extension && npm run build:webview"
  }
}
```

---

### Phase 1: Data File Detection (2-3 days)

**Context Keys:**
```typescript
// quantlabContextKeys.ts

const QUANTLAB_IS_DATA_FILE = new RawContextKey<boolean>('quantlab.isDataFile', false);
const QUANTLAB_DATA_FILE_TYPE = new RawContextKey<string | null>('quantlab.dataFileType', null);

// Detection
private isDataFile(resource: URI): boolean {
    const ext = resource.path.toLowerCase();
    return ext.endsWith('.xlsx') || ext.endsWith('.parquet') || ext.endsWith('.csv');
}
```

**Button Rendering:**
- Use corrected `renderDataFileButtons` (see 2.3 above)
- "Action" button calls `quantlab.openDataAction` (not `switchToStats`)

**Commands:**
```typescript
// viewCommands.ts
const dataViewManager = DataViewManager.getInstance();

context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.switchToVisualise', async () => {
        const uri = getActiveDataFileUri();
        if (uri) await dataViewManager.switchToVisualise(uri);
    }),

    vscode.commands.registerCommand('quantlab.openDataAction', async () => {
        const uri = getActiveDataFileUri();
        if (uri) await dataViewManager.openDataAction(uri);
    }),

    vscode.commands.registerCommand('quantlab.switchToDataEditor', async () => {
        const uri = getActiveDataFileUri();
        if (uri) await dataViewManager.switchToEditor(uri);
    })
);
```

---

### Phase 2: Resources Panel Redesign (3-4 days)

**No changes from original plan** - webview with horizontal mode switcher.

**Additional:** When test is clicked, call `quantlab.stats.openTest`:

```typescript
// ResourcesPanelProvider.ts
private handleNodeAction(nodeId: string, action: string): void {
    if (this.state.section === 'strategy') {
        // Existing behavior
        void vscode.commands.executeCommand('quantlab.action.openResource', nodeId);
    } else {
        // NEW: Open stats test
        void vscode.commands.executeCommand('quantlab.stats.openTest', { testId: nodeId });
    }
}
```

---

### Phase 3: Stats View (4 days)

**Key clarification:** Stats view does NOT have a "selection" state. Selection happens in Resources panel.

**States:**
```typescript
type StatsState =
    | StatsIdleState           // No test selected yet
    | StatsConfigurationState  // Showing test config form
    | StatsRunningState        // Executing test
    | StatsResultsState;       // Showing results

interface StatsIdleState {
    type: 'idle';
    dataFile: string;
    // Shows message: "Select a test from the Resources panel"
}

interface StatsConfigurationState {
    type: 'configuration';
    testId: string;
    testName: string;
    dataFile: string;
    columns: ColumnInfo[];       // Available columns in data
    selectedColumns: string[];   // User-selected columns
    parameters: Record<string, unknown>;
    schema: TestParameterSchema;
}
```

**Opening test from Resources:**
```typescript
// StatsViewProvider.ts
export class StatsViewProvider implements vscode.CustomTextEditorProvider {
    private static instance: StatsViewProvider;

    static getInstance(): StatsViewProvider {
        return StatsViewProvider.instance;
    }

    /**
     * Called by DataViewManager when user clicks a test in Resources
     */
    async configureTest(resource: vscode.Uri, testId: string): Promise<void> {
        const session = this.sessions.get(resource.toString());
        if (!session) return;

        // Load test schema from catalog
        const testSchema = await this.loadTestSchema(testId);

        // Load column info from data file
        const columns = await this.loadColumnInfo(resource);

        // Transition to configuration state
        const state: StatsConfigurationState = {
            type: 'configuration',
            testId,
            testName: testSchema.label,
            dataFile: resource.fsPath,
            columns,
            selectedColumns: this.autoSelectColumns(columns, testSchema),
            parameters: testSchema.defaultParameters,
            schema: testSchema
        };

        session.webview.postMessage({ type: 'setState', state });
    }
}
```

---

### Phase 4: Stats Execution (3-4 days)

**Use existing EngineHost infrastructure:**

```typescript
// core/engine/StatsEngine.ts
import { EngineHost } from './EngineHost';

export class StatsEngine {
    private readonly engineHost = EngineHost.getInstance();

    async runTest(config: StatsTestConfig): Promise<StatsTestResult> {
        const jobId = this.createJobId(config.testId);

        const request = {
            jobId,
            action: 'stats',  // New action type for EngineHost
            config: {
                testId: config.testId,
                dataPath: config.dataSource,
                columns: config.columns,
                parameters: config.parameters
            }
        };

        // Use existing job infrastructure
        const result = await this.engineHost.runJob(request);

        return this.parseStatsResult(result);
    }
}
```

**Python script:**
```python
# python/stats_runner.py
import sys
import json
from stats import descriptive, stationarity, distribution, dependence, volatility, regression, risk

def main():
    config = json.loads(sys.stdin.read())

    test_id = config['testId']
    data_path = config['dataPath']
    columns = config['columns']
    params = config['parameters']

    # Load data
    data = load_data(data_path, columns)

    # Route to appropriate module
    result = run_test(test_id, data, params)

    print(json.dumps(result))

if __name__ == '__main__':
    main()
```

---

### Phase 5: Visualise View (3-4 days)

**No major changes from original plan.**

**Share Plotly setup with Stats view:**
```typescript
// shared/plotly.ts
export function initPlotly(container: HTMLElement): void {
    // Common Plotly configuration
}

export function renderChart(
    container: HTMLElement,
    type: ChartType,
    data: PlotlyData,
    layout?: Partial<PlotlyLayout>
): void {
    // Shared rendering logic
}
```

---

### Phase 6: Integration (2-3 days)

**Commands:**
```typescript
// Register all commands
context.subscriptions.push(
    // Data view commands
    vscode.commands.registerCommand('quantlab.switchToVisualise', ...),
    vscode.commands.registerCommand('quantlab.openDataAction', ...),
    vscode.commands.registerCommand('quantlab.switchToDataEditor', ...),

    // Stats commands
    vscode.commands.registerCommand('quantlab.stats.openTest', async (args) => {
        const dataViewManager = DataViewManager.getInstance();
        await dataViewManager.openStatsTest(args.testId);
    }),
    vscode.commands.registerCommand('quantlab.stats.runTest', ...),

    // Resources commands
    vscode.commands.registerCommand('quantlab.setResourcesSection', async (section) => {
        const resourcesProvider = ResourcesPanelProvider.getInstance();
        await resourcesProvider.setSection(section);
    })
);
```

**Keybindings:**
```json
[
    {
        "key": "ctrl+q v",
        "command": "quantlab.switchToVisualise",
        "when": "quantlab.isDataFile"
    },
    {
        "key": "ctrl+q a",
        "command": "quantlab.openDataAction",
        "when": "quantlab.isDataFile"
    }
]
```

---

### Phase 7: Excel Support (2 days)

**No changes from original plan.**

---

## 4. Corrected File Inventory

### New Files

| File | Purpose |
|------|---------|
| `types/data.ts` | Data file types |
| `types/stats.ts` | Stats test types |
| `views/DataViewManager.ts` | **NEW** - Data view management |
| `panels/resources/ResourcesPanelProvider.ts` | Webview-based panel |
| `panels/resources/statsCatalog.json` | Stats test catalog |
| `views/stats/StatsViewProvider.ts` | Stats custom editor |
| `views/visualise/VisualiseViewProvider.ts` | Visualise custom editor |
| `core/engine/StatsEngine.ts` | Stats execution (uses EngineHost) |
| `python/stats_runner.py` | Stats Python entry point |
| `shared/plotly.ts` | **NEW** - Shared Plotly utilities |
| `esbuild.webview.js` | **NEW** - Webview build config |

### Modified Files

| File | Changes |
|------|---------|
| `quantlabContextKeys.ts` | Add data file detection |
| `multiEditorTabsControl.ts` | Add data file buttons (corrected) |
| `package.json` | Commands, keybindings, custom editors |
| `extension.ts` | Register DataViewManager, StatsViewProvider |

---

## 5. Verification Checklist

After implementation, verify these flows work:

### Data File Button Flow
- [ ] Open CSV → [Visualise] [Action] buttons appear
- [ ] Open Parquet → [Visualise] [Action] buttons appear
- [ ] Open XLSX → [Visualise] [Action] buttons appear
- [ ] Open Python strategy → [Chart] [Action] [Trade] buttons (unchanged)

### Visualise Flow
- [ ] Click [Visualise] → VisualiseView opens in main area
- [ ] Data columns are detected
- [ ] Charts render correctly

### Action/Stats Flow (CRITICAL)
- [ ] Click [Action] → Resources panel opens (NOT Stats view)
- [ ] Resources panel shows Pure Stats section
- [ ] Expand Stationarity → tests visible
- [ ] Click ADF Test → NOW Stats view opens
- [ ] Stats view shows ADF configuration
- [ ] Configure and run → results appear

### Mode Switching
- [ ] On strategy file, click Action → Resources shows Strategy section
- [ ] On data file, click Action → Resources shows Pure Stats section
- [ ] Manual toggle between sections works

### Edge Cases
- [ ] Click Action on data file, then switch tabs → Resources stays on Pure Stats
- [ ] Click test in Resources when no data file active → shows warning
- [ ] Binary file + Editor button → shows "Use Visualise" message

---

## 6. Summary of Changes from v1

| Issue | v1 (Wrong) | v2 (Corrected) |
|-------|------------|----------------|
| Action button behavior | Opens Stats view | Opens Resources panel only |
| Stats view trigger | Immediate on Action click | On test selection in Resources |
| ViewManager usage | Reuse for data files | New DataViewManager |
| Binary file editor | Not addressed | Show warning, redirect to Visualise |
| Build process | Not specified | esbuild.webview.js added |
| lastActiveDataFile | Not tracked | Stored in DataViewManager |
