#![allow(
    unused_imports,
    dead_code,
    unused_mut,
    unused_variables,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]
//! Phase 4.12 defensive probes for `.qbook/` persistence corruption.
//!
//! Marked `#[ignore]` — invoked via
//! `cargo test -p ql-io --test p412_qbook_corruption_probes -- --ignored
//! --nocapture --test-threads=1`.
//!
//! Each probe writes a workbook, corrupts a specific file in the
//! `.qbook/` directory in a specific way, and records what
//! `load_workbook` returns (typed error vs panic).
//!
//! The `.qbook` format is a directory with `workbook.toml` + `sheets/N.jsonl`
//! files. There is no binary magic header — corruption is structural
//! (malformed TOML, malformed JSONL, truncation, wrong schema_version).

use std::fs;
use std::panic;
use std::path::Path;

use ql_io::{load_workbook, save_workbook};
use ql_storage::Workbook;
use ql_types::Value;
use tempfile::TempDir;

fn try_load(path: &Path) -> Result<Result<Workbook, String>, String> {
    panic::catch_unwind(panic::AssertUnwindSafe(|| {
        load_workbook(path).map_err(|e| format!("QbookError: {e:?}"))
    }))
    .map_err(|payload| {
        if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_owned()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_owned()
        }
    })
}

fn save_minimal(dir: &Path) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    wb.put_at(0, 0, 0, Value::Number(42.0));
    save_workbook(&wb, "test", dir).expect("save");
}

// ─── 1. envelope corruption ──────────────────────────────────────────────

#[test]
#[ignore]
fn envelope_truncated() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("t.qbook");
    save_minimal(&path);
    let toml_path = path.join("workbook.toml");
    let original = fs::read(&toml_path).unwrap();
    for cut in [
        0usize,
        1,
        8,
        32,
        original.len() / 2,
        original.len().saturating_sub(1),
    ] {
        fs::write(&toml_path, &original[..cut.min(original.len())]).unwrap();
        let r = try_load(&path);
        eprintln!(
            "envelope_truncated[cut={cut}]: {:?}",
            r.as_ref().map(|x| x.is_ok())
        );
    }
}

#[test]
#[ignore]
fn envelope_random_bytes() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("rb.qbook");
    save_minimal(&path);
    let toml_path = path.join("workbook.toml");
    fs::write(&toml_path, b"\xff\x00\x42\x99 \r\n garbage \xfe").unwrap();
    let r = try_load(&path);
    eprintln!("envelope_random_bytes: {r:?}");
}

#[test]
#[ignore]
fn envelope_missing_required_field() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("mf.qbook");
    save_minimal(&path);
    let toml_path = path.join("workbook.toml");
    // Schema version present but no sheets section.
    fs::write(&toml_path, b"schema_version = 1\nname = \"x\"\n").unwrap();
    let r = try_load(&path);
    eprintln!("envelope_missing_required_field: {r:?}");
}

#[test]
#[ignore]
fn envelope_negative_schema_version() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("neg.qbook");
    save_minimal(&path);
    let toml_path = path.join("workbook.toml");
    let mut content = fs::read_to_string(&toml_path).unwrap();
    content = content.replace("schema_version = 1", "schema_version = -1");
    content = content.replace("schema_version = 7", "schema_version = -1");
    content = content.replace("schema_version = 6", "schema_version = -1");
    fs::write(&toml_path, content).unwrap();
    let r = try_load(&path);
    eprintln!("envelope_negative_schema_version: {r:?}");
}

#[test]
#[ignore]
fn envelope_giant_schema_version() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("big.qbook");
    save_minimal(&path);
    let toml_path = path.join("workbook.toml");
    let mut content = fs::read_to_string(&toml_path).unwrap();
    // Replace whatever version is there with a far-future one.
    let lines: Vec<&str> = content.lines().collect();
    let new: Vec<String> = lines
        .iter()
        .map(|l| {
            if l.starts_with("schema_version") {
                "schema_version = 999".to_owned()
            } else {
                (*l).to_owned()
            }
        })
        .collect();
    content = new.join("\n");
    fs::write(&toml_path, content).unwrap();
    let r = try_load(&path);
    eprintln!("envelope_giant_schema_version: {r:?}");
}

// ─── 2. sheet jsonl corruption ───────────────────────────────────────────

#[test]
#[ignore]
fn sheet_jsonl_truncated_midline() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("st.qbook");
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    for i in 0..20 {
        wb.put_at(0, i, 0, Value::Number(i as f64));
    }
    save_workbook(&wb, "test", &path).expect("save");
    let sheet_path = path.join("sheets/0.jsonl");
    let original = fs::read(&sheet_path).unwrap();
    // Cut roughly in the middle of a line.
    fs::write(&sheet_path, &original[..original.len() / 2 + 3]).unwrap();
    let r = try_load(&path);
    eprintln!("sheet_jsonl_truncated_midline: {r:?}");
}

#[test]
#[ignore]
fn sheet_jsonl_random_bytes() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("sr.qbook");
    save_minimal(&path);
    let sheet_path = path.join("sheets/0.jsonl");
    fs::write(&sheet_path, b"{garbage\n\xff\xfe\n{ \"sheet\": 0 }\n").unwrap();
    let r = try_load(&path);
    eprintln!("sheet_jsonl_random_bytes: {r:?}");
}

#[test]
#[ignore]
fn sheet_jsonl_out_of_range_coords() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("oor.qbook");
    save_minimal(&path);
    let sheet_path = path.join("sheets/0.jsonl");
    // u32::MAX row/col, well outside MAX_ROW/MAX_COLUMN.
    fs::write(
        &sheet_path,
        b"{\"row\":4294967295,\"col\":4294967295,\"value\":{\"kind\":\"number\",\"n\":1.0}}\n",
    )
    .unwrap();
    let r = try_load(&path);
    eprintln!("sheet_jsonl_out_of_range_coords: {r:?}");
}

#[test]
#[ignore]
fn sheet_jsonl_giant_one_line() {
    // 100 MB JSON line with no newline. Does the BufReader/lines() iterator
    // allocate without bound?
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("giant.qbook");
    save_minimal(&path);
    let sheet_path = path.join("sheets/0.jsonl");
    let mut buf = Vec::with_capacity(100 * 1024 * 1024 + 64);
    buf.extend_from_slice(b"{\"row\":0,\"col\":0,\"value\":{\"kind\":\"text\",\"s\":\"");
    buf.extend(std::iter::repeat(b'x').take(100 * 1024 * 1024));
    buf.extend_from_slice(b"\"}}\n");
    fs::write(&sheet_path, &buf).unwrap();
    let r = try_load(&path);
    eprintln!(
        "sheet_jsonl_giant_one_line: ok={:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

#[test]
#[ignore]
fn sheets_directory_missing() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nosheet.qbook");
    save_minimal(&path);
    fs::remove_dir_all(path.join("sheets")).unwrap();
    let r = try_load(&path);
    eprintln!("sheets_directory_missing: {r:?}");
}

#[test]
#[ignore]
fn entire_qbook_directory_corrupted() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("trash.qbook");
    fs::create_dir(&path).unwrap();
    // Write a TOML that's syntactically valid but doesn't match envelope.
    fs::write(path.join("workbook.toml"), b"hello = 1\n").unwrap();
    let r = try_load(&path);
    eprintln!("entire_qbook_directory_corrupted: {r:?}");
}

#[test]
#[ignore]
fn not_a_directory_at_all() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("file.qbook");
    fs::write(&path, b"i am a file not a dir").unwrap();
    let r = try_load(&path);
    eprintln!("not_a_directory_at_all: {r:?}");
}
