//! End-to-end smoke test against an IronCalc fixture.
//!
//! **W5-D-14a (Phase 4.11 round-trip spine):** prove that the
//! calamine-backed import pipeline actually loads a real Excel
//! workbook, populates sheets + cells + formulas, and runs through
//! recompute without panicking.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
    XlsxExportOptions, XlsxImportOptions,
};

const BASIC_TEXT_FIXTURE: &str = "../../.references/ironcalc/xlsx/tests/basic_text.xlsx";

#[test]
fn import_ironcalc_basic_text_fixture_succeeds() {
    // **W5-D-14a smoke test.** Open the smallest IronCalc fixture and
    // assert the import returns a populated Workbook. This is the
    // first end-to-end proof that the calamine + Workbook pipeline
    // works on real OOXML bytes (not just unit tests with synthetic
    // calamine `Data`).
    let registry = ql_functions::default_registry();
    // Use Skip recompute mode — the fixture may contain formulas the
    // engine doesn't yet support; for this smoke we just want to
    // confirm the load path itself doesn't panic.
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, opts)
        .expect("basic_text.xlsx should import successfully");

    // The fixture has at least 1 sheet.
    assert!(
        result.workbook.sheet_count() > 0,
        "expected at least 1 sheet, got {}",
        result.workbook.sheet_count()
    );

    // No preservation handle requested → None.
    assert!(result.preservation.is_none());
}

#[test]
fn import_ironcalc_basic_text_with_preservation_carries_bytes() {
    // **W5-D-14a:** with `preserve_package = true`, the preservation
    // handle carries the original xlsx bytes. The parts index will
    // be populated in W5-D-14 follow-up commits (OOXML scanner).
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        preserve_package: true,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, opts)
        .expect("basic_text.xlsx import with preserve_package should succeed");
    let preservation = result
        .preservation
        .expect("preservation handle should be Some");
    assert!(
        !preservation.original_bytes.is_empty(),
        "preservation should carry the original xlsx bytes"
    );
    // Sanity: bytes start with the OOXML zip magic `PK`.
    assert_eq!(&preservation.original_bytes[0..2], b"PK");
}

#[test]
fn import_ironcalc_basic_text_records_date_system() {
    // **W5-D-14b smoke test:** the OOXML scanner parses
    // `xl/workbook.xml/<workbookPr date1904=…>` and the import sets
    // the workbook's date system accordingly. basic_text.xlsx uses
    // the default 1900 system; this asserts the wiring works
    // end-to-end. (A 1904 fixture would require generating one;
    // unit tests in workbook_xml.rs already cover the 1904 parse.)
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, opts)
        .expect("basic_text.xlsx import succeeds");
    assert_eq!(
        result.workbook.date_system(),
        ql_types::DateSystem::Excel1900,
        "basic_text.xlsx should use the default 1900 date system"
    );
}

#[test]
fn import_ironcalc_basic_text_inventory_is_clean() {
    // **W5-D-14b smoke test:** basic_text.xlsx is a minimal fixture
    // with no CF / DV / comments / drawings — feature inventory
    // should be clean.
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, opts).unwrap();
    assert!(
        result.report.feature_inventory.is_clean(),
        "basic_text.xlsx should have clean inventory, got {:?}",
        result.report.feature_inventory.counts
    );
}

