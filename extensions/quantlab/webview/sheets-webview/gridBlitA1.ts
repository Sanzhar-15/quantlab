/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 Phase 3 (2026-06-04) -- pure blit + damage math for the A1 Canvas2D grid.**
 *
 * The A1 port of the FE-0b `gridBlit.ts` oracle (which was entry-index-keyed and assumed NO sticky
 * left gutter). FE-2-0 paints the whole visible window every frame ({@link CanvasGridRenderer.draw});
 * this module adds two PARTIAL-redraw paths over that proven full redraw:
 *   - **blit-scroll**: on a pure-axis scroll, the overlapping pixels of the previous frame are reused
 *     (a self-`drawImage` shifted by the scroll delta) and only the newly-exposed strip repaints --
 *     {@link computeScrollBlitA1} returns the device-px copy rect + the CSS-px strip(s) to repaint.
 *   - **damage-clip**: on a commit `render`, the new snapshot is diffed against the previous one
 *     ({@link diffSnapshotsA1}) so only the A1 ROWS whose paint changed repaint; {@link
 *     errorRowsFlippedA1} adds the rows whose error tint flipped (errorCells lives outside the snapshot).
 *
 * **A1-specific vs the FE-0b oracle:**
 *   1. **Sticky row-number gutter.** A HORIZONTAL scroll keeps `[0, gutterW)` in place (like the header
 *      keeps `[0, HEADER_HEIGHT)` on a vertical scroll), so the horizontal blit copies from
 *      `x = round(gutterW*dpr)` and the exposed strip starts at `gutterW` -- the gutter is never copied
 *      or damaged (it is repainted only by the rare full draw). A VERTICAL scroll shifts the full width
 *      (the gutter's row numbers scroll WITH their rows), exactly as in FE-0b.
 *   2. **Damage keyed by A1 `(row,col)`, returned as ROW indices.** The renderer paints the visible
 *      window by `(row,col)` lookup (not entry index), so the damage unit is the A1 row: cell `(r,c)`
 *      changed -> repaint row `r`'s band (`rowY(r)-scrollTop`). diff is by `(row,col)` string key, so a
 *      cell ADDED/REMOVED at an absolute coordinate damages exactly its row (no FE-0b "length change ->
 *      full draw" shape gate -- A1 coordinates are absolute, nothing shifts).
 *   3. **No `entryCount>0` blit gate.** The FE-0b H1 bug (an empty-sheet horizontal blit shifted a
 *      fixed-x placeholder) cannot occur: the A1 grid is uniform gridlines/bands at every scroll, so a
 *      blit is geometrically valid whether the sheet is empty or dense.
 *
 * These are OPTIMIZATIONS, never correctness crutches: every function returns `null` (or `[]`) for any
 * input the partial path cannot faithfully reproduce -- a size/dpr change, a diagonal scroll, a sheet
 * switch, a sub-device-pixel move -- and the caller then takes the full {@link CanvasGridRenderer.draw}
 * path. That is selecting the correct algorithm for the input, not masking an error (House
 * No-Fallbacks): the renderer's `DEBUG_BLIT_VERIFY` guard verifies partial==full pixel-for-pixel.
 *
 * Pure: no `vscode`, no `document`/`window`, no canvas, no `this`. Browser-bundle-safe AND
 * mocha-importable -- the correctness-critical geometry + diff are golden-tested headlessly
 * (`test/quantbook-sheets-blit-a1.test.ts`).
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../../src/quantbook/types';
import { isRenderableValue } from './cellRender';
import { HEADER_HEIGHT, ROW_HEIGHT, isInExtent } from './gridLayoutA1';

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
 * `gutterCssW` is the sticky row-gutter width (CSS px) -- used ONLY by the horizontal branch (the
 * gutter stays in place on a horizontal scroll); the vertical branch shifts the full width.
 *
 * `null` (a legitimate precondition miss, NOT an error) is returned when: there is no prior frame; the
 * dpr or viewport size changed (the backing store was cleared/resized); the scroll is DIAGONAL
 * (`dx!==0 && dy!==0` -- two self-blits in one frame compound the seam error); the move is zero or
 * sub-device-pixel; or the reusable region is `< MIN_BLIT_PX` (cheaper to just redraw).
 *
 * - **Vertical** (`dy!==0`): the header band `[0, HEADER_HEIGHT)` is STICKY, so only the body sub-rect
 *   `[HEADER_HEIGHT, cssH)` shifts (FULL width -- the gutter row numbers scroll with their rows). The
 *   damage strip is full-width at the exposed edge.
 * - **Horizontal** (`dx!==0`): the row gutter `[0, gutterW)` is STICKY, so only the body sub-rect
 *   `[gutterW, cssW)` shifts (FULL height -- the header column labels scroll with their columns). The
 *   damage strip is full-height at the exposed edge and starts at `gutterW` (never overwrites the gutter
 *   or corner).
 *
 * All copy math is in device px via `round(css*dpr)` -- identical to the renderer's `resize()`
 * backing-store sizing -- and the CSS damage strip is re-derived from the ROUNDED device delta so it
 * exactly covers the sub-pixel remainder a fractional `scrollTop`/`scrollLeft` leaves the integer blit
 * unable to reproduce.
 */
export function computeScrollBlitA1(
	prev: ScrollState | null,
	next: ScrollState,
	gutterCssW: number,
): ScrollBlit | null {
	if (prev === null) {
		return null;
	}
	// Fail closed on non-finite / non-positive inputs (FE-0b Codex L5). A `NaN` scroll delta would slip
	// past the zero/diagonal checks (NaN comparisons are false) and yield a `NaN` copy rect.
	if (!isFiniteScrollState(prev) || !isFiniteScrollState(next)) {
		return null;
	}
	if (!Number.isFinite(gutterCssW) || gutterCssW < 0) {
		return null; // a garbage gutter width would corrupt the horizontal copy origin
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

	if (dy !== 0) {
		// Vertical: shift the body region [headerDev, bh) only; the sticky header is left in place.
		const headerDev = Math.round(HEADER_HEIGHT * dpr);
		const bodyDevH = bh - headerDev;
		// **Phase 3 re-audit HIGH-1**: the renderer snaps each row's paint origin to a WHOLE CSS px
		// (`Math.round(rowY(r)-scrollTop)`), and rounding commutes with subtracting an INTEGER delta -- so a
		// uniform device-px blit matches a full redraw IFF `dy` is a whole CSS px. A fractional `dy` is
		// reachable at dpr 2 (a 0.5-CSS-px scroll snaps to 1 whole DEVICE px): the blit would shift 1 device
		// px while the rounded full draw moves 0 (`round(28-0.5)===round(28-0)===28`). So gate on the CSS-px
		// delta, NOT `|dy|*dpr` -- fail closed to the full draw (which handles fractional scroll via its own
		// rounding). At dpr 1 the two checks are identical; this only tightens dpr 2.
		if (!Number.isInteger(dy)) {
			return null;
		}
		const dyDev = Math.abs(dy) * dpr;
		// **Phase 3 re-audit #2 LOW**: also require an integer DEVICE-px shift. `resolveDpr()` clamps the
		// caller's dpr to {1,2} so an integer `dy` already yields an integer `dyDev` in production -- but
		// this pure helper must not ASSUME that; a non-integer dpr (e.g. 1.5) would make the copy rect
		// fractional. Belt-and-suspenders with the CSS-px gate above -> fail closed.
		if (!Number.isInteger(dyDev)) {
			return null;
		}
		const reusable = bodyDevH - dyDev;
		if (reusable < MIN_BLIT_PX) {
			return null;
		}
		// Repaint the exposed strip + one ROW_HEIGHT of over-row on the leading edge so the seam row's
		// half-pixel bottom border is owned by exactly one paint (never half-copied).
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

	// Horizontal: shift the body region [gutterDev, bw) only; the sticky gutter (and corner) stay in
	// place. FULL height (the header column labels scroll with their columns).
	// **Phase 3 re-audit HIGH-1**: gate on the integer CSS-px delta (see the vertical branch) -- the
	// renderer rounds each column's x origin in CSS px too, so a fractional `dx` (dpr 2) would diverge.
	if (!Number.isInteger(dx)) {
		return null;
	}
	// **Phase 3 re-audit HIGH-2**: the sticky-gutter boundary must land on a WHOLE device pixel, else
	// `round(gutterCssW*dpr)` would round the copy boundary INTO or out of the gutter (overlapping the
	// sticky region, or reading a gutter-edge pixel into the body). `gutterWidth()` returns an integer CSS
	// px today (ceil(...) + 2*GUTTER_PAD), so this never fires -- but the blit's correctness DEPENDS on it,
	// so guard explicitly (No-Fallbacks: assert the precondition, fail closed if a future change breaks it).
	if (!Number.isInteger(gutterCssW * dpr)) {
		return null;
	}
	const gutterDev = Math.round(gutterCssW * dpr);
	const bodyDevW = bw - gutterDev;
	const dxDev = Math.abs(dx) * dpr;
	// **Phase 3 re-audit #2 LOW**: also require an integer DEVICE-px shift (see the vertical branch) -- the
	// pure helper must not assume the caller's dpr is in {1,2}; a non-integer dpr -> fractional copy rect.
	if (!Number.isInteger(dxDev)) {
		return null;
	}
	const reusable = bodyDevW - dxDev;
	if (reusable < MIN_BLIT_PX) {
		return null;
	}
	const stripW = dxDev / dpr + H_SEAM_PAD;
	if (dx > 0) {
		// Scrolling right: body content moves left; new columns appear at the RIGHT edge.
		return {
			copy: { sx: gutterDev + dxDev, sy: 0, sw: reusable, sh: bh, dx: gutterDev, dy: 0, dw: reusable, dh: bh },
			damageRects: [{ x: next.cssW - stripW, y: 0, width: stripW, height: next.cssH }],
		};
	}
	// Scrolling left: body content moves right; new columns appear at the LEFT edge of the body (just
	// right of the sticky gutter -- the strip starts at gutterCssW, NOT 0).
	return {
		copy: { sx: gutterDev, sy: 0, sw: reusable, sh: bh, dx: gutterDev + dxDev, dy: 0, dw: reusable, dh: bh },
		damageRects: [{ x: gutterCssW, y: 0, width: stripW, height: next.cssH }],
	};
}

/** Equal iff two cell values render identically (kind + the kind's payload; `pending` has none). */
function valueEqual(a: QuantbookCellValue, b: QuantbookCellValue): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	// A `pending` value carries no `value` field (types.ts union). After this guard neither is pending,
	// so both carry a comparable `.value` (number | boolean | string).
	if (a.kind === 'pending' || b.kind === 'pending') {
		return a.kind === b.kind;
	}
	return a.value === b.value;
}

/** Equal iff two optional strings are both absent or both the same string. */
function optEqual(a: string | undefined, b: string | undefined): boolean {
	return a === b;
}

/** Equal iff two entries paint identically (everything {@link CanvasGridRenderer} reads for a cell).
 * Coordinates are excluded -- they are the diff KEY, not a painted field. */
function entryVisualEqual(a: Entry, b: Entry): boolean {
	return (
		valueEqual(a.value, b.value) &&
		optEqual(a.rendered, b.rendered) &&
		optEqual(a.formula, b.formula) &&
		optEqual(a.diagnostic, b.diagnostic)
	);
}

/** The renderer's `(row,col)` lookup key for an entry, or `null` if the entry is not renderable -- it
 * mirrors `canvasGrid.isRenderableEntry` FULLY (coordinate AND value), so the diff sees exactly the
 * painted set. An unrenderable entry paints nothing, so it can never contribute damage on its own. */
function cellKey(e: unknown): string | null {
	// **Phase 3 re-audit #2 MED**: mirror `canvasGrid.isRenderableEntry` EXACTLY, starting with the
	// null / non-object guard BEFORE reading any field. `isValidSnapshot` only checks `entries` is an
	// array, so an element can be `null` or a primitive (drift/tamper); reading `.row` off it would THROW
	// mid-diff. (The first re-audit fixed a malformed VALUE; this also covers a malformed ENTRY.)
	if (e === null || typeof e !== 'object') {
		return null;
	}
	const ent = e as { row?: unknown; col?: unknown; value?: unknown };
	const r = ent.row;
	const c = ent.col;
	if (typeof r !== 'number' || typeof c !== 'number' || !isInExtent(r, c)) {
		return null;
	}
	// Mirror the VALUE gate too: an unrenderable value paints nothing (setSnapshot skips it) and would
	// make `valueEqual` deref `.kind` and THROW. Treating it as absent makes a valid<->invalid transition
	// damage the row via the add/remove logic, and guarantees `valueEqual` only ever sees renderable values.
	if (!isRenderableValue(ent.value)) {
		return null;
	}
	return r + ',' + c;
}

/**
 * The A1 ROW indices whose paint changed between two snapshots, or `null` if the caller must full-draw.
 *
 * `null` is returned ONLY when there is no prior frame (`prev === null`) or the SHEET changed (a sheet
 * switch is an entirely different grid -- damaging every cell would be slower than a full draw and the
 * sticky title/meta change too). Otherwise -- because A1 coordinates are ABSOLUTE -- every difference is
 * localized: a changed cell damages its row; a cell ADDED in `next` (key absent in `prev`) damages its
 * row (now populated); a cell REMOVED (key absent in `next`) damages its row (now empty). An empty array
 * means "nothing painted changed" (e.g. a repeat snapshot on a `webviewReady`); the caller still gates
 * on the renderer's `painted` flag because an identical snapshot against a freshly-zeroed (reloaded)
 * canvas must still full-draw.
 *
 * A DEEP field compare is mandatory: the host rebuilds the snapshot every render and it crosses the
 * `postMessage` structured-clone boundary, so object identity is always fresh and useless here.
 */
export function diffSnapshotsA1(
	prev: QuantbookCellSnapshot | null,
	next: QuantbookCellSnapshot,
): number[] | null {
	if (prev === null) {
		return null;
	}
	if (prev.sheet !== next.sheet) {
		return null; // sheet switch -> full draw (different grid + sticky title/meta)
	}
	const prevByKey = new Map<string, Entry>();
	for (const e of prev.entries) {
		const k = cellKey(e);
		if (k !== null) {
			prevByKey.set(k, e);
		}
	}
	const damaged = new Set<number>();
	const seen = new Set<string>();
	for (const e of next.entries) {
		const k = cellKey(e);
		if (k === null) {
			continue; // unrenderable coord -> paints nothing, contributes no damage
		}
		seen.add(k);
		const pe = prevByKey.get(k);
		if (pe === undefined || !entryVisualEqual(pe, e)) {
			damaged.add(e.row); // added cell, or a changed paint
		}
	}
	for (const [k, pe] of prevByKey) {
		if (!seen.has(k)) {
			damaged.add(pe.row); // removed cell -> its row is now empty
		}
	}
	return [...damaged];
}

/**
 * The A1 ROW indices whose error tint flipped between two `errorCells` key sets (keys are `"row,col"`).
 * A row gains/loses its error background+foreground without any snapshot field changing, so these must
 * be unioned into the damage set. A key whose row is not a non-negative integer is ignored (defensive --
 * `errorCells` keys are minted from validated coordinates). Pure -> golden-testable.
 */
export function errorRowsFlippedA1(
	prevKeys: ReadonlySet<string>,
	nextKeys: ReadonlySet<string>,
): number[] {
	const rows = new Set<number>();
	const consider = (k: string): void => {
		const comma = k.indexOf(',');
		if (comma < 0) {
			return;
		}
		const r = Number(k.slice(0, comma));
		if (Number.isInteger(r) && r >= 0) {
			rows.add(r);
		}
	};
	for (const k of prevKeys) {
		if (!nextKeys.has(k)) {
			consider(k);
		}
	}
	for (const k of nextKeys) {
		if (!prevKeys.has(k)) {
			consider(k);
		}
	}
	return [...rows];
}
