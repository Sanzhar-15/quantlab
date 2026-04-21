/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LaneName } from '../canonical/lanes.js';

export interface ProviderRateLimit {
	requestsPerMinute: number;
	tokensPerMinute: number;
	tokensPerDay?: number;
}

// No Google entries (Audit S-11 / IV-AO11)
export const DEFAULT_RATE_LIMITS: Record<string, ProviderRateLimit> = {
	'anthropic': { requestsPerMinute: 60, tokensPerMinute: 100_000, tokensPerDay: 1_000_000 },
	'openai': { requestsPerMinute: 60, tokensPerMinute: 90_000 },
	'ollama': { requestsPerMinute: Infinity, tokensPerMinute: Infinity },
	// Quantlab Cloud: high client-side limits (server handles actual rate limiting)
	'quantlab-cloud': { requestsPerMinute: 1000, tokensPerMinute: 1_000_000 },
	// Delta Plus Server: high client-side limits (server handles actual rate limiting)
	'deltaplus': { requestsPerMinute: 1000, tokensPerMinute: 1_000_000 },
};

interface TokenBucket {
	tokens: number;
	maxTokens: number;
	refillRate: number; // tokens per ms
	lastRefill: number;
}

export interface RateLimiterConfig {
	limits?: Record<string, ProviderRateLimit>;
}

const QUOTA_GROUPS: Record<string, string[]> = {
	'completion': ['completion'],
	'chat': ['chat-ask', 'chat-gather', 'chat-plan', 'chat-act'],
	'background': ['repair', 'fast-apply', 'summarize'],
};

const QUOTA_PERCENTAGES: Record<string, number> = {
	'completion': 0.4,
	'chat': 0.5,
	'background': 0.1,
};

export class RateLimiter {
	private readonly buckets = new Map<string, TokenBucket>();
	private readonly limits: Record<string, ProviderRateLimit>;

	constructor(config?: RateLimiterConfig) {
		this.limits = { ...DEFAULT_RATE_LIMITS, ...config?.limits };
	}

	async acquire(
		providerId: string,
		lane: LaneName,
		tokensNeeded: number,
	): Promise<{ acquired: boolean; waitMs?: number }> {
		// Defensive: validate providerId
		if (!providerId || typeof providerId !== 'string') {
			console.error('[RateLimiter] Invalid providerId:', providerId);
			return { acquired: false, waitMs: 0 };
		}

		const bucket = this.getOrCreateBucket(providerId, lane);

		// Fast path: unlimited rate (positive Infinity tokens) - always allow immediately
		// Must check BEFORE refill to avoid Infinity arithmetic
		// Explicit check for positive Infinity only (not NaN or -Infinity)
		if (bucket.maxTokens === Infinity) {
			return { acquired: true };
		}

		this.refill(bucket);

		if (bucket.tokens >= tokensNeeded) {
			bucket.tokens -= tokensNeeded;
			return { acquired: true };
		}

		const deficit = tokensNeeded - bucket.tokens;
		// Defensive: prevent NaN from division by zero or invalid refillRate
		// Note: Infinity is valid (unlimited rate for ollama), only reject 0, NaN, or negative
		if (!bucket.refillRate || bucket.refillRate <= 0 || Number.isNaN(bucket.refillRate)) {
			console.error('[RateLimiter] Invalid refillRate for provider:', providerId, bucket.refillRate);
			return { acquired: false, waitMs: 60_000 };
		}
		const waitMs = deficit / bucket.refillRate;

		// Defensive: check for NaN or negative (Infinity/0 from Infinity refillRate is fine)
		if (Number.isNaN(waitMs) || waitMs < 0) {
			console.error('[RateLimiter] Invalid waitMs calculated:', waitMs, 'providerId:', providerId);
			return { acquired: false, waitMs: 60_000 };
		}

		if (waitMs > 30_000) {
			return { acquired: false, waitMs };
		}

		// Wait for tokens
		await new Promise(resolve => setTimeout(resolve, waitMs));
		this.refill(bucket);

		if (bucket.tokens >= tokensNeeded) {
			bucket.tokens -= tokensNeeded;
			return { acquired: true };
		}

		return { acquired: false, waitMs };
	}

