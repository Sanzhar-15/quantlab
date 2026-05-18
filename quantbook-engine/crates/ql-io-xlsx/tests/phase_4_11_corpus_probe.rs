//! **Phase 4.11 megaudit corpus probe.**
//!
//! Imports every `.xlsx` in `.references/`, attempts a round-trip
//! (import → export → re-import), and reports a per-fixture summary.
//!
//! Run with: `cargo test -p ql-io-xlsx --test phase_4_11_corpus_probe -- --nocapture --include-ignored`
//!
//! This is NOT part of the regular test suite (ignored by default).
//! It produces a multi-line report that's the empirical basis for
//! the Phase 4.11 megaudit findings.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, RecomputeMode, XlsxExportOptions, XlsxImportOptions,
};

const FIXTURE_ROOT: &str = "../../.references";

#[derive(Default)]
struct FixtureReport {
    path: String,
    import_ok: bool,
    sheets: usize,
    formulas: usize,
    custom_formats: usize,
    names: usize,
    tables: usize,
    feature_inventory_kinds: usize,
    formula_failures: usize,
    overlay_entries: usize,
    /// (round-trip stage outcomes)
    export_ok: bool,
    reimport_ok: bool,
    /// Semantic-equivalence: sheet count + formula count + overlay
    /// count + names count + tables count match across round-trip.
    semantic_equivalent: Option<bool>,
    /// First error message, if any.
    error: Option<String>,
}

fn run_one(path: &std::path::Path) -> FixtureReport {
    let mut r = FixtureReport {
        path: path.display().to_string(),
        ..FixtureReport::default()
    };

    let registry = ql_functions::default_registry();

    let import_opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let first = match import_xlsx_path(path, &registry, import_opts.clone()) {
        Ok(r) => r,
        Err(e) => {
            r.error = Some(format!("import: {e:?}"));
            return r;
        }
    };
    r.import_ok = true;
    r.sheets = first.workbook.sheet_count();
    r.formulas = first.workbook.iter_formulas().count();
    r.custom_formats = first
        .workbook
        .formats()
        .iter()
        .filter(|(id, _)| id.0 >= ql_storage::FIRST_CUSTOM_FORMAT_ID)
        .count();
    r.names = first.workbook.names().len();
    r.tables = first.workbook.tables().len();
    r.feature_inventory_kinds = first.report.feature_inventory.counts.len();
    r.formula_failures = first.report.formula_failures.len();
    r.overlay_entries = (0..first.workbook.sheet_count() as u16)
        .filter_map(|sid| first.workbook.sheet(sid))
        .map(|s| s.format_overlay().len())
        .sum();

    let tmp = std::env::temp_dir().join(format!(
        "phase-4-11-corpus-{}.xlsx",
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("x")
    ));
    let _ = std::fs::remove_file(&tmp);
    match export_xlsx_path(&first.workbook, &registry, &tmp, XlsxExportOptions::default()) {
        Ok(_) => r.export_ok = true,
        Err(e) => {
            r.error = Some(format!("export: {e:?}"));
            return r;
        }
    }

    let second = match import_xlsx_path(&tmp, &registry, import_opts) {
        Ok(r) => r,
        Err(e) => {
            r.error = Some(format!("re-import: {e:?}"));
            let _ = std::fs::remove_file(&tmp);
            return r;
        }
    };
    r.reimport_ok = true;

    let second_overlay: usize = (0..second.workbook.sheet_count() as u16)
        .filter_map(|sid| second.workbook.sheet(sid))
        .map(|s| s.format_overlay().len())
        .sum();
    let second_custom: usize = second
        .workbook
        .formats()
        .iter()
        .filter(|(id, _)| id.0 >= ql_storage::FIRST_CUSTOM_FORMAT_ID)
        .count();

    r.semantic_equivalent = Some(
        second.workbook.sheet_count() == r.sheets
            && second.workbook.iter_formulas().count() == r.formulas
            && second.workbook.names().len() == r.names
            && second.workbook.tables().len() == r.tables
            && second_overlay == r.overlay_entries
            && second_custom == r.custom_formats,
    );

    let _ = std::fs::remove_file(&tmp);
    r
}

#[test]
#[ignore]
fn phase_4_11_corpus_round_trip_report() {
    let mut fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();
    fixtures.sort();

    let mut total = 0;
    let mut import_ok = 0;
    let mut export_ok = 0;
    let mut reimport_ok = 0;
    let mut semantic_equiv = 0;
    let mut semantic_diverged = 0;
    let mut errors: Vec<String> = Vec::new();

    println!("=== Phase 4.11 megaudit fixture corpus report ===");
    println!(
        "{:<60} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | imp | exp | reimp | eq | error",
        "fixture",
        "sheet",
        "fml",
        "fmt",
        "names",
        "tabls",
        "inv",
        "fmlf",
        "ovrl"
    );
    for path in &fixtures {
        total += 1;
        let r = run_one(path);
        if r.import_ok {
            import_ok += 1;
        }
        if r.export_ok {
            export_ok += 1;
        }
        if r.reimport_ok {
            reimport_ok += 1;
        }
        match r.semantic_equivalent {
            Some(true) => semantic_equiv += 1,
            Some(false) => semantic_diverged += 1,
            None => {}
        }
        let short = path
            .strip_prefix(FIXTURE_ROOT)
            .unwrap_or(path)
            .display()
            .to_string();
        let eq_marker = match r.semantic_equivalent {
            Some(true) => "Y",
            Some(false) => "N",
            None => "-",
        };
        println!(
            "{:<60} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>4} | {:>3} | {:>3} | {:>5} | {} | {}",
            if short.len() > 60 {
                short[short.len() - 60..].to_string()
            } else {
                short
            },
            r.sheets,
            r.formulas,
            r.custom_formats,
            r.names,
            r.tables,
            r.feature_inventory_kinds,
            r.formula_failures,
            r.overlay_entries,
            if r.import_ok { "OK" } else { "FAIL" },
            if r.export_ok {
                "OK"
            } else if r.import_ok {
                "FAIL"
            } else {
                "-"
            },
            if r.reimport_ok {
                "OK"
            } else if r.export_ok {
                "FAIL"
            } else {
                "-"
            },
            eq_marker,
            r.error.as_deref().unwrap_or("")
        );
        if let Some(e) = r.error {
            errors.push(format!("{}: {}", path.display(), e));
        }
    }
    println!();
    println!("--- Summary ---");
    println!("Total fixtures:    {}", total);
    println!("Import OK:         {}", import_ok);
    println!("Export OK:         {}", export_ok);
    println!("Re-import OK:      {}", reimport_ok);
    println!("Semantic equiv:    {} (Y)", semantic_equiv);
    println!("Semantic diverged: {} (N)", semantic_diverged);
    println!("Errors:            {}", errors.len());
    println!();
    if !errors.is_empty() {
        println!("--- Errors detail ---");
        for e in errors.iter().take(50) {
            println!("  {}", e);
        }
    }
}

fn walkdir(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            out.extend(walkdir(&p));
        } else {
            out.push(p);
        }
    }
    out
}
