//! `.qbook/` ↔ op-log persistence.
//!
//! **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure:** this
//! module moved from `ql-oplog::persistence` to `ql-io::oplog_persistence`.
//! The move inverts the prior `ql-oplog → ql-io` dependency direction
//! so Phase 5 CRDT integration sees `ql-oplog` as a dependency floor.
//! External callers that previously imported
//! `ql_oplog::save_workbook_with_oplog` (etc.) now import from
//! `ql_io::oplog_persistence::*` (re-exported at `ql_io::*`).
//!
//! Phase 2A.3.c (2026-05-12) — original `.qbook/` ↔ op-log persistence.
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
//! [`OpLog::export_bytes`]).
//!
//! ## Phase 5.2 D-1 step 7 — Tier D3 magic-bytes header (2026-05-20)
//!
//! `oplog.bin` files written post-Tier-D3 are prefixed with an 8-byte
//! Quantlab header:
//!
//! ```text
//! offset 0..4  : OPLOG_MAGIC = b"QLOL" (Quantlab OpLog)
//! offset 4..8  : OPLOG_SCHEMA_VERSION as big-endian u32
//! offset 8..   : Loro snapshot bytes (unchanged)
//! ```
//!
//! Header purposes:
//! - **Format identification:** unambiguously distinguishes Quantlab
//!   `oplog.bin` files from arbitrary binary blobs. Loro snapshots have
//!   their own internal magic (`b"loro"`, lowercase), but it's not
//!   Quantlab-namespaced.
//! - **Forward-rejection versioning** (audit-closure correction):
//!   a future v2 reader loading a v2 file would dispatch on version;
//!   today's loader REJECTS any version it doesn't know with
//!   [`PersistenceError::OplogUnsupportedVersion`]. The version field
//!   is a discriminator + rejection gate, not yet a migration system.
//!   Per-version decode dispatch is the v2-bump-time work.
//!
//! **Legacy load path (audit-closure scope clarification):** pre-Tier-D3
//! `oplog.bin` files (no MAGIC prefix) are detected by the absence of
//! the magic and loaded as raw Loro snapshots. The Loro decoder
//! validates framing only; per-op JSON shape is checked lazily when
//! `OpLog::iter()` deserializes each op. **This means backward-compat
//! is limited to files whose ops match the CURRENT `Op` enum shape**
//! (post-step-4 FormatIdWire payloads). A pre-step-4 raw Loro file
//! (whose ops carried `Op::RegisterFormat { id: u32, ... }` instead of
//! `Op::RegisterFormat { id: FormatIdWire, ... }`) will load as a Loro
//! doc but `iter()` will fail with `OpLogError::Deserialize` on the
//! first format op. This is an explicit format-branch (NOT a silent
//! fallback) and the failure is loud. Tests:
//! - `legacy_pre_tier_d3_raw_loro_snapshot_still_loads` (this file) —
//!   pins the happy path for current-shape ops.
//! - `legacy_path_with_corrupt_loro_body_fails_loudly` (this file) —
//!   pins legacy-path Loro framing rejection.
//! - `legacy_path_with_pre_step_4_register_format_op_fails_loudly_at_iter`
//!   plus sibling tests in
//!   `crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs` (added by
//!   Phase 5.2 D-1 step 8 megaudit closure, 2026-05-20) pin the
//!   per-op-deserialize failure mode for pre-step-4 op shapes via
//!   direct LoroList JSON injection. Pre-step-4 ops surface as
//!   `OpLogError::Deserialize`, NOT silent data loss.
//!
//! **Transport-bytes vs file-bytes contract** (audit-closure clarification):
//! `OpLog::export_bytes()` and `CollabSession::export_bytes()` produce
//! RAW Loro snapshot bytes. Those are suitable for transport to other
//! peers (consumed by `CollabSession::merge_bytes` / `OpLog::merge_bytes`),
//! but NOT directly suitable as `.qbook/oplog.bin` file contents —
//! the file format requires the QLOL header. Use
//! `save_workbook_with_oplog` for file writes, never raw export bytes.
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

use crate::qbook_format::{load_workbook, save_workbook_extending, QbookError};
use ql_storage::Workbook;
use thiserror::Error;

