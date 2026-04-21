# QIC Architecture — Developer Guide

## Component Dependency Graph

```
qic.contribution.ts (activation)
├── QicService (lifecycle state)
├── Phase A (sync, < 5s)
│   ├── registerSingleton() — all services
│   ├── registerAction2() — all 9 commands
│   └── Configuration registration
└── Phase B (async)
    ├── JournaledAtomicWriter — crash recovery
    ├── QicDatabase — SQLite storage
    ├── StatePersistence — session state
    ├── Security layer
    │   ├── ConsentStore
    │   ├── OptimizedSecretScanner (Aho-Corasick)
    │   ├── EgressBoundaryEnforcer
    │   ├── TerminalSecurityGuard
    │   ├── ToolChainMonitor
    │   └── HashChainedAuditLogger
    ├── Gateway
    │   ├── AnthropicAdapter
    │   ├── OpenAIAdapter
    │   ├── OllamaAdapter
    │   ├── TokenBucketRateLimiter
    │   └── CircuitBreaker
    ├── Context Engine
    │   ├── IncrementalIndexer (BM25 + vector)
    │   ├── SecureEmbeddingService
    │   ├── RRFReranker
    │   └── ContextAssembler
    ├── Agent Runtime
    │   ├── AgentOrchestrator (agentic while-loop)
    │   ├── LaneRouter (8 lanes)
    │   ├── ToolRouter (22 tools)
    │   ├── PermissionManager
    │   └── StepExecutor
    ├── Completion Engine
    │   ├── CompletionEngine (6-tier waterfall)
    │   ├── FIMAdapter (5 providers)
    │   └── QicInlineCompletionProvider
    └── Background indexing (non-blocking)
```

## Data Flow: User Message → Response

```
1. User types message in chat webview
2. WebviewToHostMessage('user-message') → QicChatViewPane
3. QicChatViewPane → AgentOrchestrator.processMessage()
4. LaneRouter.classify() → determines lane (chat-ask, chat-act, etc.)
5. ContextAssembler.assemble() → gathers relevant context for the lane
6. Gateway.sendRequest() → sends to LLM provider
7. Provider responds (may include tool_use blocks)
8. WHILE response.stopReason === 'tool_use':
   a. ToolRouter.execute() for each tool call
   b. PermissionManager.check() → approval if needed
   c. Tool executes, returns ToolResultPayload
   d. Results appended to messages
   e. Gateway.sendRequest() again with tool results
9. Final text response → HostToWebviewMessage('stream-chunk')
10. Chat webview renders markdown response
```

## File Organization

```
src/vs/workbench/contrib/qic/
├── browser/                    # Browser-only (UI, webview, DOM)
│   ├── qic.contribution.ts    # Activation & wiring
│   ├── qicPanel.ts            # Chat ViewPane
│   ├── qicStatusBarItem.ts    # Status bar
│   ├── qicInlineCompletionProvider.ts
│   ├── uiService.ts           # Diff/permission dialogs
│   ├── firstRunView.ts        # First-run consent
│   └── media/                  # Webview assets (HTML, CSS, JS)
├── common/                     # Shared (node + browser)
│   ├── canonical/              # Types, errors, registries (INV-A1)
│   ├── crashSafe/              # JournaledAtomicWriter, checkpoints
│   ├── storage/                # SQLite, BM25 schema
│   ├── security/               # Scanner, egress, terminal guard
│   ├── gateway/                # Provider adapters, rate limiter
│   ├── context/                # Indexer, embeddings, reranker
│   ├── runtime/                # Orchestrator, lane router, tools
│   ├── mutation/               # Edit engine, matcher
│   ├── completion/             # FIM adapter, completion engine
│   ├── resilience/             # Memory manager, degradation
│   ├── telemetry/              # Telemetry, replay, session cache
│   ├── quant/                  # DataFrame, Arrow, Python bridge
│   ├── tools/                  # All 22 tool implementations
│   ├── ipc/                    # IPC types (mirrored from extensions/)
│   ├── ui/                     # Message protocol types
│   ├── constants.ts
│   └── qicService.ts
├── test/                       # All test files
│   ├── common/                 # Unit tests
│   ├── e2e/                    # End-to-end tests
│   ├── performance/            # Benchmarks & load tests
│   ├── invariants/             # Invariant verification
│   └── helpers/                # Shared test utilities
└── scripts/                    # CI validation scripts
```

## How to Add a New Tool

1. Create `common/tools/myTool.ts` implementing handlers that return `ToolResultPayload`
2. Add tool registration in `common/tools/toolRegistration.ts`
3. Add tool definition to `common/canonical/toolDefinitions.ts` (name, description, parameters, hasSideEffects)
4. Add tests in `test/common/tools/myTool.test.ts`
5. Update `scripts/validate-tool-registry.ts` expected tools list

## How to Add a New Provider Adapter

1. Create `common/gateway/myProviderAdapter.ts` implementing `ProviderAdapter` interface
2. Register in Gateway constructor (via activation wiring)
3. Add to `qic.provider.default` enum in configuration
4. Add tests with mock responses

## Key Architectural Decisions

- **INV-T1**: No edits without ApprovalToken (type-system enforcement)
- **INV-T3**: No data leaves without consent and secret redaction
- **I-1**: Agentic loop uses explicit while-loop (not streaming for-await)
- **I-SG5**: Summarize trigger at 80% budget
- **XI-SV2**: Two-step path validation with symlink resolution
- **XI-SV6**: SSRF prevention (block private IPs, loopback, link-local)
- **III-QI2**: Python bridge reuses existing engine daemon (no new sidecar)
- **XI-SV7**: API keys stored via SecretStorage (not plaintext settings)
- **IV-AO3**: Activation split into Phase A (sync) + Phase B (async)
