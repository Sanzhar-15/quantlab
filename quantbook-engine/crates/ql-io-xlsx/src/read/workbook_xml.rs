//! Parse `xl/workbook.xml` — workbook properties, sheet metadata,
//! defined names with scope.
//!
//! **Why direct OOXML parse and not calamine**: calamine's
//! `defined_names()` flattens to `(name, formula_text)` and drops
//! `localSheetId`, so we can't distinguish workbook-scoped from
//! sheet-scoped names. Per the W5-D-14 plan, the OOXML scanner is
//! authoritative for this metadata; calamine is the cell-grid
//! backend.

use crate::error::XlsxError;
use crate::read::package::XlsxPackage;
use ql_types::DateSystem;
use quick_xml::events::Event;
use quick_xml::Reader;

/// Parsed contents of `xl/workbook.xml`.
///
/// **W5-D-14b**: not all fields are consumed by the import pipeline
/// yet — `sheets` metadata and `defined_names` will be wired in
/// W5-D-14c (table imports cross-reference sheet positions) and
/// W5-D-15 (named-range resolution into the engine's `NameTable`).
/// They are parsed now so the OOXML scanner shape is locked.
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub(crate) struct WorkbookProperties {
    /// `workbookPr/@date1904` — `false` for the 1900 system (default),
    /// `true` for the 1904 system. Affects every date serial in the
    /// workbook.
    pub date_system: DateSystem,
    /// Sheets in workbook order (from `<sheets>/<sheet>` elements).
    /// Order = the order the user sees in Excel's tab bar.
    pub sheets: Vec<SheetMeta>,
    /// Defined names with full scope info. Calamine drops
    /// `localSheetId`; this parser keeps it.
    pub defined_names: Vec<DefinedNameMeta>,
}

/// One `<sheet>` element from `xl/workbook.xml/<sheets>`.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct SheetMeta {
    /// Display name (e.g. `"Sheet1"`).
    pub name: String,
    /// `sheetId` attribute — a workbook-unique integer that DOES NOT
    /// necessarily equal the workbook-order index. (E.g., if a sheet
    /// was deleted, `sheetId` values can be sparse.)
    pub sheet_id: u32,
    /// `r:id` attribute — points into `xl/_rels/workbook.xml.rels`
    /// for the actual sheet part path. Phase 4.11 doesn't require
    /// rels resolution yet (calamine handles the sheet → path map);
    /// kept for forward compat.
    pub r_id: String,
    /// `state` attribute: `visible` / `hidden` / `veryHidden`.
    /// Defaults to `visible` when absent.
    pub state: SheetState,
}

/// Sheet visibility state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum SheetState {
    /// Sheet is shown in the tab bar.
    #[default]
    Visible,
    /// Sheet is hidden (user can right-click to unhide).
    Hidden,
    /// Sheet is very-hidden (must be unhidden via VBA).
    VeryHidden,
}

/// One `<definedName>` element from
/// `xl/workbook.xml/<definedNames>`.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct DefinedNameMeta {
    /// The name as the user typed it (case-preserved).
    pub name: String,
    /// The name's target as raw OOXML formula text (e.g.
    /// `Sheet1!$A$1:$B$2`). Caller must canonicalize before
    /// registering with the engine's `NameTable`.
    pub formula_text: String,
    /// `localSheetId` attribute — when present, the name is
    /// SHEET-SCOPED (its target is `localSheetId`-indexed sheet).
    /// `None` = workbook-scoped.
    pub local_sheet_id: Option<u32>,
}

