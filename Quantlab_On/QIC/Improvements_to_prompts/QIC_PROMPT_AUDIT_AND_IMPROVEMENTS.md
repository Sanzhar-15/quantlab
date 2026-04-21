# QIC Implementation Prompts — Deep Audit & Improvements

**Auditor**: Claude Opus 4.5
**Date**: 2026-02-01
**Scope**: 21 implementation prompts (00–20) audited against:
1. QIC Technical Specification v6.2 (8,465 lines)
2. QIC Implementation Plan v3 Final (2,274 lines)
3. QIC Deep Audit Report (28 findings)
4. Quantlab codebase (current state)

**Total Findings**: 47 initial + 82 deep-dive = **129 improvements** across 10 audit dimensions

---

## Table of Contents

- [I. Audit 1 — Spec Coverage Gaps](#i-audit-1--spec-coverage-gaps)
- [II. Audit 2 — Implementation Plan Coverage Gaps](#ii-audit-2--implementation-plan-coverage-gaps)
- [III. Audit 3 — Quantlab Integration Analysis](#iii-audit-3--quantlab-integration-analysis)
- [IV. Audit 4 — Additional Optimality Findings](#iv-audit-4--additional-optimality-findings)
- [V. Per-Prompt Improvement Matrix](#v-per-prompt-improvement-matrix)
- [VI. Priority-Ordered Action Items](#vi-priority-ordered-action-items)
- [VII. Audit 5 — Deep Spec Alignment Gaps](#vii-audit-5--deep-spec-alignment-gaps)
- [VIII. Audit 6 — Implementation Plan Completeness](#viii-audit-6--implementation-plan-completeness)
- [IX. Audit 7 — Quantlab Codebase Conflict Analysis](#ix-audit-7--quantlab-codebase-conflict-analysis)
- [X. Audit 8 — Prompt Sequencing & Type Safety](#x-audit-8--prompt-sequencing--type-safety)
- [XI. Audit 9 — Security Vulnerability Analysis](#xi-audit-9--security-vulnerability-analysis)
- [XII. Audit 10 — Architectural Risk Assessment](#xii-audit-10--architectural-risk-assessment)
- [XIII. Updated Priority Matrix](#xiii-updated-priority-matrix)

---

## I. Audit 1 — Spec Coverage Gaps

Cross-referencing every spec section (SS1.x through SS15.x, Appendix A–C) against the 21 prompts.

### I-SG1: `web_search` Tool Has No Implementation Specification [HIGH]

**Spec Reference**: Tool Registry (Appendix A, lines 8177–8233) lists `web_search` as one of the 22 tools.
**Prompt Coverage**: Prompt 15 implements all 22 tools, but `web_search` has no specification in the spec or implementation plan — no API provider, no result format, no consent/egress handling.
**Impact**: The LLM implementor will either skip the tool or hallucinate an implementation. This is one of only two network-facing tools (`web_fetch` being the other) and requires explicit egress boundary specification.

**Improvement for Prompt 15**:
```
Add a detailed implementation section for web_search:
- Provider: Specify Tavily/Brave/Google Custom Search as options
- Result format: { url, title, snippet, relevance_score }[]
- Egress boundary: egress-web-search (requires per-session consent)
- Secret redaction: Redact any secrets from search queries before sending
- Rate limiting: Separate from LLM rate limits
- Caching: Cache search results for 5 minutes
- Fallback: Return empty results with warning when no provider configured
```

### I-SG2: Model Version Management Specification Uses Stale Model IDs [HIGH]

**Spec Reference**: SS4.5 (lines 3273–3512) defines model aliases and capabilities.
**Prompt Coverage**: Prompt 08 references specific model IDs (`claude-3-5-sonnet-20241022`, `gpt-4o-mini`, etc.) that are likely deprecated as of February 2026.
**Impact**: Implementations targeting non-existent or deprecated model endpoints will fail at runtime.

**Improvement for Prompt 08**:
```
Replace all hard-coded model IDs with alias-based resolution:
- Use ModelRegistry aliases (claude-latest, gpt-latest, local-fast) as primary references
- Make concrete model IDs configurable, not hard-coded
- Implement header-based auto-discovery of provider capabilities
- Add a "model health check" that validates configured models on startup
- Default aliases should resolve to current-generation models at implementation time
```

### I-SG3: Context Assembler Missing Budgets for 5 of 8 Lanes [MEDIUM]

**Spec Reference**: SS4.3 (lines 3185–3228) defines budgets only for `completion` (4K), `chat` (32K), and `gather` (64K).
**Prompt Coverage**: Prompt 09 implements the Context Assembler with 8-lane budget configs from LANE_CONFIGURATIONS but relies on the spec's 3-budget specification. Five lanes (`chat-plan`, `chat-act`, `repair`, `fast-apply`, `summarize`) have no explicit context assembly rules.

**Improvement for Prompt 09**:
```
Add explicit context assembly profiles for all 8 lanes:
- chat-ask: Use 'chat' profile (32K total)
- chat-gather: Use 'gather' profile (64K total)
- chat-plan: Use 'gather' profile (64K total — planning needs broad context)
- chat-act: Use 'chat' profile (32K total — acting needs focused context)
- repair: Use 'chat' profile (32K total) with priority on error context
- fast-apply: Use minimal profile (8K total — only selected code + intent)
- summarize: Use 'chat' profile (32K total — needs full conversation history)
- completion: Use 'completion' profile (4K total)

Document the mapping rule: if a lane doesn't have an explicit budget profile,
specify which existing profile it maps to and why.
```

### I-SG4: `get_definition` Missing from `chat-gather` Allowed Tools [MEDIUM]

**Spec Reference**: LANE_CONFIGURATIONS (spec line ~2900) — `chat-gather` allows `get_references` but not `get_definition`.
**Prompt Coverage**: Prompt 04 copies this constraint from the spec.
**Impact**: A "gather" lane that can find references but can't jump to definitions is artificially limited.

**Improvement for Prompt 04**:
```
Add get_definition to chat-gather's allowedTools list:
  'chat-gather': {
    allowedTools: ['read_file', 'search_code', 'search_files', 'list_directory',
                   'get_references', 'get_definition'],  // ADDED
    ...
  }
```

### I-SG5: `summarize` Lane Is Underspecified [MEDIUM]

**Spec Reference**: The `summarize` lane appears in LANE_CONFIGURATIONS but has no trigger condition, no integration point, and no clear purpose specified.
**Prompt Coverage**: Prompt 04 defines the lane config; Prompt 10 mentions summarize as a lane but doesn't specify when the orchestrator invokes it.

**Improvement for Prompt 10**:
```
Add explicit summarize lane trigger and integration:
- Trigger: Automatically invoked when conversation token count exceeds 80% of
  the chat lane's conversationHistory budget (80% of 16K = 12,800 tokens)
- Purpose: Compress conversation history to free token budget for new context
- Integration: AgentOrchestrator checks conversation length before each
  handleUserMessage() call; if over threshold, invoke summarize lane first
- Output: Replace conversation messages with a single "summary" system message
- Constraint: Never summarize the last 3 user/assistant exchanges (keep recent context)
```

### I-SG6: `inspect_notebook` and `preview_dataframe` Incorrectly Marked as Side-Effect Tools [MEDIUM]

**Spec Reference**: Tool Registry marks both as `hasSideEffects: true`.
**Prompt Coverage**: Prompt 04 copies this from the spec; Prompt 15 implements them with permission requirements.
**Impact**: Read-only tools requiring user permission every time degrades UX significantly for quant workflows.

**Improvement for Prompts 04 and 15**:
```
Change tool definitions:
- inspect_notebook: hasSideEffects: false, permission: { required: false }
- preview_dataframe: hasSideEffects: false, permission: { required: false }
- analyze_backtest: Keep hasSideEffects: true (it writes analysis results)

These are read-only operations that should be freely invocable by the LLM
without requiring user approval each time.
```

### I-SG7: Completion and Fast-Apply Bypass Paths Unspecified [HIGH]

**Spec Reference**: The spec has no `AgentOrchestrator` section; the implementation plan states `completion` goes through CompletionEngine directly (not orchestrator) and `fast-apply` skips the plan phase. Neither bypass is specified anywhere.
**Prompt Coverage**: Prompt 10 defines the orchestrator but doesn't specify the bypass paths. Prompt 11 defines CompletionEngine but doesn't specify how it's invoked independently of the orchestrator.

**Improvement for Prompts 10 and 11**:
```
Prompt 10 — Add bypass routing logic to AgentOrchestrator.handleUserMessage():
  async handleUserMessage(message: string, sessionId: string): Promise<void> {
    const lane = this.laneRouter.classifyMessage(message, this.conversationState);

    // BYPASS 1: Completion lane routes directly to CompletionEngine
    if (lane === 'completion') {
      // CompletionEngine is NOT invoked through the orchestrator
      // It's triggered by the InlineCompletionProvider (Prompt 11)
      throw new Error('Completion lane should not reach orchestrator');
    }

    // BYPASS 2: Fast-apply skips planning, goes directly to edit
    if (lane === 'fast-apply') {
      return this.handleFastApply(message, sessionId);
    }

    // Normal flow: context assembly → LLM → tool loop
    ...
  }

Prompt 11 — Add explicit flow diagram for completion path:
  Keystroke → 150ms debounce → CompletionEngine.provideCompletions()
  → Context assembly (prefix/suffix/imports/types, 4K budget)
  → Tier selection (waterfall: local GPU → local CPU → cache → cloud)
  → FIM or instruction-based prompt construction
  → Provider request (bypasses orchestrator entirely)
  → Ghost text display
```

### I-SG8: RRF Reranker Formula Description Omits Weights [LOW]

**Spec Reference**: SS8.3 (lines 5325–5384) describes formula as `sum of 1/(k + rank_i)` but code applies weights.
**Prompt Coverage**: Prompt 09 copies the description but implements weights correctly.

**Improvement for Prompt 09**:
```
Update the formula description to match implementation:
  score(doc) = SUM weight_i / (k + rank_i) for each source
  where weights are: BM25=0.4, vector=0.4, recency=0.1, file-proximity=0.1
```

### I-SG9: No Specification for Checkpoint-Git Relationship [LOW]

**Spec Reference**: The checkpoint system (SS6.x) never addresses how checkpoints relate to git.
**Prompt Coverage**: Prompt 03 implements checkpoints without addressing git interaction.

**Improvement for Prompt 03**:
```
Add a brief clarification section:
  "QIC checkpoints are independent of git and operate at the file-content level.
   They do NOT interact with git index, git stash, or git reflog.
   Checkpoints capture file state as encrypted snapshots; git captures version history.
   Users should commit their work to git as normal; QIC checkpoints provide
   crash recovery within a single editing session, not version control."
```

### I-SG10: Conversation Cipher Uses Two Different Crypto APIs [HIGH]

**Spec Reference**: SS10.1 (lines ~6400) mixes `crypto.randomBytes(12)` (Node.js) and `crypto.subtle` (Web Crypto API).
**Prompt Coverage**: Prompt 06 implements ConversationCipher but doesn't clarify which API to use.
**Impact**: VS Code extension host is Node.js — `crypto.subtle` would fail.

**Improvement for Prompt 06**:
```
Explicitly specify: Use node:crypto for ALL crypto operations in the extension host.
  import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

  // AES-256-GCM encryption (Node.js crypto, NOT Web Crypto API)
  encrypt(data: string, key: Buffer): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv, encrypted, authTag };
  }

Reserve crypto.subtle ONLY for webview-side operations (if any).
```

### I-SG11: BM25 Index Schema Not Fully Specified [HIGH]

**Spec Reference**: Spec references BM25 tables with `qic_bm25_` prefix but doesn't provide complete SQL DDL.
**Prompt Coverage**: Prompt 05 creates the BM25 schema but relies on the spec for column definitions.

**Improvement for Prompt 05**:
```
Add explicit complete SQL DDL for BM25 tables:

  CREATE TABLE qic_bm25_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE,
    idf REAL NOT NULL DEFAULT 0.0,
    doc_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE qic_bm25_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    avg_word_length REAL NOT NULL,
    indexed_at INTEGER NOT NULL,
    provider TEXT,
    embedding_dimensions INTEGER
  );

  CREATE TABLE qic_bm25_postings (
    term_id INTEGER NOT NULL REFERENCES qic_bm25_terms(id),
    doc_id INTEGER NOT NULL REFERENCES qic_bm25_docs(id),
    tf REAL NOT NULL,
    positions TEXT,  -- JSON array of positions
    PRIMARY KEY (term_id, doc_id)
  );

  CREATE VIRTUAL TABLE qic_bm25_fts5 USING fts5(
    path, content,
    tokenize='porter unicode61'
  );

  -- Indexes for performance
  CREATE INDEX idx_bm25_terms_term ON qic_bm25_terms(term);
  CREATE INDEX idx_bm25_docs_hash ON qic_bm25_docs(content_hash);
  CREATE INDEX idx_bm25_postings_doc ON qic_bm25_postings(doc_id);
```

---

## II. Audit 2 — Implementation Plan Coverage Gaps

Cross-referencing the 12-phase plan deliverables, gate criteria, and the spec-to-implementation matrix against the 21 prompts.

### II-PG1: Phase 11 Gate Requires 7 CI Test Suites — Only Partially Specified [HIGH]

**Plan Reference**: Phase 11 (lines 1886–2016) requires these CI gates:
```
npm run test:crash-recovery       (600s timeout)
npm run test:large-files           (300s timeout)
npm run test:state-persistence     (120s timeout)
npm run test:journal-atomicity     (300s timeout)
npm run test:checkpoint-validity   (120s timeout)
npm run test:rate-limiting         (120s timeout)
npm run test:stream-handling       (120s timeout)
```
**Prompt Coverage**: Prompt 19 specifies E2E scenarios, invariant tests, performance benchmarks, and Appendix C validation. It does NOT specify these 7 specific CI test suites with their npm script names and timeouts.

**Improvement for Prompt 19**:
```
Add a section "CI Test Suite Configuration":

Each test suite must be runnable via npm script with the specified timeout.
Add to package.json scripts section:

  "test:crash-recovery": "mocha test/e2e/crashRecovery.test.ts --timeout 600000",
  "test:large-files": "mocha test/e2e/largeWorkspace.test.ts --timeout 300000",
  "test:state-persistence": "mocha test/invariants/statePersistence.test.ts --timeout 120000",
  "test:journal-atomicity": "mocha test/invariants/journalAtomicity.test.ts --timeout 300000",
  "test:checkpoint-validity": "mocha test/invariants/checkpointValidity.test.ts --timeout 120000",
  "test:rate-limiting": "mocha test/e2e/rateLimiting.test.ts --timeout 120000",
  "test:stream-handling": "mocha test/e2e/streamHandling.test.ts --timeout 120000"

Create the missing test files:
- test/e2e/rateLimiting.test.ts
- test/e2e/streamHandling.test.ts
- test/invariants/statePersistence.test.ts
- test/invariants/journalAtomicity.test.ts
- test/invariants/checkpointValidity.test.ts
```

### II-PG2: Mock Provider for Testing Not Specified in Any Prompt [MEDIUM]

**Plan Reference**: Section 11 (Development Workflow, lines ~2200) defines a `MockProviderAdapter` for testing without API keys.
**Prompt Coverage**: No prompt creates or references the mock provider.

**Improvement for Prompt 08**:
```
Add a MockProviderAdapter alongside the real adapters:

  export class MockProviderAdapter implements ProviderAdapter {
    id = 'mock';
    name = 'Mock Provider';
    type = 'llm' as const;
    private responses: Map<string, string> = new Map();

    async isAvailable(): Promise<boolean> { return true; }
    async getHealth(): Promise<ProviderHealth> {
      return { status: 'healthy', latencyMs: 10, errorRate: 0, lastChecked: new Date().toISOString() };
    }
    async sendRequest<T>(request: ProviderRequest): Promise<T> {
      // Return canned responses for testing
      const key = request.messages?.[request.messages.length - 1]?.content ?? '';
      const response = this.responses.get(key) ?? 'Mock response for: ' + key;
      return { content: [{ type: 'text', text: response }] } as T;
    }
    cancelRequest(): void {}

    // Test helper: pre-configure responses
    setResponse(input: string, output: string): void {
      this.responses.set(input, output);
    }
  }

This enables all subsequent prompts (09-20) to test their components
without requiring real API keys.
```

### II-PG3: Stub Interface Contracts Missing `[STUB]` Warning Pattern [MEDIUM]

**Plan Reference**: Section 8 (Stub Interface Contracts, lines ~2050) defines exact stub signatures with `[STUB]` console.warn markers and a CI check that greps for them.
**Prompt Coverage**: Prompt 10 mentions stubs for UIService and security components but doesn't enforce the `[STUB]` warning pattern consistently across all stubs.

**Improvement for Prompt 10**:
```
Enforce consistent stub pattern for ALL stubs in Prompt 10:

Every stub method MUST include:
  console.warn('[STUB] ClassName.methodName — Phase N will replace this');

Stubs created in Prompt 10 that need this pattern:
- UIService.showPermissionDialog → '[STUB] UIService.showPermissionDialog — Prompt 13'
- UIService.showDiffPreview → '[STUB] UIService.showDiffPreview — Prompt 13'
- UIService.streamChatToken → '[STUB] UIService.streamChatToken — Prompt 12'
- TerminalSecurityGuard.validateCommand → '[STUB] TerminalSecurityGuard — Prompt 14'
- ToolChainMonitor.recordToolCall → '[STUB] ToolChainMonitor — Prompt 14'
- SecurityAuditLogger.* → '[STUB] SecurityAuditLogger — Prompt 14'

Additionally add this CI check to Prompt 19:
  // Zero-STUB verification (must pass after all prompts are implemented)
  test('[STUB] count is zero in production code', () => {
    const output = execSync(
      'grep -r "\\[STUB\\]" src/vs/workbench/contrib/qic/ --include="*.ts" | grep -v test | grep -v ".d.ts"'
    ).toString();
    expect(output.trim()).toBe('');
  });
```

### II-PG4: Anti-Patterns Section Not Referenced in Prompts [LOW]

**Plan Reference**: Section 7 (Anti-Patterns, lines ~1980) lists 5 critical anti-patterns to avoid.
**Prompt Coverage**: Individual prompts address specific anti-patterns (e.g., Prompt 10 fixes the agentic loop), but the anti-patterns list is never referenced as a cross-cutting checklist.

**Improvement — Add to all prompts' "Codebase Context" section**:
```
Add a standard footer to every prompt:

  ## Anti-Pattern Checklist (verify before marking complete)
  □ No for-await over a single response stream for tool calls (use explicit while-loop)
  □ No boolean returns from PermissionManager (use PermissionCheckResult)
  □ No inline crypto — use the designated crypto module
  □ No AtomicMultiFileWriter references — use JournaledAtomicWriter
  □ All BM25 tables use qic_bm25_ prefix
  □ All FileContent usage respects size tiers (inline < 1MB, stream 1-50MB, etc.)
```

### II-PG5: Phase Gate Tests Not Specified Per-Prompt [MEDIUM]

**Plan Reference**: Each implementation plan phase has explicit gate criteria.
**Prompt Coverage**: Each prompt has "Acceptance Criteria" but these don't map 1:1 to the plan's gate criteria. Some gate criteria are missing from prompts.

**Missing gate criteria by prompt**:
- **Prompt 01**: Missing "journal write latency < 10ms" SLO test
- **Prompt 05**: Missing "incremental file index SLO < 500ms" test
- **Prompt 07**: Missing "FlexibleMatcher P50 < 20ms" performance test
- **Prompt 08**: Missing "streaming handler processes tool calls correctly" test
- **Prompt 09**: Missing "DynamicToolSelector stays within 2000 token budget" test
- **Prompt 11**: Missing "Claude rejected for completion lane (no FIM support)" validation

**Improvement**: Add missing gate criteria to each affected prompt's acceptance checklist.

### II-PG6: No Rollback Strategy Per Phase [MEDIUM]

**Plan Reference**: The plan defines gate criteria but no rollback strategy if a gate fails.
**Prompt Coverage**: No prompt addresses what to do if its acceptance criteria fail.

**Improvement — Add to Prompt 19**:
```
Add a "Phase Rollback Procedures" section:

If integration testing reveals a phase-level failure:
1. Identify the failing component(s) via test output
2. Check if the failure is in the component itself or a dependency
3. If in a dependency: fix the dependency prompt's output first
4. If in the component: revert to the prompt's initial state and re-implement
5. After fixing: re-run ALL tests from the failing phase forward
   (not just the fixed component's tests)

Do NOT cherry-pick fixes — always re-run the full phase gate after any change.
```

---

## III. Audit 3 — Quantlab Integration Analysis

This is the most critical audit dimension. The prompts build QIC as a standalone workbench contribution but don't account for Quantlab's existing infrastructure.

### III-QI1: CRITICAL — Existing AI Module Overlap [CRITICAL]

**Quantlab Current State**: `extensions/quantlab/src/ai/` contains:
- `provider.ts` — `ClaudeProvider` class with streaming, content_block_delta handling
- `consent.ts` — Data consent tracking with categories (strategy_code, error_messages, etc.)
- `sanitize.ts` — Pattern-based sensitive data redaction
- `audit.ts` — Per-request audit logging with metrics
- `context.ts` — Context building for AI requests
- `types.ts` — AI/LLM type definitions

**QIC Plans**: Prompts 06, 08, 10, 14 build entirely new:
- `EgressBoundaryEnforcer` + `ConsentStore` (Prompt 06)
- `Gateway` + `ProviderAdapters` (Prompt 08)
- `SecurityAuditLogger` (Prompt 14)

**Impact**: Building a parallel AI infrastructure creates:
- Duplicate consent systems (extension's `consent.ts` vs QIC's `ConsentStore`)
- Duplicate sanitization (extension's `sanitize.ts` vs QIC's `SecretScanner`)
- Duplicate audit logging (extension's `audit.ts` vs QIC's `SecurityAuditLogger`)
- Duplicate provider management (extension's `ClaudeProvider` vs QIC's `Gateway`)
- User confusion: two different consent dialogs, two different sets of preferences

**Improvement for Prompts 00, 06, 08, 14**:
```
OPTION A (Recommended): Integrate QIC with existing AI infrastructure

Prompt 00 — Add investigation step:
  "Before scaffolding QIC, read and analyze the existing AI module at
   extensions/quantlab/src/ai/ (provider.ts, consent.ts, sanitize.ts, audit.ts).
   Document what can be reused vs what QIC needs to extend."

Prompt 06 — Integrate with existing consent:
  "QIC's ConsentStore should EXTEND the existing consent system at
   extensions/quantlab/src/ai/consent.ts, adding QIC-specific categories
   (consent:llm:chat, consent:llm:completion, consent:embedding, consent:web,
   consent:telemetry) alongside existing Quantlab categories
   (strategy_code, error_messages, data_samples, performance_metrics).

   Create an adapter layer that bridges the extension-side consent
   (extensions/quantlab/src/ai/consent.ts) with the workbench-side
   ConsentStore (src/vs/workbench/contrib/qic/), using a shared
   IConsentService interface."

Prompt 06 — Integrate with existing sanitization:
  "QIC's OptimizedSecretScanner should EXTEND the existing sanitization
   pipeline at extensions/quantlab/src/ai/sanitize.ts. The existing patterns
   should be imported and merged with QIC's 60+ patterns."

Prompt 08 — Integrate with existing provider:
  "QIC's AnthropicAdapter should reuse connection configuration from the
   existing ClaudeProvider at extensions/quantlab/src/ai/provider.ts.
   API keys should come from the same source (VS Code SecretStorage)."

Prompt 14 — Integrate with existing audit:
  "QIC's SecurityAuditLogger should complement (not replace) the existing
   audit system at extensions/quantlab/src/ai/audit.ts. Define a clear
   boundary: extension audit handles trading-related AI requests;
   QIC audit handles coding-assistant AI requests."

OPTION B (Alternative): Full separation with migration plan
  "Build QIC independently as specified, but add a migration plan in
   Prompt 20 to consolidate the existing extension AI module into QIC's
   more comprehensive infrastructure. Document the consolidation steps."
```

### III-QI2: CRITICAL — Python Sidecar Duplicates Existing Python Engine [CRITICAL]

**Quantlab Current State**: `engine/quantlab/daemon/main.py` is an existing Python daemon process that:
- Communicates via JSON-RPC over stdio
- Has data services, backtest engine, trading engine, risk management
- Has an IPC layer at `extensions/quantlab/src/core/ipc/` with full JSON-RPC types
- Already handles pandas DataFrames, parquet files, and Arrow format
- Has existing `audit/ledger.py` (SHA-256 tamper-evident logging)

**QIC Plans**: Prompt 16 creates a new Python sidecar (`python/qic_sidecar/`) with:
- JSON-RPC over stdio (same protocol)
- DataFrame preview, statistical tests, backtest analysis
- Arrow IPC for data transfer

**Impact**: Two separate Python processes doing overlapping work:
- Both handle DataFrames and parquet
- Both use JSON-RPC over stdio
- Both need numpy/pandas/pyarrow
- Users would have two Python processes running simultaneously
- Memory duplication from loading the same libraries twice

**Improvement for Prompt 16**:
```
OPTION A (Recommended): Extend existing Python engine

Prompt 16 — Reuse existing infrastructure:
  "QIC's quant features should communicate with the EXISTING Python engine
   daemon at engine/quantlab/daemon/main.py instead of spawning a new
   Python sidecar process.

   Add QIC-specific JSON-RPC methods to the existing daemon:
   - qic.analyze_time_series(data, freq?) → frequency, stationarity, outliers
   - qic.detect_frequency(timestamps) → detected frequency
   - qic.statistical_test(data, test_name) → p-value, statistic
   - qic.analyze_backtest(returns, benchmark?) → Sharpe, Sortino, max drawdown
   - qic.preview_dataframe(path, options) → safe preview data

   On the TypeScript side, create a QicPythonBridge that routes requests
   through the existing IPC layer at extensions/quantlab/src/core/ipc/:

   class QicPythonBridge {
     constructor(private readonly ipcClient: IpcClient) {}

     async analyzeTimeSeries(data: ArrowBuffer): Promise<TimeSeriesAnalysis> {
       return this.ipcClient.request('qic.analyze_time_series', { data });
     }
   }

   If the engine daemon is not running (e.g., no trading session active),
   QicPythonBridge should start it on demand and manage idle timeout.

   Reuse the existing ArrowDataFrameBridge pattern from the engine's
   debug/mmap reader for zero-copy data transfer."

OPTION B (Alternative): Separate sidecar with shared libraries
  "If the engine daemon should not be modified, create the sidecar but
   ensure it shares the same virtual environment and dependencies as the
   engine. Use qic.pythonPath to point to the engine's Python environment.
   Document the relationship between the two Python processes."
```

### III-QI3: HIGH — Existing IPC Protocol Should Be Reused [HIGH]

**Quantlab Current State**: `extensions/quantlab/src/core/ipc/types.ts` defines a complete JSON-RPC protocol with:
- `JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcSuccessResponse`, `JsonRpcErrorResponse`
- `ConnectionState` management
- `RetryConfig` and `BufferConfig`
- `MessageTier` priority levels ('critical' | 'important' | 'telemetry')
- Error codes (`PARSE_ERROR`, `METHOD_NOT_FOUND`, `INTERNAL_ERROR`, etc.)

**QIC Plans**: Prompt 16 defines a new JSON-RPC implementation for the Python sidecar.

**Improvement for Prompt 16**:
```
Import and reuse the existing IPC types:
  import { JsonRpcRequest, JsonRpcResponse, JsonRpcErrorCodes, RetryConfig }
    from '../../../../extensions/quantlab/src/core/ipc/types';

  // OR: If workbench code can't import from extensions, create a shared
  // IPC types module at src/vs/platform/qic/common/ipcTypes.ts that
  // mirrors the extension's types (maintaining compatibility).
```

### III-QI4: HIGH — Existing Trust System Should Integrate with QIC's Permission Model [HIGH]

**Quantlab Current State**: `extensions/quantlab/src/core/trust/` implements workspace trust verification. Strategy files must pass hash verification before live trading (Decision C1).

**QIC Plans**: Prompt 10 builds a standalone PermissionManager for tool execution permissions.

**Impact**: QIC could modify strategy files without going through the trust verification pipeline. A write_file tool call that modifies a trading strategy wouldn't trigger re-verification.

**Improvement for Prompt 10 and Prompt 15**:
```
Prompt 10 — Add trust-awareness to PermissionManager:
  "When a tool call targets a file within a recognized strategy directory
   (detected by the presence of strategy markers or file patterns),
   PermissionManager should escalate to 'once' permission level regardless
   of the tool's default permission level. This ensures every strategy
   modification requires explicit user approval."

Prompt 15 — Add trust hook to write_file implementation:
  "After write_file completes, if the modified file is part of a validated
   strategy (check via workspace trust service), invalidate the strategy's
   trust hash. Log a warning that the strategy will require re-validation
   before live trading."
```

### III-QI5: HIGH — Existing Secrets Management Should Be Unified [HIGH]

**Quantlab Current State**:
- Python side: `engine/quantlab/secrets/encrypted.py` uses Argon2 + AES encryption
- TypeScript side: VS Code SecretStorage API for broker credentials
- Extension: `extensions/quantlab/src/ai/sanitize.ts` for data redaction

**QIC Plans**: Prompt 06 builds new `ConversationCipher` (AES-256-GCM with PBKDF2) and `OptimizedSecretScanner` (60+ patterns).

**Improvement for Prompt 06**:
```
Unify secret management:
1. QIC's ConversationCipher should use VS Code SecretStorage API for key management
   (same as existing Quantlab extension's approach for broker credentials)

2. QIC's OptimizedSecretScanner should import and extend existing sanitization
   patterns from extensions/quantlab/src/ai/sanitize.ts. Create a shared
   pattern registry that both systems contribute to.

3. Add Quantlab-specific secret patterns to the scanner:
   - Alpaca API key/secret patterns (the existing broker integration)
   - Strategy-specific tokens or credentials
   - Data provider API keys (market data services)
```

### III-QI6: HIGH — Existing Audit System Should Be Unified [HIGH]

**Quantlab Current State**:
- Python: `engine/quantlab/audit/ledger.py` — SHA-256 tamper-evident audit trail (Decision N87)
- TypeScript: `extensions/quantlab/src/ai/audit.ts` — Per-request AI audit logging

**QIC Plans**: Prompt 14 builds a new `SecurityAuditLogger` with hash-chained entries.

**Impact**: Three separate audit systems logging to different locations with different formats.

**Improvement for Prompt 14**:
```
Consolidate audit approach:
1. QIC's SecurityAuditLogger should share the same hash-chain algorithm
   (SHA-256) as the existing engine audit ledger for consistency

2. Define clear audit boundaries:
   - Engine audit: Trading decisions, order executions, risk alerts
   - Extension AI audit: Strategy analysis requests, data consent
   - QIC audit: Tool executions, permission grants, security violations,
     egress requests, code modifications

3. Create a cross-audit reference: when QIC modifies a strategy file via
   write_file, the QIC audit entry should include a reference ID that can
   be correlated with the engine's trust verification audit trail

4. Unified audit viewer command: Register a command that displays
   a unified timeline of audit events from all three sources
```

### III-QI7: MEDIUM — Workbench Registration Must Follow Existing Patterns Exactly [MEDIUM]

**Quantlab Current State**: `src/vs/workbench/workbench.common.main.ts` has 433 lines of imports. Contributions use specific patterns:
- `registerWorkbenchContribution2(id, Class, WorkbenchPhase)` for lifecycle contributions
- `registerSingleton(IService, Implementation, InstantiationType.Delayed)` for services
- `registerAction2(ActionClass)` for commands
- Context keys via `RawContextKey<T>`
- Configuration via `configRegistry.registerConfiguration()`

**Prompt Coverage**: Prompt 00 describes the registration approach but uses generic patterns that may not match the exact codebase syntax.

**Improvement for Prompt 00**:
```
Update registration code to match EXACT Quantlab patterns:

// In workbench.common.main.ts — add import (line ~433):
import 'vs/workbench/contrib/qic/browser/qic.contribution';

// In qic.contribution.ts:
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry }
  from '../../../../platform/configuration/common/configurationRegistry.js';

// Note: Use .js extensions in imports (Quantlab's ESM convention)
// Note: Use localize() from nls.js for all user-facing strings
// Note: Extend Disposable for automatic cleanup
```

### III-QI8: MEDIUM — QIC Panel Location Should Consider Existing Quantlab Layout [MEDIUM]

**Quantlab Current State**: The activity bar already has 5 Quantlab-specific containers (data, resources, history, trade, settings). The auxiliary bar (RHS) is currently empty/unused.

**Prompt Coverage**: Prompt 00 places QIC in the auxiliary bar (ViewContainerLocation.AuxiliaryBar), which is correct.

**Improvement for Prompt 00**:
```
This placement is correct — the auxiliary bar is the optimal location because:
1. It doesn't compete with the 5 existing Quantlab activity bar containers
2. It mirrors Cursor AI's RHS placement (user familiarity)
3. The auxiliary bar toggle (Ctrl+Alt+B) doesn't conflict with QIC's Ctrl+Shift+I

However, add coordination with the existing layout:
- When QIC panel is opened for the first time, automatically show the auxiliary bar
  if it's hidden (using IWorkbenchLayoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART))
- QIC's Ctrl+Shift+I should NOT conflict with any existing Quantlab keybindings
  (verify: Ctrl+Q series is used for view switching)
- Add QIC toggle to the existing Layout Control Menu (MenuId.LayoutControlMenu)
```

### III-QI9: MEDIUM — PATCHES.md Documentation Pattern Must Be Followed [MEDIUM]

**Quantlab Current State**: PATCHES.md documents 9 active patches with a specific format:
- Category prefixes: A (branding), B (UI), C (security), D (infrastructure)
- Each entry has: Files, description, key decisions

**Prompt Coverage**: Prompt 20 adds QIC to PATCHES.md but uses a different format than existing entries.

**Improvement for Prompt 20**:
```
Follow the exact PATCHES.md format used by existing entries:

## E1: QIC — Quantlab Intelligence Console

**Category**: E (Intelligence)
**Status**: Active
**Files Modified**:
- `src/vs/workbench/workbench.common.main.ts` (import added)
- `src/vs/workbench/contrib/qic/` (new directory, ~70 files)

**Description**: AI-powered coding assistant panel in the auxiliary bar.
Provides chat interface with multi-turn tool use, inline code completions,
22 tools for file operations/search/terminal/LSP, crash-safe atomic writes
via JournaledAtomicWriter, 8-lane architecture, and quant-specific features.

**Key Decisions**:
- Built as workbench contribution (not extension) for deep integration
- Reuses existing Quantlab AI module for consent, sanitization, and audit
- Extends existing Python engine for quant analysis (no separate sidecar)
- Block-all-by-default egress policy with per-category consent
- Hash-chained security audit log (SHA-256, consistent with engine audit)
```

### III-QI10: LOW — QIC Should Leverage Existing Data Providers [LOW]

**Quantlab Current State**: `engine/quantlab/data/` has:
- `service.py` — Data service with provider abstraction
- `parquet_loader.py` — Parquet file loading
- `csv_loader.py` — CSV file loading
- `corporate_actions.py` — Corporate action handling

**QIC Plans**: Prompt 16 implements DataFrame preview with its own file loading.

**Improvement for Prompt 16**:
```
When implementing preview_dataframe tool, delegate file reading to
the existing data service when possible:
- Parquet files: Route through engine's parquet_loader via IPC
- CSV files: Route through engine's csv_loader via IPC
- Arrow files: Direct read via TypeScript (apache-arrow npm package)
- HDF5 files: Route through engine via IPC

This ensures data format handling is consistent between QIC previews
and Quantlab's native data pipeline.
```

---

## IV. Audit 4 — Additional Optimality Findings

### IV-AO1: No Token Counting Implementation Strategy [HIGH]

**Finding**: Both spec and implementation plan reference token counting extensively (token budgets per lane, dynamic tool selection budget, context assembly), but no prompt specifies HOW tokens are actually counted.
**Impact**: Token counting is a dependency for Prompts 04, 08, 09, 10, 11 — without a strategy, each component may estimate differently.

**Improvement — Add to Prompt 04**:
```
Add a TokenCounter utility to canonical types:

  import { encoding_for_model } from 'tiktoken';

  export class TokenCounter {
    private encoder = encoding_for_model('cl100k_base'); // Works for Claude & GPT

    count(text: string): number {
      return this.encoder.encode(text).length;
    }

    countMessages(messages: Message[]): number {
      let total = 0;
      for (const msg of messages) {
        total += 4; // message overhead tokens
        total += this.count(msg.content);
        if (msg.role) total += 1;
      }
      total += 2; // priming tokens
      return total;
    }

    truncateToFit(text: string, maxTokens: number): string {
      const tokens = this.encoder.encode(text);
      if (tokens.length <= maxTokens) return text;
      return this.encoder.decode(tokens.slice(0, maxTokens));
    }
  }

  // Export as singleton for consistent counting across all components
  export const tokenCounter = new TokenCounter();

Note: cl100k_base slightly overestimates for Anthropic models,
which is safer (prevents exceeding limits).
Add 'tiktoken' to package.json dependencies.
```

### IV-AO2: No Load Testing Strategy [HIGH]

**Finding**: The implementation plan defines SLOs for individual operations but has no load testing strategy for concurrent workloads.
**Impact**: SLOs may be met in isolation but fail under realistic concurrent load (100 completion requests while indexing 50K files while a chat session is active).

**Improvement for Prompt 19**:
```
Add load test scenarios:

test/performance/loadTests.test.ts:
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

### IV-AO3: VS Code Activation Timeout Risk [HIGH]

**Finding**: VS Code has a 60-second default activation timeout for extensions. QIC's 10-step activation sequence (Prompt 18) involves database initialization, crash recovery, security setup, gateway initialization, context engine, agent runtime, completion engine, and background indexing.
**Impact**: If activation exceeds 60 seconds, VS Code will report the extension as failed.

**Improvement for Prompt 18**:
```
Address activation timeout:

1. Use WorkbenchPhase.AfterRestored for the QIC contribution registration
   (not BlockStartup or BlockRestore — those would block the workbench)

2. Split activation into two phases:
   Phase A (synchronous, < 5s): Register services (lazy), register commands,
   register UI components, set up context keys
   Phase B (async, no timeout): Crash recovery, database init, security init,
   gateway init, context engine, background indexing

3. Show progressive status in the status bar:
   "QIC: Starting..." → "QIC: Recovering..." → "QIC: Indexing..." → "QIC: Ready"

4. Each activation step should have its own timeout:
   - Crash recovery: 10s max
   - Database init: 5s max
   - Gateway init: 5s max (may fail if no API key — go degraded)
   - Background indexing: no timeout (non-blocking)

5. If total activation exceeds 30s, log a warning with timing breakdown
```

### IV-AO4: Embedding Service Bypasses Gateway [MEDIUM]

**Finding**: `SecureEmbeddingService` (Prompt 09) has its own consent/redaction pipeline parallel to the Gateway (Prompt 08), which already handles consent, redaction, circuit breaking, and rate limiting.
**Impact**: Duplicate logic, inconsistent behavior between embedding requests and LLM requests.

**Improvement for Prompt 09**:
```
Route embedding requests through the Gateway:

Instead of:
  SecureEmbeddingService → consent check → redaction → EmbeddingProvider

Use:
  SecureEmbeddingService → Gateway.sendRequest({ type: 'embedding', ... })
  → Gateway handles: consent → redaction → rate limiting → circuit breaking
  → Embedding provider adapter

The Gateway already has the infrastructure for all these concerns.
Add an 'embedding' request type to ProviderRequest and register
embedding providers alongside LLM providers in the Gateway.
```

### IV-AO5: Concurrent Message Handling Missing [HIGH]

**Finding**: The AgentOrchestrator transitions to PROCESSING state and assumes sequential execution. If a user sends a second message while the first is processing, the state machine rejects the PROCESSING → PROCESSING transition.
**Impact**: Users will immediately trigger this by typing while waiting for a response.

**Improvement for Prompt 10**:
```
Add message queuing to AgentOrchestrator:

  private messageQueue: Array<{ message: string; sessionId: string; resolve: Function }> = [];
  private isProcessing = false;

  async handleUserMessage(message: string, sessionId: string): Promise<void> {
    if (this.isProcessing) {
      // Queue the message and notify the user
      this.uiService.streamChatToken(sessionId,
        '[System: Your previous request is still processing. Your new message has been queued.]');
      return new Promise((resolve) => {
        this.messageQueue.push({ message, sessionId, resolve });
      });
    }

    this.isProcessing = true;
    try {
      await this.processMessage(message, sessionId);
    } finally {
      this.isProcessing = false;
      // Process next queued message
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift()!;
        this.handleUserMessage(next.message, next.sessionId).then(next.resolve);
      }
    }
  }

Also add a cancel-current-and-process-new option:
  When a new message arrives during processing, show the user a choice:
  "Cancel current request and process new one?" vs "Queue new message"
```

### IV-AO6: No Guidance on Aho-Corasick Implementation [MEDIUM]

**Finding**: Prompt 06 specifies the Aho-Corasick optimized secret scanner but doesn't guide the implementor on whether to use a native addon or pure JavaScript.
**Impact**: The implementation plan's risk register notes "Aho-Corasick native addon compatibility" as a medium-risk item.

**Improvement for Prompt 06**:
```
Specify implementation strategy:

  // Primary: Use the 'ahocorasick' npm package (pure JavaScript)
  // This avoids native addon compatibility issues while still being
  // significantly faster than sequential regex matching.
  //
  // Fallback: If the package is unavailable, implement a simple
  // prefix-based pre-filter:
  //   1. Build a Map<string, RegExp[]> of prefix → pattern list
  //   2. Scan text for known prefixes using indexOf()
  //   3. Only run full regex for patterns with matching prefixes
  //
  // Performance target: O(n) in text length for prefix scan phase
  // Known prefixes: AKIA, AIza, sk-, sk-ant-, ghp_, github_pat_,
  //   xoxb-, SG., sk_live_, hf_, glpat-, npm_, pypi-, postgres://,
  //   mongodb://, redis://, Bearer, Basic, -----BEGIN

Add 'ahocorasick' or 'aho-corasick' to package.json dependencies.
```

### IV-AO7: Webview Communication Protocol Not Defined [HIGH]

**Finding**: The chat panel (Prompt 12) is a VS Code webview communicating via `postMessage()`, but neither the spec nor implementation plan defines the message protocol.
**Impact**: The primary user interaction surface has no contract between the extension host and the webview.

**Improvement for Prompt 12**:
```
Define explicit message protocol:

  // Extension Host → Webview messages:
  type ExtensionToWebviewMessage =
    | { type: 'stream-token'; sessionId: string; text: string }
    | { type: 'tool-call-started'; sessionId: string; toolName: string; toolCallId: string }
    | { type: 'tool-call-result'; sessionId: string; toolCallId: string; result: string; success: boolean }
    | { type: 'diff-preview'; sessionId: string; files: Array<{ path: string; before: string; after: string }> }
    | { type: 'permission-request'; requestId: string; toolName: string; description: string }
    | { type: 'error'; sessionId: string; code: string; message: string }
    | { type: 'state-change'; state: 'ready' | 'processing' | 'waiting-approval' | 'error' }
    | { type: 'clear-chat' }
    | { type: 'restore-history'; messages: Array<{ role: string; content: string }> }
    | { type: 'degradation-update'; level: number; message: string };

  // Webview → Extension Host messages:
  type WebviewToExtensionMessage =
    | { type: 'user-message'; text: string }
    | { type: 'cancel-request' }
    | { type: 'approve-diff'; sessionId: string; approved: boolean }
    | { type: 'permission-response'; requestId: string; granted: boolean; remember: boolean }
    | { type: 'copy-code'; code: string }
    | { type: 'insert-code'; code: string }
    | { type: 'webview-ready' };

All messages are serialized via JSON through postMessage().
The webview must acknowledge 'webview-ready' before the extension
sends any messages (avoids race condition on initialization).
```

### IV-AO8: `PersistentAgentStateMachine.recover()` References Undefined `this.ui` [HIGH]

**Finding**: The spec's `recover()` static method calls `machine.ui.showInfo(...)` but `ui` is not a constructor parameter.
**Prompt Coverage**: Prompt 05 implements the state machine from the spec, potentially copying this bug.

**Improvement for Prompt 05**:
```
Fix the recover() method:

  // recover() is a static factory method — it should NOT depend on UI
  static async recover(db: Database, sessionId: string): Promise<PersistentAgentStateMachine | null> {
    const state = await db.get('SELECT * FROM qic_agent_state WHERE session_id = ?', sessionId);
    if (!state) return null;

    const machine = new PersistentAgentStateMachine(db, sessionId);
    machine.current = state.current_state;
    machine.completedSteps = JSON.parse(state.completed_steps_json);

    // Return recovery info — let the CALLER handle UI notification
    return machine;
  }

  // In the activation sequence (Prompt 18), the caller handles UI:
  const recovered = await PersistentAgentStateMachine.recover(db, sessionId);
  if (recovered) {
    notificationService.info(`QIC: Recovered session from ${recovered.current} state`);
  }
```

### IV-AO9: `PersistentTaskStateMachine.recover()` Drops `failedSteps` [HIGH]

**Finding**: Recovery restores `completedSteps` but sets `failedSteps: []`. The DB schema has no `failed_steps_json` column.
**Impact**: After crash recovery, the system retries previously-failed steps.

**Improvement for Prompt 05**:
```
Add failed_steps_json to the task state schema:

  CREATE TABLE qic_task_state (
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    current_state TEXT NOT NULL,
    completed_steps_json TEXT NOT NULL DEFAULT '[]',
    failed_steps_json TEXT NOT NULL DEFAULT '[]',  -- ADDED
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, task_id)
  );

And update persist() and recover():
  async persist(): Promise<void> {
    await this.db.run(`INSERT OR REPLACE INTO qic_task_state ...`,
      this.sessionId, this.taskId, this.current,
      JSON.stringify(this.completedSteps),
      JSON.stringify(this.failedSteps),  // ADDED
      Date.now()
    );
  }

  static async recover(...): Promise<PersistentTaskStateMachine | null> {
    ...
    machine.failedSteps = JSON.parse(state.failed_steps_json);  // ADDED
    return machine;
  }
```

### IV-AO10: Rate Limiter Defaults Disagree Between Spec and Plan [MEDIUM]

**Finding**: Spec says Anthropic 60 RPM / 100K TPM; Plan says 50 RPM / 500K TPM. Phase 4 gate tests "50 RPM Anthropic limit."

**Improvement for Prompt 08**:
```
Make rate limits configurable, not hard-coded:

  const DEFAULT_RATE_LIMITS: Record<string, ProviderRateLimits> = {
    anthropic: { rpm: 60, tpm: 100_000, tpd: 1_000_000 },
    openai: { rpm: 60, tpm: 90_000 },
    ollama: { rpm: Infinity, tpm: Infinity }  // Local — no limits
  };

  // But: Override from response headers when available
  // Anthropic: anthropic-ratelimit-requests-remaining
  // OpenAI: x-ratelimit-remaining-requests
  // This auto-adjusts to the user's actual API tier

Document: "Default limits are conservative estimates. Actual limits are
auto-discovered from provider response headers and take precedence."
```

### IV-AO11: Google Provider Phantom Configuration [LOW]

**Finding**: The rate limiter includes Google provider limits (60 RPM, 120K TPM) but no Google adapter is planned in any prompt.

**Improvement for Prompt 08**:
```
Either:
A) Remove Google from rate limiter defaults (no adapter exists)
B) Add a comment: "Google/Gemini adapter planned for future version.
   Rate limits pre-configured for forward compatibility."

Option A is cleaner. If Google support is needed later,
it can be added with its own rate limits.
```

### IV-AO12: No Error Code Documentation Verification [LOW]

**Finding**: The spec defines 30+ error codes. Prompt 20 mentions verifying error code documentation but doesn't specify how.

**Improvement for Prompt 19**:
```
Add error code completeness test:

  test('All error codes have user-facing messages', () => {
    for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
      expect(entry.userMessage).toBeDefined();
      expect(entry.userMessage.length).toBeGreaterThan(0);
      expect(entry.severity).toMatch(/^(critical|high|medium|low)$/);
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

## V. Per-Prompt Improvement Matrix

Summary of all improvements mapped to their target prompts:

| Prompt | Improvement IDs | Count | Severity Distribution |
|--------|----------------|-------|-----------------------|
| **00** | III-QI1, III-QI7, III-QI8 | 3 | 1 CRITICAL, 2 MEDIUM |
| **01** | II-PG5 | 1 | 1 MEDIUM |
| **02** | (none) | 0 | — |
| **03** | I-SG9 | 1 | 1 LOW |
| **04** | I-SG4, I-SG6, IV-AO1 | 3 | 1 HIGH, 2 MEDIUM |
| **05** | I-SG11, IV-AO8, IV-AO9 | 3 | 3 HIGH |
| **06** | I-SG10, III-QI5, IV-AO6 | 3 | 2 HIGH, 1 MEDIUM |
| **07** | II-PG5 | 1 | 1 MEDIUM |
| **08** | I-SG2, II-PG2, II-PG5, IV-AO10, IV-AO11 | 5 | 2 HIGH, 2 MEDIUM, 1 LOW |
| **09** | I-SG3, I-SG8, IV-AO4 | 3 | 1 MEDIUM, 1 LOW, 1 MEDIUM |
| **10** | I-SG5, I-SG7, II-PG3, III-QI4, IV-AO5 | 5 | 2 HIGH, 3 MEDIUM |
| **11** | I-SG7, II-PG5 | 2 | 1 HIGH, 1 MEDIUM |
| **12** | IV-AO7 | 1 | 1 HIGH |
| **13** | (none) | 0 | — |
| **14** | III-QI1, III-QI6 | 2 | 1 CRITICAL, 1 HIGH |
| **15** | I-SG1, I-SG6, III-QI4 | 3 | 1 HIGH, 2 MEDIUM |
| **16** | III-QI2, III-QI3, III-QI10 | 3 | 1 CRITICAL, 1 HIGH, 1 LOW |
| **17** | (none) | 0 | — |
| **18** | IV-AO3 | 1 | 1 HIGH |
| **19** | II-PG1, II-PG6, IV-AO2, IV-AO12 | 4 | 1 HIGH, 2 MEDIUM, 1 LOW |
| **20** | III-QI9 | 1 | 1 MEDIUM |
| **All** | II-PG4 | 1 | 1 LOW |

---

## VI. Priority-Ordered Action Items

### Tier 1 — Must-Fix Before Implementation (CRITICAL + blocking HIGH)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 1 | III-QI1 | Integrate with existing Quantlab AI module (consent, sanitize, audit) | 00, 06, 08, 14 |
| 2 | III-QI2 | Reuse existing Python engine instead of spawning new sidecar | 16 |
| 3 | IV-AO5 | Add concurrent message handling (queue or cancel) | 10 |
| 4 | IV-AO3 | Address VS Code activation timeout (split sync/async phases) | 18 |
| 5 | I-SG7 | Specify completion and fast-apply bypass paths | 10, 11 |
| 6 | IV-AO7 | Define webview communication protocol | 12 |
| 7 | IV-AO1 | Add token counting implementation (tiktoken) | 04 |

### Tier 2 — Should-Fix Before Phase 5 (HIGH items)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 8 | III-QI3 | Reuse existing IPC protocol for Python bridge | 16 |
| 9 | III-QI4 | Integrate trust system with QIC permission model | 10, 15 |
| 10 | III-QI5 | Unify secrets management across Quantlab and QIC | 06 |
| 11 | III-QI6 | Unify audit systems (engine + extension + QIC) | 14 |
| 12 | I-SG10 | Fix crypto API — use node:crypto consistently | 06 |
| 13 | I-SG11 | Add complete BM25 SQL DDL schema | 05 |
| 14 | IV-AO8 | Fix PersistentAgentStateMachine.recover() UI bug | 05 |
| 15 | IV-AO9 | Fix PersistentTaskStateMachine.recover() lost failedSteps | 05 |
| 16 | I-SG1 | Specify web_search tool implementation | 15 |
| 17 | I-SG2 | Replace stale model IDs with alias-based resolution | 08 |
| 18 | II-PG1 | Add 7 CI test suites with npm scripts and timeouts | 19 |
| 19 | IV-AO2 | Add load testing scenarios | 19 |

### Tier 3 — Should-Fix Before Phase 7 (MEDIUM items)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 20 | I-SG3 | Add context assembler profiles for all 8 lanes | 09 |
| 21 | I-SG4 | Add get_definition to chat-gather | 04 |
| 22 | I-SG5 | Specify summarize lane trigger and integration | 10 |
| 23 | I-SG6 | Fix inspect_notebook/preview_dataframe side-effect flags | 04, 15 |
| 24 | III-QI7 | Match exact Quantlab workbench registration patterns | 00 |
| 25 | III-QI8 | Coordinate QIC panel with existing Quantlab layout | 00 |
| 26 | II-PG2 | Add MockProviderAdapter for testing | 08 |
| 27 | II-PG3 | Enforce [STUB] warning pattern consistently | 10 |
| 28 | II-PG5 | Add missing phase gate criteria per-prompt | 01, 07, 08, 09, 11 |
| 29 | IV-AO4 | Route embedding through Gateway | 09 |
| 30 | IV-AO6 | Specify Aho-Corasick implementation strategy | 06 |
| 31 | IV-AO10 | Make rate limits configurable, not hard-coded | 08 |

### Tier 4 — Nice-to-Fix (LOW items + polish)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 32 | III-QI9 | Follow exact PATCHES.md format | 20 |
| 33 | III-QI10 | Leverage existing data providers for DataFrame loading | 16 |
| 34 | II-PG4 | Add anti-pattern checklist to all prompts | All |
| 35 | II-PG6 | Add rollback strategy per phase | 19 |
| 36 | I-SG8 | Fix RRF formula description | 09 |
| 37 | I-SG9 | Document checkpoint-git relationship | 03 |
| 38 | IV-AO11 | Remove or annotate Google provider phantom config | 08 |
| 39 | IV-AO12 | Add error code documentation verification test | 19 |

---

## Appendix A: Quantlab Integration Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Quantlab Application                      │
├─────────────────────┬───────────────────────────────────────────┤
│ Activity Bar (LHS)  │          Editor Area          │ Aux Bar  │
│ ├─ Explorer         │                               │ (RHS)    │
│ ├─ Search           │                               │          │
│ ├─ Source Control   │  ┌─────────────────────────┐  │ ┌──────┐ │
│ ├─ Debug            │  │    Active Editor Tab     │  │ │ QIC  │ │
│ ├─ quantlab-data    │  │   (Chart/Action/Trade)   │  │ │ Chat │ │
│ ├─ quantlab-resources│ │                          │  │ │Panel │ │
│ ├─ quantlab-history │  │                          │  │ │      │ │
│ ├─ quantlab-trade   │  └─────────────────────────┘  │ │      │ │
│ └─ quantlab-settings│                               │ └──────┘ │
├─────────────────────┴───────────────────────────────┴──────────┤
│                        Status Bar                                │
│  [QIC: Ready] [Completion: fast] [Provider: claude]             │
└─────────────────────────────────────────────────────────────────┘

Service Layer (shared):
┌─────────────────────────────────────────────────────────────────┐
│ IQicService ←→ IConsentService (shared) ←→ Quantlab AI Module  │
│ IQicGateway ←→ VS Code SecretStorage ←→ Quantlab SecretsManager│
│ QicAuditLogger ←→ Shared SHA-256 chain ←→ Engine Audit Ledger  │
│ QicPythonBridge ←→ Existing IPC Layer ←→ Engine Daemon (Python) │
└─────────────────────────────────────────────────────────────────┘
```

---

## Appendix B: Files That Need Cross-Reference During Implementation

| QIC Component | Existing Quantlab File to Reference |
|---------------|--------------------------------------|
| ConsentStore (Prompt 06) | `extensions/quantlab/src/ai/consent.ts` |
| SecretScanner (Prompt 06) | `extensions/quantlab/src/ai/sanitize.ts` |
| SecurityAuditLogger (Prompt 14) | `extensions/quantlab/src/ai/audit.ts` |
| Gateway/Provider (Prompt 08) | `extensions/quantlab/src/ai/provider.ts` |
| Python Bridge (Prompt 16) | `extensions/quantlab/src/core/ipc/types.ts` |
| Python Bridge (Prompt 16) | `engine/quantlab/daemon/main.py` |
| Python Bridge (Prompt 16) | `engine/quantlab/protocol/jsonrpc.py` |
| Permission Model (Prompt 10) | `extensions/quantlab/src/core/trust/` |
| SecretStorage (Prompt 06) | `engine/quantlab/secrets/encrypted.py` |
| Data Loading (Prompt 16) | `engine/quantlab/data/service.py` |
| Audit Trail (Prompt 14) | `engine/quantlab/audit/ledger.py` |
| Registration (Prompt 00) | `src/vs/workbench/workbench.common.main.ts` |
| Aux Bar (Prompt 00) | `src/vs/workbench/browser/parts/auxiliarybar/` |
| PATCHES.md (Prompt 20) | `PATCHES.md` (root) |

---

---

# DEEP AUDIT — Phase 2 (Extended Analysis)

The following sections (VII–XII) result from a second, deeper pass analyzing:
1. Full 8,465-line spec cross-referenced line-by-line against all 21 prompts
2. Full 2,274-line implementation plan cross-referenced against prompt deliverables
3. Quantlab codebase scanned for conflicts with QIC's planned components
4. Prompt execution order analyzed for dependency gaps and type contract breaks
5. Security architecture stress-tested for bypasses and attack vectors

All findings below are **new** — they do not duplicate the 47 findings in Sections I–IV above.

---

## VII. Audit 5 — Deep Spec Alignment Gaps

Line-by-line cross-reference of the full QIC Spec v6.2 (8,465 lines) against all 21 prompts. These are spec-defined requirements that no prompt adequately covers, beyond what Section I already identified.

### VII-DS1: FileContent Type Variant Mismatch [CRITICAL]

**Spec Reference**: §3.4 (lines ~2300–2400) defines 3 FileContent variants:
- `inline` (< 1MB): full content in memory
- `stream` (1MB–50MB): async iterable chunks
- `reference` (50MB–100MB): path reference only

**Prompt Coverage**: Prompt 02 defines 4 variants with different thresholds:
- `inline` (< 100KB)
- `chunked` (100KB–10MB)
- `stream` (10MB–100MB)
- `toolarge` (> 100MB)

**Impact**: This is the core file abstraction used by every file-handling component. Mismatched variant names (`chunked` vs `stream`) and thresholds (1MB vs 100KB boundary) will cause type errors across Prompts 02, 07, 09, 15. The spec's `reference` variant (path-only) is conceptually different from Prompt 02's `toolarge` (rejection).

**Improvement for Prompt 02**:
```
Reconcile FileContent — the spec and prompt define INCOMPATIBLE types:
  Spec:   3 variants (inline/stream/reference), field: 'type', thresholds 1MB/50MB
  Prompt: 4 variants (inline/chunked/stream/toolarge), field: 'kind', thresholds 100KB/10MB

Recommended: Merge the best of both models:

  export type FileContent =
    | { type: 'inline'; data: string; sizeBytes: number }           // < 1MB (use spec threshold)
    | { type: 'stream'; handle: AsyncIterable<Uint8Array>; sizeBytes: number } // 1MB–50MB
    | { type: 'reference'; path: string; hash: string }             // > 50MB (spec's path-ref)
    | { type: 'rejected'; path: string; sizeBytes: number; maxAllowed: number }; // > 100MB

Rationale:
- Use spec's 'type' field name (not 'kind') for consistency with all other QIC types
- Use spec's 1MB inline threshold (100KB is too aggressive — most source files are < 1MB)
- Keep prompt's streaming as AsyncIterable (more practical than bare FileHandle)
- Keep spec's 'reference' variant (needed for checkpoint storage)
- Keep prompt's rejection variant (needed for clear error UX)
- Remove 'chunked' — it's redundant with 'stream' using smaller chunk sizes

UPDATE ALL DOWNSTREAM PROMPTS (07, 09, 15) to use this reconciled type.
```

### VII-DS2: Agent State Machine Timeouts Missing [HIGH]

**Spec Reference**: §5.4 defines 5 state-timeout pairs for the agent state machine:
- `idle → processing`: 120s
- `processing → waiting_approval`: 300s
- `waiting_approval → processing`: user_interaction (Infinity)
- `processing → complete`: 600s
- Any state → error: immediate

**Prompt Coverage**: Prompt 05 creates the state machine but does not specify these timeouts. The TimeoutManager is created separately but the connection between state transitions and timeout domains is not wired.

**Improvement for Prompt 05**:
```
Add explicit state-transition timeouts:

  const STATE_TIMEOUTS: Record<string, number> = {
    'idle→processing': 120_000,
    'processing→waiting_approval': 300_000,
    'waiting_approval→processing': Infinity,  // INV-A4
    'processing→complete': 600_000,
  };

  // In PersistentAgentStateMachine.transition():
  const key = `${this.current}→${target}`;
  const timeout = STATE_TIMEOUTS[key];
  if (timeout !== undefined && timeout !== Infinity) {
    this.timeoutManager.schedule(`state-${key}`, timeout, () => {
      this.transition('error');
    });
  }
```

### VII-DS3: Streaming Response Handler Missing Normalization [HIGH]

**Spec Reference**: §9.2 (lines ~5600–5700) specifies 300+ lines on streaming:
- Provider-specific SSE format normalization (Anthropic's `content_block_delta` vs OpenAI's `choices[0].delta`)
- Tool call assembly from streaming chunks (partial JSON accumulation)
- Backpressure handling when consumer is slower than provider
- Error recovery mid-stream (retry from last complete chunk)

**Prompt Coverage**: Prompt 08 mentions a `StreamingHandler` but provides only a brief description. The provider-specific normalization, tool call assembly, and backpressure are not specified.

**Improvement for Prompt 08**:
```
Add detailed StreamingHandler specification:

  class StreamingHandler {
    // Normalize provider-specific SSE events to unified StreamChunk
    normalizeAnthropicEvent(event: AnthropicSSE): StreamChunk {
      switch (event.type) {
        case 'content_block_delta':
          return { type: 'text', text: event.delta.text };
        case 'content_block_start':
          if (event.content_block.type === 'tool_use')
            return { type: 'tool-call-start', id: event.content_block.id,
                     name: event.content_block.name };
        case 'content_block_stop':
          return { type: 'tool-call-end' };
        case 'message_delta':
          return { type: 'usage', usage: event.usage };
      }
    }

    // Assemble tool calls from streaming chunks
    // Tool call JSON arrives in fragments — accumulate until complete
    private pendingToolCalls: Map<string, { name: string; jsonParts: string[] }>;

    // Backpressure: pause the readable stream when consumer is slow
    // Resume when consumer catches up (pull-based consumption)
  }
```

### VII-DS4: Request Manager with Prioritization Missing [HIGH]

**Spec Reference**: §9.3 (lines ~5720–5800) defines a `RequestManager` with:
- Priority queue (completion > chat > background)
- Load shedding when rate limits are near capacity
- Request deduplication for identical completion requests
- Per-lane quota allocation (completion: 40%, chat: 50%, background: 10%)

**Prompt Coverage**: No prompt creates a `RequestManager`. The Gateway (Prompt 08) handles routing but not prioritized queuing or load shedding.

**Improvement for Prompt 08**:
```
Add RequestManager to the Gateway:

  class RequestManager {
    private queue: PriorityQueue<PendingRequest>;
    private quotas: Map<LaneName, { percentage: number; used: number }> = new Map([
      ['completion', { percentage: 0.4, used: 0 }],
      ['chat-ask', { percentage: 0.5, used: 0 }],
      ['chat-act', { percentage: 0.5, used: 0 }],
      // background lanes share remaining 10%
    ]);

    async submit(request: GatewayRequest): Promise<ProviderResponse> {
      const priority = this.calculatePriority(request);
      if (this.shouldShed(request)) {
        throw new QicError('QIC-N003', 'Request shed due to capacity');
      }
      return this.queue.enqueue(request, priority);
    }

    private shouldShed(request: GatewayRequest): boolean {
      const quota = this.quotas.get(request.lane);
      return quota && quota.used >= quota.percentage * this.rateLimiter.remaining;
    }
  }
```

### VII-DS5: Completion Tier Selection Waterfall Missing [HIGH]

**Spec Reference**: §8.2 defines a 6-tier completion waterfall:
1. Local GPU (if available)
2. Local CPU model
3. Session cache hit
4. Cloud provider (with parallel fallback)
5. Static analysis fallback
6. Empty response

**Prompt Coverage**: Prompt 11 mentions "tier selection" briefly but doesn't specify the 6-tier waterfall or the parallel fallback strategy for cloud providers.

**Improvement for Prompt 11**:
```
Add explicit tier selection waterfall:

  class CompletionTierSelector {
    async selectTier(context: CompletionContext): Promise<CompletionTier> {
      // Tier 1: Local GPU (check via navigator.gpu or CUDA availability)
      if (this.localGPU?.isAvailable()) return { tier: 'local-gpu', provider: this.localGPU };

      // Tier 2: Local CPU model (e.g., quantized GGUF via llama.cpp)
      if (this.localCPU?.isAvailable()) return { tier: 'local-cpu', provider: this.localCPU };

      // Tier 3: Session cache
      const cached = this.sessionCache.get(context.hash);
      if (cached) return { tier: 'cache', response: cached };

      // Tier 4: Cloud provider (parallel fallback: try primary, start backup after 500ms)
      return { tier: 'cloud', provider: this.gateway };

      // Tier 5: Static analysis (type-based suggestions)
      // Tier 6: Empty response
    }
  }
```

### VII-DS6: INV-T2 Tool Permission Classification Contradiction [HIGH]

**Spec Reference**: §2.2 INV-T2 (lines 999–1007) lists ALL 22 tools as `SIDE_EFFECT_TOOLS`.
**Tool Registry**: Appendix A (lines 8186–8199) marks read_file, search_code, search_files, list_directory, get_references, get_definition as `hasSideEffects: false, permission: { required: false }`.

**Impact**: Direct spec contradiction. If INV-T2 is literal, even `read_file` needs a permission check (terrible UX). If the Tool Registry is authoritative, INV-T2's "complete list" is wrong.

**Improvement for Prompt 04**:
```
Resolve the contradiction explicitly:

  // INV-T2 defines the AUDIT requirement: ALL tool calls are logged.
  // The Tool Registry defines the PERMISSION requirement: only side-effect tools need approval.
  // These are DIFFERENT concerns:
  //   - Audit logging: ALL 22 tools (INV-T2 satisfied via SecurityAuditLogger)
  //   - Permission check: Only tools with hasSideEffects: true (Tool Registry authoritative)

  // Document this resolution in canonical/types.ts:
  /** INV-T2: Every tool call is logged via SecurityAuditLogger.
   *  Permission requirement is separate — see ToolDefinition.permission field. */
```

### VII-DS7: Encrypted Conversation Storage Table Missing [MEDIUM]

**Spec Reference**: §5.3 (lines 3592–3714) defines full SQL DDL for `conversations_encrypted` table.
**Prompt Coverage**: Prompt 06 creates `ConversationCipher` (encryption logic) but no prompt creates the `conversations_encrypted` SQL table. Prompt 03 creates state persistence tables but not this one.

**Improvement for Prompt 03 or 05**:
```
Add the encrypted conversation table:

  CREATE TABLE conversations_encrypted (
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
  CREATE INDEX idx_conv_session ON conversations_encrypted(session_id);
  CREATE INDEX idx_conv_updated ON conversations_encrypted(updated_at);
```

### VII-DS8: Permissions and Sensitive Backups Tables Missing [MEDIUM]

**Spec Reference**: §5.1 (lines 3517–3535) defines `StorageArchitecture` with tables `permissions`, `sensitive_backups`, `sessions`, `config`.
**Prompt Coverage**: No prompt creates any of these tables. Without the `permissions` table, "Allow for Session" permission grants reset on restart.

**Improvement for Prompt 05**:
```
Add missing storage tables:

  CREATE TABLE qic_permissions (
    tool_name TEXT NOT NULL,
    scope TEXT NOT NULL,  -- 'once' | 'session' | 'always'
    granted_at INTEGER NOT NULL,
    expires_at INTEGER,
    session_id TEXT,
    PRIMARY KEY (tool_name, session_id)
  );

  CREATE TABLE qic_sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT
  );

  CREATE TABLE qic_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
```

### VII-DS9: LanceDB Vector Storage Not Specified [MEDIUM]

**Spec Reference**: §5.1 (lines 3524–3527) explicitly says `lancedb: { database: '{workspaceStorage}/vectors.lance'; tables: ['code_embeddings', 'doc_embeddings'] }`.
**Prompt Coverage**: Prompt 09 mentions vector search but never specifies LanceDB, the two table names, or initialization code.

**Improvement for Prompt 09**:
```
Add explicit LanceDB specification:

  import { connect } from 'lancedb';

  class VectorIndex {
    private db: lancedb.Connection;

    async initialize(storagePath: string): Promise<void> {
      this.db = await connect(path.join(storagePath, 'vectors.lance'));

      // Create tables if not exist
      await this.db.createTable('code_embeddings', [
        { vector: new Float32Array(768), path: '', chunk: '', line_start: 0, line_end: 0 }
      ], { mode: 'create_if_not_exists' });

      await this.db.createTable('doc_embeddings', [
        { vector: new Float32Array(768), path: '', content: '', type: '' }
      ], { mode: 'create_if_not_exists' });
    }

    async search(query: Float32Array, table: string, limit: number): Promise<SearchResult[]> {
      return this.db.openTable(table).search(query).limit(limit).execute();
    }
  }
```

### VII-DS10: Circuit Breaker Missing Slow Call Tracking [MEDIUM]

**Spec Reference**: §9.1 (lines 5525–5594) defines `slowCallThreshold: 5000` and `slowCallRateThreshold: 0.5`.
**Prompt Coverage**: Prompt 07's circuit breaker only tracks failure counts, not slow calls.

**Improvement for Prompt 07**:
```
Add slow call tracking to CircuitBreaker:

  private slowCalls: number[] = [];  // timestamps of slow calls

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      if (duration > this.config.slowCallThreshold) {
        this.slowCalls.push(Date.now());
      }
      this.onSuccess();
      return result;
    } catch (error) { ... }
  }

  private shouldOpen(): boolean {
    const recentSlowRate = this.getRecentSlowCallRate();
    const recentFailRate = this.getRecentFailureRate();
    return recentFailRate > this.config.failureRateThreshold
        || recentSlowRate > this.config.slowCallRateThreshold;
  }
```

### VII-DS11: SecretPattern `contextRequired` Field Missing [MEDIUM]

**Spec Reference**: §10.1.2 (lines 6836–6842, 6930–6937) — some patterns have `contextRequired` regex (e.g., SSN requires `/ssn|social|security/i` nearby).
**Prompt Coverage**: Prompt 06 specifies 60+ patterns but never mentions `contextRequired`.

**Improvement for Prompt 06**:
```
Add contextRequired to pattern definitions where applicable:

  { name: 'ssn-us', pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    contextRequired: /ssn|social\s*security|tax\s*id/i,
    confidence: 'medium' },
  { name: 'cohere-api-key', pattern: /[a-zA-Z0-9]{40}/,
    contextRequired: /cohere/i,
    confidence: 'low' },

Without contextRequired, the SSN pattern flags every 9-digit number
(phone numbers, zip+4 codes, etc.), creating massive false positive noise.
```

### VII-DS12: Terminal Security Guard Layers 3-4 Incomplete [MEDIUM]

**Spec Reference**: §10.2 (lines 6945–7062) defines 4 layers. Layers 3-4 are:
- Layer 3: Argument analysis (backtick execution, `$(...)`, pipe to shell, path traversal in args)
- Layer 4: Context analysis (history-based escalation detection)

**Prompt Coverage**: Prompt 14 shows Layers 1-2 (blocklist/allowlist) but only stubs Layers 3-4.

**Improvement for Prompt 14**:
```
Add Layer 3 argument injection patterns:

  const SHELL_INJECTION_PATTERNS = [
    /`[^`]+`/,                    // backtick execution
    /\$\([^)]+\)/,               // subshell execution
    /;\s*\w/,                     // semicolon command chaining
    /\|\s*(bash|sh|zsh|exec)/,   // pipe to shell
    /\$\{IFS\}/,                 // IFS variable tricks
    /\x00/,                      // null byte injection
    /\.\.\//,                    // path traversal in arguments
  ];

Add Layer 4 escalation detection:

  class EscalationDetector {
    private commandHistory: Array<{ cmd: string; time: number }> = [];

    detectEscalation(newCommand: string): boolean {
      // Pattern: read sensitive file then network access
      const recentReads = this.commandHistory
        .filter(h => /cat|head|tail|less/.test(h.cmd) && /passwd|shadow|\.env|\.ssh/.test(h.cmd));
      const isNetworkCmd = /curl|wget|nc|ssh|scp/.test(newCommand);
      return recentReads.length > 0 && isNetworkCmd;
    }
  }
```

### VII-DS13: DataFlowAnalysis Interface Missing [MEDIUM]

**Spec Reference**: §3.5 (lines 3031–3051) defines `DataFlowAnalysis` with `detected`, `sensitiveDataAccessed`, `potentialExfiltration`.
**Prompt Coverage**: Prompt 14 mentions tool chain monitoring but never references data flow tracking — it can only detect fixed sequences, not data-aware patterns.

**Improvement for Prompt 14**:
```
Add DataFlowAnalysis to ToolChainMonitor:

  interface DataFlowAnalysis {
    detected: boolean;
    sensitiveDataAccessed: string[];  // file paths accessed
    potentialExfiltration: boolean;
  }

  // In ToolChainMonitor.analyze():
  // Track what data each tool accessed
  if (toolCall.name === 'read_file') {
    this.dataAccessed.set(sessionId,
      [...(this.dataAccessed.get(sessionId) ?? []), toolCall.args.path]);
  }
  // Flag if accessed data is followed by network/terminal egress
  if (['web_fetch', 'run_command', 'run_terminal'].includes(toolCall.name)) {
    const accessed = this.dataAccessed.get(sessionId) ?? [];
    if (accessed.some(p => this.isSensitivePath(p))) {
      return { detected: true, sensitiveDataAccessed: accessed,
               potentialExfiltration: true };
    }
  }
```

### VII-DS14: EmbeddingProvider Interface and Local Fallback Missing [MEDIUM]

**Spec Reference**: §3.5 (lines 2897–2927) defines `EmbeddingProvider` interface with `dimensions`, `maxTokens`, `embed()`, `embedBatch()`, and local fallback configuration.
**Prompt Coverage**: Prompt 09 creates `SecureEmbeddingService` but without the `EmbeddingProvider` interface or local fallback.

**Improvement for Prompt 09**:
```
Add EmbeddingProvider interface and fallback:

  interface EmbeddingProvider {
    readonly dimensions: number;
    readonly maxTokens: number;
    embed(text: string, options?: EmbedOptions): Promise<Float32Array>;
    embedBatch(texts: string[], options?: EmbedOptions): Promise<Float32Array[]>;
  }

  // In SecureEmbeddingService:
  private async getProvider(): Promise<EmbeddingProvider> {
    if (this.remoteProvider?.isAvailable()) return this.remoteProvider;
    if (this.config.localFallback?.enabled) return this.localProvider;
    throw new QicError('QIC-C002', 'No embedding provider available');
  }
```

### VII-DS15: FlexibleMatcher Strategies 4-7 Unspecified [MEDIUM]

**Spec Reference**: §7 (lines ~4588–4977) defines 7 matching strategies with detailed algorithms.
**Prompt Coverage**: Prompt 07 mentions "7 strategies" but only describes strategies 1-3 (exact, normalized whitespace, line-shifted). Strategies 4-7 (AST-aware, fuzzy edit distance, semantic context, LLM-based) have no specification.

**Improvement for Prompt 07**:
```
Add strategy specifications for 4-7:

Strategy 4 — AST-Aware:
  Parse both old and new content as AST nodes. Match by AST node type + name
  even if surrounding code has changed. Use tree-sitter for language support.

Strategy 5 — Fuzzy Edit Distance:
  Use Levenshtein distance normalized by line count. Accept match if
  editDistance / lineCount < 0.3 (configurable threshold).

Strategy 6 — Semantic Context:
  Match by surrounding function/class scope. Find the enclosing scope in the
  new file and compare the target lines within that scope.

Strategy 7 — LLM Instruction-Based (last resort):
  Send the original edit intent + new file content to the LLM and ask it to
  produce the updated edit. SLO: only invoke if strategies 1-6 all fail.
  Budget: max 2000 tokens. Timeout: 10s.
```

### VII-DS16: Memory Budget Per-Component Missing [MEDIUM]

**Spec Reference**: §2.6 defines the 500MB peak memory SLO with per-component budgets (embedding cache, BM25 index, conversation state, completion cache, each with different eviction policies).
**Prompt Coverage**: Prompt 11 mentions 500MB as a single number with no per-component breakdown.

**Improvement for Prompt 11**:
```
Add per-component memory budgets:

  const MEMORY_BUDGETS = {
    embeddingCache: { maxMb: 150, eviction: 'lru' },
    bm25Index: { maxMb: 100, eviction: 'fifo' },
    conversationState: { maxMb: 50, eviction: 'oldest-session' },
    completionCache: { maxMb: 50, eviction: 'lru-with-ttl' },
    vectorIndex: { maxMb: 100, eviction: 'managed-by-lancedb' },
    overhead: { maxMb: 50 },  // runtime overhead
  };
  // Total: 500MB. Monitor via MemoryPressureMonitor.
```

### VII-DS17: Secret Scanning at Checkpoint Export Missing [MEDIUM]

**Spec Reference**: §2.2 INV-T3 (lines 1032–1037) lists `CheckpointManager.export()` as an egress point requiring secret redaction.
**Prompt Coverage**: No prompt connects secret scanning to checkpoint export.

**Improvement for Prompt 03 or 07**:
```
Add secret scanning to checkpoint export:

  async exportCheckpoint(checkpointId: string): Promise<ExportedCheckpoint> {
    const checkpoint = await this.loadCheckpoint(checkpointId);
    // INV-T3: Redact secrets before export
    const redactedFiles = checkpoint.files.map(f => ({
      ...f,
      content: this.secretScanner.redact(f.content).redactedText,
    }));
    return { ...checkpoint, files: redactedFiles };
  }
```

---

## VIII. Audit 6 — Implementation Plan Completeness

Line-by-line cross-reference of the 2,274-line Implementation Plan v3 against all 21 prompts. These findings identify deliverables specified in the plan that no prompt covers.

### VIII-PC1: `python-env-manager.ts` Never Created [HIGH]

**Plan Reference**: Lines 203, 1740–1753, 2168, 2244
**Detail**: The plan specifies a dedicated `PythonEnvironmentManager` with:
- Discovery chain: setting → .venv → python3 → python
- Validation via `import numpy, pandas, pyarrow` check
- Auto-setup with virtualenv creation and pip install
- Caching of validated path

Prompt 16 creates `pythonSidecar.ts` but not this prerequisite module.

**Improvement for Prompt 16**:
```
Add pythonEnvManager.ts to files-to-create:

  class PythonEnvironmentManager {
    async discoverPython(): Promise<string> {
      // 1. Check qic.pythonPath setting
      // 2. Check workspace .venv/bin/python
      // 3. Check system python3
      // 4. Check system python
      for (const candidate of this.candidates()) {
        if (await this.validate(candidate)) return candidate;
      }
      throw new QicError('QIC-Q001', 'No suitable Python environment found');
    }

    async validate(pythonPath: string): Promise<boolean> {
      // Run: python -c "import numpy; import pandas; import pyarrow"
      const result = await execFile(pythonPath, ['-c',
        'import numpy; import pandas; import pyarrow; print("ok")']);
      return result.stdout.trim() === 'ok';
    }

    async autoSetup(): Promise<string> {
      // Create .venv, install requirements, return path
    }
  }
```

### VIII-PC2: 4 CI Validation Scripts Never Created [HIGH]

**Plan Reference**: Lines 244–249
**Detail**: `validate-schema.sh` (Prompt 19) invokes these scripts but they are never created:
- `validate-lane-prompts.ts` — verify all 8 lanes have prompt templates
- `validate-file-content-types.ts` — verify FileContent usage respects tiers
- `validate-state-persistence.ts` — verify all 3 state tables exist
- `validate-model-registry.ts` — verify model registry configuration

**Improvement for Prompt 19**:
```
Add to files-to-create table:
| scripts/validate-lane-prompts.ts | Verify 8 lanes × 8 entries |
| scripts/validate-file-content-types.ts | Verify FileContent tier usage |
| scripts/validate-state-persistence.ts | Verify state tables exist |
| scripts/validate-model-registry.ts | Verify model registry config |
```

### VIII-PC3: npm Dependencies Never Added to package.json [HIGH]

**Plan Reference**: Lines 256–277
**Detail**: Runtime dependencies are referenced but never installed:
- `better-sqlite3` ^11.0.0 (used by Prompts 03, 05)
- `lancedb` ^0.5.0 (used by Prompt 09)
- `apache-arrow` ^15.0.0 (used by Prompt 16)
- `ahocorasick` (used by Prompt 06)

No prompt adds these to Quantlab's dependency tree.

**Improvement**: Each prompt that first uses a dependency should install it:
```
Prompt 03 or 05: Add better-sqlite3 + @types/better-sqlite3
Prompt 06: Add ahocorasick (or document pure-JS fallback)
Prompt 09: Add lancedb
Prompt 16: Add apache-arrow
```

### VIII-PC4: `deactivate()` Cleanup Sequence Never Implemented [HIGH]

**Plan Reference**: Line 359
**Detail**: The plan requires cleanup on deactivation: "flush audit logs, stop sidecar, persist state, close DB." No prompt implements this.

**Improvement for Prompt 18**:
```
Add deactivation handler:

  class QicActivation {
    async deactivate(): Promise<void> {
      // Reverse order of activation
      this.cancellationManager.cancelAll();           // Cancel in-flight requests
      await this.reproducibilityLogger?.flush();       // Flush buffered logs
      await this.securityAuditLogger?.flush();         // Flush audit entries
      this.pythonSidecar?.kill();                      // Stop Python process
      await this.indexer?.dispose();                   // Stop file watchers
      await this.completionEngine?.dispose();          // Deregister completion provider
      await this.statePersistence?.persistAll();       // Save all state
      await this.database?.close();                    // Close SQLite
      this.disposed = true;
    }
  }

Register with VS Code:
  context.subscriptions.push({ dispose: () => activation.deactivate() });
```

### VIII-PC5: Workspace Storage Directories Never Created [MEDIUM]

**Plan Reference**: Lines 712–717
**Detail**: These directories must exist before components can write:
- `{workspaceStorage}/checkpoints/`
- `{workspaceStorage}/checkpoints/quarantine/`
- `{workspaceStorage}/logs/`
- `{workspaceStorage}/recordings/`
- `{workspaceStorage}/security-audit/`

**Improvement for Prompt 18**:
```
Add directory creation as activation Step 0 (before crash recovery):

  await this.step('directories', async () => {
    const dirs = ['checkpoints', 'checkpoints/quarantine', 'logs',
                  'recordings', 'security-audit'];
    for (const dir of dirs) {
      await fileService.createFolder(URI.joinPath(workspaceStorage, dir));
    }
  });
```

### VIII-PC6: Missing Commands in Registration [MEDIUM]

**Plan Reference**: Lines 349–354, 414–419
**Detail**: Prompt 18 registers 4 commands (toggle, newChat, cancel, focusInput). The plan requires 5 additional commands:
- `qic.createCheckpoint`
- `qic.restoreCheckpoint`
- `qic.showSettings`
- `qic.toggleCompletion`
- `qic.retryConnection`

**Improvement for Prompt 18**:
```
Register all commands:

  registerAction2(QICCreateCheckpointAction);
  registerAction2(QICRestoreCheckpointAction);
  registerAction2(QICShowSettingsAction);
  registerAction2(QICToggleCompletionAction);
  registerAction2(QICRetryConnectionAction);  // For degradation recovery
```

### VIII-PC7: Anti-Pattern CI Checks Missing [MEDIUM]

**Plan Reference**: Lines 286–295
**Detail**: 5 anti-patterns have no CI enforcement:
- #2: `fs.renameSync` atomicity on Windows
- #3: Secrets in workspace config
- #4: Node.js crypto in webview
- #8: Max 8 tools per LLM request
- #10: Circular dependencies

**Improvement for Prompt 19**:
```
Add CI checks to validate-schema.sh:

  # Anti-pattern #2: No renameSync in production code
  ! grep -r "renameSync" src/vs/workbench/contrib/qic/ --include="*.ts" | grep -v test

  # Anti-pattern #10: Circular dependency detection
  npx madge --circular src/vs/workbench/contrib/qic/
```

### VIII-PC8: Conversation Encryption Wire-Up Never Happens [MEDIUM]

**Plan Reference**: Lines 571, 894, 906
**Detail**: Phase 0 stubs encryption; Phase 2 (Prompt 06) should replace the stub. But Prompt 06 creates `ConversationCipher` without wiring it into the conversation state persistence from Prompt 03/05. The Phase 2 gate criterion ("Conversation state persistence now uses real encryption") is never satisfied.

**Improvement for Prompt 06**:
```
Add to "Files to Modify":
  - src/vs/workbench/contrib/qic/common/state/conversationState.ts
    Wire ConversationCipher into persist() and restore():

    async persist(): Promise<void> {
      const plaintext = JSON.stringify(this.messages);
      const encrypted = this.cipher.encrypt(plaintext);
      await this.db.run('INSERT OR REPLACE INTO conversations_encrypted ...',
        this.sessionId, encrypted.ciphertext, encrypted.iv, encrypted.authTag);
    }
```

### VIII-PC9: HDD Detection and LanceDB Fallback Missing [MEDIUM]

**Plan Reference**: Lines 2224, 2230
**Detail**: Risk register specifies:
- HDD: "Detect at startup via write benchmark; batch journal writes; warn user"
- LanceDB: "Fall back to file-based vector storage; accept slower search"

No prompt implements either mitigation.

**Improvement for Prompts 01 and 09**:
```
Prompt 01 — Add HDD detection:
  async detectStorageType(): Promise<'ssd' | 'hdd' | 'unknown'> {
    const start = Date.now();
    const testFile = path.join(this.journalDir, '.speed-test');
    await fs.writeFile(testFile, Buffer.alloc(4096));
    await fs.fdatasync(/* fd */);
    const latency = Date.now() - start;
    await fs.unlink(testFile);
    if (latency > 20) return 'hdd'; // 4KB fsync > 20ms = likely HDD
    return 'ssd';
  }

Prompt 09 — Add LanceDB fallback:
  If LanceDB initialization fails, fall back to BM25-only search.
  Log warning: "Vector search unavailable. Using keyword search only."
```

---

## IX. Audit 7 — Quantlab Codebase Conflict Analysis

Direct scanning of the Quantlab codebase for conflicts with QIC's planned components.

### IX-CC1: Ctrl+Shift+N Keybinding Already Bound [CRITICAL]

**Quantlab File**: `src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts` (~line 215)
**Current Use**: `KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN` — Accept Inline Edit in chat editing context.
**QIC Plan**: Prompt 18 assigns Ctrl+Shift+N to `QICNewChatAction`.

**Impact**: Keybinding collision. Depending on context key evaluation order, one or both commands may fire unpredictably.

**Improvement for Prompt 18**:
```
Change QIC new chat keybinding:
  primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN
  // Or: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ

Verify all QIC keybindings against:
  grep -r "KeyMod.CtrlCmd | KeyMod.Shift" src/vs/workbench/contrib/ --include="*.ts"
```

### IX-CC2: InlineCompletionProvider Registration — Integration Required [MEDIUM]

**Quantlab File**: `src/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.ts`
**Current State**: Full inline completions system with `InlineCompletionsController`, keybindings (Alt+], Alt+[, Tab), and context keys (`inlineSuggestionVisible`, etc.). **VS Code natively supports multiple providers** via parallel fetching with `groupId`, `yieldsToGroupIds`, and `excludesGroupIds` in `provideInlineCompletions.ts`.
**QIC Plan**: Prompt 11 registers a QIC `InlineCompletionProvider` for ghost text.

**Impact**: No actual conflict — the system is designed for multi-provider composition. But Prompt 11 must register correctly to integrate with the existing aggregation mechanism.

**Improvement for Prompt 11**:
```
Register QIC as a standard InlineCompletionProvider:

  const qicProvider: InlineCompletionsProvider = {
    groupId: 'qic-ai',
    // Yield to any existing Copilot/GitHub provider if present
    yieldsToGroupIds: ['copilot'],
    provideInlineCompletions: (model, position, context, token) => {
      return this.completionEngine.provideCompletions(model, position, context, token);
    },
    freeInlineCompletions: (completions) => { /* cleanup */ },
  };

  languageFeaturesService.inlineCompletionsProvider.register('*', qicProvider);

The existing InlineCompletionsController handles aggregation, priority,
and rendering automatically. QIC just needs to be a well-behaved provider.
Do NOT create a second InlineCompletionsController.
```

### IX-CC3: SQLite Native Module Coexistence [MEDIUM]

**Quantlab State**: Uses `@vscode/sqlite3` (version 5.1.10-vscode) at `src/vs/base/parts/storage/node/storage.ts` — async callback API.
**QIC Plan**: Uses `better-sqlite3` (synchronous API, WAL mode).

**Impact**: Both are native modules but CAN coexist — they statically link their own SQLite C libraries. The real risk is: `better-sqlite3` must be compiled against Quantlab's exact Electron version or the Node.js N-API will fail to load. They must also use separate database files.

**Improvement for Prompts 03/05**:
```
Recommended: Use better-sqlite3 (synchronous API is significantly simpler
for the transactional patterns QIC needs — WAL mode, prepared statements,
explicit transactions for atomic multi-file writes).

Requirements:
1. Compile better-sqlite3 against Quantlab's Electron version:
   npx electron-rebuild -m node_modules/better-sqlite3

2. Use SEPARATE database files (never share with @vscode/sqlite3):
   - QIC database: {workspaceStorage}/qic.db
   - Quantlab storage: managed by @vscode/sqlite3 separately

3. Add to Quantlab's build pipeline:
   - postinstall: electron-rebuild for better-sqlite3
   - Test native module loading on all platforms (Linux, macOS, Windows)

4. Add fallback: if better-sqlite3 fails to load, log error and enter
   degraded mode (no state persistence, no search, chat-only mode).
```

### IX-CC4: Extension Activation Ordering [MEDIUM]

**Quantlab State**: Three extensions use `onStartupFinished`: merge-conflict, debug-auto-launch, quantlab. No guaranteed ordering.
**QIC Plan**: Prompt 18 activates QIC as a workbench contribution.

**Impact**: Workbench contributions activate before extensions. File watchers from merge-conflict extension could interfere with QIC's file watching if both watch the same directories.

**Improvement for Prompt 18**:
```
Document activation ordering:
  1. QIC workbench contribution activates during WorkbenchPhase.AfterRestored
  2. Extensions activate later via onStartupFinished
  3. QIC should NOT depend on any extension being active
  4. Use IFileService events (not raw fs.watch) to coordinate with other watchers
```

### IX-CC5: File Watcher Overlap [MEDIUM]

**Quantlab State**: Extensive file watching via `workspaceWatcher.ts` and various chat file watchers.
**QIC Plan**: Prompt 09's `IncrementalIndexer` creates its own file watchers for workspace monitoring.

**Improvement for Prompt 09**:
```
Use IFileService.onDidFilesChange() instead of creating independent watchers:

  // Subscribe to VS Code's file system events
  this.fileService.onDidFilesChange(changes => {
    for (const change of changes.rawChanges) {
      if (change.type === FileChangeType.UPDATED) {
        this.reindexFile(change.resource);
      } else if (change.type === FileChangeType.DELETED) {
        this.removeFromIndex(change.resource);
      }
    }
  });

This avoids duplicate file system watches and uses Quantlab's existing
file watching infrastructure.
```

---

## X. Audit 8 — Prompt Sequencing & Type Safety

Analysis of inter-prompt dependencies, type contracts across prompt boundaries, and execution ordering issues.

### X-PS1: Service Identifiers Never Defined [CRITICAL]

**Detail**: Prompt 18 registers 5 services via `registerSingleton()`:
- `IQicDatabaseService`
- `IQicSecurityService`
- `IQicGatewayService`
- `IQicContextService`
- `IQicRuntimeService`

None of these service identifiers (created via `createDecorator<>`) are defined by any prompt. No facade service classes exist.

**Improvement — distribute across prompts**:
```
Each subsystem prompt should create its service identifier:

Prompt 03: export const IQicDatabaseService = createDecorator<IQicDatabaseService>('qicDatabaseService');
Prompt 06: export const IQicSecurityService = createDecorator<IQicSecurityService>('qicSecurityService');
Prompt 08: export const IQicGatewayService = createDecorator<IQicGatewayService>('qicGatewayService');
Prompt 09: export const IQicContextService = createDecorator<IQicContextService>('qicContextService');
Prompt 10: export const IQicRuntimeService = createDecorator<IQicRuntimeService>('qicRuntimeService');

Each facade service wraps the subsystem's internal components and exposes
them via the service interface for dependency injection.
```

### X-PS2: `ToolImplementation` Type and `ToolRouter.register()` Never Defined [CRITICAL]

**Detail**: Prompt 10 creates `ToolRouter` with `Map<string, ToolImplementation>` in the constructor, but `ToolImplementation` is never defined. Prompt 15 calls `toolRouter.register('read_file', ...)` but `register()` is never declared on `ToolRouter`.

**Improvement for Prompts 04 and 10**:
```
Prompt 04 — Add to canonical types:

  export interface ToolImplementation {
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  }

  export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

Prompt 10 — Add register() method to ToolRouter:

  class ToolRouter {
    private implementations = new Map<string, ToolImplementation>();

    register(toolName: string, handler: ToolHandler): void {
      if (this.implementations.has(toolName)) {
        throw new Error(`Tool '${toolName}' already registered`);
      }
      this.implementations.set(toolName, { execute: handler });
    }
  }
```

### X-PS3: SecurityAuditLogger Stub Never Created [HIGH]

**Detail**: Prompt 10's `ToolRouter` constructor requires `SecurityAuditLogger`, but no stub is created. The real implementation is in Prompt 14. Prompt 10 creates `UIServiceStub` but not `SecurityAuditLoggerStub`.

**Improvement for Prompt 10**:
```
Add securityAuditLoggerStub.ts to files-to-create:

  export class SecurityAuditLoggerStub implements SecurityAuditLogger {
    logToolCall(entry: AuditEntry): void {
      console.warn('[STUB] SecurityAuditLogger.logToolCall — Prompt 14 will replace');
      console.log('[AUDIT-STUB]', entry.toolName, entry.action);
    }
    logPermissionGrant(entry: AuditEntry): void {
      console.warn('[STUB] SecurityAuditLogger.logPermissionGrant — Prompt 14');
    }
    logEgressAttempt(entry: AuditEntry): void {
      console.warn('[STUB] SecurityAuditLogger.logEgressAttempt — Prompt 14');
    }
    async flush(): Promise<void> {}
  }
```

### X-PS4: UIService Chicken-and-Egg in Activation [HIGH]

**Detail**: Prompt 18's Step 5 (first-run consent) creates `FirstRunManager(this.consentStore, this.uiService)`. But `this.uiService` requires the QIC panel (Prompt 12), which depends on the orchestrator (Prompt 10), which is Step 8. UIService doesn't exist yet when Step 5 runs.

**Improvement for Prompt 18**:
```
Use VS Code's native IDialogService for first-run consent:

  await this.step('first-run', async () => {
    const firstRunManager = new FirstRunManager(
      this.consentStore,
      this.dialogService,    // VS Code's native dialog, NOT QIC UIService
      this.notificationService
    );
    const result = await firstRunManager.checkAndPrompt();
    if (!result.canProceed) {
      this.state = 'degraded';
    }
  });

The QIC webview UIService is for chat interactions.
System-level dialogs (consent, errors) should use VS Code's native APIs.
```

### X-PS5: `ProviderAdapter` Interface Missing `sendStreaming()` [HIGH]

**Detail**: Prompt 04 defines `ProviderAdapter` with only `sendRequest()`. Prompt 08's adapters implement `sendStreaming()` which is not in the interface.

**Improvement for Prompt 04**:
```
Add to ProviderAdapter interface:

  export interface ProviderAdapter {
    readonly id: string;
    readonly name: string;
    isAvailable(): Promise<boolean>;
    getHealth(): Promise<ProviderHealth>;
    sendRequest(request: ProviderRequest): Promise<ProviderResponse>;
    sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk>;  // ADDED
    cancelRequest(requestId: string): void;
  }
```

### X-PS6: Prompt 14 Should Execute Before Prompt 10 [HIGH]

**Detail**: Prompt 14 (Security Hardening) only depends on Prompts 04 and 06. It creates `SecurityAuditLogger`, `TerminalSecurityGuard`, and `ToolChainMonitor`. Prompt 10 (Agent Runtime) needs `SecurityAuditLogger`. If 14 runs before 10, the stub gap (X-PS3) disappears entirely.

**Improvement**:
```
Reorder execution: 14 should run between 09 and 10.

Current:  ...09 → 10 → 11 → 12 → 13 → 14 → 15...
Proposed: ...09 → 14 → 10 → 11 → 12 → 13 → 15...

Update prompt numbering or add a note:
"Execute Prompt 14 BEFORE Prompt 10. Prompt 14's actual dependencies
 are only Prompts 04 (canonical types) and 06 (security foundation)."
```

### X-PS7: Gateway-Specific Types Not in Canonical [MEDIUM]

**Detail**: `StreamChunk`, `GatewayRequest`, `RequestPriority` are defined in Prompt 08 but needed by Prompts 10, 11, 17. They're not in `canonical/index.ts`, violating INV-A1.

**Improvement for Prompt 04**:
```
Add to canonical types (or create canonical/gateway.ts):

  export interface StreamChunk {
    type: 'text' | 'tool-call-start' | 'tool-call-delta' | 'tool-call-end' | 'usage' | 'error' | 'done';
    text?: string;
    toolCallId?: string;
    toolName?: string;
    argsJson?: string;
    usage?: { inputTokens: number; outputTokens: number };
    error?: Error;
  }

  export type RequestPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

  export interface GatewayRequest extends ProviderRequest {
    lane: LaneName;
    priority: RequestPriority;
    sessionId: string;
  }
```

### X-PS8: Private `sessionId` in PersistentAgentStateMachine [MEDIUM]

**Detail**: Prompt 05 declares `private readonly sessionId`. Prompt 10 accesses `this.agentState.sessionId`. Compilation error.

**Improvement for Prompt 05**: `Make sessionId public or add a getter: get sessionId(): string { return this._sessionId; }`

### X-PS9: No Shared Test Utilities [MEDIUM]

**Detail**: No prompt creates shared test infrastructure. Prompt 19's E2E tests need mock factories for Gateway, ToolRouter, FileService, etc.

**Improvement for Prompt 19**:
```
Create test/helpers/ directory with:
- createMockGateway(): MockGateway with configurable responses
- createMockToolRouter(): ToolRouter with mock implementations
- createTestWorkspace(fileCount): Temporary workspace with mock files
- createMockProvider(): MockProviderAdapter (use the one from II-PG2)
- assertNoMemoryLeaks(): Heap snapshot comparison utility
```

---

## XI. Audit 9 — Security Vulnerability Analysis

Targeted security analysis of the 21 prompts, testing for real-world attack vectors.

### XI-SV1: Secret Leakage via Error Messages [CRITICAL]

**Attack Vector**: Throughout the codebase, errors are displayed to users via `this.uiService.showError(error.message)`. Error messages may contain:
- File paths with secrets in names (`/home/user/.env.PRODUCTION_KEY`)
- API response bodies with reflected secrets
- Stack traces containing secret values from variables

The `SecretScanner` is applied at egress boundaries (Gateway, embedding) but NOT to error messages shown in the UI or logged by the `SecurityAuditLogger`.

**Improvement for Prompts 10, 14**:
```
Prompt 10 — Wrap all error display through SecretScanner:

  private showError(error: Error): void {
    const sanitizedMessage = this.secretScanner.redact(error.message).redactedText;
    this.uiService.showError(sanitizedMessage);
  }

Prompt 14 — SecurityAuditLogger must redact before writing:

  logEntry(entry: AuditEntry): void {
    const redacted = {
      ...entry,
      details: this.secretScanner.redact(JSON.stringify(entry.details)).redactedText,
    };
    this.appendToLog(redacted);
  }
```

### XI-SV2: Path Traversal via Symlinks [CRITICAL]

**Attack Vector**: `path.resolve()` does not resolve symlinks. The LLM can:
1. Call `run_command` to create: `ln -s /etc/passwd /workspace/.passwd`
2. Call `read_file` on `/workspace/.passwd` — passes workspace boundary check
3. The file actually reads `/etc/passwd`

Similarly, the LLM can create symlinks to escape the workspace boundary for writes.

**Improvement for Prompt 15**:
```
Add symlink resolution to ALL file operation tools:

  async validatePath(requestedPath: string): Promise<string> {
    const resolved = path.resolve(this.workspaceRoot, requestedPath);

    // Check workspace boundary BEFORE resolving symlinks
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new QicError('QIC-P001', 'Path outside workspace');
    }

    // Resolve symlinks and check AGAIN
    const realPath = await fs.realpath(resolved);
    if (!realPath.startsWith(this.workspaceRoot)) {
      throw new QicError('QIC-P002', 'Symlink target outside workspace');
    }

    return realPath;
  }
```

### XI-SV3: Command Injection Bypassing Prefix Allowlist [CRITICAL]

**Attack Vector**: Prompt 14's terminal guard allows commands with "safe" prefixes (`git`, `python`, `npm`, `npx`). But these prefixes enable arbitrary code execution:
- `git -c protocol.ext.allow=always ext::sh -c 'rm -rf /'` — Git protocol extension
- `python -c "import os; os.system('rm -rf /')"` — Python code execution
- `npx malicious-package` — Downloads and executes arbitrary code
- `npm exec -- sh -c 'malicious command'` — npm exec to shell

**Improvement for Prompt 14**:
```
Layer 3 needs STRUCTURED command parsing, not just regex:

  class ArgumentAnalyzer {
    validate(parsed: ParsedCommand): ValidationResult {
      const { command, args } = this.parseCommand(rawCommand);

      // 1. Shell metacharacter detection in ANY argument
      for (const arg of args) {
        if (this.containsShellMetachars(arg)) {
          return { allowed: false, reason: 'Shell metacharacters in arguments',
                   layer: 3 };
        }
      }

      // 2. Per-command argument rules
      switch (command) {
        case 'python':
        case 'python3':
          // Block -c (arbitrary code execution) — require 'once' permission
          if (args.includes('-c') || args.includes('--command'))
            return { allowed: false, reason: 'python -c requires explicit approval',
                     layer: 3, escalateTo: 'once' };
          break;
        case 'git':
          // Block -c config overrides (can enable protocol extensions)
          if (args.some(a => a.startsWith('-c')))
            return { allowed: false, reason: 'git -c blocked (config injection)',
                     layer: 3 };
          break;
        case 'npx':
          // ALL npx commands download/execute remote code
          return { allowed: false, reason: 'npx requires explicit approval',
                   layer: 3, escalateTo: 'once' };
        case 'npm':
          if (args[0] === 'exec')
            return { allowed: false, reason: 'npm exec requires approval',
                     layer: 3, escalateTo: 'once' };
          break;
      }
      return { allowed: true };
    }

    private containsShellMetachars(arg: string): boolean {
      // Detect: ; | & ` $() ${} > < $(( )) \n
      return /[;&|`]|\$[\({]|[<>]|\n/.test(arg);
    }

    private parseCommand(raw: string): { command: string; args: string[] } {
      // Use shell-quote or similar library for proper argument splitting
      // Do NOT use raw string splitting — it misses quoted args
    }
  }

Key design principle: regex-based detection is always bypassable.
Use a proper shell argument parser (e.g., shell-quote npm package)
and validate the PARSED structure, not the raw string.
```

### XI-SV4: Consent Bypass After Revocation [HIGH]

**Attack Vector**: The Gateway's `RequestManager` queues requests. If consent is revoked AFTER a request is queued but BEFORE it's dispatched, the request executes without valid consent.

Similarly, the `CompletionEngine` may cache consent status. After revocation, completions continue until cache expires.

**Improvement for Prompts 06, 08, 11**:
```
Prompt 06 — Add consent revocation event:

  class ConsentStore {
    private readonly _onDidRevokeConsent = new Emitter<ConsentCategory>();
    readonly onDidRevokeConsent = this._onDidRevokeConsent.event;

    revoke(category: ConsentCategory): void {
      this.storage.delete(category);
      this._onDidRevokeConsent.fire(category);  // Notify all listeners
    }
  }

Prompt 08 — Gateway listens for revocation:

  this.consentStore.onDidRevokeConsent(category => {
    this.requestManager.cancelQueuedByCategory(category);
  });

Prompt 11 — CompletionEngine re-checks on every request:

  // Do NOT cache consent. Check fresh every time.
  if (!this.consentStore.hasConsent('llm')) {
    return [];  // No completions without consent
  }
```

### XI-SV5: XSS via Custom Markdown Renderer [HIGH]

**Attack Vector**: Prompt 12 implements a custom lightweight markdown renderer. Custom markdown renderers almost invariably have HTML injection vulnerabilities. The LLM's response could contain:
- `<img src=x onerror="...">`
- `[link](javascript:alert('xss'))`
- CSS-based data exfiltration (CSP has `'unsafe-inline'` for styles)

**Improvement for Prompt 12**:
```
1. Use VS Code's built-in MarkdownRenderer instead of a custom one:
   import { MarkdownRenderer } from 'vs/editor/browser/widget/markdownRenderer';

2. If custom renderer is required, add strict HTML sanitization:
   const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'code', 'pre',
     'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'br', 'table',
     'thead', 'tbody', 'tr', 'th', 'td', 'img', 'hr', 'details', 'summary']);

   // Validate all href attributes
   function sanitizeHref(href: string): string | null {
     if (/^https?:\/\//.test(href)) return href;
     if (href.startsWith('#')) return href;
     return null;  // Block javascript:, data:, vbscript:, etc.
   }

3. Strengthen CSP:
   style-src ${webview.cspSource} 'nonce-${nonce}';  // Remove 'unsafe-inline'
   form-action 'none';
   base-uri 'none';
```

### XI-SV6: Incomplete Egress Boundary Coverage [HIGH]

**Attack Vector**: Several network-communicating paths bypass the egress enforcer:
- `web_fetch` tool: No URL allowlist/blocklist → SSRF to internal networks
- `pip install` via Python sidecar: Downloads packages from PyPI
- `git push/fetch`: Sends code to remote repositories
- `npx`: Downloads and executes from npm registry
- Ollama URL: User-configurable, could point to remote servers

**Improvement for Prompts 06, 14, 15, 16**:
```
Prompt 15 — Add URL validation to web_fetch:

  const BLOCKED_RANGES = [
    /^(10\.\d+\.\d+\.\d+)/,              // RFC 1918
    /^(172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/, // RFC 1918
    /^(192\.168\.\d+\.\d+)/,             // RFC 1918
    /^(127\.\d+\.\d+\.\d+)/,            // Loopback
    /^(169\.254\.\d+\.\d+)/,            // Link-local
    /^(0\.0\.0\.0)/,                     // All interfaces
  ];

Prompt 14 — Document network-accessing commands:
  "git push, pip install, npm install, npx are network operations
   covered by terminal security (permission required) but NOT by
   egress enforcement (no secret scanning of command output).
   This is by design — terminal output is displayed to the user,
   not sent to providers."

Prompt 08 — Validate Ollama URL:
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(ollamaUrl).hostname)) {
    throw new QicError('QIC-N004', 'Ollama URL must be localhost');
  }
```

### XI-SV7: API Keys in Plaintext settings.json [MEDIUM]

**Detail**: Prompt 18 registers API keys as plain VS Code settings. Settings are stored in plaintext JSON, potentially synced via Settings Sync, and readable by the `read_file` tool.

**Improvement for Prompt 18**:
```
Use VS Code's SecretStorage API for API keys:

  // Instead of configuration settings:
  const apiKey = await this.secretStorageService.get('qic.anthropicApiKey');

  // Store via command:
  registerAction2(class SetApiKeyAction extends Action2 {
    async run(accessor: ServicesAccessor) {
      const key = await inputBox({ prompt: 'Enter Anthropic API Key', password: true });
      await accessor.get(ISecretStorageService).store('qic.anthropicApiKey', key);
    }
  });

  // Remove from settings registration:
  // DELETE: 'qic.provider.anthropicApiKey': { type: 'string', default: '' }
  // DELETE: 'qic.provider.openaiApiKey': { type: 'string', default: '' }
```

### XI-SV8: TOCTOU in Permission Checks [MEDIUM]

**Detail**: Permission check and tool execution are not atomic. Between `PermissionManager.check()` returning and `ToolRouter.execute()` running, the permission could be revoked.

**Improvement for Prompt 10**:
```
For 'once' permissions, consume the grant immediately:

  class PermissionManager {
    async checkAndConsume(tool: ToolDefinition, context: ToolContext):
      Promise<PermissionCheckResult> {
      const result = await this.check(tool, context);
      if (result.status === 'granted' && result.scope === 'once') {
        this.consumeGrant(result.grantId);  // Mark as used immediately
      }
      return result;
    }
  }
```

---

## XII. Audit 10 — Architectural Risk Assessment

System-level architectural analysis for failure modes, resource management, and resilience gaps.

### XII-AR1: SQLite Corruption = Total System Failure [HIGH]

**Failure Mode**: SQLite stores agent state, conversation state, BM25 index, consent records, and permissions. If corrupted, everything fails. No degradation path is defined for database unavailability.

**Improvement for Prompts 03, 11, 18**:
```
Prompt 03 — Enable WAL mode and integrity checking:

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');

Prompt 11 — Add database-specific degradation trigger:

  if (!database.isAvailable()) {
    degradationManager.setLevel(DegradationLevel.LocalOnly);
    // Chat works (in-memory), completions work (no DB needed),
    // but search, state persistence, and audit fail gracefully.
  }

Prompt 18 — Add database recovery to activation:

  await this.step('database', async () => {
    try {
      this.db = new QicDatabase(dbPath);
      await this.db.initialize();
    } catch (error) {
      // Try integrity check
      const check = await this.db.pragma('integrity_check');
      if (check !== 'ok') {
        // Backup corrupted DB, create fresh
        await fs.rename(dbPath, dbPath + '.corrupted.' + Date.now());
        this.db = new QicDatabase(dbPath);
        await this.db.initialize();
        notificationService.warn('QIC database was corrupted and has been reset.');
      }
    }
  });
```

### XII-AR2: Unbounded ConversationState Growth [HIGH]

**Failure Mode**: Tool results can be up to 1MB each. With MAX_TOOL_ROUNDS=25, a single conversation can accumulate 25MB+ in memory. The `messages_json` TEXT column in SQLite has no size limit. Persisting 25MB per state change is expensive.

**Improvement for Prompt 10**:
```
Add conversation size management:

  const MAX_TOOL_RESULT_TOKENS = 10_000;  // Per tool result
  const MAX_CONVERSATION_TOKENS = 200_000; // Total

  // Truncate tool results before appending to conversation:
  private appendToolResult(result: ToolResult): void {
    const truncated = tokenCounter.truncateToFit(result.content, MAX_TOOL_RESULT_TOKENS);
    if (truncated.length < result.content.length) {
      truncated += '\n[... truncated, full result was ' + result.content.length + ' chars]';
    }
    this.conversationState.addMessage({ role: 'tool', content: truncated });
  }

  // Before each re-send, check total size:
  if (this.conversationState.totalTokens > MAX_CONVERSATION_TOKENS) {
    await this.invokeSummarizeLane();
  }
```

### XII-AR3: Deadlock on Permission Dialog + Panel Close [HIGH]

**Failure Mode**: If the user closes the QIC panel while a permission dialog Promise is pending, the Promise may never resolve. The orchestrator hangs indefinitely.

**Improvement for Prompts 10, 12, 13**:
```
Prompt 12 — Handle panel disposal:

  class QicUIService {
    private pendingDialogs = new Map<string, { resolve: Function; reject: Function }>();

    dispose(): void {
      // Reject all pending permission dialogs
      for (const [id, dialog] of this.pendingDialogs) {
        dialog.reject(new CancellationError('QIC panel closed'));
      }
      this.pendingDialogs.clear();
    }
  }

Prompt 10 — Handle dialog cancellation in orchestrator:

  try {
    const approval = await this.uiService.showPermissionDialog(tool, context);
  } catch (e) {
    if (e instanceof CancellationError) {
      return { status: 'denied', reason: 'Panel closed during permission request' };
    }
    throw e;
  }
```

### XII-AR4: No Unified Resource Cleanup [HIGH]

**Failure Mode**: Multiple components hold resources (AbortControllers, file handles, DB connections, Python sidecar, timers) with no unified disposal sequence.

**Improvement for Prompt 18**:
```
Every component must implement IDisposable. Register all with DisposableStore:

  class QicActivation extends Disposable {
    private readonly _store = this._register(new DisposableStore());

    async activate(): Promise<void> {
      // ... initialization ...
      this._store.add(this.db);
      this._store.add(this.indexer);
      this._store.add(this.completionEngine);
      this._store.add(this.pythonSidecar);
      this._store.add(this.reproducibilityLogger);
      this._store.add(this.securityAuditLogger);
      this._store.add(this.cancellationManager);
    }

    // Disposing this class disposes all registered resources in reverse order
  }
```

### XII-AR5: Token Budget Advisory, Not Enforced in Agentic Loop [MEDIUM]

**Detail**: The `ContextAssembler` controls input tokens initially, but after tool rounds, tool results are appended without re-checking the budget. After 10+ rounds, total context far exceeds the lane's budget.

**Improvement for Prompt 10**:
```
Add budget check in the agentic loop:

  while (toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
    // ... execute tools ...

    // Budget check before re-sending
    const totalTokens = tokenCounter.countMessages(this.conversationState.getMessages());
    const budget = LANE_CONFIGURATIONS[lane].input;
    if (totalTokens > budget * 1.5) {
      // Over 150% of budget — truncate old messages
      await this.truncateConversation(budget);
    }

    // Re-send with updated conversation
  }
```

### XII-AR6: Error Propagation Swallowed by Catch Blocks [MEDIUM]

**Detail**: Multiple catch blocks silently swallow errors:
- Activation Step 10 (indexing): `console.warn` only
- Concurrent message queue: `setImmediate` callback has no `.catch()`
- Stream parsing errors: may silently stop data flow

**Improvement for Prompts 10, 18**:
```
Prompt 18 — Activation failures should report degraded features:

  this.step('indexing', async () => {
    await this.indexer.indexWorkspace(workspacePath);
  }).catch(err => {
    this.degradedFeatures.push('code-search');
    notificationService.warn('QIC: Code search unavailable — indexing failed');
  });

Prompt 10 — Queue processing needs error handling:

  if (this.messageQueue.length > 0) {
    const next = this.messageQueue.shift()!;
    this.handleUserMessage(next.message, next.sessionId)
      .then(next.resolve)
      .catch(err => {
        next.reject(err);
        this.uiService.showError('Failed to process queued message');
      });
  }
```

### XII-AR7: No Recovery from EMERGENCY Degradation [MEDIUM]

**Detail**: `DegradationLevel.Emergency` (4) is triggered by OOM/disk full. No recovery conditions are defined. No user-facing "retry" command exists.

**Improvement for Prompt 11**:
```
Add recovery conditions and user command:

  // Recovery conditions
  const RECOVERY_CONDITIONS: Record<DegradationLevel, () => boolean> = {
    [DegradationLevel.Emergency]: () =>
      process.memoryUsage().heapUsed < 400_000_000 &&  // Under 400MB
      this.diskSpaceAvailable() > 100_000_000,          // 100MB free
    [DegradationLevel.LocalOnly]: () =>
      this.circuitBreakers.some(cb => cb.state !== 'open'),
    // ...
  };

  // User command for manual recovery
  registerAction2(class QICRetryConnectionAction extends Action2 {
    id = 'qic.retryConnection';
    title = 'QIC: Retry Connection';
    async run() {
      degradationManager.reevaluate();
    }
  });
```

### XII-AR8: State Recovery Ordering vs Journal Recovery [MEDIUM]

**Detail**: In Prompt 18's activation, Step 1 (crash recovery) and Step 3 (state recovery) run independently. If journal recovery rolls back file writes, the agent state may reference files in a rolled-back state.

**Improvement for Prompt 18**:
```
Pass journal recovery result to state recovery:

  let journalRecoveryResult: RecoveryResult;

  await this.step('crash-recovery', async () => {
    journalRecoveryResult = await JournaledAtomicWriter.recoverFromCrash(journalDir, fileService);
  });

  await this.step('state-recovery', async () => {
    const sessions = await statePersistence.getRecoverableSessions();
    for (const session of sessions) {
      // If journal rolled back files that this session was editing,
      // reset the session to 'idle' instead of 'waiting_approval'
      if (journalRecoveryResult.rolledBackFiles.some(f =>
          session.pendingEdits?.includes(f))) {
        session.state = 'idle';
      }
    }
  });
```

### XII-AR9: Memory Leak in CancellationManager [LOW]

**Detail**: `CancellationManager` maintains `Map<string, CancellationScope>`. Scopes are created for each message but never removed after completion. After thousands of messages, the map grows unboundedly.

**Improvement for Prompt 05**:
```
Add scope cleanup:

  async executeWithScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const scope = this.createScope(scopeId);
    try {
      return await fn();
    } finally {
      this.removeScope(scopeId);  // Clean up after completion
    }
  }
```

---

## XIII. Updated Priority Matrix

### New Findings Summary

| Audit Section | Findings | CRITICAL | HIGH | MEDIUM | LOW |
|---------------|----------|----------|------|--------|-----|
| VII. Deep Spec Alignment | 17 | 1 | 6 | 10 | 0 |
| VIII. Plan Completeness | 9 | 0 | 4 | 5 | 0 |
| IX. Codebase Conflicts | 5 | 1 | 1 | 3 | 0 |
| X. Prompt Sequencing | 9 | 2 | 4 | 3 | 0 |
| XI. Security Vulnerabilities | 8 | 3 | 3 | 2 | 0 |
| XII. Architectural Risks | 9 | 0 | 4 | 4 | 1 |
| **Phase 2 Subtotal** | **57** | **7** | **22** | **27** | **1** |
| Phase 1 (Sections I–IV) | 47 | 2 | 19 | 18 | 8 |
| **Grand Total** | **104** | **9** | **41** | **45** | **9** |

*Note: 25 findings from agent reports were deduplicated or merged with existing findings, reducing from ~129 raw to 57 net new.*

### Tier 0 — Blockers (CRITICAL — must resolve before ANY implementation)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 1 | VII-DS1 | FileContent type variant mismatch between spec and prompts | 02 |
| 2 | IX-CC1 | Ctrl+Shift+N keybinding already bound in Quantlab | 18 |
| 3 | X-PS1 | 5 service identifiers never defined (createDecorator) | 03, 06, 08, 09, 10 |
| 4 | X-PS2 | ToolImplementation type and ToolRouter.register() missing | 04, 10 |
| 5 | XI-SV1 | Secret leakage via error messages (no redaction) | 10, 14 |
| 6 | XI-SV2 | Path traversal via symlinks (workspace escape) | 15 |
| 7 | XI-SV3 | Command injection bypassing prefix allowlist | 14 |

### Tier 1 — Must-Fix Before Implementation (HIGH — blocks correct execution)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 8 | III-QI1 | Integrate with existing Quantlab AI module | 00, 06, 08, 14 |
| 9 | III-QI2 | Reuse existing Python engine (no new sidecar) | 16 |
| 10 | VII-DS2 | Agent state machine timeouts not wired | 05 |
| 11 | VII-DS3 | Streaming handler missing normalization/backpressure | 08 |
| 12 | VII-DS4 | Request manager with prioritization missing | 08 |
| 13 | VII-DS5 | Completion tier selection waterfall missing | 11 |
| 14 | VII-DS6 | INV-T2 tool permission contradiction | 04 |
| 15 | VIII-PC1 | python-env-manager.ts never created | 16 |
| 16 | VIII-PC2 | 4 CI validation scripts never created | 19 |
| 17 | VIII-PC3 | npm dependencies never added to package.json | 03, 05, 09, 16 |
| 18 | VIII-PC4 | deactivate() cleanup never implemented | 18 |
| 19 | IX-CC2 | InlineCompletionProvider integration (use groupId/yieldsToGroupIds) | 11 |
| 20 | IX-CC3 | SQLite native module coexistence (electron-rebuild required) | 03, 05 |
| 21 | X-PS3 | SecurityAuditLogger stub never created | 10 |
| 22 | X-PS4 | UIService chicken-and-egg in activation | 18 |
| 23 | X-PS5 | ProviderAdapter missing sendStreaming() | 04 |
| 24 | X-PS6 | Prompt 14 should execute before Prompt 10 | Sequencing |
| 25 | XI-SV4 | Consent bypass after revocation | 06, 08, 11 |
| 26 | XI-SV5 | XSS via custom markdown renderer | 12 |
| 27 | XI-SV6 | Incomplete egress boundary coverage (SSRF) | 06, 14, 15, 16 |
| 28 | XII-AR1 | SQLite corruption = total system failure | 03, 11, 18 |
| 29 | XII-AR2 | Unbounded ConversationState growth | 10 |
| 30 | XII-AR3 | Deadlock on permission dialog + panel close | 10, 12, 13 |
| 31 | XII-AR4 | No unified resource cleanup (IDisposable) | 18 |
| 32 | IV-AO5 | Concurrent message handling (queue or cancel) | 10 |
| 33 | IV-AO3 | VS Code activation timeout risk | 18 |
| 34 | I-SG7 | Completion and fast-apply bypass paths | 10, 11 |
| 35 | IV-AO7 | Webview communication protocol | 12 |
| 36 | IV-AO1 | Token counting implementation (tiktoken) | 04 |

### Tier 2 — Should-Fix Before Phase 5 (MEDIUM — quality/correctness)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 37–56 | Various | See Sections VII–XII MEDIUM items | Various |

*(All MEDIUM items from Tier 3 of Section VI remain, plus the new MEDIUM items from Sections VII–XII)*

### Tier 3 — Nice-to-Fix (LOW — polish)

| # | ID | Summary | Target Prompt(s) |
|---|----|---------|-------------------|
| 57 | XII-AR9 | Memory leak in CancellationManager | 05 |
| 58–65 | Various | See Section VI Tier 4 items | Various |

---

## Appendix C: Per-Prompt Impact of Deep Audit

Updated count of improvements per prompt including deep audit findings:

| Prompt | Phase 1 | Phase 2 | Total | Highest Severity |
|--------|---------|---------|-------|-----------------|
| **00** | 3 | 0 | 3 | CRITICAL |
| **01** | 1 | 1 | 2 | MEDIUM |
| **02** | 0 | 1 | 1 | CRITICAL |
| **03** | 1 | 4 | 5 | HIGH |
| **04** | 3 | 5 | 8 | CRITICAL |
| **05** | 3 | 5 | 8 | HIGH |
| **06** | 3 | 4 | 7 | HIGH |
| **07** | 1 | 2 | 3 | MEDIUM |
| **08** | 5 | 3 | 8 | HIGH |
| **09** | 3 | 4 | 7 | MEDIUM |
| **10** | 5 | 7 | 12 | CRITICAL |
| **11** | 2 | 4 | 6 | HIGH |
| **12** | 1 | 2 | 3 | HIGH |
| **13** | 0 | 1 | 1 | HIGH |
| **14** | 2 | 4 | 6 | CRITICAL |
| **15** | 3 | 3 | 6 | CRITICAL |
| **16** | 3 | 1 | 4 | CRITICAL |
| **17** | 0 | 0 | 0 | — |
| **18** | 1 | 8 | 9 | CRITICAL |
| **19** | 4 | 2 | 6 | HIGH |
| **20** | 1 | 0 | 1 | MEDIUM |
| **Seq** | 0 | 1 | 1 | HIGH |

The most impacted prompts are **10 (Agent Runtime)** with 12 total findings, **18 (Activation)** with 9, and **04/05/08** with 8 each.

---

*End of Deep Audit Document — 104 total improvements across 10 audit dimensions (47 initial + 57 deep-dive)*
