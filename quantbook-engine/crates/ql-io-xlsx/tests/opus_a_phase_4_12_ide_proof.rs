#![allow(
    unused_imports,
    dead_code,
    unused_mut,
    unused_variables,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]

//! Phase 4.12 — IDE proof-point cross-feature probes (Opus-A).
//!
//! Master plan Phase 4 claim: "IDE must open imported xlsx, show
//! formulas, edit formulas, save .qbook, export xlsx".
//!
//! This file empirically tests each leg of that claim.
//!
//! Run with:
//!   cargo test -p ql-io-xlsx --test opus_a_phase_4_12_ide_proof \
//!     -- --ignored --nocapture <name>

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
    UnsupportedPolicy, XlsxExportOptions, XlsxImportOptions,
};
use ql_storage::{NamedTarget, Workbook};
use ql_types::Value;

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

const FIXTURE_ROOT: &str = "../../.references";

fn pick_fixture(suffix: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(FIXTURE_ROOT).join(suffix)
}

// ---------------------------------------------------------------------
// P1: Import → recompute. If formulas use literal ranges in SUM
// (Excel canon e.g. `=SUM(A1:A10)`), do they recompute correctly or do
// they end up as `#ERROR` cells in the import report?
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn p1_import_recompute_formulas_bind_success_rate() {
    let path = pick_fixture("ironcalc/xlsx/tests/calc_tests/sum.xlsx");
    if !path.exists() {
        // Try another fixture.
        let alt = pick_fixture("ironcalc/xlsx/tests/openpyxl_example.xlsx");
        run_recompute_probe(&alt);
        return;
    }
    run_recompute_probe(&path);
}

fn run_recompute_probe(path: &std::path::Path) {
    let reg = registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::BestEffort,
        unsupported_policy: UnsupportedPolicy::Permissive,
        preserve_package: false,
    };
    let result = import_xlsx_path(path, &reg, opts);
    match result {
        Ok(r) => {
            let n_formulas = r.workbook.formula_count();
            let n_failures = r.report.formula_failures.len();
            println!(
                "[P1] fixture={} formulas_total={} failures={} (fail_pct={:.1}%)",
                path.display(),
                n_formulas,
                n_failures,
                if n_formulas > 0 {
                    100.0 * (n_failures as f64) / (n_formulas as f64)
                } else {
                    0.0
                }
            );
            for f in r.report.formula_failures.iter().take(10) {
                println!(
                    "  fail: sheet={} row={} col={} formula={:?} reason={}",
                    f.sheet, f.row, f.col, f.formula, f.reason
                );
            }
            if n_failures > 0 && !r.report.formula_failures.is_empty() {
                // Pattern-detect literal-range bind failures.
                let n_literal_range_fail = r
                    .report
                    .formula_failures
                    .iter()
                    .filter(|f| f.reason.contains("literal RangeRef"))
                    .count();
                if n_literal_range_fail > 0 {
                    println!(
                        "[P1 FINDING] {n_literal_range_fail} formula failures \
                        are 'literal RangeRef in non-Function context' bind \
                        errors. This breaks the IDE proof: a basic =SUM(A1:A10) \
                        from imported Excel binds and recomputes as a #ERROR \
                        cell in the engine."
                    );
                }
            }
        }
        Err(e) => {
            println!("[P1] import failed: {e:?}");
        }
    }
}

/// P2: import → set_formula a NEW formula post-import (IDE edit) →
/// verify it evaluates.
#[test]
#[ignore]
fn p2_import_then_edit_formula() {
    let path = pick_fixture("ironcalc/xlsx/tests/openpyxl_example.xlsx");
    if !path.exists() {
        println!("[P2] fixture not found: {}", path.display());
        return;
    }
    let reg = registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let imported = import_xlsx_path(&path, &reg, opts).unwrap();
    let mut wb = imported.workbook;

    // Find first sheet, write a small formula in a far-away cell.
    let s = 0u16;
    let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s, 100, 0, ql_types::Value::Number(7.0))
        .unwrap();
    rt.set_value(s, 101, 0, ql_types::Value::Number(13.0))
        .unwrap();
    // Try a literal-range SUM — the canonical IDE-edit use case.
    let v_lit = rt.set_formula(s, 102, 0, "SUM(A101:A102)");
    println!("[P2] post-import edit SUM(A101:A102) = {v_lit:?}");
    // Try comma form.
    let v_comma = rt.set_formula(s, 102, 1, "SUM(A101, A102)");
    println!("[P2] post-import edit SUM(A101, A102) = {v_comma:?}");
    if v_lit.is_err() && v_comma.is_ok() {
        println!(
            "[P2 FINDING] post-import IDE edit: literal-range form rejected, \
            comma form accepted. User-facing impact: the most common \
            Excel formula pattern (=SUM(A1:A10)) fails when typed in our \
            IDE — they must rewrite as =SUM(A1, A2, …). This contradicts \
            the master plan Phase 4 IDE claim."
        );
    }
}

