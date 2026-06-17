/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-3 colored references -- exhaustive unit tests for the pure range-aware, color-assigning ref scanner
// (`computeFormulaRefHighlights`). Mirrors the `extractFormulaRefs` + range-pick test corpus: single cell,
// duplicate-ref color reuse, distinct-ref color rotation, range-as-one-box, identical-range reuse,
// `$`-anchor color identity, string-literal / quoted-sheet / `[...]` / function-name protections, the
// sheet-qualified (non-drawable) contract, whole-column/row + structured non-matches, color-slot order
// (qualified refs do NOT consume a slot), source-text spans, extent clamping, the not-a-formula short
// circuit, and the malformed-input no-throw totality. The render-channel wiring (the colored box paint +
// the update triggers) is operator GUI smoke; this pins the transform.

import * as assert from 'assert';

import { computeFormulaRefHighlights, type RefHighlight } from '../src/quantbook/shared/formulaRefHighlights';
import { type SelectionRect } from '../src/quantbook/shared/gridLayoutA1';

function rect(minRow: number, maxRow: number, minCol: number, maxCol: number): SelectionRect {
	return { minRow, maxRow, minCol, maxCol };
}

/** Assert one highlight's full shape (rect by structural value, plus colorIndex / span / raw). */
function assertHi(h: RefHighlight, expected: { rect: SelectionRect | null; colorIndex: number; start?: number; end?: number; raw?: string }): void {
	assert.deepStrictEqual(h.rect, expected.rect, `rect for "${h.raw}"`);
	assert.strictEqual(h.colorIndex, expected.colorIndex, `colorIndex for "${h.raw}"`);
	if (expected.start !== undefined) {
		assert.strictEqual(h.start, expected.start, `start for "${h.raw}"`);
	}
	if (expected.end !== undefined) {
		assert.strictEqual(h.end, expected.end, `end for "${h.raw}"`);
	}
	if (expected.raw !== undefined) {
		assert.strictEqual(h.raw, expected.raw, 'raw');
	}
}

