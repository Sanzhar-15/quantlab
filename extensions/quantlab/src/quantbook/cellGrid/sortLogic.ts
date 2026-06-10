/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 W2 "Sort range by column" -- the vscode-free core of the range-sort command.
//
// The command (in quantbookCommands.ts) reads the focused grid's selection (CellGridPanel.focusedGridSelection,
// W-G-2b) + the owning Session's WORKBOOK SNAPSHOT (`session.snapshot()` -- the owning Session's method;
// `workbookSnapshot()` is the DORMANT CollabSession's name, NOT this product path), picks a sort-key column +
// a direction, and -- via this layer -- computes the ROW PERMUTATION of the selected rect and emits a
// `SessionOpJson[]` that REWRITES every cell of the rect with the permuted rows, applied as ONE
// `session.batch(...)` (one undo unit) -> recalcDirtyChecked -> CellGridPanel.refreshSession. This layer is
// PURE host logic over the snapshot DTO -- it never touches the webview or the engine directly.
//
// !! WHY WE READ THE SNAPSHOT, NOT `queryRange{include_*}` (FE-4 megaudit Lane C RISK 1+2): the owning Session
// HARD-ERRORS on `queryRange` with `include_formulas`/`include_*` flags (engine `session.rs:1321`,
// `rendered: None`). The v1 DRAFT routed the sort read through `queryRange` with those flags -> it would have
// THROWN on the first sort, AND the "refuse-on-formula" guard would have been a silent no-op (it could not see
// formulas), corrupting formulas on sort. We read the snapshot, whose `CellSnapshotJson.formula` field carries
// the formula text, so the corruption guard below can actually fire.
//
// === THE CORRUPTION GUARD (the headline of this window) ===
// Sorting rewrites cell VALUES via `setValue` ops. A formula cell's relative references are NOT translated by
// this batch (ref-translation on sort is the FE-5 path, once `queryRange{include_formulas}` lands), so moving a
// formula's row would silently corrupt the workbook. THEREFORE: if ANY cell in the selected rect carries a
// `formula` ({@link CellSnapshotJson.formula} != null), {@link buildSortBatch} REFUSES -- it throws a loud,
// specific `[refuse_formula]` error and emits ZERO ops (no partial write). This ALSO covers SPILL ANCHORS (a
// spill anchor always has a `formula`, so it is caught by the same field check). Spilled cells BELOW an anchor
// carry no formula but DO carry a value; if an anchor is in the rect it is refused, and an out-of-rect anchor's
// spill cells are plain values we may freely re-emit.
//
// === DOCUMENTED v1 LIMITATIONS (asserted in the tests so they are DELIBERATE, not silent regressions) ===
//   (a) NUMBER-FORMATS / STYLES do NOT travel with sorted rows. The batch is `setValue`-only; the format
//       overlay (`FormatId`, painted via `CellSnapshotJson.rendered`) is keyed by ABSOLUTE cell address and is
//       NOT touched, so a sorted row keeps the destination address's old format, not its source row's. (Lane C
//       RISK 5.) Translating the format overlay alongside the value is FE-5.
//   (b) RELATIVE REFS IN CELLS OUTSIDE THE RECT that point INTO it are NOT translated. Sort is a `batch` of
//       value writes, not a structural op, so there is no reverse-dependency walk: an external `=A2*10` keeps
//       pointing at A2 (now holding a different sorted value). The engine recalcs it against the new value -- no
//       error, but the formula now references a moved datum. We cannot cheaply detect these from the snapshot
//       (it would require a full dependency scan of the whole workbook), so we DOCUMENT rather than refuse.
//   (c) NAMED RANGES pointing into the rect go STALE for the same reason. Not cheaply detectable from the cell
//       snapshot; documented, not refused.
//
// === ORDERING CONTRACT (Excel convention; documented + tested) ===
// Ascending order across mixed types: NUMBERS first (ascending numerically), then TEXT (ascending by JS string
// compare -- a code-unit order; locale-aware collation is a future refinement), then BOOLEANS (FALSE before
// TRUE). BLANKS are ALWAYS LAST, in BOTH directions (ascending AND descending) -- they never bubble to the top
// on a descending sort (Excel's "blanks sink" rule). Descending reverses the non-blank ordering only. The sort
// is STABLE: rows whose key compares equal keep their original relative order (a stable merge via index
// tie-break), in both directions. `error` / `pending` value kinds are engine-produced + read-only (a `setValue`
// op rejects them, engine `lib.rs:4642`), so a non-formula cell carrying one is unreproducible -- we REFUSE it
// loudly (`[refuse_value_kind]`) rather than emit a batch the engine would reject mid-apply.

