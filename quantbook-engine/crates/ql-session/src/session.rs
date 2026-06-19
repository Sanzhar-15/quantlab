//! The `EngineSession` trait — the single product-session contract that backs
//! all bindings (contract §3; acceptance API6-01).
//!
//! This is the **type-level skeleton** (6.1B increment 1): method signatures
//! only. The owning `WorkbookSession` that implements it is a later increment.
//! Method docs cite the contract section each command derives from.

use ql_types::{RowId, SheetId};
use serde::{Deserialize, Serialize};

use crate::dto::{
    BatchOptions, BatchResult, BoundRange, CellAddr, CellRange, CellSnapshot, CellValue,
    Diagnostic, DirtyResult, FormatId, NamedRange, PublishedRef, RangeQueryOptions, RangeResult,
    SessionVersion, SheetInfo, Style, StyleId, TableSpec, UndoRedoResult, WorkbookSnapshot,
    WorkbookSnapshotDelta, WriteRangeResult,
};
use crate::error::EngineResult;
use crate::function_meta::FunctionMetadata;
use crate::operation::{LifecycleState, OperationId, OperationState, RecalcKind};

/// Opaque handle to a multi-call transaction (owns buffered DTOs, never a
/// borrowed runtime — contract §3.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TransactionId(pub u64);

/// Opaque reference to a binding-side function implementation (e.g. a Python
/// worker callable). 6.4 defines its execution semantics; the contract only
/// needs an opaque handle here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FunctionImplHandle(pub u64);

/// Monotonic event-stream cursor (contract §9). Opaque; round-tripped by callers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EventCursor(pub u64);

/// A buffered mutation for `batch` / a transaction (contract §3.4). Minimal v1
/// set; structure/table ops are added in later trait increments.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SessionOp {
    /// Set a literal value.
    SetValue {
        /// Target cell.
        addr: CellAddr,
        /// New value.
        value: CellValue,
    },
    /// Set a formula.
    SetFormula {
        /// Target cell.
        addr: CellAddr,
        /// Formula text.
        text: String,
    },
    /// Clear a cell.
    Clear {
        /// Target cell.
        addr: CellAddr,
    },
    /// Set a cell format.
    SetFormat {
        /// Target cell.
        addr: CellAddr,
        /// Format id.
        format: FormatId,
    },
    /// **FE-4 W4 (2026-06-10):** set a cell visual STYLE id (the
    /// visual-formatting analog of [`Self::SetFormat`]).
    SetStyle {
        /// Target cell.
        addr: CellAddr,
        /// Style id (from [`EngineSession::register_style`]).
        style: StyleId,
    },
}

/// A structured event drained from the session's event ring (contract §9).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// Recalc progress.
    RecalcProgress {
        /// The recalc operation.
        op: OperationId,
        /// Nodes done so far.
        done: u64,
        /// Total nodes.
        total: u64,
    },
    /// A per-cell diagnostic produced (e.g. post-recalc).
    CellDiagnostic {
        /// The diagnostic.
        diagnostic: Diagnostic,
    },
    /// An operation reached a terminal state. Never precedes that op's own
    /// events (ordering rule, contract §9).
    OperationCompleted {
        /// The operation.
        op: OperationId,
        /// Its terminal state.
        state: OperationState,
    },
    /// Provenance for a cell (shaped now for UDF/SQL/AI; contract §9).
    Provenance {
        /// The cell.
        addr: CellAddr,
        /// Source descriptor (dataset id, query id, connector revision, …).
        source: String,
    },
    /// A structural change (sheet/table/name) occurred.
    StructureChanged {
        /// What kind of structure (e.g. `"sheet"`, `"table"`, `"name"`).
        kind: String,
        /// The affected target id/name.
        target: String,
    },
    /// The consumer fell behind the retention horizon and dropped events; it
    /// MUST reseed via `snapshot()` (contract §9 — not a silent loss).
    FullResyncRequired,
}

/// A page of events read from a cursor (contract §9). Reading does not drain the
/// ring, so pull pollers and push subscribers never starve each other.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventPage {
    /// Events at/after the requested cursor (in ring order).
    pub events: Vec<Event>,
    /// Cursor to pass on the next call.
    pub next_cursor: EventCursor,
    /// True if events were dropped before this page (consumer fell behind);
    /// pairs with an [`Event::FullResyncRequired`].
    pub dropped: bool,
}

