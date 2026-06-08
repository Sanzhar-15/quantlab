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

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { clampDisplayString, computeVisibleRowRange, formatCellValue, isRenderableValue } from './cellRender';
import type { ScrollBlit } from './gridBlitA1';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	ROW_HEIGHT,
	type SelectionRect,
	colX,
	columnLabel,
	computeVisibleColRange,
	gutterWidth,
	isInExtent,
	rowY,
	truncateToWidth,
} from './gridLayoutA1';

const CELL_PAD = 8;
const OVERSCAN = 2;
const MEASURE_CACHE_MAX = 5000;
const SELECTION_BORDER_PX = 2;

/**
 * **FE-2-0 Phase 3 (2026-06-04)** -- when true, every partial paint ({@link CanvasGridRenderer.drawScroll}
 * / {@link CanvasGridRenderer.drawDamage}) is followed by a full repaint and a pixel-for-pixel compare;
 * any mismatch is `console.error`-ed LOUD (No-Fallbacks: a blit/damage that diverges from the full draw
 * is a BUG, surfaced, never silently shipped). Off in production (the verify defeats the optimization +
 * uses `getImageData`); a developer flips it to validate the partial paths against the full-draw oracle.
 */
const DEBUG_BLIT_VERIFY = false;

/** One extra CSS px padded around a damage band's clip so a fractional `rowY-scrollTop` (the renderer
 * rounds paint origins) can never leave a sub-pixel sliver of the band's edge unpainted. Over-painting
 * 1px into an adjacent row is idempotent (that row repaints to its identical current value). */
const DAMAGE_CLIP_PAD = 1;

/** The active (selected) cell. */
export interface ActiveCell {
	readonly row: number;
	readonly col: number;
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
}

