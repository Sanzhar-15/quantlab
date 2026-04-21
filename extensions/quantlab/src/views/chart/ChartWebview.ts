/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ThemeProvider } from '../../ui/tokens/ThemeProvider';

export class ChartWebview {
	private ready = false;
	private readonly pending: unknown[] = [];

	constructor(private readonly panel: vscode.WebviewPanel) { }

	initialize(html: string): void {
		this.panel.webview.html = html;
	}

	onMessage(handler: (message: unknown) => void): vscode.Disposable {
		return this.panel.webview.onDidReceiveMessage(handler);
	}

	markReady(): void {
		this.ready = true;
		while (this.pending.length) {
			const message = this.pending.shift();
			if (message) {
				void this.panel.webview.postMessage(message);
			}
		}
	}

	postMessage(message: unknown): void {
		if (!this.ready) {
			this.pending.push(message);
			return;
		}

		void this.panel.webview.postMessage(message);
	}

	static buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'chart.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'chart-style.css'));
		const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'tokens.css'));
		const themeStyles = ThemeProvider.getInstance().getInlineStyles();
		const nonce = ChartWebview.getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${themeStyles}
	<link href="${tokensUri}" rel="stylesheet" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>Quantlab Chart</title>
</head>
<body>
	<div id="chart-root"></div>
	<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
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