	/**
	 * Update limits from provider response headers (Audit C-2 / IV-AO10).
	 * Uses x-ratelimit-limit-* headers for the actual limit, not remaining counts.
	 */
	updateFromHeaders(providerId: string, headers: Record<string, string>): void {
		const limit = this.limits[providerId];
		if (!limit) { return; }

		// Anthropic: anthropic-ratelimit-tokens-limit
		const anthropicTokenLimit = headers['anthropic-ratelimit-tokens-limit'];
		if (anthropicTokenLimit) {
			const parsed = parseInt(anthropicTokenLimit, 10);
			if (!isNaN(parsed) && parsed > 0) {
				limit.tokensPerMinute = parsed;
			}
		}

		// OpenAI: x-ratelimit-limit-tokens
		const openaiTokenLimit = headers['x-ratelimit-limit-tokens'];
		if (openaiTokenLimit) {
			const parsed = parseInt(openaiTokenLimit, 10);
			if (!isNaN(parsed) && parsed > 0) {
				limit.tokensPerMinute = parsed;
			}
		}

		// OpenAI: x-ratelimit-limit-requests
		const openaiRequestLimit = headers['x-ratelimit-limit-requests'];
		if (openaiRequestLimit) {
			const parsed = parseInt(openaiRequestLimit, 10);
			if (!isNaN(parsed) && parsed > 0) {
				limit.requestsPerMinute = parsed;
			}
		}
	}

	getQuotaGroup(lane: LaneName): string {
		for (const [group, lanes] of Object.entries(QUOTA_GROUPS)) {
			if (lanes.includes(lane)) { return group; }
		}
		return 'background';
	}

	getQuotaPercentage(lane: LaneName): number {
		return QUOTA_PERCENTAGES[this.getQuotaGroup(lane)] ?? 0.1;
	}

	private getOrCreateBucket(providerId: string, lane: LaneName): TokenBucket {
		const key = `${providerId}:${this.getQuotaGroup(lane)}`;
		let bucket = this.buckets.get(key);
		if (!bucket) {
			const limit = this.limits[providerId] ?? DEFAULT_RATE_LIMITS['anthropic'];
			// Log if using fallback to help debug provider issues
			if (!this.limits[providerId]) {
				console.warn('[RateLimiter] Provider not in limits, using anthropic fallback:', providerId);
			}
			const quotaPct = this.getQuotaPercentage(lane);
			// Defensive: ensure tokensPerMinute is valid (positive number or positive Infinity)
			let tokensPerMinute = limit?.tokensPerMinute ?? 100_000;

			// Reject invalid values (NaN, negative, -Infinity) - fall back to default
			if (Number.isNaN(tokensPerMinute) || tokensPerMinute <= 0) {
				console.error('[RateLimiter] Invalid tokensPerMinute for provider, using default:', providerId, tokensPerMinute);
				tokensPerMinute = 100_000;
			}

			// Handle unlimited providers (Ollama) - ONLY positive Infinity
			// This avoids NaN from Infinity arithmetic in refill calculations
			if (tokensPerMinute === Infinity) {
				bucket = {
					tokens: Infinity,
					maxTokens: Infinity,
					refillRate: Infinity, // Never used due to fast path in acquire/refill
					lastRefill: Date.now(),
				};
				this.buckets.set(key, bucket);
				return bucket;
			}

			const maxTokens = Math.floor(tokensPerMinute * quotaPct);
			// Ensure maxTokens is at least 1 to avoid division by zero
			const safeMaxTokens = Math.max(maxTokens, 1);
			bucket = {
				tokens: safeMaxTokens,
				maxTokens: safeMaxTokens,
				refillRate: safeMaxTokens / 60_000,
				lastRefill: Date.now(),
			};
			this.buckets.set(key, bucket);
		}
		return bucket;
	}

	private refill(bucket: TokenBucket): void {
		// Fast path: unlimited buckets (positive Infinity tokens) don't need refilling
		if (bucket.maxTokens === Infinity) {
			return;
		}

		const now = Date.now();
		const elapsed = now - bucket.lastRefill;
		// Guard against 0 * Infinity = NaN when elapsed is 0 and refillRate is Infinity
		const refillAmount = elapsed === 0 ? 0 : elapsed * bucket.refillRate;
		bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + refillAmount);
		bucket.lastRefill = now;
	}
}
