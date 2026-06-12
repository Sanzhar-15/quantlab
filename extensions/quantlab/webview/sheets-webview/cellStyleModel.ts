/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Engine-backed cell-style RENDER resolver (FE-5 W-R, 2026-06-12).**
 *
 * The engine is the SOLE cell-style source: styles are registered (`registerStyle`) + assigned
 * (`setStyle`) on the workbook session and ride the snapshot as a per-cell `styleId` + a workbook-level
 * `styles[]` table. This module resolves that engine shape into the single paint shape the canvas reads
 * ({@link ResolvedCellStyle}) -- fill / bold / italic / horizontal-align / per-edge BORDERS.
 *
 * **History:** Round 5 (2026-06-10) shipped a webview-owned session `CellStyleStore` here as a stopgap
 * (the engine had no style model yet), persisted to `vscode.setState`. FE-4 W4 gave the engine a style
 * model; FE-5 W-R re-points reads AND writes to it and RETIRES the session store -- so writes always
 * render (no read/write-source split). What remains is purely the engine→paint RESOLVER below.
 *
 * Pure (no `document`/`window`/`vscode`/canvas/`this`-on-DOM): golden-testable headlessly, and shared by
 * the controller (`index.ts`, resolves per cell) and the renderer (`canvasGrid.ts`, paints borders).
 */

import type { RgbJson, StyleDefJson, StyleIdJson, StyleJson } from '../../src/quantbook/types';

/** The horizontal alignment a cell can carry (overrides the per-value-kind default in the paint). */
export type HAlign = 'left' | 'center' | 'right';

// =============================================================================================
// FE-5 W-R (2026-06-12) -- ENGINE-BACKED cell style: the render-layer resolution of the engine's
// `StyleDefJson` table into the SHAPE the canvas paints. Pure (no DOM/canvas/vscode), golden-testable.
//
// WHY a separate resolved shape (not the engine `StyleJson` directly):
//   - the engine `StyleJson` carries bold/italic/fill/align + per-edge BORDERS; colors are `{r,g,b}` not
//     CSS strings -- the canvas wants pre-resolved CSS strings it can assign straight to fillStyle/strokeStyle.
//   - the engine has NO underline/strike/text-color attribute. `ResolvedCellStyle` still DECLARES those
//     fields (the canvas paint code reads them), but the engine resolver never SETS them, so they are
//     always absent on an engine-sourced style -- the matching toolbar buttons are preview-only.
//   `ResolvedCellStyle` decouples the canvas paint site from the engine `StyleJson` schema. The ONLY source
//   now is the engine table (via {@link resolveCellStyle}); the retired session store is gone.
// =============================================================================================

/** One border edge in the renderer's paint shape: a CSS color + the engine border-style name (`none` =
 *  no edge). A direct render-side mirror of the engine {@link BorderEdgeJson}, with the color pre-resolved
 *  to a CSS string so the canvas can assign it straight to `strokeStyle`. */
export interface ResolvedBorderEdge {
	/** One of `thin|medium|thick|dashed|dotted|double` (a `none` edge is dropped, never stored here). */
	readonly style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
	/** CSS color string (`rgb(r,g,b)`), resolved from the engine `{r,g,b}` channels. */
	readonly color: string;
}

/** The four cell edges, each an optional {@link ResolvedBorderEdge} (absent = no border on that edge). */
export interface ResolvedBorders {
	readonly top?: ResolvedBorderEdge;
	readonly bottom?: ResolvedBorderEdge;
	readonly left?: ResolvedBorderEdge;
	readonly right?: ResolvedBorderEdge;
}

/** The unified render-layer style the canvas paints at its single cell-paint site. Every field optional;
 *  an absent field means "renderer default". Sourced from the engine {@link StyleDefJson} (fill + bold/
 *  italic/align + per-edge borders). `underline`/`strike`/`textColor` are declared (the canvas reads them)
 *  but the engine resolver never sets them -- the engine has no such attribute (those buttons are
 *  preview-only); they stay for the canvas paint code's shape + a future engine attribute. */
export interface ResolvedCellStyle {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strike?: boolean;
	readonly halign?: HAlign;
	readonly textColor?: string;
	readonly fillColor?: string;
	readonly borders?: ResolvedBorders;
}

