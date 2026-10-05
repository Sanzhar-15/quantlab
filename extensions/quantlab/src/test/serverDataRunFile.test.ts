/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { DataService } from '../core/engine/DataService';
import { ServerDataCache } from '../core/engine/ServerDataCache';
import { ServerApiClient, ServerBar } from '../core/server/ServerApiClient';
import { ServerDataSource } from '../types/market';

// QL-DATA Q-2 (a) + DT-3: a backtest on server data reads a per-run CSV that
// is written fresh for that run and disposed at run end. No reuse window, no
// retry: ServerDataCache is the Python engine's INPUT, never a bars cache.

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE: ServerDataSource = { kind: 'server', symbol: 'TEST', displayName: 'TEST' };

suite('Q-2 (a): per-run server-data files', () => {
	let storageRoot = '';
	let runDir = '';
	let calls = 0;
	let omitVolume = false;
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
				volume: (omitVolume ? undefined : 1000 + i) as number
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
		omitVolume = false;
		_resetShimState();
		DataService.resetInstance();
		storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-rundata-'));
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

	test('two runs on one source get two distinct fresh files (no reuse window)', async () => {
		// NEGATIVE CONTROL: restore the 5-minute reuse (a fixed
		// `<symbol>_<tf>.csv` path returned while younger than 5 minutes)
		// -> both runs get the same path and calls === 1 -> RED.
		const first = await ServerDataCache.getInstance().writeRunFile(SOURCE, '1D');
		const second = await ServerDataCache.getInstance().writeRunFile(SOURCE, '1D');
		assert.notStrictEqual(first.path, second.path);
		assert.ok(fs.existsSync(first.path) && fs.existsSync(second.path), 'both run files exist');
		assert.strictEqual(calls, 2, `expected 2 transport calls, made ${calls}`);
		const lines = fs.readFileSync(first.path, 'utf8').split('\n');
		assert.strictEqual(lines[0], 'timestamp,open,high,low,close,volume');
		assert.strictEqual(lines.length, 4, 'header + 3 bars');
		await first.dispose();
		await second.dispose();
	});

	test('dispose deletes the run file; a second dispose is a no-op', async () => {
		// NEGATIVE CONTROL: make disposeRunFile return without unlinking ->
		// the file still exists after dispose -> RED.
		const runFile = await ServerDataCache.getInstance().writeRunFile(SOURCE, '1D');
		assert.ok(fs.existsSync(runFile.path));
		await runFile.dispose();
		assert.ok(!fs.existsSync(runFile.path), 'run file deleted at run end');
		await runFile.dispose();
	});

	test('resetInstance deletes run files that were never disposed', async () => {
		// NEGATIVE CONTROL: make resetInstance leave liveRunFiles alone (only
		// drop the instance) -> the undisposed file survives -> RED.
		const runFile = await ServerDataCache.getInstance().writeRunFile(SOURCE, '1D');
		ServerDataCache.resetInstance();
		assert.ok(!fs.existsSync(runFile.path), 'undisposed run file deleted at reset');
	});

	test('a bar without volume is refused, never written as 0', async () => {
		// NEGATIVE CONTROL: restore `const vol = value ?? 0` in sanitizeVolume
		// -> the run file is written with volume 0 and the call resolves -> RED.
		omitVolume = true;
		await assert.rejects(
			() => ServerDataCache.getInstance().writeRunFile(SOURCE, '1D'),
			/Invalid volume: missing/
		);
		assert.deepStrictEqual(fs.readdirSync(runDir), [], 'no run file written');
	});

	test('the startup sweep removes dead-process and legacy files, keeps live-process run files', async () => {
		// NEGATIVE CONTROL: drop the liveness check in sweepResidue (delete every
		// file) -> this process's and the parent process's run files are gone -> RED.
		const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
		const planted = {
			dead: `run-${deadPid}-TEST_1D_dead.csv`,
			legacy: 'TEST_1D.csv',
			legacyTmp: 'TEST_1D.csv.tmp',
			own: `run-${process.pid}-TEST_1D_own.csv`,
			parent: `run-${process.ppid}-TEST_1D_parent.csv`
		};
		for (const name of Object.values(planted)) {
			fs.writeFileSync(path.join(runDir, name), 'timestamp,open,high,low,close,volume\n');
		}
		await ServerDataCache.getInstance().sweepResidue();
		const left = fs.readdirSync(runDir).sort();
		assert.deepStrictEqual(left, [planted.own, planted.parent].sort());
	});
});
