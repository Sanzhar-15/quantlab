/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import {
	RetryHandler,
	createRetryHandler,
	withRetry,
	exponentialBackoff,
} from '../../core/ipc/RetryHandler';

suite('RetryHandler', () => {
	suite('retry', () => {
		test('returns result on first success', async () => {
			const handler = new RetryHandler({ maxRetries: 3 });
			let attempts = 0;

			const result = await handler.retry(async () => {
				attempts++;
				return 'success';
			});

			assert.strictEqual(result, 'success');
			assert.strictEqual(attempts, 1);
		});

		test('retries on failure and succeeds', async () => {
			const handler = new RetryHandler({
				maxRetries: 5,
				baseDelayMs: 10,
				maxDelayMs: 50,
			});
			let attempts = 0;

			const result = await handler.retry(async () => {
				attempts++;
				if (attempts < 3) {
					throw new Error('network error');
				}
				return 'success';
			});

			assert.strictEqual(result, 'success');
			assert.strictEqual(attempts, 3);
		});

		test('throws after max retries exceeded', async () => {
			const handler = new RetryHandler({
				maxRetries: 3,
				baseDelayMs: 10,
			});
			let attempts = 0;

			try {
				await handler.retry(async () => {
					attempts++;
					throw new Error('connection refused');
				});
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('connection refused'));
				assert.strictEqual(attempts, 3);
			}
		});

		test('does not retry non-retryable errors', async () => {
			const handler = new RetryHandler({
				maxRetries: 5,
				baseDelayMs: 10,
			});
			let attempts = 0;

			try {
				await handler.retry(async () => {
					attempts++;
					throw new Error('invalid argument'); // Not a retryable error
				});
				assert.fail('Should have thrown');
			} catch (error) {
				assert.strictEqual(attempts, 1);
			}
		});

		test('calls onRetry callback', async () => {
			const handler = new RetryHandler({
				maxRetries: 3,
				baseDelayMs: 10,
			});
			const retries: Array<{ attempt: number; delay: number }> = [];

			try {
				await handler.retry(
					async () => {
						throw new Error('timeout');
					},
					{
						onRetry: (attempt, delay) => {
							retries.push({ attempt, delay });
						},
					}
				);
			} catch {
				// Expected
			}

			assert.strictEqual(retries.length, 2); // 2 retries before final failure
			assert.strictEqual(retries[0].attempt, 1);
			assert.strictEqual(retries[1].attempt, 2);
		});

		test('respects abort signal', async () => {
			const handler = new RetryHandler({
				maxRetries: 10,
				baseDelayMs: 100,
			});
			const controller = new AbortController();
			let attempts = 0;

			// Abort after a short delay
			setTimeout(() => controller.abort(), 50);

			try {
				await handler.retry(
					async () => {
						attempts++;
						throw new Error('connection refused');
					},
					{ signal: controller.signal }
				);
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('aborted'));
			}
		});
	});

	suite('tryRetry', () => {
		test('returns success result', async () => {
			const handler = new RetryHandler({ maxRetries: 3 });

			const result = await handler.tryRetry(async () => 'value');

			assert.strictEqual(result.success, true);
			assert.strictEqual(result.result, 'value');
			assert.strictEqual(result.attempts, 1);
			assert.ok(result.totalTime >= 0);
		});

		test('returns failure result after max retries', async () => {
			const handler = new RetryHandler({
				maxRetries: 2,
				baseDelayMs: 10,
			});

			const result = await handler.tryRetry(async () => {
				throw new Error('network error');
			});

			assert.strictEqual(result.success, false);
			assert.ok(result.error);
			assert.ok(result.error.message.includes('network'));
			assert.strictEqual(result.attempts, 2);
		});

		test('handles abort signal', async () => {
			const handler = new RetryHandler({
				maxRetries: 10,
				baseDelayMs: 100,
			});
			const controller = new AbortController();

			setTimeout(() => controller.abort(), 50);

			const result = await handler.tryRetry(
				async () => {
					throw new Error('connection refused');
				},
				{ signal: controller.signal }
			);

			assert.strictEqual(result.success, false);
			assert.ok(result.error?.message.includes('aborted'));
		});
	});

	suite('calculateDelay', () => {
		test('uses exponential backoff', () => {
			const handler = new RetryHandler({
				maxRetries: 5,
				baseDelayMs: 100,
				maxDelayMs: 10000,
				jitterFactor: 0, // Disable jitter for predictable testing
			});

			// With jitter=0, delay should be exactly base * 2^(attempt-1)
			assert.strictEqual(handler.calculateDelay(1), 100);
			assert.strictEqual(handler.calculateDelay(2), 200);
			assert.strictEqual(handler.calculateDelay(3), 400);
			assert.strictEqual(handler.calculateDelay(4), 800);
		});

		test('caps at maxDelay', () => {
			const handler = new RetryHandler({
				maxRetries: 10,
				baseDelayMs: 1000,
				maxDelayMs: 5000,
				jitterFactor: 0,
			});

			// 1000 * 2^5 = 32000, but capped at 5000
			assert.strictEqual(handler.calculateDelay(6), 5000);
		});

		test('adds jitter', () => {
			const handler = new RetryHandler({
				maxRetries: 5,
				baseDelayMs: 100,
				maxDelayMs: 10000,
				jitterFactor: 0.5,
			});

			const delays = new Set<number>();
			for (let i = 0; i < 20; i++) {
				delays.add(handler.calculateDelay(1));
			}

			// With jitter, we should get varied delays
			// Minimum is 100, maximum is 100 + 100*0.5 = 150
			for (const delay of delays) {
				assert.ok(delay >= 100 && delay <= 150, `Delay ${delay} out of expected range`);
			}
		});
	});

	suite('getConfig', () => {
		test('returns config copy', () => {
			const handler = new RetryHandler({
				maxRetries: 10,
				baseDelayMs: 500,
			});

			const config = handler.getConfig();

			assert.strictEqual(config.maxRetries, 10);
			assert.strictEqual(config.baseDelayMs, 500);
		});
	});
});

