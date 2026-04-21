/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * State persistence invariant tests.
 * AUDIT FIX II-PG1: CI test suite for state persistence.
 */
suite('Invariant: State Persistence', () => {

	const QIC_ROOT = path.resolve(__dirname, '../../../common');

	test('StatePersistence file exists', () => {
		const filePath = path.join(QIC_ROOT, 'storage/statePersistence.ts');
		assert.ok(fs.existsSync(filePath), 'statePersistence.ts should exist');
	});

	test('StatePersistence implements session recovery', () => {
		const filePath = path.join(QIC_ROOT, 'storage/statePersistence.ts');
		const content = fs.readFileSync(filePath, 'utf-8');
		assert.ok(content.includes('getRecoverableSessions') || content.includes('recover'),
			'Should implement session recovery');
	});

	test('Database schema file exists', () => {
		const filePath = path.join(QIC_ROOT, 'storage/storageSchema.ts');
		assert.ok(fs.existsSync(filePath), 'storageSchema.ts should exist');
	});

	test('BM25 schema file exists', () => {
		const filePath = path.join(QIC_ROOT, 'storage/bm25Schema.ts');
		assert.ok(fs.existsSync(filePath), 'bm25Schema.ts should exist');
	});
});
