/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from '../../qicCrypto.js';
import type { ProviderAdapter, ProviderHealth, StreamChunk, GatewayMetadata } from '../../canonical/interfaces.js';
import type { LaneName } from '../../canonical/lanes.js';
import { QicError, type ProviderRequest, type ProviderResponse, type TokenUsage, type ContentBlock } from '../../canonical/types.js';
import { redactErrorBody } from './errorRedaction.js';
import type { IRequestService } from '../../../../../../platform/request/common/request.js';
import type { IRequestContext } from '../../../../../../base/parts/request/common/request.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { consumeStream, listenStream } from '../../../../../../base/common/stream.js';

export interface DeltaPlusConfig {
	baseUrl: string;
}

const REQUEST_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const NETWORK_RETRY_MAX = 2;
const NETWORK_RETRY_BASE_MS = 500;

type StopReason = NonNullable<ProviderResponse['stopReason']>;
const STOP_REASONS: readonly StopReason[] = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A malformed server value is a protocol violation: it throws, it is never defaulted. */
function malformed(what: string): QicError {
	return new QicError('QIC-P004', `Malformed Delta Plus Server response: ${what}`);
}

function requireUsageNumber(value: unknown, field: string): number {
	if (typeof value !== 'number') {
		throw malformed(`usage.${field} is ${value === undefined ? 'missing' : `not a number (${typeof value})`}`);
	}
	return value;
}

/** JSON has no undefined: an optional field sent as null is treated as absent. */
function optionalUsageNumber(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	return requireUsageNumber(value, field);
}

/**
 * Provider adapter for Delta Plus Server LLM proxy.
 * Holds no credential: QIC's login is the host identity (QL-LOGIN), and the host keeps
 * the tokens in its own store. Requests therefore carry no Authorization header until the
 * data path (QL-DATA) routes them through the host; the server's 401 is the visible failure.
 * Uses IRequestService for HTTP to bypass CSP restrictions in the renderer.
 */
export class DeltaPlusAdapter implements ProviderAdapter {
	readonly id = 'deltaplus';
	readonly name = 'Delta Plus Server';
	readonly type = 'llm' as const;

	private readonly config: DeltaPlusConfig;
	private readonly activeRequests = new Map<string, AbortController>();
	private readonly requestService?: IRequestService;

	// State tracking for Anthropic-format SSE tool_use events
	private _streamingToolCallId: string | null = null;

