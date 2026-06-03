/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-0b-4 (2026-06-03) -- golden tests for the PURE blit + damage math
 * (`webview/sheets-webview/gridBlit.ts`). The actual `drawImage`/`clip` calls need a real 2D
 * context (not available headlessly) and are covered by the behavioral smoke + the renderer's
 * `DEBUG_BLIT_VERIFY` self-check; these pin the correctness-critical geometry the partial-redraw
 * paths depend on: the blit copy rectangle + exposed strip(s), the sticky-header band, device-px
 * rounding under HiDPI + fractional scroll, the snapshot field-diff, and the error-tint flip set.
 */

import * as assert from 'assert';

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../src/quantbook/types';
import { HEADER_HEIGHT, ROW_HEIGHT } from '../webview/sheets-webview/gridLayout';
import {
	MIN_BLIT_PX,
	ScrollState,
	computeScrollBlit,
	diffSnapshots,
	errorRowsFlipped,
} from '../webview/sheets-webview/gridBlit';

// --- fixtures ---

function state(scrollTop: number, scrollLeft: number, cssW = 664, cssH = 600, dpr = 1): ScrollState {
	return { scrollTop, scrollLeft, cssW, cssH, dpr };
}

type Entry = QuantbookCellSnapshot['entries'][number];
function num(value: number): QuantbookCellValue {
	return { kind: 'number', value };
}
function entry(row: number, col: number, value: QuantbookCellValue, extra: Partial<Entry> = {}): Entry {
	return { row, col, value, ...extra };
}
function snap(entries: Entry[]): QuantbookCellSnapshot {
	return { snapshot_format_version: 1, sheet: 0, entries };
}

suite('FE-0b-4 computeScrollBlit -- null (full-draw) preconditions', function () {
	test('no prior frame -> null', () => {
		assert.strictEqual(computeScrollBlit(null, state(100, 0)), null);
	});
	test('dpr change -> null (backing store rescaled)', () => {
		assert.strictEqual(computeScrollBlit(state(0, 0, 664, 600, 1), state(100, 0, 664, 600, 2)), null);
	});
	test('viewport size change -> null (backing store cleared by resize)', () => {
		assert.strictEqual(computeScrollBlit(state(0, 0, 664, 600), state(100, 0, 800, 600)), null);
		assert.strictEqual(computeScrollBlit(state(0, 0, 664, 600), state(100, 0, 664, 700)), null);
	});
	test('zero movement -> null', () => {
		assert.strictEqual(computeScrollBlit(state(50, 50), state(50, 50)), null);
	});
	test('diagonal scroll -> null (no compounded two-axis self-blit)', () => {
		assert.strictEqual(computeScrollBlit(state(0, 0), state(100, 100)), null);
	});
	test('reusable region below MIN_BLIT_PX -> null', () => {
		// cssH 100 -> bodyDevH 72; dy 20 -> reusable 52 < 64.
		assert.strictEqual(computeScrollBlit(state(0, 0, 664, 100), state(20, 0, 664, 100)), null);
		// A near-full-viewport jump leaves almost nothing reusable.
		assert.strictEqual(computeScrollBlit(state(0, 0), state(560, 0)), null);
	});
	test('sub-device-pixel move -> null', () => {
		// dpr 1, dy 0.3 -> round(0.3) = 0 device px.
		assert.strictEqual(computeScrollBlit(state(0, 0), state(0.3, 0)), null);
	});
});

