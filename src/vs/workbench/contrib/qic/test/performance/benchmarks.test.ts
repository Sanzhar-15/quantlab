/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SessionCache } from '../../common/telemetry/sessionCache.js';
import { QuantPatterns } from '../../common/quant/quantPatterns.js';
import { createTextResponse } from '../helpers/testUtilities.js';

/**
 * Performance benchmark tests against SLO targets from spec §2.6.
 */
suite('Performance: Benchmarks', () => {

	test('SessionCache lookup P50 < 1ms', () => {
		const cache = new SessionCache();

		// Pre-populate cache
		for (let i = 0; i < 100; i++) {
			cache.set(
				{ model: 'test', messages: [{ role: 'user', content: `msg-${i}` }] },
				createTextResponse(`response-${i}`),
			);
		}

		// Benchmark lookups
		const start = performance.now();
		const iterations = 1000;
		for (let i = 0; i < iterations; i++) {
			cache.get({ model: 'test', messages: [{ role: 'user', content: `msg-${i % 100}` }] });
		}
		const elapsed = performance.now() - start;
		const p50 = elapsed / iterations;

		assert.ok(p50 < 1, `Cache lookup P50 should be < 1ms, got ${p50.toFixed(3)}ms`);
	});

	test('QuantPatterns.analyzeCode P50 < 5ms for typical code', () => {
		const patterns = new QuantPatterns();
		const code = `
import pandas as pd
import numpy as np

df = pd.read_csv('data.csv')
returns = df['close'].pct_change().dropna()
sharpe = returns.mean() / returns.std()
print(f"Sharpe: {sharpe}")

for idx, row in df.iterrows():
    if row['signal'] > 0:
        pass
`.repeat(10);

		const start = performance.now();
		const iterations = 100;
		for (let i = 0; i < iterations; i++) {
			patterns.analyzeCode(code);
		}
		const elapsed = performance.now() - start;
		const p50 = elapsed / iterations;

		assert.ok(p50 < 5, `QuantPatterns P50 should be < 5ms, got ${p50.toFixed(3)}ms`);
	});

	test('SessionCache computeKey P50 < 1ms', () => {
		const cache = new SessionCache();
		const request = {
			model: 'claude-3-opus',
			messages: Array.from({ length: 20 }, (_, i) => ({
				role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
				content: `Message ${i}: ${'x'.repeat(500)}`,
			})),
			temperature: 0.7,
		};

		const start = performance.now();
		const iterations = 1000;
		for (let i = 0; i < iterations; i++) {
			cache.computeKey(request);
		}
		const elapsed = performance.now() - start;
		const p50 = elapsed / iterations;

		assert.ok(p50 < 1, `Key computation P50 should be < 1ms, got ${p50.toFixed(3)}ms`);
	});

	test('Memory: SessionCache stays under 50MB', () => {
		const cache = new SessionCache();

		// Fill cache aggressively
		for (let i = 0; i < 500; i++) {
			cache.set(
				{ model: 'test', messages: [{ role: 'user', content: `msg-${i}` }] },
				createTextResponse('x'.repeat(200_000)),
			);
		}

		const stats = cache.stats();
		const sizeMb = stats.sizeBytes / (1024 * 1024);
		assert.ok(sizeMb <= 50, `Cache should be <= 50MB, got ${sizeMb.toFixed(1)}MB`);
	});
});