/// P3: round-trip a workbook with formulas using literal-range SUM.
/// Does the round-trip preserve them? Does recompute work?
#[test]
#[ignore]
fn p3_roundtrip_with_literal_range_sum() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Data");
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Number(1.0)).unwrap();
        rt.set_value(s, 1, 0, Value::Number(2.0)).unwrap();
        rt.set_value(s, 2, 0, Value::Number(3.0)).unwrap();
        // Use comma form (the only one that binds today).
        let _ = rt.set_formula(s, 3, 0, "SUM(A1, A2, A3)").unwrap();
    }
    let tmp = temp_dir().join("opus-a-roundtrip-sum.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let reg = registry();
    export_xlsx_path(&wb, &reg, &tmp, XlsxExportOptions::default()).unwrap();

    // Verify the EXPORTED .xlsx has the formula. Then re-import + recompute.
    let imported = import_xlsx_path(
        &tmp,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let n_failures = imported.report.formula_failures.len();
    let val = imported.workbook.read(ql_types::Address::new(s, 3, 0));
    println!("[P3] roundtrip: formula failures = {n_failures}, recomputed value = {val:?}");
    if val != Value::Number(6.0) {
        println!(
            "[P3 FINDING] roundtrip dropped value: A4 = {val:?}, \
            expected 6.0 (SUM(A1, A2, A3))"
        );
    }
    for f in imported.report.formula_failures.iter().take(5) {
        println!(
            "  fail: row={} col={} text={:?} reason={}",
            f.row, f.col, f.formula, f.reason
        );
    }
    let _ = std::fs::remove_file(&tmp);
}

/// P4: round-trip with cross-sheet refs + named ranges + custom format.
/// Verify each survives.
#[test]
#[ignore]
fn p4_roundtrip_multi_feature_workbook() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s1, 0, 0, Value::Number(10.0)).unwrap();
        rt.set_value(s1, 1, 0, Value::Number(20.0)).unwrap();
        rt.set_value(s1, 2, 0, Value::Number(30.0)).unwrap();
        rt.set_name(
            "QTotal",
            NamedTarget::Range(ql_types::Range::new(s1, 0, 0, 2, 0)),
        )
        .unwrap();
        let _ = rt.set_formula(s2, 0, 0, "SUM(QTotal)").unwrap();
        let _ = rt.set_formula(s2, 1, 0, "Data!A1+Data!A2").unwrap();
        let fmt = rt.intern_format("$#,##0.00").unwrap();
        rt.set_cell_format(s2, 0, 0, Some(fmt)).unwrap();
    }
    let tmp = temp_dir().join("opus-a-multi-feature.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let reg = registry();
    export_xlsx_path(&wb, &reg, &tmp, XlsxExportOptions::default()).unwrap();

    let imported = import_xlsx_path(
        &tmp,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            preserve_package: true,
            ..Default::default()
        },
    )
    .unwrap();
    let wb2 = &imported.workbook;
    let v_named = wb2.read(ql_types::Address::new(s2, 0, 0));
    let v_cross = wb2.read(ql_types::Address::new(s2, 1, 0));
    let has_name = wb2.names().lookup_ci("QTotal").is_some();
    println!(
        "[P4] roundtrip: named-range SUM(QTotal) = {v_named:?}, cross-sheet \
        Data!A1+Data!A2 = {v_cross:?}, name preserved = {has_name}"
    );
    if v_named != Value::Number(60.0) {
        println!("[P4 FINDING] named-range SUM lost on roundtrip: {v_named:?}");
    }
    if v_cross != Value::Number(30.0) {
        println!("[P4 FINDING] cross-sheet ref lost on roundtrip: {v_cross:?}");
    }
    if !has_name {
        println!("[P4 FINDING] named range dropped on roundtrip");
    }
    // Was the custom format preserved? Walk the format table directly.
    let mut custom_formats: Vec<(u32, String)> = Vec::new();
    for (id, s) in wb2.formats().iter() {
        // Step 3: `is_custom()` replaces the pre-step-3 `id.0 >= 164` filter.
        if id.is_custom() {
            custom_formats.push((
                id.to_legacy_u32()
                    .expect("pre-step-6 xlsx test sees only legacy FormatId"),
                s.to_owned(),
            ));
        }
    }
    println!("[P4] custom formats post-roundtrip: {custom_formats:?}");
    let has_currency_fmt = custom_formats.iter().any(|(_, s)| s.contains("$#,##0"));
    if !has_currency_fmt {
        println!("[P4 FINDING] custom format '$#,##0.00' lost on roundtrip");
    }
    // What format does the cell display now?
    {
        let mut clone = imported.workbook.clone();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut clone, &reg);
        let d = rt.read_display(s2, 0, 0);
        println!("[P4] post-roundtrip Report!A1 display: {d:?}");
    }
    let _ = std::fs::remove_file(&tmp);
}

