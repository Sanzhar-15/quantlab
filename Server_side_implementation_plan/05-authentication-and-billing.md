# Authentication & Billing

## Authentication

### OAuth2 + PKCE Flow

The extension uses OAuth2 Authorization Code flow with PKCE, which is the standard for native/desktop apps (no client secret needed).

**Components:**
- Authorization server: `accounts.quantlab.dev`
- Token endpoint: `accounts.quantlab.dev/token`
- Redirect URI: `vscode://quantlab.qic/auth/callback` (VS Code URI handler)

### Flow Detail

```
1. User clicks "Sign in to Quantlab" in QIC panel or Command Palette

2. Extension generates PKCE pair:
   code_verifier = random(43-128 chars, unreserved charset)
   code_challenge = base64url(sha256(code_verifier))

3. Extension opens system browser:
   https://accounts.quantlab.dev/authorize?
     client_id=qic-vscode
     redirect_uri=vscode://quantlab.qic/auth/callback
     code_challenge=<hash>
     code_challenge_method=S256
     response_type=code
     scope=qic:inference qic:usage
     state=<random_nonce>

4. User authenticates (options):
   - Email + password
   - GitHub OAuth
   - Google OAuth
   - Enterprise SSO (SAML, for fund customers)

5. Authorization server redirects:
   vscode://quantlab.qic/auth/callback?code=<auth_code>&state=<nonce>

6. VS Code handles the URI, extension receives the callback

7. Extension exchanges code for tokens:
   POST https://accounts.quantlab.dev/token
   {
     grant_type: "authorization_code",
     code: "<auth_code>",
     code_verifier: "<original_verifier>",
     client_id: "qic-vscode",
     redirect_uri: "vscode://quantlab.qic/auth/callback"
   }

8. Receives:
   {
     access_token: "<jwt>",      // 15 min TTL
     refresh_token: "<opaque>",  // 30 day TTL
     expires_in: 900,
     token_type: "Bearer",
     scope: "qic:inference qic:usage"
   }

9. Extension stores both tokens in VS Code SecretStorage

10. All subsequent API calls use: Authorization: Bearer <access_token>
```

### Token Lifecycle

**Access token (JWT, 15 min):**
- Self-validating (server verifies signature without DB lookup)
- Contains: user ID, plan tier, scopes (NO email -- see below)
- Short-lived to limit damage if leaked
- Refreshed automatically by the adapter

**Refresh token (opaque, 30 days):**
- Stored encrypted in SecretStorage
- Single-use: each refresh returns a new refresh token (rotation)
- Revokable server-side (sign-out invalidates all refresh tokens)
- If the refresh token is expired, user must re-authenticate

**Auto-refresh logic in QuantlabCloudAdapter:**
```
On every request:
  1. Check if access token expires within 60 seconds
  2. If yes: refresh proactively (before the request)
  3. If request returns 401: refresh and retry once
  4. If refresh fails: emit QicError('QIC-P006', 'Session expired')
     -> Extension shows "Sign in again" prompt
```

### JWT Plan Tier Staleness (HIGH-12)

**Problem:** When a user upgrades via Stripe, the webhook updates the database, but the active JWT still says `"plan": "free"` until the next token refresh (up to 15 minutes).

**Server-side fix:** For plan-sensitive routing decisions (reasoning tier access), the request router checks plan tier from Redis (updated immediately by the Stripe webhook), not from the JWT alone. The JWT's plan claim is a fast-path optimization: if the JWT says "pro," trust it; if the JWT says "free," check Redis for a recent upgrade before rejecting.

**Server-initiated token refresh:** On plan change, the Stripe webhook sets a flag in Redis (`user:{id}:plan-changed`). On the next request with a stale JWT, the server includes `X-QIC-Token-Refresh: required` in the response headers. The `QuantlabCloudAdapter` checks for this header and triggers an immediate token refresh, which returns a JWT with the updated plan tier.

### Sign-Out

```
User clicks "Sign out" in QIC panel
  -> Extension calls POST /v1/auth/revoke with refresh_token
  -> Extension deletes both tokens from SecretStorage
  -> Extension removes 'quantlab-cloud' from providers Map
  -> Gateway falls back to BYOK providers if available
  -> Status bar updates to show current mode
```

### Enterprise SSO

For quant funds with existing identity providers:

- SAML 2.0 integration via the authorization server
- Admin configures SSO in the Quantlab dashboard
- Users authenticate via their firm's identity provider
- No separate Quantlab password needed

