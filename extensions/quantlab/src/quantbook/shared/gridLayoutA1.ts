/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 (2026-06-03) -- pure layout math for the A1 spreadsheet renderer.**
 *
 * **W3 frozen-panes promotion (2026-06-09):** this module (and `a1FormulaRefs.ts`) MOVED here from
 * `webview/sheets-webview/` so the host-side dep-graph window imports ONE pure A1 tokenizer/layout
 * module, not a fork. Both are DOM/vscode-free (no `document`/`window`/`vscode`/`this`/native binary),
 * so they are safe in BOTH the browser webview bundle (esbuild) AND the Node host (`src/quantbook/`).
 * The webview keeps a THIN re-export shim at the old path so its ~8 importers are untouched; the
 * webview esbuild's `HOST_RUNTIME_FILTER` is narrowed to allow `src/quantbook/shared/` (a pure,
 * napi-free subtree) while still blocking every host-runtime module (`session`/`loader`/native).
 *
 * Supersedes (and, as of FE-2-0 Phase 4, fully REPLACES) the retired FE-0b cell-LIST geometry module
 * `gridLayout.ts`. The A1 grid is a real spreadsheet: a sticky **column-letter band**
 * (A,B,C,…) across the top, a sticky **row-number gutter** (1,2,3,…) down the left, a **corner box**
 * at their intersection, and a full grid of cells spanning the Excel extent
 * (`MAX_ROWS` × `MAX_COLS`). The sparse snapshot's populated cells paint at their (row,col); every
 * other cell is empty-but-editable.
 *
 * **CONTENT coordinates**: origin at the top-left of the full scrollable content. The column band
 * occupies `[0, HEADER_HEIGHT)`; the row gutter occupies `[0, gutterW)`. Data cell `(row,col)` spans
 * `[colX(col), colX(col)+sizeAt(colSizing,col))` on X and `[rowY(row), rowY(row)+sizeAt(rowSizing,row))`
 * on Y -- which reduces to the uniform `gutterW + col*COL_WIDTH` (width `COL_WIDTH`) / `HEADER_HEIGHT +
 * row*ROW_HEIGHT` (height `ROW_HEIGHT`) until a column/row is resized (Wave G / G-rows). The canvas
 * converts content->local by subtracting the scroll offset; the band + gutter are STICKY
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

// **Wave G column sizing (R1, 2026-06-18) + Wave G-rows (2026-06-18):** the pure sparse sizing model lives
// in `./axisSizing`. The COLUMN- and ROW-geometry functions below read injected module bindings ({@link
// currentColSizing} / {@link currentRowSizing}) so the ~130 existing call sites (and every existing golden
// test) stay UNCHANGED and one source per axis feeds paint + hit-test + overlay alike (divergence-proof).
// Re-exported so the webview shim's importers reach the model through the existing `./gridLayoutA1` path.
import {
	type AxisSizing,
	emptyAxisSizing,
	indexAtOffset,
	offsetBefore,
	sizeAt,
	totalExtent,
} from './axisSizing';

export * from './axisSizing';

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

/**
 * Pixel width of one data column. **Sheets-parity (2026-06-10): 100px**, Google Sheets' default column
 * width (was 64, the Excel-ish default -- a 2026-06-10 screenshot audit showed the grid reading less
 * spreadsheet-like than Sheets AND truncating long labels at 64). Every consumer derives from this one
 * constant (renderer paint, hit-testing, frozen-band widths, blit math, the scroll spacer via
 * {@link totalContentWidth}, the overlay editor via {@link cellContentRect}), so this single edit
 * re-geometries the whole grid consistently. Width has no Chromium-element-cap concern
 * (`MAX_COLS * 100 = ~1.64M px`, far under the ~33.5M cap that constrains ROW_HEIGHT).
 */
export const COL_WIDTH = 100;

/** Pixel height of one data row. **Sheets-parity (2026-06-10): 24px** (was 25; Google Sheets uses ~21).
 * 21 was rejected deliberately: the renderer's body font is 13px (`canvasGrid.readFonts`), and a 13px
 * glyph box centered in a 21px row leaves ~3px of leading per side -- visibly cramped next to Sheets,
 * whose default cell font is smaller (10pt). 24 keeps the tightened "spreadsheet density" read while
 * giving the 13px font ~5px of leading, and stays an INTEGER CSS px (the blit math in `gridBlitA1.ts`
 * fails closed on a fractional frozen-band height). **Must stay <= 31**: `MAX_ROWS*ROW_HEIGHT` must
 * remain under the ~33.5M-px Chromium/Electron max element height (at 24 → 25.2M px, 75% of the cap). */
export const ROW_HEIGHT = 24;

/** Pixel height of the sticky column-letter band (A,B,C,…). **Sheets-parity (2026-06-10): 24px** (was
 * 28) -- proportional to the tightened ROW_HEIGHT (Sheets' column band is the same height as its rows),
 * and ample for the renderer's 11px header font. The row-number gutter needs no analogous constant: its
 * width derives from the measured widest row number + `GUTTER_PAD` ({@link gutterWidth}), so it stays
 * proportional by construction. */
export const HEADER_HEIGHT = 24;

/** Horizontal padding inside the row-number gutter (each side of the number). */
export const GUTTER_PAD = 8;

/** Excel row count (0-based rows `[0, MAX_ROWS)`; the bottom row is 1,048,575). */
export const MAX_ROWS = 1_048_576;

/** Excel column count (0-based cols `[0, MAX_COLS)`; the last column 16,383 is "XFD"). */
export const MAX_COLS = 16_384;

/** **Wave G column sizing** -- inclusive clamp for a resized COLUMN width (CSS px). `MIN` keeps a column
 *  grabbable + legible; `MAX` (Excel's practical ceiling) bounds the X extent: `MAX_COLS * MAX_COL_WIDTH =
 *  32.77M px` stays under the ~33.5M-px Chromium element cap even in the (unreachable) all-columns-maxed
 *  case, so column sizing needs NO separate total-extent guard -- that is a ROW-axis concern for the
 *  follow-up wave (`MAX_ROWS * any row height` blows the cap). */
export const MIN_COL_WIDTH = 12;
export const MAX_COL_WIDTH = 2000;

