# Internal Inconsistencies

These are contradictions between plan documents that must be resolved before implementation begins. Each inconsistency creates ambiguity about intent; an implementer would have to guess which document is authoritative.

---

## INCONSISTENCY-1: Two Different Activation Flow Code Samples

### The Contradiction

**Doc 01, Section 4** shows BYOK initialization gated by:
```typescript
if (connectionMode === 'byok' || connectionMode === 'cloud') {
    // BYOK adapters are ALSO created in cloud mode as fallback
```

**Doc 07, Step 6 Detail** shows BYOK initialization gated by:
```typescript
if (connectionMode !== 'local') {
    // BYOK adapters (always initialized if keys exist, for fallback)
```

These are logically equivalent today (when connectionMode is `'cloud' | 'byok' | 'local'`), but they differ in intent and future-proofing:

- Doc 01's version is explicit and breaks if a new connection mode is added (e.g., `'enterprise'`)
- Doc 07's version is permissive and automatically includes new modes

Similarly, Doc 01's cloud adapter init checks `connectionMode === 'cloud' || connectionMode === undefined`, while Doc 07 checks `connectionMode !== 'local'`. Under Doc 07's logic, BYOK mode also initializes the cloud adapter (if a token exists), which is different from Doc 01's intent where BYOK mode skips cloud initialization.

### Resolution Required

Decide on **one** canonical activation flow. Recommendation: use Doc 07's version (`!== 'local'`) as it's simpler and correctly handles the case where a BYOK user later signs in to cloud (cloud adapter becomes available as a bonus). Update Doc 01 Section 4 to match.

However, clarify the cloud adapter initialization: should cloud adapter initialize in BYOK mode? If yes (Doc 07's behavior), then a BYOK user who happens to have a cloud token gets cloud as an option. If no (Doc 01's behavior), the user must explicitly switch to cloud mode.

---

## INCONSISTENCY-2: QuantlabCloudAdapter Config Interface Mismatch

### The Contradiction

**Doc 01, Section 1** defines the adapter config:
```typescript
export interface QuantlabCloudConfig {
    baseUrl: string;
    accessToken: string;
    refreshToken?: string;
}
```

**Doc 07, Step 6 Detail** constructs the adapter with an additional `onTokenRefresh` callback:
```typescript
new QuantlabCloudAdapter({
    baseUrl: cloudUrl,
    accessToken,
    refreshToken: ...,
    onTokenRefresh: async (newAccess, newRefresh) => {
        await this.secretStorageService.store(...);
    },
});
```

The `onTokenRefresh` callback is critical for persisting refreshed tokens but is missing from the interface definition in Doc 01.

### Resolution Required

Update Doc 01's `QuantlabCloudConfig` interface to include:
```typescript
export interface QuantlabCloudConfig {
    baseUrl: string;
    accessToken: string;
    refreshToken?: string;
    onTokenRefresh?: (newAccessToken: string, newRefreshToken?: string) => Promise<void>;
}
```

---

## INCONSISTENCY-3: "Files That Change" List is Incomplete

### The Contradiction

**Doc 07** lists the files that change:

| File | Change |
|------|--------|
| `constants.ts` | Add new settings and secret keys |
| `qic.contribution.ts` | Branch activation on connection mode |
| `modelRegistry.ts` | Add cloud model aliases |
| `egressEnforcer.ts` | Add `'quantlab-cloud'` to EgressBoundary |
| `consentStore.ts` | Handle cloud consent boundary |

Then states: "This is approximately 3 modified files and 3 new files."

**Problems:**
1. The table lists **5** modified files, not 3
2. **Missing from the list:** `gateway.ts` must be modified for provider-aware egress boundary selection (CRITICAL-3 from `01-critical-codebase-fixes.md`)
3. **Missing from the list:** `interfaces.ts` must be modified to widen `ProviderAdapter` with `GatewayMetadata` (CRITICAL-2)
4. **Missing from the list:** `types.ts` if `StreamChunk` is extended with `providerMeta` (MEDIUM-1)
5. **Missing from the list:** `telemetryService.ts` needs transport capability (Phase 5)

### Resolution Required

Correct the table to list all modified files accurately:

| File | Change | Phase |
|------|--------|-------|
| `constants.ts` | New settings, secret keys | 1 |
| `qic.contribution.ts` | Connection mode branching, cloud adapter init | 1 |
| `modelRegistry.ts` | Cloud model aliases, per-lane arrays (CRITICAL-1) | 1 |
| `egressEnforcer.ts` | Add `'quantlab-cloud'` boundary | 1 |
| `consentStore.ts` | Handle cloud consent + data tier | 1 |
| `gateway.ts` | Provider-aware egress boundary (CRITICAL-3) | 1 |
| `interfaces.ts` | Widen ProviderAdapter with GatewayMetadata (CRITICAL-2), extend StreamChunk | 1 |

Remove the misleading "approximately 3 modified files" count.

---

## INCONSISTENCY-4: Pro Tier Token Budget Conflict

### The Contradiction

**Doc 05** (Plan Tiers table):
```
Pro: 10M tokens/month
```

