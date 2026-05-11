/*---------------------------------------------------------------------------------------------
 *  Stats View Provider - Custom editor for statistical test configuration and results
 *  Executes via Delta Plus Server with local Python fallback.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewUri, getNonce } from '../../utils/webview';
import { DataViewManager } from '../DataViewManager';
import { getTestById, STATS_TEST_DEFINITIONS } from '../../stats/StatsCatalog';
import {
    StatsState,
    StatsTestConfig,
    StatsTestResult,
    StatsTestDefinition,
    StatsConfigurationState
} from '../../types/stats';
import { DataSourceDescriptor } from '../../types/market';
import { TOOL_ID_MAP, ResourceToolDetail } from '../../types/resources';
import { ToolExecutionService } from '../../core/server/ToolExecutionService';
import { ServerApiClient } from '../../core/server/ServerApiClient';
import { ColumnInfo, ColumnDType } from '../../types/data';

// Reverse map: legacy ID → server canonical IDs
const REVERSE_TOOL_ID_MAP: Record<string, string[]> = {};
for (const [serverKey, legacyValue] of Object.entries(TOOL_ID_MAP)) {
    if (!REVERSE_TOOL_ID_MAP[legacyValue]) {
        REVERSE_TOOL_ID_MAP[legacyValue] = [];
    }
    REVERSE_TOOL_ID_MAP[legacyValue].push(serverKey);
}

interface StatsMessage {
    type: 'ready' | 'runTest' | 'updateConfig' | 'backToConfig' | 'switchTest' | 'cancel';
    testId?: string;
    config?: Partial<StatsTestConfig>;
}

export class StatsViewProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'quantlab.statsView';
    private static instance: StatsViewProvider;

    private readonly webviewPanels = new Map<string, vscode.WebviewPanel>();
    private readonly stateByUri = new Map<string, StatsState>();
    // Track the server tool ID alongside the legacy testId
    private readonly serverToolIdByUri = new Map<string, string>();
    private readonly activeJobIdByUri = new Map<string, string>();

    private constructor(
        private readonly context: vscode.ExtensionContext
    ) {}

    static getInstance(context?: vscode.ExtensionContext): StatsViewProvider {
        if (!StatsViewProvider.instance) {
            if (!context) {
                throw new Error('StatsViewProvider must be initialized with context');
            }
            StatsViewProvider.instance = new StatsViewProvider(context);
        }
        return StatsViewProvider.instance;
    }

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = StatsViewProvider.getInstance(context);
        return vscode.window.registerCustomEditorProvider(
            StatsViewProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        );
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const uri = document.uri;
        const uriKey = uri.toString();

        // Store panel reference
        this.webviewPanels.set(uriKey, webviewPanel);

        // Configure webview
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Handle messages from webview — scoped to this panel's lifetime
        const panelDisposables: vscode.Disposable[] = [];
        panelDisposables.push(
            webviewPanel.webview.onDidReceiveMessage(
                (message: StatsMessage) => this.handleMessage(uri, message)
            )
        );

        // Cleanup on dispose
        webviewPanel.onDidDispose(() => {
            for (const d of panelDisposables) { d.dispose(); }
            panelDisposables.length = 0;
            this.webviewPanels.delete(uriKey);
            this.stateByUri.delete(uriKey);
            this.serverToolIdByUri.delete(uriKey);
            this.activeJobIdByUri.delete(uriKey);
        });

        // Check for pending test from DataViewManager
        const pendingTestId = DataViewManager.getInstance().consumePendingTest(uri);
        if (pendingTestId) {
            // Initialize with pending test
            await this.initializeWithTest(uri, pendingTestId);
        } else {
            // Initialize in idle state
            this.stateByUri.set(uriKey, {
                type: 'idle',
                dataFile: uri.fsPath
            });
        }
    }

    private async handleMessage(uri: vscode.Uri, message: StatsMessage): Promise<void> {
        const uriKey = uri.toString();

        switch (message.type) {
            case 'ready':
                // Webview is ready, send current state
                this.sendState(uri);
                break;

            case 'switchTest':
                if (message.testId) {
                    await this.initializeWithTest(uri, message.testId);
                }
                break;

            case 'updateConfig':
                if (message.config) {
                    this.updateConfiguration(uri, message.config);
                }
                break;

            case 'runTest':
                await this.runTest(uri);
                break;

            case 'cancel':
                await this.cancelTest(uri);
                break;

            case 'backToConfig': {
                // Return to configuration from results
                const state = this.stateByUri.get(uriKey);
                if (state && (state.type === 'results' || state.type === 'error')) {
                    await this.initializeWithTest(uri, state.testId);
                }
                break;
            }
        }
    }

    /**
     * Initialize with a test ID. Accepts either server canonical IDs (e.g. 'augmented-dickey-fuller')
     * or legacy IDs (e.g. 'adf'). Tries fetching schema from server first, falls back to local catalog.
     */
    private async initializeWithTest(uri: vscode.Uri, toolId: string): Promise<void> {
        const uriKey = uri.toString();
        let testDef: StatsTestDefinition | undefined;
        let serverToolId = toolId;

        // Determine if this is a server canonical ID or legacy ID
        const legacyId = TOOL_ID_MAP[toolId] ?? toolId;

        // 1. Try server schema fetch (use the canonical ID)
        try {
            const detail = await ServerApiClient.getInstance().getResourceToolDetail(toolId);
            testDef = this.convertServerDetailToTestDef(detail);
            serverToolId = toolId;
        } catch {
            // Server unavailable — try with legacy ID if different
            if (legacyId !== toolId) {
                try {
                    const detail = await ServerApiClient.getInstance().getResourceToolDetail(legacyId);
                    testDef = this.convertServerDetailToTestDef(detail);
                    serverToolId = legacyId;
                } catch {
                    // Fall through to local catalog
                }
            }
        }

        // 2. Fallback to local catalog
        if (!testDef) {
            testDef = getTestById(legacyId);
            // Store the original server tool ID for execution
            serverToolId = toolId;
        }

        if (!testDef) {
            this.stateByUri.set(uriKey, {
                type: 'error',
                testId: legacyId,
                error: `Unknown test: ${toolId}`,
                recoverable: false
            });
            this.sendState(uri);
            return;
        }

        // Track the server tool ID for execution
        this.serverToolIdByUri.set(uriKey, serverToolId);

        // Load column info from data file
        const columns = await this.loadColumnInfo(uri);

        // Build initial state
        const initialParams: Record<string, unknown> = {};
        for (const param of testDef.parameters) {
            initialParams[param.id] = param.default;
        }

        this.stateByUri.set(uriKey, {
            type: 'configuration',
            testId: legacyId,
            testName: testDef.label,
            dataFile: uri.fsPath,
            columns,
            selectedColumns: [],
            parameters: initialParams,
            schema: testDef,
            validation: { isValid: false, errors: ['Select at least one column'] }
        });

        this.sendState(uri);
    }

    /**
     * Convert server ResourceToolDetail to local StatsTestDefinition format
     */
    private convertServerDetailToTestDef(detail: ResourceToolDetail): StatsTestDefinition | undefined {
        if (!detail.required_columns || !detail.parameters) {
            return undefined;
        }

        return {
            id: detail.id,
            label: detail.label,
            description: detail.description,
            category: 'descriptive', // Category isn't critical for execution
            requiredColumns: {
                count: detail.required_columns.count,
                types: detail.required_columns.types,
            },
            parameters: detail.parameters.map(p => ({
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

    private async loadColumnInfo(uri: vscode.Uri): Promise<Array<{ name: string; dtype: ColumnDType }>> {
        // Audit-fix C3+M1: the underlying command now THROWS on inspection
        // failure (was: silently returned null/[] which produced empty pickers
        // with no UI surface). Surface the error to the user, then return
        // an empty list so the panel shape stays renderable.
        try {
            const result = await vscode.commands.executeCommand<ColumnInfo[]>(
                'quantlab.getDataFileColumns',
                uri.fsPath
            );
            return (result ?? []).map(c => ({ name: c.name, dtype: c.dtype }));
        } catch (err) {
            const message = (err as Error)?.message ?? String(err);
            void vscode.window.showErrorMessage(
                `Failed to inspect ${uri.fsPath}: ${message}`,
            );
            return [];
        }
    }

    private updateConfiguration(uri: vscode.Uri, updates: Partial<StatsTestConfig>): void {
        const uriKey = uri.toString();
        const state = this.stateByUri.get(uriKey);

        if (state?.type !== 'configuration') return;

        // Apply updates
        if (updates.columns !== undefined) {
            state.selectedColumns = updates.columns;
        }
        if (updates.parameters !== undefined) {
            state.parameters = { ...state.parameters, ...updates.parameters };
        }

        // Validate
        state.validation = this.validateConfiguration(state);

        this.stateByUri.set(uriKey, state);
        this.sendState(uri);
    }

    private validateConfiguration(state: StatsConfigurationState): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];
        const schema = state.schema;

        // Check column requirements
        const colCount = state.selectedColumns.length;
        const required = schema.requiredColumns.count;

        if (typeof required === 'number' && colCount !== required) {
            errors.push(`Requires exactly ${required} column(s), selected ${colCount}`);
        } else if (required === '1+' && colCount < 1) {
            errors.push('Select at least 1 column');
        } else if (required === '2+' && colCount < 2) {
            errors.push('Select at least 2 columns');
        }

        // Check column types
        const validTypes = schema.requiredColumns.types;
        for (const colName of state.selectedColumns) {
            const col = state.columns.find(c => c.name === colName);
            if (col && !validTypes.includes(col.dtype as 'float64' | 'int64')) {
                errors.push(`Column "${colName}" has incompatible type: ${col.dtype}`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    private async runTest(uri: vscode.Uri): Promise<void> {
        const uriKey = uri.toString();
        const state = this.stateByUri.get(uriKey);

        if (state?.type !== 'configuration') return;
        if (!state.validation?.isValid) return;

        const startedAt = new Date().toISOString();
        const serverToolId = this.serverToolIdByUri.get(uriKey) ?? state.testId;

        // Transition to running state
        this.stateByUri.set(uriKey, {
            type: 'running',
            testId: state.testId,
            testName: state.testName,
            progress: 0,
            message: 'Submitting to server...',
            startedAt
        });
        this.sendState(uri);

        try {
            // Try server execution first
            const result = await this.runTestOnServer(uri, serverToolId, state);

            if (!this.webviewPanels.has(uriKey)) { return; } // Panel closed during execution
            // Transition to results state
            this.stateByUri.set(uriKey, {
                type: 'results',
                testId: state.testId,
                result,
                durationMs: Date.now() - new Date(startedAt).getTime()
            });
        } catch {
            if (!this.webviewPanels.has(uriKey)) { return; } // Panel closed during execution
            // Fallback to local Python execution
            this.updateProgress(uri, 0, 'Server unavailable, running locally...');

            try {
                const result = await this.runTestLocally(uri, state);

                if (!this.webviewPanels.has(uriKey)) { return; } // Panel closed during execution
                if (result) {
                    this.stateByUri.set(uriKey, {
                        type: 'results',
                        testId: state.testId,
                        result,
                        durationMs: Date.now() - new Date(startedAt).getTime()
                    });
                } else {
                    throw new Error('No result returned from stats engine');
                }
            } catch (localErr) {
                if (!this.webviewPanels.has(uriKey)) { return; } // Panel closed during execution
                this.stateByUri.set(uriKey, {
                    type: 'error',
                    testId: state.testId,
                    error: localErr instanceof Error ? localErr.message : String(localErr),
                    recoverable: true
                });
            }
        }

        if (this.webviewPanels.has(uriKey)) {
            this.sendState(uri);
        }
    }

    /**
     * Execute test on the Delta Plus Server
     */
    private async runTestOnServer(
        uri: vscode.Uri,
        serverToolId: string,
        state: StatsConfigurationState,
    ): Promise<StatsTestResult> {
        const uriKey = uri.toString();
        const executionService = ToolExecutionService.getInstance();
        const dataSource = this.resolveDataSource(uri);

        const job = await executionService.submitExecution({
            toolId: serverToolId,
            dataSource,
            columns: state.selectedColumns,
            parameters: state.parameters,
        });

        // Panel may have closed while submitExecution was in flight
        if (!this.webviewPanels.has(uriKey)) {
            throw new Error('Execution was cancelled');
        }

        this.activeJobIdByUri.set(uriKey, job.jobId);

        if (job.status === 'failed') {
            this.activeJobIdByUri.delete(uriKey);
            throw new Error(job.error ?? 'Server execution failed');
        }

        if (job.status === 'cancelled') {
            this.activeJobIdByUri.delete(uriKey);
            throw new Error('Execution was cancelled');
        }

        if (!job.result) {
            this.activeJobIdByUri.delete(uriKey);
            throw new Error('No result returned from server');
        }

        this.activeJobIdByUri.delete(uriKey);

        // Convert ToolExecutionResult → StatsTestResult
        return {
            testId: job.result.testId,
            testName: job.result.testName,
            statistic: job.result.statistic,
            pValue: job.result.pValue,
            criticalValues: job.result.criticalValues,
            conclusion: job.result.conclusion,
            interpretation: job.result.interpretation,
            details: job.result.details,
            visualizations: job.result.visualizations?.map(v => ({
                type: v.type as StatsTestResult['visualizations'] extends Array<infer U> ? U extends { type: infer T } ? T : never : never,
                title: v.title,
                data: v.data,
            })),
        };
    }

    /**
     * Fallback: execute test locally via Python StatsEngine
     */
    private async runTestLocally(
        uri: vscode.Uri,
        state: StatsConfigurationState,
    ): Promise<StatsTestResult | null> {
        const legacyId = TOOL_ID_MAP[state.testId] ?? state.testId;
        const config: StatsTestConfig = {
            testId: legacyId,
            dataPath: state.dataFile,
            columns: state.selectedColumns,
            parameters: state.parameters,
        };

        return vscode.commands.executeCommand<StatsTestResult>(
            'quantlab.executeStatsTest',
            config,
            (progress: number, message: string) => {
                this.updateProgress(uri, progress, message);
            }
        );
    }

    /**
     * Resolve the data source for execution — prefers active server source
     * if one is selected, otherwise falls back to local file.
     */
    private resolveDataSource(uri: vscode.Uri): DataSourceDescriptor {
        const manager = DataViewManager.getInstance();
        const activeSource = manager.getActiveDataSource();
        if (activeSource) {
            return activeSource;
        }
        return {
            kind: 'localFile',
            filePath: uri.fsPath,
            displayName: path.basename(uri.fsPath),
        };
    }

    private async cancelTest(uri: vscode.Uri): Promise<void> {
        const uriKey = uri.toString();
        const state = this.stateByUri.get(uriKey);

        if (state?.type !== 'running') return;

        // Cancel server job if active
        const activeJobId = this.activeJobIdByUri.get(uriKey);
        if (activeJobId) {
            try {
                await ToolExecutionService.getInstance().cancelExecution(activeJobId);
            } catch {
                // Best effort
            }
            this.activeJobIdByUri.delete(uriKey);
        }

        // Also cancel local engine
        await vscode.commands.executeCommand('quantlab.cancelStatsTest');

        // Return to configuration
        await this.initializeWithTest(uri, state.testId);
    }

    private sendState(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        const panel = this.webviewPanels.get(uriKey);
        const state = this.stateByUri.get(uriKey);

        if (panel && state) {
            void panel.webview.postMessage({
                type: 'setState',
                state,
                allTests: STATS_TEST_DEFINITIONS.map(t => ({
                    id: t.id,
                    label: t.label,
                    category: t.category
                }))
            });
        }
    }

    /**
     * Update progress from engine events
     */
    updateProgress(uri: vscode.Uri, progress: number, message: string): void {
        const uriKey = uri.toString();
        if (!this.webviewPanels.has(uriKey)) { return; }
        const state = this.stateByUri.get(uriKey);

        if (state?.type === 'running') {
            state.progress = progress;
            state.message = message;
            this.sendState(uri);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = getWebviewUri(webview, this.context.extensionUri, [
            'dist', 'webview', 'stats.js'
        ]);
        const styleUri = getWebviewUri(webview, this.context.extensionUri, [
            'dist', 'webview', 'stats-style.css'
        ]);
        const codiconsUri = getWebviewUri(webview, this.context.extensionUri, [
            'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'
        ]);

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <link href="${codiconsUri}" rel="stylesheet">
    <link href="${styleUri}" rel="stylesheet">
    <title>Stats</title>
</head>
<body>
    <div id="stats-root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
