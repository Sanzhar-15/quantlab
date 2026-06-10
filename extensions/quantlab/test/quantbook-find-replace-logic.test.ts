/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 W1 "Find / Replace All in Workbook" -- unit tests for the vscode-free, engine-free core: the
// value-search-string reducer, the case/whole-cell matcher + global string replacer, the workbook hit
// scanner, the replace-op builder (value-vs-formula re-typing + the over-cap refusal), and the single-op
// builder. The command (quantbookCommands.ts) is a thin vscode shell over these. Runs in the normal mocha
// suite (no engine, no vscode).

import * as assert from 'assert';

import {
	MAX_REPLACE_OPS,
	buildReplaceAllOps,
	cellSearchTarget,
	findHitsInWorkbook,
	matchesCell,
	opForReplacedCell,
	replaceAllInString,
	valueSearchString,
	type FindReplaceQuery,
} from '../src/quantbook/cellGrid/findReplaceLogic';
import type { CellSnapshotJson, CellValueJson, SheetSnapshotJson, WorkbookSnapshotJson } from '../src/quantbook/types';

// --- snapshot builders (test fixtures) -------------------------------------------------------------

function num(n: number): CellValueJson { return { kind: 'number', number: n }; }
function txt(t: string): CellValueJson { return { kind: 'text', text: t }; }
function boolv(b: boolean): CellValueJson { return { kind: 'boolean', boolean: b }; }

function cell(row: number, col: number, opts: { value?: CellValueJson; formula?: string }): CellSnapshotJson {
	return { row, col, value: opts.value, formula: opts.formula };
}

function sheet(id: number, name: string, cells: CellSnapshotJson[]): SheetSnapshotJson {
	return { id, name, cells };
}

function workbook(sheets: SheetSnapshotJson[]): WorkbookSnapshotJson {
	return { sheets } as WorkbookSnapshotJson;
}

const baseQuery = (over: Partial<FindReplaceQuery> & { find: string }): FindReplaceQuery => ({
	matchCase: false,
	wholeCell: false,
	inFormulas: false,
	...over,
});

// --- valueSearchString -----------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- valueSearchString', () => {
	test('text returns its raw string', () => {
		assert.strictEqual(valueSearchString(txt('hello')), 'hello');
		assert.strictEqual(valueSearchString(txt('')), '');
	});
	test('number returns String(n)', () => {
		assert.strictEqual(valueSearchString(num(1234)), '1234');
		assert.strictEqual(valueSearchString(num(12.5)), '12.5');
		assert.strictEqual(valueSearchString(num(-7)), '-7');
	});
	test('boolean returns Excel-uppercase TRUE/FALSE', () => {
		assert.strictEqual(valueSearchString(boolv(true)), 'TRUE');
		assert.strictEqual(valueSearchString(boolv(false)), 'FALSE');
	});
	test('error / pending / blank / undefined are not searchable (undefined)', () => {
		assert.strictEqual(valueSearchString({ kind: 'error', error: '#REF!' }), undefined);
		assert.strictEqual(valueSearchString({ kind: 'pending' }), undefined);
		assert.strictEqual(valueSearchString({ kind: 'blank' }), undefined);
		assert.strictEqual(valueSearchString(undefined), undefined);
	});
	test('a declared kind missing its payload throws (No-Fallbacks)', () => {
		assert.throws(() => valueSearchString({ kind: 'text' }), /\[bad_argument\].*text/);
		assert.throws(() => valueSearchString({ kind: 'number' }), /\[bad_argument\].*number/);
		assert.throws(() => valueSearchString({ kind: 'boolean' }), /\[bad_argument\].*boolean/);
	});
});

// --- matchesCell -----------------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- matchesCell', () => {
	test('case-insensitive substring (default)', () => {
		assert.strictEqual(matchesCell('Hello World', 'world', false, false), true);
		assert.strictEqual(matchesCell('Hello World', 'WORLD', false, false), true);
		assert.strictEqual(matchesCell('Hello World', 'xyz', false, false), false);
	});
	test('case-sensitive substring', () => {
		assert.strictEqual(matchesCell('Hello World', 'World', true, false), true);
		assert.strictEqual(matchesCell('Hello World', 'world', true, false), false);
	});
	test('whole-cell case-insensitive equality', () => {
		assert.strictEqual(matchesCell('Total', 'total', false, true), true);
		assert.strictEqual(matchesCell('Total sum', 'total', false, true), false);
	});
	test('whole-cell case-sensitive equality', () => {
		assert.strictEqual(matchesCell('Total', 'Total', true, true), true);
		assert.strictEqual(matchesCell('Total', 'total', true, true), false);
	});
});

