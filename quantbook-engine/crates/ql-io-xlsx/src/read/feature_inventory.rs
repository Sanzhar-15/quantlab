//! Feature-inventory scanner — detects OOXML parts the engine
//! doesn't model and records them in [`FeatureInventory`].
//!
//! **Phase 4.11 Acceptance XLSX-4-04**: unsupported features must
//! surface visible errors. This scanner is the detection mechanism;
//! the import code path consumes the inventory and either reports
//! (Permissive mode) or fails (Strict mode).
//!
//! Per Codex's architecture review: "The key assertion isn't that
//! every OOXML feature is implemented in batch one. The key
//! assertion is that Quantbook never silently claims fidelity it
//! does not have."

use crate::error::UnsupportedFeatureKind;
use crate::model::FeatureInventory;
use crate::read::package::XlsxPackage;

/// Scan the package for OOXML parts representing features the engine
/// doesn't model. Mutates the supplied inventory in place.
///
/// **W5-D-14b:** detection by part-path heuristics. False positives
/// are unlikely because OOXML conventions for these paths are
/// well-established. False negatives possible if a workbook uses a
/// novel feature path; the `Other` catch-all in
/// `UnsupportedFeatureKind` exists for that case.
///
/// The scan reads `[Content_Types].xml` + walks the zip directory
/// listing — no per-part content parse needed for detection.
pub(crate) fn scan_unsupported_features(
    package: &XlsxPackage,
    inventory: &mut FeatureInventory,
) -> Result<(), crate::error::XlsxError> {
    // Path-prefix patterns for OOXML features the engine doesn't
    // model. Each entry maps `(prefix, kind)`. Order doesn't matter
    // — a single part may register under multiple kinds.
    const PATTERNS: &[(&str, UnsupportedFeatureKind)] = &[
        ("xl/comments", UnsupportedFeatureKind::Comments),
        ("xl/drawings/", UnsupportedFeatureKind::Drawings),
        ("xl/media/", UnsupportedFeatureKind::Images),
        ("xl/externalLinks/", UnsupportedFeatureKind::ExternalLinks),
        ("xl/pivotTables/", UnsupportedFeatureKind::PivotTables),
        ("xl/pivotCache/", UnsupportedFeatureKind::PivotTables),
        ("xl/vbaProject.bin", UnsupportedFeatureKind::Macros),
    ];

    // Walk the entire zip directory once; check each entry against
    // all patterns. Slightly more wasteful than a list-per-prefix
    // call but only one zip-decode pass.
    let all = package.list_parts_with_prefix("")?;
    for entry in &all {
        for (prefix, kind) in PATTERNS {
            if entry.starts_with(prefix) {
                inventory.record(*kind);
            }
        }
    }

    // Some features live INSIDE worksheet XML (CF, DV, hyperlinks,
    // merged cells, sheet protection). W5-D-14b detection: open each
    // sheet xml, look for the trigger element names. We only count
    // PRESENCE here; per-instance reporting lands later with the
    // structured detail in `XlsxImportReport.unsupported`.
    let sheet_paths = package.list_parts_with_prefix("xl/worksheets/sheet")?;
    for path in &sheet_paths {
        if !path.ends_with(".xml") {
            continue;
        }
        if let Some(content) = package.read_part_string(path)? {
            if content.contains("<conditionalFormatting") {
                inventory.record(UnsupportedFeatureKind::ConditionalFormatting);
            }
            if content.contains("<dataValidations") {
                inventory.record(UnsupportedFeatureKind::DataValidation);
            }
            if content.contains("<hyperlinks") {
                inventory.record(UnsupportedFeatureKind::Hyperlinks);
            }
            if content.contains("<mergeCells") {
                inventory.record(UnsupportedFeatureKind::MergedCells);
            }
            if content.contains("<sheetProtection") {
                inventory.record(UnsupportedFeatureKind::Protection);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkg_with_files(files: &[(&str, &str)]) -> XlsxPackage {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, content) in files {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(content.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        XlsxPackage::from_bytes(buf)
    }

    #[test]
    fn clean_workbook_has_empty_inventory() {
        let pkg = pkg_with_files(&[
            ("xl/workbook.xml", "<workbook/>"),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData/></worksheet>",
            ),
        ]);
        let mut inv = FeatureInventory::default();
        scan_unsupported_features(&pkg, &mut inv).unwrap();
        assert!(
            inv.is_clean(),
            "expected clean inventory, got {:?}",
            inv.counts
        );
    }

    #[test]
    fn comments_part_detected() {
        let pkg = pkg_with_files(&[
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/comments1.xml", "<comments/>"),
        ]);
        let mut inv = FeatureInventory::default();
        scan_unsupported_features(&pkg, &mut inv).unwrap();
        assert_eq!(inv.counts.get(&UnsupportedFeatureKind::Comments), Some(&1));
    }

    #[test]
    fn drawings_and_media_detected_separately() {
        let pkg = pkg_with_files(&[
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/drawings/drawing1.xml", "<drawings/>"),
            ("xl/media/image1.png", ""),
            ("xl/media/image2.png", ""),
        ]);
        let mut inv = FeatureInventory::default();
        scan_unsupported_features(&pkg, &mut inv).unwrap();
        assert_eq!(inv.counts.get(&UnsupportedFeatureKind::Drawings), Some(&1));
        assert_eq!(inv.counts.get(&UnsupportedFeatureKind::Images), Some(&2));
    }

    #[test]
    fn vba_macros_detected() {
        let pkg = pkg_with_files(&[
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/vbaProject.bin", "binary-stub"),
        ]);
        let mut inv = FeatureInventory::default();
        scan_unsupported_features(&pkg, &mut inv).unwrap();
        assert_eq!(inv.counts.get(&UnsupportedFeatureKind::Macros), Some(&1));
    }

    #[test]
    fn conditional_formatting_in_sheet_detected() {
        let sheet_xml = r#"<worksheet>
  <sheetData/>
  <conditionalFormatting sqref="A1:A10">
    <cfRule type="cellIs"/>
  </conditionalFormatting>
</worksheet>"#;
        let pkg = pkg_with_files(&[
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ]);
        let mut inv = FeatureInventory::default();
        scan_unsupported_features(&pkg, &mut inv).unwrap();
        assert_eq!(
            inv.counts
                .get(&UnsupportedFeatureKind::ConditionalFormatting),
            Some(&1)
        );
    }

    #[test]
    fn data_validation_and_merged_cells_detected() {
        let sheet_xml = r#"<worksheet>
  <sheetData/>
  <mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>
  <dataValidations count="1"><dataValidation type="list"/></dataValidations>
</worksheet>"#;
        let pkg = pkg_with_files(&[
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ]);
        let mut inv = FeatureInventory::default();
        scan_unsupported_features(&pkg, &mut inv).unwrap();
        assert_eq!(
            inv.counts.get(&UnsupportedFeatureKind::MergedCells),
            Some(&1)
        );
        assert_eq!(
            inv.counts.get(&UnsupportedFeatureKind::DataValidation),
            Some(&1)
        );
    }
}
