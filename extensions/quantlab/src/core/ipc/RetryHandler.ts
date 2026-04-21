/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Retry Handler with exponential backoff.
 *
 * Provides configurable retry logic with:
 * - Exponential backoff
 * - Configurable jitter
 * - Maximum retry limits
 * - Abort support
 */

import { RetryConfig, DefaultRetryConfig } from './types';

/**
 * Retry options for individual operations.
 */
export interface RetryOptions {
	signal?: AbortSignal;
	onRetry?: (attempt: number, delay: number, error: Error) => void;
}

/**
 * Result of a retry operation.
 */
export interface RetryResult<T> {
	success: boolean;
	result?: T;
	error?: Error;
	attempts: number;
	totalTime: number;
}

/**
 * Check if an error is retryable.
 */
export type RetryableChecker = (error: Error) => boolean;

/**
 * Default retryable error checker.
 * Considers network errors and timeouts as retryable.
 */
const defaultRetryable: RetryableChecker = (error: Error) => {
	const message = error.message.toLowerCase();

	// Network errors
	if (message.includes('network') ||
		message.includes('connection') ||
		message.includes('econnrefused') ||
		message.includes('econnreset') ||
		message.includes('etimedout') ||
		message.includes('timeout')) {
		return true;
	}

	// Server overload
	if (message.includes('overload') ||
		message.includes('busy') ||
		message.includes('unavailable')) {
		return true;
	}

	return false;
};

/**
 * Retry handler with exponential backoff and jitter.
 */
export class RetryHandler {
	private readonly config: RetryConfig;
	private readonly isRetryable: RetryableChecker;

	constructor(
		config: Partial<RetryConfig> = {},
		isRetryable: RetryableChecker = defaultRetryable
	) {
		this.config = { ...DefaultRetryConfig, ...config };
		this.isRetryable = isRetryable;
	}

	/**
	 * Execute a function with retry logic.
	 */
	async retry<T>(
		fn: () => Promise<T>,
		options: RetryOptions = {}
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
			// Check for abort
			if (options.signal?.aborted) {
				throw new Error('Retry aborted');
			}

			try {
				return await fn();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if we should retry
				if (attempt >= this.config.maxRetries || !this.isRetryable(lastError)) {
					throw lastError;
				}

				// Calculate delay with exponential backoff and jitter
				const delay = this.calculateDelay(attempt);

				// Notify of retry
				options.onRetry?.(attempt, delay, lastError);

				// Wait before retrying
				await this.delay(delay, options.signal);
			}
		}

		throw lastError ?? new Error('Retry failed');
	}

	/**
	 * Execute a function with retry logic, returning a result object.
	 */
	async tryRetry<T>(
		fn: () => Promise<T>,
		options: RetryOptions = {}
	): Promise<RetryResult<T>> {
		const startTime = Date.now();
		let attempts = 0;
		let lastError: Error | undefined;

		while (attempts < this.config.maxRetries) {
			attempts++;

			// Check for abort
			if (options.signal?.aborted) {
				return {
					success: false,
					error: new Error('Retry aborted'),
					attempts,
					totalTime: Date.now() - startTime,
				};
			}

			try {
				const result = await fn();
				return {
					success: true,
					result,
					attempts,
					totalTime: Date.now() - startTime,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if we should retry
				if (attempts >= this.config.maxRetries || !this.isRetryable(lastError)) {
					break;
				}

				// Calculate delay
				const delay = this.calculateDelay(attempts);

				// Notify of retry
				options.onRetry?.(attempts, delay, lastError);

				// Wait before retrying (handle abort during delay)
				try {
					await this.delay(delay, options.signal);
				} catch (delayError) {
					// If aborted during delay, return abort result
					if (delayError instanceof Error && delayError.message.includes('aborted')) {
						return {
							success: false,
							error: delayError,
							attempts,
							totalTime: Date.now() - startTime,
						};
					}
					throw delayError;
				}
			}
		}

		return {
			success: false,
			error: lastError ?? new Error('Retry failed'),
			attempts,
			totalTime: Date.now() - startTime,
		};
	}

	/**
	 * Calculate delay for a given attempt number.
	 *
	 * Uses exponential backoff with jitter.
	 */
	calculateDelay(attempt: number): number {
		// Base delay with exponential growth
		const baseDelay = this.config.baseDelayMs * Math.pow(2, attempt - 1);

		// Cap at max delay
		const cappedDelay = Math.min(baseDelay, this.config.maxDelayMs);

		// Add jitter (random variation)
		const jitter = cappedDelay * this.config.jitterFactor * Math.random();

		return Math.floor(cappedDelay + jitter);
	}

	/**
	 * Delay with abort support.
	 */
	private delay(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(resolve, ms);

			if (signal) {
				const onAbort = () => {
					clearTimeout(timeout);
					reject(new Error('Retry aborted'));
				};

				signal.addEventListener('abort', onAbort, { once: true });

				// Clean up listener when done
				setTimeout(() => {
					signal.removeEventListener('abort', onAbort);
				}, ms);
			}
		});
	}

	/**
	 * Get the configuration.
	 */
	getConfig(): Readonly<RetryConfig> {
		return { ...this.config };
	}
}

/**
 * Create a retry handler with custom config.
 */
export function createRetryHandler(config?: Partial<RetryConfig>): RetryHandler {
	return new RetryHandler(config);
}

/**
 * Execute a function with default retry logic.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	config?: Partial<RetryConfig>,
	options?: RetryOptions
): Promise<T> {
	const handler = new RetryHandler(config);
	return handler.retry(fn, options);
}

/**
 * Decorates an async function with retry logic.
 */
export function retryable<T extends (...args: any[]) => Promise<any>>(
	config?: Partial<RetryConfig>
): (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor {
	return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
		const original = descriptor.value;
		const handler = new RetryHandler(config);

		descriptor.value = async function (...args: Parameters<T>) {
			return handler.retry(() => original.apply(this, args));
		};

		return descriptor;
	};
}

/**
 * Simple exponential backoff calculation.
 */
export function exponentialBackoff(
	attempt: number,
	baseMs: number = 1000,
	maxMs: number = 30000,
	jitter: boolean = true
): number {
	const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
	return jitter ? delay + Math.floor(delay * 0.1 * Math.random()) : delay;
}
