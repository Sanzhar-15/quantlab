# Resources Functionality — Client-Side Plan (Local LLM)

## Context

The Resources activity bar panel already displays ~566 tools. Clicking an implemented tool currently routes through `TOOL_ID_MAP` to `quantlab.openStatsTest`, which opens the Stats View and executes via local Python subprocess. We are shifting execution to the **Delta Plus Server** (`localhost:8080`) while preserving local Python as a fallback for offline use.

**15 tools** are the initial scope — all currently marked `implemented: true` in the catalog.

---

## Architecture: Server-First Execution with Local Fallback

```
Tool click in Resources panel
    │
    ▼
ResourcesWebviewProvider.handleToolClick(serverToolId)
    │
    ├─ Stats section ──► quantlab.openStatsTest(serverToolId)
    │                        │
    │                        ▼
    │                   DataViewManager.openStatsTest() → pending test → Stats View opens
    │                        │
    │                        ▼
    │                   StatsViewProvider.initializeWithTest(toolId)
    │                        │
    │                        ├─ Try: ServerApiClient.getResourceToolDetail(toolId)
    │                        │       → builds config form from server-sourced schema
    │                        │
    │                        └─ Catch: TOOL_ID_MAP[toolId] → StatsCatalog.getTestById()
    │                                 → builds config form from local schema
    │                        │
    │                        ▼
    │                   User configures columns + params → clicks "Run"
    │                        │
    │                        ├─ Try: ToolExecutionService.submitExecution()
    │                        │       → POST /v1/tools/execute
    │                        │       → returns result (sync) or jobId (async → poll/WS)
    │                        │
    │                        └─ Catch: StatsEngine.executeTest() (local Python fallback)
    │                        │
    │                        ▼
    │                   StatsViewProvider → results state → webview renders
    │
    └─ Strategy section ──► quantlab.action.openResource(serverToolId)
                                → ActionViewProvider (existing infrastructure)
```

---

## Step-by-Step Implementation

### Step 1: Create `src/types/toolExecution.ts` (~50 lines)

New type definitions for the server execution protocol.

```typescript
import { DataSourceDescriptor, ServerTimeframe } from './market';
import { StatsTestResult } from './stats';

/** What the client sends to ToolExecutionService */
export interface ToolExecutionRequest {
    toolId: string;                   // server canonical ID, e.g. 'augmented-dickey-fuller'
    dataSource: DataSourceDescriptor; // LocalFileDataSource or ServerDataSource
    columns: string[];
    parameters: Record<string, unknown>;
    timeframe?: ServerTimeframe;      // only for server data sources
}

/** Job state returned by the server */
export type ToolJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface ToolExecutionJob {
    jobId: string;
    status: ToolJobStatus;
    progress?: number;
    message?: string;
    result?: StatsTestResult;  // present when status === 'complete' (sync mode)
    error?: string;            // present when status === 'failed'
}

/** Wire format: POST /v1/tools/execute request body */
export interface ServerToolExecutePayload {
    tool_id: string;
    data_source:
        | { kind: 'server'; symbol: string; timeframe: string }
        | { kind: 'inline'; format: string; data: string; filename: string };
    columns: string[];
    parameters: Record<string, unknown>;
}

/** Wire format: GET /v1/tools/{jobId}/status response */
export interface ServerToolJobStatusResponse {
    job_id: string;
    status: ToolJobStatus;
    progress?: number;
    message?: string;
}

/** Wire format: POST /v1/tools/execute response (sync or async) */
export interface ServerToolExecuteResponse {
    job_id: string;
    status: ToolJobStatus;
    result?: Record<string, unknown>;  // raw snake_case result, or null for async
}
```

---

### Step 2: Create `src/core/server/ToolExecutionService.ts` (~180 lines)

Singleton service that replaces local Python execution with server-side execution.

**Key responsibilities:**
- Convert `DataSourceDescriptor` → server wire format
  - `LocalFileDataSource` → read file, base64-encode, send as `{ kind: 'inline', format, data, filename }`
  - `ServerDataSource` → send as `{ kind: 'server', symbol, timeframe }`
