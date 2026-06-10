/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 W1 "Find / Replace All in Workbook" -- the vscode-free core of the workbook-wide find +
// replace-all flow.
//
// The command (in quantbookCommands.ts) reads the focused grid's WHOLE-WORKBOOK snapshot
// (SessionInstance.snapshot() -> WorkbookSnapshotJson, the same DTO the canvas renderer consumes),
// runs it through {@link findHitsInWorkbook} for a hit-list QuickPick, and -- on Replace All --
// turns the same hits into a SessionOpJson[] via {@link buildReplaceAllOps} applied in ONE
// session.batch (one undo unit) -> recalcDirtyChecked -> CellGridPanel.refreshSession. This layer is
// PURE host logic; it never touches the webview and never calls the engine.
//
// **MEGAUDIT GROUND TRUTH (2026-06-10)**: the owning Session does NOT support a flagged columnar read
// -- `queryRange(..., { include_formulas | include_formats | include_rendered: true })` is a HARD
// `[not_implemented_in_v1_core]` error. So we read cell content ONLY from the host-side
// `workbookSnapshot()` result (`WorkbookSnapshotJson`), whose `CellSnapshotJson` carries the raw
// `value` + the `formula` text. The v1 search contract is therefore: search the RAW value text + (when
// the operator opts in) the formula text. We do NOT search the engine-pre-rendered `entry.rendered`
// display string (the "drop search-rendered from v1" plan decision stands -- searching value+formula is
// the locked scope; `rendered` is a display-only concern that would make a search match `$1,234.56`
// when the cell value is `1234.56`).
//
// **Replace semantics (v1, locked)**:
//   - A hit in a cell's RAW VALUE rewrites the cell's value: a literal text replace over the value's
//     string form, re-typed back to a `setValue` op (text stays text; a numeric value whose digits are
//     replaced becomes TEXT, because a partial replace like "100" -> "1X0" is no longer a number -- we
//     never silently coerce, and Excel's Replace likewise turns such a cell into text).
//   - A hit in a cell's FORMULA TEXT (only when `inFormulas` is on) rewrites the formula source via a
//     `setFormula` op (the engine stores the body without the leading `=`; we strip/re-add it).
//   - `inFormulas` OFF: formula cells are searched on their cached VALUE only (what the operator sees),
//     never on the `=...` source -- matching Excel's default "Values" lookin.
//   - A cell can produce AT MOST ONE op per Replace All (value-target XOR formula-target), so the op
//     list has no duplicate (sheet,row,col) and the batch is unambiguous.
//
// No-Fallbacks: a malformed query (empty find text) throws `[bad_argument]`; an over-cap replace
// (> {@link MAX_REPLACE_OPS}) throws `[bad_argument]` BEFORE building a multi-million-op array; a
// snapshot shape the engine could not have produced (non-finite coord) throws rather than silently
// skipping the cell.

import type { CellSnapshotJson, CellValueJson, SessionOpJson, WorkbookSnapshotJson } from '../types';

// Mirror the cellGridLogic batch-cell cap (MAX_BATCH_CELLS = 100_000): a Replace All that would touch
// more than this many cells is refused up front with a clear message, rather than building a giant op
// array the engine would reject later and less clearly. One op == one touched cell, so the op count IS
// the cell count.
export const MAX_REPLACE_OPS = 100_000;

/**
 * The find/replace query the operator builds in the QuickInput flow. `find` is the needle (non-empty;
 * the command's input box rejects an empty string, and {@link findHitsInWorkbook} re-checks). `replace`
 * is the substitution string for Replace All (absent / unused for a find-only run -- the hit list does
 * not need it). The three booleans mirror Excel's Find options:
 *  - `matchCase`: case-SENSITIVE when true; case-INSENSITIVE (default) when false.
 *  - `wholeCell`: the needle must equal the ENTIRE searched string (Excel "Match entire cell contents")
 *    -- a whole-cell match replaces the whole string with `replace`.
 *  - `inFormulas`: when true, formula CELLS are searched on (and replaced in) their `=...` SOURCE TEXT;
 *    when false, every cell is searched on its raw VALUE only (Excel's default "Values" lookin).
 */
