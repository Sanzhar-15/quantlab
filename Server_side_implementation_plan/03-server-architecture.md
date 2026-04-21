# Server Architecture

## High-Level Components

```
                          Load Balancer (CloudFlare / AWS ALB)
                                    |
                    +---------------+---------------+
                    |                               |
            +-------v--------+             +--------v-------+
            |   API Gateway  |             |  Auth Service  |
            | (request       |             | (OAuth2, JWT   |
            |  routing,      |             |  validation)   |
            |  auth check,   |             |                |
            |  rate limit)   |             +--------+-------+
            +-------+--------+                      |
                    |                               |
            +-------v--------+             +--------v-------+
            | Request Router |             | Account/Billing|
            | (classifies    |             | Service        |
            |  complexity,   |             | (Stripe, usage |
            |  selects tier) |             |  tracking)     |
            +-------+--------+             +----------------+
                    |
         +----------+----------+
         |          |          |
   +-----v--+  +---v----+  +--v-------+
   | Fast   |  | Coding |  | Reasoning|
   | Tier   |  | Tier   |  | Tier     |
   | (Haiku,|  | (Sonnet|  | (Opus,   |
   |  GPT4o |  |  GPT4o)|  |  o1)     |
   |  mini) |  |        |  |          |
   +-----+--+  +---+----+  +--+-------+
         |          |          |
   +-----v----------v----------v-------+
   |        Provider Multiplexer       |
   | (Anthropic, OpenAI, Google APIs)  |
   +-----------------------------------+
```

---

## Component Details

### 1. API Gateway

**Responsibilities:**
- TLS termination
- JWT validation (fast path: verify signature + expiry, no DB call)
- Request rate limiting (per-user, per-plan, per-lane-group)
- Request logging and metrics
- CORS and security headers
- Request routing to internal services
- Request body size enforcement (2MB max)

**Implementation:** This can be a standard API gateway (Kong, AWS API Gateway) or a lightweight custom proxy. The key requirement is low-latency passthrough for streaming -- the gateway must support SSE proxying without buffering.

**Latency budget:** The gateway adds one network hop. Target: <5ms overhead for the gateway layer itself.

### 2. Request Router

The "product-level Mixture of Experts." Classifies each incoming request and routes to the appropriate model tier.

**Routing signals (available without reading message content):**

| Signal | Source | Weight |
|--------|--------|--------|
| Lane name | `request.lane` | High -- `completion` always goes to fast tier, `chat-act` may need reasoning tier |
| Tool count | `request.tools.length` | Medium -- many tools = complex task |
| Message count | `request.messages.length` | Medium -- long conversations = more context needed |
| Token estimate | rough count of message tokens | Medium -- high token requests need capable models |
| Priority | `request.priority` | Low -- `critical` gets the best model |
| User plan | from auth context | Constraint -- free tier may not access reasoning |

**Routing signals (content-aware, Phase 3+):**

| Signal | Source | Weight |
|--------|--------|--------|
| Keyword detection | System prompt / last user message | Medium -- "debug", "architecture", "refactor" suggest reasoning |
| Code complexity | Static analysis of code in messages | Medium -- complex algorithms need reasoning tier |
| Domain detection | Quant-specific keywords | Medium -- "backtest", "portfolio", "risk model" trigger quant-specialized models |

**Phase 1 routing (simple, no ML):**
```python
def route(request):
    lane = request.lane
    if lane in ('completion', 'fast-apply', 'summarize'):
        return 'fast-tier'
    if lane in ('chat-ask', 'chat-gather', 'repair'):
        return 'coding-tier'
    if lane in ('chat-plan', 'chat-act'):
        # check complexity heuristic
        if request.tools and len(request.tools) > 10:
            return 'reasoning-tier'
        return 'coding-tier'
    return 'coding-tier'
```

