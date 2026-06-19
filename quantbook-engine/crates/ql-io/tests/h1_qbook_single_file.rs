//! Wave H1 (2026-06-19): single-file `.qbook` ZIP container tests.
//!
//! The single-file path REUSES the directory writer/reader verbatim (it stages
//! into a temp dir then zips / unzips into a temp dir then `load_workbook`), so
//! full-fidelity field coverage is inherited from the dir-format tests
//! (`loader.rs`, `oplog_e2e.rs`, `qbook_format` unit tests). These tests pin the
//! CONTAINER layer specifically: that the zip holds exactly the dir bundle
//! (minus the marker), that load recovers the workbook, that output is
//! deterministic, that the op-log rides along, and that every corruption /
//! adversarial input fails LOUD (No-Fallbacks) — never a silent half-load.

use std::fs;
use std::path::Path;

use ql_io::{
    load_workbook_file, load_workbook_file_with_oplog, save_workbook, save_workbook_file,
    save_workbook_file_with_oplog, PersistenceError, QbookError,
};
use ql_oplog::OpLog;
use ql_storage::Workbook;
use ql_types::Value;
use tempfile::TempDir;

const SENTINEL_NAME: &str = "quantbook-container";
const SENTINEL_BODY: &[u8] = b"quantbook-container-v1\n";
const MARKER_NAME: &str = ".atomic-save-marker-v1";

/// A workbook exercising the spread of bundle members: multiple sheets, a text
/// value, a number, a boolean, a formula cell, and a hidden row (the Wave G2
/// schema-v11 field — proves it rides the container).
fn build_rich_workbook() -> Workbook {
    let mut wb = Workbook::new();
    let s0 = wb.add_sheet("Returns");
    let s1 = wb.add_sheet("Prices");
    wb.put_at(s0, 0, 0, Value::Number(42.0));
    wb.put_at(s0, 0, 1, Value::Text("hello".into()));
    wb.put_at(s0, 2, 0, Value::Boolean(true));
    wb.put_formula(s0, 1, 0, "A1+1");
    wb.sheet_mut(s1).unwrap().set_row_hidden(3, true);
    wb.put_at(s1, 0, 0, Value::Number(100.0));
    wb
}

/// Sorted `(forward-slash relative name, bytes)` of every file under a saved
/// `.qbook` directory, excluding the atomic-save marker.
fn read_dir_members(dir: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.retain(|(name, _)| name != MARKER_NAME);
    out.sort();
    out
}

/// Sorted `(name, bytes)` of every entry inside a `.qbook` container, excluding
/// the sentinel marker entry.
fn read_zip_members(file: &Path) -> Vec<(String, Vec<u8>)> {
    use std::io::Read as _;
    let f = fs::File::open(file).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().to_string();
        if name == SENTINEL_NAME {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        out.push((name, buf));
    }
    out.sort();
    out
}

/// Write a hand-built ZIP (Stored, for adversarial-input tests).
fn write_zip(file: &Path, entries: &[(&str, &[u8])]) {
    use std::io::Write as _;
    let f = fs::File::create(file).unwrap();
    let mut zip = zip::ZipWriter::new(f);
    let opts =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in entries {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
}

// ─── round-trip + structural equivalence ─────────────────────────────────────

/// The container holds EXACTLY the directory bundle members (minus the marker),
/// byte-for-byte. This is the load-bearing fidelity proof: container = zip(dir
/// bytes), so everything the dir format round-trips, the container does too.
#[test]
fn container_holds_exactly_the_dir_bundle_minus_marker() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();

    let dir = tmp.path().join("ref.qbook");
    save_workbook(&wb, "wb", &dir).unwrap();
    let dir_members = read_dir_members(&dir);

    let file = tmp.path().join("book.qbook");
    save_workbook_file(&wb, "wb", &file).unwrap();
    let zip_members = read_zip_members(&file);

    assert!(
        file.is_file(),
        ".qbook must be a single FILE, not a directory"
    );
    assert_eq!(
        dir_members, zip_members,
        "container members must equal the dir bundle minus the marker"
    );
}

