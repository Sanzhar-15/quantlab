/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-5 W-T "Structured Tables" -- the vscode-free core of CREATING a structured table from the focused
// grid's selection, plus the shared validation for table / column identifiers. The command (in
// quantbookCommands.ts) reads the focused grid's selection rect + sheet id, builds a {@link TableSpecJson}
// via {@link buildTableSpec}, and calls `session.createTable(spec)` (then refreshes -- a table op bumps the
// epoch, so the panel reseeds from a fresh snapshot). Rename / drop are thin wrappers over
// `session.renameTable` / `session.dropTable`.
//
// The engine OWNS the hard validation (footprint overlap, spill-anchor collision, namespace collision -- it
// throws `[table_create_rejected]` / `[table_not_found]`). This module only does the CHEAP, pure shaping the
// command needs BEFORE the call: the identifier rules (so the input box can reject early with a reason) and
// the selection-rect -> spec projection (column-count + default column names). No-Fallbacks: a malformed
// selection throws rather than building a spec the engine would refuse.

import { isValidDefinedName, definedNameRejectionReason } from './nameDefineLogic';
import { normalizeSelectionRect } from '../reactiveNotebook/bindVariableLogic';
import { columnLabel } from '../shared/gridLayoutA1';
import type { TableSpecJson, TableSnapshotJson } from '../types';

// The A1 grid extent (mirrors nameDefineLogic / cellGridLogic). A selection outside this is only reachable
// from a tampered webview bundle; reject it loudly (No-Fallbacks).
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

/**
 * Whether `name` is a usable table / column identifier. A structured table shares the defined-name
 * namespace in the engine (a table name collides with a defined name), and the engine canonicalizes +
 * validates the identifier the same way, so we reuse the FE-4 {@link isValidDefinedName} rules verbatim
 * (first char letter/underscore; rest letters/digits/underscore/period; not a cell ref; ASCII). This keeps
 * the table-name input box's early reject consistent with what the engine will accept.
 */
export function isValidTableIdentifier(name: string): boolean {
	return isValidDefinedName(name);
}

/**
 * The reason a candidate table / column identifier was rejected, for a specific input-box message
 * (No-Fallbacks: the operator sees WHY). `undefined` means valid. Delegates to the FE-4
 * {@link definedNameRejectionReason} (shared namespace + identical rules).
 */
export function tableIdentifierRejectionReason(name: string): string | undefined {
	return definedNameRejectionReason(name);
}

/**
 * Build the default header names for a `cols`-wide table: `Column1`, `Column2`, ... `ColumnN` (Excel's
 * default-table-header convention). The engine requires `columnNames.length === cols` and the names to be
 * unique + non-empty; these defaults satisfy that. Throws on a non-positive / non-integer `cols`
 * (No-Fallbacks -- the caller derives `cols` from a validated rect, but guard anyway).
 */
export function defaultColumnNames(cols: number): string[] {
	if (!Number.isInteger(cols) || cols <= 0) {
		throw new Error(`[bad_argument] defaultColumnNames: cols must be a positive integer, got ${cols}.`);
	}
	const names: string[] = [];
	for (let i = 0; i < cols; i++) {
		names.push(`Column${i + 1}`);
	}
	return names;
}

/**
 * Normalize the focused grid's selection (`anchor` + `focus`, in ANY order) + its sheet id + the table
 * `name` into the {@link TableSpecJson} `SessionInstance.createTable(spec)` expects: a sheet-qualified rect
 * with `start <= end` on both axes (0-based), `hasHeader: true`, `hasTotals: false`, and a `Column1..N`
 * default header row sized to the selection's column span.
 *
 * No-Fallbacks:
 *  - A non-integer / out-of-extent corner or a non-u16 sheet id throws `[bad_argument]` (rather than
 *    building a footprint the engine would refuse cell-by-cell).
 *  - The `name` is NOT re-validated here (the caller's input box already enforced
 *    {@link isValidTableIdentifier}); a duplicate / footprint-overlap is the engine's
 *    `[table_create_rejected]` to raise.
 */
