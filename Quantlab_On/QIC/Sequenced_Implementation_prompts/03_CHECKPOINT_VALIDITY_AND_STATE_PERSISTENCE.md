# Prompt 03 — Checkpoint Validity Rules & State Persistence Tables

**Phase**: 0 (Pre-Implementation Crash Safety)
**Prerequisites**: Prompt 01 (JournaledAtomicWriter)
**Estimated Scope**: ~5 files created, ~600 lines

---

## Objective

Implement checkpoint validity rules (CV-1 through CV-5) and SQLite state persistence tables for agent, task, and conversation state. This ensures state machines survive process death and checkpoints are always valid.

---

## Spec References

- QIC Spec v6.2: §5.4 Checkpoint Format (lines 3716–3990) — Checkpoint validity rules CV-1 through CV-5
- QIC Spec v6.2: §3.2 State Machines (lines 2119–2444) — State persistence schemas
- QIC Spec v6.2: Appendix B — Storage error codes QIC-S001, QIC-S002

## Implementation Plan References

- Phase 0, tasks 2-3 (lines 376–378): Checkpoint validity + state persistence
- Phase 0 gate: "Corrupt checkpoint → verify quarantine", "Kill process → verify state recovery"

## Audit Fixes Incorporated

- **S-5 (HIGH)**: Add `failed_steps_json TEXT` column to `qic_task_state` schema (missing in spec).

---

## Clarification: Checkpoint-Git Relationship

QIC checkpoints are independent of git. They do NOT interact with git index, git stash, or git reflog. Checkpoints capture file state as encrypted snapshots for crash recovery within a single editing session, not version control. Users should commit their work to git as normal; QIC checkpoints provide crash recovery only. There is no need to coordinate checkpoint timing with git operations, and checkpoint files are excluded from git tracking via `.gitignore`.

---

## Implementation Instructions

### 1. Checkpoint Validity (`src/vs/workbench/contrib/qic/common/crashSafe/checkpointValidity.ts`)

Implement the 5 checkpoint validity rules:

```typescript
/**
 * Checkpoint validity rules — applied on every checkpoint read.
 * A checkpoint that fails any rule is quarantined, not deleted.
 */
export class CheckpointValidator {
    /**
     * Validate a checkpoint file against all 5 rules.
     * Returns validation result with specific failures.
     */
    validate(checkpointPath: string): Promise<CheckpointValidation>;

    /**
     * Quarantine an invalid checkpoint (move to .quarantine/ directory).
     */
    quarantine(checkpointPath: string, reason: string): Promise<void>;
}

interface CheckpointValidation {
    valid: boolean;
    failures: CheckpointFailure[];
}

interface CheckpointFailure {
    rule: 'CV-1' | 'CV-2' | 'CV-3' | 'CV-4' | 'CV-5';
    message: string;
}
```

#### The 5 Rules:

- **CV-1: Complete marker required** — A `.checkpoint` file MUST have a corresponding `.complete` marker file. If the marker is missing, the checkpoint was written during a crash and is incomplete.

- **CV-2: Checksum integrity** — The checkpoint file's content must match its embedded SHA-256 checksum. Detect bitrot or partial writes.

- **CV-3: Schema version compatibility** — The checkpoint's schema version must be compatible with the current QIC version. Reject checkpoints from incompatible future versions.

- **CV-4: Timestamp monotonicity** — A checkpoint's timestamp must be more recent than the one it replaces. Reject stale checkpoints that somehow reappear.

- **CV-5: Referential integrity** — All file paths referenced in the checkpoint must exist (or be explicitly marked as deleted). Detect checkpoints referencing files that have since been removed outside QIC.

### 2. State Persistence Tables (`src/vs/workbench/contrib/qic/common/storage/statePersistence.ts`)

Create the SQLite table schemas and CRUD operations for persisting state machine states:

