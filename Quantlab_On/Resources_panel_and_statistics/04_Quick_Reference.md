# Quick Reference Guide

## File Locations Summary

### Workbench Core (VS Code fork)

| Component | Path |
|-----------|------|
| Context Keys | `src/vs/workbench/browser/parts/editor/quantlabContextKeys.ts` |
| Tab Buttons | `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts` |
| View State Service | `src/vs/workbench/browser/parts/editor/quantlabViewStateService.ts` |
| Tab CSS | `src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css` |

### Extension

| Component | Path |
|-----------|------|
| View Manager | `extensions/quantlab/src/views/ViewManager.ts` |
| Action View | `extensions/quantlab/src/views/action/ActionViewProvider.ts` |
| Chart View | `extensions/quantlab/src/views/chart/ChartViewProvider.ts` |
| Resources Panel | `extensions/quantlab/src/panels/resources/ResourcesTreeProvider.ts` |
| Data Service | `extensions/quantlab/src/core/engine/DataService.ts` |
| Types | `extensions/quantlab/src/types/` |
| Commands | `extensions/quantlab/src/commands/viewCommands.ts` |
| Package Config | `extensions/quantlab/package.json` |

---

## Context Keys Reference

| Key | Type | Values | Trigger |
|-----|------|--------|---------|
| `quantlab.isStrategy` | boolean | true/false | Python file with strategy patterns |
| `quantlab.isDataFile` | boolean | true/false | xlsx/parquet/csv file |
| `quantlab.dataFileType` | string | 'xlsx'/'parquet'/'csv'/null | Extension of data file |
| `quantlab.currentView` | string | 'editor'/'chart'/'action'/'trade'/'visualise'/'stats' | Active view type |
| `quantlab.resourcesSection` | string | 'strategy'/'stats' | Resources panel mode |

---

## Commands Reference

### Existing Commands

| Command | Description | When |
|---------|-------------|------|
| `quantlab.switchToChart` | Open Chart view | `quantlab.isStrategy` |
| `quantlab.switchToAction` | Open Action view | `quantlab.isStrategy` |
| `quantlab.switchToTrade` | Open Trade view | `quantlab.isStrategy` |
| `quantlab.switchToEditor` | Return to Editor | Always |
| `quantlab.focusResourcesPanel` | Focus Resources | Always |

### New Commands (to implement)

| Command | Description | When |
|---------|-------------|------|
| `quantlab.switchToVisualise` | Open Visualise view | `quantlab.isDataFile` |
| `quantlab.switchToDataAction` | Open Stats Action view | `quantlab.isDataFile` |
| `quantlab.setResourcesSection` | Set Resources section | Always |
| `quantlab.stats.openTest` | Open stats test config | `quantlab.isDataFile` |
| `quantlab.stats.runTest` | Run stats test | In Stats view |

---

## Keybindings

### Existing

| Key | Command | When |
|-----|---------|------|
| `Ctrl+Q C` | switchToChart | `quantlab.isStrategy` |
| `Ctrl+Q A` | switchToAction | `quantlab.isStrategy` |
| `Ctrl+Q T` | switchToTrade | `quantlab.isStrategy` |
| `Ctrl+Q E` | switchToEditor | Always |
| `Ctrl+Q 2` | focusResourcesPanel | Always |

### New (to implement)

| Key | Command | When |
|-----|---------|------|
| `Ctrl+Q V` | switchToVisualise | `quantlab.isDataFile` |
| `Ctrl+Q A` | switchToDataAction | `quantlab.isDataFile` |

---

## View Types (Custom Editors)

| viewType | View | File Pattern |
|----------|------|--------------|
| `quantlab.chartView` | Chart | Strategy files |
| `quantlab.actionView` | Action | Strategy files |
| `quantlab.tradeView` | Trade | Strategy files |
| `quantlab.visualiseView` | Visualise | Data files (NEW) |
| `quantlab.statsView` | Stats | Data files (NEW) |

---

## Data Flow Diagrams

### Strategy File Flow (Existing)
```
Python file opened
      │
      ▼
quantlabContextKeys.ts
      │
      ├─► Sets quantlab.isStrategy = true
      │
      ▼
multiEditorTabsControl.ts
      │
      ├─► Renders: [Chart] [Action] [Trade]
      │
      ▼
User clicks button
      │
      ▼
ViewManager.switchView()
      │
      ├─► Validates strategy
      ├─► Opens custom editor
      └─► Updates context keys
```

