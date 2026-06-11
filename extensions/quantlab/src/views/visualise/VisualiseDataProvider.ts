/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VisualiseDataProvider -- VS Code CustomReadonlyEditorProvider for
 * `*.csv | *.tsv | *.parquet` (the same set the qviz daemon's
 * ALLOWED_EXTENSIONS and persist.ts allowlist accept -- keep all three in sync;
 * xlsx was removed from the selector because the daemon rejects it).
 *
 * Phase 5 step A.3 (audit-merged plan). This is the data-file entry point
 * for the Visualise builder. Unlike `VisualiseSpecProvider` (which edits
 * `.qviz.json` documents), the data file is the SOURCE for visualization;
 * it is not edited by this view. CustomReadonlyEditorProvider gives us
 * the right semantics:
 *
 *   - VS Code does not show the editor as "modified".
 *   - Save / Save As are not menu options for this editor (the user
 *     instead runs `Save Spec As...` from the webview to write a separate
 *     `.qviz.json`).
 *   - Cmd+S in this editor is a no-op (correct: there's nothing to save
 *     in the source file).
 *   - VS Code reloads the editor when the file changes externally.
 *
 * Step A keeps the legacy `quantlab.getDataFileColumns` /
 * `quantlab.getDataFilePreview` commands wired through the existing
 * `webview/visualise/` UI so users opening a CSV today see no regression.
 * Step D (MVP review cut) replaces both the webview and the data plumbing
 * with the qviz daemon-client + new builder UI.
 */

import * as vscode from 'vscode';

import type { ColumnInfo } from '../../types/data';
import { getNonce, getWebviewUri } from '../../utils/webview';

/** Inbound from webview (same protocol as the legacy stub).
 *  Discriminated union so the type system catches missing fields per
 *  message kind (audit fix: the prior loose shape silently dropped
 *  malformed messages instead of surfacing the protocol violation). */
type DataWebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'changeChart'; readonly chartType: LegacyVisualiseState['chartType'] }
	| { readonly type: 'updateConfig'; readonly config: { selectedColumns: readonly string[] } };

/** Megaudit M-35: trust-boundary validator. Returns null on
 *  any deviation from the documented shape. The webview is untrusted;
 *  the previous direct cast `(msg: DataWebviewMessage) => ...` left
 *  malformed payloads to crash the handler at first dot-access. */
const ALLOWED_LEGACY_CHART_TYPES = new Set<LegacyVisualiseState['chartType']>([
	'line', 'bar', 'scatter', 'histogram', 'heatmap',
]);
function validateDataWebviewMessage(raw: unknown): DataWebviewMessage | null {
	if (raw === null || typeof raw !== 'object') { return null; }
	const obj = raw as Record<string, unknown>;
	if (typeof obj.type !== 'string') { return null; }
	if (obj.type === 'ready') { return { type: 'ready' }; }
	if (obj.type === 'changeChart') {
		if (typeof obj.chartType !== 'string') { return null; }
		if (!ALLOWED_LEGACY_CHART_TYPES.has(obj.chartType as LegacyVisualiseState['chartType'])) {
			return null;
		}
		return { type: 'changeChart', chartType: obj.chartType as LegacyVisualiseState['chartType'] };
	}
	if (obj.type === 'updateConfig') {
		const cfg = obj.config;
		if (cfg === null || typeof cfg !== 'object') { return null; }
		const selected = (cfg as { selectedColumns?: unknown }).selectedColumns;
		if (!Array.isArray(selected) || !selected.every(s => typeof s === 'string')) { return null; }
		return { type: 'updateConfig', config: { selectedColumns: selected as string[] } };
	}
	return null;
}

/**
 * The legacy state shape sent to the webview. Kept intact for Step A so
 * the existing `webview/visualise/index.ts` UI keeps working without
 * change. Step D replaces this with the qviz protocol.
 */