/// P5: Quantbook workbook → export xlsx → re-import → export again →
/// verify identity (or close to it).
#[test]
#[ignore]
fn p5_double_roundtrip_stability() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        for i in 0..10u32 {
            rt.set_value(s, i, 0, Value::Number(i as f64)).unwrap();
        }
        // Cell with a formula.
        let _ = rt.set_formula(s, 10, 0, "A1+A2+A3").unwrap();
    }
    let reg = registry();
    let p1 = temp_dir().join("opus-a-rt-1.xlsx");
    let p2 = temp_dir().join("opus-a-rt-2.xlsx");
    let _ = std::fs::remove_file(&p1);
    let _ = std::fs::remove_file(&p2);

    export_xlsx_path(&wb, &reg, &p1, XlsxExportOptions::default()).unwrap();
    let r1 = import_xlsx_path(
        &p1,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let wb1 = r1.workbook;
    export_xlsx_path(&wb1, &reg, &p2, XlsxExportOptions::default()).unwrap();
    let r2 = import_xlsx_path(
        &p2,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let wb2 = r2.workbook;

    let mut divergence_cells: Vec<(u32, Value, Value)> = Vec::new();
    for i in 0..11u32 {
        let v1 = wb1.read(ql_types::Address::new(s, i, 0));
        let v2 = wb2.read(ql_types::Address::new(s, i, 0));
        if v1 != v2 {
            divergence_cells.push((i, v1, v2));
        }
    }
    if !divergence_cells.is_empty() {
        println!("[P5 FINDING] double-roundtrip divergence:");
        for (i, v1, v2) in &divergence_cells {
            println!("  row {i}: 1st={v1:?}, 2nd={v2:?}");
        }
    } else {
        println!("[P5 OK] double-roundtrip stable");
    }
    let _ = std::fs::remove_file(&p1);
    let _ = std::fs::remove_file(&p2);
}

/// P6: Localized formula round-trip. Set a workbook to de-DE locale,
/// store a formula, export, re-import. Does the locale survive?
#[test]
#[ignore]
fn p6_locale_survives_xlsx_roundtrip() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.set_locale(ql_types::Locale::De);
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        // de-locale input: should parse as 4.0 + 1.5.
        let _ = rt.set_formula(s, 0, 0, "1,5+2,5").unwrap();
    }
    let reg = registry();
    let p = temp_dir().join("opus-a-locale.xlsx");
    let _ = std::fs::remove_file(&p);
    export_xlsx_path(&wb, &reg, &p, XlsxExportOptions::default()).unwrap();
    let r = import_xlsx_path(
        &p,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let val = r.workbook.read(ql_types::Address::new(s, 0, 0));
    let stored = r
        .workbook
        .formula_at(s, 0, 0)
        .map(|s| s.as_ref().to_owned());
    println!("[P6] roundtripped locale=de, formula='1,5+2,5': val={val:?}, stored={stored:?}");
    if val != Value::Number(4.0) {
        println!("[P6 FINDING] post-roundtrip de-locale formula lost: {val:?}");
    }
    let _ = std::fs::remove_file(&p);
}