/** Renders a {@link QuantbookCellSnapshot} as an A1 grid onto a canvas. One instance per panel. */
export class CanvasGridRenderer {
	private readonly ctx: CanvasRenderingContext2D;
	private dpr: number;
	/** `"row,col" -> entry` for O(1) paint + hover lookup AND the single source the windowed paint
	 * iterates (Audit C1-HIGH1: no separate `snapshot.entries` scan). A STRING key (not
	 * `row*MAX_COLS+col`) so an out-of-extent coordinate can never collide with a visible cell. */
	private entryByCell = new Map<string, QuantbookCellSnapshot['entries'][number]>();
	private palette: Palette;
	private bodyFont: string;
	private headerFont: string;
	/**
	 * Width of the sticky row-number gutter, in CSS px. Computed ONCE (and on theme/font change) to fit
	 * the widest POSSIBLE row number (`MAX_ROWS`), so it never shifts as you scroll -- the overlay
	 * editor, hit-test, and spacer all read a single stable value (`gutterWidthPx`) rather than a
	 * scroll-dependent one. A few px wider than needed at low row numbers; that is fine.
	 */
	private gutterW: number;
	private readonly measureCache = new Map<string, number>();
	/**
	 * **FE-0b-4** -- true once a full {@link draw} has painted the current backing store. Reset to
	 * `false` whenever {@link resize} actually changes the backing-store dimensions (which clears it),
	 * including the same-size-but-zeroed canvas a webview reload produces. (FE-2-0 no longer blits, but
	 * the gate is retained so the upcoming `gridBlitA1.ts` fast-follow can rely on it.)
	 */
	private hasPaintedOnce = false;

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
		this.gutterW = this.computeGutterWidth();
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
	}

	/** The populated entry at (row,col), or undefined for an empty cell (hover + edit pre-fill). */
	entryAt(row: number, col: number): QuantbookCellSnapshot['entries'][number] | undefined {
		return this.entryByCell.get(row + ',' + col);
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
	): void {
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection);
		this.hasPaintedOnce = true;
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
	): void {
		const ctx = this.ctx;
		const c = blit.copy;
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
			this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection);
			ctx.restore();
		}
		this.hasPaintedOnce = true;
		if (DEBUG_BLIT_VERIFY) {
			this.verifyAgainstFull(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, 'drawScroll');
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
		const addBand = (r0: number, r1: number): void => {
			const yTop = rowY(r0) - scrollTop;
			const h = (r1 - r0 + 1) * ROW_HEIGHT;
			// Pad so the rounded paint origins sit fully inside the clip (see DAMAGE_CLIP_PAD).
			ctx.rect(0, yTop - DAMAGE_CLIP_PAD, cssWidth, h + DAMAGE_CLIP_PAD * 2);
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
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection);
		ctx.restore();
		this.hasPaintedOnce = true;
		if (DEBUG_BLIT_VERIFY) {
			this.verifyAgainstFull(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection, 'drawDamage');
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
		path: string,
	): void {
		const ctx = this.ctx;
		const bw = this.canvas.width;
		const bh = this.canvas.height;
		const partial = ctx.getImageData(0, 0, bw, bh);
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells, active, selection);
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
	 * Paint the A1 grid for `scrollTop/scrollLeft`. The **single source of cell pixels**. Paint order
	 * (so the sticky bands own every overlapping seam): background -> error-cell tints -> gridlines ->
	 * values -> selection box -> row gutter (sticky left) -> column header (sticky top) -> corner box.
	 * Cells that scroll under a band are simply covered by the band's later paint (no clipping needed).
	 */
	private paintWindow(
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
	): void {
		const ctx = this.ctx;
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, cssWidth, cssHeight);

		// Visible window. Rows are independent of the gutter; the gutter width then depends on the
		// largest visible row, and the visible columns depend on the gutter -- compute in that order.
		const bodyHeight = Math.max(0, cssHeight - HEADER_HEIGHT);
		const rowRange = computeVisibleRowRange(scrollTop, bodyHeight, MAX_ROWS, ROW_HEIGHT, OVERSCAN);
		const gutterW = this.gutterW;
		const bodyWidth = Math.max(0, cssWidth - gutterW);
		const colRange = computeVisibleColRange(scrollLeft, bodyWidth, MAX_COLS, COL_WIDTH, OVERSCAN);

		// 1. Error-cell background tints (under the gridlines + text, like Excel). Audit S1-LOW: snap the
		// fill origin to a device pixel so the tint aligns with the (rounded) gridlines on non-Electron/test.
		if (errorCells.size > 0) {
			ctx.fillStyle = this.palette.errorBg;
			for (let r = rowRange.startIdx; r < rowRange.endIdx; r += 1) {
				const ly = Math.round(rowY(r) - scrollTop);
				for (let c = colRange.startIdx; c < colRange.endIdx; c += 1) {
					if (errorCells.has(r + ',' + c)) {
						ctx.fillRect(Math.round(colX(c, gutterW) - scrollLeft), ly, COL_WIDTH, ROW_HEIGHT);
					}
				}
			}
		}

		// 2. Gridlines: batched vertical + horizontal lines across the visible body (half-pixel-aligned
		// for crisp 1px). The bands painted later cover the segments that fall under the gutter/header.
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let c = colRange.startIdx; c <= colRange.endIdx; c += 1) {
			const x = Math.round(colX(c, gutterW) - scrollLeft) - 0.5;
			ctx.moveTo(x, 0);
			ctx.lineTo(x, cssHeight);
		}
		for (let r = rowRange.startIdx; r <= rowRange.endIdx; r += 1) {
			const y = Math.round(rowY(r) - scrollTop) - 0.5;
			ctx.moveTo(0, y);
			ctx.lineTo(cssWidth, y);
		}
		ctx.stroke();

		// 3. Values for the populated cells in the window. Audit C1-HIGH1: iterate the VISIBLE WINDOW
		// (bounded ~viewport rows x cols) and look up each cell in the sparse map -- O(visible cells), a hard
		// per-frame ceiling independent of the snapshot's entry count (a dense FE-1 `qb.show` could be huge).
		ctx.font = this.bodyFont;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		const valueMax = COL_WIDTH - CELL_PAD * 2;
		for (let r = rowRange.startIdx; r < rowRange.endIdx; r += 1) {
			const y = Math.round(rowY(r) - scrollTop);
			for (let c = colRange.startIdx; c < colRange.endIdx; c += 1) {
				const entry = this.entryByCell.get(r + ',' + c);
				if (entry === undefined) {
					continue; // empty cell -- gridlines only, no fillText
				}
				const x = Math.round(colX(c, gutterW) - scrollLeft);
				const isError = errorCells.has(r + ',' + c);
				// Audit C1-HIGH2: cap the display string BEFORE measure/truncate so a pathological `rendered`
				// can't freeze the binary search (which measures the full string first).
				const raw = typeof entry.rendered === 'string' ? entry.rendered : formatCellValue(entry.value);
				const shown = truncateToWidth(clampDisplayString(raw), valueMax, s => this.measure(s));
				ctx.fillStyle = isError ? this.palette.errorFg : this.palette.foreground;
				ctx.save();
				ctx.beginPath();
				ctx.rect(x, y, COL_WIDTH, ROW_HEIGHT);
				ctx.clip();
				ctx.fillText(shown, x + CELL_PAD, y + ROW_HEIGHT / 2);
				ctx.restore();
			}
		}

		// 3b. W-G-2a: multi-cell selection range -- a translucent fill + an outer accent border over the
		// rect spanning anchor..focus. Painted UNDER the focus box (item 4) so the active cell stays crisp.
		// `selection` is non-null only for a real range (the caller passes null for a single cell, so the
		// single-cell path below is unchanged). Skip when the whole range is scrolled out of the visible
		// window (mirror the focus-box LOW-2 guard -- don't stroke/fill at far-off coords); a partially
		// visible range is fine (the sticky gutter/header repaint over any bleed under the bands).
		if (
			selection !== null &&
			selection.maxRow >= rowRange.startIdx &&
			selection.minRow < rowRange.endIdx &&
			selection.maxCol >= colRange.startIdx &&
			selection.minCol < colRange.endIdx
		) {
			const rx = Math.round(colX(selection.minCol, gutterW) - scrollLeft);
			const ry = Math.round(rowY(selection.minRow) - scrollTop);
			const rw = Math.round(colX(selection.maxCol + 1, gutterW) - scrollLeft) - rx;
			const rh = Math.round(rowY(selection.maxRow + 1) - scrollTop) - ry;
			ctx.fillStyle = this.palette.rangeFill;
			ctx.fillRect(rx, ry, rw, rh);
			ctx.strokeStyle = this.palette.selectionBorder;
			ctx.lineWidth = SELECTION_BORDER_PX;
			const ro = SELECTION_BORDER_PX / 2;
			ctx.strokeRect(rx + ro, ry + ro, rw - SELECTION_BORDER_PX, rh - SELECTION_BORDER_PX);
		}

		// 4. Active-cell selection box (2px accent border), if the selected cell is in the window. Audit
		// LOW-2: skip entirely when the active cell is scrolled off-screen (don't stroke at far-off coords).
		if (
			active !== null &&
			active.row >= rowRange.startIdx &&
			active.row < rowRange.endIdx &&
			active.col >= colRange.startIdx &&
			active.col < colRange.endIdx
		) {
			// Audit S1-MED1: snap the box origin to a device pixel (crisp on non-Electron/test).
			const x = Math.round(colX(active.col, gutterW) - scrollLeft);
			const y = Math.round(rowY(active.row) - scrollTop);
			ctx.strokeStyle = this.palette.selectionBorder;
			ctx.lineWidth = SELECTION_BORDER_PX;
			// Inset by half the border so the 2px stroke sits inside the cell rect.
			const o = SELECTION_BORDER_PX / 2;
			ctx.strokeRect(x + o, y + o, COL_WIDTH - SELECTION_BORDER_PX, ROW_HEIGHT - SELECTION_BORDER_PX);
		}

		// 5. Sticky row gutter (covers cells that scrolled left under it), then header, then corner.
		this.drawGutter(scrollTop, gutterW, cssHeight, rowRange.startIdx, rowRange.endIdx, active, selection);
		this.drawHeader(scrollLeft, gutterW, cssWidth, colRange.startIdx, colRange.endIdx, active, selection);
		this.drawCorner(gutterW);
	}

	private drawGutter(
		scrollTop: number,
		gutterW: number,
		cssHeight: number,
		startRow: number,
		endRow: number,
		active: ActiveCell | null,
		selection: SelectionRect | null,
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
		// Audit S1-LOW2: clip the label region to the gutter (mirrors drawHeader's per-cell clip) so a
		// wider-than-gutter row number can never bleed right over the body. Snap each row origin too.
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, gutterW, cssHeight);
		ctx.clip();
		for (let r = startRow; r < endRow; r += 1) {
			const y = Math.round(rowY(r) - scrollTop);
			// W-G-2a: tint every row in the selection range (or just the active row when there is no range).
			const tinted = selection !== null
				? r >= selection.minRow && r <= selection.maxRow
				: active !== null && active.row === r;
			if (tinted) {
				ctx.fillStyle = this.palette.headerActiveBg;
				ctx.fillRect(0, y, gutterW, ROW_HEIGHT);
			}
			ctx.fillStyle = this.palette.foreground;
			ctx.fillText(String(r + 1), gutterW - CELL_PAD, y + ROW_HEIGHT / 2);
		}
		ctx.restore();
		// Gutter right border + per-row bottom borders.
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const rx = Math.round(gutterW) - 0.5;
		ctx.moveTo(rx, 0);
		ctx.lineTo(rx, cssHeight);
		for (let r = startRow; r <= endRow; r += 1) {
			const y = Math.round(rowY(r) - scrollTop) - 0.5;
			ctx.moveTo(0, y);
			ctx.lineTo(gutterW, y);
		}
		ctx.stroke();
		ctx.textAlign = 'left';
	}

	private drawHeader(
		scrollLeft: number,
		gutterW: number,
		cssWidth: number,
		startCol: number,
		endCol: number,
		active: ActiveCell | null,
		selection: SelectionRect | null,
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
		for (let c = startCol; c < endCol; c += 1) {
			// Audit S1-LOW3: snap the column origin so the active-col tint + label clip align with the
			// (rounded) header separators.
			const x = Math.round(colX(c, gutterW) - scrollLeft);
			// W-G-2a: tint every column in the selection range (or just the active col when there is no range).
			const tinted = selection !== null
				? c >= selection.minCol && c <= selection.maxCol
				: active !== null && active.col === c;
			if (tinted) {
				ctx.fillStyle = this.palette.headerActiveBg;
				ctx.fillRect(x, 0, COL_WIDTH, HEADER_HEIGHT);
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(x, 0, COL_WIDTH, HEADER_HEIGHT);
			ctx.clip();
			ctx.fillStyle = this.palette.foreground;
			ctx.fillText(columnLabel(c), x + COL_WIDTH / 2, textY);
			ctx.restore();
		}
		// Header bottom border + per-column separators.
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const by = Math.round(HEADER_HEIGHT) - 0.5;
		ctx.moveTo(0, by);
		ctx.lineTo(cssWidth, by);
		for (let c = startCol; c <= endCol; c += 1) {
			const sx = Math.round(colX(c, gutterW) - scrollLeft) - 0.5;
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
	}

	/** Cached `measureText().width` at the current BODY font (cache cleared on font change). */
	private measure(text: string): number {
		let w = this.measureCache.get(text);
		if (w === undefined) {
			w = this.ctx.measureText(text).width;
			this.measureCache.set(text, w);
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
		return {
			foreground: v('--vscode-foreground', '#cccccc'),
			background: v('--vscode-editor-background', '#1e1e1e'),
			headerBg: v('--vscode-keybindingTable-headerBackground', 'rgba(128,128,128,0.2)'),
			headerActiveBg: v('--vscode-list-activeSelectionBackground', 'rgba(9,71,113,0.5)'),
			border: v('--vscode-panel-border', 'rgba(128,128,128,0.35)'),
			descriptionFg: v('--vscode-descriptionForeground', '#9d9d9d'),
			errorFg: v('--vscode-errorForeground', '#f48771'),
			errorBg: v('--vscode-inputValidation-errorBackground', 'rgba(190,40,40,0.25)'),
			selectionBorder: v('--vscode-focusBorder', '#007fd4'),
			// The dimmed editor-selection color: themed AND typically translucent, so the range fill never
			// hides cell values (translucent rgba fallback if the theme omits it).
			rangeFill: v('--vscode-editor-inactiveSelectionBackground', 'rgba(9,71,113,0.25)'),
		};
	}

	private readFonts(): { body: string; header: string } {
		const rawFamily = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim();
		let family = rawFamily;
		if (family.length === 0) {
			warnMissingThemeVar('--vscode-font-family', 'sans-serif');
			family = 'sans-serif';
		}
		return { body: '12px ' + family, header: '600 12px ' + family };
	}
}