import type { CellSnapshotJson, CellValueJson, SessionOpJson, WorkbookSnapshotJson } from '../types';
import { columnLabelA1, normalizeSelectionRect, type NormalizedRect } from '../reactiveNotebook/bindVariableLogic';

// The A1 grid extent the webview renders (mirrors cellGridLogic's private A1_MAX_ROWS/COLS, which are not
// exported; identical bound used by formatPickerLogic.ts). A rect outside this is only reachable from a tampered
// webview bundle; we reject it loudly rather than build ops the engine would refuse cell-by-cell.
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

// Mirror the format-picker batch-cell cap so a giant selection is rejected with a clear message BEFORE we build
// a multi-million-op array. A sort rewrites the WHOLE rect (rows x cols ops), so the cap bounds the op array.
export const MAX_SORT_BATCH_CELLS = 100_000;

/** Sort direction. `asc` = A->Z / smallest-first; `desc` = Z->A / largest-first. Blanks stay last in both. */
export type SortDirection = 'asc' | 'desc';

/**
 * A single cell's value as read from the snapshot, narrowed to the kinds a sort can REPRODUCE via a `setValue`
 * op: `number` | `boolean` | `text` | `blank`. `error` / `pending` are engine-produced + read-only, so they are
 * never represented here -- {@link readRectGrid} REFUSES a non-formula cell carrying one (No-Fallbacks).
 *
 * `blank` carries no payload (an absent / value-less cell). The op-builder emits a `setValue {kind:'blank'}` for
 * it (NOT a `clear` op, which on the engine is convert-to-literal and PRESERVES the value -- the wrong gesture).
 */
export type SortableCellValue =
	| { readonly kind: 'number'; readonly number: number }
	| { readonly kind: 'boolean'; readonly boolean: boolean }
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'blank' };

/** A blank singleton (no payload) -- reused for absent cells + value-less snapshot entries. */
const BLANK: SortableCellValue = { kind: 'blank' };

/**
 * Map a snapshot {@link CellValueJson} to a {@link SortableCellValue}. REFUSES (`[refuse_value_kind]`) on
 * `error` / `pending` -- a `setValue` op cannot carry them (engine `lib.rs:4642`), so a non-formula literal
 * carrying one is unreproducible by a sort batch and we fail loud rather than emit a batch the engine rejects
 * mid-apply. A malformed payload (e.g. `kind:'number'` with no `number` field) throws `[bad_argument]`.
 */
function toSortableValue(value: CellValueJson | undefined, addrLabel: string): SortableCellValue {
	if (value === undefined) {
		return BLANK;
	}
	switch (value.kind) {
		case 'blank':
			return BLANK;
		case 'number': {
			if (typeof value.number !== 'number' || !Number.isFinite(value.number)) {
				throw new Error(`[bad_argument] sort: cell ${addrLabel} has kind 'number' but a non-finite/absent number payload (${String(value.number)}).`);
			}
			return { kind: 'number', number: value.number };
		}
		case 'boolean': {
			if (typeof value.boolean !== 'boolean') {
				throw new Error(`[bad_argument] sort: cell ${addrLabel} has kind 'boolean' but an absent boolean payload.`);
			}
			return { kind: 'boolean', boolean: value.boolean };
		}
		case 'text': {
			if (typeof value.text !== 'string') {
				throw new Error(`[bad_argument] sort: cell ${addrLabel} has kind 'text' but an absent text payload.`);
			}
			return { kind: 'text', text: value.text };
		}
		case 'error':
		case 'pending':
			throw new Error(`[refuse_value_kind] sort: cell ${addrLabel} holds an engine-produced '${value.kind}' value, which a sort cannot rewrite (these are read-only -- a setValue op rejects them). Resolve or clear it first.`);
		default: {
			// A wire kind outside the known union -- fail loud (No-Fallbacks) rather than coerce to blank.
			const exhaustive: string = value.kind;
			throw new Error(`[bad_argument] sort: cell ${addrLabel} has unknown value kind '${exhaustive}'.`);
		}
	}
}

/** Convert a {@link SortableCellValue} back to the `CellValueJson` payload a `setValue` op carries. */
function toOpValue(v: SortableCellValue): CellValueJson {
	switch (v.kind) {
		case 'number':
			return { kind: 'number', number: v.number };
		case 'boolean':
			return { kind: 'boolean', boolean: v.boolean };
		case 'text':
			return { kind: 'text', text: v.text };
		case 'blank':
			return { kind: 'blank' };
		default: {
			const exhaustive: never = v;
			throw new Error(`[bad_argument] sort: unreachable value kind ${String(exhaustive)}.`);
		}
	}
}

