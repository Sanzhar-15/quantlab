/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { QuantlabToastPayload } from '../../types/notifications';

export class ToastService {
	private commandAvailable = true;

	async showToast(payload: QuantlabToastPayload): Promise<void> {
		if (this.commandAvailable) {
			try {
				await vscode.commands.executeCommand('quantlab.showToast', payload);
				return;
			} catch {
				this.commandAvailable = false;
			}
		}

		await this.showFallback(payload);
	}

	async dismissToast(id: string): Promise<void> {
		if (!this.commandAvailable) {
			return;
		}

		try {
			await vscode.commands.executeCommand('quantlab.dismissToast', id);
		} catch {
			this.commandAvailable = false;
		}
	}

	private async showFallback(payload: QuantlabToastPayload): Promise<void> {
		const actionLabels = payload.actions?.map(action => action.label) ?? [];
		let selection: string | undefined;

		if (payload.kind === 'error') {
			selection = await vscode.window.showErrorMessage(payload.title, ...actionLabels);
		} else if (payload.kind === 'warning') {
			selection = await vscode.window.showWarningMessage(payload.title, ...actionLabels);
		} else {
			selection = await vscode.window.showInformationMessage(payload.title, ...actionLabels);
		}

		if (!selection || !payload.actions) {
			return;
		}

		const action = payload.actions.find(item => item.label === selection);
		if (action?.command) {
			await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
		}
	}
}
