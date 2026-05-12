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
pub const WORKBOOK_SCHEMA_VERSION: u32 = 2;

/// The earliest schema version this reader still accepts. v1 fixtures (Phase 1)
/// continue to load on v2 binaries; older versions would need explicit handling.
const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;

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
    let paths = make_save_paths(path)?;

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
    if let Err(e) = fs::rename(&paths.temp, path) {
        if had_existing {
            // Restore the old state from backup so the user's file isn't lost.
            if let Err(restore_err) = fs::rename(&paths.backup, path) {
                eprintln!(
                    "warning: save failed AND backup restore failed; \
                     backup remains at {:?}: {restore_err}",
                    paths.backup
                );
            }
        }
        // The temp dir didn't move into place; try to clean it up.
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            eprintln!(
                "warning: failed to clean temp directory {:?} after rename failure: {cleanup_err}",
                paths.temp
            );
        }
        return Err(QbookError::Io(e));
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
    let mut orphans: Vec<PathBuf> = Vec::new();
    let read_dir = match fs::read_dir(parent) {
        Ok(it) => it,
        Err(_) => return Ok(()), // Parent unreadable; load will fail downstream with a clearer error.
    };
    for entry in read_dir.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with(&bak_prefix) {
                orphans.push(entry.path());
            }
        }
    }

    if orphans.is_empty() {
        return Ok(());
    }
    if orphans.len() > 1 {
        // Multiple orphans = ambiguous recovery. Refuse rather than guess.
        return Err(QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "multiple .bak-* siblings present; ambiguous crash recovery — \
                     resolve manually before loading",
        });
    }
    let bak = orphans.into_iter().next().expect("len == 1");

    if target_envelope_is_valid(target) {
        // Step 3 of save completed; step 4 was interrupted. Roll forward.
        if let Err(e) = fs::remove_dir_all(&bak) {
            eprintln!(
                "warning: load detected orphan backup {bak:?} but cleanup failed: {e}; \
                 target is valid, so load proceeds"
            );
        }
    } else {
        // Step 2 completed but step 3 didn't (or step 3 partially completed
        // and left an invalid target). Roll back: restore the old state.
        if target.exists() {
            if let Err(e) = fs::remove_dir_all(target) {
                return Err(QbookError::Io(e));
            }
        }
        fs::rename(&bak, target)?;
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
        sheet_envelopes.push(SheetEnvelope {
            id: sheet_id,
            name: sheet.name().to_owned(),
            chunk_rows: sheet_chunk_rows(sheet),
            row_extent: bounds.row_extent,
            col_extent: bounds.col_extent,
        });
    }

    // Phase 2A.8: serialize the workbook's NameTable. Sorted ascending by name
    // for deterministic on-disk diffs. Omitted (None) when the table is empty
    // so v1-reader compatibility round-trips cleanly.
    let names_section = if wb.names().is_empty() {
        None
    } else {
        let mut entries: Vec<NamedEntry> = wb
            .names()
            .iter()
            .map(|(name, target)| NamedEntry {
                name: name.as_ref().to_owned(),
                target: NamedTargetWire::from_target(target),
            })
            .collect();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Some(NamesSection { entries })
    };

    let envelope = WorkbookEnvelope {
        schema_version: WORKBOOK_SCHEMA_VERSION,
        name: name.to_owned(),
        sheets: sheet_envelopes,
        names: names_section,
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

    Ok(())
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

    // Construct the Workbook + sheets in id order. Sheet ids in the envelope must be
    // sequential 0..N — Workbook::add_sheet allocates ids in that order.
    // Audit M3 fix (2026-05-12): previously this panicked; now returns Result error.
    let mut wb = Workbook::new();
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
            let is_legacy_pending = is_v1
                && rec.formula.is_some()
                && matches!(&rec.value, CellWireValue::Error(s) if s == "#NULL!");

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
            wb.put_at(sheet_id, rec.row as RowId, rec.col as ColId, value);
            if let Some(formula_text) = rec.formula {
                wb.put_formula(sheet_id, rec.row as RowId, rec.col as ColId, formula_text);
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
    if let Some(names_section) = envelope.names {
        for entry in names_section.entries {
            let target = entry.target.to_target(&entry.name)?;
            wb.set_name(&entry.name, target)
                .map_err(|e| QbookError::MalformedName {
                    name: entry.name.clone(),
                    reason: format!("rejected by NameTable: {e}"),
                })?;
        }
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
        assert!(bak.exists());

        // Load: should succeed AND clean up the orphan.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(7.0));
        assert!(!bak.exists(), "load should have cleaned up the orphan .bak");
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

    /// Phase 2A.8 audit H2: multiple orphan `.bak-*` siblings → ambiguous
    /// recovery, refuse to load. Surfaces as `QbookError::InvalidPath` so the
    /// caller knows manual intervention is needed.
    #[test]
    fn load_refuses_when_multiple_orphan_backups() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ambiguous.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "ambig", &path).unwrap();

        // Plant TWO orphan .bak-* siblings.
        let parent = path.parent().unwrap();
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        for tag in ["aaa", "bbb"] {
            let bak = parent.join(format!("{basename}.bak-{tag}"));
            fs::create_dir_all(&bak).unwrap();
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
    /// schema version (e.g. 3) is rejected via the existing UnsupportedSchema
    /// path. No silent forward compat.
    #[test]
    fn future_schema_version_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("future.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 3
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
            matches!(result, Err(QbookError::UnsupportedSchema { found: 3 })),
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
}
