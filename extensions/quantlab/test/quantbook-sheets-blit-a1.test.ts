/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-2-0 Phase 3 (2026-06-04) -- golden tests for the PURE blit + damage math of the A1 grid
 * (`webview/sheets-webview/gridBlitA1.ts`). The actual `drawImage`/`clip` calls need a real 2D context
 * (not available headlessly) and are covered by the behavioral smoke + the renderer's `DEBUG_BLIT_VERIFY`
 * self-check; these pin the correctness-critical geometry the partial-redraw paths depend on, with the
 * A1-specific behaviour the FE-0b oracle never had: the STICKY ROW GUTTER excluded from the horizontal
 * blit (copy origin at `gutterW`, exposed strip starting at `gutterW`), damage keyed by A1 ROW, and a
 * sheet switch forcing a full draw.
 */

import * as assert from 'assert';

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../src/quantbook/types';
import { COL_WIDTH, HEADER_HEIGHT, ROW_HEIGHT } from '../webview/sheets-webview/gridLayoutA1';
import {
	MIN_BLIT_PX,
	ScrollState,
	type ScrollBlit,
	computeScrollBlitA1 as computeScrollBlitA1Raw,
	diffSnapshotsA1,
	errorRowsFlippedA1,
	staleTintKeysA1,
} from '../webview/sheets-webview/gridBlitA1';

// --- fixtures ---

const GUTTER = 50; // a representative sticky row-gutter width (CSS px)

/**
 * **W3 frozen panes** -- the EXISTING golden tests below call the 3-arg form (no freeze). This wrapper
 * forwards to the W3 5-arg `computeScrollBlitA1` with `frozenRowsCssH = frozenColsCssW = 0`, so every one of
 * those assertions doubles as the "non-frozen == byte-identical to the pre-W3 blit" guarantee the brief
 * requires (the body origins reduce to `HEADER_HEIGHT` / `gutterCssW`). The new W3 suite below calls the raw
 * 5-arg form directly with non-zero frozen bands.
 */
function computeScrollBlitA1(prev: ScrollState | null, next: ScrollState, gutterCssW: number): ScrollBlit | null {
	return computeScrollBlitA1Raw(prev, next, gutterCssW, 0, 0);
}

function state(scrollTop: number, scrollLeft: number, cssW = 800, cssH = 600, dpr = 1): ScrollState {
	return { scrollTop, scrollLeft, cssW, cssH, dpr };
}

type Entry = QuantbookCellSnapshot['entries'][number];
function num(value: number): QuantbookCellValue {
	return { kind: 'number', value };
}
function entry(row: number, col: number, value: QuantbookCellValue, extra: Partial<Entry> = {}): Entry {
	return { row, col, value, ...extra };
}
function snap(entries: Entry[], sheet = 0): QuantbookCellSnapshot {
	return { snapshot_format_version: 1, sheet, entries };
}

suite('FE-2-0 Phase 3 computeScrollBlitA1 -- null (full-draw) preconditions', function () {
	test('no prior frame -> null', () => {
		assert.strictEqual(computeScrollBlitA1(null, state(100, 0), GUTTER), null);
	});
	test('dpr change -> null (backing store rescaled)', () => {
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 1), state(100, 0, 800, 600, 2), GUTTER), null);
	});
	test('viewport resize -> null (backing store cleared)', () => {
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600), state(100, 0, 800, 640), GUTTER), null);
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600), state(100, 0, 820, 600), GUTTER), null);
	});
	test('no movement -> null', () => {
		assert.strictEqual(computeScrollBlitA1(state(50, 50), state(50, 50), GUTTER), null);
	});
	test('diagonal scroll -> null (two self-blits compound the seam)', () => {
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(40, 40), GUTTER), null);
	});
	test('reusable region below MIN_BLIT_PX -> null', () => {
		// Vertical: bodyDevH = 600-28 = 572; a 560px move leaves 12px reusable (< 64).
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(560, 0), GUTTER), null);
	});
	test('non-integer DEVICE-pixel move -> null (fail closed)', () => {
		// dpr 2, dy 10.25 -> 20.5 device px: not a whole device pixel.
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 2), state(10.25, 0, 800, 600, 2), GUTTER), null);
	});
	test('non-finite scroll -> null', () => {
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(Number.NaN, 0), GUTTER), null);
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(0, Number.POSITIVE_INFINITY), GUTTER), null);
	});
	test('negative / non-finite gutter width -> null (would corrupt the horizontal copy origin)', () => {
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(0, 100), -1), null);
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(0, 100), Number.NaN), null);
	});
	test('re-audit #2 LOW: a non-integer dpr -> null (the pure helper does not assume resolveDpr {1,2})', () => {
		// dy=1 is a whole CSS px (passes the CSS gate) but dyDev = 1*1.5 = 1.5 -> a fractional device copy
		// rect; the re-added device-px integer check fails it closed. Same for the horizontal axis.
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 1.5), state(1, 0, 800, 600, 1.5), GUTTER), null);
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 1.5), state(0, 1, 800, 600, 1.5), GUTTER), null);
	});
});

