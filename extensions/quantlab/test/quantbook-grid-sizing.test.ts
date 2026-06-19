/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wave G variable COLUMN-width sizing (R1, 2026-06-18) -- golden tests for the PURE sizing model in
 * `src/quantbook/shared/axisSizing.ts` and the column-aware geometry in `gridLayoutA1.ts`. Canvas
 * drawing needs a real 2D context (not available headlessly), so these pin the correctness-critical
 * math the renderer + overlay editor + hit-test + resize drag depend on: the sparse prefix-sum offset
 * and its binary-search inverse, the byte-identity of the zero-override path (the keystone invariant --
 * an un-resized axis must reduce EXACTLY to the old `index * defaultSize` arithmetic), the immutable
 * `withOverride` (canonical-form drop on default, loud throws on a malformed value), and -- in the
 * gridLayoutA1 suite -- the column-resize border hit-test.
 */

import * as assert from 'assert';

import {
	composeHidden,
	emptyAxisSizing,
	indexAtOffset,
	offsetBefore,
	sizeAt,
	totalExtent,
	withCollapsed,
	withOverride,
} from '../src/quantbook/shared/axisSizing';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	MIN_COL_WIDTH,
	MAX_COL_WIDTH,
	MIN_ROW_HEIGHT,
	MAX_ROW_HEIGHT,
	MAX_SPACER_PX,
	ROW_HEIGHT,
	cellContentRect,
	clampSplitScroll,
	colResizeBorderAt,
	colX,
	computeVisibleBodyColRange,
	computeVisibleBodyRowRange,
	computeVisibleColRange,
	frozenColsWidth,
	frozenRowsHeight,
	getColSizing,
	getRowSizing,
	hitTestContent,
	hitTestViewportFrozen,
	resetColSizing,
	resetRowSizing,
	rowResizeBorderAt,
	rowResizeBorderAtSplit,
	rowY,
	setColSizing,
	setRowSizing,
	splitPaneRowRanges,
	totalContentHeight,
	totalContentWidth,
} from '../webview/sheets-webview/gridLayoutA1';
import { computeVisibleRowRange } from '../webview/sheets-webview/cellRender';

// Representative column config (matches the live grid: COL_WIDTH=100, MAX_COLS=16384). The pure model
// is axis-generic, so these are just concrete params -- the gridLayoutA1 suite ties them to the real grid.
const COL = 100;
const COLS = 16_384;
const MINW = 12;
const MAXW = 2000;

suite('Wave G axisSizing -- empty model byte-identity (the keystone)', function () {
	const empty = emptyAxisSizing(COL, COLS, MINW, MAXW);

	test('offsetBefore(empty, k) === k * defaultSize', () => {
		for (const k of [0, 1, 5, 100, 1000, COLS - 1, COLS]) {
			assert.strictEqual(offsetBefore(empty, k), k * COL, `k=${k}`);
		}
	});

	test('sizeAt(empty, k) === defaultSize', () => {
		for (const k of [0, 1, 7, COLS - 1]) {
			assert.strictEqual(sizeAt(empty, k), COL, `k=${k}`);
		}
	});

	test('totalExtent(empty) === count * defaultSize', () => {
		assert.strictEqual(totalExtent(empty), COLS * COL);
	});

	test('indexAtOffset(empty, px) === floor(px / defaultSize) across boundaries + out of range', () => {
		for (const px of [0, 1, 50, 99, 100, 101, 150, 199, 200, 12345, COLS * COL - 1, COLS * COL, COLS * COL + 1, -1, -100]) {
			assert.strictEqual(indexAtOffset(empty, px), Math.floor(px / COL), `px=${px}`);
		}
	});
});

