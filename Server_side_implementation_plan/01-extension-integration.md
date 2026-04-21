# Extension-Side Integration

## Principle: Minimal Invasion (with caveats)

The existing QIC architecture was designed with provider-agnostic abstractions. Every component above the adapter layer -- Gateway, AgentOrchestrator, LaneRouter, ContextAssembler, ToolRouter -- operates on canonical types (`ProviderRequest`, `ProviderResponse`, `StreamChunk`). Adding the cloud path requires:

1. A new adapter class
2. Authentication infrastructure
3. Configuration changes
4. Modified activation flow
5. **Targeted structural changes** (see below)

**What does NOT change:** The orchestrator, lanes, tools, context assembly.

**What requires targeted modification:**
- `interfaces.ts`: Widen `ProviderAdapter` with `Partial<GatewayMetadata>` (CRITICAL-2)
- `interfaces.ts`: Extend `StreamChunk` `done` variant with `providerMeta` (MEDIUM-1)
- `modelRegistry.ts`: Restructure `LANE_MODEL_RECOMMENDATIONS` from `Record<string, string>` to `Record<LaneName, string[]>` (CRITICAL-1)
- `gateway.ts`: Provider-aware egress boundary selection (CRITICAL-3)
- `egressEnforcer.ts`: Add `'quantlab-cloud'` to `EgressBoundary`
- `consentStore.ts`: Add `DataTier` concept
- `degradationManager.ts`: Hook up cloud adapter state

---

## 1. QuantlabCloudAdapter

**File:** `common/gateway/providers/quantlabCloudAdapter.ts`

Implements `ProviderAdapter` from `canonical/interfaces.ts`.

### Design Decisions

**Protocol choice:** The server speaks QIC's canonical format natively. The adapter serializes `ProviderRequest` to JSON, sends it via HTTPS, and deserializes `StreamChunk` events from an SSE stream. This makes the adapter extremely thin -- no format translation needed (unlike `AnthropicAdapter` which must convert between Anthropic's native format and QIC's canonical format).

**Why not reuse the Anthropic/OpenAI format?** If the server exposed an Anthropic-compatible API, we could reuse `AnthropicAdapter` pointed at a different URL. This seems simpler but creates problems:
- The server would need to maintain format compatibility with Anthropic's evolving API
- New QIC-specific features (lane hints, routing metadata, usage quotas) would need to be smuggled through Anthropic-format fields
- Tool definitions and streaming chunks already have a canonical QIC format -- translating to Anthropic format and back is pointless overhead

**Why a native QIC protocol is better:**
- The adapter sends `GatewayRequest` directly (it already includes `lane`, `priority`, `sessionId`)
- The server returns `StreamChunk` directly (already normalized)
- Adding new metadata (quota remaining, model used, cache hits) is trivial
- The adapter is ~100 lines instead of ~260 for the Anthropic adapter

### Interface Changes Required (CRITICAL-2)

The `ProviderAdapter` interface must be widened so the cloud adapter can access `lane`, `priority`, and `sessionId` through typed fields rather than relying on implicit JavaScript structural typing:

```typescript
// NEW: Add to canonical/interfaces.ts
export interface GatewayMetadata {
    lane: LaneName;
    priority: RequestPriority;
    sessionId?: string;
}

// UPDATED: ProviderAdapter method signatures
export interface ProviderAdapter {
    sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse>;
    sendStreaming(request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk>;
    getHealth(): Promise<ProviderHealth>;
    isAvailable(): boolean;
    cancelRequest(requestId: string): void;
}
```

This is a non-breaking change: existing adapters (Anthropic, OpenAI, Ollama) continue to work since `GatewayMetadata` fields are optional via `Partial<>`. Only the cloud adapter reads them.

### StreamChunk Extension (MEDIUM-1)

The server returns a `meta` field on `done` chunks containing `actualModel`, `routingTier`, `quotaRemaining`. The canonical `StreamChunk` type must carry this:

```typescript
// UPDATED: In canonical/interfaces.ts, done variant
| { type: 'done'; usage?: TokenUsage; stopReason?: string; providerMeta?: Record<string, unknown> }
```

