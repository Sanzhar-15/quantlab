//! `.qbook/` workbook directory format.
//!
//! Per spec Part V §3 + T2-D01 (Round 7 architectural lock). The on-disk shape:
//!
//! ```text
//! my-workbook.qbook/
//! ├── workbook.toml          # envelope: schema_version, name, sheet list, names
//! └── sheets/
//!     ├── 0.jsonl            # sheet 0 cells, one JSON line per non-blank cell
//!     ├── 1.jsonl
//!     └── ...
//! ```
//!
//! - **TOML envelope** (`workbook.toml`): human-readable metadata, sheet manifest,
//!   defined-names table (since v2). Users can edit it by hand if needed.
//! - **JSONL per sheet**: one cell per line, append-friendly, line-oriented (clean
//!   diffs in tools that don't know about the format). Blank cells without formulas
//!   are NOT emitted — the file is a sparse representation.
//! - **Per-sheet partitioning**: opening one sheet doesn't require parsing all
//!   others. Scales to multi-million-cell workbooks at the partition boundary.
//!
//! ## Schema versions
//!
//! - **v1** (Phase 1 W5-6 + W5-9): envelope { schema_version, name, sheets },
//!   CellRecord { row, col, value, formula? }. CellWireValue ∈ {Number, Boolean,
//!   Text, Error}.
//! - **v2** (Phase 2A.8, this revision; megaudit closure for H2/M8-M12):
//!     - Envelope gains `names: Option<NamesSection>` for `NameTable` persistence
//!       (closes M12). v1 files load as `names: None`.
//!     - `CellWireValue::Pending` variant for formula-bearing cells whose saved
//!       value would be `Value::Blank` (closes M11 — was previously encoded as
//!       `Error(#NULL!)` which conflated a real spreadsheet error with a
//!       not-yet-evaluated formula).
//!     - `#[serde(deny_unknown_fields)]` on every envelope / record / wire-value
//!       struct (closes M9 — previously unknown fields silently dropped on read).
//!
//! ## Compatibility policy
//!
//! - **v1 → v2 load**: ACCEPTED. The v2 reader treats a v1 envelope as
//!   `names: None` and converts legacy `Error(#NULL!)` placeholders into Pending
//!   when the cell carries a formula. Existing v1 fixtures continue to load.
//! - **v2 → v1 load**: REJECTED via the existing `UnsupportedSchema` path. No
//!   silent forward-compat per the no-fallbacks rule.
//! - **Within a version**: `deny_unknown_fields` rejects extra fields loudly.
//!   Any future additive change requires an explicit version bump.
//!
//! ## Atomic save (Phase 2A.8 megaudit H2 closure)
//!
//! Save protocol uses a backup-rename sequence so a crash at any moment leaves
//! either the prior workbook or the new one intact at `path` (or recoverable
//! from a `.bak-<random>` sibling):
//!
//! ```text
//! 1. write_workbook_to_dir(wb, name, &temp)     // temp = <path>.tmp-save-<random>
//! 2. if path.exists(): fs::rename(path, &bak)   // bak = <path>.bak-<random>
//! 3. fs::rename(&temp, path)                    // install new
//! 4. fs::remove_dir_all(&bak)                   // best-effort cleanup (logged on failure)
//! ```
//!
//! Invariant: between any two adjacent steps, **at least one** of `path` or
//! `bak` contains a complete valid workbook.
//!
//! `load_workbook` runs `recover_from_crashed_save` first, which detects
//! orphan `.bak-*` siblings and either rolls forward (cleanup if `path` is
//! valid) or rolls back (rename `bak` → `path` if `path` is missing/invalid).
//!
//! ## Deferred to Phase 3+
//! - Computed-overlay separation (CORR-25 deferred).
//! - Cell formatting / number formats / styles.
//! - Sheet-scoped named ranges (`Sheet1!Local`).

use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use ql_storage::{NamedTarget, Sheet, Workbook};
use ql_types::{Address, ColId, ErrorValue, Range, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// On-disk schema version. Bumped on incompatible changes.
///
/// - `1` = Phase 1 W5-6 + W5-9: cell values + optional formulas.
/// - `2` = Phase 2A.8 megaudit closure: adds NameTable persistence, explicit
///   `Pending` CellWireValue, `deny_unknown_fields` strictness.
///
/// Loaders accept v1 AND v2 envelopes (v2 reader rewrites v1's `Error(#NULL!)`
/// placeholders into `Pending` when the cell carries a formula). v1 readers
/// (pre-2A.8 binaries, if any exist) refuse v2 via the `UnsupportedSchema`
/// error path.
/// **W5-71 (Phase 4.5.A.2):** bumped to v3. v3 adds an optional
/// `date_system` envelope field (`"1900"` or `"1904"`, default `"1900"`
/// on missing). Loaders accept v1, v2, AND v3 envelopes. A v2 envelope
/// loaded by a v3 reader gets `Workbook::date_system = Excel1900` (the
/// default). A v3 envelope's `date_system` is currently always set on
/// save; old binaries (v2 readers) refuse v3 via `UnsupportedSchema`.
///
/// **W5-81 (Phase 4.5.D part 5):** bumped to v4. v4 adds:
///   - top-level `formats: Option<FormatsSection>` — custom format
///     entries (id >= 164). Excel built-in ids 0-163 are NOT persisted;
///     `FormatTable::default()` re-seeds them on load.
///   - per-sheet `format_overlay: Option<Vec<FormatOverlayEntry>>` —
///     sparse `(row, col, id)` tuples binding cells to format ids.
///
/// **W5-92 (Phase 4.6.D):** bumped to v5. v5 adds:
///   - `NamedEntry.scope: Option<u16>` — `None` = workbook-scoped
///     (existing behavior; v1-v4 default), `Some(id)` = sheet-scoped
///     (new). The field is `#[serde(default, skip_serializing_if = ...)]`
///     so v1-v4 wire payloads continue to deserialize cleanly with
///     `scope = None` on every entry.
///
/// Loaders accept v1..=v5. v1-v4 envelopes load with all-workbook-
/// scoped names (regression-neutral). v4 readers refuse v5 via
/// `UnsupportedSchema` (the schema_version comparison upgrade is the
/// only fail-loud surface — `NamedEntry` itself uses `serde(default)`
/// so a v4 reader that somehow saw a v5 `NamedEntry` with `scope: Some`
/// would deserialize but then mis-route the name to the workbook scope
/// — the version gate prevents that path).
pub const WORKBOOK_SCHEMA_VERSION: u32 = 5;

/// The earliest schema version this reader still accepts. v1 fixtures (Phase 1)
/// continue to load on v2 binaries; older versions would need explicit handling.
///
/// Phase 2A.13 audit cycle-3 LOW-9: now `pub` so external callers (e.g.
/// `ql-oplog`) can inspect the accepted version range without reaching into
/// qbook_format internals.
pub const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Phase 2A.13 audit cycle-3 H1: sentinel filename written inside every
/// engine-saved workbook directory. Recovery scanning uses this to
/// distinguish engine-owned `.bak-<random>` siblings (which it may delete
/// or restore) from user-created sibling directories that happen to match
/// the `.bak-*` pattern (e.g., `book.qbook.bak-2025-review`).
///
/// The marker is written LAST in `write_workbook_to_dir` (after envelope +
/// all sheet JSONLs), so a partial write doesn't leave a misleading marker
/// in an incomplete directory. A v1 workbook re-saved on a v2 binary gains
/// the marker after one successful save; until then, recovery will refuse
/// to touch marker-less `.bak-*` siblings.
const ATOMIC_SAVE_MARKER_FILENAME: &str = ".atomic-save-marker-v1";

/// Errors that can occur during save / load.
#[derive(Debug, Error)]
pub enum QbookError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("TOML deserialize error: {0}")]
    TomlDe(#[from] toml::de::Error),

    #[error("TOML serialize error: {0}")]
    TomlSer(#[from] toml::ser::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error(
        "unsupported schema version {found} (this build supports versions \
         {MIN_SUPPORTED_SCHEMA_VERSION}..={WORKBOOK_SCHEMA_VERSION})"
    )]
    UnsupportedSchema { found: u32 },

    /// Phase 2A.8 audit M12: a NamedTargetWire couldn't be reconstructed into a
    /// `ql_storage::NamedTarget`. Carries the name and a reason string.
    #[error("malformed name {name:?}: {reason}")]
    MalformedName { name: String, reason: String },

    /// Phase 2A.8 audit H2: `path` doesn't have a parent directory or sensible
    /// file name, so the atomic-save temp/backup paths can't be derived.
    /// Surfaces from `make_save_paths` rather than the prior `unwrap_or` silent
    /// fallback.
    #[error("invalid workbook path {path:?}: {reason}")]
    InvalidPath { path: PathBuf, reason: &'static str },

    /// Phase 2A.13 audit cycle-3 M5: step 3 of the atomic-save protocol
    /// (rename temp → target) failed AND the rollback (rename backup → target)
    /// also failed. The user-visible state is "workbook may now be unavailable
    /// at `path`; backup data may still be at `backup_path`." Surfaces this
    /// fact directly instead of just bubbling up the original temp-rename
    /// error and burying the rollback failure in stderr.
    #[error(
        "atomic save rollback failed at {backup_path:?}: install error ({install}); \
         backup restore error ({restore}). Workbook may be unavailable at the target; \
         the backup directory still holds the prior state."
    )]
    AtomicSaveRollbackFailed {
        backup_path: PathBuf,
        install: String,
        restore: String,
    },

    #[error("malformed cell record in {file:?} at line {line}: {detail}")]
    MalformedCell {
        file: PathBuf,
        line: usize,
        detail: String,
    },

    #[error("workbook directory {path:?} does not exist or is not a directory")]
    NotADirectory { path: PathBuf },

    /// A cell value that doesn't survive JSON round-trip cleanly. serde_json
    /// silently encodes NaN/Inf as `null`, which then fails to load as a Number.
    /// Save-side validation rejects them with this error. Audit M6 fix (2026-05-12).
    #[error(
        "non-finite f64 cell at sheet {sheet} row {row} col {col}: {value} cannot be serialized"
    )]
    NonFiniteNumber {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: f64,
    },

    #[error("missing required file {file:?}")]
    MissingFile { file: PathBuf },

    /// Sheet ids in the envelope must be sequential 0..N. Audit M3 fix (2026-05-12).
    #[error("non-sequential sheet ids in envelope: expected id {expected}, found {found}")]
    NonSequentialSheetIds { expected: u16, found: u16 },

    /// **W5-81 (Phase 4.5.D part 5):** envelope's `formats` section
    /// references an id whose registration collides with the
    /// pre-populated built-in table OR an internal inconsistency
    /// (same string at two ids). The `details` field is the
    /// `FormatTableError`'s `Debug` rendering.
    #[error("malformed format entry id={id}: {details}")]
    MalformedFormat { id: u32, details: String },

    /// **W5-81 (Phase 4.5.D part 5):** per-sheet `format_overlay` carries
    /// coordinates outside the workbook's row/col bounds.
    #[error("malformed format overlay entry on sheet {sheet}: row={row}, col={col} ({why})")]
    MalformedFormatOverlay {
        sheet: u16,
        row: u32,
        col: u32,
        why: &'static str,
    },
}

/// TOML envelope for the workbook. Top-level metadata.
///
/// Phase 2A.8: `#[serde(deny_unknown_fields)]` rejects any unknown TOML key —
/// previously the loader silently dropped extras, which would let a v2-only
/// field be skipped by a still-v1 reader. Any future field requires an
/// explicit schema-version bump.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkbookEnvelope {
    pub schema_version: u32,
    /// User-supplied workbook name. Defaults to the directory name when omitted.
    pub name: String,
    /// Per-sheet metadata in id order.
    pub sheets: Vec<SheetEnvelope>,
    /// Phase 2A.8: workbook-scope defined-names section. Present in v2 envelopes
    /// (`Some` even when empty), absent in v1. `#[serde(default)]` lets v1 files
    /// load with `names: None`; the loader treats that as "no names registered."
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<NamesSection>,
    /// **W5-71 (Phase 4.5.A.2):** Excel date system. Present in v3 envelopes
    /// (always `Some` on save), absent in v1/v2 (loader maps `None` to
    /// `DateSystem::Excel1900` — the default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_system: Option<DateSystemWire>,
    /// **W5-81 (Phase 4.5.D part 5):** workbook-level format-string
    /// interning table. v4 envelopes carry custom format entries (id ≥
    /// 164) only; built-ins 0-163 are re-seeded by `FormatTable::default()`
    /// on load. v1-v3 envelopes omit the field; the loader treats `None`
    /// as "no custom formats registered" and proceeds with defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formats: Option<FormatsSection>,
}

/// **W5-71 (Phase 4.5.A.2):** wire representation of `ql_types::DateSystem`.
/// Serialized as a string `"1900"` or `"1904"` for human-readable TOML.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DateSystemWire {
    #[serde(rename = "1900")]
    Excel1900,
    #[serde(rename = "1904")]
    Excel1904,
}

impl DateSystemWire {
    pub fn from_runtime(system: ql_types::DateSystem) -> Self {
        match system {
            ql_types::DateSystem::Excel1900 => Self::Excel1900,
            ql_types::DateSystem::Excel1904 => Self::Excel1904,
        }
    }