suite('FE-0b-4 computeScrollBlit -- vertical (sticky header, body-only blit)', function () {
	test('scroll DOWN by 100 (dpr 1): body copy + bottom strip', () => {
		const blit = computeScrollBlit(state(0, 0), state(100, 0));
		assert.ok(blit !== null);
		// Copy: source is the body shifted up by dy; dest starts at the header boundary.
		assert.deepStrictEqual(blit!.copy, {
			sx: 0, sy: HEADER_HEIGHT + 100, sw: 664, sh: 600 - HEADER_HEIGHT - 100,
			dx: 0, dy: HEADER_HEIGHT, dw: 664, dh: 600 - HEADER_HEIGHT - 100,
		});
		assert.strictEqual(blit!.copy.sw, blit!.copy.dw, 'no horizontal scale');
		assert.strictEqual(blit!.copy.sh, blit!.copy.dh, 'no vertical scale');
		// Strip: the newly-exposed bottom + one over-row for the seam.
		assert.deepStrictEqual(blit!.damageRects, [
			{ x: 0, y: 600 - (100 + ROW_HEIGHT), width: 664, height: 100 + ROW_HEIGHT },
		]);
		// The blit never touches the sticky header band.
		assert.ok(blit!.copy.sy >= HEADER_HEIGHT && blit!.copy.dy >= HEADER_HEIGHT);
		assert.ok(blit!.damageRects[0].y >= HEADER_HEIGHT);
	});
	test('scroll UP by 100 (dpr 1): body copy + top strip', () => {
		const blit = computeScrollBlit(state(100, 0), state(0, 0));
		assert.ok(blit !== null);
		assert.deepStrictEqual(blit!.copy, {
			sx: 0, sy: HEADER_HEIGHT, sw: 664, sh: 600 - HEADER_HEIGHT - 100,
			dx: 0, dy: HEADER_HEIGHT + 100, dw: 664, dh: 600 - HEADER_HEIGHT - 100,
		});
		assert.deepStrictEqual(blit!.damageRects, [
			{ x: 0, y: HEADER_HEIGHT, width: 664, height: 100 + ROW_HEIGHT },
		]);
	});
	test('HiDPI dpr 2: copy is integer device px with no scale; strip stays CSS px', () => {
		const blit = computeScrollBlit(state(0, 0, 664, 600, 2), state(50, 0, 664, 600, 2));
		assert.ok(blit !== null);
		const headerDev = Math.round(HEADER_HEIGHT * 2); // 56
		const dyDev = 100; // round(50*2)
		const reusable = 600 * 2 - headerDev - dyDev; // 1200 - 56 - 100
		assert.deepStrictEqual(blit!.copy, {
			sx: 0, sy: headerDev + dyDev, sw: 1328, sh: reusable,
			dx: 0, dy: headerDev, dw: 1328, dh: reusable,
		});
		assert.strictEqual(blit!.copy.sw, blit!.copy.dw);
		assert.strictEqual(blit!.copy.sh, blit!.copy.dh);
		for (const k of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh'] as const) {
			assert.ok(Number.isInteger(blit!.copy[k]), `copy.${k} must be an integer device px`);
		}
		// Strip CSS height = dyDev/dpr + ROW_HEIGHT = 50 + 25.
		assert.deepStrictEqual(blit!.damageRects, [
			{ x: 0, y: 600 - (50 + ROW_HEIGHT), width: 664, height: 50 + ROW_HEIGHT },
		]);
	});
	test('FE-0b-5 (Codex H2): a non-integer device delta fails closed to null (full draw)', () => {
		// dpr 1: 100.3 CSS = 100.3 device px (not a whole pixel) -> the integer self-blit would sit
		// 0.3px off a full redraw, so it must return null. (Real scrollers device-snap scrollTop; this
		// synthetic delta exercises the fail-closed guard.)
		assert.strictEqual(computeScrollBlit(state(0, 0), state(100.3, 0)), null);
	});
	test('FE-0b-5: a fractional CSS delta that IS a whole device px (HiDPI snap) still blits', () => {
		// dpr 2: scrollTop 50.5 CSS = 101 device px (whole) -- the real device-pixel-snapped HiDPI case.
		const blit = computeScrollBlit(state(0, 0, 664, 600, 2), state(50.5, 0, 664, 600, 2));
		assert.ok(blit !== null);
		for (const k of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh'] as const) {
			assert.ok(Number.isInteger(blit!.copy[k]), `copy.${k} must be an integer device px`);
		}
		// dyDev = 50.5*2 = 101; sy = round(HEADER_HEIGHT*2) + 101.
		assert.strictEqual(blit!.copy.sy, Math.round(HEADER_HEIGHT * 2) + 101);
	});
	test('FE-0b-5 (Codex L5): a non-finite scroll field fails closed to null', () => {
		assert.strictEqual(computeScrollBlit(state(0, 0), state(Number.NaN, 0)), null);
		assert.strictEqual(computeScrollBlit(state(0, 0), state(0, Number.POSITIVE_INFINITY)), null);
		assert.strictEqual(computeScrollBlit(state(0, 0, 664, 600, Number.NaN), state(100, 0)), null);
		assert.strictEqual(computeScrollBlit(state(0, 0, 0, 600), state(100, 0, 0, 600)), null); // cssW <= 0
	});
	test('blit boundary at exactly MIN_BLIT_PX (>= blits, below is null)', () => {
		// dpr 1, cssH 200 -> body device height = 200 - HEADER_HEIGHT.
		const bodyDev = 200 - HEADER_HEIGHT;
		// reusable == MIN_BLIT_PX -> blit (dy leaves exactly the threshold of reusable px).
		const atThreshold = computeScrollBlit(state(0, 0, 664, 200), state(bodyDev - MIN_BLIT_PX, 0, 664, 200));
		assert.ok(atThreshold !== null, 'reusable == MIN_BLIT_PX should blit');
		// reusable == MIN_BLIT_PX - 1 -> null (not worth the drawImage).
		const below = computeScrollBlit(state(0, 0, 664, 200), state(bodyDev - MIN_BLIT_PX + 1, 0, 664, 200));
		assert.strictEqual(below, null, 'reusable == MIN_BLIT_PX-1 should not blit');
	});
});