interface LegacyVisualiseState {
	readonly dataFile: string;
	readonly columns: readonly ColumnInfo[];
	readonly chartType: 'line' | 'bar' | 'scatter' | 'histogram' | 'heatmap';
	readonly selectedColumns: readonly string[];
	readonly preview?: { readonly rows: number; readonly sample: readonly Record<string, unknown>[] };
}

class DataDocument implements vscode.CustomDocument {
	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	constructor(readonly uri: vscode.Uri) { }

	dispose(): void {
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
	}
}

export class VisualiseDataProvider implements vscode.CustomReadonlyEditorProvider<DataDocument> {
	public static readonly viewType = 'quantlab.visualiseView';

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new VisualiseDataProvider(context);
		return vscode.window.registerCustomEditorProvider(
			VisualiseDataProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	/** Per-panel state, keyed by document URI string. */
	private readonly stateByUri = new Map<string, LegacyVisualiseState>();
	private readonly panelByUri = new Map<string, vscode.WebviewPanel>();

	constructor(private readonly context: vscode.ExtensionContext) { }

	async openCustomDocument(
		uri: vscode.Uri,
		_openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken,
	): Promise<DataDocument> {
		return new DataDocument(uri);
	}

	async resolveCustomEditor(
		document: DataDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const key = document.uri.toString();
		this.panelByUri.set(key, webviewPanel);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
				vscode.Uri.joinPath(
					this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist',
				),
			],
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		const disposables: vscode.Disposable[] = [];
		disposables.push(webviewPanel.webview.onDidReceiveMessage(
			(rawMsg: unknown) => {
				// Megaudit M-35: validate at the trust boundary. The
				// webview is untrusted; the prior code cast to
				// `DataWebviewMessage` blindly. A malformed message
				// could throw uncaught (e.g., reading `.chartType` on
				// undefined) or silently route to the default case
				// which threw a vague "unknown message" error.
				const validated = validateDataWebviewMessage(rawMsg);
				if (validated === null) {
					console.error(
						`VisualiseDataProvider: malformed webview message; dropped: ${JSON.stringify(rawMsg)}`,
					);
					return;
				}
				void this.handleMessage(document.uri, validated);
			},
		));

		webviewPanel.onDidDispose(() => {
			for (const d of disposables) { d.dispose(); }
			// Audit-fix M9: only clear the registry entry if it STILL points
			// at this panel. Otherwise close-then-reopen-fast would have the
			// old panel's late-firing dispose handler delete the new panel's
			// freshly-set entry, orphaning it.
			if (this.panelByUri.get(key) === webviewPanel) {
				this.panelByUri.delete(key);
				this.stateByUri.delete(key);
			}
		});

		await this.initializeState(document.uri);
	}

	// -----------------------------------------------------------------------
	// internals (legacy state flow; Step D replaces with qviz daemon-client)
	// -----------------------------------------------------------------------

	private async handleMessage(uri: vscode.Uri, message: DataWebviewMessage): Promise<void> {
		const key = uri.toString();
		switch (message.type) {
			case 'ready':
				this.sendState(uri);
				return;
			case 'changeChart': {
				const state = this.stateByUri.get(key);
				if (!state) {
					// `state` not in the map only happens between
					// resolveCustomEditor's panel registration and
					// initializeState's first set -- a window so small
					// the webview can't have produced this message yet.
					// Surface as a protocol violation rather than swallow.
					console.warn(`changeChart received before state initialized for ${key}`);
					return;
				}
				this.stateByUri.set(key, { ...state, chartType: message.chartType });
				this.sendState(uri);
				return;
			}
			case 'updateConfig': {
				const state = this.stateByUri.get(key);
				if (!state) {
					console.warn(`updateConfig received before state initialized for ${key}`);
					return;
				}
				if (!Array.isArray(message.config.selectedColumns)) {
					console.warn(
						`updateConfig.selectedColumns must be an array, got ${typeof message.config.selectedColumns}`,
					);
					return;
				}
				this.stateByUri.set(key, {
					...state,
					selectedColumns: message.config.selectedColumns,
				});
				this.sendState(uri);
				return;
			}
			default: {
				// Megaudit Theme E (E15, 2026-05-13): the compile-time
				// `exhaustive: never` already enforces enumeration at
				// build time. Throwing at runtime here would surface as
				// an unhandled promise rejection (handleMessage is
				// invoked via `void`), potentially crashing the
				// extension host. Log + return instead.
				const exhaustive: never = message;
				console.error(`VisualiseDataProvider: unknown DataWebviewMessage at runtime: ${JSON.stringify(exhaustive)}`);
				return;
			}
		}
	}