/// The container carries the sentinel entry (correct body) and never the
/// `.atomic-save-marker-v1` dotfile (Gap-A).
#[test]
fn container_has_sentinel_and_omits_marker() {
    use std::io::Read as _;
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("book.qbook");
    save_workbook_file(&wb, "wb", &file).unwrap();

    let f = fs::File::open(&file).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(
        names.iter().any(|n| n == SENTINEL_NAME),
        "sentinel must be present: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n == MARKER_NAME),
        "the atomic-save marker must NOT be zipped: {names:?}"
    );
    assert!(
        names.iter().any(|n| n == "workbook.toml"),
        "envelope must be present: {names:?}"
    );

    let mut body = Vec::new();
    archive
        .by_name(SENTINEL_NAME)
        .unwrap()
        .read_to_end(&mut body)
        .unwrap();
    assert_eq!(body, SENTINEL_BODY);
}

/// `load_workbook_file` recovers the workbook: sheets, names, formula, hidden
/// row all survive the file round-trip.
#[test]
fn file_roundtrip_recovers_workbook() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("book.qbook");
    save_workbook_file(&wb, "wb", &file).unwrap();

    let loaded = load_workbook_file(&file).unwrap();
    assert_eq!(loaded.sheet_count(), 2);
    assert_eq!(loaded.sheet(0).unwrap().name(), "Returns");
    assert_eq!(loaded.sheet(1).unwrap().name(), "Prices");
    assert_eq!(
        loaded.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("A1+1".to_string())
    );
    assert!(
        loaded.sheet(1).unwrap().hidden_rows().contains(&3),
        "hidden row must survive the container round-trip"
    );
}

/// Saving the same workbook twice yields byte-identical container files — the
/// pinned entry timestamp + fixed entry order + deterministic Deflate. Pins the
/// `last_modified_time` determinism fix.
#[test]
fn file_save_is_deterministic() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let a = tmp.path().join("a.qbook");
    let b = tmp.path().join("b.qbook");
    save_workbook_file(&wb, "wb", &a).unwrap();
    save_workbook_file(&wb, "wb", &b).unwrap();
    assert_eq!(
        fs::read(&a).unwrap(),
        fs::read(&b).unwrap(),
        "container bytes must be deterministic across saves"
    );
}

/// A second save replaces the prior container atomically with the new content.
#[test]
fn file_save_atomic_replace() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("book.qbook");

    let mut wb1 = Workbook::new();
    wb1.add_sheet("One");
    save_workbook_file(&wb1, "wb", &file).unwrap();

    let mut wb2 = Workbook::new();
    wb2.add_sheet("A");
    wb2.add_sheet("B");
    save_workbook_file(&wb2, "wb", &file).unwrap();

    let loaded = load_workbook_file(&file).unwrap();
    assert_eq!(loaded.sheet_count(), 2, "the second save must win");
}

// ─── op-log ──────────────────────────────────────────────────────────────────

/// Workbook + op-log round-trip through the container via the `_with_oplog`
/// variants.
#[test]
fn file_with_oplog_roundtrips() {
    let wb = build_rich_workbook();
    let oplog = OpLog::new();
    let orig_oplog_bytes = oplog.export_bytes().unwrap();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("book.qbook");
    save_workbook_file_with_oplog(&wb, &oplog, "wb", &file).unwrap();

    let (loaded, loaded_oplog) = load_workbook_file_with_oplog(&file).unwrap();
    assert_eq!(loaded.sheet_count(), 2);
    assert_eq!(loaded.sheet(0).unwrap().name(), "Returns");
    assert_eq!(
        loaded_oplog.export_bytes().unwrap(),
        orig_oplog_bytes,
        "op-log bytes must round-trip through the container intact"
    );
}

/// Two entries with the same name (here two `sheets/0.jsonl`) are ambiguous —
/// extraction order would silently pick a winner — so they are refused loudly.
#[test]
fn load_file_duplicate_entry_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("dup.qbook");
    write_zip(
        &file,
        &[
            (SENTINEL_NAME, SENTINEL_BODY),
            ("sheets/0.jsonl", b"first"),
            ("sheets/0.jsonl", b"second"),
        ],
    );
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "duplicate entry must be rejected, got {err:?}"
    );
}

