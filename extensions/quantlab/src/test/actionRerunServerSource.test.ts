/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _errorMessagesSnapshot, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DataService } from '../core/engine/DataService';
import { ServerDataCache } from '../core/engine/ServerDataCache';
import { ServerApiClient, ServerBar } from '../core/server/ServerApiClient';
import { ActionViewProvider } from '../views/action/ActionViewProvider';

// QL-DATA Q-2 (window ruling): a run on server data reads a per-run CSV that
// is disposed at run end, so History must record the SERVER SOURCE (symbol,
// timeframe, range), never the run-file path. A rerun from History then calls
// writeRunFile again and never hands the engine a deleted file.

const DAY_MS = 24 * 60 * 60 * 1000;

interface SavedConfig {
	action: string;
	values: Record<string, unknown>;
}

interface EngineRequest {
	config: { values: Record<string, unknown> };
}

interface ActionHarness {
	runAction(session: unknown, payload: { actionType: string; config: SavedConfig }): Promise<void>;
	disposeRunDataFile(jobId: string): Promise<void>;
	saved: SavedConfig[];
	requests: EngineRequest[];
	setGlobalSource(source: unknown): void;
}

/**
 * Object.create skips the class-field initializers (their singletons need the
 * real VS Code runtime); runAction's collaborators are stubbed.
 */
function makeActionHarness(globalSource: unknown, globalTimeframe: string | undefined): ActionHarness {
	let source = globalSource;
	const saved: SavedConfig[] = [];
	const requests: EngineRequest[] = [];
	let runCounter = 0;
	const provider = Object.create(ActionViewProvider.prototype) as Record<string, unknown>;
	Object.assign(provider, {
		runDataFiles: new Map(),
		jobToTab: new Map(),
		getSessionTabId: () => 'tab-1',
		parameterExtractor: { extract: () => ({ parameters: [] }) },
		applyParameterSource: (values: Record<string, unknown>) => ({ ...values }),
		normalizeParamSource: () => 'code',
		getChartOverrides: () => ({}),
		buildSchemaForAction: () => ({ sections: [] }),
		getRequiredFields: () => [],
		getNumberRanges: () => ({}),
		stateMachine: { validateConfig: () => ({ isValid: true, errors: {} }), toRunning: () => undefined },
		globalState: { getDataSource: () => source, getTimeframe: () => globalTimeframe },
		createRunId: () => `run-${++runCounter}`,
		writeConfigArtifact: async (_jobId: string, config: SavedConfig) => {
			saved.push(JSON.parse(JSON.stringify(config)) as SavedConfig);
			return '/runs/artifacts';
		},
		historyState: { createEntry: (entry: unknown) => entry },
		hashText: () => 'hash',
		cacheRunLogs: () => undefined,
		engineHost: { runJob: async (request: EngineRequest) => { requests.push(request); } }
	});
	const action = provider as unknown as Pick<ActionHarness, 'runAction' | 'disposeRunDataFile'>;
	return {
		runAction: (session, payload) => action.runAction(session, payload),
		disposeRunDataFile: jobId => action.disposeRunDataFile(jobId),
		saved,
		requests,
		setGlobalSource: next => { source = next; }
	};
}

const SESSION = { document: { isDirty: false, uri: { fsPath: '/ws/strategy.py' }, getText: () => '' } };

