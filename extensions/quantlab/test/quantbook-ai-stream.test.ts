/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave K-a -- unit tests for the AI streaming parser (No-Fallbacks core) and the model resolver.
// The load-bearing test is the No-Fallbacks pin: a malformed SSE event MUST throw, never be
// silently dropped (the old `catch {}`), and an API `error` event MUST be surfaced. The model
// resolver guards against the retired-model 404 by correcting unset/unknown values to the default.

import * as assert from 'assert';

import { parseStreamEvent } from '../src/ai/streamParse';
import { AI_MODELS, DEFAULT_AI_MODEL, resolveModel } from '../src/ai/modelConfig';

suite('Quantbook AI streamParse (K-a) -- parseStreamEvent', () => {
	test('extracts a text delta from a content_block_delta', () => {
		const event = parseStreamEvent(
			JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } })
		);
		assert.deepStrictEqual(event, { kind: 'text', text: 'Hello' });
	});

	test('preserves an empty text delta as text (not dropped)', () => {
		const event = parseStreamEvent(
			JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } })
		);
		assert.deepStrictEqual(event, { kind: 'text', text: '' });
	});

	test('ignores the [DONE] sentinel', () => {
		assert.deepStrictEqual(parseStreamEvent('[DONE]'), { kind: 'ignore' });
	});

	test('ignores the [DONE] sentinel with CRLF framing (trailing \\r)', () => {
		assert.deepStrictEqual(parseStreamEvent('[DONE]\r'), { kind: 'ignore' });
	});

	test('tolerates CRLF framing on a JSON text delta', () => {
		const event = parseStreamEvent(
			JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }) + '\r'
		);
		assert.deepStrictEqual(event, { kind: 'text', text: 'hi' });
	});

	test('ignores JSON that parses to a primitive (null / number / string / array)', () => {
		for (const payload of ['null', '5', '"str"', 'true', '[]']) {
			assert.deepStrictEqual(parseStreamEvent(payload), { kind: 'ignore' }, payload);
		}
	});

	test('ignores a content_block_delta with a missing or non-string text', () => {
		assert.deepStrictEqual(parseStreamEvent(JSON.stringify({ type: 'content_block_delta' })), { kind: 'ignore' });
		assert.deepStrictEqual(
			parseStreamEvent(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 42 } })),
			{ kind: 'ignore' }
		);
	});

	test('ignores non-text events (message_start, ping, content_block_start, message_stop)', () => {
		for (const type of ['message_start', 'ping', 'content_block_start', 'message_delta', 'message_stop']) {
			assert.deepStrictEqual(parseStreamEvent(JSON.stringify({ type })), { kind: 'ignore' }, type);
		}
	});

	test('ignores a thinking delta (only text deltas carry response content)', () => {
		const event = parseStreamEvent(
			JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } })
		);
		assert.deepStrictEqual(event, { kind: 'ignore' });
	});

	test('surfaces an API error event with its message (No-Fallbacks: not ignored)', () => {
		const event = parseStreamEvent(
			JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
		);
		assert.deepStrictEqual(event, { kind: 'error', message: 'Overloaded' });
	});

	test('surfaces an error even when the error has no message', () => {
		const event = parseStreamEvent(JSON.stringify({ type: 'error', error: {} }));
		assert.strictEqual(event.kind, 'error');
	});

	test('THROWS on malformed JSON (No-Fallbacks: a corrupt stream is never silently dropped)', () => {
		assert.throws(() => parseStreamEvent('{not valid json'), /Malformed SSE event/);
	});
});

suite('Quantbook AI modelConfig (K-a) -- resolveModel', () => {
	test('defaults to the most capable current model when unset', () => {
		assert.strictEqual(resolveModel(undefined), DEFAULT_AI_MODEL);
		assert.strictEqual(resolveModel(null), DEFAULT_AI_MODEL);
		assert.strictEqual(resolveModel(''), DEFAULT_AI_MODEL);
		assert.strictEqual(resolveModel('   '), DEFAULT_AI_MODEL);
	});

	test('honors a configured model in the allow-list', () => {
		assert.strictEqual(resolveModel('claude-sonnet-4-6'), 'claude-sonnet-4-6');
		assert.strictEqual(resolveModel('  claude-haiku-4-5  '), 'claude-haiku-4-5');
	});

	test('corrects an unknown / typo model to the default (a typo can never 404 the feature)', () => {
		assert.strictEqual(resolveModel('claude-3-5-sonnet-20241022'), DEFAULT_AI_MODEL);
		assert.strictEqual(resolveModel('gpt-4'), DEFAULT_AI_MODEL);
	});

	test('the default is itself an allowed model', () => {
		assert.ok(AI_MODELS.includes(DEFAULT_AI_MODEL));
	});
});
