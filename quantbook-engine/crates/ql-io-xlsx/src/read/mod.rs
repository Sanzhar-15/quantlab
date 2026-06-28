//! Hybrid xlsx reader: calamine grid + targeted OOXML scanner.
//!
//! **W5-D-14a:** calamine grid path live.
//! **W5-D-14b (this commit):** OOXML scanner foundation — package
//! index + `xl/workbook.xml` parser (date1904 + sheet metadata +
//! scoped defined names) + feature-inventory detection.

pub(crate) mod calamine_grid;
pub(crate) mod cell_styles_xml;
pub(crate) mod convert;
pub(crate) mod feature_inventory;
pub(crate) mod limits;
pub(crate) mod names_import;
pub(crate) mod package;
pub(crate) mod rels;
pub(crate) mod sheet_parts;
pub(crate) mod styles_import;
pub(crate) mod styles_xml;
pub(crate) mod tables_import;
pub(crate) mod tables_xml;
pub(crate) mod workbook_xml;

use crate::error::XlsxError;

/// Parse a **present** numeric OOXML attribute loudly.
///
/// **No-fallbacks (COR-05 / TA10):** distinguishes an *absent* attribute
/// (the caller's concern — it initialises the field to the OOXML default
/// before the attribute loop and only calls this inside the branch that
/// fires when the attribute is actually present) from a *present-but-
/// unparseable* one, which is corruption and must surface as
/// [`XlsxError::MalformedOoxml`]. The pre-COR-05 `.parse().unwrap_or(..)`
/// / `.parse().ok()` / `if let Ok(..)` idioms aliased malformed input onto
/// the absent-attribute default, silently corrupting scope / style /
/// number-format — e.g. a malformed `localSheetId` collapsed a
/// sheet-scoped defined name to *workbook* scope (wrong scope, not a
/// missing value).
///
/// Shared by `tables_xml`, `workbook_xml`, `styles_xml`, and
/// `cell_styles_xml` so every reader rejects present-garbage identically.
pub(crate) fn parse_u32_attr(val: &str, attr: &str, part_path: &str) -> Result<u32, XlsxError> {
    val.parse::<u32>().map_err(|e| XlsxError::MalformedOoxml {
        part: part_path.to_string(),
        message: format!("attribute {attr} is not a valid u32: {val:?} ({e})"),
    })
}

/// Parse a **present** OOXML boolean attribute loudly.
///
/// **No-fallbacks (TA10):** `ST_Boolean` accepts exactly `1` / `0` / `true` /
/// `false`. The old `val == "1" || val.eq_ignore_ascii_case("true")` idiom
/// silently treated every OTHER present value (`"banana"`, a typo, a truncated
/// token) as `false` — a `value || default` mask that hides corruption. A
/// present value outside the set is now a hard error; the caller supplies the
/// *absent*-attribute default itself (this is only called when the attr is
/// present). Case-insensitive on `true`/`false` to tolerate `True`/`FALSE`
/// from non-canonical producers, matching the prior lenient accept-set.
pub(crate) fn parse_bool_attr(val: &str, attr: &str, part_path: &str) -> Result<bool, XlsxError> {
    match val {
        "1" => Ok(true),
        "0" => Ok(false),
        v if v.eq_ignore_ascii_case("true") => Ok(true),
        v if v.eq_ignore_ascii_case("false") => Ok(false),
        _ => Err(XlsxError::MalformedOoxml {
            part: part_path.to_string(),
            message: format!(
                "attribute {attr} is not a valid boolean (expected 0/1/true/false): {val:?}"
            ),
        }),
    }
}