**Phase 3 routing (ML-based):**
A small classifier model (fine-tuned from interaction data) that takes the request metadata + first 500 tokens of the last user message and outputs a routing decision. Trained on the feedback loop: when a request to the coding tier gets a low user rating, the classifier learns to route similar requests to the reasoning tier.

### 3. Model Tiers

**Fast Tier:**
- Models: Claude 3.5 Haiku, GPT-4o-mini
- Use: Completions, fast-apply, summarize
- Latency target: <500ms time-to-first-token
- Cost: ~$0.25-0.80 per million tokens

**Coding Tier:**
- Models: Claude Sonnet 4, GPT-4o
- Use: Chat, code generation, explanations, repairs
- Latency target: <1.5s time-to-first-token
- Cost: ~$3-10 per million tokens

**Reasoning Tier:**
- Models: Claude Opus 4.5, o1/o3
- Use: Complex multi-step tasks, architecture decisions, deep debugging
- Latency target: <3s time-to-first-token
- Cost: ~$15-75 per million tokens
- Access: Pro and Enterprise plans only

### 4. Provider Multiplexer

Manages connections to upstream LLM providers.

**Responsibilities:**
- Connection pooling (persistent HTTP/2 connections to each provider)
- Format translation (QIC canonical -> provider native -> QIC canonical)
- Provider-specific retry and error handling
- Failover: if Anthropic is down, route Sonnet-class requests to GPT-4o
- Cost tracking per provider per user

**Provider accounts:**
- Anthropic: Enterprise API tier with zero data retention
- OpenAI: Enterprise API with zero data retention
- Google: Vertex AI with data processing agreement
- Fireworks/Together: For fine-tuned model hosting (Phase 5+)

**Key design:** The provider multiplexer reuses the same format translation logic that the extension-side adapters already implement. In fact, the server-side Anthropic/OpenAI clients can share code with the extension adapters (or be direct ports). The `StreamingResponseHandler` class with its `parseSSEStream()` method works identically server-side.

### 5. Authentication Service

**Components:**
- OAuth2 authorization server (or delegate to Auth0/Clerk for faster MVP)
- JWT issuer (RS256 signed, short-lived access tokens)
- Refresh token store (Redis or PostgreSQL)
- Session management

**JWT claims:**
```json
{
    "sub": "user-abc123",
    "plan": "pro",
    "scopes": ["qic:inference", "qic:usage"],
    "iat": 1706832000,
    "exp": 1706832900,
    "iss": "accounts.quantlab.dev"
}
```

**Note:** `email` is intentionally excluded from JWT claims. Putting PII in every request header, every access log, and every monitoring tool is problematic for privacy-conscious quant fund users. Use only `sub` (user ID) for request-level identity. Email is available via `GET /v1/account/info` when needed for display.

The API gateway validates JWTs without calling the auth service (signature verification only). Plan tier and scopes are embedded in the token.

**JWT plan tier staleness (HIGH-12):** When a user upgrades via Stripe, the webhook updates the database, but the active JWT still says `"plan": "free"` until the next token refresh (up to 15 minutes). Fix: for plan-sensitive routing decisions (reasoning tier access), the request router checks plan tier from Redis (updated immediately by the Stripe webhook), not from the JWT alone. The JWT's plan claim is a fast-path optimization: if the JWT says "pro," trust it; if the JWT says "free," check Redis for a recent upgrade before rejecting.

### 6. Account & Billing Service

**Usage tracking:**
- Every request is metered: input tokens, output tokens, model tier, lane
- Usage aggregated per user per billing period
- Stored in PostgreSQL with ClickHouse/TimescaleDB for analytics queries

**Plan enforcement:**
- Monthly token budgets checked pre-request
- Rate limits (requests/minute, per lane group) enforced at the API gateway
- Feature gates (reasoning tier) checked at the router
- Daily request budgets checked

**Billing integration:**
- Stripe for subscription management and payment processing
- Webhooks for plan changes, payment failures, cancellations
- Usage-based overage billing for Enterprise plans