/// The single product-session contract (contract §3). All fallible operations
/// return [`EngineResult`]; nothing panics across the boundary (§8). Long ops
/// return an [`OperationId`] and put the session [`LifecycleState::Busy`] (§6).
///
/// The collaborative layer (transport/CRDT-merge/presence) is NOT here — it is
/// the v1.5 layer on top of the same op-log (contract §3.10).
pub trait EngineSession {
    // --- Lifecycle / persistence (§3.1) ---

    /// Current lifecycle state (§2.3).
    fn lifecycle_state(&self) -> LifecycleState;
    /// Open a workbook from a `.qbook` path (New → Ready).
    fn open(&mut self, path: &str) -> EngineResult<()>;
    /// Import a workbook from bytes in `format` (e.g. `"xlsx"`, `"csv"`).
    fn import(&mut self, bytes: &[u8], format: &str) -> EngineResult<()>;
    /// Save to a `.qbook` path.
    fn save(&self, path: &str) -> EngineResult<()>;
    /// Export to bytes in `format`.
    fn export(&self, format: &str) -> EngineResult<Vec<u8>>;
    /// Close the session (→ Closed). Idempotent.
    fn close(&mut self) -> EngineResult<()>;

    // --- Mutation — single edits (§3.2) ---

    /// Set a literal value (clears any formula).
    fn set_value(&mut self, addr: CellAddr, value: CellValue) -> EngineResult<()>;
    /// Set a formula (lex+parse+bind+eval). Parse/bind failure → `Compute`
    /// error or `Diagnostic`, never silently dropped (§5.5).
    fn set_formula(&mut self, addr: CellAddr, text: &str) -> EngineResult<()>;
    /// Clear a cell's formula — **convert-to-literal**: removes the formula
    /// association but PRESERVES the last computed value (Excel "convert to
    /// value"; matches `clear_formula` / the inc.2c-6 contract).
    ///
    /// To delete cell contents entirely (value + any formula in one atomic op),
    /// call [`Self::set_value`] with [`CellValue::Blank`] — the runtime emits
    /// `ClearValue + ClearFormula` together when a formula was present,
    /// otherwise just the value clear, closing the seed input #5
    /// "delete-contents" question without a separate `delete_cell` command
    /// (6.1C audit-fix L1; verified at `crates/ql-exec/src/workbook_runtime/cells.rs`
    /// `set_value` Blank arm).
    fn clear(&mut self, addr: CellAddr) -> EngineResult<()>;
    /// Set a cell format.
    fn set_format(&mut self, addr: CellAddr, format: FormatId) -> EngineResult<()>;
    /// Register a session-wide custom format, returning its id.
    fn register_format(&mut self, format_string: &str) -> EngineResult<FormatId>;
    /// **FE-4 W4 (2026-06-10):** set a cell's visual style to a registered
    /// [`StyleId`] (from [`Self::register_style`]). `bad_argument` for an
    /// unknown id. The visual-formatting analog of [`Self::set_format`].
    fn set_style(&mut self, addr: CellAddr, style: StyleId) -> EngineResult<()>;
    /// **FE-4 W4 (2026-06-10):** register a session-wide cell style, returning
    /// its [`StyleId`] (the visual-formatting analog of
    /// [`Self::register_format`]). Idempotent — re-registering an identical
    /// style returns the same id.
    fn register_style(&mut self, style: Style) -> EngineResult<StyleId>;
    /// **R9 / Wave B (2026-06-17):** increase (`delta > 0`) / decrease
    /// (`delta < 0`) the decimal places of a cell's number format — Excel's
    /// Increase/Decrease Decimal gesture. Reads the cell's current format
    /// (unbound / `General` ⇒ the integer base `"0"`), nudges the format-code
    /// string, and rebinds the cell if the result differs. A no-op (clamp
    /// boundary, a non-numeric/date format, or `delta == 0`) leaves the cell
    /// untouched. Effectively a `register_format` + `set_format` pair scoped to
    /// decimal places; a malformed format surfaces a loud error (No-Fallbacks).
    fn nudge_cell_decimals(&mut self, addr: CellAddr, delta: i32) -> EngineResult<()>;
    /// **R9 / Wave C (2026-06-18):** the READ-ONLY half of [`Self::nudge_cell_decimals`] — compute the
    /// number-format STRING the cell would carry after a decimal nudge, WITHOUT interning a format or
    /// rebinding the cell (so it never touches the undo history). Returns the nudged format string, or
    /// `None` for a no-op (`delta == 0`, the clamp boundary, or the cell already carries the nudged
    /// format). The host registers the returned string(s) and applies them over a selection in one
    /// `batch`, giving a multi-cell decimal nudge a SINGLE undo unit. A format the engine cannot model
    /// (`[Red]`/conditional/elapsed-time) surfaces a loud error (No-Fallbacks).
    fn nudge_decimals_preview(&self, addr: CellAddr, delta: i32) -> EngineResult<Option<String>>;
    /// **Wave G2 (engine-filter):** hide (`hidden = true`) or show
    /// (`hidden = false`) a set of ROWS on `sheet`. A hidden row is excluded by
    /// the `SUBTOTAL(101..=111)` "ignore hidden rows" variants, and dependents
    /// recompute. Idempotent per row — only state-changing rows are recorded and
    /// undoable, so hiding an already-hidden row is a no-op. Driven by the IDE
    /// row-gutter hide action and the future autofilter. A row past `MAX_ROW`
    /// surfaces a loud error (No-Fallbacks); the whole call is atomic.
    fn set_rows_hidden(&mut self, sheet: SheetId, rows: &[RowId], hidden: bool)
        -> EngineResult<()>;
    /// **Wave G2:** the sorted set of currently-hidden rows on `sheet` (the
    /// READ half of [`Self::set_rows_hidden`]). The renderer pulls this on a
    /// sheet switch / after a hide to collapse hidden rows.
    fn hidden_rows(&self, sheet: SheetId) -> EngineResult<Vec<RowId>>;
    /// Parse+bind a formula WITHOUT mutating (keystroke path); returns diagnostics.
    fn validate_formula(&self, addr: CellAddr, text: &str) -> EngineResult<Vec<Diagnostic>>;

