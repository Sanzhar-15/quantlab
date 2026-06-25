//! Scan a worksheet xml for per-cell style index references.
//!
//! **W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format
//! application).** Closes the remaining round-trip gap: cells in
//! OOXML carry a `<c r="A1" s="3"/>` reference into the
//! `<cellXfs>` table; calamine does not expose this attribute, so
//! we parse the worksheet xml directly.
//!
//! Output is a per-sheet `Vec<(RowId, ColId, u32)>` where the `u32`
//! is the cellXf index (0-based into `StyleIndex::cell_xfs`). The
//! caller maps that to a `FormatId` via
//! `cell_xfs[s].num_fmt_id` + `apply_number_format`.

use crate::error::XlsxError;
use ql_types::{ColId, RowId};
use quick_xml::events::Event;
use quick_xml::Reader;

/// Parse a worksheet xml string for `<c r="..." s="..."/>` pairs.
/// Cells without an `s` attribute, or with `s="0"` (default xf),
/// are NOT included — they render as General and don't need a
/// `format_overlay` entry.
pub(crate) fn parse_cell_styles_xml(
    content: &str,
    part_path: &str,
) -> Result<Vec<(RowId, ColId, u32)>, XlsxError> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut out: Vec<(RowId, ColId, u32)> = Vec::new();
    let mut buf = Vec::new();
    loop {
        let evt = reader
            .read_event_into(&mut buf)
            .map_err(|e| XlsxError::XmlParse {
                part: part_path.to_string(),
                source: e,
            })?;
        match evt {
            Event::Start(e) | Event::Empty(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                if tag == "c" {
                    let mut r_attr: Option<String> = None;
                    let mut s_attr: Option<u32> = None;
                    for attr in e.attributes().with_checks(false) {
                        // TA10: de-flatten + loud unescape (No-Fallbacks). A
                        // malformed `<c>` attribute is corruption. (A malformed
                        // cell *address* `r` value remains a documented silent
                        // skip below — the calamine grid path cross-checks it;
                        // this is the value-shape, not an XML/syntax error.)
                        let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
                            part: part_path.to_string(),
                            message: format!("malformed <c> attribute: {err}"),
                        })?;
                        let key = attr.key.as_ref();
                        let val = attr.unescape_value().map_err(|err| {
                            XlsxError::MalformedOoxml {
                                part: part_path.to_string(),
                                message: format!("malformed <c> attribute value: {err}"),
                            }
                        })?;
                        if key == b"r" {
                            r_attr = Some(val.to_string());
                        } else if key == b"s" {
                            // TA10/COR-05 (no-fallbacks): a present-but-malformed
                            // `s` (style index) is corruption. The old `if let Ok`
                            // silently left `s_attr = None`, dropping the cell from
                            // the format overlay (rendered with the default style).
                            s_attr = Some(super::parse_u32_attr(&val, "s", part_path)?);
                        }
                    }
                    // Skip cells that don't reference a non-default style.
                    let (r_ref, s_idx) = match (r_attr, s_attr) {
                        (Some(r), Some(s)) if s != 0 => (r, s),
                        _ => continue,
                    };
                    if let Some((row, col)) = parse_a1_cell(&r_ref) {
                        out.push((row, col, s_idx));
                    }
                    // Malformed refs are silently skipped — the
                    // calamine grid path would have rejected them
                    // already.
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// Parse `A1` / `BC42` into `(row, col)` zero-indexed. Returns
/// `None` for malformed refs (empty, no digits, etc.) AND for refs
/// outside Excel's address grid (col > MAX_COLUMN, row > MAX_ROW).
///
/// **W5-D-PM-2 (megaudit Opus-B HIGH-2 / self M-6 closure):** the
/// prior version accepted arbitrary letter counts + row digit
/// strings. Hostile inputs like `<c r="XFE1" s="3"/>` (col 16384,
/// one past MAX_COLUMN) silently stored entries in
/// `Sheet::format_overlay`, then round-tripped as malformed output.
/// `parse_a1_cell` now bounds-checks against ql_types::MAX_ROW /
/// MAX_COLUMN.
fn parse_a1_cell(text: &str) -> Option<(RowId, ColId)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i == 0 || i == bytes.len() {
        return None;
    }
    // Excel's max column label is "XFD" = 3 letters. Anything longer
    // is out-of-range; reject early to avoid u32 overflow and to
    // honor the address grid.
    if i > 3 {
        return None;
    }
    let col_letters = &text[..i];
    let row_digits = &text[i..];
    let mut col: u32 = 0;
    for c in col_letters.chars() {
        if !c.is_ascii_alphabetic() {
            return None;
        }
        col = col
            .checked_mul(26)?
            .checked_add(c.to_ascii_uppercase() as u32 - b'A' as u32 + 1)?;
    }
    let col = col.checked_sub(1)?;
    let row: u32 = row_digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    let row_zero_idx = row - 1;
    if col > ql_types::MAX_COLUMN || row_zero_idx > ql_types::MAX_ROW {
        return None;
    }
    Some((row_zero_idx, col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_styled_cells() {
        let xml = r#"<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" s="3"><v>1</v></c>
      <c r="B1" s="0"><v>2</v></c>
      <c r="C1"><v>3</v></c>
      <c r="D1" s="5"/>
    </row>
  </sheetData>
</worksheet>"#;
        let out = parse_cell_styles_xml(xml, "xl/worksheets/sheet1.xml").unwrap();
        // A1 (s=3) and D1 (s=5) — skip B1 (s=0 default) and C1 (no s).
        assert_eq!(out.len(), 2);
        assert!(out.contains(&(0, 0, 3)));
        assert!(out.contains(&(0, 3, 5)));
    }

    #[test]
    fn empty_sheet_returns_empty_vec() {
        let xml = r#"<worksheet xmlns="..."><sheetData/></worksheet>"#;
        let out = parse_cell_styles_xml(xml, "xl/worksheets/sheet1.xml").unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn parses_a1_cell_basic() {
        assert_eq!(parse_a1_cell("A1"), Some((0, 0)));
        assert_eq!(parse_a1_cell("Z9"), Some((8, 25)));
        assert_eq!(parse_a1_cell("AA10"), Some((9, 26)));
    }

    #[test]
    fn parses_a1_cell_rejects_malformed() {
        assert!(parse_a1_cell("").is_none());
        assert!(parse_a1_cell("1A").is_none());
        assert!(parse_a1_cell("A").is_none());
        assert!(parse_a1_cell("A0").is_none());
    }

    #[test]
    fn skips_unparseable_cell_refs_gracefully() {
        // Cells with malformed `r` attrs are silently skipped.
        let xml = r#"<worksheet>
          <sheetData>
            <c r="" s="3"/>
            <c r="garbage" s="4"/>
            <c r="A1" s="7"/>
          </sheetData>
        </worksheet>"#;
        let out = parse_cell_styles_xml(xml, "test").unwrap();
        assert_eq!(out, vec![(0, 0, 7)]);
    }

    #[test]
    fn ta10_malformed_style_index_errors() {
        // A present-but-malformed `s` (style index) is corruption. The old
        // `if let Ok` silently left `s_attr = None`, dropping the cell from
        // the format overlay (rendered with the default style). It must now
        // surface loudly. (Note: a malformed `r` stays a silent skip — a
        // separate, documented class; this test isolates `s`.)
        let xml = r#"<worksheet>
          <sheetData>
            <c r="A1" s="not-a-number"/>
          </sheetData>
        </worksheet>"#;
        match parse_cell_styles_xml(xml, "xl/worksheets/sheet1.xml") {
            Err(XlsxError::MalformedOoxml { part, message }) => {
                assert_eq!(part, "xl/worksheets/sheet1.xml");
                assert!(message.contains("attribute s"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn ta10_absent_style_index_is_skipped_not_error() {
        // Regression guard: an ABSENT `s` is skipped (no overlay), NOT an error.
        let xml = r#"<worksheet><sheetData><c r="A1"><v>1</v></c></sheetData></worksheet>"#;
        let out = parse_cell_styles_xml(xml, "xl/worksheets/sheet1.xml").unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn ta10_malformed_entity_in_attr_value_errors() {
        // TA10 fold: a malformed XML entity in an attribute value is corruption.
        // The old `unescape_value().unwrap_or_default()` swallowed it to "";
        // it must now surface loudly.
        let xml = r#"<worksheet><sheetData><c r="A1" s="&bogus;"/></sheetData></worksheet>"#;
        match parse_cell_styles_xml(xml, "xl/worksheets/sheet1.xml") {
            Err(XlsxError::MalformedOoxml { .. }) => {}
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }
}
