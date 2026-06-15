/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-8.1 "Resize Table to Selection" -- unit tests for the vscode-free, engine-free core in
// tableUiLogic.ts: `planTableResize` (the resize/noop/error decision with its precedence) and
// `appendedColumnNames` (the `Column{N}` auto-naming for column GROW). The command in
// quantbookCommands.ts is a thin vscode shell over these. Runs in the normal mocha suite (no engine, no
// vscode).

import * as assert from 'assert';

import {
	appendedColumnNames,
	planTableResize,
	type TableResizeAction,
} from '../src/quantbook/cellGrid/tableUiLogic';
import type { TableSnapshotJson } from '../src/quantbook/types';

// A table fixture: footprint anchored at (topRow, topCol), `rows` x `cols`. Header on, totals off by
// default (neither flag affects planTableResize -- it compares the total row/col counts).
const tbl = (topRow: number, topCol: number, rows: number, cols: number, over?: Partial<TableSnapshotJson>): TableSnapshotJson => ({
	name: 'RETURNS',
	displayName: 'Returns',
	sheet: 0,
	topRow,
	topCol,
	rows,
	cols,
	hasHeader: true,
	hasTotals: false,
	...over,
});

// Mirror the A1 extent constants the core uses (private to tableUiLogic).
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

suite('FE-8.1 appendedColumnNames', () => {
	test('continues the Column{N} sequence past the existing column count', () => {
		assert.deepStrictEqual(appendedColumnNames(3, 5), ['Column4', 'Column5']);
	});
	test('from zero columns names Column1..N (matches defaultColumnNames convention)', () => {
		assert.deepStrictEqual(appendedColumnNames(0, 2), ['Column1', 'Column2']);
	});
	test('a single appended column', () => {
		assert.deepStrictEqual(appendedColumnNames(4, 5), ['Column5']);
	});
	test('throws when newCols does not exceed oldCols (No-Fallbacks, not a silent empty list)', () => {
		assert.throws(() => appendedColumnNames(3, 3), /must exceed/);
		assert.throws(() => appendedColumnNames(5, 3), /must exceed/);
	});
	test('throws on non-integer spans', () => {
		assert.throws(() => appendedColumnNames(2.5, 4), /must be integers/);
		assert.throws(() => appendedColumnNames(2, 4.1), /must be integers/);
	});
});

suite('FE-8.1 planTableResize -- noop', () => {
	test('selection equal to the current footprint is a noop', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 2, 2);
		assert.deepStrictEqual(a, { kind: 'noop' } as TableResizeAction);
	});
	test('a 1x1 table re-selected exactly is a noop', () => {
		assert.deepStrictEqual(planTableResize(tbl(5, 2, 1, 1), 5, 2, 5, 2), { kind: 'noop' });
	});
});

suite('FE-8.1 planTableResize -- row resize', () => {
	test('row GROW keeps cols, empty add/remove', () => {
		// Table A1:C3 (3x3) -> select A1:C12 (rows 0..11, cols 0..2).
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 11, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 3, addedColumns: [], removedColumns: [] });
	});
	test('row SHRINK keeps cols, empty add/remove', () => {
		// Table A1:C10 (10x3) -> select A1:C6 (rows 0..5).
		const a = planTableResize(tbl(0, 0, 10, 3), 0, 0, 5, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 6, newCols: 3, addedColumns: [], removedColumns: [] });
	});
	test('row shrink to the header row only (newRows=1) is allowed (engine requires > 0)', () => {
		const a = planTableResize(tbl(0, 0, 10, 3), 0, 0, 0, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 1, newCols: 3, addedColumns: [], removedColumns: [] });
	});
});

