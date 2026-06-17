/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 (2026-06-03) -- Canvas2D renderer for the A1 spreadsheet grid.**
 *
 * Supersedes the FE-0b cell-LIST paint. Draws a real Excel-shaped sheet onto a single `<canvas>`
 * that overlays the scroller's viewport: a sticky **column-letter band** (A,B,C…) at the top, a
 * sticky **row-number gutter** (1,2,3…) on the left, a **corner box**, gridlines over the visible
 * cell window, the sparse snapshot's populated values at their (row,col), and the active-cell
 * **selection box**. Geometry comes from the pure `gridLayoutA1.ts`; values format via
 * `cellRender.formatCellValue`.
 *
 * **Paint paths.** {@link draw} is the always-correct full redraw of the visible window (~viewport
 * rows × cols; empty cells are gridlines-only, so a few hundred ops per frame). FE-2-0 Phase 3 adds two
 * partial-redraw fast paths over it, driven by the pure `gridBlitA1.ts` math: {@link drawScroll}
 * (self-blit the overlap of a pure-axis scroll, repaint only the exposed strip) and {@link drawDamage}
 * (repaint only the A1 rows whose snapshot/error state changed). Both fall back to a full {@link draw}
 * whenever the pure math returns `null`, and `DEBUG_BLIT_VERIFY` checks partial==full pixel-for-pixel.
 *
 * DOM/canvas-touching -- not unit-tested (no headless 2D context); the pure layout math is golden-
 * tested in `gridLayoutA1.ts` and the drawing is covered by the behavioral smoke + the closure audit.
 */

import type { QuantbookCellSnapshot, TableSnapshotJson } from '../../src/quantbook/types';
import { clampDisplayString, formatCellValue, isRenderableValue } from './cellRender';
import { borderWidthPx, bordersToPaint, type ResolvedBorderEdge, type ResolvedCellStyle } from './cellStyleModel';
import type { ScrollBlit } from './gridBlitA1';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	ROW_HEIGHT,
	type SelectionRect,
	clampFrozenCount,
	colX,
	columnLabel,
	computeVisibleBodyColRange,
	computeVisibleBodyRowRange,
	frozenColsWidth,
	frozenRowsHeight,
	gutterWidth,
	isInExtent,
	rowY,
	truncateToWidth,
} from './gridLayoutA1';

const CELL_PAD = 8;
const OVERSCAN = 2;
const MEASURE_CACHE_MAX = 5000;
const SELECTION_BORDER_PX = 2;
// W-G fill handle: side length (CSS px) of the small solid square at the selection's bottom-right corner
// the user drags to fill, and the dash period of the drag-preview outline.
const FILL_HANDLE_PX = 6;
// W-G bound-cell indicator: side length (CSS px) of the filled corner triangle marking a cell a reactive
// published variable drives. A small top-right marker (the Excel note-marker convention).
const PUBLISHED_BADGE_PX = 7;
// FE-3 colored references: stroke width (CSS px) of a formula ref-highlight box, and the alpha of its faint
// interior fill wash. 2px matches the selection ring's weight (it reads as a deliberate outline, not a
// gridline); the low fill alpha tints the referenced range without obscuring its cell values.
const REF_HIGHLIGHT_PX = 2;
const REF_HIGHLIGHT_FILL_ALPHA = 0.10;

/**
 * **FE-2-0 Phase 3 (2026-06-04)** -- when true, every partial paint ({@link CanvasGridRenderer.drawScroll}
 * / {@link CanvasGridRenderer.drawDamage}) is followed by a full repaint and a pixel-for-pixel compare;
 * any mismatch is `console.error`-ed LOUD (No-Fallbacks: a blit/damage that diverges from the full draw
 * is a BUG, surfaced, never silently shipped). Off in production (the verify defeats the optimization +
 * uses `getImageData`); a developer flips it to validate the partial paths against the full-draw oracle.
 */
const DEBUG_BLIT_VERIFY = false;

/** Extra CSS px padded around a damage band's clip so a fractional `rowY-scrollTop` (the renderer rounds
 * paint origins) can never leave a sub-pixel sliver of the band's edge unpainted. Over-painting into an
 * adjacent row is idempotent (that row repaints to its identical current value).
 *
 * **FE-5 W-R (2026-06-12)**: widened from 1 to 3 (the widest border: `thick`/`double` per `borderWidthPx`)
 * so a damage repaint of a row whose
 * cell carries a THICK/DOUBLE bottom or top border (up to 3 CSS px, inside-aligned within the cell) cannot
 * clip the border's far extent. The old 1px pad would have shaved a 3px border down to a 1px sliver on a
 * style-only damage repaint -- the exact silent-render-miss this wave guards against. Still bounded + idempotent. */
const DAMAGE_CLIP_PAD = 3;

/**
 * **Brand accent (2026-06-10, supersedes the Sheets-blue constant)** -- the accent that drives every
 * spreadsheet accent surface, the way Excel uses its green and Sheets its blue: the active-cell ring,
 * the multi-cell selection border + translucent fill, the row/col header highlight band for the selected
 * range, the active header letter/number text + underline, the fill handle + fill-preview dash, and the
 * select-all corner triangle. It is **Quantlab's BRAND color, resolved from the theme** -- the
 * `--vscode-quantlabAccent` theme var with this `#FF7331` orange fallback, the exact pattern the rest of
 * the product uses (`extensions/quantlab/media/tokens.css`: `--ql-accent: var(--vscode-quantlabAccent,
 * #FF7331)`; hover `#E5672C` / active `#CC5C22` exist there too, but the grid derives its hover/active
 * states as ALPHA TINTS of the base instead -- canvas paints, not CSS pseudo-states). Resolved in
 * {@link CanvasGridRenderer.readPalette} through the SAME `getComputedStyle` read as every other theme
 * color (cached in the palette, refreshed by {@link CanvasGridRenderer.refreshTheme}), so a theme that
 * overrides the brand accent wins and the grid follows live theme switches. The OPAQUE accent is
 * theme-provided (contrast on light AND dark themes is the theme author's contract); only the translucent
 * washes below are derived from it, via {@link CanvasGridRenderer.parseCssColorRgb}.
 */
const QUANTLAB_ACCENT_FALLBACK = '#FF7331';
/** Alpha for the active row/col HEADER highlight band (Excel tints the selected range's headers; Sheets
 * uses a pale accent wash). Low so the header letter/number stays legible on top of the wash. */
const ACCENT_HEADER_FILL_ALPHA = 0.16;
/** **Header HOVER wash** -- a FAINTER accent wash painted on the column-letter / row-number cell the
 * pointer is currently over (the Sheets "hover a header" cue). Deliberately lower alpha than
 * {@link ACCENT_HEADER_FILL_ALPHA} so it reads as a transient hover, distinct from the persistent
 * active-selection highlight -- and so the active highlight always wins when both would apply (the draw
 * code only paints the hover wash on a header cell that is NOT in the active/selection tint). */
const ACCENT_HEADER_HOVER_ALPHA = 0.07;
/** Alpha for the multi-cell selection RANGE fill (~15%, per the brand-accent spec). Translucent so cell
 * contents read through the wash -- the focus cell keeps its crisp opaque-accent ring on top. */
const ACCENT_RANGE_FILL_ALPHA = 0.15;
/** Very light gridline (`~#e0e0e0` on white) -- the Sheets gridline on a light theme. On a dark theme the
 * palette derives a faint low-contrast line from `--vscode-panel-border` instead (see readPalette). */
const SHEETS_GRIDLINE_LIGHT = 'rgba(0,0,0,0.10)';

// ============================================================================
// Tables wave (2026-06-13) -- structured-table banding colors.
//
// A structured table ({@link TableSnapshotJson}) paints, OVER the gridlines + UNDER the cell borders/text, a
// header band on its first row (when `hasHeader`), an alternating ~10% tint on its data rows (skipping a
// `hasTotals` last row), and an outer border around the full range. These are RANGE-level paint hints --
// the cell grid draws them directly from the table spec, NOT via the per-cell `styleAt`/`styleId` path.
//
// **Legible on light AND dark.** Defined here as the literal light-theme values the spec named; the dark
// variants are derived in {@link CanvasGridRenderer.readPalette} (a header/band needs a LIGHTER wash on a
// dark editor, the same way `headerBg`/`border` flip by theme). The header is the brand accent at a low
// alpha (so a table reads as a branded block, like Excel's table styles), the band a neutral tint, and the
// border a mid-strength neutral stroke. All are TRANSLUCENT washes so the cell value reads through.
// ============================================================================
/** Alpha for a table HEADER-row band (the brand accent wash on the first row of a table with `hasHeader`).
 * Higher than the data-row band so the header reads as the heavier block, Excel-table-style. */
const TABLE_HEADER_ALPHA = 0.22;
/** Alpha for the ~10% alternating DATA-row band tint (every other data row of a table). Subtle so the
 * banding aids row-tracking without overpowering the cell values. */
const TABLE_BAND_ALPHA = 0.10;
/** The table OUTER-BORDER stroke on a LIGHT theme (a mid-strength neutral, distinctly heavier than the
 * faint gridline so the table's extent reads as a bounded block). The dark variant is derived in
 * {@link CanvasGridRenderer.readPalette}. */
const TABLE_BORDER_COLOR_LIGHT = 'rgba(0,0,0,0.45)';
/** The table outer-border stroke on a DARK theme (a light neutral, the dark-mode analog of the above). */
const TABLE_BORDER_COLOR_DARK = 'rgba(255,255,255,0.45)';
/** The table outer-border stroke WIDTH in CSS px (heavier than the 1px gridline so the extent reads). */
const TABLE_BORDER_WIDTH_PX = 2;

/** The active (selected) cell. */
export interface ActiveCell {
	readonly row: number;
	readonly col: number;
}

/**
 * **FE-1.5 W-G** -- one published target range on the active sheet, in the host->webview wire shape
 * (0-based, INCLUSIVE). The renderer paints a corner badge on each cell inside it. The webview defines
 * this shape itself (the bundle is esbuild-isolated from host runtime); it mirrors the host
 * `PublishedRange` and is validated at the message boundary before it reaches the renderer.
 */
export interface PublishedRange {
	readonly startRow: number;
	readonly startCol: number;
	readonly endRow: number;
	readonly endCol: number;
	readonly name: string;
}

/**
 * **FE-3 colored references (grid ref-highlighting)** -- one referenced cell/range to outline on the grid
 * while a formula is being edited (Excel's colored ref boxes). `rect` is the inclusive 0-based grid rect (a
 * single cell is `min === max`; a range `A1:B2` is one rect); `colorIndex` is the reference's distinct-target
 * color SLOT (an UNBOUNDED index from `computeFormulaRefHighlights` -- the renderer takes it modulo the
 * {@link Palette.refHighlightColors} length, so identical refs share a hue and the module never needs the
 * palette size). The host computes these (only unqualified same-sheet refs are drawable) + threads them in;
 * the renderer paints one 2px stroked box per entry. An additive, independent channel (mirrors
 * `pointPreview`); it never affects cell content / selection.
 */
export interface RefHighlightRect {
	readonly rect: SelectionRect;
	readonly colorIndex: number;
}

/**
 * **FE megaudit M7 (2026-06-03)** -- module-level "already warned" guard for the theme/font CSS-var
 * reads. VS Code always injects the `--vscode-*` variables, so a missing one signals a broken
 * host/theme context; the renderer still falls back to a hardcoded default (so it draws SOMETHING
 * rather than throwing every frame), but a SILENT `value || default` would mask the broken state
 * (No-Fallbacks). We `console.warn` ONCE per missing var.
 */
const warnedMissingVars = new Set<string>();
function warnMissingThemeVar(name: string, fallback: string): void {
	if (warnedMissingVars.has(name)) {
		return;
	}
	warnedMissingVars.add(name);
	console.warn(
		`[sheets-webview] theme variable "${name}" is missing/empty; falling back to "${fallback}". ` +
		`VS Code normally injects this -- the host/theme context may be broken.`,
	);
}

/**
 * **Audit HIGH-1 / C1-MED4 (Phase 1 re-audit, 2026-06-03)** -- one-time loud warning for a snapshot
 * entry that cannot be rendered: its (row,col) is non-integer / out of the Excel extent, OR its value
 * is not a recognized {@link QuantbookCellValue}. The host validates coordinates to u32 and emits only
 * well-formed values, so a violation here signals a binding/version drift or a tampered bundle. We
 * skip the entry from the lookup AND warn (No-Fallbacks: surface, don't silently coerce) -- critically
 * WITHOUT `Number()`-coercing the coordinate first (`Number("")===0`, `Number(null)===0` would
 * silently paint a malformed cell at A1; `Number.isInteger` inside {@link isInExtent} rejects the
 * non-number outright).
 */
let warnedSkippedEntry = false;
function warnSkippedEntry(reason: string, entry: unknown): void {
	if (warnedSkippedEntry) {
		return;
	}
	warnedSkippedEntry = true;
	console.warn(
		`[sheets-webview] a snapshot entry was skipped (${reason}); it cannot be rendered in the A1 ` +
		`extent (${MAX_ROWS}x${MAX_COLS}). The engine/host should not produce such entries -- this ` +
		`signals an upstream contract violation. Offending entry:`,
		entry,
	);
}

/** Whether a snapshot entry can be rendered: a non-null object at an in-extent integer (row,col) whose
 * value is a well-formed {@link QuantbookCellValue} (see `isRenderableValue` -- re-audit finding 1: the
 * value payload, not just its `kind`, must be valid or `formatCellValue`/`clampDisplayString` crash). */
function isRenderableEntry(entry: unknown): entry is QuantbookCellSnapshot['entries'][number] {
	if (entry === null || typeof entry !== 'object') {
		return false;
	}
	const e = entry as { row?: unknown; col?: unknown; value?: unknown };
	// RAW typeof checks BEFORE isInExtent -- isInExtent expects numbers, and a non-number coord must be
	// rejected here (not `Number()`-coerced, which would silently map ""/null to A1).
	if (typeof e.row !== 'number' || typeof e.col !== 'number' || !isInExtent(e.row, e.col)) {
		return false;
	}
	return isRenderableValue(e.value);
}

