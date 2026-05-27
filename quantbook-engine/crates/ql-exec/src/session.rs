//! `WorkbookSession` — the owning, single-writer engine session (Phase 6.1B inc.2).
//!
//! This is the *implementation* of the binding-neutral [`EngineSession`] contract
//! (`crates/ql-session`, the 6.1A Codex-validated spec at `docs/api/session-api.md`).
//! Where the `ql-session` crate is the type-level contract, this is the concrete
//! struct that **owns** the engine state — `Workbook + OpLog + CalcgraphSession +
//! PlanCache + FunctionRegistry` — and threads a per-edit [`WorkbookRuntime`]
//! through it so no borrow crosses an FFI boundary (GAP-PS-09; the
//! `calcgraph_session.rs:69-71` "absorb into ONE owning struct" anticipation).
//!
//! ## Scope (6.1B inc.2 — core path + read/structure/table + snapshot_delta)
//!
//! Shipped **real**:
//! - lifecycle (`new`/`close`/state gating, the `Busy` state, version `epoch`),
//! - single-cell mutations (`set_value`/`set_formula`/`clear`/`set_format`/
//!   `register_format`/`validate_formula`) + sheet `add`/`rename`/`delete`/
//!   `restore`/`move` + `set_name` + table ops (`create`/`rename`/
//!   `rename_column`/`resize`/`drop`),
//! - recalc (`recalc_dirty`/`recalc_all`/`mark_volatiles_dirty`) under the
//!   `Busy` + operation-registry model,
//! - the read path (`snapshot`/`cell`/`list_sheets`/`query_range`) + the
//!   `{epoch, state_seq}` version token + **`snapshot_delta`** (inc.2c-3 —
//!   change-log design (a)),
//! - operations + events (`cancel`/`operation_status`/`poll_events`).
//!
//! `batch` (inc.2c-4) + the multi-call **transaction handle** (`begin_transaction`/
//! `txn_add`/`commit_transaction`/`rollback_transaction`, inc.2c-5 — a pure
//! `SessionOp` buffer that commits through the same `batch` machinery) are also
//! real. The remaining contract methods return a **surfaced** `Capability` /
//! `not_implemented_in_v1_core` error (NOT a silent fallback — project
//! No-Fallbacks rule) and land in later inc.2 sub-increments:
//! - persistence (`open`/`import`/`save`/`export`),
//! - `undo`/`redo`, function registration (6.4), reserved bulk ops (6.4/6.5).
//!
//! ## Two design facts that shape this increment
//!
//! 1. **Version token = `{epoch, state_seq}` (inc.2c-3 — F1/F2).** `state_seq` is
//!    a session-owned monotonic clock that advances on every committed mutation
//!    AND every recompute that changed ≥1 cell. It **replaces `oplog.len()`** as
//!    the token's counter because `oplog.len()` does NOT advance on recompute
//!    (`put_computed_at` appends no ops), which would let two distinct visible
//!    states share a token and make `snapshot_delta` silently under-report.
//!    (Historical note: pre-F2, a `set_value(Blank)` clear also appended no op
//!    — that gap is now closed by `Op::ClearValue`, but the recompute case
//!    remains the load-bearing reason `state_seq` exists.) `ql-oplog::OpLog`
//!    DOES expose a
//!    Loro VV (`oplog_vv()`), reserved for the v1.5 collab delta-sync path; the
//!    opaque 24-byte token shape is unchanged (only the counter's meaning is).
//!    `snapshot_delta` walks a bounded change-log keyed by `state_seq`; the
//!    `epoch` (bumped on reorder/restore/table-op/undo) forces a full rebuild for
//!    states the delta DTO cannot incrementally express.
//!
//! 2. **`EngineError` cannot have `From<RuntimeError>`** — orphan rules forbid
//!    `impl From<LocalErr> for ForeignErr` when the foreign type is `Self`
//!    (`EngineError` is from `ql-session`). So the Appendix-A mapping lives as
//!    the free function [`map_runtime_err`] in this owning layer, not as a
//!    `From` impl.
//!
//! ## Read-path enumeration note
//!
//! `snapshot` enumerates a sheet's populated cells from the live `Workbook`'s
//! **overlay** entries (user + computed) ∪ formula cells ∪ format-overlay cells.
//! This is complete for every session constructible in this increment: all
//! cell data arrives via `WorkbookRuntime` mutators, which write to the column
//! *overlays* (never the Arrow *base* chunks). Base chunks are only populated
//! by bulk construction / import (`open`/`import` — surfaced-not-yet here), so
//! base-chunk enumeration is a tracked follow-up that lands with `import`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{NamedTarget, Workbook};
use ql_types::{ColId, RowId, SheetId, Value};

use ql_formula_syntax::{lex, lex_with, parse, print_with, FormulaSite};
use ql_io::CellWireValue;
use ql_oplog::Op;
use ql_session::dto::{
    BatchOptions, BatchResult, BoundRange, CellAddr, CellRange, CellSnapshot, CellValue,
    ChangedCell, DateSystem, Diagnostic, DirtyResult, FormatDef, FormatId, FullRebuildReason,
    PublishedRef, RangeColumn, RangeQueryOptions, RangeResult, RemovedCell, SessionVersion,
    Severity, SheetInfo, SheetSnapshot, TableSpec, UndoRedoResult, WorkbookSnapshot,
    WorkbookSnapshotDelta, WriteRangeResult,
};
use ql_session::error::{EngineError, EngineResult, ErrorClass};
use ql_session::function_meta::FunctionMetadata;
use ql_session::operation::{LifecycleState, OperationId, OperationState};
use ql_session::session::{
    EngineSession, Event, EventCursor, EventPage, FunctionImplHandle, SessionOp, TransactionId,
};
use ql_session::SCHEMA_VERSION;

use crate::{bind_with_site, BindSite, CalcgraphSession, PlanCache, RuntimeError, WorkbookRuntime};

/// Process-global epoch source. A fresh epoch is minted per session
/// construction (and would be re-minted on reload / cache-clear / undo when
/// those land). Monotonic within a process — sufficient for v1 single-writer
/// token validity; cross-process epoch handling lands with persistence.
static EPOCH_COUNTER: AtomicU64 = AtomicU64::new(1);

fn mint_epoch() -> u128 {
    EPOCH_COUNTER.fetch_add(1, Ordering::Relaxed) as u128
}

/// Retained `change_log` size before the oldest records are pruned and the
/// horizon floor advances (a `last` token older than the floor gets
/// `StaleHorizon`, never a silently-incomplete delta). Bounded so a long-lived
/// session does not leak; generous enough that interactive deltas never hit it.
const CHANGE_LOG_CAP: usize = 1 << 16;

/// One delta-relevant change recorded against a [`WorkbookSession`] state-seq.
/// The change-log is the source for [`WorkbookSession::snapshot_delta`]: it
/// records *what* changed (cells/sheets/formats) at each `seq`, and the delta
/// resolves those to the *current* committed state at read time. This is the
/// (a) "session change-log keyed by version" design (impl-plan §0 item 3): it
/// keeps `snapshot_delta(&self)` and captures changes that an op-walk misses —
/// recompute-written dependents (`put_computed_at` appends no ops). (Pre-F2 a
/// `set_value(Blank)` clear also appended no op; `Op::ClearValue` now closes
/// that, but recompute dependents remain the load-bearing case.)
#[derive(Clone, Copy, Debug)]
enum SessionChange {
    /// A cell whose value/formula/format may have changed (resolved at delta time).
    Cell {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },
    /// A sheet added / renamed (resolved to a full `SheetSnapshot` at delta time).
    SheetChanged { id: SheetId },
    /// A sheet tombstoned.
    SheetRemoved { id: SheetId },
    /// A format registered (resolved to a `FormatDef` at delta time).
    FormatAdded { id: ql_storage::FormatId },
}

struct ChangeRecord {
    seq: u64,
    change: SessionChange,
}

/// The owning, single-writer engine session (contract §2.1).
///
/// Bindings wrap this behind an opaque handle (Node: `#[napi]` over
/// `Arc<Mutex<WorkbookSession>>`; C: an opaque pointer; etc.) — no borrowed
/// engine reference ever crosses FFI (§2.2).
pub struct WorkbookSession {
    /// Live, single-writer cell/sheet/table/name/format storage.
    workbook: Workbook,
    /// **inc.2c-7 undo/redo baseline.** The workbook as it was at session
    /// construction (the `from_workbook` argument), BEFORE any session edit. The
    /// session's `oplog` records only edits made AFTER construction, so undo's
    /// `rematerialize` replays the (post-undo) op-log onto a CLONE of this
    /// baseline — NOT onto a fresh empty `Workbook`. For the wired `new()` path
    /// the baseline is empty (clone is trivial), so behavior is unchanged; for a
    /// session wrapping a populated workbook (the future `open`/`import` path)
    /// this is what makes undo preserve the pre-loaded content instead of
    /// silently dropping it (and makes "you cannot undo past the point the
    /// workbook was opened" the correct, intended semantic). Audited 2026-05-27
    /// (Codex HIGH / Opus M1: a fresh-`OpLog` + populated-workbook session would
    /// otherwise lose its baseline on the first consumed undo).
    baseline: Workbook,
    /// Mandatory single-writer op-log — undo/save substrate + the `op_count`
    /// half of the version token.
    oplog: OpLog,
    /// Dependency graph + dirty propagation.
    graph: CalcgraphSession,
    /// Session-owned bind-plan cache (threaded into the per-edit runtime via
    /// `WorkbookRuntime::with_session_state` / `into_plan_cache`).
    plan_cache: PlanCache,
    /// Built-in + (future) custom function dispatch. `Arc` so a future
    /// out-of-process UDF host can share it.
    registry: Arc<FunctionRegistry>,
    /// Lifecycle state; commands are gated on it (§2.3).
    state: LifecycleState,
    /// Version-token epoch (minted at construction; re-minted by [`bump_epoch`]
    /// on changes the delta DTO cannot incrementally express — sheet reorder /
    /// restore, table ops that rewrite arbitrary formula cells — and on
    /// cache-clearing events). An old token whose epoch ≠ current →
    /// `EpochMismatch` full rebuild.
    ///
    /// [`bump_epoch`]: WorkbookSession::bump_epoch
    epoch: u128,
    /// Monotonic logical state clock — the `op_count` half of the version token
    /// (§4.0). **Replaces `oplog.len()`** (inc.2c-3): it advances on every
    /// committed mutation AND every recompute that changed ≥1 cell, so — unlike
    /// `oplog.len()`, which does NOT move on `put_computed_at` (recompute) nor on
    /// a `set_value(Blank)` clear — two *distinct* visible states can never share
    /// a token. The opaque 24-byte `{epoch, state_seq}` token shape is unchanged
    /// (bindings round-trip it verbatim); only what the 8-byte counter *means*
    /// changed. Closes audit F1 + the F2 token half.
    state_seq: u64,
    /// Bounded change-log keyed by `state_seq` — the source for `snapshot_delta`.
    /// Records what changed; the delta resolves each to current committed state.
    change_log: VecDeque<ChangeRecord>,
    /// The highest `seq` that has been pruned from `change_log`. A `last` token
    /// with `seq < change_log_floor` can no longer be served incrementally →
    /// `StaleHorizon` full rebuild (never a silently-incomplete delta).
    change_log_floor: u64,
    /// Operation registry: op-id → terminal-or-running state (§6).
    /// **v1 limitation:** grows unbounded (one entry per recalc, never pruned).
    /// Bounded retention (drop terminal entries past a horizon) is a later
    /// increment — acceptable for v1 session lifetimes.
    ops: HashMap<OperationId, OperationState>,
    /// Monotonic op-id source.
    next_op_id: u64,
    /// Append-only event ring; the cursor is an index into this vec (§9).
    /// **v1 limitation:** unbounded, `dropped` always false (no retention horizon
    /// yet); the §9 ring-with-drop semantics land with `subscribe_events`.
    events: Vec<Event>,
    /// Open multi-call transactions (§3.4): handle → buffered `SessionOp`s.
    /// `begin_transaction` allocates an empty buffer, `txn_add` appends, `commit`
    /// drains it through the SAME [`batch`] machinery, `rollback`/`close` drop it.
    /// An open transaction holds **no engine lock** — it is a pure DTO buffer; the
    /// workbook is untouched until commit, so interleaved single edits between
    /// `begin` and `commit` are allowed and the buffer is validated against the
    /// workbook state *at commit time* (the no-borrow-across-FFI contract §3.4).
    /// **v1 limitation:** grows unbounded (one entry per open txn; dropped on
    /// commit/rollback/close), same as `ops`/`events`.
    ///
    /// [`batch`]: WorkbookSession::batch
    txns: HashMap<TransactionId, Vec<SessionOp>>,
    /// Monotonic transaction-id source.
    next_txn_id: u64,
    /// Loro undo/redo manager (inc.2c-6), subscribed to `oplog`'s underlying
    /// `LoroDoc` commit stream at construction (via `OpLog::new_undo_manager`).
    /// It records every LOCAL commit made AFTER it is constructed — i.e. every
    /// `oplog.append`, which `OpLog::append` follows with `doc.commit()`. It
    /// holds an internal `Arc` to the doc, so it is `'static` and may be a
    /// field (it does NOT borrow `self.oplog`).
    ///
    /// **Undo-unit granularity (HARD QUESTION 1).** `set_merge_interval(0)` is
    /// set at construction → NO time-based merging, so each Loro commit is its
    /// own undo unit. Every `WorkbookSession` mutating command produces EXACTLY
    /// one commit: single-cell/structure/name/format/table edits each append
    /// one op (one `append` = one `commit`), and `set_value`/`rename_sheet`/
    /// `rename_table`/`rename_column` (the only commands whose underlying
    /// producer can emit MULTIPLE ops) wrap them in a single `Op::BatchCommit`
    /// (`cells.rs` `set_value` `match log_ops.len()`; `sheets.rs`/`tables.rs`
    /// rename producers append one `BatchCommit`), and `batch`/`commit_transaction`
    /// append one `Op::BatchCommit`. So one `undo()` reverts exactly one command
    /// with NO explicit `group_start`/`group_end` needed. (Proven by
    /// `undo_clear_of_formula_cell_is_one_unit` + `undo_batch_reverts_whole_batch`.)
    ///
    /// **Re-materialization model.** Unlike `ql_collab::CollabSession` (snapshot-
    /// cache + on_push cell-meta partial invalidation), `WorkbookSession` owns a
    /// LIVE workbook and re-materializes it WHOLESALE after a Loro undo/redo:
    /// `replay_into` the (now-compacted) op-log into a fresh workbook, rebuild
    /// the calcgraph, recompute, then `bump_epoch`. So no on_push meta encoding
    /// is wired here — kept deliberately simpler. See [`rematerialize`].
    ///
    /// **v1 depth cap (audit L1).** Loro's `UndoManager::new` defaults to
    /// `set_max_undo_steps(100)`; the session does not override it, so the undo
    /// stack silently drops the oldest unit past 100 undoable commands. Bounded
    /// retention is intentional for v1 (mirrors the `ops`/`events`/`change_log`
    /// bounds); a configurable depth is a later increment.
    ///
    /// [`rematerialize`]: WorkbookSession::rematerialize
    undo_manager: loro::UndoManager,
}

impl WorkbookSession {
    /// Construct a fresh, empty in-memory session (→ `Ready`). The `new(options)`
    /// product command (§3.1).
    pub fn new() -> Self {
        Self::from_workbook(Workbook::new())
    }

    /// Wrap an existing `Workbook` (e.g. a hand-built test workbook; later the
    /// product of `open`/`import`). Rebuilds the calc graph from the workbook's
    /// formulas so dependency tracking is live.
    pub fn from_workbook(workbook: Workbook) -> Self {
        let graph = CalcgraphSession::rebuild_from_workbook(&workbook).session;
        // inc.2c-7: snapshot the construction-time workbook as the undo baseline
        // BEFORE moving `workbook` into the struct (the op-log records only
        // post-construction edits, so `rematerialize` replays onto a clone of
        // this baseline — see the `baseline` field doc). Empty/cheap for `new()`.
        let baseline = workbook.clone();
        let oplog = OpLog::new();
        // inc.2c-6: construct the undo manager AFTER `oplog` so it subscribes to
        // the doc's commit stream and records every subsequent `append`'s commit.
        // `set_merge_interval(0)` disables Loro's time-based commit merging so
        // each commit is its own undo unit (HARD QUESTION 1) — every command
        // already produces exactly one commit, so 1 command == 1 undo unit with
        // no explicit grouping. The manager holds an internal Arc to the doc, so
        // it does not borrow `oplog` and can be moved into the struct below.
        let mut undo_manager = oplog.new_undo_manager();
        undo_manager.set_merge_interval(0);
        Self {
            workbook,
            baseline,
            oplog,
            graph,
            plan_cache: PlanCache::new(),
            registry: Arc::new(ql_functions::default_registry()),
            state: LifecycleState::Ready,
            epoch: mint_epoch(),
            state_seq: 0,
            change_log: VecDeque::new(),
            change_log_floor: 0,
            ops: HashMap::new(),
            next_op_id: 1,
            events: Vec::new(),
            txns: HashMap::new(),
            next_txn_id: 1,
            undo_manager,
        }
    }

    // --- internal helpers ---

    /// Run a closure against a per-edit `WorkbookRuntime` that borrows the
    /// session's owned state, recovering the (warmed) plan cache afterwards.
    /// The runtime borrow never escapes this function.
    ///
    /// **Panic safety (F3 / contract §8):** `f` runs the engine kernels, which
    /// contain reachable `.expect`/`panic!` (e.g. the recompute/spill paths). If
    /// `f` unwinds, the plan-cache restore below is skipped (leaving the cache
    /// taken/empty) and the session may be mid-edit. A `FaultGuard` marks the
    /// session `Faulted` on unwind so no later command runs against torn state —
    /// never silently `Ready`/`Busy`. It is disarmed on the normal return path.
    /// (Under `panic = "abort"` — today's default — the unwind never runs; this
    /// becomes live once the binding shim builds with `panic = "unwind"` + a
    /// boundary `catch_unwind`, per §8.2. The guard is the in-engine half of
    /// that contract.)
    fn with_runtime<R>(&mut self, f: impl FnOnce(&mut WorkbookRuntime<'_>) -> R) -> R {
        struct FaultGuard<'g> {
            state: &'g mut LifecycleState,
            armed: bool,
        }
        impl Drop for FaultGuard<'_> {
            fn drop(&mut self) {
                if self.armed {
                    *self.state = LifecycleState::Faulted;
                }
            }
        }

