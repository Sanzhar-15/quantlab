# Prompt 07 — Mutation Engine, Conflict Detection & Error Recovery

**Phase**: 3 (Mutation & Reliability)
**Prerequisites**: Prompts 01 (JournaledAtomicWriter), 04 (canonical types), 06 (security)
**Estimated Scope**: ~7 files created, ~1000 lines

---

## Objective

Implement the mutation engine (applies EditScripts to files), conflict detector, FlexibleMatcher (7 strategies), crash-safe checkpoint manager, error recovery manager, and circuit breakers. This phase makes QIC reliable — edits are atomic, conflicts are detected, errors are recovered, and failing providers are circuit-broken.

---

## Spec References

- QIC Spec v6.2: §6.2 Conflict Detection (lines 4464–4588)
- QIC Spec v6.2: §6.3 Flexible Matching (lines 4588–4977) — 7 matching strategies
- QIC Spec v6.2: §3.4 Error Recovery (lines 2568–2798) — 4-tier classification
- QIC Spec v6.2: §9.1 Circuit Breaker (lines 5514–5597)
- QIC Spec v6.2: §5.4 Checkpoint Format (lines 3716–3990) — TransactionSafeCheckpointManager

---

## Implementation Instructions

### 1. MutationEngine (`src/vs/workbench/contrib/qic/common/mutation/mutationEngine.ts`)

The mutation engine applies EditScripts to files with preview-before-apply (INV-T1):

```typescript
export class MutationEngine {
    constructor(
        private readonly atomicWriter: JournaledAtomicWriter,
        private readonly conflictDetector: ConflictDetector,
        private readonly flexibleMatcher: FlexibleMatcher
    ) {}

    /**
     * Preview edits without applying. Generates diff for user review.
     * Returns a DiffPreview that can be shown to the user.
     */
    async preview(editScript: EditScript): Promise<DiffPreview>;

    /**
     * Apply edits. REQUIRES an ApprovalToken from user review (INV-T1).
     * Uses JournaledAtomicWriter for atomicity.
     */
    async apply(editScript: EditScript, approval: ApprovalToken): Promise<ApplyResult>;

    /**
     * Revert a previously applied edit using checkpoint.
     */
    async revert(checkpointId: string): Promise<void>;
}
```

### 2. ConflictDetector (`src/vs/workbench/contrib/qic/common/mutation/conflictDetector.ts`)

Detects if files have changed since the EditScript was generated:

```typescript
export class ConflictDetector {
    /**
     * Check if any files in the EditScript have been modified
     * since the edit was generated (based on content hash).
     */
    async detectConflicts(
        editScript: EditScript,
        originalHashes: Map<string, string>
    ): Promise<ConflictResult>;
}

export interface ConflictResult {
    hasConflicts: boolean;
    conflicts: FileConflict[];
}

export interface FileConflict {
    path: string;
    type: 'modified' | 'deleted' | 'created';
    originalHash: string;
    currentHash: string;
}
```

### 3. FlexibleMatcher (`src/vs/workbench/contrib/qic/common/mutation/flexibleMatcher.ts`)

7 graduated strategies for matching edit locations in modified files:

```typescript
export class FlexibleMatcher {
    /**
     * Try to find the edit location using graduated strategies.
     * Returns the best match or null if no strategy succeeds.
     */
    findMatch(
        editOp: EditOperation,
        originalContent: string,
        currentContent: string
    ): MatchResult | null;
}

// The 7 strategies, tried in order:
// 1. Exact match — content at specified range matches exactly
// 2. Line-shifted match — content matches but at a different line offset
// 3. Fuzzy line match — Levenshtein distance within threshold (similarity > 0.8)
// 4. AST-aware match — parse to AST, match by structure (function/class names)
// 5. Fuzzy edit distance — Levenshtein distance normalized by line count
// 6. Semantic context match — match by enclosing function/class scope
// 7. LLM instruction-based (last resort) — ask LLM to produce updated edit
```

**AUDIT FIX VII-DS15**: Detailed specifications for strategies 4-7:

**Strategy 4 -- AST-Aware**: Parse both old and new file content as AST nodes using `tree-sitter`. Match by AST node type + name even if surrounding code has changed. For example, find the function `calculateSharpe` by its AST node identity regardless of line number shifts. Requires tree-sitter language grammars for supported languages (TypeScript, Python, etc.).

