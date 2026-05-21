# IDE consumer contract

**Status:** Engine Phase 2B.6 — first vertical-slice surface  
**Date:** 2026-05-12  
**Stability:** **DRAFT** — names + shapes will change as Engine Phase 6.1 (Stable Engine Session API) formalizes them. This document is the SPEC that 6.1 will harden.

This document describes how the Quantlab IDE (`extensions/quantlab/`, a separate worktree) consumes the Quantbook engine. It is informed by the IDE-2B-01..05 acceptance criteria in `docs/MASTER-PLAN.md` Phase 2B.6 and exercised in `crates/ql-exec/tests/ide_simulation.rs`.

## 1. Lifecycle (one workbook session)

```text
                                         ┌────────────────────────────┐
   IDE opens .qbook                      │ engine state:              │
   ────────────►  load_workbook_with_oplog─►  Workbook + OpLog        │
                                         └────────────┬───────────────┘
                                                      │
                                                      ▼
   user types in formula bar / pastes   ┌────────────────────────────┐
   ──────────────────────────────────►  │ per-edit:                  │
                                         │   WorkbookRuntime::with_oplog
                                         │   .set_value / .set_formula│
                                         │   .transaction().commit()  │
                                         └────────────┬───────────────┘
                                                      │ (mutates wb, appends ops)
                                                      ▼
   user saves                            ┌────────────────────────────┐
   ──────────────────────────────────►  │ save_workbook_with_oplog   │
                                         └────────────┬───────────────┘
                                                      │
   user reopens                                       ▼
   ──────────────────────────────────►  load_workbook_with_oplog → restored
```

The IDE holds three pieces of state per open workbook:

| State | Type | Lifetime |
|---|---|---|
| `wb` | `ql_storage::Workbook` | Open until save / close |
| `oplog` | `ql_oplog::OpLog` | Open until save / close. Carries mutation history. |
| `registry` | `ql_functions::FunctionRegistry` | Process-wide singleton (`default_registry()`) |

`WorkbookRuntime` is **per-edit**, not per-session. It borrows `&mut wb` + `&reg` + `&mut oplog` for the duration of one user action (one set_formula call, one paste transaction, one recompute). Borrowing `&mut wb` for the runtime's lifetime prevents the IDE from reading the workbook through other paths while an edit is in flight — that's intentional. The IDE typically constructs a runtime, performs ONE operation, drops the runtime, then re-reads cells for grid rendering.

Engine Phase 6.1 will formalize this as a `WorkbookSession` struct that owns wb + oplog + registry, exposing edit methods directly without the borrow dance. 2B.6 doesn't ship that — the test scaffolding in `ide_simulation.rs` documents the pattern.

## 2. Operations the IDE invokes

### 2.1 Open / load

```rust
let (wb, oplog) = ql_io::load_workbook_with_oplog(path)?;
```

- Loads the `.qbook/` directory.
- `oplog.bin` MUST be present (Phase 2A.3.c contract; load fails with `MissingFile` otherwise).
- The IDE then renders the grid by walking cells via `wb.sheet(id)?.read(row, col)` for each visible cell, and `wb.formula_at(sheet, row, col)` for the formula bar.

**Tier D2 (2026-05-19, `e15e8908742`):** the persistence API moved from `ql_oplog::{load,save}_workbook_with_oplog` to `ql_io::{load,save}_workbook_with_oplog`. The old import paths fail to compile.

If the workbook has no op log (legacy save or external tool), use the bare `ql_io::load_workbook(path)` and construct a fresh empty `OpLog::new()` — but note that subsequent saves via `ql_io::save_workbook_with_oplog` will write the new (empty-then-growing) log over the absent one.

### 2.2 Edit a single cell

