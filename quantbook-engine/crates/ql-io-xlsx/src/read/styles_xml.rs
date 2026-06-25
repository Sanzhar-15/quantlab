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
                // **W5-D-15.1 (self-audit H-2 root-cause closure):**
                // LibreOffice emits `<xf>...</xf>` (non-self-closing,
                // with `<alignment>` / `<protection>` children) — those
                // come through as `Event::Start`, NOT `Event::Empty`.
                // Without this branch, every cellXf in a LibreOffice
                // file was silently dropped from the index.
                if tag == "xf" && element_stack.last().map(String::as_str) == Some("cellXfs") {
                    idx.cell_xfs.push(parse_xf_attrs(&e)?);
                } else if tag == "numFmt" {
                    // TA10: `<numFmt>` may appear non-self-closing
                    // (`<numFmt ...></numFmt>`) → Start, not Empty. Parse here
                    // too so a present-but-malformed numFmtId still errors and
                    // valid non-self-closing custom formats are not dropped
                    // (mirrors the `xf` Start/Empty symmetry above).
                    if let Some(entry) = parse_numfmt_attrs(&e, PART)? {
                        idx.num_fmts.push(entry);
                    }
                }
                element_stack.push(tag);
            }
            Event::Empty(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                match tag {
                    "numFmt" => {
                        if let Some(entry) = parse_numfmt_attrs(&e, PART)? {
                            idx.num_fmts.push(entry);
                        }
                    }
                    "xf" if element_stack.last().map(String::as_str) == Some("cellXfs") => {
                        // Only count `<xf>` elements inside `<cellXfs>`,
                        // not `<cellStyleXfs>` (named styles — out of scope).
                        idx.cell_xfs.push(parse_xf_attrs(&e)?);
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

fn parse_numfmt_attrs(
    e: &quick_xml::events::BytesStart,
    part: &str,
) -> Result<Option<NumFmtEntry>, XlsxError> {
    let mut num_fmt_id: Option<u32> = None;
    let mut format_code = String::new();
    for attr in e.attributes().with_checks(false) {
        // TA10: de-flatten + loud unescape (No-Fallbacks).
        let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
            part: part.to_string(),
            message: format!("malformed <numFmt> attribute: {err}"),
        })?;
        let key = attr.key.as_ref();
        let val = attr.unescape_value().map_err(|err| XlsxError::MalformedOoxml {
            part: part.to_string(),
            message: format!("malformed <numFmt> attribute value: {err}"),
        })?;
        if key == b"numFmtId" {
            // TA10/COR-05 (no-fallbacks): a present-but-malformed `numFmtId`
            // is corruption. The old `.parse().ok()` collapsed garbage onto
            // `None`, indistinguishable from an absent attr — silently
            // dropping the entire custom number-format definition (the
            // user's `#,##0.00 €` etc. vanished). Mirrors `parse_xf_attrs`
            // (NF-05), which already errors loudly on the `<cellXfs>/<xf>`
            // side of the same id.
            num_fmt_id = Some(super::parse_u32_attr(&val, "numFmtId", part)?);
        } else if key == b"formatCode" {
            format_code = val.to_string();
        }
    }
    // Absent `numFmtId` or empty `formatCode` → not a usable custom-format
    // definition; legitimately skipped (distinct from malformed-present,
    // which already returned `Err` above).
    let Some(id) = num_fmt_id else {
        return Ok(None);
    };
    if format_code.is_empty() {
        return Ok(None);
    }
    Ok(Some(NumFmtEntry {
        num_fmt_id: id,
        format_code,
    }))
}

/// **NF-05 (no-fallbacks):** returns `Err` if `numFmtId` is present but
/// not a valid `u32`. Previously used `unwrap_or(0)` which silently treated
/// a malformed id as "General" format (0), losing the user's number format.
fn parse_xf_attrs(e: &quick_xml::events::BytesStart) -> Result<CellXf, XlsxError> {
    let mut num_fmt_id: u32 = 0;
    // **W5-D-15.1 (self-audit H-2 closure):** the OOXML schema
    // default for `applyNumberFormat` on `<cellXfs>/<xf>` is TRUE
    // when the attribute is absent. LibreOffice-generated files
    // commonly omit the attr but still expect the numFmtId to be
    // applied — verified empirically against
    // `libreoffice_888_example.xlsx` (numFmtId=165 xf with no
    // applyNumberFormat attr → format IS applied per the spec).
    // The prior `false` default silently dropped these on import.
    let mut apply_number_format = true;
    for attr in e.attributes().with_checks(false) {
        // TA10: de-flatten + loud unescape (No-Fallbacks).
        let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
            part: "xl/styles.xml".to_string(),
            message: format!("malformed <cellXfs>/<xf> attribute: {err}"),
        })?;
        let key = attr.key.as_ref();
        let val = attr.unescape_value().map_err(|err| XlsxError::MalformedOoxml {
            part: "xl/styles.xml".to_string(),
            message: format!("malformed <cellXfs>/<xf> attribute value: {err}"),
        })?;
        if key == b"numFmtId" {
            num_fmt_id = val.parse::<u32>().map_err(|_| XlsxError::MalformedOoxml {
                part: "xl/styles.xml".to_string(),
                message: format!(
                    "<cellXfs>/<xf> numFmtId={:?} is not a valid u32; \
                     cannot determine number format — workbook may be corrupt",
                    val.as_ref(),
                ),
            })?;
        } else if key == b"applyNumberFormat" {
            // Explicit attr: "1"/"true" → apply; "0"/"false" → don't.
            // TA10: loud boolean (was `== "1" || eq_ignore..true`, which
            // silently treated a malformed value as "don't apply").
            apply_number_format =
                super::parse_bool_attr(&val, "applyNumberFormat", "xl/styles.xml")?;
        }
    }
    Ok(CellXf {
        num_fmt_id,
        apply_number_format,
    })
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
        // **W5-D-15.1 (self-audit H-2 closure):** OOXML default for
        // `applyNumberFormat` is `true` when the attr is absent.
        // Cell xfs with no attribute now read as `true`.
        assert!(idx.cell_xfs[0].apply_number_format);
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

    // ============================================================
    // NF-05 — malformed numFmtId in <cellXfs>/<xf> errors loudly
    // ============================================================

    /// A `numFmtId` that is not a valid u32 must produce
    /// `XlsxError::MalformedOoxml` instead of silently falling back to 0
    /// (General format), which was the pre-NF-05 behavior.
    #[test]
    fn nf05_malformed_num_fmt_id_returns_error() {
        let xml = r#"<styleSheet>
  <cellXfs count="1">
    <xf numFmtId="not-a-number" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>"#;
        let pkg = pkg_with_styles(xml);
        let err = parse_styles_xml(&pkg).unwrap_err();
        match err {
            XlsxError::MalformedOoxml { part, message } => {
                assert_eq!(part, "xl/styles.xml");
                assert!(
                    message.contains("numFmtId"),
                    "error message should mention numFmtId; got: {message}"
                );
                assert!(
                    message.contains("not-a-number"),
                    "error message should quote the bad value; got: {message}"
                );
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    /// A valid `numFmtId` that happens to be at the boundary (u32::MAX - 1)
    /// must NOT error — only genuinely non-numeric values fail.
    #[test]
    fn nf05_valid_large_num_fmt_id_is_accepted() {
        let xml = r#"<styleSheet>
  <cellXfs count="1">
    <xf numFmtId="4294967294" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>"#;
        let pkg = pkg_with_styles(xml);
        let idx = parse_styles_xml(&pkg).unwrap();
        assert_eq!(idx.cell_xfs.len(), 1);
        assert_eq!(idx.cell_xfs[0].num_fmt_id, 4_294_967_294u32);
    }

    // ============================================================
    // TA10 — malformed numFmtId on the <numFmt> *definition* errors
    // loudly (the sibling of NF-05, which guards <cellXfs>/<xf>).
    // ============================================================

    /// A malformed `numFmtId` on a `<numFmt>` definition must error
    /// loudly instead of `.parse().ok()` collapsing it to `None` —
    /// which silently dropped the user's entire custom number format.
    #[test]
    fn ta10_malformed_numfmt_def_id_returns_error() {
        let xml = r#"<styleSheet>
  <numFmts count="1">
    <numFmt numFmtId="not-a-number" formatCode="yyyy-mm-dd"/>
  </numFmts>
</styleSheet>"#;
        let pkg = pkg_with_styles(xml);
        let err = parse_styles_xml(&pkg).unwrap_err();
        match err {
            XlsxError::MalformedOoxml { part, message } => {
                assert_eq!(part, "xl/styles.xml");
                assert!(
                    message.contains("numFmtId"),
                    "error should mention numFmtId; got: {message}"
                );
                assert!(
                    message.contains("not-a-number"),
                    "error should quote the bad value; got: {message}"
                );
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    /// An *absent* `numFmtId` (vs present-malformed) is legitimately
    /// skipped, NOT an error — the absent/present distinction is the
    /// whole point of the loud helper.
    #[test]
    fn ta10_numfmt_def_absent_id_is_skipped_not_error() {
        let xml = r#"<styleSheet>
  <numFmts count="1">
    <numFmt formatCode="yyyy-mm-dd"/>
  </numFmts>
</styleSheet>"#;
        let pkg = pkg_with_styles(xml);
        let idx = parse_styles_xml(&pkg).unwrap();
        assert_eq!(idx.num_fmts.len(), 0);
    }

    #[test]
    fn ta10_numfmt_def_valid_large_id_is_accepted() {
        // Boundary guard for the <numFmt> definition path (parity with the
        // NF-05 cellXfs boundary test).
        let xml = r#"<styleSheet>
  <numFmts count="1">
    <numFmt numFmtId="4294967294" formatCode="yyyy-mm-dd"/>
  </numFmts>
</styleSheet>"#;
        let idx = parse_styles_xml(&pkg_with_styles(xml)).unwrap();
        assert_eq!(idx.num_fmts.len(), 1);
        assert_eq!(idx.num_fmts[0].num_fmt_id, 4_294_967_294u32);
    }

    #[test]
    fn ta10_malformed_apply_number_format_errors() {
        // TA10: a present-but-invalid `applyNumberFormat` boolean is
        // corruption — the old `== "1" || eq_ignore..true` silently treated
        // it as "don't apply", dropping the user's number format.
        let xml = r#"<styleSheet>
  <cellXfs count="1">
    <xf numFmtId="164" applyNumberFormat="banana"/>
  </cellXfs>
</styleSheet>"#;
        match parse_styles_xml(&pkg_with_styles(xml)) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("applyNumberFormat"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn ta10_non_self_closing_numfmt_is_parsed() {
        // TA10 fold (Codex HIGH): a non-self-closing `<numFmt></numFmt>`
        // arrives as Event::Start, not Empty. It must be parsed too —
        // a valid one is kept; a malformed numFmtId errors loudly (was
        // silently skipped entirely before).
        let valid = r#"<styleSheet>
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"></numFmt>
  </numFmts>
</styleSheet>"#;
        let idx = parse_styles_xml(&pkg_with_styles(valid)).unwrap();
        assert_eq!(idx.num_fmts.len(), 1);
        assert_eq!(idx.num_fmts[0].num_fmt_id, 164);

        let malformed = r#"<styleSheet>
  <numFmts count="1">
    <numFmt numFmtId="not-a-number" formatCode="yyyy-mm-dd"></numFmt>
  </numFmts>
</styleSheet>"#;
        match parse_styles_xml(&pkg_with_styles(malformed)) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("numFmtId"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }
}
