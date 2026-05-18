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

    let sheet_count = workbook.sheet_count();
    for sheet_id in 0..sheet_count as u16 {
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
                        // Formula cell. Write the formula text + the
                        // cached value (if policy says so).
                        let cell = ws.get_cell_mut((umya_col, umya_row));
                        cell.set_formula(formula_text.as_str());
                        if formula_cache == FormulaCachePolicy::WriteRecomputed {
                            apply_value_to_cell(cell, val);
                        }
                        report.formula_caches_written += 1;
                    }
                    (None, Value::Blank) => {
                        // Skip blank cells (no formula, no value).
                    }
                    (None, val) => {
                        let cell = ws.get_cell_mut((umya_col, umya_row));
                        apply_value_to_cell(cell, val);
                    }
                }
                if !matches!(value, Value::Blank) || formula.is_some() {
                    report.cells_written += 1;
                }
            }
        }
    }

    // Persist to disk.
    umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
        .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;

    Ok(report)
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
            // Quantbook's ErrorValue::sigil() returns the Excel
            // display string (`#DIV/0!`, `#N/A`, etc.).
            cell.set_value_string(e.sigil());
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