suite('createRetryHandler', () => {
	test('creates handler with defaults', () => {
		const handler = createRetryHandler();
		const config = handler.getConfig();

		assert.strictEqual(config.maxRetries, 5);
		assert.strictEqual(config.baseDelayMs, 1000);
		assert.strictEqual(config.maxDelayMs, 30000);
	});

	test('creates handler with custom config', () => {
		const handler = createRetryHandler({ maxRetries: 3 });
		const config = handler.getConfig();

		assert.strictEqual(config.maxRetries, 3);
	});
});

suite('withRetry', () => {
	test('executes function with retry', async () => {
		let attempts = 0;

		const result = await withRetry(
			async () => {
				attempts++;
				if (attempts < 2) {
					throw new Error('network error');
				}
				return 'done';
			},
			{ maxRetries: 5, baseDelayMs: 10 }
		);

		assert.strictEqual(result, 'done');
		assert.strictEqual(attempts, 2);
	});
});

suite('exponentialBackoff', () => {
	test('calculates basic backoff', () => {
		assert.strictEqual(exponentialBackoff(1, 1000, 30000, false), 1000);
		assert.strictEqual(exponentialBackoff(2, 1000, 30000, false), 2000);
		assert.strictEqual(exponentialBackoff(3, 1000, 30000, false), 4000);
	});

	test('caps at maximum', () => {
		assert.strictEqual(exponentialBackoff(10, 1000, 5000, false), 5000);
	});

	test('adds jitter when enabled', () => {
		const delays = new Set<number>();
		for (let i = 0; i < 10; i++) {
			delays.add(exponentialBackoff(1, 1000, 30000, true));
		}

		// With jitter, delays should vary
		const delayArray = Array.from(delays);
		for (const delay of delayArray) {
			assert.ok(delay >= 1000 && delay <= 1100, `Delay ${delay} out of expected jitter range`);
		}
	});
});
