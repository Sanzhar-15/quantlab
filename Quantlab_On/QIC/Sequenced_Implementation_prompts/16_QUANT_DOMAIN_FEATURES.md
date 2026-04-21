# Prompt 16 — Quant Domain: DataFrame, Arrow IPC, Python Sidecar & Patterns

**Phase**: 9 (Quant Domain + LSP)
**Prerequisites**: Prompt 15 (tool implementations — notebook stubs)
**Estimated Scope**: ~10 files created, ~1200 lines

---

## Objective

Implement Quantlab-specific AI features: DataFrame safety (preview large DataFrames without OOM), Arrow IPC bridge (zero-copy transfer between Python and TypeScript), Python bridge to the EXISTING engine daemon (JSON-RPC for numerical computation), time series detection, and quant library code patterns. This differentiates QIC from generic AI coding assistants.

> **AUDIT FIX III-QI2 (CRITICAL)**: QIC's quant features should communicate with the EXISTING Python engine daemon at `engine/quantlab/daemon/main.py` via JSON-RPC. Do NOT spawn a new Python sidecar process. Add QIC-specific methods to the existing daemon: `qic.analyze_time_series`, `qic.detect_frequency`, `qic.statistical_test`, `qic.analyze_backtest`, `qic.preview_dataframe`. Create a `QicPythonBridge` that routes through the existing IPC layer at `extensions/quantlab/src/core/ipc/`.
>
> **AUDIT FIX III-QI3 (HIGH)**: Import and reuse `JsonRpcRequest`, `JsonRpcSuccessResponse`, `JsonRpcErrorResponse` from the existing IPC types at `extensions/quantlab/src/core/ipc/types.ts`. Do NOT define a new JSON-RPC protocol. (REMEDIATION FIX 4a: The actual types are `JsonRpcSuccessResponse` and `JsonRpcErrorResponse`, not `JsonRpcResponse`.)
>
> **AUDIT FIX III-QI10 (LOW)**: Delegate file reading to existing data services where possible. Parquet: route through engine's `parquet_loader`. CSV: route through engine's `csv_loader`. Arrow: direct read via `apache-arrow` npm.

---

## Spec References

- QIC Spec v6.2: §11.1 DataFrame Preview (lines 7293–7336)
- QIC Spec v6.2: §11.2 Time Series (lines 7336–7378)
- QIC Spec v6.2: §11.3 Quant Library Awareness (lines 7378–7440)
- QIC Spec v6.2: §11.4 Arrow IPC (lines 7440–7547) — Zero-copy transfer
- QIC Spec v6.2: §11.5 Python Sidecar (lines 7547–7761) — JSON-RPC process

---

## Implementation Instructions

### 1. DataFrameSafety (`src/vs/workbench/contrib/qic/common/quant/dataframeSafety.ts`)

Safe preview for large DataFrames:

> **AUDIT FIX III-QI10 (LOW)**: Delegate file reading to existing data services where possible:
> - Parquet files: Route through engine's `parquet_loader` via IPC
> - CSV files: Route through engine's `csv_loader` via IPC
> - Arrow files: Direct read via TypeScript (`apache-arrow` npm package)
> This ensures data format handling is consistent between QIC previews and Quantlab's native data pipeline.

```typescript
export class DataFrameSafety {
    /**
     * Preview a DataFrame without loading it fully into memory.
     * Uses the QicPythonBridge (existing engine daemon) to read only the preview slice.
     * Delegates file reading to existing data services (parquet_loader, csv_loader).
     */
    async preview(
        filePath: string,
        options?: { maxRows?: number; maxColumns?: number; format?: 'csv' | 'parquet' | 'feather' }
    ): Promise<DataFramePreview>;
}

export interface DataFramePreview {
    shape: [number, number];        // [rows, columns]
    columns: ColumnInfo[];
    head: Record<string, unknown>[];  // First N rows
    tail: Record<string, unknown>[];  // Last N rows
    dtypes: Record<string, string>;
    memoryUsageMb: number;
    nullCounts: Record<string, number>;
}
```

