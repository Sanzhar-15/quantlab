/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 W2 "Sort range by column" -- tests for the vscode-free sort core (sortLogic.ts):
//   PURE (no engine, no vscode): toSortableValue narrowing, the comparator + cross-type order, the stable row
//   permutation (blanks-last both directions, stability), the FORMULA-REFUSE corruption guard, the
//   error/pending value-kind refuse, the full-rect setValue batch builder, offset-rect permutation, the
//   already-sorted no-op detector, and the key-column choices.
//   ENGINE-BACKED (real owning Session; SKIPS when the cdylib is absent, e.g. on the Linux VM -- runs on the
//   Mac gate): apply a sort batch to a live workbook and assert (1) the rows actually permute, (2) sort->undo
//   restores the original order, (3) number-FORMATS do NOT travel with the sorted rows (documented v1
//   limitation (a)), and (4) a rect containing a formula is REFUSED (no ops emitted, the workbook is untouched).
//
// The command (quantbookCommands.ts) is a thin vscode shell over these (the established N-1/N-2 split).

import * as assert from 'assert';
import * as fs from 'fs';

import {
	MAX_SORT_BATCH_CELLS,
	buildSortBatch,
	buildSortKeyChoices,
	buildSortUndoLabel,
	compareSortable,
	computeSortPermutation,
	isAlreadySorted,
	readRectGrid,
	type SortableCellValue,
	type SortDirection,
} from '../src/quantbook/cellGrid/sortLogic';
import type { CellSnapshotJson, WorkbookSnapshotJson } from '../src/quantbook/types';
import {
	_resetQuantbookEngineCacheForTests,
	loadQuantbookEngine,
	resolveEnginePath,
} from '../src/quantbook/loader';
import { createWorkbookSession } from '../src/quantbook/session';
import { buildSetFormatOps, formatStringForPreset } from '../src/quantbook/cellGrid/formatPickerLogic';

function shouldSkip(): boolean {
	return !fs.existsSync(resolveEnginePath());
}

// --- Pure fixture helpers ----------------------------------------------------------------------------------

const NUM = (n: number): SortableCellValue => ({ kind: 'number', number: n });
const TXT = (t: string): SortableCellValue => ({ kind: 'text', text: t });
const BOOL = (b: boolean): SortableCellValue => ({ kind: 'boolean', boolean: b });
const BLANK: SortableCellValue = { kind: 'blank' };

/** Build a minimal one-sheet WorkbookSnapshotJson from a sparse cell list (for readRectGrid tests). */
function snapshotOf(sheetId: number, cells: CellSnapshotJson[]): WorkbookSnapshotJson {
	return {
		sheets: [{ id: sheetId, name: `S${sheetId}`, cells }],
		formats: [],
	} as unknown as WorkbookSnapshotJson;
}

function numCell(row: number, col: number, n: number): CellSnapshotJson {
	return { row, col, value: { kind: 'number', number: n } };
}
function textCell(row: number, col: number, t: string): CellSnapshotJson {
	return { row, col, value: { kind: 'text', text: t } };
}
function formulaCell(row: number, col: number, formula: string, computed: number): CellSnapshotJson {
	return { row, col, formula, value: { kind: 'number', number: computed } };
}

// =================================================================================================
// PURE: compareSortable + cross-type ordering
// =================================================================================================

suite('W2 sortLogic -- compareSortable (cross-type + within-type order)', () => {
	test('numbers order numerically', () => {
		assert.ok(compareSortable(NUM(1), NUM(2)) < 0);
		assert.ok(compareSortable(NUM(2), NUM(1)) > 0);
		assert.strictEqual(compareSortable(NUM(5), NUM(5)), 0);
		assert.ok(compareSortable(NUM(-3), NUM(0)) < 0);
	});
	test('text orders by JS code-unit compare', () => {
		assert.ok(compareSortable(TXT('apple'), TXT('banana')) < 0);
		assert.ok(compareSortable(TXT('Zebra'), TXT('apple')) < 0, 'uppercase sorts before lowercase (code-unit)');
		assert.strictEqual(compareSortable(TXT('x'), TXT('x')), 0);
	});
	test('booleans: FALSE before TRUE', () => {
		assert.ok(compareSortable(BOOL(false), BOOL(true)) < 0);
		assert.ok(compareSortable(BOOL(true), BOOL(false)) > 0);
		assert.strictEqual(compareSortable(BOOL(true), BOOL(true)), 0);
	});
	test('cross-type: numbers < text < booleans (Excel convention)', () => {
		assert.ok(compareSortable(NUM(999), TXT('a')) < 0, 'any number sorts before any text');
		assert.ok(compareSortable(TXT('zzz'), BOOL(false)) < 0, 'any text sorts before any boolean');
		assert.ok(compareSortable(NUM(0), BOOL(false)) < 0, 'any number sorts before any boolean');
	});
	test('blanks must NOT be passed to the comparator (partitioned out) -- it throws', () => {
		assert.throws(() => compareSortable(BLANK, NUM(1)), /\[bad_argument\].*blank/);
	});
});