    // --- Mutation — structure (§3.3; fail-loud single-writer semantics) ---

    /// Add a sheet, returning its id. Duplicate name → `Conflict`.
    fn add_sheet(&mut self, name: &str, chunk_rows: u32) -> EngineResult<SheetId>;
    /// Rename a sheet. Unknown id → `NotFound`; duplicate name → `Conflict`.
    fn rename_sheet(&mut self, id: SheetId, name: &str) -> EngineResult<()>;
    /// Tombstone a sheet (preserves cells for restore). Unknown id → `NotFound`
    /// (NOT the silent storage no-op).
    fn delete_sheet(&mut self, id: SheetId) -> EngineResult<()>;
    /// Restore a tombstoned sheet. Unknown/not-tombstoned → `NotFound`/`Conflict`.
    fn restore_sheet(&mut self, id: SheetId) -> EngineResult<()>;
    /// Reorder a sheet. Unknown id → `NotFound`; out-of-range index →
    /// `BadArgument` (NOT the silent storage clamp).
    fn move_sheet(&mut self, id: SheetId, index: u32) -> EngineResult<()>;
    /// Define a name bound to a range.
    fn set_name(&mut self, name: &str, target: CellRange) -> EngineResult<()>;
    /// **FE-5 W-N (2026-06-12):** remove a defined name. `scope: None` targets
    /// the workbook-scoped table; `scope: Some(id)` a sheet-scoped table.
    /// A name that isn't registered in the target scope → `NotFound`
    /// (`name_not_found`) — NOT a silent no-op (No-Fallbacks). This emits a
    /// compensating `Op::RemoveName` so an undo/redo re-materialization does
    /// not resurrect the deleted name.
    fn delete_name(&mut self, name: &str, scope: Option<SheetId>) -> EngineResult<()>;

    // Table ops — v1 single-writer (contract §3.3). Name-keyed (canonical
    // uppercase), matching `WorkbookRuntime` tables. Collaborative table-merge
    // is deferred (Phase 5 EC#2): a future collaborative table producer MUST
    // land conflict-resolution + `removed_cells` before these merge across peers.

