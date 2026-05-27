# 6.1B Increment 2 — `WorkbookSession` Implementation Plan

**Status:** ⏳ IN PROGRESS — **2b/2c-1/2c-2 + audit-fix SHIPPED 2026-05-26; inc.2 audit (F3–F10) +
inc.2c-3 `snapshot_delta` + inc.2c-4 `batch` + inc.2c-5 transaction handle + inc.2c-6 F2 `Op::ClearValue`
+ inc.2c-7 undo/redo + inc.2c-8 F10 atomic table-rename + inc.2c-9 `.qbook` open/save (Option 1)
+ inc.2c-10 xlsx `import` (dependency-inverted `ql-io-xlsx`) + inc.2c-11 csv `import`/`export`
(new pure-I/O `ql-io-csv`) + inc.2c-12 xlsx `export` (in-memory `export_xlsx_bytes` + xlsx-writer
feature-gate) SHIPPED 2026-05-27.**
Chain: `83b1b33bac2` PlanCache → `7335a5a1bfa` core → `993492b6f9b` validate_formula/query_range/
`CellValue::Blank` → `2b5e7a13f5b` delete/restore/move sheet + tables → `9f7a1645dbd` tombstone-read fix →
**`879f3601747` inc.2 audit-fix (F3–F10)** → **`20427b1c4c7` inc.2c-3 snapshot_delta** → **`58a55f4cfb8`
+ `9d471be3663` inc.2c-4 batch** → `fdd80c7a43d` inc.2c-5 transaction handle → `d8d22a04248` inc.2c-6 F2
`Op::ClearValue` → `4f8e9858d77` inc.2c-7 undo/redo → `dca5695549e` inc.2c-8 F10 atomic table-rename →
`2f92d84f3ed` inc.2c-9 `.qbook` open/save → `0e932da13a7` inc.2c-10 xlsx `import` →
`54f51edfbc1` inc.2c-11 csv `import`/`export` → **inc.2c-12 xlsx `export` (this commit)**.
`WorkbookSession` is in `crates/ql-exec/src/session.rs`; **ql-exec lib 729/0 (default + `--features
xlsx-write`), clippy clean; ql-io-xlsx 60+49/0 (default = write on), reader-only `--no-default-features`
builds clean; workspace build green.** (xlsx export: see
`docs/audits/2026-05-27-inc2c12-xlsx-export-audit/`; csv: `docs/audits/2026-05-27-inc2c11-csv-audit/`;
xlsx import: `docs/api/xlsx-import-integration-plan.md`.)

## §0 — Current state: method inventory, v1 limitations & remaining sequence (READ FIRST)

> This top matter (everything between here and the `---` before `## 1. Placement`) is the **live,
> kept-current** state of the increment — the canonical "§0" the handoff docs point at. **§1–§11 below
> are the original pre-implementation design (rationale), retained but NOT updated as things shipped — they
> describe the *plan*, not the *current code*; where they diverge (e.g. the token name, the batch
> mechanism), §0 + the header above win.**

