/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 (Wave 3, 2026-06-09) -- the vscode-free builder for the Cell Grid right-click context-menu payload.
//
// VS Code's NATIVE webview context menu reads the nearest `data-vscode-context` attribute (a JSON string)
// up the DOM from the right-clicked element. The webview sets this attribute on the canvas on every
// `contextmenu` event, AFTER hit-testing the clicked cell. The contributed `menus["webview/context"]`
// entries (in package.json) are `when`-gated on `webviewId == 'quantlab.quantbookCellGrid'` +
// `webviewSection`, and each invoked command receives the PARSED context object as its FIRST argument.
//
// **The payload is the AUTHORITATIVE, SYNCHRONOUS hand-off from the right-clicked grid to the command**
// (Codex W3 audit HIGH-1 + HIGH-2). It carries:
//   - `panelToken`: this webview's stable instance id, so the host routes the action to the EXACT panel
//     that raised the menu (NOT merely the "focused" panel -- which can differ in split editors / focus
//     edge cases, hitting the wrong grid). The host keeps a `token -> CellGridPanel` map.
//   - `selection`: the authoritative selection rect AT RIGHT-CLICK TIME, so the insert/delete command
//     plans from THIS payload rather than from the async-updated host selection (which a fast menu
//     command could read stale, mutating the wrong row/column band).
// This module builds that JSON string PURELY (no DOM, no vscode) so the payload's shape is unit-tested
// independently of the event wiring.

/**
 * The `webviewSection` the cell-grid body uses. A right-click that lands on a body cell tags the canvas
 * with this section so ONLY the quantbook grid's menu items appear (an unrelated webview, or a click that
 * is not over the grid body, gets the cleared payload below and shows no quantbook items).
 */
export const CELL_GRID_CONTEXT_SECTION = 'quantbook-grid-cell';

/** A hit cell for the context payload (0-based). */
export interface ContextCell {
	readonly row: number;
	readonly col: number;
}

/**
 * The authoritative selection rect carried in the payload (0-based, the two selection corners in ANY
 * order -- the host normalizes). A single-cell selection has anchor === focus.
 */
export interface ContextSelection {
	readonly anchorRow: number;
	readonly anchorCol: number;
	readonly focusRow: number;
	readonly focusCol: number;
}

/**
 * Build the JSON string for `data-vscode-context` when the right-click lands on a body cell.
 *
 * Shape (VS Code contract):
 * - `webviewSection`: gates which contributed menu items show (matched in `when`).
 * - `preventDefaultContextMenuItems: true`: suppresses VS Code's built-in webview items (Copy/Inspect)
 *   so only the quantbook grid items appear -- the grid owns the menu over its canvas.
 * - `quantbookGridCell: true`: a boolean key the menu `when` clauses match (so the items only ever appear
 *   over a hit cell).
 * - `panelToken`: this webview's instance id -- the host routes the command to the exact panel.
 * - `selection`: the authoritative selection rect at right-click time (anchor+focus, 0-based).
 * - `hasSelection`: whether the selection spans more than one cell (advisory, for labelling).
 * - `cell`: the hit `{row,col}` (0-based) for diagnostics.
 */
export function buildCellContextPayload(
	cell: ContextCell,
	selection: ContextSelection,
	panelToken: string,
	hasSelection: boolean,
): string {
	return JSON.stringify({
		webviewSection: CELL_GRID_CONTEXT_SECTION,
		preventDefaultContextMenuItems: true,
		quantbookGridCell: true,
		panelToken,
		selection: {
			anchorRow: selection.anchorRow,
			anchorCol: selection.anchorCol,
			focusRow: selection.focusRow,
			focusCol: selection.focusCol,
		},
		hasSelection,
		cell: { row: cell.row, col: cell.col },
	});
}

/**
 * Build the cleared payload for a right-click that is NOT over a body cell (the sticky header band, the
 * row gutter, the corner, or empty space). This still suppresses VS Code's default items but tags NO
 * quantbook section, so none of the grid's menu items appear -- a right-click off the grid body shows an
 * empty menu rather than grid actions that have no target cell (No-Fallbacks: the menu never offers an
 * action it cannot resolve to a cell).
 */
export function buildEmptyContextPayload(): string {
	return JSON.stringify({ preventDefaultContextMenuItems: true });
}