- Submit execution via `ServerApiClient.executeToolJob()`
- Map server snake_case result → client camelCase `StatsTestResult`
- Poll for async jobs or listen via WebSocket
- Cancel running jobs

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServerApiClient } from './ServerApiClient';
import { DataSourceDescriptor, isLocalFileSource, isServerSource, toServerTimeframe } from '../../types/market';
import { StatsTestResult } from '../../types/stats';
import {
    ToolExecutionRequest, ToolExecutionJob, ServerToolExecutePayload
} from '../../types/toolExecution';

export class ToolExecutionService {
    private static instance: ToolExecutionService;

    private constructor() {}

    static initialize(): ToolExecutionService {
        if (!ToolExecutionService.instance) {
            ToolExecutionService.instance = new ToolExecutionService();
        }
        return ToolExecutionService.instance;
    }

    static getInstance(): ToolExecutionService {
        if (!ToolExecutionService.instance) {
            throw new Error('ToolExecutionService not initialized');
        }
        return ToolExecutionService.instance;
    }

    async submitExecution(request: ToolExecutionRequest): Promise<ToolExecutionJob> {
        const client = ServerApiClient.getInstance();
        const payload = await this.buildPayload(request);
        const response = await client.executeToolJob(payload);

        return {
            jobId: response.job_id,
            status: response.status,
            result: response.result ? this.mapServerResult(response.result) : undefined,
        };
    }

