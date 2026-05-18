//! End-to-end smoke test against an IronCalc fixture.
//!
//! **W5-D-14a (Phase 4.11 round-trip spine):** prove that the
//! calamine-backed import pipeline actually loads a real Excel
//! workbook, populates sheets + cells + formulas, and runs through
//! recompute without panicking.

use ql_io_xlsx::{import_xlsx_path, RecomputeMode, XlsxImportOptions};

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