```sql
-- Agent state persistence
CREATE TABLE IF NOT EXISTS qic_agent_state (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,           -- 'idle' | 'processing' | 'waiting_approval' | 'error' | 'suspended'
    current_task_id TEXT,
    conversation_json TEXT,        -- Serialized conversation history
    created_at TEXT NOT NULL,      -- ISO 8601
    updated_at TEXT NOT NULL,
    metadata_json TEXT             -- Arbitrary metadata
);

-- Task state persistence
CREATE TABLE IF NOT EXISTS qic_task_state (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL,           -- 'pending' | 'planning' | 'executing' | 'verifying' | 'completed' | 'failed'
    plan_json TEXT,                -- Serialized plan steps
    current_step INTEGER DEFAULT 0,
    completed_steps_json TEXT DEFAULT '[]',
    failed_steps_json TEXT DEFAULT '[]',   -- AUDIT FIX S-5: Added (missing from spec)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES qic_agent_state(session_id)
);

-- Conversation state persistence
CREATE TABLE IF NOT EXISTS qic_conversation_state (
    conversation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    messages_json TEXT NOT NULL,   -- Serialized message array
    lane TEXT,                     -- Current lane classification
    token_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES qic_agent_state(session_id)
);

-- Encrypted conversation storage (Audit Fix VII-DS7)
-- Stores conversation content encrypted with AES-256-GCM via ConversationCipher (Prompt 06)
CREATE TABLE IF NOT EXISTS conversations_encrypted (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    encrypted_content BLOB NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations_encrypted(session_id);

-- Permissions persistence (Audit Fix VII-DS8)
-- Stores tool permission grants so "Allow for Session" survives process restart
CREATE TABLE IF NOT EXISTS qic_permissions (
    tool_name TEXT NOT NULL,
    scope TEXT NOT NULL,           -- 'once' | 'session' | 'always'
    granted_at INTEGER NOT NULL,
    expires_at INTEGER,
    session_id TEXT,
    PRIMARY KEY (tool_name, session_id)
);

-- Session tracking (Audit Fix VII-DS8)
CREATE TABLE IF NOT EXISTS qic_sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT
);

-- Configuration key-value store (Audit Fix VII-DS8)
CREATE TABLE IF NOT EXISTS qic_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

#### State Persistence Manager

```typescript
export class StatePersistenceManager {
    constructor(private readonly db: DatabaseConnection) {}

    // Initialize tables
    async initialize(): Promise<void>;

    // Agent state CRUD
    async saveAgentState(sessionId: string, state: AgentStateSnapshot): Promise<void>;
    async loadAgentState(sessionId: string): Promise<AgentStateSnapshot | null>;
    async deleteAgentState(sessionId: string): Promise<void>;

    // Task state CRUD
    async saveTaskState(taskId: string, state: TaskStateSnapshot): Promise<void>;
    async loadTaskState(taskId: string): Promise<TaskStateSnapshot | null>;
    async loadTasksForSession(sessionId: string): Promise<TaskStateSnapshot[]>;
    async deleteTaskState(taskId: string): Promise<void>;

    // Conversation state CRUD
    async saveConversationState(conversationId: string, state: ConversationSnapshot): Promise<void>;
    async loadConversationState(conversationId: string): Promise<ConversationSnapshot | null>;

    // Recovery
    async getRecoverableSessions(): Promise<string[]>;
}
```

### 3. Database Connection Wrapper (`src/vs/workbench/contrib/qic/common/storage/database.ts`)

Create a thin wrapper around SQLite for QIC's storage needs:

```typescript
export class QicDatabase {
    private db: BetterSqlite3.Database | null = null;

    constructor(private readonly dbPath: string) {}

    async initialize(): Promise<void> {
        // Open the database
        this.db = new BetterSqlite3(this.dbPath);

        // Enable WAL mode for crash resilience and concurrent read performance (Audit Fix XII-AR1)
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('wal_autocheckpoint = 1000');

        // Create all tables (state persistence, encrypted conversations, permissions, sessions, config)
        await this.createTables();
    }

    async close(): Promise<void>;

    // Use VS Code's built-in SQLite or better-sqlite3
    run(sql: string, params?: any[]): void;
    get<T>(sql: string, params?: any[]): T | undefined;
    all<T>(sql: string, params?: any[]): T[];

