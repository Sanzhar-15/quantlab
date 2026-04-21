/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from '../../qicCrypto.js';
import type { ProviderAdapter, ProviderHealth, StreamChunk, GatewayMetadata } from '../../canonical/interfaces.js';
import type { LaneName } from '../../canonical/lanes.js';
import type { ProviderRequest, ProviderResponse, TokenUsage, ContentBlock } from '../../canonical/types.js';
import { QicError } from '../../canonical/types.js';
import { redactErrorBody } from './errorRedaction.js';
import type { IRequestService } from '../../../../../../platform/request/common/request.js';
import type { IRequestContext } from '../../../../../../base/parts/request/common/request.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { consumeStream, listenStream } from '../../../../../../base/common/stream.js';

export interface DeltaPlusConfig {
	baseUrl: string;
	accessToken: string;
	refreshToken?: string;
	tokenExpiresAt?: number;
	onTokenRefresh?: (newAccess: string, newRefresh?: string) => Promise<void>;
	/** Called when token refresh fails (401/403) — should do a fresh login and return new tokens */
	loginFallback?: () => Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const PROACTIVE_REFRESH_THRESHOLD_MS = 5 * 60_000;
const NETWORK_RETRY_MAX = 2;
const NETWORK_RETRY_BASE_MS = 500;

/**
 * Provider adapter for Delta Plus Server LLM proxy.
 * Routes QIC requests through the Delta Plus server using the existing JWT.
 * Uses IRequestService for HTTP to bypass CSP restrictions in the renderer.
 */
export class DeltaPlusAdapter implements ProviderAdapter {
	readonly id = 'deltaplus';
	readonly name = 'Delta Plus Server';
	readonly type = 'llm' as const;

	private config: DeltaPlusConfig;
	private readonly activeRequests = new Map<string, AbortController>();
	private readonly requestService?: IRequestService;

	// Mutex: coalesce concurrent refresh calls
	private _refreshPromise: Promise<void> | null = null;

	// State tracking for Anthropic-format SSE tool_use events
	private _streamingToolCallId: string | null = null;

	constructor(config: DeltaPlusConfig, requestService?: IRequestService) {
		this.requestService = requestService;
		this.config = config;

		// JWT exp fallback
		if (!this.config.tokenExpiresAt && this.config.accessToken) {
			this.config.tokenExpiresAt = this.decodeJwtExp(this.config.accessToken);
		}
	}

