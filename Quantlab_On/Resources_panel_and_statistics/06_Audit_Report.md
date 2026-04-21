# Plan Audit Report

## Executive Summary

After deep review, the plan is **~80% complete** but has several **critical gaps** and **inconsistencies** that would cause implementation problems. This document identifies all issues and provides corrections.

---

## CRITICAL ISSUES

### Issue #1: Action Button Flow is WRONG for Data Files

**What the plan says:**
> When user clicks "Action" on a data file:
> 1. Set context `quantlab.resourcesSection` to `'stats'`
> 2. Execute `quantlab.focusResourcesPanel`
> 3. Resources panel shows with Pure Stats mode active

**What's missing:** The plan doesn't clearly define when/how the Stats VIEW (main editor area) opens.

**Correct flow based on user requirements:**

```
STRATEGY FILES (existing):
1. Click "Action" RHS button
2. → Opens ActionView (custom editor replaces file content)
3. → Also focuses Resources panel (side effect via autoExpandPanel)
4. User clicks test in Resources → ActionView updates

DATA FILES (new - what user described):
1. Click "Action" RHS button
2. → ONLY focuses Resources panel with Pure Stats selected
3. → Does NOT immediately open a Stats view
4. User clicks specific test in Resources
5. → THEN Stats view opens for that data file
```

**Why this matters:** The current plan has `quantlab.switchToStats` which would open a Stats view immediately. But the user said clicking "Action" should "open the LHS tab" (Resources panel), not switch the view.

**Correction needed:**
- "Action" button on data file = `quantlab.openDataAction` (focuses Resources, sets section)
- Clicking a test in Resources = `quantlab.stats.openTest` (opens Stats view)

---

### Issue #2: ViewManager is Strategy-Coupled

**Problem:** The existing `ViewManager.ts` is tightly coupled to `StrategyValidator`:

```typescript
async switchView(editor: vscode.TextEditor, view: ViewType): Promise<void> {
    const validation = this.validator.validateDocument(editor.document);  // <-- Strategy-specific!

    if (!this.canSwitchToView(view, validation)) {
        await this.showIncompatibleToast(view, validation);  // <-- Shows "not a strategy" error
        return;
    }
    // ...
}
```

**Impact:** Cannot reuse ViewManager for data file views. Would show "not a strategy" errors.

**Solution Options:**

A) **Create separate DataViewManager** (cleaner separation)
```typescript
// New file: views/DataViewManager.ts
export class DataViewManager {
    async switchView(resource: vscode.Uri, view: DataViewType): Promise<void> {
        // No strategy validation needed
        // Handle visualise/stats views
    }
}
```

B) **Extend ViewManager with data file support** (more complex)
```typescript
// Modified ViewManager
async switchView(editor: vscode.TextEditor, view: ViewType): Promise<void> {
    if (this.isDataFileView(view)) {
        return this.switchDataFileView(editor, view);
    }
    // existing strategy logic
}
```

**Recommendation:** Option A (DataViewManager) - cleaner, doesn't risk breaking existing strategy flow.

---

### Issue #3: Missing "Stats View Opening" Mechanism

**Problem:** The plan describes the Stats view but doesn't clearly specify:
1. When exactly does it open?
2. How does clicking a test in Resources open it?
3. What if Stats view is already open for a different test?

**Clarified mechanism:**

```typescript
// When user clicks a test in Resources panel:
command: 'quantlab.stats.openTest'
args: { testId: 'adf' }

// Handler:
async function openTest(args: { testId: string }) {
    const activeDataFile = getActiveDataFileUri();
    if (!activeDataFile) {
        vscode.window.showWarningMessage('No data file selected');
        return;
    }

    // Open Stats view as custom editor for this data file
    await vscode.commands.executeCommand('vscode.openWith', activeDataFile, 'quantlab.statsView');

    // Send the testId to the Stats view to show configuration
    StatsViewProvider.getInstance().openTest(activeDataFile, args.testId);
}
```

**Missing from plan:** Need to track "active data file" when Action button was clicked, in case user switches tabs before clicking a test.

