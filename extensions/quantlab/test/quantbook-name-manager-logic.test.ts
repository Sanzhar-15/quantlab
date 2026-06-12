/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-5 W-N / W-T -- unit tests for the vscode-free, engine-free cores:
//  - nameManagerLogic: describeTarget / describeScope / goToAnchor / isGoToable over each NamedTargetJson
//    kind (cell / range / constant / formula), incl. the No-Fallbacks throws on malformed DTOs.
//  - tableUiLogic: the identifier validator + buildTableSpec selection -> TableSpecJson projection.
// The commands (quantbookCommands.ts) are thin vscode shells over these. Runs in the normal mocha suite
// (no engine, no vscode).

import * as assert from 'assert';

import {
	describeScope,
	describeTarget,
	goToAnchor,
	isGoToable,
} from '../src/quantbook/cellGrid/nameManagerLogic';
import {
	buildTableSpec,
	defaultColumnNames,
	isValidTableIdentifier,
	tableIdentifierRejectionReason,
} from '../src/quantbook/cellGrid/tableUiLogic';
import type { NamedRangeJson, NamedTargetJson } from '../src/quantbook/types';

// A sheet-name resolver fixture: sheet 0 = "Returns", sheet 1 = "Prices"; everything else is gone.
const sheetNameFor = (id: number): string | undefined => (id === 0 ? 'Returns' : id === 1 ? 'Prices' : undefined);

const cellTarget = (sheet: number, row: number, col: number): NamedTargetJson => ({ kind: 'cell', cell: { sheet, row, col } });
const rangeTarget = (sheet: number, startRow: number, startCol: number, endRow: number, endCol: number): NamedTargetJson => ({
	kind: 'range',
	range: { sheet, startRow, startCol, endRow, endCol },
});

suite('FE-5 W-N nameManagerLogic -- isGoToable', () => {
	test('cell + range targets are go-to-able', () => {
		assert.strictEqual(isGoToable(cellTarget(0, 1, 1)), true);
		assert.strictEqual(isGoToable(rangeTarget(0, 1, 1, 12, 1)), true);
	});
	test('constant + formula targets are NOT go-to-able', () => {
		assert.strictEqual(isGoToable({ kind: 'constant', value: { kind: 'number', number: 7 } }), false);
		assert.strictEqual(isGoToable({ kind: 'formula', formula: 'SUM(A1:A3)' }), false);
	});
});

suite('FE-5 W-N nameManagerLogic -- goToAnchor', () => {
	test('cell target -> its exact cell', () => {
		assert.deepStrictEqual(goToAnchor(cellTarget(1, 4, 2)), { sheet: 1, row: 4, col: 2 });
	});
	test('range target -> its TOP-LEFT (start) corner', () => {
		assert.deepStrictEqual(goToAnchor(rangeTarget(0, 1, 1, 12, 3)), { sheet: 0, row: 1, col: 1 });
	});
	test('constant / formula target -> undefined (no anchor)', () => {
		assert.strictEqual(goToAnchor({ kind: 'constant', value: { kind: 'number', number: 7 } }), undefined);
		assert.strictEqual(goToAnchor({ kind: 'formula', formula: 'TODAY()' }), undefined);
	});
	test('throws (No-Fallbacks) on a "cell" kind missing its payload', () => {
		assert.throws(() => goToAnchor({ kind: 'cell' }), /missing its `cell` payload/);
	});
	test('throws (No-Fallbacks) on a "range" kind missing its payload', () => {
		assert.throws(() => goToAnchor({ kind: 'range' }), /missing its `range` payload/);
	});
	test('throws (No-Fallbacks) on an unknown kind', () => {
		assert.throws(() => goToAnchor({ kind: 'bogus' as unknown as NamedTargetJson['kind'] }), /unknown named-target kind/);
	});
});

