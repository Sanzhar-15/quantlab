/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CORE STATE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GAP-01 FIX: Service lifecycle state
 * Indicates whether QIC is ready to use
 */
export type ServiceStatus = 'initializing' | 'ready' | 'degraded' | 'error';

/**
 * GAP-01 FIX: Agent conversation state
 * Indicates what the conversation is currently doing
 */
export type AgentState = 'idle' | 'processing' | 'waiting_approval' | 'error' | 'suspended';

/**
 * Lane types from the backend routing system
 */
export type LaneType =
	| 'chat-ask'
	| 'chat-gather'
	| 'chat-plan'
	| 'chat-act'
	| 'completion'
	| 'repair'
	| 'fast-apply'
	| 'summarize';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN STATE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The complete QIC UI state
 * This is the single source of truth for the webview
 */
export interface QICState {
	/** Monotonically increasing revision number */
	revision: number;

	/** GAP-01: Service lifecycle state */
	serviceStatus: ServiceStatus;

	/** GAP-01: Agent conversation state */
	agentState: AgentState;

	/** Connection information */
	connection: ConnectionState;

	/** Context items attached to conversation */
	context: ContextState;

	/** Current conversation */
	conversation: ConversationState;

	/** Usage quota */
	quota: QuotaState;

	/** Available checkpoints */
	checkpoints: Checkpoint[];

	/** Permission state */
	permissions: PermissionsState;

	/** Current processing lane */
	currentLane: LaneType;

