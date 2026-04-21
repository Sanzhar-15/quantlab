# QIC v6.2 Implementation Plan — v3 (Final Audited)

## Comprehensive Execution Strategy

**Spec Reference**: QIC Technical Specification v6.2 (8,465 lines)  
**Audit Date**: February 2026  
**Version**: 3 — Addresses 14 missing components (v2) + 9 structural defects (v3 self-audit)  
**Methodology**: Dependency-ordered phases with hard quality gates  
**Estimated Duration**: 17–19 weeks  
**Team Assumption**: 4–6 engineers (2 core/platform, 2 feature, 1 security, 1 QA)  
**Target Implementor**: LLM coding agent with full spec access

---

## Pre-Plan: Audit Findings Against Spec v6.2

This plan is the product of a line-by-line audit of the spec against the previous implementation plan, followed by a structural self-audit. The v2 audit identified **14 missing components**, **6 LLM-implementation optimisations**, and **3 structural corrections**. The v3 self-audit identified **9 additional defects** (3 critical, 3 high, 3 medium).

### A. Components Present in Spec but MISSING from Previous Plan (v2 findings)

| # | Component | Spec Section | Lines | Impact |
|---|-----------|-------------|-------|--------|
| 1 | `TimeoutManager` (domain-separated, INV-A4) | §2.5 | 1806–2005 | Foundational — every async operation needs timeout domains |
| 2 | Storage Layer setup (SQLite schema, BM25 tables, LanceDB init, file directories) | §5.1 + §5.2 | 3512–3592 | Foundational — multiple systems depend on DB tables |
| 3 | `StepExecutor` (plan step execution with checkpoints) | §7.1 | 4981–5062 | Core runtime — agent cannot execute plans without it |
| 4 | `ToolRouter` (routes tool calls, permission checks, security integration) | §7.2 | 5062–5163 | Core runtime — agent cannot use tools without it |
| 5 | `PermissionManager` (permission levels, user prompts, decision recording) | §7.2 (referenced) | 5062–5163 | Security — tool execution blocked without permissions |
| 6 | `Gateway` (provider communication wrapper) | §9.x (implicit) | 5514–5600 | Network — all provider calls flow through Gateway |
| 7 | `SecureEmbeddingService` (consent-aware embedding with redaction) | §8.1 | 5165–5227 | Context Engine — RAG pipeline depends on this |
| 8 | `IncrementalIndexer` + RAG Pipeline (batch indexing, BM25+vector) | §8.2 | 5227–5325 | Context Engine — code search is non-functional without it |
| 9 | `Reranker` (Reciprocal Rank Fusion, 4 sources) | §8.3 | 5325–5384 | Context Engine — search quality depends on reranking |
| 10 | `ConflictDetector` (3-level: hash, line, AST) | §6.2 | 4464–4588 | Mutation — edit safety requires conflict detection |
| 11 | LSP Tool Integration (`rename_symbol`, `apply_code_action`, `organize_imports`) | §13.1 | 7974–8016 | 3 of 22 tools unimplemented |
| 12 | Token Budget / Context Assembly (per-lane context window allocation) | §4.3 | 3185–3228 | Every LLM request requires context assembly |
| 13 | UI Layer (chat panel, diff widget, inline completion, permission dialogs, status indicators) | §3.1 | 2071–2119 | User-facing — no interaction possible without UI |
| 14 | VS Code Extension Scaffold (`package.json`, activation events, commands, contribution points) | Implicit | — | Structural — nothing runs without the extension host |

### B. LLM-Implementation Optimisations Applied

1. **Explicit source directory structure** with file paths for every deliverable
2. **Module export/import contracts** — what each module provides and consumes
3. **Spec line-range references** — LLM can read exact code blocks
4. **Anti-patterns section** — common LLM mistakes to avoid
5. **Complete npm dependency list** — no guessing
6. **File-level cross-reference matrix** — every spec section → implementation file

### C. Structural Corrections (v2)

1. **Phase count increased from 9 to 11** — previous Phase 3 was overloaded (mutation engine + error recovery + agent runtime); now split properly
2. **Context Engine added as explicit phase** — was entirely absent; depends on security + storage
3. **UI layer added as explicit phase** — VS Code webview + inline completion are significant work items

### D. v3 Self-Audit Findings (9 defects fixed in this version)

**CRITICAL (would prevent end-to-end execution):**

| # | Defect | Fix |
|---|--------|-----|
| D1 | **No Agent Orchestrator or Lane Router** — every component existed but nothing wired them into an agent loop (user message → lane selection → context assembly → LLM call → tool routing → loop → response) | Added `AgentOrchestrator` + `LaneRouter` as explicit components in Phase 5 |
| D2 | **No Provider Adapters** — `Gateway` had nothing to wrap; Anthropic, OpenAI, and Ollama each need concrete adapters with auth, streaming format, error shape differences | Added `providers/` directory with 3 concrete adapters in Phase 4 |
| D3 | **`extension.ts` activation was a placeholder** — the boot path that initialises the entire system was unspecified | Added complete 12-step activation sequence in Phase 0 |

**HIGH (significant gaps in a working system):**

| # | Defect | Fix |
|---|--------|-----|
| D4 | **Phase 4 overloaded** (7 non-trivial components in 1.5 weeks) | Split: Phase 4 = Network Layer only; Agent Runtime moved to Phase 5 |
| D5 | **No lane routing logic** — system had 8 lanes but no decision mechanism for which lane to use | Added `LaneRouter` with classification strategy in Phase 5 |
| D6 | **UI timeline unrealistic** — chat panel + inline completion + diff widget + dialogs in ~1 week | Expanded to 2 weeks as standalone Phase 7 |

**MEDIUM (LLM would work around but produce sub-optimal code):**

| # | Defect | Fix |
|---|--------|-----|
| D7 | **No Python virtualenv management strategy** | Added `PythonEnvironmentManager` in Phase 9 |
| D8 | **No development/debug workflow** for LLM implementor | Added Development Workflow section |
| D9 | **Inter-module stub interfaces unspecified** — Phase 4 stubs Phase 8's TerminalGuard but never defines the stub contract | Added Stub Interface Contracts section |

---

## Guiding Principles

1. **Critical path first** — Every phase unblocks the next; no phase starts without its predecessor's gate passing.
2. **Invariant-driven** — The 11 system invariants (INV-T1 through INV-A4) are verified at every gate.
3. **Security is concurrent, not deferred** — Security foundations ship alongside the systems they protect.
4. **Spec fidelity** — Every TypeScript interface, enum, and class in the spec has a corresponding implementation file.
5. **Anti-fragile testing** — Kill-and-recover tests at Phase 0; integration tests at every gate; E2E at final phase.

---

## Source Directory Structure

Every implementation file is listed below. The LLM implementor MUST create this structure before beginning Phase 1.

```
qic/
├── package.json
├── tsconfig.json
├── webpack.config.js                    # Extension bundler
├── .vscode/
│   └── launch.json                      # Extension debug config
├── src/
│   ├── extension.ts                     # VS Code extension entry point
│   │
│   ├── canonical/                       # Phase 1 — Single source of truth
│   │   ├── index.ts                     # Re-exports everything
│   │   ├── types.ts                     # EditScript, FileContent, FileEdit, Range, Position, etc.
│   │   ├── lanes.ts                     # LaneName, LaneConfiguration, LANE_CONFIGURATIONS
│   │   ├── tools.ts                     # ToolDefinition, TOOL_REGISTRY (22 tools)
│   │   ├── prompts.ts                   # PROMPT_TEMPLATES (8 templates)
│   │   ├── egress.ts                    # DataCategory, DataDestination, EGRESS_BOUNDARIES
│   │   ├── errors.ts                    # QICError, ConflictError, etc. + ERROR_REGISTRY
│   │   └── interfaces.ts               # UIService, ProviderAdapter, ToolContext, etc.
│   │
│   ├── storage/                         # Phase 1 — Database layer
│   │   ├── database.ts                  # SQLite connection manager
│   │   ├── bm25-schema.ts              # BM25 table creation (§5.2)
│   │   ├── conversation-schema.ts       # Encrypted conversation tables (§5.3)
│   │   ├── state-schema.ts              # Agent/task/conversation state tables (§3.2.4)
│   │   ├── consent-schema.ts            # Consent store tables (§2.4)
│   │   └── vector-index.ts              # LanceDB initialisation
│   │
│   ├── crash-safe/                      # Phase 0 — Crash-safe primitives
│   │   ├── journaled-atomic-writer.ts   # §6.1 — JournaledAtomicWriter
│   │   ├── checkpoint-validity.ts       # §5.4.1 — CV-1 through CV-5
│   │   ├── file-content.ts              # §2.1.1 — FileContent type, stream handling
│   │   └── streaming-secret-scanner.ts  # §2.1.1 — 64KB chunk scanner
│   │
│   ├── state/                           # Phase 1 — State machines
│   │   ├── agent-state-machine.ts       # §3.2.1 + §3.2.4 — PersistentAgentStateMachine
│   │   ├── task-state-machine.ts        # §3.2.2 + §3.2.4 — PersistentTaskStateMachine
│   │   ├── conversation-state.ts        # §3.2.3 — ConversationStateMachine
│   │   └── recovery.ts                  # Startup recovery orchestrator
│   │
│   ├── timeout/                         # Phase 1 — Timeout management
│   │   └── timeout-manager.ts           # §2.5 — TimeoutManager (INV-A4)
│   │
│   ├── cancellation/                    # Phase 1 — Cancellation protocol
│   │   └── cancellation-manager.ts      # §3.3 — CancellationManager
│   │
│   ├── security/                        # Phase 2 + Phase 7
│   │   ├── egress-enforcer.ts           # §2.3.2 — EgressBoundaryEnforcer
│   │   ├── consent-store.ts             # §2.4 — ConsentStore (SQLite-backed)
│   │   ├── first-run-manager.ts         # §2.4 — FirstRunManager
│   │   ├── secret-scanner.ts            # §10.1.1 — OptimizedSecretScanner (Aho-Corasick)
│   │   ├── secret-patterns.ts           # §10.1.2 — All 60+ patterns with test cases
│   │   ├── secret-redactor.ts           # SecretRedactor.redact()
│   │   ├── conversation-cipher.ts       # §5.3 — ConversationCipher (AES-256-GCM)
│   │   ├── terminal-guard.ts            # §10.2 — TerminalSecurityGuard
│   │   ├── tool-chain-monitor.ts        # §10.3 — ToolChainMonitor
│   │   └── audit-logger.ts              # §10.4 — SecurityAuditLogger (hash-chained)
│   │
│   ├── mutation/                        # Phase 3
│   │   ├── mutation-engine.ts           # MutationEngine.apply() with JournaledAtomicWriter
│   │   ├── flexible-matcher.ts          # §6.3 — FlexibleMatcher (7 strategies)
│   │   ├── conflict-detector.ts         # §6.2 — ConflictDetector (3 levels)
│   │   └── approval-token.ts            # ApprovalToken (INV-T1 enforcement)
│   │
│   ├── checkpoint/                      # Phase 3
│   │   └── checkpoint-manager.ts        # §5.4.2 — TransactionSafeCheckpointManager
│   │
│   ├── recovery/                        # Phase 3
│   │   ├── error-recovery-manager.ts    # §3.4 — ErrorRecoveryManager (4-tier)
│   │   └── circuit-breaker.ts           # §9.1 — CircuitBreaker
│   │
│   ├── gateway/                         # Phase 4 — Network layer
│   │   ├── gateway.ts                   # Provider communication wrapper
│   │   ├── rate-limiter.ts              # §9.3 — RateLimiter (token-bucket)
│   │   ├── streaming-handler.ts         # §9.4 — StreamingResponseHandler
│   │   ├── request-manager.ts           # §9.2 — RequestManager (priority queue)
│   │   └── providers/                   # Concrete provider adapters
│   │       ├── anthropic-adapter.ts     # Anthropic Messages API (claude-*)
│   │       ├── openai-adapter.ts        # OpenAI Chat/Completions/FIM API (gpt-*)
│   │       └── ollama-adapter.ts        # Ollama local inference API (codellama, deepseek, etc.)
│   │
│   ├── runtime/                         # Phase 5 — Agent runtime & orchestration
│   │   ├── step-executor.ts             # §7.1 — StepExecutor
│   │   ├── tool-router.ts              # §7.2 — ToolRouter
│   │   ├── permission-manager.ts        # PermissionManager
│   │   ├── agent-orchestrator.ts        # Agent loop: message → lane → context → LLM → tools → response
│   │   └── lane-router.ts              # Lane selection: classify user intent → assign lane
│   │
│   ├── context/                         # Phase 5 — Context Engine
│   │   ├── secure-embedding.ts          # §8.1 — SecureEmbeddingService
│   │   ├── incremental-indexer.ts       # §8.2 — IncrementalIndexer
│   │   ├── reranker.ts                  # §8.3 — Reranker (RRF)
│   │   ├── context-assembler.ts         # §4.3 — Token budget allocation per lane
│   │   └── dynamic-tool-selector.ts     # §8.4 — DynamicToolSelector
│   │
│   ├── completion/                      # Phase 6 — Completion architecture
│   │   ├── completion-engine.ts         # §4.4 — Tiered completion (6 tiers)
│   │   ├── model-registry.ts            # §4.5 — ModelRegistry
│   │   └── fim-adapter.ts              # FIM marker handling for local models
│   │
│   ├── resilience/                      # Phase 6 — Resilience
│   │   ├── degradation-manager.ts       # §12.1 — DegradationManager (5 levels)
│   │   └── memory-manager.ts            # §12.2 — MemoryManager (500MB budget)
│   │
│   ├── quant/                           # Phase 9 — Quant domain
│   │   ├── dataframe-safety.ts          # §11.1 — Safe DataFrame preview
│   │   ├── arrow-bridge.ts              # §11.4 — ArrowDataFrameBridge
│   │   ├── python-sidecar.ts            # §11.5 — PythonSidecar (JSON-RPC)
│   │   ├── python-env-manager.ts        # Virtualenv discovery, creation, dependency install
│   │   ├── time-series.ts              # §11.2 — Time series intelligence
│   │   └── quant-patterns.ts            # §11.3 — Library awareness
│   │
│   ├── lsp/                             # Phase 8 — LSP integration
│   │   └── lsp-tools.ts                 # §13.1 — rename_symbol, apply_code_action, organize_imports
│   │
│   ├── telemetry/                       # Phase 9 — Observability
│   │   ├── telemetry-service.ts         # §12.3 — Opt-in telemetry
│   │   ├── reproducibility-logger.ts    # ReproducibilityLogger (JSONL)
│   │   ├── session-cache.ts             # SessionCache (LRU+TTL)
│   │   └── replay-mode.ts              # ReplayModeSupport
│   │
│   └── ui/                              # Phase 7 — User interface
│       ├── chat-panel.ts                # Chat webview provider
│       ├── inline-completion.ts         # VS Code InlineCompletionProvider
│       ├── diff-widget.ts               # Side-by-side diff preview
│       ├── permission-dialog.ts         # Permission prompt UI
│       ├── first-run-dialog.ts          # First-run consent webview
│       ├── degradation-banner.ts        # Non-dismissible status banner
│       ├── memory-pressure-alert.ts     # Memory warning UI
│       └── checkpoint-ui.ts             # Checkpoint management panel
│
├── python/                              # Python sidecar package
│   ├── setup.py
│   ├── requirements.txt                 # numpy, pandas, scipy, pyarrow
│   └── qic_sidecar/
│       ├── __init__.py
│       ├── server.py                    # JSON-RPC stdin/stdout server
│       ├── time_series.py               # Time series analysis
│       ├── backtest.py                  # Backtest metrics
│       └── statistics.py                # Statistical tests
│
├── test/
│   ├── unit/                            # Mirror src/ structure
│   ├── integration/
│   ├── e2e/
│   ├── security/
│   ├── performance/
│   └── crash-recovery/
│
└── scripts/
    ├── validate-lane-prompts.ts         # CI: §14.2 check 4
    ├── validate-tool-registry.ts        # CI: §14.2 check 5
    ├── validate-file-content-types.ts   # CI: §14.2 check 8
    ├── validate-state-persistence.ts    # CI: §14.2 check 9
    └── validate-model-registry.ts       # CI: §14.2 check 10
```

