# Prompt 09: Stats View Provider

## Objective
Create the StatsViewProvider custom editor for displaying statistical test configuration and results.

## Context
When user clicks a test in Resources panel, the Stats view opens as a custom editor on the data file. Uses the pending test pattern from DataViewManager.

## File to Create

### `extensions/quantlab/src/views/stats/StatsViewProvider.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Stats View Provider - Custom editor for statistical test configuration and results
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
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
import { ColumnInfo } from '../../types/data';

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

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(
            (message: StatsMessage) => this.handleMessage(uri, message),
            undefined,
            this.context.subscriptions
        );

        // Cleanup on dispose
        webviewPanel.onDidDispose(() => {
            this.webviewPanels.delete(uriKey);
            this.stateByUri.delete(uriKey);
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

            case 'backToConfig':
                // Return to configuration from results
                const state = this.stateByUri.get(uriKey);
                if (state && (state.type === 'results' || state.type === 'error')) {
                    await this.initializeWithTest(uri, state.testId);
                }
                break;
        }
    }

    private async initializeWithTest(uri: vscode.Uri, testId: string): Promise<void> {
        const uriKey = uri.toString();
        const testDef = getTestById(testId);

        if (!testDef) {
            this.stateByUri.set(uriKey, {
                type: 'error',
                testId,
                error: `Unknown test: ${testId}`,
                recoverable: false
            });
            this.sendState(uri);
            return;
        }

        // Load column info from data file
        const columns = await this.loadColumnInfo(uri);

        // Build initial state
        const initialParams: Record<string, unknown> = {};
        for (const param of testDef.parameters) {
            initialParams[param.id] = param.default;
        }

        this.stateByUri.set(uriKey, {
            type: 'configuration',
            testId,
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

    private async loadColumnInfo(uri: vscode.Uri): Promise<Array<{ name: string; dtype: string }>> {
        try {
            const result = await vscode.commands.executeCommand<ColumnInfo[]>(
                'quantlab.getDataFileColumns',
                uri.fsPath
            );
            return result?.map(c => ({ name: c.name, dtype: c.dtype })) ?? [];
        } catch {
            // Fallback: return empty array
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

        // Transition to running state
        this.stateByUri.set(uriKey, {
            type: 'running',
            testId: state.testId,
            testName: state.testName,
            progress: 0,
            message: 'Initializing...',
            startedAt
        });
        this.sendState(uri);

        try {
            // Execute test via engine
            const config: StatsTestConfig = {
                testId: state.testId,
                dataPath: state.dataFile,
                columns: state.selectedColumns,
                parameters: state.parameters
            };

            const result = await vscode.commands.executeCommand<StatsTestResult>(
                'quantlab.executeStatsTest',
                config,
                // Progress callback
                (progress: number, message: string) => {
                    this.updateProgress(uri, progress, message);
                }
            );

            if (result) {
                // Transition to results state
                this.stateByUri.set(uriKey, {
                    type: 'results',
                    testId: state.testId,
                    result,
                    durationMs: Date.now() - new Date(startedAt).getTime()
                });
            } else {
                throw new Error('No result returned from stats engine');
            }
        } catch (err) {
            this.stateByUri.set(uriKey, {
                type: 'error',
                testId: state.testId,
                error: err instanceof Error ? err.message : String(err),
                recoverable: true
            });
        }

        this.sendState(uri);
    }

    private async cancelTest(uri: vscode.Uri): Promise<void> {
        const uriKey = uri.toString();
        const state = this.stateByUri.get(uriKey);

        if (state?.type !== 'running') return;

        // Cancel via engine
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
            'dist', 'webview', 'stats.css'
        ]);
        // FIXED: Correct path for @vscode/codicons
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
```

## Test

1. Register provider in extension.ts (will be done in Prompt 17)
2. Open a CSV file
3. Click Action button (should open Resources panel)
4. Click a test in Pure Stats section
5. Stats view should open with test configuration
6. Cancel button should work during test execution

## Dependencies
- Prompt 04 (DataViewManager) - for pending test pattern
- Prompt 08 (StatsCatalog) - for test definitions
- Prompt 01 (types) - for state types

## Next
Proceed to `10_Stats_Webview_Script.md`
