//! GATE-V (2026-06-20): end-to-end `.qbook` full-fidelity data-loss guard.
//!
//! The per-field round-trip is already covered by `qbook_format`'s unit tests
//! — but each field family is tested IN ISOLATION (a workbook with only names,
//! or only tables, or only styles) and through the DIRECTORY path
//! (`save_workbook`/`load_workbook`). The single-file `.qbook` container path
//! (`save_workbook_file` / `save_workbook_file_with_oplog`) — the one the IDE's
//! CustomEditor actually saves through — only had H1's 4-field smoke
//! (`file_roundtrip_recovers_workbook`: sheets + one formula + one hidden row).
//!
//! This is the missing integration proof: ONE workbook that populates EVERY
//! v11 state family at once — multi-sheet; all value variants (incl. unicode);
//! cross-sheet formulas; workbook- AND sheet-scoped names (same text, different
//! scope); custom number formats + overlay; rich cell styles + overlay
//! (incl. a cell carrying BOTH a format and a style overlay on top of a text
//! value); structured tables with totals functions; hidden rows; a non-default
//! date system / reference mode / locale — saved through the production
//! single-file path, reopened, and asserted FIELD-BY-FIELD. A regression that
//! drops or corrupts any one field on the file path fails LOUD here (the whole
//! point of the validation gate), where the isolated unit tests would not see
//! the interaction.

use std::sync::Arc;

use ql_io::{
    load_workbook_file, load_workbook_file_with_oplog, save_workbook_file,
    save_workbook_file_with_oplog,
};
use ql_oplog::OpLog;
use ql_storage::{
    BorderEdge, BorderStyle, Borders, ChartKind, ChartObject, FormatId, HAlign, NamedTarget, Rgb,
    Style, StyleId, TableColumn, TableMetadata, TotalsFunction, Workbook,
};
use ql_types::{Address, DateSystem, Locale, Range, ReferenceMode, Value};
use tempfile::TempDir;

/// Stable identifiers reused by the builder and the asserter so a typo can't
/// make the round-trip vacuously pass.
const SHEET_RETURNS: &str = "Returns";
const SHEET_PRICES: &str = "Prices";
const SHEET_SCRATCH: &str = "Scratch";
const FORMAT_STRING: &str = "\"€\" #,##0.00";
const UNICODE_TEXT: &str = "café \u{1F4C8} \u{05D0}\u{05D1} a\u{0301}"; // accents, chart emoji, RTL, combining mark
const TABLE_DISPLAY: &str = "SalesTbl"; // deliberately DISTINCT from the "SalesRange" defined name —
                                        // a table whose name collides with a defined name is rejected at load.

/// The handles a populated workbook hands back so the asserter can check the
/// exact interned ids survive (not just that *some* style/format is present).
struct FullBookHandles {
    fmt_id: FormatId,
    rich_style: StyleId,
    bold_style: StyleId,
    qty_col_id: u32,
    price_col_id: u32,
    chart_a_id: u32,
    chart_b_id: u32,
}