	private async initializeState(uri: vscode.Uri): Promise<void> {
		// Audit-fix C3+M1: the data commands now THROW on inspection
		// failure (Python missing, parquet corrupt, etc). Catch + surface
		// the error to the user as a notification, then render an empty
		// state so the panel doesn't crash. CLAUDE.md "explicit error
		// handling at system boundaries" exception applies; the underlying
		// error is logged via `console.error` AND surfaced via showErrorMessage.
		let columns: ColumnInfo[] = [];
		let preview: { rows: number; sample: Record<string, unknown>[] } | undefined;
		try {
			columns = await this.loadColumnInfo(uri);
			preview = await this.loadPreview(uri);
		} catch (err) {
			const message = (err as Error)?.message ?? String(err);
			console.error(`VisualiseDataProvider: inspection failed for ${uri.fsPath}: ${message}`);
			void vscode.window.showErrorMessage(
				`Couldn't load ${uri.fsPath}: ${message}`,
			);
			// columns/preview already at safe defaults; fall through to
			// render the empty state. The user sees an explicit error
			// notification AND an empty panel -- not a silent blank.
		}
		const numericColumns = columns.filter(c => c.dtype === 'float64' || c.dtype === 'int64');
		const selectedColumns = numericColumns.length > 0 ? [numericColumns[0].name] : [];
		this.stateByUri.set(uri.toString(), {
			dataFile: uri.fsPath,
			columns,
			chartType: 'line',
			selectedColumns,
			preview,
		});
		this.sendState(uri);
	}

	/**
	 * The underlying command throws DataInspectionError on failure -- we
	 * propagate it (the caller wraps in a try/catch + user-facing notification).
	 */
	private async loadColumnInfo(uri: vscode.Uri): Promise<ColumnInfo[]> {
		const result = await vscode.commands.executeCommand<ColumnInfo[]>(
			'quantlab.getDataFileColumns', uri.fsPath,
		);
		// `vscode.commands.executeCommand` types its return as `T | undefined`
		// (the command may not be registered). The command throws on real
		// failures; an undefined return here would mean the registration is
		// gone -- which is itself a load-time misconfiguration we surface.
		if (result === undefined) {
			throw new Error('quantlab.getDataFileColumns command not registered');
		}
		return result;
	}

	private async loadPreview(
		uri: vscode.Uri,
	): Promise<{ rows: number; sample: Record<string, unknown>[] }> {
		const result = await vscode.commands.executeCommand<{ rows: number; sample: Record<string, unknown>[] }>(
			'quantlab.getDataFilePreview', uri.fsPath, 100,
		);
		if (result === undefined) {
			throw new Error('quantlab.getDataFilePreview command not registered');
		}
		return result;
	}

	private sendState(uri: vscode.Uri): void {
		const key = uri.toString();
		const panel = this.panelByUri.get(key);
		const state = this.stateByUri.get(key);
		if (panel && state) {
			void panel.webview.postMessage({ type: 'setState', state });
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = getWebviewUri(webview, this.context.extensionUri, [
			'dist', 'webview', 'visualise.js',
		]);
		const styleUri = getWebviewUri(webview, this.context.extensionUri, [
			'dist', 'webview', 'visualise-style.css',
		]);
		const codiconsUri = getWebviewUri(webview, this.context.extensionUri, [
			'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
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