/** **Wave G-rows row sizing** -- inclusive clamp for a resized ROW height (CSS px). `MIN` keeps a row
 *  grabbable + legible; `MAX` (Excel's practical ceiling) bounds a single row. Unlike columns, the ROW
 *  axis CAN approach the element-size cap in aggregate, so the row model also carries a {@link MAX_SPACER_PX}
 *  total-extent guard (see {@link currentRowSizing}). */
export const MIN_ROW_HEIGHT = 12;
export const MAX_ROW_HEIGHT = 2000;

/** **Wave G-rows row sizing** -- safe ceiling for the total scrollable content height (the vertical spacer
 *  element), a margin under the ~33.5M-px Chromium/Electron max element height. `MAX_ROWS * ROW_HEIGHT =
 *  25.2M px` (the uniform baseline) sits well under it; the row sizing model throws (No-Fallbacks) if enough
 *  row resizes would push `HEADER_HEIGHT + totalExtent` past this. NOT a column concern (`MAX_COLS *
 *  MAX_COL_WIDTH = 32.77M` already fits), so columns pass `Infinity`. */
export const MAX_SPACER_PX = 33_000_000;

/** **Wave G column sizing** -- the pointer grab band (CSS px, each side of a column's right edge) for the
 *  col-resize affordance ({@link colResizeBorderAt} / the renderer's `cursorAt`). Shared by the ROW-resize
 *  affordance ({@link rowResizeBorderAt}, each side of a row's bottom edge). */
export const RESIZE_GRAB_PX = 4;

/** **Wave G column sizing** -- the injected COLUMN sizing model. Default = uniform (no overrides), so every
 *  column-geometry function below is BYTE-IDENTICAL to the legacy `col * COL_WIDTH` arithmetic until a
 *  column is resized. The renderer replaces it via {@link setColSizing} on every sizing change (host
 *  message or live drag); paint + hit-test + overlay all read this ONE source (divergence-proof). One grid
 *  per webview realm => a module singleton is correct; tests inject a model and {@link resetColSizing}. */
let currentColSizing: AxisSizing = emptyAxisSizing(COL_WIDTH, MAX_COLS, MIN_COL_WIDTH, MAX_COL_WIDTH);

/** **Wave G** -- install the live COLUMN sizing model (the renderer's single source of truth). */
export function setColSizing(sizing: AxisSizing): void {
	currentColSizing = sizing;
}

/** **Wave G** -- the current COLUMN sizing model (the renderer reads it to build the next `withOverride`,
 *  to report `hasOverrides` to the blit gate, and to post the override set to the host). */
export function getColSizing(): AxisSizing {
	return currentColSizing;
}

/** **Wave G** -- reset to uniform (no overrides). Used on a fresh/cleared grid and for test isolation. */
export function resetColSizing(): void {
	currentColSizing = emptyAxisSizing(COL_WIDTH, MAX_COLS, MIN_COL_WIDTH, MAX_COL_WIDTH);
}

/** **Wave G-rows** -- the injected ROW sizing model (the mirror of {@link currentColSizing} for the Y axis).
 *  Default = uniform, so every row-geometry function below is BYTE-IDENTICAL to the legacy `row * ROW_HEIGHT`
 *  arithmetic until a row is resized. Carries a {@link MAX_SPACER_PX} total-extent cap (the row axis can reach
 *  the element-size limit; columns cannot). The renderer replaces it via {@link setRowSizing} on every sizing
 *  change; paint + hit-test + overlay + reveal all read this ONE source (divergence-proof). */
let currentRowSizing: AxisSizing = emptyAxisSizing(ROW_HEIGHT, MAX_ROWS, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, MAX_SPACER_PX - HEADER_HEIGHT);

/** **Wave G-rows** -- install the live ROW sizing model (the renderer's single source of truth for the Y axis). */
export function setRowSizing(sizing: AxisSizing): void {
	currentRowSizing = sizing;
}

/** **Wave G-rows** -- the current ROW sizing model (the renderer reads it to build the next `withOverride`, to
 *  report `hasOverrides` to the blit gate, and to post the override set to the host). */
export function getRowSizing(): AxisSizing {
	return currentRowSizing;
}

/** **Wave G-rows** -- reset to uniform (no overrides). Used on a fresh/cleared grid and for test isolation. */
export function resetRowSizing(): void {
	currentRowSizing = emptyAxisSizing(ROW_HEIGHT, MAX_ROWS, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, MAX_SPACER_PX - HEADER_HEIGHT);
}

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

/** Content-X of the left edge of column `colIndex` (after the gutter). **Wave G:** the cumulative sum of
 *  the widths of columns `[0, colIndex)` (via the injected {@link currentColSizing}); reduces to
 *  `gutterW + colIndex * COL_WIDTH` when no column is resized. */
export function colX(colIndex: number, gutterW: number): number {
	return gutterW + offsetBefore(currentColSizing, colIndex);
}

/** Content-Y of the top edge of row `rowIndex` (below the header band). **Wave G-rows:** the cumulative sum
 *  of the heights of rows `[0, rowIndex)` (via the injected {@link currentRowSizing}); reduces to
 *  `HEADER_HEIGHT + rowIndex * ROW_HEIGHT` when no row is resized. */
export function rowY(rowIndex: number): number {
	return HEADER_HEIGHT + offsetBefore(currentRowSizing, rowIndex);
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
	// Wave G: `width`/`height` are the cell's actual (possibly resized) size via the injected col/row models;
	// `x`/`y` come from the binding-aware `colX`/`rowY`. Reduces to `COL_WIDTH`/`ROW_HEIGHT` when nothing is
	// resized. The overlay editor reads this to size + place its `<input>`.
	return { x: colX(col, gutterW), y: rowY(row), width: sizeAt(currentColSizing, col), height: sizeAt(currentRowSizing, row) };
}

/** Total scrollable content width = gutter + all columns (drives the horizontal scrollbar). **Wave G:**
 *  the summed widths of all `MAX_COLS` columns (via {@link currentColSizing}); reduces to `gutterW +
 *  MAX_COLS * COL_WIDTH` when no column is resized. */
export function totalContentWidth(gutterW: number): number {
	return gutterW + totalExtent(currentColSizing);
}

