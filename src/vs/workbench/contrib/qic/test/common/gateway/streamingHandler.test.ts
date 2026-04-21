/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { StreamingResponseHandler } from '../../../common/gateway/streamingHandler.js';

suite('StreamingResponseHandler', () => {

	let handler: StreamingResponseHandler;

	setup(() => {
		handler = new StreamingResponseHandler();
	});

	test('normalizes Anthropic text delta', () => {
		const chunk = handler.normalizeAnthropicEvent({
			type: 'content_block_delta',
			delta: { type: 'text_delta', text: 'Hello' },
		});
		assert.ok(chunk);
		assert.strictEqual(chunk!.type, 'text');
		if (chunk!.type === 'text') {
			assert.strictEqual(chunk!.text, 'Hello');
		}
	});

	test('normalizes Anthropic tool call start', () => {
		const chunk = handler.normalizeAnthropicEvent({
			type: 'content_block_start',
			content_block: { type: 'tool_use', id: 'tc-1', name: 'read_file' },
		});
		assert.ok(chunk);
		assert.strictEqual(chunk!.type, 'tool_call_start');
		if (chunk!.type === 'tool_call_start') {
			assert.strictEqual(chunk!.id, 'tc-1');
			assert.strictEqual(chunk!.name, 'read_file');
		}
	});

	test('normalizes Anthropic message done', () => {
		const chunk = handler.normalizeAnthropicEvent({
			type: 'message_delta',
			delta: { stop_reason: 'end_turn' },
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		assert.ok(chunk);
		assert.strictEqual(chunk!.type, 'done');
	});

	test('normalizes OpenAI text content', () => {
		const result = handler.normalizeOpenAIEvent({
			choices: [{ delta: { content: 'World' } }],
		});
		assert.ok(result && !Array.isArray(result));
		const chunk = result;
		assert.strictEqual(chunk.type, 'text');
		if (chunk.type === 'text') {
			assert.strictEqual(chunk.text, 'World');
		}
	});

	test('normalizes OpenAI finish reason', () => {
		const result = handler.normalizeOpenAIEvent({
			choices: [{ finish_reason: 'stop' }],
		});
		assert.ok(result && !Array.isArray(result));
		const chunk = result;
		assert.strictEqual(chunk.type, 'done');
	});

	test('accumulates tool call from streaming chunks', () => {
		// Start
		const start = handler.accumulateToolCall({
			type: 'tool_call_start', id: 'tc-1', name: 'read_file',
		});
		assert.strictEqual(start, null);

		// Delta 1
		const delta1 = handler.accumulateToolCall({
			type: 'tool_call_delta', id: 'tc-1', argumentsDelta: '{"path":',
		});
		assert.strictEqual(delta1, null);

		// Delta 2
		const delta2 = handler.accumulateToolCall({
			type: 'tool_call_delta', id: 'tc-1', argumentsDelta: '"/src/file.ts"}',
		});
		assert.strictEqual(delta2, null);

		// End
		const result = handler.accumulateToolCall({
			type: 'tool_call_end', id: 'tc-1',
		});
		assert.ok(result);
		assert.strictEqual(result!.id, 'tc-1');
		assert.strictEqual(result!.name, 'read_file');
		assert.deepStrictEqual(result!.arguments, { path: '/src/file.ts' });
	});
});