        let cache = std::mem::take(&mut self.plan_cache);
        // Borrows `self.state`; the runtime below borrows the other (disjoint)
        // fields, so both coexist within this function.
        let mut guard = FaultGuard {
            state: &mut self.state,
            armed: true,
        };
        let mut rt = WorkbookRuntime::with_session_state(
            &mut self.workbook,
            &self.registry,
            &mut self.oplog,
            &mut self.graph,
            cache,
        );
        let out = f(&mut rt);
        self.plan_cache = rt.into_plan_cache();
        guard.armed = false;
        out
    }

    /// Like [`with_runtime`] but with the op-log **detached** — the mutators
    /// update the workbook AND maintain the calcgraph, but append **no** ops
    /// (the [`batch`] path appends its single `Op::BatchCommit` itself). Same
    /// `FaultGuard` panic safety + plan-cache take/restore as `with_runtime`.
    ///
    /// [`with_runtime`]: WorkbookSession::with_runtime
    /// [`batch`]: WorkbookSession::batch
    fn with_runtime_no_oplog<R>(&mut self, f: impl FnOnce(&mut WorkbookRuntime<'_>) -> R) -> R {
        struct FaultGuard<'g> {
            state: &'g mut LifecycleState,
            armed: bool,
        }
        impl Drop for FaultGuard<'_> {
            fn drop(&mut self) {
                if self.armed {
                    *self.state = LifecycleState::Faulted;
                }
            }
        }

        let cache = std::mem::take(&mut self.plan_cache);
        let mut guard = FaultGuard {
            state: &mut self.state,
            armed: true,
        };
        let mut rt = WorkbookRuntime::with_session_state_no_oplog(
            &mut self.workbook,
            &self.registry,
            &mut self.graph,
            cache,
        );
        let out = f(&mut rt);
        self.plan_cache = rt.into_plan_cache();
        guard.armed = false;
        out
    }

    /// Collapse all op-log commits produced by `f` into ONE undo unit
    /// (inc.2c-6, HARD QUESTION 1). Most commands already produce exactly one
    /// Loro commit, so they do NOT use this — and as of the inc.2c (F10) fix,
    /// `rename_table`/`rename_column` now ALSO emit a single `Op::BatchCommit`
    /// (one commit), so this wrapper is **defense-in-depth, not load-bearing**:
    /// it keeps them one undo unit even if a future change reintroduces a
    /// multi-`oplog.append` shape. `group_end` is infallible (a no-op without a
    /// matching `group_start`); we run it on BOTH the success and error paths so
    /// a failing `f` cannot leave a dangling open group. (Once the codebase is
    /// confident no command will ever multi-append, this helper + its two call
    /// sites can be deleted.)
    fn grouped<R>(&mut self, f: impl FnOnce(&mut Self) -> EngineResult<R>) -> EngineResult<R> {
        // A failed `group_start` is a Loro-internal fault (e.g. a group already
        // open — unreachable from the single-writer session) → loud, not
        // swallowed. We have NOT mutated anything yet, so returning here is safe.
        self.undo_manager.group_start().map_err(map_loro_undo_err)?;
        let out = f(self);
        self.undo_manager.group_end();
        out
    }

    /// Reject a coordinate outside the Excel-compatible addressable grid
    /// (`MAX_ROW` / `MAX_COLUMN`) with `BadArgument` (F4 / contract §8). The
    /// read paths (`cell`/`query_range`/`validate_formula`) read the live
    /// `Workbook` directly (no `validate_cell`), and `Sheet::read` returns
    /// `Blank` out-of-bounds — so without this an oversize coordinate would
    /// silently read empty, and an `end = u32::MAX` range would overflow the
    /// `end - start + 1` span before the cell-count cap. Mutators are already
    /// covered by the runtime's `validate_cell`.
    fn require_in_bounds(row: RowId, col: ColId, op: &str) -> EngineResult<()> {
        if row > ql_types::MAX_ROW || col > ql_types::MAX_COLUMN {
            return Err(EngineError::bad_argument(format!(
                "{op}: cell ({row}, {col}) is outside the addressable grid \
                 (max row {}, max col {})",
                ql_types::MAX_ROW,
                ql_types::MAX_COLUMN
            )));
        }
        Ok(())
    }

    /// Gate a mutating/recalc command: legal only in `Ready`.
    fn ensure_ready(&self) -> EngineResult<()> {
        match self.state {
            LifecycleState::Ready => Ok(()),
            LifecycleState::Busy => Err(EngineError::session_busy(
                "a long operation is in progress; mutating commands are rejected while Busy",
            )),
            LifecycleState::New => Err(EngineError::invalid_state(
                "session is not open yet (New); open or import a workbook first",
            )),
            LifecycleState::Closed => {
                Err(EngineError::invalid_state("session is Closed (terminal)"))
            }
            LifecycleState::Faulted => {
                Err(EngineError::invalid_state("session is Faulted (terminal)"))
            }
        }
    }

    /// Gate a read-only command: legal in `Ready` or `Busy` (reads the last
    /// committed state); rejected once terminal.
    fn ensure_readable(&self) -> EngineResult<()> {
        match self.state {
            LifecycleState::Ready | LifecycleState::Busy => Ok(()),
            LifecycleState::New => Err(EngineError::invalid_state("session is not open yet (New)")),
            LifecycleState::Closed => {
                Err(EngineError::invalid_state("session is Closed (terminal)"))
            }
            LifecycleState::Faulted => {
                Err(EngineError::invalid_state("session is Faulted (terminal)"))
            }
        }
    }

    fn next_op(&mut self) -> OperationId {
        let id = OperationId(self.next_op_id);
        self.next_op_id += 1;
        id
    }

    /// Fail-loud sheet-existence check (MED-3): an unknown id → `NotFound`,
    /// never a silent storage no-op/clamp. A *known* but tombstoned id still
    /// "exists" here (used by delete/restore/move for idempotency); reads +
    /// edits use [`require_live_sheet`] instead.
    ///
    /// [`require_live_sheet`]: WorkbookSession::require_live_sheet
    fn require_sheet_exists(&self, id: SheetId, op: &str) -> EngineResult<()> {
        if (id as usize) >= self.workbook.sheet_count() {
            return Err(EngineError::new(
                ErrorClass::NotFound,
                "sheet_not_found",
                format!(
                    "{op}: sheet {id} does not exist (workbook has {} sheets)",
                    self.workbook.sheet_count()
                ),
            ));
        }
        Ok(())
    }

    /// A sheet is "live" (visible/editable) iff it exists AND is not tombstoned.
    /// Reads (`cell`/`query_range`/`validate_formula`) and cell/structure edits
    /// (`set_*`, `rename_sheet`, `create_table`) gate on this so a deleted sheet
    /// behaves consistently across the whole surface: `snapshot`/`list_sheets`
    /// already hide tombstoned sheets, so reading or writing one must also report
    /// `NotFound` (restore it first). Both the missing and tombstoned cases use
    /// code `sheet_not_found` (the message distinguishes them).
    ///
    /// **F9 — deliberate v1 semantic (NOT gated here):** formula *evaluation*
    /// still reads tombstoned sheets — sheet-name resolution + the eval env do
    /// not filter tombstones (`workbook.rs` / `env.rs`), so a formula referencing
    /// a deleted sheet reads its preserved cells rather than `#REF!`. This is the
    /// locked V3.5.0.3b decision (`Op::RemoveSheet` leaves formula text intact, no
    /// `#REF!` substitution) and matches the v1.5 `#REF!` backlog (D7). The
    /// session surfaces gate the *direct* read/edit of a tombstoned sheet; the
    /// transitive formula-readability is intentionally preserved for v1.
    fn require_live_sheet(&self, id: SheetId, op: &str) -> EngineResult<()> {
        if (id as usize) >= self.workbook.sheet_count() {
            return Err(EngineError::new(
                ErrorClass::NotFound,
                "sheet_not_found",
                format!(
                    "{op}: sheet {id} does not exist (workbook has {} sheets)",
                    self.workbook.sheet_count()
                ),
            ));
        }
        if self.workbook.is_sheet_removed(id) {
            return Err(EngineError::new(
                ErrorClass::NotFound,
                "sheet_not_found",
                format!("{op}: sheet {id} is deleted (tombstoned); restore it first"),
            ));
        }
        Ok(())
    }

    /// Canonicalize + bind-validate one formula exactly as
    /// [`WorkbookRuntime::set_formula`] does (used by [`batch`] to build the
    /// `PutFormula` inner op pre-mutation): lex under the workbook's current
    /// reference-mode/locale → parse → `print_with(A1, EnUs, site)` to get the
    /// canonical stored text → bind at the cell site. A lex/parse/print error
    /// maps to a `Compute`/`formula_parse` `EngineError`; a bind error maps to
    /// `Compute`/`formula_bind`. The returned `Arc<str>` is the canonical text
    /// the cell will store, so the logged op matches a single edit's op.
    ///
    /// [`set_formula`]: WorkbookRuntime::set_formula
    /// [`batch`]: WorkbookSession::batch
    fn canonicalize_and_bind(&self, addr: CellAddr, text: &str) -> EngineResult<Arc<str>> {
        let mode = self.workbook.reference_mode();
        let locale = self.workbook.locale();
        let address = ql_types::Address::new(addr.sheet, addr.row, addr.col);
        let site = FormulaSite::at_cell(address);
        let to_parse_err =
            |msg: String| EngineError::new(ErrorClass::Compute, "formula_parse", msg);
        let tokens = lex_with(text, mode, locale).map_err(|e| to_parse_err(e.to_string()))?;
        let expr = parse(tokens).map_err(|e| to_parse_err(e.to_string()))?;
        let canonical: Arc<str> = Arc::from(
            print_with(
                &expr,
                ql_types::ReferenceMode::A1,
                ql_types::Locale::EnUs,
                Some(site),
            )
            .map_err(|e| to_parse_err(e.to_string()))?,
        );
        bind_with_site(
            &expr,
            BindSite::at_cell(address),
            &self.workbook,
            &self.workbook,
            &self.workbook,
        )
        .map_err(|e| EngineError::new(ErrorClass::Compute, "formula_bind", e.to_string()))?;
        Ok(canonical)
    }

    /// Encode the current `{epoch, state_seq}` version token (§4.0). 16-byte
    /// big-endian epoch followed by 8-byte big-endian `state_seq`. (inc.2c-3:
    /// the counter is `state_seq`, not `oplog.len()` — see the `state_seq` field
    /// doc; this is what makes the token a true *state* token for delta.)
    fn current_version(&self) -> SessionVersion {
        let mut bytes = Vec::with_capacity(24);
        bytes.extend_from_slice(&self.epoch.to_be_bytes());
        bytes.extend_from_slice(&self.state_seq.to_be_bytes());
        SessionVersion(bytes)
    }

    /// Decode a 24-byte `{epoch(16, BE), state_seq(8, BE)}` token. A malformed
    /// token (wrong length) is **fail-loud** `invalid_version_token` (`Protocol`)
    /// — NEVER a silent full-rebuild (§4.3 / MED-2 / No-Fallbacks).
    fn decode_version(v: &SessionVersion) -> EngineResult<(u128, u64)> {
        if v.0.len() != 24 {
            return Err(EngineError::new(
                ErrorClass::Protocol,
                "invalid_version_token",
                format!(
                    "version token must be 24 bytes ({{epoch:16, state_seq:8}}), got {}",
                    v.0.len()
                ),
            ));
        }
        let mut epoch_bytes = [0u8; 16];
        epoch_bytes.copy_from_slice(&v.0[0..16]);
        let mut seq_bytes = [0u8; 8];
        seq_bytes.copy_from_slice(&v.0[16..24]);
        Ok((
            u128::from_be_bytes(epoch_bytes),
            u64::from_be_bytes(seq_bytes),
        ))
    }

    /// Append change records for a just-committed command, bumping `state_seq`
    /// once (all records of the command share the new seq). A no-op if `changes`
    /// is empty — a command that changed nothing observable must NOT advance the
    /// token. Prunes the oldest records past [`CHANGE_LOG_CAP`], advancing
    /// `change_log_floor` so a token older than the retained window gets
    /// `StaleHorizon` rather than an incomplete delta.
    fn record_changes(&mut self, changes: impl IntoIterator<Item = SessionChange>) {
        let mut iter = changes.into_iter().peekable();
        if iter.peek().is_none() {
            return;
        }
        self.state_seq += 1;
        let seq = self.state_seq;
        for change in iter {
            self.change_log.push_back(ChangeRecord { seq, change });
        }
        while self.change_log.len() > CHANGE_LOG_CAP {
            if let Some(dropped) = self.change_log.pop_front() {
                self.change_log_floor = self.change_log_floor.max(dropped.seq);
            }
        }
    }

    /// Mint a fresh epoch → every outstanding version token becomes
    /// `EpochMismatch` (full rebuild) on its next `snapshot_delta`. Used for
    /// state changes the delta DTO cannot incrementally express — sheet reorder
    /// (`move_sheet`) / restore (`restore_sheet`, reappears at a position the
    /// delta can't convey) and table ops (`create/rename/rename_column/resize/
    /// drop_table`, which rewrite arbitrary formula cells the session can't
    /// enumerate) — and for cache-clearing events (undo/redo, future). The
    /// change-log is keyed by the OLD epoch's seqs, so it is cleared (a new-epoch
    /// token starts fresh from the current `state_seq`).
    fn bump_epoch(&mut self) {
        self.epoch = mint_epoch();
        self.change_log.clear();
        self.change_log_floor = self.state_seq;
    }

    /// Rebuild the live workbook + calcgraph from the (post-undo/redo) op-log,
    /// recompute computed values, and bump the epoch (inc.2c-6 undo/redo).
    ///
    /// After a Loro `undo()`/`redo()`, the UndoManager retracts (or re-applies)
    /// the commit(s) for the reverted command, so the op-log's visible list
    /// (`OpLog::iter`) now yields the POST-undo op sequence. But the session's
    /// LIVE `workbook` + `graph` still reflect the pre-undo state — Loro reverts
    /// only its own op-list, not our derived workbook/graph (which are NOT Loro
    /// containers). So we re-derive both from the op-log:
    ///
    /// 1. `replay_into` a FRESH `Workbook` from the op-log. Replay persists
    ///    formula TEXT without evaluating (its doc contract), so computed values
    ///    are not yet present.
    /// 2. Rebuild the calcgraph from that workbook (mirrors `from_workbook`).
    /// 3. `recompute_all` to fill computed values — run through a per-edit
    ///    runtime WITH THE OP-LOG DETACHED (`with_runtime_no_oplog`) so the
    ///    recompute appends NO ops (it must not pollute the log we just
    ///    re-materialized FROM, nor feed the UndoManager a spurious commit).
    ///    Structural recompute failures surface as `CellDiagnostic` events
    ///    (never silently dropped), mirroring `run_recalc`. NOTE: this does NOT
    ///    create an operation-registry entry / `Busy` transition — undo/redo are
    ///    fast synchronous re-derivations, not user-cancellable long ops; the
    ///    op-registry is the shape the out-of-process 6.4/6.5 paths reuse, and a
    ///    re-materialization is internal bookkeeping, not a recalc command.
    /// 4. `bump_epoch` so the next `snapshot_delta` from any pre-undo token
    ///    returns `full_rebuild_required` (`EpochMismatch`) — the wholesale
    ///    rebuild is not incrementally delta-expressible. The token thus changes
    ///    after every consumed undo/redo.
    ///
    /// A replay error here is a torn-engine condition (the op-log is the source
    /// of truth and must replay): map it loud (`map_replay_err`), never swallow.
    fn rematerialize(&mut self) -> EngineResult<()> {
        // Replay onto a clone of the construction-time baseline (NOT a fresh
        // empty workbook): the op-log holds only post-construction edits, so
        // `baseline + (post-undo log)` reconstructs the correct state and
        // preserves any pre-loaded content. Empty/trivial for the `new()` path.
        let mut wb = self.baseline.clone();
        ql_oplog::replay_into(&self.oplog, &mut wb, &self.registry).map_err(map_replay_err)?;
        self.workbook = wb;
        self.graph = CalcgraphSession::rebuild_from_workbook(&self.workbook).session;
        // Recompute computed values with the op-log detached (no spurious ops /
        // no UndoManager commit). The result's failures become diagnostics.
        let result = self.with_runtime_no_oplog(|rt| rt.recompute_all());
        for failure in &result.failures {
            self.events.push(Event::CellDiagnostic {
                diagnostic: Diagnostic {
                    addr: Some(CellAddr {
                        sheet: failure.sheet,
                        row: failure.row,
                        col: failure.col,
                    }),
                    severity: Severity::Error,
                    code: "formula_recompute_failed".to_string(),
                    message: failure.error.to_string(),
                },
            });
        }
        // The wholesale rebuild cannot be conveyed incrementally → force a full
        // rebuild for any outstanding token (and advance the state token).
        self.bump_epoch();
        self.state_seq += 1;
        Ok(())
    }

    /// Build a delta that tells the caller to reseed via `snapshot()` (§4.3):
    /// empty change vectors + the current token + the designed `reason`. This is
    /// a *designed* state (NOT an error — unlike a malformed token, which is the
    /// fail-loud `invalid_version_token`).
    fn full_rebuild_delta(&self, reason: FullRebuildReason) -> WorkbookSnapshotDelta {
        WorkbookSnapshotDelta {
            schema_version: SCHEMA_VERSION,
            changed_cells: Vec::new(),
            removed_cells: Vec::new(),
            sheets_changed: Vec::new(),
            sheets_removed: Vec::new(),
            formats_added: Vec::new(),
            version: self.current_version(),
            full_rebuild_required: true,
            full_rebuild_reason: Some(reason),
        }
    }

    /// Build a full `SheetSnapshot` for one live sheet (shared by `snapshot` and
    /// `snapshot_delta`'s `sheets_changed`). `None` if the sheet is gone.
    fn build_sheet_snapshot(&self, sheet_id: SheetId) -> Option<SheetSnapshot> {
        let name = self.workbook.sheet(sheet_id)?.name().to_string();
        let mut cells = Vec::new();
        for (row, col) in self.populated_coords(sheet_id) {
            if let Some(cell) = self.build_cell_snapshot(sheet_id, row, col) {
                cells.push(cell);
            }
        }
        Some(SheetSnapshot {
            id: sheet_id,
            name,
            cells,
        })
    }

    /// Run a recompute closure under the `Busy` plus operation-registry model
    /// (§6.4). In v1 the in-engine recompute is synchronous and runs to
    /// completion within this call (it is the common fast path); the registry
    /// and the `Busy` state are the shape the out-of-process UDF/SQL/AI paths
    /// (6.4/6.5) reuse for honest hard-cancel. Structural failures surface as
    /// `CellDiagnostic` events (never silently dropped).
    fn run_recalc(
        &mut self,
        f: impl FnOnce(&mut WorkbookRuntime<'_>) -> Option<crate::RecomputeResult>,
    ) -> OperationId {
        let op = self.next_op();
        self.ops.insert(op, OperationState::Running);
        self.state = LifecycleState::Busy;

        let result = self.with_runtime(f);

        if let Some(res) = &result {
            // F1: recompute commits via `put_computed_at` and appends NO ops, so
            // the version token must advance HERE — fold the changed cells into
            // the delta change-log (no-op if nothing changed).
            if !res.changed_cells.is_empty() {
                let changes: Vec<SessionChange> = res
                    .changed_cells
                    .iter()
                    .map(|&(sheet, row, col)| SessionChange::Cell { sheet, row, col })
                    .collect();
                self.record_changes(changes);
            }
            for failure in &res.failures {
                self.events.push(Event::CellDiagnostic {
                    diagnostic: Diagnostic {
                        addr: Some(CellAddr {
                            sheet: failure.sheet,
                            row: failure.row,
                            col: failure.col,
                        }),
                        severity: Severity::Error,
                        code: "formula_recompute_failed".to_string(),
                        message: failure.error.to_string(),
                    },
                });
            }
        }

        self.ops.insert(op, OperationState::Completed);
        self.state = LifecycleState::Ready;
        self.events.push(Event::OperationCompleted {
            op,
            state: OperationState::Completed,
        });
        op
    }

    /// Collect the populated `(row, col)` coordinates of one sheet from the live
    /// workbook (overlay value cells ∪ formula cells ∪ format-overlay cells).
    /// See the module-level read-path enumeration note.
    fn populated_coords(&self, sheet_id: SheetId) -> Vec<(RowId, ColId)> {
        let mut set: HashSet<(RowId, ColId)> = HashSet::new();
        if let Some(sheet) = self.workbook.sheet(sheet_id) {
            // Value cells: union of user + computed overlay keys across columns.
            for col in 0..sheet.column_count() as ColId {
                if let Some(column) = sheet.column(col) {
                    let chunk_rows = column.chunk_rows();
                    for (chunk_idx, _base, user, computed) in column.iter_chunks() {
                        let base_row = chunk_idx as u32 * chunk_rows;
                        for (rel_row, _v) in user.iter() {
                            set.insert((base_row + rel_row, col));
                        }
                        for (rel_row, _v) in computed.iter() {
                            set.insert((base_row + rel_row, col));
                        }
                    }
                }
            }
            // Format-only cells.
            for ((row, c), _fmt) in sheet.format_overlay().iter() {
                set.insert((row, c));
            }
        }
        // Formula cells (a formula cell can be Blank-valued but still present).
        for (s, row, col, _text) in self.workbook.iter_formulas() {
            if s == sheet_id {
                set.insert((row, col));
            }
        }
        let mut coords: Vec<(RowId, ColId)> = set.into_iter().collect();
        coords.sort_unstable();
        coords
    }

    /// Build a `CellSnapshot` for one cell, or `None` if the cell is truly empty
    /// (no value, formula, or format).
    fn build_cell_snapshot(
        &self,
        sheet_id: SheetId,
        row: RowId,
        col: ColId,
    ) -> Option<CellSnapshot> {
        let sheet = self.workbook.sheet(sheet_id)?;
        let value = value_to_cell_value(&sheet.read(row, col));
        let formula = self
            .workbook
            .formula_at(sheet_id, row, col)
            .map(|f| f.to_string());
        let format = sheet
            .format_overlay()
            .get(row, col)
            .map(storage_format_id_to_dto);
        if value.is_none() && formula.is_none() && format.is_none() {
            return None;
        }
        Some(CellSnapshot {
            row,
            col,
            value,
            formula,
            format,
            rendered: None,
        })
    }
}

