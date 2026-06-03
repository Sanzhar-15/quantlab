/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b-4 (2026-06-03) -- pure blit + damage math for the Canvas2D sheets renderer.**
 *
 * FE-0b-2/3 paint the whole viewport every frame. FE-0b-4 adds two PARTIAL-redraw paths over that
 * proven full redraw:
 *   - **blit-scroll**: on a pure-axis scroll, the overlapping pixels of the previous frame are
 *     reused (a self-`drawImage` shifted by the scroll delta) and only the newly-exposed strip is
 *     repainted -- {@link computeScrollBlit} computes the copy rectangle (device px) + the strip(s)
 *     to repaint (CSS px).
 *   - **damage-clip**: on a commit, the new snapshot is diffed against the previous one
 *     ({@link diffSnapshots}) so only the changed rows repaint; {@link errorRowsFlipped} adds the
 *     rows whose error tint changed (errorCells lives outside the snapshot).
 *
 * These are OPTIMIZATIONS, never correctness crutches: every function returns `null` (or the empty
 * set) for any input the partial path cannot faithfully reproduce -- a size/dpr change, a diagonal
 * scroll, a shape change (rows added/removed/reordered) -- and the caller then takes the full
 * `draw()` path. That is selecting the correct algorithm for the input, not masking an error
 * (House No-Fallbacks): the renderer's debug guard verifies partial==full pixel-for-pixel.
 *
 * Pure: no `vscode`, no `document`/`window`, no canvas, no `this`. Browser-bundle-safe AND
 * mocha-importable -- the correctness-critical geometry + diff are golden-tested headlessly
 * (`test/quantbook-sheets-blit.test.ts`); the actual `drawImage`/`clip` calls are covered by the
 * behavioral smoke + the renderer's `DEBUG_BLIT_VERIFY` self-check.
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../../src/quantbook/types';
import { HEADER_HEIGHT, ROW_HEIGHT } from './gridLayout';

/** A single snapshot entry (row/col + value + optional rendered/formula/diagnostic). */
type Entry = QuantbookCellSnapshot['entries'][number];

/**
 * Minimum reusable region (DEVICE px) below which a blit is not worth the `drawImage` -- a full
 * redraw of the small visible window is just as cheap. Exported so the golden tests can sit clearly
 * above/below the threshold rather than guessing it.
 */
export const MIN_BLIT_PX = 64;

/** Extra CSS px repainted past a horizontal seam to cover the half-pixel column separator. */
const H_SEAM_PAD = 2;

/** The scroll/size state of a painted frame. CSS px except `dpr`. */
export interface ScrollState {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly cssW: number;
	readonly cssH: number;
	readonly dpr: number;
}

/** A source->dest copy rectangle for `ctx.drawImage` (DEVICE px; `sw===dw && sh===dh`, no scale). */
export interface BlitCopy {
	readonly sx: number;
	readonly sy: number;
	readonly sw: number;
	readonly sh: number;
	readonly dx: number;
	readonly dy: number;
	readonly dw: number;
	readonly dh: number;
}

/** A rectangle to repaint (CSS px -- the renderer clips to it under the dpr transform). */
export interface DamageRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** The result of a blittable scroll: copy the overlap, then repaint `damageRects`. */
export interface ScrollBlit {
	readonly copy: BlitCopy;
	readonly damageRects: readonly DamageRect[];
}

/** All scroll/size/dpr fields are finite, and size/dpr are strictly positive. */
function isFiniteScrollState(s: ScrollState): boolean {
	return (
		Number.isFinite(s.scrollTop) &&
		Number.isFinite(s.scrollLeft) &&
		Number.isFinite(s.cssW) && s.cssW > 0 &&
		Number.isFinite(s.cssH) && s.cssH > 0 &&
		Number.isFinite(s.dpr) && s.dpr > 0
	);
}

