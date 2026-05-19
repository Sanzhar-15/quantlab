#![allow(clippy::approx_constant, unused_imports, dead_code)]

//! Opus-A megaudit deep probe — round-trip invariants.
//!
//! Goes beyond the count-equivalence corpus probe to verify cell-level,
//! overlay-level, names-level, format-code-level, table-level identity
//! across import → export → re-import.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
    UnsupportedPolicy, XlsxExportOptions, XlsxImportOptions, XlsxImportResult,
};
use ql_storage::{NamedTarget, Workbook};
use ql_types::Value;

const FIXTURE_ROOT: &str = "../../.references";

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

fn import_skip(path: &std::path::Path) -> Option<XlsxImportResult> {
    import_xlsx_path(
        path,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .ok()
}

fn round_trip(
    path: &std::path::Path,
) -> Option<(XlsxImportResult, XlsxImportResult, std::path::PathBuf)> {
    let first = import_skip(path)?;
    let tmp = std::env::temp_dir().join(format!(
        "opus-a-deep-{}-{}.xlsx",
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("x"),
        std::process::id(),
    ));
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(
        &first.workbook,
        &registry(),
        &tmp,
        XlsxExportOptions::default(),
    )
    .ok()?;
    let second = import_skip(&tmp)?;
    Some((first, second, tmp))
}

/// Probe 1: walk every fixture; for every CELL with a non-Blank
/// value in the original, verify the round-trip preserves the value.
#[test]
#[ignore]
fn deep_cell_value_round_trip() {
    let mut total_fixtures = 0;
    let mut total_cells_checked: u64 = 0;
    let mut divergence_count: u64 = 0;
    let mut divergence_details: Vec<String> = Vec::new();

    let fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();

    for path in &fixtures {
        total_fixtures += 1;
        let Some((first, second, tmp)) = round_trip(path) else {
            continue;
        };
        let short = path.file_name().unwrap().to_string_lossy().to_string();

        // Compare cell-by-cell across all sheets.
        let sheet_count = first.workbook.sheet_count();
        if sheet_count != second.workbook.sheet_count() {
            divergence_details.push(format!(
                "{}: sheet_count {} vs {}",
                short,
                sheet_count,
                second.workbook.sheet_count()
            ));
            divergence_count += 1;
            let _ = std::fs::remove_file(&tmp);
            continue;
        }
        for sid in 0..sheet_count as u16 {
            let s1 = first.workbook.sheet(sid).unwrap();
            let s2 = second.workbook.sheet(sid).unwrap();
            let b1 = s1.bounds();
            let b2 = s2.bounds();
            let row_extent = b1.row_extent.max(b2.row_extent);
            let col_extent = b1.col_extent.max(b2.col_extent);
            for r in 0..row_extent {
                for c in 0..col_extent {
                    let v1 = s1.read(r, c);
                    let v2 = s2.read(r, c);
                    if matches!(v1, Value::Blank) && matches!(v2, Value::Blank) {
                        continue;
                    }
                    total_cells_checked += 1;
                    if !values_match(&v1, &v2) {
                        divergence_count += 1;
                        if divergence_details.len() < 60 {
                            divergence_details.push(format!(
                                "{} sheet[{}] r={} c={} v1={:?} v2={:?}",
                                short, sid, r, c, v1, v2
                            ));
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }

    println!("=== Deep cell-value round-trip ===");
    println!("Total fixtures: {}", total_fixtures);
    println!("Total cells checked: {}", total_cells_checked);
    println!("Divergent cells: {}", divergence_count);
    println!("--- First 60 divergences ---");
    for d in &divergence_details {
        println!("  {}", d);
    }
}

fn values_match(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            // Allow small float drift (e.g. f64 round-trip via OOXML
            // text representation). Tolerance 0 first; if too strict,
            // widen.
            (x - y).abs() < 1e-12 || (x.is_nan() && y.is_nan())
        }
        (Value::Boolean(x), Value::Boolean(y)) => x == y,
        (Value::Text(x), Value::Text(y)) => x.as_ref() == y.as_ref(),
        (Value::Error(x), Value::Error(y)) => x == y,
        (Value::Blank, Value::Blank) => true,
        _ => false,
    }
}

/// Probe 2: walk every fixture; for every NAME in the original,
/// verify the round-trip preserves the NamedTarget byte-identically.
#[test]
#[ignore]
fn deep_name_round_trip() {
    let mut total_fixtures = 0;
    let mut total_names: usize = 0;
    let mut diverged: usize = 0;
    let mut dropped: usize = 0;
    let mut formula_fallbacks: usize = 0;
    let mut details: Vec<String> = Vec::new();

    let fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();

    for path in &fixtures {
        total_fixtures += 1;
        let Some((first, second, tmp)) = round_trip(path) else {
            continue;
        };
        let short = path.file_name().unwrap().to_string_lossy().to_string();

        // Workbook-scoped names.
        for (name, target1) in first.workbook.names().iter() {
            total_names += 1;
            if matches!(target1, NamedTarget::Formula(_)) {
                formula_fallbacks += 1;
            }
            match second.workbook.names().lookup_ci(name) {
                None => {
                    dropped += 1;
                    if details.len() < 60 {
                        details.push(format!(
                            "{} DROP name={:?} target={:?}",
                            short, name, target1
                        ));
                    }
                }
                Some(target2) => {
                    if !named_targets_match(target1, &target2) {
                        diverged += 1;
                        if details.len() < 60 {
                            details.push(format!(
                                "{} DIV name={:?} t1={:?} t2={:?}",
                                short, name, target1, target2
                            ));
                        }
                    }
                }
            }
        }

        // Sheet-scoped names.
        for sid in 0..first.workbook.sheet_count() as u16 {
            let s1 = first.workbook.sheet(sid).unwrap();
            let s2_opt = second.workbook.sheet(sid);
            for (name, target1) in s1.scoped_names().iter() {
                total_names += 1;
                if matches!(target1, NamedTarget::Formula(_)) {
                    formula_fallbacks += 1;
                }
                let look = s2_opt
                    .as_ref()
                    .and_then(|s| s.scoped_names().lookup_ci(name));
                match look {
                    None => {
                        dropped += 1;
                        if details.len() < 60 {
                            details.push(format!(
                                "{} sheet[{}] DROP scoped name={:?} target={:?}",
                                short, sid, name, target1
                            ));
                        }
                    }
                    Some(target2) => {
                        if !named_targets_match(target1, &target2) {
                            diverged += 1;
                            if details.len() < 60 {
                                details.push(format!(
                                    "{} sheet[{}] DIV scoped name={:?} t1={:?} t2={:?}",
                                    short, sid, name, target1, target2
                                ));
                            }
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }

    println!("=== Deep names round-trip ===");
    println!("Total fixtures: {}", total_fixtures);
    println!("Total names (orig): {}", total_names);
    println!("  Dropped:         {}", dropped);
    println!("  Diverged:        {}", diverged);
    println!(
        "  FormulaFallbacks (subset of total): {}",
        formula_fallbacks
    );
    println!("--- First 60 details ---");
    for d in &details {
        println!("  {}", d);
    }
}

fn named_targets_match(a: &NamedTarget, b: &NamedTarget) -> bool {
    match (a, b) {
        (NamedTarget::Cell(x), NamedTarget::Cell(y)) => x == y,
        (NamedTarget::Range(x), NamedTarget::Range(y)) => x == y,
        (NamedTarget::Constant(x), NamedTarget::Constant(y)) => values_match(x, y),
        (NamedTarget::Formula(x), NamedTarget::Formula(y)) => x.as_ref() == y.as_ref(),
        _ => false,
    }
}

/// Probe 3: every TABLE in the original survives round-trip with
/// matching display name, sheet, footprint, header/totals flags, and
/// column count + names.
#[test]
#[ignore]
fn deep_tables_round_trip() {
    let mut total_fixtures = 0;
    let mut total_tables: usize = 0;
    let mut dropped: usize = 0;
    let mut diverged: usize = 0;
    let mut details: Vec<String> = Vec::new();

    let fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();

    for path in &fixtures {
        total_fixtures += 1;
        let Some((first, second, tmp)) = round_trip(path) else {
            continue;
        };
        let short = path.file_name().unwrap().to_string_lossy().to_string();

        for (canon, t1) in first.workbook.tables().iter() {
            total_tables += 1;
            match second.workbook.tables().lookup(canon) {
                None => {
                    dropped += 1;
                    if details.len() < 60 {
                        details.push(format!("{} DROP table={:?}", short, canon));
                    }
                }
                Some(t2) => {
                    let mut diffs: Vec<String> = Vec::new();
                    if t1.display_name != t2.display_name {
                        diffs.push(format!(
                            "display: {:?} vs {:?}",
                            t1.display_name, t2.display_name
                        ));
                    }
                    if t1.sheet != t2.sheet {
                        diffs.push(format!("sheet: {} vs {}", t1.sheet, t2.sheet));
                    }
                    if t1.top_row != t2.top_row || t1.top_col != t2.top_col {
                        diffs.push(format!(
                            "top: ({},{}) vs ({},{})",
                            t1.top_row, t1.top_col, t2.top_row, t2.top_col
                        ));
                    }
                    if t1.rows != t2.rows || t1.cols != t2.cols {
                        diffs.push(format!(
                            "size: ({}x{}) vs ({}x{})",
                            t1.rows, t1.cols, t2.rows, t2.cols
                        ));
                    }
                    if t1.has_header != t2.has_header {
                        diffs.push(format!("hdr: {} vs {}", t1.has_header, t2.has_header));
                    }
                    if t1.has_totals != t2.has_totals {
                        diffs.push(format!("tot: {} vs {}", t1.has_totals, t2.has_totals));
                    }
                    if t1.columns.len() != t2.columns.len() {
                        diffs.push(format!(
                            "ncols: {} vs {}",
                            t1.columns.len(),
                            t2.columns.len()
                        ));
                    } else {
                        for (i, (c1, c2)) in t1.columns.iter().zip(t2.columns.iter()).enumerate() {
                            if c1.display != c2.display {
                                diffs.push(format!(
                                    "col[{}] display: {:?} vs {:?}",
                                    i, c1.display, c2.display
                                ));
                            }
                            if c1.totals_function != c2.totals_function {
                                diffs.push(format!(
                                    "col[{}] totals_fn: {:?} vs {:?}",
                                    i, c1.totals_function, c2.totals_function
                                ));
                            }
                        }
                    }
                    if !diffs.is_empty() {
                        diverged += 1;
                        if details.len() < 60 {
                            details.push(format!(
                                "{} DIV table={:?} {}",
                                short,
                                canon,
                                diffs.join("; ")
                            ));
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }

    println!("=== Deep tables round-trip ===");
    println!("Total fixtures: {}", total_fixtures);
    println!("Total tables: {}", total_tables);
    println!("  Dropped:    {}", dropped);
    println!("  Diverged:   {}", diverged);
    println!("--- First 60 details ---");
    for d in &details {
        println!("  {}", d);
    }
}

/// Probe 4: format codes (custom only, id >= 164). For every custom
/// format in the original, verify the same id exists in re-import with
/// the same code string.
#[test]
#[ignore]
fn deep_format_codes_round_trip() {
    let mut total_fixtures = 0;
    let mut total_customs: usize = 0;
    let mut dropped: usize = 0;
    let mut diverged: usize = 0;
    let mut details: Vec<String> = Vec::new();

    let fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();

    for path in &fixtures {
        total_fixtures += 1;
        let Some((first, second, tmp)) = round_trip(path) else {
            continue;
        };
        let short = path.file_name().unwrap().to_string_lossy().to_string();
        for (id, code) in first.workbook.formats().iter() {
            if !id.is_custom() {
                continue;
            }
            total_customs += 1;
            // Step 3: id is the full FormatId enum; Debug-print via {:?}
            // shows variant + payload (e.g. `Custom(LEGACY_PEER, 36)`).
            match second.workbook.formats().lookup(id) {
                None => {
                    dropped += 1;
                    if details.len() < 60 {
                        details.push(format!("{} DROP id={:?} code={:?}", short, id, code));
                    }
                }
                Some(code2) => {
                    if code != code2 {
                        diverged += 1;
                        if details.len() < 60 {
                            details.push(format!(
                                "{} DIV id={:?} c1={:?} c2={:?}",
                                short, id, code, code2
                            ));
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }
    println!("=== Deep format-codes round-trip ===");
    println!("Total fixtures: {}", total_fixtures);
    println!("Total custom format codes (orig): {}", total_customs);
    println!("  Dropped:  {}", dropped);
    println!("  Diverged: {}", diverged);
    println!("--- First 60 details ---");
    for d in &details {
        println!("  {}", d);
    }
}

/// Probe 5: per-cell format overlay. Every overlay entry in the
/// original must exist in re-import at the SAME (sheet, row, col)
/// with the SAME FormatId AND the format code string for that id
/// must match.
#[test]
#[ignore]
fn deep_overlay_round_trip() {
    let mut total_fixtures = 0;
    let mut total_overlays: usize = 0;
    let mut dropped_entries: usize = 0;
    let mut wrong_id: usize = 0;
    let mut wrong_code_for_same_id: usize = 0;
    let mut details: Vec<String> = Vec::new();

    let fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();

    for path in &fixtures {
        total_fixtures += 1;
        let Some((first, second, tmp)) = round_trip(path) else {
            continue;
        };
        let short = path.file_name().unwrap().to_string_lossy().to_string();
        for sid in 0..first.workbook.sheet_count() as u16 {
            let s1 = first.workbook.sheet(sid).unwrap();
            let s2_opt = second.workbook.sheet(sid);
            for ((r, c), fid1) in s1.format_overlay().iter() {
                total_overlays += 1;
                let s2 = match s2_opt {
                    Some(s) => s,
                    None => {
                        dropped_entries += 1;
                        if details.len() < 40 {
                            details.push(format!(
                                "{} DROP sheet[{}] r={} c={} (no sheet)",
                                short, sid, r, c
                            ));
                        }
                        continue;
                    }
                };
                let fid2 = match s2.format_overlay().get(r, c) {
                    Some(f) => f,
                    None => {
                        dropped_entries += 1;
                        if details.len() < 40 {
                            details.push(format!(
                                "{} DROP sheet[{}] r={} c={} fid1={:?}",
                                short, sid, r, c, fid1
                            ));
                        }
                        continue;
                    }
                };
                if fid1 != fid2 {
                    // Different format IDs — but check if the code is
                    // semantically the same (built-in re-numbered, etc.).
                    let code1 = first.workbook.formats().lookup(fid1);
                    let code2 = second.workbook.formats().lookup(fid2);
                    if code1 != code2 {
                        wrong_id += 1;
                        if details.len() < 40 {
                            details.push(format!(
                                "{} DIVID sheet[{}] r={} c={} fid1={:?} code1={:?} fid2={:?} code2={:?}",
                                short, sid, r, c, fid1, code1, fid2, code2
                            ));
                        }
                    }
                } else {
                    // Same id — verify code strings match too.
                    let code1 = first.workbook.formats().lookup(fid1);
                    let code2 = second.workbook.formats().lookup(fid2);
                    if code1 != code2 {
                        wrong_code_for_same_id += 1;
                        if details.len() < 40 {
                            details.push(format!(
                                "{} DIVCODE sheet[{}] r={} c={} fid={:?} c1={:?} c2={:?}",
                                short, sid, r, c, fid1, code1, code2
                            ));
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }
    println!("=== Deep overlay round-trip ===");
    println!("Total fixtures: {}", total_fixtures);
    println!("Total overlay entries (orig): {}", total_overlays);
    println!("  Dropped:                {}", dropped_entries);
    println!("  Wrong-id (code differs): {}", wrong_id);
    println!("  Same-id-wrong-code:     {}", wrong_code_for_same_id);
    println!("--- First 40 details ---");
    for d in &details {
        println!("  {}", d);
    }
}

/// Probe 6: formula text drift. For every formula cell in the original,
/// the re-import must have a formula at the same (sheet, row, col) and
/// the formula text must match.
#[test]
#[ignore]
fn deep_formula_text_round_trip() {
    let mut total_fixtures = 0;
    let mut total_formulas: u64 = 0;
    let mut dropped: u64 = 0;
    let mut diverged: u64 = 0;
    let mut details: Vec<String> = Vec::new();

    let fixtures: Vec<std::path::PathBuf> = walkdir(std::path::Path::new(FIXTURE_ROOT))
        .into_iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("xlsx"))
        .collect();

    for path in &fixtures {
        total_fixtures += 1;
        let Some((first, second, tmp)) = round_trip(path) else {
            continue;
        };
        let short = path.file_name().unwrap().to_string_lossy().to_string();
        let map1: std::collections::HashMap<(u16, u32, u32), String> = first
            .workbook
            .iter_formulas()
            .map(|(s, r, c, t)| ((s, r, c), t.to_string()))
            .collect();
        let map2: std::collections::HashMap<(u16, u32, u32), String> = second
            .workbook
            .iter_formulas()
            .map(|(s, r, c, t)| ((s, r, c), t.to_string()))
            .collect();
        for (k, t1) in &map1 {
            total_formulas += 1;
            match map2.get(k) {
                None => {
                    dropped += 1;
                    if details.len() < 40 {
                        details.push(format!(
                            "{} DROP fml sheet[{}] r={} c={} t={:?}",
                            short, k.0, k.1, k.2, t1
                        ));
                    }
                }
                Some(t2) => {
                    if t1 != t2 {
                        diverged += 1;
                        if details.len() < 40 {
                            details.push(format!(
                                "{} DIV fml sheet[{}] r={} c={} t1={:?} t2={:?}",
                                short, k.0, k.1, k.2, t1, t2
                            ));
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }
    println!("=== Deep formula-text round-trip ===");
    println!("Total fixtures: {}", total_fixtures);
    println!("Total formulas (orig): {}", total_formulas);
    println!("  Dropped:  {}", dropped);
    println!("  Diverged: {}", diverged);
    println!("--- First 40 details ---");
    for d in &details {
        println!("  {}", d);
    }
}

/// Probe 7: synthetic — build a workbook with every supported variant
/// in a single document. Round-trip and compare deep.
#[test]
#[ignore]
fn deep_synthetic_cross_feature() {
    use ql_storage::{FormatId, TableColumn, TableMetadata, TotalsFunction};
    use ql_types::{Address, DateSystem, Range};
    use std::sync::Arc;

    let mut wb = Workbook::new();
    wb.set_date_system(DateSystem::Excel1904);
    let s1 = wb.add_sheet("Sheet1");
    let s2 = wb.add_sheet("Sheet2");

    // Variety of values + formulas.
    wb.put_at(s1, 0, 0, Value::Number(42.5));
    wb.put_at(s1, 0, 1, Value::text("hello"));
    wb.put_at(s1, 0, 2, Value::Boolean(true));
    wb.put_at(s1, 0, 3, Value::Error(ql_types::ErrorValue::DivZero));
    wb.put_at(s1, 0, 4, Value::Error(ql_types::ErrorValue::Ref));
    wb.put_at(s1, 1, 0, Value::Number(1.0));
    wb.put_at(s1, 1, 1, Value::Number(2.0));
    wb.put_formula(s1, 1, 2, "A2+B2".to_string());

    // Sheet 2 — same Pattern, different values.
    wb.put_at(s2, 0, 0, Value::Number(100.0));

    // Workbook-scoped names: cell, range, number, text, boolean.
    wb.set_name("MyCell", NamedTarget::Cell(Address::new(s1, 0, 0)))
        .unwrap();
    wb.set_name("MyRange", NamedTarget::Range(Range::new(s1, 0, 0, 1, 2)))
        .unwrap();
    wb.set_name("Pi", NamedTarget::Constant(Value::Number(3.14)))
        .unwrap();
    wb.set_name(
        "Greeting",
        NamedTarget::Constant(Value::text("hello \"world\"")),
    )
    .unwrap();
    wb.set_name("Flag", NamedTarget::Constant(Value::Boolean(true)))
        .unwrap();
    // Sheet-scoped name.
    {
        let sheet = wb.sheet_mut(s1).unwrap();
        sheet
            .set_scoped_name("Local", NamedTarget::Cell(Address::new(s1, 0, 1)))
            .unwrap();
    }

    // Custom format codes.
    let custom_id_1 = wb.formats_mut().intern("yyyy-mm-dd");
    let custom_id_2 = wb.formats_mut().intern("#,##0.00 \"USD\"");
    let custom_id_3 = wb.formats_mut().intern("0.00;[Red]-0.00;\"-\"");
    let custom_id_4 = wb.formats_mut().intern("#,##0 \"& <foo>\""); // XML-special chars
    println!(
        "synthetic custom ids: {:?} {:?} {:?} {:?}",
        custom_id_1, custom_id_2, custom_id_3, custom_id_4
    );
    // Overlay entries.
    {
        let sheet = wb.sheet_mut(s1).unwrap();
        sheet.format_overlay_mut().set(0, 0, custom_id_1);
        sheet.format_overlay_mut().set(0, 1, custom_id_2);
        sheet.format_overlay_mut().set(0, 2, custom_id_3);
        sheet.format_overlay_mut().set(0, 3, custom_id_4);
        sheet.format_overlay_mut().set(0, 4, FormatId::Builtin(14)); // built-in
    }

    // A table.
    let tbl = TableMetadata {
        name: Arc::from("SALES"),
        display_name: Arc::from("Sales"),
        sheet: s1,
        top_row: 5,
        top_col: 0,
        rows: 3,
        cols: 2,
        has_header: true,
        has_totals: true,
        columns: vec![
            TableColumn {
                id: 1,
                name: Arc::from("date"),
                display: Arc::from("Date"),
                totals_function: Some(TotalsFunction::Sum),
            },
            TableColumn {
                id: 2,
                name: Arc::from("qty"),
                display: Arc::from("Qty"),
                totals_function: Some(TotalsFunction::Custom),
            },
        ],
    };
    wb.tables_mut().insert(tbl.name.clone(), tbl);

    let tmp = std::env::temp_dir().join("opus-a-synth.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let exp_report =
        export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    println!("export.cells_written = {}", exp_report.cells_written);
    println!(
        "export.formula_caches_written = {}",
        exp_report.formula_caches_written
    );
    println!(
        "export.dropped_features = {:?}",
        exp_report.dropped_features
    );
    println!("export.warnings = {:?}", exp_report.warnings);

    let second = import_skip(&tmp).expect("re-import");

    // Date system round-trip.
    let ds1 = wb.date_system();
    let ds2 = second.workbook.date_system();
    println!("date_system orig={:?} reimport={:?}", ds1, ds2);
    assert_eq!(ds1, ds2);

    // Cell values + formulas + errors round-trip.
    let sa = wb.sheet(s1).unwrap();
    let sb = second.workbook.sheet(s1).unwrap();
    println!("synth A1 orig={:?} new={:?}", sa.read(0, 0), sb.read(0, 0));
    println!("synth B1 orig={:?} new={:?}", sa.read(0, 1), sb.read(0, 1));
    println!("synth C1 orig={:?} new={:?}", sa.read(0, 2), sb.read(0, 2));
    println!("synth D1 orig={:?} new={:?}", sa.read(0, 3), sb.read(0, 3));
    println!("synth E1 orig={:?} new={:?}", sa.read(0, 4), sb.read(0, 4));

    // Names round-trip.
    for (name, target) in wb.names().iter() {
        match second.workbook.names().lookup_ci(name) {
            Some(t2) => println!(
                "name {:?} orig={:?} new={:?} match={}",
                name,
                target,
                t2,
                named_targets_match(target, &t2)
            ),
            None => println!("name {:?} DROPPED", name),
        }
    }
    // Sheet-scoped.
    let sb_sheet = second.workbook.sheet(s1).unwrap();
    for (name, target) in sa.scoped_names().iter() {
        match sb_sheet.scoped_names().lookup_ci(name) {
            Some(t2) => println!(
                "scoped {:?} orig={:?} new={:?} match={}",
                name,
                target,
                t2,
                named_targets_match(target, &t2)
            ),
            None => println!("scoped {:?} DROPPED", name),
        }
    }

    // Format codes.
    for (id, code) in wb.formats().iter() {
        if !id.is_custom() {
            continue;
        }
        match second.workbook.formats().lookup(id) {
            Some(c2) => {
                println!(
                    "custom fmt {:?} orig={:?} new={:?} match={}",
                    id,
                    code,
                    c2,
                    code == c2
                );
            }
            None => {
                println!("custom fmt {:?} {:?} DROPPED", id, code);
            }
        }
    }

    // Overlay entries.
    for ((r, c), fid) in sa.format_overlay().iter() {
        let v2 = sb.format_overlay().get(r, c);
        let code_orig = wb.formats().lookup(fid);
        let code_new = v2.and_then(|f| second.workbook.formats().lookup(f));
        println!(
            "overlay ({},{}) orig_id={:?} ({:?}) new={:?} ({:?})",
            r, c, fid, code_orig, v2, code_new
        );
    }

    // Tables.
    for (canon, t1) in wb.tables().iter() {
        match second.workbook.tables().lookup(canon) {
            None => println!("table {:?} DROPPED", canon),
            Some(t2) => {
                println!(
                    "table {:?} hdr=({},{}) tot=({},{}) display=({:?},{:?}) cols={}",
                    canon,
                    t1.has_header,
                    t2.has_header,
                    t1.has_totals,
                    t2.has_totals,
                    t1.display_name,
                    t2.display_name,
                    t2.columns.len(),
                );
                for (i, (c1, c2)) in t1.columns.iter().zip(t2.columns.iter()).enumerate() {
                    println!(
                        "  col[{}] id=({}->{}) display=({:?}->{:?}) totals=({:?}->{:?})",
                        i,
                        c1.id,
                        c2.id,
                        c1.display,
                        c2.display,
                        c1.totals_function,
                        c2.totals_function
                    );
                }
            }
        }
    }

    let _ = std::fs::remove_file(&tmp);
}

/// Probe 8: UpdateOriginal preservation + Strict policy probe.
/// Pick a fixture that has theme/docProps/comments/drawings — verify
/// what survives, what gets dropped, and that Strict actually errors.
#[test]
#[ignore]
fn deep_update_original_strict_policy() {
    let candidate = std::path::Path::new(FIXTURE_ROOT).join("ironcalc/xlsx/tests/example.xlsx");
    if !candidate.exists() {
        println!("skip: missing fixture {}", candidate.display());
        return;
    }
    let registry = registry();

    // First import with preserve_package = true.
    let result = import_xlsx_path(
        &candidate,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            preserve_package: true,
            ..Default::default()
        },
    )
    .expect("import");
    let preservation = result.preservation.expect("preservation");
    println!(
        "imported {}, original_bytes={}",
        candidate.display(),
        preservation.original_bytes.len()
    );
    println!(
        "feature_inventory: {:?}",
        result.report.feature_inventory.counts
    );

    // UpdateOriginal with Permissive.
    let tmp_perm = std::env::temp_dir().join("opus-a-perm.xlsx");
    let _ = std::fs::remove_file(&tmp_perm);
    let perm_report = export_xlsx_path(
        &result.workbook,
        &registry,
        &tmp_perm,
        XlsxExportOptions {
            mode: ExportMode::UpdateOriginal {
                source: preservation.clone(),
            },
            unsupported_policy: UnsupportedPolicy::Permissive,
            formula_cache: FormulaCachePolicy::WriteRecomputed,
        },
    )
    .expect("permissive export");
    println!(
        "permissive: cells={} caches={} dropped={} warnings={}",
        perm_report.cells_written,
        perm_report.formula_caches_written,
        perm_report.dropped_features.len(),
        perm_report.warnings.len()
    );
    for d in &perm_report.dropped_features {
        println!(
            "  PERM-DROP kind={:?} part={:?} detail={:?}",
            d.kind, d.part, d.detail
        );
    }
    // Re-import and check.
    if let Ok(re) = import_xlsx_path(
        &tmp_perm,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    ) {
        println!(
            "perm re-import: sheets={} fml={} ovrl={} names={} tables={}",
            re.workbook.sheet_count(),
            re.workbook.iter_formulas().count(),
            (0..re.workbook.sheet_count() as u16)
                .filter_map(|s| re.workbook.sheet(s))
                .map(|s| s.format_overlay().len())
                .sum::<usize>(),
            re.workbook.names().len(),
            re.workbook.tables().len(),
        );
    } else {
        println!("perm re-import FAILED");
    }
    let _ = std::fs::remove_file(&tmp_perm);

    // UpdateOriginal with Strict — should error if there were drops.
    let tmp_strict = std::env::temp_dir().join("opus-a-strict.xlsx");
    let _ = std::fs::remove_file(&tmp_strict);
    let strict_outcome = export_xlsx_path(
        &result.workbook,
        &registry,
        &tmp_strict,
        XlsxExportOptions {
            mode: ExportMode::UpdateOriginal {
                source: preservation,
            },
            unsupported_policy: UnsupportedPolicy::Strict,
            formula_cache: FormulaCachePolicy::WriteRecomputed,
        },
    );
    println!(
        "strict outcome: {:?}",
        strict_outcome.as_ref().err().map(|e| format!("{e}"))
    );
    // Cleanup whatever the strict path may have left.
    let _ = std::fs::remove_file(&tmp_strict);
}

/// Probe 9: synthetic — VBA + comments + drawings in UpdateOriginal
/// Strict mode. Build a fake preservation package that contains
/// `xl/vbaProject.bin` and a comments part; verify Strict errors and
/// Permissive populates dropped_features.
#[test]
#[ignore]
fn deep_strict_with_vba() {
    // Build a tiny preservation package with VBA.
    let mut buf: Vec<u8> = Vec::new();
    {
        use std::io::Write;
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let parts: &[(&str, &str)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#,
            ),
            ("xl/vbaProject.bin", "fake-vba-bytes"),
        ];
        for (name, content) in parts {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(content.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    // Import it (Permissive — VBA is in inventory but doesn't fail).
    let registry = registry();
    let tmp_in = std::env::temp_dir().join("opus-a-vba-src.xlsx");
    std::fs::write(&tmp_in, &buf).unwrap();
    let result = import_xlsx_path(
        &tmp_in,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            preserve_package: true,
            ..Default::default()
        },
    )
    .expect("import-vba");
    let preservation = result.preservation.unwrap();

    println!(
        "vba inventory: {:?}",
        result.report.feature_inventory.counts
    );

    // Permissive UpdateOriginal — VBA should land in dropped_features.
    let tmp_perm = std::env::temp_dir().join("opus-a-vba-perm.xlsx");
    let _ = std::fs::remove_file(&tmp_perm);
    let perm = export_xlsx_path(
        &result.workbook,
        &registry,
        &tmp_perm,
        XlsxExportOptions {
            mode: ExportMode::UpdateOriginal {
                source: preservation.clone(),
            },
            unsupported_policy: UnsupportedPolicy::Permissive,
            formula_cache: FormulaCachePolicy::WriteRecomputed,
        },
    )
    .expect("perm export with vba");
    println!(
        "vba perm dropped: {:?}",
        perm.dropped_features
            .iter()
            .map(|d| format!("{:?}", d.kind))
            .collect::<Vec<_>>()
    );
    let _ = std::fs::remove_file(&tmp_perm);

    // Strict UpdateOriginal — should error.
    let tmp_strict = std::env::temp_dir().join("opus-a-vba-strict.xlsx");
    let _ = std::fs::remove_file(&tmp_strict);
    let strict = export_xlsx_path(
        &result.workbook,
        &registry,
        &tmp_strict,
        XlsxExportOptions {
            mode: ExportMode::UpdateOriginal {
                source: preservation,
            },
            unsupported_policy: UnsupportedPolicy::Strict,
            formula_cache: FormulaCachePolicy::WriteRecomputed,
        },
    );
    println!(
        "vba strict outcome: {:?}",
        strict.as_ref().err().map(|e| format!("{e}"))
    );
    println!("vba strict result_path_exists: {}", tmp_strict.exists());
    let _ = std::fs::remove_file(&tmp_strict);
    let _ = std::fs::remove_file(&tmp_in);
}

/// Probe 10: NewWorkbook + Strict — does export Strict do anything
/// at all? (We expect it doesn't — NewWorkbook has nothing to drop.)
#[test]
#[ignore]
fn deep_strict_new_workbook() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    wb.put_at(0, 0, 0, Value::Number(42.0));
    // Add a Constant(Error) name — render_named_target drops these
    // silently. Does Strict catch that?
    wb.set_name(
        "Bad",
        NamedTarget::Constant(Value::Error(ql_types::ErrorValue::Ref)),
    )
    .unwrap();
    let tmp = std::env::temp_dir().join("opus-a-strict-new.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let r = export_xlsx_path(
        &wb,
        &registry(),
        &tmp,
        XlsxExportOptions {
            mode: ExportMode::NewWorkbook,
            unsupported_policy: UnsupportedPolicy::Strict,
            formula_cache: FormulaCachePolicy::WriteRecomputed,
        },
    );
    match r {
        Ok(rep) => println!(
            "NewWorkbook+Strict OK: cells={} dropped_features={} (Bad-name drop is INVISIBLE!)",
            rep.cells_written,
            rep.dropped_features.len()
        ),
        Err(e) => println!("NewWorkbook+Strict ERR: {e}"),
    }
    let _ = std::fs::remove_file(&tmp);
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
