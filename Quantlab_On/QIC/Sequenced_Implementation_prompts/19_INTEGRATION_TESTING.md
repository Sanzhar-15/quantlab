# Prompt 19 — Integration Testing & E2E Verification

**Phase**: 11 (Integration & Stabilisation)
**Prerequisites**: ALL previous prompts (00–18) complete
**Estimated Scope**: ~10 test files, ~2000 lines of tests

---

## Objective

Implement comprehensive integration tests, end-to-end scenarios, performance benchmarks, and the full Appendix C validation checklist. This is the quality gate before QIC can be considered production-ready.

---

## Spec References

- QIC Spec v6.2: §14.1 Test Strategy (lines 8016–8051)
- QIC Spec v6.2: §14.2 Schema Validation CI (lines 8051–8114)
- QIC Spec v6.2: Appendix C Validation Checklist (lines 8304–8465)
- Implementation Plan v3: Phase 11 (lines 1886–2016)

---

## Implementation Instructions

### 1. End-to-End Test Scenarios

Create tests for all 8 E2E scenarios from the implementation plan:

**`test/e2e/firstLaunch.test.ts`**:
```
Scenario: First launch
1. First-run consent → show consent UI
2. User grants consent → provider setup
3. Background indexing starts
4. First completion request → returns result
5. QIC status shows "Ready"
```

**`test/e2e/chatWorkflow.test.ts`**:
```
Scenario: Full chat workflow
1. User sends "Add a fibonacci function to utils.ts"
2. LaneRouter classifies as 'chat-act'
3. Orchestrator gathers context
4. LLM responds with tool calls (read_file, write_file)
5. Tool calls execute
6. LLM responds with tool results appended
7. Final response with diff preview
8. User approves → edits applied
```

**`test/e2e/crashRecovery.test.ts`**:
```
Scenario: Crash recovery
1. Start multi-file edit
2. Kill process mid-write
3. Restart QIC
4. JournaledAtomicWriter.recoverFromCrash() runs
5. Verify files are in consistent state (all-or-nothing)
6. User can continue where they left off
```

**`test/e2e/degradedMode.test.ts`**:
```
Scenario: Provider outage
1. Provider becomes unavailable
2. CircuitBreaker opens
3. DegradationManager escalates to LocalOnly
4. Local operations still work
5. Provider recovers
6. CircuitBreaker transitions to half-open → closed
7. DegradationManager restores Normal
```

**`test/e2e/largeWorkspace.test.ts`**:
```
Scenario: Large workspace (50K files)
1. Create workspace with 50K mock files
2. Index without OOM (memory < 500MB)
3. Search returns results in < 500ms
```

**`test/e2e/quantWorkflow.test.ts`**:
```
Scenario: Quant-specific workflow
1. Open Jupyter notebook
2. Preview large DataFrame (1GB parquet)
3. Time series analysis
4. Code edit with quant-aware suggestions
5. Backtest analysis with Sharpe ratio
```

**`test/e2e/security.test.ts`**:
```
Scenario: Security
1. Inject secrets into workspace code
2. Send code to LLM → verify secrets are redacted
3. Audit log records redaction event
4. Terminal guard blocks `rm -rf /`
5. Tool chain monitor detects read→exfiltrate sequence
```

**`test/e2e/concurrent.test.ts`**:
```
Scenario: Concurrent sessions
1. Send 3 chat messages rapidly
2. First processes, others queued
3. Request prioritization applies
4. No race conditions
```

### 1b. CI Test Suite Configuration

> **AUDIT FIX II-PG1 (HIGH)**: The implementation plan Phase 11 requires 7 specific CI test suites with npm scripts and timeouts. Add these to `package.json` scripts section:

```json
{
  "scripts": {
    "test:crash-recovery": "mocha test/e2e/crashRecovery.test.ts --timeout 600000",
    "test:large-files": "mocha test/e2e/largeWorkspace.test.ts --timeout 300000",
    "test:state-persistence": "mocha test/invariants/statePersistence.test.ts --timeout 120000",
    "test:journal-atomicity": "mocha test/invariants/journalAtomicity.test.ts --timeout 300000",
    "test:checkpoint-validity": "mocha test/invariants/checkpointValidity.test.ts --timeout 120000",
    "test:rate-limiting": "mocha test/e2e/rateLimiting.test.ts --timeout 120000",
    "test:stream-handling": "mocha test/e2e/streamHandling.test.ts --timeout 120000"
  }
}
```

