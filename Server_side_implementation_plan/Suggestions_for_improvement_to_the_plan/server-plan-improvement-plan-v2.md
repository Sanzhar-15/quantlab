# QIC Server-Side Plan: Comprehensive Improvement Plan (v2 — Self-Audited)

**Audit scope**: All 8 plan files (2,306 lines), cross-referenced against QIC Spec v6.2 (8,465 lines) and Implementation Plan v3 (2,274 lines).

**Methodology**: Initial line-by-line review, then self-audit of that review. The self-audit corrected 3 severity misclassifications, identified 6 missed findings, and improved 1 remediation. All corrections are documented in the Audit Corrections appendix.

**Finding count**: 31 findings — 3 critical, 14 high, 9 medium, 5 low/advisory.

**Structure**: Findings ordered by severity, then by implementation priority within each tier. Each finding includes exact plan location(s), problem statement, remediation, and files to modify.

---

## TIER 1 — CRITICAL (would cause system failures or data loss)

### C1. Quality signals never reach the server for server-path users

**Where**: `04-data-pipeline-and-flywheel.md`, "Collection Architecture" diagram and "What We Collect" section.

**Problem**: The plan states "For server-path users, data collection is server-side and invisible to the extension." The server sees requests and responses, but the most valuable training signals — accept/reject, edit distance, re-request, test pass/fail — exist exclusively in the extension. The server has no way to observe whether the user *used* its output. Without these signals, you cannot build preference pairs (for DPO), cannot calculate quality scores for curation, and cannot train the routing classifier. The entire flywheel thesis collapses.

**Remediation**: Add a lightweight client-side quality signal reporter that runs for ALL server-path users (not just data contributors). This is metadata, not code content:

```typescript
interface QualitySignal {
    requestId: string;        // Links to the server's request log
    type: 'accept' | 'reject' | 'edit' | 'retry' | 'test-result';
    lane: LaneName;
    editDistance?: number;     // 0.0-1.0, only for 'edit' type
    testPassed?: boolean;     // Only for 'test-result' type
    timeToDecisionMs?: number;
}
```

Batch these and send via the existing telemetry endpoint, gated by server-path ToS consent (not requiring "data contributor" opt-in). This must be designed into Phase 2 of the implementation, not Phase 5. The extension-side hook point is Gateway's `onResponseComplete` callback — add a quality signal collector there.

**Files to modify**: `04-data-pipeline-and-flywheel.md` (collection architecture), `01-extension-integration.md` (add quality signal hook), `02-api-contract.md` (telemetry endpoint payload), `06-implementation-phases.md` (move signal collection to Phase 2).

---

### C2. Data instrumentation starts too late (Phase 5)

**Where**: `06-implementation-phases.md`, Phase 5.

**Problem**: Phase 5 is "Data Pipeline" and depends on Phase 4 (billing, which implies real users). But your earliest users are the most engaged, generate the highest-quality signal, and represent the rarest demographic (early adopter quant developers). If you don't capture raw events from Phase 2 onward, you lose months of irreplaceable data.

The plan acknowledges that the fine-tuning pipeline (Phase 6) depends on Phase 5 data. But Phase 5 depends on infrastructure that could have been collecting data since Phase 2. Every month of delayed instrumentation is a month of training data you never get back.

**Remediation**: Split data collection into two parts:

- **Phase 2 addition**: Write every request metadata event (timestamp, lane, model tier, token counts, latency, stop reason) to an append-only log (S3 via async batch upload, or local JSONL files aggregated weekly). No curation, no processing — just capture. Cost: negligible (a few lines of Go middleware). Also instrument the quality signal hook from C1.

- **Phase 5 (unchanged scope)**: Curation pipeline, PII scrubbing, quality filtering, dataset construction, data contributor program. This phase processes the historical data accumulated since Phase 2.

**Files to modify**: `06-implementation-phases.md` (add data capture to Phase 2 deliverables), `03-server-architecture.md` (add async event writer to API gateway component).

---

### C3. No free-tier abuse prevention

**Where**: `05-authentication-and-billing.md`, "Plan Tiers" section.

**Problem**: 500K tokens/month free with 30 requests/minute and no identity verification is an open invitation for multi-account abuse. Someone creates 10 Gmail accounts and gets 5M free tokens/month. The plan has no mention of email verification, account age requirements, device fingerprinting, or credit card hold.

Cursor requires either a credit card or an active code session to access free tokens. GitHub Copilot requires a GitHub account with sufficient history. Without some friction, you subsidize abuse before you have revenue.

**Remediation**: The target market is quant developers — a privacy-conscious demographic. Avoid heavy-handed identity verification. Instead:

**Free tier gating (Phase 2)**: Email verification required. Require a GitHub or LinkedIn account with >1 year of age (low friction for real developers, high friction for bot accounts). Free accounts rate-limited to 10 requests/minute (not 30). Extension fingerprint (VS Code installation ID) tracked per account — one free account per installation.

**Free tier gating (Phase 4)**: Progressive trust — new accounts start with 100K tokens/month, graduating to 500K after 30 days of legitimate usage patterns (diverse lane usage, reasonable request frequency, non-trivial prompts). Accounts flagged for anomalous behavior (e.g., identical prompts across accounts, API-like request patterns) are throttled to 50K/month pending review.

**Files to modify**: `05-authentication-and-billing.md` (add abuse prevention section), `06-implementation-phases.md` (add gating to Phase 2 and Phase 4 deliverables).

---

## TIER 2 — HIGH (architectural issues or significant technical debt)

### H1. No streaming cancellation protocol

**Where**: `02-api-contract.md`, entire document — streaming lifecycle is start-only.

**Problem**: When a user hits Escape during a `chat-act` response, the extension must signal the server to abort the upstream provider request. Without cancellation, the server continues streaming from the provider, consuming tokens and billing the user for output they never see. For reasoning-tier requests (Opus, o1), a single cancelled response could waste $0.50-2.00.