**Doc 02** (`/v1/account/info` response example):
```json
{
    "plan": {
        "tier": "pro",
        "tokensPerMonth": 5000000
    }
}
```

10M vs 5M is a factor-of-two discrepancy that directly affects revenue projections and user expectations.

### Resolution Required

Pick one number and update the other document. The revenue model in Doc 05 uses 3M tokens/month as average Pro consumption, so 10M/month budget provides 3.3x headroom. At 5M/month, headroom is only 1.67x, which means more users hit their limit.

Recommendation: Use 10M as stated in the plan tiers table. Update Doc 02's example to `"tokensPerMonth": 10000000`.

---

## INCONSISTENCY-5: HTTP 401/403 Error Code Collision

### The Contradiction

**Doc 02** (Error Responses table):

| HTTP Status | QIC Code |
|-------------|----------|
| 401 | QIC-P006 |
| 403 | QIC-P006 |

Both statuses map to the same error code. These require different user actions (re-authenticate vs. upgrade plan). This was already identified as MEDIUM-2 in `03-api-and-protocol-gaps.md`.

### Resolution Required

This is listed here for completeness. The fix is defined in `03-api-and-protocol-gaps.md`: add QIC-P007 for 403 (plan limit / feature unavailable).

---

## INCONSISTENCY-6: Done Chunk 'meta' Field Handling

### The Contradiction

**Doc 02** (SSE response) shows the `done` chunk including `meta`:
```json
{"type":"done","usage":{...},"meta":{"actualModel":"...","quotaRemaining":...}}
```

And states: "The adapter strips `meta` and passes standard `StreamChunk` objects upstream."

**Doc 01** (Section 1, Request Flow) shows the same `meta` field in the SSE stream but does NOT mention stripping it.

**The codebase's `StreamChunk` type** (`interfaces.ts` line 55):
```typescript
| { type: 'done'; usage?: TokenUsage; stopReason?: string }
```

There is no `meta` or `providerMeta` field. If the adapter strips `meta`, the data is lost. If the adapter passes it through, it doesn't fit the type.

This was identified as MEDIUM-1 in `03-api-and-protocol-gaps.md`. Listed here because the two documents give contradictory instructions about what to do with `meta`.

### Resolution Required

Choose one approach:
- **Option A (recommended from MEDIUM-1):** Extend `StreamChunk` with `providerMeta?: Record<string, unknown>`. The adapter maps `meta` -> `providerMeta`. No data is lost.
- **Option B:** The adapter strips `meta` and exposes quota/model info through a separate mechanism (e.g., adapter properties that the status bar reads directly).

Update both Doc 01 and Doc 02 to describe the same approach.

---

## INCONSISTENCY-7: PROVIDER_DEFAULT vs CONNECTION_MODE Settings Overlap

### The Contradiction

The existing codebase has (`constants.ts` line 35):
```typescript
PROVIDER_DEFAULT: 'qic.provider.default',
```

The plan proposes adding:
```typescript
CONNECTION_MODE: 'qic.connectionMode',  // 'cloud' | 'byok' | 'local'
```

