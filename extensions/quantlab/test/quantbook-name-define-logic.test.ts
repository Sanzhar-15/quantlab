/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 W1 "Define Name" -- unit tests for the vscode-free, engine-free core: the Excel defined-name
// validator (accept/reject table + per-reason messages), the selection -> CellRangeJson normalizer, and
// the confirmation-toast builder. The command (quantbookCommands.ts) is a thin vscode shell over these.
// Runs in the normal mocha suite (no engine, no vscode).

import * as assert from 'assert';

import {
	MAX_DEFINED_NAME_LENGTH,
	buildDefineNameToast,
	buildNameRange,
	columnNameRejectionReason,
	definedNameRejectionReason,
	isValidColumnName,
	isValidDefinedName,
} from '../src/quantbook/cellGrid/nameDefineLogic';

suite('FE-4 W1 nameDefineLogic -- isValidDefinedName (accept)', () => {
	// NOTE: "Q1" is deliberately NOT here -- it is a valid cell reference (column Q, row 1), so Excel (and
	// our validator) REJECT it as a defined name. See the reject list below.
	const ACCEPT = ['returns', '_hidden', 'tax_rate', 'Quarter1', 'data.set', 'A_1', 'sharpe2026', 'X', '_', 'Total_Cost'];
	for (const name of ACCEPT) {
		test(`accepts "${name}"`, () => {
			assert.strictEqual(isValidDefinedName(name), true, `should accept ${name}`);
		});
	}
	test('accepts a name exactly at the length cap', () => {
		const atCap = 'a'.repeat(MAX_DEFINED_NAME_LENGTH);
		assert.strictEqual(atCap.length, MAX_DEFINED_NAME_LENGTH);
		assert.strictEqual(isValidDefinedName(atCap), true);
	});
});

suite('FE-4 W1 nameDefineLogic -- isValidDefinedName (reject)', () => {
	const REJECT = [
		'',            // empty
		'1abc',        // leading digit
		'.dotfirst',   // leading period
		'has space',   // space
		'a-b',         // hyphen
		'a+b',         // operator
		'a!b',         // bang
		String.fromCharCode(99, 97, 102, 233),  // "cafe" with a non-ASCII e-acute -- non-ASCII names are rejected
		'A1',          // cell ref
		'Q1',          // cell ref (column Q, row 1) -- collides with a coordinate, so rejected
		'$A$1',        // absolute cell ref
		'B$2',         // mixed cell ref
		'XFD1048576',  // far-corner cell ref
		'R',           // R1C1 row shorthand
		'C',           // R1C1 column shorthand
		'RC',          // R1C1 bare
		'R1C1',        // full R1C1
		'R12',         // R<digits>
		'C3',          // C<digits>
	];
	for (const name of REJECT) {
		test(`rejects "${name}"`, () => {
			assert.strictEqual(isValidDefinedName(name), false, `should reject ${name}`);
		});
	}
	test('rejects a name one over the length cap', () => {
		assert.strictEqual(isValidDefinedName('a'.repeat(MAX_DEFINED_NAME_LENGTH + 1)), false);
	});
	test('cell-ref reservation is case-insensitive', () => {
		assert.strictEqual(isValidDefinedName('a1'), false);
		assert.strictEqual(isValidDefinedName('r1c1'), false);
		assert.strictEqual(isValidDefinedName('c'), false);
	});
});

suite('FE-4 W1 nameDefineLogic -- definedNameRejectionReason', () => {
	test('a valid name yields no reason (undefined)', () => {
		assert.strictEqual(definedNameRejectionReason('returns'), undefined);
		assert.strictEqual(definedNameRejectionReason('_x'), undefined);
	});
	test('empty -> a specific empty message', () => {
		assert.match(definedNameRejectionReason('') ?? '', /empty/i);
	});
	test('over-cap -> a length message naming the cap', () => {
		const reason = definedNameRejectionReason('a'.repeat(MAX_DEFINED_NAME_LENGTH + 1)) ?? '';
		assert.match(reason, new RegExp(String(MAX_DEFINED_NAME_LENGTH)));
	});
	test('a leading digit -> a "start with a letter or underscore" message', () => {
		assert.match(definedNameRejectionReason('1abc') ?? '', /letter or an underscore/i);
	});
	test('an illegal char -> a charset message', () => {
		assert.match(definedNameRejectionReason('a-b') ?? '', /letters, digits/i);
	});
	test('a cell-ref name -> a "looks like a cell reference" message', () => {
		assert.match(definedNameRejectionReason('A1') ?? '', /cell reference/i);
	});
	test('an R1C1 name -> a "reserved" message', () => {
		assert.match(definedNameRejectionReason('R1C1') ?? '', /reserved/i);
	});
});