export interface FindReplaceQuery {
	readonly find: string;
	readonly replace?: string;
	readonly matchCase: boolean;
	readonly wholeCell: boolean;
	readonly inFormulas: boolean;
}

/**
 * What a single hit matched on: the cell's raw `value` text, or its `formula` source text. Carried on
 * {@link FindHit} so the hit-list UI can show "(formula)" and the replace builder knows which op kind to
 * emit. A cell yields at most one hit per Replace All (value XOR formula), so this is unambiguous.
 */
export type HitField = 'value' | 'formula';

/**
 * One located match. `sheetId` is the engine SheetId (u16 widened); `sheetName` is its display name (for
 * the hit-list label + A1 target). `row`/`col` are 0-based grid coordinates. `field` is what matched.
 * `preview` is the FULL searched string of the matching cell (value or formula source) -- the command
 * truncates/decorates it for the QuickPick label; keeping the full string here makes the core testable
 * without UI-shaping assumptions.
 */
export interface FindHit {
	readonly sheetId: number;
	readonly sheetName: string;
	readonly row: number;
	readonly col: number;
	readonly field: HitField;
	readonly preview: string;
	/**
	 * Whether a Replace All would WRITE to this hit. `false` for a formula cell matched on its cached
	 * VALUE (inFormulas OFF) -- Find lists it (informational) but Replace skips it (a setValue would
	 * clobber the formula). The hit-list UI can flag these so the operator understands why a listed cell
	 * was not replaced.
	 */
	readonly replaceable: boolean;
}

// The A1 grid extent the webview renders (mirrors cellGridLogic's private A1_MAX_ROWS/COLS). A snapshot
// cell outside this is not producible by the engine; we reject it loudly (No-Fallbacks) rather than
// silently skipping a cell or building an op the engine would refuse.
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

/**
 * Reduce a snapshot {@link CellValueJson} to its searchable RAW string -- the same text the operator
 * would type into the cell. `undefined` when the value carries nothing searchable for v1:
 *  - `blank` -- an empty/cleared cell value (it has no text content; a blank cell is never a value hit).
 *  - `pending` -- a formula awaiting evaluation (no cached literal yet; searching it would match an
 *    engine-internal sigil, never operator-visible text).
 *  - `error` -- the cell evaluated to an error sigil (e.g. `#REF!`); v1 does NOT search error text
 *    (replacing inside an error string is meaningless -- the error is recomputed, not stored as text).
 * For `number`/`boolean`/`text` it returns the canonical string form. Numbers use `String(n)` (the
 * engine's own snapshot literal); booleans use the Excel-uppercase `TRUE`/`FALSE` (what a cell shows and
 * what a replace must round-trip). A missing payload for the declared `kind` throws (No-Fallbacks: the
 * engine never emits a `kind` without its payload).
 */
export function valueSearchString(value: CellValueJson | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	switch (value.kind) {
		case 'text':
			if (value.text === undefined) {
				throw new Error('[bad_argument] valueSearchString: a text cell value carried no `text` payload.');
			}
			return value.text;
		case 'number':
			if (value.number === undefined) {
				throw new Error('[bad_argument] valueSearchString: a number cell value carried no `number` payload.');
			}
			return String(value.number);
		case 'boolean':
			if (value.boolean === undefined) {
				throw new Error('[bad_argument] valueSearchString: a boolean cell value carried no `boolean` payload.');
			}
			// Excel/Sheets surface booleans as uppercase TRUE/FALSE; a replace must see + round-trip that form.
			return value.boolean ? 'TRUE' : 'FALSE';
		case 'error':
		case 'pending':
		case 'blank':
			// Not searchable in v1 (see the doc-comment): error sigils are recomputed, pending has no literal,
			// blank has no content.
			return undefined;
		default: {
			// Exhaustiveness guard: a new CellValueJson.kind with no branch is a compile error here AND a loud
			// runtime throw (never a silent "not searchable" default).
			const exhaustive: never = value.kind;
			throw new Error(`[bad_argument] valueSearchString: unknown cell value kind ${String(exhaustive)}.`);
		}
	}
}

