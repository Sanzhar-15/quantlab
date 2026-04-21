/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reconciliation Panel (NEW-UI-005).
 *
 * Webview panel showing position/fill discrepancies between daemon and broker.
 */

import * as vscode from 'vscode';
import { SessionManager } from '../../core/trading/SessionManager';

interface Discrepancy {
	symbol: string;
	daemonQty: number;
	brokerQty: number;
	difference: number;
	severity: 'ok' | 'warning' | 'critical';
}

interface ReconciliationStatus {
	lastRun: string | null;
	discrepancies: Discrepancy[];
}

export class ReconciliationPanel {
	private panel: vscode.WebviewPanel | null = null;

	async show(sessionId: string): Promise<void> {
		const sessionManager = SessionManager.getInstance();
		const client = sessionManager.getDaemonClient(sessionId);
		if (!client) {
			void vscode.window.showErrorMessage('No daemon client for session');
			return;
		}

		let status: ReconciliationStatus;
		try {
			status = await client.getReconciliationStatus() as unknown as ReconciliationStatus;
		} catch {
			status = { lastRun: null, discrepancies: [] };
		}

		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'quantlab.reconciliation',
				'Reconciliation',
				vscode.ViewColumn.Two,
				{ enableScripts: false },
			);
			this.panel.onDidDispose(() => { this.panel = null; });
		}

		this.panel.webview.html = this.buildHtml(status);
	}

	private buildHtml(status: ReconciliationStatus): string {
		const discrepancies = status.discrepancies ?? [];
		const rows = discrepancies.map(d =>
			`<tr>
				<td>${this.escapeHtml(d.symbol)}</td>
				<td>${d.daemonQty}</td>
				<td>${d.brokerQty}</td>
				<td>${d.difference}</td>
				<td class="${d.severity}">${d.severity}</td>
			</tr>`
		).join('');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: var(--vscode-font-family); padding: 16px; }
		table { width: 100%; border-collapse: collapse; }
		th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
		.critical { color: var(--vscode-errorForeground); font-weight: bold; }
		.warning { color: var(--vscode-editorWarning-foreground); }
		.ok { color: var(--vscode-terminal-ansiGreen); }
	</style>
</head>
<body>
	<h2>Position Reconciliation</h2>
	<p>Last reconciliation: ${status.lastRun ?? 'Never'}</p>
	<table>
		<tr><th>Symbol</th><th>Daemon</th><th>Broker</th><th>Diff</th><th>Status</th></tr>
		${rows || '<tr><td colspan="5">No discrepancies</td></tr>'}
	</table>
</body>
</html>`;
	}

	private escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
}