/** Total scrollable content height = header band + all rows (drives the vertical scrollbar). **Wave G-rows:**
 *  the summed heights of all `MAX_ROWS` rows (via {@link currentRowSizing}); reduces to `HEADER_HEIGHT +
 *  MAX_ROWS * ROW_HEIGHT` when no row is resized. The row model's `MAX_SPACER_PX` cap keeps this under the
 *  Chromium element-height limit. */
export function totalContentHeight(): number {
	return HEADER_HEIGHT + totalExtent(currentRowSizing);
}

// --- W3 frozen panes (2026-06-09) ------------------------------------------------------------------

/**
 * **W3 frozen panes** -- clamp a raw frozen-count to a SANE non-negative integer for the given axis.
 * A freeze of N rows/cols means the first N (rows `[0,N)` / cols `[0,N)`) stay pinned below the header /
 * right of the gutter on scroll. The count is bounded to `[0, max-1]`: freezing the WHOLE axis would
 * leave zero scrollable body, so the last index can never be frozen (Excel refuses a freeze that fills
 * the pane too). A non-integer / negative / NaN input clamps to 0 (no freeze) -- defensive, since the
 * count crosses the host->webview wire and a malformed value must never corrupt the paint geometry.
 */
export function clampFrozenCount(count: number, axisMax: number): number {
	if (!Number.isInteger(count) || count <= 0) {
		return 0;
	}
	return Math.min(count, Math.max(0, axisMax - 1));
}

/** **W3 frozen panes** -- pixel height of the frozen-row band. **Wave G-rows:** the summed heights of the
 *  first `frozenRowCount` rows (via {@link currentRowSizing}); reduces to `frozenRowCount * ROW_HEIGHT` when
 *  no row is resized. 0 = none. */
export function frozenRowsHeight(frozenRowCount: number): number {
	return offsetBefore(currentRowSizing, Math.max(0, frozenRowCount));
}

/** **W3 frozen panes** -- pixel width of the frozen-col band. **Wave G:** the summed widths of the first
 *  `frozenColCount` columns (via {@link currentColSizing}); reduces to `frozenColCount * COL_WIDTH` when no
 *  column is resized. 0 = none. */
export function frozenColsWidth(frozenColCount: number): number {
	return offsetBefore(currentColSizing, Math.max(0, frozenColCount));
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
	if (currentColSizing.overrides.size === 0) {
		// Uniform fast path -- BYTE-IDENTICAL to the pre-Wave-G code (the keystone invariant).
		const maxFirst = Math.max(0, totalCols - 1);
		const firstVisible = Math.min(maxFirst, Math.max(0, Math.floor(scrollLeft / colWidth)));
		const visibleCount = Math.max(1, Math.ceil(viewportWidth / colWidth));
		const startIdx = Math.max(0, firstVisible - overscan);
		const endIdx = Math.min(totalCols, firstVisible + visibleCount + overscan);
		return { startIdx, endIdx };
	}
	// Wave G variable-width window: the first/last visible columns come from the inverse cumulative-width
	// lookup at the viewport's left/right edge (O(log) each, exact -- never an under-count that would blank
	// a column). `+1` makes the last column half-open; overscan widens both ends.
	const maxFirst = Math.max(0, totalCols - 1);
	const firstVisible = Math.min(maxFirst, Math.max(0, indexAtOffset(currentColSizing, scrollLeft)));
	const lastVisible = Math.min(maxFirst, Math.max(0, indexAtOffset(currentColSizing, scrollLeft + viewportWidth)));
	const startIdx = Math.max(0, firstVisible - overscan);
	const endIdx = Math.min(totalCols, lastVisible + 1 + overscan);
	return { startIdx, endIdx };
}

/**
 * **W3 frozen panes** -- the visible SCROLLING-BODY column range `[startIdx, endIdx)` (the columns that
 * scroll UNDER the frozen band), given `frozenColCount` columns are pinned at `[gutterW, gutterW +
 * frozenColsWidth)`. The frozen columns themselves are NOT in this range -- they are always painted at
 * their locked X (the renderer iterates `[0, frozenColCount)` separately). The scrolling body therefore:
 *   - starts at content column `frozenColCount` (never re-paint a frozen column as a body column), and
 *   - its first visible body column is `frozenColCount + floor(scrollLeft / colWidth)` (the frozen band
 *     consumes `frozenColsWidth` of the viewport, so the body's effective viewport width shrinks by it,
 *     and `scrollLeft` advances the body content under the pinned band, not the band).
 *
 * With `frozenColCount === 0` this is byte-identical to {@link computeVisibleColRange} (the brief's
 * "non-frozen == identical" requirement): `firstVisible` reduces to `floor(scrollLeft/colWidth)` and the
 * start floor is `0`. Pure + golden-tested.
 */
export function computeVisibleBodyColRange(
	scrollLeft: number,
	viewportWidth: number,
	totalCols: number,
	colWidth: number,
	overscan: number,
	frozenColCount: number,
): { startIdx: number; endIdx: number } {
	const frozen = Math.max(0, frozenColCount);
	if (totalCols === 0) {
		return { startIdx: 0, endIdx: 0 };
	}
	if (colWidth <= 0) {
		return { startIdx: Math.min(frozen, totalCols), endIdx: totalCols };
	}
	if (currentColSizing.overrides.size === 0) {
		// Uniform fast path -- BYTE-IDENTICAL to the pre-Wave-G code (the keystone invariant).
		// The body's effective viewport (the space NOT covered by the frozen band).
		const bodyViewport = Math.max(0, viewportWidth - frozen * colWidth);
		// The first SCROLLING body column = frozen offset + how far the body has scrolled. Clamp so a stale
		// large scrollLeft (data shrank) can't open an empty window past the last column.
		const maxFirst = Math.max(frozen, totalCols - 1);
		const firstVisible = Math.min(maxFirst, frozen + Math.max(0, Math.floor(scrollLeft / colWidth)));
		const visibleCount = Math.max(1, Math.ceil(bodyViewport / colWidth));
		// Never start a body column before the frozen offset (the frozen columns are painted separately).
		const startIdx = Math.max(frozen, firstVisible - overscan);
		const endIdx = Math.min(totalCols, firstVisible + visibleCount + overscan);
		return { startIdx, endIdx };
	}
	// Wave G variable-width body window. The frozen band consumes `frozenWidthPx` (= summed widths of the
	// first `frozen` columns); the body content origin is that offset, advanced by the live `scrollLeft`.
	// The first/last visible body columns are the inverse cumulative lookups at the body's left/right edge.
	const frozenWidthPx = offsetBefore(currentColSizing, frozen);
	const bodyViewport = Math.max(0, viewportWidth - frozenWidthPx);
	const maxFirst = Math.max(frozen, totalCols - 1);
	const firstVisible = Math.min(maxFirst, Math.max(frozen, indexAtOffset(currentColSizing, frozenWidthPx + scrollLeft)));
	const lastVisible = Math.min(maxFirst, Math.max(frozen, indexAtOffset(currentColSizing, frozenWidthPx + scrollLeft + bodyViewport)));
	const startIdx = Math.max(frozen, firstVisible - overscan);
	const endIdx = Math.min(totalCols, lastVisible + 1 + overscan);
	return { startIdx, endIdx };
}

