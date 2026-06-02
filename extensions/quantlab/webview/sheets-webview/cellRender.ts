/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b-1 (2026-06-02) -- pure cell-render helpers for the bundled sheets webview.**
 *
 * These functions previously lived as MIRROR copies inside the inline `<script>`
 * string built by `cellGridHtml.ts:buildClientScript`
 * (`formatCellValueClient` / `renderRowsClient` / `computeRange`). FE-0b moves
 * the webview from host-built inline HTML to a bundled (esbuild) module, so the
 * mirrors become real, type-checked, unit-testable TS here.
 *
 * **Drift hazard ELIMINATED**: pre-FE-0b there were TWO renderers -- the
 * host-side `renderRows`/`formatCellValue` in `cellGridHtml.ts` (server-side
 * initial paint) and the inline-script mirrors (scroll repaints) -- and they had
 * to be kept byte-identical by hand (see the long drift-hazard note in
 * `cellGridHtml.ts:buildClientScript`). In the FE-0b model the host posts the
 * RAW snapshot via `postMessage` and ALL rendering happens here, in one place.
 * `cellGridHtml.ts` is no longer called by the panel (retired in FE-0b-2).
 *
 * Pure functions only: no `vscode`, no `document`/`window`, no `this`, no side
 * effects. Browser-bundle-safe (esbuild) AND mocha-importable (tsc -> out/).
 * The snapshot type is `import type` only, so esbuild erases the import and does
 * NOT drag any host runtime (`session.ts` napi binding) into the webview bundle.
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../../src/quantbook/types';

/** One entry of a {@link QuantbookCellSnapshot} (row/col/value + optional rendered/formula/diagnostic). */
export type CellSnapshotEntry = QuantbookCellSnapshot['entries'][number];

/**
 * Render a cell value for display. Mirrors the (now-retired) host-side
 * `formatCellValue` in `cellGridHtml.ts`. The `switch` is exhaustive over the
 * {@link QuantbookCellValue} tagged union -- TS infers `never` in any
 * unreachable branch as a compile-time correctness pin.
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
 * HTML-escape a string for safe interpolation into element text / attribute
 * values. The webview NEVER trusts engine-rendered strings or cell text as
 * pre-escaped HTML (CSP is defence-in-depth, this is the primary guard).
 * Identical to the host-side `escapeHtml` in `cellGridHtml.ts`.
 */
export function escapeHtml(s: string): string {
	return String(s).replace(/[&<>"']/g, c => {
		switch (c) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case '\'': return '&#39;';
			default: return c;
		}
	});
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
	const firstVisible = Math.min(maxFirst, Math.max(0, Math.floor(scrollTop / rowHeight)));
	const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
	const startIdx = Math.max(0, firstVisible - overscan);
	const endIdx = Math.min(totalRows, firstVisible + visibleCount + overscan);
	return { startIdx, endIdx };
}

/**
 * Render a window of snapshot entries to the `<tbody>` `<tr>` HTML string.
 *
 * Faithful port of the (retired) inline-script `renderRowsClient`. The emitted
 * per-cell `data-*` attributes are the click-to-edit contract the webview's
 * `beginEdit`/`endEdit` depend on:
 * - `data-row` / `data-col`: cell identity (Number()-coerced; non-numeric -> "NaN",
 *   a safe attribute value -- defence-in-depth mirroring the host renderer).
 * - `data-raw-formula` (when the entry has formula text), `data-raw-value`
 *   (the parseable literal), `data-original-text` (the displayed text): the
 *   `beginEdit` precedence chain (formula > raw value > displayed text).
 * - `data-original-kind`: the value kind, for the Escape-cancel restore.
 * - `title` (when the entry has a diagnostic): hover explanation for a failed UDF.
 *
 * Every interpolated value is `escapeHtml`d.
 */
export function renderRowsHtml(entries: ReadonlyArray<CellSnapshotEntry>): string {
	let html = '';
	for (const e of entries) {
		// Use the engine-pre-rendered string for DISPLAY when present; fall back
		// to the value-default. The RAW value for editing is always the
		// value-default representation (so parseCellRawInput / classifyCellInput
		// sees a parseable literal, not a formatted "$1,234.56").
		const displayStr = typeof e.rendered === 'string' ? e.rendered : formatCellValue(e.value);
		const rawValueStr = formatCellValue(e.value);
		const kind = e.value.kind;
		const formulaAttr = typeof e.formula === 'string'
			? ` data-raw-formula="${escapeHtml(e.formula)}"`
			: '';
		const titleAttr = (typeof e.diagnostic === 'string' && e.diagnostic.length > 0)
			? ` title="${escapeHtml(e.diagnostic)}"`
			: '';
		const rowSafe = Number(e.row);
		const colSafe = Number(e.col);
		html += '<tr><td>' + rowSafe + '</td><td>' + colSafe +
			'</td><td class="cell-value" data-row="' + rowSafe +
			'" data-col="' + colSafe +
			'" data-original-text="' + escapeHtml(displayStr) +
			'" data-raw-value="' + escapeHtml(rawValueStr) + '"' +
			formulaAttr +
			titleAttr +
			' data-original-kind="' + escapeHtml(kind) + '">' +
			escapeHtml(displayStr) +
			'<span class="kind">[' + escapeHtml(kind) + ']</span></td></tr>';
	}
	return html;
}
