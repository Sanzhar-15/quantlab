//! Binding-neutral, versioned DTOs (contract §4.2).
//!
//! These are the shapes that cross the contract boundary. They are extracted
//! from the proven napi `#[napi(object)]` structs (`ql-bindings-node`) but are
//! transport-neutral plain `serde` types — bindings map their wire form to/from
//! these. Where a stable engine type already exists (`ql_types::Address`,
//! `ql_types::Range`), a `From` conversion is provided rather than re-deriving.

use ql_types::{ColId, RowId, SheetId};
use serde::{Deserialize, Serialize};

/// Opaque session/version token (contract §4.0). In v1 this is an engine-owned
/// `{session_epoch, op_count}` encoded as bytes. `op_count` is `OpLog::len()`
/// (the simplest monotonic single-writer counter); `session_epoch` is minted at
/// new/open/import and re-minted on cache-clear/undo — which is what keeps
/// tokens sound, because `OpLog::len()` is NOT monotonic under undo-retraction
/// (it reads the live Loro list). (`ql-oplog::OpLog` *does* expose a Loro
/// `VersionVector` via `oplog_vv()` — an earlier doc claim that it had none was
/// wrong — but that VV is reserved for the v1.5 `CollabSession` delta-sync path,
/// not the single-writer token; `{epoch, op_count}` is chosen deliberately
/// because index-walking ops for a semantic delta is simpler than decoding a VV
/// delta blob.) Callers round-trip the bytes verbatim and MUST NOT interpret
/// them; the engine is the sole producer/validator.
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

/// **FE-5 W-N (2026-06-12):** the target a defined name is bound to — a
/// **discriminated union** on `kind` (contract §4.2), mirroring the four
/// `ql_storage::NamedTarget` variants. A loaded `.qbook` can carry any of the
/// four even though the IDE's `setName` only ever creates `Range` today; all
/// four MUST round-trip faithfully (No-Fallbacks: a `Constant`/`Formula` must
/// NOT be silently coerced down to a `Range`).
///
/// `Constant` reuses [`CellValue`] (which can represent every `ql_types::Value`
/// case, including `Blank`), so the projection from `NamedTarget` is total — no
/// lossy variant exists at this boundary. The engine-side projection
/// (`ql-exec`) is where any future unrepresentable case would fail loud.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NamedTargetDto {
    /// A single-cell anchor (`MyRef = $A$1`).
    Cell {
        /// The anchored cell.
        cell: CellAddr,
    },
    /// A rectangular range (`Sales = $A$2:$A$1000`).
    Range {
        /// The bound range.
        range: CellRange,
    },
    /// A constant value (`TaxRate = 0.21`).
    Constant {
        /// The bound value.
        value: CellValue,
    },
    /// A raw formula source, without the leading `=` (`Profit = Revenue - Costs`).
    Formula {
        /// The formula source text.
        source: String,
    },
}

/// **FE-5 W-N (2026-06-12):** one defined name in the workbook — its canonical
/// (upper-case) name, its [`NamedTargetDto`], and its scope. `scope: None` is a
/// workbook-scoped name; `scope: Some(sheet_id)` is a sheet-scoped name (which
/// shadows a workbook-scoped name with the same identifier on that sheet, per
/// Excel canon). Surfaced in [`WorkbookSnapshot::names`] and from the session's
/// `list_names` read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NamedRange {
    /// Canonical (upper-case) defined name.
    pub name: String,
    /// What the name resolves to.
    pub target: NamedTargetDto,
    /// `None` = workbook scope; `Some(id)` = sheet-scoped on that sheet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<SheetId>,
}

/// A cell value — a **discriminated union** on `kind` (contract §4.2). Bindings
/// narrow on `kind`; exactly one payload is present. Maps from
/// [`ql_types::Value`]: `Number`/`Boolean`/`Text`/`Error`/`Blank` correspond 1:1;
/// `Pending` is the extra binding-layer "being computed" state with no
/// `ql_types::Value` analog.
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
    /// An empty cell — no committed value (maps from [`ql_types::Value::Blank`]).
    /// Added in 6.1B inc.2c so a columnar `query_range` read can represent
    /// empties in a fixed-size `Vec<CellValue>` (a deliberate, backward-compatible
    /// contract addition; see `docs/api/workbook-session-impl-plan.md` §0). As a
    /// `set_value` input it means "clear the cell's value". Snapshots omit blank
    /// cells entirely (`CellSnapshot.value: None`) rather than emitting `Blank`.
    Blank,
    /// The cell is queued for recompute and has no committed value yet.
    Pending,
}

