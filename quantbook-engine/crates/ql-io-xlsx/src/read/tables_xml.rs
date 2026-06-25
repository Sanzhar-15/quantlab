//! Parse `xl/tables/table*.xml` files into Quantbook table metadata.
//!
//! **Phase 4.8 territory**: Quantbook has first-class table support
//! (`Sales[Qty]` structured refs, rename/resize hooks, totals row
//! metadata). This module reconstructs that from OOXML.
//!
//! OOXML table.xml shape:
//! ```xml
//! <table xmlns="..." id="1" name="Sales" displayName="Sales"
//!        ref="A1:D6" totalsRowCount="1" headerRowCount="1">
//!   <autoFilter ref="A1:D5"/>
//!   <tableColumns count="4">
//!     <tableColumn id="1" name="Date" />
//!     <tableColumn id="2" name="Qty" totalsRowFunction="sum"/>
//!     <tableColumn id="3" name="Price"/>
//!     <tableColumn id="4" name="Total" totalsRowFunction="custom"/>
//!   </tableColumns>
//!   <tableStyleInfo name="TableStyleMedium2"/>
//! </table>
//! ```

use crate::error::XlsxError;
use crate::read::package::XlsxPackage;
use ql_storage::{TableColumn, TableMetadata, TotalsFunction};
use ql_types::{ColId, RowId, SheetId};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::sync::Arc;

/// Parsed table XML data, before being mapped to a SheetId.
#[derive(Debug, Clone)]
pub(crate) struct ParsedTable {
    /// Internal table id from the `id` attribute (numeric).
    #[allow(dead_code)]
    pub id: u32,
    /// `name` attribute — engine canonical form is uppercase.
    pub name: String,
    /// `displayName` attribute — case-preserving for round-trip.
    pub display_name: String,
    /// `ref` attribute parsed into (top_row, top_col, rows, cols).
    /// All zero-based.
    pub top_row: RowId,
    pub top_col: ColId,
    pub rows: u32,
    pub cols: u32,
    /// `headerRowCount` attribute (defaults to 1 per OOXML).
    pub header_row_count: u32,
    /// `totalsRowCount` attribute (defaults to 0).
    pub totals_row_count: u32,
    /// `<tableColumn>` rows.
    pub columns: Vec<ParsedTableColumn>,
}

/// One `<tableColumn>` row.
#[derive(Debug, Clone)]
pub(crate) struct ParsedTableColumn {
    /// `id` attribute — stable column identifier (preserved across
    /// renames; matches Quantbook's `TableColumn::id`).
    pub id: u32,
    /// `name` attribute (case-preserved).
    pub name: String,
    /// `totalsRowFunction` attribute (`sum`/`average`/etc.). `None`
    /// if absent.
    pub totals_row_function: Option<TotalsFunction>,
}

/// Parse a numeric OOXML table attribute that is **present** on the element.
///
/// **W5 / COR-05 (2026-06-25):** a present-but-unparseable numeric attribute
/// (`headerRowCount="abc"`, two `<tableColumn>`s with `id="x"`) is corruption,
/// not a missing value — surfacing `XlsxError::MalformedOoxml` honours the
/// no-fallbacks rule. The pre-COR-05 `val.parse().unwrap_or(<default>)` aliased
/// malformed input onto the OOXML *absent-attribute* default, silently
/// producing e.g. `headerRowCount=1` from garbage or colliding stable column
/// ids on `id=0`. The absent-attribute default stays correct because the caller
/// initialises each field before the attribute loop and only calls this helper
/// inside the branch that fires when the attribute is actually present.
fn parse_u32_attr(val: &str, attr: &str, part_path: &str) -> Result<u32, XlsxError> {
    val.parse::<u32>().map_err(|e| XlsxError::MalformedOoxml {
        part: part_path.to_string(),
        message: format!("<table> attribute {attr} is not a valid u32: {val:?} ({e})"),
    })
}

