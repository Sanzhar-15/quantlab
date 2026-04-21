# Implementation Phases

## Overview

Six phases, each building on the previous. Each phase produces a deployable, testable increment.

```
Phase 1: Extension + Auth           (extension-side only, no server yet)
Phase 2: Server MVP                 (single-provider proxy)
Phase 3: Multi-Provider Routing     (three-tier model system)
Phase 4: Billing & Subscriptions    (revenue-generating)
Phase 5: Data Pipeline              (flywheel begins -- split into 5a/5b/5c/5d)
Phase 6: Quant Specialization       (competitive moat)
```

---

## Phase 1: Extension-Side Foundation

**Goal:** Ship the `QuantlabCloudAdapter`, auth flow, settings changes, and structural prerequisites. At the end of this phase, the extension can authenticate with a Quantlab account and send requests to a server URL. The server doesn't exist yet -- we test against a mock.

### Deliverables

1. **ModelRegistry restructure** (CRITICAL-1, prerequisite for everything)
   - Change `LANE_MODEL_RECOMMENDATIONS` from `Record<string, string>` to `Record<LaneName, string[]>`
   - Rewrite `getAvailableModelForLane()` to iterate per-lane preference arrays
   - Add cloud model aliases: `cloud-default`, `cloud-fast`, `cloud-reason`
   - This must land first as it changes how all model resolution works

2. **Interface changes** (CRITICAL-2, MEDIUM-1)
   - Add `GatewayMetadata` interface to `canonical/interfaces.ts`
   - Widen `ProviderAdapter` method signatures with `Partial<GatewayMetadata>`
   - Extend `StreamChunk` `done` variant with optional `providerMeta`

3. **`QuantlabCloudAdapter`** (`common/gateway/providers/quantlabCloudAdapter.ts`)
   - Implements `ProviderAdapter`
   - Sends `GatewayRequest` JSON, receives SSE `StreamChunk` events
   - Consumes `routing` event, maps `meta` -> `providerMeta`
   - JWT authentication with auto-refresh + `X-QIC-Token-Refresh` handling
   - URL validation (HTTPS enforcement)
   - Error normalization with `redactErrorBody()`
   - Idempotency key generation (`X-QIC-Idempotency-Key`)
   - Request/response compression (gzip)
   - Health check via `GET /v1/health`
   - `cancelRequest()` implementation

4. **Authentication module** (`browser/auth/`)
   - `quantlabAuth.ts`: OAuth2 PKCE flow, token exchange, refresh
   - `uriHandler.ts`: VS Code URI handler for callback
   - Token storage in `SecretStorage`

5. **Settings updates** (`common/constants.ts`)
   - `qic.connectionMode`: `'cloud' | 'byok' | 'local'`
   - `qic.cloud.baseUrl`: server URL
   - `qic.dataTier`: `'private' | 'anonymous-metrics' | 'data-contributor'` (replaces boolean `TELEMETRY_ENABLED`)
   - `QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN` / `CLOUD_REFRESH_TOKEN`

6. **Contribution file changes** (`browser/qic.contribution.ts`)
   - Branching activation flow based on `connectionMode` (using `!== 'local'` guard)
   - Cloud + BYOK coexistence (BYOK as fallback in cloud mode)
   - Sign-in prompt when cloud mode but no token
   - Hot-swap on configuration change (reinitializeGateway)
   - DegradationManager hookup for cloud adapter state

7. **Egress updates** (`common/security/egressEnforcer.ts`)
   - Add `'quantlab-cloud'` to `EgressBoundary` type
   - Phase 2 MVP: treat cloud as `'llm'` boundary
   - Phase 4: provider-aware boundary via `getEgressBoundary()` in Gateway

8. **Quality signal instrumentation** (local-only, Phase 5 prerequisite)
   - Completion acceptance tracking via VS Code API hooks
   - Edit distance tracking (debounced 10s comparison)
   - Re-request detection (30s window)
   - Follow-up pattern tracking in orchestrator
   - Store locally in SQLite, never sent without consent