// --- replaceAllInString ----------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- replaceAllInString', () => {
	test('case-sensitive global substring replace', () => {
		assert.strictEqual(replaceAllInString('a-a-a', 'a', 'b', true, false), 'b-b-b');
		assert.strictEqual(replaceAllInString('foo Foo FOO', 'Foo', 'X', true, false), 'foo X FOO');
	});
	test('case-insensitive replace keeps surrounding casing, replaces every occurrence', () => {
		assert.strictEqual(replaceAllInString('Foo foo FOO', 'foo', 'bar', false, false), 'bar bar bar');
		assert.strictEqual(replaceAllInString('aXbXc', 'x', '-', false, false), 'a-b-c');
	});
	test('whole-cell replace swaps the entire string for the replacement', () => {
		assert.strictEqual(replaceAllInString('Total', 'total', 'Sum', false, true), 'Sum');
		assert.strictEqual(replaceAllInString('Total', 'Total', 'Sum', true, true), 'Sum');
	});
	test('empty replacement deletes the matched substring', () => {
		assert.strictEqual(replaceAllInString('a-b-c', '-', '', true, false), 'abc');
	});
	test('the needle is treated as a literal, not a regex', () => {
		// "." would match any char under regex; here it must match the literal dot only.
		assert.strictEqual(replaceAllInString('a.b.c', '.', '_', true, false), 'a_b_c');
		assert.strictEqual(replaceAllInString('aXbYc', '.', '_', true, false), 'aXbYc');
	});
	test('no match leaves the string unchanged', () => {
		assert.strictEqual(replaceAllInString('hello', 'zzz', 'X', false, false), 'hello');
	});
});

// --- cellSearchTarget ------------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- cellSearchTarget', () => {
	test('inFormulas ON + a formula cell -> the formula source (with leading =), replaceable', () => {
		const c = cell(0, 0, { value: num(42), formula: 'A1+1' });
		assert.deepStrictEqual(cellSearchTarget(c, true), { field: 'formula', text: '=A1+1', replaceable: true });
	});
	test('inFormulas OFF + a formula cell -> the cached VALUE, NOT replaceable (would clobber the formula)', () => {
		const c = cell(0, 0, { value: num(42), formula: 'A1+1' });
		assert.deepStrictEqual(cellSearchTarget(c, false), { field: 'value', text: '42', replaceable: false });
	});
	test('inFormulas ON + a pure literal cell -> the value (no formula to search), replaceable', () => {
		const c = cell(0, 0, { value: txt('hello') });
		assert.deepStrictEqual(cellSearchTarget(c, true), { field: 'value', text: 'hello', replaceable: true });
	});
	test('a non-searchable value (error) with no formula -> undefined', () => {
		const c = cell(0, 0, { value: { kind: 'error', error: '#REF!' } });
		assert.strictEqual(cellSearchTarget(c, false), undefined);
	});
	test('a formula-only pending cell, inFormulas OFF -> undefined (pending value not searchable)', () => {
		const c = cell(0, 0, { value: { kind: 'pending' }, formula: 'SLOW()' });
		assert.strictEqual(cellSearchTarget(c, false), undefined);
	});
});

