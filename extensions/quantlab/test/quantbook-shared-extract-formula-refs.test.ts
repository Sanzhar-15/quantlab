/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 B3 dependency-graph sidebar -- unit tests for the shared A1 formula-reference EXTRACTOR.
//
// This tokenizer family has a 3-HIGH-bug history (string-literal corruption, dotted ref-shaped sheet
// names, whitespace-before-`!`), so the suite mirrors the webview `translateFormulaRefs` edge-case suite
// (quantbook-a1-formula-refs.test.ts) one-for-one, asserting the SAME protections hold for extraction:
// relative/absolute/mixed components, ranges, quoted/whitespace/dotted sheet qualifiers, string-literal +
// function-name protection, bracketed structured refs, scientific notation, and the off-grid boundaries.
//
// NB: the file name MUST start with `quantbook` -- the mocha glob is `out/test/quantbook*.test.js`.

import * as assert from 'assert';

import { extractFormulaRefs, type FormulaRef } from '../src/quantbook/shared/extractFormulaRefs';

/** Compact a ref to a `[sheet!]colrow` string (1-based, `$` shown) for terse deepEqual assertions. */
function fmt(r: FormulaRef): string {
	const colLetters = ((): string => {
		let n = r.col;
		let s = '';
		do {
			s = String.fromCharCode(65 + (n % 26)) + s;
			n = Math.floor(n / 26) - 1;
		} while (n >= 0);
		return s;
	})();
	const cell = `${r.colAbs ? '$' : ''}${colLetters}${r.rowAbs ? '$' : ''}${r.row + 1}`;
	return r.sheet === undefined ? cell : `${r.sheet}!${cell}`;
}

function refs(formula: string): string[] {
	return extractFormulaRefs(formula).map(fmt);
}

suite('W3 extractFormulaRefs -- basic extraction', () => {
	test('a bare literal / no-ref formula yields []', () => {
		assert.deepStrictEqual(refs('hello'), []);
		assert.deepStrictEqual(refs('=TODAY()'), []);
		assert.deepStrictEqual(refs('=1+2*3'), []);
		assert.deepStrictEqual(refs(''), []);
	});

	test('single + multiple same-sheet refs, in source order', () => {
		assert.deepStrictEqual(refs('=A1'), ['A1']);
		assert.deepStrictEqual(refs('=A1+B1'), ['A1', 'B1']);
		assert.deepStrictEqual(refs('=B2*C3-D4'), ['B2', 'C3', 'D4']);
	});

	test('the leading = is optional (formula body with or without it)', () => {
		assert.deepStrictEqual(refs('A1+B1'), ['A1', 'B1']);
	});

	test('absolute $ components are recorded on the ref', () => {
		assert.deepStrictEqual(refs('=$A1'), ['$A1']);
		assert.deepStrictEqual(refs('=A$1'), ['A$1']);
		assert.deepStrictEqual(refs('=$A$1'), ['$A$1']);
		assert.deepStrictEqual(refs('=$A1+B$2+C3'), ['$A1', 'B$2', 'C3']);
	});

	test('0-based coordinates are correct (A1 -> row0/col0, B2 -> row1/col1)', () => {
		const [a1] = extractFormulaRefs('=A1');
		assert.strictEqual(a1.row, 0);
		assert.strictEqual(a1.col, 0);
		const [b2] = extractFormulaRefs('=B2');
		assert.strictEqual(b2.row, 1);
		assert.strictEqual(b2.col, 1);
	});
});

