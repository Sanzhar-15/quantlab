# Resources Panel & Statistics System - Master Implementation Plan

## Executive Summary

This document outlines the implementation of a **parallel button system for data files** (xlsx, parquet, csv) alongside the existing strategy-file system, plus a **redesigned Resources panel** with a horizontal mode-switcher between "Strategy" and "Pure Stats" sections.

---

## 1. Current Architecture Analysis

### 1.1 Existing RHS Button System (Strategy Files)

| Component | Location | Purpose |
|-----------|----------|---------|
| Button Rendering | `multiEditorTabsControl.ts:236-327` | Creates/updates buttons based on context |
| Context Keys | `quantlabContextKeys.ts` | Detects `quantlab.isStrategy` and `quantlab.currentView` |
| File Detection | `quantlabContextKeys.ts:148-155` | Regex patterns for strategy code |
| View Manager | `ViewManager.ts` | Handles view switching, validation, toasts |
| Action View | `ActionViewProvider.ts` | Webview for backtest configuration |

### 1.2 Current Resources Panel

| Component | Location | Purpose |
|-----------|----------|---------|
| Tree Provider | `ResourcesTreeProvider.ts` | Single tree with Tests, Templates, Guides |
| Catalog | `resourcesCatalog.json` | Static list of resources |
| Panel Registration | `package.json:377-404` | Activity bar view container |

---

## 2. Target Architecture

### 2.1 New Context Key System

```
quantlab.isStrategy         (existing) - true for Python strategy files
quantlab.isDataFile         (new)      - true for xlsx/parquet/csv files
quantlab.dataFileType       (new)      - 'xlsx' | 'parquet' | 'csv' | null
quantlab.currentView        (existing) - 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats'
quantlab.resourcesSection   (new)      - 'strategy' | 'stats'
```

### 2.2 RHS Button Mapping

| Active File Type | RHS Buttons | Behavior |
|------------------|-------------|----------|
| Python Strategy | Chart, Action, Trade | Existing behavior |
| Data File (xlsx/parquet/csv) | Visualise, Action | New behavior |
| Other files | None (or disabled) | No special views |

### 2.3 Resources Panel Redesign

```
┌─────────────────────────────────────┐
│  ┌─────────────┐ ┌─────────────┐    │  ← Horizontal button bar
│  │  Strategy   │ │ Pure Stats  │    │    (toggles content below)
│  └─────────────┘ └─────────────┘    │
├─────────────────────────────────────┤
│                                     │
│  [Content based on selected mode]   │
│                                     │
│  Strategy Mode:                     │
│    ▶ Tests                          │
│    ▶ Templates                      │
│    ▶ Guides                         │
│                                     │
│  Pure Stats Mode:                   │
│    ▶ Descriptive                    │
│    ▶ Stationarity                   │
│    ▶ Distribution                   │
│    ▶ Dependence                     │
│    ▶ Volatility                     │
│    ▶ Regression                     │
│    ▶ Risk Metrics                   │
│                                     │
└─────────────────────────────────────┘
```

---

## 3. Pure Stats Categories (Optimized)

After deep consideration of quant/econometrician workflows:

### Category Structure

