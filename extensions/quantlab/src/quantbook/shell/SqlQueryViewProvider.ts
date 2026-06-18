/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-6 / R18 Wave E (2026-06-18) -- the Activity-Bar SQL-query sidebar provider.
//
// A WebviewViewProvider (NOT a TreeDataProvider like the live-python / dependencies views) because the SQL
// editor is multi-line -- it needs a real <textarea>, which a tree cannot host. Mirrors
// `ResourcesWebviewProvider` (CSP + nonce + getWebviewUri), but loads the QUANTBOOK webview bundle
// (`dist/webview/quantbook/sql-query.js`) so the existing `build:webviews:quantbook` gate compiles it.
//
// It is a THIN host shell: it resolves the focused grid via the CellGridPanel statics, runs the query
// through `CellGridPanel.materializeSqlQuery` (which owns the materialise -> recalc -> badge -> refresh
// pipeline + orphan-clear), and relays results/errors to the webview. All SQL execution + error surfacing
// is the engine's + the panel's; this file only parses the A1 target, validates non-empty SQL, and wires
// messages.

import * as vscode from 'vscode';

import { getNonce, getWebviewUri } from '../../utils/webview';
import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { GridSelection } from '../cellGrid/cellGridLogic';
import type { CellRangeJson } from '../types';
import { buildAvailableTables, formatA1Range, parseA1Range, validateSqlText } from '../shared/sqlPanelCore';

/** webview -> host messages. */
interface IncomingMessage {
	type: 'ready' | 'useSelection' | 'runSql' | 'clearResults';
	sql?: string;
	target?: string;
}