suite('FE-2-0 Phase 3 computeScrollBlitA1 -- VERTICAL (sticky header, full width incl. gutter)', function () {
	test('scroll DOWN: copy the body region up, repaint the bottom strip', () => {
		const blit = computeScrollBlitA1(state(0, 0), state(100, 0), GUTTER);
		assert.notStrictEqual(blit, null);
		// bodyDevH = 600-28 = 572; reusable = 572-100 = 472.
		assert.deepStrictEqual(blit!.copy, { sx: 0, sy: 128, sw: 800, sh: 472, dx: 0, dy: 28, dw: 800, dh: 472 });
		// stripH = 100 + ROW_HEIGHT(25) = 125; bottom strip, FULL width (the gutter scrolls with rows).
		assert.deepStrictEqual(blit!.damageRects, [{ x: 0, y: 600 - 125, width: 800, height: 125 }]);
	});
	test('scroll UP: copy the body region down, repaint the top strip just below the header', () => {
		const blit = computeScrollBlitA1(state(100, 0), state(0, 0), GUTTER);
		assert.notStrictEqual(blit, null);
		assert.deepStrictEqual(blit!.copy, { sx: 0, sy: 28, sw: 800, sh: 472, dx: 0, dy: 128, dw: 800, dh: 472 });
		assert.deepStrictEqual(blit!.damageRects, [{ x: 0, y: HEADER_HEIGHT, width: 800, height: 125 }]);
	});
	test('the header band [0,HEADER_HEIGHT) is never copied or damaged (sticky)', () => {
		const blit = computeScrollBlitA1(state(0, 0), state(120, 0), GUTTER)!;
		assert.ok(blit.copy.dy >= HEADER_HEIGHT, 'copy dest starts at or below the header');
		assert.ok(blit.copy.sy >= HEADER_HEIGHT, 'copy source starts at or below the header');
	});
	test('HiDPI (dpr 2): device-px copy, CSS-px strip', () => {
		const blit = computeScrollBlitA1(state(0, 0, 800, 600, 2), state(50, 0, 800, 600, 2), GUTTER)!;
		// headerDev = 56; bodyDevH = 1200-56 = 1144; dyDev = 100; reusable = 1044.
		assert.deepStrictEqual(blit.copy, { sx: 0, sy: 156, sw: 1600, sh: 1044, dx: 0, dy: 56, dw: 1600, dh: 1044 });
		// stripH = 100/2 + 25 = 75 CSS px.
		assert.deepStrictEqual(blit.damageRects, [{ x: 0, y: 600 - 75, width: 800, height: 75 }]);
	});
	test('re-audit HIGH-1: a fractional CSS-px scroll at dpr 2 -> null (the renderer rounds CSS px)', () => {
		// dy 0.5 at dpr 2 is 1 WHOLE device px (the old |dy|*dpr guard accepted it), but the renderer rounds
		// each paint origin in whole CSS px -> a full draw would NOT move (round(28-0.5)===round(28-0)===28),
		// so the blit must fail closed. This is the bug Codex caught.
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 2), state(0.5, 0, 800, 600, 2), GUTTER), null);
		assert.strictEqual(computeScrollBlitA1(state(0.5, 0, 800, 600, 2), state(1, 0, 800, 600, 2), GUTTER), null);
		// An INTEGER CSS-px scroll at dpr 2 still blits (the tightening must not over-reject the valid case).
		assert.notStrictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 2), state(40, 0, 800, 600, 2), GUTTER), null);
	});
});