/**
 * The materialized rect: a dense `rows x cols` grid of {@link SortableCellValue} (row-major, rect-relative),
 * plus the sort KEY column's values (rect-relative, one per row). Built by {@link readRectGrid} after the
 * formula-refuse guard passes.
 */
export interface RectGrid {
	/** `grid[r][c]` is the value at rect-relative row `r`, col `c` (0-based, within the rect). */
	readonly grid: readonly (readonly SortableCellValue[])[];
	/** `keys[r]` is the sort key for rect-relative row `r` (the value at the chosen key column). */
	readonly keys: readonly SortableCellValue[];
	readonly rows: number;
	readonly cols: number;
}

/**
 * Read the selected rect out of the workbook snapshot into a dense {@link RectGrid}, ENFORCING the corruption
 * guard FIRST: if ANY cell in the rect carries a `formula` ({@link CellSnapshotJson.formula} != null) this
 * THROWS `[refuse_formula]` and reads nothing further (No-Fallbacks -- a single formula refuses the whole sort;
 * this also catches spill anchors). The snapshot's per-sheet cell list is sparse (absent cells are blank); we
 * index it by (row,col) and fill the dense grid, defaulting absent cells to blank.
 *
 * @param snapshot the owning Session's `snapshot()` result (NOT the dormant CollabSession `workbookSnapshot()`).
 * @param sheetId  the sheet to read (the focused grid's sheet).
 * @param rect     the NORMALIZED selection rect (0-based inclusive; caller normalizes via normalizeSelectionRect).
 * @param keyCol   the ABSOLUTE column index whose values are the sort key (must lie within the rect's columns).
 *
 * Throws `[bad_argument]` for a missing sheet, an out-of-rect key column, or an out-of-extent rect.
 */
export function readRectGrid(snapshot: WorkbookSnapshotJson, sheetId: number, rect: NormalizedRect, keyCol: number): RectGrid {
	const r = normalizeSelectionRect(rect.startRow, rect.startCol, rect.endRow, rect.endCol);
	for (const [name, v] of [['startRow', r.startRow], ['startCol', r.startCol], ['endRow', r.endRow], ['endCol', r.endCol]] as const) {
		if (!Number.isInteger(v)) {
			throw new Error(`[bad_argument] sort: rect ${name} must be an integer, got ${v}.`);
		}
	}
	if (r.startRow < 0 || r.endRow >= A1_MAX_ROWS || r.startCol < 0 || r.endCol >= A1_MAX_COLS) {
		throw new Error(`[bad_argument] sort: rect (${r.startRow},${r.startCol})-(${r.endRow},${r.endCol}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}).`);
	}
	if (!Number.isInteger(keyCol) || keyCol < r.startCol || keyCol > r.endCol) {
		throw new Error(`[bad_argument] sort: key column ${keyCol} is not within the selected rect columns [${r.startCol}, ${r.endCol}].`);
	}
	const sheet = snapshot.sheets.find((s) => s.id === sheetId);
	if (sheet === undefined) {
		throw new Error(`[bad_argument] sort: the snapshot has no sheet with id ${sheetId}.`);
	}
	const rows = r.endRow - r.startRow + 1;
	const cols = r.endCol - r.startCol + 1;
	const count = rows * cols;
	if (count > MAX_SORT_BATCH_CELLS) {
		throw new Error(`[bad_argument] sort: ${count} cells exceeds the ${MAX_SORT_BATCH_CELLS}-cell batch limit.`);
	}

	// Index the sparse cell list by (row,col) for O(1) lookup, refusing on the first formula we see anywhere in
	// the rect. We scan the WHOLE rect's cells (not just the key column) because a formula in ANY column of a
	// sorted row would be corrupted by the row move.
	const byAddr = new Map<string, CellSnapshotJson>();
	for (const cell of sheet.cells) {
		if (cell.row < r.startRow || cell.row > r.endRow || cell.col < r.startCol || cell.col > r.endCol) {
			continue; // outside the rect -- irrelevant to this sort
		}
		if (cell.formula !== undefined) {
			const label = `${columnLabelA1(cell.col)}${cell.row + 1}`;
			throw new Error(`[refuse_formula] sort: cell ${label} holds a formula (=${cell.formula}); sorting would move it WITHOUT translating its references, corrupting the workbook. Sorting a range with formulas is not supported in this version (ref-translation is a future feature). Remove or convert-to-values the formulas in the range first.`);
		}
		byAddr.set(`${cell.row},${cell.col}`, cell);
	}

	const grid: SortableCellValue[][] = [];
	const keys: SortableCellValue[] = [];
	for (let rr = 0; rr < rows; rr++) {
		const absRow = r.startRow + rr;
		const rowVals: SortableCellValue[] = [];
		for (let cc = 0; cc < cols; cc++) {
			const absCol = r.startCol + cc;
			const cell = byAddr.get(`${absRow},${absCol}`);
			const label = `${columnLabelA1(absCol)}${absRow + 1}`;
			rowVals.push(cell === undefined ? BLANK : toSortableValue(cell.value, label));
		}
		grid.push(rowVals);
		keys.push(rowVals[keyCol - r.startCol]);
	}
	return { grid, keys, rows, cols };
}

