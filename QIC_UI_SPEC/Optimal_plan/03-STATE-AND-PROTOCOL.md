# Phase 1: State Management & Protocol

**Duration:** 1 week | **Depends on:** Phase 0 (Cleanup)

---

## Overview

This phase implements the unified state model and revision-based message protocol. This is foundational for all subsequent phases.

---

## 1. Unified State Service

### 1.1 Create QicStateService

**New file:** `src/vs/workbench/contrib/qic/common/state/qicStateService.ts`

```typescript
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

// ═══════════════════════════════════════════════════════════════════════
// STATE INTERFACES (from spec, with amendments)
// ═══════════════════════════════════════════════════════════════════════

export interface QICState {
    revision: number;
    // GAP-01 FIX: Separate service and agent states
    serviceStatus: ServiceStatus;
    agentState: AgentState;
    connection: ConnectionState;
    context: ContextState;
    conversation: ConversationState;
    quota: QuotaState;
    checkpoints: Checkpoint[];
    permissions: PermissionsState;
    // AMENDMENT: Lane system from existing codebase
    currentLane: LaneType;
}

// GAP-01 FIX: Service lifecycle state (Is QIC ready to use?)
export type ServiceStatus = 'initializing' | 'ready' | 'degraded' | 'error';

// GAP-01 FIX: Agent conversation state (What is the conversation doing?)
export type AgentState = 'idle' | 'processing' | 'waiting_approval' | 'error' | 'suspended';

/*
 * GAP-01 FIX: UI Impact of Dual State Machines
 * =============================================
 *
 * The UI must react to BOTH states independently:
 *
 * ServiceStatus affects:
 *   - Status bar color (green=ready, yellow=degraded, red=error)
 *   - Whether the panel is usable at all
 *   - Error banners when degraded/error
 *
 * AgentState affects:
 *   - Streaming indicator visibility (processing)
 *   - Input disabled state (processing, waiting_approval, suspended)
 *   - Cancel button visibility (processing)
 *   - Permission card visibility (waiting_approval)
 *
 * State combinations:
 *   | ServiceStatus | AgentState       | UI Behavior |
 *   |---------------|------------------|-------------|
 *   | initializing  | idle             | Show loading spinner |
 *   | ready         | idle             | Input enabled, ready for user |
 *   | ready         | processing       | Show streaming, input disabled |
 *   | ready         | waiting_approval | Show permission card, input disabled |
 *   | degraded      | processing       | Show warning banner + streaming |
 *   | error         | *                | Show error banner, panel disabled |
 */

export interface ConnectionState {
    // Connection-specific info (not service lifecycle)
    provider: 'qic-cloud' | 'anthropic' | 'openai' | 'ollama' | 'offline';
    degradationLevel: 0 | 1 | 2 | 3 | 4;
    latencyMs: number;
    // AMENDMENT: Model info from existing codebase
    currentModel: string;
    region?: string;
}

export interface ContextState {
    items: ContextItem[];
    totalTokens: number;
    maxTokens: number;
}

export interface ConversationState {
    id: string;
    title: string;
    messages: Message[];
    isStreaming: boolean;
    pendingChanges: ChangeSet | null;
    // AMENDMENT: Active tool calls
    activeToolCalls: ToolCallInfo[];
}

export interface QuotaState {
    used: number;
    limit: number;
    estimatedCost: number;
    resetDate: string;
}

export interface PermissionsState {
    granted: Permission[];
    pending: PermissionRequest | null;
}

// AMENDMENT: Lane types from prompts.ts
export type LaneType = 'chat-ask' | 'chat-gather' | 'chat-plan' | 'chat-act' | 'completion' | 'repair' | 'fast-apply' | 'summarize';

// AMENDMENT: Tool call tracking
export interface ToolCallInfo {
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
    args?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// STATE PATCH
// ═══════════════════════════════════════════════════════════════════════

export interface QICStatePatch {
    revision: number;
    path: keyof QICState | string;  // Supports nested paths like 'conversation.messages'
    value: unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// SERVICE INTERFACE
// ═══════════════════════════════════════════════════════════════════════

export const IQicStateService = createDecorator<IQicStateService>('qicStateService');

export interface IQicStateService {
    readonly _serviceBrand: undefined;
    readonly state: Readonly<QICState>;
    readonly onDidChangeState: Event<QICStatePatch>;
    readonly revision: number;

    // GAP-01 FIX: Separate service and agent state updates
    setServiceStatus(status: ServiceStatus): number;
    setAgentState(state: AgentState): number;

    // Connection
    updateConnection(connection: Partial<ConnectionState>): number;

    // Context
    addContextItem(item: ContextItem): number;
    removeContextItem(id: string): number;
    pinContextItem(id: string): number;
    unpinContextItem(id: string): number;
    clearContext(): number;
    updateContextTokens(totalTokens: number, maxTokens: number): number;

    // Conversation
    setConversation(id: string, title: string, messages: Message[]): number;
    addMessage(message: Message): number;
    updateMessage(id: string, patch: Partial<Message>): number;
    setStreaming(isStreaming: boolean): number;
    setPendingChanges(changes: ChangeSet | null): number;
    updateChangeStatus(changeSetId: string, changeId: string, status: Change['status'], error?: string): number;

    // Tool calls (AMENDMENT)
    addToolCall(toolCall: ToolCallInfo): number;
    updateToolCall(id: string, patch: Partial<ToolCallInfo>): number;
    clearToolCalls(): number;

    // Quota
    updateQuota(quota: Partial<QuotaState>): number;

    // Checkpoints
    addCheckpoint(checkpoint: Checkpoint): number;
    removeCheckpoint(id: string): number;

    // Permissions
    setPermissionRequest(request: PermissionRequest | null): number;
    addGrantedPermission(permission: Permission): number;
    revokePermission(id: string): number;

    // Lane (AMENDMENT)
    setLane(lane: LaneType): number;

    // Serialization
    getFullState(): QICState;
    restore(state: QICState): void;
}
```

