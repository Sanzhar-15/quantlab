/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G copy/paste + fill -- the vscode-free core that translates A1 references inside a formula
// when the cell it lives in MOVES by (dRow, dCol). This is the shared correctness crux of both
// copy/paste (paste a copied formula offset to the target) and the fill handle (extend a formula down
// or right). It is a single-pass TOKENIZER, deliberately NOT a global regex replace (Codex HIGH-3): a
// blind regex would corrupt string literals ("A1" inside a text arg), quoted sheet names ('Q1 data'!),
// and function names that look like cells (LOG10(...)). Excel semantics implemented:
//   - a RELATIVE ref component (no `$`) shifts by the offset; an ABSOLUTE component (`$`) stays fixed;
//   - a sheet-qualified ref (Sheet1!A1 / 'My Sheet'!A1) still shifts its coordinate (the sheet name is
//     copied verbatim, the A1 part offset) -- matching Excel fill/copy of a cross-sheet relative ref;
//   - a ref pushed off the grid (col >= MAX_COLS or row >= MAX_ROWS, or < 0) becomes `#REF!`;
//   - a range A1:B2 is two independent refs around a copied `:` -- each end offset on its own.
// v1 cuts (documented, not hidden): full-column (A:A) / full-row (1:1) refs are NOT offset (no row/col
// digit to anchor the scan); a defined NAME shaped exactly like a cell ref (e.g. a name "Q1") is treated
// as a ref (no name table here) -- the standard spreadsheet behaviour for the common case.

import { MAX_COLS, MAX_ROWS, columnLabel } from './gridLayoutA1';

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

/**
 * Column letters -> 0-based column index (bijective base-26): "A" -> 0, "Z" -> 25, "AA" -> 26,
 * "XFD" -> 16383. Returns -1 for an empty or non-letter input (defensive; callers pass a scanned run).
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
 * identifier or immediately followed by `(` (a function call). Pure -- no formula context beyond `i`.
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

/** Render an offset reference, or `#REF!` when it falls off the grid (Excel semantics). */
function offsetRef(m: RefMatch, dRow: number, dCol: number): string {
	const newCol = m.colAbs ? m.colIndex : m.colIndex + dCol;
	const newRow = m.rowAbs ? m.rowIndex : m.rowIndex + dRow;
	if (newCol < 0 || newCol >= MAX_COLS || newRow < 0 || newRow >= MAX_ROWS) {
		return '#REF!';
	}
	return (m.colAbs ? '$' : '') + columnLabel(newCol) + (m.rowAbs ? '$' : '') + String(newRow + 1);
}

/**
 * Translate the RELATIVE A1 references in `formula` by `(dRow, dCol)` (in 0-based cell units: the target
 * cell minus the source cell), leaving `$`-absolute components fixed. `formula` is the raw formula body
 * (with or without a leading `=`; the `=` -- like any non-ref char -- is copied verbatim). A no-op offset
 * returns the input unchanged. See the module header for the exact tokenizer rules and the v1 cuts.
 */
export function translateFormulaRefs(formula: string, dRow: number, dCol: number): string {
	if (dRow === 0 && dCol === 0) {
		return formula;
	}
	let out = '';
	let i = 0;
	const n = formula.length;
	while (i < n) {
		const ch = formula[i];
		// 1. Double-quoted string literal -- copy verbatim ("" is an escaped quote inside it).
		if (ch === '"') {
			const start = i;
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
			out += formula.slice(start, i);
			continue;
		}
		// 2. Single-quoted sheet name -- copy verbatim ('' is an escaped quote inside it).
		if (ch === '\'') {
			const start = i;
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
			out += formula.slice(start, i);
			continue;
		}
		// 3. A letter or `$` may begin a cell reference.
		if (isLetter(ch) || ch === '$') {
			const m = matchRefAt(formula, i);
			if (m !== null) {
				const after = formula[m.end];
				// Not a clean ref if it is glued to a trailing identifier char or is a function call `(`.
				const gluedAfter = isAlnum(after) || after === '_' || after === '(';
				if (!gluedAfter) {
					out += offsetRef(m, dRow, dCol);
					i = m.end;
					continue;
				}
			}
			// Otherwise consume a maximal identifier run verbatim so a ref is never re-scanned inside it.
			const start = i;
			i += 1;
			while (i < n && (isAlnum(formula[i]) || formula[i] === '_' || formula[i] === '$')) {
				i += 1;
			}
			out += formula.slice(start, i);
			continue;
		}
		// 4. A number literal -- copy verbatim so a digit never seeds a ref scan. Consume a trailing
		// exponent (e.g. `2.5e3`, `1E-4`) too, else its `e3` tail would be mistaken for a ref.
		if (isDigit(ch)) {
			const start = i;
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
			out += formula.slice(start, i);
			continue;
		}
		// 5. Anything else (operators, `!`, `:`, commas, spaces, parens) -- copy one char.
		out += ch;
		i += 1;
	}
	return out;
}