suite('FE-3 colored refs -- single cells + duplicate / distinct color assignment', () => {
	test('a single cell ref yields one box at its rect, color 0, with its text span', () => {
		const hs = computeFormulaRefHighlights('=A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, start: 1, end: 3, raw: 'A1' });
	});

	test('B2 maps to (row 1, col 1)', () => {
		const hs = computeFormulaRefHighlights('=B2');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(1, 1, 1, 1), colorIndex: 0 });
	});

	test('the SAME ref reused reuses its color (=A1+A1 -> both color 0)', () => {
		const hs = computeFormulaRefHighlights('=A1+A1');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, start: 1, end: 3 });
		assertHi(hs[1], { rect: rect(0, 0, 0, 0), colorIndex: 0, start: 4, end: 6 });
	});

	test('the module returns one entry PER textual ref incl. duplicates, all sharing the color (=A1+A1+A1 -> 3 entries, color 0)', () => {
		// CONTRACT: the pure module is per-textual-reference (a future formula-text-coloring wave tints every
		// ref substring, duplicates included). The GRID render channel (updateRefHighlights in index.ts) dedupes
		// by target rect so a reused ref paints ONE box -- that dedup is intentionally NOT in this module.
		const hs = computeFormulaRefHighlights('=A1+A1+A1');
		assert.strictEqual(hs.length, 3);
		for (const h of hs) {
			assertHi(h, { rect: rect(0, 0, 0, 0), colorIndex: 0 });
		}
	});

	test('two DISTINCT refs get two colors in appearance order (=A1+B2 -> 0,1)', () => {
		const hs = computeFormulaRefHighlights('=A1+B2');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0 });
		assertHi(hs[1], { rect: rect(1, 1, 1, 1), colorIndex: 1 });
	});

	test('three distinct args get three colors (=SUM(A1,B2,C3) -> 0,1,2; SUM not a ref)', () => {
		const hs = computeFormulaRefHighlights('=SUM(A1,B2,C3)');
		assert.strictEqual(hs.length, 3);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
		assertHi(hs[1], { rect: rect(1, 1, 1, 1), colorIndex: 1, raw: 'B2' });
		assertHi(hs[2], { rect: rect(2, 2, 2, 2), colorIndex: 2, raw: 'C3' });
	});

	test('color index keeps climbing past any palette size (renderer moduloes)', () => {
		const hs = computeFormulaRefHighlights('=A1+B1+C1+D1+E1+F1+G1+H1+I1');
		assert.strictEqual(hs.length, 9);
		assert.deepStrictEqual(hs.map(h => h.colorIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

suite('FE-3 colored refs -- ranges as one box', () => {
	test('a range is ONE box spanning both endpoints (=A1:B2 -> one rect)', () => {
		const hs = computeFormulaRefHighlights('=A1:B2');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 1, 0, 1), colorIndex: 0, start: 1, end: 6, raw: 'A1:B2' });
	});

	test('a reversed range normalizes (=B2:A1 -> the same min/max rect)', () => {
		const hs = computeFormulaRefHighlights('=B2:A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 1, 0, 1), colorIndex: 0, raw: 'B2:A1' });
	});

	test('lexer whitespace around the colon is tolerated (=A1 : B2 -> one range)', () => {
		const hs = computeFormulaRefHighlights('=A1 : B2');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 1, 0, 1), colorIndex: 0, raw: 'A1 : B2' });
	});

	test('an identical range reuses its color (=A1:B2+A1:B2 -> both color 0)', () => {
		const hs = computeFormulaRefHighlights('=A1:B2+A1:B2');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 1, 0, 1), colorIndex: 0 });
		assertHi(hs[1], { rect: rect(0, 1, 0, 1), colorIndex: 0 });
	});

	test('a range and a single cell at its corner are DISTINCT targets (=A1+A1:B2 -> 0,1)', () => {
		const hs = computeFormulaRefHighlights('=A1+A1:B2');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
		assertHi(hs[1], { rect: rect(0, 1, 0, 1), colorIndex: 1, raw: 'A1:B2' });
	});

	test('a single-cell-as-range A1:A1 shares the single A1 color (same target)', () => {
		const hs = computeFormulaRefHighlights('=A1+A1:A1');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0 });
		assertHi(hs[1], { rect: rect(0, 0, 0, 0), colorIndex: 0 });
	});

	test('a mid-formula range + trailing ref (=SUM(A1:A10)*B1 -> range color 0, B1 color 1)', () => {
		const hs = computeFormulaRefHighlights('=SUM(A1:A10)*B1');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 9, 0, 0), colorIndex: 0, raw: 'A1:A10' });
		assertHi(hs[1], { rect: rect(0, 0, 1, 1), colorIndex: 1, raw: 'B1' });
	});

	test('a range right endpoint glued to an identifier is NOT a range (=A1:B2foo -> A1 single)', () => {
		const hs = computeFormulaRefHighlights('=A1:B2foo');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});

	test('a CHAINED range collapses to ONE bounding box (=A1:B2:C3 -> A1:C3)', () => {
		const hs = computeFormulaRefHighlights('=A1:B2:C3');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 2, 0, 2), colorIndex: 0, start: 1, end: 9, raw: 'A1:B2:C3' });
	});

	test('a longer chain bounds all endpoints (=A1:B2:C3:D4 -> A1:D4)', () => {
		const hs = computeFormulaRefHighlights('=A1:B2:C3:D4');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 3, 0, 3), colorIndex: 0, raw: 'A1:B2:C3:D4' });
	});

	test('a QUALIFIED chained range stays ONE non-drawable -- no spurious current-sheet box for the tail endpoint (=Sheet1!A1:B2:C3)', () => {
		const hs = computeFormulaRefHighlights('=Sheet1!A1:B2:C3');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: null, colorIndex: -1, raw: 'Sheet1!A1:B2:C3' });
	});
});

suite('FE-3 colored refs -- $-anchoring is ignored for the box + color', () => {
	test('$A$1 and A1 share a rect AND a color (same target)', () => {
		const hs = computeFormulaRefHighlights('=$A$1+A1');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: '$A$1' });
		assertHi(hs[1], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});

	test('mixed anchors $A1 / A$1 / $A$1 all collapse to the same A1 target', () => {
		const hs = computeFormulaRefHighlights('=$A1+A$1+$A$1');
		assert.strictEqual(hs.length, 3);
		for (const h of hs) {
			assertHi(h, { rect: rect(0, 0, 0, 0), colorIndex: 0 });
		}
	});
});

suite('FE-3 colored refs -- protected spans yield no spurious boxes', () => {
	test('an A1 inside a string literal is not a ref (="A1" -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('="A1"'), []);
	});

	test('a string arg does not shadow a real ref (=A1&"B2" -> only A1)', () => {
		const hs = computeFormulaRefHighlights('=A1&"B2"');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});

	test('a function name shaped like a cell is not a ref (=LOG10(A1) -> only A1)', () => {
		const hs = computeFormulaRefHighlights('=LOG10(A1)');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});

	test('a structured ref column token is not a cell ref (=T[Col] -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=T[Col]'), []);
	});

	test('a structured ref does not shadow a following ref (=T[Col]+A1 -> only A1)', () => {
		const hs = computeFormulaRefHighlights('=T[Col]+A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});

	test('an external-workbook ref is dropped whole (=[1]Sheet1!A1+B2 -> only B2)', () => {
		const hs = computeFormulaRefHighlights('=[1]Sheet1!A1+B2');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(1, 1, 1, 1), colorIndex: 0, raw: 'B2' });
	});

	test('a whole-column ref is not a cell ref (=A:A -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=A:A'), []);
	});

	test('a whole-row ref is not a cell ref (=1:1 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=1:1'), []);
	});

	test('SUM(A:A) whole-column arg yields no box but the function still scans', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=SUM(A:A)'), []);
	});
});