// =================================================================================================
// PURE: computeSortPermutation -- stability, blanks-last, direction
// =================================================================================================

suite('W2 sortLogic -- computeSortPermutation', () => {
	test('ascending number sort produces the correct permutation', () => {
		// keys: [30, 10, 20] -> sorted asc -> rows [10@idx1, 20@idx2, 30@idx0] -> perm [1,2,0]
		const perm = computeSortPermutation([NUM(30), NUM(10), NUM(20)], 'asc');
		assert.deepStrictEqual(perm, [1, 2, 0]);
	});
	test('descending number sort reverses the non-blank order', () => {
		const perm = computeSortPermutation([NUM(30), NUM(10), NUM(20)], 'desc');
		assert.deepStrictEqual(perm, [0, 2, 1]);
	});
	test('text sort ascending + descending', () => {
		const keys = [TXT('banana'), TXT('apple'), TXT('cherry')];
		assert.deepStrictEqual(computeSortPermutation(keys, 'asc'), [1, 0, 2]);
		assert.deepStrictEqual(computeSortPermutation(keys, 'desc'), [2, 0, 1]);
	});
	test('mixed types sort numbers < text < booleans ascending', () => {
		// idx0=text 'b', idx1=number 5, idx2=boolean true, idx3=number 1, idx4=text 'a'
		const keys = [TXT('b'), NUM(5), BOOL(true), NUM(1), TXT('a')];
		// asc: numbers [1@3, 5@1], text ['a'@4, 'b'@0], boolean [true@2]
		assert.deepStrictEqual(computeSortPermutation(keys, 'asc'), [3, 1, 4, 0, 2]);
	});
	test('blanks are ALWAYS last in ASCENDING', () => {
		const keys = [NUM(2), BLANK, NUM(1), BLANK];
		const perm = computeSortPermutation(keys, 'asc');
		// non-blank asc: [1@2, 2@0]; blanks [1, 3] keep original order, trailing
		assert.deepStrictEqual(perm, [2, 0, 1, 3]);
	});
	test('blanks are ALSO last in DESCENDING (blanks-sink, NOT bubbled to top)', () => {
		const keys = [NUM(2), BLANK, NUM(1), BLANK];
		const perm = computeSortPermutation(keys, 'desc');
		// non-blank desc: [2@0, 1@2]; blanks [1, 3] STILL trail
		assert.deepStrictEqual(perm, [0, 2, 1, 3]);
	});
	test('stable: equal keys keep original relative order ASCENDING', () => {
		// three rows with equal key 5 (idx 0,2,4) interleaved with smaller key 1 (idx 1,3)
		const keys = [NUM(5), NUM(1), NUM(5), NUM(1), NUM(5)];
		const perm = computeSortPermutation(keys, 'asc');
		// 1s first (idx 1,3 in order), then 5s (idx 0,2,4 in order)
		assert.deepStrictEqual(perm, [1, 3, 0, 2, 4]);
	});
	test('stable: equal keys keep original relative order DESCENDING (NOT reversed among ties)', () => {
		const keys = [NUM(5), NUM(1), NUM(5), NUM(1), NUM(5)];
		const perm = computeSortPermutation(keys, 'desc');
		// 5s first, and among the equal 5s the original order (0,2,4) is PRESERVED -- the tie-break is not signed
		assert.deepStrictEqual(perm, [0, 2, 4, 1, 3]);
	});
	test('all-blank keys -> identity permutation', () => {
		assert.deepStrictEqual(computeSortPermutation([BLANK, BLANK, BLANK], 'asc'), [0, 1, 2]);
		assert.deepStrictEqual(computeSortPermutation([BLANK, BLANK, BLANK], 'desc'), [0, 1, 2]);
	});
});

