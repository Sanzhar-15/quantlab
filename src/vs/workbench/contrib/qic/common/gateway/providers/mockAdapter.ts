/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderAdapter, ProviderHealth, StreamChunk } from '../../canonical/interfaces.js';
import type { ProviderRequest, ProviderResponse } from '../../canonical/types.js';

/**
 * Mock provider adapter for testing (Audit II-PG2).
 */
export class MockProviderAdapter implements ProviderAdapter {
	readonly id = 'mock';
	readonly name = 'Mock Provider';
	readonly type = 'llm' as const;
	private readonly responses = new Map<string, string>();

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getHealth(): Promise<ProviderHealth> {
		return {
			status: 'healthy',
			latencyMs: 10,
			errorRate: 0,
			lastChecked: new Date().toISOString(),
		};
	}

	async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
		const key = this.extractKey(request);
		const response = this.responses.get(key) ?? `Mock response for: ${key}`;
		return {
			content: [{ type: 'text', text: response }],
			usage: { inputTokens: 10, outputTokens: response.length },
			stopReason: 'end_turn',
		};
	}

	async *sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk> {
		const key = this.extractKey(request);
		const response = this.responses.get(key) ?? `Mock response for: ${key}`;
		yield { type: 'text', text: response };
		yield { type: 'done', stopReason: 'end_turn' };
	}

	cancelRequest(_requestId: string): void {
		// No-op
	}

	setResponse(input: string, output: string): void {
		this.responses.set(input, output);
	}

	private extractKey(request: ProviderRequest): string {
		const lastMessage = request.messages[request.messages.length - 1];
		if (!lastMessage) { return ''; }
		return typeof lastMessage.content === 'string'
			? lastMessage.content
			: lastMessage.content.map(b => b.type === 'text' ? b.text : '').join('');
	}
}