suite('FE-0b-4 computeScrollBlit -- horizontal (full height, header scrolls with columns)', function () {
	test('scroll RIGHT by 100: full-height copy + right strip', () => {
		const blit = computeScrollBlit(state(0, 0), state(0, 100));
		assert.ok(blit !== null);
		const reusable = 664 - 100;
		assert.deepStrictEqual(blit!.copy, {
			sx: 100, sy: 0, sw: reusable, sh: 600, dx: 0, dy: 0, dw: reusable, dh: 600,
		});
		// Strip is FULL height (header scrolls horizontally) + a small seam pad.
		assert.strictEqual(blit!.damageRects.length, 1);
		assert.strictEqual(blit!.damageRects[0].y, 0);
		assert.strictEqual(blit!.damageRects[0].height, 600);
		assert.strictEqual(blit!.damageRects[0].x, 664 - (100 + 2));
		assert.strictEqual(blit!.damageRects[0].width, 100 + 2);
	});
	test('scroll LEFT by 100: full-height copy + left strip', () => {
		const blit = computeScrollBlit(state(0, 100), state(0, 0));
		assert.ok(blit !== null);
		const reusable = 664 - 100;
		assert.deepStrictEqual(blit!.copy, {
			sx: 0, sy: 0, sw: reusable, sh: 600, dx: 100, dy: 0, dw: reusable, dh: 600,
		});
		assert.deepStrictEqual(blit!.damageRects, [{ x: 0, y: 0, width: 100 + 2, height: 600 }]);
	});
	test('FE-0b-5 (Codex H2): a non-integer horizontal device delta fails closed to null', () => {
		// dpr 1: scrollLeft 0 -> 80.4 = 80.4 device px (not whole) -> null.
		assert.strictEqual(computeScrollBlit(state(0, 0), state(0, 80.4)), null);
	});
});

suite('FE-0b-4 diffSnapshots -- shape change forces full draw (null)', function () {
	const base = snap([entry(0, 0, num(1)), entry(0, 1, num(2))]);
	test('no prior snapshot -> null', () => {
		assert.strictEqual(diffSnapshots(null, base), null);
	});
	test('entry count differs -> null', () => {
		assert.strictEqual(diffSnapshots(base, snap([entry(0, 0, num(1))])), null);
	});
	test('a row coordinate moved -> null', () => {
		assert.strictEqual(diffSnapshots(base, snap([entry(5, 0, num(1)), entry(0, 1, num(2))])), null);
	});
	test('a col coordinate moved -> null', () => {
		assert.strictEqual(diffSnapshots(base, snap([entry(0, 0, num(1)), entry(0, 9, num(2))])), null);
	});
});

