/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from '../../qicCrypto.js';
import type { ProviderAdapter, ProviderHealth, StreamChunk, GatewayMetadata, QuotaInfo } from '../../canonical/interfaces.js';
import type { ProviderRequest, ProviderResponse, TokenUsage } from '../../canonical/types.js';
import { QicError } from '../../canonical/types.js';
import { redactErrorBody } from './errorRedaction.js';

/**
 * Routing info from the server's first SSE chunk (not a StreamChunk variant).
 */
export interface RoutingInfo {
	actualModel: string;
	tier: string;
	estimatedTtft?: number;
	provider?: string;
	region?: string;
}

export interface QuantlabCloudConfig {
	baseUrl: string;
	accessToken: string;
	refreshToken?: string;
	clientId?: string;
	devMode?: boolean;
	extensionVersion?: string;
	tokenExpiresAt?: number;
	onTokenRefresh?: (newAccessToken: string, newRefreshToken?: string) => Promise<void>;
}

// --- Billing / Region response types ---

export interface SubscriptionInfo {
	plan: string;
	status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid';
	currentPeriodEnd?: string;
	tokensUsed?: number;
	tokenLimit?: number;
}

export interface CheckoutSession {
	url: string;
	sessionId: string;
}

export interface PortalSession {
	url: string;
}

export interface RegionInfo {
	id: string;
	name: string;
	available: boolean;
}

type RoutingListener = (info: RoutingInfo) => void;
type QuotaListener = (info: QuotaInfo) => void;

const PROACTIVE_REFRESH_INTERVAL_MS = 60_000; // Check every 60s
const PROACTIVE_REFRESH_THRESHOLD_MS = 5 * 60_000; // Refresh if < 5min remaining
const REQUEST_TIMEOUT_MS = 60_000;   // 60s for non-streaming inference
const STREAM_TIMEOUT_MS = 5 * 60_000; // 5 minutes for streaming (matches server provider timeout)

/**
 * Provider adapter for Quantlab Cloud.
 * Speaks QIC's canonical protocol natively — no format translation needed.
 */
export class QuantlabCloudAdapter implements ProviderAdapter {
	readonly id = 'quantlab-cloud';
	readonly name = 'Quantlab Cloud';
	readonly type = 'llm' as const;

	private config: QuantlabCloudConfig;
	private readonly activeRequests = new Map<string, AbortController>();
	private lastRoutingInfo: RoutingInfo | null = null;
	private readonly routingListeners: RoutingListener[] = [];
	private readonly quotaListeners: QuotaListener[] = [];

	// Rate limit tracking from response headers
	public rateLimitRemaining = -1;
	public rateLimitReset = 0;

	// Proactive token refresh timer
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;

	// Mutex: coalesce concurrent refresh calls into a single flight
	private _refreshPromise: Promise<void> | null = null;

	constructor(config: QuantlabCloudConfig) {
		this.validateUrl(config.baseUrl, config.devMode);
		this.config = config;

		// JWT exp fallback: if tokenExpiresAt was not provided, decode from JWT
		if (!this.config.tokenExpiresAt && this.config.accessToken) {
			this.config.tokenExpiresAt = this.decodeJwtExp(this.config.accessToken);
		}

		this.startProactiveRefresh();
	}

	// --- Event listeners ---

	onRouting(listener: RoutingListener): { dispose(): void } {
		this.routingListeners.push(listener);
		return {
			dispose: () => {
				const idx = this.routingListeners.indexOf(listener);
				if (idx >= 0) { this.routingListeners.splice(idx, 1); }
			},
		};
	}

	onQuotaUpdated(listener: QuotaListener): { dispose(): void } {
		this.quotaListeners.push(listener);
		return {
			dispose: () => {
				const idx = this.quotaListeners.indexOf(listener);
				if (idx >= 0) { this.quotaListeners.splice(idx, 1); }
			},
		};
	}

	// --- ProviderAdapter implementation ---

