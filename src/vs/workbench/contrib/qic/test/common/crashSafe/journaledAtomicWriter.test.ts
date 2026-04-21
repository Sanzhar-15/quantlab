/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { JournaledAtomicWriter } from '../../../common/crashSafe/journaledAtomicWriter.js';
import { FileOperation, JournalEntry } from '../../../common/crashSafe/types.js';

suite('JournaledAtomicWriter', () => {

	let tmpDir: string;
	let journalDir: string;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qic-jaw-test-'));
		journalDir = path.join(tmpDir, 'journals');
	});

	teardown(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// -- Happy path ------------------------------------------------------------

	test('writeAtomic writes all files atomically', async () => {
		const writer = new JournaledAtomicWriter(journalDir);
		const ops: FileOperation[] = [
			{ type: 'write', path: path.join(tmpDir, 'a.txt'), content: Buffer.from('hello') },
			{ type: 'write', path: path.join(tmpDir, 'b.txt'), content: Buffer.from('world') },
			{ type: 'write', path: path.join(tmpDir, 'c.txt'), content: Buffer.from('!') },
		];

		await writer.writeAtomic(ops);

		assert.strictEqual(await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf-8'), 'hello');
		assert.strictEqual(await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf-8'), 'world');
		assert.strictEqual(await fs.readFile(path.join(tmpDir, 'c.txt'), 'utf-8'), '!');
	});

	test('journal is cleaned up after successful write', async () => {
		const writer = new JournaledAtomicWriter(journalDir);
		await writer.writeAtomic([
			{ type: 'write', path: path.join(tmpDir, 'a.txt'), content: Buffer.from('data') },
		]);

		const files = await fs.readdir(journalDir);
		const journals = files.filter(f => f.endsWith('.journal'));
		assert.strictEqual(journals.length, 0);
	});

	// -- Crash recovery --------------------------------------------------------

	test('recoverFromCrash completes pending journal', async () => {
		// Simulate: journal written but files not yet created
		await fs.mkdir(journalDir, { recursive: true });
		const targetPath = path.join(tmpDir, 'recovered.txt');
		const content = Buffer.from('recovered data').toString('base64');
		const ops = [{ type: 'write' as const, targetPath, content }];
		const entry: JournalEntry = {
			version: 1,
			transactionId: 'test-tx',
			timestamp: new Date().toISOString(),
			operations: ops,
			checksum: crypto.createHash('sha256').update(JSON.stringify(ops)).digest('hex'),
		};
		await fs.writeFile(path.join(journalDir, 'test-tx.journal'), JSON.stringify(entry));

		const result = await JournaledAtomicWriter.recoverFromCrash(journalDir);

		assert.strictEqual(result.recovered, true);
		assert.strictEqual(result.journalsProcessed, 1);
		assert.strictEqual(result.operationsRolledForward, 1);
		assert.strictEqual(await fs.readFile(targetPath, 'utf-8'), 'recovered data');
	});

	test('corrupt journal is quarantined', async () => {
		await fs.mkdir(journalDir, { recursive: true });
		const entry: JournalEntry = {
			version: 1,
			transactionId: 'bad-tx',
			timestamp: new Date().toISOString(),
			operations: [],
			checksum: 'deliberately-wrong-checksum',
		};
		await fs.writeFile(path.join(journalDir, 'bad-tx.journal'), JSON.stringify(entry));

		const result = await JournaledAtomicWriter.recoverFromCrash(journalDir);

		assert.strictEqual(result.journalsProcessed, 1);
		assert.ok(result.errors[0].includes('QIC-J001'));

		// Verify quarantine
		const quarantined = await fs.readdir(path.join(journalDir, '.quarantine'));
		assert.ok(quarantined.some(f => f.includes('bad-tx')));
	});

	test('empty journal dir is a no-op', async () => {
		await fs.mkdir(journalDir, { recursive: true });
		const result = await JournaledAtomicWriter.recoverFromCrash(journalDir);
		assert.strictEqual(result.recovered, false);
		assert.strictEqual(result.journalsProcessed, 0);
	});

	test('hasIncompleteJournals detects pending journals', async () => {
		assert.strictEqual(await JournaledAtomicWriter.hasIncompleteJournals(journalDir), false);

		await fs.mkdir(journalDir, { recursive: true });
		await fs.writeFile(path.join(journalDir, 'pending.journal'), '{}');

		assert.strictEqual(await JournaledAtomicWriter.hasIncompleteJournals(journalDir), true);
	});

	// -- Delete operations -----------------------------------------------------

	test('writeAtomic handles delete operations', async () => {
		const filePath = path.join(tmpDir, 'to-delete.txt');
		await fs.writeFile(filePath, 'delete me');

		const writer = new JournaledAtomicWriter(journalDir);
		await writer.writeAtomic([{ type: 'delete', path: filePath }]);

		await assert.rejects(() => fs.access(filePath));
	});

	// -- Concurrent writes -----------------------------------------------------

	test('concurrent writers use unique transaction IDs', async () => {
		const writer = new JournaledAtomicWriter(journalDir);
		await Promise.all([
			writer.writeAtomic([{ type: 'write', path: path.join(tmpDir, 'c1.txt'), content: Buffer.from('1') }]),
			writer.writeAtomic([{ type: 'write', path: path.join(tmpDir, 'c2.txt'), content: Buffer.from('2') }]),
		]);

		assert.strictEqual(await fs.readFile(path.join(tmpDir, 'c1.txt'), 'utf-8'), '1');
		assert.strictEqual(await fs.readFile(path.join(tmpDir, 'c2.txt'), 'utf-8'), '2');
	});

	// -- Storage detection -----------------------------------------------------

	test('detectStorageType returns a valid value', async () => {
		const writer = new JournaledAtomicWriter(journalDir);
		await fs.mkdir(journalDir, { recursive: true });
		const result = await writer.detectStorageType();
		assert.ok(['ssd', 'hdd', 'unknown'].includes(result));
	});
});
