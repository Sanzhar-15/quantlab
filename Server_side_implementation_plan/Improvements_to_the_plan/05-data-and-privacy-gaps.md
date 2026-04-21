# Data & Privacy Gaps

---

## HIGH-10: Quality Signal Collection Does Not Exist

### The Gap

Doc 04 (Data Pipeline) lists these quality signals as collected data:

- Accept/reject: did the user use the completion or dismiss it?
- Edit distance: how much did the user change the AI's suggestion?
- Re-request: did the user immediately retry with a rephrased prompt?
- Follow-up pattern: did the tool result lead to another tool call or did the user take over?

**None of these exist in the codebase.** The `completionEngine.ts` has no accept/reject tracking. The `qicInlineCompletionProvider.ts` provides completions but does not observe whether they were accepted. There is no edit distance computation between AI suggestions and final code. There is no re-request detection.

The entire data flywheel strategy rests on quality signals that have no collection mechanism.

### Fix Required in Plan

Add a **Phase 5 prerequisite** to `06-implementation-phases.md`:

**Quality signal instrumentation (must be built before Phase 5):**

1. **Completion acceptance tracking:**
   - Hook into VS Code's `InlineCompletionItemProvider.handleDidPartiallyAcceptCompletionItem()` and `handleDidShowCompletionItem()`
   - Record: completion shown timestamp, accepted/rejected/partial, time-to-decision
   - Store locally in SQLite (never sent without consent)

2. **Edit distance tracking:**
   - On completion accept: snapshot the accepted text
   - After 10 seconds (debounced): compare accepted text with current buffer content
   - Compute Levenshtein distance ratio
   - Store locally

3. **Re-request detection:**
   - Track when the same lane receives a request within 30 seconds of a previous error or rejection
   - Flag as "retry" in the interaction log

4. **Follow-up pattern tracking:**
   - In the orchestrator, when a tool result is followed by another LLM call vs. user taking over (no new message for 60s), record the pattern

Add this instrumentation to Phase 1 (extension-side) as local-only telemetry. Data is collected locally regardless of consent tier. It is only *transmitted* in Phase 5 based on the user's consent level.

**Critical design for server-path correlation:** Each quality signal must include a `requestId` (the `X-QIC-Request-ID` from the original inference request) to link extension-side quality observations to server-side request logs. Without this linkage, the server has timing/token data and the extension has accept/reject data, but they cannot be joined for training pair construction:

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

For server-path users, these signals should be sent via the telemetry endpoint in Phase 2 (not Phase 5) -- this is metadata, not code content, and is covered by the service ToS. Losing months of quality signals from early users is irreversible.

---

## HIGH-11: Three-Tier Consent Model Mismatch

### The Gap

The plan (Doc 04, "Privacy Architecture") describes a three-tier consent model for BYOK users:

| Tier | Description |
|------|-------------|
| Private (default) | Nothing collected |
| Anonymous Metrics | Latency, accept/reject, lane usage |
| Data Contributor | Full interaction data including code |

The codebase's `consentStore.ts` has a **completely different** three-tier system:

| Tier | Description |
|------|-------------|
| Session | Consent expires when session ends |
| Workspace | Consent persists for current workspace |
| Global | Consent persists across all workspaces |

These are consent *scopes* (how long does consent last), not consent *levels* (what data is shared). The codebase has no concept of Private vs. Anonymous Metrics vs. Data Contributor.

Additionally, the codebase's `EgressBoundary` type in `egressEnforcer.ts` (line 10) defines six boundaries:
```typescript
export type EgressBoundary = 'llm' | 'embedding' | 'telemetry' | 'network' | 'web-fetch' | 'web-search';
```

There is no `'quantlab-cloud'` boundary. The plan proposes adding one (Doc 01, Section 6) but doesn't address how the telemetry consent tiers map to egress boundaries.

### Fix Required in Plan

Add a **"Consent Model Bridge"** section to `01-extension-integration.md`:

**Step 1: Extend the consent store for data tiers (Phase 1).**

The existing consent store manages per-boundary consent with duration scopes. Extend it with a new concept: `DataTier`.

```typescript
export type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';
```

