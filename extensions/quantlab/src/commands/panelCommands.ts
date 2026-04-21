/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const CONTAINER_COMMANDS: Record<string, string> = {
	data: 'workbench.view.extension.quantlab-data',
	resources: 'workbench.view.extension.quantlab-resources',
	history: 'workbench.view.extension.quantlab-history',
	trade: 'workbench.view.extension.quantlab-trade',
	settings: 'workbench.view.extension.quantlab-settings'
};

export function registerPanelCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.focusDataPanel', () => focusContainer(CONTAINER_COMMANDS.data)),
		vscode.commands.registerCommand('quantlab.focusResourcesPanel', () => focusContainer(CONTAINER_COMMANDS.resources)),
		vscode.commands.registerCommand('quantlab.focusHistoryPanel', () => focusContainer(CONTAINER_COMMANDS.history)),
		vscode.commands.registerCommand('quantlab.focusTradePanel', () => focusContainer(CONTAINER_COMMANDS.trade)),
		vscode.commands.registerCommand('quantlab.focusSettingsPanel', () => focusContainer(CONTAINER_COMMANDS.settings)),
		vscode.commands.registerCommand('quantlab.newFromTemplate', async () => {
			await vscode.window.showInformationMessage('Template gallery is not available yet.');
		}),
		vscode.commands.registerCommand('quantlab.openGuide', async (url?: string) => {
			if (!url) {
				return;
			}
			await vscode.env.openExternal(vscode.Uri.parse(url));
		})
	);
}

function focusContainer(command: string): void {
	void vscode.commands.executeCommand(command);
}