---

### Issue #4: Data File "Editor" View Not Addressed

**Problem:** When user clicks "Editor" button on a data file tab, what happens?

| File Type | Default VS Code Behavior |
|-----------|--------------------------|
| CSV | Shows as text (okay) |
| Parquet | Shows binary garbage (unusable) |
| XLSX | Shows binary garbage (unusable) |

**Options:**

A) **Create custom "Data Preview" editor** for parquet/xlsx
B) **Redirect "Editor" to "Visualise"** for binary data files
C) **Show message** "Use Visualise view to explore this data"

**Recommendation:** Option C for MVP, Option A for v2.

**Add to plan:**
```typescript
// In DataViewManager.switchView()
if (view === 'editor' && this.isBinaryDataFile(resource)) {
    vscode.window.showInformationMessage(
        'Binary data files cannot be viewed as text. Use Visualise view.',
        'Open Visualise'
    ).then(choice => {
        if (choice === 'Open Visualise') {
            this.switchView(resource, 'visualise');
        }
    });
    return;
}
```

---

### Issue #5: Resources Panel State Edge Cases

**Scenario:** User has both a strategy file and data file open.

1. User activates strategy tab
2. User clicks "Action" → Resources shows Strategy section
3. User activates data file tab
4. User clicks "Action" → Resources should switch to Pure Stats

**But what about:**
- User manually toggles Resources section while on strategy file
- User is on data file, manually switches to Strategy section, then clicks Action

**Clarification needed:** Should "Action" button ALWAYS set the Resources section, or only if coming from a different file type?

**Recommendation:** "Action" button ALWAYS sets the appropriate section. User's manual toggle is overridden when using the Action button.

```typescript
// Action button on strategy
async switchToAction() {
    await vscode.commands.executeCommand('quantlab.setResourcesSection', 'strategy');
    await vscode.commands.executeCommand('quantlab.focusResourcesPanel');
    // ... open ActionView
}

// Action button on data file
async openDataAction() {
    await vscode.commands.executeCommand('quantlab.setResourcesSection', 'stats');
    await vscode.commands.executeCommand('quantlab.focusResourcesPanel');
    // DON'T open Stats view yet - wait for test selection
}
```

---

### Issue #6: Build Process Not Specified

**Problem:** The plan mentions webview scripts but doesn't specify the build process:
- `webview/resources.ts` → `dist/webview/resources.js`
- `webview/stats.ts` → `dist/webview/stats.js`
- `webview/visualise.ts` → `dist/webview/visualise.js`

**Missing:**
1. esbuild/webpack configuration
2. Build scripts in package.json
3. Watch mode for development

**Add to plan:**

```json
// package.json scripts
{
  "scripts": {
    "build:webview": "esbuild src/webview/*.ts --bundle --outdir=dist/webview --format=iife",
    "watch:webview": "npm run build:webview -- --watch"
  }
}
```

```javascript
// esbuild.webview.js
const esbuild = require('esbuild');

esbuild.build({
    entryPoints: [
        'src/panels/resources/webview/resources.ts',
        'src/views/stats/webview/stats.ts',
        'src/views/visualise/webview/visualise.ts'
    ],
    bundle: true,
    outdir: 'dist/webview',
    format: 'iife',
    minify: process.env.NODE_ENV === 'production'
});
```

---

## MODERATE ISSUES

### Issue #7: No DataViewManager Interface Defined

**Problem:** Plan mentions DataViewManager in passing but no implementation details.

**Add to Phase 1:**

```typescript
// types/views.ts
export type DataViewType = 'editor' | 'visualise' | 'stats';

// views/DataViewManager.ts
export class DataViewManager {
    private static instance: DataViewManager;

    static getInstance(): DataViewManager { ... }

    async switchToVisualise(resource: vscode.Uri): Promise<void> {
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.visualiseView');
    }

    async switchToStats(resource: vscode.Uri, testId?: string): Promise<void> {
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.statsView');
        if (testId) {
            // Notify Stats view to show this test
        }
    }

    async switchToEditor(resource: vscode.Uri): Promise<void> {
        if (this.isBinaryDataFile(resource)) {
            // Show warning for binary files
            return;
        }
        await vscode.commands.executeCommand('vscode.openWith', resource, 'default');
    }
}
```

