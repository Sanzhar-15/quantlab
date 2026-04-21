/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ServerApiClient } from '../../core/server/ServerApiClient';

interface SettingsNode {
	id: string;
	label: string;
	description?: string;
	tooltip?: string;
	query?: string;
	command?: string;
	iconId?: string;
}

const SETTINGS_CATEGORIES: SettingsNode[] = [
	{ id: 'quantlab.settings.broker', label: 'Broker Connections', query: 'quantlab.broker' },
	{ id: 'quantlab.settings.data', label: 'Data Sources', query: 'quantlab.data' },
	{ id: 'quantlab.settings.appearance', label: 'Appearance', query: 'quantlab.appearance' },
	{ id: 'quantlab.settings.performance', label: 'Performance', query: 'quantlab.performance' },
	{ id: 'quantlab.settings.safety', label: 'Safety', query: 'quantlab.safety' },
	{ id: 'quantlab.settings.storage', label: 'Storage', query: 'quantlab.storage' }
];

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingsNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SettingsNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly _serverClient?: ServerApiClient) {
		if (_serverClient) {
			this._disposables.push(
				_serverClient.onAuthStateChange(() => this._onDidChangeTreeData.fire())
			);
		}
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		this._disposables.forEach(d => d.dispose());
	}

	getTreeItem(element: SettingsNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.id = element.id;
		item.description = element.description;
		item.tooltip = element.tooltip;
		if (element.iconId) {
			item.iconPath = new vscode.ThemeIcon(element.iconId);
		}
		if (element.command) {
			item.command = { command: element.command, title: element.label };
		} else if (element.query) {
			item.command = { command: 'workbench.action.openSettings', title: 'Open Settings', arguments: [element.query] };
		}
		return item;
	}

	getChildren(): SettingsNode[] {
		const accountNodes = this._buildAccountNodes();
		return [...accountNodes, ...SETTINGS_CATEGORIES];
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private _buildAccountNodes(): SettingsNode[] {
		if (!this._serverClient) { return []; }

		const user = this._serverClient.getUser();
		if (user) {
			return [
				{
					id: 'quantlab.account.info',
					label: user.name || user.email,
					description: user.email !== user.name ? `${user.email} · ${user.tier}` : user.tier,
					tooltip: `Signed in as ${user.email}\nTier: ${user.tier}`,
					iconId: 'account'
				},
				{
					id: 'quantlab.account.signout',
					label: 'Sign Out',
					iconId: 'sign-out',
					command: 'quantlab.signOut'
				}
			];
		}

		return [
			{
				id: 'quantlab.account.signin',
				label: 'Sign In to Delta Plus',
				description: 'No account',
				iconId: 'account',
				command: 'quantlab.signIn'
			}
		];
	}
}
