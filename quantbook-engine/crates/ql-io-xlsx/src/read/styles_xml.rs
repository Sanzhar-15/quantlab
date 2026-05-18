//! Parse `xl/styles.xml` — number formats and cell style references.
//!
//! **Focus for W5-D-14d**: minimal but useful — extract custom number
//! formats (`<numFmts>`) and the cell-XF table (`<cellXfs>`). Fonts,
//! fills, borders, alignment, etc. are deferred — Quantbook doesn't
//! yet model those at the storage layer.
//!
//! ## OOXML styles.xml shape
//!
//! ```xml
//! <styleSheet xmlns="...">
//!   <numFmts count="2">
//!     <numFmt numFmtId="164" formatCode="#,##0.00 &quot;€&quot;"/>
//!     <numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
//!   </numFmts>
//!   <fonts.../>
//!   <fills.../>
//!   <borders.../>
//!   <cellStyleXfs.../>
//!   <cellXfs count="3">
//!     <xf numFmtId="0" .../>            <!-- General -->
//!     <xf numFmtId="164" applyNumberFormat="1"/>
//!     <xf numFmtId="165" applyNumberFormat="1"/>
//!   </cellXfs>
//!   ...
//! </styleSheet>
//! ```
//!
//! **numFmtId convention**:
//! - 0-163 are RESERVED for Excel built-ins (not always present in
//!   `<numFmts>` since the consumer is expected to know them).
//! - ≥164 are workbook-specific custom format codes; only these
//!   require a `<numFmt>` entry.
//!
//! **cellXfs convention**: every cell's `<c s="N">` attribute is an
//! INDEX into the `cellXfs` array. We preserve this 1:1 so per-cell
//! application (W5-D-14 follow-up via worksheet XML scan) can map
//! `cell.s` → cellXf → numFmtId → format code.

use crate::error::XlsxError;
use crate::read::package::XlsxPackage;
use quick_xml::events::Event;
use quick_xml::Reader;

/// Parsed contents of `xl/styles.xml` (the slice this engine cares
/// about for Phase 4.11 — number formats and cell XF references).
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub(crate) struct StyleIndex {
    /// Custom number-format definitions (`numFmtId >= 164`) mapped to
    /// their format code string. Built-ins (0-163) live in the
    /// engine's `FormatTable` defaults — they're omitted here.
    pub num_fmts: Vec<NumFmtEntry>,
    /// The `<cellXfs>` table — every entry is a style applied via
    /// `<c s="N">`. `cell_xfs[N].num_fmt_id` is the numFmtId that
    /// cell references.
    pub cell_xfs: Vec<CellXf>,
}

/// One `<numFmt>` entry from `<numFmts>`.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NumFmtEntry {
    /// `numFmtId` attribute — the lookup key. ≥164 for custom; 0-163
    /// are built-ins (rarely listed here since consumers know them).
    pub num_fmt_id: u32,
    /// `formatCode` attribute — the Excel format string. e.g.
    /// `"yyyy-mm-dd"` or `"#,##0.00"`.
    pub format_code: String,
}

/// One `<xf>` entry from `<cellXfs>`. We track only the
/// `numFmtId` reference for W5-D-14d; alignment / borders / fonts
/// land later if Quantbook adds matching storage.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct CellXf {
    /// `numFmtId` attribute. 0 = General (no special format).
    pub num_fmt_id: u32,
    /// `applyNumberFormat` attribute (`"1"` / `"true"`). When false,
    /// the cell renders with the General format regardless of
    /// `num_fmt_id`.
    pub apply_number_format: bool,
}

