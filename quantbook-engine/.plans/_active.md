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
     ✅ **6.4-3a CODE + cycle-1 AUDIT-FIX SHIPPED 2026-05-28** — `ql-udf` leaf crate
     (deps `ql-types` + `arrow` `features=["ipc"]` + `thiserror`; leaf, NO ql-functions/ql-exec; NOT
     yet a default-member — pulled in at 6.4-3c). **CODE** `dce2e8bec3c`; **cycle-1 audit-fix**
     `c68bb794edc`. Modules: `codec.rs` (`ArrayValue`⇄Arrow-IPC tagged-column codec — decode is now a
     HARDENED trust boundary), `frame.rs` (`[u32 LE len][u8 type][payload]` envelope + guards),
     `payload.rs` (NEW — typed `CallPayload{handle,call_id,args}`/`ReturnPayload{call_id,result}`),
     `worker.rs` (`UdfWorker` trait + `UdfError` taxonomy + in-process `MockWorker`). **Parallel 2-way
     audit** (Codex gpt-5.5 xhigh + fresh-context Opus) → reconciled SHIP-WITH-FIXES. The 2-way again
     earned its keep: H1 (decode panic on <5 cols — arrow `RecordBatch::column` slice-OOB) + H2
     (positional-vs-field-name silent mis-read of the two `Utf8` cols str/err) found by BOTH lanes;
     the net-new HIGH **call-return-missing-ids** (CALL/RETURN carried only the bare grid — no
     handle/call_id) found by **CODEX ONLY**. **Audit-fix `c68bb794edc`:** decode validates the exact
     5-field schema (name+type+nullability) BEFORE any positional access (closes H1+H2); per-kind
     active-column is_null check (NullPayload); non-finite-number rejection (NonFinite — NaN/Inf no
     longer leak as raw Value::Number); exactly-one-batch (TrailingBatch); checked_mul (ShapeOverflow);
     NEW `payload.rs` typed CALL/RETURN codecs (closes call-return-missing-ids — on-wire STRUCTURE
     pinned now; correlation MECHANICS at 6.4-3b); `FrameError::TooLarge(u64)` reports actual length;
     explicit arrow `ipc` feature. **+14 tests (15→29)** incl. 9 adversarial decodes + bit-exact -0.0.
     Verified: `cargo test -p ql-udf` **29/0**, clippy `-p ql-udf --all-targets` clean, `cargo check
     --workspace` clean. Synthesis + lanes `docs/audits/2026-05-28-6-4-3a-ql-udf-audit/`. **Filed for
     6.4-3b:** M3 `UdfError` taxonomy completion (`Cancelled` distinct from `Timeout` + handshake/
     protocol-version variants — only exercisable with a real async pipe); real deadline/process-kill/
     no-late-commit coverage (exit test 6) is UNPROVEN here (mock can't reach it).
   - ✅ **6.4-3b CODE SHIPPED 2026-05-28** (`2671ade0cfa`) — the real Python worker. Rust
     (`crates/ql-udf`): `control.rs` (NEW — HELLO/HELLO_ACK/RAISE/LOG/CANCEL control-frame codecs +
     `PROTOCOL_VERSION`; RAISE carries call_id), `process.rs` (NEW — `PythonWorkerConfig` +
     `ProcessWorker` impl `UdfWorker`: spawn `python -m quantbook.worker`, HELLO/HELLO_ACK handshake,
     per-worker reader thread + mpsc, `call()` recv_timeout for the correlated RETURN/RAISE, timeout→
     kill+mark-dead→`Timeout` (late RETURN dropped, exit test 6), lazy respawn, `WorkerProcess::drop`
     kills+reaps; std-only, no new deps), `worker.rs` (completed the M3 taxonomy: `Cancelled`/`Handshake`/
     `Protocol`), `codec.rs` (+`BadUtf8`), `lib.rs` (mod control/process + re-exports). Python
     (`crates/quantbook-py/python/quantbook`, 3.9-compatible plain worker, NO PyO3 hot path): `_frame.py`
     (envelope mirror), `_codec.py` (tagged 5-col pyarrow grid codec EXACTLY mirroring codec.rs + payload/
     control codecs + Grid/Err), `worker.py` (`python -m quantbook.worker` loop), `__init__.py`
     (`register_formula_function` + registry), `_registry.py`, `_smoke_udfs.py` (fixture handles 7/8/9/11),
     `_self_test.py`. **Verified:** `cargo test -p ql-udf` **39/0** unit (was 29: +7 control, +2 process) +
     `tests/process_smoke.rs` **1/1** real-python end-to-end (double 21→42, mixed-grid identity,
     raise→Raised{ValueError}, timeout(300ms)→kill→respawn-new-pid; against host python3 + pyarrow 21.0.0,
     loud-skips if absent); clippy `-p ql-udf --all-targets` clean; `cargo check --workspace` clean;
     `python3 -m quantbook._self_test` PASS. ql-udf + quantbook-py stay out of default-members.
   - ✅ **6.4-3b cycle-1 AUDIT-FIX SHIPPED 2026-05-28** (`aa988b61afa`) — parallel 2-way (Codex gpt-5.5
     xhigh + fresh-context Opus). Codex DO-NOT-SHIP / Opus SHIP-WITH-FIXES → reconciled SHIP-WITH-FIXES.
     **3 HIGH + 4 MED + LOW/INFO.** The 2-way earned its keep: **BOTH lanes** caught the Drop-join
     deadlock on inherited stdout + the user-print() stdout-corruption; **CODEX-ONLY net-new HIGH**
     `frame-flood-defeats-timeout` (recv_timeout returns a ready frame regardless of remaining → a
     continuous LOG/stale-call_id stream defeats the deadline; Opus rated the same channel only LOW);
     **CODEX-ONLY MED** registry-silent-overwrite; **OPUS-ONLY MED** malformed-CALL-crash +
     python-encode-nan-inf. **HIGH fixes:** (1) `WorkerProcess::drop` DETACHES the reader thread instead
     of unconditionally joining (a UDF grandchild inheriting stdout kept the pipe open → read_frame
     blocked → join deadlocked the engine); keeps kill()+wait() reap (no zombie; wait() doesn't block on
     reparented grandchildren). (2) `worker.py` main() reserves the protocol fd (dup stdout→private fd,
     dup2 stderr→fd1, sys.stdout=sys.stderr) BEFORE importing user code → stray print()/chatter → stderr,
     not the frame stream. (3) `call()` checks `Instant::now() >= deadline_at` at the TOP of the loop
     before recv → a frame flood still hard-cancels on time. **MED fixes:** deadline_at computed at call
     ENTRY + respawn handshake capped by remaining budget (spawn()/handshake() take explicit timeout);
     register_formula_function validates callable + u64 range + rejects dup handle (replace=True override);
     worker decodes the 16-byte CALL header outside the try + grid INSIDE → malformed args → RAISE w/
     call_id, not a loop crash; `_codec.encode_grid` rejects NaN/Inf at source → clean RAISE. **LOW/INFO:**
     decode_grid num_columns==5 guard; smoke respawn proof rests on the fresh successful CALL (dropped
     flaky pid-inequality assert); protocol-write BrokenPipeError → clean exit; D-state wait() caveat doc.
     **Verified:** `cargo test -p ql-udf` **39/0** unit + `tests/process_smoke.rs` **2/2** real-python
     (added `process_worker_times_out_under_frame_flood` driving a new `_flood_worker.py` fixture — proves
     the deadline guard hard-cancels under a stale-RETURN flood); clippy `-p ql-udf --all-targets` clean;
     `cargo check --workspace` clean; `python3 -m quantbook._self_test` PASS; py_compile OK. Cargo.lock
     unchanged (std-only Rust fix). Synthesis + lanes `docs/audits/2026-05-28-6-4-3b-python-worker-audit/`.
     **Filed for 6.4-3c:** process-group/session kill (kill grandchildren so the pipe closes — the detach
     prevents the hang but can leak one blocked reader thread + fd if a UDF orphans a child); bounded
     reader channel/backpressure; Python LOG-emit path + a real LOG round-trip test; LOG→CellDiagnostic.
   - ✅ **6.4-3c CODE SHIPPED 2026-05-29** (`88406c32b70`) — UDF eval wiring; `=MYUDF(A1)` computes
     end-to-end (the wedge). **Two design-doc §10 open questions resolved AGAINST the doc** (annotated
     in `docs/phase6/6-4-3-design.md`): (1) dispatch = **Option B** (scalar.rs `None` arm via
     `registry.udf_handle(name)` + a mandatory `eval_at_cell_boundary` guard for spill) — NOT a
     `RegisteredFn::Udf` variant (`fns` is `&'static str`-keyed; UDF names are runtime `String`s →
     leak/retype). `register_udf` stays a **2-way** atomic. (2) worker lives on **`CellEnv`**
     (interior mutability `Option<&RefCell<Box<dyn UdfWorker + Send>>>`), NOT `EvalContext` (Copy);
     `+ Send` keeps `WorkbookSession: Send` (napi `assert_send`). **v1 cuts (user-confirmed):** arg
     marshalling N-scalars→1×N row / single-range→its grid / mixed-or-≥2-range→`#VALUE!`;
     failures→error VALUES now (`Timeout`→`#TIMEOUT!`, else `#CALC!`), CellDiagnostic sink deferred;
     no-worker→`#CALC!` (panic-free, FaultGuard never seals); `UDF_CALL_DEADLINE = 30s`. Files:
     ql-exec→ql-udf dep + default-members; `env.rs` (CellEnv accessor + `with_formula_cell_and_worker`);
     `scalar.rs` (`marshal_udf_args`/`dispatch_udf`/`map_udf_error` + None-arm + boundary guard);
     `workbook_runtime/{mod,recompute,cells}.rs` (worker threaded through `with_session_state*`);
     `session.rs` (`udf_worker` field + `set_udf_worker` + both `with_runtime` variants). **Verified:**
     `cargo test -p ql-exec` **763/0** lib + 8 new MockWorker tests + `tests/udf_e2e.rs` **1/1**
     real-python (`=MYUDF(A1)`→42 via live `python -m quantbook.worker`, loud-skip if no pyarrow) +
     updated `register_function_dirties_dependent_formulas` (#NAME?→#CALC! transition); clippy
     `-p ql-exec` (no new warnings); `cargo check --workspace` clean (incl. ql-bindings-node Send).
     Cargo.lock unchanged.
   - ✅ **6.4-3c 3-way AUDIT-FIX SHIPPED 2026-05-29** (`a9ef3f252ca`) — Codex gpt-5.5 xhigh
     (DO-NOT-SHIP 2H+2M) + fresh-context Opus engine-internal (SHIP-WITH-FIXES 0/3/3) + Opus
     cross-repo/IDE (SHIP 0/0/0). The four hardest dims (RefCell re-entrancy, FaultGuard
     panic-freedom, Send/`!Sync`, builtin↔UDF mutual-exclusivity) CLEAN by both engine lanes.
     **NET-NEW HIGH (Codex only — Opus rated that dim CLEAN): HIGH-1** array-PRODUCING function
     args silently scalarized — `marshal_udf_args`'s `is_range_like` sniffed PLAN shape, so
     `=MYUDF(SEQUENCE(2,2))` (an `ExprPlan::Function`) bypassed it → scalar eval → array→`#CALC!`
     → Python got a 1×1 error grid not the 2×2. FIX: classify args by RUNTIME shape (a "grid" arg
     = range ref / literal array / array-producing fn = Unified tier or nested UDF, evaluated via
     `eval_at_cell_boundary`; plain scalars incl. ROW/COLUMN stay on scalar eval). Now passes the
     full 2×2; array+scalar → VISIBLE `#VALUE!`. **HIGH-2** (Codex HIGH / Opus MED-latent):
     standalone `WorkbookTransaction` committed UDFs with no worker (no calcgraph → permanent
     `#CALC!`); latent (only `#[cfg(test)]` callers — live `commit_transaction` already threads via
     batch→`with_runtime_no_oplog`). FIX: thread `udf_worker` into `WorkbookTransaction` via
     `with_optional_oplog`. **LOW-1** `dispatch_udf` 1×1 `unwrap_or(Value::Blank)` → visible `#CALC!`.
     **Documented:** `set_udf_worker` stale-`#CALC!` needs `recalc_all` not `recalc_dirty` (doc
     fixed + test pinned; auto-dirty filed-fwd); `UDF_CALL_DEADLINE` per-call N×30s stall; error-args
     forwarded to worker (intentional, Excel); registry mutual-exclusivity construction-dependent.
     **Tests +5** (768/0 lib + 1/1 e2e real-python; clippy no new warnings; workspace clean incl.
     bindings Send). Synthesis + 3 lanes `docs/audits/2026-05-29-6-4-3c-udf-eval-wiring-audit/`.
   - ✅ **6.4-3c 5-way MEGAUDIT-fix SHIPPED 2026-05-29** (`92bbaa8601e`) — re-audited the FULL
     increment incl. the 570-line 3-way audit-fix delta (which the 3-way hadn't reviewed). 2 Codex
     gpt-5.5 xhigh (DO-NOT-SHIP 1H+2M / 3H+3M+1L) + 3 Opus (marshal SWF 0/1/1, concurrency SHIP 0/0/3,
     semantics SWF 1/2/3). Surfaced **5 findings the 3-way missed**, incl. a regression the 3-way's
     OWN fix introduced + a known-parked pre-existing bug. **FIXED 2 HIGH:** (A) `eval_at_cell_boundary`
     Unified arm was MISSING the `StructuredRef`→Range materialization the scalar arm has → broke
     `=TRANSPOSE(Table[Col])` (pre-existing for direct use; the 6.4-3c audit-fix widened it via UDF
     args) — added the arm + **un-ignored `i23_transpose_over_structured_ref`** (the parked Phase-4.12
     test documenting it); (B) `mark_volatiles_dirty` looped `graph.mark_dirty(node)` (NO fanout) →
     dependents of volatile UDFs/RAND/NOW went STALE — now calls `graph.mark_volatile_dirty()` (fans
     out) + new test. Both pre-date 6.4-3c. **HARD 6.4-3d BLOCKERS (in design §top):** (D) open/import/
     load recompute UDF cells w/ no worker → DESTROYS saved values (`#CALC!`)+spills — not product-
     reachable at 6.4-3c (no napi injection) but a data-loss blocker the moment 6.4-3d ships injection
     (must preserve/inject worker on open, trust-gated, or preserve cached values); (C) multi-cell
     LITERAL `RangeRef` args of a Reference-context UDF read values but aren't dep-tracked (needs a
     literal-range value-dep mechanism; common Aggregate+named-range path IS tracked); (G) `#CALC!`
     conflates no-worker/raised/died → CellDiagnostic sink; (H/I) op-level recalc budget + grid caps;
     (E) spill-delta under-report = the tracked 6.1C H3 (all arrays). Verified: `cargo test -p ql-exec
     --features xlsx-write` 769 lib + all integration 0-failed (i23 passes); e2e 1/1; clippy no new
     warnings; workspace clean. Cargo.lock unchanged. Synthesis+5 lanes
     `docs/audits/2026-05-29-6-4-3c-MEGAUDIT/`.
     **6.4-3c FULLY SHIPPED (code + 3-way audit + 5-way megaudit).**
   - ✅ **6.4-3d ENGINE blockers C1/D/G + napi setUdfWorker SHIPPED 2026-05-29** (plan-mode session;
     plan `~/.claude/plans/pure-frolicking-puzzle.md`; user picked C1=make-`=MYUDF(A1:A2)`-work + defer
     debugpy). Engine `5f163027a80` (+665/-95, 7 files): **G** = CellDiagnostic sink — `dispatch_udf`
     emits a structured per-cell diagnostic (udf_no_worker/raised/timeout/worker_died/cancelled/handshake/
     protocol/codec) ADDITIVELY (value mapping unchanged); ql-exec-local `env::UdfCellDiagnostic` + a
     **defaulted** `CellEnv::push_udf_diagnostic` + a `RefCell<Vec<_>>` collector on WorkbookSession lent
     through `with_session_state[_no_oplog]` + drained into `Event::CellDiagnostic` by `drain_udf_diagnostics`
     in both `with_runtime[_no_oplog]` after `drop(guard)`. **C1** = literal multi-cell range deps —
     `FormulaDeps.literal_ranges` + a walk_plan_for_deps arm + registration through the EXISTING
     range-keyed `register_range_dependency` (graph crate untouched) + is_empty/len/VEQ updates;
     `=MYUDF(A1:A2)` re-evals on edits (C2 fail-loud is the recorded fallback). **D** = D1 take/restore
     worker across the `*self=from_workbook` swap (open/xlsx/csv) + D2 `recompute_all`-ONLY preserve a
     saved UDF value when no worker (skip clear+eval+write incl. the spill-clear; scoped via a
     `preserve_saved_udf_when_no_worker` bool so recompute_dirty still goes #NAME?→#CALC! honestly). +4
     tests. napi `66a788e40c2` (+99/-4): ql-bindings-node direct ql-udf dep + `PythonWorkerConfigJson`
     DTO + `Session::setUdfWorker` (eager `ensure_started` fail-loud → `[worker_spawn_failed]`/
     `[worker_handshake]`; trust gate is the IDE's job). **Verified:** `cargo test -p ql-exec
     --features xlsx-write` 773 lib + ALL integration 0-failed; udf_e2e 1/1 real-python; clippy
     -p ql-exec no new warnings; cargo check --workspace clean incl. ql-bindings-node assert_send.
   - ✅ **6.4-3d 3-way AUDIT DONE & FIXED 2026-05-29** (`06c06d4a407`; user asked "need audit"). Codex
     gpt-5.5 xhigh (DO-NOT-SHIP 3H+2M+2L) + fresh-context Opus engine-internal (2H+1M+3L) + Opus
     napi/cross-repo (1H+2M+2L). **3 HIGH, each caught by ≥2 lanes — real bugs in the just-shipped code.**
     HIGH-1: D2 preserve fired on NON-load `recompute_all` (recalc_all kept stale; rematerialize/undo-redo
     CATASTROPHIC — replay restores formula TEXT only → preserve read Blank → dependent `=B1+1` became 1.0
     silent-wrong). FIX: `recompute_all()`=preserve-false (all ~60 callers); new
     `recompute_all_preserving_saved_udf()` called ONLY by `open`. HIGH-2: D2 doesn't preserve spills
     (.qbook never persists spill targets) → Option A scoped-preserve, documented honestly + filed a spill
     round-trip test. HIGH-3: setUdfWorker no lifecycle gate + close() didn't drop worker → injected into
     Closed/Faulted. FIX: `set_udf_worker_checked` (ensure_ready; napi spawns outside lock, calls it under
     lock → closes inject-vs-close race) + close() drops worker. LOW: handshakeTimeoutMs cap 600_000ms.
     CLEAN (all lanes): C1, G borrow/drain, D1, Send/!Sync, DTO, panic-across-boundary. +3 tests; verified
     776 lib + all integration 0-failed, e2e 1/1, clippy no-new, workspace clean. Synthesis+3 lanes
     `docs/audits/2026-05-29-6-4-3d-audit/`. (Two cargo-fmt×git-add padding-race truncations hit+fixed:
     `0de9f1fd7b5`, `e844109c565`.) **6.4-3d engine+napi+audit FULLY SHIPPED.**
   - ✅ **6.4-3d STEP 5 (IDE + pollEvents napi) SHIPPED + 3-way-audited 2026-05-29 — 6.4-3d is now FULLY
     SHIPPED.** Engine `1e182a2fad3` (audit-fix `01541cd1b7e`): napi `Session.pollEvents(cursor)` +
     Event/Diagnostic/Severity/OperationState/CellAddr/EventPage DTOs (every Event variant; `CellDiagnostic`
     now reaches JS) + worker.py `main()` no-stderr robustness (the embedded node/electron host left
     `sys.stderr=None` → the old `os.dup2(sys.stderr.fileno(),1)` crashed → worker exited before HELLO_ACK →
     every UDF `#CALC!`; now reserves the protocol channel via raw fd 1 + sinks to devnull when stderr
     unusable; does NOT dup2 fd 2 — that would clobber the protocol pipe when fd 2 was the reused dup). IDE
     `9d5ca7b75fa` (audit-fix `9df6b5c820f`, `feat/visualise-v1`): `setUdfWorker`/`pollEvents` on
     SessionInstance + loader shape check; the 5 error codes in the union + Record;
     `udfWorker.ts::injectUdfWorker` (double trust gate `vscode.workspace.isTrusted` && QuantLab
     `TrustManager` + `quantlab.pythonPath` cascade + `QUANTBOOK_PY_DIR` override) + `planUdfWorkerConfig`
     (pure); `cellGridLogic.ts::buildCellDiagnosticMessages`/`attachCellDiagnostics` (strip-stale,
     idempotent) + `cellGridHtml.ts` `title=` tooltip (server + client-repaint mirror). 3-way audit (Codex
     xhigh DO-NOT-SHIP + 2 Opus): 2 HIGH (VS-Code-Restricted-Mode trust gate [Codex-only]; client-repaint
     tooltip drop [Opus-only]) + 3 MED fixed. Synthesis `docs/audits/2026-05-29-6-4-3d-step5-audit/`.
     Verified: engine py_compile/self_test/process_smoke + node smoke (real-python `=MYUDF`→42 via no-stderr
     path); IDE hygiene/tsc/mocha 464 passing. **FILED-FORWARD (NOT 6.4-3d):** the live `cellGridPanel`→
     owning-`Session` migration + a live `pollEvents` loop (Step-5 Option-A scope boundary — the panel still
     runs on `CollabSession`, so the tooltip surface ships but nothing drives it end-to-end yet); sync
     `setUdfWorker` → async-napi `AsyncTask`; debugpy (`6.4-3d-debug`); op-level recalc budget +
     per-function deadlines (N×30s); worker.py pyarrow-import-before-fd1-redirect + `run()` param rename.
     Tracked cross-cutting (still pending): `Sheet::iter_effective_cells()` serializer fix.
   - ✅ **6.4-4 EXIT TESTS + 5-WAY CLOSURE MEGAUDIT SHIPPED 2026-05-29 — the 6.4-3 Python-UDF arc is
     CLOSED.** Engine `6b1fdb36578`. New `crates/ql-exec/tests/udf_exit_tests.rs` (public-API integration)
     proves §10.4 tests 1-8: 6 positive exits (1 scalar input-change recompute / 2 unrelated-edit
     no-recompute / 3 volatile-pass re-eval isolated from plain recalc / 6 Timeout→#TIMEOUT! committed
     atomically / 7 ALL 8 diagnostic codes at Error severity / 8 register→dirty→recalc airtight via
     invocation counters) + 2 reserved-capability guards (4 `publish_dataset` / 5 `bind_range` assert
     `not_implemented_in_v1_core`). NO production behavior changed (2 doc-only notes: scalar.rs
     `map_udf_error` wildcard + loader.rs D2 forward-risk). 5-way megaudit (2 Codex gpt-5.5 xhigh + 3
     fresh Opus): **0 HIGH / 0 DO-NOT-SHIP**; all SHIP / SHIP-WITH-FIXES. Test-hardening applied this
     cycle (Codex-1 MED-1 test-8 calls==0/==1; Opus-C MED-1 test-7 5 untested codes; Codex-1 LOW-3 test-3
     plain-recalc-flat-first; test-6 citation honesty). Verified `udf_exit_tests` 8/8 + lib 776/0 +
     `udf_e2e` 1/1 real-python + clippy no-new + workspace clean. Synthesis+lanes
     `docs/audits/2026-05-29-6-4-4-exit-tests-megaudit/`. **FILED FORWARD (NOT arc-blocking):** (FF-1)
     `validate_canonical_function_name` should reject names the formula lexer can't tokenize (`MY UDF`/
     `MY-UDF`/non-ASCII) — pre-existing 6.4-2 gap, MED, no corruption (inert registration; `=MY UDF(..)`
     fails loud), deferred to a 6.4-2-followup extracting a shared lexer identifier predicate (mirror in
     ql-functions) to avoid regressing dotted names like `T.DIST.2T`; (FF-2) `WorkbookTransaction`
     diagnostics sink (not live — only test callers; live batch/commit threads diagnostics). **NEXT =
     the next decision-lock item (reserved-tier producers / 6.5).**
   - ✅ **6.4B (UDF hardening, decision-lock §2 item 7) STARTED 2026-05-29 — FF-1 CLOSED (`57bfc434850`).**
     `validate_canonical_function_name` now gates on CALLABILITY via the engine lexer+parser (probe
     `NAME(1)` must parse to exactly `Expr::Function` matching) — rejects `MY UDF`/`MY-UDF`/non-ASCII/
     trailing-dot/digit-led; accepts dotted canon (`T.DIST.2T`) + CellRef-lexed callable (`LOG10`).
     Parser-as-source-of-truth is regression-proof (a hand grammar would wrongly reject LOG10/dotted —
     the megaudit's parser-fidelity trap). New test `register_function_rejects_uncallable_canonical_names`
     + fixed a pre-existing clippy doc_lazy_continuation. Verified lib 777/0 + exit-tests 8/8 + clippy
     clean + workspace clean. **6.4B REMAINING (fresh session, needs planning + likely a focused audit):**
     FF-2 WorkbookTransaction diagnostics sink (not live); `docs/security/udf-ai-connectors.md`
     sandbox-limitations doc; op-level UDF recalc budget + per-call deadlines (N×30s stall, design §H/I);
     UDF-6-02..04 security-audit closure. **UPDATE 2026-05-30 -- 6.4B CODE CYCLE 1 SHIPPED (H + I + FF-2) `fee55b8c719`:** (H) op-level UDF recalc budget -- `UDF_OP_BUDGET` 120s armed per recalc pass by `run_recalc` (worker-attached only), `effective_udf_deadline` clamps each call to min(per-call, remaining), skip-when-spent -> `#TIMEOUT!` + `udf_budget_exhausted`; `#[cfg(test)] set_udf_op_budget` knob. (I) grid cell/byte caps in `ql-udf` codec -- `MAX_GRID_CELLS` 5M / `MAX_GRID_BYTES` 64MiB checked before alloc in encode/decode -> `GridTooManyCells`/`GridTooManyBytes` -> `#VALUE!` + `udf_grid_too_large`. (FF-2) `WorkbookTransaction` now threads the diagnostic collector. Verified ql-udf 43/0 (+4 cap tests) + process_smoke 2/0, ql-exec lib 784/0 default+xlsx-write (+units + session budget-skip E2E + FF-2 txn-diag test), udf_exit_tests 8/8, udf_e2e 1/1 real-python, clippy no-new, workspace clean. **6.4B REMAINING (fresh session):** `docs/security/udf-ai-connectors.md` (UDF-6-04), type-conversion matrix tests (UDF-6-03), and the UDF-6-02..04 multi-lane security-audit closure. Then the locked sequence: 6.3 bindings → 6.2 service → 6.5 SQL.
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
7. ✅ **6.4B — UDF hardening — FULLY SHIPPED 2026-05-30** (HEAD `66f9b77b46d`). FF-1 (callable-name
   gate) + H (op-budget) + I (grid caps) + FF-2 (txn diag sink) + UDF-6-03 type-conversion matrix
   (`crates/ql-exec/tests/udf_type_matrix.rs` — real-worker round-trip of every Value variant + 15
   sigils + the honest numpy/pandas boundary) + UDF-6-04 sandbox doc (`docs/security/udf-ai-connectors.md`).
   Multi-lane closure audit (Codex + 3 Opus, `docs/audits/2026-05-30-6-4b-udf-closure/`) → 1 HIGH
   (arrow `bodyLength` unbounded decode alloc → `precheck_ipc_message_bounds`) + 2 MED (op-budget armed
   on undo/redo + open; doc worker-persistence) + 3 LOW, all fixed. ql-exec lib 785/0, ql-udf 45/0.
8. **6.3 — Full bindings** (Node + thin Python; WASM/C → v1.5 per decision-lock §2.8 amendment) over the stable session API + parity golden matrix. Entry plan `docs/phase6/6-3-entry-plan.md` (Codex-reviewed + ratified).
   - ✅ **6.3-0 — H3 spill change-log engine fix — SHIPPED 2026-05-30** (HEAD `8bf20b41fe5` ← `46f4bf599c8`). `snapshot_delta` now reports the full dynamic-array spill footprint (grow/shrink→removed/dissolve) — the hard prerequisite that gated binding the live-grid cluster (`snapshot_delta`/`undo`/`redo`). No `RecomputeResult`/runtime signature change (delta resolves changed-vs-removed from current state → only coords needed): recompute path → `changed_cells`; direct mutations → a per-edit `spill_footprint` `RefCell` collector lent by the session (mirrors `udf_diagnostics`), drained into `record_changes`. Parallel Codex(xhigh)+Opus closure audit → 2 net-new HIGH (both reproduced & fixed in `8bf20b41fe5`): `recalc_all` dependency-driven shrink under-report; `recompute_dirty` cycle branch never dissolving a spill (storage orphan + delta gap). 10 snapshot_delta spill tests; ql-exec lib 795/0, all integration green, ql-udf 45/0, clippy no-new, workspace clean.
   - ✅ **6.3-1a — M1 napi panic boundary + L8 op-state RAII — SHIPPED 2026-05-30** (HEAD `08f4d32c261` ← `5c7f4154cee`). All 16 napi `Session` methods now panic-safe: a `guarded()` `catch_unwind` boundary maps a Rust panic → structured `[panic]` JS error instead of aborting the IDE host (napi-rs 3.x doesn't catch by default); `#[napi(catch_unwind)]` backstop on each. L8: `run_recalc` catches a recompute panic → marks the op `Failed` + emits the terminal event → `resume_unwind` (was: stranded `Running`). Sound via existing `FaultGuard` + `parking_lot` no-poison. Parallel Codex(xhigh)+Opus closure audit → 1 HIGH (**Opus-only, reproduced; Codex missed — didn't compile --release**: method-level `#[cfg(debug_assertions)]` on the test probe broke the release build via napi's ungated registration → fixed by whole-block-gating the probe's own impl) + 1 convergent MED/LOW (terminal event), both fixed. ql-exec lib 796/0, release+debug build, node smoke proves the boundary end-to-end, clippy no-new (incl. an `#[allow(too_many_arguments)]` on `with_session_state` — crossed 8/7 at 6.3-0). **NEXT 6.3 = 6.3-1c M5+§4b DTO parity** → 6.3-2 bind 32 methods. **FILED for 6.3-2:** `version()`/`CollabSession`/`Transport` napi surfaces still lack `catch_unwind`.
   - ✅ **6.3-1d — H1 IDE error-code allowlist — SHIPPED 2026-05-30** (IDE `a5ba07775ca` on `feat/visualise-v1`; engine untouched). Extended `QuantbookErrorCode` (types.ts) + the compile-enforced `KNOWN_QUANTBOOK_ERROR_CODE_RECORD` (session.ts) with **51 missing codes** — NOT the 16 the handoff estimated. Ground-truth enumeration (parser over every `EngineError::new` site + the 7 named constructors, cross-checked 4 ways: constructor regex, test-assert grep, full parser, struct-literal grep) found the engine emits **60** distinct `EngineError` codes; `engine_error_to_napi` forwards `EngineError.code` VERBATIM as the `[code]` prefix, so all 60 reach `parseQuantbookError`; only 9 were listed (the "16" omitted the entire xlsx/csv/oplog/table/unmapped families). 6.3-2 binds the methods emitting them, so this had to land first or they'd bucket under `'unknown'` (V2.7/V2.9 contract). The derived Set + `ALL` set + `isQuantbookErrorCode` guard pick them up free; the `Record<Exclude<…,'unknown'>, true>` shape compile-enforces union↔Record parity. **Channel discipline:** per-cell DIAGNOSTIC codes (`udf_*` ×8 + `formula_recompute_failed`/`xlsx_formula_recompute_failed`/`xlsx_import_warning`, via `Event::CellDiagnostic` → `DiagnosticJson.code: string`) are DELIBERATELY excluded — not thrown `[code]` errors. Verified: `tsc --noEmit` exit 0 (compile-enforced Record IS the parity proof), eslint clean, set-diff = all 60 engine codes + 13 non-engine mapper codes, nothing dead. **GOTCHA: the IDE husky hygiene hook rejects non-ASCII (em-dash `—` / arrow `→`) in TS source — use ASCII `--`/`->` in comments. Also `git checkout -- <staged file>` restores from the INDEX, not HEAD.**
   - ✅ **6.3-1b — M2 `start_recalc`/`await_recalc` (functional pre-start cancel window) — SHIPPED 2026-05-30** (HEAD `8e78e50c560` ← `5220f36cd61`). The §3.3/§6.4 cancellation acceptance item, now FUNCTIONAL: pre-6.3-1b `cancel(op)` wrote `Canceled` but NOTHING read it + the single `recalcDirty/recalcAll` napi call held the lock through the whole synchronous recompute → ZERO window. v1 can't mid-flight abort (`recompute_*` synchronous commit-as-you-go; `CalcgraphSession` not Clone), so the fix is the start/await split. AskUserQuestion → **add start/await, keep recalc\***. Engine (`EngineSession` trait): `start_recalc(RecalcKind)->op` (reserve-only: `Running`+`Busy`+`pending_recalc`, NO compute, lock releases → window opens) + `await_recalc(op)` (reads the cancel registry: skips recompute + surfaces `Canceled` if a `cancel` won the window, else dispatches to the shared `execute_recalc`). `run_recalc` body → `execute_recalc` (single recompute path + the 6.3-1a L8 panic terminalization); `recalc_dirty/recalc_all` = thin start+await convenience wrappers (one locked call → no window, behavior identical). `RecalcKind` → `ql-session::operation`. napi: `startRecalcDirty/startRecalcAll/awaitRecalc/cancel` (guarded+catch_unwind, BigInt sign/lossless validation); `recalcDirty/recalcAll` kept; `operationStatus` deferred to 6.3-1c (needs the `OperationStateJson` DTO). Parallel Codex(xhigh)+Opus closure audit → **1 HIGH, BOTH lanes reproduced** (Codex DO-NOT-SHIP/Opus SHIP-WITH-FIXES): `start_recalc`→`close()`→`await_recalc` RESURRECTED a terminal session (`close()` set `Closed` without draining `pending_recalc`; `await_recalc` had no lifecycle gate → ran the deferred recompute + flipped `Closed→Ready`). FIXED (`8e78e50c560`): `close()` terminalizes the stranded op `Canceled`+event; `await_recalc` rejects terminal (`invalid_state`). All other dimensions clean (window real, no-late-commit, Busy lifecycle, pending integrity, L8 preserved, wrappers byte-equiv). ql-exec lib 802/0, debug+release build, clippy no-new, node smoke proves the window end-to-end (cancel skipped recompute, session usable). **GOTCHA: `RecalcKind` is a trait-param so it MUST live in ql-session (where the `EngineSession` trait is), not ql-exec.**
   - ✅ **6.3-1c — M5 + §4b DTO field-parity sweep — SHIPPED 2026-05-30** (engine `fc33fd551e5` ← `7b2a7752d1a`; IDE `2304b74478c` ← `60c21c741bb` ← `0b1a4695dc4` on `feat/visualise-v1`; the IDE tail is a post-audit completeness-sweep fix updating two `WorkbookSnapshotJson` mocha shape-pins for `schemaVersion`). The LAST 6.3-1 machinery item → 6.3-2 (bind 32 methods) is now fully unblocked. **(1) Structured error (§5.1)** — engine-taxonomy errors reach JS as NATIVE own-properties (`.code`/`.class`/`.retryable` + `.details` JSON-string / `.source`), NOT a `[code]`-prefix message. napi-rs 3.9.0's `Result<T>` path can't carry a custom `.code`, so `guarded(env,…)` is the single throw point: `engine_error_to_napi(env,e)` → `throw_structured` builds the JS error via `Env::create_error`+`Object::set` and `Env::throw`s it, returning `Status::PendingException` (napi `throw_into` short-circuits on that → our object propagates verbatim, no double-throw; confirmed against napi-3.9.0 `error.rs:488`). **DECISION/refinement vs the plan:** only the `EngineSession` taxonomy goes native; FFI arg-validation `bad_argument` (`validate_*`/`bad_argument_error`) + collab (`collab_session_error_to_napi`) + udf-spawn KEEP the `[code]` prefix (uniform `class=BadArgument`, no details) — this avoided converting the whole validator/metadata chain to `EngineError` (equivalent outcome, far lower risk, ZERO collab churn). IDE `parseQuantbookError` = native-first dual-read (native `.code` if in the 6.3-1d allowlist, else the prefix cause-walk); `QuantbookErrorInfo` +`class?`/`details?`/`retryable?`. **(2) M5 schema_version** on `WorkbookSnapshotJson`+`WorkbookSnapshotDeltaJson` (= `ql_session::SCHEMA_VERSION`) at every build site; IDE `QUANTBOOK_SCHEMA_VERSION`+`assertSupportedSchemaVersion` at snapshot AND delta ingest = the producer of the previously-producerless `unsupported_schema_version`. **(3) full_rebuild_reason** (§4.3) on the delta DTO — 3 designed reasons (no_prior_version/cache_cleared/stale_horizon) at their collab decision points, `None` for non-enumerated (malformed token/rename/guard). **(4) CellValue.blank** added to IDE `CellValueJson` (engine converter already emitted it); `QuantbookCellValue` (collab CellWireValue mirror) correctly NOT touched. **(5) operationStatus** bound (existing DTO+converter) → 6.3-1b start/await+cancel outcome observable from JS. Parallel Codex(xhigh)+Opus closure audit → **0 HIGH/DO-NOT-SHIP both lanes**; 1 Codex LOW (build-failure arm hid `build_err` → `fc33fd551e5`) + 1 Opus MED (delta-ingest schema assert one-sided → IDE `60c21c741bb`) fixed. ql-exec 802/0, debug+release build, clippy no-new, smoke proves native `code=panic`/`sheet_name_duplicate`+class+retryable / `schemaVersion===1` / `operationStatus` completed+canceled; IDE tsc+eslint clean. **GOTCHAS: (a) the structured reshape means engine-error MESSAGES no longer carry the `[code]` prefix — any smoke/test asserting `/\[code\]/` on `.message` for an engine error must switch to checking native `.code` (migrated the smoke to a dual-accept `throwsWithCode` helper). (b) napi `#[napi]` methods take an injected `env: Env` param with NO change to the JS call signature.** **FILED FORWARD:** nest a structured error in `OperationStateJson.error` (kept as `[code] message` string this increment); `details` as a native nested object (needs napi `serde-json` feature); §4b parity for `RangeResult`/`TableSpec`/`BatchResult`/`UndoRedoResult`/transaction DTOs as they bind in 6.3-2; `version()`/`CollabSession`/`Transport` napi surfaces still lack `catch_unwind` (6.3-1a INFO).
   - ✅ **6.3-2a — read/lifecycle/format/validate cluster — SHIPPED 2026-05-30** (engine `4a46822a475` on `feat/quantbook-engine`; IDE `dcebfc170f4` ← `b08110563e1` on `feat/visualise-v1`). **6.3-2 is decomposed into 5 auditable sub-increments** (a: read/lifecycle/format/validate · b: persistence · c: structure/sheets · d: tables · e: atomic groups + the 5 reserved §2c capability stubs), one shipped per session per the 2-cycle cap; 6.3-2a is the first. Bound 6 `EngineSession` methods on the owning `Session` napi class — `lifecycleState` (infallible, wire string, works on terminal sessions), `validateFormula` (diagnostics-as-DATA — a bad formula → `Vec<Diagnostic>`, NEVER a throw), `queryRange` (→ `RangeResultJson`, columnar; `include_*` → loud `not_implemented_in_v1_core`), `markVolatilesDirty`, `setFormat`, `registerFormat` — each inheriting the locked 6.3-1 contract (`guarded(env,…)`+`catch_unwind`, native structured errors, BigInt sign/lossless validation, No-Fallbacks). New napi `#[napi(object)]` mirrors: `CellRangeJson`/`RangeQueryOptionsJson`/`RangeColumnJson`/`RangeResultJson` (§4b: `RangeResultJson` FORWARDS the engine DTO's own `schema_version`, not a re-derived constant). New helpers: `lifecycle_state_str` (all 5 LifecycleState variants), `session_format_id_from_json` (reverse of `format_id_json_from_session`; BigInt `customPeer` sign/lossless-validated; missing-payload/unknown-kind rejected loud), `session_range_from_json` (sheet u16 + 4 bounds u32; inverted bounds LEFT to the engine), `range_result_json_from_session`. Reused the EXISTING IDE `DiagnosticJson`/`FormatIdJson`/`CellAddrJson` mirrors (the 6.3-2 exploration map wrongly flagged `DiagnosticJson` as missing — it was present at `types.ts:1473`). Parallel Codex(high)+Opus closure audit → **0 HIGH/0 MED BOTH lanes** (Codex: no findings at ANY severity; Opus: 2 LOW — `RangeQueryOptions`→`RangeQueryOptionsJson` naming parity, fixed in `dcebfc170f4`; + no `queryRange` IDE consumer yet, EXPECTED for a binding-only increment). ql-exec 802/0, debug+release build, ql-bindings-node clippy 0 warnings, node smoke green (queryRange schemaVersion=1 + columnar A1:B1 + format round-trip + diagnostics-as-data + lifecycleState=ready), IDE tsc+eslint clean, no mocha shape-pin drift. **GOTCHA: `registerFormat("0.00")` dedups to a BUILTIN format index, not custom — the smoke asserts `kind` is builtin|custom + exercises the custom/BigInt reverse-converter path via a fail-loud negative-`customPeer` case.** **NEXT = 6.3-2b (persistence: open/save/import/export — the M7 effective-extent land-vs-defer-to-v1.5 decision rides here); then 6.3-2c structure, 6.3-2d tables, 6.3-2e atomic groups + reserved stubs; then 6.3-3 live-grid.**
   - ✅ **6.3-2b — persistence + M7 effective-extent — SHIPPED 2026-05-30** (engine `841298fe50e` on `feat/quantbook-engine`; IDE `fb8b359bda5` on `feat/visualise-v1`). **Part 1 (bindings):** bound `open`/`save`/`import`/`export` on the owning `Session` napi class (Uint8Array byte payloads, no new DTOs) — the engine-side EngineSession methods (inc.2c-9/10/11/12) were already implemented, so this was the mechanical binding layer inheriting the locked 6.3-1 contract (`#[napi(js_name, catch_unwind)]` + injected `env: Env` + `guarded(env,…)` + native `engine_error_to_napi`). IDE mirrors: 4 `SessionInstance` sigs (types.ts, Uint8Array in/out) + loader presence-list block. **Part 2 (M7 — user chose LAND NOW, uniform across all three serializers, AFTER exploration corrected the framing: only CSV had genuinely blank-inflated OUTPUT; xlsx/.qbook already skip blank cells, so for them bounds only drove the iteration range + a write-only envelope field):** new `Sheet::effective_value_bounds()` (via `ColumnStore::effective_max_row`, cascade-correct — honors user→computed→base; a `Blank` overlay shadowing a non-null base reads Blank and is EXCLUDED, the E2 trap). `Sheet::bounds()` + its never-shrinks contract UNTOUCHED (serializer-only). Adopted lossless-per-serializer: **CSV** (`ql-io-csv`) → swap to `effective_value_bounds` (value-only, no format/formula channel → zero loss; interior blanks preserved for rectangular alignment, trailing trimmed); **.qbook** (`ql-io/qbook_format.rs`) → narrowed JSONL value-walk (the existing formula-only pass over `iter_formulas()` is the net for formula cells outside the value bbox; format-only cells ride the bounds-independent envelope `format_overlay` section) + envelope `row/col_extent` → NEW `effective_sheet_footprint()` = honest union(value ∪ formula ∪ format positions), a true UPPER bound (never under-reports); **xlsx** (`ql-io-xlsx/umya_export.rs`) → value-walk rectangle = `effective_value_bounds ∪ per-sheet formula bbox` (from the existing `formula_map`) — MANDATORY since xlsx has NO formula-only pass and a formula can compute to `Blank` (`=A1` over empty A1, `scalar.rs:1591`), so a value-only narrowing would silently drop it; the format-overlay pass (`umya_export.rs:570+`) left bounds-independent (untouched). Tests: ql-storage **+10** (incl. the E2 overlay-Blank-shadows-base trap + E3 computed-Blank + short-tail-overlay + all-blank-column-shrinks-col_extent), ql-io-csv **+3**, ql-io **+4** (format-only + formula-only survival + honest-envelope + round-trip-stable), NEW `ql-io-xlsx/tests/effective_extent.rs` **+4** (the core formula-outside-value-bbox-survives fix + format-only-survival guard + trailing-blank + in-bbox regression); smoke +6.3-2b block (.qbook save/open + csv export/import round-trips + xlsx-export capability error + loud import negatives). Parallel **Codex(high)+Opus** closure audit → **0 HIGH/0 MED BOTH lanes** (Codex: 0 findings at ANY severity; Opus: 1 LOW — `checked_add` extent-overflow consistency between `effective_value_bounds` and the footprint/xlsx sites — APPLIED, folded into the feat). ql-exec lib 802/0 (default + xlsx-write), ql-storage 209/0, ql-io 122/0, ql-io-csv 14/0, ql-io-xlsx 113/0, workspace check clean, clippy no-new-warnings-in-edited-files, debug+release cdylib, node smoke green, IDE tsc+eslint clean. **M7 is now CLOSED** (the ambiguously-filed cross-cutting item). **GOTCHA: `put_formula` (low-level, used by tests/loaders) inserts formula TEXT only — it does NOT grow `Sheet::bounds`; the real `set_formula` path writes a computed value via `put_computed` which DOES grow bounds. So the xlsx union-from-`formula_map` (not from bounds) is what guarantees a formula cell is walked regardless of how it was created.**
   - ✅ **6.3-2c — structure / sheets — SHIPPED 2026-05-30** (engine `529b9d2ba0f` on `feat/quantbook-engine`; IDE `815b4b313c0` on `feat/visualise-v1`). The THIRD of 6.3-2's 5 sub-increments. Bound 5 already-implemented `EngineSession` structure mutators on the owning `Session` napi class — `renameSheet(id, newName)` / `deleteSheet(id)` / `restoreSheet(id)` / `moveSheet(id, newIndex)` / `setName(name, target)` (`addSheet` was bound earlier) — each inheriting the locked 6.3-1 contract (`#[napi(js_name, catch_unwind)]` + injected `env: Env` + `guarded(env,…)` + native `engine_error_to_napi`). **Pure binding layer — NO engine logic changed** (the engine methods + all their edge cases were shipped + tested earlier at `ql-exec/src/session.rs:1772-1924`). **No new DTOs:** sheet ids validated to u16 via `validate_u16_index`, `moveSheet` `newIndex` to u32 via `validate_u32_index`, `setName`'s range reuses the 6.3-2a `CellRangeJson` / `session_range_from_json`. IDE: 5 owning-`SessionInstance` sigs (types.ts, after the 6.3-2b block) + a 6.3-2c loader presence-block. Smoke +6.3-2c block: rename/move(+no-op)/delete+restore round-trips observed through `listSheets()` (display-order-reflecting) + an **OBSERVABLE** `setName` (`SUM(Nums)` resolves to 60, replacing the weak did-not-throw assert) + the inverted-range-normalizes-to-same-rectangle pin + loud negatives (`sheet_not_found` on every unknown-id mutator / `sheet_name_duplicate` on dup rename / `bad_argument` on out-of-range move / `sheet_not_deleted` on restore-of-live). Parallel **Codex(high)+Opus** closure audit → **0 HIGH; 0 MED net**. Opus: 0 HIGH/0 MED, 1 LOW (stale UNTRACKED `.node` artifact = non-issue; the smoke loads the fresh `target/debug` dylib + the `.node`-into-IDE rebuild is the standing deferred follow-up; no prior increment committed a `.node`). Codex: 1 MED + 1 LOW, BOTH on `setName` — **user chose document + observable smoke** (the cross-lane catch Opus missed): `setName` silently NORMALIZES an inverted range to `start<=end` per axis via the engine's canonical `Range::new` (Excel named-range semantics) whereas `queryRange` REJECTS inversion with `bad_argument` (its `end-start+1` span arithmetic would underflow — a hazard `set_name` lacks). Resolution = NOT an engine behavior change: documented the normalization in BOTH docstrings (Rust `lib.rs` + IDE `types.ts`) so it is a stated contract not a silent fallback, + the observable smoke pins it; the `query_range`-vs-`set_name` inversion asymmetry is **FILED FORWARD** for the engine team (an engine-side API choice, not a binding defect). The audit-fix was FOLDED into the feat commit (working-tree audit, both lanes otherwise clean). ql-exec lib 802/0 (default + xlsx-write — unchanged, no engine logic touched), clippy no-new-in-edited-files, debug+release cdylib, node smoke green, IDE tsc+eslint clean, no mocha drift. **GOTCHAS: (a) the OWNING `Session` napi class is `impl Session` at `lib.rs:~5228`; the `renameSheet`/etc. at `lib.rs:1314-1635` are the LEGACY CollabSession class (typed `id: u32` + inline-check) — DO NOT touch those. (b) Committing via `mac zsh -lc '...'` with a nested heredoc BREAKS on an apostrophe (closes the outer single-quote) — write the commit message to a repo-local file (the shared Mac filesystem; `/tmp` is NOT shared between the Linux VM and the Mac host) and `git commit -F <file>`.** **NEXT = 6.3-2d (tables: create/rename/rename_column/resize/drop — needs a NEW `TableSpecJson` `#[napi(object)]`; first sub-increment that adds a DTO); then 6.3-2e (atomic groups batch/begin/txn_add/commit/rollback + the 5 reserved §2c capability stubs); then 6.3-3 live-grid (undo/redo/can_undo/can_redo/snapshot_delta-on-Session + M6 event-ring).**
   - ✅ **6.3-2d — tables — SHIPPED 2026-05-30** (engine `47342ec670d` on `feat/quantbook-engine`; IDE `27a8d8d3bc9` on `feat/visualise-v1`). The FOURTH of 6.3-2's 5 sub-increments and the FIRST to add a new DTO. Bound 5 already-implemented `EngineSession` table mutators on the owning `Session` napi class — `createTable(spec)` / `renameTable(oldName, newName)` / `renameColumn(table, oldCol, newCol)` / `resizeTable(name, newRows, newCols, addedColumns, removedColumns)` / `dropTable(name)` — each inheriting the locked 6.3-1 contract (`#[napi(js_name, catch_unwind)]` + injected `env: Env` + `guarded(env,…)` + native `engine_error_to_napi`). **Pure binding layer — NO engine logic changed** (engine methods + all edge cases shipped + tested earlier at `ql-exec/src/session.rs:1933-2027`; create gates `require_live_sheet` then rows/cols>0/footprint/overlap/column-name rules, the rest map via `map_runtime_err`, all `bump_epoch` since table ops are not delta-expressible). **NEW DTO:** `#[napi(object)] TableSpecJson` (mirrors `ql_session::TableSpec`, placed beside `CellRangeJson`) + converter `session_table_spec_from_json` (`sheet`→u16 via `validate_u16_index`; `topRow`/`topCol`/`rows`/`cols`→u32 via `validate_u32_index`; the u32 validator PERMITS 0, so a zero-dim spec reaches the engine and surfaces `table_create_rejected`, NOT a boundary `bad_argument` — faithful; `name`/`column_names` pass through). `resizeTable` validates `newRows`/`newCols` the same way. IDE: `TableSpecJson` interface (camelCase mirror) + 5 owning-`SessionInstance` sigs (types.ts, after the 6.3-2c block) + a 6.3-2d loader presence-block. **Smoke +6.3-2d block:** tables have NO read surface (`snapshot()` does not surface tables), so OBSERVABLE via a structured-reference formula `SUM(Sales[Qty])` — resolves to 30 after create (a no-op create would leave `#NAME!`); after `renameColumn`(Qty→Quantity) the NEW column name binds (fresh `SUM(Sales[Quantity])`→30) and the OLD name throws `[formula_bind]` (setFormula rejects an unbindable structured ref eagerly; a bind error does NOT fault the session since `with_runtime`'s FaultGuard only fires on a panic); same pin for `renameTable`(Sales→Revenue); `resizeTable` grows the data range so the SUM TRACKS to 70 (10+20+40, OBSERVABLE not just no-throw); `dropTable`→the ref re-binds to a `#NAME?` error VALUE on recompute (pinned via `.value.error` includes `NAME`). Loud negatives cover all 6 table codes (`table_create_rejected` ×2 incl. zero-rows, `sheet_not_found` on a non-live sheet, `table_not_found` on rename/drop/resize/rename-column of unknown, `table_column_not_found`, `table_column_rejected` on empty-new-name, `table_resize_rejected` on zero rows). Parallel **Codex(high)+Opus** closure audit (working tree) → **0 HIGH; binding code SHIP both lanes** (field parity exact, zero-permitting validation faithful, no fallbacks). Opus: 0/0/0. Codex: SHIP-WITH-FIXES on the SMOKE only — caught 2 MED + 1 LOW coverage holes Opus missed (the cross-lane catch: renameColumn/renameTable "still 30" would ALSO pass under a silent no-op since the old identifier still binds; missing `table_column_rejected`/`table_resize_rejected` negatives; drop not pinned to `#NAME?`) → ALL folded in as smoke hardening (no production change). ql-exec 802/0 (default + xlsx-write — unchanged), clippy no-new-in-edited-files, debug+release cdylib, node smoke green, IDE tsc+eslint clean. **GOTCHAS: (a) `create_table` writes NO cell values — only `TableMetadata`; column names live in metadata, NOT cells, so a table is observable only via a structured-reference formula, never by reading a header cell. (b) A formula set with an unbindable structured ref THROWS `[formula_bind]` at `setFormula` time; a formula INVALIDATED LATER (by drop/rename) becomes a `#NAME?` error VALUE on recompute — different surfaces. (c) `resizeTable(name, newRows, newCols, [], [])` is valid for a row-only grow when `newCols==oldCols`; the added/removed column lists must reconcile with the col delta.** **NEXT = 6.3-2e (atomic groups: batch/begin/txn_add/commit/rollback + the 5 reserved §2c capability stubs); then 6.3-3 live-grid (undo/redo/can_undo/can_redo/snapshot_delta-on-Session + M6 event-ring).**
   - ✅ **6.3-2e — atomic groups + reserved §3.5 stubs — SHIPPED 2026-05-30 — 6.3-2 COMPLETE** (engine `861cb14b55f` on `feat/quantbook-engine`; IDE `7dcf0acf030` on `feat/visualise-v1`). The FIFTH and final of 6.3-2's 5 sub-increments. Bound 10 already-implemented `EngineSession` methods on the owning `Session` napi class — atomic groups `batch(ops, options)` / `beginTransaction()` / `txnAdd(txn, op)` / `commitTransaction(txn)` / `rollbackTransaction(txn)` + the 5 reserved §3.5 stubs `writeRange` / `publishDataset` / `bindRange` / `refreshSource` / `materializeQuery` (thin loud-Capability forwarders, declared `-> ()`, always `not_implemented_in_v1_core`) — each inheriting the locked 6.3-1 contract (`#[napi(js_name, catch_unwind)]` + injected `env: Env` + `guarded(env,…)` + native `engine_error_to_napi`). **Pure binding layer — NO engine logic changed** (engine methods + the all-or-nothing/conflict/atomicity guarantees shipped + tested at `ql-exec/src/session.rs:2073-2466`, tests `6578-7322`). **3 NEW DTOs:** `#[napi(object)] SessionOpJson` (a `kind`-tagged STRICT mirror of the 4-variant `ql_session::session::SessionOp` — `setValue`/`setFormula`/`clear`/`setFormat`; each kind admits ONLY its own payload, an extraneous-for-kind field is a loud `[bad_argument]` like `arity_from_json`), `BatchOptionsJson` (`undoLabel?`), `BatchResultJson` (`applied` + `version` = the opaque `SessionVersion(Vec<u8>)` as a `Buffer`, like `WorkbookSnapshotJson.version`). New converters `session_op_from_json` / `transaction_id_from_bigint` (BigInt→u64, sign/lossless-validated like `awaitRecalc`) / `parse_reserved_json_payload` (reserved `data` crosses as JSON text since the napi `serde-json` feature is off; bad JSON → `[bad_argument]`). `TransactionId(u64)` carried as a JS `BigInt`. IDE: `SessionOpJson`/`BatchOptionsJson`/`BatchResultJson` interfaces (`version: Uint8Array`) + 10 owning-`SessionInstance` sigs + loader presence-block. **Smoke +6.3-2e block:** batch applies atomically + is OBSERVABLE (A1=5, B1=A1*2=10, `applied===2`, non-empty version Buffer); all-or-nothing rejects the WHOLE batch on a same-cell value/formula conflict (`conflicting_batch_ops`) with no partial mutation — proven CROSS-CELL (a valid op on a different cell in the rejected batch also does not land); transaction begin/add/commit observable (D2=C2+1=8, `applied===2`) + distinct ids; rollback discards AND consumes the handle (a follow-up `txnAdd` → `transaction_not_found`); the 5 reserved stubs throw `not_implemented_in_v1_core`; arg validation loud (unknown kind / missing-for-kind payload / extraneous-for-kind payload / malformed JSON → `bad_argument`). Parallel **Codex(high)+Opus** closure audit (working tree) → **0 HIGH; binding code SHIP both lanes**. Folded in as part of the feat: the strict `SessionOp` converter (Codex MED — extraneous-for-kind fields now rejected, was silently dropped), 2 docstring corrections in BOTH repos (the unknown-txn-id code is `transaction_not_found` not `bad_argument`; the batch conflict code is `conflicting_batch_ops` not `conflicting_ops` — both already in the IDE allowlist), + the rollback-consumed and cross-cell-atomicity smoke pins (Opus/Codex LOW). FILED FORWARD (documented in the reserved-stub banner): `writeRange`'s rectangular matrix-shape rule is enforced by the REAL impl in 6.4/6.5, not the v1 reserved forwarder (Capability is the authoritative v1 signal — adding speculative validation would bake in a contract the real impl should define). ql-exec 802/0 (default + xlsx-write — unchanged), clippy no-new-in-edited-files, debug+release cdylib, node smoke green, IDE tsc+eslint clean. **GOTCHAS: (a) `SessionOp`/`TransactionId` live at `ql_session::session::` (NOT re-exported at the `ql_session::` root — only `EngineSession` is); `BatchOptions`/`BatchResult`/`SessionVersion` are in `dto.rs` (re-exported via `pub use dto::*`). (b) an unbindable structured ref / malformed op THROWS at the call (not an error cell); a reserved stub always Capability-errors so its `napi` return is `-> ()` with `.map(|_| ())` on the unreachable Ok arm. (c) the engine `txn_add`/`commit`/`rollback` all return `transaction_not_found` (NotFound) for an unknown handle; a FAILED commit RESTORES the buffer (txn stays open).** **6.3-2 is now COMPLETE — all 32 EngineSession methods bound across sub-increments a–e.**
   - ✅ **6.3-2 closure hardening — SHIPPED 2026-05-30** (engine `1231e432eb2` on `feat/quantbook-engine`; IDE `037421ff38a` on `feat/visualise-v1`). Closes the one real defect class from the 5-way 6.3-2 closure megaudit (synthesis `docs/audits/2026-05-30-6-3-2-closure-megaudit/SYNTHESIS.md`, now marked RESOLVED). **No-Fallbacks coercion fix (megaudit H1/H2):** three `#[napi(object)]` DTOs declared `u32` fields directly → napi-rs `ToUint32`-coerced a malformed JS Number (NaN/Inf→0, 2.9→2, -1→u32::MAX) into a valid-looking value BEFORE the converter ran (violating the documented `validate_u32_index` convention at `lib.rs:159-230`). Fixed: `FormatIdJson.builtin`/`customCounter` + `ArityJson.n`/`min`/`max` retyped `Option<u32>`→`Option<f64>`; producers cast `as f64`; `session_format_id_from_json` validates via `validate_u32_index`; `arity_from_json` validates via `validate_u32_index` then keeps `u8::try_from` + inverted-range. **Strict tagged unions (M1/M2):** `session_cell_value_from_json` + `session_format_id_from_json` now reject extraneous-for-kind fields loudly (the `reject_extra` pattern from `session_op_from_json`/`arity_from_json`). **IDE parity backfill (X1/X2):** 4 missing `SessionInstance` sigs (`close` 6.1C M8; `registerFunction`/`unregisterFunction`/`listFunctions` 6.4-2) + `ArityJson`/`FunctionMetadataJson` interfaces + loader presence entries (pre-existing surface, no new methods; `function_exists`/`function_not_found` were already in the allowlist). **Smoke (Opus-3 coverage):** coercion negatives (builtin NaN/2.9/-1, arity n=2.9/NaN), strict-union negatives (blank+number, builtin+customPeer), `pollEvents` page-shape + `pollEvents(-1n)`, an OBSERVABLE `recalcAll` (A1 mutated AFTER setFormula so a stale 12 vs recomputed 14 pins real recompute), `setUdfWorker` handshakeTimeoutMs arg-validation (fires before the eager spawn). **Docstrings (Opus-2 LOWs, both repos):** setFormula `formula_bind`, import `csv_exceeds_limits`, operationStatus all-states, restoreSheet `sheet_not_deleted`, batch Phase-3 note. Parallel **Codex(high)+Opus** re-audit → **0 HIGH / 0 MED both lanes**; 2 Codex LOWs folded into the feat (the recalcAll smoke was a wrong-reason assert since `set_formula` computes eagerly → strengthened by mutating the input post-set; a stale `FormatIdJson` Rule-4 doc still said `Option<u32>` → corrected). **NO engine logic changed.** ql-exec 802/0 (default + xlsx-write, unchanged), clippy 0-new in ql-bindings-node (the 3 warnings are pre-existing in ql-collab/ql-oplog/ql-exec/ql-storage), debug+release cdylib, node smoke all blocks green, IDE tsc=0/eslint=0 (husky hygiene caught one non-ASCII `≡` in a doc → fixed to ASCII before commit). **GOTCHAS: (a) napi `u32`/`u16` params + `Option<u32>`/`Option<u16>` DTO fields silently `ToUint32`-coerce; the convention is to take them as `f64` and validate via `validate_u32_index`/`validate_u16_index` — output-only DTO fields (built by `*_from_session`/`From`) are safe and stay `u32`. (b) `set_formula` EAGERLY computes the formula value at set time, so an observable recalc smoke MUST mutate an input AFTER the formula is set, else the dependent is already correct and a no-op recalc would pass. (c) IDE husky `build/hygiene.ts` rejects ANY non-ASCII in TS — grep the FULL diff `^\+` lines for `[^\x00-\x7F]`, not just keyword-scoped, before committing.**
   - ✅ **6.3-3 — live-grid + ops cluster — SHIPPED 2026-05-30** (engine `be2b1547dac` on `feat/quantbook-engine`; IDE `cb3ca7cedca` on `feat/visualise-v1`). Bound the **5 remaining** owning-`Session` methods — `snapshotDelta`/`undo`/`redo`/`canUndo`/`canRedo` (the other listed cluster members `cancel`/`operationStatus`/`pollEvents` + the event-ring read already landed at 6.3-1b/c + 6.4-3d; `snapshot_delta`'s spill-footprint prereq shipped at 6.3-0). **Pure binding layer — NO engine logic changed** (the `EngineSession` methods + their `snapshot_delta_*`/`undo_redo_*` tests already exist at `ql-exec/src/session.rs:2674+`). Each inherits the locked 6.3-1 contract. **NEW DTO `UndoRedoResultJson { consumed: bool, version: Buffer }`** (mirrors `ql_session::dto::UndoRedoResult`; `consumed:false` on an empty stack is a normal return, NOT a throw). **NEW converter `workbook_snapshot_delta_json_from_session`** — maps the engine `WorkbookSnapshotDelta` to the EXISTING `WorkbookSnapshotDeltaJson` (reuses the snapshot sub-converters `cell_snapshot`/`sheet_snapshot`/`format_id` + `full_rebuild_reason_str`; forwards the engine delta's own `schema_version` per M5; this is the EngineSession delta path, DISTINCT from the legacy CollabSession CRDT delta builder `empty_delta`). `snapshotDelta(lastVersion: Buffer)` → `SessionVersion(lastVersion.to_vec())`; round-trips verbatim. `canUndo`/`canRedo` are ungated pure reads (`guarded` only for the panic boundary). IDE: `UndoRedoResultJson` interface + 5 `SessionInstance` sigs + loader presence-block (`WorkbookSnapshotDeltaJson` already existed IDE-side from 6.3-1c; `invalid_state`/`invalid_version_token` already in the allowlist). Smoke +6.3-3: incremental `snapshotDelta(snapshot().version)` carries the mutated D3=77 (`schemaVersion===1`, `fullRebuildRequired===false`); empty token → `no_prior_version` full rebuild; undo reverts D3 to absent (`cell()===null`) + redo restores 77 (OBSERVABLE); a post-undo `snapshotDelta` against a pre-undo token → `epoch_mismatch` full rebuild (undo mints a new epoch); the empty undo stack returns `consumed:false` after a bounded drain (addSheet is itself undoable); post-close `snapshotDelta`/`undo`/`redo` → `[invalid_state]` while `canUndo`/`canRedo` stay pure bool reads. Parallel **Codex(high)+Opus** closure audit (working tree) → **0 HIGH / 0 MED / 0 LOW both lanes** (delta converter field-complete + lossless `u16→u32`/`Vec<u8>→Buffer`, `schema_version` forwarded not re-derived, `consumed:false`-as-data, gating matches the smoke, every smoke assert fails under a broken binding, IDE parity + allowlist intact, the `&self`+`inner.lock()` interior-mutability for the `&mut self` undo/redo trait methods is sound). ql-exec 802/0 (default + xlsx-write, unchanged), clippy 0-new in ql-bindings-node, debug+release cdylib, node smoke all blocks green, IDE tsc=0/eslint=0. **GOTCHAS: (a) `undo`/`redo`/move/restore/table-ops MINT A NEW EPOCH → a `snapshotDelta` against a pre-op token full-rebuilds with `epoch_mismatch` (NOT incremental); `set_value` does NOT bump the epoch. (b) `can_undo`/`can_redo` return plain `bool` (ungated pure reads) → they do NOT throw post-close, unlike the gated `snapshotDelta`/`undo`/`redo`. (c) `addSheet` is an undoable step, so a fresh session's undo stack is not just the explicit edits — drain with a bounded loop to reach the empty-stack `consumed:false` case. (d) the owning-`Session` delta is the EngineSession `WorkbookSnapshotDelta` path; the CollabSession `empty_delta`/loro-VV builder is a DIFFERENT class — do not reuse it.** **NEXT = 6.3-4 (thin Python session facade) → 6.3-5 (golden parity matrix + closure megaudit).**
   - ✅ **6.3-4 — thin Python (pyo3) session facade + golden parity matrix — SHIPPED 2026-05-31** (engine `38f4f51dfac` on `feat/quantbook-engine`; engine-only, no IDE change). The SECOND binding row that freezes the 6.3 contract. `crates/quantbook-py` (a pure-Python crate: the 6.4B UDF worker + an empty Rust stub) gains a real pyo3 extension `quantbook._quantbook` with a THIN `Session` facade (~24 golden-flow methods) over the SAME `EngineSession` contract the napi binding wraps. NO engine logic changed. Cargo: `crate-type=["cdylib","rlib"]` + `pyo3` (workspace abi3-py310) with `features=["macros"]` re-added (the workspace pin's `default-features=false` drops the proc-macro attrs -- the key first-build gotcha) + `ql-session`/`ql-exec`/`parking_lot`/`serde_json`; OUT of `default-members`. NEW `build.rs` = macOS-only cdylib-scoped `-undefined dynamic_lookup` (extension-module cdylib does not link libpython -> raw `cargo build` + load `.dylib`->`_quantbook.so` by path, NO maturin). Facade mirrors `ql-bindings-node/src/lib.rs`: `guarded(py,..)` catch_unwind -> structured `QuantbookError` (code `panic`); `QuantbookError(Exception)` carries code/class/retryable/details(JSON-str)/source; DTOs cross as plain Python dicts with the SAME napi camelCase keys; strict tagged-union input converters reject extras; `req_str_list` errors on a missing required list (No-Fallbacks); `u64_from_pyany` makes every out-of-domain int a structured `bad_argument`. **GOTCHA: pyo3 0.28 forbids a 2nd `#[pymethods]` block (`E0119`) without `multiple-pymethods` -- so `__force_panic_for_test` is a PER-METHOD `#[cfg(debug_assertions)]` INSIDE the single block, the INVERSE of the napi whole-block lesson.** Golden parity matrix (`crates/quantbook-py/tests/{golden_flow.py,parity_matrix.py}` + `crates/ql-bindings-node/tests/golden_flow.mjs`): both emit a canonical key-sorted 22-step transcript; comparator masks only `version`/`nextCursor`, refuses a <10-step vacuous transcript, asserts byte-identical. Parallel Codex(high)+Opus, TWO rounds: round 1 BLOCK both (save/open unbound; E0119; batch rejected setFormat; required lists silently `[]`; oversize ints leaked a pyo3 error) -- all folded; the matrix itself then caught a real cross-binding divergence (napi FFI `bad_argument` sets `.code="GenericFailure"` with the code in the message prefix; structured errors set native `.code` -> the `.mjs` errCode helper now prefers the prefix then falls back). Round 2 SHIP / 0 HIGH / 0 MED both lanes; 1 LOW filed (release omits the panic probe -> release-only run records a synthetic panic row; verified run uses the debug cdylib). cargo build -p quantbook-py debug+release 0/0 (`_PyInit__quantbook` in both); clippy 0 in-crate; default-members + ql-bindings-node 0 errors; ql-exec 802/0 (default + xlsx-write, unchanged); node smoke exit 0; **parity_matrix.py PARITY OK (22 steps matched Node + Python)**. **NEXT = 6.3-5 (declare the contract frozen on >=2 passing rows + the full closure megaudit). Filed forward: full qb.show/publish/bind + the 5 §2c bulk methods (6.5); maturin/wheel packaging; widen register_function/poll_events to reject >u64 as bad_argument is already done via u64_from_pyany.**
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
