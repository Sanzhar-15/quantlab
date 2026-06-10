/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 F4 -- exhaustive unit tests for the pure abs/rel ref-cycle helper. Covers the full cycle on plain
// refs, every starting `$` form, ranges (which endpoint cycles by caret + the `:`-cycles-both rule), sheet
// qualifiers (unquoted + dotted + quoted), the caret-off-a-ref no-op, function-name + string-literal
// protection, and the caret preservation that lets a repeated F4 keep cycling the same ref. The webview
// wiring (reading selectionStart, writing the value back) is operator smoke; this pins the transform.

import * as assert from 'assert';

import { cycleRefAbsRel } from '../webview/sheets-webview/f4Logic';

/** Cycle once and return the formula (or null). */
function cyc(formula: string, caret: number): string | null {
	const r = cycleRefAbsRel(formula, caret);
	return r === null ? null : r.formula;
}

suite('FE-4 f4Logic -- cycleRefAbsRel: the four-step cycle', () => {
	test('A1 -> $A$1 -> A$1 -> $A1 -> A1 (caret on the ref)', () => {
		// caret on the column letter (index 1, just past `=`).
		assert.strictEqual(cyc('=A1', 1), '=$A$1');
		assert.strictEqual(cyc('=$A$1', 1), '=A$1');
		assert.strictEqual(cyc('=A$1', 1), '=$A1');
		assert.strictEqual(cyc('=$A1', 1), '=A1');
	});

	test('a repeated F4 cycles the SAME ref (caret preserved just past it)', () => {
		// Start at caret on 'A'; each step returns a caret we feed back in.
		let formula = '=A1+B2';
		let caret = 1;
		let r = cycleRefAbsRel(formula, caret)!;
		assert.strictEqual(r.formula, '=$A$1+B2');
		formula = r.formula;
		caret = r.caretPos;
		r = cycleRefAbsRel(formula, caret)!;
		assert.strictEqual(r.formula, '=A$1+B2', 'second F4 still cycles A1, not B2');
		formula = r.formula;
		caret = r.caretPos;
		r = cycleRefAbsRel(formula, caret)!;
		assert.strictEqual(r.formula, '=$A1+B2', 'third F4 still cycles A1');
		formula = r.formula;
		caret = r.caretPos;
		r = cycleRefAbsRel(formula, caret)!;
		assert.strictEqual(r.formula, '=A1+B2', 'fourth F4 returns A1 to relative -- full loop');
	});

	test('caret at the END of the ref (just past the digit) still cycles it', () => {
		assert.strictEqual(cyc('=A1', 3), '=$A$1'); // caret at index 3 == end of "A1"
	});

	test('caret in the MIDDLE of the ref (between letter and digit) cycles it', () => {
		assert.strictEqual(cyc('=A1', 2), '=$A$1'); // caret between 'A' and '1'
	});
});

suite('FE-4 f4Logic -- multiple refs: the caret picks which one cycles', () => {
	test('=A1+B2 -- caret on A1 cycles A1; caret on B2 cycles B2', () => {
		assert.strictEqual(cyc('=A1+B2', 1), '=$A$1+B2'); // on A1
		assert.strictEqual(cyc('=A1+B2', 4), '=A1+$B$2'); // on B2 (index 4 == 'B')
	});

	test('caret between the refs (on the operator) is not on any ref -> no-op', () => {
		// caret at index 3 -- the `+`; not on A1 (end 3, so it IS on A1's end) ... use index of `+`'s right side.
		// "=A1+B2": indices: =0 A1 B2... A at1 1at2 +at3 Bat4. Caret at 3 is A1.end -> cycles A1.
		// Put the caret AFTER the operator but using a 2-char gap so it is on neither.
		assert.strictEqual(cyc('=A1 + B2', 4), null); // index 4 is the space before '+'; not on a ref
	});

	test('boundary tie -- caret exactly at A1.end which equals nothing-glued -> the touched ref wins', () => {
		// "=A1+B2": caret at index 3 (A1.end). A1 is [1,3); 3 == end so caretOnRef(A1) true; B2 starts at 4.
		assert.strictEqual(cyc('=A1+B2', 3), '=$A$1+B2');
	});
});

suite('FE-4 f4Logic -- ranges', () => {
	test('caret on the LEFT endpoint cycles only it', () => {
		assert.strictEqual(cyc('=SUM(A1:B2)', 5), '=SUM($A$1:B2)'); // index 5 == 'A'
	});

	test('caret on the RIGHT endpoint cycles only it', () => {
		assert.strictEqual(cyc('=SUM(A1:B2)', 8), '=SUM(A1:$B$2)'); // index 8 == 'B'
	});

	test('caret ON the `:` operator cycles BOTH endpoints', () => {
		// "=SUM(A1:B2)": '(' at 4, A1 [5,7), ':' at 7, B2 [8,10).
		assert.strictEqual(cyc('=SUM(A1:B2)', 7), '=SUM($A$1:$B$2)');
	});

	test('caret just after the `:` (on the right ref start) cycles the right ref alone, not both', () => {
		// index 8 == 'B' -> on the right ref's span, not on the `:` -> single-ref path.
		assert.strictEqual(cyc('=SUM(A1:B2)', 8), '=SUM(A1:$B$2)');
	});

	test('a both-cycle advances a mixed range one step each', () => {
		// $A$1:B2 with caret on `:`. $A$1 (both) -> A$1; B2 (rel) -> $B$2.
		// "=$A$1:B2": = at0, $A$1 [1,5), ':' at5, B2 [6,8).
		assert.strictEqual(cyc('=$A$1:B2', 5), '=A$1:$B$2');
	});

	test('a fully-absolute range cycles both off absolute', () => {
		// "=$A$1:$B$2": '$A$1' [1,5), ':' at5, '$B$2' [6,10).  both -> A$1 / B$2.
		assert.strictEqual(cyc('=$A$1:$B$2', 5), '=A$1:B$2');
	});
});

