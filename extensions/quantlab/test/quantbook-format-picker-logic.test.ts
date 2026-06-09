/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G "Set Cell Format" -- unit tests for the vscode-free core of the number-formats picker:
// the preset -> format-string map, the preset-label helper, the setFormat op-builder over a rectangle
// (coordinate validation + the batch-cell cap), and the undo-label builder. The command itself
// (quantbookCommands.ts) is a thin vscode shell over these. Runs in the normal mocha suite (no engine,
// no vscode).

import * as assert from 'assert';

import {
	FORMAT_PRESET_CHOICES,
	MAX_FORMAT_BATCH_CELLS,
	buildFormatUndoLabel,
	buildSetFormatOps,
	formatStringForPreset,
	presetLabel,
	type FormatPreset,
} from '../src/quantbook/cellGrid/formatPickerLogic';
import type { FormatIdJson } from '../src/quantbook/types';

const BUILTIN_GENERAL: FormatIdJson = { kind: 'builtin', builtin: 0 };
const CUSTOM_ID: FormatIdJson = { kind: 'custom', customPeer: 7n, customCounter: 3 };

suite('W-G formatPickerLogic -- formatStringForPreset', () => {
	test('each non-custom preset maps to its Excel format string', () => {
		assert.strictEqual(formatStringForPreset('General'), 'General');
		assert.strictEqual(formatStringForPreset('Number'), '0.00');
		assert.strictEqual(formatStringForPreset('NumberThousands'), '#,##0.00');
		assert.strictEqual(formatStringForPreset('Currency'), '$#,##0.00');
		assert.strictEqual(formatStringForPreset('Percent'), '0.00%');
		assert.strictEqual(formatStringForPreset('Date'), 'yyyy-mm-dd');
	});
	test('"Custom" has no fixed string -- it throws [bad_argument]', () => {
		assert.throws(() => formatStringForPreset('Custom'), /\[bad_argument\].*Custom/);
	});
	test('every non-custom preset choice has a resolvable format string', () => {
		for (const choice of FORMAT_PRESET_CHOICES) {
			if (choice.preset === 'Custom') {
				continue;
			}
			assert.strictEqual(typeof formatStringForPreset(choice.preset), 'string');
			assert.ok(formatStringForPreset(choice.preset).length > 0);
		}
	});
});

suite('W-G formatPickerLogic -- FORMAT_PRESET_CHOICES', () => {
	test('General is first (the default-format clear) and Custom is last (the escape hatch)', () => {
		assert.strictEqual(FORMAT_PRESET_CHOICES[0].preset, 'General');
		assert.strictEqual(FORMAT_PRESET_CHOICES[FORMAT_PRESET_CHOICES.length - 1].preset, 'Custom');
	});
	test('preset keys are unique', () => {
		const keys = FORMAT_PRESET_CHOICES.map(c => c.preset);
		assert.strictEqual(new Set(keys).size, keys.length);
	});
	test('exactly the seven specified presets are offered', () => {
		const keys = FORMAT_PRESET_CHOICES.map(c => c.preset).sort();
		assert.deepStrictEqual(keys, ['Currency', 'Custom', 'Date', 'General', 'Number', 'NumberThousands', 'Percent']);
	});
});

suite('W-G formatPickerLogic -- presetLabel', () => {
	test('returns the display label for a known preset', () => {
		assert.strictEqual(presetLabel('General'), 'General');
		assert.strictEqual(presetLabel('Currency'), 'Currency');
		assert.strictEqual(presetLabel('Custom'), 'Custom...');
	});
});

