/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b (2026-06-02) -- pure value/window helpers for the bundled sheets webview.**
 *
 * `formatCellValue` (value-default display string) and `computeVisibleRowRange` (the scroll
 * window) are the value/row-window helpers consumed by the Canvas2D renderer (`canvasGrid.ts`) and
 * the A1 layout math (`gridLayoutA1.ts`). FE-0b-1's DOM-table-only helpers (`renderRowsHtml`, `escapeHtml`) were
 * removed in FE-0b-2 when the canvas replaced the DOM table -- canvas text is drawn directly, so
 * there is no HTML-escaping / attribute-contract surface.
 *
 * Pure functions only: no `vscode`, no `document`/`window`, no `this`, no side effects.
 * Browser-bundle-safe (esbuild) AND mocha-importable. The snapshot type is `import type` only, so
 * esbuild erases the import and does NOT drag host runtime (`session.ts` napi) into the bundle.
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../../src/quantbook/types';

// **Wave G-rows (R1, 2026-06-18):** the visible-row window reads the injected ROW sizing model so a
// resized row above the viewport shifts the window correctly. `gridLayoutA1` is DOM/vscode/napi-free
// (bundle-safe) and does NOT import this module, so this is a one-way dependency (no cycle). The empty
// (no-override) path stays byte-identical, so this import is inert until a row is actually resized.
import { getRowSizing, indexAtOffset } from './gridLayoutA1';

/** One entry of a {@link QuantbookCellSnapshot} (row/col/value + optional rendered/formula/diagnostic). */
export type CellSnapshotEntry = QuantbookCellSnapshot['entries'][number];

/**
 * **FE-2-0 Phase 1 (C1-HIGH2, 2026-06-03)** -- maximum length of any string fed into the canvas
 * text-measure / truncation path or a hover tooltip. A pathologically long `rendered`/`text`/
 * `diagnostic` string (a malformed or tampered snapshot) would freeze `measureText` /
 * `truncateToWidth` (a binary search that measures the FULL string first) and the native `title`
 * tooltip. We cap the DISPLAY string only -- never the stored cell value, and never the editor
 * pre-fill (capping an editable value would silently corrupt it on re-commit; legitimate values are
 * already bounded by the host's `MAX_RAW_INPUT_LENGTH`, and the webview mirrors that cap at commit).
 * 4096 chars is far beyond what a 64px cell or a tooltip can ever show.
 */
export const MAX_DISPLAY_CHARS = 4096;

/**
 * Clamp a string to {@link MAX_DISPLAY_CHARS} for safe canvas measurement / tooltip display. Returns
 * the input unchanged when already within the cap (the overwhelmingly common path). The truncation is
 * code-unit-based (a possible mid-surrogate cut here is harmless: the downstream `truncateToWidth`
 * re-truncates to the cell width and is itself surrogate-safe; the tooltip is plain text). This is a
 * display-only safety bound, NOT a semantic value transform.
 */
export function clampDisplayString(text: string): string {
	return text.length > MAX_DISPLAY_CHARS ? text.slice(0, MAX_DISPLAY_CHARS) : text;
}

/**
 * Render a cell value for its default display string. The `switch` is exhaustive over the
 * {@link QuantbookCellValue} tagged union -- TS infers `never` in any unreachable branch as a
 * compile-time correctness pin. The canvas renderer prefers the engine-`rendered` string when
 * present and falls back to this; the overlay editor uses this as the editable raw literal.
 */
export function formatCellValue(value: QuantbookCellValue): string {
	switch (value.kind) {
		case 'number':
			return String(value.value);
		case 'boolean':
			return value.value ? 'TRUE' : 'FALSE';
		case 'text':
			return value.value;
		case 'error':
			return value.value;
		case 'pending':
			return '(pending)';
	}
}

