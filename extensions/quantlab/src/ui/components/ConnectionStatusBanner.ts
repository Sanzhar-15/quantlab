/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Connection Status Banner (FIX-CGP-016).
 *
 * Status bar item showing daemon connection state.
 */

import * as vscode from 'vscode';

export class ConnectionStatusBanner {
	private statusBarItem: vscode.StatusBarItem;
	private reconnectTimer: NodeJS.Timeout | null = null;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left, 100
		);
		this.statusBarItem.command = 'quantlab.showConnectionDetails';
	}

	setConnected(sessionId: string): void {
		this.statusBarItem.text = '$(plug) Quantlab: Connected';
		this.statusBarItem.backgroundColor = undefined;
		this.statusBarItem.tooltip = `Connected to session ${sessionId}`;
		this.statusBarItem.show();

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	setDisconnected(sessionId: string, reason?: string): void {
		this.statusBarItem.text = '$(debug-disconnect) Quantlab: Disconnected';
		this.statusBarItem.backgroundColor = new vscode.ThemeColor(
			'statusBarItem.errorBackground'
		);
		this.statusBarItem.tooltip = `Disconnected from session ${sessionId}${reason ? ': ' + reason : ''}. Click for options.`;
		this.statusBarItem.show();
	}

	setReconnecting(sessionId: string, attempt: number): void {
		this.statusBarItem.text = `$(sync~spin) Quantlab: Reconnecting (${attempt})...`;
		this.statusBarItem.backgroundColor = new vscode.ThemeColor(
			'statusBarItem.warningBackground'
		);
		this.statusBarItem.tooltip = `Reconnecting to session ${sessionId}, attempt ${attempt}`;
		this.statusBarItem.show();
	}

	hide(): void {
		this.statusBarItem.hide();
	}

	dispose(): void {
		this.statusBarItem.dispose();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
	}
}
