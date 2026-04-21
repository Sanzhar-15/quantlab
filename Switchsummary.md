# QIC Project Context — Handoff Document

## What This Project Is

**Quantlab** is a VSCodium (VS Code) fork. **QIC** (Quantlab Intelligent Coder) is a built-in AI coding assistant extension within the fork, located at:

```
src/vs/workbench/contrib/qic/
```

The codebase follows VS Code's contribution pattern: services registered via `createDecorator`, dependency injection, `registerWorkbenchContribution2` for activation, `registerAction2` for commands.

## Project Timeline — What Has Been Done

### Phase A-D (Prior Sessions, Complete)
- **Production hardening**: 9 fixes across 13 files (circuit breaker, gateway retry, database warnings, UI timeout, error redaction, provider fault tolerance, LSP tool disabling, consent store mutex, test stub cleanup)
- **Server-side implementation plan**: 8 documents written in `Server_side_implementation_plan/`
- **Deep audit**: 62 findings identified, all integrated into the 8 plan documents
- **External audit integration**: 7 issues found in plans, all fixed

### Phase 1 Implementation (Current Session, Complete)
All 11 deliverables implemented with **0 TypeScript errors**. Phase 1 is "Extension-Side Foundation" — ships the QuantlabCloudAdapter, auth flow, settings, and structural prerequisites. The server doesn't exist yet.

## Architecture Overview

```
qic/
├── browser/                    # VS Code browser-layer (UI, activation, commands)
│   ├── qic.contribution.ts     # Main activation file (~1200 lines) — THE MOST IMPORTANT FILE
│   ├── qicPanel.ts             # Chat view pane (webview host)
│   ├── qicStatusBarItem.ts     # Status bar contribution
│   ├── qicInlineCompletionProvider.ts
│   ├── uiService.ts            # Webview bridge
│   └── auth/
│       ├── quantlabAuth.ts     # OAuth2 PKCE flow
│       └── uriHandler.ts       # vscode:// URI callback handler
├── common/                     # Shared logic (no browser/node deps)
│   ├── canonical/
│   │   ├── interfaces.ts       # ProviderAdapter, StreamChunk, GatewayMetadata, UIService
│   │   ├── types.ts            # ProviderRequest, QicError, ToolDefinition, etc.
│   │   ├── lanes.ts            # LaneName type (8 lanes)
│   │   └── tools.ts            # TOOL_REGISTRY (22 tools, 3 LSP disabled)
│   ├── constants.ts            # All setting keys, command IDs, secret keys, types
│   ├── qicService.ts           # IQicService — lifecycle state, QicRuntime interface
│   ├── qicCrypto.ts            # randomUUID, sha256Hex
│   ├── gateway/
│   │   ├── gateway.ts          # Gateway class — provider routing + circuit breakers
│   │   ├── modelRegistry.ts    # CRITICAL-1: per-lane ordered preference arrays
│   │   ├── rateLimiter.ts      # Token bucket rate limiter
│   │   └── providers/
│   │       ├── quantlabCloudAdapter.ts  # NEW: Quantlab Cloud (native QIC protocol)
│   │       ├── anthropicAdapter.ts      # Anthropic API adapter
│   │       ├── openaiAdapter.ts         # OpenAI API adapter
│   │       ├── ollamaAdapter.ts         # Local Ollama adapter
│   │       └── errorRedaction.ts        # Sensitive data redaction for error messages
│   ├── security/
│   │   ├── consentStore.ts     # Egress consent with DataTier sync
│   │   ├── egressEnforcer.ts   # EgressBoundary gatekeeper
│   │   ├── secretScanner.ts    # Regex-based secret detection
│   │   ├── auditLogger.ts      # Hash-chained audit log
│   │   └── ...
│   ├── runtime/
│   │   ├── agentOrchestrator.ts # Main agent loop (streaming + tool execution)
│   │   ├── toolRouter.ts       # Tool dispatch + permission checks
│   │   ├── laneRouter.ts       # Lane selection logic
│   │   └── ...
│   ├── resilience/
│   │   ├── degradationManager.ts # 5-level degradation (Normal→Emergency)
│   │   └── memoryManager.ts
│   ├── recovery/
│   │   └── circuitBreaker.ts   # Per-provider circuit breaker with state listeners
│   ├── telemetry/
│   │   ├── telemetryService.ts  # DataTier-based filtering
│   │   ├── qualitySignalService.ts # NEW: local quality signal tracking
│   │   └── sessionCache.ts
│   ├── storage/
│   │   └── database.ts         # SQLite wrapper (falls back to in-memory)
│   └── ...
└── test/
    ├── common/
    │   ├── gateway/
    │   │   ├── rateLimiter.test.ts
    │   │   └── quantlabCloudAdapter.test.ts  # NEW: 14 tests
    │   ├── auth/
    │   │   └── quantlabAuth.test.ts          # NEW: 12 tests
    │   └── ...
    ├── integration/
    │   └── mockCloudServer.ts                # NEW: Mock QIC protocol server
    ├── e2e/
    ├── invariants/
    └── helpers/
        └── testUtilities.ts
```

