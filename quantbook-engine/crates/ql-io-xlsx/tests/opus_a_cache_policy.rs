//! FormulaCachePolicy & RecomputeMode symmetry probe.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, FormulaCachePolicy, RecomputeMode, XlsxExportOptions,
    XlsxImportOptions,
};
use ql_storage::Workbook;
use ql_types::Value;

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

/// Probe: export with SkipCache writes no cached value. Re-import
/// with RecomputeMode::Skip should preserve... nothing? Or the
/// cached value field is missing in OOXML.
#[test]
#[ignore]
fn skip_cache_round_trip_behavior() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    wb.put_at(s, 0, 0, Value::Number(1.0));
    wb.put_at(s, 0, 1, Value::Number(2.0));
    wb.put_at(s, 0, 2, Value::Number(3.0));
    wb.put_formula(s, 0, 2, "A1+B1".to_string());

    let tmp = std::env::temp_dir().join("opus-a-skipcache.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let rep = export_xlsx_path(
        &wb,
        &registry(),
        &tmp,
        XlsxExportOptions {
            formula_cache: FormulaCachePolicy::SkipCache,
            ..Default::default()
        },
    )
    .unwrap();
    println!("formula_caches_written={}", rep.formula_caches_written);

    // Inspect XML.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    if let Ok(mut e) = zip.by_name("xl/worksheets/sheet1.xml") {
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        println!("--- sheet1.xml ---\n{}", s);
    }

    // Re-import with Skip — preserves whatever was written.
    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let sheet = r.workbook.sheet(s).unwrap();
    println!("(0,0)={:?}", sheet.read(0, 0));
    println!("(0,1)={:?}", sheet.read(0, 1));
    println!("(0,2)={:?}", sheet.read(0, 2));

    let _ = std::fs::remove_file(&tmp);
}

/// Probe: RecomputeMode::Strict on a formula the engine can't evaluate.
#[test]
#[ignore]
fn recompute_strict_on_unknown_function() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    wb.put_at(s, 0, 0, Value::Number(10.0));
    wb.put_at(s, 0, 1, Value::Number(20.0));
    wb.put_formula(s, 0, 1, "TOTALLY_UNKNOWN_FUNCTION(A1)".to_string());

    let tmp = std::env::temp_dir().join("opus-a-recompute-strict.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Strict,
            ..Default::default()
        },
    );
    println!(
        "strict-recompute outcome: {:?}",
        r.as_ref().err().map(|e| format!("{e}"))
    );

    // BestEffort should succeed.
    let r2 = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::BestEffort,
            ..Default::default()
        },
    );
    match r2 {
        Ok(rr) => {
            println!("besteffort: failures={}", rr.report.formula_failures.len());
            for f in &rr.report.formula_failures {
                println!("  failure: {:?}", f);
            }
        }
        Err(e) => println!("besteffort UNEXPECTEDLY FAILED: {e}"),
    }
    let _ = std::fs::remove_file(&tmp);
}
