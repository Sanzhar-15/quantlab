/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-2-0 (2026-06-03) -- golden tests for the A1 spreadsheet renderer's PURE layout math
 * (`webview/sheets-webview/gridLayoutA1.ts`). Canvas drawing needs a real 2D context (not available
 * headlessly), so these pin the correctness-critical geometry the canvas + the overlay editor depend
 * on: A1 column labels (the bijective base-26 off-by-one), gutter/header offsets, the cell rectangle,
 * the visible-column window, the extent totals, and -- the highest-value cases -- the TWO-AXIS sticky
 * hit-test (a click in the sticky column band OR the sticky row gutter OR the corner is never a cell,
 * at any scroll offset).
 */

import * as assert from 'assert';

import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	ROW_HEIGHT,
	cellContentRect,
	colX,
	columnLabel,
	computeVisibleColRange,
	gutterWidth,
	hitTestContent,
	hitTestViewport,
	isInExtent,
	rowY,
	scrollToReveal,
	totalContentHeight,
	totalContentWidth,
} from '../webview/sheets-webview/gridLayoutA1';

suite('FE-2-0 gridLayoutA1 -- columnLabel (bijective base-26)', function () {
	test('single-letter columns', () => {
		assert.strictEqual(columnLabel(0), 'A');
		assert.strictEqual(columnLabel(1), 'B');
		assert.strictEqual(columnLabel(25), 'Z');
	});
	test('two-letter boundaries (the off-by-one trap)', () => {
		assert.strictEqual(columnLabel(26), 'AA');
		assert.strictEqual(columnLabel(27), 'AB');
		assert.strictEqual(columnLabel(51), 'AZ');
		assert.strictEqual(columnLabel(52), 'BA');
		assert.strictEqual(columnLabel(701), 'ZZ');
	});
	test('three-letter boundary + the Excel max (XFD)', () => {
		assert.strictEqual(columnLabel(702), 'AAA');
		assert.strictEqual(columnLabel(MAX_COLS - 1), 'XFD'); // 16383 -- the last Excel column
	});
	test('negative index yields empty string (defensive, never reached via hit-test)', () => {
		assert.strictEqual(columnLabel(-1), '');
	});
});

suite('FE-2-0 gridLayoutA1 -- gutterWidth', function () {
	test('measured text width + padding on both sides', () => {
		assert.strictEqual(gutterWidth(40), 40 + 16);
		assert.strictEqual(gutterWidth(0), 16);
	});
	test('rounds the measured width up + floors a negative to 0', () => {
		assert.strictEqual(gutterWidth(40.2), 41 + 16);
		assert.strictEqual(gutterWidth(-5), 16);
	});
});

suite('FE-2-0 gridLayoutA1 -- cell geometry (gutter + header offsets)', function () {
	const G = 50; // a representative gutter width
	test('colX places column 0 right after the gutter', () => {
		assert.strictEqual(colX(0, G), G);
		assert.strictEqual(colX(1, G), G + COL_WIDTH);
		assert.strictEqual(colX(3, G), G + 3 * COL_WIDTH);
	});
	test('rowY places row 0 right below the header band', () => {
		assert.strictEqual(rowY(0), HEADER_HEIGHT);
		assert.strictEqual(rowY(4), HEADER_HEIGHT + 4 * ROW_HEIGHT);
	});
	test('cellContentRect of (0,0) sits at (gutterW, HEADER_HEIGHT)', () => {
		assert.deepStrictEqual(cellContentRect(0, 0, G), { x: G, y: HEADER_HEIGHT, width: COL_WIDTH, height: ROW_HEIGHT });
	});
	test('cellContentRect of an interior cell', () => {
		assert.deepStrictEqual(cellContentRect(3, 2, G), {
			x: G + 2 * COL_WIDTH,
			y: HEADER_HEIGHT + 3 * ROW_HEIGHT,
			width: COL_WIDTH,
			height: ROW_HEIGHT,
		});
	});
});

suite('FE-2-0 gridLayoutA1 -- extent totals (full Excel extent)', function () {
	const G = 50;
	test('totalContentWidth = gutter + all columns', () => {
		assert.strictEqual(totalContentWidth(G), G + MAX_COLS * COL_WIDTH);
	});
	test('totalContentHeight = header band + all rows (under the ~33.5M Chromium element cap)', () => {
		const h = totalContentHeight();
		assert.strictEqual(h, HEADER_HEIGHT + MAX_ROWS * ROW_HEIGHT);
		assert.ok(h < 33_554_432, 'full-extent spacer height must stay under the Chromium element cap');
	});
});