suite('Wave G axisSizing -- multi-override prefix-sum + inverse round-trip', function () {
	// cols 2->200 (wider), 5->40 (narrower), 9->300 (wider). Extras: +100, -60, +200.
	const s = withOverride(withOverride(withOverride(emptyAxisSizing(COL, COLS, MINW, MAXW), 2, 200), 5, 40), 9, 300);

	test('offsetBefore accumulates the extra of every override key strictly before the index', () => {
		assert.strictEqual(offsetBefore(s, 0), 0);
		assert.strictEqual(offsetBefore(s, 2), 200); // no override < 2
		assert.strictEqual(offsetBefore(s, 3), 3 * COL + 100); // col 2 (+100) is < 3
		assert.strictEqual(offsetBefore(s, 5), 5 * COL + 100); // col 2 only (5 not < 5)
		assert.strictEqual(offsetBefore(s, 6), 6 * COL + 100 - 60); // cols 2,5
		assert.strictEqual(offsetBefore(s, 9), 9 * COL + 100 - 60); // cols 2,5 (9 not < 9)
		assert.strictEqual(offsetBefore(s, 10), 10 * COL + 100 - 60 + 200); // cols 2,5,9
	});

	test('sizeAt returns the override or the default', () => {
		assert.strictEqual(sizeAt(s, 2), 200);
		assert.strictEqual(sizeAt(s, 5), 40);
		assert.strictEqual(sizeAt(s, 9), 300);
		assert.strictEqual(sizeAt(s, 3), COL);
		assert.strictEqual(sizeAt(s, 0), COL);
	});

	test('totalExtent = uniform + sum of all extras', () => {
		assert.strictEqual(totalExtent(s), COLS * COL + 100 - 60 + 200);
	});

	test('inverse round-trip: indexAtOffset(leading edge of i) === i', () => {
		for (const i of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 50, COLS - 1]) {
			assert.strictEqual(indexAtOffset(s, offsetBefore(s, i)), i, `i=${i}`);
		}
	});

	test('a pixel in the INTERIOR of a resized cell maps back to that cell', () => {
		// col 2 spans [200, 400) (width 200): mid 300 -> 2; col 5 spans [600,640) (width 40): 620 -> 5.
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 2) + 100), 2);
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 5) + 20), 5);
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 9) + 299), 9);
	});

	test('boundary exactness: leading edge -> i, one px past trailing edge -> i+1', () => {
		// col 2: [200, 400). 399 -> 2, 400 -> 3.
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 2)), 2);
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 3) - 1), 2);
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 3)), 3);
		// col 5: [600, 640). 639 -> 5, 640 -> 6.
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 6) - 1), 5);
		assert.strictEqual(indexAtOffset(s, offsetBefore(s, 6)), 6);
	});

	test('out-of-extent px extrapolates with the default (>= count) so isInExtent can reject', () => {
		const total = totalExtent(s);
		assert.strictEqual(indexAtOffset(s, total), COLS); // exactly at the end -> first out-of-extent index
		assert.strictEqual(indexAtOffset(s, total + COL), COLS + 1);
		assert.strictEqual(indexAtOffset(s, -1), -1);
	});
});

suite('Wave G axisSizing -- withOverride immutability + canonical form', function () {
	const empty = emptyAxisSizing(COL, COLS, MINW, MAXW);

	test('withOverride returns a fresh model; the source is untouched', () => {
		const s = withOverride(empty, 3, 250);
		assert.strictEqual(empty.overrides.size, 0, 'source unchanged');
		assert.strictEqual(s.overrides.size, 1);
		assert.strictEqual(sizeAt(s, 3), 250);
		assert.strictEqual(sizeAt(empty, 3), COL);
	});

	test('setting an index back to the default REMOVES the override (canonical: uniform <=> empty)', () => {
		const s = withOverride(empty, 3, 250);
		const back = withOverride(s, 3, COL);
		assert.strictEqual(back.overrides.size, 0);
		assert.strictEqual(totalExtent(back), totalExtent(empty));
		// And byte-identical to a never-resized model again.
		assert.strictEqual(offsetBefore(back, 100), 100 * COL);
	});

	test('overriding the same index twice keeps one entry at the latest size', () => {
		const s = withOverride(withOverride(empty, 4, 300), 4, 150);
		assert.strictEqual(s.overrides.size, 1);
		assert.strictEqual(sizeAt(s, 4), 150);
	});
});

suite('Wave G axisSizing -- loud construction invariants (No-Fallbacks)', function () {
	const empty = emptyAxisSizing(COL, COLS, MINW, MAXW);

	test('withOverride throws on a malformed index', () => {
		assert.throws(() => withOverride(empty, -1, 200));
		assert.throws(() => withOverride(empty, COLS, 200));
		assert.throws(() => withOverride(empty, 2.5, 200));
		assert.throws(() => withOverride(empty, NaN, 200));
	});

	test('withOverride throws on an out-of-clamp size', () => {
		assert.throws(() => withOverride(empty, 2, MINW - 1));
		assert.throws(() => withOverride(empty, 2, MAXW + 1));
		assert.throws(() => withOverride(empty, 2, 0));
		assert.throws(() => withOverride(empty, 2, -50));
		assert.throws(() => withOverride(empty, 2, NaN));
		assert.throws(() => withOverride(empty, 2, Infinity));
	});

	test('emptyAxisSizing throws on a nonsensical config', () => {
		assert.throws(() => emptyAxisSizing(0, COLS, MINW, MAXW));
		assert.throws(() => emptyAxisSizing(-100, COLS, MINW, MAXW));
		assert.throws(() => emptyAxisSizing(COL, 0, MINW, MAXW));
		assert.throws(() => emptyAxisSizing(COL, COLS, 0, MAXW));
		assert.throws(() => emptyAxisSizing(COL, COLS, MAXW, MINW)); // max < min
		assert.throws(() => emptyAxisSizing(5, COLS, MINW, MAXW)); // default below min
	});
});