/**
 * Whether `needle` occurs in `haystack` under the case + whole-cell options. `wholeCell` makes it an
 * equality test (the entire string must equal the needle, Excel "Match entire cell contents"); otherwise
 * it is a substring test. `matchCase=false` lower-cases both sides first. `needle` is assumed non-empty
 * (the caller validates); an empty needle would make the substring path trivially true, which the
 * command never reaches.
 */
export function matchesCell(haystack: string, needle: string, matchCase: boolean, wholeCell: boolean): boolean {
	const h = matchCase ? haystack : haystack.toLowerCase();
	const n = matchCase ? needle : needle.toLowerCase();
	if (wholeCell) {
		return h === n;
	}
	return h.includes(n);
}

/**
 * Replace EVERY occurrence of `needle` with `replacement` in `haystack` under the case + whole-cell
 * options. `wholeCell` replaces the WHOLE string with `replacement` (it only matched at all if the whole
 * string equalled the needle). Otherwise it is a global substring replace. Case-insensitive substring
 * replace walks the lower-cased haystack to find match positions but splices from the ORIGINAL haystack,
 * so surrounding text keeps its original casing (Excel behavior). The needle is treated as a LITERAL,
 * never a regex (no special-char interpretation) -- this is a literal find/replace, not a pattern one.
 */
export function replaceAllInString(haystack: string, needle: string, replacement: string, matchCase: boolean, wholeCell: boolean): string {
	if (wholeCell) {
		// It only reaches here if matchesCell returned true, i.e. the whole string equalled the needle.
		return replacement;
	}
	if (matchCase) {
		// Literal global replace via split/join (split on a string splits on the literal, not a regex).
		return haystack.split(needle).join(replacement);
	}
	// Case-insensitive literal global replace: scan the lower-cased forms for match offsets, splice the
	// replacement into the ORIGINAL string so untouched characters keep their casing.
	const lowerHay = haystack.toLowerCase();
	const lowerNeedle = needle.toLowerCase();
	let out = '';
	let i = 0;
	while (i < haystack.length) {
		const at = lowerHay.indexOf(lowerNeedle, i);
		if (at === -1) {
			out += haystack.slice(i);
			break;
		}
		out += haystack.slice(i, at) + replacement;
		i = at + lowerNeedle.length;
	}
	return out;
}

/**
 * Validate that a snapshot cell's coordinates are in the A1 grid extent the engine could have produced.
 * Throws `[bad_argument]` (No-Fallbacks) on a non-integer / out-of-extent coordinate rather than silently
 * skipping the cell -- such a cell would mean a corrupt snapshot, which must be surfaced, not hidden.
 */
function assertCellInExtent(sheetId: number, cell: CellSnapshotJson): void {
	if (!Number.isInteger(cell.row) || cell.row < 0 || cell.row >= A1_MAX_ROWS || !Number.isInteger(cell.col) || cell.col < 0 || cell.col >= A1_MAX_COLS) {
		throw new Error(`[bad_argument] findReplace: sheet ${sheetId} cell (row ${cell.row}, col ${cell.col}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}); the workbook snapshot is malformed.`);
	}
}

/**
 * The result of {@link cellSearchTarget}: the searched `text`, the `field` it came from, and whether a
 * Replace All may WRITE to it. `replaceable` is `false` for a formula cell matched on its CACHED VALUE
 * (inFormulas OFF): a `setValue` there would silently CLOBBER the formula -- so Find lists the cell
 * (informational) but Replace SKIPS it. A value hit on a pure-literal cell and a formula-source hit
 * (inFormulas ON) are both replaceable.
 */
export interface CellSearchTarget {
	readonly field: HitField;
	readonly text: string;
	readonly replaceable: boolean;
}

