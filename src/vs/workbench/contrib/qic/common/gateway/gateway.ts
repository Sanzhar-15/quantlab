/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GatewayRequest, StreamChunk, ProviderAdapter, ProviderHealth } from '../canonical/interfaces.js';
import type { ProviderResponse } from '../canonical/types.js';
import { QicError } from '../canonical/types.js';
import type { RateLimiter } from './rateLimiter.js';
import type { CircuitBreaker } from '../recovery/circuitBreaker.js';
import type { EgressBoundaryEnforcer } from '../security/egressEnforcer.js';
import type { OptimizedSecretScanner } from '../security/secretScanner.js';
import type { ModelRegistry } from './modelRegistry.js';

/**
 * Central gateway hub for all LLM communication.
 * Pipeline: consent check -> secret redaction -> rate limiting -> circuit breaking -> send.
 */
export class Gateway {
	constructor(
		private readonly providers: Map<string, ProviderAdapter>,
		private readonly rateLimiter: RateLimiter,
		private readonly circuitBreakers: Map<string, CircuitBreaker>,
		private readonly egressEnforcer: EgressBoundaryEnforcer,
		private readonly secretScanner: OptimizedSecretScanner,
		private readonly modelRegistry: ModelRegistry,
	) {}

	async sendRequest(request: GatewayRequest): Promise<ProviderResponse> {
		// Resolve model alias
		const resolvedModel = this.modelRegistry.resolveAlias(request.model);
		const providerId = request.providerId ?? this.modelRegistry.getProviderForModel(resolvedModel);
		if (!providerId) {
			throw new QicError('QIC-P004', `No provider available for model "${resolvedModel}". Set an API key with "Orion: Set API Key" and reload the window.`);
		}

		const provider = this.providers.get(providerId);
		if (!provider) {
			throw new QicError('QIC-P004', `Provider "${providerId}" not available. If you just set an API key, reload the window (Ctrl+Shift+P → "Reload Window").`);
		}

		// Step 1: Egress consent + secret redaction
		const messageContent = this.extractMessageContent(request);
		const egressResult = await this.egressEnforcer.checkAndSanitize('llm', messageContent, {
			sessionId: request.sessionId ?? 'unknown',
			purpose: `${request.lane} request`,
		});

		if (!egressResult.allowed) {
			throw new QicError('QIC-X001', egressResult.reason ?? 'Egress blocked');
		}

		// Apply sanitized content back to request messages
		const sanitizedRequest = this.applySanitizedContent(request, egressResult.sanitizedData);

		// Step 2: Rate limiting
		const tokenEstimate = Math.ceil(messageContent.length / 4);
		const rateResult = await this.rateLimiter.acquire(providerId, request.lane, tokenEstimate);
		if (!rateResult.acquired) {
			throw new QicError('QIC-P005', `Rate limited. Wait ${rateResult.waitMs}ms`);
		}

		// Step 3: Circuit breaker + retry
		const breaker = this.circuitBreakers.get(providerId);
		if (breaker) {
			return this.withRetry(() => breaker.execute(() =>
				provider.sendRequest({ ...sanitizedRequest, model: resolvedModel })
			));
		}

		return this.withRetry(() =>
			provider.sendRequest({ ...sanitizedRequest, model: resolvedModel })
		);
	}