// --- findHitsInWorkbook ----------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- findHitsInWorkbook', () => {
	const wb = workbook([
		sheet(0, 'Returns', [
			cell(0, 0, { value: txt('Total') }),
			cell(0, 1, { value: num(100) }),
			cell(1, 0, { value: txt('total cost') }),
			cell(1, 1, { value: num(42), formula: 'SUM(A1:A2)' }),
		]),
		sheet(1, 'Prices', [
			cell(0, 0, { value: txt('TOTAL') }),
			cell(0, 1, { value: { kind: 'error', error: '#REF!' } }),
		]),
	]);

	test('empty find text throws [bad_argument]', () => {
		assert.throws(() => findHitsInWorkbook(wb, baseQuery({ find: '' })), /\[bad_argument\].*non-empty/);
	});
	test('case-insensitive substring matches across sheets in reading order', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'total' }));
		// Returns!A1 "Total", Returns!A2 "total cost", Prices!A1 "TOTAL".
		assert.strictEqual(hits.length, 3);
		assert.deepStrictEqual(hits.map(h => `${h.sheetName}:${h.row},${h.col}:${h.field}`), [
			'Returns:0,0:value', 'Returns:1,0:value', 'Prices:0,0:value',
		]);
	});
	test('case-sensitive narrows the matches', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'Total', matchCase: true }));
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].sheetName, 'Returns');
		assert.strictEqual(hits[0].preview, 'Total');
	});
	test('whole-cell only matches exact cells', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'total', wholeCell: true }));
		// "Total" and "TOTAL" match whole-cell (case-insensitive); "total cost" does not.
		assert.strictEqual(hits.length, 2);
		assert.deepStrictEqual(hits.map(h => h.sheetName), ['Returns', 'Prices']);
	});
	test('inFormulas OFF does not match the formula source (only the cached value)', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'SUM' }));
		assert.strictEqual(hits.length, 0);
	});
	test('inFormulas ON matches the formula source and tags the field', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'SUM', inFormulas: true }));
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].field, 'formula');
		assert.strictEqual(hits[0].preview, '=SUM(A1:A2)');
	});
	test('a numeric value is searchable as its string form', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: '100' }));
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].row, 0);
		assert.strictEqual(hits[0].col, 1);
	});
	test('error cells are not searched', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'REF' }));
		assert.strictEqual(hits.length, 0);
	});
	test('a pure-literal value hit is flagged replaceable', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'Total' }));
		assert.ok(hits.length > 0);
		assert.ok(hits.every(h => h.replaceable), 'pure-literal hits are replaceable');
	});
	test('a formula cell matched on its cached value (inFormulas OFF) is LISTED but flagged NOT replaceable', () => {
		// A formula cell whose cached value contains the needle, searched in "Values" mode.
		const fwb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('hello'), formula: 'CONCAT("hello")' })])]);
		const hits = findHitsInWorkbook(fwb, baseQuery({ find: 'hello' }));
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].field, 'value');
		assert.strictEqual(hits[0].replaceable, false);
	});
	test('a formula-source hit (inFormulas ON) is flagged replaceable', () => {
		const hits = findHitsInWorkbook(wb, baseQuery({ find: 'SUM', inFormulas: true }));
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].replaceable, true);
	});
	test('a malformed coordinate throws (No-Fallbacks)', () => {
		const bad = workbook([sheet(0, 'S', [cell(-1, 0, { value: txt('x') })])]);
		assert.throws(() => findHitsInWorkbook(bad, baseQuery({ find: 'x' })), /\[bad_argument\].*extent/);
	});
});

// --- opForReplacedCell -----------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- opForReplacedCell', () => {
	test('a formula hit -> setFormula op with the leading = stripped', () => {
		const c = cell(2, 3, { value: num(1), formula: 'OLD(A1)' });
		const op = opForReplacedCell(0, c, 'formula', '=NEW(A1)');
		assert.deepStrictEqual(op, { kind: 'setFormula', sheet: 0, row: 2, col: 3, text: 'NEW(A1)' });
	});
	test('a formula replaced down to an empty body throws (No-Fallbacks)', () => {
		const c = cell(0, 0, { formula: 'X' });
		assert.throws(() => opForReplacedCell(0, c, 'formula', '='), /\[bad_argument\].*broken formula/);
		assert.throws(() => opForReplacedCell(0, c, 'formula', ''), /\[bad_argument\].*broken formula/);
	});
	test('a number value whose replaced form is still the same number stays a number op', () => {
		const c = cell(0, 0, { value: num(1234) });
		// "1234" -> "1239" (a digit replace that still parses cleanly) stays numeric.
		const op = opForReplacedCell(0, c, 'value', '1239');
		assert.deepStrictEqual(op, { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'number', number: 1239 } });
	});
	test('a number value whose replaced form is no longer numeric becomes a text op', () => {
		const c = cell(0, 0, { value: num(100) });
		const op = opForReplacedCell(0, c, 'value', '1X0');
		assert.deepStrictEqual(op, { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'text', text: '1X0' } });
	});
	test('a number value with a non-canonical numeric replaced form becomes text (no silent reformat)', () => {
		const c = cell(0, 0, { value: num(100) });
		// "100" -> "0100" parses to 100 but String(100) !== "0100", so we keep it faithful as text.
		const op = opForReplacedCell(0, c, 'value', '0100');
		assert.deepStrictEqual(op, { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'text', text: '0100' } });
	});
	test('a text value always re-types as text', () => {
		const c = cell(0, 0, { value: txt('foo') });
		const op = opForReplacedCell(0, c, 'value', 'bar');
		assert.deepStrictEqual(op, { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'text', text: 'bar' } });
	});
	test('a boolean value re-types as text after replace', () => {
		const c = cell(0, 0, { value: boolv(true) });
		const op = opForReplacedCell(0, c, 'value', 'TRUEISH');
		assert.deepStrictEqual(op, { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'text', text: 'TRUEISH' } });
	});
});

// --- buildReplaceAllOps ----------------------------------------------------------------------------