suite('FE-2-0 gridLayoutA1 -- computeVisibleColRange', function () {
	test('from the left edge with overscan', () => {
		// viewport 320px wide / 64px cols = 5 visible; +2 overscan each side; firstVisible 0.
		assert.deepStrictEqual(computeVisibleColRange(0, 320, MAX_COLS, COL_WIDTH, 2), { startIdx: 0, endIdx: 7 });
	});
	test('scrolled right', () => {
		// scrollLeft 640 / 64 = firstVisible 10; start 10-2=8; end 10+5+2=17.
		assert.deepStrictEqual(computeVisibleColRange(640, 320, MAX_COLS, COL_WIDTH, 2), { startIdx: 8, endIdx: 17 });
	});
	test('clamps a stale large scrollLeft to the last column (no empty window)', () => {
		const r = computeVisibleColRange(1e9, 320, MAX_COLS, COL_WIDTH, 2);
		assert.ok(r.startIdx < r.endIdx);
		assert.strictEqual(r.endIdx, MAX_COLS);
	});
	test('zero columns -> empty window', () => {
		assert.deepStrictEqual(computeVisibleColRange(0, 320, 0, COL_WIDTH, 2), { startIdx: 0, endIdx: 0 });
	});
	test('zero/negative colWidth -> the whole extent (avoids divide-by-zero)', () => {
		assert.deepStrictEqual(computeVisibleColRange(0, 320, MAX_COLS, 0, 2), { startIdx: 0, endIdx: MAX_COLS });
		assert.deepStrictEqual(computeVisibleColRange(640, 320, MAX_COLS, -5, 2), { startIdx: 0, endIdx: MAX_COLS });
	});
	test('zero viewportWidth -> at least one visible column (+ overscan)', () => {
		// visibleCount clamps to >= 1, so a degenerate 0-wide viewport still yields a non-empty window.
		assert.deepStrictEqual(computeVisibleColRange(0, 0, MAX_COLS, COL_WIDTH, 2), { startIdx: 0, endIdx: 3 });
	});
});

suite('FE-2-0 gridLayoutA1 -- hitTestContent (content coords)', function () {
	const G = 50;
	test('header band -> null', () => {
		assert.strictEqual(hitTestContent(G + 10, HEADER_HEIGHT - 1, G), null);
	});
	test('gutter -> null', () => {
		assert.strictEqual(hitTestContent(G - 1, HEADER_HEIGHT + 10, G), null);
	});
	test('first data cell (0,0)', () => {
		assert.deepStrictEqual(hitTestContent(G + 1, HEADER_HEIGHT + 1, G), { row: 0, col: 0 });
	});
	test('interior cell maps to floor((x-gutter)/COL_WIDTH), floor((y-header)/ROW_HEIGHT)', () => {
		assert.deepStrictEqual(
			hitTestContent(G + 2 * COL_WIDTH + 5, HEADER_HEIGHT + 3 * ROW_HEIGHT + 5, G),
			{ row: 3, col: 2 },
		);
	});
});

suite('FE-2-0 gridLayoutA1 -- hitTestViewport (TWO-AXIS sticky bands)', function () {
	const G = 50;
	test('a click in the sticky column band is null at ANY scrollLeft (sticky-top regression)', () => {
		assert.strictEqual(hitTestViewport(G + 100, HEADER_HEIGHT - 1, 0, 0, G), null);
		assert.strictEqual(hitTestViewport(G + 100, HEADER_HEIGHT - 1, 5000, 9000, G), null);
	});
	test('a click in the sticky row gutter is null at ANY scrollTop (the NEW sticky-LEFT regression)', () => {
		// The whole point: at scrollLeft>0 a naive content-coord gutter check would map the visible
		// sticky gutter to a body column. The local-coord rejection must fire FIRST.
		assert.strictEqual(hitTestViewport(G - 1, HEADER_HEIGHT + 100, 0, 0, G), null);
		assert.strictEqual(hitTestViewport(G - 1, HEADER_HEIGHT + 100, 5000, 9000, G), null);
	});
	test('a click in the corner box is null', () => {
		assert.strictEqual(hitTestViewport(G - 1, HEADER_HEIGHT - 1, 0, 0, G), null);
		assert.strictEqual(hitTestViewport(G - 1, HEADER_HEIGHT - 1, 5000, 9000, G), null);
	});
	test('a body click maps correctly after BOTH-axis scroll', () => {
		// scrollLeft 640 (=10 cols), scrollTop 250 (=10 rows). Local point at the band/gutter origin
		// + one cell in -> content (gutter+640+1, header+250+1) -> col 10, row 10.
		assert.deepStrictEqual(
			hitTestViewport(G + 1, HEADER_HEIGHT + 1, 640, 250, G),
			{ row: 10, col: 10 },
		);
	});
	test('out-of-extent clicks (past XFD / past the last row) -> null', () => {
		// A scrollLeft that pushes content-col past MAX_COLS.
		const farLeft = MAX_COLS * COL_WIDTH;
		assert.strictEqual(hitTestViewport(G + 1, HEADER_HEIGHT + 1, farLeft, 0, G), null);
		const farTop = MAX_ROWS * ROW_HEIGHT;
		assert.strictEqual(hitTestViewport(G + 1, HEADER_HEIGHT + 1, 0, farTop, G), null);
	});
});