// FE-8.4 (2026-06-15): the RELAXED column-name validator. A column is only ever referenced bracketed +
// table-qualified (`Table[Q3]`), so cell-ref-shaped + R1C1-form names are unambiguous and the engine accepts
// them (verified: ql-exec structured_ref_*_round_trip). columnNameRejectionReason keeps the STRUCTURAL rules
// but drops the two coordinate-collision guards that definedNameRejectionReason enforces.
suite('FE-8.4 nameDefineLogic -- columnNameRejectionReason (relaxed for columns)', () => {
	// Cell-ref-shaped + R1C1-form names: REJECTED as defined names, ACCEPTED as column names.
	const COLUMN_OK_BUT_NOT_DEFINED = ['Q1', 'Q3', 'A1', 'R2', 'AB12', 'R', 'C', 'RC', 'R1C1', 'r1c1', 'c'];
	for (const name of COLUMN_OK_BUT_NOT_DEFINED) {
		test(`"${name}" is a valid COLUMN name but NOT a valid defined name`, () => {
			assert.strictEqual(columnNameRejectionReason(name), undefined, `column should accept ${name}`);
			assert.strictEqual(isValidColumnName(name), true);
			// Regression guard: the defined-name / table-name path stays STRICT (it must still reject these).
			assert.ok(definedNameRejectionReason(name), `defined-name must STILL reject ${name}`);
			assert.strictEqual(isValidDefinedName(name), false);
		});
	}
	// Plain identifiers are valid for BOTH.
	for (const name of ['Region', '_hidden', 'tax_rate', 'Quarter1', 'data.set']) {
		test(`"${name}" is valid for both column and defined name`, () => {
			assert.strictEqual(columnNameRejectionReason(name), undefined);
			assert.strictEqual(definedNameRejectionReason(name), undefined);
		});
	}
	// Names that would need bracket-escaping (or are empty/over-cap) are STILL rejected for columns too.
	test('empty -> a column-specific empty message', () => {
		assert.match(columnNameRejectionReason('') ?? '', /column name cannot be empty/i);
	});
	test('over-cap -> a length message naming the cap', () => {
		const reason = columnNameRejectionReason('a'.repeat(MAX_DEFINED_NAME_LENGTH + 1)) ?? '';
		assert.match(reason, new RegExp(String(MAX_DEFINED_NAME_LENGTH)));
	});
	test('a leading digit is rejected (would not be a bare identifier)', () => {
		assert.match(columnNameRejectionReason('1bad') ?? '', /start with a letter or an underscore/i);
		assert.strictEqual(isValidColumnName('1bad'), false);
	});
	for (const bad of ['has space', 'a-b', 'a+b', '[bracket]', 'with#hash', 'at@sign']) {
		test(`a name needing escaping ${JSON.stringify(bad)} is rejected (charset)`, () => {
			assert.ok(columnNameRejectionReason(bad), `column should reject ${bad}`);
			assert.strictEqual(isValidColumnName(bad), false);
		});
	}
	test('a non-ASCII column name is rejected (ASCII-disciplined, matches the engine fold)', () => {
		const nonAscii = String.fromCharCode(99, 97, 102, 233); // "cafe" with a non-ASCII e-acute
		assert.ok(columnNameRejectionReason(nonAscii));
		assert.strictEqual(isValidColumnName(nonAscii), false);
	});
});

suite('FE-4 W1 nameDefineLogic -- buildNameRange', () => {
	test('a forward single-cell selection -> a collapsed CellRangeJson', () => {
		assert.deepStrictEqual(buildNameRange(0, 1, 2, 1, 2), { sheet: 0, startRow: 1, startCol: 2, endRow: 1, endCol: 2 });
	});
	test('a forward multi-cell selection -> the rect, start <= end', () => {
		assert.deepStrictEqual(buildNameRange(3, 1, 1, 12, 1), { sheet: 3, startRow: 1, startCol: 1, endRow: 12, endCol: 1 });
	});
	test('a reversed selection is normalized to start <= end on both axes', () => {
		assert.deepStrictEqual(buildNameRange(0, 12, 4, 2, 1), { sheet: 0, startRow: 2, startCol: 1, endRow: 12, endCol: 4 });
	});
	test('a non-integer sheet is rejected [bad_argument]', () => {
		assert.throws(() => buildNameRange(0.5, 0, 0, 0, 0), /\[bad_argument\].*sheet/);
	});
	test('a sheet beyond u16 is rejected [bad_argument]', () => {
		assert.throws(() => buildNameRange(70000, 0, 0, 0, 0), /\[bad_argument\].*sheet/);
	});
	test('a non-integer coordinate is rejected [bad_argument]', () => {
		assert.throws(() => buildNameRange(0, 0.5, 0, 0, 0), /\[bad_argument\].*integer/);
	});
	test('a negative coordinate is rejected [bad_argument]', () => {
		assert.throws(() => buildNameRange(0, -1, 0, 0, 0), /\[bad_argument\].*extent/);
	});
	test('a coordinate beyond the A1 extent is rejected [bad_argument]', () => {
		assert.throws(() => buildNameRange(0, 0, 0, 0, 16384), /\[bad_argument\].*extent/);
		assert.throws(() => buildNameRange(0, 0, 0, 1_048_576, 0), /\[bad_argument\].*extent/);
	});
});

suite('FE-4 W1 nameDefineLogic -- buildDefineNameToast', () => {
	test('composes the name and the A1 target', () => {
		assert.strictEqual(buildDefineNameToast('returns', 'Returns!B2:B13'), 'Defined name "returns" -> Returns!B2:B13');
	});
	test('a single-cell target', () => {
		assert.strictEqual(buildDefineNameToast('tax_rate', 'Sheet1!C5'), 'Defined name "tax_rate" -> Sheet1!C5');
	});
});
