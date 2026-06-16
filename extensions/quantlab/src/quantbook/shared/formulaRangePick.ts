/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-3 range-pick / point mode -- the PURE, vscode/DOM-free core that decides WHETHER a cell reference may
// be inserted at the caret while editing a formula, and that performs the text insert/replace. While a
// formula is being edited, clicking (or dragging) a cell on the grid inserts that cell's A1 reference at the
// caret (Excel "point mode"); the webview wires the pointer events, this module owns the string grammar.
//
// It MUST recognise the SAME reference-context grammar the shared tokenizer family (`extractFormulaRefs.ts`,
// `f4Logic.ts`, `a1FormulaRefs.ts`) recognises -- a single-pass scan that skips, verbatim, the three spans an
// A1 ref can never live inside: a double-quoted string literal (`"..."`, `""` escapes a quote), a
// single-quoted sheet-name/token (`'...'`, `''` escapes a quote), and a bracketed structured/external ref
// (`[...]`, depth-counted, with the OOXML `'X` 2-char escape so an unbalanced `[`/`]` in a column name cannot
// mis-count depth -- the FE-8.6 fix; mirrors the engine `consume_structured_ref_bracket`). A GLOBAL REGEX is
// deliberately NOT used: the family has a 3-HIGH-bug history (string literals, quoted/whitespace sheet names,
// dotted ref-shaped sheet names) that a blind regex re-opens.
//
// No-Fallbacks: a caret that is not at an insertion position yields `false` (a deliberate no-op, never a
// guessed "nearest" position); a malformed replace-span passed to `insertRefAtCaret` THROWS (a programming
// error must surface loud, never be silently coerced into a plain insert).

import { cellRefA1, type SelectionRect } from './gridLayoutA1';