/**
 * Plan a blit for the scroll from `prev` to `next`, or return `null` if the caller must full-draw.
 *
 * `null` is returned (a legitimate precondition miss, NOT an error) when: there is no prior frame;
 * the dpr or viewport size changed (the backing store was cleared/resized); the scroll is DIAGONAL
 * (`dx!==0 && dy!==0` -- two self-blits in one frame compound the seam error); the move is zero or
 * sub-device-pixel; or the reusable region is `< MIN_BLIT_PX` (cheaper to just redraw).
 *
 * The header band `[0, HEADER_HEIGHT)` is STICKY: a vertical scroll shifts only the body sub-rect
 * `[HEADER_HEIGHT, cssH)` and leaves the header pixels in place (they are identical frame-to-frame),
 * so the returned `damageRects` never include the header. A horizontal scroll shifts the FULL height
 * (the header scrolls with its columns) and the strip is full height. All copy math is in device px
 * via `round(css*dpr)` -- identical to the renderer's `resize()` backing-store sizing -- and the CSS
 * damage strip is re-derived from the ROUNDED device delta so it exactly covers the sub-pixel
 * remainder a fractional `scrollTop`/`scrollLeft` leaves the integer blit unable to reproduce.
 */
export function computeScrollBlit(prev: ScrollState | null, next: ScrollState): ScrollBlit | null {
	if (prev === null) {
		return null;
	}
	// FE-0b-5 (Codex L5): fail closed on non-finite / non-positive inputs. A `NaN` scroll delta
	// would slip past the zero/diagonal checks (NaN comparisons are false) and yield a `NaN` copy
	// rect; real DOM inputs are finite, but the pure API must never emit a garbage blit.
	if (!isFiniteScrollState(prev) || !isFiniteScrollState(next)) {
		return null;
	}
	if (prev.dpr !== next.dpr) {
		return null; // dpr change -> backing store rescaled, pixels invalid
	}
	if (prev.cssW !== next.cssW || prev.cssH !== next.cssH) {
		return null; // resize -> resize() cleared the backing store
	}
	const dx = next.scrollLeft - prev.scrollLeft;
	const dy = next.scrollTop - prev.scrollTop;
	if (dx === 0 && dy === 0) {
		return null; // no movement
	}
	if (dx !== 0 && dy !== 0) {
		return null; // diagonal -> full draw
	}

	const dpr = next.dpr;
	const bw = Math.max(1, Math.round(next.cssW * dpr));
	const bh = Math.max(1, Math.round(next.cssH * dpr));
	const headerDev = Math.round(HEADER_HEIGHT * dpr);

	if (dy !== 0) {
		// Vertical: shift the body region [headerDev, bh) only; the sticky header is left in place.
		const bodyDevH = bh - headerDev;
		// FE-0b-5 (Codex H2): the blit copies an INTEGER device-px region; if |dy|*dpr is not a whole
		// device pixel the reused overlap would sit a sub-pixel off a true full redraw. Real scrollers
		// report device-pixel-snapped scrollTop (so |dy|*dpr is integral and the blit fires); a
		// fractional delta must FAIL CLOSED to the full-draw path rather than blit approximately.
		const dyDev = Math.abs(dy) * dpr;
		if (!Number.isInteger(dyDev) || dyDev <= 0) {
			return null; // sub-/non-integer-device-pixel move -> full draw
		}
		const reusable = bodyDevH - dyDev;
		if (reusable < MIN_BLIT_PX) {
			return null;
		}
		// Repaint the exposed strip + one ROW_HEIGHT of over-row on the leading edge so the seam
		// row's half-pixel bottom border is owned by exactly one paint (never half-copied).
		const stripH = dyDev / dpr + ROW_HEIGHT;
		if (dy > 0) {
			// Scrolling down: content moves up; new rows appear at the BOTTOM.
			return {
				copy: { sx: 0, sy: headerDev + dyDev, sw: bw, sh: reusable, dx: 0, dy: headerDev, dw: bw, dh: reusable },
				damageRects: [{ x: 0, y: next.cssH - stripH, width: next.cssW, height: stripH }],
			};
		}
		// Scrolling up: content moves down; new rows appear at the TOP (just below the header).
		return {
			copy: { sx: 0, sy: headerDev, sw: bw, sh: reusable, dx: 0, dy: headerDev + dyDev, dw: bw, dh: reusable },
			damageRects: [{ x: 0, y: HEADER_HEIGHT, width: next.cssW, height: stripH }],
		};
	}

	// Horizontal: shift the FULL height (header scrolls with its columns); strip is full height.
	// FE-0b-5 (Codex H2): integer device delta only (see the vertical branch) -- else full draw.
	const dxDev = Math.abs(dx) * dpr;
	if (!Number.isInteger(dxDev) || dxDev <= 0) {
		return null;
	}
	const reusable = bw - dxDev;
	if (reusable < MIN_BLIT_PX) {
		return null;
	}
	const stripW = dxDev / dpr + H_SEAM_PAD;
	if (dx > 0) {
		// Scrolling right: content moves left; new columns appear at the RIGHT.
		return {
			copy: { sx: dxDev, sy: 0, sw: reusable, sh: bh, dx: 0, dy: 0, dw: reusable, dh: bh },
			damageRects: [{ x: next.cssW - stripW, y: 0, width: stripW, height: next.cssH }],
		};
	}
	// Scrolling left: content moves right; new columns appear at the LEFT.
	return {
		copy: { sx: 0, sy: 0, sw: reusable, sh: bh, dx: dxDev, dy: 0, dw: reusable, dh: bh },
		damageRects: [{ x: 0, y: 0, width: stripW, height: next.cssH }],
	};
}

