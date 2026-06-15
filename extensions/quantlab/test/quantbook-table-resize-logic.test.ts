/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-8.1 "Resize Table to Selection" + FE-8.3 "column shrink / rename column" -- unit tests for the
// vscode-free, engine-free core in tableUiLogic.ts: `planTableResize` (the resize/noop/error decision with
// its precedence, now incl. column SHRINK driven by the live column roster), `appendedColumnNames` (the
// `Column{N}` auto-naming for column GROW), and `planColumnRename` (the rename validation mirroring the
// engine). The commands in quantbookCommands.ts are thin vscode shells over these. Runs in the normal mocha
// suite (no engine, no vscode).

import * as assert from 'assert';

import {
	appendedColumnNames,
	planColumnRename,
	planTableResize,
	type ColumnRenameAction,
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

// The default `Column1..ColumnN` roster a freshly IDE-created `cols`-wide table has -- passed to
// planTableResize as the live column names (from `tableColumns`). Length MUST equal the table's cols (the
// stale-roster guard rejects a mismatch).
const cols = (n: number): string[] => Array.from({ length: n }, (_, i) => `Column${i + 1}`);

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
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 2, 2);
		assert.deepStrictEqual(a, { kind: 'noop' } as TableResizeAction);
	});
	test('a 1x1 table re-selected exactly is a noop', () => {
		assert.deepStrictEqual(planTableResize(tbl(5, 2, 1, 1), cols(1), 5, 2, 5, 2), { kind: 'noop' });
	});
});

suite('FE-8.1 planTableResize -- row resize', () => {
	test('row GROW keeps cols, empty add/remove', () => {
		// Table A1:C3 (3x3) -> select A1:C12 (rows 0..11, cols 0..2).
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 11, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 3, addedColumns: [], removedColumns: [] });
	});
	test('row SHRINK keeps cols, empty add/remove', () => {
		// Table A1:C10 (10x3) -> select A1:C6 (rows 0..5).
		const a = planTableResize(tbl(0, 0, 10, 3), cols(3), 0, 0, 5, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 6, newCols: 3, addedColumns: [], removedColumns: [] });
	});
	test('row shrink to the header row only (newRows=1) is allowed (engine requires > 0)', () => {
		const a = planTableResize(tbl(0, 0, 10, 3), cols(3), 0, 0, 0, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 1, newCols: 3, addedColumns: [], removedColumns: [] });
	});
});

suite('FE-8.1 planTableResize -- column grow (auto-named)', () => {
	test('grow columns appends Column{N}, removedColumns empty', () => {
		// Table A1:C3 (3x3) -> select A1:E3 (cols 0..4): two new columns Column4, Column5.
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 2, 4);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 5, addedColumns: ['Column4', 'Column5'], removedColumns: [] });
	});
	test('grow BOTH rows and columns', () => {
		// Table A1:C3 (3x3) -> select A1:E12 (rows 0..11, cols 0..4).
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 11, 4);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 5, addedColumns: ['Column4', 'Column5'], removedColumns: [] });
	});
	test('the balance invariant newCols == oldCols + added - removed holds', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 2, 6);
		assert.strictEqual(a.kind, 'resize');
		if (a.kind === 'resize') {
			assert.strictEqual(a.newCols, 3 + a.addedColumns.length - a.removedColumns.length);
		}
	});
});

