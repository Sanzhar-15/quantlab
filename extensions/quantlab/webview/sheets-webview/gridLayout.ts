/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b-2 (2026-06-02) -- pure layout math for the Canvas2D sheets renderer.**
 *
 * The grid is a LIST of populated cells (one display-row per snapshot entry) across 3 fixed
 * columns -- Row (entry.row), Col (entry.col), Value (the rendered value) -- faithful to the
 * FE-0b-1 DOM table. This module owns the geometry: column widths/offsets, the header band,
 * row stride, the cell rectangle, hit-testing, and width-bounded text truncation.
 *
 * **CONTENT coordinates** (not viewport): the origin is the top-left of the full scrollable
 * content (the header band occupies `[0, HEADER_HEIGHT)`, entry `i` occupies
 * `[HEADER_HEIGHT + i*ROW_HEIGHT, +ROW_HEIGHT)`). The canvas renderer converts content->local
 * by subtracting the scroll offset; the overlay editor `<input>` lives in the scroller's content
 * layer and uses these content rects directly (so it tracks scroll naturally).
 *
 * Pure: no `vscode`, no `document`/`window`, no canvas, no `this`. Browser-bundle-safe AND
 * mocha-importable -- the correctness-critical geometry is golden-tested headlessly; the actual
 * canvas drawing (which needs a real 2D context) is covered by the behavioral smoke.
 */

/** A fixed grid column. `key` selects the entry field; `width` is in CSS px. */
export interface GridColumn {
	readonly key: 'row' | 'col' | 'value';
	readonly label: string;
	readonly width: number;
}

/** The 3 fixed columns of the FE-0b cell list. */
export const COLUMNS: readonly GridColumn[] = [
	{ key: 'row', label: 'Row', width: 72 },
	{ key: 'col', label: 'Col', width: 72 },
	{ key: 'value', label: 'Value', width: 520 },
];

/** Pixel height of one data row (matches the FE-0b-1 DOM `<td>` row). */
export const ROW_HEIGHT = 25;

/** Pixel height of the sticky header band (Row / Col / Value labels). */
export const HEADER_HEIGHT = 28;

/** Left edge (content X) of column `colIndex` = sum of preceding column widths. */
export function columnX(colIndex: number): number {
	let x = 0;
	for (let i = 0; i < colIndex && i < COLUMNS.length; i += 1) {
		x += COLUMNS[i].width;
	}
	return x;
}

/** Total content width = sum of all column widths (drives the horizontal scrollbar). */
export function totalContentWidth(): number {
	return columnX(COLUMNS.length);
}

/** Total content height = header band + all entry rows (drives the vertical scrollbar). */
export function totalContentHeight(entryCount: number): number {
	return HEADER_HEIGHT + Math.max(0, entryCount) * ROW_HEIGHT;
}

/**
 * Content-coordinate rectangle of a cell. Used to position the overlay editor `<input>` (a child
 * of the scroller's content layer, so it scrolls with the grid). The canvas renderer derives its
 * local draw rect by subtracting the scroll offset from this.
 */
export function cellContentRect(
	entryIndex: number,
	colIndex: number,
): { x: number; y: number; width: number; height: number } {
	return {
		x: columnX(colIndex),
		y: HEADER_HEIGHT + entryIndex * ROW_HEIGHT,
		width: COLUMNS[colIndex]?.width ?? 0,
		height: ROW_HEIGHT,
	};
}

/**
 * Map a CONTENT-coordinate point to the cell under it, or `null` if it lands in the header band,
 * before/after the columns, or past the populated entries. The caller converts a click's
 * viewport coords to content coords first (`contentX = clientX - canvasLeft + scrollLeft`, etc.).
 */
export function hitTestContent(
	contentX: number,
	contentY: number,
	entryCount: number,
): { entryIndex: number; colIndex: number } | null {
	if (contentY < HEADER_HEIGHT) {
		return null; // header band -- not an editable data cell
	}
	const entryIndex = Math.floor((contentY - HEADER_HEIGHT) / ROW_HEIGHT);
	if (entryIndex < 0 || entryIndex >= entryCount) {
		return null;
	}
	if (contentX < 0) {
		return null;
	}
	let x = 0;
	for (let i = 0; i < COLUMNS.length; i += 1) {
		if (contentX < x + COLUMNS[i].width) {
			return { entryIndex, colIndex: i };
		}
		x += COLUMNS[i].width;
	}
	return null; // past the last column
}

/**
 * Map a VIEWPORT-LOCAL point (relative to the canvas, which overlays the viewport) to the cell
 * under it. The header is STICKY at the viewport top `[0, HEADER_HEIGHT)` regardless of scroll, so
 * a click there is never an editable data cell -- it is rejected in LOCAL coords BEFORE adding the
 * scroll offset. (Doing the header check in content coords is WRONG: at `scrollTop>0` a click on the
 * visible sticky header would map to `localY + scrollTop >= HEADER_HEIGHT` and hit a body row.)
 * Below the header, the point is converted to content coords and delegated to {@link hitTestContent}.
 */
export function hitTestViewport(
	localX: number,
	localY: number,
	scrollLeft: number,
	scrollTop: number,
	entryCount: number,
): { entryIndex: number; colIndex: number } | null {
	if (localY < HEADER_HEIGHT) {
		return null; // sticky header band -- not an editable cell at any scroll position
	}
	return hitTestContent(localX + scrollLeft, localY + scrollTop, entryCount);
}

/**
 * Truncate `text` to fit `maxWidth` px (per the injected `measure`), appending an ellipsis when it
 * must be cut. Pure: `measure` is the only environment dependency, so this is golden-testable with
 * a fake monospace measurer. Returns `''` if not even the ellipsis fits. Binary-searches the
 * longest prefix whose `prefix + '…'` still fits.
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
	return text.slice(0, lo) + ellipsis;
}
