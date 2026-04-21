# Prompt 18: Final Testing & Verification

## Objective
Comprehensive testing checklist to verify all components work correctly.

## Pre-flight Checks

### 1. Build Verification

```bash
# Navigate to extension
cd extensions/quantlab

# Install dependencies
npm install

# TypeScript compilation (should have no errors)
npx tsc --noEmit

# Build extension
npm run build

# Build webviews
npm run build:webview

# Install Python dependencies
cd python/stats && pip install -r requirements.txt && cd ../..
```

### 2. File Structure Verification

Verify all new files exist:

```bash
# Types
ls src/types/data.ts src/types/stats.ts

# Views
ls src/views/DataViewManager.ts
ls src/views/visualise/VisualiseViewProvider.ts
ls src/views/stats/StatsViewProvider.ts

# Panels
ls src/panels/resources/ResourcesWebviewProvider.ts

# Commands
ls src/commands/dataCommands.ts

# Stats
ls src/stats/StatsCatalog.ts src/stats/StatsEngine.ts

# Utils
ls src/utils/webview.ts

# Webviews
ls webview/resources/index.ts webview/resources/resources.css
ls webview/stats/index.ts webview/stats/stats.css
ls webview/visualise/index.ts webview/visualise/visualise.css

# Python
ls python/data/inspect_data.py
ls python/stats/runner.py python/stats/requirements.txt
ls python/stats/tests/__init__.py
```

## Functional Testing

### Test 1: Data File Detection (Context Keys)

1. Open QuantLab
2. Open a .csv file
3. Open Developer Tools (Help → Toggle Developer Tools)
4. In Console, run:
   ```javascript
   // Check context keys
   workbench.getWorkbenchState().contextKeyService.getContextKeyValue('quantlab.isDataFile')
   // Should return: true

   workbench.getWorkbenchState().contextKeyService.getContextKeyValue('quantlab.dataFileType')
   // Should return: 'csv'

   workbench.getWorkbenchState().contextKeyService.getContextKeyValue('quantlab.isStrategy')
   // Should return: false
   ```

5. Open a .py strategy file
6. Verify:
   - `quantlab.isDataFile` → false
   - `quantlab.isStrategy` → true

### Test 2: RHS Button Rendering

1. Open a .csv file
2. **Verify**: Two buttons appear on RHS of tab: [Visualise] [Action]
3. Open a .py strategy file
4. **Verify**: Three buttons appear: [Chart] [Action] [Trade]
5. Open a .txt file
6. **Verify**: No QuantLab buttons appear

### Test 3: Visualise View

1. Open a .csv file with numeric data
2. Click [Visualise] button
3. **Verify**:
   - [ ] Data table renders with columns and values
   - [ ] Column list appears in sidebar
   - [ ] Checking/unchecking columns updates the table
   - [ ] Chart type buttons work (Table, Line, Scatter, Histogram, Heatmap)
   - [ ] Line chart shows selected numeric columns
   - [ ] Scatter plot works with 2+ columns
   - [ ] Histogram shows distribution
   - [ ] Heatmap shows correlation matrix
   - [ ] Export button saves CSV

### Test 4: Resources Panel

1. Click Resources icon in Activity Bar
2. **Verify**: Panel opens with two buttons at top: "Strategy" | "Pure Stats"
3. Click "Strategy"
4. **Verify**: Shows Tests, Templates, Guides
5. Click "Pure Stats"
6. **Verify**:
   - [ ] 7 categories appear (Descriptive, Stationarity, Distribution, Dependence, Volatility, Regression, Risk)
   - [ ] Categories expand/collapse on click
   - [ ] Test items appear under each category

### Test 5: Action Button Flow

1. Open a .csv file
2. Click [Action] button on RHS
3. **Verify**:
   - [ ] Resources panel opens (or focuses if already open)
   - [ ] "Pure Stats" section is automatically selected
   - [ ] Stats categories are visible

### Test 6: Stats View

1. Open a .csv file with numeric columns
2. Click [Action] button
3. In Resources panel, click on "ADF Test" under Stationarity
4. **Verify**:
   - [ ] Stats view opens as custom editor on the data file
   - [ ] Test selector shows "ADF Test" selected
   - [ ] Column list appears with checkboxes
   - [ ] Only compatible columns (float64, int64) are enabled
   - [ ] Parameters section shows regression type and max lags
   - [ ] Run button is disabled until a column is selected