suite('FE-8.3 planTableResize -- column SHRINK (drops the trailing roster names)', () => {
	test('narrowing the selection drops the trailing column(s), addedColumns empty', () => {
		// Table A1:C3 (3x3) -> select A1:B3 (cols 0..1): 2 < 3 -> drop the last column (Column3).
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 2, 1);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 2, addedColumns: [], removedColumns: ['Column3'] });
	});
	test('a single-cell selection at the top-left shrinks both axes (1x1)', () => {
		// Table A1:C3 (3x3) -> select just A1: 1 row x 1 col -> drop Column2, Column3 + shrink to 1 row.
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 0, 0);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 1, newCols: 1, addedColumns: [], removedColumns: ['Column2', 'Column3'] });
	});
	test('combined column-shrink + row-grow', () => {
		// Table A1:C3 (3x3) -> select A1:B12 (rows 0..11, cols 0..1): grow rows to 12, drop Column3.
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 11, 1);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 2, addedColumns: [], removedColumns: ['Column3'] });
	});
	test('uses the ACTUAL (non-default) roster names, not the Column{N} convention', () => {
		// A table loaded with custom names: dropping the last column removes "Q2", not "Column3".
		const a = planTableResize(tbl(0, 0, 3, 3), ['Region', 'Q1', 'Q2'], 0, 0, 2, 1);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 2, addedColumns: [], removedColumns: ['Q2'] });
	});
	test('drop multiple trailing columns in order', () => {
		// 4-col table -> shrink to 2 cols: removes the last two, in order.
		const a = planTableResize(tbl(0, 0, 3, 4), ['A', 'B', 'C', 'D'], 0, 0, 2, 1);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 2, addedColumns: [], removedColumns: ['C', 'D'] });
	});
});

suite('FE-8.3 planTableResize -- stale roster guard', () => {
	test('columnNames length != table.cols is a loud error (stale snapshot), never a guessed slice', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), cols(2), 0, 0, 2, 1);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /column roster \(2\) doesn't match its column count \(3\)/);
			assert.match(a.reason, /stale/i);
		}
	});
});

suite('FE-8.1 planTableResize -- anchor must match (a table cannot move)', () => {
	test('selection top-left != table top-left -> error naming the required cell', () => {
		// Table anchored at B2 (top 1,1); selecting from A1 (0,0) must be rejected.
		const a = planTableResize(tbl(1, 1, 3, 3), cols(3), 0, 0, 4, 4);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /must start at the table's top-left cell B2/);
		}
	});
	test('a column-only anchor mismatch is rejected', () => {
		// Table anchored at B1 (top 0,1); selecting from A1 (0,0).
		const a = planTableResize(tbl(0, 1, 3, 3), cols(3), 0, 0, 2, 3);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /top-left cell B1/);
		}
	});
});

suite('FE-8.1 planTableResize -- corner order + guards', () => {
	test('corners in reverse order normalize the same (focus at top-left)', () => {
		// anchor at bottom-right (11,2), focus at top-left (0,0): same A1:C12 row-grow.
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 11, 2, 0, 0);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 12, newCols: 3, addedColumns: [], removedColumns: [] });
	});
	test('a non-integer corner is a loud error (tampered webview)', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 5.5, 2);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /not a whole number/);
		}
	});
	test('a selection extending past the grid extent is a loud error', () => {
		// endRow = A1_MAX_ROWS is out of range (valid rows are 0..A1_MAX_ROWS-1).
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, A1_MAX_ROWS, 2);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /outside the grid/);
		}
	});
	test('extent guard fires on columns too', () => {
		const a = planTableResize(tbl(0, 0, 3, 3), cols(3), 0, 0, 2, A1_MAX_COLS);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /outside the grid/);
		}
	});
});

suite('FE-8.1 planTableResize -- totals row does not change the decision', () => {
	test('a hasTotals table grows by row count like any other', () => {
		const a = planTableResize(tbl(0, 0, 5, 3, { hasTotals: true }), cols(3), 0, 0, 9, 2);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 10, newCols: 3, addedColumns: [], removedColumns: [] });
	});
});