/// P7: Date1904 round-trip. Workbook is configured for date1904; a
/// formula uses YEAR() which should respect that. Round-trip and verify
/// the date system is preserved.
#[test]
#[ignore]
fn p7_date1904_survives_roundtrip() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.set_date_system(ql_types::DateSystem::Excel1904);
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Number(36526.0)).unwrap();
        let _ = rt.set_formula(s, 1, 0, "YEAR(A1)").unwrap();
    }
    let reg = registry();
    let p = temp_dir().join("opus-a-1904.xlsx");
    let _ = std::fs::remove_file(&p);
    export_xlsx_path(&wb, &reg, &p, XlsxExportOptions::default()).unwrap();
    let r = import_xlsx_path(
        &p,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let yr = r.workbook.read(ql_types::Address::new(s, 1, 0));
    let ds = r.workbook.date_system();
    println!("[P7] post-roundtrip: date_system = {ds:?}, YEAR(36526) = {yr:?}");
    if ds != ql_types::DateSystem::Excel1904 {
        println!("[P7 FINDING] date_system dropped on roundtrip: {ds:?}");
    }
    if yr != Value::Number(2004.0) {
        println!("[P7 FINDING] YEAR result after 1904 roundtrip wrong: {yr:?}");
    }
    let _ = std::fs::remove_file(&p);
}

/// P8: Verify that engine-exported xlsx files contain readable formula
/// cell values (FormulaCachePolicy::WriteRecomputed).
#[test]
#[ignore]
fn p8_export_writes_recomputed_cached_values() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Number(2.0)).unwrap();
        rt.set_value(s, 1, 0, Value::Number(3.0)).unwrap();
        let _ = rt.set_formula(s, 2, 0, "A1+A2").unwrap();
    }
    let reg = registry();
    let p = temp_dir().join("opus-a-export-cache.xlsx");
    let _ = std::fs::remove_file(&p);
    // Default cache policy WriteRecomputed.
    export_xlsx_path(&wb, &reg, &p, XlsxExportOptions::default()).unwrap();

    // Re-import with RecomputeMode::Skip — cell value should still come
    // from cached value.
    let r = import_xlsx_path(
        &p,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let val = r.workbook.read(ql_types::Address::new(s, 2, 0));
    let stored = r
        .workbook
        .formula_at(s, 2, 0)
        .map(|s| s.as_ref().to_owned());
    println!("[P8] skip-recompute: A3 value = {val:?}, formula text = {stored:?}");
    if val != Value::Number(5.0) {
        println!(
            "[P8 FINDING] cached value missing on Skip recompute: got {val:?}, \
            expected 5.0 (FormulaCachePolicy::WriteRecomputed should preserve it)"
        );
    }
    let _ = std::fs::remove_file(&p);
}

/// P12: investigate the "prefix comma" parse failures — find the
/// formula text shapes that fail.
#[test]
#[ignore]
fn p12_prefix_comma_failure_shapes() {
    let dir = std::path::Path::new(FIXTURE_ROOT).join("ironcalc/xlsx/tests/calc_tests");
    if !dir.exists() {
        return;
    }
    let reg = registry();
    let mut samples: Vec<String> = Vec::new();
    let mut count_omitted_arg = 0usize;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("xlsx") {
            continue;
        }
        let r = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            import_xlsx_path(
                &path,
                &reg,
                XlsxImportOptions {
                    recompute: RecomputeMode::BestEffort,
                    ..Default::default()
                },
            )
        })) {
            Ok(Ok(r)) => r,
            _ => continue,
        };
        for f in &r.report.formula_failures {
            if f.reason.contains("prefix") && f.reason.contains("Comma") {
                if samples.len() < 30 {
                    samples.push(format!(
                        "{}: {:?}",
                        path.file_name().unwrap().to_string_lossy(),
                        f.formula
                    ));
                }
                // Check if it looks like a Comma-immediately-after-LParen
                // (omitted leading arg)
                if f.formula.contains("(,") || f.formula.contains(", ,") || f.formula.contains(",,")
                {
                    count_omitted_arg += 1;
                }
            }
        }
    }
    println!("[P12] sample prefix-comma failures:");
    for s in samples.iter().take(30) {
        println!("  {s}");
    }
    println!("[P12] count with literal omitted-arg pattern: {count_omitted_arg}");
    if !samples.is_empty() {
        println!(
            "[P12 FINDING] {} prefix-comma parser failures sampled. Excel \
            supports omitted-arg syntax like IF(A1,,B1) or VLOOKUP(x,t,c,) — \
            our parser doesn't accept these.",
            samples.len()
        );
    }
}

