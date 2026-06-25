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
/// **NF-04 (no-fallbacks):** returns `Err(XlsxError::MalformedOoxml)` if
/// any sheet's `r:id` has no matching entry in `xl/_rels/workbook.xml.rels`.
/// Previously returned an empty string slot which produced a confusing
/// "file not found" error downstream.
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
        // **NF-04 (no-fallbacks):** an empty `r:id` on a `<sheet>` element or a
        // `r:id` that doesn't appear in `xl/_rels/workbook.xml.rels` means the
        // workbook is corrupt — the sheet part cannot be located. Returning an
        // empty string silently produced a confusing "file not found" error
        // downstream. Surface the root cause loudly.
        let part_path = rid_to_part.get(&sheet.r_id).cloned().ok_or_else(|| {
            XlsxError::MalformedOoxml {
                part: "xl/_rels/workbook.xml.rels".to_string(),
                message: format!(
                    "sheet {:?} (sheetId={}) has r:id={:?} \
                     which has no matching <Relationship> entry; \
                     the workbook is corrupt or has been partially written",
                    sheet.name, sheet.sheet_id, sheet.r_id,
                ),
            }
        })?;
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
    use crate::read::workbook_xml::{SheetMeta, SheetState};
    use std::io::Write;

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

    // ============================================================
    // NF-04 — missing r:id in workbook rels returns MalformedOoxml
    // ============================================================

    fn pkg_with_workbook_rels(rels_xml: &str) -> XlsxPackage {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zw.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
            zw.write_all(rels_xml.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        XlsxPackage::from_bytes(buf)
    }

    fn sheet_meta(name: &str, sheet_id: u32, r_id: &str) -> SheetMeta {
        SheetMeta {
            name: name.to_string(),
            sheet_id,
            r_id: r_id.to_string(),
            state: SheetState::Visible,
        }
    }

    /// When a sheet's `r:id` has no matching entry in the workbook rels,
    /// `build_sheet_part_paths` must return `MalformedOoxml` — not an empty
    /// string slot that produces a confusing "file not found" downstream.
    #[test]
    fn nf04_missing_rid_in_workbook_rels_returns_error() {
        // Rels file has rId1 but the sheet asks for rId99.
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
        let pkg = pkg_with_workbook_rels(rels_xml);
        let wb_props = crate::read::workbook_xml::WorkbookProperties {
            date_system: ql_types::DateSystem::Excel1900,
            sheets: vec![sheet_meta("MissingSheet", 2, "rId99")],
            defined_names: vec![],
        };
        let err = build_sheet_part_paths(&pkg, &wb_props).unwrap_err();
        match err {
            XlsxError::MalformedOoxml { part, message } => {
                assert_eq!(part, "xl/_rels/workbook.xml.rels");
                assert!(
                    message.contains("rId99"),
                    "error should mention the missing r:id; got: {message}"
                );
                assert!(
                    message.contains("MissingSheet"),
                    "error should name the sheet; got: {message}"
                );
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    /// When all sheet r:ids are present in the rels, `build_sheet_part_paths`
    /// succeeds and returns the resolved part paths.
    #[test]
    fn nf04_all_rids_present_succeeds() {
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/>
</Relationships>"#;
        let pkg = pkg_with_workbook_rels(rels_xml);
        let wb_props = crate::read::workbook_xml::WorkbookProperties {
            date_system: ql_types::DateSystem::Excel1900,
            sheets: vec![
                sheet_meta("Alpha", 1, "rId1"),
                sheet_meta("Beta", 5, "rId2"),
            ],
            defined_names: vec![],
        };
        let paths = build_sheet_part_paths(&pkg, &wb_props).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("sheet1.xml"), "first sheet: {}", paths[0]);
        assert!(paths[1].ends_with("sheet5.xml"), "second sheet: {}", paths[1]);
    }
}