The adapter maps `meta` -> `providerMeta`. All existing code paths ignore `providerMeta` (the orchestrator doesn't read it). The UI service can surface metadata (actual model, quota) without changing the orchestrator.

### Config Interface

```typescript
export interface QuantlabCloudConfig {
    baseUrl: string;         // 'https://api.quantlab.dev' (production)
    accessToken: string;     // JWT from OAuth2 flow
    refreshToken?: string;   // For automatic token refresh
    onTokenRefresh?: (newAccessToken: string, newRefreshToken?: string) => Promise<void>;
}

export class QuantlabCloudAdapter implements ProviderAdapter {
    readonly id = 'quantlab-cloud';
    readonly name = 'Quantlab Cloud';
    readonly type = 'llm' as const;

    private activeRequests = new Map<string, AbortController>();

    constructor(config: QuantlabCloudConfig);

    async sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse>;
    async *sendStreaming(request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk>;
    // ... remaining ProviderAdapter methods
}
```

### Request Flow

```
Extension                          Quantlab Server
   |                                     |
   |  POST /v1/qic/stream               |
   |  Authorization: Bearer <jwt>        |
   |  Content-Type: application/json     |
   |  X-QIC-Idempotency-Key: <uuid>     |
   |  Body: {                            |
   |    model: "quantlab-auto",          |
   |    messages: [...],                 |
   |    tools: [...],                    |
   |    lane: "chat-act",               |
   |    priority: "normal",             |
   |    sessionId: "...",               |
   |    maxTokens: 32768,               |
   |    temperature: 0.2                 |
   |  }                                  |
   | ----------------------------------> |
   |                                     |  Route to appropriate model
   |  SSE: data: {"type":"routing",      |  <-- First chunk: routing info
   |    "actualModel":"claude-sonnet-4-...", |
   |    "tier":"coding",                 |
   |    "estimatedTtft":1200}            |
   | <---------------------------------- |
   |  (adapter consumes routing chunk,   |
   |   emits quota-updated event)        |
   |                                     |
   |  SSE: data: {"type":"text",...}     |
   | <---------------------------------- |
   |  SSE: data: {"type":"tool_call_start",...}
   | <---------------------------------- |
   |  ...                                |
   |  SSE: data: {"type":"done",         |
   |    "usage":{...},                   |
   |    "meta": {                        |
   |      "actualModel":"...",           |
   |      "quotaRemaining": 45000,       |
   |      "routingDecision":"coding-tier"|
   |    }}                               |
   | <---------------------------------- |
   |  (adapter maps meta -> providerMeta)|
   |  (adapter emits quota-updated event)|
```

**Routing event handling (MEDIUM-14):** The server sends a `routing` event as the first SSE chunk before content streaming begins. The `routing` type is NOT a `StreamChunk` variant -- it is a server-specific control event. The adapter's SSE parser must pre-filter it:

```typescript
// Inside sendStreaming's SSE parsing loop:
for await (const line of sseLines) {
    const chunk = JSON.parse(line.slice('data: '.length));
    if (chunk.type === 'routing') {
        // Consume internally: store actualModel, tier, estimatedTtft
        this.lastRoutingInfo = chunk;
        this.emit('routing', chunk); // UI can show "Using Claude Sonnet 4..."
        continue; // Do NOT yield as StreamChunk
    }
    yield chunk as StreamChunk; // text, tool_call_*, done, error
}
```

The adapter emits a provider metadata event that the UI can use to show "Using Claude Sonnet 4 (coding tier)..." immediately.

**Quota synchronization (MEDIUM-18):** The `done` chunk's `meta.quotaRemaining` is the **authoritative** usage figure. The extension's token estimation is used only for pre-request cost prediction (advisory, not authoritative). The adapter emits a `quota-updated` event after each response using `meta.quotaRemaining`. The UI service consumes this event to update the status bar display and quota warnings.

**Meta field handling:** The adapter maps `meta` to `providerMeta` on the `done` chunk. No data is lost, and the field is ignored by all existing code paths.

### Request Cancellation (HIGH-6)

```typescript
cancelRequest(requestId: string): void {
    this.activeRequests.get(requestId)?.abort();
    this.activeRequests.delete(requestId);
}
```

Each `sendRequest`/`sendStreaming` call stores an `AbortController` keyed by request ID. `cancelRequest` calls `abort()` on it. This follows the same pattern as `AnthropicAdapter` and `OpenAIAdapter`.

### Token Refresh

The adapter must handle JWT expiry transparently:

```typescript
private async refreshAccessToken(): Promise<void> {
    const resp = await fetch(`${this.config.baseUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.config.refreshToken }),
    });
    const { access_token, refresh_token } = await resp.json();
    this.config.accessToken = access_token;
    this.config.refreshToken = refresh_token;
    // Persist via callback
    await this.config.onTokenRefresh?.(access_token, refresh_token);
}
```

On 401 from the server:
1. Attempt token refresh
2. If refresh succeeds, retry the original request (once)
3. If refresh fails, throw `QicError('QIC-P006', 'Quantlab Cloud session expired. Please sign in again.')`

**Server-initiated token refresh (HIGH-12):** On plan change, the server includes `X-QIC-Token-Refresh: required` in the response headers. The adapter checks for this header after each response and triggers an immediate token refresh, which returns a JWT with the updated plan tier. This prevents up to 15 minutes of stale plan data.

### URL Validation

Same HTTPS enforcement as the Anthropic/OpenAI adapters:
```typescript
private get baseUrl(): string {
    const parsed = new URL(this.config.baseUrl);
    if (parsed.protocol !== 'https:') {
        throw new QicError('QIC-N001', 'Quantlab Cloud URL must use HTTPS');
    }
    return this.config.baseUrl;
}
```

Exception: Allow `http://localhost` when `qic.cloud.devMode` is true (for local server development).