5. Select a numeric column
6. **Verify**: Run button becomes enabled
7. Click Run
8. **Verify**:
   - [ ] Running state shows with progress
   - [ ] Results appear after completion
   - [ ] Shows test statistic, p-value, critical values
   - [ ] Shows conclusion and interpretation
   - [ ] "Back to Configuration" button works

### Test 7: Stats Test Execution

1. Run ADF test on a price series
2. **Verify result contains**:
   - Test statistic (numeric)
   - p-value (between 0 and 1)
   - Critical values (1%, 5%, 10%)
   - Conclusion text
   - Interpretation text

3. Try other tests:
   - [ ] KPSS test
   - [ ] Summary Statistics
   - [ ] Normality Tests
   - [ ] Correlation Matrix (requires 2+ columns)

### Test 8: Error Handling

1. Try to run correlation test with only 1 column selected
2. **Verify**: Validation error appears

3. Open a CSV with only text columns
4. Try to run ADF test
5. **Verify**: All columns are disabled (incompatible type)

6. Open a non-existent file path (simulate error)
7. **Verify**: Error state displays with retry option

### Test 9: Tab Switching

1. Open a .csv file in Visualise view
2. Open a .py strategy in Chart view
3. Switch between tabs
4. **Verify**:
   - [ ] RHS buttons update correctly for each file type
   - [ ] Context keys update (check in DevTools)
   - [ ] Views preserve their state when switching back

### Test 10: Multiple Data Files

1. Open three different CSV files
2. Open Visualise view for each
3. **Verify**: Each maintains its own state (selected columns, chart type)

## Performance Testing

### Large File Handling

1. Open a CSV with 100,000+ rows
2. **Verify**:
   - [ ] Column info loads within 5 seconds
   - [ ] Preview (1000 rows) loads within 3 seconds
   - [ ] UI remains responsive
   - [ ] Stats tests run without hanging

### Memory Usage

1. Open 5 different data files in Visualise view
2. Monitor memory in Task Manager
3. **Verify**: Memory usage stays reasonable (< 500MB additional)

## Edge Cases

1. **Empty CSV**: Open CSV with headers but no data
   - Should show empty table, no crash

2. **Unicode columns**: CSV with special characters in column names
   - Should display correctly

3. **Missing values**: CSV with null/NaN values
   - Should show "null" in table, stats should handle gracefully

4. **Very wide file**: CSV with 100+ columns
   - Sidebar should scroll, performance acceptable

5. **Parquet file**: Open a .parquet file
   - All features should work same as CSV

6. **Excel file**: Open a .xlsx file
   - All features should work same as CSV

## Regression Testing

Ensure existing functionality still works:

1. **Strategy files**: Open .py strategy, verify Chart/Action/Trade buttons work
2. **Engine**: Run a backtest, verify it completes
3. **Data panel**: Market data panel still shows symbols
4. **Server connection**: WebSocket connection still works

## Known Limitations

Document any known limitations:

1. Parquet/XLSX files cannot be viewed as text (Editor view)
2. Stats tests require Python with statsmodels/arch installed
3. Large files (>1M rows) may be slow
4. Correlation matrix limited to ~20 columns for readability

## Sign-off Checklist

- [ ] All builds pass without errors
- [ ] All 10 functional tests pass
- [ ] Performance is acceptable
- [ ] Edge cases handled gracefully
- [ ] No regressions in existing functionality
- [ ] Documentation updated (if applicable)

## Troubleshooting

### Common Issues

1. **Buttons don't appear**
   - Check context keys in DevTools
   - Verify `multiEditorTabsControl.ts` modifications
   - Check `quantlabContextKeys.ts` is detecting files

2. **Webview shows blank**
   - Check Console for JavaScript errors
   - Verify webview build completed
   - Check CSP (Content Security Policy) in HTML

3. **Stats test fails**
   - Check Python is in PATH
   - Verify requirements installed
   - Check Python script paths

4. **Resources panel empty**
   - Verify WebviewViewProvider registration
   - Check package.json view configuration
   - Look for errors in Output panel

### Debug Commands

```javascript
// In Extension Host DevTools
vscode.commands.getCommands().then(c => c.filter(x => x.includes('quantlab')))

// Check registered providers
vscode.extensions.getExtension('quantlab').exports
```
