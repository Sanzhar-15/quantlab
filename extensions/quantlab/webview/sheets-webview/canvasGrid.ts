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
import { COLUMNS, HEADER_HEIGHT, ROW_HEIGHT, columnX, totalContentWidth, truncateToWidth } from './gridLayout';

const CELL_PAD = 8;
const KIND_GAP = 6;
const OVERSCAN = 2;
const MEASURE_CACHE_MAX = 5000;

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

	constructor(private readonly canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d');
		if (ctx === null) {
			throw new Error('sheets-webview: 2D canvas context unavailable');
		}
		this.ctx = ctx;
		this.dpr = CanvasGridRenderer.resolveDpr();
		this.palette = this.readPalette();
		const fonts = this.readFonts();
		this.bodyFont = fonts.body;
		this.headerFont = fonts.header;
	}

	private static resolveDpr(): number {
		return Math.min(2, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
	}

	setSnapshot(snapshot: QuantbookCellSnapshot): void {
		this.snapshot = snapshot;
	}

	get entryCount(): number {
		return this.snapshot?.entries.length ?? 0;
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
		const ctx = this.ctx;
		// Reset the transform each frame (NOT cumulative scale) then scale for HiDPI.
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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
				this.measureCache.clear();
			}
		}
		return w;
	}

	private readPalette(): Palette {
		const cs = getComputedStyle(document.body);
		const v = (name: string, fallback: string): string => {
			const raw = cs.getPropertyValue(name).trim();
			return raw.length > 0 ? raw : fallback;
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
		const family = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
		return { body: '12px ' + family, header: '600 12px ' + family };
	}
}