```
Pure Stats
│
├── Descriptive
│   ├── Summary Statistics (mean, std, skew, kurtosis, percentiles)
│   ├── Distribution Visualization (histogram, KDE)
│   ├── Outlier Detection (IQR, Z-score, Isolation Forest)
│   └── Missing Data Analysis
│
├── Stationarity
│   ├── Augmented Dickey-Fuller (ADF)
│   ├── KPSS Test
│   ├── Phillips-Perron (PP)
│   ├── DF-GLS Test
│   └── Zivot-Andrews (structural breaks)
│
├── Distribution
│   ├── Jarque-Bera Test
│   ├── Shapiro-Wilk Test
│   ├── Anderson-Darling Test
│   ├── Kolmogorov-Smirnov Test
│   └── QQ Plot Analysis
│
├── Dependence
│   ├── Correlation Matrix (Pearson, Spearman, Kendall)
│   ├── Autocorrelation (ACF)
│   ├── Partial Autocorrelation (PACF)
│   ├── Ljung-Box Test
│   ├── Granger Causality
│   └── Cointegration (Engle-Granger, Johansen)
│
├── Volatility
│   ├── ARCH Effects Test (Engle's LM)
│   ├── GARCH Fit Assessment
│   ├── Variance Ratio Test
│   └── Rolling Volatility Analysis
│
├── Regression
│   ├── OLS Summary
│   ├── Breusch-Pagan (heteroskedasticity)
│   ├── White Test (heteroskedasticity)
│   ├── Durbin-Watson (autocorrelation)
│   ├── VIF (multicollinearity)
│   └── Ramsey RESET (misspecification)
│
└── Risk Metrics
    ├── Value at Risk (Historical, Parametric, Monte Carlo)
    ├── Expected Shortfall (CVaR)
    ├── Maximum Drawdown Analysis
    ├── Sharpe / Sortino / Calmar Ratios
    └── Beta / Alpha Calculation
```

### Rationale for Categories

1. **Descriptive** - First step in any analysis; understand the data
2. **Stationarity** - Critical for time series; most models assume stationarity
3. **Distribution** - Validates normality assumptions for parametric tests
4. **Dependence** - Both cross-sectional (correlation) and time-series (ACF/PACF)
5. **Volatility** - Essential for financial data; ARCH/GARCH effects common
6. **Regression** - Diagnostic tests for regression-based strategies
7. **Risk Metrics** - Portfolio/strategy risk assessment

---

## 4. Implementation Phases

### Phase 0: Foundation & Types (1-2 days)

**Objective**: Establish type system and interfaces for data files and stats.

**Files to Create/Modify**:
- `types/data.ts` - Data file types and interfaces
- `types/stats.ts` - Statistical test types, configs, results
- `types/views.ts` - Add new view types ('visualise', 'stats')

**Key Types**:
```typescript
// types/data.ts
export type DataFileType = 'xlsx' | 'parquet' | 'csv';

export interface DataFileInfo {
  path: string;
  type: DataFileType;
  columns?: string[];
  rowCount?: number;
  dateRange?: { start: Date; end: Date };
}

// types/stats.ts
export type StatsCategory =
  | 'descriptive'
  | 'stationarity'
  | 'distribution'
  | 'dependence'
  | 'volatility'
  | 'regression'
  | 'risk';

export interface StatsTestConfig {
  testId: string;
  category: StatsCategory;
  parameters: Record<string, unknown>;
  dataSource: string;
  columns: string[];
}

export interface StatsTestResult {
  testId: string;
  testName: string;
  statistic: number;
  pValue: number;
  conclusion: string;
  details: Record<string, unknown>;
  visualizations?: StatsVisualization[];
}
```

---

### Phase 1: Data File Detection (2-3 days)

**Objective**: Detect data files and set context keys.

**Files to Modify**:
- `quantlabContextKeys.ts` - Add data file detection
- `multiEditorTabsControl.ts` - Add conditional button rendering

**Implementation Details**:

1. **Add context keys** in `quantlabContextKeys.ts`:
```typescript
const QUANTLAB_IS_DATA_FILE = new RawContextKey<boolean>('quantlab.isDataFile', false);
const QUANTLAB_DATA_FILE_TYPE = new RawContextKey<string | null>('quantlab.dataFileType', null);

// In QuantlabContextKeyController
private readonly isDataFileKey = QUANTLAB_IS_DATA_FILE.bindTo(this.contextKeyService);
private readonly dataFileTypeKey = QUANTLAB_DATA_FILE_TYPE.bindTo(this.contextKeyService);

private isDataFile(resource: URI): boolean {
  const ext = resource.path.toLowerCase();
  return ext.endsWith('.xlsx') || ext.endsWith('.parquet') || ext.endsWith('.csv');
}

private getDataFileType(resource: URI): DataFileType | null {
  const ext = resource.path.toLowerCase();
  if (ext.endsWith('.xlsx')) return 'xlsx';
  if (ext.endsWith('.parquet')) return 'parquet';
  if (ext.endsWith('.csv')) return 'csv';
  return null;
}
```