// Type-rank for the ascending cross-type order: numbers (0) < text (1) < booleans (2). Blanks are handled
// SEPARATELY (always last, both directions) and never reach here.
function typeRank(v: SortableCellValue): number {
	switch (v.kind) {
		case 'number':
			return 0;
		case 'text':
			return 1;
		case 'boolean':
			return 2;
		case 'blank':
			// Blanks are partitioned out before comparison; reaching here is a logic error.
			throw new Error('[bad_argument] sort: blank reached the type comparator (should be partitioned last).');
		default: {
			const exhaustive: never = v;
			throw new Error(`[bad_argument] sort: unknown value kind ${String(exhaustive)}.`);
		}
	}
}

/**
 * Compare two NON-blank {@link SortableCellValue}s for ASCENDING order. Cross-type: numbers < text < booleans
 * (Excel convention). Within a type: numbers numerically, text by JS code-unit compare, booleans FALSE < TRUE.
 * Returns <0 / 0 / >0. Blanks must be partitioned out by the caller (they are always last, both directions).
 */
export function compareSortable(a: SortableCellValue, b: SortableCellValue): number {
	const ra = typeRank(a);
	const rb = typeRank(b);
	if (ra !== rb) {
		return ra - rb;
	}
	switch (a.kind) {
		case 'number':
			// Same-type guaranteed by ra===rb; the cast is sound.
			return a.number - (b as { kind: 'number'; number: number }).number;
		case 'text': {
			const bt = (b as { kind: 'text'; text: string }).text;
			return a.text < bt ? -1 : a.text > bt ? 1 : 0;
		}
		case 'boolean': {
			const bb = (b as { kind: 'boolean'; boolean: boolean }).boolean;
			// FALSE (0) before TRUE (1).
			return (a.boolean ? 1 : 0) - (bb ? 1 : 0);
		}
		case 'blank':
			// Unreachable: typeRank(a) above already threw for a blank. Kept so the switch is total.
			throw new Error('[bad_argument] sort: blank reached compareSortable (should be partitioned last).');
		default: {
			const exhaustive: never = a;
			throw new Error(`[bad_argument] sort: unknown value kind ${String(exhaustive)}.`);
		}
	}
}

/**
 * Compute the STABLE row PERMUTATION that sorts `keys` by `direction`. The result `perm` is an array of
 * rect-relative source-row indices in their NEW order: row `perm[i]` of the original rect becomes row `i` of the
 * sorted rect.
 *
 * Rules: BLANK keys are ALWAYS partitioned to the END, in BOTH directions (Excel's blanks-sink). Non-blank keys
 * sort ascending by {@link compareSortable}, then `direction==='desc'` REVERSES the non-blank comparison only
 * (blanks stay last). Stability: equal keys keep their original relative order -- enforced by an explicit index
 * tie-break (NOT relying on `Array.prototype.sort` stability across engines, though modern V8 is stable; the
 * tie-break makes it provable). The blank partition is itself stable (blanks keep their original order).
 */
export function computeSortPermutation(keys: readonly SortableCellValue[], direction: SortDirection): number[] {
	const nonBlank: number[] = [];
	const blanks: number[] = [];
	for (let i = 0; i < keys.length; i++) {
		if (keys[i].kind === 'blank') {
			blanks.push(i);
		} else {
			nonBlank.push(i);
		}
	}
	const sign = direction === 'asc' ? 1 : -1;
	nonBlank.sort((ia, ib) => {
		const cmp = compareSortable(keys[ia], keys[ib]);
		if (cmp !== 0) {
			return sign * cmp;
		}
		// Stable tie-break: preserve original relative order for equal keys, in BOTH directions (the tie-break
		// is NOT multiplied by `sign` -- equal keys must not flip order on a descending sort).
		return ia - ib;
	});
	// Blanks keep their original relative order (already ascending by index) and always trail.
	return nonBlank.concat(blanks);
}

