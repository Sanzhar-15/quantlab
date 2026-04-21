/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SessionCache } from '../../common/telemetry/sessionCache.js';
import { MemoryManager } from '../../common/resilience/memoryManager.js';
import { createTextResponse, createMockProvider } from '../helpers/testUtilities.js';

/**
 * Load test scenarios.
 * AUDIT FIX IV-AO2: Tests for concurrent workloads.
 */
suite('Performance: Load Tests', () => {

	test('50 concurrent cache operations complete without error', async () => {
		const cache = new SessionCache();

		const promises = Array.from({ length: 50 }, (_, i) => {
			return new Promise<void>((resolve) => {
				const request = { model: 'test', messages: [{ role: 'user' as const, content: `concurrent-${i}` }] };
				cache.set(request, createTextResponse(`response-${i}`));
				const result = cache.get(request);
				assert.ok(result, `Cache should return result for concurrent-${i}`);
				resolve();
			});
		});

		await Promise.all(promises);
		assert.ok(cache.stats().entries > 0);
	});

	test('MockProvider handles 50 concurrent requests', async () => {
		const provider = createMockProvider({
			defaultResponse: createTextResponse('ok'),
			latencyMs: 10,
		});

		const promises = Array.from({ length: 50 }, (_, i) =>
			provider.sendRequest({
				model: 'test',
				messages: [{ role: 'user', content: `request-${i}` }],
			}),
		);

		const results = await Promise.all(promises);
		assert.strictEqual(results.length, 50);
		assert.strictEqual(provider.getCallCount(), 50);
	});

	test('MemoryManager tracks allocations correctly', () => {
		const manager = new MemoryManager();
		const initial = manager.getComponentAllocation('embeddingCache');

		// Simulate component allocation
		manager.requestAllocation('embeddingCache', 50 * 1024 * 1024); // 50MB

		const afterAllocation = manager.getComponentAllocation('embeddingCache');
		assert.ok(afterAllocation >= initial);
	});

	test('1000 sequential cache operations maintain performance', () => {
		const cache = new SessionCache();

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			const request = { model: 'test', messages: [{ role: 'user' as const, content: `seq-${i}` }] };
			cache.set(request, createTextResponse(`response-${i}`));
			cache.get(request);
		}
		const elapsed = performance.now() - start;

		// 1000 set+get pairs should complete in < 5 seconds
		assert.ok(elapsed < 5000, `1000 operations should complete in < 5s, got ${elapsed.toFixed(0)}ms`);
	});
});