	/**
	 * Update the in-memory access/refresh tokens.
	 * Called by the QIC contribution when ServerApiClient writes a fresh token to SecretStorage,
	 * ensuring this adapter always uses the latest token without doing its own HTTP refresh.
	 */
	updateTokens(accessToken: string, refreshToken?: string, tokenExpiresAt?: number): void {
		this.config.accessToken = accessToken;
		if (refreshToken !== undefined) {
			this.config.refreshToken = refreshToken;
		}
		if (tokenExpiresAt !== undefined) {
			this.config.tokenExpiresAt = tokenExpiresAt;
		} else if (accessToken) {
			this.config.tokenExpiresAt = this.decodeJwtExp(accessToken);
		}
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
			if (this.requestService) {
				const cts = new CancellationTokenSource();
				setTimeout(() => cts.cancel(), 5000);
				const context = await this.requestService.request({
					url: `${this.config.baseUrl}/health/live`,
					type: 'GET',
					headers: { 'Authorization': `Bearer ${this.config.accessToken}` },
				}, cts.token);
				const statusOk = context.res.statusCode !== undefined && context.res.statusCode >= 200 && context.res.statusCode < 300;
				return {
					status: statusOk ? 'healthy' : 'degraded',
					latencyMs: Date.now() - start,
					errorRate: 0,
					lastChecked: new Date().toISOString(),
				};
			} else {
				const response = await fetch(`${this.config.baseUrl}/health/live`, {
					headers: { 'Authorization': `Bearer ${this.config.accessToken}` },
					signal: AbortSignal.timeout(5000),
				});
				return {
					status: response.ok ? 'healthy' : 'degraded',
					latencyMs: Date.now() - start,
					errorRate: 0,
					lastChecked: new Date().toISOString(),
				};
			}
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

		const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

		try {
			await this.ensureTokenFresh();

			const bodyStr = JSON.stringify(this.buildQicRequest(request, false));

		const doRequest = async (): Promise<{ status: number; body: string }> => {
				if (this.requestService) {
					const cts = new CancellationTokenSource();
					if (request.signal) {
						request.signal.addEventListener('abort', () => cts.cancel());
					}
					const context = await this.requestService.request({
						url: `${this.config.baseUrl}/v1/qic/request`,
						type: 'POST',
						headers: this.getHeaders(),
						data: bodyStr,
					}, cts.token);
					const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
					return { status: context.res.statusCode ?? 500, body: buffer.toString() };
				} else {
					const response = await fetch(`${this.config.baseUrl}/v1/qic/request`, {
						method: 'POST',
						headers: this.getHeaders(),
						body: bodyStr,
						signal: abortController.signal,
					});
					return { status: response.status, body: await response.text() };
				}
			};

			let result: { status: number; body: string } | undefined;
			let lastNetworkError: unknown;

			// Retry loop for transient network errors (e.g. net::ERR_FAILED)
			for (let attempt = 0; attempt <= NETWORK_RETRY_MAX; attempt++) {
				try {
					result = await doRequest();
					lastNetworkError = undefined;
					break;
				} catch (err) {
					if (attempt < NETWORK_RETRY_MAX && this.isTransientNetworkError(err)) {
						lastNetworkError = err;
						await new Promise(r => setTimeout(r, NETWORK_RETRY_BASE_MS * Math.pow(2, attempt)));
						continue;
					}
					throw err;
				}
			}
			if (!result) {
				throw lastNetworkError ?? new QicError('QIC-N002', 'Failed to connect to Delta Plus Server after retries');
			}

			// Handle 401 — attempt token refresh + retry
			if (result.status === 401) {
				await this.refreshAccessToken();
				result = await doRequest();
			}

			if (result.status < 200 || result.status >= 300) {
				throw this.normalizeErrorFromStatus(result.status, result.body);
			}

			const rawOuter = JSON.parse(result.body) as Record<string, unknown>;
			const raw = this.unwrapResponse(rawOuter) as Record<string, unknown>;

			// Normalize response content
			const content: ContentBlock[] = typeof raw.content === 'string'
				? [{ type: 'text' as const, text: raw.content as string }]
				: (Array.isArray(raw.content) ? raw.content : []).map((b: any) => {
					if (b.type === 'tool_use' || b.type === 'tool_call') {
						return {
							type: 'tool_use' as const,
							id: b.id ?? '',
							name: b.name ?? '',
							input: typeof b.input === 'string' ? (() => { try { return JSON.parse(b.input); } catch { return {}; } })() : (b.input ?? {}),
						};
					}
					return { type: 'text' as const, text: b.text ?? '' };
				});

			return {
				content,
				usage: this.mapUsage(raw.usage),
				stopReason: (raw.stop_reason ?? raw.stopReason) as 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | undefined,
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

		const timeoutId = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

		try {
			await this.ensureTokenFresh();

			const bodyStr = JSON.stringify(this.buildQicRequest(request, true));

			if (this.requestService) {
				yield* this.streamViaRequestService(bodyStr, request.signal, requestId);
			} else {
				yield* this.streamViaFetch(bodyStr, abortController, requestId);
			}
		} finally {
			clearTimeout(timeoutId);
			this.activeRequests.delete(requestId);
		}
	}

	private async *streamViaRequestService(bodyStr: string, signal: AbortSignal | undefined, _requestId: string): AsyncIterable<StreamChunk> {
		const cts = new CancellationTokenSource();
		if (signal) {
			signal.addEventListener('abort', () => cts.cancel());
		}

		let context: IRequestContext | undefined;
		for (let attempt = 0; attempt <= NETWORK_RETRY_MAX; attempt++) {
			try {
				context = await this.requestService!.request({
					url: `${this.config.baseUrl}/v1/qic/stream`,
					type: 'POST',
					headers: this.getHeaders(),
					data: bodyStr,
				}, cts.token);
				break;
			} catch (reqErr) {
				if (attempt < NETWORK_RETRY_MAX && this.isTransientNetworkError(reqErr)) {
					await new Promise(r => setTimeout(r, NETWORK_RETRY_BASE_MS * Math.pow(2, attempt)));
					continue;
				}
				const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
				throw new QicError('QIC-N002', `Failed to connect to Delta Plus Server: ${message}`);
			}
		}
		if (!context) {
			throw new QicError('QIC-N002', 'Failed to connect to Delta Plus Server after retries');
		}

		// Handle 401 — retry after refresh
		if (context.res.statusCode === 401) {
			await this.refreshAccessToken();
			try {
				context = await this.requestService!.request({
					url: `${this.config.baseUrl}/v1/qic/stream`,
					type: 'POST',
					headers: this.getHeaders(),
					data: bodyStr,
				}, cts.token);
			} catch (reqErr) {
				const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
				throw new QicError('QIC-N002', `Failed to connect to Delta Plus Server: ${message}`);
			}
		}

		if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
			const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
			throw this.normalizeErrorFromStatus(context.res.statusCode ?? 500, buffer.toString());
		}

		// Convert VSBufferReadableStream to async iterable of lines
		const queue: string[] = [];
		let streamDone = false;
		let resolver: (() => void) | null = null;
		let lineBuffer = '';

		listenStream<VSBuffer>(context.stream, {
			onData: (chunk) => {
				const text = chunk.toString();
				lineBuffer += text;
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() ?? '';
				for (const line of lines) {
					queue.push(line);
					resolver?.();
				}
			},
			onError: () => { streamDone = true; resolver?.(); },
			onEnd: () => {
				if (lineBuffer) { queue.push(lineBuffer); }
				streamDone = true;
				resolver?.();
			},
		});

		async function* readLines(): AsyncIterable<string> {
			while (!streamDone || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else if (!streamDone) {
					await new Promise<void>(resolve => { resolver = resolve; });
				}
			}
		}

		yield* this.parseSSELines(readLines());
	}

	private async *streamViaFetch(bodyStr: string, abortController: AbortController, _requestId: string): AsyncIterable<StreamChunk> {
		let response: Response | undefined;
		// Retry loop for transient network errors
		for (let attempt = 0; attempt <= NETWORK_RETRY_MAX; attempt++) {
			try {
				response = await fetch(`${this.config.baseUrl}/v1/qic/stream`, {
					method: 'POST',
					headers: this.getHeaders(),
					body: bodyStr,
					signal: abortController.signal,
				});
				break;
			} catch (fetchErr) {
				if (attempt < NETWORK_RETRY_MAX && this.isTransientNetworkError(fetchErr)) {
					await new Promise(r => setTimeout(r, NETWORK_RETRY_BASE_MS * Math.pow(2, attempt)));
					continue;
				}
				const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
				throw new QicError('QIC-N002', `Failed to connect to Delta Plus Server: ${message}`);
			}
		}
		if (!response) {
			throw new QicError('QIC-N002', 'Failed to connect to Delta Plus Server after retries');
		}

		// Handle 401 — retry after refresh
		if (response.status === 401) {
			await this.refreshAccessToken();
			try {
				response = await fetch(`${this.config.baseUrl}/v1/qic/stream`, {
					method: 'POST',
					headers: this.getHeaders(),
					body: bodyStr,
					signal: abortController.signal,
				});
			} catch (fetchErr) {
				const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
				throw new QicError('QIC-N002', `Failed to connect to Delta Plus Server: ${message}`);
			}
		}

		if (!response.ok) {
			throw this.normalizeErrorFromStatus(response.status, await response.text());
		}

		if (!response.body) {
			throw new QicError('QIC-P004', 'Empty response body from Delta Plus Server');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		async function* readLines(): AsyncIterable<string> {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					yield line;
				}
			}
			if (buffer) { yield buffer; }
		}

		yield* this.parseSSELines(readLines());
	}

