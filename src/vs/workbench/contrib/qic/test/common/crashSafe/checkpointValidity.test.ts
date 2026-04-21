/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CheckpointValidator, CheckpointData } from '../../../common/crashSafe/checkpointValidity.js';

function makeCheckpoint(overrides: Partial<CheckpointData> = {}): CheckpointData {
	const base: Omit<CheckpointData, 'checksum'> = {
		schemaVersion: 1,
		timestamp: new Date().toISOString(),
		files: [],
		...overrides,
	};
	const checksum = crypto.createHash('sha256')
		.update(JSON.stringify({
			schemaVersion: base.schemaVersion,
			timestamp: base.timestamp,
			files: base.files,
			metadata: base.metadata,
		}))
		.digest('hex');
	return { ...base, checksum };
}

suite('CheckpointValidator', () => {

	let tmpDir: string;
	let validator: CheckpointValidator;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qic-ckpt-test-'));
		validator = new CheckpointValidator(tmpDir);
	});

	teardown(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('valid checkpoint passes all 5 rules', async () => {
		const ckptPath = path.join(tmpDir, 'test.checkpoint');
		const data = makeCheckpoint();
		await fs.writeFile(ckptPath, JSON.stringify(data));
		await fs.writeFile(ckptPath + '.complete', '');

		const result = await validator.validate(ckptPath);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.failures.length, 0);
	});

	test('CV-1: missing .complete marker fails', async () => {
		const ckptPath = path.join(tmpDir, 'no-marker.checkpoint');
		const data = makeCheckpoint();
		await fs.writeFile(ckptPath, JSON.stringify(data));

		const result = await validator.validate(ckptPath);
		assert.ok(result.failures.some(f => f.rule === 'CV-1'));
	});

	test('CV-2: corrupted checksum fails', async () => {
		const ckptPath = path.join(tmpDir, 'bad-checksum.checkpoint');
		const data = makeCheckpoint();
		data.checksum = 'wrong';
		await fs.writeFile(ckptPath, JSON.stringify(data));
		await fs.writeFile(ckptPath + '.complete', '');

		const result = await validator.validate(ckptPath);
		assert.ok(result.failures.some(f => f.rule === 'CV-2'));
	});

	test('CV-3: future schema version fails', async () => {
		const ckptPath = path.join(tmpDir, 'future-schema.checkpoint');
		const data = makeCheckpoint({ schemaVersion: 999 });
		await fs.writeFile(ckptPath, JSON.stringify(data));
		await fs.writeFile(ckptPath + '.complete', '');

		const result = await validator.validate(ckptPath);
		assert.ok(result.failures.some(f => f.rule === 'CV-3'));
	});

	test('CV-4: stale timestamp fails', async () => {
		const ckptPath = path.join(tmpDir, 'stale.checkpoint');
		const data = makeCheckpoint({ timestamp: '2020-01-01T00:00:00Z' });
		await fs.writeFile(ckptPath, JSON.stringify(data));
		await fs.writeFile(ckptPath + '.complete', '');

		const result = await validator.validate(ckptPath, '2025-01-01T00:00:00Z');
		assert.ok(result.failures.some(f => f.rule === 'CV-4'));
	});

	test('CV-5: missing referenced file fails', async () => {
		const ckptPath = path.join(tmpDir, 'missing-ref.checkpoint');
		const data = makeCheckpoint({
			files: [{ path: 'nonexistent.txt', hash: 'abc' }],
		});
		await fs.writeFile(ckptPath, JSON.stringify(data));
		await fs.writeFile(ckptPath + '.complete', '');

		const result = await validator.validate(ckptPath);
		assert.ok(result.failures.some(f => f.rule === 'CV-5'));
	});

	test('CV-5: deleted file marked as such passes', async () => {
		const ckptPath = path.join(tmpDir, 'deleted-ok.checkpoint');
		const data = makeCheckpoint({
			files: [{ path: 'gone.txt', hash: 'abc', deleted: true }],
		});
		await fs.writeFile(ckptPath, JSON.stringify(data));
		await fs.writeFile(ckptPath + '.complete', '');

		const result = await validator.validate(ckptPath);
		assert.ok(!result.failures.some(f => f.rule === 'CV-5'));
	});

	test('invalid checkpoint is quarantined', async () => {
		const ckptPath = path.join(tmpDir, 'quarantine-me.checkpoint');
		await fs.writeFile(ckptPath, '{}');
		await fs.writeFile(ckptPath + '.complete', '');

		await validator.quarantine(ckptPath, 'test reason');

		await assert.rejects(() => fs.access(ckptPath));
		const quarantined = await fs.readdir(path.join(tmpDir, '.quarantine'));
		assert.ok(quarantined.some(f => f.includes('quarantine-me')));
	});

	test('multiple failures are all reported', async () => {
		const ckptPath = path.join(tmpDir, 'multi-fail.checkpoint');
		const data = makeCheckpoint({
			schemaVersion: 999,
			files: [{ path: 'missing.txt', hash: 'abc' }],
		});
		data.checksum = 'wrong';
		await fs.writeFile(ckptPath, JSON.stringify(data));
		// No .complete marker

		const result = await validator.validate(ckptPath, '2099-01-01T00:00:00Z');
		assert.ok(result.failures.length >= 2); // At least CV-1 and CV-2
	});
});