impl Default for WorkbookSession {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineSession for WorkbookSession {
    // --- Lifecycle / persistence (§3.1) ---

    fn lifecycle_state(&self) -> LifecycleState {
        self.state
    }

    fn open(&mut self, _path: &str) -> EngineResult<()> {
        Err(not_implemented("open (.qbook load)"))
    }

    fn import(&mut self, _bytes: &[u8], _format: &str) -> EngineResult<()> {
        Err(not_implemented("import"))
    }

    fn save(&self, _path: &str) -> EngineResult<()> {
        Err(not_implemented("save (.qbook write)"))
    }

    fn export(&self, _format: &str) -> EngineResult<Vec<u8>> {
        Err(not_implemented("export"))
    }

    fn close(&mut self) -> EngineResult<()> {
        self.state = LifecycleState::Closed;
        // Drop any open transaction buffers — they can never commit on a
        // terminal session (their handles become `transaction_not_found`).
        self.txns.clear();
        Ok(())
    }

    // --- Mutation — single edits (§3.2) ---

    fn set_value(&mut self, addr: CellAddr, value: CellValue) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "set_value")?;
        let v = cell_value_to_value(value)?;
        self.with_runtime(|rt| rt.set_value(addr.sheet, addr.row, addr.col, v))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }]);
        Ok(())
    }

    fn set_formula(&mut self, addr: CellAddr, text: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "set_formula")?;
        self.with_runtime(|rt| rt.set_formula(addr.sheet, addr.row, addr.col, text))
            .map(|_value| ())
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }]);
        Ok(())
    }

    fn clear(&mut self, addr: CellAddr) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "clear")?;
        self.with_runtime(|rt| rt.clear_formula(addr.sheet, addr.row, addr.col))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }]);
        Ok(())
    }

    fn set_format(&mut self, addr: CellAddr, format: FormatId) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "set_format")?;
        let id = dto_format_id_to_storage(format);
        self.with_runtime(|rt| rt.set_cell_format(addr.sheet, addr.row, addr.col, Some(id)))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }]);
        Ok(())
    }

    fn register_format(&mut self, format_string: &str) -> EngineResult<FormatId> {
        self.ensure_ready()?;
        let id = self
            .with_runtime(|rt| rt.intern_format(format_string))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::FormatAdded { id }]);
        Ok(storage_format_id_to_dto(id))
    }

    fn validate_formula(&self, addr: CellAddr, text: &str) -> EngineResult<Vec<Diagnostic>> {
        self.ensure_readable()?;
        self.require_live_sheet(addr.sheet, "validate_formula")?;
        Self::require_in_bounds(addr.row, addr.col, "validate_formula")?; // F4
                                                                          // Read-only lex → parse → bind against the live workbook (no mutation, so
                                                                          // no `WorkbookRuntime` `&mut` needed). A failure at any stage becomes one
                                                                          // error `Diagnostic`; a clean bind yields an empty vec (valid). Evaluation
                                                                          // is intentionally skipped — a formula that *binds* is structurally valid;
                                                                          // an eval-time `#REF!`/`#DIV/0!` is a cell value, not a validation error.
        let diag = |code: &str, message: String| -> Vec<Diagnostic> {
            vec![Diagnostic {
                addr: Some(addr),
                severity: Severity::Error,
                code: code.to_string(),
                message,
            }]
        };
        let tokens = match lex(text) {
            Ok(t) => t,
            Err(e) => return Ok(diag("formula_lex", e.to_string())),
        };
        let expr = match parse(tokens) {
            Ok(x) => x,
            Err(e) => return Ok(diag("formula_parse", e.to_string())),
        };
        match bind_with_site(
            &expr,
            BindSite::at_cell(addr.into()),
            &self.workbook,
            &self.workbook,
            &self.workbook,
        ) {
            Ok(_plan) => Ok(Vec::new()),
            Err(e) => Ok(diag("formula_bind", e.to_string())),
        }
    }

    // --- Mutation — structure (§3.3) ---

    fn add_sheet(&mut self, name: &str, chunk_rows: u32) -> EngineResult<SheetId> {
        self.ensure_ready()?;
        let id = self
            .with_runtime(|rt| rt.add_sheet(name, chunk_rows))
            .map_err(map_runtime_err)?;
        // A new sheet appends at the end of the display order — reconstructable
        // by the delta consumer, so a plain `SheetChanged` (no epoch bump).
        self.record_changes([SessionChange::SheetChanged { id }]);
        Ok(id)
    }

    fn rename_sheet(&mut self, id: SheetId, name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        // F6: a tombstoned sheet is uniformly gone across the surface — renaming
        // one must report NotFound, not silently rename a hidden sheet.
        self.require_live_sheet(id, "rename_sheet")?;
        self.with_runtime(|rt| rt.rename_sheet(id, name))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::SheetChanged { id }]);
        Ok(())
    }

    fn delete_sheet(&mut self, id: SheetId) -> EngineResult<()> {
        self.ensure_ready()?;
        // Fail-loud (MED-3): unknown id → NotFound (NOT the silent storage no-op).
        self.require_sheet_exists(id, "delete_sheet")?;
        // F5: an already-tombstoned (but known) id is a TRUE idempotent no-op —
        // return without appending a spurious `Op::RemoveSheet`. The earlier impl
        // appended unconditionally; `Workbook::remove_sheet` then no-ops, but the
        // op still advanced the version token + polluted the log for a non-change.
        if self.workbook.is_sheet_removed(id) {
            return Ok(());
        }
        // Producer order: append-before-mutate, so a failed append leaves the
        // workbook unchanged. (`Workbook::remove_sheet` tombstones — preserving
        // cells for restore; cross-sheet dependents are NOT proactively dirtied
        // here, matching the engine's current cross-sheet-ref handling. Formulas
        // referencing a tombstoned sheet stay readable — see the F9 note on
        // `require_live_sheet`.)
        self.oplog
            .append(Op::RemoveSheet { id })
            .map_err(oplog_append_err)?;
        self.workbook.remove_sheet(id);
        self.record_changes([SessionChange::SheetRemoved { id }]);
        Ok(())
    }

    fn restore_sheet(&mut self, id: SheetId) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_sheet_exists(id, "restore_sheet")?;
        // F5 / contract §3.3: restoring a sheet that is NOT tombstoned is a
        // Conflict (there is nothing to restore) — never a silent no-op that
        // appends a spurious `Op::RestoreSheet` + advances the version token.
        if !self.workbook.is_sheet_removed(id) {
            return Err(EngineError::new(
                ErrorClass::Conflict,
                "sheet_not_deleted",
                format!("restore_sheet: sheet {id} is not deleted (nothing to restore)"),
            ));
        }
        self.oplog
            .append(Op::RestoreSheet { id })
            .map_err(oplog_append_err)?;
        self.workbook.restore_sheet(id);
        // A restored sheet reappears at its preserved display position, which the
        // delta DTO cannot convey → bump the epoch so consumers reseed (rare).
        self.bump_epoch();
        Ok(())
    }

    fn move_sheet(&mut self, id: SheetId, index: u32) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_sheet_exists(id, "move_sheet")?;
        // Fail-loud (MED-3): out-of-range index → BadArgument (NOT the silent
        // storage clamp). Valid display positions are [0, sheet_count).
        let count = self.workbook.sheet_count() as u32;
        if index >= count {
            return Err(EngineError::bad_argument(format!(
                "move_sheet: index {index} out of range (workbook has {count} sheets)"
            )));
        }
        // F5: moving a sheet to its current display position is a no-op — skip
        // the spurious `Op::MoveSheet` + version advance.
        let current = self
            .workbook
            .sheet_display_order()
            .iter()
            .position(|&s| s == id);
        if current == Some(index as usize) {
            return Ok(());
        }
        self.oplog
            .append(Op::MoveSheet {
                id,
                new_index: index,
            })
            .map_err(oplog_append_err)?;
        self.workbook.move_sheet(id, index);
        // A reorder cannot be expressed by the delta DTO (no order field) →
        // bump the epoch so consumers reseed for the new order (rare).
        self.bump_epoch();
        Ok(())
    }

    fn set_name(&mut self, name: &str, target: CellRange) -> EngineResult<()> {
        self.ensure_ready()?;
        let range: ql_types::Range = target.into();
        self.with_runtime(|rt| rt.set_name(name, NamedTarget::Range(range)))
            .map_err(map_runtime_err)
        // No change-log record: defined names are not part of `WorkbookSnapshot`
        // / `WorkbookSnapshotDelta`, so a name definition is delta-invisible.
    }

    fn create_table(&mut self, spec: TableSpec) -> EngineResult<()> {
        self.ensure_ready()?;
        // F6: `WorkbookRuntime::create_table` only checks `sheet(..).is_some()`,
        // which still returns `Some` for a tombstoned sheet — so without this you
        // could create a table on a deleted sheet (invisible to snapshot/
        // list_sheets). Gate on the live sheet, consistent with the read/edit
        // surface.
        self.require_live_sheet(spec.sheet, "create_table")?;
        let TableSpec {
            name,
            sheet,
            top_row,
            top_col,
            rows,
            cols,
            has_header,
            has_totals,
            column_names,
        } = spec;
        self.with_runtime(|rt| {
            rt.create_table(
                &name,
                sheet,
                top_row,
                top_col,
                rows,
                cols,
                has_header,
                has_totals,
                column_names,
            )
        })
        .map_err(map_runtime_err)?;
        // Table ops write/rewrite cells (headers, totals, and — for rename — formula
        // text anywhere in the workbook) that the session cannot enumerate, so they
        // are not incrementally delta-expressible → bump the epoch (consumers reseed;
        // table ops are infrequent schema changes).
        self.bump_epoch();
        Ok(())
    }

    fn rename_table(&mut self, old_name: &str, new_name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        // `rename_table`'s producer now emits ONE `Op::BatchCommit`
        // ([RenameTable, PutFormula × N]) after the F10 fix (tables.rs) → already
        // one commit = one undo unit. The `grouped()` wrapper is defense-in-depth
        // (see its doc): it keeps this one undo unit even if the producer ever
        // regresses to a multi-append shape.
        self.grouped(|s| {
            s.with_runtime(|rt| rt.rename_table(old_name, new_name))
                .map(|_affected| ())
                .map_err(map_runtime_err)
        })?;
        self.bump_epoch(); // see create_table
        Ok(())
    }

    fn rename_column(&mut self, table: &str, old_col: &str, new_col: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        // Same as `rename_table`: the producer now emits ONE `Op::BatchCommit`
        // ([RenameColumn, PutFormula × N]) after the F10 fix; `grouped()` is
        // defense-in-depth (already one undo unit).
        self.grouped(|s| {
            s.with_runtime(|rt| rt.rename_column(table, old_col, new_col))
                .map(|_affected| ())
                .map_err(map_runtime_err)
        })?;
        self.bump_epoch(); // see create_table
        Ok(())
    }

    fn resize_table(
        &mut self,
        name: &str,
        new_rows: u32,
        new_cols: u32,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    ) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| {
            rt.resize_table(name, new_rows, new_cols, added_columns, removed_columns)
        })
        .map_err(map_runtime_err)?;
        self.bump_epoch(); // see create_table
        Ok(())
    }

    fn drop_table(&mut self, name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.drop_table(name))
            .map_err(map_runtime_err)?;
        self.bump_epoch(); // see create_table
        Ok(())
    }

    // --- Batch / transaction (§3.4) ---

    /// Apply a sequence of cell mutations as ONE undo unit / ONE op-log entry
    /// (`Op::BatchCommit`, §3.4). Option (a) of impl-plan §0:
    ///
    /// 1. **Validate-all up front (atomic).** Every op's sheet liveness +
    ///    grid bounds are checked, every `SetFormula` is lex→parse→bind'd, and
    ///    every value that will be serialized into the `BatchCommit`
    ///    (`SetValue` literals + `Clear`'s preserved cell value) is checked
    ///    finite — so the later append cannot fail on a NaN/Inf serialization.
    ///    Any failure returns the error with the workbook + version token
    ///    UNCHANGED (nothing mutated, no op appended).
    /// 2. **Build the single `Op::BatchCommit`** from the PRE-batch workbook
    ///    state (mirroring `WorkbookTransaction::commit`'s pre-commit reads at
    ///    `transaction.rs:311`): `SetValue`→`PutValue`(+`ClearFormula` if the
    ///    cell currently has a formula); `SetFormula`→`PutFormula`(canonical
    ///    A1/EnUs text); `Clear`→`PutValue`(preserved scalar value)+
    ///    `ClearFormula` (skipping a no-formula cell, mirroring
    ///    `clear_formula`); `SetFormat`→`SetCellFormat`. (A `SetValue(Blank)`
    ///    emits `Op::ClearValue` — the durable value-clear op, mirroring
    ///    `set_value` post-F2; the only zero-inner-op case is a `Clear` on a
    ///    no-formula cell.)
    /// 3. **Append the `BatchCommit` BEFORE mutating** the workbook (one undo
    ///    unit, one log entry; an append failure leaves the workbook
    ///    unchanged), unless the batch reduces to zero inner ops.
    /// 4. **Apply every op through a graph-maintaining runtime with the op-log
    ///    DETACHED** ([`with_runtime_no_oplog`] / `with_session_state_no_oplog`)
    ///    — so the workbook AND the session's `CalcgraphSession` update (the
    ///    graph hooks fire on `graph.is_some()`, independent of the op-log) but
    ///    NO second per-op append happens. This is the tension
    ///    `WorkbookTransaction` could not resolve (it maintains no graph): after
    ///    the batch, a later `recalc_dirty` correctly recomputes the batched
    ///    cells' dependents.
    /// 5. **Advance `state_seq` exactly once** for the whole batch
    ///    (`record_changes` with every touched cell/format), so a
    ///    `snapshot_delta` from a pre-batch token reflects every batched cell.
    ///
    /// `options.undo_label` is accepted but not yet consumed (undo lands in a
    /// later increment; the label will tag the undo unit then). The eval of
    /// formulas happens during apply (single-edit semantics); same-cell
    /// duplicate ops use last-write-wins with the pre-batch `had_formula`
    /// approximation, identical to `WorkbookTransaction`.
    ///
    /// [`with_runtime_no_oplog`]: WorkbookSession::with_runtime_no_oplog
    fn batch(&mut self, ops: Vec<SessionOp>, _options: BatchOptions) -> EngineResult<BatchResult> {
        self.ensure_ready()?;

        // Empty batch: nothing observable changed → no op, no token advance.
        if ops.is_empty() {
            return Ok(BatchResult {
                applied: 0,
                version: self.current_version(),
            });
        }

        // --- Phase 1: validate-all + build the BatchCommit inner ops, all
        // against the PRE-batch workbook (no mutation yet). Any error here
        // returns with the workbook + token UNCHANGED. ---
        let mut inner_ops: Vec<Op> = Vec::with_capacity(ops.len() * 2);
        // Touched cells/formats for the single `record_changes` call (deduped
        // at delta-resolve time, so a plain Vec is fine).
        let mut changes: Vec<SessionChange> = Vec::with_capacity(ops.len());

        // Same-cell value/formula conflict guard. The BatchCommit inner ops are
        // built here against the PRE-batch workbook, but Phase 3 applies the ops
        // SEQUENTIALLY through the runtime. For two ops that both touch the
        // value/formula of one cell, the pre-batch-built log can diverge from
        // the sequential apply on replay: e.g. `[SetFormula A1, SetValue A1]`
        // logs `[PutFormula A1, PutValue A1]` (SetValue saw no formula
        // pre-batch, so emitted no ClearFormula), but replaying PutValue does
        // NOT clear the formula (`crates/ql-oplog/src/replay.rs:486-510`), so a
        // replay yields A1 with BOTH a value and a formula — divergent from the
        // live state where set_value clears the formula it now sees. Rejecting
        // any cell hit by >1 value/formula-affecting op (SetValue/SetFormula/
        // Clear) eliminates every such divergent ordering. SetFormat is
        // orthogonal (touches only the format overlay, independent of
        // value/formula on replay) and is deliberately NOT tracked here, so it
        // may coexist with one value/formula op on the same cell. This mirrors
        // (and is stricter than) WorkbookTransaction's ConflictingOps guard.
        let mut vf_targets: HashSet<CellAddr> = HashSet::with_capacity(ops.len());
        // Reject the SECOND value/formula op on a cell; names the offending cell.
        macro_rules! guard_vf_conflict {
            ($addr:expr) => {{
                if !vf_targets.insert(*$addr) {
                    return Err(EngineError::new(
                        ErrorClass::Conflict,
                        "conflicting_batch_ops",
                        format!(
                            "batch: cell (sheet {}, row {}, col {}) is targeted by more \
                             than one value/formula op (SetValue/SetFormula/Clear) in the \
                             same batch; a batch may touch each cell's value/formula at \
                             most once",
                            $addr.sheet, $addr.row, $addr.col
                        ),
                    ));
                }
            }};
        }

        for op in &ops {
            match op {
                SessionOp::SetValue { addr, value } => {
                    self.require_live_sheet(addr.sheet, "batch.set_value")?;
                    Self::require_in_bounds(addr.row, addr.col, "batch.set_value")?;
                    guard_vf_conflict!(addr);
                    // Reject Pending/Error/non-finite inputs exactly as
                    // `set_value` does (the runtime would too, but doing it
                    // here keeps validation fully up front / pre-mutation).
                    let v = cell_value_to_value(value.clone())?;
                    // **F2 Blank-durability closure (2026-05-27):** mirror
                    // `set_value` exactly — a Blank value (which
                    // `from_value` encodes as `None`) emits the durable
                    // `Op::ClearValue` rather than nothing, so a batched
                    // Blank-clear is reproducible on replay.
                    match CellWireValue::from_value(&v) {
                        Some(wire) => inner_ops.push(Op::PutValue {
                            sheet: addr.sheet,
                            row: addr.row,
                            col: addr.col,
                            value: wire,
                        }),
                        None => inner_ops.push(Op::ClearValue {
                            sheet: addr.sheet,
                            row: addr.row,
                            col: addr.col,
                        }),
                    }
                    // Mirror `set_value`: a `ClearFormula` lands iff the cell
                    // currently (pre-batch) has a formula.
                    if self
                        .workbook
                        .formula_at(addr.sheet, addr.row, addr.col)
                        .is_some()
                    {
                        inner_ops.push(Op::ClearFormula {
                            sheet: addr.sheet,
                            row: addr.row,
                            col: addr.col,
                        });
                    }
                    changes.push(SessionChange::Cell {
                        sheet: addr.sheet,
                        row: addr.row,
                        col: addr.col,
                    });
                }
                SessionOp::SetFormula { addr, text } => {
                    self.require_live_sheet(addr.sheet, "batch.set_formula")?;
                    Self::require_in_bounds(addr.row, addr.col, "batch.set_formula")?;
                    guard_vf_conflict!(addr);
                    // Canonicalize + bind-validate exactly as `set_formula`
                    // does (lex_with current mode/locale → parse → print_with
                    // A1/EnUs at the cell site → bind). The canonical text is
                    // what `set_formula` persists, so the `PutFormula` op
                    // matches what an individual edit would have logged.
                    let canonical = self.canonicalize_and_bind(*addr, text)?;
                    inner_ops.push(Op::PutFormula {
                        sheet: addr.sheet,
                        row: addr.row,
                        col: addr.col,
                        text: canonical.as_ref().to_owned(),
                    });
                    changes.push(SessionChange::Cell {
                        sheet: addr.sheet,
                        row: addr.row,
                        col: addr.col,
                    });
                }
                SessionOp::Clear { addr } => {
                    self.require_live_sheet(addr.sheet, "batch.clear")?;
                    Self::require_in_bounds(addr.row, addr.col, "batch.clear")?;
                    guard_vf_conflict!(addr);
                    // Mirror `clear_formula`: a no-formula cell is a no-op
                    // (no inner op, no change record). Otherwise emit the
                    // preserved-value `PutValue` (unless this cell is a spill
                    // anchor, whose value is part of the spill, or the value
                    // is Blank) followed by `ClearFormula`.
                    if self
                        .workbook
                        .formula_at(addr.sheet, addr.row, addr.col)
                        .is_some()
                    {
                        let is_spill_anchor = self
                            .workbook
                            .spill_anchor_at(addr.sheet, addr.row, addr.col)
                            .is_some();
                        if !is_spill_anchor {
                            let current = self
                                .workbook
                                .read(ql_types::Address::new(addr.sheet, addr.row, addr.col));
                            // Up-front finiteness guard so the append cannot
                            // fail on a non-finite preserved value (mirrors
                            // clear_formula's append-before-mutate guarantee).
                            if let Value::Number(n) = current {
                                if !n.is_finite() {
                                    return Err(EngineError::bad_argument(format!(
                                        "batch.clear: cell ({}, {}) holds a non-finite \
                                         value that cannot be preserved in the op log",
                                        addr.row, addr.col
                                    )));
                                }
                            }
                            if let Some(wire) = CellWireValue::from_value(&current) {
                                inner_ops.push(Op::PutValue {
                                    sheet: addr.sheet,
                                    row: addr.row,
                                    col: addr.col,
                                    value: wire,
                                });
                            }
                        }
                        inner_ops.push(Op::ClearFormula {
                            sheet: addr.sheet,
                            row: addr.row,
                            col: addr.col,
                        });
                        changes.push(SessionChange::Cell {
                            sheet: addr.sheet,
                            row: addr.row,
                            col: addr.col,
                        });
                    }
                }
                SessionOp::SetFormat { addr, format } => {
                    self.require_live_sheet(addr.sheet, "batch.set_format")?;
                    Self::require_in_bounds(addr.row, addr.col, "batch.set_format")?;
                    let id = dto_format_id_to_storage(*format);
                    // Mirror `set_cell_format`'s producer-side gate: refuse an
                    // unregistered id up front (BadArgument), pre-mutation.
                    if self.workbook.formats().lookup(id).is_none() {
                        return Err(EngineError::new(
                            ErrorClass::BadArgument,
                            "unknown_format_id",
                            format!("batch.set_format: format id {id:?} is not registered"),
                        ));
                    }
                    inner_ops.push(Op::SetCellFormat {
                        sheet: addr.sheet,
                        row: addr.row,
                        col: addr.col,
                        id: Some(ql_oplog::FormatIdWire::from_storage(id)),
                    });
                    changes.push(SessionChange::Cell {
                        sheet: addr.sheet,
                        row: addr.row,
                        col: addr.col,
                    });
                }
            }
        }

        // --- Phase 2: append the single BatchCommit BEFORE any mutation.
        // (Skip iff the batch reduced to zero inner ops — e.g. only
        // `SessionOp::Clear`s on cells that have no formula (mirroring
        // `clear_formula`'s no-op); then there is nothing to log and nothing
        // observable changed. Note: a `SetValue { Blank }` now ALWAYS emits a
        // durable `Op::ClearValue` (F2 closure), so it never contributes to
        // this zero-op case.) ---
        let applied = ops.len() as u32;
        if inner_ops.is_empty() {
            return Ok(BatchResult {
                applied,
                version: self.current_version(),
            });
        }
        self.oplog
            .append(Op::BatchCommit { ops: inner_ops })
            .map_err(oplog_append_err)?;

        // --- Phase 3: apply every op through a graph-maintaining runtime with
        // the op-log DETACHED, so the workbook + calcgraph update but NO second
        // per-op append happens. The inputs were validated in Phase 1; a
        // mutator error here would be an engine inconsistency → fail loud
        // (map_runtime_err, never swallowed). ---
        self.with_runtime_no_oplog(|rt| -> Result<(), RuntimeError> {
            for op in &ops {
                match op {
                    SessionOp::SetValue { addr, value } => {
                        let v = cell_value_to_value(value.clone())
                            .expect("batch.set_value: validated finite in Phase 1");
                        rt.set_value(addr.sheet, addr.row, addr.col, v)?;
                    }
                    SessionOp::SetFormula { addr, text } => {
                        rt.set_formula(addr.sheet, addr.row, addr.col, text.as_str())?;
                    }
                    SessionOp::Clear { addr } => {
                        rt.clear_formula(addr.sheet, addr.row, addr.col)?;
                    }
                    SessionOp::SetFormat { addr, format } => {
                        let id = dto_format_id_to_storage(*format);
                        rt.set_cell_format(addr.sheet, addr.row, addr.col, Some(id))?;
                    }
                }
            }
            Ok(())
        })
        .map_err(map_runtime_err)?;

        // --- Phase 4: advance state_seq exactly once for the whole batch. ---
        self.record_changes(changes);

        Ok(BatchResult {
            applied,
            version: self.current_version(),
        })
    }

    /// Begin a multi-call transaction (§3.4): allocate an opaque handle owning an
    /// empty `SessionOp` buffer. Legal only in `Ready` (you are starting a
    /// mutation sequence). The handle holds NO engine borrow — buffering is pure;
    /// the workbook is touched only at [`commit_transaction`].
    ///
    /// [`commit_transaction`]: WorkbookSession::commit_transaction
    fn begin_transaction(&mut self) -> EngineResult<TransactionId> {
        self.ensure_ready()?;
        let id = TransactionId(self.next_txn_id);
        // Fail-loud on id-space exhaustion (No-Fallbacks): never wrap, which
        // could reuse a live handle and overwrite its buffer. Practically
        // unreachable (2^64 begins), but the loud path is the correct one. The
        // handle is NOT inserted on exhaustion. (audit inc.2c-5 LOW)
        self.next_txn_id = self.next_txn_id.checked_add(1).ok_or_else(|| {
            EngineError::new(
                ErrorClass::Internal,
                "transaction_id_exhausted",
                "transaction id space exhausted (2^64 transactions begun in this session)",
            )
        })?;
        self.txns.insert(id, Vec::new());
        Ok(id)
    }

    /// Buffer an op into an open transaction (§3.4). Gated `Ready` (extending a
    /// transaction is forward progress — rejected on `Busy`/terminal with
    /// `invalid_state`, uniform with the other mutators, so a `Faulted`/`Closed`
    /// session cannot silently keep buffering ops that can never commit — audit
    /// inc.2c-5 MED). Unknown handle → `NotFound`/`transaction_not_found`
    /// (fail-loud, never a silent no-op). The op's *workbook validity* is **not**
    /// checked here — validation is atomic at commit (mirroring [`batch`]),
    /// against the workbook state *at commit time*, because the workbook may
    /// change between `txn_add` calls (the transaction holds no lock). Per-add
    /// validation against a stale state would be both weaker and inconsistent
    /// with the all-or-nothing commit guarantee.
    ///
    /// [`batch`]: WorkbookSession::batch
    fn txn_add(&mut self, txn: TransactionId, op: SessionOp) -> EngineResult<()> {
        self.ensure_ready()?;
        let buf = self
            .txns
            .get_mut(&txn)
            .ok_or_else(|| unknown_transaction(txn, "txn_add"))?;
        buf.push(op);
        Ok(())
    }

    /// Commit an open transaction (§3.4): drain its buffer through the SAME
    /// [`batch`] machinery (validate-all → one `Op::BatchCommit` → graph-
    /// maintaining apply → single `state_seq` tick). So a transaction inherits
    /// `batch`'s guarantees verbatim — validation-atomicity, graph consistency,
    /// one undo unit, and the same-cell value/formula conflict guard
    /// (`conflicting_batch_ops`): two value/formula ops buffered on one cell are
    /// rejected at commit, exactly as in a single-call `batch` (the replay
    /// divergence the guard prevents applies identically to a buffered txn).
    ///
    /// Unknown handle → `NotFound`. On a **failed** commit the buffer is
    /// **restored** (the transaction stays open): `batch` is validation-atomic so
    /// nothing was applied, and the caller may fix-and-retry or `rollback`. A
    /// successful commit consumes the handle. Gated `Ready` before the buffer is
    /// touched, so a `Busy`/terminal commit neither consumes nor applies.
    ///
    /// [`batch`]: WorkbookSession::batch
    fn commit_transaction(&mut self, txn: TransactionId) -> EngineResult<BatchResult> {
        self.ensure_ready()?;
        if !self.txns.contains_key(&txn) {
            return Err(unknown_transaction(txn, "commit_transaction"));
        }
        // Remove before committing; restore iff the commit fails (validation-
        // atomic → nothing applied → the transaction is still meaningfully open).
        let ops = self
            .txns
            .remove(&txn)
            .expect("contains_key checked immediately above");
        match self.batch(ops.clone(), BatchOptions::default()) {
            Ok(res) => Ok(res),
            Err(e) => {
                self.txns.insert(txn, ops);
                Err(e)
            }
        }
    }

    /// Discard an open transaction (§3.4): drop its buffer. Unknown handle →
    /// `NotFound`. Always legal (cleanup), regardless of lifecycle state.
    fn rollback_transaction(&mut self, txn: TransactionId) -> EngineResult<()> {
        self.txns
            .remove(&txn)
            .map(|_| ())
            .ok_or_else(|| unknown_transaction(txn, "rollback_transaction"))
    }

    // --- Recalculation (§3.7) ---

    fn recalc_dirty(&mut self) -> EngineResult<OperationId> {
        self.ensure_ready()?;
        Ok(self.run_recalc(|rt| rt.recompute_dirty()))
    }

    fn recalc_all(&mut self) -> EngineResult<OperationId> {
        self.ensure_ready()?;
        Ok(self.run_recalc(|rt| Some(rt.recompute_all())))
    }

    fn mark_volatiles_dirty(&mut self) -> EngineResult<()> {
        self.ensure_ready()?;
        let nodes: Vec<_> = self.graph.volatile_formulas().iter().copied().collect();
        for node in nodes {
            self.graph.mark_dirty(node);
        }
        Ok(())
    }

    // --- Query / snapshot (§3.6) ---

    fn query_range(
        &self,
        range: CellRange,
        options: RangeQueryOptions,
    ) -> EngineResult<RangeResult> {
        self.ensure_readable()?;
        // F7 / No-Fallbacks: the v1 `RangeColumn` carries values only. If the
        // caller requested extras we do not yet serve, fail loud rather than
        // silently returning a narrower result than asked for. Empty cells are
        // `CellValue::Blank` (added inc.2c) so the columnar shape stays
        // fixed-size.
        if options.include_formulas || options.include_formats || options.include_rendered {
            return Err(not_implemented(
                "query_range include_formulas/include_formats/include_rendered",
            ));
        }
        self.require_live_sheet(range.sheet, "query_range")?;
        let sheet = self
            .workbook
            .sheet(range.sheet)
            .expect("require_live_sheet verified the sheet exists");
        if range.end_row < range.start_row || range.end_col < range.start_col {
            return Err(EngineError::bad_argument(
                "range end coordinate is before its start",
            ));
        }
        // F4: reject out-of-grid corners (BadArgument). `Sheet::read` returns
        // `Blank` out-of-bounds, and an `end = u32::MAX` span would overflow the
        // `end - start + 1` arithmetic below before the cell-count cap.
        Self::require_in_bounds(range.start_row, range.start_col, "query_range")?;
        Self::require_in_bounds(range.end_row, range.end_col, "query_range")?;
        let n_rows = range.end_row - range.start_row + 1;
        let n_cols = range.end_col - range.start_col + 1;
        // Guard against an OOM on a pathological whole-sheet request (the read is
        // a deliberate caller request, but a fixed cap fails loud rather than
        // allocating gigabytes of Blanks).
        const MAX_CELLS: u64 = 1 << 20; // ~1M cells
        if (n_rows as u64) * (n_cols as u64) > MAX_CELLS {
            return Err(EngineError::bad_argument(format!(
                "range too large: {n_rows}x{n_cols} exceeds the {MAX_CELLS}-cell query cap"
            )));
        }
        let mut columns = Vec::with_capacity(n_cols as usize);
        for col in range.start_col..=range.end_col {
            let mut values = Vec::with_capacity(n_rows as usize);
            for row in range.start_row..=range.end_row {
                values.push(value_to_cell_value_dense(&sheet.read(row, col)));
            }
            columns.push(RangeColumn { values });
        }
        Ok(RangeResult {
            schema_version: SCHEMA_VERSION,
            range,
            n_rows,
            n_cols,
            columns,
        })
    }

    fn snapshot(&self) -> EngineResult<WorkbookSnapshot> {
        self.ensure_readable()?;
        let mut sheets = Vec::new();
        for &sheet_id in self.workbook.sheet_display_order() {
            if self.workbook.is_sheet_removed(sheet_id) {
                continue;
            }
            if let Some(snap) = self.build_sheet_snapshot(sheet_id) {
                sheets.push(snap);
            }
        }
        let formats = self
            .workbook
            .formats()
            .iter()
            .map(|(id, s)| FormatDef {
                id: storage_format_id_to_dto(id),
                string: s.to_string(),
            })
            .collect();
        let date_system = date_system_to_dto(self.workbook.date_system());
        Ok(WorkbookSnapshot {
            schema_version: SCHEMA_VERSION,
            sheets,
            formats,
            date_system,
            version: self.current_version(),
        })
    }

    fn snapshot_delta(&self, last_version: &SessionVersion) -> EngineResult<WorkbookSnapshotDelta> {
        // Design (a) — session change-log keyed by `state_seq` (impl-plan §0 item
        // 3, locked 2026-05-27). Keeps `&self`: the `&mut self` mutators + recalc
        // populate `change_log`; this reads it. Captures what an op-walk misses —
        // recompute-written dependents (`put_computed_at` appends no ops) —
        // because changes are recorded explicitly at the command, not derived
        // from the op-log. (Pre-F2 a `set_value(Blank)` clear also appended no
        // op; `Op::ClearValue` now closes that, but the recompute case remains.)
        self.ensure_readable()?;

        // §4.3 designed full-rebuild states (NOT errors) + the fail-loud
        // malformed-token error (§4.3 / MED-2 / No-Fallbacks).
        if last_version.0.is_empty() {
            // First call — no prior version to diff against.
            return Ok(self.full_rebuild_delta(FullRebuildReason::NoPriorVersion));
        }
        let (last_epoch, last_seq) = Self::decode_version(last_version)?;
        if last_epoch != self.epoch {
            // Reload/import/undo/move/restore/table-op minted a new epoch.
            return Ok(self.full_rebuild_delta(FullRebuildReason::EpochMismatch));
        }
        if last_seq > self.state_seq {
            // A single-writer session cannot have produced a future token →
            // malformed, fail loud (never a silent resync).
            return Err(EngineError::new(
                ErrorClass::Protocol,
                "invalid_version_token",
                format!(
                    "version token state_seq {last_seq} is ahead of current {}",
                    self.state_seq
                ),
            ));
        }
        if last_seq < self.change_log_floor {
            // Older than the retained change-log window — we cannot prove the
            // delta is complete, so reseed rather than under-report.
            return Ok(self.full_rebuild_delta(FullRebuildReason::StaleHorizon));
        }

        // Walk the records strictly after `last_seq`; dedup by target.
        let mut changed_coords: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
        let mut changed_sheets: HashSet<SheetId> = HashSet::new();
        let mut removed_sheets: HashSet<SheetId> = HashSet::new();
        let mut added_formats: HashSet<ql_storage::FormatId> = HashSet::new();
        for rec in self.change_log.iter().filter(|r| r.seq > last_seq) {
            match rec.change {
                SessionChange::Cell { sheet, row, col } => {
                    changed_coords.insert((sheet, row, col));
                }
                SessionChange::SheetChanged { id } => {
                    changed_sheets.insert(id);
                }
                SessionChange::SheetRemoved { id } => {
                    removed_sheets.insert(id);
                }
                SessionChange::FormatAdded { id } => {
                    added_formats.insert(id);
                }
            }
        }

        // Resolve cell changes to current committed state: present → changed,
        // absent → removed. A cell on a now-tombstoned sheet is conveyed via
        // `sheets_removed`, so skip it here (avoids a redundant per-cell entry).
        let mut changed_cells = Vec::new();
        let mut removed_cells = Vec::new();
        for (sheet, row, col) in changed_coords {
            if self.workbook.is_sheet_removed(sheet) {
                continue;
            }
            match self.build_cell_snapshot(sheet, row, col) {
                Some(cell) => changed_cells.push(ChangedCell { sheet, cell }),
                None => removed_cells.push(RemovedCell { sheet, row, col }),
            }
        }

        // Resolve changed sheets to full snapshots (a since-removed sheet is
        // reported only in `sheets_removed`).
        let mut sheets_changed = Vec::new();
        for id in changed_sheets {
            if removed_sheets.contains(&id) || self.workbook.is_sheet_removed(id) {
                continue;
            }
            if let Some(snap) = self.build_sheet_snapshot(id) {
                sheets_changed.push(snap);
            }
        }
        let sheets_removed: Vec<SheetId> = removed_sheets
            .into_iter()
            .filter(|id| self.workbook.is_sheet_removed(*id))
            .collect();

        // Resolve added formats to their current `FormatDef`.
        let formats_added: Vec<FormatDef> = added_formats
            .into_iter()
            .filter_map(|id| {
                self.workbook
                    .formats()
                    .iter()
                    .find(|(fid, _)| *fid == id)
                    .map(|(fid, s)| FormatDef {
                        id: storage_format_id_to_dto(fid),
                        string: s.to_string(),
                    })
            })
            .collect();

        Ok(WorkbookSnapshotDelta {
            schema_version: SCHEMA_VERSION,
            changed_cells,
            removed_cells,
            sheets_changed,
            sheets_removed,
            formats_added,
            version: self.current_version(),
            full_rebuild_required: false,
            full_rebuild_reason: None,
        })
    }

    fn cell(&self, addr: CellAddr) -> EngineResult<Option<CellSnapshot>> {
        self.ensure_readable()?;
        self.require_live_sheet(addr.sheet, "cell")?;
        Self::require_in_bounds(addr.row, addr.col, "cell")?; // F4
        Ok(self.build_cell_snapshot(addr.sheet, addr.row, addr.col))
    }

    fn list_sheets(&self) -> EngineResult<Vec<SheetInfo>> {
        self.ensure_readable()?;
        let mut out = Vec::new();
        for &sheet_id in self.workbook.sheet_display_order() {
            if self.workbook.is_sheet_removed(sheet_id) {
                continue;
            }
            if let Some(sheet) = self.workbook.sheet(sheet_id) {
                out.push(SheetInfo {
                    id: sheet_id,
                    name: sheet.name().to_string(),
                });
            }
        }
        Ok(out)
    }

    // --- Undo / redo (§3.8) ---

    /// Undo the last command (inc.2c-6). Asks Loro to retract the last commit
    /// (one undo unit = one command, by `set_merge_interval(0)` + the
    /// one-commit-per-command invariant — see the `undo_manager` field doc), then
    /// re-materializes the live workbook + graph from the now-compacted op-log
    /// ([`rematerialize`]).
    ///
    /// Empty undo stack ⇒ `consumed: false` with the version token UNCHANGED —
    /// NOT an error (contract §3.8). A consumed undo advances the token (epoch
    /// bump in `rematerialize`). A Loro-internal failure is mapped loud
    /// (`map_loro_undo_err` → `Internal`), never swallowed.
    ///
    /// [`rematerialize`]: WorkbookSession::rematerialize
    fn undo(&mut self) -> EngineResult<UndoRedoResult> {
        self.ensure_ready()?;
        let consumed = self.undo_manager.undo().map_err(map_loro_undo_err)?;
        if consumed {
            self.rematerialize()?;
        }
        Ok(UndoRedoResult {
            consumed,
            version: self.current_version(),
        })
    }

    /// Redo the last undone command (inc.2c-6). Symmetric to [`undo`]: Loro
    /// re-applies the previously-retracted commit, then we re-materialize.
    /// Empty redo stack ⇒ `consumed: false`, token unchanged.
    ///
    /// [`undo`]: WorkbookSession::undo
    fn redo(&mut self) -> EngineResult<UndoRedoResult> {
        self.ensure_ready()?;
        let consumed = self.undo_manager.redo().map_err(map_loro_undo_err)?;
        if consumed {
            self.rematerialize()?;
        }
        Ok(UndoRedoResult {
            consumed,
            version: self.current_version(),
        })
    }

    fn can_undo(&self) -> bool {
        self.undo_manager.can_undo()
    }

    fn can_redo(&self) -> bool {
        self.undo_manager.can_redo()
    }

    // --- Functions (§3.9; impl in 6.4) ---

    fn register_function(
        &mut self,
        _metadata: FunctionMetadata,
        _impl_handle: FunctionImplHandle,
    ) -> EngineResult<()> {
        Err(not_implemented("register_function"))
    }

    fn unregister_function(&mut self, _canonical_name: &str) -> EngineResult<()> {
        Err(not_implemented("unregister_function"))
    }

    fn list_functions(&self) -> EngineResult<Vec<FunctionMetadata>> {
        Err(not_implemented("list_functions"))
    }

    // --- Operations / events (§6 / §9) ---

    fn cancel(&mut self, op: OperationId) -> EngineResult<bool> {
        match self.ops.get(&op) {
            None => Err(EngineError::new(
                ErrorClass::NotFound,
                "operation_not_found",
                format!("no operation with id {}", op.0),
            )),
            // Already terminal — nothing to cancel. (In v1 the in-engine
            // recompute is synchronous and completes within its own call, so a
            // Running op is never observable to a serial caller; the registry +
            // pre-start-cancel shape is what the out-of-process 6.4/6.5 paths
            // reuse.)
            Some(state) if state.is_terminal() => Ok(false),
            Some(_) => {
                self.ops.insert(op, OperationState::Canceled);
                Ok(true)
            }
        }
    }

    fn operation_status(&self, op: OperationId) -> EngineResult<OperationState> {
        self.ops.get(&op).cloned().ok_or_else(|| {
            EngineError::new(
                ErrorClass::NotFound,
                "operation_not_found",
                format!("no operation with id {}", op.0),
            )
        })
    }

    fn poll_events(&mut self, cursor: EventCursor) -> EngineResult<EventPage> {
        let start = cursor.0 as usize;
        let events = if start < self.events.len() {
            self.events[start..].to_vec()
        } else {
            Vec::new()
        };
        Ok(EventPage {
            events,
            next_cursor: EventCursor(self.events.len() as u64),
            // v1: unbounded ring, no retention horizon yet → never drops.
            dropped: false,
        })
    }

    // --- Reserved bulk data / publish / bind (§3.5; impl 6.4/6.5) ---

    fn write_range(
        &mut self,
        _range: CellRange,
        _values: Vec<Vec<CellValue>>,
    ) -> EngineResult<WriteRangeResult> {
        Err(not_implemented("write_range"))
    }

    fn publish_dataset(
        &mut self,
        _name: &str,
        _data: serde_json::Value,
        _target: CellRange,
    ) -> EngineResult<PublishedRef> {
        Err(not_implemented("publish_dataset"))
    }

    fn bind_range(&mut self, _binding_id: &str, _target: CellRange) -> EngineResult<BoundRange> {
        Err(not_implemented("bind_range"))
    }

    fn refresh_source(&mut self, _source_id: &str, _revision: u64) -> EngineResult<DirtyResult> {
        Err(not_implemented("refresh_source"))
    }

    fn materialize_query(
        &mut self,
        _query_id: &str,
        _target: CellRange,
        _data: serde_json::Value,
    ) -> EngineResult<PublishedRef> {
        Err(not_implemented("materialize_query"))
    }
}

