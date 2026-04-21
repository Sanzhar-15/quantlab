# Data Pipeline & Flywheel

## The Strategic Case

The server's primary long-term value is not the proxy infrastructure (commodity) or the subscription revenue (defensible but capped). It's the domain-specific intelligence that accumulates through the data flywheel:

```
Users generate interactions
         |
         v
Data pipeline curates training signal
         |
         v
Fine-tuned quant models improve
         |
         v
Better experience attracts more users
         |
         v
More users generate more interactions
         |
         (cycle accelerates)
```

This document covers the full pipeline from raw interaction data to deployed fine-tuned models.

**Fine-tuned model contingency (LOW-12):** If fine-tuned models never outperform base models, the data flywheel value is in:
1. **Routing optimization** -- the classifier learns which model/tier to use for which request type (30-40% cost reduction)
2. **Prompt engineering** -- domain-specific system prompts tuned using interaction data
3. **Session context intelligence** -- learning which context to include per domain

Phase 6 success criteria should include routing optimization metrics (cost reduction per request, quality-adjusted) alongside raw model quality metrics. The moat may not be "better models" but "smarter routing."

---

## Data Collection

### What We Collect (Server-Path Users)

**IMPORTANT:** Server-path data collection has two layers (MEDIUM-12):

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

**Request metadata (operational, 30-day retention):**
- Timestamp, lane, model tier, actual model used
- Input token count, output token count
- Time-to-first-token, total response time
- Tool calls made (names only, not arguments)
- Stop reason (end_turn, tool_use, max_tokens)
- Error codes (if any)

**Session-level data (operational, 30-day retention):**
- Session duration, number of exchanges
- Lane transitions (e.g., chat-ask -> chat-plan -> chat-act)
- Tool usage patterns
- Context window utilization (how close to budget limits)

**Quality signals (requires instrumentation -- see below):**
- Accept/reject: did the user use the completion or dismiss it?
- Edit distance: how much did the user change the AI's suggestion?
- Re-request: did the user immediately retry with a rephrased prompt?
- Follow-up pattern: did the tool result lead to another tool call or did the user take over?
- Conversation length before goal achieved

**What we explicitly DO NOT collect by default:**
- Raw code content (messages, tool arguments, tool results)
- File paths (may reveal project structure)
- User's prompt text

This distinction is critical. Metadata + quality signals are enough for routing optimization and usage analytics. Code content is only collected with explicit opt-in (Data Contributor tier).

### Quality Signal Architecture (HIGH-10)

**None of the quality signals listed above exist in the codebase.** The `completionEngine.ts` has no accept/reject tracking. The `qicInlineCompletionProvider.ts` provides completions but does not observe whether they were accepted. There is no edit distance computation. There is no re-request detection.

**This must be built as a Phase 1 prerequisite:**

1. **Completion acceptance tracking:** Hook into VS Code's `InlineCompletionItemProvider.handleDidPartiallyAcceptCompletionItem()` and `handleDidShowCompletionItem()`. Record: completion shown timestamp, accepted/rejected/partial, time-to-decision. Store locally in SQLite.

2. **Edit distance tracking:** On completion accept: snapshot the accepted text. After 10 seconds (debounced): compare accepted text with current buffer content. Compute Levenshtein distance ratio. Store locally.

3. **Re-request detection:** Track when the same lane receives a request within 30 seconds of a previous error or rejection. Flag as "retry."

4. **Follow-up pattern tracking:** In the orchestrator, when a tool result is followed by another LLM call vs. user taking over (no new message for 60s), record the pattern.

**Critical: server-path correlation.** Each quality signal must include a `requestId` (the `X-QIC-Request-ID` from the original inference request) to link extension-side quality observations to server-side request logs. Without this linkage, the server has timing/token data and the extension has accept/reject data, but they cannot be joined for training pair construction:

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

Data is collected locally regardless of consent tier. Transmission depends on `DataTier`:
- For server-path users: quality signal metadata should be sent via the telemetry endpoint in Phase 2 (not Phase 5) -- this is metadata, not code content.
- For BYOK users: depends on their `DataTier` setting.

### What We Collect (Data Contributors -- Opt-In)

Users who explicitly opt into data contribution provide:

**Full interaction data:**
- Complete prompt/response pairs
- Tool call arguments and results
- File paths and code snippets
- The full context window content

**Enhanced quality signals:**
- Git diff between AI suggestion and user's final code
- Time spent reviewing before accept/reject
- Whether the code passed tests after apply

**Compensation:**
- Free or discounted server access
- Priority queue for requests
- Early access to fine-tuned models

### Collection Architecture

```
Extension                              Server
   |                                     |
   | [inference request as normal]       |
   | ----------------------------------> |
   |                                     |-- Log: metadata + timing
   |                                     |-- Async: write to event stream
   |                                     |
   | [Quality signals (Phase 2+):]       |
   | POST /v1/telemetry/interaction      |
   | (batched, async, every 60s)         |
   | ----------------------------------> |
   |                                     |-- Write to telemetry queue
```

For server-path users, request metadata collection is server-side and invisible to the extension. For quality signals and data contributors (including BYOK contributors), the extension batches and sends interaction data asynchronously via a dedicated telemetry endpoint.