suite('W-G formatPickerLogic -- buildSetFormatOps', () => {
	test('a single-cell rect produces ONE setFormat op carrying the format id', () => {
		const ops = buildSetFormatOps(0, { startRow: 0, startCol: 1, endRow: 0, endCol: 1 }, BUILTIN_GENERAL);
		assert.strictEqual(ops.length, 1);
		assert.deepStrictEqual(ops[0], { kind: 'setFormat', sheet: 0, row: 0, col: 1, format: BUILTIN_GENERAL });
	});
	test('a 2x3 rect produces 6 ops in row-major order, each with the same format id', () => {
		const ops = buildSetFormatOps(2, { startRow: 0, startCol: 1, endRow: 1, endCol: 3 }, CUSTOM_ID);
		assert.strictEqual(ops.length, 6);
		const coords = ops.map(o => `${o.row},${o.col}`);
		assert.deepStrictEqual(coords, ['0,1', '0,2', '0,3', '1,1', '1,2', '1,3']);
		for (const o of ops) {
			assert.strictEqual(o.kind, 'setFormat');
			assert.strictEqual(o.sheet, 2);
			assert.deepStrictEqual(o.format, CUSTOM_ID);
		}
	});
	test('a reversed rect is re-normalized -- same ops as the forward rect', () => {
		const forward = buildSetFormatOps(0, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, BUILTIN_GENERAL);
		const reversed = buildSetFormatOps(0, { startRow: 1, startCol: 1, endRow: 0, endCol: 0 }, BUILTIN_GENERAL);
		assert.deepStrictEqual(reversed, forward);
	});
	test('a non-integer sheet is rejected [bad_argument]', () => {
		assert.throws(() => buildSetFormatOps(0.5, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, BUILTIN_GENERAL), /\[bad_argument\].*sheet/);
	});
	test('a sheet beyond u16 is rejected [bad_argument]', () => {
		assert.throws(() => buildSetFormatOps(70000, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, BUILTIN_GENERAL), /\[bad_argument\].*sheet/);
	});
	test('a negative row is rejected [bad_argument]', () => {
		assert.throws(() => buildSetFormatOps(0, { startRow: -1, startCol: 0, endRow: 0, endCol: 0 }, BUILTIN_GENERAL), /\[bad_argument\].*extent/);
	});
	test('a column beyond the A1 extent is rejected [bad_argument]', () => {
		assert.throws(() => buildSetFormatOps(0, { startRow: 0, startCol: 0, endRow: 0, endCol: 16384 }, BUILTIN_GENERAL), /\[bad_argument\].*extent/);
	});
	test('a non-integer coordinate is rejected [bad_argument]', () => {
		assert.throws(() => buildSetFormatOps(0, { startRow: 0, startCol: 0, endRow: 0.5, endCol: 0 }, BUILTIN_GENERAL), /\[bad_argument\].*integer/);
	});
	test('a rect whose cell count exceeds the cap is rejected [bad_argument]', () => {
		// A 1000 x 1000 rect = 1,000,000 cells, well over MAX_FORMAT_BATCH_CELLS.
		assert.throws(
			() => buildSetFormatOps(0, { startRow: 0, startCol: 0, endRow: 999, endCol: 999 }, BUILTIN_GENERAL),
			new RegExp(`\\[bad_argument\\].*${MAX_FORMAT_BATCH_CELLS}`),
		);
	});
	test('a rect exactly at the cap is accepted', () => {
		// MAX_FORMAT_BATCH_CELLS cells in a single column.
		const ops = buildSetFormatOps(0, { startRow: 0, startCol: 0, endRow: MAX_FORMAT_BATCH_CELLS - 1, endCol: 0 }, BUILTIN_GENERAL);
		assert.strictEqual(ops.length, MAX_FORMAT_BATCH_CELLS);
	});
});

suite('W-G formatPickerLogic -- buildFormatUndoLabel', () => {
	test('composes the preset label and the A1 target', () => {
		assert.strictEqual(buildFormatUndoLabel('Currency', 'S0!B1:D3'), 'Set format: Currency over S0!B1:D3');
	});
	test('a raw custom format string is used verbatim as the applied label', () => {
		assert.strictEqual(buildFormatUndoLabel('0.000', 'S0!A1'), 'Set format: 0.000 over S0!A1');
	});
});

// Compile-time guard: the FormatPreset union is exactly what the choices list enumerates (a stray member
// without a choice would surface in the "exactly the seven" test above; this assignment keeps the type
// referenced so an unused-import lint never strips it).
const _typeGuard: FormatPreset = 'General';
void _typeGuard;