/**
 * Compute the searched string + field + replaceability for ONE snapshot cell under the query's
 * `inFormulas` option, or `undefined` when the cell has nothing to search. The single source of truth
 * shared by {@link findHitsInWorkbook} (to locate hits) and {@link buildReplaceAllOps} (to build the op
 * for the SAME field), so find + replace can never disagree about what a cell matched on.
 *
 * Decision table:
 *  - `inFormulas` ON  + cell HAS formula text -> search the FORMULA SOURCE (the `=...` body, re-prefixed
 *    with `=` so the operator searches/replaces what they'd see in the formula bar). REPLACEABLE (the
 *    replace rewrites the source via setFormula).
 *  - `inFormulas` OFF + cell HAS formula text -> search the cell's cached VALUE (Excel's default "Values"
 *    lookin). NOT replaceable -- the value is derived; a setValue would destroy the formula. Find shows
 *    it; Replace skips it.
 *  - a pure-literal cell (no formula text) -> search the raw VALUE string. REPLACEABLE via setValue.
 */
export function cellSearchTarget(cell: CellSnapshotJson, inFormulas: boolean): CellSearchTarget | undefined {
	if (inFormulas && cell.formula !== undefined) {
		// The engine stores the formula body WITHOUT the leading `=`; surface it WITH `=` so the operator
		// searches the formula bar form (and a replace that touches the leading text behaves intuitively).
		return { field: 'formula', text: `=${cell.formula}`, replaceable: true };
	}
	const valueText = valueSearchString(cell.value);
	if (valueText === undefined) {
		return undefined;
	}
	// A formula cell matched on its CACHED VALUE is searchable but NOT replaceable (No-Fallbacks: never
	// silently clobber a formula with a literal). A pure-literal cell IS replaceable.
	const isFormulaCell = cell.formula !== undefined;
	return { field: 'value', text: valueText, replaceable: !isFormulaCell };
}

/**
 * Scan the WHOLE workbook snapshot for cells matching `query`, returning the hits in a STABLE order:
 * sheet display order (the snapshot already orders `sheets` by `sheet_display_order`), then row-major
 * (row asc, col asc) within each sheet (the snapshot already sorts `cells` by (row, col)). The order is
 * the natural reading order so the hit-list QuickPick + the Replace All op list are deterministic.
 *
 * No-Fallbacks: an empty `find` throws `[bad_argument]` (a zero-length needle would match every cell);
 * a malformed snapshot cell coordinate throws via {@link assertCellInExtent}.
 */
export function findHitsInWorkbook(snapshot: WorkbookSnapshotJson, query: FindReplaceQuery): FindHit[] {
	if (query.find.length === 0) {
		throw new Error('[bad_argument] findHitsInWorkbook: the find text must be non-empty.');
	}
	const hits: FindHit[] = [];
	for (const sheet of snapshot.sheets) {
		for (const cell of sheet.cells) {
			assertCellInExtent(sheet.id, cell);
			const target = cellSearchTarget(cell, query.inFormulas);
			if (target === undefined) {
				continue;
			}
			if (matchesCell(target.text, query.find, query.matchCase, query.wholeCell)) {
				hits.push({
					sheetId: sheet.id,
					sheetName: sheet.name,
					row: cell.row,
					col: cell.col,
					field: target.field,
					preview: target.text,
					replaceable: target.replaceable,
				});
			}
		}
	}
	return hits;
}

/**
 * Build the `SessionOpJson[]` for a Replace All over `query`, applied by the command in ONE
 * `session.batch(...)` (one undo unit). Re-derives the hits from the SAME snapshot + the SAME
 * {@link cellSearchTarget} logic as {@link findHitsInWorkbook} (so find + replace agree), then turns each
 * hit into exactly one op for its field:
 *  - a `formula` hit -> a `setFormula` op carrying the replaced source with the leading `=` STRIPPED (the
 *    engine stores the body without it); an empty post-strip body throws (No-Fallbacks: a formula that
 *    replaced down to bare `=` is invalid -- the operator must not silently produce a broken cell).
 *  - a `value` hit -> a `setValue` op. If the ORIGINAL value was a number AND the replaced string still
 *    parses as the SAME-form finite number, the op stays `number`; otherwise the op is `text` (a partial
 *    replace like "100" -> "1X0" is no longer a number, so the cell becomes text -- Excel does the same).
 *    A boolean/text value always re-types as text after replace (a replaced boolean string is no longer a
 *    canonical TRUE/FALSE the engine would re-parse as a bool; storing it as text is faithful + lossless).
 *
 * `query.replace` defaults to the empty string when absent (Replace All with an empty replacement DELETES
 * the matched substring -- a valid Excel operation). The op list has at most one op per (sheet,row,col).
 *
 * No-Fallbacks: an empty `find` throws; an op count over {@link MAX_REPLACE_OPS} throws BEFORE the array
 * is built out (the loop checks as it grows so a runaway is caught early); a malformed coordinate throws.
 */