suite('Wave G3a axisSizing -- withCollapsed + composeHidden (hidden rows = 0px)', function () {
	// Use the ROW config (a hidden row is a row concept), with the row spacer cap so the cap-vs-collapse
	// claim is exercised against the same FINITE cap the live row axis carries.
	const ROWS = MAX_ROWS;
	const rowEmpty = () => emptyAxisSizing(ROW_HEIGHT, ROWS, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, MAX_SPACER_PX - HEADER_HEIGHT);

	test('withCollapsed sets the index to exactly 0 (bypassing the minSize floor withOverride enforces)', () => {
		const s = withCollapsed(rowEmpty(), 4);
		assert.strictEqual(sizeAt(s, 4), 0);
		// withOverride would throw for 0 / below-min; withCollapsed does not.
		assert.throws(() => withOverride(rowEmpty(), 4, 0));
		assert.strictEqual(s.overrides.size, 1, 'a 0-entry is stored (0 != defaultSize) so the gate trips');
	});

	test('withCollapsed is immutable; the source model is untouched', () => {
		const base = rowEmpty();
		const s = withCollapsed(base, 3);
		assert.strictEqual(sizeAt(base, 3), ROW_HEIGHT, 'source unchanged');
		assert.strictEqual(sizeAt(s, 3), 0);
	});

	test('withCollapsed throws on a malformed index (No-Fallbacks)', () => {
		assert.throws(() => withCollapsed(rowEmpty(), -1));
		assert.throws(() => withCollapsed(rowEmpty(), ROWS));
		assert.throws(() => withCollapsed(rowEmpty(), 2.5));
		assert.throws(() => withCollapsed(rowEmpty(), NaN));
	});

	test('a collapsed row only DECREASES extent -> the spacer cap can never fire', () => {
		const base = rowEmpty();
		const before = totalExtent(base);
		const s = withCollapsed(base, 7);
		assert.strictEqual(totalExtent(s), before - ROW_HEIGHT);
		assert.ok(totalExtent(s) < base.maxTotalExtent);
	});

	test('offsetBefore plateaus across a collapsed band; indexAtOffset returns the FIRST VISIBLE row after it', () => {
		// Hide rows 4 and 5: offsets at 4,5,6 collapse onto the same value, and a hit at that offset
		// resolves to row 6 (the first visible row past the band) -- hidden rows are never hit-tested.
		const s = composeHidden(rowEmpty(), [4, 5]);
		assert.strictEqual(offsetBefore(s, 4), 4 * ROW_HEIGHT);
		assert.strictEqual(offsetBefore(s, 5), 4 * ROW_HEIGHT, 'row 4 contributes 0');
		assert.strictEqual(offsetBefore(s, 6), 4 * ROW_HEIGHT, 'rows 4,5 contribute 0');
		assert.strictEqual(offsetBefore(s, 7), 5 * ROW_HEIGHT, 'row 6 visible again');
		assert.strictEqual(indexAtOffset(s, 4 * ROW_HEIGHT), 6, 'collapsed-band offset -> first visible row after');
		assert.strictEqual(sizeAt(s, 4), 0);
		assert.strictEqual(sizeAt(s, 5), 0);
		assert.strictEqual(sizeAt(s, 6), ROW_HEIGHT);
	});

	test('composeHidden over an EMPTY set returns the base UNCHANGED (same reference -- the keystone)', () => {
		const base = withOverride(rowEmpty(), 2, 60); // a resize, no hidden
		assert.strictEqual(composeHidden(base, []), base);
		assert.strictEqual(composeHidden(base, new Set<number>()), base);
	});

	test('compose order is resize-then-collapse: a hidden row shadows its resize to 0...', () => {
		const resized = withOverride(rowEmpty(), 3, 80);
		const composed = composeHidden(resized, [3]);
		assert.strictEqual(sizeAt(composed, 3), 0, 'hidden wins over the resize');
		// ...and UNHIDING (recomposing from the SEPARATE resize input with an empty hidden set) restores 80px.
		assert.strictEqual(sizeAt(composeHidden(resized, []), 3), 80, 'unhide restores the user resize height');
	});

	test('composeHidden throws on an out-of-extent hidden index (contained at the webview boundary)', () => {
		assert.throws(() => composeHidden(rowEmpty(), [2, ROWS + 1]));
	});
});

// A representative gutter width (the renderer measures this per frame; any positive value works here).
const G = 50;
const colModel = () => emptyAxisSizing(COL_WIDTH, MAX_COLS, MIN_COL_WIDTH, MAX_COL_WIDTH);

