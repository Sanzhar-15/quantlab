# QIC v6.2 Deep Audit Report

**Auditor**: Claude Opus 4.5  
**Date**: 1 February 2026  
**Scope**: QIC Technical Specification v6.2 (~8,465 lines) + Implementation Plan v3 Final (~2,274 lines)  
**Methodology**: Line-by-line cross-referencing, architectural consistency analysis, completeness verification, optimality assessment

---

## Audit Verdict: Summary

Both documents are **exceptionally thorough** for their stage of maturity. The spec is among the most implementation-ready AI-tool specifications I have encountered — it defines types, interfaces, algorithms, error codes, and invariants at a level that genuinely enables LLM-driven implementation. The implementation plan is equally strong: dependency-ordered, gate-enforced, with explicit stub contracts and anti-patterns.

That said, this audit identifies **7 critical findings**, **12 high-severity findings**, and **9 medium-severity findings** that, if left unaddressed, will cause either implementation failure, runtime defects, or significant rework.

| Severity | Count | Impact |
|----------|-------|--------|
| CRITICAL | 7 | Would prevent end-to-end operation or cause data loss |
| HIGH | 12 | Significant gaps; workarounds possible but costly |
| MEDIUM | 9 | Sub-optimal; LLM implementor would produce working but inferior code |

---

## Part I: Cross-Document Inconsistencies

### C-1 · CRITICAL — Spec §15.1 vs Implementation Plan Phasing Are Incompatible

The spec's own §15.1 (lines 8114–8177) defines a **7-phase, ~6-week** implementation plan. The implementation plan document defines a **12-phase, 17–19 week** plan. These are not merely different granularities — they contradict on ordering and grouping:

| Component | Spec §15.1 Phase | Impl Plan Phase |
|-----------|-----------------|-----------------|
| Rate Limiter | Phase 1 (Foundation) | Phase 4 (Network) |
| Streaming Handler | Phase 1 (Foundation) | Phase 4 (Network) |
| Degradation Manager | Phase 4 (Performance) | Phase 6 (Completion & Resilience) |
| Memory Manager | Phase 4 (Performance) | Phase 6 (Completion & Resilience) |
| Request Prioritisation | Phase 4 (Performance) | Phase 4 (Network) |
| Completion Tiers | Phase 4 (Performance) | Phase 6 (Completion & Resilience) |
| Model Registry | Phase 4 (Performance) | Phase 6 (Completion & Resilience) |
| Dynamic Tool Selection | Phase 5 (Security Hardening) | Phase 5 (Agent Runtime) |

**Risk**: An LLM implementor given both documents will be confused about which to follow. The implementation plan is clearly the superior document (more granular, dependency-ordered, gate-enforced), but the spec's §15.1 hasn't been updated to match.

**Recommendation**: Either (a) remove §15.1 from the spec entirely and reference the implementation plan as the authoritative phase ordering, or (b) update §15.1 to exactly mirror the implementation plan's 12-phase structure. Option (a) is cleaner.

---

### C-2 · HIGH — Rate Limiter Provider Limits Disagree

The spec (§9.3, line 5700–5724) defines provider limits as:
- Anthropic: 60 RPM, 100K TPM
- OpenAI: 60 RPM, 90K TPM

The implementation plan (line 1090) states:
- Anthropic: 50 RPM, 500K TPM
- OpenAI: 60 RPM, 800K TPM

And the Phase 4 gate (line 1134) tests against "50 RPM Anthropic limit."

**Risk**: The LLM implementor will hard-code whichever value it sees last. The actual limits depend on the user's API tier and change frequently.

**Recommendation**: Neither document should hard-code provider rate limits. Instead, define configurable defaults with header-based auto-discovery (the spec already specifies header mapping at lines 5706–5719). The hard-coded values should be labelled as "conservative defaults, overridden by response headers." Both documents should use the same defaults.

---