/// Build a workbook exercising EVERY v12 persisted field family at once
/// (v11 families + Wave Q1 chart objects).
fn build_full_v11_workbook() -> (Workbook, FullBookHandles) {
    let mut wb = Workbook::new();
    let s0 = wb.add_sheet(SHEET_RETURNS);
    let s1 = wb.add_sheet(SHEET_PRICES);
    let s2 = wb.add_sheet(SHEET_SCRATCH);

    // ── values: every variant, including a unicode-heavy string ──────────────
    wb.put_at(s0, 0, 0, Value::Number(42.5));
    wb.put_at(s0, 0, 1, Value::Text(Arc::from(UNICODE_TEXT)));
    wb.put_at(s0, 2, 0, Value::Boolean(true));
    wb.put_at(s0, 2, 1, Value::Boolean(false));
    wb.put_at(s1, 0, 0, Value::Number(100.0));
    // Formulas: one local, one cross-sheet (formula TEXT must survive verbatim).
    wb.put_formula(s0, 1, 0, "A1+1");
    wb.put_formula(s1, 1, 0, "Returns!A1*2");

    // ── hidden rows (v11): two non-adjacent rows on Prices ───────────────────
    wb.sheet_mut(s1).unwrap().set_row_hidden(3, true);
    wb.sheet_mut(s1).unwrap().set_row_hidden(7, true);

    // ── defined names: workbook scope, all four target kinds ─────────────────
    wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
        .unwrap();
    wb.set_name("Anchor", NamedTarget::Cell(Address::new(s0, 0, 0)))
        .unwrap();
    wb.set_name("SalesRange", NamedTarget::Range(Range::new(s0, 1, 0, 100, 3)))
        .unwrap();
    wb.set_name("Profit", NamedTarget::Formula(Arc::from("Revenue - Costs")))
        .unwrap();
    // Sheet-scoped names: the SAME text "Rate" on two sheets resolves to two
    // distinct targets — a cross-scope interaction the isolated tests don't mix
    // with the rest of the sections.
    wb.sheet_mut(s0)
        .unwrap()
        .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
        .unwrap();
    wb.sheet_mut(s1)
        .unwrap()
        .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
        .unwrap();

    // ── number formats: a custom format interned + bound via the overlay ─────
    let fmt_id = wb.formats_mut().intern(FORMAT_STRING);
    wb.sheet_mut(s0).unwrap().format_overlay_mut().set(0, 1, fmt_id);

    // ── cell styles: a fully-bordered rich style + a bold-only style ─────────
    let edge = BorderEdge {
        style: BorderStyle::Double,
        color: Rgb::new(0x11, 0x22, 0x33),
    };
    let rich = Style {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        fill: Some(Rgb::new(0xab, 0xcd, 0xef)),
        text_color: Some(Rgb::new(0x77, 0x88, 0x99)),
        align: HAlign::Center,
        borders: Borders {
            top: edge,
            bottom: BorderEdge {
                style: BorderStyle::Thin,
                color: Rgb::new(1, 2, 3),
            },
            left: BorderEdge {
                style: BorderStyle::Medium,
                color: Rgb::new(4, 5, 6),
            },
            right: edge,
        },
    };
    let bold_style = wb.styles_mut().intern(Style {
        bold: true,
        ..Style::default()
    });
    let rich_style = wb.styles_mut().intern(rich);
    // CROSS-FIELD: cell (0,1) on Returns already carries a TEXT value AND a
    // FORMAT overlay — give it a STYLE overlay too. Three pieces of state on one
    // cell, all of which must survive together.
    wb.sheet_mut(s0).unwrap().style_overlay_mut().set(0, 1, rich_style);
    wb.sheet_mut(s0).unwrap().style_overlay_mut().set(2, 0, bold_style);

    // ── tables: a structured table with totals functions on Scratch ──────────
    let qty_col_id = wb.tables_mut().allocate_column_id();
    let price_col_id = wb.tables_mut().allocate_column_id();
    let canonical: Arc<str> = Arc::from(TABLE_DISPLAY.to_ascii_uppercase().as_str());
    wb.tables_mut().insert(
        Arc::clone(&canonical),
        TableMetadata {
            name: Arc::clone(&canonical),
            display_name: Arc::from(TABLE_DISPLAY),
            sheet: s2,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 2,
            has_header: true,
            has_totals: true,
            columns: vec![
                TableColumn {
                    id: qty_col_id,
                    name: Arc::from("qty"),
                    display: Arc::from("Qty"),
                    totals_function: Some(TotalsFunction::Sum),
                },
                TableColumn {
                    id: price_col_id,
                    name: Arc::from("price"),
                    display: Arc::from("Price"),
                    totals_function: Some(TotalsFunction::Average),
                },
            ],
        },
    );

    // ── chart objects (v12): two charts, different kinds, distinct anchors ────
    // Chart B is anchored on Prices (s1) but plots a range on Returns (s0) —
    // exercises a source sheet DISTINCT from the anchor sheet. Chart A carries a
    // title; chart B carries none (the Option<title> round-trip).
    let chart_a_id = wb.charts_mut().allocate_chart_id();
    let chart_b_id = wb.charts_mut().allocate_chart_id();
    wb.charts_mut().insert(ChartObject {
        id: chart_a_id,
        name: "Returns Line".to_string(),
        chart_type: ChartKind::Line,
        sheet: s0,
        anchor_row: 5,
        anchor_col: 5,
        width_px: 480,
        height_px: 320,
        source_range: Range::new(s0, 0, 0, 9, 0),
        title: Some("Daily Returns".to_string()),
    });
    wb.charts_mut().insert(ChartObject {
        id: chart_b_id,
        name: "Px Scatter".to_string(),
        chart_type: ChartKind::Scatter,
        sheet: s1,
        anchor_row: 10,
        anchor_col: 2,
        width_px: 600,
        height_px: 400,
        source_range: Range::new(s0, 0, 0, 100, 3),
        title: None,
    });

    // ── workbook-level scalars: non-default date system / refmode / locale ───
    wb.set_date_system(DateSystem::Excel1904);
    wb.set_reference_mode(ReferenceMode::R1C1);
    wb.set_locale(Locale::De);

    (
        wb,
        FullBookHandles {
            fmt_id,
            rich_style,
            bold_style,
            qty_col_id,
            price_col_id,
            chart_a_id,
            chart_b_id,
        },
    )
}