suite('FE-2-0 Phase 3 computeScrollBlitA1 -- HORIZONTAL (sticky gutter EXCLUDED, full height)', function () {
	test('scroll RIGHT: copy from gutterW, repaint the right strip', () => {
		const blit = computeScrollBlitA1(state(0, 0), state(0, 100), GUTTER);
		assert.notStrictEqual(blit, null);
		// bodyDevW = 800-50 = 750; reusable = 750-100 = 650. Copy SOURCE starts at gutterDev(50)+dxDev(100).
		assert.deepStrictEqual(blit!.copy, { sx: 150, sy: 0, sw: 650, sh: 600, dx: 50, dy: 0, dw: 650, dh: 600 });
		// stripW = 100 + 2 = 102; right strip, FULL height.
		assert.deepStrictEqual(blit!.damageRects, [{ x: 800 - 102, y: 0, width: 102, height: 600 }]);
	});
	test('scroll LEFT: the exposed strip starts at gutterW, NOT 0 (the A1 sticky-gutter difference)', () => {
		const blit = computeScrollBlitA1(state(0, 100), state(0, 0), GUTTER);
		assert.notStrictEqual(blit, null);
		assert.deepStrictEqual(blit!.copy, { sx: 50, sy: 0, sw: 650, sh: 600, dx: 150, dy: 0, dw: 650, dh: 600 });
		// The left strip must NOT cover the sticky gutter [0,50): it starts exactly at gutterW.
		assert.deepStrictEqual(blit!.damageRects, [{ x: GUTTER, y: 0, width: 102, height: 600 }]);
	});
	test('the gutter [0,gutterW) is never copied INTO (sticky): every copy dest x >= gutterDev', () => {
		for (const dx of [60, 120, 300]) {
			const blit = computeScrollBlitA1(state(0, 0), state(0, dx), GUTTER)!;
			assert.ok(blit.copy.dx >= 50, `right-scroll dx=${dx}: copy dest x ${blit.copy.dx} >= gutterDev`);
			assert.ok(blit.copy.sx >= 50, `right-scroll dx=${dx}: copy source x ${blit.copy.sx} >= gutterDev`);
			assert.ok(blit.damageRects[0].x >= 50, `right-scroll dx=${dx}: damage x >= gutterW`);
		}
		const left = computeScrollBlitA1(state(0, 200), state(0, 80), GUTTER)!;
		assert.ok(left.copy.dx >= 50 && left.copy.sx >= 50, 'left-scroll copy stays right of the gutter');
		assert.strictEqual(left.damageRects[0].x, GUTTER, 'left-scroll strip starts at the gutter edge');
	});
	test('reusable body width below MIN_BLIT_PX -> null (gutter eats into the budget)', () => {
		// bodyDevW = 800-50 = 750; a 700px move leaves 50px reusable (< 64).
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(0, 700), GUTTER), null);
	});
	test('re-audit HIGH-1: a fractional CSS-px horizontal scroll at dpr 2 -> null', () => {
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 2), state(0, 0.5, 800, 600, 2), GUTTER), null);
	});
	test('re-audit HIGH-2: a fractional gutter device width -> null (would round the copy boundary into the gutter)', () => {
		// gutterW 50.4 at dpr 1 -> round(50.4)=50 copy boundary overlaps the sticky gutter CSS [50,50.4).
		assert.strictEqual(computeScrollBlitA1(state(0, 0), state(0, 100), 50.4), null);
		// dpr 2, gutterW 50.25 -> *2 = 100.5 (non-integer device px) -> null.
		assert.strictEqual(computeScrollBlitA1(state(0, 0, 800, 600, 2), state(0, 100, 800, 600, 2), 50.25), null);
		// An integer gutter still blits (the guard must not over-reject the real case).
		assert.notStrictEqual(computeScrollBlitA1(state(0, 0), state(0, 100), 50), null);
	});
	test('MIN_BLIT_PX is the documented threshold (regression pin)', () => {
		assert.strictEqual(MIN_BLIT_PX, 64);
	});
});