---

### Issue #8: Stats View State Management Incomplete

**Problem:** The StatsStateMachine states are defined but transitions aren't clear.

**Current (incomplete):**
```typescript
type StatsState =
  | StatsSelectionState      // Initial
  | StatsConfigurationState  // Configure
  | StatsRunningState        // Running
  | StatsResultsState        // Results
```

**Questions not answered:**
1. Does Stats view have a "selection" state, or is selection always in Resources panel?
2. Can user run multiple tests on the same data?
3. What happens when user clicks different test while one is running?

**Clarification:**

The Stats view should be **test-specific**, not have an internal selection state:

```typescript
// Simplified states:
type StatsState =
  | StatsIdleState           // Waiting for test selection (from Resources)
  | StatsConfigurationState  // Showing test config form
  | StatsRunningState        // Executing test
  | StatsResultsState        // Showing results (can modify params & re-run)

interface StatsIdleState {
    type: 'idle';
    message: 'Select a test from the Resources panel';
}
```

When user clicks different test in Resources:
1. If current test is running → prompt to cancel or wait
2. If results shown → replace with new test config

---

### Issue #9: Column Selection Not Detailed

**Problem:** Many stats tests operate on specific columns. Plan mentions "Column selector" but no implementation details.

**Need to specify:**

1. **How columns are detected:**
```typescript
interface DataFileMetadata {
    columns: ColumnInfo[];
}

interface ColumnInfo {
    name: string;
    dtype: 'numeric' | 'datetime' | 'string' | 'boolean';
    nullCount: number;
    sampleValues: unknown[];
}
```

2. **Which tests need which column types:**
```json
{
    "id": "adf",
    "requiredColumns": {
        "count": 1,
        "types": ["numeric"]
    }
}
```

3. **Multi-column tests:**
```json
{
    "id": "correlation-matrix",
    "requiredColumns": {
        "count": "2+",
        "types": ["numeric"]
    }
}
```

---

### Issue #10: Python Environment Not Specified

**Problem:** Plan assumes Python is available but doesn't specify:
- How is Python located?
- Virtual environment?
- Dependency installation?

**Should reuse existing EngineHost approach:**

```typescript
// StatsEngine should use same Python as EngineHost
export class StatsEngine {
    private readonly engineHost = EngineHost.getInstance();

    async runTest(config: StatsTestConfig): Promise<StatsTestResult> {
        // Use existing Python execution infrastructure
        const result = await this.engineHost.executeScript(
            'stats_runner.py',
            config
        );
        return this.parseResult(result);
    }
}
```

**Add to plan:** Clarify that StatsEngine uses existing EngineHost infrastructure, not a separate Python setup.

---

## MINOR ISSUES

### Issue #11: Keybinding Conflict

**Problem:** Plan has `Ctrl+Q A` for both strategy Action and data Action:

```json
// Strategy (existing)
{ "key": "ctrl+q a", "command": "quantlab.switchToAction", "when": "quantlab.isStrategy" }

// Data (proposed)
{ "key": "ctrl+q a", "command": "quantlab.switchToStats", "when": "quantlab.isDataFile" }
```

**This is actually fine** because of the `when` clauses. But need to verify no overlap scenario.

**Edge case:** What if neither `isStrategy` nor `isDataFile` is true? → No binding fires (correct).

---

### Issue #12: Missing Error States

**For each view, need error handling:**

| Error | Handling |
|-------|----------|
| Data file too large | Show warning, offer to sample |
| Invalid data format | Show error with details |
| Python not found | Show setup instructions |
| Test execution fails | Show error, allow retry |
| Network error (for server data) | Show retry option |

**Add to Phase 4:**
```typescript
interface StatsErrorState {
    type: 'error';
    error: {
        code: 'DATA_TOO_LARGE' | 'INVALID_FORMAT' | 'PYTHON_ERROR' | 'TEST_FAILED';
        message: string;
        recoverable: boolean;
        action?: { label: string; command: string };
    };
}
```

