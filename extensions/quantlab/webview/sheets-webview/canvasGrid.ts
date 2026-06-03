/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b-2 (2026-06-02) -- Canvas2D renderer for the sheets webview.**
 *
 * Replaces the FE-0b-1 DOM table. Draws the sheet snapshot (a list of populated cells, one
 * display-row per entry) onto a single `<canvas>` that overlays the scroller's viewport: the
 * header band is painted at a fixed y=0 every frame (so it stays put while rows scroll under it),
 * and the visible entry window is painted below it, offset by `scrollTop`. Geometry comes from the
 * pure `gridLayout.ts`; values format via `cellRender.formatCellValue`.
 *
 * Canvas text is drawn directly -- there is NO HTML-injection surface, so the `escapeHtml` +
 * `data-*` attribute machinery the DOM table needed is gone. Theme colours come from the VS Code
 * `--vscode-*` CSS variables (cached; refreshed on snapshot push + theme change). A small text-
 * measure cache backs width-bounded truncation.
 *
 * DOM/canvas-touching -- not unit-tested (no headless 2D context); the pure layout math is golden-
 * tested in `gridLayout.ts` and the drawing is covered by the behavioral smoke + the closure audit.
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { computeVisibleRowRange, formatCellValue } from './cellRender';
import type { ScrollBlit } from './gridBlit';
import { COLUMNS, HEADER_HEIGHT, ROW_HEIGHT, columnX, totalContentWidth, truncateToWidth } from './gridLayout';

const CELL_PAD = 8;
const KIND_GAP = 6;
const OVERSCAN = 2;
const MEASURE_CACHE_MAX = 5000;

/**
 * **FE megaudit M7 (2026-06-03)** -- module-level "already warned" guard for the
 * theme/font CSS-var reads. VS Code always injects the `--vscode-*` variables, so
 * a missing one signals a broken host/theme context; the renderer still falls back
 * to a hardcoded default (so it draws SOMETHING rather than throwing every frame),
 * but a SILENT `value || default` would mask the broken state (No-Fallbacks). We
 * `console.warn` ONCE per missing var (the guard keeps it from spamming on every
 * theme refresh / snapshot push). The font fallback is the worst case -- wrong
 * metrics silently corrupt `truncateToWidth` -- so it warns too.
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

interface Palette {
	foreground: string;
	background: string;
	headerBg: string;
	border: string;
	descriptionFg: string;
	errorFg: string;
	errorBg: string;
}

/** Renders a {@link QuantbookCellSnapshot} onto a canvas. One instance per panel webview. */
export class CanvasGridRenderer {
	private readonly ctx: CanvasRenderingContext2D;
	private dpr: number;
	private snapshot: QuantbookCellSnapshot | null = null;
	private palette: Palette;
	private bodyFont: string;
	private headerFont: string;
	private readonly measureCache = new Map<string, number>();
	/**
	 * **FE-0b-4** -- true once a full {@link draw} has painted the current backing store. The
	 * partial paths ({@link drawScroll}/{@link drawDamage}) reuse existing pixels, so they are only
	 * valid AFTER a full paint. It is reset to `false` whenever {@link resize} actually changes the
	 * backing-store dimensions (which clears it) -- including the same-size-but-zeroed canvas a
	 * webview reload produces, where a re-sent identical snapshot would otherwise diff to "no change"
	 * against a blank canvas (FE-0b-4 R3).
	 */
	private hasPaintedOnce = false;

	constructor(private readonly canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d');
		if (ctx === null) {
			throw new Error('sheets-webview: 2D canvas context unavailable');
		}
		this.ctx = ctx;
		// FE-0b-4: the blit self-`drawImage` copies axis-aligned, same-size rects -- smoothing must
		// be OFF or the copy resamples and blurs. It is persistent context state; set it once here
		// (and defensively in drawScroll).
		this.ctx.imageSmoothingEnabled = false;
		this.dpr = CanvasGridRenderer.resolveDpr();
		this.palette = this.readPalette();
		const fonts = this.readFonts();
		this.bodyFont = fonts.body;
		this.headerFont = fonts.header;
	}