---

## 2. Authentication Flow

### OAuth2 with PKCE

Standard flow for desktop/extension apps:

```
User clicks "Sign in to Quantlab"
    |
    v
Extension generates code_verifier + code_challenge
    |
    v
Opens system browser: https://accounts.quantlab.dev/authorize?
    client_id=qic-vscode&
    redirect_uri=vscode://quantlab.qic/auth/callback&
    code_challenge=...&
    code_challenge_method=S256&
    response_type=code&
    scope=qic:inference qic:usage
    |
    v
User authenticates in browser (email/password, SSO, GitHub)
    |
    v
Browser redirects to vscode://quantlab.qic/auth/callback?code=...
    |
    v
Extension exchanges code for tokens:
    POST https://accounts.quantlab.dev/token
    { grant_type: authorization_code, code, code_verifier }
    |
    v
Receives: { access_token, refresh_token, expires_in }
    |
    v
Stores tokens in SecretStorage:
    QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN
    QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN
```

### URI Handler Registration

VS Code supports custom URI handlers for OAuth callbacks:

```typescript
// In qic.contribution.ts registration phase
vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri) {
        if (uri.path === '/auth/callback') {
            const code = uri.query.match(/code=([^&]+)/)?.[1];
            // Exchange code for tokens...
        }
    }
});
```

### Session Management

- Access tokens: short-lived (15 minutes)
- Refresh tokens: long-lived (30 days), stored in SecretStorage
- On extension activation: check for valid refresh token -> auto-refresh access token
- On token expiry during request: automatic refresh (transparent to user)
- On refresh failure: prompt user to sign in again

---

## 3. Configuration Changes

### New Settings

Add to `QIC_SETTINGS` in `constants.ts`:

```typescript
CONNECTION_MODE: 'qic.connectionMode',        // 'cloud' | 'byok' | 'local'
CLOUD_BASE_URL: 'qic.cloud.baseUrl',          // default: 'https://api.quantlab.dev'
CLOUD_DEV_MODE: 'qic.cloud.devMode',          // boolean, default: false
DATA_TIER: 'qic.dataTier',                    // 'private' | 'anonymous-metrics' | 'data-contributor'
```