### C-3 · HIGH — INV-T1 ENFORCEMENT References Stale `AtomicMultiFileWriter`

The spec's INV-T1 enforcement block (line 983) still reads: *"AtomicMultiFileWriter ensures all-or-nothing application"*. This should reference `JournaledAtomicWriter` — the V6.2 replacement. Similarly, INV-T5 (line 1079) references `AtomicMultiFileWriter with staging directory`.

The implementation plan correctly uses `JournaledAtomicWriter` everywhere and even has a CI check (§14.2 check 7) to grep for stale references. But the spec itself would fail this check.

**Recommendation**: Find-and-replace all `AtomicMultiFileWriter` references in the spec with `JournaledAtomicWriter`.

---

### C-4 · HIGH — Model Identifiers Are Stale

Both documents reference models that are already deprecated or superseded as of February 2026:
- `claude-3-5-sonnet-20241022` → likely superseded by Claude 4 family
- `claude-3-haiku-20240307` → likely superseded
- `claude-3-opus-20240229` → likely superseded
- `gpt-4o-mini` → possibly superseded

The spec's §4.5 (Model Version Management) correctly implements alias resolution and deprecation detection, but the hard-coded model recommendations in §4.2 (lines 3119–3183) use pinned model IDs that are likely already deprecated.

**Recommendation**: Replace all pinned model IDs in §4.2 with aliases (`claude-latest-fast`, `claude-latest-smart`, `openai-latest`, etc.) and let the ModelRegistry resolve them. This is exactly what the ModelRegistry is designed for — the spec should dogfood its own abstraction.

---

### C-5 · MEDIUM — Token Budget for `chat-plan` and `chat-act` Not Specified in Context Assembler

The spec's §4.3 (Token Budget Specification, lines 3185–3226) only defines budgets for `completion`, `chat` (32K), and `gather` (64K). It does not define explicit budgets for `chat-plan`, `chat-act`, `repair`, `fast-apply`, or `summarize`. Meanwhile, the LANE_CONFIGURATIONS (lines 548–645) define token budgets for all 8 lanes (e.g., chat-plan: 64K input / 8K output, fast-apply: 8K/2K).

The implementation plan's §5.4 (Context Assembler, line 1198) only lists 3 budget profiles (completion, chat, gather), which would leave 5 lanes without explicit context assembly rules.

**Recommendation**: The Context Assembler should either (a) have explicit budget profiles for all 8 lanes, or (b) explicitly document a mapping rule (e.g., `chat-plan` and `chat-act` use the `gather` profile; `repair` and `fast-apply` use a cut-down profile). The current implicit mapping is ambiguous.

---

### C-6 · MEDIUM — `get_definition` Tool Missing from `chat-gather` Allowed Tools

The spec's `chat-gather` lane configuration (line 578) includes: `read_file`, `search_code`, `search_files`, `get_references`, `list_directory`, `inspect_notebook`, `preview_dataframe`.

It omits `get_definition`, which is included in `chat-ask` (line 566). A "gather" operation that can look up references but not jump to definitions is artificially constrained — gathering context typically requires understanding where symbols are defined.

**Recommendation**: Add `get_definition` to `chat-gather`'s `allowedTools` list.

---

## Part II: Spec Findings

### S-1 · CRITICAL — No Specification for the Agent Orchestrator

The spec defines every component (StepExecutor, ToolRouter, Gateway, ContextEngine, LaneRouter) but **never specifies the orchestration loop** that connects them. There is no `AgentOrchestrator` class, no `handleUserMessage()` method, no specification of how tool call results are fed back to the LLM for multi-turn tool use.

The implementation plan (§5.9, lines 1281–1380) fills this gap brilliantly with a complete `AgentOrchestrator` class and pseudocode. But the spec — the authoritative document — doesn't contain it.

**Risk**: The spec is incomplete as a standalone document. Anyone reading only the spec would know what every organ does but not how the body works.