---

## Request Cancellation (HIGH-6)

### Client-Side

The `QuantlabCloudAdapter` stores an `AbortController` per active request. `cancelRequest(requestId)` calls `abort()`, which closes the HTTP connection.

### Server-Side

The server MUST detect client disconnect within 500ms and abort the upstream provider request. In Go:
- Propagate `context.Context` cancellation from the client HTTP connection through to the upstream `http.NewRequestWithContext()`
- Select on both the upstream response stream and the client context's `Done()` channel
- On client disconnect: cancel upstream context, close provider connection

Tokens already generated by the provider before cancellation are billed to the user's quota -- the provider charges for them regardless. The server sends a best-effort `done` chunk with `stopReason: "cancelled"` before closing the stream.

---

## Prompt Caching Strategy (HIGH-8)

### How Prompt Caching Works (Anthropic)

- Mark the system prompt with `cache_control: { type: "ephemeral" }`
- On subsequent requests with the same prefix, Anthropic serves from cache (~$0.30/MTok instead of $3/MTok for Sonnet)
- Cache TTL: 5 minutes (refreshed on each use)

### Server-Side Cache Management

- The server groups requests by `sessionId` + `lane`
- Within a session/lane, the system prompt is typically identical across requests
- The server adds `cache_control` markers to the system prompt and the first N context messages
- Cache hit ratio target: >80% for multi-turn conversations

**Extension-side requirement:** None. The extension sends the same canonical request format. The server handles cache marker injection transparently.

**Cost impact:** For a typical `chat-act` session (10 exchanges, 50K tokens system+context, 5K tokens per exchange), prompt caching reduces input costs by ~70%.

---

## Abuse Prevention (HIGH-4)

### Pre-Authentication

- Rate limit the sign-up endpoint: 5 accounts per IP per hour
- Email verification required before first inference request
- Block disposable email domains (mailinator, guerrillamail, etc.)
- CAPTCHA on sign-up (hCaptcha or Turnstile, not reCAPTCHA -- quant users value privacy)

### Post-Authentication

- Hard rate limit on free tier: 30 requests/minute (enforce strictly, per lane group)
- Anomaly detection: flag accounts that hit rate limits consistently
- Automated suspension for accounts exceeding 3x their token budget (accounting for estimation errors)
- Device fingerprinting: limit free accounts to N per device (via extension telemetry)

### Progressive Trust

New free accounts start with 100K tokens/month, graduating to 500K after 30 days of legitimate usage patterns (diverse lane usage, reasonable request frequency, non-trivial prompts). Accounts flagged for anomalous behavior (identical prompts across accounts, API-like request patterns) are throttled to 50K/month pending review.

Consider requiring a GitHub or LinkedIn account with >1 year of age as a low-friction verification step -- high friction for bot accounts, low friction for real developers.

### Cost Protection

- Global spending alert: if total provider costs exceed 2x projected for the day, throttle free tier
- Provider-specific circuit breakers: if a single provider's costs spike, route free-tier traffic to cheaper alternatives

---

## Observability (HIGH-5)

### Distributed Tracing

- Every request gets a trace ID (`X-QIC-Request-ID`) generated at the API gateway
- Trace ID propagated through all internal services and to upstream providers
- Trace storage: Jaeger or Grafana Tempo
- The extension sends the trace ID so server logs can be correlated with client-side events

### Metrics (Prometheus/Grafana)

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

### Logging

- Structured JSON logs (not free-text)
- Log levels: ERROR (failures), WARN (degradation), INFO (request metadata), DEBUG (development only)
- No code content in logs (privacy) -- only metadata, timing, token counts
- Log aggregation: Loki or CloudWatch Logs
- Retention: 30 days for INFO, 90 days for ERROR/WARN

### Alerting

- PagerDuty/OpsGenie integration
- Tiered alerts: WARNING (Slack notification), CRITICAL (page on-call)
- Runbook links in every alert