Add to `QIC_SECRET_KEYS`:

```typescript
CLOUD_ACCESS_TOKEN: 'qic.cloudAccessToken',
CLOUD_REFRESH_TOKEN: 'qic.cloudRefreshToken',
```

### Settings Registration

```typescript
// Connection mode
'qic.connectionMode': {
    type: 'string',
    default: 'cloud',
    enum: ['cloud', 'byok', 'local'],
    enumDescriptions: [
        'Quantlab Cloud (default) -- zero-config, managed infrastructure',
        'Bring Your Own Key -- direct connections to Anthropic/OpenAI',
        'Local only -- Ollama for offline/air-gapped environments',
    ],
    description: 'How QIC connects to AI models.',
}

// Data tier (replaces boolean TELEMETRY_ENABLED)
'qic.dataTier': {
    type: 'string',
    default: 'private',
    enum: ['private', 'anonymous-metrics', 'data-contributor'],
    enumDescriptions: [
        'Private -- no telemetry data sent',
        'Anonymous Metrics -- latency, accept/reject rates, lane usage (no code content)',
        'Data Contributor -- full interaction data including code (for model improvement)',
    ],
    description: 'Controls what data QIC shares with Quantlab.',
}
```

### Settings Hierarchy (CONNECTION_MODE vs PROVIDER_DEFAULT)

The existing codebase has `PROVIDER_DEFAULT: 'qic.provider.default'` which overlaps in purpose with `CONNECTION_MODE`. Resolution:

`connectionMode` takes precedence over `provider.default`:
1. `connectionMode` determines which adapters are initialized (cloud, BYOK, local, or combinations)
2. `provider.default` is a hint within the BYOK path: if in BYOK mode, prefer this provider
3. In cloud mode, `provider.default` is ignored (the server handles model selection)
4. In local mode, `provider.default` is ignored (only Ollama is available)

Long-term: deprecate `PROVIDER_DEFAULT` in favor of the per-lane override mechanism (`qic.laneOverrides`).

### Per-Lane Provider Override

Advanced setting for power users who want to mix paths:

```typescript
'qic.laneOverrides': {
    type: 'object',
    default: {},
    description: 'Override the connection path for specific lanes.',
    // Example: { "completion": "byok-openai", "chat-act": "cloud" }
}
```

This maps lane names to provider IDs. The ModelRegistry checks overrides before its default resolution.

**Override resolution order:**
1. If `laneOverrides[lane]` is set, try that provider first
2. If override provider is unavailable (no key, circuit breaker open), log a warning and fall through to `LANE_MODEL_RECOMMENDATIONS[lane]` as if no override existed
3. Overrides are "prefer," not "require" -- this prevents user misconfiguration from breaking the system

---

## 4. Modified Activation Flow

### Changes to `qic.contribution.ts` Step 6 (Gateway)

The current Step 6 unconditionally creates BYOK adapters. The modified version branches on connection mode. **Uses `!== 'local'` guard** (not explicit mode enumeration) for future-proofing.

The canonical activation flow code is in `07-migration-from-current.md`, Step 6 Detail. Key design points described here; see Doc 07 for the complete code.

**Activation logic summary:**
1. Create providers Map based on `connectionMode` (cloud, BYOK, and/or local)
2. Create circuit breakers for all providers
3. Hook DegradationManager into cloud circuit breaker (see Section 10)
4. Show user guidance (sign-in prompt, warnings)
5. Register hot-swap listener for configuration changes
6. Build Gateway with providers, circuit breakers, model registry

### Key behavior: Cloud + BYOK coexistence

When `connectionMode !== 'local'`, BYOK adapters are also initialized (if keys exist). This enables:
1. **Fallback**: If the cloud server is down, the circuit breaker opens and ModelRegistry falls through to BYOK
2. **Per-lane override**: User can route `completion` to their own OpenAI key while keeping `chat-act` on cloud
3. **Migration path**: User can switch between modes without reconfiguring
4. **BYOK user with cloud token**: A BYOK user who later signs into cloud gets cloud as an additional option