**Recommendation**: Add a §7.3 "Agent Orchestrator" section to the spec that formalises the loop: message → lane classification → context assembly → LLM call → tool call processing → response streaming → state transitions. This can be adapted from the implementation plan's §5.9.

---

### S-2 · CRITICAL — No Specification for Lane Routing Logic

Related to S-1: the spec defines 8 lanes with complete configurations but provides **no specification for how a user message gets classified into a lane**. There is no `LaneRouter`, no classification strategy, no escalation rules.

The implementation plan (§5.8, lines 1260–1279) fills this gap with a priority-ordered classification strategy. But the spec should be the source of truth.

**Recommendation**: Add a §4.6 "Lane Classification" section to the spec that specifies the classification algorithm, escalation rules, and default lane.

---

### S-3 · CRITICAL — No Provider Adapter Interface Specification

The spec defines `ProviderAdapter` as an interface (in §3.5) with methods like `sendRequest()`, `isAvailable()`, `getHealth()`. But it provides **no specification for provider-specific concerns**: authentication methods, streaming format differences, error shape normalization, FIM marker handling, rate limit header parsing.

The implementation plan (§4.2, lines 1039–1080) provides detailed specifications for all 3 adapters. Again, this critical detail lives only in the implementation plan.

**Recommendation**: Add a §9.5 "Provider Adapter Specifications" section covering Anthropic, OpenAI, and Ollama concrete adapters with auth, streaming format, error shape, and model-specific concerns.

---

### S-4 · HIGH — `PersistentAgentStateMachine.recover()` References Undefined `this.ui`

The spec's `PersistentAgentStateMachine.recover()` static method (lines 2358–2378) calls `machine.ui.showInfo(...)`. But `ui` is not a constructor parameter or property of `PersistentAgentStateMachine`. The class constructor (lines 2332–2337) takes only `db` and `sessionId`.

**Recommendation**: Either (a) add `ui: UIService` as a constructor parameter, or (b) pass `UIService` as a parameter to `recover()`, or (c) return the recovery state and let the caller handle UI notification. Option (c) is cleanest because `recover()` is a static factory method and should not depend on UI.

---

### S-5 · HIGH — `PersistentTaskStateMachine.recover()` Does Not Restore `failedSteps`

The spec's `PersistentTaskStateMachine.recover()` (lines 2421–2441) restores `completedSteps` from `completed_steps_json` but sets `failedSteps: []` (line 2436). The `failed_steps` are not persisted to the database at all — the schema (lines 2297–2310) has no `failed_steps_json` column.

**Risk**: After crash recovery, the system loses knowledge of which steps previously failed, potentially retrying them incorrectly.

**Recommendation**: Add `failed_steps_json TEXT` to the `qic_task_state` schema and persist/restore it.

---

### S-6 · HIGH — Conversation Cipher Uses Two Different Crypto APIs

The spec (§5.3, lines 3600–3716 as referenced by implementation plan line 887–894) specifies both Node.js `crypto.randomBytes(12)` for IV generation AND Web Crypto API `crypto.subtle` for encrypt/decrypt. These are two different APIs in two different runtimes. In a VS Code extension (Node.js context), you should use `node:crypto` consistently. The Web Crypto API is for webview contexts.

**Recommendation**: Use `node:crypto` for all crypto operations in the extension host. Reserve `crypto.subtle` for any webview-side crypto (which should be minimal).

---

### S-7 · HIGH — BM25 Index Schema Not Fully Specified

The spec references BM25 tables (§5.2, lines 3538–3592) with `qic_bm25_` prefix but does not provide the full SQL schema (column definitions, data types, indexes). The implementation plan references `qic_bm25_terms`, `qic_bm25_postings`, `qic_bm25_docs` (line 1174) but also doesn't define the schema.

For a "implementation-ready" spec, the BM25 schema is a notable gap. The LLM implementor will need to design the BM25 storage schema from scratch.