/// Read + parse `xl/workbook.xml` from the package.
///
/// Returns `WorkbookProperties::default()` (1900 system, empty sheets,
/// empty names) if `xl/workbook.xml` doesn't exist — but a real xlsx
/// MUST have this part, so missing → `XlsxError::MalformedOoxml` to
/// surface the corruption.
pub(crate) fn parse_workbook_xml(package: &XlsxPackage) -> Result<WorkbookProperties, XlsxError> {
    const PART: &str = "xl/workbook.xml";
    let content = match package.read_part_string(PART)? {
        Some(c) => c,
        None => {
            return Err(XlsxError::MalformedOoxml {
                part: PART.to_string(),
                message: "xl/workbook.xml not found in package (required by OOXML spec)"
                    .to_string(),
            })
        }
    };

    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut props = WorkbookProperties::default();
    let mut buf = Vec::new();

    // Collect `<definedName>` text content across multiple event
    // chunks (quick-xml emits Start/Text/End separately).
    let mut current_name: Option<DefinedNameBuilder> = None;

    loop {
        let evt = reader
            .read_event_into(&mut buf)
            .map_err(|e| XlsxError::XmlParse {
                part: PART.to_string(),
                source: e,
            })?;
        match evt {
            Event::Empty(e) => {
                // self-closing — typical for <workbookPr ... /> and
                // <sheet name="..." sheetId="1" r:id="rId1" />.
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                match tag {
                    "workbookPr" => {
                        for attr in e.attributes().with_checks(false) {
                            // TA10: de-flatten + loud unescape (was `.flatten()` /
                            // `unwrap_or_default()`) — a malformed attribute is
                            // corruption, not a skippable item (No-Fallbacks).
                            let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
                                part: PART.to_string(),
                                message: format!("malformed <workbookPr> attribute: {err}"),
                            })?;
                            if attr.key.as_ref() == b"date1904" {
                                let v = attr.unescape_value().map_err(|err| {
                                    XlsxError::MalformedOoxml {
                                        part: PART.to_string(),
                                        message: format!(
                                            "malformed <workbookPr> attribute value: {err}"
                                        ),
                                    }
                                })?;
                                // TA10: loud boolean (was `== "1" || eq_ignore..true`
                                // which silently treated a malformed value as 1900).
                                if super::parse_bool_attr(&v, "date1904", PART)? {
                                    props.date_system = DateSystem::Excel1904;
                                }
                            }
                        }
                    }
                    "sheet" => {
                        if let Some(meta) = parse_sheet_attrs(&e, PART)? {
                            props.sheets.push(meta);
                        }
                    }
                    _ => {}
                }
            }
            Event::Start(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                if tag == "definedName" {
                    let mut builder = DefinedNameBuilder::default();
                    for attr in e.attributes().with_checks(false) {
                        // TA10: de-flatten + loud unescape (No-Fallbacks). The old
                        // `.flatten()` dropped malformed attributes and
                        // `unwrap_or_default()` turned an unescape failure into ""
                        // (which then silently dropped the whole defined name at the
                        // `!name.is_empty()` guard).
                        let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
                            part: PART.to_string(),
                            message: format!("malformed <definedName> attribute: {err}"),
                        })?;
                        let key = attr.key.as_ref();
                        let val = attr.unescape_value().map_err(|err| {
                            XlsxError::MalformedOoxml {
                                part: PART.to_string(),
                                message: format!("malformed <definedName> attribute value: {err}"),
                            }
                        })?;
                        if key == b"name" {
                            builder.name = val.to_string();
                        } else if key == b"localSheetId" {
                            // TA10/COR-05 (no-fallbacks): a present-but-malformed
                            // `localSheetId` is corruption, not "workbook-scoped".
                            // The old `if let Ok` silently left `local_sheet_id =
                            // None`, collapsing a SHEET-scoped defined name to
                            // WORKBOOK scope — a correctness bug (wrong scope),
                            // not a missing value. Absent attr keeps None (the
                            // branch only fires when the attr is present).
                            builder.local_sheet_id =
                                Some(super::parse_u32_attr(&val, "localSheetId", PART)?);
                        }
                    }
                    current_name = Some(builder);
                } else if tag == "workbookPr" {
                    // <workbookPr> can also appear as Start when it has
                    // child elements; handle the date1904 attr here too.
                    for attr in e.attributes().with_checks(false) {
                        let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
                            part: PART.to_string(),
                            message: format!("malformed <workbookPr> attribute: {err}"),
                        })?;
                        if attr.key.as_ref() == b"date1904" {
                            let v = attr.unescape_value().map_err(|err| {
                                XlsxError::MalformedOoxml {
                                    part: PART.to_string(),
                                    message: format!(
                                        "malformed <workbookPr> attribute value: {err}"
                                    ),
                                }
                            })?;
                            // TA10: loud boolean (see Empty-branch note above).
                            if super::parse_bool_attr(&v, "date1904", PART)? {
                                props.date_system = DateSystem::Excel1904;
                            }
                        }
                    }
                } else if tag == "sheet" {
                    // <sheet> with children (uncommon but possible).
                    if let Some(meta) = parse_sheet_attrs(&e, PART)? {
                        props.sheets.push(meta);
                    }
                }
            }
            Event::Text(t) => {
                if let Some(builder) = current_name.as_mut() {
                    // TA10: loud unescape (was `unwrap_or_default()`) — a malformed
                    // entity in defined-name formula text is corruption.
                    let txt = t.unescape().map_err(|e| XlsxError::MalformedOoxml {
                        part: PART.to_string(),
                        message: format!("malformed <definedName> formula text: {e}"),
                    })?;
                    builder.formula_text.push_str(&txt);
                }
            }
            Event::End(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                if tag == "definedName" {
                    if let Some(builder) = current_name.take() {
                        if !builder.name.is_empty() {
                            props.defined_names.push(builder.build());
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(props)
}

/// Helper: parse attributes of a `<sheet>` Element (Empty or Start).
fn parse_sheet_attrs<'a>(
    e: &quick_xml::events::BytesStart<'a>,
    part: &str,
) -> Result<Option<SheetMeta>, XlsxError> {
    let mut name = String::new();
    let mut sheet_id: u32 = 0;
    let mut r_id = String::new();
    let mut state = SheetState::Visible;
    for attr in e.attributes().with_checks(false) {
        // TA10: de-flatten + loud unescape (No-Fallbacks); sheetId routed
        // through the shared loud helper (was a bespoke message that dropped
        // the bad value).
        let attr = attr.map_err(|err| XlsxError::MalformedOoxml {
            part: part.to_string(),
            message: format!("malformed <sheet> attribute: {err}"),
        })?;
        let key = attr.key.as_ref();
        let val = attr.unescape_value().map_err(|err| XlsxError::MalformedOoxml {
            part: part.to_string(),
            message: format!("malformed <sheet> attribute value: {err}"),
        })?;
        if key == b"name" {
            name = val.to_string();
        } else if key == b"sheetId" {
            sheet_id = super::parse_u32_attr(&val, "sheetId", part)?;
        } else if key.ends_with(b":id") || key == b"r:id" {
            // Namespace prefix may be `r` or other depending on xmlns
            // declarations. We just check for the local-name `id`
            // following any namespace prefix.
            r_id = val.to_string();
        } else if key == b"state" {
            // TA10 (no-fallbacks): an *absent* `state` defaults to Visible
            // (set before the loop). A *present* value must be one of the
            // three OOXML sheet states — an unknown present value is
            // corruption, not silently "visible".
            state = match val.as_ref() {
                "visible" => SheetState::Visible,
                "hidden" => SheetState::Hidden,
                "veryHidden" => SheetState::VeryHidden,
                other => {
                    return Err(XlsxError::MalformedOoxml {
                        part: part.to_string(),
                        message: format!(
                            "<sheet> state attribute {other:?} is not a valid \
                             sheet state (expected visible/hidden/veryHidden)"
                        ),
                    });
                }
            };
        }
    }
    if name.is_empty() {
        return Err(XlsxError::MalformedOoxml {
            part: part.to_string(),
            message: "<sheet> element missing required name attribute".to_string(),
        });
    }
    // **W5-D-PM-2 (megaudit Opus-B HIGH-4 closure):** reject sheet
    // names containing control characters (NUL, BEL, etc.). Excel's
    // sheet-name rules forbid these; LibreOffice does too. Without
    // this check, hostile fixtures with `"Sheet\x00Foo"` import
    // cleanly, export via umya, then real Excel rejects with a
    // repair dialog when the user opens the output.
    if name
        .chars()
        .any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r')
    {
        return Err(XlsxError::MalformedOoxml {
            part: part.to_string(),
            message: "<sheet name=...> contains control character(s) — Excel rejects".to_string(),
        });
    }
    Ok(Some(SheetMeta {
        name,
        sheet_id,
        r_id,
        state,
    }))
}

#[derive(Default)]
struct DefinedNameBuilder {
    name: String,
    formula_text: String,
    local_sheet_id: Option<u32>,
}

impl DefinedNameBuilder {
    fn build(self) -> DefinedNameMeta {
        DefinedNameMeta {
            name: self.name,
            formula_text: self.formula_text,
            local_sheet_id: self.local_sheet_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkg_with(name: &str, content: &str) -> XlsxPackage {
        // Build a tiny in-memory zip with the given part. Used as a
        // fast unit-test fixture (no full xlsx required).
        use std::io::Write;
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
    fn parse_default_date_system_is_1900() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.date_system, DateSystem::Excel1900);
        assert_eq!(props.sheets.len(), 1);
        assert_eq!(props.sheets[0].name, "Sheet1");
        assert_eq!(props.sheets[0].sheet_id, 1);
    }

    #[test]
    fn parse_date1904_attribute_sets_1904_system() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <workbookPr date1904="1"/>
  <sheets>
    <sheet name="S" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.date_system, DateSystem::Excel1904);
    }

    #[test]
    fn parse_date1904_true_also_recognized() {
        // OOXML accepts both `1` and `true` for booleans.
        let xml = r#"<workbook><workbookPr date1904="true"/></workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.date_system, DateSystem::Excel1904);
    }

    #[test]
    fn ta10_malformed_date1904_errors() {
        // TA10: a present-but-invalid boolean is corruption — the old
        // `== "1" || eq_ignore..true` silently treated it as 1900.
        let xml = r#"<workbook><workbookPr date1904="banana"/></workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        match parse_workbook_xml(&pkg) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("date1904"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn ta10_date1904_false_keeps_1900() {
        // Regression guard: explicit false tokens → 1900 default, not error.
        for v in ["0", "false", "False"] {
            let xml = format!(r#"<workbook><workbookPr date1904="{v}"/></workbook>"#);
            let pkg = pkg_with("xl/workbook.xml", &xml);
            let props = parse_workbook_xml(&pkg).unwrap();
            assert_eq!(props.date_system, DateSystem::Excel1900, "v={v}");
        }
    }

    #[test]
    fn parse_sheet_state_attribute() {
        let xml = r#"<workbook>
  <sheets>
    <sheet name="Visible" sheetId="1" r:id="rId1"/>
    <sheet name="Hidden" sheetId="2" r:id="rId2" state="hidden"/>
    <sheet name="VeryHidden" sheetId="3" r:id="rId3" state="veryHidden"/>
  </sheets>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.sheets.len(), 3);
        assert_eq!(props.sheets[0].state, SheetState::Visible);
        assert_eq!(props.sheets[1].state, SheetState::Hidden);
        assert_eq!(props.sheets[2].state, SheetState::VeryHidden);
    }

    #[test]
    fn parse_scoped_defined_names() {
        // **Critical Phase 4.11 feature**: defined names with
        // localSheetId — calamine drops this. Verify the OOXML
        // scanner preserves scope.
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>
  <definedNames>
    <definedName name="WorkbookName">Sheet1!$A$1</definedName>
    <definedName name="LocalName" localSheetId="0">Sheet1!$B$1</definedName>
  </definedNames>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.defined_names.len(), 2);
        let workbook_name = &props.defined_names[0];
        assert_eq!(workbook_name.name, "WorkbookName");
        assert!(workbook_name.local_sheet_id.is_none());
        let local_name = &props.defined_names[1];
        assert_eq!(local_name.name, "LocalName");
        assert_eq!(local_name.local_sheet_id, Some(0));
        assert!(local_name.formula_text.contains("$B$1"));
    }

    #[test]
    fn ta10_malformed_local_sheet_id_errors() {
        // A present-but-malformed `localSheetId` is corruption. The old
        // `if let Ok` silently left `local_sheet_id = None`, collapsing a
        // SHEET-scoped name to WORKBOOK scope (a correctness bug). It must
        // now surface loudly.
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>
  <definedNames>
    <definedName name="Bad" localSheetId="not-a-number">Sheet1!$A$1</definedName>
  </definedNames>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        match parse_workbook_xml(&pkg) {
            Err(XlsxError::MalformedOoxml { part, message }) => {
                assert_eq!(part, "xl/workbook.xml");
                assert!(message.contains("localSheetId"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn ta10_absent_local_sheet_id_stays_workbook_scoped() {
        // Regression guard: an ABSENT localSheetId must remain None
        // (workbook scope), NOT error — only present-malformed fails.
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>
  <definedNames>
    <definedName name="Wb">Sheet1!$A$1</definedName>
  </definedNames>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.defined_names.len(), 1);
        assert!(props.defined_names[0].local_sheet_id.is_none());
    }

    #[test]
    fn ta10_malformed_sheet_state_errors() {
        // An unknown PRESENT `state` is corruption, not silently "visible".
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1" state="bogus"/></sheets>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        match parse_workbook_xml(&pkg) {
            Err(XlsxError::MalformedOoxml { part, message }) => {
                assert_eq!(part, "xl/workbook.xml");
                assert!(message.contains("state"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn ta10_explicit_visible_state_is_accepted() {
        // Regression guard: an explicit `state="visible"` is valid (the
        // new explicit arm), not an error.
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1" state="visible"/></sheets>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.sheets.len(), 1);
        assert_eq!(props.sheets[0].state, SheetState::Visible);
    }

    #[test]
    fn ta10_state_is_case_sensitive_per_spec() {
        // ST_SheetState (ECMA-376 §18.18.68) is a closed, case-sensitive set.
        // `state="Hidden"` (capital H) is NOT valid → corruption, surfaced
        // loudly (the old `_ => Visible` silently mislabeled it visible).
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1" state="Hidden"/></sheets>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        match parse_workbook_xml(&pkg) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("state"), "got: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn ta10_local_sheet_id_large_valid_is_accepted() {
        // Boundary guard: a large valid u32 localSheetId parses (only
        // genuinely non-numeric values fail).
        let xml = r#"<workbook>
  <sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>
  <definedNames>
    <definedName name="Big" localSheetId="4294967294">Sheet1!$A$1</definedName>
  </definedNames>
</workbook>"#;
        let pkg = pkg_with("xl/workbook.xml", xml);
        let props = parse_workbook_xml(&pkg).unwrap();
        assert_eq!(props.defined_names[0].local_sheet_id, Some(4_294_967_294));
    }

    #[test]
    fn missing_workbook_xml_is_malformed_error() {
        // Package without xl/workbook.xml — every OOXML spreadsheet
        // MUST have this part. Surface the corruption loudly.
        let pkg = pkg_with("xl/styles.xml", "<styles/>");
        let result = parse_workbook_xml(&pkg);
        match result {
            Err(XlsxError::MalformedOoxml { part, .. }) => {
                assert_eq!(part, "xl/workbook.xml");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }
}