### Hot-Swap on Configuration Change (HIGH-7)

```typescript
// In QicActivation, after Step 6:
this._register(this.configurationService.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('qic.connectionMode') ||
        e.affectsConfiguration('qic.cloud.baseUrl')) {
        this.reinitializeGateway();
    }
}));
```

`reinitializeGateway()` would:
1. Cancel any in-flight requests via each adapter's `cancelRequest()`
2. Rebuild the providers Map based on new settings
3. Reconstruct ModelRegistry, RateLimiter, CircuitBreakers
4. Update the Gateway instance on QicService
5. Update the status bar indicator

**In-flight request handling:** Mode switching takes effect only for NEW requests. In-flight requests complete on their current adapter. The Gateway maintains both old and new provider Maps during the transition. Old providers are dereferenced after all in-flight requests complete (or after a 30-second timeout). If an agent loop is in progress (multi-turn tool execution), the loop continues on the original provider until the current turn completes, then subsequent turns use the new provider.

---

## 5. ModelRegistry Changes

### CRITICAL-1: Structural Restructuring Required

**Current codebase** (`modelRegistry.ts` lines 30-39):
```typescript
// BEFORE -- single model per lane, no fallback chain:
const LANE_MODEL_RECOMMENDATIONS: Record<string, string> = {
    'completion': 'local-fast',
    'chat-ask': 'claude-latest',
    'chat-gather': 'claude-latest',
    'chat-plan': 'claude-latest',
    'chat-act': 'claude-latest',
    'repair': 'claude-latest',
    'fast-apply': 'local-fast',
    'summarize': 'gpt-latest',
};
```

Fallback logic currently lives separately in `getAvailableModelForLane()` (lines 103-136) with a hardcoded `fallbackOrder` array. This cannot express "try cloud-default first, then claude-latest, then gpt-latest" per lane.

**Required change:**
```typescript
// AFTER -- per-lane ordered preference arrays:
const LANE_MODEL_RECOMMENDATIONS: Record<LaneName, string[]> = {
    'completion':   ['cloud-fast', 'local-fast', 'gpt-latest'],
    'chat-ask':     ['cloud-default', 'claude-latest', 'gpt-latest'],
    'chat-gather':  ['cloud-default', 'claude-latest', 'gpt-latest'],
    'chat-plan':    ['cloud-default', 'claude-latest', 'gpt-latest'],
    'chat-act':     ['cloud-default', 'claude-latest', 'gpt-latest'],
    'repair':       ['cloud-default', 'claude-latest', 'gpt-latest'],
    'fast-apply':   ['cloud-fast', 'local-fast', 'claude-haiku'],
    'summarize':    ['cloud-fast', 'gpt-latest', 'claude-haiku'],
};
```

Rewrite `getAvailableModelForLane()` to iterate the per-lane array instead of the separate `fallbackOrder`:

```typescript
getAvailableModelForLane(lane: LaneName): ModelConfig | null {
    const preferences = LANE_MODEL_RECOMMENDATIONS[lane];
    for (const alias of preferences) {
        const config = this.getModelByAlias(alias);
        if (config && this.providers.has(config.providerId)) {
            return config;
        }
    }
    // Last resort: any available model from any provider
    return this.getAnyAvailableModel();
}
```

### Updated DEFAULT_MODELS

```typescript
const DEFAULT_MODELS: ModelConfig[] = [
    // Cloud models (server handles actual model selection)
    { alias: 'cloud-default',  modelId: 'quantlab-auto',    providerId: 'quantlab-cloud' },
    { alias: 'cloud-fast',     modelId: 'quantlab-fast',    providerId: 'quantlab-cloud' },
    { alias: 'cloud-reason',   modelId: 'quantlab-reason',  providerId: 'quantlab-cloud' },

    // Existing BYOK models (unchanged)
    { alias: 'claude-latest',  modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic' },
    { alias: 'gpt-latest',    modelId: 'gpt-4o',                   providerId: 'openai' },
    { alias: 'local-fast',    modelId: 'qwen2.5-coder:7b',         providerId: 'ollama' },
    { alias: 'claude-haiku',  modelId: 'claude-3-5-haiku-20241022', providerId: 'anthropic' },
];
```