    /// Create a table from `spec`. Duplicate name → `Conflict`; unknown anchor
    /// sheet → `NotFound`; zero rows/cols → `BadArgument`.
    fn create_table(&mut self, spec: TableSpec) -> EngineResult<()>;
    /// Rename a table. Unknown `old_name` → `NotFound`; `new_name` collision →
    /// `Conflict`.
    fn rename_table(&mut self, old_name: &str, new_name: &str) -> EngineResult<()>;
    /// Rename a column within a table. Unknown table/column → `NotFound`;
    /// `new_col` collision → `Conflict`.
    fn rename_column(&mut self, table: &str, old_col: &str, new_col: &str) -> EngineResult<()>;
    /// Resize a table (add/remove rows/columns). Unknown table → `NotFound`;
    /// invalid dims → `BadArgument`.
    fn resize_table(
        &mut self,
        name: &str,
        new_rows: u32,
        new_cols: u32,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    ) -> EngineResult<()>;
    /// Drop a table. Unknown name → `NotFound`.
    fn drop_table(&mut self, name: &str) -> EngineResult<()>;

    // --- Batch / transaction (§3.4; transport-neutral) ---

    /// Apply a batch atomically (one undo unit). All-or-nothing at the
    /// validation+local-commit layer; replay-from-persisted-logs is fail-loud
    /// but NOT rollback-atomic (contract §3.4).
    fn batch(&mut self, ops: Vec<SessionOp>, options: BatchOptions) -> EngineResult<BatchResult>;
    /// Begin a multi-call transaction (opaque handle owning buffered ops).
    fn begin_transaction(&mut self) -> EngineResult<TransactionId>;
    /// Buffer an op into an open transaction.
    fn txn_add(&mut self, txn: TransactionId, op: SessionOp) -> EngineResult<()>;
    /// Commit an open transaction.
    fn commit_transaction(&mut self, txn: TransactionId) -> EngineResult<BatchResult>;
    /// Discard an open transaction.
    fn rollback_transaction(&mut self, txn: TransactionId) -> EngineResult<()>;

    // --- Recalculation (§3.7; cancellation scoped per §6) ---

    /// Recompute the dirty set (incremental). Returns an op id; in v1, cancel is
    /// honored only pre-start (§6.4). One-shot convenience = [`start_recalc`] +
    /// [`await_recalc`] under one call (no cancel window).
    ///
    /// [`start_recalc`]: EngineSession::start_recalc
    /// [`await_recalc`]: EngineSession::await_recalc
    fn recalc_dirty(&mut self) -> EngineResult<OperationId>;
    /// Recompute everything. Returns an op id; pre-start cancel only in v1.
    fn recalc_all(&mut self) -> EngineResult<OperationId>;
    /// **M2 — reserve a recalc and return its op id WITHOUT running it** (the §6.4
    /// "start → wait/cancel" shape). The session becomes `Busy`; the caller releases
    /// the binding lock, so a [`cancel`](EngineSession::cancel) can land in the
    /// resulting **pre-start window** before [`await_recalc`](EngineSession::await_recalc)
    /// runs the synchronous recompute. A second `start_recalc` while one is pending is
    /// rejected (`Busy`). The caller MUST follow with `await_recalc` (even after a
    /// `cancel`) to drain back to `Ready`.
    fn start_recalc(&mut self, kind: RecalcKind) -> EngineResult<OperationId>;
    /// **M2 — run (or skip) the recalc reserved by [`start_recalc`](EngineSession::start_recalc).**
    /// If a `cancel(op)` won the pre-start window, the recompute is SKIPPED (no commit,
    /// no state change) and the op surfaces `Canceled` (§6.4 pre-start cancel — the
    /// synchronous core cannot mid-flight abort, §6.3); otherwise it runs to
    /// `Completed`/`Failed`. Fail-loud (`bad_argument`) if `op` is not the in-flight
    /// recalc.
    fn await_recalc(&mut self, op: OperationId) -> EngineResult<()>;
    /// Mark all volatile functions dirty.
    fn mark_volatiles_dirty(&mut self) -> EngineResult<()>;

    // --- Query / snapshot (§3.6) ---