/// P11: directly probe EVEN() overflow panic.
#[test]
#[ignore]
fn p11_even_overflow_panic() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let reg = registry();
    let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
    // Probe with f64 values that overflow i64 when EVEN()/ODD() casts.
    let inputs = [
        1e18,
        9.22e18,
        f64::MAX / 2.0,
        f64::MAX,
        -1e18,
        -f64::MAX,
        i64::MAX as f64,
    ];
    for (i, n) in inputs.iter().enumerate() {
        let r_even = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            rt.set_value(s, i as u32, 0, Value::Number(*n)).unwrap();
            rt.set_formula(s, i as u32, 1, format!("EVEN(A{})", i + 1))
        }));
        let r_odd = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            rt.set_formula(s, i as u32, 2, format!("ODD(A{})", i + 1))
        }));
        println!("[P11] n={n}: EVEN={r_even:?}, ODD={r_odd:?}");
        if r_even.is_err() {
            println!("[P11 FINDING] EVEN({n}) panicked — i64 overflow in cast");
        }
        if r_odd.is_err() {
            println!("[P11 FINDING] ODD({n}) panicked — i64 overflow in cast");
        }
    }
}

/// P10: SWEEP across many calc_tests/*.xlsx — measure how often
/// imported xlsx files hit the literal-RangeRef bind failure during
/// recompute. If a significant fraction fail, the IDE-edit claim is
/// broken.
#[test]
#[ignore]
fn p10_sweep_calc_tests_recompute_failure_rate() {
    let dir = std::path::Path::new(FIXTURE_ROOT).join("ironcalc/xlsx/tests/calc_tests");
    if !dir.exists() {
        println!("[P10] dir not found: {}", dir.display());
        return;
    }
    let reg = registry();
    let mut total_formulas = 0usize;
    let mut total_failures = 0usize;
    let mut literal_range_failures = 0usize;
    let mut files_with_failures = 0usize;
    let mut files_with_literal_range_failures: Vec<String> = Vec::new();
    let mut sample_reasons: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("xlsx") {
            continue;
        }
        let opts = XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        };
        let r = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            import_xlsx_path(&path, &reg, opts.clone())
        })) {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => continue,
            Err(_) => {
                println!(
                    "[P10 PANIC] panic while importing {}",
                    path.file_name().unwrap().to_string_lossy()
                );
                continue;
            }
        };
        let nf = r.workbook.formula_count();
        let nfail = r.report.formula_failures.len();
        total_formulas += nf;
        total_failures += nfail;
        if nfail > 0 {
            files_with_failures += 1;
        }
        let lrf = r
            .report
            .formula_failures
            .iter()
            .filter(|f| f.reason.contains("literal RangeRef"))
            .count();
        literal_range_failures += lrf;
        if lrf > 0 {
            files_with_literal_range_failures
                .push(path.file_name().unwrap().to_string_lossy().to_string());
        }
        for f in &r.report.formula_failures {
            // Bucket the reason by first 80 chars.
            let key = f.reason.chars().take(80).collect::<String>();
            *sample_reasons.entry(key).or_insert(0) += 1;
        }
    }
    println!(
        "[P10 SWEEP] calc_tests: total_formulas={total_formulas}, total_failures={total_failures} \
        (literal_RangeRef={literal_range_failures}); \
        files_with_failures={files_with_failures}, \
        files_with_literal_range_fail={}",
        files_with_literal_range_failures.len()
    );
    println!("[P10 SWEEP] reason buckets:");
    let mut bucket_vec: Vec<_> = sample_reasons.into_iter().collect();
    bucket_vec.sort_by(|a, b| b.1.cmp(&a.1));
    for (reason, n) in bucket_vec.iter().take(10) {
        println!("  ({n}) {reason}");
    }
    println!("[P10 SWEEP] files with literal-RangeRef failures (top 10):");
    for f in files_with_literal_range_failures.iter().take(10) {
        println!("  {f}");
    }
    if literal_range_failures > 0 {
        println!(
            "[P10 FINDING] {literal_range_failures} formulas across {} files \
            failed to bind because of the literal-RangeRef restriction. \
            Phase 4 IDE proof point unmet on this volume.",
            files_with_literal_range_failures.len()
        );
    }
}

