/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 F4 -- absolute/relative reference cycling. While editing a formula, F4 cycles the `$`-anchoring of
// the cell reference the caret is on, Excel-faithfully:  A1 -> $A$1 -> A$1 -> $A1 -> A1.
//
// This is a PURE string transform (no engine call, no DOM). It MUST recognise exactly the reference
// grammar the shared tokenizer (`shared/a1FormulaRefs.ts`) recognises, so a ref F4 rewrites is the same ref
// copy/paste/fill would translate:
//   - a plain ref `A1`; each of `$A$1`, `A$1`, `$A1`;
//   - 1-3 column letters (XFD is the widest), 1-7 row digits;
//   - a sheet qualifier in front -- unquoted `S1!A1` / `Q1.2024!A1` (a `[A-Za-z_][A-Za-z0-9_.]*` name,
//     optional ASCII whitespace, `!`) OR single-quoted `'My Sheet'!A1` -- is copied VERBATIM; only the
//     A1 coordinate after the `!` is cycled (the qualifier never gains/loses a `$`);
//   - a range `A1:B2` is two independent refs around the `:`; the caret picks WHICH endpoint cycles, EXCEPT
//     when the caret sits ON the `:` operator, when BOTH endpoints cycle (Excel cycles the whole range when
//     you sit between the ends).
//
// Caret model: `caretPos` is a 0-based offset into `formula` (an `<input>.selectionStart`). The caret is
// considered "on" a ref token if it is anywhere within the token's [start, end) span OR exactly at `end`
// (so a caret just past the last digit -- the common case right after typing a ref -- still cycles it).
//
// No-Fallbacks: if the caret is not on any ref (it is in whitespace, on an operator other than a range `:`
// between two refs, inside a function name, in a string literal, ...), `cycleRefAbsRel` returns `null` and
// the caller leaves the formula untouched (F4 is a no-op there) -- it never guesses a "nearest" ref.

import { columnLabel } from './gridLayoutA1';

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

/** Column letters -> 0-based column index (bijective base-26): "A" -> 0, "AA" -> 26. -1 if non-letter. */
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

/** A located cell reference token inside a formula -- its absolute span and parsed parts. The span COVERS
 *  any leading `$` and the column letters + optional row `$` + row digits; it does NOT include a sheet
 *  qualifier (that is matched separately and copied verbatim). */
interface LocatedRef {
	readonly start: number; // index of the first char of the ref (a `$` or the first column letter)
	readonly end: number; // index just past the last row digit
	readonly colAbs: boolean;
	readonly colLetters: string; // the column letters AS WRITTEN (case preserved on re-emit via columnLabel)
	readonly rowAbs: boolean;
	readonly rowDigits: string; // the row digits as written
}

/**
 * Try to match an A1 cell reference starting at `i`: an optional `$`, 1-3 column letters, an optional `$`,
 * 1-7 row digits. Returns the located ref, or null when the text at `i` is not a clean reference (mirrors
 * `matchRefAt` in the shared tokenizer: a 4th letter or 8th digit disqualifies it as a longer identifier).
 * Does NOT apply the "glued after" / function-call `(` rejection -- the caller (`cycleRefAbsRel`) applies
 * the same `isAlnum(after) || after === '_' || after === '('` rejection the tokenizer does.
 */
function matchRefAt(s: string, i: number): LocatedRef | null {
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
		return null; // a 4th letter -> a longer identifier (sheet/function/name), not a column
	}
	const colEnd = j;
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
		return null; // an 8th digit -> beyond the grid width, not a row
	}
	const colLetters = s.slice(colStart, colEnd);
	if (colLettersToIndex(colLetters) < 0) {
		return null;
	}
	return { start: i, end: j, colAbs, colLetters, rowAbs, rowDigits: s.slice(rowStart, j) };
}

/**
 * If an UNQUOTED sheet-name qualifier starts at `i` -- a `[A-Za-z0-9_.]` run, then OPTIONAL ASCII
 * whitespace, then `!` -- return the index just PAST the `!`; else -1. Mirrors `unquotedSheetNameEnd` in
 * the shared tokenizer (which returns the `!` index); here we return one past it so the caller can skip the
 * qualifier and start the ref scan at the coordinate. The caller invokes this only at a letter (never `$`).
 */
function unquotedSheetQualifierEnd(s: string, i: number): number {
	let j = i;
	while (j < s.length && (isAlnum(s[j]) || s[j] === '_' || s[j] === '.')) {
		j += 1;
	}
	if (j === i) {
		return -1; // no sheet-name run
	}
	let k = j;
	while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) {
		k += 1;
	}
	if (s[k] === '!') {
		return k + 1; // one past the `!`
	}
	return -1;
}

