/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-11 "Name box" -- unit tests for the vscode-free, engine-free core: the submit ROUTER
// (routeNameBoxSubmit: existing-name / A1-ref / define / error, with the disjoint-namespace precedence)
// and the untrusted-payload validator (parseNameBoxSubmitMessage). The webview + host shell are thin
// layers over these. Runs in the normal mocha suite (no engine, no vscode).

import * as assert from 'assert';

import { NameBoxSelection, routeNameBoxSubmit } from '../src/quantbook/cellGrid/nameBoxLogic';
import { matchNameForSelection } from '../src/quantbook/shared/nameMatch';
import { parseNameBoxSubmitMessage } from '../src/quantbook/cellGrid/cellGridLogic';
import { isValidDefinedName } from '../src/quantbook/cellGrid/nameDefineLogic';
import type { NamedRangeJson, SheetInfoJson } from '../src/quantbook/types';

const SHEETS: SheetInfoJson[] = [
	{ id: 0, name: 'Returns' },
	{ id: 1, name: 'Prices' },
];

const NAMES: NamedRangeJson[] = [
	// engine stores names UPPER-cased.
	{ name: 'RETURNS', target: { kind: 'range', range: { sheet: 0, startRow: 1, startCol: 1, endRow: 12, endCol: 1 } } }, // workbook range
	{ name: 'PRICE', target: { kind: 'cell', cell: { sheet: 0, row: 4, col: 2 } } }, // workbook cell
	{ name: 'PI', target: { kind: 'constant', value: { kind: 'number', number: 3.14159 } } }, // constant -- NO grid anchor
	{ name: 'LOCALSUM', target: { kind: 'range', range: { sheet: 1, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }, scope: 1 }, // sheet-scoped to sheet 1
	{ name: 'DUP', target: { kind: 'range', range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } } }, // workbook DUP
	{ name: 'DUP', target: { kind: 'range', range: { sheet: 0, startRow: 5, startCol: 5, endRow: 5, endCol: 5 } }, scope: 0 }, // sheet-0-scoped DUP
];

function sel(sheet = 0, anchorRow = 0, anchorCol = 0, focusRow = 0, focusCol = 0): NameBoxSelection {
	return { sheet, anchorRow, anchorCol, focusRow, focusCol };
}

