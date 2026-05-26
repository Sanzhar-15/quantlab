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
//! ## Scope (6.1B inc.2 — the "core path" sub-increment)
//!
//! This increment ships the architecturally load-bearing core **real**:
//! - lifecycle (`new`/`close`/state gating, the `Busy` state, version `epoch`),
//! - single-cell mutations (`set_value`/`set_formula`/`clear`/`set_format`/
//!   `register_format`) + sheet `add`/`rename` + `set_name`,
//! - recalc (`recalc_dirty`/`recalc_all`/`mark_volatiles_dirty`) under the
//!   `Busy` + operation-registry model,
//! - the read path (`snapshot`/`cell`/`list_sheets`) + the `{epoch, op_count}`
//!   version token,
//! - operations + events (`cancel`/`operation_status`/`poll_events`).
//!
//! The remaining contract methods return a **surfaced** `Capability` /
//! `not_implemented_in_v1_core` error (NOT a silent fallback — project
//! No-Fallbacks rule) and land in later inc.2 sub-increments:
//! - persistence (`open`/`import`/`save`/`export`),
//! - `query_range` + `snapshot_delta` (see the two notes below),
//! - `delete_sheet`/`restore_sheet`/`move_sheet` (need manual op-emission +
//!   fail-loud wrappers — MED-3), table ops, `batch`/transactions,
//!   `undo`/`redo`, function registration (6.4), reserved bulk ops (6.4/6.5).
//!
//! ## Two design facts discovered while grounding this increment
//!
//! 1. **Version token = `{epoch, op_count}` — and `ql-oplog::OpLog` DOES have a
//!    Loro version vector** (`oplog_vv()`), contrary to an earlier doc claim
//!    that it had none. We still use `{epoch, op_count}` deliberately, because
//!    (a) `op_count = OpLog::len()` is the simplest monotonic single-writer
//!    counter and (b) `len()` is NOT monotonic under undo-retraction
//!    (`OpLog::len` reads Loro live), so the `epoch` (bumped on
//!    reload / cache-clear / undo) is what keeps tokens sound — not the absence
//!    of a VV. The Loro VV is reserved for the v1.5 collab delta-sync path.
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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{NamedTarget, Workbook};
use ql_types::{ColId, RowId, SheetId, Value};

use ql_session::dto::{
    BatchOptions, BatchResult, BoundRange, CellAddr, CellRange, CellSnapshot, CellValue, DateSystem,
    Diagnostic, DirtyResult, FormatDef, FormatId, PublishedRef, RangeQueryOptions, RangeResult,
    Severity, SessionVersion, SheetInfo, SheetSnapshot, UndoRedoResult, WorkbookSnapshot,
    WorkbookSnapshotDelta, WriteRangeResult,
};
use ql_session::error::{EngineError, EngineResult, ErrorClass};
use ql_session::function_meta::FunctionMetadata;
use ql_session::operation::{LifecycleState, OperationId, OperationState};
use ql_session::session::{
    EngineSession, Event, EventCursor, EventPage, FunctionImplHandle, SessionOp, TransactionId,
};
use ql_session::SCHEMA_VERSION;

use crate::{CalcgraphSession, PlanCache, RuntimeError, WorkbookRuntime};

/// Process-global epoch source. A fresh epoch is minted per session
/// construction (and would be re-minted on reload / cache-clear / undo when
/// those land). Monotonic within a process — sufficient for v1 single-writer
/// token validity; cross-process epoch handling lands with persistence.
static EPOCH_COUNTER: AtomicU64 = AtomicU64::new(1);

fn mint_epoch() -> u128 {
    EPOCH_COUNTER.fetch_add(1, Ordering::Relaxed) as u128
}