// =================================================================================================
// PURE: readRectGrid -- the corruption guard + value narrowing + offset rects
// =================================================================================================

suite('W2 sortLogic -- readRectGrid (corruption guard + materialization)', () => {
	test('reads a dense grid + key column from a sparse snapshot (absent cells = blank)', () => {
		const snap = snapshotOf(0, [numCell(0, 0, 30), numCell(2, 0, 10), textCell(1, 1, 'x')]);
		const grid = readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 }, 0);
		assert.strictEqual(grid.rows, 3);
		assert.strictEqual(grid.cols, 2);
		assert.deepStrictEqual(grid.keys, [NUM(30), BLANK, NUM(10)]);
		assert.deepStrictEqual(grid.grid[1], [BLANK, TXT('x')], 'row 1: A blank, B "x"');
	});
	test('REFUSES on a single formula cell anywhere in the rect ([refuse_formula], no read)', () => {
		const snap = snapshotOf(0, [numCell(0, 0, 1), formulaCell(1, 1, 'A1*2', 2), numCell(2, 0, 3)]);
		assert.throws(
			() => readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 }, 0),
			/\[refuse_formula\].*B2/,
		);
	});
	test('a formula OUTSIDE the rect does NOT trigger the refuse', () => {
		// formula at C1 (col 2); rect is A1:B3 (cols 0-1) -> formula is irrelevant.
		const snap = snapshotOf(0, [numCell(0, 0, 1), formulaCell(0, 2, 'A1*2', 2)]);
		const grid = readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 }, 0);
		assert.strictEqual(grid.rows, 3);
	});
	test('REFUSES a non-formula cell carrying an engine-produced error value ([refuse_value_kind])', () => {
		const snap = snapshotOf(0, [{ row: 0, col: 0, value: { kind: 'error', error: '#DIV/0!' } }]);
		assert.throws(
			() => readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 0),
			/\[refuse_value_kind\].*error/,
		);
	});
	test('REFUSES a non-formula cell carrying a pending value ([refuse_value_kind])', () => {
		const snap = snapshotOf(0, [{ row: 0, col: 0, value: { kind: 'pending' } }]);
		assert.throws(
			() => readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 0),
			/\[refuse_value_kind\].*pending/,
		);
	});
	test('a missing sheet is rejected [bad_argument]', () => {
		const snap = snapshotOf(0, []);
		assert.throws(() => readRectGrid(snap, 9, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 0), /\[bad_argument\].*no sheet/);
	});
	test('a key column outside the rect is rejected [bad_argument]', () => {
		const snap = snapshotOf(0, []);
		assert.throws(() => readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, 5), /\[bad_argument\].*key column/);
	});
	test('an oversized rect is rejected before reading [bad_argument]', () => {
		const snap = snapshotOf(0, []);
		assert.throws(() => readRectGrid(snap, 0, { startRow: 0, startCol: 0, endRow: 999, endCol: 999 }, 0), new RegExp(`\\[bad_argument\\].*${MAX_SORT_BATCH_CELLS}`));
	});
});

// =================================================================================================
// PURE: buildSortBatch -- the full-rect setValue rewrite
// =================================================================================================