This is stored as a separate setting (`qic.dataTier`) and controls what telemetry events are allowed:

| DataTier | Egress boundaries allowed |
|----------|--------------------------|
| `private` | `llm` only (no telemetry) |
| `anonymous-metrics` | `llm` + `telemetry` (metadata only) |
| `data-contributor` | `llm` + `telemetry` (full interaction data) |

**Step 2: Wire DataTier into the telemetry service.**

The existing `telemetryService.ts` already checks consent before logging. Modify it to check `DataTier` instead of the boolean `TELEMETRY_ENABLED` setting:

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

The existing `qic.telemetry.enabled` setting (boolean, default false) should be deprecated in favor of `qic.dataTier` (enum, default 'private'). For backwards compatibility: if `telemetry.enabled` is true and `dataTier` is not set, treat as `anonymous-metrics`.

---

## MEDIUM-11: Telemetry Service Has No Network Capability

### The Gap

The plan (Doc 04) describes a telemetry endpoint `POST /v1/telemetry/interaction` that receives batched interaction data from the extension. But the existing `telemetryService.ts` has **no network code**. Its `flush()` method only calls `egressEnforcer.checkAndSanitize()` and does nothing with the result. No HTTP request is made. No data leaves the machine.

The plan assumes this infrastructure exists and just needs an endpoint URL. In reality, the entire client-side telemetry transport needs to be built.

### Fix Required in Plan

Add to `01-extension-integration.md`:

**Telemetry transport (Phase 5 deliverable):**

The telemetry service needs a `TelemetryTransport` that:
1. Collects events in a local buffer (already exists)
2. Serializes events as JSON batches
3. Sends via `POST /v1/telemetry/interaction` through the egress enforcer
4. Handles failures gracefully (retry with exponential backoff, drop after 3 failures)
5. Respects `DataTier` for what events to include

This is new code in the extension, not just a server endpoint. Add it to the Phase 5 deliverables list.

---

## MEDIUM-12: Server-Path Implicit Consent via ToS is Legally Fragile

### The Gap

Doc 04 states: "Server-path users implicitly consent to data collection via Terms of Service." This is legally problematic:

1. **GDPR (EU):** Terms of Service are not sufficient basis for data processing. GDPR requires either explicit consent, legitimate interest, or contractual necessity. Burying data collection in ToS violates the "freely given" requirement for consent.

2. **Quant fund compliance:** Many hedge funds have data handling policies that prohibit sending code to third-party servers without explicit approval. "It's in the ToS" is not sufficient for their compliance officers.

3. **Competitive trust:** Quant developers are privacy-conscious. The plan's own competitive analysis should note that Cursor's data practices are frequently criticized in developer forums.

### Fix Required in Plan

Update Doc 04, "Data Collection" section:

**Server-path data handling must be two-layered:**

1. **Request processing (always):** Code passes through the server for inference. This is essential for the service to function and is covered by ToS under "contractual necessity" (GDPR Art. 6(1)(b)).

2. **Data retention and analytics (opt-in):** The server logs request metadata (timing, token counts, model used) by default for operational purposes (30-day retention). Extended retention, quality signal collection, and code content storage require **explicit** opt-in via account settings, not just ToS acceptance.

**First-use consent flow for server-path users:**
After sign-up, before first inference request, show:
```
Quantlab Cloud processes your coding requests through our servers.

[x] I consent to Quantlab processing my code for inference (required)
[ ] I consent to anonymized usage analytics to improve the service (optional)
[ ] I consent to contributing interaction data to improve QIC models (optional)
```

The first checkbox is required (service cannot function without it). The other two map to `anonymous-metrics` and `data-contributor` tiers.

---

## MEDIUM-13: PII Scrubbing Pipeline is Unspecified

### The Gap

Doc 04 describes a PII scrubbing pipeline:
- Strip email addresses, names from code comments
- Replace file paths with anonymized tokens
- Replace string literals that look like credentials, URLs, or internal hostnames
- Hash session IDs and user IDs

But no implementation details are given. PII scrubbing is notoriously difficult -- false negatives leak private data, false positives corrupt training data.

### Fix Required in Plan

Add to `04-data-pipeline-and-flywheel.md`:

**PII scrubbing specification:**

