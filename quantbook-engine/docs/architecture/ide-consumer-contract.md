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

**Out of scope for V3.2.b:** virtualization (V3.3), live remote-peer propagation (V3.2.c -- see below), text / boolean / error cell editing (waits on engine-side `appendPutValueText` / `appendPutValueBool` bindings), multi-cell selection / paste, formula bar.

### 4.1.z2 Cell-grid live multi-window propagation (Phase 5.7 V3.2.c, 2026-05-22)

**Status:** V3.2.c.2-V3.2.c.5 at IDE commit `a165141eb68`; V3.2.c.6 docs in THIS commit.  Closes the "no remote auto-refresh" V3.2.b limitation by attaching a Transport + running a 1-second `pollRemote` loop.

**New command:** `quantlab.quantbookCellGridCollab` ("Quantbook: Open Cell Grid (Collab)").  The V3.2.a `quantlab.quantbookCellGrid` command stays local-only for fast-start dev / smoke; the collab command is the multi-window surface.

**Attach orchestration (decision C1 + C7):** REUSES `connectOrSpawn` from `extensions/quantlab/src/quantbook/multiWindowDemo.ts` (now exported per V3.2.c.2):

1. Try `engine.Transport.websocketConnect('ws://127.0.0.1:7117')` first.  If a peer window is already running the V3.1.a relay, this succeeds.
2. On failure: spawn the `relay-server` binary (resolved via `resolveRelayBinaryPath`), wait for the stable stdout marker `[ql-collab-ws relay] listening on ws://...`, then reconnect.
3. On spawn-loss race (two windows invoking concurrently both fail step 1, both spawn; OS gives the bind to one; the loser's binary exits): retry step 1.  Lose-the-race window becomes a passive joiner.  V3.1.e Opus M2 / Codex L1 convergent closure preserved.

**Panel lifecycle:** `CellGridPanel.show(context, session, sheet, attachment)`.

- `attachment` is `CollabAttachment { engine, transport, spawnedRelay, log }`.  The panel OWNS every field's lifetime.
- `wireAttachment` runs BEFORE the first render: `session.setAutoFlushPolicy('onAppend')` (decision B4 in `runMultiWindowDemo` -- matches here) + `session.attachTransport(transport)` + `setInterval(tickPollRemote, 1000)`.
- Each cell commit (the V3.2.b `appendPutValueValidated` path) now auto-flushes to the attached transport; peer windows pick it up on their next pollRemote tick.

**Pollloop (decisions C2 + C3 + C5):**

The 1-second interval calls `tickPollRemote()`, which delegates to vscode-free `classifyPollTick(session)`:

```ts
type PollTickResult =
  | { kind: 'idle' }                            // pollRemote()=0; no change
  | { kind: 'merged'; count: number }           // pollRemote()=n>0; render
  | { kind: 'transportClosed' }                 // reconnect via V3.1.c
  | { kind: 'error'; code; message };           // log + skip the tick
```

On `merged`: full `this.render()` rebuild.  Per-cell diffing is deferred to V3.3 virtualization; at V3.2 scale (hundreds of cells, human-typing cadence) a full re-render every second is imperceptible.

**Reconnect (decision C6):** REUSES V3.1.c's `reconnectWithBackoff` (now exported per V3.2.c.2).  3 tries at 500/1000/2000 ms.  On exhaustion: dispose the panel + kill spawned relay (signal-aware predicate per V3.1.e Codex L4) + `showWarningMessage(..., 'Restart Cell Grid (Collab)')`.  Restart re-invokes the command; the fresh invocation re-runs `connectOrSpawn` (no relay running -> spawn).

**Single-tab-per-sheet (V3.2.a.1 + V3.2.c.3):**

- LOCAL panels obey the V3.2.a.1 cache (one panel per sheet; re-open reveals + refreshes).
- COLLAB panels BYPASS the cache (`attachment !== undefined` -> always create a new panel).  Rationale: local + collab on the same sheet target DIFFERENT sessions; reusing the local panel would silently swap its session, breaking the V3.2.b dispatcher's `this.session` closure.

**Status indicator (decision C4):**

OutputChannel-only at V3.2.c.  Each state transition emits a tagged log line:

- `[collab] starting cell-grid collab (sheet 0)...`
- `[collab] joined existing relay at ws://127.0.0.1:7117`  OR  `[collab] spawned relay AND joined at ...`
- `[collab] attached transport (sheet 0); pollRemote every 1000ms`
- `[collab] pollRemote merged N remote blob(s); re-rendering`
- `[collab] pollRemote saw transport_closed; reconnecting`
- `[collab] reconnect succeeded; resuming pollRemote`  OR  `[collab] reconnect EXHAUSTED: ...`
- `[collab] disposed (sheet 0).`

Persistent `vscode.window.createStatusBarItem` is V3.x backlog.

**Deferred to V3.x (still):**

- **Undo/redo** (V3.4 scope per V3.2 plan): the cell-grid panel will need a way to surface UndoGroup boundaries + drive `undo` / `redo` napi calls.  Not modeled in V3.2 message envelope.  Likely additions: `{type:'undo'}` / `{type:'redo'}` outgoing messages + a `refresh` push after the engine applies the inverse.
- Per-cell "incoming" tint animation on merged-remote ops (decision C5 deferred).
- Push API from engine (`Transport::on_inbound_blob` callback) replacing 1s polling -- needs new napi surface + Rule 4 audit (decision C2 Option B).
- Multi-sheet grid (V3.3).
- Optimistic rendering (still N/A at localhost latency; V3.x WAN may revisit).

**Drift hazards (V3.x maintainers):**

- `POLL_REMOTE_INTERVAL_MS = 1000` (`cellGridPanel.ts`) and the multiWindowDemo's `POLL_REMOTE_INTERVAL_MS` are separate constants of the same value.  Keep in sync OR extract to a shared config module when adding a second tunable surface.
- `connectOrSpawn` + `reconnectWithBackoff` are exported from `multiWindowDemo.ts` for V3.2.c.  V3.2.d audit decided NOT to extract to a separate module (would widen the diff for a one-call-site reuse); revisit if a third consumer arrives.
- `CollabAttachment.spawnedRelay` -- the panel disposes it on close.  If you add a SECOND panel for the same sheet (e.g., a future preview surface), make sure only ONE owns the relay; the other should pass `spawnedRelay: undefined` as a joiner.

**V3.2.d audit closures (2026-05-22):**

- **localPanels + collabPanels separate Maps (V3.2.d HIGH-1).** Pre-V3.2.d a single `activePanels` Map keyed by sheet held BOTH local + collab panels, with three latent gaps (collab-then-local revealed collab on local-open; collab-then-collab spawned 2 sessions under same `BigInt(process.pid)` violating V3.1.b PeerId uniqueness; local-then-collab orphaned the local panel from `refreshAll`).  Now: two separate `Map`s; local + collab CAN coexist on the same sheet; collab-then-collab reveals existing + `showInformationMessage` rather than spawning a duplicate.  `refreshAll` iterates both maps.
- **IDE-side validators emit `[bad_argument]` (V3.2.d HIGH-2).** Pre-V3.2.d `appendPutValueValidated` threw plain `Error` strings without the bracket prefix; `parseQuantbookError` bucketed under `'unknown'`.  Now: all four throws prefixed with `[bad_argument]` matching the engine-side V2.7 contract.  Dispatcher (`cellGridLogic.ts`) added `typeof req.rawInput !== 'string'` runtime guard so null / undefined / number `rawInput` surfaces structured `bad_argument` instead of a TypeError -> `'unknown'`.
- **Post-reconnect pending-op flush (V3.2.d Codex M1).** Engine contract is mutate-then-flush; a `transport_closed` during a cell edit's `OnAppend` auto-flush leaves the local PutValue committed but unflushed.  `handleTransportClosed` now checks `session.hasPendingFlush()` after `attachTransport(fresh)` and calls `flushDeltaToTransport()` if true.  Best-effort: if the flush itself fails, the next tick or user edit re-tries.
- **`tickPollRemote` merged-path try/catch (V3.2.d Codex M3).** Pre-V3.2.d `this.render()` was called without try/catch; a throw bubbled into `setInterval` which silently swallowed it AND kept ticking.  Now: wrap render; on `bad_argument` or `session_oplog` (fatal codes), dispose the panel + show Restart warning; on transient codes, skip the tick.
- **postMessage-after-dispose guard (V3.2.d Opus MEDIUM-1).** Added `CellGridPanel._disposed: boolean` set BEFORE `disposeAttachment` in the `onDidDispose` handler.  `handleIncoming.onError` checks this flag; if disposed, falls back to `vscode.window.showWarningMessage` so late-arriving errorReplies still surface to the user instead of being silently dropped to a dead webview.

### 4.1.z3 Cell-grid multi-sheet + virtualization (Phase 5.7 V3.3.0, 2026-05-22 to 2026-05-23)

**Status:** V3.3.0.1 decision lock + V3.3.0.2 `listSheets` napi + V3.3.0.3 `exportSnapshot` incremental cache + V3.3.0.4 IDE custom-inline virtualization scaffold + V3.3.0.5 multi-sheet UX command + V3.3.0.6 audit-gap closures shipped.  V3.3.0.7 (this section's commit) + V3.3.0.X (parallel Codex+Opus audit) pending.  See V3.3 entry plan at `quantbook-engine/.plans/_active.md` for the in-flight checklist.

#### New engine napi surface (V3.3.0.2)

```ts
class CollabSession {
  // V3.3.0.2: enumerate distinct u16 sheets present in the local op log.
  // Returns sorted ascending Vec<u16>; empty if no PutValue ops yet.
  // Errors via [bad_argument] per V2.7 contract.
  listSheets(): number[];
}
```

IDE-side typed wrapper at `extensions/quantlab/src/quantbook/session.ts`:

```ts
function listSheets(session: CollabSessionInstance): number[];
```

**Semantics**: walks the local op log (post-V3.3.0.3 reads from the incremental snapshot cache; pre-cache fallback would walk via op_log().iter()).  Sheets only appear if a `PutValue` op references them; "empty sheets" created via a future `SheetMetadata` Op variant (V3.4+) are NOT enumerated here.  CRDT-consistent: pollRemote-merged blobs from peers are in the log before listSheets walks; cross-peer sheet sets converge.

**V3.4+ migration path**: add `listSheetsMetadata(): Vec<SheetMetadata>` for { id, display_name, color, hidden } when the engine ships a `SheetMetadata` Op variant.  Additive; does not break the V3.3.0.2 `listSheets() -> Vec<u16>` contract.

#### New engine state (V3.3.0.3 -- incremental snapshot cache)

```rust
pub struct CollabSession {
    // ... existing fields ...
    last_snapshot: HashMap<(u16, u32, u32), CellWireValue>,
}
```

**Rule 4 per-field walk** documented inline in `ql-collab/src/session.rs::last_snapshot` doc comment:
- `HashMap<K, V>` is `Send + Sync` when both `K` and `V` are.
- `(u16, u32, u32)` is trivially `Send + Sync` (Copy + 'static).
- `CellWireValue` is `Send + Sync` per V1 audit.
- Composition: `Send + Sync`.  Inherits V2.4 `Arc<Mutex<CollabSession>>` external sync pinning.
- **0 new Rule 4 triggers; arc terminus stays at 6.**

**5 op-mutation paths maintain the cache:**

| Path | Cache update |
|---|---|
| `new` | initialized empty |
| `from_snapshot` | full rebuild via `rebuild_snapshot_cache()` after `OpLog::import_bytes` |
| `append_op` | O(1) incremental insert on `Op::PutValue` (local append is at causal frontier; iteration order does not reorder existing entries) |
| `merge_bytes` | full rebuild (Loro CRDT merge can causally-reorder; iteration order of EXISTING entries can shift even when the log only grows; incremental update would be INCORRECT) |
| `discard_pending_ops` | full rebuild (`self.log = fork_at_vv(...)` replaces the log) |
| `poll_remote_with_limit` | full rebuild after the drain batch (calls `self.log.merge_bytes` directly to avoid per-blob auto-flush; cache invalidation matches the batched cadence) |

**Read path**: new public accessor `CollabSession::snapshot_cells(&self, sheet: u16) -> Vec<((u32, u32), CellWireValue)>`.  Returns sorted ascending by `(row, col)`.  O(cells-in-cache) with a sheet filter (V3.x may nest by sheet for O(cells-on-sheet) if profiling justifies).

**napi `export_snapshot` refactored** to read from the cache via `snapshot_cells`.  Pre-V3.3.0.3 the lock-hold time was O(N) in op count per call (V3.2.d Opus M4); post-V3.3.0.3 it's O(cells-on-sheet).

**Cache invalidation discipline at V3.4 undo:**

- Cache is MONOTONIC-GROW at V3.3 (no undo at V3.3 per V3.2.e exit packet "What V3.2 deliberately did NOT do" + V3.3.0.1 decision D4 defer-persistence-and-undo-to-V3.4).
- V3.4 undo lands → the undo path MUST call `rebuild_snapshot_cache()` (or an undo-aware `invalidate_cells(...)` accessor) before any subsequent `snapshot_cells` / `export_snapshot` read.  Tracked in `.plans/_active.md` V3.3 risk register R-V3.3-2.

#### Custom-inline virtualization (V3.3.0.4)

Per V3.3.0.1 decision D1 (custom inline; no library; no bundler).  Pure helpers live in `cellGridLogic.ts` (vscode-free; mocha-driveable):

```ts
function computeVisibleRange(
  scrollTop: number,
  rowHeight: number,
  viewportHeight: number,
  totalRows: number,
  overscan?: number = 5,
): { startIdx: number; endIdx: number };

function buildVirtualRows<T>(
  entries: ReadonlyArray<T>,
  startIdx: number,
  endIdx: number,
): T[];
```

`computeVisibleRange` is defensive against `rowHeight === 0` (returns full range; no div-by-zero); clamps `endIdx` to `totalRows`; default overscan = 5 rows above + below visible window for smooth scrolling.

**HTML structure** (`cellGridHtml.ts::buildHtml` with `options.nonce` set):

```
<div class="cell-grid-viewport">   <!-- max-height: 80vh; overflow-y: auto -->
  <table>
    <thead><tr><th>Row</th><th>Col</th><th>Value</th></tr></thead>  <!-- sticky -->
    <tbody data-virt-row-height="25" data-virt-total-rows="{N}">
      <tr class="cell-grid-spacer-top" data-spacer-height="{px}" style="height: {px}px;">...</tr>
      <!-- visible rows here (initial server window = 40 rows) -->
      <tr class="cell-grid-spacer-bottom" data-spacer-height="{px}" style="height: {px}px;">...</tr>
    </tbody>
  </table>
</div>
<script id="cell-grid-data" type="application/json">{...snapshot json...}</script>
```

**Virtualization gate**: only triggers when `nonce` is provided (V3.2.b/c modes) AND `entries.length > 40`.  V3.2.a read-only mode + small snapshots render all rows directly.

**Snapshot data block** is `<script type="application/json">` (non-executable; CSP `script-src 'nonce-...'` blocks unnonced scripts; defense-in-depth: `</script>` substrings in cell text are html-escaped to `<\/script` to prevent premature tag termination).

**Webview script** (inside the nonced `<script>` tag) attaches a scroll listener to `.cell-grid-viewport`; on each scroll tick it recomputes the visible range via inline `computeRange` (client-side mirror of the server `computeVisibleRange`), slices the snapshot via inline `renderRowsClient`, and replaces the `<tbody>` innerHTML with `[topSpacer + visibleRows + bottomSpacer]`.

**Mid-edit safety**: the scroll handler checks `activeInput !== null` (the V3.2.b click-to-edit `<input>` reference); if set, the repaint is SKIPPED for that tick.  Clobbering would lose unsaved text.  User commits / cancels before repaints resume.

**Drift hazard (V3.3.0.6 audit closure)**: `formatCellValueClient` + `renderRowsClient` in the webview script are MIRRORS of `formatCellValue` + `renderRows` in `cellGridHtml.ts`.  Any future change to one MUST also update the other.  V3.x can close via codegen of the client mirror OR by pre-formatting values into the snapshot data block server-side.

#### Multi-sheet UX (V3.3.0.5)

Per V3.3.0.1 decision D2 (panel-per-sheet, NOT sheet-tabs-in-panel):

- New command `quantlab.quantbookCellGridSwitchSheet`.  Calls `CellGridPanel.activeLocalPanels()` → finds the FIRST open local panel (`panels[0]` = oldest by Map-insertion order).  Calls `listSheets(session)` → builds `vscode.window.showQuickPick` items via the new pure helper `buildSheetQuickPickItems(sheets, currentSheet): SheetQuickPickItem[]` (current sheet marked `(current)` in `description`).  On selection: `CellGridPanel.show(context, session, selectedSheet)` opens a NEW panel for that sheet.
- Empty / single-sheet sessions surface `showInformationMessage`; no QuickPick.
- Collab panels NOT eligible (per V3.2.d HIGH-1 mode-split rationale; collab per-sheet switching deferred to V3.x because of peerId + transport-lifetime considerations).

**Panel title** updated in `CellGridPanel.show()`:
- Multi-sheet sessions: `Cell Grid (Sheet N of M)` / `Cell Grid -- Collab (Sheet N of M)`.
- Single-sheet sessions: `Cell Grid (Sheet N)` (no "of 1" noise).
- **Point-in-time semantic**: title is computed at `show()` time via `session.listSheets().length`; later appends that create new sheets do NOT update existing panel titles.  Documented as the V3.3.0.5 ship-time tradeoff (V3.x can wire reactive updates if ergonomic feedback demands).

**Multi-panel selection caveat** (V3.3.0.5 + V3.3.0.6 audit doc):
- When >1 local panel is open, switch-sheet operates on `panels[0]` = OLDEST (Map insertion-order).  This may surprise users who expect "switch the panel I just clicked".
- V3.x can add a panel-picker step or an active-panel accessor.  V3.3 ships oldest-panel semantic for simplicity.

#### V3.2.a sample-data change (V3.3.0.5)

The V3.2.a `quantlab.quantbookCellGrid` command was extended to seed sample data on sheets 0/1/2 (was sheet 0 only).  This makes the V3.3.0.5 switch-sheet command demonstrable without requiring users to first manually seed multiple sheets.

Sample shape:
- Sheet 0: 5 cells (the original V3.2.a sample)
- Sheet 1: 3 cells (cols 0+1 row 0; col 0 row 1)
- Sheet 2: 1 cell (0, 0, 99)

#### Drift hazards (V3.x maintainers)

- `VIRT_ROW_HEIGHT_PX = 25` + `VIRT_INITIAL_ROWS = 40` are duplicated as `ROW_HEIGHT = 25` + `OVERSCAN = 5` in the inline webview script.  If you change the server-side constant, change the client mirror too (the same drift class as the `formatCellValueClient` hazard above).
- `last_snapshot` cache invariants assume LWW semantics inside `(sheet, row, col)`.  V3.4 undo MUST call `rebuild_snapshot_cache()` to invalidate; documented in the cache field's doc comment.
- The `cell-grid-data` data block is HTML-escaped for `</script>` only.  If a V3.x adds OTHER content types (e.g., inline SVG) that have early-termination edge cases, audit the JSON-escape logic at that time.
- `CellGridPanel.activeLocalPanels()` returns a snapshot — callers must NOT cache the array across event-loop ticks (panels can dispose at any time).
- The webview script's mid-edit guard depends on `activeInput !== null`; if a V3.x adds OTHER user-interaction state (e.g., drag-selecting cells), the scroll handler may need additional guards.

#### V3.3 risks (carryforward from V3.2.d Opus § V3.3 readiness + V3.3-specific)

- **R-V3.3-1 Virtualization integration risk** -- MITIGATED at V3.3.0.4 by custom-inline design (no library/bundler).
- **R-V3.3-2 exportSnapshot incremental cache invariants under undo** -- OPEN; V3.4 undo MUST audit cache invalidation before shipping.
- **R-V3.3-3 listSheets enumeration consistency** -- LOW; op log has the data; engine-side cache keeps it consistent across local appends + remote merges.
- **R-V3.3-4 Persistence schema versioning** -- OPEN (V3.4 problem); D-1 ship established the Tier D3 envelope.
- **R-V3.3-5 PeerId reuse under restart** -- MEDIUM; carryforward from V3.1.e Codex M1; V3.2.d HIGH-1 closure handles same-window collab-then-collab but NOT cross-restart.  Defensive UUID-derived peerId fix is V3.x backlog.
- **R-V3.3-6 Virtualization + reconnect race** -- MITIGATED at V3.3.0.4 by the `activeInput !== null` mid-edit guard + the V3.2.b panel.dispose teardown that destroys the scroll listener with the document.

#### Out of scope for V3.3.0

- `.qbook` persistence (V3.4 scope per V3.3.0.1 decision D4).
- Undo/redo + UndoGroupGuard RAII translation (V3.4 scope).
- Presence (PresenceState + sweep_presence integration with the grid widget; V3.4 scope per Phase 5.6 V2 integration).
- `rebuild_workbook` routing (V3.5 scope; V3.3 reads from the incremental cache which is decoupled from full workbook reconstruction).
- Push API for inbound observation (V3.x backlog; V3.3.0.1 D6 keeps 1s pollRemote).
- Per-cell incoming-tint animation (V3.x backlog; V3.2.c.1 C5 deferred + V3.3 inherits).
- Persistent `vscode.window.createStatusBarItem` (V3.x backlog; V3.2.c.1 C4 deferred + V3.3 inherits).
- Text / boolean / error cell creation from JS (waits on engine-side `appendPutValueText` / `appendPutValueBool` napi bindings; V3.3 keeps the V3.2.b number-only edit surface).
- jsdom-based DOM integration test for virtualization (V3.3.0.6 deferral; mocha cannot natively execute the webview script without jsdom or vscode-test).
- Live VS Code two-window smoke test for V3.3 (out of mocha scope; V3.3.0.X audit may revisit via vscode-test or manual procedure).

#### Live smoke procedure (V3.3.0.6 user-action gap closure)

Mocha pins the V3.3 surface 176/176 but the actual VS Code webview lifecycle + virtualized scrolling + multi-sheet UX has not been verified at the OS level.  User-facing smoke test procedure:

```sh
# 1. Build engine cdylib with test-fixtures enabled (mocha needs it
#    too; this also makes the IDE extension able to load the fixture
#    class if needed).
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
cargo build -p ql-bindings-node --release --features test-fixtures

# 2. Open the IDE in development mode (Extension Development Host).
#    From quantlab repo root:
#      open -a "Visual Studio Code" .
#    Then F5 -> Run Extension.

# 3. In the Extension Development Host window:
#    Cmd-Shift-P -> "Quantbook: Open Cell Grid"
#    Expected:
#      - panel opens with title "Cell Grid (Sheet 0 of 3)"
#      - 5 sample rows visible (sheet 0 sample data from V3.3.0.5)
#      - clicking a cell -> input box appears with the value
#      - typing + Enter -> input stays in place; cell value updates
#        on the host re-render (V3.2.b PESSIMISTIC flow)
#      - Escape on input -> cell restored

# 4. Cmd-Shift-P -> "Quantbook: Switch Cell Grid Sheet"
#    Expected:
#      - QuickPick with 3 items: Sheet 0 (current), Sheet 1, Sheet 2
#      - selecting Sheet 1 -> new panel opens with title
#        "Cell Grid (Sheet 1 of 3)" + sheet-1 sample data (3 cells)

# 5. Scroll smoke (requires a large snapshot):
#    Add enough sample data to exceed 40 rows (modify V3.2.a command
#    to seed 100 rows, OR use the V3.2.b cell-edit flow to manually
#    add rows).
#    Expected:
#      - scrolling the viewport reveals additional rows
#      - tbody re-renders dynamically (visible in webview devtools
#        Network -> none; Elements -> tbody innerHTML changes on scroll)
#      - scrolling while a cell is in edit mode does NOT clobber the
#        input (mid-edit guard works)

# 6. Multi-window collab smoke (V3.2.c surface; V3.3 inherits):
#    File -> New Window
#    In window 1: run "Quantbook: Open Cell Grid (Collab)"
#    In window 2: run the same command
#    Expected:
#      - both windows spawn the relay (race-retry handles spawn loss)
#      - edits in window 1 appear in window 2 within ~1s (pollRemote
#        cadence) and vice versa
```

If smoke surfaces issues, file findings against V3.3.0.X audit (parallel Codex+Opus megaudit) which is the next planned audit cycle.

### 4.1.z4 Undo/redo + `.qbook` persistence + presence integration (Phase 5.7 V3.4, 2026-05-23)

**Status:** ALL V3.4.0 sub-steps SHIPPED + AUDITED.  V3.4.0.1 decision lock + V3.4.0.2 hybrid `CellState` cache + V3.4.0.3 undo/redo napi + Cmd-Z webview wiring + V3.4.0.4a engine `.qbook` napi + V3.4.0.4b IDE Save As/Open commands + UUID PeerId + V3.4.0.5a presence napi + V3.4.0.5b IDE cell-grid presence integration + V3.4.0.6 mocha (effectively complete via incremental +47 V3.4-specific tests) + V3.4.0.7 (this section's commit) + **V3.4.0.X cumulative megaudit** (2026-05-24; 3 HIGH + 3 MEDIUM + 3 LOW closed in-cycle; 3 MEDIUM doc-deferred; 5 LOW V3.4.1+ backlog).  V3.4 phase termination next.

**Engine HEAD trail**: `a87c31eed4f` (0.1 lock) -> `1ae59a1a1aa` (0.2 cache) -> `7d63ff53132` (0.3 undo/redo) -> `5ce55f65739` (0.5a presence) -> `cd26a37b513` (0.5b plan-only) -> `bef220d7d3c` (0.4a engine napi) -> `a1e2c673381` (0.4b plan + D5 deviation) -> `6f7eb20cf44` (Cargo.lock) -> `b2b3775fcc8` + `30ae2d30b44` + `6cfaaffb01c` (deep-audit drift fixes) -> `fe10a245d07` (0.7 docs) -> `b2052797f9a` (MASTER-PLAN sweep) -> **V3.4.0.X closures (this commit)**.  **IDE HEAD trail**: `673792af05f` (0.3) -> `8ff2d81f1e4` (0.5a) -> `1744cee11af` (0.5b) -> `ec9b59db8a5` (0.4a) -> `fa7ec198cee` (0.4b) -> **V3.4.0.X closures (this commit pair)**.

**Audit transcripts:** `docs/audits/2026-05-24-phase-5-7-v3-4-0-x-{codex,opus}.md`.  Codex Lane A (protocol/correctness) + Opus Lane B (adversarial design) ran in parallel.  Cross-lane convergent: **1 HIGH** (Codex H3 + Opus H1 -- `quantlab.quantbookCellGrid` sample-data path lacks `addSheet` -> Save As fails).  Single-lane: 2 Codex HIGHs + 5 Opus MEDIUMs + 3 Codex MEDIUMs + 3 Codex LOWs + 5 Opus LOWs.  See "V3.4.0.X cumulative megaudit closures (2026-05-24)" sub-section at the end of this section for the full closure record.

#### New engine napi surface (V3.4.0.3 + V3.4.0.4a + V3.4.0.5a)

```ts
class CollabSession {
  // V3.4.0.3 -- undo/redo over Loro UndoManager.  Returns true if a stack
  // item was consumed (inverse op appended to visible log), false if the
  // stack was empty.  LOCAL-ONLY: remote ops merged via mergeBytes /
  // pollRemote are NOT affected.  On consumed=true, rebuild_snapshot_cache
  // is called BEFORE auto-flush (V3.3.0.X HIGH-1 closure) so a subsequent
  // exportSnapshot reads the post-undo CellState view atomically.
  undo(): boolean;
  redo(): boolean;

  // V3.4.0.4a -- minimal Op::AddSheet wrapper.  Sheet ids are assigned
  // deterministically by the engine on replay in op-log append order
  // (first addSheet call -> sheet 0; second -> sheet 1; ...).  Required
  // before any appendPutValue on a sheet (rebuild_workbook replay
  // requires sheets to exist before PutValue).
  addSheet(name: string, chunkRows: number): void;

  // V3.4.0.4a -- save to a .qbook directory at `path`.  Calls
  // rebuild_workbook(&default_registry()) internally + save_workbook_with_oplog.
  // Atomic two-file write (workbook.toml at envelope v2 + oplog.bin in
  // Tier D3 header).  Workbook name hardcoded as "quantbook".
  toQbook(path: string): void;

  // V3.4.0.5a -- presence 5-pack.  See PresenceStateJson struct + #4.1.z4
  // presence section for full semantics.
  updatePresence(state: PresenceStateJson): void;
  peerPresence(peer: bigint): PresenceStateJson | null;
  clearPresence(): void;
  sweepPresence(): number;
  peersWithPresence(): bigint[];
}

class CollabSession {
  // V3.4.0.4a -- load a session from a .qbook directory at `path`.
  // peerIdOverride is REQUIRED (not Option) -- V3.4.0.4b IDE caller
  // always passes a fresh UUID-derived BigInt via generateUuidPeerId
  // (per D5 DEVIATION; see § D5 below).
  static fromQbook(path: string, peerIdOverride: bigint): CollabSession;
}

// V3.4.0.5a -- JS-facing PresenceState mirror via #[napi(object)].
// All 6 fields required.  Cursor coords = (sheet, row, col); selection-
// rectangle opposite corner = (selectionEndRow, selectionEndCol); typing
// is a soft hint for IDE cursor styling.  Engine-side bidirectional From
// impls (CorePresenceState <-> PresenceStateJson) at FFI boundary.
interface PresenceStateJson {
  sheet: number;
  row: number;
  col: number;
  selectionEndRow: number;
  selectionEndCol: number;
  typing: boolean;
}
```

IDE-side typed wrappers at `extensions/quantlab/src/quantbook/session.ts`:

```ts
function undo(session: CollabSessionInstance): boolean;
function redo(session: CollabSessionInstance): boolean;
function addSheet(session: CollabSessionInstance, name: string, chunkRows?: number): void;  // default chunkRows=1000
function exportToQbook(session: CollabSessionInstance, path: string): void;
function sessionFromQbook(path: string, peerIdOverride: bigint): CollabSessionInstance;
function generateUuidPeerId(): bigint;  // V3.4.0.4b; see § D5
function updatePresence(session: CollabSessionInstance, state: PresenceStateJson): void;
function peerPresence(session: CollabSessionInstance, peer: bigint): PresenceStateJson | null;
function clearPresence(session: CollabSessionInstance): void;
function sweepPresence(session: CollabSessionInstance): number;
function peersWithPresence(session: CollabSessionInstance): bigint[];
function buildPresenceSnapshotJson(session: CollabSessionInstance, panelSheet: number): PresencePanelSnapshot;  // host-side helper for V3.4.0.5b
```

**Error code surface** (extends V2.7 `QuantbookErrorCode` discriminated-union):

| Code | Source | Meaning |
|---|---|---|
| `qbook_error` | `PersistenceError::Qbook(_)` | workbook persistence layer (I/O, schema, malformed cell) |
| `qbook_unsupported_version` | `PersistenceError::OplogUnsupportedVersion { .. }` | `oplog.bin` schema version out of band |
| `qbook_truncated_header` | `PersistenceError::OplogTruncatedHeader { .. }` | `oplog.bin` magic-prefix present but header < 8 bytes |
| `qbook_unknown` | `PersistenceError::_` wildcard | `#[non_exhaustive]` future variants until this mapper is updated |
| `session_oplog` | `CollabSessionError::OpLog(_)` | op-log Loro snapshot encode/decode (also fires from V3.4.0.4a `rebuild_workbook` and `oplog.export_bytes` inside `fromQbook`) |
| `bad_argument` | napi argument validation | peerIdOverride zero / negative / > u64::MAX; `presenceUpdate` envelope malformed |

`KNOWN_QUANTBOOK_ERROR_CODE_RECORD` in `session.ts` extends accordingly so V2.9 Lane C M3's record-driven `isQuantbookErrorCode` typeguard auto-recognizes the new codes.

#### New engine state (V3.4.0.2 -- hybrid `CellState` cache)

```rust
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellState {
    pub value: Option<CellWireValue>,
    pub formula: Option<String>,
}

pub struct CollabSession {
    // ... existing fields ...
    last_snapshot: HashMap<(u16, u32, u32), CellState>,  // <-- type changed from CellWireValue
}
```

**Rule 4 per-field walk** (V3.4.0.2 doc-comment; independently re-verified at V3.3.0.X by Opus + carried forward through V3.4):

- `Option<T>: Send + Sync` when `T: Send + Sync` (std auto-trait).
- `value: Option<CellWireValue>`: `CellWireValue` is `Send + Sync` per V1 audit.
- `formula: Option<String>`: `String` is `Send + Sync` trivially.
- Composition: `CellState: Send + Sync`.
- `HashMap<(u16,u32,u32), CellState>: Send + Sync` (HashMap composition over auto-traits).
- **0 new Rule 4 triggers at V3.4.0.2; arc terminus stays at 6.**  V3.4.0.5a adds one new napi-boundary struct `PresenceStateJson` -- composition of three `u16/u32` + one `bool` primitives, trivially Send+Sync; **also 0 new triggers**.

**Per-field LWW semantics** (NOT per-cell):

- `Op::PutValue` writes `state.value`, **preserves** `state.formula`.
- `Op::PutFormula` writes `state.formula`, **preserves** `state.value`.
- `Op::ClearFormula` clears `state.formula` via `get_mut + skip-if-absent`, preserves `state.value`.
- A cell can carry BOTH a value AND a formula (e.g., `=A1+1` evaluated to `42` -- formula text + cached numeric coexist).

**Ghost-entry avoidance**: `ClearFormula` uses `get_mut` (NOT `entry().or_default()`) so a ClearFormula on a never-written cell does NOT create a phantom cache entry.  Preserves `list_sheets_from_cache` correctness -- sheets only surface if a cell-keyed op materialized an entry.

**7 op-mutation paths maintain the cache** (extends V3.3.0.3's 5):

| Path | Cache update |
|---|---|
| `new` | initialized empty |
| `from_snapshot` | full rebuild via `rebuild_snapshot_cache()` after `OpLog::import_bytes` |
| `append_op` | O(1) incremental upsert on `Op::PutValue` / `Op::PutFormula` / `Op::ClearFormula` (3 cell-keyed variants; local append is at causal frontier; iteration order does not reorder existing entries) |
| `merge_bytes` | full rebuild (Loro CRDT merge can causally-reorder; iteration order of EXISTING entries can shift) |
| `discard_pending_ops` | full rebuild (`self.log = fork_at_vv(...)` replaces the log) |
| `poll_remote_with_limit` | full rebuild after the drain batch (`merge_bytes` direct call) |
| `undo` / `redo` | full rebuild BEFORE auto-flush (V3.3.0.X HIGH-1 closure; carries through V3.4.0.3) |

**napi `export_snapshot` shape preservation** (V3.4.0.2 contract): the JSON shape returned to the IDE is UNCHANGED from V3.3.0.3 -- the FFI layer extracts `state.value` via `filter_map` and SKIPS entries where `value` is `None` (formula-only cells with no literal value).  V3.4.1+ may extend the JSON with a `formula?: string` field once IDE rendering needs formula display; for V3.4 the snapshot remains literal-value-only.

**Read path**: `CollabSession::snapshot_cells(&self, sheet: u16) -> Vec<((u32, u32), CellState)>` -- signature CHANGED from `CellWireValue` to `CellState` at V3.4.0.2.  Direct Rust consumers must `.value.as_ref()` to access the literal.

#### Undo/redo invalidation contract + Cmd-Z webview wiring (V3.4.0.3)

**Cache invalidation contract** (closes V3.3 R-V3.3-2):

- On `undo() == true` (and symmetrically `redo() == true`), the engine method calls `rebuild_snapshot_cache()` BEFORE returning + BEFORE auto-flush.  IDE callers can chain `undo() === true` immediately with `exportSnapshot` without re-locking.
- On `undo() == false` (empty stack), NO cache rebuild + NO auto-flush is triggered -- a closed transport cannot turn "nothing to undo" into a spurious `[transport_closed]` error (V3.5 V2 V2 + Codex M2 contract carried).

**Cmd-Z webview wiring** (V3.4.0.3 IDE; lives in `cellGridHtml.ts::buildClientScript`):

```text
document.addEventListener('keydown', function (ev) {
  if (activeInput !== null) {
    // Mid-edit: let the browser handle text-undo inside the cell <input>.
    // Do NOT preventDefault; do NOT post the workbook undo envelope.
    return;
  }
  const isMeta = ev.metaKey || ev.ctrlKey;
  if (!isMeta) return;
  const key = ev.key.toLowerCase();
  if (key === 'z' && !ev.shiftKey) {
    ev.preventDefault();
    vscode.postMessage({ type: 'undo' });
  } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
    ev.preventDefault();
    vscode.postMessage({ type: 'redo' });
  }
});
```

Key mapping: `(Cmd|Ctrl)+Z` (no Shift) -> `{type:'undo'}` post; `(Cmd|Ctrl)+Shift+Z` OR `Ctrl+Y` (Win/Linux convention) -> `{type:'redo'}` post; case-insensitive on `'z'` / `'y'`.

**Mid-edit guard** (V3.4.0.1 D4 boolean-flag race-guard pattern; extends V3.3.0.4 `activeInput` scroll-handler guard): when `activeInput !== null`, the keydown handler returns BEFORE `preventDefault + postMessage`, so the browser's native text-undo handles undo inside the `<input>` rather than escaping into the workbook undo path.

**Dispatcher envelope arms** (`cellGridLogic.ts::dispatchIncomingMessage`):

```text
undo / redo:
  - consumed=true  -> deps.onCommit() triggers panel re-render via V3.3.0.3 cache
  - consumed=false -> silent no-op (empty stack; user pressed Cmd-Z with nothing to undo)
  - engine throw   -> deps.onError({ code: info.code, message: '[undo|redo] ${info.message}',
                                     sheet: deps.sheet, row: 0, col: 0 })
```

`row/col` sentinels = 0 because undo/redo is session-wide, not cell-keyed; the errorReply schema requires coords (V3.2.b.1 B1 envelope contract).

#### `.qbook` persistence (V3.4.0.4a) + `addSheet` real semantic gap closure

**Envelope format**: stays at v2 per V3.4.0.1 D3 -- the existing `workbook.toml.schema_version` from Phase 2A.8 is sufficient; no v3 bump needed because the D5 deviation (V3.4.0.4b) means PeerId is NOT persisted in the envelope.  Tier D3 oplog wrapper from D-1 step 7 carries unchanged.

**`toQbook(path)` semantics** (V3.4.0.4a):

1. Lock the session.
2. Call `inner.rebuild_workbook(&default_registry())` -- materializes a `Workbook` from the op log via `replay_into`.  The `Workbook` NEVER crosses the FFI boundary; it's a write-only serializer input.
3. Call `save_workbook_with_oplog(&wb, op_log, "quantbook", path)` -- atomic two-file write (workbook.toml + oplog.bin) via temp-dir + rename.
4. Workbook name hardcoded as `"quantbook"` at V3.4.0.4a; V3.4.1+ may accept a name argument derived from filename.

**`fromQbook(path, peerIdOverride)` semantics**:

1. Validate `peerIdOverride` via `peer_id_from_bigint` -- non-zero (LEGACY_PEER sentinel rejected) + within u64 range.
2. `load_workbook_with_oplog(path)` -> `(Workbook, OpLog)`.
3. The loaded `Workbook` is DISCARDED -- only the `OpLog` matters for V3.4.0.4a.  IDE-side Workbook consumption stays V3.5+ scope; the V3.3.0.3 incremental cache (rebuilt during `from_snapshot`) answers all V3.3+ consumer queries.
4. `oplog.export_bytes()` -> snapshot bytes.
5. `CollabSession::from_snapshot(peer_id_override, &bytes)` -> fresh session at the loaded state.  `from_snapshot` rebuilds the V3.3.0.3 / V3.4.0.2 cache from the imported log per its field-docstring contract.

**Double-Loro-serialization cost**: `load_workbook_with_oplog` decodes -> `export_bytes` re-encodes -> `from_snapshot` re-decodes.  At V3.4 scale (workbook open is user-initiated, ~1/min max), this is irrelevant.  V3.4.1+ could add `CollabSession::from_oplog(peer_id, OpLog)` factory bypassing the round-trip if profiling justifies, but it requires lifting the LoroDoc-set-peer-id concern through a new API surface.

**`addSheet(name, chunkRows)` -- REAL SEMANTIC GAP closure** (V3.4.0.4a discovery):

`CollabSession::rebuild_workbook` (called internally by `toQbook`) replays the op log into a fresh `Workbook` via `replay_into`, and `Op::PutValue { sheet, ... }` replay REQUIRES the sheet to already exist (else `session_replay -- invalid sheet at op N`).  Without an `addSheet` napi, sessions built purely via `appendPutValue` could NOT be saved.  The minimal wrapper closes the gap:

- Sheet ids are assigned deterministically by the engine on replay in op-log append order: first `addSheet` -> sheet 0; second -> 1; ...
- `chunkRows` = per-sheet row partition size for `Workbook` internal storage (Phase 2A multi-million-cell optimization).  Pass `1000` for typical V3.4 scale.
- Callers building sessions intended for `.qbook` persistence MUST `addSheet` BEFORE `appendPutValue` for that sheet.

**Save-during-pending-flush** (R-V3.4-6 CLOSED at V3.4.0.4a): `toQbook` saves `inner.op_log()` directly, which contains ALL local ops.  Transport "flush" is the cross-peer sync, ORTHOGONAL to disk persistence.  The session's local op log IS the canonical state from this peer's perspective regardless of whether peers have observed it.  No pending-flush hazard at V3.4 scope.

**IDE commands** (V3.4.0.4b):

- `quantlab.quantbookSaveAs`: requires an open local `CellGridPanel` (`CellGridPanel.activeLocalPanels()`); uses oldest-panel semantic per V3.3.0.5/.6 (`panels[0]`).  `vscode.window.showSaveDialog` with `filters: { 'Quantbook': ['qbook'] }` -> `exportToQbook(panel.session, uri.fsPath)`.  Success / failure toasts via `vscode.window.showInformationMessage` / `showErrorMessage` + log to extension output channel.
- `quantlab.quantbookOpen`: `vscode.window.showOpenDialog` with `canSelectFolders: true` + `canSelectFiles: false` (a `.qbook` is a directory) + filter -> generates fresh PeerId via `generateUuidPeerId()` (per D5 DEVIATION) -> `sessionFromQbook(path, peerId)` -> `CellGridPanel.show(context, session, 0)` (always opens on sheet 0; user runs Switch Cell Grid Sheet for other sheets).

#### D5 DEVIATION -- fresh-UUID-per-session (V3.4.0.4b)

**Original V3.4.0.1 D5 lock**: persisted-per-workbook PeerId via envelope v3 (`peer_id_for_this_session: u64` field) OR `~/.config/quantlab/peer_ids.json` keyed by workbook UUID; on subsequent open the same workbook gets the same PeerId -> "this peer is User A across sessions" continuity.

**Implementation discovery at V3.4.0.4b**: persisted-per-workbook PeerId has an unsolvable two-windows-same-workspace collision -- if a user opens the SAME workbook in TWO vscode windows of the SAME workspace simultaneously, both windows would read the SAME stashed PeerId + assert-fail or, worse, silently corrupt CRDT causality (Loro requires unique PeerIds per concurrent participant).

**Resolution (shipped at V3.4.0.4b)**: **fresh-UUID-per-session**.  IDE-side `generateUuidPeerId()` helper in `session.ts`:

```ts
function generateUuidPeerId(): bigint {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const uuid = crypto.randomUUID();
    const hex16 = uuid.replace(/-/g, '').slice(0, 16);  // first 16 hex = 64 bits
    const value = BigInt('0x' + hex16);
    if (value !== 0n) return value;  // reject the astronomically-rare all-zero
  }
  throw new Error('[bad_argument] generateUuidPeerId: 8 consecutive zero-truncated UUIDs from crypto.randomUUID -- entropy source broken');
}
```

- **Source**: Node 14.17+ `crypto.randomUUID()`; Electron / VS Code well past floor.
- **Entropy**: UUIDv4 has 122 random bits; truncating to 64 keeps ~64 bits.  Birthday-paradox collision probability is ~2^32 sessions before first collision -- effectively zero for real workbook usage.
- **Non-zero guarantee**: `PeerId(0)` is the engine's `LEGACY_PEER` sentinel + would assert-fail `CollabSession::new`.  All-zero truncation has ~2^-64 probability; we retry up to 8 times.
- **8-attempt cap throws per CLAUDE.md No-Fallbacks**: 8 consecutive all-zero UUIDs is ~2^-512 probability -- reaching there means the entropy source is broken; surfaces loudly rather than silently.

**Trade-off accepted**:

- ✅ **CRDT-correct**: each session = distinct Loro peer; future ops get unique attribution.
- ✅ **Closes R-V3.3-5 fully**: UUID 2^64 keyspace vs PID's ~2^15 effective range.
- ✅ **No back-compat issue**: V3.4 is the first `.qbook` ship; persisted-peerId contract never existed in production.
- ❌ **No cross-restart op-attribution continuity**: "this peer is User A across sessions" feature is NOT available.  Past ops keep their original PeerId attribution; future ops use the new session UUID.

**V3.4.1+ may revisit IF** a user-facing feature ("show my contributions", per-user color in presence, audit log of who-changed-what) surfaces and justifies the per-workbook stash complexity.  For V3.4.0.4b scope the trade-off is accepted.

#### Presence integration with cell-grid (V3.4.0.5a/b)

**Engine napi (V3.4.0.5a)** wraps the existing Phase 5.6 V1+V2 `CollabSession` presence surface.  `PresenceStateJson` is a `#[napi(object)]` struct at the FFI boundary; bidirectional `From` impls convert between `CorePresenceState` and `PresenceStateJson` losslessly.

**Sweep contract (V1 limitation pinned at V3.4.0.5a tests)**: `sweepPresence()` removes ALL entries unconditionally and returns the removed count.  There is NO threshold parameter at V1; V3.4.1+ may add `sweep_presence_with_threshold(secs)` when engine ships it.  Presence persists across `exportBytes` / `fromSnapshot` (LoroDoc snapshot contains the presence LoroMap; V1 known limitation per engine `presence.rs` docstring); callers wanting "rejoin with clean presence" should call `sweepPresence()` after `fromSnapshot`.

**IDE host-side helper (V3.4.0.5b)**:

```ts
interface PresenceSnapshotPeer {
  peerId: string;       // 16-hex lowercase (matches engine presence::peer_key + DOM data-peer attribute encoding)
  sheet: number;
  row: number;
  col: number;
  selectionEndRow: number;
  selectionEndCol: number;
  typing: boolean;
}
interface PresencePanelSnapshot {
  selfPeerId: string;
  peers: PresenceSnapshotPeer[];
}

function buildPresenceSnapshotJson(session, panelSheet): PresencePanelSnapshot;
// - Skip-self filter: own cursor IS the cell input; no decoration needed.
// - Race-aware null-skip: peer enumerated in peersWithPresence but cleared
//   between calls returns null from peerPresence; silently dropped.
// - Sheet filter happens WEBVIEW-SIDE (today's webview ignores peers on
//   other sheets); host returns ALL peers in case a future multi-sheet UI
//   wants the full set.
```

**HTML embedding** (mirrors V3.3.0.4 `cell-grid-data` data block structure):

```
<script id="cell-grid-presence" type="application/json">{"selfPeerId": "...", "peers": [...]}</script>
```

- Non-executable; CSP `script-src 'nonce-...'` blocks unnonced scripts.
- Defense-in-depth: `</script>` substrings escaped to `<\/script` to prevent premature tag termination.
- Empty fallback `{"selfPeerId": "0000000000000000", "peers": []}` is emitted when caller omits `options.presence` -- the webview script's data-block lookup never returns null (avoids a branch in the inline script).
- Gated on nonced mode: V3.2.a read-only mode has no script + no decoration; the data block is suppressed entirely.

**CSS rule**:

```css
.cell-peer-presence {
  outline: 2px solid var(--vscode-editorCursor-foreground);
  outline-offset: -2px;
}
```

Uses `outline` (NOT `border`) so the existing td border + padding stays stable -- layout doesn't shift when peers arrive / depart.  `outline-offset: -2px` pulls the outline inward to the cell edge.  All peers get the same color at V3.4.0.5b; per-peer color hashing is V3.4.1+ polish.

**Webview decoration script**: parses `cell-grid-presence` on init -> for each peer, filters by `p.sheet === SHEET` -> finds matching `.cell-value[data-row][data-col]` td -> adds `.cell-peer-presence` class + `data-peer="${peerId}"` attribute.  Best-effort: silent if no matching td (peer is on a row outside the virtualized window per V3.3.0.4, OR on a different sheet, OR in a never-PutValue'd cell with no `<td>` to decorate).

**Edit-mode broadcast**: `beginEdit` posts `{type:'presenceUpdate', state:{...typing:true}}`; `endEdit` posts the same with `typing:false`.  Sent regardless of commit/cancel because both transition out of typing state.

**Dispatcher envelope arm** (`cellGridLogic.ts`):

```text
presenceUpdate:
  - runtime validation: state must be object with 6 fields
    (sheet/row/col/selectionEndRow/selectionEndCol all numbers; typing boolean)
  - malformed -> errorReply { code: 'bad_argument', message: '[presenceUpdate] state must be ...' }
  - success   -> session.updatePresence(state); NO onCommit
                 (presence doesn't affect cell snapshot; re-render every cursor
                  move would thrash)
  - engine throw -> errorReply { code: info.code, message: '[presenceUpdate] ${info.message}' }
```

**Panel lifecycle**:

- `render()` builds presence snapshot via `buildPresenceSnapshotJson`; try/catch with `console.warn` fallback per CLAUDE.md No-Fallbacks (presence is non-critical decoration; cells render without it if engine throws).
- `panel.onDidDispose` calls `session.clearPresence()` so this peer's cursor disappears for remote peers when the window closes.  `console.warn` on engine failure (CLAUDE.md compliance -- dispose handlers are fire-and-forget but errors MUST be visible).  Runs BEFORE `disposeAttachment` so the auto-flush has a transport to flush through.

#### Drift hazards (V3.x maintainers)

- **CellState shape evolution**: V3.5+ may add `format: Option<FormatId>` to `CellState` for `Op::SetCellFormat`.  The Rule 4 per-field walk MUST be re-run at that point because `FormatId` is a tagged enum (`Builtin(u32) | Custom(PeerId, u32)`) whose trait obligations were audited at D-1.  The walk MUST cover every new field.
- **`addSheet` pre-`appendPutValue` requirement**: sessions built via `appendPutValue` alone (without prior `addSheet`) CANNOT be saved via `toQbook` -- `rebuild_workbook` replay fails with `session_replay -- invalid sheet`.  Document this in any future test scaffolding helper that builds sessions for persistence round-trip.
- **`rebuild_workbook` engine-side-only constraint**: napi-side `toQbook` uses `rebuild_workbook` internally at V3.4 scope.  IDE-side Workbook materialization stays V3.5+ scope.  Do NOT expose the rebuilt Workbook through FFI without a V3.5 entry-readiness review.
- **D5 deviation pitfall for V3.4.1+**: if a user-facing "show my contributions" feature surfaces and motivates per-workbook PeerId stashing, the V3.4.0.4b two-windows-same-workspace collision MUST be re-solved.  Candidate approaches: (a) per-session UUID + stash-on-first-save with prompt on second-window-open ("rejoin as same user or fork as new user?"); (b) per-machine PeerId in `~/.config` keyed by `(workbook_uuid, machine_id)` so two machines get distinct ids but same-machine same-workbook gets the same.  Both add complexity; defer until justified.
- **Presence data block parallel to `cell-grid-data`**: the V3.4.0.5b webview script reads `cell-grid-presence` separately.  Any V3.x that adds OTHER data blocks (e.g., format snapshot, validation rules) MUST follow the same `<script id="cell-grid-X" type="application/json">` + `</script>`-escape + empty-fallback pattern + nonced-mode gate.
- **UUID retry cap**: `generateUuidPeerId` throws after 8 zero-truncated UUIDs.  This is a defensive No-Fallbacks closure; if the throw ever fires in practice, the entropy source is broken (Electron / V8 randomness pool exhausted, OS-level `/dev/urandom` failure).  Investigate as a runtime corruption signal, NOT a routine retry.
- **`updatePresence` envelope does NOT trigger onCommit**: deliberate at V3.4.0.5b dispatcher arm.  V3.x maintainers extending presence to MORE state (e.g., "selected range" persistence in the snapshot) MUST decide whether the new state changes warrant re-render; the V3.4 default is "no thrash".

#### V3.4 risk register (post-implementation reality)

- **R-V3.4-1 Hybrid cache shape migration breaks consumers** -- MITIGATED at V3.4.0.2 by keeping `snapshot_cells(sheet)` SIGNATURE-extending (return type changed `CellWireValue -> CellState` for Rust consumers; napi `export_snapshot` JSON shape unchanged for IDE).  Internal field shape change only on the Rust side.
- **R-V3.4-2 Undo/redo across persistence load** -- DOCUMENTED.  Loading a `.qbook` gives the session a fresh state; Loro `UndoManager` history is RESET on `from_snapshot` (matches existing behavior).  Load -> no undo of pre-load state available.  This is correct CRDT behavior; document any future "preserve undo across load" feature request as out-of-scope for V3.4.
- **R-V3.4-3 Presence + 2-window collab race** -- **CLOSED at V3.5.0.7** (DEFERRED at V3.4.0.5b -> KNOWN-GAP at V3.4.0.X via Opus M2 -> CLOSED at V3.5.0.7 via host-level guard).  V3.5.0.7 ships the host-level mid-edit-render guard: `CellGridPanel._presenceRepaintInFlight` boolean set true on `presenceUpdate { typing: true }` from the local peer + cleared on `typing: false`; `tickPollRemote`'s `'merged'` branch checks the flag BEFORE `this.render()` and SKIPS + logs when true (deferred render fires on next 1s tick once typing:false arrives -- the merged op stays in the engine cache so no data loss).  Stuck-true mitigation: 30s watchdog (`PRESENCE_TYPING_WATCHDOG_MS`) auto-clears the flag (covers panel-hung / window-closed-mid-edit edge cases) + dispose-time `setPresenceTyping(false)` cancels any pending watchdog.  Dispatcher fires the new `onLocalTyping` callback AFTER `updatePresence` succeeds (validation failures + engine throws SKIP the fire -- host flag stays in sync with engine state).  **9 mocha tests** pin the dispatcher contract; live smoke verification of the two-window race is the V3.5.0.9 § 4.1.z5 procedure addition.  See V3.5.0.7 sub-step in `.plans/_active.md` for the full closure record.
- **R-V3.4-4 PeerId reuse across .qbook save/load** -- CLOSED at V3.4.0.4b via D5 DEVIATION (see § D5 above).  Fresh-UUID-per-session via `crypto.randomUUID` truncated to 64-bit BigInt.  R-V3.3-5 cross-restart PID collision carryforward also CLOSED (UUID 2^64 keyspace vs PID ~2^15 effective range).
- **R-V3.4-5 Undo across remote-op merge** -- DOCUMENTED.  Loro `UndoManager` only undoes LOCAL ops; remote ops merged via `pollRemote` are NOT undone.  This is correct CRDT behavior; undoing a remote op would mean "delete the peer's edit" which violates causality.  IDE smoke procedure (§ live smoke below) includes an explicit two-window check: "Cmd-Z after a remote edit lands undoes YOUR last edit, not the remote one."
- **R-V3.4-6 .qbook save during pending-flush** -- CLOSED at V3.4.0.4a (see `.qbook persistence` section above).  `toQbook` saves `op_log()` directly; transport flush is orthogonal to disk persistence.
- **~~R-V3.4-7 Presence sweep frequency~~** -- **VOIDED at V3.4.0.5b**.  Pre-implementation premise (Phase 5.6 V2 `sweep_presence(threshold_secs)`) was WRONG: the engine `sweepPresence()` actually shipped without a threshold parameter and sweeps ALL entries unconditionally.  Periodic auto-sweep on a tick cadence would clobber live remote peers' cursor decorations.  Correct behavior at V3.4.0.5b: sweep ONLY on lifecycle events (`panel.onDidDispose` calls `clearPresence` for the local peer).  Threshold-based variant deferred to V3.4.1+ when engine ships `sweep_presence_with_threshold(secs)`.

#### Out of scope for V3.4

- Save-on-edit auto-save (V3.4.1+; user must explicitly run `Quantbook: Save As` after edits).
- Last-saved-time indicator in panel title (V3.4.1+).
- Multi-sheet picker in `Quantbook: Open` UX (always lands on sheet 0; user runs `Quantbook: Switch Cell Grid Sheet` for other sheets; V3.4.1+).
- Per-peer color hashing for presence decoration (V3.4.1+ polish; today all peers get `--vscode-editorCursor-foreground`).
- Tooltips on presence-decorated cells ("PeerId X is editing"; V3.4.1+ polish; the `data-peer` attribute is already pinned for the future hook).
- Threshold-based `sweepPresence` variant (waits on engine `sweep_presence_with_threshold(secs)`; V3.4.1+).
- Per-workbook PeerId stash for cross-restart op-attribution continuity (D5 deviation deferral; V3.4.1+ IF user-facing feature surfaces).
- IDE-side `rebuild_workbook` consumption (V3.5+ scope; today engine-side-only at the napi layer for `toQbook` serialization).
- Partial-invalidate undo strategy (V3.5+; V3.4 uses full-rebuild per V3.3.0.X HIGH-1 closure).
- Full `Op` enum cache coverage (V3.5+; V3.4 covers 3 cell-keyed variants -- PutValue + PutFormula + ClearFormula; SetCellFormat / RegisterFormat / RenameSheet / DeleteSheet etc. deferred).
- Live VS Code smoke test as mocha automation (out of mocha scope without `vscode-test`; user-action gap closed by § live smoke procedure below).
- Multi-window collab via `.qbook` (needs live VS Code; V3.4.0.6 deferral; § live smoke procedure includes the check).
- Presence + scroll race-guard mocha (R-V3.4-3 DEFERRED -- existing `activeInput` guard + full render cover the surface; no race-guard test to write at V3.4 scope).

#### Live smoke procedure (V3.4.0.7 user-action gap closure)

Mocha pins the V3.4 surface 228/228 but the actual VS Code webview lifecycle for undo/redo + Save As / Open + cross-window presence has not been verified at the OS level.  Extends V3.3.0.6 § 4.1.z3 procedure:

```sh
# Prerequisites: same as V3.3.0.6 § 4.1.z3 steps 1-2 (build engine cdylib;
# open IDE in Extension Development Host).

# 7. Undo/redo smoke (V3.4.0.3).
#    In the Cell Grid panel from V3.3.0.6 step 3:
#    - Edit cell A1 -> 100 -> Enter -> cell shows 100.
#    - Cmd-Z (Mac) / Ctrl-Z (Win/Linux) -> cell A1 reverts.
#    - Cmd-Shift-Z (Mac) / Ctrl-Y (Win/Linux) -> cell A1 re-applies to 100.
#    - Edit cell A1 -> start typing "200" but DON'T Enter yet.
#    - Cmd-Z WHILE mid-edit -> the typed text "200" undoes character-by-character
#      (browser text-undo); the workbook value is NOT undone.  Mid-edit guard works.
#    - Escape to cancel; Cmd-Z again -> NOW the workbook undo fires (cell A1
#      reverts from 100 to its pre-V3.4.0.3-step-7 state).

# 8. .qbook Save As smoke (V3.4.0.4a + V3.4.0.4b).
#    Cmd-Shift-P -> "Quantbook: Save As..."
#    - showSaveDialog appears with .qbook filter.
#    - Choose a path like ~/Desktop/smoke.qbook -> Save.
#    - Toast: "Quantbook saved to /Users/.../smoke.qbook".
#    - In a terminal: `ls ~/Desktop/smoke.qbook` -> directory with
#      `workbook.toml` + `oplog.bin`.

# 9. .qbook Open smoke.
#    Cmd-Shift-P -> "Quantbook: Open..."
#    - showOpenDialog appears with canSelectFolders + .qbook filter.
#    - Choose ~/Desktop/smoke.qbook -> Open.
#    - New Cell Grid panel opens on sheet 0 with the saved state restored.
#    - Output channel shows: `Opened Quantbook from /Users/.../smoke.qbook
#      (peerId=0xXXXXXXXXXXXXXXXX)` where XXXXXXXXXXXXXXXX is a fresh
#      UUID-derived 16-hex BigInt (D5 deviation -- NOT the same as the
#      saver's PeerId).

# 10. Two-window collab + presence smoke (V3.4.0.5a/b + R-V3.4-5).
#     File -> New Window (or duplicate the EDH).
#     In window 1: "Quantbook: Open Cell Grid (Collab)" -> panel opens.
#     In window 2: "Quantbook: Open Cell Grid (Collab)" -> panel opens.
#     - Both windows should connect via the relay (V3.2.c).
#     - In window 1, click cell A1 -> enter edit mode.
#       In window 2, within ~1s (pollRemote cadence), cell A1 in window
#       2's panel should gain a `.cell-peer-presence` outline (V3.4.0.5b
#       decoration).
#     - In window 1, Enter to commit "42" + click off.
#       In window 2: cell A1 outline DISAPPEARS (typing=false; clear on
#       click-off) within ~1s.  Cell A1 also updates to 42 (V3.2.c
#       propagation).
#     - In window 1, Cmd-Z to undo the "42" write.
#       Cell A1 in window 1 reverts; window 2 also sees the revert within
#       ~1s.
#     - R-V3.4-5 check: in window 1, edit cell B1 -> "999" -> Enter.
#       Then in window 1, edit cell A1 -> "100" -> Enter.
#       Cmd-Z in window 1 -> A1 reverts to its pre-100 value (NOT B1's
#       999 -- undo only retracts the local peer's last op, NOT the
#       remote op).
#     - Close window 1.  In window 2: cell A1's presence outline (if any
#       remained) should disappear within ~1s (dispose-time clearPresence).

# 11. Multi-window persistence smoke (R-V3.4-2 + D5 DEVIATION pin).
#     In a single window: "Quantbook: Open..." the smoke.qbook from step 9.
#     In the SAME window: "Quantbook: Open..." the SAME smoke.qbook
#     AGAIN.  Two panels open with the SAME data but DIFFERENT PeerIds
#     (D5 deviation -- fresh UUID per open).  Both panels can be edited
#     independently; merges happen via the engine's CRDT layer.  Cmd-Z
#     in panel A reverts panel A's last op only; the same applies to
#     panel B (R-V3.4-5 LOCAL-ONLY undo carries).
```

If smoke surfaces issues, file findings against the V3.4.0.X audit closures (see § below) or a V3.4.0.X-followup cycle.

#### V3.4.0.X cumulative megaudit closures (2026-05-24)

**Audit transcripts:** `docs/audits/2026-05-24-phase-5-7-v3-4-0-x-{codex,opus}.md`.  Both lanes returned PASS-WITH-FINDINGS.  Combined: 1 cross-lane convergent HIGH + 2 single-lane HIGHs + 6 single-lane MEDIUMs + 8 LOWs.  All 3 HIGHs + 3 of 6 MEDIUMs closed in-cycle; 3 MEDIUMs documented-defer; 8 LOWs split between in-cycle doc fixes (3) and V3.4.1+ backlog (5).

| Finding | Lanes | Severity | Closure |
|---|---|---|---|
| H1 -- `quantlab.quantbookCellGrid` sample-data path lacks `addSheet` -> `quantlab.quantbookSaveAs` fails with `session_replay -- invalid sheet` | **Codex H3 + Opus H1 (CONVERGENT)** | HIGH | IDE: `addSheet(session, 'S0'/'S1'/'S2')` seeded before sample `appendPutValueValidated` in `quantbookCommands.ts`; same fix carried to `quantlab.quantbookCellGridCollab` + `multiWindowDemo` so all session-creation entry points are Save-As-able.  Mocha pin: `Save As on sample-data session (with addSheet seeding fix) succeeds` (round-trip + reloaded cell-snapshot equality). |
| H2 -- `CellState` cache ignores `Op::BatchCommit`-nested cell ops; production `WorkbookRuntime::set_value`-over-formula emits `BatchCommit { PutValue, ClearFormula }` which `rebuild_workbook` sees but `rebuild_snapshot_cache` does not -> imported `.qbook` cells missing from IDE snapshot | Codex H1 | HIGH | Engine: hoisted `CacheEffect` enum to module scope + added `collect_cache_effects(op, out)` recursive walker (recurses into `Op::BatchCommit { ops }`) + `apply_cache_effect(snapshot, effect)` shared helper.  `append_op` (live path) and `rebuild_snapshot_cache` (full walk) both use the same helpers -> drift surface eliminated.  Mocha pin: `cell_state_batch_commit_recurses_into_cache` (both live append + from_snapshot rebuild). |
| H3 -- `addSheet(chunkRows)` napi accepts raw `u32` with no validation; JS `NaN/Infinity/negative/fractional` boundary class re-opens the panic/OOM hazard fixed for `appendPutValue` | Codex H2 | HIGH | Engine: `add_sheet` signature changed from `chunk_rows: u32` to `chunk_rows: f64` + validated through `validate_u32_index("addSheet", "chunkRows", chunk_rows)` + additional `>= 1` check (engine `WorkbookRuntime::add_sheet` rejects `chunk_rows == 0` to prevent `ColumnStore::with_chunk_rows(0)` panic).  Mocha pin: 5 bad-cases (zero / negative / NaN / Infinity / fractional) + 2 valid-boundary (default 1000 + min 1). |
| M1 -- `ClearFormula` on a formula-only cell leaves empty `CellState { value: None, formula: None }` in cache -> `list_sheets_from_cache` surfaces the sheet despite no actual content | Codex M1 | MED | Engine: `apply_cache_effect` for `CacheEffect::ClearFormula` checks `value.is_none() && formula.is_none()` after the clear and REMOVES the key entirely.  Mocha pin: `cell_state_formula_only_clear_removes_cache_key` (live + rebuild paths + sanity check that value-bearing cells survive formula clear). |
| M2 -- `endEdit(commit)` posts `putValue` then early-returns; `typing:false` broadcast block lives AFTER the early-return so remote peers stay visually "typing" until panel dispose | Codex M2 | MED | IDE: `typing:false` broadcast moved to BEFORE the `if (commit)` branch, after the `activeInput`/`activeCell` reset.  Both commit and cancel paths now broadcast typing:false.  Mocha pins: structural-ordering check (typing:false appears before if(commit)) + exactly-one occurrence check (no duplicate broadcast in cancel path). |
| M3 -- `presenceUpdate` dispatcher validates `typeof === 'number'` only; NaN/Infinity/negative/fractional/out-of-u16-or-u32-range values flow through to napi's ToUint32 coercion | Codex M3 | MED | IDE: new `validatePresenceNumeric(state): string \| null` helper in `cellGridLogic.ts` (mirrors `appendPutValueValidated` discipline; sheet `[0, 65535]`; row/col/selectionEnd* `[0, 4294967295]`; all finite + integer).  Dispatcher arm rejects with `[presenceUpdate] ${message}` -> `code: 'bad_argument'` errorReply.  Mocha pin: 10 boundary cases for the helper + 6 dispatcher-arm rejection cases. |
| M4 -- D5 deviation rationale understates cross-WINDOW collision class (dev worktrees, shared-drive mounts) | Opus M1 | MED | Docs-only deferral.  Documented in V3.4.1+ backlog: future per-workbook stash MUST address (a) per-session UUID + stash-on-first-save with prompt on second-window-open, OR (b) per-machine PeerId in `~/.config` keyed by `(workbook_uuid, machine_id)`. |
| M5 -- R-V3.4-3 deferral rationale misses local-presenceUpdate -> remote-render race (host-driven `webview.html = ...` rebuild can destroy mid-edit `<input>`) | Opus M2 | MED | Docs-only deferral promoted from DEFERRED to KNOWN-GAP in the risk register below.  V3.4.0.5c follow-up MUST add a host-level `mid-edit guard` boolean tracking `typing:true` presenceUpdate state + skip `render()` in `tickPollRemote` when set.  Not blocking V3.4.0.X close (no live-smoke complaint surfaced; user-action gap pending). |
| M6 -- `rebuild_snapshot_cache` LWW correctness depends on Loro `iter()` causal-merge order; docstring did not pin this as a SOURCE-OF-TRUTH invariant -> future Loro bump could silently break per-cell LWW | Opus M5 | MED | Engine: extended `rebuild_snapshot_cache` docstring with explicit "LWW iteration-order invariant" paragraph citing Phase 5.1 Codex V1 audit + flagging the future-Loro-bump audit-trigger surface.  Doc-only (no code change). |
| L1 -- `fromQbook` napi + `sessionFromQbook` IDE wrapper docstrings still mention "stored-previously" / per-workbook stash language | Codex L1 + Opus M1 (related) | LOW | Engine + IDE: rewrote both docstrings to describe the V3.4.0.4b D5 DEVIATION reality (fresh-UUID-per-session via `crypto.randomUUID()`; no stash exists). |
| L2 -- `generateUuidPeerId` docstring overstates entropy as ~64 bits / ~2^32 collision; reality is ~60 bits / ~2^30 (UUIDv4 version nibble `4` at hex-char position 12 is deterministic) | Codex L2 + Opus M3 | LOW | IDE: rewrote `generateUuidPeerId` docstring with the bit-48 deterministic-nibble analysis + corrected entropy claims.  All-zero retry-loop rationale updated to "defense against non-spec `crypto.randomUUID`" (spec-compliant UUIDv4 cannot produce all-zero truncation). |
| L3 -- napi persistence error tests don't pin `qbook_unsupported_version` / `qbook_truncated_header` codes | Codex L3 | LOW | Deferred to V3.4.1+ backlog.  `ql-io` already has lower-level tests for these envelope states; binding-level coverage adds marginal value at significant test scaffolding cost (corrupt-oplog.bin fixture).  Track in `.plans/v3-4-1-backlog.md` (TBD). |
| L4-L8 (5x Opus LOWs) -- `PresenceStateJson` lacks `#[non_exhaustive]` / hardcoded "quantbook" workbook name / UUID BigInt allocation per attempt / clearPresence dispose try/catch policy / presenceUpdate u16/u32 range checks (already covered by M3 closure) | Opus L1-L5 | LOW | All deferred to V3.4.1+ backlog (polish; not blocking). |

**Closure surface (engine + IDE):**

- **Engine (ql-collab/src/session.rs)**: `CacheEffect` enum hoisted to module scope; `collect_cache_effects(&Op, &mut Vec<CacheEffect>)` recursive walker; `apply_cache_effect(snapshot, effect)` shared mutator with formula-only-key removal.  `rebuild_snapshot_cache` docstring extended with LWW iteration-order invariant.  +2 ql-collab unit tests (79 -> 81): `cell_state_formula_only_clear_removes_cache_key` + `cell_state_batch_commit_recurses_into_cache`.
- **Engine (ql-bindings-node/src/lib.rs)**: `add_sheet` signature `u32` -> `f64` + `validate_u32_index` + `>= 1` check.  `fromQbook` docstring rewrite (D5 deviation reflection).
- **IDE (`extensions/quantlab/src/commands/quantbookCommands.ts`)**: `addSheet` import + 3-call seed before `quantlab.quantbookCellGrid` sample data; 1-call seed before `quantlab.quantbookCellGridCollab` panel; 1-call seed before `multiWindowDemo` peer A.
- **IDE (`extensions/quantlab/src/quantbook/cellGrid/cellGridHtml.ts`)**: `endEdit(commit)` -- moved typing:false broadcast above the if(commit) branch.
- **IDE (`extensions/quantlab/src/quantbook/cellGrid/cellGridLogic.ts`)**: new exported `validatePresenceNumeric` + dispatcher-arm integration.
- **IDE (`extensions/quantlab/src/quantbook/session.ts`)**: `sessionFromQbook` JSDoc + `generateUuidPeerId` JSDoc rewrites.
- **IDE mocha tests (`extensions/quantlab/test/quantbook-roundtrip.test.ts`)**: +26 V3.4.0.X tests (228 -> 254) across 5 suites: validatePresenceNumeric (10) + dispatcher numeric rejection (6) + commit broadcast pin (2) + BatchCommit IDE round-trip pin (1) + addSheet chunkRows validation (7).

**Rule 4 arc terminus:** HELD at 6 throughout the V3.4.0.X closures.  No new Rust types introduced; the `CacheEffect` enum is a private cache-update DTO with no trait obligations beyond `enum { (u16,u32,u32), CellWireValue, String }` primitives (trivially `Send + Sync` per Opus Lane B walk).  All closures preserve the V3.4 surface contracts (napi shape unchanged; cache invariants preserved; D5 fresh-UUID-per-session semantics intact).

**R-V3.4-3 RECLASSIFIED + CLOSED**: was DEFERRED at V3.4.0.5b; promoted to KNOWN-GAP at V3.4.0.X via Opus M2; **CLOSED at V3.5.0.7** via host-level `_presenceRepaintInFlight` boolean + 30s watchdog + tickPollRemote merged-branch skip.  The race surface (two-window collab: window 1 mid-edit + window 2 commit -> window 1's `webview.html` rebuild destroys mid-edit `<input>`) is now guarded at the host layer.  Dispatcher's `onLocalTyping` callback fires AFTER `updatePresence` succeeds so the host flag stays in sync with engine state.  9 mocha tests pin the dispatcher contract; live two-window smoke verification is part of V3.5.0.9 § 4.1.z5 procedure.

### 4.1.z5 WorkbookSnapshot + sheet ops + format extension + partial-invalidate undo + mid-edit-render guard (Phase 5.7 V3.5, 2026-05-24)

**Status:** V3.5.0.1 decision lock + V3.5.0.2 WorkbookSnapshot napi (D3) + V3.5.0.3 D4 sheet-ops suite (a renameSheet + b deleteSheet/Op::RemoveSheet + c moveSheet/Op::MoveSheet) + V3.5.0.4a IDE sheet management commands + V3.5.0.4b cell-grid render migration to workbookSnapshot + V3.5.0.5 CellState.format extension (D1) + V3.5.0.6 partial-invalidate undo (D2) + V3.5.0.7 IDE mid-edit-render guard (D5 / R-V3.4-3 KNOWN-GAP CLOSED) + V3.5.0.9 (this section's commit) all shipped.  V3.5.0.4c sheet-tabs UI scaffold REMAINS PENDING (may defer to V3.5.1+ -- multi-sheet UX adequately covered by Command Palette commands + reactive title).  V3.5.0.X parallel Codex+Opus megaudit (phase termination) pending.

**Engine HEAD trail**: `48be1878db5` (0.1 lock) -> `bbd129ed629` (0.2 WorkbookSnapshot napi) -> `74aa5039e04` (0.3a renameSheet) -> `9be3672ca01` (0.3b deleteSheet + Op::RemoveSheet tombstone) -> `7ec7877a018` (0.3c moveSheet + Op::MoveSheet display-order overlay) -> `fa7541f1e8d` (V3.5 deep-audit closures) -> `1be56176fd2` (0.4a IDE-only plan) -> `75963628c54` (0.4b IDE-only plan) -> `175258f4dd0` (0.5 CellState format extension) -> `1bd21296f31` (0.6 partial-invalidate undo) -> `bf443957d3b` (0.7 plan + R-V3.4-3 closure update).  **IDE HEAD trail**: `299fed5eda9` (0.2 types + wrapper) -> `5ad934d087f` (0.3a) -> `91a6b3870bd` (0.3b) -> `e3642ef3458` (0.3c -- closes D4) -> `8fecc25c03f` (0.4a sheet management commands) -> `0d4659e62d6` (0.4b render migration + reactive title) -> `0b6a6481a14` (0.5 FormatIdJson + format passthrough) -> `650e7ea6c3e` (0.7 mid-edit-render guard).

#### V3.5.0.1 -- decision lock (5 D-decisions)

Per V3.4.0.X Opus § F V3.5 ENTRY READINESS analysis:

| Decision | Choice | Sub-step |
|---|---|---|
| **D1** CellState format extension | Per-cell `format: Option<FormatId>` on existing `CellState`; defer session-wide RegisterFormat FormatTable cache + format-aware buildHtml rendering to V3.6+ | V3.5.0.5 |
| **D2** Partial-invalidate undo | New `invalidate_cell(sheet, row, col)` + classifier-driven dispatch; full-rebuild fallback for non-cell-keyed retracts; architectural shape ships V3.5.0.6 (per-cell op-index for true O(ops-for-this-cell) deferred to V3.6+) | V3.5.0.6 |
| **D3** WorkbookSnapshot napi shape | Flattened `WorkbookSnapshotJson { sheets: Vec<SheetSnapshotJson> }` (chosen over mirroring full `ql-storage::Workbook` across FFI -- pre-shaped for IDE renderer; matches V3.4.0.5a PresenceStateJson pattern) | V3.5.0.2 |
| **D4** Sheet ops (rename/delete/move) | Split into 0.3a (renameSheet -- existing `Op::RenameSheet`) + 0.3b (deleteSheet + new `Op::RemoveSheet` tombstone semantic) + 0.3c (moveSheet + new `Op::MoveSheet` display-order overlay) | V3.5.0.3a/b/c |
| **D5** Mid-edit-render guard | Host-level `_presenceRepaintInFlight: boolean` on CellGridPanel + 30s watchdog + tickPollRemote merged-branch skip + DispatchDeps.onLocalTyping callback fires AFTER updatePresence succeeds; closes R-V3.4-3 KNOWN-GAP | V3.5.0.7 |

#### V3.5.0.2 -- WorkbookSnapshot napi (D3)

New engine napi method `CollabSession::workbook_snapshot() -> Result<WorkbookSnapshotJson>`:

```ts
class CollabSession {
  // V3.5.0.2 -- flattened JSON-serializable view of the full workbook.
  // Routes through inner.rebuild_workbook(&default_registry()) for
  // sheet metadata + uses V3.3.0.3/V3.4.0.2 incremental cache via
  // snapshot_cells(sheet_id) for cell content.  The rebuilt Workbook
  // is DISCARDED after sheet count + names extraction -- IDE-side
  // Workbook consumption stays V3.6+ scope.
  workbookSnapshot(): WorkbookSnapshotJson;
}

// V3.5.0.5 EXTENDED: per-cell format passthrough added to CellSnapshotJson.
interface WorkbookSnapshotJson {
  sheets: SheetSnapshotJson[];
  // V3.6+: names: NamedRangeJson[]; formats: FormatDefJson[]
}

interface SheetSnapshotJson {
  id: number;     // u16 SheetId widened (0..65535 fits in JS number)
  name: string;   // display name (carries latest RenameSheet effect)
  cells: CellSnapshotJson[];  // sorted (row, col) ascending
}

interface CellSnapshotJson {
  row: number;
  col: number;
  // napi-rs Option::None -> ABSENT JS property (undefined, NOT null)
  value?: CellValueJson;
  formula?: string;
  format?: FormatIdJson;  // V3.5.0.5 addition
}

interface CellValueJson {
  kind: 'number' | 'boolean' | 'text' | 'error' | 'pending';
  // Discriminate on `kind`; non-active payload fields are ABSENT
  number?: number;
  boolean?: boolean;
  text?: string;
  error?: string;
}

// V3.5.0.5 NEW
interface FormatIdJson {
  kind: 'builtin' | 'custom';
  builtin?: number;          // u32 when kind='builtin'
  customPeer?: bigint;       // u64 widened when kind='custom'
  customCounter?: number;    // u32 when kind='custom'
}
```

**Per-call cost (R-V3.5-1)**: `workbookSnapshot` is O(N) in op count (rebuild_workbook replay).  IDE callers MUST batch (do NOT call per-keystroke).  V3.5.0.4b cell-grid render() fires per onCommit (cell edit) + per pollRemote tick (~1s) -- accepted at V3.4-scale; V3.6+ may add incremental snapshot deltas.

**Empty addSheet'd sheets DO appear** in `sheets[]` with `cells: []` (V3.5.0.2 enumerates via `Workbook::sheet_count()` post-rebuild, NOT via `list_sheets_from_cache`).  Differs from `listSheets()` which is cache-based and only surfaces sheets with PutValue ops.

**Tombstone filter** (V3.5.0.3b carry): tombstoned sheets are SKIPPED in the returned snapshot (the IDE renderer doesn't see deleted sheets).  Filter applied AFTER display-order resolution (V3.5.0.3c carry) so a tombstoned-then-moved sheet is correctly omitted.

**Rule 4 per-field walk**: `sheets: Vec<SheetSnapshotJson>` Send+Sync via Vec composition over SheetSnapshotJson (id: u32 primitive + name: String + cells: Vec<CellSnapshotJson>); CellSnapshotJson over u32 + Option<CellValueJson> + Option<String> + Option<FormatIdJson>; CellValueJson kind: String + 4 Option payloads (all Send+Sync trivially); FormatIdJson kind: String + Option<u32> + Option<BigInt(=Vec<u64>+sign)> + Option<u32>.  **0 new Rule 4 triggers; arc terminus stays at 6.**

#### V3.5.0.3 D4 -- sheet operations suite (renameSheet + deleteSheet + moveSheet)

SPLIT into 3 sub-sub-steps per scope discovery: only `Op::RenameSheet` exists pre-V3.5 (Phase 4.6.C / 5.3 prior art); `Op::RemoveSheet` + `Op::MoveSheet` are new and require CRDT semantic locks.

**V3.5.0.3a renameSheet**:

```ts
class CollabSession {
  renameSheet(id: number, newName: string): void;
}
```

Thin napi wrapper appending existing `Op::RenameSheet { id, old_name, new_name }`.  Pre-rebuilds workbook to capture current sheet name as advisory `old_name` (per Phase 5.3 step 2 Codex M2; recorded for debuggability + future strict-mode replay).  **Contract divergence from `WorkbookRuntime::rename_sheet`**: napi does NOT rewrite formula text -- formula references to the old sheet name stay stale in the cache until next `workbookSnapshot` / `exportToQbook` call triggers `rebuild_workbook` -> `repair_sheet_rename_chain` (Phase 5.3 step 3).  Acceptable for V3.5.0.3a scope because IDE flow always reads through workbookSnapshot.

**V3.5.0.3b deleteSheet + Op::RemoveSheet (CRDT semantic = tombstone preserving id slot)**:

```ts
class CollabSession {
  deleteSheet(id: number): void;
}
```

New wire variant `Op::RemoveSheet { id: SheetId }` (serde-tagged additive; no `OPLOG_SCHEMA_VERSION` bump).  CRDT semantic chosen: **tombstone preserving id slot** (rejected hard-delete because it would shift subsequent sheet ids + break post-delete `Op::PutValue { sheet: N, .. }` references; rejected `#REF!` formula substitution -- V3.6+ if user-feedback requires).  New `Workbook.removed_sheets: HashSet<SheetId>` field + `remove_sheet(id)` + `is_sheet_removed(id)` accessors.

**Idempotent under concurrent delete**: HashSet semantics; re-delete is replay no-op.  **Writes to tombstoned sheet silently dropped**: cell-keyed apply_op handlers (PutValue/PutFormula/ClearFormula) extended with `if workbook.is_sheet_removed(*sheet) { return Ok(()) }` short-circuit AFTER `validate_cell`.  Concurrent {PutValue, RemoveSheet} ordering: PutValue first -> writes then tombstones (cell unreachable via snapshot); RemoveSheet first -> PutValue silently dropped.  Deterministic Loro causal-merge order converges peers.

**Already-tombstoned NOT bad_argument**: CRDT idempotency contract -- second delete is replay no-op.

**Forward-compat caveat** (V3.5 deep-audit closure): pre-V3.5.0.3b binaries reading V3.5.0.3b+ saved .qbook files with `Op::RemoveSheet` instances WILL fail deserialization with `OpLogError::Deserialize` (serde `tag = "kind"` rejects unknown variant tags; no `#[serde(other)]` catch-all on this enum).  Same forward-compat property as every historical Op variant addition -- if forward-compat for older readers becomes a product concern, ship a schema-version bump + migrator AS A SEPARATE PHASE; do NOT retrofit individual Op additions.

**V3.5.0.3c moveSheet + Op::MoveSheet (CRDT semantic = display-order overlay)**:

```ts
class CollabSession {
  // newIndex out-of-range clamps to end (CRDT idempotency).
  moveSheet(id: number, newIndex: number): void;
}
```

New wire variant `Op::MoveSheet { id: SheetId, new_index: u32 }`.  CRDT semantic: **display-order overlay** (mirrors V3.5.0.3b tombstone's id-stability strategy).  New `Workbook.sheet_display_order: Vec<SheetId>` field (defaults to `[0, 1, ..., sheet_count() - 1]` in append order via `try_add_sheet_with_chunk_rows` hook).  Sheet ids in `Workbook.sheets` stay STABLE; only display order mutates -- subsequent ops referencing the moved sheet by id keep landing on the correct sheet.

**`workbook_snapshot` iterates display order** (V3.5.0.3c carry): replaces `0..sheet_count()` with `sheet_display_order().to_vec()`; defensive fallback enumerates missing ids at end (resilient against future engine-internal bugs that bypass `try_add_sheet_with_chunk_rows`).

**Move-tombstoned-sheet silently applies**: display order remembers user's reorder intent even for deleted sheets (snapshot filter applied separately).  **Move-non-existent-sheet silently no-ops**: cross-peer causal-merge friendly (peer might see MoveSheet for an id whose AddSheet hasn't replayed locally; eventual causal order rectifies).

**D4 SHEET-OPS SUITE COMPLETE** at V3.5.0.3c.  +32 cumulative mocha tests across 0.3a (+8) / 0.3b (+11) / 0.3c (+13).  Rule 4 arc terminus held at 6 throughout: HashSet<SheetId> + Vec<SheetId> primitive composition; 0 new triggers.

#### V3.5.0.4 -- IDE WorkbookSnapshot consumption + sheet management UI

SPLIT into 3 sub-sub-steps; 0.4a + 0.4b shipped; 0.4c (sheet-tabs UI scaffold) pending (may defer to V3.5.1+).

**V3.5.0.4a sheet management commands**: 4 new vscode commands wrapping V3.5.0.3 sheet ops:

| Command | UI flow | Calls |
|---|---|---|
| `quantlab.quantbookSheetAdd` | showInputBox (non-empty validation) | `addSheet(session, name, 1000)` |
| `quantlab.quantbookSheetRename` | showQuickPick (over `workbookSnapshot.sheets`) + showInputBox (non-empty + different-from-current validation) | `renameSheet(session, id, newName)` |
| `quantlab.quantbookSheetDelete` | showQuickPick + `showWarningMessage { modal: true }` confirm with destructive-warning copy | `deleteSheet(session, id)` |
| `quantlab.quantbookSheetMove` | 2-step picker: showQuickPick source + showQuickPick target position with adjacency labels (`(first)` / `(last)` / `(between Sheet X and Sheet Y)`) | `moveSheet(session, id, newIndex)` |

All 4 follow V3.4.0.4b Save As pattern: `panels[0]` arbitrary-pick from `CellGridPanel.activeLocalPanels()`; try/catch with `showErrorMessage` + output channel logging.  2 new pure helpers in `cellGridLogic.ts`: `buildSheetManagementQuickPickItems(sheets, currentSheet)` + `buildSheetMovePositionItems(sheets, sourceSheetId)`.

**V3.5.0.4b cell-grid render migration**: `cellGridPanel.ts::render()` now calls `workbookSnapshot(this.session)` instead of `exportSnapshot(this.sheet)`.  New pure helper `extractSheetSnapshot(snapshot, sheetId): QuantbookCellSnapshot | null` in `cellGridLogic.ts` bridges V3.5.0.2 `WorkbookSnapshotJson` -> V3.2.a `QuantbookCellSnapshot` (preserves `buildHtml` contract).  Option (i) minimal-change scope (preserves panel-per-sheet V3.3.0.1 D2 semantic).

**Key behaviors enabled**:
- V3.5.0.4a sheet ops (rename/delete/move) reflect IMMEDIATELY in render (no pollRemote tick wait)
- **Reactive panel title** (clears V3.3.0.X reactive-panel-title backlog): render() sets `this.panel.title` each call using `wbSnapshot.sheets.length` -- counts addSheet'd-but-empty sheets + includes the active sheet's name
- **Sheet-not-found tombstone-race fallback**: if user runs Delete Sheet on `this.sheet` while panel is open, `extractSheetSnapshot` returns null; render() falls back to empty entries + `console.warn` (No-Fallbacks tension acknowledged in docstring -- the alternative is a permanent red error banner; empty + warn is the lesser evil)
- **extractSheetSnapshot skips formula-only cells** (V3.4.0.X MEDIUM-1 carry: matches `export_snapshot`'s `filter_map(state.value)` behavior); throws `[bad_argument]` on unknown CellValueJson kind (binding-drift signal)

**V3.5.0.4c sheet-tabs UI scaffold deferral**: V3.5.0.4a+b cover multi-sheet UX via Command Palette + reactive title; sheet-tabs strip would be polish (faster sheet switching) but NOT a correctness gap.  Defer to V3.5.1+ if user signal surfaces; otherwise folds into V3.6+ multi-tab redesign.

#### V3.5.0.5 -- CellState format extension (D1)

`CellState` extended with `format: Option<FormatId>` field.  Per-cell `Op::SetCellFormat` cache integration ships; **session-wide RegisterFormat FormatTable cache + format-aware buildHtml rendering DEFERRED to V3.6+** (per-cell format is the minimum surface to unblock format-aware rendering; session-wide registry is a larger design that would surface in `WorkbookSnapshotJson.formats: Vec<FormatDefJson>`).

**Per-field LWW semantics** (extends V3.4.0.2):
- `Op::PutValue` writes `state.value`, preserves `formula` + `format`
- `Op::PutFormula` writes `state.formula`, preserves `value` + `format`
- `Op::ClearFormula` clears `state.formula`, preserves `value` + `format`
- **`Op::SetCellFormat { id: Some(_) }` writes `state.format`**, preserves `value` + `formula` (V3.5.0.5 new)
- **`Op::SetCellFormat { id: None }` clears `state.format`**, preserves `value` + `formula` (W5-80 "clear overlay" semantic)

A cell can carry ANY combination of (value, formula, format).

**Ghost-entry-avoidance extended** (V3.4.0.X MEDIUM-1 carry): the all-fields-None check now includes format -- `(value && formula && format).is_none()` triggers cache key removal.  Without this extension, a `SetCellFormat { id: None }` on a never-written cell would leave a phantom cache entry that surfaces in `list_sheets_from_cache`.

**Engine implementation**: new `CacheEffect::SetCellFormat { key, format: Option<FormatId> }` variant.  `collect_cache_effects` emits the new variant on `Op::SetCellFormat` (converts wire `FormatIdWire` -> storage `FormatId` via lossless `to_storage()`); BatchCommit recursion carries.  `apply_cache_effect` for SetCellFormat: `Some(_)` -> `entry().or_default().format = Some(id)`; `None` -> `get_mut + skip-if-absent` (mirrors ClearFormula's ghost-entry-avoidance).

**napi surface**: new `#[napi(object)] FormatIdJson` struct (tagged-union mirror: kind String + optional builtin u32 + optional custom_peer BigInt + optional custom_counter u32); `impl From<FormatId> for FormatIdJson` handles both variants losslessly (PeerId.0 widened to BigInt via `BigInt::from`).  `CellSnapshotJson` extended with `format: Option<FormatIdJson>` field.  `workbook_snapshot` threads `state.format.map(FormatIdJson::from)` through.

**IDE side V3.5.0.5 scope is PASSTHROUGH ONLY**: `extractSheetSnapshot` deliberately DROPS format (V3.2.a `QuantbookCellSnapshot` has no format field; `buildHtml` not format-aware until V3.6+).  The field round-trips through `workbookSnapshot` for V3.6+ format-aware rendering.

**Rule 4 per-field walk on extended CellState**: `format: Option<FormatId>` where `FormatId = Builtin(u32) | Custom(PeerId, u32)`; `PeerId(pub u64)` -- all primitives + Copy + Send + Sync trivially.  Composition: `FormatId: Send + Sync + Copy` (enum of all-Copy variants).  `Option<FormatId>`: Send + Sync.  `CellState` with format field: composition stays Send+Sync.  **No new Rule 4 trigger**; arc terminus stays at 6.  FormatIdJson napi struct also positive walk.

#### V3.5.0.6 -- partial-invalidate undo (D2)

New `invalidate_cell(&mut self, sheet, row, col) -> Result<(), CollabSessionError>` pub(crate) method on CollabSession.  Drops the cell entry, walks the op log applying ONLY effects targeting `(sheet, row, col)` via existing `collect_cache_effects` + `apply_cache_effect` helpers (BatchCommit recursion + ghost-entry-avoidance carry; V3.5.0.5 SetCellFormat variant integrated).

New `affected_cells_for_partial_invalidate(op) -> Option<Vec<(u16,u32,u32)>>` classifier:
- Returns `Some(deduped+sorted cells)` for cell-keyed ops (PutValue / PutFormula / ClearFormula / SetCellFormat) OR BatchCommit of only-cell-keyed inner ops
- Returns `None` for non-cell-keyed (AddSheet / RenameSheet / RemoveSheet / MoveSheet / RegisterFormat / table ops / mixed BatchCommit) -- conservative fallback signal

**undo/redo dispatch refactored**: captures most-recent visible op BEFORE retract (undo) / AFTER append (redo); if log size changed by exactly 1 AND captured op is cell-keyed, calls `invalidate_cell` per affected cell; otherwise falls back to `rebuild_snapshot_cache` (preserves V3.3.0.X HIGH-1 closure guarantee).  Loro `UndoManager` retracts the most-recent local op + visible log shrinks by exactly 1 (pinned by existing `undo_retracts_visible_op_from_op_log_len`); when no remote op landed after the local op, the most-recent visible op IS the to-be-retracted op.  Shrinkage-by-exactly-1 check defensively falls back to full rebuild in the mixed-remote-ops case.

**Cost story (V3.5.0.6 ship)**: `invalidate_cell` walks the full log (O(N)) but writes ONE HashMap entry vs full rebuild's O(N) walk + O(cells) writes.  **Real performance win** (avoiding the full walk) needs a per-cell op-index that V3.5.0.6 does NOT add -- V3.6+ scope.  V3.5.0.6 ships the **architectural shape**:
1. Cleaner semantics: undo touches specific cells, not the whole cache
2. Foundation for V3.6+ per-cell op-index + incremental snapshot deltas
3. Cells unaffected by the undo retain their existing CellState entries (byte-identical preserved -- pinned by mocha)

**Side-by-side equality pin** (correctness invariant): for every supported op shape, partial-invalidate post-undo cache EQUALS the forced-full-rebuild post-undo cache.  Mocha covers PutValue / PutFormula / ClearFormula / SetCellFormat / BatchCommit cell-keyed / AddSheet fallback / redo dispatch / multi-cell BatchCommit.

#### V3.5.0.7 -- IDE mid-edit-render guard (D5 / R-V3.4-3 KNOWN-GAP CLOSED)

Closes R-V3.4-3 (DEFERRED at V3.4.0.5b -> KNOWN-GAP at V3.4.0.X via Opus M2 -> CLOSED at V3.5.0.7).  The race: a host-driven `webview.html = ...` rebuild during the user's mid-edit `<input>` lifetime destroys the in-progress input element.  Reproducible in two-window collab smoke: window 1 mid-edit + window 2 commit -> window 1's pollRemote-merged tick fires render() -> webview.html reassign destroys the `<input>`.

**Engine-side**: no changes -- closure is fully IDE-side.

**IDE-side `cellGridPanel.ts` changes**:
- New `_presenceRepaintInFlight: boolean` field (init false; reset to false on dispose via `setPresenceTyping(false)`)
- New `PRESENCE_TYPING_WATCHDOG_MS = 30_000` constant (tunable; lower bound = longest legitimate cell edit; consider 60s if formula entry surfaces in user feedback)
- New private `presenceTypingWatchdog: ReturnType<typeof setTimeout>` handle
- New public `setPresenceTyping(typing: boolean)` method -- atomic flag set + watchdog arm/cancel.  **Stuck-true mitigation**: `setTimeout` auto-clears flag after 30s + logs via attachment's output channel (covers panel-hung / window-closed-mid-edit / webview-crash edge cases)
- `tickPollRemote` `'merged'` branch checks `_presenceRepaintInFlight` BEFORE `this.render()`; when true, logs `SKIPPING render (presenceRepaintInFlight; local user mid-edit). Will retry on next tick.` + returns.  Deferred render fires on next 1s pollRemote tick once typing:false arrives; merged op stays in engine cache so no data loss
- `handleIncoming` wires `onLocalTyping -> setPresenceTyping` with `_disposed` short-circuit
- `onDidDispose` calls `setPresenceTyping(false)` to cancel any pending watchdog

**IDE-side `cellGridLogic.ts` changes**:
- `DispatchDeps` gains optional `onLocalTyping?(typing: boolean): void` callback (optional for backward compat with V3.4.0.X + V3.5.0.5 tests)
- `presenceUpdate` dispatcher arm fires `deps.onLocalTyping?(s.typing)` **AFTER** `session.updatePresence` succeeds.  Shape-validation + numeric-validation failures + engine throws DON'T fire -- host flag stays in sync with engine state

**Why "after updatePresence succeeds"**: if updatePresence throws (engine-level failure), we DON'T toggle the host flag -- the engine never received the state; the webview would see the stale prior presence; the host should match.  Only the LOCAL peer's presenceUpdate (typing field) maps to the host flag -- remote peers' typing state is observed via the per-cell `data-peer` decoration in the webview (V3.4.0.5b), which does NOT block this panel's merged-tick render.

#### Drift hazards (V3.6+ maintainers)

- **CellState shape evolution beyond V3.5.0.5**: future Op variants that carry per-cell state (e.g., per-cell validation rule, per-cell comment) MUST: (1) add a new field to `CellState` with Rule 4 per-field walk in the docstring; (2) extend the `CacheEffect` enum with the corresponding new variant; (3) extend `collect_cache_effects` to recurse on the new Op; (4) extend `apply_cache_effect` to handle the new variant; (5) **EXTEND the all-fields-None ghost-entry-avoidance check** in `ClearFormula` + `SetCellFormat { id: None }` branches (currently `value.is_none() && formula.is_none() && format.is_none()`); (6) extend `affected_cells_for_partial_invalidate` to recognize the new cell-keyed variant.
- **Adding new Op cell-keyed variants** REQUIRES the same 6-step extension above; missing any step causes partial-invalidate to fall back to full-rebuild silently (correctness preserved but performance degrades) OR ghost cache entries (functional bug).
- **WorkbookSnapshotJson shape additions** (V3.6+ may add `names: NamedRangeJson[]` + `formats: FormatDefJson[]`): keep ADDITIVE (no field removal / rename); V3.5 IDE consumers that destructure `.sheets` only continue working through the addition.  Rule 4 per-field walk REQUIRED on each new struct.
- **Per-cell op-index for true O(ops-for-this-cell) invalidate_cell** (V3.6+ deferral): maintaining a `HashMap<(sheet, row, col), Vec<usize>>` mapping cell coord -> op-log indices that touch it.  Updated incrementally in `append_op` per emitted CacheEffect.  Rebuilt during `from_snapshot` + `merge_bytes`.  invalidate_cell looks up the index instead of walking the full log -> O(ops-for-this-cell).  Memory cost: ~24 bytes per indexed op-cell pair; manageable at typical session sizes.
- **Loro UndoManager `on_pop` callback wiring** (V3.6+ deferral): would surface the retracted op shape directly via the UndoManager API, eliminating the V3.5.0.6 peek-most-recent-visible-op + shrink-by-1 heuristic.  Cleaner + handles the mixed-remote-ops case correctly without conservative fallback.
- **Mid-edit-render guard watchdog tuning**: `PRESENCE_TYPING_WATCHDOG_MS = 30_000` is tunable.  If formula entry (multi-second edits with intermittent typing) surfaces stuck-true reports in production, increase to 60s OR add typing-stroke-based refresh (any typing keystroke resets the watchdog).  Currently the watchdog fires 30s after the initial `typing: true`, NOT 30s of inactivity.
- **DispatchDeps.onLocalTyping is optional**: V3.4.0.X + V3.5.0.5 mocha tests don't pass it.  Future tests that DO want to exercise the guard MUST pass `onLocalTyping`; tests that DON'T care can omit.

#### V3.5 risk register (post-implementation reality)

- **R-V3.5-1 WorkbookSnapshot O(N) per-call cost** -- DOCUMENTED.  `workbookSnapshot` routes through `rebuild_workbook` (O(N) replay); fires per onCommit + per pollRemote tick (~1s).  V3.4-scale accepted; V3.6+ may add incremental snapshot deltas if profiling justifies.  IDE callers MUST batch (do NOT call per-keystroke).
- **R-V3.5-2 Partial-invalidate per-cell-op-index deferral** -- DOCUMENTED.  V3.5.0.6 ships the architectural shape but `invalidate_cell` still walks the full log (O(N)).  V3.6+ scope: per-cell op-index would make invalidate_cell O(ops-for-this-cell).
- **R-V3.5-3 Sheet-tabs UX gap (V3.5.0.4c not shipped)** -- ACCEPTED.  Multi-sheet UX adequately covered by V3.5.0.4a Command Palette commands (Add/Rename/Delete/Move Sheet) + V3.5.0.4b reactive panel title; sheet-tabs strip would be polish (faster switching) but NOT a correctness gap.  V3.5.1+ if user signal surfaces; otherwise folds into V3.6+ multi-tab redesign.
- **R-V3.5-4 Format-aware rendering deferral** -- DOCUMENTED.  V3.5.0.5 ships per-cell format passthrough but `buildHtml` does NOT render format-aware cells (no number format / date / currency interpretation).  V3.6+ scope.
- **R-V3.5-5 Session-wide format registry deferral** -- DOCUMENTED.  `Op::RegisterFormat` is NOT integrated with the V3.4.0.2 cache (would need a separate session-wide FormatTable cache + new `WorkbookSnapshotJson.formats: Vec<FormatDefJson>` field).  V3.6+ scope when format-UI write-path (`appendSetCellFormat` napi + commands) lands.
- **R-V3.5-6 Cross-restart PeerId reuse (R-V3.3-5 carryforward)** -- CLOSED at V3.4.0.4b via fresh-UUID-per-session (D5 deviation; documented in § 4.1.z4).
- **R-V3.5-7 Mid-edit-render guard watchdog correctness** -- DOCUMENTED.  30s `PRESENCE_TYPING_WATCHDOG_MS` is the V3.5.0.7 ship default.  Stuck-true conditions (panel-hung / window-closed-mid-edit / webview-crash) auto-clear after 30s with logged warning.  Tunable if user feedback surfaces.

#### Out of scope for V3.5

- **Sheet-tabs UI scaffold** (V3.5.0.4c -- may defer to V3.5.1+; folds into V3.6+ multi-tab redesign if not shipped standalone)
- **Format-aware buildHtml rendering** (V3.6+; number / date / currency / etc. format interpretation)
- **Session-wide RegisterFormat FormatTable cache** (V3.6+; would surface in `WorkbookSnapshotJson.formats: Vec<FormatDefJson>`)
- **Format-UI write-path** (V3.6+; napi `appendSetCellFormat` + commands like `quantbookSetCellFormat`)
- **Per-cell op-index for O(ops-for-this-cell) invalidate_cell** (V3.6+; requires `HashMap<(sheet, row, col), Vec<usize>>` maintained in append_op + rebuilt on from_snapshot/merge_bytes)
- **Loro UndoManager `on_pop` callback wiring** (V3.6+; would surface retracted-op shape directly; cleaner than V3.5.0.6 peek-most-recent heuristic)
- **#REF! formula substitution for cross-sheet refs to deleted sheets** (V3.6+; extends repair_sheet_rename_chain)
- **Op::RestoreSheet un-delete** (V3.6+ if user-facing flow justified; cell storage preserved internally but no surface)
- **Reclamation pass for orphaned sheet storage** (V3.6+; compact tombstoned-sheet storage once op log purged of references)
- **Per-peer display-order overlay** (V3.6+ if peer-specific reorder preferences become concern; today display order is shared canonical)
- **Display-order undo** (V3.5.0.6 partial-invalidate doesn't handle Op::MoveSheet -- non-cell-keyed; falls back to full rebuild which correctly inverts display order; specific testing TBD)
- **vscode-test command-flow integration tests** (V3.5.1+; today's mocha covers pure helpers + napi contract; command-level wiring needs vscode-host)

#### Live smoke procedure (V3.5.0.9 user-action gap closure)

Mocha pins the V3.5 surface at 346/346 IDE tests + 106/106 ql-collab.  Extends V3.4.0.7 § 4.1.z4 steps 7-11 with V3.5-specific verification:

```sh
# Prerequisites: same as V3.4.0.7 § 4.1.z4 steps 1-2 (build engine
# cdylib; open IDE in Extension Development Host).

# 12. Sheet management commands smoke (V3.5.0.4a + V3.5.0.X A-HIGH-3 closure).
#     **V3.5.0.X audit-closure A-HIGH-3 (2026-05-24)**: all 4 commands
#     now call CellGridPanel.refreshAll() after success; pre-closure
#     the panels did NOT update until a subsequent user action.
#     Output channel log lines should include "refreshed N panel(s)".
#     In the Cell Grid panel:
#     - Cmd-Shift-P -> "Quantbook: Add Sheet..." -> enter "Q4Returns"
#       -> Enter.  Toast: 'Sheet "Q4Returns" added.'  Output:
#       'Added sheet "Q4Returns" to session; refreshed 1 panel(s).'
#     - Cmd-Shift-P -> "Quantbook: Rename Sheet..." -> select an
#       existing sheet -> enter a different name -> Enter.  Toast +
#       (V3.5.0.4b reactive title) panel title updates IMMEDIATELY
#       (the refreshAll() call triggers render() which re-reads
#       workbookSnapshot + the V3.5.0.X A-HIGH-2 closure surfaces
#       the renamed sheet's repaired formulas; see step 15).
#     - Cmd-Shift-P -> "Quantbook: Move Sheet..." -> 2-step picker:
#       select source sheet, then select target position with adjacency
#       labels.  Snapshot reordering reflects in title's sheet-count
#       sequence (visible immediately via refreshAll).
#     - Cmd-Shift-P -> "Quantbook: Delete Sheet..." -> select a
#       sheet to delete -> showWarningMessage modal "Delete sheet N
#       (Name)?  This cannot be undone..." -> click "Delete".  Sheet
#       count in title decrements immediately; if the deleted sheet
#       was the active panel's sheet, panel shows empty cells +
#       console.warn (sheet-not-found tombstone-race fallback per
#       V3.5.0.4b).

# 13. Cell-grid render migration smoke (V3.5.0.4b reactive title).
#     - Quantbook: Add Sheet... (3 times) -> "S1", "S2", "S3"
#     - Verify panel title now reads "Cell Grid (Sheet 0 of 4)" (the
#       initial sheet + 3 newly added; reactive count includes empty
#       sheets unlike pre-V3.5.0.4b listSheets-based count).
#     - Click in a cell + type "100" -> Enter.  Title stays "Sheet N
#       of M" -- the count is reactive on each render() but cells
#       within a sheet don't change the count.
#     - Quantbook: Rename Sheet... -> rename Sheet 0 to "Active".
#       Panel title updates within ms: 'Cell Grid (Sheet 0 "Active" of 4)'.

# 14. Mid-edit-render guard smoke (V3.5.0.7 / R-V3.4-3 CLOSED).
#     The two-window collab race verification:
#     - File -> New Window (or duplicate the EDH).
#     - In window 1: "Quantbook: Open Cell Grid (Collab)" -> panel opens.
#     - In window 2: "Quantbook: Open Cell Grid (Collab)" -> panel opens.
#     - Both windows connect via the relay (V3.2.c).
#     - In window 1: click cell A1 -> begin editing (input appears).
#       Output channel shows: presenceUpdate typing:true broadcast.
#     - In window 2 (while window 1's input is OPEN):
#       click cell B1 -> type "999" -> Enter (commit).
#     - In window 1: within ~1s the pollRemote tick fires -- the
#       output channel should now log:
#         [collab] pollRemote merged 1 remote blob(s); SKIPPING render
#         (presenceRepaintInFlight; local user mid-edit). Will retry
#         on next tick.
#     - Verify window 1's <input> element is STILL OPEN (not destroyed
#       by the merged-tick render -- the V3.5.0.7 closure).
#     - In window 1: type a value + Enter.  presenceUpdate typing:false
#       broadcasts; flag clears.  **V3.5.0.X audit-closure A-HIGH-4
#       (2026-05-24)**: the deferred render fires IMMEDIATELY on
#       typing:false (not at the next pollRemote tick) -- cell B1
#       now shows "999".  Pre-closure the deferred render was LOST
#       (subsequent ticks classified as 'idle' and never rendered);
#       window 1 would have stayed showing cell B1 empty indefinitely
#       until some unrelated render triggered.  Output channel logs:
#         [collab] pollRemote idle tick: firing deferred render
#         (presence guard cleared since last merged-skip).
#       (only when the typing:false fires AFTER the next pollRemote
#        tick; otherwise the render fires inside setPresenceTyping
#        without a log line)
#     - **Watchdog smoke** (optional): in window 1, click cell A1 ->
#       begin editing.  WAIT 30+ seconds without committing or
#       canceling (simulate hung typing).  Output channel logs:
#         [collab] presenceRepaintInFlight watchdog fired after 30000ms;
#         auto-cleared (typing:false never arrived; merged-tick
#         renders will resume).
#       Subsequent merged ticks render normally.  V3.5.0.X audit-closure
#       A-HIGH-4: the watchdog auto-clear ALSO fires the deferred render
#       if one is pending (verify window 1 now shows window 2's commit
#       even though typing:false never broadcast).

# 15. Format passthrough + repaired-formula smoke (V3.5.0.5 +
#     V3.5.0.X A-HIGH-2 -- devtools inspection).
#     V3.5 has no IDE write-path for SetCellFormat (V3.6+ scope), but
#     the WorkbookSnapshot's per-cell format field round-trips.  Verify
#     via webview devtools:
#     - Open the webview's devtools (Cmd-Shift-P -> "Developer:
#       Open Webview Developer Tools" -> select the cell-grid panel's
#       webview).
#     - In the devtools console:
#         document.getElementById('cell-grid-data').textContent
#       Parse the JSON.  Verify the entries[] structure has
#       row + col + value but NO format key (V3.5.0.4b
#       extractSheetSnapshot deliberately drops format; V3.2.a shape
#       preserved for buildHtml).  V3.6+ format-aware rendering will
#       extend this.
#
#     **V3.5.0.X audit-closure A-HIGH-2 (2026-05-24) -- repaired-formula
#     verification** (requires .qbook with a formula referencing a
#     to-be-renamed sheet; the IDE has no PutFormula write path so
#     this needs a pre-built .qbook from an integration test or from
#     a future V3.6 formula-write surface):
#     - Open a .qbook that has sheet "A" with another sheet's cell
#       containing formula "=A!B1".
#     - Cmd-Shift-P -> "Quantbook: Rename Sheet..." -> rename A to
#       "Renamed".  Panel refreshes (per A-HIGH-3 closure).
#     - In webview devtools console, invoke the napi workbookSnapshot
#       handle and inspect the formula text on the cell that referenced
#       sheet A.  Pre-V3.5.0.X closure: the formula text was stale
#       ("=A!B1").  Post-closure: the formula text is repaired
#       ("=Renamed!B1") -- napi reads from rebuild_workbook +
#       repair_sheet_rename_chain via workbook.formula_at instead of
#       the unrepaired last_snapshot cache.
#     - Note: until V3.6+ adds an IDE-facing PutFormula API, this
#       step is "construct a .qbook externally then smoke" rather
#       than a fully IDE-driven flow.  The ql-collab Rust test
#       `rebuilt_workbook_carries_repaired_formula_but_cache_does_not`
#       pins the underlying mechanism.
```

If smoke surfaces issues, file findings against the V3.5.0.X audit (parallel Codex+Opus megaudit) which is the next planned audit cycle.

#### V3.5.0.X audit-closures (Phase 5.7 V3.5 phase-termination audit, 2026-05-24)

**Status:** Parallel Codex+Opus megaudit ran 2026-05-24 against V3.5.0.1 through V3.5.0.9.  Both transcripts shipped: `docs/audits/2026-05-24-phase-5-7-v3-5-0-x-codex.md` (Codex Lane A; **FAIL** verdict; 4 HIGH + 1 LOW) + `docs/audits/2026-05-24-phase-5-7-v3-5-0-x-opus.md` (Opus Lane B; PASS-WITH-FINDINGS; 2 HIGH + 4 MED + 3 LOW + 1 INFO).  **5 distinct HIGHs + 1 valid MEDIUM closed in-cycle**; 1 LOW closed in-cycle; remaining LOWs deferred to V3.5.1+ backlog.

**Cross-lane convergence table:**

| Finding | Codex | Opus | Disposition |
|---|---|---|---|
| Partial-invalidate undo wrong-cell after remote interleave | A-HIGH-1 (native-binding repro) | H2 (B.4.b analysis) | **CONVERGENT HIGH; one fix closes both** |
| SetCellFormat tombstone gap | (Codex missed) | H1 (B.6) | Opus-only HIGH; closed in-cycle |
| workbookSnapshot bypasses repaired formulas | A-HIGH-2 | (Opus didn't flag) | Codex-only HIGH; closed in-cycle |
| Sheet management commands don't repaint | A-HIGH-3 | (Opus didn't flag) | Codex-only HIGH; closed in-cycle |
| Mid-edit render skip loses deferred repaint | A-HIGH-4 | (Opus didn't flag) | Codex-only HIGH; closed in-cycle |
| _presenceRepaintInFlight docstring drift | (Codex didn't flag) | M2 | Opus-only MED; closed in-cycle |
| TS comments mention `null` for napi optional fields | A-LOW-1 | (Opus didn't flag) | Codex-only LOW; closed in-cycle |

**Closures (in sequencing order; trivial -> invasive):**

1. **Opus-H1 -- SetCellFormat tombstone guard.**  Engine `crates/ql-oplog/src/replay.rs:728-757` extended with `if workbook.is_sheet_removed(*sheet) { return Ok(()) }` after `validate_cell`, mirroring the V3.5.0.3b pattern that V3.5.0.5's new SetCellFormat handler missed.  **Scope widening discovered during closure**: the live-cache walker (`crates/ql-collab/src/session.rs::apply_cache_effect`) was ALSO tombstone-blind for ALL four cell-keyed ops (PutValue + PutFormula + ClearFormula + SetCellFormat) -- the V3.5.0.3b engine guard only fired during replay paths, not during `append_op`'s live cache update.  Closure widened to:
   - New `CacheEffect::RemoveSheet { id }` variant emitted by `collect_cache_effects` for `Op::RemoveSheet`.
   - New `removed_sheets: HashSet<u16>` field on `CollabSession` tracking the tombstone state for the cache walker.  Rule 4 per-field walk in the field docstring; 0 new triggers; arc terminus stays at 6.
   - `apply_cache_effect` signature gains `&mut HashSet<u16>` parameter; on `CacheEffect::RemoveSheet`, inserts the id into the tracker AND drops all snapshot entries for that sheet via `HashMap::retain`.  All cell-keyed effects early-return when their target sheet is tombstoned.
   - Three callers updated: `append_op`, `rebuild_snapshot_cache` (atomic-swap with fresh local tombstone set), `invalidate_cell` (V3.5.0.6 partial path).
   - **+3 ql-collab regression tests**: `set_cell_format_on_tombstoned_sheet_is_silently_dropped` + `set_cell_format_clear_on_tombstoned_sheet_is_silently_dropped` + `put_value_on_tombstoned_sheet_is_silently_dropped` (the last test is the broader-scope discovery pin).

2. **Opus-M2 -- _presenceRepaintInFlight reset in show().**  IDE `extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts::show()` extended with `instance.setPresenceTyping(false)` immediately before the first `instance.render()` call.  Pre-closure the field-level docstring claimed this reset happened in show(); the reset only existed in the constructor (init false) + on dispose (setPresenceTyping(false)).  Matches V3.4.0.X-established "reinit on show + attachTransport" pattern.  No regression test (no-op on fresh instance; defensive against future refactor that reuses instances).

3. **A-HIGH-2 -- workbookSnapshot bypasses repaired formulas.**  napi `crates/ql-bindings-node/src/lib.rs::workbook_snapshot` now reads formula text from the rebuilt+repaired `Workbook` (via `workbook.formula_at(sheet, row, col)`) instead of from the unrepaired `last_snapshot` cache (`state.formula`).  Pre-closure the napi method DISCARDED the repaired Workbook (only used it for sheet count + names) and serialized stale formula text -- the § 4.1.z5 contract that "formulas surface with rename-repair" (formerly line ~1392) was violated.  The cache's `state.formula` is now the FALLBACK when the repaired Workbook has no formula for the cell (defensive; shouldn't happen post-V3.4.0.X MEDIUM-1 closure).  **+1 ql-collab regression test**: `rebuilt_workbook_carries_repaired_formula_but_cache_does_not` pins the cache-vs-workbook divergence (proves the napi's choice of source matters; the 3-line napi edit is verified by code review on top).  IDE-level integration test deferred to V3.5.1+ scope (would require new napi `appendPutFormula` since formula write isn't IDE-facing today).

4. **A-HIGH-3 -- sheet management commands don't repaint panels.**  IDE `extensions/quantlab/src/commands/quantbookCommands.ts` all 4 sheet management commands (Add/Rename/Delete/Move) now call `CellGridPanel.refreshAll()` after each successful sheet op.  `refreshAll()` was already shipped at V3.2.a.1 (iterates both `localPanels` + `collabPanels` maps and calls `instance.render()` on each).  Output channel log line updated to include `refreshed N panel(s)`.  Pre-closure the live smoke claim "panel title updates within ms" was FALSE because local panels have no poll loop.  No new regression test (vscode-test integration is V3.5.1+ scope per V3.4.0.X Opus § F V3.5 ENTRY READINESS).  Live smoke step 12 now genuinely verifies the behavior.  Note: when the active sheet of a panel is deleted, the panel renders the V3.5.0.4b tombstone-race fallback (empty cells + `console.warn`) -- this is the documented contract; no separate work needed.

5. **A-HIGH-4 -- mid-edit render skip loses deferred repaint.**  IDE `cellGridPanel.ts` gains a new `_pendingRenderAfterTyping: boolean` field.  `tickPollRemote`'s `'merged'` branch sets the flag when skipping; `setPresenceTyping(false)` clears + renders if the flag is set; the presence-typing watchdog auto-clear also fires the deferred render; defense-in-depth in the `'idle'` branch fires the render if the guard has since cleared.  Pre-closure the merged-skip set no pending flag, so subsequent ticks classifying as `'idle'` never rendered; remote changes stayed invisible indefinitely.  R-V3.4-3 closure (V3.5.0.7) was INCOMPLETE without this flag; this V3.5.0.X closure restores the § 4.1.z5 D5 guarantee that "deferred render fires on next 1s tick" (V3.5.0.X actually fires IMMEDIATELY on typing:false, which is BETTER than waiting for the next tick).  No mocha test (panel-level behavior; verification via live smoke step 14 -- two-window mid-edit + commit + verify deferred render fires when typing:false).

6. **A-HIGH-1 + Opus-H2 (CONVERGENT) -- partial-invalidate undo wrong-cell after remote interleaving.**  New `pure_local_frontier: bool` field on `CollabSession`.  Initialized `true` in both constructors.  Set `true` after successful `append_op`, `undo`, `redo` (the appended/inverse op is the new local frontier).  Set `false` after `merge_bytes`, `poll_remote_with_limit` (when blobs drained), `discard_pending_ops` -- any path where remote ops join the log OR the log structure changes.  `undo()` / `redo()` dispatch gates partial-invalidate on this field: if `!pure_local_frontier` the dispatch falls back to full `rebuild_snapshot_cache` regardless of op shape.  Codex A-HIGH-1's native-binding repro: peer A writes (0,0,0); peer B writes (0,1,0); A merges B; A undoes -- pre-closure partial-invalidate read the captured `pre_undo_last_op` as B's REMOTE op and targeted (0,1,0) (WRONG), leaving A's undone cell stale.  Post-closure: the merge resets `pure_local_frontier = false`; undo dispatches to full rebuild.  **+1 ql-collab regression test**: `undo_after_remote_interleave_falls_back_to_full_rebuild` mirrors the Codex § 7 repro + verifies via side-by-side equality with a forced full rebuild on the same post-undo log.  Rule 4: `bool` is Copy+Send+Sync; 0 new triggers; arc terminus stays at 6.  V3.6+ alternative (Loro UndoManager `on_pop` callback) preserved as deferred per § 4.1.z5 drift hazards.

7. **A-LOW-1 -- TS comment hygiene.**  IDE `extensions/quantlab/src/quantbook/types.ts` CellValueJson + CellSnapshotJson docstrings updated: `null`/`undefined` wording replaced with "absent" + explicit "napi-rs serializes Rust `Option::None` as ABSENT properties (the field is `undefined`, NOT `null`)" + "Use TypeScript's optional `?:` syntax to model this contract".  Doc hygiene; interfaces and tests were already correct.

**Backlog (V3.5.1+):**

| ID | Description | Severity | Reason |
|---|---|---|---|
| Opus-M1 (REJECTED as false positive) | Mocha count mismatch (Opus claimed 335; actual = 346) | n/a | Opus over-counted via grep; missed mocha's dynamic for-loop test discovery.  Verified directly via mocha runner |
| Opus-M3 | `quantbookCellGridSwitchSheet` + `quantbookCellGridRefresh` duplication risk | DESIGN OPINION | V3.6+ multi-tab redesign may consolidate; defer with "review during V3.6 sheet-tabs scoping" note |
| Opus-M4 (DOWNGRADED to LOW by Opus on re-read) | `move_sheet` impl correctness | LOW | Opus self-downgraded; no action |
| Opus-L1 | Dead-code arc in `affected_cells_for_partial_invalidate` (classifier never returns `Some(empty Vec)`) | LOW | Minor; could simplify the helper but no behavior change |
| Opus-L2 | `buildSheetMovePositionItems` lists source's current position with `(current)` annotation (semantically a no-op move) | LOW | UX polish; engine accepts via idempotency |
| Opus-L3 | V3.5.0.4b reactive title race between construction + wireAttachment (brief wrong mode-tag window) | LOW | Edge case; defer |
| Opus-I1 | `Workbook::move_sheet` linear-search O(N) | INFO | Acceptable at typical sheet counts; V3.6+ polish |

**Rule 4 arc terminus confirmation:** HELD at 6 throughout the V3.5.0.X closures.  Three new types added in-closure all have positive Send+Sync per-field walks documented in their docstrings:
- `CacheEffect::RemoveSheet { id: u16 }` (enum variant; primitive composition).
- `CollabSession.removed_sheets: HashSet<u16>` (positive Send+Sync via std inherent impl over u16).
- `CollabSession.pure_local_frontier: bool` (Copy+Send+Sync trivially).

**R-V3.5-* reclassifications:** none required.  All V3.5 risks documented at V3.5.0.9 remain accurate.  R-V3.5-2 (partial-invalidate undo correctness under causal reorder) was the conceptual basis for the convergent-HIGH closure and is now operationalized via the `pure_local_frontier` gate + regression test.

**Cumulative V3.5 test deltas post-closure:**
- ql-collab: 81 (V3.4.0.X baseline) -> 111 (+30 V3.5-specific cumulative): V3.5.0.5 +12 + V3.5.0.6 +13 + V3.5.0.X +5 (3 tombstone + 1 repaired-formula + 1 partial-invalidate remote-interleave).
- IDE mocha: 254 (V3.4.0.X baseline) -> 346 (+92 V3.5-specific cumulative; V3.5.0.X added 0 since panel-level behavior is live-smoke-verified).
- ql-collab-ws: 42 (V3.4.0.X baseline) -> 42 (unchanged).

**V3.5 ALL SHIPPED + AUDITED.**  V3.5.0.X megaudit closure complete; V3.5 plan archived; MASTER-PLAN swept.

---

 `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format`. IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)`. `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate. xlsx export flattens multi-peer FormatIds via dedup-by-code; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. xlsx import surfaces unresolved-overlay-numfmt as `report.unsupported` entries. `.qbook/oplog.bin` files wrapped in Tier D3 header (`OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION`). `CollabSession::new` + `from_snapshot` + `OpLog::set_peer_id` assert `PeerId != 0` (release-firing). See `docs/phase5/d-1-exit-packet.md` for the full closure record.

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