## Key Types and Interfaces

### ConnectionMode
```typescript
type ConnectionMode = 'cloud' | 'byok' | 'local';
```

### DataTier (replaces boolean TELEMETRY_ENABLED)
```typescript
type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';
```

### LaneName (8 lanes)
```typescript
type LaneName = 'completion' | 'chat-ask' | 'chat-gather' | 'chat-plan' | 'chat-act' | 'repair' | 'fast-apply' | 'summarize';
```

### ProviderAdapter
```typescript
interface ProviderAdapter {
    readonly id: string;
    readonly name: string;
    readonly type: 'llm' | 'embedding';
    isAvailable(): Promise<boolean>;
    getHealth(): Promise<ProviderHealth>;
    sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse>;
    sendStreaming(request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk>;
    cancelRequest(requestId: string): void;
}
```

### StreamChunk (discriminated union)
```typescript
type StreamChunk =
    | { type: 'text'; text: string }
    | { type: 'tool_call_start'; id: string; name: string }
    | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
    | { type: 'tool_call_end'; id: string }
    | { type: 'done'; usage?: TokenUsage; stopReason?: string; providerMeta?: Record<string, unknown> }
    | { type: 'error'; error: QicError };
```

### ModelRegistry (CRITICAL-1 restructure)
Per-lane ordered preference arrays. Resolution: lane override → iterate preference array checking provider availability → any available model.
```typescript
const LANE_MODEL_RECOMMENDATIONS: Record<LaneName, string[]> = {
    'completion': ['cloud-fast', 'local-fast', 'gpt-latest'],
    'chat-ask': ['cloud-default', 'claude-latest', 'gpt-latest'],
    // ... etc
};
```

### DegradationManager (5 levels)
```
0 = Normal
1 = ReducedQuality (cloud CB open, BYOK available)
2 = NoCompletions
3 = LocalOnly (cloud + BYOK down, only Ollama)
4 = Emergency (everything down or OOM)
```

## Activation Flow (qic.contribution.ts)

The `QicActivation` class runs in `WorkbenchPhase.AfterRestored`. Steps:

| Step | Name | What It Does |
|------|------|-------------|
| 0 | directories | Creates workspace storage dirs |
| 1 | crash-recovery | Journals rollforward (non-fatal if sandboxed) |
| 2 | database | SQLite init (falls back to in-memory) |
| 3 | state-recovery | Agent state machine restore |
| 4 | security | SecretScanner, ConsentStore, EgressEnforcer, AuditLogger |
| 5 | first-run | Consent dialog for first-time users |
| 6 | gateway | **Connection mode branching**: cloud adapter (gated by `qic.cloud.enabled`), BYOK adapters, Ollama, circuit breakers, model registry, DataTier sync |
| 7 | context | Embedding service + incremental indexer |
| 8 | runtime | DegradationManager, orchestrator, tools, checkpoints, quality signals |
| 8b | (inline) | Status bar registration |
| 9 | completion | CompletionEngine + inline provider |
| 10 | indexing | Background workspace indexing (non-blocking) |

## Settings (registered in contribution file)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `qic.connectionMode` | enum | `'cloud'` | cloud/byok/local |
| `qic.cloud.enabled` | boolean | `false` | Feature flag for cloud path |
| `qic.cloud.baseUrl` | string | `'https://api.quantlab.dev'` | Server URL |
| `qic.cloud.devMode` | boolean | `false` | Allow HTTP localhost |
| `qic.dataTier` | enum | `'private'` | Data sharing level |
| `qic.laneOverrides` | object | `{}` | Per-lane provider overrides |
| `qic.telemetry.enabled` | boolean | `false` | DEPRECATED (→ dataTier) |
| `qic.provider.default` | enum | `'anthropic'` | Default BYOK provider |
| `qic.provider.ollamaUrl` | string | `'http://localhost:11434'` | Ollama URL |
| `qic.completion.enabled` | boolean | `true` | Inline completions |