---

### Issue #13: No History/Recent Tests

**Currently:** Strategy Action view has "Recent Runs" feature.

**For Stats:** Consider adding "Recent Tests" showing:
- Test name
- Data file
- Timestamp
- Quick re-run option

**Add to Phase 4 (optional enhancement).**

---

### Issue #14: Stats Test Visualization Output

**Some tests produce charts:**
- ACF/PACF → Correlogram
- QQ Analysis → QQ Plot
- Distribution → Histogram overlay

**Plan mentions this but doesn't detail:**
1. Where are charts rendered?
2. What library (reuse Plotly from Visualise view)?
3. Can charts be exported?

**Clarification:**
```typescript
interface StatsTestResult {
    // ... existing fields ...
    visualizations?: Array<{
        type: 'line' | 'bar' | 'scatter' | 'histogram';
        data: PlotlyData;
        layout: PlotlyLayout;
    }>;
}
```

Stats view should embed Plotly for result charts. Can share Plotly setup with Visualise view.

---

## COMPLETENESS CHECK

### Required Components

| Component | In Plan? | Complete? |
|-----------|----------|-----------|
| Context key detection | Yes | Yes |
| RHS button rendering | Yes | Partial - need Data button behavior fix |
| DataViewManager | Mentioned | No - needs implementation |
| Resources panel webview | Yes | Yes |
| Stats catalog | Yes | Yes |
| Stats view | Yes | Partial - state machine needs work |
| Stats execution | Yes | Partial - needs EngineHost integration |
| Visualise view | Yes | Yes |
| Column detection | Mentioned | No - needs detail |
| Error handling | No | Missing |
| Build process | No | Missing |

### Flow Verification

| Flow | Described? | Correct? |
|------|------------|----------|
| Open data file → buttons appear | Yes | Yes |
| Click Visualise → view opens | Yes | Yes |
| Click Action → Resources opens | Yes | **Needs correction** |
| Click test → Stats view opens | Partially | **Needs correction** |
| Run test → results shown | Yes | Yes |
| Switch between modes | Yes | Yes |

---

## REVISED PHASE STRUCTURE

Based on audit, recommend restructuring:

### Phase 0: Foundation (2 days)
- Types for data files, stats, views
- **DataViewManager stub**
- **Build configuration for webviews**

### Phase 1: Data File Detection (2-3 days)
- Context keys
- Button rendering
- **"Action" button correct behavior (opens Resources, not Stats view)**

### Phase 2: Resources Panel (3-4 days)
- Webview with mode switcher
- Strategy tree
- Stats tree
- **Section auto-switching on Action button**

### Phase 3: Stats View Skeleton (3 days)
- Custom editor registration
- Idle state
- Configuration state
- **Integration with Resources panel (test selection trigger)**

### Phase 4: Stats Execution (4 days)
- Python scripts (use existing EngineHost)
- Running/Results states
- **Error handling**
- Result visualization

### Phase 5: Visualise View (3-4 days)
- Custom editor
- Plotly integration
- Column/chart selection
- **Share Plotly with Stats view**

### Phase 6: Integration (2-3 days)
- Commands
- Keybindings
- **Binary file "Editor" handling**
- **Column metadata detection**

### Phase 7: Excel Support (2 days)
- xlsx library
- Sheet selection UI

---

## ACTION ITEMS

### Must Fix Before Implementation

1. [ ] Correct Action button flow for data files
2. [ ] Add DataViewManager implementation details
3. [ ] Specify test selection → Stats view opening mechanism
4. [ ] Add build configuration for webviews
5. [ ] Handle binary file "Editor" view
6. [ ] Integrate StatsEngine with existing EngineHost

### Should Add

1. [ ] Column metadata detection and validation
2. [ ] Error states for all views
3. [ ] Stats result visualization details

### Nice to Have

1. [ ] Recent tests history
2. [ ] Batch test execution
3. [ ] Test dependencies/suggestions