	async isAvailable(): Promise<boolean> {
		try {
			const health = await this.getHealth();
			return health.status !== 'unavailable';
		} catch {
			return false;
		}
	}

	async getHealth(): Promise<ProviderHealth> {
		const start = Date.now();
		try {
			const hdrs: Record<string, string> = { 'Authorization': `Bearer ${this.config.accessToken}` };
			if (this.config.extensionVersion) {
				hdrs['X-QIC-Extension-Version'] = this.config.extensionVersion;
			}
			const response = await fetch(`${this.baseUrl}/v1/health/ready`, {
				headers: hdrs,
				signal: AbortSignal.timeout(5000),
			});
			const data = await response.json() as { status?: string };
			return {
				status: data.status === 'healthy' ? 'healthy' : 'degraded',
				latencyMs: Date.now() - start,
				errorRate: 0,
				lastChecked: new Date().toISOString(),
			};
		} catch {
			return {
				status: 'unavailable',
				latencyMs: Date.now() - start,
				errorRate: 1,
				lastChecked: new Date().toISOString(),
			};
		}
	}

	async sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse> {
		const requestId = randomUUID();
		const abortController = new AbortController();
		this.activeRequests.set(requestId, abortController);

		// Compose caller abort + timeout into a single signal
		const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

		try {
			// Proactive refresh before request if token is near expiry
			await this.ensureTokenFresh();

			const body = this.buildRequestBody(request);
			let response = await this.doFetch('/v1/qic/request', body, requestId, abortController.signal, request.lane);

			// Handle 401 — attempt token refresh
			if (response.status === 401) {
				await this.refreshAccessToken();
				response = await this.doFetch('/v1/qic/request', body, requestId, abortController.signal, request.lane);
			}

			// Handle X-QIC-Token-Refresh header (HIGH-12)
			if (response.headers.get('X-QIC-Token-Refresh') === 'required') {
				void this.refreshAccessToken(); // Non-blocking
			}

			if (!response.ok) {
				throw await this.normalizeError(response);
			}

			// Parse response headers for quota/rate-limit/routing info
			this.parseResponseHeaders(response);

			// Normalize response format: server may return flat or structured content
			const raw = await response.json() as Record<string, unknown>;
			const content = typeof raw.content === 'string'
				? [{ type: 'text' as const, text: raw.content as string }]
				: (Array.isArray(raw.content) ? raw.content : []).map((b: any) => ({
					type: b.type as 'text',
					text: b.text ?? '',
				}));
			const usage = this.mapUsage(raw.usage);

			return {
				content,
				usage,
				stopReason: (raw.stopReason ?? raw.stop_reason) as 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | undefined,
			};
		} finally {
			clearTimeout(timeoutId);
			this.activeRequests.delete(requestId);
		}
	}