suite('Wave G gridLayoutA1 -- column geometry is byte-identical under the DEFAULT (uniform) binding', function () {
	// The existing gridlayout + split golden suites are the real regression net (they run in this same
	// mocha pass with the default empty binding). These focused assertions guard the keystone directly.
	teardown(() => resetColSizing());

	test('colX / cellContentRect / totalContentWidth / frozenColsWidth reduce to COL_WIDTH arithmetic', () => {
		resetColSizing();
		assert.strictEqual(colX(0, G), G);
		assert.strictEqual(colX(5, G), G + 5 * COL_WIDTH);
		assert.deepStrictEqual(cellContentRect(2, 3, G), {
			x: G + 3 * COL_WIDTH,
			y: HEADER_HEIGHT + 2 * ROW_HEIGHT,
			width: COL_WIDTH,
			height: ROW_HEIGHT,
		});
		assert.strictEqual(totalContentWidth(G), G + MAX_COLS * COL_WIDTH);
		assert.strictEqual(frozenColsWidth(0), 0);
		assert.strictEqual(frozenColsWidth(3), 3 * COL_WIDTH);
	});

	test('hitTestContent maps uniformly + the visible-col window is the legacy floor/ceil', () => {
		resetColSizing();
		// content-X G+250 -> col 2 (250/100=2.5); content-Y HEADER+5 -> row 0.
		assert.deepStrictEqual(hitTestContent(G + 250, HEADER_HEIGHT + 5, G), { row: 0, col: 2 });
		// viewport [0,200) at COL_WIDTH=100, no overscan -> cols [0,2).
		assert.deepStrictEqual(computeVisibleColRange(0, 200, MAX_COLS, COL_WIDTH, 0), { startIdx: 0, endIdx: 2 });
	});
});

suite('Wave G gridLayoutA1 -- column geometry shifts with resized columns', function () {
	teardown(() => resetColSizing());

	test('a widened column pushes every later colX + grows totalContentWidth', () => {
		setColSizing(withOverride(colModel(), 1, 200)); // col 1: 100 -> 200 (+100)
		assert.strictEqual(colX(0, G), G); // before the resize
		assert.strictEqual(colX(1, G), G + COL_WIDTH); // leading edge of col 1 unchanged (sum of [0,1))
		assert.strictEqual(colX(2, G), G + COL_WIDTH + 200); // col 1 is now 200 wide
		assert.strictEqual(colX(3, G), G + 2 * COL_WIDTH + 200);
		assert.strictEqual(cellContentRect(0, 1, G).width, 200);
		assert.strictEqual(cellContentRect(0, 2, G).width, COL_WIDTH);
		assert.strictEqual(totalContentWidth(G), G + MAX_COLS * COL_WIDTH + 100);
		assert.strictEqual(frozenColsWidth(2), COL_WIDTH + 200); // cols 0 (100) + 1 (200)
	});

	test('hitTestContent round-trips: a point inside a (variable-width) column maps back to it', () => {
		setColSizing(withOverride(withOverride(colModel(), 1, 220), 3, 40));
		for (let c = 0; c < 6; c += 1) {
			const mid = Math.floor((colX(c, G) + colX(c + 1, G)) / 2);
			const hit = hitTestContent(mid, HEADER_HEIGHT + 1, G);
			assert.ok(hit !== null, `c=${c} mid=${mid}`);
			assert.strictEqual(hit!.col, c, `c=${c} mid=${mid}`);
		}
	});

	test('computeVisibleColRange leaves NO blank column: every column with a pixel in the viewport is covered', () => {
		setColSizing(withOverride(colModel(), 0, 40)); // narrow col 0 -> more columns fit
		const scrollLeft = 0;
		const viewportWidth = 350;
		const range = computeVisibleColRange(scrollLeft, viewportWidth, MAX_COLS, COL_WIDTH, 0);
		// Walk the columns whose painted span intersects [scrollLeft, scrollLeft+viewportWidth) and assert
		// each is inside [startIdx, endIdx). col0=[0,40), col1=[40,140), col2=[140,240), col3=[240,340), col4=[340,440)
		for (let c = 0; c < 5; c += 1) {
			const left = colX(c, G) - G; // content-X (drop the gutter)
			const right = colX(c + 1, G) - G;
			if (right > scrollLeft && left < scrollLeft + viewportWidth) {
				assert.ok(c >= range.startIdx && c < range.endIdx, `col ${c} [${left},${right}) must be covered by [${range.startIdx},${range.endIdx})`);
			}
		}
	});

	test('setColSizing / getColSizing round-trip', () => {
		const s = withOverride(colModel(), 4, 333);
		setColSizing(s);
		assert.strictEqual(getColSizing(), s);
		assert.strictEqual(sizeAt(getColSizing(), 4), 333);
	});

	test('computeVisibleBodyColRange (the live renderer path) covers the body window under freeze + resize', () => {
		// Freeze 1 col, widen col 0 (a frozen col) to 200. Body shows cols >= 1 scrolled under the band.
		setColSizing(withOverride(colModel(), 0, 200));
		const range = computeVisibleBodyColRange(0, 400, MAX_COLS, COL_WIDTH, 0, 1);
		// frozen band = 200 (col 0). body viewport = 400-200 = 200 px, starting at content col 1.
		// body cols: 1=[200,300), 2=[300,400), 3=[400,500). The 200px body window [200,400) covers cols 1,2.
		assert.ok(range.startIdx >= 1, 'never paints a frozen column as a body column');
		for (const c of [1, 2]) {
			assert.ok(c >= range.startIdx && c < range.endIdx, `body col ${c} must be covered by [${range.startIdx},${range.endIdx})`);
		}
	});
});

