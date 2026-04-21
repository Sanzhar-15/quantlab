/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	QICState,
	QICStatePatch,
	Message,
	ContextItem,
	ChangeSet,
	PermissionRequest,
	Checkpoint,
	ToolCallInfo,
	ErrorInfo
} from '../state/qicStateService.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HOST → WEBVIEW MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

export type HostToWebviewMessageV2 =
	// ─────────────────────────────────────────────────────────────────────────
	// State Synchronization
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'state:full'; revision: number; payload: QICState }
	| { type: 'state:patch'; revision: number; payload: QICStatePatch }
	| { type: 'state:sync'; revision: number }  // Request revision ack

	// ─────────────────────────────────────────────────────────────────────────
	// Streaming Messages
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'message:start'; revision: number; payload: { id: string } }
	| { type: 'message:chunk'; revision: number; payload: {
		id: string;
		content: string;
		kind: 'text' | 'code';
	}}
	| { type: 'message:complete'; revision: number; payload: {
		id: string;
		metadata?: MessageMetadata;
	}}
	| { type: 'message:error'; revision: number; payload: {
		id: string;
		error: ErrorInfo;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Tool Calls (AMENDMENT: from existing codebase)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'tool:start'; revision: number; payload: ToolCallInfo }
	| { type: 'tool:result'; revision: number; payload: {
		id: string;
		content: string;
		isError: boolean;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Conversation Management
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'conversation:loaded'; revision: number; payload: {
		id: string;
		title: string;
		messages: Message[];
	}}
	| { type: 'conversation:titleUpdated'; revision: number; payload: {
		id: string;
		title: string;
	}}
	| { type: 'conversations:list'; revision: number; payload: {
		conversations: ConversationSummary[];
	}}
	| { type: 'conversations:searchResults'; revision: number; payload: {
		query: string;
		results: SearchResult[];
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Changes
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'changes:pending'; revision: number; payload: ChangeSet }
	| { type: 'changes:resolved'; revision: number; payload: {
		id: string;
		status: 'accepted' | 'rejected' | 'partial';
	}}
	| { type: 'changes:fileStatus'; revision: number; payload: {
		changeSetId: string;
		changeId: string;
		status: string;
		error?: string;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Permissions (GAP-06 FIX)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'permission:request'; revision: number; payload: PermissionRequest }
	| { type: 'permission:resolved'; revision: number; payload: {
		id: string;
		granted: boolean;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Context
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'context:update'; revision: number; payload: {
		items: ContextItem[];
		totalTokens: number;
		maxTokens: number;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Checkpoints
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'checkpoint:created'; revision: number; payload: Checkpoint }
	| { type: 'checkpoint:restored'; revision: number; payload: {
		id: string;
		filesChanged: number;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Audit
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'audit:entries'; revision: number; payload: {
		entries: AuditEntry[];
		total: number;
		hasMore: boolean;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Export
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'export:ready'; revision: number; payload: {
		type: string;
		format: string;
		data: string;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Theme (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'theme:change'; revision: number; payload: {
		theme: 'light' | 'dark' | 'high-contrast';
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Lane (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'lane:change'; revision: number; payload: {
		lane: string;
		maxTokens: number;
	}};

// ═══════════════════════════════════════════════════════════════════════════════
// WEBVIEW → HOST MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

export type WebviewToHostMessageV2 =
	// ─────────────────────────────────────────────────────────────────────────
	// Lifecycle
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'ready' }
	| { type: 'revision:ack'; revision: number }
	| { type: 'state:request' }  // Request full state (gap recovery)

	// ─────────────────────────────────────────────────────────────────────────
	// Messages
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'send'; payload: {
		content: string;
		mentions: Mention[];
	}}
	| { type: 'cancel' }
	| { type: 'retry'; payload: { messageId: string } }
	| { type: 'regenerate'; payload: { messageId: string } }
	| { type: 'edit'; payload: {
		messageId: string;
		newContent: string;
		mentions: Mention[];
	}}
	| { type: 'switchBranch'; payload: {
		messageId: string;
		branchId: string;
	}}
	| { type: 'deleteBranch'; payload: {
		messageId: string;
		branchId: string;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Conversations
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'newChat' }
	| { type: 'loadConversation'; payload: { conversationId: string } }
	| { type: 'deleteConversation'; payload: { conversationId: string } }
	| { type: 'renameConversation'; payload: {
		conversationId: string;
		title: string;
	}}
	| { type: 'conversations:requestList' }
	| { type: 'conversations:search'; payload: { query: string } }
	| { type: 'conversations:export'; payload: {
		conversationId: string;
		format: 'markdown' | 'json';
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Changes (GAP-05 FIX: simplified approval flow)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'changes:accept'; payload: {
		changeSetId: string;
		changeId: string;
		editScriptHash: string;  // Echo back hash from host
	}}
	| { type: 'changes:reject'; payload: {
		changeSetId: string;
		changeId: string;
	}}
	| { type: 'changes:acceptGroup'; payload: {
		changeSetId: string;
		groupId: string;
	}}
	| { type: 'changes:rejectGroup'; payload: {
		changeSetId: string;
		groupId: string;
	}}
	| { type: 'changes:acceptAll'; payload: { changeSetId: string } }
	| { type: 'changes:rejectAll'; payload: { changeSetId: string } }
	| { type: 'changes:retryFailed'; payload: { changeSetId: string } }

	// ─────────────────────────────────────────────────────────────────────────
	// Permissions (GAP-06 FIX)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'permission:allow'; payload: {
		id: string;
		scope: 'once' | 'session' | 'always';
	}}
	| { type: 'permission:deny'; payload: { id: string } }
	| { type: 'permission:revoke'; payload: { id: string } }

	// ─────────────────────────────────────────────────────────────────────────
	// Context
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'context:add'; payload: {
		type: 'file' | 'folder' | 'symbol' | 'selection';
		path: string;
	}}
	| { type: 'context:remove'; payload: { id: string } }
	| { type: 'context:pin'; payload: { id: string } }
	| { type: 'context:unpin'; payload: { id: string } }
	| { type: 'context:clear' }

	// ─────────────────────────────────────────────────────────────────────────
	// Checkpoints
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'checkpoint:create'; payload: { description?: string } }
	| { type: 'checkpoint:restore'; payload: { id: string } }
	| { type: 'checkpoint:delete'; payload: { id: string } }

	// ─────────────────────────────────────────────────────────────────────────
	// Audit
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'audit:request'; payload: {
		filter?: string;
		timeRange?: string;
		offset?: number;
		limit?: number;
	}}
	| { type: 'audit:export'; payload: { format: 'json' | 'csv' } }

	// ─────────────────────────────────────────────────────────────────────────
	// Navigation (AMENDMENT: file reference clicks)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'open-file-reference'; payload: {
		path: string;
		isFolder: boolean;
		line?: number;
	}}

	// ─────────────────────────────────────────────────────────────────────────
	// Quick Pick Triggers (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'quickPick:history' }
	| { type: 'quickPick:checkpoints' }
	| { type: 'quickPick:provider' }
	| { type: 'quickPick:status' }

	// ─────────────────────────────────────────────────────────────────────────
	// Quality Signals (AMENDMENT: GAP-14)
	// ─────────────────────────────────────────────────────────────────────────
	| { type: 'quality-signal'; payload: {
		messageId: string;
		rating: 'positive' | 'negative';
		feedback?: string;
	}};

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORTING TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MessageMetadata {
	/** Associated changes */
	changes?: ChangeSet;
	/** Error if message failed */
	error?: ErrorInfo;
	/** Tokens used */
	tokensUsed?: number;
	/** Lane used for this message */
	lane?: string;
}

export interface ConversationSummary {
	/** Conversation ID */
	id: string;
	/** Title */
	title: string;
	/** Last message timestamp */
	timestamp: string;
	/** Number of messages */
	messageCount: number;
	/** Preview of last message */
	preview?: string;
}

export interface SearchResult {
	/** Conversation containing match */
	conversationId: string;
	/** Message containing match */
	messageId: string;
	/** Snippet with match highlighted */
	snippet: string;
	/** Match timestamp */
	timestamp: string;
}

export interface Mention {
	/** Unique ID */
	id: string;
	/** Type of mention */
	type: 'file' | 'folder' | 'symbol' | 'docs';
	/** Path */
	path: string;
	/** Display name */
	displayName: string;
	/** Token count */
	tokens: number;
}

export interface AuditEntry {
	/** Entry ID */
	id: string;
	/** Timestamp */
	timestamp: string;
	/** Entry type */
	type: 'tool_call' | 'permission' | 'change' | 'checkpoint' | 'error';
	/** Entry data */
	data: Record<string, unknown>;
	/** Session ID */
	sessionId: string;
	/** Previous hash (for chain integrity) */
	prevHash: string;
	/** This entry's hash */
	hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE GUARDS
// ═══════════════════════════════════════════════════════════════════════════════

export function isV2HostMessage(msg: unknown): msg is HostToWebviewMessageV2 {
	if (typeof msg !== 'object' || msg === null) { return false; }
	const m = msg as { type?: string };
	return m.type?.startsWith('state:') ||
		m.type?.startsWith('message:') ||
		m.type?.startsWith('tool:') ||
		m.type?.startsWith('conversation') ||
		m.type?.startsWith('changes:') ||
		m.type?.startsWith('permission:') ||
		m.type?.startsWith('context:') ||
		m.type?.startsWith('checkpoint:') ||
		m.type?.startsWith('audit:') ||
		m.type?.startsWith('export:') ||
		m.type?.startsWith('theme:') ||
		m.type?.startsWith('lane:') ||
		false;
}

export function isV2WebviewMessage(msg: unknown): msg is WebviewToHostMessageV2 {
	if (typeof msg !== 'object' || msg === null) { return false; }
	const m = msg as { type?: string };
	return m.type === 'ready' ||
		m.type?.startsWith('revision:') ||
		m.type?.startsWith('state:') ||
		m.type === 'send' ||
		m.type === 'cancel' ||
		m.type === 'retry' ||
		m.type === 'regenerate' ||
		m.type === 'edit' ||
		m.type === 'switchBranch' ||
		m.type === 'deleteBranch' ||
		m.type === 'newChat' ||
		m.type?.startsWith('load') ||
		m.type?.startsWith('delete') ||
		m.type?.startsWith('rename') ||
		m.type?.startsWith('conversations:') ||
		m.type?.startsWith('changes:') ||
		m.type?.startsWith('permission:') ||
		m.type?.startsWith('context:') ||
		m.type?.startsWith('checkpoint:') ||
		m.type?.startsWith('audit:') ||
		m.type?.startsWith('quickPick:') ||
		m.type === 'open-file-reference' ||
		m.type === 'quality-signal' ||
		false;
}
