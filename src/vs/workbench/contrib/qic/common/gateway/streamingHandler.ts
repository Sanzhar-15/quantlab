/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { StreamChunk } from '../canonical/interfaces.js';
import type { ToolCall, TokenUsage } from '../canonical/types.js';

/**
 * SSE parsing and provider-specific normalization (Audit VII-DS3).
 */
export class StreamingResponseHandler {
	private readonly pendingToolCalls = new Map<string, { name: string; jsonParts: string[] }>();
	private currentToolCallId: string | null = null;

	async *parseSSEStream(
		lines: AsyncIterable<string>,
		format: 'anthropic' | 'openai' | 'ollama',
	): AsyncIterable<StreamChunk> {
		// Reset state at the start to prevent stale data from previous streams
		this.reset();

		let dataBuffer: string[] = [];

		for await (const line of lines) {
			// SSE spec: empty line dispatches the event
			if (line.trim() === '') {
				if (dataBuffer.length > 0) {
					const data = dataBuffer.join('\n');
					dataBuffer = [];

					if (data === '[DONE]') { break; }

					let parsed: any;
					try {
						parsed = JSON.parse(data);
					} catch {
						continue;
					}

					let result: StreamChunk | StreamChunk[] | null = null;
					switch (format) {
						case 'anthropic':
							result = this.normalizeAnthropicEvent(parsed);
							break;
						case 'openai':
							result = this.normalizeOpenAIEvent(parsed);
							break;
						case 'ollama':
							result = this.normalizeOllamaEvent(parsed);
							break;
					}

					if (result) {
						if (Array.isArray(result)) {
							for (const chunk of result) { yield chunk; }
						} else {
							yield result;
						}
					}
				}
				continue;
			}

			if (line.startsWith(':')) { continue; } // SSE comment
			if (line.startsWith('event:')) { continue; } // SSE event type (not data)

			if (line.startsWith('data: ')) {
				dataBuffer.push(line.slice(6));
			} else if (line.startsWith('data:')) {
				dataBuffer.push(line.slice(5));
			} else {
				// Non-standard: treat raw line as data for Ollama compatibility
				dataBuffer.push(line);
			}
		}

		// Flush any remaining buffered data
		if (dataBuffer.length > 0) {
			const data = dataBuffer.join('\n');
			if (data !== '[DONE]') {
				try {
					const parsed = JSON.parse(data);
					let result: StreamChunk | StreamChunk[] | null = null;
					switch (format) {
						case 'anthropic': result = this.normalizeAnthropicEvent(parsed); break;
						case 'openai': result = this.normalizeOpenAIEvent(parsed); break;
						case 'ollama': result = this.normalizeOllamaEvent(parsed); break;
					}
					if (result) {
						if (Array.isArray(result)) {
							for (const chunk of result) { yield chunk; }
						} else {
							yield result;
						}
					}
				} catch { /* ignore parse error on flush */ }
			}
		}
	}

	normalizeAnthropicEvent(event: any): StreamChunk | null {
		switch (event.type) {
			case 'content_block_delta':
				if (event.delta?.type === 'text_delta') {
					return { type: 'text', text: event.delta.text };
				}
				if (event.delta?.type === 'input_json_delta' && this.currentToolCallId) {
					return {
						type: 'tool_call_delta',
						id: this.currentToolCallId,
						argumentsDelta: event.delta.partial_json,
					};
				}
				return null;

			case 'content_block_start':
				if (event.content_block?.type === 'tool_use') {
					this.currentToolCallId = event.content_block.id;
					return {
						type: 'tool_call_start',
						id: event.content_block.id,
						name: event.content_block.name,
					};
				}
				return null;

			case 'content_block_stop':
				if (this.currentToolCallId) {
					const id = this.currentToolCallId;
					this.currentToolCallId = null;
					return { type: 'tool_call_end', id };
				}
				return null;

			case 'message_delta':
				return {
					type: 'done',
					usage: event.usage as TokenUsage | undefined,
					stopReason: event.delta?.stop_reason,
				};

			case 'message_stop':
				return { type: 'done' };

			default:
				return null;
		}
	}

