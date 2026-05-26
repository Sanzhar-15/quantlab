//! Binding-neutral, versioned DTOs (contract §4.2).
//!
//! These are the shapes that cross the contract boundary. They are extracted
//! from the proven napi `#[napi(object)]` structs (`ql-bindings-node`) but are
//! transport-neutral plain `serde` types — bindings map their wire form to/from
//! these. Where a stable engine type already exists (`ql_types::Address`,
//! `ql_types::Range`), a `From` conversion is provided rather than re-deriving.

use ql_types::{ColId, RowId, SheetId};
use serde::{Deserialize, Serialize};

/// Opaque session/version token (contract §4.0). In v1 this is the single-writer
/// op-log's encoded Loro `VersionVector`. Callers round-trip it verbatim and MUST
/// NOT interpret the bytes; the engine is the sole producer/validator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionVersion(pub Vec<u8>);

/// A sheet-qualified cell address (mirrors [`ql_types::Address`], serde-able).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CellAddr {
    /// Sheet id.
    pub sheet: SheetId,
    /// 0-indexed row.
    pub row: RowId,
    /// 0-indexed column.
    pub col: ColId,
}

impl From<ql_types::Address> for CellAddr {
    fn from(a: ql_types::Address) -> Self {
        Self {
            sheet: a.sheet,
            row: a.row,
            col: a.col,
        }
    }
}
impl From<CellAddr> for ql_types::Address {
    fn from(a: CellAddr) -> Self {
        ql_types::Address::new(a.sheet, a.row, a.col)
    }
}

/// A rectangular range within one sheet (mirrors [`ql_types::Range`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CellRange {
    /// Sheet id.
    pub sheet: SheetId,
    /// Inclusive top-left row.
    pub start_row: RowId,
    /// Inclusive top-left column.
    pub start_col: ColId,
    /// Inclusive bottom-right row.
    pub end_row: RowId,
    /// Inclusive bottom-right column.
    pub end_col: ColId,
}

impl From<ql_types::Range> for CellRange {
    fn from(r: ql_types::Range) -> Self {
        Self {
            sheet: r.sheet,
            start_row: r.start_row,
            start_col: r.start_col,
            end_row: r.end_row,
            end_col: r.end_col,
        }
    }
}
impl From<CellRange> for ql_types::Range {
    fn from(r: CellRange) -> Self {
        ql_types::Range::new(r.sheet, r.start_row, r.start_col, r.end_row, r.end_col)
    }
}

/// A cell value — a **discriminated union** on `kind` (contract §4.2). Bindings
/// narrow on `kind`; exactly one payload is present. Maps from
/// [`ql_types::Value`] (`Pending` is a binding-layer "being computed" state with
/// no `ql_types::Value` analog).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CellValue {
    /// Numeric value.
    Number {
        /// The number.
        number: f64,
    },
    /// Boolean value.
    Boolean {
        /// The boolean.
        boolean: bool,
    },
    /// Text value.
    Text {
        /// The string.
        text: String,
    },
    /// A spreadsheet error value (`#REF!`, `#DIV/0!`, …) — NOT an
    /// [`crate::EngineError`] (contract §5.5).
    Error {
        /// The rendered error code.
        error: String,
    },
    /// The cell is queued for recompute and has no committed value yet.
    Pending,
}

/// A format identifier — builtin index or session-custom (peer, counter).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FormatId {
    /// Builtin format index.
    Builtin {
        /// Index into the builtin format table.
        builtin: u32,
    },
    /// Session-custom format, keyed by the registering peer + counter.
    Custom {
        /// Registering peer id.
        peer: u64,
        /// Per-peer counter.
        counter: u32,
    },
}

/// A registered format definition (`{id, string}`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormatDef {
    /// The format id.
    pub id: FormatId,
    /// The format string (e.g. `"0.00%"`, `"yyyy-mm-dd"`).
    pub string: String,
}

/// One cell in a sheet snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellSnapshot {
    /// 0-indexed row.
    pub row: RowId,
    /// 0-indexed column.
    pub col: ColId,
    /// Committed value, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<CellValue>,
    /// Formula text, if the cell holds a formula.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    /// Cell format, if set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<FormatId>,
    /// Pre-rendered display string (format applied), if available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered: Option<String>,
}

/// A sheet's full cell set in a snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SheetSnapshot {
    /// Sheet id.
    pub id: SheetId,
    /// Sheet name.
    pub name: String,
    /// Cells, sorted (row, col) ascending.
    pub cells: Vec<CellSnapshot>,
}

/// Lightweight sheet descriptor (no cells) for `list_sheets`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetInfo {
    /// Sheet id.
    pub id: SheetId,
    /// Sheet name.
    pub name: String,
}

/// The workbook's date epoch system.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum DateSystem {
    /// Excel 1900 epoch (default).
    Excel1900,
    /// Excel 1904 epoch.
    Excel1904,
}

/// A full workbook snapshot (contract §3.6 / §4.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkbookSnapshot {
    /// DTO schema version (contract §4.1).
    pub schema_version: u16,
    /// All (non-tombstoned) sheets.
    pub sheets: Vec<SheetSnapshot>,
    /// Session-wide format table (builtin + custom).
    pub formats: Vec<FormatDef>,
    /// Workbook date epoch.
    pub date_system: DateSystem,
    /// Opaque version token (round-trip into `snapshot_delta`).
    pub version: SessionVersion,
}