9. **New commands**
   - `qic.signIn`, `qic.signOut`, `qic.accountInfo`, `qic.switchConnectionMode`

10. **Status bar** showing active connection mode + degradation level

11. **Tests**
    - Mock server (Express/fastify) that speaks the QIC protocol
    - Unit tests for `QuantlabCloudAdapter`
    - Integration tests for auth flow (mocked authorization server)
    - Test mode that uses `http://localhost` (gated behind `qic.cloud.devMode`)

12. **Documentation**
    - Extension settings reference
    - Cloud vs BYOK comparison page

### How to Test Without a Server

Create a mock server in `test/integration/mockCloudServer.ts`:
```typescript
// Accepts QIC canonical requests, returns canned StreamChunk responses
// Sends routing event as first chunk
// Validates JWT tokens (using a test signing key)
// Simulates rate limiting, error responses, timeout scenarios
// Tests X-QIC-Token-Refresh header handling
```

Run it locally, set `qic.cloud.baseUrl = 'http://localhost:3001'` and `qic.cloud.devMode = true`.

### Feature Flag

```typescript
'qic.cloud.enabled': {
    type: 'boolean',
    default: false,  // Off during development, flipped to true at GA
    description: 'Enable Quantlab Cloud connection path.',
}
```

---

## Phase 2: Server MVP

**Goal:** A working server that authenticates users, forwards requests to Anthropic, and returns streaming responses. No billing yet -- all users have generous limits.

### Deliverables

1. **API Gateway service**
   - HTTPS termination
   - JWT validation
   - Request logging and metrics
   - Rate limiting (per-user, per-lane-group, hardcoded generous limits)
   - SSE streaming proxy (no buffering)
   - Request body size enforcement (2MB max)
   - `routing` event generation

2. **Provider proxy**
   - Anthropic adapter (reuse format translation from extension codebase)
   - Connection pooling to `api.anthropic.com`
   - Error handling and retry
   - Prompt cache marker injection
   - Client disconnect detection + upstream cancellation

3. **Authentication service**
   - Option A: Auth0 with custom domain (`accounts.quantlab.dev`)
   - Option B: Clerk (faster setup)
   - Option C: Custom OAuth2 server (more control, more work)
   - Recommendation: Start with Auth0, migrate to custom if needed

