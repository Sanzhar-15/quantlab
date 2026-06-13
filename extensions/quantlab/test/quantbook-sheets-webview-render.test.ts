/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-0b (2026-06-02) -- unit tests for the bundled sheets-webview pure value/window helpers
 * (`webview/sheets-webview/cellRender.ts`): `formatCellValue` (the value-default display string)
 * and `computeVisibleRowRange` (the scroll window). The FE-0b-1 DOM-table helpers
 * (`renderRowsHtml`/`escapeHtml`) were removed in FE-0b-2 (the canvas draws text directly), so
 * their suites are gone; the canvas LAYOUT math is golden-tested in
 * `quantbook-sheets-grid-layout.test.ts`.
 *
 * Pure functions -- no vscode, no DOM -- so they import + run under plain mocha.
 */

import * as assert from 'assert';

import type { TableSnapshotJson } from '../src/quantbook/types';
import { computeVisibleRowRange, formatCellValue, isRenderableValue } from '../webview/sheets-webview/cellRender';
import { computeTablePaint, type TableVisibleRange } from '../webview/sheets-webview/canvasGrid';

suite('FE-0b sheets-webview cellRender -- formatCellValue', function () {
	test('number renders its String() form', () => {
		assert.strictEqual(formatCellValue({ kind: 'number', value: 42 }), '42');
		assert.strictEqual(formatCellValue({ kind: 'number', value: -3.5 }), '-3.5');
	});
	test('boolean renders TRUE / FALSE', () => {
		assert.strictEqual(formatCellValue({ kind: 'boolean', value: true }), 'TRUE');
		assert.strictEqual(formatCellValue({ kind: 'boolean', value: false }), 'FALSE');
	});
	test('text renders verbatim; error renders its code; pending is (pending)', () => {
		assert.strictEqual(formatCellValue({ kind: 'text', value: 'hello' }), 'hello');
		assert.strictEqual(formatCellValue({ kind: 'error', value: '#DIV/0!' }), '#DIV/0!');
		assert.strictEqual(formatCellValue({ kind: 'pending' }), '(pending)');
	});
});

suite('FE-2-0 Phase 1 cellRender -- isRenderableValue (the formatCellValue guard)', function () {
	test('accepts each well-formed tagged-union value', () => {
		assert.strictEqual(isRenderableValue({ kind: 'number', value: 42 }), true);
		assert.strictEqual(isRenderableValue({ kind: 'boolean', value: false }), true);
		assert.strictEqual(isRenderableValue({ kind: 'text', value: 'hi' }), true);
		assert.strictEqual(isRenderableValue({ kind: 'error', value: '#DIV/0!' }), true);
		assert.strictEqual(isRenderableValue({ kind: 'pending' }), true);
	});
	test('rejects a recognized kind with a MISSING/wrong-typed payload (the re-audit crash case)', () => {
		// `{kind:'text'}` has a valid kind but no `value` -> formatCellValue would return undefined.
		assert.strictEqual(isRenderableValue({ kind: 'text' }), false);
		assert.strictEqual(isRenderableValue({ kind: 'number' }), false);
		assert.strictEqual(isRenderableValue({ kind: 'number', value: '42' }), false); // string, not number
		assert.strictEqual(isRenderableValue({ kind: 'boolean', value: 1 }), false); // number, not boolean
		assert.strictEqual(isRenderableValue({ kind: 'text', value: 7 }), false); // number, not string
		assert.strictEqual(isRenderableValue({ kind: 'error', value: null }), false);
	});
	test('rejects an unknown kind and non-object values', () => {
		assert.strictEqual(isRenderableValue({ kind: 'blank' }), false); // host rejects blank in snapshots
		assert.strictEqual(isRenderableValue({ kind: 'whatever', value: 'x' }), false);
		assert.strictEqual(isRenderableValue({}), false);
		assert.strictEqual(isRenderableValue(null), false);
		assert.strictEqual(isRenderableValue(undefined), false);
		assert.strictEqual(isRenderableValue('text'), false);
		assert.strictEqual(isRenderableValue(42), false);
	});
});

suite('FE-0b sheets-webview cellRender -- computeVisibleRowRange', function () {
	test('empty table -> [0,0)', () => {
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, 0, 25, 5), { startIdx: 0, endIdx: 0 });
	});
	test('non-positive rowHeight -> whole table (avoids div-by-zero)', () => {
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, 100, 0, 5), { startIdx: 0, endIdx: 100 });
	});
	test('top of a tall table windows with overscan', () => {
		// firstVisible=0, visibleCount=ceil(100/25)=4, start=0, end=min(100, 0+4+5)=9
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, 100, 25, 5), { startIdx: 0, endIdx: 9 });
	});
	test('scrolled mid-table windows around the visible rows', () => {
		// scrollTop=250 -> firstVisible=10; start=10-5=5; end=10+4+5=19
		assert.deepStrictEqual(computeVisibleRowRange(250, 100, 100, 25, 5), { startIdx: 5, endIdx: 19 });
	});
	test('endIdx clamps to totalRows near the bottom', () => {
		// firstVisible=floor(2400/25)=96 (< totalRows-1=99, so unclamped); end=min(100, 96+4+5)=100; start=91
		assert.deepStrictEqual(computeVisibleRowRange(2400, 100, 100, 25, 5), { startIdx: 91, endIdx: 100 });
	});
	test('stale large scrollTop after the data SHRINKS clamps to the last rows (no blank grid)', () => {
		// Persistent viewport kept scrollTop=2400 (was ~100 rows) but the data
		// shrank to 10 rows. Without the firstVisible clamp this returned {91,10}
		// -> slice(91,10)=[] + a 2275px top spacer = blank grid. With the clamp:
		// maxFirst=9, firstVisible=min(9,96)=9, start=4, end=min(10, 9+4+5)=10.
		const r = computeVisibleRowRange(2400, 100, 10, 25, 5);
		assert.deepStrictEqual(r, { startIdx: 4, endIdx: 10 });
		assert.ok(r.startIdx <= r.endIdx, 'startIdx never exceeds endIdx');
		assert.ok(r.endIdx - r.startIdx > 0, 'window is non-empty -> grid is not blank');
	});
});

