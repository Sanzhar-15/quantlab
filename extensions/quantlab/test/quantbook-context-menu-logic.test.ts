/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 (Wave 3, 2026-06-09) -- unit tests for the vscode-free core of the Cell Grid context menu's
// insert/delete-row-column planner: planStructuralOp (which engine method, which 0-based index, how many
// rows/columns) over a selection, and the describeStructuralPlan label. The command itself
// (quantbookCommands.ts) is a thin vscode shell over these (it resolves the focused grid + calls the typed
// engine method). Runs in the normal mocha suite (no engine, no vscode).

import * as assert from 'assert';

import {
	describeStructuralPlan,
	parseContextMenuArg,
	planStructuralOp,
	type GridSelectionInput,
	type StructuralOp,
} from '../src/quantbook/cellGrid/contextMenuLogic';

/** A single-cell selection at (row,col). */
function cell(row: number, col: number): GridSelectionInput {
	return { anchorRow: row, anchorCol: col, focusRow: row, focusCol: col };
}

/** A rectangular selection between two corners (any order). */
function rect(aRow: number, aCol: number, fRow: number, fCol: number): GridSelectionInput {
	return { anchorRow: aRow, anchorCol: aCol, focusRow: fRow, focusCol: fCol };
}

suite('W3 contextMenuLogic -- planStructuralOp (single cell)', () => {
	const at = cell(3, 5); // row 3, col 5

	test('insertRowAbove inserts ONE row at the selected row', () => {
		assert.deepStrictEqual(planStructuralOp('insertRowAbove', at), {
			method: 'insertRows', axis: 'row', index: 3, count: 1,
		});
	});

	test('insertRowBelow inserts ONE row just past the selected row', () => {
		assert.deepStrictEqual(planStructuralOp('insertRowBelow', at), {
			method: 'insertRows', axis: 'row', index: 4, count: 1,
		});
	});

	test('deleteRow deletes the single selected row', () => {
		assert.deepStrictEqual(planStructuralOp('deleteRow', at), {
			method: 'deleteRows', axis: 'row', index: 3, count: 1,
		});
	});

	test('insertColumnLeft inserts ONE column at the selected column', () => {
		assert.deepStrictEqual(planStructuralOp('insertColumnLeft', at), {
			method: 'insertColumns', axis: 'column', index: 5, count: 1,
		});
	});

	test('insertColumnRight inserts ONE column just past the selected column', () => {
		assert.deepStrictEqual(planStructuralOp('insertColumnRight', at), {
			method: 'insertColumns', axis: 'column', index: 6, count: 1,
		});
	});

	test('deleteColumn deletes the single selected column', () => {
		assert.deepStrictEqual(planStructuralOp('deleteColumn', at), {
			method: 'deleteColumns', axis: 'column', index: 5, count: 1,
		});
	});
});

suite('W3 contextMenuLogic -- planStructuralOp (multi-cell range)', () => {
	// Rows 3..5, cols 2..4 (3 rows x 3 cols). Anchor at the bottom-right, focus at the top-left -> the
	// planner must normalize regardless of corner order.
	const band = rect(5, 4, 3, 2);

	test('insertRowAbove inserts the selected ROW COUNT at the top row of the band', () => {
		assert.deepStrictEqual(planStructuralOp('insertRowAbove', band), {
			method: 'insertRows', axis: 'row', index: 3, count: 3,
		});
	});

	test('insertRowBelow inserts the selected row count just past the BOTTOM row', () => {
		assert.deepStrictEqual(planStructuralOp('insertRowBelow', band), {
			method: 'insertRows', axis: 'row', index: 6, count: 3,
		});
	});

	test('deleteRow deletes the whole selected row band (top index, full count)', () => {
		assert.deepStrictEqual(planStructuralOp('deleteRow', band), {
			method: 'deleteRows', axis: 'row', index: 3, count: 3,
		});
	});

	test('insertColumnLeft inserts the selected COLUMN COUNT at the left column', () => {
		assert.deepStrictEqual(planStructuralOp('insertColumnLeft', band), {
			method: 'insertColumns', axis: 'column', index: 2, count: 3,
		});
	});

	test('insertColumnRight inserts the selected column count just past the RIGHT column', () => {
		assert.deepStrictEqual(planStructuralOp('insertColumnRight', band), {
			method: 'insertColumns', axis: 'column', index: 5, count: 3,
		});
	});

	test('deleteColumn deletes the whole selected column band (left index, full count)', () => {
		assert.deepStrictEqual(planStructuralOp('deleteColumn', band), {
			method: 'deleteColumns', axis: 'column', index: 2, count: 3,
		});
	});
});

