/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 (2026-06-03) -- pure layout math for the A1 spreadsheet renderer.**
 *
 * Supersedes the FE-0b cell-LIST geometry (`gridLayout.ts`, retained as a green oracle until the
 * fast-follow retirement). The A1 grid is a real spreadsheet: a sticky **column-letter band**
 * (A,B,C,…) across the top, a sticky **row-number gutter** (1,2,3,…) down the left, a **corner box**
 * at their intersection, and a full grid of fixed-size cells spanning the Excel extent
 * (`MAX_ROWS` × `MAX_COLS`). The sparse snapshot's populated cells paint at their (row,col); every
 * other cell is empty-but-editable.
 *
 * **CONTENT coordinates**: origin at the top-left of the full scrollable content. The column band
 * occupies `[0, HEADER_HEIGHT)`; the row gutter occupies `[0, gutterW)`. Data cell `(row,col)` sits
 * at `[gutterW + col*COL_WIDTH, +COL_WIDTH) × [HEADER_HEIGHT + row*ROW_HEIGHT, +ROW_HEIGHT)`. The
 * canvas converts content->local by subtracting the scroll offset; the band + gutter are STICKY
 * (re-painted at viewport-local `y=0` / `x=0` every frame, never scrolled).
 *
 * **`gutterW` is a parameter, not a constant**, because the row-number gutter widens with the digit
 * count of the largest visible row (Excel/Sheets behaviour). Only the renderer can `measureText`, so
 * it computes `gutterW` per frame (via {@link gutterWidth}) and threads it through every function
 * here -- keeping this module PURE (no canvas/document/window/this) and golden-testable headlessly.
 *
 * **Centralized mapping (windowing insurance):** ALL viewport<->content<->(row,col) math lives here.
 * `index.ts` must never inline `+ HEADER_HEIGHT + scrollTop` arithmetic -- so a future swap of the
 * giant-DOM-spacer model for a windowed/virtualized scroller (needed only if `ROW_HEIGHT` grows past
 * the ~31px that keeps `MAX_ROWS*ROW_HEIGHT` under the ~33.5M-px Chromium element cap, or for a
 * non-Electron target) touches only this module, not the hit-test / paint / edit call sites.
 */

/**
 * Re-export the surrogate-pair-safe width-bounded truncation from the FE-0b layout module (shared,
 * not forked). When `gridLayout.ts` is retired in the fast-follow, move this function here.
 */
export { truncateToWidth } from './gridLayout';

/** Pixel width of one data column (Excel default ~64px). */
export const COL_WIDTH = 64;

/** Pixel height of one data row. **Must stay <= 31**: `MAX_ROWS*ROW_HEIGHT` must remain under the
 * ~33.5M-px Chromium/Electron max element height (at 25 → 26.2M px, 78% of the cap). */
export const ROW_HEIGHT = 25;

/** Pixel height of the sticky column-letter band (A,B,C,…). */
export const HEADER_HEIGHT = 28;

/** Horizontal padding inside the row-number gutter (each side of the number). */
export const GUTTER_PAD = 8;

/** Excel row count (0-based rows `[0, MAX_ROWS)`; the bottom row is 1,048,575). */
export const MAX_ROWS = 1_048_576;

/** Excel column count (0-based cols `[0, MAX_COLS)`; the last column 16,383 is "XFD"). */
export const MAX_COLS = 16_384;

/**
 * A1 column label for a 0-based column index: 0→"A", 25→"Z", 26→"AA", 51→"AZ", 52→"BA", 701→"ZZ",
 * 702→"AAA", 16383→"XFD". This is **bijective base-26** (a.k.a. "spreadsheet" / "Excel" numbering):
 * there is no zero digit, so the `Math.floor(n/26) - 1` after emitting each least-significant letter
 * is the carry correction (the off-by-one that distinguishes it from plain base-26). Ported from the
 * engine's canonical `column_index_to_letters` (`ql-formula-syntax/src/printer.rs`).
 */