## Commands (13 total, all registered via registerAction2)

| Command ID | What It Does |
|-----------|-------------|
| `qic.newChat` | New conversation (Ctrl+Alt+N) |
| `qic.cancel` | Cancel current (Escape) |
| `qic.focusInput` | Focus chat input (Ctrl+L) |
| `qic.createCheckpoint` | Snapshot workspace |
| `qic.restoreCheckpoint` | Restore from checkpoint |
| `qic.showSettings` | Open QIC settings |
| `qic.toggleCompletion` | Toggle inline completions |
| `qic.retryConnection` | Health check all providers |
| `qic.setApiKey` | Store BYOK API key in SecretStorage |
| `qic.signIn` | OAuth2 PKCE flow → browser → URI callback → token exchange |
| `qic.signOut` | Revoke + clear tokens |
| `qic.accountInfo` | Show JWT claims + connection mode |
| `qic.switchConnectionMode` | Quick pick cloud/byok/local |

## QuantlabCloudAdapter Details

- Speaks QIC canonical protocol natively (no format translation)
- SSE streaming with routing event pre-filter (consumed, not yielded)
- `meta` → `providerMeta` mapping on done chunks
- JWT auto-refresh on 401 + `X-QIC-Token-Refresh: required` header
- HTTPS validation (localhost exception in devMode)
- Error redaction via `redactErrorBody()`
- Idempotency key (`X-QIC-Idempotency-Key`) per request
- `Accept-Encoding: gzip` header
- `X-QIC-Extension-Version` header
- `onRouting()` and `onQuotaUpdated()` event listeners

## Server-Side Implementation Plan

Located at `/home/steppen0mad/Desktop/quantlab/quantlab/Server_side_implementation_plan/`:

| Doc | Title | Content |
|-----|-------|---------|
| 01 | Extension Integration | How extension talks to server |
| 02 | API Contract | REST + SSE endpoints, idempotency |
| 03 | Auth & Identity | OAuth2, JWT, RBAC |
| 04 | Infrastructure | Kubernetes, Redis, PostgreSQL |
| 05 | Billing & Subscriptions | Stripe, usage tracking |
| 06 | Implementation Phases | 6 phases with deliverables |
| 07 | Migration from Current | Step-by-step migration guide |
| 08 | Security & Compliance | Threat model, data handling |

## What Comes Next (Phase 2+)

**Phase 2: Server MVP** — A working server that authenticates users, forwards requests to Anthropic, and returns streaming responses. Defined in `06-implementation-phases.md` lines 117+.

Key Phase 2 deliverables:
- Express/Fastify server with QIC protocol endpoints
- JWT verification middleware
- Single-provider proxy (Anthropic initially)
- PostgreSQL for user/session state
- Redis for rate limiting + idempotency cache
- Deployment to Kubernetes

## Known Technical Debt / Open Items

1. **Hot-swap is reload-based**: Config changes prompt "Reload Window" rather than live gateway replacement. True hot-swap would require updating references held by orchestrator, completion engine, etc.

2. **Quality signal service integration**: The service exists and stores data but isn't yet called from the completion engine or orchestrator. The hooks need to be wired into `QicInlineCompletionProvider` (acceptance/rejection) and `AgentOrchestrator` (follow-ups, re-requests).

3. **Tests use real HTTP**: The adapter and auth tests spin up actual HTTP servers on localhost. They work but are integration-style, not pure unit tests.

4. **Feature flag `qic.cloud.enabled` defaults to `false`**: Must be flipped to `true` at GA.

5. **URI handler not registered with VS Code**: The `QicAuthUriHandler` is instantiated per sign-in flow but not registered via `IURIHandlerService`. The sign-in command creates its own handler instance — for production, this should be registered once at activation.

## Test Framework

- Mocha-style: `suite()`, `test()`, `suiteSetup()`, `suiteTeardown()`, `setup()`
- Assertion: Node.js `assert` module (`assert.strictEqual`, `assert.ok`, `assert.throws`, `assert.rejects`)
- No Jest, no vitest

## Build/Compile

- Full project TypeScript compile causes OOM (it's a VS Code fork). Use per-file IDE diagnostics instead.
- Launch: `./scripts/code.sh`
- All QIC files currently pass with 0 TypeScript diagnostics.
