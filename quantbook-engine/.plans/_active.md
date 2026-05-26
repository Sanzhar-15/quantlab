---
name: 2026-05-26_phase-6-product-surfaces
status: |
  IN-PROGRESS — Phase 6 (Product Surfaces), the v1-critical path. Phase 5 COMPLETE
  (5.8 megaudit PASS-WITH-FINDINGS); Phase 6 DECISION-LOCKED (docs/phase6/decision-lock.md,
  Codex gpt-5.5 xhigh validated). Sequence = wedge-first, STAGED.

  ✅ 6.1A SHIPPED + CODEX-VALIDATED 2026-05-26 (this session, docs-only): wrote docs/api/session-api.md
  (v2) — the stable engine session contract. Codex (gpt-5.5 xhigh) reviewed it, verdict REVISE
  (5 HIGH/5 MED/2 LOW/1 INFO, all code-grounded), all verified at source + resolved in v2.
  Key locks the review forced: single-writer OpLog MANDATORY → its Loro VV is the version token
  (resolves the deferred-collab token gap); cancellation scoped honestly (in-engine recalc =
  pre-start-cancel-only in v1 — recompute_* are synchronous commit-as-you-go loops + CalcgraphSession
  isn't Clone; hard no-late-commit only for out-of-process UDF/SQL/AI; new Busy lifecycle state);
  batch(ops,options)+opaque txn handle (no RAII borrow across FFI; BatchCommit replay is fail-loud
  NOT rollback-atomic); reserved bulk cmds (write_range/publish_dataset/bind_range/refresh_source/
  materialize_query) for 6.4/6.5; functions_used reverse index + registration invalidation; malformed
  version token = fail-loud invalid_version_token (closes a real silent-resync fallback — No-Fallbacks);
  error variant→code Appendix A. Review: docs/api/codex-6-1a-review.md. Verified anchors:
  calcgraph_session.rs:69-71 (owning-session); :149-164/:201-203 (whitelists = 6.4-0 gap);
  lib.rs:306-349 ([kind] error); recompute.rs:61/252 (synchronous recalc); replay.rs:889-895
  (BatchCommit non-rollback); FormulaDeps has no functions_used.

  ⭐ NEXT = 6.1B: implement the owning WorkbookSession around WorkbookRuntime + OpLog +
  CalcgraphSession + PlanCache + FunctionRegistry. Bottom-up-extract the EngineSession trait
  from the proven napi workflows; migrate the Node smoke path onto it; do NOT freeze the
  CollabSession CRDT façade (collab = v1.5 / Product Phase 9, feature-gated). This is a CODE
  phase → fresh session, full cycle budget.
date: 2026-05-26
predecessor_plan: .plans/_archive/2026-05-26_phase-5-7-v3-6-1-delta-consumer-backlog.md (V3.6.1 backlog mini-phase, SUPERSEDED by Phase 5 COMPLETE)
parent_phase: 6 Product Surfaces
canonical_decision_lock: docs/phase6/decision-lock.md (authoritative locked decisions + sequence)
canonical_contract: docs/api/session-api.md (6.1A — what 6.1B builds against)
direction: |
  Wedge-first: get the engine to the Month-6 Python kill gate (debug-from-cell, BoundFrame,
  qb.show(df)) on the shortest sound path. 6.1 (stable session API) is the non-negotiable
  foundation; 6.4 (Python UDFs) is the strategic wedge; everything else (full bindings,
  service, SQL, AI) follows. Collab is v1.5-deferred and must NOT pre-empt Phase 6.

current_engine_head: ff6cd4c147c (6.1A v2 Codex-validated) ← 85966ece7b4 (6.1A session-api.md) ← 5886ff32101 (doc-handoff fixes). SOURCE unchanged at 7e536fc07b2 (S2-01); all 6.1A work is docs-only. pre-B#1 baseline 1465b1db4c4.
current_ide_head: d028568b53b (V3.6.1.2 shared delta cache) — unchanged
audit_rules_inherited: parallel Codex+Opus per phase/wave/step; negative trait claims need positive compile proof; phase-level closures use 3-5-way megaudits; range-aware fn ships need lex+parse+bind+eval coverage.

## Locked Phase 6 sequence (decision-lock §2)

1. ✅ **Decision lock** — docs/phase6/decision-lock.md.
2. ✅ **6.1A — Session API contract** — docs/api/session-api.md v2 (SHIPPED + Codex-validated 2026-05-26).
3. ⭐ **6.1B — Owning WorkbookSession** — single-engine owning session around WorkbookRuntime +
   OpLog + CalcgraphSession + PlanCache + FunctionRegistry (calcgraph_session.rs:69-71 anticipates
   it). Define the EngineSession trait + binding-neutral DTO module (schema_version). Implement
   EngineError taxonomy, cancellation registry + op lifecycle, panic/validation boundary, event
   queue. Migrate the Node smoke path. Leave collab/transport/presence feature-gated.
4. **6.1C — Security/design audit** (MANDATORY before broader binding/service exposure).
5. **6.4-0 — Function-metadata substrate** — replace the hardcoded volatility whitelist
   (calcgraph_session.rs:149-164) + the address-only-reference whitelist (:201-203) +
   dispatch-only FunctionRegistry (ql-functions/src/registry.rs) with first-class
   FunctionMetadata (arity/volatility/determinism/dep-shape/batch-shape/arg-policy/cancel/provenance).
6. **6.4A — MVP UDF + minimal Python authoring slice** — trusted-workspace only; managed Python
   WORKER process (debugpy + hard-cancel via kill/restart); quantbook-py minimum API
   (qb.show/publish/bind/register_formula_function, BoundFrame.refresh, explicit edit txns);
   batch-shaped/Arrow call API from day one; deterministic structured error mapping. Proves the
   Month-6 kill gate.
7. **6.4B — UDF hardening** — timeout/cancel via process kill, type-conversion matrix, resource
   policy, subprocess lifecycle, docs/security/udf-ai-connectors.md, §4 graph-invalidation exit
   tests, security-audit closure (UDF-6-02..04).
8. **6.3 — Full bindings** (WASM/Node/C/Python) over the stable session API + parity golden matrix.
9. **6.2 — Full service transport** — decide HTTP/gRPC then (default HTTP+SSE).
10. **6.5 — SQL surface + connectors** — creds in VS Code SecretStorage, never in .qbook.
11. **6.6 — AI boundary or explicit deferral** — sentinel + provider-boundary; =AI() cell fn v2-aligned.
12. **6.7 — Phase 6 audit.**

## Top risks to actively manage (decision-lock §5)
1. Wrong 6.1 API lock → binding forks. Freeze DTOs/error/cancel/event semantics before breadth;
   one golden flow matrix across Node/Python/C/WASM/service; migrate the Node path early.
2. Python UDF cancellation/security overclaimed. v1 = Workspace Trust + subprocess isolation only,
   no hard-sandbox claim. In-process PyO3 = engine smoke only; hard cancel = worker kill/restart.
3. UDF/SQL/AI bypass the Phase-3 graph. Every language surface is a graph-visible formula node with
   metadata + explicit deps + provenance + dirty triggers; enforce via the §4 exit tests.

## ⚠️ Carryover caveats (from the prior session)
- **FIXES NOT LIVE / NOT DIRECTLY TESTED**: B#1 (ff09a5e17a7) + S2-01 (7e536fc07b2) are SOURCE-only.
  The napi .node is unrebuilt (running IDE still has old behavior) AND neither has a bug-exercising
  test (napi lib-test can't link). HIGHEST-VALUE next CODE step (do early in 6.1B session or before):
  rebuild the .node + add B#1 + S2-01 cross-window mocha tests.
- **Mac-host tooling gotchas**: `rg` NOT installed (use grep); `cargo` NOT on non-interactive PATH
  (use $HOME/.cargo/bin/cargo); ql-bindings-node lib-TEST can't link standalone (napi runtime symbols)
  → test the napi surface via IDE mocha or at the ql-collab core level; ql-collab-ws tests need a
  net-permitted env (sandbox TCP-bind denial is not a regression). Codex/cargo run via `mac zsh -lc`.

## Non-blocking polish backlog (v1.5 / opportunistic; do NOT pre-empt Phase 6)
- CellValueJson discriminated-union retype (recipe: closures.md §5 item 2; ~20 min TS).
- Coverage gaps (D5-1/2/3): collab merge_bytes multi-peer convergence + positive wire round-trips.
- Doc-drift (B#2/B#3/C#2 docstrings).
- v1.5 collab: D7 #REF!, sheet-tabs UI, incremental DOM patching, B9 removedCells population.

## Acceptance (Phase 6 exit, MASTER-PLAN §778-782)
- Product surfaces are real and tested; all bindings share one engine contract (API6-01);
  Python UDFs / SQL / AI do not bypass graph invalidation.
- 6.1-specific: API6-01 one trait backs all bindings; API6-02 cancellation; API6-03 structured errors.
