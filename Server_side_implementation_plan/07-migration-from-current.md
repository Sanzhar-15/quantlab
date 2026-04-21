# Migration From Current System

## What Stays Exactly the Same

The beauty of QIC's adapter-based architecture is that most of the system is untouched by the hybrid migration.

**Zero changes required:**

| Component | File(s) | Why unchanged |
|-----------|---------|---------------|
| Agent Orchestrator | `agentOrchestrator.ts` | Operates on canonical types via Gateway. Doesn't know or care which adapter serves requests. |
| Lane Router | `laneRouter.ts`, `lanes.ts` | Lane classification is independent of provider. |
| Tool Router + all 22 tools | `toolRouter.ts`, tool implementations | Tools execute locally, results flow back through conversation state. |
| Context Assembler | `contextAssembler.ts` | Builds context independently of provider. |
| Conversation State | `conversationState.ts` | Stores messages in canonical format. |
| Agent State Machine | `agentStateMachine.ts` | State transitions are provider-agnostic. |
| Mutation Engine | `mutationEngine.ts`, `atomicWriter.ts` | File operations are local. |
| Security layer | `secretScanner.ts`, `auditLogger.ts` | Secret scanning happens at Gateway level, before adapter. |
| Completion Engine | `completionEngine.ts` | Uses Gateway, not adapters directly. |
| Database | `database.ts` | Local SQLite, unrelated to provider. |
| UI Service | `uiService.ts` | Webview communication, unrelated to provider. |

**Files that change:**

| File | Change | Phase |
|------|--------|-------|
| `constants.ts` | New settings (`connectionMode`, `dataTier`, `cloud.baseUrl`), secret keys | 1 |
| `qic.contribution.ts` | Connection mode branching, cloud adapter init, hot-swap listener, DegradationManager hookup | 1 |
| `modelRegistry.ts` | Restructure `LANE_MODEL_RECOMMENDATIONS` from `Record<string, string>` to `Record<LaneName, string[]>`, rewrite `getAvailableModelForLane()`, add cloud model aliases (CRITICAL-1) | 1 |
| `egressEnforcer.ts` | Add `'quantlab-cloud'` to `EgressBoundary` type | 1 |
| `consentStore.ts` | Handle cloud consent boundary + `DataTier` concept | 1 |
| `gateway.ts` | Provider-aware egress boundary selection via `getEgressBoundary()` (CRITICAL-3) | 4 (MVP: unchanged, Phase 4: modified) |
| `interfaces.ts` | Add `GatewayMetadata` interface, widen `ProviderAdapter` with `Partial<GatewayMetadata>`, extend `StreamChunk` `done` variant with `providerMeta` (CRITICAL-2, MEDIUM-1) | 1 |
| `telemetryService.ts` | Wire `DataTier` check (replaces boolean `TELEMETRY_ENABLED`) | 1 |

**New files:**

| File | Purpose |
|------|---------|
| `common/gateway/providers/quantlabCloudAdapter.ts` | Cloud adapter |
| `common/gateway/providers/errorRedaction.ts` | Shared error body redaction utility (**already exists** from production hardening; no new file needed) |
| `browser/auth/quantlabAuth.ts` | OAuth2 PKCE flow |
| `browser/auth/uriHandler.ts` | VS Code URI handler |

---

## Backwards Compatibility

### Existing BYOK Users

Users who have configured API keys and are using QIC today experience zero disruption:

1. Default `connectionMode` is `'cloud'` for new installs
2. **Existing installs** that already have API keys: the setting defaults to `'cloud'`, but the activation flow detects no cloud token and falls through to BYOK mode automatically
3. To make this explicit: on update, if user has API keys but no cloud token, show a one-time notification:
   ```
   "QIC now supports Quantlab Cloud for zero-config AI access.
   You're currently using your own API keys (BYOK mode).
   [Try Cloud] [Keep BYOK] [Learn More]"
   ```
4. Choosing "Keep BYOK" sets `connectionMode: 'byok'` explicitly
5. Choosing "Try Cloud" starts the sign-up/sign-in flow
6. No keys are deleted, no settings are changed without user action

### Settings Migration

No settings are renamed or removed. All new settings have sensible defaults:

| Setting | Default | Behavior for existing users |
|---------|---------|---------------------------|
| `qic.connectionMode` | `'cloud'` | Falls through to BYOK if no cloud token |
| `qic.cloud.baseUrl` | `'https://api.quantlab.dev'` | Only used in cloud mode |
| `qic.cloud.devMode` | `false` | Off by default |
| `qic.dataTier` | `'private'` | No telemetry (same as current default) |

**`TELEMETRY_ENABLED` deprecation:** The existing `qic.telemetry.enabled` setting (boolean, default false) is deprecated in favor of `qic.dataTier` (enum, default 'private'). For backwards compatibility: if `telemetry.enabled` is true and `dataTier` is not set, treat as `anonymous-metrics`.

### API Key Storage

Existing API keys in SecretStorage are untouched:
- `qic.anthropicApiKey` -- preserved, used when `connectionMode !== 'local'` or as fallback
- `qic.openaiApiKey` -- preserved, same

