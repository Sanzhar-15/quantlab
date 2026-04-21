/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { QicErrorTemplate, ERROR_REGISTRY } from './errors.js';

// === EditScript Types ===

export interface EditScript {
	version: 1;
	edits: FileEdit[];
}

export interface FileEdit {
	path: string;
	operations: EditOperation[];
}

export type EditOperation =
	| { type: 'replace'; range: Range; newText: string }
	| { type: 'insert'; position: Position; text: string }
	| { type: 'delete'; range: Range };

export interface Range {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface Position {
	line: number;
	column: number;
}

// === Permission Types ===

export interface PermissionCheckResult {
	status: 'granted' | 'denied';
	scope: 'once' | 'session' | 'always';
	reason?: string;
	expiresAt?: string;
}

// === Tool Types ===
//
// INV-T2 Resolution (Audit VII-DS6):
// - Audit logging: ALL 22 tools are logged via SecurityAuditLogger regardless of permission settings.
// - Permission check: Only tools with hasSideEffects: true require user approval before execution.
// - These are separate concerns — logging is unconditional, approval is conditional.
//

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JSONSchema;
	hasSideEffects: boolean;
	permission: ToolPermission;
	status?: 'active' | 'not-yet-implemented';
}

export interface ToolPermission {
	required: boolean;
	level?: 'once' | 'session' | 'always';
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	content: string;
	isError: boolean;
}

/**
 * What tool implementations actually return (without toolCallId).
 * The ToolRouter wraps this with toolCallId to produce a full ToolResult.
 */
export type ToolResultPayload = Omit<ToolResult, 'toolCallId'>;

export interface ToolContext {
	sessionId: string;
	workspacePath: string;
	activeFilePath?: string;
	targetPath?: string;
	permissions: Map<string, PermissionCheckResult>;
}

export interface ToolImplementation {
	execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResultPayload>;
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResultPayload>;

// === Provider Types ===

export interface ProviderRequest {
	model: string;
	messages: Message[];
	tools?: ToolDefinition[];
	temperature?: number;
	maxTokens?: number;
	stream?: boolean;
	signal?: AbortSignal;
}

export interface ProviderResponse {
	content: ContentBlock[];
	usage?: TokenUsage;
	stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface Message {
	role: 'user' | 'assistant' | 'system';
	content: string | ContentBlock[];
}

// === Approval Types ===

export interface ApprovalToken {
	id: string;
	editScriptHash: string;
	grantedAt: string;
	grantedBy: 'user' | 'auto-test';
	expiresAt: string;
}

// === Error Types ===

export class QicError extends Error {
	public readonly code: string;
	public readonly qicName: string;
	public readonly severity: 'info' | 'warning' | 'error';
	public readonly userMessage: string | null;
	public readonly details?: unknown;
	public readonly httpStatus?: number;

	constructor(code: string, message: string, details?: unknown, httpStatus?: number) {
		super(message);
		this.name = 'QicError';
		this.code = code;
		const template: QicErrorTemplate | undefined = ERROR_REGISTRY[code];
		this.qicName = template?.name ?? 'UnknownError';
		this.severity = template?.severity ?? 'error';
		this.userMessage = message;
		this.details = details;
		this.httpStatus = httpStatus;
		Object.setPrototypeOf(this, QicError.prototype);
	}
}

/**
 * Create a QicError from a registry code.
 */
export function createQicError(code: string, message?: string, details?: unknown): QicError {
	const template = ERROR_REGISTRY[code];
	if (!template) {
		throw new Error(`Unknown error code: ${code}`);
	}
	return new QicError(code, message ?? template.userMessage ?? template.name, details);
}

// === JSON Schema (simplified) ===

export interface JSONSchema {
	type: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	items?: JSONSchema;
	description?: string;
	enum?: (string | number)[];
}