suite('FE-11 nameBoxLogic -- routeNameBoxSubmit (existing name -> navigate-name)', () => {
	test('exact match navigates to the name', () => {
		const a = routeNameBoxSubmit('RETURNS', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'navigate-name');
		if (a.kind === 'navigate-name') {
			assert.strictEqual(a.name.name, 'RETURNS');
		}
	});

	test('match is case-insensitive (engine stores upper)', () => {
		const a = routeNameBoxSubmit('returns', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'navigate-name');
		if (a.kind === 'navigate-name') {
			assert.strictEqual(a.name.name, 'RETURNS');
		}
	});

	test('a constant name (no grid anchor) still routes navigate-name (host shows the no-anchor toast)', () => {
		const a = routeNameBoxSubmit('pi', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'navigate-name');
		if (a.kind === 'navigate-name') {
			assert.strictEqual(a.name.name, 'PI');
			assert.strictEqual(a.name.target.kind, 'constant');
		}
	});

	test('a name matching a valid define-shape (RETURNS) navigates -- step 1 beats step 3', () => {
		// RETURNS is itself a syntactically valid new name; the existing-name match must win.
		assert.strictEqual(isValidDefinedName('RETURNS'), true);
		const a = routeNameBoxSubmit('RETURNS', sel(0, 9, 9, 9, 9), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'navigate-name');
	});

	test('scope shadowing: a sheet-scoped name on the active sheet wins over the workbook one', () => {
		const a = routeNameBoxSubmit('dup', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'navigate-name');
		if (a.kind === 'navigate-name') {
			assert.strictEqual(a.name.scope, 0); // the sheet-0-scoped DUP (range at 5,5), not the workbook one
		}
	});

	test('scope shadowing: with no current-sheet match, the workbook-scoped name wins', () => {
		const a = routeNameBoxSubmit('dup', sel(1), NAMES, SHEETS); // active sheet 1; no DUP scoped to 1
		assert.strictEqual(a.kind, 'navigate-name');
		if (a.kind === 'navigate-name') {
			assert.strictEqual(a.name.scope, undefined); // the workbook DUP
		}
	});

	test('a name scoped to ANOTHER sheet is NOT resolved by bare entry (visibility) -- it falls through', () => {
		// LOCALSUM is scoped to sheet 1. On sheet 0 it is NOT referenceable by bare name (Excel: qualify it
		// `Sheet1!localsum`). FE-11 v2: a prior matches[0] fallback navigated cross-sheet; now it falls through
		// to the define path (localsum is a valid new name) -- matching the matched-name/dropdown visibility rule.
		const a = routeNameBoxSubmit('localsum', sel(0, 2, 2, 2, 2), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'define');
	});

	test('a sheet-scoped name IS resolved on its OWN sheet', () => {
		const a = routeNameBoxSubmit('localsum', sel(1, 0, 0, 0, 0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'navigate-name');
		if (a.kind === 'navigate-name') {
			assert.strictEqual(a.name.scope, 1);
		}
	});
});

suite('FE-11 nameBoxLogic -- routeNameBoxSubmit (A1 reference -> navigate-ref)', () => {
	test('a bare cell navigates to it on the active sheet', () => {
		const a = routeNameBoxSubmit('B5', sel(0), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 0, row: 4, col: 1 });
	});

	test('lowercase is accepted', () => {
		const a = routeNameBoxSubmit('b5', sel(0), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 0, row: 4, col: 1 });
	});

	test('a range navigates to its top-left', () => {
		const a = routeNameBoxSubmit('B5:D9', sel(0), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 0, row: 4, col: 1 });
	});

	test('an inverted range still lands on the normalized top-left', () => {
		const a = routeNameBoxSubmit('D9:B5', sel(0), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 0, row: 4, col: 1 });
	});

	test('a sheet-qualified ref resolves the named sheet', () => {
		const a = routeNameBoxSubmit('Prices!C3', sel(0), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 1, row: 2, col: 2 });
	});

	test('a sheet-qualified range lands on its top-left on the named sheet', () => {
		const a = routeNameBoxSubmit('Returns!A1:B2', sel(1), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 0, row: 0, col: 0 });
	});

	test('an unknown sheet in a qualified ref is a loud error (No-Fallbacks, not sheet-0)', () => {
		const a = routeNameBoxSubmit('Nope!A1', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.ok(a.reason.includes('Nope'));
		}
	});

	test('a malformed body after a known sheet is an error, NOT a fall-through to define', () => {
		const a = routeNameBoxSubmit('Prices!ZZ', sel(0), NAMES, SHEETS); // no row digits -> not a cell
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.ok(a.reason.includes('Prices'));
		}
	});

	test('sheet-name match is case-sensitive (engine sheet names are)', () => {
		const a = routeNameBoxSubmit('prices!C3', sel(0), NAMES, SHEETS); // lower-case sheet name
		assert.strictEqual(a.kind, 'error');
	});
});

