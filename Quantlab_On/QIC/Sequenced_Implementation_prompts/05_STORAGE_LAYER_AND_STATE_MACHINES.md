# Prompt 05 — Storage Layer, State Machines & Timeout/Cancellation

**Phase**: 1 (Foundation)
**Prerequisites**: Prompts 03 (state persistence) and 04 (canonical types)
**Estimated Scope**: ~8 files created, ~900 lines

---

## Objective

Implement the persistent state machines (Agent, Task, Conversation), the timeout manager with domain separation, and the hierarchical cancellation manager. These are the runtime primitives that govern QIC's execution lifecycle.

---

## Spec References

- QIC Spec v6.2: §3.2 State Machines (lines 2119–2444) — Agent, Task, Conversation FSMs
- QIC Spec v6.2: §2.5 Timeout Manager (lines 1806–2005) — Domain-separated timeouts
- QIC Spec v6.2: §3.3 Cancellation Protocol (lines 2444–2568) — Hierarchical cancellation
- QIC Spec v6.2: §5.1 Storage Overview (lines 3512–3538)
- QIC Spec v6.2: §5.2 BM25 Schema (lines 3538–3592)

## Audit Fixes Incorporated

- **S-4 (HIGH)**: `PersistentAgentStateMachine.recover()` must NOT reference `this.ui`. Return recovery state and let caller handle UI.
- **S-5 (HIGH)**: `PersistentTaskStateMachine.recover()` must restore `failedSteps` from `failed_steps_json`.
- **S-7 (HIGH)**: Define complete BM25 SQL schema with column definitions.
- **I-SG11 (HIGH)**: Add complete BM25 SQL DDL including FTS5 virtual table for full-text search.
- **IV-AO8 (HIGH)**: Fix `PersistentAgentStateMachine.recover()` to remove UI dependency from static factory; return machine and let caller handle notification.
- **IV-AO9 (HIGH)**: Add `failed_steps_json` column to `qic_task_state` table; update persist()/recover() methods.
- **VII-DS2 (HIGH)**: Add state-transition timeout wiring with explicit timeout constants per transition.
- **VII-DS8 (MEDIUM)**: Add `qic_permissions`, `qic_sessions`, `qic_config` tables to storage schema.
- **VII-DS9 (MEDIUM)**: Add LanceDB vector storage initialization section.
- **X-PS8 (MEDIUM)**: Change `sessionId` from private to public (or add getter) in PersistentAgentStateMachine.
- **XII-AR9 (LOW)**: Add scope cleanup `removeScope(scopeId)` to CancellationManager after processing completes.

---

## Implementation Instructions

### 1. PersistentAgentStateMachine (`src/vs/workbench/contrib/qic/common/state/agentStateMachine.ts`)

States: `idle → processing → waiting_approval → idle` (with `error` and `suspended` as terminal/pause states)