suite('FE-8.1 planTableResize -- anchor-independent (not just origin tables)', () => {
	test('column grow on a table anchored at D3 still appends Column{N} (names are topCol-independent)', () => {
		// Table D3:F5 (top 2,3; 3x3) -> select D3:H5 (rows 2..4, cols 3..7): grow to 5 cols.
		const a = planTableResize(tbl(2, 3, 3, 3), cols(3), 2, 3, 4, 7);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 3, newCols: 5, addedColumns: ['Column4', 'Column5'], removedColumns: [] });
	});
	test('row-only grow on a single-column table anchored off-origin', () => {
		// Table B2:B4 (top 1,1; 3x1) -> select B2:B12 (rows 1..11, col 1): row grow, cols unchanged.
		const a = planTableResize(tbl(1, 1, 3, 1), cols(1), 1, 1, 11, 1);
		assert.deepStrictEqual(a, { kind: 'resize', newRows: 11, newCols: 1, addedColumns: [], removedColumns: [] });
	});
});

suite('FE-8.3 planColumnRename', () => {
	// Realistic IDE-reachable column names: plain identifiers, NOT cell-ref-like (Q1/R2 etc. are valid A1
	// addresses, which the shared identifier rules reject -- and which the IDE never creates).
	const roster = ['Region', 'Revenue', 'Profit'];
	test('a valid rename returns the stored old display name + the new name', () => {
		assert.deepStrictEqual(
			planColumnRename(roster, 'Revenue', 'Sales'),
			{ kind: 'rename', oldCol: 'Revenue', newCol: 'Sales' } as ColumnRenameAction,
		);
	});
	test('renaming to the same name is a noop (the engine no-ops a same-canonical rename)', () => {
		assert.deepStrictEqual(planColumnRename(roster, 'Revenue', 'Revenue'), { kind: 'noop' });
	});
	test('a case-only change is a noop (same canonical -> engine Ok(0), no display change)', () => {
		assert.deepStrictEqual(planColumnRename(roster, 'Revenue', 'revenue'), { kind: 'noop' });
	});
	test('oldCol is matched case-insensitively and the EXACT stored display is carried', () => {
		assert.deepStrictEqual(
			planColumnRename(roster, 'revenue', 'Sales'),
			{ kind: 'rename', oldCol: 'Revenue', newCol: 'Sales' },
		);
	});
	test('an unknown column is a loud error', () => {
		const a = planColumnRename(roster, 'Nope', 'Sales');
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /no column named "Nope"/);
		}
	});
	test('a collision with another column is a loud error (case-insensitive)', () => {
		const a = planColumnRename(roster, 'Revenue', 'profit');
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /already has a column named "profit"/);
		}
	});
	test('an invalid new identifier is a loud error (shared defined-name rules)', () => {
		const a = planColumnRename(roster, 'Revenue', '1bad');
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.ok(a.reason.length > 0);
		}
	});
	// FE-8.3 Codex-HIGH closure: the engine folds column names ASCII-only (to_ascii_lowercase). JS
	// `toLowerCase()` also folds non-ASCII letters, so U+00C5 and U+00E5 -- DISTINCT columns to the engine --
	// would collapse and a Unicode-based match could pick the WRONG one. These pin ASCII-only matching.
	// (\u escapes keep this source ASCII-only for the hygiene check; the runtime strings are the real chars.)
	const aRingUpper = String.fromCharCode(0xC5); // U+00C5 A-with-ring (upper)
	const aRingLower = String.fromCharCode(0xE5); // U+00E5 a-with-ring (lower) -- Unicode-folds to same as upper, ASCII-folds distinct
	test('non-ASCII columns that differ only by case are matched by EXACT ASCII fold, not Unicode', () => {
		// Selecting the lower form must resolve to the lower form, not the upper -- proving ASCII (not Unicode) fold.
		assert.deepStrictEqual(
			planColumnRename([aRingUpper, aRingLower], aRingLower, 'Renamed'),
			{ kind: 'rename', oldCol: aRingLower, newCol: 'Renamed' },
		);
		assert.deepStrictEqual(
			planColumnRename([aRingUpper, aRingLower], aRingUpper, 'Renamed'),
			{ kind: 'rename', oldCol: aRingUpper, newCol: 'Renamed' },
		);
	});
});