export function buildTableSpec(name: string, sheet: number, anchorRow: number, anchorCol: number, focusRow: number, focusCol: number): TableSpecJson {
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 65535) {
		throw new Error(`[bad_argument] buildTableSpec: sheet must be an integer in [0, 65535], got ${sheet}.`);
	}
	for (const [label, v] of [['anchorRow', anchorRow], ['anchorCol', anchorCol], ['focusRow', focusRow], ['focusCol', focusCol]] as const) {
		if (!Number.isInteger(v)) {
			throw new Error(`[bad_argument] buildTableSpec: selection ${label} must be an integer, got ${v}.`);
		}
	}
	const rect = normalizeSelectionRect(anchorRow, anchorCol, focusRow, focusCol);
	if (rect.startRow < 0 || rect.endRow >= A1_MAX_ROWS || rect.startCol < 0 || rect.endCol >= A1_MAX_COLS) {
		throw new Error(`[bad_argument] buildTableSpec: selection (${rect.startRow},${rect.startCol})-(${rect.endRow},${rect.endCol}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}).`);
	}
	const rows = rect.endRow - rect.startRow + 1;
	const cols = rect.endCol - rect.startCol + 1;
	return {
		name,
		sheet,
		topRow: rect.startRow,
		topCol: rect.startCol,
		rows,
		cols,
		hasHeader: true,
		hasTotals: false,
		columnNames: defaultColumnNames(cols),
	};
}

// FE-8 (2026-06-14) "Tables -- lifecycle UI". Drop / Rename act on an EXISTING table; the operator picks it
// either by right-clicking inside its footprint (context-aware) or from a QuickPick of every table in the
// workbook. The two pure helpers below back both paths -- no vscode, no session, fully unit-testable. The
// table set comes from `session.snapshot().tables` ({@link TableSnapshotJson}); the engine forbids
// overlapping footprints, so {@link tableAtCell} returns AT MOST one table.

/**
 * The table on `sheet` whose footprint `[topRow, topRow+rows) x [topCol, topCol+cols)` contains the 0-based
 * cell `(row, col)`, or `undefined` if the cell is in no table on that sheet. The engine guarantees table
 * footprints never overlap, so the first containing table is the only one. A non-finite / non-integer
 * coordinate matches nothing (returns `undefined`) -- this is a pure lookup, so "no match" is the correct
 * result for a junk input, NOT an error to mask; the caller treats `undefined` as "right-clicked outside any
 * table -> fall back to the full picker", which is legitimate UX, not a swallowed failure.
 */
export function tableAtCell(tables: readonly TableSnapshotJson[], sheet: number, row: number, col: number): TableSnapshotJson | undefined {
	if (!Number.isInteger(sheet) || !Number.isInteger(row) || !Number.isInteger(col)) {
		return undefined;
	}
	for (const t of tables) {
		if (t.sheet === sheet && row >= t.topRow && row < t.topRow + t.rows && col >= t.topCol && col < t.topCol + t.cols) {
			return t;
		}
	}
	return undefined;
}

/** One row of the table picker: the underlying snapshot plus the pre-shaped display strings. */
export interface TablePickItem {
	/** The table this row selects -- the canonical {@link TableSnapshotJson.name} is what drop/rename pass to the engine. */
	readonly table: TableSnapshotJson;
	/** Display label: the human {@link TableSnapshotJson.displayName}. */
	readonly label: string;
	/** A1 footprint, e.g. `A1:C10` (top-left .. bottom-right, header row included). */
	readonly rangeLabel: string;
	/** Dimensions + header/totals summary, e.g. `10 rows x 3 cols - header`. */
	readonly detail: string;
}

/**
 * Shape the workbook's tables into picker rows (display name, A1 footprint, dims summary). Pure: the SHEET
 * NAME is intentionally NOT resolved here (that needs the session's `listSheets()`); the command layer adds
 * it as the QuickPick `description`. Order is preserved from the snapshot (the engine sorts by sheet then
 * canonical name). Returns `[]` for an empty list -- the command surfaces a loud "no tables" message rather
 * than opening an empty picker (No-Fallbacks: never a silent no-op).
 */