suite('FE-3 colored refs -- sheet-qualified refs are non-drawable (v1 deferred)', () => {
	test('an unquoted-sheet ref is returned rect=null, colorIndex=-1', () => {
		const hs = computeFormulaRefHighlights('=Sheet2!A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: null, colorIndex: -1, raw: 'Sheet2!A1' });
	});

	test('a quoted-sheet ref is non-drawable', () => {
		const hs = computeFormulaRefHighlights('=\'My Sheet\'!A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: null, colorIndex: -1, raw: '\'My Sheet\'!A1' });
	});

	test('a qualified RANGE is one non-drawable highlight (=Sheet2!A1:B2)', () => {
		const hs = computeFormulaRefHighlights('=Sheet2!A1:B2');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: null, colorIndex: -1, raw: 'Sheet2!A1:B2' });
	});

	test('a quoted A1-shaped substring inside the sheet name is not a ref (=\'Q1 data\'!B2)', () => {
		const hs = computeFormulaRefHighlights('=\'Q1 data\'!B2');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: null, colorIndex: -1, raw: '\'Q1 data\'!B2' });
	});

	test('a ref-shaped unquoted sheet name is treated as a SHEET, not a same-sheet cell (=S1!A1)', () => {
		const hs = computeFormulaRefHighlights('=S1!A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: null, colorIndex: -1, raw: 'S1!A1' });
	});

	test('a qualified ref does NOT consume a color slot (=Sheet2!A1+B2 -> B2 is color 0)', () => {
		const hs = computeFormulaRefHighlights('=Sheet2!A1+B2');
		assert.strictEqual(hs.length, 2);
		assertHi(hs[0], { rect: null, colorIndex: -1 });
		assertHi(hs[1], { rect: rect(1, 1, 1, 1), colorIndex: 0, raw: 'B2' });
	});

	test('mix of qualified + bare keeps bare color slots dense (=A1+Sheet2!B2+A1 -> 0,-1,0)', () => {
		const hs = computeFormulaRefHighlights('=A1+Sheet2!B2+A1');
		assert.strictEqual(hs.length, 3);
		assert.deepStrictEqual(hs.map(h => h.colorIndex), [0, -1, 0]);
	});
});

suite('FE-3 colored refs -- extent clamping (out-of-extent refs do not match)', () => {
	test('the last valid cell XFD1048576 maps to the extent corner', () => {
		const hs = computeFormulaRefHighlights('=XFD1048576');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(1048575, 1048575, 16383, 16383), colorIndex: 0 });
	});

	test('a column past XFD is not a ref (=XFE1 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=XFE1'), []);
	});

	test('a row past the extent is not a ref (=A1048577 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=A1048577'), []);
	});

	test('an 8-digit row is not a ref (=A12345678 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=A12345678'), []);
	});
});

suite('FE-3 colored refs -- not-a-formula short circuit', () => {
	test('an empty string yields []', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights(''), []);
	});

	test('a plain value (no leading =) yields [] even if it looks like a ref', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('A1'), []);
		assert.deepStrictEqual(computeFormulaRefHighlights('A1:B2'), []);
	});

	test('a bare = with no refs yields []', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('='), []);
	});

	test('a numeric/literal formula yields [] (=1+2, =TODAY())', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=1+2'), []);
		assert.deepStrictEqual(computeFormulaRefHighlights('=TODAY()'), []);
	});

	test('scientific notation never seeds a ref scan (=2.5e3+A1 -> only A1)', () => {
		const hs = computeFormulaRefHighlights('=2.5e3+A1');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});
});

suite('FE-3 colored refs -- malformed input is total (no throw)', () => {
	test('an unterminated string does not throw (="A1 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('="A1'), []);
	});

	test('an unterminated quoted sheet does not throw (=\'A1 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=\'A1'), []);
	});

	test('an unterminated bracket does not throw (=[A1 -> [])', () => {
		assert.deepStrictEqual(computeFormulaRefHighlights('=[A1'), []);
	});

	test('a dangling operator does not throw (=A1+ -> only A1)', () => {
		const hs = computeFormulaRefHighlights('=A1+');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0 });
	});

	test('a dangling colon does not throw (=A1: -> A1 single, no range)', () => {
		const hs = computeFormulaRefHighlights('=A1:');
		assert.strictEqual(hs.length, 1);
		assertHi(hs[0], { rect: rect(0, 0, 0, 0), colorIndex: 0, raw: 'A1' });
	});
});
