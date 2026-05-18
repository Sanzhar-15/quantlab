//! Phase 2A.3.c (2026-05-12) — `.qbook/` ↔ op-log persistence.
//!
//! Adds `oplog.bin` as a sidecar file inside the `.qbook/` directory. The
//! sidecar is written by `save_workbook_with_oplog` using the closure-based
//! extension hook `ql_io::save_workbook_extending`, so it rides the same
//! atomic-rename protocol as the envelope + sheet JSONLs. Crash recovery
//! works transparently — `oplog.bin` lives inside the backup directory
//! alongside the rest and recovers via `recover_from_crashed_save`.
//!
//! ## Sidecar filename
//!
//! `oplog.bin` — binary `Loro::ExportMode::Snapshot` blob (per
//! [`OpLog::export_bytes`]). Versioning is handled inside the Loro snapshot
//! format; this layer is content-agnostic.
//!
//! ## Documented behavior
//!
//! - `save_workbook_with_oplog` writes BOTH the workbook AND `oplog.bin`.
//!   Any previously-present `oplog.bin` in the target is overwritten.
//! - `load_workbook_with_oplog` reads BOTH. If `oplog.bin` is missing,
//!   returns [`PersistenceError::Qbook(QbookError::MissingFile {..})`] —
//!   no silent fallback to an empty op log per the no-fallbacks rule.
//! - The plain `ql_io::save_workbook` (no oplog parameter) DROPS any
//!   existing `oplog.bin` in the target. Callers that want to keep history
//!   MUST use `save_workbook_with_oplog`. Loud: pinned by the test
//!   `save_workbook_drops_existing_oplog_bin`.
//! - The plain `ql_io::load_workbook` ignores any `oplog.bin` that's
//!   present (returns the workbook only). Forward-compatible: a v2 reader
//!   without op-log support can still read a workbook saved with an op log.

use std::fs;
use std::path::Path;

use ql_io::{load_workbook, save_workbook_extending, QbookError};
use ql_storage::Workbook;
use thiserror::Error;

use crate::log::OpLog;
use crate::OpLogError;

/// Filename used for the op-log sidecar inside a `.qbook/` directory.
pub const OPLOG_FILENAME: &str = "oplog.bin";