/// Parse one `xl/tables/table*.xml` file.
pub(crate) fn parse_table_xml(content: &str, part_path: &str) -> Result<ParsedTable, XlsxError> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut id: u32 = 0;
    let mut name = String::new();
    let mut display_name = String::new();
    let mut ref_str = String::new();
    let mut header_row_count: u32 = 1;
    let mut totals_row_count: u32 = 0;
    let mut columns: Vec<ParsedTableColumn> = Vec::new();

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
                match tag {
                    "table" => {
                        for attr in e.attributes().with_checks(false) {
                            // COR-05: a malformed attribute (bad KV syntax, or a
                            // bad entity escape in the value) is corruption —
                            // surface it loudly instead of silently dropping it
                            // (the old `.flatten()` / `.unwrap_or_default()`).
                            let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
                                part: part_path.to_string(),
                                message: format!("malformed <table> attribute: {err}"),
                            })?;
                            let key = attr.key.as_ref();
                            let val =
                                attr.unescape_value().map_err(|err| XlsxError::MalformedOoxml {
                                    part: part_path.to_string(),
                                    message: format!("malformed <table> attribute value: {err}"),
                                })?;
                            if key == b"id" {
                                id = parse_u32_attr(val.as_ref(), "id", part_path)?;
                            } else if key == b"name" {
                                name = val.to_string();
                            } else if key == b"displayName" {
                                display_name = val.to_string();
                            } else if key == b"ref" {
                                ref_str = val.to_string();
                            } else if key == b"headerRowCount" {
                                header_row_count =
                                    parse_u32_attr(val.as_ref(), "headerRowCount", part_path)?;
                            } else if key == b"totalsRowCount" {
                                totals_row_count =
                                    parse_u32_attr(val.as_ref(), "totalsRowCount", part_path)?;
                            }
                        }
                    }
                    "tableColumn" => {
                        let mut col_id: u32 = 0;
                        let mut col_name = String::new();
                        let mut totals_fn: Option<TotalsFunction> = None;
                        for attr in e.attributes().with_checks(false) {
                            let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
                                part: part_path.to_string(),
                                message: format!("malformed <tableColumn> attribute: {err}"),
                            })?;
                            let key = attr.key.as_ref();
                            let val =
                                attr.unescape_value().map_err(|err| XlsxError::MalformedOoxml {
                                    part: part_path.to_string(),
                                    message: format!(
                                        "malformed <tableColumn> attribute value: {err}"
                                    ),
                                })?;
                            if key == b"id" {
                                col_id = parse_u32_attr(val.as_ref(), "tableColumn id", part_path)?;
                            } else if key == b"name" {
                                col_name = val.to_string();
                            } else if key == b"totalsRowFunction" {
                                // COR-05: a PRESENT but unrecognized totals-row
                                // function is corruption, not "no totals function"
                                // — the OOXML ST_TotalsRowFunction enumeration is
                                // closed, so surface an unknown value loudly.
                                totals_fn = Some(parse_totals_function(&val).ok_or_else(|| {
                                    XlsxError::MalformedOoxml {
                                        part: part_path.to_string(),
                                        message: format!("unknown totalsRowFunction value: {val:?}"),
                                    }
                                })?);
                            }
                        }
                        if !col_name.is_empty() {
                            columns.push(ParsedTableColumn {
                                id: col_id,
                                name: col_name,
                                totals_row_function: totals_fn,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if name.is_empty() {
        return Err(XlsxError::MalformedOoxml {
            part: part_path.to_string(),
            message: "<table> element missing required name attribute".to_string(),
        });
    }
    if display_name.is_empty() {
        // Default per OOXML: displayName falls back to name.
        display_name = name.clone();
    }
    let (top_row, top_col, rows, cols) =
        parse_a1_ref(&ref_str).ok_or_else(|| XlsxError::MalformedOoxml {
            part: part_path.to_string(),
            message: format!("invalid table ref attribute: {ref_str:?}"),
        })?;

    Ok(ParsedTable {
        id,
        name,
        display_name,
        top_row,
        top_col,
        rows,
        cols,
        header_row_count,
        totals_row_count,
        columns,
    })
}

/// Convert a parsed table + its owning sheet into a Quantbook
/// `TableMetadata`. The caller already knows `sheet_id` from the
/// rels-resolution step.
pub(crate) fn parsed_table_to_metadata(parsed: ParsedTable, sheet: SheetId) -> TableMetadata {
    let columns: Vec<TableColumn> = parsed
        .columns
        .into_iter()
        .map(|c| TableColumn {
            id: c.id,
            name: Arc::from(c.name.to_ascii_lowercase()),
            display: Arc::from(c.name),
            totals_function: c.totals_row_function,
        })
        .collect();
    TableMetadata {
        name: Arc::from(parsed.name.to_ascii_uppercase()),
        display_name: Arc::from(parsed.display_name),
        sheet,
        top_row: parsed.top_row,
        top_col: parsed.top_col,
        rows: parsed.rows,
        cols: parsed.cols,
        has_header: parsed.header_row_count > 0,
        has_totals: parsed.totals_row_count > 0,
        columns,
    }
}

/// Parse an A1-style ref like `A1:D6` into `(top_row, top_col, rows, cols)`.
/// All zero-based. Single-cell refs `A1` are valid (rows=1, cols=1).
fn parse_a1_ref(s: &str) -> Option<(RowId, ColId, u32, u32)> {
    let (start, end) = match s.find(':') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, s),
    };
    let (top_row, top_col) = parse_a1_cell(start)?;
    let (bot_row, bot_col) = parse_a1_cell(end)?;
    if bot_row < top_row || bot_col < top_col {
        return None;
    }
    Some((
        top_row,
        top_col,
        bot_row - top_row + 1,
        bot_col - top_col + 1,
    ))
}