Create the missing test files:
- `test/e2e/rateLimiting.test.ts`
- `test/e2e/streamHandling.test.ts`
- `test/invariants/statePersistence.test.ts`
- `test/invariants/journalAtomicity.test.ts`
- `test/invariants/checkpointValidity.test.ts`

### 1c. Load Test Scenarios

> **AUDIT FIX IV-AO2 (HIGH)**: The implementation plan defines SLOs for individual operations but has no load testing strategy for concurrent workloads.

**`test/performance/loadTests.test.ts`**:

```typescript
test('Completion latency under concurrent load', async () => {
    // Simulate: 50 concurrent completion requests
    // While: background indexing is running on 10K files
    // While: one chat session is active
    // Assert: completion P95 still < 1000ms (cloud standard tier)
});

test('Memory stability under sustained use', async () => {
    // Simulate: 1000 completion requests over 10 minutes
    // Plus: 50 chat interactions
    // Assert: memory never exceeds 500MB
    // Assert: no memory leaks (final RSS - initial RSS < 50MB)
});

test('Request prioritization under pressure', async () => {
    // Simulate: rate limit approaching (90% of quota)
    // Send: 10 completion requests + 5 chat requests simultaneously
    // Assert: completion requests are prioritized (40% quota share)
    // Assert: chat requests are not starved (50% quota share)
});
```

### 2. Appendix C Validation Checklist Script

Create a validation script that runs all 41 checks from Appendix C:

**`scripts/validate-appendix-c.ts`**:

```typescript
// Pre-Implementation Verification (10 checks)
check('All canonical types from single module', () => {
    // Verify canonical/index.ts exports all types
});
check('No boolean permission returns', () => {
    // Grep for 'check.*: boolean' in permission code
});
check('Every lane has LANE_CONFIGURATIONS entry', () => {
    // Verify 8 lanes × 8 entries
});
// ... all 10 checks

// Security Verification (9 checks)
check('Embedding consent flow', () => { /* ... */ });
// ... all 9 checks

// Architecture Verification (11 checks)
check('JournaledAtomicWriter crash recovery', () => { /* ... */ });
// ... all 11 checks

// Performance Verification (11 checks)
check('Degradation levels trigger correctly', () => { /* ... */ });
// ... all 11 checks
```

### 3. Schema Validation CI Script

Implement the CI script from spec §14.2:

**`scripts/validate-schema.sh`**:

```bash
#!/bin/bash
set -e
echo "=== QIC Schema Consistency Validation ==="

# 1. TypeScript strict compilation
npx tsc --noEmit --strict

# 2. No boolean permission returns
! grep -r "check.*: boolean" src/vs/workbench/contrib/qic/ --include="*.ts" | grep -v test | grep -v ".d.ts"

# 3. All lanes have prompt templates
npx ts-node scripts/validate-lane-prompts.ts

# 4. Tool registry completeness (22 tools)
npx ts-node scripts/validate-tool-registry.ts

# 5. BM25 table naming
! grep -rE "(?<!qic_)bm25_(terms|postings|docs|index)" src/vs/workbench/contrib/qic/ --include="*.ts"

# 6. No AtomicMultiFileWriter references
! grep -r "AtomicMultiFileWriter" src/vs/workbench/contrib/qic/ --include="*.ts" | grep -v test

# 7. FileContent types used
npx ts-node scripts/validate-file-content-types.ts

# 8. No [STUB] warnings in production code
! grep -r "\[STUB\]" src/vs/workbench/contrib/qic/ --include="*.ts" | grep -v test

# AUDIT FIX VIII-PC7: Anti-pattern CI checks
# Anti-pattern #2: No renameSync in production code
! grep -r "renameSync" src/vs/workbench/contrib/qic/ --include="*.ts" | grep -v test

# Anti-pattern #10: Circular dependency detection
npx madge --circular src/vs/workbench/contrib/qic/

echo "=== Schema validation passed ==="
```

### 4. Performance Benchmark Tests

**`test/performance/benchmarks.test.ts`**:

Test against SLO targets from spec §2.6:

