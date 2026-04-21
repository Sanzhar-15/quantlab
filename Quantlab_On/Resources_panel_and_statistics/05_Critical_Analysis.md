# Critical Analysis & Optimizations

This document identifies potential issues, edge cases, and optimizations for the implementation.

---

## 1. Potential Issues & Mitigations

### Issue 1: Context Key Conflicts

**Problem**: A file could theoretically be both a strategy and reference data (e.g., a Python file that reads a CSV).

**Analysis**: The current detection is mutually exclusive:
- `isStrategy` = Python file with strategy patterns
- `isDataFile` = xlsx/parquet/csv extension

**Mitigation**: These are already mutually exclusive by design (different extensions). However, when a strategy file is open AND it references a data file, the user may want to visualize that data.

**Solution**: Consider adding a command `quantlab.visualiseData` that can be invoked from within a strategy context to visualize its data source.

---

### Issue 2: Large File Performance

**Problem**: Opening large xlsx/parquet files (100MB+) could freeze the UI.

**Mitigations**:
1. **Lazy loading**: Only load metadata initially (row count, column names)
2. **Streaming**: Use streaming parsers where possible
3. **Row limits**: Default to loading first N rows (configurable)
4. **Progress indicators**: Show loading state in buttons and panels
5. **Caching**: Cache loaded data to avoid re-parsing

**Implementation**:
```typescript
// DataService.ts
async getDataFileInfo(filePath: string): Promise<DataFileInfo> {
    const ext = path.extname(filePath).toLowerCase();

    // Quick metadata extraction without loading full file
    if (ext === '.parquet') {
        const metadata = await this.getParquetMetadata(filePath);
        return {
            columns: metadata.schema.fields.map(f => f.name),
            rowCount: metadata.numRows,
            // Don't load actual data yet
        };
    }
    // ...
}
```

---

### Issue 3: Stats Test Execution Time

**Problem**: Some statistical tests (e.g., Johansen cointegration, Monte Carlo VaR) can take minutes on large datasets.

**Mitigations**:
1. **Progress reporting**: Python scripts emit progress events
2. **Cancellation**: Support cancellation via jobId
3. **Timeout**: Configurable timeout per test type
4. **Sampling**: Option to run on sample of data for quick preview

**Implementation Pattern** (already exists in EngineHost):
```typescript
// Use existing EngineHost pattern
const job = await this.engineHost.runJob({
    jobId: runId,
    action: 'stats',
    config: { testId: 'adf', ... }
});

// Progress events already supported
this.engineHost.onDidEmit(event => {
    if (event.type === 'progress') {
        // Update UI
    }
});
```

---

### Issue 4: Resources Panel State Persistence

**Problem**: User switches to Pure Stats, closes VS Code, reopens - should remember the section.

**Solution**: Already addressed in plan - use `globalState` to persist section preference.

**Additional Consideration**: Per-workspace vs global preference?
- **Recommendation**: Use global state (user preference), not workspace state
- Rationale: Statistical tools preference is user-specific, not project-specific

---

### Issue 5: Multiple Data Files Open

**Problem**: User has multiple data files open in tabs. Which one does the Stats view operate on?

**Analysis**: Same pattern as current strategy system - operates on the **active document**.

**Implementation**:
- Stats view should track which data file it's associated with
- If user switches to a different data file tab, Stats view should update
- Consider showing data file path in Stats view header for clarity

---

## 2. Architectural Optimizations

### Optimization 1: Shared Webview Infrastructure

**Current State**: ActionViewProvider, ChartViewProvider each have their own webview setup.

**Opportunity**: Create shared base classes:
```typescript
abstract class QuantlabWebviewProvider implements vscode.CustomTextEditorProvider {
    protected abstract buildHtml(): string;
    protected abstract handleMessage(message: unknown): void;

    // Shared: CSP setup, theme integration, message routing
}
```

**Benefit**: Reduce code duplication, ensure consistency.

---

### Optimization 2: Stats Result Caching

**Problem**: User runs ADF test, switches to another test, comes back - has to re-run.

**Solution**: Cache results per (dataFile, testId, params) tuple.

```typescript
interface StatsCacheKey {
    dataPath: string;
    dataHash: string;  // Hash of relevant data columns
    testId: string;
    paramsHash: string;
}

class StatsResultCache {
    private cache = new Map<string, StatsTestResult>();
    private maxSize = 50;

    get(key: StatsCacheKey): StatsTestResult | undefined;
    set(key: StatsCacheKey, result: StatsTestResult): void;
}
```

---

### Optimization 3: Batch Test Execution

**Use Case**: User wants to run all stationarity tests at once.

**Implementation**: Add "Run All" button per category:
```typescript
// Stats catalog extension
{
  "id": "stationarity",
  "label": "Stationarity",
  "batchRunnable": true,  // <-- New flag
  "tests": [...]
}
```

---

### Optimization 4: Test Dependencies

**Some tests have logical dependencies**:
- Run ADF before KPSS (for confirmation)
- Run summary stats before distribution tests
- Run stationarity tests before time series tests