/**
 * **W3 frozen panes** -- the visible SCROLLING-BODY ROW range `[startIdx, endIdx)` (the rows that scroll
 * UNDER the frozen band), given `frozenRowCount` rows are pinned at `[HEADER_HEIGHT, HEADER_HEIGHT +
 * frozenRowsHeight)`. The exact row twin of {@link computeVisibleBodyColRange} (kept as a SEPARATE
 * function -- not a shared generic -- so a height/width arg transposition is impossible, mirroring the
 * `computeVisibleRowRange`/`computeVisibleColRange` split). The frozen rows are painted separately at
 * their locked Y, so they are excluded; the body's first visible row is `frozenRowCount +
 * floor(scrollTop / rowHeight)`. With `frozenRowCount === 0` this is byte-identical to
 * `computeVisibleRowRange` (in `cellRender.ts`). Pure + golden-tested.
 *
 * `bodyHeight` is the FULL body height below the header (`cssHeight - HEADER_HEIGHT`); the frozen band is
 * subtracted INSIDE (the body's effective viewport = `bodyHeight - frozenRowsHeight`), matching how the
 * renderer already passes `cssHeight - HEADER_HEIGHT` as the row viewport.
 */
export function computeVisibleBodyRowRange(
	scrollTop: number,
	bodyHeight: number,
	totalRows: number,
	rowHeight: number,
	overscan: number,
	frozenRowCount: number,
): { startIdx: number; endIdx: number } {
	const frozen = Math.max(0, frozenRowCount);
	if (totalRows === 0) {
		return { startIdx: 0, endIdx: 0 };
	}
	if (rowHeight <= 0) {
		return { startIdx: Math.min(frozen, totalRows), endIdx: totalRows };
	}
	if (currentRowSizing.overrides.size === 0) {
		// Uniform fast path -- BYTE-IDENTICAL to the pre-Wave-G-rows code (the keystone invariant).
		const bodyViewport = Math.max(0, bodyHeight - frozen * rowHeight);
		const maxFirst = Math.max(frozen, totalRows - 1);
		const firstVisible = Math.min(maxFirst, frozen + Math.max(0, Math.floor(scrollTop / rowHeight)));
		const visibleCount = Math.max(1, Math.ceil(bodyViewport / rowHeight));
		const startIdx = Math.max(frozen, firstVisible - overscan);
		const endIdx = Math.min(totalRows, firstVisible + visibleCount + overscan);
		return { startIdx, endIdx };
	}
	// Wave G-rows variable-height body window (the exact mirror of computeVisibleBodyColRange's variable path).
	// The frozen band consumes `frozenHeightPx` (= summed heights of the first `frozen` rows); the body content
	// origin is that offset, advanced by the live `scrollTop`. First/last visible body rows are the inverse
	// cumulative lookups at the body's top/bottom edge.
	const frozenHeightPx = offsetBefore(currentRowSizing, frozen);
	const bodyViewport = Math.max(0, bodyHeight - frozenHeightPx);
	const maxFirst = Math.max(frozen, totalRows - 1);
	const firstVisible = Math.min(maxFirst, Math.max(frozen, indexAtOffset(currentRowSizing, frozenHeightPx + scrollTop)));
	const lastVisible = Math.min(maxFirst, Math.max(frozen, indexAtOffset(currentRowSizing, frozenHeightPx + scrollTop + bodyViewport)));
	const startIdx = Math.max(frozen, firstVisible - overscan);
	const endIdx = Math.min(totalRows, lastVisible + 1 + overscan);
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
 * defined behaviour: a publish may target a range (range-aware bind), but the kernel's G2 guard rejects
 * overlapping published regions, so at most one range contains a cell -- first-match is unambiguous, and
 * is the rule if that ever changes. Pure + unit-tested so the formula-bar chip and the hover tooltip read
 * it headlessly-verified.
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
 *
 * **W3 frozen panes**: the caller passes the EFFECTIVE band size = sticky band + frozen-band pixels
 * (`HEADER_HEIGHT + frozenRowsHeight` / `gutterW + frozenColsWidth`), so a cell hidden under a FROZEN
 * band scrolls into the body pane exactly as one hidden under the header/gutter does. A cell that IS in
 * the frozen band itself is never the scroll target (it is always on screen), so this is unchanged for
 * the no-freeze path.
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
	// Wave G/G-rows: each axis maps via its inverse cumulative lookup (reduces to `floor((contentY -
	// HEADER_HEIGHT) / ROW_HEIGHT)` / `floor((contentX - gutterW) / COL_WIDTH)` when nothing is resized).
	const row = indexAtOffset(currentRowSizing, contentY - HEADER_HEIGHT);
	const col = indexAtOffset(currentColSizing, contentX - gutterW);
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
 *
 * **W3 frozen panes**: a point inside a FROZEN band maps to the frozen cell directly (the band is
 * locked at a known viewport position, NOT scrolled), so the scroll offset must NOT be added there;
 * only a point in the scrolling body adds the (body-adjusted) scroll. {@link hitTestViewportFrozen}
 * handles the freeze case; this base function is the `frozenRowCount===0 && frozenColCount===0` path
 * (kept so every existing caller / golden test is byte-identical).
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

/**
 * **W3 frozen panes** -- map a VIEWPORT-LOCAL point to the cell under it WITH a frozen band of
 * `frozenRowCount` rows + `frozenColCount` cols. Generalizes {@link hitTestViewport}: the viewport is
 * divided into four panes by the band edges --
 *   - the sticky header/gutter/corner reject as before (a click there is never a cell);
 *   - the FROZEN row band `[HEADER_HEIGHT, HEADER_HEIGHT + frozenRowsHeight)` maps Y WITHOUT `scrollTop`
 *     (the frozen rows are pinned), to content row `floor((localY - HEADER_HEIGHT)/ROW_HEIGHT)` (always
 *     `< frozenRowCount`);
 *   - the FROZEN col band `[gutterW, gutterW + frozenColsWidth)` maps X WITHOUT `scrollLeft`;
 *   - the SCROLLING body adds the scroll on each axis whose pointer is past the frozen band, then
 *     offsets by the frozen count (the body's first column is `frozenColCount`, not `floor(scroll/..)`).
 *
 * A point can be in the frozen-row band on Y but the scrolling body on X (the top-frozen strip over a
 * scrolled column), etc. -- each axis is resolved independently, which is exactly the Excel four-pane
 * behaviour. With both counts 0 this reduces to {@link hitTestViewport} (verified by a golden test).
 * Pure -- the canvas hit-test threads the live frozen counts in.
 */
export function hitTestViewportFrozen(
	localX: number,
	localY: number,
	scrollLeft: number,
	scrollTop: number,
	gutterW: number,
	frozenRowCount: number,
	frozenColCount: number,
): { row: number; col: number } | null {
	if (localY < HEADER_HEIGHT) {
		return null; // sticky column band (or corner)
	}
	if (localX < gutterW) {
		return null; // sticky row gutter (or corner)
	}
	const fRows = Math.max(0, frozenRowCount);
	const fCols = Math.max(0, frozenColCount);
	// Wave G/G-rows: each frozen band is the cumulative extent of the first N rows/cols (reduces to
	// `N * ROW_HEIGHT` / `N * COL_WIDTH` when nothing is resized).
	const frozenRowsPx = offsetBefore(currentRowSizing, fRows);
	const frozenColsPx = offsetBefore(currentColSizing, fCols);
	// Resolve each axis: in the frozen band the pointer maps to the pinned cell (no scroll); past it the
	// pointer maps to a scrolling body cell (add the scroll, offset by the frozen count).
	let row: number;
	if (localY < HEADER_HEIGHT + frozenRowsPx) {
		row = indexAtOffset(currentRowSizing, localY - HEADER_HEIGHT);
	} else {
		// Body Y: the band consumed `frozenRowsPx` of the viewport; the body content origin is `frozenRowsPx`
		// (= offsetBefore(fRows)), advanced by `scrollTop`, plus the in-body local offset -- the inverse
		// cumulative lookup over that ABSOLUTE content-Y names the body row (mirrors the column body branch;
		// reduces to `fRows + floor((bodyLocalY+scrollTop)/ROW_HEIGHT)` when no row is resized).
		const bodyLocalY = localY - (HEADER_HEIGHT + frozenRowsPx);
		row = indexAtOffset(currentRowSizing, frozenRowsPx + scrollTop + bodyLocalY);
	}
	// Wave G: both branches map content-X -> column via the inverse cumulative-width lookup. Frozen band:
	// content-X is `localX - gutterW` (no scroll). Body: the body content origin is `frozenColsPx` (=
	// offsetBefore(fCols)), advanced by `scrollLeft`, plus the in-body local offset. Reduces to the legacy
	// `floor(.../COL_WIDTH)` / `fCols + floor(...)` when no column is resized.
	let col: number;
	if (localX < gutterW + frozenColsPx) {
		col = indexAtOffset(currentColSizing, localX - gutterW);
	} else {
		const bodyLocalX = localX - (gutterW + frozenColsPx);
		col = indexAtOffset(currentColSizing, frozenColsPx + scrollLeft + bodyLocalX);
	}
	if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) {
		return null;
	}
	return { row, col };
}