interface Palette {
	foreground: string;
	background: string;
	headerBg: string;
	headerActiveBg: string;
	border: string;
	descriptionFg: string;
	errorFg: string;
	errorBg: string;
	selectionBorder: string;
	// W-G-2a: translucent fill painted over a multi-cell selection range (the focus cell keeps its
	// crisp border on top). Must be translucent so cell contents show through.
	rangeFill: string;
	// W-G bound-cell indicator: the (opaque) accent for the top-right corner badge on a reactively
	// published cell. A distinct hue from selectionBorder so a selected published cell shows both.
	publishedBadge: string;
	// Sheets retheme: the muted color for INACTIVE header letters / row numbers (Sheets greys the
	// non-active headers; the active one goes `accent`+bold). Derived from `--vscode-descriptionForeground`.
	headerText: string;
	// Sheets retheme: the opaque accent for the ACTIVE row/col header text (the current column letter /
	// row number goes accent + bold, Sheets-style). Same hue as `selectionBorder`.
	accent: string;
	// Sheets retheme (header HOVER): the FAINT accent wash painted on the single header letter / row number
	// the pointer is over. Lower alpha than `headerActiveBg` so the active highlight always reads on top and
	// wins (the draw only paints this on a header cell NOT already in the active/selection tint).
	headerHoverBg: string;
	// Sheets retheme: the muted fill for the small select-all corner triangle (top-left corner box).
	cornerTriangle: string;
	// Tables wave (2026-06-13): a structured table's HEADER-row band (brand accent wash). Translucent so
	// header text reads through; the heavier of the two table washes.
	tableHeaderBand: string;
	// Tables wave: a structured table's alternating DATA-row band (~10% neutral tint). Translucent.
	tableDataBand: string;
	// Tables wave: a structured table's OUTER border stroke (mid-strength neutral, heavier than gridlines;
	// flips light/dark like `border`).
	tableBorder: string;
	// FE-3 colored references: the rotating palette for the formula ref-highlight boxes (Excel's colored ref
	// boxes). A {@link RefHighlightRect.colorIndex} indexes this MODULO its length, so the box hues cycle. The
	// hues are distinct, legible on light + dark, and sourced from the theme `--vscode-charts-*` tokens (with
	// hex fallbacks); deliberately a SEPARATE list from `selectionBorder`/`publishedBadge` so a ref box never
	// reads as the selection ring or a bound-cell badge. Always non-empty (the renderer moduloes by `length`).
	refHighlightColors: readonly string[];
}

/** **Tables wave (2026-06-13)** -- a half-open cell-INDEX range of the pane currently being painted (the
 * windowed `[start, end)` rows + cols `paintCellRegion` iterates). `computeTablePaint` intersects each table
 * against this. */
export interface TableVisibleRange {
	readonly rowStart: number;
	readonly rowEnd: number;
	readonly colStart: number;
	readonly colEnd: number;
}

/** **Tables wave (2026-06-13)** -- the paint plan for ONE on-pane structured table, in cell-INDEX space (the
 * renderer converts to device px via `colX`/`rowY`). All ranges are half-open `[start, end)`. */
export interface TablePaint {
	/** The header row index, or `null` when the table has no header OR the header row is off-pane. The fill
	 * spans `[fillColStart, fillColEnd)`. */
	readonly headerRow: number | null;
	/** The data-row indices to BAND (the alternating zebra rows), clipped to the visible row window and to
	 * the table's data rows (excludes the header row and a `hasTotals` final row). */
	readonly bandRows: readonly number[];
	/** The visible column span (clipped to the pane) the header/band fills cover -- `[colStart, colEnd)`. */
	readonly fillColStart: number;
	readonly fillColEnd: number;
	/** The FULL table extent in cell indices (NOT clipped to the pane -- the canvas pane clip trims the
	 * off-pane portion of the stroked outer border). `[rowStart, rowEnd) x [colStart, colEnd)`. */
	readonly borderRowStart: number;
	readonly borderRowEnd: number;
	readonly borderColStart: number;
	readonly borderColEnd: number;
}

/**
 * **Tables wave (2026-06-13)** -- PURE table-paint planner. For each structured table that intersects the
 * `visible` pane, returns its header row, the alternating data-band rows (clipped to the pane), the visible
 * column fill span, and the full-extent border rectangle (for the outer stroke; the canvas clip trims it).
 * A table entirely off-pane yields NOTHING (it is skipped). No canvas/DOM -- golden-testable.
 *
 * Conventions matching {@link TableSnapshotJson}: the range is `[topRow, topRow+rows) x [topCol, topCol+cols)`;
 * the FIRST row is the header iff `hasHeader`; the LAST row is a totals row iff `hasTotals` (it is excluded
 * from the data banding). Banding is applied to EVERY OTHER data row, starting with the SECOND data row (so
 * the first data row directly under the header is unbanded, the Excel/Sheets default-table-style cadence).
 *
 * **Defensive (No-Fallbacks-adjacent):** a degenerate spec (`rows<=0`, `cols<=0`, or a non-finite/negative
 * coordinate) is SKIPPED -- it cannot describe a paintable rectangle. This is not masking an error: the
 * engine owns table validity; the renderer simply does not paint a non-rectangle. (The host already
 * `console.warn`s a structurally-broken table; here we just no-op it rather than throw mid-paint.)
 */
export function computeTablePaint(
	tables: readonly TableSnapshotJson[],
	visible: TableVisibleRange,
): TablePaint[] {
	const out: TablePaint[] = [];
	for (const t of tables) {
		// Degenerate / malformed spec -> not a paintable rectangle. Skip (the host warns on broken specs).
		if (
			// `topRow`/`topCol` use `Number.isInteger` (NOT merely `Number.isFinite`) for the SAME reason as
			// `rows`/`cols`: a fractional coordinate (e.g. topRow=2.5) describes no cell boundary, and feeding it
			// to the row/col-pitch geometry below would paint a half-row-misaligned band. A grid coordinate is
			// always a whole, non-negative index; the `< 0` checks below keep the non-negativity guard.
			!Number.isInteger(t.topRow) || !Number.isInteger(t.topCol) ||
			!Number.isInteger(t.rows) || !Number.isInteger(t.cols) ||
			t.rows <= 0 || t.cols <= 0 || t.topRow < 0 || t.topCol < 0
		) {
			continue;
		}
		const tRowStart = t.topRow;
		const tRowEnd = t.topRow + t.rows; // half-open
		const tColStart = t.topCol;
		const tColEnd = t.topCol + t.cols; // half-open
		// Off-pane in either axis -> nothing to paint for this table.
		if (tRowEnd <= visible.rowStart || tRowStart >= visible.rowEnd || tColEnd <= visible.colStart || tColStart >= visible.colEnd) {
			continue;
		}
		// Visible column span the fills cover (clipped to the pane).
		const fillColStart = Math.max(tColStart, visible.colStart);
		const fillColEnd = Math.min(tColEnd, visible.colEnd);
		// Header row: the table's first row, IFF the table has a header AND that row is in the visible window.
		const headerRowIdx = tRowStart;
		const headerRow = t.hasHeader && headerRowIdx >= visible.rowStart && headerRowIdx < visible.rowEnd ? headerRowIdx : null;
		// Data rows: everything between the (optional) header and the (optional) totals row.
		const dataRowStart = tRowStart + (t.hasHeader ? 1 : 0);
		const dataRowEnd = tRowEnd - (t.hasTotals ? 1 : 0); // half-open
		const bandRows: number[] = [];
		// Band every OTHER data row, starting at the SECOND data row (index parity from dataRowStart). Clip to
		// the visible window so we never plan a fill for an off-pane row.
		const visRowStart = Math.max(dataRowStart, visible.rowStart);
		const visRowEnd = Math.min(dataRowEnd, visible.rowEnd);
		for (let r = visRowStart; r < visRowEnd; r += 1) {
			// (r - dataRowStart) is the 0-based data-row ordinal; band the ODD ordinals (1,3,5,...) so the row
			// directly under the header stays unbanded.
			if ((r - dataRowStart) % 2 === 1) {
				bandRows.push(r);
			}
		}
		out.push({
			headerRow,
			bandRows,
			fillColStart,
			fillColEnd,
			borderRowStart: tRowStart,
			borderRowEnd: tRowEnd,
			borderColStart: tColStart,
			borderColEnd: tColEnd,
		});
	}
	return out;
}

/** Renders a {@link QuantbookCellSnapshot} as an A1 grid onto a canvas. One instance per panel. */
export class CanvasGridRenderer {
	private readonly ctx: CanvasRenderingContext2D;
	private dpr: number;
	/** `"row,col" -> entry` for O(1) paint + hover lookup AND the single source the windowed paint
	 * iterates (Audit C1-HIGH1: no separate `snapshot.entries` scan). A STRING key (not
	 * `row*MAX_COLS+col`) so an out-of-extent coordinate can never collide with a visible cell. */
	private entryByCell = new Map<string, QuantbookCellSnapshot['entries'][number]>();
	/**
	 * **Tables wave (2026-06-13)** -- the structured tables on the CURRENT sheet, set by {@link setSnapshot}
	 * from {@link QuantbookCellSnapshot.tables} (already filtered to this sheet host-side). Painted as
	 * header/data bands + an outer border in {@link paintCellRegion} (step 2.25), independent of the per-cell
	 * `styleAt` path. Empty when the snapshot carries no tables (the common case). */
	private tables: readonly TableSnapshotJson[] = [];
	private palette: Palette;
	private bodyFont: string;
	private headerFont: string;
	/** **Sheets retheme** -- bold header font for the ACTIVE row/col label (drawn in `accent`). */
	private headerActiveFont: string;
	/**
	 * Width of the sticky row-number gutter, in CSS px. Computed ONCE (and on theme/font change) to fit
	 * the widest POSSIBLE row number (`MAX_ROWS`), so it never shifts as you scroll -- the overlay
	 * editor, hit-test, and spacer all read a single stable value (`gutterWidthPx`) rather than a
	 * scroll-dependent one. A few px wider than needed at low row numbers; that is fine.
	 */
	private gutterW: number;
	/**
	 * **W3 frozen panes (2026-06-09)** -- the number of leading rows / columns PINNED below the header /
	 * right of the gutter (Excel "Freeze Panes"). 0 = no freeze (the byte-identical pre-W3 paint path). The
	 * host sets these via {@link setFrozen} on a `freeze`/`unfreeze` message; the renderer paints the four
	 * panes (body + frozen-rows + frozen-cols + frozen-corner) and the orchestrator threads the counts into
	 * the blit math so a scroll still blits (the frozen bands are excluded from the copy + repainted each
	 * frame, like the sticky header/gutter). Always sane integers in `[0, MAX-1]` (validated in setFrozen).
	 */
	private frozenRowCount = 0;
	private frozenColCount = 0;
	/**
	 * **Sheets retheme (2026-06-10)** -- the scroll offset the LAST frame painted at, recorded by
	 * {@link paintWindow}. The cursor hit-test ({@link installCursorHitTest}) reads it to place the column /
	 * row header separators under the pointer at the same offset the visible frame shows (the renderer is
	 * not otherwise told the scroll; it threads it per-draw). Purely for the cursor affordance -- never used
	 * by the paint geometry, which always receives the live scroll as a parameter.
	 */
	private lastScrollTop = 0;
	private lastScrollLeft = 0;
	/**
	 * **Sheets retheme (2026-06-10) -- header hover highlight.** The column / row index the pointer is
	 * currently hovering in the COLUMN-letter band / ROW-number gutter, or `-1` for "no header hovered"
	 * (pointer is over the body / corner, or has left the canvas). Set by the {@link installCursorHitTest}
	 * mousemove + the mouseleave clear; read by {@link drawHeader} / {@link drawGutter} to paint a faint
	 * hover wash on that one header cell (the Sheets "hover a header" cue). Purely a paint hint -- the
	 * active-selection tint is checked FIRST so it always wins (no fight between hover and active). Repaints
	 * are coalesced to the next animation frame and fire ONLY when the hovered index actually changes.
	 */
	private hoveredHeaderCol = -1;
	private hoveredHeaderRow = -1;
	/** rAF handle for the debounced hover repaint (0 = none scheduled), so a rapid mousemove burst across
	 * one header cell repaints at most once per frame. */
	private hoverRepaintRaf = 0;
	/**
	 * **Sheets retheme (header hover)** -- the exact argument tuple the LAST full {@link draw} painted with,
	 * captured so a hover-only change can REPLAY that same full redraw without the orchestrator (this
	 * renderer owns its only mutated input -- the hovered header index). `null` until the first {@link draw}.
	 * Holds the live references the host passed (errorCells / active / selection / publishedRanges /
	 * fillPreview); a subsequent host-driven `draw()` overwrites the tuple, so a stale hover replay can never
	 * paint older state than the last frame the host asked for.
	 */
	private lastDrawArgs: {
		cssWidth: number;
		cssHeight: number;
		scrollTop: number;
		scrollLeft: number;
		errorCells: ReadonlyMap<string, string>;
		active: ActiveCell | null;
		selection: SelectionRect | null;
		publishedRanges: readonly PublishedRange[];
		fillPreview: SelectionRect | null;
		pointPreview: SelectionRect | null;
		refHighlights: readonly RefHighlightRect[];
	} | null = null;
	private readonly measureCache = new Map<string, number>();
	/**
	 * **FE-0b-4** -- true once a full {@link draw} has painted the current backing store. Reset to
	 * `false` whenever {@link resize} actually changes the backing-store dimensions (which clears it),
	 * including the same-size-but-zeroed canvas a webview reload produces. (FE-2-0 no longer blits, but
	 * the gate is retained so the upcoming `gridBlitA1.ts` fast-follow can rely on it.)
	 */
	private hasPaintedOnce = false;
	/**
	 * **Round 5 (2026-06-10) / FE-5 W-R (2026-06-12) -- per-cell visual styling.** A bound lookup of the
	 * per-cell {@link ResolvedCellStyle} (`bold`/`italic`/`underline`/`strike`/`halign`/`textColor`/
	 * `fillColor`/per-edge `borders`) for the CURRENT sheet, supplied by the controller
	 * ({@link setStyleLookup}). The renderer stays sheet-agnostic + SOURCE-agnostic -- it paints whatever
	 * {@link ResolvedCellStyle} the lookup returns, whether the controller resolves it from the session
	 * style store (today's live source) or the engine snapshot's `styles[]`+`styleId` (FE-5's engine-backed
	 * source, threaded by the conductor). The controller closes over the active sheet id and rebinds this on
	 * sheet switch + after any style edit, then `redraw()`s. Default = "no styling". Read at the single
	 * cell-paint site ({@link paintCellRegion}). Borders are an engine-only attribute, so they appear only
	 * when the lookup resolves from the engine source. */
	private styleAt: (row: number, col: number) => ResolvedCellStyle | undefined = () => undefined;

