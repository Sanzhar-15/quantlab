/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 (Wave 3, 2026-06-09) -- the vscode-free core of the Cell Grid right-click context menu's
// insert/delete-row-column commands.
//
// The native VS Code webview context menu (a `data-vscode-context` JSON attribute the webview sets on
// right-click + `package.json` `menus["webview/context"]` entries gated on the quantbook grid) routes
// each insert/delete item to a host command in quantbookCommands.ts. Those commands resolve the FOCUSED
// grid's selection (via `CellGridPanel.focusedGridSelection()` -- a {@link GridSelectionInput}) and call
// this module to compute the structural engine call:
//   { method, sheet, index, count }
// which the command applies through the typed `SessionInstance.insert/delete{Rows,Columns}` handshake
// methods (runtime-pending the W1 engine window) + `recalcDirty` + `refreshSession` -- mirroring the
// `setValue -> recalcDirtyChecked -> refreshSession` discipline of every other grid-mutating command.
//
// Keeping this pure + unit-tested pins the index/count math (which row band a "delete row" removes; where
// "insert above" vs "insert below" lands) independently of the vscode shell; the command itself is a thin
// wrapper. No-Fallbacks: this never invents a selection -- the command surfaces a clear toast when no grid
// cell is selected BEFORE calling here, and the engine throws loud on an out-of-range index.

/**
 * The eight structural operations the context menu exposes. Insert is split into the four Excel
 * directions; delete removes the whole selected band per axis.
 */
export type StructuralOp =
	| 'insertRowAbove'
	| 'insertRowBelow'
	| 'insertColumnLeft'
	| 'insertColumnRight'
	| 'deleteRow'
	| 'deleteColumn';

/**
 * The focused grid's selection as the host sees it (the {@link GridSelection} shape from cellGridLogic,
 * re-declared structurally so this pure module imports nothing from the vscode-coupled layer). `anchor`
 * and `focus` are the two selection corners in ANY order (a single-cell selection has them equal). All
 * four coordinates are 0-based and the dispatcher guarantees they are integers within the A1 extent.
 */
export interface GridSelectionInput {
	readonly anchorRow: number;
	readonly anchorCol: number;
	readonly focusRow: number;
	readonly focusCol: number;
}

/** The native (typed) engine method a {@link StructuralOp} resolves to. */
export type StructuralMethod = 'insertRows' | 'deleteRows' | 'insertColumns' | 'deleteColumns';

/**
 * The resolved engine call for a structural op: which `SessionInstance` method to invoke, the 0-based
 * `index` to operate at, and the `count` of rows/columns. `axis` is carried for the command's user-facing
 * label / toast ("Insert 2 rows" vs "Insert 2 columns").
 */
export interface StructuralPlan {
	readonly method: StructuralMethod;
	readonly axis: 'row' | 'column';
	/** 0-based row index (row ops) or column index (column ops) the engine acts at. */
	readonly index: number;
	/** Number of rows/columns to insert or delete (>= 1). */
	readonly count: number;
}

/**
 * Normalize a selection's two corners (anchor + focus, any order) into an inclusive top-left ->
 * bottom-right rect. Local to this module so it imports nothing from the reactive-notebook layer; mirrors
 * the identical helper in bindVariableLogic.ts.
 */
function normalize(sel: GridSelectionInput): { top: number; left: number; bottom: number; right: number } {
	return {
		top: Math.min(sel.anchorRow, sel.focusRow),
		left: Math.min(sel.anchorCol, sel.focusCol),
		bottom: Math.max(sel.anchorRow, sel.focusRow),
		right: Math.max(sel.anchorCol, sel.focusCol),
	};
}

/**
 * Resolve a {@link StructuralOp} + the current selection into the concrete engine call.
 *
 * Semantics (Excel canon, with the selection's span as the count):
 * - **insertRowAbove**: insert `selectedRows` blank rows AT the selection's top row (existing rows shift
 *   down). Selecting rows 3-5 and "Insert Above" pushes the current content down by 3, leaving 3 blank rows
 *   starting at row 3.
 * - **insertRowBelow**: insert `selectedRows` blank rows AT `bottom + 1` (the row just past the selection).
 * - **insertColumnLeft / insertColumnRight**: the column analogues at `left` / `right + 1`.
 * - **deleteRow**: delete the whole selected row band (`top .. bottom`, `count = selectedRows`).
 * - **deleteColumn**: delete the whole selected column band (`left .. right`).
 *
 * Always returns `count >= 1` (a single-cell selection inserts/deletes one row/column). Pure; no I/O.
 */
export function planStructuralOp(op: StructuralOp, sel: GridSelectionInput): StructuralPlan {
	const rect = normalize(sel);
	const rowCount = rect.bottom - rect.top + 1;
	const colCount = rect.right - rect.left + 1;
	switch (op) {
		case 'insertRowAbove':
			return { method: 'insertRows', axis: 'row', index: rect.top, count: rowCount };
		case 'insertRowBelow':
			return { method: 'insertRows', axis: 'row', index: rect.bottom + 1, count: rowCount };
		case 'deleteRow':
			return { method: 'deleteRows', axis: 'row', index: rect.top, count: rowCount };
		case 'insertColumnLeft':
			return { method: 'insertColumns', axis: 'column', index: rect.left, count: colCount };
		case 'insertColumnRight':
			return { method: 'insertColumns', axis: 'column', index: rect.right + 1, count: colCount };
		case 'deleteColumn':
			return { method: 'deleteColumns', axis: 'column', index: rect.left, count: colCount };
		default: {
			// Exhaustiveness guard: a new StructuralOp must be handled here. Throw loud (No-Fallbacks)
			// rather than silently returning a default plan that would mutate the wrong band.
			const unreachable: never = op;
			throw new Error(`planStructuralOp: unhandled structural op ${String(unreachable)}`);
		}
	}
}