use ql_oplog::{OpLog, OpLogError};

/// Filename used for the op-log sidecar inside a `.qbook/` directory.
pub const OPLOG_FILENAME: &str = "oplog.bin";

/// **Phase 5.2 D-1 step 7 (2026-05-20):** 4-byte magic prefix on
/// post-Tier-D3 `oplog.bin` files. ASCII `"QLOL"` (Quantlab OpLog).
/// Format-identifies the file as Quantlab-owned + version-prefixes the
/// Loro snapshot bytes that follow.
///
/// Files lacking this prefix are pre-Tier-D3 raw Loro snapshots —
/// detected by the load path and routed through the legacy decode
/// (explicit format branch; not a silent fallback).
pub const OPLOG_MAGIC: [u8; 4] = *b"QLOL";

/// **Phase 5.2 D-1 step 7 (2026-05-20):** schema version of the
/// post-Tier-D3 `oplog.bin` wrapper. Serialized as big-endian u32 at
/// offset 4..8 right after [`OPLOG_MAGIC`].
///
/// - `1` (current): Quantlab op-log header v1. Loro snapshot body
///   contains FormatIdWire-shaped `Op::RegisterFormat` + `Op::SetCellFormat`
///   payloads (post-D-1-step-4 wire shape).
///
/// Bumping this version on a future incompatible op shape gives the
/// loader an explicit forward-rejection trigger — today's behavior is
/// rejection via [`PersistenceError::OplogUnsupportedVersion`]; v2 may
/// add per-version decode dispatch (migration).
pub const OPLOG_SCHEMA_VERSION: u32 = 1;

/// **Phase 5.2 D-1 step 7 audit closure (Opus MEDIUM-2):** lowest schema
/// version this reader accepts. Mirrors `qbook_format::MIN_SUPPORTED_SCHEMA_VERSION`
/// (asymmetry fix). The version range `[OPLOG_MIN_SUPPORTED_SCHEMA_VERSION,
/// OPLOG_SCHEMA_VERSION]` is the accepted band; values outside surface
/// as [`PersistenceError::OplogUnsupportedVersion`]. Currently both
/// bounds are 1 — there's no v0 in the universe, so a v0 header is
/// always corruption.
pub const OPLOG_MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Total header length: 4 bytes magic + 4 bytes BE u32 version.
///
/// **Phase 5.2 D-1 step 7 audit closure (Opus LOW-1):** promoted to
/// `pub const` so external diagnostic tooling can sanity-check files
/// without hard-coding `8`.
pub const OPLOG_HEADER_LEN: usize = OPLOG_MAGIC.len() + std::mem::size_of::<u32>();

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

    /// **Phase 5.2 D-1 step 7 (2026-05-20):** `oplog.bin` starts with the
    /// Quantlab magic ([`OPLOG_MAGIC`]) but carries a schema version
    /// outside the accepted band `[OPLOG_MIN_SUPPORTED_SCHEMA_VERSION,
    /// OPLOG_SCHEMA_VERSION]`. Distinct from `OpLog` errors so callers
    /// can surface "future-format file written by a newer Quantlab" or
    /// "v0 reserved-as-corrupt" vs "the Loro snapshot itself is corrupt."
    ///
    /// **Audit-closure refinement (Opus MEDIUM-2):** error now carries
    /// `min` + `max` bounds so the consumer can render a precise message.
    #[error("oplog.bin schema version {found} is unsupported (this build accepts versions {min}..={max})")]
    OplogUnsupportedVersion { found: u32, min: u32, max: u32 },

    /// **Phase 5.2 D-1 step 7 (2026-05-20):** `oplog.bin` starts with
    /// the Quantlab magic but is shorter than [`OPLOG_HEADER_LEN`] (8
    /// bytes) — the version u32 can't be read. Indicates corruption or
    /// a malformed Quantlab-prefixed file.
    #[error("oplog.bin has Quantlab magic but header is truncated ({found_bytes} bytes; need {required})")]
    OplogTruncatedHeader { found_bytes: usize, required: usize },
}

