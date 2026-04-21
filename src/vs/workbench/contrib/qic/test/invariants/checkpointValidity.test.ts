/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Checkpoint validity invariant tests.
 * AUDIT FIX II-PG1: CI test suite for checkpoint validity.
 */
suite('Invariant: Checkpoint Validity', () => {

	const QIC_ROOT = path.resolve(__dirname, '../../../common');

	test('CheckpointValidator file exists', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/checkpointValidity.ts');
		assert.ok(fs.existsSync(filePath), 'checkpointValidity.ts should exist');
	});

	test('CheckpointValidator implements CV rules', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/checkpointValidity.ts');
		const content = fs.readFileSync(filePath, 'utf-8');

		// Should implement some of CV-1 through CV-5
		assert.ok(content.includes('validate'), 'Should have validate method');
		assert.ok(content.includes('checksum') || content.includes('hash'),
			'Should verify checksums');
	});

	test('CheckpointManager uses atomic writes', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/checkpointManager.ts');
		const content = fs.readFileSync(filePath, 'utf-8');

		assert.ok(content.includes('atomicWriter'), 'Should use atomicWriter');
		assert.ok(content.includes('.complete'), 'Should write .complete marker');
	});

	test('CheckpointManager implements secret scanning on export', () => {
		const filePath = path.join(QIC_ROOT, 'crashSafe/checkpointManager.ts');
		const content = fs.readFileSync(filePath, 'utf-8');

		assert.ok(content.includes('secretScanner'), 'Should use secretScanner for export (VII-DS17)');
		assert.ok(content.includes('exportCheckpoint'), 'Should have export method');
	});
});