### 1.2 Implementation

```typescript
export class QicStateService extends Disposable implements IQicStateService {
    declare readonly _serviceBrand: undefined;

    private _state: QICState;
    private _revision = 0;

    private readonly _onDidChangeState = this._register(new Emitter<QICStatePatch>());
    readonly onDidChangeState = this._onDidChangeState.event;

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

    private createInitialState(): QICState {
        return {
            revision: 0,
            // GAP-01 FIX: Initialize both state machines
            serviceStatus: 'initializing',
            agentState: 'idle',
            connection: {
                provider: 'qic-cloud',
                degradationLevel: 0,
                latencyMs: 0,
                currentModel: 'claude-latest'
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
            currentLane: 'chat-ask'
        };
    }

    private emit(path: string, value: unknown): number {
        this._revision++;
        this._state = { ...this._state, revision: this._revision };
        this._onDidChangeState.fire({ revision: this._revision, path, value });
        return this._revision;
    }

    // Example mutation implementation
    updateConnection(connection: Partial<ConnectionState>): number {
        this._state = {
            ...this._state,
            connection: { ...this._state.connection, ...connection }
        };
        return this.emit('connection', this._state.connection);
    }

    addMessage(message: Message): number {
        this._state = {
            ...this._state,
            conversation: {
                ...this._state.conversation,
                messages: [...this._state.conversation.messages, message]
            }
        };
        return this.emit('conversation.messages', this._state.conversation.messages);
    }

    // ... implement all other methods similarly

    getFullState(): QICState {
        return { ...this._state };
    }

    restore(state: QICState): void {
        this._state = state;
        this._revision = state.revision;
        this._onDidChangeState.fire({ revision: this._revision, path: '*', value: state });
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}
```

---

## 2. Message Protocol V2

### 2.1 Create Protocol V2 Types

**New file:** `src/vs/workbench/contrib/qic/common/ui/messageProtocolV2.ts`

