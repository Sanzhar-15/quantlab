/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from '../../qicCrypto.js';
import type { ProviderAdapter, ProviderHealth, StreamChunk, GatewayMetadata } from '../../canonical/interfaces.js';
import type { LaneName } from '../../canonical/lanes.js';
import { QicError, type ProviderRequest, type ProviderResponse, type TokenUsage, type ContentBlock } from '../../canonical/types.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { QuantlabHostError, type IQuantlabHostIdentityService } from '../../../../../services/quantlabHostIdentity/common/quantlabHostIdentity.js';

/** IPC-DATA op: the Delta Plus Server health check, answered by the host. */
export const QIC_HEALTH_OP = 'qic.health';

/** IPC-DATA op: one QIC request (the QIC protocol body), answered by the host. */
export const QIC_REQUEST_OP = 'qic.request';

/** The host has no streaming op for QIC; a stream is refused with this message, never replaced by a non-streaming call. */
export const QIC_STREAMING_UNAVAILABLE = 'QIC streaming is not available through the host';

const REQUEST_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

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
 * Provider adapter for the Delta Plus Server LLM proxy.
 * It holds no credential, no server address and no HTTP client: every call is an IPC-DATA op
 * (`qic.health`, `qic.request`) sent through the host's workbench service with the caller's identity
 * epoch. The host adds the token and owns the one backend origin. A host refusal rejects with its
 * {@link QuantlabHostError} code (the host answers `no-route` until QIC's server route exists); it is
 * never mapped to a value.
 */
export class DeltaPlusAdapter implements ProviderAdapter {
	readonly id = 'deltaplus';
	readonly name = 'Delta Plus Server';
	readonly type = 'llm' as const;

	private readonly activeRequests = new Map<string, CancellationTokenSource>();

	constructor(private readonly hostIdentityService: IQuantlabHostIdentityService) { }

	// --- ProviderAdapter implementation ---

	async isAvailable(): Promise<boolean> {
		const health = await this.getHealth();
		return health.status !== 'unavailable';
	}

	async getHealth(): Promise<ProviderHealth> {
		const start = Date.now();
		await this.hostRequest(QIC_HEALTH_OP, null, HEALTH_TIMEOUT_MS, undefined);
		return {
			status: 'healthy',
			latencyMs: Date.now() - start,
			errorRate: 0,
			lastChecked: new Date().toISOString(),
		};
	}

	async sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse> {
		const data = await this.hostRequest(QIC_REQUEST_OP, this.buildQicRequest(request, false), REQUEST_TIMEOUT_MS, request.signal);
		const raw = this.unwrapResponse(data);

		return {
			content: this.parseContent(raw.content),
			usage: this.mapUsage(raw.usage),
			stopReason: this.parseStopReason(raw.stop_reason ?? raw.stopReason),
		};
	}

	/**
	 * The host offers no QIC streaming op: iterating the stream rejects with
	 * {@link QIC_STREAMING_UNAVAILABLE}. There is no silent switch to {@link sendRequest}.
	 */
	sendStreaming(_request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk> {
		return {
			[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
				return {
					next: () => Promise.reject(new Error(QIC_STREAMING_UNAVAILABLE)),
				};
			},
		};
	}

	cancelRequest(requestId: string): void {
		this.activeRequests.get(requestId)?.cancel();
		this.activeRequests.delete(requestId);
	}

	// --- Dispose ---

	dispose(): void {
		for (const [id, cts] of this.activeRequests) {
			cts.cancel();
			this.activeRequests.delete(id);
		}
	}

	// --- Host transport ---

	/**
	 * The epoch of the signed-in identity, read at call time. Signed out is a refusal, never a guess.
	 * A host that cannot answer rejects (the identity service's rejection propagates).
	 */
	private async signedInEpoch(): Promise<number> {
		const identity = await this.hostIdentityService.getIdentity();
		if (!identity.signedIn) {
			throw new QuantlabHostError('not-signed-in', 'QIC needs a signed-in QuantLab user: sign in from the Quantlab terminal view.', undefined);
		}
		return identity.epoch;
	}

	/**
	 * One IPC-DATA op through the host. The timeout and the caller's abort signal both cancel the
	 * token; the host then answers `cancelled`, which rejects like every other refusal.
	 */
	private async hostRequest(op: string, input: unknown, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
		const epoch = await this.signedInEpoch();
		const requestId = randomUUID();
		const cts = new CancellationTokenSource();
		this.activeRequests.set(requestId, cts);

		const timeoutId = setTimeout(() => cts.cancel(), timeoutMs);
		const onAbort = () => cts.cancel();
		if (signal) {
			if (signal.aborted) {
				cts.cancel();
			} else {
				signal.addEventListener('abort', onAbort, { once: true });
			}
		}

		try {
			return await this.hostIdentityService.request(op, input, epoch, cts.token);
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener('abort', onAbort);
			this.activeRequests.delete(requestId);
			cts.dispose();
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

	// --- Helpers ---

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
	 * Unwrap the Delta Plus server response envelope that the host passes through as its data.
	 * Server wraps responses as { success: true, data: { ... } }; a value without a `data` object throws.
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
}