/// A depth-neutral `../` entry (`sheets/../workbook.toml`) stays inside the
/// stage dir but would substitute a member — rejected (megaudit MEDIUM).
#[test]
fn load_file_parent_dir_component_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("sneaky.qbook");
    write_zip(
        &file,
        &[
            (SENTINEL_NAME, SENTINEL_BODY),
            ("sheets/../workbook.toml", b"malicious"),
        ],
    );
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "a parent-dir component must be rejected, got {err:?}"
    );
}

/// A `CurDir` (`./`) component is also non-normal: `./workbook.toml` joins to the
/// same file as `workbook.toml` but is a distinct dedup key, so it could
/// substitute a member. Rejected by the all-`Normal` guard (Codex re-audit MED).
#[test]
fn load_file_curdir_component_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("dotslash.qbook");
    write_zip(
        &file,
        &[
            (SENTINEL_NAME, SENTINEL_BODY),
            ("workbook.toml", b"real"),
            ("./workbook.toml", b"malicious"),
        ],
    );
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "a curdir (./) component must be rejected, got {err:?}"
    );
}

/// Repeated separators alias to the same file (`sheets//0.jsonl` joins to the
/// same target as `sheets/0.jsonl`) but are distinct raw names — they must
/// canonicalize to one dedup key and be rejected as a duplicate, closing the
/// whole lexical-alias substitution class (Codex pass-3 MEDIUM).
#[test]
fn load_file_repeated_separator_alias_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("alias.qbook");
    write_zip(
        &file,
        &[
            (SENTINEL_NAME, SENTINEL_BODY),
            ("sheets/0.jsonl", b"real"),
            ("sheets//0.jsonl", b"malicious"),
        ],
    );
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "a repeated-separator alias must be rejected, got {err:?}"
    );
}

/// A case alias (`workbook.toml` vs `WORKBOOK.TOML`) collides to the SAME file on
/// a case-insensitive FS (macOS APFS default). The dangerous bug is a malicious
/// alias SUBSTITUTING a member with different-but-valid content. To pin that
/// portably (Codex pass-5): pack the canonical lowercase `workbook.toml` with
/// INVALID bytes and the uppercase `WORKBOOK.TOML` with the VALID envelope.
/// - Pre-fix on APFS: `File::create` lets the valid uppercase truncate-overwrite
///   the invalid lowercase, so the load would WRONGLY succeed (the bug).
/// - Post-fix on APFS: `create_new` rejects the colliding second write loudly.
/// - On a case-SENSITIVE FS: both extract distinctly; `load_workbook` reads the
///   INVALID lowercase `workbook.toml` and fails. Either way the load must error
///   — it must NEVER silently succeed off the substituted content.
#[test]
fn load_file_case_alias_does_not_silently_succeed() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let good = tmp.path().join("good.qbook");
    save_workbook_file(&wb, "wb", &good).unwrap();
    let members = read_zip_members(&good); // (name, bytes), sentinel excluded
    let valid_envelope = members
        .iter()
        .find(|(n, _)| n == "workbook.toml")
        .map(|(_, b)| b.clone())
        .expect("good container has a workbook.toml");

    let file = tmp.path().join("casealias.qbook");
    {
        use std::io::Write as _;
        let f = fs::File::create(&file).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(SENTINEL_NAME, opts).unwrap();
        zip.write_all(SENTINEL_BODY).unwrap();
        for (name, bytes) in &members {
            // Canonical lowercase envelope carries INVALID bytes; sheets stay valid.
            let body: &[u8] = if name == "workbook.toml" {
                b"this is not valid toml"
            } else {
                bytes
            };
            zip.start_file(name.clone(), opts).unwrap();
            zip.write_all(body).unwrap();
        }
        // The colliding uppercase alias carries the VALID envelope — pre-fix it
        // would substitute the invalid lowercase and the load would succeed.
        zip.start_file("WORKBOOK.TOML", opts).unwrap();
        zip.write_all(&valid_envelope).unwrap();
        zip.finish().unwrap();
    }
    assert!(
        load_workbook_file(&file).is_err(),
        "a case-aliased member substitution must never silently succeed"
    );
}