```typescript
import type { QICState, QICStatePatch, Message, ContextItem, ChangeSet, PermissionRequest, Checkpoint, ToolCallInfo } from '../state/qicStateService.js';

// ═══════════════════════════════════════════════════════════════════════
// HOST → WEBVIEW
// ═══════════════════════════════════════════════════════════════════════

export type HostToWebviewMessageV2 =
    // State synchronization
    | { type: 'state:full'; revision: number; payload: QICState }
    | { type: 'state:patch'; revision: number; payload: QICStatePatch }
    | { type: 'state:sync'; revision: number }

    // Streaming
    | { type: 'message:start'; revision: number; payload: { id: string } }
    | { type: 'message:chunk'; revision: number; payload: { id: string; content: string; kind: 'text' | 'code' } }
    | { type: 'message:complete'; revision: number; payload: { id: string; metadata?: MessageMetadata } }
    | { type: 'message:error'; revision: number; payload: { id: string; error: ErrorInfo } }

    // Tool calls (AMENDMENT: not in spec but exists in codebase)
    | { type: 'tool:start'; revision: number; payload: ToolCallInfo }
    | { type: 'tool:result'; revision: number; payload: { id: string; content: string; isError: boolean } }

    // Conversation management
    | { type: 'conversation:titleUpdated'; revision: number; payload: { id: string; title: string } }
    | { type: 'conversations:list'; revision: number; payload: { conversations: ConversationSummary[] } }
    | { type: 'conversations:searchResults'; revision: number; payload: { query: string; results: SearchResult[] } }

    // Changes
    | { type: 'changes:pending'; revision: number; payload: ChangeSet }
    | { type: 'changes:resolved'; revision: number; payload: { id: string; status: 'accepted' | 'rejected' | 'partial' } }
    | { type: 'changes:fileStatus'; revision: number; payload: { changeSetId: string; changeId: string; status: string; error?: string } }

    // Permissions
    | { type: 'permission:request'; revision: number; payload: PermissionRequest }
    | { type: 'permission:resolved'; revision: number; payload: { id: string; granted: boolean } }

    // Context
    | { type: 'context:update'; revision: number; payload: { items: ContextItem[]; totalTokens: number; maxTokens: number } }

    // Checkpoints
    | { type: 'checkpoint:created'; revision: number; payload: Checkpoint }
    | { type: 'checkpoint:restored'; revision: number; payload: { id: string; filesChanged: number } }

    // Audit
    | { type: 'audit:entries'; revision: number; payload: { entries: AuditEntry[]; total: number; hasMore: boolean } }

    // Export
    | { type: 'export:ready'; revision: number; payload: { type: string; format: string; data: string } }

    // AMENDMENT: Theme
    | { type: 'theme:change'; revision: number; payload: { theme: 'light' | 'dark' | 'high-contrast' } };

// ═══════════════════════════════════════════════════════════════════════
// WEBVIEW → HOST
// ═══════════════════════════════════════════════════════════════════════

export type WebviewToHostMessageV2 =
    // Lifecycle
    | { type: 'ready' }
    | { type: 'revision:ack'; revision: number }
    | { type: 'state:request' }

    // Messages
    | { type: 'send'; payload: { content: string; mentions: Mention[] } }
    | { type: 'cancel' }
    | { type: 'retry'; payload: { messageId: string } }
    | { type: 'regenerate'; payload: { messageId: string } }
    | { type: 'edit'; payload: { messageId: string; newContent: string; mentions: Mention[] } }
    | { type: 'switchBranch'; payload: { messageId: string; branchId: string } }
    | { type: 'deleteBranch'; payload: { messageId: string; branchId: string } }

    // Conversations
    | { type: 'newChat' }
    | { type: 'loadConversation'; payload: { conversationId: string } }
    | { type: 'deleteConversation'; payload: { conversationId: string } }
    | { type: 'renameConversation'; payload: { conversationId: string; title: string } }
    | { type: 'conversations:requestList' }
    | { type: 'conversations:search'; payload: { query: string } }
    | { type: 'conversations:export'; payload: { conversationId: string; format: string } }

    // Changes
    | { type: 'changes:accept'; payload: { changeSetId: string; changeId: string } }
    | { type: 'changes:reject'; payload: { changeSetId: string; changeId: string } }
    | { type: 'changes:acceptGroup'; payload: { changeSetId: string; groupId: string } }
    | { type: 'changes:rejectGroup'; payload: { changeSetId: string; groupId: string } }
    | { type: 'changes:acceptAll'; payload: { changeSetId: string } }
    | { type: 'changes:rejectAll'; payload: { changeSetId: string } }
    | { type: 'changes:retryFailed'; payload: { changeSetId: string } }

    // Permissions
    | { type: 'permission:allow'; payload: { id: string; scope: 'once' | 'session' | 'always' } }
    | { type: 'permission:deny'; payload: { id: string } }
    | { type: 'permission:revoke'; payload: { id: string } }

    // Context
    | { type: 'context:add'; payload: { type: string; path: string } }
    | { type: 'context:remove'; payload: { id: string } }
    | { type: 'context:pin'; payload: { id: string } }
    | { type: 'context:unpin'; payload: { id: string } }
    | { type: 'context:clear' }

    // Checkpoints
    | { type: 'checkpoint:create'; payload: { description?: string } }
    | { type: 'checkpoint:restore'; payload: { id: string } }
    | { type: 'checkpoint:delete'; payload: { id: string } }

    // Audit
    | { type: 'audit:request'; payload: { filter?: string; timeRange?: string; offset?: number; limit?: number } }
    | { type: 'audit:export'; payload: { format: string } }

    // AMENDMENT: File reference clicks
    | { type: 'open-file-reference'; path: string; isFolder: boolean }

    // AMENDMENT: Quick Pick triggers
    | { type: 'quickPick:history' }
    | { type: 'quickPick:checkpoints' }
    | { type: 'quickPick:provider' }
    | { type: 'quickPick:status' };

// ═══════════════════════════════════════════════════════════════════════
// SUPPORTING TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface MessageMetadata {
    changes?: ChangeSet;
    error?: ErrorInfo;
    tokensUsed?: number;
}

export interface ErrorInfo {
    code: string;
    title: string;
    message: string;
    recoverable: boolean;
    retryAfter?: number;
    actions: ErrorAction[];
}

export interface ErrorAction {
    label: string;
    command: string;
    args?: unknown[];
}

export interface ConversationSummary {
    id: string;
    title: string;
    timestamp: string;
    messageCount: number;
    preview?: string;
}

export interface SearchResult {
    conversationId: string;
    messageId: string;
    snippet: string;
    timestamp: string;
}

export interface Mention {
    id: string;
    type: 'file' | 'folder' | 'symbol' | 'docs';
    path: string;
    displayName: string;
    tokens: number;
}

export interface AuditEntry {
    id: string;
    timestamp: string;
    type: 'tool_call' | 'permission' | 'change' | 'checkpoint' | 'error';
    data: Record<string, unknown>;
    sessionId: string;
    prevHash: string;
    hash: string;
}
```

