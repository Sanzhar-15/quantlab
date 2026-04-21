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

export interface OpenAIConfig {
	apiKey: string;
	baseUrl?: string;
	defaultModel?: string;
}

export class OpenAIAdapter implements ProviderAdapter {
	readonly id = 'openai';
	readonly name = 'OpenAI';
	readonly type = 'llm' as const;
	private readonly config: OpenAIConfig;
	private readonly activeRequests = new Map<string, AbortController>();
	private readonly requestService?: IRequestService;

	constructor(config: OpenAIConfig, requestService?: IRequestService) {
		this.requestService = requestService;
		// Validate API key
		if (!config.apiKey || !config.apiKey.trim()) {
			throw new QicError('QIC-P006', 'OpenAI API key is required');
		}
		// Warn if key format doesn't look right (but don't reject - OpenAI might change format)
		if (!config.apiKey.startsWith('sk-')) {
			console.warn('[OpenAIAdapter] API key may be invalid (expected format: sk-...)');
		}
		this.config = config;
		// Validate baseUrl at construction time
		this.validateBaseUrl();
	}

	private validateBaseUrl(): void {
		const url = this.config.baseUrl ?? 'https://api.openai.com';
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:') {
				throw new QicError('QIC-N001', `OpenAI baseUrl must use HTTPS: ${url}`);
			}
			// Block localhost for security (SSRF prevention)
			if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
				throw new QicError('QIC-N001', `OpenAI baseUrl cannot point to localhost: ${url}`);
			}
		} catch (e) {
			if (e instanceof QicError) { throw e; }
			throw new QicError('QIC-N001', `Invalid OpenAI baseUrl: ${url}`);
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
			let statusOk: boolean;

			if (this.requestService) {
				const cts = new CancellationTokenSource();
				setTimeout(() => cts.cancel(), 5000);
				const context = await this.requestService.request({
					url: `${this.baseUrl}/v1/models`,
					type: 'GET',
					headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
				}, cts.token);
				statusOk = context.res.statusCode !== undefined && context.res.statusCode >= 200 && context.res.statusCode < 300;
			} else {
				const response = await fetch(`${this.baseUrl}/v1/models`, {
					headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
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
						url: `${this.baseUrl}/v1/chat/completions`,
						type: 'POST',
						headers: this.getHeaders(),
						data: bodyStr,
					}, cts.token);
				} catch (reqErr) {
					const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
					throw new QicError('QIC-N002', `Failed to connect to OpenAI API: ${message}. Check your internet connection.`);
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
					response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
						method: 'POST',
						headers: this.getHeaders(),
						body: bodyStr,
						signal: request.signal ?? controller.signal,
					});
				} catch (fetchErr) {
					// Network error (DNS failure, connection refused, etc.)
					const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
					throw new QicError('QIC-N002', `Failed to connect to OpenAI API: ${message}. Check your internet connection.`);
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
					url: `${this.baseUrl}/v1/chat/completions`,
					type: 'POST',
					headers: this.getHeaders(),
					data: bodyStr,
				}, cts.token);
			} catch (reqErr) {
				const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
				throw new QicError('QIC-N002', `Failed to connect to OpenAI API: ${message}. Check your internet connection.`);
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

			yield* handler.parseSSEStream(readLines(), 'openai');
		} else {
			let response: Response;
			try {
				response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
					method: 'POST',
					headers: this.getHeaders(),
					body: bodyStr,
					signal: request.signal,
				});
			} catch (fetchErr) {
				// Network error (DNS failure, connection refused, etc.)
				const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
				throw new QicError('QIC-N002', `Failed to connect to OpenAI API: ${message}. Check your internet connection.`);
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

			yield* handler.parseSSEStream(readLines(), 'openai');
		}
	}

	cancelRequest(requestId: string): void {
		this.activeRequests.get(requestId)?.abort();
		this.activeRequests.delete(requestId);
	}

	private get baseUrl(): string {
		// Validation already done in constructor via validateBaseUrl()
		return this.config.baseUrl ?? 'https://api.openai.com';
	}

	private getHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${this.config.apiKey}`,
		};
	}

	private buildRequestBody(request: ProviderRequest): any {
		// OpenAI uses a separate 'tool' role for tool results, not content blocks
		const messages: any[] = [];
		for (const m of request.messages) {
			if (typeof m.content === 'string') {
				messages.push({ role: m.role, content: m.content });
				continue;
			}
			// Check for tool_result blocks — OpenAI expects these as role='tool' messages
			const toolResults = m.content.filter(b => b.type === 'tool_result');
			const otherBlocks = m.content.filter(b => b.type !== 'tool_result');

			if (otherBlocks.length > 0) {
				const textBlocks = otherBlocks.filter(b => b.type === 'text');
				const toolUseBlocks = otherBlocks.filter(b => b.type === 'tool_use');

				const msg: any = {
					role: m.role,
					content: textBlocks.length > 0
						? textBlocks.map(b => ('text' in b ? b.text : '')).join('')
						: null,
				};

				// OpenAI expects tool_use as tool_calls at message level, not content blocks
				if (toolUseBlocks.length > 0) {
					msg.tool_calls = toolUseBlocks.map(b => ({
						id: ('id' in b ? b.id : ''),
						type: 'function',
						function: {
							name: ('name' in b ? b.name : ''),
							arguments: JSON.stringify('input' in b ? b.input : {}),
						},
					}));
				}

				messages.push(msg);
			}

			for (const tr of toolResults) {
				if (tr.type === 'tool_result') {
					messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
				}
			}
		}

		const body: any = {
			model: request.model,
			max_tokens: request.maxTokens ?? 4096,
			messages,
		};

		if (request.temperature !== undefined) { body.temperature = request.temperature; }
		if (request.tools?.length) {
			body.tools = request.tools.map(t => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}));
		}

		return body;
	}

	private normalizeResponse(data: any): ProviderResponse {
		const choice = data.choices?.[0];
		const content: ContentBlock[] = [];

		if (choice?.message?.content) {
			content.push({ type: 'text', text: choice.message.content });
		}

		if (choice?.message?.tool_calls) {
			for (const tc of choice.message.tool_calls) {
				content.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.function.name,
					input: JSON.parse(tc.function.arguments || '{}'),
				});
			}
		}

		const usage: TokenUsage | undefined = data.usage ? {
			inputTokens: data.usage.prompt_tokens,
			outputTokens: data.usage.completion_tokens,
		} : undefined;

		return {
			content,
			usage,
			stopReason: this.normalizeStopReason(choice?.finish_reason),
		};
	}

	private normalizeStopReason(reason: string): ProviderResponse['stopReason'] {
		const map: Record<string, ProviderResponse['stopReason']> = {
			'stop': 'end_turn',
			'tool_calls': 'tool_use',
			'length': 'max_tokens',
		};
		return map[reason] ?? 'end_turn';
	}

	private normalizeError(status: number, body: string): QicError {
		if (status === 401) { return new QicError('QIC-P006', 'OpenAI authentication failed', undefined, status); }
		if (status === 429) { return new QicError('QIC-P005', 'OpenAI rate limit reached', undefined, status); }
		return new QicError('QIC-P004', `OpenAI error ${status}: ${redactErrorBody(body)}`, undefined, status);
	}
}