---

## npm Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "lancedb": "^0.5.0",
    "apache-arrow": "^15.0.0",
    "aho-corasick": "^1.0.0"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "webpack": "^5.90.0",
    "webpack-cli": "^5.1.0",
    "ts-loader": "^9.5.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@types/jest": "^29.5.0"
  }
}
```

**Note for LLM**: If `aho-corasick` npm package is unavailable or has compatibility issues, implement a pure-JS Aho-Corasick automaton (~200 lines). The spec explicitly allows this fallback.

---

## Anti-Patterns for LLM Implementors

**DO NOT:**
1. Use synchronous `fs` calls in the extension host — VS Code extension host is single-threaded; sync I/O blocks all extensions. Always use `fs.promises` or `vscode.workspace.fs`.
2. Use `fs.renameSync` on Windows and assume atomicity — it is NOT atomic when the target exists. Use `MoveFileEx` via native binding or write-new-then-delete-old.
3. Store secrets in `vscode.workspace.getConfiguration()` — use `context.secrets` (VS Code SecretStorage API) for key material.
4. Import Node.js `crypto` in webview code — webviews run in a browser sandbox; use `crypto.subtle` (Web Crypto API) for webview-side crypto.
5. Forget `fsync` after journal writes — the entire crash-safety model depends on journal durability before mutations begin.
6. Return `boolean` from permission checks — spec invariant: always return `PermissionCheckResult` (status + reason + prompt).
7. Use raw string file content for files > 1MB — always use `FileContent` discriminated union (inline/stream/reference).
8. Register more than 8 tools per LLM request — token budget is 2000 tokens for tool schemas; exceeding this wastes context.
9. Use `setTimeout` for user-facing timeouts — use `TimeoutManager` with appropriate domain (`USER_INTERACTION` has no timeout).
10. Create circular dependencies between modules — the dependency graph is strictly layered: canonical → storage → crash-safe → state → security → mutation → runtime → gateway → context → completion → resilience.

---

## Dependency Graph

```
Phase 0: Extension Scaffold + Crash-Safe Primitives
    │
    ├──► Phase 1: Foundation Layer (types, storage, state machines, timeouts, cancellation)
    │       │
    │       ├──► Phase 2: Security Foundation (egress, consent, secrets, encryption)
    │       │
    │       └──► Phase 3: Mutation & Reliability (mutation engine, checkpoints, error recovery, circuit breakers)
    │               │
    │               └──► Phase 4: Network Layer (gateway, provider adapters, rate limiter, streaming, request mgr)
    │                       │
    │                       └──► Phase 5: Agent Runtime & Context Engine
    │                               │     (orchestrator, lane router, step executor, tool router,
    │                               │      embedding, indexing, reranking, context assembly)
    │                               │
    │                               └──► Phase 6: Completion & Resilience
    │                                       │     (tiered completion, model registry, degradation, memory)
    │                                       │
    │                                       ├──► Phase 7: UI Layer (2 weeks — chat, inline, diff, dialogs)
    │                                       │
    │                                       ├──► Phase 8: Security Hardening (terminal guard, tool chain, audit)
    │                                       │
    │                                       └──► Phase 9: Quant Domain + LSP
    │                                               │
    │                                               └──► Phase 10: Telemetry & Documentation
    │
    └──► Phase 11: Integration Testing & Stabilisation (requires ALL phases)
```

**Key structural change from v2:** Phases 4 and 5 are separated. Phase 4 (Network) provides the transport layer. Phase 5 (Agent Runtime + Context Engine) builds everything that uses the transport layer, culminating in the `AgentOrchestrator` — the central loop that connects every component into a running system. Without this separation, a smart LLM would build 50 perfect modules with no orchestration layer to connect them.

---

## Phase 0 — VS Code Extension Scaffold + Crash-Safe Primitives

**Duration**: 1 week (Week 1)  
**Gate**: BLOCKING — no other phase may begin until Phase 0 validates.  
**Rationale**: The extension cannot load without a scaffold. Four V6.2 Tier-1 audit findings (journaled atomicity, checkpoint validity, stream-based file handling, state persistence) are foundational. Every downstream system depends on at least one of these primitives being crash-safe.

### 0.0 Extension Scaffold

| Detail | Value |
|--------|-------|
| Files | `package.json`, `tsconfig.json`, `webpack.config.js`, `src/extension.ts`, `.vscode/launch.json` |
| Duration | Day 0 (prerequisite setup) |

**What to build:**

- `package.json` with:
  - `activationEvents`: `["onStartupFinished"]` (lazy activation, don't block VS Code startup)
  - `contributes.commands`: `qic.openChat`, `qic.toggleCompletion`, `qic.showSettings`, `qic.createCheckpoint`, `qic.restoreCheckpoint`
  - `contributes.configuration`: provider API keys, model preferences, consent overrides
  - `contributes.viewsContainers` + `contributes.views`: QIC sidebar with chat panel
  - All npm dependencies listed above
- `tsconfig.json` with `"strict": true`, `"target": "ES2022"`, `"module": "commonjs"`
- `webpack.config.js` for extension bundling (target: `"node"`, externals: `["vscode"]`)
- `src/extension.ts` with:
  - `activate(context: vscode.ExtensionContext)` — entry point (full sequence below)
  - `deactivate()` — cleanup (flush audit logs, stop sidecar, persist state, close DB)

**Activation Sequence (CRITICAL — this is the boot path):**

The LLM implementor MUST implement this exact sequence in `extension.ts`. Every step depends on the previous.

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Step 1: Initialise storage (SQLite, LanceDB, directories)
  const db = await initializeDatabase(context.globalStorageUri);
  const vectorIndex = await initializeVectorIndex(context.globalStorageUri);

  // Step 2: Crash recovery — BEFORE any user interaction
  const journalRecoveries = await JournaledAtomicWriter.recoverFromCrash(workspaceRoot);
  const checkpointRecoveries = await CheckpointValidator.recoverOnStartup(db);
  const stateRecoveries = await PersistentAgentStateMachine.recover(db, sessionId);

  // Step 3: Show recovery notification if anything was recovered
  if (journalRecoveries.length || checkpointRecoveries.length || stateRecoveries) {
    await uiService.showRecoveryPrompt(journalRecoveries, checkpointRecoveries, stateRecoveries);
  }

  // Step 4: Initialise security layer (consent store, secret scanner, cipher)
  const consentStore = new ConsentStore(db);
  const secretScanner = new OptimizedSecretScanner();
  const cipher = new ConversationCipher(context.secrets);
  await cipher.initialize();

  // Step 5: First-run consent — BLOCKS all egress until completed
  const firstRunManager = new FirstRunManager(consentStore, uiService);
  await firstRunManager.checkAndShowIfNeeded();

  // Step 6: Initialise network layer (gateway, providers, rate limiter)
  const gateway = new Gateway(consentStore, secretScanner, auditLogger);
  gateway.registerProvider(new AnthropicAdapter(config));
  gateway.registerProvider(new OpenAIAdapter(config));
  gateway.registerProvider(new OllamaAdapter(config));

  // Step 7: Initialise context engine (embedding, indexer)
  const embeddingService = new SecureEmbeddingService(gateway, consentStore, secretScanner);
  const indexer = new IncrementalIndexer(db, vectorIndex, embeddingService);

  // Step 8: Start background indexing (non-blocking)
  indexer.startBackgroundIndex(workspaceRoot);

  // Step 9: Initialise agent runtime (orchestrator, tool router)
  const orchestrator = new AgentOrchestrator(gateway, indexer, toolRouter, stepExecutor, laneRouter);

  // Step 10: Register VS Code providers
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider('*', completionProvider),
  );

  // Step 11: Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('qic.openChat', () => chatPanel.reveal()),
    vscode.commands.registerCommand('qic.toggleCompletion', () => completionEngine.toggle()),
    vscode.commands.registerCommand('qic.showSettings', () => firstRunManager.showSettingsUI()),
    vscode.commands.registerCommand('qic.createCheckpoint', () => checkpointManager.createInteractive()),
    vscode.commands.registerCommand('qic.restoreCheckpoint', () => checkpointManager.restoreInteractive()),
  );

  // Step 12: Register file watchers for incremental indexing
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(uri => indexer.queueChange({ path: uri.fsPath, type: 'modified' }));
  watcher.onDidCreate(uri => indexer.queueChange({ path: uri.fsPath, type: 'created' }));
  watcher.onDidDelete(uri => indexer.queueChange({ path: uri.fsPath, type: 'deleted' }));
  context.subscriptions.push(watcher);
}
```

The LLM should implement this as a skeleton in Phase 0, filling in each component as its phase completes. Use `// TODO: Phase N` comments for unimplemented components.
- `.vscode/launch.json` for Extension Development Host debugging

**Acceptance criteria:**

- Extension loads in VS Code Development Host without errors.
- Commands appear in command palette.
- Extension can be launched and debugged from VS Code.

### 0.1 JournaledAtomicWriter

| Detail | Value |
|--------|-------|
| Spec Reference | §6.1 (lines 3990–4464) |
| File | `src/crash-safe/journaled-atomic-writer.ts` |
| Invariant | INV-A2 (Atomic Multi-File Operations) |
| Duration | Days 1–2 |

**What to build:**

- Transaction journal protocol: `PREPARING → COMMITTING → COMMITTED → ROLLING_BACK`
- Journal file at `.qic-journal/{txId}.journal` with `fsync` before any filesystem mutation
- Per-operation completion tracking inside the journal
- `recoverFromCrash(workspaceRoot)` startup scanner for `.qic-journal/`
- Roll-forward for COMMITTING state, roll-back for PREPARING/ROLLING_BACK
- Checksum verification: SHA-256 of serialised operations array
- Quarantine logic for corrupt or checksum-mismatched journals
- Disk space pre-check: 2× total file size of all operations

**Implementation details (from spec lines 3992–4464):**

```typescript
// Key types to implement:
enum TransactionState { PREPARING, COMMITTING, COMMITTED, ROLLING_BACK }

interface TransactionJournal {
  txId: string;
  state: TransactionState;
  operations: JournalOperation[];
  checksum: string;      // SHA-256 of JSON.stringify(operations)
  createdAt: string;
  completedOperations: number[];  // indices of completed ops
}

interface JournalOperation {
  index: number;
  type: 'create' | 'modify' | 'delete' | 'rename';
  targetPath: string;
  stagingPath: string;   // .qic-staging/{txId}/{index}
  backupPath?: string;   // Original content for rollback
  completed: boolean;
}
```

- Staging directory: `.qic-staging/{txId}/` — write-only workspace; originals buffered in memory for rollback
- Temp files use `.qic-tmp` suffix in the same directory as target (required for atomic `rename(2)` on same filesystem)
- Journal updates after each operation: re-write full journal file, then `fsync`
- On Windows: `rename` is NOT atomic over NTFS when target exists → use `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` or write-new-then-delete-old

**Exports:** `JournaledAtomicWriter`, `TransactionJournal`, `TransactionState`  
**Imports:** `FileContent` from `./file-content`

**Acceptance criteria:**

- Kill process mid-transaction (after journal write, before all renames complete) → restart → recovery completes remaining renames.
- Kill process before journal write → restart → no orphaned temp files, no partial state.
- Corrupt journal checksum → quarantine, do not apply.
- Journal write latency < 10ms (p95) on SSD.
- Disk space insufficient → `DiskSpaceError` thrown before any writes.

### 0.2 Checkpoint Validity Rules (CV-1 through CV-5)

| Detail | Value |
|--------|-------|
| Spec Reference | §5.4.1 (lines 3718–3851) |
| File | `src/crash-safe/checkpoint-validity.ts` |
| Invariant | INV-A3 (Checkpoint Crash Safety) |
| Duration | Days 2–3 |

**What to build:**

- CV-1: File must have `.checkpoint` extension
- CV-2: Corresponding `.complete` marker file must exist → quarantine if missing
- CV-3: Decryption must succeed with current AES-256-GCM key → quarantine if fails
- CV-4: Internal checksum (SHA-256) must match → quarantine if mismatch
- CV-5: Schema version must be compatible → attempt migration; quarantine if migration fails
- Quarantine directory (`{workspaceStorage}/checkpoints/quarantine/`) with 7-day retention and automatic cleanup
- `recoverOnStartup()` that scans for incomplete checkpoints: `.pending` without `.complete`, `.restoring` markers
- `validateCheckpoint(path)` → returns `{ valid: boolean; rule: string; error?: string }`

**Exports:** `CheckpointValidator`, `CheckpointValidationResult`, `QuarantineManager`  
**Imports:** None (standalone primitives)

**Acceptance criteria:**

- `.checkpoint` without `.complete` → quarantined, user notified.
- Checksum corruption → quarantine.
- Schema version mismatch → migration attempted; if migration fails, quarantine.
- Quarantine files older than 7 days auto-deleted on startup.

### 0.3 Stream-Based File Handling

| Detail | Value |
|--------|-------|
| Spec Reference | §2.1.1 (lines 210–444 — FileContent type, FileHandlingConfig, StreamingSecretScanner) |
| File | `src/crash-safe/file-content.ts` + `src/crash-safe/streaming-secret-scanner.ts` |
| Duration | Days 3–4 |

**What to build:**

- `FileContent` discriminated union: `inline` (< 1MB raw string), `stream` (1–50MB → `ReadableStream`), `reference` (for checkpoints — path + hash, no content loaded)
- `FileHandlingConfig` with size tiers and exclusion patterns (`*.csv`, `*.parquet`, `*.arrow`, `*.h5`, `*.pkl`, etc.)
- Updated `CheckpointFile` interface: `contentRef: FileContent` instead of `content: string`
- `StreamingSecretScanner`: 64KB chunk processing with 1KB overlap for patterns spanning chunk boundaries
- Integration point: `JournaledAtomicWriter.applyFileEdit()` must handle `FileContent.stream` for create operations

