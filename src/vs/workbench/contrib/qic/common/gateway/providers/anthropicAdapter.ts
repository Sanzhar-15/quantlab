/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from '../../qicCrypto.js';
import type { ProviderAdapter, ProviderHealth, StreamChunk } from '../../canonical/interfaces.js';
import type { ProviderRequest, ProviderResponse, ContentBlock, TokenUsage } from '../../canonical/types.js';
import { QicError } from '../../canonical/types.js';
import { StreamingResponseHandler } from '../streamingHandler.js';
import { redactErrorBody } from './errorRedaction.js';
import type { IRequestService } from '../../../../../../platform/request/common/request.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { consumeStream, listenStream } from '../../../../../../base/common/stream.js';

export interface AnthropicConfig {
	apiKey: string;
	baseUrl?: string;
	defaultModel?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
	readonly id = 'anthropic';
	readonly name = 'Anthropic';
	readonly type = 'llm' as const;
	private readonly config: AnthropicConfig;
	private readonly activeRequests = new Map<string, AbortController>();
	private readonly requestService?: IRequestService;

	constructor(config: AnthropicConfig, requestService?: IRequestService) {
		this.requestService = requestService;
		// Validate API key
		if (!config.apiKey || !config.apiKey.trim()) {
			throw new QicError('QIC-P006', 'Anthropic API key is required');
		}
		// Warn if key format doesn't look right (but don't reject - Anthropic might change format)
		if (!config.apiKey.startsWith('sk-ant-')) {
			console.warn('[AnthropicAdapter] API key may be invalid (expected format: sk-ant-...)');
		}
		this.config = config;
		// Validate baseUrl at construction time
		this.validateBaseUrl();
	}

