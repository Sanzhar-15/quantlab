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

### 4.1 Phase 5 collaboration surface (Phase 5.7 V1 + V2.1-V2.7 bound; V3 will extend)

**Status update (Phase 5.7 V1 + V2 SHIPPED 2026-05-22)**: a Node binding now consumes this surface via the engine repo's `crates/ql-bindings-node/` (napi-rs cdylib). Phase 5.7 V1 binds the minimum `CollabSession` round-trip: constructor / `fromSnapshot` / `appendPutValue` / `exportBytes` / `mergeBytes` / observability (`opCount` / `pendingOpCount` / `hasPendingFlush` / `peerId`). **Phase 5.7 V2 (V2.1 through V2.7 + V2.8 megaudit + code closures)** binds the full Transport surface: `attachTransport` / `detachTransport` / `hasTransport` (V2.1) / `flushToTransport` / `pollRemote` / `pollRemoteWithLimit` (V2.1+V2.2) / `flushDeltaToTransport` / `transportLastError` / `setAutoFlushPolicy` / `autoFlushPolicy` (V2.2) / `Transport.websocketConnect` (V2.3) / `flushPendingToTransport` (V2.4 + V2.5 V8-block closure) / structured `QuantbookErrorCode` discrimination via `parseQuantbookError` (V2.7) / cfg-gated `BlockingTransportFixture` for contention tests + credential-scrubbed `WebSocketError::InvalidUrl` + Error.cause walk (V2.8). Phase 5.7 V3 binds `rebuild_workbook` + full Op enum + undo/redo + presence + persistence + multi-window IDE demo. See `docs/phase5/5-7-v1-exit-packet.md` (V1) + `docs/phase5/5-7-v2-exit-packet.md` (V2 phase termination) for closure records.

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
- **Production transport (✅ Phase 5.5 V2 V3 step 4 SHIPPED 2026-05-21 — `ql-collab-ws::WebSocketTransport`):** new sibling crate `ql-collab-ws` houses the first production-grade `Transport` impl. Bridges async tokio-tungstenite (`=0.29.0`) to the sync `Transport` trait via `tokio::sync::mpsc` channels + 2 spawned background tasks (writer drains outbound; reader pushes inbound). Caller pattern (sync): `let rt = tokio::runtime::Runtime::new()?; let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?; session.attach_transport(ws);`. `Drop` aborts both background tasks (RAII close). Transport is `Send + Sync` (both compile-time asserted via `static_assertions` since V2 V4 V1 step 3). Single-consumer receive is enforced by `try_recv(&mut self)`'s exclusive borrow, NOT by `!Sync` — the V2 V3 step 4 docstring originally claimed `!Sync` based on intuition; corrected in V2 V4 V1 step 3. The `Sync` bound means consumers can wrap the concrete transport in `Arc<WebSocketTransport>` if needed (V1 substrate doesn't use that pattern, but V2 V4+ could). **Why a separate crate**: `ql-collab` core stays runtime-agnostic — embedders that need only `LoopbackTransport` or a custom impl (in-process IPC, gRPC stream) don't pay for tokio. **MVP V1 limitations** (all deferred to V2 V4 in `docs/PHASE-4-V2-BACKLOG.md` Tier I and future):
    - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy in front, or wait for V2 V4 `rustls` feature.
    - **No auto-reconnect.** On `Err(TransportError::Closed)`, caller drives recovery: `session.detach_transport(); let new_ws = rt.block_on(WebSocketTransport::connect(url))?; session.attach_transport(new_ws);`. V2 V3 step 1's baseline reset (`last_flushed_vv = None` on attach) makes the next flush deliver all accumulated ops including offline ones — the offline-write contract above holds identically for WS.
    - **Unbounded outbound mpsc queue.** Memory grows if peer disconnects + caller keeps appending. Combine with `session.pending_op_count()` (V2 V4 V1 step 2 SHIPPED — finer-grained than the V2 V3 step 3 `has_pending_flush()` boolean) for threshold/backlog observability; V2 V4+ will switch to a bounded outbound queue with backpressure policy.
    - **Client-only.** Server-side WebSocket impls use other libraries (`axum-tungstenite`, `warp::ws`, etc.).
    - **Drops text/ping/pong frames as inbound data.** Loro payloads are binary; non-binary frames don't carry our protocol. Close frames trigger reader task exit + closed-flag set.