**Exports:** `FileContent`, `FileHandlingConfig`, `StreamingSecretScanner`, `CheckpointFile`  
**Imports:** None

**Acceptance criteria:**

- Process a 100MB file without OOM (RSS stays under 500MB total budget).
- `StreamingSecretScanner` finds the same secrets as the inline scanner on identical content.
- Excluded file types are never loaded into memory for processing.
- `FileContent.stream` works end-to-end through `JournaledAtomicWriter`.

### 0.4 State Machine Persistence (SQLite)

| Detail | Value |
|--------|-------|
| Spec Reference | §3.2.4 (lines 2274–2444) |
| File | `src/state/agent-state-machine.ts` + `src/state/task-state-machine.ts` (persistence layer only — full FSM wiring in Phase 1) |
| Duration | Days 4–5 |

**What to build:**

- Three SQLite tables: `qic_agent_state`, `qic_task_state`, `qic_conversation_state`
- `PersistentAgentStateMachine` — persists on every state transition via `onTransition()` hook
- `PersistentTaskStateMachine` — persists state, current step, plan, and completed steps
- Static `recover(db, sessionId)` methods on both classes
- Recovery UX: show user "Session Recovered" with Continue / Start Fresh options
- Conversation state stores encrypted messages (via `ConversationCipher` — Phase 2 dependency; stub encryption for now)
- Persist on: state-transition, step-complete, tool-call-start, tool-call-end

**Exports:** `PersistentAgentStateMachine`, `PersistentTaskStateMachine`, `AgentState`, `TaskState`  
**Imports:** `better-sqlite3`

**Acceptance criteria:**

- Kill process during PROCESSING state → restart → agent recovers to correct state, user prompted.
- Kill process mid-task → restart → task resumes from last completed step OR rolls back to checkpoint.
- Conversation context survives crash and is recoverable (encryption tested after Phase 2).

### Phase 0 Gate

All four subsystems must pass independently before unlocking Phase 1:

```
□ Extension scaffold loads in VS Code Development Host
□ JournaledAtomicWriter crash-injection tests (5 scenarios: kill-during-write, kill-before-journal, corrupt-journal, disk-full, concurrent-access)
□ Checkpoint validity rules (CV-1 through CV-5, 8 scenarios)
□ Stream-based file handling (100MB file, no OOM, RSS < 500MB)
□ State machine persistence (kill-and-recover, 3 FSMs)
□ Journal write latency < 10ms (p95)
□ All unit tests pass in CI
```

---

## Phase 1 — Foundation Layer

**Duration**: 1 week (Week 2)  
**Dependencies**: Phase 0 complete  
**Rationale**: Canonical types, storage initialisation, state machines, timeouts, and cancellation form the skeleton that all features attach to. Every subsequent phase imports from this layer.

### 1.1 Canonical Type Module

| Detail | Value |
|--------|-------|
| Spec Reference | §2.1.1–§2.1.3 (lines 206–964), §3.5 (lines 2798–3113), Appendix A (lines 8177–8233), Appendix B (lines 8233–8304) |
| Files | `src/canonical/types.ts`, `src/canonical/lanes.ts`, `src/canonical/tools.ts`, `src/canonical/prompts.ts`, `src/canonical/egress.ts`, `src/canonical/errors.ts`, `src/canonical/interfaces.ts`, `src/canonical/index.ts` |

**What to build — complete list:**

`types.ts`:
- `EditScript`, `FileEdit`, `TextChange`, `Range`, `Position`, `EditScriptMetadata`, `EditSource`
- `FileContent` (re-export from crash-safe), `FileHandlingConfig`, `CheckpointFile`
- `PermissionCheckResult`, `PermissionLevel` (status: granted/denied/ask-user/ask-user-once)
- `FileChange`, `FileState`, `EmbeddingResult`, `EmbeddingConfig`, `EmbedOptions`
- `ApplyContext`, `ApplyResult`, `FileValidator`, `ValidationResult`
- `PlanStep`, `StepResult`
- `QueuedRequest`, `Priority`, `Request`
- `ServiceState`, `ProviderHealth`
- `ConflictInfo` (from §6.2)

`lanes.ts`:
- `LaneName` (8 lanes: completion, chat-ask, chat-gather, chat-plan, chat-act, repair, fast-apply, summarize)
- `LaneConfiguration` with token budgets, allowed tools, prompt keys, temperature, top_p
- `LANE_CONFIGURATIONS` constant (all 8 lanes)

`tools.ts`:
- `ToolDefinition` interface (name, description, parameters JSON schema, hasSideEffects, permission)
- `TOOL_REGISTRY` — all 22 tools with complete JSON schemas and permission definitions
- Tool validation: `TOOL_COUNT === 22` assertion at module load

`prompts.ts`:
- `PROMPT_TEMPLATES` — all 8 lane prompt templates
- `validateLanePromptMapping()` — run at module load; every lane's `promptKey` must exist

`egress.ts`:
- `DataCategory` enum (8 values: USER_CODE, USER_SECRETS, SESSION_STATE, SYSTEM_CONFIG, METRICS, CHECKPOINTS, NOTEBOOK_STATE, EMBEDDING_INPUT)
- `DataDestination` enum (6 values)
- `DataEgressBoundary` interface
- `EGRESS_BOUNDARIES` array (5 boundaries from §2.3.2)

`errors.ts`:
- All error classes: `QICError`, `ConflictError`, `ValidationError`, `DiskSpaceError`, `CancellationError`, `EmbeddingConsentRequiredError`, `CircuitOpenError`, `LoadSheddingError`, `SourceLimitError`, `ModelUnavailableError`
- `ERROR_REGISTRY` — all 30+ error codes from Appendix B (categories: T, P, S, C, E, J, R, M, X, Y)

`interfaces.ts`:
- `UIService` (10 methods: showPermissionDialog, showFirstRunConsent, showPrivacySettings, showError, showWarning, showToolChainWarning, showDegradationBanner, hideDegradationBanner, showInfo, showRecoveryPrompt)
- `ProviderAdapter` (id, name, type, isAvailable, getHealth, sendRequest, cancelRequest)
- `ProviderRequest` (id, type, model, messages, prompt, maxTokens, temperature, stopSequences, signal)
- `ToolContext` (sessionId, taskId, lane, ui, workspaceRoot, signal)
- `ErrorContext` (step, checkpointId, context, request, workspaceRoot, modifiedFiles)
- `ExecutionContext` (taskScopeId, modifiedFiles, workspaceRoot)
- `EmbeddingProvider` (id, name, dimensions, maxTokens, embed, embedBatch)
- `ChainAnalysis`, `DataFlowAnalysis`, `ToolCallRecord`

`index.ts`:
- Re-exports everything from all canonical files
- `validateLanePromptMapping()` called at import time

**CI enforcement:** No other module may define these types. CI grep check.

**Acceptance criteria:**

- Module compiles with `--strict`
- `validateLanePromptMapping()` passes (8 lanes × 8 templates)
- All 22 tools registered with complete JSON schemas
- `TOOL_COUNT === 22` assertion passes
- All error codes in `ERROR_REGISTRY` have `name`, `severity`, `userMessage`
- No duplicate type definitions across codebase (CI check)

### 1.2 Storage Layer Initialisation

| Detail | Value |
|--------|-------|
| Spec Reference | §5.1 (lines 3512–3538), §5.2 (lines 3538–3592) |
| Files | `src/storage/database.ts`, `src/storage/bm25-schema.ts`, `src/storage/conversation-schema.ts`, `src/storage/state-schema.ts`, `src/storage/consent-schema.ts`, `src/storage/vector-index.ts` |

**What to build:**

`database.ts`:
- SQLite connection manager using `better-sqlite3`
- Database at `{workspaceStorage}/qic.db` (use `context.globalStorageUri` or `context.storageUri`)
- WAL mode enabled, foreign keys on
- `initializeDatabase()` runs all schema creation scripts
- `getDb()` singleton accessor

`bm25-schema.ts`:
- Create tables: `qic_bm25_terms`, `qic_bm25_postings`, `qic_bm25_docs`
- Create FTS5 virtual table: `qic_bm25_fts5`
- All indexes as specified in §5.2

`conversation-schema.ts`:
- Create table: `conversations_encrypted` (id, session_id, encrypted_content BLOB, iv BLOB, auth_tag BLOB, created_at, updated_at, message_count, metadata_json)
- Indexes on session_id and updated_at

`state-schema.ts`:
- Create tables: `qic_agent_state`, `qic_task_state`, `qic_conversation_state`
- Schema matches §3.2.4

`consent-schema.ts`:
- Create table: `consent_records` (category_id, granted, granted_at, granted_by, version)
- Create table: `first_run_status` (completed, completed_at)

`vector-index.ts`:
- LanceDB initialisation at `{workspaceStorage}/vectors.lance`
- Create tables: `code_embeddings`, `doc_embeddings`
- Schema: `{ path: string, vector: Float32Array, contentHash: string, updatedAt: string }`

**File directories to create on startup:**
- `{workspaceStorage}/checkpoints/`
- `{workspaceStorage}/checkpoints/quarantine/`
- `{workspaceStorage}/logs/`
- `{workspaceStorage}/recordings/`
- `{workspaceStorage}/security-audit/`

**Exports:** `initializeDatabase`, `getDb`, `initializeVectorIndex`  
**Imports:** `better-sqlite3`, `lancedb`

**Acceptance criteria:**

- All tables created on first activation.
- Second activation is idempotent (no errors from `IF NOT EXISTS`).
- BM25 tables use `qic_bm25_` prefix consistently (CI check from §14.2).

### 1.3 State Machines + Persistence Integration

| Detail | Value |
|--------|-------|
| Spec Reference | §3.2.1–§3.2.3 (lines 2119–2274) |
| Files | `src/state/agent-state-machine.ts`, `src/state/task-state-machine.ts`, `src/state/conversation-state.ts`, `src/state/recovery.ts` |

**What to build:**

- Wire `PersistentAgentStateMachine` (from Phase 0) with full transition map from §3.2.1:
  - CREATED → [starting]
  - STARTING → [ready, failed, degraded]
  - READY → [processing, shutdown, degraded]
  - PROCESSING → [ready, waiting-input, waiting-approval, paused, failed, degraded]
  - WAITING_INPUT → [processing, paused, shutdown]
  - WAITING_APPROVAL → [processing, paused, shutdown]
  - PAUSED → [processing, ready, shutdown]
  - DEGRADED → [ready, failed, shutdown]
  - FAILED → [starting, shutdown]
  - SHUTDOWN → [] (terminal)
- Timeout per state (from spec): STARTING=30s, PROCESSING=300s, WAITING_INPUT=600s, WAITING_APPROVAL=300s, DEGRADED=300s
- Wire `PersistentTaskStateMachine` with full transition map from §3.2.2
- `ConversationStateMachine` with persistence
- `recovery.ts`: orchestrates startup recovery (journal → checkpoints → state machines → user notification)

**Acceptance criteria:**

- Every valid transition succeeds; every invalid transition throws.
- Timeouts fire correctly (e.g., PROCESSING → PAUSED after 300s).
- State machines persist on every transition.
- Recovery orchestrator integrates all recovery paths.

### 1.4 Timeout Manager

| Detail | Value |
|--------|-------|
| Spec Reference | §2.5 (lines 1806–2005) |
| File | `src/timeout/timeout-manager.ts` |
| Invariant | INV-A4 (Timeout Domain Separation) |

**What to build:**

- `TimeoutDomain` enum: `USER_INTERACTION`, `EXECUTION`, `NETWORK`, `BACKGROUND`
- `TimeoutConfiguration` per domain:
  - USER_INTERACTION: no timeout (null), not extendable
  - EXECUTION: 60s default, 300s max, 3 extensions of 60s each
  - NETWORK: 30s default, 120s max, 2 extensions of 30s each
  - BACKGROUND: 300s default, 600s max, not extendable
- `TimeoutManager` class with methods: `create()`, `extend()`, `cancel()`, `getRemainingTime()`, `isInUserInteractionDomain()`
- Helper methods: `createUserInteraction()`, `createExecution()`, `createNetwork()`, `createBackground()`

**Exports:** `TimeoutManager`, `TimeoutDomain`, `TimeoutHandle`  
**Imports:** None

**Acceptance criteria:**

- USER_INTERACTION timeouts never fire (null timeout).
- EXECUTION timeout fires after 60s (default), extendable 3 times.
- NETWORK timeout fires after 30s.
- Extension beyond max total duration is rejected.
- `cancel()` prevents timeout from firing.

### 1.5 Cancellation Protocol

| Detail | Value |
|--------|-------|
| Spec Reference | §3.3 (lines 2444–2568) |
| File | `src/cancellation/cancellation-manager.ts` |
| Invariant | INV-T5 (Cancellation Safety) |

**What to build:**

- Hierarchical `AbortController` scopes: session → task → step → request
- `createScope(id, level, parentId)` — creates child scope linked to parent
- Parent cancellation propagates to all children
- Cleanup hooks per scope level (flush-logs, persist-state, rollback-pending-edits)
- `checkCancellation(signal)` utility that throws `CancellationError` if aborted
- `onCancel(signal, callback)` for registering cleanup

**Exports:** `CancellationManager`, `CancellationError`  
**Imports:** None

**Acceptance criteria:**

- Cancel session → all child tasks, steps, requests cancelled.
- Cancel step → only that step's requests cancelled; parent task unaffected.
- Cleanup hooks run in reverse registration order.
- `checkCancellation` throws immediately if already cancelled.

### Phase 1 Gate

```
□ Canonical type module compiles with --strict, no duplicate definitions
□ All 8 prompt templates pass validateLanePromptMapping()
□ All 22 tools registered with complete JSON schemas
□ All SQLite tables created (BM25, conversations, state, consent)
□ LanceDB initialised with code_embeddings + doc_embeddings tables
□ State machines transition correctly (unit tests for every valid/invalid transition)
□ TimeoutManager: USER_INTERACTION never times out; EXECUTION times out at 60s
□ Cancellation propagates through 4-level hierarchy
□ CI schema validation script (§14.2 checks 1–6) passes
```

---

## Phase 2 — Security Foundation

**Duration**: 1 week (Week 3)  
**Dependencies**: Phase 1 complete (canonical types, storage layer)  
**Rationale**: Security must be in place before any feature sends data externally. This is not optional hardening — it's a prerequisite for the gateway. INV-T3 (Secret Protection) is enforced from this phase forward.

### 2.1 Data Egress Controls

| Detail | Value |
|--------|-------|
| Spec Reference | §2.3.2 (lines 1562–1647) |
| File | `src/security/egress-enforcer.ts` |

