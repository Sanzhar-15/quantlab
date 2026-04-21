# API Contract: Extension <-> Quantlab Server

## Design Principle

The server speaks QIC's canonical types natively. No format translation at the adapter layer. The extension serializes `GatewayRequest`, the server returns `StreamChunk` events. All the complexity (model routing, prompt optimization, provider format translation) lives server-side.

---

## Endpoints

### POST /v1/qic/stream

Primary inference endpoint. Streaming via Server-Sent Events.

**Request:**
```
POST /v1/qic/stream
Authorization: Bearer <jwt_access_token>
Content-Type: application/json
Content-Encoding: gzip
X-QIC-Extension-Version: 1.108.0
X-QIC-Request-ID: <uuid>
X-QIC-Idempotency-Key: <uuid>

{
    "model": "quantlab-auto",
    "messages": [
        { "role": "system", "content": "..." },
        { "role": "user", "content": "..." },
        { "role": "assistant", "content": [
            { "type": "text", "text": "..." },
            { "type": "tool_use", "id": "tc1", "name": "read_file", "input": {"path": "..."} }
        ]},
        ...
    ],
    "tools": [
        { "name": "read_file", "description": "...", "parameters": {...} },
        ...
    ],
    "lane": "chat-act",
    "priority": "normal",
    "sessionId": "sess-abc123",
    "maxTokens": 32768,
    "temperature": 0.2
}
```

The request body is QIC's `GatewayRequest` type serialized as JSON. The `lane`, `priority`, and `sessionId` fields are sent by contract (see `GatewayMetadata` in `01-extension-integration.md`). The server uses them for routing and billing.

**Response (SSE stream):**
```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Content-Encoding: gzip
Cache-Control: no-cache
X-QIC-Request-ID: <same uuid echoed>
X-QIC-Actual-Model: claude-sonnet-4-20250514
X-QIC-Routing-Tier: coding

data: {"type":"routing","actualModel":"claude-sonnet-4-20250514","tier":"coding","estimatedTtft":1200}

data: {"type":"text","text":"Let me "}

data: {"type":"text","text":"read that file."}

data: {"type":"tool_call_start","id":"tc1","name":"read_file"}

data: {"type":"tool_call_delta","id":"tc1","argumentsDelta":"{\"path\":"}

data: {"type":"tool_call_delta","id":"tc1","argumentsDelta":"\"/src/main.ts\"}"}

data: {"type":"tool_call_end","id":"tc1"}

data: {"type":"done","usage":{"inputTokens":1234,"outputTokens":567},"stopReason":"tool_use","meta":{"actualModel":"claude-sonnet-4-20250514","routingTier":"coding","quotaRemaining":{"tokens":45000,"requests":120}}}
```

**Routing event (first chunk):** The server sends a `routing` event before content streaming begins. The adapter consumes this internally (does NOT pass through as a `StreamChunk`) and emits a UI-facing metadata event showing "Using Claude Sonnet 4 (coding tier)..." immediately. The `estimatedTtft` (optional) enables the extension to show a progress indicator.

