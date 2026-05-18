//! umya-spreadsheet writer — `NewWorkbook` mode.
//!
//! **W5-D-14e scope**: minimal viable exporter. Writes:
//! - Sheets (one per Quantbook sheet, in workbook order).
//! - Cell values (Number / Boolean / Text / Error).
//! - Formula text + cached values.
//!
//! NOT in this commit (W5-D-14e follow-ups):
//! - Tables / styles / named ranges round-trip.
//! - `ExportMode::UpdateOriginal` (load preservation + patch).
//! - Conditional formatting / data validation preservation.
//!
//! The `UpdateOriginal` mode arrives in a follow-up; this slice
//! proves the umya integration works end-to-end on the cell layer
//! first.

use crate::error::XlsxError;
use crate::options::FormulaCachePolicy;
use crate::report::XlsxExportReport;
use ql_storage::Workbook;
use ql_types::Value;

/// Per-cell fix instruction. **W5-D-14.1 umya-bug workaround:** umya
/// 2.2.0 has two correctness bugs we patch via post-process on output:
/// 1. Formula cells write `t="str"` even when the cached value is
///    numeric/boolean (umya's `get_data_type_crate` returns "str"
///    for any cell with a formula, regardless of `raw_value` type).
/// 2. Error cells hardcode `#VALUE!` as the OOXML `<v>` content
///    regardless of the actual `CellErrorType` variant
///    (umya `worksheet.rs:524-526` hardcodes the sigil).
#[derive(Debug, Clone)]
struct CellFix {
    /// A1-style cell reference, e.g. `"C5"`.
    cell_ref: String,
    /// What to patch.
    kind: CellFixKind,
}