```typescript
test('Completion latency (cloud standard) P95 < 1000ms', async () => { /* ... */ });
test('Chat TTFT P95 < 2000ms', async () => { /* ... */ });
test('Edit preview render P50 < 100ms', async () => { /* ... */ });
test('Flexible matching P50 < 20ms', async () => { /* ... */ });
test('Full repo index (10K files) P95 < 30000ms', async () => { /* ... */ });
test('Checkpoint create P50 < 100ms', async () => { /* ... */ });
test('Memory peak < 500MB', async () => { /* ... */ });
test('Journal write P95 < 10ms', async () => { /* ... */ });
```

### 5. Invariant Tests

**`test/invariants/invariants.test.ts`**:

Test all 11 invariants:

```typescript
test('INV-T1: MutationEngine.apply() requires ApprovalToken', () => { /* type check */ });
test('INV-T2: ToolRouter always logs via SecurityAuditLogger', () => { /* ... */ });
test('INV-T3: EgressBoundaryEnforcer redacts secrets before send', () => { /* ... */ });
test('INV-T4: Checkpoint validation with CV-1 through CV-5', () => { /* ... */ });
test('INV-T5: Cancellation propagates parent → children', () => { /* ... */ });
test('INV-T6a: Deterministic local operations', () => { /* ... */ });
test('INV-A1: All types from canonical/index.ts', () => { /* ... */ });
test('INV-A2: JournaledAtomicWriter atomicity', () => { /* ... */ });
test('INV-A3: Checkpoint crash safety', () => { /* ... */ });
test('INV-A4: TimeoutManager USER_INTERACTION has no timeout', () => { /* ... */ });
```

### 5b. Shared Test Utilities

> **AUDIT FIX X-PS9 (MEDIUM)**: No prompt creates shared test infrastructure. E2E tests need mock factories for Gateway, ToolRouter, FileService, etc.

**`test/helpers/testUtilities.ts`**:

```typescript
/**
 * Create a mock Gateway with configurable responses.
 */
export function createMockGateway(responses?: Map<string, string>): MockGateway;

/**
 * Create a ToolRouter with mock implementations for all 22 tools.
 */
export function createMockToolRouter(): ToolRouter;

/**
 * Create a temporary workspace with mock files.
 */
export function createTestWorkspace(fileCount: number): Promise<{ path: string; cleanup: () => Promise<void> }>;

/**
 * Create a MockProviderAdapter with canned responses.
 */
export function createMockProvider(): MockProviderAdapter;

/**
 * Heap snapshot comparison utility for memory leak detection.
 */
export function assertNoMemoryLeaks(fn: () => Promise<void>, toleranceMb?: number): Promise<void>;
```

### 5c. Error Code Completeness Tests

> **AUDIT FIX IV-AO12 (LOW)**: Add error code documentation verification tests.

**`test/invariants/errorCodes.test.ts`**:

