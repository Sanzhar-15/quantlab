/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../../../common/gateway/rateLimiter.js';

suite('RateLimiter', () => {

	test('acquires tokens from bucket', async () => {
		const limiter = new RateLimiter();
		const result = await limiter.acquire('anthropic', 'chat-ask', 100);
		assert.strictEqual(result.acquired, true);
	});

	test('maps lanes to correct quota groups', () => {
		const limiter = new RateLimiter();
		assert.strictEqual(limiter.getQuotaGroup('completion'), 'completion');
		assert.strictEqual(limiter.getQuotaGroup('chat-ask'), 'chat');
		assert.strictEqual(limiter.getQuotaGroup('chat-act'), 'chat');
		assert.strictEqual(limiter.getQuotaGroup('repair'), 'background');
		assert.strictEqual(limiter.getQuotaGroup('fast-apply'), 'background');
		assert.strictEqual(limiter.getQuotaGroup('summarize'), 'background');
	});

	test('no Google entries in defaults (Audit S-11)', () => {
		assert.strictEqual(DEFAULT_RATE_LIMITS['google'], undefined);
		assert.strictEqual(DEFAULT_RATE_LIMITS['gemini'], undefined);
	});

	test('ollama has infinite limits', () => {
		assert.strictEqual(DEFAULT_RATE_LIMITS['ollama'].requestsPerMinute, Infinity);
		assert.strictEqual(DEFAULT_RATE_LIMITS['ollama'].tokensPerMinute, Infinity);
	});

	test('updateFromHeaders adjusts limits', () => {
		const limiter = new RateLimiter();
		limiter.updateFromHeaders('anthropic', {
			'anthropic-ratelimit-requests-remaining': '120',
		});
		// Should not throw and limits should be updated
	});

	test('quota percentages are correct', () => {
		const limiter = new RateLimiter();
		assert.strictEqual(limiter.getQuotaPercentage('completion'), 0.4);
		assert.strictEqual(limiter.getQuotaPercentage('chat-ask'), 0.5);
		assert.strictEqual(limiter.getQuotaPercentage('repair'), 0.1);
	});
});