    // Transaction support
    transaction<T>(fn: () => T): T;
}
```

**Note**: Use VS Code's existing SQLite infrastructure. Look at how `src/vs/workbench/services/storage/` handles SQLite — follow the same pattern.

> **REMEDIATION FIX 5d / AUDIT FIX IX-CC3**: SQLite library decision — `@vscode/sqlite3` (async) vs `better-sqlite3` (sync). If using `better-sqlite3` (as shown above with `db.pragma(...)` sync calls), you MUST run `npx electron-rebuild -m node_modules/better-sqlite3` to compile against Quantlab's Electron version. If using `@vscode/sqlite3` (async), change all sync-style `db.pragma(...)` calls to their async equivalents (e.g., `await db.run('PRAGMA journal_mode = WAL')`). The sync API shown in this prompt assumes `better-sqlite3`.

**WAL Mode Rationale** (Audit Fix XII-AR1): SQLite stores agent state, conversation state, BM25 index, consent records, and permissions. WAL mode provides:
- Better concurrent read performance (readers don't block writers)
- Improved crash resilience (WAL is more atomic than rollback journal)
- `synchronous = NORMAL` is sufficient with WAL mode (full sync only on checkpoint, not every commit)

### 4. Tests

**Checkpoint Validity Tests** (`test/common/crashSafe/checkpointValidity.test.ts`):
- Valid checkpoint passes all 5 rules
- Missing `.complete` marker → CV-1 failure
- Corrupted checksum → CV-2 failure
- Future schema version → CV-3 failure
- Older timestamp than existing → CV-4 failure
- References deleted file → CV-5 failure
- Invalid checkpoint is quarantined (moved, not deleted)
- Multiple failures are all reported

**State Persistence Tests** (`test/common/storage/statePersistence.test.ts`):
- Save and load agent state round-trip
- Save and load task state with failed_steps (audit fix S-5)
- Recover sessions after simulated crash
- Delete cascades correctly
- Empty database returns null/empty arrays

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/crashSafe/checkpointValidity.ts` | CV-1 through CV-5 validation |
| `src/vs/workbench/contrib/qic/common/storage/database.ts` | SQLite wrapper |
| `src/vs/workbench/contrib/qic/common/storage/statePersistence.ts` | State CRUD |
| `src/vs/workbench/contrib/qic/test/common/crashSafe/checkpointValidity.test.ts` | Checkpoint tests |
| `src/vs/workbench/contrib/qic/test/common/storage/statePersistence.test.ts` | Persistence tests |

---

## Acceptance Criteria

```
□ All 5 checkpoint validity rules (CV-1 through CV-5) implemented and tested
□ Invalid checkpoints are quarantined, not deleted
□ SQLite tables created: qic_agent_state, qic_task_state, qic_conversation_state
□ SQLite table created: conversations_encrypted (audit fix VII-DS7)
□ SQLite tables created: qic_permissions, qic_sessions, qic_config (audit fix VII-DS8)
□ qic_task_state includes failed_steps_json column (audit fix S-5)
□ Database initialized with WAL mode, synchronous=NORMAL (audit fix XII-AR1)
□ State persistence round-trip works for all 3 state types
□ Recovery correctly identifies recoverable sessions
□ Kill process → restart → state is recovered from SQLite
□ Checkpoints are independent of git (no git index/stash/reflog interaction)
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Description |
|--------|----------|-------------|
| **I-SG9** | LOW | Added "Checkpoint-Git Relationship" clarification section stating checkpoints are independent of git, capture encrypted snapshots for crash recovery only, and do not interact with git index/stash/reflog |
| **VII-DS7** | MEDIUM | Added `conversations_encrypted` SQL table with columns for encrypted content, IV, auth tag, session reference, message count, and metadata, plus session index |
| **VII-DS8** | MEDIUM | Added `qic_permissions` table (tool permission grants that survive restart), `qic_sessions` table (session tracking), and `qic_config` table (key-value configuration store) |
| **XII-AR1** | HIGH (partial) | Added WAL mode enablement (`journal_mode = WAL`, `synchronous = NORMAL`, `wal_autocheckpoint = 1000`) to database initialization for crash resilience and concurrent read performance |
