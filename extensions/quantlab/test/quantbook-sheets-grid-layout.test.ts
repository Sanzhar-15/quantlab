/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-0b-2 (2026-06-02) -- golden tests for the Canvas2D sheets renderer's PURE layout math
 * (`webview/sheets-webview/gridLayout.ts`). Canvas drawing itself needs a real 2D context (not
 * available headlessly), so these pin the correctness-critical geometry the canvas + the overlay
 * editor depend on: column offsets, the cell rectangle, hit-testing (incl. the header band + the
 * editable-cell mapping), and width-bounded truncation.
 */

import * as assert from 'assert';

import {
	COLUMNS,
	HEADER_HEIGHT,
	ROW_HEIGHT,
	cellContentRect,
	columnX,
	hitTestContent,
	hitTestViewport,
	totalContentHeight,
	totalContentWidth,
	truncateToWidth,
} from '../webview/sheets-webview/gridLayout';

suite('FE-0b-2 gridLayout -- column geometry', function () {
	test('columnX is the cumulative width of preceding columns', () => {
		assert.strictEqual(columnX(0), 0);
		assert.strictEqual(columnX(1), 72);
		assert.strictEqual(columnX(2), 144);
		assert.strictEqual(columnX(3), 664); // == total width (Row 72 + Col 72 + Value 520)
	});
	test('totalContentWidth = sum of all column widths', () => {
		assert.strictEqual(totalContentWidth(), 664);
	});
	test('totalContentHeight = header band + entry rows', () => {
		assert.strictEqual(totalContentHeight(0), HEADER_HEIGHT);
		assert.strictEqual(totalContentHeight(10), HEADER_HEIGHT + 10 * ROW_HEIGHT);
	});
});

suite('FE-0b-2 gridLayout -- cellContentRect (content coords for the overlay editor)', function () {
	test('first entry, Value column', () => {
		assert.deepStrictEqual(cellContentRect(0, 2), { x: 144, y: HEADER_HEIGHT, width: 520, height: ROW_HEIGHT });
	});
	test('fourth entry, Row column -- y advances by ROW_HEIGHT per entry below the header', () => {
		assert.deepStrictEqual(cellContentRect(3, 0), { x: 0, y: HEADER_HEIGHT + 3 * ROW_HEIGHT, width: 72, height: ROW_HEIGHT });
	});
});

suite('FE-0b-2 gridLayout -- hitTestContent', function () {
	test('a point in the header band is NOT an editable cell', () => {
		assert.strictEqual(hitTestContent(10, 10, 5), null);
	});
	test('first data row maps to entryIndex 0 + the clicked column', () => {
		assert.deepStrictEqual(hitTestContent(10, HEADER_HEIGHT + 5, 5), { entryIndex: 0, colIndex: 0 });
		assert.deepStrictEqual(hitTestContent(columnX(2) + 10, HEADER_HEIGHT + 5, 5), { entryIndex: 0, colIndex: 2 });
	});
	test('second data row maps to entryIndex 1', () => {
		assert.deepStrictEqual(hitTestContent(10, HEADER_HEIGHT + ROW_HEIGHT + 5, 5), { entryIndex: 1, colIndex: 0 });
	});
	test('a row below the populated entries is null (no phantom cell)', () => {
		assert.strictEqual(hitTestContent(10, HEADER_HEIGHT + 50 * ROW_HEIGHT, 2), null);
	});
	test('x past the last column, or negative, is null', () => {
		assert.strictEqual(hitTestContent(totalContentWidth() + 5, HEADER_HEIGHT + 5, 5), null);
		assert.strictEqual(hitTestContent(-1, HEADER_HEIGHT + 5, 5), null);
	});
});

suite('FE-0b-2 gridLayout -- hitTestViewport (sticky-header-aware, the FE-0b-2 audit HIGH)', function () {
	test('a click in the sticky header band is null at scroll 0', () => {
		assert.strictEqual(hitTestViewport(10, 10, 0, 0, 5), null);
	});
	test('REGRESSION: a click on the sticky header is STILL null after vertical scroll', () => {
		// The bug: contentY = localY + scrollTop = 10 + 300 = 310 >= HEADER_HEIGHT would wrongly
		// hit a body row. The local-coords header guard (localY 10 < HEADER_HEIGHT) rejects it first.
		assert.strictEqual(hitTestViewport(10, 10, 0, 300, 20), null);
	});
	test('a body click maps to the right entry/column at scroll 0', () => {
		assert.deepStrictEqual(hitTestViewport(columnX(2) + 10, HEADER_HEIGHT + 5, 0, 0, 5), { entryIndex: 0, colIndex: 2 });
	});
	test('a body click maps correctly after vertical scroll', () => {
		// localY = HEADER_HEIGHT + 5 -> contentY = +300 = 333 -> entryIndex = floor((333-28)/25) = 12
		assert.deepStrictEqual(hitTestViewport(columnX(2) + 10, HEADER_HEIGHT + 5, 0, 300, 20), { entryIndex: 12, colIndex: 2 });
	});
	test('horizontal scroll shifts the hit column', () => {
		// localX 10 + scrollLeft 100 = contentX 110 -> Col column [72,144)
		assert.deepStrictEqual(hitTestViewport(10, HEADER_HEIGHT + 5, 100, 0, 5), { entryIndex: 0, colIndex: 1 });
	});
});

suite('FE-0b-2 gridLayout -- truncateToWidth', function () {
	// Fake monospace measurer: each char (incl. the ellipsis) is 10px wide.
	const measure = (s: string): number => s.length * 10;

	test('text that fits is returned unchanged', () => {
		assert.strictEqual(truncateToWidth('abc', 100, measure), 'abc');
	});
	test('text too wide is cut to the longest prefix + ellipsis that fits', () => {
		// '…' = 10px; longest prefix len with (len+1)*10 <= 45 is 3 -> 'abc…' (40px), 'abcd…' (50px) overflows.
		assert.strictEqual(truncateToWidth('abcdefghij', 45, measure), 'abc…');
	});
	test('empty string stays empty', () => {
		assert.strictEqual(truncateToWidth('', 100, measure), '');
	});
	test('when not even the ellipsis fits, returns empty', () => {
		assert.strictEqual(truncateToWidth('abcdefghij', 5, measure), '');
	});
});

suite('FE-0b-2 gridLayout -- column contract', function () {
	test('exactly 3 columns: Row / Col / Value (only Value is editable)', () => {
		assert.deepStrictEqual(COLUMNS.map(c => c.key), ['row', 'col', 'value']);
		assert.deepStrictEqual(COLUMNS.map(c => c.label), ['Row', 'Col', 'Value']);
	});
});
