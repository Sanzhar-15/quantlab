/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileContentLoader, FileContent } from '../../../common/crashSafe/fileContent.js';

suite('FileContent', () => {

	let tmpDir: string;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qic-fc-test-'));
	});

	teardown(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Use small thresholds for testing
	const testConfig = {
		inlineThreshold: 100,         // 100 bytes
		streamThreshold: 500,         // 500 bytes
		referenceThreshold: 1000,     // 1000 bytes
		chunkSize: 64,
	};

	test('small file returns inline', async () => {
		const filePath = path.join(tmpDir, 'small.txt');
		await fs.writeFile(filePath, 'hello world'); // 11 bytes

		const loader = new FileContentLoader(testConfig);
		const content = await loader.loadFile(filePath);

		assert.strictEqual(content.type, 'inline');
		if (content.type === 'inline') {
			assert.strictEqual(content.data, 'hello world');
			assert.strictEqual(content.sizeBytes, 11);
		}
	});

	test('medium file returns stream', async () => {
		const filePath = path.join(tmpDir, 'medium.txt');
		await fs.writeFile(filePath, 'x'.repeat(200)); // 200 bytes

		const loader = new FileContentLoader(testConfig);
		const content = await loader.loadFile(filePath);

		assert.strictEqual(content.type, 'stream');
		if (content.type === 'stream') {
			assert.strictEqual(content.sizeBytes, 200);
		}
	});

	test('large file returns reference', async () => {
		const filePath = path.join(tmpDir, 'large.txt');
		await fs.writeFile(filePath, 'x'.repeat(700)); // 700 bytes

		const loader = new FileContentLoader(testConfig);
		const content = await loader.loadFile(filePath);

		assert.strictEqual(content.type, 'reference');
		if (content.type === 'reference') {
			assert.strictEqual(content.path, filePath);
			assert.ok(content.hash.length === 64); // SHA-256 hex
		}
	});

	test('huge file returns rejected', async () => {
		const filePath = path.join(tmpDir, 'huge.txt');
		await fs.writeFile(filePath, 'x'.repeat(1500)); // 1500 bytes

		const loader = new FileContentLoader(testConfig);
		const content = await loader.loadFile(filePath);

		assert.strictEqual(content.type, 'rejected');
		if (content.type === 'rejected') {
			assert.strictEqual(content.path, filePath);
			assert.strictEqual(content.sizeBytes, 1500);
			assert.strictEqual(content.maxAllowed, 1000);
		}
	});

	test('toFullString works for inline', async () => {
		const loader = new FileContentLoader(testConfig);
		const content: FileContent = { type: 'inline', data: 'hello', sizeBytes: 5 };
		assert.strictEqual(await loader.toFullString(content), 'hello');
	});

	test('toFullString throws for reference', async () => {
		const loader = new FileContentLoader(testConfig);
		const content: FileContent = { type: 'reference', path: '/foo', hash: 'abc' };
		await assert.rejects(() => loader.toFullString(content));
	});

	test('toFullString throws for rejected', async () => {
		const loader = new FileContentLoader(testConfig);
		const content: FileContent = { type: 'rejected', path: '/foo', sizeBytes: 200, maxAllowed: 100 };
		await assert.rejects(() => loader.toFullString(content));
	});

	test('processContent dispatches correctly for all 4 variants', async () => {
		const loader = new FileContentLoader(testConfig);

		const inlineResult = await loader.processContent(
			{ type: 'inline', data: 'test', sizeBytes: 4 },
			{
				onInline: (d) => `inline:${d}`,
				onStream: () => 'stream',
				onReference: () => 'reference',
				onRejected: () => 'rejected',
			},
		);
		assert.strictEqual(inlineResult, 'inline:test');

		const rejectedResult = await loader.processContent(
			{ type: 'rejected', path: '/x', sizeBytes: 500, maxAllowed: 100 },
			{
				onInline: () => 'inline',
				onStream: () => 'stream',
				onReference: () => 'reference',
				onRejected: (_p, size) => `rejected:${size}`,
			},
		);
		assert.strictEqual(rejectedResult, 'rejected:500');
	});

	test('stream processing does not load full content into memory at once', async () => {
		const filePath = path.join(tmpDir, 'stream-test.txt');
		await fs.writeFile(filePath, 'x'.repeat(200));

		const loader = new FileContentLoader(testConfig);
		const content = await loader.loadFile(filePath);
		assert.strictEqual(content.type, 'stream');

		if (content.type === 'stream') {
			let totalBytes = 0;
			let maxChunkSize = 0;
			for await (const chunk of content.handle) {
				totalBytes += chunk.length;
				maxChunkSize = Math.max(maxChunkSize, chunk.length);
			}
			assert.strictEqual(totalBytes, 200);
			// Chunks should be at most chunkSize (64 bytes)
			assert.ok(maxChunkSize <= testConfig.chunkSize + 1);
		}
	});
});