suite('W3 frozen panes -- computeScrollBlitA1 frozen bands', function () {
	test('non-frozen (0,0) is byte-identical to the 3-arg wrapper across many scrolls', () => {
		const cases: [ScrollState, ScrollState][] = [
			[state(0, 0), state(100, 0)],
			[state(100, 0), state(0, 0)],
			[state(0, 0), state(0, 100)],
			[state(0, 100), state(0, 0)],
			[state(0, 0, 800, 600, 2), state(40, 0, 800, 600, 2)],
		];
		for (const [prev, next] of cases) {
			assert.deepStrictEqual(
				computeScrollBlitA1Raw(prev, next, GUTTER, 0, 0),
				computeScrollBlitA1(prev, next, GUTTER),
				`prev/next scroll ${JSON.stringify([prev.scrollTop, prev.scrollLeft, next.scrollTop, next.scrollLeft])}`,
			);
		}
	});
	test('VERTICAL scroll with 2 frozen ROWS: the body copy starts BELOW the frozen band, not the header', () => {
		// 2 frozen rows -> frozenRowsCssH = 2*ROW_HEIGHT = 50. bodyTop = HEADER_HEIGHT(28)+50 = 78.
		const frozenH = 2 * ROW_HEIGHT;
		const blit = computeScrollBlitA1Raw(state(0, 0), state(100, 0), GUTTER, frozenH, 0)!;
		assert.notStrictEqual(blit, null);
		const bodyTop = HEADER_HEIGHT + frozenH; // 78
		// bodyDevH = 600 - 78 = 522; reusable = 522 - 100 = 422.
		assert.deepStrictEqual(blit.copy, { sx: 0, sy: bodyTop + 100, sw: 800, sh: 422, dx: 0, dy: bodyTop, dw: 800, dh: 422 });
		// The frozen-row band [HEADER_HEIGHT, bodyTop) is NEVER copied or damaged (pinned, like the header).
		assert.ok(blit.copy.dy >= bodyTop, 'copy dest at/below the frozen band');
		assert.ok(blit.copy.sy >= bodyTop, 'copy source at/below the frozen band');
	});
	test('VERTICAL scroll UP with frozen rows: the exposed strip starts at the frozen-band edge', () => {
		const frozenH = 2 * ROW_HEIGHT; // 50
		const bodyTop = HEADER_HEIGHT + frozenH; // 78
		const blit = computeScrollBlitA1Raw(state(100, 0), state(0, 0), GUTTER, frozenH, 0)!;
		assert.strictEqual(blit.damageRects[0].y, bodyTop, 'top strip starts below the frozen rows, not at HEADER_HEIGHT');
	});
	test('HORIZONTAL scroll with 1 frozen COL: the body copy starts RIGHT of the gutter + frozen col', () => {
		const frozenW = 1 * COL_WIDTH; // 64
		const bodyLeft = GUTTER + frozenW; // 114
		const blit = computeScrollBlitA1Raw(state(0, 0), state(0, 100), GUTTER, 0, frozenW)!;
		// bodyDevW = 800 - 114 = 686; reusable = 686 - 100 = 586.
		assert.deepStrictEqual(blit.copy, { sx: bodyLeft + 100, sy: 0, sw: 586, sh: 600, dx: bodyLeft, dy: 0, dw: 586, dh: 600 });
		assert.ok(blit.copy.dx >= bodyLeft, 'copy dest right of the frozen-col band');
	});
	test('HORIZONTAL scroll LEFT with frozen cols: the exposed strip starts at the frozen-col-band edge', () => {
		const frozenW = 1 * COL_WIDTH; // 64
		const bodyLeft = GUTTER + frozenW; // 114
		const blit = computeScrollBlitA1Raw(state(0, 100), state(0, 0), GUTTER, 0, frozenW)!;
		assert.strictEqual(blit.damageRects[0].x, bodyLeft, 'left strip starts right of the frozen cols, not at gutterW');
	});
	test('a vertical scroll is unaffected by frozen COLS (frozen cols scroll with their rows on Y)', () => {
		// Frozen cols only affect the HORIZONTAL branch; a vertical scroll shifts the full width including them.
		const frozenW = 2 * COL_WIDTH;
		const withCols = computeScrollBlitA1Raw(state(0, 0), state(100, 0), GUTTER, 0, frozenW);
		const noCols = computeScrollBlitA1Raw(state(0, 0), state(100, 0), GUTTER, 0, 0);
		assert.deepStrictEqual(withCols, noCols, 'frozen cols do not change the vertical blit');
	});
	test('a horizontal scroll is unaffected by frozen ROWS', () => {
		const frozenH = 3 * ROW_HEIGHT;
		const withRows = computeScrollBlitA1Raw(state(0, 0), state(0, 100), GUTTER, frozenH, 0);
		const noRows = computeScrollBlitA1Raw(state(0, 0), state(0, 100), GUTTER, 0, 0);
		assert.deepStrictEqual(withRows, noRows, 'frozen rows do not change the horizontal blit');
	});
	test('a large frozen band that leaves < MIN_BLIT_PX reusable -> null (fail closed to full draw)', () => {
		// bodyDevH = 600 - (28 + frozenH); with a big frozen band + a moderate scroll the reusable region drops
		// below 64 -> null. frozenH = 500 -> bodyDevH = 72; a 20px scroll leaves 52 (< 64).
		assert.strictEqual(computeScrollBlitA1Raw(state(0, 0), state(20, 0), GUTTER, 500, 0), null);
	});
	test('a negative / non-finite frozen band -> null (would corrupt the body copy origin)', () => {
		assert.strictEqual(computeScrollBlitA1Raw(state(0, 0), state(100, 0), GUTTER, -1, 0), null);
		assert.strictEqual(computeScrollBlitA1Raw(state(0, 0), state(0, 100), GUTTER, 0, Number.NaN), null);
	});
	test('a fractional frozen-row device boundary -> null (dpr 2)', () => {
		// frozenRowsCssH = 0.25 at dpr 2 -> *2 = 0.5 (non-integer device px) -> fail closed. (Real counts are
		// integer * ROW_HEIGHT, so this only guards a future fractional ROW_HEIGHT.)
		assert.strictEqual(computeScrollBlitA1Raw(state(0, 0, 800, 600, 2), state(40, 0, 800, 600, 2), GUTTER, 0.25, 0), null);
	});
});

