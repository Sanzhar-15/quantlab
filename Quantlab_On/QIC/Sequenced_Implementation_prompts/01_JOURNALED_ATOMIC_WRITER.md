# Prompt 01 — JournaledAtomicWriter & Crash-Safe Foundation

**Phase**: 0 (Pre-Implementation Crash Safety)
**Prerequisites**: Prompt 00 complete
**Estimated Scope**: ~5 files created, ~500 lines of implementation + tests

---

## Objective

Implement the `JournaledAtomicWriter` — a crash-safe transaction journal system that replaces simple atomic rename with a proper WAL (write-ahead log). This is the foundational crash-safety primitive that ALL subsequent file operations in QIC depend on.

**BLOCKING**: The spec mandates Phase 0 completion before any other phase begins. The JournaledAtomicWriter must pass crash-injection tests.

---

## Spec References

- QIC Spec v6.2: §6.1 JournaledAtomicWriter (lines 3990–4464) — Complete implementation spec
- QIC Spec v6.2: Appendix B Error Registry — Journal error codes QIC-J001 through QIC-J004

## Implementation Plan References

- Phase 0 (lines 330–427) — Scaffold + Crash-Safe
- Phase 0 gate criteria (lines 476–487)

## Audit Fixes Incorporated

- **C-3 (HIGH)**: Use `JournaledAtomicWriter` everywhere — never reference the stale `AtomicMultiFileWriter`.

---

## Implementation Instructions

### File: `src/vs/workbench/contrib/qic/common/crashSafe/journaledAtomicWriter.ts`

Implement the `JournaledAtomicWriter` class per spec §6.1. Key components:

#### 1. Transaction Journal Protocol

The protocol has 4 phases:
1. **Write journal** — Write all operations to a `.journal` file with checksums
2. **fsync journal** — Ensure journal is durably written
3. **Execute operations** — Perform the actual file writes
4. **Delete journal** — Clean up after success

#### 2. Journal File Format

```typescript
interface JournalEntry {
    version: 1;
    transactionId: string;      // UUID
    timestamp: string;           // ISO 8601
    operations: JournalOperation[];
    checksum: string;            // SHA-256 of operations
}

interface JournalOperation {
    type: 'write' | 'rename' | 'delete';
    targetPath: string;
    backupPath?: string;         // For rollback
    content?: string;            // For write operations
    contentChecksum?: string;    // SHA-256 of content
}
```

#### 3. Core API

```typescript
export class JournaledAtomicWriter {
    constructor(
        private readonly journalDir: string,    // Directory for journal files
        private readonly fileService: IFileService
    ) {}

    /**
     * Execute a batch of file operations atomically.
     * Either ALL operations succeed, or ALL are rolled back.
     */
    async writeAtomic(operations: FileOperation[]): Promise<void>;

    /**
     * Recover from a crash by replaying or rolling back any incomplete journals.
     * Called on extension activation (Phase 0 activation sequence).
     */
    static async recoverFromCrash(journalDir: string, fileService: IFileService): Promise<RecoveryResult>;

    /**
     * Check if there are any incomplete journals (crash detection).
     */
    static async hasIncompleteJournals(journalDir: string): Promise<boolean>;
}

interface FileOperation {
    type: 'write' | 'rename' | 'delete';
    path: string;
    content?: Uint8Array;
}

interface RecoveryResult {
    recovered: boolean;
    journalsProcessed: number;
    operationsRolledForward: number;
    operationsRolledBack: number;
    errors: string[];
}
```

#### 4. Recovery Logic

On `recoverFromCrash()`:
1. Scan `journalDir` for `.journal` files
2. For each journal file:
   a. Validate the checksum — if checksum fails, quarantine the journal (move to `.quarantine/`)
   b. Check completion status:
      - If ALL operations have corresponding completed files → **roll forward** (complete remaining)
      - If NONE have started → **delete journal** (nothing to recover)
      - If PARTIAL → **roll back** (restore from backups)
3. After recovery, delete processed journal files
4. Return `RecoveryResult` with statistics

#### 5. Error Handling

Use error codes from Appendix B:
- `QIC-J001`: JournalCorrupt — checksum mismatch, quarantine
- `QIC-J002`: JournalChecksumMismatch — data integrity failure
- `QIC-J003`: RollForwardFailed — couldn't complete interrupted operation
- `QIC-J004`: RollBackFailed — couldn't undo interrupted operation

