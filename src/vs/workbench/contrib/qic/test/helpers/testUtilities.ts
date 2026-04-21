/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
	ProviderRequest,
	ProviderResponse,
	ToolCall,
	ToolResult,
	ToolContext,
	ToolResultPayload,
} from '../../common/canonical/types.js';

/**
 * Shared test infrastructure (AUDIT FIX X-PS9).
 * Mock factories for Gateway, ToolRouter, FileService, etc.
 */

// === Mock Provider ===

export interface MockProviderOptions {
	responses?: Map<string, ProviderResponse>;
	defaultResponse?: ProviderResponse;
	latencyMs?: number;
	failAfter?: number;
}

export class MockProviderAdapter {
	private callCount = 0;

	constructor(private readonly options: MockProviderOptions = {}) {}

	async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
		this.callCount++;

		if (this.options.failAfter && this.callCount > this.options.failAfter) {
			throw new Error('MockProvider: simulated failure');
		}

		if (this.options.latencyMs) {
			await sleep(this.options.latencyMs);
		}

		// Check for specific response by last user message
		const lastUserMsg = getLastUserMessage(request);
		if (lastUserMsg && this.options.responses?.has(lastUserMsg)) {
			return this.options.responses.get(lastUserMsg)!;
		}

		return this.options.defaultResponse ?? createTextResponse('Mock response');
	}

	getCallCount(): number {
		return this.callCount;
	}
}

export function createMockProvider(options?: MockProviderOptions): MockProviderAdapter {
	return new MockProviderAdapter(options);
}

// === Mock Tool Router ===

export interface MockToolRouterOptions {
	toolResults?: Map<string, ToolResultPayload>;
}

export class MockToolRouter {
	private readonly results: Map<string, ToolResultPayload>;
	private readonly executedCalls: ToolCall[] = [];

	constructor(options: MockToolRouterOptions = {}) {
		this.results = options.toolResults ?? new Map();
	}

	async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
		this.executedCalls.push(toolCall);

		const result = this.results.get(toolCall.name);
		if (result) {
			return { toolCallId: toolCall.id, content: result.content, isError: result.isError };
		}

		return {
			toolCallId: toolCall.id,
			content: `Mock result for ${toolCall.name}`,
			isError: false,
		};
	}

	getExecutedCalls(): ToolCall[] {
		return [...this.executedCalls];
	}
}

export function createMockToolRouter(options?: MockToolRouterOptions): MockToolRouter {
	return new MockToolRouter(options);
}

// === Test Workspace ===

export async function createTestWorkspace(fileCount: number): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const workspacePath = path.join(os.tmpdir(), `qic-test-${crypto.randomUUID()}`);
	await fs.mkdir(workspacePath, { recursive: true });

	for (let i = 0; i < fileCount; i++) {
		const dir = path.join(workspacePath, `dir-${Math.floor(i / 100)}`);
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `file-${i}.ts`);
		await fs.writeFile(filePath, `// File ${i}\nexport const value${i} = ${i};\n`);
	}

	return {
		path: workspacePath,
		cleanup: async () => {
			await fs.rm(workspacePath, { recursive: true, force: true });
		},
	};
}

// === Mock Context ===

export function createMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: 'test-session',
		workspacePath: '/test/workspace',
		permissions: new Map(),
		...overrides,
	};
}

// === Response Builders ===

export function createTextResponse(text: string): ProviderResponse {
	return {
		content: [{ type: 'text', text }],
		usage: { inputTokens: 10, outputTokens: 20 },
		stopReason: 'end_turn',
	};
}

export function createToolUseResponse(toolName: string, args: Record<string, unknown>): ProviderResponse {
	return {
		content: [{
			type: 'tool_use',
			id: `call-${crypto.randomUUID().slice(0, 8)}`,
			name: toolName,
			input: args,
		}],
		usage: { inputTokens: 10, outputTokens: 30 },
		stopReason: 'tool_use',
	};
}

// === Memory Leak Detection ===

export async function assertNoMemoryLeaks(fn: () => Promise<void>, toleranceMb: number = 50): Promise<void> {
	if (typeof globalThis.gc === 'function') {
		globalThis.gc();
	}
	const before = process.memoryUsage().heapUsed;

	await fn();

	if (typeof globalThis.gc === 'function') {
		globalThis.gc();
	}
	const after = process.memoryUsage().heapUsed;

	const diffMb = (after - before) / (1024 * 1024);
	if (diffMb > toleranceMb) {
		throw new Error(`Potential memory leak: ${diffMb.toFixed(1)}MB increase (tolerance: ${toleranceMb}MB)`);
	}
}

// === Helpers ===

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getLastUserMessage(request: ProviderRequest): string | null {
	for (let i = request.messages.length - 1; i >= 0; i--) {
		const msg = request.messages[i];
		if (msg.role === 'user') {
			return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
		}
	}
	return null;
}