/// Combined error type for the persistence functions in this module. Wraps
/// both [`QbookError`] (from the underlying workbook persistence) and
/// [`OpLogError`] (from Loro snapshot encode/decode).
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum PersistenceError {
    /// Workbook persistence layer error (I/O, schema, malformed cell, etc.).
    #[error("workbook persistence error: {0}")]
    Qbook(#[from] QbookError),

    /// Op-log encode/decode error (Loro internal, serde_json, etc.).
    #[error("op log error: {0}")]
    OpLog(#[from] OpLogError),
}

/// Save a workbook AND its op log to `path` atomically. Both files land
/// together via the `.qbook/` atomic-rename protocol — there's no window in
/// which the workbook is updated but the op log isn't (or vice versa).
///
/// Overwrites any prior `oplog.bin` in the target.
pub fn save_workbook_with_oplog(
    wb: &Workbook,
    oplog: &OpLog,
    name: &str,
    path: &Path,
) -> Result<(), PersistenceError> {
    // Export the Loro snapshot bytes FIRST. Failing here (e.g., a
    // serde_json NaN/Inf rejection nested inside an Op::PutValue) surfaces
    // before we touch the filesystem.
    let bytes = oplog.export_bytes()?;

    // Hand off to ql-io. The closure writes `oplog.bin` into the temp
    // directory; the atomic rename then moves it into place with the rest
    // of the workbook.
    save_workbook_extending(wb, name, path, |temp_dir| {
        fs::write(temp_dir.join(OPLOG_FILENAME), &bytes).map_err(QbookError::Io)
    })?;
    Ok(())
}

/// Load a workbook AND its op log from `path`. Both files must be present.
///
/// Errors:
/// - [`PersistenceError::Qbook`] if the workbook itself fails to load
///   (missing envelope, schema mismatch, malformed cell, etc.).
/// - [`PersistenceError::Qbook(QbookError::MissingFile)`] specifically when
///   `oplog.bin` is missing — the caller asked for the op log; surfacing
///   the absence loudly is the no-fallbacks-rule answer.
/// - [`PersistenceError::OpLog`] if `oplog.bin` is present but Loro can't
///   decode it (corruption, version mismatch in the Loro snapshot format).
pub fn load_workbook_with_oplog(path: &Path) -> Result<(Workbook, OpLog), PersistenceError> {
    let wb = load_workbook(path)?;
    let oplog_path = path.join(OPLOG_FILENAME);
    if !oplog_path.is_file() {
        return Err(PersistenceError::Qbook(QbookError::MissingFile {
            file: oplog_path,
        }));
    }
    let bytes = fs::read(&oplog_path).map_err(QbookError::Io)?;
    let oplog = OpLog::import_bytes(&bytes)?;
    Ok((wb, oplog))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_io::CellWireValue;
    use ql_types::{Address, Value};
    use tempfile::TempDir;

    use crate::Op;

    fn fresh_workbook_with_cell() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.put_at(0, 0, 0, Value::Number(42.0));
        wb
    }

    fn oplog_with_three_ops() -> OpLog {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 1,
            value: CellWireValue::Number(43.0),
        })
        .unwrap();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 2,
            text: "A1 + B1".to_owned(),
        })
        .unwrap();
        log
    }

    #[test]
    fn save_then_load_round_trip_preserves_workbook_and_oplog() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rt.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "rt", &path).unwrap();

        let (loaded_wb, loaded_log) = load_workbook_with_oplog(&path).unwrap();
        assert_eq!(loaded_wb.read(Address::new(0, 0, 0)), Value::Number(42.0));
        assert_eq!(loaded_log.len(), oplog.len());
        let original_ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        let loaded_ops: Vec<Op> = loaded_log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(original_ops, loaded_ops);
    }

    #[test]
    fn load_with_oplog_when_oplog_missing_returns_missing_file_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nooplog.qbook");
        let wb = fresh_workbook_with_cell();
        // Save WITHOUT oplog (plain ql_io::save_workbook).
        ql_io::save_workbook(&wb, "nooplog", &path).unwrap();

        let result = load_workbook_with_oplog(&path);
        match result {
            Err(PersistenceError::Qbook(QbookError::MissingFile { file })) => {
                assert_eq!(file.file_name().and_then(|s| s.to_str()), Some("oplog.bin"));
            }
            other => panic!("expected MissingFile, got {other:?}"),
        }
    }

    #[test]
    fn load_workbook_without_oplog_ignores_present_oplog_bin() {
        // Save with oplog, then load with the plain (non-oplog) loader.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("with_oplog.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "test", &path).unwrap();

        // Plain load — no oplog returned, but the workbook is intact.
        let loaded = ql_io::load_workbook(&path).unwrap();
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(42.0));
        // And the oplog.bin file is still on disk.
        assert!(path.join(OPLOG_FILENAME).is_file());
    }

    #[test]
    fn save_workbook_without_oplog_drops_existing_oplog_bin() {
        // Documented behavior: plain save_workbook called on a path that has
        // an oplog.bin will NOT preserve it. The next load_workbook_with_oplog
        // will fail with MissingFile.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("dropped.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "v1", &path).unwrap();
        assert!(path.join(OPLOG_FILENAME).is_file());

        // Re-save with the plain function.
        let mut wb2 = Workbook::new();
        wb2.add_sheet("S");
        wb2.put_at(0, 0, 0, Value::Number(99.0));
        ql_io::save_workbook(&wb2, "v2", &path).unwrap();

        // oplog.bin is gone.
        assert!(
            !path.join(OPLOG_FILENAME).exists(),
            "save_workbook (no oplog) must drop existing oplog.bin"
        );
        // Workbook is the new one.
        let loaded = ql_io::load_workbook(&path).unwrap();
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(99.0));
    }

    #[test]
    fn save_with_oplog_overwrites_existing_oplog_bin() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("over.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog_a = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog_a, "v1", &path).unwrap();

        // New oplog with different content.
        let mut oplog_b = OpLog::new();
        oplog_b
            .append(Op::PutValue {
                sheet: 0,
                row: 5,
                col: 5,
                value: CellWireValue::Text("hello".to_owned()),
            })
            .unwrap();
        save_workbook_with_oplog(&wb, &oplog_b, "v2", &path).unwrap();

        let (_, loaded_log) = load_workbook_with_oplog(&path).unwrap();
        assert_eq!(loaded_log.len(), 1, "expected the new (1-op) log");
        let loaded_ops: Vec<Op> = loaded_log.iter().collect::<Result<_, _>>().unwrap();
        match &loaded_ops[0] {
            Op::PutValue {
                sheet,
                row,
                col,
                value,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 5, 5));
                assert_eq!(value, &CellWireValue::Text("hello".to_owned()));
            }
            other => panic!("expected PutValue, got {other:?}"),
        }
    }

    #[test]
    fn empty_oplog_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = OpLog::new();
        save_workbook_with_oplog(&wb, &oplog, "empty", &path).unwrap();

        let (_, loaded_log) = load_workbook_with_oplog(&path).unwrap();
        assert_eq!(loaded_log.len(), 0);
        assert!(loaded_log.is_empty());
    }

    #[test]
    fn load_with_oplog_when_oplog_bin_is_corrupted_returns_oplog_error() {
        // Save a valid workbook + oplog, then corrupt oplog.bin manually.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("corrupt.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "corrupt", &path).unwrap();

        // Overwrite oplog.bin with garbage.
        fs::write(path.join(OPLOG_FILENAME), b"this is not a loro snapshot").unwrap();

        let result = load_workbook_with_oplog(&path);
        assert!(
            matches!(result, Err(PersistenceError::OpLog(_))),
            "expected OpLog error for corrupted oplog.bin, got {result:?}"
        );
    }
}