suite('FE-2-0 Phase 3 diffSnapshotsA1 -- damaged A1 rows (absolute coords, no shape gate)', function () {
	test('no prior snapshot -> null (must full-draw)', () => {
		assert.strictEqual(diffSnapshotsA1(null, snap([entry(0, 0, num(1))])), null);
	});
	test('sheet switch -> null (entirely different grid)', () => {
		const a = snap([entry(0, 0, num(1))], 0);
		const b = snap([entry(0, 0, num(1))], 1);
		assert.strictEqual(diffSnapshotsA1(a, b), null);
	});
	test('identical snapshot -> [] (nothing painted changed)', () => {
		const a = snap([entry(3, 4, num(7)), entry(10, 2, num(9))]);
		const b = snap([entry(3, 4, num(7)), entry(10, 2, num(9))]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), []);
	});
	test('a value change damages exactly that cell row', () => {
		const a = snap([entry(3, 4, num(7)), entry(10, 2, num(9))]);
		const b = snap([entry(3, 4, num(8)), entry(10, 2, num(9))]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), [3]);
	});
	test('an ADDED cell damages its row (no FE-0b length-change full draw -- coords are absolute)', () => {
		const a = snap([entry(3, 4, num(7))]);
		const b = snap([entry(3, 4, num(7)), entry(12, 0, num(1))]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), [12]);
	});
	test('a REMOVED cell damages its (now empty) row', () => {
		const a = snap([entry(3, 4, num(7)), entry(12, 0, num(1))]);
		const b = snap([entry(3, 4, num(7))]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), [12]);
	});
	test('two changed cells in the SAME row dedupe to one row index', () => {
		const a = snap([entry(5, 0, num(1)), entry(5, 1, num(2))]);
		const b = snap([entry(5, 0, num(9)), entry(5, 1, num(8))]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), [5]);
	});
	test('a rendered/formula/diagnostic change (same value) still damages the row', () => {
		const a = snap([entry(2, 2, num(5), { rendered: '5' })]);
		const b = snap([entry(2, 2, num(5), { rendered: '5.00' })]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), [2]);
		const c = snap([entry(2, 2, num(5), { formula: 'A1' })]);
		const d = snap([entry(2, 2, num(5), { formula: 'A2' })]);
		assert.deepStrictEqual(diffSnapshotsA1(c, d), [2]);
	});
	test('an off-extent / non-numeric coordinate paints nothing -> contributes no damage', () => {
		const a = snap([entry(3, 4, num(7))]);
		// A drifted entry at an out-of-extent row: skipped by the renderer, so no damage from it.
		const b = snap([entry(3, 4, num(7)), entry(9_999_999, 0, num(1))]);
		assert.deepStrictEqual(diffSnapshotsA1(a, b), []);
	});
	test('re-audit MED: a malformed-VALUE entry never crashes the diff (it paints nothing)', () => {
		// `isValidSnapshot` only checks `entries` is an array, so a drifted snapshot can carry a bad value;
		// the renderer skips it but `fullSnapshot` stores it -> a later diff must treat it as ABSENT and
		// NEVER dereference `.kind` on it (the crash Codex caught; Opus mis-rated as benign).
		const badNull = { row: 0, col: 0, value: null } as unknown as Entry;
		assert.doesNotThrow(() => diffSnapshotsA1(snap([badNull]), snap([badNull])));
		assert.deepStrictEqual(diffSnapshotsA1(snap([badNull]), snap([badNull])), []); // unrenderable in both
	});
	test('re-audit MED: a value going valid <-> invalid damages the row (cell appears/disappears)', () => {
		const valid = snap([entry(2, 1, num(5))]);
		const invalid = snap([{ row: 2, col: 1, value: { kind: 'bogus' } } as unknown as Entry]);
		assert.deepStrictEqual(diffSnapshotsA1(valid, invalid), [2]); // was painted, now skipped -> repaint empty
		assert.deepStrictEqual(diffSnapshotsA1(invalid, valid), [2]); // was empty, now painted
	});
	test('re-audit #2 MED: a null / primitive ENTRY never crashes the diff (mirrors isRenderableEntry)', () => {
		// `isValidSnapshot` only checks `entries` is an array, so an element can be null or a primitive.
		// `cellKey` must reject non-objects BEFORE reading `.row` (the crash Codex caught on re-audit).
		const nul = null as unknown as Entry;
		const prim = 42 as unknown as Entry;
		assert.doesNotThrow(() => diffSnapshotsA1(snap([nul]), snap([nul])));
		assert.deepStrictEqual(diffSnapshotsA1(snap([nul]), snap([nul])), []);
		assert.doesNotThrow(() => diffSnapshotsA1(snap([prim]), snap([entry(0, 0, num(1))])));
		// valid -> non-object damages the (now empty) row; non-object -> valid damages it too.
		assert.deepStrictEqual(diffSnapshotsA1(snap([entry(2, 1, num(5))]), snap([nul])), [2]);
		assert.deepStrictEqual(diffSnapshotsA1(snap([nul]), snap([entry(2, 1, num(5))])), [2]);
	});
});