/// Parse `A1` → `(row=0, col=0)`. `XFD1048576` → `(1048575, 16383)`.
fn parse_a1_cell(s: &str) -> Option<(RowId, ColId)> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut col: u32 = 0;
    while i < chars.len() && chars[i].is_ascii_alphabetic() {
        col = col
            .checked_mul(26)?
            .checked_add((chars[i].to_ascii_uppercase() as u32) - ('A' as u32) + 1)?;
        i += 1;
    }
    if col == 0 || i == 0 || i == chars.len() {
        return None;
    }
    let row_str: String = chars[i..].iter().collect();
    let row_1based: u32 = row_str.parse().ok()?;
    if row_1based == 0 {
        return None;
    }
    Some((row_1based - 1, col - 1))
}

fn parse_totals_function(s: &str) -> Option<TotalsFunction> {
    match s.to_ascii_lowercase().as_str() {
        "none" => Some(TotalsFunction::None),
        "average" => Some(TotalsFunction::Average),
        "count" => Some(TotalsFunction::Count),
        "countNums" | "countnums" => Some(TotalsFunction::CountNums),
        "max" => Some(TotalsFunction::Max),
        "min" => Some(TotalsFunction::Min),
        "stdDev" | "stddev" => Some(TotalsFunction::StdDev),
        "sum" => Some(TotalsFunction::Sum),
        "var" | "variance" => Some(TotalsFunction::Variance),
        "custom" => Some(TotalsFunction::Custom),
        _ => None,
    }
}

