//! Probe: workbook registers custom format codes (164+) but no cells
//! use them via the overlay. Does the format code still survive round-trip?

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
fn format_registered_but_not_used_anywhere_round_trips() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    wb.put_at(s, 0, 0, Value::Number(42.0));
    let id_a = wb.formats_mut().intern("yyyy-mm-dd");
    let id_b = wb.formats_mut().intern("0.000%");
    println!("orig ids: {:?} {:?}", id_a, id_b);
    // No overlay entries — the cell at A1 has no format.

    let tmp = std::env::temp_dir().join("opus-a-fmt-no-overlay.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    // Dump styles.xml.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    if let Ok(mut e) = zip.by_name("xl/styles.xml") {
        let mut sx = String::new();
        e.read_to_string(&mut sx).unwrap();
        println!("--- xl/styles.xml ---\n{}", sx);
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
    println!("--- after re-import ---");
    for (id, c) in r.workbook.formats().iter() {
        if id.is_custom() {
            println!("  id={:?} = {:?}", id, c);
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe: overlay that references a built-in id (< 164) that was never
/// pre-populated in the engine's FormatTable. The export writes
/// `<c s="N">` with N pointing into the cellXfs roster — but the
/// roster only contains FormatIds that came from overlays, so this
/// SHOULD work even for built-ins. Test specifically id 14, 9, 38
/// (38 is "not pre-populated" per format.rs comment).
#[test]
#[ignore]
fn overlay_on_unpopulated_builtin() {
    use ql_storage::FormatId;
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    wb.put_at(s, 0, 0, Value::Number(0.5));
    wb.put_at(s, 0, 1, Value::Number(1234.5));
    wb.put_at(s, 0, 2, Value::Number(0.07));
    {
        let sheet = wb.sheet_mut(s).unwrap();
        sheet.format_overlay_mut().set(0, 0, FormatId::Builtin(38)); // not pre-populated; renders as color
        sheet.format_overlay_mut().set(0, 1, FormatId::Builtin(46)); // also not pre-populated
        sheet.format_overlay_mut().set(0, 2, FormatId::Builtin(9)); // pre-populated "0%"
    }
    let tmp = std::env::temp_dir().join("opus-a-unpopulated-builtin.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    if let Ok(mut e) = zip.by_name("xl/styles.xml") {
        let mut sx = String::new();
        e.read_to_string(&mut sx).unwrap();
        println!("--- styles.xml ---\n{}", sx);
    }
    if let Ok(mut e) = zip.by_name("xl/worksheets/sheet1.xml") {
        let mut sx = String::new();
        e.read_to_string(&mut sx).unwrap();
        println!("--- sheet1.xml ---\n{}", sx);
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
    let sheet2 = r.workbook.sheet(s).unwrap();
    for c in 0..3 {
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
    let _ = std::fs::remove_file(&tmp);
}

/// Probe: empty workbook (zero sheets). Round-trip behavior.
#[test]
#[ignore]
fn empty_workbook_round_trip() {
    let wb = Workbook::new();
    let tmp = std::env::temp_dir().join("opus-a-empty.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let r = export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default());
    println!(
        "export empty workbook: {:?}",
        r.as_ref().err().map(|e| format!("{e}"))
    );
    let _ = std::fs::remove_file(&tmp);
}