/// A changed cell in a delta.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChangedCell {
    /// Sheet id.
    pub sheet: SheetId,
    /// The new cell state.
    pub cell: CellSnapshot,
}

/// A removed (cleared) cell in a delta.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemovedCell {
    /// Sheet id.
    pub sheet: SheetId,
    /// 0-indexed row.
    pub row: RowId,
    /// 0-indexed column.
    pub col: ColId,
}

/// Why an incremental delta could not be produced and the caller must reseed
/// via `snapshot()` (contract §4.3). A *malformed* token is NOT in this set — it
/// is the fail-loud [`crate::EngineError::invalid_version_token`] (No-Fallbacks).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FullRebuildReason {
    /// Empty token on the first call.
    NoPriorVersion,
    /// The delta cache was force-cleared (merge/undo).
    CacheCleared,
    /// The token is well-formed but older than the cache horizon.
    StaleHorizon,
    /// The token is from a different session/epoch (e.g. post-reload).
    EpochMismatch,
}

/// An incremental workbook delta (contract §3.6 / §4.2 / §4.3).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkbookSnapshotDelta {
    /// DTO schema version.
    pub schema_version: u16,
    /// Cells changed since the caller's `last_version`.
    pub changed_cells: Vec<ChangedCell>,
    /// Cells cleared since `last_version`.
    pub removed_cells: Vec<RemovedCell>,
    /// Sheets added/renamed/reordered since `last_version`.
    pub sheets_changed: Vec<SheetSnapshot>,
    /// Sheets tombstoned since `last_version`.
    pub sheets_removed: Vec<SheetId>,
    /// Formats registered since `last_version`.
    pub formats_added: Vec<FormatDef>,
    /// Current version token (store for the next call).
    pub version: SessionVersion,
    /// When true the caller MUST reseed via `snapshot()` (see `full_rebuild_reason`).
    pub full_rebuild_required: bool,
    /// The designed reason for a full rebuild (only set when
    /// `full_rebuild_required`; contract §4.3 / MED-2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_rebuild_reason: Option<FullRebuildReason>,
}

/// Options for `query_range` (which extras to include).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeQueryOptions {
    /// Include formula text per cell.
    pub include_formulas: bool,
    /// Include format ids per cell.
    pub include_formats: bool,
    /// Include pre-rendered display strings per cell.
    pub include_rendered: bool,
}

/// One column of a [`RangeResult`] (columnar layout).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RangeColumn {
    /// Column values, top-to-bottom. (Arrow-handle layout is a future option.)
    pub values: Vec<CellValue>,
}

/// A batch-shaped range read (contract §3.6 / §4.2 / MED-5). **Columnar**
/// (Arrow-friendly); one shape across all bindings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RangeResult {
    /// DTO schema version.
    pub schema_version: u16,
    /// The queried range.
    pub range: CellRange,
    /// Number of rows.
    pub n_rows: u32,
    /// Number of columns.
    pub n_cols: u32,
    /// Columnar values (length == `n_cols`; each column length == `n_rows`).
    pub columns: Vec<RangeColumn>,
}

/// Options for `batch` (contract §3.4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchOptions {
    /// Group the batch under a named undo unit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_label: Option<String>,
}

/// Result of a `batch`/transaction commit (contract §3.4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BatchResult {
    /// Number of ops applied.
    pub applied: u32,
    /// New version token after the batch.
    pub version: SessionVersion,
}

/// Result of `undo`/`redo` (contract §3.8). Empty stack ⇒ `consumed: false`
/// (NOT an error).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UndoRedoResult {
    /// Whether a step was consumed.
    pub consumed: bool,
    /// New version token (undo/redo clears the delta cache → next
    /// `snapshot_delta` full-rebuilds).
    pub version: SessionVersion,
}

/// Result of `write_range` (reserved, contract §3.5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WriteRangeResult {
    /// Cells written.
    pub written: u32,
    /// New version token.
    pub version: SessionVersion,
}

/// Reference to a published dataset / materialized query (reserved, §3.5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedRef {
    /// Stable id of the published artifact.
    pub id: String,
}

/// A bound overlay range (reserved, §3.5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundRange {
    /// Stable binding id.
    pub binding_id: String,
}

/// Result of a source refresh (reserved, §3.5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DirtyResult {
    /// Number of dependent cells dirtied.
    pub dirtied: u32,
    /// New version token.
    pub version: SessionVersion,
}

/// Severity of a [`Diagnostic`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Informational.
    Info,
    /// Warning.
    Warning,
    /// Error.
    Error,
}

/// A per-cell diagnostic (returned by `validate_formula` or via the event
/// stream; same DTO either way — contract §9).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    /// The cell the diagnostic applies to (None for workbook-level).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addr: Option<CellAddr>,
    /// Severity.
    pub severity: Severity,
    /// Stable diagnostic code.
    pub code: String,
    /// Human-readable message.
    pub message: String,
}
