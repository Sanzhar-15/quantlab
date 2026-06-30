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
//! `SessionOp` buffer that commits through the same `batch` machinery) +
//! **`undo`/`redo`** (inc.2c-7) + **`.qbook` `open`/`save`** (inc.2c-9 — Option 1:
//! reconstruct from the envelope, fresh op-log/undo history) + **xlsx `import`**
//! (inc.2c-10 — same Option-1 adoption, via `ql_io_xlsx` + the injected
//! `EngineXlsxRecomputer`) + **`csv` `import`/`export`** (inc.2c-11 — via the
//! pure-I/O `ql_io_csv`; no recompute since CSV has no formulas) are also real.
//! **xlsx `export`** (inc.2c-12 — whole-workbook, via `ql_io_xlsx` behind the
//! `xlsx-write` feature so the default reader-only build stays lean; without
//! the feature it returns the honest `Capability` error) is also real. The
//! remaining contract methods return a **surfaced** `Capability` /
//! `not_implemented_in_v1_core` error (NOT a silent fallback — project
//! No-Fallbacks rule) and land in later sub-increments:
//! - function registration (6.4), reserved bulk ops (6.4/6.5).
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

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::env::UdfCellDiagnostic;
use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{NamedTarget, Workbook};
use ql_types::{ColId, RowId, SheetId, Value};
use ql_udf::UdfWorker;

// 6.5-1: Arrow types for building per-table/sheet RecordBatches (SQL inputs) and
// converting a SQL result RecordBatch back to cell values.
use arrow_array::builder::{BooleanBuilder, Float64Builder, StringBuilder};
use arrow_array::{
    Array, ArrayRef, BooleanArray, Float32Array, Float64Array, Int16Array, Int32Array, Int64Array,
    Int8Array, LargeStringArray, RecordBatch, StringArray, UInt16Array, UInt32Array, UInt64Array,
    UInt8Array,
};
use arrow_schema::{DataType, Field, Schema};

use ql_formula_syntax::{lex, lex_with, parse, print_with, FormulaSite};
use ql_io::CellWireValue;
use ql_oplog::Op;
use ql_session::dto::{
    BatchOptions, BatchResult, BindDirection, BindingInfo, BorderEdge as BorderEdgeDto,
    BorderStyle as BorderStyleDto,
    Borders as BordersDto, BoundRange, CellAddr, CellLineage, CellRange, CellSnapshot, CellValue,
    ChangedCell, DateSystem, Diagnostic, DirtyResult, FormatDef, FormatId, FullRebuildReason,
    HAlign as HAlignDto, LineageKind, NamedRange, NamedTargetDto, PublishedRef, RangeColumn,
    RangeQueryOptions, RangeResult, RemovedCell, Rgb as RgbDto, SessionVersion, Severity,
    SheetInfo, SheetSnapshot, Style as StyleDto, StyleDef, StyleId as StyleIdDto, TableSnapshot,
    TableSpec, UndoRedoResult, WorkbookSnapshot, WorkbookSnapshotDelta, WriteRangeResult,
};
use ql_session::error::{EngineError, EngineResult, ErrorClass};
use ql_session::function_meta::FunctionMetadata;
use ql_session::operation::{LifecycleState, OperationId, OperationState, RecalcKind};
use ql_session::session::{
    EngineSession, Event, EventCursor, EventPage, FunctionImplHandle, SessionOp, TransactionId,
};
use ql_session::SCHEMA_VERSION;

use crate::structural::{build_structural_batch, StructuralAxis, StructuralError, StructuralKind};
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
    /// **FE-4 W4 (2026-06-10):** a style registered (resolved to a `StyleDef`
    /// at delta time — the visual-formatting analog of `FormatAdded`).
    StyleAdded { id: ql_storage::StyleId },
}

struct ChangeRecord {
    seq: u64,
    change: SessionChange,
}

/// RAII guard that transitions the session to [`LifecycleState::Faulted`] if
/// dropped while still armed (i.e., the wrapped block panicked). Lifted to
/// module scope from the two inline copies in [`WorkbookSession::with_runtime`]
/// and [`WorkbookSession::with_runtime_no_oplog`] so the **6.1C audit-fix M3**
/// non-runtime mutator paths (`delete_sheet`, `restore_sheet`, `move_sheet`,
/// `mark_volatiles_dirty`, and `batch`'s Phase 2 op-log append) can reuse it
/// without duplicating the pattern. Disarmed on the normal return path; the
/// drop is a no-op when `armed == false`.
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

/// **6.5-2:** typed per-cell provenance record stored in
/// [`WorkbookSession::cell_provenance`]. Records which source last wrote a cell
/// and at which revision — the cell-keyed half of the dual provenance index.
struct CellProvenance {
    /// The `source_id` (query_id) that last produced this cell.
    source_id: String,
    /// The revision at which the source last wrote this cell. Starts at `0`
    /// for a direct `materialize_query`; updated to the caller-supplied
    /// revision on every successful `refresh_source`. Carried per the locked
    /// typed-provenance contract (source_id + revision). Read by `cell_lineage`
    /// (R23) to report the cell's lineage revision; refresh still dirties via the
    /// source-level reverse index.
    revision: u64,
}

/// **ENG-FUSION:** which producer wrote a provenance entry. `refresh_source` re-runs
/// only `Query` (SQL) sources through `materialize_query`; a `Published` dataset
/// (`qb.publish`) is updated by RE-publishing (its producer is external — a Python
/// value — so the engine cannot re-run it), so `refresh_source` rejects it loudly
/// rather than mis-parsing the stored `{"values":...}` payload as SQL (No-Fallbacks).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ProducerKind {
    /// `materialize_query` — `data = {"sql": "..."}`, refreshable.
    Query,
    /// `publish_dataset` — `data = {"values": [[...]]}`, NOT refresh_source-able.
    Published,
}

/// **6.5-2:** per-source provenance record stored in [`WorkbookSession::provenance`].
/// Holds enough state to re-run `materialize_query` on `refresh_source` and
/// to report the cells produced in the last materialization (the reverse index).
struct ProvenanceEntry {
    /// **ENG-FUSION:** the producer that wrote this entry (gates `refresh_source`).
    kind: ProducerKind,
    /// The revision at which this source was last successfully materialized.
    /// Starts at 0 (first call sets it on the first `refresh_source`). A
    /// `refresh_source(revision)` with `revision <= stored` is a no-op.
    revision: u64,
    /// The `data` argument (`{"sql": "..."}` for Query, `{"values": [[...]]}` for
    /// Published) needed to re-run / re-record the producer.
    data: serde_json::Value,
    /// The `target` range passed to the last `materialize_query` call.
    target: CellRange,
    /// Cells produced in the last materialization (row-major, anchored at
    /// `target`'s top-left). Empty for a zero-row result. This is the
    /// `source_id → produced_cells` reverse index.
    cells: Vec<CellAddr>,
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
    /// **M2 (6.3-1b):** the in-flight recalc reserved by [`start_recalc`] and
    /// drained by [`await_recalc`] — `Some((op, kind))` between those two calls,
    /// `None` otherwise. This is what makes the **pre-start cancel window** real:
    /// `start_recalc` allocates the op, marks it `Running`, sets the session
    /// `Busy`, and RETURNS (releasing the binding lock) without recomputing; a
    /// `cancel(op)` landing before `await_recalc` flips the op to `Canceled`, and
    /// `await_recalc` then skips the recompute entirely (contract §6.4 pre-start
    /// cancel; the synchronous compute core cannot do mid-flight abort — §6.3).
    /// The session is `Busy` while this is `Some`, so no second `start_recalc` and
    /// no mutation can interleave; the caller MUST `await_recalc` (even after a
    /// `cancel`) to drain it back to `Ready`.
    ///
    /// [`start_recalc`]: WorkbookSession::start_recalc
    /// [`await_recalc`]: WorkbookSession::await_recalc
    pending_recalc: Option<(OperationId, RecalcKind)>,
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
    /// **6.4-3c (2026-05-29):** the out-of-process Python-UDF worker, if one is
    /// configured (via [`set_udf_worker`]). `None` until the IDE/host injects
    /// one. `RefCell` provides the interior mutability that bridges the shared-
    /// `&` eval stack to [`ql_udf::UdfWorker::call`]'s `&mut self`: `with_runtime`
    /// lends `&self.udf_worker` to the per-edit `WorkbookRuntime`, which threads
    /// it into the eval env. Single-writer + single-threaded recompute, so the
    /// `!Sync` `RefCell` is sound. A registered UDF with NO worker evaluates to
    /// `#CALC!` at the dispatch site (No-Fallbacks-honest), never a panic. The
    /// full napi/IDE injection bridge (+ `debugpy` / trusted-workspace gating) is
    /// 6.4-3d; this field + [`set_udf_worker`] are the minimal in-engine surface.
    ///
    /// [`set_udf_worker`]: WorkbookSession::set_udf_worker
    udf_worker: Option<RefCell<Box<dyn UdfWorker + Send>>>,
    /// **6.4-3d (2026-05-29; megaudit blocker G):** per-recompute collector for
    /// UDF-dispatch diagnostics. `with_runtime`/`with_runtime_no_oplog` lend
    /// `&self.udf_diagnostics` into the runtime (alongside `udf_worker`); the
    /// dispatch site pushes a [`crate::env::UdfCellDiagnostic`] on a failed (or
    /// no-worker) `=MYUDF(..)`; the same helpers DRAIN it into
    /// `Event::CellDiagnostic` after the runtime borrow ends. Always-present
    /// (cheap empty `Vec`), unlike `udf_worker`. `!Sync` `RefCell` is sound
    /// under single-threaded recompute. The cell VALUE is unchanged — this is
    /// purely the "why did the UDF fail" channel (exit test 7).
    udf_diagnostics: RefCell<Vec<UdfCellDiagnostic>>,
    /// **H3 (6.3-0):** per-edit collector for spill-footprint TARGET cells (the
    /// NON-anchor cells of a dynamic-array spill) touched by a DIRECT mutation.
    /// [`with_runtime`]/[`with_runtime_no_oplog`] CLEAR it at entry and lend
    /// `&self.spill_footprint` to the runtime (alongside `udf_diagnostics`); the
    /// `set_formula`/`set_value`/`clear` runtime primitives push their footprint
    /// targets; and the owning command DRAINS it (via [`drain_spill_footprint`])
    /// into its delta change-log alongside the anchor — so `snapshot_delta`
    /// reports the FULL footprint, not just the anchor. Unlike `udf_diagnostics`
    /// (drained automatically into the event stream by the `with_runtime`
    /// helpers), this is drained by the specific command, because only
    /// `set_formula`/`set_value`/`clear`/`batch` fold it into `record_changes`;
    /// the recompute paths record footprints through `RecomputeResult.changed_cells`
    /// instead. Always-present (cheap empty `Vec`); `!Sync` `RefCell` sound under
    /// single-threaded edits.
    ///
    /// [`with_runtime`]: WorkbookSession::with_runtime
    /// [`with_runtime_no_oplog`]: WorkbookSession::with_runtime_no_oplog
    /// [`drain_spill_footprint`]: WorkbookSession::drain_spill_footprint
    spill_footprint: RefCell<Vec<(SheetId, RowId, ColId)>>,
    /// **6.4B (item H):** operation-level UDF time budget armed on each recalc pass
    /// (see [`run_recalc`]). Default [`crate::scalar::UDF_OP_BUDGET`] (120s); bounds
    /// a recompute touching N slow UDF cells to ~this instead of N × the per-call
    /// deadline (the "N×30s stall"). Settable via [`set_udf_op_budget`] (used by
    /// tests; a host-config / per-function-deadline surface is filed forward, not
    /// yet bound over napi).
    ///
    /// [`run_recalc`]: WorkbookSession::run_recalc
    /// [`set_udf_op_budget`]: WorkbookSession::set_udf_op_budget
    udf_op_budget: std::time::Duration,
    /// **6.5-2:** `source_id → ProvenanceEntry` reverse index. Populated by
    /// `materialize_query` on every successful write; consumed by `refresh_source`
    /// to revision-gate re-runs and dirty exactly the produced cells' dependents.
    provenance: HashMap<String, ProvenanceEntry>,
    /// **6.5-2:** `cell_addr → CellProvenance` typed per-cell map — the cell-keyed
    /// half of the dual provenance index. Records which source last wrote each cell
    /// and at which revision. Updated by `materialize_query` (revision=0 baseline)
    /// and by `refresh_source` (advanced to the caller's revision). Stale entries
    /// (cells a source no longer produces after a shrinking result) are evicted by
    /// `refresh_source`.
    cell_provenance: HashMap<CellAddr, CellProvenance>,
    /// **ENG-FUSION + TE1 (var↔cell moat — D-IDENTITY):** `binding_id →
    /// BindingInfo` registry — the single engine-owned source of truth for the
    /// Python-var↔grid-range binding. Written by `bind_range` (the declaration
    /// half) and `publish_dataset` (the data half) via `upsert_binding`; read by
    /// `binding`/`bindings`/`cell_lineage`. Unlike the provenance maps
    /// (data-derived, cleared on undo/redo), a binding is a region POINTER so it
    /// is KEPT across undo/redo — but DEC-B marks it `force_check` when the
    /// rebuild wipes its provenance (see `rematerialize`). Session-local: NEVER
    /// serialized into `.qbook` (a binding without a live kernel is inert).
    /// Re-binding/re-publishing an id upserts after validation (No-Fallbacks,
    /// never a silent default).
    bindings: HashMap<String, BindingInfo>,
    /// **TE1 HIGH-1 (w135):** the CURRENT net-active structural-edit set, recomputed
    /// at the end of every [`rematerialize`] from the op-log. Read by `upsert_binding`
    /// to STAMP each binding's birth set (the grid it was declared under) into
    /// `binding_birth_structural`. Between rematerializes it is stable (structural row/
    /// col ops only ever enter via `apply_structural_edit`, which rematerializes), so
    /// the stamp is the live active set without re-walking the log. Session-local, NOT
    /// serialized into `.qbook`. See [`StructuralEditRecord`] and [`rematerialize`].
    ///
    /// [`rematerialize`]: WorkbookSession::rematerialize
    active_structural: Vec<StructuralEditRecord>,
    /// **TE1 HIGH-1 (w135):** per-binding BIRTH net-active structural set — the
    /// structural edits active when each binding was declared/upserted (a snapshot of
    /// `active_structural` at that moment). Keyed by `binding_id`, parallel to
    /// `bindings` (stamped in `upsert_binding`, dropped in `unbind`). `rematerialize`
    /// invalidates an alive binding iff the CURRENT active set has an edit intersecting
    /// its target that was NOT in its birth set — so a redo that merely RESTORES the
    /// binding's birth grid is correctly a no-op (a session-global active-set diff
    /// over-invalidated that case — Codex round-2 followup). NOT in `.qbook`.
    binding_birth_structural: HashMap<String, Vec<StructuralEditRecord>>,
}

/// **TE1 HIGH-1 (w135):** one net-active ROW/COLUMN structural edit, recovered from
/// the op-log. `rematerialize` recomputes the active set (`collect_active_structural_edits`)
/// from the CURRENT op-log on every undo/redo and invalidates each alive binding for
/// which the active set gained an intersecting edit RELATIVE TO that binding's birth
/// set (`binding_birth_structural`) — closing the redo×`bind_range` gap (Codex
/// round-2 HIGH) without over-invalidating a redo that merely restores the birth grid.
/// Sheet-delete (`Op::RemoveSheet`) is NOT collected here; it is handled by the
/// sheet-liveness check in `rematerialize`. Deliberately NOT a `VersionVector`: the
/// op-log VV is MONOTONIC across undo/redo (undo appends an inverse op → the VV only
/// grows, so it still "includes" an edit after that edit's effect was undone),
/// whereas `OpLog::iter()` — the materialized LoroList that `replay_into` consumes —
/// reflects net-active state (an undone op is absent, a redone op present). The op
/// sequence is the correct signal; the causal VV is not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StructuralEditRecord {
    sheet: SheetId,
    axis: StructuralAxis,
    kind: StructuralKind,
}

/// **TE1 HIGH-1 (w135):** multiset difference `now \ base` — the structural edits
/// active NOW that were not active in `base` (a binding's birth set). A MULTISET (not
/// a set) so a second identical edit counts as newly-active; compared by VALUE (not op
/// identity) because the D-RANGEMOVE predicate depends only on (sheet, axis, kind) —
/// two equal records invalidate exactly the same bindings, and a pure reorder of the
/// active set (no add/remove) leaves the net grid unchanged, so an empty diff is
/// correct. O(n·m) over the handful of structural edits in a session.
fn newly_active_structural(
    now: &[StructuralEditRecord],
    base: &[StructuralEditRecord],
) -> Vec<StructuralEditRecord> {
    let mut remaining: Vec<StructuralEditRecord> = base.to_vec();
    let mut newly = Vec::new();
    for edit in now {
        if let Some(pos) = remaining.iter().position(|p| p == edit) {
            // Carried over from `base` (consume the match so duplicates count).
            remaining.swap_remove(pos);
        } else {
            newly.push(*edit);
        }
    }
    newly
}

/// **TE1 HIGH-1 (w135):** the D-RANGEMOVE anchored predicate — does `record` (a row/
/// col structural edit) intersect or precede `target` on its axis? A target is safe
/// ONLY if it lies entirely before the edit position along the edited axis
/// (`end < edit_start`). Shared by the forward `invalidate_bindings_for_structural_edit`
/// and the birth-relative `rematerialize` pass so both use one predicate.
fn structural_edit_affects(record: &StructuralEditRecord, target: &CellRange) -> bool {
    if record.sheet != target.sheet {
        return false;
    }
    let edit_start = match record.kind {
        StructuralKind::Insert { at, .. } => at,
        StructuralKind::Delete { start, .. } => start,
    };
    match record.axis {
        StructuralAxis::Row => target.end_row >= edit_start,
        StructuralAxis::Col => target.end_col >= edit_start,
    }
}

impl WorkbookSession {
    /// Construct a fresh, empty in-memory session (→ `Ready`). The `new(options)`
    /// product command (§3.1).
    pub fn new() -> Self {
        Self::from_workbook(Workbook::new())
    }

    /// Wrap an existing `Workbook` (e.g. a hand-built test workbook; later the
    /// product of `open`/`import`) using a CALLER-PROVIDED registry `Arc`.
    /// Rebuilds the calc graph from the workbook's formulas — extracting deps,
    /// arg-context, and volatility against THAT registry — so dependency
    /// tracking is live and consistent with the registry the session will hold.
    ///
    /// **6.4-2 cycle-2 audit-fix (F2 — Codex):** the `open`/`import` adoption
    /// sites need this overload. They previously did
    /// `*self = Self::from_workbook(wb); self.registry = preserved_registry;`
    /// — but `from_workbook` builds the graph against a FRESH `default_registry()`,
    /// so after the post-hoc `self.registry =` swap the graph was extracted
    /// UDF-free while `self.registry` was UDF-aware: a graph⊥registry divergence
    /// the increment introduces once 6.4-2 lets a UDF be registered before an
    /// adoption. (`open` self-healed via its post-swap `recompute_all`, which
    /// rebuilds the graph against `self.registry`; xlsx `import` does NOT
    /// recompute after the swap, so its graph stayed divergent.) Passing the
    /// preserved registry into construction closes the divergence at the source
    /// for ALL adoption sites and removes `open`'s wasteful double graph build.
    /// This is the same divergence class the 6.4-0 H2 + 6.4-1 H1 audit-fixes
    /// closed at `recompute_all` / `rematerialize`; the adoption-site variant
    /// was the gap those sweeps missed.
    pub fn from_workbook_with_registry(
        workbook: Workbook,
        registry: Arc<FunctionRegistry>,
    ) -> Self {
        let graph =
            CalcgraphSession::rebuild_from_workbook_with_registry(&workbook, &registry).session;
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
        // **TF8 / Wave-C (2026-06-29):** exclude format/style *registration*
        // commits (tagged `FORMAT_COMMIT_ORIGIN` by `intern_format` /
        // `intern_style`) from the undo stack. A registration is a monotonic,
        // content-addressed intern with no user-visible effect on its own — a
        // cell only displays a format/style via the still-undoable
        // `SetCellFormat` / `SetCellStyle`. Without this, a `RegisterFormat`
        // commit sat beneath the visible format change and the next undo "did
        // nothing" (it retracted the invisible registration); it was also a
        // latent correctness hazard (undoing a registration while another cell
        // still referenced the id). The registration op stays in the op-log
        // (origin only affects the UndoManager), so `rematerialize`'s
        // `replay_into` keeps the format interned across an undo of a
        // neighbouring edit — no cell→format ref can dangle. Mirrors the
        // `PRESENCE_COMMIT_ORIGIN` exclusion in `ql_collab::CollabSession`.
        undo_manager.add_exclude_origin_prefix(ql_oplog::FORMAT_COMMIT_ORIGIN);
        Self {
            workbook,
            baseline,
            oplog,
            graph,
            plan_cache: PlanCache::new(),
            registry,
            state: LifecycleState::Ready,
            epoch: mint_epoch(),
            state_seq: 0,
            change_log: VecDeque::new(),
            change_log_floor: 0,
            ops: HashMap::new(),
            next_op_id: 1,
            pending_recalc: None,
            events: Vec::new(),
            txns: HashMap::new(),
            next_txn_id: 1,
            undo_manager,
            // 6.4-3c: no UDF worker until the host injects one via set_udf_worker.
            udf_worker: None,
            // 6.4-3d (blocker G): empty per-recompute diagnostic collector.
            udf_diagnostics: RefCell::new(Vec::new()),
            spill_footprint: RefCell::new(Vec::new()),
            udf_op_budget: crate::scalar::UDF_OP_BUDGET,
            provenance: HashMap::new(),
            cell_provenance: HashMap::new(),
            bindings: HashMap::new(),
            // TE1 HIGH-1: empty — `active_structural` is populated by the first
            // `rematerialize`; birth sets are stamped per binding in `upsert_binding`.
            active_structural: Vec::new(),
            binding_birth_structural: HashMap::new(),
        }
    }

    /// Wrap an existing `Workbook` with a FRESH default registry (built-ins
    /// only). The construction-time path for `new()` and hand-built test
    /// workbooks, where no UDFs exist yet. Adoption sites that must preserve a
    /// UDF-aware registry across workbook replacement use
    /// [`Self::from_workbook_with_registry`] instead (6.4-2 cycle-2 audit-fix F2).
    pub fn from_workbook(workbook: Workbook) -> Self {
        Self::from_workbook_with_registry(workbook, Arc::new(ql_functions::default_registry()))
    }

    /// **6.4-3c (2026-05-29):** install the out-of-process Python-UDF worker
    /// this session dispatches registered UDFs to. Until this is called, a
    /// registered `=MYUDF(A1)` evaluates to `#CALC!` (No-Fallbacks-honest — the
    /// UDF is known to the graph but cannot compute without a worker). Wrapping
    /// in `RefCell` gives the interior mutability the shared-`&` eval stack needs
    /// to reach [`ql_udf::UdfWorker::call`]'s `&mut self`.
    ///
    /// Idempotent-replace: a second call swaps the worker (the prior one is
    /// dropped — its `Drop` kills + reaps the child per 6.4-3b). v1 takes a
    /// `Box<dyn UdfWorker + Send>` directly; the napi/IDE bridge that constructs a
    /// `ProcessWorker` from trusted-workspace config (+ `debugpy`) is 6.4-3d.
    ///
    /// NOTE: this does NOT itself recompute, and it does NOT dirty anything.
    /// A UDF cell evaluated BEFORE the worker was installed is a *clean*
    /// `#CALC!`, so `recalc_dirty` will NOT heal it — callers that want existing
    /// UDF cells to pick up the worker must call `recalc_all` (Codex MED-1 /
    /// Opus LOW-2, 6.4-3c audit). In the intended flow the host injects the
    /// worker BEFORE any UDF formulas are entered, so `set_formula`'s immediate
    /// eval sees it and no heal is needed. Auto-dirtying UDF-using cells on
    /// injection (via the 6.4-0 `functions_used` reverse index) is FILED-FORWARD
    /// for the 6.4-3d host bridge, which owns injection ordering.
    pub fn set_udf_worker(&mut self, worker: Box<dyn UdfWorker + Send>) {
        self.udf_worker = Some(RefCell::new(worker));
    }

    /// **6.4-3d (audit-fix HIGH-3):** lifecycle-gated worker injection for the
    /// napi/host boundary. `ensure_ready()` first, so a `New`/`Busy`/`Closed`/
    /// `Faulted` session rejects with `[invalid_state]`/`[session_busy]` instead
    /// of silently attaching a live Python child to a terminal session (and the
    /// `close()` worker-drop would then never run for it). The bare
    /// [`set_udf_worker`] stays an infallible field-setter for Rust tests on a
    /// known-`Ready` session.
    ///
    /// The napi `setUdfWorker` spawns + handshakes the worker OUTSIDE the session
    /// lock (a process op), then calls this UNDER the lock — so a session that
    /// transitioned to `Closed` during the spawn is caught HERE and the passed
    /// `worker` is dropped by the caller (its child killed + reaped), closing the
    /// inject-vs-close race.
    ///
    /// [`set_udf_worker`]: WorkbookSession::set_udf_worker
    pub fn set_udf_worker_checked(
        &mut self,
        worker: Box<dyn UdfWorker + Send>,
    ) -> EngineResult<()> {
        self.ensure_ready()?;
        self.udf_worker = Some(RefCell::new(worker));
        Ok(())
    }

    // --- internal helpers ---

    /// Run a closure against a per-edit `WorkbookRuntime` that borrows the
    /// session's owned state, recovering the (warmed) plan cache afterwards.
    /// The runtime borrow never escapes this function.
    ///
    /// **Panic safety (F3 / contract §8):** `f` runs the engine kernels, which
    /// contain reachable `.expect`/`panic!` (e.g. the recompute/spill paths). If
    /// `f` unwinds, the plan-cache restore below is skipped (leaving the cache
    /// taken/empty) and the session may be mid-edit. A [`FaultGuard`] marks the
    /// session `Faulted` on unwind so no later command runs against torn state —
    /// never silently `Ready`/`Busy`. It is disarmed on the normal return path.
    ///
    /// **6.1C audit-fix A-INFO/L-E6 — panic-default rationale corrected.** The
    /// prior docstring claimed `panic = "abort"` was "today's default"; this is
    /// factually wrong (the workspace `Cargo.toml` does not set `panic`, so the
    /// cargo default for release cdylib is `unwind`). The operational behavior
    /// (a `Session` method panic aborts the host) is still correct, but for the
    /// **napi-derive opt-in** reason: napi-rs only wraps panics into JS errors
    /// when `#[napi(catch_unwind)]` is set, and the `Session` class does not set
    /// it (tracked 6.1C M1 → 6.3). Unwinding through the generated `extern "C"`
    /// callback aborts. Once 6.3 lands `#[napi(catch_unwind)]` per method, this
    /// in-engine guard becomes the half that ensures even a catch-unwind'd panic
    /// leaves the session sealed (`Faulted`) rather than torn.
    fn with_runtime<R>(&mut self, f: impl FnOnce(&mut WorkbookRuntime<'_>) -> R) -> R {
        let cache = std::mem::take(&mut self.plan_cache);
        // **H3 (6.3-0):** start each runtime borrow with an empty spill-footprint
        // collector so a command drains exactly its own footprint (no leak across
        // commands). Unlike `udf_diagnostics` (auto-drained below), the owning
        // command drains this after the closure returns.
        self.spill_footprint.borrow_mut().clear();
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
            // 6.4-3c: lend the worker (disjoint field from the &mut borrows above).
            self.udf_worker.as_ref(),
            // 6.4-3d (blocker G): lend the per-recompute diagnostic collector.
            Some(&self.udf_diagnostics),
            // H3 (6.3-0): lend the per-edit spill-footprint collector.
            Some(&self.spill_footprint),
        );
        let out = f(&mut rt);
        self.plan_cache = rt.into_plan_cache();
        guard.armed = false;
        // 6.4-3d (blocker G): release the runtime + guard borrows, then drain
        // any UDF-dispatch diagnostics into the event stream.
        drop(guard);
        self.drain_udf_diagnostics();
        out
    }

    /// **6.4-3d (2026-05-29; megaudit blocker G):** drain the per-recompute UDF
    /// diagnostic collector into the event stream as `Event::CellDiagnostic`.
    /// Called by [`with_runtime`]/[`with_runtime_no_oplog`] AFTER the runtime
    /// (and its borrow of `self.udf_diagnostics`) is dropped, so the fresh
    /// `borrow_mut` here cannot overlap the dispatch-site borrows. The cell
    /// VALUE was already written during recompute; this only surfaces WHY a
    /// UDF failed. Severity is always `Error` for these codes.
    ///
    /// [`with_runtime`]: WorkbookSession::with_runtime
    /// [`with_runtime_no_oplog`]: WorkbookSession::with_runtime_no_oplog
    fn drain_udf_diagnostics(&mut self) {
        let diags: Vec<UdfCellDiagnostic> = self.udf_diagnostics.borrow_mut().drain(..).collect();
        for diag in diags {
            self.events.push(Event::CellDiagnostic {
                diagnostic: Diagnostic {
                    addr: Some(diag.addr.into()),
                    severity: Severity::Error,
                    code: diag.code.to_string(),
                    message: diag.message,
                },
            });
        }
    }

    /// **H3 (6.3-0):** drain the per-edit spill-footprint collector into
    /// [`SessionChange::Cell`] records for the delta change-log. The owning
    /// command (`set_value`/`set_formula`/`clear`/`batch`) calls this AFTER its
    /// `with_runtime` closure returns and folds the result into ONE
    /// `record_changes` call alongside the anchor cell — so `snapshot_delta`
    /// reports the full spill footprint, not just the anchor. Takes `&self` (the
    /// `RefCell` gives interior mutability) so it composes inside a change-list
    /// builder without a second `&mut self` borrow. The recompute paths do NOT
    /// use this — they record footprints via `RecomputeResult.changed_cells`.
    fn drain_spill_footprint(&self) -> Vec<SessionChange> {
        self.spill_footprint
            .borrow_mut()
            .drain(..)
            .map(|(sheet, row, col)| SessionChange::Cell { sheet, row, col })
            .collect()
    }

    /// Like [`with_runtime`] but with the op-log **detached** — the mutators
    /// update the workbook AND maintain the calcgraph, but append **no** ops
    /// (the [`batch`] path appends its single `Op::BatchCommit` itself). Same
    /// `FaultGuard` panic safety + plan-cache take/restore as `with_runtime`.
    ///
    /// [`with_runtime`]: WorkbookSession::with_runtime
    /// [`batch`]: WorkbookSession::batch
    fn with_runtime_no_oplog<R>(&mut self, f: impl FnOnce(&mut WorkbookRuntime<'_>) -> R) -> R {
        let cache = std::mem::take(&mut self.plan_cache);
        // **H3 (6.3-0):** clear-on-entry; see `with_runtime`.
        self.spill_footprint.borrow_mut().clear();
        let mut guard = FaultGuard {
            state: &mut self.state,
            armed: true,
        };
        let mut rt = WorkbookRuntime::with_session_state_no_oplog(
            &mut self.workbook,
            &self.registry,
            &mut self.graph,
            cache,
            // 6.4-3c: lend the worker (disjoint field from the &mut borrows above).
            self.udf_worker.as_ref(),
            // 6.4-3d (blocker G): lend the per-recompute diagnostic collector.
            Some(&self.udf_diagnostics),
            // H3 (6.3-0): lend the per-edit spill-footprint collector.
            Some(&self.spill_footprint),
        );
        let out = f(&mut rt);
        self.plan_cache = rt.into_plan_cache();
        guard.armed = false;
        // 6.4-3d (blocker G): release borrows, then drain UDF diagnostics.
        drop(guard);
        self.drain_udf_diagnostics();
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

    /// Gate [`open`]/[`import`] (inc.2c-9 persistence): legal in `New` (the
    /// `New → Ready` lifecycle transition the trait doc names) OR `Ready`
    /// (re-opening over a live session is allowed — it replaces the document).
    /// Rejected loud in `Busy` (a long op is in flight) and the terminal states.
    /// NOT `ensure_ready` — that rejects `New`, which `open` is precisely the
    /// way out of.
    ///
    /// [`open`]: WorkbookSession::open
    /// [`import`]: WorkbookSession::import
    fn ensure_openable(&self) -> EngineResult<()> {
        match self.state {
            LifecycleState::New | LifecycleState::Ready => Ok(()),
            LifecycleState::Busy => Err(EngineError::session_busy(
                "a long operation is in progress; open/import is rejected while Busy",
            )),
            LifecycleState::Closed => {
                Err(EngineError::invalid_state("session is Closed (terminal)"))
            }
            LifecycleState::Faulted => {
                Err(EngineError::invalid_state("session is Faulted (terminal)"))
            }
        }
    }

    /// Allocate the next operation id.
    ///
    /// **6.1C audit-fix M6 (partial) — `checked_add` consistency with
    /// `next_txn_id` (`begin_transaction`).** Plain `+= 1` would wrap on the
    /// (practically unreachable) 2^64th allocation, silently reusing a live
    /// op-id. Fail loud instead — the loud path matches the
    /// `transaction_id_exhausted` pattern next door, and a panic here trips the
    /// `with_runtime` FaultGuard on the calling path so the session seals
    /// (`Faulted`) rather than continuing with a colliding id. (Bounded
    /// retention of `ops` is the broader M6 follow-up filed for 6.3.)
    fn next_op(&mut self) -> OperationId {
        let id = OperationId(self.next_op_id);
        self.next_op_id = self
            .next_op_id
            .checked_add(1)
            .expect("operation id space exhausted (2^64 ops in one session)");
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
            &self.registry,
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
        // **6.4-1 cycle-2 audit-fix H1 (2026-05-28):** thread `self.registry`
        // through the rebuild so the dep walker uses the session's live
        // (potentially UDF-aware) registry rather than a fresh
        // `default_registry()`. `rematerialize` runs on every undo/redo; the
        // 6.4-0 H2 audit-fix closed the parallel `recompute_all` site but
        // missed this one and `from_workbook` — both surfaced by the 6.4-1
        // cycle-2 Opus lane. Behavior-preserving today; prevents future
        // silent divergence once 6.4-2 wires `register_function`.
        self.graph =
            CalcgraphSession::rebuild_from_workbook_with_registry(&self.workbook, &self.registry)
                .session;
        // **TB3 (w140; audit BLOCKER fold):** `rematerialize` replaces
        // `self.workbook` wholesale from replay and rebuilds the graph above.
        // The plan cache is session-owned and CARRIED across runtimes
        // (`with_runtime` take/put-back), but its key (`PlanCacheKey`) has NO
        // table-extent axis — table mutators (`resize_table`/`rename_table`)
        // keep it coherent by EXPLICITLY clearing it (see `tables.rs`). A replay
        // can restore a DIFFERENT table extent than the cache was last warmed
        // against (e.g. undo of a `resize_table`), so a wholesale rebuild MUST
        // reset the plan cache too. Without this, the recompute below — whose
        // cycle-detection pre-pass now SHARES the plan cache (TB3, w140) —
        // could bind a structured ref against a stale extent and miss a `#CIRC!`
        // or read a stale aggregate. The TB3 win is preserved: the pre-pass
        // re-warms the now-cold cache and the eval loop hits it within this same
        // pass. (`open`/`from_workbook` build a FRESH session → fresh cache, so
        // this is the only wholesale-rebuild site that reuses the cache.)
        self.plan_cache.clear();
        // Recompute computed values with the op-log detached (no spurious ops /
        // no UndoManager commit). The result's failures become diagnostics.
        // **6.4B closure-audit (MED):** arm the op-budget — undo/redo can replay a
        // workbook with many UDF cells; without this the pass is bounded only by the
        // 30s per-call deadline (the N×30s aggregate stall item H exists to close).
        let op_deadline = self.udf_op_deadline_for_pass();
        let result = self.with_runtime_no_oplog(|rt| {
            rt.arm_udf_op_deadline(op_deadline);
            rt.recompute_all()
        });
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
        // 6.5-2: provenance maps are session-local state — they are NOT stored in
        // the op-log, so undo/redo cannot replay them. After a wholesale rebuild the
        // live workbook no longer reflects any prior materialize_query write, so
        // stale provenance entries would let refresh_source re-apply an undone source
        // to the rebuilt state. Clear both maps unconditionally; the caller must
        // re-run materialize_query to re-establish provenance after undo/redo.
        self.provenance.clear();
        self.cell_provenance.clear();
        // DEC-B (undo × binding): the rebuild just wiped every binding's backing
        // provenance (the maps above are not in the op-log, so a publish's
        // provenance cannot be replayed). A binding is KEPT (it is a region
        // pointer, not data) but now points at vanished provenance, so flag every
        // SOURCE-BACKED binding `force_check` — the kernel's next touch
        // re-publishes and `upsert_binding` clears it. A bare `bind_range`
        // declaration (`source_id` None) has no provenance to lose and is left
        // untouched. Never leave a binding pointing at vanished provenance
        // silently (No-Fallbacks). `alive` is NOT changed here — structural
        // invalidation (D-RANGEMOVE) is a separate, axis-aware concern.
        //
        // `&& binding.alive`: a DEAD binding (already invalidated by a structural
        // edit) cannot be healed by a re-publish to its now-stale target — it
        // needs a re-bind — so it must NOT regain `force_check` on a later
        // undo/redo, or it would re-enter the contradictory {alive=false,
        // force_check=true} state.
        for binding in self.bindings.values_mut() {
            if binding.source_id.is_some() && binding.alive {
                binding.force_check = true;
            }
        }

        // TE1 HIGH-1 (D-RANGEMOVE × undo/redo): the forward structural path
        // (`apply_structural_edit` / `delete_sheet`) invalidates anchored bindings at
        // edit time, but a REDO re-applies a previously-undone structural edit WITHOUT
        // routing through that path — it only replays the op-log here, so the redone
        // shift would otherwise leave an intersecting binding stale-`alive` (Codex
        // round-2 HIGH). Close it here, BINDING-RELATIVE: each alive binding is killed
        // iff (a) its target sheet is no longer live, or (b) the CURRENT net-active
        // structural set gained an intersecting edit RELATIVE TO that binding's birth
        // set. Birth-relative (not a session-global active-set diff) so a redo that
        // merely RESTORES a binding's birth grid is correctly a no-op — a global diff
        // over-invalidated that case (Codex round-2 followup). The DEC-B `force_check`
        // pass above runs FIRST, so a binding killed here ends {alive=false,
        // force_check=false}, never the contradictory {alive=false, force_check=true}.
        //
        // NOT a VersionVector: the op-log VV is monotonic across undo/redo (undo
        // appends an inverse op → the VV only grows), so it cannot distinguish an edit
        // whose effect was undone from one still applied; `OpLog::iter()` (the
        // net-active LoroList) can. Edits LEAVING the active set (an undo) are
        // intentionally not acted on — DEC-B governs undo (keep the binding +
        // `force_check`); this closes only the becomes-active (forward/redo) gap.
        //
        // KNOWN LIMITATION (out of TE1 scope, contrived + unreachable in wired flows):
        // because the relative diff compares by VALUE, a PARTIAL redo of two value-equal
        // stacked edits (birth `[E,E]`, now `[E]` after one redo) yields an empty diff,
        // so a BARE binding stays alive-but-shifted without `force_check`. Same class as
        // DEC-B's tolerated bare-binding undo imprecision; SOURCE-backed bindings are
        // protected (DEC-B re-flags `force_check` every undo/redo). Bare `bind_range`
        // has no TE1 caller (the moat uses `publish_dataset`). Precise fix = TE2.
        let now_structural = self.collect_active_structural_edits()?;
        for binding in self.bindings.values_mut() {
            if !binding.alive {
                continue;
            }
            // (a) Sheet-delete, incl. a REDO of `Op::RemoveSheet` (which routes only
            // through here, not the forward `delete_sheet` path): a binding whose
            // target sheet is no longer live is dead — never reported stale-alive.
            let sheet = binding.target.sheet;
            let sheet_live = (sheet as usize) < self.workbook.sheet_count()
                && !self.workbook.is_sheet_removed(sheet);
            if !sheet_live {
                binding.alive = false;
                binding.force_check = false;
                continue;
            }
            // (b) Row/col edits active NOW but NOT at this binding's birth. A binding
            // missing its birth stamp is an `upsert_binding` invariant violation —
            // fail loud in debug; in release treat birth as empty (conservative:
            // invalidate on any intersecting active edit) rather than silently skip.
            let relative_new = match self.binding_birth_structural.get(&binding.binding_id) {
                Some(birth) => newly_active_structural(&now_structural, birth),
                None => {
                    debug_assert!(
                        false,
                        "binding {} has no birth structural stamp",
                        binding.binding_id
                    );
                    now_structural.clone()
                }
            };
            if relative_new
                .iter()
                .any(|edit| structural_edit_affects(edit, &binding.target))
            {
                binding.alive = false;
                binding.force_check = false;
            }
        }
        self.active_structural = now_structural;

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
            styles_added: Vec::new(),
            version: self.current_version(),
            full_rebuild_required: true,
            full_rebuild_reason: Some(reason),
        }
    }

    /// Build a full `SheetSnapshot` for one live sheet (shared by `snapshot` and
    /// `snapshot_delta`'s `sheets_changed`). `None` if the sheet is gone.
    /// `parsed_format_cache` is the caller's per-read-call render cache (see
    /// `build_cell_snapshot`); threading it through keeps `format::parse` at
    /// once-per-unique-`FormatId` per top-level call even across sheets.
    fn build_sheet_snapshot(
        &self,
        sheet_id: SheetId,
        parsed_format_cache: &mut HashMap<ql_storage::FormatId, ql_functions::format::FormatString>,
    ) -> Option<SheetSnapshot> {
        let name = self.workbook.sheet(sheet_id)?.name().to_string();
        let mut cells = Vec::new();
        for (row, col) in self.populated_coords(sheet_id) {
            if let Some(cell) = self.build_cell_snapshot(sheet_id, row, col, parsed_format_cache) {
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
    /// **6.4B (item H):** override the operation-level UDF time budget (default
    /// [`crate::scalar::UDF_OP_BUDGET`] = 120s). A test/host configuration knob —
    /// not yet bound over napi (host configurability + per-function deadlines are
    /// filed forward). `Duration::ZERO` makes every UDF in a recalc pass exhaust the
    /// budget immediately, which the budget tests use to drive the skip path.
    #[cfg(test)]
    pub(crate) fn set_udf_op_budget(&mut self, budget: std::time::Duration) {
        self.udf_op_budget = budget;
    }

    /// **6.4B (item H):** the operation-level UDF time budget for ONE recompute
    /// pass — `Some(now + UDF_OP_BUDGET)` iff a worker is attached, else `None`.
    /// With no worker, UDFs are `#CALC!` no-worker and never block, so a budget
    /// would be meaningless and the `None` path keeps non-UDF recompute byte-for-byte
    /// unchanged. EVERY full-pass recompute that can dispatch a UDF must arm this so
    /// the aggregate stall is bounded (not just the explicit `recalc_*` paths):
    /// [`run_recalc`], [`rematerialize`] (undo/redo), and the `open` load path all
    /// route through it (6.4B closure-audit MED — the budget was previously armed
    /// only in `run_recalc`, leaving undo/redo + open bounded by the 30s per-call
    /// deadline alone).
    ///
    /// [`run_recalc`]: WorkbookSession::run_recalc
    /// [`rematerialize`]: WorkbookSession::rematerialize
    fn udf_op_deadline_for_pass(&self) -> Option<std::time::Instant> {
        self.udf_worker
            .is_some()
            .then(|| std::time::Instant::now() + self.udf_op_budget)
    }

    /// **M2 (6.3-1b):** the shared recompute executor — runs the recompute, folds
    /// its changes into the delta change-log, and terminalizes the op. Assumes `op`
    /// is already `Running` and the session already `Busy` (set by [`start_recalc`]).
    /// This is the single recompute code path: both the windowed [`await_recalc`] and
    /// the one-shot convenience wrappers ([`recalc_dirty`]/[`recalc_all`]) funnel
    /// through here, so the L8 panic-terminalization and the 6.3-1a terminal-event
    /// emit live in exactly one place.
    ///
    /// [`start_recalc`]: WorkbookSession::start_recalc
    /// [`await_recalc`]: WorkbookSession::await_recalc
    /// [`recalc_dirty`]: WorkbookSession::recalc_dirty
    /// [`recalc_all`]: WorkbookSession::recalc_all
    fn execute_recalc(
        &mut self,
        op: OperationId,
        f: impl FnOnce(&mut WorkbookRuntime<'_>) -> Option<crate::RecomputeResult>,
    ) {
        // **6.4B (item H):** arm the operation-level UDF time budget for THIS recalc
        // pass. Computed at AWAIT time (when the recompute actually starts, not at
        // `start_recalc`), before `with_runtime` borrows `self`, then set on the
        // runtime so the per-cell recompute env carries it to the dispatch site.
        let op_deadline = self.udf_op_deadline_for_pass();
        // **L8 (6.3-1a):** terminalize the op on a recompute panic. `with_runtime`'s
        // `FaultGuard` already seals the session `Faulted` as the stack unwinds out
        // of it, but the op would otherwise stay stranded `Running` (the
        // `Completed` insert below never runs). Catch the unwind, mark the op
        // `Failed`, then `resume_unwind` so the napi boundary (M1) still surfaces a
        // `[panic]` error and we never run normal post-processing on the now-Faulted
        // session. `AssertUnwindSafe` is sound: `self.ops` is a plain map untouched
        // by the panic, and we immediately re-raise rather than observe `self`.
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.with_runtime(|rt| {
                rt.arm_udf_op_deadline(op_deadline);
                f(rt)
            })
        })) {
            Ok(result) => result,
            Err(payload) => {
                // **6.3-1a closure-audit (Codex MEDIUM / Opus LOW):** a terminal op
                // MUST also emit its terminal event — the normal `Completed` path
                // does (tail of this fn), and `Event::OperationCompleted` means
                // "operation reached a terminal state". Record `Failed` AND announce
                // it before re-raising so an IDE polling `poll_events` for op
                // terminalization sees this op resolve (not hang on `Running`). The
                // structured panic message still reaches the caller via the napi
                // boundary's `[panic]` error; here we only surface the terminal state.
                let failed = OperationState::Failed {
                    error: EngineError::panic("recompute panicked"),
                };
                self.ops.insert(op, failed.clone());
                self.events
                    .push(Event::OperationCompleted { op, state: failed });
                std::panic::resume_unwind(payload);
            }
        };

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
            // **FE-4 W4:** style-only cells (a cell carrying only a visual style,
            // no value/formula/format, must still surface in the snapshot —
            // else `build_cell_snapshot` never runs for it and the style is
            // invisible to the IDE).
            //
            // **FE-9 (2026-06-14):** skip cells whose ONLY content is an EMPTY
            // (default) style — they're not really populated. Mirrors
            // `build_cell_snapshot`'s resolve-and-drop and keeps used-range /
            // extent from counting phantom style-only cells.
            for ((row, c), sid) in sheet.style_overlay().iter() {
                if let Some(s) = self.workbook.styles().lookup(sid) {
                    if s.is_empty() {
                        continue;
                    }
                }
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
    ///
    /// **Display-path gap closure (2026-06-10)**: `rendered` is now populated
    /// (pre-closure it was hardcoded `None`, so the IDE grid showed RAW
    /// numbers for format-carrying cells — a percent-formatted `0.021`
    /// displayed `"0.021"` instead of `"2.10%"`). The format-rendering logic
    /// existed but ONLY on the dormant `CollabSession` napi paths
    /// (`ql-bindings-node/src/lib.rs` `workbook_snapshot` D4 + the
    /// `workbook_snapshot_delta` changed-cells path) — the same
    /// wrong-session-class trap as the w54 insert/delete bug: a feature built
    /// on `CollabSession` that the product (owning `WorkbookSession`) never
    /// got. This is the single per-cell choke point for ALL owning-session
    /// read paths (`snapshot` → `build_sheet_snapshot`, `snapshot_delta`'s
    /// `changed_cells` AND `sheets_changed`, and single-cell `cell()`), so
    /// populating it here fixes every product render path at once.
    ///
    /// **Semantics are a 1:1 MIRROR of the `CollabSession` D4 contract**
    /// (`CellSnapshotJson.rendered` docstring + the gating at the
    /// `workbook_snapshot` / delta render sites in
    /// `ql-bindings-node/src/lib.rs`), translated from the collab cache's
    /// `Option<CellWireValue>` vocabulary to the owning session's direct
    /// `ql_types::Value` read:
    /// - format `None` → rendered `None` (IDE falls back to value-based
    ///   default rendering). NOTE: a cell EXPLICITLY formatted with
    ///   `Builtin(0)` ("General", pre-registered in `FormatTable::new`) is
    ///   `Some` here and DOES render through `SectionKind::General` — exactly
    ///   what the CollabSession path does (no special-casing of builtin-0).
    /// - value `None` → rendered `None`. `value_to_cell_value` maps
    ///   `Value::Blank` → `None`, which covers BOTH collab gates at once: the
    ///   "no value" gate AND the `is_pending()` gate (the collab cache's
    ///   `Pending` sentinel marks a formula awaiting evaluation; the owning
    ///   session's storage read for that state IS `Value::Blank`). Mirrors
    ///   the audit-of-D4 CONVERGENT-HIGH-3 closure: never render a
    ///   not-yet-evaluated formula as a formatted zero.
    /// - format-id lookup miss in `Workbook::formats()` → `None` (should not
    ///   happen for well-formed sessions: `set_format` rejects unregistered
    ///   ids — but the delta/replay surface keeps the guard).
    /// - format-string parse failure (`ql_functions::format::parse` err —
    ///   V2 token, malformed grammar) → `None` (IDE value-default fallback,
    ///   per the Phase 5.6 conservative discipline the collab path follows).
    /// - `Value::Error` DOES render: `ql_functions::format::render`
    ///   short-circuits errors to their canonical sigils (Excel canon —
    ///   errors never honor the format string), identical to the collab path
    ///   where a known sigil wire-decodes to `Value::Error` and renders. The
    ///   collab-only "unknown error sigil → wire-decode err → None" gate has
    ///   NO owning-session analog (`Value::Error` is a closed enum; every
    ///   sigil is canonical), so nothing is lost in the translation.
    ///
    /// `parsed_format_cache` mirrors the collab path's audit-of-D4
    /// CONVERGENT-MED-2 closure: `format::parse` runs ONCE per unique
    /// `FormatId` per top-level read call (snapshot / delta / cell), not per
    /// cell. Callers own the cache so its lifetime matches the collab
    /// per-snapshot-call granularity.
    fn build_cell_snapshot(
        &self,
        sheet_id: SheetId,
        row: RowId,
        col: ColId,
        parsed_format_cache: &mut HashMap<ql_storage::FormatId, ql_functions::format::FormatString>,
    ) -> Option<CellSnapshot> {
        let sheet = self.workbook.sheet(sheet_id)?;
        // Keep the RAW `ql_types::Value` for rendering (render takes `&Value`;
        // the DTO `CellValue` is wire-shaped, not render-shaped).
        let raw_value = sheet.read(row, col);
        let value = value_to_cell_value(&raw_value);
        let formula = self
            .workbook
            .formula_at(sheet_id, row, col)
            .map(|f| f.to_string());
        // Keep the STORAGE-side id for the `FormatTable` lookup; the DTO id is
        // only for the snapshot payload.
        let storage_format = sheet.format_overlay().get(row, col);
        let format = storage_format.map(storage_format_id_to_dto);
        // **FE-4 W4:** the cell-style id, if any. Carried inline as a DTO
        // StyleId; the `styles` snapshot table resolves it to a `Style`.
        //
        // **FE-9 (2026-06-14):** resolve the overlay style and DROP it when it
        // resolves to the EMPTY (default) style — an empty style is "no style"
        // (style.rs), so a value-less cell carrying only a default style is
        // genuinely empty and must not surface as a phantom snapshot cell. The
        // source fix in `set_cell_style` prevents NEW empty binds; this read-side
        // resolve heals any that slipped in via replay / the dormant collab path /
        // an older `.qbook`. A lookup miss (id not in the table — cannot happen for
        // a well-formed session) preserves today's emit behavior, never masks.
        let style = sheet.style_overlay().get(row, col).and_then(|sid| {
            match self.workbook.styles().lookup(sid) {
                Some(s) if s.is_empty() => None,
                _ => Some(storage_style_id_to_dto(sid)),
            }
        });
        if value.is_none() && formula.is_none() && format.is_none() && style.is_none() {
            return None;
        }
        // The D4 gate, in owning-session vocabulary: render iff the cell has
        // BOTH an explicit format AND a committed non-Blank value (see the
        // docstring above for the full None-fallback contract mirror).
        let rendered: Option<String> = match (storage_format, value.is_some()) {
            (Some(fmt_id), true) => {
                // Same render/eval context as the CollabSession sites: the
                // workbook's date system + locale, system clock. `render`
                // ignores `locale` today (English month names hardcoded) but
                // the passthrough mirrors the audit-of-D4 CONVERGENT-MED-1
                // closure (no silent forward-compat regression when
                // locale-aware rendering lands).
                let eval_ctx = ql_types::EvalContext {
                    date_system: self.workbook.date_system(),
                    locale: self.workbook.locale(),
                    now_provider: ql_types::NowProvider::System,
                };
                if let Some(fmt) = parsed_format_cache.get(&fmt_id) {
                    // CONVERGENT-MED-2 parse cache hit: reuse the
                    // `FormatString` across cells sharing a `FormatId`.
                    Some(ql_functions::format::render(&raw_value, fmt, &eval_ctx))
                } else {
                    // Cache miss: lookup + parse + insert. `?`-style fallthrough
                    // to `None` on lookup miss / parse error is the documented
                    // IDE value-default fallback, NOT a swallowed engine error
                    // (the contract docstring above enumerates every arm).
                    self.workbook.formats().lookup(fmt_id).and_then(|fmt_str| {
                        let fmt = ql_functions::format::parse(fmt_str).ok()?;
                        let rendered_str =
                            ql_functions::format::render(&raw_value, &fmt, &eval_ctx);
                        parsed_format_cache.insert(fmt_id, fmt);
                        Some(rendered_str)
                    })
                }
            }
            _ => None,
        };
        Some(CellSnapshot {
            row,
            col,
            value,
            formula,
            format,
            style,
            rendered,
        })
    }

    /// Surface an xlsx import report's fidelity caveats as `Warning`
    /// diagnostics (inc.2c-10). The import SUCCEEDS, but unsupported OOXML
    /// features (dropped), soft warnings, and formulas the engine couldn't
    /// recompute (Excel cached value preserved) are all reported as poll-able
    /// events — never silently dropped (No-Fallbacks). Called AFTER the
    /// `*self = from_workbook(..)` adoption (which resets `events`).
    fn push_xlsx_import_diagnostics(&mut self, report: &ql_io_xlsx::XlsxImportReport) {
        // The PRIMARY fidelity-loss channel: `scan_unsupported_features` records
        // dropped OOXML features (conditional formatting, data validation, merged
        // cells, hyperlinks, protection, comments, drawings, images, pivots,
        // macros, external links, hidden sheets) into `feature_inventory.counts`
        // — NOT into `report.unsupported` (which carries only per-occurrence
        // detail for a couple of cases). Under `UnsupportedPolicy::Permissive`
        // (the import default) those features are silently ignored on the wire,
        // so surfacing the inventory here is what keeps the No-Fallbacks promise.
        // Sorted by kind for deterministic event order (HashMap iteration order
        // is otherwise nondeterministic).
        let mut inventory: Vec<_> = report.feature_inventory.counts.iter().collect();
        inventory.sort_by_key(|(kind, _)| format!("{kind:?}"));
        for (kind, count) in inventory {
            self.events.push(Event::CellDiagnostic {
                diagnostic: Diagnostic {
                    addr: None,
                    severity: Severity::Warning,
                    code: "xlsx_unsupported_feature".to_string(),
                    message: format!(
                        "{kind:?} is not represented by the engine and was dropped on import \
                         ({count} occurrence(s))"
                    ),
                },
            });
        }
        // Per-occurrence unsupported records (location detail the inventory tally
        // lacks — e.g. an unregistered custom number format at a specific cell).
        for uf in &report.unsupported {
            self.events.push(Event::CellDiagnostic {
                diagnostic: Diagnostic {
                    addr: None,
                    severity: Severity::Warning,
                    code: "xlsx_unsupported_feature".to_string(),
                    message: format!("{:?} in {}: {}", uf.kind, uf.part, uf.detail),
                },
            });
        }
        for w in &report.warnings {
            self.events.push(Event::CellDiagnostic {
                diagnostic: Diagnostic {
                    addr: None,
                    severity: Severity::Warning,
                    code: "xlsx_import_warning".to_string(),
                    message: format!("{}: {}", w.location, w.message),
                },
            });
        }
        for f in &report.formula_failures {
            self.events.push(Event::CellDiagnostic {
                diagnostic: Diagnostic {
                    addr: Some(CellAddr {
                        sheet: f.sheet,
                        row: f.row,
                        col: f.col,
                    }),
                    severity: Severity::Warning,
                    code: "xlsx_formula_recompute_failed".to_string(),
                    message: format!("formula {:?}: {}", f.formula, f.reason),
                },
            });
        }
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

    /// Open a `.qbook` directory (inc.2c-9). **Option 1 (locked 2026-05-27):**
    /// reconstruct the workbook from the `.qbook` and adopt it with a FRESH
    /// op-log + undo history (`baseline = loaded workbook`), so the undo
    /// invariant `baseline + replay(oplog) == workbook` holds trivially (the
    /// loaded workbook IS the baseline; replay of the empty log is identity) —
    /// matching `from_workbook` and avoiding Option 2's data-loss bug class
    /// (a loaded `oplog` whose replay diverges from the loaded envelope). The
    /// loaded file's op-log history is therefore NOT carried forward: a later
    /// `save` writes only THIS session's edits, and undo cannot cross the open
    /// point (the intended semantic). The on-disk `oplog.bin` is still loaded
    /// and validated (via the oplog-aware loader) so a corrupt sidecar fails
    /// loud here rather than being silently ignored — it is then discarded.
    fn open(&mut self, path: &str) -> EngineResult<()> {
        self.ensure_openable()?;
        // Load + validate BOTH the workbook envelope and the op-log sidecar; the
        // op-log is discarded (Option 1). A missing sidecar or a bad envelope
        // surfaces loud as a `Persistence` error (No-Fallbacks).
        //
        // **Wave H1 (2026-06-19):** `.qbook` is now a single FILE (a ZIP
        // container). Dispatch on the on-disk shape so legacy directory bundles
        // still open: a directory → the dir loader; anything else (including a
        // non-existent path, which fails loud as `NotFound` inside the file
        // loader, matching the prior contract) → the single-file loader. This
        // is an explicit format branch, NOT a silent fallback — both branches
        // surface their own persistence errors.
        let target = Path::new(path);
        let (wb, discarded_oplog) = if target.is_dir() {
            ql_io::load_workbook_with_oplog(target).map_err(map_persistence_err)?
        } else {
            ql_io::load_workbook_file_with_oplog(target).map_err(map_persistence_err)?
        };
        // `load_workbook_with_oplog` validates only the Loro snapshot FRAMING;
        // per-op JSON is deserialized lazily by `OpLog::iter()` (`log.rs:107`).
        // A frame-valid but payload-corrupt sidecar (e.g. a pre-Tier-D3 op shape
        // — see `ql-oplog/tests/d1_step8_legacy_op_shape.rs`) would otherwise be
        // silently accepted here and then masked by the next `save`'s overwrite.
        // Even though Option 1 discards this op-log, validate its payloads now so
        // a corrupt sidecar fails LOUD on open (the No-Fallbacks contract this
        // increment promises). Done BEFORE `*self = ...` → atomic: a failure
        // leaves the session untouched and still usable.
        for op in discarded_oplog.iter() {
            op.map_err(|e| map_persistence_err(ql_io::PersistenceError::OpLog(e)))?;
        }
        // Adopt as a fresh session over the loaded workbook. `from_workbook`
        // rebuilds the calcgraph, mints a new epoch (so any pre-open delta token
        // → EpochMismatch full rebuild), resets `state_seq`/`change_log`/`ops`/
        // `events`/`txns` (a fresh document), and — crucially — builds a FRESH
        // `OpLog` + `UndoManager` re-subscribed to it AND sets `baseline = wb`.
        // The function registry is session-scoped tooling (not document state),
        // so it is preserved across the open (v1: always the default registry).
        // **6.4-2 cycle-2 audit-fix (F2):** adopt via `from_workbook_with_registry`
        // so the rebuilt graph is extracted against the PRESERVED (UDF-aware)
        // registry — not the fresh default `from_workbook` would build. (`open`
        // additionally self-heals via the `recompute_all` below, but building the
        // graph correctly the first time avoids the wasteful double build and
        // keeps the pre-recompute graph consistent.)
        let registry = Arc::clone(&self.registry);
        // **6.4-3d (megaudit blocker D1):** preserve the live Python-UDF worker
        // across the wholesale `*self = ...` replacement. `take()` leaves `None`
        // in the about-to-be-dropped old self (so its `Drop` kills nothing), and
        // we re-home the worker into the rebuilt session BEFORE the recompute
        // below — so a `=MYUDF(..)` recomputes against the live worker instead
        // of being destroyed to `#CALC!`. Moving the `RefCell<Box<..>>` (a
        // by-value IPC handle) never signals the child process. When no worker
        // is configured, this is `None` and blocker D2 (recompute preserves
        // saved UDF values) keeps the loaded values intact.
        let preserved_worker = self.udf_worker.take();
        *self = Self::from_workbook_with_registry(wb, registry);
        self.udf_worker = preserved_worker;
        // Recompute on open — mirrors the canonical IDE path
        // (`loader.rs::load_workbook_and_recompute`): the saved computed values
        // may be stale relative to their inputs. Run with the op-log DETACHED so
        // the recompute appends no ops and feeds the (fresh) undo manager no
        // spurious commit. Structural failures surface as `CellDiagnostic`
        // events (never swallowed — the `run_recalc`/`rematerialize` pattern).
        // **6.4-3d (audit-fix HIGH-1):** the LOAD path uses the PRESERVING
        // variant so a saved UDF value survives an open with no worker (D2).
        // `recalc_all` (session.rs:2227) and `rematerialize` (session.rs:877)
        // deliberately use the plain `recompute_all` (no preserve) — they must
        // recompute honestly (rematerialize's replayed cells have no saved value
        // → preserving would write Blank, a silent wrong result).
        // **6.4B closure-audit (MED):** arm the op-budget for the load-path pass too
        // (the worker was restored just above) — a reopened workbook can re-dispatch
        // many UDF cells; bound the aggregate, not just per-call.
        let op_deadline = self.udf_op_deadline_for_pass();
        let result = self.with_runtime_no_oplog(|rt| {
            rt.arm_udf_op_deadline(op_deadline);
            rt.recompute_all_preserving_saved_udf()
        });
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
        Ok(())
    }

    /// Import a workbook from in-memory bytes. v1 supports `"xlsx"` (inc.2c-10)
    /// and `"csv"` (inc.2c-11); any other format is a loud `BadArgument`.
    ///
    /// **csv:** parse via `ql_io_csv::import_csv_bytes` (no recompute — CSV has
    /// no formulas) → Option-1 adoption (same model as xlsx below, minus the
    /// recomputer).
    ///
    /// **xlsx (Option 1, same adoption model as [`open`]):** parse the bytes via
    /// `ql_io_xlsx::import_xlsx_bytes` — which recomputes BestEffort through the
    /// injected [`EngineXlsxRecomputer`] (dependency inversion: `ql-io-xlsx` is
    /// pure I/O) — then adopt the resulting workbook with a FRESH op-log + undo
    /// history (`*self = from_workbook`, registry preserved, epoch re-minted).
    /// Because the importer already recomputed, this does NOT recompute again
    /// (unlike `open`, which loads a possibly-stale `.qbook`). The import
    /// report's fidelity caveats (unsupported features, soft warnings, formulas
    /// the engine couldn't recompute) are surfaced as `Warning` diagnostics —
    /// never silently dropped (No-Fallbacks).
    ///
    /// **Panic safety (§8).** Unlike [`open`] — whose recompute mutates
    /// `self.workbook` IN PLACE under a `with_runtime` `FaultGuard` — `import`'s
    /// recompute runs inside `import_xlsx_bytes` on a LOCAL workbook (`self` only
    /// lends `&self.registry`), and `self` is replaced by the SINGLE atomic
    /// `*self = from_workbook(..)` only AFTER a successful parse+recompute. No
    /// step leaves `self` half-mutated: a panic in parse / recompute / adopt
    /// leaves `self` in its prior valid (`Ready`) state and the session stays
    /// usable. A `FaultGuard` here would be wrong — it would fault a healthy
    /// session. (Under `panic = "unwind"`, the boundary `catch_unwind` of §8.2
    /// still maps the panic to `EngineError::panic`.)
    ///
    /// [`open`]: WorkbookSession::open
    /// [`EngineXlsxRecomputer`]: crate::EngineXlsxRecomputer
    fn import(&mut self, bytes: &[u8], format: &str) -> EngineResult<()> {
        self.ensure_openable()?;
        match format {
            "xlsx" => {
                let result = ql_io_xlsx::import_xlsx_bytes(
                    bytes,
                    &self.registry,
                    ql_io_xlsx::XlsxImportOptions::default(),
                    Some(&crate::EngineXlsxRecomputer),
                )
                .map_err(map_xlsx_err)?;
                let report = result.report;
                // Adopt the imported (already-recomputed) workbook as a fresh
                // session, preserving the function registry (session tooling, not
                // document state). Mirrors `open`'s Option-1 adoption.
                // **6.4-2 cycle-2 audit-fix (F2 — the live divergence site):**
                // xlsx import does NOT recompute after adoption (the importer
                // already recomputed on the local workbook), so unlike `open`
                // there is no post-swap `recompute_all` to rebuild the graph.
                // Adopting via `from_workbook_with_registry` is what keeps the
                // graph extracted against the preserved UDF-aware registry.
                let registry = Arc::clone(&self.registry);
                // 6.4-3d (blocker D1): preserve the live UDF worker across the swap.
                let preserved_worker = self.udf_worker.take();
                *self = Self::from_workbook_with_registry(result.workbook, registry);
                self.udf_worker = preserved_worker;
                self.push_xlsx_import_diagnostics(&report);
                Ok(())
            }
            "csv" => {
                // CSV has NO formulas (a leading `=` is imported as text), so
                // there is nothing to recompute — unlike xlsx import, this path
                // does not run a recomputer. Parse into a fresh single-sheet
                // workbook, then adopt it Option-1 (same model as `open`/xlsx
                // import: `*self = from_workbook`, registry preserved, fresh
                // op-log/undo, epoch re-minted).
                let result =
                    ql_io_csv::import_csv_bytes(bytes, ql_io_csv::CsvImportOptions::default())
                        .map_err(map_csv_err)?;
                // **6.4-2 cycle-2 audit-fix (F2):** preserve the registry into
                // graph construction (consistency with `open`/xlsx; CSV has no
                // formulas so the graph is empty either way, but the adoption
                // pattern stays uniform and correct).
                let registry = Arc::clone(&self.registry);
                // 6.4-3d (blocker D1): preserve the live UDF worker across the swap.
                let preserved_worker = self.udf_worker.take();
                *self = Self::from_workbook_with_registry(result.workbook, registry);
                self.udf_worker = preserved_worker;
                Ok(())
            }
            other => Err(EngineError::bad_argument(format!(
                "unsupported import format {other:?} (v1 supports \"xlsx\" and \"csv\")"
            ))),
        }
    }

    /// Save the live workbook + this session's op-log to a single-file `.qbook`
    /// container (inc.2c-9; **Wave H1 (2026-06-19)** — formerly a `.qbook`
    /// directory). Workbook + op-log land atomically via the single-file ZIP
    /// protocol (`ql_io::save_workbook_file_with_oplog`): the container is
    /// streamed to a sibling temp file, fsync'd, then atomically renamed onto
    /// `path` (one `rename(2)` — strictly safer than the old dir protocol's
    /// move-aside window). Under Option 1 the op-log holds only edits made since
    /// construction/`open`, so a re-save of an opened file writes just this
    /// session's edits (the documented history trade-off).
    ///
    /// The workbook display name written into the envelope is derived from the
    /// path's file stem — the `.qbook` format's own documented default; the
    /// in-memory `Workbook` carries no document name in v1. Saving onto an
    /// existing legacy `.qbook` DIRECTORY is refused loudly (`InvalidPath`);
    /// the user opens the old bundle (dir dispatch) and saves to a new path.
    fn save(&self, path: &str) -> EngineResult<()> {
        self.ensure_readable()?;
        let p = Path::new(path);
        let name = p.file_stem().and_then(|s| s.to_str()).ok_or_else(|| {
            EngineError::bad_argument(format!(
                "save path {path:?} has no file stem to derive a workbook name from"
            ))
        })?;
        ql_io::save_workbook_file_with_oplog(&self.workbook, &self.oplog, name, p)
            .map_err(map_persistence_err)?;
        Ok(())
    }

    /// Export the live workbook to in-memory bytes. v1 supports `"csv"`
    /// (inc.2c-11) and `"xlsx"` (inc.2c-12, behind the `xlsx-write` feature);
    /// any other format is a loud `BadArgument`.
    ///
    /// **csv (single-sheet, value-only):** CSV is inherently flat, and `export`
    /// is `&self` so there is no event channel to warn through. Rather than
    /// silently dropping sheets (a No-Fallbacks violation), a workbook with more
    /// than one live sheet is **refused loudly** (`BadArgument`); a single live
    /// sheet is serialised via `ql_io_csv::export_csv_bytes` (cells rendered by
    /// `ql_types::Value`'s `Display`; no number-format application in v1). A
    /// workbook with zero live sheets yields empty bytes.
    ///
    /// **xlsx (whole-workbook, inc.2c-12):** serialises ALL sheets via
    /// `ql_io_xlsx::export_xlsx_bytes` (`NewWorkbook` mode) — xlsx is multi-sheet
    /// so, unlike csv, no single-sheet restriction applies. This path exists
    /// only when the crate is built with the `xlsx-write` feature (the
    /// umya-spreadsheet writer); without it, `export("xlsx")` returns the honest
    /// `Capability`/`not_implemented_in_v1_core` error (the writer's heavy codec
    /// tree is kept out of the default reader-only build). Export fidelity
    /// caveats are NOT surfaced (the `&self` no-event-channel limitation shared
    /// with csv); errors map through `map_xlsx_err` (Appendix A).
    fn export(&self, format: &str) -> EngineResult<Vec<u8>> {
        self.ensure_readable()?;
        match format {
            "csv" => {
                let live: Vec<SheetId> = self
                    .workbook
                    .sheet_display_order()
                    .iter()
                    .copied()
                    .filter(|id| !self.workbook.is_sheet_removed(*id))
                    .collect();
                match live.as_slice() {
                    [] => Ok(Vec::new()),
                    [one] => ql_io_csv::export_csv_bytes(
                        &self.workbook,
                        *one,
                        ql_io_csv::CsvExportOptions::default(),
                    )
                    .map_err(map_csv_err),
                    many => Err(EngineError::bad_argument(format!(
                        "csv export requires a single-sheet workbook, but this one has {} live \
                         sheets; export each sheet separately (a sheet-targeted csv export is a \
                         later-version feature)",
                        many.len()
                    ))),
                }
            }
            "xlsx" => {
                #[cfg(feature = "xlsx-write")]
                {
                    // **inc.2c-12:** real xlsx export — serialize the WHOLE
                    // workbook (xlsx is multi-sheet) to bytes via the
                    // feature-gated `ql-io-xlsx` writer (`NewWorkbook` mode,
                    // Permissive policy = the defaults). Errors route through
                    // `map_xlsx_err` (Appendix A). Like csv export, this is
                    // `&self`, so there is NO event channel to surface the
                    // export report's fidelity caveats (multi-peer-format
                    // flattening, unregistered overlay customs, named-range
                    // constants); under the default Permissive policy those are
                    // dropped on the wire — the same `&self` no-warning-channel
                    // limitation as csv export (which likewise surfaces no
                    // export-fidelity report). A future surfacing channel would
                    // need either `&mut self` (events) or a richer return type;
                    // deferred.
                    let (bytes, _report) = ql_io_xlsx::export_xlsx_bytes(
                        &self.workbook,
                        &self.registry,
                        ql_io_xlsx::XlsxExportOptions::default(),
                    )
                    .map_err(map_xlsx_err)?;
                    Ok(bytes)
                }
                #[cfg(not(feature = "xlsx-write"))]
                {
                    // The xlsx writer is not compiled into this build. Honest
                    // `Capability`/`not_implemented_in_v1_core` (No-Fallbacks),
                    // never a silent empty export.
                    Err(not_implemented("export (xlsx)"))
                }
            }
            other => Err(EngineError::bad_argument(format!(
                "unsupported export format {other:?} (v1 supports \"csv\"{})",
                if cfg!(feature = "xlsx-write") {
                    " and \"xlsx\""
                } else {
                    ""
                }
            ))),
        }
    }

    fn close(&mut self) -> EngineResult<()> {
        // **M2 (6.3-1b) closure-audit HIGH (both lanes):** a recalc reserved by
        // `start_recalc` but not yet `await`ed leaves `pending_recalc` set and the
        // op `Running`. `close()` is always allowed (teardown), so without this a
        // later `await_recalc(op)` would run the recompute and flip `Closed → Ready`
        // — RESURRECTING a terminal session. Terminalize the stranded op as
        // `Canceled` (with its terminal event, preserving the "terminal ops emit a
        // terminal event" invariant) and clear the reservation, so close is
        // self-consistent. (`await_recalc` also gates on the terminal state — defense
        // in depth — but this keeps the op resolved rather than stranded `Running`.)
        if let Some((op, _)) = self.pending_recalc.take() {
            self.ops.insert(op, OperationState::Canceled);
            self.events.push(Event::OperationCompleted {
                op,
                state: OperationState::Canceled,
            });
        }
        self.state = LifecycleState::Closed;
        // Drop any open transaction buffers — they can never commit on a
        // terminal session (their handles become `transaction_not_found`).
        self.txns.clear();
        // **6.4-3d (audit-fix HIGH-3):** drop the Python-UDF worker on close so
        // its child process is killed + reaped deterministically (the
        // `ProcessWorker::drop` kills the child) — otherwise a closed session
        // would leak the worker until the whole session is dropped/GC'd.
        self.udf_worker = None;
        Ok(())
    }

    // --- Mutation — single edits (§3.2) ---

    fn set_value(&mut self, addr: CellAddr, value: CellValue) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "set_value")?;
        let v = cell_value_to_value(value)?;
        self.with_runtime(|rt| rt.set_value(addr.sheet, addr.row, addr.col, v))
            .map_err(map_runtime_err)?;
        // **H3 (6.3-0):** anchor + any dissolved spill-footprint targets (a
        // literal write over a spill anchor/target retracts the footprint → the
        // old targets must surface as removed in `snapshot_delta`).
        let mut changes = vec![SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }];
        changes.extend(self.drain_spill_footprint());
        self.record_changes(changes);
        // **R23 lineage:** a literal write retires any source attribution on this cell.
        self.drop_cell_lineage(addr);
        Ok(())
    }

    fn set_formula(&mut self, addr: CellAddr, text: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "set_formula")?;
        self.with_runtime(|rt| rt.set_formula(addr.sheet, addr.row, addr.col, text))
            .map(|_value| ())
            .map_err(map_runtime_err)?;
        // **H3 (6.3-0):** anchor + spill-footprint targets (grow/shrink/dissolve)
        // so `snapshot_delta` reports the full footprint, not just the anchor.
        let mut changes = vec![SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }];
        changes.extend(self.drain_spill_footprint());
        self.record_changes(changes);
        // **R23 lineage:** a formula write retires any source attribution on this cell.
        self.drop_cell_lineage(addr);
        Ok(())
    }

    fn clear(&mut self, addr: CellAddr) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "clear")?;
        self.with_runtime(|rt| rt.clear_formula(addr.sheet, addr.row, addr.col))
            .map_err(map_runtime_err)?;
        // **H3 (6.3-0):** anchor + any dissolved spill-footprint targets (clearing
        // a spill anchor retracts the whole footprint → old targets go removed).
        let mut changes = vec![SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }];
        changes.extend(self.drain_spill_footprint());
        self.record_changes(changes);
        // **R23 lineage:** `clear` (clear_formula) is a NO-OP on a value cell — and a
        // source-produced cell is a value cell — so it never changes a tracked cell's
        // content and must NOT drop lineage (the cell still holds the source's value).
        // It only de-formulizes a formula cell, which is never source-produced.
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

    fn set_style(&mut self, addr: CellAddr, style: StyleIdDto) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "set_style")?;
        let id = dto_style_id_to_storage(style);
        self.with_runtime(|rt| rt.set_cell_style(addr.sheet, addr.row, addr.col, Some(id)))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::Cell {
            sheet: addr.sheet,
            row: addr.row,
            col: addr.col,
        }]);
        Ok(())
    }

    fn register_style(&mut self, style: StyleDto) -> EngineResult<StyleIdDto> {
        self.ensure_ready()?;
        let storage_style = dto_style_to_storage(style);
        let id = self
            .with_runtime(|rt| rt.intern_style(storage_style))
            .map_err(map_runtime_err)?;
        self.record_changes([SessionChange::StyleAdded { id }]);
        Ok(storage_style_id_to_dto(id))
    }

    fn nudge_cell_decimals(&mut self, addr: CellAddr, delta: i32) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(addr.sheet, "nudge_cell_decimals")?;
        // The runtime reads the cell's current format, nudges it, and (when the
        // result differs) interns the new format + rebinds the cell, returning
        // the new FormatId. `None` ⇒ no-op (clamp boundary / non-numeric format
        // / delta 0) ⇒ nothing to record.
        let new_id = self
            .with_runtime(|rt| rt.nudge_cell_decimals(addr.sheet, addr.row, addr.col, delta))
            .map_err(map_runtime_err)?;
        if let Some(id) = new_id {
            // Surface the (possibly newly-interned) format id AND the cell
            // rebinding, exactly as register_format + set_format would.
            // FormatAdded is idempotent if the format already existed.
            self.record_changes([
                SessionChange::FormatAdded { id },
                SessionChange::Cell {
                    sheet: addr.sheet,
                    row: addr.row,
                    col: addr.col,
                },
            ]);
        }
        Ok(())
    }

    fn nudge_decimals_preview(&self, addr: CellAddr, delta: i32) -> EngineResult<Option<String>> {
        self.ensure_readable()?;
        self.require_live_sheet(addr.sheet, "nudge_decimals_preview")?;
        // Read-only compute against the live workbook (no `&mut`/oplog needed, like
        // `validate_formula`): returns the nudged format STRING, or `None` for a no-op.
        // The host registers + applies it via one `batch`, so the undo history is
        // untouched here. An unmodellable format surfaces loud via `map_runtime_err`.
        crate::workbook_runtime::compute_nudged_format(&self.workbook, addr.sheet, addr.row, addr.col, delta)
            .map_err(map_runtime_err)
    }

    fn set_rows_hidden(
        &mut self,
        sheet: SheetId,
        rows: &[RowId],
        hidden: bool,
    ) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(sheet, "set_rows_hidden")?;
        // The runtime appends ONE `Op::SetRowsHidden` (state-changing rows only),
        // mutates the hidden set, and dirties the SUBTOTAL dependents.
        //
        // We deliberately record NO per-cell `SessionChange` here (Opus-fork MED):
        // a hidden row's cell VALUES do not change, so the snapshot delta needs
        // nothing for those cells. The visibility METADATA reaches the client via
        // `hidden_rows()` (a pull), not the cell delta; and the SUBTOTAL recompute
        // records its OWN changed cells through the standard recalc path. Emitting
        // `rows x col_extent` Cell changes here would both over-record unchanged
        // cells AND allocate O(rows x col_extent) up-front — fine for a single
        // gutter-hide, but a wide-sheet autofilter hiding 100k rows would blow up.
        // (The delta consumer's `classify_delta_op` already forces a full rebuild
        // when an `Op::SetRowsHidden` lands in the delta window, so the cache-only
        // read path stays correct.)
        self.with_runtime(|rt| rt.set_rows_hidden(sheet, rows, hidden))
            .map_err(map_runtime_err)?;
        Ok(())
    }

    fn hidden_rows(&self, sheet: SheetId) -> EngineResult<Vec<RowId>> {
        self.ensure_readable()?;
        self.require_live_sheet(sheet, "hidden_rows")?;
        Ok(self
            .workbook
            .sheet(sheet)
            .expect("require_live_sheet guards sheet bounds")
            .hidden_rows()
            .iter()
            .copied()
            .collect())
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
            &self.registry,
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
        //
        // **6.1C audit-fix M3:** bracket the append+mutate window with a
        // `FaultGuard` so a panic mid-flight transitions →`Faulted` rather than
        // leaving `state = Ready` with the op-log torn from the workbook. The
        // graceful `Err` from `oplog.append` disarms before propagating; only an
        // actual unwind triggers the fault. The block scope releases the
        // guard's `&mut self.state` borrow before `record_changes` runs.
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            match self
                .oplog
                .append(Op::RemoveSheet { id })
                .map_err(oplog_append_err)
            {
                Ok(()) => {
                    self.workbook.remove_sheet(id);
                    guard.armed = false;
                }
                Err(e) => {
                    guard.armed = false;
                    return Err(e);
                }
            }
        }
        self.record_changes([SessionChange::SheetRemoved { id }]);
        // TE1 (D-RANGEMOVE): bindings whose target lives on the deleted sheet are
        // invalidated (`alive=false`) — mirrors the host's `#REF!` badge handling
        // for a now-deleted sheet; a read returns the dead binding, never a
        // stale-live one.
        self.invalidate_bindings_for_sheet(id);
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
        // **6.1C audit-fix M3:** FaultGuard around append+mutate (see
        // `delete_sheet` for the rationale; same pattern).
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            match self
                .oplog
                .append(Op::RestoreSheet { id })
                .map_err(oplog_append_err)
            {
                Ok(()) => {
                    self.workbook.restore_sheet(id);
                    guard.armed = false;
                }
                Err(e) => {
                    guard.armed = false;
                    return Err(e);
                }
            }
        }
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
        // **6.1C audit-fix M3:** FaultGuard around append+mutate (see
        // `delete_sheet` for the rationale; same pattern).
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            match self
                .oplog
                .append(Op::MoveSheet {
                    id,
                    new_index: index,
                })
                .map_err(oplog_append_err)
            {
                Ok(()) => {
                    self.workbook.move_sheet(id, index);
                    guard.armed = false;
                }
                Err(e) => {
                    guard.armed = false;
                    return Err(e);
                }
            }
        }
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
        // No change-log record: defined names are not part of the incremental
        // delta surface (`WorkbookSnapshotDelta`), so a name definition is
        // delta-invisible. They DO surface in the FULL `WorkbookSnapshot.names`
        // field (FE-5 W-N); the IDE Name-Manager refreshes via `snapshot()`.
    }

    fn delete_name(&mut self, name: &str, scope: Option<SheetId>) -> EngineResult<()> {
        self.ensure_ready()?;
        // Routes to the runtime wrapper, which appends the compensating
        // `Op::RemoveName` BEFORE the in-memory clear (so a re-materialize
        // doesn't resurrect the name) and fails loud (`name_not_found`) on a
        // name that isn't registered in the target scope (No-Fallbacks).
        match scope {
            None => self
                .with_runtime(|rt| rt.delete_name(name))
                .map_err(map_runtime_err),
            Some(sheet) => self
                .with_runtime(|rt| rt.delete_sheet_scoped_name(sheet, name))
                .map_err(map_runtime_err),
        }
        // Like `set_name`, no change-log record: defined-name removal is
        // delta-invisible; the Name-Manager refreshes via a full `snapshot()`.
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
                SessionOp::SetStyle { addr, style } => {
                    self.require_live_sheet(addr.sheet, "batch.set_style")?;
                    Self::require_in_bounds(addr.row, addr.col, "batch.set_style")?;
                    let id = dto_style_id_to_storage(*style);
                    // Mirror `set_cell_style`'s producer-side gate: refuse an
                    // unregistered id up front (BadArgument), pre-mutation.
                    let resolved = self.workbook.styles().lookup(id);
                    if resolved.is_none() {
                        return Err(EngineError::new(
                            ErrorClass::BadArgument,
                            "unknown_style_id",
                            format!("batch.set_style: style id {id:?} is not registered"),
                        ));
                    }
                    // **FE-9 (2026-06-14):** collapse an empty/default style to a
                    // CLEAR, matching `set_cell_style`. Phase 3 applies via
                    // `set_cell_style(Some(id))`, which collapses the LIVE overlay;
                    // the LOGGED op must collapse identically or replay/undo/reload
                    // would resurrect a phantom (op said `Some(empty)` while the
                    // live state cleared). No-Fallbacks: the unknown-id refusal
                    // above is preserved; only a resolves-to-default id collapses.
                    let logged_id = match resolved {
                        Some(s) if s.is_empty() => None,
                        _ => Some(ql_oplog::StyleIdWire::from_storage(id)),
                    };
                    inner_ops.push(Op::SetCellStyle {
                        sheet: addr.sheet,
                        row: addr.row,
                        col: addr.col,
                        id: logged_id,
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
        // **6.1C audit-fix M3:** Phase 2 (the single `Op::BatchCommit` append)
        // runs OUTSIDE `with_runtime_no_oplog`'s FaultGuard. A Loro-internal
        // panic during `append` (practically unreachable, but the contract §8
        // promise is "panic → Faulted, not Ready") would otherwise leave the
        // session in `Ready` with a partially-written op-log. Bracket the
        // append in a `FaultGuard` so an unwind here seals the session, and
        // Phase 3 below (inside `with_runtime_no_oplog`) preserves its own.
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            let append_res = self
                .oplog
                .append(Op::BatchCommit { ops: inner_ops })
                .map_err(oplog_append_err);
            guard.armed = false;
            append_res?;
        }

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
                    SessionOp::SetStyle { addr, style } => {
                        let id = dto_style_id_to_storage(*style);
                        rt.set_cell_style(addr.sheet, addr.row, addr.col, Some(id))?;
                    }
                }
            }
            Ok(())
        })
        .map_err(map_runtime_err)?;

        // **R23 lineage:** a value/formula op overwrites the cell's content, so it
        // retires any source attribution. `Clear` (clear_formula) is a NO-OP on a
        // value cell (and a source-produced cell IS a value cell), so it does NOT
        // drop lineage — consistent with the single-cell `clear`, and it is exactly
        // the all-`Clear`-no-op batch that takes the empty-`inner_ops` early return
        // above (so nothing is skipped here). Format/style ops also leave the source
        // intact. Provenance recorders (materialize/publish via write_range -> batch)
        // RE-establish the forward entry through `record_block_provenance` AFTER this
        // returns (SetValue/SetFormula always yield non-empty `inner_ops`, so this
        // loop is never skipped for them), so dropping here is transient for them and
        // sticks only for genuine user value/formula writes.
        for op in &ops {
            match op {
                SessionOp::SetValue { addr, .. } | SessionOp::SetFormula { addr, .. } => {
                    self.drop_cell_lineage(*addr)
                }
                SessionOp::Clear { .. }
                | SessionOp::SetFormat { .. }
                | SessionOp::SetStyle { .. } => {}
            }
        }

        // --- Phase 4: advance state_seq exactly once for the whole batch. ---
        // **H3 (6.3-0):** fold in any spill-footprint targets touched by the
        // batch's set_formula/set_value/clear ops (drained from the Phase-3
        // runtime) alongside the per-op anchor changes built in Phase 1, so
        // `snapshot_delta` reports the full footprint for batched/transacted
        // spill edits too.
        changes.extend(self.drain_spill_footprint());
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

    // **M2 (6.3-1b):** `start_recalc`/`await_recalc` are the windowed split of the
    // recalc ops — the contract §6.4 "start → wait/cancel" shape that makes a
    // pre-start cancel actually work (pre-6.3-1b, `cancel` wrote `Canceled` but
    // nothing read it). They are `EngineSession` trait methods (the binding-neutral
    // op surface, alongside `recalc_dirty`/`recalc_all`/`cancel`); the private
    // inherent `execute_recalc` is the shared recompute body.
    fn start_recalc(&mut self, kind: RecalcKind) -> EngineResult<OperationId> {
        // `ensure_ready` rejects a second concurrent start (already `Busy` with the
        // first in-flight op) and any non-`Ready` state.
        self.ensure_ready()?;
        let op = self.next_op();
        self.ops.insert(op, OperationState::Running);
        self.state = LifecycleState::Busy;
        self.pending_recalc = Some((op, kind));
        Ok(op)
    }

    fn await_recalc(&mut self, op: OperationId) -> EngineResult<()> {
        // **M2 (6.3-1b) closure-audit HIGH (both lanes):** never resurrect a terminal
        // session. If the session went `Closed`/`Faulted` after `start_recalc` (e.g.
        // `close()` mid-window), drain any stranded reservation and reject — running
        // the recompute here would flip the state back to `Ready`. (`close()` also
        // terminalizes the op as `Canceled`; this guard is the second line of defense
        // and the honest `invalid_state` for the caller.)
        if matches!(self.state, LifecycleState::Closed | LifecycleState::Faulted) {
            self.pending_recalc = None;
            return Err(EngineError::invalid_state(
                "await_recalc: session is terminal (Closed/Faulted); the reserved recalc is abandoned",
            ));
        }
        // Validate `op` is the in-flight recalc before consuming the reservation.
        match self.pending_recalc {
            None => {
                return Err(EngineError::bad_argument(
                    "await_recalc: no recalc is in progress (call start_recalc first)",
                ));
            }
            Some((pending_op, _)) if pending_op != op => {
                return Err(EngineError::bad_argument(format!(
                    "await_recalc: op {op:?} is not the in-flight recalc ({pending_op:?})"
                )));
            }
            Some(_) => {}
        }
        let (op, kind) = self.pending_recalc.take().expect("pending validated above");

        // **Pre-start cancel check (the §6.4 guarantee, now functional).** A
        // `cancel(op)` between `start_recalc` and here flipped the op to `Canceled`;
        // honor it by NOT recomputing — no commit, no change-log/epoch advance, no
        // partial state. Emit the terminal event (the "terminal ops emit a terminal
        // event" invariant from the 6.3-1a audit — `cancel` itself only writes the
        // state) and release `Busy` back to `Ready`.
        if matches!(self.ops.get(&op), Some(OperationState::Canceled)) {
            self.state = LifecycleState::Ready;
            self.events.push(Event::OperationCompleted {
                op,
                state: OperationState::Canceled,
            });
            return Ok(());
        }

        // Not canceled → run the synchronous recompute. Dispatch the stored kind to
        // the matching `WorkbookRuntime` call (the recompute closure can't be stored
        // across the start→await boundary, so `RecalcKind` carries the intent).
        match kind {
            RecalcKind::Dirty => self.execute_recalc(op, |rt| rt.recompute_dirty()),
            RecalcKind::All => self.execute_recalc(op, |rt| Some(rt.recompute_all())),
        }
        Ok(())
    }

    // **M2 (6.3-1b):** `recalc_dirty`/`recalc_all` are the one-shot CONVENIENCE
    // wrappers — `start_recalc` + `await_recalc` in a single call. Because both run
    // under one binding lock with nothing interleaved, there is NO cancel window
    // here (identical observable behavior to the pre-6.3-1b single call); the
    // windowed path is the explicit `start_recalc`/`await_recalc` pair the binding
    // exposes separately. `ensure_ready` lives in `start_recalc`, so these no longer
    // gate it themselves (no double-gate).
    fn recalc_dirty(&mut self) -> EngineResult<OperationId> {
        let op = self.start_recalc(RecalcKind::Dirty)?;
        self.await_recalc(op)?;
        Ok(op)
    }

    fn recalc_all(&mut self) -> EngineResult<OperationId> {
        let op = self.start_recalc(RecalcKind::All)?;
        self.await_recalc(op)?;
        Ok(op)
    }

    fn mark_volatiles_dirty(&mut self) -> EngineResult<()> {
        self.ensure_ready()?;
        // **6.1C audit-fix M3:** the graph mutator runs outside `with_runtime`
        // (no op-log append, no workbook mutation), but a panic here would still
        // leave the calcgraph in a half-marked state with `state = Ready`. Wrap
        // in a FaultGuard so any unwind seals the session → `Faulted` per the
        // contract §8 panic-safety promise.
        let mut guard = FaultGuard {
            state: &mut self.state,
            armed: true,
        };
        // **MEGAUDIT fix (2026-05-29; Codex-B HIGH):** call the graph's
        // `mark_volatile_dirty`, which marks each volatile node dirty AND fans
        // out the transitive reverse-dep graph from each volatile cell. The
        // previous code looped `self.graph.mark_dirty(node)` per volatile
        // formula — but `mark_dirty` (pub(crate), for coordinated recovery
        // only) inserts ONLY that node, with NO fanout. So a downstream
        // `C1 = B1 + 1` over a volatile `B1 = MYUDF(A1)` (or RAND/NOW) stayed
        // STALE after `mark_volatiles_dirty` + `recalc_dirty`, because
        // `recompute_dirty` re-dirties dependents only through spill writes,
        // not ordinary value changes — it relies on the dirty set being
        // pre-fanned-out (which is exactly what `mark_volatile_dirty` does).
        // Pre-dates 6.4-3c (affects all volatile fns); surfaced because UDFs
        // are the first host-declared-volatile functions with dependents.
        self.graph.mark_volatile_dirty();
        guard.armed = false;
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
        // Per-snapshot-call render cache (CONVERGENT-MED-2 mirror): one
        // `format::parse` per unique `FormatId` for the WHOLE snapshot — the
        // same granularity as the CollabSession `workbook_snapshot` path.
        let mut parsed_format_cache: HashMap<
            ql_storage::FormatId,
            ql_functions::format::FormatString,
        > = HashMap::new();
        for &sheet_id in self.workbook.sheet_display_order() {
            if self.workbook.is_sheet_removed(sheet_id) {
                continue;
            }
            if let Some(snap) = self.build_sheet_snapshot(sheet_id, &mut parsed_format_cache) {
                sheets.push(snap);
            }
        }
        // **6.1C audit-fix H2 — deterministic `formats` ordering.** The
        // upstream `FormatTable::iter()` is HashMap-backed (arbitrary order, per
        // `ql-storage/src/format.rs`), while the shared `WorkbookSnapshot.formats`
        // docs promise sorted-by-`FormatId` (`crates/ql-bindings-node/src/lib.rs`
        // `WorkbookSnapshotJson.formats`; `CollabSession`'s napi delta path
        // already sorts). Sort here so EVERY binding sees a stable order and
        // golden-test diffs / `JSON.stringify`-equal comparisons hold. Cost is
        // O(n log n) on the format-table size (typically < 100); negligible.
        let mut formats: Vec<FormatDef> = self
            .workbook
            .formats()
            .iter()
            .map(|(id, s)| FormatDef {
                id: storage_format_id_to_dto(id),
                string: s.to_string(),
            })
            .collect();
        formats.sort_by_key(|fd| fd.id);
        // **FE-4 W4:** the session-wide style table, sorted by StyleId for a
        // stable wire order (mirrors `formats` above).
        let mut styles: Vec<StyleDef> = self
            .workbook
            .styles()
            .iter()
            .map(|(id, style)| StyleDef {
                id: storage_style_id_to_dto(id),
                style: storage_style_to_dto(style),
            })
            .collect();
        styles.sort_by_key(|sd| sd.id);
        let date_system = date_system_to_dto(self.workbook.date_system());
        // **FE-5 W-N:** enumerate BOTH workbook-scoped and every sheet's
        // sheet-scoped defined names (helper walks both — missing either is a
        // silent data loss). Sorted for a stable wire shape.
        let names = collect_named_ranges(&self.workbook);
        // **Builder E (2026-06-13):** every structured table (all sheets), sorted.
        let tables = collect_tables(&self.workbook);
        Ok(WorkbookSnapshot {
            schema_version: SCHEMA_VERSION,
            sheets,
            formats,
            styles,
            date_system,
            names,
            tables,
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
        let mut added_styles: HashSet<ql_storage::StyleId> = HashSet::new();
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
                SessionChange::StyleAdded { id } => {
                    added_styles.insert(id);
                }
            }
        }

        // Per-delta-call render cache (CONVERGENT-MED-2 mirror — the
        // CollabSession delta path keeps one `parsed_format_cache` per
        // `workbook_snapshot_delta` call); shared across BOTH the per-cell
        // `changed_cells` walk and the `sheets_changed` full-sheet rebuilds.
        let mut parsed_format_cache: HashMap<
            ql_storage::FormatId,
            ql_functions::format::FormatString,
        > = HashMap::new();

        // Resolve cell changes to current committed state: present → changed,
        // absent → removed. A cell on a now-tombstoned sheet is conveyed via
        // `sheets_removed`, so skip it here (avoids a redundant per-cell entry).
        let mut changed_cells = Vec::new();
        let mut removed_cells = Vec::new();
        for (sheet, row, col) in changed_coords {
            if self.workbook.is_sheet_removed(sheet) {
                continue;
            }
            match self.build_cell_snapshot(sheet, row, col, &mut parsed_format_cache) {
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
            if let Some(snap) = self.build_sheet_snapshot(id, &mut parsed_format_cache) {
                sheets_changed.push(snap);
            }
        }
        let mut sheets_removed: Vec<SheetId> = removed_sheets
            .into_iter()
            .filter(|id| self.workbook.is_sheet_removed(*id))
            .collect();

        // Resolve added formats to their current `FormatDef`.
        let mut formats_added: Vec<FormatDef> = added_formats
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

        // **FE-4 W4:** resolve added styles to their current `StyleDef`
        // (mirrors `formats_added`).
        let mut styles_added: Vec<StyleDef> = added_styles
            .into_iter()
            .filter_map(|id| {
                self.workbook.styles().lookup(id).map(|style| StyleDef {
                    id: storage_style_id_to_dto(id),
                    style: storage_style_to_dto(style),
                })
            })
            .collect();

        // **6.1C audit-fix H2 — deterministic ordering across all five delta
        // collections.** The HashSet walks above (`changed_coords`,
        // `changed_sheets`, `removed_sheets`, `added_formats`) produce arbitrary
        // iteration order, so consecutive deltas with identical logical content
        // would otherwise differ on the wire. Sort each output by its natural
        // key so consumers get byte-stable JSON, golden-test diffs hold, and
        // every binding sees the same shape (CollabSession's napi delta path
        // already sorts the comparable arrays). Cost is O(n log n) on the per-
        // call change-count, dwarfed by `build_cell_snapshot` / `build_sheet_snapshot`.
        changed_cells.sort_by_key(|c| (c.sheet, c.cell.row, c.cell.col));
        removed_cells.sort_by_key(|c| (c.sheet, c.row, c.col));
        sheets_changed.sort_by_key(|s| s.id);
        sheets_removed.sort_unstable();
        formats_added.sort_by_key(|fd| fd.id);
        styles_added.sort_by_key(|sd| sd.id);

        Ok(WorkbookSnapshotDelta {
            schema_version: SCHEMA_VERSION,
            changed_cells,
            removed_cells,
            sheets_changed,
            sheets_removed,
            formats_added,
            styles_added,
            version: self.current_version(),
            full_rebuild_required: false,
            full_rebuild_reason: None,
        })
    }

    fn cell(&self, addr: CellAddr) -> EngineResult<Option<CellSnapshot>> {
        self.ensure_readable()?;
        self.require_live_sheet(addr.sheet, "cell")?;
        Self::require_in_bounds(addr.row, addr.col, "cell")?; // F4

        // Single-cell read: a throwaway render cache (at most one parse).
        let mut parsed_format_cache = HashMap::new();
        Ok(self.build_cell_snapshot(addr.sheet, addr.row, addr.col, &mut parsed_format_cache))
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

    fn list_names(&self) -> EngineResult<Vec<NamedRange>> {
        self.ensure_readable()?;
        // Walks BOTH workbook-scoped and every sheet's sheet-scoped names
        // (same helper as `snapshot().names`). Reads the live workbook
        // directly — no rebuild — so it reflects the current in-memory state
        // (incl. a just-applied `delete_name`).
        Ok(collect_named_ranges(&self.workbook))
    }

    fn table_columns(&self, table: &str) -> EngineResult<Vec<String>> {
        self.ensure_readable()?;
        // Reads the live workbook directly (no rebuild) — like `list_names` —
        // so it reflects the current in-memory roster (incl. a just-applied
        // `rename_column` / `resize_table`). Canonical (uppercase) lookup matches
        // every other table op (e.g. `resize_table`'s `name.to_ascii_uppercase()`).
        // An absent table routes through the SAME `map_runtime_err` as drop/rename
        // so the `table_not_found` error is byte-identical (No-Fallbacks: one error
        // contract, never a divergent code).
        let canonical = table.to_ascii_uppercase();
        let meta = self
            .workbook
            .tables()
            .lookup(&canonical)
            .ok_or_else(|| map_runtime_err(RuntimeError::TableNotFound(table.to_owned())))?;
        Ok(meta
            .columns
            .iter()
            .map(|c| c.display.as_ref().to_owned())
            .collect())
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

    // --- Functions (§3.9; substrate 6.4-0, completion 6.4-1, trait-wiring 6.4-2) ---

    /// **6.4-2 (2026-05-28):** combined UDF metadata + dispatch-handle
    /// registration. Calls [`ql_functions::FunctionRegistry::register_udf`]
    /// (which calls `register_metadata` then inserts the handle on success,
    /// bumping `fn_gen` exactly once), then fires the
    /// [`CalcgraphSession::on_function_registered`] hook so every formula
    /// referencing the (previously-unknown) name dirties + transitive-fans.
    ///
    /// The `fn_gen` bump invalidates [`PlanCacheKey`] entries that were
    /// minted before this call, so the next eval re-binds + re-extracts
    /// deps against the new metadata — closes contract §10.3's
    /// "re-extract deps" half. The dirty fanout closes the "dirties every
    /// formula referencing that canonical name (reschedule)" half.
    ///
    /// **Errors (Appendix A):**
    /// - `Conflict / function_exists` — canonical name already registered
    ///   (built-in or existing UDF). Via [`map_function_registry_err`].
    /// - `Capability / session_busy` / `Capability / invalid_state` —
    ///   gated by [`Self::ensure_ready`]; mutator legal only in `Ready`.
    ///
    /// **No event emission v1:** function registration is session-scoped
    /// tooling (not document state — `open` / `import` deliberately
    /// preserve the registry across workbook adoption); contract §9
    /// doesn't list it as a `StructureChanged` source. Filed for 6.4-3 if
    /// observability demands it.
    ///
    /// **No version-token bump:** registry mutation does not advance the
    /// `{epoch, op_count}` token — the workbook + op-log are untouched.
    /// `snapshot()` after `register_function` returns the same token as
    /// before; consumers polling on the token won't see a change. This is
    /// deliberate (registry IS tooling, not document state).
    ///
    /// **FaultGuard discipline:** the registry mutation + graph hook are
    /// two separate state mutations on `self`. A panic between them would
    /// leave `fn_gen` bumped + metadata registered + handle inserted but
    /// no dirty fanout — a subtle inconsistency. Bracket the pair with a
    /// [`FaultGuard`] matching the 6.1C audit-fix M3 pattern at
    /// [`Self::delete_sheet`]. Disarms cleanly on the
    /// `register_udf`-returned-Err path so a legitimate `Conflict` does
    /// NOT seal the session.
    fn register_function(
        &mut self,
        metadata: FunctionMetadata,
        impl_handle: FunctionImplHandle,
    ) -> EngineResult<()> {
        self.ensure_ready()?;
        // **6.4-2 cycle-2 audit-fix (H1/F1 — Codex + Opus, both lanes):**
        // validate the canonical name BEFORE touching the registry.
        // [`ql_functions::FunctionRegistry::register_metadata`] `assert!`s the
        // name is non-empty + ASCII-upper-case (`registry.rs:357,:361`) — those
        // are INTERNAL invariants, not input validation. Reaching them from JS
        // over napi (which has NO `catch_unwind`, `ql-bindings-node/src/lib.rs:19`)
        // would PANIC the host; worse, the panic would unwind through the armed
        // `FaultGuard` below and permanently seal the session `Faulted` — one
        // bad input bricks the session. Convert a non-canonical name into a loud
        // structured `bad_argument` here (No-Fallbacks: a caller contract
        // violation surfaces honestly; it is NOT silently normalized).
        validate_canonical_function_name(&metadata.canonical_name)?;
        // Stash the canonical name BEFORE `register_udf` moves `metadata`
        // into the registry — needed for the dirty-fanout hook.
        let canonical_name = metadata.canonical_name.clone();
        // FaultGuard around registry + graph mutation (6.1C audit-fix M3 pattern).
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            match Arc::make_mut(&mut self.registry)
                .register_udf(metadata, impl_handle)
                .map_err(map_function_registry_err)
            {
                Ok(()) => {
                    // Substrate hook: dirty every dependent formula +
                    // transitive-fan. Returns the directly-dirtied count
                    // (downstream-of-downstream handled transitively by
                    // `mark_dirty_from_cell_write`).
                    let _dirty_count = self.graph.on_function_registered(&canonical_name);
                    guard.armed = false;
                }
                Err(e) => {
                    guard.armed = false;
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    /// **6.4-2 (2026-05-28):** symmetric counterpart to
    /// [`Self::register_function`]. Removes UDF metadata via
    /// [`ql_functions::FunctionRegistry::unregister_metadata`] (which
    /// clears the matching `udf_handles` entry symmetrically + bumps
    /// `fn_gen` on success), then fires
    /// [`CalcgraphSession::on_function_unregistered`] for the dirty
    /// fanout. After this call, formulas referencing the now-missing
    /// canonical name will surface `#NAME?` on the next eval (dispatch is
    /// gone from `RegisteredFn`; `scalar.rs:463` returns
    /// `Value::Error(ErrorValue::Name)` for missing-function calls).
    ///
    /// **Errors (Appendix A):**
    /// - `NotFound / function_not_found` — name has no metadata (never
    ///   registered, or already unregistered). Via [`map_function_registry_err`].
    /// - `Conflict / function_exists` — name is a built-in (dispatch entry
    ///   still present); the registry's builtin-guard prevents removing
    ///   built-in metadata. The mapper translates `Conflict` to
    ///   `function_exists` regardless of variant; the message distinguishes.
    /// - `Capability / session_busy` / `Capability / invalid_state` —
    ///   gated by [`Self::ensure_ready`].
    fn unregister_function(&mut self, canonical_name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        // FaultGuard around registry + graph mutation (6.1C audit-fix M3 pattern).
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            match Arc::make_mut(&mut self.registry)
                .unregister_metadata(canonical_name)
                .map_err(map_function_registry_err)
            {
                Ok(()) => {
                    let _dirty_count = self.graph.on_function_unregistered(canonical_name);
                    guard.armed = false;
                }
                Err(e) => {
                    guard.armed = false;
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    /// **6.4-2 (2026-05-28):** list every registered function (built-ins +
    /// UDFs) with full metadata. Reads via
    /// [`ql_functions::FunctionRegistry::sorted_metadata`] (M3 from 6.4-1)
    /// for deterministic ordering by `canonical_name` — matches the 6.1C
    /// H2 ordering discipline for snapshot DTOs (Vecs serialized over the
    /// wire MUST be call-stable; a 5-way megaudit caught the snapshot
    /// `formats` non-determinism at exactly this seam).
    ///
    /// Allocates `Vec<&FunctionMetadata>` of registry-len size at the
    /// registry layer, then clones each entry into the owned `Vec<FunctionMetadata>`
    /// the DTO returns. v1 sizes (~260 builtins + UDFs) keep this cheap.
    ///
    /// **Gate:** [`Self::ensure_readable`] (Ready/Busy OK; rejects
    /// New/Closed/Faulted). Matches `snapshot`/`cell`/`list_sheets`.
    fn list_functions(&self) -> EngineResult<Vec<FunctionMetadata>> {
        self.ensure_readable()?;
        Ok(self
            .registry
            .sorted_metadata()
            .into_iter()
            .cloned()
            .collect())
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

    /// **6.5-0:** bulk rectangular literal write — the substrate every
    /// materialize path (SQL result, connector refresh) builds on. After
    /// validating the rectangle (range/shape/cap), it lowers the matrix to one
    /// [`SessionOp::SetValue`] per cell and applies them through
    /// [`batch`](WorkbookSession::batch) — so the whole bulk write is ONE atomic
    /// command: validate-all-then-apply (no partial write on any input error), a
    /// SINGLE `Op::BatchCommit` (so the write is ONE undo unit, not N — undo
    /// reverts the entire range), and the version token advances exactly once.
    /// `values` is row-major and must match the range shape EXACTLY — a mismatch
    /// is a loud `bad_argument`, never a silent truncate/pad (No-Fallbacks).
    /// `Blank` clears a cell (the same `set_value`/`batch` input semantics). A
    /// per-cell `set_value` loop would be WRONG here: each call appends its own
    /// op-log commit, splitting one logical write into N undo units.
    fn write_range(
        &mut self,
        range: CellRange,
        values: Vec<Vec<CellValue>>,
    ) -> EngineResult<WriteRangeResult> {
        self.ensure_ready()?;
        self.require_live_sheet(range.sheet, "write_range")?;

        // Range validation mirrors `query_range` (F4): reject an inverted range,
        // then both corners must lie in the addressable grid (an `end = u32::MAX`
        // span would overflow the `end - start + 1` arithmetic below).
        if range.end_row < range.start_row || range.end_col < range.start_col {
            return Err(EngineError::bad_argument(
                "write_range: range end coordinate is before its start",
            ));
        }
        Self::require_in_bounds(range.start_row, range.start_col, "write_range")?;
        Self::require_in_bounds(range.end_row, range.end_col, "write_range")?;
        let n_rows = range.end_row - range.start_row + 1;
        let n_cols = range.end_col - range.start_col + 1;
        // Same OOM guard as `query_range`: a fixed cell cap fails loud rather than
        // accepting a pathological whole-grid write.
        const MAX_CELLS: u64 = 1 << 20; // ~1M cells
        let cell_count = (n_rows as u64) * (n_cols as u64);
        if cell_count > MAX_CELLS {
            return Err(EngineError::bad_argument(format!(
                "write_range: {n_rows}x{n_cols} exceeds the {MAX_CELLS}-cell write cap"
            )));
        }

        // Shape must match the range EXACTLY, validated before any mutation.
        if values.len() as u64 != n_rows as u64 {
            return Err(EngineError::bad_argument(format!(
                "write_range: values has {} row(s), range spans {n_rows} row(s)",
                values.len()
            )));
        }
        for (i, row) in values.iter().enumerate() {
            if row.len() as u64 != n_cols as u64 {
                return Err(EngineError::bad_argument(format!(
                    "write_range: values row {i} has {} cell(s), range spans {n_cols} column(s)",
                    row.len()
                )));
            }
        }

        // Lower the matrix to one `SetValue` op per cell (row-major), then apply
        // them as a SINGLE atomic command via `batch`. `batch` validates every op
        // pre-mutation (a literal error / Pending / non-finite value fails loud in
        // its Phase 1 with NO partial write), logs ONE `Op::BatchCommit` under a
        // FaultGuard (so the bulk write is one undo unit), dirties dependents, and
        // advances the version token exactly once. Each cell of a rectangle is a
        // distinct address, so `batch`'s same-cell value/formula conflict guard
        // never fires here.
        let sheet = range.sheet;
        let start_row = range.start_row;
        let start_col = range.start_col;
        let mut ops: Vec<SessionOp> = Vec::with_capacity(cell_count as usize);
        for (r_idx, row) in values.into_iter().enumerate() {
            for (c_idx, value) in row.into_iter().enumerate() {
                ops.push(SessionOp::SetValue {
                    addr: CellAddr {
                        sheet,
                        row: start_row + r_idx as RowId,
                        col: start_col + c_idx as ColId,
                    },
                    value,
                });
            }
        }
        let result = self.batch(ops, BatchOptions::default())?;
        Ok(WriteRangeResult {
            written: result.applied,
            version: result.version,
        })
    }

    /// **ENG-FUSION:** publish a Python (or any caller) value into `target`. `data` is
    /// a JSON object `{"values": [[scalar|null, ...], ...]}` — a rectangular, row-major
    /// matrix of JSON scalars converted PER CELL (heterogeneous): finite number ->
    /// `Number`, string -> `Text`, bool -> `Boolean`, null -> `Blank`; a non-scalar
    /// element or a non-rectangular `values` is a loud `bad_argument` (No-Fallbacks).
    /// (Distinct from `materialize_query`'s per-COLUMN Arrow inference — Arrow ingestion
    /// is an FE-side concern and can be added later as another `data` variant.) The block
    /// is written anchored at `target`'s top-left via the [`write_range`] substrate (ONE
    /// `Op::BatchCommit`, dirties dependents, one version bump); it must FIT within
    /// `target` (else loud `bad_argument`) and `target` cells beyond the block are left
    /// unchanged. A zero-row value writes nothing.
    ///
    /// Provenance is recorded keyed by `name` (the dual index, exactly like
    /// `materialize_query`) for attribution. Note a published dataset is NOT
    /// `refresh_source`-able (its producer is external — re-publish to update;
    /// `refresh_source` on a `Published` source is a loud `bad_argument`).
    ///
    /// **Reactive dirty-notify (the moat):** on RE-publish under the same `name`, after
    /// writing the new block this also dirties the dependents of cells the previous value
    /// covered but the new one does not (the `refresh_source` old-cell fan-out, which
    /// `materialize_query` alone does not perform). The caller drives recomputation with
    /// a following `recalc_dirty`. Returns `PublishedRef { id }` (the caller's `name`).
    ///
    /// [`write_range`]: WorkbookSession::write_range
    fn publish_dataset(
        &mut self,
        name: &str,
        data: serde_json::Value,
        target: CellRange,
    ) -> EngineResult<PublishedRef> {
        self.ensure_ready()?;
        self.require_live_sheet(target.sheet, "publish_dataset")?;
        if target.end_row < target.start_row || target.end_col < target.start_col {
            return Err(EngineError::bad_argument(
                "publish_dataset: target range end coordinate is before its start",
            ));
        }
        Self::require_in_bounds(target.start_row, target.start_col, "publish_dataset")?;
        Self::require_in_bounds(target.end_row, target.end_col, "publish_dataset")?;
        let target_rows = (target.end_row - target.start_row + 1) as usize;
        let target_cols = (target.end_col - target.start_col + 1) as usize;

        // Convert the JSON value-matrix to a row-major cell matrix (loud bad_argument on
        // malformed / non-rectangular / non-finite / non-scalar input) BEFORE any mutation.
        let values = json_block_to_cell_values(&data)?;

        // Cells this name produced on a prior publish — captured BEFORE the write so the
        // re-publish shrink fan-out can dirty the dependents of any vacated cells.
        let old_cells: Vec<CellAddr> = self
            .provenance
            .get(name)
            .map(|e| e.cells.clone())
            .unwrap_or_default();

        let n_rows = values.len();
        if n_rows == 0 {
            // Zero-row publish: write nothing, record an (empty) provenance entry for
            // attribution, but still dirty the dependents of any previously-produced
            // cells so a shrink-to-zero reactively invalidates downstream formulas.
            self.record_block_provenance(name, target, Vec::new(), data, ProducerKind::Published);
            // TE1 (D-IDENTITY): a publish is also the DATA half of the unified
            // binding — upsert bindings[name] so the var↔cell identity exists.
            // source_id = name (the provenance key the data flows through);
            // direction is preserved (None) so a prior bind_range(Bidirectional)
            // is not downgraded; a fresh publish resets `alive` and clears any
            // undo `force_check`. Even a zero-row publish declares the envelope.
            self.upsert_binding(name, target, None, Some(name.to_string()), false);
            for cell in &old_cells {
                self.graph.on_set_value(cell.sheet, cell.row, cell.col);
            }
            return Ok(PublishedRef {
                id: name.to_string(),
            });
        }
        let n_cols = values[0].len();
        if n_rows > target_rows || n_cols > target_cols {
            return Err(EngineError::bad_argument(format!(
                "publish_dataset: data {n_rows}x{n_cols} does not fit the target range \
                 {target_rows}x{target_cols}"
            )));
        }

        // Write the block anchored at the target's top-left (validation + one BatchCommit
        // + dependent dirtying of the newly-written cells).
        let block = CellRange {
            sheet: target.sheet,
            start_row: target.start_row,
            start_col: target.start_col,
            end_row: target.start_row + (n_rows as RowId) - 1,
            end_col: target.start_col + (n_cols as ColId) - 1,
        };
        self.write_range(block, values)?;

        // Record the dual-index provenance (row-major produced cells) keyed by `name`.
        let mut produced: Vec<CellAddr> = Vec::with_capacity(n_rows * n_cols);
        for r in 0..n_rows as RowId {
            for c in 0..n_cols as ColId {
                produced.push(CellAddr {
                    sheet: target.sheet,
                    row: target.start_row + r,
                    col: target.start_col + c,
                });
            }
        }
        self.record_block_provenance(name, target, produced, data, ProducerKind::Published);
        // TE1 (D-IDENTITY): upsert the unified binding (the DATA half); see the
        // zero-row path above. The lineage invariant — bindings[name].source_id ==
        // name AND the declared target covers the produced block — is set by the
        // upsert (source_id) and guaranteed by the n_rows/n_cols ≤ target
        // validation above (the produced `block` is anchored within `target`).
        // `assert!` (not `debug_assert!`): a moat-level invariant must fail LOUD in
        // release too (No-Fallbacks) if a future refactor of the block construction
        // ever violates it. It cannot fire given the validation above.
        assert!(
            block.start_row >= target.start_row
                && block.end_row <= target.end_row
                && block.start_col >= target.start_col
                && block.end_col <= target.end_col,
            "TE1 lineage invariant: produced block must lie within the declared binding target"
        );
        self.upsert_binding(name, target, None, Some(name.to_string()), false);

        // Reactive dirty-notify: fan out over the PREVIOUS produced cells so dependents of
        // cells the new value no longer covers are dirtied. `write_range` already fired
        // `on_set_value` at every newly-written cell; firing again over the overlap is
        // idempotent, and the non-overlap (vacated) cells are exactly the shrink case.
        for cell in &old_cells {
            self.graph.on_set_value(cell.sheet, cell.row, cell.col);
        }

        Ok(PublishedRef {
            id: name.to_string(),
        })
    }

    /// **ENG-FUSION:** register `binding_id -> target` as a `BoundFrame` overlay
    /// region. `target` is validated like `write_range` (live sheet, not inverted, both
    /// corners in the addressable grid — loud `bad_argument`/`sheet_not_found`, never a
    /// silent default). Round-trip reads of the bound range use the existing
    /// `query_range`/snapshot path; this call only records the region so the FE / kernel
    /// can address it by id. Re-binding an existing id overwrites it (after validation).
    /// The binding is session-local and KEPT across undo/redo (a region pointer, not
    /// data). Returns `BoundRange { binding_id }`.
    fn bind_range(&mut self, binding_id: &str, target: CellRange) -> EngineResult<BoundRange> {
        // TE1: the trait entry preserves the existing direction (a re-bind never
        // downgrades a `Bidirectional` binding → `None`); the
        // `qb.show(editable=True)` path declares a direction explicitly via the
        // inherent `bind_range_with_direction`.
        self.bind_range_with_direction(binding_id, target, None)
    }

    /// **6.5-2:** revision-gated source refresh. Re-runs the producer (via the
    /// 6.5-1 `materialize_query` substrate) and dirties the dependents of ALL cells
    /// the source previously produced, not just the cells in the new result block.
    /// This ensures correctness when a result shrinks: a formula that depended on a
    /// cell the source no longer covers is still queued for `recalc_dirty`.
    ///
    /// `revision` is the caller's new-version counter for the external source. If
    /// `revision <= stored_revision` the source data has not changed — the call is
    /// a no-op (`dirtied = 0`; version unchanged). On the first call after a
    /// `materialize_query` the stored revision is `0`, so any positive `revision`
    /// triggers a refresh. A `revision = 0` refresh call is always a no-op.
    ///
    /// Returns `source_not_found` (`NotFound`) if `source_id` has never been
    /// materialized in this session.
    fn refresh_source(&mut self, source_id: &str, revision: u64) -> EngineResult<DirtyResult> {
        self.ensure_ready()?;

        // Extract the full provenance record under an immutable borrow; release
        // before any mutable use of `self`.
        let (kind, stored_rev, data, target, old_cells) = match self.provenance.get(source_id) {
            None => {
                return Err(EngineError::new(
                    ErrorClass::NotFound,
                    "source_not_found",
                    format!(
                        "refresh_source: source '{source_id}' has not been materialized \
                         in this session"
                    ),
                ))
            }
            Some(e) => (
                e.kind,
                e.revision,
                e.data.clone(),
                e.target,
                e.cells.clone(),
            ),
        };

        // ENG-FUSION: a published dataset (`qb.publish`) has an EXTERNAL producer (a
        // Python value the engine cannot re-run), so refresh_source cannot regenerate
        // it. Reject loudly (No-Fallbacks) rather than replaying its `{"values":...}`
        // payload through the SQL path (which would mis-parse as a missing-`sql` error).
        // A published dataset is updated by RE-publishing it.
        if kind == ProducerKind::Published {
            return Err(EngineError::bad_argument(format!(
                "refresh_source: source '{source_id}' is a published dataset (qb.publish); \
                 update it by re-publishing, not refresh_source"
            )));
        }

        // Revision gate: a caller-provided revision that is not newer than the last
        // materialization means the source data has not changed — nothing to refresh.
        if revision <= stored_rev {
            return Ok(DirtyResult {
                dirtied: 0,
                version: self.current_version(),
            });
        }

        // Snapshot dirty count before re-materializing.
        let dirty_before = self.graph.dirty_formulas().len();

        // Re-run the producer via the 6.5-1 substrate (parse SQL → run → write_range
        // → one BatchCommit → calcgraph on_set_value fans out to new cells' dependents).
        // This MUST succeed before we touch the dirty set — a failed re-materialization
        // (deleted sheet, invalid SQL, oversized result) must leave the graph dirty set
        // completely unchanged (audit MED: pre-fan-out mutates observable state on error).
        self.materialize_query(source_id, target, data)?;

        // Fan out dirty propagation over ALL previously-produced cells. This covers the
        // shrinking-result case: if the re-run no longer writes cell C, `write_range`
        // never fires `on_set_value` at C, so C's formula dependents would not be
        // dirtied without this pass. The `write_range` above already fired `on_set_value`
        // at every newly-written cell; firing again here is idempotent for the overlap.
        // Staged AFTER the successful re-materialization so a failed refresh is invisible
        // to subsequent `recalc_dirty` calls.
        for cell in &old_cells {
            self.graph.on_set_value(cell.sheet, cell.row, cell.col);
        }

        let dirty_after = self.graph.dirty_formulas().len();

        // Advance the stored revision now that re-materialization succeeded.
        if let Some(e) = self.provenance.get_mut(source_id) {
            e.revision = revision;
        }

        // Sync per-cell provenance: evict stale cells (old but not in the new result)
        // and advance the revision on current cells.
        let new_cells: Vec<CellAddr> = self
            .provenance
            .get(source_id)
            .map(|e| e.cells.clone())
            .unwrap_or_default();
        let new_cells_set: HashSet<CellAddr> = new_cells.iter().copied().collect();
        for old_cell in &old_cells {
            if !new_cells_set.contains(old_cell) {
                // Only evict if this source still owns the cell. Another source may
                // have claimed ownership via last-writer-wins since the last time
                // this source ran; removing that entry would clobber the other
                // source's provenance record.
                if self
                    .cell_provenance
                    .get(old_cell)
                    .map(|cp| cp.source_id.as_str())
                    == Some(source_id)
                {
                    self.cell_provenance.remove(old_cell);
                }
            }
        }
        for new_cell in new_cells {
            self.cell_provenance.insert(
                new_cell,
                CellProvenance {
                    source_id: source_id.to_string(),
                    revision,
                },
            );
        }

        Ok(DirtyResult {
            dirtied: dirty_after.saturating_sub(dirty_before) as u32,
            version: self.current_version(),
        })
    }

    /// **6.5-1:** materialize a SQL query result into `target`. `data` is a JSON
    /// object `{"sql": "<query>"}`; the query runs OFF the hot path (DataFusion, via
    /// the pure `ql-sql` crate) over the workbook's tables (registered by display name
    /// with their named columns) and sheets (by sheet name with A1 column-letter
    /// columns over the effective value bounds). The result is written as a block
    /// anchored at `target`'s top-left through the [`write_range`] substrate (ONE
    /// `Op::BatchCommit`, dirties dependents, one version bump); the result must FIT
    /// within `target` (else loud `bad_argument`) and cells of `target` beyond the
    /// result are left unchanged. A zero-row result writes nothing. Returns
    /// `PublishedRef { id }` (the caller's `query_id`). Per-cell provenance + the
    /// `refresh_source` re-run path are 6.5-2.
    ///
    /// [`write_range`]: WorkbookSession::write_range
    fn materialize_query(
        &mut self,
        query_id: &str,
        target: CellRange,
        data: serde_json::Value,
    ) -> EngineResult<PublishedRef> {
        self.ensure_ready()?;
        self.require_live_sheet(target.sheet, "materialize_query")?;
        if target.end_row < target.start_row || target.end_col < target.start_col {
            return Err(EngineError::bad_argument(
                "materialize_query: target range end coordinate is before its start",
            ));
        }
        Self::require_in_bounds(target.start_row, target.start_col, "materialize_query")?;
        Self::require_in_bounds(target.end_row, target.end_col, "materialize_query")?;
        let target_rows = (target.end_row - target.start_row + 1) as usize;
        let target_cols = (target.end_col - target.start_col + 1) as usize;

        let sql = parse_materialize_sql(&data)?;
        let tables = build_sql_tables(&self.workbook)?;
        // Bound execution to the target's row capacity: SQL stops after `target_rows + 1`
        // rows, so a result that cannot fit is rejected loud WITHOUT collecting OR
        // converting an oversized result (a 1-row target never materializes ~1M rows).
        let result = ql_sql::run_sql(tables, &sql, target_rows).map_err(|e| match e {
            ql_sql::SqlError::ResultTooLarge { .. } => EngineError::bad_argument(format!(
                "materialize_query: result does not fit the target range (more than \
                 {target_rows} row(s))"
            )),
            other => EngineError::new(ErrorClass::BadArgument, "sql_error", other.to_string()),
        })?;

        // Fit is checked on the RecordBatch (cheap row/col counts) BEFORE the row-major
        // conversion. `run_sql` already bounded rows at `target_rows` (else the
        // `ResultTooLarge` arm above fired); this catches the column overflow.
        let n_rows = result.num_rows();
        if n_rows == 0 {
            // A zero-row result materializes nothing (no write, no version advance).
            // record_block_provenance still records an (empty) entry so refresh_source
            // can re-run, and evicts per-cell entries from a prior non-empty run of this
            // same source (shrink-to-zero), ownership-guarded.
            self.record_block_provenance(query_id, target, Vec::new(), data, ProducerKind::Query);
            return Ok(PublishedRef {
                id: query_id.to_string(),
            });
        }
        let n_cols = result.num_columns();
        if n_rows > target_rows || n_cols > target_cols {
            return Err(EngineError::bad_argument(format!(
                "materialize_query: result {n_rows}x{n_cols} does not fit the target range \
                 {target_rows}x{target_cols}"
            )));
        }
        let values = record_batch_to_cell_values(&result)?;

        // Write the result block anchored at the target's top-left via the bulk-write
        // substrate (validation + one BatchCommit + dependent dirtying). Cells of the
        // target beyond the result block are left unchanged.
        let block = CellRange {
            sheet: target.sheet,
            start_row: target.start_row,
            start_col: target.start_col,
            end_row: target.start_row + (n_rows as RowId) - 1,
            end_col: target.start_col + (n_cols as ColId) - 1,
        };
        self.write_range(block, values)?;

        // 6.5-2: record the dual-index provenance (source_id->cells reverse + cell->source
        // forward) so refresh_source dirties all produced cells' dependents and per-cell
        // attribution works. Shared with publish_dataset via record_block_provenance.
        let mut produced: Vec<CellAddr> = Vec::with_capacity(n_rows * n_cols);
        for r in 0..n_rows as RowId {
            for c in 0..n_cols as ColId {
                produced.push(CellAddr {
                    sheet: target.sheet,
                    row: target.start_row + r,
                    col: target.start_col + c,
                });
            }
        }
        self.record_block_provenance(query_id, target, produced, data, ProducerKind::Query);

        Ok(PublishedRef {
            id: query_id.to_string(),
        })
    }
}

impl WorkbookSession {
    // ========================================================================
    // W3 (insert/delete rows & columns) — structural-axis edits on the OWNING
    // session.
    //
    // These are the methods the PRODUCT grid actually runs on (the napi
    // `Session` wraps this `WorkbookSession`; the dormant `CollabSession` is
    // v1.5). They mirror the structural-SHEET-op pattern (`delete_sheet` /
    // `restore_sheet` / `move_sheet`): append the op to the session's own
    // op-log under a `FaultGuard`, then `rematerialize` (replay the log →
    // fresh workbook with the structural edit + the rewritten formula text
    // applied, rebuild the calcgraph, recompute, and bump the epoch so the
    // grid full-re-snapshots — the change is not delta-expressible).
    //
    // The op vector is built by `crate::structural::build_structural_batch`,
    // the SAME 7-audit-pass producer core the `CollabSession` napi path uses —
    // it validates the sheet, clone-preflights the positional edit, and emits
    // `[structural_op, PutFormula×N]` where each PutFormula carries the
    // ref-FOLLOWED rewritten text at the cell's POST-shift position. Reusing it
    // (rather than re-deriving) is deliberate: this is silent-data-corruption-
    // class logic and duplication re-opens the bug surface.
    //
    // No-Fallbacks: a malformed edit (count==0 / off-grid / table-split /
    // missing/tombstoned sheet) is surfaced loud as a `[bad_argument]`
    // `EngineError` by the preflight — never a silent no-op.
    // ========================================================================

    /// Insert `count` blank rows at row index `at` on `sheet`. Rows at/below
    /// `at` shift down; formulas referencing the edited sheet have their refs
    /// rewritten to follow. `count == 0` / off-grid / table-split → loud
    /// `[bad_argument]`. `[invalid_state]` off a Ready session; `[sheet_not_found]`
    /// for an unknown sheet.
    pub fn insert_rows(&mut self, sheet: SheetId, at: RowId, count: u32) -> EngineResult<()> {
        self.apply_structural_edit(
            sheet,
            StructuralAxis::Row,
            StructuralKind::Insert { at, count },
            ql_types::MAX_ROW,
        )
    }

    /// Delete the INCLUSIVE row block `[start, end]` on `sheet`. Rows below
    /// `end` shift up; refs into the deleted block become `#REF!`. `start > end`
    /// / off-grid / table-split → loud `[bad_argument]`.
    pub fn delete_rows(&mut self, sheet: SheetId, start: RowId, end: RowId) -> EngineResult<()> {
        self.apply_structural_edit(
            sheet,
            StructuralAxis::Row,
            StructuralKind::Delete { start, end },
            ql_types::MAX_ROW,
        )
    }

    /// Insert `count` blank columns at column index `at` on `sheet`. See
    /// [`Self::insert_rows`] for the producer model.
    pub fn insert_columns(&mut self, sheet: SheetId, at: ColId, count: u32) -> EngineResult<()> {
        self.apply_structural_edit(
            sheet,
            StructuralAxis::Col,
            StructuralKind::Insert { at, count },
            ql_types::MAX_COLUMN,
        )
    }

    /// Delete the INCLUSIVE column block `[start, end]` on `sheet`. See
    /// [`Self::delete_rows`] for the producer model.
    pub fn delete_columns(&mut self, sheet: SheetId, start: ColId, end: ColId) -> EngineResult<()> {
        self.apply_structural_edit(
            sheet,
            StructuralAxis::Col,
            StructuralKind::Delete { start, end },
            ql_types::MAX_COLUMN,
        )
    }

    /// Shared driver for the four structural-axis edits. Gate Ready, require the
    /// sheet exists, build the audited `[structural_op, PutFormula×N]` batch,
    /// append it as a single `Op::BatchCommit` under a `FaultGuard`, then
    /// `rematerialize` (replay → recompute → epoch bump).
    fn apply_structural_edit(
        &mut self,
        sheet: SheetId,
        axis: StructuralAxis,
        kind: StructuralKind,
        axis_max: u32,
    ) -> EngineResult<()> {
        self.ensure_ready()?;
        // Fail-loud: an unknown sheet id → NotFound (consistent with the
        // sheet-op surface). `build_structural_batch` ALSO rejects a missing /
        // tombstoned sheet, but checking here keeps the error class identical
        // (`sheet_not_found` NotFound) to the rest of the structure surface and
        // short-circuits before the clone-preflight allocation.
        self.require_sheet_exists(sheet, "structural_edit")?;
        // Build the audited op batch (validate + clone-preflight + per-formula
        // text-shift + assembly). A rejection here is a caller-input problem →
        // map to `[bad_argument]` (No-Fallbacks: never a silent no-op).
        let ops = build_structural_batch(&self.workbook, sheet, axis, kind, axis_max)
            .map_err(map_structural_err)?;
        // **6.1C audit-fix M3 pattern (see `delete_sheet`):** bracket the op-log
        // append with a `FaultGuard` so a panic mid-flight transitions the
        // session → `Faulted` rather than leaving `state = Ready` with the
        // op-log torn from the workbook. A graceful `Err` from `oplog.append`
        // disarms before propagating; only an actual unwind trips the fault.
        {
            let mut guard = FaultGuard {
                state: &mut self.state,
                armed: true,
            };
            match self
                .oplog
                .append(Op::BatchCommit { ops })
                .map_err(oplog_append_err)
            {
                Ok(()) => {
                    guard.armed = false;
                }
                Err(e) => {
                    guard.armed = false;
                    return Err(e);
                }
            }
        }
        // Replay the op-log → fresh workbook with the structural edit + the
        // rewritten formula TEXT applied, rebuild the calcgraph, recompute
        // computed values, and bump the epoch. A structural edit moves many
        // cells the delta DTO cannot express, so the epoch bump → full
        // re-snapshot is the correct delta behavior (like `restore_sheet`).
        self.rematerialize()?;
        // TE1 (D-RANGEMOVE): a structural edit moves/splits absolute cell coords;
        // anchored bindings on this sheet that intersect or precede the edit are
        // invalidated loudly (`alive=false`) rather than silently shifted —
        // range-following is a v1.5 cut.
        //
        // LOAD-BEARING (do NOT remove as "redundant" with the rematerialize pass):
        // this birth-AGNOSTIC call is the backstop for a forward edit that is
        // VALUE-equal to a binding's birth edit (e.g. `insert_rows(2,1)` → bind →
        // undo → `insert_rows(2,1)` again). The birth-relative `rematerialize` pass
        // compares the active set to each binding's birth set by VALUE, so it MASKS
        // such a forward edit (it looks "already in birth"); this call kills the
        // binding correctly — a genuinely NEW forward shift must invalidate, unlike a
        // REDO that restores the birth grid (which the pass correctly spares).
        self.invalidate_bindings_for_structural_edit(sheet, axis, kind);
        Ok(())
    }

    /// **TE1 (var↔cell moat — D-IDENTITY):** the shared upsert that BOTH
    /// `bind_range` (declaration half) and `publish_dataset` (data half) write
    /// through, so the unified binding identity lives in exactly one place.
    ///
    /// - `direction = Some(d)` sets the direction; `None` preserves the existing
    ///   one (or `Forward` for a fresh binding) — so re-declaring never downgrades
    ///   a `Bidirectional` binding.
    /// - `source_id` carries the provenance key: `Some(name)` from a publish; a
    ///   bare `bind_range` passes its preserved-or-`None` source.
    /// - `generation` bumps only when the target moves/resizes (a stable target
    ///   reuses the prior generation; a moved one bumps — carried into the TE2
    ///   reverse plane to reject stale-envelope edits).
    /// - A successful (re)bind is LIVE (`alive = true`). `force_check` is set by
    ///   the CALLER: `publish_dataset` passes `false` (fresh data clears any prior
    ///   undo-staleness, DEC-B); a `bind_range` re-declaration of a source-backed
    ///   binding PRESERVES the prior `force_check` (a declaration carries no data,
    ///   so it cannot clear staleness — only a re-publish can).
    fn upsert_binding(
        &mut self,
        binding_id: &str,
        target: CellRange,
        direction: Option<BindDirection>,
        source_id: Option<String>,
        force_check: bool,
    ) {
        let prev = self.bindings.get(binding_id);
        let generation = match prev {
            Some(p) if p.target == target => p.generation,
            // saturating_add: a u64 generation cannot realistically overflow, but
            // never wrap silently to 0 (No-Fallbacks) — a saturated generation
            // stays maximal, which still reads as "moved" to a staleness check.
            Some(p) => p.generation.saturating_add(1),
            None => 0,
        };
        let direction = direction
            .or_else(|| prev.map(|p| p.direction))
            .unwrap_or(BindDirection::Forward);
        self.bindings.insert(
            binding_id.to_string(),
            BindingInfo {
                binding_id: binding_id.to_string(),
                target,
                direction,
                source_id,
                generation,
                alive: true,
                force_check,
            },
        );
        // TE1 HIGH-1: stamp the binding's BIRTH net-active structural set (the grid it
        // is declared/re-anchored under) so `rematerialize` invalidates it only for
        // edits that became active SINCE its birth — not for a redo that restores it.
        // `active_structural` is the live set (stable between rematerializes), so no
        // log walk is needed here even on the hot publish path.
        self.binding_birth_structural
            .insert(binding_id.to_string(), self.active_structural.clone());
    }

    /// **ENG-FUSION + TE1:** the [`BindingInfo`] a `binding_id` is bound to, if any
    /// — the read accessor for the unified binding registry (used by tests, the
    /// FE/kernel badge, and reverse-plane lookup). Returns `None` for a never-bound
    /// id; a structurally-invalidated binding is returned with `alive = false`
    /// (No-Fallbacks: a dead binding is never reported as a live one, nor elided to
    /// `None`).
    pub fn binding(&self, binding_id: &str) -> Option<BindingInfo> {
        self.bindings.get(binding_id).cloned()
    }

    /// **TE1:** enumerate every binding — the engine-authoritative source the
    /// IDE's `PublishedCellsStore` mirrors (it replaces the host-side shadow
    /// registry as the badge source-of-truth). Includes dead (`alive=false`)
    /// bindings so the caller can surface invalidations, never silently elide
    /// them. Iteration order is unspecified (HashMap); callers needing a stable
    /// order sort by `binding_id`.
    pub fn bindings(&self) -> Vec<BindingInfo> {
        self.bindings.values().cloned().collect()
    }

    /// **TE1:** drop a binding (the engine half of the kernel's `unpublish`
    /// reverse frame / explicit teardown). Returns `true` if a binding existed and
    /// was removed, `false` if the id was unknown — the caller learns whether
    /// anything was actually dropped (No-Fallbacks: never a silent no-op
    /// masquerading as success). Does NOT touch provenance or the already-written
    /// cell values: unpublishing the binding leaves those as ordinary user data
    /// (symmetric with `drop_cell_lineage`); clearing the cells is a separate
    /// caller choice.
    pub fn unbind(&mut self, binding_id: &str) -> EngineResult<bool> {
        // Drop the parallel birth stamp (TE1 HIGH-1) in lockstep with the binding.
        self.binding_birth_structural.remove(binding_id);
        Ok(self.bindings.remove(binding_id).is_some())
    }

    /// **TE1:** the validation + upsert core shared by the trait `bind_range`
    /// (declaration with `direction = None` → preserve existing / `Forward`) and
    /// the `qb.show(editable=True)` path (`Some(Bidirectional)`). `target` is
    /// validated like `write_range` (live sheet, not inverted, in-bounds — loud
    /// `bad_argument`/`sheet_not_found`, never a silent default). As the
    /// DECLARATION half it preserves any existing `source_id` (a bare declaration
    /// carries no data); a later `publish_dataset` links the source. Session-local,
    /// KEPT across undo/redo (a region pointer). Returns `BoundRange { binding_id }`.
    pub fn bind_range_with_direction(
        &mut self,
        binding_id: &str,
        target: CellRange,
        direction: Option<BindDirection>,
    ) -> EngineResult<BoundRange> {
        self.ensure_ready()?;
        self.require_live_sheet(target.sheet, "bind_range")?;
        if target.end_row < target.start_row || target.end_col < target.start_col {
            return Err(EngineError::bad_argument(
                "bind_range: target range end coordinate is before its start",
            ));
        }
        Self::require_in_bounds(target.start_row, target.start_col, "bind_range")?;
        Self::require_in_bounds(target.end_row, target.end_col, "bind_range")?;
        // bind_range is the DECLARATION half: it carries NO data. If it
        // re-declares a SOURCE-BACKED binding (a prior publish linked a provenance
        // source), it must not silently break that link:
        //   - `force_check` is PRESERVED — only `publish_dataset`, which actually
        //     re-records provenance, may clear undo-staleness (DEC-B). A bare
        //     declaration cannot heal a stale binding.
        //   - the new envelope MUST still cover every cell the source actually
        //     produced, else the binding would point its envelope away from its
        //     data (lineage-invariant break). If that provenance is gone (an undo
        //     wiped it) there is nothing to cover, so a same-id re-declaration is
        //     allowed and keeps the (now stale) source link + force_check.
        // A bare declaration (no prior source) — or a re-declaration of a DEAD
        // binding (already invalidated by a structural edit / sheet-delete, whose
        // old anchor + provenance are stale) — is a FRESH, non-stale binding.
        // Only a LIVE source-backed binding triggers the cover check + preserve.
        let (source_id, force_check) = match self
            .bindings
            .get(binding_id)
            .filter(|b| b.alive)
            .and_then(|b| b.source_id.clone().map(|s| (s, b.force_check)))
        {
            Some((src, prev_force_check)) => {
                if let Some(entry) = self.provenance.get(&src) {
                    for cell in &entry.cells {
                        let covered = cell.sheet == target.sheet
                            && cell.row >= target.start_row
                            && cell.row <= target.end_row
                            && cell.col >= target.start_col
                            && cell.col <= target.end_col;
                        if !covered {
                            return Err(EngineError::bad_argument(
                                "bind_range: target must still cover this binding's published \
                                 cells; re-publish to move a bound dataset's envelope",
                            ));
                        }
                    }
                }
                (Some(src), prev_force_check)
            }
            None => (None, false),
        };
        self.upsert_binding(binding_id, target, direction, source_id, force_check);
        Ok(BoundRange {
            binding_id: binding_id.to_string(),
        })
    }

    /// **TE1 (D-RANGEMOVE):** mark every live binding on `sheet` whose target
    /// intersects or precedes a structural edit as `alive = false` — anchored +
    /// loud invalidation, never a silent shift (the absolute target no longer
    /// matches what the user sees, and a silently-shifted envelope could overlap
    /// another binding). The kernel's `force_check` + re-run re-establishes a
    /// fresh binding at the new selection. A binding is safe ONLY if it lies
    /// entirely before the edit position along the edited axis (`end < edit_start`).
    fn invalidate_bindings_for_structural_edit(
        &mut self,
        sheet: SheetId,
        axis: StructuralAxis,
        kind: StructuralKind,
    ) {
        let record = StructuralEditRecord { sheet, axis, kind };
        for binding in self.bindings.values_mut() {
            if !binding.alive {
                continue;
            }
            if structural_edit_affects(&record, &binding.target) {
                binding.alive = false;
                // A dead binding cannot be healed by a re-publish to its now-stale
                // target — it needs a fresh re-bind at the new selection — so clear
                // `force_check` (which means "a re-publish will heal me"). This
                // avoids the contradictory {alive=false, force_check=true} state a
                // prior `rematerialize` in the same structural edit would otherwise
                // leave.
                binding.force_check = false;
            }
        }
    }

    /// **TE1 (D-RANGEMOVE / sheet delete):** mark every binding whose target lives
    /// on the deleted `sheet` as `alive = false`. A read returns the dead binding,
    /// never a stale-live one (No-Fallbacks).
    fn invalidate_bindings_for_sheet(&mut self, sheet: SheetId) {
        for binding in self.bindings.values_mut() {
            if binding.target.sheet == sheet {
                binding.alive = false;
                // Dead binding needs a re-bind, not a re-publish — clear
                // force_check (see invalidate_bindings_for_structural_edit).
                binding.force_check = false;
            }
        }
    }

    /// **TE1 HIGH-1 (w135):** walk the CURRENT (net-active) op-log and collect every
    /// ROW/COLUMN structural edit it materializes, in op-log order (sheet-delete is
    /// handled by the sheet-liveness check, not here). Recurses into `Op::BatchCommit`
    /// because a structural edit is stored as `[InsertRows, PutFormula×N]` inside ONE
    /// `BatchCommit`. `OpLog::iter` reads the materialized LoroList, whose current
    /// state reflects undo/redo (an undone op is absent, a redone op present, since
    /// Loro's UndoManager retracts/replays list entries) — the same iterator
    /// `replay_into` consumes — so this is the authoritative net-active structural
    /// set. A malformed op surfaces loudly
    /// (No-Fallbacks); in practice `rematerialize` calls this only AFTER a
    /// successful `replay_into` of the same log, so a decode error here is
    /// effectively unreachable.
    fn collect_active_structural_edits(&self) -> EngineResult<Vec<StructuralEditRecord>> {
        fn push_from_op(op: &Op, out: &mut Vec<StructuralEditRecord>) {
            match op {
                Op::InsertRows { sheet, at, count } => out.push(StructuralEditRecord {
                    sheet: *sheet,
                    axis: StructuralAxis::Row,
                    kind: StructuralKind::Insert {
                        at: *at,
                        count: *count,
                    },
                }),
                Op::DeleteRows { sheet, start, end } => out.push(StructuralEditRecord {
                    sheet: *sheet,
                    axis: StructuralAxis::Row,
                    kind: StructuralKind::Delete {
                        start: *start,
                        end: *end,
                    },
                }),
                Op::InsertColumns { sheet, at, count } => out.push(StructuralEditRecord {
                    sheet: *sheet,
                    axis: StructuralAxis::Col,
                    kind: StructuralKind::Insert {
                        at: *at,
                        count: *count,
                    },
                }),
                Op::DeleteColumns { sheet, start, end } => out.push(StructuralEditRecord {
                    sheet: *sheet,
                    axis: StructuralAxis::Col,
                    kind: StructuralKind::Delete {
                        start: *start,
                        end: *end,
                    },
                }),
                Op::BatchCommit { ops } => {
                    for inner in ops {
                        push_from_op(inner, out);
                    }
                }
                _ => {}
            }
        }
        let mut out = Vec::new();
        for op_result in self.oplog.iter() {
            let op = op_result
                .map_err(|e| map_oplog_err(e, "oplog iter (structural scan)".to_string()))?;
            push_from_op(&op, &mut out);
        }
        Ok(out)
    }

    /// **ENG-FUSION (extracted from `materialize_query`, 6.5-2 logic):** record the
    /// dual-index provenance for a freshly produced block under `source_id`, and evict
    /// the per-cell entries this source produced before but no longer produces (target
    /// shrank / fewer columns), guarded by ownership (last-writer-wins) so a cell another
    /// source now owns is never clobbered. `produced` is the row-major list of cells
    /// written (empty for a zero-row producer); `data` is the producer payload stored so
    /// `refresh_source` / re-publish can re-run. Emits `Event::Provenance` per produced
    /// cell. Does NOT touch the dependency graph — callers fan out `on_set_value`
    /// themselves for reactive shrink (publish_dataset / refresh_source).
    fn record_block_provenance(
        &mut self,
        source_id: &str,
        target: CellRange,
        produced: Vec<CellAddr>,
        data: serde_json::Value,
        kind: ProducerKind,
    ) {
        for &cell_addr in &produced {
            // **R23 invariant:** a source materializes into ONE sheet, so every
            // produced cell shares `target.sheet`. `cell_lineage` relies on this to
            // anchor the produced-block bounding box to `addr.sheet`. Enforce it in
            // debug/test builds (free in release) so a future cross-sheet producer
            // trips here rather than silently mis-reporting a block.
            debug_assert_eq!(
                cell_addr.sheet, target.sheet,
                "record_block_provenance: produced cell on a different sheet than the target"
            );
            self.events.push(Event::Provenance {
                addr: cell_addr,
                source: source_id.to_string(),
            });
            // Per-cell typed provenance (cell -> {source_id, revision}); revision=0
            // baseline (refresh_source advances it). Last-writer-wins overwrite.
            self.cell_provenance.insert(
                cell_addr,
                CellProvenance {
                    source_id: source_id.to_string(),
                    revision: 0,
                },
            );
        }
        // Evict cells this source produced before but not now. Read old cells from the
        // still-PRIOR provenance entry (the new entry is inserted last); guard removal so
        // we don't evict a cell another source has since claimed via last-writer-wins.
        let new_set: HashSet<CellAddr> = produced.iter().copied().collect();
        let old_cells: Vec<CellAddr> = self
            .provenance
            .get(source_id)
            .map(|e| e.cells.clone())
            .unwrap_or_default();
        for old_cell in old_cells {
            if !new_set.contains(&old_cell)
                && self
                    .cell_provenance
                    .get(&old_cell)
                    .map(|cp| cp.source_id.as_str())
                    == Some(source_id)
            {
                self.cell_provenance.remove(&old_cell);
            }
        }
        self.provenance.insert(
            source_id.to_string(),
            ProvenanceEntry {
                kind,
                revision: 0,
                data,
                target,
                cells: produced,
            },
        );
    }

    /// **R23 lineage:** a direct write over a cell drops its forward lineage entry
    /// — the cell now holds user content, not a tracked source's output, so
    /// `cell_lineage` must no longer attribute it to the source. The reverse index
    /// (`provenance[source].cells`) is intentionally LEFT intact so
    /// `refresh_source`'s dirty fan-out still covers the cell. Provenance recorders
    /// (materialize/publish/refresh) write through `write_range`/`batch` and then
    /// RE-establish the forward entry via `record_block_provenance`, so calling
    /// this from the shared write path is transient for them and sticks only for
    /// genuine user VALUE/FORMULA writes (`set_value`/`set_formula` + their `batch`
    /// ops). `clear` (clear_formula) is a no-op on a value cell — which is what a
    /// source-produced cell always is — so it is NOT a drop site.
    fn drop_cell_lineage(&mut self, addr: CellAddr) {
        self.cell_provenance.remove(&addr);
    }

    /// **R23 SQL→cell lineage:** read-only lineage for the cell at `addr`, joining
    /// the dual provenance index — `cell_provenance` (cell → source) and
    /// `provenance` (source → produced cells + producer payload). Returns
    /// `Ok(None)` when the cell was not produced by a tracked source (an ordinary
    /// user-typed/empty cell — a direct write over a previously source-produced
    /// cell drops its forward entry, so this stays truthful). `sql` is `Some` only
    /// for a `Query` (SQL materialize) source — extracted from the stored
    /// `{"sql": "..."}` payload; a `Published` (`qb.publish`) dataset carries a
    /// value matrix, not SQL, so its `sql` is `None`.
    ///
    /// Gates exactly like the sibling reads (`cell`): a non-readable session
    /// (`[invalid_state]`), a deleted sheet (`[sheet_not_found]`), or an
    /// out-of-grid address (`[bad_argument]`) fail LOUD — they never masquerade as
    /// a plain `Ok(None)`. Pure read: borrows `&self`, mutates nothing, emits no
    /// events.
    pub fn cell_lineage(&self, addr: CellAddr) -> EngineResult<Option<CellLineage>> {
        self.ensure_readable()?;
        self.require_live_sheet(addr.sheet, "cell_lineage")?;
        Self::require_in_bounds(addr.row, addr.col, "cell_lineage")?;

        let cp = match self.cell_provenance.get(&addr) {
            Some(cp) => cp,
            None => return Ok(None),
        };
        // Invariant: every `cell_provenance` entry's `source_id` has a matching
        // `provenance` entry — `record_block_provenance` inserts both, undo clears
        // both, `refresh_source` keeps them paired. A missing entry is a
        // structural inconsistency — surface it LOUD as an internal error rather
        // than silently report "no lineage" (No-Fallbacks).
        let entry = self.provenance.get(&cp.source_id).ok_or_else(|| {
            EngineError::new(
                ErrorClass::Internal,
                "lineage_inconsistent",
                format!(
                    "cell_lineage: cell ({}, {}, {}) is owned by source '{}' with no \
                     provenance entry",
                    addr.sheet, addr.row, addr.col, cp.source_id
                ),
            )
        })?;
        let (kind, sql) = match entry.kind {
            ProducerKind::Query => (
                LineageKind::Query,
                entry
                    .data
                    .get("sql")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            ),
            ProducerKind::Published => (LineageKind::Published, None),
        };
        // The produced block = the bounding rectangle of the cells the source
        // ACTUALLY produced (NOT the declared `entry.target`, which can be larger
        // than a short result). `entry.cells` is non-empty here: the queried cell
        // is owned by this source, hence one of its produced cells. All produced
        // cells share `addr.sheet` (a source materializes into one sheet).
        let mut min_row = addr.row;
        let mut max_row = addr.row;
        let mut min_col = addr.col;
        let mut max_col = addr.col;
        for c in &entry.cells {
            min_row = min_row.min(c.row);
            max_row = max_row.max(c.row);
            min_col = min_col.min(c.col);
            max_col = max_col.max(c.col);
        }
        let produced_range = CellRange {
            sheet: addr.sheet,
            start_row: min_row,
            start_col: min_col,
            end_row: max_row,
            end_col: max_col,
        };
        // TE1: cross-link to the unified binding. For a Published source the id IS
        // the binding id (D-IDENTITY); a SQL `Query` source has no Python binding.
        let (binding_id, direction) = match self.bindings.get(&cp.source_id) {
            // Link ONLY when the binding is still backed by THIS source. After an
            // `unbind` + bare `bind_range` re-declaration, the same id can exist
            // with `source_id = None` — that bare binding must NOT relink the old
            // published cells (No-Fallbacks: never report a stale binding link).
            Some(b)
                if kind == LineageKind::Published
                    && b.source_id.as_deref() == Some(cp.source_id.as_str()) =>
            {
                (Some(b.binding_id.clone()), Some(b.direction))
            }
            _ => (None, None),
        };
        Ok(Some(CellLineage {
            source_id: cp.source_id.clone(),
            kind,
            revision: cp.revision,
            sql,
            produced_range,
            produced_cells: entry.cells.len(),
            binding_id,
            direction,
        }))
    }

    /// **R24 (Wave L3) — used range:** the bounding rectangle of `sheet`'s
    /// non-blank *value* cells — its effective data extent, anchored at `A1`.
    /// Returns `Ok(None)` for an empty / all-blank sheet (no value cell
    /// anywhere) so a caller can tell "no data" apart from "a 1×1 used range at
    /// A1" without a sentinel. The extent is the VALUE extent
    /// ([`Sheet::effective_value_bounds`]): a format-only cell, or a formula
    /// whose value is blank, does NOT widen it (that method's contract); an
    /// error value DOES count. This is the range an agent should `query_range`
    /// to read every datum on the sheet.
    ///
    /// Gates exactly like the sibling reads (`cell` / `cell_lineage`): a
    /// non-readable session (`[invalid_state]`) or a missing/tombstoned sheet
    /// (`[sheet_not_found]`) fail LOUD — they never masquerade as a plain
    /// `Ok(None)`. Pure read: borrows `&self`, mutates nothing, emits no events.
    pub fn used_range(&self, sheet: SheetId) -> EngineResult<Option<CellRange>> {
        self.ensure_readable()?;
        self.require_live_sheet(sheet, "used_range")?;
        // `require_live_sheet` proved the id is in range AND not tombstoned, so
        // the lookup cannot miss. A `None` here would be a structural
        // inconsistency — surface it LOUD (No-Fallbacks) rather than fabricate
        // an empty range.
        let sheet_ref = self.workbook.sheet(sheet).ok_or_else(|| {
            EngineError::new(
                ErrorClass::Internal,
                "sheet_lookup_inconsistent",
                format!("used_range: live sheet {sheet} not found in workbook"),
            )
        })?;
        let bounds = sheet_ref.effective_value_bounds();
        // `Bounds::default()` (0 × 0) is the empty/all-blank sheet — no used
        // range. Either extent being zero means no value cell, so report None.
        if bounds.row_extent == 0 || bounds.col_extent == 0 {
            return Ok(None);
        }
        Ok(Some(CellRange {
            sheet,
            start_row: 0,
            start_col: 0,
            // `effective_value_bounds` returns one-past-max extents, both > 0
            // here (guarded above), so the `- 1` cannot underflow.
            end_row: bounds.row_extent - 1,
            end_col: bounds.col_extent - 1,
        }))
    }

    /// **R24 (Wave L3) — list tables:** every structured table in the workbook,
    /// the cheap dedicated read the IDE/MCP surface needs instead of
    /// [`Self::snapshot`] (which materializes every cell — the `list_tables` MCP
    /// tool was held back at Wave L1 precisely for the lack of this getter).
    /// Walks only the workbook-level table table (`collect_tables`), so it is
    /// O(tables), never O(cells) — safe on a 1M-cell sheet. Sorted by
    /// `(sheet, name)` (the `collect_tables` order, matching
    /// `WorkbookSnapshot.tables`).
    ///
    /// Read gate (`ensure_readable`, like `list_functions`): legal in
    /// Ready/Busy, rejected `[invalid_state]` once terminal. Tables on a
    /// tombstoned sheet are RETAINED, consistent with `collect_tables` /
    /// `list_charts` (the IDE filters by live sheet; `restore_sheet` brings them
    /// back).
    pub fn list_tables(&self) -> EngineResult<Vec<TableSnapshot>> {
        self.ensure_readable()?;
        Ok(collect_tables(&self.workbook))
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

/// **FE-5 W-N (2026-06-12):** project a storage `NamedTarget` into the contract
/// [`NamedTargetDto`]. TOTAL — all four variants are faithfully representable
/// (No-Fallbacks: never coerces a `Constant`/`Formula` down to a `Range`). The
/// `Constant` arm uses `value_to_cell_value_dense`, which represents every
/// `ql_types::Value` case (including `Blank`) — so no lossy case exists at this
/// boundary. If a future `NamedTarget` variant is added, this match becomes a
/// compile error here (the storage enum is in another crate, but this is an
/// owned, wildcard-free match), forcing an explicit faithful mapping.
fn named_target_to_dto(target: &ql_storage::NamedTarget) -> NamedTargetDto {
    match target {
        ql_storage::NamedTarget::Cell(addr) => NamedTargetDto::Cell {
            cell: CellAddr::from(*addr),
        },
        ql_storage::NamedTarget::Range(range) => NamedTargetDto::Range {
            range: CellRange::from(*range),
        },
        ql_storage::NamedTarget::Constant(value) => NamedTargetDto::Constant {
            value: value_to_cell_value_dense(value),
        },
        ql_storage::NamedTarget::Formula(source) => NamedTargetDto::Formula {
            source: source.as_ref().to_owned(),
        },
    }
}

/// **FE-5 W-N (2026-06-12):** collect ALL defined names from a workbook — BOTH
/// workbook-scoped (`Workbook::names`) AND every sheet's sheet-scoped names
/// (`Sheet::scoped_names`). Missing either scope would be a silent data loss
/// (the Name-Manager would not show sheet-scoped names), so both are walked.
/// Returns a deterministically sorted `Vec<NamedRange>`: workbook-scoped first
/// (`scope: None` sorts before `Some`), then by sheet id, then by name — a
/// stable wire shape across calls (the underlying `NameTable` is HashMap-backed,
/// so iteration order is otherwise arbitrary).
fn collect_named_ranges(workbook: &Workbook) -> Vec<NamedRange> {
    let mut names: Vec<NamedRange> = Vec::new();
    // Workbook-scoped.
    for (name, target) in workbook.names().iter() {
        names.push(NamedRange {
            name: name.as_ref().to_owned(),
            target: named_target_to_dto(target),
            scope: None,
        });
    }
    // Sheet-scoped — walk EVERY sheet's scoped-name table (including
    // tombstoned sheets: their scoped names remain in storage and the
    // owning-session persistence/round-trip preserves them, so surfacing them
    // keeps the read consistent with what a save would write).
    for sheet_id in 0..workbook.sheet_count() as SheetId {
        if let Some(sheet) = workbook.sheet(sheet_id) {
            for (name, target) in sheet.scoped_names().iter() {
                names.push(NamedRange {
                    name: name.as_ref().to_owned(),
                    target: named_target_to_dto(target),
                    scope: Some(sheet_id),
                });
            }
        }
    }
    // Deterministic order: scope (None < Some) then sheet id then name.
    names.sort_by(|a, b| a.scope.cmp(&b.scope).then_with(|| a.name.cmp(&b.name)));
    names
}

/// **FE-5 W-? (Builder E, 2026-06-13):** enumerate EVERY structured table in the
/// workbook (across ALL sheets) into a sorted `Vec<TableSnapshot>` for the
/// `WorkbookSnapshot.tables` read surface. The table table is workbook-level and
/// name-keyed (NOT per-sheet) — `tables().iter()` yields every table once; each
/// `TableMetadata` carries its own anchor `sheet`. Mapping is TOTAL over the
/// fields the IDE renders (No-Fallbacks: every field is mapped explicitly, never
/// defaulted). `name`/`display_name` are `Arc<str>` in storage → owned `String`
/// here. Sorted by `(sheet, name)` for a stable wire shape (the underlying
/// `TableTable` is HashMap-backed / arbitrary-order, mirroring why
/// `collect_named_ranges` and the `formats`/`styles` arrays sort).
fn collect_tables(workbook: &Workbook) -> Vec<TableSnapshot> {
    let mut tables: Vec<TableSnapshot> = workbook
        .tables()
        .iter()
        .map(|(_canonical, meta)| TableSnapshot {
            name: meta.name.as_ref().to_owned(),
            display_name: meta.display_name.as_ref().to_owned(),
            sheet: meta.sheet,
            top_row: meta.top_row,
            top_col: meta.top_col,
            rows: meta.rows,
            cols: meta.cols,
            has_header: meta.has_header,
            has_totals: meta.has_totals,
        })
        .collect();
    tables.sort_by(|a, b| a.sheet.cmp(&b.sheet).then_with(|| a.name.cmp(&b.name)));
    tables
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

// ===== FE-4 W4 (2026-06-10): Style DTO ↔ storage conversions =====

fn storage_style_id_to_dto(id: ql_storage::StyleId) -> StyleIdDto {
    StyleIdDto {
        peer: id.peer.as_u64(),
        counter: id.counter,
    }
}

fn dto_style_id_to_storage(id: StyleIdDto) -> ql_storage::StyleId {
    ql_storage::StyleId::new(ql_types::PeerId::new(id.peer), id.counter)
}

fn storage_rgb_to_dto(c: ql_storage::Rgb) -> RgbDto {
    RgbDto {
        r: c.r,
        g: c.g,
        b: c.b,
    }
}

fn dto_rgb_to_storage(c: RgbDto) -> ql_storage::Rgb {
    ql_storage::Rgb {
        r: c.r,
        g: c.g,
        b: c.b,
    }
}

fn storage_halign_to_dto(a: ql_storage::HAlign) -> HAlignDto {
    match a {
        ql_storage::HAlign::General => HAlignDto::General,
        ql_storage::HAlign::Left => HAlignDto::Left,
        ql_storage::HAlign::Center => HAlignDto::Center,
        ql_storage::HAlign::Right => HAlignDto::Right,
    }
}

fn dto_halign_to_storage(a: HAlignDto) -> ql_storage::HAlign {
    match a {
        HAlignDto::General => ql_storage::HAlign::General,
        HAlignDto::Left => ql_storage::HAlign::Left,
        HAlignDto::Center => ql_storage::HAlign::Center,
        HAlignDto::Right => ql_storage::HAlign::Right,
    }
}

fn storage_border_style_to_dto(s: ql_storage::BorderStyle) -> BorderStyleDto {
    match s {
        ql_storage::BorderStyle::None => BorderStyleDto::None,
        ql_storage::BorderStyle::Thin => BorderStyleDto::Thin,
        ql_storage::BorderStyle::Medium => BorderStyleDto::Medium,
        ql_storage::BorderStyle::Thick => BorderStyleDto::Thick,
        ql_storage::BorderStyle::Dashed => BorderStyleDto::Dashed,
        ql_storage::BorderStyle::Dotted => BorderStyleDto::Dotted,
        ql_storage::BorderStyle::Double => BorderStyleDto::Double,
    }
}

fn dto_border_style_to_storage(s: BorderStyleDto) -> ql_storage::BorderStyle {
    match s {
        BorderStyleDto::None => ql_storage::BorderStyle::None,
        BorderStyleDto::Thin => ql_storage::BorderStyle::Thin,
        BorderStyleDto::Medium => ql_storage::BorderStyle::Medium,
        BorderStyleDto::Thick => ql_storage::BorderStyle::Thick,
        BorderStyleDto::Dashed => ql_storage::BorderStyle::Dashed,
        BorderStyleDto::Dotted => ql_storage::BorderStyle::Dotted,
        BorderStyleDto::Double => ql_storage::BorderStyle::Double,
    }
}

fn storage_border_edge_to_dto(e: ql_storage::BorderEdge) -> BorderEdgeDto {
    BorderEdgeDto {
        style: storage_border_style_to_dto(e.style),
        color: storage_rgb_to_dto(e.color),
    }
}

fn dto_border_edge_to_storage(e: BorderEdgeDto) -> ql_storage::BorderEdge {
    let style = dto_border_style_to_storage(e.style);
    // **FE-9 (2026-06-14):** a `None`-style edge draws nothing, so its color is
    // inert. Canonicalize it to `BorderEdge::NONE` (== the default edge) so (a) two
    // "no border" edges with different leftover colors intern as ONE style (dedup),
    // and (b) a borders-off style resolves to `Style::default()` → `is_empty()` →
    // an empty-style bind collapses to a clear instead of leaving a phantom.
    if matches!(style, ql_storage::BorderStyle::None) {
        return ql_storage::BorderEdge::NONE;
    }
    ql_storage::BorderEdge {
        style,
        color: dto_rgb_to_storage(e.color),
    }
}

fn storage_style_to_dto(s: ql_storage::Style) -> StyleDto {
    StyleDto {
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
        strike: s.strike,
        fill: s.fill.map(storage_rgb_to_dto),
        text_color: s.text_color.map(storage_rgb_to_dto),
        align: storage_halign_to_dto(s.align),
        borders: BordersDto {
            top: storage_border_edge_to_dto(s.borders.top),
            bottom: storage_border_edge_to_dto(s.borders.bottom),
            left: storage_border_edge_to_dto(s.borders.left),
            right: storage_border_edge_to_dto(s.borders.right),
        },
    }
}

fn dto_style_to_storage(s: StyleDto) -> ql_storage::Style {
    ql_storage::Style {
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
        strike: s.strike,
        fill: s.fill.map(dto_rgb_to_storage),
        text_color: s.text_color.map(dto_rgb_to_storage),
        align: dto_halign_to_storage(s.align),
        borders: ql_storage::Borders {
            top: dto_border_edge_to_storage(s.borders.top),
            bottom: dto_border_edge_to_storage(s.borders.bottom),
            left: dto_border_edge_to_storage(s.borders.left),
            right: dto_border_edge_to_storage(s.borders.right),
        },
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
        // FE-10.x: a name no formula could reference (cell-ref shape like `A1`/`Q1`,
        // a number, a boolean, or whitespace-carrying) → BadArgument.
        R::NameNotReferenceable { .. } => {
            EngineError::new(ErrorClass::BadArgument, "name_not_referenceable", display)
        }
        // FE-5 W-N: deleting a name that doesn't exist → NotFound (fail loud,
        // never the silent clear no-op).
        R::NameNotFound { .. } => EngineError::new(ErrorClass::NotFound, "name_not_found", display),
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
        // R9 / Wave B: a nudge produced/encountered an unparseable format code.
        R::InvalidFormat(_) => EngineError::new(ErrorClass::BadArgument, "invalid_format", display),
        // FE-4 W4: style-overlay errors mirror the format-overlay ones.
        R::UnknownStyleId(_) => {
            EngineError::new(ErrorClass::BadArgument, "unknown_style_id", display)
        }
        R::StyleCounterExhausted { .. } => {
            EngineError::new(ErrorClass::Internal, "style_counter_exhausted", display)
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
        }
        // **Wave Q1 (2026-06-23):** chart id not found → NotFound (mirrors
        // TableNotFound — fail loud on an update/remove of a missing chart,
        // never the silent store no-op).
        R::ChartNotFound(_) => EngineError::new(ErrorClass::NotFound, "chart_not_found", display),
        // NOTE: no wildcard arm. `RuntimeError` is `#[non_exhaustive]`, but
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

/// **W3 (insert/delete rows & columns):** map a [`StructuralError`] from the
/// shared `structural::build_structural_batch` producer to an `EngineError`.
///
/// Every variant is a caller-input rejection (a missing sheet, a tombstoned
/// sheet, or a positional preflight failure — count==0, off-grid, table-split,
/// inverted range) surfaced loudly BEFORE any op is appended, so all map to
/// `BadArgument` (No-Fallbacks: a producer rejection always surfaces, never a
/// silent no-op). The `code` distinguishes the class for IDE diagnostics; the
/// `message` carries the precise detail from the producer.
fn map_structural_err(e: StructuralError) -> EngineError {
    let code = match e {
        StructuralError::SheetMissing { .. } => "sheet_not_found",
        StructuralError::SheetTombstoned { .. } => "sheet_tombstoned",
        StructuralError::Preflight { .. } => "structural_edit_rejected",
    };
    EngineError::new(ErrorClass::BadArgument, code, e.message().to_string())
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
        // TB6: a too-deeply-nested batch is a caller-input rejection (sibling of
        // `O::Serialize`), surfaced loudly before any mutation — not an engine
        // bug. Give it a stable BadArgument code rather than "unmapped_*".
        O::BatchDepthExceeded { .. } => {
            EngineError::new(ErrorClass::BadArgument, "oplog_batch_depth", display)
        }
        // `#[non_exhaustive]`: unmapped → loud Internal.
        _ => EngineError::new(ErrorClass::Internal, "unmapped_oplog_error", display),
    }
}

/// Map a `ql_io::PersistenceError` (from `open`/`save` — inc.2c-9) to the
/// contract `EngineError` (Appendix A). All persistence failures are
/// `ErrorClass::Persistence`; the codes are the contract-locked
/// `qbook_error`/`session_oplog`/`qbook_unsupported_version`/`qbook_truncated_header`.
///
/// `PersistenceError` is a FOREIGN `#[non_exhaustive]` enum (it lives in
/// `ql-io`), so this match REQUIRES a wildcard arm. A future variant must be
/// mapped explicitly (Appendix A: "no `qbook_unknown` to callers"); until then
/// it surfaces a loud `Internal`/`unmapped_persistence_error` — never a silent
/// swallow or a generic catch-all code (No-Fallbacks).
fn map_persistence_err(e: ql_io::PersistenceError) -> EngineError {
    use ql_io::PersistenceError as P;
    let display = e.to_string();
    match e {
        P::Qbook(_) => EngineError::new(ErrorClass::Persistence, "qbook_error", display),
        P::OpLog(_) => EngineError::new(ErrorClass::Persistence, "session_oplog", display),
        P::OplogUnsupportedVersion { .. } => EngineError::new(
            ErrorClass::Persistence,
            "qbook_unsupported_version",
            display,
        ),
        P::OplogTruncatedHeader { .. } => {
            EngineError::new(ErrorClass::Persistence, "qbook_truncated_header", display)
        }
        _ => EngineError::new(ErrorClass::Internal, "unmapped_persistence_error", display),
    }
}

/// Map a `ql_io_xlsx::XlsxError` (from `import("xlsx")` — inc.2c-10) to the
/// contract `EngineError` (Appendix A). Format/parse failures are
/// `ErrorClass::Persistence` (an import is a load operation); engine-integration
/// + export failures are `Internal` (engine bugs, not caller input).
///
/// `XlsxError` is a FOREIGN `#[non_exhaustive]` enum (it lives in `ql-io-xlsx`),
/// so this match REQUIRES a wildcard arm — a future variant surfaces a loud
/// `Internal`/`unmapped_xlsx_error`, never a silent or generic caller-visible
/// code (No-Fallbacks).
fn map_xlsx_err(e: ql_io_xlsx::XlsxError) -> EngineError {
    use ql_io_xlsx::XlsxError as X;
    let display = e.to_string();
    match e {
        X::Io(_) => EngineError::new(ErrorClass::Persistence, "xlsx_io", display),
        X::Zip(_) => EngineError::new(ErrorClass::Persistence, "xlsx_zip", display),
        X::Calamine(_) => EngineError::new(ErrorClass::Persistence, "xlsx_calamine", display),
        X::XmlParse { .. } => EngineError::new(ErrorClass::Persistence, "xlsx_xml_parse", display),
        X::MalformedOoxml { .. } => {
            EngineError::new(ErrorClass::Persistence, "xlsx_malformed_ooxml", display)
        }
        X::UnsupportedFeature { .. } => {
            EngineError::new(ErrorClass::Persistence, "xlsx_unsupported_feature", display)
        }
        X::Export(_) => EngineError::new(ErrorClass::Internal, "xlsx_export", display),
        X::Engine(_) => EngineError::new(ErrorClass::Internal, "xlsx_engine", display),
        _ => EngineError::new(ErrorClass::Internal, "unmapped_xlsx_error", display),
    }
}

/// Map a `ql_io_csv::CsvError` (from `import("csv")` / `export("csv")` —
/// inc.2c-11) to the contract `EngineError` (Appendix A). Parse/I/O failures are
/// `Persistence` (a load/serialise operation); an over-large CSV is a
/// `BadArgument` (the caller's input exceeds engine capacity); a missing export
/// sheet is an `Internal` invariant break (the session selects the sheet).
///
/// `CsvError` is a FOREIGN `#[non_exhaustive]` enum (it lives in `ql-io-csv`), so
/// this match REQUIRES a wildcard arm — a future variant surfaces a loud
/// `Internal`/`unmapped_csv_error`, never a silent or generic caller-visible
/// code (No-Fallbacks).
fn map_csv_err(e: ql_io_csv::CsvError) -> EngineError {
    use ql_io_csv::CsvError as C;
    let display = e.to_string();
    match e {
        C::Io(_) => EngineError::new(ErrorClass::Persistence, "csv_io", display),
        C::Parse(_) => EngineError::new(ErrorClass::Persistence, "csv_parse", display),
        C::ExceedsSheetLimits { .. } => {
            EngineError::new(ErrorClass::BadArgument, "csv_exceeds_limits", display)
        }
        C::SheetNotFound(_) => {
            EngineError::new(ErrorClass::Internal, "csv_sheet_not_found", display)
        }
        _ => EngineError::new(ErrorClass::Internal, "unmapped_csv_error", display),
    }
}

/// **6.4-2 cycle-2 audit-fix (H1 — Codex F1 + Opus H1/H2):** enforce the
/// registry's canonical-name contract at the trait boundary, returning a
/// structured `bad_argument` rather than letting
/// [`ql_functions::FunctionRegistry::register_metadata`]'s internal `assert!`s
/// (`registry.rs:357,:361`) panic across the (catch_unwind-free) napi boundary
/// and seal the session via the armed `FaultGuard`. The contract is: a non-empty
/// ASCII-upper-case canonical name (the IDE / any caller is expected to
/// upper-case before calling — the registry stores and `list_functions` returns
/// the name verbatim, so we VALIDATE rather than silently normalize, per
/// No-Fallbacks). This makes the two registry asserts genuine unreachable
/// invariants for the trait path.
///
/// **6.4B hardening (2026-05-29; closes the 6.4-4 megaudit FF-1 / Codex-2 MED):**
/// also reject a canonical name the formula language cannot CALL. Previously the
/// gate accepted any non-empty all-upper string, so `register_function("MY UDF")`
/// / `"MY-UDF"` / `"É"` succeeded and `list_functions` advertised a name no
/// formula could reference (an inert registration — `=MY UDF(..)` fails loud at
/// parse, never silently). We validate against the REAL lexer+parser (the single
/// source of truth) rather than a hand-rolled identifier grammar: a hand grammar
/// would drift from the parser and wrongly reject valid forms — dotted Excel
/// canon (`T.DIST.2T`, via the lexer's digit-leading segments) and names that lex
/// as a `CellRef` but the parser disambiguates as a function when followed by `(`
/// (`LOG10`, `ATAN2`; see `token.rs`). The probe `NAME(1)` must lex+parse to a
/// single `Expr::Function` whose name matches; anything else (whitespace,
/// punctuation, non-ASCII, trailing garbage) fails to parse as one and is
/// rejected. (The lower-level registry `register_metadata` keeps its own
/// upper-case asserts; this trait-boundary gate is where host/napi registrations
/// enter, so it is the right place to enforce callability without adding a
/// formula-syntax dependency to the `ql-functions` registry crate.)
fn validate_canonical_function_name(name: &str) -> EngineResult<()> {
    if name.is_empty() {
        return Err(EngineError::bad_argument(
            "register_function: canonical_name must not be empty".to_string(),
        ));
    }
    if name.bytes().any(|b| b.is_ascii_lowercase()) {
        return Err(EngineError::bad_argument(format!(
            "register_function: canonical_name {name:?} must be canonical upper-case \
             (caller must normalize before calling)"
        )));
    }
    // Callability gate: `NAME(1)` must parse to exactly a function call named
    // `NAME`. Uses the engine's own lexer+parser so the accepted set is exactly
    // what `=NAME(..)` can bind — no separate grammar to keep in sync.
    let probe = format!("{name}(1)");
    let is_callable = lex(&probe)
        .ok()
        .and_then(|tokens| parse(tokens).ok())
        .is_some_and(|expr| {
            matches!(&expr, ql_formula_syntax::Expr::Function { name: parsed, .. }
                if parsed.eq_ignore_ascii_case(name))
        });
    if !is_callable {
        return Err(EngineError::bad_argument(format!(
            "register_function: canonical_name {name:?} is not a callable formula \
             function name (must be usable as the head of `=NAME(..)`)"
        )));
    }
    Ok(())
}

/// **6.4-1 (2026-05-28; M5):** map `FunctionRegistryError` to the
/// binding-neutral `EngineError` taxonomy. Used by the (forthcoming, 6.4)
/// `WorkbookSession::register_function` / `unregister_function` /
/// `list_functions` trait methods to translate the registry-level error
/// into the contract §10.3 caller-visible codes
/// (`function_exists` / `function_not_found`). Mirrors the
/// `map_runtime_err` / `map_persistence_err` / `map_xlsx_err` / `map_csv_err`
/// pattern — one mapper per Appendix-A row family, exhaustive match, never
/// a silent default.
///
/// Both registry-level variants land in this mapper:
/// - `Conflict { name }` → `Conflict` / `function_exists`. The substrate's
///   `unregister_metadata` builtin-guard (6.4-0 audit-fix) ALSO returns
///   `Conflict` (with a different message) to signal that a built-in's
///   metadata can'\''t be removed — both surface here as the same caller-
///   visible code; the message disambiguates.
/// - `NotFound { name }` → `NotFound` / `function_not_found`. Matches the
///   contract §10.3 wording exactly.
///
/// No `_ => unmapped_*_error` arm because `FunctionRegistryError` is a
/// closed enum we own — adding a new variant without a mapping should
/// surface as a compile error at this match, not a silent runtime
/// catch-all.
// **6.4-2 (2026-05-28):** the `#[allow(dead_code)]` from 6.4-1 is REMOVED —
// `WorkbookSession::register_function` and `unregister_function` now wire
// this mapper into the engine→napi error surface (Appendix A
// `function_exists` / `function_not_found`).
fn map_function_registry_err(e: ql_functions::FunctionRegistryError) -> EngineError {
    use ql_functions::FunctionRegistryError as F;
    let display = e.to_string();
    match e {
        F::Conflict { .. } => EngineError::new(ErrorClass::Conflict, "function_exists", display),
        F::NotFound { .. } => EngineError::new(ErrorClass::NotFound, "function_not_found", display),
    }
}

// ============================================================================
// 6.5-1: SQL materialize support. SQL execution lives in the pure `ql-sql` crate
// (DataFusion, off the hot path); here we (a) build one Arrow RecordBatch per
// workbook table/sheet to register as a queryable table, and (b) convert a result
// RecordBatch back into a row-major cell-value matrix.
// ============================================================================

/// Parse the `materialize_query` `data` payload: a JSON object `{"sql": "<query>"}`.
/// Anything else is a loud `bad_argument` (No-Fallbacks -- never a silent default query).
fn parse_materialize_sql(data: &serde_json::Value) -> EngineResult<String> {
    let sql = data.get("sql").and_then(|v| v.as_str()).ok_or_else(|| {
        EngineError::bad_argument(
            "materialize_query: `data` must be a JSON object with a string `sql` field",
        )
    })?;
    if sql.trim().is_empty() {
        return Err(EngineError::bad_argument(
            "materialize_query: `sql` must be a non-empty query",
        ));
    }
    Ok(sql.to_string())
}

/// **ENG-FUSION:** convert a `publish_dataset` `data` payload — a JSON object
/// `{"values": [[scalar|null, ...], ...]}` — into a row-major `Vec<Vec<CellValue>>`.
/// Per-CELL conversion (heterogeneous, unlike `materialize_query`'s per-column Arrow
/// inference). Loud `bad_argument` (No-Fallbacks) on: missing/non-array `values`, a
/// non-array row, a non-rectangular shape, an empty row (zero columns with rows
/// present), or a non-scalar / non-finite element. An empty `values` array -> zero
/// rows (the caller's zero-row publish path).
fn json_block_to_cell_values(data: &serde_json::Value) -> EngineResult<Vec<Vec<CellValue>>> {
    let rows = data
        .get("values")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            EngineError::bad_argument(
                "publish_dataset: `data` must be a JSON object with a `values` array of rows",
            )
        })?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<Vec<CellValue>> = Vec::with_capacity(rows.len());
    let mut width: Option<usize> = None;
    for (r, row) in rows.iter().enumerate() {
        let cells = row.as_array().ok_or_else(|| {
            EngineError::bad_argument(format!(
                "publish_dataset: `data.values[{r}]` must be an array (a row of scalars)"
            ))
        })?;
        match width {
            None => {
                if cells.is_empty() {
                    return Err(EngineError::bad_argument(
                        "publish_dataset: `data.values` rows must have at least one column",
                    ));
                }
                // Cap the input cell count BEFORE converting the bulk matrix (and before
                // publish_dataset stores `data` in provenance), mirroring the SQL input
                // cap. The write_range cap also bounds the committed block, but this
                // bails after row 0 so a within-parse-but-oversized payload cannot force
                // a full Vec<Vec<CellValue>> allocation + long-lived provenance retention.
                const MAX_PUBLISH_CELLS: u64 = 1 << 20; // ~1M cells
                let total = (rows.len() as u64).saturating_mul(cells.len() as u64);
                if total > MAX_PUBLISH_CELLS {
                    return Err(EngineError::bad_argument(format!(
                        "publish_dataset: data {}x{} exceeds the {MAX_PUBLISH_CELLS}-cell cap",
                        rows.len(),
                        cells.len()
                    )));
                }
                width = Some(cells.len());
            }
            Some(w) if cells.len() != w => {
                return Err(EngineError::bad_argument(format!(
                    "publish_dataset: `data.values` is not rectangular (row {r} has {} \
                     cells, expected {w})",
                    cells.len()
                )));
            }
            _ => {}
        }
        let mut out_row: Vec<CellValue> = Vec::with_capacity(cells.len());
        for (c, cell) in cells.iter().enumerate() {
            out_row.push(json_scalar_to_cell_value(cell, r, c)?);
        }
        out.push(out_row);
    }
    Ok(out)
}

/// **ENG-FUSION:** one JSON scalar -> `CellValue`. null -> Blank, bool -> Boolean,
/// finite number -> Number, string -> Text; a JSON array/object or a non-finite number
/// is a loud `bad_argument`. (JSON cannot represent NaN/Inf, but the finiteness guard
/// is kept defensively so the engine never receives a non-finite f64.)
fn json_scalar_to_cell_value(v: &serde_json::Value, r: usize, c: usize) -> EngineResult<CellValue> {
    use serde_json::Value as J;
    match v {
        J::Null => Ok(CellValue::Blank),
        J::Bool(b) => Ok(CellValue::Boolean { boolean: *b }),
        J::Number(n) => {
            let f = n.as_f64().ok_or_else(|| {
                EngineError::bad_argument(format!(
                    "publish_dataset: `data.values[{r}][{c}]` is not a representable number"
                ))
            })?;
            if !f.is_finite() {
                return Err(EngineError::bad_argument(format!(
                    "publish_dataset: `data.values[{r}][{c}]` must be a finite number"
                )));
            }
            Ok(CellValue::Number { number: f })
        }
        J::String(s) => Ok(CellValue::Text { text: s.clone() }),
        J::Array(_) | J::Object(_) => Err(EngineError::bad_argument(format!(
            "publish_dataset: `data.values[{r}][{c}]` must be a scalar (number, string, \
             bool, or null)"
        ))),
    }
}

/// Excel column letters for a 0-based column index (0 -> "A", 25 -> "Z", 26 -> "AA").
/// Names sheet-as-table columns (a raw sheet has no header row in v1). Bijective
/// base-26 (A=1), matching ql-formula-syntax's printer.
fn column_index_to_letters(mut col: u32) -> String {
    let mut letters = String::new();
    loop {
        let digit = (col % 26) as u8;
        letters.insert(0, (b'A' + digit) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    letters
}

/// Build one Arrow column from cell values, inferring the type: all non-blank Number
/// -> Float64; all non-blank Boolean -> Boolean; otherwise Utf8 (every non-blank cell
/// stringified via `Value`'s `Display` -- numbers, TRUE/FALSE, text, error sigils).
/// Blank cells become Arrow nulls; an all-blank column -> Float64 of nulls. Returns the
/// column `DataType` (for the schema `Field`) + the array.
fn build_inferred_column(values: &[Value]) -> (DataType, ArrayRef) {
    let mut all_number = true;
    let mut all_boolean = true;
    for v in values {
        match v {
            Value::Blank => {}
            Value::Number(_) => all_boolean = false,
            Value::Boolean(_) => all_number = false,
            Value::Text(_) | Value::Error(_) => {
                all_number = false;
                all_boolean = false;
            }
        }
    }
    if all_number {
        let mut b = Float64Builder::with_capacity(values.len());
        for v in values {
            match v {
                Value::Number(n) => b.append_value(*n),
                _ => b.append_null(),
            }
        }
        (DataType::Float64, Arc::new(b.finish()))
    } else if all_boolean {
        let mut b = BooleanBuilder::with_capacity(values.len());
        for v in values {
            match v {
                Value::Boolean(x) => b.append_value(*x),
                _ => b.append_null(),
            }
        }
        (DataType::Boolean, Arc::new(b.finish()))
    } else {
        let mut b = StringBuilder::new();
        for v in values {
            if matches!(v, Value::Blank) {
                b.append_null();
            } else {
                b.append_value(v.to_string());
            }
        }
        (DataType::Utf8, Arc::new(b.finish()))
    }
}

/// Assemble a RecordBatch from named columns (field name + values), inferring each
/// column's Arrow type. The caller guarantees all columns are the same length
/// (a rectangular region); a mismatch surfaces loud as `Internal`/`sql_table_build`.
fn record_batch_from_columns(columns: Vec<(String, Vec<Value>)>) -> EngineResult<RecordBatch> {
    let mut fields = Vec::with_capacity(columns.len());
    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(columns.len());
    for (name, values) in columns {
        let (dt, arr) = build_inferred_column(&values);
        fields.push(Field::new(name, dt, true));
        arrays.push(arr);
    }
    let schema = Arc::new(Schema::new(fields));
    RecordBatch::try_new(schema, arrays).map_err(|e| {
        EngineError::new(
            ErrorClass::Internal,
            "sql_table_build",
            format!("failed to build an in-memory SQL table: {e}"),
        )
    })
}

/// Per-source cell cap for SQL inputs. A sheet's `effective_value_bounds` can span up to
/// the whole grid from a single far cell, and a table by its footprint; both would
/// otherwise build every (mostly-blank) cell into Arrow. A source over this cap is a loud
/// `bad_argument` (No-Fallbacks; sparse/range pushdown is a later increment).
const MAX_SQL_INPUT_CELLS: u64 = 1 << 20; // ~1M cells

/// Build the queryable tables for a SQL query over the workbook: every defined table
/// (by display name, with its named columns, data rows only) and every live sheet (by
/// name, with A1 column-letter columns over the effective value bounds). Each becomes
/// one in-memory Arrow RecordBatch. (v1: ALL sources are built per query, off the hot
/// path; referenced-only / lazy registration is a v1.5 improvement.) The TOTAL cells
/// across all sources is bounded by [`MAX_SQL_INPUT_CELLS`] -- checked incrementally
/// BEFORE each source's columns are materialized, so a single far cell (whole-grid
/// `effective_value_bounds`) or many sources cannot force an unbounded Arrow allocation.
/// Over-cap, or a table/sheet name collision (which would silently shadow under one SQL
/// schema -- the sheet registers last and wins), is a loud `bad_argument`.
fn build_sql_tables(workbook: &Workbook) -> EngineResult<Vec<(String, RecordBatch)>> {
    let mut out: Vec<(String, RecordBatch)> = Vec::new();
    let mut names: HashSet<String> = HashSet::new();
    let mut total_cells: u64 = 0;

    // Defined tables: named columns, data rows only (header/totals excluded).
    for (_canonical, table) in workbook.tables().iter() {
        let sheet = match workbook.sheet(table.sheet) {
            Some(s) => s,
            None => continue, // tombstoned anchor sheet -> skip the table
        };
        let name = table.display_name.to_string();
        let n_rows = table
            .data_range()
            .map(|r| u64::from(r.end_row - r.start_row + 1))
            .unwrap_or(0);
        let cells = n_rows * (table.columns.len() as u64);
        total_cells = total_cells.saturating_add(cells);
        if total_cells > MAX_SQL_INPUT_CELLS {
            return Err(sql_input_cap_err(total_cells));
        }
        let mut columns: Vec<(String, Vec<Value>)> = Vec::with_capacity(table.columns.len());
        for (col_idx, col_meta) in table.columns.iter().enumerate() {
            let mut vals = Vec::new();
            if let Some(range) = table.column_data_range(col_idx as u32) {
                for row in range.start_row..=range.end_row {
                    vals.push(sheet.read(row, range.start_col));
                }
            }
            columns.push((col_meta.display.to_string(), vals));
        }
        if !names.insert(name.clone()) {
            return Err(name_collision_err(&name));
        }
        out.push((name, record_batch_from_columns(columns)?));
    }

    // Live sheets: A1 column-letter columns over the effective value bounds.
    for &sheet_id in workbook.sheet_display_order() {
        if workbook.is_sheet_removed(sheet_id) {
            continue;
        }
        let sheet = match workbook.sheet(sheet_id) {
            Some(s) => s,
            None => continue,
        };
        let bounds = sheet.effective_value_bounds();
        if bounds.col_extent == 0 {
            continue; // empty sheet -> nothing to query
        }
        let name = sheet.name().to_string();
        let cells = u64::from(bounds.row_extent) * u64::from(bounds.col_extent);
        // Check the running total BEFORE materializing the (potentially whole-grid) columns.
        total_cells = total_cells.saturating_add(cells);
        if total_cells > MAX_SQL_INPUT_CELLS {
            return Err(sql_input_cap_err(total_cells));
        }
        if !names.insert(name.clone()) {
            return Err(name_collision_err(&name));
        }
        let mut columns: Vec<(String, Vec<Value>)> = Vec::with_capacity(bounds.col_extent as usize);
        for col in 0..bounds.col_extent {
            let mut vals = Vec::with_capacity(bounds.row_extent as usize);
            for row in 0..bounds.row_extent {
                vals.push(sheet.read(row, col));
            }
            columns.push((column_index_to_letters(col), vals));
        }
        out.push((name, record_batch_from_columns(columns)?));
    }

    Ok(out)
}

/// The total cells across all queryable tables/sheets exceeded the SQL input budget.
/// Bounds total Arrow allocation per query (v1; referenced-only registration is v1.5).
fn sql_input_cap_err(total_cells: u64) -> EngineError {
    EngineError::bad_argument(format!(
        "materialize_query: total SQL input ({total_cells} cells across the workbook's \
         tables/sheets) exceeds the {MAX_SQL_INPUT_CELLS}-cell input cap"
    ))
}

/// A table and a sheet (or two sources) share a SQL-registration name -> a query would
/// silently resolve to whichever registered last. Fail loud instead (No-Fallbacks).
fn name_collision_err(name: &str) -> EngineError {
    EngineError::bad_argument(format!(
        "materialize_query: ambiguous SQL source name `{name}` (a table and a sheet, or \
         two sources, share it); rename one before querying"
    ))
}

/// Convert one SQL result column (an Arrow array) into a column of `CellValue`s.
/// Handles the Arrow types DataFusion produces over our inferred Float64/Boolean/Utf8
/// inputs, plus the integer types from `COUNT`/casts. Nulls -> `Blank`. An unsupported
/// result type is a loud `bad_argument` (No-Fallbacks).
fn arrow_column_to_cell_values(col: &ArrayRef) -> EngineResult<Vec<CellValue>> {
    macro_rules! num_col {
        ($ty:ty) => {{
            let a = col
                .as_any()
                .downcast_ref::<$ty>()
                .expect("data_type checked above");
            (0..a.len())
                .map(|i| {
                    if a.is_null(i) {
                        CellValue::Blank
                    } else {
                        CellValue::Number {
                            number: a.value(i) as f64,
                        }
                    }
                })
                .collect()
        }};
    }
    let out: Vec<CellValue> = match col.data_type() {
        DataType::Float64 => num_col!(Float64Array),
        DataType::Float32 => num_col!(Float32Array),
        DataType::Int64 => num_col!(Int64Array),
        DataType::Int32 => num_col!(Int32Array),
        DataType::Int16 => num_col!(Int16Array),
        DataType::Int8 => num_col!(Int8Array),
        DataType::UInt64 => num_col!(UInt64Array),
        DataType::UInt32 => num_col!(UInt32Array),
        DataType::UInt16 => num_col!(UInt16Array),
        DataType::UInt8 => num_col!(UInt8Array),
        DataType::Boolean => {
            let a = col
                .as_any()
                .downcast_ref::<BooleanArray>()
                .expect("data_type checked above");
            (0..a.len())
                .map(|i| {
                    if a.is_null(i) {
                        CellValue::Blank
                    } else {
                        CellValue::Boolean {
                            boolean: a.value(i),
                        }
                    }
                })
                .collect()
        }
        DataType::Utf8 => {
            let a = col
                .as_any()
                .downcast_ref::<StringArray>()
                .expect("data_type checked above");
            (0..a.len())
                .map(|i| {
                    if a.is_null(i) {
                        CellValue::Blank
                    } else {
                        CellValue::Text {
                            text: a.value(i).to_string(),
                        }
                    }
                })
                .collect()
        }
        DataType::LargeUtf8 => {
            let a = col
                .as_any()
                .downcast_ref::<LargeStringArray>()
                .expect("data_type checked above");
            (0..a.len())
                .map(|i| {
                    if a.is_null(i) {
                        CellValue::Blank
                    } else {
                        CellValue::Text {
                            text: a.value(i).to_string(),
                        }
                    }
                })
                .collect()
        }
        DataType::Null => (0..col.len()).map(|_| CellValue::Blank).collect(),
        other => {
            return Err(EngineError::bad_argument(format!(
                "materialize_query: unsupported SQL result column type {other:?}"
            )));
        }
    };
    Ok(out)
}

/// Convert a SQL result RecordBatch into a row-major `Vec<Vec<CellValue>>`.
fn record_batch_to_cell_values(batch: &RecordBatch) -> EngineResult<Vec<Vec<CellValue>>> {
    let n_rows = batch.num_rows();
    let n_cols = batch.num_columns();
    let mut cols: Vec<Vec<CellValue>> = Vec::with_capacity(n_cols);
    for c in 0..n_cols {
        cols.push(arrow_column_to_cell_values(batch.column(c))?);
    }
    let mut rows: Vec<Vec<CellValue>> = Vec::with_capacity(n_rows);
    for r in 0..n_rows {
        let mut row = Vec::with_capacity(n_cols);
        for c in cols.iter() {
            row.push(c[r].clone());
        }
        rows.push(row);
    }
    Ok(rows)
}

impl WorkbookSession {
    // ===== Wave Q1 (2026-06-23) -- chart-object CRUD (owning session) =====
    //
    // The product napi `Session` wraps this `WorkbookSession`; these inherent
    // methods are the surface its #[napi] chart methods call. Chart objects are
    // INERT for the calcgraph (no cells, no formula deps): the producer layer
    // (`workbook_runtime/charts.rs`) adds no calcgraph dirty-fan and no
    // plan-cache flush, since no cached formula plan depends on a chart.
    //
    // They are NOT inert for the snapshot-delta surface: a chart object has no
    // field in `WorkbookSnapshotDelta` and no `SessionChange` variant, so it
    // cannot be conveyed incrementally. Each chart mutation therefore calls
    // `bump_epoch` -- exactly like a table op (`create_table`) -- forcing the
    // owning session's `snapshot_delta` to return `full_rebuild_required`
    // (`EpochMismatch`), so the IDE reseeds via `snapshot` and re-pulls
    // `list_charts`. `bump_epoch` re-mints only the snapshot epoch and clears the
    // change-log; it does NOT recompute formulas. (The legacy CollabSession path
    // signals the same via `classify_delta_op` in `lib.rs`; the owning session
    // does not use that classifier, so this explicit `bump_epoch` is required --
    // its absence was the w119 data-loss blocker.)

    /// **Wave Q1:** add a chart object; returns its stable id. Both the anchor
    /// sheet and the source-range sheet must be live (not tombstoned).
    #[allow(clippy::too_many_arguments)]
    pub fn add_chart(
        &mut self,
        name: &str,
        chart_type: ql_storage::ChartKind,
        sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
        width_px: u32,
        height_px: u32,
        source_range: ql_types::Range,
        title: Option<String>,
    ) -> EngineResult<u32> {
        self.ensure_ready()?;
        self.require_live_sheet(sheet, "add_chart")?;
        self.require_live_sheet(source_range.sheet, "add_chart (source range sheet)")?;
        let id = self
            .with_runtime(|rt| {
                rt.add_chart(
                    name,
                    chart_type,
                    sheet,
                    anchor_row,
                    anchor_col,
                    width_px,
                    height_px,
                    source_range,
                    title,
                )
            })
            .map_err(map_runtime_err)?;
        // Chart objects are not in the incremental delta surface -> force a full
        // rebuild so the IDE reseeds + re-pulls `list_charts` (see module note).
        self.bump_epoch();
        Ok(id)
    }

    /// **Wave Q1:** replace a chart's full mutable state. Errors loudly if the
    /// id isn't registered.
    #[allow(clippy::too_many_arguments)]
    pub fn update_chart(
        &mut self,
        id: u32,
        name: &str,
        chart_type: ql_storage::ChartKind,
        sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
        width_px: u32,
        height_px: u32,
        source_range: ql_types::Range,
        title: Option<String>,
    ) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_live_sheet(sheet, "update_chart")?;
        self.require_live_sheet(source_range.sheet, "update_chart (source range sheet)")?;
        self.with_runtime(|rt| {
            rt.update_chart(
                id,
                name,
                chart_type,
                sheet,
                anchor_row,
                anchor_col,
                width_px,
                height_px,
                source_range,
                title,
            )
        })
        .map_err(map_runtime_err)?;
        self.bump_epoch(); // see add_chart
        Ok(())
    }

    /// **Wave Q1:** remove a chart by id. Errors loudly if the id isn't registered.
    pub fn remove_chart(&mut self, id: u32) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.remove_chart(id))
            .map_err(map_runtime_err)?;
        self.bump_epoch(); // see add_chart
        Ok(())
    }

    /// **Wave Q1:** snapshot all chart objects (HashMap-arbitrary order).
    ///
    /// Returns EVERY chart, including any anchored on (or sourcing from) a
    /// tombstoned sheet -- consistent with the table read surface
    /// (`collect_tables` / `WorkbookSnapshot.tables`), which likewise returns a
    /// tombstoned sheet's tables. Tombstoning is reversible: a later
    /// `restore_sheet` brings the sheet and its charts back together, so the
    /// engine must NOT drop them here. The IDE filters by live sheet for
    /// rendering (it has the live-sheet set from `snapshot`); a chart whose
    /// anchor sheet is absent from the snapshot simply has nowhere to draw.
    pub fn list_charts(&mut self) -> EngineResult<Vec<ql_storage::ChartObject>> {
        self.ensure_ready()?;
        Ok(self.with_runtime_no_oplog(|rt| rt.list_charts()))
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
        // History: `begin_transaction` inc.2c-5; `undo`/`redo` inc.2c-6;
        // `open`/`save` inc.2c-9; xlsx/csv `import`/`export` inc.2c-10/11/12;
        // `register`/`unregister`/`list_functions` 6.4-2; and the reserved bulk ops
        // `write_range` (6.5-0), `materialize_query` (6.5-1), `refresh_source`
        // (6.5-2), `publish_dataset` + `bind_range` (ENG-FUSION) are ALL real now.
        // The remaining honest Capability surface is `query_range` asked for column
        // extras the v1 columnar shape does not serve (formulas / formats /
        // rendered) — fail loud, never a silently narrower result. The option check
        // runs before sheet lookup, so a fresh session (no sheet, nothing to undo)
        // still surfaces it. (`export("xlsx")` without the `xlsx-write` feature is
        // covered separately.)
        let dummy_range = CellRange {
            sheet: 0,
            start_row: 0,
            start_col: 0,
            end_row: 0,
            end_col: 0,
        };
        let err = s
            .query_range(
                dummy_range,
                RangeQueryOptions {
                    include_formulas: true,
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Capability);
        assert_eq!(err.code, "not_implemented_in_v1_core");
        // A fresh session has nothing to undo/redo (but the methods are real now).
        assert!(!s.can_undo());
        assert!(!s.can_redo());
        assert!(!s.undo().unwrap().consumed);
        assert!(!s.redo().unwrap().consumed);
        // 6.4-2 verification: `list_functions` is now real on a fresh session;
        // returns the built-in metadata set (Vec) with deterministic ordering.
        let funcs = s.list_functions().expect("list_functions is real in 6.4-2");
        assert!(!funcs.is_empty(), "fresh session must list ~260 built-ins");
        assert!(
            funcs.iter().any(|m| m.canonical_name == "SUM"),
            "built-in SUM must appear in list_functions"
        );
    }

    // --- 6.5-0: write_range (bulk rectangular literal write substrate) ---

    /// The `state_seq` half of the version token (trailing 8 bytes, big-endian).
    fn token_seq(v: &SessionVersion) -> u64 {
        u64::from_be_bytes(v.0[16..24].try_into().expect("24-byte token"))
    }

    fn rng(sheet: SheetId, sr: RowId, sc: ColId, er: RowId, ec: ColId) -> CellRange {
        CellRange {
            sheet,
            start_row: sr,
            start_col: sc,
            end_row: er,
            end_col: ec,
        }
    }

    fn num(n: f64) -> CellValue {
        CellValue::Number { number: n }
    }

    /// A bulk write lands every cell AND dirties dependents: a `SUM(A1:B2)`
    /// formula recomputes after a `write_range` over its inputs. A broken no-op
    /// `write_range` fails this on BOTH the read-back and the recompute.
    #[test]
    fn write_range_is_observable_and_dirties_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();

        // Initial 2x2 write into A1:B2 (row-major: row0=[A1,B1], row1=[A2,B2]).
        let res = s
            .write_range(
                rng(sheet, 0, 0, 1, 1),
                vec![vec![num(1.0), num(2.0)], vec![num(3.0), num(4.0)]],
            )
            .unwrap();
        assert_eq!(res.written, 4);
        assert_eq!(cell_value(&s, addr(sheet, 0, 0)), num(1.0));
        assert_eq!(cell_value(&s, addr(sheet, 0, 1)), num(2.0));
        assert_eq!(cell_value(&s, addr(sheet, 1, 0)), num(3.0));
        assert_eq!(cell_value(&s, addr(sheet, 1, 1)), num(4.0));

        // A formula depending on every written cell evaluates eagerly to 10.
        // (Cell-ref arithmetic, not a literal range arg — the session binder
        // only admits literal ranges inside reference-aware fn arg lists.)
        s.set_formula(addr(sheet, 0, 2), "A1+B1+A2+B2").unwrap();
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(10.0));

        // Overwrite the inputs in bulk → C1 goes dirty → recalc recomputes to 100.
        s.write_range(
            rng(sheet, 0, 0, 1, 1),
            vec![vec![num(10.0), num(20.0)], vec![num(30.0), num(40.0)]],
        )
        .unwrap();
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 1, 1)), num(40.0));
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(100.0));
    }

    /// The whole bulk write is ONE command: the `state_seq` advances by exactly 1
    /// for a 4-cell write (not once per cell).
    #[test]
    fn write_range_advances_version_exactly_once() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let before = token_seq(&s.snapshot().unwrap().version);
        let res = s
            .write_range(
                rng(sheet, 0, 0, 1, 1),
                vec![vec![num(1.0), num(2.0)], vec![num(3.0), num(4.0)]],
            )
            .unwrap();
        let after = token_seq(&s.snapshot().unwrap().version);
        assert_eq!(
            after,
            before + 1,
            "a 4-cell bulk write is ONE state-seq bump"
        );
        assert_eq!(
            token_seq(&res.version),
            after,
            "result.version is the post-write token"
        );
    }

    /// A shape mismatch (wrong row count) is a loud `bad_argument` with NO partial
    /// write and NO version advance.
    #[test]
    fn write_range_shape_mismatch_is_bad_argument_no_partial_write() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(99.0)).unwrap();
        let seq0 = token_seq(&s.snapshot().unwrap().version);

        // Range spans 2 rows, matrix has 1 → mismatch.
        let err = s
            .write_range(rng(sheet, 0, 0, 1, 0), vec![vec![num(1.0)]])
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);

        // Wrong row width (range spans 2 cols, row has 1).
        let err2 = s
            .write_range(rng(sheet, 0, 0, 0, 1), vec![vec![num(1.0)]])
            .unwrap_err();
        assert_eq!(err2.class, ErrorClass::BadArgument);

        assert_eq!(
            cell_value(&s, addr(sheet, 0, 0)),
            num(99.0),
            "no partial write"
        );
        assert_eq!(
            token_seq(&s.snapshot().unwrap().version),
            seq0,
            "no version advance on rejection"
        );
    }

    /// An inverted range (end before start) is rejected loudly.
    #[test]
    fn write_range_inverted_range_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let err = s
            .write_range(rng(sheet, 5, 0, 1, 0), vec![vec![num(1.0)]])
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
    }

    /// A literal error value (or `Pending`) anywhere in the matrix is rejected
    /// UP FRONT — a preceding valid cell is NOT written (validate-all-then-apply).
    #[test]
    fn write_range_rejects_invalid_cell_value_no_partial_write() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(99.0)).unwrap();
        let seq0 = token_seq(&s.snapshot().unwrap().version);
        // A1:A2 (2 rows, 1 col): [Number, Error] — the error aborts before A1 is
        // overwritten with the new Number.
        let err = s
            .write_range(
                rng(sheet, 0, 0, 1, 0),
                vec![
                    vec![num(7.0)],
                    vec![CellValue::Error {
                        error: "#REF!".to_string(),
                    }],
                ],
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 0)),
            num(99.0),
            "no partial write"
        );

        let err2 = s
            .write_range(rng(sheet, 0, 0, 0, 0), vec![vec![CellValue::Pending]])
            .unwrap_err();
        assert_eq!(err2.class, ErrorClass::BadArgument);
        // Neither rejected write advanced the version token (validate-before-apply).
        assert_eq!(
            token_seq(&s.snapshot().unwrap().version),
            seq0,
            "no version advance on rejection"
        );
    }

    /// `Blank` in the matrix clears the cell (same `set_value` input semantics).
    #[test]
    fn write_range_blank_clears_cell() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(5.0)).unwrap();
        assert_eq!(cell_value(&s, addr(sheet, 0, 0)), num(5.0));
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![CellValue::Blank]])
            .unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap();
        assert!(
            c.is_none() || c.unwrap().value.is_none(),
            "a Blank bulk write clears the cell"
        );
    }

    /// Lifecycle + target gating: closed session → `invalid_state`; unknown sheet
    /// → `sheet_not_found`.
    #[test]
    fn write_range_gating() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let miss = s
            .write_range(rng(99, 0, 0, 0, 0), vec![vec![num(1.0)]])
            .unwrap_err();
        assert_eq!(miss.class, ErrorClass::NotFound);
        assert_eq!(miss.code, "sheet_not_found");
        s.close().unwrap();
        let closed = s
            .write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(1.0)]])
            .unwrap_err();
        assert_eq!(closed.code, "invalid_state");
    }

    /// A range exceeding the cell cap fails loud BEFORE any allocation/shape work
    /// (the cap is checked ahead of the matrix-shape validation).
    #[test]
    fn write_range_over_cell_cap_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // ~4M cells > the 1<<20 cap; pass an empty matrix so the cap fires first
        // (no multi-million-cell allocation).
        let err = s
            .write_range(rng(sheet, 0, 0, 1999, 1999), Vec::new())
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        // The CAP must be what rejects it (checked before shape) — both branches
        // are `bad_argument`, so pin the cap by its message.
        assert!(
            err.message.contains("write cap"),
            "cap must reject before shape validation; got: {}",
            err.message
        );
    }

    /// The whole bulk write is ONE op-log unit: it logs a single `Op::BatchCommit`
    /// (not N per-cell commits), and a single `undo()` reverts the ENTIRE range.
    /// This is the regression guard for the "per-cell `set_value` loop splits the
    /// write into N undo units" defect.
    #[test]
    fn write_range_is_one_batch_commit_and_undo_reverts_whole_range() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let log_before = s.oplog.len();
        s.write_range(
            rng(sheet, 0, 0, 1, 1),
            vec![vec![num(1.0), num(2.0)], vec![num(3.0), num(4.0)]],
        )
        .unwrap();

        // Exactly ONE op-log entry, and it is a BatchCommit holding all 4 cells.
        assert_eq!(
            s.oplog.len() - log_before,
            1,
            "a 4-cell write_range must log ONE BatchCommit"
        );
        let ops: Vec<Op> = s.oplog.iter().collect::<Result<_, _>>().unwrap();
        match ops.last().unwrap() {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(
                    inner.len(),
                    4,
                    "4 written cells -> 4 inner ops; got {inner:?}"
                );
                assert!(inner.iter().all(|o| matches!(o, Op::PutValue { .. })));
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }

        // ONE undo reverts the ENTIRE bulk write (a broken N-commit impl would
        // leave A1..B2 minus the last cell behind).
        assert!(s.undo().unwrap().consumed);
        for (r, c) in [(0u32, 0u32), (0, 1), (1, 0), (1, 1)] {
            assert!(
                s.cell(addr(sheet, r, c)).unwrap().is_none(),
                "cell ({r},{c}) must revert to empty after a single undo"
            );
        }
    }

    /// A non-A1-anchored range with mixed value kinds lands each cell at the right
    /// address (catches an offset bug in the row-major idx -> (row,col) mapping)
    /// and touches NOTHING outside the range.
    #[test]
    fn write_range_nonzero_anchor_mixed_kinds() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // B2:C3 (rows 1-2, cols 1-2). row0=[B2,C2], row1=[B3,C3].
        let res = s
            .write_range(
                rng(sheet, 1, 1, 2, 2),
                vec![
                    vec![num(1.0), CellValue::Boolean { boolean: true }],
                    vec![
                        CellValue::Text {
                            text: "hi".to_string(),
                        },
                        num(2.0),
                    ],
                ],
            )
            .unwrap();
        assert_eq!(res.written, 4);
        assert_eq!(cell_value(&s, addr(sheet, 1, 1)), num(1.0)); // B2
        assert_eq!(
            cell_value(&s, addr(sheet, 1, 2)),
            CellValue::Boolean { boolean: true }
        ); // C2
        assert_eq!(
            cell_value(&s, addr(sheet, 2, 1)),
            CellValue::Text {
                text: "hi".to_string()
            }
        ); // B3
        assert_eq!(cell_value(&s, addr(sheet, 2, 2)), num(2.0)); // C3
                                                                 // A1 (outside the range) was never touched.
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "A1 must be untouched"
        );
    }

    // --- 6.5-1: materialize_query (SQL over sheets/tables -> sheet) ---

    fn sql_data(sql: &str) -> serde_json::Value {
        serde_json::json!({ "sql": sql })
    }

    /// SQL-6-01 (query a SHEET) + SQL-6-02 (materialize to sheet): a GROUP BY/SUM over
    /// a sheet's A1-letter columns lands in the target block.
    #[test]
    fn materialize_query_sheet_aggregate() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(
            rng(sheet, 0, 0, 2, 1),
            vec![
                vec![num(10.0), CellValue::Text { text: "x".into() }],
                vec![num(20.0), CellValue::Text { text: "y".into() }],
                vec![num(30.0), CellValue::Text { text: "x".into() }],
            ],
        )
        .unwrap();
        let r = s
            .materialize_query(
                "q1",
                rng(sheet, 0, 3, 1, 4),
                sql_data("SELECT B, SUM(A) AS total FROM S GROUP BY B ORDER BY B"),
            )
            .unwrap();
        assert_eq!(r.id, "q1");
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 3)),
            CellValue::Text { text: "x".into() }
        );
        assert_eq!(cell_value(&s, addr(sheet, 0, 4)), num(40.0));
        assert_eq!(
            cell_value(&s, addr(sheet, 1, 3)),
            CellValue::Text { text: "y".into() }
        );
        assert_eq!(cell_value(&s, addr(sheet, 1, 4)), num(20.0));
    }

    /// SQL-6-01 (query a TABLE by name with its named columns).
    #[test]
    fn materialize_query_over_named_table() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        let spec = TableSpec {
            name: "T".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 3, // 1 header + 2 data
            cols: 2,
            has_header: true,
            has_totals: false,
            column_names: vec!["region".into(), "amount".into()],
        };
        s.create_table(spec).unwrap();
        // Data rows (1-2): region (col 0) + amount (col 1).
        s.write_range(
            rng(sid, 1, 0, 2, 1),
            vec![
                vec![
                    CellValue::Text {
                        text: "east".into(),
                    },
                    num(100.0),
                ],
                vec![
                    CellValue::Text {
                        text: "west".into(),
                    },
                    num(200.0),
                ],
            ],
        )
        .unwrap();
        let r = s
            .materialize_query(
                "q2",
                rng(sid, 0, 3, 1, 4),
                sql_data(
                    "SELECT region, SUM(amount) AS total FROM T GROUP BY region ORDER BY region",
                ),
            )
            .unwrap();
        assert_eq!(r.id, "q2");
        assert_eq!(
            cell_value(&s, addr(sid, 0, 3)),
            CellValue::Text {
                text: "east".into()
            }
        );
        assert_eq!(cell_value(&s, addr(sid, 0, 4)), num(100.0));
        assert_eq!(
            cell_value(&s, addr(sid, 1, 3)),
            CellValue::Text {
                text: "west".into()
            }
        );
        assert_eq!(cell_value(&s, addr(sid, 1, 4)), num(200.0));
    }

    /// SQL-6-02: a materialized cell dirties its dependents (a formula recomputes).
    #[test]
    fn materialize_query_dirties_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(5.0)).unwrap(); // A1 = 5
        s.set_formula(addr(sheet, 0, 2), "B1*2").unwrap(); // C1 = B1*2; B1 blank -> 0
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(0.0));
        s.materialize_query(
            "q3",
            rng(sheet, 0, 1, 0, 1),
            sql_data("SELECT A FROM S WHERE A = 5"),
        )
        .unwrap();
        assert_eq!(cell_value(&s, addr(sheet, 0, 1)), num(5.0)); // B1 materialized
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(10.0)); // C1 recomputed
    }

    /// A result larger than the target range is a loud bad_argument (No-Fallbacks).
    #[test]
    fn materialize_query_result_exceeds_target_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(
            rng(sheet, 0, 0, 2, 0),
            vec![vec![num(1.0)], vec![num(2.0)], vec![num(3.0)]],
        )
        .unwrap();
        // 3-row result into a 2x1 target -> does not fit.
        let err = s
            .materialize_query("q4", rng(sheet, 0, 2, 1, 2), sql_data("SELECT A FROM S"))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(err.message.contains("does not fit"), "got: {}", err.message);
    }

    /// A zero-row result writes nothing and leaves the target + version unchanged.
    #[test]
    fn materialize_query_zero_rows_writes_nothing() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(7.0)]])
            .unwrap();
        s.set_value(addr(sheet, 0, 2), num(99.0)).unwrap(); // target sentinel
        let seq0 = token_seq(&s.snapshot().unwrap().version);
        let r = s
            .materialize_query(
                "q5",
                rng(sheet, 0, 2, 0, 2),
                sql_data("SELECT A FROM S WHERE A > 1000"),
            )
            .unwrap();
        assert_eq!(r.id, "q5");
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 2)),
            num(99.0),
            "target untouched on 0-row result"
        );
        assert_eq!(
            token_seq(&s.snapshot().unwrap().version),
            seq0,
            "no version advance"
        );
    }

    /// Malformed `data` and bad SQL are loud bad_argument.
    #[test]
    fn materialize_query_bad_input_is_loud() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(1.0)]])
            .unwrap();
        let e1 = s
            .materialize_query("q", rng(sheet, 0, 1, 0, 1), serde_json::json!({"nope": 1}))
            .unwrap_err();
        assert_eq!(e1.class, ErrorClass::BadArgument);
        let e2 = s
            .materialize_query("q", rng(sheet, 0, 1, 0, 1), sql_data("   "))
            .unwrap_err();
        assert_eq!(e2.class, ErrorClass::BadArgument);
        let e3 = s
            .materialize_query("q", rng(sheet, 0, 1, 0, 1), sql_data("SELECT * FROM nope"))
            .unwrap_err();
        assert_eq!(e3.class, ErrorClass::BadArgument);
        assert_eq!(e3.code, "sql_error");
    }

    /// Lifecycle + target gating: closed -> invalid_state; unknown target sheet ->
    /// sheet_not_found (both before any SQL runs).
    #[test]
    fn materialize_query_gating() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let miss = s
            .materialize_query("q", rng(99, 0, 0, 0, 0), sql_data("SELECT 1"))
            .unwrap_err();
        assert_eq!(miss.code, "sheet_not_found");
        s.close().unwrap();
        let closed = s
            .materialize_query("q", rng(sheet, 0, 0, 0, 0), sql_data("SELECT 1"))
            .unwrap_err();
        assert_eq!(closed.code, "invalid_state");
    }

    /// A table and a sheet sharing a name is a loud bad_argument (no silent shadow).
    #[test]
    fn materialize_query_name_collision_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.create_table(TableSpec {
            name: "S".into(), // collides with the sheet name "S"
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["c".into()],
        })
        .unwrap();
        s.set_value(addr(sid, 1, 0), num(1.0)).unwrap();
        let err = s
            .materialize_query("q", rng(sid, 0, 3, 0, 3), sql_data("SELECT 1"))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(err.message.contains("ambiguous"), "got: {}", err.message);
    }

    /// A sheet too large to materialize into Arrow is rejected (input cap), not OOM.
    #[test]
    fn materialize_query_oversized_input_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // One far cell makes effective_value_bounds span ~4M cells (> the 1<<20 cap).
        s.set_value(addr(sheet, 2047, 2047), num(1.0)).unwrap();
        let err = s
            .materialize_query("q", rng(sheet, 0, 0, 0, 0), sql_data("SELECT 1"))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(err.message.contains("input cap"), "got: {}", err.message);
    }

    /// A result with more columns than the target is a loud "does not fit".
    #[test]
    fn materialize_query_too_many_columns_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 1), vec![vec![num(1.0), num(2.0)]])
            .unwrap();
        // 1 row x 2 cols into a 1x1 target.
        let err = s
            .materialize_query("q", rng(sheet, 0, 3, 0, 3), sql_data("SELECT A, B FROM S"))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(err.message.contains("does not fit"), "got: {}", err.message);
    }

    // --- 6.5-2: provenance reverse-index + refresh_source ---

    /// materialize_query records per-cell provenance and emits Event::Provenance
    /// for each produced cell (SQL-6-03 provenance recording).
    #[test]
    fn provenance_recorded_after_materialize_query() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 1, 0), vec![vec![num(1.0)], vec![num(2.0)]])
            .unwrap();
        let cursor0 = s.poll_events(EventCursor(0)).unwrap().next_cursor;
        s.materialize_query(
            "src1",
            rng(sheet, 0, 2, 1, 2),
            sql_data("SELECT A FROM S ORDER BY A"),
        )
        .unwrap();
        // Two cells produced (2 rows × 1 col): Event::Provenance for each.
        let page = s.poll_events(cursor0).unwrap();
        let prov_events: Vec<_> = page
            .events
            .iter()
            .filter(|e| matches!(e, Event::Provenance { .. }))
            .collect();
        assert_eq!(
            prov_events.len(),
            2,
            "one Provenance event per produced cell"
        );
        for ev in &prov_events {
            match ev {
                Event::Provenance { source, .. } => assert_eq!(source, "src1"),
                _ => unreachable!(),
            }
        }
    }

    /// A zero-row materialize_query still registers a provenance entry (no events,
    /// but refresh_source can later re-run the query when data arrives).
    #[test]
    fn provenance_recorded_for_zero_row_result() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(99.0)]])
            .unwrap();
        let cursor0 = s.poll_events(EventCursor(0)).unwrap().next_cursor;
        s.materialize_query(
            "src_empty",
            rng(sheet, 0, 2, 2, 2),
            sql_data("SELECT A FROM S WHERE A > 1000"),
        )
        .unwrap();
        // No Provenance events for a zero-row result.
        let page = s.poll_events(cursor0).unwrap();
        let n_prov = page
            .events
            .iter()
            .filter(|e| matches!(e, Event::Provenance { .. }))
            .count();
        assert_eq!(n_prov, 0, "no Provenance events for zero-row result");
        // But refresh_source should NOT return source_not_found — the entry exists.
        let dirty = s.refresh_source("src_empty", 1).unwrap();
        // The re-run still produces zero rows (same query), so dirtied == 0.
        assert_eq!(dirty.dirtied, 0);
    }

    /// **R23:** `cell_lineage` reports a SQL-materialized cell's source, kind, SQL
    /// text, and the produced block — and every cell of the block shares it.
    #[test]
    fn cell_lineage_query_cell_reports_sql_and_block() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 1, 0), vec![vec![num(1.0)], vec![num(2.0)]])
            .unwrap();
        let sql = "SELECT A FROM S ORDER BY A";
        s.materialize_query("q1", rng(sheet, 0, 2, 1, 2), sql_data(sql))
            .unwrap();

        let lin = s
            .cell_lineage(addr(sheet, 0, 2))
            .unwrap()
            .expect("C1 is query-produced");
        assert_eq!(lin.source_id, "q1");
        assert_eq!(lin.kind, LineageKind::Query);
        assert_eq!(lin.sql.as_deref(), Some(sql));
        assert_eq!(lin.revision, 0);
        assert_eq!(lin.produced_range, rng(sheet, 0, 2, 1, 2));
        assert_eq!(lin.produced_cells, 2);

        // The sibling cell of the same block reports the identical lineage.
        let lin2 = s
            .cell_lineage(addr(sheet, 1, 2))
            .unwrap()
            .expect("C2 is query-produced");
        assert_eq!(lin2.source_id, "q1");
        assert_eq!(lin2.produced_range, rng(sheet, 0, 2, 1, 2));
    }

    /// **R23:** an ordinary user-typed cell (and a never-written cell) has no
    /// lineage — `cell_lineage` returns `Ok(None)`, not a fabricated entry.
    #[test]
    fn cell_lineage_none_for_user_typed_cell() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(42.0)]])
            .unwrap();
        assert!(
            s.cell_lineage(addr(sheet, 0, 0)).unwrap().is_none(),
            "a user-typed cell has no lineage"
        );
        assert!(
            s.cell_lineage(addr(sheet, 5, 5)).unwrap().is_none(),
            "a never-written cell has no lineage"
        );
    }

    /// **R23:** a `publish_dataset` (qb.publish) cell reports `Published` lineage
    /// with NO SQL (its payload is a value matrix, not a query).
    #[test]
    fn cell_lineage_published_cell_has_no_sql() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let data = serde_json::json!({"values": [["AAPL", 192.5, true]]});
        s.publish_dataset("prices", data, rng(sheet, 0, 0, 0, 2))
            .unwrap();
        let lin = s
            .cell_lineage(addr(sheet, 0, 1))
            .unwrap()
            .expect("a published cell has lineage");
        assert_eq!(lin.source_id, "prices");
        assert_eq!(lin.kind, LineageKind::Published);
        assert_eq!(lin.sql, None, "a published dataset carries no SQL");
        assert_eq!(lin.produced_range, rng(sheet, 0, 0, 0, 2));
        assert_eq!(lin.produced_cells, 3);
    }

    /// **R23:** `refresh_source` advances the per-cell revision that `cell_lineage`
    /// reports, while keeping the source id and SQL intact.
    #[test]
    fn cell_lineage_revision_advances_after_refresh() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(7.0)]])
            .unwrap();
        let sql = "SELECT A FROM S";
        s.materialize_query("q", rng(sheet, 0, 2, 0, 2), sql_data(sql))
            .unwrap();
        assert_eq!(
            s.cell_lineage(addr(sheet, 0, 2)).unwrap().unwrap().revision,
            0
        );

        s.refresh_source("q", 1).unwrap();
        let lin = s
            .cell_lineage(addr(sheet, 0, 2))
            .unwrap()
            .expect("still query-produced after refresh");
        assert_eq!(lin.revision, 1, "refresh advances the lineage revision");
        assert_eq!(lin.sql.as_deref(), Some(sql));
    }

    // ====================================================================
    // R24 (Wave L3) — `used_range` + `list_tables` read getters.
    // ====================================================================

    /// **R24:** an empty / never-written sheet has no used range -> `Ok(None)`
    /// (distinct from a fabricated 1×1 A1 range).
    #[test]
    fn used_range_empty_sheet_is_none() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        assert!(
            s.used_range(sheet).unwrap().is_none(),
            "an all-blank sheet has no used range"
        );
    }

    /// **R24:** the used range is the value extent, anchored at A1 and INCLUSIVE
    /// of the far cell. Writing A1 and C2 -> A1:C2.
    #[test]
    fn used_range_spans_value_extent_inclusive() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(1.0)).unwrap();
        s.set_value(addr(sheet, 1, 2), num(2.0)).unwrap();
        assert_eq!(
            s.used_range(sheet).unwrap().expect("has data"),
            rng(sheet, 0, 0, 1, 2)
        );
    }

    /// **R24:** the extent is ORIGIN-ANCHORED (mirrors `effective_value_bounds`):
    /// a lone far cell at C3 still yields A1:C3, never C3:C3.
    #[test]
    fn used_range_is_origin_anchored() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 2, 2), num(9.0)).unwrap();
        assert_eq!(
            s.used_range(sheet).unwrap().expect("has data"),
            rng(sheet, 0, 0, 2, 2)
        );
    }

    /// **R24:** the extent tracks the VALUE extent — clearing the only value back
    /// to Blank shrinks the used range away to `None` (the value extent, unlike
    /// the conservative `bounds()`, shrinks).
    #[test]
    fn used_range_shrinks_to_none_when_values_cleared() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(5.0)).unwrap();
        assert_eq!(
            s.used_range(sheet).unwrap().expect("has data"),
            rng(sheet, 0, 0, 0, 0)
        );
        s.set_value(addr(sheet, 0, 0), CellValue::Blank).unwrap();
        assert!(
            s.used_range(sheet).unwrap().is_none(),
            "clearing the only value leaves no used range"
        );
    }

    /// **R24:** `used_range` gates like the sibling reads — an unknown sheet is a
    /// loud `[sheet_not_found]`, never a silent `Ok(None)`.
    #[test]
    fn used_range_unknown_sheet_fails_loud() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let err = s.used_range(99).unwrap_err();
        assert_eq!(err.code, "sheet_not_found");
    }

    /// **R24:** a deleted (tombstoned) sheet is a loud `[sheet_not_found]` for
    /// `used_range`, consistent with `cell` / `cell_lineage`.
    #[test]
    fn used_range_tombstoned_sheet_fails_loud() {
        let mut s = WorkbookSession::new();
        let _keep = s.add_sheet("A", 16384).unwrap();
        let gone = s.add_sheet("B", 16384).unwrap();
        s.set_value(addr(gone, 0, 0), num(1.0)).unwrap();
        s.delete_sheet(gone).unwrap();
        assert_eq!(s.used_range(gone).unwrap_err().code, "sheet_not_found");
    }

    /// **R24:** `used_range` is a read — rejected loud once the session is Closed.
    #[test]
    fn used_range_on_closed_session_is_invalid_state() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.close().unwrap();
        assert_eq!(s.used_range(sheet).unwrap_err().code, "invalid_state");
    }

    /// **R24:** `list_tables` on a workbook with no tables is an empty vec (a true
    /// empty, NOT an error).
    #[test]
    fn list_tables_empty_is_empty_vec() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        assert!(s.list_tables().unwrap().is_empty());
    }

    /// **R24:** `list_tables` reports created tables with their metadata, sorted by
    /// `(sheet, name)` — proven by creating out of order.
    #[test]
    fn list_tables_reports_created_tables_sorted() {
        let mut s = WorkbookSession::new();
        let s0 = s.add_sheet("S0", 16384).unwrap();
        let s1 = s.add_sheet("S1", 16384).unwrap();
        s.create_table(TableSpec {
            name: "ZED".into(),
            sheet: s1,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["c".into()],
        })
        .unwrap();
        s.create_table(TableSpec {
            name: "ALPHA".into(),
            sheet: s0,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 2,
            has_header: true,
            has_totals: false,
            column_names: vec!["a".into(), "b".into()],
        })
        .unwrap();
        let tables = s.list_tables().unwrap();
        assert_eq!(tables.len(), 2);
        // Sorted by (sheet, name): S0/ALPHA before S1/ZED.
        assert_eq!(tables[0].name, "ALPHA");
        assert_eq!(tables[0].sheet, s0);
        assert_eq!(tables[0].rows, 3);
        assert_eq!(tables[0].cols, 2);
        assert!(tables[0].has_header && !tables[0].has_totals);
        assert_eq!(tables[1].name, "ZED");
        assert_eq!(tables[1].sheet, s1);
    }

    /// **R24:** a table on a tombstoned sheet is RETAINED by `list_tables`
    /// (consistent with `collect_tables` / `list_charts`; the IDE filters by live
    /// sheet, `restore_sheet` brings it back).
    #[test]
    fn list_tables_retains_tombstoned_sheet_table() {
        let mut s = WorkbookSession::new();
        let _keep = s.add_sheet("KEEP", 16384).unwrap();
        let gone = s.add_sheet("GONE", 16384).unwrap();
        s.create_table(TableSpec {
            name: "T".into(),
            sheet: gone,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["c".into()],
        })
        .unwrap();
        s.delete_sheet(gone).unwrap();
        let tables = s.list_tables().unwrap();
        assert_eq!(tables.len(), 1, "tombstoned-sheet table is retained");
        assert_eq!(tables[0].name, "T");
    }

    /// **R24:** `list_tables` is a read — rejected loud once the session is Closed.
    #[test]
    fn list_tables_on_closed_session_is_invalid_state() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        s.close().unwrap();
        assert_eq!(s.list_tables().unwrap_err().code, "invalid_state");
    }

    /// **R23 (Codex BLOCKER fold):** a direct user VALUE/FORMULA write over a
    /// source-produced cell RETIRES its lineage — `cell_lineage` must no longer
    /// attribute the now-user-owned cell to the source.
    #[test]
    fn cell_lineage_dropped_after_user_overwrite() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 1, 0), vec![vec![num(1.0)], vec![num(2.0)]])
            .unwrap();
        s.materialize_query(
            "q",
            rng(sheet, 0, 2, 1, 2),
            sql_data("SELECT A FROM S ORDER BY A"),
        )
        .unwrap();
        // C1, C2 both start with lineage.
        assert!(s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_some());
        assert!(s.cell_lineage(addr(sheet, 1, 2)).unwrap().is_some());

        // set_value over C1 -> lineage dropped; sibling untouched.
        s.set_value(addr(sheet, 0, 2), num(99.0)).unwrap();
        assert!(
            s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_none(),
            "set_value retires lineage"
        );
        assert!(s.cell_lineage(addr(sheet, 1, 2)).unwrap().is_some());

        // set_formula over C2 -> dropped (raw source, no leading `=`).
        s.set_formula(addr(sheet, 1, 2), "1+1").unwrap();
        assert!(
            s.cell_lineage(addr(sheet, 1, 2)).unwrap().is_none(),
            "set_formula retires lineage"
        );
    }

    /// **R23 (Codex re-audit fold):** `clear` (clear_formula) is a NO-OP on a
    /// source-produced VALUE cell — the value is preserved — so lineage is KEPT
    /// (the cell still holds the source's output). A real content-clear
    /// (`set_value` with a Blank) DOES retire it. This is why neither the
    /// single-cell `clear` nor the batch `Clear` op is a lineage-drop site.
    #[test]
    fn cell_lineage_kept_after_noop_clear_dropped_after_blank() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(5.0)]])
            .unwrap();
        s.materialize_query("q", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();

        // clear on the materialized value cell: no-op (value preserved) -> lineage kept.
        s.clear(addr(sheet, 0, 2)).unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(num(5.0)),
            "clear is a no-op on a value cell (value preserved)"
        );
        assert!(
            s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_some(),
            "lineage is kept when clear did not change the cell"
        );

        // A real content-clear (Blank value) retires lineage.
        s.set_value(addr(sheet, 0, 2), CellValue::Blank).unwrap();
        assert!(
            s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_none(),
            "a Blank set_value retires lineage"
        );
    }

    /// **R23 (Codex BLOCKER fold):** a bulk user write (`write_range` -> `batch`)
    /// over a produced block retires the lineage of every overwritten cell, while
    /// a value/formula recorder (materialize) still establishes lineage.
    #[test]
    fn cell_lineage_dropped_after_range_overwrite() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 1, 0), vec![vec![num(1.0)], vec![num(2.0)]])
            .unwrap();
        s.materialize_query(
            "q",
            rng(sheet, 0, 2, 1, 2),
            sql_data("SELECT A FROM S ORDER BY A"),
        )
        .unwrap();
        assert!(s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_some());
        assert!(s.cell_lineage(addr(sheet, 1, 2)).unwrap().is_some());

        // User pastes a range over the whole produced block.
        s.write_range(rng(sheet, 0, 2, 1, 2), vec![vec![num(7.0)], vec![num(8.0)]])
            .unwrap();
        assert!(
            s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_none(),
            "write_range retires lineage"
        );
        assert!(s.cell_lineage(addr(sheet, 1, 2)).unwrap().is_none());
    }

    /// **R23 (Codex MED fold):** `produced_range` is the actual produced block
    /// (bounding box of written cells), NOT the larger declared target.
    #[test]
    fn cell_lineage_produced_range_is_block_not_target() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(
            rng(sheet, 0, 0, 2, 0),
            vec![vec![num(1.0)], vec![num(2.0)], vec![num(3.0)]],
        )
        .unwrap();
        // Target C1:C100 but the query returns only 2 rows -> produced block C1:C2.
        s.materialize_query(
            "q",
            rng(sheet, 0, 2, 99, 2),
            sql_data("SELECT A FROM S WHERE A < 3 ORDER BY A"),
        )
        .unwrap();
        let lin = s
            .cell_lineage(addr(sheet, 0, 2))
            .unwrap()
            .expect("C1 produced");
        assert_eq!(
            lin.produced_range,
            rng(sheet, 0, 2, 1, 2),
            "produced block is C1:C2, not the C1:C100 target"
        );
        assert_eq!(lin.produced_cells, 2);
    }

    /// **R23 (Lane-2 fold):** undo clears both provenance maps, so a materialized
    /// cell has no lineage after the materialize is undone.
    #[test]
    fn cell_lineage_none_after_undo() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(5.0)]])
            .unwrap();
        s.materialize_query("q", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        assert!(s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_some());
        s.undo().unwrap();
        assert!(
            s.cell_lineage(addr(sheet, 0, 2)).unwrap().is_none(),
            "undo clears lineage"
        );
    }

    /// **R23 (Codex HIGH fold):** `cell_lineage` gates like the sibling reads — an
    /// unknown/deleted sheet fails `[sheet_not_found]`, an out-of-grid address fails
    /// `[bad_argument]`, and a closed session fails `[invalid_state]` — none of these
    /// masquerade as `Ok(None)`.
    #[test]
    fn cell_lineage_gating() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let miss = s.cell_lineage(addr(99, 0, 0)).unwrap_err();
        assert_eq!(miss.code, "sheet_not_found");
        let oob = s.cell_lineage(addr(sheet, 9_999_999, 0)).unwrap_err();
        assert_eq!(oob.code, "bad_argument");
        s.close().unwrap();
        let closed = s.cell_lineage(addr(sheet, 0, 0)).unwrap_err();
        assert_eq!(closed.code, "invalid_state");
    }

    /// refresh_source on an unknown source_id returns source_not_found (NotFound).
    #[test]
    fn refresh_source_unknown_id_is_not_found() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let err = s.refresh_source("no_such_source", 1).unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "source_not_found");
    }

    /// refresh_source with revision == 0 is always a no-op (stored revision starts
    /// at 0, so 0 <= 0 → gate fires immediately).
    #[test]
    fn refresh_source_revision_zero_is_noop() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(5.0)]])
            .unwrap();
        s.materialize_query("src", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        let v_before = s.snapshot().unwrap().version;
        let result = s.refresh_source("src", 0).unwrap();
        assert_eq!(result.dirtied, 0);
        // Version must not advance on a no-op refresh.
        assert_eq!(s.snapshot().unwrap().version, v_before);
    }

    /// refresh_source revision gate: calling with the same revision twice is a
    /// no-op on the second call (stored revision == caller revision → gate fires).
    #[test]
    fn refresh_source_same_revision_is_noop_on_second_call() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(7.0)]])
            .unwrap();
        s.materialize_query("src", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        s.refresh_source("src", 1).unwrap(); // first refresh: revision 1
        let v_after_first = s.snapshot().unwrap().version;
        let result = s.refresh_source("src", 1).unwrap(); // same revision again
        assert_eq!(result.dirtied, 0, "second call with same revision is no-op");
        assert_eq!(s.snapshot().unwrap().version, v_after_first);
    }

    /// refresh_source re-materializes the query and dirties dependents of the
    /// produced cells (SQL-6-03: refresh dirties dependents → recalc_dirty heals).
    #[test]
    fn refresh_source_rematerializes_and_dirties_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Col A: source data (1 row). Col B: will be the materialized output.
        // Col C: formula depending on Col B.
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(3.0)]])
            .unwrap();
        s.set_formula(addr(sheet, 0, 2), "B1 * 10").unwrap(); // C1 = B1*10
                                                              // First materialization: B1 = 3 (from SELECT A FROM S).
        s.materialize_query("src", rng(sheet, 0, 1, 0, 1), sql_data("SELECT A FROM S"))
            .unwrap();
        assert_eq!(cell_value(&s, addr(sheet, 0, 1)), num(3.0));
        // C1 is now dirty (B1 changed); recalc it.
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(30.0));

        // Update source data: A1 = 7.
        s.set_value(addr(sheet, 0, 0), num(7.0)).unwrap();

        // refresh_source(revision=1) should re-materialize B1=7 and dirty C1.
        let dirty = s.refresh_source("src", 1).unwrap();
        assert!(dirty.dirtied >= 1, "at least C1 must be dirtied");
        assert_eq!(cell_value(&s, addr(sheet, 0, 1)), num(7.0)); // B1 updated
        let op2 = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op2).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(70.0)); // C1 healed
    }

    /// refresh_source advances the stored revision so a lower revision is a no-op.
    #[test]
    fn refresh_source_advances_stored_revision() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(1.0)]])
            .unwrap();
        s.materialize_query("src", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        // First refresh at revision 5.
        s.refresh_source("src", 5).unwrap();
        // Refresh at revision 3 (lower than stored 5) → no-op.
        let result = s.refresh_source("src", 3).unwrap();
        assert_eq!(
            result.dirtied, 0,
            "lower revision is a no-op after higher refresh"
        );
    }

    /// refresh_source on a closed session returns invalid_state (lifecycle gate).
    #[test]
    fn refresh_source_closed_session_is_invalid_state() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(1.0)]])
            .unwrap();
        s.materialize_query("src", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        s.close().unwrap();
        let err = s.refresh_source("src", 1).unwrap_err();
        assert_eq!(err.code, "invalid_state");
    }

    /// A shrinking refresh correctly dirties dependents of cells the source no
    /// longer produces (SQL-6-03 correctness for the shrinking-result case).
    ///
    /// Setup: A1=1, A2=2, A3=3; query `SELECT A FROM S WHERE A > 0` → B1=1, B2=2,
    /// B3=3 (3 cells). Formulas C1=B1*10, C2=B2*10, C3=B3*10 are all clean after
    /// recalc. Then A2 and A3 become negative so the query now returns only 1 row.
    /// `refresh_source` MUST dirty C2 and C3 (B2/B3 not in new write block) via the
    /// `source_id→cells` reverse-index fan-out, not just via `write_range`.
    #[test]
    fn refresh_source_shrinking_result_dirties_stale_cell_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();

        // A1=1, A2=2, A3=3 (all positive so WHERE A>0 returns 3 rows).
        s.write_range(
            rng(sheet, 0, 0, 2, 0),
            vec![vec![num(1.0)], vec![num(2.0)], vec![num(3.0)]],
        )
        .unwrap();

        // Formulas in col C that depend on col B (the materialized output).
        s.set_formula(addr(sheet, 0, 2), "B1 * 10").unwrap(); // C1
        s.set_formula(addr(sheet, 1, 2), "B2 * 10").unwrap(); // C2
        s.set_formula(addr(sheet, 2, 2), "B3 * 10").unwrap(); // C3

        // First materialization: 3 rows → B1=1, B2=2, B3=3.
        s.materialize_query(
            "src",
            rng(sheet, 0, 1, 2, 1),
            sql_data("SELECT A FROM S WHERE A > 0 ORDER BY A"),
        )
        .unwrap();
        assert_eq!(cell_value(&s, addr(sheet, 0, 1)), num(1.0));
        assert_eq!(cell_value(&s, addr(sheet, 1, 1)), num(2.0));
        assert_eq!(cell_value(&s, addr(sheet, 2, 1)), num(3.0));

        // Recalc so C1=10, C2=20, C3=30 are all clean.
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(10.0));
        assert_eq!(cell_value(&s, addr(sheet, 1, 2)), num(20.0));
        assert_eq!(cell_value(&s, addr(sheet, 2, 2)), num(30.0));
        assert_eq!(
            s.graph.dirty_formulas().len(),
            0,
            "no dirty formulas after recalc"
        );

        // Shrink: A2 = -1, A3 = -2 (both negative, filtered out by WHERE A>0).
        // C1/C2/C3 depend on B1/B2/B3, not on A2/A3, so no formula is dirtied here.
        s.set_value(addr(sheet, 1, 0), num(-1.0)).unwrap();
        s.set_value(addr(sheet, 2, 0), num(-2.0)).unwrap();
        assert_eq!(
            s.graph.dirty_formulas().len(),
            0,
            "col-A writes must not dirty col-C formulas"
        );

        // refresh_source: SQL now returns only 1 row (B1=1). The refresh must fire
        // on_set_value at B2 and B3 (old cells, via the reverse-index fan-out) so C2
        // and C3 are dirtied even though write_range never touches B2/B3.
        let result = s.refresh_source("src", 1).unwrap();
        assert!(
            result.dirtied >= 3,
            "expected C1, C2, C3 all dirtied (got {}); shrinking refresh must \
             dirty stale-cell dependents via reverse-index fan-out",
            result.dirtied
        );

        // Per-cell provenance: B1 still present at revision=1; B2/B3 evicted.
        assert!(
            s.cell_provenance.contains_key(&addr(sheet, 0, 1)),
            "B1 must remain in cell_provenance"
        );
        assert!(
            !s.cell_provenance.contains_key(&addr(sheet, 1, 1)),
            "B2 must be evicted (no longer produced)"
        );
        assert!(
            !s.cell_provenance.contains_key(&addr(sheet, 2, 1)),
            "B3 must be evicted (no longer produced)"
        );
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 1)].revision, 1);
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 1)].source_id, "src");

        // Recalc: C1/C2/C3 all recompute correctly.
        let op2 = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op2).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(10.0)); // B1=1 → C1=10
                                                                  // B2 was not overwritten by the shrinking refresh, so it keeps its old value.
        assert_eq!(cell_value(&s, addr(sheet, 1, 2)), num(20.0)); // B2 still=2 → C2=20
        assert_eq!(cell_value(&s, addr(sheet, 2, 2)), num(30.0)); // B3 still=3 → C3=30
    }

    /// Per-cell provenance map is populated and accessible after materialize_query.
    #[test]
    fn cell_provenance_populated_after_materialize_query() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 1, 0), vec![vec![num(5.0)], vec![num(6.0)]])
            .unwrap();
        s.materialize_query(
            "qp",
            rng(sheet, 0, 2, 1, 2),
            sql_data("SELECT A FROM S ORDER BY A"),
        )
        .unwrap();
        // Both produced cells must be in the per-cell map with source="qp", revision=0.
        let cp0 = s
            .cell_provenance
            .get(&addr(sheet, 0, 2))
            .expect("cell (0,2) in map");
        assert_eq!(cp0.source_id, "qp");
        assert_eq!(cp0.revision, 0);
        let cp1 = s
            .cell_provenance
            .get(&addr(sheet, 1, 2))
            .expect("cell (1,2) in map");
        assert_eq!(cp1.source_id, "qp");
        assert_eq!(cp1.revision, 0);
    }

    /// Undo after materialize_query clears provenance: refresh_source on the
    /// undone source returns source_not_found (not a resurrection of undone data).
    #[test]
    fn refresh_source_after_undo_is_not_found() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(1.0)]])
            .unwrap();
        s.materialize_query("src", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        // Provenance is established.
        assert!(s.provenance.contains_key("src"));
        assert!(s.cell_provenance.contains_key(&addr(sheet, 0, 2)));

        // Undo the materialization.
        let ur = s.undo().unwrap();
        assert!(ur.consumed, "undo must consume a step");
        // Both provenance maps must be cleared by rematerialize.
        assert!(
            !s.provenance.contains_key("src"),
            "provenance must be cleared after undo"
        );
        assert!(
            s.cell_provenance.is_empty(),
            "cell_provenance must be cleared after undo"
        );
        // refresh_source on the undone source must return source_not_found.
        let err = s.refresh_source("src", 1).unwrap_err();
        assert_eq!(err.code, "source_not_found");
    }

    /// Redo also clears provenance (rematerialize rebuilds from op-log; session-local
    /// provenance is not in the log and must not survive a wholesale rebuild).
    #[test]
    fn refresh_source_after_redo_is_not_found() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.write_range(rng(sheet, 0, 0, 0, 0), vec![vec![num(2.0)]])
            .unwrap();
        s.materialize_query("src", rng(sheet, 0, 2, 0, 2), sql_data("SELECT A FROM S"))
            .unwrap();
        s.undo().unwrap();
        // Redo brings the cell values back from the op-log but NOT provenance.
        let ur = s.redo().unwrap();
        assert!(ur.consumed, "redo must consume a step");
        assert!(
            !s.provenance.contains_key("src"),
            "provenance must remain cleared after redo (not in op-log)"
        );
        let err = s.refresh_source("src", 1).unwrap_err();
        assert_eq!(err.code, "source_not_found");
    }

    /// Repeated materialize_query for the same query_id evicts cells from the prior
    /// run that are no longer produced, without touching cells owned by other sources.
    #[test]
    fn materialize_query_repeated_evicts_stale_cell_provenance() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // First run: A1=1, A2=2, A3=3 → B1, B2, B3 produced.
        s.write_range(
            rng(sheet, 0, 0, 2, 0),
            vec![vec![num(1.0)], vec![num(2.0)], vec![num(3.0)]],
        )
        .unwrap();
        s.materialize_query(
            "q1",
            rng(sheet, 0, 1, 2, 1),
            sql_data("SELECT A FROM S ORDER BY A"),
        )
        .unwrap();
        assert!(s.cell_provenance.contains_key(&addr(sheet, 0, 1))); // B1
        assert!(s.cell_provenance.contains_key(&addr(sheet, 1, 1))); // B2
        assert!(s.cell_provenance.contains_key(&addr(sheet, 2, 1))); // B3

        // Another source claims B2.
        s.materialize_query(
            "q2",
            rng(sheet, 1, 1, 1, 1),
            sql_data("SELECT A FROM S WHERE A = 2"),
        )
        .unwrap();
        assert_eq!(s.cell_provenance[&addr(sheet, 1, 1)].source_id, "q2");

        // Second run of q1 with a 1-row result: B1 still owned, B2 now owned by q2
        // (must not be evicted), B3 owned by q1 (must be evicted).
        s.write_range(
            rng(sheet, 1, 0, 2, 0),
            vec![vec![num(-1.0)], vec![num(-2.0)]],
        )
        .unwrap();
        s.materialize_query(
            "q1",
            rng(sheet, 0, 1, 2, 1),
            sql_data("SELECT A FROM S WHERE A > 0 ORDER BY A"),
        )
        .unwrap();
        // B1 still owned by q1.
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 1)].source_id, "q1");
        // B2 still owned by q2 (q1 no longer produced it, but q2 is the last writer).
        assert_eq!(
            s.cell_provenance[&addr(sheet, 1, 1)].source_id,
            "q2",
            "q2's ownership of B2 must not be evicted by q1's re-run"
        );
        // B3 was owned by q1 and is no longer produced → evicted.
        assert!(
            !s.cell_provenance.contains_key(&addr(sheet, 2, 1)),
            "B3 must be evicted from cell_provenance (q1 no longer produces it)"
        );
    }

    /// refresh_source does not clobber another source's last-writer ownership when
    /// evicting stale cells from the shrinking result.
    #[test]
    fn refresh_source_does_not_evict_other_source_ownership() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();

        // q1 produces B1=1, B2=2, B3=3.
        s.write_range(
            rng(sheet, 0, 0, 2, 0),
            vec![vec![num(1.0)], vec![num(2.0)], vec![num(3.0)]],
        )
        .unwrap();
        // D1=B3*10 — a formula that depends on B3 so we can verify dirtying.
        s.set_formula(addr(sheet, 0, 3), "B3 * 10").unwrap();
        s.materialize_query(
            "q1",
            rng(sheet, 0, 1, 2, 1),
            sql_data("SELECT A FROM S WHERE A > 0 ORDER BY A"),
        )
        .unwrap();
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 3)), num(30.0)); // D1=3*10=30
                                                                  // q2 takes over B2.
        s.materialize_query(
            "q2",
            rng(sheet, 1, 1, 1, 1),
            sql_data("SELECT A FROM S WHERE A = 2"),
        )
        .unwrap();
        assert_eq!(s.cell_provenance[&addr(sheet, 1, 1)].source_id, "q2");

        // Shrink source data so q1's refresh only produces 1 row (B1).
        s.set_value(addr(sheet, 1, 0), num(-1.0)).unwrap();
        s.set_value(addr(sheet, 2, 0), num(-2.0)).unwrap();
        let _ = s.recalc_dirty(); // clean any dirty from set_value

        let result = s.refresh_source("q1", 1).unwrap();
        // D1 depends on B3 which is in q1's old_cells → at least D1 must be dirtied.
        assert!(
            result.dirtied >= 1,
            "D1 (depends on B3) must be dirtied, got {}",
            result.dirtied
        );

        // B1 still owned by q1 with revision=1.
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 1)].source_id, "q1");
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 1)].revision, 1);
        // B2 must still be owned by q2 (q1's eviction must not remove q2's entry).
        assert_eq!(
            s.cell_provenance[&addr(sheet, 1, 1)].source_id,
            "q2",
            "q2 ownership of B2 must survive q1's shrinking refresh"
        );
        // B3 was owned by q1 and not produced any more → evicted by q1's refresh.
        assert!(
            !s.cell_provenance.contains_key(&addr(sheet, 2, 1)),
            "B3 (owned by q1, not in new result) must be evicted"
        );
    }

    // --- ENG-FUSION: publish_dataset ---

    /// publish_dataset writes a JSON value-matrix per cell (text/number/bool) and records
    /// the dual-index provenance keyed by `name`.
    #[test]
    fn publish_dataset_writes_and_tracks_provenance() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let data = serde_json::json!({"values": [["AAPL", 192.5, true]]});
        let r = s
            .publish_dataset("prices", data, rng(sheet, 0, 0, 0, 2))
            .unwrap();
        assert_eq!(r.id, "prices");
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 0)),
            CellValue::Text {
                text: "AAPL".into()
            }
        );
        assert_eq!(cell_value(&s, addr(sheet, 0, 1)), num(192.5));
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 2)),
            CellValue::Boolean { boolean: true }
        );
        // Dual provenance index: source reverse + per-cell forward.
        assert_eq!(s.provenance["prices"].cells.len(), 3);
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 0)].source_id, "prices");
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 2)].source_id, "prices");
    }

    /// A JSON null publishes as a Blank (cleared) cell.
    #[test]
    fn publish_dataset_null_is_blank() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(5.0)).unwrap();
        s.publish_dataset(
            "d",
            serde_json::json!({"values": [[null]]}),
            rng(sheet, 0, 0, 0, 0),
        )
        .unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap();
        assert!(
            c.is_none() || c.unwrap().value.is_none(),
            "a JSON null publishes as a Blank (cleared) cell"
        );
    }

    /// publish_dataset dirties dependents; recalc recomputes them, and re-publishing a
    /// new value at the same cell reactively updates the dependent (the core moat path).
    #[test]
    fn publish_dataset_dirties_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 2), "B1*2").unwrap(); // C1 = B1*2; B1 blank -> 0
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(0.0));
        s.publish_dataset(
            "v",
            serde_json::json!({"values": [[5.0]]}),
            rng(sheet, 0, 1, 0, 1),
        )
        .unwrap(); // B1 = 5
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(10.0)); // C1 = 5*2

        // Re-publish a new value -> the dependent reactively updates.
        s.publish_dataset(
            "v",
            serde_json::json!({"values": [[8.0]]}),
            rng(sheet, 0, 1, 0, 1),
        )
        .unwrap();
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 2)), num(16.0)); // C1 = 8*2
    }

    /// THE moat behaviour: re-publishing a SHRUNK value dirties the dependents of cells
    /// the previous value covered but the new one does not (the refresh_source fan-out),
    /// and evicts their per-cell provenance. (Vacated cells keep their value, exactly
    /// like materialize_query / refresh_source — clearing is the caller's job.)
    #[test]
    fn publish_dataset_republish_shrink_dirties_vacated_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // D1 depends ONLY on B3 (vacated on shrink); nothing depends on B1.
        s.set_formula(addr(sheet, 0, 3), "B3*10").unwrap();
        s.publish_dataset(
            "px",
            serde_json::json!({"values": [[1.0], [2.0], [3.0]]}),
            rng(sheet, 0, 1, 2, 1),
        )
        .unwrap(); // B1=1, B2=2, B3=3
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(cell_value(&s, addr(sheet, 0, 3)), num(30.0)); // D1 = B3*10 = 30
        assert!(s.cell_provenance.contains_key(&addr(sheet, 2, 1))); // B3 owned by px
        let dirty_before = s.graph.dirty_formulas().len();

        // Re-publish a 1-row value -> writes only B1; B2/B3 are vacated.
        s.publish_dataset(
            "px",
            serde_json::json!({"values": [[7.0]]}),
            rng(sheet, 0, 1, 2, 1),
        )
        .unwrap();
        // The vacated-cell fan-out dirtied D1 (depends on B3). Nothing depends on B1, so
        // the increase is attributable to the shrink fan-out.
        assert!(
            s.graph.dirty_formulas().len() > dirty_before,
            "shrink re-publish must dirty the dependents of vacated cells (D1)"
        );
        // B3's per-cell provenance is evicted (px no longer produces it); B1 still owned.
        assert!(
            !s.cell_provenance.contains_key(&addr(sheet, 2, 1)),
            "B3 must be evicted from cell_provenance after the shrink re-publish"
        );
        assert_eq!(s.cell_provenance[&addr(sheet, 0, 1)].source_id, "px");
    }

    /// publish_dataset is ONE BatchCommit; a single undo reverts the whole block.
    #[test]
    fn publish_dataset_is_one_batch_commit_and_undo_reverts() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let log_before = s.oplog.len();
        s.publish_dataset(
            "d",
            serde_json::json!({"values": [[1.0, 2.0], [3.0, 4.0]]}),
            rng(sheet, 0, 0, 1, 1),
        )
        .unwrap();
        assert_eq!(
            s.oplog.len() - log_before,
            1,
            "a 4-cell publish must log ONE BatchCommit"
        );
        assert!(s.undo().unwrap().consumed);
        for (r, c) in [(0u32, 0u32), (0, 1), (1, 0), (1, 1)] {
            assert!(
                s.cell(addr(sheet, r, c)).unwrap().is_none(),
                "cell ({r},{c}) reverts to empty after one undo"
            );
        }
    }

    /// A value larger than the target range is a loud bad_argument (No-Fallbacks).
    #[test]
    fn publish_dataset_result_exceeds_target_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // 3-row value into a 2x1 target -> does not fit.
        let err = s
            .publish_dataset(
                "d",
                serde_json::json!({"values": [[1.0], [2.0], [3.0]]}),
                rng(sheet, 0, 0, 1, 0),
            )
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(err.message.contains("does not fit"), "got: {}", err.message);
    }

    /// Malformed `data` is loud bad_argument with no write: missing `values`, a
    /// non-rectangular matrix, and a non-scalar element.
    #[test]
    fn publish_dataset_bad_data_is_loud() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let t = rng(sheet, 0, 0, 4, 4);
        assert_eq!(
            s.publish_dataset("d", serde_json::json!({"nope": 1}), t)
                .unwrap_err()
                .class,
            ErrorClass::BadArgument
        );
        assert_eq!(
            s.publish_dataset("d", serde_json::json!({"values": [[1.0, 2.0], [3.0]]}), t)
                .unwrap_err()
                .class,
            ErrorClass::BadArgument
        );
        assert_eq!(
            s.publish_dataset("d", serde_json::json!({"values": [[{"a": 1}]]}), t)
                .unwrap_err()
                .class,
            ErrorClass::BadArgument
        );
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "nothing is written on malformed data"
        );
    }

    /// A zero-row value writes nothing and leaves the target + version unchanged, but
    /// records a provenance entry (for attribution).
    #[test]
    fn publish_dataset_zero_rows_writes_nothing() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), num(99.0)).unwrap();
        let seq0 = token_seq(&s.snapshot().unwrap().version);
        let r = s
            .publish_dataset(
                "d",
                serde_json::json!({"values": []}),
                rng(sheet, 0, 0, 0, 0),
            )
            .unwrap();
        assert_eq!(r.id, "d");
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 0)),
            num(99.0),
            "target untouched on a 0-row publish"
        );
        assert_eq!(
            token_seq(&s.snapshot().unwrap().version),
            seq0,
            "no version advance"
        );
        assert!(
            s.provenance.contains_key("d"),
            "still records a provenance entry"
        );
    }

    /// Lifecycle + target gating: unknown sheet -> sheet_not_found; closed ->
    /// invalid_state (both before any conversion).
    #[test]
    fn publish_dataset_gating() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let miss = s
            .publish_dataset(
                "d",
                serde_json::json!({"values": [[1.0]]}),
                rng(99, 0, 0, 0, 0),
            )
            .unwrap_err();
        assert_eq!(miss.code, "sheet_not_found");
        s.close().unwrap();
        let closed = s
            .publish_dataset(
                "d",
                serde_json::json!({"values": [[1.0]]}),
                rng(sheet, 0, 0, 0, 0),
            )
            .unwrap_err();
        assert_eq!(closed.code, "invalid_state");
    }

    /// refresh_source on a published dataset is a loud bad_argument (its producer is
    /// external -> update by re-publishing), NOT a misleading SQL-parse error.
    #[test]
    fn refresh_source_rejects_published_dataset() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "ds",
            serde_json::json!({"values": [[1.0]]}),
            rng(sheet, 0, 0, 0, 0),
        )
        .unwrap();
        let err = s.refresh_source("ds", 1).unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(
            err.message.contains("published dataset"),
            "got: {}",
            err.message
        );
        // Precedence: the Published rejection fires BEFORE the revision gate, so even a
        // revision=0 (normally a no-op) refresh on a published id is the loud rejection,
        // not a silent dirtied=0.
        let err0 = s.refresh_source("ds", 0).unwrap_err();
        assert_eq!(err0.class, ErrorClass::BadArgument);
        assert!(
            err0.message.contains("published dataset"),
            "got: {}",
            err0.message
        );
    }

    /// A value-matrix exceeding the 1<<20-cell cap is a loud bad_argument BEFORE the
    /// bulk conversion + with no write / no provenance retained.
    #[test]
    fn publish_dataset_oversized_input_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // One row, (1<<20)+1 columns -> over the cap (caught after parsing row 0).
        let n = (1usize << 20) + 1;
        let row = serde_json::Value::Array(vec![serde_json::Value::from(1.0); n]);
        let data = serde_json::json!({ "values": [row] });
        let err = s
            .publish_dataset("big", data, rng(sheet, 0, 0, 0, 0))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(err.message.contains("cap"), "got: {}", err.message);
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "nothing written on an over-cap publish"
        );
        assert!(
            !s.provenance.contains_key("big"),
            "no provenance retained on an over-cap publish"
        );
    }

    // --- ENG-FUSION: bind_range ---

    /// bind_range registers binding_id -> target (resolvable via `binding`), and a
    /// write into the bound region round-trips through the normal read path.
    #[test]
    fn bind_range_registers_and_round_trips() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 1, 0); // A1:A2
        let b = s.bind_range("b1", target).unwrap();
        assert_eq!(b.binding_id, "b1");
        let bound = s.binding("b1").expect("binding present");
        assert_eq!(bound.target, target);
        assert_eq!(bound.direction, BindDirection::Forward);
        assert!(bound.alive);
        assert!(!bound.force_check);
        assert_eq!(
            bound.source_id, None,
            "a bare bind_range has no provenance source until published"
        );
        // Round-trip: a write into the bound region reads back via the normal path.
        s.write_range(target, vec![vec![num(10.0)], vec![num(20.0)]])
            .unwrap();
        assert_eq!(cell_value(&s, addr(sheet, 0, 0)), num(10.0));
        assert_eq!(cell_value(&s, addr(sheet, 1, 0)), num(20.0));
    }

    /// Re-binding an existing id overwrites the region (after validation).
    #[test]
    fn bind_range_rebind_overwrites() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let a = rng(sheet, 0, 0, 0, 0);
        let b = rng(sheet, 1, 1, 2, 2);
        s.bind_range("x", a).unwrap();
        s.bind_range("x", b).unwrap();
        assert_eq!(
            s.binding("x").map(|bd| bd.target),
            Some(b),
            "re-binding overwrites the region"
        );
    }

    /// An inverted target is a loud bad_argument and records no binding.
    #[test]
    fn bind_range_inverted_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let err = s.bind_range("b", rng(sheet, 2, 0, 0, 0)).unwrap_err(); // end < start
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert!(
            s.binding("b").is_none(),
            "no binding recorded on an invalid target"
        );
    }

    /// A target outside the addressable grid is a loud bad_argument.
    #[test]
    fn bind_range_out_of_bounds_is_bad_argument() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let err = s
            .bind_range("b", rng(sheet, 0, 0, 2_000_000, 0))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
    }

    /// A binding is a region pointer (not data), so it survives undo/redo — unlike
    /// the provenance maps, which are cleared on undo.
    #[test]
    fn bind_range_kept_across_undo() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 0, 0);
        s.bind_range("b", target).unwrap();
        s.set_value(addr(sheet, 0, 0), num(5.0)).unwrap();
        assert!(s.undo().unwrap().consumed);
        assert_eq!(
            s.binding("b").map(|bd| bd.target),
            Some(target),
            "binding survives undo (unlike provenance)"
        );
    }

    /// Lifecycle + target gating: unknown sheet -> sheet_not_found; closed ->
    /// invalid_state.
    #[test]
    fn bind_range_gating() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let miss = s.bind_range("b", rng(99, 0, 0, 0, 0)).unwrap_err();
        assert_eq!(miss.code, "sheet_not_found");
        s.close().unwrap();
        let closed = s.bind_range("b", rng(sheet, 0, 0, 0, 0)).unwrap_err();
        assert_eq!(closed.code, "invalid_state");
    }

    // --- TE1: publish↔bind unified-binding wiring ---

    /// A `publish_dataset` is the DATA half of the unified binding: it upserts
    /// `bindings[name]` with `source_id = name` (the lineage invariant), `Forward`
    /// direction, `alive`, generation 0, and not force_check.
    #[test]
    fn publish_dataset_upserts_binding() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 2, 0); // A1:A3
        let data = serde_json::json!({"values": [[1.0], [2.0], [3.0]]});
        s.publish_dataset("prices", data, target).unwrap();
        let b = s.binding("prices").expect("publish creates the binding");
        assert_eq!(b.binding_id, "prices");
        assert_eq!(b.target, target);
        assert_eq!(b.direction, BindDirection::Forward);
        assert_eq!(
            b.source_id,
            Some("prices".to_string()),
            "lineage invariant: source_id == name"
        );
        assert_eq!(b.generation, 0);
        assert!(b.alive);
        assert!(!b.force_check);
    }

    /// `bind_range` declares (source_id None); a later `publish` on the same id
    /// links the provenance source WITHOUT downgrading the declared direction, and
    /// keeps generation 0 when the target is unchanged.
    #[test]
    fn bind_range_then_publish_links_source_and_preserves_target() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 1, 0); // A1:A2
        s.bind_range("x", target).unwrap();
        assert_eq!(
            s.binding("x").unwrap().source_id,
            None,
            "a declaration has no source until published"
        );
        let data = serde_json::json!({"values": [[10.0], [20.0]]});
        s.publish_dataset("x", data, target).unwrap();
        let b = s.binding("x").unwrap();
        assert_eq!(b.source_id, Some("x".to_string()), "publish links the source");
        assert_eq!(b.target, target);
        assert_eq!(b.generation, 0, "unchanged target → generation unchanged");
        assert!(b.alive);
    }

    /// Re-publishing the SAME name to a resized target bumps the generation
    /// (carried into the TE2 reverse plane to reject stale-envelope edits).
    #[test]
    fn republish_to_moved_target_bumps_generation() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "x",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 0, 0, 1, 0), // A1:A2
        )
        .unwrap();
        assert_eq!(s.binding("x").unwrap().generation, 0);
        s.publish_dataset(
            "x",
            serde_json::json!({"values": [[1.0]]}),
            rng(sheet, 0, 0, 0, 0), // A1 (shrunk target)
        )
        .unwrap();
        assert_eq!(
            s.binding("x").unwrap().generation,
            1,
            "a moved/resized target bumps the generation"
        );
    }

    /// `bindings()` enumerates every binding; `unbind()` drops one and reports
    /// whether it existed (No-Fallbacks: an unknown id is `false`, not a silent ok).
    #[test]
    fn bindings_enumerate_and_unbind_reports() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "a",
            serde_json::json!({"values": [[1.0]]}),
            rng(sheet, 0, 0, 0, 0),
        )
        .unwrap();
        s.publish_dataset(
            "b",
            serde_json::json!({"values": [[2.0]]}),
            rng(sheet, 1, 0, 1, 0),
        )
        .unwrap();
        let mut ids: Vec<String> = s.bindings().into_iter().map(|x| x.binding_id).collect();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
        assert!(
            s.unbind("a").unwrap(),
            "unbind of an existing binding returns true"
        );
        assert!(s.binding("a").is_none(), "binding is gone after unbind");
        assert!(
            !s.unbind("a").unwrap(),
            "unbind of an unknown id returns false"
        );
        assert_eq!(s.bindings().len(), 1, "only b remains");
    }

    // --- TE1: DEC-B undo reconciliation + D-RANGEMOVE structural invalidation ---

    /// DEC-B: undo wipes the binding's backing provenance but KEEPS the binding
    /// (alive), marking it `force_check` so the next kernel touch re-publishes; a
    /// re-publish self-heals (clears force_check). Never a silent dangling pointer.
    #[test]
    fn undo_keeps_published_binding_and_marks_force_check() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 0, 0);
        s.publish_dataset("x", serde_json::json!({"values": [[5.0]]}), target)
            .unwrap();
        let before = s.binding("x").unwrap();
        assert!(before.alive && !before.force_check);
        assert_eq!(before.source_id, Some("x".to_string()));
        assert!(s.undo().unwrap().consumed);
        let after = s.binding("x").expect("DEC-B: binding is KEPT across undo");
        assert!(
            after.alive,
            "undo is not a structural invalidation — binding stays alive"
        );
        assert!(
            after.force_check,
            "DEC-B: undo wiped provenance → binding flagged force_check"
        );
        assert_eq!(after.target, target, "the declared envelope is unchanged");
        // Re-publish self-heals: the next kernel touch clears force_check.
        s.publish_dataset("x", serde_json::json!({"values": [[7.0]]}), target)
            .unwrap();
        assert!(
            !s.binding("x").unwrap().force_check,
            "re-publish clears force_check"
        );
    }

    /// A bare `bind_range` (no provenance source) is NOT flagged force_check on
    /// undo — it has no data to re-publish.
    #[test]
    fn undo_does_not_force_check_a_bare_bind_range() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 0, 0);
        s.bind_range("b", target).unwrap();
        s.set_value(addr(sheet, 0, 0), num(5.0)).unwrap();
        assert!(s.undo().unwrap().consumed);
        let b = s.binding("b").expect("bare binding survives undo");
        assert!(b.alive && !b.force_check, "no source → no force_check");
        assert_eq!(b.source_id, None);
    }

    /// D-RANGEMOVE (rows): a row insert invalidates only the bindings it
    /// intersects or precedes; a binding entirely above the insert stays alive.
    #[test]
    fn structural_row_insert_invalidates_only_intersecting_bindings() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "before",
            serde_json::json!({"values": [[1.0]]}),
            rng(sheet, 0, 0, 0, 0), // A1 — above the insert
        )
        .unwrap();
        s.publish_dataset(
            "after",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 4, 0, 5, 0), // A5:A6 — at/after the insert
        )
        .unwrap();
        s.insert_rows(sheet, 2, 2).unwrap(); // insert 2 rows at row index 2
        let before = s.binding("before").unwrap();
        assert!(before.alive, "a binding entirely above the insert is unaffected");
        assert!(
            before.force_check,
            "a spared source-backed binding is still force_check'd (provenance was wiped by the rebuild)"
        );
        assert!(
            !s.binding("after").unwrap().alive,
            "a binding at/after the insert is invalidated (anchored, not shifted)"
        );
    }

    /// D-RANGEMOVE (cols): a column delete preceding a binding invalidates it.
    #[test]
    fn structural_col_delete_invalidates_binding() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "c",
            serde_json::json!({"values": [[3.0]]}),
            rng(sheet, 0, 2, 0, 2), // C1
        )
        .unwrap();
        assert!(s.binding("c").unwrap().alive);
        s.delete_columns(sheet, 0, 0).unwrap(); // delete column A (precedes C)
        assert!(
            !s.binding("c").unwrap().alive,
            "a column delete preceding the binding invalidates it"
        );
    }

    /// D-RANGEMOVE (sheet): deleting a sheet invalidates only its bindings;
    /// bindings on other sheets stay alive.
    #[test]
    fn delete_sheet_invalidates_bindings_on_that_sheet() {
        let mut s = WorkbookSession::new();
        let s1 = s.add_sheet("S1", 16384).unwrap();
        let s2 = s.add_sheet("S2", 16384).unwrap();
        s.publish_dataset(
            "on_s1",
            serde_json::json!({"values": [[1.0]]}),
            rng(s1, 0, 0, 0, 0),
        )
        .unwrap();
        s.publish_dataset(
            "on_s2",
            serde_json::json!({"values": [[2.0]]}),
            rng(s2, 0, 0, 0, 0),
        )
        .unwrap();
        s.delete_sheet(s1).unwrap();
        assert!(
            !s.binding("on_s1").unwrap().alive,
            "binding on the deleted sheet is invalidated"
        );
        assert!(
            s.binding("on_s2").unwrap().alive,
            "binding on a surviving sheet stays alive"
        );
    }

    /// TE1 (step 4): `cell_lineage` on a published cell cross-links to its binding
    /// (`binding_id == source_id`, direction Forward).
    #[test]
    fn cell_lineage_links_published_binding() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "x",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 0, 0, 1, 0),
        )
        .unwrap();
        let lin = s
            .cell_lineage(addr(sheet, 0, 0))
            .unwrap()
            .expect("a published cell has lineage");
        assert_eq!(lin.kind, LineageKind::Published);
        assert_eq!(lin.binding_id, Some("x".to_string()));
        assert_eq!(lin.direction, Some(BindDirection::Forward));
    }

    /// TE1 (step 4): `bind_range_with_direction` declares an editable
    /// (Bidirectional) binding; a later publish preserves the direction (the
    /// `None`-preserve path never downgrades it to Forward).
    #[test]
    fn bind_range_with_direction_sets_and_publish_preserves_bidirectional() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 0, 0);
        s.bind_range_with_direction("e", target, Some(BindDirection::Bidirectional))
            .unwrap();
        assert_eq!(
            s.binding("e").unwrap().direction,
            BindDirection::Bidirectional
        );
        s.publish_dataset("e", serde_json::json!({"values": [[9.0]]}), target)
            .unwrap();
        assert_eq!(
            s.binding("e").unwrap().direction,
            BindDirection::Bidirectional,
            "publish preserves the declared Bidirectional direction"
        );
    }

    // --- TE1 audit-fold regressions (Codex BLOCKER/HIGH + lane MEDIUMs) ---

    /// Codex BLOCKER: `bind_range` re-declaring a source-backed binding must NOT
    /// clear DEC-B `force_check` — only a `publish_dataset` (which re-records
    /// provenance) may heal staleness. publish → undo → bind_range(same) keeps the
    /// binding stale until an actual re-publish.
    #[test]
    fn bind_range_after_undo_preserves_force_check() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 1, 0); // A1:A2
        s.publish_dataset("x", serde_json::json!({"values": [[1.0], [2.0]]}), target)
            .unwrap();
        assert!(s.undo().unwrap().consumed);
        assert!(s.binding("x").unwrap().force_check, "undo set force_check");
        // A bare re-declaration of the same region must NOT pretend the binding is
        // fresh — provenance is still gone.
        s.bind_range("x", target).unwrap();
        let b = s.binding("x").unwrap();
        assert!(
            b.force_check,
            "BLOCKER regression: bind_range must not clear undo force_check"
        );
        assert_eq!(b.source_id, Some("x".to_string()), "source link preserved");
        // Only a real re-publish heals it.
        s.publish_dataset("x", serde_json::json!({"values": [[3.0], [4.0]]}), target)
            .unwrap();
        assert!(!s.binding("x").unwrap().force_check, "re-publish heals it");
    }

    /// Codex HIGH: `bind_range` must reject moving a source-backed binding's
    /// envelope away from the cells its source actually produced (lineage-invariant
    /// break) — re-publish is the only way to move a bound dataset.
    #[test]
    fn bind_range_move_off_published_cells_is_rejected() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 1, 0); // A1:A2
        s.publish_dataset("x", serde_json::json!({"values": [[1.0], [2.0]]}), target)
            .unwrap();
        // C1:C2 does not cover A1:A2 (the produced cells) → loud bad_argument.
        let err = s.bind_range("x", rng(sheet, 0, 2, 1, 2)).unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        // The binding is unchanged (still over A1:A2).
        assert_eq!(s.binding("x").unwrap().target, target);
        // A re-declaration that still COVERS the produced cells is allowed (e.g. a
        // larger envelope), and changes direction without moving off the data.
        s.bind_range_with_direction(
            "x",
            rng(sheet, 0, 0, 2, 0), // A1:A3 ⊇ A1:A2
            Some(BindDirection::Bidirectional),
        )
        .unwrap();
        let b = s.binding("x").unwrap();
        assert_eq!(b.direction, BindDirection::Bidirectional);
        assert_eq!(b.source_id, Some("x".to_string()));
    }

    /// Codex HIGH: after `unbind` + bare `bind_range` re-declaration, `cell_lineage`
    /// must NOT relink the old published cells to the now-source-less binding.
    #[test]
    fn cell_lineage_does_not_relink_after_unbind_and_bare_rebind() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "x",
            serde_json::json!({"values": [[1.0]]}),
            rng(sheet, 0, 0, 0, 0),
        )
        .unwrap();
        assert_eq!(
            s.cell_lineage(addr(sheet, 0, 0)).unwrap().unwrap().binding_id,
            Some("x".to_string())
        );
        assert!(s.unbind("x").unwrap());
        // A NEW bare binding reusing the id, on a different region.
        s.bind_range("x", rng(sheet, 0, 2, 0, 2)).unwrap();
        let lin = s.cell_lineage(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(lin.source_id, "x", "the cell is still provenance-owned by x");
        assert_eq!(
            lin.binding_id, None,
            "HIGH regression: a source-less rebind must not relink old cells"
        );
        assert_eq!(lin.direction, None);
    }

    /// Lane A MEDIUM: a structurally-invalidated binding must NOT carry the
    /// contradictory {alive=false, force_check=true} state — a dead binding needs a
    /// re-bind, not a re-publish.
    #[test]
    fn structural_invalidation_clears_force_check() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "y",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 4, 0, 5, 0), // A5:A6
        )
        .unwrap();
        s.insert_rows(sheet, 2, 2).unwrap(); // intersects/precedes → invalidates
        let b = s.binding("y").unwrap();
        assert!(!b.alive, "invalidated");
        assert!(
            !b.force_check,
            "a dead binding must not also be flagged force_check"
        );
    }

    /// Lane C: redo of a publish runs the same DEC-B path as undo — the binding is
    /// kept and re-flagged force_check (provenance is not replayed).
    #[test]
    fn redo_of_publish_marks_force_check() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 0, 0);
        s.publish_dataset("x", serde_json::json!({"values": [[5.0]]}), target)
            .unwrap();
        assert!(s.undo().unwrap().consumed);
        assert!(s.redo().unwrap().consumed);
        let b = s.binding("x").expect("binding kept across redo");
        assert!(b.alive);
        assert!(b.force_check, "redo's rematerialize re-flags force_check");
    }

    /// Redo correctness: a structural edit that SPARES a binding (entirely before it)
    /// leaves it alive through undo→redo. (Contrast
    /// `redo_of_structural_edit_invalidates_a_binding_declared_while_pending`, which
    /// exercises the case where a redone edit DOES shift a binding — reachable because
    /// `bind_range` is session-local and does NOT clear the redo stack.)
    #[test]
    fn redo_of_structural_edit_keeps_spared_binding_alive() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "z",
            serde_json::json!({"values": [[1.0]]}),
            rng(sheet, 0, 0, 0, 0), // A1 — above the edit
        )
        .unwrap();
        s.insert_rows(sheet, 5, 1).unwrap(); // at row 5, spares A1
        assert!(s.binding("z").unwrap().alive, "spared by the insert");
        assert!(s.undo().unwrap().consumed);
        assert!(s.redo().unwrap().consumed);
        assert!(
            s.binding("z").unwrap().alive,
            "still spared after undo→redo of the structural edit"
        );
    }

    /// Lane C: the row-DELETE structural path invalidates a binding it precedes.
    #[test]
    fn structural_row_delete_invalidates_binding() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "d",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 2, 0, 3, 0), // A3:A4
        )
        .unwrap();
        s.delete_rows(sheet, 0, 0).unwrap(); // delete row 0 (precedes)
        assert!(!s.binding("d").unwrap().alive);
    }

    /// Lane C: the column-INSERT structural path invalidates a binding it precedes.
    #[test]
    fn structural_col_insert_invalidates_binding() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "ci",
            serde_json::json!({"values": [[3.0]]}),
            rng(sheet, 0, 2, 0, 2), // C1
        )
        .unwrap();
        s.insert_columns(sheet, 0, 1).unwrap(); // insert at col 0 (precedes C)
        assert!(!s.binding("ci").unwrap().alive);
    }

    /// Lane C: publish → unbind → republish is a FRESH binding (generation 0), not
    /// a rebind off the dropped one.
    #[test]
    fn publish_unbind_republish_is_fresh_generation() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let target = rng(sheet, 0, 0, 0, 0);
        s.publish_dataset("u", serde_json::json!({"values": [[1.0]]}), target)
            .unwrap();
        assert!(s.unbind("u").unwrap());
        assert!(s.binding("u").is_none());
        s.publish_dataset("u", serde_json::json!({"values": [[2.0]]}), target)
            .unwrap();
        assert_eq!(
            s.binding("u").unwrap().generation,
            0,
            "a republish after unbind starts a fresh binding"
        );
    }

    /// Lane C: a structurally-invalidated binding is READABLE as `Some{alive:false}`
    /// — never elided to `None` (No-Fallbacks: distinguish never-bound from
    /// bound-then-invalidated).
    #[test]
    fn dead_binding_is_readable_not_none() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "x",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 0, 0, 1, 0), // A1:A2
        )
        .unwrap();
        s.insert_rows(sheet, 0, 1).unwrap(); // at row 0, intersects
        let b = s.binding("x");
        assert!(b.is_some(), "dead binding is not elided to None");
        assert!(!b.unwrap().alive);
    }

    // --- TE1 audit-fold round 2 (Codex/Sonnet re-audit) ---

    /// Round-2 (Codex MED / Sonnet HIGH): a binding invalidated by a structural
    /// edit must STAY {alive=false, force_check=false} across a later undo/redo —
    /// `rematerialize`'s DEC-B pass must NOT resurrect `force_check` on a dead
    /// binding (it gates on `&& binding.alive`).
    #[test]
    fn dead_binding_stays_force_check_clear_across_undo_redo() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.publish_dataset(
            "y",
            serde_json::json!({"values": [[1.0], [2.0]]}),
            rng(sheet, 4, 0, 5, 0),
        )
        .unwrap();
        s.insert_rows(sheet, 2, 2).unwrap();
        let b = s.binding("y").unwrap();
        assert!(!b.alive && !b.force_check, "invalidated: dead + clear");
        assert!(s.undo().unwrap().consumed);
        let b = s.binding("y").unwrap();
        assert!(
            !b.alive && !b.force_check,
            "undo must not resurrect force_check on a dead binding"
        );
        assert!(s.redo().unwrap().consumed);
        let b = s.binding("y").unwrap();
        assert!(
            !b.alive && !b.force_check,
            "redo must not resurrect force_check on a dead binding"
        );
    }

    /// Round-2 (Sonnet MED): after a sheet delete invalidates a binding,
    /// re-declaring that id on a SURVIVING sheet is a FRESH bind — not a misleading
    /// `bad_argument` about the dead source's cells on the now-deleted sheet.
    #[test]
    fn bind_range_after_sheet_delete_is_fresh_not_rejected() {
        let mut s = WorkbookSession::new();
        let s1 = s.add_sheet("S1", 16384).unwrap();
        let s2 = s.add_sheet("S2", 16384).unwrap();
        s.publish_dataset(
            "x",
            serde_json::json!({"values": [[1.0]]}),
            rng(s1, 0, 0, 0, 0),
        )
        .unwrap();
        s.delete_sheet(s1).unwrap();
        assert!(!s.binding("x").unwrap().alive, "binding on deleted sheet is dead");
        // Re-declaring on the surviving sheet succeeds as a fresh bare binding.
        s.bind_range("x", rng(s2, 0, 0, 0, 0)).unwrap();
        let b = s.binding("x").unwrap();
        assert!(b.alive, "re-declaration revives a fresh binding");
        assert_eq!(b.source_id, None, "the stale source link is dropped (fresh bind)");
        assert_eq!(b.target.sheet, s2);
    }

    /// **TE1 HIGH-1 (w135) — FIXED (was the Codex round-2 `#[ignore]` gap).** A
    /// bare `bind_range` binding declared while a structural REDO is pending must be
    /// invalidated when the redo re-applies the shift. `bind_range` is session-local
    /// (it does NOT clear the redo stack), so the insert is re-applied AFTER the
    /// binding exists, shifting its target out from under it. The redo path replays
    /// the op-log via `rematerialize` rather than `apply_structural_edit`, so the
    /// fix lives in `rematerialize`: it recomputes the net-active structural-edit set
    /// from the current op-log and re-runs D-RANGEMOVE invalidation for every edit
    /// that just became active (here, the redone insert). This needs NEITHER a
    /// VersionVector (the op-log VV is monotonic across undo/redo — it cannot tell an
    /// undone edit from a live one) NOR recovery of "lowered" structural intent (the
    /// op-log retains the distinguishable `Op::InsertRows`/etc. variant verbatim).
    #[test]
    fn redo_of_structural_edit_invalidates_a_binding_declared_while_pending() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.insert_rows(sheet, 2, 1).unwrap();
        assert!(s.undo().unwrap().consumed); // structural redo pending
        s.bind_range("b", rng(sheet, 4, 0, 4, 0)).unwrap(); // session-local: redo NOT cleared
        assert!(s.binding("b").unwrap().alive, "fresh declaration is live");
        assert!(s.redo().unwrap().consumed); // re-applies insert at 2, shifts row 4
        assert!(
            !s.binding("b").unwrap().alive,
            "the redone insert at row 2 shifts the row-4 target → binding is invalidated"
        );
        // D-RANGEMOVE clears force_check on a dead binding (needs a re-bind, not a
        // re-publish) — never the contradictory {alive=false, force_check=true}.
        assert!(!s.binding("b").unwrap().force_check);
    }

    /// **TE1 HIGH-1 (w135):** the redo invalidation respects the SAME anchored
    /// predicate as the forward path — a redone edit that does NOT intersect/precede
    /// the binding's target must leave it `alive` (no blanket kill on redo).
    #[test]
    fn redo_of_non_intersecting_structural_edit_keeps_binding_alive() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.insert_rows(sheet, 10, 1).unwrap(); // insert BELOW the binding's row
        assert!(s.undo().unwrap().consumed);
        s.bind_range("b", rng(sheet, 4, 0, 4, 0)).unwrap();
        assert!(s.redo().unwrap().consumed); // re-applies insert at row 10
        assert!(
            s.binding("b").unwrap().alive,
            "an insert entirely below the row-4 target does not affect it"
        );
    }

    /// **TE1 HIGH-1 (w135):** column-axis coverage — a redone `insert_columns`
    /// intersecting/preceding a binding's target column invalidates it.
    #[test]
    fn redo_of_column_insert_invalidates_intersecting_binding() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.insert_columns(sheet, 1, 1).unwrap();
        assert!(s.undo().unwrap().consumed);
        s.bind_range("b", rng(sheet, 0, 3, 0, 3)).unwrap(); // target at column 3
        assert!(s.redo().unwrap().consumed); // re-applies insert at column 1
        assert!(
            !s.binding("b").unwrap().alive,
            "the redone column insert at col 1 shifts the col-3 target → invalidated"
        );
    }

    /// **TE1 HIGH-1 (w135) — BINDING-RELATIVE invalidation (Codex round-2 followup).**
    /// A binding declared while a structural edit is ALREADY active is anchored to the
    /// POST-edit grid (that edit is in its BIRTH set). Undo removes the edit (DEC-B
    /// keeps the bare binding alive), and a REDO RESTORES the exact birth grid — so the
    /// binding must stay `alive`. A naive session-global active-set diff wrongly killed
    /// it on the redo (the edit looked "newly active" globally); the per-binding birth
    /// comparison makes the redo a correct no-op.
    #[test]
    fn redo_restoring_a_bindings_birth_grid_keeps_it_alive() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.insert_rows(sheet, 2, 1).unwrap(); // edit active
        s.bind_range("b", rng(sheet, 4, 0, 4, 0)).unwrap(); // declared UNDER the active insert
        assert!(s.binding("b").unwrap().alive);
        assert!(s.undo().unwrap().consumed); // remove insert (DEC-B: keep the bare binding)
        assert!(
            s.binding("b").unwrap().alive,
            "undo keeps a bare binding alive (DEC-B); only becomes-active edits invalidate"
        );
        assert!(s.redo().unwrap().consumed); // RESTORE the binding's birth grid
        assert!(
            s.binding("b").unwrap().alive,
            "redo restores the exact grid the binding was declared under → not a false invalidation"
        );
    }

    /// **TE1 HIGH-1 (w135):** birth-relative invalidation still fires for a GENUINELY
    /// new intersecting edit even when the binding's birth set is non-empty (a prior
    /// non-intersecting edit was active at declaration).
    #[test]
    fn new_intersecting_edit_invalidates_a_binding_with_a_nonempty_birth_set() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.insert_rows(sheet, 10, 1).unwrap(); // active, below the binding
        s.bind_range("b", rng(sheet, 4, 0, 4, 0)).unwrap(); // birth = [insert@10]; alive
        assert!(s.binding("b").unwrap().alive);
        s.insert_rows(sheet, 2, 1).unwrap(); // NEW edit intersecting row 4
        assert!(
            !s.binding("b").unwrap().alive,
            "a new intersecting edit invalidates even when the birth set is non-empty"
        );
    }

    /// **TE1 HIGH-1 (w135) — sheet-delete REDO gap (Codex round-2 followup).** A redo
    /// of `Op::RemoveSheet` routes only through `rematerialize`, not the forward
    /// `delete_sheet` path, so the sheet-liveness check (not the row/col scan) must
    /// catch a binding left on the re-tombstoned sheet — never report it stale-alive.
    #[test]
    fn redo_of_sheet_delete_invalidates_binding_on_the_tombstoned_sheet() {
        let mut s = WorkbookSession::new();
        let _s1 = s.add_sheet("S1", 16384).unwrap();
        let s2 = s.add_sheet("S2", 16384).unwrap();
        s.delete_sheet(s2).unwrap();
        assert!(s.undo().unwrap().consumed); // s2 restored, redo pending
        s.bind_range("b", rng(s2, 0, 0, 0, 0)).unwrap(); // declared on the restored sheet
        assert!(s.binding("b").unwrap().alive);
        assert!(s.redo().unwrap().consumed); // re-tombstone s2
        assert!(
            !s.binding("b").unwrap().alive,
            "a binding on a redo-tombstoned sheet must not stay stale-live"
        );
    }

    /// **TE1 HIGH-1 (w135) — forward backstop is load-bearing (Codex re-audit nuance).**
    /// A NEW forward edit value-equal to a binding's BIRTH edit is masked by the
    /// birth-relative `rematerialize` pass (the multiset diff matches it by value), but
    /// the forward `invalidate_bindings_for_structural_edit` backstop kills the binding
    /// — a genuinely new shift must invalidate (contrast `redo_restoring_a_bindings_birth_grid_keeps_it_alive`,
    /// where a REDO restores the birth grid and the binding is correctly spared). This
    /// locks the forward call as load-bearing (do not delete it as "redundant").
    #[test]
    fn forward_value_equal_replacement_edit_invalidates_via_the_backstop() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.insert_rows(sheet, 2, 1).unwrap(); // edit active; birth of "b" will be [insert@2]
        s.bind_range("b", rng(sheet, 4, 0, 4, 0)).unwrap();
        assert!(s.undo().unwrap().consumed); // remove the insert (b kept alive, DEC-B)
        assert!(s.binding("b").unwrap().alive);
        s.insert_rows(sheet, 2, 1).unwrap(); // NEW forward insert@2 (value-equal to birth; clears redo)
        assert!(
            !s.binding("b").unwrap().alive,
            "a NEW forward edit value-equal to the birth edit still invalidates (forward backstop)"
        );
    }

    // --- 6.4-2: register_function / unregister_function / list_functions ---

    /// Build a UDF metadata stub for tests. Defaults to `Volatility::Volatile +
    /// ArgContext::Aggregate + BatchShape::ArrayBatch` because that's the shape
    /// the 6.4-3 Python UDF flow actually uses (so the test fixtures exercise
    /// the wedge configuration); individual tests override fields as needed.
    /// **6.4B (item H):** with the op-level UDF budget exhausted (set to ZERO), a
    /// recalc pass SKIPS every UDF dispatch — the worker is NOT called — bounding
    /// the recalc instead of blocking N × the per-call deadline. With a normal
    /// budget the same recalc DOES dispatch. Proven via an invocation counter.
    #[test]
    fn udf_op_budget_zero_skips_dispatch_in_recalc() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_w = Arc::clone(&calls);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            move |_h, _a: &ql_types::ArrayValue| {
                calls_w.fetch_add(1, Ordering::SeqCst);
                Ok(ql_types::ArrayValue::singleton(Value::Number(42.0)))
            },
        )));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        // set_formula evaluated B1 once (a single edit carries no op budget).
        let after_set = calls.load(Ordering::SeqCst);
        assert!(after_set >= 1, "set_formula computed the cell once");

        // Exhaust the op budget, then recalc -> every UDF dispatch is SKIPPED.
        s.set_udf_op_budget(std::time::Duration::ZERO);
        s.recalc_all().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            after_set,
            "op budget exhausted -> the worker is NOT called during recalc"
        );
        // The cell holds the budget-exhausted #TIMEOUT! value.
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#TIMEOUT!"),
            "budget-exhausted UDF cell is #TIMEOUT!"
        );

        // Restore a normal budget -> the same recalc now DOES dispatch.
        s.set_udf_op_budget(std::time::Duration::from_secs(120));
        s.recalc_all().unwrap();
        assert!(
            calls.load(Ordering::SeqCst) > after_set,
            "with budget restored the recalc dispatches the UDF again"
        );
    }

    /// **6.4B closure-audit (MED):** the op-budget is also armed on the
    /// `rematerialize` pass behind undo/redo (not only the explicit `recalc_*`) —
    /// with the budget exhausted, an undo (which replays + recomputes a full pass)
    /// SKIPS the UDF dispatch instead of blocking N × the per-call deadline.
    #[test]
    fn udf_op_budget_arms_on_undo_redo_rematerialize() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_w = Arc::clone(&calls);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            move |_h, _a: &ql_types::ArrayValue| {
                calls_w.fetch_add(1, Ordering::SeqCst);
                Ok(ql_types::ArrayValue::singleton(Value::Number(42.0)))
            },
        )));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        // A further edit to undo back across (the UDF cell is recomputed every
        // rematerialize regardless — recompute_all is a full pass).
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 1.0 })
            .unwrap();

        // Exhaust the budget, then undo -> rematerialize SKIPS the UDF dispatch.
        s.set_udf_op_budget(std::time::Duration::ZERO);
        let before = calls.load(Ordering::SeqCst);
        s.undo().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            before,
            "op budget exhausted -> the worker is NOT called during undo's rematerialize"
        );
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#TIMEOUT!"),
            "budget-exhausted UDF cell is #TIMEOUT! after undo"
        );

        // Restore a normal budget, then redo -> rematerialize dispatches the UDF.
        s.set_udf_op_budget(std::time::Duration::from_secs(120));
        let before2 = calls.load(Ordering::SeqCst);
        s.redo().unwrap();
        assert!(
            calls.load(Ordering::SeqCst) > before2,
            "with budget restored, redo's rematerialize dispatches the UDF again"
        );
    }

    fn udf_meta(canonical_name: &str) -> FunctionMetadata {
        use ql_session::function_meta::{
            ArgContext, ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, Volatility,
        };
        FunctionMetadata {
            canonical_name: canonical_name.to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Volatile,
            determinism: false,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Strict,
            cancellation: CancelPolicy::WorkerKill,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec!["python".to_string()],
        }
    }

    /// **6.4-2 (2026-05-28):** the happy path — register a UDF, then
    /// `list_functions` includes it; unregister it, then `list_functions`
    /// excludes it. Verifies the trait wiring through the
    /// substrate-completion seam (`sorted_metadata` view).
    #[test]
    fn register_function_succeeds_and_list_functions_includes_then_excludes_it() {
        let mut s = WorkbookSession::new();
        let initial_count = s.list_functions().unwrap().len();
        assert!(
            initial_count > 200,
            "fresh session must hold the built-ins (~260)"
        );

        s.register_function(udf_meta("MYUDF"), FunctionImplHandle(0xABCD))
            .expect("register_function clean");
        let after_register = s.list_functions().unwrap();
        assert_eq!(after_register.len(), initial_count + 1);
        let myudf = after_register
            .iter()
            .find(|m| m.canonical_name == "MYUDF")
            .expect("MYUDF must appear in list_functions");
        // Metadata faithful end-to-end.
        assert_eq!(
            myudf.volatility,
            ql_session::function_meta::Volatility::Volatile
        );
        assert_eq!(
            myudf.batch_shape,
            ql_session::function_meta::BatchShape::ArrayBatch
        );
        assert_eq!(
            myudf.arg_context,
            ql_session::function_meta::ArgContext::Aggregate
        );
        assert_eq!(myudf.provenance_tags, vec!["python".to_string()]);

        s.unregister_function("MYUDF").expect("unregister clean");
        let after_unregister = s.list_functions().unwrap();
        assert_eq!(after_unregister.len(), initial_count);
        assert!(
            !after_unregister.iter().any(|m| m.canonical_name == "MYUDF"),
            "MYUDF must NOT appear in list_functions after unregister"
        );
    }

    /// **6.4-2 (2026-05-28):** duplicate UDF registration surfaces
    /// `Conflict / function_exists` per Appendix A. The mapper at
    /// `map_function_registry_err` is now wired (the `#[allow(dead_code)]`
    /// was removed in 6.4-2).
    #[test]
    fn register_function_duplicate_returns_conflict_function_exists() {
        let mut s = WorkbookSession::new();
        s.register_function(udf_meta("MYUDF"), FunctionImplHandle(1))
            .unwrap();
        let err = s
            .register_function(udf_meta("MYUDF"), FunctionImplHandle(2))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "function_exists");
        // **6.4-2 cycle-2 audit-fix (M3/F6):** the Conflict short-circuited
        // BEFORE the `udf_handles.insert`, so the ORIGINAL handle (1) is still
        // the one the registry holds. `list_functions` exposes only metadata
        // (not handles), so assert the handle directly through the session's
        // registry (test-internal field access) rather than overclaiming via a
        // metadata-count check.
        assert_eq!(
            s.registry.udf_handle("MYUDF"),
            Some(FunctionImplHandle(1)),
            "rejected duplicate must NOT overwrite the original handle (1)"
        );
        // Unregister (clears metadata + handle), then re-register with a
        // DIFFERENT handle (2) and prove (2) actually lands.
        s.unregister_function("MYUDF").unwrap();
        assert_eq!(
            s.registry.udf_handle("MYUDF"),
            None,
            "unregister_function clears the handle symmetrically"
        );
        s.register_function(udf_meta("MYUDF"), FunctionImplHandle(2))
            .unwrap();
        assert_eq!(
            s.registry.udf_handle("MYUDF"),
            Some(FunctionImplHandle(2)),
            "re-register lands the NEW handle (2)"
        );
        // Final state has exactly one MYUDF (re-registered).
        assert_eq!(
            s.list_functions()
                .unwrap()
                .iter()
                .filter(|m| m.canonical_name == "MYUDF")
                .count(),
            1
        );
    }

    /// **6.4-2 (2026-05-28):** registering against a built-in name
    /// (which holds metadata via the boot-time `register_builtin_metadata`
    /// pass) ALSO returns `Conflict / function_exists`. The mapper
    /// translates the registry-level `Conflict` regardless of whether
    /// the conflict is with another UDF or with a built-in's metadata —
    /// both are user-visible as "function_exists" per contract §10.3.
    #[test]
    fn register_function_against_builtin_returns_conflict() {
        let mut s = WorkbookSession::new();
        let err = s
            .register_function(udf_meta("SUM"), FunctionImplHandle(99))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "function_exists");
        // SUM's built-in metadata is untouched.
        let sum = s
            .list_functions()
            .unwrap()
            .into_iter()
            .find(|m| m.canonical_name == "SUM")
            .expect("SUM must still appear after rejected register");
        // Built-in SUM is Pure, NOT Volatile (our udf_meta stub).
        assert_eq!(sum.volatility, ql_session::function_meta::Volatility::Pure);
    }

    /// **6.4-2 (2026-05-28):** unregistering an unknown name returns
    /// `NotFound / function_not_found` — never a silent no-op (the
    /// substrate's fail-loud rule per Appendix A).
    #[test]
    fn unregister_function_returns_not_found_for_unknown_name() {
        let mut s = WorkbookSession::new();
        let err = s.unregister_function("DOES_NOT_EXIST").unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "function_not_found");
    }

    /// **6.4-2 (2026-05-28):** unregistering a built-in name returns
    /// `Conflict / function_exists` via the registry's builtin-guard
    /// (6.4-0 audit-fix Codex A LOW). The mapper translates `Conflict`
    /// to `function_exists` regardless of the underlying reason; the
    /// message disambiguates ("registered built-in (dispatch entry
    /// present)").
    #[test]
    fn unregister_function_against_builtin_returns_conflict() {
        let mut s = WorkbookSession::new();
        let err = s.unregister_function("SUM").unwrap_err();
        assert_eq!(err.class, ErrorClass::Conflict);
        assert_eq!(err.code, "function_exists");
        assert!(
            err.message.contains("built-in") || err.message.contains("dispatch"),
            "builtin-guard message must explain why: got {:?}",
            err.message
        );
        // SUM stays in the list.
        assert!(s
            .list_functions()
            .unwrap()
            .iter()
            .any(|m| m.canonical_name == "SUM"));
    }

    /// **6.4-2 (2026-05-28):** `list_functions` returns sorted metadata
    /// (M3 from 6.4-1's `sorted_metadata` view) — deterministic order
    /// across consecutive calls + ascending `canonical_name`. Matches
    /// the 6.1C H2 ordering discipline for snapshot DTOs.
    #[test]
    fn list_functions_is_call_stable_and_ascending() {
        let s = WorkbookSession::new();
        let first = s.list_functions().unwrap();
        let second = s.list_functions().unwrap();
        // Call-stable.
        assert_eq!(first.len(), second.len());
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!(a.canonical_name, b.canonical_name);
        }
        // Strictly ascending.
        for w in first.windows(2) {
            assert!(
                w[0].canonical_name < w[1].canonical_name,
                "list_functions violated ordering at {:?} -> {:?}",
                w[0].canonical_name,
                w[1].canonical_name
            );
        }
    }

    /// **6.4-2 (2026-05-28):** the H3 wire test — a formula that bound
    /// while MYUDF was unknown becomes dirty when MYUDF is registered;
    /// `recalc_dirty` re-evaluates it.
    ///
    /// **6.4-3c (2026-05-29) update:** pre-registration the formula evaluates
    /// to `#NAME?` (unknown function); post-registration (with NO worker
    /// configured) it now evaluates to `#CALC!` — the dispatch arm finds the
    /// UDF via `registry.udf_handle` but there's no worker to call, so it
    /// returns a deterministic `#CALC!` (No-Fallbacks-honest). The `#NAME?` →
    /// `#CALC!` VALUE TRANSITION is now an even stronger proof that the dirty
    /// fanout fired AND the recalc actually re-dispatched (a no-op recalc would
    /// have left `#NAME?`). The with-a-worker computes-to-a-value path is
    /// `udf_scalar_computes_with_mock_worker` below.
    #[test]
    fn register_function_dirties_dependent_formulas() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 42.0 })
            .unwrap();
        // Bind a formula referencing MYUDF while it's unknown → evaluates to
        // #NAME? (scalar.rs:463 returns ErrorValue::Name for missing dispatch).
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        let b1_before = s.cell(addr(sheet, 0, 1)).unwrap().unwrap();
        assert!(
            matches!(&b1_before.value, Some(CellValue::Error { error }) if error == "#NAME?"),
            "MYUDF(A1) bound while unknown must evaluate to #NAME? (got {:?})",
            b1_before.value
        );

        // **6.4-2 cycle-2 audit-fix (M1/F5 + L1):** capture observable state
        // BEFORE registration so the dirty fanout + fn_gen bump are PROVEN, not
        // merely implied by an unchanged #NAME? value. A no-op recalc would
        // leave the value identical and still report `Completed`, so the old
        // "#NAME? before AND after" assertions proved nothing about the wire.
        // B1 is clean here (its `set_formula` already evaluated it).
        let gen_before = s.registry.fn_generation();
        let dirty_before = s.graph.dirty_formulas().len();

        // Register MYUDF. Dirty fanout fires; fn_gen bumps → bind cache miss.
        s.register_function(udf_meta("MYUDF"), FunctionImplHandle(1))
            .expect("register_function clean");

        // PROOF (a): the registry mutation wired through the trait — fn_gen
        // bumped exactly once (the H3 cache-invalidation half; also closes L1,
        // since no trait-level fn_gen-bump test existed before).
        assert_eq!(
            s.registry.fn_generation(),
            gen_before + 1,
            "register_function MUST bump fn_gen exactly once through the trait (H3 wire)"
        );
        // PROOF (b): the dirty fanout fired — the formula naming MYUDF was
        // dirtied by `on_function_registered`. Without the hook this set is
        // unchanged. (The unit-level count==1 proof lives in calcgraph_session;
        // this pins the END-TO-END trait wire.)
        let dirty_after_register = s.graph.dirty_formulas().len();
        assert!(
            dirty_after_register > dirty_before,
            "register_function MUST dirty the formula(s) referencing MYUDF (the fanout); \
             dirty set went {dirty_before} -> {dirty_after_register}"
        );

        // recalc_dirty re-evaluates — B1 was dirtied by the substrate hook.
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);

        // Post-recalc: B1 transitions #NAME? → #CALC! (6.4-3c). The dispatch
        // arm now resolves MYUDF via `registry.udf_handle`, but no worker is
        // configured on this session, so it returns a deterministic #CALC!
        // (NOT a panic, NOT a silent no-op). The VALUE CHANGE proves the dirty
        // fanout fired AND the recalc re-dispatched through the new metadata.
        let b1_after = s.cell(addr(sheet, 0, 1)).unwrap().unwrap();
        assert!(
            matches!(&b1_after.value, Some(CellValue::Error { error }) if error == "#CALC!"),
            "post-register (no worker): registered UDF dispatches to #CALC! (got {:?})",
            b1_after.value
        );
    }

    // ===== 6.4-3c — UDF eval dispatch (MockWorker, no Python) =====

    /// Small helper: read a cell's `CellValue` (panics if the cell is absent).
    fn cell_value(s: &WorkbookSession, a: CellAddr) -> CellValue {
        s.cell(a)
            .unwrap()
            .unwrap_or_else(|| panic!("cell {a:?} must exist"))
            .value
            .unwrap_or_else(|| panic!("cell {a:?} must have a committed value"))
    }

    /// Register `name` as an Aggregate-context Python UDF under `handle`.
    fn register_udf(s: &mut WorkbookSession, name: &str, handle: u64) {
        s.register_function(udf_meta(name), FunctionImplHandle(handle))
            .expect("register_function clean");
    }

    /// **6.4-3d (blocker C1):** register `name` as a Reference-context,
    /// NON-volatile (`Pure`) Python UDF — so a literal multi-cell range arg
    /// (`=MYUDF(A1:A2)`) binds as a `RangeRef` and re-evaluation is driven ONLY
    /// by the literal-range dependency, NOT by volatility (a `Volatile` UDF
    /// would always re-eval and mask whether the dep is actually tracked).
    fn register_udf_reference(s: &mut WorkbookSession, name: &str, handle: u64) {
        use ql_session::function_meta::{ArgContext, Volatility};
        let mut meta = udf_meta(name);
        meta.arg_context = ArgContext::Reference;
        meta.volatility = Volatility::Pure;
        meta.determinism = true;
        s.register_function(meta, FunctionImplHandle(handle))
            .expect("register_function clean");
    }

    /// **6.4-3d (megaudit blocker G):** a registered UDF with NO worker yields
    /// `#CALC!` AND a structured `udf_no_worker` `CellDiagnostic` (value
    /// unchanged; the diagnostic explains WHY — exit test 7).
    #[test]
    fn udf_no_worker_emits_diagnostic() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        // No worker configured → dispatch yields #CALC! AND a diagnostic.
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "no-worker UDF cell value is #CALC!"
        );
        let page = s.poll_events(EventCursor(0)).unwrap();
        assert!(
            page.events.iter().any(|e| matches!(
                e,
                Event::CellDiagnostic { diagnostic }
                    if diagnostic.code == "udf_no_worker"
                        && diagnostic.addr == Some(addr(sheet, 0, 1))
            )),
            "set_formula with no worker must emit a udf_no_worker CellDiagnostic"
        );
    }

    /// **6.4-3d (megaudit blocker G):** a UDF that RAISES yields `#CALC!` AND a
    /// `udf_raised` `CellDiagnostic` carrying `"{exc_type}: {message}"`.
    #[test]
    fn udf_raised_emits_diagnostic_with_exc_type() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Err(ql_udf::UdfError::Raised {
                exc_type: "ValueError".into(),
                message: "boom".into(),
            })
        })));
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        // Value mapping unchanged: a raise → #CALC! (additive diagnostic).
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "raised UDF cell value is #CALC!"
        );
        let page = s.poll_events(EventCursor(0)).unwrap();
        assert!(
            page.events.iter().any(|e| matches!(
                e,
                Event::CellDiagnostic { diagnostic }
                    if diagnostic.code == "udf_raised" && diagnostic.message == "ValueError: boom"
            )),
            "a raised UDF must emit a udf_raised diagnostic carrying exc_type: message"
        );
    }

    /// **6.4-3d (megaudit blocker C1):** a literal multi-cell range arg of a
    /// Reference-context UDF (`=MYSUM(A1:A2)`) is dep-tracked — editing a cell
    /// INSIDE the range re-evaluates the UDF. Pre-6.4-3d the range recorded no
    /// dep and the UDF went silently stale. The UDF is `Pure` (non-volatile) so
    /// the re-eval is driven solely by the literal-range dependency.
    #[test]
    fn udf_literal_multicell_range_arg_tracks_edits() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf_reference(&mut s, "MYSUM", 7);
        // Worker sums every value in the grid it receives.
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            |_h, args: &ql_types::ArrayValue| {
                let mut total = 0.0;
                for r in 0..args.rows() {
                    for c in 0..args.cols() {
                        if let Some(Value::Number(n)) = args.get(r, c) {
                            total += *n;
                        }
                    }
                }
                Ok(ql_types::ArrayValue::singleton(Value::Number(total)))
            },
        )));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap(); // A1
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 2.0 })
            .unwrap(); // A2
        s.set_formula(addr(sheet, 0, 1), "MYSUM(A1:A2)").unwrap(); // B1 = 1+2 = 3
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 3.0 }
        );
        // Edit A2 INSIDE the literal range → the UDF must re-evaluate.
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 5.0 })
            .unwrap(); // A2 = 5
        s.recalc_dirty().unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 6.0 },
            "editing A2 inside MYSUM(A1:A2) must re-evaluate the UDF (literal-range dep tracked)"
        );
    }

    /// **6.4-3d (megaudit blocker D):** open/load is non-destructive for saved
    /// UDF values. D2: opening with NO worker PRESERVES the saved value instead
    /// of recomputing it to `#CALC!` (and a dependent stays correct). D1: a
    /// worker present BEFORE open is preserved across the wholesale `*self = ..`
    /// swap, so open's recompute uses it.
    #[test]
    fn open_preserves_saved_udf_value_and_preserves_worker() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("udf.qbook");
        let path_str = path.to_str().unwrap();

        // Author with a DOUBLING worker: A1=21, B1=MYUDF(A1)=42, C1=B1+1=43.
        let sheet;
        {
            let mut s = WorkbookSession::new();
            sheet = s.add_sheet("S", 16384).unwrap();
            register_udf(&mut s, "MYUDF", 7);
            s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
                |_h, args: &ql_types::ArrayValue| {
                    let n = match args.get(0, 0) {
                        Some(Value::Number(x)) => *x,
                        o => panic!("expected number, got {o:?}"),
                    };
                    Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
                },
            )));
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
                .unwrap();
            s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // B1 = 42
            s.set_formula(addr(sheet, 0, 2), "B1+1").unwrap(); // C1 = 43
            assert_eq!(
                cell_value(&s, addr(sheet, 0, 1)),
                CellValue::Number { number: 42.0 }
            );
            assert_eq!(
                cell_value(&s, addr(sheet, 0, 2)),
                CellValue::Number { number: 43.0 }
            );
            s.save(path_str).unwrap();
        }

        // (D2) Open with NO worker → saved values PRESERVED, not destroyed.
        {
            let mut s2 = WorkbookSession::new();
            register_udf(&mut s2, "MYUDF", 7); // registry is session tooling, re-registered
            s2.open(path_str).unwrap();
            assert_eq!(
                cell_value(&s2, addr(sheet, 0, 1)),
                CellValue::Number { number: 42.0 },
                "D2: open with no worker must PRESERVE the saved UDF value, not destroy it to #CALC!"
            );
            assert_eq!(
                cell_value(&s2, addr(sheet, 0, 2)),
                CellValue::Number { number: 43.0 },
                "D2: a dependent of a preserved UDF cell stays correct"
            );
        }

        // (D1) Open in a session that HAS a TRIPLING worker → the worker is
        // preserved across the swap, so open's recompute uses it: 21*3 = 63.
        {
            let mut s3 = WorkbookSession::new();
            register_udf(&mut s3, "MYUDF", 7);
            s3.set_udf_worker(Box::new(ql_udf::MockWorker::new(
                |_h, args: &ql_types::ArrayValue| {
                    let n = match args.get(0, 0) {
                        Some(Value::Number(x)) => *x,
                        o => panic!("expected number, got {o:?}"),
                    };
                    Ok(ql_types::ArrayValue::singleton(Value::Number(n * 3.0)))
                },
            )));
            s3.open(path_str).unwrap();
            assert_eq!(
                cell_value(&s3, addr(sheet, 0, 1)),
                CellValue::Number { number: 63.0 },
                "D1: a worker present before open is preserved across the swap; open's recompute uses it (21*3=63)"
            );
        }
    }

    /// **6.4-3d audit-fix HIGH-1:** the D2 preserve is LOAD-ONLY. A user
    /// `recalc_all` on a no-worker session must NOT keep the stale saved UDF
    /// value — it must recompute honestly to `#CALC!`. (Pre-fix `recompute_all`
    /// hardcoded preserve=true, so recalc_all wrongly kept the stale value.)
    #[test]
    fn recalc_all_does_not_preserve_stale_udf_value_without_worker() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("udf2.qbook");
        let path_str = path.to_str().unwrap();
        let sheet;
        {
            let mut s = WorkbookSession::new();
            sheet = s.add_sheet("S", 16384).unwrap();
            register_udf(&mut s, "MYUDF", 7);
            s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
                |_h, a: &ql_types::ArrayValue| {
                    let n = match a.get(0, 0) {
                        Some(Value::Number(x)) => *x,
                        o => panic!("{o:?}"),
                    };
                    Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
                },
            )));
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
                .unwrap();
            s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // 42
            s.save(path_str).unwrap();
        }
        let mut s2 = WorkbookSession::new();
        register_udf(&mut s2, "MYUDF", 7);
        s2.open(path_str).unwrap();
        // LOAD preserved the saved value (D2).
        assert_eq!(
            cell_value(&s2, addr(sheet, 0, 1)),
            CellValue::Number { number: 42.0 }
        );
        // But an explicit recalc with no worker must recompute → #CALC! (honest),
        // NOT keep the stale 42.
        s2.recalc_all().unwrap();
        assert!(
            matches!(cell_value(&s2, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "recalc_all with no worker must recompute a UDF cell to #CALC!, not preserve the stale value"
        );
    }

    /// **6.4-3d audit-fix HIGH-1 (the catastrophic one):** undo/redo
    /// (`rematerialize`) must NOT preserve. Rematerialize replays formula TEXT
    /// only, so the OLD preserve path could read `Blank` and write it back,
    /// silently blanking a UDF cell. Post-fix `rematerialize` uses the
    /// non-preserving `recompute_all`, so a UDF cell with no worker recomputes
    /// HONESTLY to `#CALC!` — never silently `Blank`/stale. (NB: `recompute_all`
    /// is HashMap-order single-pass, so a *dependent* may transiently read the
    /// pre-recompute value — a pre-existing recompute_all property, not this fix;
    /// we assert the UDF cell ITSELF, which is deterministic.)
    #[test]
    fn undo_recomputes_udf_cell_honestly_without_worker() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("udf3.qbook");
        let path_str = path.to_str().unwrap();
        let sheet;
        {
            let mut s = WorkbookSession::new();
            sheet = s.add_sheet("S", 16384).unwrap();
            register_udf(&mut s, "MYUDF", 7);
            s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
                |_h, a: &ql_types::ArrayValue| {
                    let n = match a.get(0, 0) {
                        Some(Value::Number(x)) => *x,
                        o => panic!("{o:?}"),
                    };
                    Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
                },
            )));
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
                .unwrap();
            s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // B1 = 42
            s.save(path_str).unwrap();
        }
        let mut s2 = WorkbookSession::new();
        register_udf(&mut s2, "MYUDF", 7);
        s2.open(path_str).unwrap(); // no worker → B1 = 42 preserved (D2)
        assert_eq!(
            cell_value(&s2, addr(sheet, 0, 1)),
            CellValue::Number { number: 42.0 }
        );
        // One undoable edit, then undo → triggers rematerialize.
        s2.set_value(addr(sheet, 3, 3), CellValue::Number { number: 7.0 })
            .unwrap();
        let undo = s2.undo().unwrap();
        assert!(undo.consumed, "the edit must be undoable");
        // Post-fix: rematerialize recomputes (NO preserve) → no worker → #CALC!,
        // never a silently-blanked cell.
        let b1 = cell_value(&s2, addr(sheet, 0, 1));
        assert!(
            matches!(&b1, CellValue::Error { error } if error == "#CALC!"),
            "after undo on a no-worker session, the UDF cell must recompute to #CALC! (never silently Blank); got {b1:?}"
        );
    }

    /// **6.4-3d audit-fix HIGH-3:** `set_udf_worker_checked` gates lifecycle —
    /// a non-Ready (Closed) session rejects with `[invalid_state]` (the worker is
    /// dropped, not attached), unlike the infallible `set_udf_worker`.
    #[test]
    fn set_udf_worker_checked_rejects_closed_session() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        // Ready → checked injection succeeds.
        s.set_udf_worker_checked(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Ok(ql_types::ArrayValue::singleton(Value::Number(1.0)))
        })))
        .expect("checked inject on a Ready session succeeds");
        s.close().unwrap();
        let err = s
            .set_udf_worker_checked(Box::new(ql_udf::MockWorker::new(|_h, _a| {
                Ok(ql_types::ArrayValue::singleton(Value::Number(1.0)))
            })))
            .unwrap_err();
        assert_eq!(
            err.code, "invalid_state",
            "checked inject on a Closed session → invalid_state"
        );
    }

    /// **6.4-3c (2026-05-29):** the wedge — a registered UDF with a worker
    /// actually COMPUTES. `=MYUDF(A1)` with `A1=21` and a doubling worker → 42.
    /// Inverts the old "registered UDF stays #NAME?" assertion.
    #[test]
    fn udf_scalar_computes_with_mock_worker() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        // Doubling worker: read the single scalar arg, return n*2 as a 1×1 grid.
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            |_handle, args: &ql_types::ArrayValue| {
                let n = match args.get(0, 0) {
                    Some(Value::Number(x)) => *x,
                    other => panic!("expected a number arg, got {other:?}"),
                };
                Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
            },
        )));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        // set_formula evaluates immediately through the worker-carrying env.
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 42.0 },
            "=MYUDF(A1) with A1=21 and a doubling worker must compute 42"
        );
    }

    /// A registered UDF with NO worker configured → deterministic `#CALC!`, and
    /// the session stays usable (NOT `Faulted` — dispatch is panic-free, so the
    /// `with_runtime` FaultGuard never fires).
    #[test]
    fn udf_with_no_worker_is_calc_not_panic() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "registered UDF with no worker must be #CALC!"
        );
        // Session is still usable — a follow-up edit succeeds (not sealed).
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 1.0 })
            .expect("session must remain usable after a worker-less UDF dispatch");
    }

    /// A worker that RAISES maps to `#CALC!` (v1 coarse mapping) and leaves the
    /// session usable.
    #[test]
    fn udf_raise_maps_to_calc() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Err(ql_udf::UdfError::Raised {
                exc_type: "ValueError".to_string(),
                message: "boom".to_string(),
            })
        })));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "a raising UDF must map to #CALC! in v1"
        );
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 1.0 })
            .expect("session usable after a raising UDF");
    }

    /// A worker that TIMES OUT maps to `#TIMEOUT!`.
    #[test]
    fn udf_timeout_maps_to_timeout() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Err(ql_udf::UdfError::Timeout(std::time::Duration::from_millis(
                1,
            )))
        })));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#TIMEOUT!"),
            "a timed-out UDF must map to #TIMEOUT!"
        );
    }

    /// A UDF returning an N×M grid at the cell boundary SPILLS (via the existing
    /// `write_spill` path) — proving the `eval_at_cell_boundary` UDF guard.
    #[test]
    fn udf_array_return_spills_at_cell_boundary() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        // Worker returns a fixed 2×1 column {10; 20}.
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Ok(ql_types::ArrayValue::column(vec![
                Value::Number(10.0),
                Value::Number(20.0),
            ]))
        })));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        // Top-level `=MYUDF(A1)` at B1 spills to B1:B2.
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 10.0 },
            "spill anchor B1 must hold the first cell"
        );
        assert_eq!(
            cell_value(&s, addr(sheet, 1, 1)),
            CellValue::Number { number: 20.0 },
            "B2 must hold the spilled second cell"
        );
    }

    /// The SAME array-returning UDF in SCALAR context (a sub-expression) is
    /// `#CALC!` per the scalar-context contract (mirrors the Unified-tier rule).
    #[test]
    fn udf_array_in_scalar_context_is_calc() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Ok(ql_types::ArrayValue::column(vec![
                Value::Number(10.0),
                Value::Number(20.0),
            ]))
        })));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        // `=MYUDF(A1)+0` — MYUDF is a sub-expression, so its array return becomes
        // #CALC! (scalar context), and #CALC!+0 propagates the error.
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)+0").unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "an array-returning UDF in scalar context must be #CALC!"
        );
    }

    /// Nested UDFs `=MYUDF(MYUDF2(A1))` evaluate correctly — proving the
    /// `RefCell` worker borrow is released between the inner and outer calls.
    /// With `A1=21` and a doubling worker: MYUDF2(21)=42, MYUDF(42)=84.
    #[test]
    fn nested_udf_evaluates() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        register_udf(&mut s, "MYUDF2", 8);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            |_h, args: &ql_types::ArrayValue| {
                let n = match args.get(0, 0) {
                    Some(Value::Number(x)) => *x,
                    other => panic!("expected a number arg, got {other:?}"),
                };
                Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
            },
        )));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(MYUDF2(A1))")
            .unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 84.0 },
            "nested doubling UDFs: MYUDF2(21)=42, MYUDF(42)=84"
        );
    }

    /// Two range args can't fit the v1 single-grid wire protocol → `#VALUE!`
    /// (the marshalling-limit guard; rejected BEFORE the worker is called).
    #[test]
    fn udf_two_range_args_is_value_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 2.0 })
            .unwrap();
        // Two named ranges → two AggregateNameRef args. NB: the names must NOT
        // look like A1-style cell refs (e.g. "R1"/"R2" parse as cells R1/R2, not
        // names) — hence the "MyRange*" prefix, matching the single-range test.
        s.set_name(
            "MyRangeA",
            CellRange {
                sheet,
                start_row: 0,
                start_col: 0,
                end_row: 1,
                end_col: 0,
            },
        )
        .expect("set_name MyRangeA");
        s.set_name(
            "MyRangeB",
            CellRange {
                sheet,
                start_row: 0,
                start_col: 0,
                end_row: 1,
                end_col: 0,
            },
        )
        .expect("set_name MyRangeB");
        register_udf(&mut s, "MYUDF", 7);
        // A doubling worker is installed so the ONLY path to #VALUE! is the
        // marshalling rejection (not a missing worker → which would be #CALC!).
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Ok(ql_types::ArrayValue::singleton(Value::Number(0.0)))
        })));
        s.set_formula(addr(sheet, 0, 1), "MYUDF(MyRangeA, MyRangeB)")
            .unwrap();
        let got = cell_value(&s, addr(sheet, 0, 1));
        assert!(
            matches!(&got, CellValue::Error { error } if error == "#VALUE!"),
            "two range args exceed the v1 single-grid protocol → #VALUE! (got {got:?})"
        );
    }

    // ===== 6.4-3c 3-way audit fixes — array-producing args (CODEX-HIGH-1) =====

    /// **CODEX-HIGH-1 regression:** an array-PRODUCING function arg (a
    /// Unified-tier built-in like `SEQUENCE`) must reach the UDF as its FULL
    /// grid, not be silently collapsed to a 1×1 `#CALC!` by scalar eval.
    #[test]
    fn udf_array_producing_function_arg_passes_full_grid() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        // Shape-echo worker: returns rows*10 + cols of the grid it received.
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            |_h, args: &ql_types::ArrayValue| {
                Ok(ql_types::ArrayValue::singleton(Value::Number(
                    (args.rows() * 10 + args.cols()) as f64,
                )))
            },
        )));
        // SEQUENCE(2,2) is a real Unified-tier built-in producing a 2×2 grid.
        s.set_formula(addr(sheet, 0, 1), "MYUDF(SEQUENCE(2,2))")
            .unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 22.0 },
            "MYUDF must receive SEQUENCE(2,2)'s full 2×2 grid (rows*10+cols=22); \
             a scalarized 1×1 would echo 11"
        );
    }

    /// One array arg + a scalar can't fit the v1 single-grid protocol → a
    /// VISIBLE `#VALUE!`, never a silent scalarization. CODEX-HIGH-1 follow-on.
    #[test]
    fn udf_array_producing_function_arg_with_extra_scalar_is_value_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(|_h, _a| {
            Ok(ql_types::ArrayValue::singleton(Value::Number(0.0)))
        })));
        s.set_formula(addr(sheet, 0, 1), "MYUDF(SEQUENCE(2,2), 5)")
            .unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#VALUE!"),
            "an array arg + a scalar exceeds the single-grid protocol → #VALUE!"
        );
    }

    /// A nested UDF that RETURNS a grid, used as an arg, must pass that grid to
    /// the outer UDF (array-aware arg eval), not a scalarized `#CALC!`.
    #[test]
    fn udf_nested_array_returning_udf_arg_passes_grid() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "OUTER", 7);
        register_udf(&mut s, "INNER", 8);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            |h, args: &ql_types::ArrayValue| match h {
                // INNER → a fixed 2×3 grid.
                8 => Ok(ql_types::ArrayValue::new(
                    2,
                    3,
                    vec![
                        Value::Number(1.0),
                        Value::Number(2.0),
                        Value::Number(3.0),
                        Value::Number(4.0),
                        Value::Number(5.0),
                        Value::Number(6.0),
                    ],
                )
                .expect("2×3 test grid")),
                // OUTER → echo the shape it received.
                _ => Ok(ql_types::ArrayValue::singleton(Value::Number(
                    (args.rows() * 10 + args.cols()) as f64,
                ))),
            },
        )));
        s.set_formula(addr(sheet, 0, 1), "OUTER(INNER())").unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 23.0 },
            "OUTER must receive INNER()'s full 2×3 grid (rows*10+cols=23)"
        );
    }

    /// **Codex MED-1 / Opus LOW-2 pin:** a UDF cell computed BEFORE a worker is
    /// installed is a CLEAN `#CALC!`. `set_udf_worker` does NOT dirty it, so
    /// `recalc_dirty` leaves it `#CALC!`; only `recalc_all` heals it. Pins the
    /// documented v1 behavior so a future change is a deliberate decision.
    #[test]
    fn udf_set_worker_after_formula_needs_recalc_all() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_udf(&mut s, "MYUDF", 7);
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        // No worker yet → clean #CALC!.
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "pre-worker: clean #CALC!"
        );
        // Install a doubling worker. Does NOT dirty the clean #CALC! cell.
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            |_h, args: &ql_types::ArrayValue| {
                let n = match args.get(0, 0) {
                    Some(Value::Number(x)) => *x,
                    other => panic!("expected a number arg, got {other:?}"),
                };
                Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
            },
        )));
        s.recalc_dirty().unwrap();
        assert!(
            matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#CALC!"),
            "recalc_dirty does NOT heal a clean #CALC! UDF cell (documented v1 behavior)"
        );
        s.recalc_all().unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 42.0 },
            "recalc_all picks up the worker → 42"
        );
    }

    /// **MEGAUDIT 2026-05-29 (Codex-B HIGH):** `mark_volatiles_dirty` must fan
    /// out to DEPENDENTS of a volatile UDF, not just mark the volatile cell. The
    /// prior code looped `graph.mark_dirty(node)` (no fanout), so a downstream
    /// `C1 = B1 + 1` over a volatile `B1 = MYUDF(A1)` stayed STALE after
    /// `mark_volatiles_dirty` + `recalc_dirty`. (Pre-dates 6.4-3c; affects all
    /// volatile fns — UDFs are the first host-declared-volatile fns w/ deps.)
    #[test]
    fn mark_volatiles_dirty_fans_out_to_dependents_of_volatile_udf() {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::Arc;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // udf_meta() declares Volatility::Volatile.
        register_udf(&mut s, "MYUDF", 7);
        // Counting worker: each call returns a strictly larger number, so a
        // re-dispatch is observable (the value actually changes).
        let counter = Arc::new(AtomicU64::new(0));
        let c2 = Arc::clone(&counter);
        s.set_udf_worker(Box::new(ql_udf::MockWorker::new(
            move |_h, _a: &ql_types::ArrayValue| {
                let n = c2.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(ql_types::ArrayValue::singleton(Value::Number(n as f64)))
            },
        )));
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // B1 = call#1 = 1
        s.set_formula(addr(sheet, 0, 2), "B1+1").unwrap(); // C1 = 2
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 1.0 }
        );
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 2)),
            CellValue::Number { number: 2.0 }
        );
        // F9: mark volatiles dirty + recalc. B1 re-dispatches (call#2 = 2); C1
        // MUST fan out from the volatile B1 and recompute to 3.
        s.mark_volatiles_dirty().unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 1)),
            CellValue::Number { number: 2.0 },
            "volatile B1 re-dispatches"
        );
        assert_eq!(
            cell_value(&s, addr(sheet, 0, 2)),
            CellValue::Number { number: 3.0 },
            "C1 must fan out from volatile B1 (the bug left it stale at 2)"
        );
    }

    /// **6.4-2 (2026-05-28; closes M4-OPUS UDF-flow binder integration
    /// test from the 6.4-1 cycle 2 audit):** a UDF registered with
    /// `arg_context: Aggregate` admits **named-range** args at the binder
    /// layer (via `BindContext::AggregateNameRef`). Pre-registration the
    /// binder rejects `=MYUDF(MyRange)` with
    /// `BindError::NamedRangeInScalarContext` — the binder's default
    /// `Scalar` arg-context for unknown names; post-registration it binds
    /// because the metadata-derived arg_context is now `Aggregate`. This is
    /// the load-bearing wire-through of 6.4-1's H1 binder migration
    /// (`ql-exec::plan::is_aggregate_function` consults metadata) to the
    /// trait surface.
    ///
    /// **Why named range, not literal `A1:A2`:** literal RangeRefs as
    /// direct args to non-Function-context callsites are rejected at a
    /// layer ABOVE the arg_context check (the W5-108 / Phase 4.7.O
    /// "literal RangeRef in non-Function context is unsupported in v1"
    /// constraint). The H1 binder migration affects NAMED ranges
    /// (`AggregateNameRef`), not literal ranges — verified at source by
    /// the test failure when the test was first written against
    /// `MYUDF(A1:A2)`.
    #[test]
    fn register_function_with_aggregate_arg_context_admits_named_range_args() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 2.0 })
            .unwrap();
        // Define a named range `MyRange` → A1:A2.
        s.set_name(
            "MyRange",
            CellRange {
                sheet,
                start_row: 0,
                start_col: 0,
                end_row: 1,
                end_col: 0,
            },
        )
        .expect("set_name");

        // Pre-registration: MYUDF unknown → binder defaults its args to Scalar
        // arg_context → the named range `MyRange` surfaces
        // `BindError::NamedRangeInScalarContext`, which `set_formula` maps via
        // `map_runtime_err` to `Compute / formula_bind` (it returns `Err`, not a
        // cell diagnostic — verified at `set_formula` :1336-1338).
        //
        // **6.4-2 cycle-2 audit-fix (M2/F7):** assert the SPECIFIC failure, not
        // "any error". The old check accepted any `set_formula` error or any
        // error-valued cell, so it could pass for an unrelated parse/arity/
        // lifecycle failure and still claim it pinned the ArgContext migration.
        let pre = s
            .set_formula(addr(sheet, 0, 1), "MYUDF(MyRange)")
            .expect_err("MYUDF(MyRange) MUST fail to bind while MYUDF is unknown");
        assert_eq!(
            pre.class,
            ErrorClass::Compute,
            "pre-registration error class"
        );
        assert_eq!(pre.code, "formula_bind", "pre-registration error code");
        assert!(
            pre.message.contains("scalar position")
                && pre.message.to_uppercase().contains("MYRANGE"),
            "pre-registration failure must be the named-range-in-scalar-context bind error \
             (the binder's Scalar default for an unknown function), got: {}",
            pre.message
        );

        // Register MYUDF with arg_context: Aggregate (the udf_meta() default).
        s.register_function(udf_meta("MYUDF"), FunctionImplHandle(1))
            .expect("register_function clean");

        // Post-registration: setting the formula succeeds (binder admits the
        // named-range arg under AggregateNameRef context). Whether eval
        // produces #NAME? or something else depends on dispatch (still
        // missing in v1), but the BIND must pass.
        s.set_formula(addr(sheet, 1, 1), "MYUDF(MyRange)")
            .expect("MYUDF(MyRange) MUST bind after registering MYUDF with arg_context=Aggregate");
        // The cell exists (formula is stored).
        let c1 = s.cell(addr(sheet, 1, 1)).unwrap();
        assert!(
            c1.is_some_and(|c| c.formula.is_some()),
            "formula text must round-trip after successful bind"
        );
    }

    /// **6.4-2 (2026-05-28; closes M3-OPUS Reference+ArrayBatch forward-
    /// compat smoke from the 6.4-1 cycle 2 audit):** a UDF declaring the
    /// unusual combination `arg_context: Reference + batch_shape:
    /// ArrayBatch` registers + lists + unregisters cleanly. No substrate
    /// assertion fires; the metadata round-trips through `list_functions`
    /// faithfully. Forward-compat for the 6.4-3 worker-dispatcher design
    /// (which may want a Reference-arg UDF returning an Arrow batch).
    #[test]
    fn register_function_reference_plus_array_batch_round_trips_through_dto() {
        use ql_session::function_meta::{ArgContext, BatchShape};
        let mut s = WorkbookSession::new();
        let mut meta = udf_meta("MYREFUDF");
        meta.arg_context = ArgContext::Reference;
        meta.batch_shape = BatchShape::ArrayBatch;
        s.register_function(meta, FunctionImplHandle(7))
            .expect("Reference + ArrayBatch combo registers clean");
        let listed = s
            .list_functions()
            .unwrap()
            .into_iter()
            .find(|m| m.canonical_name == "MYREFUDF")
            .expect("MYREFUDF in list");
        assert_eq!(listed.arg_context, ArgContext::Reference);
        assert_eq!(listed.batch_shape, BatchShape::ArrayBatch);
        // Unregister cleanly too.
        s.unregister_function("MYREFUDF").expect("unregister clean");
        assert!(!s
            .list_functions()
            .unwrap()
            .iter()
            .any(|m| m.canonical_name == "MYREFUDF"));
    }

    /// **6.4-2 (2026-05-28):** lifecycle gate — `register_function` /
    /// `unregister_function` require `Ready`; rejected on `Closed` with
    /// `invalid_state`. `list_functions` requires `Readable` (Ready/Busy
    /// OK; Closed rejected).
    #[test]
    fn function_methods_respect_lifecycle_gate() {
        let mut s = WorkbookSession::new();
        s.close().unwrap();
        // register_function: ensure_ready rejects Closed.
        let err = s
            .register_function(udf_meta("MYUDF"), FunctionImplHandle(1))
            .unwrap_err();
        assert_eq!(err.code, "invalid_state");
        // unregister_function: same gate.
        let err = s.unregister_function("MYUDF").unwrap_err();
        assert_eq!(err.code, "invalid_state");
        // list_functions: ensure_readable also rejects Closed.
        let err = s.list_functions().unwrap_err();
        assert_eq!(err.code, "invalid_state");
    }

    /// **6.4-2 cycle-2 audit-fix (H1/F1 — Codex + Opus, both lanes):** a
    /// lowercase or empty `canonical_name` returns a loud structured
    /// `[bad_argument]` instead of PANICKING across the (catch_unwind-free) napi
    /// boundary. Pre-fix, `register_function` forwarded the name straight to
    /// `register_metadata`, whose `assert!`s (`registry.rs:357,:361`) panicked —
    /// and the panic unwound through the ARMED `FaultGuard`, permanently sealing
    /// the session `Faulted`. This test pins BOTH the structured error AND the
    /// no-seal property (a valid registration after the rejected ones succeeds).
    #[test]
    fn register_function_rejects_lowercase_or_empty_canonical_name_with_bad_argument() {
        let mut s = WorkbookSession::new();
        // Lowercase canonical_name (registry.rs:361 asserts ASCII-upper-case).
        let err = s
            .register_function(udf_meta("mylowerudf"), FunctionImplHandle(1))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert_eq!(err.code, "bad_argument");
        // Empty canonical_name (registry.rs:357 asserts non-empty).
        let err = s
            .register_function(udf_meta(""), FunctionImplHandle(1))
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert_eq!(err.code, "bad_argument");
        // CRUCIAL no-seal property: validation happens BEFORE the FaultGuard is
        // armed, so the rejected calls leave the session Ready. A subsequent
        // VALID registration must still succeed (proves the session was not
        // sealed Faulted by the rejected inputs).
        s.register_function(udf_meta("MYUDF"), FunctionImplHandle(2))
            .expect("a valid registration after rejected ones must still succeed");
        assert!(s
            .list_functions()
            .unwrap()
            .iter()
            .any(|m| m.canonical_name == "MYUDF"));
    }

    /// **6.4B hardening (2026-05-29; 6.4-4 megaudit FF-1):** `register_function`
    /// rejects an upper-case-but-UNCALLABLE canonical name (one the formula
    /// language cannot use as `=NAME(..)`), while still accepting the DOTTED
    /// shapes a naive identifier grammar would wrongly reject — both letter-led
    /// (`VAR.S` shape) and digit-led (`T.DIST.2T` / `.2T` shape) segments. (The
    /// gate uses the real lexer+parser, so it also accepts CellRef-lexed builtin
    /// names like `LOG10`; that is not asserted here because every such name is
    /// already a registered builtin and would hit the dup-check, not the gate —
    /// the acceptance is covered by the parser path itself + the validator doc.)
    #[test]
    fn register_function_rejects_uncallable_canonical_names() {
        // Accept: plain + both dotted-segment shapes + leading underscore — all
        // callable as a formula head and none a pre-registered builtin.
        for (i, ok_name) in ["MYUDF", "MY.DOTUDF", "MYUDF.2X", "_HIDDEN"]
            .iter()
            .enumerate()
        {
            let mut s = WorkbookSession::new();
            s.register_function(udf_meta(ok_name), FunctionImplHandle(i as u64 + 1))
                .unwrap_or_else(|e| {
                    panic!("{ok_name:?} is a callable name and must register: {e:?}")
                });
        }
        // Reject: whitespace, punctuation, non-ASCII, trailing dot, digit-led —
        // all upper-case (so they pass the lowercase gate) but uncallable as a
        // formula function head.
        let mut s = WorkbookSession::new();
        for bad_name in ["MY UDF", "MY-UDF", "MY+UDF", "É", "MY.UDF.", "1UDF"] {
            let err = s
                .register_function(udf_meta(bad_name), FunctionImplHandle(99))
                .unwrap_err();
            assert_eq!(
                err.code, "bad_argument",
                "{bad_name:?} is not callable as =NAME(..) and must be rejected bad_argument"
            );
        }
        // No-seal: a valid registration still succeeds after the rejects.
        s.register_function(udf_meta("OKUDF"), FunctionImplHandle(100))
            .expect("session must remain usable (validation precedes the FaultGuard)");
    }

    /// **6.4-2 cycle-2 audit-fix (F2 — Codex):** prove `from_workbook_with_registry`
    /// extracts the rebuilt graph against the CALLER-PROVIDED registry, so the
    /// `open`/`import` adoption sites preserve UDF-awareness. Build a workbook
    /// whose `B1 = MYVOL(A1)` references a VOLATILE UDF (via a helper session
    /// that has MYVOL registered), then adopt the SAME workbook two ways and
    /// compare the rebuilt graph's volatile classification:
    ///   - via `from_workbook_with_registry(.., udf_aware_registry)` → B1 volatile
    ///   - via `from_workbook(..)` (fresh default, UDF-free registry) → NOT volatile
    /// With the pre-fix adoption pattern (`from_workbook` then post-hoc registry
    /// swap), the graph would have been built UDF-free and the volatile
    /// classification silently lost — the divergence this fix closes.
    #[test]
    fn from_workbook_with_registry_threads_udf_metadata_into_graph() {
        let mut helper = WorkbookSession::new();
        let sheet = helper.add_sheet("S", 16384).unwrap();
        helper
            .set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        // udf_meta defaults to Volatility::Volatile (the Python-UDF wedge shape).
        helper
            .register_function(udf_meta("MYVOL"), FunctionImplHandle(1))
            .unwrap();
        helper.set_formula(addr(sheet, 0, 1), "MYVOL(A1)").unwrap();
        let wb = helper.workbook.clone();
        let udf_registry = Arc::clone(&helper.registry);

        // Adopt with the preserved UDF-aware registry → B1 classified volatile.
        let adopted = WorkbookSession::from_workbook_with_registry(wb.clone(), udf_registry);
        assert!(
            !adopted.graph.volatile_formulas().is_empty(),
            "from_workbook_with_registry MUST extract the graph against the PASSED \
             registry — MYVOL is Volatile, so B1=MYVOL(A1) lands in the volatile set"
        );

        // Adopt with a fresh default (UDF-free) registry → MYVOL unknown → NOT
        // volatile. This is exactly the divergence the F2 fix prevents at the
        // open/import adoption sites.
        let default_adopted = WorkbookSession::from_workbook(wb);
        assert!(
            default_adopted.graph.volatile_formulas().is_empty(),
            "from_workbook (default registry) does not know MYVOL is volatile — \
             confirms the registry choice DRIVES graph extraction (the F2 hazard)"
        );
    }

    // --- persistence: open + save .qbook round-trip (inc.2c-9) ---

    /// save → open round-trips cell values, formula text, and computed values.
    /// (Sheet ids are preserved by the `.qbook` format, so `sheet` is reused.)
    #[test]
    fn save_open_round_trip_preserves_cells_formulas_values() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("rt.qbook");
        let path_str = path.to_str().unwrap();

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap();
        let _ = s.recalc_dirty().unwrap();
        s.save(path_str).unwrap();

        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        assert_eq!(s2.lifecycle_state(), LifecycleState::Ready);
        let a1 = s2.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 10.0 }));
        let b1 = s2.cell(addr(sheet, 0, 1)).unwrap().unwrap();
        assert_eq!(b1.value, Some(CellValue::Number { number: 20.0 }));
        assert_eq!(b1.formula.as_deref(), Some("A1 * 2"));
    }

    /// open recomputes a stale saved formula value (mirrors the canonical IDE
    /// path `loader.rs::load_workbook_and_recompute`): a `.qbook` whose stored
    /// A2 (= A1*2) is stale relative to A1 is refreshed on open.
    #[test]
    fn open_recomputes_stale_saved_formula_value() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("stale.qbook");
        let path_str = path.to_str().unwrap();

        // Build a workbook with a deliberately-stale computed value: A2 = A1*2
        // computed against A1=10 (→20), then A1 mutated to 100 WITHOUT recompute.
        let mut wb = Workbook::new();
        let sheet = wb.add_sheet("S");
        wb.put_at(sheet, 0, 0, Value::Number(10.0));
        let reg = ql_functions::default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(sheet, 1, 0, "A1 * 2").unwrap();
        }
        wb.put_at(sheet, 0, 0, Value::Number(100.0)); // A2 now stale at 20
        ql_io::save_workbook_with_oplog(&wb, &OpLog::new(), "stale", &path).unwrap();

        let mut s = WorkbookSession::new();
        s.open(path_str).unwrap();
        // open recomputed: A2 = 100 * 2 = 200.
        let a2 = s.cell(addr(sheet, 1, 0)).unwrap().unwrap();
        assert_eq!(a2.value, Some(CellValue::Number { number: 200.0 }));
    }

    /// A value cleared to Blank (`Op::ClearValue`, F2) survives save → open —
    /// the prior value does NOT resurrect (the core F2-durability round-trip).
    #[test]
    fn set_value_blank_survives_save_open_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("blank.qbook");
        let path_str = path.to_str().unwrap();

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Blank).unwrap(); // clear to blank
        s.save(path_str).unwrap();

        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        // A1 is empty — the 5.0 did not survive the clear through save/open.
        assert!(s2.cell(addr(sheet, 0, 0)).unwrap().is_none());
    }

    /// open of a non-existent path fails loud as a `Persistence` error and
    /// leaves the session unchanged + usable (No-Fallbacks).
    #[test]
    fn open_nonexistent_path_fails_loud_persistence() {
        let mut s = WorkbookSession::new();
        let err = s.open("/no/such/path/nope.qbook").unwrap_err();
        assert_eq!(err.class, ErrorClass::Persistence);
        assert_eq!(err.code, "qbook_error");
        // The failed open did not mutate the session (it errored before adopting).
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        assert!(s.add_sheet("StillWorks", 16384).is_ok());
    }

    /// open re-mints the epoch, so a delta token captured before open returns
    /// `full_rebuild_required` (EpochMismatch), never a silently-incomplete delta.
    #[test]
    fn open_rebumps_epoch_invalidates_prior_delta_token() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("epoch.qbook");
        let path_str = path.to_str().unwrap();
        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
                .unwrap();
            s.save(path_str).unwrap();
        }

        let mut s = WorkbookSession::new();
        let _ = s.add_sheet("Old", 16384).unwrap();
        let token = s.snapshot().unwrap().version;
        s.open(path_str).unwrap();
        let delta = s.snapshot_delta(&token).unwrap();
        assert!(
            delta.full_rebuild_required,
            "a pre-open delta token must force a full rebuild after open re-mints the epoch"
        );
    }

    /// save is rejected once the session is terminal (Closed) — loud, never a
    /// silent no-op.
    #[test]
    fn save_while_closed_fails_invalid_state() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("closed.qbook");
        let mut s = WorkbookSession::new();
        s.close().unwrap();
        let err = s.save(path.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "invalid_state");
    }

    /// A save path with no file stem (the workbook name source in v1) fails
    /// loud as `BadArgument` rather than writing a nameless workbook.
    #[test]
    fn save_path_without_stem_fails_bad_argument() {
        let s = WorkbookSession::new();
        let err = s.save("/tmp/..").unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
        assert_eq!(err.code, "bad_argument");
    }

    /// **Wave H1:** `save` onto a path occupied by an existing DIRECTORY (e.g. a
    /// legacy `.qbook` bundle) is refused LOUD as `Persistence` — the single-file
    /// container can't overwrite a directory, and the directory is left intact.
    #[test]
    fn save_onto_existing_directory_fails_loud_persistence() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("legacy.qbook");
        std::fs::create_dir_all(&path).unwrap();
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let err = s.save(path.to_str().unwrap()).unwrap_err();
        assert_eq!(err.class, ErrorClass::Persistence);
        assert!(path.is_dir(), "the existing directory must be untouched");
    }

    /// open of a single-file `.qbook` whose container bytes are corrupt fails
    /// LOUD as a `Persistence` error and leaves the session untouched (the Codex
    /// inc.2c-9 HIGH, generalized to the **Wave H1 (2026-06-19)** container: a
    /// corrupt file must not be silently accepted then masked by the next save).
    /// Op-log-specific corruption (Loro framing / payload op shape) is pinned at
    /// the ql-io layer — `oplog_persistence`'s dir tests + the H1
    /// `qbook_file_roundtrip` suite, which the single-file loader funnels through
    /// the SAME `load_workbook_with_oplog` — and by `d1_step8_legacy_op_shape.rs`.
    #[test]
    fn open_with_corrupt_container_fails_loud_persistence() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("corrupt.qbook");
        let path_str = path.to_str().unwrap();
        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
                .unwrap();
            s.save(path_str).unwrap();
        }
        // **Wave H1:** `.qbook` is now a single FILE (a ZIP container), so the
        // old `std::fs::write(path.join("oplog.bin"), ..)` corruption is invalid
        // (the path is a file). Overwrite the container bytes in place; the
        // single-file loader rejects this loudly (`NotAQbookContainer`/`Zip` ->
        // `Persistence`) before adopting anything.
        std::fs::write(&path, b"this is not a quantbook container").unwrap();

        let mut s = WorkbookSession::new();
        let err = s.open(path_str).unwrap_err();
        assert_eq!(err.class, ErrorClass::Persistence);
        // The failed open did not adopt the document; the session is still usable.
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        assert!(s.add_sheet("StillWorks", 16384).is_ok());
    }

    /// Immediately after `open`, the (fresh) undo stack is empty: `can_undo()` is
    /// false and an `undo()` is a no-op — undo cannot cross the open point
    /// (Option 1: the loaded op-log is discarded, a fresh `UndoManager` is built).
    #[test]
    fn can_undo_false_immediately_after_open() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("undo.qbook");
        let path_str = path.to_str().unwrap();
        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 42.0 })
                .unwrap();
            s.set_formula(addr(sheet, 0, 1), "A1+1").unwrap();
            s.save(path_str).unwrap();
        }

        let mut s = WorkbookSession::new();
        s.open(path_str).unwrap();
        // The opened content is present (recompute ran)…
        let sheet = 0;
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 43.0 })
        );
        // …but nothing is undoable, and undo is a no-op (cannot cross open).
        assert!(!s.can_undo());
        assert!(!s.undo().unwrap().consumed);
    }

    /// A save → open → mutate → re-save → open cycle is stable: the original
    /// cells, the new mutation, and formula recompute all survive even though
    /// `open` resets the op-log to empty each time (the documented Option-1
    /// history trade-off does not cost document state — `save` writes the full
    /// workbook envelope independent of the op-log).
    #[test]
    fn save_open_resave_open_stable() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("cycle.qbook");
        let path_str = path.to_str().unwrap();

        let sheet;
        {
            let mut s = WorkbookSession::new();
            sheet = s.add_sheet("S", 16384).unwrap();
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
                .unwrap();
            s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap();
            let _ = s.recalc_dirty().unwrap();
            s.save(path_str).unwrap();
        }

        // Reopen, mutate A1, recalc, re-save to the SAME path (overwrite).
        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        s2.set_value(addr(sheet, 0, 0), CellValue::Number { number: 7.0 })
            .unwrap();
        let _ = s2.recalc_dirty().unwrap();
        s2.save(path_str).unwrap();

        // Reopen the re-saved file: the mutation + recompute + formula all survive.
        let mut s3 = WorkbookSession::new();
        s3.open(path_str).unwrap();
        let a1 = s3.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 7.0 }));
        let b1 = s3.cell(addr(sheet, 0, 1)).unwrap().unwrap();
        assert_eq!(b1.value, Some(CellValue::Number { number: 14.0 }));
        assert_eq!(b1.formula.as_deref(), Some("A1 * 2"));
    }

    // --- import: xlsx (inc.2c-10) ---

    /// xlsx round-trip: export a fixture workbook to xlsx bytes (no committed
    /// `.xlsx` fixtures exist), import them into a session, and confirm cells +
    /// the formula's recompute (via the injected `EngineXlsxRecomputer`) survive.
    #[test]
    fn import_xlsx_round_trip_loads_cells_and_recomputes() {
        let dir = tempfile::TempDir::new().unwrap();
        let xlsx_path = dir.path().join("fixture.xlsx");
        let reg = ql_functions::default_registry();

        // Build A1=6, A2==A1*7 (=42), export to xlsx.
        let mut wb = Workbook::new();
        let sheet = wb.add_sheet("S");
        wb.put_at(sheet, 0, 0, Value::Number(6.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(sheet, 1, 0, "A1 * 7").unwrap();
            let _ = rt.recompute_all();
        }
        ql_io_xlsx::export_xlsx_path(&wb, &reg, &xlsx_path, Default::default()).unwrap();
        let bytes = std::fs::read(&xlsx_path).unwrap();

        let mut s = WorkbookSession::new();
        s.import(&bytes, "xlsx").unwrap();
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        let a1 = s.cell(addr(0, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 6.0 }));
        let a2 = s.cell(addr(0, 1, 0)).unwrap().unwrap();
        assert_eq!(a2.value, Some(CellValue::Number { number: 42.0 }));
        assert!(
            a2.formula.is_some(),
            "A2 must retain its formula after import"
        );
        // The import adopted a fresh op-log/undo history (Option 1): nothing undoable.
        assert!(!s.can_undo());
    }

    /// import of bytes that aren't a valid xlsx (not a zip) fails loud as a
    /// `Persistence` error and leaves the session unchanged + usable.
    #[test]
    fn import_malformed_xlsx_bytes_fails_loud_persistence() {
        let mut s = WorkbookSession::new();
        let err = s.import(b"not an xlsx file", "xlsx").unwrap_err();
        assert_eq!(err.class, ErrorClass::Persistence);
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        assert!(s.add_sheet("StillWorks", 16384).is_ok());
    }

    /// import of an unknown format → `BadArgument`; `"csv"` is the deferred
    /// follow-up → honest `Capability`/`not_implemented_in_v1_core`.
    #[test]
    fn import_unknown_format_is_bad_argument() {
        // csv + xlsx are real (inc.2c-10/11); an unknown format is a loud
        // BadArgument, NOT a Capability/not_implemented.
        let mut s = WorkbookSession::new();
        let err = s.import(b"x", "ods").unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
    }

    // --- import/export: csv (inc.2c-11) ---

    /// csv round-trip through the session: import infers types, the cells read
    /// back, and `export("csv")` re-serialises them.
    #[test]
    fn import_export_csv_round_trip() {
        let mut s = WorkbookSession::new();
        s.import(b"name,score,passed\nAlice,91.5,TRUE\nBob,0,FALSE\n", "csv")
            .unwrap();
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        // Inferred types survive (sheet id 0 is the single imported sheet).
        assert_eq!(
            s.cell(addr(0, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Text {
                text: "name".to_string()
            })
        );
        assert_eq!(
            s.cell(addr(0, 1, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 91.5 })
        );
        assert_eq!(
            s.cell(addr(0, 1, 2)).unwrap().unwrap().value,
            Some(CellValue::Boolean { boolean: true })
        );
        // Re-export and confirm the values come back out.
        let out = String::from_utf8(s.export("csv").unwrap()).unwrap();
        assert!(out.contains("name,score,passed"), "out=<{out}>");
        assert!(out.contains("Alice,91.5,TRUE"), "out=<{out}>");
        assert!(out.contains("Bob,0,FALSE"), "out=<{out}>");
        // csv import adopts a fresh op-log/undo history (Option 1).
        assert!(!s.can_undo());
    }

    /// A field with a leading `=` imports as TEXT, never a formula (csv
    /// injection-safety + this path has no evaluator).
    #[test]
    fn import_csv_leading_equals_is_text_not_formula() {
        let mut s = WorkbookSession::new();
        s.import(b"=1+1\n", "csv").unwrap();
        let c = s.cell(addr(0, 0, 0)).unwrap().unwrap();
        assert_eq!(
            c.value,
            Some(CellValue::Text {
                text: "=1+1".to_string()
            })
        );
        assert!(c.formula.is_none(), "csv must not create a formula");
    }

    /// Malformed (non-UTF-8) csv bytes fail loud as a `Persistence` error and
    /// leave the session unchanged + usable.
    #[test]
    fn import_csv_non_utf8_fails_loud_persistence() {
        let mut s = WorkbookSession::new();
        let err = s.import(&[b'a', b',', 0xFF, b'\n'], "csv").unwrap_err();
        assert_eq!(err.class, ErrorClass::Persistence);
        assert_eq!(err.code, "csv_parse");
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        assert!(s.add_sheet("StillWorks", 16384).is_ok());
    }

    /// `export("csv")` refuses a multi-sheet workbook loudly rather than
    /// silently dropping sheets (export is `&self`, no warning channel).
    #[test]
    fn export_csv_multi_sheet_fails_loud_bad_argument() {
        let mut s = WorkbookSession::new();
        s.add_sheet("A", 16384).unwrap();
        s.add_sheet("B", 16384).unwrap();
        let err = s.export("csv").unwrap_err();
        assert_eq!(err.class, ErrorClass::BadArgument);
    }

    /// An unknown export format is always a loud `BadArgument`.
    #[test]
    fn export_unknown_format_is_bad_argument() {
        let s = WorkbookSession::new();
        assert_eq!(s.export("ods").unwrap_err().class, ErrorClass::BadArgument);
    }

    /// Without the `xlsx-write` feature, the umya writer isn't compiled in, so
    /// `export("xlsx")` returns the honest deferred
    /// `Capability`/`not_implemented_in_v1_core` error (No-Fallbacks — never a
    /// silent empty export).
    #[cfg(not(feature = "xlsx-write"))]
    #[test]
    fn export_xlsx_without_feature_is_capability() {
        let s = WorkbookSession::new();
        let xlsx = s.export("xlsx").unwrap_err();
        assert_eq!(xlsx.class, ErrorClass::Capability);
        assert_eq!(xlsx.code, "not_implemented_in_v1_core");
    }

    /// With the `xlsx-write` feature, `export("xlsx")` produces real bytes that
    /// re-import into a session with cells + recomputed formulas intact. xlsx is
    /// multi-sheet, so the WHOLE workbook round-trips (no single-sheet limit like
    /// csv). Exercises the in-memory `export_xlsx_bytes` writer end-to-end
    /// through the session contract.
    #[cfg(feature = "xlsx-write")]
    #[test]
    fn export_xlsx_round_trip_through_session() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 6.0 })
            .unwrap();
        // set_formula evaluates immediately → A2 == 42 is cached for export.
        s.set_formula(addr(sheet, 1, 0), "A1 * 7").unwrap();

        let bytes = s.export("xlsx").unwrap();
        assert!(!bytes.is_empty(), "xlsx export produced no bytes");

        // Re-import the bytes into a fresh session; cells + formula survive.
        let mut s2 = WorkbookSession::new();
        s2.import(&bytes, "xlsx").unwrap();
        assert_eq!(s2.lifecycle_state(), LifecycleState::Ready);
        let a1 = s2.cell(addr(0, 0, 0)).unwrap().unwrap();
        assert_eq!(a1.value, Some(CellValue::Number { number: 6.0 }));
        let a2 = s2.cell(addr(0, 1, 0)).unwrap().unwrap();
        assert_eq!(a2.value, Some(CellValue::Number { number: 42.0 }));
        assert!(
            a2.formula.is_some(),
            "A2 must retain its formula after the xlsx round-trip"
        );
    }

    /// The xlsx feature inventory (the PRIMARY dropped-feature channel —
    /// conditional formatting, merged cells, etc.) is surfaced as `Warning`
    /// diagnostics, NOT silently dropped (Opus H1: `feature_inventory.counts`
    /// is distinct from `report.unsupported`, and Permissive import drops those
    /// features on the wire — the session must report them).
    #[test]
    fn xlsx_import_surfaces_feature_inventory_as_diagnostics() {
        use ql_io_xlsx::UnsupportedFeatureKind;
        let mut s = WorkbookSession::new();
        let mut report = ql_io_xlsx::XlsxImportReport::default();
        report
            .feature_inventory
            .record(UnsupportedFeatureKind::MergedCells);
        report
            .feature_inventory
            .record(UnsupportedFeatureKind::ConditionalFormatting);
        s.push_xlsx_import_diagnostics(&report);
        let n = s
            .events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Event::CellDiagnostic { diagnostic }
                        if diagnostic.code == "xlsx_unsupported_feature"
                )
            })
            .count();
        assert_eq!(
            n, 2,
            "both inventoried dropped features must surface as diagnostics (No-Fallbacks)"
        );
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

    /// **L8 (6.3-1a):** a panic during recompute must terminalize the op as
    /// `Failed` (NOT leave it stranded `Running`, since the `Completed` insert
    /// never runs) AND seal the session `Faulted` (the existing `FaultGuard`),
    /// with subsequent mutators rejected `[invalid_state]` — never a second
    /// panic. **6.3-1b:** drives the shared `execute_recalc` executor (the body
    /// formerly in `run_recalc`) with a panicking closure under `catch_unwind`,
    /// after arming an op via `start_recalc` exactly as the windowed path does (the
    /// napi boundary's M1 `guarded` does the same in prod).
    #[test]
    fn execute_recalc_panic_terminalizes_op_and_faults_session() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        // Silence the default panic hook so the deliberate panic does not spam
        // the test output; restore it immediately after.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        // Arm an op (Running + Busy) as `start_recalc` does (op id 1 — fresh
        // session, edits allocate no ops), then drive the shared executor with a
        // panicking recompute closure.
        let op = s.start_recalc(RecalcKind::Dirty).unwrap();
        assert_eq!(op, OperationId(1));
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            s.execute_recalc(op, |_rt| panic!("boom"))
        }));
        std::panic::set_hook(prev);
        assert!(
            caught.is_err(),
            "the panic must propagate past execute_recalc (resume_unwind)"
        );
        // The armed op is `Failed`, not stranded `Running`.
        match s.operation_status(OperationId(1)).unwrap() {
            OperationState::Failed { .. } => {}
            other => panic!("op must be Failed after a recompute panic, got {other:?}"),
        }
        assert_eq!(s.lifecycle_state(), LifecycleState::Faulted);
        // The terminal event is emitted (6.3-1a closure-audit): an IDE polling
        // events sees the op resolve to Failed, not hang on Running. poll_events
        // is a pure read and stays legal on a Faulted session.
        let page = s.poll_events(EventCursor(0)).unwrap();
        assert!(
            page.events.iter().any(|e| matches!(
                e,
                Event::OperationCompleted {
                    op: o,
                    state: OperationState::Failed { .. }
                } if *o == OperationId(1)
            )),
            "a Failed OperationCompleted event must be emitted for the panicked op"
        );
        let err = s
            .set_value(addr(sheet, 0, 0), CellValue::Number { number: 2.0 })
            .unwrap_err();
        assert_eq!(err.code, "invalid_state");
    }

    // ---- M2 (6.3-1b): start_recalc / await_recalc pre-start cancel window ----

    /// Build `A1=10`, `B1==A1*2` (=20), then dirty B1 by setting `A1=5` WITHOUT
    /// recomputing — so a recalc that runs makes B1=10, and a recalc that is skipped
    /// leaves the stale B1=20. Returns `(session, sheet)`.
    fn dirty_dependent_session() -> (WorkbookSession, SheetId) {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 })
        );
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        (s, sheet)
    }

    /// (a) A `cancel(op)` in the pre-start window makes `await_recalc` SKIP the
    /// recompute: the op is `Canceled`, the dependent stays stale, the session is
    /// `Ready`, and a terminal `Canceled` event is emitted.
    #[test]
    fn await_recalc_honors_pre_start_cancel_and_skips_recompute() {
        let (mut s, sheet) = dirty_dependent_session();
        let op = s.start_recalc(RecalcKind::Dirty).unwrap();
        // Reads + cancel are legal in the Busy window.
        assert_eq!(s.lifecycle_state(), LifecycleState::Busy);
        assert!(s.cell(addr(sheet, 0, 1)).is_ok());
        assert!(s.cancel(op).unwrap(), "cancel of a Running op succeeds");
        s.await_recalc(op).unwrap();
        // Recompute was SKIPPED: B1 still the stale 20 (NOT 10).
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "canceled recalc must not recompute"
        );
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Canceled);
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        let page = s.poll_events(EventCursor(0)).unwrap();
        assert!(
            page.events.iter().any(|e| matches!(
                e,
                Event::OperationCompleted { op: o, state: OperationState::Canceled } if *o == op
            )),
            "a terminal Canceled event must be emitted"
        );
    }

    /// (b) `start_recalc` then `await_recalc` with no cancel completes normally and
    /// recomputes the dependent.
    #[test]
    fn start_then_await_recalc_completes_and_recomputes() {
        let (mut s, sheet) = dirty_dependent_session();
        let op = s.start_recalc(RecalcKind::Dirty).unwrap();
        s.await_recalc(op).unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 }),
            "uncanceled recalc must recompute B1 to A1*2 = 10"
        );
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
    }

    /// (c) Cancel AFTER the op is terminal (already completed) returns `false`.
    #[test]
    fn cancel_after_completed_returns_false() {
        let (mut s, _sheet) = dirty_dependent_session();
        let op = s.recalc_dirty().unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
        assert!(
            !s.cancel(op).unwrap(),
            "cancel of an already-terminal op is a no-op (false)"
        );
    }

    /// (d) `await_recalc` misuse is fail-loud: no pending recalc, or an op that is
    /// not the in-flight one (and the real pending recalc stays drainable).
    #[test]
    fn await_recalc_misuse_is_bad_argument() {
        let (mut s, _sheet) = dirty_dependent_session();
        // No pending recalc.
        let err = s.await_recalc(OperationId(999)).unwrap_err();
        assert_eq!(err.code, "bad_argument");
        // Mismatched op: pending stays intact and is still drainable.
        let op = s.start_recalc(RecalcKind::Dirty).unwrap();
        let err = s.await_recalc(OperationId(op.0 + 1)).unwrap_err();
        assert_eq!(err.code, "bad_argument");
        s.await_recalc(op).unwrap();
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Completed);
    }

    /// (e) The Busy window blocks a second `start_recalc` and any mutation
    /// (`session_busy`), and convenience `recalc_dirty`/`recalc_all` still behave as
    /// before (no window).
    #[test]
    fn recalc_window_is_busy_and_convenience_wrappers_unchanged() {
        let (mut s, sheet) = dirty_dependent_session();
        let op = s.start_recalc(RecalcKind::Dirty).unwrap();
        // Second start + mutation are rejected while Busy.
        assert_eq!(
            s.start_recalc(RecalcKind::All).unwrap_err().code,
            "session_busy"
        );
        assert_eq!(
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
                .unwrap_err()
                .code,
            "session_busy"
        );
        s.await_recalc(op).unwrap();
        // Drained back to Ready; convenience recalc now works and recomputes.
        assert_eq!(s.lifecycle_state(), LifecycleState::Ready);
        let op2 = s.recalc_all().unwrap();
        assert_eq!(s.operation_status(op2).unwrap(), OperationState::Completed);
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 })
        );
    }

    /// **6.3-1b closure-audit HIGH (both lanes):** `close()` mid-window must NOT be
    /// resurrectable. `start_recalc` then `close` then `await_recalc` must reject
    /// (`invalid_state`), leave the session `Closed`, and resolve the stranded op as
    /// `Canceled` (not run the recompute and flip back to `Ready`).
    #[test]
    fn close_during_recalc_window_cannot_be_resurrected_by_await() {
        let (mut s, sheet) = dirty_dependent_session();
        let op = s.start_recalc(RecalcKind::Dirty).unwrap();
        s.close().unwrap();
        assert_eq!(s.lifecycle_state(), LifecycleState::Closed);
        // close() terminalized the stranded op as Canceled (not left Running).
        assert_eq!(s.operation_status(op).unwrap(), OperationState::Canceled);
        // await_recalc rejects on the terminal session and does NOT recompute.
        let err = s.await_recalc(op).unwrap_err();
        assert_eq!(err.code, "invalid_state");
        assert_eq!(
            s.lifecycle_state(),
            LifecycleState::Closed,
            "the session must stay Closed — never resurrected to Ready"
        );
        // A subsequent mutating command stays rejected (terminal is terminal).
        assert_eq!(
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 9.0 })
                .unwrap_err()
                .code,
            "invalid_state"
        );
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

    // ========================================================================
    // W3 (insert/delete rows & columns) — the REAL owning-session test.
    //
    // THIS is the test that would have caught the production bug: insert/delete
    // were only wired to the dormant `CollabSession`, never to the owning
    // `WorkbookSession` the product grid runs on. These drive the REAL
    // `WorkbookSession` (not a mock) and assert the SILENT-CORRUPTION-class
    // invariant: after a structural edit a formula ref FOLLOWS its target cell
    // (a ref that stayed pointing at the old coordinate would be silent data
    // corruption) AND the recomputed value is still correct.
    // ========================================================================

    /// Insert a blank row ABOVE a value + a formula: the value moves, the
    /// formula cell moves, its TEXT re-points to follow its input, and the
    /// recomputed value is preserved. The headline anti-silent-corruption test.
    #[test]
    fn owning_session_insert_rows_shifts_values_and_repoints_formula() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        // A1 = 10 (row 0), A3 = 30 (row 2), D3 = `=A3*10` (row 2, col 3) → 300.
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_formula(addr(sheet, 2, 3), "A3*10").unwrap();
        // Sanity: D3 == 300, text canonicalized to "A3 * 10".
        let d3 = s.cell(addr(sheet, 2, 3)).unwrap().unwrap();
        assert_eq!(d3.value, Some(CellValue::Number { number: 300.0 }));
        assert_eq!(d3.formula.as_deref(), Some("A3 * 10"));

        // Insert 1 blank row at index 1 (above the 2nd row). Rows >= 1 shift +1.
        s.insert_rows(sheet, 1, 1).unwrap();

        // The blank inserted row 1 is empty; A1 (row 0) is untouched.
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 })
        );
        assert!(
            s.cell(addr(sheet, 1, 0)).unwrap().is_none(),
            "inserted row 1 must be blank"
        );
        // The value 30 moved A3(row2) → A4(row3); the OLD A3 is now blank.
        assert!(
            s.cell(addr(sheet, 2, 0)).unwrap().is_none(),
            "old A3 (row 2) must be vacated by the insert"
        );
        assert_eq!(
            s.cell(addr(sheet, 3, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "value 30 must move A3 → A4"
        );
        // The formula cell moved D3(row2) → D4(row3); its TEXT now reads
        // "A4 * 10" (the ref FOLLOWED the cell — NOT still "A3 * 10", which
        // would be the silent corruption), and it recomputes to 300.
        assert!(
            s.cell(addr(sheet, 2, 3)).unwrap().is_none(),
            "old D3 (row 2) must be vacated by the insert"
        );
        let d4 = s.cell(addr(sheet, 3, 3)).unwrap().unwrap();
        assert_eq!(
            d4.formula.as_deref(),
            Some("A4 * 10"),
            "formula ref must FOLLOW its target cell (A3 → A4), not stay stale"
        );
        assert_eq!(
            d4.value,
            Some(CellValue::Number { number: 300.0 }),
            "recomputed value must still be 300 after the shift"
        );
    }

    /// **Wave G2 (engine-filter) e2e.** The full hidden-row → SUBTOTAL path on
    /// the REAL `WorkbookSession`: `set_rows_hidden` mutates the hidden set AND
    /// dirties the SUBTOTAL dependents, so `recalc_dirty` recomputes
    /// `SUBTOTAL(101..=111)` to SKIP the hidden rows while `SUBTOTAL(1..=11)`
    /// keeps them. Also exercises the `hidden_rows` getter and the unhide path.
    #[test]
    fn owning_session_set_rows_hidden_subtotal_skips_then_unhides() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // A1:A4 = 10, 20, 30, 40.
        for (row, v) in [(0, 10.0), (1, 20.0), (2, 30.0), (3, 40.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        // B1 = SUBTOTAL(109, A1:A4) (SUM skip-hidden); B2 = SUBTOTAL(9, A1:A4).
        s.set_formula(addr(sheet, 0, 1), "SUBTOTAL(109, A1:A4)").unwrap();
        s.set_formula(addr(sheet, 1, 1), "SUBTOTAL(9, A1:A4)").unwrap();
        let b = |s: &WorkbookSession, row| s.cell(addr(sheet, row, 1)).unwrap().unwrap().value;
        // All visible → both 100.
        assert_eq!(b(&s, 0), Some(CellValue::Number { number: 100.0 }));
        assert_eq!(b(&s, 1), Some(CellValue::Number { number: 100.0 }));

        // Hide row index 1 (A2 = 20) and recompute.
        s.set_rows_hidden(sheet, &[1], true).unwrap();
        s.recalc_dirty().unwrap();
        // 109 SKIPS A2 → 100 - 20 = 80; 9 keeps it → 100.
        assert_eq!(
            b(&s, 0),
            Some(CellValue::Number { number: 80.0 }),
            "SUBTOTAL(109) must skip the hidden row after recalc"
        );
        assert_eq!(
            b(&s, 1),
            Some(CellValue::Number { number: 100.0 }),
            "SUBTOTAL(9) must NOT skip hidden rows"
        );
        assert_eq!(s.hidden_rows(sheet).unwrap(), vec![1]);

        // Unhide → B1 back to 100.
        s.set_rows_hidden(sheet, &[1], false).unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(b(&s, 0), Some(CellValue::Number { number: 100.0 }));
        assert!(s.hidden_rows(sheet).unwrap().is_empty());
    }

    /// **Wave G2 (engine-filter) — formula IN a hidden row + undo (audit LOWs).**
    /// (1) A non-SUBTOTAL formula living INSIDE a hidden row still computes
    /// (firing `on_set_value` on a formula cell is a harmless idempotent
    /// re-eval). (2) `undo` of a `SetRowsHidden` restores BOTH the hidden set
    /// AND recomputes the visibility-sensitive SUBTOTAL (via `rematerialize`).
    #[test]
    fn owning_session_formula_in_hidden_row_and_undo_restores() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (row, v) in [(0, 10.0), (1, 20.0), (2, 30.0), (3, 40.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        // A plain formula cell that LIVES IN the row we will hide (C3 = A1 + A2).
        s.set_formula(addr(sheet, 2, 2), "A1 + A2").unwrap();
        // A SUBTOTAL that will skip the hidden row.
        s.set_formula(addr(sheet, 0, 1), "SUBTOTAL(109, A1:A4)").unwrap();
        let v = |s: &WorkbookSession, r, c| s.cell(addr(sheet, r, c)).unwrap().unwrap().value;
        assert_eq!(v(&s, 0, 1), Some(CellValue::Number { number: 100.0 }));
        assert_eq!(v(&s, 2, 2), Some(CellValue::Number { number: 30.0 }));

        // Hide row 2 (A3 = 30, and the formula cell C3 lives there). Recompute.
        s.set_rows_hidden(sheet, &[2], true).unwrap();
        s.recalc_dirty().unwrap();
        // The plain formula IN the hidden row still computes (visibility-agnostic).
        assert_eq!(
            v(&s, 2, 2),
            Some(CellValue::Number { number: 30.0 }),
            "a non-SUBTOTAL formula in a hidden row still evaluates"
        );
        // SUBTOTAL(109) skips the hidden row 2 (A3 = 30) → 100 - 30 = 70.
        assert_eq!(v(&s, 0, 1), Some(CellValue::Number { number: 70.0 }));
        assert_eq!(s.hidden_rows(sheet).unwrap(), vec![2]);

        // Undo the hide → rematerialize restores the empty hidden set AND
        // recomputes the SUBTOTAL back to 100 (no explicit recalc needed).
        assert!(s.undo().unwrap().consumed);
        assert!(
            s.hidden_rows(sheet).unwrap().is_empty(),
            "undo restores the hidden set"
        );
        assert_eq!(
            v(&s, 0, 1),
            Some(CellValue::Number { number: 100.0 }),
            "undo recomputes the SUBTOTAL back to the all-visible value"
        );
    }

    /// **GAP-R-01 regression (2026-06-30, COR-1) — the real trigger.** `undo` →
    /// `rematerialize` replays the op-log onto the baseline; `Op::PutFormula` is
    /// TEXT-ONLY, so the replayed formula cells carry no computed value, and the
    /// subsequent full-pass `recompute_all` must resolve a deep chain in
    /// dependency-first order. The historical bug evaluated that pass in randomized
    /// `iter_formulas()` HashMap order, so a cell could read its precedent before it
    /// was computed → a silent, non-deterministic wrong value that STUCK across the
    /// undo. The 16-link chain makes an accidental-correct HashMap order (~1/16!)
    /// effectively impossible, so this fails pre-fix and passes deterministically post-fix.
    #[test]
    fn gap_r_01_undo_rematerialize_preserves_deep_valueless_chain() {
        const N: u32 = 16;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // A1 = 1 (a plain value); A2..A16 each = the cell above + 1.
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        for k in 1..N {
            // cell at 0-based row k is A(k+1); its precedent A(k) is 1-based row `k`.
            s.set_formula(addr(sheet, k, 0), &format!("A{k}+1")).unwrap();
        }
        let v = |s: &WorkbookSession, row| s.cell(addr(sheet, row, 0)).unwrap().unwrap().value;
        // Live editing already computed the chain in topo order (recompute_dirty path).
        assert_eq!(v(&s, N - 1), Some(CellValue::Number { number: N as f64 }));

        // An edit we will undo: A1 = 100 cascades the whole chain.
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 100.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            v(&s, N - 1),
            Some(CellValue::Number {
                number: (N as f64) + 99.0
            })
        );

        // UNDO → rematerialize → recompute_all over the replayed (valueless) chain.
        assert!(s.undo().unwrap().consumed);
        // A1 is the restored base value; A2..A16 must be topo-correct through the
        // valueless full-pass recompute (the GAP-R-01 trigger).
        assert_eq!(v(&s, 0), Some(CellValue::Number { number: 1.0 }));
        for k in 1..N {
            assert_eq!(
                v(&s, k),
                Some(CellValue::Number {
                    number: (k + 1) as f64
                }),
                "after undo, A{} must be topo-correct through rematerialize (GAP-R-01)",
                k + 1
            );
        }
    }

    /// **SUBTOTAL nested-skip (2026-06-29) — the core behavior.** A grand-total
    /// `SUBTOTAL` over a range that contains intermediate `SUBTOTAL` cells must
    /// ignore those nested subtotals (the "subtotal of subtotals" guard), for
    /// BOTH the 1..=11 (`9`) and 101..=111 (`109`) bands, regardless of hidden
    /// rows. Layout: A3 and A6 are nested subtotals over the runs above them.
    #[test]
    fn owning_session_subtotal_nested_skip_sum() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (row, v) in [(0, 10.0), (1, 20.0), (3, 40.0), (4, 50.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        // A3 = SUBTOTAL(9, A1:A2) = 30 (nested); A6 = SUBTOTAL(9, A4:A5) = 90 (nested).
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(9, A1:A2)").unwrap();
        s.set_formula(addr(sheet, 5, 0), "SUBTOTAL(9, A4:A5)").unwrap();
        // The nested subtotals themselves compute over plain-number runs.
        let a = |s: &WorkbookSession, row| s.cell(addr(sheet, row, 0)).unwrap().unwrap().value;
        assert_eq!(a(&s, 2), Some(CellValue::Number { number: 30.0 }));
        assert_eq!(a(&s, 5), Some(CellValue::Number { number: 90.0 }));

        // Grand totals over the whole column INCLUDING the nested-subtotal cells.
        // Without nested-skip this would be 10+20+30+40+50+90 = 240; the guard
        // drops A3 (30) and A6 (90) → 10+20+40+50 = 120, for BOTH bands.
        s.set_formula(addr(sheet, 0, 1), "SUBTOTAL(9, A1:A6)").unwrap();
        s.set_formula(addr(sheet, 1, 1), "SUBTOTAL(109, A1:A6)").unwrap();
        let b = |s: &WorkbookSession, row| s.cell(addr(sheet, row, 1)).unwrap().unwrap().value;
        assert_eq!(
            b(&s, 0),
            Some(CellValue::Number { number: 120.0 }),
            "SUBTOTAL(9) must skip nested SUBTOTAL cells A3 + A6"
        );
        assert_eq!(
            b(&s, 1),
            Some(CellValue::Number { number: 120.0 }),
            "SUBTOTAL(109) must skip nested SUBTOTAL cells A3 + A6 (no rows hidden)"
        );
    }

    /// **SUBTOTAL nested-skip — count / counta / average / max / min / product.**
    /// Each function-num must EXCLUDE (not just zero-out) the nested cells: COUNT
    /// drops them from the tally, COUNTA from the non-blank tally, AVERAGE from
    /// both numerator and denominator, PRODUCT from the running product (a 0 would
    /// be catastrophic), MAX/MIN from the extremes.
    #[test]
    fn owning_session_subtotal_nested_skip_all_reducers() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // A1=2, A2=3, A4=4 plain; A3 = SUBTOTAL(6, A1:A2) = 6 (nested product).
        for (row, v) in [(0, 2.0), (1, 3.0), (3, 4.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(6, A1:A2)").unwrap();
        // Overwrite the SAME result cell (B1) per function-num; set_formula
        // recomputes synchronously. Range A1:A4 = [2, 3, <nested 6>, 4]; the
        // guard skips A3 every time.
        let eval = |s: &mut WorkbookSession, num: &str| {
            s.set_formula(addr(sheet, 0, 1), num).unwrap();
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value
        };
        // PRODUCT(6): 2*3*4 = 24 (NOT 2*3*6*4 = 144 — and never *0*).
        assert_eq!(
            eval(&mut s, "SUBTOTAL(6, A1:A4)"),
            Some(CellValue::Number { number: 24.0 })
        );
        // COUNT(2): 3 numbers (A1,A2,A4), not 4.
        assert_eq!(
            eval(&mut s, "SUBTOTAL(2, A1:A4)"),
            Some(CellValue::Number { number: 3.0 })
        );
        // COUNTA(3): 3 non-blank (A1,A2,A4), not 4.
        assert_eq!(
            eval(&mut s, "SUBTOTAL(3, A1:A4)"),
            Some(CellValue::Number { number: 3.0 })
        );
        // AVERAGE(1): (2+3+4)/3 = 3, not (2+3+6+4)/4 = 3.75.
        assert_eq!(
            eval(&mut s, "SUBTOTAL(1, A1:A4)"),
            Some(CellValue::Number { number: 3.0 })
        );
        // MAX(4): max(2,3,4) = 4 (the nested 6 is excluded, else it'd be 6).
        assert_eq!(
            eval(&mut s, "SUBTOTAL(4, A1:A4)"),
            Some(CellValue::Number { number: 4.0 })
        );
        // MIN(5): min(2,3,4) = 2.
        assert_eq!(
            eval(&mut s, "SUBTOTAL(5, A1:A4)"),
            Some(CellValue::Number { number: 2.0 })
        );
        // STDEV.S(7): sample stdev of {2,3,4} = 1.0 (the nested 6 excluded; with it
        // the answer would be ~1.708). Exercises the numeric_args (var/stdev) path.
        assert_eq!(
            eval(&mut s, "SUBTOTAL(7, A1:A4)"),
            Some(CellValue::Number { number: 1.0 })
        );
        // VAR.S(10): sample variance of {2,3,4} = 1.0 (with the nested 6 it'd be ~2.92).
        assert_eq!(
            eval(&mut s, "SUBTOTAL(10, A1:A4)"),
            Some(CellValue::Number { number: 1.0 })
        );
    }

    /// **SUBTOTAL nested-skip × hidden rows compose.** `SUBTOTAL(109)` skips BOTH
    /// hidden rows AND nested-subtotal cells; `SUBTOTAL(9)` skips only the nested
    /// subtotal (keeps the hidden row).
    #[test]
    fn owning_session_subtotal_nested_skip_with_hidden() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // A1=10, A2=20, A4=40 plain; A3 = SUBTOTAL(9, A1:A2) = 30 (nested).
        for (row, v) in [(0, 10.0), (1, 20.0), (3, 40.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(9, A1:A2)").unwrap();
        s.set_formula(addr(sheet, 0, 1), "SUBTOTAL(9, A1:A4)").unwrap();
        s.set_formula(addr(sheet, 1, 1), "SUBTOTAL(109, A1:A4)").unwrap();
        let b = |s: &WorkbookSession, row| s.cell(addr(sheet, row, 1)).unwrap().unwrap().value;
        // All visible: both skip only the nested A3 → 10+20+40 = 70.
        assert_eq!(b(&s, 0), Some(CellValue::Number { number: 70.0 }));
        assert_eq!(b(&s, 1), Some(CellValue::Number { number: 70.0 }));

        // Hide row index 1 (A2 = 20). 109 now also drops A2 → 10+40 = 50;
        // 9 keeps the hidden A2 but still drops the nested A3 → 70.
        s.set_rows_hidden(sheet, &[1], true).unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            b(&s, 0),
            Some(CellValue::Number { number: 70.0 }),
            "SUBTOTAL(9): skip nested A3 only, keep hidden A2"
        );
        assert_eq!(
            b(&s, 1),
            Some(CellValue::Number { number: 50.0 }),
            "SUBTOTAL(109): skip nested A3 AND hidden A2"
        );
    }

    /// **SUBTOTAL nested-skip is ROOT-NODE, matching IronCalc.** Only a cell whose
    /// formula's AST ROOT is a `SUBTOTAL(...)` call is skipped. `=SUBTOTAL(..)+0`
    /// has root `+`, so it is NOT a nested subtotal and is counted normally. (A
    /// naive "formula text contains SUBTOTAL" check would wrongly skip it.)
    #[test]
    fn owning_session_subtotal_nested_skip_is_root_node() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (row, v) in [(0, 10.0), (1, 20.0), (3, 40.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        // A3 = SUBTOTAL(9, A1:A2)+0 = 30 — root is `+`, NOT a nested subtotal.
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(9, A1:A2)+0").unwrap();
        s.set_formula(addr(sheet, 0, 1), "SUBTOTAL(9, A1:A4)").unwrap();
        let b = |s: &WorkbookSession, row| s.cell(addr(sheet, row, 1)).unwrap().unwrap().value;
        // A3 IS counted → 10+20+30+40 = 100 (not 70).
        assert_eq!(
            b(&s, 0),
            Some(CellValue::Number { number: 100.0 }),
            "=SUBTOTAL(..)+0 has root `+` → NOT skipped (root-node semantics)"
        );
    }

    /// **Nested-skip is SUBTOTAL-only — a plain SUM over the same column is
    /// untouched** (the materializer's Blank-substitution is name-gated). SUM
    /// includes the nested-subtotal cell values.
    #[test]
    fn owning_session_sum_over_nested_subtotal_column_is_unmasked() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (row, v) in [(0, 10.0), (1, 20.0), (3, 40.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(9, A1:A2)").unwrap(); // A3 = 30
        s.set_formula(addr(sheet, 0, 1), "SUM(A1:A4)").unwrap();
        let b = s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value;
        // SUM does NOT skip subtotals → 10+20+30+40 = 100.
        assert_eq!(
            b,
            Some(CellValue::Number { number: 100.0 }),
            "plain SUM is not nested-skip-gated → includes the nested subtotal"
        );
    }

    /// **SUBTOTAL nested-skip — 2D multi-column range.** Exercises the
    /// `mask_nested_subtotals` flat-index → (row, col) mapping for BOTH a
    /// column-0 nested cell (`i % cols == 0`) and a column-1 nested cell
    /// (`i % cols == 1`), proving the column axis isn't mis-mapped.
    #[test]
    fn owning_session_subtotal_nested_skip_multi_column() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // A1=1 B1=2 / A2=<nested col0> B2=20 / A3=100 B3=<nested col1>.
        for (row, col, v) in [(0, 0, 1.0), (0, 1, 2.0), (1, 1, 20.0), (2, 0, 100.0)] {
            s.set_value(addr(sheet, row, col), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_formula(addr(sheet, 1, 0), "SUBTOTAL(9, A1:A1)").unwrap(); // A2 = 1  (col 0)
        s.set_formula(addr(sheet, 2, 1), "SUBTOTAL(9, B1:B2)").unwrap(); // B3 = 22 (col 1)
        // Grand total over the whole 3×2 block A1:B3. Keep A1,B1,B2,A3 = 1+2+20+100;
        // skip the two nested cells A2 (col 0) and B3 (col 1). Without skip: 1+2+1+20+100+22 = 146.
        s.set_formula(addr(sheet, 4, 0), "SUBTOTAL(9, A1:B3)").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 4, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 123.0 }),
            "2D range: both the col-0 and col-1 nested subtotals must be skipped"
        );
    }

    /// **SUBTOTAL nested-skip — multiple range args.** Masking is applied
    /// per-range-arg in the materializer; a nested subtotal in the FIRST range is
    /// skipped while a second (clean) range is summed in full.
    #[test]
    fn owning_session_subtotal_nested_skip_multi_range() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (row, col, v) in [(0, 0, 10.0), (1, 0, 20.0), (0, 2, 1.0), (1, 2, 2.0), (2, 2, 3.0)] {
            s.set_value(addr(sheet, row, col), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(9, A1:A2)").unwrap(); // A3 = 30 (nested)
        // SUBTOTAL(9, A1:A3, C1:C3): (A1+A2, skip A3) + (C1+C2+C3) = 30 + 6 = 36.
        s.set_formula(addr(sheet, 4, 0), "SUBTOTAL(9, A1:A3, C1:C3)").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 4, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 36.0 }),
            "nested subtotal in the first range arg skipped; second range summed in full"
        );
    }

    /// **SUBTOTAL nested-skip — structured (table-column) ref arg.** Covers the
    /// SECOND materializer call site (the `ExprPlan::StructuredRef` arm): a
    /// `SUBTOTAL` over a table column whose data contains a nested SUBTOTAL cell
    /// skips that cell, identical to the literal-range path.
    #[test]
    fn owning_session_subtotal_nested_skip_structured_ref() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.create_table(TableSpec {
            name: "T".into(),
            sheet,
            top_row: 0,
            top_col: 0,
            rows: 4, // header row + 3 data rows
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["Amt".into()],
        })
        .unwrap();
        // Data range A2:A4: A2=10, A3=20, A4=SUBTOTAL(9,A2:A3)=30 (nested, in-column).
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_formula(addr(sheet, 3, 0), "SUBTOTAL(9, A2:A3)").unwrap();
        // Grand total over the table column → resolves to data range A2:A4; skip A4.
        s.set_formula(addr(sheet, 0, 2), "SUBTOTAL(9, T[Amt])").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "structured-ref arm: nested subtotal in the table column is skipped (10+20, not 60)"
        );
    }

    /// **SUBTOTAL nested-skip inside a LET body (LocalScopedEnv forwarding).** A
    /// SUBTOTAL with a DIRECT worksheet range evaluated inside a `LET`/`LAMBDA`
    /// body still skips nested subtotals — the local-scope env wrapper must forward
    /// `cell_is_subtotal` to the inner workbook env, else the trait default (false)
    /// silently disables nested-skip inside LET. (Codex r2 HIGH.)
    #[test]
    fn owning_session_subtotal_nested_skip_inside_let() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (row, v) in [(0, 10.0), (1, 20.0), (3, 40.0)] {
            s.set_value(addr(sheet, row, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_formula(addr(sheet, 2, 0), "SUBTOTAL(9, A1:A2)").unwrap(); // A3 = 30 (nested)
        // The SUBTOTAL's range A1:A4 is a DIRECT worksheet range (provenance present),
        // evaluated inside a LET body → nested A3 must still be skipped → 0+10+20+40 = 70.
        // `x` is referenced so the LET binding is unambiguously used.
        s.set_formula(addr(sheet, 0, 1), "LET(x, 0, x + SUBTOTAL(9, A1:A4))")
            .unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 70.0 }),
            "nested-skip must work inside a LET body (LocalScopedEnv forwards cell_is_subtotal)"
        );
    }

    /// **NETWORKDAYS / WORKDAY holiday RANGE arg, end-to-end (W5-74 holiday
    /// tier — closes GAP-F-09 / GAP-F-10).** Exercises the FULL path that the
    /// date_fns unit tests cannot: the binder must admit the holiday range
    /// (`ArgContext::Aggregate`) so it binds as a `RangeRef`, the ql-exec
    /// dispatcher must materialize it as `FnArg::Range` through the new
    /// range-AND-context-aware arm, and the fn must subtract / skip the
    /// holidays. Only a real worksheet range proves the binder + dispatcher
    /// half.
    #[test]
    fn owning_session_networkdays_workday_holiday_range() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v = |s: &WorkbookSession, r, c| s.cell(addr(sheet, r, c)).unwrap().unwrap().value;
        // Holiday cells: B1 = 2024-01-03 (Wed), B2 = 2024-01-04 (Thu),
        // B3 = 2024-01-02 (Tue). Holiday cells are themselves formulas.
        s.set_formula(addr(sheet, 0, 1), "DATE(2024,1,3)").unwrap();
        s.set_formula(addr(sheet, 1, 1), "DATE(2024,1,4)").unwrap();
        s.set_formula(addr(sheet, 2, 1), "DATE(2024,1,2)").unwrap();

        // NETWORKDAYS(2024-01-01 Mon .. 2024-01-05 Fri) = 5 working days; minus
        // the two holidays in B1:B2 → 3.
        s.set_formula(
            addr(sheet, 0, 2),
            "NETWORKDAYS(DATE(2024,1,1), DATE(2024,1,5), B1:B2)",
        )
        .unwrap();
        assert_eq!(
            v(&s, 0, 2),
            Some(CellValue::Number { number: 3.0 }),
            "NETWORKDAYS must subtract the 2 holidays in B1:B2 (binder admits the \
             range + new dispatcher arm materializes it as FnArg::Range)"
        );

        // Control: the same span WITHOUT holidays → 5. Proves the subtraction
        // is the holiday range, not an unrelated change.
        s.set_formula(addr(sheet, 1, 2), "NETWORKDAYS(DATE(2024,1,1), DATE(2024,1,5))")
            .unwrap();
        assert_eq!(v(&s, 1, 2), Some(CellValue::Number { number: 5.0 }));

        // WORKDAY(2024-01-01 Mon, +1) is normally Tue 01-02; with 01-02 a
        // holiday in B3:B3, the next working day is Wed 01-03 — equal to B1.
        s.set_formula(addr(sheet, 0, 3), "WORKDAY(DATE(2024,1,1), 1, B3:B3)")
            .unwrap();
        assert_eq!(
            v(&s, 0, 3),
            v(&s, 0, 1),
            "WORKDAY must skip the holiday in B3:B3 and land on 2024-01-03 (== B1)"
        );

        // **Codex r1 HIGH regression guard, end-to-end.** A LITERAL 1-cell
        // range `A1:A1` in a DATE slot (the same 1×1 FnArg::Range a `[@Col]`
        // structured ref narrows to) must unwrap to its value — NOT regress to
        // #VALUE! now that NETWORKDAYS carries ArgContext::Aggregate. A1/A2 hold
        // the span dates; NETWORKDAYS(A1:A1, A2:A2) = 5.
        s.set_formula(addr(sheet, 0, 0), "DATE(2024,1,1)").unwrap(); // A1
        s.set_formula(addr(sheet, 1, 0), "DATE(2024,1,5)").unwrap(); // A2
        s.set_formula(addr(sheet, 4, 0), "NETWORKDAYS(A1:A1, A2:A2)")
            .unwrap();
        assert_eq!(
            v(&s, 4, 0),
            Some(CellValue::Number { number: 5.0 }),
            "a 1×1 range in a scalar date slot must unwrap (regression guard)"
        );
    }

    /// **CROSS-SHEET on the owning session (megaudit L2 closure).** A formula
    /// on Sheet2 that references Sheet1!A3 must, when a row is inserted on
    /// Sheet1, have its TEXT rewritten (Sheet1!A3 → Sheet1!A4) while its own
    /// POSITION on Sheet2 stays put (Sheet2 was not edited). This is the exact
    /// "correct in one session class but broken in the path the product runs
    /// on" blind spot that left insert/delete a no-op on the owning Session —
    /// so it is pinned here against the REAL `WorkbookSession`, not a mock.
    #[test]
    fn owning_session_insert_rows_repoints_cross_sheet_ref_and_keeps_position() {
        let mut s = WorkbookSession::new();
        let s1 = s.add_sheet("Sheet1", 16384).unwrap();
        let s2 = s.add_sheet("Sheet2", 16384).unwrap();
        // Sheet1: A1=10 (row0), A3=30 (row2). Sheet2: B1 = `=Sheet1!A3*10` → 300.
        s.set_value(addr(s1, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(s1, 2, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_formula(addr(s2, 0, 1), "Sheet1!A3*10").unwrap();
        let b1 = s.cell(addr(s2, 0, 1)).unwrap().unwrap();
        assert_eq!(b1.value, Some(CellValue::Number { number: 300.0 }));
        let pre = b1.formula.as_deref().unwrap().to_string();
        assert!(
            pre.contains("A3"),
            "precondition: ref is to A3, got {pre:?}"
        );

        // Insert a blank row at index 1 on SHEET1. Sheet1!A3(30) → Sheet1!A4.
        s.insert_rows(s1, 1, 1).unwrap();

        // Sheet1 side moved: old A3 (row2) blank, value 30 now at A4 (row3).
        assert!(
            s.cell(addr(s1, 2, 0)).unwrap().is_none(),
            "Sheet1 A3 (row2) must be vacated"
        );
        assert_eq!(
            s.cell(addr(s1, 3, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "Sheet1 value 30 must move A3 → A4"
        );
        // Sheet2's formula cell did NOT move (Sheet2 was not the edited sheet),
        // but its TEXT followed the cross-sheet ref (A3 → A4), and it recomputes
        // to 300 against the moved Sheet1!A4. A stale ref would read the now-blank
        // Sheet1!A3 → 0 (the silent cross-sheet corruption).
        let b1_after = s.cell(addr(s2, 0, 1)).unwrap().unwrap();
        let post = b1_after.formula.as_deref().unwrap().to_string();
        assert!(
            post.contains("A4") && !post.contains("A3"),
            "cross-sheet ref text must follow A3 → A4 (no longer stale); got {post:?}"
        );
        assert_eq!(
            b1_after.value,
            Some(CellValue::Number { number: 300.0 }),
            "cross-sheet formula must recompute to 300 against the moved Sheet1!A4"
        );
    }

    /// Delete the inserted row to shift everything back: the inverse of the
    /// insert test. The formula ref must follow the cell back (A4 → A3).
    #[test]
    fn owning_session_delete_rows_shifts_back_and_repoints_formula() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        // Author the POST-insert state directly: A1=10, A4=30, D4=`=A4*10`.
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 3, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_formula(addr(sheet, 3, 3), "A4*10").unwrap();

        // Delete the INCLUSIVE block [1, 1] (the blank row 1). Rows > 1 shift -1.
        s.delete_rows(sheet, 1, 1).unwrap();

        // A1 untouched; value 30 moved A4(row3) → A3(row2); formula D4 → D3
        // with text "A3 * 10" (ref followed back), still 300.
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 })
        );
        assert_eq!(
            s.cell(addr(sheet, 2, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "value 30 must move A4 → A3 on delete"
        );
        let d3 = s.cell(addr(sheet, 2, 3)).unwrap().unwrap();
        assert_eq!(
            d3.formula.as_deref(),
            Some("A3 * 10"),
            "formula ref must follow the cell back (A4 → A3)"
        );
        assert_eq!(d3.value, Some(CellValue::Number { number: 300.0 }));
    }

    /// Insert a blank COLUMN to the left of a value + formula: the column
    /// analog of the row insert test (refs shift on the col axis).
    #[test]
    fn owning_session_insert_columns_shifts_values_and_repoints_formula() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        // C1 = 30 (row 0, col 2), E1 = `=C1*10` (row 0, col 4) → 300.
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 4), "C1*10").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 300.0 })
        );

        // Insert 1 blank column at index 1 (col B). Cols >= 1 shift +1: C → D,
        // E → F; the C1 ref becomes D1.
        s.insert_columns(sheet, 1, 1).unwrap();

        // Value 30 moved C1(col2) → D1(col3).
        assert!(s.cell(addr(sheet, 0, 2)).unwrap().is_none());
        assert_eq!(
            s.cell(addr(sheet, 0, 3)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "value 30 must move C1 → D1"
        );
        // Formula moved E1(col4) → F1(col5) with text "D1 * 10", still 300.
        let f1 = s.cell(addr(sheet, 0, 5)).unwrap().unwrap();
        assert_eq!(
            f1.formula.as_deref(),
            Some("D1 * 10"),
            "formula ref must FOLLOW C1 → D1 on a column insert"
        );
        assert_eq!(f1.value, Some(CellValue::Number { number: 300.0 }));
    }

    /// Deleting the row a formula REFERENCES turns the ref into `#REF!`; the
    /// referencing cell survives (it's outside the deleted block) and its text
    /// records the broken ref. Deleting the row a formula LIVES ON drops the
    /// formula entirely (its own cell is gone — must NOT be resurrected).
    #[test]
    fn owning_session_delete_rows_ref_into_block_becomes_ref_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        // A3 = 30 (row 2); D1 = `=A3*10` (row 0, col 3) references A3.
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 3), "A3*10").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 3)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 300.0 })
        );

        // Delete the INCLUSIVE block [2, 2] (the row A3 lives on). The ref into
        // the deleted block becomes #REF!; D1 (row 0) is above the block, so it
        // stays put but its text now carries the broken ref.
        s.delete_rows(sheet, 2, 2).unwrap();

        let d1 = s.cell(addr(sheet, 0, 3)).unwrap().unwrap();
        assert_eq!(
            d1.formula.as_deref(),
            Some("#REF! * 10"),
            "a ref into the deleted block must become #REF!"
        );
        assert_eq!(
            d1.value,
            Some(CellValue::Error {
                error: "#REF!".to_string()
            }),
            "a formula over a #REF! ref must evaluate to the #REF! error value"
        );
        // The vacated A3 cell is gone.
        assert!(s.cell(addr(sheet, 2, 0)).unwrap().is_none());
    }

    /// Deleting the row a formula LIVES ON drops the formula — its own cell is
    /// gone, and the producer must NOT resurrect it via a stale `PutFormula`.
    #[test]
    fn owning_session_delete_rows_drops_formula_on_deleted_own_cell() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        // A1 = 5 (row 0); D2 = `=A1*10` (row 1, col 3) → 50, lives on row 1.
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.set_formula(addr(sheet, 1, 3), "A1*10").unwrap();
        assert_eq!(
            s.cell(addr(sheet, 1, 3)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 50.0 })
        );

        // Delete the row the formula LIVES ON ([1, 1]).
        s.delete_rows(sheet, 1, 1).unwrap();

        // The formula cell is gone — NOT resurrected at row 0 or anywhere.
        assert!(
            s.cell(addr(sheet, 1, 3)).unwrap().is_none(),
            "deleted formula's old cell must be empty"
        );
        assert!(
            s.cell(addr(sheet, 0, 3)).unwrap().is_none(),
            "deleted formula must NOT be resurrected at the shifted-up position"
        );
        // A1 (above the deleted block) is untouched.
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 5.0 })
        );
    }

    /// A structural edit on the owning session is gated like every mutation:
    /// off a Ready session it is `[invalid_state]`; an unknown sheet is
    /// NotFound; a malformed edit (count==0) is a loud `[bad_argument]`.
    #[test]
    fn owning_session_structural_edit_validation() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Unknown sheet → NotFound (not a silent no-op).
        assert_eq!(
            s.insert_rows(9999, 0, 1).unwrap_err().class,
            ErrorClass::NotFound
        );
        // count == 0 → loud BadArgument (the preflight rejects it).
        assert_eq!(
            s.insert_rows(sheet, 0, 0).unwrap_err().class,
            ErrorClass::BadArgument
        );
        // start > end → loud BadArgument.
        assert_eq!(
            s.delete_rows(sheet, 5, 2).unwrap_err().class,
            ErrorClass::BadArgument
        );
        // Closed session → invalid_state for a structural edit.
        s.close().unwrap();
        assert_eq!(
            s.insert_rows(sheet, 0, 1).unwrap_err().code,
            "invalid_state"
        );
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

    #[test]
    fn chart_crud_round_trip_on_session() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        let id_a = s
            .add_chart(
                "A",
                ql_storage::ChartKind::Line,
                sid,
                0,
                0,
                300,
                200,
                ql_types::Range::new(sid, 0, 0, 9, 0),
                Some("Title A".to_string()),
            )
            .unwrap();
        let id_b = s
            .add_chart(
                "B",
                ql_storage::ChartKind::Bar,
                sid,
                5,
                5,
                300,
                200,
                ql_types::Range::new(sid, 0, 1, 9, 1),
                None,
            )
            .unwrap();
        assert_ne!(id_a, id_b, "allocated ids are distinct");
        assert_eq!(s.list_charts().unwrap().len(), 2);

        // update A: change kind + name + drop the title
        s.update_chart(
            id_a,
            "A2",
            ql_storage::ChartKind::Scatter,
            sid,
            1,
            1,
            400,
            300,
            ql_types::Range::new(sid, 0, 0, 4, 0),
            None,
        )
        .unwrap();
        let charts = s.list_charts().unwrap();
        let a = charts.iter().find(|c| c.id == id_a).unwrap();
        assert_eq!(a.chart_type, ql_storage::ChartKind::Scatter);
        assert_eq!(a.name, "A2");
        assert_eq!(a.title, None);

        // update / remove a missing id → NotFound (fail loud, No-Fallbacks)
        assert_eq!(
            s.update_chart(
                9999,
                "x",
                ql_storage::ChartKind::Line,
                sid,
                0,
                0,
                1,
                1,
                ql_types::Range::new(sid, 0, 0, 0, 0),
                None,
            )
            .unwrap_err()
            .class,
            ErrorClass::NotFound
        );
        s.remove_chart(id_b).unwrap();
        assert_eq!(s.remove_chart(9999).unwrap_err().class, ErrorClass::NotFound);
        assert_eq!(s.list_charts().unwrap().len(), 1);
    }

    /// **w119 BLOCKER regression.** Every chart mutation on the owning session
    /// must force `snapshot_delta` to report `full_rebuild_required`. Chart
    /// objects have NO incremental delta representation (no `WorkbookSnapshotDelta`
    /// field, no `SessionChange` variant), so without an epoch bump the mutation
    /// is silently lost for the IDE (it never learns to re-pull `list_charts`).
    /// Mirrors `snapshot_delta_table_op_forces_epoch_mismatch`.
    #[test]
    fn snapshot_delta_chart_op_forces_full_rebuild() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();

        // add_chart bumps the epoch -> a prior token gets EpochMismatch.
        let v0 = s.snapshot().unwrap().version;
        let id = s
            .add_chart(
                "A",
                ql_storage::ChartKind::Line,
                sid,
                0,
                0,
                300,
                200,
                ql_types::Range::new(sid, 0, 0, 9, 0),
                None,
            )
            .unwrap();
        let d = s.snapshot_delta(&v0).unwrap();
        assert!(d.full_rebuild_required, "add_chart must force a full rebuild");
        assert_eq!(d.full_rebuild_reason, Some(FullRebuildReason::EpochMismatch));

        // update_chart bumps the epoch.
        let v1 = s.snapshot().unwrap().version;
        s.update_chart(
            id,
            "A2",
            ql_storage::ChartKind::Bar,
            sid,
            1,
            1,
            400,
            300,
            ql_types::Range::new(sid, 0, 0, 4, 0),
            None,
        )
        .unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        assert!(
            d.full_rebuild_required,
            "update_chart must force a full rebuild"
        );
        assert_eq!(d.full_rebuild_reason, Some(FullRebuildReason::EpochMismatch));

        // remove_chart bumps the epoch.
        let v2 = s.snapshot().unwrap().version;
        s.remove_chart(id).unwrap();
        let d = s.snapshot_delta(&v2).unwrap();
        assert!(
            d.full_rebuild_required,
            "remove_chart must force a full rebuild"
        );
        assert_eq!(d.full_rebuild_reason, Some(FullRebuildReason::EpochMismatch));

        // A FAILED chart op changed nothing -> it must NOT bump the epoch (no
        // spurious full rebuild). `bump_epoch` sits behind the `?`, so the early
        // error return skips it.
        let v3 = s.snapshot().unwrap().version;
        assert!(s.remove_chart(9999).is_err());
        let d = s.snapshot_delta(&v3).unwrap();
        assert!(
            !d.full_rebuild_required,
            "a failed chart op must not force a rebuild"
        );
    }

    /// **w119 MED pin.** `list_charts` returns charts on a tombstoned sheet,
    /// consistent with the table read surface (`collect_tables`). Tombstoning is
    /// reversible (`restore_sheet`), so the engine preserves the chart and the
    /// IDE does the visibility filtering. Guards against a future "filter dead
    /// sheets" change that would diverge from the table surface and silently
    /// drop a chart that `restore_sheet` is meant to bring back.
    #[test]
    fn list_charts_retains_charts_on_tombstoned_sheet() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        // A second sheet so deleting the first is not a delete-last-sheet refusal.
        s.add_sheet("Keep", 16384).unwrap();
        let id = s
            .add_chart(
                "A",
                ql_storage::ChartKind::Line,
                sid,
                0,
                0,
                300,
                200,
                ql_types::Range::new(sid, 0, 0, 9, 0),
                None,
            )
            .unwrap();
        assert_eq!(s.list_charts().unwrap().len(), 1);

        // Delete the chart's anchor sheet -> tombstoned, NOT erased.
        s.delete_sheet(sid).unwrap();
        let charts = s.list_charts().unwrap();
        assert_eq!(charts.len(), 1, "tombstoned-sheet chart is still listed");
        assert_eq!(charts[0].id, id);

        // Restore brings the sheet (and its untouched chart) back.
        s.restore_sheet(sid).unwrap();
        assert_eq!(s.list_charts().unwrap().len(), 1);
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

    /// **R9 / Wave B (2026-06-17):** `nudge_cell_decimals` increases/decreases
    /// a cell's rendered precision through the full session path (the rendered
    /// string is what the IDE grid shows).
    #[test]
    fn nudge_cell_decimals_changes_rendered_precision() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.5 })
            .unwrap();
        let fmt = s.register_format("0.00").unwrap();
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.rendered.as_deref(), Some("1.50"));

        // Increase one decimal → "0.000" → "1.500".
        s.nudge_cell_decimals(addr(sheet, 0, 0), 1).unwrap();
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.rendered.as_deref(), Some("1.500"));

        // Decrease two decimals → "0.0" → "1.5".
        s.nudge_cell_decimals(addr(sheet, 0, 0), -2).unwrap();
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.rendered.as_deref(), Some("1.5"));
    }

    /// **TF8 / Wave-C (2026-06-29): format registration must NOT be an undo
    /// unit ("undo does nothing once").** `register_format` commits its
    /// `Op::RegisterFormat` with `FORMAT_COMMIT_ORIGIN`, which the session's
    /// `UndoManager` excludes. Here three VISIBLE commands run (add_sheet,
    /// set_value, set_format) plus one registration; draining the undo stack
    /// must consume exactly the THREE visible units — the registration adds no
    /// phantom step.
    #[test]
    fn tf8_register_format_is_excluded_from_undo_stack() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap(); // undo unit 1
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap(); // undo unit 2
        let fmt = s.register_format("0.00%").unwrap(); // EXCLUDED — no unit
        s.set_format(addr(sheet, 0, 0), fmt).unwrap(); // undo unit 3

        // First undo reverts the visible SetCellFormat (not a phantom
        // registration): the format binding clears, the value edit survives.
        assert!(s.undo().unwrap().consumed);
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.format, None, "undo must revert the cell's format binding");
        assert_eq!(
            c.value,
            Some(CellValue::Number { number: 5.0 }),
            "the value edit is untouched"
        );

        // Drain the rest and count: exactly the THREE visible commands were undo
        // units; `register_format` contributed NONE.
        let mut consumed = 1; // the undo above
        while s.undo().unwrap().consumed {
            consumed += 1;
        }
        assert_eq!(
            consumed, 3,
            "add_sheet + set_value + set_format are the only undo units; \
             register_format must not add a phantom 'undo does nothing' step"
        );
        assert!(!s.can_undo());
    }

    /// **TF8:** a format committed BETWEEN two undoable edits must SURVIVE an
    /// undo of the later edit — the registration is preserved (Loro treats the
    /// excluded-origin commit as remote-like), so the `FormatId` stays valid and
    /// no cell→format reference can dangle.
    #[test]
    fn tf8_format_survives_undo_of_a_neighbouring_edit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let fmt = s.register_format("0.00%").unwrap(); // excluded
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 2.0 })
            .unwrap();

        // Undo the LAST edit (B1). The format registration committed between A1
        // and B1 must NOT be retracted.
        assert!(s.undo().unwrap().consumed);
        assert!(
            s.cell(addr(sheet, 0, 1)).unwrap().is_none(),
            "B1 reverted by the undo"
        );
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 1.0 }),
            "A1 is intact"
        );

        // The format is still registered: binding A1 to it succeeds (no
        // UnknownFormatId), and re-interning the same string returns the SAME id.
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        assert_eq!(s.cell(addr(sheet, 0, 0)).unwrap().unwrap().format, Some(fmt));
        assert_eq!(
            s.register_format("0.00%").unwrap(),
            fmt,
            "the same string re-interns to the same id (still registered after the undo)"
        );
    }

    /// **TF8:** `nudge_cell_decimals` interns a NEW format AND rebinds the cell
    /// in one command. With the registration excluded, only the `SetCellFormat`
    /// is an undo unit, so ONE undo restores the pre-nudge format.
    #[test]
    fn tf8_nudge_cell_decimals_is_one_undo_unit() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.5 })
            .unwrap();
        let base = s.register_format("0.00").unwrap(); // excluded
        s.set_format(addr(sheet, 0, 0), base).unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().rendered.as_deref(),
            Some("1.50")
        );

        // Nudge interns "0.000" (excluded) and rebinds the cell (one undo unit).
        s.nudge_cell_decimals(addr(sheet, 0, 0), 1).unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().rendered.as_deref(),
            Some("1.500")
        );

        // ONE undo restores the previous (0.00) binding — the intern added no
        // extra unit.
        assert!(s.undo().unwrap().consumed);
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(
            c.rendered.as_deref(),
            Some("1.50"),
            "a single undo restores the pre-nudge format"
        );
        assert_eq!(c.format, Some(base));
    }

    /// **TF8:** `register_style` is symmetric to `register_format` — its
    /// `Op::RegisterStyle` commit is excluded from undo too.
    #[test]
    fn tf8_register_style_is_excluded_from_undo_stack() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap(); // unit 1
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 9.0 })
            .unwrap(); // unit 2
        let sid = s.register_style(bold_style()).unwrap(); // EXCLUDED — no unit
        s.set_style(addr(sheet, 0, 0), sid).unwrap(); // unit 3

        let mut consumed = 0;
        while s.undo().unwrap().consumed {
            consumed += 1;
        }
        assert_eq!(
            consumed, 3,
            "add_sheet + set_value + set_style are the only undo units; \
             register_style must not add a phantom step"
        );
    }

    /// **TF8 correctness guard:** excluding the registration from UNDO must NOT
    /// exclude it from PERSISTENCE. The `Op::RegisterFormat` is still pushed to
    /// the op-log (only the commit ORIGIN differs), so the cell's format survives
    /// a full `.qbook` save/open round-trip.
    #[test]
    fn tf8_registered_format_persists_through_save_open() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("tf8.qbook");
        let path_str = path.to_str().unwrap();

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let fmt = s.register_format("0.00%").unwrap(); // excluded from undo...
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        s.recalc_dirty().unwrap();
        s.save(path_str).unwrap();

        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        let c = s2.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        // ...but NOT from persistence: the registration is durably in the log.
        assert!(
            c.format.is_some(),
            "the registered format must persist across save/open"
        );
        assert_eq!(
            c.rendered.as_deref(),
            Some("100.00%"),
            "the persisted format ('0.00%') is applied after reopen"
        );
    }

    /// **TF8 redo contract:** after undoing a format apply, REDO must re-bind the
    /// cell — the format stayed registered (excluded from undo), so redo of the
    /// `SetCellFormat` references a still-valid id (never a dangling ref).
    #[test]
    fn tf8_redo_reapplies_format_after_undo() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        let fmt = s.register_format("0.00%").unwrap(); // excluded from undo
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(s.cell(addr(sheet, 0, 0)).unwrap().unwrap().format, Some(fmt));

        // Undo the SetCellFormat → cell unformatted (the format stays registered).
        assert!(s.undo().unwrap().consumed);
        assert_eq!(s.cell(addr(sheet, 0, 0)).unwrap().unwrap().format, None);

        // Redo re-applies the SetCellFormat against the still-registered format.
        assert!(s.redo().unwrap().consumed);
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(
            c.format,
            Some(fmt),
            "redo re-binds the cell to the still-registered format"
        );
        assert_eq!(c.rendered.as_deref(), Some("100.00%"));
    }

    /// An unbound (General) cell increased binds an explicit one-decimal format
    /// through the session path; `delta == 0` is a harmless session-level no-op.
    #[test]
    fn nudge_cell_decimals_unbound_and_zero_delta() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // delta 0 → no-op (the napi layer rejects 0; the session treats it as
        // nothing-to-do) → the cell stays unformatted.
        s.nudge_cell_decimals(addr(sheet, 0, 0), 0).unwrap();
        assert!(s.cell(addr(sheet, 0, 0)).unwrap().is_none());

        // Increase an unbound cell → binds "0.0".
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 7.0 })
            .unwrap();
        s.nudge_cell_decimals(addr(sheet, 0, 0), 1).unwrap();
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.rendered.as_deref(), Some("7.0"));
    }

    /// **R9 / Wave C (2026-06-18):** `nudge_decimals_preview` returns the nudged format STRING
    /// WITHOUT mutating the cell, and the string matches what the apply path would bind. This is the
    /// engine half the IDE batches over a selection for a single-undo multi-cell decimal nudge.
    #[test]
    fn nudge_decimals_preview_is_read_only_and_matches_apply() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.5 })
            .unwrap();
        let fmt = s.register_format("0.00").unwrap();
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        s.recalc_dirty().unwrap();

        // Preview the increase → "0.000". The cell must be UNCHANGED (still rendered "1.50").
        let previewed = s.nudge_decimals_preview(addr(sheet, 0, 0), 1).unwrap();
        assert_eq!(previewed.as_deref(), Some("0.000"));
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(
            c.rendered.as_deref(),
            Some("1.50"),
            "preview must NOT rebind the cell"
        );

        // Applying the previewed string (the IDE's registerFormat + batch path) renders "1.500" —
        // i.e. preview agrees with what the apply nudge would have produced.
        let nudged_fmt = s.register_format(previewed.as_deref().unwrap()).unwrap();
        s.set_format(addr(sheet, 0, 0), nudged_fmt).unwrap();
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.rendered.as_deref(), Some("1.500"));

        // A no-op preview (decrease past zero decimals on a "0" cell) returns None.
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 3.0 })
            .unwrap();
        let zero_fmt = s.register_format("0").unwrap();
        s.set_format(addr(sheet, 1, 0), zero_fmt).unwrap();
        assert_eq!(s.nudge_decimals_preview(addr(sheet, 1, 0), -1).unwrap(), None);
    }

    // --- Display-path gap closure (2026-06-10): `rendered` on the OWNING
    // session's snapshot paths. Pre-closure `build_cell_snapshot` hardcoded
    // `rendered: None` (the format-rendering existed only on the dormant
    // `CollabSession` napi paths — the w54 wrong-session-class trap), so the
    // IDE grid showed raw `0.021` for a percent-formatted cell. These tests
    // pin the D4-contract mirror on the product (`WorkbookSession`) path. ---

    /// The headline repro: value `0.021` + format `"0.00%"` → the full
    /// `snapshot()`, the single-cell `cell()`, and the value DTO must agree,
    /// with `rendered` carrying the ENGINE renderer's exact output. The
    /// expected string is DERIVED from `ql_functions::format::render` itself
    /// (same renderer, same parse) and pinned to the literal `"2.10%"` —
    /// consistent with the renderer's own suite (`0.123→"12.30%"`,
    /// `0.25→"25.00%"` in `ql-functions/src/format/render.rs`).
    #[test]
    fn format_carrying_cell_snapshot_includes_engine_rendered_string() {
        // Derive the renderer's real output first (the session builds its
        // EvalContext from the workbook: Excel1900 + EnUs + System — the
        // `EvalContext` default; percent rendering is date-system-agnostic).
        let fmt = ql_functions::format::parse("0.00%").unwrap();
        let expected = ql_functions::format::render(
            &Value::Number(0.021),
            &fmt,
            &ql_types::EvalContext {
                date_system: ql_types::DateSystem::Excel1900,
                locale: ql_types::Locale::EnUs,
                now_provider: ql_types::NowProvider::System,
            },
        );
        assert_eq!(expected, "2.10%", "renderer contract moved under us");

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 1, 1), CellValue::Number { number: 0.021 })
            .unwrap();
        let fmt_id = s.register_format("0.00%").unwrap();
        s.set_format(addr(sheet, 1, 1), fmt_id).unwrap();
        s.recalc_dirty().unwrap();

        // Full-snapshot path (snapshot → build_sheet_snapshot → build_cell_snapshot).
        let snap = s.snapshot().unwrap();
        let cell = snap.sheets[0]
            .cells
            .iter()
            .find(|c| c.row == 1 && c.col == 1)
            .expect("the formatted cell must be in the snapshot");
        assert_eq!(cell.rendered.as_deref(), Some(expected.as_str()));
        assert_eq!(cell.format, Some(fmt_id));
        assert_eq!(cell.value, Some(CellValue::Number { number: 0.021 }));

        // Single-cell path (`cell()`) goes through the same choke point.
        let single = s.cell(addr(sheet, 1, 1)).unwrap().unwrap();
        assert_eq!(single.rendered.as_deref(), Some(expected.as_str()));
    }

    /// A format-only cell (format set, NO committed value) is the owning-
    /// session value-kind that the D4 contract maps to `rendered: None`
    /// (collab vocabulary: `state.value == None` / `Pending` — both read as
    /// `Value::Blank` here). The IDE falls back to its own default display.
    #[test]
    fn format_only_cell_renders_none() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let fmt_id = s.register_format("0.00%").unwrap();
        s.set_format(addr(sheet, 0, 0), fmt_id).unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.format, Some(fmt_id));
        assert_eq!(c.value, None);
        assert_eq!(c.rendered, None, "no value → no pre-render (D4 mirror)");
    }

    /// An ERROR-valued format-carrying cell renders its CANONICAL SIGIL —
    /// mirroring the CollabSession path exactly: a known sigil wire-decodes
    /// to `Value::Error` and `ql_functions::format::render` short-circuits
    /// errors to their sigils (Excel canon: errors never honor the format
    /// string). The collab contract's only error→None arm is the UNKNOWN-
    /// sigil wire-decode failure, which has no owning-session analog
    /// (`Value::Error` is a closed enum). Mirror, don't invent.
    #[test]
    fn error_valued_format_carrying_cell_renders_canonical_sigil() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "1/0").unwrap();
        let fmt_id = s.register_format("0.00%").unwrap();
        s.set_format(addr(sheet, 0, 0), fmt_id).unwrap();
        s.recalc_dirty().unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(
            c.value,
            Some(CellValue::Error {
                error: "#DIV/0!".to_string()
            })
        );
        assert_eq!(
            c.rendered.as_deref(),
            Some("#DIV/0!"),
            "errors render as their sigil (render short-circuit), not None"
        );
    }

    /// An unformatted number cell pre-renders nothing (format `None` →
    /// `rendered None`; the IDE's value-based default rendering applies).
    #[test]
    fn unformatted_number_cell_renders_none() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 0.021 })
            .unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.format, None);
        assert_eq!(c.rendered, None, "no explicit format → no pre-render");
    }

    /// A cell EXPLICITLY formatted with builtin-0 ("General", pre-registered
    /// in `FormatTable::new`) DOES pre-render, through `SectionKind::General`
    /// — exactly what the CollabSession path does (lookup → "General" →
    /// parse → render; no builtin-0 special-casing). `render_general_number`
    /// of a non-integer is the shortest-round-trip `f64` text.
    #[test]
    fn builtin_general_format_renders_via_general_section() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 0.021 })
            .unwrap();
        s.set_format(addr(sheet, 0, 0), FormatId::Builtin { builtin: 0 })
            .unwrap();
        let c = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(c.rendered.as_deref(), Some("0.021"));
    }

    /// The delta path: a changed format-carrying cell arrives in
    /// `snapshot_delta().changed_cells` WITH `rendered` populated (the delta
    /// walk funnels through the same `build_cell_snapshot` choke point —
    /// pre-closure the IDE's incremental refresh showed raw values even if a
    /// full reseed would have, post-closure, rendered them).
    #[test]
    fn snapshot_delta_changed_cells_carry_rendered() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 1, 1), CellValue::Number { number: 0.021 })
            .unwrap();
        let fmt_id = s.register_format("0.00%").unwrap();
        s.set_format(addr(sheet, 1, 1), fmt_id).unwrap();
        s.recalc_dirty().unwrap();
        let delta = s.snapshot_delta(&v0).unwrap();
        assert!(!delta.full_rebuild_required);
        let changed = delta
            .changed_cells
            .iter()
            .find(|c| c.sheet == sheet && c.cell.row == 1 && c.cell.col == 1)
            .expect("the formatted cell must be in changed_cells");
        assert_eq!(changed.cell.rendered.as_deref(), Some("2.10%"));
        assert_eq!(changed.cell.format, Some(fmt_id));
    }

    /// **R9 / Wave B (audit LOW, runtime/session lane):** a nudge that allocates
    /// a NEW custom format must surface it in the delta's `formats_added` (so the
    /// IDE can render the rebound cell) AND list the cell in `changed_cells`.
    #[test]
    fn snapshot_delta_after_nudge_carries_new_format() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.5 })
            .unwrap();
        let fmt = s.register_format("0.00").unwrap();
        s.set_format(addr(sheet, 0, 0), fmt).unwrap();
        s.recalc_dirty().unwrap();
        let v0 = s.snapshot().unwrap().version;
        // Increase → "0.000" (a new custom format id).
        s.nudge_cell_decimals(addr(sheet, 0, 0), 1).unwrap();
        s.recalc_dirty().unwrap();
        let delta = s.snapshot_delta(&v0).unwrap();
        assert!(!delta.full_rebuild_required);
        assert!(
            delta.formats_added.iter().any(|fd| fd.string == "0.000"),
            "nudge's new format must appear in formats_added"
        );
        let changed = delta
            .changed_cells
            .iter()
            .find(|c| c.sheet == sheet && c.cell.row == 0 && c.cell.col == 0)
            .expect("the nudged cell must be in changed_cells");
        assert_eq!(changed.cell.rendered.as_deref(), Some("1.500"));
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

    // ---- H3 (6.3-0): snapshot_delta reports the FULL spill footprint ----

    /// (row, col) pairs of a delta's `changed_cells`.
    fn delta_changed_coords(d: &WorkbookSnapshotDelta) -> Vec<(u32, u32)> {
        d.changed_cells
            .iter()
            .map(|c| (c.cell.row, c.cell.col))
            .collect()
    }
    /// (row, col) pairs of a delta's `removed_cells`.
    fn delta_removed_coords(d: &WorkbookSnapshotDelta) -> Vec<(u32, u32)> {
        d.removed_cells.iter().map(|r| (r.row, r.col)).collect()
    }

    /// Direct `set_formula` of a spill reports EVERY footprint target (not just
    /// the anchor) — the core H3 fix on the direct-mutation path, no recalc.
    #[test]
    fn snapshot_delta_includes_spill_targets_on_set_formula() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        // SEQUENCE(3) spills 3×1 down A1:A3 → 1, 2, 3.
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(3)").unwrap();
        let d = s.snapshot_delta(&v0).unwrap();
        assert!(!d.full_rebuild_required, "same-epoch in-window delta");
        let changed = delta_changed_coords(&d);
        for row in 0..3 {
            assert!(
                changed.contains(&(row, 0)),
                "spill target ({row},0) must be in the delta — got {changed:?}"
            );
        }
        // The target values resolve to the spilled numbers.
        let a3 = d
            .changed_cells
            .iter()
            .find(|c| c.cell.row == 2 && c.cell.col == 0)
            .expect("A3 present");
        assert_eq!(a3.cell.value, Some(CellValue::Number { number: 3.0 }));
    }

    /// A spill that GROWS reports the newly-added targets.
    #[test]
    fn snapshot_delta_spill_grow() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(2)").unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(4)").unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        let changed = delta_changed_coords(&d);
        for row in 0..4 {
            assert!(
                changed.contains(&(row, 0)),
                "grown footprint cell ({row},0) must be in the delta — got {changed:?}"
            );
        }
    }

    /// A spill that SHRINKS reports the dropped targets in `removed_cells`.
    #[test]
    fn snapshot_delta_spill_shrink_reports_removed() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(4)").unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(2)").unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        let removed = delta_removed_coords(&d);
        assert!(
            removed.contains(&(2, 0)) && removed.contains(&(3, 0)),
            "dropped targets A3/A4 must be in removed_cells — got {removed:?}"
        );
        let changed = delta_changed_coords(&d);
        assert!(
            changed.contains(&(0, 0)) && changed.contains(&(1, 0)),
            "surviving targets A1/A2 must be in changed_cells — got {changed:?}"
        );
    }

    /// Overwriting a spill anchor with a literal dissolves the spill — old
    /// targets surface as removed (the `set_value` dissolution path).
    #[test]
    fn snapshot_delta_spill_dissolve_via_literal() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(3)").unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 99.0 })
            .unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        let changed = delta_changed_coords(&d);
        let removed = delta_removed_coords(&d);
        assert!(changed.contains(&(0, 0)), "anchor A1 now 99 → changed");
        assert!(
            removed.contains(&(1, 0)) && removed.contains(&(2, 0)),
            "dissolved targets A2/A3 must be removed — got removed={removed:?}"
        );
    }

    /// Clearing a spill anchor dissolves the whole footprint — all targets
    /// surface as removed (the `clear_formula` dissolution path).
    #[test]
    fn snapshot_delta_spill_dissolve_via_clear() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(3)").unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.clear(addr(sheet, 0, 0)).unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        let removed = delta_removed_coords(&d);
        for row in 0..3 {
            assert!(
                removed.contains(&(row, 0)),
                "cleared footprint cell ({row},0) must be removed — got {removed:?}"
            );
        }
    }

    /// A spill RESIZED by a recompute (its size depends on an edited cell)
    /// reports the new footprint — the load-bearing `recompute_dirty` fix.
    #[test]
    fn snapshot_delta_spill_via_recalc_dependent() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 3.0 })
            .unwrap();
        // A1 = SEQUENCE(B1, 1, B1) spills B1 rows down column 0, starting at B1
        // (so EVERY footprint value changes when B1 changes — including the
        // anchor; the anchor-invariant case is covered separately by the VEQ
        // test below).
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(B1,1,B1)")
            .unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 5.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        assert!(!d.full_rebuild_required, "same-epoch delta");
        let changed = delta_changed_coords(&d);
        for row in 0..5 {
            assert!(
                changed.contains(&(row, 0)),
                "recompute-grown footprint cell ({row},0) must be in the delta — got {changed:?}"
            );
        }
        // The grown targets A4/A5 (blank → number) are the load-bearing proof:
        // without the recompute_dirty footprint fix they'd be silently missing.
        let a5 = d
            .changed_cells
            .iter()
            .find(|c| c.cell.row == 4 && c.cell.col == 0)
            .expect("A5 (grown target) present");
        assert_eq!(a5.cell.value, Some(CellValue::Number { number: 9.0 }));
    }

    /// A spill produced inside a `batch` reports its full footprint (the batch
    /// folds the drained footprint into its single `record_changes`).
    #[test]
    fn snapshot_delta_spill_in_batch() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;
        s.batch(
            vec![
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 1),
                    value: CellValue::Number { number: 3.0 },
                },
                SessionOp::SetFormula {
                    addr: addr(sheet, 0, 0),
                    text: "SEQUENCE(3)".to_string(),
                },
            ],
            BatchOptions::default(),
        )
        .unwrap();
        let d = s.snapshot_delta(&v0).unwrap();
        let changed = delta_changed_coords(&d);
        for row in 0..3 {
            assert!(
                changed.contains(&(row, 0)),
                "batched spill target ({row},0) must be in the delta — got {changed:?}"
            );
        }
    }

    /// The VEQ trap: a spill whose ANCHOR value is invariant but whose TARGETS
    /// change must still report the changed targets. `SEQUENCE(3,1,1,A1)` →
    /// [1, 1+A1, 1+2·A1]; the anchor (start) stays 1 across A1 edits, so the
    /// anchor VEQ-skips its write — but C2/C3 vary and MUST be reported.
    #[test]
    fn snapshot_delta_spill_veq_anchor_unchanged_targets_changed() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        // C1 = SEQUENCE(3,1,1,A1) spills C1:C3 = 1, 1+A1, 1+2A1.
        s.set_formula(addr(sheet, 0, 2), "SEQUENCE(3,1,1,A1)")
            .unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        let changed = delta_changed_coords(&d);
        assert!(
            changed.contains(&(1, 2)) && changed.contains(&(2, 2)),
            "C2/C3 changed despite the anchor C1 being VEQ-unchanged — got {changed:?}"
        );
        // The VEQ-invariant anchor C1 (value stays 1) must NOT be over-reported
        // (audit LOW): the footprint enumeration skips the anchor and the VEQ
        // short-circuit suppresses its write.
        assert!(
            !changed.contains(&(0, 2)),
            "value-invariant anchor C1 must NOT be in the delta — got {changed:?}"
        );
        // Confirm the new target values resolved correctly (1+10=11, 1+20=21).
        let c3 = d
            .changed_cells
            .iter()
            .find(|c| c.cell.row == 2 && c.cell.col == 2)
            .expect("C3 present");
        assert_eq!(c3.cell.value, Some(CellValue::Number { number: 21.0 }));
    }

    /// Audit HIGH-1 regression: a spill SHRUNK by a DEPENDENCY edit + `recalc_all`
    /// (NOT `recalc_dirty`, NOT a direct anchor edit) must still report the
    /// dropped targets as removed. The dissolving edit (`set_value(B1, ..)`)
    /// records only B1; `recompute_all` walks anchors only and clears the old
    /// spill internally — the fix captures the old footprint so A3/A4 surface.
    #[test]
    fn snapshot_delta_spill_recalc_all_dependency_shrink_reports_removed() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 4.0 })
            .unwrap();
        // A1 = SEQUENCE(B1) spills B1 rows down column 0 (B1=4 → A1:A4).
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(B1)").unwrap();
        let v1 = s.snapshot().unwrap().version;
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 2.0 })
            .unwrap();
        s.recalc_all().unwrap();
        let d = s.snapshot_delta(&v1).unwrap();
        assert!(
            !d.full_rebuild_required,
            "recalc_all does NOT bump the epoch"
        );
        let removed = delta_removed_coords(&d);
        assert!(
            removed.contains(&(2, 0)) && removed.contains(&(3, 0)),
            "dependency-driven shrink via recalc_all must report A3/A4 removed — got removed={removed:?}"
        );
    }

    /// Audit HIGH-2 regression: a spill anchor that becomes part of a CYCLE via a
    /// recompute (a dependency edit, not a direct anchor edit) must dissolve its
    /// footprint — old targets cleared from storage AND reported removed. The
    /// cycled-node branch previously wrote `#CIRC!` without clearing the spill.
    #[test]
    fn snapshot_delta_spill_dissolved_when_anchor_becomes_cyclic() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 3.0 })
            .unwrap();
        // A1 = SEQUENCE(C1) spills A1:A3 (C1=3). A2 = (1,0) is a spill target.
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(C1)").unwrap();
        let v1 = s.snapshot().unwrap().version;
        // Make C1 read A2 (a target of A1's spill) → A1→C1→A2(≈A1) cycle.
        s.set_formula(addr(sheet, 0, 2), "A2").unwrap();
        s.recalc_dirty().unwrap();
        // Storage: the dissolved target A2 must carry no stale spilled value —
        // a fully-cleared cell reports absent (`None`) or Blank, never the old 2.0.
        let a2 = s.cell(addr(sheet, 1, 0)).unwrap();
        assert!(
            a2.as_ref()
                .and_then(|c| c.value.clone())
                .map_or(true, |v| v == CellValue::Blank),
            "A2 must not retain a stale spilled value after cycle dissolution — got {a2:?}"
        );
        let d = s.snapshot_delta(&v1).unwrap();
        let removed = delta_removed_coords(&d);
        assert!(
            removed.contains(&(1, 0)) && removed.contains(&(2, 0)),
            "cycle-dissolved spill targets A2/A3 must be reported removed — got removed={removed:?}"
        );
    }

    // ===== FE-9.x (2026-06-14): uniform spill-body dissolution on error =====

    /// **FE-9.x — a previously-spilled formula going `#NAME?` dissolves its body
    /// (dirty path).** Pre-FE-9.x the bind-error arm wrote `#NAME?` at the anchor but
    /// left the spill body STALE on screen (the deferred HIGH). Now the body is cleared,
    /// the anchor unregistered, and `snapshot_delta` reports the removed body cells.
    #[test]
    fn fe9x_dirty_name_error_dissolves_spill_body() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap(); // A1:A3 (3 rows)
        s.set_formula(addr(sheet, 0, 2), "TRANSPOSE(SALES)")
            .unwrap(); // C1 → spills C1:E1
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 }),
            "precondition: C1 spill body[0] = 10"
        );
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "precondition: E1 spill body[2] = 30"
        );
        let v1 = s.snapshot().unwrap().version;
        s.delete_name("SALES", None).unwrap();
        s.recalc_dirty().unwrap();
        let c1 = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&c1, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9.x: deleted-name spill anchor must be #NAME?, got {c1:?}"
        );
        for (col, label) in [(3u32, "D1"), (4, "E1")] {
            let body = s.cell(addr(sheet, 0, col)).unwrap();
            assert!(
                body.as_ref()
                    .and_then(|c| c.value.clone())
                    .map_or(true, |v| v == CellValue::Blank),
                "FE-9.x: dissolved spill body {label} must NOT retain a stale value, got {body:?}"
            );
        }
        let d = s.snapshot_delta(&v1).unwrap();
        let removed = delta_removed_coords(&d);
        assert!(
            removed.contains(&(0, 3)) && removed.contains(&(0, 4)),
            "FE-9.x: dissolved body D1/E1 must be reported removed — got removed={removed:?}"
        );
    }

    /// **FE-9.x — same dissolution via the live `recalc_all` path.** `recalc_all`
    /// lends the persistent graph to `recompute_all` (Codex RESHAPE), so the full-pass
    /// `#NAME?` arm must dissolve the body too.
    #[test]
    fn fe9x_recalc_all_name_error_dissolves_spill_body() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "TRANSPOSE(SALES)")
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "precondition: E1 spill body = 30"
        );
        s.delete_name("SALES", None).unwrap();
        s.recalc_all().unwrap();
        let c1 = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&c1, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9.x: recalc_all on a deleted-name spill anchor must be #NAME?, got {c1:?}"
        );
        for (col, label) in [(3u32, "D1"), (4, "E1")] {
            let body = s.cell(addr(sheet, 0, col)).unwrap();
            assert!(
                body.as_ref()
                    .and_then(|c| c.value.clone())
                    .map_or(true, |v| v == CellValue::Blank),
                "FE-9.x: recalc_all must dissolve spill body {label}, got {body:?}"
            );
        }
    }

    /// **FE-9.x — gap 2: an aliased reader is re-extracted on dirty-path dissolution.**
    /// `G3 = D1` is producer-aliased to the spill anchor `C1`. After the spill
    /// dissolves to `#NAME?`, `D1` is a free literal cell; a LATER user write to `D1`
    /// must update `G3` — proving its dep was re-routed off the dead anchor.
    #[test]
    fn fe9x_name_error_reextracts_aliased_reader() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "TRANSPOSE(SALES)")
            .unwrap(); // C1:E1
        s.set_formula(addr(sheet, 2, 6), "D1").unwrap(); // G3 = D1 (a spill body cell)
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "precondition: G3 = D1 = 20"
        );
        s.delete_name("SALES", None).unwrap();
        s.recalc_dirty().unwrap();
        // GAP-2 PROOF: D1 is now a free cell. A user write to it MUST reach G3.
        s.set_value(addr(sheet, 0, 3), CellValue::Number { number: 99.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 99.0 }),
            "FE-9.x gap-2: G3's dep must re-extract to literal D1 after dissolution → see D1=99"
        );
    }

    /// **FE-9.x — gap 2 on the live `recalc_all` path (the RESHAPE-critical test).**
    /// The same aliased-reader re-extraction must happen when the dissolution occurs
    /// inside `recalc_all` (persistent graph attached). Without the `recompute_all`
    /// re-extraction this FAILS (G3 stays stale).
    #[test]
    fn fe9x_recalc_all_reextracts_aliased_reader() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "TRANSPOSE(SALES)")
            .unwrap();
        s.set_formula(addr(sheet, 2, 6), "D1").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "precondition: G3 = D1 = 20"
        );
        s.delete_name("SALES", None).unwrap();
        s.recalc_all().unwrap(); // dissolution + re-extraction on the full-pass path
        s.set_value(addr(sheet, 0, 3), CellValue::Number { number: 99.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 99.0 }),
            "FE-9.x RESHAPE: recalc_all must re-extract aliased readers → G3 sees D1=99"
        );
    }

    /// **FE-9.x — uniformity: a DROPPED TABLE under a spill dissolves too.**
    /// `UnknownTable` shares the `#NAME?` arm with `UnresolvedName`, so dropping a
    /// table that a spilling formula reads must dissolve the body identically.
    #[test]
    fn fe9x_table_drop_dissolves_spill_body() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.create_table(TableSpec {
            name: "T".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 3, // header + 2 data rows
            cols: 2,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".into(), "B".into()],
        })
        .unwrap();
        // Data column B (col 1, rows 1-2) = [20, 30].
        s.set_value(addr(sid, 1, 1), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_value(addr(sid, 2, 1), CellValue::Number { number: 30.0 })
            .unwrap();
        // E1 = TRANSPOSE(T[B]) → spills E1:F1 (the 2 data values, transposed).
        s.set_formula(addr(sid, 0, 4), "TRANSPOSE(T[B])").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sid, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "precondition: E1 spill body[0] = 20"
        );
        assert_eq!(
            s.cell(addr(sid, 0, 5)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "precondition: F1 spill body[1] = 30"
        );
        s.drop_table("T").unwrap();
        s.recalc_dirty().unwrap();
        let e1 = s.cell(addr(sid, 0, 4)).unwrap().unwrap().value;
        assert!(
            matches!(&e1, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9.x: dropped-table spill anchor must be #NAME?, got {e1:?}"
        );
        let f1 = s.cell(addr(sid, 0, 5)).unwrap();
        assert!(
            f1.as_ref()
                .and_then(|c| c.value.clone())
                .map_or(true, |v| v == CellValue::Blank),
            "FE-9.x: dropped-table dissolution must clear spill body F1, got {f1:?}"
        );
    }

    /// **FE-9.x — gap 2 with an `@`-bearing reader (pins the cell-anchor cache key).**
    /// `G3 = @D1:D1` reads the spill target `D1` and its text contains `@`, so the
    /// re-extraction must rebuild it under a CELL-anchored plan-cache key. After the
    /// spill dissolves, a write to `D1` must reach `G3`.
    #[test]
    fn fe9x_at_reader_reextracts_after_dissolution() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "TRANSPOSE(SALES)")
            .unwrap(); // C1:E1
        s.set_formula(addr(sheet, 2, 6), "@D1:D1").unwrap(); // G3 = @D1:D1 → D1 (has '@')
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "precondition: G3 = @D1:D1 = D1 = 20"
        );
        s.delete_name("SALES", None).unwrap();
        s.recalc_dirty().unwrap();
        s.set_value(addr(sheet, 0, 3), CellValue::Number { number: 99.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 99.0 }),
            "FE-9.x gap-2: an @-bearing reader must re-extract (cell-anchor key) → see D1=99"
        );
    }

    /// **FE-9.x — a reader that is ITSELF a spilling formula survives dissolution.**
    /// `G1 = TRANSPOSE(C1:E1)` spills off the body of `C1 = TRANSPOSE(SALES)`. Deleting
    /// SALES dissolves C1's body; G1 must re-evaluate without corruption (no panic, no
    /// stale value, recalc completes) and its own footprint stays consistent.
    #[test]
    fn fe9x_reader_that_spills_survives_dissolution() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "TRANSPOSE(SALES)")
            .unwrap(); // C1:E1 (1×3)
        s.set_formula(addr(sheet, 0, 6), "TRANSPOSE(C1:E1)")
            .unwrap(); // G1:G3 (3×1)
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 6)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "precondition: G3 (spilled-from-spill) = 30"
        );
        s.delete_name("SALES", None).unwrap();
        // Must not panic / must complete.
        s.recalc_dirty().unwrap();
        // The source anchor is #NAME?.
        let c1 = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&c1, Some(CellValue::Error { error }) if error == "#NAME?"),
            "C1 source anchor must be #NAME?, got {c1:?}"
        );
        // G1 (the spilling reader) must have RE-EVALUATED — not the stale 10. It reads
        // C1:E1 = [#NAME?, blank, blank], so its array result carries the error.
        let g1 = s.cell(addr(sheet, 0, 6)).unwrap().unwrap().value;
        assert!(
            matches!(&g1, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9.x: the spilling reader G1 must re-evaluate (error-propagate), not keep stale 10; got {g1:?}"
        );
        // Its former body cells G2/G3 must not retain stale spilled values.
        for (rr, label) in [(1u32, "G2"), (2, "G3")] {
            let body = s.cell(addr(sheet, rr, 6)).unwrap();
            assert!(
                body.as_ref()
                    .and_then(|c| c.value.clone())
                    .map_or(true, |v| v == CellValue::Blank),
                "FE-9.x: spilling-reader body {label} must not retain a stale value, got {body:?}"
            );
        }
    }

    /// **FE-9.x — the dirty `#CIRC!` cycle branch dissolves AND re-extracts (gap 2).**
    /// A spilling anchor driven into a cycle by a dependency edit dissolves its body;
    /// an aliased reader of a now-freed body cell must re-route — a later write to that
    /// cell reaches the reader. The cycle `A1↔C1` excludes `A2`, so writing `A2` does
    /// NOT re-spill (keeping `A1` `#CIRC!` and `A2` free).
    #[test]
    fn fe9x_dirty_circ_over_spill_dissolves_and_reextracts() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 3.0 })
            .unwrap(); // C1 = 3
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(C1)").unwrap(); // A1 spills A1:A3
        s.set_formula(addr(sheet, 5, 5), "A2").unwrap(); // F6 = A2 (body cell, aliased to A1)
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 5, 5)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 2.0 }),
            "precondition: F6 = A2 = 2"
        );
        // Drive A1 into a cycle that does NOT involve A2: C1 = A1 → A1→C1→A1.
        s.set_formula(addr(sheet, 0, 2), "A1").unwrap();
        s.recalc_dirty().unwrap();
        let a1 = s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value;
        assert!(
            matches!(&a1, Some(CellValue::Error { error }) if error == "#CIRC!"),
            "A1 in a cycle must be #CIRC!, got {a1:?}"
        );
        let a2 = s.cell(addr(sheet, 1, 0)).unwrap();
        assert!(
            a2.as_ref()
                .and_then(|c| c.value.clone())
                .map_or(true, |v| v == CellValue::Blank),
            "FE-9.x: cycle-dissolved body A2 must be cleared, got {a2:?}"
        );
        // GAP-2 (cycle branch): write the freed A2 — F6 must see it (re-extracted).
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 99.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 5, 5)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 99.0 }),
            "FE-9.x: the dirty #CIRC! cycle branch must re-extract F6 → see A2=99"
        );
    }

    /// **FE-9.x — `recalc_all` Ok-arm SHRINK re-extracts aliased readers (RESHAPE, site 5).**
    /// A surviving spill that SHRINKS during `recalc_all` drops targets; a reader aliased
    /// to a dropped target must re-route to the now-literal cell. Without the Ok-arm
    /// re-extraction this FAILS (the reader stays stale).
    #[test]
    fn fe9x_recalc_all_ok_shrink_reextracts_aliased_reader() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 4.0 })
            .unwrap(); // B1 = 4
        s.set_formula(addr(sheet, 0, 0), "SEQUENCE(B1)").unwrap(); // A1 spills A1:A4
        s.set_formula(addr(sheet, 5, 5), "A4").unwrap(); // F6 = A4 (last body cell, aliased)
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 5, 5)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 4.0 }),
            "precondition: F6 = A4 = 4"
        );
        // Shrink to A1:A2 (A3/A4 dropped) and resolve via recalc_all (Ok-arm site 5).
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 2.0 })
            .unwrap();
        s.recalc_all().unwrap();
        // A4 is now free; write it and confirm F6 re-routed to literal A4.
        s.set_value(addr(sheet, 3, 0), CellValue::Number { number: 77.0 })
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 5, 5)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 77.0 }),
            "FE-9.x site-5: recalc_all Ok-arm shrink must re-extract F6 → see A4=77"
        );
    }

    // ===== FE-9.y (2026-06-14): Ok-path spill→scalar dissolution =====
    //
    // NOTE on coverage: the EQUAL-VALUE VEQ-strand (a spill dissolving to a NUMBER
    // scalar that VEQ-equals its prior top-left) is the actual FE-9.y bug, but it is
    // NOT reachable through any production formula. Spilling comes only from the
    // Unified-tier fns SEQUENCE / TRANSPOSE / FILTER; none returns a number-scalar —
    // the only Ok-path dissolution-to-scalar is FILTER→no-match → `#CALC!` (a
    // degenerate array), and `#CALC!` never equals a numeric top-left, so VEQ never
    // fires there. The equal-value strand therefore only arises from a residual
    // inconsistent state (an older buggy build / a file it saved) or a scalar-returning
    // UDF. That residual state is exercised directly by the runtime-level white-box
    // test `recompute_dirty_spill_dissolved_to_scalar_forces_anchor_write_past_veq`
    // (recompute.rs), which is the real FE-9.y regression guard. The session test
    // below covers the realistic Ok-path dissolution (FILTER → `#CALC!`) end-to-end.

    /// **FE-9.y — a FILTER spill that dissolves to `#CALC!` (no match) clears its
    /// body on the Ok path.** `FILTER(Data, Mask)` spills the kept rows; flipping the
    /// mask all-false makes FILTER return a degenerate array → `#CALC!` at the anchor
    /// with `new_spill_shape = None`. This is the realistic Ok-path spill→scalar
    /// dissolution; the anchor must show `#CALC!` and the old body must clear. (Here
    /// the dissolved value `#CALC!` ≠ the prior top-left, so VEQ never fires — the
    /// equal-value strand is covered by the recompute.rs white-box test.)
    #[test]
    fn fe9y_dirty_filter_dissolved_to_calc_clears_body() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 5.0), (1, 6.0), (2, 7.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap(); // A1:A3 = Data
        }
        for (rr, v) in [(0u32, 1.0), (1, 1.0), (2, 0.0)] {
            s.set_value(addr(sheet, rr, 1), CellValue::Number { number: v })
                .unwrap(); // B1:B3 = Mask (keep rows 1,2)
        }
        s.set_name("Data", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_name("Mask", range(sheet, 0, 1, 2, 1)).unwrap();
        s.set_formula(addr(sheet, 0, 4), "FILTER(Data, Mask)")
            .unwrap(); // E1 → spills E1:E2
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 5.0 }),
            "precondition: E1 FILTER spill anchor = 5"
        );
        assert_eq!(
            s.cell(addr(sheet, 1, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 6.0 }),
            "precondition: E2 FILTER spill body = 6"
        );
        // Flip the mask all-false → FILTER no-match → degenerate → #CALC! (dissolution).
        for rr in 0..3u32 {
            s.set_value(addr(sheet, rr, 1), CellValue::Number { number: 0.0 })
                .unwrap();
        }
        s.recalc_dirty().unwrap();
        let e1 = s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value;
        assert!(
            matches!(&e1, Some(CellValue::Error { error }) if error == "#CALC!"),
            "FE-9.y: FILTER no-match must dissolve the spill to #CALC! at the anchor, got {e1:?}"
        );
        let e2 = s.cell(addr(sheet, 1, 4)).unwrap();
        assert!(
            e2.as_ref()
                .and_then(|c| c.value.clone())
                .map_or(true, |v| v == CellValue::Blank),
            "FE-9.y: dissolved FILTER body E2 must be cleared, got {e2:?}"
        );
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

    /// **TB3 (w140) — Codex audit BLOCKER regression.** A structured-reference
    /// plan (`SUM(Sales[Qty])`) binds to the table's CURRENT extent.
    /// `resize_table` keeps the plan cache coherent by clearing it then
    /// RE-WARMING against the new extent via `reextract_table_readers` — but
    /// `PlanCacheKey` has no table-generation axis, so the re-warmed plan is
    /// keyed identically to one looked up after an UNDO. `rematerialize`
    /// (undo/redo) replays the workbook to the OLD extent; before the w140 fix
    /// it did NOT clear the carried plan cache, so the stale shrunk-extent plan
    /// survived. TB3 made `recompute_all`'s cycle-detection pre-pass SHARE that
    /// cache (previously it re-bound fresh and was immune), so an undo-of-resize
    /// could even miss a `#CIRC!`. This asserts the simpler, broader value
    /// consequence: after undo the structured ref MUST re-bind against the
    /// restored extent. Fails without `rematerialize`'s `plan_cache.clear()`
    /// (the reader keeps the shrunk A2-only sum).
    #[test]
    fn undo_of_table_resize_rebinds_structured_ref_no_stale_plan() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        // Sales: header at row 0 ("Qty"), 3 data rows (1,2,3 → A2,A3,A4), col 0.
        s.create_table(TableSpec {
            name: "Sales".into(),
            sheet: sid,
            top_row: 0,
            top_col: 0,
            rows: 4, // header + 3 data
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["Qty".into()],
        })
        .unwrap();
        s.set_value(addr(sid, 1, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_value(addr(sid, 2, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sid, 3, 0), CellValue::Number { number: 100.0 })
            .unwrap();
        // Reader OUTSIDE the table (D9) sums the whole Qty column → 111.
        s.set_formula(addr(sid, 8, 3), "SUM(Sales[Qty])").unwrap();
        assert_eq!(
            cell_value(&s, addr(sid, 8, 3)),
            CellValue::Number { number: 111.0 },
            "full-extent structured-ref sum before any resize"
        );

        // Shrink the table to 1 data row (header + 1 ⇒ `rows: 2`) → Qty = A2.
        // This clears the plan cache then RE-WARMS the reader's plan against the
        // A2-only extent (a stale plan keyed identically to a post-undo lookup).
        s.resize_table("Sales", 2, 1, vec![], vec![]).unwrap();

        // Undo the resize → `rematerialize` replays the table back to A2:A4 and
        // recomputes. The reader MUST re-bind against the restored extent and
        // read 111 again. WITHOUT the w140 `rematerialize` `plan_cache.clear()`,
        // the cycle pre-pass + eval loop hit the stale A2-only plan → 1.
        assert!(s.undo().unwrap().consumed, "resize must be undoable");
        assert_eq!(
            cell_value(&s, addr(sid, 8, 3)),
            CellValue::Number { number: 111.0 },
            "undo-of-resize must re-bind the structured ref against the restored \
             extent; a stale plan cache would leave the shrunk A2-only sum (1)"
        );
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

    // === 6.1C audit-fix H2 — deterministic ordering across snapshot DTOs ===

    /// `snapshot.formats` must be sorted by `FormatId` regardless of the
    /// underlying `FormatTable::iter` HashMap order. Without the audit-fix
    /// sort, two consecutive snapshots in DIFFERENT processes (each with its
    /// own per-process HashMap hash seed) could disagree, breaking the
    /// shared-DTO documented contract that `formats` is sorted by `FormatId`.
    #[test]
    fn snapshot_formats_are_sorted_by_format_id() {
        let mut s = WorkbookSession::new();
        // Register several formats; the assigned FormatIds are `Custom{peer,
        // counter}` whose counter advances per registration. The test doesn't
        // care what the IDs are — only that the output Vec is sorted.
        for fmt in ["0.00", "@", "yyyy-mm-dd", "0%", "$#,##0.00"] {
            s.register_format(fmt).unwrap();
        }
        let snap = s.snapshot().unwrap();
        assert!(snap.formats.len() >= 5, "all registered formats present");
        let ids: Vec<_> = snap.formats.iter().map(|fd| fd.id).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "snapshot.formats must be sorted by FormatId");
    }

    /// `snapshot_delta.changed_cells` / `removed_cells` / `sheets_changed` /
    /// `sheets_removed` / `formats_added` MUST all be sorted by their natural
    /// key. The HashSet walks that populate the intermediate sets produce
    /// arbitrary order, so without the audit-fix sort the wire output would
    /// be nondeterministic for identical logical content.
    #[test]
    fn snapshot_delta_collections_are_sorted_deterministically() {
        let mut s = WorkbookSession::new();
        // Two sheets so the (sheet, row, col) tie-breaker is exercised.
        let sa = s.add_sheet("A", 16384).unwrap();
        let sb = s.add_sheet("B", 16384).unwrap();
        let v0 = s.snapshot().unwrap().version;

        // Cell writes in REVERSE of the expected sort order on both sheets.
        for (sheet, row, col) in [
            (sb, 5, 3),
            (sb, 1, 0),
            (sa, 7, 2),
            (sa, 0, 0),
            (sa, 0, 5),
            (sa, 4, 1),
        ] {
            s.set_value(addr(sheet, row, col), CellValue::Number { number: 1.0 })
                .unwrap();
        }
        // A removed cell: write then clear → ends up in `removed_cells`.
        s.set_value(addr(sa, 9, 9), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_value(addr(sa, 9, 9), CellValue::Blank).unwrap();
        s.set_value(addr(sb, 8, 8), CellValue::Number { number: 2.0 })
            .unwrap();
        s.set_value(addr(sb, 8, 8), CellValue::Blank).unwrap();

        // Two formats so `formats_added` ordering is exercised.
        s.register_format("0.00%").unwrap();
        s.register_format("yyyy").unwrap();

        let d = s.snapshot_delta(&v0).unwrap();
        assert!(!d.full_rebuild_required);

        // Each output Vec must be in sorted order by its natural key.
        let cell_keys: Vec<_> = d
            .changed_cells
            .iter()
            .map(|c| (c.sheet, c.cell.row, c.cell.col))
            .collect();
        let mut cell_sorted = cell_keys.clone();
        cell_sorted.sort();
        assert_eq!(
            cell_keys, cell_sorted,
            "changed_cells must be sorted by (sheet, row, col)"
        );

        let removed_keys: Vec<_> = d
            .removed_cells
            .iter()
            .map(|c| (c.sheet, c.row, c.col))
            .collect();
        let mut removed_sorted = removed_keys.clone();
        removed_sorted.sort();
        assert_eq!(
            removed_keys, removed_sorted,
            "removed_cells must be sorted by (sheet, row, col)"
        );

        let sheet_ids: Vec<_> = d.sheets_changed.iter().map(|sh| sh.id).collect();
        let mut sheet_sorted = sheet_ids.clone();
        sheet_sorted.sort();
        assert_eq!(
            sheet_ids, sheet_sorted,
            "sheets_changed must be sorted by id"
        );

        let mut removed_sheets_sorted = d.sheets_removed.clone();
        removed_sheets_sorted.sort();
        assert_eq!(
            d.sheets_removed, removed_sheets_sorted,
            "sheets_removed must be sorted"
        );

        let format_ids: Vec<_> = d.formats_added.iter().map(|fd| fd.id).collect();
        let mut format_sorted = format_ids.clone();
        format_sorted.sort();
        assert_eq!(
            format_ids, format_sorted,
            "formats_added must be sorted by FormatId"
        );
    }

    /// Two snapshots taken back-to-back against the same workbook state must
    /// be IDENTICAL — without the audit-fix sort, two `snapshot()` calls
    /// would already agree within a process (HashMap's hasher seed is
    /// stable per HashMap instance), but the wire output would diverge
    /// across processes. This test catches a regression that would break the
    /// stability guarantee at the same locus (Vec field ordering).
    #[test]
    fn snapshot_formats_are_stable_across_calls() {
        let mut s = WorkbookSession::new();
        for fmt in ["@", "0.00", "yyyy-mm-dd", "0%"] {
            s.register_format(fmt).unwrap();
        }
        let a = s.snapshot().unwrap();
        let b = s.snapshot().unwrap();
        let ids_a: Vec<_> = a.formats.iter().map(|fd| fd.id).collect();
        let ids_b: Vec<_> = b.formats.iter().map(|fd| fd.id).collect();
        assert_eq!(
            ids_a, ids_b,
            "two consecutive snapshots must produce identical formats order"
        );
    }

    // =========================================================================
    // FE-4 W4 — cell-style foundation acceptance tests on the REAL owning
    // WorkbookSession (NOT a mock; NOT the dormant CollabSession). These are
    // the 11 mandatory acceptance tests from the LAUNCH-LOCKED fe4-plan.
    // =========================================================================

    fn bold_style() -> StyleDto {
        StyleDto {
            bold: true,
            ..StyleDto::default()
        }
    }

    fn fully_bordered_style() -> StyleDto {
        use ql_session::dto::{BorderEdge, BorderStyle, Borders, Rgb};
        let edge = BorderEdge {
            style: BorderStyle::Double,
            color: Rgb {
                r: 0x11,
                g: 0x22,
                b: 0x33,
            },
        };
        StyleDto {
            bold: true,
            italic: true,
            underline: true,
            strike: true,
            fill: Some(Rgb {
                r: 0xab,
                g: 0xcd,
                b: 0xef,
            }),
            text_color: Some(Rgb {
                r: 0x77,
                g: 0x88,
                b: 0x99,
            }),
            align: ql_session::dto::HAlign::Center,
            borders: Borders {
                top: edge,
                bottom: BorderEdge {
                    style: BorderStyle::Thin,
                    color: Rgb { r: 1, g: 2, b: 3 },
                },
                left: BorderEdge {
                    style: BorderStyle::Medium,
                    color: Rgb { r: 4, g: 5, b: 6 },
                },
                right: edge,
            },
        }
    }

    /// FE-7: a style exercising the new font attrs (text_color clone of fill,
    /// underline clone of bold, strike clone of italic) WITHOUT borders.
    fn font_attr_style() -> StyleDto {
        use ql_session::dto::Rgb;
        StyleDto {
            underline: true,
            strike: true,
            text_color: Some(Rgb {
                r: 0x12,
                g: 0x34,
                b: 0x56,
            }),
            ..StyleDto::default()
        }
    }

    /// (1) setStyle → snapshot → styleId set.
    #[test]
    fn fe4_setstyle_snapshot_has_style_id() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 2, 1), sid).unwrap();
        let cell = s.cell(addr(sheet, 2, 1)).unwrap().unwrap();
        assert_eq!(cell.style, Some(sid));
        // The snapshot's styles table resolves the id.
        let snap = s.snapshot().unwrap();
        let def = snap.styles.iter().find(|sd| sd.id == sid).unwrap();
        assert_eq!(def.style, bold_style());
    }

    /// FE-7: registerStyle with the new font attrs → snapshot styles[] carries
    /// them (text_color round-trips an Rgb; underline/strike round-trip true).
    #[test]
    fn fe7_font_attrs_round_trip_through_snapshot() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(font_attr_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), sid).unwrap();
        let snap = s.snapshot().unwrap();
        let def = snap.styles.iter().find(|sd| sd.id == sid).unwrap();
        assert_eq!(
            def.style,
            font_attr_style(),
            "font attrs round-trip exactly"
        );
        assert!(def.style.underline);
        assert!(def.style.strike);
        assert_eq!(
            def.style.text_color,
            Some(ql_session::dto::Rgb {
                r: 0x12,
                g: 0x34,
                b: 0x56
            })
        );
    }

    /// (2) setStyle → insert row → assert style MOVED + original cleared
    /// (the wave-3 overlay-orphan bug analog).
    #[test]
    fn fe4_setstyle_insert_row_moves_style_clears_original() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 3, 0), sid).unwrap();
        // Insert one row at row 0 → the styled cell at row 3 moves to row 4.
        s.insert_rows(sheet, 0, 1).unwrap();
        let moved = s.cell(addr(sheet, 4, 0)).unwrap();
        assert_eq!(
            moved.and_then(|c| c.style),
            Some(sid),
            "style moved to row 4"
        );
        let original = s.cell(addr(sheet, 3, 0)).unwrap();
        assert!(
            original.is_none() || original.unwrap().style.is_none(),
            "original row-3 style must be cleared (no orphan)"
        );
    }

    /// (3) delete row → entry dropped.
    #[test]
    fn fe4_setstyle_delete_row_drops_entry() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 2, 0), sid).unwrap();
        s.delete_rows(sheet, 2, 2).unwrap();
        // Row 2's styled cell was deleted → no overlay entry there.
        let cell = s.cell(addr(sheet, 2, 0)).unwrap();
        assert!(cell.is_none() || cell.unwrap().style.is_none());
    }

    /// (4) `.qbook` round-trip preserves the style + overlay.
    #[test]
    fn fe4_setstyle_qbook_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("style-rt.qbook");
        let path_str = path.to_str().unwrap();

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("Sheet1", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 2, 1), sid).unwrap();
        s.save(path_str).unwrap();

        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        let cell = s2.cell(addr(sheet, 2, 1)).unwrap().unwrap();
        assert_eq!(cell.style, Some(sid));
        let snap = s2.snapshot().unwrap();
        let def = snap.styles.iter().find(|sd| sd.id == sid).unwrap();
        assert_eq!(def.style, bold_style());
    }

    /// (5) undo → cleared.
    #[test]
    fn fe4_setstyle_undo_clears() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), sid).unwrap();
        assert_eq!(s.cell(addr(sheet, 0, 0)).unwrap().unwrap().style, Some(sid));
        let res = s.undo().unwrap();
        assert!(res.consumed);
        let cell = s.cell(addr(sheet, 0, 0)).unwrap();
        assert!(
            cell.is_none() || cell.unwrap().style.is_none(),
            "undo must clear the style"
        );
    }

    /// (6) redo → restored.
    #[test]
    fn fe4_setstyle_redo_restores() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), sid).unwrap();
        s.undo().unwrap();
        let res = s.redo().unwrap();
        assert!(res.consumed);
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().style,
            Some(sid),
            "redo must restore the style"
        );
    }

    /// **FE-9 (2026-06-14) — empty-style bind is a clear (no phantom cell).**
    /// Binding a registered DEFAULT/empty style on an otherwise-empty cell must
    /// NOT materialize a phantom snapshot cell — the engine collapses it to a
    /// clear. Pre-fix, the IDE's "toggle every attribute off" path created a
    /// value-less, style-only overlay entry the snapshot + persistence emitted.
    #[test]
    fn fe9_empty_style_bind_is_a_clear_no_phantom() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let empty = s.register_style(StyleDto::default()).unwrap();
        s.set_style(addr(sheet, 0, 0), empty).unwrap();
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "FE-9: binding a default style on an empty cell must NOT create a phantom cell"
        );
    }

    /// **FE-9 — toggle-OFF removes the cell's style (no lingering phantom).** Set
    /// a real (bold) style, confirm it's present, then bind a default style (the
    /// "unset everything" gesture): the cell's style is gone and, with no value,
    /// the cell itself disappears — no phantom left behind.
    #[test]
    fn fe9_toggle_style_off_removes_phantom() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let bold = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), bold).unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().style,
            Some(bold),
            "precondition: the bold style is applied"
        );
        // Toggle everything off → bind a default style → cell clears.
        let empty = s.register_style(StyleDto::default()).unwrap();
        s.set_style(addr(sheet, 0, 0), empty).unwrap();
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "FE-9: toggling the style off must leave no phantom cell"
        );
    }

    /// **FE-9 — a non-empty style on a VALUE cell is untouched (no over-collapse).**
    /// The collapse only fires for the default style; a value cell with a real
    /// style keeps both.
    #[test]
    fn fe9_value_cell_keeps_real_style() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 42.0 })
            .unwrap();
        let bold = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), bold).unwrap();
        let cell = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(cell.value, Some(CellValue::Number { number: 42.0 }));
        assert_eq!(cell.style, Some(bold), "real style on a value cell is kept");
    }

    /// **FE-9 (2026-06-14) — a BATCHED empty-style bind records a CLEAR (audit MED).**
    /// The IDE applies styles via `batch`. An empty/default style in a batch must log
    /// `SetCellStyle{None}`, not `Some(empty_id)`, or a reload/undo (which replays the
    /// op log) would resurrect a phantom value-less styled cell even though the live
    /// overlay was correctly cleared.
    #[test]
    fn fe9_batched_empty_style_no_phantom_after_reload() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("fe9batch.qbook");
        let path_str = path.to_str().unwrap();
        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            let empty = s.register_style(StyleDto::default()).unwrap();
            s.batch(
                vec![SessionOp::SetStyle {
                    addr: addr(sheet, 0, 0),
                    style: empty,
                }],
                BatchOptions::default(),
            )
            .unwrap();
            assert!(
                s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
                "live: a batched empty-style bind leaves no phantom cell"
            );
            s.save(path_str).unwrap();
        }
        // Reload replays the op log; a logged Some(empty_id) would recreate the phantom.
        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        assert!(
            s2.cell(addr(0, 0, 0)).unwrap().is_none(),
            "FE-9: a batched empty-style bind must NOT resurrect a phantom after reload"
        );
    }

    /// **FE-9 (2026-06-14) — a borders-off edge with a leftover color collapses to a
    /// clear (audit LOW).** A `None`-style border edge draws nothing, so its color is
    /// inert; canonicalization makes such an otherwise-default style resolve to
    /// `Style::default()` → `is_empty()` → an empty-style bind clears instead of
    /// leaving a phantom (and two such edges intern as one style — dedup).
    #[test]
    fn fe9_borders_off_with_color_collapses_to_clear() {
        use ql_session::dto::{BorderEdge, BorderStyle, Borders, Rgb};
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let style = StyleDto {
            borders: Borders {
                top: BorderEdge {
                    style: BorderStyle::None,
                    color: Rgb { r: 255, g: 0, b: 0 },
                },
                ..Borders::default()
            },
            ..StyleDto::default()
        };
        let id = s.register_style(style).unwrap();
        s.set_style(addr(sheet, 0, 0), id).unwrap();
        assert!(
            s.cell(addr(sheet, 0, 0)).unwrap().is_none(),
            "FE-9: a None-style border edge with a leftover color is visually empty → collapses to a clear"
        );
    }

    /// (7) batch([setStyle, setValue]) → both set (BatchCommit walker).
    #[test]
    fn fe4_batch_setstyle_and_setvalue_both_set() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(bold_style()).unwrap();
        s.batch(
            vec![
                SessionOp::SetStyle {
                    addr: addr(sheet, 0, 0),
                    style: sid,
                },
                SessionOp::SetValue {
                    addr: addr(sheet, 0, 0),
                    value: CellValue::Number { number: 42.0 },
                },
            ],
            BatchOptions::default(),
        )
        .unwrap();
        let cell = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(cell.style, Some(sid));
        assert_eq!(cell.value, Some(CellValue::Number { number: 42.0 }));
    }

    /// (8) setStyle → snapshotDelta → styleId in changedCells.
    #[test]
    fn fe4_setstyle_snapshot_delta_carries_style() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Baseline version BEFORE the style edit.
        let v0 = s.snapshot().unwrap().version;
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 1, 1), sid).unwrap();
        let delta = s.snapshot_delta(&v0).unwrap();
        assert!(!delta.full_rebuild_required);
        let changed = delta
            .changed_cells
            .iter()
            .find(|c| c.sheet == sheet && c.cell.row == 1 && c.cell.col == 1)
            .expect("changed cell for the styled cell");
        assert_eq!(changed.cell.style, Some(sid));
        // The style def is also surfaced in styles_added.
        assert!(delta.styles_added.iter().any(|sd| sd.id == sid));
    }

    /// (9) setStyle → from_snapshot rebuild (op-log replay) → preserved.
    #[test]
    fn fe4_setstyle_oplog_replay_rebuild_preserves() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let sid = s.register_style(fully_bordered_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), sid).unwrap();
        // rematerialize() (undo+redo cycle) rebuilds the workbook by replaying
        // the op-log into a fresh workbook — the op-log replay path that
        // from_snapshot also uses. A redo after undo round-trips through it.
        s.undo().unwrap();
        s.redo().unwrap();
        let cell = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(cell.style, Some(sid));
        let snap = s.snapshot().unwrap();
        let def = snap.styles.iter().find(|sd| sd.id == sid).unwrap();
        assert_eq!(def.style, fully_bordered_style());
    }

    /// (10) removeSheet → restoreSheet → styled cells reappear.
    #[test]
    fn fe4_setstyle_remove_restore_sheet_styles_reappear() {
        let mut s = WorkbookSession::new();
        let keep = s.add_sheet("Keep", 16384).unwrap();
        let sheet = s.add_sheet("Styled", 16384).unwrap();
        let _ = keep;
        let sid = s.register_style(bold_style()).unwrap();
        s.set_style(addr(sheet, 0, 0), sid).unwrap();
        s.delete_sheet(sheet).unwrap();
        s.restore_sheet(sheet).unwrap();
        let cell = s.cell(addr(sheet, 0, 0)).unwrap().unwrap();
        assert_eq!(
            cell.style,
            Some(sid),
            "styled cell must reappear on restore"
        );
    }

    /// (11) BORDERS-SPECIFIC: a Style with all four per-edge borders set
    /// survives the full round-trip — distinct intern + insert/delete re-key +
    /// every edge {style,color} survives the `.qbook` save→load.
    #[test]
    fn fe4_full_borders_survive_round_trip_and_shift() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("borders.qbook");
        let path_str = path.to_str().unwrap();

        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Distinct intern: a borderless bold style + the fully-bordered one.
        let plain = s.register_style(bold_style()).unwrap();
        let bordered = s.register_style(fully_bordered_style()).unwrap();
        assert_ne!(
            plain, bordered,
            "bordered interns distinctly from borderless"
        );
        s.set_style(addr(sheet, 5, 2), bordered).unwrap();
        // Re-key through an insert: row 5 → row 6.
        s.insert_rows(sheet, 0, 1).unwrap();
        assert_eq!(
            s.cell(addr(sheet, 6, 2)).unwrap().unwrap().style,
            Some(bordered),
            "bordered style re-keys through AxisShift"
        );
        // Now save → load and confirm every edge survives.
        s.save(path_str).unwrap();
        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        let cell = s2.cell(addr(sheet, 6, 2)).unwrap().unwrap();
        assert_eq!(cell.style, Some(bordered));
        let snap = s2.snapshot().unwrap();
        let def = snap.styles.iter().find(|sd| sd.id == bordered).unwrap();
        assert_eq!(
            def.style,
            fully_bordered_style(),
            "every per-edge border {{style,color}} survives .qbook save→load"
        );
    }

    // ========================================================================
    // FE-5 W-N (2026-06-12) — Name Manager engine support.
    // ========================================================================

    fn range(sheet: SheetId, sr: RowId, sc: ColId, er: RowId, ec: ColId) -> CellRange {
        CellRange {
            sheet,
            start_row: sr,
            start_col: sc,
            end_row: er,
            end_col: ec,
        }
    }

    // ===== Builder E (2026-06-13): WorkbookSnapshot.tables read surface =====

    /// A created table surfaces in `WorkbookSnapshot.tables` with its full
    /// range + header/totals flags (the IDE's table-render read surface).
    #[test]
    fn fe5_snapshot_carries_a_created_table() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.create_table(TableSpec {
            name: "Sales".into(),
            sheet: sid,
            top_row: 2,
            top_col: 1,
            rows: 5, // 1 header + 3 data + 1 totals
            cols: 3,
            has_header: true,
            has_totals: true,
            column_names: vec!["Region".into(), "Q1".into(), "Q2".into()],
        })
        .unwrap();

        let snap = s.snapshot().unwrap();
        assert_eq!(snap.tables.len(), 1, "the one created table is present");
        let t = &snap.tables[0];
        // Canonical name is uppercased by the engine; display name preserves case.
        assert_eq!(t.name, "SALES");
        assert_eq!(t.display_name, "Sales");
        assert_eq!(t.sheet, sid);
        assert_eq!(t.top_row, 2);
        assert_eq!(t.top_col, 1);
        assert_eq!(t.rows, 5);
        assert_eq!(t.cols, 3);
        assert!(t.has_header);
        assert!(t.has_totals);
    }

    /// Two tables on two DIFFERENT sheets both surface (the walker is
    /// workbook-level, not per-sheet) and come back sorted by `(sheet, name)`.
    #[test]
    fn fe5_snapshot_carries_tables_across_two_sheets() {
        let mut s = WorkbookSession::new();
        let s0 = s.add_sheet("S0", 16384).unwrap();
        let s1 = s.add_sheet("S1", 16384).unwrap();
        // Create on sheet 1 FIRST so we prove the sort (by sheet id) and not
        // insertion/HashMap order.
        s.create_table(TableSpec {
            name: "Beta".into(),
            sheet: s1,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["Col".into()],
        })
        .unwrap();
        s.create_table(TableSpec {
            name: "Alpha".into(),
            sheet: s0,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["Col".into()],
        })
        .unwrap();

        let snap = s.snapshot().unwrap();
        assert_eq!(snap.tables.len(), 2, "both tables present");
        // Sorted by (sheet, name): sheet 0's ALPHA before sheet 1's BETA.
        assert_eq!(snap.tables[0].name, "ALPHA");
        assert_eq!(snap.tables[0].sheet, s0);
        assert_eq!(snap.tables[1].name, "BETA");
        assert_eq!(snap.tables[1].sheet, s1);
    }

    /// A workbook with no tables → the field is empty (and, being
    /// `skip_serializing_if = "Vec::is_empty"`, omitted on the wire).
    #[test]
    fn fe5_snapshot_tables_empty_when_none_defined() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let snap = s.snapshot().unwrap();
        assert!(snap.tables.is_empty(), "no tables → empty vec");
        // The additive field is omitted from the serialized form when empty.
        let json = serde_json::to_value(&snap).unwrap();
        assert!(
            json.get("tables").is_none(),
            "empty tables is skip-serialized (additive/backward-safe)"
        );
    }

    /// **FE-8.3 (2026-06-15) — `table_columns` read surface.** The column names
    /// live in `TableMetadata` (the snapshot omits them); `table_columns` reads
    /// them back, in order, by case-insensitive table name, and reflects every
    /// in-place roster mutation (`rename_column`, `resize_table` grow + shrink).
    /// This is the read FE-8.1 column-shrink + rename-column wire against.
    #[test]
    fn fe83_table_columns_reads_roster_and_reflects_mutations() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        s.create_table(TableSpec {
            name: "Sales".into(),
            sheet: sid,
            top_row: 2,
            top_col: 1,
            rows: 5,
            cols: 3,
            has_header: true,
            has_totals: false,
            column_names: vec!["Region".into(), "Q1".into(), "Q2".into()],
        })
        .unwrap();

        // Display names, in order — looked up case-INSENSITIVELY (canonicalized
        // like every other table op).
        assert_eq!(
            s.table_columns("Sales").unwrap(),
            vec!["Region".to_string(), "Q1".to_string(), "Q2".to_string()]
        );
        assert_eq!(
            s.table_columns("sales").unwrap(),
            vec!["Region".to_string(), "Q1".to_string(), "Q2".to_string()],
            "lookup is case-insensitive"
        );

        // rename_column rewrites the roster in place.
        s.rename_column("Sales", "Q1", "Quarter1").unwrap();
        assert_eq!(
            s.table_columns("Sales").unwrap(),
            vec!["Region".to_string(), "Quarter1".to_string(), "Q2".to_string()]
        );

        // resize grow (+1 col, appended display name).
        s.resize_table("Sales", 5, 4, vec!["Q3".into()], vec![]).unwrap();
        assert_eq!(
            s.table_columns("Sales").unwrap(),
            vec![
                "Region".to_string(),
                "Quarter1".to_string(),
                "Q2".to_string(),
                "Q3".to_string()
            ]
        );

        // resize shrink (-2 trailing cols; removed_columns must match the trailing
        // displays in order — exactly what FE-8.1 col-shrink computes via slice).
        s.resize_table("Sales", 5, 2, vec![], vec!["Q2".into(), "Q3".into()])
            .unwrap();
        assert_eq!(
            s.table_columns("Sales").unwrap(),
            vec!["Region".to_string(), "Quarter1".to_string()]
        );
    }

    /// An unknown table is the SAME loud `table_not_found` (NotFound) that
    /// drop/rename raise — never an empty Vec or a silent Ok (No-Fallbacks).
    #[test]
    fn fe83_table_columns_unknown_table_errors_loud() {
        let mut s = WorkbookSession::new();
        s.add_sheet("S", 16384).unwrap();
        let err = s.table_columns("NoSuchTable").unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "table_not_found");
    }

    /// **THE critical persistence test (resurrect-on-reload).** Define a name,
    /// delete it, SAVE to `.qbook`, RELOAD, and assert the name is GONE. An
    /// in-memory list/delete test is INSUFFICIENT — it passes while the disk
    /// silently resurrects the name on the next replay. This save→reload
    /// assertion is the whole point of `Op::RemoveName`.
    #[test]
    fn fe5_delete_name_does_not_resurrect_after_save_reload() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("names.qbook");
        let path_str = path.to_str().unwrap();

        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            // Define two names; delete one.
            s.set_name("SALES", range(sheet, 0, 0, 9, 0)).unwrap();
            s.set_name("COSTS", range(sheet, 0, 1, 9, 1)).unwrap();
            assert_eq!(s.list_names().unwrap().len(), 2);
            s.delete_name("SALES", None).unwrap();
            // In-memory: only COSTS remains.
            let live: Vec<String> = s
                .list_names()
                .unwrap()
                .into_iter()
                .map(|n| n.name)
                .collect();
            assert_eq!(
                live,
                vec!["COSTS".to_string()],
                "in-memory delete removed SALES"
            );
            s.save(path_str).unwrap();
        }

        // Reload from disk — the deleted name MUST stay gone (no resurrect).
        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        let reloaded: Vec<String> = s2
            .list_names()
            .unwrap()
            .into_iter()
            .map(|n| n.name)
            .collect();
        assert_eq!(
            reloaded,
            vec!["COSTS".to_string()],
            "RESURRECT BUG: a deleted name must NOT come back after save→reload"
        );
        // And it's gone from the full snapshot too.
        let snap_names: Vec<String> = s2
            .snapshot()
            .unwrap()
            .names
            .into_iter()
            .map(|n| n.name)
            .collect();
        assert_eq!(snap_names, vec!["COSTS".to_string()]);
    }

    /// **The undo-after-delete resurrect test (the rematerialize path).**
    /// `WorkbookSession::rematerialize` (run on EVERY undo/redo) re-derives the
    /// workbook from `baseline + replay(oplog)`. Without a compensating
    /// `Op::RemoveName`, the original `Op::SetName` keeps replaying and the
    /// deleted name resurrects after an unrelated undo. This is a live
    /// (non-persistence) corruption path — stricter than the save→reload case.
    #[test]
    fn fe5_delete_name_does_not_resurrect_after_undo() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 9, 0)).unwrap();
        s.delete_name("SALES", None).unwrap();
        assert!(s.list_names().unwrap().is_empty(), "deleted in-memory");
        // Make an UNRELATED edit, then undo it — this triggers rematerialize
        // (baseline + replay(oplog)). The SALES name must NOT come back.
        s.set_value(addr(sheet, 5, 5), CellValue::Number { number: 1.0 })
            .unwrap();
        let r = s.undo().unwrap();
        assert!(r.consumed, "the unrelated edit was undone");
        assert!(
            s.list_names().unwrap().is_empty(),
            "RESURRECT BUG: a deleted name must NOT come back after an undo's rematerialize"
        );
    }

    /// **The redo-after-delete resurrect test (sibling to the undo case).**
    /// `redo` is symmetric to `undo`: it re-applies the previously-undone command
    /// and then runs `rematerialize` (`baseline + replay(oplog)`) — the SAME
    /// re-derivation path that resurrects a deleted name if the compensating
    /// `Op::RemoveName` is missing. Here we delete a name, make an unrelated edit,
    /// undo it, then REDO it: the deleted name must STAY gone across the redo's
    /// rematerialize (the redo only re-applies the unrelated edit; it does NOT
    /// touch the name, and the `RemoveName` op keeps replaying).
    #[test]
    fn fe5_delete_name_does_not_resurrect_after_redo() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 9, 0)).unwrap();
        s.delete_name("SALES", None).unwrap();
        assert!(s.list_names().unwrap().is_empty(), "deleted in-memory");
        // Unrelated edit → undo it → redo it. Each of undo/redo runs
        // rematerialize, the resurrect-prone re-derivation path.
        s.set_value(addr(sheet, 5, 5), CellValue::Number { number: 1.0 })
            .unwrap();
        let u = s.undo().unwrap();
        assert!(u.consumed, "the unrelated edit was undone");
        assert!(
            s.list_names().unwrap().is_empty(),
            "deleted name stays gone after undo"
        );
        let r = s.redo().unwrap();
        assert!(r.consumed, "the unrelated edit was redone");
        // The redo re-applied the F6 edit (observable) …
        assert_eq!(
            s.cell(addr(sheet, 5, 5)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 1.0 }),
            "redo re-applied the unrelated F6 edit"
        );
        // … and the deleted name MUST NOT have resurrected on the redo's
        // rematerialize.
        assert!(
            s.list_names().unwrap().is_empty(),
            "RESURRECT BUG: a deleted name must NOT come back after a redo's rematerialize"
        );
    }

    /// `delete_name` of an unknown name is a LOUD `name_not_found` error
    /// (NotFound), NOT a silent no-op (No-Fallbacks). And it appends nothing.
    #[test]
    fn fe5_delete_unknown_name_errors_loud() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 9, 0)).unwrap();
        let err = s.delete_name("NOPE", None).unwrap_err();
        assert_eq!(err.class, ErrorClass::NotFound);
        assert_eq!(err.code, "name_not_found");
        // The existing name is untouched.
        assert_eq!(s.list_names().unwrap().len(), 1);
    }

    /// **FE-9 (2026-06-14) — the stale-name-binding fix (dirty path).** A formula
    /// referencing a defined name kept a STALE value when the name was deleted,
    /// because the recompute Err-arm only mapped UnknownTable/Sheet → `#NAME?`
    /// and left `UnresolvedName` as a `RecomputeFailure` (which preserves the
    /// cell's prior value). Define SALES + a dependent `=SUM(SALES)`, recalc to a
    /// real value, then delete SALES and recalc: the dependent MUST become
    /// `#NAME?`, not keep its prior sum.
    #[test]
    fn fe9_deleted_name_makes_dependents_name_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap();
        // C1 = SUM(SALES) → 60.
        s.set_formula(addr(sheet, 0, 2), "SUM(SALES)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 60.0 }),
            "precondition: =SUM(SALES) computes 60"
        );
        // Delete SALES → the dependent must re-evaluate to #NAME?, NOT keep 60.
        s.delete_name("SALES", None).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9: deleting SALES must turn =SUM(SALES) into #NAME?, got {v:?} (stale-value bug)"
        );
    }

    /// **FE-9 — the "rename" case (delete + redefine).** There is no RenameName
    /// op; the IDE renames a name as `delete_name(old)` + `set_name(new)`, with no
    /// auto-rewrite of references. A formula still referencing the old name must
    /// become `#NAME?` after the rename (the same dirty→re-bind→UnresolvedName
    /// path as a plain delete). NB: the name must NOT be a valid column letter
    /// sequence (≤ "XFD") — e.g. "OLD" binds as the *column* OLD and shadows the
    /// same-named range — so this uses ALPHA/BETA (both > 3 letters).
    #[test]
    fn fe9_renamed_away_name_makes_old_ref_name_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 7.0 })
            .unwrap();
        s.set_name("ALPHA", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "SUM(ALPHA)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 12.0 }),
            "precondition: =SUM(ALPHA) computes 12"
        );
        // "Rename" ALPHA → BETA (delete + set). The =SUM(ALPHA) formula is NOT
        // rewritten, so it now references a missing name.
        s.delete_name("ALPHA", None).unwrap();
        s.set_name("BETA", range(sheet, 0, 0, 1, 0)).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9: a formula referencing the renamed-away name must be #NAME?, got {v:?}"
        );
    }

    /// **FE-9 — the load path (recompute_all on open).** A persisted workbook whose
    /// formula references a since-deleted name must show `#NAME?` after reload, not
    /// a stale value. This exercises `recompute_all` (the open/replay path) rather
    /// than the dirty path covered above.
    #[test]
    fn fe9_deleted_name_dependent_is_name_error_after_reload() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("fe9names.qbook");
        let path_str = path.to_str().unwrap();
        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 4.0 })
                .unwrap();
            s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 6.0 })
                .unwrap();
            s.set_name("SALES", range(sheet, 0, 0, 1, 0)).unwrap();
            s.set_formula(addr(sheet, 0, 2), "SUM(SALES)").unwrap();
            s.recalc_dirty().unwrap();
            s.delete_name("SALES", None).unwrap();
            s.save(path_str).unwrap();
        }
        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        // The reopened workbook recomputes from baseline+replay; the dependent
        // now binds to a missing name.
        s2.recalc_all().unwrap();
        let v = s2.cell(addr(0, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-9: reloaded =SUM(SALES) with SALES deleted must be #NAME?, got {v:?}"
        );
    }

    /// **FE-10 (2026-06-14) — a 3-letter name (a valid column ≤ XFD) resolves in a
    /// formula.** This is the case the FE-9 tests above had to AVOID (see the
    /// `fe9_renamed_away` comment: "OLD binds as the column OLD and shadows the
    /// same-named range — so this uses ALPHA/BETA"). Pre-FE-10 `=SUM(TAX)` summed
    /// the empty whole column `TAX` (= 0); now a standalone bare token binds as the
    /// NAME, so it resolves the range.
    #[test]
    fn fe10_three_letter_name_resolves_in_aggregate() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_name("TAX", range(sheet, 0, 0, 2, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 4), "SUM(TAX)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 60.0 }),
            "FE-10: =SUM(TAX) must resolve the named range (= 60), not the empty column TAX (= 0)"
        );
    }

    /// **FE-10 — deleting a 3-letter name makes dependents `#NAME?`.** Now that a
    /// 3-letter name binds as a NameRef, the FE-9 `UnresolvedName → #NAME?` net is
    /// REACHABLE for it (pre-FE-10 it never bound as a name, so deleting it left the
    /// formula silently summing the empty column).
    #[test]
    fn fe10_deleted_three_letter_name_is_name_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 4.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 6.0 })
            .unwrap();
        s.set_name("TAX", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 4), "SUM(TAX)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 }),
            "precondition: =SUM(TAX) computes 10"
        );
        s.delete_name("TAX", None).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-10: deleting TAX must turn =SUM(TAX) into #NAME?, got {v:?}"
        );
    }

    /// **FE-10 — a 3-letter name round-trips through save/reload.** The formula text
    /// `SUM(PV)` is persisted and re-parsed on open; the parser fix must survive
    /// (re-parse to a NameRef), so the reloaded workbook still resolves the name.
    #[test]
    fn fe10_three_letter_name_round_trips_through_save() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("fe10names.qbook");
        let path_str = path.to_str().unwrap();
        {
            let mut s = WorkbookSession::new();
            let sheet = s.add_sheet("S", 16384).unwrap();
            s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 100.0 })
                .unwrap();
            s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 200.0 })
                .unwrap();
            s.set_name("PV", range(sheet, 0, 0, 1, 0)).unwrap();
            s.set_formula(addr(sheet, 0, 4), "SUM(PV)").unwrap();
            s.recalc_dirty().unwrap();
            s.save(path_str).unwrap();
        }
        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        s2.recalc_all().unwrap();
        assert_eq!(
            s2.cell(addr(0, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 300.0 }),
            "FE-10: reloaded =SUM(PV) must still resolve the named range (= 300)"
        );
    }

    /// **FE-10 — the explicit colon whole-column form is UNCHANGED.** Now that a
    /// bare `A` is a name, the colon form `A:A` must still be a genuine whole-column
    /// reference (the only way to express a whole column — matching Excel).
    #[test]
    fn fe10_whole_column_colon_form_still_works() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 2.0 })
            .unwrap();
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 3.0 })
            .unwrap();
        s.set_formula(addr(sheet, 0, 4), "SUM(A:A)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 6.0 }),
            "FE-10: =SUM(A:A) (explicit colon whole column) must still sum column A (= 6)"
        );
    }

    /// **FE-10 — a name in a formula is NOT shifted as a column by insert-column.**
    /// The rewrite path (`lex → parse → shift → print`) must leave a NameRef alone.
    /// Pre-FE-10 `SUM(TAX)` parsed as a whole-column ref, so an inserted column would
    /// have SHIFTED `TAX` to a different column (silent corruption). With the parser
    /// fix it is a NameRef, which the structural shifter leaves untouched — the
    /// formula text stays `SUM(TAX)`.
    #[test]
    fn fe10_name_in_formula_not_shifted_by_insert_column() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_name("TAX", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 4), "SUM(TAX)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4))
                .unwrap()
                .unwrap()
                .formula
                .as_deref(),
            Some("SUM(TAX)"),
            "precondition: formula stored canonically as SUM(TAX)"
        );
        // Insert a column at col 0 — everything shifts right by one. A WHOLE-COLUMN
        // ref to `TAX` would shift; a NAME ref must not.
        s.insert_columns(sheet, 0, 1).unwrap();
        s.recalc_dirty().unwrap();
        // The formula cell moved from col 4 to col 5; its text must be unchanged.
        assert_eq!(
            s.cell(addr(sheet, 0, 5))
                .unwrap()
                .unwrap()
                .formula
                .as_deref(),
            Some("SUM(TAX)"),
            "FE-10: insert-column must NOT shift the NAME `TAX` in the formula text"
        );
    }

    /// **FE-10 — a 3-letter name under `@` evals IDENTICALLY to a 4+ letter name.**
    /// FE-10 routes `@OLD` through the same NameRef path `@SALES` already used.
    /// **FE-10.x (2026-06-14)** then IMPLEMENTED the `@`-over-a-named-range narrowing
    /// ("rule 10") for BOTH: `SUM(@OLD)` / `SUM(@SALES)` now narrow the single-column
    /// named range to the formula-row cell instead of summing the full range. This
    /// pins CONSISTENCY (no divergence between the 3-letter and 4+ letter case) AND
    /// the narrowed value: the formula is at row 0, so `@` narrows the range A1:A2 to
    /// A1 (= 3), NOT the full-range sum (7).
    #[test]
    fn fe10_at_name_eval_consistency() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 3.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 4.0 })
            .unwrap();
        // OLD (3-letter, previously shadowed) and SALES (4-letter) name the SAME range.
        s.set_name("OLD", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "SUM(@OLD)").unwrap();
        s.set_formula(addr(sheet, 0, 3), "SUM(@SALES)").unwrap();
        s.recalc_dirty().unwrap();
        let v_old = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        let v_sales = s.cell(addr(sheet, 0, 3)).unwrap().unwrap().value;
        assert_eq!(
            v_old,
            Some(CellValue::Number { number: 3.0 }),
            "FE-10.x: SUM(@OLD) at row 0 must NARROW A1:A2 to A1 (= 3), not sum the full range (= 7); got {v_old:?}"
        );
        assert_eq!(
            v_old, v_sales,
            "FE-10: @OLD (3-letter) must eval identically to @SALES (4-letter) — same NameRef path"
        );
    }

    /// **FE-10 — a lowercase bare token resolves case-insensitively.** `sum(tax)`
    /// → `SUM` (function) over the named range `TAX` (the lexer accepts lowercase
    /// column letters; `canonicalize_function_name` upper-cases; the NameTable
    /// lookup is case-insensitive).
    #[test]
    fn fe10_lowercase_bare_name_resolves() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_name("TAX", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "sum(tax)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "FE-10: lowercase `sum(tax)` must resolve the case-insensitive name TAX (= 30)"
        );
    }

    /// **FE-10 — RETARGETING a 3-letter RANGE name re-dirties dependents (the PRODUCT
    /// path).** A Range name (the ONLY kind the session/IDE can create — `set_name` is
    /// `NamedTarget::Range`-only) binds to `AggregateNameRef`, which records a name-dep,
    /// so `on_set_name` re-dirties `=SUM(TAX)` when TAX is redefined. This proves the
    /// product-facing column-shadow fix is fully correct under retarget (delete is
    /// covered by `fe10_deleted_three_letter_name_is_name_error`). NB: SCALAR/Constant
    /// names (`NamedTarget::Cell`/`Constant`) are runtime-API-only, NOT product-reachable,
    /// and have a PRE-EXISTING dep-tracking gap (they erase the name at bind → not
    /// re-dirtied) — affecting all name lengths, deferred to FE-10.x.
    #[test]
    fn fe10_retarget_range_name_redirties_dependents() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_value(addr(sheet, 2, 0), CellValue::Number { number: 30.0 })
            .unwrap();
        s.set_name("TAX", range(sheet, 0, 0, 1, 0)).unwrap(); // TAX = A1:A2
        s.set_formula(addr(sheet, 0, 4), "SUM(TAX)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 30.0 }),
            "precondition: =SUM(TAX) over A1:A2 = 30"
        );
        // Retarget TAX to A1:A3 (set_name is last-writer-wins upsert).
        s.set_name("TAX", range(sheet, 0, 0, 2, 0)).unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 4)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 60.0 }),
            "FE-10: retargeting the RANGE name TAX to A1:A3 must re-dirty =SUM(TAX) → 60"
        );
    }

    /// **FE-10 — a SCALAR (Constant) name re-dirties dependents on DELETE (the dep fix).**
    /// Scalar names aren't creatable via the live session (`set_name` is Range-only) but
    /// DO load from a `.qbook` / imported `.xlsx`; the runtime escape hatch seeds one here
    /// to mirror that. Pre-fix the scalar resolution ERASED the name (→ `Number`), so no
    /// name-dep was recorded → `delete_name` + recalc left a STALE value (the Codex
    /// NO-SHIP). The `ScalarNameRef` wrapper records the name-dep, so deleting K now
    /// re-dirties `=K*A1` → `#NAME?`. `K` is a 1-letter, column-shaped name — exactly the
    /// class FE-10's parser change newly routes through the scalar-name path.
    #[test]
    fn fe10_scalar_constant_name_redirties_on_delete() {
        use ql_storage::NamedTarget;
        use ql_types::Value;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 100.0 })
            .unwrap(); // A1 = 100
        s.with_runtime(|rt| rt.set_name("K", NamedTarget::Constant(Value::Number(2.0))))
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "K*A1").unwrap(); // B1 = K*A1
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 200.0 }),
            "precondition: K(=2) * A1(=100) = 200"
        );
        s.delete_name("K", None).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-10: deleting the scalar name K must re-dirty =K*A1 to #NAME?, got {v:?} (was the stale-value NO-SHIP)"
        );
    }

    /// **FE-10 — a SCALAR (Constant) name re-dirties dependents on RETARGET.** Companion
    /// to the delete case: redefining K (last-writer-wins) must recompute `=K*A1`.
    #[test]
    fn fe10_scalar_constant_name_redirties_on_retarget() {
        use ql_storage::NamedTarget;
        use ql_types::Value;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 100.0 })
            .unwrap();
        s.with_runtime(|rt| rt.set_name("K", NamedTarget::Constant(Value::Number(2.0))))
            .unwrap();
        s.set_formula(addr(sheet, 0, 1), "K*A1").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 200.0 }),
            "precondition: K(=2) * A1(=100) = 200"
        );
        // Retarget K = 3 (upsert).
        s.with_runtime(|rt| rt.set_name("K", NamedTarget::Constant(Value::Number(3.0))))
            .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 300.0 }),
            "FE-10: retargeting scalar K to 3 must re-dirty =K*A1 → 300 (not the stale 200)"
        );
    }

    /// **FE-10 — a CELL-target name stays a REFERENCE for reference-aware fns.** The
    /// `ScalarNameRef` wrapper must be transparent to ROW/COLUMN/ROWS/ISFORMULA/… (which
    /// need a reference, not a value). Regression guard for the Codex round-3 finding: the
    /// eager ref-arg materializer's catch-all evaluated the wrapper as a scalar VALUE →
    /// `ROW(name)` = `#VALUE!`. The fix recurses into `inner`, so a `Cell`-target name is
    /// a `RefArg::Reference`. Covers BOTH a 4-letter name (`ANCHOR` — correct pre-FE-10,
    /// must not regress) and a column-shaped name (`K` — newly routed through this path).
    #[test]
    fn fe10_reference_aware_fn_over_cell_target_name() {
        use ql_storage::NamedTarget;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Both names target C5 (0-indexed row 4, col 2) → ROW = 5, COLUMN = 3.
        s.with_runtime(|rt| {
            rt.set_name(
                "ANCHOR",
                NamedTarget::Cell(ql_types::Address::new(sheet, 4, 2)),
            )
        })
        .unwrap();
        s.with_runtime(|rt| {
            rt.set_name("K", NamedTarget::Cell(ql_types::Address::new(sheet, 4, 2)))
        })
        .unwrap();
        s.set_formula(addr(sheet, 0, 0), "ROW(ANCHOR)").unwrap();
        s.set_formula(addr(sheet, 1, 0), "ROW(K)").unwrap();
        s.set_formula(addr(sheet, 2, 0), "COLUMN(K)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 5.0 }),
            "FE-10: ROW(ANCHOR) (cell-target name) must be 5, not #VALUE!"
        );
        assert_eq!(
            s.cell(addr(sheet, 1, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 5.0 }),
            "FE-10: ROW(K) (column-shaped cell-target name) must be 5, not #VALUE!"
        );
        assert_eq!(
            s.cell(addr(sheet, 2, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 3.0 }),
            "FE-10: COLUMN(K) must be 3"
        );
    }

    /// **FE-10 — a bare `=K` (scalar Constant name) at the cell boundary evals.** Exercises
    /// `eval_at_cell_boundary`'s scalar path with the `ScalarNameRef` wrapper (vs the
    /// `*`-binary path of the other scalar tests).
    #[test]
    fn fe10_bare_scalar_name_at_cell_boundary() {
        use ql_storage::NamedTarget;
        use ql_types::Value;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.with_runtime(|rt| rt.set_name("K", NamedTarget::Constant(Value::Number(42.0))))
            .unwrap();
        s.set_formula(addr(sheet, 0, 0), "K").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 42.0 }),
            "FE-10: a bare `=K` (Constant name) must eval to the constant (42)"
        );
    }

    /// **FE-10 — `ISREF(<name>)` re-dirties when the name is retargeted (lazy-shape dep).**
    /// `ISREF` is a LazyShape ref-aware fn: it inspects the arg's resolved SHAPE. A name's
    /// shape flips when retargeted (Constant=literal → `ISREF`=FALSE; Cell=reference →
    /// `ISREF`=TRUE), so `ISREF(K)` must re-dirty on a name mutation. Pre-fix the
    /// LazyShape dep policy skipped ALL arg deps → `ISREF(K)` stayed stale (Codex round-4
    /// finding; pre-existing for range names too, e.g. `ISREF(SALES)`).
    #[test]
    fn fe10_isref_over_name_redirties_on_retarget() {
        use ql_storage::NamedTarget;
        use ql_types::Value;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.with_runtime(|rt| rt.set_name("K", NamedTarget::Constant(Value::Number(42.0))))
            .unwrap();
        s.set_formula(addr(sheet, 0, 0), "ISREF(K)").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Boolean { boolean: false }),
            "precondition: ISREF(K) where K is a Constant = FALSE"
        );
        // Retarget K from Constant → Cell: its resolved shape becomes a reference.
        s.with_runtime(|rt| {
            rt.set_name("K", NamedTarget::Cell(ql_types::Address::new(sheet, 4, 2)))
        })
        .unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 0)).unwrap().unwrap().value,
            Some(CellValue::Boolean { boolean: true }),
            "FE-10: retargeting K to a Cell must re-dirty ISREF(K) → TRUE (not stale FALSE)"
        );
    }

    // ===== FE-10.x (2026-06-14): Part A — reject non-referenceable names =====

    /// **FE-10.x — `set_name` rejects names no formula could reference.** A name
    /// must lex+parse to a single `NameRef` whose canonical text equals the stored
    /// key. Cell-ref shapes (`A1`/`Q1`/`FY1`/`XFD1048576`/`RC1`/`ABC123`), numbers
    /// (`123`), booleans (`TRUE`/`FALSE`), illegal-char (`$A`/`A B`) and
    /// whitespace-carrying (`" A "` — the lexer skips the spaces but the stored key
    /// keeps them) names are all REJECTED. The reserved `AI` sentinel is rejected
    /// too (by `would_accept`, a different error). NB: `R1C1` is NOT here — under
    /// A1-canonical parsing it lexes as a NAME (the trailing `C` breaks the cell-ref
    /// shape), so it is referenceable; see `fe10x_accepts_referenceable_names`.
    #[test]
    fn fe10x_rejects_non_referenceable_names() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let r = range(sheet, 0, 0, 1, 0);
        for bad in [
            "A1",
            "Q1",
            "FY1",
            "XFD1048576",
            "RC1",
            "ABC123",
            "123",
            "TRUE",
            "FALSE",
            " A ",
            "$A",
            "A B",
        ] {
            assert!(
                s.set_name(bad, r).is_err(),
                "FE-10.x: name {bad:?} must be REJECTED (not referenceable)"
            );
        }
        assert!(
            s.set_name("AI", r).is_err(),
            "FE-10.x: reserved name AI must be rejected"
        );
    }

    /// **FE-10.x — `set_name` ACCEPTS referenceable names, incl. column-shaped ones.**
    /// We are intentionally MORE permissive than Excel: anything that references fine
    /// in our A1-canonical engine is allowed. That includes `R`/`C` (Excel reserves
    /// them only for a Name-Box keyboard shortcut we lack), bare columns
    /// (`K`/`OLD`/`TAX`/`XFC`/`RC`), leading-underscore and dotted identifiers
    /// (`_foo`/`My.Range`), bare function names (`SUM`), and even `R1C1` (under
    /// A1-canonical parsing the trailing `C` breaks the cell-ref shape, so it lexes
    /// as a NAME — and our stored formulas are canonical A1, so it references fine).
    #[test]
    fn fe10x_accepts_referenceable_names() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let r = range(sheet, 0, 0, 0, 0);
        for good in [
            "R",
            "C",
            "K",
            "OLD",
            "TAX",
            "XFC",
            "RC",
            "R1C1",
            "Sales_2025",
            "_foo",
            "My.Range",
            "SUM",
            "Sheet1",
            "MyRange",
            "Data",
        ] {
            assert!(
                s.set_name(good, r).is_ok(),
                "FE-10.x: name {good:?} must be ACCEPTED (referenceable)"
            );
        }
    }

    /// **FE-10.x — the validator fires on BOTH runtime name-creation paths.**
    /// `set_sheet_scoped_name` (the second producer method) rejects a cell-ref-shaped
    /// name and accepts a referenceable one, identically to `set_name`. Also covers a
    /// SCALAR target (`Constant`), confirming the check is target-kind-agnostic.
    #[test]
    fn fe10x_sheet_scoped_and_scalar_set_name_validate() {
        use ql_storage::NamedTarget;
        use ql_types::Value;
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        // Sheet-scoped path.
        assert!(
            s.with_runtime(|rt| rt.set_sheet_scoped_name(
                sheet,
                "B2",
                NamedTarget::Constant(Value::Number(1.0))
            ))
            .is_err(),
            "FE-10.x: set_sheet_scoped_name must reject the cell-ref-shaped name B2"
        );
        assert!(
            s.with_runtime(|rt| rt.set_sheet_scoped_name(
                sheet,
                "MyRate",
                NamedTarget::Constant(Value::Number(1.0))
            ))
            .is_ok(),
            "FE-10.x: set_sheet_scoped_name must accept MyRate"
        );
        // Workbook-scoped scalar (Constant) path.
        assert!(
            s.with_runtime(|rt| rt.set_name("Q4", NamedTarget::Constant(Value::Number(1.0))))
                .is_err(),
            "FE-10.x: set_name must reject the cell-ref-shaped scalar name Q4"
        );
    }

    // ===== FE-10.x: Part B — `@` over a named range narrows (rule 10) =====

    /// **FE-10.x — `SUM(@SALES)` narrows the single-column named range to the
    /// formula-row cell.** Pre-FE-10.x this summed the FULL range (the `@` was
    /// silently ignored → wrong answer).
    #[test]
    fn fe10x_at_named_range_narrows_single_column() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap(); // A1:A3
        s.set_formula(addr(sheet, 1, 2), "SUM(@SALES)").unwrap(); // row 1 → A2
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 1, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "FE-10.x: SUM(@SALES) at row 1 must narrow A1:A3 to A2 (= 20), not sum the full range (= 60)"
        );
    }

    /// **FE-10.x — `@SALES` outside the range's row span → `#VALUE!`.**
    #[test]
    fn fe10x_at_named_range_out_of_span_is_value_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 10.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 20.0 })
            .unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 1, 0)).unwrap(); // A1:A2 (rows 0-1)
        s.set_formula(addr(sheet, 5, 2), "@SALES").unwrap(); // row 5 is outside
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 5, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#VALUE!"),
            "FE-10.x: @SALES outside the range's row span must be #VALUE!, got {v:?}"
        );
    }

    /// **FE-10.x — `@<2-D named range>` → `#VALUE!`.**
    #[test]
    fn fe10x_at_named_range_2d_is_value_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
            .unwrap();
        s.set_name("GRID", range(sheet, 0, 0, 1, 1)).unwrap(); // A1:B2 (2-D)
        s.set_formula(addr(sheet, 0, 3), "@GRID").unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 3)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#VALUE!"),
            "FE-10.x: @<2-D named range> must be #VALUE!, got {v:?}"
        );
    }

    /// **FE-10.x — bare `=@SALES` narrows to a single cell** (was the
    /// `NamedRangeInScalarContext` error before — `@` is the scalarization operator).
    #[test]
    fn fe10x_bare_at_named_range_narrows_not_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 7.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 8.0 })
            .unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 1, 2), "@SALES").unwrap(); // row 1 → A2 = 8
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 1, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 8.0 }),
            "FE-10.x: bare =@SALES must narrow to the anchor-row cell (A2 = 8), not error"
        );
    }

    /// **FE-10.x — the narrowed `@SALES` preserves the name-dep (the crux).** The
    /// narrowed result is wrapped in `ScalarNameRef`, so RETARGETING `SALES`
    /// re-dirties + re-narrows the formula (and the Error inner re-dirties too):
    /// retargeting to A2:A3 puts the row-0 formula OUT of span → `#VALUE!`. Without
    /// the wrapper the bare CellRef would drop the dep and stay stale at 10.
    #[test]
    fn fe10x_at_named_range_redirties_on_retarget() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap(); // A1:A3
        s.set_formula(addr(sheet, 0, 2), "@SALES").unwrap(); // row 0 → A1 = 10
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 }),
            "precondition: @SALES at row 0 narrows A1:A3 to A1 = 10"
        );
        // Retarget SALES to A2:A3 — row 0 is now OUTSIDE the span.
        s.set_name("SALES", range(sheet, 1, 0, 2, 0)).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#VALUE!"),
            "FE-10.x: retargeting SALES to A2:A3 must re-dirty @SALES at row 0 → #VALUE! \
             (dep preserved via ScalarNameRef, incl. the Error inner), got {v:?}"
        );
    }

    /// **FE-10.x — deleting the name makes `@SALES` go `#NAME?`** (dep preserved →
    /// reachable FE-9 `#NAME?` net).
    #[test]
    fn fe10x_at_named_range_delete_is_name_error() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 5.0 })
            .unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 6.0 })
            .unwrap();
        s.set_name("SALES", range(sheet, 0, 0, 1, 0)).unwrap();
        s.set_formula(addr(sheet, 0, 2), "@SALES").unwrap(); // row 0 → A1 = 5
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 5.0 }),
            "precondition: @SALES = A1 = 5"
        );
        s.delete_name("SALES", None).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#NAME?"),
            "FE-10.x: deleting SALES must turn @SALES into #NAME?, got {v:?}"
        );
    }

    /// **FE-10.x — the same `@SALES` text in two rows narrows to DIFFERENT cells.**
    /// Guards the `@` cell-anchor cache: the bound plan must key on the formula
    /// anchor, not just the text, or both rows would collapse to one cell.
    #[test]
    fn fe10x_at_named_range_anchor_cache_two_rows() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap(); // A1:A3
        s.set_formula(addr(sheet, 0, 2), "@SALES").unwrap(); // row 0 → A1 = 10
        s.set_formula(addr(sheet, 1, 2), "@SALES").unwrap(); // row 1 → A2 = 20
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 0, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 10.0 }),
            "FE-10.x: @SALES at row 0 → A1 = 10"
        );
        assert_eq!(
            s.cell(addr(sheet, 1, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 20.0 }),
            "FE-10.x: @SALES at row 1 → A2 = 20 (anchor-keyed, not collapsed to A1)"
        );
    }

    /// **FE-10.x — a reference-aware fn over `@<named range>` sees a REFERENCE.**
    /// `@SALES` narrows to a `CellRef` (wrapped in `ScalarNameRef`), so `ROW(@SALES)`
    /// returns the anchor row's 1-indexed number (NOT `#VALUE!` — the FE-10 round-3
    /// "wrapper mishandled by a ref-arg materializer" class). Retargeting `SALES` out
    /// of the anchor's span re-dirties → `#VALUE!`, proving the name-dep survives
    /// through the address-only dep walker.
    #[test]
    fn fe10x_reference_aware_fn_over_at_name() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0), (3, 40.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 3, 0)).unwrap(); // A1:A4 (rows 0-3)
        s.set_formula(addr(sheet, 2, 2), "ROW(@SALES)").unwrap(); // row 2 → A3 → ROW = 3
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 2, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 3.0 }),
            "FE-10.x: ROW(@SALES) at row 2 must be the 1-indexed anchor row (3), not #VALUE!"
        );
        // Retarget SALES to the single-column A4:A5 (rows 3-4) → row 2 is now out of
        // span → re-dirty → #VALUE! (a single CELL would be idempotent, not out of
        // span — so use a multi-row column that excludes the anchor row).
        s.set_name("SALES", range(sheet, 3, 0, 4, 0)).unwrap();
        s.recalc_dirty().unwrap();
        let v = s.cell(addr(sheet, 2, 2)).unwrap().unwrap().value;
        assert!(
            matches!(&v, Some(CellValue::Error { error }) if error == "#VALUE!"),
            "FE-10.x: retargeting SALES to A4:A5 must re-dirty ROW(@SALES) at row 2 → #VALUE!, got {v:?}"
        );
    }

    /// **FE-10.x — `@<single-row name>` narrows to the anchor COLUMN; `@<single-cell
    /// name>` is idempotent.** Covers the rule-3 and rule-5 branches of
    /// `narrow_concrete_range` for a NAMED range (the single-column case is covered
    /// elsewhere).
    #[test]
    fn fe10x_at_named_range_single_row_and_single_cell() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 100.0 })
            .unwrap();
        s.set_value(addr(sheet, 0, 1), CellValue::Number { number: 200.0 })
            .unwrap();
        s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 300.0 })
            .unwrap();
        // Single ROW A1:C1 → @ narrows to the anchor col.
        s.set_name("ROWRANGE", range(sheet, 0, 0, 0, 2)).unwrap();
        s.set_formula(addr(sheet, 5, 1), "@ROWRANGE").unwrap(); // col 1 → B1 = 200
                                                                // Single CELL A1:A1 → @ idempotent → A1 regardless of anchor.
        s.set_name("ONECELL", range(sheet, 0, 0, 0, 0)).unwrap();
        s.set_formula(addr(sheet, 7, 7), "@ONECELL").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 5, 1)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 200.0 }),
            "FE-10.x: @<single-row name> at col 1 must narrow to B1 (= 200)"
        );
        assert_eq!(
            s.cell(addr(sheet, 7, 7)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 100.0 }),
            "FE-10.x: @<single-cell name> must be idempotent → A1 (= 100), regardless of anchor"
        );
    }

    /// **FE-10.x — `@<cross-sheet named range>` narrows on the NAME's sheet.** A
    /// workbook-scoped name whose range lives on a different sheet than the formula:
    /// narrowing uses the name's sheet (`r.sheet`) with the FORMULA's anchor row.
    #[test]
    fn fe10x_at_named_range_cross_sheet() {
        let mut s = WorkbookSession::new();
        let s0 = s.add_sheet("S0", 16384).unwrap();
        let s1 = s.add_sheet("S1", 16384).unwrap();
        s.set_value(addr(s1, 0, 0), CellValue::Number { number: 11.0 })
            .unwrap();
        s.set_value(addr(s1, 1, 0), CellValue::Number { number: 22.0 })
            .unwrap();
        s.set_value(addr(s1, 2, 0), CellValue::Number { number: 33.0 })
            .unwrap();
        s.set_name("REMOTE", range(s1, 0, 0, 2, 0)).unwrap(); // S1!A1:A3
                                                              // Formula on S0 at row 1 → narrows REMOTE to S1!A2 = 22.
        s.set_formula(addr(s0, 1, 2), "@REMOTE").unwrap();
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(s0, 1, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 22.0 }),
            "FE-10.x: @<cross-sheet name> at row 1 must narrow to S1!A2 (= 22) on the name's sheet"
        );
    }

    /// **FE-10.x — `COLUMN(@name)` (address-only) and `ISREF(@name)` (lazy-shape)
    /// over the narrowed wrapper.** Makes the dep-policy coverage explicit across the
    /// two non-normal walkers: `COLUMN`/`ROWS`/`COLUMNS` share the address-only branch
    /// with `ROW` (tested separately); `ISREF` is LazyShape. A `@<single-col name>`
    /// narrows to a `CellRef`, so `COLUMN` reads its 1-indexed column and `ISREF` is
    /// TRUE (it IS a reference).
    #[test]
    fn fe10x_column_and_isref_over_at_name() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        for (rr, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
            s.set_value(addr(sheet, rr, 0), CellValue::Number { number: v })
                .unwrap();
        }
        s.set_name("SALES", range(sheet, 0, 0, 2, 0)).unwrap(); // A1:A3 (col 0)
        s.set_formula(addr(sheet, 1, 2), "COLUMN(@SALES)").unwrap(); // → A2 → COLUMN = 1
        s.set_formula(addr(sheet, 1, 3), "ISREF(@SALES)").unwrap(); // → A2 → a reference
        s.recalc_dirty().unwrap();
        assert_eq!(
            s.cell(addr(sheet, 1, 2)).unwrap().unwrap().value,
            Some(CellValue::Number { number: 1.0 }),
            "FE-10.x: COLUMN(@SALES) must be the 1-indexed column of the narrowed cell (1)"
        );
        assert_eq!(
            s.cell(addr(sheet, 1, 3)).unwrap().unwrap().value,
            Some(CellValue::Boolean { boolean: true }),
            "FE-10.x: ISREF(@SALES) must be TRUE — the narrowed @name is a reference"
        );
    }

    /// `list_names` walks BOTH workbook-scoped AND sheet-scoped tables, and all
    /// four `NamedTarget` variants round-trip faithfully (no coercion). We use
    /// the runtime directly to register Constant/Formula/Cell names (the
    /// session `set_name` only creates Range), then assert the DTO shapes.
    #[test]
    fn fe5_list_names_both_scopes_all_four_variants() {
        let mut s = WorkbookSession::new();
        let s0 = s.add_sheet("S0", 16384).unwrap();
        let s1 = s.add_sheet("S1", 16384).unwrap();
        // Workbook-scoped, all four variants via the runtime (bypasses the
        // session's Range-only set_name).
        s.with_runtime(|rt| {
            rt.set_name(
                "ANCHOR",
                NamedTarget::Cell(ql_types::Address::new(s0, 2, 3)),
            )
            .unwrap();
            rt.set_name(
                "SALES",
                NamedTarget::Range(ql_types::Range::new(s0, 0, 0, 9, 0)),
            )
            .unwrap();
            rt.set_name("TAXRATE", NamedTarget::Constant(Value::Number(0.21)))
                .unwrap();
            rt.set_name(
                "PROFIT",
                NamedTarget::Formula(std::sync::Arc::from("REVENUE - COSTS")),
            )
            .unwrap();
        });
        // Sheet-scoped on s1.
        s.with_runtime(|rt| {
            rt.set_sheet_scoped_name(s1, "LOCALRATE", NamedTarget::Constant(Value::Number(0.05)))
                .unwrap();
        });

        let names = s.list_names().unwrap();
        // 4 workbook-scoped + 1 sheet-scoped.
        assert_eq!(names.len(), 5);

        let find = |n: &str| names.iter().find(|x| x.name == n).unwrap().clone();

        // Cell variant — faithful (NOT coerced to Range).
        match find("ANCHOR").target {
            NamedTargetDto::Cell { cell } => {
                assert_eq!((cell.sheet, cell.row, cell.col), (s0, 2, 3));
            }
            other => panic!("ANCHOR should be Cell, got {other:?}"),
        }
        // Range variant.
        match find("SALES").target {
            NamedTargetDto::Range { range } => {
                assert_eq!(range.start_row, 0);
                assert_eq!(range.end_row, 9);
            }
            other => panic!("SALES should be Range, got {other:?}"),
        }
        // Constant variant — faithful (NOT coerced to Range).
        match find("TAXRATE").target {
            NamedTargetDto::Constant {
                value: CellValue::Number { number },
            } => assert_eq!(number, 0.21),
            other => panic!("TAXRATE should be Constant(Number), got {other:?}"),
        }
        // Formula variant — faithful (NOT coerced to Range).
        match find("PROFIT").target {
            NamedTargetDto::Formula { source } => assert_eq!(source, "REVENUE - COSTS"),
            other => panic!("PROFIT should be Formula, got {other:?}"),
        }
        // Sheet-scoped entry carries scope = Some(s1).
        let local = find("LOCALRATE");
        assert_eq!(local.scope, Some(s1));
        match local.target {
            NamedTargetDto::Constant {
                value: CellValue::Number { number },
            } => assert_eq!(number, 0.05),
            other => panic!("LOCALRATE should be Constant(Number), got {other:?}"),
        }

        // Sort order: workbook-scoped (scope None) first, then by name; the
        // sheet-scoped LOCALRATE comes last (scope Some sorts after None).
        assert_eq!(names.last().unwrap().name, "LOCALRATE");
    }

    /// `.qbook` names round-trip: define names (all variants, both scopes) →
    /// save → reload → `list_names` matches. Exercises the envelope persistence
    /// path (distinct from the oplog `RemoveName` path).
    #[test]
    fn fe5_qbook_names_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("rt.qbook");
        let path_str = path.to_str().unwrap();

        let (s0, s1);
        {
            let mut s = WorkbookSession::new();
            s0 = s.add_sheet("S0", 16384).unwrap();
            s1 = s.add_sheet("S1", 16384).unwrap();
            s.with_runtime(|rt| {
                rt.set_name("TAXRATE", NamedTarget::Constant(Value::Number(0.21)))
                    .unwrap();
                rt.set_name(
                    "SALES",
                    NamedTarget::Range(ql_types::Range::new(s0, 0, 0, 9, 0)),
                )
                .unwrap();
                rt.set_sheet_scoped_name(
                    s1,
                    "LOCALRATE",
                    NamedTarget::Constant(Value::Number(0.05)),
                )
                .unwrap();
            });
            s.save(path_str).unwrap();
        }

        let mut s2 = WorkbookSession::new();
        s2.open(path_str).unwrap();
        let names = s2.list_names().unwrap();
        assert_eq!(names.len(), 3, "all three names survive save→reload");

        let find = |n: &str| names.iter().find(|x| x.name == n).unwrap().clone();
        assert!(matches!(
            find("TAXRATE").target,
            NamedTargetDto::Constant {
                value: CellValue::Number { number }
            } if number == 0.21
        ));
        assert!(matches!(find("SALES").target, NamedTargetDto::Range { .. }));
        let local = find("LOCALRATE");
        assert_eq!(local.scope, Some(s1));
        let _ = s0; // silence unused on some paths
    }
}
