# 6.1B Increment 2 — `WorkbookSession` Implementation Plan

**Status:** ⏳ IN PROGRESS — **2b/2c-1/2c-2 + audit-fix SHIPPED 2026-05-26; the 2026-05-27 inc.2 audit
(F3–F10) + inc.2c-3 `snapshot_delta` SHIPPED 2026-05-27.** Chain: `83b1b33bac2` PlanCache →
`7335a5a1bfa` core → `993492b6f9b` validate_formula/query_range/`CellValue::Blank` → `2b5e7a13f5b`
delete/restore/move sheet + tables → `9f7a1645dbd` tombstone-read fix → **`879f3601747` inc.2 audit-fix
(F3 panic-guard / F4 read-path bounds / F5 tombstone op-log fidelity / F6 require_live_sheet on
rename+create_table / F7 query_range options fail-loud / F8 Appendix-A / F9–F10 docs)** → **`20427b1c4c7`
inc.2c-3 snapshot_delta**. `WorkbookSession` is in `crates/ql-exec/src/session.rs`; **ql-exec lib 667/0,
clippy clean, workspace `cargo check` green.**

### Method status — what the next window inherits (REAL vs surfaced-not-yet)
**REAL (implemented + tested):** `lifecycle_state`, `close`; `set_value`, `set_formula`, `clear`,
`set_format`, `register_format`, `validate_formula`; `add_sheet`, `rename_sheet`, `delete_sheet`,
`restore_sheet`, `move_sheet`, `set_name`; `create_table`/`rename_table`/`rename_column`/`resize_table`/
`drop_table`; `recalc_dirty`, `recalc_all`, `mark_volatiles_dirty`; `query_range`, `snapshot`,
**`snapshot_delta`**, `cell`, `list_sheets`; `cancel`, `operation_status`, `poll_events`. (Construction:
`new`/`from_workbook`.)
**DEFERRED — return `EngineError{class:Capability, code:"not_implemented_in_v1_core"}` (honest, never a
fallback):** `open`/`import`/`save`/`export` (persistence);
`batch`/`begin_transaction`/`txn_add`/`commit_transaction`/`rollback_transaction`; `undo`/`redo`
(`can_undo`/`can_redo` return `false`); `register_function`/`unregister_function`/`list_functions` (6.4);
`write_range`/`publish_dataset`/`bind_range`/`refresh_source`/`materialize_query` (6.4/6.5).

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
- `set_value(Blank)` on a value-only cell: token advances + appears in delta (F2 token half fixed), but
  the clear is **not replayable** on save/load (pre-existing Phase-2A.3.b wire-format limitation) →
  tracked to the persistence increment (emit a value-clear op / wire-encode Blank).
- **F10 (tracked, pre-existing): table rename/rename_column are NOT append-before-mutate atomic** (Codex
  HIGH; near-zero reachability — no float serde path; only Loro-internal failure). Fix = collect ops →
  one `Op::BatchCommit` before any `put_formula`, mirroring `rename_sheet`. The misleading comment is
  corrected; the fix is deferred. See `docs/audits/2026-05-27-inc2-session-audit/SYNTHESIS.md`.

**Remaining sequence (NEXT):** batch/txn → undo/redo → persistence → functions → reserved bulk → Node
smoke migration (+ pending `.node` rebuild + B#1/S2-01 mocha tests) → 6.1C audit.

> **⚠️ NEXT-SESSION DESIGN NOTE — `batch` is a DESIGN increment, not a wiring task (grounded
> 2026-05-27; TWO tensions, decide both first):**
>
> **Tension 1 — op coverage.** `WorkbookTransaction` (`transaction.rs:158/196`) buffers only
> `put_value`/`put_formula` — **no clear/set_format** — while `SessionOp` (`ql-session/src/session.rs:40`)
> has all four (SetValue/SetFormula/Clear/SetFormat).
>
> **Tension 2 (the load-bearing one) — `WorkbookTransaction` does NOT maintain the calcgraph.** It is
> the pre-Phase-3 batch primitive (module doc `:22-25`): `commit` writes values/formulas + evaluates in
> op-order directly on the `Workbook`, with **no `CalcgraphSession` field**. But `WorkbookSession` owns a
> LIVE graph that its single-cell mutators keep current (runtime `on_set_value` hooks). Routing `batch`
> through `WorkbookTransaction` would leave the session graph **stale** → a later `recalc_dirty` misses
> the batched cells' deps + fails to dirty their dependents = silent correctness break. So a faithful
> `batch` must keep one `Op::BatchCommit` (§3.4 = one undo unit) AND keep the graph consistent.
>
> **Resolution options (pick deliberately):** **(a)** apply each op through the session's
> graph-maintaining runtime mutators with the op-log **detached** (runtime takes `Option<&mut OpLog>` —
> pass `None`, so graph + workbook update but NO per-op append), then append one manually-built
> `Op::BatchCommit` — covers all 4 op types, graph stays live, but duplicates op-construction (fragile,
> must mirror the per-mutator PutValue/ClearFormula/PutFormula/SetCellFormat logic); **(b)** a NEW native
> runtime `apply_batch(ops)` (graph-maintaining + emits one BatchCommit) — cleanest, an engine addition
> in `workbook_runtime`; **(c)** `WorkbookTransaction` + a full `CalcgraphSession::rebuild_from_workbook`
> after commit — correct but O(all formulas)/batch and still no clear/set_format. **Do NOT** loop the
> per-edit session mutators (emits N ops, not one undo unit, violating §3.4). Recommendation: **(b)** if
> the engine-addition budget is acceptable (it's the right long-term primitive and 6.4 bulk writes will
> want it too); otherwise **(a)** for a v1 that ships now. Verify the runtime maintains the graph with
> `oplog = None` before committing to (a).
>
> **Plus:** the multi-call handle (`begin_transaction`/`txn_add`/`commit_transaction`/
> `rollback_transaction`) needs two NEW `WorkbookSession` fields (`txns: HashMap<TransactionId,
> Vec<SessionOp>>`, `next_txn_id: u64`) not in the struct yet (impl-plan §2 sketched them; inc.2b shipped
> without). `BatchResult` = `{applied: u32, version}`; `BatchOptions` = `{undo_label?}`;
> `TransactionId(u64)`. **Undo/redo (next after batch) hits the same graph-reversion question** — undo
> retracts ops but the workbook + graph must be rebuilt to the pre-op state (likely
> `rebuild_from_workbook` after a Loro undo); `bump_epoch` is already wired for it.

### What 2b shipped (REAL)
- **2a — PlanCache session-ownership** (§3): `WorkbookRuntime::with_session_state(.., PlanCache)` +
  `into_plan_cache(self)` (ownership-transfer, not a `&mut` field — zero existing-call-site change).
- Struct + lifecycle (`new`/`from_workbook`/`close`, Ready/Busy/Closed gating) + `{epoch,op_count}`
  version token (§2, §4).
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
6. **`batch`/transactions** + **`undo`/`redo`** (needs `OpLog::new_undo_manager`) + **persistence**
   (`open`/`import`/`save`/`export` via `ql_io` — adds `PersistenceError` mapping to Appendix A).
7. **functions** (6.4) + **reserved bulk** (6.4/6.5).

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