suite('W2 sortLogic -- buildSortBatch (full-rect setValue rewrite)', () => {
	test('values-only sort permutes correctly + rewrites EVERY rect cell (mixed multi-column)', () => {
		// A1:B3 -- key col A. Rows: (30,'x'),(10,'y'),(20,'z'). Asc on A -> (10,'y'),(20,'z'),(30,'x').
		const snap = snapshotOf(0, [
			numCell(0, 0, 30), textCell(0, 1, 'x'),
			numCell(1, 0, 10), textCell(1, 1, 'y'),
			numCell(2, 0, 20), textCell(2, 1, 'z'),
		]);
		const ops = buildSortBatch(0, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 }, 0, 'asc', snap);
		assert.strictEqual(ops.length, 6, 'full-rect rewrite: 3 rows x 2 cols = 6 ops');
		// Destination row 0 carries source row 1's values (10,'y'); row 1 -> (20,'z'); row 2 -> (30,'x').
		assert.deepStrictEqual(ops[0], { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'number', number: 10 } });
		assert.deepStrictEqual(ops[1], { kind: 'setValue', sheet: 0, row: 0, col: 1, value: { kind: 'text', text: 'y' } });
		assert.deepStrictEqual(ops[2], { kind: 'setValue', sheet: 0, row: 1, col: 0, value: { kind: 'number', number: 20 } });
		assert.deepStrictEqual(ops[3], { kind: 'setValue', sheet: 0, row: 1, col: 1, value: { kind: 'text', text: 'z' } });
		assert.deepStrictEqual(ops[4], { kind: 'setValue', sheet: 0, row: 2, col: 0, value: { kind: 'number', number: 30 } });
		assert.deepStrictEqual(ops[5], { kind: 'setValue', sheet: 0, row: 2, col: 1, value: { kind: 'text', text: 'x' } });
	});
	test('descending direction reverses the row order', () => {
		const snap = snapshotOf(0, [numCell(0, 0, 1), numCell(1, 0, 3), numCell(2, 0, 2)]);
		const ops = buildSortBatch(0, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'desc', snap);
		assert.deepStrictEqual(ops.map(o => o.value), [
			{ kind: 'number', number: 3 }, { kind: 'number', number: 2 }, { kind: 'number', number: 1 },
		]);
	});
	test('blanks sort last + are rewritten as setValue {kind:"blank"} (NOT a clear op)', () => {
		const snap = snapshotOf(0, [numCell(0, 0, 2), numCell(2, 0, 1)]); // row 1 is blank
		const ops = buildSortBatch(0, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'asc', snap);
		assert.strictEqual(ops.length, 3);
		// asc: [1@row2, 2@row0, blank@row1]
		assert.deepStrictEqual(ops[0].value, { kind: 'number', number: 1 });
		assert.deepStrictEqual(ops[1].value, { kind: 'number', number: 2 });
		assert.deepStrictEqual(ops[2], { kind: 'setValue', sheet: 0, row: 2, col: 0, value: { kind: 'blank' } });
		assert.ok(ops.every(o => o.kind === 'setValue'), 'every op is a setValue (no clear ops)');
	});
	test('untouched-value cells still get an IDENTICAL setValue op (full-rect rewrite contract)', () => {
		// already-sorted ascending: every row maps to itself; ops re-write each cell with its own value.
		const snap = snapshotOf(0, [numCell(0, 0, 1), numCell(1, 0, 2), numCell(2, 0, 3)]);
		const ops = buildSortBatch(0, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'asc', snap);
		assert.deepStrictEqual(ops.map(o => `${o.row},${o.col}`), ['0,0', '1,0', '2,0']);
		assert.deepStrictEqual(ops.map(o => o.value), [
			{ kind: 'number', number: 1 }, { kind: 'number', number: 2 }, { kind: 'number', number: 3 },
		]);
	});
	test('OFFSET rect (not starting at A1) permutes correctly with absolute coords', () => {
		// rect C3:D5 (startRow 2, startCol 2). key col C. values down C: 9,7,8 -> asc -> 7,8,9
		const snap = snapshotOf(0, [
			numCell(2, 2, 9), textCell(2, 3, 'p'),
			numCell(3, 2, 7), textCell(3, 3, 'q'),
			numCell(4, 2, 8), textCell(4, 3, 'r'),
		]);
		const ops = buildSortBatch(0, { startRow: 2, startCol: 2, endRow: 4, endCol: 3 }, 2, 'asc', snap);
		assert.strictEqual(ops.length, 6);
		// destination C3 (row2,col2) gets source row with C=7 -> value 7 + paired D='q'
		assert.deepStrictEqual(ops[0], { kind: 'setValue', sheet: 0, row: 2, col: 2, value: { kind: 'number', number: 7 } });
		assert.deepStrictEqual(ops[1], { kind: 'setValue', sheet: 0, row: 2, col: 3, value: { kind: 'text', text: 'q' } });
		assert.deepStrictEqual(ops[4], { kind: 'setValue', sheet: 0, row: 4, col: 2, value: { kind: 'number', number: 9 } });
		assert.deepStrictEqual(ops[5], { kind: 'setValue', sheet: 0, row: 4, col: 3, value: { kind: 'text', text: 'p' } });
	});
	test('a rect with a formula emits ZERO ops -- it THROWS [refuse_formula] before building any', () => {
		const snap = snapshotOf(0, [numCell(0, 0, 1), formulaCell(1, 0, 'A1+1', 2)]);
		let ops: unknown;
		assert.throws(() => { ops = buildSortBatch(0, { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, 0, 'asc', snap); }, /\[refuse_formula\]/);
		assert.strictEqual(ops, undefined, 'no ops array was produced');
	});
	test('a non-integer sheet is rejected [bad_argument]', () => {
		const snap = snapshotOf(0, []);
		assert.throws(() => buildSortBatch(0.5, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 0, 'asc', snap), /\[bad_argument\].*sheet/);
	});
	test('numeric-vs-text ordering as documented (numbers before text, both ascending)', () => {
		// key col A: [text "10", number 9, number 100] -> asc -> numbers first (9, 100), then text "10"
		const snap = snapshotOf(0, [textCell(0, 0, '10'), numCell(1, 0, 9), numCell(2, 0, 100)]);
		const ops = buildSortBatch(0, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'asc', snap);
		assert.deepStrictEqual(ops.map(o => o.value), [
			{ kind: 'number', number: 9 },
			{ kind: 'number', number: 100 },
			{ kind: 'text', text: '10' },
		], 'numbers (9, 100) sort before the text "10" -- not a lexical "10" < "100" < "9"');
	});
});

