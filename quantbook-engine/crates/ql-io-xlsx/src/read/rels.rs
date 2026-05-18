//! Parse OOXML `.rels` files.
//!
//! Each xlsx package has multiple rels files:
//! - `_rels/.rels` — package-root relationships (points at
//!   `xl/workbook.xml`).
//! - `xl/_rels/workbook.xml.rels` — workbook → sheets, styles,
//!   shared strings, theme.
//! - `xl/worksheets/_rels/sheet{n}.xml.rels` — sheet → tables,
//!   comments, drawings, hyperlinks.
//!
//! Each file has the same shape:
//! ```xml
//! <Relationships xmlns="...">
//!   <Relationship Id="rId1" Type="..." Target="..."/>
//!   <Relationship Id="rId2" Type="..." Target="..."/>
//! </Relationships>
//! ```
//!
//! **W5-D-14c**: parsed for table → sheet ownership resolution. The
//! workbook-rels parser arrives later (for shared strings / styles
//! path resolution; calamine handles those today).

use crate::error::XlsxError;
use crate::read::package::XlsxPackage;
use quick_xml::events::Event;
use quick_xml::Reader;

/// One `<Relationship>` element parsed from a `.rels` file.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct Relationship {
    /// `Id` attribute — used to look up the relationship by name from
    /// the consuming XML part (e.g. `<tablePart r:id="rId3"/>`).
    pub id: String,
    /// `Type` attribute — schema URI, e.g.
    /// `http://schemas.openxmlformats.org/officeDocument/2006/relationships/table`.
    pub rel_type: String,
    /// `Target` attribute — relative path to the target part. Often
    /// uses `..` to refer outside the part's directory (e.g.
    /// `../tables/table1.xml` from a sheet rels file).
    pub target: String,
}

impl Relationship {
    /// `true` if this relationship points at a table part.
    pub fn is_table(&self) -> bool {
        self.rel_type.ends_with("/table")
    }
}

/// Parse a `.rels` file's content.
///
/// Returns the relationships in document order. The caller picks the
/// ones they care about by `Type`.
pub(crate) fn parse_relationships(
    content: &str,
    part_path: &str,
) -> Result<Vec<Relationship>, XlsxError> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut out = Vec::new();
    let mut buf = Vec::new();

    loop {
        let evt = reader
            .read_event_into(&mut buf)
            .map_err(|e| XlsxError::XmlParse {
                part: part_path.to_string(),
                source: e,
            })?;
        match evt {
            Event::Empty(e) | Event::Start(e) => {
                let local_name = e.local_name();
                let tag = std::str::from_utf8(local_name.as_ref()).unwrap_or("");
                if tag == "Relationship" {
                    let mut id = String::new();
                    let mut rel_type = String::new();
                    let mut target = String::new();
                    for attr in e.attributes().with_checks(false).flatten() {
                        let key = attr.key.as_ref();
                        if key == b"Id" {
                            id = attr.unescape_value().unwrap_or_default().to_string();
                        } else if key == b"Type" {
                            rel_type = attr.unescape_value().unwrap_or_default().to_string();
                        } else if key == b"Target" {
                            target = attr.unescape_value().unwrap_or_default().to_string();
                        }
                    }
                    if !id.is_empty() {
                        out.push(Relationship {
                            id,
                            rel_type,
                            target,
                        });
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// Read + parse a `.rels` file by part path. Returns `Ok(vec![])` if
/// the file doesn't exist (many sheets have no rels — no tables, no
/// comments, no drawings).
pub(crate) fn read_relationships(
    package: &XlsxPackage,
    rels_path: &str,
) -> Result<Vec<Relationship>, XlsxError> {
    match package.read_part_string(rels_path)? {
        Some(content) => parse_relationships(&content, rels_path),
        None => Ok(Vec::new()),
    }
}

/// Resolve a relative target path (often `../tables/table1.xml`)
/// against the directory of the rels file. Returns the absolute
/// in-package path (always forward-slash separated, no leading `/`).
///
/// Example: rels_path `xl/worksheets/_rels/sheet1.xml.rels`,
/// target `../tables/table1.xml` → `xl/tables/table1.xml`.
pub(crate) fn resolve_rel_target(rels_path: &str, target: &str) -> String {
    // Absolute target (leading `/`) — package-rooted; ignore the rels
    // file's base entirely.
    if let Some(rest) = target.strip_prefix('/') {
        return rest.to_string();
    }

    // Relative: walk from the directory containing the part this
    // rels file describes. `xl/worksheets/_rels/sheet1.xml.rels`
    // describes `xl/worksheets/sheet1.xml`, whose parent dir is
    // `xl/worksheets/`. Strip the trailing filename and the
    // `_rels/` segment.
    let mut base = match rels_path.rfind('/') {
        Some(i) => rels_path[..i].to_string(),
        None => String::new(),
    };
    if base.ends_with("/_rels") {
        base.truncate(base.len() - 6);
    } else if base == "_rels" {
        base.clear();
    }

    // **W5-D-PM-2 (megaudit Opus-B HIGH-3 closure — SECURITY):**
    // reject `..` walks that escape the package root. A hostile xlsx
    // with `<Relationship Target="../../../etc/passwd"/>` would
    // otherwise produce a path that escapes the zip-package
    // boundary. The resolved path is downstream used in zip-entry
    // comparisons + error messages; opens path-confusion-style
    // attacks if any caller ever writes to disk using these paths.
    let mut segments: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    for part in target.split('/') {
        if part == ".." {
            if segments.pop().is_none() {
                // `..` walked past the package root. Return a
                // sentinel empty path so the caller's zip lookup
                // fails (no entry at "" exists) and the downstream
                // surface produces a typed error.
                return String::new();
            }
        } else if part != "." && !part.is_empty() {
            segments.push(part);
        }
    }
    segments.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_relationship_basic() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>
</Relationships>"#;
        let rels = parse_relationships(xml, "xl/worksheets/_rels/sheet1.xml.rels").unwrap();
        assert_eq!(rels.len(), 2);
        assert_eq!(rels[0].id, "rId1");
        assert!(rels[0].is_table());
        assert_eq!(rels[0].target, "../tables/table1.xml");
        assert!(!rels[1].is_table());
    }

    #[test]
    fn resolve_target_resolves_dotdot_paths() {
        // Sheet rels → table — most common case.
        assert_eq!(
            resolve_rel_target(
                "xl/worksheets/_rels/sheet1.xml.rels",
                "../tables/table1.xml"
            ),
            "xl/tables/table1.xml"
        );
        // Sheet rels → comments at sibling level.
        assert_eq!(
            resolve_rel_target("xl/worksheets/_rels/sheet1.xml.rels", "../comments1.xml"),
            "xl/comments1.xml"
        );
        // Absolute target (leading `/`).
        assert_eq!(
            resolve_rel_target("xl/worksheets/_rels/sheet1.xml.rels", "/xl/tables/t.xml"),
            "xl/tables/t.xml"
        );
        // No `..` — relative-to-base.
        assert_eq!(
            resolve_rel_target("xl/_rels/workbook.xml.rels", "worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml"
        );
    }

    #[test]
    fn empty_relationships_returns_empty() {
        let rels = parse_relationships(
            r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#,
            "xl/_rels/workbook.xml.rels",
        )
        .unwrap();
        assert!(rels.is_empty());
    }
}