/// A format identifier — builtin index or session-custom (peer, counter).
///
/// `Ord`/`PartialOrd` are derived so consumers (and the in-engine
/// `WorkbookSession::snapshot` / `snapshot_delta` deterministic-ordering pass
/// added by the 6.1C audit-fix H2) can sort `formats` / `formats_added`
/// stably. Variant order (`Builtin` < `Custom`) + tuple-of-fields order
/// matches the storage-side `ql_storage::FormatId`'s derive, so the wire-
/// observable ordering is identical regardless of which side does the sort.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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

/// **FE-4 W4 (2026-06-10):** a cell-STYLE id — a peer-allocated
/// `(peer, counter)` tuple (the visual-formatting analog of [`FormatId`];
/// NO `Builtin` variant, because styles have no Excel-canonical registry).
/// `Ord` derived for stable snapshot ordering, matching `FormatId`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct StyleId {
    /// Registering peer id.
    pub peer: u64,
    /// Per-peer counter.
    pub counter: u32,
}

/// **FE-4 W4:** a 24-bit RGB color (no alpha; cell fills + border colors).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Rgb {
    /// Red channel.
    pub r: u8,
    /// Green channel.
    pub g: u8,
    /// Blue channel.
    pub b: u8,
}

/// **FE-4 W4:** horizontal alignment of a cell's content.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HAlign {
    /// Excel default — value-type-driven (numbers right, text left).
    #[default]
    General,
    /// Force left alignment.
    Left,
    /// Force center alignment.
    Center,
    /// Force right alignment.
    Right,
}

/// **FE-4 W4:** the stroke style of a single cell-border edge.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BorderStyle {
    /// No border drawn on this edge (the default).
    #[default]
    None,
    /// Thin solid line.
    Thin,
    /// Medium solid line.
    Medium,
    /// Thick solid line.
    Thick,
    /// Dashed line.
    Dashed,
    /// Dotted line.
    Dotted,
    /// Double line.
    Double,
}

/// **FE-4 W4:** a single border edge — stroke style + color.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct BorderEdge {
    /// The stroke style. `None` ⇒ no border drawn on this edge.
    pub style: BorderStyle,
    /// The stroke color. Ignored when `style == BorderStyle::None`.
    pub color: Rgb,
}

/// **FE-4 W4:** the four per-edge borders of a cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Borders {
    /// Top edge.
    pub top: BorderEdge,
    /// Bottom edge.
    pub bottom: BorderEdge,
    /// Left edge.
    pub left: BorderEdge,
    /// Right edge.
    pub right: BorderEdge,
}

/// **FE-4 W4 (2026-06-10):** a cell's VISUAL style — bold/italic/fill/align
/// plus per-edge borders (operator decision #4 schema). The DTO mirror of
/// `ql_storage::Style`; carried inline in [`StyleDef`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Style {
    /// Bold font weight.
    pub bold: bool,
    /// Italic font slant.
    pub italic: bool,
    /// Background fill color; `None` = no fill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<Rgb>,
    /// Horizontal alignment.
    #[serde(default)]
    pub align: HAlign,
    /// Per-edge borders.
    #[serde(default)]
    pub borders: Borders,
}

/// **FE-4 W4 (2026-06-10):** a registered style definition (`{id, style}`) —
/// the workbook-snapshot `styles` table entry resolving a [`StyleId`] to its
/// [`Style`] value (the visual-formatting analog of [`FormatDef`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StyleDef {
    /// The style id.
    pub id: StyleId,
    /// The style value.
    pub style: Style,
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
    /// **FE-4 W4 (2026-06-10):** cell visual-style id, if set. `None` = no
    /// explicit style (renders unstyled). Resolved against
    /// [`WorkbookSnapshot::styles`] / [`WorkbookSnapshotDelta::styles_added`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<StyleId>,
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