User types `=A1 * 2` and hits Enter:

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
let value = rt.set_formula(sheet, row, col, "A1 * 2")?;
// value is Value::Number(20.0) given A1=10
// rt drops; wb + oplog observable again
```

The IDE renders `value` in the cell. If `set_formula` returns `Err(RuntimeError::...)`:
- The Display string is user-facing — render it in a diagnostic panel / hover tooltip.
- The workbook is unchanged (no partial write, per the no-fallbacks rule).
- The op log is unchanged (append-before-mutate ordering).

Common error variants the IDE renders:
- `RuntimeError::Lex(...)` — syntax / tokenization error (e.g., unexpected `@`).
- `RuntimeError::Parse(...)` — parse error (e.g., unclosed paren).
- `RuntimeError::Bind(BindError::UnresolvedName(...))` — `#NAME?` analogue.
- `RuntimeError::Bind(BindError::NamedRangeInScalarContext(...))` — use SUM/AVERAGE/COUNT etc.
- `RuntimeError::Bind(BindError::NamedFormulaUnsupported(...))` — named formulas are Engine Phase 4.
- `RuntimeError::InvalidSheet { ... }` / `InvalidCell { ... }` — coordinate out of range.

### 2.3 Edit a single cell to a literal

User types `42` (no leading `=`):

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
rt.set_value(sheet, row, col, Value::Number(42.0))?;
```

Sets a literal; clears any prior formula. Emits `Op::PutValue` (+ `Op::ClearFormula` if cell had a formula).

### 2.4 Cancel an edit

User starts typing, presses Esc. **The IDE simply does not call `set_formula` / `set_value`.** No engine state changes. No op log entry. The runtime is never constructed.

This is the canonical "no-op cancel" path. The engine offers no explicit cancel API because none is needed — borrow-checked mutation requires explicit `&mut` access, and the IDE never grants it for cancelled edits.

### 2.5 Paste a block

User pastes 10 cells (literals + formulas):

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
{
    let mut tx = rt.transaction();
    for (row, col, value) in pasted_literals {
        tx.put_value(sheet, row, col, value)?;
    }
    for (row, col, formula) in pasted_formulas {
        tx.put_formula(sheet, row, col, formula)?;
    }
    tx.commit()?;
}
```

The transaction:
- Buffers all writes; eager bind validation surfaces formula errors BEFORE the commit (so the paste atomically succeeds or rejects).
- Drop without commit = no-op (canonical "ESC cancels paste" path).
- Emits exactly one `Op::BatchCommit { ops: [...] }` per commit.

### 2.6 Set / remove a defined name

User adds a named range in the Name Manager:

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))?;
```

Emits `Op::SetName`. Returns `RuntimeError::Name(NameTableError::Reserved(...))` for reserved names (currently just `AI` per CORR-06).

### 2.7 Add a sheet

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
let new_sheet_id = rt.add_sheet("Sheet2", 16_384)?;
```

`16_384` is the engine default chunk size; pass the same unless deliberately tuning.

### 2.8 Clear a formula (keep value)

