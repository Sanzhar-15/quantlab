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

import { computeVisibleRowRange, formatCellValue, isRenderableValue } from '../webview/sheets-webview/cellRender';

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
