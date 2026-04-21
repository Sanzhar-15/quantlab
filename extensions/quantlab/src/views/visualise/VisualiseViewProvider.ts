/*---------------------------------------------------------------------------------------------
 *  Visualise View Provider - Custom editor for data file visualization
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getWebviewUri, getNonce } from '../../utils/webview';
import { ColumnInfo } from '../../types/data';

interface VisualiseMessage {
	type: 'ready' | 'changeChart' | 'updateConfig';
	chartType?: string;
	config?: Record<string, unknown>;
}

interface VisualiseState {
	dataFile: string;
	columns: ColumnInfo[];
	chartType: 'line' | 'bar' | 'scatter' | 'histogram' | 'heatmap';
	selectedColumns: string[];
	preview?: {
		rows: number;
		sample: Record<string, unknown>[];
	};
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
				vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
			]
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		// Handle messages from webview — scoped to this panel's lifetime
		const panelDisposables: vscode.Disposable[] = [];
		panelDisposables.push(
			webviewPanel.webview.onDidReceiveMessage(
				(message: VisualiseMessage) => this.handleMessage(uri, message)
			)
		);

		// Cleanup on dispose
		webviewPanel.onDidDispose(() => {
			for (const d of panelDisposables) { d.dispose(); }
			panelDisposables.length = 0;
			this.webviewPanels.delete(uriKey);
			this.stateByUri.delete(uriKey);
		});

		// Initialize state
		await this.initializeState(uri);
	}

	private async handleMessage(uri: vscode.Uri, message: VisualiseMessage): Promise<void> {
		const uriKey = uri.toString();

		switch (message.type) {
			case 'ready':
				this.sendState(uri);
				break;

			case 'changeChart':
				if (message.chartType) {
					const state = this.stateByUri.get(uriKey);
					if (state) {
						state.chartType = message.chartType as VisualiseState['chartType'];
						this.sendState(uri);
					}
				}
				break;

			case 'updateConfig':
				if (message.config) {
					const state = this.stateByUri.get(uriKey);
					if (state) {
						if (Array.isArray(message.config.selectedColumns)) {
							state.selectedColumns = message.config.selectedColumns as string[];
						}
						this.sendState(uri);
					}
				}
				break;
		}
	}

	private async initializeState(uri: vscode.Uri): Promise<void> {
		const uriKey = uri.toString();

		// Load column info from data file
		const columns = await this.loadColumnInfo(uri);

		// Load preview data
		const preview = await this.loadPreview(uri);

		// Select first numeric column by default
		const numericColumns = columns.filter(
			c => c.dtype === 'float64' || c.dtype === 'int64'
		);
		const selectedColumns = numericColumns.length > 0
			? [numericColumns[0].name]
			: [];

		this.stateByUri.set(uriKey, {
			dataFile: uri.fsPath,
			columns,
			chartType: 'line',
			selectedColumns,
			preview
		});

		this.sendState(uri);
	}

	private async loadColumnInfo(uri: vscode.Uri): Promise<ColumnInfo[]> {
		try {
			const result = await vscode.commands.executeCommand<ColumnInfo[]>(
				'quantlab.getDataFileColumns',
				uri.fsPath
			);
			return result ?? [];
		} catch {
			return [];
		}
	}

	private async loadPreview(uri: vscode.Uri): Promise<{ rows: number; sample: Record<string, unknown>[] } | undefined> {
		try {
			const result = await vscode.commands.executeCommand<{ rows: number; sample: Record<string, unknown>[] }>(
				'quantlab.getDataFilePreview',
				uri.fsPath,
				100 // Sample size
			);
			return result ?? undefined;
		} catch {
			return undefined;
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
			'dist', 'webview', 'visualise-style.css'
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
    <title>Visualise</title>
</head>
<body>
    <div id="visualise-root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