New keys added alongside:
- `qic.cloudAccessToken` -- JWT for cloud API
- `qic.cloudRefreshToken` -- OAuth2 refresh token

---

## Extension Activation Flow (Updated)

Here is the complete updated activation flow, showing how cloud integrates with the existing step sequence:

```
Step 0: Directories (unchanged)
Step 1: Crash Recovery (unchanged)
Step 2: Database (unchanged)
Step 3: State Recovery (unchanged)
Step 4: Security (MODIFIED -- add 'quantlab-cloud' egress boundary)
Step 5: First-Run Consent (MODIFIED -- different dialog text for cloud vs BYOK, DataTier selection)
Step 6: Gateway (MODIFIED -- see below)
Step 7: Context Engine (unchanged)
Step 8: Agent Runtime (unchanged)
Step 9: Completion Engine (unchanged)
Step 10: Background Indexing (unchanged)
```

### Step 6 Detail (Gateway Initialization)

```typescript
await this.step('gateway', async () => {
    const connectionMode = this.configurationService.getValue<string>(QIC_SETTINGS.CONNECTION_MODE);
    const providers = new Map<string, ProviderAdapter>();

    // --- Cloud adapter (initialized for all modes except local) ---
    if (connectionMode !== 'local') {
        const accessToken = await this.secretStorageService.get(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN);
        if (accessToken) {
            const cloudUrl = this.configurationService.getValue<string>(QIC_SETTINGS.CLOUD_BASE_URL);
            try {
                const cloudAdapter = new QuantlabCloudAdapter({
                    baseUrl: cloudUrl,
                    accessToken,
                    refreshToken: await this.secretStorageService.get(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN),
                    onTokenRefresh: async (newAccess, newRefresh) => {
                        await this.secretStorageService.store(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN, newAccess);
                        if (newRefresh) {
                            await this.secretStorageService.store(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN, newRefresh);
                        }
                    },
                });
                providers.set('quantlab-cloud', cloudAdapter);
            } catch (err) {
                this.logService.warn('[QIC] Failed to initialize Quantlab Cloud:', err);
            }
        }
    }

    // --- BYOK adapters (always initialized if keys exist, for fallback) ---
    if (connectionMode !== 'local') {
        const anthropicKey = await this.secretStorageService.get(QIC_SECRET_KEYS.ANTHROPIC_API_KEY);
        const openaiKey = await this.secretStorageService.get(QIC_SECRET_KEYS.OPENAI_API_KEY);
        if (anthropicKey) {
            try {
                providers.set('anthropic', new AnthropicAdapter({ apiKey: anthropicKey }));
            } catch (err) {
                this.logService.warn('[QIC] Failed to initialize Anthropic:', err);
            }
        }
        if (openaiKey) {
            try {
                providers.set('openai', new OpenAIAdapter({ apiKey: openaiKey }));
            } catch (err) {
                this.logService.warn('[QIC] Failed to initialize OpenAI:', err);
            }
        }
    }

    // --- Local adapter (always available) ---
    const ollamaUrl = this.configurationService.getValue<string>(QIC_SETTINGS.PROVIDER_OLLAMA_URL);
    try {
        providers.set('ollama', new OllamaAdapter({ baseUrl: ollamaUrl }));
    } catch (err) {
        this.logService.warn('[QIC] Failed to initialize Ollama:', err);
    }

    // --- Build infrastructure (must precede DegradationManager hookup) ---
    const rateLimiter = new RateLimiter();
    const circuitBreakers = new Map([...providers.keys()].map(id => [id, new CircuitBreaker()]));
    const modelRegistry = new ModelRegistry(providers);

    // --- DegradationManager hookup ---
    if (providers.has('quantlab-cloud')) {
        const hasByok = providers.has('anthropic') || providers.has('openai');
        const hasLocal = providers.has('ollama');
        // Register circuit breaker callbacks
        circuitBreakers.get('quantlab-cloud')?.onStateChange((state) => {
            if (state === 'open') {
                if (hasByok) this.degradationManager.setLevel(1);       // ReducedQuality
                else if (hasLocal) this.degradationManager.setLevel(3); // LocalOnly
                else this.degradationManager.setLevel(4);               // Emergency
            } else if (state === 'closed') {
                this.degradationManager.setLevel(0); // Normal
            }
        });
    }

    // --- User guidance ---
    if (providers.size === 0) {
        this.notificationService.warn(localize('qic.noProviders',
            'QIC: No AI providers configured. Sign in to Quantlab Cloud or configure API keys.'));
    } else if (!providers.has('quantlab-cloud') && connectionMode === 'cloud') {
        this.promptCloudSignIn();
    } else if (providers.size === 1 && providers.has('ollama')) {
        this.notificationService.info(localize('qic.ollamaOnly', ...));
    }

    // --- Hot-swap listener ---
    this._register(this.configurationService.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('qic.connectionMode') ||
            e.affectsConfiguration('qic.cloud.baseUrl')) {
            this.reinitializeGateway();
        }
    }));

    // --- Build gateway ---
    gateway = new Gateway(providers, rateLimiter, circuitBreakers, egressEnforcer, secretScanner, modelRegistry);
});
```

