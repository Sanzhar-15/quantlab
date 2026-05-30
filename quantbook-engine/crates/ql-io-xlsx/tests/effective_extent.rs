//! M7 (6.3-2b) — effective-extent xlsx export probes.
//!
//! The xlsx value-walk now sweeps `effective_value_bounds() ∪ per-sheet formula
//! bbox` rather than the conservative `Sheet::bounds`. These tests pin the
//! load-bearing invariants:
//!   - a formula cell OUTSIDE the value bbox still exports (the union catches it —
//!     the core fix; xlsx has no separate formula-only emit pass);
//!   - trailing blank-inflated cells don't corrupt the round-trip;
//!   - a format-only cell outside the value∪formula union survives with its style
//!     (the format-overlay pass stays bounds-independent).

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, RecomputeMode, XlsxExportOptions, XlsxImportOptions,
    XlsxImportResult,
};
use ql_storage::{FormatId, Workbook};
use ql_types::Value;

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

/// Export an in-memory workbook to a temp `.xlsx` and re-import it WITHOUT
/// recompute (so cached formula text + values survive verbatim for assertion).
fn round_trip_wb(wb: &Workbook, tag: &str) -> XlsxImportResult {
    let tmp = std::env::temp_dir().join(format!("m7-eff-extent-{}-{}.xlsx", tag, std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(wb, &registry(), &tmp, XlsxExportOptions::default())
        .expect("export_xlsx_path");
    let res = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    )
    .expect("import_xlsx_path");
    let _ = std::fs::remove_file(&tmp);
    res
}

#[test]
fn formula_cell_outside_value_bbox_survives_export() {
    // THE CORE FIX. A formula-only cell far outside the non-blank-value bbox must
    // still export its formula text. xlsx writes formulas inline in the value-walk
    // (no separate formula pass), so a value-only narrowing would silently drop it;
    // the value∪formula union must catch it.
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S");
    wb.put_at(s, 0, 0, Value::Number(1.0)); // value bbox: just (0,0)
    wb.put_at(s, 1, 1, Value::Number(2.0)); // value bbox grows to 2x2
    wb.put_formula(s, 100, 25, "A50".to_string()); // far formula, Blank value
    let second = round_trip_wb(&wb, "formula-outside");
    assert_eq!(
        second.workbook.formula_at(s, 100, 25).map(|f| f.as_ref()),
        Some("A50"),
        "formula cell outside the value bbox must survive export"
    );
    // The real values are intact too.
    assert_eq!(second.workbook.sheet(s).unwrap().read(0, 0), Value::Number(1.0));
    assert_eq!(second.workbook.sheet(s).unwrap().read(1, 1), Value::Number(2.0));
}

#[test]
fn trailing_blank_inflation_does_not_corrupt_round_trip() {
    // A far explicit Blank inflates `Sheet::bounds` but carries no data; the export
    // must preserve real values and not materialize the far blank.
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S");
    wb.put_at(s, 0, 0, Value::Number(7.0));
    wb.put_at(s, 2, 3, Value::text("x"));
    wb.put_at(s, 50, 50, Value::Blank); // inflates bounds only
    let second = round_trip_wb(&wb, "trailing-blank");
    assert_eq!(second.workbook.sheet(s).unwrap().read(0, 0), Value::Number(7.0));
    assert_eq!(second.workbook.sheet(s).unwrap().read(2, 3), Value::text("x"));
    // The far blank carried no data; it reads Blank either way.
    assert_eq!(second.workbook.sheet(s).unwrap().read(50, 50), Value::Blank);
}

#[test]
fn format_only_cell_outside_union_survives_with_style() {
    // Guards the format-overlay pass independence: a format-only cell (blank value,
    // no formula) outside the value∪formula union must survive the round-trip with
    // its style. (Built-in ids may renumber on round-trip, so compare the resolved
    // format CODE, not the raw id.)
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S");
    wb.put_at(s, 0, 0, Value::Number(1.0)); // value bbox: just (0,0)
    wb.sheet_mut(s)
        .unwrap()
        .format_overlay_mut()
        .set(40, 10, FormatId::Builtin(14)); // m/d/yyyy, far format-only cell
    let original_code = wb.formats().lookup(FormatId::Builtin(14)).map(str::to_owned);
    let second = round_trip_wb(&wb, "format-only");
    let s2 = second.workbook.sheet(s).unwrap();
    let fid2 = s2
        .format_overlay()
        .get(40, 10)
        .expect("format-only cell must survive the round-trip with a style");
    let code2 = second.workbook.formats().lookup(fid2).map(str::to_owned);
    assert_eq!(
        code2, original_code,
        "the surviving format code must match the original"
    );
}

#[test]
fn in_bbox_formula_round_trips_normally() {
    // Regression: a normal formula inside the value bbox still round-trips its text.
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S");
    wb.put_at(s, 0, 0, Value::Number(3.0));
    wb.put_at(s, 0, 1, Value::Number(4.0));
    wb.put_formula(s, 0, 2, "A1+B1".to_string());
    let second = round_trip_wb(&wb, "in-bbox");
    assert_eq!(
        second.workbook.formula_at(s, 0, 2).map(|f| f.as_ref()),
        Some("A1+B1"),
        "an in-bbox formula must round-trip"
    );
}