2. **Update button rendering** in `multiEditorTabsControl.ts`:
```typescript
private updateQuantlabActions(): void {
  // ... existing setup ...

  const isStrategy = this.isQuantlabStrategy();
  const isDataFile = this.isQuantlabDataFile();

  if (isStrategy) {
    // Render: Chart, Action, Trade (existing)
    for (const view of this.getQuantlabButtonOrder(currentView)) {
      this.renderButton(view, disposables);
    }
  } else if (isDataFile) {
    // Render: Visualise, Action (new)
    for (const view of this.getDataFileButtonOrder(currentView)) {
      this.renderDataButton(view, disposables);
    }
  }
}

private getDataFileButtonOrder(currentView: QuantlabViewType): DataViewType[] {
  switch (currentView) {
    case 'visualise':
      return ['editor', 'action'];
    case 'action':
      return ['visualise', 'editor'];
    default:
      return ['visualise', 'action'];
  }
}
```

---

### Phase 2: Resources Panel Redesign (3-4 days)

**Objective**: Add horizontal mode switcher to Resources panel.

**Files to Create/Modify**:
- `panels/resources/ResourcesPanelProvider.ts` - New webview-based panel
- `panels/resources/ResourcesWebview.ts` - Webview logic
- `panels/resources/html/resources.html` - Panel HTML template
- `panels/resources/css/resources.css` - Panel styling
- `panels/resources/StatsCatalog.ts` - Stats tree data

**Implementation Details**:

The Resources panel needs to change from a simple TreeDataProvider to a **Webview-based panel** to support the horizontal button bar UI. This follows the same pattern as ActionViewProvider.

**Panel Structure**:
```html
<div class="resources-panel">
  <div class="mode-switcher">
    <button class="mode-btn active" data-mode="strategy">Strategy</button>
    <button class="mode-btn" data-mode="stats">Pure Stats</button>
  </div>
  <div class="panel-content">
    <!-- Tree view rendered here based on mode -->
  </div>
</div>
```

**CSS for Mode Switcher**:
```css
.mode-switcher {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}

.mode-btn {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--vscode-button-border);
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 12px;
}

.mode-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
```

**State Management**:
- Store selected mode in extension global state
- When "Action" button is clicked on a data file, set mode to 'stats' before focusing panel
- Command: `quantlab.focusResourcesPanel` should accept optional `{ section: 'strategy' | 'stats' }`

---

### Phase 3: Pure Stats Tree Content (2-3 days)

**Objective**: Implement the stats category tree with all tests.

**Files to Create**:
- `panels/resources/statsCatalog.json` - Stats test definitions
- `panels/resources/StatsTreeBuilder.ts` - Builds tree from catalog

**Catalog Structure** (`statsCatalog.json`):
```json
{
  "categories": [
    {
      "id": "descriptive",
      "label": "Descriptive",
      "icon": "graph",
      "tests": [
        {
          "id": "summary-stats",
          "label": "Summary Statistics",
          "description": "Mean, std, skew, kurtosis, percentiles",
          "parameters": [
            { "id": "percentiles", "type": "array", "default": [0.25, 0.5, 0.75] }
          ]
        },
        {
          "id": "distribution-viz",
          "label": "Distribution Visualization",
          "description": "Histogram and KDE plots"
        },
        {
          "id": "outlier-detection",
          "label": "Outlier Detection",
          "description": "IQR, Z-score, Isolation Forest methods",
          "parameters": [
            { "id": "method", "type": "select", "options": ["iqr", "zscore", "isolation_forest"], "default": "iqr" },
            { "id": "threshold", "type": "number", "default": 1.5 }
          ]
        }
      ]
    },
    {
      "id": "stationarity",
      "label": "Stationarity",
      "icon": "pulse",
      "tests": [
        {
          "id": "adf",
          "label": "Augmented Dickey-Fuller",
          "description": "Test for unit root / stationarity",
          "parameters": [
            { "id": "maxlag", "type": "number", "default": null, "label": "Max Lag (auto if null)" },
            { "id": "regression", "type": "select", "options": ["c", "ct", "ctt", "n"], "default": "c", "label": "Regression Type" }
          ]
        },
        {
          "id": "kpss",
          "label": "KPSS Test",
          "description": "Kwiatkowski-Phillips-Schmidt-Shin test",
          "parameters": [
            { "id": "regression", "type": "select", "options": ["c", "ct"], "default": "c" },
            { "id": "nlags", "type": "select", "options": ["auto", "legacy"], "default": "auto" }
          ]
        }
        // ... more tests
      ]
    }
    // ... more categories
  ]
}
```

