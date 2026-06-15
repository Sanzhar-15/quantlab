/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 B3 dependency-graph sidebar -- the vscode-free core that EXTRACTS the A1 cell references a formula
// reads (its direct precedents). It is the read-only twin of the webview `translateFormulaRefs`
// (a1FormulaRefs.ts), which SHIFTS refs for copy/paste/fill: this one does not rewrite anything, it
// enumerates the refs so the dep-graph can show "B2 reads A1, Sheet2!C3". It deliberately shares that
// module's single-pass TOKENIZER skeleton, NOT a global regex (the tokenizer family has a 3-HIGH-bug
// history -- a blind regex corrupts string literals, quoted/whitespace sheet names, dotted ref-shaped
// sheet names, and function names that look like cells). Every protection translateFormulaRefs grew
// (Codex HIGH-3, the dotted-sheet-name HIGH, and the whitespace-before-`!` HIGH) is mirrored here so the
// two stay in lockstep; the edge-case test suite mirrors a1FormulaRefs' suite one-for-one.
//
// PROMOTION NOTE: the frozen-panes workstream is promoting `a1FormulaRefs.ts` + `gridLayoutA1.ts` from
// `webview/sheets-webview/` into THIS `src/quantbook/shared/` directory. This file is additive (a NEW
// export the W3 brief requires) and shares the tokenizer skeleton by VALUE (it inlines the same small A1
// constants + scan helpers rather than importing the not-yet-promoted module), so it compiles standalone
// today and stays non-conflicting with that promotion. Once `gridLayoutA1.ts` lands here, the inlined
// `MAX_COLS`/`MAX_ROWS`/`colLettersToIndex` can be re-pointed at it without changing this file's behaviour.

/** Excel column count (0-based cols `[0, MAX_COLS)`; the last column 16,383 is "XFD"). */
const MAX_COLS = 16_384;

/** Excel row count (0-based rows `[0, MAX_ROWS)`; the bottom row is 1,048,575). */
const MAX_ROWS = 1_048_576;

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
 * Strip trailing lexer-whitespace from a sheet-qualifier slice. The slice `formula.slice(i, sheetEnd)` ends
 * at the `!`, so for a whitespace-padded qualifier (`S0 !`, `'My Sheet' !`) it carries the padding spaces.
 * That whitespace is lexer padding, NOT part of the sheet NAME, so consumers comparing the name (cross-sheet
 * detection) must not see it. Returns the SEMANTIC sheet text (quotes, if any, preserved -- the consumer
 * strips those); `S0 ` -> `S0`, `'My Sheet' ` -> `'My Sheet'`. Pure.
 */
function trimTrailingLexWhitespace(s: string): string {
	let end = s.length;
	while (end > 0 && isLexWhitespace(s[end - 1])) {
		end -= 1;
	}
	return s.slice(0, end);
}

/**
 * Column letters -> 0-based column index (bijective base-26): "A" -> 0, "Z" -> 25, "AA" -> 26,
 * "XFD" -> 16383. Returns -1 for an empty or non-letter input (defensive; callers pass a scanned run).
 * Identical to the webview a1FormulaRefs helper (shared by value -- see the PROMOTION NOTE above).
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

/**
 * One A1 cell reference extracted from a formula. Coordinates are 0-based (`row 0`/`col 0` = `A1`),
 * matching the engine snapshot + the dep-graph's coordinate space. `sheet` is the SEMANTIC sheet-name
 * qualifier WITHOUT the trailing `!` and WITHOUT any lexer whitespace before the `!` (e.g. `"Sheet2"`,
 * `"S1"`, `"Q1.2024"`, or a quoted `"'My Sheet'"` -- quotes preserved, the consumer strips them), or
 * `undefined` for an unqualified ref on the same sheet. For a range like `Sheet2!A1:B2`, the right endpoint
 * `B2` INHERITS `Sheet2` (both endpoints live on the qualified sheet). `colAbs`/`rowAbs` record `$`-anchoring
 * (kept so a future "absolute precedent" badge can distinguish `$A$1` from `A1`; the dep-graph v1 ignores
 * them). `raw` is the exact verbatim source slice of THIS endpoint (its own sheet qualifier if it had one;
 * an inherited sheet is NOT re-inserted into `raw`), so the UI can show what was typed.
 */
