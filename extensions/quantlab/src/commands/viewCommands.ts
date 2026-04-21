/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ViewManager } from '../views/ViewManager';
import { ViewType } from '../types/views';

export function registerViewCommands(context: vscode.ExtensionContext): void {
	const viewManager = ViewManager.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.switchToChart', () => switchToView('chart')),
		vscode.commands.registerCommand('quantlab.switchToAction', () => switchToView('action')),
		vscode.commands.registerCommand('quantlab.switchToStats', () => switchToView('stats')),
		vscode.commands.registerCommand('quantlab.switchToTrade', () => switchToView('trade')),
		vscode.commands.registerCommand('quantlab.switchToEditor', () => switchToView('editor')),

		vscode.commands.registerCommand('quantlab.openAsChart', (uri?: vscode.Uri) => openAsView('chart', uri)),
		vscode.commands.registerCommand('quantlab.openAsAction', (uri?: vscode.Uri) => openAsView('action', uri)),
		vscode.commands.registerCommand('quantlab.openAsTrade', (uri?: vscode.Uri) => openAsView('trade', uri))
	);

	async function switchToView(view: ViewType): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			await viewManager.switchView(editor, view);
			return;
		}

		const resource = getActiveResource();
		if (!resource) {
			return;
		}

		await viewManager.switchViewForResource(resource, view);
	}

	async function openAsView(view: ViewType, uri?: vscode.Uri): Promise<void> {
		const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri ?? getActiveResource();
		if (!targetUri) {
			return;
		}

		const openInSideGroup = uri ? false : true;
		await viewManager.openAsView(targetUri, view, { openInSideGroup });
	}

	function getActiveResource(): vscode.Uri | undefined {
		const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		if (!tab) {
			return undefined;
		}

		if (tab.input instanceof vscode.TabInputText) {
			return tab.input.uri;
		}

		if (tab.input instanceof vscode.TabInputCustom) {
			return tab.input.uri;
		}

		if (tab.input instanceof vscode.TabInputTextDiff) {
			return tab.input.modified;
		}

		return undefined;
	}
}
