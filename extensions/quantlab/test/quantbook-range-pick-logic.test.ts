/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-3 range-pick / point mode -- exhaustive unit tests for the pure insertion-grammar core. Covers
// `canPointAtCaret` eligibility (operators/paren/comma/leading-`=`, the glued-to-token rejections, the
// string-literal / quoted-sheet / `[...]` protections, defensive caret clamping), `buildRefText` (single cell
// vs. normalised range), and `insertRefAtCaret` (insert, re-point replace, the malformed-span THROW, caret
// clamping). The pointer wiring (reading selectionStart, setPointerCapture, redraw) is operator smoke; this
// pins the transform.

import * as assert from 'assert';

import { buildRefText, canPointAtCaret, canPointAtRange, insertRefAtCaret, isRefTerminator } from '../src/quantbook/shared/formulaRangePick';
import { selectionRect, type SelectionRect } from '../src/quantbook/shared/gridLayoutA1';

function rect(minRow: number, maxRow: number, minCol: number, maxCol: number): SelectionRect {
	return { minRow, maxRow, minCol, maxCol };
}

suite('FE-3 range-pick -- canPointAtCaret: eligible positions', () => {
	test('the empty formula `=` (caret just past it) is eligible', () => {
		assert.strictEqual(canPointAtCaret('=', 1), true);
	});

	test('caret immediately after each operator / paren / comma is eligible', () => {
		assert.strictEqual(canPointAtCaret('=A1+', 4), true);
		assert.strictEqual(canPointAtCaret('=A1-', 4), true);
		assert.strictEqual(canPointAtCaret('=A1*', 4), true);
		assert.strictEqual(canPointAtCaret('=A1/', 4), true);
		assert.strictEqual(canPointAtCaret('=A1^', 4), true);
		assert.strictEqual(canPointAtCaret('=A1&', 4), true);
		assert.strictEqual(canPointAtCaret('=A1<', 4), true);
		assert.strictEqual(canPointAtCaret('=A1>', 4), true);
		assert.strictEqual(canPointAtCaret('=A1=', 4), true);
		assert.strictEqual(canPointAtCaret('=SUM(', 5), true);
		assert.strictEqual(canPointAtCaret('=SUM(A1,', 8), true);
	});

	test('trailing lexer whitespace before the caret is skipped', () => {
		assert.strictEqual(canPointAtCaret('=A1 + ', 6), true);
		assert.strictEqual(canPointAtCaret('=SUM( ', 6), true);
	});
});

suite('FE-3 range-pick -- canPointAtCaret: rejected positions', () => {
	test('glued to the right of a ref / number / function name is NOT eligible', () => {
		assert.strictEqual(canPointAtCaret('=A1', 3), false); // just past a ref
		assert.strictEqual(canPointAtCaret('=SU', 3), false); // inside a function name
		assert.strictEqual(canPointAtCaret('=1', 2), false); // just past a number
	});

	test('caret at/before the leading `=` is NOT eligible', () => {
		assert.strictEqual(canPointAtCaret('=', 0), false);
		assert.strictEqual(canPointAtCaret('=A1+', 0), false);
	});

	test('a non-formula value is never eligible', () => {
		assert.strictEqual(canPointAtCaret('A1', 2), false);
		assert.strictEqual(canPointAtCaret('123', 3), false);
		assert.strictEqual(canPointAtCaret('', 0), false);
	});

	test('inside a string literal / quoted sheet name / [...] is NOT eligible', () => {
		assert.strictEqual(canPointAtCaret('="hello, ', 8), false); // inside an (unterminated) string
		assert.strictEqual(canPointAtCaret('=\'My Sheet', 9), false); // inside a quoted sheet name
		assert.strictEqual(canPointAtCaret('=\'My Sheet\'!', 11), false); // glued to the `!` qualifier (cross-sheet deferred)
		assert.strictEqual(canPointAtCaret('=Table1[Col]', 9), false); // inside a structured `[...]` ref
	});

	test('a malformed caret (NaN / negative / past-end) is clamped, never throws', () => {
		assert.strictEqual(canPointAtCaret('=A1+', Number.NaN), false); // -> 0
		assert.strictEqual(canPointAtCaret('=A1+', -1), false); // -> 0
		assert.strictEqual(canPointAtCaret('=A1', 999), false); // -> 3 (glued to the ref)
	});

	test('a caret glued to the LEFT of an operand fuses tokens -> not eligible (M3)', () => {
		assert.strictEqual(canPointAtCaret('=A1+B2', 4), false); // before `B2` -> would glue the new ref onto B2
		assert.strictEqual(canPointAtCaret('=A1+ B2', 5), false); // whitespace then an operand on the right
		assert.strictEqual(canPointAtCaret('=A1+"x"', 4), false); // before a string literal
		assert.strictEqual(canPointAtCaret('=A1+(B2)', 4), false); // before an opening paren / group
	});

	test('a legit mid-formula operand slot (right side is a terminator) stays eligible', () => {
		assert.strictEqual(canPointAtCaret('=SUM(,B2)', 5), true); // after `(`, the right neighbour is `,`
		assert.strictEqual(canPointAtCaret('=SUM(A1,)', 8), true); // after `,`, the right neighbour is `)`
	});

	test('`%` is postfix, not binary -> a caret after it is NOT eligible (L1)', () => {
		assert.strictEqual(canPointAtCaret('=A1%', 4), false);
	});

	test('a caret inside a two-char comparison operator (`<=`/`>=`/`<>`) is NOT eligible (C-M3)', () => {
		assert.strictEqual(canPointAtCaret('=A1<=B2', 4), false); // between `<` and `=` -> would split `<=`
		assert.strictEqual(canPointAtCaret('=A1>=B2', 4), false); // between `>` and `=`
		assert.strictEqual(canPointAtCaret('=A1<>B2', 4), false); // between `<` and `>`
		// a SINGLE comparison operator, or a position AFTER a complete digraph, is still an eligible operand slot
		assert.strictEqual(canPointAtCaret('=A1<', 4), true);
		assert.strictEqual(canPointAtCaret('=A1<=', 5), true);
	});
});