	async *sendStreaming(request: GatewayRequest): AsyncIterable<StreamChunk> {
		const resolvedModel = this.modelRegistry.resolveAlias(request.model);
		const providerId = request.providerId ?? this.modelRegistry.getProviderForModel(resolvedModel);
		if (!providerId) {
			throw new QicError('QIC-P004', `No provider available for model "${resolvedModel}". Set an API key with "Orion: Set API Key" and reload the window.`);
		}

		const provider = this.providers.get(providerId);
		if (!provider) {
			throw new QicError('QIC-P004', `Provider "${providerId}" not available. If you just set an API key, reload the window (Ctrl+Shift+P → "Reload Window").`);
		}

		// Egress check + sanitization
		const messageContent = this.extractMessageContent(request);
		const egressResult = await this.egressEnforcer.checkAndSanitize('llm', messageContent, {
			sessionId: request.sessionId ?? 'unknown',
			purpose: `${request.lane} streaming`,
		});

		if (!egressResult.allowed) {
			throw new QicError('QIC-X001', egressResult.reason ?? 'Egress blocked');
		}

		// Apply sanitized content
		const sanitizedRequest = this.applySanitizedContent(request, egressResult.sanitizedData);

		// Rate limiting
		const tokenEstimate = Math.ceil(messageContent.length / 4);
		const rateResult = await this.rateLimiter.acquire(providerId, request.lane, tokenEstimate);
		if (!rateResult.acquired) {
			throw new QicError('QIC-P005', `Rate limited. Wait ${rateResult.waitMs}ms`);
		}

		// Circuit breaker — check state before streaming, record outcome after.
		const breaker = this.circuitBreakers.get(providerId);
		const streamReq = { ...sanitizedRequest, model: resolvedModel };

		if (breaker) {
			// Pre-check circuit state (mirrors the guard in breaker.execute())
			breaker.checkCanExecute();

			let streamError: Error | undefined;
			try {
				for await (const chunk of provider.sendStreaming(streamReq)) {
					yield chunk;
				}
			} catch (err) {
				streamError = err instanceof Error ? err : new Error(String(err));
				throw streamError;
			} finally {
				if (streamError) {
					breaker.recordFailure();
				} else {
					breaker.recordSuccess();
				}
			}
		} else {
			yield* provider.sendStreaming(streamReq);
		}
	}

	async getProviderHealth(): Promise<Map<string, ProviderHealth>> {
		const results = new Map<string, ProviderHealth>();
		for (const [id, provider] of this.providers) {
			try {
				results.set(id, await provider.getHealth());
			} catch {
				results.set(id, {
					status: 'unavailable',
					latencyMs: 0,
					errorRate: 1,
					lastChecked: new Date().toISOString(),
				});
			}
		}
		return results;
	}

	private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
		const delays = [1000, 3000];
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				return await fn();
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (!this.isRetryable(lastError) || attempt === maxAttempts - 1) { throw lastError; }
				// Respect Retry-After header on 429
				let delay = delays[attempt] ?? 3000;
				if (err instanceof QicError && err.httpStatus === 429) {
					const retryAfter = (err.details as any)?.retryAfterMs;
					if (retryAfter && typeof retryAfter === 'number') { delay = retryAfter; }
				}
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
		throw lastError!;
	}

	private isRetryable(err: Error): boolean {
		if (err instanceof QicError) {
			const status = err.httpStatus;
			return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
		}
		return err.message.includes('fetch failed') || err.message.includes('ECONNRESET');
	}

	private extractMessageContent(request: GatewayRequest): string {
		return request.messages.map(m => {
			if (typeof m.content === 'string') { return m.content; }
			return m.content.map(b => b.type === 'text' ? b.text : '').join('');
		}).join('\n');
	}

	/**
	 * Replace message text content with sanitized (secret-redacted) version.
	 * Note: Egress enforcer already scanned the concatenated content. Here we apply
	 * redaction to individual messages for accurate message-level handling.
	 * We skip re-scanning if no secrets were found (sanitizedData undefined).
	 */
	private applySanitizedContent(request: GatewayRequest, sanitizedData?: string): GatewayRequest {
		// If egress enforcer found no secrets in the concatenated content, skip individual scanning
		if (sanitizedData === undefined) {
			return request;
		}

		// Egress found secrets - scan individual messages to ensure accurate per-message redaction
		// This handles cases where message boundaries differ from concatenation boundaries
		const sanitizedMessages = request.messages.map(m => {
			if (typeof m.content === 'string') {
				const result = this.secretScanner.scan(m.content);
				return result.hasSecrets ? { ...m, content: result.redactedText } : m;
			}
			let hasChanges = false;
			const newContent = m.content.map(b => {
				if (b.type === 'text') {
					const result = this.secretScanner.scan(b.text);
					if (result.hasSecrets) {
						hasChanges = true;
						return { ...b, text: result.redactedText };
					}
				}
				return b;
			});
			return hasChanges ? { ...m, content: newContent } : m;
		});

		return { ...request, messages: sanitizedMessages };
	}
}
