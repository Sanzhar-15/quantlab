/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-3 colored references (grid ref-highlighting) -- the PURE, vscode/DOM-free core that locates each
// distinct cell/range reference a formula reads, AS A RANGE-AWARE, COLOR-ASSIGNED, TEXT-OFFSET-BEARING
// list, so the renderer can outline each referenced range on the grid with its own color (Excel's
// colored boxes while you edit a formula). It is a sibling of `extractFormulaRefs.ts` -- it shares that
// module's hardened single-pass TOKENIZER skeleton (the audited helpers `matchRefAt`,
// `unquotedSheetNameEnd`, `quotedSheetNameEnd`, `consumeExternalRefBody`, and the string/quoted-sheet/
// `[...]` skips) -- but differs in THREE ways the colored-box use needs and `extractFormulaRefs` cannot
// give:
//   1. it keeps a RANGE intact -- `A1:B2` is ONE highlight (one box), not two endpoint cells, so a range
//      paints as a single outlined rect (extractFormulaRefs flattens it into two endpoints);
//   2. it carries the `[start, end)` SOURCE-TEXT span of each ref (for a future formula-text-coloring
//      wave; the grid v1 ignores it);
//   3. it assigns a stable COLOR INDEX per distinct DRAWABLE target (identical target -> same color, a
//      distinct target -> the next color), so the renderer paints Excel's rotating ref colors.
//
// WHY A NEW FILE (not an `extractFormulaRefs` change): that module feeds the dep-graph / clipboard / F4
// PERSISTENCE paths (the FE-8.6 escape-char-corruption history); changing its contract risks those. The
// FE-3 range-pick wave set the precedent with its own pure sibling `formulaRangePick.ts`. The tokenizer
// skeleton is mirrored BY VALUE (the same audited helpers inlined) and pinned by an exhaustive edge-case
// test suite mirroring the `extractFormulaRefs` corpus, so the two cannot silently drift.
//
// No-Fallbacks: like `extractFormulaRefs`, this is a TOTAL single-pass tokenizer over a body the engine
// already validated (the editor's live text; the engine rejects a malformed formula at `setFormula`). It
// cannot both stay total AND report malformedness, so on a malformed body (an unterminated `"`/`'`/`[`)
// it scans the unterminated construct to EOF without throwing -- matching `extractFormulaRefs`. It never
// guesses a coordinate: a ref it cannot map to a same-sheet cell rect (a sheet-QUALIFIED ref, or a
// whole-column/row/structured token that is not a cell ref at all) is returned with `rect: null` +
// `colorIndex: -1`, never a fabricated box.
//
// SCOPE (v1, GRID-ONLY, UNQUALIFIED-ONLY): only UNQUALIFIED single-cell + range refs get a drawable rect.
// A sheet-qualified ref (`Sheet2!A1`, `'My Sheet'!A1:B2`) -- even one naming the current sheet -- is
// returned with `rect: null` (drawing it correctly needs engine-equivalent sheet-name equality:
// quotes / ASCII case-fold / `''` escapes, a correctness minefield deferred to a later wave). An
// unqualified ref ALWAYS targets the sheet being edited, so it needs no sheet context -- which is why
// this module takes none.

import { MAX_COLS, MAX_ROWS, type SelectionRect } from './gridLayoutA1';

// --- Tokenizer skeleton, mirrored BY VALUE from extractFormulaRefs.ts (audited helpers; keep in lockstep) ---