export function columnLabel(colIndex: number): string {
	let n = Math.floor(colIndex);
	if (n < 0) {
		return '';
	}
	let label = '';
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return label;
}

/**
 * Width of the sticky row-number gutter for a given measured text width (the px width of the WIDEST
 * row-number string currently in view, from `ctx.measureText`). Pure: the measurement is injected so
 * this stays headless-testable. The renderer recomputes it per frame so the gutter tracks the digit
 * count of the largest visible row (Excel/Sheets behaviour).
 */
export function gutterWidth(maxRowNumberTextWidth: number): number {
	return Math.ceil(Math.max(0, maxRowNumberTextWidth)) + GUTTER_PAD * 2;
}

/** Content-X of the left edge of column `colIndex` (after the gutter). */
export function colX(colIndex: number, gutterW: number): number {
	return gutterW + colIndex * COL_WIDTH;
}

/** Content-Y of the top edge of row `rowIndex` (below the header band). */
export function rowY(rowIndex: number): number {
	return HEADER_HEIGHT + rowIndex * ROW_HEIGHT;
}

/**
 * Content-coordinate rectangle of cell `(row,col)`. Used to position the overlay editor `<input>`
 * (an absolute child of the scroller's content layer, so it scrolls with the grid) and to derive the
 * canvas local draw rect (subtract the scroll offset). Cell `(0,0)` sits at `(gutterW, HEADER_HEIGHT)`.
 */
export function cellContentRect(
	row: number,
	col: number,
	gutterW: number,
): { x: number; y: number; width: number; height: number } {
	return { x: colX(col, gutterW), y: rowY(row), width: COL_WIDTH, height: ROW_HEIGHT };
}

/** Total scrollable content width = gutter + all columns (drives the horizontal scrollbar). */
export function totalContentWidth(gutterW: number): number {
	return gutterW + MAX_COLS * COL_WIDTH;
}

/** Total scrollable content height = header band + all rows (drives the vertical scrollbar). */
export function totalContentHeight(): number {
	return HEADER_HEIGHT + MAX_ROWS * ROW_HEIGHT;
}

/**
 * Half-open visible-column range `[startIdx, endIdx)` for a horizontally-scrolled viewport. The
 * column twin of {@link computeVisibleRowRange} (in `cellRender.ts`); kept as a separate function
 * (not a shared generic) so a width/height arg transposition is impossible. The gutter offset does
 * NOT enter the formula -- it cancels exactly as the header offset does for rows (a column scrolled
 * under the sticky gutter is covered by the gutter's own paint), so `firstVisible =
 * floor(scrollLeft / colWidth)`.
 */
export function computeVisibleColRange(
	scrollLeft: number,
	viewportWidth: number,
	totalCols: number,
	colWidth: number,
	overscan: number,
): { startIdx: number; endIdx: number } {
	if (totalCols === 0) {
		return { startIdx: 0, endIdx: 0 };
	}
	if (colWidth <= 0) {
		return { startIdx: 0, endIdx: totalCols };
	}
	const maxFirst = Math.max(0, totalCols - 1);
	const firstVisible = Math.min(maxFirst, Math.max(0, Math.floor(scrollLeft / colWidth)));
	const visibleCount = Math.max(1, Math.ceil(viewportWidth / colWidth));
	const startIdx = Math.max(0, firstVisible - overscan);
	const endIdx = Math.min(totalCols, firstVisible + visibleCount + overscan);
	return { startIdx, endIdx };
}

/**
 * **FE-2-0 Phase 1 (C1-MED4, 2026-06-03)** -- whether `(row,col)` is a renderable A1 cell: an
 * INTEGER inside `[0,MAX_ROWS) × [0,MAX_COLS)`. The explicit `Number.isInteger` is load-bearing: a
 * bare `r < 0 || r >= MAX_ROWS` comparison is FALSE for `NaN`, so a `NaN`/fractional coordinate from
 * a malformed snapshot would slip past a range-only check into the paint/lookup math. Pure +
 * golden-tested so the renderer's `setSnapshot` extent guard is verified headlessly.
 */