/**
 * **FE-2-0 Phase 1 re-audit (finding 1, 2026-06-03)** -- runtime validator for an inbound snapshot
 * cell value, the guard that makes {@link formatCellValue} total. The renderer's `setSnapshot` uses
 * this to skip+warn any malformed entry, so a drifted/tampered host can never feed `formatCellValue`
 * an `undefined`-yielding value (which would then crash `clampDisplayString`/`prefill.length`).
 *
 * Checking only `kind` is INSUFFICIENT: `{ kind: 'text' }` (no `value` field) has a recognized kind
 * but a missing payload, so `formatCellValue` returns `undefined`. We validate the FULL tagged-union
 * payload per kind -- mirroring the `formatCellValue` switch exactly (the `default` rejects an unknown
 * kind). Pure (no DOM); golden-tested.
 */
export function isRenderableValue(value: unknown): value is QuantbookCellValue {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const v = value as { kind?: unknown; value?: unknown };
	switch (v.kind) {
		case 'number':
			return typeof v.value === 'number';
		case 'boolean':
			return typeof v.value === 'boolean';
		case 'text':
		case 'error':
			return typeof v.value === 'string';
		case 'pending':
			return true; // no `value` payload -- `formatCellValue` returns a fixed '(pending)'
		default:
			return false;
	}
}

/**
 * Half-open visible-row range `[startIdx, endIdx)` for a scrolled viewport.
 * Both indices clamp to `[0, totalRows]`; `startIdx == endIdx == 0` when
 * `totalRows === 0`, and `startIdx <= endIdx` always.
 *
 * **Named `computeVisibleRowRange` (NOT `computeVisibleRange`) deliberately**:
 * the host has a same-purpose `computeVisibleRange` in `cellGridLogic.ts` with a
 * DIFFERENT parameter order (`scrollTop, rowHeight, viewportHeight, totalRows`).
 * Keeping a distinct name here prevents a copy/paste arg-order transposition
 * between the two. This copy is independent so the browser bundle never imports
 * host runtime.
 *
 * @param scrollTop pixels scrolled from the top (`viewport.scrollTop`).
 * @param viewportHeight pixel height of the scroll viewport (`viewport.clientHeight`).
 * @param totalRows total snapshot entries.
 * @param rowHeight pixel height of one row.
 * @param overscan extra rows above + below the visible window for smooth scroll.
 */
export function computeVisibleRowRange(
	scrollTop: number,
	viewportHeight: number,
	totalRows: number,
	rowHeight: number,
	overscan: number,
): { startIdx: number; endIdx: number } {
	if (totalRows === 0) {
		return { startIdx: 0, endIdx: 0 };
	}
	if (rowHeight <= 0) {
		return { startIdx: 0, endIdx: totalRows };
	}
	// Clamp `firstVisible` to the last row. The FE-0b viewport is PERSISTENT
	// (retainContextWhenHidden), so it keeps its scrollTop across renders. If the
	// data SHRINKS (rows deleted / sheet switched / undo) a stale large scrollTop
	// must NOT yield an empty window (`slice(91, 10)`) + a giant top spacer --
	// that paints a blank grid. Clamping shows the last rows instead.
	const maxFirst = Math.max(0, totalRows - 1);
	const rowSizing = getRowSizing();
	if (rowSizing.overrides.size === 0) {
		// Uniform fast path -- BYTE-IDENTICAL to the pre-Wave-G-rows code (the keystone invariant).
		const firstVisible = Math.min(maxFirst, Math.max(0, Math.floor(scrollTop / rowHeight)));
		const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
		const startIdx = Math.max(0, firstVisible - overscan);
		const endIdx = Math.min(totalRows, firstVisible + visibleCount + overscan);
		return { startIdx, endIdx };
	}
	// Wave G-rows variable-height window: the first/last visible rows are the inverse cumulative-height
	// lookups at the viewport's top/bottom edge (exact -- never an under-count that would blank a row). The
	// stale-scrollTop clamp (`maxFirst`) still applies. Mirrors computeVisibleColRange's variable path.
	const firstVisible = Math.min(maxFirst, Math.max(0, indexAtOffset(rowSizing, scrollTop)));
	const lastVisible = Math.min(maxFirst, Math.max(0, indexAtOffset(rowSizing, scrollTop + viewportHeight)));
	const startIdx = Math.max(0, firstVisible - overscan);
	const endIdx = Math.min(totalRows, lastVisible + 1 + overscan);
	return { startIdx, endIdx };
}
