/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Sheet-tabs (2026-06-10) -- the Excel-style bottom tab strip.
//
// Two layers are covered here; the panel registry + in-place switch (host, vscode-bound) and the visual
// behaviour (tabs render, clicking switches, cells don't leak across sheets) are the operator smoke.
//   1. PURE LOGIC (no engine): `buildSheetStripModel` + `moveIndex` from `sheetTabBar.ts`.
//   2. REORDER COMPOSITION (real engine): the host's tab "Move Left/Right" maps `moveIndex` ->
//      `session.moveSheet(id, newIndex)`. An off-by-one there is a SILENT reorder bug, so we pin the
//      composition against the REAL owning Session, not a mock.

import * as assert from 'assert';
import * as fs from 'fs';

import {
	_resetQuantbookEngineCacheForTests,
	loadQuantbookEngine,
	resolveEnginePath,
} from '../src/quantbook/loader';
import { createWorkbookSession } from '../src/quantbook/session';
import { buildSheetStripModel, moveIndex } from '../webview/sheets-webview/sheetTabBar';

function shouldSkip(): boolean {
	return !fs.existsSync(resolveEnginePath());
}

suite('sheet-tabs -- buildSheetStripModel (pure)', () => {
	test('maps every sheet in order and flags exactly the active one', () => {
		const model = buildSheetStripModel([
			{ id: 0, name: 'S0' },
			{ id: 5, name: 'Returns' },
			{ id: 9, name: 'S9' },
		], 5);
		assert.deepStrictEqual(model, [
			{ id: 0, name: 'S0', active: false },
			{ id: 5, name: 'Returns', active: true },
			{ id: 9, name: 'S9', active: false },
		]);
	});

	test('preserves display order (does NOT sort by id)', () => {
		const model = buildSheetStripModel([{ id: 9, name: 'b' }, { id: 2, name: 'a' }], 9);
		assert.deepStrictEqual(model.map(m => m.id), [9, 2], 'order is the host display order, untouched');
	});

	test('an active id absent from the list flags nothing (no crash)', () => {
		const model = buildSheetStripModel([{ id: 0, name: 'S0' }, { id: 1, name: 'S1' }], 42);
		assert.deepStrictEqual(model.map(m => m.active), [false, false]);
	});

	test('an empty sheet list yields an empty model', () => {
		assert.deepStrictEqual(buildSheetStripModel([], 0), []);
	});
});

suite('sheet-tabs -- moveIndex (pure; mirrors the host moveSheet one-step math)', () => {
	const order = [0, 5, 9]; // a sparse display order

	test('move right is idx+1; move left is idx-1', () => {
		assert.strictEqual(moveIndex(order, 0, 1), 1, 'first -> right -> index 1');
		assert.strictEqual(moveIndex(order, 5, 1), 2, 'middle -> right -> index 2');
		assert.strictEqual(moveIndex(order, 9, -1), 1, 'last -> left -> index 1');
		assert.strictEqual(moveIndex(order, 5, -1), 0, 'middle -> left -> index 0');
	});

	test('clamps at the ends (already first/last -> null, a no-op)', () => {
		assert.strictEqual(moveIndex(order, 0, -1), null, 'first cannot move left');
		assert.strictEqual(moveIndex(order, 9, 1), null, 'last cannot move right');
	});

	test('an id absent from the order returns null', () => {
		assert.strictEqual(moveIndex(order, 42, 1), null);
		assert.strictEqual(moveIndex(order, 42, -1), null);
	});
});

suite('sheet-tabs -- reorder composition against the REAL engine', () => {
	suiteSetup(function () {
		if (shouldSkip()) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		this.timeout(60000); // cold dlopen of the cdylib
		loadQuantbookEngine();
	});

	test('moveIndex -> session.moveSheet reorders the live sheets as the strip intends', () => {
		const s = createWorkbookSession();
		// A fresh workbook session starts EMPTY; add three sheets -> a known display order.
		s.addSheet('A', 1000);
		s.addSheet('B', 1000);
		s.addSheet('C', 1000);
		const order0 = s.listSheets().map(x => x.id);
		assert.strictEqual(order0.length, 3, 'three live sheets');
		const first = order0[0];
		const second = order0[1];

		// Tab "Move Right" on the first sheet: moveIndex(order, first, +1) -> 1, then moveSheet.
		const right = moveIndex(order0, first, 1);
		assert.strictEqual(right, 1);
		s.moveSheet(first, right as number);
		const order1 = s.listSheets().map(x => x.id);
		assert.strictEqual(order1.indexOf(first), 1, 'the first sheet moved one position right (to index 1)');
		assert.strictEqual(order1[0], second, 'the second sheet is now first');

		// Tab "Move Left" puts it back: moveIndex(order1, first, -1) -> 0, then moveSheet.
		const left = moveIndex(order1, first, -1);
		assert.strictEqual(left, 0);
		s.moveSheet(first, left as number);
		assert.deepStrictEqual(s.listSheets().map(x => x.id), order0, 'restored the original display order');

		s.close();
	});

	test('a deleted sheet drops out of listSheets; a surviving sheet remains (delete-active survivor logic)', () => {
		const s = createWorkbookSession();
		s.addSheet('A', 1000);
		s.addSheet('B', 1000);
		const order0 = s.listSheets().map(x => x.id);
		assert.strictEqual(order0.length, 2);
		s.deleteSheet(order0[0]);
		const survivors = s.listSheets().map(x => x.id);
		assert.deepStrictEqual(survivors, [order0[1]], 'the deleted sheet is gone; the other survives');
		s.close();
	});
});