---

### Phase 4: Stats Action View (4-5 days)

**Objective**: Create the webview for configuring and running statistical tests.

**Files to Create**:
- `views/stats/StatsViewProvider.ts` - Main custom editor provider
- `views/stats/StatsWebview.ts` - Webview communication
- `views/stats/StatsStateMachine.ts` - State management
- `views/stats/html/stats.html` - View template
- `views/stats/css/stats.css` - View styling

**State Machine States**:
```typescript
type StatsState =
  | StatsSelectionState      // Initial: show categories/tests tree
  | StatsConfigurationState  // Configure test parameters
  | StatsRunningState        // Test is executing
  | StatsResultsState        // Show results with visualizations
```

**View Layout**:
```
┌─────────────────────────────────────────────────────────────────┐
│ Stats Action View                                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Augmented Dickey-Fuller Test                            │   │
│  │                                                          │   │
│  │ Data Column: [Close ▼]                                   │   │
│  │                                                          │   │
│  │ Max Lag:     [Auto ▼]                                    │   │
│  │                                                          │   │
│  │ Regression:  [Constant ▼]                                │   │
│  │              ○ None (n)                                  │   │
│  │              ● Constant (c)                              │   │
│  │              ○ Constant + Trend (ct)                     │   │
│  │              ○ Constant + Trend + Trend² (ctt)           │   │
│  │                                                          │   │
│  │                               [Run Test]                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Results                                                  │   │
│  │                                                          │   │
│  │ Test Statistic: -3.452                                   │   │
│  │ P-Value:        0.0091                                   │   │
│  │ Critical Values:                                         │   │
│  │   1%: -3.43   5%: -2.86   10%: -2.57                     │   │
│  │                                                          │   │
│  │ Conclusion: ✓ Reject H₀ at 5% level                      │   │
│  │             Series is likely stationary                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Integration with ViewManager**:
- Add `'stats'` to `ViewType` union
- Add `quantlab.statsView` to custom editors in `package.json`
- Register command `quantlab.switchToStats`

---

### Phase 5: Stats Execution Engine (3-4 days)

**Objective**: Python backend for executing statistical tests.

**Files to Create**:
- `python/stats_runner.py` - Main stats execution script
- `python/stats/` - Module with test implementations
- `core/engine/StatsEngine.ts` - TypeScript interface to Python

**Python Module Structure**:
```
python/stats/
├── __init__.py
├── descriptive.py      # Summary stats, outliers
├── stationarity.py     # ADF, KPSS, PP, etc.
├── distribution.py     # Normality tests
├── dependence.py       # Correlation, ACF, Granger
├── volatility.py       # ARCH, GARCH
├── regression.py       # OLS diagnostics
└── risk.py             # VaR, CVaR, drawdown
```

**Example Implementation** (`stationarity.py`):
```python
from statsmodels.tsa.stattools import adfuller, kpss
import pandas as pd
import json

def run_adf(data: pd.Series, maxlag=None, regression='c'):
    """Run Augmented Dickey-Fuller test."""
    result = adfuller(data, maxlag=maxlag, regression=regression)

    return {
        'testId': 'adf',
        'testName': 'Augmented Dickey-Fuller',
        'statistic': float(result[0]),
        'pValue': float(result[1]),
        'usedLag': int(result[2]),
        'nObs': int(result[3]),
        'criticalValues': {
            '1%': float(result[4]['1%']),
            '5%': float(result[4]['5%']),
            '10%': float(result[4]['10%'])
        },
        'conclusion': 'Stationary' if result[1] < 0.05 else 'Non-stationary'
    }
