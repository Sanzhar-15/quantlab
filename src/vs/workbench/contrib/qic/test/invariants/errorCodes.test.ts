/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ERROR_REGISTRY } from '../../common/canonical/errors.js';

/**
 * Error code completeness tests.
 * AUDIT FIX IV-AO12: Verify all error codes have user-facing messages.
 */
suite('Invariant: Error Codes', () => {

	test('ERROR_REGISTRY is not empty', () => {
		const codes = Object.keys(ERROR_REGISTRY);
		assert.ok(codes.length > 0, 'ERROR_REGISTRY should have entries');
	});

	test('All error codes have a name', () => {
		for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
			assert.ok(entry.name && entry.name.length > 0, `Error code ${code} should have a name`);
		}
	});

	test('All error codes have valid severity', () => {
		const validSeverities = ['info', 'warning', 'error'];
		for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
			assert.ok(
				validSeverities.includes(entry.severity),
				`Error code ${code} should have valid severity, got: ${entry.severity}`,
			);
		}
	});

	test('Error codes follow QIC-XXXX pattern', () => {
		const codePattern = /^QIC-[A-Z]\d{3}$/;
		for (const code of Object.keys(ERROR_REGISTRY)) {
			assert.ok(
				codePattern.test(code),
				`Error code ${code} should match QIC-XXXX pattern`,
			);
		}
	});

	test('QicError constructor looks up registry', () => {
		// Verify the QicError class works with registered codes
		const { QicError } = require('../../common/canonical/types.js');
		const firstCode = Object.keys(ERROR_REGISTRY)[0];
		const error = new QicError(firstCode, 'test message');
		assert.strictEqual(error.code, firstCode);
		assert.ok(error.qicName.length > 0);
	});
});
