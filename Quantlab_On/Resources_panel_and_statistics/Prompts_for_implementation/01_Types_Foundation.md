# Prompt 01: Types Foundation

## Objective
Create the TypeScript type definitions for data files and statistical tests.

## Context
QuantLab is adding support for data file analysis (CSV, Parquet, XLSX) with statistical tests. This prompt creates the foundational types.

## Files to Create

### 1. `extensions/quantlab/src/types/data.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Data file type definitions for QuantLab statistics feature
 *--------------------------------------------------------------------------------------------*/

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

export function isDataFileExtension(ext: string): ext is DataFileType {
    return ext === 'csv' || ext === 'parquet' || ext === 'xlsx';
}

export function getDataFileType(filePath: string): DataFileType | null {
    const ext = filePath.toLowerCase().split('.').pop();
    if (ext && isDataFileExtension(ext)) {
        return ext;
    }
    return null;
}
```

### 2. `extensions/quantlab/src/types/stats.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Statistical test type definitions for QuantLab
 *--------------------------------------------------------------------------------------------*/

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
    type: 'number' | 'select' | 'boolean' | 'array';
    default: unknown;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    description?: string;
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
    data: unknown;
    layout?: unknown;
}

// State types for Stats view
export type StatsState =
    | StatsIdleState
    | StatsConfigurationState
    | StatsRunningState
    | StatsResultsState
    | StatsErrorState;

export interface StatsIdleState {
    type: 'idle';
    dataFile: string;
}

export interface StatsConfigurationState {
    type: 'configuration';
    testId: string;
    testName: string;
    dataFile: string;
    columns: Array<{ name: string; dtype: string }>;
    selectedColumns: string[];
    parameters: Record<string, unknown>;
    schema: StatsTestDefinition;
    validation?: { isValid: boolean; errors: string[] };
}

export interface StatsRunningState {
    type: 'running';
    testId: string;
    testName: string;
    progress: number;
    message: string;
    startedAt: string;
}

export interface StatsResultsState {
    type: 'results';
    testId: string;
    result: StatsTestResult;
    durationMs: number;
}

export interface StatsErrorState {
    type: 'error';
    testId: string;
    error: string;
    recoverable: boolean;
}
```

## Files to Modify

### 3. `extensions/quantlab/src/types/views.ts`

Add to existing ViewType:

```typescript
// Change from:
export type ViewType = 'editor' | 'chart' | 'action' | 'trade';

// To:
export type ViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

// Add new type for data file views
// NOTE: 'action' is NOT a view - it's a button that opens the Resources panel
// The actual views for data files are: editor, visualise, stats
export type DataViewType = 'editor' | 'visualise' | 'stats';
```

### 4. `extensions/quantlab/src/types/engine.ts`

Add after existing types:

```typescript
// Stats job request (different from strategy JobRequest)
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
        title: string;
        data: unknown;
        layout?: unknown;
    }>;
}

export interface StatsCompleteEvent {
    type: 'stats-complete';
    jobId: string;
    result: StatsJobResult;
}

// Update EngineEvent union - add StatsCompleteEvent
export type EngineEvent =
    | JobProgressEvent
    | JobLogEvent
    | JobCompleteEvent
    | JobFailedEvent
    | StatsCompleteEvent;
```

## Test

After creating these files:

1. TypeScript should compile without errors:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

2. Imports should work:
   ```typescript
   import { DataFileType, ColumnInfo } from './types/data';
   import { StatsTestConfig, StatsState } from './types/stats';
   ```

## Dependencies
None - this is the first prompt.

## Next
Proceed to `02_Context_Keys.md`
