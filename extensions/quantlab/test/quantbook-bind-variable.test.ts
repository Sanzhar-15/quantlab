/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 N-2 -- unit tests for the vscode-free core of "Bind Variable to Selected Cell": the A1
// column/cell formatter, the Python-identifier validator, and the injection-safe cell-source builder.
// The command itself (reactiveNotebookController.ts) is a thin vscode shell over these. Runs in the
// normal mocha suite (no ipykernel / no vscode).

import * as assert from 'assert';

import {
	buildBindPublishCellSource,
	buildBindPublishRangeCellSource,
	columnLabelA1,
	formatCellTarget,
	formatRangeTarget,
	isPublishableSheetName,
	isValidPublishVariableName,
	normalizeSelectionRect,
} from '../src/quantbook/reactiveNotebook/bindVariableLogic';

suite('N-2 bindVariableLogic -- columnLabelA1 (bijective base-26)', () => {
	test('first 26 columns map A..Z', () => {
		assert.strictEqual(columnLabelA1(0), 'A');
		assert.strictEqual(columnLabelA1(25), 'Z');
	});
	test('the Z -> AA boundary', () => {
		assert.strictEqual(columnLabelA1(26), 'AA');
		assert.strictEqual(columnLabelA1(27), 'AB');
		assert.strictEqual(columnLabelA1(51), 'AZ');
		assert.strictEqual(columnLabelA1(52), 'BA');
	});
	test('the ZZ -> AAA boundary', () => {
		assert.strictEqual(columnLabelA1(701), 'ZZ');
		assert.strictEqual(columnLabelA1(702), 'AAA');
	});
	test('a fractional index is floored; a negative index is empty', () => {
		assert.strictEqual(columnLabelA1(2.9), 'C');
		assert.strictEqual(columnLabelA1(-1), '');
	});
});

suite('N-2 bindVariableLogic -- formatCellTarget (1-based A1)', () => {
	test('A1 is (row 0, col 0)', () => {
		assert.strictEqual(formatCellTarget('S0', 0, 0), 'S0!A1');
	});
	test('B1 is (row 0, col 1) -- the seed-cell target', () => {
		assert.strictEqual(formatCellTarget('S0', 0, 1), 'S0!B1');
	});
	test('row is rendered 1-based, column bijective', () => {
		assert.strictEqual(formatCellTarget('Sheet1', 4, 2), 'Sheet1!C5');
		assert.strictEqual(formatCellTarget('S2', 99, 26), 'S2!AA100');
	});
});

suite('N-2 bindVariableLogic -- isValidPublishVariableName', () => {
	test('accepts plain identifiers', () => {
		for (const ok of ['x', 'price', '_hidden', 'a1', 'CamelCase', 'with_underscores_123']) {
			assert.strictEqual(isValidPublishVariableName(ok), true, `should accept ${ok}`);
		}
	});
	test('rejects empty / leading digit / spaces / punctuation / dots', () => {
		for (const bad of ['', '1x', 'a b', 'a-b', 'a.b', 'a(', 'qb.publish', ' x', 'x ']) {
			assert.strictEqual(isValidPublishVariableName(bad), false, `should reject "${bad}"`);
		}
	});
	test('rejects non-ASCII identifiers (the publish wire is ASCII-disciplined)', () => {
		assert.strictEqual(isValidPublishVariableName('naive'), true);
		// "naive" but with U+00EF in place of the i; built from char codes so THIS source stays ASCII-only.
		assert.strictEqual(isValidPublishVariableName(String.fromCharCode(110, 97, 239, 118, 101)), false);
	});
	test('rejects Python keywords', () => {
		for (const kw of ['class', 'def', 'return', 'None', 'True', 'False', 'import', 'lambda']) {
			assert.strictEqual(isValidPublishVariableName(kw), false, `should reject keyword ${kw}`);
		}
	});
});

suite('N-2 bindVariableLogic -- isPublishableSheetName', () => {
	test('accepts ordinary sheet names', () => {
		for (const ok of ['S0', 'Sheet1', 'My Data', 'Q1-2026', 'a.b']) {
			assert.strictEqual(isPublishableSheetName(ok), true, `should accept "${ok}"`);
		}
	});
	test('rejects names containing "!" (the resolver splits on the first "!")', () => {
		assert.strictEqual(isPublishableSheetName('A!B'), false);
		assert.strictEqual(isPublishableSheetName('!leading'), false);
		assert.strictEqual(isPublishableSheetName('trailing!'), false);
	});
	test('rejects an empty name', () => {
		assert.strictEqual(isPublishableSheetName(''), false);
	});
});