export function tableQuickPickItems(tables: readonly TableSnapshotJson[]): TablePickItem[] {
	return tables.map((t) => {
		const topLeft = `${columnLabel(t.topCol)}${t.topRow + 1}`;
		const bottomRight = `${columnLabel(t.topCol + t.cols - 1)}${t.topRow + t.rows}`;
		const flags = [t.hasHeader ? 'header' : undefined, t.hasTotals ? 'totals' : undefined].filter((f): f is string => f !== undefined);
		const detail = `${t.rows} rows x ${t.cols} cols${flags.length > 0 ? ` - ${flags.join(' + ')}` : ''}`;
		return { table: t, label: t.displayName, rangeLabel: `${topLeft}:${bottomRight}`, detail };
	});
}

// FE-8.1 (2026-06-15) "Resize Table to Selection". The engine's `resizeTable(name, newRows, newCols,
// addedColumns, removedColumns)` re-ranges a table to a new extent ANCHORED AT ITS EXISTING TOP-LEFT (the
// engine inherits + freezes `top_row`/`top_col` -- a table can be resized but never moved). The pure core
// below decides, from the target table's snapshot + the operator's selection, exactly what -- if any --
// resize call re-ranges it to that selection: row grow/shrink, column GROW (appended columns auto-named),
// and column SHRINK.
//
// FE-8.3 (2026-06-15) unblocked column SHRINK: the engine wants the trailing column NAMES in
// `removedColumns` (it validates them against the live roster -- see ql-exec tables.rs `resize_table`), and
// the IDE can now read them via `SessionInstance.tableColumns(name)`. `planTableResize` takes that roster
// and slices off the trailing names to drop; the engine re-validates and rejects loudly on any mismatch
// (No-Fallbacks -- we never guess the names).

/**
 * The default-convention names for the columns APPENDED when a table grows from `oldCols` to `newCols`:
 * `Column{oldCols+1}` .. `Column{newCols}` (continuing {@link defaultColumnNames}'s `Column1..ColumnN`
 * scheme). Because the IDE is the only table creator and always names columns `Column1..ColumnOldCols`
 * (see {@link buildTableSpec}), these appended names are collision-free BY CONSTRUCTION for IDE-created
 * tables; a table loaded from a `.qbook` with non-default column names could (rarely) collide, in which
 * case `session.resizeTable` rejects it loudly -- we NEVER silently rename to dodge a collision
 * (No-Fallbacks). Throws on a non-grow / non-integer span (the caller only reaches this on a validated
 * col-grow, but guard anyway).
 */
export function appendedColumnNames(oldCols: number, newCols: number): string[] {
	if (!Number.isInteger(oldCols) || !Number.isInteger(newCols)) {
		throw new Error(`[bad_argument] appendedColumnNames: oldCols/newCols must be integers, got ${oldCols}/${newCols}.`);
	}
	if (oldCols < 0 || newCols <= oldCols) {
		throw new Error(`[bad_argument] appendedColumnNames: newCols (${newCols}) must exceed oldCols (${oldCols}).`);
	}
	const names: string[] = [];
	for (let i = oldCols; i < newCols; i++) {
		names.push(`Column${i + 1}`);
	}
	return names;
}

/**
 * The decision a "Resize Table to Selection" makes against {@link SessionInstance.resizeTable}: either a
 * concrete `resize` call, a `noop` (selection already matches the footprint), or a loud `error` (the
 * operator-facing reason). No-Fallbacks: nothing is silently clamped or dropped.
 */
export type TableResizeAction =
	| { readonly kind: 'resize'; readonly newRows: number; readonly newCols: number; readonly addedColumns: string[]; readonly removedColumns: string[] }
	| { readonly kind: 'noop' }
	| { readonly kind: 'error'; readonly reason: string };