	private static resolveDpr(): number {
		// FE megaudit M7: a 0 / undefined devicePixelRatio is anomalous (every real
		// browser reports >= 1). Warn ONCE before defaulting to 1 rather than silently
		// masking it (No-Fallbacks) -- a wrong DPR corrupts the HiDPI backing-store
		// scale.
		const raw = window.devicePixelRatio;
		if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
			warnMissingThemeVar('window.devicePixelRatio', '1');
			return 1;
		}
		return Math.min(2, Math.max(1, Math.ceil(raw)));
	}

	setSnapshot(snapshot: QuantbookCellSnapshot): void {
		this.snapshot = snapshot;
	}

	get entryCount(): number {
		return this.snapshot?.entries.length ?? 0;
	}

	/** **FE-0b-4** -- whether a full {@link draw} has painted the current backing store (the
	 * precondition for {@link drawScroll}/{@link drawDamage}; see {@link hasPaintedOnce}). */
	get painted(): boolean {
		return this.hasPaintedOnce;
	}

	/** **FE-0b-4** -- the device-pixel ratio the backing store is currently scaled at (always 1 or
	 * 2). The caller passes it to `computeScrollBlit` so the blit copy math matches `resize()`. */
	get backingScale(): number {
		return this.dpr;
	}

	/** Re-read theme palette + fonts (call on snapshot push + on a body-class/theme change). */
	refreshTheme(): void {
		this.palette = this.readPalette();
		const fonts = this.readFonts();
		this.bodyFont = fonts.body;
		this.headerFont = fonts.header;
		// Measurements are font-dependent -- invalidate the cache on a font change.
		this.measureCache.clear();
	}

	/** Size the backing store for HiDPI. `cssWidth/cssHeight` are the viewport's logical px. */
	resize(cssWidth: number, cssHeight: number): void {
		this.dpr = CanvasGridRenderer.resolveDpr();
		const bw = Math.max(1, Math.round(cssWidth * this.dpr));
		const bh = Math.max(1, Math.round(cssHeight * this.dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
			// FE-0b-4: assigning canvas.width/height CLEARS the backing store, so any reused pixels
			// are gone -- the next paint MUST be a full draw, not a blit/damage over a blank canvas.
			this.hasPaintedOnce = false;
			// Setting the backing store also resets context state (imageSmoothingEnabled, transform);
			// re-disable smoothing so the next blit copies crisply.
			this.ctx.imageSmoothingEnabled = false;
		}
		this.canvas.style.width = cssWidth + 'px';
		this.canvas.style.height = cssHeight + 'px';
	}

	/**
	 * Repaint the visible window. `cssWidth/cssHeight` = viewport logical size; `scrollTop/
	 * scrollLeft` from the scroller; `errorCells` = set of `"row,col"` keys to decorate (from
	 * `errorReply`). Full redraw (blit/damage is FE-0b-4).
	 */
	draw(cssWidth: number, cssHeight: number, scrollTop: number, scrollLeft: number, errorCells: ReadonlyMap<string, string>): void {
		// Full redraw -- the always-correct path AND the fallback for every partial path (FE-0b-4).
		// Reset the transform (NOT cumulative scale) then scale for HiDPI; paint the whole viewport.
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells);
		this.hasPaintedOnce = true;
	}

	/**
	 * Paint the background + the visible entry window + the sticky header for `scrollTop/scrollLeft`.
	 * The **single source of cell pixels**: {@link draw} calls it un-clipped (full viewport); the
	 * partial paths ({@link drawScroll}/{@link drawDamage}) call it under a `ctx.clip()` so only the
	 * damaged region is repainted -- which GUARANTEES the partial pixels are identical to a full
	 * redraw (same code, only the clip differs). Assumes the caller has set the dpr transform.
	 * `fillRect(0,0,w,h)` under an active clip fills only the clipped area.
	 */
	private paintWindow(
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
	): void {
		const ctx = this.ctx;
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, cssWidth, cssHeight);

		const entries = this.snapshot?.entries ?? [];
		if (entries.length === 0) {
			this.drawHeader(scrollLeft, cssWidth);
			ctx.font = this.bodyFont;
			ctx.fillStyle = this.palette.descriptionFg;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			ctx.fillText('(empty -- no PutValue ops on this sheet)', CELL_PAD, HEADER_HEIGHT + ROW_HEIGHT / 2);
			return;
		}

		// Visible entry window (the body area is below the header band).
		const bodyHeight = Math.max(0, cssHeight - HEADER_HEIGHT);
		const range = computeVisibleRowRange(scrollTop, bodyHeight, entries.length, ROW_HEIGHT, OVERSCAN);

		// Data rows first; header painted on top so a row scrolled under it is covered.
		ctx.font = this.bodyFont;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		for (let i = range.startIdx; i < range.endIdx; i += 1) {
			this.drawRow(entries[i], HEADER_HEIGHT + i * ROW_HEIGHT - scrollTop, scrollLeft, errorCells);
		}
		this.drawHeader(scrollLeft, cssWidth);
	}

	/**
	 * **FE-0b-4 blit-scroll.** Reuse the previous frame's overlapping pixels: copy them shifted by
	 * the scroll delta (a self-`drawImage` in device px), then repaint only the newly-exposed
	 * strip(s) via the clipped {@link paintWindow}. `blit` is from `computeScrollBlit` (a device-px
	 * copy rect + CSS-px damage rects). The caller guarantees `painted` + an unchanged size/dpr.
	 */
	drawScroll(
		blit: ScrollBlit,
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
	): void {
		const ctx = this.ctx;
		// The copy rect is already device-scaled -> issue drawImage under the IDENTITY transform
		// (issuing it under the dpr transform would scale the device rect a second time).
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = false;
		const c = blit.copy;
		ctx.drawImage(this.canvas, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
		// Repaint the exposed strip(s) in CSS px under the restored dpr transform.
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		for (const r of blit.damageRects) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(r.x, r.y, r.width, r.height);
			ctx.clip();
			this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells);
			ctx.restore();
		}
	}

	/**
	 * **FE-0b-4 damage-clip.** Repaint ONLY the changed entry rows (by index), each via the clipped
	 * {@link paintWindow} so the pixels match a full redraw. The sticky header never changes on an
	 * edit, so it is not repainted (the body-row clip excludes it). Off-screen rows are skipped.
	 * `changedIdx` is the union of `diffSnapshots` + `errorRowsFlipped` from the caller.
	 */
	drawDamage(
		changedIdx: readonly number[],
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
	): void {
		const ctx = this.ctx;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		// FE-0b-5 (Codex M4): build ONE clip region spanning ALL visible changed rows, then paint the
		// window ONCE. A per-row paintWindow() would re-run the whole visible-window draw loop once per
		// damaged row (N loops for N rows) -- correct pixels, but the wrong cost for a perf path.
		ctx.save();
		ctx.beginPath();
		let anyVisible = false;
		for (const idx of changedIdx) {
			const rowTop = HEADER_HEIGHT + idx * ROW_HEIGHT - scrollTop;
			// Clamp to the body viewport [HEADER_HEIGHT, cssHeight); +1 captures the row's bottom
			// border. Skip rows fully off-screen or fully under the sticky header.
			const top = Math.max(rowTop, HEADER_HEIGHT);
			const bottom = Math.min(rowTop + ROW_HEIGHT + 1, cssHeight);
			if (bottom <= top) {
				continue;
			}
			ctx.rect(0, top, cssWidth, bottom - top); // accumulates into the union clip path
			anyVisible = true;
		}
		if (anyVisible) {
			ctx.clip();
			this.paintWindow(cssWidth, cssHeight, scrollTop, scrollLeft, errorCells);
		}
		ctx.restore();
	}

	private drawRow(
		entry: QuantbookCellSnapshot['entries'][number],
		localY: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
	): void {
		const ctx = this.ctx;
		const rowNum = Number(entry.row);
		const colNum = Number(entry.col);
		const isError = errorCells.has(rowNum + ',' + colNum);
		const rowLeft = -scrollLeft;
		const rowWidth = totalContentWidth();

		// Row background (error-tinted when decorated).
		ctx.fillStyle = isError ? this.palette.errorBg : this.palette.background;
		ctx.fillRect(rowLeft, localY, rowWidth, ROW_HEIGHT);

		for (let c = 0; c < COLUMNS.length; c += 1) {
			const col = COLUMNS[c];
			const x = columnX(c) - scrollLeft;
			ctx.save();
			ctx.beginPath();
			ctx.rect(x, localY, col.width, ROW_HEIGHT);
			ctx.clip();
			const textY = localY + ROW_HEIGHT / 2;
			if (col.key === 'value') {
				// Value display: engine-rendered string if present, else value-default. Followed by
				// the `[kind]` annotation in descriptionFg (drawn inline after the value when it fits).
				const display = typeof entry.rendered === 'string' ? entry.rendered : formatCellValue(entry.value);
				const kindStr = '[' + entry.value.kind + ']';
				const kindW = this.measure(kindStr);
				const avail = col.width - CELL_PAD * 2;
				const valueMax = Math.max(0, avail - kindW - KIND_GAP);
				const shownValue = truncateToWidth(display, valueMax, s => this.measure(s));
				ctx.fillStyle = isError ? this.palette.errorFg : this.palette.foreground;
				ctx.fillText(shownValue, x + CELL_PAD, textY);
				// Only draw the kind if the (possibly-truncated) value left room for it.
				const valueW = this.measure(shownValue);
				if (valueW + KIND_GAP + kindW <= avail) {
					ctx.fillStyle = this.palette.descriptionFg;
					ctx.fillText(kindStr, x + CELL_PAD + valueW + KIND_GAP, textY);
				}
			} else {
				const text = col.key === 'row' ? String(rowNum) : String(colNum);
				const shown = truncateToWidth(text, col.width - CELL_PAD * 2, s => this.measure(s));
				ctx.fillStyle = isError ? this.palette.errorFg : this.palette.foreground;
				ctx.fillText(shown, x + CELL_PAD, textY);
			}
			ctx.restore();
		}

		// Row bottom border + column separators (0.5px-aligned for crisp 1px lines).
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const lineY = Math.round(localY + ROW_HEIGHT) - 0.5;
		ctx.moveTo(rowLeft, lineY);
		ctx.lineTo(rowLeft + rowWidth, lineY);
		for (let c = 1; c < COLUMNS.length; c += 1) {
			const sx = Math.round(columnX(c) - scrollLeft) - 0.5;
			ctx.moveTo(sx, localY);
			ctx.lineTo(sx, localY + ROW_HEIGHT);
		}
		ctx.stroke();
	}

	private drawHeader(scrollLeft: number, cssWidth: number): void {
		const ctx = this.ctx;
		// Opaque base FIRST: overscan rows are drawn at negative localY (under the header band), so
		// without this an overscan row's text/borders would bleed through the (often translucent)
		// headerBg while scrolling.
		ctx.fillStyle = this.palette.background;
		ctx.fillRect(0, 0, cssWidth, HEADER_HEIGHT);
		ctx.fillStyle = this.palette.headerBg;
		ctx.fillRect(0, 0, cssWidth, HEADER_HEIGHT);
		ctx.font = this.headerFont;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.fillStyle = this.palette.foreground;
		const textY = HEADER_HEIGHT / 2;
		for (let c = 0; c < COLUMNS.length; c += 1) {
			const col = COLUMNS[c];
			const x = columnX(c) - scrollLeft;
			ctx.save();
			ctx.beginPath();
			ctx.rect(x, 0, col.width, HEADER_HEIGHT);
			ctx.clip();
			ctx.fillText(col.label, x + CELL_PAD, textY);
			ctx.restore();
		}
		// Header bottom border + column separators.
		ctx.strokeStyle = this.palette.border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const lineY = Math.round(HEADER_HEIGHT) - 0.5;
		ctx.moveTo(0, lineY);
		ctx.lineTo(cssWidth, lineY);
		for (let c = 1; c < COLUMNS.length; c += 1) {
			const sx = Math.round(columnX(c) - scrollLeft) - 0.5;
			ctx.moveTo(sx, 0);
			ctx.lineTo(sx, HEADER_HEIGHT);
		}
		ctx.stroke();
		// Restore body font for subsequent measure() calls within the frame.
		ctx.font = this.bodyFont;
	}

	/** Cached `measureText().width` at the current body font (cache cleared on font change). */
	private measure(text: string): number {
		let w = this.measureCache.get(text);
		if (w === undefined) {
			w = this.ctx.measureText(text).width;
			this.measureCache.set(text, w);
			if (this.measureCache.size > MEASURE_CACHE_MAX) {
				// FE megaudit L-i: evict the OLDEST half (Map preserves insertion order)
				// instead of clear-all, so a cache overflow doesn't cause a thundering
				// re-measure of every still-visible string on the very next frame.
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
			// FE megaudit M7: warn ONCE before falling back (No-Fallbacks).
			warnMissingThemeVar(name, fallback);
			return fallback;
		};
		return {
			foreground: v('--vscode-foreground', '#cccccc'),
			background: v('--vscode-editor-background', '#1e1e1e'),
			headerBg: v('--vscode-toolbar-hoverBackground', 'rgba(90,93,94,0.31)'),
			border: v('--vscode-panel-border', 'rgba(128,128,128,0.35)'),
			descriptionFg: v('--vscode-descriptionForeground', '#9d9d9d'),
			errorFg: v('--vscode-errorForeground', '#f48771'),
			errorBg: v('--vscode-inputValidation-errorBackground', 'rgba(190,40,40,0.25)'),
		};
	}

	private readFonts(): { body: string; header: string } {
		// FE megaudit M7: the font fallback is the most damaging silent fallback --
		// wrong metrics corrupt truncateToWidth. Warn ONCE before defaulting.
		const rawFamily = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim();
		let family = rawFamily;
		if (family.length === 0) {
			warnMissingThemeVar('--vscode-font-family', 'sans-serif');
			family = 'sans-serif';
		}
		return { body: '12px ' + family, header: '600 12px ' + family };
	}
}