```typescript
test('All error codes have user-facing messages', () => {
    for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
        // userMessage can be string | null per QicErrorTemplate
        // Codes with null userMessage use the error name as fallback (see QicError constructor)
        expect(entry.userMessage === null || entry.userMessage.length > 0).toBe(true);
        // Severity must match canonical QicErrorTemplate severity enum
        expect(entry.severity).toMatch(/^(info|warning|error)$/);
    }
});

test('All error codes have at least one test', () => {
    const testedCodes = new Set<string>();
    // Scan test files for error code references
    const testFiles = glob.sync('src/vs/workbench/contrib/qic/test/**/*.test.ts');
    for (const file of testFiles) {
        const content = fs.readFileSync(file, 'utf8');
        for (const code of Object.keys(ERROR_REGISTRY)) {
            if (content.includes(code)) testedCodes.add(code);
        }
    }
    const untestedCodes = Object.keys(ERROR_REGISTRY).filter(c => !testedCodes.has(c));
    expect(untestedCodes).toEqual([]);
});
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/test/e2e/firstLaunch.test.ts` | E2E: first launch |
| `src/vs/workbench/contrib/qic/test/e2e/chatWorkflow.test.ts` | E2E: chat flow |
| `src/vs/workbench/contrib/qic/test/e2e/crashRecovery.test.ts` | E2E: crash recovery |
| `src/vs/workbench/contrib/qic/test/e2e/degradedMode.test.ts` | E2E: degradation |
| `src/vs/workbench/contrib/qic/test/e2e/security.test.ts` | E2E: security |
| `src/vs/workbench/contrib/qic/test/e2e/rateLimiting.test.ts` | E2E: rate limiting (AUDIT FIX II-PG1) |
| `src/vs/workbench/contrib/qic/test/e2e/streamHandling.test.ts` | E2E: stream handling (AUDIT FIX II-PG1) |
| `src/vs/workbench/contrib/qic/test/performance/benchmarks.test.ts` | Performance SLOs |
| `src/vs/workbench/contrib/qic/test/performance/loadTests.test.ts` | Load tests (AUDIT FIX IV-AO2) |
| `src/vs/workbench/contrib/qic/test/invariants/invariants.test.ts` | All 11 invariants |
| `src/vs/workbench/contrib/qic/test/invariants/statePersistence.test.ts` | State persistence (AUDIT FIX II-PG1) |
| `src/vs/workbench/contrib/qic/test/invariants/journalAtomicity.test.ts` | Journal atomicity (AUDIT FIX II-PG1) |
| `src/vs/workbench/contrib/qic/test/invariants/checkpointValidity.test.ts` | Checkpoint validity (AUDIT FIX II-PG1) |
| `src/vs/workbench/contrib/qic/test/invariants/errorCodes.test.ts` | Error code completeness (AUDIT FIX IV-AO12) |
| `src/vs/workbench/contrib/qic/test/helpers/testUtilities.ts` | Shared test utilities (AUDIT FIX X-PS9) |
| `src/vs/workbench/contrib/qic/scripts/validate-appendix-c.ts` | 41-check validation |
| `src/vs/workbench/contrib/qic/scripts/validate-schema.sh` | CI schema validation |
| `src/vs/workbench/contrib/qic/scripts/validate-tool-registry.ts` | Tool completeness |
| `src/vs/workbench/contrib/qic/scripts/validate-lane-prompts.ts` | Lane prompt verification (AUDIT FIX VIII-PC2) |
| `src/vs/workbench/contrib/qic/scripts/validate-file-content-types.ts` | FileContent tier usage (AUDIT FIX VIII-PC2) |
| `src/vs/workbench/contrib/qic/scripts/validate-state-persistence.ts` | State tables exist (AUDIT FIX VIII-PC2) |
| `src/vs/workbench/contrib/qic/scripts/validate-model-registry.ts` | Model registry config (AUDIT FIX VIII-PC2) |

---

## Acceptance Criteria (Release Gate)

```
□ All 8 E2E scenarios pass
□ All 7 CI test suites pass with correct timeouts — audit fix II-PG1
□ Performance benchmarks meet spec SLOs
□ Load tests pass (50 concurrent completions, memory stability, prioritization) — audit fix IV-AO2
□ Appendix C validation checklist complete (all 41 checks)
□ All 11 invariants verified
□ All 4 CI validation scripts pass — audit fix VIII-PC2
□ Anti-pattern CI checks pass (no renameSync, no circular deps) — audit fix VIII-PC7
□ Error code completeness verified — audit fix IV-AO12
□ Unit test coverage > 80%
□ No critical or high severity bugs
□ Schema validation script passes (all CI checks)
□ No [STUB] warnings in production code
□ Zero TypeScript compilation errors
```

---

## Audit Fixes Applied

The following fixes from the deep audit (QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md) have been incorporated into this prompt:

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **II-PG1** | HIGH | Added CI test suite configuration with 7 npm scripts and timeouts. Created missing test files: `rateLimiting.test.ts`, `streamHandling.test.ts`, `statePersistence.test.ts`, `journalAtomicity.test.ts`, `checkpointValidity.test.ts`. |
| **VIII-PC2** | HIGH | Added 4 CI validation scripts to files-to-create: `validate-lane-prompts.ts`, `validate-file-content-types.ts`, `validate-state-persistence.ts`, `validate-model-registry.ts`. |
| **VIII-PC7** | MEDIUM | Added anti-pattern CI checks: grep for `renameSync`, circular dependency detection via `madge`. |
| **IV-AO2** | HIGH | Added load test scenarios: 50 concurrent completions while indexing, memory stability over 1000 requests, request prioritization under pressure. |
| **X-PS9** | MEDIUM | Added shared test utilities: `createMockGateway`, `createMockToolRouter`, `createTestWorkspace`, `createMockProvider`, `assertNoMemoryLeaks`. |
| **IV-AO12** | LOW | Added error code completeness tests: verify all error codes have user-facing messages and at least one test. |
