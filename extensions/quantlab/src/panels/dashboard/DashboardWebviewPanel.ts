/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//  DashboardWebviewPanel -- Generic reusable webview panel factory for data dashboards.
//  Pattern follows QuantLabHome.ts: singleton per id, CSP with nonce, tokens.css.

import * as vscode from 'vscode';
import { ThemeProvider } from '../../ui/tokens/ThemeProvider';

export interface DashboardConfig<T> {
	id: string;
	title: string;
	fetchData: () => Promise<T>;
	renderBody: (data: T) => string;
}

interface DashboardEntry {
	panel: vscode.WebviewPanel;
	refresh: (loadingLabel: string) => Promise<void>;
}

const panels = new Map<string, DashboardEntry>();

export class DashboardWebviewPanel {
	static async show<T>(context: vscode.ExtensionContext, config: DashboardConfig<T>): Promise<void> {
		const existing = panels.get(config.id);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.One, false);
			// Re-reveal triggers a background data refresh so a panel opened
			// hours ago never sits on stale data.
			await existing.refresh('Refreshing...');
			return;
		}

		const themeProvider = ThemeProvider.getInstance();
		const panel = vscode.window.createWebviewPanel(
			config.id,
			config.title,
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [context.extensionUri],
			}
		);

		const tokensUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'media', 'tokens.css')
		);
		const themeStyles = themeProvider.getInlineStyles();
		const themeKey = `dashboard.${config.id}.${Date.now()}`;
		themeProvider.registerWebview(themeKey, panel.webview);

		let disposed = false;
		let refreshing = false;

		const refresh = async (loadingLabel: string): Promise<void> => {
			// Debounce: ignore refresh requests while one is already in flight,
			// otherwise the last-to-resolve response wins regardless of order.
			if (refreshing || disposed) {
				return;
			}
			refreshing = true;
			panel.webview.html = buildHtml(panel.webview.cspSource, tokensUri, themeStyles, config.title,
				`<div class="dash-loading">${escapeHtml(loadingLabel)}</div>`);
			try {
				const data = await config.fetchData();
				if (disposed) {
					return;
				}
				panel.webview.html = buildHtml(panel.webview.cspSource, tokensUri, themeStyles, config.title, config.renderBody(data));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[DashboardWebviewPanel] '${config.id}' data fetch failed:`, err);
				if (disposed) {
					return;
				}
				panel.webview.html = buildHtml(panel.webview.cspSource, tokensUri, themeStyles, config.title,
					`<div class="dash-error">Failed to load data: ${escapeHtml(msg)}</div>`);
			} finally {
				refreshing = false;
			}
		};

		panels.set(config.id, { panel, refresh });

		// Handle refresh messages from the webview's Refresh button.
		panel.webview.onDidReceiveMessage(async (msg: { type: string }) => {
			if (msg.type === 'refresh') {
				await refresh('Refreshing...');
			}
		});

		panel.onDidDispose(() => {
			disposed = true;
			panels.delete(config.id);
			themeProvider.unregisterWebview(themeKey);
		});

		// Initial load.
		await refresh('Loading...');
	}
}

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i++) { result += chars[Math.floor(Math.random() * chars.length)]; }
	return result;
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(cspSource: string, tokensUri: vscode.Uri, themeStyles: string, title: string, body: string): string {
	const n = nonce();
	// style-src MUST include cspSource or the linked tokens.css is silently
	// blocked and every dashboard renders without its design tokens.
	const csp = [
		`default-src 'none'`,
		`img-src ${cspSource} data:`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${n}'`,
	].join('; ');

	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${themeStyles}
	<link href="${tokensUri}" rel="stylesheet" />
	<title>${escapeHtml(title)}</title>
	<style nonce="${n}">
		/* All colors come from tokens.css (theme-aware --vscode-* chains);
			never fall back to fixed dark hex -- that breaks light theme. */
		body { padding: 24px 32px; font-family: var(--vscode-font-family, sans-serif); color: var(--ql-fg); background: var(--ql-base); }
		h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 12px; }
		.dash-refresh { background: none; border: 1px solid var(--ql-border); color: var(--ql-muted); border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
		.dash-refresh:hover { border-color: var(--ql-accent); color: var(--ql-accent); }
		.dash-loading, .dash-error { padding: 40px; text-align: center; color: var(--ql-muted); font-size: 14px; }
		.dash-error { color: var(--ql-error); }
		.dashboard-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
		.dashboard-table th { text-align: left; padding: 8px 12px; background: var(--ql-surface); border-bottom: 1px solid var(--ql-border); color: var(--ql-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
		.dashboard-table td { padding: 8px 12px; border-bottom: 1px solid var(--ql-border); color: var(--ql-fg); }
		.dashboard-table tr:hover td { background: var(--ql-hover); }
		.summary-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
		.summary-card { background: var(--ql-surface); border: 1px solid var(--ql-border); border-radius: 8px; padding: 16px; }
		.summary-card .label { font-size: 11px; color: var(--ql-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
		.summary-card .value { font-size: 20px; font-weight: 700; color: var(--ql-fg); }
		.summary-card .sub { font-size: 12px; color: var(--ql-muted); margin-top: 4px; }
		.news-list { list-style: none; padding: 0; margin: 16px 0; }
		.news-list li { padding: 12px 0; border-bottom: 1px solid var(--ql-border); }
		.news-list .news-title { font-size: 14px; font-weight: 600; color: var(--ql-fg); margin-bottom: 4px; }
		.news-list .news-meta { font-size: 11px; color: var(--ql-muted); }
		.news-list .news-summary { font-size: 13px; color: var(--ql-muted); margin-top: 4px; line-height: 1.5; }
		.dash-empty { padding: 24px; text-align: center; color: var(--ql-muted); }
		.section-label { font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ql-muted); margin: 24px 0 8px; }
	</style>
</head>
<body>
	<h1>${escapeHtml(title)} <button class="dash-refresh" id="refreshBtn">Refresh</button></h1>
	${body}
	<script nonce="${n}">
	(function () {
		const vscode = acquireVsCodeApi();
		document.getElementById('refreshBtn').addEventListener('click', function () {
			vscode.postMessage({ type: 'refresh' });
		});
	}());
	</script>
</body>
</html>`;
}
