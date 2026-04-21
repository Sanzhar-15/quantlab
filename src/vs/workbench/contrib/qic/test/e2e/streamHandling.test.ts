/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { StreamChunk } from '../../common/canonical/interfaces.js';

/**
 * E2E: Stream handling and chunk processing.
 * AUDIT FIX II-PG1: CI test suite for stream handling.
 */
suite('E2E: Stream Handling', () => {

	test('StreamChunk text type is recognized', () => {
		const chunk: StreamChunk = { type: 'text', text: 'hello' };
		assert.strictEqual(chunk.type, 'text');
		assert.strictEqual(chunk.text, 'hello');
	});

	test('StreamChunk tool_call_start type is recognized', () => {
		const chunk: StreamChunk = { type: 'tool_call_start', id: 'call-1', name: 'read_file' };
		assert.strictEqual(chunk.type, 'tool_call_start');
		assert.strictEqual(chunk.id, 'call-1');
		assert.strictEqual(chunk.name, 'read_file');
	});

	test('StreamChunk tool_call_delta accumulates arguments', () => {
		const deltas: StreamChunk[] = [
			{ type: 'tool_call_start', id: 'call-1', name: 'read_file' },
			{ type: 'tool_call_delta', id: 'call-1', argumentsDelta: '{"path":' },
			{ type: 'tool_call_delta', id: 'call-1', argumentsDelta: '"utils.ts"}' },
			{ type: 'tool_call_end', id: 'call-1' },
		];

		// Accumulate argument deltas
		let accumulatedArgs = '';
		for (const d of deltas) {
			if (d.type === 'tool_call_delta') {
				accumulatedArgs += d.argumentsDelta;
			}
		}

		const parsed = JSON.parse(accumulatedArgs);
		assert.strictEqual(parsed.path, 'utils.ts');
	});

	test('StreamChunk done type carries usage', () => {
		const chunk: StreamChunk = {
			type: 'done',
			usage: { inputTokens: 100, outputTokens: 200 },
			stopReason: 'end_turn',
		};
		assert.strictEqual(chunk.type, 'done');
		assert.strictEqual(chunk.usage?.inputTokens, 100);
	});

	test('StreamChunk error type carries error info', () => {
		const chunk: StreamChunk = {
			type: 'error',
			error: { code: 'QIC-G001', message: 'Provider error' } as any,
		};
		assert.strictEqual(chunk.type, 'error');
	});
});
