//! Probe: two distinct numFmtId values map to the same format code.
//! Does register_at handle this gracefully?

use ql_io_xlsx::{import_xlsx_path, RecomputeMode, XlsxImportOptions};

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

#[test]
#[ignore]
fn two_custom_ids_with_same_format_code() {
    use std::io::Write;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let styles = r##"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
  <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
  <numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
</numFmts>
<cellXfs count="3">
  <xf numFmtId="0"/>
  <xf numFmtId="164" applyNumberFormat="1"/>
  <xf numFmtId="165" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"##;
        let parts: &[(&str, &str)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45001</v></c></row></sheetData></worksheet>"#,
            ),
            ("xl/styles.xml", styles),
        ];
        for (n, c) in parts {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(c.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    let src = std::env::temp_dir().join("opus-a-dup-fmt.xlsx");
    std::fs::write(&src, &buf).unwrap();

    let r = import_xlsx_path(
        &src,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    );
    match r {
        Ok(res) => {
            println!("import OK");
            for (id, c) in res.workbook.formats().iter() {
                if id.is_custom() {
                    println!("  id={:?} code={:?}", id, c);
                }
            }
            let sheet = res.workbook.sheet(0).unwrap();
            println!("  A1 overlay = {:?}", sheet.format_overlay().get(0, 0));
            println!("  B1 overlay = {:?}", sheet.format_overlay().get(0, 1));
        }
        Err(e) => println!("import ERR: {e}"),
    }
    let _ = std::fs::remove_file(&src);
}

/// Probe: numFmtId="0" with custom-id (164) re-declaration of "General".
#[test]
#[ignore]
fn libreoffice_general_at_custom_id_round_trip() {
    use std::io::Write;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        // LibreOffice-style: numFmtId=164 with formatCode="General".
        let styles = r##"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1">
  <numFmt numFmtId="164" formatCode="General"/>
</numFmts>
<cellXfs count="2">
  <xf numFmtId="0"/>
  <xf numFmtId="164" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"##;
        let parts: &[(&str, &str)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
            ("xl/styles.xml", styles),
        ];
        for (n, c) in parts {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(c.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    let src = std::env::temp_dir().join("opus-a-lo-general.xlsx");
    std::fs::write(&src, &buf).unwrap();

    let r = import_xlsx_path(
        &src,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
        Some(&ql_exec::EngineXlsxRecomputer),
    )
    .unwrap();
    let sheet = r.workbook.sheet(0).unwrap();
    println!(
        "import OK; A1 overlay = {:?}",
        sheet.format_overlay().get(0, 0)
    );
    println!(
        "formats[164] = {:?}",
        r.workbook
            .formats()
            .lookup(ql_storage::FormatId::legacy_from_u32(164))
    );
    // The cell references xf 1 → numFmtId=164. But the styles_import
    // closure for the "General-at-custom-id" case treats register_at
    // as a no-op. So `formats[164]` is None, but the overlay still
    // has FormatId(164). On EXPORT, the umya post-process emits
    // `numFmts` from `wb.formats().iter()` which filters to >= 164;
    // since 164 isn't in the table, the OOXML emit lacks the
    // declaration — and the cell's `s="N"` then references a numFmtId
    // not declared. Excel would render with the built-in 0 default,
    // but the *file* is technically lacking an entry.
    let _ = std::fs::remove_file(&src);
}