    pub fn to_runtime(self) -> ql_types::DateSystem {
        match self {
            Self::Excel1900 => ql_types::DateSystem::Excel1900,
            Self::Excel1904 => ql_types::DateSystem::Excel1904,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetEnvelope {
    pub id: u16,
    pub name: String,
    /// Per-sheet chunk size (default 16384). Phase 1 W5-6 captures the constructed
    /// value so loaders reconstruct sheets at the same chunk layout.
    pub chunk_rows: u32,
    /// Highest-row written + 1, conservative. Reads beyond this still return Blank;
    /// the field exists for save-side allocation hints and observability.
    pub row_extent: u32,
    pub col_extent: u32,
    /// **W5-81 (Phase 4.5.D part 5):** per-sheet sparse cell-format overlay.
    /// `Some([])` and `None` are equivalent ("no custom formats on this
    /// sheet"); save serializes as `None` for v4 sheets with empty
    /// overlay to keep TOML minimal. Loader maps `None` → empty overlay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_overlay: Option<Vec<FormatOverlayEntry>>,
}

/// **W5-81 (Phase 4.5.D part 5):** workbook-level format-table wire format.
///
/// Persists ONLY custom entries (`id >= FIRST_CUSTOM_FORMAT_ID`). Built-in
/// ids 0-163 are re-seeded by `FormatTable::default()` at load time, so
/// putting them on disk would bloat every workbook with the same constants.
/// Entries are sorted by id for deterministic diffs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormatsSection {
    pub entries: Vec<FormatEntry>,
}

/// **W5-81 (Phase 4.5.D part 5):** one row in the workbook FormatTable.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormatEntry {
    pub id: u32,
    pub string: String,
}

/// **W5-81 (Phase 4.5.D part 5):** one entry in a sheet's cell-format
/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
/// for deterministic diffs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormatOverlayEntry {
    pub row: u32,
    pub col: u32,
    pub id: u32,
}

/// Phase 2A.8: workbook-scope defined names. The on-disk wire format mirrors
/// `ql_storage::NameTable` + `NamedTarget`, projected into serializable shapes.
///
/// Names are stored in canonical (upper-case) form, matching `NameTable::set`'s
/// canonicalization. Order is sorted ascending by name for deterministic diffs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamesSection {
    pub entries: Vec<NamedEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamedEntry {
    pub name: String,
    pub target: NamedTargetWire,
    /// **W5-92 (Phase 4.6.D):** name scope.
    /// - `None` (default; v1-v4 wire) = workbook-scoped.
    /// - `Some(sheet_id)` = sheet-scoped; sheet-scoped beats workbook-
    ///   scoped at lookup time (Excel canon, XS-4-03).
    ///
    /// `serde(default)` keeps the field optional in v1-v4 payloads;
    /// `skip_serializing_if` keeps v1-v4 round-trips byte-stable for
    /// workbook-scoped names (the common case).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<u16>,
}

/// Wire-format mirror of `ql_storage::NamedTarget`. Each variant is tagged
/// explicitly so the on-disk shape is self-describing and survives schema bumps.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NamedTargetWire {
    /// `NamedTarget::Cell` — single-cell anchor at `$Sheet!$Row,$Col`.
    Cell { sheet: u16, row: u32, col: u32 },
    /// `NamedTarget::Range` — rectangular range.
    Range {
        sheet: u16,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    },
    /// `NamedTarget::Constant(Value)` — reuses the cell wire-value vocabulary.
    Constant { value: CellWireValue },
    /// `NamedTarget::Formula(Arc<str>)` — raw formula source (without `=`).
    Formula { source: String },
}

/// JSONL cell record — one line per non-blank or formula-bearing cell.
///
/// Tagged enum representation keeps the wire format compact + self-describing:
/// `{"row":5,"col":3,"value":{"Number":42.0}}`.
///
/// - **W5-9** added the optional `formula` field. If `Some`, the cell carries a
///   formula whose evaluated result is `value`. If `None` (or absent in the
///   JSON), the cell is a literal value.
/// - **Phase 2A.8** added `deny_unknown_fields` per audit M9. Any unrecognized
///   JSON field is rejected loudly at parse time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CellRecord {
    pub row: u32,
    pub col: u32,
    pub value: CellWireValue,
    /// Formula source (without leading `=`). Phase 1 W5-9. Omitted from JSON when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
}

/// Wire-format mirror of `ql_types::Value`. Phase 1 W5-6 doesn't add Serialize to
/// ql-types directly (keeps the types crate lean); ql-io owns the encoding.
///
/// Phase 2A.8 (megaudit M11): added `Pending` variant for formula-bearing cells
/// whose saved value would be `Value::Blank` (because the formula hasn't been
/// evaluated yet, or its result really is Blank). Previously this case was
/// encoded as `Error("#NULL!")`, conflating "not yet evaluated" with a real
/// Excel `#NULL!` error. The v2 reader recognizes `Pending` as "needs
/// recompute"; for v1 files, the loader auto-rewrites `Error(#NULL!)` to
/// `Pending` when the same cell has a `formula` field.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum CellWireValue {
    Number(f64),
    Boolean(bool),
    Text(String),
    Error(String), // Stored as the canonical "#REF!" / "#VALUE!" / etc. text form.
    /// Formula-bearing cell with no evaluated value. Recompute resolves it.
    Pending,
}

impl CellWireValue {
    pub fn from_value(v: &Value) -> Option<Self> {
        match v {
            Value::Blank => None,
            Value::Number(n) => Some(CellWireValue::Number(*n)),
            Value::Boolean(b) => Some(CellWireValue::Boolean(*b)),
            Value::Text(s) => Some(CellWireValue::Text(s.as_ref().to_owned())),
            Value::Error(e) => Some(CellWireValue::Error(error_to_canonical_text(*e))),
        }
    }

    /// Decode the wire value into a `ql_types::Value`. `Pending` decodes to
    /// `Value::Blank` — the cell is in a transient state until recompute runs.
    pub fn to_value(&self) -> Result<Value, QbookError> {
        match self {
            CellWireValue::Number(n) => Ok(Value::number(*n)),
            CellWireValue::Boolean(b) => Ok(Value::Boolean(*b)),
            CellWireValue::Text(s) => Ok(Value::text(s.as_str())),
            CellWireValue::Error(s) => match parse_canonical_error_text(s) {
                Some(e) => Ok(Value::Error(e)),
                None => Err(QbookError::MalformedCell {
                    file: PathBuf::new(),
                    line: 0,
                    detail: format!("unknown error variant: {s:?}"),
                }),
            },
            CellWireValue::Pending => Ok(Value::Blank),
        }
    }

    /// True iff this is the Phase 2A.8 Pending sentinel (formula-bearing cell
    /// with no evaluated value).
    pub fn is_pending(&self) -> bool {
        matches!(self, CellWireValue::Pending)
    }
}

impl NamedTargetWire {
    /// Project a runtime `NamedTarget` into the wire shape for serialization.
    pub fn from_target(t: &NamedTarget) -> Self {
        match t {
            NamedTarget::Cell(addr) => NamedTargetWire::Cell {
                sheet: addr.sheet,
                row: addr.row,
                col: addr.col,
            },
            NamedTarget::Range(r) => NamedTargetWire::Range {
                sheet: r.sheet,
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
            },
            NamedTarget::Constant(v) => NamedTargetWire::Constant {
                // NamedTarget::Constant(Value::Blank) is unusual but valid; map
                // to Number(0.0) sentinel? No — preserve the variant by emitting
                // Error("BLANK_SENTINEL")? Also wrong. The cleanest answer: refuse
                // to serialize Blank constants — the user shouldn't have one,
                // and we'd round-trip-lose it anyway.
                //
                // In practice, `from_value(&Value::Blank)` returns None. So to
                // serialize a Blank constant we'd need a dedicated wire variant.
                // For Phase 2A.8 we deny it at save time via the conversion
                // helper below; this match arm assumes from_value returns Some.
                value: CellWireValue::from_value(v).unwrap_or(CellWireValue::Pending),
            },
            NamedTarget::Formula(src) => NamedTargetWire::Formula {
                source: src.as_ref().to_owned(),
            },
        }
    }

    /// Decode the wire shape back into a `NamedTarget`. Carries the name only
    /// for error reporting; the caller embeds the result in a `NameTable`.
    pub fn to_target(&self, name_for_error: &str) -> Result<NamedTarget, QbookError> {
        match self {
            NamedTargetWire::Cell { sheet, row, col } => {
                if *row > MAX_ROW {
                    return Err(QbookError::MalformedName {
                        name: name_for_error.to_owned(),
                        reason: format!("Cell.row {row} exceeds MAX_ROW {MAX_ROW}"),
                    });
                }
                if *col > MAX_COLUMN {
                    return Err(QbookError::MalformedName {
                        name: name_for_error.to_owned(),
                        reason: format!("Cell.col {col} exceeds MAX_COLUMN {MAX_COLUMN}"),
                    });
                }
                Ok(NamedTarget::Cell(Address::new(*sheet, *row, *col)))
            }
            NamedTargetWire::Range {
                sheet,
                start_row,
                start_col,
                end_row,
                end_col,
            } => {
                for (label, v, max) in [
                    ("start_row", *start_row, MAX_ROW),
                    ("start_col", *start_col, MAX_COLUMN),
                    ("end_row", *end_row, MAX_ROW),
                    ("end_col", *end_col, MAX_COLUMN),
                ] {
                    if v > max {
                        return Err(QbookError::MalformedName {
                            name: name_for_error.to_owned(),
                            reason: format!("Range.{label} {v} exceeds max {max}"),
                        });
                    }
                }
                Ok(NamedTarget::Range(Range::new(
                    *sheet, *start_row, *start_col, *end_row, *end_col,
                )))
            }
            NamedTargetWire::Constant { value } => {
                let v = value.to_value().map_err(|e| match e {
                    QbookError::MalformedCell { detail, .. } => QbookError::MalformedName {
                        name: name_for_error.to_owned(),
                        reason: format!("Constant decode: {detail}"),
                    },
                    other => other,
                })?;
                Ok(NamedTarget::Constant(v))
            }
            NamedTargetWire::Formula { source } => {
                Ok(NamedTarget::Formula(std::sync::Arc::from(source.as_str())))
            }
        }
    }
}

/// Map `ErrorValue` to its canonical Excel-style text form (`#REF!`, `#VALUE!`, etc.).
/// Used by both wire-format serialization and the user-visible representation per spec.
pub fn error_to_canonical_text(e: ErrorValue) -> String {
    match e {
        ErrorValue::Ref => "#REF!".to_string(),
        ErrorValue::Value => "#VALUE!".to_string(),
        ErrorValue::NA => "#N/A".to_string(),
        ErrorValue::DivZero => "#DIV/0!".to_string(),
        ErrorValue::Null => "#NULL!".to_string(),
        ErrorValue::Num => "#NUM!".to_string(),
        ErrorValue::Name => "#NAME?".to_string(),
        ErrorValue::Spill => "#SPILL!".to_string(),
        ErrorValue::Calc => "#CALC!".to_string(),
        ErrorValue::Disconnected => "#DISCONNECTED!".to_string(),
        ErrorValue::Binding => "#BINDING!".to_string(),
        ErrorValue::Timeout => "#TIMEOUT!".to_string(),
        ErrorValue::Permission => "#PERMISSION!".to_string(),
        ErrorValue::AINotAvailable => "#AI_NOT_AVAILABLE_V1".to_string(),
        ErrorValue::Circ => "#CIRC!".to_string(),
    }
}

fn parse_canonical_error_text(s: &str) -> Option<ErrorValue> {
    Some(match s {
        "#REF!" => ErrorValue::Ref,
        "#VALUE!" => ErrorValue::Value,
        "#N/A" => ErrorValue::NA,
        "#DIV/0!" => ErrorValue::DivZero,
        "#NULL!" => ErrorValue::Null,
        "#NUM!" => ErrorValue::Num,
        "#NAME?" => ErrorValue::Name,
        "#SPILL!" => ErrorValue::Spill,
        "#CALC!" => ErrorValue::Calc,
        "#DISCONNECTED!" => ErrorValue::Disconnected,
        "#BINDING!" => ErrorValue::Binding,
        "#TIMEOUT!" => ErrorValue::Timeout,
        "#PERMISSION!" => ErrorValue::Permission,
        "#AI_NOT_AVAILABLE_V1" => ErrorValue::AINotAvailable,
        "#CIRC!" => ErrorValue::Circ,
        _ => return None,
    })
}

/// Save a `Workbook` to `path` (a `.qbook/` directory). **Crash-safe atomic save**
/// per the Phase 2A.8 megaudit H2 closure:
///
/// 1. Write the new workbook to `<path>.tmp-save-<random>`.
/// 2. If `path` already exists, rename it to `<path>.bak-<random>`.
/// 3. Rename the temp directory into `path`.
/// 4. Best-effort remove the backup; on failure, log a warning to stderr but
///    DO NOT silently swallow (megaudit M8). The next `load_workbook` will
///    detect the orphan via `recover_from_crashed_save` and clean it up.
///
/// **Invariant**: between any two adjacent steps, at least one of `path` or
/// `<path>.bak-<random>` contains a complete valid workbook. A crash at any
/// instant leaves a recoverable on-disk state.
///
/// Cross-filesystem note: the temp and backup paths are *siblings* of the
/// target, sharing its parent directory. POSIX `rename(2)` is atomic within a
/// single filesystem; the sibling-only design preserves that property.
pub fn save_workbook(wb: &Workbook, name: &str, path: &Path) -> Result<(), QbookError> {
    save_workbook_extending(wb, name, path, |_| Ok(()))
}

