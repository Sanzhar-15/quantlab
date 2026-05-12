//! `.qbook/` workbook directory format — Phase 1 W5-6.
//!
//! Per spec Part V §3 + T2-D01 (Round 7 architectural lock). The on-disk shape:
//!
//! ```text
//! my-workbook.qbook/
//! ├── workbook.toml          # envelope: schema_version, name, sheet list, defaults
//! └── sheets/
//!     ├── 0.jsonl            # sheet 0 cells, one JSON line per non-blank cell
//!     ├── 1.jsonl
//!     └── ...
//! ```
//!
//! - **TOML envelope** (`workbook.toml`): human-readable metadata. Fits with Cargo's
//!   lineage; users can edit it by hand if needed (e.g. rename a sheet).
//! - **JSONL per sheet**: one cell per line, append-friendly, line-oriented (clean
//!   diffs in tools that don't know about the format). Blank cells are NOT emitted —
//!   the file is a sparse representation.
//! - **Per-sheet partitioning**: opening one sheet doesn't require parsing all
//!   others. Scales to multi-million-cell workbooks at the partition boundary.
//!
//! ## Schema version
//!
//! `WORKBOOK_SCHEMA_VERSION = 1`. Bump on incompatible changes. Loaders refuse
//! unknown versions per the no-fallbacks rule (no silent forward-compat).
//!
//! ## Phase 1 scope (W5-6)
//!
//! Saved: cell values (Number, Boolean, Text, Error). Blank cells skipped.
//! Sheet names + chunk_rows preserved.
//!
//! Deferred to Phase 2+ (when binder integration lands):
//! - Cell formulas (currently the Workbook only stores Values, not formulas).
//! - Named ranges (NameTable currently empty in Phase 0).
//! - Computed-overlay separation (CORR-25 deferred).
//! - Cell formatting / number formats / styles.

use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use ql_storage::{Sheet, Workbook};
use ql_types::{ColId, ErrorValue, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// On-disk schema version. Bumped on incompatible changes.
pub const WORKBOOK_SCHEMA_VERSION: u32 = 1;

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

    #[error("unsupported schema version {found} (this build supports {WORKBOOK_SCHEMA_VERSION})")]
    UnsupportedSchema { found: u32 },

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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkbookEnvelope {
    pub schema_version: u32,
    /// User-supplied workbook name. Defaults to the directory name when omitted.
    pub name: String,
    /// Per-sheet metadata in id order.
    pub sheets: Vec<SheetEnvelope>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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

/// JSONL cell record — one line per non-blank cell.
///
/// Tagged enum representation keeps the wire format compact + self-describing:
/// `{"row":5,"col":3,"value":{"Number":42.0}}`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CellRecord {
    pub row: u32,
    pub col: u32,
    pub value: CellWireValue,
}

/// Wire-format mirror of `ql_types::Value`. Phase 1 W5-6 doesn't add Serialize to
/// ql-types directly (keeps the types crate lean); ql-io owns the encoding.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum CellWireValue {
    Number(f64),
    Boolean(bool),
    Text(String),
    Error(String), // Stored as the canonical "#REF!" / "#VALUE!" / etc. text form.
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

/// Save a `Workbook` to `path` (a `.qbook/` directory). **Atomic**: writes the whole
/// workbook to a sibling temp directory, then renames it into place. If the save fails
/// partway through (disk full, OOM, JSON encode error, panic), the original target —
/// if any — is untouched. Audit M4 fix (2026-05-12).
///
/// Atomicity guarantees:
/// - **Per-file write failure**: original target intact; temp dir gets cleaned up on
///   next save attempt.
/// - **Pre-rename crash**: target intact (we haven't touched it yet).
/// - **Rename window**: when target exists, we remove it then rename the temp dir.
///   There's a microsecond window where neither path exists. POSIX `rename(2)` is
///   atomic on the same filesystem, but Rust's `fs::rename` for directories requires
///   the target to be empty or absent. Phase 2's simpler approach: remove + rename.
///   A future Phase 4+ atomic-replace with `.bak` rotation would close that window.
pub fn save_workbook(wb: &Workbook, name: &str, path: &Path) -> Result<(), QbookError> {
    // Compute the temp-dir path next to the target. Using PID + a fixed suffix gives
    // a stable name per process so concurrent saves from the same process collide loudly
    // (the first save's leftover temp gets cleaned up). Across processes, PID
    // disambiguates.
    let temp_path = sibling_temp_path(path);

    // Pre-clean any leftover from a prior interrupted save with the same temp name.
    // This is best-effort: if it fails, the create_dir_all below will surface a clear
    // error (e.g. "file exists"). We don't error here — leftover cleanup is a
    // recovery courtesy, not a correctness gate.
    if temp_path.exists() {
        let _ = fs::remove_dir_all(&temp_path);
    }

    // Write everything to the temp dir.
    let write_result = write_workbook_to_dir(wb, name, &temp_path);
    if let Err(e) = write_result {
        // Save failed mid-write. Clean up the partial temp dir so the next save starts
        // fresh, then propagate the error. The original target — if any — is intact.
        let _ = fs::remove_dir_all(&temp_path);
        return Err(e);
    }

    // Commit: replace target with the freshly-written temp dir.
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    fs::rename(&temp_path, path)?;
    Ok(())
}

/// Generate a sibling temp-dir path for atomic save. Uses the target's basename +
/// `.tmp-save-PID` suffix in the same parent directory so the rename stays on the
/// same filesystem (a precondition for atomicity on POSIX).
fn sibling_temp_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let basename = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workbook".to_string());
    parent.join(format!("{basename}.tmp-save-{}", std::process::id()))
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
    let envelope = WorkbookEnvelope {
        schema_version: WORKBOOK_SCHEMA_VERSION,
        name: name.to_owned(),
        sheets: sheet_envelopes,
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
        // Naive iteration: walk every (row, col) within bounds. Sparse cells (Blank)
        // are skipped. Phase 2 may optimize via direct chunk-walking; not on hot path.
        for row in 0..bounds.row_extent {
            for col in 0..bounds.col_extent {
                let v = sheet.read(row, col);
                // Audit M6 fix (2026-05-12): reject NaN/Inf at the save boundary.
                // serde_json silently encodes NaN as `null`, producing files that
                // fail to load — silent corruption. Validate explicitly.
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
                if let Some(wire) = CellWireValue::from_value(&v) {
                    let rec = CellRecord {
                        row,
                        col,
                        value: wire,
                    };
                    let line = serde_json::to_string(&rec)?;
                    writeln!(writer, "{line}")?;
                }
            }
        }
        writer.flush()?;
    }

    Ok(())
}