suite('Wave G gridLayoutA1 -- colResizeBorderAt (the resize-cursor / drag hit-test)', function () {
	teardown(() => resetColSizing());

	test('uniform: grabbing a column border returns the column on its LEFT (Excel convention)', () => {
		resetColSizing();
		// col 0 spans local [G, G+100); its right edge is at G+100. The border there resizes col 0.
		assert.strictEqual(colResizeBorderAt(G + COL_WIDTH, 0, G, 0), 0);
		// col 1 right edge at G+200 -> resize col 1.
		assert.strictEqual(colResizeBorderAt(G + 2 * COL_WIDTH, 0, G, 0), 1);
	});

	test('the middle of a column is NOT a border', () => {
		resetColSizing();
		assert.strictEqual(colResizeBorderAt(G + 50, 0, G, 0), -1); // mid of col 0
		assert.strictEqual(colResizeBorderAt(G + 150, 0, G, 0), -1); // mid of col 1
	});

	test('the gutter / corner is never a column border', () => {
		resetColSizing();
		assert.strictEqual(colResizeBorderAt(G - 1, 0, G, 0), -1);
		assert.strictEqual(colResizeBorderAt(0, 0, G, 0), -1);
	});

	test('honours horizontal scroll: a border scrolled to local-X is detected there', () => {
		resetColSizing();
		// scrollLeft 100 shifts col 1's right edge (content G+200) to local G+100.
		assert.strictEqual(colResizeBorderAt(G + COL_WIDTH, 100, G, 0), 1);
	});

	test('resized columns move the grab point', () => {
		setColSizing(withOverride(colModel(), 0, 200)); // col 0 -> 200 wide
		// col 0 right edge now at G+200 -> resize col 0.
		assert.strictEqual(colResizeBorderAt(G + 200, 0, G, 0), 0);
		// G+100 is now the MIDDLE of col 0 (span [G, G+200)) -> not a border.
		assert.strictEqual(colResizeBorderAt(G + 100, 0, G, 0), -1);
	});

	test('the frozen/body divider is grabbable from BOTH sides even when scrolled (resizes the last frozen col)', () => {
		resetColSizing();
		// freeze 2 cols -> the divider seam is fixed at G + frozenColsWidth(2) = G + 200 (no scroll).
		const dividerX = G + 200;
		// Body is scrolled far past RESIZE_GRAB_PX -- the OLD body-edge math would miss the right side.
		assert.strictEqual(colResizeBorderAt(dividerX, 500, G, 2), 1); // exactly on the seam -> last frozen col
		assert.strictEqual(colResizeBorderAt(dividerX + 3, 500, G, 2), 1); // right side, within GRAB
		assert.strictEqual(colResizeBorderAt(dividerX - 3, 500, G, 2), 1); // left side, within GRAB
		// A point well into the body (past the seam + GRAB) is NOT the divider.
		assert.notStrictEqual(colResizeBorderAt(dividerX + 40, 500, G, 2), 1);
	});
});

// === Wave G-rows: variable ROW-HEIGHT sizing ======================================================
// The model is the same axis-generic AxisSizing; these suites pin the ROW binding wired through
// gridLayoutA1 (rowY / cellContentRect-height / totalContentHeight / frozenRowsHeight / hitTestContent /
// hitTestViewportFrozen / computeVisibleBodyRowRange / splitPaneRowRanges / clampSplitScroll /
// rowResizeBorderAt) + the cellRender computeVisibleRowRange, plus the row-specific spacer-extent cap.
const rowModel = () => emptyAxisSizing(ROW_HEIGHT, MAX_ROWS, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, MAX_SPACER_PX - HEADER_HEIGHT);