suite('W3 extractFormulaRefs -- ranges', () => {
	test('a range A1:B2 extracts both endpoints', () => {
		assert.deepStrictEqual(refs('=SUM(A1:B2)'), ['A1', 'B2']);
		assert.deepStrictEqual(refs('=SUM($A$1:$B$2)'), ['$A$1', '$B$2']);
	});

	test('multiple ranges + scalars together', () => {
		assert.deepStrictEqual(refs('=SUM(A1:A3)+B5'), ['A1', 'A3', 'B5']);
	});

	test('re-audit HIGH: a sheet-qualified range propagates the sheet to BOTH endpoints', () => {
		// `Sheet2!A1:B2` -- the `!` only precedes the LEFT endpoint, but BOTH cells live on Sheet2. The right
		// endpoint must INHERIT the sheet, else it resolves to the wrong (focused) sheet -- a fabricated edge.
		assert.deepStrictEqual(refs('=SUM(Sheet2!A1:B2)'), ['Sheet2!A1', 'Sheet2!B2']);
		assert.deepStrictEqual(refs('=Sheet2!A1:B2'), ['Sheet2!A1', 'Sheet2!B2']);
		// A chained range propagates down the chain.
		assert.deepStrictEqual(refs('=Sheet2!A1:B2:C3'), ['Sheet2!A1', 'Sheet2!B2', 'Sheet2!C3']);
		// Inheritance does NOT leak past the range: a `+A1` after a qualified range is bare (same-sheet).
		assert.deepStrictEqual(refs('=SUM(S1!A1:C3)+A1'), ['S1!A1', 'S1!C3', 'A1']);
		// A bare range stays bare (nothing to inherit).
		assert.deepStrictEqual(refs('=A1:B2'), ['A1', 'B2']);
		// A `+B2` (not a range) after a qualified ref does NOT inherit (no `:` connecting them).
		assert.deepStrictEqual(refs('=Sheet2!A1+B2'), ['Sheet2!A1', 'B2']);
	});
});

suite('W3 extractFormulaRefs -- function names are not refs', () => {
	test('LOG10 (ref-shaped) is a function call, not a ref', () => {
		assert.deepStrictEqual(refs('=LOG10(A1)'), ['A1']);
	});

	test('SUM args are extracted but SUM itself is not', () => {
		assert.deepStrictEqual(refs('=SUM(A1,B1)'), ['A1', 'B1']);
	});
});

suite('W3 extractFormulaRefs -- string-literal protection', () => {
	test('an A1 inside a "..." string is NOT a ref; real refs around it are', () => {
		assert.deepStrictEqual(refs('=IF(A1>0,"A1 up","B1 dn")'), ['A1']);
	});

	test('an escaped "" inside a string does not end it', () => {
		assert.deepStrictEqual(refs('=A1&"say ""A1"""'), ['A1']);
	});
});