// =================================================================================================
// PURE: isAlreadySorted + buildSortUndoLabel + buildSortKeyChoices
// =================================================================================================

suite('W2 sortLogic -- isAlreadySorted', () => {
	test('an ascending-sorted column is already sorted ascending', () => {
		assert.strictEqual(isAlreadySorted([NUM(1), NUM(2), NUM(3)], 'asc'), true);
		assert.strictEqual(isAlreadySorted([NUM(1), NUM(2), NUM(3)], 'desc'), false);
	});
	test('an unsorted column is not already sorted', () => {
		assert.strictEqual(isAlreadySorted([NUM(3), NUM(1), NUM(2)], 'asc'), false);
	});
	test('a column already in descending order reports sorted-desc', () => {
		assert.strictEqual(isAlreadySorted([NUM(3), NUM(2), NUM(1)], 'desc'), true);
	});
});

suite('W2 sortLogic -- buildSortUndoLabel', () => {
	test('asc + desc phrasing with key column + target', () => {
		assert.strictEqual(buildSortUndoLabel('asc', 'B', 'S0!B1:D3'), 'Sort A->Z: keyed on B over S0!B1:D3');
		assert.strictEqual(buildSortUndoLabel('desc', 'C', 'S0!A1:C9'), 'Sort Z->A: keyed on C over S0!A1:C9');
	});
});

suite('W2 sortLogic -- buildSortKeyChoices', () => {
	test('one choice per rect column, A1-labelled, absolute col index', () => {
		const choices = buildSortKeyChoices({ startRow: 0, startCol: 1, endRow: 5, endCol: 3 });
		assert.deepStrictEqual(choices, [
			{ col: 1, label: 'B' },
			{ col: 2, label: 'C' },
			{ col: 3, label: 'D' },
		]);
	});
	test('a single-column rect yields exactly one choice', () => {
		assert.deepStrictEqual(buildSortKeyChoices({ startRow: 0, startCol: 0, endRow: 9, endCol: 0 }), [{ col: 0, label: 'A' }]);
	});
});

// =================================================================================================
// ENGINE-BACKED (real owning Session; skipped without the cdylib -- runs on the Mac gate)
// =================================================================================================

