/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Webview message protocol (Audit I-7, IV-AO7).
 * Explicit discriminated unions for all host-to-webview and webview-to-host messages.
 */

// === Serialized types ===

export interface SerializedMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	timestamp: string;
	toolCalls?: Array<{ name: string; status: string }>;
}

// === Host → Webview Messages ===

export interface AuditLogEntry {
	timestamp: string;
	type: string;
	tool?: string;
	status?: string;
	reason?: string;
}

export interface MetricsData {
	errorRate: number;
	avgLatencyMs: number;
	memoryPressure: 'normal' | 'high' | 'critical';
	providersAvailable: number;
	totalProviders: number;
}

export interface DataFramePreviewData {
	filePath: string;
	shape: [number, number];
	columns: string[];
	rows: Array<Record<string, unknown>>;
	truncated: boolean;
	format: 'csv' | 'parquet' | 'feather';
}

export type HostToWebviewMessage =
	| { type: 'stream-token'; text: string }
	| { type: 'message-complete'; messageId: string }
	| { type: 'tool-call-started'; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: 'tool-call-result'; toolCallId: string; content: string; isError: boolean }
	| { type: 'diff-preview'; editScriptHash: string; previewHtml: string; filePaths: string[] }
	| { type: 'permission-request'; requestId: string; toolName: string; description: string }
	| { type: 'state-change'; state: 'idle' | 'processing' | 'waiting_approval' | 'error' }
	| { type: 'error'; code: string; message: string }
	| { type: 'clear-chat' }
	| { type: 'restore-history'; messages: SerializedMessage[] }
	| { type: 'set-theme'; theme: 'light' | 'dark' | 'high-contrast' }
	| { type: 'degradation-update'; level: number; description: string }
	| { type: 'quota-update'; tokensUsed: number; tokenLimit: number; costUsed: number; costLimit: number; resetAt: string }
	| { type: 'status-update'; lane: string; model: string; provider: string; region?: string }
	| { type: 'checkpoint-list'; checkpoints: Array<{ id: string; createdAt: string; fileCount: number }> }
	| { type: 'show-first-run' }
	| { type: 'settings-data'; consents: Record<string, boolean>; connectionMode: string; pythonStatus: { path: string; version: string } | null }
	| { type: 'audit-log'; entries: AuditLogEntry[]; chainValid: boolean }
	| { type: 'metrics-update'; metrics: MetricsData }
	| { type: 'replay-status'; active: boolean; mode: 'off' | 'strict' | 'best-effort' | 'fallback'; recordingCount: number }
	| { type: 'dataframe-preview'; data: DataFramePreviewData }
	// Phase 2+: Additional host messages
	| { type: 'conversation:saved' }
	| { type: 'conversation:save-error'; payload: { error: string } }
	| { type: 'show-help' };

// === Webview → Host Messages ===

export type WebviewToHostMessage =
	| { type: 'user-message'; text: string }
	| { type: 'cancel-request' }
	| { type: 'permission-response'; requestId: string; granted: boolean; scope: 'once' | 'session' | 'always' }
	| { type: 'approve-diff'; editScriptHash: string; approved: boolean }
	| { type: 'new-chat' }
	| { type: 'copy-code'; code: string }
	| { type: 'insert-code'; code: string; filePath?: string }
	| { type: 'webview-ready' }
	| { type: 'open-settings' }
	| { type: 'toggle-consent'; boundary: string; granted: boolean }
	| { type: 'attempt-recovery' }
	| { type: 'create-checkpoint' }
	| { type: 'restore-checkpoint'; checkpointId: string }
	| { type: 'first-run-consent'; consents: { llm: boolean; embeddings: boolean; telemetry: boolean } }
	| { type: 'request-audit-log'; filter?: string }
	| { type: 'request-metrics' }
	| { type: 'set-replay-mode'; mode: 'off' | 'strict' | 'best-effort' | 'fallback'; recordingPath?: string }
	| { type: 'preview-dataframe'; filePath: string }
	| { type: 'open-file-reference'; path: string; isFolder: boolean }
	// Phase 2+: V2 message types
	| { type: 'send'; payload: { content: string; provider?: string } }
	| { type: 'cancel' }
	| { type: 'first-run:complete'; payload: Record<string, unknown> }
	| { type: 'conversation:save' }
	// Phase 3: Quick Pick triggers
	| { type: 'quickPick:status' }
	| { type: 'quickPick:history' }
	| { type: 'quickPick:checkpoints' }
	| { type: 'quickPick:provider' }
	| { type: 'quickPick:quota' }
	| { type: 'show-help' }
	| { type: 'open-external'; payload: { url: string } }
	| { type: 'export-conversation' }
	| { type: 'rename-conversation' }
	| { type: 'show-permissions' }
	| { type: 'permission:response'; payload: Record<string, unknown> }
	// Phase 4: Context management
	| { type: 'context:add'; item: Record<string, unknown> }
	| { type: 'context:remove'; id: string }
	| { type: 'context:clear' }
	| { type: 'context:showPicker' }
	| { type: 'context:openDrawer' }
	| { type: 'context:openItem'; id: string; item: Record<string, unknown> }
	| { type: 'context:getContent'; id: string }
	// Phase 4: Mention autocomplete
	| { type: 'mention:search'; query: string }
	| { type: 'mention:getRecent' }
	// Phase 5: Change card actions
	| { type: 'change:viewDiff'; changeId: string }
	| { type: 'change:apply'; changeId: string }
	| { type: 'change:reject'; changeId: string }
	| { type: 'change:openFile'; changeId: string }
	// Phase 5: Approval flow
	| { type: 'changes:accept'; payload: Record<string, unknown> }
	| { type: 'changes:reject'; payload: Record<string, unknown> }
	| { type: 'changes:acceptAll'; payload: Record<string, unknown> }
	| { type: 'changes:rejectAll'; payload: Record<string, unknown> }
	| { type: 'changes:retry'; payload: Record<string, unknown> }
	// Phase 6: Error handling
	| { type: 'error:notification'; severity: string; title: string; message: string }
	| { type: 'error:statusBar'; severity: string; message: string }
	| { type: 'error:retry'; operationId: string; command: string }
	| { type: 'error:command'; command: string }
	| { type: 'error:modal'; [key: string]: unknown }
	// Phase 6: Connection
	| { type: 'connection:retry' };