suite('W3 extractFormulaRefs -- sheet qualifiers', () => {
	test('an unquoted sheet-qualified ref keeps the sheet name and extracts the cell', () => {
		assert.deepStrictEqual(refs('=Sheet1!A1'), ['Sheet1!A1']);
		assert.deepStrictEqual(refs('=Sheet2!B2+A1'), ['Sheet2!B2', 'A1']);
	});

	test('a quoted sheet name keeps quotes verbatim; an A1-shaped substring inside is not a ref', () => {
		assert.deepStrictEqual(refs('=\'My Sheet\'!A1'), ['\'My Sheet\'!A1']);
		assert.deepStrictEqual(refs('=\'Q1 data\'!A1'), ['\'Q1 data\'!A1']);
		assert.deepStrictEqual(
			refs('=\'My Sheet\'!A1+Sheet2!B2'),
			['\'My Sheet\'!A1', 'Sheet2!B2'],
		);
	});

	test('a quoted sheet name with an escaped quote round-trips', () => {
		assert.deepStrictEqual(refs('=\'O\'\'Brien\'!A1'), ['\'O\'\'Brien\'!A1']);
	});

	test('HIGH: an UNQUOTED ref-shaped sheet name (S1!, Q1!) is the SHEET, not a same-sheet ref', () => {
		// The product seeds sheets S0/S1/S2 -- `S1` is ref-shaped (col S, row 1) but is a SHEET here. The
		// extracted ref must be `S1!A1`, NOT a same-sheet `S1` cell + an unqualified `A1`.
		assert.deepStrictEqual(refs('=S1!A1'), ['S1!A1']);
		assert.deepStrictEqual(refs('=Q1!A1'), ['Q1!A1']);
		assert.deepStrictEqual(refs('=S1!B2*2'), ['S1!B2']);
	});

	test('HIGH: an UNQUOTED DOTTED sheet name (Q1.2024!, A1.2024!) is NOT split at the dot', () => {
		// The engine emits `[A-Za-z0-9_.]` names UNQUOTED (printer.rs print_sheet_name); the `!` guard must
		// look PAST the inner dot, else `Q1.2024!A1` would mis-extract `Q1` as a ref.
		assert.deepStrictEqual(refs('=Q1.2024!A1'), ['Q1.2024!A1']);
		assert.deepStrictEqual(refs('=A1.2024!A1'), ['A1.2024!A1']);
		assert.deepStrictEqual(
			refs('=H1.2025!C3+Q2.2024!D4'),
			['H1.2025!C3', 'Q2.2024!D4'],
		);
		// The range's right endpoint inherits the dotted sheet (re-audit range-inheritance fix).
		assert.deepStrictEqual(refs('=SUM(Q1.2024!A1:B2)'), ['Q1.2024!A1', 'Q1.2024!B2']);
		// A non-ref-shaped dotted sheet was already safe -- regression guard.
		assert.deepStrictEqual(refs('=Data.2024!B5'), ['Data.2024!B5']);
	});

	test('HIGH: a ref-shaped sheet name with WHITESPACE before the ! (S1 !A1) is NOT a same-sheet ref', () => {
		// The lexer skips whitespace between a sheet name and `!`. The SEMANTIC sheet name excludes that lexer
		// padding (it is not part of the name), so `S1 !A1` extracts sheet `S1` (trimmed), NOT a same-sheet ref.
		assert.deepStrictEqual(refs('=S1 !A1'), ['S1!A1']);
		assert.deepStrictEqual(refs('=Q1 !A1'), ['Q1!A1']);
		// A tab is also lexer whitespace; it is trimmed from the semantic name.
		assert.deepStrictEqual(refs('=S1\t!A1'), ['S1!A1']);
		// Whitespace AFTER the ! is part of the cell side -- the cell ref is still found, sheet unchanged.
		assert.deepStrictEqual(refs('=S1! A1'), ['S1!A1']);
		// The semantic-name trim makes a whitespace-padded same-sheet ref compare equal to its sheet (the
		// provider's cross-sheet/self detection relies on this).
		const [r] = extractFormulaRefs('=S0 !B2');
		assert.strictEqual(r.sheet, 'S0', 'the semantic sheet name has no trailing space');
	});

	test('re-audit HIGH: quoted sheet name with WHITESPACE before the ! trims to the semantic name', () => {
		assert.deepStrictEqual(refs('=\'My Sheet\' !A1'), ['\'My Sheet\'!A1']);
		const [r] = extractFormulaRefs('=\'S0\' !B2');
		assert.strictEqual(r.sheet, '\'S0\'', 'quotes kept, trailing space trimmed');
	});

	test('re-audit HIGH: an unquoted sheet name STARTING with _ is scanned from its real start', () => {
		// The engine lexer allows a sheet name to start with `_` (`[A-Za-z_]...`). Without `_` as a scan-start,
		// `_Data!A1` would skip `_` and mis-extract `Data!A1` -- a wrong sheet, with no validator surface.
		assert.deepStrictEqual(refs('=_Data!A1'), ['_Data!A1']);
		assert.deepStrictEqual(refs('=_1!A1'), ['_1!A1']);
		const [r] = extractFormulaRefs('=_Data!A1');
		assert.strictEqual(r.sheet, '_Data');
	});
});

