/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
// Megaudit Final.2: install vscode-shim BEFORE importing 'vscode'.
// Plain mocha doesn't have access to the real VS Code runtime.
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { DataSourceDescriptor, Timeframe, isLocalFileSource } from '../types/market';

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

suite('GlobalState', () => {
	const context = {
		workspaceState: new MockMemento(),
		globalState: new MockMemento(),
		subscriptions: []
	} as unknown as vscode.ExtensionContext;

	const globalState = GlobalState.initialize(context);

	test('defaults to no data source and no timeframe', () => {
		assert.strictEqual(globalState.getDataSource(), undefined);
		assert.strictEqual(globalState.getTimeframe(), undefined);
	});

	test('sets data source', () => {
		const source: DataSourceDescriptor = { kind: 'localFile', filePath: '/data/test.csv', displayName: 'test.csv' };
		globalState.setDataSource(source);
		const result = globalState.getDataSource();
		assert.ok(isLocalFileSource(result));
		assert.strictEqual(result.filePath, '/data/test.csv');
		assert.strictEqual(result.displayName, 'test.csv');
	});

	test('ignores invalid timeframe', () => {
		globalState.setTimeframe('1D' as Timeframe);
		globalState.setTimeframe('bad' as Timeframe);
		assert.strictEqual(globalState.getTimeframe(), '1D');
	});
});
