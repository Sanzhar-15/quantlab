# Prompt 14: Visualise View Provider

## Objective
Create the VisualiseViewProvider custom editor for data file visualization.

## Context
When user clicks "Visualise" button on a data file, this view opens showing an interactive data table and chart options.

## File to Create

### `extensions/quantlab/src/views/visualise/VisualiseViewProvider.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Visualise View Provider - Custom editor for data file visualization
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewUri, getNonce } from '../../utils/webview';
import { ColumnInfo, DataFrameResult } from '../../types/data';

interface VisualiseMessage {
    type: 'ready' | 'requestData' | 'changeChart' | 'selectColumns' | 'export';
    columns?: string[];
    chartType?: string;
    offset?: number;
    limit?: number;
}

interface VisualiseState {
    filePath: string;
    fileName: string;
    fileType: string;
    columns: ColumnInfo[];
    selectedColumns: string[];
    chartType: 'table' | 'line' | 'scatter' | 'histogram' | 'heatmap';
    data: DataFrameResult | null;
    isLoading: boolean;
    error: string | null;
}

export class VisualiseViewProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'quantlab.visualiseView';
    private static instance: VisualiseViewProvider;

    private readonly webviewPanels = new Map<string, vscode.WebviewPanel>();
    private readonly stateByUri = new Map<string, VisualiseState>();

    private constructor(
        private readonly context: vscode.ExtensionContext
    ) {}

    static getInstance(context?: vscode.ExtensionContext): VisualiseViewProvider {
        if (!VisualiseViewProvider.instance) {
            if (!context) {
                throw new Error('VisualiseViewProvider must be initialized with context');
            }
            VisualiseViewProvider.instance = new VisualiseViewProvider(context);
        }
        return VisualiseViewProvider.instance;
    }

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = VisualiseViewProvider.getInstance(context);
        return vscode.window.registerCustomEditorProvider(
            VisualiseViewProvider.viewType,
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
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules')
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Handle messages
        webviewPanel.webview.onDidReceiveMessage(
            (message: VisualiseMessage) => this.handleMessage(uri, message),
            undefined,
            this.context.subscriptions
        );

        // Cleanup on dispose
        webviewPanel.onDidDispose(() => {
            this.webviewPanels.delete(uriKey);
            this.stateByUri.delete(uriKey);
        });

        // Initialize state
        await this.initializeState(uri);
    }

    private async initializeState(uri: vscode.Uri): Promise<void> {
        const uriKey = uri.toString();
        const filePath = uri.fsPath;
        const ext = path.extname(filePath).toLowerCase().slice(1);

        // Initialize with loading state
        this.stateByUri.set(uriKey, {
            filePath,
            fileName: path.basename(filePath),
            fileType: ext,
            columns: [],
            selectedColumns: [],
            chartType: 'table',
            data: null,
            isLoading: true,
            error: null
        });

        this.sendState(uri);

        try {
            // Load column info
            const columns = await vscode.commands.executeCommand<ColumnInfo[]>(
                'quantlab.getDataFileColumns',
                filePath
            );

            if (!columns) {
                throw new Error('Failed to load column information');
            }

            // Load initial data preview
            const data = await vscode.commands.executeCommand<DataFrameResult>(
                'quantlab.getDataPreview',
                filePath,
                { limit: 1000 }
            );

            // Update state
            const state = this.stateByUri.get(uriKey)!;
            state.columns = columns;
            state.selectedColumns = columns.slice(0, 10).map(c => c.name); // First 10 cols
            state.data = data ?? null;
            state.isLoading = false;

            this.sendState(uri);

        } catch (err) {
            const state = this.stateByUri.get(uriKey)!;
            state.isLoading = false;
            state.error = err instanceof Error ? err.message : String(err);
            this.sendState(uri);
        }
    }

    private async handleMessage(uri: vscode.Uri, message: VisualiseMessage): Promise<void> {
        const uriKey = uri.toString();
        const state = this.stateByUri.get(uriKey);
        if (!state) return;

        switch (message.type) {
            case 'ready':
                this.sendState(uri);
                break;

            case 'requestData':
                await this.loadData(uri, message.offset, message.limit);
                break;

            case 'selectColumns':
                if (message.columns) {
                    state.selectedColumns = message.columns;
                    await this.loadData(uri);
                }
                break;

            case 'changeChart':
                if (message.chartType) {
                    state.chartType = message.chartType as VisualiseState['chartType'];
                    this.sendState(uri);
                }
                break;

            case 'export':
                await this.exportData(uri);
                break;
        }
    }

    private async loadData(
        uri: vscode.Uri,
        offset?: number,
        limit?: number
    ): Promise<void> {
        const uriKey = uri.toString();
        const state = this.stateByUri.get(uriKey);
        if (!state) return;

        state.isLoading = true;
        this.sendState(uri);

        try {
            const data = await vscode.commands.executeCommand<DataFrameResult>(
                'quantlab.getDataPreview',
                state.filePath,
                {
                    limit: limit ?? 1000,
                    columns: state.selectedColumns.length > 0 ? state.selectedColumns : undefined
                }
            );

            state.data = data ?? null;
            state.isLoading = false;
            state.error = null;

        } catch (err) {
            state.isLoading = false;
            state.error = err instanceof Error ? err.message : String(err);
        }

        this.sendState(uri);
    }

    private async exportData(uri: vscode.Uri): Promise<void> {
        const state = this.stateByUri.get(uri.toString());
        if (!state?.data) return;

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(state.filePath.replace(/\.[^.]+$/, '_export.csv')),
            filters: { 'CSV': ['csv'] }
        });

        if (saveUri) {
            // Convert data to CSV
            const columns = Object.keys(state.data.data);
            const rows = state.data.rowCount;
            let csv = columns.join(',') + '\n';

            for (let i = 0; i < rows; i++) {
                const row = columns.map(col => {
                    const val = state.data!.data[col][i];
                    if (val === null || val === undefined) return '';
                    if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
                    return String(val);
                });
                csv += row.join(',') + '\n';
            }

            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(csv, 'utf8'));
            void vscode.window.showInformationMessage(`Exported to ${saveUri.fsPath}`);
        }
    }

    private sendState(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        const panel = this.webviewPanels.get(uriKey);
        const state = this.stateByUri.get(uriKey);

        if (panel && state) {
            void panel.webview.postMessage({
                type: 'setState',
                state
            });
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = getWebviewUri(webview, this.context.extensionUri, [
            'dist', 'webview', 'visualise.js'
        ]);
        const styleUri = getWebviewUri(webview, this.context.extensionUri, [
            'dist', 'webview', 'visualise.css'
        ]);
        const codiconsUri = getWebviewUri(webview, this.context.extensionUri, [
            'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'
        ]);

        // Plotly for charts
        const plotlyUri = getWebviewUri(webview, this.context.extensionUri, [
            'node_modules', 'plotly.js-dist-min', 'plotly.min.js'
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
    <title>Visualise</title>
</head>
<body>
    <div id="visualise-root"></div>
    <script nonce="${nonce}" src="${plotlyUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
```

## Package.json Dependency

Add Plotly to package.json:

```json
{
    "devDependencies": {
        "plotly.js-dist-min": "^2.27.0"
    }
}
```

## Test

1. TypeScript compiles:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

2. Register provider (will be done in Prompt 17)

3. Open a data file, click "Visualise" button

4. Verify:
   - Data table renders
   - Column selection works
   - Chart type switching works

## Dependencies
- Prompt 13 (DataService) for data loading commands

## Next
Proceed to `15_Visualise_Webview_Script.md`