This is a **Phase 1 deliverable** -- the restructure must happen before cloud adapter integration.

---

## 6. Egress Consent Integration

### New Egress Boundary (CRITICAL-3)

The `EgressBoundary` type needs a new value:

```typescript
export type EgressBoundary = 'llm' | 'embedding' | 'telemetry' | 'network' | 'web-fetch' | 'web-search' | 'quantlab-cloud';
```

### Provider-Aware Boundary Selection

The Gateway currently hardcodes the egress boundary to `'llm'` for all requests (`gateway.ts` line 44). This must become provider-aware:

**Phase 2 (MVP):** Treat cloud as `'llm'` boundary. All LLM requests use the same consent boundary regardless of provider. The consent dialog text explains that data may be sent through Quantlab's servers or directly to providers.

**Phase 4:** Full provider-aware egress:
```typescript
// In Gateway:
private getEgressBoundary(providerId: string): EgressBoundary {
    if (providerId === 'quantlab-cloud') return 'quantlab-cloud';
    return 'llm';  // anthropic, openai, ollama all use 'llm'
}

// In sendRequest():
const egressResult = await this.egressEnforcer.checkAndSanitize(
    this.getEgressBoundary(providerId), messageContent, { ... }
);
```

This allows separate consent tracking -- a user can consent to sending data to Quantlab's servers but not directly to Anthropic (or vice versa). This is important for enterprise/compliance users who need fine-grained data flow control.

### First-Run Consent Dialog Update

For cloud mode:
```
"QIC connects to Quantlab's servers to process your coding requests.
Your code is sent to Quantlab's infrastructure, which forwards it to
AI providers (Anthropic, OpenAI) for inference.

Quantlab does not store your code beyond the duration of each request
unless you explicitly opt in to data contribution."
```

For BYOK mode, the existing dialog is unchanged.

---

## 7. Consent Model Bridge (HIGH-11)

### The Problem

The existing `consentStore.ts` has a three-tier system of consent *scopes* (Session, Workspace, Global) -- how long consent lasts. The plan needs consent *levels* (Private, Anonymous Metrics, Data Contributor) -- what data is shared. These are orthogonal concepts.

### Design

**Step 1: Extend the consent store for data tiers (Phase 1).**

```typescript
export type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';
```

This is stored as a separate setting (`qic.dataTier`) and controls what telemetry events are allowed:

| DataTier | Egress boundaries allowed |
|----------|--------------------------|
| `private` | `llm` only (no telemetry) |
| `anonymous-metrics` | `llm` + `telemetry` (metadata only) |
| `data-contributor` | `llm` + `telemetry` (full interaction data) |

**Auto-grant telemetry consent:** When `DataTier` changes from `private` to `anonymous-metrics` or `data-contributor`, the extension must automatically grant `'telemetry'` egress consent in the `consentStore` (Global scope). Otherwise the `EgressBoundaryEnforcer` blocks telemetry sends even though the user has opted in via `DataTier`. Conversely, downgrading to `private` revokes `'telemetry'` consent. This ensures `DataTier` and egress consent stay in sync without requiring the user to manage both settings manually.

**Step 2: Wire DataTier into the telemetry service.**

```typescript
// Current: simple boolean
const enabled = configurationService.getValue(QIC_SETTINGS.TELEMETRY_ENABLED);

// New: tier-based
const dataTier = configurationService.getValue<DataTier>(QIC_SETTINGS.DATA_TIER);
if (dataTier === 'private') return; // no telemetry
if (dataTier === 'anonymous-metrics' && event.containsCodeContent) return; // metadata only
// 'data-contributor': send everything
```

**Step 3: Deprecate `TELEMETRY_ENABLED` boolean.**

