/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Client-side cell style model (round 5, 2026-06-10).**
 *
 * The engine has NO cell-style storage -- its only formatting is the number-format table
 * (`register_format`/`set_format`). So the toolbar's Bold/Italic/Underline/Strikethrough, the
 * horizontal-align trio, and the text/fill color controls had no engine path and shipped as silent
 * no-ops (the operator's "fake toolbar" complaint). This module is the render-layer answer: a pure,
 * webview-owned per-cell VISUAL style map that the canvas paints at its single cell-paint site
 * ({@link CanvasGridRenderer.paintCellRegion}) and the toolbar mutates over the active selection.
 *
 * **Boundary (honest, NOT a hidden fallback):** these styles are PRESENTATION held in the webview.
 * They persist across a webview reload via `vscode.setState` (session-scoped, like Excel's in-session
 * styling), but they are NOT written to the `.qnb` workbook file -- engine-backed persistent styling
 * is FE-4 work. This is a real rendering feature with a documented scope, surfaced (the demo script
 * notes it), never a swallowed error.
 *
 * **Keying:** `sheetId|row|col` (0-based row/col). Styles are NOT shifted by row/col insert-delete
 * (the engine moves the VALUES; this webview map does not know the structural op) -- a documented v1
 * limitation; styling then-restyling after a structural edit is not a demo beat.
 *
 * Pure (no `document`/`window`/`vscode`/canvas/`this`-on-DOM): golden-testable headlessly, and shared
 * by the controller (`index.ts`, writes) and the renderer (`canvasGrid.ts`, reads via a bound lookup).
 */

/** The horizontal alignment overrides a cell can carry (overrides the per-kind default in the paint). */
export type HAlign = 'left' | 'center' | 'right';

/** A single cell's visual style. Every field optional; an absent field means "renderer default".
 *  An object with no set field is "empty" and is dropped from the map ({@link isEmptyStyle}). */
export interface CellStyle {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strike?: boolean;
	readonly halign?: HAlign;
	/** CSS color string for the glyphs (overrides the foreground/error color). */
	readonly textColor?: string;
	/** CSS color string for the cell background fill (painted under gridlines + text). */
	readonly fillColor?: string;
}

/** The four boolean toggles the toolbar flips. */
export type StyleToggle = 'bold' | 'italic' | 'underline' | 'strike';

/** A structural rectangle of cells (inclusive, 0-based) -- mirrors {@link SelectionRect} shape without
 *  importing it (this leaf module stays dependency-free). */
export interface StyleRect {
	readonly minRow: number;
	readonly maxRow: number;
	readonly minCol: number;
	readonly maxCol: number;
}

/** The serialized shape persisted in `vscode.setState` (a plain JSON object keyed by `sheet|row|col`). */
export interface SerializedCellStyles {
	readonly version: 1;
	readonly cells: { readonly [key: string]: CellStyle };
}

/** Whether a style object carries no meaningful styling (so it can be dropped rather than stored). */
export function isEmptyStyle(s: CellStyle): boolean {
	return (
		!s.bold &&
		!s.italic &&
		!s.underline &&
		!s.strike &&
		s.halign === undefined &&
		s.textColor === undefined &&
		s.fillColor === undefined
	);
}

function cellKey(sheet: number, row: number, col: number): string {
	return sheet + '|' + row + '|' + col;
}

/**
 * Round-5 audit LOW: validate a persisted color before trusting it. A corrupt/foreign string assigned
 * to `ctx.fillStyle` is a SILENT no-op -- the canvas keeps the PREVIOUS iteration's color, so one bad
 * persisted value would paint a neighbor's fill onto the wrong cell. Accept only the shapes the style
 * layer itself produces (swatch hex) plus the rgb()/rgba() forms a theme var could have injected.
 */
export function isValidCssColor(value: unknown): value is string {
	if (typeof value !== 'string') {
		return false;
	}
	return (
		/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ||
		/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(value)
	);
}

/** Hard ceiling on cells touched by one style op, mirroring the engine's batch cap so a pathological
 *  whole-column/whole-sheet selection can't build an unbounded map (the selection rect can span the
 *  full Excel extent). A selection larger than this is clamped to its top-left corner (the common
 *  styling target) -- a `console.warn`-worthy edge, surfaced by the caller, never silently truncated. */
export const MAX_STYLE_CELLS = 100_000;

/**
 * The per-cell visual style map. Sparse: only styled cells are stored, and a cell whose style becomes
 * empty is deleted (so {@link size} reflects genuinely-styled cells and serialization stays small).
 */
export class CellStyleStore {
	private readonly map = new Map<string, CellStyle>();

	/** The style for one cell, or `undefined` (renderer default). */
	get(sheet: number, row: number, col: number): CellStyle | undefined {
		return this.map.get(cellKey(sheet, row, col));
	}

	get size(): number {
		return this.map.size;
	}

	/** Number of cells in `rect` (clamped to >= 0); used by the caller to guard against a giant op. */
	static rectCellCount(rect: StyleRect): number {
		const rows = Math.max(0, rect.maxRow - rect.minRow + 1);
		const cols = Math.max(0, rect.maxCol - rect.minCol + 1);
		return rows * cols;
	}

	/** Clamp a (possibly whole-axis) rect to at most {@link MAX_STYLE_CELLS} by shrinking toward the
	 *  top-left; returns the clamped rect AND whether clamping happened (so the caller can warn). */
	static clampRect(rect: StyleRect): { rect: StyleRect; clamped: boolean } {
		if (CellStyleStore.rectCellCount(rect) <= MAX_STYLE_CELLS) {
			return { rect, clamped: false };
		}
		// Keep all selected columns if narrow; otherwise cap rows so rows*cols <= MAX.
		const cols = Math.max(1, rect.maxCol - rect.minCol + 1);
		const maxRows = Math.max(1, Math.floor(MAX_STYLE_CELLS / cols));
		return {
			rect: { minRow: rect.minRow, minCol: rect.minCol, maxCol: rect.maxCol, maxRow: rect.minRow + maxRows - 1 },
			clamped: true,
		};
	}

	private forEachCell(rect: StyleRect, fn: (row: number, col: number) => void): void {
		for (let r = rect.minRow; r <= rect.maxRow; r += 1) {
			for (let c = rect.minCol; c <= rect.maxCol; c += 1) {
				fn(r, c);
			}
		}
	}

	private update(sheet: number, row: number, col: number, patch: (s: CellStyle) => CellStyle): void {
		const key = cellKey(sheet, row, col);
		const next = patch(this.map.get(key) ?? {});
		if (isEmptyStyle(next)) {
			this.map.delete(key);
		} else {
			this.map.set(key, next);
		}
	}

	/**
	 * Toggle a boolean style over `rect` with Excel/Sheets semantics: if EVERY cell in the rect already
	 * has the property on, the whole rect is turned OFF; otherwise the whole rect is turned ON. Returns
	 * the resulting boolean (true = now on) so the caller can reflect the button's pressed state.
	 */
	toggleBool(sheet: number, rect: StyleRect, prop: StyleToggle): boolean {
		let allOn = true;
		this.forEachCell(rect, (r, c) => {
			if (this.get(sheet, r, c)?.[prop] !== true) {
				allOn = false;
			}
		});
		const next = !allOn;
		this.forEachCell(rect, (r, c) => {
			this.update(sheet, r, c, s => ({ ...s, [prop]: next ? true : undefined }));
		});
		return next;
	}

	/** Set (or clear, with `null`) the horizontal alignment over `rect`. */
	setAlign(sheet: number, rect: StyleRect, halign: HAlign | null): void {
		this.forEachCell(rect, (r, c) => {
			this.update(sheet, r, c, s => ({ ...s, halign: halign ?? undefined }));
		});
	}

	/** Set (or clear, with `null`) a color over `rect`. `which` selects text vs fill. */
	setColor(sheet: number, rect: StyleRect, which: 'textColor' | 'fillColor', color: string | null): void {
		this.forEachCell(rect, (r, c) => {
			this.update(sheet, r, c, s => ({ ...s, [which]: color ?? undefined }));
		});
	}

	/** Remove ALL styling from every cell in `rect` (the "clear formatting" path). */
	clear(sheet: number, rect: StyleRect): void {
		this.forEachCell(rect, (r, c) => {
			this.map.delete(cellKey(sheet, r, c));
		});
	}

	/** Plain-object snapshot for `vscode.setState`. */
	serialize(): SerializedCellStyles {
		const cells: { [key: string]: CellStyle } = {};
		for (const [k, v] of this.map) {
			cells[k] = v;
		}
		return { version: 1, cells };
	}

	/**
	 * Rebuild a store from a {@link serialize} payload. Defensive: a malformed/foreign blob yields an
	 * empty store (No-Fallbacks spirit: a corrupt state must not crash the webview boot, and styling is
	 * non-load-bearing presentation -- losing it is the safe degradation, and the only way it degrades).
	 */
	static deserialize(raw: unknown): CellStyleStore {
		const store = new CellStyleStore();
		if (typeof raw !== 'object' || raw === null) {
			return store;
		}
		const obj = raw as { version?: unknown; cells?: unknown };
		if (obj.version !== 1 || typeof obj.cells !== 'object' || obj.cells === null) {
			return store;
		}
		for (const [key, value] of Object.entries(obj.cells as { [k: string]: unknown })) {
			if (typeof value !== 'object' || value === null) {
				continue;
			}
			// Round-5 audit LOW: validate the KEY too -- `get()` reconstructs `sheet|row|col` so a foreign
			// key is never read, but without this it would be re-persisted forever (dead state).
			if (!/^\d+\|\d+\|\d+$/.test(key)) {
				continue;
			}
			const v = value as CellStyle;
			const clean: CellStyle = {
				bold: v.bold === true ? true : undefined,
				italic: v.italic === true ? true : undefined,
				underline: v.underline === true ? true : undefined,
				strike: v.strike === true ? true : undefined,
				halign: v.halign === 'left' || v.halign === 'center' || v.halign === 'right' ? v.halign : undefined,
				textColor: isValidCssColor(v.textColor) ? v.textColor : undefined,
				fillColor: isValidCssColor(v.fillColor) ? v.fillColor : undefined,
			};
			if (!isEmptyStyle(clean)) {
				store.map.set(key, clean);
			}
		}
		return store;
	}
}