	/**
	 * Parse SSE lines and yield StreamChunks.
	 * Handles the Delta Plus server's event format, including
	 * multi-chunk emission for complete tool_call events.
	 */
	private async *parseSSELines(lines: AsyncIterable<string>): AsyncIterable<StreamChunk> {
		let currentEventType = '';
		this._streamingToolCallId = null; // Reset state for new stream

		for await (const line of lines) {
			// Parse event type
			if (line.startsWith('event: ')) {
				currentEventType = line.slice(7).trim();
				continue;
			}

			// Empty line resets event type
			if (line.trim() === '') {
				currentEventType = '';
				continue;
			}

			if (!line.startsWith('data: ')) {
				continue;
			}

			const data = line.slice(6).trim();
			if (!data || data === '[DONE]') {
				continue;
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(data) as Record<string, unknown>;
			} catch {
				continue;
			}

			// Use event type from SSE if available, otherwise fall back to data.type
			const eventType = currentEventType || (parsed.type as string) || '';

			const chunks = this.mapServerEvent(eventType, parsed);
			for (const chunk of chunks) {
				yield chunk;
			}

			// Reset event type after processing
			currentEventType = '';
		}
	}

	cancelRequest(requestId: string): void {
		this.activeRequests.get(requestId)?.abort();
		this.activeRequests.delete(requestId);
	}

