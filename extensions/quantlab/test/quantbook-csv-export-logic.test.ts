/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-8.2 "Export to CSV" -- unit tests for the one piece of pure logic: defaultCsvFileName (the safe
// default save-dialog file name derived from the active sheet's name). The command itself
// (quantbookExportCsv) is a thin vscode shell over session.export('csv') + showSaveDialog +
// workspace.fs.writeFile. Runs in the normal mocha suite (no engine, no vscode).

import * as assert from 'assert';

import { defaultCsvFileName } from '../src/quantbook/cellGrid/cellGridLogic';

suite('FE-8.2 defaultCsvFileName', () => {
	test('a plain sheet name becomes name.csv', () => {
		assert.strictEqual(defaultCsvFileName('Returns'), 'Returns.csv');
	});
	test('undefined / empty / whitespace-only falls back to export.csv', () => {
		assert.strictEqual(defaultCsvFileName(undefined), 'export.csv');
		assert.strictEqual(defaultCsvFileName(''), 'export.csv');
		assert.strictEqual(defaultCsvFileName('   '), 'export.csv');
	});
	test('characters illegal in file names are replaced with _', () => {
		assert.strictEqual(defaultCsvFileName('P&L: 2026/Q1'), 'P&L_ 2026_Q1.csv');
		assert.strictEqual(defaultCsvFileName('a\\b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h.csv');
	});
	test('control characters are stripped to _', () => {
		assert.strictEqual(defaultCsvFileName('tab\there'), 'tab_here.csv');
	});
	test('runs of whitespace collapse and the name is trimmed', () => {
		assert.strictEqual(defaultCsvFileName('  My   Model  '), 'My Model.csv');
	});
	test('an all-illegal name is sanitized (still valid, not the fallback)', () => {
		assert.strictEqual(defaultCsvFileName('///'), '___.csv');
	});
	test('path-traversal inputs cannot produce a separator (no `/` or `\\` survives)', () => {
		// Defense-in-depth: the value only seeds the save-dialog DEFAULT (the user confirms the real path,
		// and defaultUri is joined under the workspace folder), but the name itself must never carry a
		// separator. A regex change that reintroduced one would fail HERE.
		assert.strictEqual(defaultCsvFileName('..'), '...csv');
		assert.strictEqual(defaultCsvFileName('../x'), '.._x.csv');
		assert.strictEqual(defaultCsvFileName('../../etc/passwd'), '.._.._etc_passwd.csv');
		const out = defaultCsvFileName('a/b\\c');
		assert.ok(!out.includes('/') && !out.includes('\\'), `no separator may survive: got ${out}`);
	});
});