- **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
- **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.

---

### Worked examples — three core IDE workflows (V2 V3 step 6 ship)

**V2 V3 step 6 megaudit closure (2026-05-21) — Opus-A M1**: the API inventory above mentions the new V2 V3 V1 APIs but doesn't show the call sequence for the three workflows an IDE engineer will actually build. The subsections below give canonical implementations with the gotchas called out inline. An IDE engineer should be able to wire each workflow from these subsections alone, without spelunking `session.rs` or `lib.rs`.

#### 4.1.1 Synced / Unsynced / Offline indicator

The IDE shows a status indicator: 🟢 Synced (all local ops on the wire), 🟡 Unsynced (local changes pending), ⚫ Offline (no transport).

```rust
use ql_collab::CollabSession;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncStatus { Synced, Unsynced, Offline }

fn indicator_status(session: &CollabSession) -> SyncStatus {
    if !session.has_transport() {
        SyncStatus::Offline
    } else if session.has_pending_flush() {
        SyncStatus::Unsynced
    } else {
        SyncStatus::Synced
    }
}
```

**Gotchas**:

1. **`from_snapshot` post-attach reports `Unsynced`.** A session built via `CollabSession::from_snapshot(peer_id, bytes)` has `current_vv ≠ default` (imported ops) and `last_flushed_vv = None`. After `attach_transport`, `has_pending_flush()` returns `true` even though the user did nothing. The `has_transport()` gating above handles this (`Offline` takes priority), but if you ever query `has_pending_flush()` directly for UI, suppress it on first display after `from_snapshot` until the first auto-flush completes.

2. **"Unsynced offline edits" vs "Unsynced retry-pending" are indistinguishable from the substrate.** After `append_op` returns `Err(Transport(Closed))`, the local op committed but `last_flushed_vv` didn't advance — so `has_pending_flush() = true`, same state as an offline append. To differentiate the UI copy ("Saving locally — reconnecting…" vs "Saving locally — offline"), the IDE must track its own `transport_error_pending: bool` flag and clear it on the next successful flush.

3. **Delivery semantics — queued-vs-acked closure (V2 V4 V1 step 1 SHIPPED 2026-05-21)**: `has_pending_flush() == false` alone means "queued to the currently-attached transport's internal buffer," NOT "submitted to the wire." For buffered async transports (`WebSocketTransport`), bytes sit in an mpsc channel between mpsc-enqueue and `ws_sink.send` completion. **The closure**: call `session.flush_pending_to_transport()` AFTER `flush_delta_to_transport()` (or any mutator under `OnAppend`). Block-sync; returns `Ok(())` once the writer task has completed `ws_sink.send` for every queued blob (level-1 ack: flushed to the WebSocket sink). For TCP-level or peer-application-level ack, build a custom ack-op on top — out of scope for V2 V4 V1. The blocking-sync nature means: from a tokio task body, wrap in `tokio::task::spawn_blocking` or use multi-thread runtime.

