/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import fsModule = require('fs');
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

	// QL-LOGIN+DATA c1 SHOULD 8: the cache keeps cleanup ownership of a run file until its unlink SUCCEEDS -- in dispose, in
	// resetInstance and in partial-write cleanup. A failed unlink is visible (it throws) and is never retried by itself; the
	// next EXPLICIT cleanup tries again.
	suite('cleanup ownership until the unlink succeeds', () => {
		const realUnlink = fsModule.promises.unlink;
		const realUnlinkSync = fsModule.unlinkSync;
		const realWriteFile = fsModule.promises.writeFile;
		let attempts: string[] = [];
		let ebusyBudget = 0;

		const ebusy = (): Error => Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
		const owned = (runPath: string, instance: ServerDataCache): boolean =>
			(instance as unknown as { liveRunFiles: Set<string> }).liveRunFiles.has(runPath);

		setup(() => {
			attempts = [];
			ebusyBudget = 0;
			// Every unlink is counted; the first `ebusyBudget` of them fail with EBUSY, the rest reach the real filesystem.
			(fsModule.promises as unknown as { unlink: unknown }).unlink = async (target: string): Promise<void> => {
				attempts.push(`unlink ${path.basename(target)}`);
				if (ebusyBudget > 0) {
					ebusyBudget--;
					throw ebusy();
				}
				return realUnlink(target);
			};
			(fsModule as unknown as { unlinkSync: unknown }).unlinkSync = (target: string): void => {
				attempts.push(`unlinkSync ${path.basename(target)}`);
				if (ebusyBudget > 0) {
					ebusyBudget--;
					throw ebusy();
				}
				realUnlinkSync(target);
			};
		});

		teardown(() => {
			(fsModule.promises as unknown as { unlink: unknown }).unlink = realUnlink;
			(fsModule as unknown as { unlinkSync: unknown }).unlinkSync = realUnlinkSync;
			(fsModule.promises as unknown as { writeFile: unknown }).writeFile = realWriteFile;
		});

		test('dispose: a first unlink that fails EBUSY throws and keeps the path; the second explicit dispose deletes it (2 attempts)', async () => {
			// NEGATIVE CONTROL: put `this.liveRunFiles.delete(runPath)` back before the unlink in disposeRunFile (and
			// drop the delete from unlinkOwned's success path) -> the second dispose is a silent no-op: 1 attempt,
			// the file still exists, the path is no longer owned -> RED.
			const instance = ServerDataCache.getInstance();
			const runFile = await instance.writeRunFile(SOURCE, '1D');
			ebusyBudget = 1;

			await assert.rejects(() => runFile.dispose(), /EBUSY/);
			assert.strictEqual(attempts.length, 1);
			assert.ok(owned(runFile.path, instance), 'the failed unlink keeps the path owned');
			assert.ok(fs.existsSync(runFile.path));

			await runFile.dispose();
			assert.strictEqual(attempts.length, 2, 'no automatic retry in between: exactly one attempt per explicit dispose');
			assert.ok(!owned(runFile.path, instance), 'ownership ends when the unlink succeeds');
			assert.ok(!fs.existsSync(runFile.path));

			await runFile.dispose();
			assert.strictEqual(attempts.length, 2, 'a dispose after success does nothing');
		});

		test('reset: a first unlinkSync that fails EBUSY throws and keeps the path; the file\'s explicit dispose deletes it (2 attempts)', async () => {
			// NEGATIVE CONTROL: put `instance.liveRunFiles.delete(runPath)` back before `fs.unlinkSync` in resetInstance
			// -> the explicit dispose afterwards is a silent no-op: 1 attempt, the file still exists -> RED.
			const instance = ServerDataCache.getInstance();
			const runFile = await instance.writeRunFile(SOURCE, '1D');
			ebusyBudget = 1;

			assert.throws(() => ServerDataCache.resetInstance(), /1 run data file\(s\) could not be deleted.*EBUSY/);
			assert.strictEqual(attempts.length, 1);
			assert.ok(owned(runFile.path, instance), 'the failed reset keeps the path owned by the retired instance');
			assert.ok(fs.existsSync(runFile.path));

			await runFile.dispose();
			assert.deepStrictEqual(attempts, [`unlinkSync ${path.basename(runFile.path)}`, `unlink ${path.basename(runFile.path)}`]);
			assert.ok(!owned(runFile.path, instance));
			assert.ok(!fs.existsSync(runFile.path));
		});

		test('partial-write cleanup: a failed unlink keeps the path owned; the explicit reset deletes it (2 attempts)', async () => {
			// NEGATIVE CONTROL: put `this.liveRunFiles.delete(runPath)` back as the first statement of writeRunFile's
			// catch -> the path is forgotten, resetInstance finds nothing, the partial file survives with 1 attempt -> RED.
			const instance = ServerDataCache.getInstance();
			(fsModule.promises as unknown as { writeFile: unknown }).writeFile = async (target: string, data: string, options: object): Promise<void> => {
				await realWriteFile(target, data.slice(0, 10), options as fs.WriteFileOptions);
				throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
			};
			ebusyBudget = 1;

			await assert.rejects(
				() => instance.writeRunFile(SOURCE, '1D'),
				/Failed to write run data file .*EIO.*removing the partial file also failed: EBUSY/
			);
			const [partial] = fs.readdirSync(runDir);
			assert.ok(partial, 'the partial file is left behind');
			const partialPath = path.join(runDir, partial);
			assert.strictEqual(attempts.length, 1);
			assert.ok(owned(partialPath, instance), 'the failed cleanup keeps the path owned');

			ServerDataCache.resetInstance();
			assert.strictEqual(attempts.length, 2);
			assert.ok(!owned(partialPath, instance));
			assert.ok(!fs.existsSync(partialPath));
		});

		test('partial-write cleanup that succeeds releases the path at once', async () => {
			const instance = ServerDataCache.getInstance();
			(fsModule.promises as unknown as { writeFile: unknown }).writeFile = async (target: string, data: string, options: object): Promise<void> => {
				await realWriteFile(target, data.slice(0, 10), options as fs.WriteFileOptions);
				throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
			};

			await assert.rejects(() => instance.writeRunFile(SOURCE, '1D'), /Failed to write run data file .*EIO/);
			assert.strictEqual(attempts.length, 1);
			assert.deepStrictEqual(fs.readdirSync(runDir), []);
			assert.strictEqual((instance as unknown as { liveRunFiles: Set<string> }).liveRunFiles.size, 0);
		});

		test('two concurrent disposes of one file share one unlink attempt', async () => {
			const runFile = await ServerDataCache.getInstance().writeRunFile(SOURCE, '1D');

			await Promise.all([runFile.dispose(), runFile.dispose()]);

			assert.strictEqual(attempts.length, 1);
			assert.ok(!fs.existsSync(runFile.path));
		});

		test('a file that is already gone (ENOENT) is reported once, then no longer owned', async () => {
			const instance = ServerDataCache.getInstance();
			const runFile = await instance.writeRunFile(SOURCE, '1D');
			fs.unlinkSync(runFile.path);
			attempts = [];

			await assert.rejects(() => runFile.dispose(), /ENOENT/);
			assert.ok(!owned(runFile.path, instance), 'nothing is left to own');
			await runFile.dispose();
			assert.strictEqual(attempts.length, 1);
		});
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
