/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SettingsTreeProvider } from './SettingsTreeProvider';
import { ServerApiClient } from '../../core/server/ServerApiClient';

export class SettingsPanelProvider {
	private readonly treeView: vscode.TreeView<unknown>;

	constructor(context: vscode.ExtensionContext) {
		const serverClient = ServerApiClient.getInstance();
		const provider = new SettingsTreeProvider(serverClient);
		context.subscriptions.push(provider);
		this.treeView = vscode.window.createTreeView('quantlab.settingsView', { treeDataProvider: provider });
		context.subscriptions.push(this.treeView);
	}
}