The existing `qic.telemetry.enabled` setting (boolean, default false) is deprecated in favor of `qic.dataTier` (enum, default 'private'). For backwards compatibility: if `telemetry.enabled` is true and `dataTier` is not set, treat as `anonymous-metrics`.

---

## 8. Completion Lane Routing Strategy (HIGH-1)

### The Problem

The `completion` lane requires sub-200ms TTFT. Cloud path adds two extra hops (extension -> server -> provider -> server -> extension), adding 20-100ms. This may push TTFT past acceptable threshold.

### Phased Approach

**Phase 2: Completions always bypass the server (Option A).**

For the `completion` lane only, the ModelRegistry resolves to a BYOK or local adapter regardless of connection mode. Chat/act/plan lanes go through the server. The server never sees completion requests.

- Pro: Lowest latency, simplest
- Con: No server-side analytics for completions, no fine-tuned completion models via server

**Phase 3+: Persistent WebSocket for completions (Option B).**

Instead of SSE (new HTTP connection per request), maintain a persistent WebSocket between extension and server. Completions are sent as WebSocket messages, eliminating connection setup overhead (~50ms saved).

- Pro: Near-zero connection overhead, enables server-side completion analytics
- Con: More complex protocol, WebSocket state management

**Implementation:** In the `LANE_MODEL_RECOMMENDATIONS` for `completion`, the first entry is `'cloud-fast'` but with a Phase 2 config flag `qic.cloud.completionsBypassServer` (default: true) that forces completion lane to skip cloud models and use BYOK/local directly.

---

## 9. Offline & Degraded Connectivity (HIGH-2)

### Behavior Matrix

| Scenario | Cloud Available | BYOK Keys Present | Ollama Running | Behavior |
|----------|----------------|-------------------|----------------|----------|
| Normal | Yes | Yes | Yes | Cloud handles requests, BYOK+Ollama as fallback |
| Normal | Yes | No | No | Cloud handles requests |
| Server down | No | Yes | Yes | Circuit breaker opens on cloud, auto-falls to BYOK |
| Server down | No | No | Yes | Falls to Ollama (limited capability) |
| Server down | No | No | No | Clear error: "No AI providers available" |
| Mid-stream disconnect | Drops | Yes | - | Current request fails, next request auto-routes to BYOK |
| Airplane mode | No | No | Yes | Ollama only; show "Offline mode" in status bar |
| Airplane mode | No | No | No | All lanes disabled; show "No AI available" |

### Key Design Decisions

- The circuit breaker on `quantlab-cloud` must open fast (2-3 failures, not 5) to minimize user-facing latency during outages
- When cloud circuit opens, show a subtle notification: "Quantlab Cloud unavailable, using direct connection"
- When cloud circuit recovers (half-open probe succeeds), silently switch back
- The status bar indicator reflects the actual active provider, not just the configured mode

---

## 10. DegradationManager Integration (HIGH-13)

The `DegradationManager` at `common/resilience/degradationManager.ts` has 5 levels: Normal (0), ReducedQuality (1), NoCompletions (2), LocalOnly (3), Emergency (4). Cloud adapter state maps to:

| Scenario | BYOK Available | Ollama Available | Degradation Level |
|----------|---------------|-----------------|-------------------|
| Cloud down | Yes | Yes | 1 (ReducedQuality) -- disable speculative completions |
| Cloud down | Yes | No | 1 (ReducedQuality) -- BYOK handles all lanes |
| Cloud down | No | Yes | 3 (LocalOnly) -- only local completion and file ops |
| Cloud down | No | No | 4 (Emergency) -- only session recovery and checkpoint |

**Logic:** `hasByok` takes priority. If any BYOK provider is available, level 1 regardless of Ollama. If only Ollama, level 3. If nothing, level 4.

When the circuit breaker recovers (half-open probe succeeds), the DegradationManager returns to level 0 (Normal). The status bar indicator (`[Cloud*] QIC Degraded`) reflects the degradation level, not just circuit breaker state.

---

## 11. Quality Signal Hooks (HIGH-10)

### The Problem