---

## Infrastructure

### Language Decision Framework (LOW-11)

The plan recommends Go for the server hot path. Decision depends on team:

- If team includes Go engineers: Go from Phase 2
- If team is primarily TypeScript: Node.js/TypeScript for Phase 2-3, rewrite hot path to Go when latency profiling shows Node overhead exceeds 5ms at target concurrency
- The Provider Multiplexer's format translation logic (Anthropic/OpenAI native <-> QIC canonical) already exists in TypeScript. Server-side Node.js can share this code directly.

### Recommended Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| API Gateway | Custom Go service or Caddy | Low latency, native SSE support, easy to deploy |
| Request Router | Go or Python | Go for production speed, Python for ML inference in Phase 3 |
| Provider Multiplexer | Go | High concurrency, connection pooling, streaming |
| Auth Service | Auth0 or Clerk (managed) for MVP, custom for scale | Faster time to market |
| Database | PostgreSQL | Users, plans, sessions, audit logs |
| Cache | Redis | Rate limiting, session cache, JWT blacklist, plan tier override |
| Analytics | ClickHouse | High-volume usage data, fast aggregation queries |
| Message Queue | NATS or Kafka | Async telemetry processing, billing events |
| Object Store | S3 | Telemetry data, training datasets, model artifacts |
| Deployment | Kubernetes on AWS (EKS) | Standard, scalable, multi-region capable |

### Why Go for the Core Proxy

The critical path is: receive request -> validate JWT -> route -> forward to provider -> stream response back. This is I/O-bound work where Go excels:
- Native HTTP/2 and SSE support
- Goroutines handle thousands of concurrent streaming connections efficiently
- Low memory footprint per connection
- Fast startup (matters for autoscaling)

Python is fine for the ML-based router (Phase 3) as a separate microservice, but the hot path should not have Python in it.

### Multi-Region Deployment

**Phase 2-3:** Single region (us-east-1). This is sufficient for hundreds of users.

**Phase 4:** Add eu-west-1 (Ireland) when billing starts and European quant funds (a primary target market) need low latency for paid usage.

**Phase 4+:** Add ap-northeast-1 (Tokyo) only with a signed enterprise contract from an Asian fund.

DNS-based routing (CloudFlare, Route 53) directs users to the nearest region. Each region maintains its own connection pools to providers (Anthropic, OpenAI, Google all have multi-region endpoints).

### Scaling Strategy

```
                            +---------+
User requests/sec           | 10      | MVP launch
                            | 100     | Early adoption
                            | 1,000   | Growth
                            | 10,000  | Scale
                            +---------+

API Gateway:       2 instances per region (autoscale 2-20)
Request Router:    1 instance per region (autoscale 1-10)
Provider Proxy:    3 instances per region (autoscale 3-30)
Auth Service:      Managed (Auth0) or 2 instances
Database:          RDS Multi-AZ with read replicas
Redis:             ElastiCache cluster (3 nodes)
```

The bottleneck is always the upstream provider rate limits, not our infrastructure. The server should handle 10x more concurrent requests than the providers can serve, so the queue stays on our side (with proper backpressure).

---

## Graceful Shutdown (HIGH-15)

SSE connections are long-lived -- a reasoning-tier response may stream for 30+ seconds including extended thinking time. The default `terminationGracePeriodSeconds` (30s) is too short. Every deployment causes dropped responses for some users.

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

---

## Infrastructure-as-Code (MEDIUM-8)

### Repository Structure

```
quantlab-server/
  infra/
    terraform/
      modules/
        networking/     # VPC, subnets, security groups
        compute/        # EKS cluster, node groups
        database/       # RDS, ElastiCache
        storage/        # S3 buckets
        monitoring/     # CloudWatch, Grafana
      environments/
        staging/
        production/
    k8s/
      base/             # Kustomize base manifests
        api-gateway/
        provider-proxy/
        auth-service/
      overlays/
        staging/
        production/
  services/
    api-gateway/        # Go service
    provider-proxy/     # Go service
    billing-worker/     # Background job processor
  .github/
    workflows/
      ci.yml            # Lint, test, build
      deploy-staging.yml
      deploy-production.yml
```

