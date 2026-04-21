/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * System Tray Manager (NEW-UI-003).
 *
 * Uses VS Code's window badge API and notifications for session monitoring
 * when VS Code is minimized.
 */

import * as vscode from 'vscode';

export class SystemTrayManager {
	private badgeDisposable: vscode.Disposable | null = null;

	updateSessionCount(count: number): void {
		if (count > 0) {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Window,
				title: `Quantlab: ${count} active session${count > 1 ? 's' : ''}`,
			}, () => new Promise<void>(() => { /* persistent until cleared */ }));
		}
	}

	showAlert(message: string, severity: 'info' | 'warning' | 'error'): void {
		const prefixed = `Quantlab: ${message}`;
		switch (severity) {
			case 'info':
				void vscode.window.showInformationMessage(prefixed);
				break;
			case 'warning':
				void vscode.window.showWarningMessage(prefixed);
				break;
			case 'error':
				void vscode.window.showErrorMessage(prefixed);
				break;
		}
	}

	dispose(): void {
		this.badgeDisposable?.dispose();
	}
}
