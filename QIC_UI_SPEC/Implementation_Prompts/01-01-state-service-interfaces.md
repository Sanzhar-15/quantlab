# Prompt 01-01: State Service Interfaces

**Phase:** 1 - Foundation
**Dependencies:** Phase 0 Complete
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Define the TypeScript interfaces for the unified QIC state service. This is the foundation for all state management and must correctly model both service lifecycle and agent conversation states (GAP-01 fix).

---

## Context

The plan identified a critical gap: the backend has two separate state machines:
1. **ServiceStatus**: Is QIC ready to use? (`initializing` | `ready` | `degraded` | `error`)
2. **AgentState**: What is the conversation doing? (`idle` | `processing` | `waiting_approval` | `error` | `suspended`)

The UI must track both independently.

Reference: `QIC_UI_SPEC/Optimal_plan/03-STATE-AND-PROTOCOL.md`

---

## Scope

### In Scope
- Create `qicStateService.ts` with interfaces
- Define `QICState` main interface
- Define all sub-interfaces (Connection, Context, Conversation, etc.)
- Define `IQicStateService` service interface
- Define `QICStatePatch` for incremental updates
- Include all amendments from plan (lanes, tool calls, etc.)

### Out of Scope
- Implementation of the service (next prompt)
- Message protocol types (separate prompt)
- Webview state handler (separate prompt)

---

## Pre-Conditions

- [ ] Phase 0 complete (clean codebase)
- [ ] Git branch created: `qic-ui/01-01-state-interfaces`

---

## Tasks

### 1. Create File Structure

```bash
mkdir -p src/vs/workbench/contrib/qic/common/state
touch src/vs/workbench/contrib/qic/common/state/qicStateService.ts
```

### 2. Define Core State Types

```typescript
// src/vs/workbench/contrib/qic/common/state/qicStateService.ts

import { Event } from 'vs/base/common/event';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

// ═══════════════════════════════════════════════════════════════════════
// CORE STATE TYPES
// ═══════════════════════════════════════════════════════════════════════

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
```

### 3. Define Main QICState Interface

```typescript
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
}
```

### 4. Define Sub-Interfaces

```typescript
// ═══════════════════════════════════════════════════════════════════════
// CONNECTION STATE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT STATE
// ═══════════════════════════════════════════════════════════════════════

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
    type: 'file' | 'folder' | 'selection' | 'symbol' | 'terminal' | 'diagnostic' | 'docs';

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
}

// ═══════════════════════════════════════════════════════════════════════
// CONVERSATION STATE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// TOOL CALL STATE (AMENDMENT)
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// CHANGES STATE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// QUOTA STATE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// CHECKPOINT STATE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// PERMISSIONS STATE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// ERROR INFO
// ═══════════════════════════════════════════════════════════════════════

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
```

### 5. Define State Patch Type

```typescript
// ═══════════════════════════════════════════════════════════════════════
// STATE PATCH (for incremental updates)
// ═══════════════════════════════════════════════════════════════════════

export interface QICStatePatch {
    /** Revision this patch creates */
    revision: number;

    /** Path to the changed property (supports dot notation) */
    path: string;

    /** New value */
    value: unknown;
}
```

### 6. Define Service Interface

```typescript
// ═══════════════════════════════════════════════════════════════════════
// SERVICE INTERFACE
// ═══════════════════════════════════════════════════════════════════════

export const IQicStateService = createDecorator<IQicStateService>('qicStateService');

export interface IQicStateService {
    readonly _serviceBrand: undefined;

    /** Current state (read-only) */
    readonly state: Readonly<QICState>;

    /** Event fired when state changes */
    readonly onDidChangeState: Event<QICStatePatch>;

    /** Current revision number */
    readonly revision: number;

    // ─────────────────────────────────────────────────────────────────
    // Service & Agent State (GAP-01)
    // ─────────────────────────────────────────────────────────────────

    setServiceStatus(status: ServiceStatus): number;
    setAgentState(state: AgentState): number;

    // ─────────────────────────────────────────────────────────────────
    // Connection
    // ─────────────────────────────────────────────────────────────────

    updateConnection(connection: Partial<ConnectionState>): number;

    // ─────────────────────────────────────────────────────────────────
    // Context
    // ─────────────────────────────────────────────────────────────────

    addContextItem(item: ContextItem): number;
    removeContextItem(id: string): number;
    pinContextItem(id: string): number;
    unpinContextItem(id: string): number;
    clearContext(): number;
    updateContextTokens(totalTokens: number, maxTokens: number): number;

    // ─────────────────────────────────────────────────────────────────
    // Conversation
    // ─────────────────────────────────────────────────────────────────

    setConversation(id: string, title: string, messages: Message[]): number;
    addMessage(message: Message): number;
    updateMessage(id: string, patch: Partial<Message>): number;
    setStreaming(isStreaming: boolean): number;
    setPendingChanges(changes: ChangeSet | null): number;
    updateChangeStatus(changeSetId: string, changeId: string, status: Change['status'], error?: string): number;

    // ─────────────────────────────────────────────────────────────────
    // Tool Calls (AMENDMENT)
    // ─────────────────────────────────────────────────────────────────

    addToolCall(toolCall: ToolCallInfo): number;
    updateToolCall(id: string, patch: Partial<ToolCallInfo>): number;
    clearToolCalls(): number;

    // ─────────────────────────────────────────────────────────────────
    // Quota
    // ─────────────────────────────────────────────────────────────────

    updateQuota(quota: Partial<QuotaState>): number;

    // ─────────────────────────────────────────────────────────────────
    // Checkpoints
    // ─────────────────────────────────────────────────────────────────

    addCheckpoint(checkpoint: Checkpoint): number;
    removeCheckpoint(id: string): number;

    // ─────────────────────────────────────────────────────────────────
    // Permissions
    // ─────────────────────────────────────────────────────────────────

    setPermissionRequest(request: PermissionRequest | null): number;
    addGrantedPermission(permission: Permission): number;
    revokePermission(id: string): number;

    // ─────────────────────────────────────────────────────────────────
    // Lane (AMENDMENT)
    // ─────────────────────────────────────────────────────────────────

    setLane(lane: LaneType): number;

    // ─────────────────────────────────────────────────────────────────
    // Serialization
    // ─────────────────────────────────────────────────────────────────

    getFullState(): QICState;
    restore(state: QICState): void;
}
```

### 7. Add JSDoc Documentation

Ensure all interfaces have clear JSDoc comments explaining:
- Purpose of each field
- When it's updated
- Relationship to backend state

---

## Verification

### Success Criteria
- [ ] File created at correct path
- [ ] All interfaces compile without errors
- [ ] All types from plan included
- [ ] GAP-01 fix implemented (dual state)
- [ ] All amendments included (lanes, tool calls)
- [ ] Service interface has all required methods

### Verification Commands
```bash
# TypeScript compilation
npx tsc --noEmit src/vs/workbench/contrib/qic/common/state/qicStateService.ts

# Check for TODO markers
grep -n "TODO" src/vs/workbench/contrib/qic/common/state/qicStateService.ts
```

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/common/state/qicStateService.ts
rmdir src/vs/workbench/contrib/qic/common/state  # if empty
```

---

## Code Changes

### Files Created
| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/state/qicStateService.ts` | State interfaces |

### Estimated Lines
- ~400-500 lines of interface definitions

---

## Notes

- These interfaces are the contract - get them right
- All methods return the new revision number
- State is always immutable from consumer perspective
- Patches use dot notation for nested paths (e.g., `conversation.messages`)
