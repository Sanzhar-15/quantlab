/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import { isTestFlagEnabled } from './helpers/envFlag';
import * as assert from 'assert';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { TabViewStateManager } from '../core/state/TabViewState';
import { ViewManager } from '../views/ViewManager';

// Megaudit Final.2: this test calls `vscode.workspace.openTextDocument`
// and `vscode.window.showTextDocument`, neither of which the test
// shim implements (they require the real VS Code runtime). Gate
// behind RUN_VSCODE_RUNTIME_TESTS so the suite passes in plain mocha.
suite('ViewManager', () => {
	test('switchView updates tab view state', async function () {
		if (!isTestFlagEnabled(process.env.RUN_VSCODE_RUNTIME_TESTS)) {  // Megaudit-2 A6-MAJOR-3
			this.skip();
			return;
		}
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
