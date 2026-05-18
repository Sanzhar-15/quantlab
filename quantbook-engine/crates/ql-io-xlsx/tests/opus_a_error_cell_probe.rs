//! Investigate why Error cells become Text on round-trip.

use ql_io_xlsx::{export_xlsx_path, import_xlsx_path, RecomputeMode, XlsxExportOptions, XlsxImportOptions};
use ql_storage::Workbook;
use ql_types::{ErrorValue, Value};

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

#[test]
#[ignore]
fn investigate_error_cells_with_and_without_formula() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");

    // VALUE-only error cell (no formula).
    wb.put_at(s, 0, 0, Value::Error(ErrorValue::DivZero));
    wb.put_at(s, 0, 1, Value::Error(ErrorValue::NA));
    wb.put_at(s, 0, 2, Value::Error(ErrorValue::Value));
    wb.put_at(s, 0, 3, Value::Error(ErrorValue::Ref));
    wb.put_at(s, 0, 4, Value::Error(ErrorValue::Num));
    wb.put_at(s, 0, 5, Value::Error(ErrorValue::Name));
    wb.put_at(s, 0, 6, Value::Error(ErrorValue::Null));

    // FORMULA cell with Error cached value (e.g. =1/0).
    wb.put_at(s, 1, 0, Value::Error(ErrorValue::DivZero));
    wb.put_formula(s, 1, 0, "1/0".to_string());
    wb.put_at(s, 1, 1, Value::Error(ErrorValue::NA));
    wb.put_formula(s, 1, 1, "NA()".to_string());

    let tmp = std::env::temp_dir().join("opus-a-error-cells.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let sheet = result.workbook.sheet(s).unwrap();
    for c in 0..7 {
        let orig = wb.sheet(s).unwrap().read(0, c);
        let back = sheet.read(0, c);
        println!("VALUE r=0 c={} orig={:?} back={:?}", c, orig, back);
    }
    for c in 0..2 {
        let orig = wb.sheet(s).unwrap().read(1, c);
        let back = sheet.read(1, c);
        println!("FORMULA r=1 c={} orig={:?} back={:?}", c, orig, back);
    }

    // Also dump the umya-generated XML for the sheet.
    let bytes = std::fs::read(&tmp).unwrap();
    let mut reader = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    for name in &["xl/worksheets/sheet1.xml", "xl/sharedStrings.xml"] {
        match reader.by_name(name) {
            Ok(mut e) => {
                use std::io::Read;
                let mut s = String::new();
                let _ = e.read_to_string(&mut s);
                println!("\n--- {} ---", name);
                println!("{}", s);
            }
            Err(_) => println!("\n--- {} (absent) ---", name),
        }
    }

    let _ = std::fs::remove_file(&tmp);
}