/// Assert that a reloaded workbook recovered EVERY field the builder set.
/// Every divergence fails loud — a dropped field is a data-loss bug.
fn assert_full_v11_fidelity(loaded: &Workbook, h: &FullBookHandles) {
    // sheets
    assert_eq!(loaded.sheet_count(), 3, "sheet count");
    assert_eq!(loaded.sheet(0).unwrap().name(), SHEET_RETURNS);
    assert_eq!(loaded.sheet(1).unwrap().name(), SHEET_PRICES);
    assert_eq!(loaded.sheet(2).unwrap().name(), SHEET_SCRATCH);

    // values (incl. unicode) + blank for unwritten
    let s0 = loaded.sheet(0).unwrap();
    assert_eq!(s0.read(0, 0), Value::Number(42.5), "number value");
    assert_eq!(
        s0.read(0, 1),
        Value::Text(Arc::from(UNICODE_TEXT)),
        "unicode text value must survive byte-exact"
    );
    assert_eq!(s0.read(2, 0), Value::Boolean(true), "boolean true");
    assert_eq!(s0.read(2, 1), Value::Boolean(false), "boolean false");
    assert_eq!(s0.read(9, 9), Value::Blank, "unwritten cell stays blank");
    assert_eq!(
        loaded.sheet(1).unwrap().read(0, 0),
        Value::Number(100.0),
        "Prices value"
    );

    // formulas (text verbatim, incl. cross-sheet)
    assert_eq!(
        loaded.formula_at(0, 1, 0).map(|f| f.to_string()),
        Some("A1+1".to_string()),
        "local formula text"
    );
    assert_eq!(
        loaded.formula_at(1, 1, 0).map(|f| f.to_string()),
        Some("Returns!A1*2".to_string()),
        "cross-sheet formula text"
    );

    // hidden rows (v11)
    let prices = loaded.sheet(1).unwrap();
    assert!(prices.hidden_rows().contains(&3), "hidden row 3");
    assert!(prices.hidden_rows().contains(&7), "hidden row 7");
    assert!(!prices.hidden_rows().contains(&4), "row 4 must stay visible");

    // workbook-scoped names (all four kinds)
    assert_eq!(loaded.names().len(), 4, "workbook name count");
    assert!(
        matches!(loaded.names().lookup_ci("TaxRate"), Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21),
        "name TaxRate constant"
    );
    assert!(
        matches!(loaded.names().lookup_ci("Anchor"), Some(NamedTarget::Cell(_))),
        "name Anchor cell"
    );
    assert!(
        matches!(loaded.names().lookup_ci("SalesRange"), Some(NamedTarget::Range(_))),
        "name SalesRange range"
    );
    assert!(
        matches!(loaded.names().lookup_ci("Profit"), Some(NamedTarget::Formula(_))),
        "name Profit formula"
    );

    // sheet-scoped names: same text, distinct per-sheet targets
    assert!(
        matches!(loaded.sheet(0).unwrap().scoped_names().lookup_ci("Rate"), Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21),
        "Returns-scoped Rate = 0.21"
    );
    assert!(
        matches!(loaded.sheet(1).unwrap().scoped_names().lookup_ci("Rate"), Some(NamedTarget::Constant(Value::Number(n))) if n == 0.05),
        "Prices-scoped Rate = 0.05"
    );

    // number format + overlay binding
    assert_eq!(
        loaded.sheet(0).unwrap().format_overlay().get(0, 1),
        Some(h.fmt_id),
        "format overlay binding on (0,1)"
    );
    assert_eq!(
        loaded.formats().lookup(h.fmt_id),
        Some(FORMAT_STRING),
        "custom format string"
    );

    // styles + overlay (and the every-sub-field rich style)
    assert_eq!(
        loaded.sheet(0).unwrap().style_overlay().get(0, 1),
        Some(h.rich_style),
        "rich style overlay coexists with the text value + format overlay on (0,1)"
    );
    assert_eq!(
        loaded.sheet(0).unwrap().style_overlay().get(2, 0),
        Some(h.bold_style),
        "bold style overlay on (2,0)"
    );
    let got = loaded.styles().lookup(h.rich_style).expect("rich style interned");
    assert!(got.bold && got.italic && got.underline && got.strike, "rich font attrs");
    assert_eq!(got.fill, Some(Rgb::new(0xab, 0xcd, 0xef)), "rich fill");
    assert_eq!(got.text_color, Some(Rgb::new(0x77, 0x88, 0x99)), "rich text color");
    assert_eq!(got.align, HAlign::Center, "rich align");
    assert_eq!(got.borders.top.style, BorderStyle::Double, "rich top border");
    assert_eq!(got.borders.top.color, Rgb::new(0x11, 0x22, 0x33), "rich top border color");
    assert_eq!(got.borders.bottom.style, BorderStyle::Thin, "rich bottom border");
    assert_eq!(got.borders.left.style, BorderStyle::Medium, "rich left border");

    // tables + columns + totals functions + stable column ids
    let tbl = loaded.lookup_table(TABLE_DISPLAY).expect("table reloaded");
    assert_eq!(&*tbl.display_name, TABLE_DISPLAY, "table display name");
    assert_eq!(tbl.sheet, 2, "table sheet");
    assert_eq!((tbl.top_row, tbl.top_col, tbl.rows, tbl.cols), (0, 0, 3, 2), "table footprint");
    assert!(tbl.has_header && tbl.has_totals, "table header/totals flags");
    assert_eq!(tbl.columns.len(), 2, "table column count");
    assert_eq!(tbl.columns[0].id, h.qty_col_id, "qty column id stable");
    assert_eq!(&*tbl.columns[0].display, "Qty", "qty column display");
    assert_eq!(tbl.columns[0].totals_function, Some(TotalsFunction::Sum), "qty totals fn");
    assert_eq!(tbl.columns[1].id, h.price_col_id, "price column id stable");
    assert_eq!(tbl.columns[1].totals_function, Some(TotalsFunction::Average), "price totals fn");

    // chart objects (v12): two charts, every field round-trips; ids stable
    assert_eq!(loaded.charts().len(), 2, "chart count");
    let ca = loaded.charts().lookup(h.chart_a_id).expect("chart A reloaded");
    assert_eq!(ca.name, "Returns Line", "chart A name");
    assert_eq!(ca.chart_type, ChartKind::Line, "chart A kind");
    assert_eq!((ca.sheet, ca.anchor_row, ca.anchor_col), (0, 5, 5), "chart A anchor");
    assert_eq!((ca.width_px, ca.height_px), (480, 320), "chart A size");
    assert_eq!(ca.source_range, Range::new(0, 0, 0, 9, 0), "chart A source range");
    assert_eq!(ca.title.as_deref(), Some("Daily Returns"), "chart A title");
    let cb = loaded.charts().lookup(h.chart_b_id).expect("chart B reloaded");
    assert_eq!(cb.name, "Px Scatter", "chart B name");
    assert_eq!(cb.chart_type, ChartKind::Scatter, "chart B kind");
    assert_eq!(
        (cb.sheet, cb.anchor_row, cb.anchor_col),
        (1, 10, 2),
        "chart B anchor"
    );
    assert_eq!((cb.width_px, cb.height_px), (600, 400), "chart B size");
    assert_eq!(
        cb.source_range,
        Range::new(0, 0, 0, 100, 3),
        "chart B cross-sheet source range (anchor on s1, source on s0)"
    );
    assert_eq!(cb.title, None, "chart B has no title");

    // workbook-level scalars
    assert_eq!(loaded.date_system(), DateSystem::Excel1904, "date system");
    assert_eq!(loaded.reference_mode(), ReferenceMode::R1C1, "reference mode");
    assert_eq!(loaded.locale(), Locale::De, "locale");
}