export class SqlQueryViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'quantlab.sqlQueryView';

	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) { }

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
		};
		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		this.disposables.push(
			webviewView.webview.onDidReceiveMessage((message: IncomingMessage) => void this.handleMessage(message)),
		);
		// Re-push the default target + table list when the focused grid changes (panel open/dispose/focus).
		// onDidChangeGrids does NOT fire on mere selection movement; and pushState() no-ops while the view is
		// hidden (it skips the O(N) snapshot), so this stays cheap.
		this.disposables.push(CellGridPanel.onDidChangeGrids(() => this.pushState()));
		// pushState() skips work while the view is hidden; refresh the moment it becomes visible again so the
		// table hint + default target are current when the user opens the panel.
		this.disposables.push(
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					this.pushState();
				}
			}),
		);

		webviewView.onDidDispose(() => {
			this.disposables.forEach(d => d.dispose());
			this.disposables = [];
			this.view = undefined;
		});
	}

	private postMessage(message: unknown): void {
		if (this.view === undefined) {
			return;
		}
		// Log non-delivery (No-Fallbacks): a dropped post would otherwise silently lose an error/warning/result.
		void this.view.webview.postMessage(message).then(
			delivered => {
				if (!delivered) {
					console.warn('[SqlQueryViewProvider] postMessage was not delivered (webview hidden or not ready)');
				}
			},
			err => {
				console.error('[SqlQueryViewProvider] postMessage failed:', err);
			},
		);
	}

	private async handleMessage(message: IncomingMessage): Promise<void> {
		// The webview is an UNTRUSTED boundary: validate field shapes and never let a drifted/malformed message
		// become an unhandled rejection that leaves the panel stuck (No-Fallbacks -- surface it, don't swallow).
		try {
			switch (message.type) {
				case 'ready':
					this.pushState();
					break;
				case 'useSelection':
					this.pushTarget();
					break;
				case 'runSql':
					this.runSql(
						typeof message.sql === 'string' ? message.sql : '',
						typeof message.target === 'string' ? message.target : '',
					);
					break;
				case 'clearResults':
					this.clearResults();
					break;
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[SqlQueryViewProvider] message handling failed: ${detail}`);
			this.postMessage({ type: 'runResult', ok: false, error: `Internal error: ${detail}` });
		}
	}

	/** Push the full panel state: whether a grid is focused, the default target (its selection), and the
	 *  available-tables hint list. Triggered on `ready`, on focus change, and after a run. */
	private pushState(): void {
		// Perf (audit MED): do nothing for a hidden/closed view. retainContextWhenHidden keeps this provider's
		// onDidChangeGrids subscription alive while the SQL view is collapsed, and snapshot() is O(N); we refresh
		// on onDidChangeVisibility when the view returns.
		if (this.view === undefined || !this.view.visible) {
			return;
		}
		// A grid is "available" iff a panel is FOCUSED -- this does NOT require a reported selection (audit MED):
		// runSql/clearResults need only the session, and the panel must enable even before the user clicks a cell.
		const panel = CellGridPanel.focusedLocalPanel();
		if (panel === undefined) {
			this.postMessage({ type: 'state', hasGrid: false });
			return;
		}
		// The default target is a CONVENIENCE from the current selection (if any) -- absent before the first click.
		const selection = CellGridPanel.focusedGridSelection();
		const defaultTarget = selection !== undefined ? selectionToTarget(selection.selection) : undefined;
		// The table hint is a CONVENIENCE; a snapshot() failure must not break the panel -- surface it as a
		// hint error (No-Fallbacks: logged + shown), the editor still works.
		try {
			const sheets = panel.session.listSheets();
			const snapshot = panel.session.snapshot();
			const tables = buildAvailableTables({ sheets, tables: snapshot.tables ?? [] });
			this.postMessage({ type: 'state', hasGrid: true, defaultTarget, tables });
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[SqlQueryViewProvider] table hint read failed: ${detail}`);
			this.postMessage({ type: 'state', hasGrid: true, defaultTarget, tablesError: detail });
		}
	}

	/** Respond to the webview's "Use selection" button with the LIVE focused-grid selection as an A1 target. */
	private pushTarget(): void {
		const focused = CellGridPanel.focusedGridSelection();
		if (focused === undefined) {
			this.postMessage({ type: 'runResult', ok: false, error: 'Open a sheet and select a target range first.' });
			return;
		}
		this.postMessage({ type: 'target', defaultTarget: selectionToTarget(focused.selection) });
	}

	private runSql(rawSql: string, rawTarget: string): void {
		const validated = validateSqlText(rawSql);
		if (!validated.ok) {
			this.postMessage({ type: 'runResult', ok: false, error: validated.error });
			return;
		}
		// Resolve via focusedLocalPanel (session + sheet) -- NOT focusedGridSelection, which requires a reported
		// selection. The target comes from the typed A1 string, so a fresh grid the user has not clicked yet must
		// still be runnable (audit MED).
		const panel = CellGridPanel.focusedLocalPanel();
		if (panel === undefined) {
			this.postMessage({ type: 'runResult', ok: false, error: 'Open a sheet first.' });
			return;
		}
		const parsed = parseA1Range(rawTarget);
		if (!parsed.ok) {
			this.postMessage({ type: 'runResult', ok: false, error: parsed.error });
			return;
		}
		const target: CellRangeJson = {
			sheet: panel.sheet,
			startRow: parsed.rect.startRow,
			startCol: parsed.rect.startCol,
			endRow: parsed.rect.endRow,
			endCol: parsed.rect.endCol,
		};
		const result = CellGridPanel.materializeSqlQuery(panel.session, target, validated.sql);
		if (result.ok) {
			this.postMessage({ type: 'runResult', ok: true, warning: result.warning, target: formatA1Range(parsed.rect) });
			this.pushState();
		} else {
			this.postMessage({ type: 'runResult', ok: false, error: result.error });
		}
	}

	private clearResults(): void {
		// focusedLocalPanel (no selection required) -- clearing needs only the session (audit MED).
		const panel = CellGridPanel.focusedLocalPanel();
		if (panel === undefined) {
			this.postMessage({ type: 'runResult', ok: false, error: 'Open a sheet first.' });
			return;
		}
		const result = CellGridPanel.clearSqlResults(panel.session);
		if (result.ok) {
			this.postMessage({ type: 'runResult', ok: true, cleared: result.cleared, warning: result.warning });
		} else {
			this.postMessage({ type: 'runResult', ok: false, error: result.error });
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = getWebviewUri(webview, this.extensionUri, ['dist', 'webview', 'quantbook', 'sql-query.js']);
		const styleUri = getWebviewUri(webview, this.extensionUri, ['dist', 'webview', 'quantbook', 'sql-query-style.css']);
		const nonce = getNonce();

		// CSP: scripts are nonce-gated (no unsafe-inline on script-src). style-src keeps 'unsafe-inline' to match
		// the hardened sibling ResourcesWebviewProvider -- VS Code injects the theme `--vscode-*` variables via an
		// inline <style> block, so dropping it would break theming; our own styles are a linked local stylesheet.
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<link href="${styleUri}" rel="stylesheet">
	<title>SQL Query</title>
</head>
<body>
	<div id="sql-root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** Normalise a grid selection's anchor/focus to an inclusive rect, then format it as an A1 target string. */
function selectionToTarget(selection: GridSelection): string {
	return formatA1Range({
		startRow: Math.min(selection.anchorRow, selection.focusRow),
		startCol: Math.min(selection.anchorCol, selection.focusCol),
		endRow: Math.max(selection.anchorRow, selection.focusRow),
		endCol: Math.max(selection.anchorCol, selection.focusCol),
	});
}
