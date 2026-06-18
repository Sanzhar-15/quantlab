/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wave F window split (R5, 2026-06-18) -- golden tests for the PURE horizontal-split geometry in
 * `src/quantbook/shared/gridLayoutA1.ts`. Canvas drawing needs a real 2D context (not available
 * headlessly), so these pin the correctness-critical math the renderer + overlay editor + hit-test
 * depend on: the bar clamp (each pane keeps >= 1 row), the per-pane visible-row windows (golden-tied to
 * the single-pane `computeVisibleRowRange` so split panes match the body window EXACTLY), the synthetic
 * top-scroll clamp, and the split-aware hit-test (header/gutter reject; the top pane maps with
 * `topScrollTop`, the bottom with `botScrollTop`; a point on the bar resolves into the bottom pane).
 */

import * as assert from 'assert';

import {
	HEADER_HEIGHT,
	MAX_ROWS,
	ROW_HEIGHT,
	clampSplitBarY,
	clampSplitScroll,
	hitTestSplit,
	hitTestViewport,
	splitPaneRowRanges,
} from '../webview/sheets-webview/gridLayoutA1';
import { computeVisibleRowRange } from '../webview/sheets-webview/cellRender';

const OVERSCAN = 2; // must match canvasGrid.ts so the golden tie below is meaningful

suite('Wave F split -- clampSplitBarY', function () {
	test('non-finite / <= 0 raw Y -> 0 (no split sentinel)', () => {
		assert.strictEqual(clampSplitBarY(0, 800), 0);
		assert.strictEqual(clampSplitBarY(-50, 800), 0);
		assert.strictEqual(clampSplitBarY(NaN, 800), 0);
		assert.strictEqual(clampSplitBarY(Infinity, 800), 0); // non-finite -> no split
	});

	test('a viewport too short for two one-row panes -> 0', () => {
		// Need HEADER_HEIGHT + 2*ROW_HEIGHT of height; one less than that cannot hold two panes.
		const tooShort = HEADER_HEIGHT + 2 * ROW_HEIGHT - 1;
		assert.strictEqual(clampSplitBarY(HEADER_HEIGHT + ROW_HEIGHT, tooShort), 0);
	});

	test('clamps below the top-pane minimum up to HEADER_HEIGHT + ROW_HEIGHT', () => {
		const barY = clampSplitBarY(HEADER_HEIGHT + 1, 800); // 1px top pane -> bumped to one row
		assert.strictEqual(barY, HEADER_HEIGHT + ROW_HEIGHT);
	});

	test('clamps above the bottom-pane maximum down to cssHeight - ROW_HEIGHT', () => {
		const barY = clampSplitBarY(799, 800); // 1px bottom pane -> bumped so the bottom keeps one row
		assert.strictEqual(barY, 800 - ROW_HEIGHT);
	});

	test('a mid-viewport bar rounds to a whole px and passes through; BOTH panes keep >= 1 row', () => {
		const cssHeight = 800;
		const barY = clampSplitBarY(403.6, cssHeight);
		assert.strictEqual(barY, 404);
		assert.ok(barY - HEADER_HEIGHT >= ROW_HEIGHT, 'top pane >= 1 row');
		assert.ok(cssHeight - barY >= ROW_HEIGHT, 'bottom pane >= 1 row');
	});
});

suite('Wave F split -- splitPaneRowRanges (golden-tied to single-pane window)', function () {
	test('each pane range equals computeVisibleRowRange for its own scroll + band height', () => {
		const cssHeight = 800;
		const splitBarY = 320; // top band = 320 - HEADER_HEIGHT; bottom band = 800 - 320
		const topScrollTop = 12 * ROW_HEIGHT; // top pane parked at row 12
		const botScrollTop = 500 * ROW_HEIGHT; // bottom pane parked at row 500 -- independent
		const r = splitPaneRowRanges(topScrollTop, botScrollTop, splitBarY, cssHeight, OVERSCAN);
		assert.strictEqual(r.topBandHeight, splitBarY - HEADER_HEIGHT);
		assert.strictEqual(r.botBandHeight, cssHeight - splitBarY);
		assert.deepStrictEqual(
			r.top,
			computeVisibleRowRange(topScrollTop, r.topBandHeight, MAX_ROWS, ROW_HEIGHT, OVERSCAN),
		);
		assert.deepStrictEqual(
			r.bottom,
			computeVisibleRowRange(botScrollTop, r.botBandHeight, MAX_ROWS, ROW_HEIGHT, OVERSCAN),
		);
	});

	test('the two panes scroll INDEPENDENTLY (different offsets -> different windows)', () => {
		const r = splitPaneRowRanges(0, 900 * ROW_HEIGHT, 400, 800, OVERSCAN);
		assert.strictEqual(r.top.startIdx, 0); // top parked at the very top
		assert.ok(r.bottom.startIdx > 800, 'bottom window is far down the sheet, unrelated to the top');
	});

	test('a stale large scroll clamps to the last rows -- never an empty window', () => {
		const huge = MAX_ROWS * ROW_HEIGHT * 4; // way past the end
		const r = splitPaneRowRanges(huge, huge, 400, 800, OVERSCAN);
		assert.ok(r.top.startIdx < r.top.endIdx, 'top window non-empty');
		assert.ok(r.bottom.startIdx < r.bottom.endIdx, 'bottom window non-empty');
		assert.strictEqual(r.top.endIdx, MAX_ROWS);
		assert.strictEqual(r.bottom.endIdx, MAX_ROWS);
	});
});