suite('N-2 bindVariableLogic -- buildBindPublishCellSource (injection-safe)', () => {
	test('a normal bind produces a runnable qb.publish line', () => {
		const src = buildBindPublishCellSource('price', 'S0', 0, 1);
		assert.ok(src.includes('qb.publish("price", price, "S0!B1")'), `got: ${src}`);
		// The comment is the first line; the call is the last line.
		const lines = src.split('\n');
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0].startsWith('# '), 'first line is a comment');
		assert.strictEqual(lines[1], 'qb.publish("price", price, "S0!B1")');
	});

	test('a sheet name with a double-quote stays a valid Python string literal (no break-out)', () => {
		const src = buildBindPublishCellSource('x', 'My"Sheet', 0, 0);
		// JSON.stringify escapes the inner quote -> a valid Python str literal "My\"Sheet!A1".
		assert.ok(src.includes('qb.publish("x", x, "My\\"Sheet!A1")'), `got: ${src}`);
		// Neither line contains an UNESCAPED closing quote that would terminate the string early:
		// every line is single-line (no stray newline injected from the target).
		assert.strictEqual(src.split('\n').length, 2);
	});

	test('a sheet name with a backslash is escaped', () => {
		const src = buildBindPublishCellSource('x', 'a\\b', 0, 0);
		assert.ok(src.includes('qb.publish("x", x, "a\\\\b!A1")'), `got: ${src}`);
	});

	test('the variable name is used both as the string key and the bare value expression', () => {
		const src = buildBindPublishCellSource('returns', 'S1', 2, 3);
		assert.ok(src.includes('qb.publish("returns", returns, "S1!D3")'), `got: ${src}`);
	});
});

// FE-1.5 N-2 follow-up (range-aware bind): a multi-cell selection publishes a 2D value across a RANGE.
suite('N-2 bindVariableLogic -- normalizeSelectionRect (anchor/focus, any corner order)', () => {
	const norm = { startRow: 0, startCol: 1, endRow: 2, endCol: 3 }; // the B1:D3 rect every order must yield
	test('anchor top-left, focus bottom-right', () => {
		assert.deepStrictEqual(normalizeSelectionRect(0, 1, 2, 3), norm);
	});
	test('anchor bottom-right, focus top-left (reversed)', () => {
		assert.deepStrictEqual(normalizeSelectionRect(2, 3, 0, 1), norm);
	});
	test('anchor top-right, focus bottom-left', () => {
		assert.deepStrictEqual(normalizeSelectionRect(0, 3, 2, 1), norm);
	});
	test('anchor bottom-left, focus top-right', () => {
		assert.deepStrictEqual(normalizeSelectionRect(2, 1, 0, 3), norm);
	});
	test('a collapsed selection (anchor === focus) yields a single-cell rect (start === end)', () => {
		assert.deepStrictEqual(normalizeSelectionRect(4, 2, 4, 2), { startRow: 4, startCol: 2, endRow: 4, endCol: 2 });
	});
});

suite('N-2 bindVariableLogic -- formatRangeTarget (normalized rect -> A1 range)', () => {
	test('a single-cell rect (start === end) collapses to a bare cell, identical to formatCellTarget', () => {
		assert.strictEqual(formatRangeTarget('S0', 0, 1, 0, 1), 'S0!B1');
		assert.strictEqual(formatRangeTarget('S0', 0, 1, 0, 1), formatCellTarget('S0', 0, 1));
		assert.strictEqual(formatRangeTarget('Sheet1', 4, 2, 4, 2), formatCellTarget('Sheet1', 4, 2));
	});
	test('a multi-cell rect renders top-left:bottom-right, rows 1-based', () => {
		assert.strictEqual(formatRangeTarget('S0', 0, 1, 2, 3), 'S0!B1:D3');
	});
	test('a single-row strip and a single-column strip', () => {
		assert.strictEqual(formatRangeTarget('S0', 0, 0, 0, 4), 'S0!A1:E1'); // one row, five cols
		assert.strictEqual(formatRangeTarget('S0', 0, 0, 4, 0), 'S0!A1:A5'); // five rows, one col
	});
	test('a far-extent range exercises bijective column rollover', () => {
		assert.strictEqual(formatRangeTarget('S2', 9, 26, 99, 27), 'S2!AA10:AB100');
	});
});

suite('N-2 bindVariableLogic -- buildBindPublishRangeCellSource (range, injection-safe)', () => {
	test('a single-cell rect is byte-identical to buildBindPublishCellSource (N-2 regression guard)', () => {
		assert.strictEqual(
			buildBindPublishRangeCellSource('price', 'S0', 0, 1, 0, 1),
			buildBindPublishCellSource('price', 'S0', 0, 1),
		);
	});
	test('a multi-cell range publishes to the range target with a 2D-value hint comment', () => {
		const src = buildBindPublishRangeCellSource('m', 'S0', 0, 1, 2, 3);
		const lines = src.split('\n');
		assert.strictEqual(lines.length, 2, 'comment line + call line');
		assert.ok(lines[0].startsWith('# '), 'first line is a comment');
		assert.ok(lines[0].includes('2D value'), `comment hints a 2D value; got: ${lines[0]}`);
		assert.ok(lines[0].includes('"S0!B1:D3"'), 'comment names the range target');
		assert.strictEqual(lines[1], 'qb.publish("m", m, "S0!B1:D3")');
	});
	test('a single-cell rect keeps the plain (no 2D-hint) comment', () => {
		const src = buildBindPublishRangeCellSource('x', 'S0', 0, 0, 0, 0);
		assert.ok(!src.includes('2D value'), `single-cell comment has no 2D hint; got: ${src}`);
		assert.ok(src.includes('qb.publish("x", x, "S0!A1")'), `got: ${src}`);
	});
	test('a hostile sheet name stays a valid Python string literal on a range target (no break-out)', () => {
		const src = buildBindPublishRangeCellSource('x', 'My"Sheet', 0, 0, 1, 1);
		assert.ok(src.includes('qb.publish("x", x, "My\\"Sheet!A1:B2")'), `got: ${src}`);
		assert.strictEqual(src.split('\n').length, 2, 'no stray newline injected from the target');
	});
});