**Recommendation**: Add the complete BM25 SQL schema to §5.2, including the term frequency table, document length table, posting list table, and the IDF computation approach.

---

### S-8 · HIGH — `inspect_notebook` and `preview_dataframe` Tools Marked `hasSideEffects: true`

In Appendix A (lines 8218–8220), `inspect_notebook`, `preview_dataframe`, and `analyze_backtest` are all marked `hasSideEffects: true`. But notebook inspection and DataFrame preview are read-only operations. Only `analyze_backtest` arguably has side effects (spawning the Python sidecar).

Marking read-only tools as having side effects means they'll unnecessarily require user permission every time, degrading the user experience.

**Recommendation**: Set `hasSideEffects: false` for `inspect_notebook` and `preview_dataframe`. If they require the Python sidecar, the sidecar startup is an implementation detail, not a user-facing side effect.

---

### S-9 · HIGH — No `web_search` Tool Implementation Anywhere

The tool registry includes `web_search` (Appendix A, line 8207), and it appears in `chat-act`'s wildcard tool access. But neither the spec nor the implementation plan specifies what `web_search` does, what API it calls, what provider it uses, or how results are formatted.

Unlike `web_fetch` (which is a simple HTTP GET), a search tool needs a search provider (Bing, Google, SerpAPI, etc.), result formatting, and consent/egress handling.

**Recommendation**: Either (a) specify the `web_search` implementation (provider, API, result format) in the spec and implementation plan, or (b) remove it from the tool registry and add it as a future item. An unspecified tool will cause the LLM implementor to either skip it or hallucinate an implementation.

---

### S-10 · MEDIUM — RRF Reranker Formula Has Subtle Issue

The spec's RRF implementation (§8.3, lines 5350–5378) applies weights to RRF scores: `score += source.weight * (1 / (k + rank))`. In standard RRF, weights are applied per-source but the formula is `Σ 1/(k + rank_i)` without per-source weights. The weighted variant is fine, but the spec's formula description (line 5346) says `'∑ 1/(k + rank_i) for each source'` — which omits the weights.

**Recommendation**: Update the formula description to include weights: `'∑ weight_i / (k + rank_i) for each source'`. The code is correct; the description is not.

---

### S-11 · MEDIUM — No Google/Gemini Provider in Adapter Specifications

The spec's rate limiter (§9.3, line 5720) includes Google provider limits (60 RPM, 120K TPM), suggesting Google/Gemini is a supported provider. But there is no Google adapter specification, no Google entry in the model recommendations (§4.2), and the implementation plan only builds 3 adapters (Anthropic, OpenAI, Ollama).

**Recommendation**: Either add a Google adapter specification or remove the Google entry from the rate limiter config. Having phantom provider limits creates confusion.

---

### S-12 · MEDIUM — No Specification for How Checkpoints Interact with Git

The spec thoroughly specifies QIC's own checkpoint system but never addresses its relationship with git. In a real quant workspace, developers use git extensively. Questions left unanswered: Do QIC checkpoints complement git stash? Should checkpoint restore also affect the git index? Should checkpoint create also create a git stash or commit? Can checkpoints be used to restore files that were also modified by git?

**Recommendation**: Add a brief section clarifying that QIC checkpoints are independent of git and operate at the file-content level only. Optionally, add a `create_checkpoint` enhancement that creates a git stash as a parallel backup.

---

## Part III: Implementation Plan Findings

### I-1 · CRITICAL — Agent Orchestrator Tool Call Loop Is Not Actually Recursive

The implementation plan's `handleUserMessage()` (lines 1308–1371) processes the response stream and handles tool calls inline. However, after executing a tool and calling `this.conversationState.addToolResult(...)`, the code has a comment "Re-send with tool result appended — Gateway handles this" (line 1356) but **there is no actual re-send**. The `for await` loop continues reading from the original stream, but the stream has already ended at the tool call — there's no mechanism to send the tool result back and get a new stream.