---

## 3. Message Bridge

### 3.1 Create Bridge Service

**File:** `src/vs/workbench/contrib/qic/browser/messageBridge.ts`

```typescript
import { Disposable } from 'vs/base/common/lifecycle';
import type { IQicStateService, QICStatePatch } from '../common/state/qicStateService.js';
import type { HostToWebviewMessageV2, WebviewToHostMessageV2 } from '../common/ui/messageProtocolV2.js';

export class QicMessageBridge extends Disposable {
    private webviewReady = false;
    private messageQueue: HostToWebviewMessageV2[] = [];
    private lastAckedRevision = 0;

    constructor(
        private readonly stateService: IQicStateService,
        private readonly postMessage: (msg: HostToWebviewMessageV2) => void
    ) {
        super();

        // Forward state changes to webview
        this._register(stateService.onDidChangeState(patch => {
            this.sendPatch(patch);
        }));
    }

    // Called when webview sends 'ready'
    onWebviewReady(): void {
        this.webviewReady = true;

        // Send full state
        this.send({
            type: 'state:full',
            revision: this.stateService.revision,
            payload: this.stateService.getFullState()
        });

        // Flush queue
        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift()!;
            this.postMessage(msg);
        }
    }

    // Called when webview acknowledges revision
    onRevisionAck(revision: number): void {
        this.lastAckedRevision = revision;
    }

    // Called when webview requests state (gap detected)
    onStateRequest(): void {
        this.send({
            type: 'state:full',
            revision: this.stateService.revision,
            payload: this.stateService.getFullState()
        });
    }

    private sendPatch(patch: QICStatePatch): void {
        this.send({
            type: 'state:patch',
            revision: patch.revision,
            payload: patch
        });
    }

    send(msg: HostToWebviewMessageV2): void {
        if (!this.webviewReady) {
            this.messageQueue.push(msg);
            return;
        }
        this.postMessage(msg);
    }
}
```