**Strategy 5 -- Fuzzy Edit Distance**: Use Levenshtein distance normalized by line count. Accept the match if `editDistance / lineCount < 0.3` (configurable threshold). This handles minor refactors like variable renames or whitespace changes that make exact matching fail but preserve structural similarity.

**Strategy 6 -- Semantic Context**: Match by enclosing function/class scope. Find the enclosing scope (function, method, class) in the new file and compare the target lines within that scope. This handles cases where code has been moved within the same scope but the scope itself is identifiable.

**Strategy 7 -- LLM Instruction-Based (Last Resort)**: Send the original edit intent + new file content to the LLM and ask it to produce the updated edit. SLO: only invoke if strategies 1-6 all fail. Budget: max 2000 tokens. Timeout: 10 seconds. Use the `fast-apply` lane for this request. Log a warning when this strategy is triggered, as it has cost and latency implications.

### 4. ErrorRecoveryManager (`src/vs/workbench/contrib/qic/common/recovery/errorRecoveryManager.ts`)

4-tier error classification and recovery:

```typescript
export type ErrorTier = 'transient' | 'retriable' | 'degradable' | 'fatal';

export class ErrorRecoveryManager {
    /**
     * Classify an error and determine recovery strategy.
     */
    classify(error: Error): ErrorClassification;

    /**
     * Execute recovery action based on classification.
     */
    async executeRecovery(error: Error, context: RecoveryContext): Promise<RecoveryResult>;

    /**
     * Escalate to next tier if recovery fails.
     */
    async escalate(error: Error, failedTier: ErrorTier): Promise<RecoveryResult>;

    /**
     * Emergency save — persist all in-flight work before crash.
     */
    async emergencySave(): Promise<void>;
}

export interface ErrorClassification {
    tier: ErrorTier;
    retryable: boolean;
    maxRetries: number;
    backoffMs: number;
    degradedMode?: string;
}
```

### 5. CircuitBreaker (`src/vs/workbench/contrib/qic/common/recovery/circuitBreaker.ts`)

Per-provider circuit breaker.

**AUDIT FIX VII-DS10**: Track requests exceeding `slowCallThreshold` (5000ms). Open circuit if `slowCallRate > 0.5` in addition to failure rate:

```typescript
export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
    private state: CircuitState = 'closed';
    private failureCount = 0;
    private lastFailureTime = 0;
    private slowCalls: number[] = [];  // timestamps of slow calls

    constructor(
        private readonly config: {
            failureThreshold: number;        // Default: 5
            resetTimeoutMs: number;          // Default: 60000
            halfOpenMaxAttempts: number;     // Default: 1
            slowCallThreshold: number;       // Default: 5000 (ms)
            slowCallRateThreshold: number;   // Default: 0.5
        }
    ) {}

    /**
     * Execute an operation through the circuit breaker.
     * Throws CircuitOpenError if circuit is open.
     * Tracks slow calls in addition to failures.
     */
    async execute<T>(operation: () => Promise<T>): Promise<T> {
        // ... circuit state check ...
        const start = Date.now();
        try {
            const result = await operation();
            const duration = Date.now() - start;
            if (duration > this.config.slowCallThreshold) {
                this.slowCalls.push(Date.now());
            }
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    /**
     * Determine if circuit should open based on failure rate OR slow call rate.
     */
    private shouldOpen(): boolean {
        const recentSlowRate = this.getRecentSlowCallRate();
        const recentFailRate = this.getRecentFailureRate();
        return recentFailRate > (this.config.failureThreshold / 10)
            || recentSlowRate > this.config.slowCallRateThreshold;
    }

    private getRecentSlowCallRate(): number {
        const windowMs = 60_000;
        const now = Date.now();
        const recentSlow = this.slowCalls.filter(t => now - t < windowMs).length;
        // Rate = slow calls / total calls in window
        return this.totalCallsInWindow > 0 ? recentSlow / this.totalCallsInWindow : 0;
    }

    getState(): CircuitState;
    getFailureCount(): number;
    reset(): void;
}
```