suite('FE-2-0 Phase 3 errorRowsFlippedA1 -- damaged rows from error-tint flips', function () {
	test('a newly-errored cell damages its row', () => {
		assert.deepStrictEqual(errorRowsFlippedA1(new Set(), new Set(['4,2'])), [4]);
	});
	test('a cleared error damages its (now un-tinted) row', () => {
		assert.deepStrictEqual(errorRowsFlippedA1(new Set(['4,2']), new Set()), [4]);
	});
	test('an unchanged error set flips nothing -> [] (re-error of the same cell is a no-op repaint)', () => {
		assert.deepStrictEqual(errorRowsFlippedA1(new Set(['4,2']), new Set(['4,2'])), []);
	});
	test('multiple flips on the same row dedupe', () => {
		const flipped = errorRowsFlippedA1(new Set(), new Set(['7,0', '7,3']));
		assert.deepStrictEqual(flipped, [7]);
	});
	test('flips across rows return each row once', () => {
		const flipped = errorRowsFlippedA1(new Set(['1,0']), new Set(['1,0', '5,0', '8,2'])).sort((a, b) => a - b);
		assert.deepStrictEqual(flipped, [5, 8]);
	});
	test('a malformed key (no comma / non-integer row) is ignored', () => {
		assert.deepStrictEqual(errorRowsFlippedA1(new Set(), new Set(['nonsense'])), []);
		assert.deepStrictEqual(errorRowsFlippedA1(new Set(), new Set(['x,2'])), []);
	});
});

// --- staleTintKeysA1 (FE-2-0 polish 2026-06-05: clear a stale tint when a cell is fixed elsewhere) ---