---

## 3.2 GAP-06 FIX: Permission Dialog Promise Resolution

The backend's permission flow requires proper Promise resolution:

```
Tool needs permission → PermissionManager.check() →
  If not granted → uiService.showPermissionDialog() →
    Returns Promise<PermissionCheckResult> →
      { granted: boolean, scope: 'once' | 'session' | 'always', reason?: string }
```

**Host-side Implementation:**

```typescript
// In QicChatViewPane or a dedicated PermissionBridge
private pendingPermissionDialogs = new Map<string, {
    resolve: (result: PermissionCheckResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}>();

async showPermissionDialog(tool: string, context: ToolContext): Promise<PermissionCheckResult> {
    const requestId = this.generateId();
    const PERMISSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    return new Promise((resolve, reject) => {
        // Set up timeout
        const timeout = setTimeout(() => {
            this.pendingPermissionDialogs.delete(requestId);
            reject(new Error('Permission request timed out'));
        }, PERMISSION_TIMEOUT);

        this.pendingPermissionDialogs.set(requestId, { resolve, reject, timeout });

        // Send to webview
        this.messageBridge.send({
            type: 'permission:request',
            revision: this.stateService.revision,
            payload: {
                id: requestId,
                toolName: tool,
                description: this.formatToolDescription(tool, context),
                riskLevel: this.getToolRiskLevel(tool),
                timestamp: Date.now()
            }
        });

        // Also update state for UI
        this.stateService.setPermissionRequest({
            id: requestId,
            toolName: tool,
            description: this.formatToolDescription(tool, context),
            riskLevel: this.getToolRiskLevel(tool)
        });
    });
}

// Handle webview response
handlePermissionResponse(msg: { type: 'permission:allow' | 'permission:deny'; payload: { id: string; scope?: string } }): void {
    const pending = this.pendingPermissionDialogs.get(msg.payload.id);
    if (!pending) {
        console.warn('No pending permission dialog for id:', msg.payload.id);
        return;
    }

    clearTimeout(pending.timeout);
    this.pendingPermissionDialogs.delete(msg.payload.id);

    // Clear pending request from state
    this.stateService.setPermissionRequest(null);

    if (msg.type === 'permission:allow') {
        pending.resolve({
            granted: true,
            scope: msg.payload.scope as 'once' | 'session' | 'always',
            reason: undefined
        });
    } else {
        pending.resolve({
            granted: false,
            scope: 'once',
            reason: 'User denied permission'
        });
    }
}
```

**Webview-side Handler:**

```javascript
// In permission card click handlers
function allowPermission(requestId, scope) {
    vscode.postMessage({
        type: 'permission:allow',
        payload: { id: requestId, scope: scope }
    });
    // Hide permission card immediately for responsive feel
    hidePermissionCard(requestId);
}

function denyPermission(requestId) {
    vscode.postMessage({
        type: 'permission:deny',
        payload: { id: requestId }
    });
    hidePermissionCard(requestId);
}
```

---

## 4. Webview State Handler

### 4.1 State Manager in Webview

**File:** `src/vs/workbench/contrib/qic/browser/media/stateManager.js`