	constructor(private readonly canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d');
		if (ctx === null) {
			throw new Error('sheets-webview: 2D canvas context unavailable');
		}
		this.ctx = ctx;
		this.ctx.imageSmoothingEnabled = false;
		this.dpr = CanvasGridRenderer.resolveDpr();
		this.palette = this.readPalette();
		const fonts = this.readFonts();
		this.bodyFont = fonts.body;
		this.headerFont = fonts.header;
		this.headerActiveFont = fonts.headerActive;
		this.gutterW = this.computeGutterWidth();
		this.installCursorHitTest();
	}

	/** Gutter width sized to the widest possible row label, at the current header font. Audit LOW-6:
	 * the font is proportional, so the widest 7-digit string is the widest DIGIT repeated, not literally
	 * "1048576" -- measure the widest digit and multiply by the max digit count. */
	private computeGutterWidth(): number {
		this.ctx.font = this.headerFont;
		let widestDigit = 0;
		for (let d = 0; d <= 9; d += 1) {
			widestDigit = Math.max(widestDigit, this.ctx.measureText(String(d)).width);
		}
		const maxDigits = String(MAX_ROWS).length; // 7 for the Excel extent
		return gutterWidth(widestDigit * maxDigits);
	}

	/** The stable sticky-gutter width in CSS px (for the overlay editor, hit-test, spacer, nav). */
	get gutterWidthPx(): number {
		return this.gutterW;
	}

	/**
	 * **W3 frozen panes** -- set the freeze (N leading rows + N leading cols pinned). Counts are clamped to
	 * sane non-negative integers in `[0, MAX-1]` (a full-axis freeze would leave no scrollable body, so the
	 * last index can never be frozen). Does NOT repaint -- the host calls this then `redraw()`. `setFrozen(0,0)`
	 * restores the byte-identical no-freeze paint path (Unfreeze).
	 */
	setFrozen(rows: number, cols: number): void {
		this.frozenRowCount = clampFrozenCount(rows, MAX_ROWS);
		this.frozenColCount = clampFrozenCount(cols, MAX_COLS);
	}

	/** **W3 frozen panes** -- the current pinned-row count (the orchestrator's blit gate reads this via the host). */
	get frozenRows(): number {
		return this.frozenRowCount;
	}

	/** **W3 frozen panes** -- the current pinned-col count. */
	get frozenCols(): number {
		return this.frozenColCount;
	}

