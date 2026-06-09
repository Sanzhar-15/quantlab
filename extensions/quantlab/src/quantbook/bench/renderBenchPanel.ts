/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2 BAKEOFF (2026-06-09) -- the render-bench host panel.**
 *
 * A thin host shell for the `render-bench` webview (`webview/render-bench/`). It mirrors
 * `cellGridPanel.ts`'s persistent-bundle CSP/asWebviewUri discipline (a nonce-gated `<script src>`
 * + a `default-src 'none'` CSP, the bundle loaded from `dist/webview/quantbook/`), but is DELIBERATELY
 * minimal: there is NO session, NO write path, NO snapshot push. The bench synthesizes its own data
 * and drives the REAL `RenderOrchestrator` entirely webview-side; the host only loads the shell and
 * records the `benchResults` the webview posts back (to the Quantbook output channel) so a run is
 * persisted for the operator / CI.
 *
 * Single instance: re-running the command reveals the existing panel (the bench re-runs in place).
 */

import * as vscode from 'vscode';

import { getNonce, getWebviewUri } from '../../utils/webview';

const VIEW_TYPE = 'quantlab.quantbookRenderBench';

let current: vscode.WebviewPanel | undefined;

/**
 * Open (or reveal) the render-bench panel. The bench bundle runs entirely in the webview; this host
 * loads the shell + logs the results the webview posts. Returns the panel.
 */
export function showRenderBenchPanel(
	context: vscode.ExtensionContext,
	log: vscode.OutputChannel,
): vscode.WebviewPanel {
	if (current !== undefined) {
		current.reveal(vscode.ViewColumn.Active, false);
		return current;
	}
	const panel = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		'Quantbook Render Bench',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			// Narrowed to the bundle directory (parity with cellGridPanel.ts).
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'quantbook')],
		},
	);
	current = panel;

	const disposables: vscode.Disposable[] = [];
	panel.webview.onDidReceiveMessage((raw: unknown) => {
		const msg = raw as { type?: unknown; text?: unknown } | null;
		if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') {
			return;
		}
		if (msg.type === 'benchReady') {
			log.appendLine('[render-bench] webview loaded; click "Run all datasets" to measure the FE-2 gates.');
			return;
		}
		if (msg.type === 'benchResults') {
			// Persist the results to the output channel (the operator/CI reads them; the webview also
			// shows them inline). No-Fallbacks: a malformed payload is surfaced, not silently dropped.
			if (typeof msg.text === 'string') {
				log.appendLine('[render-bench] results:\n' + msg.text);
			} else {
				log.appendLine('[render-bench] received a benchResults message with no text payload: ' + JSON.stringify(raw));
			}
			return;
		}
		log.appendLine('[render-bench] unknown message from the bench webview: ' + String(msg.type));
	}, undefined, disposables);

	panel.onDidDispose(() => {
		for (const d of disposables) {
			d.dispose();
		}
		if (current === panel) {
			current = undefined;
		}
	}, undefined, disposables);

	panel.webview.html = buildBenchShellHtml(panel.webview, context.extensionUri);
	return panel;
}

/**
 * The bench shell HTML. Mirrors `cellGridPanel.ts`'s `buildShellHtml`: a nonce-based CSP
 * (`default-src 'none'`; `style-src ${cspSource} 'unsafe-inline'`; `script-src 'nonce-...'`;
 * `img-src ${cspSource}`), the bundle + stylesheet loaded via `asWebviewUri`. No data in the HTML.
 */
function buildBenchShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	const scriptUri = getWebviewUri(webview, extensionUri, ['dist', 'webview', 'quantbook', 'render-bench.js']);
	const styleUri = getWebviewUri(webview, extensionUri, ['dist', 'webview', 'quantbook', 'render-bench-style.css']);
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${styleUri}" rel="stylesheet">
<title>Quantbook Render Bench</title>
</head>
<body>
<div id="bench-root">Loading Quantbook render bench&hellip;</div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