The data flywheel depends on quality signals (accept/reject, edit distance, re-request, follow-up patterns) that do not exist in the codebase. No collection mechanism exists.

### Phase 1 Prerequisite: Quality Signal Instrumentation

Build local-only quality signal collection in Phase 1:

1. **Completion acceptance tracking:** Hook into VS Code's `InlineCompletionItemProvider.handleDidPartiallyAcceptCompletionItem()` and `handleDidShowCompletionItem()`. Record: completion shown timestamp, accepted/rejected/partial, time-to-decision. Store locally in SQLite (never sent without consent).

2. **Edit distance tracking:** On completion accept: snapshot the accepted text. After 10 seconds (debounced): compare accepted text with current buffer content. Compute Levenshtein distance ratio. Store locally.

3. **Re-request detection:** Track when the same lane receives a request within 30 seconds of a previous error or rejection. Flag as "retry" in the interaction log.

4. **Follow-up pattern tracking:** In the orchestrator, when a tool result is followed by another LLM call vs. user taking over (no new message for 60s), record the pattern.

### Server-Path Correlation

Each quality signal must include a `requestId` (the `X-QIC-Request-ID` from the original inference request) to link extension-side quality observations to server-side request logs:

```typescript
interface QualitySignal {
    requestId: string;        // Links to server request log
    type: 'accept' | 'reject' | 'edit' | 'retry' | 'test-result';
    lane: LaneName;
    editDistance?: number;     // 0.0-1.0, only for 'edit' type
    testPassed?: boolean;      // Only for 'test-result' type
    timeToDecisionMs?: number;
}
```

Data is collected locally regardless of consent tier. It is only *transmitted* based on the user's `DataTier`:
- `private`: never sent
- `anonymous-metrics`: sent via telemetry endpoint in Phase 2 (metadata, not code content)
- `data-contributor`: sent with full context

---

## 12. ReproducibilityLogger & SessionCache (INCONSISTENCY-12)

These components exist at `common/telemetry/reproducibilityLogger.ts` and `common/telemetry/sessionCache.ts`. Both are late-stage (Phase 9 in the extension implementation plan), but the server plan must not create obstacles.

**ReproducibilityLogger:** Cloud requests use `model: "quantlab-auto"` (a virtual alias). On replay, this alias would hit the server again and might resolve to a different model. Fix: log the outgoing request (with `model: "quantlab-auto"`) and on stream completion, append `actualModel` from `meta`. Replay mode should allow replaying against either the cloud (re-routes) or the actual model via BYOK (deterministic).

**SessionCache:** The cache key includes provider + model + message hash. For cloud path, the model is `quantlab-auto`. Two identical requests might be routed to different models server-side, but the cache key would be identical. Fix: Cloud requests are cache-eligible with a short TTL (60s vs 300s for BYOK), keyed on message hash only (model alias is ignored since the server controls routing). Alternatively, invalidate cloud cache entries when `actualModel` differs between identical requests.

---

## 13. New Commands

### Sign In / Sign Out

```typescript
QIC_SIGN_IN_COMMAND_ID = 'qic.signIn';
QIC_SIGN_OUT_COMMAND_ID = 'qic.signOut';
QIC_ACCOUNT_INFO_COMMAND_ID = 'qic.accountInfo';  // Shows plan, usage, quota
```

### Switch Connection Mode

```typescript
QIC_SWITCH_MODE_COMMAND_ID = 'qic.switchConnectionMode';
// QuickPick: Cloud | BYOK | Local
// Changing mode triggers gateway re-initialization (Section 4)
```

---

## 14. Status Bar Integration

Show the active connection mode in the status bar:

```
[Cloud] QIC Ready          -- connected to Quantlab Cloud
[BYOK] QIC Ready           -- using own API keys
[Local] QIC Ready          -- Ollama only
[Cloud*] QIC Degraded      -- cloud unavailable, using BYOK fallback (DegradationManager level 1+)
```

This uses VS Code's `StatusBarItem` API and updates based on:
- Which adapter(s) are available
- Which adapter actually served the last request
- Circuit breaker states
- DegradationManager level