```typescript
export type AgentState = 'idle' | 'processing' | 'waiting_approval' | 'error' | 'suspended';

export class PersistentAgentStateMachine {
    private state: AgentState = 'idle';

    // AUDIT FIX X-PS8: sessionId must be accessible by Prompt 10's AgentOrchestrator
    private readonly _sessionId: string;

    constructor(
        private readonly db: StatePersistenceManager,
        sessionId: string
    ) {
        this._sessionId = sessionId;
    }

    get sessionId(): string { return this._sessionId; }

    // Valid transitions
    private readonly transitions: Record<AgentState, AgentState[]> = {
        'idle': ['processing', 'suspended'],
        'processing': ['waiting_approval', 'idle', 'error', 'suspended'],
        'waiting_approval': ['processing', 'idle', 'error'],
        'error': ['idle', 'suspended'],
        'suspended': ['idle']
    };

    // AUDIT FIX VII-DS2: State-transition timeout wiring
    // Spec §5.4 defines timeout pairs for agent state transitions.
    private static readonly STATE_TIMEOUTS: Record<string, number> = {
        'idle→processing': 120_000,           // 2 minutes to start processing
        'processing→waiting_approval': 300_000, // 5 minutes for LLM + tool execution
        'waiting_approval→processing': Infinity, // INV-A4: No timeout for user approval
        'processing→complete': 600_000,        // 10 minutes total processing budget
    };

    async transition(to: AgentState, timeoutManager?: TimeoutManager): Promise<void> {
        if (!this.transitions[this.state]?.includes(to)) {
            throw new Error(`Invalid transition: ${this.state} → ${to}`);
        }

        // Wire state-transition timeout if a TimeoutManager is provided
        const key = `${this.state}→${to}`;
        const timeout = PersistentAgentStateMachine.STATE_TIMEOUTS[key];
        if (timeoutManager && timeout !== undefined && timeout !== Infinity) {
            timeoutManager.schedule(`state-${key}`, timeout, () => {
                this.transition('error');
            });
        }

        this.state = to;
        await this.persist();
    }

    getState(): AgentState { return this.state; }

    private async persist(): Promise<void> {
        await this.db.saveAgentState(this.sessionId, {
            state: this.state,
            // ... other fields
        });
    }

    /**
     * AUDIT FIX S-4 / IV-AO8: recover() is a static factory method.
     * It must NOT depend on UI. Returns the machine and recovery info.
     * The CALLER handles UI notification:
     *
     *   // In activation sequence (Prompt 18):
     *   const recovered = await PersistentAgentStateMachine.recover(db, sessionId);
     *   if (recovered) {
     *     notificationService.info(`QIC: Recovered session from ${recovered.recoveredFrom} state`);
     *   }
     */
    static async recover(
        db: StatePersistenceManager,
        sessionId: string
    ): Promise<{ machine: PersistentAgentStateMachine; recoveredFrom: AgentState } | null> {
        const snapshot = await db.loadAgentState(sessionId);
        if (!snapshot) return null;

        const machine = new PersistentAgentStateMachine(db, sessionId);
        const recoveredFrom = snapshot.state as AgentState;

        // Resume from where we left off
        if (recoveredFrom === 'processing') {
            machine.state = 'idle'; // Reset to idle after crash during processing
        } else {
            machine.state = recoveredFrom;
        }

        await machine.persist();
        return { machine, recoveredFrom };
    }
}
```

### 2. PersistentTaskStateMachine (`src/vs/workbench/contrib/qic/common/state/taskStateMachine.ts`)

States: `pending → planning → executing → verifying → completed | failed`

**AUDIT FIX IV-AO9**: The `qic_task_state` table MUST include `failed_steps_json` column. Without it, crash recovery drops failed steps and the system retries previously-failed steps.

```sql
-- Task state table (AUDIT FIX IV-AO9: includes failed_steps_json)
CREATE TABLE IF NOT EXISTS qic_task_state (
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    current_state TEXT NOT NULL,
    completed_steps_json TEXT NOT NULL DEFAULT '[]',
    failed_steps_json TEXT NOT NULL DEFAULT '[]',  -- AUDIT FIX IV-AO9: ADDED
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, task_id)
);
```