	// --- Dispose ---

	dispose(): void {
		for (const [id, controller] of this.activeRequests) {
			controller.abort();
			this.activeRequests.delete(id);
		}
	}

	// --- Request transformation ---

	/**
	 * Map client lane names to server QIC lane names.
	 * Server lanes: completion, chat-ask, chat-plan, chat-debug, chat-review, edit, doc-gen, test-gen
	 * Client lanes: completion, chat-ask, chat-gather, chat-plan, chat-act, repair, fast-apply, summarize
	 */
	private static readonly LANE_MAP: Partial<Record<LaneName, string>> = {
		// All client lanes now exist on the server — no remapping needed.
		// Keep this map for potential future mismatches.
	};

	private mapLane(lane?: LaneName): string {
		if (!lane) { return 'chat-ask'; }
		return DeltaPlusAdapter.LANE_MAP[lane] ?? lane;
	}

	/**
	 * Build a QIC protocol request body.
	 * Format: { lane, messages, session_id?, context?, tools?, max_tokens?, temperature?, stream }
	 */
	private buildQicRequest(request: ProviderRequest & Partial<GatewayMetadata>, stream: boolean): object {
		const lane = this.mapLane(request.lane);

		// Build messages — flatMap because tool_result blocks become separate role='tool' messages (OpenAI format)
		const messages: Record<string, unknown>[] = [];
		for (const m of request.messages) {
			if (typeof m.content === 'string') {
				messages.push({ role: m.role, content: m.content });
				continue;
			}

			// Separate content blocks by type
			const toolResults = m.content.filter(b => b.type === 'tool_result');
			const otherBlocks = m.content.filter(b => b.type !== 'tool_result');

			// Process non-tool-result blocks (text + tool_use)
			if (otherBlocks.length > 0) {
				const textParts = otherBlocks.filter(b => b.type === 'text');
				const toolUseParts = otherBlocks.filter(b => b.type === 'tool_use');

				const msg: Record<string, unknown> = {
					role: m.role,
					content: textParts.length > 0
						? textParts.map(b => ('text' in b ? b.text : '')).join('')
						: (toolUseParts.length > 0 ? null : ''),
				};

				// OpenAI format: tool_use → tool_calls with function wrapper
				if (toolUseParts.length > 0) {
					const validToolCalls = toolUseParts
						.filter(b => 'name' in b && typeof b.name === 'string' && (b.name as string).trim() !== '')
						.map(b => ({
							id: ('id' in b ? b.id : ''),
							type: 'function',
							function: {
								name: (b as any).name as string,
								arguments: JSON.stringify('input' in b ? b.input : {}),
							},
						}));
					if (validToolCalls.length > 0) {
						msg.tool_calls = validToolCalls;
					}
				}

				messages.push(msg);
			}

			// OpenAI format: tool_result → separate role='tool' messages
			for (const tr of toolResults) {
				if (tr.type === 'tool_result') {
					messages.push({
						role: 'tool',
						tool_call_id: (tr as any).tool_use_id,
						content: (tr as any).content ?? '',
					});
				}
			}
		}

		const body: Record<string, unknown> = {
			lane,
			messages,
			stream,
		};

		// Optional fields per QIC protocol
		if (request.sessionId) { body.session_id = request.sessionId; }
		if (request.context) { body.context = request.context; }
		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map(t => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}));
		}
		if (request.maxTokens) { body.max_tokens = request.maxTokens; }
		if (request.temperature !== undefined) { body.temperature = request.temperature; }

		return body;
	}

	// --- SSE event mapping ---

	/**
	 * Map a server SSE event to one or more canonical StreamChunks.
	 * Returns an array because a single server `tool_call` event must
	 * emit tool_call_start + tool_call_delta + tool_call_end.
	 */
	private mapServerEvent(eventType: string, data: Record<string, unknown>): StreamChunk[] {
		switch (eventType) {
			case 'routing': {
				// QIC routing event — informational, skip (contains lane/tier info)
				return [];
			}

			case 'content_delta':
			case 'text_delta': {
				const text = (data.text as string) ?? '';
				return [{ type: 'text', text }];
			}

			case 'tool_call_start': {
				const id = (data.id as string) ?? '';
				const name = (data.name as string) ?? '';
				return [{ type: 'tool_call_start', id, name }];
			}

			case 'tool_call': {
				// Server sends full tool call in one event — emit all 3 chunks
				const id = (data.id as string) ?? '';
				const name = (data.name as string) ?? '';
				// Handle input as either JSON string or object
				const rawInput = data.input;
				const input = typeof rawInput === 'string' ? rawInput : (rawInput ? JSON.stringify(rawInput) : '');
				const chunks: StreamChunk[] = [
					{ type: 'tool_call_start', id, name },
				];
				if (input) {
					chunks.push({ type: 'tool_call_delta', id, argumentsDelta: input });
				}
				chunks.push({ type: 'tool_call_end', id });
				return chunks;
			}

			case 'tool_call_delta': {
				const id = (data.id as string) ?? '';
				const rawDelta = data.input ?? data.arguments_delta;
				const argumentsDelta = typeof rawDelta === 'string' ? rawDelta : (rawDelta ? JSON.stringify(rawDelta) : '');
				return [{ type: 'tool_call_delta', id, argumentsDelta }];
			}

			case 'tool_call_end': {
				const id = (data.id as string) ?? '';
				return [{ type: 'tool_call_end', id }];
			}

			case 'stop':
			case 'done': {
				const usage = this.mapUsage(data.usage);
				const stopReason = (data.stop_reason as string) ?? (data.stopReason as string) ?? undefined;
				return [{ type: 'done', usage, stopReason }];
			}

			case 'usage': {
				// Usage-only event — skip (will be included in done)
				return [];
			}

			case 'error': {
				const message = (data.message as string) ?? 'Unknown server error';
				return [{ type: 'error', error: new QicError('QIC-P004', message) }];
			}

			// --- Anthropic SSE format compatibility ---
			// If the Delta Plus server proxies Anthropic events as-is, these
			// event types appear instead of the QIC protocol types above.
			case 'content_block_start': {
				const block = data.content_block as Record<string, unknown> | undefined;
				if (block?.type === 'tool_use') {
					const id = (block.id as string) ?? '';
					const name = (block.name as string) ?? '';
					this._streamingToolCallId = id;
					return [{ type: 'tool_call_start', id, name }];
				}
				// text block start — no chunk needed, text comes in deltas
				return [];
			}

			case 'content_block_delta': {
				const delta = data.delta as Record<string, unknown> | undefined;
				if (delta?.type === 'text_delta') {
					return [{ type: 'text', text: (delta.text as string) ?? '' }];
				}
				if (delta?.type === 'input_json_delta' && this._streamingToolCallId) {
					return [{
						type: 'tool_call_delta',
						id: this._streamingToolCallId,
						argumentsDelta: (delta.partial_json as string) ?? '',
					}];
				}
				return [];
			}

			case 'content_block_stop': {
				if (this._streamingToolCallId) {
					const id = this._streamingToolCallId;
					this._streamingToolCallId = null;
					return [{ type: 'tool_call_end', id }];
				}
				return [];
			}

			case 'message_start':
				return [];

			case 'message_delta': {
				const deltaObj = data.delta as Record<string, unknown> | undefined;
				return [{
					type: 'done',
					usage: this.mapUsage(data.usage),
					stopReason: (deltaObj?.stop_reason as string) ?? undefined,
				}];
			}

			case 'message_stop':
				return [{ type: 'done' }];

			case 'ping':
				return [];

			default: {
				// Fallback: try to map by data.type field
				const dataType = data.type as string;
				if (dataType === 'routing' || dataType === 'ping' || dataType === 'message_start') {
					return [];
				}
				if (dataType === 'text_delta' || dataType === 'content_delta') {
					return [{ type: 'text', text: (data.text as string) ?? '' }];
				}
				if (dataType === 'tool_call') {
					const id = (data.id as string) ?? '';
					const name = (data.name as string) ?? '';
					const rawInput = data.input;
					const input = typeof rawInput === 'string' ? rawInput : (rawInput ? JSON.stringify(rawInput) : '');
					const chunks: StreamChunk[] = [{ type: 'tool_call_start', id, name }];
					if (input) {
						chunks.push({ type: 'tool_call_delta', id, argumentsDelta: input });
					}
					chunks.push({ type: 'tool_call_end', id });
					return chunks;
				}
				// Anthropic format via data.type fallback
				if (dataType === 'content_block_start') {
					return this.mapServerEvent('content_block_start', data);
				}
				if (dataType === 'content_block_delta') {
					return this.mapServerEvent('content_block_delta', data);
				}
				if (dataType === 'content_block_stop') {
					return this.mapServerEvent('content_block_stop', data);
				}
				if (dataType === 'message_delta') {
					return this.mapServerEvent('message_delta', data);
				}
				if (dataType === 'message_stop') {
					return [{ type: 'done' }];
				}
				if (dataType === 'stop' || dataType === 'done') {
					return [{ type: 'done', usage: this.mapUsage(data.usage), stopReason: (data.stop_reason as string) ?? undefined }];
				}
				if (dataType === 'error') {
					return [{ type: 'error', error: new QicError('QIC-P004', (data.message as string) ?? 'Unknown error') }];
				}
				// Unknown event type — log for diagnostics
				console.warn(`[DeltaPlusAdapter] Unhandled SSE event: type="${eventType}" data.type="${dataType}"`);
				return [];
			}
		}
	}

	// --- Token management ---

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
		// Try refresh token first, then fall back to direct login
		let refreshFailed = false;

		if (this.config.refreshToken) {
			try {
				const data = await this.attemptTokenRefresh();
				this.applyTokenData(data);
				return;
			} catch (e) {
				// Any refresh failure (HTTP errors, network errors like net::ERR_FAILED) → try login fallback
				refreshFailed = true;
			}
		} else {
			refreshFailed = true;
		}

		// Fallback: direct login when refresh token is missing or invalid
		if (refreshFailed && this.config.loginFallback) {
			try {
				const result = await this.config.loginFallback();
				this.config.accessToken = result.accessToken;
				if (result.refreshToken) {
					this.config.refreshToken = result.refreshToken;
				}
				if (result.expiresIn) {
					this.config.tokenExpiresAt = Date.now() + (result.expiresIn * 1000);
				} else {
					this.config.tokenExpiresAt = this.decodeJwtExp(result.accessToken);
				}
				// Persist via callback
				try {
					await this.config.onTokenRefresh?.(result.accessToken, result.refreshToken);
				} catch {
					// Best-effort persistence
				}
				return;
			} catch (loginErr) {
				throw new QicError('QIC-P006', `Delta Plus re-login failed: ${loginErr instanceof Error ? loginErr.message : String(loginErr)}`);
			}
		}

		throw new QicError('QIC-P006', 'Delta Plus session expired. Please reconnect to the server.');
	}

	private async attemptTokenRefresh(): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
		let data: { access_token?: string; refresh_token?: string; expires_in?: number };

		if (this.requestService) {
			const cts = new CancellationTokenSource();
			setTimeout(() => cts.cancel(), 10_000);
			const context = await this.requestService.request({
				url: `${this.config.baseUrl}/v1/auth/refresh`,
				type: 'POST',
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ refresh_token: this.config.refreshToken }),
			}, cts.token);

			if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
				if (context.res.statusCode === 401 || context.res.statusCode === 403) {
					throw new QicError('QIC-P006', 'Refresh token expired', undefined, context.res.statusCode);
				}
				throw new QicError('QIC-P006', `Token refresh failed: ${context.res.statusCode}`, undefined, context.res.statusCode);
			}

			const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
			const raw = JSON.parse(buffer.toString()) as Record<string, unknown>;
			data = this.unwrapResponse(raw);
		} else {
			const resp = await fetch(`${this.config.baseUrl}/v1/auth/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: this.config.refreshToken }),
				signal: AbortSignal.timeout(10_000),
			});

			if (!resp.ok) {
				if (resp.status === 401 || resp.status === 403) {
					throw new QicError('QIC-P006', 'Refresh token expired', undefined, resp.status);
				}
				throw new QicError('QIC-P006', `Token refresh failed: ${resp.status}`, undefined, resp.status);
			}

			const raw = await resp.json() as Record<string, unknown>;
			data = this.unwrapResponse(raw);
		}

		if (!data.access_token) {
			throw new QicError('QIC-P006', 'Token refresh response missing access_token');
		}

		return data;
	}

	private applyTokenData(data: { access_token?: string; refresh_token?: string; expires_in?: number }): void {
		this.config.accessToken = data.access_token!;
		if (data.refresh_token) {
			this.config.refreshToken = data.refresh_token;
		}
		if (data.expires_in) {
			this.config.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
		} else {
			this.config.tokenExpiresAt = this.decodeJwtExp(data.access_token!);
		}
		// Persist via callback (fire-and-forget)
		this.config.onTokenRefresh?.(data.access_token!, data.refresh_token).catch(() => { /* best-effort */ });
	}

	private async ensureTokenFresh(): Promise<void> {
		if (!this.config.tokenExpiresAt || !this.config.refreshToken) { return; }
		const remaining = this.config.tokenExpiresAt - Date.now();
		if (remaining < PROACTIVE_REFRESH_THRESHOLD_MS) {
			try {
				await this.refreshAccessToken();
			} catch {
				// Best-effort — actual 401 handling will catch failures
			}
		}
	}

	// --- Helpers ---

	private getHeaders(): Record<string, string> {
		return {
			'Authorization': `Bearer ${this.config.accessToken}`,
			'Content-Type': 'application/json',
			'X-QIC-Idempotency-Key': randomUUID(),
		};
	}

	private decodeJwtExp(token: string): number | undefined {
		try {
			const parts = token.split('.');
			if (parts.length !== 3) { return undefined; }
			const payload = JSON.parse(atob(parts[1])) as { exp?: number };
			if (typeof payload.exp === 'number') {
				return payload.exp * 1000;
			}
		} catch {
			// Not a valid JWT
		}
		return undefined;
	}

	private mapUsage(raw: any): TokenUsage | undefined {
		if (!raw) { return undefined; }
		return {
			inputTokens: raw.input_tokens ?? raw.inputTokens ?? 0,
			outputTokens: raw.output_tokens ?? raw.outputTokens ?? 0,
			cacheReadTokens: raw.cache_read_tokens ?? raw.cacheReadTokens,
			cacheWriteTokens: raw.cache_creation_tokens ?? raw.cacheWriteTokens,
		};
	}

	/**
	 * Unwrap Delta Plus server response envelope.
	 * Server wraps responses as { success: true, data: { ... } }.
	 */
	private unwrapResponse(raw: Record<string, unknown>): any {
		if (raw.data && typeof raw.data === 'object') {
			return raw.data;
		}
		return raw;
	}

	/**
	 * Detect transient network errors (e.g. Chromium net::ERR_FAILED after session instability).
	 * These are safe to retry since the request never reached the server.
	 */
	private isTransientNetworkError(err: unknown): boolean {
		if (err instanceof Error) {
			const msg = err.message;
			return msg.includes('net::ERR_FAILED') ||
				msg.includes('net::ERR_CONNECTION_RESET') ||
				msg.includes('net::ERR_CONNECTION_REFUSED') ||
				msg.includes('net::ERR_NETWORK_CHANGED') ||
				msg.includes('ECONNRESET') ||
				msg.includes('ECONNREFUSED') ||
				msg.includes('fetch failed');
		}
		return false;
	}

	private normalizeErrorFromStatus(status: number, body: string): QicError {
		const redacted = redactErrorBody(body);

		if (status === 401) {
			return new QicError('QIC-P006', 'Delta Plus session expired. Please reconnect to the server.', undefined, 401);
		}
		if (status === 429) {
			return new QicError('QIC-P005', `Rate limited. ${redacted}`, undefined, 429);
		}

		return new QicError('QIC-P004', `Delta Plus Server error ${status}: ${redacted}`, undefined, status);
	}
}
