/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ThemeProvider } from '../tokens/ThemeProvider';
import { ReducedMotion } from '../accessibility/ReducedMotion';

export type WelcomeAction = 'template' | 'open' | 'skip';

export class WelcomeModal {
	static async show(context: vscode.ExtensionContext): Promise<WelcomeAction | undefined> {
		const themeProvider = ThemeProvider.getInstance();
		const panel = vscode.window.createWebviewPanel(
			'quantlab.welcome',
			'Welcome to Quantlab',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [context.extensionUri]
			}
		);

		panel.webview.html = this.buildHtml(panel.webview, context.extensionUri);
		const key = `quantlab.welcome.${Date.now()}`;
		themeProvider.registerWebview(key, panel.webview);
		const reducedMotion = ReducedMotion.getInstance();
		panel.webview.postMessage({ type: 'reducedMotion', mode: reducedMotion.getMode() });
		const reducedMotionDisposable = reducedMotion.onDidChange(mode => {
			panel.webview.postMessage({ type: 'reducedMotion', mode });
		});

		return new Promise(resolve => {
			const disposable = panel.webview.onDidReceiveMessage(message => {
				if (!message || typeof message !== 'object') {
					return;
				}
				const payload = message as { type?: string };
				if (payload.type === 'startTemplate') {
					resolve('template');
					panel.dispose();
				}
				if (payload.type === 'openExisting') {
					resolve('open');
					panel.dispose();
				}
				if (payload.type === 'skip') {
					resolve('skip');
					panel.dispose();
				}
			});

			panel.onDidDispose(() => {
				themeProvider.unregisterWebview(key);
				reducedMotionDisposable.dispose();
				disposable.dispose();
				resolve(undefined);
			});
		});
	}

	private static buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'tokens.css'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'onboarding.css'));
		const themeStyles = ThemeProvider.getInstance().getInlineStyles();
		const nonce = this.getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${themeStyles}
	<link href="${tokensUri}" rel="stylesheet" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>Welcome to Quantlab</title>
</head>
<body>
	<div class="welcome-shell">
		<h1>Welcome to Quantlab</h1>
		<p class="welcome-subtitle">Build, test, and trade strategies with a quant-first workflow.</p>
		<div class="welcome-actions">
			<button class="btn btn-primary" data-action="startTemplate">Start with Template</button>
			<button class="btn btn-secondary" data-action="openExisting">Open Existing</button>
			<button class="btn btn-ghost" data-action="skip">Skip Tour</button>
		</div>
	</div>
	<script nonce="${nonce}">
		(function() {
			const vscode = acquireVsCodeApi();
			document.querySelectorAll('[data-action]').forEach(button => {
				button.addEventListener('click', () => {
					vscode.postMessage({ type: button.getAttribute('data-action') });
				});
			});
			window.addEventListener('message', event => {
				const data = event.data || {};
				if (data.type === 'theme' && data.theme) {
					const root = document.documentElement;
					root.dataset.qlTheme = data.theme.kind;
					root.dataset.qlThemeVariant = data.theme.variant;
					root.dataset.qlHighContrast = data.theme.highContrast ? 'true' : 'false';
				}
				if (data.type === 'reducedMotion') {
					const mode = data.mode || 'auto';
					const prefers = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
					const reduce = mode === 'always' || (mode === 'auto' && prefers);
					document.documentElement.classList.toggle('ql-reduced-motion', reduce);
				}
			});
		})();
	</script>
</body>
</html>`;
	}

	private static getNonce(): string {
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let nonce = '';
		for (let i = 0; i < 32; i++) {
			nonce += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return nonce;
	}
}