	constructor(config: DeltaPlusConfig, requestService?: IRequestService) {
		this.requestService = requestService;
		this.config = config;
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

			if (result.status < 200 || result.status >= 300) {
				throw this.normalizeErrorFromStatus(result.status, result.body);
			}

			const rawOuter: unknown = JSON.parse(result.body);
			const raw = this.unwrapResponse(rawOuter);

			// Normalize response content
			const content = this.parseContent(raw.content);

			return {
				content,
				usage: this.mapUsage(raw.usage),
				stopReason: this.parseStopReason(raw.stop_reason ?? raw.stopReason),
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
		// All client lanes now exist on the server - no remapping needed.
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

		// Build messages - flatMap because tool_result blocks become separate role='tool' messages (OpenAI format)
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
				const textParts = otherBlocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
				const toolUseParts = otherBlocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');

				const msg: Record<string, unknown> = {
					role: m.role,
					content: textParts.length > 0
						? textParts.map(b => b.text).join('')
						: (toolUseParts.length > 0 ? null : ''),
				};

				// OpenAI format: tool_use → tool_calls with function wrapper
				if (toolUseParts.length > 0) {
					const validToolCalls = toolUseParts
						.filter(b => typeof b.name === 'string' && b.name.trim() !== '')
						.map(b => ({
							id: b.id,
							type: 'function',
							function: {
								name: b.name,
								arguments: JSON.stringify(b.input),
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
						tool_call_id: tr.tool_use_id,
						content: tr.content ?? '',
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
				// QIC routing event - informational, skip (contains lane/tier info)
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
				// Server sends full tool call in one event - emit all 3 chunks
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
				// Usage-only event - skip (will be included in done)
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
				// text block start - no chunk needed, text comes in deltas
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
					return [{ type: 'done', usage: this.mapUsage(data.usage), stopReason: this.parseStopReason(data.stop_reason) }];
				}
				if (dataType === 'error') {
					return [{ type: 'error', error: new QicError('QIC-P004', (data.message as string) ?? 'Unknown error') }];
				}
				// Unknown event type - log for diagnostics
				console.warn(`[DeltaPlusAdapter] Unhandled SSE event: type="${eventType}" data.type="${dataType}"`);
				return [];
			}
		}
	}

	// --- Helpers ---

	private getHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'X-QIC-Idempotency-Key': randomUUID(),
		};
	}

	/**
	 * Map server usage to TokenUsage. Absent usage (undefined or null) is undefined;
	 * present usage must carry numeric input and output token counts.
	 */
	private mapUsage(raw: unknown): TokenUsage | undefined {
		if (raw === undefined || raw === null) { return undefined; }
		if (!isRecord(raw)) {
			throw malformed(`usage is not an object (${typeof raw})`);
		}
		return {
			inputTokens: requireUsageNumber(raw.input_tokens ?? raw.inputTokens, 'input_tokens'),
			outputTokens: requireUsageNumber(raw.output_tokens ?? raw.outputTokens, 'output_tokens'),
			cacheReadTokens: optionalUsageNumber(raw.cache_read_tokens ?? raw.cacheReadTokens, 'cache_read_tokens'),
			cacheWriteTokens: optionalUsageNumber(raw.cache_creation_tokens ?? raw.cacheWriteTokens, 'cache_creation_tokens'),
		};
	}

	/**
	 * Validate a server stop reason. Absent (undefined or null) is undefined;
	 * every other value must be one of the four canonical stop reasons.
	 */
	private parseStopReason(raw: unknown): StopReason | undefined {
		if (raw === undefined || raw === null) { return undefined; }
		const stopReason = STOP_REASONS.find(r => r === raw);
		if (stopReason === undefined) {
			throw malformed(`unknown stop reason ${JSON.stringify(raw)}`);
		}
		return stopReason;
	}

	/**
	 * Unwrap Delta Plus server response envelope.
	 * Server wraps responses as { success: true, data: { ... } }; a body without a `data` object throws.
	 */
	private unwrapResponse(raw: unknown): Record<string, unknown> {
		if (!isRecord(raw)) {
			throw malformed('body is not a JSON object');
		}
		const data = raw.data;
		if (!isRecord(data)) {
			throw malformed('body has no `data` object');
		}
		return data;
	}

	/**
	 * Parse response `content`: a string is one text block, an array is parsed block by block.
	 */
	private parseContent(raw: unknown): ContentBlock[] {
		if (typeof raw === 'string') {
			return [{ type: 'text', text: raw }];
		}
		if (!Array.isArray(raw)) {
			throw malformed(`content is neither a string nor an array (${raw === null ? 'null' : typeof raw})`);
		}
		return raw.map((block: unknown, index: number) => this.parseContentBlock(block, index));
	}

	private parseContentBlock(block: unknown, index: number): ContentBlock {
		if (!isRecord(block)) {
			throw malformed(`content[${index}] is not an object`);
		}
		const type = block.type;
		if (typeof type !== 'string') {
			throw malformed(`content[${index}] has no string type`);
		}
		if (type === 'tool_use' || type === 'tool_call') {
			const id = block.id;
			const name = block.name;
			if (typeof id !== 'string') {
				throw malformed(`content[${index}] (${type}) has no string id`);
			}
			if (typeof name !== 'string') {
				throw malformed(`content[${index}] (${type}) has no string name`);
			}
			return { type: 'tool_use', id, name, input: this.parseToolInput(block.input, index) };
		}
		const text = block.text;
		if (typeof text !== 'string') {
			throw malformed(`content[${index}] (${type}) has no string text`);
		}
		return { type: 'text', text };
	}

	/**
	 * A tool_use input is either an object or a string holding a JSON object.
	 */
	private parseToolInput(input: unknown, index: number): Record<string, unknown> {
		if (typeof input === 'string') {
			let parsed: unknown;
			try {
				parsed = JSON.parse(input);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw malformed(`content[${index}].input is not valid JSON: ${message}`);
			}
			if (!isRecord(parsed)) {
				throw malformed(`content[${index}].input string does not hold a JSON object`);
			}
			return parsed;
		}
		if (!isRecord(input)) {
			throw malformed(`content[${index}].input is neither an object nor a JSON object string (${input === null ? 'null' : typeof input})`);
		}
		return input;
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
			return new QicError('QIC-P006', 'Delta Plus Server rejected the request (401): QIC requests carry no credential until the data path routes them through the host sign-in.', undefined, 401);
		}
		if (status === 429) {
			return new QicError('QIC-P005', `Rate limited. ${redacted}`, undefined, 429);
		}

		return new QicError('QIC-P004', `Delta Plus Server error ${status}: ${redacted}`, undefined, status);
	}
}