suite('FE-11 nameBoxLogic -- routeNameBoxSubmit (new name -> define)', () => {
	test('a valid new name over a single cell defines a 1x1 range', () => {
		const a = routeNameBoxSubmit('revenue', sel(0, 2, 3, 2, 3), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'define');
		if (a.kind === 'define') {
			assert.strictEqual(a.name, 'revenue');
			assert.deepStrictEqual(a.range, { sheet: 0, startRow: 2, startCol: 3, endRow: 2, endCol: 3 });
		}
	});

	test('a valid new name over a multi-cell selection defines the normalized rectangle', () => {
		const a = routeNameBoxSubmit('block', sel(0, 1, 1, 5, 3), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'define');
		if (a.kind === 'define') {
			assert.deepStrictEqual(a.range, { sheet: 0, startRow: 1, startCol: 1, endRow: 5, endCol: 3 });
		}
	});

	test('corner order does not matter (the range is normalized)', () => {
		const a = routeNameBoxSubmit('block', sel(0, 5, 3, 1, 1), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'define');
		if (a.kind === 'define') {
			assert.deepStrictEqual(a.range, { sheet: 0, startRow: 1, startCol: 1, endRow: 5, endCol: 3 });
		}
	});

	test('a dotted name is valid', () => {
		const a = routeNameBoxSubmit('data.set', sel(0, 0, 0, 0, 0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'define');
	});

	test('define uses the selection sheet, not a typed one', () => {
		const a = routeNameBoxSubmit('onSheet1', sel(1, 0, 0, 2, 0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'define');
		if (a.kind === 'define') {
			assert.strictEqual(a.range.sheet, 1);
		}
	});
});

suite('FE-11 nameBoxLogic -- routeNameBoxSubmit (error)', () => {
	test('empty text is a loud error (defensive -- the webview should not post it)', () => {
		assert.strictEqual(routeNameBoxSubmit('', sel(0), NAMES, SHEETS).kind, 'error');
	});

	test('whitespace-only text is an error', () => {
		assert.strictEqual(routeNameBoxSubmit('   ', sel(0), NAMES, SHEETS).kind, 'error');
	});

	test('a leading-digit token is an error naming the rule', () => {
		const a = routeNameBoxSubmit('1abc', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.ok(/letter or an underscore/i.test(a.reason));
		}
	});

	test('an R1C1 form is an error (reserved)', () => {
		const a = routeNameBoxSubmit('R1C1', sel(0), NAMES, SHEETS);
		assert.strictEqual(a.kind, 'error');
		if (a.kind === 'error') {
			assert.ok(/R1C1|reserved/i.test(a.reason));
		}
	});

	test('a token with a space is an error', () => {
		assert.strictEqual(routeNameBoxSubmit('a b', sel(0), NAMES, SHEETS).kind, 'error');
	});
});

suite('FE-11 nameBoxLogic -- precedence + disjointness', () => {
	test('an A1-shaped token always navigates, never defines (even with a selection)', () => {
		// "A1" is a valid reference -> navigate-ref; it can never be a defined name.
		const a = routeNameBoxSubmit('A1', sel(0, 2, 2, 4, 4), NAMES, SHEETS);
		assert.deepStrictEqual(a, { kind: 'navigate-ref', sheet: 0, row: 0, col: 0 });
	});

	test('a valid A1 cell is never a valid defined name (the disjointness invariant)', () => {
		for (const ref of ['A1', 'B5', 'Z9', 'AB12', '$A$1', 'XFD1048576']) {
			assert.strictEqual(isValidDefinedName(ref), false, `${ref} must not be a valid name`);
		}
	});

	test('a stored name never contains a ":" or "!" (so it can never look like a ref/qualified ref)', () => {
		for (const n of NAMES) {
			assert.ok(!n.name.includes(':') && !n.name.includes('!'), `${n.name} must not contain : or !`);
		}
	});
});

suite('FE-11 parseNameBoxSubmitMessage (untrusted payload)', () => {
	const good = { type: 'nameBoxSubmit', text: 'B5', sheet: 0, selection: { anchorRow: 0, anchorCol: 0, focusRow: 1, focusCol: 2 } };

	test('accepts a well-formed message (flattened)', () => {
		assert.deepStrictEqual(parseNameBoxSubmitMessage(good), {
			text: 'B5', sheet: 0, anchorRow: 0, anchorCol: 0, focusRow: 1, focusCol: 2,
		});
	});

	test('tolerates an extraneous field (e.g. webviewId)', () => {
		const r = parseNameBoxSubmitMessage({ ...good, webviewId: 'sheets' });
		assert.ok(r !== undefined && r.text === 'B5');
	});

	test('rejects non-object / null', () => {
		assert.strictEqual(parseNameBoxSubmitMessage(null), undefined);
		assert.strictEqual(parseNameBoxSubmitMessage(42), undefined);
		assert.strictEqual(parseNameBoxSubmitMessage('nameBoxSubmit'), undefined);
	});

	test('rejects a wrong type tag', () => {
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, type: 'toolbarCommand' }), undefined);
	});

	test('rejects a non-string text', () => {
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, text: 5 }), undefined);
	});

	test('rejects a non-integer / negative / non-number sheet', () => {
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, sheet: 1.5 }), undefined);
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, sheet: -1 }), undefined);
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, sheet: '0' }), undefined);
	});

	test('rejects a missing selection', () => {
		assert.strictEqual(parseNameBoxSubmitMessage({ type: 'nameBoxSubmit', text: 'B5', sheet: 0 }), undefined);
	});

	test('rejects a selection with a missing / non-integer / negative corner', () => {
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, selection: { anchorRow: 0, anchorCol: 0, focusRow: 1 } }), undefined);
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, selection: { anchorRow: 0, anchorCol: 0, focusRow: 1, focusCol: 2.5 } }), undefined);
		assert.strictEqual(parseNameBoxSubmitMessage({ ...good, selection: { anchorRow: -1, anchorCol: 0, focusRow: 1, focusCol: 2 } }), undefined);
	});
});