### Data File Flow (New)
```
Data file opened (xlsx/parquet/csv)
      │
      ▼
quantlabContextKeys.ts
      │
      ├─► Sets quantlab.isDataFile = true
      ├─► Sets quantlab.dataFileType = 'xlsx' etc
      │
      ▼
multiEditorTabsControl.ts
      │
      ├─► Renders: [Visualise] [Action]
      │
      ▼
User clicks [Action]
      │
      ▼
Sets quantlab.resourcesSection = 'stats'
      │
      ▼
focusResourcesPanel({ section: 'stats' })
      │
      ▼
ResourcesPanelProvider shows Pure Stats tree
      │
      ▼
User clicks a test (e.g., ADF)
      │
      ▼
quantlab.stats.openTest('adf')
      │
      ▼
StatsViewProvider opens with ADF config UI
```

---

## Stats Categories Quick Reference

| Category | Tests |
|----------|-------|
| **Descriptive** | Summary Stats, Distribution Viz, Outlier Detection |
| **Stationarity** | ADF, KPSS, PP, DF-GLS, Zivot-Andrews |
| **Distribution** | Jarque-Bera, Shapiro-Wilk, Anderson-Darling, QQ |
| **Dependence** | Correlation, ACF, PACF, Ljung-Box, Granger, Cointegration |
| **Volatility** | ARCH Effects, Variance Ratio, Rolling Vol |
| **Regression** | OLS, Breusch-Pagan, White, Durbin-Watson, VIF |
| **Risk** | VaR, CVaR, Max Drawdown, Performance Ratios |

---

## CSS Variables Used

```css
/* Buttons */
--vscode-button-background
--vscode-button-foreground
--vscode-button-border

/* Lists/Trees */
--vscode-list-hoverBackground
--vscode-list-activeSelectionBackground
--vscode-list-activeSelectionForeground

/* Panel */
--vscode-sideBar-background
--vscode-panel-border

/* Icons */
--vscode-symbolIcon-methodForeground

/* Focus */
--vscode-focusBorder
```

---

## Python Dependencies for Stats

```bash
pip install statsmodels scipy pandas numpy arch empyrical
```

| Package | Version | Purpose |
|---------|---------|---------|
| statsmodels | >=0.14 | ADF, KPSS, ACF, regression diagnostics |
| scipy | >=1.11 | Shapiro-Wilk, Anderson-Darling, correlation |
| pandas | >=2.0 | Data manipulation |
| numpy | >=1.24 | Numerical operations |
| arch | >=6.0 | ARCH/GARCH, variance ratio |
| empyrical | >=0.5 | Risk metrics (optional) |

---

## Implementation Checklist

### Phase 1: Data File Detection
- [ ] Add context keys in quantlabContextKeys.ts
- [ ] Add isDataFile detection
- [ ] Update multiEditorTabsControl.ts button rendering
- [ ] Test with xlsx, parquet, csv files

### Phase 2: Resources Panel Redesign
- [ ] Create ResourcesPanelProvider.ts (webview)
- [ ] Create resources.css with mode switcher
- [ ] Create webview script for tree rendering
- [ ] Create statsCatalog.json
- [ ] Register new panel provider
- [ ] Update focusResourcesPanel command

### Phase 3: Pure Stats Content
- [ ] Complete statsCatalog.json with all tests
- [ ] Implement StatsTreeBuilder.ts
- [ ] Test tree expansion/collapse
- [ ] Test node selection/action

### Phase 4: Stats View
- [ ] Create StatsViewProvider.ts
- [ ] Create StatsWebview.ts
- [ ] Create state machine
- [ ] Implement config UI for each test
- [ ] Register custom editor

### Phase 5: Stats Engine
- [ ] Create stats_runner.py
- [ ] Implement each stats module
- [ ] Create StatsEngine.ts interface
- [ ] Test with sample data

### Phase 6: Visualise View
- [ ] Create VisualiseViewProvider.ts
- [ ] Integrate Plotly.js
- [ ] Implement chart types
- [ ] Add column/date selectors

### Phase 7: Integration
- [ ] Wire all commands
- [ ] Add keybindings
- [ ] Test full workflow
- [ ] Handle edge cases

### Phase 8: Excel Support
- [ ] Add xlsx package
- [ ] Extend DataService
- [ ] Handle multiple sheets