- `EgressBoundaryEnforcer` wrapping every external call site
- 5 boundaries from `EGRESS_BOUNDARIES`: egress-llm-chat, egress-llm-completion, egress-embedding, egress-web-search, egress-telemetry
- Each boundary checks: consent status → secret redaction → audit logging → proceed or block
- Integration point stubs (actual integration when Gateway is built in Phase 4): `Gateway.send()`, `SecureEmbeddingService.embed()`, `TelemetryService.send()`, `CheckpointManager.export()`, `Logger.write()`
- `enforceEgress(boundaryId, data, context)` → returns `{ allowed: boolean; redactedData: any; reason?: string }`

### 2.2 Consent Store + First-Run Manager

| Detail | Value |
|--------|-------|
| Spec Reference | §2.4 (lines 1647–1806) |
| Files | `src/security/consent-store.ts`, `src/security/first-run-manager.ts` |

- `ConsentStore` backed by SQLite (consent_records table from Phase 1)
- 5 consent categories matching `CONSENT_CATEGORIES` from spec: AI Chat, Code Completion, Codebase Indexing, Web Search, Telemetry
- `FirstRunManager.checkAndShowIfNeeded()` called on activation, before any egress
- Privacy settings UI accessible from command palette (command: `qic.showSettings`)
- Consent records include: categoryId, granted, grantedAt, grantedBy, version
- `ConsentStore.get()`, `set()`, `getAll()`, `revoke()`, `revokeAll()`, `hasCompletedFirstRun()`, `markFirstRunComplete()`

### 2.3 Secret Scanner (Aho-Corasick)

| Detail | Value |
|--------|-------|
| Spec Reference | §10.1.1 (lines 6240–6379), §10.1.2 (lines 6379–6945) |
| Files | `src/security/secret-scanner.ts`, `src/security/secret-patterns.ts`, `src/security/secret-redactor.ts` |

- Implement all 60+ secret patterns from §10.1.2 with test cases (`shouldMatch` / `shouldNotMatch`)
- 24 static prefixes for fast pre-filtering: `AKIA`, `AIza`, `sk-`, `ghp_`, `gho_`, `glpat-`, `xoxb-`, `xoxp-`, `SG.`, `rk_live_`, etc.
- `OptimizedSecretScanner` with two-phase scan: Aho-Corasick prefix match → targeted regex validation
- `scanFileAdaptive()`: inline scan for files < 1MB, `StreamingSecretScanner` (from Phase 0) for larger
- `SecretRedactor.redact()` → `{ redactedText: string; matches: SecretMatch[] }`
- Integration with `StreamingSecretScanner` from Phase 0 for files 1–50MB

### 2.4 Encrypted Storage

| Detail | Value |
|--------|-------|
| Spec Reference | §5.3 (lines 3592–3716) |
| File | `src/security/conversation-cipher.ts` |

- `ConversationCipher` with AES-256-GCM (spec lines 3600–3716)
- Key derivation: generate 32-byte random key → store via VS Code `context.secrets` (SecretStorage API)
- `encrypt(plaintext)` → `{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }`
- `decrypt(data)` → `string`
- Use Node.js `crypto.randomBytes(12)` for IV generation
- Web Crypto API `crypto.subtle` for encrypt/decrypt
- Checkpoint encryption at rest using same cipher
- Now wire into state machine persistence from Phase 0 (replace encryption stubs)

### Phase 2 Gate

```
□ No external call succeeds without consent check (integration test with mocked providers)
□ First-run dialog blocks all egress until completed
□ All 60+ secret patterns pass their test cases (shouldMatch + shouldNotMatch)
□ Aho-Corasick scanner produces identical results to sequential regex scanner (correctness parity test)
□ Aho-Corasick scan is ≥ 3× faster than sequential regex on 10MB input (benchmark)
□ Conversation encryption round-trips correctly (encrypt → decrypt → compare)
□ Checkpoint encryption survives write-read-verify cycle
□ Conversation state persistence now uses real encryption (Phase 0 stubs replaced)
□ CI: §14.2 check 2 passes (no boolean permission returns)
```

---

## Phase 3 — Mutation Engine & Core Reliability

**Duration**: 1.5 weeks (Weeks 4–5)  
**Dependencies**: Phase 0 (journaled writer), Phase 1 (state machines, cancellation, timeout), Phase 2 (secret scanner)  
**Rationale**: This phase integrates the Phase 0 crash-safe primitives into the full mutation pipeline, adds conflict detection, error recovery, and circuit breakers. These are the reliability primitives that all provider interactions depend on.

### 3.1 Mutation Engine Integration

| Detail | Value |
|--------|-------|
| Spec Reference | §6.1 (lines 3990–4464), §6.3 (lines 4588–4977) |
| Files | `src/mutation/mutation-engine.ts`, `src/mutation/flexible-matcher.ts`, `src/mutation/approval-token.ts` |

- Wire `JournaledAtomicWriter` into `MutationEngine.apply()` (replaces any legacy `AtomicMultiFileWriter` references)
- `ApprovalToken` requirement for all disk writes — INV-T1 enforcement:
  - `ApprovalToken` is an opaque object created only by user approval flow
  - `MutationEngine.apply(editScript, approvalToken)` — token required at type level
  - No filesystem mutation without a valid token
- `FlexibleMatcher` with all 7 strategies from §6.3:
  1. Exact match
  2. Line-shifted match (content moved by ±N lines)
  3. Context-anchored match (find surrounding unique lines)
  4. Fuzzy match (Levenshtein distance threshold)
  5. AST-aware match (for supported languages)
  6. Hunk decomposition (split large edit into smaller hunks, apply independently)
  7. LLM-repair (last resort: ask LLM to re-generate edit against current file)
- Edit preview via shadow buffers (no disk write until approval)
- Baseline hash conflict detection before staging

### 3.2 Conflict Detector

| Detail | Value |
|--------|-------|
| Spec Reference | §6.2 (lines 4464–4588) |
| File | `src/mutation/conflict-detector.ts` |

- 3-level conflict detection:
  - **Fast** (hash-based, O(1)): compare `fileEdit.baselineHash` vs current file hash
  - **Standard** (line-based, O(n)): detect overlapping and adjacent changes
  - **Deep** (AST-based, O(n log n)): detect semantic and dependency conflicts (for supported languages)
- `ConflictInfo` with types: file-modified, file-deleted, file-created, range-overlap, range-adjacent, symbol-renamed, import-changed, semantic-dependency
- Severity levels: blocking, warning, info
- Resolution options per conflict type: use-current, use-proposed, manual-merge, recreate, skip, overwrite

### 3.3 Crash-Safe Checkpoints (Full Integration)

| Detail | Value |
|--------|-------|
| Spec Reference | §5.4.2 (lines 3851–3990) |
| File | `src/checkpoint/checkpoint-manager.ts` |

- `TransactionSafeCheckpointManager` with CV-1 through CV-5 validation on every read
- PENDING/COMPLETE marker protocol
- Checkpoint create/restore integrated with `StepExecutor` (Phase 4) — expose API now, wire later
- Encrypted checkpoint storage with stream support for large files
- `create(checkpointId, files)`, `restore(checkpointId)`, `list()`, `delete(checkpointId)`

### 3.4 Error Recovery Manager

| Detail | Value |
|--------|-------|
| Spec Reference | §3.4 (lines 2568–2798) |
| File | `src/recovery/error-recovery-manager.ts` |

- 4-tier error classification: transient → recoverable → permanent → catastrophic
- **Transient**: exponential backoff retry (3 max, patterns: ECONNRESET, ETIMEDOUT, 429, 503)
- **Recoverable**: reduce-context → simplify-request → fallback-model chain
- **Permanent**: notify user, disable provider
- **Catastrophic**: emergency save (persist all in-flight state), prompt restart
- `handleError(error, context)` → `{ recovered: boolean; method: string; result?: any }`
- `executeRecoveryAction()`, `escalate()`, `emergencySave()`

### 3.5 Circuit Breakers

| Detail | Value |
|--------|-------|
| Spec Reference | §9.1 (lines 5516–5597) |
| File | `src/recovery/circuit-breaker.ts` |

- Per-provider circuit breaker: CLOSED → OPEN → HALF_OPEN
- Configuration from spec:
  - `failureThreshold: 5`, `failureWindow: 60000ms`, `failureRateThreshold: 0.5`
  - `openDuration: 30000ms`, `halfOpenRequests: 3`, `successThreshold: 2`
  - `slowCallThreshold: 5000ms`, `slowCallRateThreshold: 0.5`
- `execute(request, fallback?)` — main entry point
- Half-open: allow limited probe requests after cooldown
- Integration with `ErrorRecoveryManager` — circuit open triggers fallback model
- `CircuitOpenError` with `remainingMs` for UI feedback

### Phase 3 Gate

```
□ Multi-file edit: apply 5-file edit → success; kill mid-edit → recovery restores clean state
□ FlexibleMatcher: each of 7 strategies has passing test suite (minimum 5 test cases per strategy)
□ ConflictDetector: hash-level detects any change; line-level detects overlapping ranges; creates correct ConflictInfo
□ INV-T1: no disk write without ApprovalToken (enforced by type system + runtime check)
□ Error recovery: transient errors retry with backoff; context_length_exceeded → reduces context and retries
□ Circuit breaker trips after 5 consecutive failures, recovers after cooldown with 2 successful probes
□ Emergency save preserves in-progress work on catastrophic error
□ CI: §14.2 check 7 passes (no AtomicMultiFileWriter references)
□ CI: §14.2 check 8 passes (FileContent types used everywhere)
```

---

## Phase 4 — Network Layer

**Duration**: 1.5 weeks (Weeks 5–6)  
**Dependencies**: Phase 3 (circuit breakers), Phase 2 (egress controls, secret scanner)  
**Rationale**: The Gateway is the single exit point for all external communication. It wraps consent, redaction, rate limiting, circuit breaking, and streaming. Provider Adapters are concrete implementations — without them, the Gateway has nothing to send to. This phase is separated from Agent Runtime because the transport layer must be testable independently.

### 4.1 Gateway (Provider Communication Hub)

| Detail | Value |
|--------|-------|
| Spec Reference | §9.x (lines 5514–6236) |
| File | `src/gateway/gateway.ts` |

- Single entry point for ALL external communication (LLM, embedding, search)
- Pipeline: `EgressBoundaryEnforcer` → `SecretRedactor` → `RateLimiter` → `CircuitBreaker` → `ProviderAdapter` → `StreamingResponseHandler`
- `send(request, options)` → response (streaming or complete)
- `sendStreaming(request, options)` → `AsyncIterable<StreamChunk>`
- Provider adapter registration: `registerProvider(adapter: ProviderAdapter)`
- Fallback chain: if primary provider fails or circuit opens, try fallback per lane configuration
- All calls wrapped with `TimeoutManager` (NETWORK domain: 30s default, 120s max)
- Egress audit: every call logged (metadata only, no content)

### 4.2 Provider Adapters

| Detail | Value |
|--------|-------|
| Spec Reference | §4.2 (lines 3119–3185), §4.5 (lines 3273–3512) |
| Files | `src/gateway/providers/anthropic-adapter.ts`, `src/gateway/providers/openai-adapter.ts`, `src/gateway/providers/ollama-adapter.ts` |

**Each adapter implements the `ProviderAdapter` interface and handles provider-specific concerns:**

**AnthropicAdapter** (`anthropic-adapter.ts`):
- Auth: `x-api-key` header from VS Code SecretStorage
- Base URL: `https://api.anthropic.com/v1/messages`
- Streaming: SSE with `event: message_start`, `content_block_delta`, `message_stop`
- Tool calls: `content[].type === 'tool_use'` blocks
- Rate limit headers: `anthropic-ratelimit-tokens-remaining`, `retry-after`
- Error shapes: `{ type: 'error', error: { type: 'overloaded_error' } }`
- Models: `claude-3-5-sonnet-*`, `claude-3-haiku-*`, `claude-3-opus-*`
- FIM: NOT supported — instruction-based completion only

**OpenAIAdapter** (`openai-adapter.ts`):
- Auth: `Authorization: Bearer {key}` from SecretStorage
- Base URL: `https://api.openai.com/v1/chat/completions` (chat) or `/v1/completions` (FIM)
- Streaming: SSE with `data: {"choices":[{"delta":{...}}]}`
- Tool calls: `choices[0].message.tool_calls[]` blocks
- Rate limit headers: `x-ratelimit-remaining-tokens`, `retry-after`
- Error shapes: `{ error: { type: 'rate_limit_error', code: '429' } }`
- Models: `gpt-4o`, `gpt-4o-mini`
- FIM: Supported via `/v1/completions` endpoint with `suffix` parameter

**OllamaAdapter** (`ollama-adapter.ts`):
- Auth: None (local)
- Base URL: `http://localhost:11434/api/generate` (completion) or `/api/chat` (chat)
- Streaming: NDJSON (`{"response": "...", "done": false}`)
- Tool calls: Not supported — all tool routing handled by QIC, not model
- Rate limiting: None needed (local)
- Error shapes: `{ error: "model not found" }`
- Models: `codellama:7b-code`, `deepseek-coder:6.7b`, `starcoder2:3b`
- FIM: Supported via raw mode with model-specific markers
- Health check: `GET /api/tags` to verify Ollama is running and model is loaded
- Model pull: `POST /api/pull` if model not available (with user confirmation)

**Implementation note for LLM:** Each adapter MUST normalize responses into the provider-agnostic `StreamChunk` type. The Gateway and everything above it should never see provider-specific types.

### 4.3 Rate Limiter

| Detail | Value |
|--------|-------|
| Spec Reference | §9.3 (lines 5687–5938) |
| File | `src/gateway/rate-limiter.ts` |

- Token-bucket algorithm per provider
- Provider limits from spec: Anthropic (500K TPM, 50 RPM), OpenAI (800K TPM, 60 RPM), local (unlimited)
- Cross-lane quota sharing: shared bucket with per-lane reservations
- `waitForCapacity(tokens)` → Promise (resolves when tokens available)
- `getAvailableTokens()`, `timeToRefill(amount)` for UI feedback
- Rate limit response handling: parse `retry-after` headers, respect 429/529 responses
- Exponential backoff on rate limit: 1s, 2s, 4s, 8s (max 4 retries)

### 4.4 Streaming Response Handler

| Detail | Value |
|--------|-------|
| Spec Reference | §9.4 (lines 5938–6236) |
| File | `src/gateway/streaming-handler.ts` |

- SSE parser supporting BOTH Anthropic and OpenAI formats (adapter tells handler which format)
- NDJSON parser for Ollama format
- Partial JSON assembly for tool calls (accumulate `tool_use` blocks until complete)
- Backpressure via pause/resume with 16KB high-water mark
- Reconnection with exponential backoff (3 attempts: 1s, 2s, 4s)
- Token estimation during stream, reconciliation on `message_stop`/`[DONE]`
- Provider-agnostic output: `StreamChunk { type: 'text' | 'tool_call' | 'done' | 'error', ... }`

### 4.5 Request Manager