suite('FE-4 f4Logic -- sheet qualifiers (the coordinate cycles, the qualifier is verbatim)', () => {
	test('unquoted sheet prefix: S1!A1 -- only A1 cycles, S1! is preserved', () => {
		// "=S1!A1": 'S1!' is a sheet qualifier; the A1 after it is the ref.
		assert.strictEqual(cyc('=S1!A1', 4), '=S1!$A$1'); // index 4 == 'A'
	});

	test('a ref-shaped sheet name (S1) before `!` is NOT cycled as a ref', () => {
		// caret on the 'S1' part -> S1 is a sheet qualifier (a run ending in `!`), not a ref -> no-op there.
		assert.strictEqual(cyc('=S1!A1', 1), null); // index 1 == 'S' (inside the qualifier)
	});

	test('dotted unquoted sheet name: Q1.2024!A1 -- only A1 cycles', () => {
		// "=Q1.2024!A1": qualifier "Q1.2024!" then A1.  index of 'A' = 9.
		assert.strictEqual(cyc('=Q1.2024!A1', 9), '=Q1.2024!$A$1');
	});

	test('whitespace-padded qualifier: "S1 !A1" -- the coordinate still cycles', () => {
		// "=S1 !A1": qualifier "S1 !" (space accepted by the lexer), then A1.  'A' index = 5.
		assert.strictEqual(cyc('=S1 !A1', 5), '=S1 !$A$1');
	});

	test('quoted sheet name: \'My Sheet\'!A1 -- only A1 cycles, the quoted name is verbatim', () => {
		const f = '=\'My Sheet\'!A1';
		// "=" 0, "'My Sheet'" [1,11), "!" 11, "A1" [12,14).  'A' index = 12.
		assert.strictEqual(cyc(f, 12), '=\'My Sheet\'!$A$1');
	});

	test('caret inside a quoted sheet name -> no-op (it is not a ref)', () => {
		assert.strictEqual(cyc('=\'My Sheet\'!A1', 3), null); // index 3 inside 'My Sheet'
	});

	test('a qualified range cycles both coordinates, qualifier preserved', () => {
		// "=S1!A1:B2": qualifier "S1!", then A1, ':', B2.  ':' index: =0 S1!=1..3 A1=4..5 :=6 B2=7..8.
		assert.strictEqual(cyc('=S1!A1:B2', 6), '=S1!$A$1:$B$2');
	});
});

suite('FE-4 f4Logic -- no-op cases (No-Fallbacks: never guess a ref)', () => {
	test('a formula with NO refs -> null', () => {
		assert.strictEqual(cycleRefAbsRel('=1+2*3', 1), null);
		assert.strictEqual(cycleRefAbsRel('=SUM(1,2)', 5), null);
		assert.strictEqual(cycleRefAbsRel('hello', 2), null);
	});

	test('caret on the `=` (not on a ref) -> null', () => {
		assert.strictEqual(cyc('=A1', 0), null);
	});

	test('caret in trailing whitespace away from any ref -> null', () => {
		assert.strictEqual(cyc('=A1   ', 5), null);
	});

	test('a function name that is ref-shaped is NOT cycled (the `(` guard)', () => {
		// LOG10 is ref-shaped (col LOG -> but >3 letters, so it never matches a col anyway). Caret on it -> no-op.
		assert.strictEqual(cyc('=LOG10(A1)', 2), null);
		// A real ref inside still cycles when the caret is on it.
		assert.strictEqual(cyc('=LOG10(A1)', 7), '=LOG10($A$1)'); // index 7 == 'A' inside the parens
	});

	test('a ref-shaped token inside a string literal is NOT cycled', () => {
		// "=IF(A1>0,\"A1 up\",0)": the A1 inside the quotes must not cycle; the real A1 does.
		const f = '=IF(A1>0,"A1 up",0)';
		// caret inside the string literal "A1 up": find index of the quoted A's. '"' at 9, then 'A' at 10.
		assert.strictEqual(cyc(f, 10), null, 'the A1 inside the string is not a ref');
		// the real A1 (index 4) cycles.
		assert.strictEqual(cyc(f, 4), '=IF($A$1>0,"A1 up",0)');
	});

	test('a bracketed structured ref is skipped (no A1 to cycle inside it)', () => {
		// "=Table1[A1]" -- the "A1" is a column token, not a cell ref.
		assert.strictEqual(cyc('=Table1[A1]', 8), null);
	});
});

suite('FE-4 f4Logic -- caret clamping + boundary safety', () => {
	test('a caret past the end is clamped (still finds a trailing ref at its end)', () => {
		assert.strictEqual(cyc('=A1', 999), '=$A$1'); // clamped to length 3 == A1.end
	});

	test('a negative caret is clamped to 0 (on the `=`, not a ref) -> null', () => {
		assert.strictEqual(cyc('=A1', -5), null);
	});

	test('a bare ref with no leading `=` still cycles (the editor only calls this in formula mode, but the helper is `=`-agnostic)', () => {
		assert.strictEqual(cyc('A1', 0), '$A$1');
	});

	test('multi-letter columns and multi-digit rows round-trip', () => {
		assert.strictEqual(cyc('=AA10', 1), '=$AA$10');
		assert.strictEqual(cyc('=$AA$10', 1), '=AA$10');
		assert.strictEqual(cyc('=XFD1048576', 1), '=$XFD$1048576'); // the grid's max cell
	});
});