```

**StatsEngine.ts Interface**:
```typescript
export class StatsEngine {
  async runTest(config: StatsTestConfig): Promise<StatsTestResult> {
    const request = {
      testId: config.testId,
      dataPath: config.dataSource,
      columns: config.columns,
      parameters: config.parameters
    };

    return this.executeInPython('stats_runner.py', request);
  }
}
```

---

### Phase 6: Visualise View (3-4 days)

**Objective**: Data visualization webview for exploring data files.

**Files to Create**:
- `views/visualise/VisualiseViewProvider.ts`
- `views/visualise/VisualiseWebview.ts`
- `views/visualise/html/visualise.html`
- `views/visualise/css/visualise.css`

**Visualization Engine**: Use **Plotly.js** for:
- Line charts (time series)
- Histograms
- Scatter plots
- Heatmaps (correlation matrix)
- Box plots
- Candlestick (if OHLCV data detected)

**View Features**:
1. **Column selector** - Choose which columns to visualize
2. **Chart type** - Auto-detect or manual selection
3. **Date range** - Filter by date range
4. **Interactive** - Pan, zoom, hover tooltips
5. **Export** - Save as PNG/SVG

**Layout**:
```
┌─────────────────────────────────────────────────────────────────┐
│ Visualise View                                    [Export ▼]    │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│ │ Column      │ │ Chart Type  │ │ Date Range  │                │
│ │ [Close ▼]   │ │ [Line ▼]    │ │ [All ▼]     │                │
│ └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                    ┌───────────────────────┐                    │
│                    │                       │                    │
│                    │   [Plotly Chart]      │                    │
│                    │                       │                    │
│                    │                       │                    │
│                    └───────────────────────┘                    │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Summary: 1,234 rows | 2020-01-01 to 2023-12-31 | No nulls      │
└─────────────────────────────────────────────────────────────────┘
```

---

### Phase 7: Integration & Commands (2-3 days)

**Objective**: Wire everything together with commands and keybindings.

**Commands to Register**:
```typescript
// View switching
'quantlab.switchToVisualise'   // Data file → Visualise view
'quantlab.switchToStats'       // Data file → Stats view (reuse Action concept)

// Resources panel
'quantlab.focusResourcesPanel' // Focus with optional section param
'quantlab.setResourcesSection' // Switch between Strategy/Stats

