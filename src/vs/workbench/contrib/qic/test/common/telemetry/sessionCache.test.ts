/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SessionCache } from '../../../common/telemetry/sessionCache.js';
import { ReplayModeSupport } from '../../../common/telemetry/replayMode.js';
import { TelemetryService } from '../../../common/telemetry/telemetryService.js';
import type { ProviderRequest, ProviderResponse } from '../../../common/canonical/types.js';

function makeRequest(content: string, model: string = 'test-model'): ProviderRequest {
	return {
		model,
		messages: [{ role: 'user', content }],
		temperature: 0,
	};
}

function makeResponse(text: string): ProviderResponse {
	return {
		content: [{ type: 'text', text }],
		usage: { inputTokens: 10, outputTokens: 20 },
		stopReason: 'end_turn',
	};
}

suite('SessionCache', () => {
	test('cache miss returns null', () => {
		const cache = new SessionCache();
		const result = cache.get(makeRequest('hello'));
		assert.strictEqual(result, null);
	});

	test('cache hit returns stored response', () => {
		const cache = new SessionCache();
		const request = makeRequest('hello');
		const response = makeResponse('world');

		cache.set(request, response);
		const result = cache.get(request);

		assert.ok(result);
		assert.strictEqual(result.content[0].type, 'text');
		if (result.content[0].type === 'text') {
			assert.strictEqual(result.content[0].text, 'world');
		}
	});

	test('I-8: different message history produces different cache keys', () => {
		const cache = new SessionCache();

		// Same last message but different conversation history
		const request1: ProviderRequest = {
			model: 'test-model',
			messages: [
				{ role: 'user', content: 'first question' },
				{ role: 'assistant', content: 'first answer' },
				{ role: 'user', content: 'follow up' },
			],
			temperature: 0,
		};

		const request2: ProviderRequest = {
			model: 'test-model',
			messages: [
				{ role: 'user', content: 'different question' },
				{ role: 'assistant', content: 'different answer' },
				{ role: 'user', content: 'follow up' },
			],
			temperature: 0,
		};

		const key1 = cache.computeKey(request1);
		const key2 = cache.computeKey(request2);

		assert.notStrictEqual(key1, key2, 'Different message histories should produce different cache keys');
	});

	test('I-8: identical full requests produce same cache key', () => {
		const cache = new SessionCache();
		const request = makeRequest('hello');

		const key1 = cache.computeKey(request);
		const key2 = cache.computeKey(request);

		assert.strictEqual(key1, key2);
	});

	test('different models produce different cache keys', () => {
		const cache = new SessionCache();

		const key1 = cache.computeKey(makeRequest('hello', 'model-a'));
		const key2 = cache.computeKey(makeRequest('hello', 'model-b'));

		assert.notStrictEqual(key1, key2);
	});

	test('LRU eviction works', () => {
		const cache = new SessionCache();

		// Fill cache with entries
		for (let i = 0; i < 100; i++) {
			cache.set(makeRequest(`msg-${i}`), makeResponse('x'.repeat(500_000)));
		}

		const stats = cache.stats();
		assert.ok(stats.sizeBytes <= stats.maxSizeBytes, 'Cache should not exceed max size');
	});

	test('clear removes all entries', () => {
		const cache = new SessionCache();
		cache.set(makeRequest('a'), makeResponse('b'));
		cache.set(makeRequest('c'), makeResponse('d'));

		cache.clear();

		assert.strictEqual(cache.stats().entries, 0);
		assert.strictEqual(cache.stats().sizeBytes, 0);
	});

	test('overwriting same key updates entry', () => {
		const cache = new SessionCache();
		const request = makeRequest('hello');

		cache.set(request, makeResponse('first'));
		cache.set(request, makeResponse('second'));

		const result = cache.get(request);
		assert.ok(result);
		if (result.content[0].type === 'text') {
			assert.strictEqual(result.content[0].text, 'second');
		}
		assert.strictEqual(cache.stats().entries, 1);
	});
});

suite('ReplayModeSupport', () => {
	test('off mode returns null', () => {
		const replay = new ReplayModeSupport();
		const result = replay.getReplayResponse(makeRequest('hello'));
		assert.strictEqual(result, null);
		assert.strictEqual(replay.getMode(), 'off');
	});

	test('isActive returns correct state', () => {
		const replay = new ReplayModeSupport();
		assert.strictEqual(replay.isActive(), false);
	});

	test('deactivate clears state', () => {
		const replay = new ReplayModeSupport();
		replay.deactivateReplayMode();
		assert.strictEqual(replay.getMode(), 'off');
		assert.strictEqual(replay.recordingCount(), 0);
	});
});

suite('TelemetryService', () => {
	test('hashPath produces consistent 16-char hex', () => {
		const hash1 = TelemetryService.hashPath('/foo/bar/baz.ts');
		const hash2 = TelemetryService.hashPath('/foo/bar/baz.ts');
		assert.strictEqual(hash1, hash2);
		assert.strictEqual(hash1.length, 16);
		assert.ok(/^[0-9a-f]+$/.test(hash1));
	});

	test('hashPath produces different hashes for different paths', () => {
		const hash1 = TelemetryService.hashPath('/foo/bar.ts');
		const hash2 = TelemetryService.hashPath('/foo/baz.ts');
		assert.notStrictEqual(hash1, hash2);
	});
});
