/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 (2026-06-03) -- pure layout math for the A1 spreadsheet renderer.**
 *
 * Supersedes (and, as of FE-2-0 Phase 4, fully REPLACES) the retired FE-0b cell-LIST geometry module
 * `gridLayout.ts`. The A1 grid is a real spreadsheet: a sticky **column-letter band**
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
 * Truncate `text` to fit `maxWidth` px (per the injected `measure`), appending an ellipsis when it
 * must be cut. Pure: `measure` is the only environment dependency, so this is golden-testable with
 * a fake monospace measurer. Returns `''` if not even the ellipsis fits. Binary-searches the
 * longest prefix whose `prefix + '…'` still fits.
 *
 * **FE-2-0 Phase 4 (2026-06-04):** moved here from the retired FE-0b `gridLayout.ts` (it was the only
 * symbol that module still provided, via a re-export). Body unchanged; the surrogate-safe backoff is
 * the FE megaudit L-e fix.
 */
export function truncateToWidth(text: string, maxWidth: number, measure: (s: string) => number): string {
	if (text === '') {
		return '';
	}
	if (measure(text) <= maxWidth) {
		return text;
	}
	const ellipsis = '…';
	if (measure(ellipsis) > maxWidth) {
		return '';
	}
	let lo = 0;
	let hi = text.length;
	// Largest `len` with measure(text.slice(0,len) + '…') <= maxWidth.
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (measure(text.slice(0, mid) + ellipsis) <= maxWidth) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	// FE megaudit L-e: don't slice mid-surrogate. `text.length` counts UTF-16 code units, so a cut at
	// `lo` could land BETWEEN a high+low surrogate of an astral character (emoji, etc.), leaving a lone
	// high surrogate that renders as the replacement glyph. If the last kept code unit is a high
	// surrogate (0xD800-0xDBFF) followed by a low surrogate, back off one unit to drop the whole pair.
	if (lo > 0 && lo < text.length) {
		const lastKept = text.charCodeAt(lo - 1);
		const nextDropped = text.charCodeAt(lo);
		if (lastKept >= 0xD800 && lastKept <= 0xDBFF && nextDropped >= 0xDC00 && nextDropped <= 0xDFFF) {
			lo -= 1;
		}
	}
	return text.slice(0, lo) + ellipsis;
}

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
 * A1 cell reference for a 0-based `(row, col)`: `(0,0)`->"A1", `(1,1)`->"B2", `(0,26)`->"AA1",
 * `(1048575,16383)`->"XFD1048576". The column uses {@link columnLabel} (bijective base-26); the row is
 * 1-based. A negative row clamps to row 1. Pure -- the formula bar's cell-name box reads this (W-G).
 */
export function cellRefA1(row: number, col: number): string {
	return columnLabel(col) + String(Math.max(0, Math.floor(row)) + 1);
}

/** An inclusive rectangular cell range, in 0-based grid coordinates. */
export interface SelectionRect {
	readonly minRow: number;
	readonly maxRow: number;
	readonly minCol: number;
	readonly maxCol: number;
}

/**
 * Normalize a selection's two endpoints -- `anchor` (the fixed end) and `focus` (the moving end) -- into
 * an inclusive {@link SelectionRect}, regardless of which end is up/left. `anchor === focus` yields a
 * single-cell rect (`min === max`). Pure -- the renderer paints from this and the host (W-G-2b) reports
 * it. The W-G selection model keeps `focus` as the editable/active cell; `anchor` is the other corner.
 */
export function selectionRect(
	anchor: { row: number; col: number },
	focus: { row: number; col: number },
): SelectionRect {
	return {
		minRow: Math.min(anchor.row, focus.row),
		maxRow: Math.max(anchor.row, focus.row),
		minCol: Math.min(anchor.col, focus.col),
		maxCol: Math.max(anchor.col, focus.col),
	};
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
 * **FE-1.5 W-G (bound-cell name display)** -- the reactive variable NAME driving cell `(row, col)`,
 * or `null` if the cell is not a published target. Scans `ranges` (the host->webview published set
 * for the active sheet, each an inclusive 0-based rect carrying its `.name`) and returns the FIRST
 * containing range's name. The param is STRUCTURAL (not the webview `PublishedRange` interface) so
 * this leaf geometry module stays free of any dependency on `canvasGrid.ts`. First-match-wins is the
 * documented v1 behaviour: publishes are single cells, so ranges never overlap; a future range-aware
 * bind that does overlap would surface the first match (registration order). Pure + unit-tested so
 * the formula-bar chip and the hover tooltip read it headlessly-verified.
 */
export function publishedNameAt(
	ranges: readonly {
		readonly startRow: number;
		readonly startCol: number;
		readonly endRow: number;
		readonly endCol: number;
		readonly name: string;
	}[],
	row: number,
	col: number,
): string | null {
	for (const r of ranges) {
		if (row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol) {
			return r.name;
		}
	}
	return null;
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