/**
 * Build the ONE batch of `setValue` ops that rewrites the selected rect with its rows permuted by
 * `direction` on `keyCol`. This is the FULL-RECT-REWRITE strategy (documented + tested): EVERY destination cell
 * of the rect gets exactly one `setValue` op carrying the value from its source row -- including cells whose
 * value is unchanged (they get an identical-value `setValue`) and blanks (a `setValue {kind:'blank'}`). Full
 * rewrite is chosen for predictability/safety over a minimal diff: the op set is a deterministic function of the
 * permutation, with no subtle "did this cell actually change" partial-write logic.
 *
 * THE CORRUPTION GUARD runs inside {@link readRectGrid}: if any rect cell has a formula, that throws
 * `[refuse_formula]` BEFORE any op is built, so this returns ZERO ops (a loud throw, never a partial batch).
 *
 * Ops are returned in row-major order over the DESTINATION rect (row-major by absolute (row,col)). The caller
 * applies them via `session.batch(ops, { undoLabel })` (one undo unit).
 *
 * @param sheet     the sheet id (range-checked to the engine u16 bound).
 * @param rect      the NORMALIZED selection rect (0-based inclusive).
 * @param keyCol    ABSOLUTE key column index (within the rect).
 * @param direction sort direction.
 * @param snapshot  the owning Session snapshot to read the rect's current values from.
 */
export function buildSortBatch(
	sheet: number,
	rect: NormalizedRect,
	keyCol: number,
	direction: SortDirection,
	snapshot: WorkbookSnapshotJson,
): SessionOpJson[] {
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 65535) {
		throw new Error(`[bad_argument] sort: sheet must be an integer in [0, 65535], got ${sheet}.`);
	}
	const r = normalizeSelectionRect(rect.startRow, rect.startCol, rect.endRow, rect.endCol);
	// readRectGrid enforces the formula-refuse guard + all rect/key validation; it throws before we build ops.
	const { grid, keys, rows, cols } = readRectGrid(snapshot, sheet, r, keyCol);
	const perm = computeSortPermutation(keys, direction);
	const ops: SessionOpJson[] = [];
	for (let rr = 0; rr < rows; rr++) {
		const sourceRow = grid[perm[rr]];
		const absRow = r.startRow + rr;
		for (let cc = 0; cc < cols; cc++) {
			const absCol = r.startCol + cc;
			ops.push({ kind: 'setValue', sheet, row: absRow, col: absCol, value: toOpValue(sourceRow[cc]) });
		}
	}
	return ops;
}

/**
 * Whether sorting on `keyCol` is a NO-OP given `keys` + `direction` -- i.e. the computed permutation is the
 * identity (already sorted). The command uses this to skip an empty mutation (and tell the operator the range is
 * already sorted) rather than push a no-change undo unit. Pure; does not read the snapshot.
 */
export function isAlreadySorted(keys: readonly SortableCellValue[], direction: SortDirection): boolean {
	const perm = computeSortPermutation(keys, direction);
	for (let i = 0; i < perm.length; i++) {
		if (perm[i] !== i) {
			return false;
		}
	}
	return true;
}

/**
 * The undo-label / toast string for a sort over a rect, e.g. `Sort A->Z: keyed on B over S0!B1:D3`.
 * `direction` picks the `A->Z` / `Z->A` phrasing; `keyColLabel` is the key column's A1 letter; `target` is the
 * formatted A1 range (the command builds it via formatRangeTarget).
 */
export function buildSortUndoLabel(direction: SortDirection, keyColLabel: string, target: string): string {
	const arrow = direction === 'asc' ? 'A->Z' : 'Z->A';
	return `Sort ${arrow}: keyed on ${keyColLabel} over ${target}`;
}

/**
 * The set of key-column CHOICES for a multi-column selection: one per column in the rect, labelled by its A1
 * letter. The command turns these into a QuickPick (single-column selections skip the pick -- the lone column is
 * the key). `col` is the ABSOLUTE column index; `label` is its A1 letter (e.g. `B`).
 */
export interface SortKeyChoice {
	readonly col: number;
	readonly label: string;
}

/** Build the key-column choices for a rect: every column from `startCol` to `endCol` inclusive, A1-labelled. */
export function buildSortKeyChoices(rect: NormalizedRect): SortKeyChoice[] {
	const r = normalizeSelectionRect(rect.startRow, rect.startCol, rect.endRow, rect.endCol);
	const choices: SortKeyChoice[] = [];
	for (let col = r.startCol; col <= r.endCol; col++) {
		choices.push({ col, label: columnLabelA1(col) });
	}
	return choices;
}
