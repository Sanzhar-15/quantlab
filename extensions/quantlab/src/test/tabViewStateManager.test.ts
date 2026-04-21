/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { TabViewStateManager } from '../core/state/TabViewState';

suite('TabViewStateManager', () => {
	const manager = TabViewStateManager.initialize();

	test('setCurrentView stores and retrieves state', () => {
		const tabInstanceId = 'file:///strategy.py::0::0';
		const filePath = 'file:///strategy.py';

		manager.setCurrentView(tabInstanceId, filePath, 'chart');

		assert.strictEqual(manager.getCurrentView(tabInstanceId), 'chart');
		assert.strictEqual(manager.getState(tabInstanceId)?.filePath, filePath);

		manager.removeState(tabInstanceId);
	});

	test('onDidChangeView fires for updates', async () => {
		const tabInstanceId = 'file:///strategy.py::1::0';
		const filePath = 'file:///strategy.py';

		const changePromise = new Promise<{ tabInstanceId: string; view: string }>(resolve => {
			const disposable = manager.onDidChangeView(event => {
				if (event.tabInstanceId !== tabInstanceId) {
					return;
				}
				disposable.dispose();
				resolve({ tabInstanceId: event.tabInstanceId, view: event.view });
			});
		});

		manager.setCurrentView(tabInstanceId, filePath, 'action');

		const change = await changePromise;

		assert.strictEqual(change.tabInstanceId, tabInstanceId);
		assert.strictEqual(change.view, 'action');

		manager.removeState(tabInstanceId);
	});
});