/**
 * A human-readable, past-tense action label for the output log / toast, e.g. "Inserted 3 rows",
 * "Deleted 1 column". Pure; consumed by the command after a successful apply.
 */
export function describeStructuralPlan(plan: StructuralPlan): string {
	const verb = plan.method.startsWith('insert') ? 'Inserted' : 'Deleted';
	const noun = plan.count === 1 ? plan.axis : `${plan.axis}s`;
	return `${verb} ${plan.count} ${noun}`;
}

/**
 * **fe/sheet-tabs (2026-06-10; Codex HIGH)** -- the freeze counts for "Freeze Panes Here" over a
 * context-menu selection: pin the rows ABOVE + columns LEFT of the selection's FOCUS cell (Excel
 * "Freeze Panes" canon), i.e. `rows = focusRow`, `cols = focusCol`. This pins the SAME math
 * `CellGridPanel.freezeFocusedPanesAtSelection` applies to the focused panel's live selection, so the
 * menu path (which carries the authoritative right-click-time selection, like the structural commands
 * above) cannot drift from the palette path. The ANCHOR is deliberately ignored (Excel freezes at the
 * active cell, not the selection rect); a focus of A1 (`0,0`) yields `0/0` -- the natural Unfreeze.
 * Pure; no I/O. The webview re-clamps the counts on apply (defence in depth).
 */
export function planFreezeAtSelection(sel: GridSelectionInput): { rows: number; cols: number } {
	return { rows: Math.max(0, sel.focusRow), cols: Math.max(0, sel.focusCol) };
}

/**
 * The validated context argument a context-menu command receives. VS Code passes the PARSED
 * `data-vscode-context` object as the command's first argument; {@link parseContextMenuArg} validates it
 * into this shape (or `undefined` if malformed). `panelToken` routes to the exact raising panel
 * (Codex HIGH-2); `selection` is the authoritative right-click-time rect the command plans from
 * (Codex HIGH-1) instead of the async-updated host selection.
 */
export interface ContextMenuArg {
	readonly panelToken: string;
	readonly selection: GridSelectionInput;
	/**
	 * The exact 0-based cell the right-click landed on, when the payload carried it (every grid-cell payload
	 * does -- see `buildCellContextPayload`). This is DISTINCT from the selection anchor: when the right-click
	 * lands INSIDE a pre-existing multi-cell selection, the webview KEEPS that selection, so `selection.anchor`
	 * is a selection CORNER, not the clicked cell. A command that acts on the right-clicked cell (e.g. table
	 * Drop/Rename, which resolves the table CONTAINING the click) MUST use this, never the anchor.
	 */
	readonly cell?: { readonly row: number; readonly col: number };
}

/** True iff `v` is a finite integer (the selection coords must be exact grid indices, never coerced). */
function isInt(v: unknown): v is number {
	return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Validate the raw `data-vscode-context` argument a context-menu command was invoked with into a
 * {@link ContextMenuArg}, or `undefined` if it is missing / malformed (No-Fallbacks: the command surfaces
 * a clear toast rather than acting on a guessed selection). Requires a non-empty `panelToken` string and a
 * `selection` whose four corners are non-negative integers. Pure; no vscode.
 */
export function parseContextMenuArg(raw: unknown): ContextMenuArg | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const obj = raw as { panelToken?: unknown; selection?: unknown; cell?: unknown };
	if (typeof obj.panelToken !== 'string' || obj.panelToken.length === 0) {
		return undefined;
	}
	const sel = obj.selection;
	if (typeof sel !== 'object' || sel === null) {
		return undefined;
	}
	const s = sel as { anchorRow?: unknown; anchorCol?: unknown; focusRow?: unknown; focusCol?: unknown };
	if (!isInt(s.anchorRow) || !isInt(s.anchorCol) || !isInt(s.focusRow) || !isInt(s.focusCol)) {
		return undefined;
	}
	const base: ContextMenuArg = {
		panelToken: obj.panelToken,
		selection: { anchorRow: s.anchorRow, anchorCol: s.anchorCol, focusRow: s.focusRow, focusCol: s.focusCol },
	};
	// The hit cell is optional in the SHAPE (older/other payloads may omit it; existing consumers ignore it),
	// but if PRESENT it must validate strictly (No-Fallbacks: a present-but-malformed cell rejects the whole
	// arg rather than being silently dropped, so a command relying on it never acts on a coerced coordinate).
	// Only attach `cell` when valid+present -- never an own `cell: undefined` key (keeps the shape minimal).
	if (obj.cell === undefined) {
		return base;
	}
	if (typeof obj.cell !== 'object' || obj.cell === null) {
		return undefined;
	}
	const c = obj.cell as { row?: unknown; col?: unknown };
	if (!isInt(c.row) || !isInt(c.col)) {
		return undefined;
	}
	return { ...base, cell: { row: c.row, col: c.col } };
}