/// The owning, single-writer engine session (contract §2.1).
///
/// Bindings wrap this behind an opaque handle (Node: `#[napi]` over
/// `Arc<Mutex<WorkbookSession>>`; C: an opaque pointer; etc.) — no borrowed
/// engine reference ever crosses FFI (§2.2).
pub struct WorkbookSession {
    /// Live, single-writer cell/sheet/table/name/format storage.
    workbook: Workbook,
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
    /// Version-token epoch (minted at construction; re-minted on cache-clear /
    /// undo when those land).
    epoch: u128,
    /// Operation registry: op-id → terminal-or-running state (§6).
    ops: HashMap<OperationId, OperationState>,
    /// Monotonic op-id source.
    next_op_id: u64,
    /// Append-only event ring; the cursor is an index into this vec (§9).
    /// v1: unbounded, `dropped` always false (no retention horizon yet).
    events: Vec<Event>,
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
        Self {
            workbook,
            oplog: OpLog::new(),
            graph,
            plan_cache: PlanCache::new(),
            registry: Arc::new(ql_functions::default_registry()),
            state: LifecycleState::Ready,
            epoch: mint_epoch(),
            ops: HashMap::new(),
            next_op_id: 1,
            events: Vec::new(),
        }
    }

    // --- internal helpers ---

    /// Run a closure against a per-edit `WorkbookRuntime` that borrows the
    /// session's owned state, recovering the (warmed) plan cache afterwards.
    /// The runtime borrow never escapes this function.
    fn with_runtime<R>(&mut self, f: impl FnOnce(&mut WorkbookRuntime<'_>) -> R) -> R {
        let cache = std::mem::take(&mut self.plan_cache);
        let mut rt = WorkbookRuntime::with_session_state(
            &mut self.workbook,
            &self.registry,
            &mut self.oplog,
            &mut self.graph,
            cache,
        );
        let out = f(&mut rt);
        self.plan_cache = rt.into_plan_cache();
        out
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
            LifecycleState::New => Err(EngineError::invalid_state(
                "session is not open yet (New)",
            )),
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

    /// Encode the current `{epoch, op_count}` version token (§4.0). 16-byte
    /// big-endian epoch followed by 8-byte big-endian op_count.
    fn current_version(&self) -> SessionVersion {
        let mut bytes = Vec::with_capacity(24);
        bytes.extend_from_slice(&self.epoch.to_be_bytes());
        bytes.extend_from_slice(&(self.oplog.len() as u64).to_be_bytes());
        SessionVersion(bytes)
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
    fn build_cell_snapshot(&self, sheet_id: SheetId, row: RowId, col: ColId) -> Option<CellSnapshot> {
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
        Ok(())
    }

    // --- Mutation — single edits (§3.2) ---

    fn set_value(&mut self, addr: CellAddr, value: CellValue) -> EngineResult<()> {
        self.ensure_ready()?;
        let v = cell_value_to_value(value)?;
        self.with_runtime(|rt| rt.set_value(addr.sheet, addr.row, addr.col, v))
            .map_err(map_runtime_err)
    }

    fn set_formula(&mut self, addr: CellAddr, text: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.set_formula(addr.sheet, addr.row, addr.col, text))
            .map(|_value| ())
            .map_err(map_runtime_err)
    }

    fn clear(&mut self, addr: CellAddr) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.clear_formula(addr.sheet, addr.row, addr.col))
            .map_err(map_runtime_err)
    }

    fn set_format(&mut self, addr: CellAddr, format: FormatId) -> EngineResult<()> {
        self.ensure_ready()?;
        let id = dto_format_id_to_storage(format);
        self.with_runtime(|rt| rt.set_cell_format(addr.sheet, addr.row, addr.col, Some(id)))
            .map_err(map_runtime_err)
    }

    fn register_format(&mut self, format_string: &str) -> EngineResult<FormatId> {
        self.ensure_ready()?;
        let id = self
            .with_runtime(|rt| rt.intern_format(format_string))
            .map_err(map_runtime_err)?;
        Ok(storage_format_id_to_dto(id))
    }

    fn validate_formula(&self, _addr: CellAddr, _text: &str) -> EngineResult<Vec<Diagnostic>> {
        // Deferred: validate_formula is `&self` but WorkbookRuntime construction
        // needs `&mut`. The read-only lex+parse+bind path is implementable
        // directly against `&self.workbook`; it lands in the next inc.2 sub-step.
        Err(not_implemented("validate_formula"))
    }

    // --- Mutation — structure (§3.3) ---

    fn add_sheet(&mut self, name: &str, chunk_rows: u32) -> EngineResult<SheetId> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.add_sheet(name, chunk_rows))
            .map_err(map_runtime_err)
    }

    fn rename_sheet(&mut self, id: SheetId, name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.rename_sheet(id, name))
            .map_err(map_runtime_err)
    }

    fn delete_sheet(&mut self, _id: SheetId) -> EngineResult<()> {
        // Needs a fail-loud wrapper + manual Op::RemoveSheet emission (MED-3);
        // Workbook::remove_sheet is a silent no-op and isn't on WorkbookRuntime.
        Err(not_implemented("delete_sheet"))
    }

    fn restore_sheet(&mut self, _id: SheetId) -> EngineResult<()> {
        Err(not_implemented("restore_sheet"))
    }

    fn move_sheet(&mut self, _id: SheetId, _index: u32) -> EngineResult<()> {
        Err(not_implemented("move_sheet"))
    }

    fn set_name(&mut self, name: &str, target: CellRange) -> EngineResult<()> {
        self.ensure_ready()?;
        let range: ql_types::Range = target.into();
        self.with_runtime(|rt| rt.set_name(name, NamedTarget::Range(range)))
            .map_err(map_runtime_err)
    }

    fn create_table(&mut self, _spec: ql_session::dto::TableSpec) -> EngineResult<()> {
        Err(not_implemented("create_table"))
    }

    fn rename_table(&mut self, _old_name: &str, _new_name: &str) -> EngineResult<()> {
        Err(not_implemented("rename_table"))
    }

    fn rename_column(&mut self, _table: &str, _old_col: &str, _new_col: &str) -> EngineResult<()> {
        Err(not_implemented("rename_column"))
    }

    fn resize_table(
        &mut self,
        _name: &str,
        _new_rows: u32,
        _new_cols: u32,
        _added_columns: Vec<String>,
        _removed_columns: Vec<String>,
    ) -> EngineResult<()> {
        Err(not_implemented("resize_table"))
    }

    fn drop_table(&mut self, _name: &str) -> EngineResult<()> {
        Err(not_implemented("drop_table"))
    }

    // --- Batch / transaction (§3.4) ---

    fn batch(&mut self, _ops: Vec<SessionOp>, _options: BatchOptions) -> EngineResult<BatchResult> {
        Err(not_implemented("batch"))
    }

    fn begin_transaction(&mut self) -> EngineResult<TransactionId> {
        Err(not_implemented("begin_transaction"))
    }

    fn txn_add(&mut self, _txn: TransactionId, _op: SessionOp) -> EngineResult<()> {
        Err(not_implemented("txn_add"))
    }

    fn commit_transaction(&mut self, _txn: TransactionId) -> EngineResult<BatchResult> {
        Err(not_implemented("commit_transaction"))
    }

    fn rollback_transaction(&mut self, _txn: TransactionId) -> EngineResult<()> {
        Err(not_implemented("rollback_transaction"))
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
        _range: CellRange,
        _options: RangeQueryOptions,
    ) -> EngineResult<RangeResult> {
        // Deferred pending a CellValue blank-representation decision: a columnar
        // RangeResult must represent empty cells, but `CellValue` has no Blank
        // variant. Resolving this (add `CellValue::Blank` vs `Vec<Option<..>>`)
        // is a deliberate contract change tracked for the next inc.2 sub-step;
        // snapshot/cell handle blanks via `Option`/skip and prove the read path.
        Err(not_implemented("query_range"))
    }

    fn snapshot(&self) -> EngineResult<WorkbookSnapshot> {
        self.ensure_readable()?;
        let mut sheets = Vec::new();
        for &sheet_id in self.workbook.sheet_display_order() {
            if self.workbook.is_sheet_removed(sheet_id) {
                continue;
            }
            let name = match self.workbook.sheet(sheet_id) {
                Some(s) => s.name().to_string(),
                None => continue,
            };
            let mut cells = Vec::new();
            for (row, col) in self.populated_coords(sheet_id) {
                if let Some(cell) = self.build_cell_snapshot(sheet_id, row, col) {
                    cells.push(cell);
                }
            }
            sheets.push(SheetSnapshot {
                id: sheet_id,
                name,
                cells,
            });
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

    fn snapshot_delta(&self, _last_version: &SessionVersion) -> EngineResult<WorkbookSnapshotDelta> {
        // Step 6 of the impl plan: the op-walk delta + the §4.3 full-rebuild /
        // invalid_version_token rules. Returning full_rebuild_required here
        // would be a silent-resync fallback (forbidden), so this is an honest
        // not-yet until the delta walk lands.
        Err(not_implemented("snapshot_delta"))
    }

    fn cell(&self, addr: CellAddr) -> EngineResult<Option<CellSnapshot>> {
        self.ensure_readable()?;
        if self.workbook.sheet(addr.sheet).is_none() {
            return Err(EngineError::new(
                ErrorClass::NotFound,
                "sheet_not_found",
                format!("sheet {} does not exist", addr.sheet),
            ));
        }
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

    fn undo(&mut self) -> EngineResult<UndoRedoResult> {
        Err(not_implemented("undo"))
    }

    fn redo(&mut self) -> EngineResult<UndoRedoResult> {
        Err(not_implemented("redo"))
    }

    fn can_undo(&self) -> bool {
        // No undo machinery wired in this increment → no step available.
        false
    }

    fn can_redo(&self) -> bool {
        false
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
        CellValue::Pending => Err(EngineError::bad_argument(
            "Pending is a computed-state marker, not a valid input value",
        )),
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
        }
        // NOTE: no wildcard arm. `RuntimeError` is `#[non_exhaustive]`, but
        // this match is in the SAME crate, so it must be exhaustive — which is
        // exactly the safety the contract wants (§5.3): a newly-added variant
        // becomes a COMPILE error here, forcing an explicit mapping rather than
        // silently leaking through a catch-all.
    }
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
        for err in [
            s.snapshot_delta(&SessionVersion(vec![])).unwrap_err(),
            s.open("/tmp/x.qbook").unwrap_err(),
            s.undo().unwrap_err(),
        ] {
            assert_eq!(err.class, ErrorClass::Capability);
            assert_eq!(err.code, "not_implemented_in_v1_core");
        }
        assert!(!s.can_undo());
        assert!(!s.can_redo());
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
}
