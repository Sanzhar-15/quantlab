/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//  QuantLab Home -- Post-login dashboard tab.
//  Shown once after first successful login. Accessible any time via "quantlab.openHome".
//  Two-column layout: Delta Plus brand (left) + personalised dashboard (right).

import * as vscode from 'vscode';
import { ThemeProvider } from '../ui/tokens/ThemeProvider';

export interface HomeUser {
	name?: string;
	email: string;
	tier?: string;
}

export class QuantLabHome {
	private static _instance: vscode.WebviewPanel | undefined;

	static show(context: vscode.ExtensionContext, user: HomeUser): void {
		if (QuantLabHome._instance) {
			QuantLabHome._instance.reveal(vscode.ViewColumn.One, false);
			return;
		}

		const themeProvider = ThemeProvider.getInstance();
		const panel = vscode.window.createWebviewPanel(
			'quantlab.home',
			'QuantLab Home',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [context.extensionUri],
			}
		);
		QuantLabHome._instance = panel;

		const tokensUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'media', 'tokens.css')
		);
		const styleUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'media', 'welcome.css')
		);
		const themeStyles = themeProvider.getInlineStyles();
		const themeKey = `quantlab.home.${Date.now()}`;
		themeProvider.registerWebview(themeKey, panel.webview);

		panel.webview.html = QuantLabHome._buildHtml(
			panel.webview, tokensUri, styleUri, themeStyles, user
		);

		// Handle quick-action button clicks -> execute VS Code commands
		panel.webview.onDidReceiveMessage(async (msg: { type: string; cmd?: string }) => {
			if (msg.type === 'command' && msg.cmd) {
				await vscode.commands.executeCommand(msg.cmd).then(undefined, () => { /* ignore */ });
			}
		});

		panel.onDidDispose(() => {
			QuantLabHome._instance = undefined;
			themeProvider.unregisterWebview(themeKey);
		});
	}

	static close(): void {
		QuantLabHome._instance?.dispose();
	}

	static isOpen(): boolean {
		return QuantLabHome._instance !== undefined;
	}

	// ---- HTML ----

	private static _buildHtml(
		webview: vscode.Webview,
		tokensUri: vscode.Uri,
		styleUri: vscode.Uri,
		themeStyles: string,
		user: HomeUser,
	): string {
		const nonce = QuantLabHome._nonce();
		// style-src MUST include cspSource or the linked tokens.css/welcome.css
		// are silently blocked and the panel renders unstyled.
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		const displayName = user.name?.split(' ')[0] ?? user.email.split('@')[0];
		const tier = user.tier ? `${user.tier.charAt(0).toUpperCase()}${user.tier.slice(1)}` : 'Free';

		const actions: Array<{ label: string; icon: string; cmd: string; desc: string }> = [
			// allow-any-unicode-next-line
			{ label: 'Open Orion', icon: '✦', cmd: 'workbench.view.extension.quantlab-qic', desc: 'AI trading assistant' },
			// allow-any-unicode-next-line
			{ label: 'Browse Markets', icon: '⬡', cmd: 'quantlab.focusDataPanel', desc: '511 equities · 50 crypto' },
			// allow-any-unicode-next-line
			{ label: 'View Chart', icon: '↗', cmd: 'quantlab.chart.refresh', desc: 'Drag symbols to chart' },
			// allow-any-unicode-next-line
			{ label: 'Manage Alerts', icon: '◈', cmd: 'quantlab.focusDataPanel', desc: 'Price & volume triggers' },
		];

		const tips: string[] = [
			'Drag any symbol from the Data panel onto the chart to plot it instantly.',
			'Use <kbd>Ctrl+Shift+P</kbd> and type <strong>QuantLab</strong> to discover all commands.',
			'Right-click any data row to add to watchlist, set alerts, or open a chart.',
			'QIC AI has access to real-time Delta Plus data -- just ask it anything.',
		];

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${themeStyles}
	<link href="${tokensUri}" rel="stylesheet" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>QuantLab Home</title>
	<style nonce="${nonce}">
		/* Home-specific overrides on top of welcome.css split layout */
		.home-right { display: flex; flex-direction: column; gap: 0; overflow-y: auto; padding: 48px 52px; }

		/* Welcome card */
		.home-welcome { margin-bottom: 28px; }
		.home-name { font-size: 24px; font-weight: 700; color: var(--ql-fg, #EDEDEF); margin: 0 0 4px; }
		.home-meta { font-size: 13px; color: var(--ql-muted, #A8A8AC); display: flex; align-items: center; gap: 8px; }
		.home-tier-badge {
			display: inline-flex; align-items: center; padding: 2px 8px;
			background: var(--ql-accent, #FF7331)1A; color: var(--ql-accent, #FF7331);
			border: 1px solid var(--ql-accent, #FF7331)44; border-radius: 20px;
			font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
		}

		/* Section headers */
		.home-section-label {
			font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
			color: var(--ql-muted, #A8A8AC); margin: 0 0 12px;
		}

		/* Quick actions grid */
		.home-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 28px; }
		.home-action {
			display: flex; flex-direction: column; gap: 3px;
			background: var(--ql-surface, #2C2B2B); border: 1px solid var(--ql-border, #383737);
			border-radius: 8px; padding: 14px 16px; cursor: pointer; text-align: left;
			transition: border-color .15s, background .15s; color: inherit; font-family: inherit;
		}
		.home-action:hover { border-color: var(--ql-accent, #FF7331); background: var(--ql-hover, #333232); }
		.home-action-icon { font-size: 18px; color: var(--ql-accent, #FF7331); margin-bottom: 2px; }
		.home-action-label { font-size: 13px; font-weight: 600; color: var(--ql-fg, #EDEDEF); }
		.home-action-desc { font-size: 11px; color: var(--ql-muted, #A8A8AC); }

		/* Divider */
		.home-divider { height: 1px; background: var(--ql-border, #383737); margin: 0 0 24px; }

		/* Tips */
		.home-tips { display: flex; flex-direction: column; gap: 10px; }
		.home-tip {
			display: flex; align-items: flex-start; gap: 10px;
			font-size: 13px; color: var(--ql-muted, #A8A8AC); line-height: 1.5;
		}
		.home-tip-dot {
			width: 5px; height: 5px; border-radius: 50%; background: var(--ql-accent, #FF7331);
			flex-shrink: 0; margin-top: 7px;
		}
		kbd {
			font-family: inherit; font-size: 11px; padding: 1px 5px;
			background: var(--ql-inset, #1B1A1A); border: 1px solid var(--ql-border, #383737);
			border-radius: 3px; color: var(--ql-fg, #EDEDEF);
		}
	</style>
</head>
<body>
<div class="welcome-shell">

	<!-- ---- Left: Brand panel ---- -->
	<div class="brand-panel">
		<div class="brand-lockup">
			<div class="brand-logo">
				<span class="brand-delta">&#916;</span>
				<span class="brand-name">Delta Plus</span>
			</div>
			<h1 class="brand-tagline">Professional trading.<br><em>Built for quants.</em></h1>
			<p class="brand-desc">QuantLab connects to Delta Plus for real-time market data, strategy back-testing, and AI-assisted analysis.</p>
		</div>
		<ul class="feature-list">
			<li>511 equities &amp; 50 crypto pairs, live</li>
			<li>Back-test strategies against historical data</li>
			<li>Yield curve, fundamentals &amp; sentiment</li>
			<li>Delta Plus AI chat, integrated</li>
		</ul>
	</div>

	<!-- ---- Right: Dashboard ---- -->
	<div class="form-panel">
		<div class="home-right">

			<!-- Welcome card -->
			<div class="home-welcome">
				<p class="home-name">Welcome back, ${this._esc(displayName)}!</p>
				<div class="home-meta">
					<span>${this._esc(user.email)}</span>
					<span class="home-tier-badge">${this._esc(tier)}</span>
				</div>
			</div>

			<!-- Quick actions -->
			<p class="home-section-label">Quick Start</p>
			<div class="home-actions">
				${actions.map(a => `
				<button class="home-action" data-cmd="${this._esc(a.cmd)}">
					<span class="home-action-icon">${a.icon}</span>
					<span class="home-action-label">${this._esc(a.label)}</span>
					<span class="home-action-desc">${this._esc(a.desc)}</span>
				</button>`).join('')}
			</div>

			<div class="home-divider"></div>

			<!-- Tips -->
			<p class="home-section-label">Tips</p>
			<div class="home-tips">
				${tips.map(t => `
				<div class="home-tip">
					<span class="home-tip-dot"></span>
					<span>${t}</span>
				</div>`).join('')}
			</div>

		</div>
	</div>

</div>
<script nonce="${nonce}">
(function () {
	const vscode = acquireVsCodeApi();
	document.querySelectorAll('.home-action').forEach(function (btn) {
		btn.addEventListener('click', function () {
			vscode.postMessage({ type: 'command', cmd: btn.dataset.cmd });
		});
	});
}());
</script>
</body>
</html>`;
	}

	private static _esc(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	private static _nonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) { result += chars[Math.floor(Math.random() * chars.length)]; }
		return result;
	}
}
