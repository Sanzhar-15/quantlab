/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { ProviderRequest, ProviderResponse } from '../canonical/types.js';

interface CachedResponse {
	response: ProviderResponse;
	timestamp: number;
	sizeBytes: number;
}

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const CACHE_TTL_MS = 600_000; // 10 minutes

/**
 * Session cache for request deduplication.
 *
 * AUDIT FIX I-8 (HIGH): Cache key hashes the ENTIRE messages array,
 * plus model, tools, and temperature. NOT just the last user message.
 * This prevents cross-contamination between different conversation contexts.
 */
export class SessionCache {

	private readonly cache = new Map<string, CachedResponse>();
	private currentSizeBytes = 0;

	/**
	 * Check if a request is cached.
	 * Returns the cached response or null.
	 */
	get(request: ProviderRequest): ProviderResponse | null {
		const key = this.computeKey(request);
		const entry = this.cache.get(key);

		if (!entry) {
			return null;
		}

		// H8: TTL check — evict stale entries
		if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
			this.currentSizeBytes -= entry.sizeBytes;
			this.cache.delete(key);
			return null;
		}

		// Move to end (LRU refresh) — delete and re-set
		this.cache.delete(key);
		this.cache.set(key, entry);

		return entry.response;
	}

	/**
	 * Cache a response.
	 */
	set(request: ProviderRequest, response: ProviderResponse): void {
		const key = this.computeKey(request);
		const serialized = JSON.stringify(response);
		const sizeBytes = Buffer.byteLength(serialized, 'utf-8');

		// Don't cache responses larger than 10% of max size
		if (sizeBytes > MAX_SIZE_BYTES * 0.1) {
			return;
		}

		// Evict old entries if needed (LRU)
		while (this.currentSizeBytes + sizeBytes > MAX_SIZE_BYTES && this.cache.size > 0) {
			this.evictOldest();
		}

		// Remove existing entry if present
		const existing = this.cache.get(key);
		if (existing) {
			this.currentSizeBytes -= existing.sizeBytes;
			this.cache.delete(key);
		}

		this.cache.set(key, {
			response,
			timestamp: Date.now(),
			sizeBytes,
		});
		this.currentSizeBytes += sizeBytes;
	}

	/**
	 * Get cache statistics.
	 */
	stats(): { entries: number; sizeBytes: number; maxSizeBytes: number } {
		return {
			entries: this.cache.size,
			sizeBytes: this.currentSizeBytes,
			maxSizeBytes: MAX_SIZE_BYTES,
		};
	}

	/**
	 * Clear all cached entries.
	 */
	clear(): void {
		this.cache.clear();
		this.currentSizeBytes = 0;
	}

	/**
	 * Compute cache key from the complete request payload.
	 *
	 * AUDIT FIX I-8: Hash ENTIRE messages array + model + tools + temperature.
	 * This ensures different conversation contexts produce different cache keys.
	 */
	computeKey(request: ProviderRequest): string {
		return sha256Hex(JSON.stringify({
				model: request.model,
				messages: request.messages,       // ENTIRE array per I-8
				tools: request.tools,
				temperature: request.temperature,
			}));
	}

	/**
	 * Evict the oldest (least recently used) entry.
	 */
	private evictOldest(): void {
		// Map.keys() returns in insertion order — first key is oldest
		const firstKey = this.cache.keys().next().value;
		if (firstKey !== undefined) {
			const entry = this.cache.get(firstKey);
			if (entry) {
				this.currentSizeBytes -= entry.sizeBytes;
			}
			this.cache.delete(firstKey);
		}
	}
}