/// P13: full IDE proof point — import xlsx, save to .qbook, load
/// back, export xlsx. Verify the formulas + names + tables survive.
#[test]
#[ignore]
fn p13_full_ide_proof_point_xlsx_qbook_xlsx() {
    use ql_io::{load_workbook_with_oplog, save_workbook_with_oplog};
    use ql_oplog::OpLog;
    use std::env::temp_dir;

    // STAGE 1: Build a workbook with rich features (skipping
    // literal-range SUM since we know it fails).
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    let reg = registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = ql_exec::WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(s1, 0, 0, Value::Number(1.0)).unwrap();
        rt.set_value(s1, 1, 0, Value::Number(2.0)).unwrap();
        rt.set_value(s1, 2, 0, Value::Number(3.0)).unwrap();
        rt.set_name(
            "MyData",
            NamedTarget::Range(ql_types::Range::new(s1, 0, 0, 2, 0)),
        )
        .unwrap();
        rt.set_formula(s2, 0, 0, "SUM(MyData)").unwrap();
        let fmt = rt.intern_format("0.000").unwrap();
        rt.set_cell_format(s2, 0, 0, Some(fmt)).unwrap();
    }
    // STAGE 1B: Export to xlsx.
    let xlsx_path = temp_dir().join("opus-a-ide-stage1.xlsx");
    let _ = std::fs::remove_file(&xlsx_path);
    export_xlsx_path(&wb, &reg, &xlsx_path, XlsxExportOptions::default()).unwrap();
    println!("[P13] Stage 1: exported xlsx");

    // STAGE 2: Import xlsx (IDE: "open file").
    let imported = import_xlsx_path(
        &xlsx_path,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let v1 = imported.workbook.read(ql_types::Address::new(s2, 0, 0));
    println!("[P13] Stage 2: imported xlsx, =SUM(MyData) = {v1:?}");
    if v1 != Value::Number(6.0) {
        println!("[P13 FINDING] xlsx-import dropped formula value: {v1:?}");
    }

    // STAGE 3: Save to .qbook (IDE: "save as quantbook").
    let mut wb2 = imported.workbook;
    let oplog2 = OpLog::new();
    let qbook_dir = temp_dir().join("opus-a-ide.qbook");
    let _ = std::fs::remove_dir_all(&qbook_dir);
    save_workbook_with_oplog(&wb2, &oplog2, "opus-a-ide", &qbook_dir).unwrap();
    println!("[P13] Stage 3: saved .qbook");

    // STAGE 4: Load .qbook back (IDE: "reopen").
    let (mut wb3, _ol3) = load_workbook_with_oplog(&qbook_dir).unwrap();
    {
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb3, &reg);
        let _ = rt.recompute_all();
    }
    let v3 = wb3.read(ql_types::Address::new(s2, 0, 0));
    println!("[P13] Stage 4: loaded .qbook, =SUM(MyData) = {v3:?}");
    if v3 != Value::Number(6.0) {
        println!("[P13 FINDING] qbook-roundtrip dropped formula value: {v3:?}");
    }

    // STAGE 5: Export xlsx from the loaded .qbook (IDE: "save as xlsx").
    let xlsx_path2 = temp_dir().join("opus-a-ide-stage5.xlsx");
    let _ = std::fs::remove_file(&xlsx_path2);
    export_xlsx_path(&wb3, &reg, &xlsx_path2, XlsxExportOptions::default()).unwrap();
    println!("[P13] Stage 5: re-exported xlsx");

    // STAGE 6: Reimport that xlsx, verify final state.
    let r6 = import_xlsx_path(
        &xlsx_path2,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let v6 = r6.workbook.read(ql_types::Address::new(s2, 0, 0));
    println!("[P13] Stage 6: re-imported xlsx, =SUM(MyData) = {v6:?}");
    if v6 != Value::Number(6.0) {
        println!("[P13 FINDING] full IDE-flow round trip dropped value: {v6:?}");
    }
    let has_name = r6.workbook.names().lookup_ci("MyData").is_some();
    let custom_count: usize = r6
        .workbook
        .formats()
        .iter()
        .filter(|(id, _)| id.is_custom())
        .count();
    println!("[P13] Stage 6: name preserved={has_name}, custom_formats={custom_count}");
    if !has_name {
        println!("[P13 FINDING] named range lost in full IDE round-trip");
    }
    if custom_count == 0 {
        println!("[P13 FINDING] custom format lost in full IDE round-trip");
    }
    let _ = std::fs::remove_file(&xlsx_path);
    let _ = std::fs::remove_file(&xlsx_path2);
    let _ = std::fs::remove_dir_all(&qbook_dir);
}

