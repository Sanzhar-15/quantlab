/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G copy/paste -- unit tests for the pure paste planner (offset math, single-cell fill, literal
// vs formula, cut-move source clears). The webview wiring (keydown, reading the selection) is operator
// smoke; this pins the logic the megaudit cares about.

import * as assert from 'assert';

import { planPaste, type GridClipboard } from '../webview/sheets-webview/clipboardLogic';

function clip(top: number, left: number, cells: string[][], isCut = false): GridClipboard {
	return {
		top,
		left,
		rows: cells.length,
		cols: cells[0].length,
		cells: cells.map(row => row.map(rawInput => ({ rawInput }))),
		isCut,
	};
}

suite('FE-1.5 clipboardLogic -- planPaste', () => {
	test('a block pastes once with a constant offset; formulas translate, literals do not', () => {
		// Source A1:B1 = [ "=B1", "text A1" ] at (0,0). Paste top-left at C3 (row 2, col 2) -> offset (2,2).
		const c = clip(0, 0, [['=B1', 'text A1']]);
		const out = planPaste(c, 2, 2, 1, 1);
		assert.deepStrictEqual(out, [
			{ row: 2, col: 2, rawInput: '=D3' }, // =B1 + (2,2) -> =D3
			{ row: 2, col: 3, rawInput: 'text A1' }, // a literal is verbatim (NOT offset to "A3")
		]);
	});

	test('a single copied cell fills a multi-cell selection, offsetting each by its position', () => {
		// Copy A1 = "=A$1+1"; select A2:A4; paste -> fill, col-absolute row stays, rel col... only rows move.
		const c = clip(0, 0, [['=A1+1']]);
		const out = planPaste(c, 1, 0, 3, 1); // selection A2:A4 (3 rows, 1 col)
		assert.deepStrictEqual(out, [
			{ row: 1, col: 0, rawInput: '=A2+1' },
			{ row: 2, col: 0, rawInput: '=A3+1' },
			{ row: 3, col: 0, rawInput: '=A4+1' },
		]);
	});

	test('a single cell into a single-cell selection pastes once (no fill)', () => {
		const c = clip(0, 0, [['=A1']]);
		const out = planPaste(c, 5, 5, 1, 1);
		assert.deepStrictEqual(out, [{ row: 5, col: 5, rawInput: '=F6' }]);
	});

	test('an absolute formula is unchanged by the offset', () => {
		const c = clip(0, 0, [['=$A$1*2']]);
		const out = planPaste(c, 3, 3, 1, 1);
		assert.deepStrictEqual(out, [{ row: 3, col: 3, rawInput: '=$A$1*2' }]);
	});

	test('an empty source cell pastes as a clear', () => {
		const c = clip(0, 0, [['5', '']]);
		const out = planPaste(c, 0, 2, 1, 1);
		assert.deepStrictEqual(out, [
			{ row: 0, col: 2, rawInput: '5' },
			{ row: 0, col: 3, rawInput: '' }, // empty -> clears the target
		]);
	});

	test('cut-move: the paste writes the target AND clears the (non-overlapping) source cells', () => {
		const c = clip(0, 0, [['10', '20']], /*isCut*/ true); // A1:B1 cut
		const out = planPaste(c, 0, 4, 1, 1); // paste at E1 (no overlap with the source)
		assert.deepStrictEqual(out, [
			{ row: 0, col: 4, rawInput: '10' },
			{ row: 0, col: 5, rawInput: '20' },
			{ row: 0, col: 0, rawInput: '' }, // source A1 cleared
			{ row: 0, col: 1, rawInput: '' }, // source B1 cleared
		]);
	});

	test('cut-move with overlap: an overlapping source cell keeps the pasted value (not double-written)', () => {
		const c = clip(0, 0, [['1', '2', '3']], /*isCut*/ true); // A1:C1 cut
		const out = planPaste(c, 0, 1, 1, 1); // paste shifted one col right -> B1:D1 (overlaps B1,C1)
		// Targets B1,C1,D1 written; source A1 cleared; B1,C1 overlap -> NOT cleared (kept as pasted).
		assert.deepStrictEqual(out, [
			{ row: 0, col: 1, rawInput: '1' },
			{ row: 0, col: 2, rawInput: '2' },
			{ row: 0, col: 3, rawInput: '3' },
			{ row: 0, col: 0, rawInput: '' }, // only A1 (the non-overlapping source) is cleared
		]);
	});

	test('a formula pushed off the grid by the paste becomes #REF! (translator semantics)', () => {
		const c = clip(5, 5, [['=A1']]); // a ref well left/up of the source
		const out = planPaste(c, 0, 0, 1, 1); // paste up-left by (-5,-5): A1 -> off-grid
		assert.deepStrictEqual(out, [{ row: 0, col: 0, rawInput: '=#REF!' }]);
	});
});