suite('FE-0b-4 diffSnapshots -- field changes (damage indices)', function () {
	const base = snap([entry(0, 0, num(1)), entry(0, 1, num(2)), entry(0, 2, num(3))]);
	test('structurally identical -> [] (e.g. re-handshake re-send)', () => {
		const same = snap([entry(0, 0, num(1)), entry(0, 1, num(2)), entry(0, 2, num(3))]);
		assert.deepStrictEqual(diffSnapshots(base, same), []);
	});
	test('value.value change -> that index', () => {
		const next = snap([entry(0, 0, num(1)), entry(0, 1, num(99)), entry(0, 2, num(3))]);
		assert.deepStrictEqual(diffSnapshots(base, next), [1]);
	});
	test('value.kind change (number -> error) -> that index', () => {
		const next = snap([entry(0, 0, { kind: 'error', value: '#DIV/0!' }), entry(0, 1, num(2)), entry(0, 2, num(3))]);
		assert.deepStrictEqual(diffSnapshots(base, next), [0]);
	});
	test('pending -> number does not throw (pending has no .value)', () => {
		const prev = snap([entry(0, 0, { kind: 'pending' })]);
		const next = snap([entry(0, 0, num(7))]);
		assert.deepStrictEqual(diffSnapshots(prev, next), [0]);
		// And the reverse, plus pending===pending is unchanged.
		assert.deepStrictEqual(diffSnapshots(next, prev), [0]);
		assert.deepStrictEqual(diffSnapshots(prev, snap([entry(0, 0, { kind: 'pending' })])), []);
	});
	test('rendered string change -> that index', () => {
		const prev = snap([entry(0, 0, num(1), { rendered: '1.00' })]);
		const next = snap([entry(0, 0, num(1), { rendered: '$1.00' })]);
		assert.deepStrictEqual(diffSnapshots(prev, next), [0]);
	});
	test('rendered present -> absent -> that index', () => {
		const prev = snap([entry(0, 0, num(1), { rendered: '1.00' })]);
		const next = snap([entry(0, 0, num(1))]);
		assert.deepStrictEqual(diffSnapshots(prev, next), [0]);
	});
	test('formula change -> that index', () => {
		const prev = snap([entry(0, 0, num(3), { formula: 'A1+A2' })]);
		const next = snap([entry(0, 0, num(3), { formula: 'A1+A2+1' })]);
		assert.deepStrictEqual(diffSnapshots(prev, next), [0]);
	});
	test('diagnostic change -> that index', () => {
		const prev = snap([entry(0, 0, { kind: 'error', value: '#CALC!' })]);
		const next = snap([entry(0, 0, { kind: 'error', value: '#CALC!' }, { diagnostic: 'cycle detected' })]);
		assert.deepStrictEqual(diffSnapshots(prev, next), [0]);
	});
	test('multiple scattered changes -> sorted ascending', () => {
		const next = snap([entry(0, 0, num(11)), entry(0, 1, num(2)), entry(0, 2, num(33))]);
		assert.deepStrictEqual(diffSnapshots(base, next), [0, 2]);
	});
});

suite('FE-0b-4 errorRowsFlipped', function () {
	const entries = [entry(0, 0, num(1)), entry(3, 7, num(2)), entry(5, 2, num(3))];
	test('a newly-added error key -> its entry index', () => {
		assert.deepStrictEqual(errorRowsFlipped(new Set(), new Set(['3,7']), entries), [1]);
	});
	test('a removed error key (cleared) -> its entry index', () => {
		assert.deepStrictEqual(errorRowsFlipped(new Set(['5,2']), new Set(), entries), [2]);
	});
	test('a key not matching any current entry is ignored', () => {
		assert.deepStrictEqual(errorRowsFlipped(new Set(['9,9']), new Set(), entries), []);
	});
	test('no change -> []', () => {
		assert.deepStrictEqual(errorRowsFlipped(new Set(['3,7']), new Set(['3,7']), entries), []);
	});
	test('add + remove together -> both indices (sorted)', () => {
		assert.deepStrictEqual(errorRowsFlipped(new Set(['0,0']), new Set(['5,2']), entries), [0, 2]);
	});
});