suite('FE-2-0 gridLayoutA1 -- boundary + extent-edge exactness (audit follow-ups)', function () {
	const G = 50;
	test('the exact band/gutter boundary pixel maps to cell (0,0) (the `<` is exclusive)', () => {
		// contentX === gutterW and contentY === HEADER_HEIGHT are NOT rejected -> first cell.
		assert.deepStrictEqual(hitTestContent(G, HEADER_HEIGHT, G), { row: 0, col: 0 });
	});
	test('the last in-extent cell maps to (MAX_ROWS-1, MAX_COLS-1); one px past -> null', () => {
		assert.deepStrictEqual(
			hitTestContent(colX(MAX_COLS - 1, G) + 1, rowY(MAX_ROWS - 1) + 1, G),
			{ row: MAX_ROWS - 1, col: MAX_COLS - 1 },
		);
		assert.strictEqual(hitTestContent(colX(MAX_COLS, G), rowY(0) + 1, G), null); // col == MAX_COLS
		assert.strictEqual(hitTestContent(colX(0, G) + 1, rowY(MAX_ROWS), G), null); // row == MAX_ROWS
	});
	test('cell extents tile exactly to the totals at the far edge (float64 exactness)', () => {
		assert.strictEqual(colX(MAX_COLS - 1, G) + COL_WIDTH, totalContentWidth(G));
		assert.strictEqual(rowY(MAX_ROWS - 1) + ROW_HEIGHT, totalContentHeight());
	});
});

suite('FE-2-0 Phase 1 -- isInExtent (NaN/extent guard for snapshot entries)', function () {
	test('accepts integer coordinates inside the Excel extent', () => {
		assert.strictEqual(isInExtent(0, 0), true);
		assert.strictEqual(isInExtent(10, 20), true);
		assert.strictEqual(isInExtent(MAX_ROWS - 1, MAX_COLS - 1), true);
	});
	test('rejects out-of-extent coordinates (negative or >= the max)', () => {
		assert.strictEqual(isInExtent(-1, 0), false);
		assert.strictEqual(isInExtent(0, -1), false);
		assert.strictEqual(isInExtent(MAX_ROWS, 0), false);
		assert.strictEqual(isInExtent(0, MAX_COLS), false);
	});
	test('rejects NaN / Infinity / fractional coordinates (the load-bearing Number.isInteger)', () => {
		// A bare `r < 0 || r >= MAX_ROWS` range check is FALSE for NaN -- the whole reason for the guard.
		assert.strictEqual(isInExtent(NaN, 0), false);
		assert.strictEqual(isInExtent(0, NaN), false);
		assert.strictEqual(isInExtent(Infinity, 0), false);
		assert.strictEqual(isInExtent(0.5, 0), false);
		assert.strictEqual(isInExtent(0, 1.9), false);
	});
});

suite('FE-2-0 Phase 1 -- scrollToReveal (one-axis reveal + tiny-viewport clamp)', function () {
	// Representative band sizes: the gutter (≈50px) horizontally; HEADER_HEIGHT vertically.
	const BAND = 50;
	test('an already-visible cell leaves the scroll unchanged', () => {
		assert.strictEqual(scrollToReveal(200, COL_WIDTH, BAND, 100, 400), 100);
	});
	test('a cell off the near edge (under the band) scrolls so its start sits at the band edge', () => {
		const s = scrollToReveal(200, COL_WIDTH, BAND, 180, 400); // localStart 20 < band 50
		assert.strictEqual(s, 200 - BAND);
		assert.strictEqual(200 - s, BAND); // cell start now exactly at the band edge
	});
	test('a cell off the far edge scrolls so its end sits at the viewport edge', () => {
		const s = scrollToReveal(500, COL_WIDTH, BAND, 100, 400); // localEnd 464 > client 400
		assert.strictEqual(s, 500 + COL_WIDTH - 400);
		assert.strictEqual(500 - s + COL_WIDTH, 400); // cell end now exactly at the viewport edge
	});
	test('tiny viewport (body narrower than a cell): left-align, never park the cell under the band', () => {
		// client 80 - band 50 = 30 visible body < COL_WIDTH 64. The old far-edge branch would push the
		// cell start to localX = client - COL_WIDTH = 16 < band 50 -> UNDER the gutter. The clamp left-aligns.
		const s = scrollToReveal(300, COL_WIDTH, BAND, 290, 80);
		assert.strictEqual(s, 300 - BAND);
		assert.strictEqual(300 - s, BAND); // cell start at the band edge, not under it
	});
	test('vertical axis behaves identically with HEADER_HEIGHT as the band', () => {
		assert.strictEqual(scrollToReveal(rowY(0), ROW_HEIGHT, HEADER_HEIGHT, 0, 400), 0); // row 0 at top, visible
		const s = scrollToReveal(rowY(40), ROW_HEIGHT, HEADER_HEIGHT, 0, 200); // far below
		assert.strictEqual(s, rowY(40) + ROW_HEIGHT - 200);
	});
});