	async *sendStreaming(request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk> {
		const requestId = randomUUID();
		const abortController = new AbortController();
		this.activeRequests.set(requestId, abortController);

		// Hard ceiling timeout for the entire stream (matches server provider timeout)
		const timeoutId = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

		try {
			// Proactive refresh before request if token is near expiry
			await this.ensureTokenFresh();

			const body = this.buildRequestBody(request);
			let response = await this.doFetch('/v1/qic/stream', body, requestId, abortController.signal, request.lane);

			// Handle 401 — attempt token refresh
			if (response.status === 401) {
				await this.refreshAccessToken();
				response = await this.doFetch('/v1/qic/stream', body, requestId, abortController.signal, request.lane);
			}

			// Handle X-QIC-Token-Refresh header (HIGH-12)
			if (response.headers.get('X-QIC-Token-Refresh') === 'required') {
				void this.refreshAccessToken();
			}

			if (!response.ok) {
				throw await this.normalizeError(response);
			}

			// Parse response headers for quota/rate-limit/routing info
			this.parseResponseHeaders(response);

			if (!response.body) {
				throw new QicError('QIC-P004', 'Empty response body from Quantlab Cloud');
			}

			// Parse SSE stream
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) { continue; }

						const data = line.slice(6).trim();
						if (!data || data === '[DONE]') { continue; }

						let chunk: Record<string, unknown>;
						try {
							chunk = JSON.parse(data) as Record<string, unknown>;
						} catch {
							continue;
						}

						// Pre-filter: routing event is NOT a StreamChunk variant (MEDIUM-14)
						if (chunk.type === 'routing') {
							this.lastRoutingInfo = {
								actualModel: chunk.actualModel as string ?? chunk.actual_model as string,
								tier: chunk.tier as string,
								estimatedTtft: chunk.estimatedTtft as number ?? chunk.estimated_ttft as number | undefined,
								provider: chunk.provider as string | undefined,
								region: chunk.region as string | undefined,
							};
							for (const listener of this.routingListeners) {
								listener(this.lastRoutingInfo);
							}
							continue; // Do NOT yield
						}

						// Map 'done' chunk: meta -> providerMeta, snake_case usage mapping
						if (chunk.type === 'done') {
							const meta = chunk.meta as Record<string, unknown> | undefined;
							const usage = this.mapUsage(chunk.usage);

							// Emit quota update
							if (meta?.quotaRemaining) {
								for (const listener of this.quotaListeners) {
									listener(meta.quotaRemaining as QuotaInfo);
								}
							}

							yield {
								type: 'done',
								usage,
								stopReason: (chunk.stopReason ?? chunk.stop_reason) as string | undefined,
								providerMeta: meta,
							} satisfies StreamChunk;
							continue;
						}

						// Map 'text_delta' → canonical 'text' (server sends text_delta, client expects text)
						if (chunk.type === 'text_delta') {
							(chunk as any).type = 'text';
						}

						// Pass through all other StreamChunk variants directly
						yield chunk as unknown as StreamChunk;
					}
				}

				// Flush remaining buffer
				if (buffer.startsWith('data: ')) {
					const data = buffer.slice(6).trim();
					if (data && data !== '[DONE]') {
						try {
							const chunk = JSON.parse(data) as Record<string, unknown>;
							if (chunk.type !== 'routing') {
								if (chunk.type === 'text_delta') {
									(chunk as any).type = 'text';
								}
								yield chunk as unknown as StreamChunk;
							}
						} catch {
							// Incomplete JSON at end of stream — ignore
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		} finally {
			clearTimeout(timeoutId);
			this.activeRequests.delete(requestId);
		}
	}

	cancelRequest(requestId: string): void {
		this.activeRequests.get(requestId)?.abort();
		this.activeRequests.delete(requestId);
	}

	// --- Billing endpoints ---

	async getSubscription(): Promise<SubscriptionInfo> {
		const response = await this.doAuthGet('/v1/billing/subscription');
		return await response.json() as SubscriptionInfo;
	}

	async createCheckoutSession(plan: string): Promise<CheckoutSession> {
		const response = await this.doAuthPost('/v1/billing/create-checkout-session', { plan });
		return await response.json() as CheckoutSession;
	}

	async createPortalSession(): Promise<PortalSession> {
		const response = await this.doAuthPost('/v1/billing/portal-session', {});
		return await response.json() as PortalSession;
	}

	// --- Region endpoints ---

	async getRegions(): Promise<RegionInfo[]> {
		const response = await fetch(`${this.baseUrl}/v1/regions`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) { throw await this.normalizeError(response); }
		return await response.json() as RegionInfo[];
	}

	async getRegionPreference(): Promise<string | null> {
		const response = await this.doAuthGet('/v1/regions/preference');
		const data = await response.json() as { region?: string };
		return data.region ?? null;
	}

	async setRegionPreference(region: string): Promise<void> {
		await this.doAuthPost('/v1/regions/preference', { region }, 'PUT');
	}

	// --- Dispose (cleanup proactive refresh timer + cancel active requests) ---

	dispose(): void {
		if (this._refreshTimer !== null) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = null;
		}
		for (const [id, controller] of this.activeRequests) {
			controller.abort();
			this.activeRequests.delete(id);
		}
	}

	// --- Token management ---