The SSE protocol is one-directional (server → client). Three things need specification:

1. How the server detects client disconnect (Go's `context.Done()` when TCP connection closes)
2. Whether the server aborts the upstream provider request on disconnect (it should)
3. How partially-streamed tokens are billed (they must be — the provider charges for them)

**Remediation**: Add to `02-api-contract.md`:

**Cancellation**: The client cancels a streaming request by closing the HTTP connection. The server MUST detect the closed connection within 500ms and abort the upstream provider request. Tokens already generated by the provider are billed to the user's quota. The `X-QIC-Request-ID` enables correlation if the server needs to clean up asynchronously.

Add to `03-server-architecture.md`: The Go proxy must propagate `context.Context` cancellation from the client connection through to the upstream HTTP request. Use `http.NewRequestWithContext()` and select on both the upstream response stream and the client context.

**Files to modify**: `02-api-contract.md` (add cancellation section), `03-server-architecture.md` (add cancellation propagation detail).

---

### H2. JWT plan tier goes stale after upgrade

**Where**: `05-authentication-and-billing.md`, "Token Lifecycle" section and `03-server-architecture.md`, "Authentication Service" section.

**Problem**: The JWT embeds the user's plan tier with a 15-minute TTL. When a user upgrades via Stripe, the webhook updates the database, but the user's active JWT still says `"plan": "free"` until it refreshes. This means a user who upgrades to Pro might wait up to 15 minutes before accessing the reasoning tier.

**Remediation**: Two complementary fixes:

1. **Server-side override for plan-sensitive decisions**: The request router checks plan tier from Redis (updated by Stripe webhook) for reasoning-tier access decisions, not from the JWT. The JWT's plan claim is used as a fast-path optimization only — if the JWT says "pro," trust it; if the JWT says "free," check Redis for a recent upgrade.

2. **Server-initiated token refresh**: On plan change, set a flag in Redis (`user:{id}:plan-changed`). On the next request, if the flag is set, include a `X-QIC-Token-Refresh: required` header in the response. The QuantlabCloudAdapter sees this header and triggers an immediate token refresh, which returns a JWT with the updated plan.

**Files to modify**: `05-authentication-and-billing.md` (add plan-change propagation), `03-server-architecture.md` (add Redis plan-check in router), `02-api-contract.md` (add `X-QIC-Token-Refresh` header), `01-extension-integration.md` (add header-triggered refresh in adapter).

---

### H3. No spec invariant compliance mapping

**Where**: Absent from all 8 files.

**Problem**: The existing QIC spec defines 11 system invariants (INV-T1 through INV-A4). The Implementation Plan v3 meticulously maps each invariant to the phase where it's first enforced. The server-side plan doesn't reference any of these invariants or verify that the hybrid architecture preserves them.

Critical invariants affected by the server path:

- **INV-T3 (Secret Protection)**: "EgressBoundaryEnforcer calls SecretRedactor before every external send." Does the QuantlabCloudAdapter go through EgressBoundaryEnforcer? The plan's activation code in `07-migration-from-current.md` builds the Gateway with egress enforcement, so yes — but this should be explicitly stated and tested.

- **INV-T6b (Reproducible Requests)**: "ReproducibilityLogger records all requests." For cloud path, what gets logged? The request as sent to the cloud server (with `model: "quantlab-auto"`)? Or the actual model that served the request (returned in `meta.actualModel`)? Both are needed: the former for request replay, the latter for debugging model-specific behavior.

- **INV-A1 (Single Source of Truth)**: "`canonical/index.ts` is sole type authority." The `meta` field added to the `done` StreamChunk is a new type. Does it extend the canonical StreamChunk type, or is it handled entirely within the adapter? If the former, `canonical/interfaces.ts` must be updated. If the latter, the adapter strips it before passing upstream — this must be explicit.

**Remediation**: Add a new section to `00-executive-summary.md` or create a dedicated `08-invariant-compliance.md`:

For each of the 11 invariants, state: (a) whether the cloud path affects it, (b) how compliance is maintained, (c) what test verifies it. Specifically:

- INV-T3: Confirm Gateway's egress enforcement applies to QuantlabCloudAdapter. Test: send a request containing a known secret pattern → verify it's redacted before reaching the server.
- INV-T6b: ReproducibilityLogger logs `{ endpoint: serverUrl, body: gatewayRequest }` on send, then appends `{ meta.actualModel }` on stream completion. Both are needed.
- INV-A1: The `meta` field is NOT added to canonical `StreamChunk`. The adapter strips it and exposes server metadata via a separate `QuantlabCloudAdapter.getLastRequestMeta()` method.

**Files to modify**: Create `08-invariant-compliance.md` or add section to `00-executive-summary.md`.

---

### H4. Model routing event missing from stream

**Where**: `02-api-contract.md`, SSE response format.

**Problem**: When a user sends `model: "quantlab-auto"`, they don't know which model will serve the request until the `done` chunk arrives with `meta.actualModel`. For expensive reasoning-tier requests that might take 3+ seconds to first token, the user sees a blank chat with no indication of what's happening. The response headers include `X-QIC-Actual-Model` and `X-QIC-Routing-Tier`, but SSE response headers are only available after the first chunk arrives — they don't help during the wait.

**Remediation**: Add a `routing` event as the first SSE chunk before content streaming begins:

```
data: {"type":"routing","actualModel":"claude-sonnet-4-20250514","tier":"coding","estimatedTtft":1200}

data: {"type":"text","text":"Let me "}
...
```

The extension can immediately show "Using Claude Sonnet 4 (coding tier)..." in the chat UI. The `estimatedTtft` (optional) helps the extension show a meaningful progress indicator.

This requires adding `routing` to the StreamChunk type — but only within the QuantlabCloudAdapter. The adapter consumes the routing chunk internally and emits a provider metadata event to the UI, then passes through only standard StreamChunk types to the Gateway.

**Files to modify**: `02-api-contract.md` (add routing event to SSE format), `01-extension-integration.md` (add routing chunk handling in adapter).

---

### H5. Stripe webhook signature verification absent

**Where**: `05-authentication-and-billing.md`, "Billing Integration (Stripe)" section.

**Problem**: The billing section describes webhook handlers for `subscription.created`, `invoice.paid`, `invoice.payment_failed` — but doesn't mention verifying the `stripe-signature` header. Without signature verification, anyone who discovers the webhook endpoint URL can POST fabricated payment events and grant themselves Pro access, modify billing records, or trigger plan downgrades for other users. This is a one-line fix but a critical security gap.

**Remediation**: Add to `05-authentication-and-billing.md`, Billing Integration section:

**Webhook security**: All Stripe webhook handlers MUST verify the `stripe-signature` header using `stripe.webhooks.constructEvent(payload, sig, endpointSecret)` before processing any event. Unverified events return 400 and are logged as security incidents. The webhook endpoint secret is stored as an environment variable, never in source code.

Add to `06-implementation-phases.md`, Phase 4 deliverables: Include webhook signature verification as a hard requirement with a test that sends a request with an invalid signature and verifies rejection.

**Files to modify**: `05-authentication-and-billing.md` (add webhook verification), `06-implementation-phases.md` (add to Phase 4 acceptance criteria).

---

### H6. Monitoring and observability missing

**Where**: Absent from `03-server-architecture.md` (beyond the data pipeline metrics table in `04-data-pipeline-and-flywheel.md`).

**Problem**: The server plan mentions metrics in passing (data pipeline health table) but has no dedicated monitoring specification. There are no alerting rules, no dashboard requirements, no on-call runbook, no distributed tracing specification. For a system that proxies all user inference requests through a single server, an undetected outage means every user loses AI capability simultaneously — worse than BYOK where each user's failure is independent.

**Remediation**: Add a "Monitoring & Observability" section to `03-server-architecture.md`:

**Core metrics** (all per-region, per-lane):
- Request rate (req/s)
- Error rate (% of 4xx and 5xx responses)
- Latency: p50, p95, p99 by lane
- Time-to-first-token: p50, p95, p99 by lane
- Provider health: status per provider per region
- Quota utilization: % of monthly budget consumed, aggregated daily
- Billing accuracy: server-metered tokens vs. provider-reported tokens (should match within 1%)
- Active SSE connections (gauge)

**Alerting thresholds**:
- Error rate >5% for 2 minutes → page on-call
- p99 latency exceeds tier budget (completion >500ms, chat >2s, reasoning >5s) for 5 minutes → warn
- Provider outage (health check fails 3 consecutive times) → page + auto-failover
- Billing discrepancy >1% over 24 hours → warn
- Active connections >80% of server capacity → warn (autoscale trigger)

**Distributed tracing**: The `X-QIC-Request-ID` (client-generated, see H11) flows through all layers. Server logs include this ID in structured JSON format. Provider requests include it as metadata. This enables a single ID lookup to trace the full lifecycle: extension → server → provider → server → extension.

**Tooling**: Prometheus + Grafana for metrics/dashboards, structured JSON logs to CloudWatch/Loki, PagerDuty or Opsgenie for alerting.

**Files to modify**: `03-server-architecture.md` (add monitoring section), `06-implementation-phases.md` (add monitoring setup to Phase 2 deliverables — not Phase 5).

---

### H7. Egress boundary semantics unclear for cloud path

**Where**: `01-extension-integration.md`, Section 6 "Egress Consent Integration."

**Problem**: The plan adds `'quantlab-cloud'` as a new `EgressBoundary` value alongside the existing `'llm'`. But the spec defines 5 detailed `DataEgressBoundary` objects with specific consent granularity, redaction rules, and audit configuration. The plan's addition is a single string value that doesn't map to this structure.

Moreover, the cloud path involves TWO egress hops: extension → Quantlab server → provider API. The user consents to sending code to Quantlab, but Quantlab forwards it to Anthropic/OpenAI.

**Remediation**: Define a full `DataEgressBoundary` entry for the cloud path:

```typescript
{
    id: 'egress-quantlab-cloud',
    name: 'Quantlab Cloud Inference',
    dataType: DataCategory.SESSION_STATE,
    destination: {
        type: DataDestination.LLM_PROVIDER,
        providers: ['quantlab-cloud'],
    },
    consent: {
        required: true,
        granularity: 'first-run',
        canOptOut: false,       // If cloud mode, consent is required
        defaultState: 'opted-out',
    },
    redaction: { required: true, patterns: ['all'] },
    audit: { logRequest: true, logResponse: true, retentionDays: 7, includeContent: false },
}
```

Cloud consent is a single consent covering the full chain. When a user in cloud mode consents to `egress-quantlab-cloud`, they do NOT also need to consent to `egress-llm-chat` — the cloud boundary subsumes it. The `EgressBoundaryEnforcer` must understand this precedence.

**Files to modify**: `01-extension-integration.md` (replace simple string boundary with full `DataEgressBoundary`).

---

### H8. DegradationManager integration missing

**Where**: Absent from `01-extension-integration.md` and `07-migration-from-current.md`.

**Problem**: The spec defines a 5-level DegradationManager (NORMAL → REDUCED → LIMITED → MINIMAL → EMERGENCY) that manages system behavior when services degrade. The server plan discusses circuit breakers and fallback to BYOK, but doesn't connect this to the DegradationManager.

When the cloud server goes down, the circuit breaker opens and ModelRegistry falls through to BYOK. But the DegradationManager should also be notified — it might disable speculative completions (level 1), disable vector search (level 2), or switch to local-only (level 3) depending on severity.

**Remediation**: Add to `01-extension-integration.md`:

The QuantlabCloudAdapter registers as a service with the DegradationManager. When the circuit breaker opens:

- If BYOK fallback is available → DegradationManager level 1 (REDUCED). Disable speculative completions (they're latency-sensitive and BYOK adds overhead). Show `[Cloud*] QIC Degraded` in status bar.
- If no BYOK fallback and only Ollama available → DegradationManager level 3 (MINIMAL). Only local completion and file operations.
- If no providers available → DegradationManager level 4 (EMERGENCY). Only session recovery and checkpoint restore.

When the circuit breaker recovers → DegradationManager returns to level 0.

**Files to modify**: `01-extension-integration.md` (add DegradationManager integration), `07-migration-from-current.md` (add DegradationManager hookup in activation flow).

---

### H9. No extension ↔ server version compatibility contract

**Where**: `02-api-contract.md` mentions `X-QIC-Extension-Version` header but defines no behavior.

**Problem**: The API contract defines the request header but doesn't specify what happens when versions are incompatible. If the server adds a required field to GatewayRequest, or StreamChunk gains a new `type` value the extension doesn't understand, or the server deprecates an endpoint — there's no defined behavior.

**Remediation**: Add to `02-api-contract.md`:

**Compatibility contract**:

- Server MUST accept requests from extensions up to 2 major versions behind.
- Server MUST NOT add required fields to GatewayRequest without a major version bump.
- New StreamChunk `type` values are ignored by older extensions (forward-compatible by design — the adapter's switch statement falls through to a no-op default).
- If extension version is too old (>2 major versions behind), server returns HTTP 426 (Upgrade Required) with body `{ "error": { "code": "QIC-UPGRADE", "message": "Please update Quantlab", "minVersion": "2.0.0" } }`. The adapter displays an "Update Required" notification with a link to the marketplace.

**Files to modify**: `02-api-contract.md` (add compatibility section).

---

### H10. Graceful shutdown severs active SSE connections during deployment

**Where**: Absent from `03-server-architecture.md`.

**Problem**: When Kubernetes rolls a new server version, it terminates pods. SSE connections are long-lived — a reasoning-tier response might stream for 30+ seconds. Without explicit connection draining, a deployment severs active streams mid-response. The default `terminationGracePeriodSeconds` (30s) is too short for reasoning-tier streams that may include extended thinking time.

This isn't theoretical — every deployment causes dropped responses for some users. With completions firing on every keystroke, even a brief disruption is visible.

**Remediation**: Add to `03-server-architecture.md`, Infrastructure section:

**Graceful shutdown protocol**:
1. Pod receives SIGTERM.
2. `preStop` hook: remove pod from load balancer (stop accepting new connections).
3. Server enters draining mode: existing SSE connections continue streaming.
4. Wait for all active streams to complete, up to 90 seconds.
5. After 90s, force-close remaining connections (send a `done` chunk with `stopReason: "server-shutdown"` if possible).
6. Pod terminates.

Kubernetes config: `terminationGracePeriodSeconds: 120` (must exceed the preStop + drain timeout). Rolling update strategy: `maxUnavailable: 0`, `maxSurge: 1` (zero-downtime deployment).

**Files to modify**: `03-server-architecture.md` (add graceful shutdown section), `06-implementation-phases.md` (add to Phase 2 infrastructure deliverables).

---

### H11. Request ID should be client-generated for end-to-end tracing

**Where**: `02-api-contract.md`, `X-QIC-Request-ID` is mentioned only in response headers.

**Problem**: The plan mentions `X-QIC-Request-ID` in the response but doesn't specify who generates it. For end-to-end debugging (extension → server → provider → server → extension), the client should generate a UUID and send it in the request header. Currently, debugging a failed request requires correlating timestamps across three separate systems (extension logs, server logs, provider dashboard) — slow and error-prone.

**Remediation**: Add to `02-api-contract.md`:

**Request tracing**: The client generates a UUIDv4 and sends it as `X-QIC-Request-ID` in the request header. The server:
1. Uses this ID for all internal logging related to the request.
2. Passes it to the provider as metadata (Anthropic: `metadata.user_id`, OpenAI: custom header).
3. Returns it in the response header (confirming receipt).
4. Includes it in the `done` chunk's `meta` object.

If the client omits the header, the server generates one. The extension's ReproducibilityLogger records this ID, enabling single-ID lookup across all three systems.

**Files to modify**: `02-api-contract.md` (add request tracing contract), `01-extension-integration.md` (generate UUID in QuantlabCloudAdapter).

---

## TIER 3 — MEDIUM (correctness and optimization issues)

### M1. Prompt caching strategy absent

**Where**: Absent from `03-server-architecture.md`.

**Problem**: Anthropic's prompt caching reduces costs up to 90% for cache hits on repeated prefixes. The server is uniquely positioned to exploit this because it controls system prompts and can route requests with identical prefixes to the same provider connection. The spec already references "prompt-caching-enabled" as a completion tier requirement (Tier 4, spec line 2026). But the server plan never mentions prompt caching.

For a coding assistant, system prompts and tool definitions are often identical across requests within a session. With 8 lanes, each with a fixed system prompt template, the server can pre-warm caches and achieve high hit rates.

**Remediation**: Add to `03-server-architecture.md`, Provider Multiplexer section:

**Prompt caching optimization**: The server maintains stable system prompt prefixes per lane. The Anthropic adapter uses `cache_control` markers to cache the system prompt + tool definitions block (typically 2K-8K tokens). The server tracks cache hit rates per lane and adjusts prefix stability to maximize hits.

Expected cost reduction: 50-70% on input tokens for Anthropic requests after cache warm-up. This is one of the strongest cost advantages of the server path over BYOK (where each user's extension has independent cache state).

**Files to modify**: `03-server-architecture.md` (add prompt caching section to Provider Multiplexer).

---

### M2. Completion lane will burn through rate limits

**Where**: `05-authentication-and-billing.md`, Plan Tiers table.

**Problem**: The completion lane fires on every keystroke (debounced, but still high-frequency). At Pro's 200 requests/minute, fast typing with inline completions could exhaust the rate limit in under a minute, blocking all other lanes (chat, repair). The plan doesn't differentiate rate limits by lane or request type.

**Remediation**: Add lane-aware rate limiting:

- **Completion lane**: Separate bucket — 120 requests/minute for Pro (doesn't compete with chat/agent).
- **Chat/agent lanes**: Shared bucket — 60 requests/minute for Pro.
- **Server-side optimization**: The server deduplicates rapid-fire completion requests from the same session (if a new completion request arrives while the previous one is still streaming, cancel the previous one). This reduces provider costs without the user noticing.

Also add client-side intelligence: the QuantlabCloudAdapter should respect the server's `X-RateLimit-Remaining` header and proactively suppress low-priority completion requests when the budget is low.

**Files to modify**: `05-authentication-and-billing.md` (add lane-aware rate limits), `03-server-architecture.md` (add completion deduplication), `01-extension-integration.md` (add proactive rate limit management).

---

### M3. No idempotency for non-streaming requests

**Where**: `02-api-contract.md`, `POST /v1/qic/request` endpoint.

**Problem**: The non-streaming endpoint is synchronous. If the client's connection drops after the server processes the request but before the response arrives, the client retries. Without an idempotency mechanism, the server processes and bills the request twice. For expensive reasoning-tier requests, this could double-charge the user.

**Remediation**: Add to `02-api-contract.md`:

**Idempotency**: The client sends an `Idempotency-Key` header (UUIDv4) with every non-streaming request. The server:
1. Checks Redis for the key before processing.
2. If found: returns the cached response (no re-processing, no re-billing).
3. If not found: processes the request, caches the response under the key for 5 minutes, returns the response.
4. If the key is missing: server generates one internally (but cannot guarantee idempotency for retries).

Streaming requests don't need this — SSE connections are inherently resumable via `Last-Event-ID`, and re-requesting a stream is expected behavior.

**Files to modify**: `02-api-contract.md` (add idempotency section).

---

### M4. `laneOverrides` interaction with ModelRegistry fallback unspecified

**Where**: `01-extension-integration.md`, Section 3 "Per-Lane Provider Override."

**Problem**: The setting `qic.laneOverrides` lets users route specific lanes to specific providers (e.g., `"completion": "byok-openai"`). But the plan doesn't define: what happens if the override target is unavailable? Does it fall through to the default recommendation chain? What's the precedence: override → default cloud → BYOK → local?

**Remediation**: Add to `01-extension-integration.md`:

**Override resolution**:
1. If `laneOverrides[lane]` is set, try that provider first.
2. If override provider is unavailable (no key, circuit breaker open), log a warning and fall through to `LANE_MODEL_RECOMMENDATIONS[lane]` as if no override existed.
3. Overrides are "prefer," not "require." This prevents user misconfiguration from breaking the system.

**Files to modify**: `01-extension-integration.md` (add override resolution semantics).

---

### M5. Connection mode switching is disruptive and under-specified

**Where**: `01-extension-integration.md`, Section 7 "Switch Connection Mode."

**Problem**: The `qic.switchConnectionMode` command "triggers gateway re-initialization." But re-initializing the gateway means destroying all existing provider adapters, circuit breakers, rate limiters, and creating new ones. What happens to in-flight requests? Agent loops in progress?

**Remediation**: Add to `01-extension-integration.md`:

**Mode switching protocol**:
1. New mode takes effect only for NEW requests. In-flight requests complete on their current adapter.
2. The Gateway maintains both old and new provider Maps during the transition. Old providers are dereferenced after all in-flight requests complete (or after a 30-second timeout).
3. If an agent loop is in progress (multi-turn tool execution), the loop continues on the original provider until the current turn completes, then subsequent turns use the new provider.
4. Warning: "Switching connection mode will take effect for new requests. Current conversations will continue using the previous connection."

**Files to modify**: `01-extension-integration.md` (add mode switching protocol).

---

### M6. No server-side secret scanning for data pipeline

**Where**: `04-data-pipeline-and-flywheel.md`, PII scrubbing section.

**Problem**: The client-side EgressBoundaryEnforcer scans for secrets before sending requests. But the data pipeline stores interaction data for curation and fine-tuning. If a secret slips through client-side scanning (false negative, or a new pattern), it persists in the training data indefinitely. The PII scrubbing pipeline mentions email addresses, file paths, and credentials in string literals — but it doesn't reference the spec's `OptimizedSecretScanner` with its 60+ patterns.

**Remediation**: The data pipeline's PII scrubber should use the same secret pattern database as the extension-side scanner (shared as a JSON pattern file or npm package). Add to Phase 5: the curation pipeline runs the full `SecretPatterns` list against all stored code content, with alerts on any matches (these represent client-side scanning failures).

**Files to modify**: `04-data-pipeline-and-flywheel.md` (reference spec's secret pattern database in PII scrubber).

---

### M7. Token counting discrepancy between client and server

**Where**: Implicit across `01-extension-integration.md` (context assembly) and `05-authentication-and-billing.md` (billing).

**Problem**: Context assembly is client-side — the extension's `ContextAssembler` allocates token budgets per lane using approximate tokenizers. Server-side billing uses actual token counts from provider responses. These will differ, sometimes significantly. The extension's quota display ("7.2M / 10M tokens used") will drift from actual billing.

**Remediation**: Add to `02-api-contract.md`:

The `done` chunk's `meta.quotaRemaining` is the authoritative usage figure. The QuantlabCloudAdapter updates the local quota display after every response using this value. The extension's token estimation is used only for pre-request cost prediction (advisory, not authoritative).

Add to `01-extension-integration.md`: The adapter emits a `quota-updated` event after each response, which the UI service consumes to update the status bar display.

**Files to modify**: `02-api-contract.md` (document authoritative quota source), `01-extension-integration.md` (add quota-updated event).

---

### M8. ReproducibilityLogger and SessionCache interaction with cloud path unspecified

**Where**: Absent from all files.

**Problem**: The spec defines `ReproducibilityLogger` (logs all requests/responses for replay) and `SessionCache` (caches responses for identical requests within a session). Both operate at the Gateway level. Neither is mentioned in the server plan.

For ReproducibilityLogger: The cloud path sends `model: "quantlab-auto"` — a virtual model alias. On replay, this alias would hit the server again and might get a different model. For true reproducibility, the log must also record the actual model from `meta.actualModel`.

For SessionCache: The cache key currently includes provider + model + message hash. For cloud path, the model is `quantlab-auto`. Two identical requests might be routed to different models server-side.

**Remediation**: Add a "Reproducibility & Caching" section to `01-extension-integration.md`:

- ReproducibilityLogger: Log the outgoing request (with `model: "quantlab-auto"`) and on stream completion, append `actualModel` from `meta`. Replay mode should allow replaying against either the cloud (re-routes) or the actual model via BYOK (deterministic).
- SessionCache: Cloud requests are cache-eligible with a 60-second TTL (vs. 300s for BYOK), keyed on message hash only (model alias is ignored since the server controls routing).

Note: INV-T6b/c are Phase 9 in the extension implementation plan, so this is documentation-only for now — ensuring the server plan doesn't create obstacles for the future Phase 9 implementation.

**Files to modify**: `01-extension-integration.md` (add reproducibility/caching section).

---

### M9. No model pinning for enterprise users

**Where**: Absent from all files.

**Problem**: When the server upgrades from `claude-sonnet-4-20250514` to a newer version, `quantlab-auto` silently changes behavior. Enterprise quant users running production backtesting workflows may need deterministic model behavior across sessions.

**Remediation**: Add to `02-api-contract.md`:

The `model` field accepts either aliases (`quantlab-auto`, `quantlab-fast`) or pinned model IDs (`claude-sonnet-4-20250514`). If a pinned ID is sent, the server routes directly to that model (subject to availability and plan tier). If the model is deprecated, return error `QIC-MODEL-DEPRECATED` with a suggested replacement.

Enterprise plans include a `modelPolicy` setting: "auto" (default) or "pinned" (admin-configured model version per tier).

**Files to modify**: `02-api-contract.md` (add model pinning behavior), `05-authentication-and-billing.md` (add enterprise modelPolicy).

---

### M10. Health check semantics undefined

**Where**: `02-api-contract.md`, `GET /v1/health` endpoint.

**Problem**: The health endpoint returns per-provider status, but the plan doesn't define what "healthy" means. "Healthy" could mean "TCP connection succeeds," "authentication works," or "can process a small request under latency threshold." For load balancers and monitoring, the distinction matters — a server that can connect to Anthropic's API but gets 401 (expired key) is "connected" but not "healthy."

**Remediation**: Add to `02-api-contract.md`:

**Health check levels**:
- **Liveness** (`GET /v1/health/live`): Server process is running and accepting connections. Used by Kubernetes liveness probe. Returns 200 if the HTTP server is responsive. No external checks.
- **Readiness** (`GET /v1/health/ready`): Server can process requests. Used by Kubernetes readiness probe and load balancer. Returns 200 if at least one provider is authenticated and responding. Returns 503 if no providers are available.
- **Detailed** (`GET /v1/health`): Full status. Sends a minimal tokenization request (not a full inference) to each provider, verifies response under 2 seconds. Returns per-provider status: `healthy` (responds <2s), `degraded` (responds but >2s), `unhealthy` (auth failure or no response).

**Files to modify**: `02-api-contract.md` (add health check levels).

---

## TIER 4 — LOW (premature complexity and advisory)

### L1. Multi-region deployment premature in Phase 3

**Where**: `06-implementation-phases.md`, Phase 3 and `03-server-architecture.md`, "Multi-Region Deployment."

**Problem**: Three regions (us-east-1, eu-west-1, ap-northeast-1) with DNS routing in Phase 3 is infrastructure for 10K+ concurrent users. Phase 3 will likely have hundreds.

**Recommendation**: Single region (us-east-1) through Phase 3. Add eu-west-1 in Phase 4 (when billing starts and European quant funds — a primary target market — need low latency for paid usage). ap-northeast-1 only with a signed enterprise contract from an Asian fund.

**Files to modify**: `06-implementation-phases.md` (move eu-west-1 to Phase 4, ap-northeast-1 to Phase 6), `03-server-architecture.md` (note single-region for MVP).

---

### L2. ClickHouse premature — PostgreSQL sufficient for 18+ months

**Where**: `03-server-architecture.md`, "Recommended Stack" table.

**Problem**: At your scale for the first 12+ months (10K-100K events/day), a well-indexed PostgreSQL table with periodic rollups handles analytical queries fine. ClickHouse adds operational overhead: separate cluster, different query dialect, data ingestion pipeline, monitoring.

**Recommendation**: Start with PostgreSQL for everything. Create a `usage_events` table with proper indexing and partitioning (by month). Add materialized views for common aggregations. Migrate analytics to ClickHouse when query performance degrades — which won't happen until millions of daily events.

**Files to modify**: `03-server-architecture.md` (replace ClickHouse with PostgreSQL analytics, note migration trigger).

---

### L3. Go for hot path — validate against team capabilities

**Where**: `03-server-architecture.md`, "Why Go for the core proxy."

**Problem**: Go is optimal for a high-performance streaming proxy, but if your team is primarily TypeScript and Python, introducing Go means a third language and slower initial velocity. Node.js with native HTTP/2 and streaming handles the MVP competently.

**Recommendation**: Add a decision framework:
- If team includes Go engineers → Go from Phase 2
- If team is primarily TypeScript → Node.js/TypeScript for Phase 2-3, rewrite hot path to Go when latency profiling shows Node.js overhead exceeds 5ms at target concurrency
- The Provider Multiplexer's format translation logic is already in TypeScript (the extension adapters) — server-side Node.js can share this code directly

**Files to modify**: `03-server-architecture.md` (add language decision framework).

---

### L4. Fine-tuned model assumptions may not hold

**Where**: `04-data-pipeline-and-flywheel.md`, "The Competitive Moat" section.

**Problem**: The moat thesis assumes fine-tuned Llama/Qwen on quant data will outperform Claude Sonnet for quant tasks. Frontier models improve faster than fine-tuned small models. This is unproven and may never be true.

**Recommendation**: Add a contingency. If fine-tuned models never outperform base models, the data flywheel value is in:
1. **Routing optimization** — the classifier learns which model/tier to use for which request type (30-40% cost reduction)
2. **Prompt engineering** — domain-specific system prompts tuned using interaction data
3. **Session context intelligence** — learning which context to include per domain

Phase 6 success criteria should include routing optimization metrics alongside model quality metrics.

**Files to modify**: `04-data-pipeline-and-flywheel.md` (add contingency), `06-implementation-phases.md` (add routing metrics to Phase 6 success criteria).

---

### L5. Revenue projections need acquisition strategy

**Where**: `05-authentication-and-billing.md`, "Revenue Projections Model."

**Problem**: Projections assume 10K users with 5% Pro conversion. Total addressable market is small (~50K-100K quant developers). No user acquisition strategy is discussed.

**Recommendation**: Note as a dependency: "Revenue projections assume user base growth that depends on marketing, distribution, and product-market fit strategies not covered in this document."

---

## TIER 5 — ADDITIONS (new sections the plan should include)

### A1. Disaster recovery and backup strategy

**Where**: Absent from `03-server-architecture.md`.

**What to add**: For a billing system handling real money:
- PostgreSQL: Automated daily backups (pg_dump), point-in-time recovery enabled, RTO <1 hour, RPO <15 minutes.
- Redis: AOF persistence, replica in same AZ for failover.
- S3 data lake: Cross-region replication enabled.
- Stripe webhooks: Idempotent processing with deduplication (Stripe sends retries).
- Runbook: documented procedure for database restore, provider key rotation, complete region failover.

---

### A2. Load testing strategy

**Where**: Absent from `06-implementation-phases.md`.

**What to add**: Phase 2 success criteria requires "100 concurrent streaming requests without degradation" but doesn't describe validation. SSE load testing is non-trivial — standard HTTP load testers don't handle long-lived streaming connections.

Specify: Use k6 with the SSE extension, or a custom Go load generator that opens N concurrent SSE connections, validates chunk integrity, and measures TTFT distribution. Add to Phase 2 deliverables: load test script and performance baseline document.

---

### A3. Server-side cost estimation

**Where**: Absent from `02-api-contract.md`.

**What to add**: Users have no way to estimate cost before sending a request. For reasoning-tier requests that might consume 50K tokens, a Free tier user (500K/month) could blow 10% of their budget on one question.

Recommended approach: The routing event (H4) includes `estimatedInputTokens` and `tier` metadata. The extension can show a confirmation dialog for expensive requests ("This will use the reasoning tier (~50K tokens). Continue?"). No separate endpoint needed — the routing chunk arrives before content streaming and can be acted on.

---

### A4. Remove email from JWT (PII in every request header)

**Where**: `03-server-architecture.md`, JWT claims section.

**What to change**: The JWT currently includes `"email": "trader@fund.com"`. PII in every request header, access log, and monitoring tool. For privacy-conscious quant fund users, this is problematic.

Remove email from JWT. Use only `sub` (user ID) for request-level identity. Email is available via `/v1/account/info` when needed for display.

---

### A5. Session affinity for agent loops

**Where**: Absent from `03-server-architecture.md`.

**What to add**: A 5-turn agent loop generates 5 separate HTTP requests. These should ideally hit the same server instance (warm connection pool, cached routing decision). Add to load balancer configuration: sticky sessions based on `sessionId` request field, with a 5-minute TTL.

Low-priority optimization, easy to implement, measurably reduces latency for multi-turn interactions.

---

## IMPLEMENTATION PRIORITY TABLE

Ordered by impact, adjusted for effort. This is the recommended execution sequence.

| Priority | Finding | Severity | Effort | Impact | Phase |
|----------|---------|----------|--------|--------|-------|
| 1 | C1 — Quality signal collection | CRITICAL | Medium | Flywheel depends on it | 2 |
| 2 | C2 — Data instrumentation in Phase 2 | CRITICAL | Low | Prevents irreversible data loss | 2 |
| 3 | C3 — Free tier abuse prevention | CRITICAL | Low | Prevents cost bleed before revenue | 2 |
| 4 | H1 — Streaming cancellation | HIGH | Low | Prevents token waste | 2 |
| 5 | H5 — Stripe webhook verification | HIGH | Trivial | Security-critical | 4 |
| 6 | H6 — Monitoring/observability | HIGH | Medium | Operational necessity | 2 |
| 7 | H2 — JWT plan tier staleness | HIGH | Medium | UX after upgrade | 4 |
| 8 | H3 — Invariant compliance mapping | HIGH | Medium | Spec correctness | 1 |
| 9 | H4 — Routing event in stream | HIGH | Low | UX improvement | 2 |
| 10 | H10 — Graceful shutdown | HIGH | Low | Zero-downtime deploys | 2 |
| 11 | H11 — Client-generated request ID | HIGH | Trivial | Debugging capability | 2 |
| 12 | H7 — Egress boundary definition | HIGH | Low | Spec compliance | 1 |
| 13 | H8 — DegradationManager integration | HIGH | Medium | System resilience | 1 |
| 14 | M1 — Prompt caching strategy | MEDIUM | Low | Major cost reduction | 3 |
| 15 | M2 — Lane-aware rate limiting | MEDIUM | Medium | UX protection | 4 |
| 16 | M3 — Idempotency keys | MEDIUM | Low | Billing correctness | 2 |
| 17 | H9 — Version compatibility contract | HIGH | Low | Future-proofing | 2 |
| 18 | M10 — Health check definition | MEDIUM | Low | Ops correctness | 2 |
| 19 | M4 — Lane override fallback | MEDIUM | Trivial | Correctness | 1 |
| 20 | M5 — Mode switching protocol | MEDIUM | Low | Correctness | 1 |
| 21 | M6 — Server-side secret scanning | MEDIUM | Low | Data safety | 5 |
| 22 | M7 — Token counting discrepancy | MEDIUM | Low | Billing accuracy | 2 |
| 23 | M8 — Reproducibility/cache | MEDIUM | Medium | Future Phase 9 compat | Doc only |
| 24 | M9 — Model pinning | MEDIUM | Low | Enterprise readiness | 4 |
| 25 | A4 — Remove email from JWT | ADVISORY | Trivial | Privacy | 2 |
| 26 | A1 — Disaster recovery | ADVISORY | Medium | Operational safety | 4 |
| 27 | A2 — Load testing strategy | ADVISORY | Medium | Validation | 2 |
| 28 | A3 — Cost estimation | ADVISORY | Low | UX | 3 |
| 29 | A5 — Session affinity | ADVISORY | Low | Performance | 3 |
| 30 | L1-L3 — Premature complexity | ADVISORY | Low | Focus/velocity | All |
| 31 | L4-L5 — Strategic concerns | ADVISORY | N/A | Strategic clarity | Doc only |

---

## CHANGES PER PLAN FILE

Summary of every modification needed, grouped by file:

### `00-executive-summary.md`
- Add invariant compliance summary (H3)

### `01-extension-integration.md`
- Add quality signal hook in Gateway callback (C1)
- Add header-triggered token refresh for plan changes (H2)
- Add routing chunk handling in QuantlabCloudAdapter (H4)
- Replace simple boundary string with full `DataEgressBoundary` (H7)
- Add DegradationManager integration section (H8)
- Add client-generated request UUID (H11)
- Add proactive rate limit management (M2)
- Add lane override fallback semantics (M4)
- Add mode switching protocol (M5)
- Add quota-updated event for billing accuracy (M7)
- Add reproducibility/caching compatibility notes (M8)

### `02-api-contract.md`
- Add streaming cancellation protocol (H1)
- Add `X-QIC-Token-Refresh` response header (H2)
- Add routing event to SSE format (H4)
- Add version compatibility contract (H9)
- Add `X-QIC-Request-ID` as client-sent request header (H11)
- Add telemetry endpoint payload for quality signals (C1)
- Add idempotency key protocol (M3)
- Add model pinning behavior (M9)
- Add health check levels (M10)
- Add cost estimation via routing event (A3)

### `03-server-architecture.md`
- Add async event writer to API gateway (C2)
- Add cancellation propagation detail (H1)
- Add Redis plan-check in router (H2)
- Add monitoring and observability section (H6)
- Add graceful shutdown protocol (H10)
- Add prompt caching section to Provider Multiplexer (M1)
- Add completion deduplication (M2)
- Remove email from JWT claims (A4)
- Add session affinity note (A5)
- Add disaster recovery section (A1)
- Note single-region for MVP (L1)
- Replace ClickHouse with PostgreSQL + migration trigger (L2)
- Add language decision framework (L3)

### `04-data-pipeline-and-flywheel.md`
- Add quality signal collection for server-path users (C1)
- Reference spec's secret pattern database in PII scrubber (M6)
- Add contingency for fine-tuned models (L4)

### `05-authentication-and-billing.md`
- Add free tier abuse prevention section (C3)
- Add plan-change propagation mechanism (H2)
- Add Stripe webhook signature verification (H5)
- Add lane-aware rate limit tiers (M2)
- Add enterprise modelPolicy setting (M9)
- Note revenue projections dependency on GTM (L5)

### `06-implementation-phases.md`
- Move data capture and quality signals to Phase 2 deliverables (C1, C2)
- Add free tier gating to Phase 2 and Phase 4 (C3)
- Add webhook verification to Phase 4 acceptance criteria (H5)
- Add monitoring setup to Phase 2 deliverables (H6)
- Add graceful shutdown to Phase 2 infrastructure (H10)
- Add load test script to Phase 2 deliverables (A2)
- Move eu-west-1 to Phase 4, ap-northeast-1 to Phase 6 (L1)
- Add routing metrics to Phase 6 success criteria (L4)

### `07-migration-from-current.md`
- Add DegradationManager hookup in activation flow (H8)

### NEW: `08-invariant-compliance.md`
- Full invariant compliance matrix for cloud path (H3)

---

## AUDIT CORRECTIONS (transparency log)

Three findings from the initial audit (v1) were severity-corrected in this version:

| Original | Corrected | Reason |
|----------|-----------|--------|
| C2 — Streaming cancellation was CRITICAL | H1 — Now HIGH | Token waste, not system failure. A cancelled completion wastes fractions of a cent. Even reasoning-tier waste is bounded. Fixable with standard Go context propagation. |
| C3 — JWT staleness was CRITICAL | H2 — Now HIGH | Frustrating UX (15-minute wait), not data loss or security. Most upgrades happen outside active sessions. |
| H4 — ReproducibilityLogger was HIGH | M8 — Now MEDIUM | INV-T6b/c are Phase 9 in the extension plan — late-stage infrastructure. The server plan doesn't *break* reproducibility; it creates a subtlety that needs documentation. |

One remediation was improved:

| Original | Corrected | Reason |
|----------|-----------|--------|
| C5 recommended phone verification or credit card hold | Now recommends GitHub/LinkedIn account age requirement + progressive trust | Target market is quant developers — privacy-conscious. Phone verification is high friction for this demographic. GitHub/LinkedIn account age is low friction for real developers, high friction for bots. |

Six findings were absent from v1 and added in v2:

| Finding | Why missed |
|---------|-----------|
| H5 — Stripe webhook verification | Security detail missed during billing section review |
| H6 — Monitoring/observability | Present in initial review, dropped during document creation |
| H10 — Graceful shutdown | Deployment operations not considered in v1 |
| H11 — Client-generated request ID | Tracing details overlooked |
| M3 — Idempotency keys | API design pattern missed |
| M10 — Health check definition | Assumed implicit, but semantics matter for ops |