/// The kitchen sink through the plain single-file container path.
#[test]
fn full_v11_fidelity_through_single_file_path() {
    let (wb, h) = build_full_v11_workbook();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("full.qbook");
    save_workbook_file(&wb, "full", &file).unwrap();
    assert!(file.is_file(), ".qbook must be a single FILE");

    let loaded = load_workbook_file(&file).unwrap();
    assert_full_v11_fidelity(&loaded, &h);
}

/// The kitchen sink through the `_with_oplog` single-file path — the variant the
/// IDE CustomEditor actually saves through (`session.save` -> oplog file path).
/// Every workbook field must survive AND the op-log bytes must round-trip.
#[test]
fn full_v11_fidelity_through_oplog_file_path() {
    let (wb, h) = build_full_v11_workbook();
    let oplog = OpLog::new();
    let orig_oplog_bytes = oplog.export_bytes().unwrap();
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("full_oplog.qbook");
    save_workbook_file_with_oplog(&wb, &oplog, "full", &file).unwrap();

    let (loaded, loaded_oplog) = load_workbook_file_with_oplog(&file).unwrap();
    assert_full_v11_fidelity(&loaded, &h);
    assert_eq!(
        loaded_oplog.export_bytes().unwrap(),
        orig_oplog_bytes,
        "op-log bytes must round-trip alongside a fully-populated workbook"
    );
}

/// A fully-populated workbook (every section present) must save BYTE-IDENTICALLY
/// across two saves — pins deterministic section ordering when names, formats,
/// styles, tables, overlays AND hidden rows all coexist (non-deterministic
/// ordering of any one section would silently break diff/sync/backup equality).
#[test]
fn full_v11_workbook_save_is_deterministic() {
    let (wb, _h) = build_full_v11_workbook();
    let tmp = TempDir::new().unwrap();
    let a = tmp.path().join("a.qbook");
    let b = tmp.path().join("b.qbook");
    save_workbook_file(&wb, "full", &a).unwrap();
    save_workbook_file(&wb, "full", &b).unwrap();
    assert_eq!(
        std::fs::read(&a).unwrap(),
        std::fs::read(&b).unwrap(),
        "a fully-populated container must serialize deterministically"
    );
}
