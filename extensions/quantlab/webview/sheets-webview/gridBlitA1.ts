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
 * **W3 frozen panes (2026-06-09)**: `frozenRowsCssH` (= `frozenRowCount * ROW_HEIGHT`) and
 * `frozenColsCssW` (= `frozenColCount * COL_WIDTH`) are the pinned-band sizes (CSS px). The body that
 * SCROLLS starts past them: vertically at `HEADER_HEIGHT + frozenRowsCssH`, horizontally at `gutterCssW +
 * frozenColsCssW`. The frozen-row band (vertical scroll) and frozen-col band (horizontal scroll) are
 * EXCLUDED from the copy and stay put from the previous frame -- exactly like the header/gutter (their
 * content is pinned, so a pure scroll never changes them). The OTHER frozen band scrolls WITH the body on
 * that axis (frozen cols scroll vertically; frozen rows scroll horizontally), so it is inside the shifted
 * body rect -- matching how the gutter row numbers / header column letters already scroll with their
 * rows/cols. With both frozen sizes 0 this is byte-identical to the pre-W3 blit (the brief's
 * "non-frozen == identical" requirement): the body origins reduce to `HEADER_HEIGHT` / `gutterCssW`.
 *
 * `null` (a legitimate precondition miss, NOT an error) is returned when: there is no prior frame; the
 * dpr or viewport size changed (the backing store was cleared/resized); the scroll is DIAGONAL
 * (`dx!==0 && dy!==0` -- two self-blits in one frame compound the seam error); the move is zero or
 * sub-device-pixel; or the reusable region is `< MIN_BLIT_PX` (cheaper to just redraw).
 *
 * - **Vertical** (`dy!==0`): the header band + frozen-row band `[0, HEADER_HEIGHT + frozenRowsCssH)` are
 *   PINNED, so only the body sub-rect `[bodyTop, cssH)` shifts (FULL width -- the gutter row numbers AND
 *   the frozen COLUMNS scroll with their rows). The damage strip is full-width at the exposed edge.
 * - **Horizontal** (`dx!==0`): the row gutter + frozen-col band `[0, gutterW + frozenColsCssW)` are
 *   PINNED, so only the body sub-rect `[bodyLeft, cssW)` shifts (FULL height). The damage strip is
 *   full-height at the exposed edge and starts at `bodyLeft` (never overwrites the gutter/frozen cols).
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
	frozenRowsCssH: number,
	frozenColsCssW: number,
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
	// W3 frozen panes: a garbage frozen-band size would corrupt the body copy origin -> fail closed.
	if (!Number.isFinite(frozenRowsCssH) || frozenRowsCssH < 0 || !Number.isFinite(frozenColsCssW) || frozenColsCssW < 0) {
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

	if (dy !== 0) {
		// Vertical: shift the body region [bodyTopDev, bh) only; the header + frozen-row band are pinned.
		// W3: `frozenRowCount * ROW_HEIGHT` rows below the header stay put (their cells don't scroll), so the
		// scrolling body begins at `HEADER_HEIGHT + frozenRowsCssH`. The frozen-row band [headerDev, bodyTopDev)
		// is neither copied nor damaged -- it is preserved from the previous frame, exactly like the header.
		const headerDev = Math.round(HEADER_HEIGHT * dpr);
		// W3: the frozen-row band must land on a WHOLE device pixel so the copy boundary never rounds INTO it
		// (overlapping the pinned region) or out of it (reading a frozen-edge pixel into the body). `frozenRowsCssH`
		// is `frozenRowCount * ROW_HEIGHT` (integer CSS px); guard explicitly so a future fractional ROW_HEIGHT
		// fails closed rather than corrupting the seam (No-Fallbacks; mirrors the gutter-boundary guard below).
		if (!Number.isInteger(frozenRowsCssH * dpr)) {
			return null;
		}
		const bodyTopDev = headerDev + Math.round(frozenRowsCssH * dpr);
		const bodyDevH = bh - bodyTopDev;
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
		// W3: the body top in CSS px (just below the header + frozen-row band) -- the scrolling-up strip
		// starts here, and the copy source/dest origins are `bodyTopDev`. With no frozen rows this is
		// `HEADER_HEIGHT` (byte-identical to the pre-W3 blit).
		const bodyTopCss = HEADER_HEIGHT + frozenRowsCssH;
		if (dy > 0) {
			// Scrolling down: content moves up; new rows appear at the BOTTOM.
			return {
				copy: { sx: 0, sy: bodyTopDev + dyDev, sw: bw, sh: reusable, dx: 0, dy: bodyTopDev, dw: bw, dh: reusable },
				damageRects: [{ x: 0, y: next.cssH - stripH, width: next.cssW, height: stripH }],
			};
		}
		// Scrolling up: content moves down; new rows appear at the TOP (just below the header + frozen band).
		return {
			copy: { sx: 0, sy: bodyTopDev, sw: bw, sh: reusable, dx: 0, dy: bodyTopDev + dyDev, dw: bw, dh: reusable },
			damageRects: [{ x: 0, y: bodyTopCss, width: next.cssW, height: stripH }],
		};
	}

	// Horizontal: shift the body region [bodyLeftDev, bw) only; the sticky gutter + frozen-col band (and the
	// corner) stay in place. FULL height (the header column labels + frozen ROWS scroll with their columns).
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
	// W3: same WHOLE-device-pixel requirement for the frozen-col band boundary (`frozenColCount * COL_WIDTH`
	// is an integer CSS px today; guard so a future fractional COL_WIDTH fails closed instead of corrupting
	// the seam). The body left = gutter + frozen-col band.
	if (!Number.isInteger(frozenColsCssW * dpr)) {
		return null;
	}
	const bodyLeftCss = gutterCssW + frozenColsCssW;
	const bodyLeftDev = Math.round(gutterCssW * dpr) + Math.round(frozenColsCssW * dpr);
	const bodyDevW = bw - bodyLeftDev;
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
			copy: { sx: bodyLeftDev + dxDev, sy: 0, sw: reusable, sh: bh, dx: bodyLeftDev, dy: 0, dw: reusable, dh: bh },
			damageRects: [{ x: next.cssW - stripW, y: 0, width: stripW, height: next.cssH }],
		};
	}
	// Scrolling left: body content moves right; new columns appear at the LEFT edge of the body (just right
	// of the sticky gutter + frozen-col band -- the strip starts at bodyLeftCss, NOT 0 or gutterCssW).
	return {
		copy: { sx: bodyLeftDev, sy: 0, sw: reusable, sh: bh, dx: bodyLeftDev + dxDev, dy: 0, dw: reusable, dh: bh },
		damageRects: [{ x: bodyLeftCss, y: 0, width: stripW, height: next.cssH }],
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

/** Equal iff two entries have the same STORED CONTENT (value + formula) -- the "a real write landed"
 * signal for {@link staleTintKeysA1}. Deliberately EXCLUDES `diagnostic` (attached host-side from the
 * event ring, can change with NO cell write -- megaudit MED: a diagnostic-only delta must not clear an
 * error tint) and `rendered` (a derived display projection of `value`, not an independent write). */
function cellContentEqual(a: Entry, b: Entry): boolean {
	return valueEqual(a.value, b.value) && optEqual(a.formula, b.formula);
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

/**
 * **FE-2-0 polish (2026-06-05) -- clear a STALE error tint when a cell is fixed elsewhere.**
 *
 * `errorCells` tints a cell red after an `errorReply` (an edit this panel posted was REJECTED -- the bad
 * value was NEVER stored, so the snapshot keeps showing the cell's prior valid content). Phase 2 made a
 * bare `render` deliberately NOT touch `errorCells` (that invariant killed the sibling-render false-ack
 * HIGH). But that left a stale tint when the cell is FIXED by another writer (a sibling panel / a
 * recompute) -- the underlying content changes yet the red tint lingers.
 *
 * This returns the subset of `tintedKeys` (`"row,col"`) whose STORED CONTENT actually changed between
 * `prev` and `next` -- i.e. a real write landed on that cell -- so the caller can drop only those tints.
 * Because a rejected edit was never stored, "the snapshot shows a valid value" is ALWAYS true and cannot
 * be the signal; the CHANGE between renders is. Uses {@link cellContentEqual} (value + formula only) -- a
 * diagnostic-only or rendered-only delta is NOT a write and must not clear the tint.
 *
 * The cell with an OPEN editor is INTENTIONALLY not special-cased: clearing the tint of the very cell the
 * user is fixing when a SIBLING repairs it is exactly the point of this feature, and the editor (a real
 * `<input>` painted on top) covers the cell so the tint under it is not even visible; on editor-close the
 * correct, untinted, sibling-written value shows. (The cell's tint can never be cleared by the user's OWN
 * rejected edit, which is never stored -- so `prev`/`next` for that cell are equal and it isn't returned.)
 *
 * Returns `[]` when there is no prior frame or the sheet changed (the caller clears `errorCells`
 * wholesale on a sheet switch). Pure -> golden-testable.
 */
export function staleTintKeysA1(
	prev: QuantbookCellSnapshot | null,
	next: QuantbookCellSnapshot,
	tintedKeys: Iterable<string>,
): string[] {
	if (prev === null || prev.sheet !== next.sheet) {
		return [];
	}
	const prevByKey = new Map<string, Entry>();
	for (const e of prev.entries) {
		const k = cellKey(e);
		if (k !== null) {
			prevByKey.set(k, e);
		}
	}
	const nextByKey = new Map<string, Entry>();
	for (const e of next.entries) {
		const k = cellKey(e);
		if (k !== null) {
			nextByKey.set(k, e);
		}
	}
	const out: string[] = [];
	for (const key of tintedKeys) {
		const pe = prevByKey.get(key);
		const ne = nextByKey.get(key);
		// Content changed iff the cell's RENDERABLE presence flipped, or both renders carry the cell but its
		// STORED CONTENT (value + formula) now differs -- a real write. (NOT entryVisualEqual: a diagnostic-
		// only or rendered-only change is not a write and must not clear the tint -- megaudit MED.)
		const changed =
			(pe === undefined) !== (ne === undefined) ||
			(pe !== undefined && ne !== undefined && !cellContentEqual(pe, ne));
		if (changed) {
			out.push(key);
		}
	}
	return out;
}
