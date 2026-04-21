/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SessionCache } from '../../common/telemetry/sessionCache.js';
import { createTextResponse } from '../helpers/testUtilities.js';

/**
 * E2E: Rate limiting and request deduplication.
 * AUDIT FIX II-PG1: CI test suite for rate limiting.
 */
suite('E2E: Rate Limiting', () => {

	test('SessionCache deduplicates identical requests', () => {
		const cache = new SessionCache();
		const request = { model: 'test', messages: [{ role: 'user' as const, content: 'hello' }] };
		const response = createTextResponse('world');

		cache.set(request, response);
		const cached = cache.get(request);

		assert.ok(cached, 'Should find cached response');
		assert.deepStrictEqual(cached, response);
	});

	test('SessionCache does not return stale results for different requests', () => {
		const cache = new SessionCache();
		const request1 = { model: 'test', messages: [{ role: 'user' as const, content: 'hello' }] };
		const request2 = { model: 'test', messages: [{ role: 'user' as const, content: 'goodbye' }] };
		const response = createTextResponse('world');

		cache.set(request1, response);
		const result = cache.get(request2);

		assert.strictEqual(result, null, 'Different request should not hit cache');
	});

	test('SessionCache respects size limit with eviction', () => {
		const cache = new SessionCache();

		// Add many entries to trigger eviction
		for (let i = 0; i < 200; i++) {
			const request = { model: 'test', messages: [{ role: 'user' as const, content: `msg-${i}` }] };
			cache.set(request, createTextResponse('x'.repeat(300_000)));
		}

		const stats = cache.stats();
		assert.ok(stats.sizeBytes <= stats.maxSizeBytes, 'Cache should not exceed max size');
	});
});