### 6. TransactionSafeCheckpointManager (`src/vs/workbench/contrib/qic/common/crashSafe/checkpointManager.ts`)

Checkpoint creation and restoration using the JournaledAtomicWriter:

```typescript
export class TransactionSafeCheckpointManager {
    constructor(
        private readonly atomicWriter: JournaledAtomicWriter,
        private readonly validator: CheckpointValidator,
        private readonly secretScanner: OptimizedSecretScanner,  // REMEDIATION FIX 3b: VII-DS17
        private readonly checkpointDir: string
    ) {}

    /**
     * REMEDIATION FIX 3b / AUDIT FIX VII-DS17: Export checkpoint with secret redaction.
     * INV-T3 requires that secrets are redacted before any data leaves the system,
     * including checkpoint exports.
     */
    async exportCheckpoint(checkpointId: string): Promise<ExportedCheckpoint> {
        const checkpoint = await this.loadCheckpoint(checkpointId);
        // Redact secrets from all file contents before exporting
        for (const file of checkpoint.files) {
            const scanResult = this.secretScanner.scan(file.content);
            file.content = scanResult.redactedText;
        }
        return checkpoint;
    }

    async createCheckpoint(files: string[], metadata?: Record<string, unknown>): Promise<string>;
    async restoreCheckpoint(checkpointId: string): Promise<void>;
    async listCheckpoints(): Promise<CheckpointInfo[]>;
    async deleteCheckpoint(checkpointId: string): Promise<void>;
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/mutation/mutationEngine.ts` | Edit application |
| `src/vs/workbench/contrib/qic/common/mutation/conflictDetector.ts` | Conflict detection |
| `src/vs/workbench/contrib/qic/common/mutation/flexibleMatcher.ts` | 7 matching strategies |
| `src/vs/workbench/contrib/qic/common/recovery/errorRecoveryManager.ts` | Error recovery |
| `src/vs/workbench/contrib/qic/common/recovery/circuitBreaker.ts` | Circuit breaker |
| `src/vs/workbench/contrib/qic/common/crashSafe/checkpointManager.ts` | Checkpoint manager |
| `src/vs/workbench/contrib/qic/test/common/mutation/flexibleMatcher.test.ts` | Matcher tests |

---

## Acceptance Criteria

```
□ MutationEngine.apply() requires ApprovalToken (INV-T1 enforced by type system)
□ MutationEngine uses JournaledAtomicWriter (all edits are atomic)
□ ConflictDetector detects modified/deleted/created file conflicts
□ FlexibleMatcher implements all 7 strategies in graduated order
□ FlexibleMatcher correctly applies edits to files with line offset changes
□ ErrorRecoveryManager classifies errors into 4 tiers
□ ErrorRecoveryManager.emergencySave() persists in-flight work
□ CircuitBreaker transitions: closed → open after 5 failures, open → half-open after timeout
□ Checkpoint create + restore round-trip preserves all file contents
□ Checkpoints are validated with CV-1 through CV-5 on restore
□ FlexibleMatcher P50 < 20ms per matching operation (AUDIT FIX II-PG5)
□ CircuitBreaker opens on slow call rate > 0.5 (in addition to failure rate)
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **II-PG5** | MEDIUM | Added missing phase gate criterion: "FlexibleMatcher P50 < 20ms per matching operation" to acceptance criteria. |
| **VII-DS10** | MEDIUM | Added slow call tracking to CircuitBreaker. Track requests exceeding `slowCallThreshold` (5000ms). Open circuit if `slowCallRate > 0.5` in addition to failure rate. |
| **VII-DS15** | MEDIUM | Added detailed specifications for FlexibleMatcher strategies 4-7: Strategy 4 (AST-Aware via tree-sitter), Strategy 5 (Fuzzy Levenshtein with editDistance/lineCount < 0.3), Strategy 6 (Semantic Context by enclosing scope), Strategy 7 (LLM Last Resort with 2000 token budget and 10s timeout). |
| **VII-DS17** | MEDIUM | REMEDIATION FIX 3b: Added secret scanning at checkpoint export. Moved from Prompt 06 since `checkpointManager.ts` is created here. `secretScanner.redact()` applied in `exportCheckpoint()` method per INV-T3. |