	/** Recently used context items (04-04) */
	recentContext: ContextItem[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConnectionState {
	/** Current provider */
	provider: 'qic-cloud' | 'anthropic' | 'openai' | 'ollama' | 'offline';

	/** Degradation level (0 = normal, 4 = emergency) */
	degradationLevel: 0 | 1 | 2 | 3 | 4;

	/** Current latency in milliseconds */
	latencyMs: number;

	/** Current model identifier */
	currentModel: string;

	/** Optional region information */
	region?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ContextState {
	/** Attached context items */
	items: ContextItem[];

	/** Total tokens used by context */
	totalTokens: number;

	/** Maximum tokens allowed (varies by lane) */
	maxTokens: number;
}

export interface ContextItem {
	/** Unique identifier */
	id: string;

	/** Type of context */
	type: 'file' | 'folder' | 'selection' | 'symbol' | 'terminal' | 'diagnostic' | 'docs' | 'url';

	/** Display path or name */
	path: string;

	/** Human-readable name */
	displayName: string;

	/** Token count for this item */
	tokens: number;

	/** Whether this item is pinned */
	pinned: boolean;

	/** Whether item was auto-added */
	implicit: boolean;

	/** Optional start line for selections */
	startLine?: number;

	/** Optional end line for selections */
	endLine?: number;

	/** Optional content (for inline/url context items) */
	content?: string;

	/** Optional URL (for url type context items) */
	url?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATION STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConversationState {
	/** Conversation identifier */
	id: string;

	/** Conversation title */
	title: string;

	/** Messages in the conversation */
	messages: Message[];

	/** Whether currently streaming a response */
	isStreaming: boolean;

	/** Pending changes awaiting approval */
	pendingChanges: ChangeSet | null;

	/** Active tool calls (AMENDMENT) */
	activeToolCalls: ToolCallInfo[];
}

export interface Message {
	/** Message identifier */
	id: string;

	/** Message role */
	role: 'user' | 'assistant' | 'system';

	/** Message content */
	content: string;

	/** Timestamp */
	timestamp: string;

	/** Attached context mentions */
	mentions?: Mention[];

	/** Associated changes */
	changes?: ChangeSet;

	/** Error if this message failed */
	error?: ErrorInfo;

	/** Whether message was edited */
	edited?: boolean;

	/** Branch information for regenerated responses */
	branches?: Branch[];

	/** Active branch ID */
	activeBranch?: string;
}

export interface Mention {
	/** Unique identifier */
	id: string;

	/** Type of mention */
	type: 'file' | 'folder' | 'symbol' | 'docs';

	/** Path to the referenced item */
	path: string;

	/** Display name */
	displayName: string;

	/** Token count */
	tokens: number;
}

export interface Branch {
	/** Branch identifier */
	id: string;

	/** Branch content */
	content: string;

	/** When this branch was created */
	timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL CALL STATE (AMENDMENT)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ToolCallInfo {
	/** Tool call identifier */
	id: string;

	/** Tool name */
	name: string;

	/** Current status */
	status: 'running' | 'complete' | 'error';

	/** Tool arguments */
	args?: Record<string, unknown>;

	/** Tool result (when complete) */
	result?: string;

	/** Whether result is an error */
	isError?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGES STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChangeSet {
	/** Change set identifier */
	id: string;

	/** Individual changes */
	changes: Change[];

	/** Summary description */
	summary: string;

	/** Files affected */
	files: string[];
}

export interface Change {
	/** Change identifier */
	id: string;

	/** File path */
	filePath: string;

	/** Change type */
	type: 'create' | 'modify' | 'delete' | 'rename';

	/** Diff content */
	diff: string;

	/** Current status */
	status: 'pending' | 'accepted' | 'rejected' | 'applied' | 'failed';

	/** Error if failed */
	error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTA STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuotaState {
	/** Tokens/requests used */
	used: number;

	/** Total limit */
	limit: number;

	/** Estimated cost */
	estimatedCost: number;

	/** When quota resets */
	resetDate: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKPOINT STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface Checkpoint {
	/** Checkpoint identifier */
	id: string;

	/** Optional description */
	description?: string;

	/** When checkpoint was created */
	timestamp: string;

	/** Associated change set ID */
	changeSetId?: string;

	/** Files included in checkpoint */
	files: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSIONS STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface PermissionsState {
	/** Granted permissions */
	granted: Permission[];

	/** Currently pending permission request */
	pending: PermissionRequest | null;
}

export interface Permission {
	/** Permission identifier */
	id: string;

	/** Tool name */
	toolName: string;

	/** Granted scope */
	scope: 'once' | 'session' | 'always';

	/** When permission was granted */
	grantedAt: string;
}

export interface PermissionRequest {
	/** Request identifier */
	id: string;

	/** Tool requesting permission */
	toolName: string;

	/** Human-readable description */
	description: string;

	/** Risk level for display */
	riskLevel: 'low' | 'medium' | 'high';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR INFO
// ═══════════════════════════════════════════════════════════════════════════════

export interface ErrorInfo {
	/** Error code (e.g., QIC-T002) */
	code: string;

	/** Error title */
	title: string;

	/** Detailed message */
	message: string;

	/** Whether error is recoverable */
	recoverable: boolean;

	/** Retry after milliseconds (for rate limits) */
	retryAfter?: number;

	/** Available actions */
	actions: ErrorAction[];
}

export interface ErrorAction {
	/** Button label */
	label: string;

	/** Command to execute */
	command: string;

	/** Command arguments */
	args?: unknown[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE PATCH (for incremental updates)
// ═══════════════════════════════════════════════════════════════════════════════

export interface QICStatePatch {
	/** Revision this patch creates */
	revision: number;

	/** Path to the changed property (supports dot notation) */
	path: string;

	/** New value */
	value: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

export const IQicStateService = createDecorator<IQicStateService>('qicStateService');

export interface IQicStateService {
	readonly _serviceBrand: undefined;

	/** Current state (read-only) */
	readonly state: Readonly<QICState>;

	/** Event fired when state changes */
	readonly onDidChangeState: Event<QICStatePatch>;

	/** Current revision number */
	readonly revision: number;

	// ─────────────────────────────────────────────────────────────────────────
	// Service & Agent State (GAP-01)
	// ─────────────────────────────────────────────────────────────────────────

	setServiceStatus(status: ServiceStatus): number;
	setAgentState(state: AgentState): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Connection
	// ─────────────────────────────────────────────────────────────────────────

	updateConnection(connection: Partial<ConnectionState>): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Context
	// ─────────────────────────────────────────────────────────────────────────

	addContextItem(item: ContextItem): number;
	removeContextItem(id: string): number;
	pinContextItem(id: string): number;
	unpinContextItem(id: string): number;
	clearContext(): number;
	updateContextTokens(totalTokens: number, maxTokens: number): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Conversation
	// ─────────────────────────────────────────────────────────────────────────

	setConversation(id: string, title: string, messages: Message[]): number;
	addMessage(message: Message): number;
	updateMessage(id: string, patch: Partial<Message>): number;
	setStreaming(isStreaming: boolean): number;
	setPendingChanges(changes: ChangeSet | null): number;
	updateChangeStatus(changeSetId: string, changeId: string, status: Change['status'], error?: string): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Tool Calls (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────

	addToolCall(toolCall: ToolCallInfo): number;
	updateToolCall(id: string, patch: Partial<ToolCallInfo>): number;
	clearToolCalls(): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Quota
	// ─────────────────────────────────────────────────────────────────────────

	updateQuota(quota: Partial<QuotaState>): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Checkpoints
	// ─────────────────────────────────────────────────────────────────────────

	addCheckpoint(checkpoint: Checkpoint): number;
	removeCheckpoint(id: string): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Permissions
	// ─────────────────────────────────────────────────────────────────────────

	setPermissionRequest(request: PermissionRequest | null): number;
	addGrantedPermission(permission: Permission): number;
	revokePermission(id: string): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Lane (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────

	setLane(lane: LaneType): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Recent Context (04-04)
	// ─────────────────────────────────────────────────────────────────────────

	addToRecentContext(item: ContextItem): number;
	getRecentContext(): ContextItem[];
	clearRecentContext(): number;

	// ─────────────────────────────────────────────────────────────────────────
	// Review Mode (Phase 5)
	// ─────────────────────────────────────────────────────────────────────────

	applyChange?(changeId: string): void;
	rejectChange?(changeId: string): void;

	// ─────────────────────────────────────────────────────────────────────────
	// Conversation Management (Phase 3)
	// ─────────────────────────────────────────────────────────────────────────

	getConversationSummaries?(): Promise<Array<{ id: string; title: string; timestamp: string; messageCount: number; preview?: string }>>;
	deleteConversation?(id: string): Promise<void>;
	exportConversation?(id: string): Promise<unknown>;

	// ─────────────────────────────────────────────────────────────────────────
	// Serialization
	// ─────────────────────────────────────────────────────────────────────────

	getFullState(): QICState;
	restore(state: QICState): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export class QicStateService extends Disposable implements IQicStateService {
	declare readonly _serviceBrand: undefined;

	private _state: QICState;
	private _revision = 0;

	private readonly _onDidChangeState = this._register(new Emitter<QICStatePatch>());
	readonly onDidChangeState: Event<QICStatePatch> = this._onDidChangeState.event;

	constructor() {
		super();
		this._state = this.createInitialState();
	}

	get state(): Readonly<QICState> {
		return this._state;
	}

	get revision(): number {
		return this._revision;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Initial State Factory
	// ─────────────────────────────────────────────────────────────────────────

	private createInitialState(): QICState {
		return {
			revision: 0,
			serviceStatus: 'initializing',
			agentState: 'idle',
			connection: {
				provider: 'qic-cloud',
				degradationLevel: 0,
				latencyMs: 0,
				currentModel: 'claude-3-opus'
			},
			context: {
				items: [],
				totalTokens: 0,
				maxTokens: 32000
			},
			conversation: {
				id: this.generateId(),
				title: 'New Conversation',
				messages: [],
				isStreaming: false,
				pendingChanges: null,
				activeToolCalls: []
			},
			quota: {
				used: 0,
				limit: 100000,
				estimatedCost: 0,
				resetDate: ''
			},
			checkpoints: [],
			permissions: {
				granted: [],
				pending: null
			},
			currentLane: 'chat-ask',
			recentContext: []
		};
	}

	private generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core Mutation Helper
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Core mutation method - all state changes go through here
	 */
	private mutate<T>(path: string, mutator: (state: QICState) => QICState, value: T): number {
		this._revision++;
		this._state = mutator(this._state);
		this._state = { ...this._state, revision: this._revision };

		const patch: QICStatePatch = {
			revision: this._revision,
			path,
			value
		};

		this._onDidChangeState.fire(patch);
		return this._revision;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Service & Agent State (GAP-01 FIX)
	// ─────────────────────────────────────────────────────────────────────────

	setServiceStatus(status: ServiceStatus): number {
		return this.mutate('serviceStatus', state => ({
			...state,
			serviceStatus: status
		}), status);
	}

	setAgentState(agentState: AgentState): number {
		return this.mutate('agentState', state => ({
			...state,
			agentState
		}), agentState);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Connection
	// ─────────────────────────────────────────────────────────────────────────

	updateConnection(connection: Partial<ConnectionState>): number {
		const newConnection = { ...this._state.connection, ...connection };
		return this.mutate('connection', state => ({
			...state,
			connection: newConnection
		}), newConnection);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Context
	// ─────────────────────────────────────────────────────────────────────────

	addContextItem(item: ContextItem): number {
		const items = [...this._state.context.items, item];
		return this.mutate('context.items', state => ({
			...state,
			context: { ...state.context, items }
		}), items);
	}

	removeContextItem(id: string): number {
		const items = this._state.context.items.filter(i => i.id !== id);
		return this.mutate('context.items', state => ({
			...state,
			context: { ...state.context, items }
		}), items);
	}

	pinContextItem(id: string): number {
		const items = this._state.context.items.map(i =>
			i.id === id ? { ...i, pinned: true } : i
		);
		return this.mutate('context.items', state => ({
			...state,
			context: { ...state.context, items }
		}), items);
	}

	unpinContextItem(id: string): number {
		const items = this._state.context.items.map(i =>
			i.id === id ? { ...i, pinned: false } : i
		);
		return this.mutate('context.items', state => ({
			...state,
			context: { ...state.context, items }
		}), items);
	}

	clearContext(): number {
		// Keep pinned items
		const items = this._state.context.items.filter(i => i.pinned);
		return this.mutate('context.items', state => ({
			...state,
			context: { ...state.context, items, totalTokens: 0 }
		}), items);
	}

	updateContextTokens(totalTokens: number, maxTokens: number): number {
		return this.mutate('context', state => ({
			...state,
			context: { ...state.context, totalTokens, maxTokens }
		}), { totalTokens, maxTokens });
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Conversation
	// ─────────────────────────────────────────────────────────────────────────

	setConversation(id: string, title: string, messages: Message[]): number {
		const conversation: ConversationState = {
			id,
			title,
			messages,
			isStreaming: false,
			pendingChanges: null,
			activeToolCalls: []
		};
		return this.mutate('conversation', state => ({
			...state,
			conversation
		}), conversation);
	}

	addMessage(message: Message): number {
		const messages = [...this._state.conversation.messages, message];
		return this.mutate('conversation.messages', state => ({
			...state,
			conversation: { ...state.conversation, messages }
		}), messages);
	}

	updateMessage(id: string, patch: Partial<Message>): number {
		const messages = this._state.conversation.messages.map(m =>
			m.id === id ? { ...m, ...patch } : m
		);
		return this.mutate('conversation.messages', state => ({
			...state,
			conversation: { ...state.conversation, messages }
		}), messages);
	}

	setStreaming(isStreaming: boolean): number {
		return this.mutate('conversation.isStreaming', state => ({
			...state,
			conversation: { ...state.conversation, isStreaming }
		}), isStreaming);
	}

	setPendingChanges(changes: ChangeSet | null): number {
		return this.mutate('conversation.pendingChanges', state => ({
			...state,
			conversation: { ...state.conversation, pendingChanges: changes }
		}), changes);
	}

	updateChangeStatus(changeSetId: string, changeId: string, status: Change['status'], error?: string): number {
		const pendingChanges = this._state.conversation.pendingChanges;
		if (!pendingChanges || pendingChanges.id !== changeSetId) {
			return this._revision; // No change
		}

		const changes = pendingChanges.changes.map(c =>
			c.id === changeId ? { ...c, status, error } : c
		);

		const updated: ChangeSet = { ...pendingChanges, changes };
		return this.mutate('conversation.pendingChanges', state => ({
			...state,
			conversation: { ...state.conversation, pendingChanges: updated }
		}), updated);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Tool Calls (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────

	addToolCall(toolCall: ToolCallInfo): number {
		const activeToolCalls = [...this._state.conversation.activeToolCalls, toolCall];
		return this.mutate('conversation.activeToolCalls', state => ({
			...state,
			conversation: { ...state.conversation, activeToolCalls }
		}), activeToolCalls);
	}

	updateToolCall(id: string, patch: Partial<ToolCallInfo>): number {
		const activeToolCalls = this._state.conversation.activeToolCalls.map(tc =>
			tc.id === id ? { ...tc, ...patch } : tc
		);
		return this.mutate('conversation.activeToolCalls', state => ({
			...state,
			conversation: { ...state.conversation, activeToolCalls }
		}), activeToolCalls);
	}

	clearToolCalls(): number {
		return this.mutate('conversation.activeToolCalls', state => ({
			...state,
			conversation: { ...state.conversation, activeToolCalls: [] }
		}), []);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Quota
	// ─────────────────────────────────────────────────────────────────────────

	updateQuota(quota: Partial<QuotaState>): number {
		const newQuota = { ...this._state.quota, ...quota };
		return this.mutate('quota', state => ({
			...state,
			quota: newQuota
		}), newQuota);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Checkpoints
	// ─────────────────────────────────────────────────────────────────────────

	addCheckpoint(checkpoint: Checkpoint): number {
		const checkpoints = [...this._state.checkpoints, checkpoint];
		return this.mutate('checkpoints', state => ({
			...state,
			checkpoints
		}), checkpoints);
	}

	removeCheckpoint(id: string): number {
		const checkpoints = this._state.checkpoints.filter(cp => cp.id !== id);
		return this.mutate('checkpoints', state => ({
			...state,
			checkpoints
		}), checkpoints);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Permissions
	// ─────────────────────────────────────────────────────────────────────────

	setPermissionRequest(request: PermissionRequest | null): number {
		return this.mutate('permissions.pending', state => ({
			...state,
			permissions: { ...state.permissions, pending: request }
		}), request);
	}

	addGrantedPermission(permission: Permission): number {
		const granted = [...this._state.permissions.granted, permission];
		return this.mutate('permissions.granted', state => ({
			...state,
			permissions: { ...state.permissions, granted }
		}), granted);
	}

	revokePermission(id: string): number {
		const granted = this._state.permissions.granted.filter(p => p.id !== id);
		return this.mutate('permissions.granted', state => ({
			...state,
			permissions: { ...state.permissions, granted }
		}), granted);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Lane (AMENDMENT)
	// ─────────────────────────────────────────────────────────────────────────

	setLane(lane: LaneType): number {
		return this.mutate('currentLane', state => ({
			...state,
			currentLane: lane
		}), lane);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Recent Context (04-04)
	// ─────────────────────────────────────────────────────────────────────────

	private readonly MAX_RECENT_ITEMS = 20;

	addToRecentContext(item: ContextItem): number {
		// Remove if already exists (will be re-added at front)
		let recentContext = this._state.recentContext.filter(
			i => !(i.path === item.path && i.type === item.type)
		);

		// Add to front (most recent first)
		recentContext = [item, ...recentContext];

		// Trim to max items
		if (recentContext.length > this.MAX_RECENT_ITEMS) {
			recentContext = recentContext.slice(0, this.MAX_RECENT_ITEMS);
		}

		return this.mutate('recentContext', state => ({
			...state,
			recentContext
		}), recentContext);
	}

	getRecentContext(): ContextItem[] {
		return this._state.recentContext;
	}

	clearRecentContext(): number {
		return this.mutate('recentContext', state => ({
			...state,
			recentContext: []
		}), []);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Serialization
	// ─────────────────────────────────────────────────────────────────────────

	getFullState(): QICState {
		return { ...this._state };
	}

	restore(state: QICState): void {
		this._state = state;
		this._revision = state.revision;
		this._onDidChangeState.fire({
			revision: this._revision,
			path: '*',
			value: state
		});
	}
}
