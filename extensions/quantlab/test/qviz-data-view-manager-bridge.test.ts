/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step D bridge (Phase 5): integration tests for
 * `DataViewManager.switchToVisualise` -- the path that turns a CSV
 * (or parquet/xlsx) into an opened qviz-spec builder. The actual
 * file-creation half (draft spec written to disk) and the
 * `vscode.openWith` routing both run through the vscode shim so the
 * test exercises real production code without a real editor.
 *
 * Coverage:
 *   - first click on a CSV with NO companion: draft .qviz.json gets
 *     written next to the CSV, then opened with `quantlab.visualiseSpecView`
 *   - second click on the same CSV (companion now exists): file is
 *     NOT re-written; existing one is opened verbatim (preserves any
 *     user edits)
 *   - click on a file outside the open workspace folders: refused with
 *     a user-facing error notification, no file written, no open
 *   - click on a non-data file: refused with a warning, no file written
 *   - the written draft validates against `validateOrThrow`
 *   - the written draft's dataset.uri is workspace-relative (not absolute)
 */

import * as assert from 'assert';

import { installVscodeShim } from './helpers/vscode-shim';
installVscodeShim();

import {
	Uri,
	_resetShimState,
	_setWorkspaceFolders,
	_setFile,
	_writesSnapshot,
	_errorMessagesSnapshot,
	_commandsExecuted,
} from './helpers/vscode-shim';
import { DataViewManager } from '../src/views/DataViewManager';
import { parseSpecBytes } from '../src/qviz/specCore';