/**
 * If a single-quoted sheet name `'...'!` starts at `i`, return the index just past the `!`; else -1. A `''`
 * inside the quotes is an escaped quote (mirrors the shared tokenizer's single-quote scan). The closing
 * quote must be followed (after optional ASCII whitespace, which the lexer accepts) by `!`.
 */
function quotedSheetQualifierEnd(s: string, i: number): number {
	if (s[i] !== '\'') {
		return -1;
	}
	let j = i + 1;
	while (j < s.length) {
		if (s[j] === '\'') {
			if (s[j + 1] === '\'') {
				j += 2;
				continue;
			}
			j += 1; // past the closing quote
			break;
		}
		j += 1;
	}
	let k = j;
	while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) {
		k += 1;
	}
	if (s[k] === '!') {
		return k + 1;
	}
	return -1;
}

/** The four `$`-anchoring states, in F4 cycle order. */
type RefAbsState = 'rel' | 'both' | 'rowAbs' | 'colAbs';

/** Map a ref's current (colAbs,rowAbs) to its cycle state. */
function stateOf(colAbs: boolean, rowAbs: boolean): RefAbsState {
	if (!colAbs && !rowAbs) {
		return 'rel'; // A1
	}
	if (colAbs && rowAbs) {
		return 'both'; // $A$1
	}
	if (!colAbs && rowAbs) {
		return 'rowAbs'; // A$1
	}
	return 'colAbs'; // $A1
}

/** Advance one F4 step: A1 -> $A$1 -> A$1 -> $A1 -> A1. */
function nextState(s: RefAbsState): { colAbs: boolean; rowAbs: boolean } {
	switch (s) {
		case 'rel':
			return { colAbs: true, rowAbs: true }; // A1 -> $A$1
		case 'both':
			return { colAbs: false, rowAbs: true }; // $A$1 -> A$1
		case 'rowAbs':
			return { colAbs: true, rowAbs: false }; // A$1 -> $A1
		case 'colAbs':
			return { colAbs: false, rowAbs: false }; // $A1 -> A1
	}
}

/** Render a located ref with NEW abs flags, preserving the column letters' canonical case + the row digits
 *  verbatim. Uses `columnLabel` (uppercase canonical) so the column matches the rest of the toolchain. */
function renderRef(ref: LocatedRef, colAbs: boolean, rowAbs: boolean): string {
	const colIndex = colLettersToIndex(ref.colLetters);
	const col = colIndex >= 0 ? columnLabel(colIndex) : ref.colLetters;
	return (colAbs ? '$' : '') + col + (rowAbs ? '$' : '') + ref.rowDigits;
}

/** True if `pos` is "on" the ref's span [start, end) or exactly at `end` (a caret just past the ref). */
function caretOnRef(ref: LocatedRef, pos: number): boolean {
	return pos >= ref.start && pos <= ref.end;
}

/**
 * Scan `formula` left-to-right and collect every cell ref (with its absolute span), applying the SAME
 * disqualifications the shared tokenizer applies: sheet qualifiers (quoted + unquoted) are skipped (their
 * coordinate ref IS collected, at the post-`!` offset); refs inside string literals / bracketed table refs
 * are skipped; a ref glued to a trailing identifier char or `(` is NOT a ref. Returns the refs in source
 * order. Pure; O(n).
 */