suite('FE-4 W1 findReplaceLogic -- buildReplaceAllOps', () => {
	test('empty find throws [bad_argument]', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('x') })])]);
		assert.throws(() => buildReplaceAllOps(wb, baseQuery({ find: '' })), /\[bad_argument\].*non-empty/);
	});
	test('replaces only matching cells, leaving untouched cells absent from the op list', () => {
		const wb = workbook([sheet(0, 'S', [
			cell(0, 0, { value: txt('foo') }),
			cell(0, 1, { value: txt('bar') }),
			cell(1, 0, { value: txt('foobar') }),
		])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'foo', replace: 'BAZ' }));
		// Only (0,0) and (1,0) contain "foo"; (0,1) "bar" is untouched.
		assert.strictEqual(ops.length, 2);
		assert.deepStrictEqual(ops.map(o => `${o.row},${o.col}`), ['0,0', '1,0']);
		assert.deepStrictEqual((ops[0].value as CellValueJson), { kind: 'text', text: 'BAZ' });
		assert.deepStrictEqual((ops[1].value as CellValueJson), { kind: 'text', text: 'BAZbar' });
	});
	test('an empty replace string deletes the matched substring', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('a-b-c') })])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: '-', replace: '' }));
		assert.strictEqual(ops.length, 1);
		assert.deepStrictEqual((ops[0].value as CellValueJson), { kind: 'text', text: 'abc' });
	});
	test('a missing replace defaults to empty (deletes the match)', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('xYx') })])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'Y' }));
		assert.deepStrictEqual((ops[0].value as CellValueJson), { kind: 'text', text: 'xx' });
	});
	test('inFormulas ON rewrites the formula source via setFormula (= stripped)', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: num(1), formula: 'OLD(A1)' })])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'OLD', replace: 'NEW', inFormulas: true }));
		assert.strictEqual(ops.length, 1);
		assert.deepStrictEqual(ops[0], { kind: 'setFormula', sheet: 0, row: 0, col: 0, text: 'NEW(A1)' });
	});
	test('inFormulas OFF does NOT replace a formula cell on its cached value (would clobber the formula)', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('OLD'), formula: 'CONCAT("OLD")' })])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'OLD', replace: 'NEW' }));
		// The formula cell's cached value matched but is NOT replaceable -> no op (No-Fallbacks: never a
		// silent destructive setValue over a formula). The operator must turn on "Search in formulas".
		assert.strictEqual(ops.length, 0);
	});
	test('inFormulas OFF still replaces a PURE-LITERAL cell on its value', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('OLD') })])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'OLD', replace: 'NEW' }));
		assert.strictEqual(ops.length, 1);
		assert.strictEqual(ops[0].kind, 'setValue');
		assert.deepStrictEqual((ops[0].value as CellValueJson), { kind: 'text', text: 'NEW' });
	});
	test('at most one op per cell (no duplicate coordinates)', () => {
		const wb = workbook([sheet(0, 'S', [
			cell(0, 0, { value: txt('aa'), formula: 'aa' }),
		])]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'a', replace: 'b', inFormulas: true }));
		assert.strictEqual(ops.length, 1);
		const coords = new Set(ops.map(o => `${o.sheet},${o.row},${o.col}`));
		assert.strictEqual(coords.size, ops.length);
	});
	test('a malformed sheet id throws (No-Fallbacks)', () => {
		const wb = workbook([sheet(70000, 'S', [cell(0, 0, { value: txt('x') })])]);
		assert.throws(() => buildReplaceAllOps(wb, baseQuery({ find: 'x', replace: 'y' })), /\[bad_argument\].*u16/);
	});
	test('over-cap (> MAX_REPLACE_OPS) is refused [bad_argument]', () => {
		// Build a single sheet with MAX_REPLACE_OPS + 1 matching cells (one column).
		const cells: CellSnapshotJson[] = [];
		for (let r = 0; r <= MAX_REPLACE_OPS; r++) {
			cells.push(cell(r, 0, { value: txt('foo') }));
		}
		const wb = workbook([sheet(0, 'S', cells)]);
		assert.throws(
			() => buildReplaceAllOps(wb, baseQuery({ find: 'foo', replace: 'bar' })),
			new RegExp(`\\[bad_argument\\].*${MAX_REPLACE_OPS}`),
		);
	});
	test('exactly MAX_REPLACE_OPS matching cells is accepted', () => {
		const cells: CellSnapshotJson[] = [];
		for (let r = 0; r < MAX_REPLACE_OPS; r++) {
			cells.push(cell(r, 0, { value: txt('foo') }));
		}
		const wb = workbook([sheet(0, 'S', cells)]);
		const ops = buildReplaceAllOps(wb, baseQuery({ find: 'foo', replace: 'bar' }));
		assert.strictEqual(ops.length, MAX_REPLACE_OPS);
	});
	test('no matches -> an empty op list (the command treats this as "nothing to replace")', () => {
		const wb = workbook([sheet(0, 'S', [cell(0, 0, { value: txt('hello') })])]);
		assert.strictEqual(buildReplaceAllOps(wb, baseQuery({ find: 'zzz', replace: 'q' })).length, 0);
	});
});