/// Save a workbook AND its op log to `path` atomically. Both files land
/// together via the `.qbook/` atomic-rename protocol — there's no window in
/// which the workbook is updated but the op log isn't (or vice versa).
///
/// Overwrites any prior `oplog.bin` in the target.
///
/// **Phase 5.2 D-1 step 7 (2026-05-20):** the written `oplog.bin` is
/// prefixed with the 8-byte Tier D3 header (4-byte [`OPLOG_MAGIC`] +
/// big-endian [`OPLOG_SCHEMA_VERSION`] u32). Pre-Tier-D3 files lacked
/// the prefix; the load path detects and handles both shapes.
pub fn save_workbook_with_oplog(
    wb: &Workbook,
    oplog: &OpLog,
    name: &str,
    path: &Path,
) -> Result<(), PersistenceError> {
    // Export the Loro snapshot bytes FIRST. Failing here (e.g., a
    // serde_json NaN/Inf rejection nested inside an Op::PutValue) surfaces
    // before we touch the filesystem.
    let loro_bytes = oplog.export_bytes()?;

    // Phase 5.2 D-1 step 7: prepend the Quantlab Tier D3 header.
    // Layout: 4 bytes MAGIC + 4 bytes BE version + Loro snapshot.
    let mut bytes = Vec::with_capacity(OPLOG_HEADER_LEN + loro_bytes.len());
    bytes.extend_from_slice(&OPLOG_MAGIC);
    bytes.extend_from_slice(&OPLOG_SCHEMA_VERSION.to_be_bytes());
    bytes.extend_from_slice(&loro_bytes);

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
/// - [`PersistenceError::OplogUnsupportedVersion`] if `oplog.bin` carries
///   a Quantlab magic prefix but the schema version is beyond what this
///   build supports.
/// - [`PersistenceError::OplogTruncatedHeader`] if `oplog.bin` starts
///   with the Quantlab magic but is too short to contain the version u32.
/// - [`PersistenceError::OpLog`] if `oplog.bin` is present but Loro can't
///   decode it (corruption, version mismatch in the Loro snapshot format).
///
/// **Phase 5.2 D-1 step 7 (2026-05-20):** load handles both Tier-D3
/// headered files (post-step-7) AND pre-Tier-D3 raw Loro snapshots
/// (backward compat). Format detection is by MAGIC prefix; both paths
/// surface their own errors loudly per the no-fallbacks rule.
pub fn load_workbook_with_oplog(path: &Path) -> Result<(Workbook, OpLog), PersistenceError> {
    let wb = load_workbook(path)?;
    let oplog_path = path.join(OPLOG_FILENAME);
    if !oplog_path.is_file() {
        return Err(PersistenceError::Qbook(QbookError::MissingFile {
            file: oplog_path,
        }));
    }
    let bytes = fs::read(&oplog_path).map_err(QbookError::Io)?;
    let oplog = decode_oplog_bytes(&bytes)?;
    Ok((wb, oplog))
}

/// **Phase 5.2 D-1 step 7 (2026-05-20):** decode `oplog.bin` bytes,
/// stripping the Tier D3 header if present. Pre-Tier-D3 files (raw Loro
/// snapshots with no Quantlab prefix) decode via the legacy path.
///
/// Format detection is by the 4-byte MAGIC prefix:
/// - Bytes start with [`OPLOG_MAGIC`] → parse u32 version (bytes 4..8).
///   Reject if version > [`OPLOG_SCHEMA_VERSION`] or if bytes are
///   truncated before the version u32 fully present. Decode remainder
///   as Loro snapshot.
/// - Bytes don't start with [`OPLOG_MAGIC`] → legacy raw Loro snapshot.
///   Decode entire byte slice as Loro snapshot.
///
/// This is an explicit format branch, not a silent fallback — both
/// branches surface their own decode errors. A garbage file that lacks
/// both MAGIC and a valid Loro snapshot prefix lands in the legacy
/// branch and surfaces `OpLog(...)`.
fn decode_oplog_bytes(bytes: &[u8]) -> Result<OpLog, PersistenceError> {
    // Audit-closure (Opus LOW-2): `starts_with` is idiomatic and
    // handles the length check implicitly; no risk of panic from a
    // short slice.
    if bytes.starts_with(&OPLOG_MAGIC) {
        // Tier D3 path: header present.
        if bytes.len() < OPLOG_HEADER_LEN {
            return Err(PersistenceError::OplogTruncatedHeader {
                found_bytes: bytes.len(),
                required: OPLOG_HEADER_LEN,
            });
        }
        let mut version_bytes = [0u8; 4];
        version_bytes.copy_from_slice(&bytes[OPLOG_MAGIC.len()..OPLOG_HEADER_LEN]);
        let version = u32::from_be_bytes(version_bytes);
        // Audit-closure (Codex LOW-1 / Opus MEDIUM-2): gate the LOWER
        // bound too. version=0 is reserved-as-corrupt; mirrors
        // qbook_format's MIN_SUPPORTED_SCHEMA_VERSION pattern.
        if version < OPLOG_MIN_SUPPORTED_SCHEMA_VERSION || version > OPLOG_SCHEMA_VERSION {
            return Err(PersistenceError::OplogUnsupportedVersion {
                found: version,
                min: OPLOG_MIN_SUPPORTED_SCHEMA_VERSION,
                max: OPLOG_SCHEMA_VERSION,
            });
        }
        // Strip header; remainder is the Loro snapshot.
        let loro_bytes = &bytes[OPLOG_HEADER_LEN..];
        let oplog = OpLog::import_bytes(loro_bytes)?;
        Ok(oplog)
    } else {
        // Legacy path: pre-Tier-D3 raw Loro snapshot. Decode the whole
        // byte slice as a Loro snapshot. If the file is actually garbage
        // (doesn't start with MAGIC and isn't a valid Loro snapshot
        // either), Loro's decoder returns an error which surfaces as
        // PersistenceError::OpLog.
        //
        // **Scope limitation (audit-closure HIGH-1 documentation):**
        // Loro's decoder validates SNAPSHOT FRAMING only. The per-op JSON
        // shape is checked lazily at `OpLog::iter()` deserialize time.
        // Pre-step-4 raw Loro files (whose ops carried bare `u32` ids
        // instead of FormatIdWire) decode here cleanly as Loro docs but
        // iter() will surface `OpLogError::Deserialize` on the first
        // format op. Test
        // `legacy_path_with_pre_step_4_op_shape_fails_loudly_at_iter`
        // pins the loud-failure contract.
        let oplog = OpLog::import_bytes(bytes)?;
        Ok(oplog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_oplog::CellWireValue;
    use ql_types::{Address, Value};
    use tempfile::TempDir;

    use ql_oplog::Op;

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
        crate::save_workbook(&wb, "nooplog", &path).unwrap();

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
        let loaded = crate::load_workbook(&path).unwrap();
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
        crate::save_workbook(&wb2, "v2", &path).unwrap();

        // oplog.bin is gone.
        assert!(
            !path.join(OPLOG_FILENAME).exists(),
            "save_workbook (no oplog) must drop existing oplog.bin"
        );
        // Workbook is the new one.
        let loaded = crate::load_workbook(&path).unwrap();
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

    // ===== Phase 5.2 D-1 step 7 — Tier D3 magic header tests (2026-05-20) =====

    /// **Tier D3:** the round-trip suite already exercises save → load
    /// symmetry. This test inspects the bytes on disk to pin the
    /// post-Tier-D3 wire format: the file MUST start with
    /// `OPLOG_MAGIC` (b"QLOL") followed by the schema version as a
    /// big-endian u32.
    #[test]
    fn tier_d3_oplog_bin_starts_with_quantlab_magic_and_version_header() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("magic.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "magic", &path).unwrap();

        let bytes = fs::read(path.join(OPLOG_FILENAME)).unwrap();
        assert!(
            bytes.len() >= OPLOG_HEADER_LEN,
            "post-Tier-D3 oplog.bin must contain at least the 8-byte header"
        );
        assert_eq!(
            &bytes[..OPLOG_MAGIC.len()],
            &OPLOG_MAGIC,
            "first 4 bytes must be OPLOG_MAGIC (b\"QLOL\")"
        );
        let mut version_bytes = [0u8; 4];
        version_bytes.copy_from_slice(&bytes[OPLOG_MAGIC.len()..OPLOG_HEADER_LEN]);
        assert_eq!(
            u32::from_be_bytes(version_bytes),
            OPLOG_SCHEMA_VERSION,
            "version u32 (bytes 4..8, big-endian) must match current schema"
        );
    }

    /// **Tier D3:** a Quantlab-prefixed file with a schema version
    /// beyond what this build supports must surface
    /// `PersistenceError::OplogUnsupportedVersion` — NOT silently
    /// decode (which could mis-interpret a future op shape) and NOT
    /// fall back to the legacy raw-Loro path (which would also
    /// mis-interpret).
    #[test]
    fn tier_d3_future_schema_version_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("future.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "future", &path).unwrap();

        // Overwrite the version u32 with one beyond the current.
        let mut bytes = fs::read(path.join(OPLOG_FILENAME)).unwrap();
        let future_version = OPLOG_SCHEMA_VERSION + 1;
        bytes[OPLOG_MAGIC.len()..OPLOG_HEADER_LEN].copy_from_slice(&future_version.to_be_bytes());
        fs::write(path.join(OPLOG_FILENAME), &bytes).unwrap();

        let result = load_workbook_with_oplog(&path);
        match result {
            Err(PersistenceError::OplogUnsupportedVersion { found, min, max }) => {
                assert_eq!(found, future_version);
                assert_eq!(min, OPLOG_MIN_SUPPORTED_SCHEMA_VERSION);
                assert_eq!(max, OPLOG_SCHEMA_VERSION);
            }
            other => panic!("expected OplogUnsupportedVersion, got {other:?}"),
        }
    }

    /// **Audit-closure (Codex LOW-1 / Opus MEDIUM-2):** version `0` is
    /// reserved-as-corrupt. Mirrors `qbook_format::MIN_SUPPORTED_SCHEMA_VERSION`
    /// gate. Pre-closure the loader only checked `version > max` so
    /// version=0 silently passed.
    #[test]
    fn tier_d3_version_zero_rejected_as_unsupported() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v0.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "v0", &path).unwrap();

        // Overwrite the version u32 with 0.
        let mut bytes = fs::read(path.join(OPLOG_FILENAME)).unwrap();
        bytes[OPLOG_MAGIC.len()..OPLOG_HEADER_LEN].copy_from_slice(&0u32.to_be_bytes());
        fs::write(path.join(OPLOG_FILENAME), &bytes).unwrap();

        let result = load_workbook_with_oplog(&path);
        match result {
            Err(PersistenceError::OplogUnsupportedVersion { found, min, max }) => {
                assert_eq!(found, 0);
                assert_eq!(min, OPLOG_MIN_SUPPORTED_SCHEMA_VERSION);
                assert_eq!(max, OPLOG_SCHEMA_VERSION);
            }
            other => panic!("expected OplogUnsupportedVersion(found=0), got {other:?}"),
        }
    }

    /// **Audit-closure (Codex HIGH-1, part 1 of 2):** pin the legacy-path
    /// fail-loud contract for files that LOOK like Loro snapshots
    /// (start with `b"loro"`) but carry garbage body bytes. The
    /// MAGIC-detection routes to legacy path; Loro's framing decoder
    /// then rejects.
    ///
    /// **Scope of this test:** it pins the FRAMING-level failure
    /// mode. The per-op-deserialize failure mode that HIGH-1 also
    /// describes (pre-step-4 files: Loro framing accepts; ops fail at
    /// `iter()`) is pinned by part 2 — see
    /// `crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs` (D-1 step 8
    /// megaudit closure, 2026-05-20). That file synthesizes pre-step-4
    /// op JSON via direct `LoroDoc::get_list("ops").push(LoroValue::String(json))`
    /// — a technique Opus-A's step-8 megaudit proved feasible.
    ///
    /// Both tests together guarantee: legacy-path corruption of any
    /// flavor — frame-level garbage OR per-op shape drift — surfaces
    /// as `PersistenceError::OpLog`. Not silent data loss.
    #[test]
    fn legacy_path_with_corrupt_loro_body_fails_loudly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("corrupt_loro.qbook");
        let wb = fresh_workbook_with_cell();
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();
        save_workbook_with_oplog(&wb, &log, "corrupt_loro", &path).unwrap();

        // Replace oplog.bin with bytes that resemble a Loro snapshot
        // header but carry garbage afterward. MAGIC-detection routes
        // to legacy path; Loro decoder rejects framing.
        let mut garbage = b"loro".to_vec();
        garbage.extend_from_slice(&[0xff; 64]);
        fs::write(path.join(OPLOG_FILENAME), &garbage).unwrap();

        let result = load_workbook_with_oplog(&path);
        assert!(
            matches!(result, Err(PersistenceError::OpLog(_))),
            "legacy-path Loro decode of corrupt body must fail loudly; got {result:?}"
        );
    }

    /// **Tier D3:** a Quantlab-prefixed file truncated before the
    /// version u32 is fully present surfaces
    /// `PersistenceError::OplogTruncatedHeader` — NOT a Loro decode
    /// error (which would mis-attribute the corruption).
    #[test]
    fn tier_d3_truncated_header_surfaces_distinct_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("truncated.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "truncated", &path).unwrap();

        // Truncate to MAGIC + 2 bytes (less than the 8-byte header).
        let bytes = fs::read(path.join(OPLOG_FILENAME)).unwrap();
        let truncated = &bytes[..OPLOG_MAGIC.len() + 2];
        fs::write(path.join(OPLOG_FILENAME), truncated).unwrap();

        let result = load_workbook_with_oplog(&path);
        match result {
            Err(PersistenceError::OplogTruncatedHeader {
                found_bytes,
                required,
            }) => {
                assert_eq!(found_bytes, OPLOG_MAGIC.len() + 2);
                assert_eq!(required, OPLOG_HEADER_LEN);
            }
            other => panic!("expected OplogTruncatedHeader, got {other:?}"),
        }
    }

    /// **Tier D3 backward compat:** a pre-Tier-D3 `oplog.bin` (raw Loro
    /// snapshot with NO Quantlab MAGIC prefix) must still load via the
    /// legacy decode path. Construct one by exporting Loro bytes
    /// directly + writing them without the header prefix that
    /// `save_workbook_with_oplog` would prepend.
    #[test]
    fn legacy_pre_tier_d3_raw_loro_snapshot_still_loads() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();

        // Save with header so the .qbook directory + envelope exist.
        save_workbook_with_oplog(&wb, &oplog, "legacy", &path).unwrap();

        // Now replace oplog.bin with a raw Loro snapshot (no header) —
        // simulates a pre-Tier-D3 file written by an older Quantlab.
        let raw_loro = oplog.export_bytes().unwrap();
        assert_ne!(
            &raw_loro[..OPLOG_MAGIC.len().min(raw_loro.len())],
            &OPLOG_MAGIC,
            "Loro snapshot's first bytes must not collide with OPLOG_MAGIC \
             (else the legacy-path detection breaks)"
        );
        fs::write(path.join(OPLOG_FILENAME), &raw_loro).unwrap();

        // Load via the legacy path: must succeed, ops survive.
        let (_, loaded_log) = load_workbook_with_oplog(&path)
            .expect("legacy raw-Loro oplog.bin must load via the backward-compat path");
        let loaded_ops: Vec<Op> = loaded_log.iter().collect::<Result<_, _>>().unwrap();
        let original_ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(loaded_ops, original_ops);
    }

    /// **Tier D3:** an empty file (0 bytes) doesn't start with MAGIC →
    /// routes to legacy path → Loro decode fails → surfaces
    /// `PersistenceError::OpLog`. Pins the boundary: zero-length is
    /// not a special case.
    #[test]
    fn tier_d3_empty_oplog_bin_routes_to_legacy_path_and_loro_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty_oplog.qbook");
        let wb = fresh_workbook_with_cell();
        let oplog = oplog_with_three_ops();
        save_workbook_with_oplog(&wb, &oplog, "empty_oplog", &path).unwrap();

        // Replace oplog.bin with an empty file.
        fs::write(path.join(OPLOG_FILENAME), b"").unwrap();

        let result = load_workbook_with_oplog(&path);
        assert!(
            matches!(result, Err(PersistenceError::OpLog(_))),
            "empty oplog.bin must route to legacy decode + surface OpLog error; got {result:?}"
        );
    }
}