// ============================================================================
// Conversions (Appendix A — free functions, since orphan rules forbid
// `impl From<RuntimeError> for EngineError`).
// ============================================================================

/// Surfaced "not implemented in the v1 core yet" — a visible `Capability`
/// error, never a silent fallback (project No-Fallbacks rule; contract §3.5).
fn not_implemented(what: &str) -> EngineError {
    EngineError::new(
        ErrorClass::Capability,
        "not_implemented_in_v1_core",
        format!(
            "{what} is not implemented in the v1 WorkbookSession core yet \
             (Phase 6.1B inc.2 ships the core path; this lands in a later increment)"
        ),
    )
}

/// An operation referenced a transaction handle that is not open (never begun,
/// already committed, rolled back, or dropped at `close`). Fail-loud
/// `NotFound`/`transaction_not_found`, never a silent no-op (§3.4 / Appendix A).
fn unknown_transaction(txn: TransactionId, op: &str) -> EngineError {
    EngineError::new(
        ErrorClass::NotFound,
        "transaction_not_found",
        format!("{op}: no open transaction with id {}", txn.0),
    )
}

/// Map a `ql_types::Value` to the contract's `CellValue` (`None` for `Blank` —
/// a cell with no committed value). `Pending` has no `Value` analog.
fn value_to_cell_value(v: &Value) -> Option<CellValue> {
    match v {
        Value::Blank => None,
        Value::Number(n) => Some(CellValue::Number { number: *n }),
        Value::Boolean(b) => Some(CellValue::Boolean { boolean: *b }),
        Value::Text(s) => Some(CellValue::Text {
            text: s.to_string(),
        }),
        Value::Error(e) => Some(CellValue::Error {
            error: e.sigil().to_string(),
        }),
    }
}