/**
 * Plan a resize of `table` (resolved via {@link tableAtCell}) to the operator's selection (corners in ANY
 * order). The table's top-left anchor is frozen by the engine, so the selection MUST start at the table's
 * top-left; the new extent is the selection's row/col span. `columnNames` is the table's CURRENT column
 * roster (display names, in order) from {@link SessionInstance.tableColumns} -- needed to compute the
 * trailing names to drop on a column shrink.
 *
 * Precedence (first match wins):
 *  1. a non-integer corner (only reachable from a tampered webview) -> `error`.
 *  2. `columnNames.length != table.cols` -> `error` (roster/snapshot disagree = stale state; don't guess).
 *  3. selection top-left != table top-left -> `error` naming the required A1 cell (the anchor can't move).
 *  4. footprint outside the A1 grid -> `error`.
 *  5. selection == current footprint -> `noop` (the engine would no-op; skip the call).
 *  6. COLUMN SHRINK (`newCols < table.cols`) -> `resize` dropping the trailing `cols - newCols` names
 *     (`removedColumns = columnNames.slice(newCols)`), `addedColumns: []`.
 *  7. COLUMN GROW (`newCols > table.cols`) -> `resize` with `addedColumns` auto-named, `removedColumns: []`.
 *  8. row-only change -> `resize` with empty add/remove.
 *
 * The engine balance invariant `newCols == oldCols + added - removed` holds by construction in every branch
 * (grow: removed empty, added = newCols-oldCols; shrink: added empty, removed = oldCols-newCols; row-only:
 * both empty).
 */
export function planTableResize(table: TableSnapshotJson, columnNames: readonly string[], anchorRow: number, anchorCol: number, focusRow: number, focusCol: number): TableResizeAction {
	for (const [label, v] of [['anchorRow', anchorRow], ['anchorCol', anchorCol], ['focusRow', focusRow], ['focusCol', focusCol]] as const) {
		if (!Number.isInteger(v)) {
			return { kind: 'error', reason: `the selection ${label} is not a whole number (${v}).` };
		}
	}
	// The roster (from `tableColumns`) and the snapshot (from `snapshot().tables`) come from the SAME session
	// and must agree on column count; a mismatch means the snapshot is stale (No-Fallbacks: surface it, never
	// slice a stale roster and send the engine the wrong names).
	if (columnNames.length !== table.cols) {
		return { kind: 'error', reason: `the table's column roster (${columnNames.length}) doesn't match its column count (${table.cols}) -- the view is stale. Refresh the Cell Grid and retry.` };
	}
	const rect = normalizeSelectionRect(anchorRow, anchorCol, focusRow, focusCol);
	if (rect.startRow !== table.topRow || rect.startCol !== table.topCol) {
		const required = `${columnLabel(table.topCol)}${table.topRow + 1}`;
		return { kind: 'error', reason: `the selection must start at the table's top-left cell ${required} -- a table can be resized but not moved. Re-select starting at ${required}.` };
	}
	if (rect.endRow < 0 || rect.endRow >= A1_MAX_ROWS || rect.endCol < 0 || rect.endCol >= A1_MAX_COLS) {
		return { kind: 'error', reason: `the selection extends outside the grid (max ${A1_MAX_ROWS} rows x ${A1_MAX_COLS} columns).` };
	}
	const newRows = rect.endRow - rect.startRow + 1;
	const newCols = rect.endCol - rect.startCol + 1;
	if (newRows === table.rows && newCols === table.cols) {
		return { kind: 'noop' };
	}
	if (newCols < table.cols) {
		// COLUMN SHRINK: drop the trailing (cols - newCols) columns. The engine requires `removedColumns` to
		// be EXACTLY those trailing display names, in order, case-insensitive (ql-exec tables.rs resize_table);
		// slicing the live roster from `newCols` gives precisely that. Handles a combined col-shrink +
		// row-change too (newRows comes from the selection).
		return { kind: 'resize', newRows, newCols, addedColumns: [], removedColumns: columnNames.slice(newCols) };
	}
	if (newCols > table.cols) {
		return { kind: 'resize', newRows, newCols, addedColumns: appendedColumnNames(table.cols, newCols), removedColumns: [] };
	}
	// row-only change (newCols === table.cols)
	return { kind: 'resize', newRows, newCols, addedColumns: [], removedColumns: [] };
}

// FE-8.3 (2026-06-15) "Rename a table column". The engine's `renameColumn(table, oldCol, newCol)` exists
// (it mutates the column metadata + rewrites stored structured-reference formula text as one undo unit) but
// was unreachable from the UI because the IDE couldn't read a table's column names to offer them. With
// `SessionInstance.tableColumns(name)` (FE-8.3) the command can list them; the pure core below validates the
// chosen rename against the live roster BEFORE the call, mirroring the engine's own checks
// (ql-exec tables.rs `rename_column`: non-empty + identifier rules, target-not-already-present,
// same-canonical no-op) so the input box / command can reject early with a reason (No-Fallbacks).