/// Phase 2A.3.c (2026-05-12): closure-based extension primitive. Same atomic-save
/// protocol as `save_workbook`, with an additional hook (`extend`) that fires
/// AFTER `write_workbook_to_dir` populates the temp directory but BEFORE the
/// atomic `rename(temp → target)`. Used by `ql_oplog::save_workbook_with_oplog`
/// to write `oplog.bin` as a sidecar — it rides the same atomic rename and
/// recovers via the same crash-rollback path.
///
/// The closure receives the temp directory path. It can `fs::write` arbitrary
/// files into it. The atomic-save invariant still holds: at every step
/// boundary, at least one of {target, `<target>.bak-<random>`} contains a
/// complete valid workbook + any sidecars the closure wrote.
///
/// Closure failure cleans up the temp directory and propagates the error —
/// same semantics as a `write_workbook_to_dir` failure.
///
/// Public `save_workbook` is a thin wrapper that calls this with a no-op
/// closure; callers without sidecars should keep using `save_workbook`.
pub fn save_workbook_extending<F>(
    wb: &Workbook,
    name: &str,
    path: &Path,
    extend: F,
) -> Result<(), QbookError>
where
    F: FnOnce(&Path) -> Result<(), QbookError>,
{
    let paths = make_save_paths(path)?;

    // Phase 2A.13 audit cycle-3 H5: refuse to save into a path that exists
    // but is NOT a directory. `path.exists() && !path.is_dir()` means a
    // regular file (or symlink, FIFO, etc.) is sitting where the workbook
    // directory should be. The previous code would have happily renamed
    // that file to `<base>.bak-<suffix>`, then installed our directory in
    // its place — the user's original file becomes an orphan no one will
    // ever find (recovery would try `remove_dir_all` on it and fail with
    // `NotADirectory`). Loud refusal is the right answer.
    if path.exists() && !path.is_dir() {
        return Err(QbookError::InvalidPath {
            path: path.to_path_buf(),
            reason: "target exists but is not a directory",
        });
    }

    // Step 1: write everything to the temp dir. If this fails, the original
    // target (if any) is untouched and we clean up the partial temp.
    if let Err(e) = write_workbook_to_dir(wb, name, &paths.temp) {
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            // The original save error is what the caller wants; the cleanup
            // failure goes to stderr per the M8 audit (don't silence).
            eprintln!(
                "warning: failed to clean partial temp directory {:?} after save error: {cleanup_err}",
                paths.temp
            );
        }
        return Err(e);
    }

    // Phase 2A.3.c: extension hook fires after the engine has finished
    // populating the temp dir (envelope + sheets + marker), but before the
    // atomic rename. Sidecars written here become part of the all-or-nothing
    // visibility guarantee.
    if let Err(e) = extend(&paths.temp) {
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            eprintln!(
                "warning: failed to clean partial temp directory {:?} after extend error: {cleanup_err}",
                paths.temp
            );
        }
        return Err(e);
    }

    // Step 2: if target exists, move it aside (NOT remove). After this, the
    // old state is at `.bak-<random>` and the target is missing.
    let had_existing = path.exists();
    if had_existing {
        fs::rename(path, &paths.backup)?;
    }

    // Step 3: install the new state at the target. If this fails after step 2,
    // we have `.bak-<random>` only and no target — recovery on next load will
    // roll back. To avoid leaving the temp dir orphaned in that case, attempt
    // a rollback ourselves before returning.
    if let Err(install_err) = fs::rename(&paths.temp, path) {
        // Phase 2A.13 audit cycle-3 M5: when install fails AND restore also
        // fails, surface a compound error (was: silently `eprintln!`ed the
        // restore failure and returned only the install error).
        let restore_err: Option<std::io::Error> = if had_existing {
            fs::rename(&paths.backup, path).err()
        } else {
            None
        };
        // The temp dir didn't move into place; try to clean it up.
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            eprintln!(
                "warning: failed to clean temp directory {:?} after rename failure: {cleanup_err}",
                paths.temp
            );
        }
        if let Some(restore_err) = restore_err {
            // Both failed → compound user-visible error.
            return Err(QbookError::AtomicSaveRollbackFailed {
                backup_path: paths.backup.clone(),
                install: install_err.to_string(),
                restore: restore_err.to_string(),
            });
        }
        // Restore succeeded (or no prior target existed): the user's prior
        // workbook is intact at `path`. Return the install error so the
        // caller knows the save itself failed.
        return Err(QbookError::Io(install_err));
    }

    // Step 4: best-effort backup cleanup. On failure, log loudly — but the
    // save itself succeeded, so we return Ok. `recover_from_crashed_save` on
    // a future load will eventually clean up the orphan.
    if had_existing {
        if let Err(e) = fs::remove_dir_all(&paths.backup) {
            eprintln!(
                "warning: save succeeded but backup cleanup failed at {:?}: {e}",
                paths.backup
            );
        }
    }
    Ok(())
}

/// Phase 2A.8 audit M10: each save uses a fresh, collision-resistant suffix so
/// concurrent saves from two threads in the same process never share temp /
/// backup paths. The suffix mixes wall-clock nanos, PID, and the calling
/// thread's id — sufficient uniqueness for the IDE save-path workload without
/// pulling in a random-source crate.
fn save_session_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    // ThreadId formats as "ThreadId(N)" — hash via length + a fixed mixer to
    // get a u64 contribution. Stable within a process.
    let tid_str = format!("{:?}", std::thread::current().id());
    let tid_hash = tid_str.bytes().fold(0u64, |acc, b| {
        acc.wrapping_mul(0x100000001B3).wrapping_add(b as u64)
    });
    let mixed = nanos
        .wrapping_mul(0x9E3779B97F4A7C15)
        .wrapping_add(pid.wrapping_mul(0xBF58476D1CE4E5B9))
        ^ tid_hash;
    format!("{mixed:016x}")
}

/// Resolved temp + backup paths for one save invocation. Sharing the suffix
/// between temp and backup lets `recover_from_crashed_save` link them
/// unambiguously if a crash occurs mid-protocol.
struct SavePaths {
    temp: PathBuf,
    backup: PathBuf,
}

/// Derive temp + backup sibling paths for `target`. Phase 2A.8 audit M9
/// closure: degenerate paths (no parent, no file_name) error loudly via
/// `QbookError::InvalidPath` rather than the prior `unwrap_or` silent fallback.
fn make_save_paths(target: &Path) -> Result<SavePaths, QbookError> {
    let parent = target.parent().ok_or_else(|| QbookError::InvalidPath {
        path: target.to_path_buf(),
        reason: "no parent directory",
    })?;
    let basename = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "no file name",
        })?;
    // Refuse to save into a target whose basename is itself a temp/backup name
    // — that would let a path like `foo.bak-abc/` collide with our own
    // backup-rename protocol. Phase 2A.8 conservative gate; the IDE shouldn't
    // pick names like this, but a hostile caller could.
    if basename.contains(".tmp-save-") || basename.contains(".bak-") {
        return Err(QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "basename collides with atomic-save protocol naming",
        });
    }
    let suffix = save_session_suffix();
    Ok(SavePaths {
        temp: parent.join(format!("{basename}.tmp-save-{suffix}")),
        backup: parent.join(format!("{basename}.bak-{suffix}")),
    })
}

/// Phase 2A.8 audit H2 recovery protocol. Called at the top of
/// `load_workbook`. Detects orphan `.bak-<random>` siblings of `target` and
/// either rolls forward (target is intact, just clean up bak) or rolls back
/// (target missing/invalid, rename bak → target).
///
/// If multiple `.bak-*` orphans exist (unlikely; would require multiple
/// crashes across save sessions), we conservatively refuse to load and ask
/// the caller to manually resolve. Returning an error here is safer than
/// guessing which backup is "the right one."
fn recover_from_crashed_save(target: &Path) -> Result<(), QbookError> {
    let Some(parent) = target.parent() else {
        return Ok(()); // No parent, nothing to scan.
    };
    let basename = match target.file_name() {
        Some(s) => s.to_string_lossy().into_owned(),
        None => return Ok(()),
    };
    let bak_prefix = format!("{basename}.bak-");

    // Scan the parent dir for orphan .bak-* siblings.
    // Phase 2A.13 audit cycle-3 H1: ONLY consider directories that carry our
    // atomic-save marker file (`is_engine_owned_backup`). A user-created
    // sibling like `book.qbook.bak-2025-review` shares the filename prefix
    // but lacks the marker — recovery leaves it alone.
    let mut orphans: Vec<PathBuf> = Vec::new();
    let read_dir = match fs::read_dir(parent) {
        Ok(it) => it,
        Err(_) => return Ok(()), // Parent unreadable; load will fail downstream with a clearer error.
    };
    for entry in read_dir.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with(&bak_prefix) {
                let p = entry.path();
                if is_engine_owned_backup(&p) {
                    orphans.push(p);
                }
                // Else: user-created sibling that just happens to match the
                // `.bak-*` prefix. Not ours, don't touch.
            }
        }
    }

    if orphans.is_empty() {
        return Ok(());
    }

    // Phase 2A.13 audit cycle-3 M6: when the target is valid AND we have
    // multiple orphans, they're ALL stale (a valid target can only result
    // from a single most-recent successful save; any older `.bak-*` is from
    // a prior save whose step-4 cleanup never completed). Clean them all up
    // instead of refusing to load — accumulated `eprintln!` warnings from
    // repeated step-4 failures would otherwise create a permanent deadlock.
    if target_envelope_is_valid(target) {
        for bak in &orphans {
            if let Err(e) = fs::remove_dir_all(bak) {
                eprintln!(
                    "warning: load detected orphan backup {bak:?} but cleanup failed: {e}; \
                     target is valid, so load proceeds"
                );
            }
        }
        return Ok(());
    }

    // Target is missing or invalid. We need to restore from a backup.
    // Multi-orphan case here IS ambiguous (we don't know which backup
    // matches the missing target); refuse and ask the user.
    if orphans.len() > 1 {
        return Err(QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "target is missing/invalid AND multiple .bak-* siblings present; \
                     ambiguous crash recovery — resolve manually before loading",
        });
    }
    let bak = orphans.into_iter().next().expect("len == 1");

    // Step 2 completed but step 3 didn't (or step 3 partially completed
    // and left an invalid target). Roll back: restore the old state.
    if target.exists() {
        if let Err(e) = fs::remove_dir_all(target) {
            return Err(QbookError::Io(e));
        }
    }
    // Phase 2A.13 audit cycle-3 M4: concurrent loader race. Two loaders
    // seeing the same orphan can race here — one wins, the other sees
    // `NotFound` because the bak is already consumed. If we lose the
    // rename race, re-check whether the target is NOW valid (the other
    // loader's rename succeeded and installed it). Only return the I/O
    // error if the rollback genuinely failed.
    if let Err(rename_err) = fs::rename(&bak, target) {
        if target_envelope_is_valid(target) {
            // Another loader won the race and the rollback is already done.
            // We're good — proceed with load.
            return Ok(());
        }
        return Err(QbookError::Io(rename_err));
    }
    Ok(())
}

