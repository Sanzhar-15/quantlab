---
name: 2026-05-26_phase-6-product-surfaces
status: |
  IN-PROGRESS — Phase 6 (Product Surfaces), the v1-critical path. Phase 5 COMPLETE
  (5.8 megaudit PASS-WITH-FINDINGS); Phase 6 DECISION-LOCKED (docs/phase6/decision-lock.md,
  Codex gpt-5.5 xhigh validated). Sequence = wedge-first, STAGED.

  ✅ 6.1A SHIPPED + CODEX-VALIDATED 2026-05-26 (this session, docs-only): wrote docs/api/session-api.md
  (v2) — the stable engine session contract. Codex (gpt-5.5 xhigh) reviewed it, verdict REVISE
  (5 HIGH/5 MED/2 LOW/1 INFO, all code-grounded), all verified at source + resolved in v2.
  Key locks the review forced: single-writer OpLog MANDATORY → the version token is `{epoch,op_count}`
  (NOTE: 6.1A said "Loro VV"; inc.2 grounding corrected this — OpLog DOES expose a Loro VV via oplog_vv,
  but `{epoch,op_count}` is the deliberate v1 token, see session-api.md §4.0); cancellation scoped honestly (in-engine recalc =
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

  ✅ 6.1B increment 1 SHIPPED 2026-05-26 (`20d11072a0a`, CODE cycle 1/2): stood up the
  `ql-session` crate — the binding-neutral EngineSession trait + versioned DTOs + EngineError
  taxonomy + operation/lifecycle types + FunctionMetadata skeleton. TYPE-LEVEL ONLY (no impl);
  compiles + 4 unit tests pass + clippy clean. Reuses ql-types. Self-tests pin the CellValue
  wire shape, the structured-error contract, and the malformed-token-is-fail-loud (No-Fallbacks) rule.
  ✅ inc.1b (`38108a5c8ef`, CODE cycle 2/2) completed the EngineSession trait with the v1 table ops
  (create/rename/rename_column/resize/drop_table) + TableSpec DTO (5 tests). ⚠️ a git-index padding
  race truncated the inc.1 commit's dto.rs/session.rs blobs — caught + fixed at `af15dcf3a5d`.

  ✅ 6.1B inc.2a + 2b SHIPPED 2026-05-26 (this session, CODE) — the owning `WorkbookSession` core path.
  - 2a (`83b1b33bac2`): session-owned PlanCache — `WorkbookRuntime::with_session_state(.., PlanCache)` +
    `into_plan_cache(self)`. Ownership-transfer instead of the doc's `&mut PlanCache` sketch → ZERO
    existing-call-site change. ql-exec suite green.
  - 2b (`7335a5a1bfa`): `crates/ql-exec/src/session.rs` — `WorkbookSession impl EngineSession`. REAL:
    lifecycle (new/from_workbook/close, Ready/Busy/Closed) + `{epoch,op_count}` 24-byte token; mutations
    (set_value/set_formula/clear/set_format/register_format, add_sheet/rename_sheet, set_name); recalc
    (recalc_dirty/all/mark_volatiles_dirty under Busy+op-registry, CellDiagnostic events); read
    (snapshot live-overlay enum / cell / list_sheets); ops/events (cancel/operation_status/poll_events).
    8 session tests + 644 ql-exec lib green; clippy clean. Error mapping = free fns map_runtime_err/
    map_oplog_err (orphan rules forbid `From<RuntimeError> for EngineError`; in-crate exhaustive match).
    CORRECTED a doc error: ql-oplog::OpLog DOES expose a Loro VV (oplog_vv) — earlier "no VV" claim was
    wrong; `{epoch,op_count}` is still the v1 token by deliberate choice (see session-api.md §4.0).

  ✅ 6.1B inc.2c-1 SHIPPED 2026-05-26 (`993492b6f9b`) — read-path completion: `validate_formula` +
  `query_range` (columnar dense, empties → `CellValue::Blank`). DECISION TAKEN: added `CellValue::Blank`.
  ✅ 6.1B inc.2c-2 SHIPPED 2026-05-26 (`2b5e7a13f5b`) — structure + table ops: delete/restore/move_sheet
  (fail-loud MED-3: unknown id → NotFound, OOR move index → BadArgument; manual `Op::{RemoveSheet,
  RestoreSheet,MoveSheet}` emission, append-before-mutate) + create/rename/rename_column/resize/drop_table
  (WorkbookRuntime delegations). ✅ AUDIT-FIX 2026-05-26 (`9f7a1645dbd`, from the "optimal/complete"
  review): tombstone-read consistency — `require_live_sheet` gates cell/query_range/validate_formula +
  cell edits so a deleted sheet is uniformly NotFound (snapshot/list_sheets already hid it); +documented
  ops/events unbounded growth. 17 session tests + 653 ql-exec lib green; clippy clean.

  ✅ 6.1B inc.2 AUDIT (F3–F10) + inc.2c-3 snapshot_delta SHIPPED 2026-05-27. Parallel Codex (gpt-5.5
  xhigh) + Opus audit of WorkbookSession (synthesis docs/audits/2026-05-27-inc2-session-audit/SYNTHESIS.md;
  10 findings, all verified at source). Audit-fix `879f3601747`: F3 with_runtime FaultGuard (panic→Faulted);
  F4 read-path coord bounds; F5 tombstone op-log fidelity (double-delete no-op; restore-of-live Conflict);
  F6 require_live_sheet on rename_sheet+create_table; F7 query_range options fail-loud; F8 Appendix-A honest
  mapping; F9 deleted-sheet-formula-readable doc; F10 corrected misleading tables.rs comment (BatchCommit
  atomicity fix TRACKED). inc.2c-3 `20427b1c4c7`: snapshot_delta = design (a) — change-log keyed by a
  monotonic `state_seq` (REPLACES oplog.len() as the token counter; advances on mutation + recompute-with-
  changes + Blank-clear → closes Codex HIGH F1+F2-token-half). RecomputeResult gained changed_cells. §4.3
  rules + fail-loud invalid_version_token; epoch-bump for delta-inexpressible states (move/restore sheet,
  table ops). ql-exec lib 667/0, clippy clean, workspace cargo check green.

  ⭐ NEXT = 6.1B inc.2c-4+ (continue the impl) — **follow `docs/api/workbook-session-impl-plan.md` §0**.
  Remaining, surfaced as `Capability/not_implemented_in_v1_core` (honest, No-Fallbacks):
  (6) batch/txn + undo/redo (OpLog::new_undo_manager) + persistence (open/import/save/export via ql_io →
  adds PersistenceError to Appendix A); (7) functions (6.4) + reserved bulk (6.4/6.5). Then Node
  smoke-path migration + 6.1C audit. Do NOT freeze the CollabSession CRDT façade (collab = v1.5).
  Also pending from inc.1: the napi `.node` rebuild + B#1/S2-01 mocha tests.
date: 2026-05-26
predecessor_plan: .plans/_archive/2026-05-26_phase-5-7-v3-6-1-delta-consumer-backlog.md (V3.6.1 backlog mini-phase, SUPERSEDED by Phase 5 COMPLETE)
parent_phase: 6 Product Surfaces
canonical_decision_lock: docs/phase6/decision-lock.md (authoritative locked decisions + sequence)
canonical_contract: docs/api/session-api.md (6.1A v2, Codex-validated — what 6.1B builds against)
canonical_impl_plan: docs/api/workbook-session-impl-plan.md (6.1B inc.2 concrete build plan — READ FIRST before implementing WorkbookSession)
codex_review: docs/api/codex-6-1a-review.md (the 13 findings the contract resolves)
direction: |
  Wedge-first: get the engine to the Month-6 Python kill gate (debug-from-cell, BoundFrame,
  qb.show(df)) on the shortest sound path. 6.1 (stable session API) is the non-negotiable
  foundation; 6.4 (Python UDFs) is the strategic wedge; everything else (full bindings,
  service, SQL, AI) follows. Collab is v1.5-deferred and must NOT pre-empt Phase 6.

current_engine_head: 9d471be3663 (6.1B inc.2c-4 batch fix — reject same-cell value/formula conflicts; LAST CODE COMMIT) ← 58a55f4cfb8 (6.1B inc.2c-4 — batch via option (a)) ← dddb19a9c0d (batch calcgraph design note) ← 03fdeead3aa (batch design-fork note) ← 67c8ad3596e (inc.2c-3 docs sync) ← 20427b1c4c7 (6.1B inc.2c-3 — snapshot_delta: change-log + state_seq) ← 879f3601747 (6.1B inc.2 audit-fix F3–F10) ← e16acdcf14b (inc.2c-2 doc sync) ← 9f7a1645dbd (6.1B inc.2c-2 audit-fix — tombstone-read consistency) ← 2b5e7a13f5b (6.1B inc.2c-2 — structure + table ops) ← 993492b6f9b (6.1B inc.2c-1 — validate_formula + query_range + CellValue::Blank) ← 7335a5a1bfa (6.1B inc.2b — WorkbookSession core path) ← 83b1b33bac2 (6.1B inc.2a — session-owned PlanCache ctor; first PRE-EXISTING-code change since S2-01, additive) ← 884b7e365e8 (6.1B inc.2 impl-plan doc) ← 38108a5c8ef (6.1B inc.1b — trait w/ table ops) ← af15dcf3a5d (race-fix) ← 20d11072a0a (6.1B inc.1 — ql-session crate) ← ff6cd4c147c (6.1A v2). PRE-EXISTING-code changes since baseline: B#1 + S2-01 + inc.2a (additive PlanCache ctor). inc.2b/2c-1/2c-2 add NEW ql-exec/src/session.rs + ql-session dep + CellValue::Blank variant (no pre-existing-code behavior change). After current_engine_head, doc-sync commits advance HEAD further. pre-B#1 baseline 1465b1db4c4.
current_ide_head: d028568b53b (V3.6.1.2 shared delta cache) — unchanged
audit_rules_inherited: parallel Codex+Opus per phase/wave/step; negative trait claims need positive compile proof; phase-level closures use 3-5-way megaudits; range-aware fn ships need lex+parse+bind+eval coverage.

## Locked Phase 6 sequence (decision-lock §2)

1. ✅ **Decision lock** — docs/phase6/decision-lock.md.
2. ✅ **6.1A — Session API contract** — docs/api/session-api.md v2 (SHIPPED + Codex-validated 2026-05-26).
3. **6.1B — Owning WorkbookSession** — single-engine owning session around WorkbookRuntime +
   OpLog + CalcgraphSession + PlanCache + FunctionRegistry (calcgraph_session.rs:69-71 anticipates it).
   - ✅ **inc.1 (`20d11072a0a`, +race-fix `af15dcf3a5d`) + inc.1b (`38108a5c8ef`)**: `ql-session` crate —
     EngineSession trait + binding-neutral DTO module (schema_version) + EngineError taxonomy +
     operation/lifecycle types + FunctionMetadata skeleton + v1 table ops + TableSpec. Type-level only;
     compiles + 5 tests + clippy clean. (Trait surface now complete for inc.2 to implement.)
   - ✅ **inc.2a (`83b1b33bac2`) + 2b (`7335a5a1bfa`) + 2c-1 (`993492b6f9b`) + 2c-2 (`2b5e7a13f5b`)**:
     session-owned PlanCache + the owning `WorkbookSession` (`impl EngineSession` in
     `ql-exec/src/session.rs`) — lifecycle + `{epoch,op_count}` token + single-cell mutations + recalc
     (Busy/op-registry) + read (snapshot/cell/list_sheets/query_range/validate_formula) + ops/events +
     `CellValue::Blank` + **structure ops (delete/restore/move_sheet, fail-loud) + table ops
     (create/rename/rename_column/resize/drop)** + Appendix-A error mapping (free fns). 14 session tests
     + 650 ql-exec lib green, clippy clean. Remaining surfaced `not_implemented_in_v1_core` (No-Fallbacks).
   - ⭐ **inc.2c-3 (NEXT)**: ⚠️ snapshot_delta (DESIGN DECISION needed — recompute deps not op-logged +
     &self; see §0 item 3) → batch/txn + undo/redo + persistence → functions/bulk. See
     `workbook-session-impl-plan.md` §0. Then migrate the Node smoke path. Leave
     collab/transport/presence feature-gated.
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