/**
 * **Wave G column sizing** -- given a VIEWPORT-LOCAL X inside the column-letter band (the caller checks
 * `localY < HEADER_HEIGHT`), return the column index whose RIGHT edge the pointer is grabbing for a
 * resize, or `-1` if the pointer is not within {@link RESIZE_GRAB_PX} of any column border. Excel
 * convention: grabbing a column's right edge resizes THAT column; grabbing its left edge resizes the
 * PREVIOUS column. Freeze-aware: frozen columns are pinned (no scroll), body columns carry `scrollLeft`,
 * exactly as {@link hitTestViewportFrozen} maps them -- so the divider between the frozen band and the
 * body resizes the last frozen column. Pure; the renderer's `cursorAt` + the resize-drag pointerdown
 * both consult it. With no resized column this still works (uniform widths via the binding).
 */
export function colResizeBorderAt(
	localX: number,
	scrollLeft: number,
	gutterW: number,
	frozenColCount: number,
): number {
	if (localX < gutterW) {
		return -1; // row-number gutter / corner -- never a column border
	}
	const fCols = Math.max(0, frozenColCount);
	const frozenColsPx = offsetBefore(currentColSizing, fCols);
	// The divider between the frozen band and the scrolling body is a FIXED seam at `gutterW + frozenColsPx`
	// (the frozen band never scrolls). Grabbing within RESIZE_GRAB_PX of it -- from EITHER side -- resizes the
	// LAST frozen column. Without this explicit check, a body-side grab maps to a SCROLLED body edge and
	// misses the seam once `scrollLeft > RESIZE_GRAB_PX` (the grab zone would be half-width). Checked before
	// the band split so the right side of the divider is always grabbable.
	if (fCols > 0 && Math.abs(localX - (gutterW + frozenColsPx)) <= RESIZE_GRAB_PX) {
		return fCols - 1;
	}
	// The column under the pointer + its local left/right edges. Frozen band: pinned (no scroll). Body:
	// the body content origin is `frozenColsPx`, advanced by `scrollLeft`, so each edge subtracts it.
	let col: number;
	let leftEdge: number;
	let rightEdge: number;
	if (localX < gutterW + frozenColsPx) {
		col = Math.min(Math.max(0, indexAtOffset(currentColSizing, localX - gutterW)), MAX_COLS - 1);
		leftEdge = gutterW + offsetBefore(currentColSizing, col);
		rightEdge = gutterW + offsetBefore(currentColSizing, col + 1);
	} else {
		const bodyLocalX = localX - (gutterW + frozenColsPx);
		col = Math.min(Math.max(0, indexAtOffset(currentColSizing, frozenColsPx + scrollLeft + bodyLocalX)), MAX_COLS - 1);
		leftEdge = gutterW + offsetBefore(currentColSizing, col) - scrollLeft;
		rightEdge = gutterW + offsetBefore(currentColSizing, col + 1) - scrollLeft;
	}
	// Right-edge grab wins ties (a narrow column < 2*GRAB stays resizable from its own right edge).
	if (localX >= rightEdge - RESIZE_GRAB_PX) {
		return col;
	}
	if (localX <= leftEdge + RESIZE_GRAB_PX && col - 1 >= 0) {
		return col - 1;
	}
	return -1;
}