/// Specification for `create_table` (contract §3.3). Tables are **name-keyed**
/// (canonical uppercase), anchored at a sheet cell, matching
/// `WorkbookRuntime::create_table`. Single-writer v1 — collaborative table-merge
/// is deferred (Phase 5 EC#2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableSpec {
    /// Table name (canonicalized uppercase by the engine).
    pub name: String,
    /// Anchor sheet.
    pub sheet: SheetId,
    /// Anchor top-left row.
    pub top_row: RowId,
    /// Anchor top-left column.
    pub top_col: ColId,
    /// Row count (incl. header/totals if present); must be > 0.
    pub rows: u32,
    /// Column count; must be > 0.
    pub cols: u32,
    /// Whether the first row is a header.
    pub has_header: bool,
    /// Whether the last row is a totals row.
    pub has_totals: bool,
    /// Column display names (length should match `cols`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub column_names: Vec<String>,
}

/// **FE-5 W-? (Builder E, 2026-06-13):** one structured table's metadata, surfaced
/// in [`WorkbookSnapshot::tables`] so the IDE can render table chrome (banded rows,
/// header/totals styling, the table-name badge).
///
/// This is a READ/OUTPUT DTO — distinct from the create-input [`TableSpec`]. They are
/// deliberately NOT the same struct:
/// - [`TableSpec`] is the `create_table` INPUT (no `display_name` — the engine
///   derives the case-preserving display form at create time; carries
///   `column_names` for the create roster).
/// - `TableSnapshot` is the snapshot OUTPUT — it carries the engine-resolved
///   `display_name` (case-preserving) AND the canonical `name`, and it omits the
///   create-only `column_names`. Mirrors the `NamedRange`(output)-vs-create-input
///   split already in this module.
///
/// **Coordinate model** (mirrors [`ql_storage::TableMetadata`]): `top_row`/`top_col`
/// is the top-left cell; `rows × cols` is the FULL footprint INCLUDING the header
/// row (when `has_header`) and totals row (when `has_totals`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableSnapshot {
    /// Canonical (uppercase) table name.
    pub name: String,
    /// Display name (case-preserving). Equals `name` when no case-preserving form
    /// was supplied at create time.
    pub display_name: String,
    /// Anchor sheet — the IDE renderer needs this to know which sheet to draw the
    /// table chrome on (dropping it would be silent data loss).
    pub sheet: SheetId,
    /// Top-left row of the full footprint.
    pub top_row: RowId,
    /// Top-left column of the full footprint.
    pub top_col: ColId,
    /// Total rows (incl. header/totals if present).
    pub rows: u32,
    /// Total columns.
    pub cols: u32,
    /// `true` iff `top_row` is a header row.
    pub has_header: bool,
    /// `true` iff `top_row + rows - 1` is a totals row.
    pub has_totals: bool,
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
    /// **FE-4 W4 (2026-06-10):** session-wide cell-style table. Resolves each
    /// cell's [`CellSnapshot::style`] id to its [`Style`] value (the
    /// visual-formatting analog of [`Self::formats`]). Empty when no styles
    /// are registered.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<StyleDef>,
    /// Workbook date epoch.
    pub date_system: DateSystem,
    /// **FE-5 W-N (2026-06-12):** all defined names in the workbook — BOTH
    /// workbook-scoped (`scope: None`) AND every sheet's sheet-scoped names
    /// (`scope: Some(id)`). Sorted (workbook-scoped first, then by sheet id,
    /// then by name) for a stable wire shape. Empty when none are defined.
    /// The Name-Manager UI is refreshed via a full `snapshot()` (defined-name
    /// changes are delta-invisible — see `snapshot_delta`).
    ///
    /// **Additive field** (schema bumped 1 → 2). `serde(default)` keeps any
    /// pre-bump serialized snapshot deserializing (the field reads as empty).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<NamedRange>,
    /// **FE-5 W-? (Builder E, 2026-06-13):** every structured table in the workbook
    /// (across ALL sheets), so the IDE can render table chrome. Enumerated from the
    /// workbook's name-keyed table table; sorted (by sheet id, then canonical name)
    /// for a stable wire shape. Empty when no tables are defined.
    ///
    /// **Additive field** (schema bumped 2 → 3). `serde(default)` keeps any
    /// pre-bump serialized snapshot deserializing (the field reads as empty).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<TableSnapshot>,
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
    /// **FE-4 W4 (2026-06-10):** styles registered since `last_version` (the
    /// visual-formatting analog of [`Self::formats_added`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub styles_added: Vec<StyleDef>,
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