/** Equal iff two cell values render identically (kind + the kind's payload; `pending` has none). */
function valueEqual(a: QuantbookCellValue, b: QuantbookCellValue): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	// A `pending` value carries no `value` field (types.ts union). After this guard neither is
	// pending, so both carry a comparable `.value` (number | boolean | string).
	if (a.kind === 'pending' || b.kind === 'pending') {
		return a.kind === b.kind;
	}
	return a.value === b.value;
}

/** Equal iff two optional strings are both absent or both the same string. */
function optEqual(a: string | undefined, b: string | undefined): boolean {
	return a === b;
}

/** Equal iff two entries paint identically (everything {@link drawRow} reads). Coordinates excluded
 * (a coordinate change is a SHAPE change, handled by the caller as a full redraw). */
function entryVisualEqual(a: Entry, b: Entry): boolean {
	return (
		valueEqual(a.value, b.value) &&
		optEqual(a.rendered, b.rendered) &&
		optEqual(a.formula, b.formula) &&
		optEqual(a.diagnostic, b.diagnostic)
	);
}

/**
 * Indices of the entries whose PAINT changed between two snapshots, or `null` if the caller must
 * full-draw because the snapshot SHAPE changed (different entry count, or any index's row/col moved
 * -- the whole grid layout shifts). An empty array means "structurally identical, nothing changed"
 * (e.g. the host re-sending the same snapshot on a repeat `webviewReady`); the caller still gates on
 * the renderer's `hasPaintedOnce` because an identical snapshot against a freshly-zeroed (reloaded)
 * canvas must still full-draw.
 *
 * A DEEP field compare is mandatory: the host rebuilds the snapshot every render and it crosses the
 * `postMessage` structured-clone boundary, so object identity is always fresh and useless here.
 */
export function diffSnapshots(prev: QuantbookCellSnapshot | null, next: QuantbookCellSnapshot): number[] | null {
	if (prev === null) {
		return null;
	}
	const a = prev.entries;
	const b = next.entries;
	if (a.length !== b.length) {
		return null; // shape change (rows added/removed) -> every subsequent row shifts
	}
	const changed: number[] = [];
	for (let i = 0; i < b.length; i += 1) {
		const ea = a[i];
		const eb = b[i];
		if (Number(ea.row) !== Number(eb.row) || Number(ea.col) !== Number(eb.col)) {
			return null; // a row/col moved -> layout shift, full draw
		}
		if (!entryVisualEqual(ea, eb)) {
			changed.push(i);
		}
	}
	return changed;
}

/**
 * Entry indices whose error tint flipped between two `errorCells` key sets (keys are `"row,col"`,
 * matching {@link drawRow}'s lookup). A row gains/loses its error background+foreground without any
 * snapshot field changing, so these must be unioned into the damage set (notably: `applyRender`
 * CLEARS all error keys, which un-tints every previously-failed row). Keys not matching a current
 * entry are ignored (the cell is no longer present). Pure -> golden-testable.
 */
export function errorRowsFlipped(
	prevKeys: ReadonlySet<string>,
	nextKeys: ReadonlySet<string>,
	entries: readonly Entry[],
): number[] {
	const flipped = new Set<string>();
	for (const k of prevKeys) {
		if (!nextKeys.has(k)) {
			flipped.add(k);
		}
	}
	for (const k of nextKeys) {
		if (!prevKeys.has(k)) {
			flipped.add(k);
		}
	}
	if (flipped.size === 0) {
		return [];
	}
	const out: number[] = [];
	for (let i = 0; i < entries.length; i += 1) {
		if (flipped.has(Number(entries[i].row) + ',' + Number(entries[i].col))) {
			out.push(i);
		}
	}
	return out;
}
