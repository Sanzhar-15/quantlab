/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for `pythonPath.ts` -- Phase 5 step 5.C wiring.
 *
 * Pure tests: stub the env / config / homedir args. No fs writes
 * outside the per-test temp directory.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveQuantlabPython, verifyPythonVersion } from '../src/qviz/pythonPath';

function makeExecutable(p: string): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
	fs.chmodSync(p, 0o755);
}

/** Each test gets its own pristine temp dir so order-dependence
 *  doesn't bite (the resolver checks `homeDir/.quantlab/venv/bin/python`,
 *  which would otherwise be shared across tests in a suite). */
function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-py-'));
	try { return fn(dir); }
	finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } }
}

suite('pythonPath.resolveQuantlabPython', () => {

	test('returns null when no candidates exist', () => {
		withTempDir(tempDir => {
			const r = resolveQuantlabPython({
				env: {},
				homeDir: tempDir,
			});
			assert.strictEqual(r, null);
		});
	});

	test('env override has highest priority', () => {
		withTempDir(tempDir => {
			const envPath = path.join(tempDir, 'env-python');
			makeExecutable(envPath);
			const r = resolveQuantlabPython({
				env: { QUANTLAB_PYTHON: envPath },
				quantlabConfigPath: '/never/used',
				homeDir: tempDir,
			});
			assert.ok(r);
			assert.strictEqual(r!.source, 'override-env');
			assert.strictEqual(r!.pythonPath, envPath);
		});
	});

	test('quantlab config beats python ext config', () => {
		withTempDir(tempDir => {
			const qPath = path.join(tempDir, 'q-python');
			const pPath = path.join(tempDir, 'p-python');
			makeExecutable(qPath);
			makeExecutable(pPath);
			const r = resolveQuantlabPython({
				env: {},
				quantlabConfigPath: qPath,
				pythonExtConfigPath: pPath,
				homeDir: tempDir,
			});
			assert.ok(r);
			assert.strictEqual(r!.source, 'config-quantlab');
			assert.strictEqual(r!.pythonPath, qPath);
		});
	});

	test('python ext config falls through to managed venv', () => {
		withTempDir(tempDir => {
			const managed = path.join(tempDir, '.quantlab', 'venv', 'bin', 'python');
			makeExecutable(managed);
			const r = resolveQuantlabPython({
				env: {},
				homeDir: tempDir,
			});
			assert.ok(r);
			assert.strictEqual(r!.source, 'managed-venv');
			assert.strictEqual(r!.pythonPath, managed);
		});
	});

	test('non-existent paths in EXPLICIT config FAIL LOUDLY (no fall-through)', () => {
		// Step C megaudit PP1: prior code silently fell through to the
		// next candidate when an explicit override didn't resolve. An
		// explicit user config pointing at a bad path should produce
		// null, not silently demote to managed-venv.
		withTempDir(tempDir => {
			// Even though a managed venv EXISTS, the explicit override
			// should fail loud.
			const managed = path.join(tempDir, '.quantlab', 'venv', 'bin', 'python');
			makeExecutable(managed);
			const r = resolveQuantlabPython({
				env: {},
				quantlabConfigPath: '/no/such/python',
				homeDir: tempDir,
			});
			assert.strictEqual(r, null,
				'explicit quantlab.pythonPath that doesn\'t exist must NOT fall through to managed-venv');
		});
	});

	test('QUANTLAB_PYTHON env override fails loud when path missing', () => {
		withTempDir(tempDir => {
			const managed = path.join(tempDir, '.quantlab', 'venv', 'bin', 'python');
			makeExecutable(managed);
			const r = resolveQuantlabPython({
				env: { QUANTLAB_PYTHON: '/no/such/python' },
				homeDir: tempDir,
			});
			assert.strictEqual(r, null);
		});
	});

	test('directory at python path is REJECTED (not just X_OK)', () => {
		// Step C megaudit PP3: bare accessSync(X_OK) accepts executable
		// directories on POSIX. The resolver must require isFile().
		withTempDir(tempDir => {
			const dirPath = path.join(tempDir, 'pretend-python');
			fs.mkdirSync(dirPath);
			const r = resolveQuantlabPython({
				env: { QUANTLAB_PYTHON: dirPath },
				homeDir: tempDir,
			});
			assert.strictEqual(r, null);
		});
	});

	test('Windows venv layout uses Scripts/python.exe', () => {
		withTempDir(tempDir => {
			const winVenv = path.join(tempDir, '.quantlab', 'venv', 'Scripts', 'python.exe');
			makeExecutable(winVenv);
			const r = resolveQuantlabPython({
				env: {},
				homeDir: tempDir,
				platform: 'win32',
			});
			assert.ok(r);
			assert.strictEqual(r!.source, 'managed-venv');
			assert.strictEqual(r!.pythonPath, winVenv);
		});
	});

	test('POSIX venv layout uses bin/python (not Windows path)', () => {
		withTempDir(tempDir => {
			const winVenv = path.join(tempDir, '.quantlab', 'venv', 'Scripts', 'python.exe');
			makeExecutable(winVenv);
			// POSIX platform: should NOT find the Windows-layout python.
			const r = resolveQuantlabPython({
				env: {},
				homeDir: tempDir,
				platform: 'linux',
			});
			assert.strictEqual(r, null);
		});
	});

});

suite('pythonPath.verifyPythonVersion', () => {

	test('rejects non-existent path with structured error', () => {
		const r = verifyPythonVersion('/no/such/python', 3, 10);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/failed to execute/.test(r.error), r.error);
	});

	test('rejects /bin/echo (output not parseable as version)', function () {
		// Use the system echo as a known executable that doesn't print
		// MAJOR.MINOR.
		try { fs.accessSync('/bin/echo', fs.constants.X_OK); }
		catch { this.skip(); return; }
		const r = verifyPythonVersion('/bin/echo', 3, 10);
		assert.strictEqual(r.ok, false);
	});

	// Note: positive happy-path test would require a real Python; left
	// as an integration test (will pass on hosts with Python, skip
	// otherwise — covered indirectly by the lifecycle tests).

});
