# API & Protocol Gaps

---

## MEDIUM-1: StreamChunk 'done' Type Has No 'meta' Field

### The Gap

The plan's API contract (doc 02) shows the `done` chunk including a `meta` field with `actualModel`, `routingTier`, `quotaRemaining`. But the actual `StreamChunk` type in the codebase:

```typescript
| { type: 'done'; usage?: TokenUsage; stopReason?: string }
```

There is no `meta` field. The adapter would need to either:
- Strip the `meta` before yielding (losing the data), or
- Extend the `StreamChunk` type to include optional metadata

### Fix Required in Plan

**Recommended approach:** Extend `StreamChunk` to carry optional provider metadata:

```typescript
| { type: 'done'; usage?: TokenUsage; stopReason?: string; providerMeta?: Record<string, unknown> }
```

The `providerMeta` field is optional and ignored by all existing code paths (the orchestrator doesn't read it). The cloud adapter populates it from the server's `meta` field. The extension can surface metadata (actual model used, quota remaining) in the UI without changing the orchestrator.

Add this to `01-extension-integration.md` under "Integration Points" and to `02-api-contract.md` with a note that `meta` maps to `providerMeta` in the canonical type.

---

## MEDIUM-2: Error Code Collision (HTTP 401 vs 403)

### The Gap

The plan maps both HTTP 401 (auth failure) and 403 (plan limit / feature unavailable) to `QIC-P006`. These are semantically different errors requiring different user actions:
- 401: "Sign in again" (token expired)
- 403: "Upgrade your plan" (feature gated)

### Fix Required in Plan

Add a new error code to the QIC error registry:

```
QIC-P007: Plan limit exceeded
```

Update the error table in doc 02:

| HTTP Status | QIC Code | Meaning | User Action |
|-------------|----------|---------|-------------|
| 401 | QIC-P006 | Token expired/invalid | Re-authenticate |
| 403 | QIC-P007 | Plan limit / feature unavailable | Upgrade plan |

The cloud adapter's `normalizeError()` should distinguish:
```typescript
if (status === 401) return new QicError('QIC-P006', 'Session expired. Please sign in again.', undefined, 401);
if (status === 403) return new QicError('QIC-P007', 'Feature requires Pro plan. Upgrade at quantlab.dev/pricing', undefined, 403);
```

---

## MEDIUM-3: Idempotency Keys for Retry Safety

### The Gap

The extension's Gateway has `withRetry()` that retries on 429/500/502/503/529. The server may also retry upstream. If a request succeeds at the provider but the response is lost (network interruption between server and extension), the retry sends the same request again. The provider processes it again, and the user is billed for both.

For inference, this is functionally harmless (same prompt produces similar output). But for billing, it's double-charged.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Idempotency key header:**
```
X-QIC-Idempotency-Key: <uuid>
```

The extension generates a UUID per logical request (not per retry attempt). The server:
1. On first receipt: processes normally, caches the response keyed by idempotency key (Redis, 5 min TTL)
2. On duplicate receipt (same idempotency key): returns the cached response without forwarding to the provider
3. Usage is metered only once per idempotency key

Implementation: Redis `SET NX` on the idempotency key. If the key already exists, return the cached response.

Add to the `QuantlabCloudAdapter`:
```typescript
const idempotencyKey = randomUUID();
headers['X-QIC-Idempotency-Key'] = idempotencyKey;
// Same key used for all retry attempts of this request
```

---

## MEDIUM-4: Request and Response Compression

### The Gap

The plan never mentions HTTP compression. A `chat-act` request with 200K tokens of context can be 800KB+ of JSON. At scale, this wastes bandwidth and increases latency.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Request compression:** The extension sends `Content-Encoding: gzip` and compresses the request body. The server accepts `gzip` and `br` (Brotli) encoded requests.

**Response compression:** Standard `Accept-Encoding: gzip, br` negotiation. SSE streams are gzip-compressed (most CDNs/proxies support this for SSE).

**Impact:** Typical request compression ratio is 5-10x for JSON. An 800KB context window compresses to ~100KB. SSE text chunks compress ~3-5x.

**Implementation note:** Node.js `fetch` (used by the extension in the Electron renderer) supports compressed responses natively. For request compression, the adapter needs to manually compress the body using `CompressionStream` or a polyfill.

---

## MEDIUM-5: Request Size Limits

### The Gap

The `chat-act` lane has a 200K token input budget (~800KB of text). The plan doesn't specify server-side request body limits.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Server-side limits:**

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max request body | 2MB | 200K tokens at ~4 chars/token = ~800KB, plus tool definitions, JSON overhead. 2MB provides headroom. |
| Max messages array length | 500 | Prevent pathological conversations |
| Max tool definitions | 50 | Current max is 22 (with 3 disabled). Headroom for growth. |
| Max streaming response duration | 300s | Prevent zombie streams |

Requests exceeding limits return 413 (Payload Too Large) with a clear error message.

---

## MEDIUM-6: API Pagination for Usage Endpoints

### The Gap

`GET /v1/account/usage` returns daily usage data. For Enterprise users querying months of history, the response could be large.

### Fix Required in Plan

Add pagination to `02-api-contract.md`:

```
GET /v1/account/usage?from=2026-01-01&to=2026-02-01&limit=30&offset=0
```

Response includes pagination metadata:
```json
{
    "daily": [...],
    "pagination": {
        "total": 45,
        "limit": 30,
        "offset": 0,
        "hasMore": true
    }
}
```

---

## MEDIUM-14: Routing Event Missing From SSE Stream

### The Gap

When a user sends `model: "quantlab-auto"`, they don't know which model serves the request until the `done` chunk arrives with `meta.actualModel`. For expensive reasoning-tier requests (3+ seconds to first token), the user sees a blank chat with no indication of what's happening. The response headers `X-QIC-Actual-Model` and `X-QIC-Routing-Tier` are only available after the first chunk arrives -- they don't help during the wait.

### Fix Required in Plan

Add a `routing` event as the first SSE chunk before content streaming begins:

```
data: {"type":"routing","actualModel":"claude-sonnet-4-20250514","tier":"coding","estimatedTtft":1200}

data: {"type":"text","text":"Let me "}
...
```

The `QuantlabCloudAdapter` consumes the `routing` chunk internally (does not pass it through as a `StreamChunk`). Instead, it emits a provider metadata event that the UI can use to show "Using Claude Sonnet 4 (coding tier)..." immediately. The `estimatedTtft` (optional) allows the extension to show a meaningful progress indicator.

This is a server-only SSE protocol addition. No changes to the canonical `StreamChunk` type -- the adapter strips this chunk before yielding to the Gateway.

---

## MEDIUM-15: Extension-Server Version Compatibility Contract

### The Gap

The plan defines `X-QIC-Extension-Version` in the request header but specifies no behavior for version mismatches. If the server adds a required field, StreamChunk gains a new type value the extension doesn't understand, or the server deprecates an endpoint -- behavior is undefined.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Compatibility contract:**
- Server MUST accept requests from extensions up to 2 major versions behind
- Server MUST NOT add required fields to `GatewayRequest` without a major version bump
- New `StreamChunk` type values are ignored by older extensions (forward-compatible by design -- the adapter's switch falls through to a no-op default)
- If extension version is too old (>2 major versions behind), server returns HTTP 426 (Upgrade Required) with body `{ "error": { "code": "QIC-UPGRADE", "message": "Please update Quantlab", "minVersion": "2.0.0" } }`. The adapter displays an "Update Required" notification with a marketplace link.

---

## MEDIUM-16: Health Check Levels Undefined

### The Gap

The `/v1/health` endpoint returns per-provider status but doesn't define what "healthy" means. For Kubernetes probes and load balancer configuration, the distinction between liveness, readiness, and detailed health matters.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Health check levels:**

| Endpoint | Purpose | What it checks | Used by |
|----------|---------|---------------|---------|
| `GET /v1/health/live` | Liveness | HTTP server is responsive | K8s liveness probe |
| `GET /v1/health/ready` | Readiness | At least one provider authenticated and responding | K8s readiness probe, load balancer |
| `GET /v1/health` | Detailed | Sends minimal test to each provider, measures latency | Monitoring, status page |

Detailed health returns per-provider status: `healthy` (responds <2s), `degraded` (responds but >2s), `unhealthy` (auth failure or no response). Readiness returns 503 if no providers are available (pulls pod from load balancer rotation).

---

## MEDIUM-17: Lane-Specific Rate Limiting

### The Gap

The plan defines rate limits per plan tier (Free: 30/min, Pro: 200/min) but does not differentiate by lane. The completion lane fires on every keystroke (debounced). At Pro's 200/min, fast typing with inline completions could exhaust the rate limit within a minute, blocking all other lanes (chat, repair).

### Fix Required in Plan

Add to `05-authentication-and-billing.md`:

**Lane-aware rate limiting:**

| Lane Group | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| Completion (high-frequency) | 20/min | 120/min | Custom |
| Chat/Agent (chat-ask, chat-plan, chat-act, chat-gather, repair) | 10/min | 60/min | Custom |
| Background (fast-apply, summarize) | 5/min | 30/min | Custom |

Each group has its own rate limit bucket. Completion requests never starve chat requests.

**Server-side completion deduplication:** If a new completion request arrives while the previous one for the same session is still streaming, cancel the previous upstream request. The user only sees the latest result. This reduces provider costs without visible impact.

---

## MEDIUM-18: Token Count Discrepancy Between Client and Server

### The Gap

Context assembly is client-side -- the extension's `ContextAssembler` allocates token budgets using approximate tokenizers. Server-side billing uses actual token counts from provider responses. These will differ, sometimes significantly. The extension's quota display ("7.2M / 10M tokens used") will drift from actual billing.

### Fix Required in Plan

Add to `02-api-contract.md`:

The `done` chunk's `meta.quotaRemaining` is the **authoritative** usage figure. The extension's token estimation is used only for pre-request cost prediction (advisory, not authoritative).

Add to `01-extension-integration.md`: The `QuantlabCloudAdapter` emits a `quota-updated` event after each response using `meta.quotaRemaining`. The UI service consumes this event to update the status bar display and quota warnings.

---

## MEDIUM-19: Model Pinning for Enterprise Users

### The Gap

When the server upgrades from `claude-sonnet-4-20250514` to a newer version, `quantlab-auto` silently changes behavior. Enterprise quant users running production backtesting workflows need deterministic model behavior across sessions.

### Fix Required in Plan

Add to `02-api-contract.md`:

**Model pinning:** The `model` field accepts either aliases (`quantlab-auto`, `quantlab-fast`) or pinned model IDs (`claude-sonnet-4-20250514`). If a pinned ID is sent, the server routes directly to that model (subject to availability and plan tier). If the model is deprecated, return `QIC-MODEL-DEPRECATED` with a suggested replacement.

Add to `05-authentication-and-billing.md`: Enterprise plans include a `modelPolicy` setting: `"auto"` (default) or `"pinned"` (admin-configured model version per tier). Pinned policies prevent surprise model changes during critical workflows.

---

## MEDIUM-20: Stripe Webhook Signature Verification

### The Gap

The billing section describes webhook handlers for `subscription.created`, `invoice.paid`, `invoice.payment_failed` but doesn't mention verifying the `stripe-signature` header. Without verification, anyone who discovers the webhook URL can POST fabricated payment events to grant themselves Pro access.

### Fix Required in Plan

Add to `05-authentication-and-billing.md`, Billing Integration section:

**Webhook security:** All Stripe webhook handlers MUST verify the `stripe-signature` header using `stripe.webhooks.constructEvent(payload, sig, endpointSecret)` before processing any event. Unverified events return 400 and are logged as security incidents. The webhook endpoint secret is stored as an environment variable, never in source code.

Add to Phase 4 acceptance criteria in `06-implementation-phases.md`: a test that sends a request with an invalid signature and verifies rejection.
