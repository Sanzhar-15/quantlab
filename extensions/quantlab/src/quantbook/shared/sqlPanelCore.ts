/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-6 / R18 Wave E (2026-06-18) -- pure logic for the SQL-query sidebar.**
 *
 * Lives in `src/quantbook/shared/` (the esbuild-exempt, DOM/vscode/napi-free subtree -- see
 * `gridLayoutA1.ts`) so the SAME functions are used by the webview bundle (`webview/sql-query/`), the host
 * provider (`SqlQueryViewProvider`), the host materialise path (`cellGridPanel.ts`, for `rectDifference`),
 * AND the mocha suite -- one tested copy, no fork.
 *
 * It does the parsing/validation that must be correct (an A1 target string <-> the engine's inclusive
 * 0-based `CellRangeJson` rect; SQL non-empty) and the orphan-cell geometry (`rectDifference`). Everything
 * the engine itself validates (the SELECT body, result-fit, table existence) is left to the engine, which
 * fails LOUD (No-Fallbacks) -- this module never second-guesses it.
 */

import { MAX_COLS, MAX_ROWS, columnLabel } from './gridLayoutA1';
import type { CellRangeJson } from '../types';

/** An inclusive rectangular range in 0-based grid coordinates (no sheet -- the caller supplies it). */
export interface RectLite {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
}

/** One entry in the sidebar's "available tables" helper: a sheet (queryable by name) or a defined table. */
export interface AvailableTable {
	/** The name to use in a `FROM` clause (a sheet name, or a defined table's display name). */
	name: string;
	kind: 'sheet' | 'table';
	/** Owning sheet id (tables only; for display grouping). */
	sheet?: number;
}

/** Ok/err result of parsing an A1 target string. */
export type ParseRangeResult = { ok: true; rect: RectLite } | { ok: false; error: string };

/** Ok/err result of validating the SQL body. */
export type ValidateSqlResult = { ok: true; sql: string } | { ok: false; error: string };

/**
 * 0-based column index for bijective base-26 letters (`'A'`->0, `'Z'`->25, `'AA'`->26, `'XFD'`->16383), or
 * `-1` if any character is not `A`-`Z`. Inverse of {@link columnLabel}. Self-contained (the `gridLayoutA1`
 * / `a1FormulaRefs` copies are not exported) and tested directly.
 */
function colLettersToIndex(letters: string): number {
	if (letters.length === 0) {
		return -1;
	}
	let n = 0;
	for (let i = 0; i < letters.length; i++) {
		const code = letters.charCodeAt(i) - 64; // 'A'(65) -> 1
		if (code < 1 || code > 26) {
			return -1;
		}
		n = n * 26 + code;
	}
	return n - 1; // bijective base-26 -> 0-based
}

/** Parse one A1 cell token (`'A1'`, `'$B$2'`) to a 0-based `{row,col}`, or `null` if malformed/out-of-extent. */
function parseCell(token: string): { row: number; col: number } | null {
	const m = /^([A-Z]+)([0-9]+)$/.exec(token);
	if (m === null) {
		return null;
	}
	const col = colLettersToIndex(m[1]);
	if (col < 0 || col >= MAX_COLS) {
		return null;
	}
	const row1 = Number(m[2]); // 1-based row from the A1 string
	if (!Number.isInteger(row1) || row1 < 1 || row1 > MAX_ROWS) {
		return null;
	}
	return { row: row1 - 1, col };
}

/**
 * Parse a user-entered A1 target (`'A1'`, `'a1:c10'`, `' $A$1 : $C$10 '`) into an inclusive, NORMALISED
 * 0-based {@link RectLite} (so a reversed `C10:A1` becomes `A1:C10`). Case-insensitive; `$` anchors are
 * stripped; surrounding whitespace is ignored. Returns a precise error string (surfaced verbatim to the
 * user -- No-Fallbacks: a malformed target is NEVER silently coerced to a default cell).
 */
export function parseA1Range(text: string): ParseRangeResult {
	const cleaned = text.trim().toUpperCase().replace(/\$/g, '');
	if (cleaned === '') {
		return { ok: false, error: 'Enter a target range, e.g. A1:C10.' };
	}
	// v1 targets the FOCUSED sheet only (no sheet-qualified targets) -- give a clear message instead of a
	// generic "Invalid cell" when the user types e.g. Sheet2!A1.
	if (cleaned.includes('!')) {
		return { ok: false, error: 'Sheet-qualified targets are not supported here -- enter a range on the focused sheet, e.g. A1:C10.' };
	}
	const parts = cleaned.split(':');
	if (parts.length > 2) {
		return { ok: false, error: `Invalid range "${text.trim()}" -- use one cell (A1) or two (A1:C10).` };
	}
	const a = parseCell(parts[0].trim());
	if (a === null) {
		return { ok: false, error: `Invalid cell "${parts[0].trim()}" -- expected A1-style, e.g. A1 (max XFD1048576).` };
	}
	if (parts.length === 1) {
		return { ok: true, rect: { startRow: a.row, startCol: a.col, endRow: a.row, endCol: a.col } };
	}
	const b = parseCell(parts[1].trim());
	if (b === null) {
		return { ok: false, error: `Invalid cell "${parts[1].trim()}" -- expected A1-style, e.g. C10 (max XFD1048576).` };
	}
	return {
		ok: true,
		rect: {
			startRow: Math.min(a.row, b.row),
			startCol: Math.min(a.col, b.col),
			endRow: Math.max(a.row, b.row),
			endCol: Math.max(a.col, b.col),
		},
	};
}