/** The engine border-style names the renderer knows how to paint (a `none` edge is not rendered). */
const RENDERABLE_BORDER_STYLES: ReadonlySet<string> = new Set([
	'thin', 'medium', 'thick', 'dashed', 'dotted', 'double',
]);

/** A `{r,g,b}` (each in 0..=255) -> a `rgb(r,g,b)` CSS string, or `null` if any channel is out of the u8
 *  domain (No-Fallbacks: a malformed channel is surfaced as a rejected edge by the caller, never clamped to
 *  a silent default color). */
function rgbToCss(rgb: RgbJson | undefined): string | null {
	if (rgb === null || rgb === undefined) {
		return null;
	}
	const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;
	if (!ok(rgb.r) || !ok(rgb.g) || !ok(rgb.b)) {
		return null;
	}
	return 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
}

/** Map one engine {@link BorderEdgeJson} to a {@link ResolvedBorderEdge}, or `undefined` if the edge is
 *  `none` / unrenderable (unknown style name) / has a malformed color. Unrenderable is treated as "no edge"
 *  -- distinct from a fallback: an unknown edge style is genuinely not paintable, and dropping ONE edge is
 *  not masking a broader error (the cell still renders with its other valid edges + attributes). */
function resolveBorderEdge(edge: { style?: unknown; color?: unknown } | undefined): ResolvedBorderEdge | undefined {
	if (edge === null || edge === undefined || typeof edge !== 'object') {
		return undefined;
	}
	const style = edge.style;
	if (typeof style !== 'string' || style === 'none' || !RENDERABLE_BORDER_STYLES.has(style)) {
		return undefined;
	}
	const color = rgbToCss(edge.color as RgbJson | undefined);
	if (color === null) {
		return undefined;
	}
	return { style: style as ResolvedBorderEdge['style'], color };
}

/** Map an engine {@link StyleJson} `align` (`general|left|center|right`) to the renderer's {@link HAlign},
 *  or `undefined` for `general`/absent/unknown (the renderer then uses its per-value-kind default). */
function resolveAlign(align: unknown): HAlign | undefined {
	return align === 'left' || align === 'center' || align === 'right' ? align : undefined;
}

/**
 * **FE-5 W-R** -- resolve a cell's engine {@link StyleIdJson} against the snapshot's `styles[]` table into a
 * {@link ResolvedCellStyle} the canvas paints. Returns `undefined` for an absent id (the cell carries no
 * style -- the common case).
 *
 * **No-Fallbacks:** a `styleId` that does NOT resolve against `styles[]` is a CONTRACT VIOLATION (the engine
 * must register every referenced style), so this returns a sentinel `'unresolved'` the caller surfaces LOUD
 * (warn-once + skip) -- it NEVER silently paints a default style. A resolved style whose every field is
 * default yields a non-undefined but empty object (the cell IS styled, just to defaults) -- the caller
 * treats that as "no visible style"; only a true contract miss is `'unresolved'`.
 */
export function resolveCellStyle(
	styleId: StyleIdJson | undefined,
	styles: readonly StyleDefJson[] | undefined,
): ResolvedCellStyle | 'unresolved' | undefined {
	if (styleId === null || styleId === undefined) {
		return undefined; // no style on this cell
	}
	if (!Array.isArray(styles)) {
		return 'unresolved'; // a styleId with no table to resolve against -- a threading contract miss
	}
	let found: StyleJson | undefined;
	for (const def of styles) {
		if (def !== null && typeof def === 'object' && def.id !== null && def.id !== undefined &&
			def.id.peer === styleId.peer && def.id.counter === styleId.counter) {
			found = def.style;
			break;
		}
	}
	if (found === undefined) {
		return 'unresolved';
	}
	const borders: { top?: ResolvedBorderEdge; bottom?: ResolvedBorderEdge; left?: ResolvedBorderEdge; right?: ResolvedBorderEdge } = {};
	const top = resolveBorderEdge(found.borderTop);
	const bottom = resolveBorderEdge(found.borderBottom);
	const left = resolveBorderEdge(found.borderLeft);
	const right = resolveBorderEdge(found.borderRight);
	if (top !== undefined) { borders.top = top; }
	if (bottom !== undefined) { borders.bottom = bottom; }
	if (left !== undefined) { borders.left = left; }
	if (right !== undefined) { borders.right = right; }
	const resolved: {
		bold?: boolean; italic?: boolean; halign?: HAlign; fillColor?: string; borders?: ResolvedBorders;
	} = {};
	if (found.bold === true) { resolved.bold = true; }
	if (found.italic === true) { resolved.italic = true; }
	const halign = resolveAlign(found.align);
	if (halign !== undefined) { resolved.halign = halign; }
	const fill = rgbToCss(found.fill);
	if (fill !== null) { resolved.fillColor = fill; }
	if (top !== undefined || bottom !== undefined || left !== undefined || right !== undefined) {
		resolved.borders = borders;
	}
	return resolved;
}