### 2. ArrowDataFrameBridge (`src/vs/workbench/contrib/qic/common/quant/arrowBridge.ts`)

Apache Arrow IPC for zero-copy DataFrame transfer:

```typescript
export class ArrowDataFrameBridge {
    /**
     * Read a DataFrame from Arrow IPC format.
     * Uses shared memory when available, temp file fallback otherwise.
     */
    async readFromArrow(ipcPath: string): Promise<ArrowTable>;

    /**
     * Write data to Arrow IPC format for Python consumption.
     */
    async writeToArrow(data: ArrowTable, outputPath: string): Promise<void>;

    /**
     * Transfer a DataFrame from Python to TypeScript via Arrow IPC.
     * 1. Existing engine daemon writes DataFrame to Arrow IPC file
     * 2. TypeScript reads the Arrow IPC file
     * 3. File is cleaned up after read
     * Reuses the existing ArrowDataFrameBridge pattern from the engine's
     * debug/mmap reader for zero-copy data transfer.
     */
    async transferFromPython(
        bridge: QicPythonBridge,
        pythonExpression: string
    ): Promise<ArrowTable>;
}
```

### 3. QicPythonBridge (`src/vs/workbench/contrib/qic/common/quant/qicPythonBridge.ts`)

> **AUDIT FIX III-QI2 (CRITICAL)**: This replaces the originally planned standalone Python sidecar. Instead of spawning a new process, QicPythonBridge routes requests through the existing IPC layer to the existing Python engine daemon at `engine/quantlab/daemon/main.py`.

> **AUDIT FIX III-QI3 (HIGH)**: Reuse existing IPC types — import `JsonRpcRequest`, `JsonRpcResponse` from `extensions/quantlab/src/core/ipc/types.ts`.

Bridge to the existing Quantlab Python engine daemon for numerical compute:

```typescript
// REMEDIATION FIX 4b: Workbench code CANNOT import from extensions/ directory.
// Create shared IPC types that mirror the needed types from extensions/quantlab/src/core/ipc/types.ts.
// import { JsonRpcRequest, JsonRpcSuccessResponse, JsonRpcErrorResponse } from '../common/ipc/ipcTypes.js';

export class QicPythonBridge {
    private readonly ipcClient: IpcClient;
    private readonly idleTimeoutMs = 5 * 60 * 1000;  // 5 minutes

    constructor(ipcClient: IpcClient) {
        this.ipcClient = ipcClient;
    }

    /**
     * Ensure the engine daemon is running.
     * If the engine daemon is not running (e.g., no trading session active),
     * QicPythonBridge should start it on demand and manage idle timeout.
     */
    async ensureRunning(): Promise<void>;

    /**
     * Send a QIC-specific JSON-RPC request to the existing engine daemon.
     * Uses the existing IPC layer — does NOT spawn a new process.
     */
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
        return this.ipcClient.request(method, params);
    }

    /**
     * Analyze time series data via the existing engine daemon.
     */
    async analyzeTimeSeries(data: ArrowBuffer): Promise<TimeSeriesAnalysis> {
        return this.call('qic.analyze_time_series', { data });
    }

    /**
     * Detect frequency of timestamps.
     */
    async detectFrequency(timestamps: string[]): Promise<FrequencyInfo> {
        return this.call('qic.detect_frequency', { timestamps });
    }

    /**
     * Run a statistical test via the engine daemon.
     */
    async statisticalTest(data: number[], testName: string): Promise<StatTestResult> {
        return this.call('qic.statistical_test', { data, test_name: testName });
    }

    /**
     * Analyze backtest results via the engine daemon.
     */
    async analyzeBacktest(returns: number[], benchmark?: number[]): Promise<BacktestAnalysis> {
        return this.call('qic.analyze_backtest', { returns, benchmark });
    }

    /**
     * Preview a DataFrame via the engine daemon.
     */
    async previewDataFrame(path: string, options?: DataFramePreviewOptions): Promise<DataFramePreview> {
        return this.call('qic.preview_dataframe', { path, ...options });
    }

    /**
     * Stop the engine daemon if QIC started it on demand.
     */
    async stop(): Promise<void>;
}
```