/** Lexer-whitespace: the exact ASCII set the engine lexer skips (space/tab/LF/CR -- NOT Unicode space). */
function isLexWhitespace(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Chars that, immediately to the LEFT of the insertion point (after skipping lexer whitespace), make a ref
 * insertion grammatically valid: the leading `=`, an open paren, an argument comma, or a BINARY operator. A ref
 * glued to the right of any OTHER char (a letter/digit/`_`/`.`/`$` -> inside an identifier/number/ref; a `)` /
 * `]` / `!` / quote -> just past a closing token) would corrupt that token, so those are NOT starters.
 * `%` is EXCLUDED: in the engine grammar `%` is a POSTFIX operator (`50%`), never binary, so a caret right
 * after it (`=A1%|`) is past a complete expression, not at an operand position.
 */
const REF_STARTERS: ReadonlySet<string> = new Set(['=', '(', ',', '+', '-', '*', '/', '^', '&', '<', '>']);

/**
 * Chars that may immediately FOLLOW an inserted ref (after skipping lexer whitespace) without fusing two
 * tokens: a binary operator, a comma, a close paren, or the POSTFIX `%` (`B2%` is a valid percent literal).
 * If the char to the RIGHT of the insertion point is anything else -- a letter/digit/`_`/`$` (operand), a
 * `(`/`[`/quote (an opener), or `!` (a sheet qualifier) -- inserting a ref there would glue it onto the next
 * token (`=A1+B2` caret-after-`+` -> `=A1+C3B2`), so insertion is forbidden. End-of-text is always safe.
 */
const SAFE_FOLLOWERS: ReadonlySet<string> = new Set([')', ',', '+', '-', '*', '/', '^', '&', '<', '>', '=', '%']);

/** Clamp an arbitrary caret (possibly NaN / negative / past end) into `[0, text.length]`. */
function clampCaret(text: string, caret: number): number {
	if (!Number.isFinite(caret)) {
		return 0;
	}
	return Math.max(0, Math.min(text.length, Math.floor(caret)));
}

/** Index just past a double-quoted string literal opened at `i` (`""` escapes a quote); `s.length` if unterminated. */
function stringSpanEnd(s: string, i: number): number {
	let j = i + 1;
	while (j < s.length) {
		if (s[j] === '"') {
			if (s[j + 1] === '"') {
				j += 2;
				continue;
			}
			return j + 1; // just past the closing quote
		}
		j += 1;
	}
	return s.length; // unterminated -> the rest of the text is "inside" the string
}

/** Index just past a single-quoted run opened at `i` (`''` escapes a quote); `s.length` if unterminated. */
function singleQuoteSpanEnd(s: string, i: number): number {
	let j = i + 1;
	while (j < s.length) {
		if (s[j] === '\'') {
			if (s[j + 1] === '\'') {
				j += 2;
				continue;
			}
			return j + 1; // just past the closing quote
		}
		j += 1;
	}
	return s.length; // unterminated
}

/**
 * Index just past a bracketed `[...]` run opened at `i`, depth-counted; `s.length` if unbalanced/unterminated.
 * The OOXML `'X` 2-char escape (FE-8.6) is skipped so an escaped `[`/`]`/`#`/`@`/`'` inside a column name does
 * NOT change depth -- mirrors the engine `consume_structured_ref_bracket`.
 */
function bracketSpanEnd(s: string, i: number): number {
	let depth = 0;
	let j = i;
	while (j < s.length) {
		if (s[j] === '\'') {
			j += 2; // skip the escaped char
			continue;
		}
		if (s[j] === '[') {
			depth += 1;
		} else if (s[j] === ']') {
			depth -= 1;
			if (depth === 0) {
				return j + 1; // just past the matching close
			}
		}
		j += 1;
	}
	return s.length; // unbalanced -> the rest of the text is "inside" the bracket run
}

/**
 * True if `caret` falls strictly INSIDE a string literal / single-quoted run / bracketed ref -- i.e. between
 * the opening delimiter and the position just past its close. A caret exactly AT an opening delimiter (before
 * it) or exactly at the position past a close is NOT inside (the look-left rule handles those edges). Scans
 * left-to-right, skipping each atomic span; stops at the caret. Pure; O(caret).
 */
function caretInsideProtectedSpan(text: string, caret: number): boolean {
	let i = 0;
	while (i < caret) {
		const ch = text[i];
		if (ch === '"') {
			const end = stringSpanEnd(text, i);
			if (caret < end) {
				return true; // i < caret < end -> strictly inside the string
			}
			i = end;
			continue;
		}
		if (ch === '\'') {
			const end = singleQuoteSpanEnd(text, i);
			if (caret < end) {
				return true;
			}
			i = end;
			continue;
		}
		if (ch === '[') {
			const end = bracketSpanEnd(text, i);
			if (caret < end) {
				return true;
			}
			i = end;
			continue;
		}
		i += 1;
	}
	return false;
}

/** True if the first significant (non-lexer-whitespace) char to the LEFT of `caret` is a ref starter. */
function precededByRefStarter(text: string, caret: number): boolean {
	let k = caret - 1;
	while (k >= 0 && isLexWhitespace(text[k])) {
		k -= 1;
	}
	if (k < 0) {
		return false; // nothing significant to the left (caret is at/before the formula's `=`)
	}
	return REF_STARTERS.has(text[k]);
}

/** True if the first significant (non-lexer-whitespace) char at/after `pos` is a safe follower (or none). */
function followedBySafeChar(text: string, pos: number): boolean {
	let k = pos;
	while (k < text.length && isLexWhitespace(text[k])) {
		k += 1;
	}
	if (k >= text.length) {
		return true; // nothing to the right -- a ref at the end of the formula fuses onto nothing
	}
	return SAFE_FOLLOWERS.has(text[k]);
}

/**
 * Whether inserting a cell reference over the selection/caret `[start, end)` is grammatically valid (Excel
 * point-mode eligibility). The selected text (if any) is REPLACED by the ref, so the grammar is checked on the
 * SURROUNDING context -- the char to the LEFT of `start` and the char to the RIGHT of `end`:
 *   - `text` must be a formula (`text[0] === '='`); a plain value is never a point-mode target.
 *   - neither endpoint may be inside a string literal / quoted sheet name / `[...]` structured ref.
 *   - the first significant char left of `start` must be a ref STARTER (`=`/`(`/`,`/binary op) AND the first
 *     significant char right of `end` must be a SAFE FOLLOWER (operator/comma/close-paren/`%`/end), so the
 *     inserted ref sits at an operand position and fuses onto neither neighbour.
 * Defensive: out-of-range / NaN offsets are clamped + ordered; a `start` at/before the `=` returns false. Pure.
 */
export function canPointAtRange(text: string, start: number, end: number): boolean {
	if (text.length === 0 || text[0] !== '=') {
		return false; // not a formula -> point mode never applies
	}
	// Clamp EACH endpoint first, THEN order -- so a NaN / out-of-range endpoint can never invert the pair.
	const cs = clampCaret(text, start);
	const ce = clampCaret(text, end);
	const s = Math.min(cs, ce);
	const e = Math.max(cs, ce);
	if (s <= 0) {
		return false; // the left edge is at/before the leading `=`
	}
	if (caretInsideProtectedSpan(text, s) || (e !== s && caretInsideProtectedSpan(text, e))) {
		return false; // an endpoint is inside a string / quoted sheet / [...] -- inserting there corrupts it
	}
	// Reject a zero-width caret wedged in the MIDDLE of a two-char comparison operator (`<=` / `>=` / `<>`): the
	// left char is a STARTER and the right char is a SAFE FOLLOWER, so the surrounding-char rule alone would
	// allow it -- but inserting there SPLITS the operator (`=A1<|=B2` -> `=A1<C3=B2`). Only a no-selection caret
	// can sit between the two chars (a selection would have to start there, which the boundary checks cover).
	if (s === e && s >= 1) {
		const digraph = text.slice(s - 1, s + 1);
		if (digraph === '<=' || digraph === '>=' || digraph === '<>') {
			return false;
		}
	}
	return precededByRefStarter(text, s) && followedBySafeChar(text, e);
}

/**
 * Whether inserting a cell reference AT `caret` (no selection) is valid -- the zero-width case of
 * {@link canPointAtRange}. The named entry point for the no-selection path. Pure.
 */
export function canPointAtCaret(text: string, caret: number): boolean {
	return canPointAtRange(text, caret, caret);
}

/** A half-open `[start, end)` span (offsets into the editor value) covering an inserted reference's text. */
export interface RefSpan {
	readonly start: number;
	readonly end: number;
}

/** The result of a point insert/replace: the new editor text, the inserted ref's span, and the new caret. */
export interface InsertResult {
	readonly text: string;
	readonly span: RefSpan;
	readonly caret: number;
}

/**
 * Insert `refText` into `text`, returning the new text + the inserted span + the caret placed just past it.
 *   - With `prevSpan` (a re-point: the previous point inserted a ref and the user has not typed since), the
 *     ref at `[prevSpan.start, prevSpan.end)` is REPLACED -- so dragging/clicking again rewrites the live ref
 *     rather than appending a second one.
 *   - Without `prevSpan`, `refText` is inserted at `caret` (clamped into range).
 * No-Fallbacks: a malformed `prevSpan` (non-integer, negative, end<start, or end>length) THROWS -- a caller
 * that lost track of the span is a bug we must SEE, never silently fall back to a plain insert (which would
 * leave the stale ref text behind and duplicate the reference). Pure.
 */
export function insertRefAtCaret(text: string, caret: number, refText: string, prevSpan?: RefSpan): InsertResult {
	if (prevSpan !== undefined) {
		const { start, end } = prevSpan;
		if (
			!Number.isInteger(start) || !Number.isInteger(end) ||
			start < 0 || end < start || end > text.length
		) {
			throw new Error(
				`insertRefAtCaret: malformed prevSpan {start:${start}, end:${end}} for text length ${text.length}`,
			);
		}
		const newText = text.slice(0, start) + refText + text.slice(end);
		const newEnd = start + refText.length;
		return { text: newText, span: { start, end: newEnd }, caret: newEnd };
	}
	const c = clampCaret(text, caret);
	const newText = text.slice(0, c) + refText + text.slice(c);
	const newEnd = c + refText.length;
	return { text: newText, span: { start: c, end: newEnd }, caret: newEnd };
}

/**
 * The A1 text for a pointed range: a single cell (`min === max` on both axes) -> `cellRefA1(minRow,minCol)`
 * (e.g. `B2`); a multi-cell rect -> `top-left:bottom-right` (e.g. `B2:D10`). `rect` is already normalised by
 * {@link selectionRect}, so this never has to order the corners. Pure.
 */
export function buildRefText(rect: SelectionRect): string {
	const topLeft = cellRefA1(rect.minRow, rect.minCol);
	if (rect.minRow === rect.maxRow && rect.minCol === rect.maxCol) {
		return topLeft;
	}
	return `${topLeft}:${cellRefA1(rect.maxRow, rect.maxCol)}`;
}

/**
 * True if `ch` is a char that ends the "live re-point" target -- an operator / open paren / comma / lexer
 * whitespace. Exported for a future refinement where only a terminator clears the inserted-span (Excel
 * re-point vs. append); the v1 wiring instead clears the span on ANY real keystroke AND on a new point whose
 * caret has moved off the span end, which is stricter but removes a whole class of stale-span bugs, so this
 * terminator helper is not yet wired. Pure.
 */
export function isRefTerminator(ch: string): boolean {
	return REF_STARTERS.has(ch) || ch === ' ' || ch === '\t';
}