/// Sentinel present but with the wrong body (a future/foreign container version)
/// → loud `NotAQbookContainer`, never a silent partial load.
#[test]
fn load_file_wrong_sentinel_body_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("wrongver.qbook");
    write_zip(&file, &[(SENTINEL_NAME, b"quantbook-container-v999\n")]);
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::NotAQbookContainer { .. }),
        "a wrong sentinel body must be rejected, got {err:?}"
    );
}

/// `load_workbook_file_with_oplog` on a container with NO `oplog.bin` entry
/// (saved via the plain `save_workbook_file`) fails LOUD — the caller asked for
/// the op-log; its absence surfaces (No-Fallbacks), same as the dir format.
#[test]
fn file_with_oplog_missing_entry_is_loud() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("noop.qbook");
    save_workbook_file(&wb, "wb", &file).unwrap();

    let err = load_workbook_file_with_oplog(&file).unwrap_err();
    assert!(
        matches!(err, PersistenceError::Qbook(QbookError::MissingFile { .. })),
        "missing oplog entry must fail loud as MissingFile, got {err:?}"
    );
}

// ─── adversarial / corruption (all must fail LOUD) ───────────────────────────

/// Non-ZIP bytes renamed to `.qbook` → loud `Zip` error.
#[test]
fn load_file_not_a_zip_is_loud() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("garbage.qbook");
    fs::write(&file, b"definitely not a zip file").unwrap();
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "garbage must fail as Zip, got {err:?}"
    );
}

/// A truncated container (central directory lost) → loud `Zip` error.
#[test]
fn load_file_truncated_is_loud() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("trunc.qbook");
    save_workbook_file(&wb, "wb", &file).unwrap();
    let bytes = fs::read(&file).unwrap();
    fs::write(&file, &bytes[..bytes.len() / 2]).unwrap();
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "truncated must fail as Zip, got {err:?}"
    );
}

/// A valid ZIP that is NOT a quantbook container (no sentinel) → loud
/// `NotAQbookContainer` (never a silent half-load).
#[test]
fn load_file_foreign_zip_without_sentinel_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("foreign.qbook");
    write_zip(
        &file,
        &[("foo.txt", b"bar"), ("workbook.toml", b"not real")],
    );
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::NotAQbookContainer { .. }),
        "a sentinel-less zip must be refused, got {err:?}"
    );
}

/// A container with the sentinel but a zip-slip entry name (`../escape`) →
/// loud `Zip` error during extraction (the `enclosed_name` guard).
#[test]
fn load_file_zip_slip_entry_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("slip.qbook");
    write_zip(
        &file,
        &[(SENTINEL_NAME, SENTINEL_BODY), ("../escape.txt", b"pwned")],
    );
    let err = load_workbook_file(&file).unwrap_err();
    assert!(
        matches!(err, QbookError::Zip(_)),
        "a zip-slip entry must be rejected, got {err:?}"
    );
}

/// Saving a single-file container onto an existing legacy `.qbook` DIRECTORY is
/// refused loudly (`InvalidPath`), and the directory is left untouched.
#[test]
fn save_file_onto_legacy_dir_is_loud() {
    let wb = build_rich_workbook();
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("legacy.qbook");
    save_workbook(&wb, "wb", &path).unwrap();
    assert!(path.is_dir());

    let err = save_workbook_file(&wb, "wb", &path).unwrap_err();
    assert!(matches!(err, QbookError::InvalidPath { .. }), "got {err:?}");
    assert!(path.is_dir(), "the legacy dir must be untouched");
    assert!(path.join("workbook.toml").is_file());
}

/// An empty (0-sheet) workbook round-trips through the container.
#[test]
fn empty_workbook_file_roundtrips() {
    let wb = Workbook::new();
    assert_eq!(wb.sheet_count(), 0);
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("empty.qbook");
    save_workbook_file(&wb, "empty", &file).unwrap();
    let loaded = load_workbook_file(&file).unwrap();
    assert_eq!(loaded.sheet_count(), 0);
}
