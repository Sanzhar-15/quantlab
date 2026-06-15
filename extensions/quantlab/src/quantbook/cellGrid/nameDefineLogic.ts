/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 W1 "Define Name" -- the vscode-free core of defining a workbook name over the current selection.
//
// The command (in quantbookCommands.ts) reads the focused grid's selection
// (CellGridPanel.focusedGridSelection) + its sheet id, validates the operator-typed name via
// {@link isValidDefinedName}, normalizes the selection rect into the {@link CellRangeJson} shape
// `SessionInstance.setName(name, target)` expects via {@link buildNameRange}, calls `setName`, and shows
// a confirmation TOAST. The risky, pure parts -- the Excel name-validation rules + the selection->range
// normalization -- live HERE and are unit-tested directly (the command is a thin vscode shell, the
// established cellGrid N-1/N-2 split).
//
// **GROUND TRUTH (2026-06-10)**: `setName` emits NO SessionChange -- a defined name is delta-invisible
// (it is NOT part of the snapshot/delta DTOs). So there is nothing to refresh on the grid and the only
// operator feedback is the command-level confirmation toast. This is v1 = DEFINE only (no list / no
// delete / no manager UI -- that is FE-5).
//
// **Range orientation**: `setName` itself normalizes an inverted target (startRow > endRow) to
// start <= end per axis (a defined name is a rectangle; corner order carries no meaning -- Excel/Sheets
// named-range semantics, documented on the napi method). We ALSO normalize here so the toast/label
// reports the well-ordered rect and the two layers never disagree.
//
// No-Fallbacks: an invalid name is rejected by the command's input box via {@link isValidDefinedName}
// (never coerced into a broken name); a malformed selection coordinate throws `[bad_argument]` rather
// than building a range the engine would refuse.

import type { CellRangeJson } from '../types';
import { normalizeSelectionRect } from '../reactiveNotebook/bindVariableLogic';

// The A1 grid extent the webview renders (mirrors cellGridLogic's private A1_MAX_ROWS/COLS). A selection
// outside this is only reachable from a tampered webview bundle; we reject it loudly (No-Fallbacks).
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

// Excel's defined-name length cap: a name may be up to 255 characters. Longer is rejected.
export const MAX_DEFINED_NAME_LENGTH = 255;

/**
 * Whether `name` is a usable workbook defined-name under Excel's naming rules, which the engine's
 * name table also enforces:
 *  - The first character is a LETTER or an underscore (`_`). (Excel also allows a backslash as the first
 *    char; we omit that rarely-used form in v1 for a simpler, stricter rule -- No-Fallbacks favors a
 *    clear reject over a surprising accept.)
 *  - Every subsequent character is a letter, a digit, an underscore, or a period (`.`).
 *  - The name is NOT a valid cell reference (e.g. `A1`, `B$2`, `$AB$12`) -- such a name would be
 *    ambiguous with a coordinate. It is also NOT an R1C1-style reference (`R`, `C`, `R1C1`, `RC`), which
 *    Excel forbids for the same reason.
 *  - The single letters `R` and `C` (any case) are reserved by Excel (R1C1 row/column shorthands) and
 *    rejected.
 *  - Length is 1..{@link MAX_DEFINED_NAME_LENGTH} characters.
 *  - ASCII only (the validation regex is ASCII-disciplined, matching the repo's ASCII-only source rule
 *    and the engine's identifier handling; a non-ASCII letter is rejected rather than risking a mismatch
 *    with the engine's name canonicalization).
 *
 * No-Fallbacks: the command's input box validates with this and refuses an invalid name rather than
 * coercing it. The check is case-INSENSITIVE where Excel is (cell-ref / R1C1 reservations), but the
 * stored name keeps its original casing (the engine owns canonicalization).
 */
export function isValidDefinedName(name: string): boolean {
	if (name.length === 0 || name.length > MAX_DEFINED_NAME_LENGTH) {
		return false;
	}
	// First char letter/underscore; rest letters/digits/underscore/period. ASCII-only.
	if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
		return false;
	}
	// Reject names that ARE a cell reference (would collide with a coordinate). Matches an optional `$`
	// before the column and before the row: e.g. A1, $A1, A$1, $A$1, AB12, $XFD$1048576. Case-insensitive
	// column letters.
	if (/^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$/.test(name)) {
		return false;
	}
	// Reject R1C1-style references and the bare R/C row/column shorthands Excel reserves.
	// Forms: R, C, RC, R1C1, R1, C1, R[1]C[1] is not producible here (brackets are rejected by the char
	// rule above), so we cover R / C / R<digits> / C<digits> / R<digits>C<digits> / RC.
	if (/^[Rr]$|^[Cc]$|^[Rr][Cc]$|^[Rr][0-9]+$|^[Cc][0-9]+$|^[Rr][0-9]+[Cc][0-9]+$/.test(name)) {
		return false;
	}
	return true;
}

/**
 * The reason a candidate name was rejected, for a specific input-box validation message (No-Fallbacks:
 * the operator sees WHY, not a generic "invalid"). `undefined` means the name is valid.
 */