suite('FE-5 W-N nameManagerLogic -- describeTarget', () => {
	test('cell -> sheet-qualified A1 (1-based row, lettered col)', () => {
		assert.strictEqual(describeTarget(cellTarget(0, 1, 1), sheetNameFor), 'Returns!B2');
	});
	test('range -> sheet-qualified A1 range', () => {
		assert.strictEqual(describeTarget(rangeTarget(0, 1, 1, 12, 1), sheetNameFor), 'Returns!B2:B13');
	});
	test('single-cell range collapses to a bare cell', () => {
		assert.strictEqual(describeTarget(rangeTarget(1, 0, 0, 0, 0), sheetNameFor), 'Prices!A1');
	});
	test('a gone sheet surfaces #<id> rather than inventing a name', () => {
		assert.strictEqual(describeTarget(cellTarget(99, 0, 0), sheetNameFor), '#99!A1');
	});
	test('constant (number / text / boolean) -> "= <value>"', () => {
		assert.strictEqual(describeTarget({ kind: 'constant', value: { kind: 'number', number: 3.14 } }, sheetNameFor), '= 3.14');
		assert.strictEqual(describeTarget({ kind: 'constant', value: { kind: 'text', text: 'hi' } }, sheetNameFor), '= "hi"');
		assert.strictEqual(describeTarget({ kind: 'constant', value: { kind: 'boolean', boolean: true } }, sheetNameFor), '= TRUE');
	});
	test('formula -> "= <source>" (adds the leading =)', () => {
		assert.strictEqual(describeTarget({ kind: 'formula', formula: 'SUM(Returns!B2:B13)' }, sheetNameFor), '= SUM(Returns!B2:B13)');
	});
	test('throws (No-Fallbacks) on a constant missing its value payload', () => {
		assert.throws(() => describeTarget({ kind: 'constant' }, sheetNameFor), /missing its `value` payload/);
	});
});

suite('FE-5 W-N nameManagerLogic -- describeScope', () => {
	const wbName: NamedRangeJson = { name: 'TOTAL', target: cellTarget(0, 0, 0) };
	const sheetScoped: NamedRangeJson = { name: 'LOCAL', target: cellTarget(1, 0, 0), scope: 1 };
	const danglingScope: NamedRangeJson = { name: 'GHOST', target: cellTarget(0, 0, 0), scope: 99 };
	test('absent scope -> "Workbook"', () => {
		assert.strictEqual(describeScope(wbName, sheetNameFor), 'Workbook');
	});
	test('sheet scope -> the sheet display name', () => {
		assert.strictEqual(describeScope(sheetScoped, sheetNameFor), 'Prices');
	});
	test('dangling sheet scope -> #<id>', () => {
		assert.strictEqual(describeScope(danglingScope, sheetNameFor), '#99');
	});
});

suite('FE-5 W-T tableUiLogic -- identifier validation (shares the defined-name rules)', () => {
	test('accepts identifier-like table names', () => {
		// NB: "Tbl1" is a VALID cell reference (col Tbl, row 1) so it is REJECTED (shared defined-name rule),
		// exactly like the Define-Name validator -- use names that are not cell-ref-shaped.
		for (const n of ['Returns', 'Price_History', 'Tbl_1', '_scratch', 'Table10']) {
			assert.strictEqual(isValidTableIdentifier(n), true, `should accept ${n}`);
		}
	});
	test('rejects cell-ref-like + empty names with a reason', () => {
		assert.strictEqual(isValidTableIdentifier('A1'), false);
		assert.ok(tableIdentifierRejectionReason('A1'));
		assert.ok(tableIdentifierRejectionReason(''));
		assert.strictEqual(tableIdentifierRejectionReason('Returns'), undefined);
	});
});

suite('FE-5 W-T tableUiLogic -- defaultColumnNames', () => {
	test('Column1..N', () => {
		assert.deepStrictEqual(defaultColumnNames(3), ['Column1', 'Column2', 'Column3']);
	});
	test('throws on non-positive', () => {
		assert.throws(() => defaultColumnNames(0), /positive integer/);
		assert.throws(() => defaultColumnNames(-1), /positive integer/);
	});
});

suite('FE-5 W-T tableUiLogic -- buildTableSpec', () => {
	test('normalizes an inverted selection + derives rows/cols + default headers', () => {
		// Anchor at C5 (row 4, col 2), focus at A1 (row 0, col 0) -> normalized A1:C5 (3 cols x 5 rows).
		const spec = buildTableSpec('Returns', 0, 4, 2, 0, 0);
		assert.deepStrictEqual(spec, {
			name: 'Returns',
			sheet: 0,
			topRow: 0,
			topCol: 0,
			rows: 5,
			cols: 3,
			hasHeader: true,
			hasTotals: false,
			columnNames: ['Column1', 'Column2', 'Column3'],
		});
	});
	test('a single-cell selection -> a 1x1 table', () => {
		const spec = buildTableSpec('T', 1, 7, 7, 7, 7);
		assert.strictEqual(spec.rows, 1);
		assert.strictEqual(spec.cols, 1);
		assert.deepStrictEqual(spec.columnNames, ['Column1']);
	});
	test('throws (No-Fallbacks) on a non-integer sheet / corner', () => {
		assert.throws(() => buildTableSpec('T', 1.5, 0, 0, 0, 0), /sheet must be an integer/);
		assert.throws(() => buildTableSpec('T', 0, 0.5, 0, 0, 0), /must be an integer/);
	});
});