```javascript
// @ts-nocheck
// QIC Webview State Manager - Handles revision-based state sync

(function() {
    'use strict';

    let currentRevision = 0;
    let state = null;
    const listeners = new Set();

    function getState() {
        return state;
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function notifyListeners(patch) {
        listeners.forEach(fn => fn(state, patch));
    }

    function handleMessage(msg) {
        // Ignore old revisions
        if (msg.revision !== undefined && msg.revision <= currentRevision) {
            console.log('[StateManager] Ignoring old revision:', msg.revision, 'current:', currentRevision);
            return false;
        }

        switch (msg.type) {
            case 'state:full':
                state = msg.payload;
                currentRevision = msg.revision;
                notifyListeners(null);
                vscode.postMessage({ type: 'revision:ack', revision: currentRevision });
                return true;

            case 'state:patch':
                if (!state) {
                    // Request full state if we don't have one
                    vscode.postMessage({ type: 'state:request' });
                    return false;
                }

                // Check for gap
                if (msg.revision > currentRevision + 1) {
                    console.warn('[StateManager] Gap detected, requesting full state');
                    vscode.postMessage({ type: 'state:request' });
                    return false;
                }

                // Apply patch
                state = applyPatch(state, msg.payload);
                currentRevision = msg.revision;
                notifyListeners(msg.payload);
                vscode.postMessage({ type: 'revision:ack', revision: currentRevision });
                return true;

            case 'state:sync':
                // Host is checking if we're in sync
                vscode.postMessage({ type: 'revision:ack', revision: currentRevision });
                return true;

            default:
                return false;
        }
    }

    function applyPatch(state, patch) {
        const newState = { ...state, revision: patch.revision };
        const path = patch.path.split('.');
        let target = newState;

        for (let i = 0; i < path.length - 1; i++) {
            target[path[i]] = { ...target[path[i]] };
            target = target[path[i]];
        }

        target[path[path.length - 1]] = patch.value;
        return newState;
    }

    // Export
    window.qicState = {
        getState,
        subscribe,
        handleMessage,
        getRevision: () => currentRevision
    };
})();
```

---

## 5. Service Registration

### 5.1 Register State Service

**File:** `src/vs/workbench/contrib/qic/browser/qic.contribution.ts`

Add to service registration:

```typescript
import { IQicStateService, QicStateService } from '../common/state/qicStateService.js';

// In registerSingleton section:
registerSingleton(IQicStateService, QicStateService, InstantiationType.Eager);
```

---

## 6. Migration Path

### 6.1 Compatibility Layer

Keep old message types working during migration:

```typescript
// In QicChatViewPane.handleWebviewMessage()
private handleWebviewMessage(msg: WebviewToHostMessage | WebviewToHostMessageV2): void {
    // V2 messages
    if (msg.type === 'ready') {
        this.messageBridge.onWebviewReady();
        return;
    }
    if (msg.type === 'revision:ack') {
        this.messageBridge.onRevisionAck((msg as any).revision);
        return;
    }
    if (msg.type === 'state:request') {
        this.messageBridge.onStateRequest();
        return;
    }

    // V1 messages (legacy) - forward to existing handlers
    if (msg.type === 'user-message') {
        // Existing handler
    }
    // ... etc
}
```

---

## 7. Testing

### Unit Tests

```typescript
// src/vs/workbench/contrib/qic/test/state/qicStateService.test.ts

suite('QicStateService', () => {
    let service: QicStateService;

    setup(() => {
        service = new QicStateService();
    });

    test('initial state has revision 0', () => {
        assert.strictEqual(service.revision, 0);
    });

    test('mutations increment revision', () => {
        service.updateConnection({ status: 'connected' });
        assert.strictEqual(service.revision, 1);
    });

    test('emits patch on mutation', () => {
        const patches: QICStatePatch[] = [];
        service.onDidChangeState(p => patches.push(p));

        service.updateConnection({ status: 'connected' });

        assert.strictEqual(patches.length, 1);
        assert.strictEqual(patches[0].path, 'connection');
        assert.strictEqual(patches[0].revision, 1);
    });

    test('restore sets state and revision', () => {
        const savedState = { ...service.getFullState(), revision: 42 };
        service.restore(savedState);

        assert.strictEqual(service.revision, 42);
    });
});
```

---

## 8. Checklist

### State Service
- [ ] Create `qicStateService.ts` with interfaces
- [ ] Implement all mutation methods
- [ ] Add serialization/restore
- [ ] Register as singleton
- [ ] Write unit tests

### Protocol V2
- [ ] Create `messageProtocolV2.ts`
- [ ] Define all message types
- [ ] Add amendments for existing features

### Message Bridge
- [ ] Create `messageBridge.ts`
- [ ] Implement queue and sync logic
- [ ] Handle revision gaps

### Webview State
- [ ] Create `stateManager.js`
- [ ] Implement patch application
- [ ] Add gap detection
- [ ] Export global API

### Migration
- [ ] Add compatibility layer in panel
- [ ] Test both V1 and V2 messages
- [ ] Document deprecation timeline