	/**
	 * Normalize OpenAI streaming events. Processes ALL tool call entries
	 * in the tool_calls array (not just the first), and emits tool_call_end
	 * events when finish_reason is 'tool_calls'.
	 */
	normalizeOpenAIEvent(event: any): StreamChunk | StreamChunk[] | null {
		const choice = event.choices?.[0];
		if (!choice) { return null; }

		if (choice.delta?.content) {
			return { type: 'text', text: choice.delta.content };
		}

		if (choice.delta?.tool_calls) {
			const chunks: StreamChunk[] = [];
			for (const tc of choice.delta.tool_calls) {
				if (tc.function?.name) {
					const id = tc.id ?? String(tc.index);
					this.currentToolCallId = id;
					chunks.push({ type: 'tool_call_start', id, name: tc.function.name });
				}
				if (tc.function?.arguments) {
					const id = tc.id ?? this.currentToolCallId ?? String(tc.index);
					chunks.push({ type: 'tool_call_delta', id, argumentsDelta: tc.function.arguments });
				}
			}
			if (chunks.length === 1) { return chunks[0]; }
			if (chunks.length > 1) { return chunks; }
		}

		if (choice.finish_reason) {
			const chunks: StreamChunk[] = [];
			// Emit tool_call_end for any pending tool calls before 'done'
			if (choice.finish_reason === 'tool_calls') {
				for (const [id] of this.pendingToolCalls) {
					chunks.push({ type: 'tool_call_end', id });
				}
			}
			chunks.push({
				type: 'done',
				stopReason: choice.finish_reason,
				usage: event.usage ? {
					inputTokens: event.usage.prompt_tokens ?? 0,
					outputTokens: event.usage.completion_tokens ?? 0,
				} : undefined,
			});
			if (chunks.length === 1) { return chunks[0]; }
			return chunks;
		}

		return null;
	}

	private normalizeOllamaEvent(event: any): StreamChunk | StreamChunk[] | null {
		// Handle tool calls from Ollama (supported since Ollama 0.2+)
		if (event.message?.tool_calls && Array.isArray(event.message.tool_calls)) {
			const chunks: StreamChunk[] = [];
			for (const tc of event.message.tool_calls) {
				if (tc.function) {
					const id = `ollama-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const argsStr = typeof tc.function.arguments === 'string'
						? tc.function.arguments
						: JSON.stringify(tc.function.arguments ?? {});
					chunks.push({ type: 'tool_call_start', id, name: tc.function.name });
					chunks.push({ type: 'tool_call_delta', id, argumentsDelta: argsStr });
					chunks.push({ type: 'tool_call_end', id });
				}
			}
			if (chunks.length > 0) {
				return chunks;
			}
		}

		if (event.done) {
			const chunks: StreamChunk[] = [];
			// Emit tool_call_end for any pending tool calls before 'done'
			for (const [id] of this.pendingToolCalls) {
				chunks.push({ type: 'tool_call_end', id });
			}
			chunks.push({ type: 'done', stopReason: 'end_turn' });
			if (chunks.length === 1) { return chunks[0]; }
			return chunks;
		}
		if (event.message?.content) {
			return { type: 'text', text: event.message.content };
		}
		if (event.response) {
			return { type: 'text', text: event.response };
		}
		return null;
	}

	accumulateToolCall(chunk: StreamChunk): ToolCall | null {
		if (chunk.type === 'tool_call_start') {
			this.pendingToolCalls.set(chunk.id, { name: chunk.name, jsonParts: [] });
			return null;
		}

		if (chunk.type === 'tool_call_delta') {
			const pending = this.pendingToolCalls.get(chunk.id);
			if (pending) {
				pending.jsonParts.push(chunk.argumentsDelta);
			}
			return null;
		}

		if (chunk.type === 'tool_call_end') {
			const pending = this.pendingToolCalls.get(chunk.id);
			if (pending) {
				this.pendingToolCalls.delete(chunk.id);
				const argsJson = pending.jsonParts.join('');
				let args: Record<string, unknown>;
				try {
					args = JSON.parse(argsJson);
				} catch {
					args = {};
				}
				return { id: chunk.id, name: pending.name, arguments: args };
			}
		}

		return null;
	}

	reset(): void {
		this.pendingToolCalls.clear();
		this.currentToolCallId = null;
	}
}