---

## ModelRegistry Fallback Chain

The restructured resolution uses per-lane ordered preference arrays:

```
For lane 'chat-act':
  1. Try 'cloud-default' -> requires 'quantlab-cloud' provider -> if unavailable, skip
  2. Try 'claude-latest' -> requires 'anthropic' provider -> if unavailable, skip
  3. Try 'gpt-latest' -> requires 'openai' provider -> if unavailable, skip
  4. Last resort: any available model from any provider

For lane 'completion':
  1. Try 'cloud-fast' -> requires 'quantlab-cloud' provider
  2. Try 'local-fast' -> requires 'ollama' provider
  3. Try 'gpt-latest' -> requires 'openai' provider (FIM capable)
  4. Last resort: any
```

The circuit breaker per provider means that if the cloud server goes down, subsequent requests immediately skip to BYOK without waiting for timeout. Recovery is automatic when the circuit breaker's reset timeout elapses and a probe request succeeds.

**laneOverrides fallback:** If `laneOverrides[lane]` specifies a provider that is unavailable (no key, circuit breaker open), the system logs a warning and falls through to `LANE_MODEL_RECOMMENDATIONS[lane]`. Overrides are "prefer," not "require."

---

## Invariant Compliance (HIGH-14)

The QIC codebase defines 11 system invariants (INV-T1 through INV-A4). The cloud path affects several:

| Invariant | Affected? | Compliance Strategy |
|-----------|----------|-------------------|
| INV-T1 (MutationEngine requires ApprovalToken) | No | Mutations are local, unaffected by cloud path |
| INV-T2 (ToolRouter logs all tool calls) | No | Tool execution is local, unaffected |
| INV-T3 (Secret protection via EgressBoundaryEnforcer) | **Yes** | Gateway's egress enforcement applies to QuantlabCloudAdapter. The new `'quantlab-cloud'` boundary goes through the same `checkAndSanitize()` path. **Test:** send a request containing a known secret pattern, verify redaction before it reaches the server. |
| INV-T4 (Tool execution approval) | No | Local-only concern |
| INV-T6b (Reproducible requests via ReproducibilityLogger) | **Yes** | Cloud requests use `model: "quantlab-auto"` (virtual). The logger must record both the outgoing request (with virtual model) and the actual model from `providerMeta.actualModel` on stream completion. Otherwise replay targets a different model. |
| INV-A1 (canonical/index.ts is sole type authority) | **Yes** | `StreamChunk` extension (`providerMeta`), `GatewayMetadata` interface, and `EgressBoundary` addition must all be defined in `canonical/interfaces.ts`, not ad-hoc in the adapter. |
| INV-A2 (Database schema versioning) | No | Unaffected |
| INV-A3 (Test coverage requirements) | No | New code follows existing patterns |
| INV-A4 (TimeoutManager USER_INTERACTION has no timeout) | No | Unaffected by cloud path |

---

## Testing Strategy

### Unit Tests

- `QuantlabCloudAdapter`: Mock `fetch`, verify request serialization, response deserialization (including `routing` event consumption and `meta` -> `providerMeta` mapping), token refresh, `X-QIC-Token-Refresh` header handling, error handling, cancellation
- Auth module: Mock browser open, URI handler callback, token exchange
- ModelRegistry: Verify restructured per-lane arrays work correctly, cloud models preferred when cloud provider available, fallback when not, laneOverrides fallback behavior

### Integration Tests

- Mock cloud server (local Express app speaking QIC protocol including `routing` events)
- Full activation flow with mock server
- Connection mode switching (hot-swap)
- Token expiry and refresh during streaming
- Cloud-down fallback to BYOK
- Circuit breaker behavior + DegradationManager level changes
- Idempotency key deduplication
- Quality signal collection and batching

### E2E Tests

- Real cloud server (staging environment)
- Sign-up, sign-in, send message, receive response
- Mode switching
- Sign-out

---

## Rollout Strategy

### Phase 1 Launch (Extension Only)

1. Ship extension update with cloud adapter behind `qic.cloud.enabled` feature flag (default: false)
2. Internal testing with staging server
3. Enable for opt-in beta users
4. Monitor: latency, error rates, fallback frequency
5. General availability (flip flag to true)

### Phase 2 Launch (Server MVP)

1. Deploy to single region (us-east-1)
2. Invite-only access (100 users)
3. Monitor: TTFT overhead, server error rates, concurrent connections, graceful shutdown behavior
4. Scale test: 500 concurrent users
5. Open registration

### Communication

**For existing BYOK users:**
- Blog post: "QIC now offers zero-config mode via Quantlab Cloud"
- In-extension notification (one-time, dismissable)
- Documentation: how cloud and BYOK compare, how to switch

**For new users:**
- Default experience is cloud (sign up, start coding)
- Onboarding flow guides through account creation
- BYOK documentation available for those who want it