suite('FE-11 v2 nameBoxLogic -- matchNameForSelection (selection -> name; Excel exact match)', () => {
	test('a single-cell selection at a `cell`-target name returns the name', () => {
		// PRICE is a `cell` target at sheet 0, row 4, col 2 (C5).
		assert.strictEqual(matchNameForSelection(sel(0, 4, 2, 4, 2), NAMES), 'PRICE');
	});

	test('a selection EXACTLY equal to a `range`-target name returns the name', () => {
		// RETURNS is sheet 0, rows 1..12, col 1 (B2:B13).
		assert.strictEqual(matchNameForSelection(sel(0, 1, 1, 12, 1), NAMES), 'RETURNS');
	});

	test('corner order does not matter (extent is normalized before matching)', () => {
		assert.strictEqual(matchNameForSelection(sel(0, 12, 1, 1, 1), NAMES), 'RETURNS');
	});

	test('a single cell INSIDE a named range (not equal to it) does NOT match -- shows the ref, like Excel', () => {
		// B3 (row 2, col 1) sits inside RETURNS but is not the whole range.
		assert.strictEqual(matchNameForSelection(sel(0, 2, 1, 2, 1), NAMES), undefined);
	});

	test('a sub-rectangle of a named range does NOT match', () => {
		assert.strictEqual(matchNameForSelection(sel(0, 1, 1, 5, 1), NAMES), undefined);
	});

	test('a `cell`-target name does NOT match a multi-cell selection', () => {
		assert.strictEqual(matchNameForSelection(sel(0, 4, 2, 5, 2), NAMES), undefined);
	});

	test('a constant name never matches (no grid extent)', () => {
		const onlyConst: NamedRangeJson[] = [{ name: 'PI', target: { kind: 'constant', value: { kind: 'number', number: 3.14 } } }];
		assert.strictEqual(matchNameForSelection(sel(0, 0, 0, 0, 0), onlyConst), undefined);
	});

	test('the target SHEET must match -- the same extent on another sheet is not the name', () => {
		// RETURNS extent but selection sheet 1 (RETURNS is workbook-scoped, yet its target lives on sheet 0).
		assert.strictEqual(matchNameForSelection(sel(1, 1, 1, 12, 1), NAMES), undefined);
		// PRICE cell extent on sheet 1 -- the cell target is on sheet 0.
		assert.strictEqual(matchNameForSelection(sel(1, 4, 2, 4, 2), NAMES), undefined);
	});

	test('scope filter: a sheet-scoped name matches only on its own sheet', () => {
		// LOCALSUM is scope 1, single cell (0,0) on sheet 1 -- matches on sheet 1...
		assert.strictEqual(matchNameForSelection(sel(1, 0, 0, 0, 0), NAMES), 'LOCALSUM');
		// ...and on sheet 0 the workbook DUP single-cell (0,0) matches instead (LOCALSUM is invisible here).
		assert.strictEqual(matchNameForSelection(sel(0, 0, 0, 0, 0), NAMES), 'DUP');
	});

	test('multiple names over the IDENTICAL extent: alphabetical by name (same scope)', () => {
		const same: NamedRangeJson[] = [
			{ name: 'BBB', target: { kind: 'range', range: { sheet: 0, startRow: 2, startCol: 2, endRow: 3, endCol: 3 } } },
			{ name: 'AAA', target: { kind: 'range', range: { sheet: 0, startRow: 2, startCol: 2, endRow: 3, endCol: 3 } } },
		];
		assert.strictEqual(matchNameForSelection(sel(0, 2, 2, 3, 3), same), 'AAA');
	});

	test('multiple names over the IDENTICAL extent: sheet-scoped shadows workbook (beats alphabetical)', () => {
		const same: NamedRangeJson[] = [
			{ name: 'AAA_WB', target: { kind: 'range', range: { sheet: 0, startRow: 2, startCol: 2, endRow: 3, endCol: 3 } } }, // workbook, alphabetically first
			{ name: 'ZZZ_LOCAL', target: { kind: 'range', range: { sheet: 0, startRow: 2, startCol: 2, endRow: 3, endCol: 3 } }, scope: 0 }, // sheet-scoped
		];
		// the sheet-scoped name wins even though ZZZ_LOCAL sorts AFTER AAA_WB.
		assert.strictEqual(matchNameForSelection(sel(0, 2, 2, 3, 3), same), 'ZZZ_LOCAL');
	});

	test('empty names list returns undefined (No-Fallbacks: the honest no-match)', () => {
		assert.strictEqual(matchNameForSelection(sel(0, 0, 0, 0, 0), []), undefined);
	});
});