#[test]
fn round_trip_ironcalc_basic_text_preserves_sheet_count() {
    // **W5-D-14e end-to-end round-trip smoke**: import an xlsx,
    // export it back via NewWorkbook mode, re-import — sheet count
    // should be preserved exactly.
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let first = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, opts.clone()).unwrap();
    let original_sheet_count = first.workbook.sheet_count();

    let tmp = std::env::temp_dir().join("ql-io-xlsx-rt-sheet-count.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let export_opts = XlsxExportOptions {
        mode: ExportMode::NewWorkbook,
        formula_cache: FormulaCachePolicy::WriteRecomputed,
        ..Default::default()
    };
    export_xlsx_path(&first.workbook, &registry, &tmp, export_opts).unwrap();

    let second = import_xlsx_path(&tmp, &registry, opts).unwrap();
    assert_eq!(second.workbook.sheet_count(), original_sheet_count);
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_1_round_trip_preserves_formula_with_cached_value() {
    // **W5-D-14.1 (audit HIGH-1 closure):** umya's `set_value_*`
    // setters internally call `remove_formula()`. The fix reorders
    // the calls — apply value FIRST, then `set_formula`. This pins
    // the round-trip behavior end-to-end.
    use ql_storage::Workbook;
    use ql_types::Value;

    let registry = ql_functions::default_registry();
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.put_at(s, 0, 0, Value::Number(2.0));
    wb.put_at(s, 0, 1, Value::Number(3.0));
    // Formula cell with cached value.
    wb.put_at(s, 0, 2, Value::Number(5.0));
    wb.put_formula(s, 0, 2, "A1+B1");

    let tmp = std::env::temp_dir().join("ql-io-xlsx-rt-formula-cache.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(
        &wb,
        &registry,
        &tmp,
        XlsxExportOptions {
            formula_cache: FormulaCachePolicy::WriteRecomputed,
            ..Default::default()
        },
    )
    .unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    // Formula text preserved.
    let formula = result.workbook.formula_at(0, 0, 2);
    assert!(
        formula.is_some(),
        "formula at C1 should survive round-trip (W5-D-14.1 HIGH-1 closure)"
    );
    assert_eq!(formula.unwrap().as_ref(), "A1+B1");
    // Cached value preserved.
    assert_eq!(
        result.workbook.sheet(0).unwrap().read(0, 2),
        Value::Number(5.0)
    );
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_1_round_trip_preserves_date1904() {
    // **W5-D-14.1 (audit HIGH-2 closure):** umya 2.2.0 doesn't expose
    // workbookPr/@date1904. Our post-process zip patch injects the
    // attribute when the source workbook is 1904. Verify round-trip.
    use ql_storage::Workbook;
    use ql_types::{DateSystem, Value};

    let registry = ql_functions::default_registry();
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    wb.put_at(0, 0, 0, Value::Number(40000.0));
    wb.set_date_system(DateSystem::Excel1904);

    let tmp = std::env::temp_dir().join("ql-io-xlsx-rt-date1904.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        result.workbook.date_system(),
        DateSystem::Excel1904,
        "date1904 should round-trip (W5-D-14.1 HIGH-2 closure)"
    );
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_1_round_trip_preserves_error_values() {
    // **W5-D-14.1 (audit HIGH-6 closure):** error values now export
    // via `Cell::set_error` (which routes through `guess_typed_data`
    // → `CellRawValue::Error`), not `set_value_string` (which writes
    // plain text). Verify all 7 Excel error sigils round-trip as
    // `Value::Error(_)`, not `Value::Text("#…")`.
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    let registry = ql_functions::default_registry();
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    let cases = [
        ErrorValue::DivZero,
        ErrorValue::NA,
        ErrorValue::Name,
        ErrorValue::Null,
        ErrorValue::Num,
        ErrorValue::Ref,
        ErrorValue::Value,
    ];
    for (i, err) in cases.iter().enumerate() {
        wb.put_at(0, i as u32, 0, Value::Error(*err));
    }

    let tmp = std::env::temp_dir().join("ql-io-xlsx-rt-errors.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();
    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    for (i, err) in cases.iter().enumerate() {
        let got = result.workbook.sheet(0).unwrap().read(i as u32, 0);
        match got {
            Value::Error(e) => assert_eq!(
                e,
                *err,
                "error variant should match for sigil {}",
                err.sigil()
            ),
            other => panic!("expected Error({err:?}), got {other:?}"),
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_1_libreoffice_general_at_custom_id_does_not_error() {
    // **W5-D-14.1 (audit HIGH-8 closure):** LibreOffice's
    // `libreoffice_888_example.xlsx` declares
    // `<numFmt numFmtId="164" formatCode="General"/>` which previously
    // triggered `StringCollision` because "General" is already at
    // builtin id 0. The closure makes redundant declarations benign.
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let result = import_xlsx_path(
        "../../.references/ironcalc/xlsx/tests/libreoffice_888_example.xlsx",
        &registry,
        opts,
    );
    assert!(
        result.is_ok(),
        "LibreOffice fixture should import after HIGH-8 closure, got {:?}",
        result.err()
    );
}

#[test]
fn w5_d_14_2_round_trip_preserves_custom_format_codes() {
    // **W5-D-14.2 (HIGH-5 closure):** custom format codes (numFmtId >= 164)
    // registered in the Quantbook FormatTable must survive export → re-import.
    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    let custom_code = "#,##0.00 \"USD\"";
    let custom_id = wb.formats_mut().intern(custom_code);
    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));

    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-custom-format.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    // The format must be present at the same id (replay-deterministic
    // round-trip).
    let imported_code = result
        .workbook
        .formats()
        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
    assert_eq!(
        imported_code,
        Some(custom_code),
        "custom format code did not survive round-trip"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_round_trip_preserves_workbook_scoped_name_cell() {
    // **W5-D-14.2 (HIGH-4 closure):** workbook-scope name targeting a
    // cell must round-trip.
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::{Address, Value};
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.put_at(s, 4, 2, Value::Number(99.0));
    wb.set_name("MyCell", NamedTarget::Cell(Address::new(s, 4, 2)))
        .unwrap();

    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-name-cell.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let target = result
        .workbook
        .names()
        .lookup_ci("MyCell")
        .expect("workbook name MyCell missing after round-trip");
    match target {
        NamedTarget::Cell(a) => {
            assert_eq!(a.sheet, 0);
            assert_eq!(a.row, 4);
            assert_eq!(a.col, 2);
        }
        other => panic!("expected Cell target, got {other:?}"),
    }

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_round_trip_preserves_workbook_scoped_name_range() {
    // **W5-D-14.2 (HIGH-4 closure):** workbook-scope name targeting a
    // range must round-trip.
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::Range;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.set_name("Block", NamedTarget::Range(Range::new(s, 1, 0, 9, 4)))
        .unwrap();

    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-name-range.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let target = result
        .workbook
        .names()
        .lookup_ci("Block")
        .expect("workbook name Block missing after round-trip");
    match target {
        NamedTarget::Range(r) => {
            assert_eq!(r.sheet, 0);
            assert_eq!(r.start_row, 1);
            assert_eq!(r.start_col, 0);
            assert_eq!(r.end_row, 9);
            assert_eq!(r.end_col, 4);
        }
        other => panic!("expected Range target, got {other:?}"),
    }

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_round_trip_preserves_table() {
    // **W5-D-14.2 (HIGH-3 closure):** Quantbook tables export to
    // `xl/tables/table*.xml` and re-import via the existing tables
    // importer.
    use ql_storage::{TableColumn, TableMetadata, TotalsFunction, Workbook};
    use std::sync::Arc;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let columns = vec![
        TableColumn {
            id: 1,
            name: Arc::from("qty"),
            display: Arc::from("Qty"),
            totals_function: Some(TotalsFunction::Sum),
        },
        TableColumn {
            id: 2,
            name: Arc::from("price"),
            display: Arc::from("Price"),
            totals_function: None,
        },
    ];
    let meta = TableMetadata {
        name: Arc::from("SALES"),
        display_name: Arc::from("Sales"),
        sheet: s,
        top_row: 0,
        top_col: 0,
        rows: 4,
        cols: 2,
        has_header: true,
        has_totals: false,
        columns,
    };
    wb.tables_mut().insert(Arc::from("SALES"), meta);

    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-table.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let table = result
        .workbook
        .tables()
        .lookup("SALES")
        .expect("table SALES missing after round-trip");
    assert_eq!(table.sheet, 0);
    assert_eq!(table.top_row, 0);
    assert_eq!(table.top_col, 0);
    assert_eq!(table.rows, 4);
    assert_eq!(table.cols, 2);
    assert!(table.has_header);
    assert_eq!(table.columns.len(), 2);
    assert_eq!(table.columns[0].display.as_ref(), "Qty");
    assert_eq!(table.columns[1].display.as_ref(), "Price");

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_update_original_round_trip_preserves_opaque_theme() {
    // **W5-D-14.2 (HIGH-7 closure):** import a real fixture WITH
    // `preserve_package = true`, then export via UpdateOriginal. The
    // output should retain the original's `xl/theme/theme1.xml` (an
    // opaque part Quantbook doesn't model).
    let registry = ql_functions::default_registry();
    let import_opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        preserve_package: true,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, import_opts).unwrap();
    let preservation = result.preservation.expect("preservation requested");

    let tmp = std::env::temp_dir().join("w5-d-14-2-update-original-theme.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let export_opts = XlsxExportOptions {
        mode: ExportMode::UpdateOriginal {
            source: preservation,
        },
        formula_cache: FormulaCachePolicy::WriteRecomputed,
        ..Default::default()
    };
    export_xlsx_path(&result.workbook, &registry, &tmp, export_opts).unwrap();

    // Open the output zip and confirm the theme survived.
    let bytes = std::fs::read(&tmp).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: std::collections::HashSet<String> = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(
        names.iter().any(|n| n.starts_with("xl/theme/")),
        "expected xl/theme/* to be preserved, got: {names:?}"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_update_original_round_trip_preserves_cell_edits() {
    // **W5-D-14.2 (HIGH-7 closure):** UpdateOriginal must also write
    // Quantbook's cell edits — the shadow's worksheet xml replaces
    // the original's, so any cells we put in the Workbook after
    // import should appear in the output.
    use ql_types::Value;
    let registry = ql_functions::default_registry();
    let import_opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        preserve_package: true,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, import_opts).unwrap();
    let preservation = result.preservation.expect("preservation requested");

    let mut wb = result.workbook;
    // Edit a cell on sheet 0.
    wb.put_at(0, 0, 25, Value::Number(123.0));

    let tmp = std::env::temp_dir().join("w5-d-14-2-update-original-edit.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let export_opts = XlsxExportOptions {
        mode: ExportMode::UpdateOriginal {
            source: preservation,
        },
        formula_cache: FormulaCachePolicy::WriteRecomputed,
        ..Default::default()
    };
    export_xlsx_path(&wb, &registry, &tmp, export_opts).unwrap();

    // Re-import and confirm the edit is visible AND theme survived.
    let reimport = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let sheet0 = reimport.workbook.sheet(0).unwrap();
    assert_eq!(
        sheet0.read(0, 25),
        Value::Number(123.0),
        "expected our edit at (0,25) to survive UpdateOriginal round-trip"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn import_ironcalc_example_fixture_with_recompute_doesnt_panic() {
    // **W5-D-14a:** larger fixture with formulas. Run recompute in
    // best-effort mode. The point is: the pipeline doesn't panic
    // and (whatever formulas the engine supports) recompute makes
    // forward progress. Failures are reported, not fatal.
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::BestEffort,
        ..Default::default()
    };
    let result = import_xlsx_path(
        "../../.references/ironcalc/xlsx/tests/example.xlsx",
        &registry,
        opts,
    );
    // Whatever the report says, the import itself should succeed
    // (BestEffort = don't abort on formula failures).
    assert!(
        result.is_ok(),
        "example.xlsx BestEffort import should succeed, got {:?}",
        result.err()
    );
    let result = result.unwrap();
    assert!(result.workbook.sheet_count() > 0);
    // Report exists; whether formula_failures is empty depends on
    // engine fn coverage. Don't assert; just confirm the report is
    // structurally present.
    let _ = result.report.formula_failures.len();
}
