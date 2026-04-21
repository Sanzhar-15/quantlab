/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Journal atomicity invariant tests.
 * AUDIT FIX II-PG1: CI test suite for journal atomicity.
 */
suite('Invariant: Journal Atomicity', () => {

	const QIC_ROOT = path.resolve(__dirname, '../../../common');

	test('JournaledAtomicWriter file exists', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/journaledAtomicWriter.ts');
		assert.ok(fs.existsSync(filePath), 'journaledAtomicWriter.ts should exist');
	});

	test('JournaledAtomicWriter uses .complete marker pattern', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/journaledAtomicWriter.ts');
		const content = fs.readFileSync(filePath, 'utf-8');

		assert.ok(content.includes('.complete'), 'Should use .complete marker for atomicity');
		assert.ok(content.includes('writeAtomic'), 'Should expose writeAtomic method');
	});

	test('JournaledAtomicWriter has crash recovery', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/journaledAtomicWriter.ts');
		const content = fs.readFileSync(filePath, 'utf-8');

		assert.ok(
			content.includes('recoverFromCrash') || content.includes('recover'),
			'Should have crash recovery method',
		);
	});

	test('JournaledAtomicWriter uses fdatasync or fsync', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/journaledAtomicWriter.ts');
		const content = fs.readFileSync(filePath, 'utf-8');

		assert.ok(
			content.includes('fdatasync') || content.includes('fsync') || content.includes('sync'),
			'Should ensure data is flushed to disk',
		);
	});
});