```typescript
export type TaskState = 'pending' | 'planning' | 'executing' | 'verifying' | 'completed' | 'failed';

export class PersistentTaskStateMachine {
    completedSteps: string[] = [];
    failedSteps: string[] = [];      // AUDIT FIX S-5 / IV-AO9: Track failed steps

    // ... similar pattern to AgentStateMachine ...

    // AUDIT FIX IV-AO9: persist() must save both completedSteps AND failedSteps
    async persist(): Promise<void> {
        await this.db.run(
            `INSERT OR REPLACE INTO qic_task_state
             (session_id, task_id, current_state, completed_steps_json, failed_steps_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            this.sessionId, this.taskId, this.current,
            JSON.stringify(this.completedSteps),
            JSON.stringify(this.failedSteps),  // AUDIT FIX IV-AO9: ADDED
            Date.now()
        );
    }

    // AUDIT FIX IV-AO9: recover() must restore failedSteps from failed_steps_json
    static async recover(
        db: StatePersistenceManager,
        taskId: string
    ): Promise<{ machine: PersistentTaskStateMachine; recoveredFrom: TaskState } | null> {
        const snapshot = await db.loadTaskState(taskId);
        if (!snapshot) return null;

        const machine = new PersistentTaskStateMachine(/* ... */);
        machine.completedSteps = JSON.parse(snapshot.completedStepsJson || '[]');
        machine.failedSteps = JSON.parse(snapshot.failedStepsJson || '[]');  // AUDIT FIX S-5 / IV-AO9
        // ...
        return { machine, recoveredFrom: snapshot.state as TaskState };
    }
}
```

### 3. ConversationState (`src/vs/workbench/contrib/qic/common/state/conversationState.ts`)

Manages the conversation message history with persistence:

```typescript
export class ConversationState {
    private messages: Message[] = [];
    private lane: LaneName | null = null;

    addUserMessage(text: string): void;
    addAssistantMessage(content: ContentBlock[]): void;
    addToolResult(toolCallId: string, result: ToolResult): void;
    getMessages(): Message[];
    getLane(): LaneName | null;
    setLane(lane: LaneName): void;
    getTokenCount(): number;

    async persist(db: StatePersistenceManager, conversationId: string): Promise<void>;
    static async restore(db: StatePersistenceManager, conversationId: string): Promise<ConversationState | null>;
}
```

### 4. TimeoutManager (`src/vs/workbench/contrib/qic/common/timeout/timeoutManager.ts`)

Implements domain-separated timeouts per spec §2.5. **Critical**: The `USER_INTERACTION` domain has NO timeout (users can take as long as they want to approve edits).

```typescript
export type TimeoutDomain = 'llm_request' | 'tool_execution' | 'file_io' | 'network' | 'user_interaction';

export class TimeoutManager {
    private readonly defaults: Record<TimeoutDomain, number> = {
        'llm_request': 120_000,       // 2 minutes
        'tool_execution': 60_000,     // 1 minute
        'file_io': 30_000,            // 30 seconds
        'network': 30_000,            // 30 seconds
        'user_interaction': Infinity   // INV-A4: No timeout for user interactions!
    };

    /**
     * Execute an operation with a domain-specific timeout.
     * Returns the result or throws TimeoutError.
     */
    async withTimeout<T>(
        domain: TimeoutDomain,
        operation: (signal: AbortSignal) => Promise<T>,
        overrideMs?: number
    ): Promise<T>;
}
```

### 5. CancellationManager (`src/vs/workbench/contrib/qic/common/cancellation/cancellationManager.ts`)

Implements hierarchical cancellation per spec §3.3:

```typescript
export class CancellationManager {
    private readonly scopes = new Map<string, CancellationScope>();

    /**
     * Create a cancellation scope with optional parent.
     * Cancelling a parent cancels all children.
     */
    createScope(id: string, parentId?: string): CancellationScope;

    /**
     * Cancel a scope and all its children.
     */
    cancel(scopeId: string, reason: string): void;

    /**
     * Get the AbortSignal for a scope.
     */
    getSignal(scopeId: string): AbortSignal;

    /**
     * AUDIT FIX XII-AR9: Remove a scope after processing completes.
     * Without this, scopes accumulate in the Map and leak memory
     * after thousands of messages.
     */
    removeScope(scopeId: string): void;

    /**
     * AUDIT FIX XII-AR9: Convenience method that creates a scope, runs the
     * function, and automatically cleans up the scope on completion.
     */
    async executeWithScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
        const scope = this.createScope(scopeId);
        try {
            return await fn();
        } finally {
            this.removeScope(scopeId);  // Clean up after completion
        }
    }
}

export class CancellationScope {
    private readonly controller = new AbortController();
    private readonly children: CancellationScope[] = [];
    private readonly cleanupHooks: (() => Promise<void>)[] = [];