| Detail | Value |
|--------|-------|
| Spec Reference | §9.2 (lines 5597–5687) |
| File | `src/gateway/request-manager.ts` |

- Priority queue: CRITICAL > INTERACTIVE > BACKGROUND > SPECULATIVE
- Per-priority config: CRITICAL (5s max queue, cannot shed), INTERACTIVE (10s, shed after 15s), BACKGROUND (30s, shed after 10s), SPECULATIVE (5s, shed after 5s)
- Load shedding: under pressure, drop SPECULATIVE → BACKGROUND → INTERACTIVE (never CRITICAL)
- Fair queuing: per-source limits (completion: 10, chat: 5), starvation prevention (max 10 consecutive same-priority)
- Queue depth monitoring: signal `DegradationManager` when overloaded
- `enqueue(request, priority)` → Promise

### Phase 4 Gate

```
□ Gateway: send request → egress check → redaction → rate limit → circuit breaker → provider → stream parse
□ AnthropicAdapter: sends Messages API request, parses SSE stream, extracts tool_use blocks
□ OpenAIAdapter: sends Chat Completions request, parses SSE stream, extracts tool_calls
□ OllamaAdapter: sends to local Ollama, parses NDJSON stream, health check works
□ All 3 adapters normalize to StreamChunk (no provider-specific types leak above Gateway)
□ Rate limiter: sustain 50 RPM Anthropic limit; 51st request waits for refill
□ Streaming handler: interleaved text + tool_call chunks parsed correctly for all 3 providers
□ Request manager: under load, CRITICAL completes while SPECULATIVE is shed
□ Fallback chain: Anthropic circuit open → Gateway automatically tries OpenAI fallback
```

---

## Phase 5 — Agent Runtime & Context Engine

**Duration**: 2 weeks (Weeks 6–8)  
**Dependencies**: Phase 4 (Gateway, Provider Adapters), Phase 3 (mutation engine, error recovery, checkpoints), Phase 2 (consent, secret scanner)  
**Rationale**: This phase builds both the Context Engine (codebase intelligence) and the Agent Runtime (plan execution, tool routing) and then wires them together with the **Agent Orchestrator** — the central loop that turns individual components into a running system. These are combined because the Orchestrator needs both the Context Engine and the Runtime, and building them in parallel within one phase allows integration testing at the gate.

### 5.1 Secure Embedding Service

| Detail | Value |
|--------|-------|
| Spec Reference | §8.1 (lines 5165–5227) |
| File | `src/context/secure-embedding.ts` |

- Wraps all embedding calls with consent check → secret redaction → audit logging
- If consent not granted: try local embedding provider (e.g., `ollama:nomic-embed-text`); if unavailable, throw `EmbeddingConsentRequiredError`
- Providers: remote (OpenAI `text-embedding-3-small`, Voyage, Cohere) and local (Ollama)
- `embed(text, options)` → `EmbeddingResult`
- `embedBatch(texts, options)` → `EmbeddingResult[]`
- Redaction happens before sending; audit log records request metadata (provider, input length, redacted count) but NOT content

### 5.2 Incremental Indexer + RAG Pipeline

| Detail | Value |
|--------|-------|
| Spec Reference | §8.2 (lines 5227–5325) |
| File | `src/context/incremental-indexer.ts` |

- File change triggers: modified, created, deleted, renamed
- 500ms batch window: queue changes, process batch after 500ms of no new changes
- Content hash check: skip reindex if hash unchanged
- Priority: index open files first
- For each file:
  - Update BM25 index (tokenise → update `qic_bm25_terms`, `qic_bm25_postings`, `qic_bm25_docs`)
  - Update vector index (embed via `SecureEmbeddingService` → upsert to LanceDB)
- Background full reindex on provider change (non-blocking)
- SLOs: single file < 500ms; structural changes < 10s

### 5.3 Reranker

| Detail | Value |
|--------|-------|
| Spec Reference | §8.3 (lines 5325–5384) |
| File | `src/context/reranker.ts` |

- Reciprocal Rank Fusion (RRF) with `k=60`
- 4 sources with weights: BM25 (0.4), vector (0.4), recency (0.1), file-proximity (0.1)
- Formula: `score(doc) = Σ weight_i / (k + rank_i)` for each source
- `rerank(results, context)` → sorted `RankedResult[]`

### 5.4 Context Assembler (Token Budget)

| Detail | Value |
|--------|-------|
| Spec Reference | §4.3 (lines 3185–3228) |
| File | `src/context/context-assembler.ts` |

- Per-lane token budget allocation:
  - **completion**: 4000 total → prefix (2000), suffix (800), imports (280), typeContext (400), systemPrompt (500)
  - **chat**: 32000 total → systemPrompt (2000), conversationHistory (16000), context (12000), toolSchemas (2000)
  - **gather**: 64000 total → systemPrompt (2000), conversationHistory (24000), context (32000), toolSchemas (6000)
- `assembleContext(lane, query, conversation, signal)` → `{ messages: Message[], tokenCount: number }`
- Uses `IncrementalIndexer` search results → `Reranker` → select top results within budget
- Truncation strategy: oldest conversation messages first, then lowest-ranked context

### 5.5 Dynamic Tool Selector

| Detail | Value |
|--------|-------|
| Spec Reference | §8.4 (lines 5384–5514) |
| File | `src/context/dynamic-tool-selector.ts` |

- Pre-computed tool embeddings (256-dim, `text-embedding-3-small`)
- Semantic similarity between user message and tool descriptions
- Token budget enforcement: max 2000 tokens for tool schemas
- Max 8 tools per request
- Essential tools always included per lane (from `getEssentialTools()` mapping)
- For lanes with explicit `allowedTools` (not `'*'`): bypass semantic selection, use lane config
- `selectTools(userMessage, lane, maxTokens)` → `ToolDefinition[]`

### 5.6 Step Executor

| Detail | Value |
|--------|-------|
| Spec Reference | §7.1 (lines 4977–5062) |
| File | `src/runtime/step-executor.ts` |

- Executes individual `PlanStep`s within a task
- Creates checkpoint before each step execution (via `TransactionSafeCheckpointManager`)
- Creates cancellation scope per step (via `CancellationManager`)
- On `CancellationError`: rollback to checkpoint, return cancelled result
- On other errors: delegate to `ErrorRecoveryManager`; if recovery fails, propagate error
- `executeStep(step, context)` → `StepResult` { success, cancelled, recoveredFrom, duration, checkpointId }
- Integrates with `TimeoutManager` (EXECUTION domain) for per-step timeouts

### 5.7 Tool Router with Permission Checks

| Detail | Value |
|--------|-------|
| Spec Reference | §7.2 (lines 5062–5163) |
| Files | `src/runtime/tool-router.ts`, `src/runtime/permission-manager.ts` |

**ToolRouter:**
- Routes tool calls to tool implementations
- Validates tool is allowed in current lane (`LANE_CONFIGURATIONS[lane].allowedTools`)
- Checks permission via `PermissionManager.check()` → `PermissionCheckResult`
- For terminal tools (`run_terminal`, `run_command`): validates via `TerminalSecurityGuard` (Phase 8 — use stub, see Stub Interface Contracts)
- Records tool call via `ToolChainMonitor` (Phase 8 — use stub)
- Logs execution via `SecurityAuditLogger` (Phase 8 — use stub)
- `route(toolCall, context)` → `ToolResult`
- Wraps execution with `TimeoutManager` (EXECUTION domain)

**PermissionManager:**
- `check(tool, context)` → `PermissionCheckResult` (NEVER returns boolean — spec invariant)
- Permission levels: `none`, `once` (ask each time), `session` (ask once per session), `always` (always allow after first grant)
- Stores decisions in memory (session-scoped) and SQLite (persistent for `always`)
- `record(toolName, userResponse, level)` — store decision
- Permission dialog integration via `UIService.showPermissionDialog()`

### 5.8 Lane Router

| Detail | Value |
|--------|-------|
| File | `src/runtime/lane-router.ts` |

**This component was absent in all previous plans.** The system has 8 lanes but nothing decided which lane to use.

- `classifyMessage(message, conversationHistory)` → `LaneName`
- Classification strategy (ordered, first match wins):
  1. **Explicit user directive**: user says "just explain" → `chat-ask`; user says "do it" / "fix this" → `chat-act`
  2. **Conversation state**: if task is in PLANNING state → `chat-plan`; if in ACTING state → `chat-act`
  3. **Intent classification** (heuristic, upgradeable to LLM-based):
     - Question without code change intent → `chat-ask`
     - Question requiring codebase investigation → `chat-gather`
     - Request to modify/create/delete files → `chat-plan` (then `chat-act` for execution)
     - "fix this error" / repair request → `repair`
  4. **Default**: `chat-ask`
- The orchestrator may re-route mid-conversation: `chat-ask` response that determines code changes are needed → escalate to `chat-plan`
- Lane transitions are logged for debugging/telemetry

### 5.9 Agent Orchestrator (CRITICAL — the central loop)

| Detail | Value |
|--------|-------|
| File | `src/runtime/agent-orchestrator.ts` |

**This is the single most important component that was missing from all previous plans.** It is the agent loop — the body that connects all the organs.

```typescript
class AgentOrchestrator {
  constructor(
    private gateway: Gateway,
    private contextEngine: { assembler: ContextAssembler, toolSelector: DynamicToolSelector, indexer: IncrementalIndexer },
    private toolRouter: ToolRouter,
    private stepExecutor: StepExecutor,
    private laneRouter: LaneRouter,
    private mutationEngine: MutationEngine,
    private agentStateMachine: PersistentAgentStateMachine,
    private taskStateMachine: PersistentTaskStateMachine,
    private conversationState: ConversationStateMachine,
    private cancellationManager: CancellationManager,
    private uiService: UIService,
  ) {}

  /**
   * Main entry point — called when user sends a message in chat.
   */
  async handleUserMessage(message: string, sessionId: string): Promise<void> {
    // 1. Determine lane
    const lane = this.laneRouter.classifyMessage(message, this.conversationState.getHistory());

    // 2. Transition agent state: READY → PROCESSING
    await this.agentStateMachine.transition('processing');

    // 3. Create cancellation scope for this interaction
    const signal = this.cancellationManager.createScope(`msg-${Date.now()}`, 'task', sessionId);

    try {
      // 4. Assemble context (codebase search + conversation history + tool schemas)
      const tools = await this.contextEngine.toolSelector.selectTools(message, lane);
      const context = await this.contextEngine.assembler.assembleContext(lane, message, this.conversationState.getHistory(), signal);

      // 5. Send to LLM via Gateway
      const stream = await this.gateway.sendStreaming({
        model: this.getModelForLane(lane),
        messages: context.messages,
        tools: tools.map(t => t.schema),
        signal,
      });

      // 6. Process response stream — THE AGENT LOOP
      for await (const chunk of stream) {
        if (chunk.type === 'text') {
          // Stream text to UI
          this.uiService.streamChatToken(chunk.text);
        }
        else if (chunk.type === 'tool_call') {
          // Route tool call → execute → feed result back to LLM
          await this.agentStateMachine.transition('processing'); // stay in processing
          const result = await this.toolRouter.route(chunk.toolCall, { sessionId, lane, signal });

          // If tool produced file edits, present diff preview (INV-T1)
          if (result.edits) {
            await this.agentStateMachine.transition('waiting-approval');
            const token = await this.uiService.showDiffPreview(result.edits);
            if (token) {
              await this.mutationEngine.apply(result.edits, token);
            }
            await this.agentStateMachine.transition('processing');
          }

          // Continue the conversation with tool result
          // (this is recursive — LLM may issue more tool calls)
          this.conversationState.addToolResult(chunk.toolCall.id, result);
          // Re-send with tool result appended — Gateway handles this
        }
      }

      // 7. Transition agent state: PROCESSING → READY
      await this.agentStateMachine.transition('ready');

    } catch (error) {
      if (error instanceof CancellationError) {
        await this.agentStateMachine.transition('ready');
      } else {
        await this.agentStateMachine.transition('failed');
        // ErrorRecoveryManager handles escalation
        throw error;
      }
    }
  }
}
```

**Implementation notes for LLM:**
- The tool call loop is recursive: LLM may issue multiple tool calls in sequence. The orchestrator must continue sending tool results back until the LLM produces a final text response.
- The `handleUserMessage` method is the ONLY public entry point for chat interactions. Everything else is wired through it.
- For the `completion` lane, the CompletionEngine (Phase 6) handles the loop directly — it doesn't go through the orchestrator because it's a different interaction model (inline, not chat).
- For `fast-apply`, the orchestrator skips the plan phase and directly applies the edit.

### Phase 5 Gate

```
□ Embedding: consent check blocks external embedding without consent; local fallback works
□ Indexer: change 1 file → BM25 + vector updated within 500ms; content hash skip works
□ Reranker: RRF produces correct ordering for known test set
□ Context assembler: chat lane stays within 32K tokens; completion lane within 4K
□ Dynamic tool selector: stays within 2000-token budget; essential tools always present
□ StepExecutor: execute 3-step plan → each step checkpointed; cancel mid-step → rollback to checkpoint
□ ToolRouter: route tool call → permission check → execution → result
□ PermissionManager: ask-user-once → first call prompts, second call proceeds silently
□ LaneRouter: "explain this code" → chat-ask; "fix the bug in auth.py" → chat-plan; explicit "do it" → chat-act
□ AgentOrchestrator: full loop — user message → lane selection → context assembly → LLM call → tool execution → response streamed to UI
□ AgentOrchestrator: multi-tool loop — LLM issues 3 tool calls → all 3 executed → results fed back → final response
□ CI: §14.2 check 9 passes (state persistence tables verified)
```

---

## Phase 6 — Completion Architecture & Resilience

**Duration**: 1.5 weeks (Weeks 7–8)  
**Dependencies**: Phase 5 (context engine, embedding), Phase 4 (gateway, request manager), Phase 3 (circuit breakers)  
**Rationale**: The completion engine is the most-used feature (sub-200ms autocomplete). It requires the full stack: context assembly, model registry, provider communication, degradation management, and memory management.

### 6.1 Tiered Completion Engine

| Detail | Value |
|--------|-------|
| Spec Reference | §4.4 (lines 3228–3273) |
| File | `src/completion/completion-engine.ts` |

- 6-tier waterfall: Local GPU → Local CPU → Edge Cache → Cloud Optimized → Cloud Standard → Degraded
- Parallel fallback: race local vs. cloud with 200ms local timeout
- Adaptive behaviour:
  - Latency tracking: p50/p95/p99 over 100-request sliding window
  - Auto-demotion: after 5 consecutive failures OR > 20% p95 exceedance
  - Promotion check: every 5 minutes, send 3 test requests to higher tier
- Status bar latency indicator: fast (< 200ms), normal (< 500ms), slow (< 1000ms)
- FIM support: use FIM markers for local models (codellama, deepseek-coder, starcoder2); instruction-based for Claude
- Integration with `ContextAssembler` for completion context (4000 token budget)
- VS Code `InlineCompletionProvider` registration