**Implementation**: Add optional dependencies in catalog:
```json
{
  "id": "kpss",
  "label": "KPSS Test",
  "suggestedAfter": ["adf"],  // Suggestion, not requirement
  "description": "..."
}
```

---

## 3. UX Considerations

### Consideration 1: Test Result Interpretation

**Problem**: Users may not know how to interpret statistical results.

**Solutions**:
1. **Conclusion text**: Always include human-readable conclusion
2. **Tooltips**: Explain what the numbers mean
3. **Color coding**: Green = pass assumption, Red = reject, Yellow = borderline
4. **Learn more links**: Link to documentation for each test

**Example Result UI**:
```
┌─────────────────────────────────────────────────┐
│ Augmented Dickey-Fuller Test                    │
├─────────────────────────────────────────────────┤
│ Test Statistic: -3.452                          │
│ P-Value:        0.0091  [?]                     │
│                                                 │
│ Critical Values:                                │
│   1%:  -3.43  ──────────│────                   │
│   5%:  -2.86  ─────│────│────                   │
│   10%: -2.57  ───│─│────│────                   │
│                  ↑ Your value                   │
│                                                 │
│ ┌───────────────────────────────────────────┐  │
│ │ ✓ Conclusion: Reject null hypothesis      │  │
│ │   The series appears to be stationary     │  │
│ │   at the 5% significance level.           │  │
│ └───────────────────────────────────────────┘  │
│                                                 │
│ [Learn More]  [Export]  [Run Again]             │
└─────────────────────────────────────────────────┘
```

---

### Consideration 2: Parameter Defaults

**Problem**: Many tests have complex parameters (lags, regression types, etc.).

**Solution**: Smart defaults + presets:
```json
{
  "id": "adf",
  "presets": [
    { "name": "Quick (auto lags)", "params": { "maxlag": null, "regression": "c" } },
    { "name": "With trend", "params": { "maxlag": null, "regression": "ct" } },
    { "name": "Custom", "params": null }
  ]
}
```

---

### Consideration 3: Visualization Integration

**Opportunity**: Some stats tests benefit from visualizations:
- ACF/PACF → Correlogram plot
- QQ Analysis → QQ plot
- Distribution → Histogram overlay
- Stationarity → Time series plot with trend

**Implementation**: Stats results can include visualization data that renders in the same view.

---

## 4. Edge Cases

### Edge Case 1: Empty Data File
- **Scenario**: User opens empty CSV
- **Handling**: Show helpful message, disable tests

### Edge Case 2: Non-numeric Columns
- **Scenario**: Data has categorical columns
- **Handling**: Filter column selector to numeric only for most tests

### Edge Case 3: Date/Time Column Detection
- **Scenario**: Need to identify which column is the time index
- **Handling**: Auto-detect common patterns (date, datetime, timestamp), allow manual selection

### Edge Case 4: Missing Values
- **Scenario**: Data has NaN/null values
- **Handling**:
  - Show warning in UI
  - Offer options: drop, fill forward, fill mean
  - Some tests handle NaN natively

### Edge Case 5: Different Data Encodings
- **Scenario**: CSV with non-UTF8 encoding
- **Handling**: Try common encodings, show error if fails

---

## 5. Future Enhancements (Out of Scope)

These are not part of the current implementation but worth noting:

1. **Custom Test Scripts**: Let users write Python scripts that integrate into the stats menu
2. **Test History**: Track which tests have been run on which files
3. **Comparison Mode**: Run same test on multiple files side-by-side
4. **Report Generation**: Export all test results as PDF/HTML report
5. **Scheduling**: Run tests automatically when data file changes
6. **Remote Data Sources**: Support fetching data from APIs, databases

---

## 6. Risk Assessment Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Large file freeze | Medium | High | Lazy loading, progress UI |
| Test execution timeout | Medium | Medium | Configurable timeout, cancellation |
| Python dependency issues | Low | High | Bundle dependencies, version pinning |
| Webview rendering issues | Low | Medium | Test across themes, fallback styles |
| Context key race conditions | Low | Medium | Debounce updates (already done) |
| Stats result accuracy | Low | High | Use well-tested libraries, add unit tests |

---

## 7. Success Metrics

Post-implementation, track:

1. **Adoption**: % of users who use Pure Stats features
2. **Completion**: % of test runs that complete successfully
3. **Performance**: Average time to render results
4. **Errors**: Frequency and types of errors
5. **Feature requests**: What additional tests users ask for

---

## 8. Recommended Implementation Order

Based on dependencies and risk:

1. **Phase 1 (Foundation)** - Must be stable before anything else
2. **Phase 2 (Resources Panel)** - Core UX, blocks other phases
3. **Phase 3 (Stats Content)** - Populates the panel
4. **Phase 4 (Stats View)** - Where users spend time
5. **Phase 5 (Stats Engine)** - Can be stubbed initially
6. **Phase 6 (Visualise)** - Independent, can be parallel
7. **Phase 7 (Integration)** - Final polish
8. **Phase 8 (Excel)** - Enhancement, can be deferred

**Recommendation**: Implement Phases 1-4 as MVP, then iterate.