function collectRefs(formula: string): LocatedRef[] {
	const refs: LocatedRef[] = [];
	let i = 0;
	const n = formula.length;
	while (i < n) {
		const ch = formula[i];
		// Bracketed structured/external ref `[...]` -- copy over (no A1 ref to cycle inside it). Depth-counted.
		if (ch === '[') {
			let depth = 0;
			while (i < n) {
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
			continue;
		}
		// Double-quoted string literal -- skip ("" escapes a quote).
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
		// Single-quoted token -- it is a sheet qualifier `'name'!A1` if a `!` follows the close quote; the
		// ref AFTER the `!` is collected. Otherwise (no `!`) it is a bare quoted name; skip it.
		if (ch === '\'') {
			const qEnd = quotedSheetQualifierEnd(formula, i);
			if (qEnd >= 0) {
				i = qEnd; // jump past `'name'!`; the coordinate ref is matched on the next loop iterations
				continue;
			}
			// bare quoted token (no trailing `!`) -- skip its span
			let j = i + 1;
			while (j < n) {
				if (formula[j] === '\'') {
					if (formula[j + 1] === '\'') {
						j += 2;
						continue;
					}
					j += 1;
					break;
				}
				j += 1;
			}
			i = j;
			continue;
		}
		if (isLetter(ch) || ch === '$') {
			// An unquoted sheet qualifier (a run ending in `!`) -- skip it; the coordinate after `!` is matched
			// next. A `$`-led token can never be a sheet name (mirrors the shared tokenizer).
			if (ch !== '$') {
				const sqEnd = unquotedSheetQualifierEnd(formula, i);
				if (sqEnd >= 0) {
					i = sqEnd;
					continue;
				}
			}
			const m = matchRefAt(formula, i);
			if (m !== null) {
				const after = formula[m.end];
				const gluedAfter = isAlnum(after) || after === '_' || after === '(';
				if (!gluedAfter) {
					refs.push(m);
					i = m.end;
					continue;
				}
			}
			// Consume a maximal identifier run verbatim so a ref is never re-scanned inside it.
			i += 1;
			while (i < n && (isAlnum(formula[i]) || formula[i] === '_' || formula[i] === '$')) {
				i += 1;
			}
			continue;
		}
		// A number literal -- consume so a digit never seeds a ref scan (mirror the shared tokenizer).
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
		i += 1; // any other char -- advance one
	}
	return refs;
}

/** Replace the half-open span [start,end) of `s` with `replacement`. */
function spliceSpan(s: string, start: number, end: number, replacement: string): string {
	return s.slice(0, start) + replacement + s.slice(end);
}

/**
 * The result of an F4 cycle: the new formula text + the new caret position. The caret is kept ON the
 * (possibly re-sized) ref so a repeated F4 keeps cycling the SAME ref -- placed just past the ref's end.
 */
export interface CycleResult {
	readonly formula: string;
	readonly caretPos: number;
}

/**
 * Cycle the absolute/relative anchoring of the cell reference the caret is on:
 *   A1 -> $A$1 -> A$1 -> $A1 -> A1.
 * Returns the new formula + caret, or `null` when the caret is not on any ref (F4 is a no-op there).
 *
 * Range rule (Excel): when the caret sits exactly ON the `:` operator BETWEEN two refs, BOTH endpoints
 * cycle together (the whole range's anchoring advances one step). Otherwise the SINGLE ref the caret touches
 * cycles. If the caret is on the end of one ref AND the start of the next (only possible when they are
 * adjacent, which a range's `:` prevents), the FIRST (left) ref wins -- a deterministic, documented choice.
 */
export function cycleRefAbsRel(formula: string, caretPos: number): CycleResult | null {
	const pos = Math.max(0, Math.min(formula.length, caretPos));
	const refs = collectRefs(formula);
	if (refs.length === 0) {
		return null;
	}

	// RANGE: caret exactly ON the `:` operator (i.e. `formula[pos] === ':'`, the caret sits immediately BEFORE
	// the colon) that joins two collected refs (left.end === colonIndex, right.start === colonIndex + 1). Cycle
	// BOTH endpoints one step. A caret just AFTER the `:` is ON the right ref's span instead -- handled by the
	// single-ref path below (it cycles the right endpoint alone), matching Excel's "the endpoint you are on".
	// Splice the RIGHT ref first so the left ref's span stays valid (the right edit does not shift left indices).
	if (formula[pos] === ':') {
		const colonIndex = pos;
		const left = refs.find(r => r.end === colonIndex);
		const right = refs.find(r => r.start === colonIndex + 1);
		if (left !== undefined && right !== undefined) {
			const lNext = nextState(stateOf(left.colAbs, left.rowAbs));
			const rNext = nextState(stateOf(right.colAbs, right.rowAbs));
			const rText = renderRef(right, rNext.colAbs, rNext.rowAbs);
			const lText = renderRef(left, lNext.colAbs, lNext.rowAbs);
			let out = spliceSpan(formula, right.start, right.end, rText);
			out = spliceSpan(out, left.start, left.end, lText);
			// Keep the caret on the (possibly re-shifted) `:` so a repeated F4 keeps cycling the whole RANGE
			// (the new colon sits just past the rewritten left endpoint).
			const newColon = left.start + lText.length;
			return { formula: out, caretPos: newColon };
		}
		// a lone `:` not between two refs -- fall through to the single-ref search below
	}

	// SINGLE ref: the first ref whose span the caret touches (start..end inclusive). The first match wins on
	// an exact boundary tie (documented above).
	const hit = refs.find(r => caretOnRef(r, pos));
	if (hit === undefined) {
		return null;
	}
	const next = nextState(stateOf(hit.colAbs, hit.rowAbs));
	const text = renderRef(hit, next.colAbs, next.rowAbs);
	const out = spliceSpan(formula, hit.start, hit.end, text);
	// Keep the caret just past the rewritten ref so a repeated F4 cycles the same ref.
	return { formula: out, caretPos: hit.start + text.length };
}