suite('FE-3 range-pick -- canPointAtRange (selection replace)', () => {
	test('a selection whose surroundings are operand slots is eligible (Excel re-point)', () => {
		// `=B2+1`, the `B2` selected (start 1, end 3): left of 1 is `=`, right of 3 is `+` -> eligible.
		assert.strictEqual(canPointAtRange('=B2+1', 1, 3), true);
		assert.strictEqual(canPointAtRange('=B2+1', 3, 1), true); // reversed offsets normalise
	});

	test('the zero-width case equals canPointAtCaret (incl. the M3 right-glue reject)', () => {
		assert.strictEqual(canPointAtRange('=A1+', 4, 4), true);
		assert.strictEqual(canPointAtRange('=A1+B2', 4, 4), false);
	});

	test('a selection ending just before an operand is NOT eligible (would fuse on the right)', () => {
		assert.strictEqual(canPointAtRange('=B2C9', 1, 3), false); // right of end (`C`) is an operand char
	});

	test('a selection endpoint inside a protected span is rejected', () => {
		assert.strictEqual(canPointAtRange('="abc"', 2, 4), false); // both ends inside the string literal
	});
});

suite('FE-3 range-pick -- buildRefText', () => {
	test('a single cell yields a bare A1 ref', () => {
		assert.strictEqual(buildRefText(rect(0, 0, 0, 0)), 'A1');
		assert.strictEqual(buildRefText(rect(1, 1, 1, 1)), 'B2');
	});

	test('a multi-cell rect yields top-left:bottom-right', () => {
		assert.strictEqual(buildRefText(rect(0, 9, 1, 1)), 'B1:B10');
		assert.strictEqual(buildRefText(rect(0, 2, 0, 3)), 'A1:D3');
	});

	test('an inverted anchor/focus normalises via selectionRect', () => {
		// dragging from B10 up to B1 -> still B1:B10
		assert.strictEqual(buildRefText(selectionRect({ row: 9, col: 1 }, { row: 0, col: 1 })), 'B1:B10');
	});
});

suite('FE-3 range-pick -- insertRefAtCaret', () => {
	test('inserts at the caret and reports the span', () => {
		const r = insertRefAtCaret('=', 1, 'A1');
		assert.strictEqual(r.text, '=A1');
		assert.deepStrictEqual(r.span, { start: 1, end: 3 });
		assert.strictEqual(r.caret, 3);
	});

	test('inserts into the middle of a formula', () => {
		const r = insertRefAtCaret('=SUM(A1,)', 8, 'C3');
		assert.strictEqual(r.text, '=SUM(A1,C3)');
		assert.deepStrictEqual(r.span, { start: 8, end: 10 });
		assert.strictEqual(r.caret, 10);
	});

	test('re-point: replaces the previous span with a new cell ref', () => {
		const r = insertRefAtCaret('=A1', 3, 'B5', { start: 1, end: 3 });
		assert.strictEqual(r.text, '=B5');
		assert.deepStrictEqual(r.span, { start: 1, end: 3 });
		assert.strictEqual(r.caret, 3);
	});

	test('re-point: replaces a single-cell span with a range', () => {
		const r = insertRefAtCaret('=A1', 3, 'B2:B10', { start: 1, end: 3 });
		assert.strictEqual(r.text, '=B2:B10');
		assert.deepStrictEqual(r.span, { start: 1, end: 7 });
		assert.strictEqual(r.caret, 7);
	});

	test('a malformed prevSpan THROWS (No-Fallbacks)', () => {
		assert.throws(() => insertRefAtCaret('=A1', 1, 'B2', { start: 5, end: 2 })); // end < start
		assert.throws(() => insertRefAtCaret('=A1', 1, 'B2', { start: 1, end: 99 })); // end > length
		assert.throws(() => insertRefAtCaret('=A1', 1, 'B2', { start: -1, end: 2 })); // negative
	});

	test('a past-end caret clamps to the end, never throws', () => {
		const r = insertRefAtCaret('=A1', 999, 'B2');
		assert.strictEqual(r.text, '=A1B2');
		assert.deepStrictEqual(r.span, { start: 3, end: 5 });
		assert.strictEqual(r.caret, 5);
	});
});

suite('FE-3 range-pick -- isRefTerminator', () => {
	test('operators / paren / comma / whitespace terminate; operands do not', () => {
		for (const ch of [',', '(', '+', '-', '*', '/', '^', '&', '<', '>', '=', ' ', '\t']) {
			assert.strictEqual(isRefTerminator(ch), true, `expected ${JSON.stringify(ch)} to terminate`);
		}
		// `%` is postfix (excluded from REF_STARTERS), and `)`/`]` are closers -- none "terminate" a re-point token.
		for (const ch of ['A', '1', '_', '.', '$', ')', ']', '%']) {
			assert.strictEqual(isRefTerminator(ch), false, `expected ${JSON.stringify(ch)} to NOT terminate`);
		}
	});
});