### 6.2 Model Registry

| Detail | Value |
|--------|-------|
| Spec Reference | §4.5 (lines 3273–3512) |
| File | `src/completion/model-registry.ts` |

- Alias resolution: `claude-latest` → `claude-3-5-sonnet-20241022`, etc.
- Capability detection: tools, vision, streaming, maxContext, maxOutput, FIM support
- `validateForLane(modelId, lane)` — FIM required for completion, tools required for act/gather
- Deprecation checking:
  - Daily interval check (86400000ms)
  - 30-day warning before sunset
  - Auto-migration fallback chain (e.g., `claude-3-haiku → claude-3-5-haiku → claude-3-5-sonnet`)
- Best-effort capability detection for unknown/local models (heuristic: local models have FIM, no tools)
- `resolveAlias()`, `getCapabilities()`, `checkDeprecation()`, `autoMigrate()`, `validateForLane()`

### 6.3 FIM Adapter

| Detail | Value |
|--------|-------|
| Spec Reference | §4.2 (lines 3119–3185) |
| File | `src/completion/fim-adapter.ts` |

- FIM marker maps for supported models:
  - codellama: `<PRE>`, `<SUF>`, `<MID>`
  - deepseek-coder: `<｜fim▁begin｜>`, `<｜fim▁hole｜>`, `<｜fim▁end｜>`
  - starcoder2: `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`
- Instruction-based completion for models without FIM (Claude): construct a prompt that asks the model to complete code at cursor position
- `formatFIMRequest(prefix, suffix, modelId)` → provider-specific request

### 6.4 Degradation Manager

| Detail | Value |
|--------|-------|
| Spec Reference | §12.1 (lines 7763–7857) |
| File | `src/resilience/degradation-manager.ts` |

- 5 levels: NORMAL → REDUCED → LIMITED → MINIMAL → EMERGENCY
- Automatic level calculation from service health states (`ServiceState[]`)
- Feature disable/enable by level:
  - REDUCED: disable speculative completions, reduce indexing frequency
  - LIMITED: disable background indexing, reduce context window
  - MINIMAL: disable completions, chat-only mode
  - EMERGENCY: save all state, disable all AI features, show recovery UI
- Auto-recovery: 30s check interval, 3 attempts with 2× backoff
- User notification: non-dismissible banner (via `UIService.showDegradationBanner`) with recovery progress
- State machine: `DegradationStateMachine` with valid transitions

### 6.5 Memory Manager

| Detail | Value |
|--------|-------|
| Spec Reference | §12.2 (lines 7857–7939) |
| File | `src/resilience/memory-manager.ts` |

- 500MB total budget with per-component allocation:
  - Vector index: 150MB
  - BM25 index: 50MB
  - Session state: 100MB
  - Completion cache: 50MB
  - Embedding cache: 100MB
  - File cache: 30MB
  - Miscellaneous: 20MB
- 4 pressure levels: normal (< 70%), elevated (< 80%), high (< 90%), critical (≥ 95%)
- Eviction policies:
  - LRU (default for most caches)
  - LFU (embedding cache — frequently used embeddings are more valuable)
  - Relevance-weighted LRU (vector index — recent + relevant survive longer)
- Pressure response chain: reduce-caches → aggressive-eviction → emergency-measures (dump to disk)
- Periodic monitoring: check RSS every 10s
- Integration with `DegradationManager`: critical memory pressure triggers MINIMAL degradation

### Phase 6 Gate

```
□ Completion: local model returns in < 200ms; cloud fallback works when local unavailable
□ Completion: FIM markers correct for codellama, deepseek-coder, starcoder2
□ Completion: instruction-based completion works for Claude (no FIM markers)
□ Model registry: deprecated model auto-migrates; FIM model assigned to completion lane
□ Model registry: validateForLane rejects Claude for completion lane (no FIM)
□ Degradation: simulate provider outage → MINIMAL within 5s → recover when provider returns
□ Memory: sustained load stays under 500MB; pressure response activates at correct thresholds
□ Latency indicator updates in real time during completion
□ CI: §14.2 check 10 passes (model registry validated)
```

---

## Phase 7 — UI Layer

**Duration**: 2 weeks (Weeks 9–11)  
**Dependencies**: Phase 5 (agent orchestrator, tool router), Phase 6 (completion engine, degradation), Phase 2 (consent)  
**Rationale**: The UI layer is the user's entire interaction surface. The chat panel with streaming markdown, the inline completion provider, the diff preview widget, and the permission/consent dialogs are each significant implementations. This phase is 2 weeks — not squeezed — because the chat panel alone (streaming, code blocks, syntax highlighting, file links, copy/insert) is substantial.

### 7.1 UI Layer

#### 7.1 Chat Panel (Webview)

| Detail | Value |
|--------|-------|
| Spec Reference | §3.1 — `chatPanel` |
| File | `src/ui/chat-panel.ts` |

- VS Code `WebviewViewProvider` registered in sidebar
- Streaming message display (token-by-token rendering)
- Message types: user, assistant, system, tool-call, tool-result, error
- Markdown rendering for assistant messages
- Code block syntax highlighting
- File reference links (click to open file)
- Copy/insert code actions
- Message input with submit (Enter) and newline (Shift+Enter)
- Conversation history display
- Integration with `ConversationStateMachine` for state persistence

#### 7.2 Inline Completion Provider

| Detail | Value |
|--------|-------|
| Spec Reference | §3.1 — `inlineEdit` |
| File | `src/ui/inline-completion.ts` |

- VS Code `InlineCompletionItemProvider` registration
- Debounced trigger (150ms after last keystroke)
- Ghost text display for completions
- Tab to accept, Escape to dismiss
- Multi-line completion support
- Integration with `CompletionEngine` (Phase 6)
- Latency indicator in status bar

#### 7.3 Diff Preview Widget

| Detail | Value |
|--------|-------|
| Spec Reference | §3.1 — `diffWidget` |
| File | `src/ui/diff-widget.ts` |

- Side-by-side diff preview before edit application
- Uses VS Code diff editor API
- Accept / Reject / Accept All / Reject All actions
- Per-file and per-hunk granularity
- Integration with `MutationEngine.preview()` (shadow buffers from Phase 3)
- Creates `ApprovalToken` on user acceptance (INV-T1)

#### 7.4 Permission & Consent Dialogs

| Detail | Value |
|--------|-------|
| Spec Reference | §2.4, §3.5 — `UIService` |
| Files | `src/ui/permission-dialog.ts`, `src/ui/first-run-dialog.ts` |

- `showPermissionDialog()`: VS Code QuickPick or Modal dialog for tool permissions
- `showFirstRunConsent()`: Webview panel with 5 consent categories, privacy policy link, terms link
- `showPrivacySettings()`: Settings webview accessible from command palette
- Remember permission checkbox (for `session` and `always` levels)

#### 7.5 Status Indicators

| Detail | Value |
|--------|-------|
| Spec Reference | §3.1 — `degradationIndicator`, `memoryPressureAlert` |
| Files | `src/ui/degradation-banner.ts`, `src/ui/memory-pressure-alert.ts`, `src/ui/checkpoint-ui.ts` |

- Degradation banner: non-dismissible status bar item or notification showing current degradation level and recovery progress
- Memory pressure alert: warning notification when memory exceeds 80%
- Checkpoint management: command palette commands for create/restore/list checkpoints

#### 7.6 UIService Implementation

Wire all UI components into a concrete `UIService` implementation that satisfies the `UIService` interface from `src/canonical/interfaces.ts`. This is the single integration point between the core engine and the UI.

### Phase 7 Gate

```
□ Chat panel: send message → streaming response renders token-by-token with markdown
□ Chat panel: code blocks have syntax highlighting and copy/insert buttons
□ Inline completion: type code → ghost text appears after 150ms debounce → Tab accepts
□ Diff preview: edit generates → side-by-side diff → Accept creates ApprovalToken → edit applied
□ First-run dialog: blocks all operations until consent given
□ Permission dialog: tool execution prompts user; remembered for session
□ Degradation banner: shows when system in REDUCED or worse state
□ Memory pressure alert: fires at 80% threshold
□ Checkpoint UI: create and restore checkpoints from command palette
□ UIService: all 10 interface methods implemented and wired
```

---

## Phase 8 — Security Hardening

**Duration**: 1 week (Week 11)  
**Dependencies**: Phase 5 (tool router — now replace stubs with real implementations), Phase 2 (base security)  
**Rationale**: With the tool router and permission system live, harden the attack surface: terminal command validation, tool chain monitoring, and audit logging. This phase replaces all security stubs from Phase 5.

### 8.1 Terminal Security Guard

| Detail | Value |
|--------|-------|
| Spec Reference | §10.2 (lines 6945–7062) |
| File | `src/security/terminal-guard.ts` |

- 4-layer validation: syntax parsing → blocklist check → argument validation → context analysis
- Blocklist: fork bombs (`:(){ :|:& };:`), dangerous `rm` patterns, disk write/format commands, `curl|bash` pipes, `eval` with user input
- Argument validation: paths within workspace only, no env exfiltration (`$ENV`, `printenv`), no credential access
- Context analysis: check if command is part of exfiltration chain (read sensitive → send external)
- Output sanitisation: 100KB max output, ANSI escape removal, secret redaction from terminal output
- `validateCommand(command, context)` → `{ allowed: boolean; reason?: string }`

### 8.2 Tool Chain Monitor

| Detail | Value |
|--------|-------|
| Spec Reference | §10.3 (lines 7062–7158) |
| File | `src/security/tool-chain-monitor.ts` |

- 3 dangerous sequences:
  1. **Read-then-exfiltrate**: `read_file(sensitive)` → `web_fetch(external)` (data leaving workspace)
  2. **Credential-access-chain**: `read_file(.env)` → `run_terminal(curl)` (credentials being sent)
  3. **Mass-file-operation**: `list_directory(/)` → `read_file(*)` → `write_file(*)` (bulk data access)
- Per-session call history: last 100 tool calls
- Data flow tracking: flag potential exfiltration when sensitive data accessed then sent externally
- Actions: block, block-and-warn (with explanation), warn (with user confirmation option)
- `recordToolCall(toolCall, context)`, `analyzeCurrentChain(sessionId)` → `ChainAnalysis`

### 8.3 Security Audit Logger

| Detail | Value |
|--------|-------|
| Spec Reference | §10.4 (lines 7158–7291) |
| File | `src/security/audit-logger.ts` |