This is the most common mistake in agentic loop implementations. The tool call loop requires either:
1. A recursive call to the Gateway with the accumulated conversation (including tool result), or
2. A while-loop that continues until the LLM produces a non-tool-call response.

**Risk**: As written, the first tool call would execute but the result would never be sent back to the LLM. Multi-tool interactions (the core agentic capability) would be completely broken.

**Recommendation**: Replace the `for await` stream processing with an explicit agentic loop:
```
while (true) {
  stream = gateway.sendStreaming(messages)
  for await chunk of stream:
    if text: stream to UI
    if tool_call: execute, append result to messages, break inner loop
    if done: return (exit outer loop)
}
```

---

### I-2 · CRITICAL — No Specification for How `fast-apply` and `completion` Lanes Bypass the Orchestrator

The implementation plan (line 1378) states: *"For the `completion` lane, the CompletionEngine (Phase 6) handles the loop directly — it doesn't go through the orchestrator."* And line 1379: *"For `fast-apply`, the orchestrator skips the plan phase and directly applies the edit."*

But neither bypass is specified. How does the CompletionEngine handle inline completions? It needs the full context assembly pipeline, the Gateway, and the streaming handler — but not the tool router or step executor. This "thin path" through the system is unspecified.

**Recommendation**: Add explicit flow diagrams for the completion path (keystroke → debounce → context assembly → LLM → ghost text) and the fast-apply path (selection → context → LLM → edit script → preview → apply).

---

### I-3 · CRITICAL — Phase 2 Depends on Phase 1, But Security Should Block Before Foundation Is Complete

The dependency graph shows Phase 2 (Security) depends on Phase 1 (Foundation — types, storage, state machines). But the spec's design philosophy states: "Consent before egress" and "No data leaves the system without explicit user consent."

The problem: Phase 1 includes storage initialisation which involves creating SQLite tables. If the LLM implementor tests Phase 1 in isolation (which the gate encourages), they might inadvertently create egress-free paths that persist into later phases. The `EgressBoundaryEnforcer` from Phase 2 needs to wrap ALL external calls from the moment they're first coded — not after the fact.

**Recommendation**: Phase 2's `EgressBoundaryEnforcer` should be implemented as a thin wrapper (block-all-by-default) in Phase 0 or Phase 1, even before the full consent system is ready. This ensures the security invariant is never violated, even during development. The implementation plan's stub pattern would work well here — a stub `EgressBoundaryEnforcer` that blocks all egress until Phase 2 replaces it with the real implementation.

---

### I-4 · HIGH — No Error Handling in Activation Sequence for Partial Failures

The activation sequence (lines 366–427) is a linear chain of `await` calls. If step 6 (Gateway initialization) fails but step 1–5 succeeded, the extension is in an inconsistent state: database initialized, security layer active, but no Gateway. There's no try/catch, no rollback, and no degraded-start path.

**Recommendation**: Wrap the activation sequence in a try/catch that:
1. Records which steps completed successfully
2. On failure, transitions to DEGRADED state instead of crashing
3. Shows the user a meaningful error ("QIC started in limited mode: AI features unavailable. Error: [provider auth failed]")
4. Allows retry without full extension reload

---

### I-5 · HIGH — No Handling of Concurrent `handleUserMessage` Calls

The `AgentOrchestrator.handleUserMessage()` transitions the agent state to PROCESSING and assumes sequential execution. But what if the user sends a second message while the first is still being processed? The state machine would reject the transition (PROCESSING → PROCESSING is not valid per the spec), and the second message would throw.

**Recommendation**: Add message queuing in the orchestrator: if agent is PROCESSING, queue the incoming message and notify the user ("Processing your previous request..."). Alternatively, cancel the current interaction and start the new one (with user confirmation).

---