suite('Wave G-rows axisSizing -- total-extent cap (the row spacer guard; columns are uncapped)', function () {
	// A SMALL capped model so the cap is reachable in a unit test (the live row model has ~7.8M px of headroom):
	// base extent = 100 * 10 = 1000; cap = 1500 (headroom 500).
	const capped = () => emptyAxisSizing(10, 100, 1, 1000, 1500);

	test('withOverride within the cap succeeds', () => {
		assert.strictEqual(totalExtent(withOverride(capped(), 0, 500)), 1490); // +490 -> 1490 <= 1500
	});

	test('withOverride that would exceed the cap throws (No-Fallbacks)', () => {
		assert.throws(() => withOverride(capped(), 0, 600)); // +590 -> 1590 > 1500
	});

	test('the cap is cumulative across overrides', () => {
		const s = withOverride(capped(), 0, 400); // +390 -> 1390
		assert.strictEqual(totalExtent(s), 1390);
		assert.throws(() => withOverride(s, 1, 200)); // +190 -> 1580 > 1500
	});

	test('exact boundary: total === cap is ALLOWED, total === cap + 1 throws', () => {
		// base 1000, cap 1500. Override 0 -> 510 gives extra +500 -> total EXACTLY 1500 (allowed).
		assert.strictEqual(totalExtent(withOverride(capped(), 0, 510)), 1500);
		// Override 0 -> 511 gives extra +501 -> total 1501 (cap + 1, rejected).
		assert.throws(() => withOverride(capped(), 0, 511));
	});

	test('emptyAxisSizing throws when the cap is below the uniform baseline', () => {
		assert.throws(() => emptyAxisSizing(10, 100, 1, 1000, 999)); // base 1000 > cap 999
	});

	test('columns (no cap arg == Infinity) never throw on extent -- the keystone for byte-identity', () => {
		let s = emptyAxisSizing(COL_WIDTH, MAX_COLS, MIN_COL_WIDTH, MAX_COL_WIDTH);
		for (let c = 0; c < 50; c += 1) {
			s = withOverride(s, c, MAX_COL_WIDTH); // 50 columns at max -- columns are uncapped
		}
		assert.strictEqual(s.overrides.size, 50);
	});

	test('the live row model admits a realistic handful of max-height rows', () => {
		let s = rowModel();
		for (let r = 0; r < 20; r += 1) {
			s = withOverride(s, r, MAX_ROW_HEIGHT);
		}
		assert.strictEqual(s.overrides.size, 20);
	});
});

suite('Wave G-rows gridLayoutA1 -- row geometry is byte-identical under the DEFAULT (uniform) binding', function () {
	teardown(() => resetRowSizing());

	test('rowY / cellContentRect-height / totalContentHeight / frozenRowsHeight reduce to ROW_HEIGHT arithmetic', () => {
		resetRowSizing();
		assert.strictEqual(rowY(0), HEADER_HEIGHT);
		assert.strictEqual(rowY(5), HEADER_HEIGHT + 5 * ROW_HEIGHT);
		assert.strictEqual(cellContentRect(2, 3, G).height, ROW_HEIGHT);
		assert.strictEqual(totalContentHeight(), HEADER_HEIGHT + MAX_ROWS * ROW_HEIGHT);
		assert.strictEqual(frozenRowsHeight(0), 0);
		assert.strictEqual(frozenRowsHeight(3), 3 * ROW_HEIGHT);
	});

	test('hitTestContent maps uniformly + computeVisibleRowRange is the legacy floor/ceil', () => {
		resetRowSizing();
		resetColSizing();
		// content-Y HEADER+50 -> row 2 (50/24 = 2.08); content-X G+5 -> col 0.
		assert.deepStrictEqual(hitTestContent(G + 5, HEADER_HEIGHT + 50, G), { row: 2, col: 0 });
		// viewport [0, 100) at ROW_HEIGHT=24, no overscan -> rows [0, ceil(100/24)=5).
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, MAX_ROWS, ROW_HEIGHT, 0), { startIdx: 0, endIdx: 5 });
	});

	test('clampSplitScroll ceiling reduces to MAX_ROWS*ROW_HEIGHT - band', () => {
		resetRowSizing();
		assert.strictEqual(clampSplitScroll(Number.MAX_SAFE_INTEGER, 200), MAX_ROWS * ROW_HEIGHT - 200);
	});
});