#### 6. Platform Considerations

- Use `fs.fdatasync()` (not just `fs.fsync()`) for journal durability on Linux
- For Windows: use `MoveFileEx` semantics for atomic rename (write-new-then-delete-old fallback)
- Journal write latency target: < 10ms (P95)

### HDD Detection

Detect storage type at startup via a 4KB write benchmark. If fsync latency exceeds 20ms, warn the user and batch journal writes to amortize the cost.

Add the following method to `JournaledAtomicWriter`:

```typescript
/**
 * Detect whether the underlying storage is SSD or HDD.
 * Uses a 4KB write + fdatasync benchmark. If fsync latency > 20ms,
 * the storage is likely an HDD — batch journal writes and warn user.
 */
async detectStorageType(): Promise<'ssd' | 'hdd' | 'unknown'> {
    const testFile = path.join(this.journalDir, '.speed-test');
    try {
        const fd = await fs.open(testFile, 'w');
        const start = performance.now();
        await fd.write(Buffer.alloc(4096));
        await fd.datasync();
        const latency = performance.now() - start;
        await fd.close();
        await fs.unlink(testFile);

        if (latency > 20) {
            console.warn(`[QIC] Detected slow storage (${latency.toFixed(1)}ms fsync). ` +
                         'Batching journal writes for performance.');
            return 'hdd';
        }
        return 'ssd';
    } catch {
        return 'unknown';
    }
}
```

When HDD is detected:
- Batch multiple `writeAtomic()` calls within a configurable window (default: 50ms)
- Show a one-time notification: "QIC detected slow storage. Journal writes will be batched for better performance."
- Log the detected storage type to telemetry for diagnostics

### File: `src/vs/workbench/contrib/qic/common/crashSafe/types.ts`

Define the shared crash-safe types used across the system:

```typescript
export interface FileOperation {
    type: 'write' | 'rename' | 'delete';
    path: string;
    content?: Uint8Array;
}

export interface RecoveryResult {
    recovered: boolean;
    journalsProcessed: number;
    operationsRolledForward: number;
    operationsRolledBack: number;
    errors: string[];
}
```

### Test File: `src/vs/workbench/contrib/qic/test/common/crashSafe/journaledAtomicWriter.test.ts`

Write comprehensive tests:

1. **Happy path**: Write 3 files atomically → all files exist with correct content
2. **Crash during write**: Simulate crash after journal write but before file operations → recovery completes all operations
3. **Crash during partial execution**: Simulate crash after 1 of 3 operations → recovery either rolls forward or rolls back consistently
4. **Corrupt journal**: Write journal with bad checksum → recovery quarantines it
5. **Empty journal dir**: No journals → recovery is a no-op
6. **Multiple journals**: Two pending journals → both recovered in order
7. **Concurrent writes**: Two writers don't interfere (use unique transaction IDs)
8. **Performance**: Journal write completes in < 10ms for 10 file operations

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/crashSafe/journaledAtomicWriter.ts` | Main implementation |
| `src/vs/workbench/contrib/qic/common/crashSafe/types.ts` | Shared types |
| `src/vs/workbench/contrib/qic/test/common/crashSafe/journaledAtomicWriter.test.ts` | Tests |

---

## Acceptance Criteria (Phase 0 Gate - Partial)

```
□ JournaledAtomicWriter.writeAtomic() writes all files or none
□ JournaledAtomicWriter.recoverFromCrash() recovers from simulated crashes
□ Corrupt journals are quarantined (not deleted, not replayed)
□ Journal write latency < 10ms (P95) measured over 100+ runs as statistical p95
□ All error codes (QIC-J001 through QIC-J004) are used correctly
□ No references to AtomicMultiFileWriter anywhere in QIC code
□ detectStorageType() correctly identifies SSD vs HDD via 4KB write benchmark
□ HDD detection triggers batched journal writes and user warning
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Description |
|--------|----------|-------------|
| **II-PG5** | MEDIUM | Updated acceptance criteria to specify "measured over 100+ runs as statistical p95" for journal write latency, matching the implementation plan's gate criteria methodology |
| **VIII-PC9** | MEDIUM | Added HDD Detection section with `detectStorageType()` method using 4KB write benchmark, 20ms fsync threshold, batched journal writes for HDD, and user warning notification |