### Method status — what the next window inherits (REAL vs surfaced-not-yet)
**REAL (implemented + tested):** `lifecycle_state`, `close`; `set_value`, `set_formula`, `clear`,
`set_format`, `register_format`, `validate_formula`; `add_sheet`, `rename_sheet`, `delete_sheet`,
`restore_sheet`, `move_sheet`, `set_name`; `create_table`/`rename_table`/`rename_column`/`resize_table`/
`drop_table`; **`batch`** (inc.2c-4); **`begin_transaction`/`txn_add`/`commit_transaction`/
`rollback_transaction`** (inc.2c-5 — the multi-call handle); **`undo`/`redo`/`can_undo`/`can_redo`**
(inc.2c-7 — Loro `UndoManager` + baseline-replay re-materialization); `recalc_dirty`, `recalc_all`,
`mark_volatiles_dirty`; `query_range`, `snapshot`, **`snapshot_delta`**, `cell`, `list_sheets`; `cancel`,
`operation_status`, `poll_events`; **`.qbook` `open`/`save`** (inc.2c-9 — Option 1: reconstruct from the
envelope + fresh op-log/undo history); **xlsx `import`** (inc.2c-10 — Option-1 adoption via
dependency-inverted `ql-io-xlsx` + injected `EngineXlsxRecomputer`); **csv `import`/`export`** (inc.2c-11
— pure-I/O `ql-io-csv`; import Option-1 + no recompute; export single-live-sheet, verbatim);
**xlsx `export`** (inc.2c-12 — whole-workbook, via `ql_io_xlsx::export_xlsx_bytes` behind the `xlsx-write`
feature; without the feature → honest `Capability`). (Construction: `new`/`from_workbook`.)
**DEFERRED — return `EngineError{class:Capability, code:"not_implemented_in_v1_core"}` (honest, never a
fallback):** `register_function`/`unregister_function`/`list_functions` (6.4);
`write_range`/`publish_dataset`/`bind_range`/`refresh_source`/`materialize_query` (6.4/6.5).
(Unknown `import`/`export` formats → loud `BadArgument`, not Capability. `export("xlsx")` without the
`xlsx-write` feature is also a surfaced `Capability` — the writer's heavy codec tree is opt-in.)

### Known v1 limitations (documented, not bugs — revisit when relevant)
- **Version token = `{epoch, state_seq}`** (inc.2c-3): `state_seq` (NOT `oplog.len()`) advances on every
  committed mutation + every recompute-with-changes, so the token is a true *state* token for delta.
- **`snapshot_delta` = change-log design (a)** keyed by `state_seq` (bounded `CHANGE_LOG_CAP`); §4.3
  rules implemented (empty→NoPriorVersion, epoch→EpochMismatch, future→fail-loud `invalid_version_token`,
  `seq<floor`→StaleHorizon). **Epoch-bump (forces full rebuild) for states the delta DTO can't express:**
  `move_sheet` (reorder), `restore_sheet` (reappears at an unconveyable position), all table ops (rewrite
  arbitrary formula cells). `set_name` is delta-invisible (no names field in the snapshot DTO).
- A tombstoned sheet is uniformly `NotFound` for reads + cell/structure edits (`require_live_sheet`,
  incl. rename_sheet + create_table per F6); delete/restore use a tombstone pre-check (F5: double-delete
  = true no-op; restore-of-live = `Conflict/sheet_not_deleted`). Formula EVAL still reads tombstoned
  sheets (deliberate v1 semantic, F9 — no `#REF!` until v1.5 D7).
- `ops` HashMap + `events` Vec grow **unbounded** (no retention horizon yet); `change_log` IS bounded.
  The Loro undo stack is capped at **100 steps** (Loro default; inc.2c-7 L1) — oldest unit silently
  dropped past 100 undoable commands (bounded retention, intentional v1).
- ✅ **F2 CLOSED (inc.2c-6, `d8d22a04248`):** `set_value(Blank)` (+ batch/transaction Blank-clears) now
  emit a replayable **`Op::ClearValue`** → durable on save/load AND on undo's replay re-materialization.
  `clear_formula` deliberately unchanged (preserves values — Excel convert-to-literal).
- **undo/redo (inc.2c-7):** Loro `UndoManager` field (`set_merge_interval(0)`) → 1 command = 1 undo unit
  (every command = one Loro commit; `rename_table`/`rename_column` wrapped in `grouped()` since they emit
  N+1 commits via the F10 loop). `rematerialize` = replay the post-undo op-log onto a CLONE of the
  construction-time **baseline workbook** (NOT a fresh empty one — closes the Codex-HIGH populated-
  `from_workbook` data-loss path) → `rebuild_from_workbook` → `recompute_all` (op-log detached) →
  `bump_epoch`. Empty stack → `consumed:false`. Linear single-writer replay reproduces renames without
  the ql-collab repair passes (concurrency-only).
- ✅ **F10 CLOSED (inc.2c-8, `dca5695549e`): table rename/rename_column are now append-before-mutate
  atomic** — `rename_table`/`rename_column` collect the rename op + all `PutFormula` rewrites into ONE
  `Op::BatchCommit` appended before any mutation (mirroring `rename_sheet`). Replay applies the inner ops
  in order (re-key, then rewrite text — complementary). Focused Codex audit clean (no HIGH/MED). The undo
  `grouped()` wrapper is now defense-in-depth (the renames are single-commit by construction).

✅ **`.qbook` `open`/`save` SHIPPED (inc.2c-9).** **DESIGN FORK LOCKED — Option 1** (user-confirmed
2026-05-27): `open` reconstructs the workbook from the `.qbook` envelope and adopts it via
`*self = from_workbook(loaded_wb)` — fresh empty op-log, fresh `UndoManager`, `baseline = loaded_wb`,
re-minted epoch, reset state — then recomputes (op-log detached; saved computed values may be stale,
mirroring `loader.rs::load_workbook_and_recompute`). The loaded op-log is loaded via
`ql_io::load_workbook_with_oplog` and its op payloads are **fully validated by iterating it** (Codex HIGH:
`load_workbook_with_oplog` checks only Loro framing; per-op JSON is lazy via `iter()` — a frame-valid but
payload-corrupt sidecar must fail loud on open, not be silently discarded then masked by the next save),
then discarded. `save` writes `&self.workbook` + `&self.oplog` via `ql_io::save_workbook_with_oplog`; the
workbook name is derived from the path file-stem (no document-name metadata in v1). `map_persistence_err`
fills Appendix A (`Persistence`/`qbook_error`|`session_oplog`|`qbook_unsupported_version`|
`qbook_truncated_header`; foreign `#[non_exhaustive]` wildcard → loud `Internal`/`unmapped_persistence_error`).
**v1 limitations (documented, not bugs):** loaded op-log history not carried (re-save = this session's edits
only — the locked Option-1 trade-off); recompute-on-open; name-from-path-stem; `open` legal in `New`/`Ready`
(re-open replaces the document). Option 2 (adopt the loaded op-log) was rejected — it needs
`loaded_wb == replay(loaded_oplog)`, re-opening the data-loss bug class inc.2c-7 closed; revisit for
collab-v1.5. Parallel Codex(gpt-5.5 xhigh)+Opus audit: 1 HIGH (the sidecar-payload validation gap — FIXED)
+ LOW/INFO (docs, 2 added tests) — synthesis `docs/audits/2026-05-27-inc2c9-persist-audit/`.

**✅ xlsx `export` SHIPPED (inc.2c-12).** `export("xlsx")` serialises the WHOLE workbook via
`ql_io_xlsx::export_xlsx_bytes` (`NewWorkbook` mode) — umya 2.2.0's `writer::xlsx::write_writer<W: io::Write>`
serialises straight into a `Vec<u8>` (no tempfile); the path exporter now delegates to a shared bytes core
(`export_new_workbook_to_bytes`) + one `atomic_write_to_path`, and `post_process_zip` became the
bytes-in/bytes-out `post_process_bytes` (byte-identical output). The umya WRITER (+ its image/rav1e/exr/tiff
codecs) is behind ql-io-xlsx's `write` feature (`default = ["write"]`, `umya-spreadsheet` optional);
`ql-exec` depends `default-features = false` and gates `export("xlsx")` on its own `xlsx-write` feature
(without it → honest `Capability`). A `ql-exec` `[dev-dependencies]` re-enables `write` so the inc.2c-10
import round-trip test fixture (which calls `export_xlsx_path`) still compiles; workspace `resolver = "2"`
keeps the dev-dep `write` out of the normal lib build. Parallel Codex(gpt-5.5 xhigh)+Opus audit: CLEAN
(0 HIGH/MED/LOW; both verified the `write_writer ≡ write` byte-equivalence + the feature graph via
`cargo tree`). Synthesis `docs/audits/2026-05-27-inc2c12-xlsx-export-audit/`.

**✅ Node smoke-path migration — engine-side enabler SHIPPED (inc.2d, 2026-05-28).** The Node binding
`ql-bindings-node` now exposes the owning `WorkbookSession` over napi as a new **`Session`** class
(`Arc<parking_lot::Mutex<ql_exec::WorkbookSession>>`) — `new`/`addSheet`/`setValue`/`setFormula`/`clear`/
`recalcDirty`/`recalcAll`/`snapshot`/`cell`/`listSheets`, with `engine_error_to_napi` + DTO mappers reusing
the existing `#[napi(object)]` shapes, `f64`+`validate_u16/u32_index` discipline, and a positive
`WorkbookSession: Send` compile-proof. The existing `CollabSession` CRDT façade is untouched (collab = v1.5).
A plain-Node `process.dlopen` smoke (`crates/ql-bindings-node/tests/smoke_session.mjs`) proves
edit→recalc→snapshot through the owning session over FFI. Parallel Codex+Opus audit **SHIP** (0 HIGH/MED;
1 LOW doc-fix applied; rest tracked) — synthesis `docs/audits/2026-05-28-inc2d-session-napi-audit/`.

**Remaining sequence (NEXT) — reconciled to the canonical decision-lock §2** (the prior "functions-first"
ordering here had drifted; the lock puts the Node smoke migration inside 6.1B → then 6.1C → then 6.4-0):
**IDE-side Node smoke wiring + mocha (drive the `Session` class through `loader.ts`; rebuild the `.node`;
add the B#1/S2-01 cross-window mocha tests) — cross-repo (`feat/visualise-v1`), the explicit hand-off** →
**6.1C security/design audit** → **6.4-0 function-metadata substrate** → **6.4 Python UDFs**. **Also tracked
(cross-cutting):
a storage-level effective-non-blank-value extent API** adopted by all serializers (csv/xlsx/.qbook) so a
blank-inflated `Sheet::bounds` can't produce a giant export (Codex inc.2c-11 HIGH — currently
consistent-with-siblings + documented; Opus inc.2c-12 INFO re-noted the HashMap-ordered fresh-rels emission,
also pre-existing). (`batch` inc.2c-4; **transaction handle** inc.2c-5; **F2 `Op::ClearValue`** inc.2c-6;
**undo/redo** inc.2c-7; **F10 atomic table-rename** inc.2c-8; **`.qbook` open/save** inc.2c-9; **xlsx import**
inc.2c-10; **csv import/export** inc.2c-11; **xlsx export** inc.2c-12 — all Codex/Opus-audited, synthesis
docs under `docs/audits/2026-05-27-*`.)

> **✅ `batch` SHIPPED inc.2c-4 (2026-05-27) — OPTION (a) chosen.** Both tensions resolved; the
> multi-call transaction handle stays deferred (see below).
>
> **Tension 1 — op coverage (RESOLVED — all four covered).** `WorkbookTransaction`
> (`transaction.rs:158/196`) buffers only `put_value`/`put_formula`, but `batch` covers all four
> `SessionOp` variants (SetValue/SetFormula/Clear/SetFormat) by building the `BatchCommit` inner ops
> directly (it does not route through `WorkbookTransaction`).
>
> **Tension 2 (load-bearing) — graph consistency (RESOLVED).** `WorkbookTransaction` maintains no
> `CalcgraphSession`. `batch` instead applies the ops through a **graph-maintaining runtime with the
> op-log DETACHED**: the verified source fact (`cells.rs:157/306/341/371/793/871`, `formats.rs:88/127`)
> is that every producer gates its op-log append on `self.oplog.as_deref_mut()` while every calcgraph
> hook (`on_set_value`/`on_set_formula`/`on_clear_formula`) fires on `self.graph.is_some()` —
> **independently**. So a runtime with `oplog = None, graph = Some(..)` updates the workbook AND keeps
> the graph live but appends NO ops. A later `recalc_dirty` therefore recomputes the batched cells'
> dependents correctly (proven by `batch_keeps_calcgraph_live_for_later_recalc`).
>
> **Why (a), not (b)/(c).** (b) [a native `WorkbookRuntime::apply_batch`] is the cleaner long-term
> primitive but a larger engine addition; (a) ships now with one small additive constructor
> (`WorkbookRuntime::with_session_state_no_oplog`, `mod.rs`) + the session's own BatchCommit assembly,
> reusing the audited single-edit mutators verbatim for the actual mutation. (c) [`WorkbookTransaction` +
> `rebuild_from_workbook`] is O(all formulas)/batch and lacks clear/set_format. The "fragile duplicate
> op-construction" risk that (a) carries is bounded here: the inner ops are built from the **pre-batch
> workbook state** (mirroring `WorkbookTransaction::commit`'s `transaction.rs:311` `had_formula` reads),
> `SetFormula` reuses `set_formula`'s exact canonicalize path (`canonicalize_and_bind`), and `Clear`
> mirrors `clear_formula`'s preserved-value emission. **6.4 bulk writes should still consider promoting
> this to the native (b) primitive.**
>
> **Mechanics shipped:** (1) validate-all up front (sheet liveness + grid bounds + formula lex/parse/bind
> + finiteness of every serialized value) — any failure leaves the workbook + token UNCHANGED; (2) build
> ONE `Op::BatchCommit` from pre-batch state; (3) append it BEFORE mutating (so an append/serialization
> failure leaves nothing mutated — finiteness is pre-checked so only a Loro-internal append failure
> remains, an `Internal` engine bug); (4) apply via the detached-op-log graph-maintaining runtime; (5)
> `record_changes` ONCE → `state_seq` advances exactly one tick → `snapshot_delta` from a pre-batch token
> reports every batched cell. `BatchResult.applied` = the requested op count (honest even when a batch
> reduces to zero inner ops, e.g. a Blank-clear on a non-formula cell — then no BatchCommit is appended).
> `options.undo_label` is accepted but not yet consumed (undo lands later). 11 session tests added.
>
> **⚠️ FOLLOW-UP FIX (2026-05-27) — same-cell value/formula conflict guard.** Because the inner ops are
> built from **pre-batch** state but Phase 3 applies them **sequentially**, two ops that both touch one
> cell's value/formula could make the logged ops diverge from the live result on replay. Canonical case:
> `batch([SetFormula A1, SetValue A1])` logs `[PutFormula A1, PutValue A1]` (SetValue saw NO formula
> pre-batch → emitted no ClearFormula), but replaying `Op::PutValue` does NOT clear the formula
> (`crates/ql-oplog/src/replay.rs:486-510`) → a replay yields A1 with BOTH a value and a formula,
> divergent from the live state (where the sequential `set_value` clears the formula it now sees). This
> was a regression vs `WorkbookTransaction`, which rejects same-cell mixed value/formula ops via
> `check_op_kind` → `ConflictingOps`. **Rule shipped:** Phase 1 rejects any batch in which the same
> `(sheet, row, col)` is targeted by more than ONE value/formula-affecting op — i.e. more than one of
> `SetValue` / `SetFormula` / `Clear` (also two same-kind ops on one cell, slightly stricter than the
> transaction's last-write-wins; same-cell-multi-write within one batch is pathological → reject loudly).
> `SetFormat` is **orthogonal** (touches only the format overlay, replay-independent of value/formula) and
> is deliberately NOT tracked → it MAY coexist with one value/formula op on the same cell. Rejection is
> `EngineError { class: Conflict, code: "conflicting_batch_ops", … }` naming the offending cell, fired
> via a `HashSet<CellAddr>` during the Phase-1 walk BEFORE any append/mutation (validation-atomic:
> workbook + token unchanged). +3 session tests (formula-then-value → Conflict; value-then-clear →
> Conflict; value+format → OK, both land).
>
> **✅ SHIPPED inc.2c-5 — the multi-call handle** (`begin_transaction`/`txn_add`/`commit_transaction`/
> `rollback_transaction`). Added the two `WorkbookSession` fields (`txns: HashMap<TransactionId,
> Vec<SessionOp>>`, `next_txn_id: u64`). The handle is a **pure `SessionOp` buffer holding no engine
> borrow**; `commit_transaction` drains it through the SAME `batch` machinery (inheriting
> validation-atomicity, graph consistency, one `Op::BatchCommit`, single state tick, and the same-cell
> conflict guard `conflicting_batch_ops`). No lock between begin and commit → the buffer is validated at
> **commit time**. `begin`/`txn_add`/`commit` require `Ready`; `rollback` is ungated (cleanup). A failed
> commit leaves the transaction OPEN (the buffer is restored — `batch` is validation-atomic so nothing
> applied). `close` drops all buffers. Unknown handle → fail-loud `NotFound`/`transaction_not_found`;
> id-space exhaustion → loud `Internal`/`transaction_id_exhausted` (never wraps). 10 session tests;
> parallel Codex+Opus audit clean (no HIGH; one MED + two LOW applied — see
> `docs/audits/2026-05-27-inc2c5-txn-audit/SYNTHESIS.md`).
> **Undo/redo (NEXT) hits the graph-reversion question** — undo retracts ops but the workbook +
> graph must be rebuilt to the pre-op state (likely `rebuild_from_workbook` after a Loro undo);
> `bump_epoch` is already wired for it.

### What 2b shipped (REAL)
- **2a — PlanCache session-ownership** (§3): `WorkbookRuntime::with_session_state(.., PlanCache)` +
  `into_plan_cache(self)` (ownership-transfer, not a `&mut` field — zero existing-call-site change).
- Struct + lifecycle (`new`/`from_workbook`/`close`, Ready/Busy/Closed gating) + `{epoch, state_seq}`
  version token (2b shipped it as `{epoch, op_count}`; the counter was renamed `state_seq` in inc.2c-3 —
  §1–§11 below still say `op_count`, see the §0 banner) (§2, §4).
- `map_runtime_err` + `map_oplog_err` (§6 / Appendix A) — **free fns, NOT `From` impls** (orphan rules
  forbid `impl From<RuntimeError> for EngineError`; the in-crate `RuntimeError` match is exhaustive →
  a new variant is a compile error, stronger than a runtime catch-all).
- Mutations: `set_value`/`set_formula`/`clear`/`set_format`/`register_format`, `add_sheet`/`rename_sheet`,
  `set_name`. Recalc: `recalc_dirty`/`recalc_all`/`mark_volatiles_dirty` (Busy + op-registry; synchronous
  to completion in v1; `CellDiagnostic` events on structural failures).
- Read: `snapshot` (live-overlay enumeration) / `cell` / `list_sheets`. Ops/events:
  `cancel`/`operation_status`/`poll_events`.

### NEXT sub-increments (surfaced-not-yet today as `Capability/not_implemented_in_v1_core`)
1. ✅ **`validate_formula`** (SHIPPED inc.2c-1, `993492b6f9b`) — read-only lex→parse→bind against
   `&self.workbook`; failure → one error `Diagnostic`, clean bind → empty vec. Eval skipped.
2. ✅ **`query_range`** (SHIPPED inc.2c-1) — **DECISION TAKEN: added `CellValue::Blank`** (mirrors
   `ql_types::Value::Blank`; uniform fixed-size columnar; backward-compatible additive variant) rather
   than `Vec<Option<CellValue>>`. Columnar dense read; empties → `CellValue::Blank`; inverted range →
   `BadArgument`; >1M-cell request → `BadArgument` (fail-loud OOM guard). `include_*` options reserved
   (v1 `RangeColumn` is values-only). Snapshot still omits blanks (`CellSnapshot.value: None`).
3. ✅ **`snapshot_delta`** (SHIPPED inc.2c-3, `20427b1c4c7`) — **design (a) chosen** (user-locked
   2026-05-27): a session change-log keyed by a monotonic `state_seq`, keeping `snapshot_delta(&self)`.
   `state_seq` REPLACES `oplog.len()` as the token counter (advances on every committed mutation AND
   every recompute-with-changes), because the op-walk was doubly insufficient — recompute writes via
   `put_computed_at` with no ops AND `set_value(Blank)` appends no op. `RecomputeResult` gained
   `changed_cells` (recompute_dirty's precise VEQ set; recompute_all's full set). §4.3 rules + fail-loud
   `invalid_version_token`. Epoch-bump for delta-inexpressible states (move/restore/table ops). The
   `&mut self` full-diff option (b) was rejected (trait change + O(n)/call + single-baseline).
4. ✅ **`delete_sheet`/`restore_sheet`/`move_sheet`** (SHIPPED inc.2c-2, `2b5e7a13f5b`) — fail-loud
   (unknown id → `NotFound`; out-of-range move index → `BadArgument`); validate against the live
   workbook, append `Op::{RemoveSheet,RestoreSheet,MoveSheet}` (append-before-mutate), then mutate.
   Known-but-tombstoned id = idempotent no-op. (Cross-sheet dependents not proactively dirtied — v1.)
5. ✅ **table ops** (SHIPPED inc.2c-2) — `create/rename/rename_column/resize/drop_table` as
   `WorkbookRuntime` delegations (emit ops + graph table-hooks). drop/rename unknown → `NotFound`.
   (Zero-dim create → `Conflict` via `TableCreateRejected` — surfaced, classified one tier over
   `BadArgument`; minor.)
6. ✅ **`batch`** (SHIPPED inc.2c-4) — option (a): validate-all → build ONE `Op::BatchCommit` from
   pre-batch state → append-before-mutate → apply via a graph-maintaining runtime with the op-log
   DETACHED (new `WorkbookRuntime::with_session_state_no_oplog`) → `record_changes` once. All four
   `SessionOp` variants covered; `state_seq` advances exactly one tick.
7. ✅ **transaction handle** (SHIPPED inc.2c-5) — the multi-call
   `begin_transaction`/`txn_add`/`commit_transaction`/`rollback_transaction`. New fields `txns`/
   `next_txn_id`; a pure `SessionOp` buffer (no engine borrow) committed through the same `batch`
   machinery (inherits validation-atomicity + conflict guard); validated at commit time; failed commit
   keeps the txn open; fail-loud unknown handle / id-exhaustion. Codex+Opus audit clean.
8. ✅ **F2 `Op::ClearValue`** (SHIPPED inc.2c-6, `d8d22a04248`) — replayable value-clear; every Blank-clear
   path (set_value/batch/transaction) is now durable on save/load + undo-replay. Prerequisite for undo.
9. ✅ **`undo`/`redo`/`can_undo`/`can_redo`** (SHIPPED inc.2c-7, `4f8e9858d77`) — Loro `UndoManager` field
   (`set_merge_interval(0)`, 1 command = 1 unit; `grouped()` for rename_table/column); `rematerialize` =
   replay post-undo op-log onto a clone of the construction-time `baseline` workbook → rebuild graph →
   recompute_all (op-log detached) → bump_epoch. Empty stack → consumed:false. Codex+Opus audit: closed a
   real populated-`from_workbook` data-loss HIGH (the baseline field); F10 left tracked.
10. ✅ **F10 atomic table-rename** (SHIPPED inc.2c-8, `dca5695549e`) — `rename_table`/`rename_column` emit
    ONE `Op::BatchCommit` ([Rename*, PutFormula × N]) append-before-mutate (mirror `rename_sheet`); closes
    the tracked F10 gap. Codex audit clean.
11. ✅ **persistence `.qbook` `open`/`save`** (SHIPPED inc.2c-9) — **Option 1** (locked): reconstruct from
    the envelope + fresh op-log/undo history; `map_persistence_err` fills Appendix A; sidecar op-payloads
    validated on open (Codex HIGH fixed). See the Remaining sequence block above.
12. ✅ **xlsx `import`** (SHIPPED inc.2c-10) — broke the `ql-exec ↔ ql-io-xlsx` cycle via **dependency
    inversion** (`ql-io-xlsx` now pure I/O; recompute injected through `XlsxRecomputer`/
    `EngineXlsxRecomputer`); `WorkbookSession::import("xlsx")` = Option-1 adoption + import-report
    diagnostics (incl. `feature_inventory`, Opus/Codex HIGH fixed); `map_xlsx_err` in Appendix A.
    Tracked follow-up: feature-gate the xlsx WRITER so `ql-exec` doesn't pull image codecs. See
    `docs/api/xlsx-import-integration-plan.md`.
13. ✅ **csv `import`/`export`** (SHIPPED inc.2c-11) — new pure-I/O leaf crate `ql-io-csv` (deps: `csv` +
    `ql-storage` + `ql-types`; NO `ql-exec` — CSV has no formulas → no recompute injection).
    `import("csv")` = Option-1 adoption + type inference (BOM-stripped, UTF-8, injection-safe, engine-limit
    guarded); `export("csv")` = single-live-sheet (multi → loud `BadArgument`), verbatim/value-only;
    `map_csv_err` in Appendix A. Parallel Codex+Opus audit: Codex HIGH (conservative-bounds export
    blowup) assessed consistent-with-siblings (xlsx/.qbook do the same) → documented + tracked
    cross-cutting; Opus BOM fix applied; faithful-export injection stance documented. Synthesis
    `docs/audits/2026-05-27-inc2c11-csv-audit/`.
14. **NEXT: `export("xlsx")` + xlsx-writer feature-gate (inc.2c-12)** → **functions** (6.4) +
    **reserved bulk** (6.4/6.5). Plus the tracked cross-cutting effective-extent serializer fix.

---

This is the concrete, grounded build plan for the *implementation* of the `EngineSession` contract.
Read this together with:
- `docs/api/session-api.md` (the contract — what to build; v2, Codex-validated) — **authoritative**.
- `docs/api/codex-6-1a-review.md` (the 13 findings the contract resolves — the *why* behind the hard parts).
- `crates/ql-session/src/*` (the trait + DTOs that already exist and compile — increment 1/1b).
- `.plans/_active.md` (sequence + cycle accounting).

**Increment 1/1b already shipped** (HEAD chain ends `38108a5c8ef`): the `ql-session` crate is the
complete *type-level* contract — `EngineSession` trait (incl. table ops), all DTOs, `EngineError`,
operation/lifecycle types, `FunctionMetadata`. It compiles + 5 tests + clippy clean. **Increment 2 is
the implementation: a concrete `WorkbookSession` that `impl EngineSession`.**

---

## 1. Placement (decided, grounded)

**Implement `WorkbookSession` in `ql-exec`** (new module `crates/ql-exec/src/session.rs`), NOT a new crate.

Rationale (verified at the dep graph):
- `ql-exec` already owns `WorkbookRuntime` (`workbook_runtime/mod.rs`), `CalcgraphSession`
  (`calcgraph_session.rs`), and `PlanCache`, and already depends on `ql-storage` (`Workbook`),
  `ql-oplog` (`OpLog`), `ql-functions` (`FunctionRegistry`), `ql-calcgraph`, `ql-types`.
- `ql-session` depends on **`ql-types` only** → `ql-exec → ql-session` is **acyclic** (ql-session has no
  path back to ql-exec). So add `ql-session = { path = "../ql-session" }` to `ql-exec/Cargo.toml`.
- Bindings (`ql-bindings-node`, etc.) then depend on `ql-exec` + `ql-session` and adapt their FFI to the
  `WorkbookSession` concrete type behind the trait.

(A standalone `ql-workbook-session` crate is possible but adds a crate for no isolation benefit — `ql-exec`
is exactly the layer that already composes all the owned pieces.)

---

## 2. The owning struct

`WorkbookRuntime<'a>` (verified `workbook_runtime/mod.rs:133-170`) is a **per-edit borrow** holding
`&'a mut Workbook`, `&'a FunctionRegistry`, `Option<&'a mut OpLog>`, `Option<&'a mut CalcgraphSession>`,
plus a `plan_cache: PlanCache` **by value** (fresh per constructor). `WorkbookSession` inverts this: it
**owns** the long-lived state and constructs the per-edit `WorkbookRuntime` internally so no borrow
crosses FFI.

```rust
pub struct WorkbookSession {
    workbook: Workbook,                 // ql-storage — live, single-writer
    oplog: OpLog,                       // ql-oplog — MANDATORY (undo/save/version token)
    graph: CalcgraphSession,            // ql-exec — dep graph + dirty propagation
    plan_cache: PlanCache,              // ql-exec — SESSION-OWNED (see §3, LOW-1)
    registry: Arc<FunctionRegistry>,    // ql-functions — built-ins + UDFs (Arc: shareable, process-ish)
    state: LifecycleState,              // ql-session — New/Ready/Busy/Closed/Faulted
    epoch: u128,                        // version-token epoch (minted at new/open/import/cache-clear)
    ops: OperationRegistry,             // NEW — op-id → token/deadline/state (§6 / HIGH-1)
    events: EventRing,                  // NEW — append-only ring + monotonic cursor (§9)
    txns: HashMap<TransactionId, Vec<SessionOp>>, // NEW — buffered multi-call transactions (§3.4)
    next_op_id: u64,
    next_txn_id: u64,
}
```

Bindings wrap it: Node `#[napi]` over `Arc<Mutex<WorkbookSession>>` (mirrors today's `CollabSession`);
C an opaque pointer; etc. (contract §2.2 / §11).

---

## 3. The PlanCache refactor (LOW-1 — do this FIRST; it unblocks everything)

Today every `WorkbookRuntime` constructor allocates a fresh `PlanCache` (`mod.rs:140` field is by-value;
`:162`/`:225` call `PlanCache::new()`). If `WorkbookSession` builds a runtime per command, the cache resets
every call and `cache_stats` is meaningless.

**Refactor:** add a constructor that borrows a session-owned cache, e.g.

```rust
// in workbook_runtime/mod.rs
pub fn with_session_state<'a>(
    workbook: &'a mut Workbook,
    registry: &'a FunctionRegistry,
    oplog: &'a mut OpLog,
    graph: &'a mut CalcgraphSession,
    plan_cache: &'a mut PlanCache,   // borrowed, not owned
) -> Self { ... }
```

Change the `plan_cache` field to `&'a mut PlanCache` for this path (or generalize the struct). Keep the
existing owning constructors for back-compat with current call sites; migrate the IDE/collab path later.
`WorkbookSession` then holds `plan_cache: PlanCache` and passes `&mut self.plan_cache` per edit. Verify
the existing ~4135 ql-exec tests stay green after the refactor.

---

## 4. Version token (HIGH-2 — `{epoch, op_count}`, chosen over the Loro VV)

**Grounded correction (revised 6.1B inc.2 — the earlier "no VV" claim was WRONG):** `ql-oplog::OpLog`
is **Loro-backed and DOES expose a version vector** (`oplog_vv()` at `crates/ql-oplog/src/log.rs:424`),
plus `new_undo_manager` / `export_delta_bytes` / `fork_at_vv`. We still use `{epoch, op_count}`
**deliberately**: (1) `op_count = OpLog::len()` is the simplest monotonic single-writer counter and
index-walking ops gives a semantic (changed-cell) delta directly, vs decoding a Loro VV delta blob;
(2) `OpLog::len()` is **NOT monotonic** under undo-retraction (it reads the live Loro list), so the
`epoch` — bumped on undo/reload/cache-clear — is what keeps tokens sound. The Loro VV is reserved for
the v1.5 collab delta-sync path. (`SessionVersion` doc in `dto.rs` + `session-api.md` §4.0 now reflect
this corrected rationale.) So:

- **SHIPPED inc.2b:** `current_version()` encodes `{ epoch: u128, op_count: u64 }` as 24 bytes
  (16-byte BE epoch + 8-byte BE op_count). `epoch` minted via a process `AtomicU64` at construction;
  `op_count = self.oplog.len()`. `snapshot()` stamps it.
- **NEXT (step 6, deferred):** `snapshot_delta(last)` decodes `last`:
  - decode failure / unknown schema → **`EngineError::invalid_version_token`** (fail-loud; MED-2).
  - `last.epoch != self.epoch` → `full_rebuild_required` reason `EpochMismatch`.
  - `last.op_count > self.op_count` → also `invalid_version_token` (a token from the future is malformed).
  - else → emit the ops in `(last.op_count .. current.op_count)` as the delta (changed/removed cells,
    sheet/format changes), then stamp the new token.
- The contract (`session-api.md` §4.0) + the `SessionVersion` doc comment in `dto.rs` already reflect this.

---

## 5. Method-by-method implementation map

Build a per-edit runtime with `WorkbookRuntime::with_session_state(&mut self.workbook, &self.registry,
&mut self.oplog, &mut self.graph, &mut self.plan_cache)` then call the existing mutator. Group order:

| Trait method | Implement via | Notes |
|--------------|---------------|-------|
| `set_value` | `WorkbookRuntime::set_value` | map `CellValue` → `ql_types::Value`; `Pending` is invalid as *input* → `BadArgument` |
| `set_formula` | `set_formula` | parse/bind err → `Compute` `EngineError` (or `Diagnostic`); §5.5 |
| `clear` | `clear_formula` | |
| `validate_formula` | `validate_formula` (no mutation) | returns `Vec<Diagnostic>` |
| `set_format`/`register_format` | format-table ops | |
| `add_sheet`/`rename_sheet` | `WorkbookRuntime` sheet ops (`sheets.rs`) | duplicate→`Conflict`, unknown→`NotFound` |
| `delete_sheet`/`restore_sheet`/`move_sheet` | **NEW fail-loud wrappers** (MED-3) | `ql-storage::Workbook::{remove,restore,move}_sheet` silently no-op/clamp (`workbook.rs:749/781/809`) — wrap: check existence/range FIRST, return `NotFound`/`BadArgument`, then call |
| `set_name` | names (`names.rs`) | |
| `create_table`/`rename_table`/`rename_column`/`resize_table`/`drop_table` | `workbook_runtime/tables.rs` | name-keyed; `TableSpec` → `create_table(name, sheet, top_row, top_col, rows, cols, has_header, has_totals, column_names)` |
| `batch` | buffer ops → one `Op::BatchCommit` via `WorkbookTransaction` (`transaction.rs`) | atomicity per §3.4 (validation+local-commit atomic; replay NOT rollback-atomic — honest) |
| `begin/txn_add/commit/rollback_transaction` | `txns` map of buffered `SessionOp` → commit builds a `batch` | opaque handle, no borrowed runtime |
| `recalc_dirty`/`recalc_all` | `recompute_dirty`/`recompute_all` | return `op_id`; **pre-start cancel only** (§6 / HIGH-1); set `Busy` around the call |
| `mark_volatiles_dirty` | volatile pass | |
| `query_range` | iterate owned `Workbook` cells in range → columnar `RangeResult` | batch-shaped |
| `snapshot` | iterate owned `Workbook` (sheets/cells/formats) → `WorkbookSnapshot` + `{epoch,op_count}` token | **no replay** — single-writer owns a live workbook (unlike the collab `rebuild_workbook` path). Mirror the napi `workbook_snapshot` builder (`lib.rs:2141+`) but read the live workbook. |
| `snapshot_delta` | §4 token logic + walk new ops | |
| `cell` | `Workbook` cell lookup | |
| `list_sheets` | `Workbook` sheets (skip tombstoned) | |
| `undo`/`redo`/`can_undo`/`can_redo` | op-log/undo machinery | empty stack → `consumed:false`; bump `epoch` (clears delta cache) |
| `register_function`/`unregister_function`/`list_functions` | `FunctionRegistry` + §10 metadata | collision→`Conflict` (not panic); functions_used invalidation is 6.4-0 |
| `cancel`/`operation_status` | `ops` registry | |
| `poll_events` | `events` ring read-from-cursor (no drain) | |
| `write_range`/`publish_dataset`/`bind_range`/`refresh_source`/`materialize_query` | **reserved** | return `EngineError{class:Capability, code:"not_implemented_in_v1_core"}` until 6.4/6.5 — an explicit, surfaced "not yet", NOT a silent fallback |

---

## 6. The hard parts (concrete approaches)

- **Cancellation / `Busy` (HIGH-1):** `recompute_*` are synchronous `&mut self` commit-as-you-go loops
  (`recompute.rs:61/153/252/445`); `CalcgraphSession` is not `Clone`. So v1 = **pre-start cancel only**:
  `recalc_*` registers an op, sets `state = Busy`, checks the cancel token *before* invoking the synchronous
  pass; if canceled pre-start → `OperationState::Canceled`, no recompute; else run to completion, commit,
  `state = Ready`, emit `OperationCompleted`. Do **not** promise mid-flight abort. Hard mid-flight cancel
  (staged recalc) + out-of-process UDF worker-kill are later (§6.3 of the contract). While `Busy`, mutating/
  recalc commands return `session_busy`; read-only snapshot of the last committed state stays legal.
- **Fail-loud sheet ops (MED-3):** wrap the storage no-op/clamp methods — validate first, return
  `NotFound`/`BadArgument`, then mutate.
- **`EngineError` Appendix A (MED-1):** implement `From<RuntimeError>`, `From<ReplayError>`,
  `From<OpLogError>`, `From<PersistenceError>` → `EngineError`, filling the mapping table in
  `session-api.md` Appendix A exhaustively (resolve the flagged ambiguities there). **No `qbook_unknown`
  catch-all may reach a caller** — an unmapped variant is an `Internal` bug.
- **Panic boundary (LOW-2):** the `catch_unwind` + `Faulted` marking lives in the **binding shim** layer
  (it needs `panic = "unwind"`); `WorkbookSession` itself just must never panic on bad input (validate →
  `BadArgument`). Mutating-command panic ⇒ mark `Faulted`.
- **No-Fallbacks:** every "not yet" path returns a *surfaced* `EngineError` (e.g. `Capability`/
  `not_implemented_in_v1_core`), never a silent default. Malformed token = `invalid_version_token` (never
  silent full-rebuild).

---

## 7. Sub-task ordering (smallest sound path first)

1. **PlanCache refactor** (§3) — unblocks owning the cache; re-run ql-exec tests green.
2. **Struct + lifecycle** — `WorkbookSession::new`, `lifecycle_state`, `close`, `Faulted`; epoch minting.
3. **`EngineError` `From` impls** (Appendix A) — needed by every method.
4. **Read path** — `snapshot`, `cell`, `list_sheets`, `query_range`, version token (§4). Test against a
   hand-built workbook.
5. **Single-edit mutations** — `set_value`/`set_formula`/`clear`/formats; then `recalc_dirty`/`recalc_all`
   with the `Busy`/pre-start-cancel model.
6. **`snapshot_delta`** — the op-walk + the §4.3 full-rebuild/`invalid_version_token` rules.
7. **Structure ops** (fail-loud sheets + names + table ops) + **batch/transaction** + **undo/redo**.
8. **Events + operations** — ring + `poll_events`, `cancel`, `operation_status`.
9. **Function registration surface** (metadata store; execution is 6.4).
10. **Node smoke-path migration** (§8).
11. Reserved bulk methods return the explicit `Capability` "not yet" error.

Respect the ≤2 plan-implement-audit cycles per session rule — this is multiple sessions. A natural
sub-increment boundary is after step 4 (read path proven) and after step 6 (delta proven).

---

## 8. Node smoke-path migration (proves API6-01 early)

Add a thin `#[napi]` `WorkbookSession` wrapper in `ql-bindings-node` (alongside, not replacing,
`CollabSession`). Wire the IDE's edit→recalc→snapshot smoke path through it for one flow:
`new → set_value → set_formula → recalc_dirty → snapshot → snapshot_delta`. This catches missing
commands / DTO-shape mismatches before breadth (the §11 golden-flow matrix). Map `EngineError` →
JS `Error` with `.code`/`.class`/`.details` (replacing the `[kind]`-string parse). **Do NOT delete the
collab `CollabSession` surface** — it stays feature-gated as the v1.5 layer.

---

## 9. Tests

- **ql-exec integration tests** (the real bar; ql-bindings-node lib-test can't link — napi symbols): drive
  `WorkbookSession` directly in Rust. Cover: the read path round-trips; `set_value`+`recalc`+`snapshot`
  reflects computed values; `snapshot_delta` emits only changed cells + the `epoch_mismatch`/
  `invalid_version_token` branches; fail-loud sheet ops; `batch` atomicity; undo/redo; `Busy` rejects
  concurrent mutation; pre-start cancel yields `Canceled` with no recompute.
- **Mocha** (IDE): the Node smoke flow (step 8) — and **fold in the still-pending B#1 + S2-01 cross-window
  tombstone mocha tests here** (the `.node` gets rebuilt for this work anyway — closes the standing
  "fixes-not-live" debt).
- Keep the `ql-session` crate self-tests; add `impl EngineSession for WorkbookSession` exercises.

---

## 10. Deferred to inc.3+ (do NOT pull forward)
- Collab `CollabSession` feature-gating + the Loro-VV→token adapter (v1.5).
- Staged in-engine recalc (mid-flight hard cancel) + rollback-atomic replay (compute-core refactors).
- `write_range`/`publish_dataset`/`bind_range`/`refresh_source`/`materialize_query` execution (6.4/6.5).
- Service transport (6.2), full WASM/C/Python bindings (6.3), `functions_used` graph index (6.4-0).

---

## 11. Pre-flight checklist for the next session
- [ ] Read `session-api.md` v2 (contract) + `codex-6-1a-review.md` (findings) + this plan.
- [ ] `cargo build -p ql-session` is green (the contract crate; HEAD chain `38108a5c8ef`).
- [ ] Mac-host gotchas: `rg` absent (use `grep`); `cargo` at `$HOME/.cargo/bin/cargo`; build via `mac zsh -lc`.
- [ ] After EACH commit, **verify committed blobs are not truncated** (`git diff HEAD --stat` empty;
      `git show HEAD:<path> | tail`) — the git-index padding race recurred this session (truncated the
      inc.1 commit; fixed at `af15dcf3a5d`). Re-stage to fix; never `--no-verify`.
- [ ] Start with the PlanCache refactor (§3) and re-run the ql-exec suite before building the session.