suite('Wave G-rows gridLayoutA1 -- row geometry shifts with resized rows', function () {
	teardown(() => { resetRowSizing(); resetColSizing(); });

	test('a taller row pushes every later rowY + grows totalContentHeight', () => {
		setRowSizing(withOverride(rowModel(), 1, 60)); // row 1: 24 -> 60 (+36)
		assert.strictEqual(rowY(0), HEADER_HEIGHT);
		assert.strictEqual(rowY(1), HEADER_HEIGHT + ROW_HEIGHT); // leading edge of row 1 unchanged
		assert.strictEqual(rowY(2), HEADER_HEIGHT + ROW_HEIGHT + 60); // row 1 is now 60 tall
		assert.strictEqual(rowY(3), HEADER_HEIGHT + 2 * ROW_HEIGHT + 60);
		assert.strictEqual(cellContentRect(1, 0, G).height, 60);
		assert.strictEqual(cellContentRect(2, 0, G).height, ROW_HEIGHT);
		assert.strictEqual(totalContentHeight(), HEADER_HEIGHT + MAX_ROWS * ROW_HEIGHT + 36);
		assert.strictEqual(frozenRowsHeight(2), ROW_HEIGHT + 60); // rows 0 (24) + 1 (60)
	});

	test('hitTestContent round-trips: a point inside a (variable-height) row maps back to it', () => {
		resetColSizing();
		setRowSizing(withOverride(withOverride(rowModel(), 1, 80), 3, 12));
		for (let r = 0; r < 6; r += 1) {
			const mid = Math.floor((rowY(r) + rowY(r + 1)) / 2);
			const hit = hitTestContent(G + 1, mid, G);
			assert.ok(hit !== null, `r=${r} mid=${mid}`);
			assert.strictEqual(hit!.row, r, `r=${r} mid=${mid}`);
		}
	});

	test('clampSplitScroll ceiling tracks the resized total extent', () => {
		setRowSizing(withOverride(rowModel(), 0, 1000)); // +976
		assert.strictEqual(clampSplitScroll(Number.MAX_SAFE_INTEGER, 200), MAX_ROWS * ROW_HEIGHT + 976 - 200);
	});

	test('computeVisibleRowRange leaves NO blank row: every row with a pixel in the viewport is covered', () => {
		setRowSizing(withOverride(rowModel(), 0, 12)); // narrow row 0 -> more rows fit
		const scrollTop = 0;
		const viewportHeight = 100;
		const range = computeVisibleRowRange(scrollTop, viewportHeight, MAX_ROWS, ROW_HEIGHT, 0);
		for (let r = 0; r < 6; r += 1) {
			const top = rowY(r) - HEADER_HEIGHT; // content-Y (drop the header band)
			const bottom = rowY(r + 1) - HEADER_HEIGHT;
			if (bottom > scrollTop && top < scrollTop + viewportHeight) {
				assert.ok(r >= range.startIdx && r < range.endIdx, `row ${r} [${top},${bottom}) must be covered by [${range.startIdx},${range.endIdx})`);
			}
		}
	});

	test('computeVisibleBodyRowRange covers the body window under freeze + resize', () => {
		setRowSizing(withOverride(rowModel(), 0, 60)); // a FROZEN row resized taller
		const range = computeVisibleBodyRowRange(0, 200, MAX_ROWS, ROW_HEIGHT, 0, 1);
		// frozen band = 60 (row 0). body viewport = 200-60 = 140 px starting at content row 1.
		assert.ok(range.startIdx >= 1, 'never paints a frozen row as a body row');
		for (const r of [1, 2]) {
			assert.ok(r >= range.startIdx && r < range.endIdx, `body row ${r} must be covered by [${range.startIdx},${range.endIdx})`);
		}
	});

	test('splitPaneRowRanges windows each pane under a resized row (no blank row)', () => {
		setRowSizing(withOverride(rowModel(), 0, 100)); // row 0 tall
		const ranges = splitPaneRowRanges(0, 0, HEADER_HEIGHT + 200, 400, 0); // top band = 200 px
		assert.strictEqual(ranges.top.startIdx, 0);
		assert.ok(ranges.top.endIdx > ranges.top.startIdx);
		assert.ok(ranges.bottom.endIdx > ranges.bottom.startIdx);
	});

	test('setRowSizing / getRowSizing round-trip', () => {
		const s = withOverride(rowModel(), 4, 333);
		setRowSizing(s);
		assert.strictEqual(getRowSizing(), s);
		assert.strictEqual(sizeAt(getRowSizing(), 4), 333);
	});

	test('hitTestViewportFrozen rows round-trip under a resized frozen row AND a resized body row', () => {
		resetColSizing();
		setRowSizing(withOverride(withOverride(rowModel(), 0, 60), 5, 80)); // frozen row 0 = 60, body row 5 = 80
		// A point in the frozen row-0 band maps to row 0 (pinned, no scroll):
		assert.strictEqual(hitTestViewportFrozen(G + 1, HEADER_HEIGHT + 30, 0, 0, G, 1, 0)!.row, 0);
		// rows past the frozen band: 0=60,1..4=24,5=80 -> row 5 content-Y spans [156, 236). A local Y of
		// HEADER+200 (no scroll) maps to absolute content-Y 200 -> row 5.
		assert.strictEqual(hitTestViewportFrozen(G + 1, HEADER_HEIGHT + 200, 0, 0, G, 1, 0)!.row, 5);
	});
});