/// Load a `Workbook` from a `.qbook/` directory.
pub fn load_workbook(path: &Path) -> Result<Workbook, QbookError> {
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

    if envelope.schema_version != WORKBOOK_SCHEMA_VERSION {
        return Err(QbookError::UnsupportedSchema {
            found: envelope.schema_version,
        });
    }

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
            let value = rec.value.to_value().map_err(|e| match e {
                QbookError::MalformedCell { detail, .. } => QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail,
                },
                other => other,
            })?;
            wb.put_at(sheet_id, rec.row as RowId, rec.col as ColId, value);
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
        assert_eq!(env.schema_version, 1);
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

    /// Audit M4 acceptance (2026-05-12): a successful save replaces the target
    /// atomically via a sibling temp dir + rename. No temp leftover after success.
    #[test]
    fn atomic_save_leaves_no_temp_dir_after_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("atomic.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "atomic-test", &path).unwrap();
        assert!(path.exists(), "target should exist after save");

        // The temp-dir name follows `<basename>.tmp-save-<pid>`. After a successful
        // save, NO such directory should remain.
        let temp_path = sibling_temp_path(&path);
        assert!(
            !temp_path.exists(),
            "temp dir {temp_path:?} should be cleaned up after successful save"
        );
    }

    /// Audit M4 acceptance: a failed save does NOT clobber the existing target. Pre-
    /// populate target with one workbook, then attempt to save a NaN-bearing
    /// workbook (which serde_json will reject). The pre-existing target must
    /// remain readable and unchanged.
    #[test]
    fn atomic_save_failed_save_does_not_clobber_target() {
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

        // Temp dir from the failed save was cleaned up.
        let temp_path = sibling_temp_path(&path);
        assert!(
            !temp_path.exists(),
            "temp dir from failed save should be cleaned up"
        );
    }

    /// Audit M4 acceptance: leftover temp dir from a prior crashed save is cleaned
    /// up before the next save starts. Simulates a crash by manually creating a
    /// temp dir with the expected name.
    #[test]
    fn atomic_save_cleans_up_leftover_temp_from_prior_crash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("leftover.qbook");

        // Simulate a crashed prior save: create the temp dir with some garbage.
        let temp_path = sibling_temp_path(&path);
        fs::create_dir_all(&temp_path).unwrap();
        fs::write(temp_path.join("garbage"), "not a real workbook").unwrap();
        assert!(temp_path.exists());

        // Now do a real save. Should succeed despite the leftover temp.
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "recover", &path).unwrap();

        // Temp dir gone, target exists.
        assert!(!temp_path.exists());
        assert!(path.exists());
        let reloaded = load_workbook(&path).unwrap();
        assert_eq!(reloaded.sheet(0).unwrap().read(0, 0), Value::Number(1.0));
    }
}
