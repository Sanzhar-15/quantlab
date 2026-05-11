/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { HistoryState } from '../core/state/HistoryState';

class MockMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();

	get<T>(key: string, defaultValue?: T): T {
		if (!this.store.has(key)) {
			return defaultValue as T;
		}
		return this.store.get(key) as T;
	}

	update(key: string, value: unknown): Thenable<void> {
		this.store.set(key, value);
		return Promise.resolve();
	}

	keys(): readonly string[] {
		return Array.from(this.store.keys());
	}
}

suite('HistoryState', () => {
	const context = {
		workspaceState: new MockMemento(),
		globalState: new MockMemento(),
		subscriptions: []
	} as unknown as vscode.ExtensionContext;

	const historyState = HistoryState.initialize(context);

	test('clamps progress values and ignores NaN updates', () => {
		const entry = historyState.createEntry({
			id: 'history-progress',
			type: 'backtest',
			status: 'running',
			strategyPath: '/tmp/strategy.py',
			progress: 250
		});

		assert.strictEqual(entry.progress, 100);

		const updated = historyState.updateEntry(entry.id, { progress: -10 });
		assert.strictEqual(updated?.progress, 0);

		const cleared = historyState.updateEntry(entry.id, { progress: Number.NaN });
		assert.strictEqual(cleared?.progress, undefined);
	});

	test('blocks invalid status transitions', () => {
		const entry = historyState.createEntry({
			id: 'history-status',
			type: 'backtest',
			status: 'running',
			strategyPath: '/tmp/strategy.py'
		});

		const regressed = historyState.updateEntry(entry.id, { status: 'queued' });
		assert.strictEqual(regressed?.status, 'running');

		historyState.updateEntry(entry.id, { status: 'completed' });
		const blocked = historyState.updateEntry(entry.id, { status: 'failed' });
		assert.strictEqual(blocked?.status, 'completed');
	});

	test('tracks unviewed count when marking entries viewed', () => {
		const before = historyState.getUnviewedCount();
		const entry = historyState.createEntry({
			id: 'history-unviewed',
			type: 'backtest',
			status: 'completed',
			strategyPath: '/tmp/strategy.py'
		});

		assert.strictEqual(historyState.getUnviewedCount(), before + 1);
		historyState.markAsViewed(entry.id);
		assert.strictEqual(historyState.getUnviewedCount(), before);
	});
});