4. **Simple routing**
   - Lane-based model selection (same logic as extension's `ModelRegistry`)
   - completion/fast-apply/summarize -> Claude 3.5 Haiku
   - chat-ask/chat-gather/repair -> Claude Sonnet 4
   - chat-plan/chat-act -> Claude Sonnet 4 (reasoning tier not yet active)

5. **Usage tracking**
   - Log all requests to PostgreSQL
   - Redis counters for rate limiting (per lane group)
   - No billing integration yet

6. **Observability** (HIGH-5)
   - Structured JSON logging
   - Prometheus metrics (TTFT, request duration, error rate, active streams)
   - Distributed tracing via `X-QIC-Request-ID`
   - Basic alerting (PagerDuty/Slack)

7. **Quality signal telemetry endpoint**
   - `POST /v1/telemetry/interaction` accepting batched quality signals
   - Store server-side for correlation with request metadata via `requestId`
   - Start collecting from day one (metadata only, not code content)

8. **Infrastructure**
   - Single region (us-east-1)
   - Docker Compose for local development
   - Kubernetes deployment for staging/production
   - Graceful shutdown protocol (90s drain, terminationGracePeriodSeconds: 120)
   - CI/CD pipeline (GitHub Actions -> ECR -> EKS)
   - Terraform modules for core infrastructure

9. **Health endpoints**
   - `GET /v1/health/live` (K8s liveness)
   - `GET /v1/health/ready` (K8s readiness, maintenance flag)
   - `GET /v1/health` (detailed per-provider status)

10. **Documentation**
    - API reference (auto-generated from OpenAPI spec)
    - Getting started guide

### Architecture (Phase 2)

```
CloudFlare (DDoS, TLS)
        |
  API Gateway (Go)
        |
  +-----+-----+
  |           |
Auth0     Provider Proxy (Go)
              |
         Anthropic API
```

### Success Criteria

- A user can: install Quantlab, sign up via browser, return to extension, send "Hi" in QIC panel, receive a streaming response from Claude via the Quantlab server
- Latency overhead vs direct BYOK: <15ms additional
- Server handles 100 concurrent streaming requests without degradation
- Graceful shutdown completes active streams without drops

### Load Tests (Phase 2)

| Tool | Scenario | Target |
|------|----------|--------|
| k6 | 100 concurrent streaming requests, 60s duration | p99 TTFT <2s, 0% error rate |
| k6 | Authentication flow: 50 sign-ins/sec | p99 <500ms |

---

## Phase 3: Multi-Provider Routing

**Goal:** Add OpenAI and Google as backend providers. Implement the three-tier routing system.

### Deliverables

1. **Additional provider proxies**
   - OpenAI adapter (GPT-4o, GPT-4o-mini)
   - Google Vertex adapter (Gemini models)
   - Failover logic: if Anthropic is down, route to OpenAI

2. **Three-tier routing**
   - Fast tier: Haiku, GPT-4o-mini (cheapest, fastest)
   - Coding tier: Sonnet, GPT-4o (balanced)
   - Reasoning tier: Opus, o1 (expensive, most capable)
   - Lane-based routing with complexity heuristics

3. **Provider health monitoring**
   - Continuous health checks against all providers
   - Automatic failover on provider outage
   - Dashboard showing provider status

4. **Cost optimization**
   - Track cost per request per provider
   - Route to cheapest provider that meets quality threshold
   - Prompt caching for multi-turn conversations (Anthropic)

5. **Idempotency implementation**
   - Redis-backed idempotency key cache (5 min TTL)
   - Deduplication of retry requests

6. **Version compatibility**
   - HTTP 426 for extensions >2 major versions behind
   - Forward-compatible StreamChunk handling

7. **Documentation**
   - Architecture overview for contributors

### Load Tests (Phase 3)

| Tool | Scenario | Target |
|------|----------|--------|
| k6 | Mixed-lane traffic: 30% completion, 50% chat, 20% act | p99 TTFT <1s (chat), <300ms (completion) |

### Success Criteria

- Three providers operational with automatic failover
- Routing correctly assigns tiers based on lane + complexity
- Cost per request is 10-20% lower than BYOK (due to volume discounts and smart routing)

---

## Phase 4: Billing & Subscriptions

**Goal:** Monetize. Implement the free/pro/enterprise tier system.

### Deliverables

1. **Stripe integration**
   - Subscription plans (free, pro, enterprise)
   - Checkout flow (extension -> browser -> Stripe)
   - Webhook handling (payment events, plan changes) with `stripe-signature` verification
   - Overage billing for enterprise
   - JWT plan tier staleness fix (Redis override + X-QIC-Token-Refresh)

2. **Quota enforcement**
   - Pre-request quota check (Redis)
   - Monthly token budgets per plan
   - Lane-aware rate limits per plan
   - Daily request budgets per plan
   - Feature gates (reasoning tier: pro+ only)
   - Progressive trust for free tier (100K -> 500K graduation)
   - Graceful degradation when quota exceeded (downgrade to fast tier)

3. **Abuse prevention**
   - Email verification before first request
   - Disposable email blocking
   - CAPTCHA (hCaptcha/Turnstile)
   - Anomaly detection and automated suspension
   - Device fingerprinting for free tier

4. **Web dashboard** (`accounts.quantlab.dev`)
   - Account settings
   - Plan management
   - Usage charts
   - Billing history
   - Payment methods
   - Data & privacy settings (DataTier selection)

5. **Extension-side quota display**
   - Token usage in QIC panel header (from `meta.quotaRemaining`)
   - Low-quota warnings
   - Upgrade prompts when hitting limits

6. **Provider-aware egress boundary** (CRITICAL-3, Phase 4)
   - `getEgressBoundary()` in Gateway selects `'quantlab-cloud'` vs `'llm'` based on provider ID
   - Separate consent tracking for cloud vs direct connections

7. **Multi-region deployment**
   - Add eu-west-1 (Ireland) for European quant funds

8. **Enterprise features**
   - SSO/SAML integration
   - Team management (admin console)
   - Usage reports and cost allocation
   - Custom rate limits and model access
   - Model pinning policies

9. **Documentation**
   - Pricing page, billing FAQ, enterprise sales sheet

### Load Tests (Phase 4)

| Tool | Scenario | Target |
|------|----------|--------|
| k6 | Free-tier rate limit enforcement: 1000 users at limit | 100% of over-limit requests rejected with 429 |
| k6 | Billing accuracy: 10K metered requests | Token count variance <1% vs. actual provider usage |

### Success Criteria

- Users can self-serve upgrade from free to pro
- Billing is accurate (metered tokens match Stripe invoices)
- Enterprise onboarding flow works with at least one SSO provider
- Stripe webhook with invalid signature is rejected (security test)

---

## Phase 5: Data Pipeline

Data collection is split into four sub-phases with different dependencies:

### Phase 5a: Server-Side Metadata Collection (depends on Phase 2)

Start collecting server-side request metadata from day one.

**Deliverables:**
- Event streaming from API gateway to Kafka/NATS
- S3 data lake (raw events)
- Basic PII scrubbing (regex-based, API key patterns from `SecretScanner`)
- Cleaned data lake

### Phase 5b: Quality Signal Correlation (depends on Phase 1 + Phase 2)

Link extension-side quality signals with server-side request logs.

**Deliverables:**
- Telemetry transport in extension (network code for `telemetryService.ts`)
- Quality signal batching and transmission (respecting DataTier)
- Server-side join: requestId links quality signals to request metadata

### Phase 5c: Data Contributor Program (depends on Phase 4)

Needs billing for incentives.

**Deliverables:**
- Opt-in flow in extension settings (DataTier -> `data-contributor`)
- First-use consent flow for server-path users
- Consent management (GDPR-compliant)
- Rewards: free/discounted Pro access
- Data deletion on request (GDPR deletion flow)

### Phase 5d: Curation Pipeline (depends on Phase 5a + 5c)

Needs data to curate.

**Deliverables:**
- Quality filtering (accept rate, edit distance thresholds)
- Domain tagging (quant, data science, web, systems, general)
- Instruction pair extraction
- Preference pair extraction (for DPO)
- Dataset versioning and storage
- Full PII scrubbing with second-pass validation

### Documentation (Phase 5)
- Data contribution program terms
- Privacy policy update

### Success Criteria

- Data pipeline processes 10K+ interactions/day
- PII scrubber has <0.1% false negative rate (verified by manual audit)
- At least 10K curated instruction pairs after 3 months
- Quality signals successfully correlate with server request logs

---

## Phase 6: Quant Specialization

**Goal:** Train and deploy domain-specific models that outperform general models for quant workflows.

### Deliverables

1. **Evaluation suite**
   - Custom quant coding benchmarks:
     - Backtest implementation (given a strategy description, implement it)
     - Risk metric calculation (VaR, Sharpe, max drawdown)
     - Data pipeline construction (pandas operations on market data)
     - Signal generation (alpha factor implementation)
   - General coding benchmarks (HumanEval, MBPP) as baseline

2. **Fine-tuning infrastructure**
   - SFT training pipeline (on curated instruction pairs)
   - DPO training pipeline (on preference pairs)
   - Model evaluation automation
   - A/B testing framework (serve fine-tuned model to % of users)

3. **Fine-tuned model deployment**
   - Host on Fireworks/Together (managed GPU inference)
   - Integrate into provider multiplexer
   - Router sends quant-domain requests to fine-tuned models

4. **Quant knowledge base** (optional)
   - Pre-indexed documentation for common quant libraries
   - Financial data schema awareness
   - Quantlab-specific context (project structure, conventions)

### Success Criteria

- Fine-tuned fast-tier model matches Sonnet quality on quant tasks (at 1/10 the cost)
- Fine-tuned coding-tier model outperforms Sonnet by 15%+ on quant eval suite
- A/B test shows measurable improvement in user satisfaction for quant workflows
- **Routing optimization metrics:** cost reduction per request >= 30% quality-adjusted (contingency: if fine-tuned models underperform, this is the primary value)

---

## Timeline Summary

| Phase | Focus | Key Dependency |
|-------|-------|----------------|
| 1 | Extension adapter + auth + ModelRegistry restructure | None (can start immediately) |
| 2 | Server MVP + observability + graceful shutdown | Phase 1 (needs adapter to test against) |
| 3 | Multi-provider routing + idempotency + version compat | Phase 2 (needs working server) |
| 4 | Billing, abuse prevention, multi-region, egress boundary | Phase 2 (needs user accounts) |
| 5a | Server-side metadata collection | Phase 2 (needs working server with users) |
| 5b | Quality signal correlation | Phase 1 + Phase 2 |
| 5c | Data contributor program | Phase 4 (needs billing for incentives) |
| 5d | Curation pipeline | Phase 5a + Phase 5c |
| 6 | Quant specialization | Phase 5d (needs training data) |

Phases 3 and 4 can run in parallel after Phase 2. Phase 5a and 5b should start as early as possible.

---

## Marketing Dependencies Per Phase

| Phase | Marketing Action |
|-------|-----------------|
| Phase 1 | Open-source community engagement, GitHub presence |
| Phase 2 | Beta invitations to quant community (QuantConnect forums, r/algotrading, Hacker News) |
| Phase 3 | Blog posts comparing QIC to Cursor/Copilot for quant workflows |
| Phase 4 | Launch announcement, Product Hunt, quant conference demos |
| Phase 5 | Data contributor incentive program, referral bonuses |
| Phase 6 | Benchmark publications showing quant-specific improvements |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Server adds unacceptable latency | Measure TTFT overhead obsessively. Target <10ms. Use connection pooling and zero-buffering SSE proxy. Completions bypass server in Phase 2. |
| Server becomes single point of failure | BYOK fallback always available. Circuit breaker auto-falls-through. DegradationManager integration. Multi-region deployment (Phase 4). |
| Provider API costs exceed subscription revenue | Smart routing to cheapest adequate model. Fine-tuned models on cheaper infrastructure (Phase 6). Usage caps per plan. Lane-aware rate limiting. |
| Low adoption of server path | Free tier is generous (with progressive trust). Zero-friction onboarding. BYOK remains available (no lock-in). |
| Data collection consent concerns | Two-layered consent (processing vs retention). GDPR-compliant three-tier DataTier system. No code stored without explicit opt-in. SOC 2 compliance. |
| Fine-tuned models underperform | Extensive eval suite before deployment. A/B testing. Fallback to base models. Routing optimization provides value even without better models. |

---

## Load Testing Infrastructure

- Dedicated load test environment (separate from staging)
- Provider mock server (to avoid incurring real API costs during load tests)
- Automated load test suite in CI (runs nightly against staging)
- Tool: k6 or Grafana k6

---

## Documentation Plan

| Phase | Documentation |
|-------|--------------|
| 1 | Extension settings reference, cloud vs BYOK comparison page |
| 2 | API reference (auto-generated from OpenAPI spec), getting started guide |
| 3 | Architecture overview for contributors |
| 4 | Pricing page, billing FAQ, enterprise sales sheet |
| 5 | Data contribution program terms, privacy policy update |
| 6 | Quant-specific model capabilities documentation |

**Internal documentation:**
- Runbook for each service (deploy, restart, debug, rollback)
- On-call playbook with alert-to-action mapping
- Architecture decision records (ADRs) for major design choices