    get signal(): AbortSignal;
    addChild(child: CancellationScope): void;
    addCleanupHook(hook: () => Promise<void>): void;
    cancel(reason: string): void;
}
```

### 6. BM25 Schema (Audit Fix S-7) (`src/vs/workbench/contrib/qic/common/storage/bm25Schema.ts`)

Define the complete BM25 SQL schema:

```typescript
export const BM25_SCHEMA = `
-- Document metadata
CREATE TABLE IF NOT EXISTS qic_bm25_docs (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    last_indexed TEXT NOT NULL,
    UNIQUE(file_path)
);

-- Term frequency table
CREATE TABLE IF NOT EXISTS qic_bm25_terms (
    term_id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE,
    doc_frequency INTEGER NOT NULL DEFAULT 0  -- Number of docs containing this term
);

-- Posting list (term → document occurrences)
CREATE TABLE IF NOT EXISTS qic_bm25_postings (
    term_id INTEGER NOT NULL,
    doc_id INTEGER NOT NULL,
    term_frequency INTEGER NOT NULL,          -- Count of term in this doc
    positions TEXT,                             -- JSON array of positions (optional)
    PRIMARY KEY (term_id, doc_id),
    FOREIGN KEY (term_id) REFERENCES qic_bm25_terms(term_id),
    FOREIGN KEY (doc_id) REFERENCES qic_bm25_docs(doc_id)
);

-- AUDIT FIX I-SG11: FTS5 virtual table for full-text search
-- Uses porter stemming and unicode61 tokenizer for best results
CREATE VIRTUAL TABLE IF NOT EXISTS qic_bm25_fts5 USING fts5(
    content, path,
    content='qic_bm25_docs',
    content_rowid='doc_id',
    tokenize='porter unicode61'
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_qic_bm25_postings_doc ON qic_bm25_postings(doc_id);
CREATE INDEX IF NOT EXISTS idx_qic_bm25_docs_path ON qic_bm25_docs(file_path);
CREATE INDEX IF NOT EXISTS idx_qic_bm25_terms_term ON qic_bm25_terms(term);
CREATE INDEX IF NOT EXISTS idx_qic_bm25_docs_hash ON qic_bm25_docs(content_hash);
`;
```

### 7. Additional Storage Tables (AUDIT FIX VII-DS8) (`src/vs/workbench/contrib/qic/common/storage/storageSchema.ts`)

AUDIT FIX VII-DS8: Spec §5.1 (lines 3517-3535) defines `StorageArchitecture` with tables `permissions`, `sessions`, and `config`. Without the `permissions` table, "Allow for Session" permission grants reset on restart.

```typescript
export const ADDITIONAL_STORAGE_SCHEMA = `
-- AUDIT FIX VII-DS8: Permissions table
-- Persists permission grants so "Allow for Session" survives restart
CREATE TABLE IF NOT EXISTS qic_permissions (
    tool_name TEXT NOT NULL,
    scope TEXT NOT NULL,          -- 'once' | 'session' | 'always'
    granted_at INTEGER NOT NULL,
    expires_at INTEGER,
    session_id TEXT,
    PRIMARY KEY (tool_name, session_id)
);

-- AUDIT FIX VII-DS8: Sessions table
CREATE TABLE IF NOT EXISTS qic_sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT
);

-- AUDIT FIX VII-DS8: Config table
CREATE TABLE IF NOT EXISTS qic_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
`;
```

### 8. LanceDB Vector Storage Initialization — DEFERRED (REMEDIATION FIX 4d)

> **REMEDIATION FIX 4d**: VectorIndex is created in Prompt 09 (`context/vectorIndex.ts`) as the canonical implementation. Removed from Prompt 05 to avoid duplicate implementations. See Prompt 09 for the LanceDB initialization with `code_embeddings` and `doc_embeddings` tables.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/state/agentStateMachine.ts` | Agent FSM |
| `src/vs/workbench/contrib/qic/common/state/taskStateMachine.ts` | Task FSM |
| `src/vs/workbench/contrib/qic/common/state/conversationState.ts` | Conversation state |
| `src/vs/workbench/contrib/qic/common/timeout/timeoutManager.ts` | Domain-separated timeouts |
| `src/vs/workbench/contrib/qic/common/cancellation/cancellationManager.ts` | Hierarchical cancellation |
| `src/vs/workbench/contrib/qic/common/storage/bm25Schema.ts` | BM25 SQL schema (with FTS5) |
| `src/vs/workbench/contrib/qic/common/storage/storageSchema.ts` | Additional storage tables (VII-DS8) |
| ~~`src/vs/workbench/contrib/qic/common/storage/vectorIndex.ts`~~ | ~~LanceDB vector storage init~~ **DEFERRED TO PROMPT 09** (REMEDIATION FIX 4d): VectorIndex created in Prompt 09 as canonical implementation |
| `src/vs/workbench/contrib/qic/test/common/state/agentStateMachine.test.ts` | Agent FSM tests |
| `src/vs/workbench/contrib/qic/test/common/state/taskStateMachine.test.ts` | Task FSM tests |