    /// Batch-shaped range read (columnar).
    fn query_range(
        &self,
        range: CellRange,
        options: RangeQueryOptions,
    ) -> EngineResult<RangeResult>;
    /// Full workbook snapshot (carries the opaque version token, §4.0).
    fn snapshot(&self) -> EngineResult<WorkbookSnapshot>;
    /// Incremental delta from a prior version token (§4.3 full-rebuild rules;
    /// a malformed token is the fail-loud `invalid_version_token` error).
    fn snapshot_delta(&self, last_version: &SessionVersion) -> EngineResult<WorkbookSnapshotDelta>;
    /// Single-cell lookup.
    fn cell(&self, addr: CellAddr) -> EngineResult<Option<CellSnapshot>>;
    /// List (non-tombstoned) sheets.
    fn list_sheets(&self) -> EngineResult<Vec<SheetInfo>>;
    /// **FE-5 W-N (2026-06-12):** list every defined name in the workbook —
    /// BOTH workbook-scoped (`scope: None`) AND every sheet's sheet-scoped
    /// names (`scope: Some(id)`). Sorted (workbook-scoped first, then by sheet
    /// id, then by name) for a stable order. The same data is carried in
    /// [`WorkbookSnapshot::names`]; this is the lightweight read for the
    /// Name-Manager UI without a full cell snapshot.
    fn list_names(&self) -> EngineResult<Vec<NamedRange>>;
    /// **FE-8.3 (2026-06-15):** list a table's column display names, in order.
    /// The column names live in the engine's `TableMetadata` but are omitted from
    /// [`WorkbookSnapshot::tables`]; this is the lightweight read backing FE-8.1's
    /// column-shrink (the IDE needs the trailing names for `resize_table`'s
    /// `removed_columns`) and the rename-column picker. The `table` name is matched
    /// case-insensitively (canonicalized like every other table op); an unknown
    /// table is the same `table_not_found` (NotFound) that drop/rename raise.
    fn table_columns(&self, table: &str) -> EngineResult<Vec<String>>;

    // --- Undo / redo (§3.8) ---

    /// Undo one step. Empty stack → `consumed:false` (not an error); clears the
    /// delta cache.
    fn undo(&mut self) -> EngineResult<UndoRedoResult>;
    /// Redo one step.
    fn redo(&mut self) -> EngineResult<UndoRedoResult>;
    /// Whether an undo step is available.
    fn can_undo(&self) -> bool;
    /// Whether a redo step is available.
    fn can_redo(&self) -> bool;

    // --- Functions (§3.9; impl in 6.4) ---

    /// Register a custom function. Collision with a built-in/UDF → `Conflict`
    /// (NOT a panic); dirties formulas referencing the (previously-unknown)
    /// name (contract §10.3).
    fn register_function(
        &mut self,
        metadata: FunctionMetadata,
        impl_handle: FunctionImplHandle,
    ) -> EngineResult<()>;
    /// Unregister a custom function (dirties referencing formulas).
    fn unregister_function(&mut self, canonical_name: &str) -> EngineResult<()>;
    /// List all functions (built-ins + UDFs) with metadata.
    fn list_functions(&self) -> EngineResult<Vec<FunctionMetadata>>;

    // --- Operations / events (§6 / §9) ---

    /// Cancel an operation (cooperative; for in-engine recalc, pre-start only in
    /// v1). Returns whether a cancel was registered.
    fn cancel(&mut self, op: OperationId) -> EngineResult<bool>;
    /// Query an operation's state.
    fn operation_status(&self, op: OperationId) -> EngineResult<OperationState>;
    /// Read a page of events from `cursor` (does not drain the ring).
    fn poll_events(&mut self, cursor: EventCursor) -> EngineResult<EventPage>;

    // --- Reserved bulk data / publish / bind (§3.5; impl 6.4/6.5) ---

    /// Bulk-write a rectangular value matrix; dirties dependents of `range`.
    fn write_range(
        &mut self,
        range: CellRange,
        values: Vec<Vec<CellValue>>,
    ) -> EngineResult<WriteRangeResult>;
    /// Publish a dataset into a target (reserved; `qb.publish()`). `data` is an
    /// opaque payload the 6.4 layer interprets (Arrow batch, etc.).
    fn publish_dataset(
        &mut self,
        name: &str,
        data: serde_json::Value,
        target: CellRange,
    ) -> EngineResult<PublishedRef>;
    /// Bind an overlay (reserved; `qb.bind()`).
    fn bind_range(&mut self, binding_id: &str, target: CellRange) -> EngineResult<BoundRange>;
    /// Refresh an external source by revision; dirties dependents (reserved).
    fn refresh_source(&mut self, source_id: &str, revision: u64) -> EngineResult<DirtyResult>;
    /// Materialize a query result into a target (reserved; SQL).
    fn materialize_query(
        &mut self,
        query_id: &str,
        target: CellRange,
        data: serde_json::Value,
    ) -> EngineResult<PublishedRef>;
}