export function isInExtent(row: number, col: number): boolean {
	return (
		Number.isInteger(row) &&
		Number.isInteger(col) &&
		row >= 0 &&
		row < MAX_ROWS &&
		col >= 0 &&
		col < MAX_COLS
	);
}

/**
 * **FE-2-0 Phase 1 (C2-MED2, 2026-06-03)** -- the new scroll offset (one axis) that reveals a cell
 * below/right of a sticky band, given the cell's content-start, its size, the sticky band size
 * (header/gutter), the current scroll, and the viewport client size. Keeps the "ALL viewport math
 * lives here" doctrine + is golden-testable (the old inline version read the DOM).
 *
 * - **Tiny viewport** (visible body `client - band <= size`, i.e. narrower/shorter than one cell):
 *   align the cell's start to the band edge (`start - band`) and accept clipping on the far edge.
 *   Without this, the far-edge branch parks the cell PARTLY UNDER the sticky band.
 * - Cell starts before the band edge -> scroll so its start sits at the band edge.
 * - Cell ends past the viewport -> scroll so its end sits at the viewport edge.
 * - Otherwise already fully visible -> scroll unchanged.
 */
export function scrollToReveal(
	cellStart: number,
	cellSize: number,
	bandSize: number,
	scroll: number,
	clientSize: number,
): number {
	const bodyVisible = clientSize - bandSize;
	if (bodyVisible <= cellSize) {
		return cellStart - bandSize; // viewport too small for a whole cell: align to the band edge
	}
	const localStart = cellStart - scroll;
	if (localStart < bandSize) {
		return cellStart - bandSize;
	}
	if (localStart + cellSize > clientSize) {
		return cellStart + cellSize - clientSize;
	}
	return scroll;
}

/**
 * Map a CONTENT-coordinate point to the cell `(row,col)` under it, or `null` if it lands in the
 * header band, the gutter, the corner, or outside the `MAX_ROWS × MAX_COLS` extent. Callers with a
 * VIEWPORT-local point must use {@link hitTestViewport} instead (the bands are sticky).
 */
export function hitTestContent(
	contentX: number,
	contentY: number,
	gutterW: number,
): { row: number; col: number } | null {
	if (contentY < HEADER_HEIGHT) {
		return null; // column-letter band
	}
	if (contentX < gutterW) {
		return null; // row-number gutter
	}
	const row = Math.floor((contentY - HEADER_HEIGHT) / ROW_HEIGHT);
	const col = Math.floor((contentX - gutterW) / COL_WIDTH);
	if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) {
		return null;
	}
	return { row, col };
}

/**
 * Map a VIEWPORT-LOCAL point (relative to the canvas, which overlays the viewport) to the cell under
 * it. **Both bands are sticky**, so a click in the column band (`localY < HEADER_HEIGHT`) or the row
 * gutter (`localX < gutterW`) -- or the corner (both) -- is rejected in LOCAL coords BEFORE adding the
 * scroll offset. Doing the gutter check in content coords would be WRONG at `scrollLeft > 0` (the
 * visible sticky gutter would map to `localX + scrollLeft >= gutterW` and hit a body column) -- the
 * exact mirror of the sticky-header reasoning in the FE-0b `gridLayout.ts`. Below+right of the bands,
 * the point is converted to content coords and delegated to {@link hitTestContent}.
 */
export function hitTestViewport(
	localX: number,
	localY: number,
	scrollLeft: number,
	scrollTop: number,
	gutterW: number,
): { row: number; col: number } | null {
	if (localY < HEADER_HEIGHT) {
		return null; // sticky column band (or corner) -- never an editable cell at any scroll position
	}
	if (localX < gutterW) {
		return null; // sticky row gutter (or corner) -- never an editable cell at any scroll position
	}
	return hitTestContent(localX + scrollLeft, localY + scrollTop, gutterW);
}