#### Python Engine Extension (add to existing engine daemon)

Add QIC-specific JSON-RPC methods to the **existing** engine at `engine/quantlab/daemon/main.py`:

```python
# Add these QIC-specific methods to the existing JSON-RPC handler:
#
# - qic.preview_dataframe(path, format, max_rows, max_columns) → DataFramePreview
# - qic.analyze_backtest(returns, benchmark?) → BacktestAnalysis (Sharpe, Sortino, max drawdown, alpha/beta)
# - qic.detect_frequency(timestamps) → detected frequency
# - qic.analyze_time_series(data, freq?) → frequency, stationarity, outliers
# - qic.statistical_test(data, test_name) → p-value, statistic
#
# These methods extend the existing daemon — they do NOT create a new process.
# Reuse the existing ArrowDataFrameBridge pattern from the engine's
# debug/mmap reader for zero-copy data transfer.
```

### 3b. PythonEnvironmentManager (`src/vs/workbench/contrib/qic/common/quant/pythonEnvManager.ts`)

> **AUDIT FIX VIII-PC1 (HIGH)**: This file was missing from the original prompt. It is a prerequisite for QicPythonBridge.

```typescript
export class PythonEnvironmentManager {
    private cachedPythonPath: string | null = null;

    /**
     * Discover a suitable Python environment.
     * Discovery chain: setting → .venv → python3 → python
     */
    async discoverPython(): Promise<string> {
        if (this.cachedPythonPath) return this.cachedPythonPath;

        // 1. Check qic.pythonPath setting
        // 2. Check workspace .venv/bin/python
        // 3. Check system python3
        // 4. Check system python
        for (const candidate of this.candidates()) {
            if (await this.validate(candidate)) {
                this.cachedPythonPath = candidate;
                return candidate;
            }
        }
        throw new QicError('QIC-Q001', 'No suitable Python environment found');
    }

    /**
     * Validate a Python environment by running import checks.
     */
    async validate(pythonPath: string): Promise<boolean> {
        // Run: python -c "import numpy; import pandas; import pyarrow; print('ok')"
        const result = await execFile(pythonPath, ['-c',
            'import numpy; import pandas; import pyarrow; print("ok")']);
        return result.stdout.trim() === 'ok';
    }

    /**
     * Auto-setup: create virtualenv and install requirements if needed.
     */
    async autoSetup(): Promise<string> {
        // Create .venv, install requirements, return path
    }

    private *candidates(): Generator<string> {
        // 1. User setting
        const settingPath = this.configService.getValue<string>('qic.pythonPath');
        if (settingPath) yield settingPath;

        // 2. Workspace .venv
        yield path.join(this.workspaceRoot, '.venv', 'bin', 'python');

        // 3. System python3
        yield 'python3';

        // 4. System python
        yield 'python';
    }
}
```

### 4. TimeSeriesDetector (`src/vs/workbench/contrib/qic/common/quant/timeSeries.ts`)

```typescript
export class TimeSeriesDetector {
    /**
     * Detect time series characteristics in data.
     */
    async analyze(filePath: string): Promise<TimeSeriesInfo>;
}

export interface TimeSeriesInfo {
    isTimeSeries: boolean;
    frequency?: 'tick' | 'second' | 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly';
    dateColumn?: string;
    gaps: Array<{ start: string; end: string; count: number }>;
    outliers: Array<{ index: number; value: number; zscore: number }>;
    warnings: string[];
}
```

### 5. QuantPatterns (`src/vs/workbench/contrib/qic/common/quant/quantPatterns.ts`)

Quant-specific code intelligence for completions:

```typescript
export class QuantPatterns {
    /**
     * Detect common quant coding anti-patterns and provide warnings.
     */
    analyzeCode(code: string): QuantWarning[];

    /**
     * Provide quant-aware completion suggestions.
     */
    getCompletionContext(code: string, position: Position): QuantContext;
}

// Anti-patterns to detect:
// - Look-ahead bias (using future data in backtest)
// - Survivorship bias (indexing by ticker without survival filter)
// - Data snooping (fitting parameters to test set)
// - Missing transaction cost modeling
// - Incorrect Sharpe ratio calculation (daily vs annualized)
// - Pandas .loc vs .iloc confusion with time series
```

