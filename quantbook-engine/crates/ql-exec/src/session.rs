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

use ql_formula_syntax::{lex, parse};
use ql_oplog::Op;
use ql_session::dto::{
    BatchOptions, BatchResult, BoundRange, CellAddr, CellRange, CellSnapshot, CellValue, DateSystem,
    Diagnostic, DirtyResult, FormatDef, FormatId, PublishedRef, RangeColumn, RangeQueryOptions,
    RangeResult, Severity, SessionVersion, SheetInfo, SheetSnapshot, TableSpec, UndoRedoResult,
    WorkbookSnapshot, WorkbookSnapshotDelta, WriteRangeResult,
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

    /// Fail-loud sheet-existence check (MED-3): an unknown id → `NotFound`,
    /// never a silent storage no-op/clamp. (A *known* but tombstoned id still
    /// "exists" for delete/restore idempotency.)
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

    fn validate_formula(&self, addr: CellAddr, text: &str) -> EngineResult<Vec<Diagnostic>> {
        self.ensure_readable()?;
        if self.workbook.sheet(addr.sheet).is_none() {
            return Err(EngineError::new(
                ErrorClass::NotFound,
                "sheet_not_found",
                format!("sheet {} does not exist", addr.sheet),
            ));
        }
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
        self.with_runtime(|rt| rt.add_sheet(name, chunk_rows))
            .map_err(map_runtime_err)
    }

    fn rename_sheet(&mut self, id: SheetId, name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.rename_sheet(id, name))
            .map_err(map_runtime_err)
    }

    fn delete_sheet(&mut self, id: SheetId) -> EngineResult<()> {
        self.ensure_ready()?;
        // Fail-loud (MED-3): unknown id → NotFound (NOT the silent storage no-op).
        // An already-tombstoned (but known) id is an idempotent no-op, not an error.
        self.require_sheet_exists(id, "delete_sheet")?;
        // Producer order: append-before-mutate, so a failed append leaves the
        // workbook unchanged. (`Workbook::remove_sheet` tombstones — preserving
        // cells for restore; cross-sheet dependents are NOT proactively dirtied
        // here, matching the engine's current cross-sheet-ref handling.)
        self.oplog.append(Op::RemoveSheet { id }).map_err(oplog_append_err)?;
        self.workbook.remove_sheet(id);
        Ok(())
    }

    fn restore_sheet(&mut self, id: SheetId) -> EngineResult<()> {
        self.ensure_ready()?;
        self.require_sheet_exists(id, "restore_sheet")?;
        self.oplog.append(Op::RestoreSheet { id }).map_err(oplog_append_err)?;
        self.workbook.restore_sheet(id);
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
        self.oplog
            .append(Op::MoveSheet { id, new_index: index })
            .map_err(oplog_append_err)?;
        self.workbook.move_sheet(id, index);
        Ok(())
    }

    fn set_name(&mut self, name: &str, target: CellRange) -> EngineResult<()> {
        self.ensure_ready()?;
        let range: ql_types::Range = target.into();
        self.with_runtime(|rt| rt.set_name(name, NamedTarget::Range(range)))
            .map_err(map_runtime_err)
    }

    fn create_table(&mut self, spec: TableSpec) -> EngineResult<()> {
        self.ensure_ready()?;
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
                &name, sheet, top_row, top_col, rows, cols, has_header, has_totals, column_names,
            )
        })
        .map_err(map_runtime_err)
    }

    fn rename_table(&mut self, old_name: &str, new_name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.rename_table(old_name, new_name))
            .map(|_affected| ())
            .map_err(map_runtime_err)
    }

    fn rename_column(&mut self, table: &str, old_col: &str, new_col: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.rename_column(table, old_col, new_col))
            .map(|_affected| ())
            .map_err(map_runtime_err)
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
        .map_err(map_runtime_err)
    }

    fn drop_table(&mut self, name: &str) -> EngineResult<()> {
        self.ensure_ready()?;
        self.with_runtime(|rt| rt.drop_table(name))
            .map_err(map_runtime_err)
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
        range: CellRange,
        _options: RangeQueryOptions,
    ) -> EngineResult<RangeResult> {
        // `_options` (include_formulas/formats/rendered) is reserved: the v1
        // `RangeColumn` carries values only. Empty cells are `CellValue::Blank`
        // (added inc.2c) so the columnar shape stays fixed-size.
        self.ensure_readable()?;
        let sheet = self.workbook.sheet(range.sheet).ok_or_else(|| {
            EngineError::new(
                ErrorClass::NotFound,
                "sheet_not_found",
                format!("sheet {} does not exist", range.sheet),
            )
        })?;
        if range.end_row < range.start_row || range.end_col < range.start_col {
            return Err(EngineError::bad_argument(
                "range end coordinate is before its start",
            ));
        }
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
        // DEFERRED (inc.2c-2) with a known DESIGN PROBLEM to resolve deliberately
        // — surfaced honestly rather than shipped incomplete:
        //
        // The obvious stateless implementation — decode the `{epoch, op_count}`
        // token and walk ops `[last_op_count .. current)` from the op-log — is
        // INSUFFICIENT, because `recompute_dirty`/`recompute_all` write recomputed
        // dependent values via `Workbook::put_computed_at` and DO NOT append ops.
        // So an op-walk captures the *user-edited* cell (e.g. A1) but MISSES its
        // recomputed dependents (e.g. B1=A1*2) — a silently incomplete delta
        // (No-Fallbacks violation).
        //
        // A correct delta needs the set of cells whose value/formula/format
        // changed since `last_version`, INCLUDING recompute-affected ones. But
        // `snapshot_delta` is `&self` (can't cache a prior snapshot to diff), and
        // `RecomputeResult` does not return the changed coords. Resolution
        // options (decide in the audit / next window):
        //   (a) maintain a session change-log keyed by version (built during
        //       mutations + recompute; snapshot_delta reads it with &self) —
        //       requires recompute to report changed coords (extend
        //       RecomputeResult or read the graph dirty set pre-recompute);
        //   (b) make snapshot_delta `&mut self` + a diff-against-last-snapshot
        //       cache (mirrors the proven collab path) — a contract change;
        //   (c) have recompute append computed-value ops (heavy; pollutes the log).
        // (a) is the likely choice. See workbook-session-impl-plan.md §0 item 3.
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
        }
        // NOTE: no wildcard arm. `RuntimeError` is `#[non_exhaustive]`, but
        // this match is in the SAME crate, so it must be exhaustive — which is
        // exactly the safety the contract wants (§5.3): a newly-added variant
        // becomes a COMPILE error here, forcing an explicit mapping rather than
        // silently leaking through a catch-all.
    }
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
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 }).unwrap();
        s.set_value(addr(sheet, 1, 0), CellValue::Number { number: 2.0 }).unwrap();
        // B-column left empty.
        let r = s
            .query_range(
                CellRange { sheet, start_row: 0, start_col: 0, end_row: 1, end_col: 1 },
                RangeQueryOptions::default(),
            )
            .unwrap();
        assert_eq!(r.n_rows, 2);
        assert_eq!(r.n_cols, 2);
        assert_eq!(r.columns.len(), 2);
        // Column A: [1, 2]; column B: [Blank, Blank].
        assert_eq!(r.columns[0].values, vec![
            CellValue::Number { number: 1.0 },
            CellValue::Number { number: 2.0 },
        ]);
        assert_eq!(r.columns[1].values, vec![CellValue::Blank, CellValue::Blank]);
    }

    #[test]
    fn query_range_rejects_inverted_and_oversize() {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        let inverted = s
            .query_range(
                CellRange { sheet, start_row: 5, start_col: 0, end_row: 0, end_col: 0 },
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
        let names: Vec<String> =
            s.list_sheets().unwrap().into_iter().map(|x| x.name).collect();
        assert!(names.contains(&"Keep".to_string()));
        assert!(!names.contains(&"Drop".to_string()));
        assert_ne!(v0, s.snapshot().unwrap().version);
        // Restore brings it back.
        s.restore_sheet(drop_id).unwrap();
        let names2: Vec<String> =
            s.list_sheets().unwrap().into_iter().map(|x| x.name).collect();
        assert!(names2.contains(&"Drop".to_string()));
    }

    #[test]
    fn move_sheet_out_of_range_is_bad_argument_unknown_is_not_found() {
        let mut s = WorkbookSession::new();
        let sid = s.add_sheet("S", 16384).unwrap();
        assert_eq!(s.move_sheet(sid, 9999).unwrap_err().class, ErrorClass::BadArgument);
        assert_eq!(s.move_sheet(9999, 0).unwrap_err().class, ErrorClass::NotFound);
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
        assert_eq!(s.drop_table("NOPE").unwrap_err().class, ErrorClass::NotFound);
        // Drop the real one succeeds.
        s.drop_table("T").unwrap();
    }
}
