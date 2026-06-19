/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// **Wave G3a / R4 (2026-06-19)** -- the vscode-free core of the Cell Grid right-click "Hide rows" /
// "Unhide rows" / "Unhide all rows" commands. The native VS Code webview context menu routes each item to
// a host command in quantbookCommands.ts; that command resolves the FOCUSED grid (by panel token) + the
// AUTHORITATIVE right-click-time selection ({@link GridSelectionInput}) and calls this module to compute the
// concrete row set, then drives the engine `setRowsHidden`/`getHiddenRows` substrate (Wave G2).
//
// Keeping the span/intersection math pure + unit-tested pins WHICH rows a Hide/Unhide touches independently
// of the vscode shell (the command itself is a thin wrapper, like the insert/delete-row commands in
// contextMenuLogic.ts). No-Fallbacks: the command surfaces a clear info toast when there is nothing to
// unhide (an empty result), and the engine throws loud on an out-of-range row.
//
// **No degenerate MAX_ROWS span:** there is NO select-all in the grid (Ctrl+A is `passthrough` in
// gridKeyDispatch -- it never sets a selection), so a selection's row span is always a real, bounded user
// gesture (drag / shift-extend / Ctrl+Shift+arrow to the used end). The Hide command therefore materializes
// `[minRow .. maxRow]` without an arbitrary cap -- the span can never reach the full 1,048,576-row sheet.

import type { GridSelectionInput } from './contextMenuLogic';

/** The A1 grid row extent (mirrors `MAX_ROWS` in gridLayoutA1; declared locally to keep this module
 *  vscode/webview-free, matching sortLogic/tableUiLogic/etc.). Valid rows are `[0, A1_MAX_ROWS)`. */
const A1_MAX_ROWS = 1_048_576;

/** The inclusive row band a Hide/Unhide acts on, from a selection's two corners (in any order). */
export interface RowSpan {
	readonly minRow: number;
	readonly maxRow: number;
}

/**
 * The inclusive `[minRow, maxRow]` row band of a selection (anchor + focus, any order). Columns are ignored:
 * Hide/Unhide act on whole rows, so a partial-row selection still hides the rows it intersects (Excel canon).
 * Both corners are CLAMPED to the A1 grid extent `[0, A1_MAX_ROWS)` (defence in depth, Codex LOW): the webview
 * already clamps live selections, but a malformed `data-vscode-context` arg (only `parseContextMenuArg`'s
 * non-negative-integer check stands between it and here) must never drive {@link rowsInSpan} to materialize a
 * multi-million-row array. A legitimate selection is already in-extent, so the clamp is a no-op for it. Pure.
 */
export function rowSpanFromSelection(sel: GridSelectionInput): RowSpan {
	const lo = Math.min(sel.anchorRow, sel.focusRow);
	const hi = Math.max(sel.anchorRow, sel.focusRow);
	return {
		minRow: Math.max(0, Math.min(lo, A1_MAX_ROWS - 1)),
		maxRow: Math.max(0, Math.min(hi, A1_MAX_ROWS - 1)),
	};
}

/**
 * The explicit row indices in the inclusive span (the array the engine `setRowsHidden(sheet, rows, hidden)`
 * takes). Bounded by the selection (no select-all exists), so this never materializes the whole sheet. Pure.
 */
export function rowsInSpan(span: RowSpan): number[] {
	const rows: number[] = [];
	for (let r = span.minRow; r <= span.maxRow; r += 1) {
		rows.push(r);
	}
	return rows;
}

/**
 * The currently-hidden rows that fall WITHIN the span -- the "Unhide rows" target (the intersection of the
 * engine's `getHiddenRows(sheet)` with the selected band). Empty when the selection covers no hidden row, so
 * the command can surface an explicit "nothing to unhide" toast (No-Fallbacks) rather than a silent no-op.
 * Pure; preserves the input order (the engine returns ascending).
 */
export function hiddenRowsInSpan(hidden: readonly number[], span: RowSpan): number[] {
	return hidden.filter(r => r >= span.minRow && r <= span.maxRow);
}