/**
 * **FE-5 W-R -- shared-edge border DEDUP.** Adjacent cells can each declare a border on their shared edge
 * (cell A's right edge == cell B's left edge); painting both double-strokes the seam and, for `dashed`,
 * can phase-mismatch. The render rule: **a cell OWNS its TOP and LEFT edges; its BOTTOM and RIGHT edges are
 * ceded to the neighbor below / to the right** (which paints them as ITS top / left). So for a given cell we
 * paint top+left always, and bottom+right ONLY at the grid's painted frontier is unnecessary -- the neighbor
 * owns them. This pure helper returns, for a cell, which of its four edges THIS cell should paint given its
 * own resolved borders and its right/below neighbors' resolved borders, applying the own-top-left rule:
 *   - top:    paint iff this cell has a top edge (always owned).
 *   - left:   paint iff this cell has a left edge (always owned).
 *   - bottom: paint iff this cell has a bottom edge AND the cell BELOW does not have a top edge (else the
 *             neighbor's top -- which this cell's bottom coincides with -- already paints that seam).
 *   - right:  paint iff this cell has a right edge AND the cell to the RIGHT does not have a left edge.
 * The neighbor-wins tie-break keeps a single deterministic owner for a contested seam (no double-draw, no
 * dashed phase clash), while still drawing a border the neighbor lacks (e.g. only this cell sets a bottom).
 */
export function bordersToPaint(
	self: ResolvedBorders | undefined,
	below: ResolvedBorders | undefined,
	right: ResolvedBorders | undefined,
): { top?: ResolvedBorderEdge; bottom?: ResolvedBorderEdge; left?: ResolvedBorderEdge; right?: ResolvedBorderEdge } {
	const out: { top?: ResolvedBorderEdge; bottom?: ResolvedBorderEdge; left?: ResolvedBorderEdge; right?: ResolvedBorderEdge } = {};
	if (self === undefined) {
		return out;
	}
	if (self.top !== undefined) { out.top = self.top; }
	if (self.left !== undefined) { out.left = self.left; }
	// Bottom: this cell's bottom seam == the cell-below's top seam. The neighbor below OWNS its top, so cede
	// the seam to it when it has a top edge; otherwise this cell paints its own bottom.
	if (self.bottom !== undefined && (below === undefined || below.top === undefined)) {
		out.bottom = self.bottom;
	}
	// Right: this cell's right seam == the cell-to-the-right's left seam. The neighbor right OWNS its left,
	// so cede when it has a left edge; otherwise this cell paints its own right.
	if (self.right !== undefined && (right === undefined || right.left === undefined)) {
		out.right = self.right;
	}
	return out;
}

/** The device-independent stroke WIDTH (CSS px) for each engine border style. `thin`=1, `medium`=2,
 *  `thick`=3; `dashed`/`dotted`=1 (their distinction is the dash pattern, not the width); `double` is drawn
 *  as two 1px lines (see the renderer) so its nominal width here is the OUTER span it occupies (3). */
export function borderWidthPx(style: ResolvedBorderEdge['style']): number {
	switch (style) {
		case 'thin': return 1;
		case 'dashed': return 1;
		case 'dotted': return 1;
		case 'medium': return 2;
		case 'thick': return 3;
		case 'double': return 3;
	}
}