### I-6 · HIGH — Phase 7 (UI) Depends on Phase 6, But Several Phase 5 Components Need UI Stubs

The dependency graph shows Phase 7 (UI) depends on Phase 6 (Completion). But Phase 5 (Agent Runtime) already needs `UIService` for the permission dialog, diff preview, and chat streaming. The plan addresses this with UI stubs (lines 2058–2064), but the stub for `showDiffPreview` returns a "mock ApprovalToken."

**Risk**: A mock ApprovalToken means that during Phase 5–6 testing, all edits are auto-approved without user review. This violates INV-T1 during development. If any test code assumes auto-approval, it may not be caught until Phase 7.

**Recommendation**: The stub `showDiffPreview` should log a prominent warning AND require an environment variable or test flag (`QIC_AUTO_APPROVE_FOR_TESTING=true`) to prevent accidental auto-approval in any context other than automated tests.

---

### I-7 · HIGH — No Webview Communication Protocol Specified

Phase 7 builds the chat panel as a VS Code webview. Webviews communicate with the extension host via `postMessage()`. But neither the spec nor the implementation plan defines the message protocol between the webview and the extension host (message types, payload shapes, error handling, serialization).

This is a significant omission because the chat panel is the primary user interaction surface, and the message protocol determines the entire user experience.

**Recommendation**: Add a message protocol specification to Phase 7 with defined message types: `{ type: 'user-message', text: string }`, `{ type: 'stream-token', text: string }`, `{ type: 'tool-call-started', name: string }`, `{ type: 'diff-preview', edits: EditScript }`, `{ type: 'permission-request', tool: string }`, etc.

---

### I-8 · HIGH — `SessionCache` Key Hashing May Cause False Cache Hits

The implementation plan (line 1851) defines session cache key hashing as "hash of model + messages + tools + temperature." But if a user sends the same message twice in a conversation, the conversation history will be different (the second message includes the first response), yet the cache key might match if only the last user message is hashed.

**Recommendation**: The cache key should hash the **entire** messages array (including conversation history), not just the user's message. Or explicitly document that caching only applies to identical complete request payloads.

---

### I-9 · MEDIUM — LSP Tools Placed in Phase 9 But Phase 8 (Security Hardening) Tests Tool Completeness

The Phase 8 gate (line 1677) tests "Dynamic tool selection: stays within 2000-token budget; essential tools always present." But at Phase 8, only 19 of 22 tools are implemented (the 3 LSP tools come in Phase 9). This means Phase 8's tool selection tests operate against an incomplete tool registry.