/**
 * **Wave G3b AutoFilter** -- the painted/clickable filter-triangle box inside a header cell: `FILTER_TRIANGLE_W`
 * px wide, sitting `FILTER_TRIANGLE_RIGHT_GAP` px in from the column's right edge (which clears the
 * {@link RESIZE_GRAB_PX} resize-grab zone so the two never collide). A column narrower than
 * {@link FILTER_TRIANGLE_MIN_COL_W} gets no triangle (it would overlap the label / the previous column) -- the
 * paint and the hit-test gate on the SAME minimum so they never disagree.
 */
export const FILTER_TRIANGLE_W = 14;
export const FILTER_TRIANGLE_RIGHT_GAP = 5;
export const FILTER_TRIANGLE_MIN_COL_W = FILTER_TRIANGLE_W + FILTER_TRIANGLE_RIGHT_GAP + 2;

/**
 * **Wave G3b AutoFilter** -- given a VIEWPORT-LOCAL X inside the column-letter band (the caller checks
 * `localY < HEADER_HEIGHT`), return the column whose filter-triangle box contains the pointer, or `-1`. Only
 * columns in the active filter range `[minCol, maxCol]` carry a triangle. Frozen-aware exactly like
 * {@link colResizeBorderAt} (frozen cols pinned, body cols carry `scrollLeft`), so the box lands on the painted
 * glyph under freeze. The caller gates the call on AutoFilter being active; this returns `-1` for any column
 * too narrow for a triangle (sharing {@link FILTER_TRIANGLE_MIN_COL_W} with the paint). Pure; the header-click
 * pointerdown consults it AFTER {@link colResizeBorderAt} (a resize-border grab wins the shared right edge).
 */
export function filterTriangleColAt(
	localX: number,
	scrollLeft: number,
	gutterW: number,
	frozenColCount: number,
	minCol: number,
	maxCol: number,
): number {
	if (localX < gutterW) {
		return -1; // gutter / corner
	}
	const fCols = Math.max(0, frozenColCount);
	const frozenColsPx = offsetBefore(currentColSizing, fCols);
	// `paintLeft` is the column's ROUNDED screen-left -- `Math.round(colX(col) - effScrollLeft)` -- EXACTLY the
	// value the renderer paints the header cell (and thus the triangle) at, so the clickable box and the painted
	// glyph agree to the pixel even when `colX - scroll` is fractional (5-lane-audit MED). Frozen cols are pinned
	// (effScroll 0); body cols carry `scrollLeft` -- mirroring colResizeBorderAt / paintColLabels.
	let col: number;
	let paintLeft: number;
	if (localX < gutterW + frozenColsPx) {
		col = Math.min(Math.max(0, indexAtOffset(currentColSizing, localX - gutterW)), MAX_COLS - 1);
		paintLeft = Math.round(gutterW + offsetBefore(currentColSizing, col));
	} else {
		const bodyLocalX = localX - (gutterW + frozenColsPx);
		col = Math.min(Math.max(0, indexAtOffset(currentColSizing, frozenColsPx + scrollLeft + bodyLocalX)), MAX_COLS - 1);
		paintLeft = Math.round(gutterW + offsetBefore(currentColSizing, col) - scrollLeft);
	}
	if (col < minCol || col > maxCol) {
		return -1; // outside the filter range -- no triangle
	}
	const colWidth = sizeAt(currentColSizing, col);
	if (colWidth < FILTER_TRIANGLE_MIN_COL_W) {
		return -1; // too narrow to carry a triangle (matches the paint gate)
	}
	const boxRight = paintLeft + colWidth - FILTER_TRIANGLE_RIGHT_GAP;
	const boxLeft = boxRight - FILTER_TRIANGLE_W;
	return localX >= boxLeft && localX <= boxRight ? col : -1;
}

/**
 * **Wave G-rows row sizing** -- given a VIEWPORT-LOCAL Y inside the row-number gutter (the caller checks
 * `localX < gutterW`), return the row index whose BOTTOM edge the pointer is grabbing for a resize, or
 * `-1` if the pointer is not within {@link RESIZE_GRAB_PX} of any row border. Excel convention: grabbing a
 * row's bottom edge resizes THAT row; grabbing its top edge resizes the PREVIOUS row. Freeze-aware: frozen
 * rows are pinned (no scroll), body rows carry `scrollTop`, exactly as {@link hitTestViewportFrozen} maps
 * them -- so the divider between the frozen band and the body resizes the last frozen row. The Y mirror of
 * {@link colResizeBorderAt} (`headerHeight` plays the role `gutterW` plays there). Pure; the renderer's
 * `cursorAt` + the resize-drag pointerdown both consult it. With no resized row this still works (uniform
 * heights via the binding).
 */