User edits the formula bar to remove the leading `=` (Excel-canon: strips formula, leaves last-evaluated value as a literal):

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
rt.clear_formula(sheet, row, col)?;
```

Emits `Op::PutValue(current) + Op::ClearFormula` (preserves the "strip formula, keep value" semantic across replay). No-op if cell had no formula.

### 2.9 Recompute on demand

After an out-of-band mutation (e.g., a UDF refresh, a future connector update) the IDE forces a full recompute:

```rust
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
let result = rt.recompute_all();
if !result.is_complete() {
    for failure in &result.failures {
        // display per-cell diagnostic
    }
}
```

Hit/miss counters in the bind-plan cache visible via `rt.cache_stats()` — IDE can surface these in a status bar / debug pane (Engine Phase 6.2 wires them into the ql-profile JSON for the IDE to render).

### 2.10 Save

```rust
ql_io::save_workbook_with_oplog(&wb, &oplog, "name", path)?;
```

Atomic save (`.qbook/` + `oplog.bin` ride the same temp-then-rename protocol). The op log persists in full — any future session reloading this `.qbook` sees the same history.

## 3. What the IDE does NOT do

- **The IDE does NOT call `Workbook::set_name`, `Workbook::add_sheet`, `Workbook::put_at`, or `Workbook::clear_formula` directly.** Those are LOW-LEVEL methods (doc-marked Phase 2B.5) used by the qbook loader, the op-log replay path, runtime-internal recompute pass 2, and tests. Direct calls bypass the op log silently — a correctness hole for product code.
- **The IDE does NOT manage the op log directly.** No `oplog.append(...)` calls. The runtime emits ops; the IDE just hands the runtime an `&mut OpLog` and the runtime handles the rest.
- **The IDE does NOT evaluate formulas itself.** All evaluation goes through the runtime. The IDE consumes results, never produces them.
- **The IDE does NOT cache parsed/bound plans.** That's the runtime's `PlanCache`. The IDE consumes hit/miss stats for observability but never inserts directly.

## 4. Engine surfaces NOT yet shipped (filed in `docs/known-gaps.md`)

The IDE will need these eventually; they're not blocking the Phase 2B.6 vertical slice:

- ~~**On-keystroke validation.**~~ ✅ SHIPPED in Phase 2B.7: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` exists. Closes GAP-I-04.
- ~~**Undo / redo.**~~ ✅ SHIPPED in Phase 5.4 V1/V2 V1/V2 V1.1 (2026-05-19). See `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)" — `CollabSession::{undo,redo,can_undo,can_redo,undo_count,redo_count,clear_undo_stack,start_undo_group,end_undo_group,start_undo_group_scoped,set_undo_merge_interval}`.
- **Incremental dependency-aware recompute.** `recompute_all` re-walks every formula. The IDE wants "this cell changed → recompute its dependents only." GAP-R-01 (Engine Phase 3 — calcgraph integration).
- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. ✅ **Phase 5.3 SHIPPED 2026-05-20** — causality-aware rename-repair pass via `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See § 4.1 below for the IDE-facing API.
- **Long-running cancellation.** No `Cancel-token` on long operations. Engine Phase 6.1 work.

### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)

Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:

- **`ql_collab::CollabSession`** — per-peer session holder. Wraps an `OpLog` + `loro::UndoManager` + optional `Box<dyn Transport>`.
- **`CollabSession::new(peer_id) -> Result<Self, _>`** + **`from_snapshot(peer_id, bytes)`** — construction.
- **Op log:** `append_op` / `merge_bytes` / `export_bytes`.
- **Undo:** `undo` / `redo` / `start_undo_group_scoped` (returns RAII `UndoGroupGuard` — recommended for paste/fill-down/table-import).
- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 step 4 (✅ SHIPPED 2026-05-21) adds `ql-collab-ws::WebSocketTransport` as the first production-grade impl (separate crate — see "Production transport (ql-collab-ws)" section below).
- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
- **Offline-write (✅ Phase 5.5 V2 V3 step 3 SHIPPED 2026-05-21)**: append while no transport attached → `append_op` returns `Ok(())` and commits locally; `maybe_auto_flush` silently no-ops. **Loro's CRDT op log IS the implicit offline queue — no separate buffer needed.** On reattach: `attach_transport` resets `last_flushed_vv = None`. The next mutator (or explicit `flush_delta_to_transport`) sends the delta from empty VV — delivers ALL accumulated ops including the offline ones. Recovery from a failed flush (transport closed mid-session) follows the same pattern: the failed-flush op is committed locally; detach + reattach (or just reattach — it replaces + resets) + explicit flush sends everything. NEW `CollabSession::has_pending_flush() -> bool` ergonomic helper: compares `current_vv` vs `last_flushed_vv.unwrap_or_default()`. Use for IDE status indicators ("Synced" vs "Unsynced changes") + reconnect handshake logic. **Idiom for explicit reattach-then-sync**: `session.attach_transport(t); if session.has_pending_flush() { session.flush_delta_to_transport()?; }` — `attach_transport` doesn't auto-flush by design (lifecycle event, not mutation; preserves V2 V1 `Option<previous>` return signature).
- **Production transport (✅ Phase 5.5 V2 V3 step 4 SHIPPED 2026-05-21 — `ql-collab-ws::WebSocketTransport`):** new sibling crate `ql-collab-ws` houses the first production-grade `Transport` impl. Bridges async tokio-tungstenite (`=0.29.0`) to the sync `Transport` trait via `tokio::sync::mpsc` channels + 2 spawned background tasks (writer drains outbound; reader pushes inbound). Caller pattern (sync): `let rt = tokio::runtime::Runtime::new()?; let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?; session.attach_transport(ws);`. `Drop` aborts both background tasks (RAII close). Transport is `Send` (compile-time assert); not `Sync` (single-consumer mpsc). **Why a separate crate**: `ql-collab` core stays runtime-agnostic — embedders that need only `LoopbackTransport` or a custom impl (in-process IPC, gRPC stream) don't pay for tokio. **MVP V1 limitations** (all deferred to V2 V4 in `docs/PHASE-4-V2-BACKLOG.md` Tier I and future):
    - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy in front, or wait for V2 V4 `rustls` feature.
    - **No auto-reconnect.** On `Err(TransportError::Closed)`, caller drives recovery: `session.detach_transport(); let new_ws = rt.block_on(WebSocketTransport::connect(url))?; session.attach_transport(new_ws);`. V2 V3 step 1's baseline reset (`last_flushed_vv = None` on attach) makes the next flush deliver all accumulated ops including offline ones — the offline-write contract above holds identically for WS.
    - **Unbounded outbound mpsc queue.** Memory grows if peer disconnects + caller keeps appending. Combine with V2 V3 step 3 `has_pending_flush()` for observability; V2 V4 will switch to bounded + backpressure policy.
    - **Client-only.** Server-side WebSocket impls use other libraries (`axum-tungstenite`, `warp::ws`, etc.).
    - **Drops text/ping/pong frames as inbound data.** Loro payloads are binary; non-binary frames don't carry our protocol. Close frames trigger reader task exit + closed-flag set.
- **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
- **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.

**D-1 (✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 megaudit):** `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format`. IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)`. `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate. xlsx export flattens multi-peer FormatIds via dedup-by-code; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. xlsx import surfaces unresolved-overlay-numfmt as `report.unsupported` entries. `.qbook/oplog.bin` files wrapped in Tier D3 header (`OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION`). `CollabSession::new` + `from_snapshot` + `OpLog::set_peer_id` assert `PeerId != 0` (release-firing). See `docs/phase5/d-1-exit-packet.md` for the full closure record.

## 5. Acceptance pattern (`crates/ql-exec/tests/ide_simulation.rs`)

The simulation test exercises this contract end-to-end without an actual IDE. Each `#[test]` corresponds to one of IDE-2B-01..05:

| Test | Acceptance | What it proves |
|---|---|---|
| `ide_01_formula_edit_returns_value` | IDE-2B-01 | `set_formula` returns the evaluated Value; IDE can render it |
| `ide_02_bind_errors_carry_user_facing_display` | IDE-2B-02 | Errors round-trip with non-empty Display strings; no fallback values |
| `ide_03_cancel_pattern_no_state_change` | IDE-2B-03 | The borrow-check-enforced "no call = no mutation" pattern works |
| `ide_04_paste_block_via_transaction` | IDE-2B-04 | Transaction commit emits exactly one BatchCommit; partial drop = no state |
| `ide_05_save_reload_preserves_state_and_oplog` | IDE-2B-05 | Round-trip preserves workbook + oplog length + visible cell values |

The test file is the spec for what the actual TypeScript binding (Engine Phase 6.3) will call.
