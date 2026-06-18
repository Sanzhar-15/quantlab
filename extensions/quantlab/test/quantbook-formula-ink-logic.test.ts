/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-3 / Wave D formula-TEXT coloring -- exhaustive unit tests for the pure `buildFormulaInkSegments`
// transform (the segment partition the colouring overlay renders). Sits on top of the already-exhaustively
// tested `computeFormulaRefHighlights` scanner, so these tests focus on the PARTITION contract: not-a-formula
// short circuit, default/coloured segment ordering, duplicate + `$`-anchor colour reuse, range-as-one-span,
// qualified refs folded into default text (R3b deferred), unbounded colour rotation, and -- the load-bearing
// one -- the COVERAGE INVARIANT (`join('') === text`) that keeps every colour aligned to its glyph. The DOM
// overlay (alignment / transparent input / caret / scroll / IME) is operator GUI smoke; this pins the transform.

import * as assert from 'assert';

import { buildFormulaInkSegments, type InkSegment } from '../src/quantbook/shared/formulaInk';

/** Assert the exact segment list (text + colorIndex, in order). */
function assertSegs(text: string, expected: InkSegment[]): void {
	assert.deepStrictEqual(buildFormulaInkSegments(text), expected, `segments for ${JSON.stringify(text)}`);
}

/** The alignment contract: concatenating every segment's text reproduces the input exactly, and no segment is empty. */
function assertCoverage(text: string): void {
	const segs = buildFormulaInkSegments(text);
	assert.strictEqual(segs.map(s => s.text).join(''), text, `coverage join for ${JSON.stringify(text)}`);
	for (const s of segs) {
		assert.ok(s.text.length > 0, `no empty segment in ${JSON.stringify(text)} (got ${JSON.stringify(segs)})`);
	}
}

suite('FE-3 formula-text ink -- not-a-formula short circuit', () => {
	test('empty string yields no segments (overlay stays off)', () => {
		assertSegs('', []);
	});
	test('a plain value (no leading =) yields no segments', () => {
		assertSegs('5', []);
		assertSegs('hello', []);
		assertSegs('A1', []); // a bare cell-looking value is NOT a formula
	});
});

suite('FE-3 formula-text ink -- single refs + default gaps', () => {
	test('a bare = is one default segment', () => {
		assertSegs('=', [{ text: '=', colorIndex: -1 }]);
	});
	test('a single cell ref splits into leading-= default + the coloured ref', () => {
		assertSegs('=A1', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
		]);
	});
	test('a ref with a trailing default remainder', () => {
		assertSegs('=A1+1', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: '+1', colorIndex: -1 },
		]);
	});
	test('operators and whitespace between refs stay default-coloured', () => {
		assertSegs('=A1 + B2', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: ' + ', colorIndex: -1 },
			{ text: 'B2', colorIndex: 1 },
		]);
	});
});

suite('FE-3 formula-text ink -- colour assignment (distinct / duplicate / $-anchor)', () => {
	test('two distinct targets get colours 0 then 1', () => {
		assertSegs('=A1+B2', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: '+', colorIndex: -1 },
			{ text: 'B2', colorIndex: 1 },
		]);
	});
	test('a duplicate ref reuses its colour (=A1+A1 -> both colour 0)', () => {
		assertSegs('=A1+A1', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: '+', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
		]);
	});
	test('$A$1 targets the same cell as A1 -> shares its colour', () => {
		assertSegs('=A1+$A$1', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: '+', colorIndex: -1 },
			{ text: '$A$1', colorIndex: 0 },
		]);
	});
	test('colour index is UNBOUNDED past the palette size (7 distinct refs -> 0..6)', () => {
		// The module never wraps; the renderer takes colorIndex modulo its (6-hue) palette. The 7th distinct
		// ref must carry colorIndex 6, not 0.
		const segs = buildFormulaInkSegments('=A1+A2+A3+A4+A5+A6+A7');
		const colours = segs.filter(s => s.colorIndex >= 0).map(s => s.colorIndex);
		assert.deepStrictEqual(colours, [0, 1, 2, 3, 4, 5, 6]);
	});
});

