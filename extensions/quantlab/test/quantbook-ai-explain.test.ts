/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave K-b (R20) -- unit tests for the Explain-with-AI prompt builders (pure). The load-bearing
// tests are the HONESTY/PRIVACY pins: the request carries ONLY the A1 address + formula (+ error),
// never a raw cell data value AND never the sheet name (workbook metadata). This matches the w99
// local-first modal's named egress (strategy_code + error_messages, the implicit-consent categories).

import * as assert from 'assert';

import {
	NO_FORMULA_MESSAGE,
	buildExplainMessages,
	buildExplainSystemPrompt,
	cellErrorString,
	normalizeFormula,
} from '../src/ai/explainPrompt';

suite('Quantbook AI explain (R20) -- buildExplainSystemPrompt', () => {
	const sys = buildExplainSystemPrompt();

	test('asks for a direct, explanation-only response (no preamble/thinking leak)', () => {
		assert.ok(/directly/i.test(sys) && /only/i.test(sys), 'must ask for a direct, response-only answer');
		assert.ok(/no preamble/i.test(sys), 'must forbid preamble');
	});

	test('instructs explaining the error and not inventing data', () => {
		assert.ok(/error/i.test(sys), 'must mention explaining errors');
		assert.ok(/do not invent data/i.test(sys), 'must forbid inventing data values');
	});
});

suite('Quantbook AI explain (R20) -- buildExplainMessages', () => {
	test('carries the A1 address and the formula (normalized with a leading =)', () => {
		const [msg] = buildExplainMessages({ a1: 'B7', formula: 'SUM(A1:A6)' });
		assert.strictEqual(msg.role, 'user');
		assert.ok(msg.content.includes('Cell: B7'));
		assert.ok(msg.content.includes('Formula: =SUM(A1:A6)'), 'must normalize a missing leading =');
	});

	test('HONESTY: never carries the sheet name (workbook metadata)', () => {
		const [msg] = buildExplainMessages({ a1: 'B7', formula: '=A1+1' });
		assert.ok(!/sheet/i.test(msg.content), 'the outbound message must not mention a sheet');
	});

	test('does not double a leading = that is already present', () => {
		const [msg] = buildExplainMessages({ a1: 'A1', formula: '=A1*2' });
		assert.ok(msg.content.includes('Formula: =A1*2'));
		assert.ok(!msg.content.includes('==A1*2'));
	});

	test('includes the error line when the cell is in an error state', () => {
		const [msg] = buildExplainMessages({ a1: 'A1', formula: '=1/0', error: '#DIV/0!' });
		assert.ok(msg.content.includes('Current error: #DIV/0!'));
	});

	test('omits the error line when there is no error', () => {
		const [msg] = buildExplainMessages({ a1: 'A1', formula: '=A1+1' });
		assert.ok(!/error/i.test(msg.content), 'no error mention when the cell is not errored');
	});

	test('HONESTY: never carries a raw cell data value (only A1 + formula + error)', () => {
		const [msg] = buildExplainMessages({ a1: 'A1', formula: '=A1+1', error: '#REF!' });
		assert.ok(!/value\s*:/i.test(msg.content), 'must not include a cell value');
	});
});

suite('Quantbook AI explain (R20) -- cellErrorString (privacy-sensitive derivation)', () => {
	test('returns the error string only for an error-kind value', () => {
		assert.strictEqual(cellErrorString({ kind: 'error', error: '#DIV/0!' }), '#DIV/0!');
	});

	test('returns undefined for non-error values (never leaks a normal value)', () => {
		assert.strictEqual(cellErrorString({ kind: 'number' }), undefined);
		// Even if a non-error value somehow carried an `error` field, it is NOT read (kind gates it).
		assert.strictEqual(cellErrorString({ kind: 'text', error: 'leak' }), undefined);
		assert.strictEqual(cellErrorString({ kind: 'boolean' }), undefined);
		assert.strictEqual(cellErrorString({ kind: 'blank' }), undefined);
		assert.strictEqual(cellErrorString(undefined), undefined);
		assert.strictEqual(cellErrorString(null), undefined);
	});

	test('returns undefined for an error-kind value with no/empty error string', () => {
		assert.strictEqual(cellErrorString({ kind: 'error' }), undefined);
		assert.strictEqual(cellErrorString({ kind: 'error', error: '' }), undefined);
	});
});

suite('Quantbook AI explain (R20) -- normalizeFormula', () => {
	test('prepends a leading = when missing and trims', () => {
		assert.strictEqual(normalizeFormula('SUM(A1:A2)'), '=SUM(A1:A2)');
		assert.strictEqual(normalizeFormula('  A1+1  '), '=A1+1');
	});

	test('leaves an existing leading = intact (no doubling)', () => {
		assert.strictEqual(normalizeFormula('=A1*2'), '=A1*2');
	});
});

suite('Quantbook AI explain (R20) -- NO_FORMULA_MESSAGE', () => {
	test('is a non-empty user-facing sentinel', () => {
		assert.ok(typeof NO_FORMULA_MESSAGE === 'string' && NO_FORMULA_MESSAGE.length > 0);
	});
});