    async pollUntilComplete(
        jobId: string,
        onProgress?: (progress: number, message: string) => void,
        token?: vscode.CancellationToken,
    ): Promise<StatsTestResult> {
        const client = ServerApiClient.getInstance();
        const POLL_INTERVAL_MS = 1000;
        const MAX_POLLS = 300; // 5 minutes max

        for (let i = 0; i < MAX_POLLS; i++) {
            if (token?.isCancellationRequested) {
                await this.cancelExecution(jobId);
                throw new Error('Execution cancelled');
            }

            const status = await client.getToolJobStatus(jobId);

            if (status.status === 'complete') {
                const rawResult = await client.getToolJobResult(jobId);
                return this.mapServerResult(rawResult);
            }

            if (status.status === 'failed') {
                throw new Error(status.message ?? 'Tool execution failed on server');
            }

            if (status.status === 'cancelled') {
                throw new Error('Execution was cancelled');
            }

            if (onProgress && status.progress !== undefined) {
                onProgress(status.progress, status.message ?? '');
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        throw new Error('Tool execution timed out');
    }

    async cancelExecution(jobId: string): Promise<void> {
        await ServerApiClient.getInstance().cancelToolJob(jobId);
    }

    // ── Private helpers ─────────────────────────────────────────────────

    private async buildPayload(request: ToolExecutionRequest): Promise<ServerToolExecutePayload> {
        let dataSource: ServerToolExecutePayload['data_source'];

        if (isLocalFileSource(request.dataSource)) {
            const filePath = request.dataSource.filePath;
            const ext = path.extname(filePath).toLowerCase().replace('.', '');
            const content = await fs.promises.readFile(filePath);
            dataSource = {
                kind: 'inline',
                format: ext === 'xlsx' ? 'xlsx' : ext === 'parquet' ? 'parquet' : 'csv',
                data: content.toString('base64'),
                filename: path.basename(filePath),
            };
        } else if (isServerSource(request.dataSource)) {
            dataSource = {
                kind: 'server',
                symbol: request.dataSource.symbol,
                timeframe: request.timeframe
                    ? toServerTimeframe(request.timeframe)
                    : '1h',
            };
        } else {
            throw new Error('Unknown data source type');
        }

        return {
            tool_id: request.toolId,
            data_source: dataSource,
            columns: request.columns,
            parameters: request.parameters,
        };
    }

    private mapServerResult(raw: Record<string, unknown>): StatsTestResult {
        return {
            testId: String(raw.test_id ?? raw.testId ?? ''),
            testName: String(raw.test_name ?? raw.testName ?? ''),
            statistic: Number(raw.statistic ?? 0),
            pValue: raw.p_value != null ? Number(raw.p_value) : (raw.pValue != null ? Number(raw.pValue) : null),
            criticalValues: (raw.critical_values ?? raw.criticalValues ?? undefined) as Record<string, number> | undefined,
            conclusion: String(raw.conclusion ?? ''),
            interpretation: String(raw.interpretation ?? ''),
            details: (raw.details ?? {}) as Record<string, unknown>,
            visualizations: (raw.visualizations ?? undefined) as StatsTestResult['visualizations'],
        };
    }

    dispose(): void {
        // Nothing to clean up currently
    }
}
```

---

### Step 3: Extend `src/core/server/ServerApiClient.ts` (+60 lines)

**Add imports** at top:
```typescript
import { ServerToolExecutePayload, ServerToolExecuteResponse, ServerToolJobStatusResponse } from '../../types/toolExecution';
```

**Add methods** after existing `getResourceToolDetail()`:

```typescript
// ── Tool Execution ───────────────────────────────────────────────────────

async executeToolJob(payload: ServerToolExecutePayload): Promise<ServerToolExecuteResponse> {
    await this.ensureAuthenticated();
    return this.request<ServerToolExecuteResponse>('POST', '/v1/tools/execute', payload);
}

async getToolJobStatus(jobId: string): Promise<ServerToolJobStatusResponse> {
    await this.ensureAuthenticated();
    return this.request<ServerToolJobStatusResponse>('GET', `/v1/tools/${encodeURIComponent(jobId)}/status`);
}

async getToolJobResult(jobId: string): Promise<Record<string, unknown>> {
    await this.ensureAuthenticated();
    return this.request<Record<string, unknown>>('GET', `/v1/tools/${encodeURIComponent(jobId)}/result`);
}

async cancelToolJob(jobId: string): Promise<void> {
    await this.ensureAuthenticated();
    await this.request<unknown>('DELETE', `/v1/tools/${encodeURIComponent(jobId)}`);
}
```

**Extend WebSocket handler** — in `handleWebSocketMessage()`, after the `quote` type check:

```typescript
if (parsed.type === 'job-progress') {
    this._onJobProgress.fire({
        jobId: parsed.job_id,
        progress: parsed.progress,
        message: parsed.message ?? '',
    });
} else if (parsed.type === 'job-complete') {
    this._onJobComplete.fire({ jobId: parsed.job_id });
}
```

**Add event emitters** as class members:

```typescript
private readonly _onJobProgress = new vscode.EventEmitter<{ jobId: string; progress: number; message: string }>();
readonly onJobProgress = this._onJobProgress.event;

private readonly _onJobComplete = new vscode.EventEmitter<{ jobId: string }>();
readonly onJobComplete = this._onJobComplete.event;
```

**Dispose** the emitters in the existing `dispose()` method.

---

### Step 4: Update `src/panels/resources/ResourcesWebviewProvider.ts` (+15 lines)

Change `handleToolClick` to:
1. Pass server canonical ID (not legacy mapped ID)
2. Route strategy tools to ActionViewProvider

```typescript
private async handleToolClick(serverToolId: string): Promise<void> {
    const tool = this.catalogService.getToolById(serverToolId);
    if (!tool || !tool.implemented) { return; }

    const section = this.catalogService.getSectionForTool(serverToolId);

    if (section === 'stats') {
        // Map to legacy ID for Stats View (which uses StatsCatalog)
        const legacyId = TOOL_ID_MAP[serverToolId] ?? serverToolId;
        void vscode.commands.executeCommand('quantlab.openStatsTest', serverToolId);
    } else if (section === 'strategy') {
        void vscode.commands.executeCommand('quantlab.action.openResource', serverToolId);
    }
}
```

---

### Step 5: Update `src/panels/resources/ResourcesCatalogService.ts` (+15 lines)

Add `getSectionForTool()`:

```typescript
getSectionForTool(toolId: string): ClientSection | null {
    const cat = this.getCategoryForTool(toolId);
    if (!cat) { return null; }
    return this.getSectionForCategory(cat.id);
}
```

---

### Step 6: Update `src/views/stats/StatsViewProvider.ts` (~80 lines changed)

**6a. Add imports:**
```typescript
import { ToolExecutionService } from '../../core/server/ToolExecutionService';
import { ServerApiClient } from '../../core/server/ServerApiClient';
import { TOOL_ID_MAP, ResourceToolDetail, ParameterDefinition } from '../../types/resources';
import { DataSourceDescriptor, isServerSource } from '../../types/market';
```

**6b. Change `initializeWithTest`** to try server schema first:

```typescript
private async initializeWithTest(uri: vscode.Uri, toolId: string): Promise<void> {
    const uriKey = uri.toString();
    let testDef: StatsTestDefinition | null = null;

    // 1. Try server-sourced schema
    try {
        const detail = await ServerApiClient.getInstance().getResourceToolDetail(toolId);
        testDef = this.convertDetailToTestDef(toolId, detail);
    } catch { /* server unavailable */ }

    // 2. Fallback to local StatsCatalog
    if (!testDef) {
        const legacyId = TOOL_ID_MAP[toolId] ?? toolId;
        testDef = getTestById(legacyId) ?? null;
    }

    if (!testDef) {
        this.stateByUri.set(uriKey, { type: 'error', testId: toolId, error: `Unknown test: ${toolId}`, recoverable: false });
        this.sendState(uri);
        return;
    }

    // ... rest of existing logic (load columns, build initial state, etc.)
}
```

**6c. Add `convertDetailToTestDef` helper:**

```typescript
private convertDetailToTestDef(toolId: string, detail: ResourceToolDetail): StatsTestDefinition {
    return {
        id: toolId,
        label: detail.label,
        description: detail.description,
        category: 'descriptive', // category is only used for grouping, not functional
        requiredColumns: detail.required_columns ?? { count: '1+', types: ['float64', 'int64'] },
        parameters: (detail.parameters ?? []).map(p => ({
            id: p.id,
            label: p.label,
            type: p.type as 'number' | 'select' | 'boolean' | 'array',
            default: p.default,
            options: p.options,
            min: p.min,
            max: p.max,
            description: p.description,
        })),
    };
}
```

**6d. Change `runTest`** to use server execution with local fallback:

```typescript
private async runTest(uri: vscode.Uri): Promise<void> {
    const uriKey = uri.toString();
    const state = this.stateByUri.get(uriKey);
    if (state?.type !== 'configuration' || !state.validation?.isValid) { return; }

    const startedAt = new Date().toISOString();
    this.stateByUri.set(uriKey, {
        type: 'running', testId: state.testId, testName: state.testName,
        progress: 0, message: 'Initializing...', startedAt,
    });
    this.sendState(uri);

    try {
        // Try server execution first
        const executionService = ToolExecutionService.getInstance();
        const dataSource = this.resolveDataSource(uri);

        const job = await executionService.submitExecution({
            toolId: state.testId,
            dataSource,
            columns: state.selectedColumns,
            parameters: state.parameters,
        });

        let result: StatsTestResult;
        if (job.result) {
            // Synchronous result
            result = job.result;
        } else {
            // Async — poll
            result = await executionService.pollUntilComplete(
                job.jobId,
                (progress, message) => this.updateProgress(uri, progress, message),
            );
        }

        this.stateByUri.set(uriKey, {
            type: 'results', testId: state.testId, result,
            durationMs: Date.now() - new Date(startedAt).getTime(),
        });
    } catch {
        // Fallback: local Python execution
        try {
            await this.runTestLocally(uri, state, startedAt);
            return; // runTestLocally sets its own result state
        } catch (localErr) {
            this.stateByUri.set(uriKey, {
                type: 'error', testId: state.testId,
                error: localErr instanceof Error ? localErr.message : String(localErr),
                recoverable: true,
            });
        }
    }

    this.sendState(uri);
}

private async runTestLocally(
    uri: vscode.Uri,
    state: StatsConfigurationState,
    startedAt: string,
): Promise<void> {
    const legacyId = TOOL_ID_MAP[state.testId] ?? state.testId;
    const config: StatsTestConfig = {
        testId: legacyId,
        dataPath: uri.fsPath,
        columns: state.selectedColumns,
        parameters: state.parameters,
    };

    const result = await vscode.commands.executeCommand<StatsTestResult>(
        'quantlab.executeStatsTest', config,
        (progress: number, message: string) => this.updateProgress(uri, progress, message),
    );

    if (result) {
        this.stateByUri.set(uri.toString(), {
            type: 'results', testId: state.testId, result,
            durationMs: Date.now() - new Date(startedAt).getTime(),
        });
    } else {
        throw new Error('No result returned from local stats engine');
    }
}

private resolveDataSource(uri: vscode.Uri): DataSourceDescriptor {
    const manager = DataViewManager.getInstance();
    const active = manager.getActiveDataSource();
    if (active) { return active; }
    return {
        kind: 'localFile' as const,
        filePath: uri.fsPath,
        displayName: path.basename(uri.fsPath),
    };
}
```

---

### Step 7: Update `src/views/DataViewManager.ts` (+15 lines)

Add active data source tracking:

```typescript
private activeDataSource: DataSourceDescriptor | undefined;

/** Set the active data source (called by Data panel on selection) */
setActiveDataSource(source: DataSourceDescriptor): void {
    this.activeDataSource = source;
}

/** Get the active data source */
getActiveDataSource(): DataSourceDescriptor | undefined {
    return this.activeDataSource;
}
```

---

### Step 8: Update `src/commands/dataCommands.ts` (+10 lines)

Add cancel command:

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.cancelToolExecution', async (jobId: string) => {
        try {
            const service = ToolExecutionService.getInstance();
            await service.cancelExecution(jobId);
        } catch (err) {
            void vscode.window.showErrorMessage(
                `Failed to cancel execution: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    })
);
```

---

### Step 9: Update `src/extension.ts` (+5 lines)

In `activate()`, after ServerApiClient initialization:
```typescript
import { ToolExecutionService } from './core/server/ToolExecutionService';
// ...
ToolExecutionService.initialize();
```

In `deactivate()`:
```typescript
try { ToolExecutionService.getInstance().dispose(); } catch { }
```

---

### Step 10: Enhance `webview/stats/index.ts` — Richer Results (~100 lines)

Extend the results rendering to handle the structured `details` and `criticalValues` fields:

**10a. Details table renderer:**
```typescript
function renderDetailsTable(details: Record<string, unknown>): string {
    const rows = Object.entries(details).map(([key, value]) => {
        const label = key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
        const formatted = typeof value === 'number' ? value.toFixed(4) : String(value);
        return `<tr><td class="detail-key">${escapeHtml(label)}</td><td class="detail-value">${escapeHtml(formatted)}</td></tr>`;
    }).join('');
    return `<table class="details-table">${rows}</table>`;
}
```

**10b. Critical values renderer:**
```typescript
function renderCriticalValues(criticalValues: Record<string, number>, statistic: number): string {
    const rows = Object.entries(criticalValues).map(([level, value]) => {
        const isSignificant = statistic < value;
        const cls = isSignificant ? 'significant' : '';
        return `<tr class="${cls}"><td>${escapeHtml(level)}</td><td>${value.toFixed(4)}</td></tr>`;
    }).join('');
    return `<table class="critical-values-table"><tr><th>Level</th><th>Critical Value</th></tr>${rows}</table>`;
}
```

**10c. Update results state rendering** to call these new functions when data is available.

---

## File Summary

| File | Action | Lines Est. |
|---|---|---|
| `src/types/toolExecution.ts` | **CREATE** | ~50 |
| `src/core/server/ToolExecutionService.ts` | **CREATE** | ~180 |
| `src/core/server/ServerApiClient.ts` | **MODIFY** | +60 |
| `src/panels/resources/ResourcesWebviewProvider.ts` | **MODIFY** | +15 |
| `src/panels/resources/ResourcesCatalogService.ts` | **MODIFY** | +15 |
| `src/views/stats/StatsViewProvider.ts` | **MODIFY** | +80 |
| `src/views/DataViewManager.ts` | **MODIFY** | +15 |
| `src/commands/dataCommands.ts` | **MODIFY** | +10 |
| `src/extension.ts` | **MODIFY** | +5 |
| `webview/stats/index.ts` | **MODIFY** | +100 |

## Verification

1. `cd extensions/quantlab && npx tsc -p tsconfig.json` — must compile cleanly
2. `node esbuild-webview.mjs` — must bundle cleanly
3. With server running: click tool → server execution → results display
4. Without server: click tool → local Python fallback → results display
5. Test both data source types (local CSV file and server symbol)