#[derive(Debug, Clone)]
enum CellFixKind {
    /// Remove the `t="str"` attribute from this cell. Used for
    /// formula cells whose cached value is numeric (Number / Boolean).
    /// After removal the cell has default type "n".
    RemoveStrType,
    /// Replace the hardcoded `#VALUE!` sigil with the actual error
    /// sigil.
    OverrideErrorSigil(&'static str),
}

/// Convert (col, row) (both 0-indexed) to an A1-style ref.
fn cell_ref_a1(row: u32, col: u32) -> String {
    let mut name = String::new();
    let mut c = col + 1; // 1-indexed for the bijective base-26 conversion
    while c > 0 {
        let rem = (c - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        c = (c - 1) / 26;
    }
    name.push_str(&(row + 1).to_string());
    name
}

/// Export a Quantbook `Workbook` to an xlsx file via umya-spreadsheet
/// in `NewWorkbook` mode (generate fresh).
pub(crate) fn export_new_workbook(
    workbook: &Workbook,
    output_path: &std::path::Path,
    formula_cache: FormulaCachePolicy,
) -> Result<XlsxExportReport, XlsxError> {
    let mut report = XlsxExportReport::default();
    let mut spreadsheet = umya_spreadsheet::new_file_empty_worksheet();

    // Build a quick lookup from (sheet, row, col) → formula text so
    // the per-cell loop can decide whether to write a formula or a
    // value. The `iter_formulas` API gives us only formula-bearing
    // cells; cells without formulas just get the value-only path.
    let mut formula_map: std::collections::HashMap<(u16, u32, u32), String> =
        std::collections::HashMap::new();
    for (sheet, row, col, text) in workbook.iter_formulas() {
        formula_map.insert((sheet, row, col), text.to_string());
    }

    // **W5-D-14.1 umya-bug workaround**: track per-cell fixes by
    // sheet ORDER INDEX (which matches the OOXML sheet1.xml, sheet2.xml
    // numbering for fresh-generated workbooks).
    let mut sheet_fixes: Vec<Vec<CellFix>> = Vec::with_capacity(workbook.sheet_count());

    let sheet_count = workbook.sheet_count();
    for sheet_id in 0..sheet_count as u16 {
        let mut fixes: Vec<CellFix> = Vec::new();
        let sheet = workbook
            .sheet(sheet_id)
            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
        let sheet_name = sheet.name().to_string();

        // `new_file_empty_worksheet` returns a spreadsheet with no
        // sheets; add each sheet by name. For the first sheet we'd
        // normally also rename the default, but the empty-file
        // variant doesn't have a default sheet, so add fresh.
        spreadsheet
            .new_sheet(&sheet_name)
            .map_err(|e| XlsxError::Export(format!("umya new_sheet({sheet_name}) failed: {e}")))?;

        let bounds = sheet.bounds();
        if bounds.row_extent == 0 || bounds.col_extent == 0 {
            // Empty sheet — done.
            continue;
        }

        // Get the worksheet handle for cell writes. umya uses
        // 1-indexed (col, row) coordinates; Quantbook is 0-indexed
        // (row, col). Convert at write time.
        let ws = spreadsheet
            .get_sheet_by_name_mut(&sheet_name)
            .ok_or_else(|| {
                XlsxError::Export(format!(
                    "umya sheet {sheet_name} disappeared after new_sheet"
                ))
            })?;

        // Walk every (row, col) within bounds. This is O(rows * cols)
        // and inefficient for large sparse sheets; W5-D-14e
        // follow-up: switch to column-wise iteration via ColumnStore.
        for row in 0..bounds.row_extent {
            for col in 0..bounds.col_extent {
                let value = sheet.read(row, col);
                let formula = formula_map.get(&(sheet_id, row, col));

                let umya_col = col + 1;
                let umya_row = row + 1;

                match (formula, &value) {
                    (Some(formula_text), val) => {
                        // **W5-D-14.1 (audit HIGH-1 closure — phase
                        // 1):** umya's `set_value_*` setters internally
                        // call `remove_formula()`, so we apply the
                        // value FIRST then call `set_formula` (which
                        // doesn't touch the raw value).
                        let cell = ws.get_cell_mut((umya_col, umya_row));
                        let cache_written = if formula_cache == FormulaCachePolicy::WriteRecomputed
                            && !matches!(val, Value::Blank)
                        {
                            apply_value_to_cell(cell, val);
                            true
                        } else {
                            false
                        };
                        cell.set_formula(formula_text.as_str());
                        if cache_written {
                            report.formula_caches_written += 1;
                        }
                        // **W5-D-14.1 (audit HIGH-1 closure — phase 2):**
                        // umya's writer sets `t="str"` on any formula
                        // cell (`cell_value.rs::get_data_type_crate`
                        // returns "str" for Some(formula) regardless
                        // of raw_value type). Calamine then reads the
                        // `<v>` content as text. Schedule a post-
                        // process fix: remove `t="str"` for cells
                        // whose cached value is numeric/boolean (the
                        // default cell type "n" lets calamine restore
                        // the number).
                        if cache_written && matches!(val, Value::Number(_) | Value::Boolean(_)) {
                            fixes.push(CellFix {
                                cell_ref: cell_ref_a1(row, col),
                                kind: CellFixKind::RemoveStrType,
                            });
                        }
                        // For formula cells with Error cached value:
                        // umya hardcodes `#VALUE!` (umya
                        // `worksheet.rs:524-526`). Schedule sigil fix.
                        if let Value::Error(e) = val {
                            if cache_written {
                                fixes.push(CellFix {
                                    cell_ref: cell_ref_a1(row, col),
                                    kind: CellFixKind::OverrideErrorSigil(e.sigil()),
                                });
                            }
                        }
                    }
                    (None, Value::Blank) => {
                        // Skip blank cells (no formula, no value).
                    }
                    (None, val) => {
                        let cell = ws.get_cell_mut((umya_col, umya_row));
                        apply_value_to_cell(cell, val);
                        // **W5-D-14.1 (audit HIGH-6 closure):** umya
                        // hardcodes `#VALUE!` for any error cell.
                        // Schedule the actual sigil patch.
                        if let Value::Error(e) = val {
                            fixes.push(CellFix {
                                cell_ref: cell_ref_a1(row, col),
                                kind: CellFixKind::OverrideErrorSigil(e.sigil()),
                            });
                        }
                    }
                }
                if !matches!(value, Value::Blank) || formula.is_some() {
                    report.cells_written += 1;
                }
            }
        }
        sheet_fixes.push(fixes);
    }

    // Persist to disk.
    umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
        .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;

    // **W5-D-14.1 unified post-process pass:** apply workarounds for
    // umya 2.2.0 bugs and limitations. Three distinct patches:
    //
    // 1. `xl/workbook.xml`: inject `workbookPr/@date1904` when the
    //    Quantbook source is 1904 (HIGH-2 closure).
    // 2. `xl/worksheets/sheet{N}.xml`: remove `t="str"` from formula
    //    cells whose cached value is numeric/boolean (HIGH-1 closure).
    // 3. `xl/worksheets/sheet{N}.xml`: replace the hardcoded `#VALUE!`
    //    sigil with the actual error sigil per cell (HIGH-6 closure).
    let needs_date1904 = workbook.date_system() == ql_types::DateSystem::Excel1904;
    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
    if needs_date1904 || needs_cell_fixes {
        post_process_zip(output_path, needs_date1904, &sheet_fixes)?;
    }

    Ok(report)
}

/// Unified post-process pass over the just-written xlsx. Applies:
/// - `xl/workbook.xml`: inject `date1904="1"` if needed.
/// - `xl/worksheets/sheet{N}.xml`: apply per-cell fixes (remove
///   spurious `t="str"`, replace hardcoded error sigils).
///
/// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
fn post_process_zip(
    path: &std::path::Path,
    inject_date1904: bool,
    sheet_fixes: &[Vec<CellFix>],
) -> Result<(), XlsxError> {
    use std::io::{Read, Write};

    let bytes = std::fs::read(path)?;
    let mut reader =
        zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).map_err(XlsxError::Zip)?;
    let mut out_buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
        for i in 0..reader.len() {
            let mut entry = reader.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            if inject_date1904 && name == "xl/workbook.xml" {
                content = inject_date1904_into_workbook_xml(content)?;
            } else if let Some(sheet_idx) = sheet_index_from_path(&name) {
                if let Some(fixes) = sheet_fixes.get(sheet_idx) {
                    if !fixes.is_empty() {
                        content = apply_cell_fixes_to_sheet_xml(content, fixes)?;
                    }
                }
            }
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file(name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }
        writer.finish().map_err(XlsxError::Zip)?;
    }
    std::fs::write(path, out_buf)?;
    Ok(())
}

/// Convert `xl/worksheets/sheet5.xml` → `Some(4)` (0-indexed N-1).
/// Returns `None` for any path that isn't a per-sheet worksheet xml.
fn sheet_index_from_path(name: &str) -> Option<usize> {
    let stripped = name.strip_prefix("xl/worksheets/sheet")?;
    let n_str = stripped.strip_suffix(".xml")?;
    n_str.parse::<usize>().ok().and_then(|n| n.checked_sub(1))
}

/// Apply per-cell fixes to one worksheet xml content. Each fix
/// targets a specific cell ref (e.g. `"C5"`) within the sheet.
fn apply_cell_fixes_to_sheet_xml(
    content: Vec<u8>,
    fixes: &[CellFix],
) -> Result<Vec<u8>, XlsxError> {
    let mut text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("worksheet.xml is not valid UTF-8: {e}")))?;
    for fix in fixes {
        match &fix.kind {
            CellFixKind::RemoveStrType => {
                // Pattern: `<c r="C5" t="str">` → `<c r="C5">`.
                // umya always writes attributes in the same order:
                // `r` first, then optional `t`, then optional `s`.
                // The `t="str"` attribute appears immediately after
                // the `r="..."` for formula cells. Match the exact
                // pair `<c r="X1" t="str"`.
                let needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}""#, fix.cell_ref);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::OverrideErrorSigil(sigil) => {
                // Pattern: `<c r="C5" t="e"><v>#VALUE!</v></c>` →
                // `<c r="C5" t="e"><v>SIGIL</v></c>`. The cell ref
                // anchors the match so we only patch the targeted cell.
                let needle = format!(r#"<c r="{}" t="e"><v>#VALUE!</v>"#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}" t="e"><v>{}</v>"#, fix.cell_ref, sigil);
                text = text.replace(&needle, &replacement);
            }
        }
    }
    Ok(text.into_bytes())
}