Implementation: use the authorization server's built-in SAML support (Auth0, Clerk, or custom). The extension flow is identical -- the authorization server handles the SAML redirect internally.

---

## Billing

### Plan Tiers

| Feature | Free | Pro | Enterprise |
|---------|------|-----|-----------|
| Monthly price | $0 | $20/mo | Custom |
| Token budget | 500K/mo (100K initially, graduating) | 10M/mo | Unlimited |
| Burst rate | See lane limits below | See lane limits below | Custom |
| Daily budget | 500/day | 5,000/day | Custom |
| Fast tier | Yes | Yes | Yes |
| Coding tier | Yes (limited) | Yes | Yes |
| Reasoning tier | No | Yes | Yes |
| Data retention | 7 days | 30 days | Custom |
| Priority queue | No | Yes | Yes |
| SSO | No | No | Yes |
| Dedicated support | No | No | Yes |
| SLA | None | 99.5% | 99.9% |
| Model pinning | No | No | Yes |

### Lane-Aware Rate Limiting (MEDIUM-17)

Rate limits are enforced per lane group to prevent completion requests from starving chat:

| Lane Group | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| Completion (high-frequency) | 20/min | 120/min | Custom |
| Chat/Agent (chat-ask, chat-plan, chat-act, chat-gather, repair) | 10/min | 60/min | Custom |
| Background (fast-apply, summarize) | 5/min | 30/min | Custom |

**Server-side completion deduplication:** If a new completion request arrives while the previous one for the same session is still streaming, cancel the previous upstream request.

### Model Pinning (MEDIUM-19)

Enterprise plans include a `modelPolicy` setting: `"auto"` (default) or `"pinned"` (admin-configured model version per tier). Pinned policies prevent surprise model changes during critical workflows.

When the server upgrades from `claude-sonnet-4-20250514` to a newer version, `quantlab-auto` silently changes behavior. Enterprise quant users running production backtesting workflows need deterministic model behavior. The `model` field in requests accepts either aliases (`quantlab-auto`) or pinned model IDs (`claude-sonnet-4-20250514`).

### Pricing Rationale

**Cost basis:**
- Average Pro user: ~3M tokens/month
- Blended provider cost: ~$5/MTok
- Per-user cost: ~$15/month
- At $20/month: ~25% gross margin per Pro user

This is thin initially. The margin becomes healthy when:
1. Smart routing reduces average cost (fast tier for simple requests: ~$0.50/MTok vs $5/MTok blended)
2. Fine-tuned models on cheaper infrastructure replace expensive API calls (Phase 6)
3. Volume discounts from providers kick in (>$100K/month spend)

**Value justification:**
- $20/month = price parity with Cursor, which is the direct competitor
- Quantlab's differentiator is quant specialization, not price
- Free tier exists for adoption; Pro tier funds the infrastructure

**Sensitivity analysis:**

| Price | Expected conversion | Monthly revenue (10K users) | Gross margin |
|-------|--------------------|-----------------------------|-------------|
| $15/month | 7% of users | $10,500 | ~0% (breakeven) |
| $20/month | 5% of users | $10,000 + $25K enterprise | ~25% initially, ~60% at scale |
| $30/month | 3% of users | $9,000 + $25K enterprise | ~50% initially |

$20 is the right price point: competitive parity, acceptable margin that improves with scale.

### Usage Metering

Every request is metered at the server:

```go
type UsageEvent struct {
    UserID      string
    Timestamp   time.Time
    Lane        string
    LaneGroup   string    // completion | chat-agent | background
    ModelTier   string
    ActualModel string
    InputTokens int
    OutputTokens int
    LatencyMs   int
    StatusCode  int
}
```

Events are written to an append-only log (Kafka/NATS) and aggregated:
- Real-time: Redis counters for rate limiting and quota checks (per lane group)
- Batch: ClickHouse for analytics and billing calculations

### Quota Enforcement

Pre-request check (synchronous, <2ms):

```
1. Read user's remaining quota from Redis (token budget + daily request budget + lane group rate limit)
2. Estimate request cost (input tokens * model tier multiplier)
3. If over quota: return 429 with upgrade prompt
4. If within quota: proceed, decrement counters
5. On response: adjust counters based on actual token usage
```

The extension shows quota status in the QIC panel:
```
Quantlab Pro | 7.2M / 10M tokens used | Resets Feb 28
```

### Billing Integration (Stripe)

