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
	planColumnNamesFromHeaders,
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
	test('an escape-needing special-char new name is now ACCEPTED (FE-8.6)', () => {
		// `Net[1]` (contains `[` + `]`) -- FE-8.5 rejected this; FE-8.6 accepts it (the engine `'`-escapes the
		// brackets when it rewrites the structured-ref text, so the rename is faithful).
		assert.deepStrictEqual(
			planColumnRename(roster, 'Revenue', 'Net[1]'),
			{ kind: 'rename', oldCol: 'Revenue', newCol: 'Net[1]' } as ColumnRenameAction,
		);
	});
	// FE-8.4/8.5/8.6 (2026-06-15): a column name MAY be cell-ref-shaped (Q1..Q4), an R1C1 form, contain SPACES
	// (`Order Date`), be digit-leading (`2026`), carry no-escape punctuation, OR contain the OOXML escape specials
	// `[ ] # @ '` (`Net [Margin]` -- the headline FE-8.6 case) -- a column is only ever referenced bracketed +
	// table-qualified (`Table[Net '[Margin']]`), and the engine accepts + round-trips all of these (verified:
	// ql-exec structured_ref_escape_char + parity + cell-ref/R1C1 probes). These would have been REJECTED before.
	const NOW_ACCEPTED = [
		'Q3', 'Q1', 'R2', 'A1', 'AB12', // cell-ref shapes (FE-8.4)
		'R', 'C', 'RC', 'R1C1', // R1C1 forms (FE-8.4)
		'Order Date', 'Q3 2026', // spaces (FE-8.5)
		'2026', '1bad', // digit-leading (FE-8.5)
		'Gross-Margin', 'Net Margin %', 'P&L', // no-escape punctuation (FE-8.5)
		'Net [Margin]', 'a]b', 'Cost#1', 'with#hash', '@Rate', 'at@sign', 'Bob\'s', 'it\'s', // OOXML escape specials (FE-8.6)
	];
	for (const accepted of NOW_ACCEPTED) {
		test(`a full-parity new name "${accepted}" is now ACCEPTED`, () => {
			assert.deepStrictEqual(
				planColumnRename(roster, 'Revenue', accepted),
				{ kind: 'rename', oldCol: 'Revenue', newCol: accepted } as ColumnRenameAction,
			);
		});
	}
	// ...but structurally-unsafe names (edge whitespace, empty, control chars) are STILL rejected (No-Fallbacks).
	for (const stillInvalid of [' Revenue', 'Revenue ', '', `a${String.fromCharCode(0x01)}b`]) {
		test(`a structurally-unsafe name ${JSON.stringify(stillInvalid)} is STILL rejected`, () => {
			const a = planColumnRename(roster, 'Revenue', stillInvalid);
			assert.strictEqual(a.kind, 'error');
		});
	}
	test('a cell-ref-shaped name still collides case-insensitively with an existing such column', () => {
		// Roster already holding a Q3 column: renaming Revenue -> q3 must be a loud collision, not a silent accept.
		const a = planColumnRename(['Region', 'Revenue', 'Q3'], 'Revenue', 'q3');
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.match(a.reason, /already has a column named "q3"/);
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

// FE-8.5 (2026-06-15): planColumnNamesFromHeaders -- project a table's HEADER-ROW texts into column NAMES
// (full Excel-parity). Blank -> Column{N} by position; else the trimmed header text, validated full-parity;
// case-insensitive uniqueness via the engine's ASCII fold; a LOUD error on any reject or duplicate (never a
// silent rewrite). Pure + session-free -- the create-table command is a thin shell over it.
suite('FE-8.5 planColumnNamesFromHeaders', () => {
	test('text headers become the column names verbatim', () => {
		assert.deepStrictEqual(
			planColumnNamesFromHeaders(['Region', 'Revenue', 'Profit']),
			{ kind: 'ok', names: ['Region', 'Revenue', 'Profit'] },
		);
	});
	test('full-parity headers (spaces / digit-leading / punctuation) are kept as-is', () => {
		assert.deepStrictEqual(
			planColumnNamesFromHeaders(['Order Date', '2026', 'Net Margin %', 'P&L']),
			{ kind: 'ok', names: ['Order Date', '2026', 'Net Margin %', 'P&L'] },
		);
	});
	test('a blank (null) header gets a Column{N} default BY POSITION', () => {
		assert.deepStrictEqual(
			planColumnNamesFromHeaders(['Region', null, 'Profit']),
			{ kind: 'ok', names: ['Region', 'Column2', 'Profit'] },
		);
	});
	test('an empty-string / whitespace-only header is treated as blank -> Column{N}', () => {
		assert.deepStrictEqual(
			planColumnNamesFromHeaders(['', '   ', 'X']),
			{ kind: 'ok', names: ['Column1', 'Column2', 'X'] },
		);
	});
	test('a header text is trimmed before use', () => {
		assert.deepStrictEqual(
			planColumnNamesFromHeaders(['  Revenue  ']),
			{ kind: 'ok', names: ['Revenue'] },
		);
	});
	test('a header with OOXML escape chars is now ACCEPTED verbatim (FE-8.6)', () => {
		// `Net [Margin]` (`[`+`]`) and `Cost#1` (`#`) -- FE-8.5 would have loud-refused these; FE-8.6 names the
		// columns after them directly (the engine `'`-escapes the specials when it emits structured-ref text).
		assert.deepStrictEqual(
			planColumnNamesFromHeaders(['Net [Margin]', 'Cost#1', '@Rate', 'Bob\'s']),
			{ kind: 'ok', names: ['Net [Margin]', 'Cost#1', '@Rate', 'Bob\'s'] },
		);
	});
	test('a header with a control char is STILL a loud error naming the column + reason', () => {
		// Control chars are the only char-class still rejected (the printer can't escape them). A leading/trailing
		// whitespace header is TRIMMED first (so it can't trip the edge-whitespace rule) -- use an interior control char.
		const r = planColumnNamesFromHeaders(['Region', `Net${String.fromCharCode(0x01)}1`, 'Profit']);
		assert.strictEqual(r.kind, 'error');
		if (r.kind === 'error') {
			assert.match(r.reason, /Column 2 header/);
			assert.match(r.reason, /control character/i);
		}
	});
	test('duplicate header text (case-insensitive) is a loud error naming both columns', () => {
		const r = planColumnNamesFromHeaders(['Revenue', 'Cost', 'revenue']);
		assert.strictEqual(r.kind, 'error');
		if (r.kind === 'error') {
			assert.match(r.reason, /Columns 1 and 3/);
			assert.match(r.reason, /must be unique/i);
		}
	});
	test('a blank-default Column{N} that collides with a typed "ColumnN" header is a loud error', () => {
		// Header row ["Column2", <blank>] -> names ["Column2", "Column2"] -> dup, surfaced loudly.
		const r = planColumnNamesFromHeaders(['Column2', null]);
		assert.strictEqual(r.kind, 'error');
		if (r.kind === 'error') {
			assert.match(r.reason, /must be unique/i);
		}
	});
	test('uniqueness uses the engine ASCII fold, not JS toLowerCase (a non-ASCII case pair is NOT a dup)', () => {
		// U+00C5 / U+00E5 Unicode-fold equal but ASCII-fold DISTINCT -> the engine sees 2 columns, so this must
		// be accepted, not flagged as a duplicate (mirrors the FE-8.3 Codex-HIGH ASCII-fold fix).
		const upper = String.fromCharCode(0xC5);
		const lower = String.fromCharCode(0xE5);
		assert.deepStrictEqual(
			planColumnNamesFromHeaders([upper, lower]),
			{ kind: 'ok', names: [upper, lower] },
		);
	});
	test('an empty header list throws (a table must have at least one column)', () => {
		assert.throws(() => planColumnNamesFromHeaders([]), /at least one column/);
	});
});
