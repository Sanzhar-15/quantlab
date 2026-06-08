/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G copy/paste + fill -- unit tests for the A1 formula-reference translator (the shared
// correctness crux). Pinned exhaustively because both copy/paste and the fill handle depend on it and
// the webview UI is not headlessly testable. Covers relative/absolute/mixed offsets, ranges, sheet
// qualifiers, string-literal + function-name protection, scientific notation, and #REF! overflow.

import * as assert from 'assert';

import { translateFormulaRefs } from '../webview/sheets-webview/a1FormulaRefs';

suite('FE-1.5 a1FormulaRefs -- translateFormulaRefs', () => {
	test('a zero offset is a verbatim no-op', () => {
		assert.strictEqual(translateFormulaRefs('=A1+$B$2', 0, 0), '=A1+$B$2');
	});

	test('relative refs shift down (dRow), right (dCol), and both', () => {
		assert.strictEqual(translateFormulaRefs('=A1+B1', 1, 0), '=A2+B2');
		assert.strictEqual(translateFormulaRefs('=A1+B1', 0, 1), '=B1+C1');
		assert.strictEqual(translateFormulaRefs('=A1', 2, 3), '=D3');
	});

	test('absolute $ components stay fixed; relative ones move', () => {
		assert.strictEqual(translateFormulaRefs('=$A1', 1, 1), '=$A2', 'col fixed, row moves');
		assert.strictEqual(translateFormulaRefs('=A$1', 1, 1), '=B$1', 'row fixed, col moves');
		assert.strictEqual(translateFormulaRefs('=$A$1', 5, 5), '=$A$1', 'both fixed -> unchanged');
	});

	test('a mix of relative/absolute refs in one formula', () => {
		assert.strictEqual(translateFormulaRefs('=$A1+B$2+C3', 1, 1), '=$A2+C$2+D4');
	});

	test('a range offsets both endpoints; an absolute range is unchanged', () => {
		assert.strictEqual(translateFormulaRefs('=SUM(A1:B2)', 1, 0), '=SUM(A2:B3)');
		assert.strictEqual(translateFormulaRefs('=SUM($A$1:$B$2)', 3, 3), '=SUM($A$1:$B$2)');
	});

	test('function names are not mistaken for refs', () => {
		// LOG10 is ref-shaped (col LOG, row 10) but is a function call -> the `(` guard leaves it alone.
		assert.strictEqual(translateFormulaRefs('=LOG10(A1)', 1, 0), '=LOG10(A2)');
		assert.strictEqual(translateFormulaRefs('=SUM(A1,B1)', 0, 1), '=SUM(B1,C1)');
	});

	test('refs inside a string literal are preserved; real refs around it move', () => {
		assert.strictEqual(
			translateFormulaRefs('=IF(A1>0,"A1 up","B1 dn")', 1, 0),
			'=IF(A2>0,"A1 up","B1 dn")',
		);
		// An escaped "" inside the string does not end it.
		assert.strictEqual(translateFormulaRefs('=A1&"say ""A1"""', 1, 0), '=A2&"say ""A1"""');
	});

	test('sheet-qualified refs keep the sheet name verbatim and offset the coordinate', () => {
		assert.strictEqual(translateFormulaRefs('=Sheet1!A1', 1, 1), '=Sheet1!B2');
		assert.strictEqual(
			translateFormulaRefs('=\'My Sheet\'!A1+Sheet2!B2', 1, 0),
			'=\'My Sheet\'!A2+Sheet2!B3',
		);
		// A1-shaped text inside a quoted sheet name is not a ref.
		assert.strictEqual(translateFormulaRefs('=\'Q1 data\'!A1', 0, 1), '=\'Q1 data\'!B1');
	});

	test('column-letter rollover (Z -> AA) and reverse', () => {
		assert.strictEqual(translateFormulaRefs('=Z9', 0, 1), '=AA9');
		assert.strictEqual(translateFormulaRefs('=AA10', 0, -1), '=Z10');
	});

	test('a ref pushed off the grid becomes #REF!', () => {
		assert.strictEqual(translateFormulaRefs('=A1', -1, 0), '=#REF!', 'row above row 1');
		assert.strictEqual(translateFormulaRefs('=A1', 0, -1), '=#REF!', 'col left of A');
		assert.strictEqual(translateFormulaRefs('=XFD1', 0, 1), '=#REF!', 'col past XFD');
		// Only the overflowing ref becomes #REF!; the in-range sibling still moves.
		assert.strictEqual(translateFormulaRefs('=A1+B5', -1, 0), '=#REF!+B4');
	});

	test('numbers (incl. scientific notation) are never seen as refs', () => {
		assert.strictEqual(translateFormulaRefs('=1+2*3', 1, 1), '=1+2*3');
		assert.strictEqual(translateFormulaRefs('=A1*2.5e3', 1, 0), '=A2*2.5e3', 'e3 is an exponent, not a ref');
		assert.strictEqual(translateFormulaRefs('=A1*1E-4', 1, 0), '=A2*1E-4');
	});

	test('a bare literal (no formula refs) is unchanged', () => {
		assert.strictEqual(translateFormulaRefs('hello', 3, 3), 'hello');
		assert.strictEqual(translateFormulaRefs('=TODAY()', 5, 5), '=TODAY()');
	});

	test('a 3-letter column at the valid max offsets correctly', () => {
		// XFC (16382) + 1 col -> XFD (16383, the last column); +1 more -> #REF! (covered above).
		assert.strictEqual(translateFormulaRefs('=XFC1', 0, 1), '=XFD1');
	});

	test('megaudit HIGH: an UNQUOTED ref-shaped sheet name (S1!, Q1!) is NOT offset', () => {
		// `S1` is ref-shaped (col S, row 1) but is a SHEET name here; the `!` guard leaves it alone, and
		// only the coordinate after `!` moves. The product seeds sheets S0/S1/S2, so this is the real case.
		assert.strictEqual(translateFormulaRefs('=S1!A1', 1, 0), '=S1!A2');
		assert.strictEqual(translateFormulaRefs('=S1!A1', 0, 1), '=S1!B1');
		assert.strictEqual(translateFormulaRefs('=Q1!A1', 0, 1), '=Q1!B1');
		assert.strictEqual(translateFormulaRefs('=S1!B2*2', 1, 0), '=S1!B3*2');
	});

	test('megaudit: bottom-edge overflow (past MAX_ROWS) is #REF!', () => {
		assert.strictEqual(translateFormulaRefs('=A1048576', 1, 0), '=#REF!');
		// An absolute row at the max never overflows under an offset.
		assert.strictEqual(translateFormulaRefs('=A$1048576', 5, 0), '=A$1048576');
	});

	test('megaudit LOW: bracketed structured/external refs are copied verbatim (A1 inside not offset)', () => {
		assert.strictEqual(translateFormulaRefs('=Table1[Amount]+A1', 1, 0), '=Table1[Amount]+A2');
		assert.strictEqual(translateFormulaRefs('=SUM(Table1[[#Data],[A1]])+A1', 1, 0), '=SUM(Table1[[#Data],[A1]])+A2');
	});
});