/// Cheap envelope-validity check used by recovery. The full load is the real
/// validity test, but recovery needs a quick yes/no to decide forward vs
/// back. We check: directory exists, `workbook.toml` parses, every claimed
/// sheet JSONL file exists. We DO NOT parse JSONL line-by-line — that's the
/// load path's job.
fn target_envelope_is_valid(target: &Path) -> bool {
    if !target.is_dir() {
        return false;
    }
    let toml_path = target.join("workbook.toml");
    if !toml_path.is_file() {
        return false;
    }
    let toml_str = match fs::read_to_string(&toml_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let envelope: WorkbookEnvelope = match toml::from_str(&toml_str) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let sheets_dir = target.join("sheets");
    for sheet_env in &envelope.sheets {
        let sheet_path = sheets_dir.join(format!("{}.jsonl", sheet_env.id));
        if !sheet_path.is_file() {
            return false;
        }
    }
    true
}

/// Inner write that populates `dir` with `workbook.toml` + `sheets/*.jsonl`. Used by
/// `save_workbook` against a temp dir; not a public surface (the atomic-save wrapper
/// is what callers want).
fn write_workbook_to_dir(wb: &Workbook, name: &str, dir: &Path) -> Result<(), QbookError> {
    fs::create_dir_all(dir)?;
    let sheets_dir = dir.join("sheets");
    fs::create_dir_all(&sheets_dir)?;

    // Build the envelope.
    let mut sheet_envelopes: Vec<SheetEnvelope> = Vec::new();
    for sheet_id in 0..(wb.sheet_count() as SheetId) {
        let sheet = wb.sheet(sheet_id).expect("sheet_count was wrong");
        let bounds = sheet.bounds();
        // **W5-81 (Phase 4.5.D part 5):** serialize the per-sheet cell-format
        // overlay if it has any entries. Sorted by (row, col) for diffability.
        let format_overlay = {
            let overlay = sheet.format_overlay();
            if overlay.is_empty() {
                None
            } else {
                let mut entries: Vec<FormatOverlayEntry> = overlay
                    .iter()
                    .map(|((r, c), fid)| FormatOverlayEntry {
                        row: r,
                        col: c,
                        id: fid.0,
                    })
                    .collect();
                entries.sort_by_key(|e| (e.row, e.col));
                Some(entries)
            }
        };
        sheet_envelopes.push(SheetEnvelope {
            id: sheet_id,
            name: sheet.name().to_owned(),
            chunk_rows: sheet_chunk_rows(sheet),
            row_extent: bounds.row_extent,
            col_extent: bounds.col_extent,
            format_overlay,
        });
    }

    // Phase 2A.8: serialize the workbook's NameTable. Sorted ascending by
    // (scope, name) for deterministic on-disk diffs (workbook-scoped first
    // since `None < Some` under derive(Ord); then by name). Omitted (None)
    // when both workbook-scoped table AND every sheet's scoped_names table
    // are empty, so v1-reader compatibility round-trips cleanly for the
    // empty-names common case.
    //
    // **W5-92 (Phase 4.6.D):** collects workbook-scoped names first, then
    // sheet-scoped names from each sheet's `scoped_names` table. The
    // `scope` field on `NamedEntry` distinguishes the two; legacy v1-v4
    // readers emit only the workbook-scoped entries (no per-sheet names
    // existed pre-v5).
    let names_section = {
        let mut entries: Vec<NamedEntry> = Vec::new();
        for (name, target) in wb.names().iter() {
            entries.push(NamedEntry {
                name: name.as_ref().to_owned(),
                target: NamedTargetWire::from_target(target),
                scope: None,
            });
        }
        for sheet_id in 0..wb.sheet_count() as ql_types::SheetId {
            if let Some(sheet) = wb.sheet(sheet_id) {
                for (name, target) in sheet.scoped_names().iter() {
                    entries.push(NamedEntry {
                        name: name.as_ref().to_owned(),
                        target: NamedTargetWire::from_target(target),
                        scope: Some(sheet_id),
                    });
                }
            }
        }
        if entries.is_empty() {
            None
        } else {
            // Deterministic ordering: workbook-scoped (scope=None) entries
            // first, then sheet-scoped grouped by sheet id; within each
            // group, names sorted ascending.
            entries.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));
            Some(NamesSection { entries })
        }
    };

    // **W5-81 (Phase 4.5.D part 5):** serialize custom FormatTable entries
    // (id ≥ FIRST_CUSTOM_FORMAT_ID). Built-ins are re-seeded from
    // `FormatTable::default()` on load and aren't persisted. None if the
    // table has no custom entries (typical for built-in-only workbooks).
    let formats_section = {
        let mut entries: Vec<FormatEntry> = wb
            .formats()
            .iter()
            .filter(|(id, _)| id.0 >= ql_storage::FIRST_CUSTOM_FORMAT_ID)
            .map(|(id, s)| FormatEntry {
                id: id.0,
                string: s.to_owned(),
            })
            .collect();
        if entries.is_empty() {
            None
        } else {
            entries.sort_by_key(|e| e.id);
            Some(FormatsSection { entries })
        }
    };

    let envelope = WorkbookEnvelope {
        schema_version: WORKBOOK_SCHEMA_VERSION,
        name: name.to_owned(),
        sheets: sheet_envelopes,
        names: names_section,
        // **W5-71 (Phase 4.5.A.2):** persist the workbook's date system.
        date_system: Some(DateSystemWire::from_runtime(wb.date_system())),
        // **W5-81 (Phase 4.5.D part 5):** persist custom format entries.
        formats: formats_section,
    };
    let toml_str = toml::to_string_pretty(&envelope)?;
    fs::write(dir.join("workbook.toml"), toml_str)?;

    // Per-sheet JSONL.
    for sheet_id in 0..(wb.sheet_count() as SheetId) {
        let sheet = wb.sheet(sheet_id).expect("sheet_count was wrong");
        let sheet_path = sheets_dir.join(format!("{sheet_id}.jsonl"));
        let f = fs::File::create(&sheet_path)?;
        let mut writer = BufWriter::new(f);
        let bounds = sheet.bounds();

        // Collect formula cells for this sheet so we can emit them even when their
        // row/col falls outside the value-bounds rectangle (e.g. a formula cell
        // with no evaluated value yet, or a formula at an extreme position).
        // Sort by (row, col) for deterministic output.
        let mut formula_positions: Vec<(RowId, ColId)> = wb
            .iter_formulas()
            .filter(|(s, _, _, _)| *s == sheet_id)
            .map(|(_, r, c, _)| (r, c))
            .collect();
        formula_positions.sort();

        // Track which (row, col) pairs we've already written from the value-bounds
        // sweep, so the formula-only pass doesn't double-emit.
        let mut written: std::collections::HashSet<(RowId, ColId)> =
            std::collections::HashSet::new();

        // Naive iteration over value bounds. Sparse cells (Blank without a formula)
        // are skipped. Phase 2 may optimize via direct chunk-walking; not on hot path.
        for row in 0..bounds.row_extent {
            for col in 0..bounds.col_extent {
                let v = sheet.read(row, col);
                // Audit M6 fix (2026-05-12): reject NaN/Inf at the save boundary.
                if let Value::Number(n) = v {
                    if !n.is_finite() {
                        return Err(QbookError::NonFiniteNumber {
                            sheet: sheet_id,
                            row,
                            col,
                            value: n,
                        });
                    }
                }
                let wire = CellWireValue::from_value(&v);
                let formula = wb
                    .formula_at(sheet_id, row, col)
                    .map(|s| s.as_ref().to_owned());
                // Emit if there's a non-blank value OR a formula.
                if wire.is_some() || formula.is_some() {
                    // Phase 2A.8 audit M11: formula-bearing cells with Blank
                    // saved value encode as `Pending` (was: `Error(#NULL!)`,
                    // which conflated "not yet evaluated" with a real Excel
                    // #NULL! error). `Pending` is a distinct wire variant the
                    // loader recognizes as "recompute required."
                    let rec = CellRecord {
                        row,
                        col,
                        value: wire.unwrap_or(CellWireValue::Pending),
                        formula,
                    };
                    let line = serde_json::to_string(&rec)?;
                    writeln!(writer, "{line}")?;
                    written.insert((row, col));
                }
            }
        }

        // Emit formula cells whose (row, col) fell outside the value-bounds
        // rectangle. These are formula-only cells with Blank values: encoded
        // as `Pending` per Phase 2A.8 audit M11 so the formula text survives
        // round-trip without conflating with a real #NULL! error.
        for (row, col) in formula_positions {
            if written.contains(&(row, col)) {
                continue;
            }
            let formula = wb
                .formula_at(sheet_id, row, col)
                .map(|s| s.as_ref().to_owned());
            let rec = CellRecord {
                row,
                col,
                value: CellWireValue::Pending,
                formula,
            };
            let line = serde_json::to_string(&rec)?;
            writeln!(writer, "{line}")?;
        }
        writer.flush()?;
    }

    // Phase 2A.13 audit cycle-3 H1: write the atomic-save marker LAST, after
    // envelope + all sheet JSONLs. A partial write that fails before this
    // point leaves a directory WITHOUT the marker, so recovery won't
    // mistake the partial result for an engine-owned backup. Marker
    // content is the schema version + a human-readable note (no parsing —
    // the filename's presence is the only signal recovery consults).
    fs::write(
        dir.join(ATOMIC_SAVE_MARKER_FILENAME),
        format!(
            "Quantbook atomic-save marker v1 (schema_version={WORKBOOK_SCHEMA_VERSION}).\n\
             Presence of this file proves the directory was written by the\n\
             engine's atomic-save protocol. Used by recover_from_crashed_save\n\
             to distinguish engine-owned `.bak-<random>` siblings from\n\
             user-created sibling directories. Safe to ignore.\n"
        ),
    )?;

    Ok(())
}

/// Phase 2A.13 audit cycle-3 H1: a directory is "engine-owned" iff it contains
/// our marker file. Used by recovery to filter `.bak-<random>` siblings —
/// user-created directories that match the prefix but lack the marker are
/// left alone.
fn is_engine_owned_backup(dir: &Path) -> bool {
    dir.join(ATOMIC_SAVE_MARKER_FILENAME).is_file()
}

/// Load a `Workbook` from a `.qbook/` directory.
///
/// Phase 2A.8 audit H2: before reading, calls `recover_from_crashed_save` to
/// detect and resolve orphan `.bak-<random>` siblings left by a prior crashed
/// save. Recovery either rolls forward (target valid, cleanup orphan) or rolls
/// back (target missing/invalid, restore orphan).
pub fn load_workbook(path: &Path) -> Result<Workbook, QbookError> {
    // Recovery happens BEFORE the directory check — if the prior save crashed
    // between step 2 (rename → bak) and step 3 (rename temp → target), the
    // target may not yet exist. Recovery restores it from .bak.
    recover_from_crashed_save(path)?;

    if !path.is_dir() {
        return Err(QbookError::NotADirectory {
            path: path.to_path_buf(),
        });
    }

    // Read + parse envelope.
    let toml_path = path.join("workbook.toml");
    if !toml_path.is_file() {
        return Err(QbookError::MissingFile { file: toml_path });
    }
    let toml_str = fs::read_to_string(&toml_path)?;
    let envelope: WorkbookEnvelope = toml::from_str(&toml_str)?;

    // Phase 2A.8: accept schema versions in [MIN_SUPPORTED..=current].
    // v1 envelopes load on v2 binaries (with `names: None`); future v3 will
    // reject with this same path until callers explicitly opt in.
    if envelope.schema_version < MIN_SUPPORTED_SCHEMA_VERSION
        || envelope.schema_version > WORKBOOK_SCHEMA_VERSION
    {
        return Err(QbookError::UnsupportedSchema {
            found: envelope.schema_version,
        });
    }
    let is_v1 = envelope.schema_version == 1;

    // Phase 2A.13 audit cycle-3 H4: counter for legacy-pending migrations so we
    // can warn the user once per load (rather than silently corrupting any
    // legitimate `#NULL!` formula results from v1 workbooks).
    let mut legacy_pending_migrations: usize = 0;

    // Construct the Workbook + sheets in id order. Sheet ids in the envelope must be
    // sequential 0..N — Workbook::add_sheet allocates ids in that order.
    // Audit M3 fix (2026-05-12): previously this panicked; now returns Result error.
    let mut wb = Workbook::new();
    // **W5-71 (Phase 4.5.A.2):** apply the envelope's date_system, defaulting
    // to Excel1900 when absent (v1/v2 envelopes lack the field). v3+
    // envelopes always carry it.
    if let Some(ds_wire) = envelope.date_system {
        wb.set_date_system(ds_wire.to_runtime());
    }
    // (Else: leave at Workbook::default(), which is Excel1900.)
    // **W5-81 (Phase 4.5.D part 5):** apply the envelope's FormatsSection.
    // v4 envelopes carry custom format entries (id ≥ 164); v1-v3 don't.
    // Built-ins 0-163 are already in the FormatTable from
    // `Workbook::default()`. `register_at` is idempotent for the
    // pre-seeded builtins; mismatches surface as `MalformedFormat`.
    if let Some(ref fs) = envelope.formats {
        for entry in &fs.entries {
            wb.formats_mut()
                .register_at(ql_storage::FormatId(entry.id), entry.string.as_str())
                .map_err(|err| QbookError::MalformedFormat {
                    id: entry.id,
                    details: format!("{err:?}"),
                })?;
        }
    }
    let sheets_dir = path.join("sheets");
    for (expected_id, sheet_env) in envelope.sheets.iter().enumerate() {
        if sheet_env.id as usize != expected_id {
            return Err(QbookError::NonSequentialSheetIds {
                expected: expected_id as u16,
                found: sheet_env.id,
            });
        }
        let sheet_id = wb.add_sheet_with_chunk_rows(sheet_env.name.clone(), sheet_env.chunk_rows);
        assert_eq!(
            sheet_id as usize, expected_id,
            "Workbook::add_sheet_with_chunk_rows returned non-sequential id — programmer error in ql-storage"
        );

        // **W5-81 (Phase 4.5.D part 5):** apply the per-sheet cell-format
        // overlay. v4 envelopes carry `format_overlay`; v1-v3 don't.
        //
        // **W5-84 closure (Codex MEDIUM-3):** the loader now VALIDATES
        // that each overlay id resolves in the workbook's `FormatTable`,
        // matching the runtime + replay contract (which both surface
        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
        // corrupted `.qbook` binding a cell to an unregistered id no
        // longer falls through to silent General fallback at render
        // time — it now surfaces `MalformedFormatOverlay` at load.
        if let Some(ref overlay_entries) = sheet_env.format_overlay {
            // Snapshot the set of registered ids BEFORE the overlay
            // mutation so we don't borrow `wb` twice (mutable on the
            // sheet + immutable on `wb.formats()`).
            let known_ids: std::collections::HashSet<u32> =
                wb.formats().iter().map(|(id, _)| id.0).collect();
            let sheet_mut = wb.sheet_mut(sheet_id).expect("just-added sheet must exist");
            for entry in overlay_entries {
                // Bounds-check to mirror the cell-record validation
                // below — out-of-range coordinates surface as
                // `MalformedFormatOverlay` rather than silently binding
                // a sentinel address.
                if entry.row > MAX_ROW || entry.col > MAX_COLUMN {
                    return Err(QbookError::MalformedFormatOverlay {
                        sheet: sheet_id,
                        row: entry.row,
                        col: entry.col,
                        why: "out-of-range row/col",
                    });
                }
                if !known_ids.contains(&entry.id) {
                    return Err(QbookError::MalformedFormatOverlay {
                        sheet: sheet_id,
                        row: entry.row,
                        col: entry.col,
                        why: "format id not registered in FormatTable",
                    });
                }
                sheet_mut.format_overlay_mut().set(
                    entry.row,
                    entry.col,
                    ql_storage::FormatId(entry.id),
                );
            }
        }

        // Audit M2 fix (2026-05-12): a missing sheet JSONL is now an explicit
        // MissingFile error rather than silently treating the sheet as empty
        // (which would mask corruption / partial saves). The on-disk format
        // emits an empty file for an empty sheet, so file-presence is the
        // correctness oracle.
        let sheet_path = sheets_dir.join(format!("{sheet_id}.jsonl"));
        if !sheet_path.is_file() {
            return Err(QbookError::MissingFile { file: sheet_path });
        }
        let f = fs::File::open(&sheet_path)?;
        let reader = BufReader::new(f);
        for (line_no, line) in reader.lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let rec: CellRecord =
                serde_json::from_str(&line).map_err(|e| QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail: format!("JSON parse: {e}"),
                })?;
            // Audit H4 fix (2026-05-12): validate row/col bounds at the loader so
            // hand-crafted JSONL with out-of-bounds coordinates produces a clean
            // MalformedCell error instead of panicking inside Sheet::put.
            if rec.row > MAX_ROW {
                return Err(QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail: format!("row {} exceeds MAX_ROW {MAX_ROW}", rec.row),
                });
            }
            if rec.col > MAX_COLUMN {
                return Err(QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail: format!("col {} exceeds MAX_COLUMN {MAX_COLUMN}", rec.col),
                });
            }
            // Phase 2A.8 audit M11: detect the v1 legacy encoding of a
            // formula-bearing Blank cell (`Error("#NULL!")` + formula) and
            // rewrite it to the v2 Pending semantic during the v1 load path.
            // v2 files emit `Pending` directly and skip this branch.
            //
            // Phase 2A.13 audit cycle-3 H4: this rule cannot distinguish
            // "engine wrote #NULL! as Pending stand-in" from "user's formula
            // legitimately evaluated to #NULL!" (Excel's intersection-of-
            // disjoint-ranges error, e.g. `=SUM(A1 B1)` with a space). Both
            // encode identically in v1. We count migrations and warn ONCE
            // per load at the end so the user can audit suspect formulas
            // rather than silently corrupting real #NULL! results.
            let is_legacy_pending = is_v1
                && rec.formula.is_some()
                && matches!(&rec.value, CellWireValue::Error(s) if s == "#NULL!");
            if is_legacy_pending {
                legacy_pending_migrations += 1;
            }

            let value = if rec.value.is_pending() || is_legacy_pending {
                // Pending cells contribute no Value to the cell — leave it
                // Blank until recompute runs. The formula text below is what
                // matters for the recompute pass.
                Value::Blank
            } else {
                rec.value.to_value().map_err(|e| match e {
                    QbookError::MalformedCell { detail, .. } => QbookError::MalformedCell {
                        file: sheet_path.clone(),
                        line: line_no + 1,
                        detail,
                    },
                    other => other,
                })?
            };
            // Phase 3.5 (CORR-25, 2026-05-12) — OVR-3-03: load routes
            // cells with formulas to the COMPUTED overlay; cells without
            // formulas go to the USER overlay. This preserves the
            // engine's semantic invariant ("formula-owned cell has no
            // user-overlay entry"). Pending/Blank values are skipped on
            // the formula path because there's nothing to display until
            // recompute runs; the formula text alone is enough to drive
            // the recompute pass.
            let row = rec.row as RowId;
            let col = rec.col as ColId;
            if let Some(formula_text) = rec.formula {
                wb.put_formula(sheet_id, row, col, formula_text);
                if !matches!(value, Value::Blank) {
                    wb.put_computed_at(sheet_id, row, col, value);
                }
            } else {
                wb.put_at(sheet_id, row, col, value);
            }
        }
    }

    // Phase 2A.8: hydrate the workbook's NameTable from the envelope's
    // `names` section. v1 envelopes lack the section (envelope.names is None);
    // those workbooks load with an empty NameTable, matching prior behavior.
    //
    // Phase 2A.9 audit M6: `Workbook::set_name` may now refuse reserved names
    // (currently `AI` per CORR-06). A v2 file that somehow contains a reserved
    // name (e.g., hand-edited TOML) surfaces as `QbookError::MalformedName`.
    // **W5-92 (Phase 4.6.D):** route by scope. `scope: None` (the v1-v4
    // historical case) lands in the workbook-scoped `NameTable`;
    // `scope: Some(id)` lands in that sheet's `scoped_names` table. An
    // unknown sheet id surfaces as `MalformedName` (the load-time
    // analog of the op-log replay's `InvalidSheet` — we can't carry the
    // structural error through `QbookError`'s vocabulary without a new
    // variant, and `MalformedName` is the right shape for "name's
    // target is bad").
    if let Some(names_section) = envelope.names {
        for entry in names_section.entries {
            let target = entry.target.to_target(&entry.name)?;
            match entry.scope {
                None => {
                    wb.set_name(&entry.name, target)
                        .map_err(|e| QbookError::MalformedName {
                            name: entry.name.clone(),
                            reason: format!("rejected by workbook NameTable: {e}"),
                        })?;
                }
                Some(sheet_id) => {
                    let sheet =
                        wb.sheet_mut(sheet_id)
                            .ok_or_else(|| QbookError::MalformedName {
                                name: entry.name.clone(),
                                reason: format!("scope refers to unknown sheet id {sheet_id}"),
                            })?;
                    sheet.set_scoped_name(&entry.name, target).map_err(|e| {
                        QbookError::MalformedName {
                            name: entry.name.clone(),
                            reason: format!("rejected by sheet {sheet_id} NameTable: {e}"),
                        }
                    })?;
                }
            }
        }
    }

    // Phase 2A.13 audit cycle-3 H4: warn once per load if we rewrote any v1
    // `Error("#NULL!") + formula` cells to Pending. The rewrite is correct
    // for engine-produced files (where #NULL! was a stand-in for "not yet
    // evaluated") but COULD silently corrupt legitimate Excel #NULL! results
    // — the v1 wire format conflated both cases. The user should re-check
    // any formulas that legitimately produce #NULL! after this load.
    if legacy_pending_migrations > 0 {
        eprintln!(
            "warning: load_workbook {path:?} migrated {legacy_pending_migrations} v1 \
             `Error(#NULL!) + formula` cells to the v2 Pending semantic. \
             If any of those formulas were authored to produce #NULL! intentionally \
             (e.g. `=SUM(A1 B1)` with a space), their evaluated values will be lost \
             until recompute. Re-save the workbook in v2 format to remove this ambiguity."
        );
    }

    Ok(wb)
}