**Telemetry transport (must be built):** The existing `telemetryService.ts` has **no network code**. Its `flush()` method only calls `egressEnforcer.checkAndSanitize()` and does nothing with the result. A `TelemetryTransport` must be built that:
1. Collects events in a local buffer (already exists)
2. Serializes events as JSON batches
3. Sends via `POST /v1/telemetry/interaction` through the egress enforcer
4. Handles failures gracefully (retry with exponential backoff, drop after 3 failures)
5. Respects `DataTier` for what events to include

---

## Data Pipeline

### Stage 1: Ingestion

```
Raw events --> NATS/Kafka topic --> S3 (raw data lake)
                   |
                   v
            Stream processor
            (deduplication,
             schema validation,
             PII scrubbing)
                   |
                   v
            S3 (cleaned data lake)
```

**PII scrubbing specification (MEDIUM-13):**

| PII Type | Detection Method | Action | False Positive Risk |
|----------|-----------------|--------|-------------------|
| Email addresses | Regex: `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b` | Replace with `<EMAIL>` | Low |
| API keys / tokens | Pattern matching (sk-, Bearer, ghp_, etc.) + entropy analysis | Replace with `<SECRET>` | Medium (may catch hash literals) |
| File paths | Starts with `/`, `C:\`, `~` | Replace with `<FILE_N>` (consistent within session) | High (code references paths) |
| URLs | Standard URL regex | Replace domain with `<HOST_N>`, keep path structure | Medium |
| IP addresses | Regex: `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` | Replace with `<IP>` | Low |
| Names in comments | NER model (small, fast) | Replace with `<NAME>` | High (many false positives in code) |

**Recommendation:** Start with regex-based scrubbing (reliable, fast, auditable). Defer NER-based name detection to Phase 6 when accuracy can be validated. Maintain a manual audit process: randomly sample 100 scrubbed records weekly and verify no PII leaks.

**Pattern reuse from extension:** The extension's `secretScanner.ts` already implements API key detection with 60+ patterns via `OptimizedSecretScanner`. The server-side PII scrubber should share the same pattern database (published as a JSON pattern file or npm package). The curation pipeline should run the full `SecretPatterns` list against all stored code content as a second pass, with alerts on any matches -- these represent client-side scanning failures.

### Stage 2: Quality Filtering

Not all interactions are useful for training. Quality filters:

**Positive signals (include):**
- Completion accepted with <10% edit distance (AI got it right)
- Multi-turn tool use sessions that completed successfully
- Code that passed subsequent test runs
- Interactions with explicit thumbs-up

**Negative signals (include as negative examples):**
- Completions immediately rejected
- Repeated retries of the same prompt (model struggled)
- Tool executions that returned errors
- Interactions with explicit thumbs-down

**Filter out (discard):**
- Trivial interactions (single-token completions, "hi" messages)
- Corrupted/incomplete sessions
- Obvious test/debugging sessions (e.g., repeated "test" messages)
- Content flagged by safety filters

### Stage 3: Curation

Transform filtered interactions into training-ready datasets.

**Instruction tuning pairs:**
```json
{
    "system": "<lane-specific system prompt>",
    "instruction": "<user's request>",
    "context": "<relevant code context>",
    "response": "<AI's response that was accepted>",
    "metadata": {
        "lane": "chat-act",
        "domain": "quantitative-finance",
        "quality_score": 0.92,
        "tools_used": ["read_file", "write_file", "run_command"]
    }
}
```

**Domain tagging:**
Automatically classify interactions by domain:
- `quantitative-finance`: mentions of backtesting, portfolio, risk, alpha, Sharpe, drawdown
- `data-science`: pandas, numpy, scipy, matplotlib, data cleaning
- `systems-programming`: networking, concurrency, OS, performance
- `web-development`: React, API, frontend, CSS
- `general-coding`: everything else

Quant-domain interactions are the most valuable and receive higher weight in fine-tuning.

**Preference pairs (for RLHF/DPO):**
When we have both an accepted and rejected response for similar prompts:
```json
{
    "instruction": "<prompt>",
    "chosen": "<response that was accepted>",
    "rejected": "<response that was rejected/edited>",
    "domain": "quantitative-finance"
}
```

### Stage 4: Dataset Storage

```
Curated datasets --> S3 (versioned, immutable)
                        |
                  +-----+-----+
                  |           |
          Training sets    Eval sets
          (90%)            (10%)
