//! Text edge cases.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, RecomputeMode, XlsxExportOptions, XlsxImportOptions,
};
use ql_storage::Workbook;
use ql_types::Value;

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

#[test]
#[ignore]
fn text_with_whitespace_xml_chars_newlines() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    wb.put_at(s, 0, 0, Value::text("  leading and trailing  "));
    wb.put_at(s, 0, 1, Value::text("multi\nline\ntext"));
    wb.put_at(s, 0, 2, Value::text("xml-bad: < & > \" '"));
    wb.put_at(s, 0, 3, Value::text("tabs\there"));
    wb.put_at(s, 0, 4, Value::text("")); // empty string
    wb.put_at(s, 0, 5, Value::text("\u{0009}control"));
    wb.put_at(s, 0, 6, Value::text("emoji ❤️🎉 mix"));

    let tmp = std::env::temp_dir().join("opus-a-text-edge.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    )
    .unwrap();
    let sheet = r.workbook.sheet(s).unwrap();
    for c in 0..7 {
        let orig = wb.sheet(s).unwrap().read(0, c);
        let back = sheet.read(0, c);
        let ok = match (&orig, &back) {
            (Value::Text(a), Value::Text(b)) => a.as_ref() == b.as_ref(),
            _ => false,
        };
        println!("(0,{}) ok={} orig={:?} back={:?}", c, ok, orig, back);
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe: very long text — sharedStrings handling.
#[test]
#[ignore]
fn very_long_text() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let huge: String = "a".repeat(100_000);
    wb.put_at(s, 0, 0, Value::text(huge.as_str()));
    let tmp = std::env::temp_dir().join("opus-a-huge-text.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    )
    .unwrap();
    let back = r.workbook.sheet(s).unwrap().read(0, 0);
    match back {
        Value::Text(t) => println!(
            "huge text round-trip len={} (orig={})",
            t.as_ref().len(),
            huge.len()
        ),
        other => println!("UNEXPECTED: {:?}", other),
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe: 1900 vs 1904 date system survival.
#[test]
#[ignore]
fn date1900_survives() {
    use ql_types::DateSystem;
    let mut wb = Workbook::new();
    // DEFAULT: 1900.
    assert_eq!(wb.date_system(), DateSystem::Excel1900);
    wb.add_sheet("S1");
    let tmp = std::env::temp_dir().join("opus-a-date1900.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    // Dump workbook.xml.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    if let Ok(mut e) = zip.by_name("xl/workbook.xml") {
        let mut sx = String::new();
        e.read_to_string(&mut sx).unwrap();
        println!("date1900 export workbook.xml: {}", sx);
    }

    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    )
    .unwrap();
    println!("imported date system: {:?}", r.workbook.date_system());
    let _ = std::fs::remove_file(&tmp);
}
