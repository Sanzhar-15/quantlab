# Prompt 01-02: State Service Implementation

**Phase:** 1 - Foundation
**Dependencies:** 01-01 (State Service Interfaces)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement the `QicStateService` class that provides centralized state management for the QIC UI. This service is the single source of truth for all UI state.

---

## Context

The interfaces from 01-01 define WHAT the state looks like. This prompt implements HOW the state is managed:
- Immutable state updates
- Revision tracking
- Event emission for subscribers
- Serialization for persistence

Reference: `QIC_UI_SPEC/Optimal_plan/03-STATE-AND-PROTOCOL.md`

---

## Scope

### In Scope
- Implement `QicStateService` class
- Implement all mutation methods
- Implement event emission
- Implement serialization/restore
- Add utility methods

### Out of Scope
- Service registration (next prompt)
- Integration with existing services
- Webview communication

---

## Pre-Conditions

- [ ] 01-01 complete (interfaces defined)
- [ ] Git branch created: `qic-ui/01-02-state-implementation`

---

## Tasks

### 1. Create Implementation Class

```typescript
// src/vs/workbench/contrib/qic/common/state/qicStateService.ts
// (Add to existing file after interfaces)

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';

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
```

### 2. Implement Initial State Factory

```typescript
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
            currentLane: 'chat-ask'
        };
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
    }
```

### 3. Implement Core Mutation Helper

```typescript
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

    /**
     * Helper for immutable nested updates
     */
    private updateNested<T extends object>(obj: T, path: string[], value: unknown): T {
        if (path.length === 0) {
            return value as T;
        }

        const [head, ...tail] = path;
        return {
            ...obj,
            [head]: tail.length === 0
                ? value
                : this.updateNested((obj as any)[head], tail, value)
        };
    }
```

### 4. Implement Service & Agent State Methods (GAP-01)

```typescript
    // ─────────────────────────────────────────────────────────────────
    // Service & Agent State (GAP-01 FIX)
    // ─────────────────────────────────────────────────────────────────

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
```

### 5. Implement Connection Methods

```typescript
    // ─────────────────────────────────────────────────────────────────
    // Connection
    // ─────────────────────────────────────────────────────────────────

    updateConnection(connection: Partial<ConnectionState>): number {
        const newConnection = { ...this._state.connection, ...connection };
        return this.mutate('connection', state => ({
            ...state,
            connection: newConnection
        }), newConnection);
    }
```

### 6. Implement Context Methods

```typescript
    // ─────────────────────────────────────────────────────────────────
    // Context
    // ─────────────────────────────────────────────────────────────────

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
```

### 7. Implement Conversation Methods

```typescript
    // ─────────────────────────────────────────────────────────────────
    // Conversation
    // ─────────────────────────────────────────────────────────────────

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
```

### 8. Implement Tool Call Methods

```typescript
    // ─────────────────────────────────────────────────────────────────
    // Tool Calls (AMENDMENT)
    // ─────────────────────────────────────────────────────────────────

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
```

### 9. Implement Remaining Methods

```typescript
    // ─────────────────────────────────────────────────────────────────
    // Quota
    // ─────────────────────────────────────────────────────────────────

    updateQuota(quota: Partial<QuotaState>): number {
        const newQuota = { ...this._state.quota, ...quota };
        return this.mutate('quota', state => ({
            ...state,
            quota: newQuota
        }), newQuota);
    }

    // ─────────────────────────────────────────────────────────────────
    // Checkpoints
    // ─────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────
    // Permissions
    // ─────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────
    // Lane
    // ─────────────────────────────────────────────────────────────────

    setLane(lane: LaneType): number {
        return this.mutate('currentLane', state => ({
            ...state,
            currentLane: lane
        }), lane);
    }

    // ─────────────────────────────────────────────────────────────────
    // Serialization
    // ─────────────────────────────────────────────────────────────────

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
```

---

## Verification

### Success Criteria
- [ ] All interface methods implemented
- [ ] Compiles without errors
- [ ] Mutations are immutable
- [ ] Events fire on each mutation
- [ ] Revision increments correctly
- [ ] Unit tests pass (if written)

### Verification Commands
```bash
# Build
npm run compile

# Type check
npx tsc --noEmit
```

### Manual Verification
Create a simple test:
```typescript
const service = new QicStateService();
console.log('Initial revision:', service.revision); // 0

service.onDidChangeState(patch => {
    console.log('Patch:', patch.path, patch.revision);
});

service.setServiceStatus('ready');
console.log('After setServiceStatus:', service.revision); // 1

service.setAgentState('processing');
console.log('After setAgentState:', service.revision); // 2
```

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/common/state/qicStateService.ts
```

---

## Notes

- All mutations must be immutable (spread operators)
- Each mutation must increment revision
- Each mutation must fire event
- Performance: consider batching for multiple rapid updates