suite('Wave G-rows gridLayoutA1 -- rowResizeBorderAt (the resize-cursor / drag hit-test)', function () {
	teardown(() => resetRowSizing());

	test('uniform: grabbing a row border returns the row ABOVE it (Excel convention)', () => {
		resetRowSizing();
		// row 0 spans local [HEADER, HEADER+24); its bottom edge at HEADER+24 resizes row 0.
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT + ROW_HEIGHT, 0, HEADER_HEIGHT, 0), 0);
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT + 2 * ROW_HEIGHT, 0, HEADER_HEIGHT, 0), 1);
	});

	test('the middle of a row is NOT a border', () => {
		resetRowSizing();
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT + 12, 0, HEADER_HEIGHT, 0), -1); // mid of row 0
	});

	test('the header band / corner is never a row border', () => {
		resetRowSizing();
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT - 1, 0, HEADER_HEIGHT, 0), -1);
		assert.strictEqual(rowResizeBorderAt(0, 0, HEADER_HEIGHT, 0), -1);
	});

	test('honours vertical scroll: a border scrolled to local-Y is detected there', () => {
		resetRowSizing();
		// scrollTop 24 shifts row 1's bottom edge (content HEADER+48) to local HEADER+24.
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT + ROW_HEIGHT, ROW_HEIGHT, HEADER_HEIGHT, 0), 1);
	});

	test('resized rows move the grab point', () => {
		setRowSizing(withOverride(rowModel(), 0, 60)); // row 0 -> 60 tall
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT + 60, 0, HEADER_HEIGHT, 0), 0);
		assert.strictEqual(rowResizeBorderAt(HEADER_HEIGHT + 30, 0, HEADER_HEIGHT, 0), -1); // mid of row 0 now
	});

	test('the frozen/body divider is grabbable from BOTH sides even when scrolled (resizes the last frozen row)', () => {
		resetRowSizing();
		const dividerY = HEADER_HEIGHT + 2 * ROW_HEIGHT; // freeze 2 rows -> seam at HEADER + 48 (no scroll)
		assert.strictEqual(rowResizeBorderAt(dividerY, 500, HEADER_HEIGHT, 2), 1); // on the seam
		assert.strictEqual(rowResizeBorderAt(dividerY + 3, 500, HEADER_HEIGHT, 2), 1); // body side, within GRAB
		assert.strictEqual(rowResizeBorderAt(dividerY - 3, 500, HEADER_HEIGHT, 2), 1); // frozen side, within GRAB
		assert.notStrictEqual(rowResizeBorderAt(dividerY + 40, 500, HEADER_HEIGHT, 2), 1); // well into the body
	});
});

suite('Wave G-rows gridLayoutA1 -- rowResizeBorderAtSplit (split-aware row border; Codex audit HIGH)', function () {
	teardown(() => resetRowSizing());
	const HH = HEADER_HEIGHT;
	const splitBarY = HH + 200; // top band 200 px tall

	test('the header band / corner is never a border', () => {
		resetRowSizing();
		assert.strictEqual(rowResizeBorderAtSplit(HH - 1, splitBarY, 0, 0, HH), -1);
	});

	test('top pane detects the border using the TOP synthetic scroll (the bottom scroll is irrelevant there)', () => {
		resetRowSizing();
		// topScroll 0: row 0's bottom edge at local HH+24 -> resize row 0.
		assert.strictEqual(rowResizeBorderAtSplit(HH + ROW_HEIGHT, splitBarY, 0, 999, HH), 0);
		// topScroll 24 shifts row 1's bottom edge (content HH+48) to local HH+24 -> resize row 1.
		assert.strictEqual(rowResizeBorderAtSplit(HH + ROW_HEIGHT, splitBarY, ROW_HEIGHT, 999, HH), 1);
	});

	test('bottom pane uses the DOM scroll shifted by the band offset (NOT the top scroll)', () => {
		resetRowSizing();
		const bandOffset = splitBarY - HH; // 200
		// botScroll = bandOffset => the bottom pane shows from row 0 (effScroll 0). Row 8's bottom edge (content
		// HH+216) lands at local HH+216, inside the bottom band. The top scroll (12345) must NOT affect this.
		assert.strictEqual(rowResizeBorderAtSplit(HH + 216, splitBarY, 12345, bandOffset, HH), 8);
		// A larger DOM scroll moves the border to a LATER row at the SAME local-Y -> proves botScroll is used.
		assert.strictEqual(rowResizeBorderAtSplit(HH + 216, splitBarY, 12345, bandOffset + ROW_HEIGHT, HH), 9);
	});

	test('resized rows shift the split border grab point', () => {
		setRowSizing(withOverride(rowModel(), 0, 60)); // row 0 tall (60) in the top pane
		// top pane, topScroll 0: row 0 now spans [HH, HH+60); its bottom edge at HH+60 -> resize row 0.
		assert.strictEqual(rowResizeBorderAtSplit(HH + 60, splitBarY, 0, 999, HH), 0);
		assert.strictEqual(rowResizeBorderAtSplit(HH + 30, splitBarY, 0, 999, HH), -1); // mid of the tall row 0
	});
});