/// Insert `date1904="1"` into `<workbookPr>`. If the element is
/// missing, insert a fresh `<workbookPr date1904="1"/>` after the
/// opening `<workbook>` tag. UTF-8 text manipulation — OOXML is
/// always UTF-8.
fn inject_date1904_into_workbook_xml(content: Vec<u8>) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("workbook.xml is not valid UTF-8: {e}")))?;

    // Case 1: <workbookPr already present — add date1904 attribute.
    if let Some(start_idx) = text.find("<workbookPr") {
        let after_tag = start_idx + "<workbookPr".len();
        // If date1904="1" already present, no-op.
        let end_of_element = text[after_tag..]
            .find('>')
            .map(|i| after_tag + i)
            .unwrap_or(after_tag);
        let element_attrs = &text[after_tag..end_of_element];
        if element_attrs.contains("date1904=") {
            return Ok(text.into_bytes());
        }
        // Insert ` date1904="1"` right after `<workbookPr`.
        let mut out = String::with_capacity(text.len() + 16);
        out.push_str(&text[..after_tag]);
        out.push_str(r#" date1904="1""#);
        out.push_str(&text[after_tag..]);
        return Ok(out.into_bytes());
    }

    // Case 2: no <workbookPr — insert one right after the opening
    // <workbook ...> tag.
    if let Some(opening) = text.find("<workbook") {
        let end_of_opening = text[opening..]
            .find('>')
            .map(|i| opening + i + 1)
            .ok_or_else(|| {
                XlsxError::Export("workbook.xml has malformed <workbook> opening tag".to_string())
            })?;
        let mut out = String::with_capacity(text.len() + 40);
        out.push_str(&text[..end_of_opening]);
        out.push_str(r#"<workbookPr date1904="1"/>"#);
        out.push_str(&text[end_of_opening..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "workbook.xml missing <workbook> root element".to_string(),
    ))
}

/// Translate a Quantbook `Value` into an umya cell value setter.
///
/// **Error values**: umya represents Excel errors via the cell's
/// value string in the OOXML `t="e"` form. We set the textual
/// representation; consumers (Excel) re-parse it as an error.
fn apply_value_to_cell(cell: &mut umya_spreadsheet::Cell, value: &Value) {
    match value {
        Value::Number(n) => {
            cell.set_value_number(*n);
        }
        Value::Boolean(b) => {
            cell.set_value_bool(*b);
        }
        Value::Text(s) => {
            cell.set_value_string(s.as_ref());
        }
        Value::Error(e) => {
            // **W5-D-14.1 (audit HIGH-6 closure):** use umya's
            // `set_error` (which routes through `guess_typed_data` →
            // `CellRawValue::Error`) instead of `set_value_string`
            // (which writes a plain text cell). On re-import, calamine
            // now produces `Data::Error(...)` and our `data_to_value`
            // maps that to `Value::Error(...)` — preserving the type.
            cell.set_error(e.sigil());
        }
        Value::Blank => {
            // No-op — empty cell.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_empty_workbook_writes_valid_xlsx() {
        // Smoke: a workbook with one empty sheet should export to a
        // valid xlsx (umya generates the OOXML scaffolding even for
        // empty sheets).
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let tmp = std::env::temp_dir().join("ql-io-xlsx-empty-export.xlsx");
        let report = export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();
        assert_eq!(report.cells_written, 0);
        assert_eq!(report.formula_caches_written, 0);
        // File exists and is non-empty.
        let metadata = std::fs::metadata(&tmp).unwrap();
        assert!(metadata.len() > 0);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn export_workbook_with_values_round_trips_via_calamine() {
        // End-to-end: build a Quantbook with cells, export it, then
        // re-import via the W5-D-14a calamine path. Values should
        // come back identical.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_at(s, 0, 1, Value::text("hello"));
        wb.put_at(s, 1, 0, Value::Boolean(true));

        let tmp = std::env::temp_dir().join("ql-io-xlsx-roundtrip-values.xlsx");
        let _ = std::fs::remove_file(&tmp);
        export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();

        // Re-import via the public API.
        let registry = ql_functions::default_registry();
        let result = crate::import_xlsx_path(
            &tmp,
            &registry,
            crate::XlsxImportOptions {
                recompute: crate::RecomputeMode::Skip,
                ..Default::default()
            },
        )
        .unwrap();

        // Assert values match.
        let sheet = result.workbook.sheet(0).unwrap();
        assert_eq!(sheet.read(0, 0), Value::Number(42.0));
        match sheet.read(0, 1) {
            Value::Text(s) => assert_eq!(s.as_ref(), "hello"),
            other => panic!("expected Text(\"hello\"), got {other:?}"),
        }
        assert_eq!(sheet.read(1, 0), Value::Boolean(true));
        let _ = std::fs::remove_file(&tmp);
    }
}