These settings overlap in purpose. `PROVIDER_DEFAULT` selects a default provider (`anthropic`, `openai`, `ollama`). `CONNECTION_MODE` selects a connection path (`cloud`, `byok`, `local`). What happens when:
- `connectionMode = 'byok'` and `provider.default = 'openai'`? (Clear: use OpenAI directly)
- `connectionMode = 'cloud'` and `provider.default = 'openai'`? (Conflict: does the user want cloud routing or direct OpenAI?)
- `connectionMode = 'local'` and `provider.default = 'anthropic'`? (Conflict: can't reach Anthropic in local mode)

### Resolution Required

Add to `01-extension-integration.md`, Section 3:

**Settings hierarchy:**

`connectionMode` takes precedence over `provider.default`:
1. `connectionMode` determines which adapters are initialized (cloud, BYOK, local, or combinations)
2. `provider.default` is a hint within the BYOK path: if in BYOK mode, prefer this provider
3. In cloud mode, `provider.default` is ignored (the server handles model selection)
4. In local mode, `provider.default` is ignored (only Ollama is available)

Alternatively, deprecate `PROVIDER_DEFAULT` in favor of the per-lane override mechanism (`qic.laneOverrides`). This is more powerful and doesn't conflict with `connectionMode`.

---

## INCONSISTENCY-8: Gateway Listed as Unchanged in Doc 07

### The Contradiction

**Doc 07** ("What Stays Exactly the Same") includes:

> | Gateway class | `gateway.ts` | Takes `Map<string, ProviderAdapter>`. Cloud adapter is just another entry. Egress enforcement, rate limiting, circuit breaking, retry -- all work identically. |

**But the plan itself requires modifying `gateway.ts`:**

1. CRITICAL-3: The Gateway must select egress boundary based on provider ID (currently hardcoded to `'llm'`)
2. The Gateway must pass `GatewayMetadata` through to adapters (CRITICAL-2's impact)

Doc 07 should move `gateway.ts` from the "unchanged" table to the "files that change" table.

### Resolution Required

Move `gateway.ts` to the "files that change" section of Doc 07:

| File | Change |
|------|--------|
| `gateway.ts` | Provider-aware egress boundary selection, GatewayMetadata passthrough |

---

## INCONSISTENCY-9: Phase Dependency Chain Error

### The Contradiction

**Doc 06** (Timeline Summary):

> | Phase 5 | Data pipeline | Phase 4 (needs users generating data) |

This states Phase 5 depends on Phase 4 (billing). But Phase 5 (data collection) doesn't actually require billing to be operational. Server-path users generate data as soon as Phase 2 is live. The dependency should be:

- Phase 5 depends on **Phase 2** (needs a working server with users generating requests)
- Phase 5 can optionally benefit from Phase 4 (billing incentives for data contributors)

Starting data collection at Phase 5 (after billing is built) means losing months of valuable interaction data from Phase 2-4 users.

### Resolution Required

Update the timeline:

| Phase | Dependency | Rationale |
|-------|-----------|-----------|
| Phase 5a: Server-side metadata collection | Phase 2 | Collect timing, token counts, lane usage from day one |
| Phase 5b: Quality signal instrumentation | Phase 1 | Extension-side accept/reject tracking, built early |
| Phase 5c: Data contributor program | Phase 4 | Needs billing for incentives (free/discounted Pro) |
| Phase 5d: Curation pipeline | Phase 5a + 5c | Needs data to curate |

Split Phase 5 and start pieces earlier. The most valuable data (server-side metadata, quality signals) should be collected from the earliest possible moment.

---

## INCONSISTENCY-10: Rate Limit Numbers Disagree

### The Contradiction

**Doc 05** (Plan Tiers):
```
Free: 30 requests/min
Pro: 200 requests/min
```

**Doc 02** (Account Info response):
```json
{
    "plan": {
        "requestsPerDay": 1000
    }
}
```

The tiers use requests/minute but the API response uses requests/day. These are different units measuring different things. 200 requests/min = 288,000 requests/day (theoretical max), which is far more than the 1,000/day in the API response.

### Resolution Required

Clarify that rate limiting has two dimensions:

| Dimension | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| Burst rate (requests/min) | 30 | 200 | Custom |
| Daily budget (requests/day) | 500 | 5,000 | Custom |

Update the `/v1/account/info` response to include both:
```json
{
    "plan": {
        "rateLimit": {
            "requestsPerMinute": 200,
            "requestsPerDay": 5000
        }
    }
}
```

---

## INCONSISTENCY-11: laneOverrides Fallback Behavior Unspecified

### The Contradiction

**Doc 01, Section 3** introduces `qic.laneOverrides`:
```typescript
'qic.laneOverrides': {
    type: 'object',
    default: {},
    description: 'Override the connection path for specific lanes.',
    // Example: { "completion": "byok-openai", "chat-act": "cloud" }
}
```

But the plan doesn't define what happens when the override target is unavailable (no key, circuit breaker open, provider down). Does the system fail the request? Does it fall through to the default `LANE_MODEL_RECOMMENDATIONS` chain?

### Resolution Required

Add to `01-extension-integration.md`, Section 3:

**Override resolution order:**
1. If `laneOverrides[lane]` is set, try that provider first
2. If override provider is unavailable (no key, circuit breaker open), log a warning and fall through to `LANE_MODEL_RECOMMENDATIONS[lane]` as if no override existed
3. Overrides are "prefer," not "require" -- this prevents user misconfiguration from breaking the system

---

## INCONSISTENCY-12: ReproducibilityLogger and SessionCache Behavior With Cloud Path Undefined

### The Contradiction

The codebase has both a `ReproducibilityLogger` (`common/telemetry/reproducibilityLogger.ts`) and a `SessionCache` (`common/telemetry/sessionCache.ts`). Both operate at the Gateway level. Neither is mentioned in the server plan.

**ReproducibilityLogger:** Cloud requests send `model: "quantlab-auto"` (a virtual alias). On replay, this alias would hit the server again and might resolve to a different model. For true reproducibility, the log must record the actual model in addition to the request.

**SessionCache:** The cache key includes provider + model + message hash. For cloud path, the model is `quantlab-auto`. Two identical requests might be routed to different models server-side, but the cache key would be identical, producing stale hits from a different model's output.

### Resolution Required

Add to `01-extension-integration.md`:

- **ReproducibilityLogger:** Log the outgoing request (with `model: "quantlab-auto"`) and on stream completion, append `actualModel` from `meta`. Replay mode should allow replaying against either the cloud (re-routes) or the actual model via BYOK (deterministic).
- **SessionCache:** Cloud requests are cache-eligible with a short TTL (60s vs 300s for BYOK), keyed on message hash only (model alias is ignored since the server controls routing). Alternatively, invalidate cloud cache entries when `actualModel` differs between identical requests.

Note: These components are late-stage (Phase 9 in the extension implementation plan). This is documentation-only to ensure the server plan doesn't create obstacles for their future implementation.