- Hash-chained audit log: each entry includes SHA-256 of previous entry → tamper detection
- Event types: authentication, authorization (granted/denied), tool execution (start/complete/fail), violations, egress
- WriteStream-based for performance (don't block on I/O)
- Log file at `{workspaceStorage}/security-audit/audit-{date}.jsonl`
- Log rotation: new file per day, retention configurable
- `logAuthzGranted()`, `logAuthzDenied()`, `logToolExecution()`, `logViolation()`, `logEgressRequest()`, `verifyChainIntegrity()`

### 8.4 Wire Security into ToolRouter

Now replace the stubs from Phase 5:
- Wire `TerminalSecurityGuard` into `ToolRouter` for terminal commands
- Wire `ToolChainMonitor` into `ToolRouter` for all tool calls
- Wire `SecurityAuditLogger` into `ToolRouter` for all tool executions

### Phase 8 Gate

```
□ Terminal guard: fork bomb blocked; rm -rf / blocked; curl|bash blocked; path-outside-workspace blocked
□ Tool chain monitor: read_file → web_fetch sequence detected and flagged
□ Audit log: hash chain verified over 1000 entries; tampering detected when entry modified
□ Output sanitisation: ANSI removed; secrets redacted from terminal output
□ All security stubs in ToolRouter replaced with real implementations
□ Dynamic tool selection: stays within 2000-token budget; essential tools always present
```

---

## Phase 9 — Quant Domain Layer + LSP Integration

**Duration**: 1.5 weeks (Weeks 12–13)  
**Dependencies**: Phase 6 (memory management, model registry), Phase 8 (security hardening), Phase 5 (context engine)  
**Rationale**: This is the differentiator. Quant-specific features require the full stack to be stable: stream-based file handling for large datasets, secure embedding for code intelligence, memory management for large indexes, and the complete security layer for safe execution. LSP integration provides the last 3 tools.

### 9.1 DataFrame Safety

| Detail | Value |
|--------|-------|
| Spec Reference | §11.1 (lines 7293–7336) |
| File | `src/quant/dataframe-safety.ts` |

- Safe preview for large DataFrames: `head(5)`, `tail(5)`, `sample(10)`, `describe()` without loading full dataset
- Memory-aware preview sizing based on current pressure level from `MemoryManager`
- Type detection for financial data: timestamps, OHLCV (Open/High/Low/Close/Volume), returns, prices
- Overflow/NaN/Inf warnings in preview output
- File format detection: `.csv`, `.parquet`, `.arrow`, `.h5`, `.feather`

### 9.2 Apache Arrow IPC Bridge

| Detail | Value |
|--------|-------|
| Spec Reference | §11.4 (lines 7440–7547) |
| File | `src/quant/arrow-bridge.ts` |

- Zero-copy DataFrame transfer between Python sidecar and TypeScript via Arrow IPC format
- File-based IPC protocol: Python writes Arrow IPC file → TypeScript reads via `apache-arrow` npm package
- Shared memory when available (Linux/macOS), temp file fallback (Windows or when shared mem unavailable)
- Schema validation: verify Arrow schema matches expected types before processing
- Type mapping: Arrow → TypeScript (Float64 → number, Utf8 → string, Timestamp → Date, etc.)
- Memory tracking: register/deregister Arrow buffers with `MemoryManager`
- Cleanup: delete temp IPC files after transfer

### 9.3 Python Sidecar

| Detail | Value |
|--------|-------|
| Spec Reference | §11.5 (lines 7547–7761) |
| File | `src/quant/python-sidecar.ts` + `python/qic_sidecar/` package |

**TypeScript side:**
- JSON-RPC over stdin/stdout communication with Python child process
- Lifecycle: lazy start (spawn on first call), idle timeout (5 min), graceful shutdown
- Error handling: 30s per-call timeout, reject all pending on process death
- Auto-restart on crash (max 3 restarts per session)
- `call(method, params)` → Promise

**Python side (`python/qic_sidecar/`):**
- JSON-RPC server reading from stdin, writing to stdout
- Methods:
  - `analyze_time_series(data, freq?)` → frequency, stationarity, outliers, gaps
  - `detect_frequency(timestamps)` → detected frequency (tick → yearly)
  - `statistical_test(data, test_name)` → test result with p-value
  - `analyze_backtest(returns, benchmark?)` → Sharpe, Sortino, max drawdown, alpha, beta, Calmar
- Dependencies: numpy, pandas, scipy, pyarrow
- Ship pinned `requirements.txt` (exact versions for reproducibility)

**Python Environment Manager (`src/quant/python-env-manager.ts`):**

This component manages the Python virtualenv lifecycle — the #1 pain point for tools with Python sidecars.

- **Discovery**: Check in order: (1) `qic.pythonPath` setting, (2) `{extensionPath}/.venv/bin/python`, (3) `python3` on PATH, (4) `python` on PATH
- **Validation**: Run `python -c "import numpy, pandas, scipy, pyarrow"` to verify all deps installed
- **Auto-setup**: If validation fails:
  1. Create virtualenv: `python -m venv {extensionPath}/.venv`
  2. Install deps: `pip install -r {extensionPath}/python/requirements.txt`
  3. Re-validate
- **User notification**: Show progress notification during setup ("QIC: Installing Python dependencies…")
- **Error handling**: If Python not found → show error with instructions; if pip fails → show error with manual install command
- **Caching**: Store validated Python path in workspace settings to skip discovery on subsequent activations
- `ensurePythonReady()` → `{ pythonPath: string; ready: boolean; error?: string }`

### 9.4 Time Series Intelligence

| Detail | Value |
|--------|-------|
| Spec Reference | §11.2 (lines 7336–7378) |
| File | `src/quant/time-series.ts` |

- Automatic frequency detection: tick, second, minute, hourly, daily, weekly, monthly, quarterly, yearly
- Stationarity testing (ADF test via Python sidecar)
- Outlier detection (z-score with configurable threshold, default 3.0)
- Gap detection in timestamp series (missing dates/times)
- Integration with chat context: surface warnings about look-ahead bias, data leakage, survivorship bias

### 9.5 Quant Library Patterns

| Detail | Value |
|--------|-------|
| Spec Reference | §11.3 (lines 7378–7440) |
| File | `src/quant/quant-patterns.ts` |

- Financial library awareness: pandas, numpy, scipy, zipline, backtrader, QuantLib, pyfolio
- Code intelligence for common quant patterns:
  - Vectorised operations (prefer `.apply()` over loops)
  - Rolling windows (`rolling().mean()`, `ewm()`)
  - Resampling (`resample('D').agg()`)
  - Merge/join patterns for financial data
- Backtesting-specific warnings:
  - Look-ahead bias detection (accessing future data in computation)
  - Survivorship bias warnings (indexing by ticker without survival filter)
  - Data snooping alerts (fitting parameters to test set)
- Math notation recognition in comments/docstrings (LaTeX-like patterns)

### 9.6 LSP Tool Integration

| Detail | Value |
|--------|-------|
| Spec Reference | §13.1 (lines 7974–8016) |
| File | `src/lsp/lsp-tools.ts` |

Implement the 3 LSP-dependent tools from the tool registry:

1. **`rename_symbol`**: Use `vscode.commands.executeCommand('vscode.executeDocumentRenameProvider')` or `vscode.languages.registerRenameProvider`. Takes path, position, newName. Returns workspace edit result.

2. **`apply_code_action`**: Use `vscode.commands.executeCommand('vscode.executeCodeActionProvider')`. Takes path, range, actionKind. Filters by kind, applies selected action.

3. **`organize_imports`**: Use `vscode.commands.executeCommand('editor.action.organizeImports')` or code action with kind `source.organizeImports`.

All 3 tools require `permission: { required: true, level: 'once' }` and have `hasSideEffects: true`.

### Phase 9 Gate

```
□ DataFrame preview: 1GB parquet file previews in < 2s without OOM
□ Arrow IPC: round-trip DataFrame Python → TypeScript → Python with zero data loss
□ Python sidecar: starts on first call, idles out after 5 min, handles process death gracefully
□ Python sidecar: auto-restarts after crash (max 3)
□ Time series: correctly detects daily frequency, identifies gaps, flags outliers
□ Quant patterns: completion suggestions respect pandas/numpy idioms
□ Backtest analysis: returns Sharpe, Sortino, max drawdown, alpha/beta correctly
□ LSP: rename_symbol renames across multiple files; apply_code_action works; organize_imports works
□ All 22 tools now have implementations (verify tool registry completeness)
```

---

## Phase 10 — Telemetry, Reproducibility & Documentation

**Duration**: 1 week (Weeks 13–14)  
**Dependencies**: All prior phases  
**Rationale**: Production readiness. Opt-in telemetry, reproducibility infrastructure for debugging, and comprehensive documentation.

### 10.1 Telemetry

| Detail | Value |
|--------|-------|
| Spec Reference | §12.3 (lines 7939–7974) |
| File | `src/telemetry/telemetry-service.ts` |

- Opt-in telemetry (respects consent from Phase 2; defaults to opted-out)
- Privacy requirements: no user identifiers, no file contents, no file paths (hash only), no secrets
- 4 categories with sampling rates:
  - Performance (10%): completion latency, indexing time, memory usage
  - Errors (100%): all errors with error codes (no stack traces with file paths)
  - Usage (1%): feature usage counts (chat, completion, tool calls)
  - Quality (10%): completion acceptance rate, edit success rate
- 7-day raw event retention, 90-day aggregated retention
- Integration with `EgressBoundaryEnforcer` (egress-telemetry boundary)

### 10.2 Reproducibility Infrastructure

| Detail | Value |
|--------|-------|
| Files | `src/telemetry/reproducibility-logger.ts`, `src/telemetry/session-cache.ts`, `src/telemetry/replay-mode.ts` |

- `ReproducibilityLogger`: logs all external requests/responses as JSONL to `{workspaceStorage}/recordings/`
- `SessionCache`: caches responses for identical requests within session (LRU with TTL)
  - Request hashing for deduplication (hash of model + messages + tools + temperature)
  - Cache size limit: 50MB
- `ReplayModeSupport`: load recorded responses for debugging/testing
  - 3 modes: strict (exact match required), best-effort (fuzzy match), fallback (try cache then live)
  - `activateReplayMode(recordingPath)`, `deactivateReplayMode()`

### 10.3 Documentation

- API versioning strategy (schema versions in EditScript, checkpoint format, journal format)
- Migration guides for each version transition
- Architecture Decision Records (ADRs) for key choices:
  - ADR-001: JournaledAtomicWriter over simple rename
  - ADR-002: Aho-Corasick over sequential regex
  - ADR-003: Arrow IPC over JSON for DataFrame transfer
  - ADR-004: Token-bucket rate limiting
  - ADR-005: 4-tier error classification
- Developer onboarding guide
- Security model documentation for external audit
- All 22 tools documented with usage examples
- All 8 lanes documented with token budgets
- All 11 invariants documented with enforcement mechanisms

### Phase 10 Gate

```
□ Telemetry respects opt-out; no PII in any telemetry event (automated PII scan)
□ Every error code in ERROR_REGISTRY has a user-facing message and a test
□ Replay mode can reproduce a recorded session identically (strict mode)
□ Session cache hit rate > 0% for repeated identical requests
□ Documentation covers all 22 tools, 8 lanes, 11 invariants
□ CI schema validation script (§14.2 — all 10 checks) passes
```

---

## Phase 11 — Integration Testing & Stabilisation

**Duration**: 2–3 weeks (Weeks 14–17)  
**Dependencies**: All phases complete  
**Rationale**: End-to-end validation of the complete system, including cross-cutting concerns, performance benchmarking, security audit, and the full verification checklist from Appendix C.

### 11.1 End-to-End Scenarios

| Scenario | Coverage | Phases Exercised |
|----------|----------|-----------------|
| **First launch** | First-run consent → provider setup → initial index → first completion | 0, 1, 2, 5, 6, 7 |
| **Chat workflow** | Ask → Gather → Plan → Act → Verify → user approves edits | 1, 4, 5, 6, 7, 3 |
| **Crash recovery** | Kill during multi-file edit → restart → journal recovery → user continues | 0, 1, 3 |
| **Degraded mode** | Provider outage → degradation → local fallback → provider recovery → promotion | 3, 4, 6 |
| **Large workspace** | 50K files → index without OOM → search returns in < 500ms | 5, 6 |
| **Quant workflow** | Open notebook → DataFrame preview → time series analysis → code edit → backtest | 8, 4, 3 |
| **Security** | Injected secrets in code → redacted before LLM call → audit log records event → terminal guard blocks exfiltration | 2, 7 |
| **Concurrent** | 3 simultaneous chat sessions → request prioritisation → no race conditions | 4, 6 |

### 11.2 Performance Benchmarking

Target SLOs from §2.6 (lines 2006–2069):

| Metric | P50 | P95 | P99 |
|--------|-----|-----|-----|
| Completion (Local GPU) | 50ms | 150ms | 300ms |
| Completion (Local CPU) | 200ms | 500ms | 1000ms |
| Completion (Edge Cached) | 100ms | 250ms | 500ms |
| Completion (Cloud Optimized) | 300ms | 600ms | 1200ms |
| Completion (Cloud Standard) | 500ms | 1000ms | 2000ms |
| Chat TTFT | 500ms | 2000ms | 3500ms |
| Chat Streaming | 50ms | 100ms | — |
| Edit Preview Render | 100ms | 300ms | — |
| Edit Apply to Disk | 50ms | 200ms | — |
| Flexible Matching | 20ms | 100ms | — |
| Incremental File Index | 200ms | 500ms | — |
| Full Repo Index (10K files) | 5000ms | 30000ms | — |
| Checkpoint Create | 100ms | 500ms | — |
| Checkpoint Restore | 500ms | 2000ms | — |
| Memory (peak) | < 500MB | — | — |
| Memory (leak rate) | 0 MB/hr | — | — |
| Journal Write | — | < 10ms | — |

### 11.3 Security Audit

Run full Appendix C Validation Checklist (lines 8304–8370):

**Pre-Implementation Verification (10 checks):**
- All canonical types from single module
- No boolean permission returns
- Every lane has LANE_CONFIGURATIONS entry
- Every lane's promptKey exists in PROMPT_TEMPLATES
- All 22 tools with complete JSON schemas
- All BM25 tables use `qic_bm25_` prefix
- All secret patterns have test cases
- FileContent type used everywhere
- FileHandlingConfig tiers applied
- INV-T6 split into T6a/T6b/T6c

**Security Verification (9 checks):**
- Embedding consent flow
- Conversation encryption end-to-end
- First-run consent on launch
- TerminalSecurityGuard validates all commands
- ToolChainMonitor tracks all sequences
- SecurityAuditLogger integrity chain
- All egress boundaries have consent
- Aho-Corasick matches pure-regex results
- StreamingSecretScanner handles 100MB+ without OOM

**Architecture Verification (11 checks):**
- All FSMs have state diagrams
- JournaledAtomicWriter crash recovery
- TransactionSafeCheckpointManager recovery
- CV-1 through CV-5 enforced
- CancellationManager hierarchy propagation
- TimeoutManager domain separation
- ErrorRecoveryManager classification coverage
- PersistentAgentStateMachine survives process death
- PersistentTaskStateMachine resumes from last step
- ModelRegistry validates lane compatibility
- ModelRegistry handles deprecation

**Performance Verification (11 checks):**
- Degradation levels trigger correctly
- Memory budgets enforced
- Request prioritisation works under load
- Circuit breakers trip and recover
- Completion SLOs meet tier targets
- RateLimiter respects limits + quota sharing
- StreamingResponseHandler processes tool calls
- DynamicToolSelector stays within budget
- ArrowDataFrameBridge zero-copy transfer
- PythonSidecar idle timeout cleanup

### 11.4 V6.2 CI/CD Pipeline

Deploy the CI pipeline from §14.2 and Appendix C:

```bash
# Core test suites
npm run test:crash-recovery      # 600s timeout
npm run test:large-files          # 300s timeout
npm run test:state-persistence    # 120s timeout
npm run test:journal-atomicity    # 300s timeout
npm run test:checkpoint-validity  # 120s timeout
npm run test:rate-limiting        # 120s timeout
npm run test:stream-handling      # 120s timeout

# Additional CI gates
npm run test:unit                 # All unit tests, > 80% coverage
npm run test:integration          # Integration tests
npm run test:security             # Secret pattern tests, injection tests, chain tests
npm run test:performance          # SLO validation
npm run test:invariants           # All INV-* invariant tests
npm run validate:schema           # §14.2 schema validation (10 checks)
```

### Phase 11 Gate (Release Gate)

```
□ All 8 E2E scenarios pass
□ Performance benchmarks meet spec SLOs (from §2.6)
□ Appendix C validation checklist complete (all 41 checks)
□ All V6.2 CI/CD gates pass (7 test suites)
□ Unit test coverage > 80%
□ No critical or high severity bugs open
□ Security audit complete (penetration testing, secret pattern fuzzing, audit log integrity)
□ Documentation reviewed and published
□ All 11 invariants verified in final build
```

---

## Stub Interface Contracts

When a phase depends on a component from a later phase, it uses a stub. The LLM MUST implement these exact stub signatures so the real implementation is a drop-in replacement.

```typescript
// ═══ Phase 5 stubs for Phase 8 components ═══

// Stub: src/security/terminal-guard.ts (real implementation in Phase 8)
export class TerminalSecurityGuard {
  async validateCommand(command: string, context: ToolContext): Promise<{ allowed: boolean; reason?: string }> {
    // STUB: Allow all commands until Phase 8
    // Log warning so we can verify stub is replaced
    console.warn('[STUB] TerminalSecurityGuard.validateCommand — allowing all commands');
    return { allowed: true };
  }
}

// Stub: src/security/tool-chain-monitor.ts (real implementation in Phase 8)
export class ToolChainMonitor {
  recordToolCall(toolCall: ToolCall, context: ToolContext): void {
    // STUB: No-op until Phase 8
  }
  analyzeCurrentChain(sessionId: string): ChainAnalysis {
    // STUB: No suspicious sequences until Phase 8
    return { suspiciousSequence: false };
  }
}

// Stub: src/security/audit-logger.ts (real implementation in Phase 8)
export class SecurityAuditLogger {
  logAuthzGranted(tool: string, context: ToolContext): void { /* STUB */ }
  logAuthzDenied(tool: string, reason: string): void { /* STUB */ }
  logToolExecution(tool: string, status: string, context: ToolContext, meta?: any): void { /* STUB */ }
  logViolation(type: string, details: any): void { /* STUB */ }
  logEgressRequest(boundary: string, meta: any): void { /* STUB */ }
  async verifyChainIntegrity(): Promise<boolean> { return true; /* STUB */ }
}

// ═══ Phase 5 stubs for Phase 7 UI components ═══

// Stub: src/ui/permission-dialog.ts (real implementation in Phase 7)
// UIService.showPermissionDialog is used by PermissionManager
// Stub returns { granted: true } with console warning
// Stub UIService.showDiffPreview returns a mock ApprovalToken
// Stub UIService.streamChatToken writes to VS Code output channel (not webview)
```

**CI enforcement:** Add a test that greps for `[STUB]` warnings in the codebase. After Phase 8, this test MUST find zero matches. This ensures all stubs are replaced.

---

## Development & Debug Workflow

The LLM implementor should follow this workflow for every phase:

### Setup
```bash
# Initial setup (run once)
cd qic/
npm install
npm run compile  # or: npx tsc --noEmit --strict (type check only)
```

### Development Loop
```bash
# 1. Type-check (fast — no emit)
npx tsc --noEmit --strict

# 2. Run unit tests for the phase
npx jest --testPathPattern="test/unit/crash-safe"  # Phase 0 example

# 3. Launch Extension Development Host for manual testing
# Press F5 in VS Code with launch.json configured
# Or: code --extensionDevelopmentPath=/path/to/qic

# 4. View extension output
# In Extension Development Host: View → Output → select "QIC" channel
```

### Debugging
- All `console.log` output goes to VS Code's Output channel (set `log.level: 'debug'` in settings)
- Use VS Code debugger with breakpoints in the Extension Development Host
- For webview debugging: Command Palette → "Developer: Open Webview Developer Tools"

### Mock Providers for Testing
```typescript
// Use this mock provider adapter for testing without real API keys
class MockProviderAdapter implements ProviderAdapter {
  id = 'mock';
  name = 'Mock Provider';
  type = 'llm' as const;
  async isAvailable() { return true; }
  async getHealth() { return { status: 'healthy' as const, latencyMs: 10, errorRate: 0, lastChecked: new Date().toISOString() }; }
  async sendRequest(request: ProviderRequest) {
    // Return canned responses based on request content
    return { content: [{ type: 'text', text: 'Mock response' }] };
  }
  cancelRequest() {}
}
```

### CI Validation (run before committing)
```bash
# Full validation suite
npx tsc --noEmit --strict
npx jest --coverage
npm run validate:schema  # §14.2 checks
```

---

## Spec-to-Implementation Cross-Reference Matrix

Every section of the spec mapped to its implementation file and phase.

| Spec Section | Lines | Implementation File | Phase |
|-------------|-------|-------------------|-------|
| §1.x Executive Summary | 1–200 | N/A (informational) | — |
| §2.1.1 EditScript / FileContent | 210–444 | `canonical/types.ts` + `crash-safe/file-content.ts` | 0, 1 |
| §2.1.2 PermissionCheckResult | 444–511 | `canonical/types.ts` | 1 |
| §2.1.3 Lane Configuration | 511–964 | `canonical/lanes.ts` | 1 |
| §2.2 Trust Invariants (INV-T1–T6, INV-A1–A4) | 964–1536 | Enforced across all modules | All |
| §2.3 Data Flow Guarantees | 1536–1647 | `canonical/egress.ts` + `security/egress-enforcer.ts` | 1, 2 |
| §2.4 First-Run Consent | 1647–1806 | `security/consent-store.ts` + `security/first-run-manager.ts` | 2 |
| §2.5 Timeout Manager | 1806–2005 | `timeout/timeout-manager.ts` | 1 |
| §2.6 Performance SLOs | 2006–2069 | Test targets in Phase 10 | 10 |
| §3.1 Component Overview | 2071–2119 | Architecture reference | All |
| §3.2 State Machines | 2119–2444 | `state/agent-state-machine.ts` + `state/task-state-machine.ts` + `state/conversation-state.ts` | 0, 1 |
| §3.3 Cancellation Protocol | 2444–2568 | `cancellation/cancellation-manager.ts` | 1 |
| §3.4 Error Recovery | 2568–2798 | `recovery/error-recovery-manager.ts` | 3 |
| §3.5 Core Interfaces | 2798–3113 | `canonical/interfaces.ts` | 1 |
| §4.1 Lane Definitions | 3113–3119 | `canonical/lanes.ts` | 1 |
| §4.2 Model Recommendations | 3119–3185 | `completion/model-registry.ts` + `completion/fim-adapter.ts` | 6 |
| §4.3 Token Budget | 3185–3228 | `context/context-assembler.ts` | 5 |
| §4.4 Completion Architecture | 3228–3273 | `completion/completion-engine.ts` | 6 |
| §4.5 Model Version Management | 3273–3512 | `completion/model-registry.ts` | 6 |
| §5.1 Storage Overview | 3512–3538 | `storage/database.ts` | 1 |
| §5.2 BM25 Schema | 3538–3592 | `storage/bm25-schema.ts` | 1 |
| §5.3 Encrypted Conversation | 3592–3716 | `security/conversation-cipher.ts` + `storage/conversation-schema.ts` | 1, 2 |
| §5.4 Checkpoint Format | 3716–3990 | `crash-safe/checkpoint-validity.ts` + `checkpoint/checkpoint-manager.ts` | 0, 3 |
| §6.1 JournaledAtomicWriter | 3990–4464 | `crash-safe/journaled-atomic-writer.ts` | 0 |
| §6.2 Conflict Detection | 4464–4588 | `mutation/conflict-detector.ts` | 3 |
| §6.3 Flexible Matching | 4588–4977 | `mutation/flexible-matcher.ts` | 3 |
| §7.1 Step Executor | 4977–5062 | `runtime/step-executor.ts` | 5 |
| §7.2 Tool Router | 5062–5163 | `runtime/tool-router.ts` + `runtime/permission-manager.ts` | 5 |
| — Agent Orchestrator | — (implicit in spec) | `runtime/agent-orchestrator.ts` | 5 |
| — Lane Router | — (implicit in spec) | `runtime/lane-router.ts` | 5 |
| — Provider Adapters | §4.2, §4.5 | `gateway/providers/anthropic-adapter.ts`, `openai-adapter.ts`, `ollama-adapter.ts` | 4 |
| — Python Env Manager | — (operational) | `quant/python-env-manager.ts` | 9 |
| §8.1 Secure Embedding | 5165–5227 | `context/secure-embedding.ts` | 5 |
| §8.2 RAG Pipeline | 5227–5325 | `context/incremental-indexer.ts` | 5 |
| §8.3 Reranking | 5325–5384 | `context/reranker.ts` | 5 |
| §8.4 Dynamic Tool Selection | 5384–5514 | `context/dynamic-tool-selector.ts` | 5 |
| §9.1 Circuit Breaker | 5514–5597 | `recovery/circuit-breaker.ts` | 3 |
| §9.2 Request Prioritisation | 5597–5687 | `gateway/request-manager.ts` | 4 |
| §9.3 Rate Limiting | 5687–5938 | `gateway/rate-limiter.ts` | 4 |
| §9.4 Streaming Handler | 5938–6236 | `gateway/streaming-handler.ts` | 4 |
| §10.1 Secret Patterns | 6236–6945 | `security/secret-scanner.ts` + `security/secret-patterns.ts` | 2 |
| §10.2 Terminal Security | 6945–7062 | `security/terminal-guard.ts` | 8 |
| §10.3 Tool Chain Monitor | 7062–7158 | `security/tool-chain-monitor.ts` | 8 |
| §10.4 Audit Logger | 7158–7291 | `security/audit-logger.ts` | 8 |
| §11.1 DataFrame Preview | 7293–7336 | `quant/dataframe-safety.ts` | 9 |
| §11.2 Time Series | 7336–7378 | `quant/time-series.ts` | 9 |
| §11.3 Quant Library Awareness | 7378–7440 | `quant/quant-patterns.ts` | 9 |
| §11.4 Arrow IPC | 7440–7547 | `quant/arrow-bridge.ts` | 9 |
| §11.5 Python Sidecar | 7547–7761 | `quant/python-sidecar.ts` + `python/qic_sidecar/` | 9 |
| §12.1 Degradation Manager | 7763–7857 | `resilience/degradation-manager.ts` | 6 |
| §12.2 Memory Manager | 7857–7939 | `resilience/memory-manager.ts` | 6 |
| §12.3 Telemetry | 7939–7974 | `telemetry/telemetry-service.ts` | 10 |
| §13.1 LSP Tools | 7974–8016 | `lsp/lsp-tools.ts` | 9 |
| §14.1 Test Strategy | 8016–8051 | `test/` directory structure | 11 |
| §14.2 CI Validation | 8051–8114 | `scripts/validate-*.ts` | 11 |
| §15.1 Implementation Phases | 8114–8177 | This document | — |
| Appendix A: Tool Registry | 8177–8233 | `canonical/tools.ts` | 1 |
| Appendix B: Error Registry | 8233–8304 | `canonical/errors.ts` | 1 |
| Appendix C: Validation Checklist | 8304–8465 | Phase 11 test scripts | 11 |

---

## Invariant Verification Matrix

Every phase gate must verify that no invariant has been violated by the new code.

| Invariant | Description | First Enforced | Mechanism |
|-----------|-------------|----------------|-----------|
| INV-T1 | Preview Before Apply | Phase 3 | `ApprovalToken` required by `MutationEngine.apply()` type signature |
| INV-T2 | No Silent Execution | Phase 4 | `ToolRouter` always logs via `SecurityAuditLogger` |
| INV-T3 | Secret Protection | Phase 2 | `EgressBoundaryEnforcer` calls `SecretRedactor` before every external send |
| INV-T4 | Checkpoint Integrity | Phase 0 | CV-1 through CV-5 validation on every checkpoint read |
| INV-T5 | Cancellation Safety | Phase 1 | Hierarchical `AbortController` with cleanup hooks |
| INV-T6a | Deterministic Local Ops | Phase 1 | Pure functions for local operations; no randomness |
| INV-T6b | Reproducible Requests | Phase 9 | `ReproducibilityLogger` records all requests |
| INV-T6c | Best-Effort Reproducibility | Phase 9 | `ReplayModeSupport` with 3 modes |
| INV-A1 | Single Source of Truth | Phase 1 | `canonical/index.ts` is sole type authority; CI enforces |
| INV-A2 | Atomic Multi-File Ops | Phase 0 | `JournaledAtomicWriter` with fsync + journal recovery |
| INV-A3 | Checkpoint Crash Safety | Phase 0 | PENDING/COMPLETE markers, quarantine on corruption |
| INV-A4 | Timeout Domain Separation | Phase 1 | `TimeoutManager` with USER_INTERACTION domain (no timeout) |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Journal write latency exceeds 10ms on HDD | Medium | High | Detect HDD at startup via write benchmark; batch journal writes; warn user; suggest SSD |
| Aho-Corasick native addon compatibility (Node.js version, platform) | Medium | Medium | Pure-JS fallback implementation (~200 lines); accept slight perf hit (still 2× faster than sequential) |
| Arrow IPC shared memory not available (Windows, some containers) | Medium | Low | Temp file fallback specified in spec; performance slightly reduced |
| Python sidecar dependency conflicts (numpy/scipy versions vs user env) | High | Medium | Ship pinned virtualenv with `requirements.txt`; detect system Python issues at startup; provide `qic.pythonPath` setting |
| Windows atomic rename limitations (NTFS) | High | Medium | `MoveFileEx` wrapper documented; write-new-then-delete-old fallback |
| Large workspace (>50K files) exceeds memory budget | Medium | High | Aggressive eviction; reduce vector index dimensions (256→128); pagination for search results; incremental indexing only |
| LanceDB compatibility issues (native addon) | Medium | Medium | Fall back to file-based vector storage; accept slower search |
| VS Code API changes in future versions | Low | Medium | Pin minimum VS Code version; use stable APIs only; test against 2 recent VS Code versions |
| LLM provider API breaking changes | Medium | Medium | Provider adapters abstract API differences; model registry handles deprecation gracefully |
| Webview Content Security Policy issues | Medium | Low | Strict CSP; no inline scripts; all resources loaded from extension bundle |

---

## Team Allocation Recommendation

| Engineer | Ph 0 | Ph 1 | Ph 2 | Ph 3 | Ph 4 | Ph 5 | Ph 6 | Ph 7 | Ph 8 | Ph 9 | Ph 10 | Ph 11 |
|----------|------|------|------|------|------|------|------|------|------|------|-------|-------|
| Core-1 | Journal, Checkpoint | State machines, timeout | — | Mutation engine, conflict | — | StepExec, ToolRouter, **Orchestrator** | Completion engine | — | — | — | — | E2E, perf |
| Core-2 | Streams, State persist | Storage, DB init | — | Error recovery, circuit | Gateway, providers, rate limiter, streaming | Embedding, indexer | Degradation, memory | — | — | — | — | E2E, perf |
| Feature-1 | — | Canonical types | — | — | Request manager | Reranker, context assembler, **LaneRouter** | Model registry, FIM | Chat panel, diff widget | — | DataFrame, Arrow IPC, LSP | Docs | E2E |
| Feature-2 | Ext scaffold | — | — | — | **Provider adapters** | Dynamic tool selector | — | Inline completion, indicators | — | Sidecar, **venv mgr**, quant | Telemetry, replay | E2E |
| Security | — | — | Egress, consent, secrets, encryption | — | — | Permission manager | — | First-run UI, permission UI | Terminal, toolchain, audit | — | Security docs | Security audit |
| QA | Gate test | Gate test | Gate test | Gate test | Gate test | Gate test | Gate test | Gate test | Gate test | Gate test | Gate test | Full verify |

**Bold** items are v3 additions that were absent in v2.

---

## Phase Timeline Summary

| Phase | Name | Weeks | Duration | Key Deliverables |
|-------|------|-------|----------|-----------------|
| 0 | Scaffold + Crash-Safe | W1 | 1 wk | Extension loads; journal, checkpoints, streams, state persist; activation sequence |
| 1 | Foundation | W2 | 1 wk | Canonical types, storage layer, state machines, timeout, cancellation |
| 2 | Security Foundation | W3 | 1 wk | Egress, consent, Aho-Corasick scanner, encryption |
| 3 | Mutation & Reliability | W4–5 | 1.5 wk | Mutation engine, conflict detector, checkpoints, error recovery, circuit breakers |
| 4 | Network Layer | W5–6 | 1.5 wk | Gateway, 3 provider adapters, rate limiter, streaming handler, request manager |
| 5 | Agent Runtime & Context | W6–8 | 2 wk | Step executor, tool router, embedding, indexing, reranking, **agent orchestrator**, **lane router** |
| 6 | Completion & Resilience | W8–9 | 1.5 wk | Tiered completion, model registry, FIM adapter, degradation, memory management |
| 7 | UI Layer | W9–11 | 2 wk | Chat panel, inline completion, diff widget, permission dialogs, status indicators |
| 8 | Security Hardening | W11 | 1 wk | Terminal guard, tool chain monitor, audit logger; replace all stubs |
| 9 | Quant Domain + LSP | W12–13 | 1.5 wk | DataFrame, Arrow IPC, Python sidecar+venv, time series, quant patterns, LSP tools |
| 10 | Telemetry & Documentation | W13–14 | 1 wk | Telemetry, reproducibility, replay, documentation |
| 11 | Integration & Stabilisation | W14–17 | 2–3 wk | 8 E2E scenarios, performance benchmarks, security audit, CI/CD, release |

**Total: 17–19 weeks.** Phases 3/4 and 7/8 can overlap with sufficient team parallelism, reducing to ~15 weeks. The critical path is: 0 → 1 → 3 → 4 → 5 → 6 → 7 → 11 (13 weeks sequential).

---

*End of QIC v6.2 Implementation Plan — v3 Final Audited*