/// P15: post-import EDIT trying to overwrite an existing literal-range
/// SUM formula. Does the IDE flow surface the bind error correctly to
/// the user?
#[test]
#[ignore]
fn p15_edit_imported_literal_range_formula() {
    // Use ironcalc/xlsx/tests/calc_tests/SUM.xlsx if available; else
    // build synthetic by importing one with literal-range formula.
    let dir = std::path::Path::new(FIXTURE_ROOT).join("ironcalc/xlsx/tests/calc_tests");
    if !dir.exists() {
        println!("[P15] dir not found");
        return;
    }
    let mut chosen = None;
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().and_then(|e| e.to_str()) == Some("xlsx") {
            let name = p.file_name().unwrap().to_string_lossy().to_lowercase();
            if name.contains("sum") || name.contains("xlookup") {
                chosen = Some(p);
                break;
            }
        }
    }
    let path = match chosen {
        Some(p) => p,
        None => return,
    };
    let reg = registry();
    let imported = import_xlsx_path(
        &path,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let nf = imported.report.formula_failures.len();
    println!(
        "[P15] imported {}: {} formula failures (representative IDE workload)",
        path.file_name().unwrap().to_string_lossy(),
        nf
    );

    // Cell is bound to e.g. SUM(A1:A10) which couldn't bind. The user
    // hits Enter to recommit the formula text — does it now report the
    // bind error?
    let mut wb = imported.workbook;
    let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
    // Pick the first failure cell.
    if let Some(f) = imported.report.formula_failures.first() {
        let result = rt.set_formula(f.sheet, f.row, f.col, f.formula.as_str());
        println!("[P15] re-set_formula on failed cell: {result:?}");
        if result.is_err() {
            println!(
                "[P15 FINDING] formula text that imports successfully fails \
                to re-bind on user edit. Cell (sheet={}, row={}, col={}) \
                text={:?} can't be recommitted. IDE save flow broken.",
                f.sheet, f.row, f.col, f.formula
            );
        }
    }
}

/// P14: cross-feature crash test — table with formula values referenced
/// across sheet + name + format + locale all at once, then save/load.
#[test]
#[ignore]
fn p14_qbook_persistence_with_full_phase4_features() {
    use ql_io::{load_workbook_with_oplog, save_workbook_with_oplog};
    use ql_oplog::OpLog;
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    wb.set_locale(ql_types::Locale::De);
    wb.set_date_system(ql_types::DateSystem::Excel1904);
    let reg = registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = ql_exec::WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(s1, 0, 0, Value::Text("Qty".into())).unwrap();
        rt.set_value(s1, 1, 0, Value::Number(10.0)).unwrap();
        rt.set_value(s1, 2, 0, Value::Number(20.0)).unwrap();
        rt.create_table("Sales", s1, 0, 0, 3, 1, true, false, vec!["Qty".to_owned()])
            .unwrap();
        rt.set_formula(s2, 0, 0, "SUM(Sales[Qty])").unwrap();
        let fmt = rt.intern_format("yyyy-mm-dd").unwrap();
        rt.set_cell_format(s2, 1, 0, Some(fmt)).unwrap();
        rt.set_value(s2, 1, 0, Value::Number(36526.0)).unwrap();
    }
    // Save.
    let qbook = temp_dir().join("opus-a-full-feature.qbook");
    let _ = std::fs::remove_dir_all(&qbook);
    save_workbook_with_oplog(&wb, &oplog, "opus-a-full-feature", &qbook).unwrap();
    // Load.
    let (mut wb2, _ol2) = load_workbook_with_oplog(&qbook).unwrap();
    let locale_after = wb2.locale();
    let date_after = wb2.date_system();
    let has_table = wb2.tables().lookup("SALES").is_some();
    let custom_count: usize = wb2
        .formats()
        .iter()
        .filter(|(id, _)| id.is_custom())
        .count();
    println!(
        "[P14] post-qbook-rt: locale={locale_after:?}, date={date_after:?}, \
        table_preserved={has_table}, custom_formats={custom_count}"
    );
    {
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb2, &reg);
        let _ = rt.recompute_all();
    }
    let v = wb2.read(ql_types::Address::new(s2, 0, 0));
    println!("[P14] post-qbook-rt SUM(Sales[Qty]) = {v:?}");
    if v != Value::Number(30.0) {
        println!("[P14 FINDING] structured-ref formula broke after .qbook round trip: {v:?}");
    }
    if locale_after != ql_types::Locale::De {
        println!("[P14 FINDING] locale lost on .qbook round trip: {locale_after:?}");
    }
    if date_after != ql_types::DateSystem::Excel1904 {
        println!("[P14 FINDING] date_system lost on .qbook round trip: {date_after:?}");
    }
    if !has_table {
        println!("[P14 FINDING] table lost on .qbook round trip");
    }
    if custom_count == 0 {
        println!("[P14 FINDING] custom format lost on .qbook round trip");
    }
    let _ = std::fs::remove_dir_all(&qbook);
}