/// Read the actual `chunk_rows` from a sheet. Audit H5 fix (2026-05-12): uses the
/// `Sheet::chunk_rows()` accessor (added in W5-7) so the envelope reflects the
/// real layout instead of the env default.
fn sheet_chunk_rows(sheet: &Sheet) -> u32 {
    sheet.chunk_rows()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn cell(row: u32, col: u32, v: Value) -> ((SheetId, RowId, ColId), Value) {
        ((0, row, col), v)
    }

    fn wb_with(name: &str, cells: &[((SheetId, RowId, ColId), Value)]) -> Workbook {
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet(name);
        for ((_s, r, c), v) in cells {
            wb.put_at(sheet_id, *r, *c, v.clone());
        }
        wb
    }

    // ===== save + load round-trip =====

    #[test]
    fn roundtrip_empty_workbook_one_sheet() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with("Sheet1", &[]);
        save_workbook(&wb, "test", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet_count(), 1);
        assert_eq!(loaded.sheet(0).unwrap().name(), "Sheet1");
    }

    #[test]
    fn roundtrip_with_number_cells() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with(
            "Sheet1",
            &[
                cell(0, 0, Value::Number(1.0)),
                cell(0, 1, Value::Number(2.0)),
                cell(5, 3, Value::Number(42.5)),
            ],
        );
        save_workbook(&wb, "test", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        let s = loaded.sheet(0).unwrap();
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        assert_eq!(s.read(0, 1), Value::Number(2.0));
        assert_eq!(s.read(5, 3), Value::Number(42.5));
        // Cells not written remain Blank.
        assert_eq!(s.read(10, 10), Value::Blank);
    }

    #[test]
    fn roundtrip_with_all_value_variants() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with(
            "S",
            &[
                cell(0, 0, Value::Number(42.0)),
                cell(0, 1, Value::Boolean(true)),
                cell(0, 2, Value::Boolean(false)),
                cell(0, 3, Value::Text(Arc::from("hello"))),
                cell(0, 4, Value::Error(ErrorValue::DivZero)),
                cell(0, 5, Value::Error(ErrorValue::Ref)),
                cell(0, 6, Value::Error(ErrorValue::AINotAvailable)),
            ],
        );
        save_workbook(&wb, "v", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        let s = loaded.sheet(0).unwrap();
        assert_eq!(s.read(0, 0), Value::Number(42.0));
        assert_eq!(s.read(0, 1), Value::Boolean(true));
        assert_eq!(s.read(0, 2), Value::Boolean(false));
        assert_eq!(s.read(0, 3), Value::text("hello"));
        assert_eq!(s.read(0, 4), Value::Error(ErrorValue::DivZero));
        assert_eq!(s.read(0, 5), Value::Error(ErrorValue::Ref));
        assert_eq!(s.read(0, 6), Value::Error(ErrorValue::AINotAvailable));
    }

    #[test]
    fn roundtrip_multi_sheet() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ms.qbook");

        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("First");
        let s2 = wb.add_sheet("Second");
        wb.put_at(s1, 0, 0, Value::Number(100.0));
        wb.put_at(s2, 0, 0, Value::Number(200.0));

        save_workbook(&wb, "ms", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert_eq!(loaded.sheet_count(), 2);
        assert_eq!(loaded.sheet(0).unwrap().name(), "First");
        assert_eq!(loaded.sheet(1).unwrap().name(), "Second");
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(100.0));
        assert_eq!(loaded.sheet(1).unwrap().read(0, 0), Value::Number(200.0));
    }

    #[test]
    fn roundtrip_preserves_text_with_special_chars() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.qbook");
        let s = "line1\nline2\t\"quoted\" and \\backslash and unicode: λ";
        let wb = wb_with("S", &[cell(0, 0, Value::Text(Arc::from(s)))]);
        save_workbook(&wb, "t", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.sheet(0).unwrap().read(0, 0),
            Value::Text(Arc::from(s))
        );
    }

    #[test]
    fn blank_cells_are_skipped_in_jsonl() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sparse.qbook");
        // Two distant cells with vast Blank space between.
        let wb = wb_with(
            "S",
            &[
                cell(0, 0, Value::Number(1.0)),
                cell(100, 100, Value::Number(2.0)),
            ],
        );
        save_workbook(&wb, "s", &path).unwrap();

        // Read the JSONL directly; expect exactly 2 non-empty lines.
        let jsonl = fs::read_to_string(path.join("sheets/0.jsonl")).unwrap();
        let lines: Vec<&str> = jsonl.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2, "blanks should NOT be emitted");
    }

    // ===== schema version enforcement =====

    #[test]
    fn unsupported_schema_version_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Hand-write an envelope with a bogus schema version.
        fs::write(
            path.join("workbook.toml"),
            "schema_version = 999\nname = \"x\"\nsheets = []\n",
        )
        .unwrap();

        match load_workbook(&path) {
            Err(QbookError::UnsupportedSchema { found: 999 }) => {}
            other => panic!("expected UnsupportedSchema(999), got {other:?}"),
        }
    }

    #[test]
    fn missing_workbook_toml_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.qbook");
        fs::create_dir_all(&path).unwrap();

        match load_workbook(&path) {
            Err(QbookError::MissingFile { .. }) => {}
            other => panic!("expected MissingFile, got {other:?}"),
        }
    }

    #[test]
    fn nonexistent_path_errors() {
        let path = std::path::Path::new("/nonexistent/path/does/not/exist.qbook");
        match load_workbook(path) {
            Err(QbookError::NotADirectory { .. }) => {}
            other => panic!("expected NotADirectory, got {other:?}"),
        }
    }

    #[test]
    fn malformed_jsonl_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");

        // First write a valid workbook to set up the directory structure.
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();

        // Now corrupt the sheet's JSONL.
        fs::write(path.join("sheets/0.jsonl"), "this is not json\n").unwrap();

        match load_workbook(&path) {
            Err(QbookError::MalformedCell { line: 1, .. }) => {}
            other => panic!("expected MalformedCell at line 1, got {other:?}"),
        }
    }

    /// Audit H4 regression (2026-05-12): out-of-bounds row in a JSONL cell record
    /// used to panic inside Sheet::put. Now: clean MalformedCell error with the
    /// line number and a row-bound message.
    #[test]
    fn row_over_max_row_errors_not_panics() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oob.qbook");

        // Set up a valid workbook then overwrite the JSONL with an out-of-bounds row.
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();
        // u32::MAX is well over Excel's MAX_ROW = 1_048_575.
        fs::write(
            path.join("sheets/0.jsonl"),
            "{\"row\":4294967295,\"col\":0,\"value\":{\"Number\":1.0}}\n",
        )
        .unwrap();

        match load_workbook(&path) {
            Err(QbookError::MalformedCell { detail, .. }) => {
                assert!(
                    detail.contains("MAX_ROW"),
                    "detail should mention MAX_ROW: {detail:?}"
                );
            }
            other => panic!("expected MalformedCell mentioning MAX_ROW, got {other:?}"),
        }
    }

    #[test]
    fn col_over_max_col_errors_not_panics() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oob_col.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();
        // u32::MAX > MAX_COLUMN = 16_383.
        fs::write(
            path.join("sheets/0.jsonl"),
            "{\"row\":0,\"col\":4294967295,\"value\":{\"Number\":1.0}}\n",
        )
        .unwrap();

        match load_workbook(&path) {
            Err(QbookError::MalformedCell { detail, .. }) => {
                assert!(
                    detail.contains("MAX_COLUMN"),
                    "detail should mention MAX_COLUMN: {detail:?}"
                );
            }
            other => panic!("expected MalformedCell mentioning MAX_COLUMN, got {other:?}"),
        }
    }

    /// Audit M2 regression (2026-05-12): missing sheet JSONL used to silently treat
    /// the sheet as empty. Now: MissingFile error.
    #[test]
    fn missing_sheet_jsonl_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("partial.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();

        // Delete the sheet's JSONL while keeping the envelope intact.
        fs::remove_file(path.join("sheets/0.jsonl")).unwrap();

        match load_workbook(&path) {
            Err(QbookError::MissingFile { file }) => {
                assert!(file.to_string_lossy().contains("0.jsonl"));
            }
            other => panic!("expected MissingFile for sheets/0.jsonl, got {other:?}"),
        }
    }

    /// Audit M3 regression (2026-05-12): sheet IDs in envelope must be sequential 0..N.
    /// Previously a panic; now a Result error.
    #[test]
    fn non_sequential_sheet_ids_errors_not_panics() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_ids.qbook");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Hand-write an envelope with non-sequential IDs ([0, 2] — skips 1).
        fs::write(
            path.join("workbook.toml"),
            r#"schema_version = 1
name = "x"

[[sheets]]
id = 0
name = "S0"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[sheets]]
id = 2
name = "S2"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#,
        )
        .unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join("sheets/2.jsonl"), "").unwrap();

        match load_workbook(&path) {
            Err(QbookError::NonSequentialSheetIds {
                expected: 1,
                found: 2,
            }) => {}
            other => panic!("expected NonSequentialSheetIds {{1,2}}, got {other:?}"),
        }
    }

    /// Audit H5 regression (2026-05-12): chunk_rows used to be a known lie in the
    /// envelope because no public accessor existed on Sheet. Now Sheet::chunk_rows()
    /// is the source of truth, and the envelope reflects the actual layout.
    #[test]
    fn chunk_rows_envelope_reflects_actual_sheet_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("chunks.qbook");

        // Construct a workbook where the sheet has chunk_rows = 64 (not the default
        // 16384 or env value).
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet_with_chunk_rows("Tiny", 64);
        wb.put_at(sheet_id, 0, 0, Value::Number(1.0));
        save_workbook(&wb, "x", &path).unwrap();

        let toml_str = fs::read_to_string(path.join("workbook.toml")).unwrap();
        let env: WorkbookEnvelope = toml::from_str(&toml_str).unwrap();
        assert_eq!(
            env.sheets[0].chunk_rows, 64,
            "envelope must report actual chunk_rows"
        );

        // Round-trip: the loaded sheet must report the same chunk_rows.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(sheet_id).unwrap().chunk_rows(), 64);
    }

    // ===== envelope content =====

    #[test]
    fn envelope_contains_expected_metadata() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("meta.qbook");
        let wb = wb_with("Inventory", &[cell(2, 4, Value::Number(99.0))]);
        save_workbook(&wb, "my workbook", &path).unwrap();

        let toml_str = fs::read_to_string(path.join("workbook.toml")).unwrap();
        let env: WorkbookEnvelope = toml::from_str(&toml_str).unwrap();
        assert_eq!(env.schema_version, WORKBOOK_SCHEMA_VERSION); // Phase 2A.8: now 2
        assert_eq!(env.name, "my workbook");
        assert_eq!(env.sheets.len(), 1);
        assert_eq!(env.sheets[0].name, "Inventory");
        assert_eq!(env.sheets[0].id, 0);
        // Bounds: row 2, col 4 → row_extent = 3, col_extent = 5.
        assert_eq!(env.sheets[0].row_extent, 3);
        assert_eq!(env.sheets[0].col_extent, 5);
    }

    // ===== CellWireValue conversions =====

    #[test]
    fn wire_value_blank_is_none() {
        assert!(CellWireValue::from_value(&Value::Blank).is_none());
    }

    #[test]
    fn wire_value_error_canonical_text() {
        assert_eq!(error_to_canonical_text(ErrorValue::Ref), "#REF!");
        assert_eq!(error_to_canonical_text(ErrorValue::DivZero), "#DIV/0!");
        assert_eq!(
            error_to_canonical_text(ErrorValue::AINotAvailable),
            "#AI_NOT_AVAILABLE_V1"
        );
    }

    #[test]
    fn wire_value_error_roundtrip_all_variants() {
        for e in ql_types::ErrorValue::ALL.iter() {
            let wire = CellWireValue::Error(error_to_canonical_text(*e));
            let v = wire.to_value().unwrap();
            assert_eq!(v, Value::Error(*e), "round-trip failed for {e:?}");
        }
    }

    #[test]
    fn wire_value_unknown_error_text_errors() {
        let wire = CellWireValue::Error("#NOT_A_REAL_ERROR".to_string());
        let result = wire.to_value();
        assert!(matches!(result, Err(QbookError::MalformedCell { .. })));
    }

    // ===== nan / inf handling =====

    #[test]
    fn nan_inf_become_num_error_via_value_constructor() {
        // Even if a Number(NaN) somehow got serialized (it can't from Value::number,
        // but a buggy external writer could try), to_value sanitizes via Value::number.
        let wire = CellWireValue::Number(f64::NAN);
        let v = wire.to_value().unwrap();
        assert_eq!(v, Value::Error(ErrorValue::Num));
    }

    /// Audit M6 fix (2026-05-12): file-level NaN handling. serde_json silently
    /// encodes NaN as `null`, producing files that fail to load — a silent
    /// corruption. Save-side validation rejects NaN/Inf explicitly with a
    /// NonFiniteNumber error carrying the cell coordinates.
    #[test]
    fn save_with_nan_value_errors_cleanly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nan-save.qbook");

        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("S");
        // Bypass Value::number sanitizer by using the pub enum variant directly.
        wb.put_at(sheet_id, 5, 3, Value::Number(f64::NAN));

        match save_workbook(&wb, "nan-test", &path) {
            Err(QbookError::NonFiniteNumber {
                sheet,
                row,
                col,
                value,
            }) => {
                assert_eq!(sheet, sheet_id);
                assert_eq!(row, 5);
                assert_eq!(col, 3);
                assert!(value.is_nan());
            }
            other => panic!("expected NonFiniteNumber error, got {other:?}"),
        }
        // After a failed save, the target should NOT exist (atomic-save guarantee).
        assert!(
            !path.exists(),
            "atomic-save invariant violated: target exists after failed save at {path:?}"
        );
    }

    #[test]
    fn save_with_inf_value_errors_cleanly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("inf-save.qbook");

        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("S");
        wb.put_at(sheet_id, 0, 0, Value::Number(f64::INFINITY));

        match save_workbook(&wb, "inf-test", &path) {
            Err(QbookError::NonFiniteNumber { value, .. }) => {
                assert!(value.is_infinite());
            }
            other => panic!("expected NonFiniteNumber error, got {other:?}"),
        }
        // Atomic-save invariant: target absent after failed save.
        assert!(!path.exists());
    }

    #[test]
    fn save_with_neg_inf_value_errors_cleanly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("neg-inf-save.qbook");

        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("S");
        wb.put_at(sheet_id, 0, 0, Value::Number(f64::NEG_INFINITY));

        let result = save_workbook(&wb, "neg-inf-test", &path);
        assert!(matches!(result, Err(QbookError::NonFiniteNumber { .. })));
        assert!(!path.exists());
    }

    // ===== atomic save (audit M4 fix) =====

    // ===== W5-9: formula round-trip =====

    /// W5-9: formula cells survive save → load round-trip with both the formula text
    /// AND the evaluated value preserved.
    #[test]
    fn roundtrip_formula_with_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("f.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Cell (0, 0) has a literal value.
        wb.put_at(s, 0, 0, Value::Number(5.0));
        // Cell (1, 0) has BOTH a value and a formula.
        wb.put_at(s, 1, 0, Value::Number(15.0));
        wb.put_formula(s, 1, 0, "A1 * 3");

        save_workbook(&wb, "formulas", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        // Literal cell.
        assert_eq!(loaded.sheet(s).unwrap().read(0, 0), Value::Number(5.0));
        assert!(loaded.formula_at(s, 0, 0).is_none());
        // Formula cell.
        assert_eq!(loaded.sheet(s).unwrap().read(1, 0), Value::Number(15.0));
        assert_eq!(
            loaded.formula_at(s, 1, 0).map(|s| s.as_ref()),
            Some("A1 * 3")
        );
    }

    #[test]
    fn roundtrip_formula_only_cell_outside_bounds() {
        // A formula cell at (100, 100) where the sheet's value-bounds extent is (0, 0)
        // — pure formula-only state. Should survive round-trip via the formula-positions
        // emit path.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fonly.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 100, 100, "SUM(A:A)");
        // Note: NO put_at for (100, 100). bounds stays at (0, 0).

        save_workbook(&wb, "fonly", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert_eq!(
            loaded.formula_at(s, 100, 100).map(|s| s.as_ref()),
            Some("SUM(A:A)")
        );
        // Phase 2A.8 audit M11: formula-only Blank cells round-trip via the
        // Pending wire variant, which decodes to Value::Blank (was: #NULL!
        // sentinel, which conflated with a real spreadsheet error).
        assert_eq!(loaded.sheet(s).unwrap().read(100, 100), Value::Blank);
    }

    #[test]
    fn roundtrip_multiple_formulas_across_sheets() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("multi-f.qbook");

        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Sheet1");
        let s2 = wb.add_sheet("Sheet2");
        wb.put_at(s1, 0, 0, Value::Number(1.0));
        wb.put_formula(s1, 0, 0, "1");
        wb.put_at(s2, 5, 5, Value::Number(99.0));
        wb.put_formula(s2, 5, 5, "B5 + 1");

        save_workbook(&wb, "multi", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert_eq!(loaded.formula_count(), 2);
        assert_eq!(loaded.formula_at(s1, 0, 0).map(|s| s.as_ref()), Some("1"));
        assert_eq!(
            loaded.formula_at(s2, 5, 5).map(|s| s.as_ref()),
            Some("B5 + 1")
        );
    }

    #[test]
    fn old_schema_v1_files_without_formula_field_load_as_literal_only() {
        // Backwards-compat: a CellRecord JSON missing the `formula` field (old W5-6
        // schema-v1-format files) deserializes with formula = None via serde default.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        fs::write(
            path.join("workbook.toml"),
            r#"schema_version = 1
name = "legacy"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 1
col_extent = 1
"#,
        )
        .unwrap();
        // No `formula` field — emulates the W5-6 format.
        fs::write(
            path.join("sheets/0.jsonl"),
            "{\"row\":0,\"col\":0,\"value\":{\"Number\":7.0}}\n",
        )
        .unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(7.0));
        assert!(loaded.formula_at(0, 0, 0).is_none());
        assert_eq!(loaded.formula_count(), 0);
    }

    /// Audit M4 acceptance (2026-05-12): a successful save replaces the target
    /// atomically via a sibling temp dir + rename. No temp leftover after success.
    #[test]
    fn atomic_save_leaves_no_temp_or_backup_after_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("atomic.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "atomic-test", &path).unwrap();
        assert!(path.exists(), "target should exist after save");

        // Phase 2A.8: after a successful save, neither `<base>.tmp-save-*`
        // nor `<base>.bak-*` sibling should remain.
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        let parent = path.parent().unwrap();
        for entry in std::fs::read_dir(parent).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(&format!("{basename}.tmp-save-")),
                "found leftover temp sibling: {name}"
            );
            assert!(
                !name.starts_with(&format!("{basename}.bak-")),
                "found leftover backup sibling: {name}"
            );
        }
    }

    /// Phase 2A.8 (was Audit M4): a failed save does NOT clobber the existing
    /// target. Pre-populate target with one workbook, then attempt to save a
    /// NaN-bearing workbook (which the save-side NaN guard will reject). The
    /// pre-existing target must remain readable and unchanged.
    #[test]
    fn failed_save_does_not_clobber_target() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preserved.qbook");

        // First, write a valid workbook with known content.
        let original = wb_with("S", &[cell(0, 0, Value::Number(42.0))]);
        save_workbook(&original, "first", &path).unwrap();
        assert!(path.exists());

        // Attempt a save that will fail (NaN-bearing).
        let mut bad_wb = Workbook::new();
        let sheet_id = bad_wb.add_sheet("S");
        bad_wb.put_at(sheet_id, 0, 0, Value::Number(f64::NAN));
        let result = save_workbook(&bad_wb, "bad", &path);
        assert!(result.is_err(), "expected save to fail");

        // Target must still exist with the original content.
        assert!(path.exists(), "target was clobbered by failed save");
        let reloaded = load_workbook(&path).unwrap();
        assert_eq!(reloaded.sheet(0).unwrap().read(0, 0), Value::Number(42.0));

        // No orphan temp/backup siblings.
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        let parent = path.parent().unwrap();
        for entry in std::fs::read_dir(parent).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(&format!("{basename}.tmp-save-"))
                    && !name.starts_with(&format!("{basename}.bak-")),
                "found orphan sibling: {name}"
            );
        }
    }

    /// Phase 2A.8 audit H2 recovery test — roll-forward case. Simulate a
    /// crash after step 3 (rename temp → target succeeded) but before step 4
    /// (backup cleanup): an orphan `.bak-*` sibling exists, AND the target is
    /// a valid workbook. Recovery should clean up the orphan and load the
    /// target normally.
    ///
    /// Phase 2A.13 audit cycle-3 H1 update: the orphan also needs the
    /// `.atomic-save-marker-v1` file inside it; otherwise recovery treats it
    /// as a user-created sibling and leaves it alone.
    #[test]
    fn load_recovers_orphan_backup_when_target_valid_roll_forward() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rollforward.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(7.0))]);
        save_workbook(&wb, "rollforward", &path).unwrap();

        // Manually create an orphan .bak-* sibling alongside the (valid)
        // target. Loader should detect and remove it.
        let bak = path.parent().unwrap().join(format!(
            "{}.bak-deadbeef",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&bak).unwrap();
        fs::write(bak.join("workbook.toml"), "garbage that won't parse").unwrap();
        // H1: mark this orphan as engine-owned so recovery acts on it.
        fs::write(bak.join(ATOMIC_SAVE_MARKER_FILENAME), "engine-owned").unwrap();
        assert!(bak.exists());

        // Load: should succeed AND clean up the orphan.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(7.0));
        assert!(!bak.exists(), "load should have cleaned up the orphan .bak");
    }

    /// Phase 2A.13 audit cycle-3 H1: a user-created sibling directory whose
    /// name happens to match the `.bak-*` prefix is NOT engine-owned and
    /// recovery must leave it alone. Closes the megaudit's `book.qbook.bak-
    /// 2025-review` data-loss vector.
    #[test]
    fn load_does_not_touch_user_created_sibling_lacking_marker() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("user-sibling.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(42.0))]);
        save_workbook(&wb, "user-sibling", &path).unwrap();

        // Plant a user-created sibling matching the .bak-* prefix but
        // lacking the engine marker. Could be a manual backup the user
        // made, e.g. `mybook.qbook.bak-2025-review/`.
        let user_sibling = path.parent().unwrap().join(format!(
            "{}.bak-2025-review",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&user_sibling).unwrap();
        fs::write(user_sibling.join("notes.md"), "my own backup, don't touch").unwrap();
        assert!(!is_engine_owned_backup(&user_sibling));

        // Load: succeeds, leaves the user's sibling intact.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(42.0));
        assert!(
            user_sibling.exists(),
            "recovery must NOT touch user-created marker-less siblings"
        );
        assert_eq!(
            fs::read_to_string(user_sibling.join("notes.md")).unwrap(),
            "my own backup, don't touch"
        );
    }

    /// Phase 2A.8 audit H2 recovery test — rollback case. Simulate a crash
    /// after step 2 (target renamed to backup) but before step 3 (temp →
    /// target completed): backup exists with a valid envelope, target does
    /// not exist. Recovery should rename the backup back to the target.
    #[test]
    fn load_recovers_orphan_backup_when_target_missing_rollback() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rollback.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(99.0))]);
        save_workbook(&wb, "rollback", &path).unwrap();

        // Simulate the post-step-2 state: rename the valid target to a .bak.
        let bak = path.parent().unwrap().join(format!(
            "{}.bak-deadbeef",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::rename(&path, &bak).unwrap();
        assert!(bak.exists());
        assert!(!path.exists(), "target should be temporarily missing");

        // Load: recovery rolls back from .bak to target, then loads normally.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(99.0));
        assert!(path.exists(), "target should exist after recovery");
        assert!(!bak.exists(), "backup should be consumed by rollback");
    }

    /// Phase 2A.13 audit cycle-3 M6: multiple orphan `.bak-*` siblings WITH a
    /// valid target are all stale (the most-recent successful save left a
    /// valid target; any older backups failed step-4 cleanup). Clean them
    /// all up; the load succeeds. Previously refused with InvalidPath,
    /// creating a permanent deadlock under repeated step-4 failures.
    #[test]
    fn load_cleans_all_orphans_when_target_valid_post_2a13() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("multi-stale.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "multi-stale", &path).unwrap();

        // Plant TWO engine-owned orphan .bak-* siblings.
        let parent = path.parent().unwrap();
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        let baks: Vec<_> = ["aaa", "bbb"]
            .iter()
            .map(|tag| {
                let bak = parent.join(format!("{basename}.bak-{tag}"));
                fs::create_dir_all(&bak).unwrap();
                fs::write(bak.join(ATOMIC_SAVE_MARKER_FILENAME), "engine-owned").unwrap();
                bak
            })
            .collect();

        // Load: target is valid → both orphans get cleaned, load succeeds.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(1.0));
        for bak in &baks {
            assert!(!bak.exists(), "orphan {bak:?} should have been cleaned up");
        }
    }

    /// Phase 2A.13 audit cycle-3 M6: multi-orphan case WITH a missing/invalid
    /// target remains genuinely ambiguous (which backup matches the missing
    /// target?). Refuse to load with InvalidPath so the user resolves
    /// manually. Verifies the narrowed refusal condition.
    #[test]
    fn load_refuses_when_multiple_orphans_and_target_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ambiguous-missing.qbook");

        // Plant two engine-owned orphans BUT no target.
        let parent = path.parent().unwrap();
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        for tag in ["aaa", "bbb"] {
            let bak = parent.join(format!("{basename}.bak-{tag}"));
            fs::create_dir_all(&bak).unwrap();
            fs::write(bak.join(ATOMIC_SAVE_MARKER_FILENAME), "engine-owned").unwrap();
        }

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::InvalidPath { .. })),
            "expected InvalidPath for ambiguous recovery, got {result:?}"
        );
    }

    /// Phase 2A.8 audit M10: per-save random suffix means concurrent saves
    /// from two threads don't share temp/backup paths. Direct test of the
    /// suffix generator running quickly in sequence (simulating the
    /// concurrent case): two consecutive calls produce distinct suffixes.
    #[test]
    fn save_session_suffix_is_distinct_per_call() {
        let s1 = save_session_suffix();
        // A small sleep to ensure the nanos differ on platforms with coarser
        // clock resolution.
        std::thread::sleep(std::time::Duration::from_nanos(1));
        let s2 = save_session_suffix();
        assert_ne!(s1, s2, "save_session_suffix must produce unique values");
    }

    /// Phase 2A.13 audit cycle-3 H5: save refuses if the target path exists
    /// but is a regular file (not a directory). Prior behavior would have
    /// silently renamed the user's file to `.bak-<suffix>` and installed
    /// the workbook directory in its place, orphaning the user's file.
    #[test]
    fn save_refuses_when_target_is_a_regular_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("conflict.qbook");
        // Plant a regular file at the target path. (The user's mistake;
        // the engine doesn't enforce that `.qbook` paths are directories.)
        fs::write(&path, b"this is a regular file, not a workbook").unwrap();
        assert!(path.is_file());

        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        let result = save_workbook(&wb, "conflict", &path);
        match result {
            Err(QbookError::InvalidPath { path: p, reason }) => {
                assert_eq!(p, path);
                assert!(reason.contains("not a directory"));
            }
            other => panic!("expected InvalidPath, got {other:?}"),
        }
        // The user's file is intact.
        assert!(path.is_file());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "this is a regular file, not a workbook"
        );
    }

    /// Phase 2A.8 audit M9 (deny_unknown_fields): a workbook.toml with an
    /// unrecognized field at the envelope level is rejected loudly.
    #[test]
    fn load_rejects_unknown_envelope_field() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("extra-field.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "extra", &path).unwrap();

        // Inject an extra field into workbook.toml.
        let toml_path = path.join("workbook.toml");
        let mut contents = fs::read_to_string(&toml_path).unwrap();
        contents.push_str("\nunknown_future_field = \"hello\"\n");
        fs::write(&toml_path, contents).unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::TomlDe(_))),
            "expected TomlDe error for unknown envelope field, got {result:?}"
        );
    }

    /// Phase 2A.8 audit M12: NameTable round-trips through save/load.
    #[test]
    fn name_table_round_trip_through_save_load() {
        use std::sync::Arc;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("names.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(7.0));
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        wb.set_name("AnchorA1", NamedTarget::Cell(Address::new(s, 0, 0)))
            .unwrap();
        wb.set_name(
            "SalesRange",
            NamedTarget::Range(Range::new(s, 1, 0, 100, 3)),
        )
        .unwrap();
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("Revenue - Costs")))
            .unwrap();

        save_workbook(&wb, "names", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        // All four names survive.
        assert_eq!(loaded.names().len(), 4);
        assert!(matches!(
            loaded.names().lookup("TAXRATE"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        assert!(matches!(
            loaded.names().lookup("ANCHORA1"),
            Some(NamedTarget::Cell(_))
        ));
        assert!(matches!(
            loaded.names().lookup("SALESRANGE"),
            Some(NamedTarget::Range(_))
        ));
        assert!(matches!(
            loaded.names().lookup("PROFIT"),
            Some(NamedTarget::Formula(_))
        ));
    }

    // ===== W5-71 Phase 4.5.A.2 — date_system v2→v3 migration =====

    #[test]
    fn date_system_excel1900_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ds_1900.qbook");
        let mut wb = Workbook::new();
        // Default is Excel1900; verify it survives save/load.
        wb.add_sheet("S");
        assert_eq!(wb.date_system(), ql_types::DateSystem::Excel1900);
        save_workbook(&wb, "ds_1900", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.date_system(), ql_types::DateSystem::Excel1900);
    }

    #[test]
    fn date_system_excel1904_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ds_1904.qbook");
        let mut wb = Workbook::new();
        wb.set_date_system(ql_types::DateSystem::Excel1904);
        wb.add_sheet("S");
        save_workbook(&wb, "ds_1904", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.date_system(), ql_types::DateSystem::Excel1904);
    }

    #[test]
    fn v2_envelope_missing_date_system_loads_as_excel1900() {
        // Hand-craft a v2 envelope without the new field; expect the v3
        // reader to default-load as Excel1900.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v2.qbook");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::create_dir_all(path.join("sheets")).unwrap();
        let v2_toml = r#"
schema_version = 2
name = "legacy_v2"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        std::fs::write(path.join("workbook.toml"), v2_toml).unwrap();
        // Empty sheet JSONL.
        std::fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        // Engine-owned marker (so recovery passes).
        std::fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        // Default date_system on missing field is Excel1900.
        assert_eq!(loaded.date_system(), ql_types::DateSystem::Excel1900);
    }

    #[test]
    fn date_system_wire_round_trip() {
        // Pure type-level test: wire enum round-trips runtime enum.
        for ds in [
            ql_types::DateSystem::Excel1900,
            ql_types::DateSystem::Excel1904,
        ] {
            let wire = DateSystemWire::from_runtime(ds);
            assert_eq!(wire.to_runtime(), ds);
        }
    }

    // ===== W5-81 Phase 4.5.D part 5 — formats + overlay v3→v4 migration =====

    #[test]
    fn empty_format_table_round_trips_without_persisting_builtins() {
        // A fresh workbook has the pre-seeded built-ins in its FormatTable
        // but no CUSTOM entries. Save should omit the `formats` section
        // entirely so v3-style envelopes still produce minimal TOML.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty_formats.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        save_workbook(&wb, "empty_formats", &path).unwrap();
        // Round-trip: built-ins still present after load.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId(14)),
            Some("m/d/yyyy")
        );
        // The TOML envelope should NOT contain a `[formats]` table (built-
        // ins aren't persisted; the section is None when empty).
        let toml_str = std::fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(
            !toml_str.contains("[formats]") && !toml_str.contains("formats ="),
            "envelope must omit empty formats section, got:\n{toml_str}"
        );
    }

    #[test]
    fn custom_format_round_trips_through_save_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("custom_formats.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        // Intern two custom formats.
        let id_a = wb.formats_mut().intern("\"⚓\" #,##0.00");
        let id_b = wb.formats_mut().intern("0.0000");
        assert_eq!(id_a.0, ql_storage::FIRST_CUSTOM_FORMAT_ID);
        assert_eq!(id_b.0, ql_storage::FIRST_CUSTOM_FORMAT_ID + 1);
        save_workbook(&wb, "custom_formats", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        // Both custom entries survive.
        assert_eq!(loaded.formats().lookup(id_a), Some("\"⚓\" #,##0.00"));
        assert_eq!(loaded.formats().lookup(id_b), Some("0.0000"));
        // Built-ins still present too.
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId(0)),
            Some("General")
        );
    }

    #[test]
    fn per_sheet_format_overlay_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("overlay.qbook");
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("A");
        let s1 = wb.add_sheet("B");
        // Bind cells on both sheets to different built-in ids.
        wb.sheet_mut(s0)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, ql_storage::FormatId(14)); // m/d/yyyy
        wb.sheet_mut(s0)
            .unwrap()
            .format_overlay_mut()
            .set(3, 5, ql_storage::FormatId(4)); // #,##0.00
        wb.sheet_mut(s1)
            .unwrap()
            .format_overlay_mut()
            .set(10, 20, ql_storage::FormatId(49)); // @
        save_workbook(&wb, "overlay", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        // Sheet A overlay round-trips.
        assert_eq!(
            loaded.sheet(s0).unwrap().format_overlay().get(0, 0),
            Some(ql_storage::FormatId(14))
        );
        assert_eq!(
            loaded.sheet(s0).unwrap().format_overlay().get(3, 5),
            Some(ql_storage::FormatId(4))
        );
        // Sheet B overlay round-trips.
        assert_eq!(
            loaded.sheet(s1).unwrap().format_overlay().get(10, 20),
            Some(ql_storage::FormatId(49))
        );
        // Sheet A doesn't see Sheet B's binding.
        assert_eq!(loaded.sheet(s0).unwrap().format_overlay().get(10, 20), None);
    }

    #[test]
    fn full_format_round_trip_custom_id_plus_overlay() {
        // Real-world path: intern a custom format, bind a cell to it,
        // round-trip, verify everything survives.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("full.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        let fmt = "\"$\"#,##0.00;[Red]\"$\"#,##0.00"; // V1 parser doesn't
                                                      // support [Red] but the parser refuses LATE; the FormatTable doesn't
                                                      // call the parser at registration — it just interns the string.
                                                      // Use a parser-friendly format here for symmetry with future tests.
        let _ = fmt; // silence unused
        let id = wb.formats_mut().intern("\"€\" #,##0.00");
        wb.sheet_mut(s).unwrap().format_overlay_mut().set(2, 1, id);
        save_workbook(&wb, "full", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        let loaded_id = loaded.sheet(s).unwrap().format_overlay().get(2, 1).unwrap();
        assert_eq!(loaded_id, id);
        assert_eq!(loaded.formats().lookup(loaded_id), Some("\"€\" #,##0.00"));
    }

    #[test]
    fn v3_envelope_missing_formats_loads_with_defaults() {
        // Hand-craft a v3-style envelope without `formats` / `format_overlay`.
        // The v4 reader must default-load it cleanly with the pre-seeded
        // built-ins + empty overlays (regression-neutral).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v3.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let v3_toml = r#"
schema_version = 3
name = "legacy_v3"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        fs::write(path.join("workbook.toml"), v3_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        // Built-ins were re-seeded by FormatTable::default().
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId(0)),
            Some("General")
        );
        // No custom entries.
        for id in ql_storage::FIRST_CUSTOM_FORMAT_ID..(ql_storage::FIRST_CUSTOM_FORMAT_ID + 10) {
            assert!(
                loaded.formats().lookup(ql_storage::FormatId(id)).is_none(),
                "v3 envelope must not produce custom format at id {id}"
            );
        }
        // Empty overlay.
        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
    }

    #[test]
    fn malformed_format_id_collision_surfaces_as_error() {
        // Hand-craft a v4 envelope that tries to re-bind id 0 (General)
        // to a different string. The loader must surface
        // `MalformedFormat`.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_format.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let bad_toml = r#"
schema_version = 4
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[formats.entries]]
id = 0
string = "NOT_GENERAL"
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::MalformedFormat { id: 0, .. })),
            "expected MalformedFormat(id=0), got {result:?}"
        );
    }

    #[test]
    fn malformed_format_overlay_out_of_range_surfaces_as_error() {
        // Hand-craft a v4 envelope with an out-of-range row in the
        // overlay. The loader must surface `MalformedFormatOverlay`.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_overlay.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // MAX_ROW is u32::MAX in `ql_types`; we use a far-too-large row.
        let row_too_big = u32::MAX;
        let bad_toml = format!(
            r#"
schema_version = 4
name = "bad_overlay"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[sheets.format_overlay]]
row = {row_too_big}
col = 0
id = 0
"#
        );
        fs::write(path.join("workbook.toml"), &bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                result,
                Err(QbookError::MalformedFormatOverlay { sheet: 0, .. })
            ),
            "expected MalformedFormatOverlay, got {result:?}"
        );
    }

    #[test]
    fn malformed_format_overlay_unregistered_id_surfaces_as_error() {
        // **W5-84 closure (Codex MEDIUM-3):** an overlay entry pointing
        // at an unregistered FormatId must surface as
        // `MalformedFormatOverlay` at load — not silently bind through
        // to a render-time General fallback.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("phantom_id_overlay.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // id 999 is NOT pre-populated as a built-in and not in any
        // `[[formats.entries]]` section, so it should never be bindable
        // by the loader. Mirrors runtime / replay's contract.
        let bad_toml = r#"
schema_version = 4
name = "phantom_id"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[sheets.format_overlay]]
row = 0
col = 0
id = 999
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                result,
                Err(QbookError::MalformedFormatOverlay {
                    sheet: 0,
                    row: 0,
                    col: 0,
                    why: "format id not registered in FormatTable",
                })
            ),
            "expected MalformedFormatOverlay(unregistered id), got {result:?}"
        );
    }

    /// Phase 2A.8 audit M11: a formula-bearing cell with Blank value
    /// round-trips through the new `Pending` wire variant. On load, the
    /// formula is preserved and the cell value is Blank (Pending decodes to
    /// Blank); recompute would resolve it.
    #[test]
    fn formula_only_cell_round_trips_as_pending() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("pending.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Cell with a formula but no evaluated value yet (Value::Blank).
        wb.put_formula(s, 5, 3, "1 + 1");
        save_workbook(&wb, "pending", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.formula_at(s, 5, 3).map(|s| s.as_ref()),
            Some("1 + 1")
        );
        // Pending decodes to Blank — recompute would resolve to 2.0.
        assert_eq!(loaded.read(Address::new(s, 5, 3)), Value::Blank);
    }

    /// Phase 2A.8 backward-compat test: a hand-crafted v1 envelope (no `names`
    /// section, legacy `Error("#NULL!")` placeholder for formula-bearing Blank
    /// cells) loads cleanly on the v2 reader. The legacy `#NULL!` + formula
    /// combo gets rewritten to the Pending semantic on load.
    #[test]
    fn v1_envelope_loads_on_v2_reader_with_legacy_pending_rewrite() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-compat.qbook");

        // Manually build a v1 workbook directory:
        //   workbook.toml: schema_version = 1, no `names` section
        //   sheets/0.jsonl: a literal cell + a formula-bearing Blank
        //     cell encoded as Error("#NULL!") (the v1 legacy encoding).
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 1
name = "legacy-v1"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 1
col_extent = 1
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        let jsonl = "{\"row\":0,\"col\":0,\"value\":{\"Number\":42.0}}\n\
                     {\"row\":5,\"col\":3,\"value\":{\"Error\":\"#NULL!\"},\"formula\":\"1 + 1\"}\n";
        fs::write(path.join("sheets").join("0.jsonl"), jsonl).unwrap();

        let loaded = load_workbook(&path).unwrap();

        // Literal cell intact.
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(42.0));

        // Legacy formula-bearing #NULL! rewritten to Pending semantic:
        // cell value is Blank, formula text preserved.
        assert_eq!(loaded.read(Address::new(0, 5, 3)), Value::Blank);
        assert_eq!(
            loaded.formula_at(0, 5, 3).map(|s| s.as_ref()),
            Some("1 + 1")
        );

        // v1 envelope had no names section → NameTable empty.
        assert!(loaded.names().is_empty());
    }

    /// Phase 2A.8 forward-compat: a hand-crafted envelope with an unknown
    /// schema version is rejected via the existing UnsupportedSchema path.
    /// No silent forward compat. **W5-81 (Phase 4.5.D part 5):** updated
    /// from version 4 to version 5 after v4 became the current ship
    /// version (adding FormatTable + per-sheet format overlay).
    /// **W5-92 (Phase 4.6.D):** updated from version 5 to version 6 after
    /// v5 became the current ship version (adding `NamedEntry.scope`
    /// for sheet-scoped names).
    #[test]
    fn future_schema_version_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("future.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "future"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::UnsupportedSchema { found: 6 })),
            "expected UnsupportedSchema, got {result:?}"
        );
    }

    /// Phase 2A.8 audit H2 crash-window simulation. Verify the documented
    /// invariant: at every step boundary in the save protocol, at least one
    /// of {target, `<target>.bak-*`} contains a complete valid workbook.
    ///
    /// Strategy: factor the save into discrete observable states by reaching
    /// inside the protocol via the same `make_save_paths` + write helpers
    /// that production save uses. At each step boundary, verify on-disk
    /// state then run `load_workbook` (which invokes `recover_from_crashed_save`)
    /// and confirm the recovery produces a usable workbook.
    #[test]
    fn crash_window_at_every_step_recovers_a_valid_workbook() {
        // Build a baseline workbook on disk first.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-sim.qbook");
        let original = wb_with("S", &[cell(0, 0, Value::Number(100.0))]);
        save_workbook(&original, "v1", &path).unwrap();
        let original_v1_value = Value::Number(100.0);

        // Now simulate a second save that crashes at each step. The "new"
        // workbook would have a different value; on recovery we should
        // always be able to load *something* coherent.
        let new_wb = wb_with("S", &[cell(0, 0, Value::Number(200.0))]);

        // --- Step 1 crash: temp dir exists, target intact ---
        {
            let paths = make_save_paths(&path).unwrap();
            write_workbook_to_dir(&new_wb, "v2", &paths.temp).unwrap();
            // Simulated crash. The temp dir is orphaned, but the target is
            // intact and there's no .bak yet, so recovery is a no-op and load
            // returns the original.
            let loaded = load_workbook(&path).unwrap();
            assert_eq!(loaded.read(Address::new(0, 0, 0)), original_v1_value);
            // Cleanup the orphan temp dir before the next sub-test.
            fs::remove_dir_all(&paths.temp).unwrap();
        }

        // --- Step 2 crash: target renamed to .bak, no target, temp pending ---
        {
            let paths = make_save_paths(&path).unwrap();
            write_workbook_to_dir(&new_wb, "v2", &paths.temp).unwrap();
            fs::rename(&path, &paths.backup).unwrap();
            // Simulated crash AFTER step 2. Target missing; .bak holds the
            // original. Recovery should roll back.
            assert!(!path.exists());
            let loaded = load_workbook(&path).unwrap();
            assert_eq!(loaded.read(Address::new(0, 0, 0)), original_v1_value);
            // After rollback recovery, the original is back at `path`. Cleanup
            // the orphan temp dir.
            assert!(path.exists());
            fs::remove_dir_all(&paths.temp).unwrap();
        }

        // --- Step 3 crash: target installed (new), backup exists, awaiting cleanup ---
        {
            let paths = make_save_paths(&path).unwrap();
            write_workbook_to_dir(&new_wb, "v2", &paths.temp).unwrap();
            fs::rename(&path, &paths.backup).unwrap();
            fs::rename(&paths.temp, &path).unwrap();
            // Simulated crash AFTER step 3. Both target (new) and .bak (old)
            // exist. Recovery should roll FORWARD (target is valid; clean up
            // the orphan .bak).
            let loaded = load_workbook(&path).unwrap();
            assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(200.0));
            assert!(!paths.backup.exists(), "orphan .bak should be removed");
        }
    }

    // ===== Phase 2A.3.c — save_workbook_extending =====

    #[test]
    fn save_workbook_extending_writes_sidecar_into_target() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sidecar.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(7.0))]);

        save_workbook_extending(&wb, "sidecar", &path, |temp_dir| {
            fs::write(temp_dir.join("custom.bin"), b"hello").map_err(QbookError::Io)
        })
        .unwrap();

        // The workbook persisted normally.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(7.0));
        // And the sidecar moved with the atomic rename.
        assert!(path.join("custom.bin").is_file());
        assert_eq!(fs::read(path.join("custom.bin")).unwrap(), b"hello");
    }

    #[test]
    fn save_workbook_extending_closure_failure_cleans_temp_and_preserves_target() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("closure-fail.qbook");
        // Seed with an initial workbook so we can verify the failed save
        // doesn't perturb it.
        let original = wb_with("S", &[cell(0, 0, Value::Number(100.0))]);
        save_workbook(&original, "v1", &path).unwrap();

        // Attempt a save_workbook_extending where the closure fails. The
        // protocol should clean up the temp dir and leave the target
        // unchanged.
        let new_wb = wb_with("S", &[cell(0, 0, Value::Number(200.0))]);
        let result = save_workbook_extending(&new_wb, "v2", &path, |_| {
            Err(QbookError::InvalidPath {
                path: PathBuf::from("/synthetic"),
                reason: "synthetic-closure-failure",
            })
        });
        assert!(
            matches!(
                result,
                Err(QbookError::InvalidPath {
                    reason: "synthetic-closure-failure",
                    ..
                })
            ),
            "expected synthetic closure-failure error, got {result:?}"
        );

        // Original target still has v1 values.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(100.0));
        // No orphan temp dir lingering. The temp suffix is random per call,
        // so glob the parent for .tmp-save-* directories — none should match.
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-save-"))
            .collect();
        assert!(
            entries.is_empty(),
            "expected no .tmp-save-* orphans, got {entries:?}"
        );
    }

    // ===== W5-92 (Phase 4.6.D) sheet-scoped names + schema v5 =====

    #[test]
    fn schema_version_constant_is_five() {
        // Sanity check so future bumps trip this test until the doc is updated.
        assert_eq!(WORKBOOK_SCHEMA_VERSION, 5);
    }

    #[test]
    fn sheet_scoped_name_round_trips_through_save_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("scoped.qbook");
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S1");
        let s1 = wb.add_sheet("S2");
        // Workbook-scoped name.
        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        // Sheet-scoped names — different sheets can hold the same name.
        wb.sheet_mut(s0)
            .unwrap()
            .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        wb.sheet_mut(s1)
            .unwrap()
            .set_scoped_name("Bonus", NamedTarget::Constant(Value::Number(100.0)))
            .unwrap();

        save_workbook(&wb, "scoped", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert!(matches!(
            loaded.names().lookup_ci("Rate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.05
        ));
        assert!(matches!(
            loaded.sheet(s0).unwrap().scoped_names().lookup_ci("Rate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        assert!(matches!(
            loaded.sheet(s1).unwrap().scoped_names().lookup_ci("Bonus"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 100.0
        ));
        // Cross-checks: sheet 1 has no "Rate"; sheet 0 has no "Bonus".
        assert!(loaded
            .sheet(s1)
            .unwrap()
            .scoped_names()
            .lookup_ci("Rate")
            .is_none());
        assert!(loaded
            .sheet(s0)
            .unwrap()
            .scoped_names()
            .lookup_ci("Bonus")
            .is_none());
    }

    #[test]
    fn v4_envelope_missing_scope_loads_into_workbook_scope() {
        // Hand-craft a v4 envelope with a `names` entry that has no
        // `scope` field. The v5 reader must default `scope: None` and
        // assign the name to the workbook scope (regression-neutral
        // for pre-v5 files).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v4.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let v4_toml = r#"
schema_version = 4
name = "legacy_v4"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[names]
entries = [
  { name = "Legacy", target = { kind = "constant", value = { Number = 1.5 } } },
]
"#;
        fs::write(path.join("workbook.toml"), v4_toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert!(matches!(
            loaded.names().lookup_ci("Legacy"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 1.5
        ));
        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
    }

    #[test]
    fn load_rejects_scoped_name_referencing_unknown_sheet() {
        // A hand-crafted v5 envelope with a scoped entry pointing at a
        // non-existent sheet must surface MalformedName, not silently
        // create the sheet or drop the name.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_scope.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 5
name = "bad_scope"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[names]
entries = [
  { name = "X", scope = 7, target = { kind = "constant", value = { Number = 1.0 } } },
]
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                &result,
                Err(QbookError::MalformedName { name, .. }) if name == "X"
            ),
            "expected MalformedName for X, got {result:?}"
        );
    }

    #[test]
    fn workbook_only_names_round_trip_serializes_without_scope_field() {
        // Wire-compat check: when no sheet-scoped names exist, the
        // serialized names entries should NOT emit a `scope` field
        // (Option::is_none + skip_serializing_if). Round-tripping
        // through the v4-style on-disk shape lets v4 readers load v5
        // files cleanly when no sheet-scoped names are present.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("wb_only.qbook");
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        wb.set_name("R", NamedTarget::Constant(Value::Number(0.5)))
            .unwrap();
        save_workbook(&wb, "wb_only", &path).unwrap();

        // Read the workbook.toml and verify no `scope =` appears.
        let toml = fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(
            !toml.contains("scope ="),
            "expected workbook-only names to omit scope field, got: {toml}"
        );

        let loaded = load_workbook(&path).unwrap();
        assert!(matches!(
            loaded.names().lookup_ci("R"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.5
        ));
    }
}