export interface FormulaRef {
	/** Semantic sheet-name qualifier (no trailing `!`, no lexer whitespace), or undefined for a same-sheet ref. */
	readonly sheet?: string;
	/** 0-based row index (`A1` -> 0). Always in `[0, MAX_ROWS)`. */
	readonly row: number;
	/** 0-based column index (`A1` -> 0). Always in `[0, MAX_COLS)`. */
	readonly col: number;
	/** True if the column was `$`-anchored (`$A1`). */
	readonly colAbs: boolean;
	/** True if the row was `$`-anchored (`A$1`). */
	readonly rowAbs: boolean;
	/** The exact source text of this reference (incl. any sheet qualifier), e.g. `"Sheet2!$A1"`. */
	readonly raw: string;
}

interface RefMatch {
	readonly colAbs: boolean;
	readonly colIndex: number;
	readonly rowAbs: boolean;
	readonly rowIndex: number;
	readonly end: number; // index in the source just past the matched ref
}

/**
 * Try to match a single A1 cell reference at `i`: an optional `$`, 1-3 column letters (XFD is the widest
 * valid column), an optional `$`, then 1-7 row digits. Returns `null` when the text at `i` is not a clean,
 * in-extent reference -- crucially when MORE than 3 letters lead (a sheet/function/name like "Sheet1" or
 * "SUM"), so those are never mistaken for a column. The caller additionally rejects a match glued to an
 * identifier or immediately followed by `(` (a function call). Byte-for-byte the webview matchRefAt.
 */
