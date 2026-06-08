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
	cellRefA1,
	colX,
	columnLabel,
	computeVisibleColRange,
	gutterWidth,
	hitTestContent,
	hitTestViewport,
	isInExtent,
	publishedNameAt,
	rowY,
	scrollToReveal,
	selectionRect,
	totalContentHeight,
	totalContentWidth,
	truncateToWidth,
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

suite('W-G gridLayoutA1 -- cellRefA1 (formula-bar name box)', function () {
	test('origin + diagonal', () => {
		assert.strictEqual(cellRefA1(0, 0), 'A1');
		assert.strictEqual(cellRefA1(1, 1), 'B2');
		assert.strictEqual(cellRefA1(9, 2), 'C10');
	});
	test('multi-letter columns keep the 1-based row', () => {
		assert.strictEqual(cellRefA1(0, 26), 'AA1');
		assert.strictEqual(cellRefA1(99, 701), 'ZZ100');
	});
	test('the Excel max cell', () => {
		assert.strictEqual(cellRefA1(MAX_ROWS - 1, MAX_COLS - 1), 'XFD1048576');
	});
	test('a negative row clamps to row 1 (defensive)', () => {
		assert.strictEqual(cellRefA1(-1, 0), 'A1');
	});
});

suite('W-G-2a gridLayoutA1 -- selectionRect (anchor/focus normalization)', function () {
	test('a single cell (anchor === focus) yields a degenerate rect', () => {
		assert.deepStrictEqual(selectionRect({ row: 3, col: 5 }, { row: 3, col: 5 }), {
			minRow: 3, maxRow: 3, minCol: 5, maxCol: 5,
		});
	});
	test('focus down-right of anchor', () => {
		assert.deepStrictEqual(selectionRect({ row: 1, col: 2 }, { row: 4, col: 6 }), {
			minRow: 1, maxRow: 4, minCol: 2, maxCol: 6,
		});
	});
	test('inverted: focus up-left of anchor normalizes the same', () => {
		assert.deepStrictEqual(selectionRect({ row: 4, col: 6 }, { row: 1, col: 2 }), {
			minRow: 1, maxRow: 4, minCol: 2, maxCol: 6,
		});
	});
	test('mixed: anchor low-row/high-col, focus high-row/low-col', () => {
		assert.deepStrictEqual(selectionRect({ row: 1, col: 9 }, { row: 7, col: 3 }), {
			minRow: 1, maxRow: 7, minCol: 3, maxCol: 9,
		});
	});
	test('a single-row band and a single-col band', () => {
		assert.deepStrictEqual(selectionRect({ row: 2, col: 0 }, { row: 2, col: 4 }), {
			minRow: 2, maxRow: 2, minCol: 0, maxCol: 4,
		});
		assert.deepStrictEqual(selectionRect({ row: 0, col: 3 }, { row: 5, col: 3 }), {
			minRow: 0, maxRow: 5, minCol: 3, maxCol: 3,
		});
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

// **FE-2-0 Phase 4 (2026-06-04)** -- migrated from the retired `test/quantbook-sheets-grid-layout.test.ts`
// when `truncateToWidth` moved out of the FE-0b `gridLayout.ts` into `gridLayoutA1.ts`. Body unchanged.
suite('FE-2-0 gridLayoutA1 -- truncateToWidth (migrated from FE-0b gridLayout)', function () {
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
	// FE megaudit L-e (2026-06-03): never slice mid-surrogate. An astral char (emoji) is 2 UTF-16 code
	// units; a cut between them would leave a lone high surrogate.
	test('does not split a surrogate pair (drops the whole astral char)', () => {
		// '😀' is 2 UTF-16 units. 'a😀bc' has length 5. measure(len)=len*10; maxWidth 35 -> largest prefix
		// len with (len+1)*10<=35 is 2, which cuts BETWEEN the surrogate pair (units 1 and 2). The L-e
		// backoff must drop to len 1 -> 'a…', never 'a\uD83D…'.
		const out = truncateToWidth('a😀bc', 35, measure);
		const beforeEllipsis = out.slice(0, -1);
		const lastUnit = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1);
		assert.ok(
			!(lastUnit >= 0xD800 && lastUnit <= 0xDBFF),
			`truncated result "${out}" must not end with a lone high surrogate`,
		);
	});
});

// FE-1.5 W-G (bound-cell name display): publishedNameAt resolves which reactive variable drives a
// cell, for the formula-bar chip + the hover tooltip. The chip/hover DOM is operator-smoke-only;
// this pins the pure membership predicate (inclusive rect, first-match-wins, structural param).
suite('FE-1.5 W-G gridLayoutA1 -- publishedNameAt (driving-variable lookup)', function () {
	test('empty ranges -> null everywhere', function () {
		assert.strictEqual(publishedNameAt([], 0, 0), null);
		assert.strictEqual(publishedNameAt([], 5, 9), null);
	});
	test('a single-cell range names its cell and nothing else', function () {
		const ranges = [{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' }]; // S0!B1
		assert.strictEqual(publishedNameAt(ranges, 0, 1), 'x', 'on the published cell');
		assert.strictEqual(publishedNameAt(ranges, 0, 0), null, 'one column left');
		assert.strictEqual(publishedNameAt(ranges, 0, 2), null, 'one column right');
		assert.strictEqual(publishedNameAt(ranges, 1, 1), null, 'one row below');
	});
	test('a multi-cell range matches its interior and every inclusive boundary corner', function () {
		// B2:D4 -> rows 1..3, cols 1..3 (a future range-aware bind shape).
		const ranges = [{ startRow: 1, startCol: 1, endRow: 3, endCol: 3, name: 'm' }];
		assert.strictEqual(publishedNameAt(ranges, 2, 2), 'm', 'interior');
		assert.strictEqual(publishedNameAt(ranges, 1, 1), 'm', 'top-left corner (inclusive)');
		assert.strictEqual(publishedNameAt(ranges, 1, 3), 'm', 'top-right corner (inclusive)');
		assert.strictEqual(publishedNameAt(ranges, 3, 1), 'm', 'bottom-left corner (inclusive)');
		assert.strictEqual(publishedNameAt(ranges, 3, 3), 'm', 'bottom-right corner (inclusive)');
		assert.strictEqual(publishedNameAt(ranges, 0, 1), null, 'one row above the top edge');
		assert.strictEqual(publishedNameAt(ranges, 4, 3), null, 'one row below the bottom edge');
		assert.strictEqual(publishedNameAt(ranges, 2, 4), null, 'one column past the right edge');
	});
	test('first-match-wins when ranges overlap (documented v1 registration order)', function () {
		const ranges = [
			{ startRow: 0, startCol: 0, endRow: 2, endCol: 2, name: 'first' },
			{ startRow: 0, startCol: 0, endRow: 2, endCol: 2, name: 'second' },
		];
		assert.strictEqual(publishedNameAt(ranges, 1, 1), 'first');
	});
	test('multiple disjoint ranges each resolve to their own name', function () {
		const ranges = [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'a' }, // B1
			{ startRow: 4, startCol: 2, endRow: 4, endCol: 2, name: 'b' }, // C5
		];
		assert.strictEqual(publishedNameAt(ranges, 0, 1), 'a');
		assert.strictEqual(publishedNameAt(ranges, 4, 2), 'b');
		assert.strictEqual(publishedNameAt(ranges, 2, 2), null, 'a gap between them');
	});
});
