/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-Export-XLSX (2026-06-16) -- tests for "Export to XLSX".
//
//  1. `defaultXlsxFileName` -- the one piece of PURE logic (the safe save-dialog default name). Runs in
//     the normal mocha suite (no engine, no vscode), exactly like the FE-8.2 CSV sibling.
//  2. A REAL-DYLIB smoke that `session.export('xlsx')` returns a genuine multi-sheet .xlsx package through
//     the IDE load path (`loadQuantbookEngine()` -> `createWorkbookSession()`). This proves the napi wiring
//     AND that the loaded dylib was built with the `xlsx-write` feature -- it fails LOUD (with an actionable
//     "rebuild with --features xlsx-write" message) if the feature is absent (No-Fallbacks; never a silent
//     skip-on-feature-missing). Skips only when the engine binary itself is absent (CI without the engine
//     repo), mirroring quantbook-session.test.ts / quantbook-roundtrip.test.ts.

import * as assert from 'assert';
import * as fs from 'fs';

import { defaultXlsxFileName } from '../src/quantbook/cellGrid/cellGridLogic';
import {
	_resetQuantbookEngineCacheForTests,
	loadQuantbookEngine,
	resolveEnginePath,
} from '../src/quantbook/loader';
import { createWorkbookSession } from '../src/quantbook/session';

suite('FE-Export-XLSX defaultXlsxFileName', () => {
	test('a plain workbook name becomes name.xlsx', () => {
		assert.strictEqual(defaultXlsxFileName('Returns'), 'Returns.xlsx');
	});
	test('undefined / empty / whitespace-only falls back to workbook.xlsx', () => {
		// Whole-workbook export has no single sheet to name after, so the fallback is `workbook` (not `export`).
		assert.strictEqual(defaultXlsxFileName(undefined), 'workbook.xlsx');
		assert.strictEqual(defaultXlsxFileName(''), 'workbook.xlsx');
		assert.strictEqual(defaultXlsxFileName('   '), 'workbook.xlsx');
	});
	test('characters illegal in file names are replaced with _', () => {
		assert.strictEqual(defaultXlsxFileName('P&L: 2026/Q1'), 'P&L_ 2026_Q1.xlsx');
		assert.strictEqual(defaultXlsxFileName('a\\b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h.xlsx');
	});
	test('control characters are stripped to _ and whitespace runs collapse + trim', () => {
		assert.strictEqual(defaultXlsxFileName('tab\there'), 'tab_here.xlsx');
		assert.strictEqual(defaultXlsxFileName('  My   Model  '), 'My Model.xlsx');
	});
	test('path-traversal inputs cannot produce a separator (no `/` or `\\` survives)', () => {
		assert.strictEqual(defaultXlsxFileName('../../etc/passwd'), '.._.._etc_passwd.xlsx');
		const out = defaultXlsxFileName('a/b\\c');
		assert.ok(!out.includes('/') && !out.includes('\\'), `no separator may survive: got ${out}`);
	});
});

function shouldSkip(): boolean {
	const enginePath = resolveEnginePath();
	if (!fs.existsSync(enginePath)) {
		const seen = global as unknown as { __quantbookXlsxExportSkipLogged?: boolean };
		if (!seen.__quantbookXlsxExportSkipLogged) {
			seen.__quantbookXlsxExportSkipLogged = true;
			console.warn(
				`[quantbook-xlsx-export.test] SKIPPING: engine binary not found at ${enginePath} -- build with: ` +
				`cd ../quantlab-quantbook/quantbook-engine && ` +
				`cargo build -p ql-bindings-node --release --features xlsx-write,test-fixtures`,
			);
		}
		return true;
	}
	return false;
}

// The ASCII zip local-file-header magic ("PK\x03\x04") that opens every .xlsx (a zip package).
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

suite('FE-Export-XLSX session.export("xlsx") -- real dylib', () => {
	suiteSetup(function () {
		if (shouldSkip()) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		// Cold dlopen of the cdylib can take 10-30s; preload here so the first test body does not hit the
		// 10s default timeout (same amortization the session/roundtrip suites use).
		this.timeout(60000);
		loadQuantbookEngine();
	});

	function exportXlsxOrExplain(s: ReturnType<typeof createWorkbookSession>): Uint8Array {
		try {
			return s.export('xlsx');
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			// The ONLY expected failure here is a dylib built without `xlsx-write` (the honest
			// not-implemented Capability error). Re-throw with an actionable rebuild hint rather than letting
			// a cryptic engine error read as an unrelated test bug (No-Fallbacks: loud + specific).
			if (/not_implemented|xlsx-write|Capability/i.test(detail)) {
				throw new Error(
					`export('xlsx') returned not-implemented -- the loaded dylib lacks the xlsx-write feature. ` +
					`Rebuild: cd ../quantlab-quantbook/quantbook-engine && ` +
					`cargo build -p ql-bindings-node --release --features xlsx-write,test-fixtures. (${detail})`,
				);
			}
			throw err;
		}
	}

	test('a populated multi-sheet workbook exports a genuine .xlsx package', () => {
		const s = createWorkbookSession();
		const s1 = s.addSheet('Alpha', 1000);
		const s2 = s.addSheet('Beta', 1000);
		s.setValue(s1, 0, 0, { kind: 'number', number: 10 });
		s.setFormula(s1, 0, 1, 'A1+1'); // B1 = 11
		s.setValue(s2, 0, 0, { kind: 'text', text: 'hello' });
		s.recalcDirty();

		const bytes = exportXlsxOrExplain(s);
		const buf = Buffer.from(bytes);

		assert.ok(buf.length > 200, `an .xlsx package is several KB; got ${buf.length} bytes`);
		assert.ok(
			buf.subarray(0, 4).equals(ZIP_MAGIC),
			'bytes open with the zip magic PK\\x03\\x04 (an .xlsx is a zip package)',
		);
		// Zip stores entry FILENAMES uncompressed in each local header, so the raw bytes literally contain the
		// package's part names -- a cheap, robust "this is really an OOXML spreadsheet" assertion.
		const asLatin1 = buf.toString('latin1');
		assert.ok(asLatin1.includes('[Content_Types].xml'), 'package carries the OOXML [Content_Types].xml part');
		// Prove MULTI-sheet output specifically: a single distinct `xl/worksheets/sheetN.xml` would pass a bare
		// `includes('xl/worksheets/sheet')` check, so a regression that silently exported only one sheet would
		// slip through. The 2-sheet workbook above (Alpha + Beta) must emit >=2 distinct worksheet parts.
		const sheetParts = new Set(asLatin1.match(/xl\/worksheets\/sheet\d+\.xml/g) ?? []);
		assert.ok(sheetParts.size >= 2,
			`a 2-sheet workbook must emit >=2 distinct worksheet parts; got ${sheetParts.size} (${[...sheetParts].join(', ')})`);
	});

	test('an empty workbook still exports a valid (non-empty) .xlsx package', () => {
		const s = createWorkbookSession();
		s.addSheet('Sheet1', 1000);
		const buf = Buffer.from(exportXlsxOrExplain(s));
		assert.ok(buf.length > 200 && buf.subarray(0, 4).equals(ZIP_MAGIC),
			'an empty workbook is still a valid, non-empty zip package (no 0-byte case, unlike CSV)');
	});
});