suite('FE-8.1 planTableResize -- column grow (auto-named)', () => {
	test('grow columns appends Column{N}, removedColumns empty', () => {
		// Table A1:C3 (3x3) -> select A1:E3 (cols 0..4): two new columns Column4, Column5.
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 2, 4);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 5, addedColumns: ['Column4', 'Column5'], removedColumns: [] });
	});
	test('grow BOTH rows and columns', () => {
		// Table A1:C3 (3x3) -> select A1:E12 (rows 0..11, cols 0..4).
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 11, 4);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 5, addedColumns: ['Column4', 'Column5'], removedColumns: [] });
	});
	test('the balance invariant newCols == oldCols + added - removed holds', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 2, 6);
		assert.strictEqual(a.kind, 'resize');
		if (a.kind === 'resize') {
			assert.strictEqual(a.newCols, 3 + a.addedColumns.length - a.removedColumns.length);
		}
	});
});

suite('FE-8.1 planTableResize -- column shrink is DEFERRED (loud error)', () => {
	test('narrowing the selection is a loud error, never a silent clamp', () => {
		// Table A1:C3 (3x3) -> select A1:B3 (cols 0..1): 2 < 3.
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 2, 1);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /shrinking a table's columns isn't supported yet/i);
			assert.match(a.reason, /3 columns/);
		}
	});
	test('a single-cell selection at the top-left of a multi-col table shrinks columns -> error', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 0, 0);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /shrinking/i);
		}
	});
});

suite('FE-8.1 planTableResize -- anchor must match (a table cannot move)', () => {
	test('selection top-left != table top-left -> error naming the required cell', () => {
		// Table anchored at B2 (top 1,1); selecting from A1 (0,0) must be rejected.
		const a = planTableResize(tbl(1, 1, 3, 3), 0, 0, 4, 4);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /must start at the table's top-left cell B2/);
		}
	});
	test('a column-only anchor mismatch is rejected', () => {
		// Table anchored at B1 (top 0,1); selecting from A1 (0,0).
		const a = planTableResize(tbl(0, 1, 3, 3), 0, 0, 2, 3);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /top-left cell B1/);
		}
	});
});

suite('FE-8.1 planTableResize -- corner order + guards', () => {
	test('corners in reverse order normalize the same (focus at top-left)', () => {
		// anchor at bottom-right (11,2), focus at top-left (0,0): same A1:C12 row-grow.
		const a = planTableResize(tbl(0, 0, 3, 3), 11, 2, 0, 0);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 3, addedColumns: [], removedColumns: [] });
	});
	test('a non-integer corner is a loud error (tampered webview)', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 5.5, 2);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /not a whole number/);
		}
	});
	test('a selection extending past the grid extent is a loud error', () => {
		// endRow = A1_MAX_ROWS is out of range (valid rows are 0..A1_MAX_ROWS-1). Checked BEFORE dims.
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, A1_MAX_ROWS, 2);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /outside the grid/);
		}
	});
	test('extent guard fires on columns too', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), 0, 0, 2, A1_MAX_COLS);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /outside the grid/);
		}
	});
});

suite('FE-8.1 planTableResize -- totals row does not change the decision', () => {
	test('a hasTotals table grows by row count like any other', () => {
		const a = planTableResize(tbl(0, 0, 5, 3, { hasTotals: true }), 0, 0, 9, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 10, newCols: 3, addedColumns: [], removedColumns: [] });
	});
});

suite('FE-8.1 planTableResize -- anchor-independent (not just origin tables)', () => {
	test('column grow on a table anchored at D3 still appends Column{N} (names are topCol-independent)', () => {
		// Table D3:F5 (top 2,3; 3x3) -> select D3:H5 (rows 2..4, cols 3..7): grow to 5 cols.
		const a = planTableResize(tbl(2, 3, 3, 3), 2, 3, 4, 7);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 5, addedColumns: ['Column4', 'Column5'], removedColumns: [] });
	});
	test('row-only grow on a single-column table anchored off-origin', () => {
		// Table B2:B4 (top 1,1; 3x1) -> select B2:B12 (rows 1..11, col 1): row grow, cols unchanged.
		const a = planTableResize(tbl(1, 1, 3, 1), 1, 1, 11, 1);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 11, newCols: 1, addedColumns: [], removedColumns: [] });
	});
});