export function rowResizeBorderAt(
	localY: number,
	scrollTop: number,
	headerHeight: number,
	frozenRowCount: number,
): number {
	if (localY < headerHeight) {
		return -1; // column-letter band / corner -- never a row border
	}
	const fRows = Math.max(0, frozenRowCount);
	const frozenRowsPx = offsetBefore(currentRowSizing, fRows);
	// The divider between the frozen band and the scrolling body is a FIXED seam at `headerHeight +
	// frozenRowsPx` (the frozen band never scrolls). Grabbing within RESIZE_GRAB_PX of it -- from EITHER side
	// -- resizes the LAST frozen row (mirrors the column frozen/body divider). Checked before the band split
	// so the bottom side of the divider is always grabbable once `scrollTop > RESIZE_GRAB_PX`.
	if (fRows > 0 && Math.abs(localY - (headerHeight + frozenRowsPx)) <= RESIZE_GRAB_PX) {
		return fRows - 1;
	}
	// The row under the pointer + its local top/bottom edges. Frozen band: pinned (no scroll). Body: the
	// body content origin is `frozenRowsPx`, advanced by `scrollTop`, so each edge subtracts it.
	let row: number;
	let topEdge: number;
	let bottomEdge: number;
	if (localY < headerHeight + frozenRowsPx) {
		row = Math.min(Math.max(0, indexAtOffset(currentRowSizing, localY - headerHeight)), MAX_ROWS - 1);
		topEdge = headerHeight + offsetBefore(currentRowSizing, row);
		bottomEdge = headerHeight + offsetBefore(currentRowSizing, row + 1);
	} else {
		const bodyLocalY = localY - (headerHeight + frozenRowsPx);
		row = Math.min(Math.max(0, indexAtOffset(currentRowSizing, frozenRowsPx + scrollTop + bodyLocalY)), MAX_ROWS - 1);
		topEdge = headerHeight + offsetBefore(currentRowSizing, row) - scrollTop;
		bottomEdge = headerHeight + offsetBefore(currentRowSizing, row + 1) - scrollTop;
	}
	// Bottom-edge grab wins ties (a short row < 2*GRAB stays resizable from its own bottom edge).
	if (localY >= bottomEdge - RESIZE_GRAB_PX) {
		return row;
	}
	if (localY <= topEdge + RESIZE_GRAB_PX && row - 1 >= 0) {
		return row - 1;
	}
	return -1;
}

/**
 * **Wave G-rows row sizing + Wave F window split** -- the split-aware row mirror of {@link rowResizeBorderAt}.
 * While a horizontal split is active the row gutter paints in TWO panes at INDEPENDENT effective scrolls (top
 * pane: `topScrollTop`; bottom pane: `botScrollTop - (splitBarY - headerHeight)`), so the resize border must be
 * detected against the pane the pointer is in, NOT the single DOM scroll. Picks the pane by `localY < splitBarY`
 * (the bar biases to the bottom, exactly as {@link hitTestSplit}) and delegates to {@link rowResizeBorderAt}
 * with that pane's effective scroll. A split has NO frozen rows (split + freeze are mutually exclusive), so
 * `frozenRowCount` is always 0 here. Pure; the renderer's `cursorAt` + the resize-drag pointerdown consult it
 * whenever a split is active.
 */
export function rowResizeBorderAtSplit(
	localY: number,
	splitBarY: number,
	topScrollTop: number,
	botScrollTop: number,
	headerHeight: number,
): number {
	if (localY < headerHeight) {
		return -1; // column-letter band / corner
	}
	const inTop = localY < splitBarY;
	// The bottom pane's effective scroll = the DOM scroll shifted up by the band offset (mirrors
	// `paintSplitWindow`'s `botEff = botScroll - bandOffset`); the top pane uses its synthetic scroll directly.
	const effScrollTop = inTop ? topScrollTop : botScrollTop - (splitBarY - headerHeight);
	return rowResizeBorderAt(localY, effScrollTop, headerHeight, 0);
}

// --- Wave F window split (R5, 2026-06-18) ----------------------------------------------------------
//
// A horizontal window SPLIT divides the viewport into a TOP and a BOTTOM pane that scroll
// INDEPENDENTLY on Y (both share the live horizontal scroll). Unlike a freeze (which pins the leading
// rows at effective-scroll 0), each split pane is a full independent windowed view of the SAME sheet:
// the bottom pane tracks the live DOM scroll, the top pane carries its own SYNTHETIC scroll. The
// renderer paints both panes through the same `paintCellRegion` used for freeze, feeding the top pane
// `topScrollTop` where freeze fed `0`. Split + freeze are mutually exclusive (Excel canon). All the
// viewport math lives here (the doctrine), pure + unit-tested, so the renderer threads live values in.

/** The visible half-open row ranges for the two panes of a horizontal split, plus each pane's pixel
 * band height. `top` covers viewport `[HEADER_HEIGHT, splitBarY)`, `bottom` covers `[splitBarY,
 * cssHeight)`. See {@link splitPaneRowRanges}. */
export interface SplitPaneRanges {
	readonly top: { startIdx: number; endIdx: number };
	readonly bottom: { startIdx: number; endIdx: number };
	readonly topBandHeight: number;
	readonly botBandHeight: number;
}

/**
 * **Wave F window split** -- clamp a raw horizontal-split-bar Y (viewport CSS px) to a position that
 * leaves at least one row visible in BOTH panes. Returns `0` ("no split") when the viewport is too
 * short to hold two one-row panes below the header, or for a non-finite / `<= 0` input -- mirroring how
 * `0` is the no-op sentinel for {@link clampFrozenCount}. The bar is free-floating (a dragged pixel
 * position, not snapped to a row boundary -- each pane is an independent window so a partially-clipped
 * row at the bar is fine, exactly as Excel renders a dragged split); the value is rounded to a whole
 * CSS px. The host->webview wire carries this raw, so a malformed value must never corrupt the geometry.
 */
export function clampSplitBarY(rawY: number, cssHeight: number): number {
	if (!Number.isFinite(rawY) || rawY <= 0) {
		return 0;
	}
	// Wave G-rows: deliberately uses the DEFAULT ROW_HEIGHT (not the resized height of row 0 / the last
	// row) as the one-row margin. The bar is a free-floating DROP BOUND, not a row-position map, so a
	// partially-clipped resized row at the split is acceptable (exactly as Excel renders a dragged split) --
	// leaving this uniform keeps the Wave-F split-bar goldens byte-identical.
	const minBarY = HEADER_HEIGHT + ROW_HEIGHT; // top pane >= ~1 row
	const maxBarY = cssHeight - ROW_HEIGHT; // bottom pane >= ~1 row
	if (maxBarY < minBarY) {
		return 0; // viewport too short for two panes
	}
	return Math.min(maxBarY, Math.max(minBarY, Math.round(rawY)));
}