suite('W3 extractFormulaRefs -- numbers, brackets, errors', () => {
	test('scientific notation is never seen as a ref', () => {
		assert.deepStrictEqual(refs('=A1*2.5e3'), ['A1']);
		assert.deepStrictEqual(refs('=A1*1E-4'), ['A1']);
	});

	test('bracketed structured refs are skipped (A1 inside not extracted)', () => {
		assert.deepStrictEqual(refs('=Table1[Amount]+A1'), ['A1']);
		assert.deepStrictEqual(refs('=SUM(Table1[[#Data],[A1]])+A1'), ['A1']);
	});

	// FE-8.6 (2026-06-15): the bracket balancer is OOXML-ESCAPE-AWARE -- it skips each `'X` 2-char atom (the
	// engine's `escape_for_sref` `'`-escapes `[ ] # @ '` in column names), so an UNBALANCED bracket inside a name
	// can't mis-count depth and mis-attribute precedents. The A1 OUTSIDE the ref is the only precedent.
	test('FE-8.6: escaped structured-ref column names do not derail extraction (escape-aware balancer)', () => {
		// Unbalanced `[` -> `Sales[Net '[Margin]`: only the trailing A1 is a precedent (was swallowed pre-fix).
		assert.deepStrictEqual(refs('=SUM(Sales[Net \'[Margin])+A1'), ['A1']);
		// Unbalanced `]` -> `Sales[x']B2]`: `B2` is inside the column token (NOT a ref); `C3` outside IS.
		assert.deepStrictEqual(refs('=Sales[x\']B2]+C3'), ['C3']);
		// Balanced escaped name + `#`/`@`/`'` escapes: outside ref only.
		assert.deepStrictEqual(refs('=Sales[Net \'[Margin\']]+A1'), ['A1']);
		assert.deepStrictEqual(refs('=Sales[\'#Tot]+A1'), ['A1']);
		assert.deepStrictEqual(refs('=Sales[Bob\'\'s]+A1'), ['A1']);
	});

	test('re-audit HIGH: an EXTERNAL-workbook ref [N]Sheet!A1 is NOT emitted as a local edge', () => {
		// `[1]Sheet1!A1` / `[Book.xlsx]Data!C3` point into ANOTHER workbook -- emitting the cell as a local
		// precedent would fabricate an edge. The whole external ref (incl. a range right endpoint) is dropped;
		// a genuine local ref beside it is still extracted.
		assert.deepStrictEqual(refs('=[1]Sheet1!A1'), []);
		assert.deepStrictEqual(refs('=[1]Sheet1!A1:B2'), []);
		assert.deepStrictEqual(refs('=[1]A1'), []);
		assert.deepStrictEqual(refs('=[1]Sheet1!A1+A2'), ['A2']);
		assert.deepStrictEqual(refs('=[Book.xlsx]Data!C3+B1'), ['B1']);
	});

	test('a #REF! error literal is not mis-read as a ref', () => {
		// `#` is skipped, `REF` is consumed as a sheet-name-shaped run before `!`, which has no clean cell ref
		// after it -> nothing extracted. A real ref beside it still extracts.
		assert.deepStrictEqual(refs('=#REF!'), []);
		assert.deepStrictEqual(refs('=A1+#REF!'), ['A1']);
	});
});

suite('W3 extractFormulaRefs -- boundaries', () => {
	test('the widest valid column (XFD) and bottom row are extractable', () => {
		assert.deepStrictEqual(refs('=XFD1'), ['XFD1']);
		assert.deepStrictEqual(refs('=A1048576'), ['A1048576']);
	});

	test('an 8th row digit / a 4th column letter is not a clean ref (longer identifier)', () => {
		// `ABCD1` has a 4-letter column run -> not a ref (it is an identifier/name).
		assert.deepStrictEqual(refs('=ABCD1'), []);
		// `A12345678` has 8 row digits (> MAX_ROWS width) -> not a clean ref.
		assert.deepStrictEqual(refs('=A12345678'), []);
	});
});

suite('W3 extractFormulaRefs -- raw text fidelity', () => {
	test('raw carries the exact source slice incl. the sheet qualifier', () => {
		const [r] = extractFormulaRefs('=Sheet2!$A$1');
		assert.strictEqual(r.raw, 'Sheet2!$A$1');
		assert.strictEqual(r.sheet, 'Sheet2');
		assert.strictEqual(r.colAbs, true);
		assert.strictEqual(r.rowAbs, true);
	});

	test('raw of a quoted-sheet ref includes the quotes', () => {
		const [r] = extractFormulaRefs('=\'My Sheet\'!B3');
		assert.strictEqual(r.raw, '\'My Sheet\'!B3');
		assert.strictEqual(r.sheet, '\'My Sheet\'');
	});
});
