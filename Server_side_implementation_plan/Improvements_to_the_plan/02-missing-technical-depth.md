# Missing Technical Depth

These are production-critical concerns that the plan either ignores or glosses over.

---

## HIGH-1: Completion Lane Latency Problem

### The Gap

The `completion` lane powers inline code suggestions -- the user types, and QIC autocompletes. This requires sub-200ms time-to-first-token (TTFT) to feel responsive. At 200ms+ users perceive a lag; at 500ms+ they find it annoying.

The plan targets <10ms server overhead, but the real cost is the extra network round trip. Current BYOK path:

```
Extension -> Anthropic/OpenAI  (~50-80ms round trip to provider)
```

Cloud path:

```
Extension -> Quantlab Server -> Anthropic/OpenAI -> Quantlab Server -> Extension
```

That's two additional hops. Even with the server in the same AWS region as the provider (eliminating the server-to-provider hop), the extension-to-server hop adds 20-100ms depending on user geography. For completions, this may push TTFT past the acceptable threshold.

### Fix Required in Plan

Add a dedicated section on **completion lane routing strategy** with three options:

**Option A: Completions always bypass the server.**

For the `completion` lane only, the ModelRegistry resolves to a BYOK or local adapter regardless of connection mode. Chat/act/plan lanes go through the server. The server never sees completion requests.

- Pro: Lowest latency, simplest
- Con: No server-side analytics for completions, no fine-tuned completion models via server

**Option B: Persistent WebSocket for completions.**

Instead of SSE (new HTTP connection per request), maintain a persistent WebSocket between extension and server. Completions are sent as WebSocket messages, eliminating connection setup overhead (~50ms saved).

- Pro: Near-zero connection overhead, enables server-side completion analytics
- Con: More complex protocol, WebSocket state management, harder to load-balance

**Option C: Speculative local + server race.**

Send the completion request to both local (Ollama) and server simultaneously. Show whichever responds first. If the server response is better, swap it in.

- Pro: Always fast (local responds quickly), better quality when server wins
- Con: Double resource usage, complex UX for response swapping

**Recommendation for plan:** Option A for Phase 2 (completions bypass server). Option B for Phase 3+ (WebSocket upgrade for latency-sensitive lanes). Add this as a new subsection in `01-extension-integration.md` under "Lane-Specific Routing."

---

## HIGH-2: Offline and Disconnected Mode

### The Gap

The plan has no design for what happens when:
- The user loses internet mid-session (WiFi drops, VPN reconnect)
- The Quantlab server is down (outage, maintenance)
- The user is on an airplane (no connectivity at all)

Currently in BYOK mode, network failure produces a clear error. In cloud-default mode, the behavior needs to be designed.

### Fix Required in Plan

Add an **"Offline & Degraded Connectivity"** section to `01-extension-integration.md`:

**Behavior matrix:**

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

**Key design decisions:**
- The circuit breaker on `quantlab-cloud` must open fast (2-3 failures, not 5) to minimize user-facing latency during outages
- When cloud circuit opens, show a subtle notification: "Quantlab Cloud unavailable, using direct connection"
- When cloud circuit recovers (half-open probe succeeds), silently switch back
- The status bar indicator should reflect the actual active provider, not just the configured mode

---

## HIGH-3: Streaming Error Recovery

### The Gap

The plan describes SSE streaming but doesn't address what happens when:
- The SSE stream drops mid-response (network hiccup)
- The upstream provider returns an error mid-stream (e.g., context length exceeded at token 5000)
- The server restarts while a stream is in-flight

### Fix Required in Plan

Add a **"Streaming Fault Tolerance"** section to `02-api-contract.md`:

**Server-side:**
- If the upstream provider stream drops, the server sends an `{"type":"error","error":{"code":"QIC-P004","message":"Upstream provider stream interrupted"}}` chunk followed by stream close.
- The server does NOT retry mid-stream (partial responses cannot be replayed). The client must decide whether to retry from scratch.

**Client-side (QuantlabCloudAdapter):**
- On stream error: yield the error chunk to the orchestrator (existing `case 'error': throw chunk.error` in `processStreamChunk()` handles this).
- On network disconnect mid-stream: the `fetch` rejects, which propagates as an error to the `for await` loop.
- The orchestrator's existing error handling (transition to idle, show error) applies.

**What about partial responses?**
If the model streamed 500 tokens of text before the error, those tokens were already displayed to the user via `streamChatToken()`. On retry, the user sees the response start over from scratch. This is the same behavior as Cursor and GitHub Copilot -- no one does mid-stream resume for LLM inference.

---

## HIGH-4: Abuse Prevention for Free Tier

### The Gap