| PII Type | Detection Method | Action | False Positive Risk |
|----------|-----------------|--------|-------------------|
| Email addresses | Regex: `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b` | Replace with `<EMAIL>` | Low |
| API keys / tokens | Pattern matching (sk-, Bearer, ghp_, etc.) + entropy analysis | Replace with `<SECRET>` | Medium (may catch hash literals) |
| File paths | Starts with `/`, `C:\`, `~` | Replace with `<FILE_N>` (consistent within session) | High (code references paths) |
| URLs | Standard URL regex | Replace domain with `<HOST_N>`, keep path structure | Medium |
| IP addresses | Regex: `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` | Replace with `<IP>` | Low |
| Names in comments | NER model (small, fast) | Replace with `<NAME>` | High (many false positives in code) |

**Recommendation:** Start with regex-based scrubbing (reliable, fast, auditable). Defer NER-based name detection to Phase 6 when accuracy can be validated. Maintain a manual audit process: randomly sample 100 scrubbed records weekly and verify no PII leaks.

**The extension's `secretScanner.ts` already implements some of these patterns** (API key detection with 60+ patterns via `OptimizedSecretScanner`). The server-side PII scrubber should share the same pattern database (published as a JSON pattern file or npm package). The curation pipeline should run the full `SecretPatterns` list against all stored code content as a second pass, with alerts on any matches -- these represent client-side scanning failures that leaked through.

---

## LOW-2: Data Retention Conflicts

### The Gap

The plan has conflicting data retention periods:

| Source | Claim |
|--------|-------|
| Doc 04 (Privacy Architecture) | "Automated deletion after retention period (default: 2 years)" |
| Doc 05 (Plan Tiers table) | Free: 7 days, Pro: 30 days, Enterprise: Custom |

These refer to different things (Doc 04 = training data retention, Doc 05 = usage data retention) but this is not stated explicitly. A reader would see "2 years" and "7 days" for the same system and be confused.

### Fix Required in Plan

Clarify in both documents:

| Data Type | Free Tier | Pro Tier | Enterprise | Training Pipeline |
|-----------|-----------|----------|------------|-------------------|
| Usage logs (token counts, timing) | 7 days | 30 days | Custom | N/A |
| Request metadata | 7 days | 30 days | Custom | 90 days (if consented) |
| Code content (Data Contributors) | N/A | N/A | N/A | 2 years (anonymized) |
| Curated training datasets | N/A | N/A | N/A | Indefinite (anonymized, versioned) |

---

## LOW-3: No Data Deletion Implementation Design

### The Gap

Doc 04 mentions "User can request data deletion via account settings (GDPR)" but provides no implementation details. GDPR deletion (Right to Erasure) is technically challenging when data has been used for fine-tuning.

### Fix Required in Plan

Add to `04-data-pipeline-and-flywheel.md`:

**GDPR data deletion flow:**

1. User requests deletion via account dashboard
2. Server marks all data associated with user's hashed ID as "pending deletion"
3. Raw data: deleted from S3 within 30 days
4. Curated datasets: user's contributions flagged and excluded from future training runs
5. Existing fine-tuned models: NOT retrained immediately (impractical). Instead, the user's data is excluded from the next training cycle. Document this in the privacy policy as "deletion from future model training within 90 days."
6. Aggregated analytics: retained (GDPR allows anonymized aggregate data)
7. Confirmation email sent when deletion is complete

**Note:** This is standard practice (OpenAI, Anthropic, Google all handle fine-tuning data deletion the same way -- data is excluded from future training but existing models are not immediately retrained).

---

## LOW-4: Email Address in JWT Claims

### The Gap

Doc 03 (Server Architecture) includes `"email": "trader@fund.com"` in the JWT claims. This puts PII in every request header, every access log, and every monitoring tool. For privacy-conscious quant fund users, this is problematic -- their email address is replicated across every system that touches the request.

### Fix Required in Plan

Remove `email` from the JWT claims in `03-server-architecture.md`. Use only `sub` (user ID) for request-level identity. Email is available via `GET /v1/account/info` when needed for display. The JWT should contain only: `sub`, `plan`, `scopes`, `iat`, `exp`, `iss`.
