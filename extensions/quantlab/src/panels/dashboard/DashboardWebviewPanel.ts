/*---------------------------------------------------------------------------------------------
 *  DashboardWebviewPanel — Generic reusable webview panel factory for data dashboards.
 *  Pattern follows QuantLabHome.ts: singleton per id, CSP with nonce, tokens.css.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ThemeProvider } from '../../ui/tokens/ThemeProvider';

export interface DashboardConfig<T> {
	id: string;
	title: string;
	fetchData: () => Promise<T>;
	renderBody: (data: T) => string;
}

const panels = new Map<string, vscode.WebviewPanel>();

export class DashboardWebviewPanel {
	static async show<T>(context: vscode.ExtensionContext, config: DashboardConfig<T>): Promise<void> {
		const existing = panels.get(config.id);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One, false);
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
		panels.set(config.id, panel);

		const tokensUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'media', 'tokens.css')
		);
		const themeStyles = themeProvider.getInlineStyles();
		const themeKey = `dashboard.${config.id}.${Date.now()}`;
		themeProvider.registerWebview(themeKey, panel.webview);

		// Show loading state
		panel.webview.html = buildHtml(tokensUri, themeStyles, config.title,
			'<div class="dash-loading">Loading...</div>');

		// Fetch data and render
		try {
			const data = await config.fetchData();
			panel.webview.html = buildHtml(tokensUri, themeStyles, config.title, config.renderBody(data));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			panel.webview.html = buildHtml(tokensUri, themeStyles, config.title,
				`<div class="dash-error">Failed to load data: ${escapeHtml(msg)}</div>`);
		}

		// Handle refresh messages
		panel.webview.onDidReceiveMessage(async (msg: { type: string }) => {
			if (msg.type === 'refresh') {
				panel.webview.html = buildHtml(tokensUri, themeStyles, config.title,
					'<div class="dash-loading">Refreshing...</div>');
				try {
					const data = await config.fetchData();
					panel.webview.html = buildHtml(tokensUri, themeStyles, config.title, config.renderBody(data));
				} catch (err) {
					const msg2 = err instanceof Error ? err.message : String(err);
					panel.webview.html = buildHtml(tokensUri, themeStyles, config.title,
						`<div class="dash-error">Failed to load data: ${escapeHtml(msg2)}</div>`);
				}
			}
		});

		panel.onDidDispose(() => {
			panels.delete(config.id);
			themeProvider.unregisterWebview(themeKey);
		});
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

function buildHtml(tokensUri: vscode.Uri, themeStyles: string, title: string, body: string): string {
	const n = nonce();
	const csp = [
		`default-src 'none'`,
		`img-src data:`,
		`style-src 'unsafe-inline'`,
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
		body { padding: 24px 32px; font-family: var(--vscode-font-family, sans-serif); color: var(--ql-fg, #EDEDEF); background: var(--ql-base, #242323); }
		h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 12px; }
		.dash-refresh { background: none; border: 1px solid var(--ql-border, #383737); color: var(--ql-muted, #A8A8AC); border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
		.dash-refresh:hover { border-color: var(--ql-accent, #FF7331); color: var(--ql-accent, #FF7331); }
		.dash-loading, .dash-error { padding: 40px; text-align: center; color: var(--ql-muted, #A8A8AC); font-size: 14px; }
		.dash-error { color: var(--ql-error, #FF6B6B); }
		.dashboard-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
		.dashboard-table th { text-align: left; padding: 8px 12px; background: var(--ql-surface, #2C2B2B); border-bottom: 1px solid var(--ql-border, #383737); color: var(--ql-muted, #A8A8AC); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
		.dashboard-table td { padding: 8px 12px; border-bottom: 1px solid var(--ql-border, #383737); color: var(--ql-fg, #EDEDEF); }
		.dashboard-table tr:hover td { background: var(--ql-hover, #333232); }
		.summary-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
		.summary-card { background: var(--ql-surface, #2C2B2B); border: 1px solid var(--ql-border, #383737); border-radius: 8px; padding: 16px; }
		.summary-card .label { font-size: 11px; color: var(--ql-muted, #A8A8AC); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
		.summary-card .value { font-size: 20px; font-weight: 700; color: var(--ql-fg, #EDEDEF); }
		.summary-card .sub { font-size: 12px; color: var(--ql-muted, #A8A8AC); margin-top: 4px; }
		.news-list { list-style: none; padding: 0; margin: 16px 0; }
		.news-list li { padding: 12px 0; border-bottom: 1px solid var(--ql-border, #383737); }
		.news-list .news-title { font-size: 14px; font-weight: 600; color: var(--ql-fg, #EDEDEF); margin-bottom: 4px; }
		.news-list .news-meta { font-size: 11px; color: var(--ql-muted, #A8A8AC); }
		.news-list .news-summary { font-size: 13px; color: var(--ql-muted, #A8A8AC); margin-top: 4px; line-height: 1.5; }
		.dash-empty { padding: 24px; text-align: center; color: var(--ql-muted, #A8A8AC); }
		.section-label { font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ql-muted, #A8A8AC); margin: 24px 0 8px; }
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