**Recommendation**: Either move LSP tools to Phase 8 alongside security hardening (they're small — just wrappers around VS Code commands), or explicitly note in Phase 8's gate that tool completeness will be 19/22 and re-verified at Phase 9.

---

### I-10 · MEDIUM — No Guidance on Token Counting Implementation

Both documents reference token counting extensively (token budgets, context assembly, tool schema token costs) but neither specifies how tokens are actually counted. Options include: tiktoken library (OpenAI's tokenizer), Anthropic's tokenizer, a fast approximation (chars/4), or per-provider tokenizers.

**Recommendation**: Specify the token counting strategy. For cross-provider compatibility, `tiktoken` with the `cl100k_base` encoding is a reasonable default (overestimates slightly for Anthropic, which is safer than underestimating). Add `tiktoken` to npm dependencies.

---

### I-11 · MEDIUM — Risk Register Missing Key Risks

The risk register (lines 2222–2233) covers infrastructure risks but misses:
1. **LLM hallucination of file paths**: The LLM may generate tool calls with non-existent file paths, requiring validation.
2. **Prompt injection via code**: Malicious code in the workspace could contain instructions that manipulate the LLM's behaviour through context injection.
3. **Embedding model dimensional mismatch**: If the user switches embedding providers, existing vector indexes become incompatible (different dimensions).
4. **Extension activation timeout**: VS Code has a default 60-second activation timeout. The 12-step activation sequence with crash recovery, database initialization, and background indexing could exceed this.

**Recommendation**: Add these to the risk register with mitigations.

---

### I-12 · MEDIUM — Dependency Graph Has a Hidden Cycle

The dependency graph (lines 301–327) shows: `canonical → storage → crash-safe → state → security → mutation → runtime → gateway → context → completion → resilience`. But in the anti-patterns section (line 295), it states this is a strict ordering.

However, the Gateway (Phase 4) depends on the Circuit Breaker (Phase 3, in `recovery/`). And the Agent Orchestrator (Phase 5) depends on the MutationEngine (Phase 3). These are reverse-direction dependencies that aren't reflected in the stated ordering. The actual dependency graph is a DAG, not a chain.

**Recommendation**: Replace the linear dependency chain with the actual DAG. The implementation plan's phase dependency graph (lines 301–327) is correct; the anti-pattern statement about the ordering being strictly layered is misleading.

---

## Part IV: Optimality Assessment

### Spec Optimality

**What's excellent:**
- The invariant system (INV-T1 through INV-A4) with formal notation, enforcement mechanisms, and testability criteria is best-in-class.
- The `FileContent` discriminated union for large file handling is a clean, type-safe solution.
- The `JournaledAtomicWriter` transaction protocol is thorough and handles edge cases (Windows, HDD, disk full).
- The 8-lane architecture with per-lane token budgets, allowed tools, and prompt templates is well-designed and extensible.
- The Aho-Corasick secret scanner with streaming support and 60+ patterns is production-grade.
- The error code registry with categories and user messages is thoughtful.
- The `FlexibleMatcher` with 7 graduated strategies is a pragmatic approach to the edit-application problem.

**What could be more optimal:**
1. **The spec is too long.** At 8,465 lines, it mixes specification (what to build) with implementation (how to build it — literal TypeScript class bodies). A spec should define interfaces and behaviours; the implementation plan should define implementation details. Currently, the spec contains full class implementations (e.g., `RateLimiter` is ~190 lines of TypeScript), which means the LLM implementor must decide whether to copy-paste these or treat them as reference implementations. Recommendation: Separate pure interface definitions from reference implementations. Mark reference implementations clearly as "illustrative, not prescriptive."

2. **Missing abstraction layer for embedding providers.** The `SecureEmbeddingService` talks directly to providers. But embedding is a cross-cutting concern that should go through the Gateway (which handles consent, redaction, circuit breaking, rate limiting). Currently, embedding has its own parallel consent/redaction pipeline. Recommendation: Route embedding requests through the Gateway like all other external calls.

3. **The `summarize` lane is underspecified.** It has no tools, no context, and no clear integration point. When is it triggered? Who calls it? The other 7 lanes have clear trigger conditions; `summarize` just exists. Recommendation: Specify that `summarize` is triggered automatically when conversation length exceeds a threshold, used to compress conversation history before it's truncated by the context assembler.

### Implementation Plan Optimality

**What's excellent:**
- The audit-driven approach (v2 identified 14 missing components; v3 identified 9 structural defects) is rigorous.
- The stub interface contracts with `[STUB]` warnings and CI enforcement is a smart pattern for phased implementation.
- The anti-patterns section is invaluable for LLM implementors.
- The spec-to-implementation cross-reference matrix ensures nothing falls through the cracks.
- The development/debug workflow section with mock providers is practical.

**What could be more optimal:**
1. **Phase 5 is still overloaded.** Even after the v3 fix of splitting Phases 4/5, Phase 5 contains 9 substantial components (SecureEmbedding, Indexer, Reranker, ContextAssembler, DynamicToolSelector, StepExecutor, ToolRouter+PermissionManager, LaneRouter, AgentOrchestrator) in 2 weeks. This is the most complex phase — it's where everything connects — and it should have more time. Recommendation: Split Phase 5 into 5a (Context Engine: embedding, indexer, reranker, context assembler, tool selector) and 5b (Agent Runtime: step executor, tool router, lane router, orchestrator). 5a can proceed in parallel with 5b's design phase.

2. **No load testing strategy.** The plan tests individual components at each gate and runs 8 E2E scenarios in Phase 11, but there's no load/stress testing plan. How does the system behave with 100 concurrent completion requests? With 50K files being indexed while the user is chatting? Recommendation: Add load testing scenarios to Phase 11 alongside the performance benchmarks.

3. **No rollback strategy for failed phases.** If Phase 5 fails its gate, what happens? The plan assumes linear forward progress. Recommendation: Add a brief note per phase on what to do if the gate fails (e.g., "If the agent loop fails integration testing, focus on the tool call loop first as it's the highest-risk component").

---

## Part V: Consolidated Recommendations (Priority-Ordered)

### Must-Fix Before Implementation Begins

1. **Fix the agent tool call loop** (I-1) — the implementation plan's orchestrator pseudocode is broken and will be copied verbatim by the LLM.
2. **Add Agent Orchestrator to spec** (S-1) — the spec needs this as a §7.3.
3. **Add Lane Router to spec** (S-2) — the spec needs this as a §4.6.
4. **Resolve spec §15.1 vs implementation plan phasing** (C-1) — pick one source of truth.
5. **Fix stale `AtomicMultiFileWriter` references in spec** (C-3) — 2 occurrences.
6. **Add egress blocker stub to Phase 0/1** (I-3) — security by default.
7. **Add Provider Adapter specs to spec** (S-3) — the implementation plan has them; the spec should too.

### Should-Fix Before Phase 5

8. **Reconcile rate limiter defaults** (C-2) — make them configurable with consistent defaults.
9. **Add error handling to activation sequence** (I-4) — graceful degraded start.
10. **Fix `PersistentAgentStateMachine.recover()` UI reference** (S-4) — compile error.
11. **Add `failed_steps_json` to task state schema** (S-5) — data loss on recovery.
12. **Fix crypto API inconsistency** (S-6) — use `node:crypto` consistently.
13. **Specify BM25 schema** (S-7) — the implementor needs this.
14. **Handle concurrent messages** (I-5) — user will trigger this immediately.

### Should-Fix Before Phase 7

15. **Fix tool side-effect flags** (S-8) — UX impact.
16. **Specify `web_search` tool or remove it** (S-9) — implementor will be stuck.
17. **Define webview message protocol** (I-7) — needed for Phase 7.
18. **Update model IDs to use aliases** (C-4) — the ModelRegistry can handle this.

### Nice-to-Fix

19. Specify completion/fast-apply bypass paths (I-2).
20. Add context assembler profiles for all 8 lanes (C-5).
21. Add `get_definition` to `chat-gather` (C-6).
22. Add token counting strategy (I-10).
23. Expand risk register (I-11).
24. Fix dependency chain description (I-12).
25. Fix RRF formula description (S-10).
26. Address Google provider phantom config (S-11).
27. Clarify checkpoint-git relationship (S-12).
28. Fix session cache key hashing (I-8).

---

## Conclusion

The QIC v6.2 spec and implementation plan v3 represent an impressive body of work — approximately 10,700 lines of detailed, cross-referenced, audited technical specification. The three rounds of audit that produced this version are evident in the quality.

The most significant finding is **I-1** (the broken agentic loop), which would silently break the core interaction model. The second most significant cluster is **S-1/S-2/S-3** (missing spec sections for the orchestrator, lane router, and provider adapters), which leaves the most critical integration logic specified only in the implementation plan.

With the 7 "must-fix" items addressed, this system is ready for LLM-driven implementation. The spec's invariant system, combined with the implementation plan's gated phases and stub contracts, provides a robust framework for incremental, verifiable construction.

---

*End of Audit Report*
