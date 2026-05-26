Phase 6 (Product Surfaces) decision-lock — DEEP DESIGN REVIEW (audit-only; do NOT write code; produce a reasoned verdict).

CONTEXT
The Quantbook engine just completed Phase 5 (Multi-User CRDT Collaboration) via the 5.8 Phase 5 megaudit (PASS-WITH-FINDINGS; canonical record docs/phase5/megaudit-5-8/closures.md + docs/phase5/phase-5-exit-packet.md). We are now at the Phase 6 ENTRY DECISION-LOCK. Phase 6 = "Product Surfaces": stable session API, engine-as-service, WASM/Node/C/Python bindings, Python UDFs, SQL/connectors, AI(). Per the dual-plan mapping, Phase 6 is the v1-CRITICAL path; Engine Phase 5 collaboration maps to Product Phase 9 = v1.5-DEFERRED (so the remaining collab backlog must NOT pre-empt Phase 6). This is a design review to LOCK the Phase 6 plan; a fresh session will then implement 6.1 (the engine source code-cycle budget for the current session is already exhausted).

REPO: this engine repo (source HEAD a2722008b24; the last engine SOURCE change is ff09a5e17a7 "export_snapshot tombstone fix", everything after is docs). Confirm with `git log --oneline -1`.

READ FIRST (cite these as you reason):
- docs/phase6/entry-plan.md — the Phase 6 entry-readiness analysis: §4 scope table (6.1–6.7 with effort/deps), §5 recommended sequencing, §6 risks R-P6-1..6, §7 verdict.
- docs/MASTER-PLAN.md — §0 (product↔engine phase mapping) + the "Phase 6 - Product Surfaces" section (Entry State Required + Exit Criteria + sub-items).
- /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md — the canonical PRODUCT master plan (source-of-truth): find Product Phase 5 (Python kernel + UDFs), the Month-6 PYTHON KILL GATE (the explicit "if debug-from-cell unworkable / BoundFrame leaky / qb.show(df) flaky, Phase 5 stretches" gate), and the "Python-signal → pokeable-sheet" wedge thesis. If unreadable, say so and reason from the engine plan.
- Engine crates: note `crates/ql-bindings-node` ALREADY EXISTS (the VS Code IDE consumes it via napi — appendPutValue/appendPutFormula/workbookSnapshot/workbookSnapshotDelta/sheet ops); `crates/ql-exec` holds the single-writer WorkbookRuntime + the graph runtime; Phase 3 ("One Engine") unified the fast + runtime engines. Skim the napi surface in crates/ql-bindings-node/src/lib.rs to ground 6.1.

PROPOSED DECISIONS — pressure-test EACH (AGREE, or ARGUE AGAINST with concrete evidence from the plan/code):
1. SEQUENCING = WEDGE-FIRST: 6.1 (Stable Engine Session API) → then 6.4 (Python UDFs) IMMEDIATELY, BEFORE 6.2 (service) / 6.3 (general bindings) / 6.5 (SQL) / 6.6 (AI). Rationale: Python UDFs are the strategic wedge on the Month-6 kill gate; front-load the riskiest product validation; the Node trigger path (IDE formula bar → napi → engine) largely exists. QUESTION: is this optimal, or do hidden dependencies argue for some infra first? Does 6.4 TRULY only depend on "6.1 + fn metadata" (entry-plan §4), or does it also need parts of 6.3 (the Python BINDING, quantbook-py) to exercise UDFs end-to-end? Distinguish "execute a Python UDF inside the engine (ql-udf/PyO3)" from "trigger/author it from the IDE."
2. 6.2 TRANSPORT = DEFER the HTTP-vs-gRPC pick until 6.2 actually starts (weeks out; the wedge doesn't use the service). Default-lean HTTP+SSE if forced. QUESTION: optimal to defer, or is there a reason to lock it now (e.g., it constrains 6.1's API shape)?
3. AI() 6.6 = DEFER to late Phase 6 / v1.5 (provider + product policy undecided per R-P6-6; doesn't block the wedge). QUESTION: optimal?

DEEP-DIVE (think hard; this is the core of the review):
A. 6.1 STABLE SESSION API — the foundation everything binds to. The collab/IDE napi surface is STILL CHURNING (V3.6.1 just added workbookSnapshotDelta + a shared cache). What MUST 6.1 lock so wasm/node/c/python bindings + the service can all bind without a third rewrite (R-P6-2)? Design traps to call out: the cancellation model; structured-error taxonomy across FFI; sync-vs-async surface; lifetime/ownership across the FFI boundary; whether to EXTRACT the trait from the proven ql-bindings-node surface (bottom-up) vs design top-down. Give a concrete recommendation for 6.1's shape + what to freeze first.
B. 6.4 PYTHON UDFs — R-P6-3: PyO3 + GIL, v1 ships GIL-ONLY (free-threaded 3.13t blocked). The plan says the HARD part is sandbox/timeout/CANCELLATION (UDF-6-02), not the call path. Is wedge-first realistic given that difficulty? Define the MINIMUM-VIABLE UDF that validates the Month-6 kill gate (debug-from-cell, BoundFrame, qb.show(df)) WITHOUT the full sandbox — and recommend whether to STAGE 6.4 (MVP-UDF-to-validate-kill-gate → harden-sandbox-later). What is the cancellation story for a long-running Python UDF under the GIL?
C. R-P6-4 GRAPH INVALIDATION — UDFs/SQL/AI must NOT bypass the Phase-3 unified graph. Does wedge-first 6.4 risk wiring UDF cells in a way that bypasses graph invalidation? What is the correct dependency-invalidation model for a Python-UDF cell (volatile? explicit deps? recompute-on-input-change)? This is an exit criterion — be specific.
D. Anything across the WHOLE Phase 6 the proposal misses (sequencing, security/audit checkpoints, the "security/design audit after 6.1 before exposing surfaces" requirement, connector credential boundaries, etc.).

OUTPUT (write to docs/phase6/codex-decision-lock-review.md):
- For decisions 1/2/3: VERDICT (AGREE / CHANGE-TO-X) + reasoning, citing files.
- For deep-dives A–D: analysis + CONCRETE recommendations.
- A recommended LOCKED Phase 6 sequence (ordered sub-items with the rationale for the order).
- Top 3 risks to actively manage + their mitigations.
Be thorough and specific — cite file:line where it strengthens the argument. Distinguish strong recommendations from judgment calls.