The plan offers a free tier with 500K tokens/month but has no abuse mitigation. A single bad actor with automated scripts could create hundreds of free accounts and drain significant provider budget.

### Fix Required in Plan

Add an **"Abuse Prevention"** section to `03-server-architecture.md`:

**Pre-authentication:**
- Rate limit the sign-up endpoint: 5 accounts per IP per hour
- Email verification required before first inference request
- Block disposable email domains (mailinator, guerrillamail, etc.)
- CAPTCHA on sign-up (hCaptcha or Turnstile, not reCAPTCHA -- quant users value privacy)

**Post-authentication:**
- Hard rate limit on free tier: 30 requests/minute (already in plan, but enforce strictly)
- Anomaly detection: flag accounts that hit rate limits consistently
- Automated suspension for accounts exceeding 3x their token budget (accounting for estimation errors)
- Device fingerprinting: limit free accounts to N per device (via extension telemetry)

**Progressive trust (phased):**
New free accounts start with 100K tokens/month, graduating to 500K after 30 days of legitimate usage patterns (diverse lane usage, reasonable request frequency, non-trivial prompts). Accounts flagged for anomalous behavior (identical prompts across accounts, API-like request patterns) are throttled to 50K/month pending review. Consider requiring a GitHub or LinkedIn account with >1 year of age as a low-friction verification step -- high friction for bot accounts, low friction for real developers.

**Cost protection:**
- Global spending alert: if total provider costs exceed 2x projected for the day, throttle free tier
- Provider-specific circuit breakers: if a single provider's costs spike, route free-tier traffic to cheaper alternatives

---

## HIGH-5: Observability and Monitoring

### The Gap

The plan mentions "request logging" once in the API Gateway description but has no observability design. Operating a multi-service, multi-region system without proper observability is dangerous.

### Fix Required in Plan

Add an **"Observability"** section to `03-server-architecture.md`:

**Distributed tracing:**
- Every request gets a trace ID (`X-QIC-Request-ID`) generated at the API gateway
- Trace ID propagated through all internal services and to upstream providers
- Trace storage: Jaeger or Grafana Tempo
- The extension sends the trace ID so server logs can be correlated with client-side events

**Metrics (Prometheus/Grafana):**

| Metric | Labels | Alert Threshold |
|--------|--------|----------------|
| `qic_request_duration_seconds` | lane, tier, provider, status | p99 > 5s |
| `qic_ttft_seconds` | lane, tier, provider | p50 > 1s (chat), p50 > 300ms (completion) |
| `qic_request_total` | lane, tier, status | error rate > 5% |
| `qic_active_streams` | region | > 80% capacity |
| `qic_provider_error_rate` | provider | > 10% |
| `qic_token_usage_total` | tier, provider | cost projection > 2x budget |
| `qic_auth_failure_total` | reason | spike > 100/min |
| `qic_circuit_breaker_state` | provider | open for > 5min |

**Logging:**
- Structured JSON logs (not free-text)
- Log levels: ERROR (failures), WARN (degradation), INFO (request metadata), DEBUG (development only)
- No code content in logs (privacy) -- only metadata, timing, token counts
- Log aggregation: Loki or CloudWatch Logs
- Retention: 30 days for INFO, 90 days for ERROR/WARN

**Alerting:**
- PagerDuty/OpsGenie integration
- Tiered alerts: WARNING (Slack notification), CRITICAL (page on-call)
- Runbook links in every alert

---

## HIGH-6: Request Cancellation for Cloud Adapter

### The Gap

The `ProviderAdapter` interface requires `cancelRequest(requestId: string): void`. The plan describes the cloud adapter but never mentions implementing this method. For cloud streaming requests that can run for 30+ seconds, cancellation is essential.

### Fix Required in Plan

Add to `01-extension-integration.md`, Section 1 (QuantlabCloudAdapter):

```typescript
cancelRequest(requestId: string): void {
    // Abort the in-flight fetch for this request
    this.activeRequests.get(requestId)?.abort();
    this.activeRequests.delete(requestId);
}
```

This follows the same pattern as `AnthropicAdapter` and `OpenAIAdapter`. Each `sendRequest`/`sendStreaming` call stores an `AbortController` keyed by request ID. `cancelRequest` calls `abort()` on it.

**Server-side cancellation (add to `03-server-architecture.md`):**

The server MUST detect client disconnect within 500ms and abort the upstream provider request. In Go, this means propagating `context.Context` cancellation from the client HTTP connection through to the upstream `http.NewRequestWithContext()`, and selecting on both the upstream response stream and the client context's `Done()` channel. Tokens already generated by the provider before cancellation are billed to the user's quota -- the provider charges for them regardless.

---