4. **Finer-grained "N pending changes" via `pending_op_count()` (V2 V4 V1 step 2 SHIPPED 2026-05-21)**: `has_pending_flush()` is just a boolean. For bounded-queue policies ("warn user when more than N changes pending" or "switch editor to read-only if backlog exceeds N"), use `session.pending_op_count() -> usize`. Returns the magnitude of the per-peer VV counter delta between `current_vv` and `last_flushed_vv` summed across all peers — strictly monotonic under all mutators including undo (the undo's inverse op is a new VV entry even though it retracts a visible LoroList entry). **Sibling invariant**: `pending_op_count() > 0` iff `has_pending_flush() == true` — the count's boolean reduction always matches the cheap boolean accessor. **Semantic note**: the count includes BOTH local appends AND merges from peers AND undo ops — it's "what the transport hasn't seen yet," not "your own net visible edits." For "my edits only," the IDE tracks its own peer-id-filtered counter.

5. **"Discard unsynced changes" gesture via `discard_pending_ops()` (V2 V4 V1 step 5 SHIPPED 2026-05-21)**: for UX flows where the user wants to ABANDON local edits (window-close-with-discard, "Revert to saved", server-enforced constraint violation), use `session.discard_pending_ops() -> Result<usize>`. Reverts the log to the last successfully-flushed checkpoint (`last_flushed_vv`); if no flush ever happened, reverts to a fresh empty log. Preserves `peer_id`, attached transport, auto-flush policy. Recreates the internal `UndoManager` (active undo groups become invalid — caller MUST end groups before calling). Returns the count of ops actually discarded. **Post-condition**: `pending_op_count() == 0` and `has_pending_flush() == false`. Use carefully — this is a destructive operation; pair with a "are you sure?" UX dialog.

   ```rust
   // Canonical "Discard local changes?" dialog handler.
   fn on_discard_clicked(session: &mut CollabSession) -> Result<DiscardSummary, Box<dyn std::error::Error>> {
       // Pre-conditions the caller controls:
       // 1. Any active undo group MUST be ended before this point
       //    (RAII `UndoGroupGuard` ends on drop; ensure it's out of scope).
       // 2. Detach the transport FIRST if you also want the discard to
       //    survive a peer's broadcast-back via `merge_bytes`. The
       //    transport-attached path leaves the discard susceptible to
       //    CRDT convergence — see local-only caveat.
       let count = session.discard_pending_ops()?;
       Ok(DiscardSummary {
           ops_discarded: count,
           // Post-condition guarantees:
           still_pending: session.has_pending_flush(),  // false
           local_op_count: session.op_count(),
       })
   }
   ```

   **Local-only caveat (V2 V4 V1 step 5 audit closure, Codex L1 / Opus M2)**: discard is a SESSION-LOCAL revert. If a discarded op was previously delivered to a peer (via the attached transport before the user clicked "Discard," or via a prior session that broadcast it), the peer still has the op. When the local session next does `merge_bytes` (directly or via `poll_remote`), the op will RE-APPEAR via CRDT convergence. Mitigations: (a) detach the transport before `discard_pending_ops` to prevent immediate `poll_remote` re-delivery; (b) for protocol-level peer rollback, layer a domain-specific revert op via `append_op` after discard. Discard's contract is "session-local revert," not "protocol revert."

#### 4.1.2 Reconnect handshake on `Err(Closed)`

When a session method returns `Err(CollabSessionError::Transport(TransportError::Closed))`, the IDE drives recovery. Use `CollabSession::transport_last_error()` (new in V2 V3 step 5) to choose the right user-facing message and retry strategy.

```rust
use ql_collab::{CollabSession, CollabSessionError, TransportError};
use ql_collab_ws::WebSocketTransport;

#[derive(Debug)]
enum ReconnectAction { RetryWithBackoff, RetryWithAuthPrompt, AbortAndShowError }

fn classify_disconnect(cause: Option<String>) -> ReconnectAction {
    let Some(msg) = cause else {
        // No specific cause (e.g., graceful caller close) — treat as
        // unexpected. Default to retry.
        return ReconnectAction::RetryWithBackoff;
    };
    if msg.contains("401") || msg.contains("auth") {
        ReconnectAction::RetryWithAuthPrompt
    } else if msg.contains("close frame: code=1008") {
        // RFC 6455 1008 = policy violation; server kicked us.
        ReconnectAction::AbortAndShowError
    } else if msg.contains("close frame: code=1011") {
        // RFC 6455 1011 = server error; retryable.
        ReconnectAction::RetryWithBackoff
    } else {
        // Generic runtime error (peer reset, IO, capacity): retry.
        ReconnectAction::RetryWithBackoff
    }
}

fn reconnect(
    session: &mut CollabSession,
    url: &str,
    rt: &tokio::runtime::Handle,
) -> Result<(), Box<dyn std::error::Error>> {
    let cause = session.transport_last_error();
    let action = classify_disconnect(cause);

    if matches!(action, ReconnectAction::AbortAndShowError) {
        return Err("server rejected with policy-violation; aborting".into());
    }
    if matches!(action, ReconnectAction::RetryWithAuthPrompt) {
        // Show auth UI; on confirm, fall through to reconnect.
        // ...IDE-specific auth flow...
    }

    // Drop the old transport (releases TCP socket + background tasks).
    let _ = session.detach_transport();
    let new_ws = rt.block_on(WebSocketTransport::connect(url))?;
    session.attach_transport(new_ws);

    // Post-attach: drive explicit flush to deliver offline ops
    // immediately (don't wait for next user action). See § 4.1.3.
    if session.has_pending_flush() {
        session.flush_delta_to_transport()?;
    }
    Ok(())
}
```

**`WebSocketError` variant → recommended IDE action**:

| `transport_last_error()` substring | Likely cause | Recommended IDE action |
|---|---|---|
| `"WebSocket runtime error: peer close frame: code=1000"` | Graceful peer close (normal) | Reconnect, transient |
| `"...code=1008..."` | Policy violation (auth, throttle) | Show error; abort retry |
| `"...code=1011..."` | Server internal error | Reconnect with backoff |
| `"...code=4XXX..."` | Application-defined (server-specific) | Inspect reason string |
| `"WebSocket runtime error: peer stream ended without close frame"` | TCP teardown without graceful close | Reconnect with backoff |
| `"WebSocket runtime error: <tungstenite IO error>"` | Network / socket / capacity issue | Reconnect with backoff |
| `"WebSocket handshake failed: 401..."` | Auth rejected at connect time | Show auth prompt |
| `"WebSocket connection failed: ..."` | TCP refused / DNS / timeout | Reconnect with backoff |
| `"ql-collab-ws writer task panicked"` | Internal panic (allocator, future bug) | Bug; log + abort |
| `None` (no error stashed) | Caller-initiated close (`session.detach_transport`) | No reconnect needed |

**Gotchas**:

1. **`#[must_use]` on `detach_transport`** (V2 V3 step 5 closure): the returned `Option<Box<dyn Transport + Send>>` owns the old transport's background tasks. The `let _ = ...` binding above drops it immediately. Holding the Box past reconnect keeps the old TCP socket open + the old `last_error()` reachable separately from the new transport's.
2. **`transport_last_error()` returns `None` if no transport is attached.** Call it BEFORE `detach_transport()` so you read from the failing transport, not the empty session slot.
3. **The reconnect itself can fail.** `WebSocketTransport::connect` returns `Err(WebSocketError::ConnectFailed | HandshakeFailed | InvalidUrl)`. Handle separately from the runtime errors above — these are connect-time, not in-flight.
4. **Backoff is the IDE's responsibility.** The substrate doesn't track retry counts. Build an exponential-backoff loop around `reconnect()` with a max retry budget; show "Cannot connect" after exhausted.

#### 4.1.3 Offline-write recovery

User edits offline (no transport or transport down). They reconnect. All edits flow to peers.

```rust
use ql_collab::{AutoFlushPolicy, CollabSession, PeerId};
use ql_collab_ws::WebSocketTransport;

fn setup_session(rt: &tokio::runtime::Handle, url: &str) -> Result<CollabSession, Box<dyn std::error::Error>> {
    let mut session = CollabSession::new(PeerId::new(1))?;
    session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Initial connect — may fail; user can edit offline meanwhile.
    if let Ok(ws) = rt.block_on(WebSocketTransport::connect(url)) {
        session.attach_transport(ws);
    }
    Ok(session)
}

// User types offline — each append commits locally; no transport,
// so maybe_auto_flush no-ops. Loro's op log IS the implicit offline
// queue.
//   session.append_op(op)?;  // returns Ok even with no transport

// Later: connectivity returns. IDE-initiated reconnect (NOT triggered
// by a user mutator).
fn user_came_back_online(
    session: &mut CollabSession,
    url: &str,
    rt: &tokio::runtime::Handle,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws = rt.block_on(WebSocketTransport::connect(url))?;
    session.attach_transport(ws);

    // CRITICAL: if no user action follows attach, there's no "next
    // mutator" to trigger auto-flush. Drive an explicit flush so the
    // peer sees state immediately, not 5 minutes from now when the
    // user next types. The V2 V3 step 1 baseline-reset on attach
    // (`last_flushed_vv = None`) makes this flush deliver ALL
    // accumulated offline ops in one delta blob.
    if session.has_pending_flush() {
        session.flush_delta_to_transport()?;
    }
    Ok(())
}
```

**Gotchas**:

1. **"Next mutator OR explicit flush" — the IDE chooses based on trigger source.** If reconnect is **user-driven** (e.g., user clicks "Reconnect"), their next keystroke will trigger auto-flush — don't drive explicit. If reconnect is **automatic** (e.g., network-recovery detection), there's no upcoming user action — drive explicit flush, otherwise the peer sees nothing until the user types.
2. **Large-blob memory pressure (V2 V3 step 5 megaudit Opus-A M4)**: post-attach explicit flush sends ALL accumulated offline ops in ONE delta blob. For typical IDE-edit volumes (hundreds of ops, KBs), this is fine. For long offline sessions (hours of edits, MBs), the blob sits in the unbounded outbound mpsc until the writer task drains it — memory pressure on small devices. V2 V4 Tier I + K will add chunking + bounded queue.
3. **Explicit-flush `Err(Closed)` requires the same recovery as auto-flush `Err(Closed)`** (V2 V3 step 5 megaudit Opus-A L4 symmetry): on `flush_delta_to_transport()` returning `Err(Transport(Closed))`, the local state is committed but `last_flushed_vv` is unchanged. Treat it identically to § 4.1.2's reconnect flow — detach + reconnect with a fresh transport.

4. **Confirm local-writer flush with `flush_pending_to_transport()`** (V2 V4 V1 step 1 closure, 2026-05-21): after the post-attach `flush_delta_to_transport()`, call `session.flush_pending_to_transport()?` to block until the writer task has completed `ws_sink.send` for every queued blob (level-1 ack: flushed to the WebSocket sink). Without it, `Ok(true)` from `flush_delta_to_transport()` only means "bytes are queued in the transport's internal mpsc," not "submitted to the sink." For an offline-recovery UX where the user expects "all my offline edits are flushed to the wire" before the UI shows that confirmation, the additional `flush_pending_to_transport()` call is the load-bearing assertion. Note: this is NOT peer-acknowledgement — TCP reliability handles sink→peer transit, but if you need peer-application-level confirmation (e.g., "did the server actually persist this?"), layer a custom ack-op on top of `merge_bytes`. Blocking-sync; same async-context caveat as § 4.1.1 gotcha #3.

5. **Alternative: discard offline edits instead of recovering** (V2 V4 V1 step 5, 2026-05-21): if the user's choice in the reconnect dialog is "Discard local changes" rather than "Sync them," call `session.discard_pending_ops()` BEFORE the explicit `flush_delta_to_transport()`. The discard reverts the log to the last-flushed checkpoint (or empty if never flushed); subsequent flush is a no-op (`Ok(false)`) until the user makes new edits. See § 4.1.1 gotcha #5 for the API contract + a code snippet. **Local-only caveat**: if a discarded op was previously delivered to a peer (in a prior session), the peer still has it and a future `merge_bytes` will re-deliver — discard is a session-local revert, not a protocol-level peer rollback.

### 4.1.x Concurrency model — one session per thread

**V2 V3 step 6 (2026-05-21) — Opus-A cross-workflow + V2 V4 V1 step 3 audit correction (2026-05-21)**: `CollabSession` is `Send + !Sync` (the `Option<Box<dyn Transport + Send>>` field's trait object carries no Sync bound). `WebSocketTransport` is `Send + Sync` (all concrete fields happen to be Sync). Note: the V2 V3 step 4 docstring initially claimed WebSocketTransport was `!Sync` based on intuition about the single-consumer mpsc; corrected in V2 V4 V1 step 3 — single-consumer receive is enforced by `try_recv(&mut self)`, not by `!Sync`. Either way, the IDE pattern is the same: own the SESSION on one thread (since CollabSession is !Sync), channel-pass mutations from other threads. The WebSocketTransport's Sync property doesn't change the recommended pattern because it lives inside the session.

- **Own the session on one thread** (e.g., the IDE's worker thread for background sync).
- **Channel-pass mutations** from the UI thread to the worker via `tokio::sync::mpsc` or `crossbeam::channel`. The UI sends `EditCommand::PutValue { ... }` etc.; the worker invokes `session.append_op(...)` and ships results back via `Status::Synced { peer_count }` etc.
- **Don't wrap the session in `Arc<Mutex<...>>`** for shared concurrent access. Per-method locking pays per-keystroke acquire overhead, defeats the borrow-checker isolation, and adds deadlock risk against the tokio runtime owned by the transport.

The runtime that drives `WebSocketTransport::connect` can be any tokio runtime (current_thread or multi_thread). The session's worker thread and the runtime can be the same thread (current_thread) or separate (multi_thread). The mpsc channels inside `WebSocketTransport` are clone-able tokio handles, so the writer/reader tasks run on the runtime regardless of which thread owns the session.

### 4.1.y Multi-window IDE reconnect contract (Phase 5.7 V3.1.b + V3.1.c, 2026-05-22)

**Status:** V3.1.a engine relay binary at `crates/ql-collab-ws/examples/relay-server.rs` + V3.1.b IDE command `quantlab.quantbookDemoMultiWindow` (file `extensions/quantlab/src/quantbook/multiWindowDemo.ts`). The multi-window demo is the first user-visible V3 surface; V3.2+ will lift these patterns into the production cell-grid UI.

**Co-ordination model: symmetric try-connect-first.** Each VS Code window runs the same command. The first window to invoke spawns the relay binary as a child process (via `child_process.spawn`); subsequent windows detect the relay is already listening and skip the spawn step. PeerId = `BigInt(process.pid)` -- each renderer process has a unique PID; the BigInt comfortably fits within u64. Row = `pid & 0xffff` so multi-window appends land in distinct rows for visual convergence.

**Reconnect-with-backoff contract** (closes V2.8 Lane C R2):

1. Every catch on `appendPutValue` / `pollRemote` / `flushDeltaToTransport` etc. routes through `parseQuantbookError(err)`. If `info.code === 'transport_closed'` or `'transport_io'`, the demo calls `handleTransportClosed(label)`.
2. `handleTransportClosed` is debounced via a `reconnectInFlight` flag -- concurrent timer ticks during a reconnect get a `return` early.
3. The handler `session.detachTransport()` + calls `reconnectWithBackoff(engine, log)` which retries `engine.Transport.websocketConnect(...)` up to 3 times at 500 / 1000 / 2000 ms backoff.
4. On success: `session.attachTransport(fresh)` + log "reconnect succeeded; demo resumes". Reconnect-in-flight gate releases; next timer tick resumes normal cadence.
5. On exhaustion: stop the demo (clear timers, detach transport, kill spawned relay if this window owned it) BEFORE prompting the user. Then surface a `vscode.window.showWarningMessage(msg, 'Restart Demo')`. If the user clicks "Restart Demo", `vscode.commands.executeCommand('quantlab.quantbookDemoMultiWindow')` re-invokes the command -- the fresh invocation sees no running relay and re-spawns it via `connectOrSpawn`'s spawn fallback.

**Dispose-from-handler safety**: the disposable's `dispose()` is idempotent (guarded by `isDisposed`). The reconnect-exhaustion path calls `dispose()` itself, AND `context.subscriptions` still holds a reference to the disposable. When the user later closes the window OR re-invokes the command, the eventual second `dispose()` call is a no-op.

**Drift hazards** (for V3.x maintainers):
- The relay binary's stdout marker `[ql-collab-ws relay] listening on ws://...` is the load-bearing readiness signal (Lane C R6). If you rename the marker, update both the binary AND `spawnRelayBinary`'s `readyMarker` constant.
- The relay's default port `7117` is duplicated as a constant in the binary (`DEFAULT_PORT`) AND the IDE (`RELAY_PORT`). Keep them in sync. Mocha test uses `17117` to avoid collisions with a real running demo.
- `MAX_RECONNECT_TRIES = 3` + `INITIAL_RECONNECT_BACKOFF_MS = 500` (doubling) are tuned for localhost; production over WAN will need a different policy (V3.x backlog: configurable + smarter -- jitter, indefinite retry on user request, etc.).

**Out of scope for V3.1**: smarter reconnect policy, programmatic second-window spawn (today the user manually opens window 2 via File > New Window), TLS, auth, multi-session WAN.

### 4.1.z Cell-grid webview message-passing contract (Phase 5.7 V3.2.b, 2026-05-22)

**Status:** V3.2.a scaffold at `extensions/quantlab/src/quantbook/cellGrid/` + V3.2.b nonced cell-edit flow (this commit's IDE counterpart, `86b02d22a0b`).  First webview consumer of the V2 Transport binding's structured-error contract (`parseQuantbookError` + `QuantbookErrorCode`).

**File layout (vscode-free split for testability):**

- `cellGridHtml.ts` -- pure HTML/CSS/inline-script builder.  No `vscode` import.
- `cellGridLogic.ts` -- pure host-side dispatcher + parser.  No `vscode` import.
- `cellGridPanel.ts` -- thin `vscode.WebviewPanel` wrapper that wires the above into a lifecycle (`show()` / `render()` / `refreshAll()` / `onDidReceiveMessage` -> `dispatchIncomingMessage`).

**Security posture:**

- `enableScripts: true` (required by the click-to-edit flow).
- CSP: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`.
- Nonce is 32-char alphanumeric (`[A-Za-z0-9]{32}`), regenerated per `render()` call.  Format matches `LoginWebviewPanel._nonce` for cross-extension audit consistency.
- The SAME nonce appears in BOTH the CSP `script-src` directive AND the inline `<script nonce="...">` attribute.  `buildHtml` reads it from a single local; the browser/webview rejects the script if the values diverge.

**Message envelope (decision lock V3.2.b.1):**

```ts
// Outgoing (webview -> extension host)
interface PutValueRequest {
  type: 'putValue';
  sheet: number;
  row: number;
  col: number;
  rawInput: string;   // literal user-typed string; host parses
}

// Incoming (extension host -> webview), failure path
interface ErrorReplyMessage {
  type: 'errorReply';
  sheet: number;
  row: number;
  col: number;
  code: QuantbookErrorCode;   // from parseQuantbookError(err).code
  message: string;
}
```

The success path is NOT a message -- it's a full HTML rebuild via `panel.webview.html = buildHtml(snapshot, { nonce })`.  The new document carries fresh data attributes + a fresh script; the prior input element is gone because the cell's display text now matches the committed value.

Unknown `type` values from EITHER direction are logged + ignored.  No silent fall-through, no exception.  Future schema additions can land without breaking older webviews (the webview WILL ignore a future `pushUpdate` message it doesn't know how to handle; same for the host receiving a future client message).

**Rendering contract (decision B4 -- PESSIMISTIC):**

- User clicks `.cell-value` -> webview replaces `<td>` content with `<input>`.
- User types + presses Enter -> webview posts `putValue` + LEAVES the input in place.
- Host parses + commits + re-renders on success (input is destroyed by the HTML rebuild; cell now shows committed value).
- Host posts `errorReply` on failure; webview script ADDS `.cell-edit-error` class to the cell + sets `title="[code] message"`; the input STAYS so the user can correct + retry.
- Escape / blur cancels: input is destroyed, cell text restored from `data-original-text`.  No commit.

Localhost IPC latency is sub-millisecond so the "input visible until host confirms" model produces no user-perceptible lag.  Optimistic rendering (mutate `<td>` immediately + roll back on errorReply) is deferred to V3.x where slow-network modes (TLS + WAN) would justify the rollback complexity.

**Number-only constraint:**

V3.2.b commits NUMERIC cells only.  The V1 napi `appendPutValue(sheet, row, col, value: f64)` is the only binding for write today; text / boolean / error variants are READ-ONLY (they can be RECEIVED via `mergeBytes` from a peer that supports them, but the IDE can't CREATE them from JS).  `parseCellRawInput` rejects non-numeric / empty / `Infinity` / `NaN` with `[bad_argument]`.

**V3.2.b limitation -- no remote auto-refresh (decision B5):**

Remote peers' edits do NOT automatically appear in this panel.  The user must run `quantlab.quantbookCellGridRefresh` to see updates from another window.  V3.2.c will add a 1-second `pollRemote` loop (or a push API in V3.x) to close this gap.

**Drift hazards (for V3.x maintainers):**

- The nonce token shape is duplicated across `LoginWebviewPanel._nonce` and `cellGridPanel.buildPanelNonce`.  If you change the alphabet or length, change both for audit consistency.
- The `[ql-collab-ws relay]` stdout marker (from § 4.1.y) and the cell-grid envelope's `type` field strings (`putValue` / `errorReply`) are load-bearing contract -- a string-level grep is the source of truth, no symbol coupling between webview-side text and host-side text.
- `data-original-text` and `data-original-kind` attributes on `.cell-value` cells carry the cell's pre-edit text.  The cancel path (Escape / blur) reads them to restore the cell.  If you rename either attribute, update both sides of the script that produces + consumes them.

**Out of scope for V3.2.b:** virtualization (V3.3), live remote-peer propagation (V3.2.c), text / boolean / error cell editing (waits on engine-side `appendPutValueText` / `appendPutValueBool` bindings), multi-cell selection / paste, formula bar.

---

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
