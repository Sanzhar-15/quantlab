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
	emptyAxisSizing,
	indexAtOffset,
	offsetBefore,
	sizeAt,
	totalExtent,
	withOverride,
} from '../src/quantbook/shared/axisSizing';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MIN_COL_WIDTH,
	MAX_COL_WIDTH,
	ROW_HEIGHT,
	cellContentRect,
	colResizeBorderAt,
	colX,
	computeVisibleBodyColRange,
	computeVisibleColRange,
	frozenColsWidth,
	getColSizing,
	hitTestContent,
	resetColSizing,
	setColSizing,
	totalContentWidth,
} from '../webview/sheets-webview/gridLayoutA1';

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