/** The visible row range for one split pane: a band of `bandHeight` px scrolled to `scrollTop`. Mirrors
 * `cellRender.computeVisibleRowRange`'s clamp + overscan EXACTLY (kept here, not imported, so
 * `gridLayoutA1` stays the leaf module + the split panes match the body-window semantics; a golden test
 * ties the two together). A stale large `scrollTop` (data shrank) clamps to the last rows, never an
 * empty window. */
function splitPaneRowRange(scrollTop: number, bandHeight: number, overscan: number): { startIdx: number; endIdx: number } {
	if (ROW_HEIGHT <= 0) {
		return { startIdx: 0, endIdx: MAX_ROWS };
	}
	const maxFirst = Math.max(0, MAX_ROWS - 1);
	if (currentRowSizing.overrides.size === 0) {
		// Uniform fast path -- BYTE-IDENTICAL to the pre-Wave-G-rows code (the keystone invariant).
		const firstVisible = Math.min(maxFirst, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)));
		const visibleCount = Math.max(1, Math.ceil(Math.max(0, bandHeight) / ROW_HEIGHT));
		const startIdx = Math.max(0, firstVisible - overscan);
		const endIdx = Math.min(MAX_ROWS, firstVisible + visibleCount + overscan);
		return { startIdx, endIdx };
	}
	// Wave G-rows variable-height pane window: first/last visible rows are the inverse cumulative lookups at
	// the pane band's top/bottom edge (a single divide can't count variable heights). A split has no frozen
	// band (split + freeze are mutually exclusive), so the offsets are the raw pane scroll.
	const firstVisible = Math.min(maxFirst, Math.max(0, indexAtOffset(currentRowSizing, scrollTop)));
	const lastVisible = Math.min(maxFirst, Math.max(0, indexAtOffset(currentRowSizing, scrollTop + Math.max(0, bandHeight))));
	const startIdx = Math.max(0, firstVisible - overscan);
	const endIdx = Math.min(MAX_ROWS, lastVisible + 1 + overscan);
	return { startIdx, endIdx };
}

/**
 * **Wave F window split** -- the visible row range for EACH pane of a horizontal split, given the two
 * independent vertical scroll offsets and the bar position. The top pane's band is `[HEADER_HEIGHT,
 * splitBarY)` (height `splitBarY - HEADER_HEIGHT`) scrolled by `topScrollTop`; the bottom pane's band is
 * `[splitBarY, cssHeight)` (height `cssHeight - splitBarY`) scrolled by `botScrollTop` (the live DOM
 * scroll). Each range comes from {@link splitPaneRowRange} so both match the single-pane window exactly.
 * Pure + golden-tested.
 */
export function splitPaneRowRanges(
	topScrollTop: number,
	botScrollTop: number,
	splitBarY: number,
	cssHeight: number,
	overscan: number,
): SplitPaneRanges {
	const topBandHeight = Math.max(0, splitBarY - HEADER_HEIGHT);
	const botBandHeight = Math.max(0, cssHeight - splitBarY);
	return {
		top: splitPaneRowRange(topScrollTop, topBandHeight, overscan),
		bottom: splitPaneRowRange(botScrollTop, botBandHeight, overscan),
		topBandHeight,
		botBandHeight,
	};
}

/**
 * **Wave F window split** -- clamp a top-pane SYNTHETIC scroll to `[0, maxScroll]` so a wheel/keyboard
 * scroll can never run past the last row (the bottom pane is bounded by the native DOM scroller; the top
 * pane has no scrollbar, so its bound is enforced here). `maxScroll = MAX_ROWS*ROW_HEIGHT - bandHeight`
 * (>= 0): the same content extent the spacer gives the DOM scroller, minus the visible band. A
 * non-finite / `<= 0` input clamps to `0`.
 */
export function clampSplitScroll(scrollTop: number, bandHeight: number): number {
	if (!Number.isFinite(scrollTop) || scrollTop <= 0) {
		return 0;
	}
	// Wave G-rows: the content extent the spacer gives the DOM scroller is the summed row heights (reduces to
	// `MAX_ROWS * ROW_HEIGHT` when no row is resized) -- so the synthetic top-pane scroll tracks it exactly.
	const maxScroll = Math.max(0, totalExtent(currentRowSizing) - Math.max(0, bandHeight));
	return Math.min(maxScroll, scrollTop);
}

/**
 * **Wave F window split** -- map a VIEWPORT-LOCAL point to its cell WITH a horizontal split bar at
 * `splitBarY`. The viewport divides into a TOP pane `[HEADER_HEIGHT, splitBarY)` scrolled by
 * `topScrollTop` and a BOTTOM pane `[splitBarY, cssHeight)` scrolled by `botScrollTop`; both share
 * `scrollLeft` on X. The sticky header (`localY < HEADER_HEIGHT`) and gutter (`localX < gutterW`) reject
 * as in {@link hitTestViewport}. A point at/below the bar resolves in the bottom pane (the bar belongs
 * to no cell; biasing down avoids a dead band). The per-axis math matches {@link hitTestContent}: convert
 * the pane-local Y to a content-row offset (`(localY - paneTopPx) + effScrollTop`), re-add HEADER_HEIGHT
 * for `hitTestContent`, and add `scrollLeft` on X exactly as the single-pane path does. Pure.
 */
export function hitTestSplit(
	localX: number,
	localY: number,
	splitBarY: number,
	topScrollTop: number,
	botScrollTop: number,
	scrollLeft: number,
	gutterW: number,
): { row: number; col: number } | null {
	if (localY < HEADER_HEIGHT) {
		return null; // sticky column band (or corner)
	}
	if (localX < gutterW) {
		return null; // sticky row gutter (or corner)
	}
	const inTop = localY < splitBarY;
	const paneTopPx = inTop ? HEADER_HEIGHT : splitBarY;
	const effScrollTop = inTop ? topScrollTop : botScrollTop;
	// Pane-local content-row offset, expressed in the content frame `hitTestContent` expects (which
	// subtracts HEADER_HEIGHT before dividing by ROW_HEIGHT). X is the single-pane body mapping.
	const contentY = (localY - paneTopPx) + effScrollTop + HEADER_HEIGHT;
	const contentX = localX + scrollLeft;
	return hitTestContent(contentX, contentY, gutterW);
}