---

## Acceptance Criteria

```
□ Agent FSM enforces valid state transitions (rejects invalid ones)
□ Agent FSM recover() does NOT reference UI (audit fix S-4 / IV-AO8)
□ Agent FSM sessionId is accessible via getter (audit fix X-PS8)
□ Agent FSM transition() wires state-transition timeouts (audit fix VII-DS2)
□ Task FSM persists and restores failedSteps via failed_steps_json (audit fix S-5 / IV-AO9)
□ qic_task_state table includes failed_steps_json column (audit fix IV-AO9)
□ State machines survive simulated process kill → recover
□ TimeoutManager enforces Infinity for user_interaction domain (INV-A4)
□ CancellationManager propagates cancel from parent to all children
□ CancellationManager.removeScope() cleans up completed scopes (audit fix XII-AR9)
□ CancellationManager.executeWithScope() auto-cleans on completion (audit fix XII-AR9)
□ Cleanup hooks execute when scopes are cancelled (INV-T5)
□ BM25 schema has proper column definitions and indexes (audit fix S-7)
□ BM25 schema includes FTS5 virtual table with porter unicode61 tokenizer (audit fix I-SG11)
□ qic_permissions, qic_sessions, qic_config tables created (audit fix VII-DS8)
□ ~~LanceDB vector storage initialized~~ **DEFERRED TO PROMPT 09** (REMEDIATION FIX 4d)
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

The following audit fix IDs from QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md have been incorporated into this prompt:

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **I-SG11** | HIGH | Added complete BM25 SQL DDL including FTS5 virtual table (`qic_bm25_fts5`) with `porter unicode61` tokenizer and additional indexes |
| **IV-AO8** | HIGH | Fixed `PersistentAgentStateMachine.recover()` -- removed UI dependency from static factory; returns machine and lets caller handle UI notification |
| **IV-AO9** | HIGH | Added `failed_steps_json` column to `qic_task_state` table DDL; updated `persist()` and `recover()` methods to save/restore failed steps |
| **VII-DS2** | HIGH | Added `STATE_TIMEOUTS` constant mapping state transitions to timeout values; wired timeout scheduling into `transition()` method with TimeoutManager |
| **VII-DS8** | MEDIUM | Added `qic_permissions`, `qic_sessions`, `qic_config` tables to storage schema in new `storageSchema.ts` |
| **VII-DS9** | MEDIUM | Added LanceDB vector storage initialization section specifying `vectors.lance` database with `code_embeddings` and `doc_embeddings` tables |
| **X-PS8** | MEDIUM | Changed `sessionId` from private to use private backing field with public getter, so Prompt 10's AgentOrchestrator can access it |
| **XII-AR9** | LOW | Added `removeScope(scopeId)` and `executeWithScope()` to CancellationManager for automatic scope cleanup after processing completes |