export function definedNameRejectionReason(name: string): string | undefined {
	if (name.length === 0) {
		return 'A name cannot be empty.';
	}
	if (name.length > MAX_DEFINED_NAME_LENGTH) {
		return `A name cannot exceed ${MAX_DEFINED_NAME_LENGTH} characters (got ${name.length}).`;
	}
	if (!/^[A-Za-z_]/.test(name)) {
		return 'A name must start with a letter or an underscore.';
	}
	if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
		return 'A name may contain only ASCII letters, digits, underscores, and periods.';
	}
	if (/^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$/.test(name)) {
		return `"${name}" looks like a cell reference; a defined name cannot be a cell address.`;
	}
	if (/^[Rr]$|^[Cc]$|^[Rr][Cc]$|^[Rr][0-9]+$|^[Cc][0-9]+$|^[Rr][0-9]+[Cc][0-9]+$/.test(name)) {
		return `"${name}" is reserved (R1C1 reference form); choose a different name.`;
	}
	return undefined;
}

/**
 * **FE-8.4 (2026-06-15):** the rejection reason for a candidate TABLE COLUMN name -- the RELAXED sibling
 * of {@link definedNameRejectionReason}. A defined / table name shares the cell namespace, so `=Q3` is
 * ambiguous with the coordinate Q3 and those validators reject cell-reference-shaped + R1C1-form names.
 * A COLUMN is different: it is ALWAYS referenced bracketed + table-qualified (`Table[Q3]`), where the
 * lexer reads the bracket content as a RAW column string with NO coordinate interpretation -- so a column
 * named `Q3` (or `R`, `C`, `R1C1`) is never ambiguous, and the engine accepts it (verified end-to-end:
 * `ql-exec` `structured_ref_cell_ref_shaped_column_names_round_trip` + `..._r1c1_shaped_..`). For a quant
 * product, quarterly columns `Q1..Q4` are exactly this case.
 *
 * So this KEEPS the structural identifier rules -- non-empty; length cap; first char `[A-Za-z_]`; rest
 * `[A-Za-z0-9_.]`; ASCII-only -- which guarantee the name needs no bracket-escaping (staying inside the
 * class the engine probes verified: bare ASCII identifiers), and DROPS only the two
 * "collides-with-a-coordinate" guards (the cell-ref reject and the R1C1 reject). Names that would need
 * escaping (spaces, `[ ] # @ '`, digit-leading, non-ASCII) are STILL rejected loudly (No-Fallbacks: we
 * relax only to what is verified, never to an unproven accept). `undefined` means valid.
 */
export function columnNameRejectionReason(name: string): string | undefined {
	if (name.length === 0) {
		return 'A column name cannot be empty.';
	}
	if (name.length > MAX_DEFINED_NAME_LENGTH) {
		return `A column name cannot exceed ${MAX_DEFINED_NAME_LENGTH} characters (got ${name.length}).`;
	}
	if (!/^[A-Za-z_]/.test(name)) {
		return 'A column name must start with a letter or an underscore.';
	}
	if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
		return 'A column name may contain only ASCII letters, digits, underscores, and periods.';
	}
	// NOTE: unlike `definedNameRejectionReason`, a column name MAY be a cell-reference shape (`Q3`, `A1`) or
	// an R1C1 form (`R`, `C`, `R1C1`) -- a column is only ever referenced as `Table[<name>]`, never as a
	// bare coordinate, so there is no ambiguity to guard against.
	return undefined;
}

/**
 * **FE-8.4 (2026-06-15):** whether `name` is a usable table COLUMN identifier (the relaxed boolean form of
 * {@link columnNameRejectionReason} -- allows cell-ref / R1C1 shapes that a defined/table name forbids).
 */
export function isValidColumnName(name: string): boolean {
	return columnNameRejectionReason(name) === undefined;
}

/**
 * Normalize a selection's two corners (`anchor` + `focus`, in ANY order) + its sheet id into the
 * {@link CellRangeJson} shape `SessionInstance.setName(name, target)` expects: a sheet-qualified rect with
 * `start <= end` on both axes (0-based, inclusive). The selection corners are min/maxed via the shared
 * {@link normalizeSelectionRect}.
 *
 * No-Fallbacks: a non-integer / out-of-extent corner or a non-u16 sheet id throws `[bad_argument]` rather
 * than building a range the engine would refuse cell-by-cell.
 */
export function buildNameRange(sheet: number, anchorRow: number, anchorCol: number, focusRow: number, focusCol: number): CellRangeJson {
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 65535) {
		throw new Error(`[bad_argument] buildNameRange: sheet must be an integer in [0, 65535], got ${sheet}.`);
	}
	for (const [name, v] of [['anchorRow', anchorRow], ['anchorCol', anchorCol], ['focusRow', focusRow], ['focusCol', focusCol]] as const) {
		if (!Number.isInteger(v)) {
			throw new Error(`[bad_argument] buildNameRange: selection ${name} must be an integer, got ${v}.`);
		}
	}
	const rect = normalizeSelectionRect(anchorRow, anchorCol, focusRow, focusCol);
	if (rect.startRow < 0 || rect.endRow >= A1_MAX_ROWS || rect.startCol < 0 || rect.endCol >= A1_MAX_COLS) {
		throw new Error(`[bad_argument] buildNameRange: selection (${rect.startRow},${rect.startCol})-(${rect.endRow},${rect.endCol}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}).`);
	}
	return {
		sheet,
		startRow: rect.startRow,
		startCol: rect.startCol,
		endRow: rect.endRow,
		endCol: rect.endCol,
	};
}

/**
 * The confirmation-toast string for a defined name, e.g. `Defined name "returns" -> Returns!B2:B13`.
 * `target` is the A1 range string the command builds via `formatRangeTarget` (from bindVariableLogic).
 * Single-line; the name is shown verbatim (it is already validated to a safe identifier-like string).
 */
export function buildDefineNameToast(name: string, target: string): string {
	return `Defined name "${name}" -> ${target}`;
}