function isLetter(ch: string | undefined): boolean {
	if (ch === undefined) {
		return false;
	}
	const c = ch.charCodeAt(0);
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isDigit(ch: string | undefined): boolean {
	if (ch === undefined) {
		return false;
	}
	const c = ch.charCodeAt(0);
	return c >= 48 && c <= 57;
}

function isAlnum(ch: string | undefined): boolean {
	return isLetter(ch) || isDigit(ch);
}

/** Lexer-whitespace: the exact ASCII set the engine lexer skips (space/tab/LF/CR -- NOT Unicode space). */
function isLexWhitespace(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Index of the first non-lexer-whitespace char at/after `i` (skips `space/tab/LF/CR`). */
function skipLexWhitespace(s: string, i: number): number {
	let k = i;
	while (k < s.length && isLexWhitespace(s[k])) {
		k += 1;
	}
	return k;
}

/**
 * Column letters -> 0-based column index (bijective base-26): "A" -> 0, "Z" -> 25, "AA" -> 26,
 * "XFD" -> 16383. Returns -1 for an empty or non-letter input. Identical to the `extractFormulaRefs` +
 * webview `a1FormulaRefs` helper (shared by value -- `gridLayoutA1` does not export it, so it is
 * replicated here and pinned by the same tests).
 */
function colLettersToIndex(letters: string): number {
	if (letters.length === 0) {
		return -1;
	}
	let n = 0;
	for (let i = 0; i < letters.length; i += 1) {
		const c = letters.charCodeAt(i);
		const v = c >= 65 && c <= 90 ? c - 64 : c >= 97 && c <= 122 ? c - 96 : 0;
		if (v === 0) {
			return -1;
		}
		n = n * 26 + v;
	}
	return n - 1;
}

interface RefMatch {
	readonly colIndex: number;
	readonly rowIndex: number;
	readonly end: number; // index in the source just past the matched ref
}

/**
 * Try to match a single A1 cell reference at `i`: an optional `$`, 1-3 column letters (XFD is the widest
 * valid column), an optional `$`, then 1-7 row digits. Returns `null` when the text at `i` is not a clean,
 * in-extent reference -- crucially when MORE than 3 letters lead (a sheet/function/name like "Sheet1" or
 * "SUM"). The caller additionally rejects a match glued to an identifier or immediately followed by `(` (a
 * function call). Byte-for-byte the `extractFormulaRefs` / webview `matchRefAt` (the `$`-anchoring is
 * accepted + ignored here -- `$A$1` and `A1` target the same cell, so they share a rect + color).
 */
function matchRefAt(s: string, i: number): RefMatch | null {
	let j = i;
	if (s[j] === '$') {
		j += 1;
	}
	const colStart = j;
	while (j < s.length && isLetter(s[j]) && j - colStart < 3) {
		j += 1;
	}
	if (j - colStart === 0) {
		return null; // no column letters
	}
	if (isLetter(s[j])) {
		return null; // a 4th letter -> this is a longer identifier (sheet/function/name), not a column
	}
	const colEnd = j; // the char after the last column letter (before any row `$`)
	if (s[j] === '$') {
		j += 1;
	}
	const rowStart = j;
	while (j < s.length && isDigit(s[j]) && j - rowStart < 7) {
		j += 1;
	}
	if (j - rowStart === 0) {
		return null; // no row digits
	}
	if (isDigit(s[j])) {
		return null; // an 8th digit -> beyond MAX_ROWS' width, not a row
	}
	const colIndex = colLettersToIndex(s.slice(colStart, colEnd));
	const rowIndex = Number(s.slice(rowStart, j)) - 1;
	if (colIndex < 0 || colIndex >= MAX_COLS) {
		return null;
	}
	if (rowIndex < 0 || rowIndex >= MAX_ROWS) {
		return null;
	}
	return { colIndex, rowIndex, end: j };
}

/**
 * If an UNQUOTED sheet-name qualifier starts at `i` -- a run of sheet-name-legal chars `[A-Za-z0-9_.]`,
 * then OPTIONAL ASCII whitespace, then `!` -- return the index of that `!`; else -1. Mirrors the engine
 * LEXER (`try_lex_sheet_name_prefix`): lex a name, skip whitespace before `!`, require `!`. The caller
 * invokes this only at a letter / `_` and never at a `$`.
 */
function unquotedSheetNameEnd(s: string, i: number): number {
	let j = i;
	while (j < s.length && (isAlnum(s[j]) || s[j] === '_' || s[j] === '.')) {
		j += 1;
	}
	if (j === i) {
		return -1; // no sheet-name run
	}
	const k = skipLexWhitespace(s, j);
	if (s[k] === '!') {
		return k;
	}
	return -1;
}

/**
 * If a QUOTED sheet-name qualifier starts at `i` (a `'...'` run with `''` as an escaped quote), then
 * OPTIONAL ASCII whitespace, then `!`, return the index of that `!`; else -1. The caller invokes this
 * only when `s[i] === '\''`.
 */
function quotedSheetNameEnd(s: string, i: number): number {
	if (s[i] !== '\'') {
		return -1;
	}
	let j = i + 1;
	while (j < s.length) {
		if (s[j] === '\'') {
			if (s[j + 1] === '\'') {
				j += 2; // an escaped '' inside the name
				continue;
			}
			j += 1; // closing quote consumed
			break;
		}
		j += 1;
	}
	const k = skipLexWhitespace(s, j);
	if (s[k] === '!') {
		return k;
	}
	return -1;
}

/**
 * If an EXTERNAL-workbook reference body directly abuts position `i` (right after a leading `[...]`
 * bracket) -- a `<sheet>!<cell>` qualified ref, or a bare `<cell>`, optionally a `:`-range -- return the
 * index PAST it; else -1. Used to CONSUME (not highlight) an external ref's cell part: `[1]Sheet1!A1`
 * points into ANOTHER workbook, so it is never a same-sheet box. Byte-for-byte `extractFormulaRefs`.
 */
function consumeExternalRefBody(s: string, i: number): number {
	const ch = s[i];
	if (ch === undefined) {
		return -1;
	}
	let cellStart = -1;
	if (ch === '\'') {
		const sheetEnd = quotedSheetNameEnd(s, i);
		if (sheetEnd >= 0) {
			cellStart = skipLexWhitespace(s, sheetEnd + 1);
		}
	} else if (isLetter(ch) || ch === '_') {
		const sheetEnd = unquotedSheetNameEnd(s, i);
		if (sheetEnd >= 0) {
			cellStart = skipLexWhitespace(s, sheetEnd + 1);
		}
	}
	const refStart = cellStart >= 0 ? cellStart : i;
	const m = matchRefAt(s, refStart);
	if (m === null) {
		return -1;
	}
	const after = s[m.end];
	if (isAlnum(after) || after === '_' || after === '(') {
		return -1;
	}
	let end = m.end;
	const colon = skipLexWhitespace(s, end);
	if (s[colon] === ':') {
		const rhsStart = skipLexWhitespace(s, colon + 1);
		const rhs = matchRefAt(s, rhsStart);
		if (rhs !== null) {
			const rhsAfter = s[rhs.end];
			if (!(isAlnum(rhsAfter) || rhsAfter === '_' || rhsAfter === '(')) {
				end = rhs.end;
			}
		}
	}
	return end;
}

// --- The colored-highlight result + the range-aware emitter ---------------------------------------

/**
 * One reference highlight extracted from a formula -- a single cell or a range, plus its source-text span,
 * its grid rect, and its color slot.
 *   - `start`/`end` are the half-open `[start, end)` offsets of the reference's SOURCE TEXT (incl. a sheet
 *     qualifier, incl. both endpoints of a range), for a future formula-text-coloring wave. The grid v1
 *     ignores them.
 *   - `rect` is the normalized inclusive grid rect of an UNQUALIFIED same-sheet cell/range (a single cell
 *     is `min === max` on both axes; a range `A1:B2` is one rect spanning both endpoints), or `null` for a
 *     ref this v1 cannot map to a same-sheet box (a sheet-QUALIFIED ref). `$`-anchoring is ignored (`$A$1`
 *     and `A1` share a rect).
 *   - `colorIndex` is the 0-based slot of this reference's DISTINCT target in appearance order (an identical
 *     target reuses its slot -> same color; `A1` and `$A$1` and `A1:A1` all share a slot), or `-1` for a
 *     non-drawable ref (`rect === null`). It is UNBOUNDED (it keeps climbing past any palette size); the
 *     renderer takes it modulo its palette length, so the module never needs to know the palette.
 *   - `raw` is the verbatim source slice `text.slice(start, end)`.
 */
export interface RefHighlight {
	readonly start: number;
	readonly end: number;
	readonly rect: SelectionRect | null;
	readonly colorIndex: number;
	readonly raw: string;
}

/** Stable key for a normalized rect, so identical targets (incl. `$A$1` vs `A1`, `A1` vs `A1:A1`) collide. */
function rectKey(rect: SelectionRect): string {
	return rect.minRow + ',' + rect.minCol + ',' + rect.maxRow + ',' + rect.maxCol;
}

/**
 * Locate every cell/range reference an EDITED formula reads, range-aware + color-assigned, for the grid's
 * colored-box highlighting (Excel point-mode coloring).
 *
 * `text` is the LIVE editor value (with its leading `=`). Returns `[]` when `text` is empty or is not a
 * formula (`text[0] !== '='`) -- a plain value is never highlighted. Otherwise it runs the same single-pass
 * tokenizer as `extractFormulaRefs` (skipping string literals, quoted sheet names, `[...]` structured /
 * external refs, function names, number literals), but emits ONE {@link RefHighlight} per reference --
 * grouping a `A1:B2` range into a single rect, carrying each ref's text span, and assigning a stable color
 * slot per distinct DRAWABLE target.
 *
 * Drawable (`rect` non-null, `colorIndex >= 0`): an UNQUALIFIED single cell (`A1`, `$A$1`) or range
 * (`A1:B2`). Non-drawable (`rect: null`, `colorIndex: -1`, still RETURNED so the contract is testable): a
 * sheet-qualified ref (`Sheet2!A1`, `'My Sheet'!A1:B2`). A whole-column/row (`A:A`, `1:1`), a structured
 * ref (`T[Col]`), an external ref (`[1]S!A1`), and a defined NAME are NOT cell references, so they yield NO
 * highlight at all (the tokenizer never matches them as a ref). Pure + total (never throws).
 *
 * KNOWN v1 LIMITATION (documented, deferred): a defined name shaped exactly like a cell (a name "Q1") is
 * not distinguishable from cell Q1 without the engine name table, so it may be boxed at that coordinate --
 * the same contract limitation `extractFormulaRefs` carries.
 */
export function computeFormulaRefHighlights(text: string): RefHighlight[] {
	if (text.length === 0 || text[0] !== '=') {
		return []; // not a formula -> no highlights
	}
	const out: RefHighlight[] = [];
	const colorByTarget = new Map<string, number>();
	let nextColorIndex = 0;
	let i = 0;
	const n = text.length;

	/**
	 * Emit one highlight for a reference whose LEFT (or only) endpoint matched at `startIdx` with `m`, and
	 * whose sheet qualifier is `sheetText` (undefined for a bare ref). Peeks for a `:`-range right endpoint
	 * (always a BARE cell -- the engine grammar qualifies only the left side, `Sheet1!A1:B2`); if found and
	 * not glued to a trailing identifier, the highlight spans the whole range as ONE rect. A QUALIFIED ref
	 * (sheetText set) is emitted with `rect: null` (v1 draws unqualified only). Returns the source index
	 * just past the whole reference (the right endpoint's end for a range, else `m.end`).
	 */
	const emit = (startIdx: number, sheetText: string | undefined, m: RefMatch): number => {
		// Consume a CHAIN of `:<bare ref>` endpoints into ONE bounding-box highlight, tracking min/max across
		// every endpoint (so a reversed `B2:A1` and a chained `A1:B2:C3` both normalize correctly). A simple
		// range is one `:`; the chain handles Excel's `:` range operator applied repeatedly (`A1:B2:C3` is the
		// bounding box A1:C3). The whole chain SHARES the START's sheet qualifier (the engine grammar qualifies
		// only the left side -- `Sheet1!A1:B2`), so `Sheet1!A1:B2:C3` is ONE non-drawable highlight; a later
		// bare endpoint must NOT leak out as a spurious current-sheet box (the audit fix). Each right endpoint
		// is a BARE cell; a glued / `(`-followed match (`A1:B2foo`) ends the chain (not a clean range endpoint).
		let minRow = m.rowIndex;
		let maxRow = m.rowIndex;
		let minCol = m.colIndex;
		let maxCol = m.colIndex;
		let rawEnd = m.end;
		let cursor = m.end;
		for (; ;) {
			const colon = skipLexWhitespace(text, cursor);
			if (text[colon] !== ':') {
				break;
			}
			const rhsStart = skipLexWhitespace(text, colon + 1);
			const rhs = matchRefAt(text, rhsStart);
			if (rhs === null) {
				break;
			}
			const after = text[rhs.end];
			if (isAlnum(after) || after === '_' || after === '(') {
				break;
			}
			minRow = Math.min(minRow, rhs.rowIndex);
			maxRow = Math.max(maxRow, rhs.rowIndex);
			minCol = Math.min(minCol, rhs.colIndex);
			maxCol = Math.max(maxCol, rhs.colIndex);
			rawEnd = rhs.end;
			cursor = rhs.end;
		}
		const rect: SelectionRect = { minRow, maxRow, minCol, maxCol };
		if (sheetText !== undefined) {
			// QUALIFIED ref -- v1 cannot safely map a sheet name to "the sheet being edited" (sheet-name
			// equality is a deferred correctness minefield). Returned non-drawable so the contract is testable.
			out.push({ start: startIdx, end: rawEnd, rect: null, colorIndex: -1, raw: text.slice(startIdx, rawEnd) });
			return rawEnd;
		}
		const key = rectKey(rect);
		let ci = colorByTarget.get(key);
		if (ci === undefined) {
			ci = nextColorIndex;
			nextColorIndex += 1;
			colorByTarget.set(key, ci);
		}
		out.push({ start: startIdx, end: rawEnd, rect, colorIndex: ci, raw: text.slice(startIdx, rawEnd) });
		return rawEnd;
	};

	while (i < n) {
		const ch = text[i];
		// 0. Bracketed structured / external reference -- the text inside `[...]` is a column/workbook token,
		// not an A1 cell ref. Skip it verbatim, depth-counted (with the FE-8.6 `'X` OOXML escape so an
		// unbalanced `[`/`]` in a column name cannot mis-count depth). Then drop a whole EXTERNAL ref body.
		if (ch === '[') {
			let depth = 0;
			while (i < n) {
				if (text[i] === '\'') {
					i += 2;
					continue;
				}
				if (text[i] === '[') {
					depth += 1;
				} else if (text[i] === ']') {
					depth -= 1;
					if (depth === 0) {
						i += 1;
						break;
					}
				}
				i += 1;
			}
			const ext = consumeExternalRefBody(text, i);
			if (ext >= 0) {
				i = ext;
			}
			continue;
		}
		// 1. Double-quoted string literal -- skip verbatim (`""` is an escaped quote). No refs inside.
		if (ch === '"') {
			i += 1;
			while (i < n) {
				if (text[i] === '"') {
					if (text[i + 1] === '"') {
						i += 2;
						continue;
					}
					i += 1;
					break;
				}
				i += 1;
			}
			continue;
		}
		// 2. Single-quoted sheet name -- only a sheet qualifier (`'name'!A1`) or a stray quoted token; the
		// text inside the quotes is never an A1 ref. Read it as a `'sheet'!<cellref>` qualifier; on success,
		// emit the following cell ref as a QUALIFIED (non-drawable) highlight.
		if (ch === '\'') {
			const sheetEnd = quotedSheetNameEnd(text, i);
			if (sheetEnd >= 0) {
				const afterBang = sheetEnd + 1;
				const cellStart = skipLexWhitespace(text, afterBang);
				const m = matchRefAt(text, cellStart);
				if (m !== null) {
					const after = text[m.end];
					if (!(isAlnum(after) || after === '_' || after === '(')) {
						// `start` is the opening quote `i` (the verbatim ref incl. its sheet qualifier).
						i = emit(i, text.slice(i, sheetEnd), m);
						continue;
					}
				}
				i = afterBang; // `'sheet'!` with no clean cell after it -- skip past `!`, scan the rest normally
				continue;
			}
			// An unterminated / non-qualifier quoted token -- skip the quoted run verbatim (no refs inside).
			i += 1;
			while (i < n) {
				if (text[i] === '\'') {
					if (text[i + 1] === '\'') {
						i += 2;
						continue;
					}
					i += 1;
					break;
				}
				i += 1;
			}
			continue;
		}
		// 3. A letter, `_`, or `$` may begin a cell reference (or an unquoted sheet qualifier).
		if (isLetter(ch) || ch === '_' || ch === '$') {
			// 3a. An UNQUOTED sheet-name qualifier (`Sheet1!A1`, dotted `Q1.2024!A1`, padded `S1 !A1`). A
			// `$`-led token can never be a sheet name; a `_`-led token can ONLY be a sheet name.
			if (ch !== '$') {
				const sheetEnd = unquotedSheetNameEnd(text, i);
				if (sheetEnd >= 0) {
					const afterBang = sheetEnd + 1;
					const cellStart = skipLexWhitespace(text, afterBang);
					const m = matchRefAt(text, cellStart);
					if (m !== null) {
						const after = text[m.end];
						if (!(isAlnum(after) || after === '_' || after === '(')) {
							i = emit(i, text.slice(i, sheetEnd), m);
							continue;
						}
					}
					i = afterBang; // sheet qualifier present, no clean cell after it -- skip past `!`
					continue;
				}
			}
			// 3b. A bare (same-sheet) cell ref. A `_`-led token cannot be a cell ref (handled above), so
			// matchRefAt at `_` correctly returns null and we fall through to the identifier-run skip.
			const m = matchRefAt(text, i);
			if (m !== null) {
				const after = text[m.end];
				if (!(isAlnum(after) || after === '_' || after === '(')) {
					i = emit(i, undefined, m);
					continue;
				}
			}
			// Otherwise consume a maximal identifier run verbatim so a ref is never re-scanned inside it.
			i += 1;
			while (i < n && (isAlnum(text[i]) || text[i] === '_' || text[i] === '$')) {
				i += 1;
			}
			continue;
		}
		// 4. A number literal -- skip verbatim so a digit never seeds a ref scan; consume a trailing exponent.
		if (isDigit(ch)) {
			i += 1;
			while (i < n && (isDigit(text[i]) || text[i] === '.')) {
				i += 1;
			}
			if (text[i] === 'e' || text[i] === 'E') {
				const sign = text[i + 1] === '+' || text[i + 1] === '-' ? 1 : 0;
				if (isDigit(text[i + 1 + sign])) {
					i += 1 + sign;
					while (i < n && isDigit(text[i])) {
						i += 1;
					}
				}
			}
			continue;
		}
		// 5. Anything else (operators, `!`, `:`, commas, spaces, parens, the leading `=`) -- skip one char.
		i += 1;
	}
	return out;
}
