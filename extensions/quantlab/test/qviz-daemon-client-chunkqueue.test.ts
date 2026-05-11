/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the daemon-client's ChunkQueue (audit-fix AF33).
 *
 * The previous parser concatenated the rolling buffer on every incoming
 * chunk, which is O(N^2) for N total bytes split into many small chunks.
 * The ChunkQueue avoids the copies by walking a linked list of chunks
 * and materializing only the bytes a frame actually consumes.
 *
 * These tests exercise the chunk-boundary correctness:
 *   - reading a uint32 split across chunk boundaries
 *   - slicing a payload that spans many chunks
 *   - consuming partial chunks
 *   - consume + slice repeatedly across many byte-by-byte chunks
 */

import * as assert from 'assert';
import { ChunkQueue } from '../src/qviz/daemon-client';

suite('ChunkQueue', () => {

	test('readUint8 across chunks', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([0xAA, 0xBB]));
		q.push(Buffer.from([0xCC]));
		q.push(Buffer.from([0xDD, 0xEE]));
		assert.strictEqual(q.readUint8(0), 0xAA);
		assert.strictEqual(q.readUint8(1), 0xBB);
		assert.strictEqual(q.readUint8(2), 0xCC);
		assert.strictEqual(q.readUint8(3), 0xDD);
		assert.strictEqual(q.readUint8(4), 0xEE);
	});

	test('readUint32LE across chunk boundary (1+3 split)', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([0x78])); // first byte of uint32
		q.push(Buffer.from([0x56, 0x34, 0x12])); // last 3 bytes
		// LE uint32 of bytes 0x78 0x56 0x34 0x12 == 0x12345678
		assert.strictEqual(q.readUint32LE(0), 0x12345678);
	});

	test('readUint32LE across chunk boundary (2+2 split)', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([0xff, 0x00]));
		q.push(Buffer.from([0xff, 0x00]));
		// LE: 0x00ff00ff
		assert.strictEqual(q.readUint32LE(0), 0x00ff00ff);
	});

	test('slice across many chunks reassembles correctly', () => {
		const q = new ChunkQueue();
		// Push 100 chunks of 1 byte each, values 0..99.
		for (let i = 0; i < 100; i++) {
			q.push(Buffer.from([i]));
		}
		const all = q.slice(0, 100);
		assert.strictEqual(all.length, 100);
		for (let i = 0; i < 100; i++) {
			assert.strictEqual(all[i], i, `byte ${i} mismatch`);
		}
	});

	test('consume across chunk boundary updates byteLength', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([1, 2, 3]));
		q.push(Buffer.from([4, 5, 6]));
		assert.strictEqual(q.size, 6);
		q.consume(4);
		assert.strictEqual(q.size, 2);
		// Remaining bytes are 5, 6.
		assert.strictEqual(q.readUint8(0), 5);
		assert.strictEqual(q.readUint8(1), 6);
	});

	test('alternating push/slice/consume does not corrupt offsets', () => {
		const q = new ChunkQueue();
		// Simulate two framed messages arriving byte-by-byte:
		// Frame layout: [u32 length=2][u8 tag=1][u8 reserved=0][2 bytes payload].
		// First: payload = [0xAB, 0xCD].
		// Second: payload = [0xEE, 0xFF].
		const frame1 = Buffer.from([2, 0, 0, 0, 1, 0, 0xAB, 0xCD]);
		const frame2 = Buffer.from([2, 0, 0, 0, 1, 0, 0xEE, 0xFF]);
		const all = Buffer.concat([frame1, frame2]);

		// Push byte-by-byte to stress the boundary handling.
		for (let i = 0; i < all.length; i++) {
			q.push(Buffer.from([all[i]]));
		}
		assert.strictEqual(q.size, 16);

		// Decode frame 1.
		assert.strictEqual(q.readUint32LE(0), 2);
		assert.strictEqual(q.readUint8(4), 1);
		const payload1 = q.slice(6, 2);
		assert.deepStrictEqual([payload1[0], payload1[1]], [0xAB, 0xCD]);
		q.consume(8);

		// Decode frame 2.
		assert.strictEqual(q.size, 8);
		assert.strictEqual(q.readUint32LE(0), 2);
		const payload2 = q.slice(6, 2);
		assert.deepStrictEqual([payload2[0], payload2[1]], [0xEE, 0xFF]);
		q.consume(8);

		assert.strictEqual(q.size, 0);
	});

	test('slice out of range throws', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([1, 2, 3]));
		assert.throws(() => q.slice(0, 4), /out of range/);
	});

	test('consume more than available throws', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([1, 2]));
		assert.throws(() => q.consume(3), /more than available/);
	});

	test('clear empties the queue', () => {
		const q = new ChunkQueue();
		q.push(Buffer.from([1, 2, 3, 4]));
		q.clear();
		assert.strictEqual(q.size, 0);
	});

	// Megaudit CRITICAL-1 regression: a length value with the top bit
	// set was misparsed as negative because `>>> 0` only coerced the
	// last term of the OR-chain. The MAX_FRAME_BYTES guard then
	// accepted the negative and the parser desynced. Lock in the
	// unsigned-32 interpretation across the full range, especially the
	// boundary at 2^31.
	test('CRITICAL-1: readUint32LE returns unsigned for top-bit-set lengths', () => {
		const cases: { bytes: number[]; expected: number }[] = [
			{ bytes: [0x00, 0x00, 0x00, 0x80], expected: 0x80000000 },         // 2^31 exactly
			{ bytes: [0xFF, 0xFF, 0xFF, 0xFF], expected: 0xFFFFFFFF },         // 2^32 - 1
			{ bytes: [0x01, 0x00, 0x00, 0x80], expected: 0x80000001 },
			{ bytes: [0x12, 0x34, 0x56, 0x78], expected: 0x78563412 },         // top bit clear (regression check)
		];
		for (const { bytes, expected } of cases) {
			const q = new ChunkQueue();
			q.push(Buffer.from(bytes));
			const actual = q.readUint32LE(0);
			assert.strictEqual(actual, expected,
				`bytes=${bytes.map(b => b.toString(16)).join(',')} should parse as ${expected}, got ${actual}`);
			assert.ok(actual >= 0, `unsigned read must be non-negative; got ${actual}`);
		}
	});

});
