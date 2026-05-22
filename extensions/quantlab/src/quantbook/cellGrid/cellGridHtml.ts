/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V3.2.a scaffold (2026-05-22) -- pure HTML-building
 * functions for the cell-grid webview.
 *
 * Split from `cellGridPanel.ts` so unit tests can import + exercise
 * these without pulling the `vscode` module (which is host-only and
 * would force every test file to install the vscode shim).
 *
 * Pure functions only -- no `this`, no side effects, no `vscode`
 * import. The host-side panel logic lives in `cellGridPanel.ts`.
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../types';

/**
 * Build the webview HTML for a cell-snapshot.
 *
 * **CSP note**: `default-src 'none'` + `style-src 'unsafe-inline'`.
 * Inline styles are needed for VS Code theme colour variables;
 * scripts stay disabled at V3.2.a. V3.2.b's message-passing will
 * require `script-src` to widen + a nonce per VS Code's webview
 * security guidance.
 */
export function buildHtml(snapshot: QuantbookCellSnapshot): string {
	const rows = renderRows(snapshot.entries);
	const meta = `snapshot_format_version=${snapshot.snapshot_format_version}; entries=${snapshot.entries.length}`;
	const body = snapshot.entries.length === 0
		? '<div class="empty">(empty -- no PutValue ops on this sheet)</div>'
		: `<table><thead><tr><th>Row</th><th>Col</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
	// CSS is concatenated as a single-line string to avoid the
	// "Bad whitespace indentation" hygiene rule firing on the CSS
	// rules' inner indentation. The rendered HTML is identical;
	// the readability cost is small for a static stylesheet this
	// short. V3.2.b may move the CSS to an asWebviewUri-loaded
	// `.css` file when message-passing lands.
	const css = [
		'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:16px;}',
		'h2{margin-top:0;}',
		'table{border-collapse:collapse;width:auto;}',
		'th,td{padding:4px 12px;border:1px solid var(--vscode-panel-border);text-align:left;}',
		'th{background:var(--vscode-toolbar-hoverBackground);font-weight:600;}',
		'.meta{color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:12px;}',
		'.empty{color:var(--vscode-descriptionForeground);font-style:italic;}',
		'.kind{color:var(--vscode-descriptionForeground);font-size:11px;margin-left:8px;}',
	].join('');
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Quantbook Cell Grid</title>
<style>${css}</style>
</head>
<body>
<h2>Quantbook Cell Grid -- Sheet ${escapeHtml(String(snapshot.sheet))}</h2>
<div class="meta">${escapeHtml(meta)}</div>
${body}
</body>
</html>`;
}

function renderRows(entries: QuantbookCellSnapshot['entries']): string {
	return entries
		.map(e => {
			const valueStr = formatCellValue(e.value);
			return `<tr><td>${e.row}</td><td>${e.col}</td><td>${escapeHtml(valueStr)}<span class="kind">[${escapeHtml(e.value.kind)}]</span></td></tr>`;
		})
		.join('');
}

/**
 * Render a cell value for display. Type-narrowed via the
 * {@link QuantbookCellValue} tagged-union; the `switch` is
 * exhaustive (TS infers `never` in any unreachable branch as a
 * compile-time correctness pin).
 */
export function formatCellValue(value: QuantbookCellValue): string {
	switch (value.kind) {
		case 'number':
			return String(value.value);
		case 'boolean':
			return value.value ? 'TRUE' : 'FALSE';
		case 'text':
			return value.value;
		case 'error':
			return value.value;
		case 'pending':
			return '(pending)';
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => {
		switch (c) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case '\'': return '&#39;';
			default: return c;
		}
	});
}
