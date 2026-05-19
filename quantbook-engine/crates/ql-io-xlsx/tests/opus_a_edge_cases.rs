#![allow(clippy::approx_constant, unused_imports, dead_code)]

//! Adversarial / edge case probes for Phase 4.11 round-trip.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
    UnsupportedPolicy, XlsxExportOptions, XlsxImportOptions,
};
use ql_storage::{FormatId, NamedTarget, Workbook};
use ql_types::Value;

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

/// Probe A: table with non-sequential column ids. Quantbook's
/// `TableColumn::id` is supposed to be stable across renames. After
/// round-trip, does the column id stay the same?
#[test]
#[ignore]
fn table_column_id_renumbering() {
    use ql_storage::{TableColumn, TableMetadata, TotalsFunction};
    use std::sync::Arc;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let t = TableMetadata {
        name: Arc::from("SPARSE"),
        display_name: Arc::from("Sparse"),
        sheet: s,
        top_row: 0,
        top_col: 0,
        rows: 3,
        cols: 3,
        has_header: true,
        has_totals: false,
        columns: vec![
            TableColumn {
                id: 5,
                name: Arc::from("a"),
                display: Arc::from("A"),
                totals_function: None,
            },
            TableColumn {
                id: 7,
                name: Arc::from("b"),
                display: Arc::from("B"),
                totals_function: None,
            },
            TableColumn {
                id: 12,
                name: Arc::from("c"),
                display: Arc::from("C"),
                totals_function: None,
            },
        ],
    };
    wb.tables_mut().insert(t.name.clone(), t);
    let tmp = std::env::temp_dir().join("opus-a-sparse-ids.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let imported = r.workbook.tables().lookup("SPARSE").unwrap();
    for (orig, back) in wb
        .tables()
        .lookup("SPARSE")
        .unwrap()
        .columns
        .iter()
        .zip(imported.columns.iter())
    {
        println!(
            "col display={:?} orig_id={} back_id={}",
            orig.display, orig.id, back.id
        );
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe B: Unicode in names, sheet names, column names, format codes.
#[test]
#[ignore]
fn unicode_survival() {
    use ql_storage::{TableColumn, TableMetadata};
    use std::sync::Arc;
    let mut wb = Workbook::new();
    // Sheet names with unicode (Russian + emoji + space).
    let s_en = wb.add_sheet("Sheet1");
    let s_ru = wb.add_sheet("Лист");
    // Quantbook may reject some chars; try a few.
    let s_emoji_result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| wb.add_sheet("test 📊")));
    println!("emoji sheet: {:?}", s_emoji_result.is_ok());

    wb.put_at(s_en, 0, 0, Value::text("héllo"));
    wb.put_at(s_en, 0, 1, Value::text("テスト"));
    wb.put_at(s_en, 0, 2, Value::text("emoji 🎉"));

    // Unicode workbook-scoped name (Quantbook may reject — test).
    let n = wb.set_name("TaxРейт", NamedTarget::Constant(Value::Number(0.21)));
    println!("unicode name set result: {:?}", n);

    // Custom format with non-ASCII (€ symbol).
    let id_euro = wb.formats_mut().intern("#,##0.00 \"€\"");
    let id_yen = wb.formats_mut().intern("¥#,##0");
    {
        let sheet = wb.sheet_mut(s_en).unwrap();
        sheet.format_overlay_mut().set(1, 0, id_euro);
        sheet.format_overlay_mut().set(1, 1, id_yen);
    }
    wb.put_at(s_en, 1, 0, Value::Number(1234.56));
    wb.put_at(s_en, 1, 1, Value::Number(8888.0));

    // Table with unicode column display name (canonical = lowercase).
    let t = TableMetadata {
        name: Arc::from("UNIDATA"),
        display_name: Arc::from("UniData"),
        sheet: s_ru,
        top_row: 0,
        top_col: 0,
        rows: 2,
        cols: 2,
        has_header: true,
        has_totals: false,
        columns: vec![
            TableColumn {
                id: 1,
                name: Arc::from("дата"),
                display: Arc::from("Дата"),
                totals_function: None,
            },
            TableColumn {
                id: 2,
                name: Arc::from("vаlue"),
                display: Arc::from("Vаlue"),
                totals_function: None,
            },
        ],
    };
    wb.tables_mut().insert(t.name.clone(), t);

    let tmp = std::env::temp_dir().join("opus-a-unicode.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let exp = export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default());
    match exp {
        Ok(_) => {
            let r = import_xlsx_path(
                &tmp,
                &registry(),
                XlsxImportOptions {
                    recompute: RecomputeMode::Skip,
                    ..Default::default()
                },
            )
            .unwrap();
            println!("Unicode round-trip OK");
            for sid in 0..r.workbook.sheet_count() as u16 {
                let s = r.workbook.sheet(sid).unwrap();
                println!("sheet[{}] name={:?}", sid, s.name());
            }
            for (id, code) in r.workbook.formats().iter() {
                if id.is_custom() {
                    println!("fmt {:?} = {:?}", id, code);
                }
            }
            for (name, target) in r.workbook.names().iter() {
                println!("name {:?} = {:?}", name, target);
            }
            for (canon, t) in r.workbook.tables().iter() {
                println!("table {:?} display={:?} cols:", canon, t.display_name);
                for c in &t.columns {
                    println!("  col id={} display={:?}", c.id, c.display);
                }
            }
        }
        Err(e) => {
            println!("Unicode export failed: {e}");
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe C: same custom format code at two different ids in an
/// imported workbook (e.g. user-saved a duplicate). Does the
/// FormatTable handle it idempotently?
#[test]
#[ignore]
fn custom_format_byte_for_byte_preservation_with_special_chars() {
    // Format codes that include characters the OOXML emitter must
    // escape: `<`, `>`, `&`, `"`. Verify the format code string
    // survives identical.
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let id_amp = wb.formats_mut().intern("#,##0 \"& foo\"");
    let id_lt = wb.formats_mut().intern("0;[<5]0.00");
    let id_quot = wb.formats_mut().intern("0.00 \"x\" 0.00");
    println!("ids: {:?} {:?} {:?}", id_amp, id_lt, id_quot);
    let tmp = std::env::temp_dir().join("opus-a-format-bytes.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    // Dump styles.xml to inspect escapes.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    let mut styles_xml = String::new();
    if let Ok(mut e) = zip.by_name("xl/styles.xml") {
        e.read_to_string(&mut styles_xml).unwrap();
    }
    println!("--- xl/styles.xml ---\n{}\n", styles_xml);

    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    for (id, c) in r.workbook.formats().iter() {
        if id.is_custom() {
            println!("after roundtrip id={:?} code={:?}", id, c);
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe D: defined name with a value-only target — verify the
/// engine's NameTable canonicalizes the lookup case-insensitively
/// after round-trip.
#[test]
#[ignore]
fn name_case_round_trip() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    // Mix-case set; lookup case-insensitive.
    wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(7.0)))
        .unwrap();
    let tmp = std::env::temp_dir().join("opus-a-name-case.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    // Dump workbook.xml to inspect what was written.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    let mut wbxml = String::new();
    if let Ok(mut e) = zip.by_name("xl/workbook.xml") {
        e.read_to_string(&mut wbxml).unwrap();
    }
    println!("workbook.xml: {}", wbxml);

    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    for (n, t) in r.workbook.names().iter() {
        println!("imported name canonical={:?} target={:?}", n, t);
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe E: large-integer numbers + float precision near integer
/// boundary (1e15) — `format_number_literal` switches between i64
/// and f64 representation. Sub-precision drift?
#[test]
#[ignore]
fn name_numeric_constant_precision() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    wb.set_name("Tiny", NamedTarget::Constant(Value::Number(1e-15)))
        .unwrap();
    wb.set_name("Huge", NamedTarget::Constant(Value::Number(1e16)))
        .unwrap();
    wb.set_name(
        "PiMore",
        NamedTarget::Constant(Value::Number(3.141592653589793)),
    )
    .unwrap();
    wb.set_name(
        "Negint",
        NamedTarget::Constant(Value::Number(-123456789012345f64)),
    )
    .unwrap();
    let tmp = std::env::temp_dir().join("opus-a-name-numeric.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    for (n, t) in r.workbook.names().iter() {
        println!("imported {:?} = {:?}", n, t);
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe F: per-cell overlay on text cells and blank-formula cells.
#[test]
#[ignore]
fn overlay_on_text_and_error_and_shared_string() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");

    // Text cell + format (often pointless but legal).
    wb.put_at(s, 0, 0, Value::text("plain text"));
    // Error cell + format.
    wb.put_at(s, 0, 1, Value::Error(ql_types::ErrorValue::NA));
    // Blank cell + format (the "style-only" path).
    // Formula + format.
    wb.put_at(s, 0, 3, Value::Number(0.5));
    wb.put_formula(s, 0, 3, "1/2".to_string());

    let fmt_text = wb.formats_mut().intern("@");
    let fmt_money = wb.formats_mut().intern("$#,##0.00");
    let fmt_date = ql_storage::FormatId::Builtin(14); // built-in
    {
        let sheet = wb.sheet_mut(s).unwrap();
        sheet.format_overlay_mut().set(0, 0, fmt_text);
        sheet.format_overlay_mut().set(0, 1, fmt_money);
        sheet.format_overlay_mut().set(0, 2, fmt_date); // BLANK cell with format
        sheet.format_overlay_mut().set(0, 3, fmt_money); // formula cell
    }

    let tmp = std::env::temp_dir().join("opus-a-overlay-mixed.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let sheet2 = r.workbook.sheet(s).unwrap();
    for c in 0..4 {
        let v = sheet2.read(0, c);
        let f = sheet2.format_overlay().get(0, c);
        println!(
            "(0,{}) value={:?} overlay={:?} ({:?})",
            c,
            v,
            f,
            f.and_then(|i| r.workbook.formats().lookup(i))
        );
    }

    // Dump worksheet xml to inspect.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    if let Ok(mut e) = zip.by_name("xl/worksheets/sheet1.xml") {
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        println!("--- xl/worksheets/sheet1.xml ---\n{}", s);
    }

    let _ = std::fs::remove_file(&tmp);
}

/// Probe G: name with `localSheetId` referencing a non-existent sheet
/// after export. Edge case: orig was deleted but Permissive import
/// loaded it; export should still re-emit cleanly.
#[test]
#[ignore]
fn sheet_scoped_name_with_orphan_target() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let _s2 = wb.add_sheet("S2");
    // Sheet-scoped name on S1 targeting S1 — normal case.
    wb.sheet_mut(s)
        .unwrap()
        .set_scoped_name(
            "RegLocal",
            NamedTarget::Cell(ql_types::Address::new(s, 0, 0)),
        )
        .unwrap();

    // Sheet-scoped name on S1 targeting S2 — also legal.
    let s2_id = 1u16;
    wb.sheet_mut(s)
        .unwrap()
        .set_scoped_name(
            "CrossSheet",
            NamedTarget::Cell(ql_types::Address::new(s2_id, 0, 0)),
        )
        .unwrap();

    let tmp = std::env::temp_dir().join("opus-a-name-scoped.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    if let Ok(mut e) = zip.by_name("xl/workbook.xml") {
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        println!("--- workbook.xml ---\n{}", s);
    }
    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    for sid in 0..r.workbook.sheet_count() as u16 {
        let sheet = r.workbook.sheet(sid).unwrap();
        for (n, t) in sheet.scoped_names().iter() {
            println!("sheet[{}] {:?} = {:?}", sid, n, t);
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe H: Strict import — when feature_inventory non-empty but no
/// drop occurs on export, Permissive should still surface report,
/// and Strict should error.
#[test]
#[ignore]
fn import_strict_with_drawings() {
    // Use one of the corpus fixtures with drawings.
    let path = std::path::Path::new("../../.references/ironcalc/xlsx/tests/example.xlsx");
    if !path.exists() {
        println!("skip - missing fixture");
        return;
    }
    // Permissive: should succeed, report has features.
    let r = import_xlsx_path(
        path,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            unsupported_policy: UnsupportedPolicy::Permissive,
            ..Default::default()
        },
    )
    .unwrap();
    println!(
        "permissive: inventory={:?}",
        r.report.feature_inventory.counts
    );

    // Strict: should error.
    let r2 = import_xlsx_path(
        path,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            unsupported_policy: UnsupportedPolicy::Strict,
            ..Default::default()
        },
    );
    println!("strict: {:?}", r2.err().map(|e| format!("{e}")));
}

/// Probe I: feature inventory contains rels-derived sheet-anchored
/// parts (drawings, charts) but NOT the rels themselves. The
/// `dropped_features` count includes the rels parts. Make this
/// explicit.
#[test]
#[ignore]
fn dropped_features_vs_feature_inventory_completeness() {
    let path = std::path::Path::new("../../.references/ironcalc/xlsx/tests/example.xlsx");
    if !path.exists() {
        println!("skip - missing fixture");
        return;
    }
    let r = import_xlsx_path(
        path,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            preserve_package: true,
            ..Default::default()
        },
    )
    .unwrap();

    println!("=== feature_inventory ===");
    for (k, n) in r.report.feature_inventory.counts.iter() {
        println!("  {:?} = {}", k, n);
    }
    let preservation = r.report.feature_inventory.counts.len();
    println!("inventory kinds: {}", preservation);

    // Export UpdateOriginal Permissive — measure drops.
    let preserve = r.preservation.unwrap();
    let tmp = std::env::temp_dir().join("opus-a-inventory-drop.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let ex = export_xlsx_path(
        &r.workbook,
        &registry(),
        &tmp,
        XlsxExportOptions {
            mode: ExportMode::UpdateOriginal { source: preserve },
            unsupported_policy: UnsupportedPolicy::Permissive,
            formula_cache: FormulaCachePolicy::WriteRecomputed,
        },
    )
    .unwrap();
    let mut by_kind: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for d in &ex.dropped_features {
        *by_kind.entry(format!("{:?}", d.kind)).or_insert(0) += 1;
    }
    println!("=== dropped_features grouped ===");
    for (k, n) in &by_kind {
        println!("  {} = {}", k, n);
    }
    let _ = std::fs::remove_file(&tmp);
}