/// Read + parse `xl/styles.xml` from the package. Returns
/// `Ok(StyleIndex::default())` if the part doesn't exist (legal in
/// OOXML — a workbook with no custom styles can omit it; the engine
/// just sees an empty index).
pub(crate) fn parse_styles_xml(package: &XlsxPackage) -> Result<StyleIndex, XlsxError> {
    const PART: &str = "xl/styles.xml";
    let content = match package.read_part_string(PART)? {
        Some(c) => c,
        None => return Ok(StyleIndex::default()),
    };

    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut idx = StyleIndex::default();
    let mut buf = Vec::new();
    // Stack of currently-open element names. Used to decide whether
    // an `<xf>` belongs to `<cellXfs>` (the per-cell table we care
    // about) or to `<cellStyleXfs>` (named styles — out of scope).
    let mut element_stack: Vec<String> = Vec::new();

    loop {
        let evt = reader
            .read_event_into(&mut buf)
            .map_err(|e| XlsxError::XmlParse {
                part: PART.to_string(),
                source: e,
            })?;
        match evt {
            Event::Start(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref())
                    .unwrap_or("")
                    .to_string();
                element_stack.push(tag);
            }
            Event::Empty(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                match tag {
                    "numFmt" => {
                        if let Some(entry) = parse_numfmt_attrs(&e) {
                            idx.num_fmts.push(entry);
                        }
                    }
                    "xf" if element_stack.last().map(String::as_str) == Some("cellXfs") => {
                        // Only count `<xf>` elements inside `<cellXfs>`,
                        // not `<cellStyleXfs>` (named styles — out of scope).
                        idx.cell_xfs.push(parse_xf_attrs(&e));
                    }
                    _ => {}
                }
            }
            Event::End(_) => {
                element_stack.pop();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(idx)
}

fn parse_numfmt_attrs(e: &quick_xml::events::BytesStart) -> Option<NumFmtEntry> {
    let mut num_fmt_id: Option<u32> = None;
    let mut format_code = String::new();
    for attr in e.attributes().with_checks(false).flatten() {
        let key = attr.key.as_ref();
        let val = attr.unescape_value().unwrap_or_default();
        if key == b"numFmtId" {
            num_fmt_id = val.parse::<u32>().ok();
        } else if key == b"formatCode" {
            format_code = val.to_string();
        }
    }
    let id = num_fmt_id?;
    if format_code.is_empty() {
        return None;
    }
    Some(NumFmtEntry {
        num_fmt_id: id,
        format_code,
    })
}

fn parse_xf_attrs(e: &quick_xml::events::BytesStart) -> CellXf {
    let mut num_fmt_id: u32 = 0;
    let mut apply_number_format = false;
    for attr in e.attributes().with_checks(false).flatten() {
        let key = attr.key.as_ref();
        let val = attr.unescape_value().unwrap_or_default();
        if key == b"numFmtId" {
            num_fmt_id = val.parse::<u32>().unwrap_or(0);
        } else if key == b"applyNumberFormat" {
            apply_number_format = val == "1" || val.eq_ignore_ascii_case("true");
        }
    }
    CellXf {
        num_fmt_id,
        apply_number_format,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn pkg_with_styles(xml: &str) -> XlsxPackage {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zw.start_file("xl/styles.xml", opts).unwrap();
            zw.write_all(xml.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        XlsxPackage::from_bytes(buf)
    }

    #[test]
    fn missing_styles_xml_returns_empty_index() {
        let pkg = pkg_with_styles_other("xl/workbook.xml", "<workbook/>");
        let idx = parse_styles_xml(&pkg).unwrap();
        assert!(idx.num_fmts.is_empty());
        assert!(idx.cell_xfs.is_empty());
    }

    fn pkg_with_styles_other(name: &str, content: &str) -> XlsxPackage {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zw.start_file(name, opts).unwrap();
            zw.write_all(content.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        XlsxPackage::from_bytes(buf)
    }

    #[test]
    fn parse_custom_numfmts() {
        // Use r##"..."## delimiters because the format code
        // contains `"#` which would terminate r#"..."# early.
        let xml = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="165" formatCode="#,##0.00"/>
  </numFmts>
</styleSheet>"##;
        let pkg = pkg_with_styles(xml);
        let idx = parse_styles_xml(&pkg).unwrap();
        assert_eq!(idx.num_fmts.len(), 2);
        assert_eq!(idx.num_fmts[0].num_fmt_id, 164);
        assert_eq!(idx.num_fmts[0].format_code, "yyyy-mm-dd");
        assert_eq!(idx.num_fmts[1].num_fmt_id, 165);
        assert_eq!(idx.num_fmts[1].format_code, "#,##0.00");
    }

    #[test]
    fn parse_cell_xfs_only_not_cell_style_xfs() {
        // Verifies the stack-based filter — `<xf>` inside
        // `<cellStyleXfs>` is ignored (that's the named-styles table,
        // not per-cell styles).
        let xml = r#"<styleSheet>
  <cellStyleXfs count="1">
    <xf numFmtId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="164" applyNumberFormat="1"/>
    <xf numFmtId="165" applyNumberFormat="true"/>
  </cellXfs>
</styleSheet>"#;
        let pkg = pkg_with_styles(xml);
        let idx = parse_styles_xml(&pkg).unwrap();
        // Only the 3 cellXfs, not the cellStyleXfs.
        assert_eq!(idx.cell_xfs.len(), 3);
        assert_eq!(idx.cell_xfs[0].num_fmt_id, 0);
        assert!(!idx.cell_xfs[0].apply_number_format);
        assert_eq!(idx.cell_xfs[1].num_fmt_id, 164);
        assert!(idx.cell_xfs[1].apply_number_format);
        // `"true"` also recognized.
        assert!(idx.cell_xfs[2].apply_number_format);
    }

    #[test]
    fn numfmt_without_format_code_is_skipped() {
        // Defensive: malformed entry shouldn't crash; skipped silently.
        let xml = r#"<styleSheet>
  <numFmts>
    <numFmt numFmtId="164"/>
  </numFmts>
</styleSheet>"#;
        let pkg = pkg_with_styles(xml);
        let idx = parse_styles_xml(&pkg).unwrap();
        assert_eq!(idx.num_fmts.len(), 0);
    }
}