suite('Wave F split -- clampSplitScroll (synthetic top-pane bound)', function () {
	test('non-finite / <= 0 -> 0', () => {
		assert.strictEqual(clampSplitScroll(0, 400), 0);
		assert.strictEqual(clampSplitScroll(-10, 400), 0);
		assert.strictEqual(clampSplitScroll(NaN, 400), 0);
	});

	test('an in-bounds offset passes through unchanged', () => {
		assert.strictEqual(clampSplitScroll(123 * ROW_HEIGHT, 400), 123 * ROW_HEIGHT);
	});

	test('an over-large offset clamps to MAX_ROWS*ROW_HEIGHT - bandHeight', () => {
		const bandHeight = 400;
		const max = MAX_ROWS * ROW_HEIGHT - bandHeight;
		assert.strictEqual(clampSplitScroll(max + 10_000, bandHeight), max);
	});
});

suite('Wave F split -- hitTestSplit', function () {
	const gutterW = 50;
	const splitBarY = 300;

	test('a point in the sticky header band or row gutter is never a cell', () => {
		assert.strictEqual(hitTestSplit(120, HEADER_HEIGHT - 1, splitBarY, 0, 0, 0, gutterW), null);
		assert.strictEqual(hitTestSplit(gutterW - 1, 400, splitBarY, 0, 0, 0, gutterW), null);
	});

	test('the TOP pane maps with topScrollTop (== single-pane hitTestViewport at that scroll)', () => {
		const localX = 120;
		const localY = 100; // inside the top band [HEADER_HEIGHT, splitBarY)
		const topScrollTop = 7 * ROW_HEIGHT;
		const scrollLeft = 3 * 100;
		assert.deepStrictEqual(
			hitTestSplit(localX, localY, splitBarY, topScrollTop, 999 * ROW_HEIGHT, scrollLeft, gutterW),
			hitTestViewport(localX, localY, scrollLeft, topScrollTop, gutterW),
		);
	});

	test('the top of the BOTTOM pane maps to the bottom-pane scroll row', () => {
		const botScrollTop = 40 * ROW_HEIGHT;
		// localY exactly at the bar = first visible row of the bottom pane.
		const hit = hitTestSplit(120, splitBarY, splitBarY, 0, botScrollTop, 0, gutterW);
		assert.notStrictEqual(hit, null);
		assert.strictEqual(hit?.row, 40);
		// one row lower in the bottom pane -> next row.
		const hit2 = hitTestSplit(120, splitBarY + ROW_HEIGHT, splitBarY, 0, botScrollTop, 0, gutterW);
		assert.strictEqual(hit2?.row, 41);
	});

	test('a point ON the bar resolves into the BOTTOM pane (the bar belongs to no cell)', () => {
		// top parked at row 0, bottom parked at row 200: a point at the bar must read the bottom (200), not 0.
		const hit = hitTestSplit(120, splitBarY, splitBarY, 0, 200 * ROW_HEIGHT, 0, gutterW);
		assert.strictEqual(hit?.row, 200);
	});

	test('across the bar the two panes read DIFFERENT rows reflecting their own scroll', () => {
		const topScrollTop = 0;
		const botScrollTop = 600 * ROW_HEIGHT;
		const above = hitTestSplit(120, splitBarY - 1, splitBarY, topScrollTop, botScrollTop, 0, gutterW);
		const below = hitTestSplit(120, splitBarY + 1, splitBarY, topScrollTop, botScrollTop, 0, gutterW);
		assert.ok(above !== null && below !== null);
		assert.ok((above?.row ?? -1) < 20, 'top pane near row 0');
		assert.ok((below?.row ?? -1) >= 600, 'bottom pane near row 600');
	});
});