suite('FE-3 formula-text ink -- ranges as one coloured span', () => {
	test('A1:B2 is a single coloured segment (not two endpoints)', () => {
		assertSegs('=SUM(A1:B2)', [
			{ text: '=SUM(', colorIndex: -1 },
			{ text: 'A1:B2', colorIndex: 0 },
			{ text: ')', colorIndex: -1 },
		]);
	});
	test('a chained range A1:B2:C3 is one coloured span', () => {
		assertSegs('=A1:B2:C3', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1:B2:C3', colorIndex: 0 },
		]);
	});
});

suite('FE-3 formula-text ink -- non-ref tokens stay default', () => {
	test('a function name is not coloured', () => {
		assertSegs('=SUM(A1)', [
			{ text: '=SUM(', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: ')', colorIndex: -1 },
		]);
	});
	test('a cell-looking token inside a string literal is not coloured', () => {
		assertSegs('="A1"&B2', [
			{ text: '="A1"&', colorIndex: -1 },
			{ text: 'B2', colorIndex: 0 },
		]);
	});
});

suite('FE-3 formula-text ink -- qualified refs fold into default text (R3b deferred)', () => {
	test('a sheet-qualified ref is NOT coloured (whole formula stays default)', () => {
		// computeFormulaRefHighlights returns it with colorIndex -1; the builder folds it into a default gap.
		assertSegs('=Sheet1!A1', [{ text: '=Sheet1!A1', colorIndex: -1 }]);
	});
	test('a qualified + an unqualified ref: only the unqualified one is coloured', () => {
		assertSegs('=Sheet1!A1+B2', [
			{ text: '=Sheet1!A1+', colorIndex: -1 },
			{ text: 'B2', colorIndex: 0 },
		]);
	});
	test('unqualified FIRST, qualified second: only the unqualified is coloured (cursor-advance path)', () => {
		// The reverse ordering of the case above -- a coloured segment is emitted first (cursor advances),
		// then the qualified skip fires with cursor > 0 and the trailing remainder absorbs the qualified ref.
		assertSegs('=A1+Sheet1!B2', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: '+Sheet1!B2', colorIndex: -1 },
		]);
	});
	test('a qualified ref SANDWICHED between two unqualified refs folds into the default gap', () => {
		// A1 -> slot 0; the qualified Sheet1!C3 consumes NO colour slot (folds into the gap); B2 -> slot 1.
		assertSegs('=A1+Sheet1!C3+B2', [
			{ text: '=', colorIndex: -1 },
			{ text: 'A1', colorIndex: 0 },
			{ text: '+Sheet1!C3+', colorIndex: -1 },
			{ text: 'B2', colorIndex: 1 },
		]);
	});
});

suite('FE-3 formula-text ink -- coverage invariant (join === text, no empty segments)', () => {
	const corpus = [
		'=',
		'=A1',
		'=A1+B2',
		'=A1+A1+A1',
		'=A1+$A$1',
		'=SUM(A1:B2)',
		'=A1:B2:C3',
		'=SUM(A1, B2, C3)',
		'="A1"&B2',
		'=Sheet1!A1',
		'=Sheet1!A1+B2',
		'=\'My Sheet\'!A1:B2 + Z9',
		'=IF(A1>0, B2*C3, -D4)',
		'=A1+A2+A3+A4+A5+A6+A7+A8',
		'=  A1   +   B2  ',
		'=A1+', // trailing operator (mid-typing)
		'="unterminated', // malformed body -- builder stays total
		'=A1:', // dangling colon (mid-typing)
		'=A1+Sheet1!B2', // unqualified then qualified (cursor-advance, then qualified-skip into the remainder)
		'=A1+Sheet1!C3+B2', // qualified sandwiched between two unqualified refs
		'=Sheet1!A1+Sheet2!B2', // two qualified refs, no unqualified -> whole string default-coloured
		'=A1 : B2', // whitespace-padded range -> ONE coloured span including the interior spaces
		'=SUM(A1', // unclosed paren (mid-typing) -> SUM default, A1 coloured, empty trailing remainder
	];
	for (const t of corpus) {
		test(`coverage holds for ${JSON.stringify(t)}`, () => {
			assertCoverage(t);
		});
	}
});