### 6. Complete Notebook Tool Implementations

Replace the stubs from Prompt 15:

```typescript
// Update tools/notebookTools.ts with real implementations
// that use QicPythonBridge (existing engine daemon) for compute
// and ArrowDataFrameBridge for data transfer
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/quant/dataframeSafety.ts` | DataFrame preview |
| `src/vs/workbench/contrib/qic/common/quant/arrowBridge.ts` | Arrow IPC bridge |
| `src/vs/workbench/contrib/qic/common/quant/qicPythonBridge.ts` | Bridge to existing engine daemon (AUDIT FIX III-QI2) |
| `src/vs/workbench/contrib/qic/common/quant/pythonEnvManager.ts` | Python environment discovery/validation (AUDIT FIX VIII-PC1) |
| `src/vs/workbench/contrib/qic/common/quant/timeSeries.ts` | Time series detection |
| `src/vs/workbench/contrib/qic/common/quant/quantPatterns.ts` | Quant patterns |
| `src/vs/workbench/contrib/qic/common/ipc/ipcTypes.ts` | Shared IPC types mirroring `extensions/quantlab/src/core/ipc/types.ts` (REMEDIATION FIX 4b) |
| `src/vs/workbench/contrib/qic/test/common/quant/qicPythonBridge.test.ts` | Bridge tests |

### Files to Modify (in existing engine daemon)

| File | Change |
|------|--------|
| `engine/quantlab/daemon/main.py` | Add QIC-specific JSON-RPC methods (qic.analyze_time_series, etc.) |
| `engine/quantlab/daemon/qic_handlers.py` | **New** — QIC-specific handler implementations for the existing daemon |

## Dependencies

**REMEDIATION FIX 4c**: Add `apache-arrow` to `package.json` dependencies. This is required by the ArrowDataFrameBridge for zero-copy DataFrame transfer. Example: `npm install apache-arrow`.

---

---

## Acceptance Criteria

```
□ DataFrame preview works for 1GB parquet file in < 2s without OOM
□ Arrow IPC round-trips DataFrame Python → TypeScript → Python with zero data loss
□ QicPythonBridge routes requests to existing engine daemon (no new Python process spawned)
□ Engine daemon starts on demand if not running, idles out after 5 min
□ PythonEnvironmentManager discovers Python via setting → .venv → python3 → python chain
□ PythonEnvironmentManager validates via import check (numpy, pandas, pyarrow)
□ Time series detection correctly identifies daily frequency, gaps, outliers
□ Quant patterns detect look-ahead bias and survivorship bias
□ Backtest analysis returns Sharpe, Sortino, max drawdown, alpha/beta
□ Parquet/CSV file reading delegates to existing engine data loaders
□ Notebook tool stubs replaced with real implementations
□ All 22 tools now have implementations (verify tool registry completeness)
□ `apache-arrow` npm dependency added to package.json (REMEDIATION FIX 4c)
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

The following fixes from the deep audit (QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md) have been incorporated into this prompt:

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **III-QI2** | CRITICAL | Replaced new Python sidecar with reuse of existing engine daemon at `engine/quantlab/daemon/main.py` via JSON-RPC. Created `QicPythonBridge` that routes through existing IPC layer. |
| **III-QI3** | HIGH | Import and reuse `JsonRpcRequest`, `JsonRpcResponse` from existing IPC types at `extensions/quantlab/src/core/ipc/types.ts`. |
| **VIII-PC1** | HIGH | Added `pythonEnvManager.ts` to files-to-create with: discovery chain (setting -> .venv -> python3 -> python), validation via import check, auto-setup with virtualenv, caching. |
| **III-QI10** | LOW | Delegated file reading to existing data service: Parquet via engine's `parquet_loader`, CSV via engine's `csv_loader`, Arrow via `apache-arrow` npm. |