/// P9: Tables — create a table, export, re-import, verify it's
/// recognized. Then add a formula using the table on import.
#[test]
#[ignore]
fn p9_table_roundtrip_then_structured_ref() {
    use std::env::temp_dir;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Data");
    {
        let reg = registry();
        let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Text("Qty".into())).unwrap();
        rt.set_value(s, 1, 0, Value::Number(1.0)).unwrap();
        rt.set_value(s, 2, 0, Value::Number(2.0)).unwrap();
        rt.set_value(s, 3, 0, Value::Number(3.0)).unwrap();
        rt.create_table("Sales", s, 0, 0, 4, 1, true, false, vec!["Qty".to_owned()])
            .unwrap();
    }
    let reg = registry();
    let p = temp_dir().join("opus-a-table-rt.xlsx");
    let _ = std::fs::remove_file(&p);
    export_xlsx_path(&wb, &reg, &p, XlsxExportOptions::default()).unwrap();

    let mut r = import_xlsx_path(
        &p,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let has_table = r.workbook.tables().lookup("SALES").is_some();
    println!("[P9] table 'Sales' preserved on roundtrip: {has_table}");

    // Now add a structured-ref formula post-import.
    let mut rt = ql_exec::WorkbookRuntime::new(&mut r.workbook, &reg);
    let v = rt.set_formula(s, 10, 0, "SUM(Sales[Qty])");
    println!("[P9] post-import SUM(Sales[Qty]) = {v:?}");
    if !matches!(v, Ok(Value::Number(n)) if (n - 6.0).abs() < 1e-9) {
        println!(
            "[P9 FINDING] post-roundtrip structured ref doesn't work: {v:?}, \
            expected 6.0"
        );
    }
    let _ = std::fs::remove_file(&p);
}

/// P16: BestEffort recompute on imported xlsx — verify whether cells
/// where formulas fail to bind keep their Excel-cached values or get
/// corrupted to 0/error.
#[test]
#[ignore]
fn p16_failed_formula_cached_value_preserved_or_corrupted() {
    let dir = std::path::Path::new(FIXTURE_ROOT).join("ironcalc/xlsx/tests/calc_tests");
    if !dir.exists() {
        return;
    }
    let mut chosen = None;
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            let lower = name.to_lowercase();
            if lower.contains("xlookup") {
                chosen = Some(p);
                break;
            }
        }
    }
    let path = match chosen {
        Some(p) => p,
        None => return,
    };
    let reg = registry();
    let r_skip = import_xlsx_path(
        &path,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let r_eff = import_xlsx_path(
        &path,
        &reg,
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    )
    .unwrap();
    let mut differing_cells = 0;
    let mut total_failures = 0usize;
    for f in &r_eff.report.formula_failures {
        total_failures += 1;
        let addr = ql_types::Address::new(f.sheet, f.row, f.col);
        let v_skip = r_skip.workbook.read(addr);
        let v_eff = r_eff.workbook.read(addr);
        if v_skip != v_eff {
            differing_cells += 1;
            if differing_cells <= 5 {
                println!(
                    "  failure-cell divergence: ({},{}) skip={v_skip:?}, eff={v_eff:?}",
                    f.row, f.col
                );
            }
        }
    }
    println!(
        "[P16] {}: total bind failures={total_failures}, cells where eff != skip = {differing_cells}",
        path.file_name().unwrap().to_string_lossy()
    );
    if differing_cells > 0 {
        println!(
            "[P16 FINDING] BestEffort recompute mutated {differing_cells} cells \
            in failed-formula positions. Per the doc, BestEffort 'keeps \
            imported cached values on failure' — finding contradicts that. \
            User-visible: cached Excel results change to 0 or error sentinels."
        );
    }
}