suite('W2 sortLogic -- sort batch against the REAL owning Session', () => {
	suiteSetup(function () {
		if (shouldSkip()) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		this.timeout(60000); // cold dlopen of the cdylib
		loadQuantbookEngine();
	});

	function colValues(snap: WorkbookSnapshotJson, sheetId: number, col: number, rows: number): (number | undefined)[] {
		const sheet = snap.sheets.find(s => s.id === sheetId)!;
		const out: (number | undefined)[] = [];
		for (let r = 0; r < rows; r++) {
			const c = sheet.cells.find(x => x.row === r && x.col === col);
			out.push(c?.value?.kind === 'number' ? c.value.number : undefined);
		}
		return out;
	}

	test('a sort batch actually permutes the live workbook rows (numbers ascending)', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		// A1:A3 = 30, 10, 20 ; B1:B3 = 1, 2, 3 (the paired column travels with its row)
		s.setValue(sheetId, 0, 0, { kind: 'number', number: 30 });
		s.setValue(sheetId, 1, 0, { kind: 'number', number: 10 });
		s.setValue(sheetId, 2, 0, { kind: 'number', number: 20 });
		s.setValue(sheetId, 0, 1, { kind: 'number', number: 1 });
		s.setValue(sheetId, 1, 1, { kind: 'number', number: 2 });
		s.setValue(sheetId, 2, 1, { kind: 'number', number: 3 });
		s.recalcDirty();

		const before = s.snapshot();
		const ops = buildSortBatch(sheetId, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 }, 0, 'asc', before);
		s.batch(ops, { undoLabel: 'sort-test' });
		s.recalcDirty();

		const after = s.snapshot();
		assert.deepStrictEqual(colValues(after, sheetId, 0, 3), [10, 20, 30], 'column A sorted ascending');
		assert.deepStrictEqual(colValues(after, sheetId, 1, 3), [2, 3, 1], 'column B travelled with its row (paired)');
		s.close();
	});

	test('sort -> undo restores the ORIGINAL row order (one undo unit)', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		s.setValue(sheetId, 0, 0, { kind: 'number', number: 30 });
		s.setValue(sheetId, 1, 0, { kind: 'number', number: 10 });
		s.setValue(sheetId, 2, 0, { kind: 'number', number: 20 });
		s.recalcDirty();

		const ops = buildSortBatch(sheetId, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'asc', s.snapshot());
		s.batch(ops, { undoLabel: 'sort-test' });
		s.recalcDirty();
		assert.deepStrictEqual(colValues(s.snapshot(), sheetId, 0, 3), [10, 20, 30], 'sorted');

		s.undo();
		s.recalcDirty();
		assert.deepStrictEqual(colValues(s.snapshot(), sheetId, 0, 3), [30, 10, 20], 'undo restored the original order in ONE step');
		s.close();
	});

	test('LIMITATION (a): number-FORMATS do NOT travel with sorted rows (stay at the absolute address)', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		// A1:A3 = 30, 10, 20. Apply a Percent format to A1 ONLY (the row that, after asc sort, moves to A3).
		s.setValue(sheetId, 0, 0, { kind: 'number', number: 30 });
		s.setValue(sheetId, 1, 0, { kind: 'number', number: 10 });
		s.setValue(sheetId, 2, 0, { kind: 'number', number: 20 });
		const pctId = s.registerFormat(formatStringForPreset('Percent'));
		s.batch(buildSetFormatOps(sheetId, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, pctId), { undoLabel: 'fmt' });
		s.recalcDirty();

		const a1FormatBefore = s.snapshot().sheets.find(x => x.id === sheetId)!.cells.find(c => c.row === 0 && c.col === 0)?.format;
		assert.ok(a1FormatBefore !== undefined, 'A1 has a format before the sort');

		// Sort ascending: A1's value (30) moves to A3, but the FORMAT stays at the A1 ADDRESS (documented v1 gap).
		const ops = buildSortBatch(sheetId, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'asc', s.snapshot());
		s.batch(ops, { undoLabel: 'sort-test' });
		s.recalcDirty();

		const after = s.snapshot().sheets.find(x => x.id === sheetId)!;
		const a1After = after.cells.find(c => c.row === 0 && c.col === 0);
		const a3After = after.cells.find(c => c.row === 2 && c.col === 0);
		assert.strictEqual(a1After?.value?.number, 10, 'A1 now holds the smallest value (10)');
		assert.ok(a1After?.format !== undefined, 'the Percent format STAYED at the A1 address (did NOT travel with value 30)');
		assert.strictEqual(a3After?.format, undefined, 'A3 -- where value 30 landed -- has NO format (the format did not follow the value)');
		s.close();
	});

	test('REFUSE-ON-FORMULA against the live session: a rect with a formula throws + leaves the workbook UNTOUCHED', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		s.setValue(sheetId, 0, 0, { kind: 'number', number: 30 });
		s.setValue(sheetId, 1, 0, { kind: 'number', number: 10 });
		s.setFormula(sheetId, 2, 0, 'A1+A2'); // A3 is a formula -> the rect must be refused
		s.recalcDirty();
		const before = colValues(s.snapshot(), sheetId, 0, 3);

		assert.throws(
			() => buildSortBatch(sheetId, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 0, 'asc', s.snapshot()),
			/\[refuse_formula\]/,
			'a rect containing a formula is refused before any op is built',
		);
		// The workbook is byte-identical -- the refuse produced ZERO writes.
		assert.deepStrictEqual(colValues(s.snapshot(), sheetId, 0, 3), before, 'no cell changed (zero writes on refuse)');
		s.close();
	});
});

// Compile-time guard: keep the SortDirection type referenced.
const _dir: SortDirection = 'asc';
void _dir;