/// Parse a table XML file from the package given its in-package path.
pub(crate) fn read_table(package: &XlsxPackage, path: &str) -> Result<ParsedTable, XlsxError> {
    let content = package
        .read_part_string(path)?
        .ok_or_else(|| XlsxError::MalformedOoxml {
            part: path.to_string(),
            message: "table xml part not found".to_string(),
        })?;
    parse_table_xml(&content, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_a1_cell_basic() {
        assert_eq!(parse_a1_cell("A1"), Some((0, 0)));
        assert_eq!(parse_a1_cell("B2"), Some((1, 1)));
        assert_eq!(parse_a1_cell("Z10"), Some((9, 25)));
        assert_eq!(parse_a1_cell("AA1"), Some((0, 26)));
        assert_eq!(parse_a1_cell("XFD1048576"), Some((1048575, 16383)));
    }

    #[test]
    fn parse_a1_cell_invalid_rejected() {
        assert_eq!(parse_a1_cell(""), None);
        assert_eq!(parse_a1_cell("A0"), None);
        assert_eq!(parse_a1_cell("1A"), None);
        assert_eq!(parse_a1_cell("AB"), None);
    }

    #[test]
    fn parse_a1_ref_single_cell() {
        assert_eq!(parse_a1_ref("A1"), Some((0, 0, 1, 1)));
    }

    #[test]
    fn parse_a1_ref_rectangular() {
        assert_eq!(parse_a1_ref("A1:D6"), Some((0, 0, 6, 4)));
        assert_eq!(parse_a1_ref("B2:C3"), Some((1, 1, 2, 2)));
    }

    #[test]
    fn parse_a1_ref_inverted_rejected() {
        // Bottom-right must be >= top-left.
        assert_eq!(parse_a1_ref("D6:A1"), None);
    }

    #[test]
    fn parse_table_xml_full_shape() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
       id="1" name="Sales" displayName="Sales"
       ref="A1:D6" totalsRowCount="1" headerRowCount="1">
  <autoFilter ref="A1:D5"/>
  <tableColumns count="4">
    <tableColumn id="1" name="Date"/>
    <tableColumn id="2" name="Qty" totalsRowFunction="sum"/>
    <tableColumn id="3" name="Price"/>
    <tableColumn id="4" name="Total" totalsRowFunction="custom"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2"/>
</table>"#;
        let parsed = parse_table_xml(xml, "xl/tables/table1.xml").unwrap();
        assert_eq!(parsed.name, "Sales");
        assert_eq!(parsed.display_name, "Sales");
        assert_eq!(parsed.top_row, 0);
        assert_eq!(parsed.top_col, 0);
        assert_eq!(parsed.rows, 6);
        assert_eq!(parsed.cols, 4);
        assert_eq!(parsed.header_row_count, 1);
        assert_eq!(parsed.totals_row_count, 1);
        assert_eq!(parsed.columns.len(), 4);
        assert_eq!(parsed.columns[1].name, "Qty");
        assert_eq!(
            parsed.columns[1].totals_row_function,
            Some(TotalsFunction::Sum)
        );
        assert_eq!(
            parsed.columns[3].totals_row_function,
            Some(TotalsFunction::Custom)
        );
        assert_eq!(parsed.columns[0].totals_row_function, None);
    }

    #[test]
    fn parse_table_xml_default_headerrowcount_is_one() {
        let xml = r#"<table name="T" displayName="T" ref="A1:B2">
  <tableColumns><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/></tableColumns>
</table>"#;
        let parsed = parse_table_xml(xml, "xl/tables/table1.xml").unwrap();
        assert_eq!(parsed.header_row_count, 1);
        assert_eq!(parsed.totals_row_count, 0);
    }

    #[test]
    fn parse_table_xml_missing_name_is_malformed() {
        let xml = r#"<table ref="A1:B2"><tableColumns/></table>"#;
        match parse_table_xml(xml, "xl/tables/table1.xml") {
            Err(XlsxError::MalformedOoxml { .. }) => {}
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    // ===== COR-05 (2026-06-25): present-but-malformed numeric attrs are loud =====
    // The OOXML *absent-attribute* default is still honoured (the field is
    // initialised before the attribute loop); only a *present* garbage value
    // must now fail loudly instead of silently collapsing to that default.

    #[test]
    fn parse_table_xml_malformed_headerrowcount_is_loud() {
        let xml = r#"<table name="T" displayName="T" ref="A1:B2" headerRowCount="abc">
  <tableColumns><tableColumn id="1" name="A"/></tableColumns>
</table>"#;
        match parse_table_xml(xml, "xl/tables/table1.xml") {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(
                    message.contains("headerRowCount"),
                    "error should name the offending attribute, got {message:?}"
                );
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn parse_table_xml_malformed_totalsrowcount_is_loud() {
        let xml = r#"<table name="T" displayName="T" ref="A1:B2" totalsRowCount="3.5">
  <tableColumns><tableColumn id="1" name="A"/></tableColumns>
</table>"#;
        match parse_table_xml(xml, "xl/tables/table1.xml") {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("totalsRowCount"));
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn parse_table_xml_malformed_table_id_is_loud() {
        let xml = r#"<table id="not-a-number" name="T" displayName="T" ref="A1:B2">
  <tableColumns><tableColumn id="1" name="A"/></tableColumns>
</table>"#;
        match parse_table_xml(xml, "xl/tables/table1.xml") {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                // `attribute id` (not just `id`) so this can't pass on the
                // `tableColumn id` error message instead.
                assert!(
                    message.contains("attribute id"),
                    "error should name the table id attribute, got {message:?}"
                );
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn parse_table_xml_malformed_column_id_is_loud() {
        // A garbage column id previously collapsed to 0 — and two such columns
        // would have collided on the stable-id key. Now it fails loudly.
        let xml = r#"<table name="T" displayName="T" ref="A1:B2">
  <tableColumns><tableColumn id="oops" name="A"/></tableColumns>
</table>"#;
        match parse_table_xml(xml, "xl/tables/table1.xml") {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("tableColumn id"));
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn parse_table_xml_absent_numeric_attrs_keep_ooxml_defaults() {
        // Regression guard for COR-05: absent headerRowCount/totalsRowCount/id
        // must still produce the OOXML defaults (1 / 0 / 0), not an error.
        let xml = r#"<table name="T" displayName="T" ref="A1:B2">
  <tableColumns><tableColumn id="1" name="A"/></tableColumns>
</table>"#;
        let parsed = parse_table_xml(xml, "xl/tables/table1.xml").expect("absent attrs are valid");
        assert_eq!(parsed.header_row_count, 1);
        assert_eq!(parsed.totals_row_count, 0);
        assert_eq!(parsed.id, 0);
    }

    #[test]
    fn parse_table_xml_absent_column_id_defaults_to_zero() {
        // COR-05 symmetry: an absent `<tableColumn>` id keeps the default (0),
        // not an error (only a PRESENT-but-malformed id fails).
        let xml = r#"<table name="T" displayName="T" ref="A1:B2">
  <tableColumns><tableColumn name="A"/></tableColumns>
</table>"#;
        let parsed =
            parse_table_xml(xml, "xl/tables/table1.xml").expect("absent column id is valid");
        assert_eq!(parsed.columns.len(), 1);
        assert_eq!(parsed.columns[0].id, 0);
    }

    #[test]
    fn parse_table_xml_unknown_totals_function_is_loud() {
        // COR-05: a present-but-unrecognized totalsRowFunction is corruption, not
        // silently "no totals function".
        let xml = r#"<table name="T" displayName="T" ref="A1:B2">
  <tableColumns><tableColumn id="1" name="A" totalsRowFunction="bogus"/></tableColumns>
</table>"#;
        match parse_table_xml(xml, "xl/tables/table1.xml") {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("totalsRowFunction"));
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn parsed_table_to_metadata_canonicalizes_name() {
        let parsed = ParsedTable {
            id: 1,
            name: "Sales".to_string(),
            display_name: "Sales".to_string(),
            top_row: 0,
            top_col: 0,
            rows: 6,
            cols: 4,
            header_row_count: 1,
            totals_row_count: 1,
            columns: vec![ParsedTableColumn {
                id: 1,
                name: "Date".to_string(),
                totals_row_function: None,
            }],
        };
        let meta = parsed_table_to_metadata(parsed, 0);
        // Quantbook canonical = uppercase.
        assert_eq!(&*meta.name, "SALES");
        assert_eq!(&*meta.display_name, "Sales");
        // Column canonical = lowercase per Quantbook convention.
        assert_eq!(&*meta.columns[0].name, "date");
        assert_eq!(&*meta.columns[0].display, "Date");
        assert!(meta.has_header);
        assert!(meta.has_totals);
    }
}