suite('W3 contextMenuLogic -- planStructuralOp (corner-order independence)', () => {
	test('all four corner orderings of the same rect yield the same plan', () => {
		const a = rect(1, 1, 4, 6);
		const b = rect(4, 6, 1, 1);
		const c = rect(1, 6, 4, 1);
		const d = rect(4, 1, 1, 6);
		const expected = { method: 'deleteRows', axis: 'row', index: 1, count: 4 } as const;
		for (const sel of [a, b, c, d]) {
			assert.deepStrictEqual(planStructuralOp('deleteRow', sel), expected);
		}
	});

	test('a non-square band: rows differ from columns (3 rows, 6 cols)', () => {
		const sel = rect(2, 0, 4, 5); // rows 2..4 (3), cols 0..5 (6)
		assert.strictEqual(planStructuralOp('deleteRow', sel).count, 3);
		assert.strictEqual(planStructuralOp('deleteColumn', sel).count, 6);
	});
});

suite('W3 contextMenuLogic -- describeStructuralPlan', () => {
	test('singular vs plural row/column nouns', () => {
		assert.strictEqual(describeStructuralPlan(planStructuralOp('insertRowAbove', cell(0, 0))), 'Inserted 1 row');
		assert.strictEqual(describeStructuralPlan(planStructuralOp('deleteColumn', cell(0, 0))), 'Deleted 1 column');
		assert.strictEqual(describeStructuralPlan(planStructuralOp('insertRowAbove', rect(0, 0, 2, 0))), 'Inserted 3 rows');
		assert.strictEqual(describeStructuralPlan(planStructuralOp('deleteColumn', rect(0, 0, 0, 3))), 'Deleted 4 columns');
	});
});

suite('W3 contextMenuLogic -- exhaustiveness', () => {
	test('every StructuralOp is handled (no throw)', () => {
		const ops: StructuralOp[] = [
			'insertRowAbove', 'insertRowBelow', 'insertColumnLeft', 'insertColumnRight', 'deleteRow', 'deleteColumn',
		];
		for (const op of ops) {
			assert.doesNotThrow(() => planStructuralOp(op, cell(0, 0)));
		}
	});

	test('an unknown op throws loud (No-Fallbacks -- never a silent default plan)', () => {
		assert.throws(() => planStructuralOp('bogusOp' as StructuralOp, cell(0, 0)), /unhandled structural op/);
	});
});

suite('W3 contextMenuLogic -- parseContextMenuArg (Codex HIGH-1/HIGH-2 fold)', () => {
	const ok = {
		panelToken: 'wv-1',
		selection: { anchorRow: 1, anchorCol: 2, focusRow: 3, focusCol: 4 },
	};

	test('accepts a well-formed context argument', () => {
		assert.deepStrictEqual(parseContextMenuArg(ok), ok);
	});

	test('rejects a missing / non-object argument', () => {
		assert.strictEqual(parseContextMenuArg(undefined), undefined);
		assert.strictEqual(parseContextMenuArg(null), undefined);
		assert.strictEqual(parseContextMenuArg('nope'), undefined);
		assert.strictEqual(parseContextMenuArg(42), undefined);
	});

	test('rejects a missing / empty panel token', () => {
		assert.strictEqual(parseContextMenuArg({ selection: ok.selection }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: '', selection: ok.selection }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: 7, selection: ok.selection }), undefined);
	});

	test('rejects a missing / malformed selection', () => {
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1' }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1', selection: null }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1', selection: { anchorRow: 1, anchorCol: 2, focusRow: 3 } }), undefined);
	});

	test('rejects non-integer / negative / coerced selection coords (No-Fallbacks -- never coerce)', () => {
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1', selection: { anchorRow: 1.5, anchorCol: 2, focusRow: 3, focusCol: 4 } }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1', selection: { anchorRow: -1, anchorCol: 2, focusRow: 3, focusCol: 4 } }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1', selection: { anchorRow: '1', anchorCol: 2, focusRow: 3, focusCol: 4 } }), undefined);
		assert.strictEqual(parseContextMenuArg({ panelToken: 'wv-1', selection: { anchorRow: NaN, anchorCol: 2, focusRow: 3, focusCol: 4 } }), undefined);
	});

	test('the parsed selection feeds planStructuralOp end-to-end', () => {
		const arg = parseContextMenuArg(ok);
		assert.notStrictEqual(arg, undefined);
		// rows 1..3 (3 rows). deleteRow -> index 1, count 3.
		assert.deepStrictEqual(planStructuralOp('deleteRow', arg!.selection), {
			method: 'deleteRows', axis: 'row', index: 1, count: 3,
		});
	});
});