## HIGH-7: Hot-Swap When Connection Mode Changes

### The Gap

When a user changes `qic.connectionMode` in settings, the plan doesn't specify what happens. Does the extension need a restart? Can providers be added/removed live?

### Fix Required in Plan

Add to `01-extension-integration.md`:

**Approach: Listen for configuration changes, re-initialize gateway.**

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
1. Cancel any in-flight requests
2. Rebuild the providers Map based on new settings
3. Reconstruct ModelRegistry, RateLimiter, CircuitBreakers
4. Update the Gateway instance on QicService
5. Update the status bar indicator

This avoids requiring a full extension restart. Existing adapters (`AnthropicAdapter`, `OpenAIAdapter`) don't need to change -- they're just re-instantiated.

**In-flight request handling:** Mode switching takes effect only for NEW requests. In-flight requests complete on their current adapter. The Gateway maintains both old and new provider Maps during the transition. Old providers are dereferenced after all in-flight requests complete (or after a 30-second timeout). If an agent loop is in progress (multi-turn tool execution), the loop continues on the original provider until the current turn completes, then subsequent turns use the new provider.

---

## HIGH-8: Prompt Caching Strategy

### The Gap

Anthropic's prompt caching can reduce costs by 90% for repeated system prompts. OpenAI has a similar feature. The plan mentions caching briefly in Phase 3 but doesn't design how the server manages it.

### Fix Required in Plan

Add to `03-server-architecture.md`, under "Provider Multiplexer":

**How prompt caching works (Anthropic):**
- Mark the system prompt with `cache_control: { type: "ephemeral" }`
- On subsequent requests with the same prefix, Anthropic serves from cache (~$0.30/MTok instead of $3/MTok for Sonnet)
- Cache TTL: 5 minutes (refreshed on each use)

**Server-side cache management:**
- The server groups requests by `sessionId` + `lane`
- Within a session/lane, the system prompt is typically identical across requests
- The server adds `cache_control` markers to the system prompt and the first N context messages
- Cache hit ratio target: >80% for multi-turn conversations

**Extension-side requirement:** None. The extension sends the same canonical request format. The server handles cache marker injection transparently.

**Cost impact:** For a typical `chat-act` session (10 exchanges, 50K tokens system+context, 5K tokens per exchange), prompt caching reduces input costs by ~70%.

---

## HIGH-9: Tool Definition Bandwidth Optimization

### The Gap

Every `GatewayRequest` includes `tools: ToolDefinition[]` -- all 22 tool definitions with full JSON schemas. This is approximately 8-12KB per request. For the `completion` lane (high frequency, small payloads), tool overhead can exceed the actual message content.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Option A: Tool schema hashing (recommended).**

First request in a session sends full tool definitions plus a hash:
```json
{
    "tools": [...full definitions...],
    "toolsHash": "sha256:abc123..."
}
```

Subsequent requests in the same session send only the hash:
```json
{
    "toolsHash": "sha256:abc123..."
}
```

The server caches the tool definitions by hash. If the hash is unknown, it returns 400 asking for full definitions.

**Option B: Server-defined tools.**

