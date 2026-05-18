//! Resolve sheet → worksheet xml part path via workbook rels.
//!
//! **W5-D-14.1 (audit HIGH-9 closure):** the prior W5-D-14c
//! implementation hardcoded `xl/worksheets/_rels/sheet{idx+1}.xml.rels`
//! based on calamine's sheet INDEX. Real-world workbooks (Excel's
//! save-after-delete-sheet, LibreOffice, openpyxl) don't always match
//! this 1:1 convention — `r:id="rId4"` from `<sheet>` in
//! `xl/workbook.xml` points into `xl/_rels/workbook.xml.rels` which
//! maps to a path like `xl/worksheets/sheet5.xml`. The CORRECT
//! resolution is:
//!
//! 1. `xl/workbook.xml/<sheets>/<sheet name="..." r:id="rId4"/>`
//! 2. `xl/_rels/workbook.xml.rels/<Relationship Id="rId4"
//!    Target="worksheets/sheet5.xml"/>`
//! 3. Hence the part path is `xl/worksheets/sheet5.xml` and the
//!    sheet rels file is `xl/worksheets/_rels/sheet5.xml.rels`.

use crate::error::XlsxError;
use crate::read::package::XlsxPackage;
use crate::read::rels::{read_relationships, resolve_rel_target};
use crate::read::workbook_xml::WorkbookProperties;
use std::collections::HashMap;

/// Build a map from sheet index (calamine workbook order) to sheet
/// rels file path. The rels path is where `<tablePart>`, `<comments>`,
/// `<hyperlinks>` etc. relationships for that specific sheet live.
///
/// Returns `Vec<String>` ordered by sheet index. Slot `i` is the
/// rels path for sheet i (in workbook order). Empty string for sheets
/// whose rels file doesn't exist or can't be resolved (sheet with no
/// rels — common for plain sheets with no tables/comments/etc.).
pub(crate) fn build_sheet_rels_paths(
    package: &XlsxPackage,
    workbook_props: &WorkbookProperties,
) -> Result<Vec<String>, XlsxError> {
    let part_paths = build_sheet_part_paths(package, workbook_props)?;
    Ok(part_paths
        .into_iter()
        .map(|p| {
            if p.is_empty() {
                String::new()
            } else {
                derive_sheet_rels_path(&p)
            }
        })
        .collect())
}

/// **W5-D-15:** companion to `build_sheet_rels_paths` — returns the
/// worksheet PART paths themselves (e.g. `xl/worksheets/sheet5.xml`)
/// instead of the rels paths. Used by the per-cell-style scanner to
/// load each sheet's xml content directly.
///
/// Empty string slot if the workbook.xml.rels lookup misses for a
/// sheet (corrupt workbook — caller decides whether to error).
pub(crate) fn build_sheet_part_paths(
    package: &XlsxPackage,
    workbook_props: &WorkbookProperties,
) -> Result<Vec<String>, XlsxError> {
    let workbook_rels = read_relationships(package, "xl/_rels/workbook.xml.rels")?;
    let mut rid_to_part: HashMap<String, String> = HashMap::new();
    for rel in workbook_rels {
        let part_path = resolve_rel_target("xl/_rels/workbook.xml.rels", &rel.target);
        rid_to_part.insert(rel.id, part_path);
    }
    let mut paths = Vec::with_capacity(workbook_props.sheets.len());
    for sheet in &workbook_props.sheets {
        let part_path = rid_to_part.get(&sheet.r_id).cloned().unwrap_or_default();
        paths.push(part_path);
    }
    Ok(paths)
}

/// Convert `xl/worksheets/sheet5.xml` → `xl/worksheets/_rels/sheet5.xml.rels`.
fn derive_sheet_rels_path(worksheet_part: &str) -> String {
    let (dir, file) = match worksheet_part.rfind('/') {
        Some(i) => (&worksheet_part[..i], &worksheet_part[i + 1..]),
        None => ("", worksheet_part),
    };
    if dir.is_empty() {
        format!("_rels/{}.rels", file)
    } else {
        format!("{}/_rels/{}.rels", dir, file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_basic() {
        assert_eq!(
            derive_sheet_rels_path("xl/worksheets/sheet1.xml"),
            "xl/worksheets/_rels/sheet1.xml.rels"
        );
        assert_eq!(
            derive_sheet_rels_path("xl/worksheets/sheet5.xml"),
            "xl/worksheets/_rels/sheet5.xml.rels"
        );
    }

    #[test]
    fn derive_no_dir() {
        // Defensive: bare-filename path (unrealistic but handled).
        assert_eq!(
            derive_sheet_rels_path("sheet1.xml"),
            "_rels/sheet1.xml.rels"
        );
    }
}
