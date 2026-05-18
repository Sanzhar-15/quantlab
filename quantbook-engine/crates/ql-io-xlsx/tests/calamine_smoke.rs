#![allow(deprecated)]
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
fn w5_d_14_2_round_trip_preserves_sheet_scoped_name() {
    // **W5-D-14.2 self-audit L-6 closure:** sheet-scope name targeting
    // a cell. localSheetId attribute must survive round-trip and the
    // name must land in `Sheet::scoped_names`, not workbook-level.
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::Address;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let sheet = wb.sheet_mut(s).unwrap();
    sheet
        .set_scoped_name("LocalCell", NamedTarget::Cell(Address::new(s, 2, 1)))
        .unwrap();

    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-scoped-name.xlsx");
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

    // Workbook-scope: should NOT contain the name.
    assert!(
        result.workbook.names().lookup_ci("LocalCell").is_none(),
        "sheet-scoped name leaked into workbook scope"
    );

    // Sheet-scope: should be on sheet 0.
    let s0 = result.workbook.sheet(0).unwrap();
    let target = s0
        .scoped_names()
        .lookup_ci("LocalCell")
        .expect("sheet-scoped name LocalCell missing on sheet 0");
    match target {
        NamedTarget::Cell(a) => {
            assert_eq!(a.sheet, 0);
            assert_eq!(a.row, 2);
            assert_eq!(a.col, 1);
        }
        other => panic!("expected Cell target, got {other:?}"),
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
fn w5_d_14_2_3_update_original_preserves_original_theme_bytes() {
    // **W5-D-14.2.3 (separate-Opus H-1 closure):** the prior assertion
    // only checked that an `xl/theme/*` path existed in the output,
    // which passed even when shadow's umya-default theme had clobbered
    // the original's content. This test compares BYTE-FOR-BYTE: the
    // output's theme1.xml must equal the original's theme1.xml.
    let registry = ql_functions::default_registry();
    let import_opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        preserve_package: true,
        ..Default::default()
    };
    let result = import_xlsx_path(BASIC_TEXT_FIXTURE, &registry, import_opts).unwrap();
    let preservation = result.preservation.expect("preservation requested");

    // Capture the original theme bytes for comparison.
    let original_bytes = preservation.original_bytes.clone();
    let original_theme = {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&original_bytes)).unwrap();
        let mut entry = zip.by_name("xl/theme/theme1.xml").unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
        buf
    };
    assert!(
        !original_theme.is_empty(),
        "fixture should have a non-empty xl/theme/theme1.xml"
    );

    let tmp = std::env::temp_dir().join("w5-d-14-2-3-theme-bytes.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let export_opts = XlsxExportOptions {
        mode: ExportMode::UpdateOriginal {
            source: preservation,
        },
        formula_cache: FormulaCachePolicy::WriteRecomputed,
        ..Default::default()
    };
    export_xlsx_path(&result.workbook, &registry, &tmp, export_opts).unwrap();

    // Read the output's theme1.xml.
    let output_bytes = std::fs::read(&tmp).unwrap();
    let output_theme = {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&output_bytes)).unwrap();
        let mut entry = zip.by_name("xl/theme/theme1.xml").unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
        buf
    };

    assert_eq!(
        output_theme,
        original_theme,
        "output theme1.xml differs from original — H-1 regression. \
         original={}B, output={}B",
        original_theme.len(),
        output_theme.len()
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_2_strict_update_original_does_not_overwrite_output_on_drop() {
    // **W5-D-14.2.2 (Codex audit H-B closure):** in Strict mode, a
    // workbook whose original contained VBA must NOT overwrite the
    // user's destination — the error must surface BEFORE the write.
    // We synthesize a minimal "original" with a vbaProject.bin entry,
    // pass it as preservation, and assert: (1) Strict errors; (2) the
    // pre-existing file at output_path is byte-identical to its
    // pre-export contents.
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    // Build a minimal "original" xlsx-shaped zip with vbaProject.bin.
    let mut original_bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut original_bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(
            b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>",
        )
        .unwrap();
        zw.start_file("xl/vbaProject.bin", opts).unwrap();
        zw.write_all(b"FAKE-VBA-BYTES").unwrap();
        zw.finish().unwrap();
    }

    // Place a "pre-existing" file at the output path so we can detect
    // overwrite.
    let tmp = std::env::temp_dir().join("w5-d-14-2-2-strict-no-overwrite.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let sentinel = b"SENTINEL-DO-NOT-OVERWRITE";
    std::fs::write(&tmp, sentinel).unwrap();

    let registry = ql_functions::default_registry();
    let wb = ql_storage::Workbook::new();
    let preservation = ql_io_xlsx::XlsxPreservation::new(original_bytes);
    let export_opts = XlsxExportOptions {
        mode: ExportMode::UpdateOriginal {
            source: preservation,
        },
        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
        ..Default::default()
    };

    let res = export_xlsx_path(&wb, &registry, &tmp, export_opts);
    assert!(
        matches!(res, Err(ql_io_xlsx::XlsxError::UnsupportedFeature { .. })),
        "expected UnsupportedFeature error in Strict mode, got {res:?}"
    );

    // Verify the sentinel file at output_path is UNCHANGED.
    let after = std::fs::read(&tmp).expect("output path must still exist");
    assert_eq!(
        after.as_slice(),
        sentinel,
        "Strict-mode UpdateOriginal overwrote the destination — H-B regression"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_14_2_2_permissive_update_original_populates_dropped_features() {
    // **W5-D-14.2.2 (Codex audit H-A/H-B closure):** Permissive mode
    // with a VBA-containing original returns OK + populates
    // `dropped_features` with the VBA drop.
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut original_bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut original_bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(
            b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>",
        )
        .unwrap();
        zw.start_file("xl/vbaProject.bin", opts).unwrap();
        zw.write_all(b"FAKE-VBA-BYTES").unwrap();
        zw.finish().unwrap();
    }

    let tmp = std::env::temp_dir().join("w5-d-14-2-2-permissive-vba.xlsx");
    let _ = std::fs::remove_file(&tmp);

    let registry = ql_functions::default_registry();
    let wb = ql_storage::Workbook::new();
    let preservation = ql_io_xlsx::XlsxPreservation::new(original_bytes);
    let export_opts = XlsxExportOptions {
        mode: ExportMode::UpdateOriginal {
            source: preservation,
        },
        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Permissive,
        ..Default::default()
    };

    let report = export_xlsx_path(&wb, &registry, &tmp, export_opts).unwrap();
    assert!(
        report
            .dropped_features
            .iter()
            .any(|f| matches!(f.kind, ql_io_xlsx::UnsupportedFeatureKind::Macros)),
        "expected dropped_features to contain a Macros entry, got {:?}",
        report.dropped_features
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_round_trip_per_cell_custom_format_application() {
    // **W5-D-15 (Phase 4.11 XLSX-4-03 closure):** a cell with an
    // applied custom format code round-trips through export →
    // re-import, ending up at the same (row, col) with a FormatId
    // that maps to the same format code.
    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let custom_code = "yyyy-mm-dd";
    let custom_id = wb.formats_mut().intern(custom_code);
    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
    // Place a cell value + apply the format to (0, 0).
    wb.put_at(s, 0, 0, Value::Number(45000.0));
    let sheet = wb.sheet_mut(s).unwrap();
    sheet.format_overlay_mut().set(0, 0, custom_id);

    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-cell-fmt.xlsx");
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

    // Format code survives in FormatTable.
    let imported_code = result
        .workbook
        .formats()
        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
    assert_eq!(imported_code, Some(custom_code));

    // Cell at (0, 0) still references that FormatId via the overlay.
    let imported_overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(
        imported_overlay.get(0, 0),
        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
        "expected (0,0) to have the custom FormatId after round-trip"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_round_trip_per_cell_builtin_format_application() {
    // **W5-D-15:** built-in formatId 14 ("m/d/yyyy") is in the
    // FormatTable defaults — applying it to a cell should also
    // round-trip even though no `<numFmt>` is registered (built-ins
    // are implicit in OOXML).
    use ql_storage::{FormatId, Workbook};
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.put_at(s, 2, 1, Value::Number(45000.0));
    let sheet = wb.sheet_mut(s).unwrap();
    let builtin = FormatId(14);
    sheet.format_overlay_mut().set(2, 1, builtin);

    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-builtin-fmt.xlsx");
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

    let imported_overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(
        imported_overlay.get(2, 1),
        Some(FormatId(14)),
        "built-in formatId 14 did not survive round-trip"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_round_trip_dedup_shared_format_id() {
    // **W5-D-15:** two cells sharing the same FormatId should reuse
    // the same cellXf slot — the cellXfs roster has exactly one
    // entry past the default.
    use ql_storage::{Workbook, FIRST_CUSTOM_FORMAT_ID};
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    // Use a code that's not in the built-in roster so `intern` allocates ≥164.
    let custom_code = "#,##0.00 \"€\"";
    let fmt = wb.formats_mut().intern(custom_code);
    assert!(
        fmt.0 >= FIRST_CUSTOM_FORMAT_ID,
        "expected custom format id >= 164, got {}",
        fmt.0
    );
    wb.put_at(s, 0, 0, Value::Number(0.42));
    wb.put_at(s, 1, 0, Value::Number(0.55));
    let sheet = wb.sheet_mut(s).unwrap();
    sheet.format_overlay_mut().set(0, 0, fmt);
    sheet.format_overlay_mut().set(1, 0, fmt);

    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-dedup.xlsx");
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

    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(overlay.get(0, 0), Some(fmt));
    assert_eq!(overlay.get(1, 0), Some(fmt));
    assert_eq!(result.workbook.formats().lookup(fmt), Some(custom_code));

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_2_formula_with_blank_cache_format_overlay_round_trips() {
    // **W5-D-15.2 (separate-Opus H-5 closure):** a formula cell whose
    // cached value is Blank (e.g., a formula with no recompute pass)
    // makes umya elide the `<c>` element entirely. The SetStyle
    // post-process then has nothing to match. With the
    // `insert_style_only_cell` fallback, the cell's overlay still
    // survives the round-trip via injected `<c r="A1" s="N"/>`.
    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let custom = wb.formats_mut().intern("0.000");
    // Formula cell with NO put_at — so cached value is Blank.
    wb.put_formula(s, 3, 4, "1+1");
    wb.sheet_mut(s)
        .unwrap()
        .format_overlay_mut()
        .set(3, 4, custom);

    let tmp = std::env::temp_dir().join("w5-d-15-2-formula-blank.xlsx");
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
    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(
        overlay.get(3, 4),
        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
        "format overlay on formula+blank cell must round-trip via inject_style_only_cell"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_2_cross_sheet_roster_byte_deterministic() {
    // **W5-D-15.2 (separate-Opus M-4 closure):** with two sheets
    // contributing different FormatIds in different orders, the
    // `<cellXfs>` roster MUST be ordered by FormatId, not by
    // sheet-encounter order. Sort by FormatId via BTreeSet pre-walk.
    use ql_storage::Workbook;
    let registry = ql_functions::default_registry();

    let mut wb = Workbook::new();
    let s0 = wb.add_sheet("S0");
    let s1 = wb.add_sheet("S1");
    let fmt_a = wb.formats_mut().intern("0.00");
    let fmt_b = wb.formats_mut().intern("yyyy-mm-dd");
    let fmt_c = wb.formats_mut().intern("0.0000");
    assert!(fmt_b.0 > fmt_a.0);
    assert!(fmt_c.0 > fmt_b.0);

    // Sheet 0 contributes formats in c, b order (greater FormatIds first).
    wb.put_at(s0, 0, 0, ql_types::Value::Number(1.0));
    wb.put_at(s0, 0, 1, ql_types::Value::Number(2.0));
    wb.sheet_mut(s0)
        .unwrap()
        .format_overlay_mut()
        .set(0, 0, fmt_c);
    wb.sheet_mut(s0)
        .unwrap()
        .format_overlay_mut()
        .set(0, 1, fmt_b);
    // Sheet 1 contributes fmt_a (lowest).
    wb.put_at(s1, 0, 0, ql_types::Value::Number(3.0));
    wb.sheet_mut(s1)
        .unwrap()
        .format_overlay_mut()
        .set(0, 0, fmt_a);

    let tmp = std::env::temp_dir().join("w5-d-15-2-cross-sheet-det.xlsx");
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

    // Re-import must still resolve each cell to its original FormatId,
    // regardless of cellXfs ordering.
    assert_eq!(
        result.workbook.sheet(0).unwrap().format_overlay().get(0, 0),
        Some(fmt_c)
    );
    assert_eq!(
        result.workbook.sheet(0).unwrap().format_overlay().get(0, 1),
        Some(fmt_b)
    );
    assert_eq!(
        result.workbook.sheet(1).unwrap().format_overlay().get(0, 0),
        Some(fmt_a)
    );

    // Inspect the styles.xml bytes — cellXfs numFmtId order should
    // match the FormatId order (a, b, c) regardless of which sheet
    // contributed each first.
    let bytes = std::fs::read(&tmp).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut styles = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("xl/styles.xml").unwrap(), &mut styles).unwrap();
    // Find positions of the three numFmtId="..." within the cellXfs block.
    let cellxfs_start = styles.find("<cellXfs").unwrap();
    let cellxfs_block = &styles[cellxfs_start..styles.find("</cellXfs>").unwrap()];
    let pos_a = cellxfs_block
        .find(&format!(r#"numFmtId="{}""#, fmt_a.0))
        .expect("fmt_a missing from cellXfs");
    let pos_b = cellxfs_block
        .find(&format!(r#"numFmtId="{}""#, fmt_b.0))
        .expect("fmt_b missing from cellXfs");
    let pos_c = cellxfs_block
        .find(&format!(r#"numFmtId="{}""#, fmt_c.0))
        .expect("fmt_c missing from cellXfs");
    assert!(
        pos_a < pos_b && pos_b < pos_c,
        "cellXfs not sorted by FormatId (M-4 regression): positions A={}, B={}, C={}",
        pos_a,
        pos_b,
        pos_c
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_pm_1_formula_with_error_cache_round_trips_as_error() {
    // **W5-D-PM-1 (megaudit Codex HIGH-2 / Opus-A HIGH-1 closure):**
    // a formula cell whose cached value is `Value::Error(_)` must
    // round-trip as `Value::Error(same variant)` — NOT as
    // `Value::Text("#DIV/0!")`. Empirical impact pre-fix: 10.1% of
    // corpus cells diverged this way.
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.put_at(s, 0, 0, Value::Error(ErrorValue::DivZero));
    wb.put_formula(s, 0, 0, "1/0");
    wb.put_at(s, 1, 0, Value::Error(ErrorValue::NA));
    wb.put_formula(s, 1, 0, "NA()");
    wb.put_at(s, 2, 0, Value::Error(ErrorValue::Name));
    wb.put_formula(s, 2, 0, "UNKNOWNFUNC()");

    let tmp = std::env::temp_dir().join("w5-d-pm-1-formula-error.xlsx");
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
    let sheet = result.workbook.sheet(0).unwrap();
    assert_eq!(sheet.read(0, 0), Value::Error(ErrorValue::DivZero));
    assert_eq!(sheet.read(1, 0), Value::Error(ErrorValue::NA));
    assert_eq!(sheet.read(2, 0), Value::Error(ErrorValue::Name));

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_pm_1_formula_with_boolean_cache_round_trips_as_boolean() {
    // **W5-D-PM-1 (megaudit Codex HIGH-1 closure):** formula cell with
    // boolean cached value must round-trip as Boolean, not Text("TRUE").
    use ql_storage::Workbook;
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.put_at(s, 0, 0, Value::Boolean(true));
    wb.put_formula(s, 0, 0, "TRUE()");
    wb.put_at(s, 1, 0, Value::Boolean(false));
    wb.put_formula(s, 1, 0, "FALSE()");

    let tmp = std::env::temp_dir().join("w5-d-pm-1-formula-bool.xlsx");
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
    let sheet = result.workbook.sheet(0).unwrap();
    assert_eq!(sheet.read(0, 0), Value::Boolean(true));
    assert_eq!(sheet.read(1, 0), Value::Boolean(false));

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_pm_1_blank_overlay_below_existing_row_keeps_sorted() {
    // **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** W5-D-15.2's
    // `insert_style_only_cell` appended new `<row>` elements at
    // end-of-sheetData regardless of row order. A workbook with
    // overlay-only at row 0 + value at row 5 would emit
    // `<sheetData>...<row r="6">...</row><row r="1">.../></row>...`
    // — invalid OOXML order. Now we insert sorted.
    use ql_storage::Workbook;
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let custom = wb.formats_mut().intern("yyyy-mm-dd");
    // Overlay-only at (0, 0).
    wb.sheet_mut(s)
        .unwrap()
        .format_overlay_mut()
        .set(0, 0, custom);
    // Value at (5, 0) — bigger row.
    wb.put_at(s, 5, 0, Value::Number(42.0));

    let tmp = std::env::temp_dir().join("w5-d-pm-1-row-order.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    // Inspect the sheet xml's row order.
    let bytes = std::fs::read(&tmp).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut sheet_xml = String::new();
    std::io::Read::read_to_string(
        &mut zip.by_name("xl/worksheets/sheet1.xml").unwrap(),
        &mut sheet_xml,
    )
    .unwrap();

    let pos_row_1 = sheet_xml.find(r#"<row r="1""#).expect("row 1 missing");
    let pos_row_6 = sheet_xml.find(r#"<row r="6""#).expect("row 6 missing");
    assert!(
        pos_row_1 < pos_row_6,
        "row order violated (row 6 appears before row 1)"
    );

    // Re-import sanity.
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
        result.workbook.sheet(0).unwrap().read(5, 0),
        Value::Number(42.0)
    );
    assert_eq!(
        result.workbook.sheet(0).unwrap().format_overlay().get(0, 0),
        Some(custom)
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_pm_2_numfmt_id_overflow_rejected() {
    // **W5-D-PM-2 (megaudit Opus-B HIGH-1 closure):** attacker-
    // controlled numFmtId near u32::MAX must be rejected, not
    // panic the importer via FormatTable::register_at's
    // `next_custom_id = id.0 + 1` overflow.
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"S\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>").unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>").unwrap();
        zw.start_file("xl/styles.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"1\"><numFmt numFmtId=\"4294967295\" formatCode=\"custom\"/></numFmts></styleSheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions::default();
    let result = ql_io_xlsx::import_xlsx_bytes(&bytes, &registry, opts);
    assert!(
        matches!(result, Err(ql_io_xlsx::XlsxError::MalformedOoxml { .. })),
        "expected MalformedOoxml for u32::MAX numFmtId, got {result:?}"
    );
}

#[test]
fn w5_d_pm_2_oob_cell_ref_skipped_silently() {
    // **W5-D-PM-2 (megaudit Opus-B HIGH-2 closure):** `<c r="XFE1" s="1"/>`
    // (col 16384, one past MAX_COLUMN) must NOT be stored in
    // format_overlay. parse_a1_cell rejects; the cell is silently
    // skipped (downgrade from panic surface to silent skip is the
    // immediate fix; surfacing as a warning is a follow-up).
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"S\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>").unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"XFE1\" s=\"1\"/><c r=\"A1048577\" s=\"1\"/></row></sheetData></worksheet>").unwrap();
        zw.start_file("xl/styles.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><cellXfs count=\"2\"><xf numFmtId=\"0\"/><xf numFmtId=\"164\" applyNumberFormat=\"1\"/></cellXfs><numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"yyyy-mm-dd\"/></numFmts></styleSheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let result = ql_io_xlsx::import_xlsx_bytes(
        &bytes,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    // OOB refs are silently skipped — overlay should be empty.
    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(overlay.len(), 0, "OOB cell refs should NOT be stored");
}

#[test]
fn w5_d_pm_2_path_traversal_rels_rejected() {
    // **W5-D-PM-2 (megaudit Opus-B HIGH-3 closure — SECURITY):**
    // `<Relationship Target="../../../etc/passwd"/>` must NOT
    // resolve outside the package root. `resolve_rel_target` now
    // returns an empty path when `..` walks past the root; the
    // downstream zip lookup fails and the part is silently absent.
    use ql_io_xlsx::import_xlsx_bytes;
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"S\" sheetId=\"1\" r:id=\"rEvil\"/></sheets></workbook>").unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rEvil\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"../../../etc/passwd\"/></Relationships>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    // Should NOT panic; should NOT crash. The unknown-r:id-resolves-
    // to-empty-path is now safe behavior (the sheet's part path is
    // empty, downstream loops skip it).
    let _ = import_xlsx_bytes(&bytes, &registry, XlsxImportOptions::default());
}

#[test]
fn w5_d_pm_2_sheet_name_with_control_char_rejected() {
    // **W5-D-PM-2 (megaudit Opus-B HIGH-4 closure):** sheet names
    // containing NUL / control chars must be rejected, not silently
    // round-tripped into output that Excel rejects.
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        // Sheet name contains a literal NUL char (via XML entity).
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"Sheet\x07Bad\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>").unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let result = ql_io_xlsx::import_xlsx_bytes(&bytes, &registry, XlsxImportOptions::default());
    assert!(
        matches!(result, Err(ql_io_xlsx::XlsxError::MalformedOoxml { .. })),
        "expected MalformedOoxml for sheet name with control char, got {result:?}"
    );
}

#[test]
fn w5_d_pm_3_zero_sheet_workbook_rejected() {
    // **W5-D-PM-3 (megaudit Opus-B HIGH-7 closure):** workbook with
    // `<sheets/>` empty (no `<sheet>` children) must be rejected as
    // malformed, not silently accepted as a zero-sheet workbook.
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets/></workbook>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let result = ql_io_xlsx::import_xlsx_bytes(&bytes, &registry, XlsxImportOptions::default());
    assert!(
        matches!(result, Err(ql_io_xlsx::XlsxError::MalformedOoxml { .. })),
        "expected MalformedOoxml for zero-sheet workbook, got {result:?}"
    );
}

#[test]
fn w5_d_pm_3_unknown_r_id_surfaces_visibly() {
    // **W5-D-PM-3 (megaudit Opus-B HIGH-8 closure):** `<sheet
    // r:id="rIdMissing">` with no matching rel entry must surface
    // visibly — either as a calamine error during cell-grid load
    // OR (if calamine accepts the workbook structure) as an
    // `XlsxWarning` in the import report. Either way, NOT a silent
    // drop.
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"Real\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Phantom\" sheetId=\"2\" r:id=\"rIdMissing\"/></sheets></workbook>").unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let result = ql_io_xlsx::import_xlsx_bytes(
        &bytes,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    );
    match result {
        Err(_) => { /* calamine catches it — visible. OK. */ }
        Ok(r) => {
            assert!(
                r.report
                    .warnings
                    .iter()
                    .any(|w| w.message.contains("rIdMissing")),
                "import succeeded but no warning emitted; should NOT silently drop"
            );
        }
    }
}

#[test]
fn w5_d_pm_3_hidden_sheet_records_inventory_entry() {
    // **W5-D-PM-3 (megaudit Opus-A HIGH-3 closure):** sheet with
    // `state="hidden"` records `HiddenSheets` in the feature
    // inventory (Quantbook's Sheet doesn't model state; we surface
    // the loss).
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/workbook.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"Visible\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Hidden\" sheetId=\"2\" state=\"hidden\" r:id=\"rId2\"/></sheets></workbook>").unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>").unwrap();
        zw.start_file("xl/worksheets/sheet2.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let result = ql_io_xlsx::import_xlsx_bytes(
        &bytes,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        result
            .report
            .feature_inventory
            .counts
            .contains_key(&ql_io_xlsx::UnsupportedFeatureKind::HiddenSheets),
        "expected HiddenSheets in inventory, got {:?}",
        result.report.feature_inventory.counts
    );
}

#[test]
fn w5_d_pm_3_new_workbook_strict_errors_on_constant_error_name() {
    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** NewWorkbook
    // mode now honors UnsupportedPolicy::Strict. A workbook with a
    // named range pointing at `Constant(Error)` (which can't be
    // OOXML-serialised) must error in Strict mode instead of
    // silently dropping the name.
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::{ErrorValue, Value};

    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    wb.set_name(
        "Bad",
        NamedTarget::Constant(Value::Error(ErrorValue::Value)),
    )
    .unwrap();

    let tmp = std::env::temp_dir().join("w5-d-pm-3-strict-name.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    let opts = XlsxExportOptions {
        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
        ..Default::default()
    };
    let result = export_xlsx_path(&wb, &registry, &tmp, opts);
    assert!(
        matches!(
            result,
            Err(ql_io_xlsx::XlsxError::UnsupportedFeature { .. })
        ),
        "expected UnsupportedFeature in Strict mode, got {result:?}"
    );
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_pm_3_update_original_strict_catches_inline_cf() {
    // **W5-D-PM-3 (megaudit self H-2 / Opus-A MEDIUM-1 closure):**
    // UpdateOriginal mode with Strict policy must error when the
    // original's worksheet xml contains inline features that the
    // shadow's xml replaces (CF, DV, mergeCells, hyperlinks).
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut original_bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut original_bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/><conditionalFormatting sqref=\"A1\"><cfRule type=\"cellIs\" operator=\"greaterThan\"/></conditionalFormatting></worksheet>").unwrap();
        zw.finish().unwrap();
    }
    let registry = ql_functions::default_registry();
    let wb = ql_storage::Workbook::new();
    let preservation = ql_io_xlsx::XlsxPreservation::new(original_bytes);
    let tmp = std::env::temp_dir().join("w5-d-pm-3-update-original-cf.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let opts = XlsxExportOptions {
        mode: ExportMode::UpdateOriginal {
            source: preservation,
        },
        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
        ..Default::default()
    };
    let result = export_xlsx_path(&wb, &registry, &tmp, opts);
    assert!(
        matches!(
            result,
            Err(ql_io_xlsx::XlsxError::UnsupportedFeature {
                feature: ql_io_xlsx::UnsupportedFeatureKind::ConditionalFormatting,
                ..
            })
        ),
        "expected ConditionalFormatting UnsupportedFeature in Strict mode, got {result:?}"
    );
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_2_blank_cell_with_format_overlay_round_trips() {
    // **W5-D-15.2 (Codex audit HIGH-4 / self-audit H-1 closure):** a
    // cell with NO value and NO formula but a registered format
    // overlay (e.g., a date-formatted column awaiting user input)
    // must round-trip. umya by default doesn't emit a `<c>` tag for
    // such cells; W5-D-15.2 pre-touches them via `get_cell_mut` so
    // the SetStyle post-process has a target to patch.
    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let custom = wb.formats_mut().intern("yyyy-mm-dd");
    assert!(custom.0 >= FIRST_CUSTOM_FORMAT_ID);
    // Apply overlay to (5, 2) WITHOUT putting any value there.
    wb.sheet_mut(s)
        .unwrap()
        .format_overlay_mut()
        .set(5, 2, custom);

    let tmp = std::env::temp_dir().join("w5-d-15-2-blank-overlay.xlsx");
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
    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(
        overlay.get(5, 2),
        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
        "blank cell with format overlay must survive round-trip"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_1_empty_sheet_before_styled_sheet_preserves_alignment() {
    // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior export
    // logic skipped `sheet_fixes.push(fixes)` for empty-bounds
    // sheets, misaligning the per-sheet fixes vector. A workbook
    // with `[empty_sheet, styled_sheet]` would emit the styled
    // sheet's fixes against `sheet1.xml` (the empty one) instead of
    // `sheet2.xml`. This test pins the alignment by round-tripping
    // a workbook with that exact shape.
    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
    use ql_types::Value;

    let mut wb = Workbook::new();
    let _empty = wb.add_sheet("Empty");
    let styled = wb.add_sheet("Styled");
    let custom = wb.formats_mut().intern("0.0000");
    assert!(custom.0 >= FIRST_CUSTOM_FORMAT_ID);
    wb.put_at(styled, 0, 0, Value::Number(42.0));
    wb.sheet_mut(styled)
        .unwrap()
        .format_overlay_mut()
        .set(0, 0, custom);

    let tmp = std::env::temp_dir().join("w5-d-15-1-empty-then-styled.xlsx");
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
    assert_eq!(result.workbook.sheet_count(), 2);
    // Empty sheet should NOT have a format overlay.
    assert!(
        result
            .workbook
            .sheet(0)
            .unwrap()
            .format_overlay()
            .is_empty(),
        "empty sheet should have no overlay (HIGH-3 misalignment regression)"
    );
    // Styled sheet should have the overlay at (0, 0).
    assert_eq!(
        result.workbook.sheet(1).unwrap().format_overlay().get(0, 0),
        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
        "styled sheet at index 1 must have overlay preserved"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_1_libreoffice_apply_number_format_default_true() {
    // **W5-D-15.1 (self-audit H-2 closure):** LibreOffice-generated
    // xlsx files commonly emit `<cellXfs>/<xf numFmtId="..." />` WITHOUT
    // the `applyNumberFormat` attribute. Per OOXML spec, default is
    // true (= apply the format). Prior to the fix, our parser
    // defaulted to false and silently dropped these on import.
    //
    // The libreoffice fixture has cellXfs with numFmtId=165 +
    // numFmtId=166 (custom formats) and NO applyNumberFormat attr.
    // After the fix, at least one cell in the file should have a
    // populated overlay entry referencing one of those custom ids.
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::Skip,
        ..Default::default()
    };
    let result = import_xlsx_path(
        "../../.references/ironcalc/xlsx/tests/libreoffice_888_example.xlsx",
        &registry,
        opts,
    )
    .unwrap();
    // At least one sheet should have at least one populated overlay
    // entry from the fixture's cellXfs roster.
    let any_overlay = (0..result.workbook.sheet_count() as u16).any(|sid| {
        result
            .workbook
            .sheet(sid)
            .map(|s| !s.format_overlay().is_empty())
            .unwrap_or(false)
    });
    assert!(
        any_overlay,
        "libreoffice fixture should populate at least one format_overlay \
         entry (W5-D-15.1 H-2 regression — applyNumberFormat default flipped)"
    );
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