// Stats tests
'quantlab.stats.runTest'       // Run a specific test
'quantlab.stats.openTest'      // Open test configuration
```

**Keybindings** (add to `package.json`):
```json
{
  "key": "ctrl+q v",
  "command": "quantlab.switchToVisualise",
  "when": "quantlab.isDataFile"
},
{
  "key": "ctrl+q a",
  "command": "quantlab.switchToStats",
  "when": "quantlab.isDataFile"
}
```

**Action Button Behavior**:
When user clicks "Action" on a data file:
1. Set context `quantlab.resourcesSection` to `'stats'`
2. Execute `quantlab.focusResourcesPanel`
3. Resources panel shows with Pure Stats mode active

---

### Phase 8: Excel (xlsx) Support (2-3 days)

**Objective**: Add xlsx file reading capability.

**Implementation**:
- Use **SheetJS (xlsx)** library for parsing
- Extend `DataService.ts` with `loadXlsxFile()` method
- Handle multiple sheets - let user select which sheet to use

**DataService Extension**:
```typescript
async loadXlsxFile(filePath: string, sheetName?: string): Promise<DataFrame> {
  const workbook = XLSX.readFile(filePath);
  const sheet = sheetName ?? workbook.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);
  return this.normalizeDataFrame(data);
}
```

---

## 5. File Inventory

### New Files to Create

| Path | Purpose |
|------|---------|
| `types/data.ts` | Data file type definitions |
| `types/stats.ts` | Stats test types and interfaces |
| `panels/resources/ResourcesPanelProvider.ts` | Webview-based Resources panel |
| `panels/resources/ResourcesWebview.ts` | Webview communication handler |
| `panels/resources/statsCatalog.json` | Stats test catalog |
| `panels/resources/StatsTreeBuilder.ts` | Tree builder for stats |
| `views/stats/StatsViewProvider.ts` | Stats custom editor |
| `views/stats/StatsWebview.ts` | Stats view webview |
| `views/stats/StatsStateMachine.ts` | Stats state management |
| `views/visualise/VisualiseViewProvider.ts` | Visualise custom editor |
| `views/visualise/VisualiseWebview.ts` | Visualise view webview |
| `core/engine/StatsEngine.ts` | Python stats interface |
| `python/stats_runner.py` | Stats execution entry point |
| `python/stats/*.py` | Individual test implementations |

### Files to Modify

| Path | Changes |
|------|---------|
| `quantlabContextKeys.ts` | Add data file detection |
| `multiEditorTabsControl.ts` | Add data file buttons |
| `ViewManager.ts` | Add visualise/stats view handling |
| `DataService.ts` | Add xlsx support |
| `package.json` | Register new views, commands, keybindings |
| `extension.ts` | Register new providers |

---

## 6. Dependencies

### NPM Packages

| Package | Purpose | Location |
|---------|---------|----------|
| `xlsx` | Excel file parsing | Extension |
| `plotly.js-dist-min` | Data visualization | Webview |

### Python Packages

| Package | Purpose |
|---------|---------|
| `statsmodels` | Statistical tests (ADF, KPSS, etc.) |
| `scipy` | Distribution tests, correlation |
| `pandas` | Data manipulation |
| `numpy` | Numerical operations |
| `arch` | ARCH/GARCH models |

---

## 7. Testing Strategy

### Unit Tests
- Context key detection for data files
- Stats catalog parsing
- Test parameter validation

### Integration Tests
- View switching between editor/visualise/stats
- Resources panel mode switching
- Stats test execution end-to-end

### Manual Testing Checklist
- [ ] Open xlsx file → see Visualise/Action buttons
- [ ] Open parquet file → see Visualise/Action buttons
- [ ] Open csv file → see Visualise/Action buttons
- [ ] Click Visualise → opens data visualization view
- [ ] Click Action → opens Resources panel with Pure Stats selected
- [ ] Click test in Pure Stats → opens Stats view with test config
- [ ] Run ADF test → see results with correct statistics
- [ ] Switch between Strategy/Pure Stats modes

---

## 8. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Resources panel redesign complexity | Use webview like ActionView - proven pattern |
| Python stats execution performance | Cache results, show progress, allow cancellation |
| xlsx large file handling | Stream parsing, row limits, progress indicators |
| Context key conflicts | Careful scoping - `isDataFile` vs `isStrategy` mutually exclusive |

---

## 9. Success Criteria

1. **Data file detection works** - Context keys set correctly for xlsx/parquet/csv
2. **RHS buttons appear** - Visualise and Action buttons show for data files
3. **Resources panel has mode switcher** - Horizontal buttons at top work
4. **Pure Stats tree is complete** - All 7 categories with tests
5. **Stats tests execute** - At least ADF, KPSS, and Summary Stats work
6. **Visualise view renders** - Basic line chart and histogram work
7. **Integration is seamless** - Clicking Action on data file opens Pure Stats

---

## 10. Phase Timeline Summary

| Phase | Description | Estimated Effort |
|-------|-------------|------------------|
| 0 | Foundation & Types | 1-2 days |
| 1 | Data File Detection | 2-3 days |
| 2 | Resources Panel Redesign | 3-4 days |
| 3 | Pure Stats Tree Content | 2-3 days |
| 4 | Stats Action View | 4-5 days |
| 5 | Stats Execution Engine | 3-4 days |
| 6 | Visualise View | 3-4 days |
| 7 | Integration & Commands | 2-3 days |
| 8 | Excel Support | 2-3 days |
| **Total** | | **22-31 days** |

---

## Appendix A: Full Stats Test Reference

See `01_Stats_Tests_Reference.md` for detailed documentation of all statistical tests including:
- Mathematical formulas
- Interpretation guidelines
- Parameter options
- Example outputs
