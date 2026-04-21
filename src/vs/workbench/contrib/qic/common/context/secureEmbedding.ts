/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Gateway } from '../gateway/gateway.js';

export interface EmbeddingProvider {
	readonly dimensions: number;
	readonly maxTokens: number;
	embed(text: string): Promise<Float32Array>;
	embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingConfig {
	localFallback?: { enabled: boolean };
}

/**
 * Secure embedding service. Routes ALL embedding requests through the Gateway
 * for consent, redaction, rate limiting, and circuit breaking (Audit IV-AO4).
 */
export class SecureEmbeddingService {
	constructor(
		private readonly gateway: Gateway,
		private readonly config: EmbeddingConfig = {},
	) {}

	async embed(texts: string[]): Promise<Float32Array[]> {
		// Route through gateway for consent + redaction + rate limiting
		const response = await this.gateway.sendRequest({
			model: 'text-embedding-3-small',
			messages: texts.map(t => ({ role: 'user' as const, content: t })),
			lane: 'fast-apply',
			priority: 'low',
			maxTokens: 0,
		});

		// Parse embeddings from response
		const embeddings: Float32Array[] = [];
		for (const block of response.content) {
			if (block.type === 'text') {
				try {
					const data = JSON.parse(block.text);
					if (Array.isArray(data)) {
						embeddings.push(new Float32Array(data));
					}
				} catch {
					embeddings.push(new Float32Array(768));
				}
			}
		}

		// Pad if needed
		while (embeddings.length < texts.length) {
			embeddings.push(new Float32Array(768));
		}

		return embeddings;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const health = await this.gateway.getProviderHealth();
			for (const [, h] of health) {
				if (h.status === 'healthy') { return true; }
			}
			return this.config.localFallback?.enabled ?? false;
		} catch {
			return false;
		}
	}
}