**Done chunk `meta` field:** The adapter maps `meta` -> `providerMeta` on the canonical `StreamChunk` `done` variant. `meta.quotaRemaining` is the **authoritative** usage figure (not the extension's local token estimates).

**Response headers:**
- `X-QIC-Actual-Model`: which model actually served the request (transparency)
- `X-QIC-Routing-Tier`: which routing tier was selected (fast/coding/reasoning)
- `X-QIC-Token-Refresh: required`: signals the extension to refresh its JWT (set on plan changes)

### POST /v1/qic/request

Non-streaming inference (used by `fast-apply`, `summarize` lanes).

**Request:** Same body as `/v1/qic/stream`.

**Response:**
```json
{
    "content": [
        { "type": "text", "text": "..." }
    ],
    "usage": { "inputTokens": 500, "outputTokens": 200 },
    "stopReason": "end_turn",
    "meta": {
        "actualModel": "claude-3-5-haiku-20241022",
        "routingTier": "fast",
        "quotaRemaining": { "tokens": 44500, "requests": 119 }
    }
}
```

Response body is QIC's `ProviderResponse` plus the `meta` field.

---

## Idempotency (MEDIUM-3)

The extension's Gateway has `withRetry()` that retries on 429/500/502/503/529. Without idempotency, a request that succeeds at the provider but whose response is lost (network interruption) gets double-billed on retry.

**Header:**
```
X-QIC-Idempotency-Key: <uuid>
```

The extension generates a UUID per logical request (not per retry attempt). Behavior differs by endpoint:

**Non-streaming (`/v1/qic/request`):**
1. On first receipt: process normally, cache the full response keyed by idempotency key (Redis, 5 min TTL)
2. On duplicate receipt: return the cached response without forwarding to the provider
3. Usage is metered only once per idempotency key

**Streaming (`/v1/qic/stream`):**
Caching full SSE streams (potentially megabytes) in Redis is impractical. Instead:
1. On first receipt: `SET NX` the idempotency key with status `"processing"`. Process normally.
2. On stream completion: update key to `"completed"` with usage metadata (token counts, billing info).
3. On duplicate receipt while `"processing"`: return `409 Conflict` with `{"error":{"code":"QIC-P008","message":"Request already in progress"}}`. The client should wait and not retry.
4. On duplicate receipt after `"completed"`: return `200` with a non-streaming response containing the usage metadata (the client knows the original stream already delivered content). Usage is NOT double-metered.
5. Key TTL: 5 minutes after completion.

Implementation: Redis `SET NX` on the idempotency key.

The `QuantlabCloudAdapter` sends the same key for all retry attempts:
```typescript
const idempotencyKey = randomUUID();
headers['X-QIC-Idempotency-Key'] = idempotencyKey;
// Same key used for all retry attempts of this request
```

---

## Request & Response Compression (MEDIUM-4)

A `chat-act` request with 200K tokens of context can be 800KB+ of JSON. Compression is mandatory.

**Request compression:** The extension sends `Content-Encoding: gzip` and compresses the request body. The server accepts `gzip` and `br` (Brotli) encoded requests.

**Response compression:** Standard `Accept-Encoding: gzip, br` negotiation. SSE streams are gzip-compressed.

**Impact:** Typical request compression ratio is 5-10x for JSON. An 800KB context window compresses to ~100KB. SSE text chunks compress ~3-5x.

**Implementation note:** Node.js `fetch` (used by the extension in the Electron renderer) supports compressed responses natively. For request compression, the adapter manually compresses the body using `CompressionStream` or a polyfill.

---

## Request Size Limits (MEDIUM-5)

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max request body | 2MB | 200K tokens at ~4 chars/token = ~800KB, plus tool definitions, JSON overhead. 2MB provides headroom. |
| Max messages array length | 500 | Prevent pathological conversations |
| Max tool definitions | 50 | Current max is 22 (with 3 disabled). Headroom for growth. |
| Max streaming response duration | 300s | Prevent zombie streams |

Requests exceeding limits return 413 (Payload Too Large) with a clear error message.

---

## Tool Definition Bandwidth Optimization (HIGH-9)

Every `GatewayRequest` includes `tools: ToolDefinition[]` -- all active tool definitions with full JSON schemas. This is approximately 8-12KB per request. For the `completion` lane (high frequency, small payloads), tool overhead can exceed the actual message content.

**Phase 2: Compression (immediate).** Enable gzip/brotli compression on all request/response bodies. Reduces the 10KB tool payload to ~1-2KB.

**Phase 3: Tool schema hashing (optimization).** First request in a session sends full tool definitions plus a hash:
```json
{
    "tools": [...],
    "toolsHash": "sha256:abc123..."
}
```

Subsequent requests in the same session send only the hash:
```json
{
    "toolsHash": "sha256:abc123..."
}
```

The server caches tool definitions by hash. If the hash is unknown, it returns 400 asking for full definitions.

---

## Streaming Fault Tolerance (HIGH-3)

### Server-Side

- If the upstream provider stream drops, the server sends an `{"type":"error","error":{"code":"QIC-P004","message":"Upstream provider stream interrupted"}}` chunk followed by stream close.
- The server does NOT retry mid-stream (partial responses cannot be replayed). The client must decide whether to retry from scratch.

### Client-Side (QuantlabCloudAdapter)

- On stream error: yield the error chunk to the orchestrator (existing `case 'error': throw chunk.error` in `processStreamChunk()` handles this).
- On network disconnect mid-stream: the `fetch` rejects, which propagates as an error to the `for await` loop.
- The orchestrator's existing error handling (transition to idle, show error) applies.

### Partial Responses

If the model streamed 500 tokens of text before the error, those tokens were already displayed to the user via `streamChatToken()`. On retry, the user sees the response start over from scratch. This is the same behavior as Cursor and GitHub Copilot -- no one does mid-stream resume for LLM inference.

---

## Authentication Endpoints

### POST /v1/auth/token

Exchange authorization code for tokens (OAuth2 token endpoint).

```
POST /v1/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=<auth_code>&
code_verifier=<pkce_verifier>&
client_id=qic-vscode&
redirect_uri=vscode://quantlab.qic/auth/callback
```

Response:
```json
{
    "access_token": "<jwt>",
    "refresh_token": "<opaque>",
    "expires_in": 900,
    "token_type": "Bearer",
    "scope": "qic:inference qic:usage"
}
```

### POST /v1/auth/refresh

Refresh an expired access token.

```
POST /v1/auth/refresh
Content-Type: application/json

{ "refresh_token": "<opaque>" }
```

Response: Same shape as token endpoint.

### POST /v1/auth/revoke

Sign out / revoke tokens.

```
POST /v1/auth/revoke
Authorization: Bearer <jwt>
Content-Type: application/json

{ "refresh_token": "<opaque>" }
```

---

## Account & Usage Endpoints

### GET /v1/account/info

Returns account details and current plan.

```json
{
    "id": "user-abc",
    "plan": {
        "tier": "pro",
        "tokensPerMonth": 10000000,
        "rateLimit": {
            "requestsPerMinute": 200,
            "requestsPerDay": 5000
        },
        "features": ["reasoning-tier", "priority-queue"]
    },
    "usage": {
        "currentPeriod": {
            "tokensUsed": 1234567,
            "requestsMade": 456,
            "periodStart": "2026-02-01T00:00:00Z",
            "periodEnd": "2026-03-01T00:00:00Z"
        }
    },
    "features": {
        "cloud_enabled": true,
        "reasoning_tier": true,
        "data_contribution": false,
        "websocket_streaming": false
    }
}
```

**Note:** `email` is intentionally excluded from this response and from JWT claims. Use only `id` (user ID) for request-level identity. Email is available via a separate profile endpoint when needed for display.

**Feature flags:** The `features` object contains server-provided feature flags. The extension caches these locally (for offline use) and refreshes them on each token refresh (every 15 min).

### GET /v1/account/usage

Detailed usage breakdown by lane and day. Supports pagination.

```
GET /v1/account/usage?from=2026-01-01&to=2026-02-01&limit=30&offset=0
```

```json
{
    "daily": [
        {
            "date": "2026-02-02",
            "byLane": {
                "chat-act": { "tokens": 50000, "requests": 15 },
                "completion": { "tokens": 10000, "requests": 200 },
                "chat-ask": { "tokens": 8000, "requests": 10 }
            },
            "totalTokens": 68000,
            "totalRequests": 225
        }
    ],
    "pagination": {
        "total": 45,
        "limit": 30,
        "offset": 0,
        "hasMore": true
    }
}
```

### GET /v1/models

Available models for the user's plan tier. Accepts pinned model IDs.

```json
{
    "models": [
        {
            "id": "quantlab-auto",
            "description": "Automatic model selection based on request complexity",
            "tiers": ["free", "pro", "enterprise"]
        },
        {
            "id": "quantlab-fast",
            "description": "Fast model for completions and simple edits",
            "tiers": ["free", "pro", "enterprise"]
        },
        {
            "id": "quantlab-reason",
            "description": "Reasoning model for complex multi-step tasks",
            "tiers": ["pro", "enterprise"]
        }
    ]
}
```

**Model pinning (MEDIUM-19):** The `model` field in requests accepts either aliases (`quantlab-auto`, `quantlab-fast`) or pinned model IDs (`claude-sonnet-4-20250514`). If a pinned ID is sent, the server routes directly to that model (subject to availability and plan tier). If the model is deprecated, return `QIC-MODEL-DEPRECATED` with a suggested replacement.

---

## Health & Status

### GET /v1/health/live

Liveness probe. Checks only that the HTTP server is responsive.

**Used by:** Kubernetes liveness probe.

```json
{ "status": "ok" }
```

### GET /v1/health/ready

Readiness probe. Checks that at least one provider is authenticated and responding.

**Used by:** Kubernetes readiness probe, load balancer.

Returns 200 if ready, 503 if no providers are available (pulls pod from load balancer rotation).

```json
{
    "status": "ready",
    "maintenance": false
}
```

The `maintenance` flag is an emergency kill switch. When `true`, the extension shows "Quantlab Cloud is undergoing maintenance" and routes all traffic to BYOK/local.

### GET /v1/health

Detailed health check. Sends minimal test to each provider, measures latency. No auth required.

```json
{
    "status": "healthy",
    "version": "0.1.0",
    "providers": {
        "anthropic": { "status": "healthy", "latencyMs": 120 },
        "openai": { "status": "healthy", "latencyMs": 95 },
        "google": { "status": "degraded", "latencyMs": 3200 }
    }
}
```

Provider status values: `healthy` (responds <2s), `degraded` (responds but >2s), `unhealthy` (auth failure or no response).

Used by `QuantlabCloudAdapter.getHealth()` and `isAvailable()`.

---

## Error Responses

All errors follow a consistent format:

```json
{
    "error": {
        "code": "QIC-P005",
        "message": "Rate limit exceeded. Retry after 30 seconds.",
        "retryAfterMs": 30000
    }
}
```

HTTP status codes map to QIC error handling:

| HTTP Status | QIC Code | Meaning | Retryable | User Action |
|-------------|----------|---------|-----------|-------------|
| 400 | QIC-P004 | Bad request (malformed) | No | Fix request |
| 401 | QIC-P006 | Token expired/invalid | Yes (after refresh) | Re-authenticate |
| 403 | QIC-P007 | Plan limit / feature not available | No | Upgrade plan |
| 413 | QIC-P004 | Payload too large | No | Reduce request size |
| 426 | QIC-UPGRADE | Extension version too old | No | Update Quantlab |
| 429 | QIC-P005 | Rate limited | Yes (after delay) | Wait |
| 500 | QIC-P004 | Server error | Yes | Retry |
| 502 | QIC-P004 | Upstream provider error | Yes | Retry |
| 503 | QIC-P004 | Service unavailable | Yes | Retry |

The `QuantlabCloudAdapter.normalizeError()` method maps these to `QicError` instances with `httpStatus` set:
```typescript
if (status === 401) return new QicError('QIC-P006', 'Session expired. Please sign in again.', undefined, 401);
if (status === 403) return new QicError('QIC-P007', 'Feature requires Pro plan. Upgrade at quantlab.dev/pricing', undefined, 403);
```

---

## Version Compatibility Contract (MEDIUM-15)

- Server MUST accept requests from extensions up to 2 major versions behind
- Server MUST NOT add required fields to `GatewayRequest` without a major version bump
- New `StreamChunk` type values are ignored by older extensions (forward-compatible by design -- the adapter's switch falls through to a no-op default)
- If extension version is too old (>2 major versions behind), server returns HTTP 426 (Upgrade Required):
  ```json
  {
      "error": {
          "code": "QIC-UPGRADE",
          "message": "Please update Quantlab",
          "minVersion": "2.0.0"
      }
  }
  ```
  The adapter displays an "Update Required" notification with a marketplace link.

---

## Versioning

The API is versioned via URL path (`/v1/`). Breaking changes require a new version (`/v2/`). Non-breaking additions (new fields in responses, new optional request fields) are backwards-compatible within a version.

The extension sends `X-QIC-Extension-Version` so the server can apply version-specific behavior if needed.

---

## Rate Limiting

### Per-Plan Limits

Rate limiting has two dimensions:

| Dimension | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| Burst rate (requests/min) | 30 | 200 | Custom |
| Daily budget (requests/day) | 500 | 5,000 | Custom |

### Lane-Aware Buckets (MEDIUM-17)

Each lane group has its own rate limit bucket. Completion requests never starve chat requests:

| Lane Group | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| Completion (high-frequency) | 20/min | 120/min | Custom |
| Chat/Agent (chat-ask, chat-plan, chat-act, chat-gather, repair) | 10/min | 60/min | Custom |
| Background (fast-apply, summarize) | 5/min | 30/min | Custom |

**Server-side completion deduplication:** If a new completion request arrives while the previous one for the same session is still streaming, cancel the previous upstream request. The user only sees the latest result.

### Response Headers

Server-side rate limiting returns standard headers:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1706900000
Retry-After: 30
```

The extension's client-side `RateLimiter` respects these headers to avoid sending requests that will be rejected. The `QuantlabCloudAdapter` extracts rate limit headers from responses and exposes them for the Gateway to consume.

---

## Data Collection Headers (Opt-In)

For users who opt into data contribution, the extension sends interaction telemetry via a separate endpoint:

### POST /v1/telemetry/interaction

```json
{
    "sessionId": "...",
    "interactions": [
        {
            "requestId": "req-uuid-123",
            "type": "suggestion-accept",
            "lane": "completion",
            "timestamp": "...",
            "latencyMs": 450,
            "tokenCount": 120,
            "timeToDecisionMs": 2500
        },
        {
            "requestId": "req-uuid-456",
            "type": "suggestion-reject",
            "lane": "chat-act",
            "timestamp": "...",
            "editDistance": 0.7
        }
    ]
}
```

Each interaction includes a `requestId` linking to the original inference request for server-side log correlation.

This is batched and sent asynchronously. Never blocks inference requests. The extension collects events locally and flushes periodically (every 60s or on session end).

**Data tier filtering:** Only events permitted by the user's `DataTier` setting are included. `anonymous-metrics` sends metadata (timing, lane, accept/reject). `data-contributor` sends full context including code.