```

Datasets are versioned and immutable. Each fine-tuning run references a specific dataset version. Eval sets are held out for benchmarking.

---

## Fine-Tuning Pipeline

### Phase 6: Domain-Specialized Models (Long-Term)

Once we have sufficient data (target: 100K+ curated instruction pairs), begin fine-tuning.

**Base models for fine-tuning:**
- Fast tier: Llama 3 8B or Qwen 2.5 Coder 7B (open weights, hostable on Fireworks/Together)
- Coding tier: Llama 3 70B or Codestral (open weights)
- Reasoning tier: Not fine-tuned initially (use Claude Opus/o1 directly)

**Fine-tuning approach:**
1. Supervised Fine-Tuning (SFT) on curated instruction pairs
2. Direct Preference Optimization (DPO) using preference pairs
3. Domain-specific continued pre-training on public quant codebases (QuantConnect, Zipline, Lean)

**Evaluation:**
- HumanEval / MBPP for general coding
- Custom quant eval suite:
  - Backtest implementation from spec
  - Risk metric calculation
  - Data pipeline construction
  - Signal generation and portfolio construction
  - NumPy/Pandas operations
- A/B testing: serve fine-tuned model to 10% of users, compare quality signals

**Deployment:**
- Fine-tuned models hosted on Fireworks or Together (managed GPU inference)
- Integrated into the provider multiplexer as additional model options
- The router sends quant-domain requests to fine-tuned models, general requests to base models

### The Competitive Moat

After 12+ months of data collection:

```
Quantlab fine-tuned models know:
  - Common quant library patterns (numpy, pandas, scipy for finance)
  - Backtesting framework idioms (Zipline, Lean, custom engines)
  - Risk model implementation patterns
  - Market data pipeline best practices
  - Quantlab-specific tool usage patterns
  - How experienced quant developers edit and refine AI suggestions
```

No competitor has this data because no competitor has a quant-focused AI coding tool with server-side data collection. This is the moat.

---

## Privacy Architecture

### Three-Tier Consent (DataTier)

The existing `consentStore.ts` manages consent *scopes* (Session, Workspace, Global -- how long consent lasts). The data *level* (what data is shared) is a separate concept managed via the `DataTier` setting:

```typescript
export type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';
```

| DataTier | What's collected | What's sent | Used for |
|----------|------------------|-------------|----------|
| **Private** (default) | Local quality signals only | Nothing | N/A |
| **Anonymous Metrics** | Quality signals + session metadata | Metadata only (no code) | Product analytics, routing optimization |
| **Data Contributor** | Full interaction data including code | Everything | Fine-tuning, all of the above |

### Server-Path Users

**Two-layered consent (MEDIUM-12):**

1. **Request processing (always, contractual necessity):** Code passes through the server. Not stored beyond request lifetime.
2. **Analytics and retention (opt-in):** Extended metadata retention, quality signal correlation, code content storage all require explicit opt-in via the first-use consent flow.

### Technical Enforcement

```
Extension side:
  - DataTier 'private': telemetry endpoint never called
  - DataTier 'anonymous-metrics': send only metadata events
  - DataTier 'data-contributor': send full interaction events
  - Wire DataTier into telemetryService:
      if (dataTier === 'private') return;
      if (dataTier === 'anonymous-metrics' && event.containsCodeContent) return;

Server side:
  - Rate-limit telemetry ingestion (prevent abuse)
  - PII scrubber runs on all stored data
  - Automated deletion after retention period (see below)
  - User can request data deletion via account settings (GDPR)
```

### Data Retention Policy (LOW-2)

| Data Type | Free Tier | Pro Tier | Enterprise | Training Pipeline |
|-----------|-----------|----------|------------|-------------------|
| Usage logs (token counts, timing) | 7 days | 30 days | Custom | N/A |
| Request metadata | 7 days | 30 days | Custom | 90 days (if consented) |
| Code content (Data Contributors) | N/A | N/A | N/A | 2 years (anonymized) |
| Curated training datasets | N/A | N/A | N/A | Indefinite (anonymized, versioned) |

### GDPR Data Deletion Flow (LOW-3)

1. User requests deletion via account dashboard
2. Server marks all data associated with user's hashed ID as "pending deletion"
3. Raw data: deleted from S3 within 30 days
4. Curated datasets: user's contributions flagged and excluded from future training runs
5. Existing fine-tuned models: NOT retrained immediately (impractical). Instead, the user's data is excluded from the next training cycle. Document this in the privacy policy as "deletion from future model training within 90 days."
6. Aggregated analytics: retained (GDPR allows anonymized aggregate data)
7. Confirmation email sent when deletion is complete

This is standard practice (OpenAI, Anthropic, Google all handle fine-tuning data deletion the same way).

### Data Access Controls

- Raw data: accessible only by ML engineering team
- Curated datasets: accessible by ML team + reviewed by privacy officer
- Fine-tuned models: deployed to production via standard MLOps pipeline
- No individual user data is ever exposed in model outputs (verified via eval)

---

## Metrics & Monitoring

### Data Pipeline Health

| Metric | Target | Alert |
|--------|--------|-------|
| Ingestion lag | <5 min | >15 min |
| PII scrub false negative rate | <0.1% | >1% |
| Dataset curation throughput | 10K pairs/day | <1K pairs/day |
| Eval score (quant suite) | Improving quarter-over-quarter | Regression |

### Flywheel Velocity

| Metric | Phase 2 Target | Phase 5 Target |
|--------|---------------|----------------|
| Daily interactions | 10K | 1M |
| Data contributor % | 5% of users | 15% of users |
| Curated instruction pairs (total) | 10K | 500K |
| Quant-domain pairs | 2K | 100K |
| Fine-tuned model quality vs base | N/A | +15% on quant eval |