The server already knows the QIC tool definitions (they're part of the product). The extension sends no tool definitions at all -- just the list of tool names allowed for this lane. The server maintains the canonical tool schemas.

- Pro: Minimal bandwidth, server can optimize tool descriptions for each model
- Con: Tool definitions must stay synchronized between extension versions and server versions

**Option C: Compression (complementary).**

Enable gzip/brotli compression on all request/response bodies. This reduces the 10KB tool payload to ~1-2KB. Works with any other option.

**Recommendation:** Option C (compression) immediately for all requests. Option A (hashing) for Phase 3 when optimization matters at scale.

---

## HIGH-12: JWT Plan Tier Goes Stale After Upgrade

### The Gap

The JWT embeds the user's plan tier (`"plan": "free"`) with a 15-minute TTL. When a user upgrades via Stripe, the webhook updates the database, but the active JWT still says `"plan": "free"` until the next token refresh. A user who upgrades to Pro might wait up to 15 minutes before accessing the reasoning tier.

### Fix Required in Plan

Add to `05-authentication-and-billing.md`, under "Token Lifecycle":

**Server-side plan-tier override:** For plan-sensitive routing decisions (reasoning tier access), the request router checks plan tier from Redis (updated immediately by the Stripe webhook), not from the JWT alone. The JWT's plan claim is a fast-path optimization: if the JWT says "pro," trust it; if the JWT says "free," check Redis for a recent upgrade before rejecting.

**Server-initiated token refresh:** On plan change, the Stripe webhook sets a flag in Redis (`user:{id}:plan-changed`). On the next request with a stale JWT, the server includes `X-QIC-Token-Refresh: required` in the response headers. The `QuantlabCloudAdapter` checks for this header and triggers an immediate token refresh, which returns a JWT with the updated plan tier.

Add the `X-QIC-Token-Refresh` header to `02-api-contract.md` and the header-triggered refresh logic to `01-extension-integration.md`.

---

## HIGH-13: DegradationManager Integration Missing

### The Gap

The codebase has a `DegradationManager` (`common/resilience/degradationManager.ts`) with a 5-level degradation system: Normal (0), ReducedQuality (1), NoCompletions (2), LocalOnly (3), Emergency (4). The plan discusses circuit breakers and fallback to BYOK but never connects this to the DegradationManager. When the cloud server goes down, the DegradationManager should be notified alongside the circuit breaker.

### Fix Required in Plan

Add to `01-extension-integration.md`:

**DegradationManager hookup:** The `QuantlabCloudAdapter` registers as a service with the DegradationManager. When the circuit breaker opens:

| Scenario | BYOK Available | Ollama Available | Degradation Level |
|----------|---------------|-----------------|-------------------|
| Cloud down | Yes | Yes | 1 (ReducedQuality) -- disable speculative completions |
| Cloud down | No | Yes | 3 (LocalOnly) -- only local completion and file ops |
| Cloud down | No | No | 4 (Emergency) -- only session recovery and checkpoint |

When the circuit breaker recovers (half-open probe succeeds), the DegradationManager returns to level 0 (Normal). The status bar indicator (`[Cloud*] QIC Degraded`) reflects the degradation level, not just circuit breaker state.

Update `07-migration-from-current.md` to add the DegradationManager hookup in the activation flow.

---

## HIGH-14: Spec Invariant Compliance Mapping Missing

### The Gap

The QIC codebase defines 11 system invariants (INV-T1 through INV-A4), all documented in code comments and tested in `test/invariants/invariants.test.ts`. The server plan introduces a cloud path that affects several invariants but never explicitly verifies that compliance is maintained.

### Fix Required in Plan

Add an **"Invariant Compliance"** section to `00-executive-summary.md` or `07-migration-from-current.md`:

| Invariant | Affected? | Compliance Strategy |
|-----------|----------|-------------------|
| INV-T1 (MutationEngine requires ApprovalToken) | No | Mutations are local, unaffected by cloud path |
| INV-T2 (ToolRouter logs all tool calls) | No | Tool execution is local, unaffected |
| INV-T3 (Secret protection via EgressBoundaryEnforcer) | **Yes** | Gateway's egress enforcement applies to QuantlabCloudAdapter. The new `'quantlab-cloud'` boundary goes through the same `checkAndSanitize()` path. Test: send a request containing a known secret pattern, verify redaction before it reaches the server. |
| INV-T6b (Reproducible requests via ReproducibilityLogger) | **Yes** | Cloud requests use `model: "quantlab-auto"` (virtual). The logger must record both the outgoing request (with virtual model) and the actual model from `meta.actualModel` on stream completion. Otherwise replay targets a different model. |
| INV-A1 (canonical/index.ts is sole type authority) | **Yes** | Any `StreamChunk` extension (e.g., `providerMeta` field) must be added to `canonical/interfaces.ts`, not defined ad-hoc in the adapter. |
| INV-A4 (TimeoutManager USER_INTERACTION has no timeout) | No | Unaffected by cloud path |
| All others (INV-T4, INV-A2, INV-A3) | No | Local-only concerns |

---

## HIGH-15: Graceful Shutdown Severs Active SSE Connections During Deployment

### The Gap

When Kubernetes rolls a new server version, it terminates pods. SSE connections are long-lived -- a reasoning-tier response may stream for 30+ seconds including extended thinking time. The default `terminationGracePeriodSeconds` (30s) is too short. Every deployment causes dropped responses for some users.

### Fix Required in Plan

Add to `03-server-architecture.md`, Infrastructure section:

**Graceful shutdown protocol:**
1. Pod receives SIGTERM
2. `preStop` hook: remove pod from load balancer (stop accepting new connections)
3. Server enters draining mode: existing SSE connections continue streaming
4. Wait for all active streams to complete, up to 90 seconds
5. After 90s, force-close remaining connections (send a `done` chunk with `stopReason: "server-shutdown"` if possible)
6. Pod terminates

**Kubernetes config:**
```yaml
terminationGracePeriodSeconds: 120  # Must exceed preStop + drain timeout
strategy:
  rollingUpdate:
    maxUnavailable: 0   # Zero-downtime deployment
    maxSurge: 1
```

Add this to Phase 2 infrastructure deliverables in `06-implementation-phases.md`.
