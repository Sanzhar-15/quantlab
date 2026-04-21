/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ProviderRequest,
	ProviderResponse,
	ToolContext,
	PermissionCheckResult,
	EditScript,
	ApprovalToken,
	TokenUsage,
	QicError,
} from './types.js';
import type { LaneName } from './lanes.js';

// === Provider Interfaces ===

export interface ProviderHealth {
	status: 'healthy' | 'degraded' | 'unavailable';
	latencyMs: number;
	errorRate: number;
	lastChecked: string;
}

export interface ProviderAdapter {
	readonly id: string;
	readonly name: string;
	readonly type: 'llm' | 'embedding';
	isAvailable(): Promise<boolean>;
	getHealth(): Promise<ProviderHealth>;
	sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse>;
	sendStreaming(request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk>;
	cancelRequest(requestId: string): void;
}

// === UI Service Interface ===

export interface UIService {
	showPermissionDialog(tool: string, context: ToolContext): Promise<PermissionCheckResult>;
	showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null>;
	streamChatToken(token: string): void;
	completeStreaming(): void;  // Signal that streaming is complete
	showToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void;
	showToolResult(toolCallId: string, content: string, isError: boolean): void;
	showInfo(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
}

// === Gateway Types ===

export type StreamChunk =
	| { type: 'text'; text: string }
	| { type: 'tool_call_start'; id: string; name: string }
	| { type: 'tool_call_delta'; id: string; argumentsDelta: string }
	| { type: 'tool_call_end'; id: string }
	| { type: 'done'; usage?: TokenUsage; stopReason?: string; providerMeta?: Record<string, unknown> }
	| { type: 'error'; error: QicError };

export type RequestPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

/**
 * Metadata that the Gateway attaches to requests before forwarding to providers.
 * Cloud adapter reads these for routing; BYOK adapters ignore them (Partial<>).
 */
export interface GatewayMetadata {
	lane: LaneName;
	priority: RequestPriority;
	sessionId?: string;
	context?: RequestContext;
}

export interface RequestContext {
	filePath?: string;
	language?: string;
	selection?: string;
	cursorLine?: number;
}

export interface QuotaInfo {
	tokensRemaining?: number;
	costRemaining?: number;
	resetAt?: string;
	warning?: string;
}

export interface GatewayRequest extends ProviderRequest {
	lane: LaneName;
	priority: RequestPriority;
	providerId?: string;
	sessionId?: string;
}