export function buildReplaceAllOps(snapshot: WorkbookSnapshotJson, query: FindReplaceQuery): SessionOpJson[] {
	if (query.find.length === 0) {
		throw new Error('[bad_argument] buildReplaceAllOps: the find text must be non-empty.');
	}
	const replacement = query.replace ?? '';
	const ops: SessionOpJson[] = [];
	for (const sheet of snapshot.sheets) {
		// Sheet ids are u16 in the engine; a snapshot carrying a non-u16 id is malformed (we never trust it).
		if (!Number.isInteger(sheet.id) || sheet.id < 0 || sheet.id > 65535) {
			throw new Error(`[bad_argument] buildReplaceAllOps: sheet id ${sheet.id} is outside the u16 range; the workbook snapshot is malformed.`);
		}
		for (const cell of sheet.cells) {
			assertCellInExtent(sheet.id, cell);
			const target = cellSearchTarget(cell, query.inFormulas);
			if (target === undefined) {
				continue;
			}
			if (!matchesCell(target.text, query.find, query.matchCase, query.wholeCell)) {
				continue;
			}
			if (!target.replaceable) {
				// A formula cell matched on its cached VALUE (inFormulas OFF): Find lists it but Replace must
				// NOT clobber the formula with a literal. Skip it (No-Fallbacks: never a silent destructive
				// write). Turn on "Search in formulas" to replace the formula source instead.
				continue;
			}
			const replaced = replaceAllInString(target.text, query.find, replacement, query.matchCase, query.wholeCell);
			if (ops.length >= MAX_REPLACE_OPS) {
				throw new Error(`[bad_argument] buildReplaceAllOps: a Replace All matching more than ${MAX_REPLACE_OPS} cells is refused (narrow the find text or use a smaller selection).`);
			}
			ops.push(opForReplacedCell(sheet.id, cell, target.field, replaced));
		}
	}
	return ops;
}

/**
 * Build the single op that writes `replaced` back into `cell` for `field`. Pure + exported for direct
 * unit testing (the value-vs-text re-typing decision is the subtle part). See {@link buildReplaceAllOps}
 * for the field/typing rules.
 */
export function opForReplacedCell(sheet: number, cell: CellSnapshotJson, field: HitField, replaced: string): SessionOpJson {
	if (field === 'formula') {
		// Strip the leading `=` the search form carried; the engine stores the body without it.
		const body = replaced.startsWith('=') ? replaced.slice(1) : replaced;
		if (body.length === 0) {
			throw new Error(`[bad_argument] opForReplacedCell: sheet ${sheet} cell (${cell.row},${cell.col}) replaced its formula down to an empty body -- refusing to write a broken formula.`);
		}
		return { kind: 'setFormula', sheet, row: cell.row, col: cell.col, text: body };
	}
	// A value hit. Preserve a numeric type ONLY when the original was a number AND the replaced string is
	// still that same finite number's canonical form (so "1234" untouched stays a number, but "1234" ->
	// "1X34" becomes text). Everything else re-types as text -- never a silent coercion.
	if (cell.value !== undefined && cell.value.kind === 'number') {
		const parsed = Number(replaced);
		if (replaced.trim().length > 0 && Number.isFinite(parsed) && String(parsed) === replaced) {
			return { kind: 'setValue', sheet, row: cell.row, col: cell.col, value: { kind: 'number', number: parsed } };
		}
	}
	return { kind: 'setValue', sheet, row: cell.row, col: cell.col, value: { kind: 'text', text: replaced } };
}