function matchRefAt(s: string, i: number): RefMatch | null {
	let j = i;
	let colAbs = false;
	if (s[j] === '$') {
		colAbs = true;
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
	let rowAbs = false;
	if (s[j] === '$') {
		rowAbs = true;
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
	return { colAbs, colIndex, rowAbs, rowIndex, end: j };
}

/**
 * If an UNQUOTED sheet-name qualifier starts at `i` -- a run of sheet-name-legal chars `[A-Za-z0-9_.]`,
 * then OPTIONAL ASCII whitespace, then `!` -- return the index of that `!` (the exclusive end of the
 * qualifier text); else -1. Mirrors the engine LEXER, NOT the printer (`try_lex_sheet_name_prefix`):
 * lex a `[A-Za-z_][A-Za-z0-9_.]*` name, skip whitespace between the name and `!` (design section 4.3),
 * require `!`. We match the LEXER because the engine stores a formula's text VERBATIM (the printer is not
 * exposed at napi), so `S1!A1`, `Q1.2024!A1`, AND a whitespace-padded `S1 !A1` each reach a snapshot
 * exactly as typed. Omitting the dotted-name look-past or the whitespace skip would mis-extract a
 * ref-shaped sheet name (`S1`/`Q1`; the product seeds S0/S1/S2) as a same-sheet cell ref (the exact two
 * HIGH bugs the webview twin fixed). The caller invokes this only at a letter and never at a `$`.
 */
function unquotedSheetNameEnd(s: string, i: number): number {
	let j = i;
	while (j < s.length && (isAlnum(s[j]) || s[j] === '_' || s[j] === '.')) {
		j += 1;
	}
	if (j === i) {
		return -1; // no sheet-name run
	}
	// Skip ASCII whitespace between the name and `!` (lexer section 4.3; engine stores it verbatim).
	const k = skipLexWhitespace(s, j);
	if (s[k] === '!') {
		return k;
	}
	return -1;
}

/**
 * If a QUOTED sheet-name qualifier starts at `i` (a `'...'` run with `''` as an escaped quote), then
 * OPTIONAL ASCII whitespace, then `!`, return the index of that `!` (exclusive end of the qualifier); else
 * -1. `'My Sheet'!A1` and `'Q1 data'!A1` are the cases: a space-bearing or otherwise-illegal-unquoted name
 * is single-quoted, and an A1-shaped substring INSIDE the quotes (`'Q1 data'`) must never be read as a ref.
 * The whitespace-before-`!` skip mirrors the unquoted path (the lexer accepts it the same way). The caller
 * invokes this only when `s[i] === '\''`.
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
	// `j` is just past the closing quote (or at end-of-string for an unterminated quote -> no `!` follows).
	const k = skipLexWhitespace(s, j);
	if (s[k] === '!') {
		return k;
	}
	return -1;
}

/**
 * If an EXTERNAL-workbook reference body directly abuts position `i` (right after a leading `[...]` bracket)
 * -- a `<sheet>!<cell>` qualified ref, or a bare `<cell>` -- return the index PAST it (including a `:`-range
 * right endpoint, e.g. `[1]Sheet1!A1:B2`); else -1 (no ref abuts the bracket). Used to CONSUME (not emit) an
 * external ref's cell part: `[1]Sheet1!A1` points into ANOTHER workbook, so its cell is NOT a local
 * precedent. The match must be IMMEDIATE (no operator/whitespace gap that would make the next token an
 * independent local ref). Pure; reuses the same sheet-qualifier + cell scanners as the main loop.
 */
function consumeExternalRefBody(s: string, i: number): number {
	const ch = s[i];
	if (ch === undefined) {
		return -1;
	}
	// A quoted or unquoted sheet qualifier directly after the bracket: `[1]'My Sheet'!A1` / `[1]Sheet1!A1`.
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
	// Either a qualified ref (cellStart set) or a bare cell ref directly after the bracket (`[1]A1`).
	const refStart = cellStart >= 0 ? cellStart : i;
	const m = matchRefAt(s, refStart);
	if (m === null) {
		return -1;
	}
	const after = s[m.end];
	// A glued identifier / function `(` means this was not a clean ref (so it is not an external cell either).
	if (isAlnum(after) || after === '_' || after === '(') {
		return -1;
	}
	let end = m.end;
	// Consume a `:`-range right endpoint too (e.g. `[1]Sheet1!A1:B2`), so the whole external range is dropped.
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

/**
 * Extract every A1 cell reference a formula reads, in source order, as 0-based {@link FormulaRef}s.
 *
 * `formula` is the raw formula body (with or without a leading `=`; the `=` and every non-ref char is
 * skipped). This is a single-pass tokenizer that mirrors the webview `translateFormulaRefs` skeleton, so
 * it inherits ALL of its protections (see the module header):
 *   - text inside a `"..."` string literal is skipped (an `A1` in an arg string is not a ref);
 *   - a quoted `'sheet'!A1` keeps the sheet name verbatim (an A1-shaped substring inside the quotes is not
 *     a ref) and the A1 coordinate after the `!` IS extracted, qualified with that sheet;
 *   - an unquoted ref-shaped sheet name -- `S1!A1`, dotted `Q1.2024!A1`, or whitespace-padded `S1 !A1` --
 *     is treated as a SHEET, not a same-sheet cell ref (the three HIGH classes the webview twin fixed);
 *   - a function name that looks like a cell (`LOG10(`) is not a ref (the trailing `(` guard);
 *   - a structured ref (`Table1[Amount]`) is skipped; an EXTERNAL-workbook ref (`[1]Sheet1!A1`,
 *     `[Book.xlsx]Data!C3`) is dropped WHOLE -- its cell lives in another workbook, so it is NOT a local
 *     precedent (emitting it would fabricate an edge);
 *   - number literals incl. scientific notation (`2.5e3`) never seed a ref scan.
 *
 * Returns the refs in the order they appear; duplicates are NOT de-duplicated here (the dep-graph model
 * de-dupes when it builds nodes, so a `=A1+A1` shows one `A1` precedent). A formula with no refs (a pure
 * literal, `=TODAY()`, `=1+2`) returns `[]`. Pure + total (never throws); unit-tested directly.
 *
 * INPUT CONTRACT (No-Fallbacks responsibility): this extractor assumes a WELL-FORMED formula -- it is the
 * read-only twin of the webview `translateFormulaRefs`, which has the same assumption. Snapshot formulas
 * satisfy it by construction (the engine rejects a malformed formula at `setFormula` with `[formula_parse]`,
 * so a stored formula already parsed). On a MALFORMED body (an unterminated `"`/`'`/`[`, a dangling `A1+`),
 * a single-pass tokenizer cannot both stay total AND report the error, so this function does NOT detect
 * malformedness -- it skips the unterminated construct to EOF (matching `translateFormulaRefs`). Therefore a
 * caller that must surface a bad formula (No-Fallbacks) MUST gate on the ENGINE validator FIRST
 * (`SessionInstance.validateFormula`, the same lexer that stored the formula) and only call this on a
 * validated body -- which is exactly what the dep-graph provider does (DepGraphTreeProvider.formulaError).
 * Do not rely on this function to flag a malformed formula.
 */
export function extractFormulaRefs(formula: string): FormulaRef[] {
	const out: FormulaRef[] = [];
	let i = 0;
	const n = formula.length;
	// Range-sheet inheritance state. In `Sheet2!A1:B2` BOTH endpoints live on Sheet2 -- but the tokenizer
	// emits the right endpoint `B2` as a bare ref (the `!` only precedes the left endpoint). So we remember
	// the previous ref's semantic sheet + its end index; when a BARE ref is the right side of a `:` range
	// whose left side is the previous ref, it inherits that sheet. `endIdx` is the source index just past the
	// previous ref so we can verify the `:` directly connects them (only `:` + lexer whitespace between).
	let prevRef: { sheet: string | undefined; endIdx: number } | null = null;

	/**
	 * Emit a ref, applying range-sheet inheritance. `startIdx`/`m.end` bound its source span; `sheetSlice` is
	 * the verbatim sheet qualifier (trailing lexer-whitespace already trimmed) or `undefined` for a bare ref.
	 * A bare ref that is the right endpoint of a `:` range whose left endpoint was the previous ref inherits
	 * the previous ref's sheet (so `Sheet2!A1:B2` yields `Sheet2!A1` + `Sheet2!B2`, not a fabricated bare B2).
	 */
	const pushRef = (startIdx: number, sheetSlice: string | undefined, m: RefMatch): void => {
		let sheet = sheetSlice;
		if (sheet === undefined && prevRef !== null) {
			// Is this ref the right side of a `:` range directly following the previous ref? Walk from the
			// previous ref's end over lexer whitespace, require a single `:`, then lexer whitespace up to this
			// ref's start. If so, inherit the left endpoint's sheet.
			let k = skipLexWhitespace(formula, prevRef.endIdx);
			if (formula[k] === ':') {
				k = skipLexWhitespace(formula, k + 1);
				if (k === startIdx) {
					sheet = prevRef.sheet;
				}
			}
		}
		out.push({ sheet, row: m.rowIndex, col: m.colIndex, colAbs: m.colAbs, rowAbs: m.rowAbs, raw: formula.slice(startIdx, m.end) });
		prevRef = { sheet, endIdx: m.end };
	};

	while (i < n) {
		const ch = formula[i];
		// 0. Bracketed structured / external reference -- the text inside `[...]` is a column/workbook token,
		// NOT an A1 cell ref. Skip it verbatim, depth-counted so a nested `[[#Headers],[Col]]` is handled.
		// (A STRUCTURED ref `Table1[Amount]` reaches here only as the `[Amount]` part: the `Table1` identifier
		// was already consumed by step 3's identifier-run, so a `[` at this position always leads a token.)
		if (ch === '[') {
			let depth = 0;
			while (i < n) {
				// FE-8.6: OOXML escape -- inside `[...]` a `'X` 2-char atom escapes X (one of `[ ] # @ '`), so the
				// escaped char must NOT change bracket depth. Skip both. Mirrors the engine's
				// `consume_structured_ref_bracket` (ql-formula-syntax lexer.rs). Without this, a column name with an
				// UNBALANCED `[`/`]` (e.g. `Net ]Margin`, printed `Table[Net ']Margin]`) mis-counts depth and this
				// skip mis-ends -> the dep-graph tree would mis-attribute precedents for referencing formulas.
				if (formula[i] === '\'') {
					i += 2;
					continue;
				}
				if (formula[i] === '[') {
					depth += 1;
				} else if (formula[i] === ']') {
					depth -= 1;
					if (depth === 0) {
						i += 1;
						break;
					}
				}
				i += 1;
			}
			// An EXTERNAL-workbook reference is `[N]Sheet!A1` / `[Book.xlsx]Sheet!A1`: a leading bracket
			// IMMEDIATELY followed by a `<sheet>!<cell>` (or bare cell). That cell lives in ANOTHER workbook,
			// NOT this local sheet -- emitting it as a local precedent would FABRICATE an edge (No-Fallbacks).
			// So if a sheet-qualified-or-bare ref directly abuts the bracket (no operator between), consume it
			// WITHOUT emitting. `consumeExternalRefBody` returns the index past such a ref, or -1 if none abuts.
			const ext = consumeExternalRefBody(formula, i);
			if (ext >= 0) {
				i = ext;
				// The external ref breaks any pending range-inheritance chain (its endpoint is not local).
				prevRef = null;
			}
			continue;
		}
		// 1. Double-quoted string literal -- skip verbatim ("" is an escaped quote inside it). No refs inside.
		if (ch === '"') {
			i += 1;
			while (i < n) {
				if (formula[i] === '"') {
					if (formula[i + 1] === '"') {
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
		// 2. Single-quoted sheet name -- it can ONLY be a sheet qualifier (`'name'!A1`) or, if no `!` follows,
		// a stray quoted token. Either way the text inside the quotes is never an A1 ref. Try to read it as a
		// `'sheet'!<cellref>` qualifier; on success, attach the quoted sheet to the following cell ref.
		if (ch === '\'') {
			const sheetEnd = quotedSheetNameEnd(formula, i);
			if (sheetEnd >= 0) {
				// The quoted name + any whitespace before `!`; trim that trailing whitespace so the SEMANTIC
				// sheet name (`'My Sheet'`, quotes kept for the consumer to strip) excludes lexer padding.
				const sheetText = trimTrailingLexWhitespace(formula.slice(i, sheetEnd));
				const afterBang = sheetEnd + 1;
				// The lexer tolerates whitespace AFTER `!` too (`'My Sheet'! A1`); skip it before the cell ref.
				const cellStart = skipLexWhitespace(formula, afterBang);
				const m = matchRefAt(formula, cellStart);
				if (m !== null) {
					const after = formula[m.end];
					const gluedAfter = isAlnum(after) || after === '_' || after === '(';
					if (!gluedAfter) {
						pushRef(i, sheetText, m);
						i = m.end;
						continue;
					}
				}
				// `'sheet'!` qualifier present but not followed by a clean cell ref (e.g. `'sheet'!A1:` range
				// end handled on the next iteration, or `'sheet'!SUM(`): skip just past the `!` so the part
				// after it is scanned normally (a same-sheet-looking ref after a sheet `!` is rare but the
				// next iteration handles it; we do not fabricate a ref).
				i = afterBang;
				continue;
			}
			// An unterminated or non-qualifier quoted token -- skip the quoted run verbatim (no refs inside).
			i += 1;
			while (i < n) {
				if (formula[i] === '\'') {
					if (formula[i + 1] === '\'') {
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
		// 3. A letter, `_`, or `$` may begin a cell reference (or an unquoted sheet qualifier). `_` is included
		// because the engine lexer allows a sheet name to START with `_` (`[A-Za-z_][A-Za-z0-9_.]*`); without
		// it, `_Data!A1` would skip `_` and mis-extract `Data!A1` (wrong sheet, no validator surface).
		if (isLetter(ch) || ch === '_' || ch === '$') {
			// 3a. An UNQUOTED sheet-name qualifier -- a `[A-Za-z_][A-Za-z0-9_.]*` run ending in `!` (optionally
			// after whitespace) -- qualifies the cell ref that follows. A `$`-led token can never be a sheet
			// name; a `_`-led token can ONLY be a sheet name (no column starts with `_`).
			if (ch !== '$') {
				const sheetEnd = unquotedSheetNameEnd(formula, i);
				if (sheetEnd >= 0) {
					// name + any whitespace before `!`; trim that trailing whitespace so the SEMANTIC sheet name
					// (used for cross-sheet detection) excludes lexer padding (`S0 ` -> `S0`).
					const sheetText = trimTrailingLexWhitespace(formula.slice(i, sheetEnd));
					const afterBang = sheetEnd + 1;
					// The lexer tolerates whitespace AFTER `!` too (`S1! A1`); skip it before the cell ref.
					const cellStart = skipLexWhitespace(formula, afterBang);
					const m = matchRefAt(formula, cellStart);
					if (m !== null) {
						const after = formula[m.end];
						const gluedAfter = isAlnum(after) || after === '_' || after === '(';
						if (!gluedAfter) {
							pushRef(i, sheetText, m);
							i = m.end;
							continue;
						}
					}
					// Sheet qualifier present but no clean cell ref after it: advance past the `!` (do NOT
					// re-scan the sheet name as a same-sheet ref -- that is the ref-shaped-sheet-name HIGH).
					i = afterBang;
					continue;
				}
			}
			// 3b. A bare (same-sheet) cell ref. A `_`-led token cannot be a cell ref (handled above as a
			// sheet-name attempt that fell through), so matchRefAt at `_` correctly returns null.
			const m = matchRefAt(formula, i);
			if (m !== null) {
				const after = formula[m.end];
				// Not a clean cell ref if glued to a trailing identifier char or a function-call `(`.
				const gluedAfter = isAlnum(after) || after === '_' || after === '(';
				if (!gluedAfter) {
					pushRef(i, undefined, m);
					i = m.end;
					continue;
				}
			}
			// Otherwise consume a maximal identifier run verbatim so a ref is never re-scanned inside it.
			i += 1;
			while (i < n && (isAlnum(formula[i]) || formula[i] === '_' || formula[i] === '$')) {
				i += 1;
			}
			continue;
		}
		// 4. A number literal -- skip verbatim so a digit never seeds a ref scan. Consume a trailing exponent
		// (`2.5e3`, `1E-4`) too, else its `e3` tail would be mistaken for a ref.
		if (isDigit(ch)) {
			i += 1;
			while (i < n && (isDigit(formula[i]) || formula[i] === '.')) {
				i += 1;
			}
			if (formula[i] === 'e' || formula[i] === 'E') {
				const sign = formula[i + 1] === '+' || formula[i + 1] === '-' ? 1 : 0;
				if (isDigit(formula[i + 1 + sign])) {
					i += 1 + sign;
					while (i < n && isDigit(formula[i])) {
						i += 1;
					}
				}
			}
			continue;
		}
		// 5. Anything else (operators, `!`, `:`, commas, spaces, parens) -- skip one char.
		i += 1;
	}
	return out;
}
