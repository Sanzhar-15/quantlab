/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderAdapter, ProviderHealth, StreamChunk } from '../../canonical/interfaces.js';
import type { ProviderRequest, ProviderResponse, ContentBlock } from '../../canonical/types.js';
import { QicError } from '../../canonical/types.js';
import { StreamingResponseHandler } from '../streamingHandler.js';
import type { IRequestService } from '../../../../../../platform/request/common/request.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { consumeStream, listenStream } from '../../../../../../base/common/stream.js';

export interface OllamaConfig {
	baseUrl?: string;
	defaultModel?: string;
}

const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

export class OllamaAdapter implements ProviderAdapter {
	readonly id = 'ollama';
	readonly name = 'Ollama';
	readonly type = 'llm' as const;
	private readonly config: OllamaConfig;
	private readonly requestService?: IRequestService;

	constructor(config?: OllamaConfig, requestService?: IRequestService) {
		this.config = config ?? {};
		this.requestService = requestService;
		this.validateBaseUrl(this.baseUrl);
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
			if (this.requestService) {
				const cts = new CancellationTokenSource();
				setTimeout(() => cts.cancel(), 3000);
				const context = await this.requestService.request({
					url: `${this.baseUrl}/api/tags`,
					type: 'GET',
				}, cts.token);
				return {
					status: context.res.statusCode && context.res.statusCode >= 200 && context.res.statusCode < 300 ? 'healthy' : 'degraded',
					latencyMs: Date.now() - start,
					errorRate: 0,
					lastChecked: new Date().toISOString(),
				};
			}
			// Fallback to fetch (may fail due to CSP in renderer)
			const response = await fetch(`${this.baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(3000),
			});
			return {
				status: response.ok ? 'healthy' : 'degraded',
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
		const body: Record<string, unknown> = {
			model: request.model,
			messages: this.buildMessages(request),
			stream: false,
			options: {
				temperature: request.temperature ?? 0.7,
				num_predict: request.maxTokens ?? 4096,
			},
		};

		// Pass tools to Ollama (supported since Ollama 0.2+)
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

		let data: any;

		if (this.requestService) {
			const cts = new CancellationTokenSource();
			if (request.signal) {
				request.signal.addEventListener('abort', () => cts.cancel());
			}
			const context = await this.requestService.request({
				url: `${this.baseUrl}/api/chat`,
				type: 'POST',
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify(body),
			}, cts.token);

			if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
				throw new QicError('QIC-P004', `Ollama error: ${context.res.statusCode}`);
			}

			// Read the response stream using VS Code's consumeStream
			const buffer = await consumeStream<VSBuffer>(context.stream, chunks => VSBuffer.concat(chunks));
			const text = buffer.toString();
			data = JSON.parse(text);
		} else {
			// Fallback to fetch (may fail due to CSP in renderer)
			const response = await fetch(`${this.baseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: request.signal,
			});

			if (!response.ok) {
				throw new QicError('QIC-P004', `Ollama error: ${response.status}`);
			}

			data = await response.json();
		}

		const content: ContentBlock[] = [];

		if (data.message?.content) {
			content.push({ type: 'text', text: data.message.content });
		}

		// Parse tool calls from Ollama response
		if (data.message?.tool_calls && Array.isArray(data.message.tool_calls)) {
			for (const tc of data.message.tool_calls) {
				if (tc.function) {
					content.push({
						type: 'tool_use',
						id: `ollama-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						name: tc.function.name,
						input: typeof tc.function.arguments === 'string'
							? JSON.parse(tc.function.arguments)
							: tc.function.arguments ?? {},
					});
				}
			}
		}

		const hasToolCalls = content.some(b => b.type === 'tool_use');

		return {
			content,
			usage: data.eval_count ? {
				inputTokens: data.prompt_eval_count ?? 0,
				outputTokens: data.eval_count,
			} : undefined,
			stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
		};
	}

	async *sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: this.buildMessages(request),
			stream: true,
			options: {
				temperature: request.temperature ?? 0.7,
				num_predict: request.maxTokens ?? 4096,
			},
		};

		// Pass tools to Ollama (supported since Ollama 0.2+)
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

		const handler = new StreamingResponseHandler();

		if (this.requestService) {
			const cts = new CancellationTokenSource();
			if (request.signal) {
				request.signal.addEventListener('abort', () => cts.cancel());
			}

			const context = await this.requestService.request({
				url: `${this.baseUrl}/api/chat`,
				type: 'POST',
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify(body),
			}, cts.token);

			if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
				throw new QicError('QIC-P004', `Ollama streaming error: ${context.res.statusCode}`);
			}

			// Convert VSBufferReadableStream to async iterable using a queue
			const queue: string[] = [];
			let streamDone = false;
			let resolver: (() => void) | null = null;

			listenStream<VSBuffer>(context.stream, {
				onData: (chunk) => {
					const text = chunk.toString();
					const lines = text.split('\n');
					for (const line of lines) {
						if (line.trim()) {
							queue.push(line);
							resolver?.();
						}
					}
				},
				onError: () => { streamDone = true; resolver?.(); },
				onEnd: () => { streamDone = true; resolver?.(); },
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

			yield* handler.parseSSEStream(readLines(), 'ollama');
		} else {
			// Fallback to fetch (may fail due to CSP in renderer)
			const response = await fetch(`${this.baseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: request.signal,
			});

			if (!response.ok || !response.body) {
				throw new QicError('QIC-P004', `Ollama streaming error: ${response.status}`);
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
						if (line.trim()) { yield line; }
					}
				}
				if (buffer.trim()) { yield buffer; }
			}

			yield* handler.parseSSEStream(readLines(), 'ollama');
		}
	}

	cancelRequest(_requestId: string): void {
		// Ollama doesn't support request cancellation via API
	}

	/**
	 * Build Ollama messages array, handling tool_use and tool_result content blocks.
	 */
	private buildMessages(request: ProviderRequest): object[] {
		return request.messages.map(m => {
			const msg: Record<string, unknown> = { role: m.role };

			if (typeof m.content === 'string') {
				msg.content = m.content;
			} else {
				// Extract text content
				const textParts = m.content.filter(b => b.type === 'text').map(b => (b as any).text ?? '');
				msg.content = textParts.join('\n');

				// Extract tool_use blocks as tool_calls (for assistant messages)
				const toolUseParts = m.content.filter(b => b.type === 'tool_use');
				if (toolUseParts.length > 0) {
					msg.tool_calls = toolUseParts.map(b => ({
						function: {
							name: (b as any).name,
							arguments: (b as any).input ?? {},
						},
					}));
				}

				// Extract tool_result blocks (for tool response messages)
				const toolResultParts = m.content.filter(b => b.type === 'tool_result');
				if (toolResultParts.length > 0) {
					msg.role = 'tool';
					msg.content = toolResultParts.map(b => (b as any).content ?? '').join('\n');
				}
			}

			return msg;
		});
	}

	private get baseUrl(): string {
		return this.config.baseUrl ?? 'http://localhost:11434';
	}

	/**
	 * SSRF prevention (Audit XI-SV6 / Remediation 5a).
	 * Hostname must be localhost, 127.0.0.1, or ::1.
	 */
	private validateBaseUrl(url: string): void {
		try {
			const parsed = new URL(url);
			if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
				throw new QicError('QIC-N001', `Ollama URL blocked: hostname '${parsed.hostname}' is not allowed. Must be localhost.`);
			}
		} catch (e) {
			if (e instanceof QicError) { throw e; }
			throw new QicError('QIC-N001', `Invalid Ollama URL: ${url}`);
		}
	}
}