	private static resolveDpr(): number {
		const raw = window.devicePixelRatio;
		if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
			warnMissingThemeVar('window.devicePixelRatio', '1');
			return 1;
		}
		return Math.min(2, Math.max(1, Math.ceil(raw)));
	}

	setSnapshot(snapshot: QuantbookCellSnapshot): void {
		// Rebuild the (row,col) lookup (snapshot is sparse -- populated cells only). Phase-1 re-audit
		// (Codex HIGH-1): validate each entry's RAW coordinate + value WITHOUT `Number()`-coercing first
		// (that turned ""/null into a silent A1 paint) and skip+warn any malformed entry, so neither the
		// windowed paint nor the hover/edit lookup can ever see a bad coordinate or an unrenderable value
		// (the latter would crash `formatCellValue`/`clampDisplayString` mid-paint). The string key
		// (`row + ',' + col`) keeps an off-extent coordinate from aliasing a visible cell.
		this.entryByCell = new Map();
		for (const entry of snapshot.entries) {
			if (!isRenderableEntry(entry)) {
				warnSkippedEntry('non-integer/off-extent coord or unrenderable value', entry);
				continue;
			}
			this.entryByCell.set(entry.row + ',' + entry.col, entry);
		}
		// **Tables wave (2026-06-13)**: store this sheet's structured tables (already host-filtered to the
		// active sheet). Absent => no tables (`[]`). The values are READ at paint time by `computeTablePaint`;
		// no validation here -- `computeTablePaint` defensively clips and skips a malformed/degenerate spec.
		this.tables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
	}

	/** The populated entry at (row,col), or undefined for an empty cell (hover + edit pre-fill). */
	entryAt(row: number, col: number): QuantbookCellSnapshot['entries'][number] | undefined {
		return this.entryByCell.get(row + ',' + col);
	}

	/**
	 * **Round 5 (2026-06-10) -- client-side cell styling.** Bind the per-cell visual-style lookup for the
	 * CURRENT sheet. The controller calls this (then `redraw()`) on sheet switch + after any toolbar
	 * style edit; the lookup closes over the active sheet id so the renderer never needs to know it.
	 */
	setStyleLookup(fn: (row: number, col: number) => ResolvedCellStyle | undefined): void {
		this.styleAt = fn;
	}

	/** The CSS `font` shorthand prefix a cell's style adds to the body font ('' when none). Shared by
	 *  {@link styledFont} and the measure-cache key so a width is never reused across fonts. */
	private stylePrefix(style: ResolvedCellStyle | undefined): string {
		if (style === undefined) {
			return '';
		}
		return (style.italic ? 'italic ' : '') + (style.bold ? '700 ' : '');
	}

	/** Compose the body font with optional bold/italic prefixes (Sheets weights: 700 bold). The base
	 *  `bodyFont` is `"13px <family>"`; we splice the CSS `font` shorthand's leading style/weight tokens. */
	private styledFont(style: ResolvedCellStyle | undefined): string {
		const prefix = this.stylePrefix(style);
		return prefix === '' ? this.bodyFont : prefix + this.bodyFont;
	}

	/** **FE-0b-4** -- whether a full {@link draw} has painted the current backing store. */
	get painted(): boolean {
		return this.hasPaintedOnce;
	}

	/** **FE-0b-4** -- the device-pixel ratio the backing store is currently scaled at (1 or 2). */
	get backingScale(): number {
		return this.dpr;
	}

	/**
	 * **FE-2-0 Phase 3 (re-audit / Opus LOW-1)** -- true when the live `devicePixelRatio` no longer matches
	 * the backing store's scale: a monitor-density change that did NOT change the CSS viewport size, so
	 * neither `resize()` nor the ResizeObserver ran. The damage fast paths (`applyRender` / `errorReply`)
	 * skip `resize()`, so they consult this and fall back to a full `redraw()` -- which re-resolves the dpr
	 * + rebuilds the backing store -- rather than paint at the stale scale (parity with the pre-Phase-3
	 * always-resize-on-render model). The scroll path already `resize()`s, so it self-corrects.
	 */
	get backingScaleStale(): boolean {
		return this.dpr !== CanvasGridRenderer.resolveDpr();
	}

	/** Re-read theme palette + fonts (call on snapshot push + on a body-class/theme change). */
	refreshTheme(): void {
		this.palette = this.readPalette();
		const fonts = this.readFonts();
		this.bodyFont = fonts.body;
		this.headerFont = fonts.header;
		this.headerActiveFont = fonts.headerActive;
		this.measureCache.clear();
		this.gutterW = this.computeGutterWidth();
	}

	/** Size the backing store for HiDPI. `cssWidth/cssHeight` are the viewport's logical px. */
	resize(cssWidth: number, cssHeight: number): void {
		this.dpr = CanvasGridRenderer.resolveDpr();
		const bw = Math.max(1, Math.round(cssWidth * this.dpr));
		const bh = Math.max(1, Math.round(cssHeight * this.dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
			this.hasPaintedOnce = false;
			this.ctx.imageSmoothingEnabled = false;
		}
		this.canvas.style.width = cssWidth + 'px';
		this.canvas.style.height = cssHeight + 'px';
	}

	/**
	 * Repaint the visible window. `cssWidth/cssHeight` = viewport logical size; `scrollTop/scrollLeft`
	 * from the scroller; `errorCells` = `"row,col"` keys to tint (from `errorReply`); `active` = the
	 * selected cell (highlight + header/gutter tint), or null. Full redraw.
	 */
	draw(
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
		pointPreview: SelectionRect | null,
		refHighlights: readonly RefHighlightRect[],
	): void {
		// **Codex MED (2026-06-10) -- stale header hover on scroll.** The hover wash only updates on canvas
		// mousemove/mouseleave; when the grid SCROLLS under a stationary pointer, the remembered header index
		// still names the OLD row/col, which now sits at a different screen position -- the wash would paint
		// on a header cell the pointer is no longer over. Cheapest correct fix: CLEAR the hover state on any
		// scroll-driven repaint (scroll differs from the last painted frame's); the next mousemove recomputes
		// and restores it. Cleared by direct field write, NOT setHeaderHover -- we are already inside the
		// repaint that will reflect the clear; scheduling another rAF replay here would just burn a frame.
		// A hover REPLAY (setHeaderHover's rAF) re-draws at the SAME scroll, so it never trips this clear.
		if (this.hasPaintedOnce && (scrollTop !== this.lastScrollTop || scrollLeft !== this.lastScrollLeft)) {
			this.hoveredHeaderCol = -1;
			this.hoveredHeaderRow = -1;
		}
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights);
		this.hasPaintedOnce = true;
		// Sheets retheme (header hover): remember this full-draw's inputs so a hover-only change can replay an
		// identical full redraw with the new hovered-header index, without routing back through the host.
		this.lastDrawArgs = { cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights };
	}

	/**
	 * **FE-2-0 Phase 3** -- blit-scroll fast path. Reuse the overlapping pixels of the previous frame
	 * via a self-`drawImage` (the `blit.copy` rect, DEVICE px, identity transform), then repaint only
	 * the newly-exposed `blit.damageRects` (CSS px, dpr transform, clipped). `blit` MUST come from
	 * {@link computeScrollBlitA1} for the SAME `scrollTop/scrollLeft` passed here -- the caller computes
	 * it from the prev/next scroll state and only reaches this method when the math returned non-null.
	 * The sticky header (vertical scroll) / gutter+corner (horizontal scroll) are neither copied nor
	 * damaged, so they are preserved exactly from the previous frame.
	 */
	drawScroll(
		blit: ScrollBlit,
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
		pointPreview: SelectionRect | null,
		refHighlights: readonly RefHighlightRect[],
	): void {
		const ctx = this.ctx;
		const c = blit.copy;
		// **Codex MED (2026-06-10) -- stale header hover on scroll (blit path).** A blittable scroll has a
		// non-zero delta by construction (computeScrollBlitA1 returns null for dx===dy===0), so the hover
		// state is ALWAYS stale here -- clear it unconditionally (direct field write; see draw() for why not
		// setHeaderHover). But clearing the STATE is not enough on this path: the copy rect includes the
		// gutter's row numbers (vertical scroll) / the header's column letters (horizontal scroll), so a
		// hover wash painted last frame TRAVELS with the blit -- and the damage strips only repaint the
		// exposed edge, not the band the wash moved within. Remember whether a wash was on screen so step 3
		// below can erase it.
		const hadHoverWash = this.hoveredHeaderCol !== -1 || this.hoveredHeaderRow !== -1;
		this.hoveredHeaderCol = -1;
		this.hoveredHeaderRow = -1;
		// 1. Self-blit the overlap in DEVICE px (identity transform). Source/dest overlap within the same
		// canvas is well-defined (the spec reads the full source region first).
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(this.canvas, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
		// 2. Repaint the exposed strip(s) in CSS px (dpr transform), clipped to each rect. paintWindow is
		// the SAME source of pixels as a full draw, so the strip is identical to a full redraw there.
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		for (const d of blit.damageRects) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(d.x, d.y, d.width, d.height);
			ctx.clip();
			this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights);
			ctx.restore();
		}
		// 3. Codex MED (stale hover): when the previous frame carried a hover wash, repaint the FULL sticky
		// gutter + header bands (clipped to exactly those two rects) so the blit-carried wash pixels are
		// erased -- the post-clear paintWindow paints both bands wash-free, restoring parity with a full
		// redraw (DEBUG_BLIT_VERIFY would flag any leftover wash as a partial!=full divergence). Bounded
		// cost (one column of row numbers + one row of column letters) on a RARE path (scrolling while the
		// pointer rests on a header); the wash-free common case skips it entirely. The clip union also
		// covers the PINNED frozen-band labels (not copied by the blit), so a preserved wash there is erased
		// in the same pass -- the pixels always match the now-cleared hover state.
		if (hadHoverWash) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, this.gutterW, cssHeight); // the row-number gutter (full height, incl. frozen labels)
			ctx.rect(0, 0, cssWidth, HEADER_HEIGHT); // the column-letter band (full width)
			ctx.clip();
			this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights);
			ctx.restore();
		}
		this.hasPaintedOnce = true;
		// Sheets retheme (header hover): a scroll updates the inputs a hover replay must use (new scrollTop/
		// scrollLeft). Capture the post-scroll tuple so a hover wash lands on the correct header at this offset.
		this.lastDrawArgs = { cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights };
		if (DEBUG_BLIT_VERIFY) {
			this.verifyAgainstFull(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights, 'drawScroll');
		}
	}

	/**
	 * **FE-2-0 Phase 3** -- damage-clip fast path. Repaint ONLY the given A1 `rows` (their full-width
	 * bands), clipped to the union of those bands so the rest of the frame is preserved. Contiguous rows
	 * merge into one band; the clip is built as a single multi-rect path (one `paintWindow`, not one per
	 * row). Used by `applyRender` (snapshot diff) at the SAME scroll the previous frame painted -- the
	 * caller gates on `painted` + scroll-unchanged, since a damage paint assumes the un-damaged pixels are
	 * already correct at the current offset. A no-op for an empty `rows`.
	 */
	drawDamage(
		rows: readonly number[],
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
		pointPreview: SelectionRect | null,
		refHighlights: readonly RefHighlightRect[],
	): void {
		if (rows.length === 0) {
			return;
		}
		const ctx = this.ctx;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.save();
		ctx.beginPath();
		// Sort + merge contiguous rows into bands so far-apart changes do NOT clip a giant bounding box
		// (the clip is the UNION of the per-band rects, not their hull).
		const sorted = [...rows].sort((a, b) => a - b);
		let runStart = sorted[0];
		let runEnd = sorted[0];
		const fRows = this.frozenRowCount;
		// **Codex HIGH-1**: a FROZEN row paints PINNED at `rowY(r)-0` (in the frozen-row band), NOT at the
		// scrolled `rowY(r)-scrollTop`. Clipping a frozen row's damage at the scrolled Y (offscreen once the
		// body has scrolled) would leave its cell value / error tint STALE until a full redraw. So a damaged
		// run that straddles the frozen boundary is added as TWO clip rects: the frozen part at effScroll 0,
		// the body part at scrollTop. `paintWindow` repaints every pane inside the clip, so covering each
		// part's pinned/scrolled viewport band is sufficient.
		const addRect = (r0: number, r1: number, effScrollTop: number): void => {
			const yTop = rowY(r0) - effScrollTop;
			const h = (r1 - r0 + 1) * ROW_HEIGHT;
			// Pad so the rounded paint origins sit fully inside the clip (see DAMAGE_CLIP_PAD).
			ctx.rect(0, yTop - DAMAGE_CLIP_PAD, cssWidth, h + DAMAGE_CLIP_PAD * 2);
		};
		const addBand = (r0: number, r1: number): void => {
			if (fRows <= 0 || r0 >= fRows) {
				addRect(r0, r1, scrollTop); // wholly in the scrolling body
				return;
			}
			if (r1 < fRows) {
				addRect(r0, r1, 0); // wholly in the frozen-row band (pinned)
				return;
			}
			// Straddles the boundary: frozen part [r0, fRows-1] pinned, body part [fRows, r1] scrolled.
			addRect(r0, fRows - 1, 0);
			addRect(fRows, r1, scrollTop);
		};
		for (let i = 1; i < sorted.length; i += 1) {
			if (sorted[i] === runEnd + 1) {
				runEnd = sorted[i];
				continue;
			}
			if (sorted[i] === runEnd) {
				continue; // duplicate row index
			}
			addBand(runStart, runEnd);
			runStart = sorted[i];
			runEnd = sorted[i];
		}
		addBand(runStart, runEnd);
		ctx.clip();
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights);
		ctx.restore();
		this.hasPaintedOnce = true;
		// Sheets retheme (header hover): keep the replay tuple current with the latest host-driven state (a
		// damage paint can change errorCells / active / selection at the same scroll the hover replay reuses).
		this.lastDrawArgs = { cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights };
		if (DEBUG_BLIT_VERIFY) {
			this.verifyAgainstFull(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights, 'drawDamage');
		}
	}

	/**
	 * **FE-2-0 Phase 3 / `DEBUG_BLIT_VERIFY`** -- capture the just-produced partial frame, full-repaint
	 * over it, and compare pixel-for-pixel; `console.error` LOUD on ANY divergence (with the first
	 * differing device pixel). The canvas is left in the correct full-draw state. Dev-only: `getImageData`
	 * is unavailable headlessly + the full repaint defeats the optimization. The pure blit/damage MATH is
	 * golden-tested in `gridBlitA1.ts`; this guards the renderer's wiring of it.
	 */
	private verifyAgainstFull(
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
		pointPreview: SelectionRect | null,
		refHighlights: readonly RefHighlightRect[],
		path: string,
	): void {
		const ctx = this.ctx;
		const bw = this.canvas.width;
		const bh = this.canvas.height;
		const partial = ctx.getImageData(0, 0, bw, bh);
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights);
		const full = ctx.getImageData(0, 0, bw, bh);
		const pa = partial.data;
		const fu = full.data;
		let diffs = 0;
		let firstX = -1;
		let firstY = -1;
		for (let i = 0; i < pa.length; i += 4) {
			if (pa[i] !== fu[i] || pa[i + 1] !== fu[i + 1] || pa[i + 2] !== fu[i + 2] || pa[i + 3] !== fu[i + 3]) {
				diffs += 1;
				if (firstX < 0) {
					const px = i / 4;
					firstX = px % bw;
					firstY = Math.floor(px / bw);
				}
			}
		}
		if (diffs > 0) {
			console.error(
				`[sheets-webview] DEBUG_BLIT_VERIFY: ${path} produced a frame that differs from a full redraw ` +
				`by ${diffs} device px (first at ${firstX},${firstY}). The partial-paint path is INCORRECT for ` +
				`this input -- it must return null/[] and fall back to a full draw.`,
			);
		}
	}

	/**
	 * Paint the A1 grid for `scrollTop/scrollLeft`. The **single source of cell pixels**.
	 *
	 * **W3 frozen panes (2026-06-09)**: the cell area is split into up to FOUR panes by the frozen bands --
	 * the scrolling BODY (bottom-right), the FROZEN-ROWS strip (top-right, pinned on Y), the FROZEN-COLS
	 * strip (bottom-left, pinned on X), and the FROZEN CORNER (top-left, pinned on both). Each pane paints
	 * the SAME cell content ({@link paintCellRegion}) but with an EFFECTIVE scroll of 0 on whichever axis is
	 * frozen, so a pinned cell stays put while the body scrolls under it. With `frozenRowCount === 0 &&
	 * frozenColCount === 0` there is exactly ONE pane (the body) covering the whole grid at the real scroll,
	 * so the paint is byte-identical to the pre-W3 single-region path. Each pane is clipped to its viewport
	 * rectangle so a body cell scrolled under a frozen strip cannot bleed into it.
	 *
	 * Paint order (later paints own overlapping seams): background -> body pane -> frozen-cols pane ->
	 * frozen-rows pane -> frozen corner -> sticky row gutter (left) -> column header (top) -> corner box.
	 */
	private paintWindow(
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
		pointPreview: SelectionRect | null,
		refHighlights: readonly RefHighlightRect[],
	): void {
		const ctx = this.ctx;
		// Sheets retheme: remember the scroll this frame painted at, so the cursor hit-test can place the
		// header separators under the pointer at the matching offset (cursor-only; never read by paint math).
		this.lastScrollTop = scrollTop;
		this.lastScrollLeft = scrollLeft;
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, cssWidth, cssHeight);

		const gutterW = this.gutterW;
		const fRows = this.frozenRowCount;
		const fCols = this.frozenColCount;
		const frozenRowsPx = frozenRowsHeight(fRows);
		const frozenColsPx = frozenColsWidth(fCols);

		// The body pane's top-left viewport corner (just past the header+frozen-rows band / gutter+frozen-cols
		// band). Cells in the body scroll under those bands.
		const bodyTop = HEADER_HEIGHT + frozenRowsPx;
		const bodyLeft = gutterW + frozenColsPx;

		// Visible ranges. The SCROLLING body skips the frozen rows/cols (they paint pinned). The frozen rows
		// span [0, fRows); the frozen cols span [0, fCols). `bodyHeight`/`bodyWidth` are the full bands below
		// the header / right of the gutter (the frozen-band subtraction happens inside the body-range fns).
		const bodyHeight = Math.max(0, cssHeight - HEADER_HEIGHT);
		const bodyWidth = Math.max(0, cssWidth - gutterW);
		const bodyRowRange = computeVisibleBodyRowRange(scrollTop, bodyHeight, MAX_ROWS, ROW_HEIGHT, OVERSCAN, fRows);
		const bodyColRange = computeVisibleBodyColRange(scrollLeft, bodyWidth, MAX_COLS, COL_WIDTH, OVERSCAN, fCols);
		// **Codex HIGH-3**: cap the FROZEN ranges to what is actually ON SCREEN. A deep freeze (e.g. row 500k)
		// makes `frozenRowsPx` far exceed the viewport; the frozen band is clipped to `[HEADER_HEIGHT,
		// min(bodyTop, cssHeight))`, so at most `ceil((cssHeight-HEADER_HEIGHT)/ROW_HEIGHT)+1` rows are visible.
		// Looping all `fRows` (or `fRows*fCols` for the corner) would be O(100k+) per frame for nothing painted.
		// The band is exactly `fRows*ROW_HEIGHT` tall, so when it fits the cap is a no-op (== fRows). +1 covers a
		// partially-visible last row at the band/viewport edge.
		const visFrozenRows = Math.min(fRows, Math.max(0, Math.ceil((cssHeight - HEADER_HEIGHT) / ROW_HEIGHT) + 1));
		const visFrozenCols = Math.min(fCols, Math.max(0, Math.ceil((cssWidth - gutterW) / COL_WIDTH) + 1));
		const frozenRowEnd = visFrozenRows; // [0, visFrozenRows) -- only the on-screen frozen rows
		const frozenColEnd = visFrozenCols; // [0, visFrozenCols) -- only the on-screen frozen cols

		// 1. BODY pane (bottom-right): scrolls both axes. Clipped to [bodyLeft, cssWidth) x [bodyTop, cssHeight)
		// so a body cell scrolled under a frozen strip never paints into it. (When fRows===fCols===0, bodyTop
		// ===HEADER_HEIGHT and bodyLeft===gutterW: the clip is the whole grid below+right of the sticky bands,
		// and paintCellRegion runs once at the real scroll -- byte-identical to the pre-W3 path.)
		this.paintCellRegion(
			bodyRowRange, bodyColRange, scrollTop, scrollLeft, gutterW,
			bodyLeft, bodyTop, cssWidth, cssHeight,
			errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights,
		);

		// 2. FROZEN-COLS pane (bottom-left): cols [0, fCols) pinned on X (effScrollLeft=0), rows scroll. Only
		// when there is a frozen-col band. Clipped to [gutterW, bodyLeft) x [bodyTop, cssHeight).
		if (fCols > 0) {
			this.paintCellRegion(
				bodyRowRange, { startIdx: 0, endIdx: frozenColEnd }, scrollTop, 0, gutterW,
				gutterW, bodyTop, bodyLeft, cssHeight,
				errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights,
			);
		}

		// 3. FROZEN-ROWS pane (top-right): rows [0, visFrozenRows) pinned on Y (effScrollTop=0), cols scroll.
		// Clipped to [bodyLeft, cssWidth) x [HEADER_HEIGHT, bodyTop).
		if (fRows > 0) {
			this.paintCellRegion(
				{ startIdx: 0, endIdx: frozenRowEnd }, bodyColRange, 0, scrollLeft, gutterW,
				bodyLeft, HEADER_HEIGHT, cssWidth, bodyTop,
				errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights,
			);
		}

		// 4. FROZEN CORNER (top-left): rows [0, visFrozenRows) x cols [0, visFrozenCols), pinned on BOTH axes.
		// Clipped to [gutterW, bodyLeft) x [HEADER_HEIGHT, bodyTop).
		if (fRows > 0 && fCols > 0) {
			this.paintCellRegion(
				{ startIdx: 0, endIdx: frozenRowEnd }, { startIdx: 0, endIdx: frozenColEnd }, 0, 0, gutterW,
				gutterW, HEADER_HEIGHT, bodyLeft, bodyTop,
				errorCells, active, selection, publishedRanges, fillPreview, pointPreview, refHighlights,
			);
		}

		// 5. Sticky row gutter (covers cells that scrolled left under it), then header, then corner. The
		// gutter/header paint BOTH the frozen labels (pinned, capped to the visible count) and the body labels
		// (scrolled), so the row numbers / column letters line up with each pane.
		this.drawGutter(scrollTop, gutterW, cssHeight, bodyRowRange.startIdx, bodyRowRange.endIdx, active, selection, visFrozenRows, bodyTop);
		this.drawHeader(scrollLeft, gutterW, cssWidth, bodyColRange.startIdx, bodyColRange.endIdx, active, selection, visFrozenCols, bodyLeft);
		this.drawCorner(gutterW);
	}

	/**
	 * **FE-5 W-R (2026-06-12) -- per-edge cell BORDERS** for every visible cell in the pane. Resolves each
	 * cell's {@link ResolvedCellStyle} borders and its right/below neighbours' borders, dedups the shared
	 * seams via {@link bordersToPaint} (own-top+left, cede-bottom+right), and strokes each surviving edge
	 * INSIDE the cell rect so a thick/double width does not bleed into the neighbour's interior.
	 *
	 * Geometry: a cell spans `[x, x+COL_WIDTH) x [y, y+ROW_HEIGHT)` (origins snapped to a whole CSS px,
	 * matching the gridline/value paint). A border of width `w` is centred `w/2` INSIDE the edge line (top at
	 * `y + w/2`, bottom at `y + ROW_HEIGHT - w/2`, left/right symmetric), so the whole stroke stays within the
	 * cell. `double` is two 1px hairlines spanning its 3px nominal width. `dashed`/`dotted` set a dash pattern.
	 * Each cell's edges paint in their OWN save/restore bracket (strokeStyle/lineWidth/lineDash are cell-local).
	 *
	 * O(visible cells) -- one style lookup per cell (plus its two neighbours), bounded by the windowed range
	 * exactly like the fill + value loops. A no-op when no visible cell carries a border (the common case),
	 * and entirely a no-op for the session-store render source (which has no borders).
	 */
	/**
	 * **Tables wave (2026-06-13)** -- paint the structured tables intersecting this pane: a header band on
	 * the first row (when `hasHeader`), an alternating ~10% tint on the data rows (skipping a `hasTotals`
	 * last row), and an outer border around the full range. RANGE-level metadata -- driven by the pure
	 * {@link computeTablePaint} plan, NOT the per-cell `styleAt` path. A no-op when this sheet has no tables.
	 *
	 * Geometry mirrors the fill/gridline/border loops: a cell spans `[x, x+COL_WIDTH) x [y, y+ROW_HEIGHT)`
	 * with origins snapped to a whole CSS px. The band fills span the table's VISIBLE column window (clipped
	 * by `computeTablePaint`); the outer border strokes the table's FULL extent and the caller's pane `clip()`
	 * trims any off-pane portion. The fills are translucent washes (palette) so cell values read through.
	 */
	private paintTables(
		rowRange: { startIdx: number; endIdx: number },
		colRange: { startIdx: number; endIdx: number },
		effScrollTop: number,
		effScrollLeft: number,
		gutterW: number,
	): void {
		if (this.tables.length === 0) {
			return; // common case -- no tables on this sheet
		}
		const ctx = this.ctx;
		const plans = computeTablePaint(this.tables, {
			rowStart: rowRange.startIdx,
			rowEnd: rowRange.endIdx,
			colStart: colRange.startIdx,
			colEnd: colRange.endIdx,
		});
		for (const plan of plans) {
			// X span of the visible fill columns: left edge of fillColStart .. right edge of (fillColEnd-1).
			const fx0 = Math.round(colX(plan.fillColStart, gutterW) - effScrollLeft);
			const fx1 = Math.round(colX(plan.fillColEnd, gutterW) - effScrollLeft);
			const fillW = fx1 - fx0;
			// Header band (brand accent wash) on the first row, when present + visible.
			if (plan.headerRow !== null && fillW > 0) {
				const hy = Math.round(rowY(plan.headerRow) - effScrollTop);
				ctx.fillStyle = this.palette.tableHeaderBand;
				ctx.fillRect(fx0, hy, fillW, ROW_HEIGHT);
			}
			// Alternating data-row bands (neutral wash).
			if (plan.bandRows.length > 0 && fillW > 0) {
				ctx.fillStyle = this.palette.tableDataBand;
				for (const r of plan.bandRows) {
					const by = Math.round(rowY(r) - effScrollTop);
					ctx.fillRect(fx0, by, fillW, ROW_HEIGHT);
				}
			}
			// Outer border around the FULL table extent (the pane clip trims the off-pane portion). Stroke is
			// inside-aligned by half its width on each edge so the 2px line sits fully within the range rect.
			const bx0 = Math.round(colX(plan.borderColStart, gutterW) - effScrollLeft);
			const bx1 = Math.round(colX(plan.borderColEnd, gutterW) - effScrollLeft);
			const by0 = Math.round(rowY(plan.borderRowStart) - effScrollTop);
			const by1 = Math.round(rowY(plan.borderRowEnd) - effScrollTop);
			if (bx1 > bx0 && by1 > by0) {
				const half = TABLE_BORDER_WIDTH_PX / 2;
				ctx.save();
				ctx.strokeStyle = this.palette.tableBorder;
				ctx.lineWidth = TABLE_BORDER_WIDTH_PX;
				ctx.strokeRect(bx0 + half, by0 + half, (bx1 - bx0) - TABLE_BORDER_WIDTH_PX, (by1 - by0) - TABLE_BORDER_WIDTH_PX);
				ctx.restore();
			}
		}
	}

	private paintCellBorders(
		rowRange: { startIdx: number; endIdx: number },
		colRange: { startIdx: number; endIdx: number },
		effScrollTop: number,
		effScrollLeft: number,
		gutterW: number,
	): void {
		for (let r = rowRange.startIdx; r < rowRange.endIdx; r += 1) {
			const y = Math.round(rowY(r) - effScrollTop);
			for (let c = colRange.startIdx; c < colRange.endIdx; c += 1) {
				const self = this.styleAt(r, c)?.borders;
				if (self === undefined) {
					continue; // no border on this cell -- the common case, skip the neighbour lookups
				}
				// Dedup the shared seams against the neighbour BELOW (its top == this cell's bottom) and to the
				// RIGHT (its left == this cell's right). Neighbour-wins keeps one owner per contested seam.
				const below = this.styleAt(r + 1, c)?.borders;
				const right = this.styleAt(r, c + 1)?.borders;
				const toPaint = bordersToPaint(self, below, right);
				if (toPaint.top === undefined && toPaint.bottom === undefined && toPaint.left === undefined && toPaint.right === undefined) {
					continue;
				}
				const x = Math.round(colX(c, gutterW) - effScrollLeft);
				this.strokeCellBorders(x, y, toPaint);
			}
		}
	}

	/** Stroke a single cell's surviving border edges INSIDE its `[x, x+COL_WIDTH) x [y, y+ROW_HEIGHT)` rect.
	 *  Each edge is painted in its own save/restore (strokeStyle/lineWidth/lineDash are per-edge). */
	private strokeCellBorders(
		x: number,
		y: number,
		edges: { top?: ResolvedBorderEdge; bottom?: ResolvedBorderEdge; left?: ResolvedBorderEdge; right?: ResolvedBorderEdge },
	): void {
		const ctx = this.ctx;
		const x1 = x + COL_WIDTH;
		const y1 = y + ROW_HEIGHT;
		// Paint one edge line at the given orientation/position, inside-aligned by its width. `double` draws
		// two 1px hairlines at the outer + inner extremes of its 3px span; the others a single centred stroke.
		const paintEdge = (edge: ResolvedBorderEdge, orient: 'h' | 'v', edgeName: 'top' | 'bottom' | 'left' | 'right'): void => {
			const w = borderWidthPx(edge.style);
			ctx.save();
			ctx.strokeStyle = edge.color;
			if (edge.style === 'dashed') {
				ctx.setLineDash([4, 2]);
			} else if (edge.style === 'dotted') {
				ctx.setLineDash([1, 2]);
			}
			// The set of stroke offsets (CSS px, measured INWARD from the edge) -- one centred line for the
			// solid widths, two hairlines (outer + inner) for `double`.
			const offsets: Array<{ pos: number; lw: number }> =
				edge.style === 'double'
					? [{ pos: 0.5, lw: 1 }, { pos: w - 0.5, lw: 1 }]
					: [{ pos: w / 2, lw: w }];
			for (const o of offsets) {
				ctx.lineWidth = o.lw;
				ctx.beginPath();
				if (orient === 'h') {
					// Top edge measures inward (down) from `y`; bottom edge inward (up) from `y1`.
					const ly = edgeName === 'top' ? y + o.pos : y1 - o.pos;
					ctx.moveTo(x, ly);
					ctx.lineTo(x1, ly);
				} else {
					const lx = edgeName === 'left' ? x + o.pos : x1 - o.pos;
					ctx.moveTo(lx, y);
					ctx.lineTo(lx, y1);
				}
				ctx.stroke();
			}
			ctx.restore();
		};
		if (edges.top !== undefined) { paintEdge(edges.top, 'h', 'top'); }
		if (edges.bottom !== undefined) { paintEdge(edges.bottom, 'h', 'bottom'); }
		if (edges.left !== undefined) { paintEdge(edges.left, 'v', 'left'); }
		if (edges.right !== undefined) { paintEdge(edges.right, 'v', 'right'); }
	}

	/**
	 * **W3 frozen panes** -- paint the cell CONTENT (error tints, gridlines, values, selection range +
	 * focus box, published badges, fill preview + handle) for one rectangular PANE, clipped to its viewport
	 * rect `[clipX0, clipX1) x [clipY0, clipY1)`. `effScrollTop`/`effScrollLeft` are the EFFECTIVE scroll for
	 * the pane (0 on a frozen axis, the real scroll on a scrolling axis), so a cell `(r,c)` paints at
	 * `colX(c)-effScrollLeft` / `rowY(r)-effScrollTop`. This is the pre-W3 `paintWindow` body, lifted
	 * VERBATIM into a per-pane routine: the body pane (one call, real scroll, full-grid clip) reproduces it
	 * exactly. Selection/badges/fill use INCLUSIVE-rect intersection against the pane's visible range so a
	 * range spanning a frozen boundary renders correctly in each pane it touches.
	 */
	private paintCellRegion(
		rowRange: { startIdx: number; endIdx: number },
		colRange: { startIdx: number; endIdx: number },
		effScrollTop: number,
		effScrollLeft: number,
		gutterW: number,
		clipX0: number,
		clipY0: number,
		clipX1: number,
		clipY1: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
		pointPreview: SelectionRect | null,
		refHighlights: readonly RefHighlightRect[],
	): void {
		const ctx = this.ctx;
		if (clipX1 <= clipX0 || clipY1 <= clipY0 || rowRange.endIdx <= rowRange.startIdx || colRange.endIdx <= colRange.startIdx) {
			return; // empty pane (no frozen band, or a zero-size viewport)
		}
		ctx.save();
		ctx.beginPath();
		ctx.rect(clipX0, clipY0, clipX1 - clipX0, clipY1 - clipY0);
		ctx.clip();

		// 0. Round 5 (2026-06-10) -- client-side cell FILL color, painted UNDER the gridlines + error tint +
		// text (Excel cell shading), for EVERY styled cell in the pane INCLUDING empty ones (a fill on a
		// blank cell must show -- so this is independent of `entryByCell`). One style lookup per visible
		// cell; bounded by the windowed range, like the value loop below.
		for (let r = rowRange.startIdx; r < rowRange.endIdx; r += 1) {
			const fy = Math.round(rowY(r) - effScrollTop);
			for (let c = colRange.startIdx; c < colRange.endIdx; c += 1) {
				const fill = this.styleAt(r, c)?.fillColor;
				if (fill !== undefined) {
					ctx.fillStyle = fill;
					ctx.fillRect(Math.round(colX(c, gutterW) - effScrollLeft), fy, COL_WIDTH, ROW_HEIGHT);
				}
			}
		}

		// 1. Error-cell background tints (under the gridlines + text, like Excel). Audit S1-LOW: snap the
		// fill origin to a device pixel so the tint aligns with the (rounded) gridlines on non-Electron/test.
		if (errorCells.size > 0) {
			ctx.fillStyle = this.palette.errorBg;
			for (let r = rowRange.startIdx; r < rowRange.endIdx; r += 1) {
				const ly = Math.round(rowY(r) - effScrollTop);
				for (let c = colRange.startIdx; c < colRange.endIdx; c += 1) {
					if (errorCells.has(r + ',' + c)) {
						ctx.fillRect(Math.round(colX(c, gutterW) - effScrollLeft), ly, COL_WIDTH, ROW_HEIGHT);
					}
				}
			}
		}

		// 2. Gridlines: batched vertical + horizontal lines across the pane (half-pixel-aligned for crisp
		// 1px). Drawn over the pane clip, so a line never bleeds past the frozen seam into the next pane.
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let c = colRange.startIdx; c <= colRange.endIdx; c += 1) {
			const x = Math.round(colX(c, gutterW) - effScrollLeft) - 0.5;
			ctx.moveTo(x, clipY0);
			ctx.lineTo(x, clipY1);
		}
		for (let r = rowRange.startIdx; r <= rowRange.endIdx; r += 1) {
			const y = Math.round(rowY(r) - effScrollTop) - 0.5;
			ctx.moveTo(clipX0, y);
			ctx.lineTo(clipX1, y);
		}
		ctx.stroke();

		// 2.25 Tables wave (2026-06-13): structured-table banding -- header band, alternating data-row bands,
		// and an outer border -- painted OVER the gridlines (step 2) but UNDER the per-cell borders (step 2.5)
		// and the cell text (step 3), so a table's banding sits behind its values + any per-cell borders. This
		// is RANGE-level metadata (NOT the per-cell `styleAt` path). A no-op when this sheet has no tables.
		this.paintTables(rowRange, colRange, effScrollTop, effScrollLeft, gutterW);

		// 2.5 FE-5 W-R (2026-06-12): per-edge cell BORDERS, painted OVER the faint gridlines (so a thin black
		// border is not washed out by the gridline beneath it) but UNDER the cell text + the selection/range
		// overlays. Engine-only attribute (borders come only from the engine-style source), so this is a no-op
		// for the session-store render source. The shared-edge dedup (own-top+left, cede-bottom+right to the
		// neighbor) prevents a contested seam from double-drawing / phase-mismatching on dashed.
		this.paintCellBorders(rowRange, colRange, effScrollTop, effScrollLeft, gutterW);

		// 3. Values for the populated cells in the pane. Audit C1-HIGH1: iterate the VISIBLE WINDOW (bounded
		// ~viewport rows x cols) and look up each cell in the sparse map -- O(visible cells), a hard per-frame
		// ceiling independent of the snapshot's entry count (a dense FE-1 `qb.show` could be huge).
		ctx.font = this.bodyFont;
		ctx.textBaseline = 'middle';
		// Codex HIGH (2026-06-10): alignment is PER VALUE KIND below (the Excel/Sheets convention), set
		// inside each cell's save/clip/restore bracket; 'left' here is just the loop's baseline state.
		ctx.textAlign = 'left';
		const valueMax = COL_WIDTH - CELL_PAD * 2;
		for (let r = rowRange.startIdx; r < rowRange.endIdx; r += 1) {
			const y = Math.round(rowY(r) - effScrollTop);
			for (let c = colRange.startIdx; c < colRange.endIdx; c += 1) {
				const entry = this.entryByCell.get(r + ',' + c);
				if (entry === undefined) {
					continue; // empty cell -- gridlines only, no fillText
				}
				// **FE-5 W-R (2026-06-12) -- style-only blank cell paints NO text.** The host projects a cell
				// carrying ONLY a style (a fill/border on an otherwise-empty cell) as a `pending` entry with a
				// `styleId` but NO formula (so its fill/border render -- steps 0 + 2.5 -- and its row enters the
				// damage diff). Such a cell must NOT show the `(pending)` placeholder text: that text is for a
				// FORMULA cell still computing (which carries `formula`). So skip the value paint for a pending
				// entry that has no formula -- it is a fill/border-only cell, not a computing cell. (A real
				// formula-pending cell keeps its `(pending)` text via the formula presence.)
				if (entry.value.kind === 'pending' && entry.formula === undefined) {
					continue;
				}
				const x = Math.round(colX(c, gutterW) - effScrollLeft);
				const isError = errorCells.has(r + ',' + c);
				// Audit C1-HIGH2: cap the display string BEFORE measure/truncate so a pathological `rendered`
				// can't freeze the binary search (which measures the full string first).
				const raw = typeof entry.rendered === 'string' ? entry.rendered : formatCellValue(entry.value);
				// Round 5 (2026-06-10): per-cell client-side style (bold/italic font, text color, halign
				// override, underline/strike). The measure cache is keyed by the style's font PREFIX so a
				// bold cell's width can never poison the plain entry for the same text -- and vice-versa
				// (round-5 audit MED: the string-only key shared widths across fonts within a frame).
				const style = this.styleAt(r, c);
				const fontKey = this.stylePrefix(style);
				ctx.save();
				ctx.beginPath();
				ctx.rect(x, y, COL_WIDTH, ROW_HEIGHT);
				ctx.clip();
				if (fontKey !== '') {
					ctx.font = this.styledFont(style); // restored by the per-cell ctx.restore() below
				}
				const shown = truncateToWidth(clampDisplayString(raw), valueMax, s => this.measure(s, fontKey));
				ctx.fillStyle =
					style?.textColor ?? (isError ? this.palette.errorFg : this.palette.foreground);
				// **Codex HIGH (2026-06-10) -- per-kind text alignment, the Excel/Sheets convention** (the
				// product bar is "looks like a real spreadsheet"): NUMBERS right-align at the cell's right
				// edge minus CELL_PAD; TEXT left-aligns at left edge + CELL_PAD (the pre-fix behavior);
				// BOOLEANS and ERRORS (#NUM! etc.) center at the cell midpoint. `pending` is a transient
				// status placeholder ('(pending)'), not a value -- centered like an error so it reads as a
				// status, not data. Switched on the VALUE's `kind` (the QuantbookCellValue discriminant),
				// NOT on the display string: a formatted number carries an engine-`rendered` string (e.g.
				// "$1,234.00") but keeps `kind:'number'`, and must still right-align. This is the SINGLE
				// cell-text paint site -- every pane (body + frozen rows/cols/corner) and every paint path
				// (full draw / drawScroll strips / drawDamage bands) funnels through paintCellRegion, so the
				// rule holds everywhere. textAlign mutates inside this save/restore bracket (canvas state
				// includes textAlign), so the loop's 'left' baseline is restored each iteration.
				// Per-kind default alignment (the Excel/Sheets convention), OVERRIDABLE by an explicit
				// client-side `halign` (round 5): NUMBERS right, TEXT left, BOOLEAN/ERROR/pending center.
				const kindAlign: 'left' | 'right' | 'center' =
					entry.value.kind === 'number'
						? 'right'
						: entry.value.kind === 'text'
							? 'left'
							: 'center';
				const halign: 'left' | 'right' | 'center' = style?.halign ?? kindAlign;
				const midY = y + ROW_HEIGHT / 2;
				let textX: number;
				if (halign === 'right') {
					ctx.textAlign = 'right';
					textX = x + COL_WIDTH - CELL_PAD;
				} else if (halign === 'center') {
					ctx.textAlign = 'center';
					textX = x + COL_WIDTH / 2;
				} else {
					ctx.textAlign = 'left';
					textX = x + CELL_PAD;
				}
				ctx.fillText(shown, textX, midY);
				// Round 5: underline / strikethrough drawn in the (possibly overridden) text color across
				// the measured glyph run. `lineStart` derives from the alignment so the rule tracks the text.
				if (style !== undefined && (style.underline === true || style.strike === true) && shown.length > 0) {
					const w = this.measure(shown, fontKey);
					const lineStart = halign === 'right' ? textX - w : halign === 'center' ? textX - w / 2 : textX;
					ctx.strokeStyle = ctx.fillStyle as string;
					ctx.lineWidth = 1;
					ctx.beginPath();
					if (style.underline === true) {
						const uy = Math.round(midY + 6) - 0.5;
						ctx.moveTo(lineStart, uy);
						ctx.lineTo(lineStart + w, uy);
					}
					if (style.strike === true) {
						const sy = Math.round(midY) - 0.5;
						ctx.moveTo(lineStart, sy);
						ctx.lineTo(lineStart + w, sy);
					}
					ctx.stroke();
				}
				ctx.restore();
			}
		}

		// 3b. W-G-2a: multi-cell selection range -- a translucent fill + an outer accent border over the
		// rect spanning anchor..focus. Painted UNDER the focus box (item 4) so the active cell stays crisp.
		// `selection` is non-null only for a real range. Skip when the range does not intersect this pane's
		// visible window (mirror the focus-box LOW-2 guard); the pane clip keeps any bleed inside the pane.
		if (
			selection !== null &&
			selection.maxRow >= rowRange.startIdx &&
			selection.minRow < rowRange.endIdx &&
			selection.maxCol >= colRange.startIdx &&
			selection.minCol < colRange.endIdx
		) {
			const rx = Math.round(colX(selection.minCol, gutterW) - effScrollLeft);
			const ry = Math.round(rowY(selection.minRow) - effScrollTop);
			const rw = Math.round(colX(selection.maxCol + 1, gutterW) - effScrollLeft) - rx;
			const rh = Math.round(rowY(selection.maxRow + 1) - effScrollTop) - ry;
			ctx.fillStyle = this.palette.rangeFill;
			ctx.fillRect(rx, ry, rw, rh);
			ctx.strokeStyle = this.palette.selectionBorder;
			ctx.lineWidth = SELECTION_BORDER_PX;
			const ro = SELECTION_BORDER_PX / 2;
			ctx.strokeRect(rx + ro, ry + ro, rw - SELECTION_BORDER_PX, rh - SELECTION_BORDER_PX);
		}

		// 4. Active-cell selection box (2px accent border), if the selected cell is in the pane window. Audit
		// LOW-2: skip entirely when the active cell is scrolled off-screen (don't stroke at far-off coords).
		if (
			active !== null &&
			active.row >= rowRange.startIdx &&
			active.row < rowRange.endIdx &&
			active.col >= colRange.startIdx &&
			active.col < colRange.endIdx
		) {
			// Audit S1-MED1: snap the box origin to a device pixel (crisp on non-Electron/test).
			const x = Math.round(colX(active.col, gutterW) - effScrollLeft);
			const y = Math.round(rowY(active.row) - effScrollTop);
			ctx.strokeStyle = this.palette.selectionBorder;
			ctx.lineWidth = SELECTION_BORDER_PX;
			// Inset by half the border so the 2px stroke sits inside the cell rect.
			const o = SELECTION_BORDER_PX / 2;
			ctx.strokeRect(x + o, y + o, COL_WIDTH - SELECTION_BORDER_PX, ROW_HEIGHT - SELECTION_BORDER_PX);
		}

		// 4b. W-G bound-cell indicator: a small filled triangle in each published cell's TOP-RIGHT corner
		// (the Excel note-marker convention). Painted AFTER the value + selection visuals (so it is never
		// hidden) but BEFORE the sticky bands, which correctly cover a cell scrolled under them. Iterate each
		// published range intersected with the pane window -- O(published cells in view).
		if (publishedRanges.length > 0) {
			ctx.fillStyle = this.palette.publishedBadge;
			for (const pr of publishedRanges) {
				const r0 = Math.max(pr.startRow, rowRange.startIdx);
				const r1 = Math.min(pr.endRow, rowRange.endIdx - 1);
				const c0 = Math.max(pr.startCol, colRange.startIdx);
				const c1 = Math.min(pr.endCol, colRange.endIdx - 1);
				for (let r = r0; r <= r1; r += 1) {
					const by = Math.round(rowY(r) - effScrollTop);
					for (let c = c0; c <= c1; c += 1) {
						const right = Math.round(colX(c, gutterW) - effScrollLeft) + COL_WIDTH;
						ctx.beginPath();
						ctx.moveTo(right - PUBLISHED_BADGE_PX, by);
						ctx.lineTo(right, by);
						ctx.lineTo(right, by + PUBLISHED_BADGE_PX);
						ctx.closePath();
						ctx.fill();
					}
				}
			}
		}

		// 4c. W-G fill handle: the drag-PREVIEW outline -- a dashed accent border around the rect the fill
		// will cover. Painted only while a fill drag is active and only when it intersects this pane window.
		if (
			fillPreview !== null &&
			fillPreview.maxRow >= rowRange.startIdx && fillPreview.minRow < rowRange.endIdx &&
			fillPreview.maxCol >= colRange.startIdx && fillPreview.minCol < colRange.endIdx
		) {
			const px = Math.round(colX(fillPreview.minCol, gutterW) - effScrollLeft);
			const py = Math.round(rowY(fillPreview.minRow) - effScrollTop);
			const pw = Math.round(colX(fillPreview.maxCol + 1, gutterW) - effScrollLeft) - px;
			const ph = Math.round(rowY(fillPreview.maxRow + 1) - effScrollTop) - py;
			ctx.save();
			ctx.strokeStyle = this.palette.selectionBorder;
			ctx.lineWidth = 1;
			ctx.setLineDash([FILL_HANDLE_PX / 2, FILL_HANDLE_PX / 2]);
			ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
			ctx.restore();
		}

		// 4c-2. FE-3 range-pick / point mode: the drag-PREVIEW outline of the cell/range being pointed into the
		// formula being edited. A DISTINCT, tighter dash than the fill handle's so it reads as "pointing a
		// reference", not a fill. Painted only while a point drag is active and only when it intersects this pane
		// window. The fill and point previews are MUTUALLY EXCLUSIVE (a fill needs no open editor; a point needs
		// one), so a frame never carries both -- but they ride INDEPENDENT channels so neither can stamp the
		// other's state. (Own block scope, so its `px/py/pw/ph` never collide with the fill block's.)
		if (
			pointPreview !== null &&
			pointPreview.maxRow >= rowRange.startIdx && pointPreview.minRow < rowRange.endIdx &&
			pointPreview.maxCol >= colRange.startIdx && pointPreview.minCol < colRange.endIdx
		) {
			const px = Math.round(colX(pointPreview.minCol, gutterW) - effScrollLeft);
			const py = Math.round(rowY(pointPreview.minRow) - effScrollTop);
			const pw = Math.round(colX(pointPreview.maxCol + 1, gutterW) - effScrollLeft) - px;
			const ph = Math.round(rowY(pointPreview.maxRow + 1) - effScrollTop) - py;
			ctx.save();
			ctx.strokeStyle = this.palette.selectionBorder;
			ctx.lineWidth = 1;
			ctx.setLineDash([3, 2]);
			ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
			ctx.restore();
		}

		// 4c-3. FE-3 colored references: one SOLID 2px colored box per referenced cell/range in the formula
		// being edited (Excel's colored ref boxes). Painted AFTER the point-mode preview (4c-2) and BEFORE the
		// fill handle (4d) so the small fill square stays on top. Each highlight strokes ONE rect for its whole
		// range (NOT per-cell, unlike the published badges) -> O(refs) per pane, cheap even on `A1:Z100000`. The
		// `colorIndex` cycles the palette modulo its length (identical refs already share a slot upstream). A
		// faint matching fill wash reads as "this range is referenced" without obscuring cell values. Each box is
		// intersected against the pane's visible window (the pane clip also keeps any bleed inside the pane), and
		// skipped if the palette is somehow empty (defensive -- readPalette always populates it).
		const refColors = this.palette.refHighlightColors;
		if (refHighlights.length > 0 && refColors.length > 0) {
			ctx.save();
			ctx.lineWidth = REF_HIGHLIGHT_PX;
			const o = REF_HIGHLIGHT_PX / 2;
			for (const h of refHighlights) {
				const rh = h.rect;
				if (
					rh.maxRow < rowRange.startIdx || rh.minRow >= rowRange.endIdx ||
					rh.maxCol < colRange.startIdx || rh.minCol >= colRange.endIdx
				) {
					continue; // this referenced range does not intersect the pane's visible window
				}
				// colorIndex is >= 0 for every drawable highlight (the host filters out the -1 non-drawables), but
				// guard defensively so a stray negative can never index from the end of the palette array.
				const color = refColors[((h.colorIndex % refColors.length) + refColors.length) % refColors.length];
				const rx = Math.round(colX(rh.minCol, gutterW) - effScrollLeft);
				const ry = Math.round(rowY(rh.minRow) - effScrollTop);
				const rw = Math.round(colX(rh.maxCol + 1, gutterW) - effScrollLeft) - rx;
				const ryh = Math.round(rowY(rh.maxRow + 1) - effScrollTop) - ry;
				ctx.fillStyle = color;
				ctx.globalAlpha = REF_HIGHLIGHT_FILL_ALPHA;
				ctx.fillRect(rx, ry, rw, ryh);
				ctx.globalAlpha = 1;
				ctx.strokeStyle = color;
				ctx.strokeRect(rx + o, ry + o, rw - REF_HIGHLIGHT_PX, ryh - REF_HIGHLIGHT_PX);
			}
			ctx.restore();
		}

		// 4d. W-G fill handle: a small solid square at the bottom-right corner of the selection (or the
		// active cell) -- the Excel drag-to-fill affordance. A background-coloured halo keeps it visible
		// against a selected (filled) range. Painted only when that corner cell is in the pane window.
		const handleBR = selection !== null ? { row: selection.maxRow, col: selection.maxCol } : active;
		if (
			handleBR !== null &&
			handleBR.row >= rowRange.startIdx && handleBR.row < rowRange.endIdx &&
			handleBR.col >= colRange.startIdx && handleBR.col < colRange.endIdx
		) {
			const cx = Math.round(colX(handleBR.col + 1, gutterW) - effScrollLeft);
			const cy = Math.round(rowY(handleBR.row + 1) - effScrollTop);
			const half = FILL_HANDLE_PX / 2;
			ctx.fillStyle = this.palette.background;
			ctx.fillRect(cx - half - 1, cy - half - 1, FILL_HANDLE_PX + 2, FILL_HANDLE_PX + 2);
			ctx.fillStyle = this.palette.selectionBorder;
			ctx.fillRect(cx - half, cy - half, FILL_HANDLE_PX, FILL_HANDLE_PX);
		}

		ctx.restore();
	}

	/**
	 * Sticky row-number gutter. **W3 frozen panes**: paints the row numbers for BOTH the FROZEN rows
	 * `[0, fRows)` (pinned at `rowY(r)-0`, clipped to `[HEADER_HEIGHT, bodyTop)`) AND the SCROLLING body
	 * rows `[startRow, endRow)` (at `rowY(r)-scrollTop`, clipped to `[bodyTop, cssHeight)`), so each row
	 * number lines up with its cell pane. With `fRows===0`, `bodyTop===HEADER_HEIGHT` and the frozen loop is
	 * empty -> byte-identical to the pre-W3 single clip from HEADER_HEIGHT down.
	 */
	private drawGutter(
		scrollTop: number,
		gutterW: number,
		cssHeight: number,
		startRow: number,
		endRow: number,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		fRows: number,
		bodyTop: number,
	): void {
		const ctx = this.ctx;
		// Audit MED-3: opaque base FIRST (headerBg may be translucent; without it the gridlines drawn
		// across the body show through the sticky gutter). Mirrors drawHeader.
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, gutterW, cssHeight);
		ctx.fillStyle = this.palette.headerBg;
		ctx.fillRect(0, 0, gutterW, cssHeight);
		ctx.font = this.headerFont;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		// Paint the row labels for a band of rows at an effective scroll, clipped to its viewport Y span.
		// Audit S1-LOW2: clip to the gutter width too so a wider-than-gutter row number can never bleed right.
		const paintRowLabels = (rowStart: number, rowEnd: number, effScrollTop: number, clipY0: number, clipY1: number): void => {
			if (rowEnd <= rowStart || clipY1 <= clipY0) {
				return;
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, clipY0, gutterW, clipY1 - clipY0);
			ctx.clip();
			for (let r = rowStart; r < rowEnd; r += 1) {
				const y = Math.round(rowY(r) - effScrollTop);
				// W-G-2a: tint every row in the selection range (or just the active row when there is no range).
				const tinted = selection !== null
					? r >= selection.minRow && r <= selection.maxRow
					: active !== null && active.row === r;
				// Sheets retheme: the FOCUS row (the active cell's own row number) gets the accent + bold;
				// other tinted rows in a range get the accent (not bold); untinted rows are muted.
				const isFocusRow = active !== null && active.row === r;
				if (tinted) {
					ctx.fillStyle = this.palette.headerActiveBg;
					ctx.fillRect(0, y, gutterW, ROW_HEIGHT);
				} else if (r === this.hoveredHeaderRow) {
					// Sheets retheme (header hover): a faint hover wash on the pointed-at row number. Painted ONLY
					// when the row is NOT active/selected -- the active highlight (above) always wins.
					ctx.fillStyle = this.palette.headerHoverBg;
					ctx.fillRect(0, y, gutterW, ROW_HEIGHT);
				}
				ctx.font = isFocusRow ? this.headerActiveFont : this.headerFont;
				ctx.fillStyle = tinted ? this.palette.accent : this.palette.headerText;
				ctx.fillText(String(r + 1), gutterW - CELL_PAD, y + ROW_HEIGHT / 2);
			}
			ctx.restore();
		};
		// Scrolling body rows (below the frozen band), then the pinned frozen rows ON TOP of any body bleed.
		paintRowLabels(startRow, endRow, scrollTop, bodyTop, cssHeight);
		paintRowLabels(0, fRows, 0, HEADER_HEIGHT, bodyTop);
		// Gutter right border + per-row bottom borders (frozen rows at effScroll 0, body rows at scrollTop).
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const rx = Math.round(gutterW) - 0.5;
		ctx.moveTo(rx, 0);
		ctx.lineTo(rx, cssHeight);
		for (let r = startRow; r <= endRow; r += 1) {
			const y = Math.round(rowY(r) - scrollTop) - 0.5;
			if (y >= bodyTop - 0.5) {
				ctx.moveTo(0, y);
				ctx.lineTo(gutterW, y);
			}
		}
		for (let r = 0; r <= fRows; r += 1) {
			const y = Math.round(rowY(r) - 0) - 0.5;
			ctx.moveTo(0, y);
			ctx.lineTo(gutterW, y);
		}
		ctx.stroke();
		ctx.textAlign = 'left';
	}

	/**
	 * Sticky column-letter header. **W3 frozen panes**: paints the labels for BOTH the FROZEN cols
	 * `[0, fCols)` (pinned at `colX(c)-0`, clipped to `[gutterW, bodyLeft)`) AND the SCROLLING body cols
	 * `[startCol, endCol)` (at `colX(c)-scrollLeft`, clipped to `[bodyLeft, cssWidth)`). With `fCols===0`,
	 * `bodyLeft===gutterW` and the frozen loop is empty -> byte-identical to the pre-W3 path.
	 */
	private drawHeader(
		scrollLeft: number,
		gutterW: number,
		cssWidth: number,
		startCol: number,
		endCol: number,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		fCols: number,
		bodyLeft: number,
	): void {
		const ctx = this.ctx;
		// Opaque base FIRST (the headerBg may be translucent; cells/gridlines must not bleed through).
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, cssWidth, HEADER_HEIGHT);
		ctx.fillStyle = this.palette.headerBg;
		ctx.fillRect(0, 0, cssWidth, HEADER_HEIGHT);
		ctx.font = this.headerFont;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		const textY = HEADER_HEIGHT / 2;
		// Paint the column labels for a band of cols at an effective scroll, clipped to its viewport X span.
		const paintColLabels = (colStart: number, colEnd: number, effScrollLeft: number, clipX0: number, clipX1: number): void => {
			if (colEnd <= colStart || clipX1 <= clipX0) {
				return;
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(clipX0, 0, clipX1 - clipX0, HEADER_HEIGHT);
			ctx.clip();
			for (let c = colStart; c < colEnd; c += 1) {
				// Audit S1-LOW3: snap the column origin so the active-col tint + label clip align with the
				// (rounded) header separators.
				const x = Math.round(colX(c, gutterW) - effScrollLeft);
				// W-G-2a: tint every column in the selection range (or just the active col when there is no range).
				const tinted = selection !== null
					? c >= selection.minCol && c <= selection.maxCol
					: active !== null && active.col === c;
				// Sheets retheme: the FOCUS column letter (the active cell's own column) goes accent + bold;
				// the rest of a range goes accent (normal weight); untinted letters are muted.
				const isFocusCol = active !== null && active.col === c;
				if (tinted) {
					ctx.fillStyle = this.palette.headerActiveBg;
					ctx.fillRect(x, 0, COL_WIDTH, HEADER_HEIGHT);
					// Sheets retheme: a 2px accent UNDERLINE beneath the active column letter (the Sheets
					// "selected column" affordance). Sits at the header's bottom edge, inside the band.
					ctx.fillStyle = this.palette.accent;
					ctx.fillRect(x, HEADER_HEIGHT - 2, COL_WIDTH, 2);
				} else if (c === this.hoveredHeaderCol) {
					// Sheets retheme (header hover): a faint hover wash on the pointed-at column letter. Painted
					// ONLY when the column is NOT active/selected -- the active highlight (above) always wins.
					ctx.fillStyle = this.palette.headerHoverBg;
					ctx.fillRect(x, 0, COL_WIDTH, HEADER_HEIGHT);
				}
				ctx.save();
				ctx.beginPath();
				ctx.rect(x, 0, COL_WIDTH, HEADER_HEIGHT);
				ctx.clip();
				ctx.font = isFocusCol ? this.headerActiveFont : this.headerFont;
				ctx.fillStyle = tinted ? this.palette.accent : this.palette.headerText;
				ctx.fillText(columnLabel(c), x + COL_WIDTH / 2, textY);
				ctx.restore();
			}
			ctx.restore();
		};
		paintColLabels(startCol, endCol, scrollLeft, bodyLeft, cssWidth);
		paintColLabels(0, fCols, 0, gutterW, bodyLeft);
		// Header bottom border + per-column separators.
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const by = Math.round(HEADER_HEIGHT) - 0.5;
		ctx.moveTo(0, by);
		ctx.lineTo(cssWidth, by);
		for (let c = startCol; c <= endCol; c += 1) {
			const sx = Math.round(colX(c, gutterW) - scrollLeft) - 0.5;
			if (sx >= bodyLeft - 0.5) {
				ctx.moveTo(sx, 0);
				ctx.lineTo(sx, HEADER_HEIGHT);
			}
		}
		for (let c = 0; c <= fCols; c += 1) {
			const sx = Math.round(colX(c, gutterW) - 0) - 0.5;
			ctx.moveTo(sx, 0);
			ctx.lineTo(sx, HEADER_HEIGHT);
		}
		ctx.stroke();
		ctx.textAlign = 'left';
		ctx.font = this.bodyFont;
	}

	/** The corner box at the gutter/header intersection (drawn last so it owns both seams). */
	private drawCorner(gutterW: number): void {
		const ctx = this.ctx;
		// Audit MED-3: opaque base FIRST, then a SINGLE headerBg -- overwriting the header's headerBg in
		// this region (otherwise the corner would be double-tinted: header's headerBg + corner's headerBg).
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, gutterW, HEADER_HEIGHT);
		ctx.fillStyle = this.palette.headerBg;
		ctx.fillRect(0, 0, gutterW, HEADER_HEIGHT);
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const rx = Math.round(gutterW) - 0.5;
		const by = Math.round(HEADER_HEIGHT) - 0.5;
		ctx.moveTo(rx, 0);
		ctx.lineTo(rx, HEADER_HEIGHT);
		ctx.moveTo(0, by);
		ctx.lineTo(gutterW, by);
		ctx.stroke();
		// Sheets retheme: the small "select-all" triangle in the corner box's bottom-right (the Sheets/Excel
		// affordance). A right triangle hugging the bottom-right inner edge, pointing up-left. Sized to a 9px
		// leg inset ~7px from the gutter/header seam so it never touches the borders. Adapts the Codex snippet
		// to the real corner geometry (`gutterW`, `HEADER_HEIGHT`), and is clamped so a narrow gutter can't push
		// it off the left edge.
		const tri = 9; // leg length (CSS px)
		const inset = 7; // gap from the bottom-right seam
		const xR = gutterW - inset; // triangle's right edge
		const yB = HEADER_HEIGHT - inset; // triangle's bottom edge
		const xL = Math.max(2, xR - tri); // left vertex, clamped inside the corner box
		const yT = Math.max(2, yB - tri); // top vertex, clamped inside the corner box
		ctx.fillStyle = this.palette.cornerTriangle;
		ctx.beginPath();
		ctx.moveTo(xL, yB);
		ctx.lineTo(xR, yT);
		ctx.lineTo(xR, yB);
		ctx.closePath();
		ctx.fill();
	}

	/**
	 * **Sheets retheme (2026-06-10)** -- the single touch that sells the spreadsheet illusion: a live
	 * `cursor` over the canvas. Attaches ONE `mousemove` listener to the canvas (the renderer owns the
	 * element) that sets `canvas.style.cursor` from a cheap geometric hit-test of the pointer:
	 *   - **`cell`** over the grid BODY (below the header, right of the gutter) -- the Sheets/Excel block cursor;
	 *   - **`default`** in the header band / row gutter / corner box.
	 *
	 * Round 5 (2026-06-10): the `col-resize`/`row-resize` cursors were REMOVED -- they implied a header
	 * resize that was never wired (the audit's "the resize cursor is a lie" finding). Sets a baseline `cell`
	 * cursor immediately so the body shows the block cursor before the first pointer move. This is the ONLY
	 * cursor the renderer sets; the `#sheets-canvas` CSS rule sets none (confirmed -- nothing to defer).
	 */
	private installCursorHitTest(): void {
		// Baseline: the grid body is the dominant surface; show the Sheets block cursor up front.
		this.canvas.style.cursor = 'cell';
		this.canvas.addEventListener('mousemove', ev => {
			const rect = this.canvas.getBoundingClientRect();
			const localX = ev.clientX - rect.left;
			const localY = ev.clientY - rect.top;
			this.canvas.style.cursor = this.cursorAt(localX, localY);
			// Sheets retheme (header hover): also update which header letter / row number is under the pointer
			// (the Sheets "hover a header" cue) and repaint that one cell's wash when it changes.
			this.updateHeaderHover(localX, localY);
		});
		// Clear the hover wash the instant the pointer leaves the canvas (Sheets drops the cue immediately).
		this.canvas.addEventListener('mouseleave', () => {
			this.setHeaderHover(-1, -1);
		});
	}

	/**
	 * **Sheets retheme (header hover)** -- map a VIEWPORT-LOCAL pointer (canvas px) to the column-letter cell
	 * / row-number cell it is over (or none) and update {@link hoveredHeaderCol} / {@link hoveredHeaderRow}.
	 * The column header band hovers a COLUMN (never a row); the row gutter hovers a ROW (never a column); the
	 * body and the corner box hover NOTHING (the body has the block cursor, the corner is the select-all box).
	 * Reuses the SAME effective-scroll-per-band geometry as {@link cursorAt} so the highlighted header lines up
	 * with the gridlines the user sees. Pure index math -- the repaint is debounced + change-gated in
	 * {@link setHeaderHover}.
	 */
	private updateHeaderHover(localX: number, localY: number): void {
		const gutterW = this.gutterW;
		const inHeaderBand = localY < HEADER_HEIGHT;
		const inGutter = localX < gutterW;
		if (inHeaderBand && inGutter) {
			this.setHeaderHover(-1, -1); // corner box -- no header hover
			return;
		}
		if (inHeaderBand) {
			// Column-letter band: which column is under the pointer (frozen cols pinned, body cols scrolled).
			const fColsPx = frozenColsWidth(this.frozenColCount);
			const effScrollLeft = localX < gutterW + fColsPx ? 0 : this.lastScrollLeft;
			const contentX = localX + effScrollLeft - gutterW;
			const col = Math.floor(contentX / COL_WIDTH);
			this.setHeaderHover(col >= 0 && col < MAX_COLS ? col : -1, -1);
			return;
		}
		if (inGutter) {
			// Row-number gutter: which row is under the pointer (frozen rows pinned, body rows scrolled).
			const fRowsPx = frozenRowsHeight(this.frozenRowCount);
			const effScrollTop = localY < HEADER_HEIGHT + fRowsPx ? 0 : this.lastScrollTop;
			const contentY = localY + effScrollTop - HEADER_HEIGHT;
			const row = Math.floor(contentY / ROW_HEIGHT);
			this.setHeaderHover(-1, row >= 0 && row < MAX_ROWS ? row : -1);
			return;
		}
		// Grid body: no header hover.
		this.setHeaderHover(-1, -1);
	}

	/**
	 * **Sheets retheme (header hover)** -- set the hovered header col/row and, ONLY when it actually changed,
	 * schedule a single coalesced repaint on the next animation frame (guard against mousemove churn -- a burst
	 * of moves across one header cell repaints at most once). The repaint REPLAYS the last full {@link draw}
	 * with the new hover index (the renderer's only self-mutated input); a no-op until the first draw recorded
	 * {@link lastDrawArgs}.
	 */
	private setHeaderHover(col: number, row: number): void {
		if (col === this.hoveredHeaderCol && row === this.hoveredHeaderRow) {
			return;
		}
		this.hoveredHeaderCol = col;
		this.hoveredHeaderRow = row;
		if (this.hoverRepaintRaf !== 0 || this.lastDrawArgs === null) {
			return; // a repaint is already queued, or nothing has been drawn yet to replay
		}
		this.hoverRepaintRaf = requestAnimationFrame(() => {
			this.hoverRepaintRaf = 0;
			const a = this.lastDrawArgs;
			if (a === null) {
				return;
			}
			this.draw(a.cssWidth, a.cssHeight, a.scrollTop, a.scrollLeft, a.errorCells, a.active, a.selection, a.publishedRanges, a.fillPreview, a.pointPreview, a.refHighlights);
		});
	}

	/**
	 * **Sheets retheme** -- the cursor string for a VIEWPORT-LOCAL pointer (canvas px). Pure (no DOM read;
	 * the caller supplies the local point), so it stays unit-reasoned. See {@link installCursorHitTest}.
	 */
	private cursorAt(localX: number, localY: number): string {
		const inHeaderBand = localY < HEADER_HEIGHT;
		const inGutter = localX < this.gutterW;
		// Round 5 (2026-06-10) -- the column header band, the row-number gutter, and the corner box all show
		// a plain arrow. The previous `col-resize`/`row-resize` affordance was REMOVED: it implied a column/
		// row resize that is NOT wired (the round-5 audit's "the resize cursor is a lie" finding -- an
		// investor who drags a header border and sees nothing happen reads it as broken). True per-column/row
		// resize requires the variable-geometry refactor (137 uniform-COL_WIDTH call sites across the
		// hit-test / blit / frozen-pane core); it is a tracked follow-up and will restore this cursor.
		if (inHeaderBand || inGutter) {
			return 'default';
		}
		// Grid body (below the header, right of the gutter): the Sheets/Excel block cursor.
		return 'cell';
	}

	/** Cached `measureText().width` at the font the caller has set on the ctx (cache cleared on font
	 *  change). `fontKey` is the style prefix active on the ctx ('' = the plain body font) -- round-5
	 *  audit MED: keying on the string alone let a BOLD cell's width poison the entry a later plain
	 *  cell with the same text read (and vice-versa), skewing truncation. The key carries the font. */
	private measure(text: string, fontKey: string = ''): number {
		const key = fontKey === '' ? text : fontKey + '\u0000' + text;
		let w = this.measureCache.get(key);
		if (w === undefined) {
			w = this.ctx.measureText(text).width;
			this.measureCache.set(key, w);
			if (this.measureCache.size > MEASURE_CACHE_MAX) {
				const evictCount = Math.floor(this.measureCache.size / 2);
				let i = 0;
				for (const key of this.measureCache.keys()) {
					if (i >= evictCount) {
						break;
					}
					this.measureCache.delete(key);
					i += 1;
				}
			}
		}
		return w;
	}

	private readPalette(): Palette {
		const cs = getComputedStyle(document.body);
		const v = (name: string, fallback: string): string => {
			const raw = cs.getPropertyValue(name).trim();
			if (raw.length > 0) {
				return raw;
			}
			warnMissingThemeVar(name, fallback);
			return fallback;
		};
		const background = v('--vscode-editor-background', '#1e1e1e');
		const isDark = CanvasGridRenderer.isDarkColor(background);
		// Brand accent (2026-06-10): Quantlab's brand color from the theme, the SAME var+fallback pattern
		// tokens.css uses for `--ql-accent`. This replaces the previous hardcoded Sheets-blue / charts-blue
		// read -- the operator wants the BRAND color wherever Excel/Sheets show theirs. Cached in the palette
		// like every other theme color; refreshTheme() re-resolves it on a theme change.
		const rawAccent = v('--vscode-quantlabAccent', QUANTLAB_ACCENT_FALLBACK);
		// Round-5 audit (finding D): the translucent washes already fall back to the canonical hex when the
		// accent is unparseable (via accentTint), but the OPAQUE uses (selectionBorder / cornerTriangle /
		// the `accent` header text) assigned the raw string directly -- an unparseable theme value would
		// make `ctx.strokeStyle = accent` a silent no-op and leave the selection ring in a STALE color.
		// Normalize ONCE here so every accent use (opaque + tint) shares the same known-good value.
		const accent = CanvasGridRenderer.parseCssColorRgb(rawAccent) === null ? QUANTLAB_ACCENT_FALLBACK : rawAccent;
		// Derive the translucent accent washes from the RESOLVED accent (theme-provided or fallback), so a
		// theme that overrides the brand color tints consistently. accentTint handles #rgb/#rrggbb/rgb()/
		// rgba() (the forms a theme var can carry) and warns ONCE + tints the known-good fallback if the
		// theme hands us something unparseable (No-Fallbacks: surfaced, never silent).
		const tint = (alpha: number): string => CanvasGridRenderer.accentTint(accent, alpha);
		return {
			foreground: v('--vscode-foreground', '#cccccc'),
			background,
			// Sheets retheme: the header band / row gutter sit on a subtle wash distinct from the cell area
			// (Sheets greys the headers a touch). A faint foreground-tinted overlay on either theme.
			headerBg: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
			// Brand accent: the ACTIVE row/col header band -- a faint accent wash over the headers of the
			// selected range (the Excel-style "selected range tints its headers" treatment; was a heavy
			// list-activeSelection fill that read brown on warm themes, then a hardcoded Sheets-blue rgba).
			headerActiveBg: tint(ACCENT_HEADER_FILL_ALPHA),
			// Sheets retheme: a LIGHT, low-contrast gridline. On a light theme the Sheets `~#e0e0e0` look
			// (a faint black overlay); on a dark theme a faint white overlay so lines stay subtle, not heavy.
			border: isDark ? 'rgba(255,255,255,0.08)' : SHEETS_GRIDLINE_LIGHT,
			descriptionFg: v('--vscode-descriptionForeground', '#9d9d9d'),
			errorFg: v('--vscode-errorForeground', '#f48771'),
			errorBg: v('--vscode-inputValidation-errorBackground', 'rgba(190,40,40,0.25)'),
			// Brand accent: the active-cell ring + selection-rect border + fill handle + fill-preview dash all
			// stroke/fill `selectionBorder`, which IS the opaque brand accent (the Excel "selected cell
			// outline in the product color" treatment -- not the editor focusBorder, which varies per theme).
			selectionBorder: accent,
			// Brand accent: a ~15% accent wash over a multi-cell range (translucent so values read through).
			rangeFill: tint(ACCENT_RANGE_FILL_ALPHA),
			// W-G bound-cell badge: a "live data" green, deliberately NOT the brand accent -- a distinct hue
			// from the accent focus/selection border so a selected published cell shows both markers.
			publishedBadge: v('--vscode-charts-green', '#89d185'),
			// Sheets-parity: muted header letters / row numbers (the active one overrides to `accent`+bold).
			headerText: v('--vscode-descriptionForeground', isDark ? '#9d9d9d' : '#5f6368'),
			accent,
			// Brand accent (header hover): a faint accent wash, strictly lighter than `headerActiveBg` so the
			// active-selection highlight always wins when a hovered header is also the active row/col.
			headerHoverBg: tint(ACCENT_HEADER_HOVER_ALPHA),
			// Brand accent: the select-all corner triangle in the OPAQUE accent (per the brand-accent spec --
			// Excel/Sheets accent their select-all affordance; ours is the brand mark in the corner box). A
			// tiny glyph, so the full-strength accent reads as a deliberate accent, not noise.
			cornerTriangle: accent,
			// Tables wave (2026-06-13): a table HEADER band is the brand accent wash (Excel-table-style branded
			// header), derived from the SAME resolved accent as every other accent wash so a themed accent tints
			// the table too. A translucent wash -> header text reads through; legible on light + dark (the alpha
			// is what's tuned, not a per-theme hue).
			tableHeaderBand: tint(TABLE_HEADER_ALPHA),
			// Tables wave: the alternating DATA-row band is a NEUTRAL foreground-tinted wash (not the accent), so
			// it reads as a quiet zebra-stripe, not a second accent block. A foreground tint flips with the theme
			// (dark fg-on-light / light fg-on-dark) the same way `headerBg` does.
			tableDataBand: isDark ? 'rgba(255,255,255,' + TABLE_BAND_ALPHA + ')' : 'rgba(0,0,0,' + TABLE_BAND_ALPHA + ')',
			// Tables wave: the outer border flips light/dark (a dark stroke on a light editor, light on dark) so
			// the table extent stays legible on both -- the same light/dark split as the gridline `border`.
			tableBorder: isDark ? TABLE_BORDER_COLOR_DARK : TABLE_BORDER_COLOR_LIGHT,
			// FE-3 colored references: the rotating ref-box palette, sourced from the theme chart hues (the same
			// `--vscode-charts-*` family `publishedBadge` reads). Six visually-distinct hues so adjacent refs in a
			// formula stay tellable apart; the renderer cycles through them modulo length. Each hue gets a hex
			// fallback (the `v` helper warns once + uses it if the theme omits the var), so the list is always
			// non-empty + fully populated. Order chosen for max adjacent contrast (blue, orange, green, purple,
			// red, yellow) -- the first ref (the common single-ref case) is the brand-adjacent blue.
			refHighlightColors: [
				v('--vscode-charts-blue', '#4f9cff'),
				v('--vscode-charts-orange', '#d8843b'),
				v('--vscode-charts-green', '#89d185'),
				v('--vscode-charts-purple', '#b180d7'),
				v('--vscode-charts-red', '#f14c4c'),
				v('--vscode-charts-yellow', '#d7ba7d'),
			],
		};
	}

	/**
	 * **Brand accent (2026-06-10)** -- parse a CSS color string into its RGB channels, or `null` when the
	 * form is not one we handle. Handles `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha ignored -- the caller
	 * supplies its own), `rgb()` and `rgba()` -- the forms a VS Code theme var / our fallbacks carry.
	 * Extracted from the body of {@link isDarkColor} (the file's pre-existing color parser, per the
	 * brand-accent spec: reuse it, don't duplicate) so BOTH the dark-gridline adaptation and the
	 * accent-tint derivation ({@link accentTint}) share one parser. Pure (string in, channels out; no
	 * `this`), so the two call sites cannot drift.
	 */
	private static parseCssColorRgb(color: string): { r: number; g: number; b: number } | null {
		const c = color.trim();
		let r: number;
		let g: number;
		let b: number;
		const hex = c.startsWith('#') ? c.slice(1) : '';
		if (hex.length === 3) {
			r = parseInt(hex[0] + hex[0], 16);
			g = parseInt(hex[1] + hex[1], 16);
			b = parseInt(hex[2] + hex[2], 16);
		} else if (hex.length === 6 || hex.length === 8) {
			r = parseInt(hex.slice(0, 2), 16);
			g = parseInt(hex.slice(2, 4), 16);
			b = parseInt(hex.slice(4, 6), 16);
		} else {
			const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
			if (m === null) {
				return null;
			}
			r = Number(m[1]);
			g = Number(m[2]);
			b = Number(m[3]);
		}
		if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
			return null;
		}
		return { r, g, b };
	}

	/**
	 * **Brand accent (2026-06-10)** -- an `rgba()` string of the resolved accent at the given alpha, for
	 * the derived translucent washes (selection range fill, header highlight band, header hover). The
	 * accent itself comes from the theme (`--vscode-quantlabAccent`) so it can be ANY parseable CSS color;
	 * when the theme hands us a form {@link parseCssColorRgb} cannot read (e.g. `hsl()`), we `console.warn`
	 * ONCE (No-Fallbacks: a silent default would mask a broken/exotic theme value) and tint the canonical
	 * `#FF7331` fallback instead -- which is statically known to parse, so the wash NEVER silently
	 * disappears (an un-tinted selection would be invisible, far worse than an off-brand hue).
	 */
	private static accentTint(accent: string, alpha: number): string {
		let rgb = CanvasGridRenderer.parseCssColorRgb(accent);
		if (rgb === null) {
			if (!warnedMissingVars.has('quantlabAccent-unparseable')) {
				warnedMissingVars.add('quantlabAccent-unparseable');
				console.warn(
					`[sheets-webview] the resolved brand accent "${accent}" is not a #rgb/#rrggbb/rgb()/rgba() ` +
					`color; deriving the translucent accent washes from the canonical fallback ` +
					`"${QUANTLAB_ACCENT_FALLBACK}" instead. The theme's --vscode-quantlabAccent value should use ` +
					`one of the supported forms.`,
				);
			}
			rgb = CanvasGridRenderer.parseCssColorRgb(QUANTLAB_ACCENT_FALLBACK);
			if (rgb === null) {
				// Unreachable: the fallback is a compile-time #rrggbb literal. Throw rather than paint garbage.
				throw new Error('sheets-webview: QUANTLAB_ACCENT_FALLBACK failed to parse -- constant corrupted');
			}
		}
		return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
	}

	/**
	 * **Sheets retheme** -- perceived-luminance check so the palette can pick a LIGHT gridline on a light
	 * theme (`~#e0e0e0`) vs a faint WHITE line on a dark theme. Parses via {@link parseCssColorRgb} (the
	 * shared parser; only the forms VS Code injects for `--vscode-editor-background`); an unparseable value
	 * defaults to "dark" (the common VS Code default), which keeps the line subtle either way. Pure-ish
	 * (string in, boolean out; no `this`).
	 */
	private static isDarkColor(color: string): boolean {
		const rgb = CanvasGridRenderer.parseCssColorRgb(color);
		if (rgb === null) {
			return true; // unparseable -> assume dark (VS Code's default family)
		}
		// Rec. 601 luma; < 128 reads as a dark background.
		return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b < 128;
	}

	private readFonts(): { body: string; header: string; headerActive: string } {
		const rawFamily = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim();
		let family = rawFamily;
		if (family.length === 0) {
			warnMissingThemeVar('--vscode-font-family', 'sans-serif');
			family = 'sans-serif';
		}
		// Sheets retheme: cell text at a comfortable 13px (was 12); the header letters / row numbers slightly
		// SMALLER (11px) + normal weight so they read muted next to the cells. The ACTIVE row/col header goes
		// bold (the Sheets "current column" treatment), drawn with `headerActive`.
		return { body: '13px ' + family, header: '11px ' + family, headerActive: '600 11px ' + family };
	}
}