suite('Q-2: a rerun of a server-data run re-fetches, never reads the disposed run file', () => {
	let storageRoot = '';
	let runDir = '';
	let calls = 0;
	const originalGetInstance = ServerApiClient.getInstance;
	const fakeClient = {
		getBars: async (): Promise<ServerBar[]> => {
			calls++;
			const end = Date.now();
			return [0, 1, 2].map(i => ({
				symbol: 'TEST',
				timestamp: new Date(end - (2 - i) * DAY_MS).toISOString(),
				open: 100 + i,
				high: 101 + i,
				low: 99 + i,
				close: 100.5 + i,
				volume: 1000 + i
			}));
		}
	} as unknown as ServerApiClient;

	suiteSetup(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fakeClient;
	});

	suiteTeardown(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
		DataService.resetInstance();
		_resetShimState();
	});

	setup(() => {
		calls = 0;
		_resetShimState();
		DataService.resetInstance();
		storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-rerun-'));
		runDir = path.join(storageRoot, 'server-data-cache');
		ServerDataCache.initialize({ globalStorageUri: { fsPath: storageRoot } } as unknown as vscode.ExtensionContext);
	});

	teardown(() => {
		ServerDataCache.resetInstance();
		for (const file of fs.readdirSync(runDir)) {
			fs.unlinkSync(path.join(runDir, file));
		}
		fs.rmdirSync(runDir);
		fs.rmdirSync(storageRoot);
	});

	test('History records the server source; the rerun writes a fresh run file after the first was disposed', async () => {
		// NEGATIVE CONTROL: write `config` (values = finalValues, i.e. the
		// run-file path) to History again instead of historyValues -> the saved
		// config has no serverSource and its dataSource is the disposed path;
		// with the global source now a local file, the rerun hands the engine
		// that deleted path -> existsSync(rerun path) is false -> RED.
		const action = makeActionHarness({ kind: 'server', symbol: 'TEST', displayName: 'Test Inc.' }, '1D');
		const { saved, requests } = action;
		const session = SESSION;

		// First run, from the global server source.
		await action.runAction(session, {
			actionType: 'backtest',
			config: { action: 'backtest', values: { dataSource: 'server:TEST', paramSource: 'code' } }
		});
		const firstPath = requests[0].config.values.dataSource as string;
		assert.ok(fs.existsSync(firstPath), 'the engine reads a live run file');
		assert.strictEqual(saved[0].values.dataSource, 'server:TEST', 'History never records the run-file path');
		assert.deepStrictEqual(saved[0].values.serverSource, { symbol: 'TEST', displayName: 'Test Inc.', timeframe: '1D' });

		// Run end: the run file is disposed.
		await action.disposeRunDataFile('run-1');
		assert.ok(!fs.existsSync(firstPath), 'run file disposed at run end');

		// Rerun from History while the global source is now a local file.
		action.setGlobalSource({ kind: 'localFile', filePath: '/ws/other.csv', displayName: 'other.csv' });
		await action.runAction(session, { actionType: 'backtest', config: saved[0] });
		const rerunPath = requests[1].config.values.dataSource as string;
		assert.notStrictEqual(rerunPath, firstPath);
		assert.ok(fs.existsSync(rerunPath), 'the rerun reads a freshly written run file');
		assert.strictEqual(calls, 2, 'the rerun re-fetched the bars');
		assert.deepStrictEqual(saved[1].values.serverSource, saved[0].values.serverSource, 'the rerun records the same source');
		await action.disposeRunDataFile('run-2');
	});

	test('no timeframe from the run config or global state is a visible error, never a default', async () => {
		// NEGATIVE CONTROL: restore `?? '1D'` in resolveServerRun -> the run
		// proceeds on 1D (a run file is written and the engine is called) and
		// no error is shown -> RED.
		const action = makeActionHarness({ kind: 'server', symbol: 'TEST', displayName: 'Test Inc.' }, undefined);
		await action.runAction(SESSION, {
			actionType: 'backtest',
			config: { action: 'backtest', values: { dataSource: 'server:TEST', paramSource: 'code' } }
		});
		assert.strictEqual(action.requests.length, 0, 'the engine is not called');
		assert.strictEqual(calls, 0, 'no bars are fetched');
		assert.deepStrictEqual(fs.readdirSync(runDir), [], 'no run file is written');
		assert.ok(
			_errorMessagesSnapshot().some(m => m.includes('No timeframe selected for the server run')),
			`shown: ${_errorMessagesSnapshot().join(' | ')}`
		);
	});
});