/** Format an inclusive 0-based {@link RectLite} back to an A1 string (`'A1'` for a single cell, else `'A1:C10'`). */
export function formatA1Range(rect: RectLite): string {
	const tl = columnLabel(rect.startCol) + String(rect.startRow + 1);
	if (rect.startRow === rect.endRow && rect.startCol === rect.endCol) {
		return tl;
	}
	return tl + ':' + columnLabel(rect.endCol) + String(rect.endRow + 1);
}

/**
 * Validate the SQL body before sending it to the engine: it must be non-empty after trimming. Everything
 * else (syntax, SELECT-only, table existence, result-fit) is the engine's job and fails LOUD there -- this
 * gate only stops an empty submit. Returns the trimmed SQL on success.
 */
export function validateSqlText(sql: string): ValidateSqlResult {
	const trimmed = sql.trim();
	if (trimmed === '') {
		return { ok: false, error: 'Enter a SELECT query.' };
	}
	return { ok: true, sql: trimmed };
}

/**
 * Build the sidebar's "available tables" hint list: every sheet (queryable by name; columns are the A1
 * letters A, B, C ...) followed by every defined table (queryable by display name; columns are its
 * headers). Pure -- the provider extracts `sheets`/`tables` from the live snapshot and feeds them here.
 */
export function buildAvailableTables(input: {
	sheets: ReadonlyArray<{ id: number; name: string }>;
	tables: ReadonlyArray<{ displayName: string; sheet: number }>;
}): AvailableTable[] {
	const out: AvailableTable[] = [];
	for (const s of input.sheets) {
		out.push({ name: s.name, kind: 'sheet', sheet: s.id });
	}
	for (const t of input.tables) {
		out.push({ name: t.displayName, kind: 'table', sheet: t.sheet });
	}
	return out;
}

/**
 * The sub-rectangles of `prev` NOT covered by `next` (rectangle subtraction over inclusive integer
 * coordinates). Used to clear the ORPHAN cells a re-run leaves behind when its target is MOVED or SHRUNK:
 * `materialize_query` (unlike `publish_dataset`) does not vacate cells the prior, larger materialisation
 * covered, so the IDE clears `prev - next` after a successful re-run.
 *
 * Returns up to four bands (top / bottom / left / right). The left/right bands span only the row-overlap
 * region so corners are never double-counted. Returns `[]` when `next` fully covers `prev`, and `[prev]`
 * when they are disjoint. Callers add the sheet id (same-sheet subtraction only -- a cross-sheet re-run
 * clears the whole `prev`, handled by the caller).
 */
export function rectDifference(prev: RectLite, next: RectLite): RectLite[] {
	// Disjoint -> the whole prev is orphaned.
	if (
		next.endRow < prev.startRow ||
		next.startRow > prev.endRow ||
		next.endCol < prev.startCol ||
		next.startCol > prev.endCol
	) {
		return [{ startRow: prev.startRow, startCol: prev.startCol, endRow: prev.endRow, endCol: prev.endCol }];
	}
	const out: RectLite[] = [];
	// Top band: rows above the overlap, full prev width.
	if (next.startRow > prev.startRow) {
		out.push({ startRow: prev.startRow, endRow: next.startRow - 1, startCol: prev.startCol, endCol: prev.endCol });
	}
	// Bottom band: rows below the overlap, full prev width.
	if (next.endRow < prev.endRow) {
		out.push({ startRow: next.endRow + 1, endRow: prev.endRow, startCol: prev.startCol, endCol: prev.endCol });
	}
	// Left/right bands span only the overlapping rows (so the corners are not double-covered by the bands above).
	const interTop = Math.max(prev.startRow, next.startRow);
	const interBottom = Math.min(prev.endRow, next.endRow);
	if (next.startCol > prev.startCol) {
		out.push({ startRow: interTop, endRow: interBottom, startCol: prev.startCol, endCol: next.startCol - 1 });
	}
	if (next.endCol < prev.endCol) {
		out.push({ startRow: interTop, endRow: interBottom, startCol: next.endCol + 1, endCol: prev.endCol });
	}
	return out;
}

/**
 * The cell ranges to blank after a SUCCESSFUL SQL re-run so no ORPHAN result cells survive a moved/shrunk
 * target. `materialize_query` (unlike `publish_dataset`) writes only the result block at the target's
 * top-left and does NOT vacate cells a prior, larger materialisation covered. Pure (sheet-aware):
 * - `prev === undefined` (first run on this session) -> nothing to clear.
 * - a cross-sheet relocation -> clear the WHOLE prior block (on its own sheet; the rect subtraction is
 *   same-sheet only).
 * - a same-sheet move/shrink -> clear `prev - next` (the disjoint bands from {@link rectDifference}).
 *
 * NOTE (accepted limitation): these vacated cells are the prior SQL OUTPUT region; if the user manually
 * typed unrelated data there between runs it is blanked too (recoverable via undo -- a separate undo unit).
 * A same-target SMALLER result still leaves trailing cells INSIDE the target the IDE cannot bound (the
 * engine returns no result dims); "Clear results" wipes them. Both are tracked engine follow-ups.
 */
export function sqlOrphanClearRanges(prev: CellRangeJson | undefined, next: CellRangeJson): CellRangeJson[] {
	if (prev === undefined) {
		return [];
	}
	if (prev.sheet !== next.sheet) {
		return [{ sheet: prev.sheet, startRow: prev.startRow, startCol: prev.startCol, endRow: prev.endRow, endCol: prev.endCol }];
	}
	return rectDifference(prev, next).map(r => ({
		sheet: prev.sheet,
		startRow: r.startRow,
		startCol: r.startCol,
		endRow: r.endRow,
		endCol: r.endCol,
	}));
}