suite('Tables wave (2026-06-13) -- computeTablePaint', function () {
	// A table at rows [2,8) cols [1,4): header on row 2, data rows 3..7, no totals (hasTotals=false).
	function table(over: Partial<TableSnapshotJson> = {}): TableSnapshotJson {
		return {
			name: 'Table1',
			displayName: 'Table 1',
			sheet: 0,
			topRow: 2,
			topCol: 1,
			rows: 6, // rows 2..7
			cols: 3, // cols 1..3
			hasHeader: true,
			hasTotals: false,
			...over,
		};
	}
	const wholePane: TableVisibleRange = { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 50 };

	test('an ON-PANE table returns its header row, banded data rows, and full-extent border rect', () => {
		const [p] = computeTablePaint([table()], wholePane);
		assert.ok(p !== undefined, 'the on-pane table yields a paint plan');
		assert.strictEqual(p.headerRow, 2, 'header is the table top row');
		// Data rows are 3,4,5,6,7 (header=row2, no totals). Band every OTHER data row starting at the SECOND
		// data row -> dataRowStart=3; band ordinals 1,3 -> rows 4 and 6.
		assert.deepStrictEqual([...p.bandRows], [4, 6], 'bands the 2nd + 4th data rows (zebra under the header)');
		// Fill columns clipped to the pane (here the whole table: cols [1,4)).
		assert.strictEqual(p.fillColStart, 1);
		assert.strictEqual(p.fillColEnd, 4);
		// Border is the FULL extent (half-open): rows [2,8) cols [1,4).
		assert.strictEqual(p.borderRowStart, 2);
		assert.strictEqual(p.borderRowEnd, 8);
		assert.strictEqual(p.borderColStart, 1);
		assert.strictEqual(p.borderColEnd, 4);
	});

	test('an OFF-PANE table (entirely above the visible rows) returns NOTHING', () => {
		// Pane shows rows [20,30): the table at rows [2,8) is entirely above -> skipped.
		const plans = computeTablePaint([table()], { rowStart: 20, rowEnd: 30, colStart: 0, colEnd: 50 });
		assert.deepStrictEqual(plans, [], 'a table outside the visible row window paints nothing');
	});

	test('an OFF-PANE table (entirely left of the visible cols) returns NOTHING', () => {
		const plans = computeTablePaint([table()], { rowStart: 0, rowEnd: 100, colStart: 10, colEnd: 50 });
		assert.deepStrictEqual(plans, [], 'a table left of the visible col window paints nothing');
	});

	test('hasTotals excludes the LAST data row from banding; header off-pane -> headerRow null', () => {
		// Table rows [2,8): header row2, totals row7 -> data rows 3..6. Band ordinals 1,3 from dataStart=3 ->
		// rows 4 and 6; but row6 is the last DATA row (totals is row7), so it stays in. Verify totals row7 is
		// NOT banded. Also clip the pane so the header row (2) is OFF-pane -> headerRow must be null.
		const [p] = computeTablePaint([table({ hasTotals: true })], { rowStart: 4, rowEnd: 100, colStart: 0, colEnd: 50 });
		assert.strictEqual(p.headerRow, null, 'header row above the pane -> not painted');
		assert.ok(!p.bandRows.includes(7), 'the totals row (last row) is never banded');
		assert.ok(p.bandRows.every(r => r >= 4), 'band rows are clipped to the visible window');
		// Border extent is still the FULL table (the canvas clip trims the off-pane part).
		assert.strictEqual(p.borderRowStart, 2);
		assert.strictEqual(p.borderRowEnd, 8);
	});

	test('a degenerate spec (rows<=0 / negative coord) is SKIPPED, never painted', () => {
		assert.deepStrictEqual(computeTablePaint([table({ rows: 0 })], wholePane), [], 'rows=0 is not a rectangle');
		assert.deepStrictEqual(computeTablePaint([table({ cols: -1 })], wholePane), [], 'cols<0 is not a rectangle');
		assert.deepStrictEqual(computeTablePaint([table({ topRow: -1 })], wholePane), [], 'a negative top row is invalid');
	});

	test('a FRACTIONAL topRow/topCol is SKIPPED (a half-cell coordinate paints no aligned band)', () => {
		// Guard regression: `topRow`/`topCol` were once checked with `Number.isFinite`, so a fractional
		// coordinate (e.g. topRow=2.5) PASSED the guard and painted a half-row-misaligned band -- it must be
		// rejected the SAME way `rows`/`cols` reject a non-integer. A grid coordinate is always a whole index.
		assert.deepStrictEqual(computeTablePaint([table({ topRow: 2.5 })], wholePane), [], 'a fractional top row is not a cell boundary');
		assert.deepStrictEqual(computeTablePaint([table({ topCol: 1.5 })], wholePane), [], 'a fractional top col is not a cell boundary');
	});

	test('a no-header table bands from the FIRST row and has headerRow null', () => {
		// Table rows [2,8) no header, no totals -> data rows 2..7, dataStart=2. Band ordinals 1,3,5 -> rows 3,5,7.
		const [p] = computeTablePaint([table({ hasHeader: false })], wholePane);
		assert.strictEqual(p.headerRow, null, 'no header -> no header band');
		assert.deepStrictEqual([...p.bandRows], [3, 5, 7], 'bands every other row from the first data row');
	});
});
