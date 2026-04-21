/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { TabViewStateManager } from '../core/state/TabViewState';
import { ViewManager } from '../views/ViewManager';

suite('ViewManager', () => {
	test('switchView updates tab view state', async () => {
		const stateManager = TabViewStateManager.initialize();
		const viewManager = ViewManager.getInstance();

		const doc = await vscode.workspace.openTextDocument({
			language: 'python',
			content: 'def strategy(data):\n    return data'
		});

		const editor = await vscode.window.showTextDocument(doc, { preview: false });

		await viewManager.switchView(editor, 'chart');
		assert.strictEqual(stateManager.getCurrentViewForEditor(editor), 'chart');

		await viewManager.switchView(editor, 'editor');
		assert.strictEqual(stateManager.getCurrentViewForEditor(editor), 'editor');

		const tabInstanceId = stateManager.getTabInstanceId(editor);
		if (tabInstanceId) {
			stateManager.removeState(tabInstanceId);
		}

		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});
});