suite('FE-2-0 polish staleTintKeysA1 -- clear a stale error tint on a real content change', function () {
	test('no prior frame -> [] (nothing to compare)', () => {
		assert.deepStrictEqual(staleTintKeysA1(null, snap([entry(0, 0, num(1))]), ['0,0']), []);
	});
	test('sheet switch -> [] (caller clears errorCells wholesale)', () => {
		const prev = snap([entry(0, 0, num(1))], 0);
		const next = snap([entry(0, 0, num(9))], 1);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), []);
	});
	test('a tinted cell whose value CHANGED between renders -> returned (a real write landed)', () => {
		// A1 was tinted from a rejected edit (never stored); a sibling then wrote a new value to A1.
		const prev = snap([entry(0, 0, num(1))]);
		const next = snap([entry(0, 0, num(2))]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), ['0,0']);
	});
	test('a tinted cell whose content is UNCHANGED -> not returned (rejected edit was never stored)', () => {
		// The classic errorReply case: the bad edit was rejected, so A1 still shows its prior value.
		const same = [entry(0, 0, num(1))];
		assert.deepStrictEqual(staleTintKeysA1(snap(same), snap([entry(0, 0, num(1))]), ['0,0']), []);
	});
	test('presence flip (cell added) -> returned; (cell removed) -> returned', () => {
		assert.deepStrictEqual(staleTintKeysA1(snap([]), snap([entry(0, 0, num(5))]), ['0,0']), ['0,0']);
		assert.deepStrictEqual(staleTintKeysA1(snap([entry(0, 0, num(5))]), snap([]), ['0,0']), ['0,0']);
	});
	test('the open-editor cell IS cleared when a sibling fixes it (audit MED-A: no permanent tint)', () => {
		// A1 has the open editor + is tinted; a sibling changed A1's stored value. It must STILL be returned
		// (the editor covers it; on close the untinted sibling value shows) -- exempting it left a permanent tint.
		const prev = snap([entry(0, 0, num(1)), entry(1, 0, num(1))]);
		const next = snap([entry(0, 0, num(2)), entry(1, 0, num(2))]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0', '1,0']), ['0,0', '1,0']);
	});
	test('only the CHANGED tinted cells are returned (an unrelated sibling change does not clear others)', () => {
		// A1 tinted + unchanged; B1 changed (a sibling fixed B1). A1 keeps its tint; only B1 clears.
		const prev = snap([entry(0, 0, num(1)), entry(0, 1, num(1))]);
		const next = snap([entry(0, 0, num(1)), entry(0, 1, num(9))]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0', '0,1']), ['0,1']);
	});
	test('a FORMULA change with the same displayed value -> returned (a real write landed)', () => {
		// cellContentEqual compares formula text too, so re-pointing a formula (even to the same value) is a
		// real edit -> the tint should clear. (Audit fix: the prior fixture used an identical formula.)
		const prev = snap([entry(0, 0, num(3), { formula: 'A2+1', rendered: '3' })]);
		const next = snap([entry(0, 0, num(3), { formula: 'A3+2', rendered: '3' })]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), ['0,0']);
	});
	test('an identical entry (same value/formula) -> not returned (no write landed)', () => {
		const e = { formula: 'A2+1', rendered: '3' };
		const prev = snap([entry(0, 0, num(3), e)]);
		const next = snap([entry(0, 0, num(3), { ...e })]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), []);
	});
	test('a DIAGNOSTIC-only change (same value+formula) -> NOT returned (megaudit MED: not a write)', () => {
		// `diagnostic` is attached host-side from the event ring and can change with no cell write -- it must
		// NOT clear the error tint. staleTintKeysA1 uses cellContentEqual (value+formula), not entryVisualEqual.
		const prev = snap([entry(0, 0, num(3), { diagnostic: undefined })]);
		const next = snap([entry(0, 0, num(3), { diagnostic: '#CALC! recompute touched it' })]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), []);
	});
	test('a RENDERED-only change (same value+formula) -> NOT returned (display projection, not a write)', () => {
		const prev = snap([entry(0, 0, num(3), { rendered: '3' })]);
		const next = snap([entry(0, 0, num(3), { rendered: '3.00' })]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), []);
	});
	test('a malformed entry in prev/next does not throw (cellKey guards it, like diffSnapshotsA1)', () => {
		const prev = snap([null as unknown as Entry, entry(0, 0, num(1))]);
		const next = snap([entry(0, 0, num(2)), 'garbage' as unknown as Entry]);
		assert.deepStrictEqual(staleTintKeysA1(prev, next, ['0,0']), ['0,0']);
	});
});