/**
 * ASCII-only lowercasing, matching the engine's column-name canonicalization EXACTLY. The engine folds
 * column names with Rust's `to_ascii_lowercase` / `eq_ignore_ascii_case` (ql-exec tables.rs) -- which folds
 * ONLY `A`-`Z`. JS `String.prototype.toLowerCase()` ALSO folds non-ASCII letters, which would DIVERGE: e.g.
 * U+00C5 (A-with-ring, upper) and U+00E5 (a-with-ring, lower) are DISTINCT columns to the engine (ASCII fold
 * leaves both unchanged) but EQUAL under Unicode folding -- so a Unicode-based match could pick the WRONG
 * column and rename/rewrite formulas for it (silent corruption). Fold only `A`-`Z` so our
 * match/collision/no-op decisions are byte-identical to the engine's.
 */
function asciiLower(s: string): string {
	return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * The decision a "Rename Table Column" makes against {@link SessionInstance.renameColumn}: a concrete
 * `rename` call, a `noop` (the new name is the old one, modulo ASCII case -- the engine no-ops a
 * same-canonical rename), or a loud `error` (the operator-facing reason). No-Fallbacks: nothing is silently
 * coerced.
 */
export type ColumnRenameAction =
	| { readonly kind: 'rename'; readonly oldCol: string; readonly newCol: string }
	| { readonly kind: 'noop' }
	| { readonly kind: 'error'; readonly reason: string };

/**
 * Plan renaming the column `oldCol` of a table (whose current roster is `columnNames`, display names in
 * order from {@link SessionInstance.tableColumns}) to `newCol`.
 *
 * Precedence (first match wins), mirroring the engine's `rename_column` validation so we reject early:
 *  1. `newCol` fails the shared table/column identifier rules -> `error` (the engine would reject it).
 *  2. `oldCol` is not in the roster (case-insensitive, like the engine's `lookup_column`) -> `error`.
 *  3. `newCol` canonical == `oldCol` canonical -> `noop` (engine returns Ok(0); a case-only change is a
 *     no-op there, so we don't pretend otherwise).
 *  4. `newCol` canonical collides with a DIFFERENT existing column -> `error` (engine `[table_column_rejected]`).
 *  5. otherwise -> `rename` (carrying the exact stored display name as `oldCol`).
 */
export function planColumnRename(columnNames: readonly string[], oldCol: string, newCol: string): ColumnRenameAction {
	// CONSERVATIVE v1: we validate `newCol` with the shared table/defined-name identifier rules
	// ({@link tableIdentifierRejectionReason}), which is STRICTER than the engine's `rename_column` (that only
	// rejects empty / collision). So a cell-ref-shaped target (e.g. "Q3") is refused here even though the
	// engine would store it. This is a loud refuse (never silent), kept until we verify such names round-trip
	// in structured references (`Table[Q3]`); see the fe-tablecols plan's known-limitations.
	const reason = tableIdentifierRejectionReason(newCol);
	if (reason !== undefined) {
		return { kind: 'error', reason };
	}
	// Match / collide / no-op using ASCII-only folding -- byte-identical to the engine's column canonicalization
	// (asciiLower); a Unicode fold here would pick the wrong column for non-ASCII rosters.
	const oldLower = asciiLower(oldCol);
	const existingIdx = columnNames.findIndex((c) => asciiLower(c) === oldLower);
	if (existingIdx === -1) {
		return { kind: 'error', reason: `the table has no column named "${oldCol}".` };
	}
	const newLower = asciiLower(newCol);
	if (newLower === oldLower) {
		// Same canonical name: the engine treats a same-canonical rename as Ok(0) (no display change), so
		// skip the call rather than imply a change we won't get.
		return { kind: 'noop' };
	}
	if (columnNames.some((c, i) => i !== existingIdx && asciiLower(c) === newLower)) {
		return { kind: 'error', reason: `the table already has a column named "${newCol}".` };
	}
	return { kind: 'rename', oldCol: columnNames[existingIdx], newCol };
}