**Subscription lifecycle:**
```
User signs up (free tier)
  -> Stripe Customer created
  -> Usage metering begins
  -> Progressive trust: start at 100K tokens/month

User upgrades to Pro
  -> Stripe Checkout session
  -> Webhook: subscription.created
  -> Server updates user plan in DB + Redis
  -> Sets Redis flag: user:{id}:plan-changed
  -> Next request triggers X-QIC-Token-Refresh: required
  -> JWT refresh includes new plan tier

Monthly cycle
  -> Stripe charges card
  -> Webhook: invoice.paid
  -> Usage counters reset

Payment failure
  -> Stripe retries (3 attempts over 7 days)
  -> Webhook: invoice.payment_failed
  -> After 3 failures: downgrade to free tier
  -> Extension shows "Payment issue" notification
```

**Stripe webhook security (MEDIUM-20):** All Stripe webhook handlers MUST verify the `stripe-signature` header using `stripe.webhooks.constructEvent(payload, sig, endpointSecret)` before processing any event. Unverified events return 400 and are logged as security incidents. The webhook endpoint secret is stored as an environment variable, never in source code.

Phase 4 acceptance criteria: a test that sends a request with an invalid signature and verifies rejection.

**Overage handling (Enterprise):**
Enterprise plans can optionally allow overage billing:
- Per-token pricing beyond the included budget
- Billed at end of month based on actual usage
- Configurable hard cap to prevent runaway costs

### Revenue Projections Model

```
Variables:
  users_free:    Users on free tier
  users_pro:     Users on Pro tier ($20/mo)
  users_ent:     Enterprise contracts (avg $500/mo)
  cost_per_token: Blended provider cost (~$5/M tokens)
  tokens_per_pro: Average Pro user consumption (~3M tokens/mo)

Revenue = (users_pro * $20) + (users_ent * $500)
Cost    = (total_tokens * cost_per_token / 1M)
Margin  = Revenue - Cost

Example at 10K users (5% Pro, 0.5% Enterprise):
  Revenue = (500 * $20) + (50 * $500) = $35,000/mo
  Cost    = (500 * 3M + 50 * 10M) * $5/M = $10,000/mo
  Margin  = $25,000/mo (71%)
```

The margin improves as fine-tuned models (hosted on cheaper infrastructure) replace expensive provider API calls for routine requests.

### Assumption Validation Plan (LOW-8)

| Assumption | Validation Method | When |
|-----------|-------------------|------|
| 5% Pro conversion | Track free -> trial -> paid funnel from Phase 2 | After 3 months of free tier |
| 3M tokens/month avg Pro | Monitor actual usage distributions in Phase 2 | After 1 month of Pro tier |
| $500/mo enterprise avg | Track first 10 enterprise deals | After 3 enterprise closes |
| 10K users in year 1 | Track growth rate from launch | Monthly after public launch |

**Break-even analysis:**

Minimum viable revenue: server infrastructure + 1 engineer salary = ~$15K/month.

| Scenario | Users needed | Pro users | Enterprise | Revenue |
|----------|-------------|-----------|------------|---------|
| Pessimistic (2% conv, $400 ent) | 15K | 300 ($6K) | 20 ($8K) | Barely viable |
| Base case (5% conv, $500 ent) | 10K | 500 ($10K) | 50 ($25K) | Healthy |
| Optimistic (8% conv, $800 ent) | 5K | 400 ($8K) | 25 ($20K) | Profitable |

The business is viable even at pessimistic conversion rates if user acquisition reaches target.

---

## Account Management UI

### Extension-Side

**QIC Panel header (when signed in):**
```
[Quantlab Cloud]  Pro  7.2M/10M tokens
```

**Command Palette commands:**
- `QIC: Sign In to Quantlab` - starts OAuth flow
- `QIC: Sign Out` - revokes tokens, removes cloud adapter
- `QIC: View Account` - opens account dashboard in browser
- `QIC: Switch to BYOK Mode` - changes connection mode setting
- `QIC: View Usage` - shows usage breakdown in panel

### Web Dashboard (accounts.quantlab.dev)

- Account settings (password, connected identity providers)
- Plan management (upgrade, downgrade, cancel)
- Usage analytics (charts by day, lane, model tier)
- Billing history (invoices, payment methods)
- API keys (for programmatic access, if needed)
- Data & privacy settings (opt-in/out of data contribution, DataTier selection)
- Team management (Enterprise: invite members, set policies, model pinning)
