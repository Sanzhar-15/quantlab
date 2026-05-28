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

  ✅ 6.1B inc.2c-4 `batch` SHIPPED 2026-05-27 (`58a55f4cfb8` + fix `9d471be3663`). `batch(ops, options)`
  via option (a): validate-all → ONE `Op::BatchCommit` → apply via graph-maintaining runtime with op-log
  DETACHED (`with_session_state_no_oplog`) → `record_changes` once; all 4 SessionOp variants. Built by a
  delegated Opus agent; a self-review CAUGHT + fixed a real latent replay-divergence (same-cell
  value/formula ops; `Op::PutValue` replay doesn't clear a formula, `replay.rs:486-510`) → now rejects
  >1 value/formula op per cell with `Conflict/conflicting_batch_ops` (SetFormat orthogonal). ql-exec lib
  681/0, clippy clean, workspace green.

  ✅ 6.1B inc.2c-5 transaction handle SHIPPED 2026-05-27. The multi-call
  begin_transaction/txn_add/commit_transaction/rollback_transaction. Added the two `WorkbookSession`
  fields (`txns: HashMap<TransactionId, Vec<SessionOp>>`, `next_txn_id: u64`); a pure `SessionOp` buffer
  (no engine borrow) committed through the SAME `batch` machinery (inherits validation-atomicity, graph
  consistency, one BatchCommit, single state_seq tick, the same-cell conflict guard). No lock between
  begin/commit → validated at commit time. begin/txn_add/commit require Ready; rollback ungated (cleanup);
  close drops buffers. Failed commit keeps the txn OPEN (buffer restored — batch is validation-atomic).
  Unknown handle → fail-loud NotFound/transaction_not_found; id exhaustion → loud Internal/
  transaction_id_exhausted (checked_add, never wraps). 10 session tests; parallel Codex(gpt-5.5 xhigh)+Opus
  audit CLEAN — no HIGH; both converged on 1 MED (gate txn_add on ensure_ready — APPLIED) + 2 LOW
  (next_txn_id checked_add — APPLIED; oplog-len test assertions — APPLIED). Synthesis
  `docs/audits/2026-05-27-inc2c5-txn-audit/SYNTHESIS.md`. ql-exec lib 691/0, clippy clean, workspace green.

  ✅ 6.1B inc.2c-6 F2 Blank-durability CLOSED (`Op::ClearValue`) SHIPPED 2026-05-27 (`d8d22a04248`).
  set_value(Blank)/batch/transaction Blank-clears now emit a replayable `Op::ClearValue` → durable on
  save/load + undo-replay. clear_formula unchanged (preserves values). Delegated-agent impl + source
  review + independent verify; ql-exec 692/0, ql-oplog/ql-collab green. Prerequisite for correct undo.

  ✅ 6.1B inc.2c-7 undo/redo SHIPPED 2026-05-27 (`4f8e9858d77`). Loro `UndoManager` field
  (set_merge_interval(0); 1 command = 1 unit; rename_table/column wrapped in a `grouped()` Loro group for
  the F10 N+1-commit loop). rematerialize = replay post-undo op-log onto a CLONE of the construction-time
  `baseline` workbook → rebuild_from_workbook → recompute_all (op-log detached) → bump_epoch. Empty stack
  → consumed:false. Builds on inc.2c-6 (undo of a Blank-clear restores the prior value). **Parallel
  Codex(gpt-5.5 xhigh)+Opus audit:** both verified the load-bearing claims at source (1-cmd-1-unit;
  linear-replay rename fidelity needs no ql-collab repair passes); both flagged ONE real bug — populated-
  from_workbook + undo silently dropped pre-loaded content (replayed from empty wb) — FIXED via the
  `baseline: Workbook` field (Codex HIGH / Opus M1). F10 table-rename atomicity left tracked; 100-step undo
  cap documented. Synthesis `docs/audits/2026-05-27-inc2c67-undo-audit/SYNTHESIS.md`. ql-exec 709/0, clippy
  clean, workspace build green.

  ✅ 6.1B inc.2c-8 F10 atomic table-rename SHIPPED 2026-05-27 (`dca5695549e`). rename_table/rename_column
  emit ONE Op::BatchCommit ([Rename*, PutFormula × N]) append-before-mutate (mirror rename_sheet); closes
  the tracked F10 Codex-HIGH gap. Replay reproduces identical end state (apply_rename_* only re-key
  metadata; PutFormula ops carry text — complementary). undo grouped() now defense-in-depth. Focused Codex
  (gpt-5.5 xhigh) audit: no HIGH/MED; 2 LOW (stale docs, rename_table e2e) APPLIED. emits_ops tests assert
  single-BatchCommit; + e2e rename_table_op_log_replay_reconstructs_rename. ql-exec 709/0 + e2e 21/0,
  ql-oplog 70/0, clippy clean, workspace build green.

  ✅ 6.1B inc.2c-9 `.qbook` open/save SHIPPED 2026-05-27. **DESIGN FORK LOCKED — Option 1** (user-confirmed):
  `open` reconstructs the workbook from the `.qbook` envelope (`ql_io::load_workbook_with_oplog`) and adopts
  it via `*self = from_workbook(loaded_wb)` — FRESH empty op-log + fresh UndoManager + `baseline = loaded_wb`
  + re-minted epoch (pre-open snapshot_delta token → EpochMismatch) + reset state_seq/change_log/ops/events/
  txns, registry preserved — then recomputes with the op-log DETACHED (saved computed values may be stale,
  mirrors loader.rs::load_workbook_and_recompute), failures → CellDiagnostic. The loaded op-log is FULLY
  validated (framing by the loader + per-op payloads by an explicit iter() loop — Codex HIGH: framing-only
  would silently accept a payload-corrupt sidecar then mask it on the next save) then DISCARDED (Option-1
  trade-off: history not carried; re-save = this session's edits only). `save(&self)` writes wb+oplog via
  `ql_io::save_workbook_with_oplog`; name from path file-stem (None → loud BadArgument). New
  `map_persistence_err` fills Appendix A (Persistence/qbook_error|session_oplog|qbook_unsupported_version|
  qbook_truncated_header; foreign non_exhaustive wildcard → loud Internal/unmapped_persistence_error). `open`
  gated New|Ready (re-open replaces the doc) via ensure_openable; save uses ensure_readable. Option 2 rejected
  (needs loaded_wb==replay(loaded_oplog) → data-loss class inc.2c-7 closed; revisit collab-v1.5).
  import/export (xlsx/csv) stay honest not_implemented_in_v1_core (follow-up). **Parallel Codex(gpt-5.5
  xhigh)+Opus audit:** 1 HIGH (sidecar payload-validation gap — FIXED + regression test) + 2 LOW (module-doc
  drift; can_undo-false-after-open + resave-stability tests added) + INFO (Appendix-A variant-name tidy);
  both verified post-open undo invariant + open-failure atomicity + recompute op-log isolation at source.
  Synthesis `docs/audits/2026-05-27-inc2c9-persist-audit/`. **ql-exec lib 719/0 + e2e 21/0, clippy clean,
  workspace build green.**

  ✅ 6.1B inc.2c-10 xlsx `import` SHIPPED 2026-05-27. Broke the `ql-exec ↔ ql-io-xlsx` cycle via
  **dependency inversion**: new `XlsxRecomputer` trait in `ql-io-xlsx` (now pure I/O; `ql-exec` → its
  dev-deps), `import_xlsx_bytes`/`_path` take `Option<&dyn XlsxRecomputer>` (loud if None+BestEffort/Strict),
  `recompute_loaded_workbook` deleted; `ql-exec` gained `ql-io-xlsx` dep + public `EngineXlsxRecomputer`
  (`src/xlsx_recompute.rs`). `WorkbookSession::import("xlsx")` = Option-1 adoption (mirrors open; no second
  recompute) + `push_xlsx_import_diagnostics`; `"csv"` → not_implemented (net-new); unknown → BadArgument;
  `map_xlsx_err` fills Appendix A. ~90 ql-io-xlsx test call-sites migrated (delegated + reviewed; 3 src
  lib-test sites use `None` — dev-dep-cycle two-crate-instance E0277, behavior-preserving). Parallel
  Codex(gpt-5.5 xhigh)+Opus audit: 1 HIGH (feature_inventory diagnostics dropped — FIXED + test) + 1 MEDIUM
  (recompute outside FaultGuard — NON-BUG, atomic self-replace, documented) + INFO; verified at source.
  **Tracked follow-up: feature-gate the xlsx WRITER so ql-exec sheds umya/image/rav1e deps.** Spec
  `docs/api/xlsx-import-integration-plan.md`; synthesis `docs/audits/2026-05-27-inc2c10-xlsx-import-audit/`.
  **ql-exec lib 723/0 + e2e 21/0, clippy clean; ql-io-xlsx green; workspace build green.**

  ✅ 6.1B inc.2c-11 csv `import`/`export` SHIPPED 2026-05-27. **New pure-I/O leaf crate `ql-io-csv`**
  (deps: `csv = "=1.3.1"` + ql-storage + ql-types; NO ql-exec — CSV has no formulas → no recompute
  injection, true leaf, no cycle). `import_csv_bytes`/`export_csv_bytes` + `CsvError`
  (Io/Parse/ExceedsSheetLimits/SheetNotFound). `import("csv")` = Option-1 adoption + **no recompute**;
  type inference (empty→Blank; TRUE/FALSE→bool; finite f64→Number, inf/nan→text; leading `=`→text,
  injection-safe; Excel-like lossy `00123`→123; BOM-stripped; UTF-8-strict; engine-limit guarded
  before put_at → no panic). `export("csv")` (`&self`) = single LIVE sheet (>1 → loud BadArgument, no
  silent drop; 0 → empty), verbatim/value-only (Value Display; conservative bounds like xlsx/.qbook).
  unknown format → BadArgument. `map_csv_err` fills Appendix A. Parallel Codex(gpt-5.5 xhigh)+Opus
  audit: Codex HIGH (export over conservative bounds → blank-inflation blowup) **assessed
  consistent-with-siblings (xlsx exporter + .qbook saver use the IDENTICAL bounds pattern) + documented
  + TRACKED cross-cutting** (uniform storage effective-extent API; round-trip path unaffected — import
  skips blanks); MEDIUM (export formula-injection) → kept faithful/verbatim (silent escaping corrupts
  data; matches Excel/Sheets), doc scoped + future opt-in noted; Opus BOM fix applied + test; LOW
  numeric fidelity kept Excel-consistent + pinned. Synthesis `docs/audits/2026-05-27-inc2c11-csv-audit/`.
  **ql-exec lib 728/0 + e2e 21/0, clippy clean; ql-io-csv 11/0; ql-io-xlsx green; workspace build green.**

  ✅ 6.1B inc.2c-12 xlsx `export` + xlsx-writer feature-gate SHIPPED 2026-05-27. `export("xlsx")`
  serialises the WHOLE workbook (xlsx is multi-sheet) via `ql_io_xlsx::export_xlsx_bytes`, AND the
  tracked inc.2c-10 follow-up (ql-exec pulling the writer's umya + image/rav1e/exr/tiff codec tree for
  import-only use) is CLOSED. umya 2.2.0 has `writer::xlsx::write_writer<W: io::Write>` → serialise to a
  `Vec<u8>` in memory (NO tempfile); the path exporter now delegates to a shared
  `export_new_workbook_to_bytes` core + one `atomic_write_to_path`, and `post_process_zip` became the
  bytes-in/bytes-out `post_process_bytes` (byte-identical output — both umya write paths go through
  `make_buffer`). `export_xlsx_bytes` is `NewWorkbook`-only (UpdateOriginal → loud `XlsxError::Export`).
  Feature-gate: ql-io-xlsx `umya-spreadsheet` optional; `default = ["write"]`, `write =
  ["dep:umya-spreadsheet"]` gates `mod write` + both export fns; the READER stays always-compiled.
  ql-exec depends `default-features = false` + `xlsx-write = ["ql-io-xlsx/write"]`; `export("xlsx")` real
  behind `#[cfg(feature = "xlsx-write")]`, else honest `Capability` (writer codecs opt-in → default
  build + WASM/bindings lean). A ql-exec `[dev-dependencies]` re-enables `write` for the inc.2c-10
  round-trip test fixture; workspace `resolver = "2"` keeps that out of the normal lib build. `export`
  is `&self` (no event channel) → fidelity report dropped under Permissive (same as csv, documented).
  Parallel Codex(gpt-5.5 xhigh)+Opus audit **CLEAN — 0 HIGH/MED/LOW** (both verified `write_writer ≡
  write` byte-equivalence at the umya registry source + the feature graph via `cargo tree`: umya absent
  from default ql-exec normal deps, present under `--features xlsx-write`; 1 doc-precision INFO applied;
  1 pre-existing HashMap-ordered fresh-rels INFO folded into the cross-cutting tracker). Synthesis
  `docs/audits/2026-05-27-inc2c12-xlsx-export-audit/`. **ql-exec lib 729/0 (default + `--features
  xlsx-write`), clippy clean; ql-io-xlsx 60+49/0 (default), `--no-default-features` builds clean;
  workspace build green.**

  ✅ 6.1B inc.2d — owning `WorkbookSession` over napi (engine-side Node-smoke enabler) SHIPPED 2026-05-28.
  `ql-bindings-node` now exposes a new **`Session`** `#[napi]` class over
  `Arc<parking_lot::Mutex<ql_exec::WorkbookSession>>` (new/addSheet/setValue/setFormula/clear/recalcDirty/
  recalcAll/snapshot/cell/listSheets) — decision-lock §2 item 3 + risk-mit #1. `CollabSession` façade
  untouched (collab=v1.5). `engine_error_to_napi` + DTO mappers reuse the existing `#[napi(object)]` shapes
  (+ new `SheetInfoJson`); `f64`+`validate_u16/u32_index` discipline; positive `WorkbookSession: Send`
  compile-proof. Deps `ql-exec` (no default features → no umya/image tree) + `ql-session`. Plain-Node
  `process.dlopen` smoke (`tests/smoke_session.mjs`) PASSES edit→recalc→snapshot. Parallel Codex+Opus
  audit **SHIP — 0 HIGH/MED**; 1 LOW (clear docstring → convert-to-literal, FIXED); deferred (snapshot
  `formats` ordering → 6.1C; `schema_version` omission → 6.3; no-`catch_unwind` under `panic=abort` =
  known, == CollabSession). Synthesis `docs/audits/2026-05-28-inc2d-session-napi-audit/`. ✅ clippy
  hygiene (`2d22f1f82e2`): the 4 pre-existing ql-bindings-node `#![deny(clippy::all)]` errors surfaced by
  the rust-1.95.0 bump (`lib.rs:416/502/564/2788`, CollabSession-path; not inc.2d) are FIXED →
  `clippy -p ql-bindings-node` GREEN (incl. moving an orphaned `PresenceStateJson` doc block back to its
  struct). **Still TRACKED (deferred, warn-level, non-breaking): workspace doc_lazy_continuation
  (ql-storage 1 / ql-oplog 3 / ql-collab 14) + type_complexity (ql-collab ×4) — a focused pass.**

  ✅ **IDE-side Node smoke wiring + mocha SHIPPED 2026-05-28** (cross-repo, IDE `feat/visualise-v1`
  `c24222315ed`): the VS Code fork drives the `Session` class through `loader.ts`/types
  (`createWorkbookSession()` + a fail-at-boundary shape-check), the `.node` was rebuilt (so B#1/S2-01 are
  now LIVE), and a mocha suite (`test/quantbook-session.test.ts`) proves edit→recalc→snapshot + the
  B#1/S2-01 regressions through the real loader. Full IDE suite 1435/0/25. Scope = types+loader+mocha,
  NO live-UI change. Parallel Codex+Opus: Opus SHIP; Codex 1 MED (cross-window S2-01 test vacuous as a
  filter regression → reframed; LOCAL S2-01 is the real guard) + pre-existing LOW + INFO. Synthesis
  `docs/audits/2026-05-28-6-1b-ide-node-migration/`.

  ⭐ NEXT — **6.1C security/design audit** (decision-lock §2 item 4; MANDATORY before broader binding/
  service exposure). Best run as a fresh dedicated multi-lane Codex+Opus megaudit; it is the home for the
  migration-deferred contract findings: snapshot `formats` ordering non-determinism, `schema_version`
  omission, no `catch_unwind` under `panic=abort`, the `WorkbookSnapshotJson.version` optional-in-TS DTO
  drift, and the no-`workbookSnapshotDelta`-over-napi gap that blocks driving the live `CellGridPanel` off
  `Session`. → **6.4-0 function-metadata substrate** → **6.4 Python UDFs**. The v1 import/export surface is
  COMPLETE (.qbook 2c-9, xlsx import 2c-10 + export 2c-12, csv 2c-11). Also tracked cross-cutting: a
  storage-level effective-non-blank-value extent API for all serializers. Do NOT freeze the CollabSession
  CRDT façade (collab = v1.5). **Follow `docs/api/workbook-session-impl-plan.md` §0.**
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

current_engine_head: 2d22f1f82e2 (6.1B clippy hygiene — cleared the 4 pre-existing ql-bindings-node `#![deny(clippy::all)]` errors surfaced by the rust-1.95.0 bump; `clippy -p ql-bindings-node` now GREEN; LAST CODE COMMIT) ← ea5987e4253 (6.1B inc.2d — owning WorkbookSession over napi, the Node-smoke enabler; code+docs+audit in one) ← eec9feb92bb (6.1B inc.2c-12 — xlsx export + xlsx-writer feature-gate) ← c11164a01a6 (inc.2c-11 doc-sync) ← 54f51edfbc1 (6.1B inc.2c-11 — csv import/export + new ql-io-csv leaf crate) ← a9ffa0519ae (inc.2c-10 Cargo.lock sync) ← 0e932da13a7 (6.1B inc.2c-10 — xlsx import + ql-io-xlsx dependency inversion; LAST CODE COMMIT before this) ← f5112879a60 (inc.2c-9 doc-sync) ← 2f92d84f3ed (6.1B inc.2c-9 — .qbook open/save, Option 1) ← 18e9b9ac3cf (inc.2c-8 handoff docs) ← dca5695549e (6.1B inc.2c-8 — F10 atomic table-rename) ← 2056edacc5c (inc.2c-6/7 doc sync) ← 4f8e9858d77 (6.1B inc.2c-7 — undo/redo) ← d8d22a04248 (6.1B inc.2c-6 — F2 Op::ClearValue) ← fdd80c7a43d (6.1B inc.2c-5 — multi-call transaction handle) ← 358c2c29f5d (inc.2c-4 coherence docs) ← 9d471be3663 (6.1B inc.2c-4 batch fix — reject same-cell value/formula conflicts) ← 58a55f4cfb8 (6.1B inc.2c-4 — batch via option (a)) ← dddb19a9c0d (batch calcgraph design note) ← 03fdeead3aa (batch design-fork note) ← 67c8ad3596e (inc.2c-3 docs sync) ← 20427b1c4c7 (6.1B inc.2c-3 — snapshot_delta: change-log + state_seq) ← 879f3601747 (6.1B inc.2 audit-fix F3–F10) ← e16acdcf14b (inc.2c-2 doc sync) ← 9f7a1645dbd (6.1B inc.2c-2 audit-fix — tombstone-read consistency) ← 2b5e7a13f5b (6.1B inc.2c-2 — structure + table ops) ← 993492b6f9b (6.1B inc.2c-1 — validate_formula + query_range + CellValue::Blank) ← 7335a5a1bfa (6.1B inc.2b — WorkbookSession core path) ← 83b1b33bac2 (6.1B inc.2a — session-owned PlanCache ctor; first PRE-EXISTING-code change since S2-01, additive) ← 884b7e365e8 (6.1B inc.2 impl-plan doc) ← 38108a5c8ef (6.1B inc.1b — trait w/ table ops) ← af15dcf3a5d (race-fix) ← 20d11072a0a (6.1B inc.1 — ql-session crate) ← ff6cd4c147c (6.1A v2). PRE-EXISTING-code changes since baseline: B#1 + S2-01 + inc.2a (additive PlanCache ctor). inc.2b/2c-1/2c-2 add NEW ql-exec/src/session.rs + ql-session dep + CellValue::Blank variant (no pre-existing-code behavior change). After current_engine_head, doc-sync commits advance HEAD further. pre-B#1 baseline 1465b1db4c4.
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
   - ✅ **inc.2c-3 (`20427b1c4c7`)**: snapshot_delta — change-log design (a) keyed by a monotonic
     `state_seq` (replaces `oplog.len()` as the token counter); §4.3 rules + fail-loud
     `invalid_version_token`; epoch-bump for move/restore sheet + table ops.
   - ✅ **inc.2c-4 (`58a55f4cfb8` + fix `9d471be3663`)**: `batch(ops, options)` — option (a)
     (validate-all → one `Op::BatchCommit` → detached-oplog graph-maintaining apply → `record_changes`
     once); all 4 SessionOp variants; rejects same-cell value/formula conflicts.
   - ✅ **inc.2c-5 (`fdd80c7a43d`)**: multi-call **transaction handle** (begin/txn_add/commit/rollback) —
     new `txns`/`next_txn_id` fields; pure `SessionOp` buffer committed through the same `batch`
     machinery; validated at commit time; failed commit keeps the txn open; fail-loud unknown handle /
     id-exhaustion. Parallel Codex+Opus audit clean (no HIGH; 1 MED + 2 LOW applied).
   - ✅ **inc.2c-6 (`d8d22a04248`)**: F2 Blank-durability CLOSED — additive `Op::ClearValue`; every
     value-clear path durable on replay/save-load (prerequisite for correct undo).
   - ✅ **inc.2c-7 (`4f8e9858d77`)**: **undo/redo** — Loro `UndoManager` field + baseline-replay
     re-materialization (replay post-undo op-log onto a clone of the construction-time `baseline`
     workbook → rebuild graph → recompute_all detached → bump_epoch); 1 command = 1 unit. Parallel
     Codex+Opus audit: closed a populated-`from_workbook` data-loss HIGH via the `baseline` field.
   - ✅ **inc.2c-8 (`dca5695549e`)**: **F10 atomic table-rename** — rename_table/rename_column emit ONE
     Op::BatchCommit append-before-mutate (mirror rename_sheet); closes the tracked F10 Codex-HIGH gap.
     Focused Codex audit clean (no HIGH/MED). undo grouped() now defense-in-depth.
   - ✅ **inc.2c-9**: **`.qbook` `open`/`save`** — **Option 1 LOCKED** (reconstruct from envelope + fresh
     op-log/undo history; loaded op-log validated incl. per-op payloads then discarded; `map_persistence_err`
     fills Appendix A). Parallel Codex+Opus audit: 1 HIGH (sidecar payload-validation gap — FIXED) + LOW/INFO.
   - ✅ **inc.2c-10**: **xlsx `import`** — broke the `ql-exec ↔ ql-io-xlsx` cycle via **dependency
     inversion** (`XlsxRecomputer` trait + `EngineXlsxRecomputer`; `ql-io-xlsx` now pure I/O). `import("xlsx")`
     = Option-1 adoption + import-report diagnostics (incl. `feature_inventory` — Codex/Opus HIGH fixed);
     `map_xlsx_err` in Appendix A. ~90 test call-sites migrated (delegated + reviewed). Tracked follow-up:
     feature-gate the xlsx writer (ql-exec pulls image codecs). Parallel audit clean after fixes.
   - ✅ **inc.2c-11**: **csv `import`/`export`** — new pure-I/O leaf `ql-io-csv` (no ql-exec dep; no
     recompute). `import("csv")` = Option-1 + type inference (BOM-stripped, UTF-8, injection-safe `=`,
     engine-limit guarded); `export("csv")` = single-live-sheet (multi → loud BadArgument), verbatim;
     `map_csv_err` in Appendix A. Parallel Codex+Opus audit: HIGH (conservative-bounds export blowup)
     → consistent-with-siblings + documented + tracked cross-cutting; BOM fix applied; faithful-export
     injection stance documented.
   - ✅ **inc.2c-12**: **xlsx `export`** + xlsx-writer feature-gate — `export("xlsx")` serialises the
     WHOLE workbook via `ql_io_xlsx::export_xlsx_bytes` (umya `write_writer` → in-memory `Vec<u8>`, no
     tempfile; path exporter delegates to a shared bytes core, `post_process_zip` → `post_process_bytes`,
     byte-identical). umya WRITER (+ image codecs) behind ql-io-xlsx `write` feature (`default=["write"]`,
     `umya` optional); ql-exec `default-features=false` + `xlsx-write` feature gates the export (else
     honest `Capability`); dev-dep re-enables `write` for the round-trip fixture. Closes the inc.2c-10
     tracked writer-leanness follow-up. Parallel Codex+Opus audit CLEAN (0 HIGH/MED/LOW).
   - ✅ **inc.2d (2026-05-28)**: owning `WorkbookSession` over napi — the new `Session` `#[napi]` class
     in `ql-bindings-node` (engine-side half of the Node smoke-path migration; `CollabSession` façade
     untouched). Parallel Codex+Opus audit SHIP. Synthesis `docs/audits/2026-05-28-inc2d-session-napi-audit/`.
   - ✅ **IDE-side Node smoke wiring + mocha SHIPPED 2026-05-28** (cross-repo, IDE `feat/visualise-v1`
     `c24222315ed`): `Session` driven through `loader.ts`/types + `createWorkbookSession()`; `.node`
     rebuilt (B#1/S2-01 now live); mocha `test/quantbook-session.test.ts` proves edit→recalc→snapshot +
     B#1/S2-01 regressions through the real loader (full IDE suite 1435/0/25). Scope = types+loader+mocha,
     no live-UI change. Codex MED (cross-window S2-01 vacuous → reframed; LOCAL is the real guard) + LOW +
     INFO; Opus SHIP. Synthesis `docs/audits/2026-05-28-6-1b-ide-node-migration/`.
   - ✅ **6.1C SHIPPED 2026-05-28** (decision-lock §2 item 4): 5-way parallel megaudit (4 Codex `gpt-5.5
     xhigh` lanes + 1 Opus agent + Opus synthesis). Scope ≈9859 LoC (`session.rs` 5117 + `Session` napi
     class ~150 + `ql-session` ~316 + IDE consumer + DTOs). **Verdict SHIP-WITH-FIXES**: 3 HIGH (1 fixed,
     2 filed for 6.3-entry), 8 MED (2 fixed, 6 filed), 8 LOW + 6 INFO. Synthesis
     `docs/audits/2026-05-28-6-1c-megaudit/SYNTHESIS.md`. **Audit-fix `6a14bd9075a`:** H2 deterministic
     ordering on `snapshot.formats` + 5 `snapshot_delta` Vecs (added `Ord`/`PartialOrd` to
     `ql_session::FormatId`); M8 `Session.close()` over napi (+ `[invalid_state]` smoke); M3 FaultGuard
     defense-in-depth (lifted to module scope; wraps `delete_sheet`/`restore_sheet`/`move_sheet`/
     `mark_volatiles_dirty` + `batch`'s Phase-2 oplog append); L1 trait-doc tightened (closes seed input
     #5 — `set_value(.., Blank)` IS the unified delete-contents command, atomic at `cells.rs::set_value`
     Blank arm); A-INFO/L-E6 misleading `session.rs:332` panic-default docstring corrected; M6 partial
     `next_op_id` → `checked_add`. **Block-on-6.3-entry:** H1 (cross-repo IDE allowlist), H3
     (snapshot_delta spill under-report — touches `WorkbookRuntime` return signature). **Filed for 6.3:**
     M1 (`#[napi(catch_unwind)]`), M2 (recalc cancel honesty — `run_recalc` allocates the op-id mid-call
     and never checks the registry), M5 (`schema_version` napi-DTO drop), M6 (`events`/`ops` bounded
     retention; needs event-ring per §9), M7 (effective-extent cross-cutting). **Over-napi cut-line:**
     `Session` binds 11 methods at 6.1C (the existing 10 + `close`); everything else defers to 6.3
     (functions to 6.4). **Verification (focused re-verify of affected lanes):** `cargo build` clean,
     `cargo test -p ql-exec --lib` **732/0** default + `--features xlsx-write` (+3 new H2 tests vs the
     729 baseline), clippy clean for edits, `node tests/smoke_session.mjs` PASS incl. the new post-close
     `[invalid_state]` + idempotent re-close assertions.
   - ✅ **6.4-0 SHIPPED 2026-05-28** (decision-lock §2 item 5): function-metadata substrate via
     parallel 2-way audit (Codex `gpt-5.5 xhigh` + Opus reviewer). Cycle 1 code at `ac20a432c63`
     (+1071/-117 across 8 files); cycle 2 audit-fix at `63592126afe` (+806/-33). The two hardcoded
     whitelists (`calcgraph_session.rs:149-164/:201-203`) are now metadata-derived; `FormulaDeps`
     gains `functions_used: Vec<Arc<str>>`; `CalcgraphSession` gains a `functions_used` reverse
     index + two hooks (`on_function_registered` / `on_function_unregistered`) mirroring
     `on_set_name`'s transitive-BFS pattern. `FunctionRegistry` gains `metadata: HashMap<String,
     FunctionMetadata>` + 5 public methods + a `FunctionRegistryError` enum; `default_registry()`
     runs `register_builtin_metadata` at boot (Phase 1 explicit overrides = prior whitelists
     byte-for-byte; Phase 2 defaults for every other dispatched fn via `r.fns.keys()`); migration-
     shim invariant `assert!` at boot (release-build coverage; audit-fix L2). Walker signature
     gains `&FunctionRegistry`; `rebuild_from_workbook(wb)` keeps zero-arg signature (constructs
     `default_registry()` internally) + new `_with_registry(wb, registry)` for production paths.
     Storage gate widened to also cover `functions_used`/`names`/`tables` — closes a latent
     `ROW(MyName)` cleanup bug. **Verdict SHIP-WITH-FIXES**: 3 HIGH (1 fixed, 2 filed for 6.4
     entry-plan), 5 MED (2 closed, 3 filed), 4 LOW (all 4 fixed), 5 INFO. Synthesis
     `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md`. **Audit-fix `63592126afe`:**
     H2 (recompute_all cycle pre-pass used `default_registry()` — swapped to
     `_with_registry(self.registry)`); Codex A LOW (unregister_metadata builtin-guard); L2
     (assert! migration-shim invariant); L3 (HookCounts parity); M4 + Codex D LOW (5 new
     substrate tests: ROW + ISREF / ROW(NOW()) registry-propagation + is_volatile / transitive
     fanout / ROW(MyName) cleanup regression / unregister builtin-guard); H3 doc-honesty
     correction (hooks are dirty-only; re-extract is the 6.4 orchestrator's responsibility).
     **Block-on-6.4-entry:** H1 (`ql-exec::plan`'s `is_aggregate_function` `:406-505` +
     `is_reference_aware_function` `:566-571` survive — UDFs with range args won't bind until
     these also derive from metadata; substrate is "two-thirds of UDF prerequisite"), H3 (hooks
     dirty-only; PlanCache needs `fn_gen` counter mirroring `name_gen` OR
     `WorkbookSession::register_function` orchestrator must call `reextract_deps` per dependent).
     **Filed for 6.4:** M1 `FormulaDeps::is_empty/len()` lie (only check 2 of 6 fields), M3
     `iter_metadata` HashMap-order (add `sorted_metadata()` view, matching 6.1C H2 ordering
     discipline), M5 `FunctionRegistryError → EngineError` mapper + Appendix A rows, I1
     `DepShape::LazyShape` for ISREF, I2 metadata-update atomicity docs, L1 walker hot-path
     `to_ascii_uppercase` allocation. **Verification (focused re-verify):** `cargo test -p ql-exec
     --lib` **742/0** (732 pre-substrate + 6 cycle-1 + 4 audit-fix), `cargo test -p ql-functions
     --lib` **1815/0**, `cargo check --workspace` clean, clippy clean for edits, Node smoke PASS.
   - ✅ **6.4-1 SHIPPED 2026-05-28** (decision-lock §2 item 6 entry): substrate-completion via
     parallel 2-way audit (Codex `gpt-5.5 xhigh` + Opus reviewer). Cycle 1 code at `1a7dfee12b0`
     (+1095/-348 across 21 files in 3 crates) batched the two block-on-6.4-entry HIGHs (H1 binder
     whitelists + H3 PlanCache re-extraction) AND the five filed substrate-completion items
     (M1 `FormulaDeps::is_empty/len` widening, M3 `sorted_metadata` view, M5
     `FunctionRegistryError → EngineError` mapper, I1 `DepShape::LazyShape` for ISREF, I2
     atomicity policy docs). Cycle 2 audit-fix at `befcd0d34cc` (+399/-55 across 5 source files).
     **H1 closure:** new `ArgContext` axis (`Scalar` / `Aggregate` / `Reference`, orthogonal to
     `BatchShape`); Phase 1.5 sets ~66 aggregate names' `arg_context: Aggregate` mirroring
     pre-6.4-1 `is_aggregate_function` `matches!` BYTE-FOR-BYTE (66/66 verified by both lanes);
     `ql-exec::plan::is_aggregate_function` + `is_reference_aware_function` drop hardcoded
     `matches!`; every binder entry point threads `&FunctionRegistry`. **H3 closure:**
     `FunctionRegistry::fn_gen` counter mirrors `name_gen`; bumps on success-only via
     `saturating_add(1)`; `PlanCacheKey` gains `fn_gen`; 5 production sites read it; bind cache
     invalidates on bump → re-bind → fresh `FormulaDeps` against current metadata. **Verdict
     SHIP-WITH-FIXES**: 2 HIGH (both Opus-only — 2 more silent-registry-divergence sites at
     `from_workbook`+`rematerialize` the 6.4-0 H2 audit-fix missed + the I2 docstring's
     `Volatility::Dynamic` claim contradicting substrate's actual unknown-fn deferral; both
     FIXED in audit-fix), 5 MED, 4 LOW, 3 INFO. Synthesis
     `docs/audits/2026-05-28-6-4-1-substrate-completion-audit/SYNTHESIS.md`. The 2-way pattern's
     structural value held for the third audit in a row (6.1C → 6.4-0 → 6.4-1). **Audit-fix
     `befcd0d34cc`:** (H1-OPUS) `WorkbookSession::from_workbook` (`session.rs:304`) +
     `rematerialize` (`:739`) now use `rebuild_from_workbook_with_registry(.., &self.registry)`;
     (H2-OPUS / Codex M1) I2 docstring rewritten to honestly describe substrate-v1 transient-gap
     behavior (formula re-binds as NOT volatile, binder arg_ctx falls back to Scalar, dispatch
     surfaces `#NAME?`); (Codex M2 / Opus M1-OPUS) new `different_function_generation_misses`
     plan-cache test pins H3 cache-miss invariant; (Codex L1 / Opus M2-OPUS) new
     `phase_1_5_aggregate_overrides_byte_for_byte_against_pre_6_4_1_whitelist` enumerates all
     66 Phase-1.5 Aggregate names verbatim; (Codex L2) 5-site stale-docstring sweep.
     **Filed for 6.4-2 (non-blocking):** M3-OPUS Reference+ArrayBatch forward-compat smoke;
     M4-OPUS UDF-flow binder integration test; L2-OPUS `DepShape::LazyShape` `#[serde(alias)]`;
     I2-OPUS Phase-1.5 overlap `debug_assert`. **Filed for 6.4 perf backlog (joint with 6.4-0
     L1):** L3-OPUS walker hot-path 2x HashMap-lookup collapse. **Verification:** `cargo check
     --workspace` clean; `cargo test -p ql-exec --lib` **743/0** default + `--features
     xlsx-write`; `cargo test -p ql-exec --tests` all integration suites green; `cargo test -p
     ql-functions --lib` **1820/0**; clippy clean for edits; Node smoke PASS through fresh-built
     audit-fix cdylib.
   - ✅ **SHIPPED 2026-05-28 — 6.4-2 engine trait wiring + napi DTO surface** (decision-lock §2 item 6
     continued). **Cycle 1 CODE** `f8eeaaeadfe` (+1477/-27 across 5 files in 4 crates) + IDE
     `739b625b4fd`. **Cycle 2 audit + audit-fix** (this fresh session, per auditor-independence
     discipline): parallel 2-way (Codex gpt-5.5 xhigh + fresh-context Opus) → reconciled
     SHIP-WITH-FIXES after **2 HIGHs** → audit-fix `3bf0d4fcbef` → doc-sync (MASTER-PLAN +
     session-api §3.9/§10.3/Appendix A + impl-plan §0). The 2-way INVERTED the usual pattern:
     **H1** (bad-name FFI panic + armed-FaultGuard session-seal + doc lie) found by BOTH lanes;
     **F2** (open/import rebuild graph against fresh UDF-free registry) found by **CODEX ONLY**.
     Audit-fix: H1 validate canonical_name at trait boundary → `[bad_argument]`; F2
     `from_workbook_with_registry` adoption helper (open/xlsx-import/csv-import); F3 strict ArityJson;
     M1/L1/M2/M3 test-honesty strengthenings; F4 ArityJson `undefined`-not-`null` doc. Verify all
     green (ql-exec lib 755/0 default + xlsx-write; 18 integration suites; ql-functions 1824/0;
     clippy clean; node smoke PASS). Synthesis + lanes
     `docs/audits/2026-05-28-6-4-2-trait-wiring-audit/`. **Still filed (non-blocking):** L2-OPUS
     LazyShape `#[serde(alias)]` (6.4-3); I2-OPUS Phase-1.5 overlap `debug_assert` (6.4-3); L3-OPUS
     walker hot-path 2x HashMap-lookup (perf backlog). **NEXT: 6.4-3 Python worker + Arrow + debugpy
     (3-way audit), then 6.4-4 exit tests (5-way megaudit).**
     <details><summary>6.4-2 cycle-1 + cycle-2 detail (historical)</summary>

     Cycle 1 CODE shipped at engine commit
     `f8eeaaeadfe` (+1477/-27 across 5 source files in 4 crates) + IDE commit `739b625b4fd` on
     `feat/visualise-v1` (+22 across 2 TS files). Cycle 2 (audit + audit-fix) ran in a fresh
     session per the auditor-independence discipline (the 6.4-1 cycle-2 audit caught 2 net-new HIGH
     that a same-session-as-code Opus couldn't have surfaced). Implemented
     `WorkbookSession::register_function` / `unregister_function` / `list_functions` (was
     `WorkbookSession::register_function` / `unregister_function` / `list_functions` (currently
     `not_implemented_in_v1_core` at `crates/ql-exec/src/session.rs:2423-2437`). Each method calls
     the substrate building blocks: registry `register_metadata` / `unregister_metadata` /
     `sorted_metadata` + calcgraph `on_function_(un)registered` + the M5 `map_function_registry_err`
     mapper (currently `#[allow(dead_code)]` at `session.rs:2878` — remove the gate). Surface the
     methods over napi (extends `Session` class beyond its 11-method 6.1C surface). Update IDE
     `parseQuantbookError` allowlist for `function_exists` / `function_not_found` codes.

     **Cycle budget (CLAUDE.md):** ≤2 plan-implement-audit cycles per session. Cycle 1 = engine +
     napi + IDE allowlist + tests; cycle 2 = parallel 2-way audit (Codex `gpt-5.5 xhigh` + Opus
     reviewer) + audit-fix; doc-sync separate. The substrate-completion shape (no Send/Sync change,
     no IO, narrow new FFI surface) puts this at 2-way per the audit-discipline memory rule 2 — the
     6.4-3 cross-repo Python-worker increment is the one that earns the 3-way (engine+Opus+IDE).

     **Design calls (locked in this plan; revisit in audit if challenged):**
     1. **UDF handle storage:** new `udf_handles: HashMap<String, FunctionImplHandle>` field on
        `FunctionRegistry`, parallel to `metadata` (matches the 6.4-0 audit's filed-design note
        "likely a HashMap<String, FunctionImplHandle> on FunctionRegistry parallel to metadata,
        populated only for UDFs"). The registry IS the authority on function identity; the handle
        is the dispatch-pointer for UDFs (vs the static fn pointer for built-ins). 6.4-3's worker
        dispatcher will look up `registry.udf_handle(name)` to invoke the Python worker.
     2. **Atomic register flow:** new `FunctionRegistry::register_udf(meta, handle)` combined
        method that calls `register_metadata` (which can fail Conflict) then inserts the handle on
        success (HashMap::insert can't fail). Single `fn_gen` bump (inside register_metadata).
        Symmetric `unregister_metadata` extended to ALSO clear any matching `udf_handles` entry
        (the builtin-guard at `registry.rs:382-394` already prevents removing builtin metadata, so
        the handle-removal is implicitly UDF-only). No separate `unregister_udf` needed — keeps
        the existing 6.4-0/6.4-1 invariant tests valid.
     3. **Arc::make_mut on registry:** the production-path mutation is
        `Arc::make_mut(&mut self.registry).register_udf(meta, handle)?`. Strong count is 1 in the
        normal flow (open/import's Arc::clone-then-drop pattern releases before mutation), so
        make_mut is O(1) (no clone). The session is single-writer so no concurrent reader.
     4. **Lifecycle gate:** `register_function`/`unregister_function` use `ensure_ready` (matches
        `register_format`/`add_sheet`/etc. — mutation gate; rejects Busy/Closed/New/Faulted).
        `list_functions` uses `ensure_readable` (matches `snapshot`/`cell`/`list_sheets` —
        Ready+Busy OK, New/Closed/Faulted rejected). NO FaultGuard wrap because no Workbook
        mutation through `with_runtime` — the registry mutation is pure HashMap work; failure
        modes are Conflict/NotFound (caller errors, not invariant breaks).
     5. **No event emission v1:** `register_function` does NOT emit `Event::StructureChanged`
        (function registration isn't a structural change in the §3.3 sense — sheet/table/name).
        Contract §9 doesn't list it; leave to a future increment if observability demands it.
     6. **napi DTO:** new `FunctionMetadataJson` `#[napi(object)]` mirror + enum-string mappings
        (volatility/dep_shape/batch_shape/arg_policy/cancellation/arg_context) + nested
        `ArityJson` (kind: "fixed"|"range"|"variadic" + n/min/max). Conversion fns:
        `metadata_from_json` (JS→Rust; rejects unknown enum strings as `bad_argument`),
        `metadata_to_json` (Rust→JS; total). `FunctionImplHandle(u64)` over napi as `BigInt`
        (matches `OperationId` convention at `lib.rs:4351`).
     7. **Cross-repo IDE allowlist:** ONLY the 2 new codes (`function_exists`, `function_not_found`)
        added to `KNOWN_QUANTBOOK_ERROR_CODE_RECORD` + the `QuantbookErrorCode` type union. The
        broader 6.1C-carryover H1 (~25 missing codes) STAYS deferred to 6.3 per the lock — not
        load-bearing for 6.4-2's wedge.

     **Cycle 1 (CODE) checklist — ALL SHIPPED at `f8eeaaeadfe` + IDE `739b625b4fd`:**
     - [x] `crates/ql-functions/src/registry.rs`:
       - [x] Added `udf_handles: HashMap<String, FunctionImplHandle>` field on `FunctionRegistry`.
       - [x] Added `pub fn register_udf(&mut self, meta, handle) -> Result<...>` (calls
             `register_metadata` then inserts handle on success).
       - [x] Added `pub fn udf_handle(&self, canonical_name: &str) -> Option<FunctionImplHandle>`.
       - [x] Extended `unregister_metadata` to ALSO remove from `udf_handles` (after builtin-guard).
             Updated its doc to describe the symmetric removal.
       - [x] Added `use ql_session::session::FunctionImplHandle` import.
       - [x] Tests (+4): `register_udf_inserts_metadata_and_handle_atomically`,
             `udf_handle_returns_none_for_builtins_and_unknown_names`,
             `unregister_metadata_clears_udf_handle_symmetrically`,
             `register_udf_conflict_does_not_insert_handle` (the atomicity property).
     - [x] `crates/ql-exec/src/session.rs`:
       - [x] Replaced `register_function` stub with real impl: `ensure_ready` + FaultGuard +
             `Arc::make_mut` + `registry.register_udf` + `on_function_registered` +
             `map_function_registry_err`.
       - [x] Replaced `unregister_function` stub with real impl: same shape (FaultGuard +
             `unregister_metadata` + `on_function_unregistered`).
       - [x] Replaced `list_functions` stub with real impl: `ensure_readable` +
             `sorted_metadata().into_iter().cloned().collect()`.
       - [x] Removed `#[allow(dead_code)]` from `map_function_registry_err`.
       - [x] Updated `deferred_methods_surface_capability_error` — swapped `list_functions`
             (now real) for `bind_range` (still deferred).
       - [x] New tests (+10): `register_function_succeeds_and_list_functions_includes_then_excludes_it`,
             `register_function_duplicate_returns_conflict_function_exists`,
             `register_function_against_builtin_returns_conflict`,
             `unregister_function_returns_not_found_for_unknown_name`,
             `unregister_function_against_builtin_returns_conflict`,
             `list_functions_is_call_stable_and_ascending` (closes 6.1C H2 ordering discipline at
             the trait surface), `register_function_dirties_dependent_formulas` (the H3 wire test
             through the trait), `register_function_with_aggregate_arg_context_admits_named_range_args`
             (M4-OPUS closure — used NAMED range not LITERAL range because the W5-108 / Phase
             4.7.O constraint rejects literal RangeRefs in non-Function context BEFORE the
             arg_context check; the H1 binder migration affects NAMED ranges via
             `AggregateNameRef`), `register_function_reference_plus_array_batch_round_trips_through_dto`
             (M3-OPUS forward-compat closure), `function_methods_respect_lifecycle_gate`.
     - [x] `crates/ql-bindings-node/src/lib.rs`:
       - [x] Added `FunctionMetadataJson` `#[napi(object)]` + nested `ArityJson` DTOs.
       - [x] Added 6 enum-string mapper pairs (`volatility_{from,to}_str` /
             `dep_shape_{from,to}_str` / `batch_shape_{from,to}_str` /
             `arg_policy_{from,to}_str` / `cancellation_{from,to}_str` /
             `arg_context_{from,to}_str`). Unknown JS strings surface `[bad_argument]`.
       - [x] Added 3 `#[napi]` methods on `Session`: `registerFunction(metadata, implHandle:
             BigInt)`, `unregisterFunction(canonicalName: String)`, `listFunctions()`.
       - [x] Imported `FunctionImplHandle` from `ql_session::session`.
     - [x] `crates/ql-bindings-node/tests/smoke_session.mjs`:
       - [x] Added UDF round-trip + negative cases + post-close lifecycle assertions.
       - [x] Documented the napi-rs `Option<T>` field omission convention (vs `null`).
     - [x] **Cross-repo IDE** (commit `739b625b4fd` on `feat/visualise-v1`):
       - [x] `extensions/quantlab/src/quantbook/session.ts`: added `function_exists` +
             `function_not_found` to `KNOWN_QUANTBOOK_ERROR_CODE_RECORD`.
       - [x] `extensions/quantlab/src/quantbook/types.ts`: added the same two codes to the
             `QuantbookErrorCode` type union.
     - [x] **Verification:**
       - [x] `cargo check --workspace` clean.
       - [x] `cargo test -p ql-functions --lib` — **1824/0** (1820 pre-6.4-2 + 4 new).
       - [x] `cargo test -p ql-exec --lib` default + `--features xlsx-write` — **753/0**
             (743 pre-6.4-2 + 10 new).
       - [x] `cargo test -p ql-exec --tests` — all 18 integration suites green.
       - [x] `cargo clippy -p ql-functions -p ql-exec -p ql-session -p ql-bindings-node
             --all-targets` clean for edits (pre-existing warnings in
             ql-storage/oplog/collab/benches unchanged).
       - [x] `node crates/ql-bindings-node/tests/smoke_session.mjs` PASS through fresh-built
             6.4-2 cdylib (touch lib.rs + cargo build + run).
       - [x] IDE `tsc --noEmit` on `extensions/quantlab/tsconfig.json` clean.

     **Cycle 1 cross-cutting fix (one mid-build correction):**
     - The first version of `register_function_with_aggregate_arg_context_admits_range_args`
       used `MYUDF(A1:A2)` (literal RangeRef). The test failed because the binder rejects
       literal RangeRefs in non-Function context at a layer ABOVE the arg_context check
       (W5-108 / Phase 4.7.O). The H1 migration affects NAMED ranges (`AggregateNameRef`),
       not literal ranges. Renamed the test + rewrote to use `MyRange` (named via
       `set_name`); now passes. Test docstring documents the constraint.
     - The first smoke-test version sent `{ kind: "variadic", n: null, min: null, max: null }`
       for the Arity, which napi-rs rejects (`NumberExpected` — `Option<T>` requires the
       field to be ABSENT, not `null`). Switched to `{ kind: "variadic" }`; documented at
       the test fixture for future contributors.

     **Cycle 2 (AUDIT + AUDIT-FIX) — handoff to fresh session:**

     Per the auditor-independence discipline (audit-discipline memory rule 2 + the 6.4-1
     cycle-2 audit's evidence that a fresh-context Opus catches structural findings a
     same-session Opus can't), cycle 2 opens cleanest in a fresh session.

     - [ ] **Audit brief (engine + IDE scope):** parallel 2-way (Codex `gpt-5.5 xhigh` via
           `codex exec -s read-only` + Opus reviewer agent fresh-context general-purpose).
           Audit scope:
       1. Trait wiring correctness end-to-end (engine method → registry method → graph hook).
       2. `Arc::make_mut` soundness — confirm no aliasing during mutation (strong count = 1
          in the normal flow; the open/import `Arc::clone`-then-drop pattern releases before
          mutation).
       3. Atomicity of `register_udf` — confirm no handle-without-metadata window AND no
          metadata-without-handle window in the OPUS code path (the Conflict short-circuit
          IS the atomicity guarantee; verify at source).
       4. FaultGuard coverage — confirm the register/unregister FaultGuards disarm cleanly
          on the legitimate-error path so Conflict / NotFound do NOT seal the session
          Faulted.
       5. Lifecycle gate coverage — register/unregister use `ensure_ready` (mutators);
          list_functions uses `ensure_readable` (read). Verify Closed/New/Faulted all
          rejected.
       6. Unregister symmetric handle clearing — confirm the `udf_handles.remove(&upper)`
          line in `unregister_metadata` runs ATOMICALLY with the metadata removal.
       7. napi DTO round-trip soundness — every enum value preserved (Rust → JS → Rust);
          unknown JS strings rejected loudly with `[bad_argument]`; BigInt sign + losslessness
          checks fire for negative + >u64::MAX `implHandle`.
       8. ArityJson tagged-union — Fixed / Range / Variadic round-trip; u32 → u8 conversion
          fails loud for values >255.
       9. IDE-side allowlist — confirm `KNOWN_QUANTBOOK_ERROR_CODE_RECORD` + `QuantbookErrorCode`
          union BOTH carry the new codes (the V2.9 compile-time Record invariant enforces
          this; the audit confirms the invariant is intact).
       10. Cross-repo wire contract — engine emits `[function_exists]` / `[function_not_found]`
           via `EngineError::Display` (`[code] message` format); IDE allowlist accepts them
           via the bracket-prefix regex.
       11. Plan-cache invalidation through the trait (the H3 wire) — verify `register_function`
           does cause subsequent `set_formula` calls referencing the new name to re-bind
           against the new metadata via the fn_gen counter.
       12. Test coverage gaps — every new test pins what its docstring claims; no
           false-positive "passes but doesn't test the claimed invariant" cases.
     - [ ] **Filed 6.4-2-entry items to verify shipped (was non-blocking 6.4-1 backlog):**
       - M3-OPUS Reference+ArrayBatch forward-compat — CHECK
         `register_function_reference_plus_array_batch_round_trips_through_dto` covers it.
       - M4-OPUS UDF-flow binder integration test — CHECK
         `register_function_with_aggregate_arg_context_admits_named_range_args` covers it.
       - L2-OPUS `DepShape::LazyShape` `#[serde(alias)]` — NOT covered (still filed; tracked
         as 6.4-2-defer or 6.4-3 housekeeping).
       - I2-OPUS Phase-1.5 overlap `debug_assert` — NOT covered (still filed).
       - Codex I1 Appendix A rows — covered by 6.4-1 doc-sync (`session-api.md`).
     - [ ] **Synthesis at `docs/audits/2026-05-XX-6-4-2-trait-wiring-audit/SYNTHESIS.md`.**
     - [ ] **Audit-fix commit** closes any HIGH/MED.

     **Doc-sync (separate commit per project convention):**
     - [ ] `docs/MASTER-PLAN.md`: 6.4-2 SHIPPED entry before 6.4-1.
     - [ ] `docs/api/session-api.md` §10.3 / §10.5: mark `register_function` / `unregister_function`
           / `list_functions` IMPLEMENTED in 6.4-2; update Appendix A `function_exists` /
           `function_not_found` rows to reflect they're now wire-live (not just M5-mapper-ready).
     - [ ] `docs/api/workbook-session-impl-plan.md` §0: 6.4-2 SHIPPED entry.
     - [x] `.plans/_active.md`: this section transitions from ⭐IN-PROGRESS to ✅SHIPPED.
     - [x] Memory: `current_work.md` + `MEMORY.md` pointer updated for 6.4-2.
     </details>

   - ⭐ **NEXT — 6.4-3 Python worker + Arrow exchange + debugpy.** ✅ DESIGNED 2026-05-28 at
     `docs/phase6/6-4-3-design.md` (the entry-plan sketch was one paragraph; the design resolves the
     central decisions). Ground truth: `quantbook-py` is a 20-line stub (greenfield); `RegisteredFn`
     has no `Udf` variant; `scalar.rs:463` returns #NAME? for registered-but-undispatchable UDFs.
     **Key decisions:** Model A (inline blocking worker call, timeout-guarded — fits the sync recalc;
     protocol kept batch-ready so the `BatchShape::ArrayBatch` batched model is a later additive
     optimization); new leaf crate `ql-udf` (process+IPC, dependency-inversion like ql-io-csv);
     plain-Python worker over length-prefixed Arrow-IPC framing (no PyO3 in the hot path — debugpy-
     friendly); `RegisteredFn::Udf(FunctionImplHandle)` dispatch tier + a `scalar.rs` arm + an
     `Option<&WorkerHandle>` on `EvalContext`; worker-kill = hard cancel (contract §6.2);
     trusted-workspace gating. **Cycle decomposition (multi-session per entry-plan §6 "2-3 sessions"):**
     ✅ **6.4-3a CODE SHIPPED 2026-05-28** — `ql-udf` leaf crate built out from the reserved stub:
     `codec.rs` (`ArrayValue`⇄Arrow-IPC tagged-column codec), `frame.rs` (`[u32 LE len][u8 type]
     [payload]` envelope + `FrameType` + EOF/torn/oversized/unknown-type guards), `worker.rs`
     (`UdfWorker` trait + `UdfError` taxonomy + in-process `MockWorker`). Deps `ql-types` + `arrow`
     + `thiserror` — leaf, NO ql-functions/ql-exec. 15 tests (round-trip over every Value variant +
     all 15 error sigils + degenerate shapes + full codec→frame→codec composition); clippy + workspace
     check clean. **2-way audit PENDING = next session's cycle 1** (this session spent its 2 cycles:
     6.4-2 audit-fix + 6.4-3a code). Control-frame payload internals deferred to 6.4-3b. Then:
     6.4-3b real Python worker spawn/handshake/kill (2-way); 6.4-3c eval wiring end-to-end (3-way);
     6.4-3d debugpy + trusted-workspace + IDE bridge (3-way). Then **6.4-4 exit-tests + closure
     megaudit** (5-way; contract §10.4 tests 1-8). **Open questions at impl start** (§10 of the
     design): transport (lean stdio), python discovery, arrow dep surface, re-examine 6.4-2
     `register_udf` atomicity once it also inserts a `RegisteredFn::Udf` dispatch entry (3-way atomic),
     EvalContext worker-threading churn. Tracked cross-cutting (still pending): `Sheet::iter_effective_cells()`
     serializer fix.
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
- ✅ **B#1 / S2-01 NOW LIVE 2026-05-28** (cross-repo IDE `c24222315ed`): cdylib rebuilt
  (`cargo build -p ql-bindings-node --release --features test-fixtures`); mocha
  `extensions/quantlab/test/quantbook-session.test.ts` covers both — the LOCAL S2-01 test is the genuine
  filter regression, the cross-window variant was reframed after a Codex MED showed `mergeBytes`
  forces a full-rebuild fallback (so the cross-window path can't discriminate the filter fix; it now
  honestly asserts the full-rebuild fallback + end-to-end no-leak). Full IDE suite 1435/0/25. Note: a
  *running* IDE picks up the rebuilt cdylib only on main-process restart (reload-window is not enough).
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
