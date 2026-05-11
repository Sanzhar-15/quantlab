/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit-2 A4-M7: unit tests for `assertSafeDataFilePath` -- the
 * workspace-boundary + extension-allowlist guard that protects the
 * Python data-inspector spawn from absolute / `..`-escape / non-
 * allowlisted paths. Previously untested directly (covered only
 * indirectly via the qviz daemon's resolveDatasetPath tests, which
 * skip the workspace-folders membership half of the contract).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { installVscodeShim } from './helpers/vscode-shim';
installVscodeShim();

import { Uri, _resetShimState, _setWorkspaceFolders } from './helpers/vscode-shim';
import { assertSafeDataFilePath } from '../src/commands/dataCommands';

suite('assertSafeDataFilePath', () => {

	// `resolveDatasetPath` calls fs.statSync, so the "accepts" tests
	// need REAL files on disk under a temporary workspace root. We
	// build one fresh per test so behavior is isolated.
	let tmpRoot: string;
	let dataDir: string;

	setup(() => {
		_resetShimState();
		tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'qviz-assert-'));
		dataDir = nodePath.join(tmpRoot, 'data');
		fs.mkdirSync(dataDir);
		// Create the three allowlisted extension test fixtures.
		fs.writeFileSync(nodePath.join(dataDir, 'x.parquet'), 'PAR1\x00');
		fs.writeFileSync(nodePath.join(dataDir, 'x.csv'), 'a,b\n1,2\n');
		fs.writeFileSync(nodePath.join(dataDir, 'x.tsv'), 'a\tb\n1\t2\n');
		fs.writeFileSync(nodePath.join(dataDir, 'x.xlsx'), 'PK\x03\x04');
		fs.writeFileSync(nodePath.join(dataDir, 'x.json'), '{}');
	});

	teardown(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	test('refuses non-string filePath', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.throws(() => assertSafeDataFilePath(42 as unknown),
			/filePath must be a non-empty string/);
		assert.throws(() => assertSafeDataFilePath(undefined as unknown),
			/filePath must be a non-empty string/);
		assert.throws(() => assertSafeDataFilePath(null as unknown),
			/filePath must be a non-empty string/);
	});

	test('refuses empty string', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.throws(() => assertSafeDataFilePath(''),
			/filePath must be a non-empty string/);
	});

	test('refuses when no workspace is open', () => {
		assert.throws(() => assertSafeDataFilePath('data/x.parquet'),
			/no workspace folder open/);
	});

	test('refuses absolute paths outside any workspace', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.throws(() => assertSafeDataFilePath('/etc/passwd'),
			/refused/);
	});

	test('accepts absolute paths inside the workspace (smoke-test fix)', () => {
		// VS Code's `uri.fsPath` is always absolute. The data viewer
		// path forwards that to `quantlab.getDataFileColumns`. The
		// original CRITICAL-13 implementation rejected ALL absolute
		// paths, breaking the legitimate "Visualise a data file" flow.
		// The fix demotes absolute → workspace-relative when it's
		// strictly inside a workspace folder.
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		const abs = nodePath.join(tmpRoot, 'data', 'x.parquet');
		assert.doesNotThrow(() => assertSafeDataFilePath(abs));
	});

	test('refuses absolute paths that escape via symlink target / parent dir', () => {
		// "/Users/.../tmpRoot/../../../etc/passwd" -- absolute-looking but
		// after normalization sits outside the workspace.
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		const malicious = nodePath.join(tmpRoot, '..', '..', '..', '..', 'etc', 'passwd');
		assert.throws(() => assertSafeDataFilePath(malicious),
			/refused/);
	});

	test('refuses `..` escapes', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.throws(() => assertSafeDataFilePath('../outside.parquet'),
			/refused/);
		assert.throws(() => assertSafeDataFilePath('data/../../outside.parquet'),
			/refused/);
	});

	test('refuses non-allowlisted extension (.xlsx)', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		// xlsx is allowlisted in the broader DataView UI (types/data.ts)
		// but NOT here -- this guard is for the qviz/inspector path
		// which uses pyarrow.
		assert.throws(() => assertSafeDataFilePath('data/x.xlsx'),
			/refused/);
	});

	test('refuses non-allowlisted extension (.json)', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.throws(() => assertSafeDataFilePath('data/x.json'),
			/refused/);
	});

	test('accepts a workspace-relative .parquet path', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.doesNotThrow(() => assertSafeDataFilePath('data/x.parquet'));
	});

	test('accepts a workspace-relative .csv path', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.doesNotThrow(() => assertSafeDataFilePath('data/x.csv'));
	});

	test('accepts a workspace-relative .tsv path', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		assert.doesNotThrow(() => assertSafeDataFilePath('data/x.tsv'));
	});

	test('multi-folder workspace: path resolved by SECOND folder is accepted', () => {
		// Build a second workspace root that does NOT have the file,
		// and prepend a folder that does -- the first ok wins.
		_setWorkspaceFolders([
			{ uri: Uri.file(tmpRoot), name: 'A' },
			{ uri: Uri.file('/does-not-exist-' + Math.random()), name: 'B' },
		]);
		assert.doesNotThrow(() => assertSafeDataFilePath('data/x.parquet'));
	});

	test('multi-folder workspace: still refuses extension miss across all folders', () => {
		const tmpB = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'qviz-assert-B-'));
		try {
			_setWorkspaceFolders([
				{ uri: Uri.file(tmpRoot), name: 'A' },
				{ uri: Uri.file(tmpB), name: 'B' },
			]);
			// xlsx not allowlisted; the loop falls through all folders
			// without hitting an `ok` result.
			assert.throws(() => assertSafeDataFilePath('data/x.xlsx'),
				/refused/);
		} finally {
			fs.rmSync(tmpB, { recursive: true, force: true });
		}
	});

	test('error message names the rejected path', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		try {
			assertSafeDataFilePath('data/x.xlsx');
			assert.fail('should have thrown');
		} catch (e) {
			assert.match((e as Error).message, /data\/x\.xlsx/,
				`error must include the rejected path; got: ${(e as Error).message}`);
		}
	});

	test('platform path-separator sanity: forward-slash is normalized', () => {
		_setWorkspaceFolders([{ uri: Uri.file(tmpRoot), name: 'ws' }]);
		const p = nodePath.posix.join('data', 'x.parquet');
		assert.doesNotThrow(() => assertSafeDataFilePath(p));
	});
});