suite('Step D — DataViewManager.switchToVisualise bridge', () => {

	let mgr: DataViewManager;

	setup(() => {
		_resetShimState();
		mgr = DataViewManager.getInstance();
	});

	test('first click on a CSV writes a companion .qviz.json and opens it', async () => {
		_setWorkspaceFolders([{ uri: Uri.file('/ws'), name: 'ws' }]);
		// CSV must "exist" to satisfy isDataFile's extension check; but
		// the actual data isn't read by switchToVisualise -- it just
		// computes the companion path. We don't need fs content here.
		_setFile('/ws/data/prices.csv', new Uint8Array(0));

		await (mgr.switchToVisualise as unknown as (u: unknown) => Promise<void>)(Uri.file('/ws/data/prices.csv'));

		// Exactly one write: the companion spec next to the CSV.
		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 1, `expected 1 write, got ${writes.length}`);
		assert.strictEqual(writes[0].path, '/ws/data/prices.qviz.json');

		// The written bytes must validate as a real spec.
		const spec = parseSpecBytes(writes[0].bytes, writes[0].path);
		assert.strictEqual(spec.dataset.uri, 'data/prices.csv',
			'dataset.uri must be workspace-relative');
		assert.match(spec.dataset.schema_hash, /^sha256:[0-9a-f]{64}$/,
			'schema_hash must satisfy the sha256:<64 hex> regex');

		// The opened editor must be the qviz-spec custom editor, NOT the
		// legacy data viewer. This is the entire point of Step D.
		const cmds = _commandsExecuted();
		const openWith = cmds.find(c => c.command === 'vscode.openWith');
		assert.ok(openWith, 'switchToVisualise must invoke vscode.openWith');
		assert.strictEqual((openWith!.args[0] as { toString(): string }).toString(),
			Uri.file('/ws/data/prices.qviz.json').toString(),
			'should open the companion, not the original CSV');
		assert.strictEqual(openWith!.args[1], 'quantlab.visualiseSpecView',
			'should route to the Phase 5 spec editor, not the legacy data viewer');
	});

	test('second click on the same CSV reuses the existing companion (no rewrite)', async () => {
		_setWorkspaceFolders([{ uri: Uri.file('/ws'), name: 'ws' }]);
		_setFile('/ws/data/prices.csv', new Uint8Array(0));

		// Simulate a user that already saved a customized spec by
		// pre-populating the companion with a deliberately-distinctive
		// payload. switchToVisualise must NOT clobber this.
		const existing = new TextEncoder().encode('{"sentinel": "must not clobber"}');
		_setFile('/ws/data/prices.qviz.json', existing);

		await (mgr.switchToVisualise as unknown as (u: unknown) => Promise<void>)(Uri.file('/ws/data/prices.csv'));

		// No writes at all -- the sentinel survived.
		assert.strictEqual(_writesSnapshot().length, 0,
			'existing companion must NOT be rewritten');

		// And the open still routes to the companion.
		const cmds = _commandsExecuted();
		const openWith = cmds.find(c => c.command === 'vscode.openWith');
		assert.ok(openWith);
		assert.strictEqual((openWith!.args[0] as { toString(): string }).toString(),
			Uri.file('/ws/data/prices.qviz.json').toString());
	});

	test('CSV outside any open workspace folder is refused with a user notification', async () => {
		_setWorkspaceFolders([{ uri: Uri.file('/ws'), name: 'ws' }]);
		_setFile('/elsewhere/prices.csv', new Uint8Array(0));

		await (mgr.switchToVisualise as unknown as (u: unknown) => Promise<void>)(Uri.file('/elsewhere/prices.csv'));

		// Nothing written, nothing opened.
		assert.strictEqual(_writesSnapshot().length, 0);
		const cmds = _commandsExecuted();
		assert.strictEqual(
			cmds.filter(c => c.command === 'vscode.openWith').length,
			0,
			'no editor should have been opened',
		);

		// User got an actionable error notification.
		const errs = _errorMessagesSnapshot();
		assert.ok(
			errs.some(e => /outside every open workspace folder/.test(e)),
			`expected workspace-membership error notification; got: ${JSON.stringify(errs)}`,
		);
	});

	test('non-data file is refused with a warning (no open, no write)', async () => {
		_setWorkspaceFolders([{ uri: Uri.file('/ws'), name: 'ws' }]);
		_setFile('/ws/notes.txt', new Uint8Array(0));

		await (mgr.switchToVisualise as unknown as (u: unknown) => Promise<void>)(Uri.file('/ws/notes.txt'));

		assert.strictEqual(_writesSnapshot().length, 0);
		const cmds = _commandsExecuted();
		assert.strictEqual(
			cmds.filter(c => c.command === 'vscode.openWith').length,
			0,
		);
		const errs = _errorMessagesSnapshot();
		assert.ok(errs.some(e => /not a supported data file/.test(e)));
	});

	test('no workspace open: refuses with notification, no write', async () => {
		// _setWorkspaceFolders not called -> shim returns undefined for
		// workspaceFolders.
		_setFile('/ws/data/prices.csv', new Uint8Array(0));

		await (mgr.switchToVisualise as unknown as (u: unknown) => Promise<void>)(Uri.file('/ws/data/prices.csv'));

		assert.strictEqual(_writesSnapshot().length, 0);
		const errs = _errorMessagesSnapshot();
		assert.ok(
			errs.some(e => /without an open workspace folder/.test(e)),
			`expected no-workspace error; got: ${JSON.stringify(errs)}`,
		);
	});

	test('preserves special filename chars (spaces, comma, parens) in the companion path', async () => {
		_setWorkspaceFolders([{ uri: Uri.file('/ws'), name: 'ws' }]);
		_setFile('/ws/INDEX_BTCUSD, 1D (4).csv', new Uint8Array(0));

		await (mgr.switchToVisualise as unknown as (u: unknown) => Promise<void>)(Uri.file('/ws/INDEX_BTCUSD, 1D (4).csv'));

		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 1);
		assert.strictEqual(writes[0].path, '/ws/INDEX_BTCUSD, 1D (4).qviz.json');

		const spec = parseSpecBytes(writes[0].bytes, writes[0].path);
		assert.strictEqual(spec.dataset.uri, 'INDEX_BTCUSD, 1D (4).csv');
	});
});
