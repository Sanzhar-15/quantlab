//! Miscellaneous probes.

use ql_io_xlsx::{
    export_xlsx_path, import_xlsx_path, RecomputeMode, XlsxExportOptions, XlsxImportOptions,
};
use ql_storage::Workbook;
use ql_types::Value;

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

/// Probe: workbook with one sheet that has only blank-overlay cells
/// AND a non-empty sheet next. Tests `has_cells_to_walk` path
/// (W5-D-15.1 / W5-D-15.2 fix area).
#[test]
#[ignore]
fn sheet_with_only_blank_overlay_cells_followed_by_normal_sheet() {
    let mut wb = Workbook::new();
    let s0 = wb.add_sheet("Empty");
    let s1 = wb.add_sheet("Normal");
    let fid = wb.formats_mut().intern("0.00");
    {
        // S0: only overlay entries (no values).
        let sheet = wb.sheet_mut(s0).unwrap();
        sheet.format_overlay_mut().set(5, 3, fid);
    }
    wb.put_at(s1, 0, 0, Value::Number(42.0));
    {
        let sheet = wb.sheet_mut(s1).unwrap();
        sheet.format_overlay_mut().set(0, 0, fid);
    }

    let tmp = std::env::temp_dir().join("opus-a-blank-overlay-sheet.xlsx");
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
    let sheet0 = r.workbook.sheet(s0).unwrap();
    let sheet1 = r.workbook.sheet(s1).unwrap();
    println!(
        "Empty.overlay (5,3) = {:?}",
        sheet0.format_overlay().get(5, 3)
    );
    println!("Normal.read(0,0) = {:?}", sheet1.read(0, 0));
    println!(
        "Normal.overlay (0,0) = {:?}",
        sheet1.format_overlay().get(0, 0)
    );
    let _ = std::fs::remove_file(&tmp);
}

/// Probe: Strict UpdateOriginal — if cross-cutting fix puts the error
/// before `fs::write`, the OUTPUT FILE must NOT exist on Strict err.
/// (W5-D-14.2.2 H-B closure claim.)
#[test]
#[ignore]
fn strict_update_original_does_not_leave_partial_output() {
    // Create a small package with a feature that would be dropped.
    use std::io::Write;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let parts: &[(&str, &str)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#,
            ),
            (
                "xl/drawings/drawing1.xml",
                r#"<?xml version="1.0"?><wsDr/>"#,
            ),
        ];
        for (n, c) in parts {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(c.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    let src = std::env::temp_dir().join("opus-a-strict-src.xlsx");
    std::fs::write(&src, &buf).unwrap();

    let r = import_xlsx_path(
        &src,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            preserve_package: true,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    )
    .unwrap();
    println!("inventory: {:?}", r.report.feature_inventory.counts);
    let preservation = r.preservation.unwrap();

    // PRE-CREATE a sentinel file at the output path. After Strict
    // fails, the sentinel MUST still exist (unchanged).
    let out_path = std::env::temp_dir().join("opus-a-strict-out.xlsx");
    std::fs::write(&out_path, b"SENTINEL-DO-NOT-OVERWRITE").unwrap();
    let pre_meta = std::fs::metadata(&out_path).unwrap();
    let pre_len = pre_meta.len();
    println!("pre-write size: {}", pre_len);

    let r2 = export_xlsx_path(
        &r.workbook,
        &registry(),
        &out_path,
        ql_io_xlsx::XlsxExportOptions {
            mode: ql_io_xlsx::ExportMode::UpdateOriginal {
                source: preservation,
            },
            unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
            formula_cache: ql_io_xlsx::FormulaCachePolicy::WriteRecomputed,
        },
    );
    println!(
        "strict outcome: {:?}",
        r2.as_ref().err().map(|e| format!("{e}"))
    );

    let post_meta = std::fs::metadata(&out_path).unwrap();
    let post_len = post_meta.len();
    println!("post-write size: {}", post_len);
    let content = std::fs::read(&out_path).unwrap();
    println!(
        "file content (first 24 bytes): {:?}",
        String::from_utf8_lossy(&content[..content.len().min(40)])
    );

    // assertion: sentinel preserved (pre == post bytes-wise)
    assert_eq!(pre_len, post_len, "Strict error MUST NOT touch output file");
    assert_eq!(content.as_slice(), b"SENTINEL-DO-NOT-OVERWRITE");

    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&src);
}

/// Probe: NewWorkbook with name target = Constant(Error). What does
/// the export do — drop silently, push to dropped_features, error?
#[test]
#[ignore]
fn new_workbook_with_invalid_name_target_constant_error() {
    use ql_storage::NamedTarget;
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    wb.set_name("OkName", NamedTarget::Constant(Value::Number(7.0)))
        .unwrap();
    wb.set_name(
        "Bad",
        NamedTarget::Constant(Value::Error(ql_types::ErrorValue::Ref)),
    )
    .unwrap();
    wb.set_name("Empty", NamedTarget::Constant(Value::Blank))
        .unwrap();

    let tmp = std::env::temp_dir().join("opus-a-bad-name-newwb.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let rep = export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();
    println!("dropped_features: {:?}", rep.dropped_features);
    println!("warnings:         {:?}", rep.warnings);

    // Re-import.
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
    for (n, t) in r.workbook.names().iter() {
        println!("  imported {:?} = {:?}", n, t);
    }
    let _ = std::fs::remove_file(&tmp);
}