	/**
	 * Coalescing mutex: if a refresh is already in flight, all concurrent
	 * callers await the same promise instead of issuing parallel refreshes.
	 */
	private async refreshAccessToken(): Promise<void> {
		if (this._refreshPromise) {
			return this._refreshPromise;
		}
		this._refreshPromise = this.doRefreshAccessToken().finally(() => {
			this._refreshPromise = null;
		});
		return this._refreshPromise;
	}

	private async doRefreshAccessToken(): Promise<void> {
		if (!this.config.refreshToken) {
			throw new QicError('QIC-P006', 'Quantlab Cloud session expired. Please sign in again.');
		}

		const maxRetries = 2;
		const delays = [1000, 3000];
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const formBody = new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: this.config.refreshToken,
					...(this.config.clientId ? { client_id: this.config.clientId } : {}),
				}).toString();

				const resp = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: formBody,
					signal: AbortSignal.timeout(10000),
				});

				if (!resp.ok) {
					// 401/403 means refresh token invalid - don't retry
					if (resp.status === 401 || resp.status === 403) {
						throw new QicError('QIC-P006', 'Quantlab Cloud session expired. Please sign in again.', undefined, resp.status);
					}
					// Server error - retry if attempts remain
					if (attempt < maxRetries) {
						await new Promise(r => setTimeout(r, delays[attempt] ?? 3000));
						continue;
					}
					throw new QicError('QIC-P006', `Token refresh failed: ${resp.status}`, undefined, resp.status);
				}

				let data: { access_token?: string; refresh_token?: string; expires_in?: number };
				try {
					data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
				} catch {
					throw new QicError('QIC-P006', 'Invalid token refresh response');
				}

				if (!data.access_token) {
					throw new QicError('QIC-P006', 'Token refresh response missing access_token');
				}

				// Update tokens
				const newAccessToken = data.access_token;
				const newRefreshToken = data.refresh_token;

				this.config.accessToken = newAccessToken;
				if (newRefreshToken) {
					this.config.refreshToken = newRefreshToken;
				}
				if (data.expires_in) {
					this.config.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
				} else {
					// Fallback: decode exp from the new JWT
					this.config.tokenExpiresAt = this.decodeJwtExp(newAccessToken);
				}

				// Persist tokens via callback (non-blocking, best-effort)
				try {
					await this.config.onTokenRefresh?.(newAccessToken, newRefreshToken);
				} catch (e) {
					// Log but don't fail - tokens are already updated in memory
					console.warn('[QuantlabCloudAdapter] Failed to persist refreshed tokens:', e);
				}

				return; // Success

			} catch (e) {
				lastError = e instanceof Error ? e : new Error(String(e));
				// If it's already a QicError, rethrow immediately (don't retry auth failures)
				if (e instanceof QicError) { throw e; }
				// Network/timeout error - retry if attempts remain
				if (attempt < maxRetries) {
					await new Promise(r => setTimeout(r, delays[attempt] ?? 3000));
					continue;
				}
			}
		}

		throw lastError ?? new QicError('QIC-P006', 'Token refresh failed after retries');
	}

	// --- Proactive token refresh ---

	private startProactiveRefresh(): void {
		if (!this.config.refreshToken) { return; }
		this._refreshTimer = setInterval(() => {
			void this.ensureTokenFresh();
		}, PROACTIVE_REFRESH_INTERVAL_MS);
	}

	private async ensureTokenFresh(): Promise<void> {
		if (!this.config.tokenExpiresAt || !this.config.refreshToken) { return; }
		const remaining = this.config.tokenExpiresAt - Date.now();
		if (remaining < PROACTIVE_REFRESH_THRESHOLD_MS) {
			try {
				await this.refreshAccessToken();
			} catch {
				// Best-effort proactive refresh — actual 401 handling will catch failures
			}
		}
	}

	// --- Response header parsing ---

	private parseResponseHeaders(response: Response): void {
		// Quota info from response headers
		const tokensRemaining = response.headers.get('X-Quota-Tokens-Remaining');
		const costRemaining = response.headers.get('X-Quota-Cost-Remaining');
		const quotaReset = response.headers.get('X-Quota-Reset');
		const quotaWarning = response.headers.get('X-QIC-Quota-Warning');
		if (tokensRemaining || costRemaining || quotaWarning) {
			const info: QuotaInfo = {
				tokensRemaining: tokensRemaining ? parseInt(tokensRemaining, 10) : undefined,
				costRemaining: costRemaining ? parseFloat(costRemaining) : undefined,
				resetAt: quotaReset ?? undefined,
				warning: quotaWarning ?? undefined,
			};
			for (const l of this.quotaListeners) {
				l(info);
			}
		}

		// Rate limit tracking
		this.rateLimitRemaining = parseInt(response.headers.get('X-RateLimit-Remaining') ?? '-1', 10);
		this.rateLimitReset = parseInt(response.headers.get('X-RateLimit-Reset') ?? '0', 10);

		// Routing metadata (supplement for non-streaming responses)
		const provider = response.headers.get('X-QIC-Provider');
		const tier = response.headers.get('X-QIC-Tier');
		const region = response.headers.get('X-QIC-Region');
		if (provider && tier) {
			const info: RoutingInfo = {
				actualModel: tier,
				tier,
				provider,
				region: region ?? undefined,
			};
			for (const l of this.routingListeners) {
				l(info);
			}
		}
	}

	// --- Helpers ---

	private get baseUrl(): string {
		return this.config.baseUrl;
	}

	private validateUrl(url: string, devMode?: boolean): void {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && !(devMode && parsed.hostname === 'localhost')) {
			throw new QicError('QIC-N001', 'Quantlab Cloud URL must use HTTPS');
		}
	}

	/**
	 * Decode the `exp` claim from a JWT without verification.
	 * Returns epoch ms or undefined if the token is not a valid JWT.
	 */
	private decodeJwtExp(token: string): number | undefined {
		try {
			const parts = token.split('.');
			if (parts.length !== 3) { return undefined; }
			const payload = JSON.parse(atob(parts[1])) as { exp?: number };
			if (typeof payload.exp === 'number') {
				return payload.exp * 1000; // Convert seconds → ms
			}
		} catch {
			// Not a valid JWT — ignore
		}
		return undefined;
	}

	/** Map server snake_case usage to canonical camelCase TokenUsage. */
	private mapUsage(raw: any): TokenUsage | undefined {
		if (!raw) { return undefined; }
		return {
			inputTokens: raw.input_tokens ?? raw.inputTokens ?? 0,
			outputTokens: raw.output_tokens ?? raw.outputTokens ?? 0,
			cacheReadTokens: raw.cache_read_tokens ?? raw.cacheReadTokens,
			cacheWriteTokens: raw.cache_creation_tokens ?? raw.cacheWriteTokens,
		};
	}

	private buildRequestBody(request: ProviderRequest & Partial<GatewayMetadata>): string {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: request.messages,
			tools: request.tools,
			lane: request.lane,
			priority: request.priority,
			sessionId: request.sessionId,
			max_tokens: request.maxTokens,
			temperature: request.temperature,
		};
		// Attach context if provided
		if (request.context) {
			body.context = {
				file_path: request.context.filePath,
				language: request.context.language,
				selection: request.context.selection,
				cursor_line: request.context.cursorLine,
			};
		}
		return JSON.stringify(body);
	}

	private async doFetch(path: string, body: string, requestId: string, signal: AbortSignal, lane?: string): Promise<Response> {
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${this.config.accessToken}`,
			'Content-Type': 'application/json',
			'Accept-Encoding': 'gzip',
			'X-QIC-Request-ID': requestId,
		};
		// Only send idempotency key for non-streaming requests
		if (path !== '/v1/qic/stream') {
			headers['X-QIC-Idempotency-Key'] = requestId;
		}
		if (lane) {
			headers['X-QIC-Lane'] = lane;
		}
		if (this.config.extensionVersion) {
			headers['X-QIC-Extension-Version'] = this.config.extensionVersion;
		}
		return fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers,
			body,
			signal,
		});
	}

	/** Authenticated GET helper for billing/region endpoints. */
	private async doAuthGet(path: string): Promise<Response> {
		await this.ensureTokenFresh();
		const response = await fetch(`${this.baseUrl}${path}`, {
			headers: {
				'Authorization': `Bearer ${this.config.accessToken}`,
				...(this.config.extensionVersion ? { 'X-QIC-Extension-Version': this.config.extensionVersion } : {}),
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401) {
			await this.refreshAccessToken();
			const retry = await fetch(`${this.baseUrl}${path}`, {
				headers: {
					'Authorization': `Bearer ${this.config.accessToken}`,
					...(this.config.extensionVersion ? { 'X-QIC-Extension-Version': this.config.extensionVersion } : {}),
				},
				signal: AbortSignal.timeout(10_000),
			});
			if (!retry.ok) { throw await this.normalizeError(retry); }
			return retry;
		}
		if (!response.ok) { throw await this.normalizeError(response); }
		return response;
	}

	/** Authenticated POST/PUT helper for billing/region endpoints. */
	private async doAuthPost(path: string, body: Record<string, unknown>, method: string = 'POST'): Promise<Response> {
		await this.ensureTokenFresh();
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				'Authorization': `Bearer ${this.config.accessToken}`,
				'Content-Type': 'application/json',
				...(this.config.extensionVersion ? { 'X-QIC-Extension-Version': this.config.extensionVersion } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401) {
			await this.refreshAccessToken();
			const retry = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers: {
					'Authorization': `Bearer ${this.config.accessToken}`,
					'Content-Type': 'application/json',
					...(this.config.extensionVersion ? { 'X-QIC-Extension-Version': this.config.extensionVersion } : {}),
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			});
			if (!retry.ok) { throw await this.normalizeError(retry); }
			return retry;
		}
		if (!response.ok) { throw await this.normalizeError(response); }
		return response;
	}

	private async normalizeError(response: Response): Promise<QicError> {
		const status = response.status;
		let body = '';
		try {
			body = await response.text();
		} catch {
			// Cannot read body
		}

		const redacted = redactErrorBody(body);

		if (status === 401) {
			return new QicError('QIC-P006', 'Session expired. Please sign in again.', undefined, 401);
		}
		if (status === 402) {
			// Quota exceeded — parse body for details
			let details: Record<string, unknown> = {};
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				details = {
					upgradeUrl: parsed.upgrade_url,
					tokensUsed: parsed.tokens_used,
					tokenLimit: parsed.token_limit,
					resetAt: parsed.reset_at,
				};
			} catch { /* ignore parse failures */ }
			return new QicError('QIC-QUOTA', 'Your usage quota is exhausted.', details, 402);
		}
		if (status === 403) {
			return new QicError('QIC-P007', 'Feature requires Pro plan. Upgrade at quantlab.dev/pricing', undefined, 403);
		}
		if (status === 409) {
			return new QicError('QIC-P008', 'Duplicate request', undefined, 409);
		}
		if (status === 426) {
			return new QicError('QIC-UPGRADE', 'Please update Quantlab to continue using cloud features.', undefined, 426);
		}
		if (status === 429) {
			// Extract Retry-After header
			let retryAfterMs: number | undefined;
			const retryAfter = response.headers.get('Retry-After');
			if (retryAfter) {
				const seconds = parseInt(retryAfter, 10);
				if (!isNaN(seconds)) {
					retryAfterMs = seconds * 1000;
				} else {
					// Retry-After may be an HTTP date
					const date = Date.parse(retryAfter);
					if (!isNaN(date)) {
						retryAfterMs = Math.max(0, date - Date.now());
					}
				}
			}
			return new QicError('QIC-P005', `Rate limited. ${redacted}`, { retryAfterMs }, 429);
		}

		return new QicError('QIC-P004', `Quantlab Cloud error ${status}: ${redacted}`, undefined, status);
	}
}
