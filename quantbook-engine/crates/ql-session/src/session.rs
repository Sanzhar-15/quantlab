//! The `EngineSession` trait — the single product-session contract that backs
//! all bindings (contract §3; acceptance API6-01).
//!
//! This is the **type-level skeleton** (6.1B increment 1): method signatures
//! only. The owning `WorkbookSession` that implements it is a later increment.
//! Method docs cite the contract section each command derives from.

use ql_types::SheetId;
use serde::{Deserialize, Serialize};

use crate::dto::{
    BatchOptions, BatchResult, BoundRange, CellAddr, CellRange, CellSnapshot, CellValue,
    Diagnostic, DirtyResult, FormatId, PublishedRef, RangeQueryOptions, RangeResult,
    SessionVersion, SheetInfo, UndoRedoResult, WorkbookSnapshot, WorkbookSnapshotDelta,
    WriteRangeResult,
};
use crate::error::EngineResult;
use crate::function_meta::FunctionMetadata;
use crate::operation::{LifecycleState, OperationId, OperationState};

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
    /// Clear a cell.
    fn clear(&mut self, addr: CellAddr) -> EngineResult<()>;
    /// Set a cell format.
    fn set_format(&mut self, addr: CellAddr, format: FormatId) -> EngineResult<()>;
    /// Register a session-wide custom format, returning its id.
    fn register_format(&mut self, format_string: &str) -> EngineResult<FormatId>;
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
    // NOTE: table ops (create/rename/rename_column/resize/drop) are v1
    // single-writer but elided from this skeleton increment; added with their
    // DTOs in a later trait increment.

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
    /// honored only pre-start (§6.4).
    fn recalc_dirty(&mut self) -> EngineResult<OperationId>;
    /// Recompute everything. Returns an op id; pre-start cancel only in v1.
    fn recalc_all(&mut self) -> EngineResult<OperationId>;
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