	private validateBaseUrl(): void {
		const url = this.config.baseUrl ?? 'https://api.anthropic.com';
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:') {
				throw new QicError('QIC-N001', `Anthropic baseUrl must use HTTPS: ${url}`);
			}
			// Block localhost for security (SSRF prevention)
			if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
				throw new QicError('QIC-N001', `Anthropic baseUrl cannot point to localhost: ${url}`);
			}
		} catch (e) {
			if (e instanceof QicError) { throw e; }
			throw new QicError('QIC-N001', `Invalid Anthropic baseUrl: ${url}`);
		}
	}

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
			const body = JSON.stringify({
				model: this.config.defaultModel ?? 'claude-sonnet-4-20250514',
				max_tokens: 1,
				messages: [{ role: 'user', content: 'ping' }],
			});

			let statusOk: boolean;

			if (this.requestService) {
				const cts = new CancellationTokenSource();
				setTimeout(() => cts.cancel(), 5000);
				const context = await this.requestService.request({
					url: `${this.baseUrl}/v1/messages`,
					type: 'POST',
					headers: this.getHeaders(),
					data: body,
				}, cts.token);
				statusOk = context.res.statusCode !== undefined && context.res.statusCode >= 200 && context.res.statusCode < 300;
			} else {
				const response = await fetch(`${this.baseUrl}/v1/messages`, {
					method: 'POST',
					headers: this.getHeaders(),
					body,
					signal: AbortSignal.timeout(5000),
				});
				statusOk = response.ok;
			}

			return {
				status: statusOk ? 'healthy' : 'degraded',
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

	async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
		const controller = new AbortController();
		const requestId = randomUUID();
		this.activeRequests.set(requestId, controller);

		try {
			const body = this.buildRequestBody(request);
			const bodyStr = JSON.stringify(body);
			let data: any;

			if (this.requestService) {
				const cts = new CancellationTokenSource();
				if (request.signal) {
					request.signal.addEventListener('abort', () => cts.cancel());
				}

				let context;
				try {
					context = await this.requestService.request({
						url: `${this.baseUrl}/v1/messages`,
						type: 'POST',
						headers: this.getHeaders(),
						data: bodyStr,
					}, cts.token);
				} catch (reqErr) {
					const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
					throw new QicError('QIC-N002', `Failed to connect to Anthropic API: ${message}. Check your internet connection.`);
				}

				if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
					const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
					throw this.normalizeError(context.res.statusCode ?? 500, buffer.toString());
				}

				const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
				data = JSON.parse(buffer.toString());
			} else {
				let response: Response;
				try {
					response = await fetch(`${this.baseUrl}/v1/messages`, {
						method: 'POST',
						headers: this.getHeaders(),
						body: bodyStr,
						signal: request.signal ?? controller.signal,
					});
				} catch (fetchErr) {
					// Network error (DNS failure, connection refused, etc.)
					const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
					throw new QicError('QIC-N002', `Failed to connect to Anthropic API: ${message}. Check your internet connection.`);
				}

				if (!response.ok) {
					throw this.normalizeError(response.status, await response.text());
				}

				data = await response.json();
			}

			return this.normalizeResponse(data);
		} finally {
			this.activeRequests.delete(requestId);
		}
	}

	async *sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk> {
		const body = this.buildRequestBody(request);
		body.stream = true;
		const bodyStr = JSON.stringify(body);

		const handler = new StreamingResponseHandler();

		if (this.requestService) {
			const cts = new CancellationTokenSource();
			if (request.signal) {
				request.signal.addEventListener('abort', () => cts.cancel());
			}

			let context;
			try {
				context = await this.requestService.request({
					url: `${this.baseUrl}/v1/messages`,
					type: 'POST',
					headers: this.getHeaders(),
					data: bodyStr,
				}, cts.token);
			} catch (reqErr) {
				const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
				throw new QicError('QIC-N002', `Failed to connect to Anthropic API: ${message}. Check your internet connection.`);
			}

			if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
				const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
				throw this.normalizeError(context.res.statusCode ?? 500, buffer.toString());
			}

			// Convert VSBufferReadableStream to async iterable using a queue
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

			yield* handler.parseSSEStream(readLines(), 'anthropic');
		} else {
			let response: Response;
			try {
				response = await fetch(`${this.baseUrl}/v1/messages`, {
					method: 'POST',
					headers: this.getHeaders(),
					body: bodyStr,
					signal: request.signal,
				});
			} catch (fetchErr) {
				// Network error (DNS failure, connection refused, etc.)
				const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
				throw new QicError('QIC-N002', `Failed to connect to Anthropic API: ${message}. Check your internet connection.`);
			}

			if (!response.ok || !response.body) {
				throw this.normalizeError(response.status, await response.text());
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

			yield* handler.parseSSEStream(readLines(), 'anthropic');
		}
	}

	cancelRequest(requestId: string): void {
		this.activeRequests.get(requestId)?.abort();
		this.activeRequests.delete(requestId);
	}

	private get baseUrl(): string {
		// Validation already done in constructor via validateBaseUrl()
		return this.config.baseUrl ?? 'https://api.anthropic.com';
	}

	private getHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'X-Api-Key': this.config.apiKey,
			'anthropic-version': '2023-06-01',
		};
	}

	private buildRequestBody(request: ProviderRequest): any {
		const body: any = {
			model: request.model,
			max_tokens: request.maxTokens ?? 4096,
			messages: request.messages.filter(m => m.role !== 'system').map(m => ({
				role: m.role,
				content: typeof m.content === 'string' ? m.content : m.content.map(b => {
					if (b.type === 'text') { return { type: 'text', text: b.text }; }
					if (b.type === 'tool_result') { return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }; }
					return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
				}),
			})),
		};

		const systemMsg = request.messages.find(m => m.role === 'system');
		if (systemMsg) {
			body.system = typeof systemMsg.content === 'string'
				? systemMsg.content
				: systemMsg.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n');
		}

		if (request.temperature !== undefined) { body.temperature = request.temperature; }
		if (request.tools?.length) {
			body.tools = request.tools.map(t => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}));
		}

		return body;
	}

	private normalizeResponse(data: any): ProviderResponse {
		const content: ContentBlock[] = (data.content ?? []).map((block: any) => {
			if (block.type === 'text') {
				return { type: 'text' as const, text: block.text };
			}
			if (block.type === 'tool_use') {
				return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
			}
			return { type: 'text' as const, text: '' };
		});

		const usage: TokenUsage | undefined = data.usage ? {
			inputTokens: data.usage.input_tokens,
			outputTokens: data.usage.output_tokens,
			cacheReadTokens: data.usage.cache_read_input_tokens,
			cacheWriteTokens: data.usage.cache_creation_input_tokens,
		} : undefined;

		return {
			content,
			usage,
			stopReason: this.normalizeStopReason(data.stop_reason),
		};
	}

	private normalizeStopReason(reason: string): ProviderResponse['stopReason'] {
		const map: Record<string, ProviderResponse['stopReason']> = {
			'end_turn': 'end_turn',
			'tool_use': 'tool_use',
			'max_tokens': 'max_tokens',
			'stop_sequence': 'stop_sequence',
		};
		return map[reason] ?? 'end_turn';
	}

	private normalizeError(status: number, body: string): QicError {
		if (status === 401) { return new QicError('QIC-P006', 'Anthropic authentication failed', undefined, status); }
		if (status === 429) { return new QicError('QIC-P005', 'Anthropic rate limit reached', undefined, status); }
		if (status === 529) { return new QicError('QIC-P004', 'Anthropic overloaded', undefined, status); }
		return new QicError('QIC-P004', `Anthropic error ${status}: ${redactErrorBody(body)}`, undefined, status);
	}
}