/// Map a contract `CellValue` to a `ql_types::Value` for use as a literal input.
/// `Pending` and `Error` are rejected as inputs (an error VALUE is a formula
/// *output*, not a literal you type); non-finite numbers are rejected.
fn cell_value_to_value(cv: CellValue) -> EngineResult<Value> {
    match cv {
        CellValue::Number { number } => {
            if number.is_finite() {
                Ok(Value::Number(number))
            } else {
                Err(EngineError::bad_argument(
                    "numeric value must be finite (NaN/Inf rejected)",
                ))
            }
        }
        CellValue::Boolean { boolean } => Ok(Value::Boolean(boolean)),
        CellValue::Text { text } => Ok(Value::Text(Arc::from(text.as_str()))),
        CellValue::Error { error } => Err(EngineError::bad_argument(format!(
            "cannot set a cell to a literal error value ({error}); error values are formula outputs"
        ))),
        // Blank as an input means "clear the cell's value".
        CellValue::Blank => Ok(Value::Blank),
        CellValue::Pending => Err(EngineError::bad_argument(
            "Pending is a computed-state marker, not a valid input value",
        )),
    }
}

/// Dense `ql_types::Value` → `CellValue` for `query_range` (a fixed-size columnar
/// read must represent empties, so `Blank` maps to `CellValue::Blank` here —
/// unlike [`value_to_cell_value`], which returns `None` for snapshot's sparse,
/// blank-omitting cell list).
fn value_to_cell_value_dense(v: &Value) -> CellValue {
    match v {
        Value::Blank => CellValue::Blank,
        Value::Number(n) => CellValue::Number { number: *n },
        Value::Boolean(b) => CellValue::Boolean { boolean: *b },
        Value::Text(s) => CellValue::Text {
            text: s.to_string(),
        },
        Value::Error(e) => CellValue::Error {
            error: e.sigil().to_string(),
        },
    }
}

fn storage_format_id_to_dto(id: ql_storage::FormatId) -> FormatId {
    match id {
        ql_storage::FormatId::Builtin(n) => FormatId::Builtin { builtin: n },
        ql_storage::FormatId::Custom(peer, counter) => FormatId::Custom {
            peer: peer.as_u64(),
            counter,
        },
    }
}

fn dto_format_id_to_storage(id: FormatId) -> ql_storage::FormatId {
    match id {
        FormatId::Builtin { builtin } => ql_storage::FormatId::Builtin(builtin),
        FormatId::Custom { peer, counter } => {
            ql_storage::FormatId::Custom(ql_types::PeerId::new(peer), counter)
        }
    }
}

fn date_system_to_dto(ds: ql_types::DateSystem) -> DateSystem {
    match ds {
        ql_types::DateSystem::Excel1900 => DateSystem::Excel1900,
        ql_types::DateSystem::Excel1904 => DateSystem::Excel1904,
    }
}

/// Map a `RuntimeError` to the contract `EngineError` (Appendix A). Every named
/// variant is mapped explicitly; the `#[non_exhaustive]` catch-all surfaces a
/// loud `Internal` (NOT a silent fallback) — any variant reaching it is an
/// unmapped-variant bug to fix, per contract §5.3.
fn map_runtime_err(e: RuntimeError) -> EngineError {
    use RuntimeError as R;
    let display = e.to_string();
    match e {
        // Formula structural errors → Compute (a formula that *evaluates* to an
        // error is a CellValue::Error, not an EngineError; §5.5).
        R::Lex(_) | R::Parse(_) | R::Print(_) => {
            EngineError::new(ErrorClass::Compute, "formula_parse", display)
        }
        R::Bind(_) => EngineError::new(ErrorClass::Compute, "formula_bind", display),
        // Target/coordinate problems.
        R::InvalidSheet { .. } => {
            EngineError::new(ErrorClass::NotFound, "sheet_not_found", display)
        }
        R::InvalidCell { .. } => EngineError::new(ErrorClass::BadArgument, "bad_cell", display),
        R::ConflictingOps { .. } => {
            EngineError::new(ErrorClass::Conflict, "conflicting_ops", display)
        }
        // Op-log append failure (the inner OpLogError distinguishes the cause).
        R::OpLog(inner) => map_oplog_err(inner, display),
        // Name / sheet-name validation.
        R::Name(_) => EngineError::new(ErrorClass::BadArgument, "name_reserved", display),
        R::SheetName(ql_storage::SheetNameError::Duplicate { .. }) => {
            EngineError::new(ErrorClass::Conflict, "sheet_name_duplicate", display)
        }
        R::SheetName(_) => EngineError::new(ErrorClass::BadArgument, "bad_sheet_name", display),
        R::InvalidChunkRows(_) => {
            EngineError::new(ErrorClass::BadArgument, "invalid_chunk_rows", display)
        }
        R::TooManySheets { .. } => {
            EngineError::new(ErrorClass::Conflict, "too_many_sheets", display)
        }
        R::UnknownFormatId(_) => {
            EngineError::new(ErrorClass::BadArgument, "unknown_format_id", display)
        }
        R::FormatCounterExhausted { .. } => {
            EngineError::new(ErrorClass::Internal, "format_counter_exhausted", display)
        }
        R::RecomputeIterationCap => {
            EngineError::new(ErrorClass::Internal, "recompute_iteration_cap", display)
        }
        // Table ops.
        R::TableCreateRejected { .. } => {
            EngineError::new(ErrorClass::Conflict, "table_create_rejected", display)
        }
        R::TableNotFound(_) => EngineError::new(ErrorClass::NotFound, "table_not_found", display),
        R::TableColumnNotFound { .. } => {
            EngineError::new(ErrorClass::NotFound, "table_column_not_found", display)
        }
        R::TableColumnRejected { .. } => {
            EngineError::new(ErrorClass::Conflict, "table_column_rejected", display)
        }
        R::TableResizeRejected { .. } => {
            EngineError::new(ErrorClass::BadArgument, "table_resize_rejected", display)
        } // NOTE: no wildcard arm. `RuntimeError` is `#[non_exhaustive]`, but
          // this match is in the SAME crate, so it must be exhaustive — which is
          // exactly the safety the contract wants (§5.3): a newly-added variant
          // becomes a COMPILE error here, forcing an explicit mapping rather than
          // silently leaking through a catch-all.
    }
}

/// Map a `loro::UndoManager::{undo,redo}` failure to an `EngineError`
/// (inc.2c-6). Loro returns `LoroError` from `undo()`/`redo()` only for
/// genuinely internal conditions — a re-entrant call while another undo is in
/// flight (`UndoManager` is `&mut`-driven from the single-writer session, so
/// this is unreachable here), or a doc-internal checkout/import error. An empty
/// stack is NOT an error (Loro returns `Ok(false)`), so anything that DOES reach
/// here is an engine-internal fault, not a caller mistake → classify `Internal`
/// (NOT `Lifecycle`: the session lifecycle is `Ready` and valid; the fault is in
/// the undo machinery, and surfacing it as `Internal` matches how the other
/// "engine bug, not caller error" paths classify — e.g. `oplog_loro`,
/// `recompute_iteration_cap`). Never swallowed (No-Fallbacks): the error is
/// surfaced loud so an unexpected Loro undo failure is visible, not masked as a
/// no-op `consumed: false`.
fn map_loro_undo_err(e: loro::LoroError) -> EngineError {
    EngineError::new(
        ErrorClass::Internal,
        "undo_manager_failed",
        format!("undo/redo failed in the Loro undo manager: {e}"),
    )
}

/// Map a `ql_oplog::ReplayError` (from `replay_into` during undo/redo
/// re-materialization, inc.2c-6) to an `EngineError`. A replay failure means the
/// op-log — the single source of truth we rebuild the live workbook FROM —
/// could not be re-applied; that is a torn-engine / corrupt-log condition, not a
/// caller mistake → loud `Internal`. Never swallowed (No-Fallbacks): a failed
/// replay must surface, not silently leave the session on stale state.
fn map_replay_err(e: ql_oplog::replay::ReplayError) -> EngineError {
    EngineError::new(
        ErrorClass::Internal,
        "replay_failed",
        format!("re-materializing the workbook from the op-log failed: {e}"),
    )
}

/// Map a direct `OpLog::append` failure (the structure-op emission path —
/// delete/restore/move sheet append ops outside a `WorkbookRuntime`) to an
/// `EngineError`.
fn oplog_append_err(e: ql_oplog::OpLogError) -> EngineError {
    let msg = format!("op log append failed: {e}");
    map_oplog_err(e, msg)
}