### CI/CD Pipeline

1. PR -> lint + unit tests + integration tests (GitHub Actions)
2. Merge to `main` -> build container images, push to ECR, deploy to staging
3. Manual approval -> deploy to production (canary: 10% traffic for 30 min, then full)
4. Rollback: `kubectl rollout undo` or Terraform state revert

---

## Disaster Recovery (MEDIUM-9)

| Scenario | Recovery Procedure | RTO | RPO |
|----------|-------------------|-----|-----|
| Single pod crash | Kubernetes auto-restart | <30s | 0 (stateless) |
| Single region outage | DNS failover to secondary region | <5min | 0 |
| Database corruption | Restore from automated daily RDS snapshots | <1hr | <24hr |
| Redis failure | ElastiCache auto-failover to replica | <30s | <1s |
| Provider API key revoked | Rotate key in secrets manager, restart pods | <15min | 0 |
| Data breach | Incident response plan activation (see below) | - | - |
| Full infrastructure compromise | Terraform destroy + recreate from code | <4hr | <24hr |

**Incident response plan (outline):**
1. Detection (monitoring alerts)
2. Containment (revoke compromised credentials, isolate affected services)
3. Assessment (scope of impact, data affected)
4. Notification (users, regulators if applicable)
5. Recovery (restore from clean state)
6. Post-mortem (root cause, preventive measures)

---

## Streaming Architecture

### The Critical Path: Time-to-First-Token

Users perceive responsiveness through time-to-first-token (TTFT). Every millisecond of proxy overhead is felt directly.

**Optimization targets:**
1. No buffering at any layer (gateway, proxy, CDN)
2. Connection reuse to providers (HTTP/2 with persistent connections)
3. JWT validation without DB calls (signature check only)
4. Rate limit checks in Redis (sub-millisecond)
5. Pre-warmed connection pools

**SSE proxying:**
The server reads chunks from the upstream provider and immediately writes them to the client connection. No accumulation, no post-processing. The `routing` chunk is the only server-originated event, sent before proxying begins. The `meta` field on the `done` chunk is injected server-side.

```
Client <--SSE-- Server <--SSE-- Anthropic
      routing          (generated)
        chunk1          chunk1
        chunk2          chunk2
        chunk3          chunk3
        done+meta       done
```

### Connection Lifecycle

```
1. Client opens HTTPS connection to server
2. Server validates JWT (in-memory, <1ms)
3. Server checks rate limits (Redis, <2ms)
4. Server classifies request (router, <5ms for heuristic, <50ms for ML)
5. Server opens/reuses connection to provider
6. Server forwards request body (with cache_control markers injected)
7. Provider streams back chunks
8. Server pipes chunks to client (zero-copy where possible)
9. On stream end: log usage, update billing counters (async)
```

Total added latency: <10ms for steps 2-4. Steps 7-8 add zero latency (pipe-through).

---

## Security

### Data in Transit
- TLS 1.3 everywhere (client->server, server->providers)
- Certificate pinning optional for enterprise clients

### Data at Rest
- User credentials: Argon2id hashed
- Refresh tokens: encrypted at rest in database
- Usage logs: encrypted at rest (AWS KMS)
- Code content: NOT stored by default (pass-through only)
- Telemetry data (opt-in): encrypted, access-controlled, retention policy

### Provider Data Agreements
- Enterprise API tiers with all providers
- Zero data retention agreements (ZDR) -- providers do not train on our users' data
- Audit logs for all provider API calls

### Compliance
- SOC 2 Type II (required for enterprise quant fund customers)
- GDPR compliance for EU users (data residency in EU region)
- No code content stored without explicit consent
