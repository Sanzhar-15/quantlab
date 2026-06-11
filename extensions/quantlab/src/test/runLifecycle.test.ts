/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { HistoryState } from '../core/state/HistoryState';
import { findSessionByTabInstanceId } from '../views/action/ActionViewProvider';

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

function makeContext(globalState: MockMemento): vscode.ExtensionContext {
	return {
		workspaceState: new MockMemento(),
		globalState,
		subscriptions: []
	} as unknown as vscode.ExtensionContext;
}

const STORAGE_KEY = 'quantlab.historyEntries';
const COMPARE_KEY = 'quantlab.compareEntries';

// Regression tests for the 2026-06-11 megaudit run-lifecycle wave (W2):
// H26/H34 (phantom running entries restored across host reloads), H33
// (cancel-from-History must resolve HistoryState directly), and H23/H32
// (engine events were dropped because the sessions map is keyed by
// session.key while events route by tabInstanceId).
suite('Run lifecycle (megaudit W2)', () => {
	suiteTeardown(() => {
		// Leave no singleton behind for suites that run later.
		HistoryState.resetInstance();
	});

	test('restore() transitions persisted running/queued entries to failed (H26/H34)', () => {
		const startedAt = new Date('2026-06-10T10:00:00Z');
		const completedAt = new Date('2026-06-10T10:05:00Z');
		const globalState = new MockMemento();
		void globalState.update(STORAGE_KEY, [
			{
				id: 'run-running', type: 'backtest', status: 'running',
				strategyPath: '/tmp/s.py', strategyHash: 'h1',
				startedAt: startedAt.toISOString(), progress: 40,
				artifactPath: '', pinned: false, tags: []
			},
			{
				id: 'run-queued', type: 'optimize', status: 'queued',
				strategyPath: '/tmp/s.py', strategyHash: 'h2',
				startedAt: startedAt.toISOString(),
				artifactPath: '', pinned: false, tags: []
			},
			{
				id: 'run-done', type: 'backtest', status: 'completed',
				strategyPath: '/tmp/s.py', strategyHash: 'h3',
				startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
				artifactPath: '/tmp/artifacts', pinned: false, tags: []
			}
		]);

		HistoryState.resetInstance();
		const historyState = HistoryState.initialize(makeContext(globalState));

		const interrupted = historyState.getEntry('run-running');
		assert.strictEqual(interrupted?.status, 'failed');
		assert.strictEqual(interrupted?.errorMessage, 'Run interrupted (host reload)');
		assert.ok(interrupted?.completedAt instanceof Date, 'completedAt must be set on the fixed-up entry');

		const queued = historyState.getEntry('run-queued');
		assert.strictEqual(queued?.status, 'failed');
		assert.strictEqual(queued?.errorMessage, 'Run interrupted (host reload)');

		const done = historyState.getEntry('run-done');
		assert.strictEqual(done?.status, 'completed');
		assert.strictEqual(done?.errorMessage, undefined);

		assert.strictEqual(historyState.getRunningJobs().length, 0, 'no phantom running entries after restore');
	});

	test('restoreCompare() drops compare ids whose entries no longer exist (M59)', () => {
		const globalState = new MockMemento();
		void globalState.update(STORAGE_KEY, [
			{
				id: 'run-kept', type: 'backtest', status: 'completed',
				strategyPath: '/tmp/s.py', strategyHash: 'h1',
				startedAt: new Date().toISOString(),
				artifactPath: '', pinned: false, tags: []
			}
		]);
		void globalState.update(COMPARE_KEY, ['run-kept', 'run-pruned-away']);

		HistoryState.resetInstance();
		const historyState = HistoryState.initialize(makeContext(globalState));

		assert.strictEqual(historyState.getCompareCount(), 1);
		assert.deepStrictEqual(historyState.getCompareEntries().map(e => e.id), ['run-kept']);
	});

	test('direct cancel update marks a running entry cancelled (H33)', () => {
		HistoryState.resetInstance();
		const historyState = HistoryState.initialize(makeContext(new MockMemento()));

		historyState.createEntry({
			id: 'run-cancel-me',
			type: 'backtest',
			status: 'running',
			strategyPath: '/tmp/s.py'
		});
		assert.strictEqual(historyState.getRunningJobs().length, 1);

		// Mirrors historyCommands.cancelHistoryRun: HistoryState is updated
		// directly after EngineHost.cancelJob, independent of any Action tab.
		const completedAt = new Date();
		const updated = historyState.updateEntry('run-cancel-me', {
			status: 'cancelled',
			completedAt,
			errorMessage: 'Job cancelled by user.'
		});

		assert.strictEqual(updated?.status, 'cancelled');
		assert.strictEqual(updated?.completedAt?.getTime(), completedAt.getTime());
		assert.strictEqual(historyState.getRunningJobs().length, 0);

		// Terminal status holds even if a late engine event tries to regress it.
		const regressed = historyState.updateEntry('run-cancel-me', { status: 'running' });
		assert.strictEqual(regressed?.status, 'cancelled');
	});

	test('engine events resolve sessions by tabInstanceId, not by the sessions map key (H23/H32)', () => {
		const uri = 'file:///tmp/strategy.py';
		const tabId = `${uri}::0::1`;
		// The real sessions map is keyed by session.key (`uri::timestamp`).
		const sessions = new Map<string, { key: string; tabInstanceId?: string }>();
		sessions.set(`${uri}::1718000000000`, { key: `${uri}::1718000000000`, tabInstanceId: tabId });
		sessions.set(`${uri}::1718000099999`, { key: `${uri}::1718000099999`, tabInstanceId: `${uri}::0::2` });
		sessions.set(`${uri}::1718000111111`, { key: `${uri}::1718000111111`, tabInstanceId: undefined });

		// The pre-fix lookup: key shapes never match, every event was dropped.
		assert.strictEqual(sessions.get(tabId), undefined);

		const resolved = findSessionByTabInstanceId(sessions.values(), tabId);
		assert.strictEqual(resolved?.key, `${uri}::1718000000000`);

		assert.strictEqual(findSessionByTabInstanceId(sessions.values(), `${uri}::9::9`), undefined);
	});
});