/// Map a `ql_oplog::OpLogError` (surfaced via `RuntimeError::OpLog`) to an
/// `EngineError`. `display` is the outer RuntimeError's message (preserves the
/// "op log error: …" prefix).
fn map_oplog_err(e: ql_oplog::OpLogError, display: String) -> EngineError {
    use ql_oplog::OpLogError as O;
    match e {
        // serde refused the wire value (e.g. NaN/Inf) — a bad input.
        O::Serialize(_) => EngineError::new(ErrorClass::BadArgument, "oplog_serialize", display),
        O::Deserialize { .. } => {
            EngineError::new(ErrorClass::Protocol, "oplog_deserialize", display)
        }
        O::SchemaMismatch(_) => EngineError::new(ErrorClass::Protocol, "oplog_schema", display),
        O::InvalidVersionVector(_) => {
            EngineError::new(ErrorClass::Protocol, "invalid_version_vector", display)
        }
        // Loro-internal failures are engine bugs, not caller errors.
        O::Loro(_) | O::LoroEncode(_) => {
            EngineError::new(ErrorClass::Internal, "oplog_loro", display)
        }
        // `#[non_exhaustive]`: unmapped → loud Internal.
        _ => EngineError::new(ErrorClass::Internal, "unmapped_oplog_error", display),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(sheet: SheetId, row: RowId, col: ColId) -> CellAddr {
        CellAddr { sheet, row, col }
    }

    /// new → add_sheet → set_value → set_formula → recalc → snapshot/cell:
    /// the core golden path through the trait surface.
    #[test]
    fn core_edit_recalc_snapshot_round_trip() {
        let mut s = WorkbookSession::new();
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);

        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap();

        // set_formula evaluates immediately: B1 == 20.
        let b1 = s.cell(addr(sheet, 0, 1)).unwrap().unwrap();
        assert_eq!(b1.value, Some(CellValue::Number { number: 20.0 }));
        // set_formula canonicalizes (W5-147: spaced operators); snapshot
        // returns the stored canonical text.
        assert_eq!(b1.formula.as_deref(), Some("A1 * 2"));

        // Change A1 → B1 goes dirty; recalc_dirty re-evaluates it to 10.
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);

        let snap = s.snapshot().unwrap();
        assert_eq!(snap.sheets.len(), 1);
        let cells = &snap.sheets[0].cells;
        let a1 = cells.iter().find(|c| c.row == 0 && c.col == 0).unwrap();
        let b1 = cells.iter().find(|c| c.row == 0 && c.col == 1).unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 5.0 }));
        assert_eq!(b1.value, Some(CellValue::Number { number: 10.0 }));
        // set_formula canonicalizes (W5-147: spaced operators); snapshot
        // returns the stored canonical text.
        assert_eq!(b1.formula.as_deref(), Some("A1 * 2"));
    }

    #[test]
    fn version_token_advances_on_edit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let v1 = s.snapshot().unwrap().version;
        assert_ne!(v0, v1, "op_count must advance after an edit");
        // 24-byte {epoch(16) + op_count(8)} layout.
        assert_eq!(v1.0.len(), 24);
    }

    #[test]
    fn list_sheets_reflects_adds() {
        let mut s = WorkbookSession::new();
        s.add_sheet("Alpha", 16384).unwrap();
        s.add_sheet("Beta", 16384).unwrap();
        let sheets = s.list_sheets().unwrap();
        let names: Vec<&str> = sheets.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Alpha"));
        assert!(names.contains(&"Beta"));
    }

    #[test]
    fn set_value_on_missing_sheet_is_not_found() {
        let mut s = WorkbookSession::new();
        let err = s
            .set_value(addr(99, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "sheet_not_found");
    }

    #[test]
    fn non_finite_value_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let err = s
            .set_value(addr(sheet, 0, 0), CellValue::Number { number: f64::NAN })
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
    }

    #[test]
    fn closed_session_rejects_mutation_and_read() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.close().unwrap();
        assert_eq!(s.lifecycle_state(), LifecycleState::Closed);
        let mut_err = s
            .set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap_err();
        assert_eq!(mut_err.code, "invalid_state");
        let read_err = s.snapshot().unwrap_err();
        assert_eq!(read_err.code, "invalid_state");
    }

    #[test]
    fn deferred_methods_surface_capability_error() {
        let mut s = WorkbookSession::new();
        // `begin_transaction` ships in inc.2c-5; `undo`/`redo` ship in inc.2c-6
        // (no longer Capability errors). The remaining deferred methods still
        // surface the honest Capability error.
        for err in [
            s.open("/tmp/x.qbook").unwrap_err(),
            s.import(&[], "xlsx").unwrap_err(),
            s.list_functions().unwrap_err(),
        ] {
            assert_eq!(err.class, ErrorClass::Capability);
            assert_eq!(err.code, "not_implemented_in_v1_core");
        }
        // A fresh session has nothing to undo/redo (but the methods are real now).
        assert!(!s.can_undo());
        assert!(!s.can_redo());
        assert!(!s.undo().unwrap().consumed);
        assert!(!s.redo().unwrap().consumed);
    }

    #[test]
    fn recalc_emits_operation_completed_event() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1+1").unwrap();
        let op = s.recalc_dirty().unwrap();
        let page = s.poll_events(EventCursor(0)).unwrap();
        assert!(page.events.iter().any(|e| matches!(
            e,
            Event::OperationCompleted { op: o, .. } if *o == op
        )));
        assert!(!page.dropped);
    }

    #[test]
    fn validate_formula_valid_vs_invalid() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // A well-formed formula → no diagnostics. (Range-free: a *literal* range
        // like SUM(A2:A5) nested under an operator bind-fails in v1 scope by
        // design — see reference_fns_step4_e2e::formulatext_of_sum_literal_range_
        // bind_fails_v1_scope — and validate_formula correctly surfaces that.)
        let v = s.validate_formula(addr(sheet, 0, 0), "1 + 2 * 3").unwrap();
        assert!(v.is_empty(), "expected valid, got: {v:?}");
        let v2 = s.validate_formula(addr(sheet, 0, 0), "A1 * 2 + 5").unwrap();
        assert!(v2.is_empty(), "expected valid, got: {v2:?}");
        // A malformed formula → exactly one error diagnostic at the cell.
        let diags = s.validate_formula(addr(sheet, 0, 0), "1 +* 2").unwrap();
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[0].addr, Some(addr(sheet, 0, 0)));
    }

    #[test]
    fn query_range_is_columnar_with_blanks() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 2.0 })
            .unwrap();
        // B-column left empty.
        let r = s
            .query_range(
                CellRange {
                    sheet,
                    start_row: 0,
                    start_col: 0,
                    end_row: 1,
                    end_col: 1,
                },
                RangeQueryOptions::default(),
            )
            .unwrap();
        assert_eq!(r.n_rows, 2);
        assert_eq!(r.n_cols, 2);
        assert_eq!(r.columns.len(), 2);
        // Column A: [1, 2]; column B: [Blank, Blank].
        assert_eq!(
            r.columns[0].values,
            vec![
                CellValue::Number { number: 1.0 },
                CellValue::Number { number: 2.0 },
            ]
        );
        assert_eq!(
            r.columns[1].values,
            vec![CellValue::Blank, CellValue::Blank]
        );
    }

    #[test]
    fn query_range_rejects_inverted_and_oversize() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let inverted = s
            .query_range(
                CellRange {
                    sheet,
                    start_row: 5,
                    start_col: 0,
                    end_row: 0,
                    end_col: 0,
                },
                RangeQueryOptions::default(),
            )
            .unwrap_err();
        assert_eq!(inverted.class, ErrorClass::BadArgument);
    }

    #[test]
    fn delete_sheet_tombstones_and_unknown_is_not_found() {
        let mut s = WorkbookSession::new();
        s.add_sheet("Keep", 16384).unwrap();
        let drop_id = s.add_sheet("Drop", 16384).unwrap();
        // Unknown id → NotFound (NOT a silent no-op).
        let err = s.delete_sheet(9999).unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "sheet_not_found");
        // Valid delete tombstones the sheet (list_sheets drops it) + advances version.
        let v0 = s.snapshot().unwrap().version;
        s.delete_sheet(drop_id).unwrap();
        let names: Vec<String> = s
            .list_sheets()
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert!(names.contains(&"Keep".to_string()));
        assert!(!names.contains(&"Drop".to_string()));
        assert_ne!(v0, s.snapshot().unwrap().version);
        // Restore brings it back.
        s.restore_sheet(drop_id).unwrap();
        let names2: Vec<String> = s
            .list_sheets()
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert!(names2.contains(&"Drop".to_string()));
    }

    #[test]
    fn move_sheet_out_of_range_is_bad_argument_unknown_is_not_found() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        assert_eq!(
            s.move_sheet(sid, 9999).unwrap_err().class,
            ErrorClass::BadArgument
        );
        assert_eq!(
            s.move_sheet(9999, 0).unwrap_err().class,
            ErrorClass::NotFound
        );
        assert_eq!(s.restore_sheet(9999).unwrap_err().code, "sheet_not_found");
    }

    #[test]
    fn create_then_drop_table() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        let spec = TableSpec {
            name: "T".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 2,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".into(), "B".into()],
        };
        s.create_table(spec).unwrap();
        // Drop unknown → NotFound.
        assert_eq!(
            s.drop_table("NOPE").unwrap_err().class,
            ErrorClass::NotFound
        );
        // Drop the real one succeeds.
        s.drop_table("T").unwrap();
    }

    /// A tombstoned sheet must behave consistently everywhere: `snapshot`/
    /// `list_sheets` hide it, so reads + edits must also report it gone.
    #[test]
    fn tombstoned_sheet_is_not_found_for_reads_and_edits() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sid, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.delete_sheet(sid).unwrap();
        // Reads + edits on the tombstoned sheet all → NotFound (not stale data).
        assert_eq!(s.cell(addr(sid, 0, 0)).unwrap_err().code, "sheet_not_found");
        assert_eq!(
            s.set_value(addr(sid, 0, 0), CellValue::Number { number: 2.0 })
                .unwrap_err()
                .code,
            "sheet_not_found"
        );
        assert_eq!(
            s.validate_formula(addr(sid, 0, 0), "1+1").unwrap_err().code,
            "sheet_not_found"
        );
        assert_eq!(
            s.query_range(
                CellRange {
                    sheet: sid,
                    start_row: 0,
                    start_col: 0,
                    end_row: 0,
                    end_col: 0
                },
                RangeQueryOptions::default(),
            )
            .unwrap_err()
            .code,
            "sheet_not_found"
        );
        // Restore makes it live again — and the preserved value reappears.
        s.restore_sheet(sid).unwrap();
        assert_eq!(
            s.cell(addr(sid, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 1.0 })
        );
    }

    #[test]
    fn set_format_round_trips_through_cell() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let fmt = s.register_format("0.00%").unwrap();
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        // A format-only cell is still "populated" (format present).
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.format, Some(fmt));
        // Setting a format referencing an unregistered id → BadArgument.
        let bogus = FormatId::Custom {
            peer: 424242,
            counter: 999,
        };
        assert_eq!(
            s.set_format(addr(sheet, 0, 0), bogus).unwrap_err().class,
            ErrorClass::BadArgument
        );
    }

    #[test]
    fn clear_removes_the_formula_keeps_the_value() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "1 + 2").unwrap();
        let before = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(before.formula.as_deref(), Some("1 + 2"));
        assert_eq!(before.value, Some(CellValue::Number { number: 3.0 }));
        s.clear(addr(sheet, 0, 0)).unwrap();
        let after = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        // clear_formula strips the formula but preserves the scalar value.
        assert_eq!(after.formula, None);
        assert_eq!(after.value, Some(CellValue::Number { number: 3.0 }));
    }

    // --- Audit-fix coverage (2026-05-27 inc.2 audit) ---

    /// F5: a double-delete is a TRUE no-op — it does NOT append a spurious
    /// `Op::RemoveSheet` and does NOT advance the version token.
    #[test]
    fn double_delete_sheet_is_true_noop_no_version_advance() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.delete_sheet(sid).unwrap();
        let v_after_delete = s.snapshot().unwrap().version;
        // Second delete of the already-tombstoned sheet: Ok, but no op / no bump.
        s.delete_sheet(sid).unwrap();
        assert_eq!(
            v_after_delete,
            s.snapshot().unwrap().version,
            "double-delete must not advance the version token"
        );
    }

    /// F5: restoring a sheet that is NOT deleted is a Conflict, not a silent
    /// no-op that appends a spurious `Op::RestoreSheet`.
    #[test]
    fn restore_of_live_sheet_is_conflict() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let err = s.restore_sheet(sid).unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "sheet_not_deleted");
        assert_eq!(
            v0,
            s.snapshot().unwrap().version,
            "no token advance on rejected restore"
        );
    }

    /// F5: moving a sheet to its current position is a no-op (no token advance).
    #[test]
    fn move_sheet_to_current_index_is_noop() {
        let mut s = WorkbookSession::new();
        let a = s.add_sheet("A", 16384).unwrap();
        s.add_sheet("B", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        s.move_sheet(a, 0).unwrap(); // A is already at index 0
        assert_eq!(v0, s.snapshot().unwrap().version);
    }

    /// F6: structure edits on a tombstoned sheet are NotFound (rename + table).
    #[test]
    fn structure_edits_on_tombstoned_sheet_are_not_found() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.delete_sheet(sid).unwrap();
        assert_eq!(
            s.rename_sheet(sid, "X").unwrap_err().code,
            "sheet_not_found"
        );
        let spec = TableSpec {
            name: "T".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["C".into()],
        };
        assert_eq!(s.create_table(spec).unwrap_err().code, "sheet_not_found");
    }

    /// F4: read paths reject out-of-grid coordinates with BadArgument (rather
    /// than silently reading Blank or overflowing the range span).
    #[test]
    fn read_paths_reject_out_of_grid_coordinates() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // cell: col beyond MAX_COLUMN.
        let e = s
            .cell(addr(sheet, 0, ql_types::MAX_COLUMN + 1))
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::BadArgument);
        // query_range: end_row = u32::MAX would overflow end - start + 1.
        let e2 = s
            .query_range(
                CellRange {
                    sheet,
                    start_row: 0,
                    start_col: 0,
                    end_row: u32::MAX,
                    end_col: 0,
                },
                RangeQueryOptions::default(),
            )
            .unwrap_err();
        assert_eq!(e2.class, ErrorClass::BadArgument);
        // validate_formula: row beyond MAX_ROW.
        let e3 = s
            .validate_formula(addr(sheet, ql_types::MAX_ROW + 1, 0), "1+1")
            .unwrap_err();
        assert_eq!(e3.class, ErrorClass::BadArgument);
    }

    /// F7: query_range with an unsupported include option fails loud (Capability),
    /// rather than silently serving a narrower values-only result.
    #[test]
    fn query_range_include_options_fail_loud() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let err = s
            .query_range(
                CellRange {
                    sheet,
                    start_row: 0,
                    start_col: 0,
                    end_row: 0,
                    end_col: 0,
                },
                RangeQueryOptions {
                    include_formulas: true,
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Capability);
        assert_eq!(err.code, "not_implemented_in_v1_core");
    }

    // --- snapshot_delta (inc.2c-3) ---

    /// Empty token → designed full rebuild (NoPriorVersion), NOT an error.
    #[test]
    fn snapshot_delta_empty_token_is_full_rebuild() {
        let s = WorkbookSession::new();
        let d = s.snapshot_delta(&SessionVersion(vec![])).unwrap();
        assert!(d.full_rebuild_required);
        assert_eq!(
            d.full_rebuild_reason,
            Some(FullRebuildReason::NoPriorVersion)
        );
    }

    /// A malformed (wrong-length) token is fail-loud `invalid_version_token`
    /// (Protocol) — NEVER a silent full rebuild (§4.3 / No-Fallbacks).
    #[test]
    fn snapshot_delta_malformed_token_fails_loud() {
        let s = WorkbookSession::new();
        let err = s
            .snapshot_delta(&SessionVersion(vec![1, 2, 3]))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Protocol);
        assert_eq!(err.code, "invalid_version_token");
    }

    /// A token whose state_seq is ahead of the session is malformed → fail-loud.
    #[test]
    fn snapshot_delta_future_token_fails_loud() {
        let s = WorkbookSession::new();
        // {current epoch, state_seq = u64::MAX} — a future seq.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&s.epoch.to_be_bytes());
        bytes.extend_from_slice(&u64::MAX.to_be_bytes());
        let err = s.snapshot_delta(&SessionVersion(bytes)).unwrap_err();
        assert_eq!(err.class, ErrorClass::Protocol);
        assert_eq!(err.code, "invalid_version_token");
    }

    /// THE gating fix (F1): a delta MUST include recompute-changed dependents,
    /// even though recompute appends no ops. A1=10, B1=A1*2 (=20); token v0;
    /// set A1=5; recalc_dirty (B1→10 via put_computed_at, no op); the delta from
    /// v0 contains BOTH A1 (edited) and B1 (recompute-changed).
    #[test]
    fn snapshot_delta_includes_recompute_changed_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap();
        let v0 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        let d = s.snapshot_delta(&v0).unwrap();
        assert!(!d.full_rebuild_required, "same-epoch in-window delta");
        let changed: Vec<(u32, u32)> = d
            .changed_cells
            .iter()
            .map(|c| (c.cell.row, c.cell.col))
            .collect();
        assert!(
            changed.contains(&(0, 0)),
            "A1 (edited) must be in the delta"
        );
        assert!(
            changed.contains(&(0, 1)),
            "B1 (recompute-changed dependent, NO op) must be in the delta — the op-walk-insufficiency fix"
        );
        // The recomputed B1 value is the current one (10), resolved at delta time.
        let b1 = d
            .changed_cells
            .iter()
            .find(|c| c.cell.row == 0 && c.cell.col == 1)
            .unwrap();
        assert_eq!(b1.cell.value, Some(CellValue::Number { number: 10.0 }));
    }

    /// A token equal to the current version yields an empty (no-change) delta.
    #[test]
    fn snapshot_delta_no_changes_is_empty() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let v = s.snapshot().unwrap().version;
        let d = s.snapshot_delta(&v).unwrap();
        assert!(!d.full_rebuild_required);
        assert!(d.changed_cells.is_empty());
        assert!(d.removed_cells.is_empty());
        assert_eq!(d.version, v, "no change → token unchanged");
    }

    /// A cleared cell is reported in `removed_cells`.
    #[test]
    fn snapshot_delta_reports_removed_cell() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 2, 2), CellValue::Number { number: 7.0 })
            .unwrap();
        let v = s.snapshot().unwrap().version;
        // F2: set_value(Blank) clears a value-only cell. Post-F2 the runtime
        // appends a durable Op::ClearValue, AND the change-log records the
        // clear → token advances and the cell shows up in removed_cells.
        s.set_value(addr(sheet, 2, 2), CellValue::Blank).unwrap();
        assert_ne!(
            v,
            s.snapshot().unwrap().version,
            "Blank-clear must advance the token"
        );
        let d = s.snapshot_delta(&v).unwrap();
        assert!(!d.full_rebuild_required);
        assert!(
            d.removed_cells.iter().any(|r| r.row == 2 && r.col == 2),
            "cleared cell must appear in removed_cells"
        );
    }

    /// A table op bumps the epoch → a prior token gets EpochMismatch (the delta
    /// cannot incrementally express table cell rewrites).
    #[test]
    fn snapshot_delta_table_op_forces_epoch_mismatch() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let spec = TableSpec {
            name: "T".into(),
            sheet,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["C".into()],
        };
        s.create_table(spec).unwrap();
        let d = s.snapshot_delta(&v0).unwrap();
        assert!(d.full_rebuild_required);
        assert_eq!(
            d.full_rebuild_reason,
            Some(FullRebuildReason::EpochMismatch)
        );
    }

    /// Added + removed sheets surface as sheets_changed / sheets_removed.
    #[test]
    fn snapshot_delta_sheet_add_then_remove() {
        let mut s = WorkbookSession::new();
        let keep = s.add_sheet("Keep", 16384).unwrap();
        s.set_value(addr(keep, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let v0 = s.snapshot().unwrap().version;
        let added = s.add_sheet("Added", 16384).unwrap();
        let d = s.snapshot_delta(&v0).unwrap();
        assert!(!d.full_rebuild_required);
        assert!(d.sheets_changed.iter().any(|sh| sh.id == added));
        // Now delete it; a fresh delta from v1 reports it removed.
        let v1 = s.snapshot().unwrap().version;
        s.delete_sheet(added).unwrap();
        let d2 = s.snapshot_delta(&v1).unwrap();
        assert!(d2.sheets_removed.contains(&added));
    }

    // --- batch (inc.2c-4) ---

    /// A paste-style batch (several SetValue + a SetFormula referencing them)
    /// applies atomically: values land and the computed formula is correct.
    #[test]
    fn batch_paste_block_applies_atomically() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let ops = vec![
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 10.0 },
            },
            SessionOp::SetValue {
                addr: addr(sheet, 1, 0),
                value: CellValue::Number { number: 20.0 },
            },
            // B1 = A1 + A2 — references cells written EARLIER in the same batch.
            SessionOp::SetFormula {
                addr: addr(sheet, 0, 1),
                text: "A1 + A2".to_string(),
            },
        ];
        let res = s.batch(ops, BatchOptions::default()).unwrap();
        assert_eq!(res.applied, 3);
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 })
        );
        assert_eq!(
            s.cell(addr(sheet, 1, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 })
        );
        let b1 = s.cell(addr(sheet, 0, 1)).unwrap().unwrap();
        assert_eq!(b1.value, Some(CellValue::Number { number: 30.0 }));
        // Canonicalized text is stored (W5-147 spaced operators).
        assert_eq!(b1.formula.as_deref(), Some("A1 + A2"));
    }

    /// THE load-bearing graph-consistency proof: after a batch that sets A1 and
    /// a formula B1=A1*2, a LATER `set_value(A1)` + `recalc_dirty()` recomputes
    /// B1 correctly — i.e. the batch kept the session calcgraph live (the
    /// tension `WorkbookTransaction` could not resolve).
    #[test]
    fn batch_keeps_calcgraph_live_for_later_recalc() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.batch(
            vec![
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 10.0 },
                },
                SessionOp::SetFormula {
                    addr: addr(sheet, 0, 1),
                    text: "A1*2".to_string(),
                },
            ],
            BatchOptions::default(),
        )
        .unwrap();
        // B1 == 20 right after the batch.
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 })
        );
        // Change A1 OUTSIDE the batch → B1 must go dirty (graph saw the batch).
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 }),
            "B1 must recompute to A1*2 = 10 — proves the batch maintained the graph"
        );
    }

    /// Validation-atomicity: a batch containing one invalid op (malformed
    /// formula) returns the error and leaves the workbook + version token
    /// UNCHANGED — no earlier op in the batch is applied.
    #[test]
    fn batch_invalid_op_is_fully_rejected() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let err = s
            .batch(
                vec![
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 0),
                        value: CellValue::Number { number: 7.0 },
                    },
                    // Malformed formula → whole batch must roll back.
                    SessionOp::SetFormula {
                        addr: addr(sheet, 0, 1),
                        text: "1 +* 2".to_string(),
                    },
                ],
                BatchOptions::default(),
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Compute);
        // The earlier (valid) SetValue must NOT have landed.
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "no op may apply when the batch contains an invalid op"
        );
        assert_eq!(
            v0,
            s.snapshot().unwrap().version,
            "a rejected batch must not advance the version token"
        );
    }

    /// A batch targeting a tombstoned sheet is rejected (NotFound), nothing
    /// applied.
    #[test]
    fn batch_on_tombstoned_sheet_is_not_found() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.delete_sheet(sheet).unwrap();
        let err = s
            .batch(
                vec![SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 1.0 },
                }],
                BatchOptions::default(),
            )
            .unwrap_err();
        assert_eq!(err.code, "sheet_not_found");
    }

    /// One BatchCommit: the op-log gains EXACTLY one `Op::BatchCommit` for a
    /// multi-op batch, with the expected inner ops (PutValue + PutFormula).
    #[test]
    fn batch_emits_exactly_one_batch_commit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let len_before = s.oplog.len();
        s.batch(
            vec![
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 10.0 },
                },
                SessionOp::SetFormula {
                    addr: addr(sheet, 0, 1),
                    text: "A1*2".to_string(),
                },
            ],
            BatchOptions::default(),
        )
        .unwrap();
        assert_eq!(
            s.oplog.len() - len_before,
            1,
            "a batch must append exactly one op-log entry (one undo unit)"
        );
        let ops: Vec<Op> = s.oplog.iter().collect::<Result<_, _>>().unwrap();
        match ops.last().unwrap() {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2, "inner ops were: {inner:?}");
                assert!(matches!(inner[0], Op::PutValue { .. }));
                assert!(matches!(inner[1], Op::PutFormula { .. }));
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }
    }

    /// A SetValue over a pre-existing formula cell emits PutValue + ClearFormula
    /// inside the single BatchCommit (mirrors set_value's op shape).
    #[test]
    fn batch_set_value_over_formula_emits_clear_formula_inside_commit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Pre-existing formula at A1.
        s.set_formula(addr(sheet, 0, 0), "1 + 2").unwrap();
        let len_before = s.oplog.len();
        s.batch(
            vec![SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 99.0 },
            }],
            BatchOptions::default(),
        )
        .unwrap();
        assert_eq!(s.oplog.len() - len_before, 1);
        let ops: Vec<Op> = s.oplog.iter().collect::<Result<_, _>>().unwrap();
        match ops.last().unwrap() {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2, "inner ops were: {inner:?}");
                assert!(matches!(inner[0], Op::PutValue { .. }));
                assert!(matches!(inner[1], Op::ClearFormula { .. }));
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }
        // The formula is gone; the literal landed.
        let a1 = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 99.0 }));
        assert_eq!(a1.formula, None);
    }

    /// state_seq advances exactly once for the whole batch, and a
    /// `snapshot_delta` from a pre-batch token reports EVERY batched cell.
    #[test]
    fn batch_advances_state_seq_once_and_delta_reports_all_cells() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let (e0, seq0) = WorkbookSession::decode_version(&v0).unwrap();
        s.batch(
            vec![
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 1.0 },
                },
                SessionOp::SetValue {
                    addr: addr(sheet, 1, 0),
                    value: CellValue::Number { number: 2.0 },
                },
                SessionOp::SetFormula {
                    addr: addr(sheet, 0, 1),
                    text: "A1+A2".to_string(),
                },
            ],
            BatchOptions::default(),
        )
        .unwrap();
        let v1 = s.snapshot().unwrap().version;
        let (e1, seq1) = WorkbookSession::decode_version(&v1).unwrap();
        assert_eq!(e0, e1, "batch must not bump the epoch");
        assert_eq!(
            seq1,
            seq0 + 1,
            "the whole batch advances state_seq exactly once"
        );
        // The delta from v0 must contain ALL three batched cells.
        let d = s.snapshot_delta(&v0).unwrap();
        assert!(!d.full_rebuild_required);
        let changed: Vec<(u32, u32)> = d
            .changed_cells
            .iter()
            .map(|c| (c.cell.row, c.cell.col))
            .collect();
        assert!(changed.contains(&(0, 0)));
        assert!(changed.contains(&(1, 0)));
        assert!(changed.contains(&(0, 1)));
    }

    /// All four SessionOp variants are supported (no Capability error).
    /// SetFormat clears+rebinds; Clear strips a formula keeping its value.
    #[test]
    fn batch_supports_all_four_op_variants() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let fmt = s.register_format("0.00%").unwrap();
        // Seed a formula cell that the batch will Clear.
        s.set_formula(addr(sheet, 2, 0), "3 + 4").unwrap();
        let res = s
            .batch(
                vec![
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 0),
                        value: CellValue::Number { number: 5.0 },
                    },
                    SessionOp::SetFormula {
                        addr: addr(sheet, 0, 1),
                        text: "A1*3".to_string(),
                    },
                    SessionOp::SetFormat {
                        addr: addr(sheet, 0, 0),
                        format: fmt,
                    },
                    SessionOp::Clear {
                        addr: addr(sheet, 2, 0),
                    },
                ],
                BatchOptions::default(),
            )
            .unwrap();
        assert_eq!(res.applied, 4);
        // SetValue + SetFormat on A1.
        let a1 = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 5.0 }));
        assert_eq!(a1.format, Some(fmt));
        // SetFormula B1 = A1*3 = 15.
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 15.0 })
        );
        // Clear strips the formula at A3 but preserves its computed value (7).
        let a3 = s.cell(addr(sheet, 2, 0)).unwrap().unwrap();
        assert_eq!(a3.formula, None);
        assert_eq!(a3.value, Some(CellValue::Number { number: 7.0 }));
    }

    /// An empty batch is a no-op: no op appended, no token advance.
    #[test]
    fn batch_empty_is_noop() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let len_before = s.oplog.len();
        let res = s.batch(Vec::new(), BatchOptions::default()).unwrap();
        assert_eq!(res.applied, 0);
        assert_eq!(s.oplog.len(), len_before, "empty batch appends nothing");
        assert_eq!(v0, s.snapshot().unwrap().version);
    }

    /// A batch reduced to zero inner ops (a Blank-clear on a non-formula cell)
    /// appends no BatchCommit and does not advance the token — but still
    /// reports `applied` honestly.
    #[test]
    fn batch_blank_clear_on_blank_cell_appends_nothing() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let len_before = s.oplog.len();
        let res = s
            .batch(
                vec![SessionOp::Clear {
                    addr: addr(sheet, 5, 5),
                }],
                BatchOptions::default(),
            )
            .unwrap();
        assert_eq!(res.applied, 1, "applied counts the requested ops honestly");
        assert_eq!(
            s.oplog.len(),
            len_before,
            "a no-effect batch appends no BatchCommit"
        );
        assert_eq!(v0, s.snapshot().unwrap().version);
    }

    /// A non-finite literal in a batch is rejected up front (BadArgument),
    /// nothing applied.
    #[test]
    fn batch_non_finite_value_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let err = s
            .batch(
                vec![
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 0),
                        value: CellValue::Number { number: 1.0 },
                    },
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 1),
                        value: CellValue::Number {
                            number: f64::INFINITY,
                        },
                    },
                ],
                BatchOptions::default(),
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(s.cell(addr(sheet, 0, 0)).unwrap().is_none());
        assert_eq!(v0, s.snapshot().unwrap().version);
    }

    /// Two value/formula ops on the SAME cell (SetFormula then SetValue) are
    /// rejected as a Conflict (`conflicting_batch_ops`). This guards the
    /// pre-batch-built-log vs sequential-apply divergence: the log would carry
    /// `[PutFormula, PutValue]` with no ClearFormula, and replaying PutValue
    /// does not strip the formula (replay.rs:486-510) → a replay would diverge
    /// from the live state. The rejection is validation-atomic: workbook +
    /// version token UNCHANGED.
    #[test]
    fn batch_same_cell_formula_then_value_is_conflict() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let len_before = s.oplog.len();
        let err = s
            .batch(
                vec![
                    SessionOp::SetFormula {
                        addr: addr(sheet, 0, 0),
                        text: "1 + 1".to_string(),
                    },
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 0),
                        value: CellValue::Number { number: 5.0 },
                    },
                ],
                BatchOptions::default(),
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "conflicting_batch_ops");
        // Validation-atomic: nothing appended, nothing mutated, token unchanged.
        assert_eq!(
            s.oplog.len(),
            len_before,
            "a rejected batch appends no BatchCommit"
        );
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "no op may apply when the batch is rejected"
        );
        assert_eq!(
            v0,
            s.snapshot().unwrap().version,
            "a rejected batch must not advance the version token"
        );
    }

    /// SetValue then Clear on the SAME cell — both value/formula-affecting — is
    /// likewise a Conflict.
    #[test]
    fn batch_same_cell_value_then_clear_is_conflict() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let err = s
            .batch(
                vec![
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 0),
                        value: CellValue::Number { number: 5.0 },
                    },
                    SessionOp::Clear {
                        addr: addr(sheet, 0, 0),
                    },
                ],
                BatchOptions::default(),
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "conflicting_batch_ops");
        assert_eq!(v0, s.snapshot().unwrap().version);
    }

    /// SetValue + SetFormat on the SAME cell is ALLOWED: format is orthogonal to
    /// value/formula on replay, so it does not trigger the conflict guard. Both
    /// effects land.
    #[test]
    fn batch_same_cell_value_plus_format_is_ok() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let fmt = s.register_format("0.00%").unwrap();
        let res = s
            .batch(
                vec![
                    SessionOp::SetValue {
                        addr: addr(sheet, 0, 0),
                        value: CellValue::Number { number: 5.0 },
                    },
                    SessionOp::SetFormat {
                        addr: addr(sheet, 0, 0),
                        format: fmt,
                    },
                ],
                BatchOptions::default(),
            )
            .unwrap();
        assert_eq!(res.applied, 2);
        // Both the value and the format landed on the one cell.
        let a1 = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 5.0 }));
        assert_eq!(a1.format, Some(fmt));
    }

    // --- Multi-call transaction handle (inc.2c-5) ---

    /// begin → txn_add×3 → commit behaves exactly like the equivalent single
    /// `batch`: all ops apply atomically, intra-transaction references resolve,
    /// the token advances exactly one tick, and the handle is consumed.
    #[test]
    fn transaction_round_trip_commits_like_batch() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;

        let txn = s.begin_transaction().unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 10.0 },
            },
        )
        .unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 1, 0),
                value: CellValue::Number { number: 20.0 },
            },
        )
        .unwrap();
        // References cells buffered earlier in the SAME transaction.
        s.txn_add(
            txn,
            SessionOp::SetFormula {
                addr: addr(sheet, 0, 1),
                text: "A1 + A2".to_string(),
            },
        )
        .unwrap();

        let res = s.commit_transaction(txn).unwrap();
        assert_eq!(res.applied, 3);
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 })
        );
        // One state tick for the whole transaction.
        assert_ne!(v0, res.version);
        // Handle consumed: a second commit/rollback is NotFound.
        let err = s.commit_transaction(txn).unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "transaction_not_found");
    }

    /// Two concurrent transactions get distinct handles and buffer independently.
    #[test]
    fn begin_transaction_returns_distinct_ids() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let t1 = s.begin_transaction().unwrap();
        let t2 = s.begin_transaction().unwrap();
        assert_ne!(t1, t2);
        s.txn_add(
            t1,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 1.0 },
            },
        )
        .unwrap();
        s.txn_add(
            t2,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 1),
                value: CellValue::Number { number: 2.0 },
            },
        )
        .unwrap();
        // Committing t1 leaves t2 open and untouched.
        assert_eq!(s.commit_transaction(t1).unwrap().applied, 1);
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 1.0 })
        );
        assert!(s.cell(addr(sheet, 0, 1)).unwrap().is_none());
        assert_eq!(s.commit_transaction(t2).unwrap().applied, 1);
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 2.0 })
        );
    }

    /// An unknown handle is fail-loud `NotFound`/`transaction_not_found` on every
    /// handle-taking method (never a silent no-op).
    #[test]
    fn unknown_transaction_handle_is_not_found() {
        let mut s = WorkbookSession::new();
        let ghost = TransactionId(9999);
        for err in [
            s.txn_add(
                ghost,
                SessionOp::Clear {
                    addr: addr(0, 0, 0),
                },
            )
            .unwrap_err(),
            s.commit_transaction(ghost).unwrap_err(),
            s.rollback_transaction(ghost).unwrap_err(),
        ] {
            assert_eq!(err.class, ErrorClass::NotFound);
            assert_eq!(err.code, "transaction_not_found");
        }
    }

    /// rollback discards the buffer: nothing applies, the token is unchanged, and
    /// the handle is gone afterward.
    #[test]
    fn rollback_discards_buffered_ops() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let txn = s.begin_transaction().unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 42.0 },
            },
        )
        .unwrap();
        s.rollback_transaction(txn).unwrap();
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "rolled-back ops must not apply"
        );
        assert_eq!(
            v0,
            s.snapshot().unwrap().version,
            "rollback must not advance the token"
        );
        // Handle consumed.
        assert_eq!(
            s.rollback_transaction(txn).unwrap_err().code,
            "transaction_not_found"
        );
    }

    /// Committing an empty transaction is a no-op: 0 applied, token unchanged.
    #[test]
    fn commit_empty_transaction_is_noop() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let txn = s.begin_transaction().unwrap();
        let res = s.commit_transaction(txn).unwrap();
        assert_eq!(res.applied, 0);
        assert_eq!(v0, res.version);
        assert_eq!(v0, s.snapshot().unwrap().version);
    }

    /// A transaction whose buffer contains an invalid op is rejected atomically
    /// at commit (nothing applied, token unchanged) AND — because `batch` is
    /// validation-atomic — the handle STAYS OPEN so the caller can fix/rollback.
    #[test]
    fn transaction_invalid_op_rejected_atomically_handle_stays_open() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let len_before = s.oplog.len();
        let txn = s.begin_transaction().unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 7.0 },
            },
        )
        .unwrap();
        s.txn_add(
            txn,
            SessionOp::SetFormula {
                addr: addr(sheet, 0, 1),
                text: "1 +* 2".to_string(), // malformed
            },
        )
        .unwrap();
        let err = s.commit_transaction(txn).unwrap_err();
        assert_eq!(err.class, ErrorClass::Compute);
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "no op may apply when the commit is rejected"
        );
        assert_eq!(v0, s.snapshot().unwrap().version);
        // No BatchCommit was appended (commit failed in Phase 1) — this is WHY
        // re-inserting the buffer is safe: a later retry can't double-apply.
        assert_eq!(
            s.oplog.len(),
            len_before,
            "a rejected commit must not append a BatchCommit"
        );
        // Handle is STILL OPEN — rollback succeeds (would be NotFound if consumed).
        s.rollback_transaction(txn)
            .expect("a failed commit must leave the transaction open");
    }

    /// A transaction inherits `batch`'s same-cell value/formula conflict guard:
    /// two value/formula ops on one cell are rejected at commit, handle stays open.
    #[test]
    fn transaction_same_cell_conflict_rejected_at_commit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        let len_before = s.oplog.len();
        let txn = s.begin_transaction().unwrap();
        s.txn_add(
            txn,
            SessionOp::SetFormula {
                addr: addr(sheet, 0, 0),
                text: "1 + 1".to_string(),
            },
        )
        .unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 5.0 },
            },
        )
        .unwrap();
        let err = s.commit_transaction(txn).unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "conflicting_batch_ops");
        // Validation-atomic: nothing appended, token unchanged, handle still open.
        assert_eq!(s.oplog.len(), len_before);
        assert_eq!(v0, s.snapshot().unwrap().version);
        s.rollback_transaction(txn)
            .expect("a rejected commit must leave the transaction open");
    }

    /// The buffer is validated against the workbook state AT COMMIT TIME (the
    /// transaction holds no lock): a sheet deleted between `txn_add` and `commit`
    /// makes the commit fail-loud `NotFound`.
    #[test]
    fn transaction_validated_at_commit_time_not_add_time() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let txn = s.begin_transaction().unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 1.0 },
            },
        )
        .unwrap(); // accepted: sheet is live at add time
        s.delete_sheet(sheet).unwrap();
        let err = s.commit_transaction(txn).unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "sheet_not_found");
        // Commit failed → handle still open.
        s.rollback_transaction(txn).unwrap();
    }

    /// `commit_transaction` on a Closed session is `invalid_state` (gated before
    /// the buffer is touched); `close` also drops all open transaction buffers.
    #[test]
    fn commit_on_closed_session_is_invalid_state() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let txn = s.begin_transaction().unwrap();
        s.close().unwrap();
        let err = s.commit_transaction(txn).unwrap_err();
        assert_eq!(err.class, ErrorClass::Lifecycle);
        assert_eq!(err.code, "invalid_state");
        // begin_transaction is likewise rejected on a terminal session.
        assert_eq!(s.begin_transaction().unwrap_err().code, "invalid_state");
    }

    /// `txn_add` on a terminal session is `invalid_state` (gated before the
    /// handle lookup), uniform with the other mutators — a Faulted/Closed session
    /// cannot keep buffering ops that could never commit (audit inc.2c-5 MED).
    #[test]
    fn txn_add_on_closed_session_is_invalid_state() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let txn = s.begin_transaction().unwrap();
        s.close().unwrap();
        let err = s
            .txn_add(
                txn,
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 1.0 },
                },
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Lifecycle);
        assert_eq!(err.code, "invalid_state");
    }

    // --- Undo / redo (inc.2c-6) ---

    /// **Audit regression (Codex HIGH / Opus M1, inc.2c-7):** a session wrapping
    /// a PRE-POPULATED workbook must not lose that baseline content when a later
    /// session edit is undone. `rematerialize` replays the (post-undo) op-log
    /// onto a CLONE of the construction-time baseline — NOT a fresh empty
    /// workbook — so pre-loaded cells survive (and redo cannot fail replay for
    /// lack of an `AddSheet`).
    #[test]
    fn undo_preserves_prepopulated_baseline_workbook() {
        let mut wb = Workbook::new();
        let sheet = wb.add_sheet("Base");
        // Baseline content: present at construction, NOT recorded in the op-log.
        wb.put_at(sheet, 0, 0, Value::Number(42.0));
        let mut s = WorkbookSession::from_workbook(wb);

        // A session edit — THIS is in the op-log (and the undo stack).
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 7.0 })
            .unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 7.0 })
        );

        // Undo the session edit. The undone cell is gone; the BASELINE survives.
        let res = s.undo().unwrap();
        assert!(res.consumed);
        assert!(
            s.cell(addr(sheet, 0, 1)).unwrap().is_none(),
            "the undone session edit must be gone"
        );
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 42.0 }),
            "the pre-loaded baseline cell must NOT be dropped by undo (Codex HIGH)"
        );

        // Redo re-applies the edit onto the preserved baseline (no replay failure).
        let res = s.redo().unwrap();
        assert!(res.consumed);
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 42.0 })
        );
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 7.0 })
        );
    }

    /// undo a `set_value` → the cell reverts; redo → it reapplies; the version
    /// token changes after each consumed step.
    #[test]
    fn undo_redo_set_value_reverts_and_reapplies() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 42.0 })
            .unwrap();
        let v_after_set = s.snapshot().unwrap().version;
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 42.0 })
        );
        assert!(s.can_undo());

        // Undo: the cell goes back to empty; token changes; redo now available.
        let r = s.undo().unwrap();
        assert!(r.consumed);
        assert_ne!(v_after_set, r.version, "a consumed undo advances the token");
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "undo must revert the set_value"
        );
        assert!(s.can_redo());

        // Redo: the value reappears; token changes again.
        let v_after_undo = s.snapshot().unwrap().version;
        let r2 = s.redo().unwrap();
        assert!(r2.consumed);
        assert_ne!(
            v_after_undo, r2.version,
            "a consumed redo advances the token"
        );
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 42.0 }),
            "redo must reapply the set_value"
        );
    }

    /// undo a `set_formula` → the formula is gone AND its dependent reverts
    /// (proves the recompute ran during re-materialization).
    #[test]
    fn undo_set_formula_reverts_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 })
        );
        // Undo the set_formula: B1's formula is gone and the cell is empty again.
        assert!(s.undo().unwrap().consumed);
        assert!(
            s.cell(addr(sheet, 0, 1)).unwrap().is_none(),
            "undo must remove the formula and its computed value"
        );
        // A1 (set earlier, a separate undo unit) is untouched.
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 })
        );
    }

    /// THE F2 payoff: undo a `set_value(Blank)` clear → the prior value is
    /// RESTORED. Before F2 the Blank-clear appended no op, so undo could not
    /// reconstruct the cleared value; `Op::ClearValue` makes it replayable, and
    /// undo retracts that op so the prior value re-materializes.
    #[test]
    fn undo_blank_clear_restores_prior_value() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 3, 3), CellValue::Number { number: 7.0 })
            .unwrap();
        // Clear the value via set_value(Blank) — its own undo unit (Op::ClearValue).
        s.set_value(addr(sheet, 3, 3), CellValue::Blank).unwrap();
        assert!(
            s.cell(addr(sheet, 3, 3)).unwrap().is_none(),
            "the Blank-clear emptied the cell"
        );
        // Undo the clear → the prior value (7) is back. This is the F2 fix.
        assert!(s.undo().unwrap().consumed);
        assert_eq!(
            s.cell(addr(sheet, 3, 3)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 7.0 }),
            "undo of a Blank-clear must restore the prior value (F2 payoff)"
        );
    }

    /// undo a `batch` (multi-op) → the WHOLE batch reverts as ONE undo unit:
    /// a single `undo()` call empties every cell the batch touched.
    #[test]
    fn undo_batch_reverts_whole_batch() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.batch(
            vec![
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 1.0 },
                },
                SessionOp::SetValue {
                    addr: addr(sheet, 1, 0),
                    value: CellValue::Number { number: 2.0 },
                },
                SessionOp::SetFormula {
                    addr: addr(sheet, 0, 1),
                    text: "A1+A2".to_string(),
                },
            ],
            BatchOptions::default(),
        )
        .unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 3.0 })
        );
        // ONE undo reverts the entire batch (one Op::BatchCommit = one unit).
        let r = s.undo().unwrap();
        assert!(r.consumed);
        assert!(s.cell(addr(sheet, 0, 0)).unwrap().is_none());
        assert!(s.cell(addr(sheet, 1, 0)).unwrap().is_none());
        assert!(s.cell(addr(sheet, 0, 1)).unwrap().is_none());
        // The batch was a single undo unit: exactly ONE more unit remains (the
        // earlier `add_sheet`); undoing it empties the stack. (If the batch had
        // split into multiple units, this single extra undo would not clear it.)
        assert!(s.can_undo(), "the add_sheet unit still remains");
        assert!(s.undo().unwrap().consumed, "undo the add_sheet");
        assert!(
            !s.can_undo(),
            "after the batch (one unit) + add_sheet (one unit) the stack is empty"
        );
    }

    /// HARD QUESTION 1 granularity proof: `clear` of a formula cell is ONE undo
    /// unit. `clear_formula` of a value-bearing formula emits PutValue +
    /// ClearFormula, which `WorkbookRuntime::clear_formula` wraps in a single
    /// `Op::BatchCommit` (one commit). So a single `undo()` fully reverts the
    /// clear — the formula AND its value come back in one step.
    #[test]
    fn undo_clear_of_formula_cell_is_one_unit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "3 + 4").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 7.0 })
        );
        s.clear(addr(sheet, 0, 0)).unwrap();
        // clear preserves the scalar value, strips the formula.
        let after_clear = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(after_clear.formula, None);
        assert_eq!(after_clear.value, Some(CellValue::Number { number: 7.0 }));
        // ONE undo restores the formula AND its computed value together.
        assert!(s.undo().unwrap().consumed);
        let restored = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(
            restored.formula.as_deref(),
            Some("3 + 4"),
            "undo of clear must restore the formula in one unit"
        );
        assert_eq!(restored.value, Some(CellValue::Number { number: 7.0 }));
        // The clear + the set_formula are two distinct units; after undoing the
        // clear, one more undo unit (the set_formula) remains.
        assert!(s.can_undo());
    }

    /// undo on an empty stack → `consumed: false`, NOT an error, token unchanged.
    /// A brand-new session has issued NO commands → nothing on the undo stack.
    /// (NOTE: `add_sheet` is itself an undoable command — a single `Op::AddSheet`
    /// commit — so a session that added a sheet would have a non-empty stack; the
    /// empty-stack case must use a pristine session.)
    #[test]
    fn undo_empty_stack_is_not_error_token_unchanged() {
        let mut s = WorkbookSession::new();
        assert!(!s.can_undo(), "a pristine session has nothing to undo");
        let v0 = s.snapshot().unwrap().version;
        let r = s.undo().unwrap();
        assert!(
            !r.consumed,
            "empty undo stack ⇒ consumed:false (not an error)"
        );
        assert_eq!(r.version, v0, "an empty undo must not advance the token");
        assert_eq!(
            v0,
            s.snapshot().unwrap().version,
            "session state unchanged after empty undo"
        );
    }

    /// redo on an empty stack → `consumed: false` (mirrors undo).
    #[test]
    fn redo_empty_stack_is_not_error() {
        let mut s = WorkbookSession::new();
        let v0 = s.snapshot().unwrap().version;
        let r = s.redo().unwrap();
        assert!(!r.consumed);
        assert_eq!(r.version, v0);
    }

    /// undo→redo round-trip returns to the SAME observable state (cell values
    /// equal); `can_undo`/`can_redo` reflect the stack across edit→undo→redo.
    #[test]
    fn undo_redo_round_trip_restores_state_and_flags_track() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 100.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1 + 1").unwrap();
        // Capture the post-edit observable state.
        let a1 = s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value;
        let b1 = s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value;
        assert_eq!(b1, Some(CellValue::Number { number: 101.0 }));

        // Flags before any undo: can_undo true, can_redo false.
        assert!(s.can_undo());
        assert!(!s.can_redo());

        // Undo both edits. (The earlier `add_sheet` is a THIRD undo unit that we
        // leave on the stack, so `can_undo` stays true here.)
        assert!(s.undo().unwrap().consumed); // undo set_formula
        assert!(s.undo().unwrap().consumed); // undo set_value
        assert!(s.can_redo());
        assert!(
            s.can_undo(),
            "the add_sheet unit still remains after undoing both edits"
        );
        assert!(s.cell(addr(sheet, 0, 0)).unwrap().is_none());
        assert!(s.cell(addr(sheet, 0, 1)).unwrap().is_none());

        // Redo both edits → identical observable state.
        assert!(s.redo().unwrap().consumed); // redo set_value
        assert!(s.redo().unwrap().consumed); // redo set_formula
        assert!(!s.can_redo(), "both edits redone");
        assert!(s.can_undo());
        assert_eq!(s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value, a1);
        assert_eq!(s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value, b1);
    }

    /// After a consumed undo, `snapshot_delta(old_token)` returns
    /// `full_rebuild_required: true` (EpochMismatch) — the wholesale
    /// re-materialization bumps the epoch.
    #[test]
    fn snapshot_delta_after_undo_forces_full_rebuild() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let v_before_undo = s.snapshot().unwrap().version;
        assert!(s.undo().unwrap().consumed);
        let d = s.snapshot_delta(&v_before_undo).unwrap();
        assert!(d.full_rebuild_required, "undo must force a full rebuild");
        assert_eq!(
            d.full_rebuild_reason,
            Some(FullRebuildReason::EpochMismatch)
        );
    }

    /// HARD QUESTION 2 (a): rename a sheet, then make + undo an UNRELATED later
    /// edit → the sheet KEEPS its renamed name after re-materialization (linear
    /// replay reproduces the rename faithfully; no ql-collab repair pass needed).
    #[test]
    fn undo_unrelated_edit_preserves_earlier_rename() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("Original", 16384).unwrap();
        s.set_value(addr(sid, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.rename_sheet(sid, "Renamed").unwrap();
        // An unrelated later edit (a different cell), then undo it.
        s.set_value(addr(sid, 5, 5), CellValue::Number { number: 9.0 })
            .unwrap();
        assert!(s.undo().unwrap().consumed); // undo the (5,5) edit only
                                             // The rename must survive the re-materialization.
        let names: Vec<String> = s
            .list_sheets()
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert!(
            names.contains(&"Renamed".to_string()),
            "linear replay must preserve the rename; got {names:?}"
        );
        assert!(!names.contains(&"Original".to_string()));
        // The unrelated edit is gone; the original A1 value survives.
        assert!(s.cell(addr(sid, 5, 5)).unwrap().is_none());
        assert_eq!(
            s.cell(addr(sid, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 1.0 })
        );
    }

    /// HARD QUESTION 2 (b): rename a sheet TWICE (A→B→C), undo once → back to B
    /// (the previous name), with cells intact. Proves linear replay reproduces a
    /// rename CHAIN exactly (each RenameSheet keys off the current name).
    #[test]
    fn undo_one_of_two_renames_returns_to_intermediate_name() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("A", 16384).unwrap();
        s.set_value(addr(sid, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.rename_sheet(sid, "B").unwrap();
        s.rename_sheet(sid, "C").unwrap();
        assert_eq!(s.list_sheets().unwrap()[0].name, "C");
        // Undo the A→...→C's last rename (B→C) → name is B again.
        assert!(s.undo().unwrap().consumed);
        let names: Vec<String> = s
            .list_sheets()
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert_eq!(names, vec!["B".to_string()], "undo of B→C returns to B");
        // Cells intact.
        assert_eq!(
            s.cell(addr(sid, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 5.0 })
        );
    }

    /// HARD QUESTION 2 (c): a table rename + undo re-materializes faithfully via
    /// linear replay (no repair pass). After undo, the OLD table name resolves
    /// (drop succeeds) and the new name does not (drop → NotFound).
    #[test]
    fn undo_table_rename_restores_old_name() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        let spec = TableSpec {
            name: "Orig".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 2,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".into(), "B".into()],
        };
        s.create_table(spec).unwrap();
        s.rename_table("Orig", "NewName").unwrap();
        // Undo the rename → "Orig" exists again, "NewName" does not.
        assert!(s.undo().unwrap().consumed);
        // Dropping "NewName" must now be NotFound (the rename was reverted).
        assert_eq!(
            s.drop_table("NewName").unwrap_err().class,
            ErrorClass::NotFound
        );
        // Dropping "Orig" succeeds (the original name is back).
        s.drop_table("Orig")
            .expect("undo of table rename must restore the old table name");
    }

    /// Table-rename undo is ONE unit: a `rename_table` of a table that has a
    /// formula REFERENCING it emits ONE `Op::BatchCommit`
    /// (`[RenameTable, PutFormula]`) after the F10 fix → already one commit = one
    /// undo unit (and the `grouped` wrapper is defense-in-depth). A single
    /// `undo()` reverts the entire rename (table name AND the rewritten formula
    /// text), never a torn intermediate state.
    #[test]
    fn undo_table_rename_with_formula_ref_is_one_unit() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        let spec = TableSpec {
            name: "Sales".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["Amount".into()],
        };
        s.create_table(spec).unwrap();
        // A formula referencing the table by name → its stored text mentions
        // "Sales", so rename_table will rewrite it (an extra PutFormula commit).
        // `SUM(Sales[Amount])` is the v1-binding structured-reference form used
        // by the WorkbookRuntime rename_table happy-path test.
        s.set_formula(addr(sid, 10, 0), "SUM(Sales[Amount])")
            .unwrap();
        let stored_before = s.cell(addr(sid, 10, 0)).unwrap().unwrap().formula.unwrap();
        assert!(
            stored_before.contains("Sales"),
            "formula text should reference the table: {stored_before}"
        );

        // Rename → the formula text is rewritten to the new name.
        s.rename_table("Sales", "Revenue").unwrap();
        let stored_after = s.cell(addr(sid, 10, 0)).unwrap().unwrap().formula.unwrap();
        assert!(
            stored_after.contains("Revenue") && !stored_after.contains("Sales"),
            "rename should rewrite the reference: {stored_after}"
        );

        // ONE undo reverts BOTH the table rename AND the formula rewrite — the
        // grouping proof. (Without grouping, this single undo would revert only
        // the last PutFormula, leaving the table still named "Revenue".)
        assert!(s.undo().unwrap().consumed);
        let stored_restored = s.cell(addr(sid, 10, 0)).unwrap().unwrap().formula.unwrap();
        assert!(
            stored_restored.contains("Sales") && !stored_restored.contains("Revenue"),
            "one undo must restore the original formula reference: {stored_restored}"
        );
        // The table name is back to "Sales" (drop by old name succeeds).
        assert_eq!(
            s.drop_table("Revenue").unwrap_err().class,
            ErrorClass::NotFound,
            "the new table name must be gone after a single undo"
        );
        s.drop_table("Sales")
            .expect("one undo must restore the old table name together with the formula");
    }

    /// undo a transaction commit (begin→txn_add→commit→undo) → the whole
    /// committed transaction reverts as ONE undo unit (it routed through `batch`
    /// → one `Op::BatchCommit`).
    #[test]
    fn undo_committed_transaction_reverts_as_one_unit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let txn = s.begin_transaction().unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 0, 0),
                value: CellValue::Number { number: 11.0 },
            },
        )
        .unwrap();
        s.txn_add(
            txn,
            SessionOp::SetValue {
                addr: addr(sheet, 1, 0),
                value: CellValue::Number { number: 22.0 },
            },
        )
        .unwrap();
        s.commit_transaction(txn).unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 11.0 })
        );
        // ONE undo reverts the entire committed transaction.
        assert!(s.undo().unwrap().consumed);
        assert!(s.cell(addr(sheet, 0, 0)).unwrap().is_none());
        assert!(s.cell(addr(sheet, 1, 0)).unwrap().is_none());
        // The committed transaction was a single undo unit: exactly ONE more
        // unit (the earlier add_sheet) remains; undoing it empties the stack.
        assert!(s.can_undo(), "the add_sheet unit still remains");
        assert!(s.undo().unwrap().consumed, "undo the add_sheet");
        assert!(
            !s.can_undo(),
            "the committed transaction collapsed to exactly one undo unit"
        );
    }

    /// undo/redo are gated `Ready`: a Closed session rejects them with
    /// `invalid_state` (uniform with the other mutators).
    #[test]
    fn undo_redo_on_closed_session_is_invalid_state() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        s.close().unwrap();
        assert_eq!(s.undo().unwrap_err().code, "invalid_state");
        assert_eq!(s.redo().unwrap_err().code, "invalid_state");
    }

    /// A new edit AFTER an undo clears the redo stack (standard undo semantics):
    /// edit → undo (redo available) → new edit → redo no longer available.
    #[test]
    fn new_edit_after_undo_clears_redo_stack() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        assert!(s.undo().unwrap().consumed);
        assert!(s.can_redo());
        // A fresh edit invalidates the redo stack.
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 2.0 })
            .unwrap();
        assert!(!s.can_redo(), "a new edit must clear the redo stack");
        assert!(s.can_undo());
    }
}
