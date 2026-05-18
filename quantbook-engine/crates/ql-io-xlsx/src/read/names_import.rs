//! **W5-D-14.2 (HIGH-4 closure — import side):** wire OOXML
//! `<definedNames>` into Quantbook's `NameTable` + sheet-scoped names.
//!
//! Parse minimal address-target subset (`Sheet!$A$1`, `Sheet!$A$1:$B$2`)
//! plus simple literal constants (numbers, booleans, double-quoted
//! strings). More complex targets (formulas, table references) are
//! deferred to a later sub-batch — they round-trip via
//! `NamedTarget::Formula` only after the bind-aware parser lands.

use crate::error::XlsxError;
use crate::read::workbook_xml::WorkbookProperties;
use ql_storage::{NamedTarget, Workbook};
use ql_types::{Address, ColId, Range, RowId, SheetId, Value};

/// Walk `workbook_props.defined_names` and register each name with
/// the appropriate scope on the workbook. Returns the number of
/// names registered (used in the import report).
///
/// Permissive: any name we can't parse is silently skipped (logged
/// via `report.warnings` callers when wired in). Reserved-name
/// rejections from the engine's `NameTableError::Reserved` are also
/// skipped — they represent user-content that conflicts with our
/// engine sentinels.
pub(crate) fn register_defined_names(
    workbook: &mut Workbook,
    workbook_props: &WorkbookProperties,
) -> Result<usize, XlsxError> {
    let mut registered: usize = 0;

    // Sheet-name → SheetId lookup. workbook_props.sheets is in
    // workbook order; the `local_sheet_id` attribute is also the
    // workbook-order index, so we can use index directly for
    // sheet-scoped names and reverse-lookup by name for workbook-
    // scoped names whose target carries an explicit sheet ref.
    let sheet_lookup: std::collections::HashMap<String, SheetId> = workbook_props
        .sheets
        .iter()
        .enumerate()
        .map(|(i, s)| (s.name.clone(), i as SheetId))
        .collect();

    for name in &workbook_props.defined_names {
        let target = match parse_name_target(&name.formula_text, &sheet_lookup) {
            Some(t) => t,
            None => {
                // Fallback: store the raw formula text. The binder
                // re-parses at use site (Phase 3+ formula-semantics).
                NamedTarget::Formula(std::sync::Arc::from(name.formula_text.as_str()))
            }
        };

        match name.local_sheet_id {
            None => {
                if workbook.set_name(&name.name, target).is_ok() {
                    registered += 1;
                }
            }
            Some(sid) => {
                if let Some(sheet) = workbook.sheet_mut(sid as SheetId) {
                    if sheet.set_scoped_name(&name.name, target).is_ok() {
                        registered += 1;
                    }
                }
            }
        }
    }

    Ok(registered)
}

/// Parse a defined-name target formula text into a `NamedTarget`.
/// Supports the subset Quantbook can represent natively:
/// - `Sheet1!$A$1` → `Cell`
/// - `Sheet1!$A$1:$B$2` → `Range`
/// - bare numeric / boolean / `"text"` → `Constant`
///
/// Returns `None` if the text doesn't match any of these patterns —
/// the caller falls back to `NamedTarget::Formula(raw_text)`.
fn parse_name_target(
    text: &str,
    sheet_lookup: &std::collections::HashMap<String, SheetId>,
) -> Option<NamedTarget> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Constants: TRUE / FALSE, numeric literal, quoted string.
    if trimmed.eq_ignore_ascii_case("TRUE") {
        return Some(NamedTarget::Constant(Value::Boolean(true)));
    }
    if trimmed.eq_ignore_ascii_case("FALSE") {
        return Some(NamedTarget::Constant(Value::Boolean(false)));
    }
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        // Strip outer quotes; unescape `""` → `"`.
        let inner = &trimmed[1..trimmed.len() - 1];
        let unescaped = inner.replace("\"\"", "\"");
        return Some(NamedTarget::Constant(Value::text(unescaped.as_str())));
    }
    if let Ok(n) = trimmed.parse::<f64>() {
        return Some(NamedTarget::Constant(Value::Number(n)));
    }

    // Address target: split off sheet name at the rightmost `!` that
    // isn't inside quotes. We anchor on the simplest case first.
    let (sheet_part, rest) = split_sheet_ref(trimmed)?;
    let sheet_id = *sheet_lookup.get(sheet_part)?;

    // Single cell vs range.
    if let Some((lhs, rhs)) = rest.split_once(':') {
        let (lr, lc) = parse_abs_cell(lhs)?;
        let (rr, rc) = parse_abs_cell(rhs)?;
        Some(NamedTarget::Range(Range::new(sheet_id, lr, lc, rr, rc)))
    } else {
        let (r, c) = parse_abs_cell(rest)?;
        Some(NamedTarget::Cell(Address::new(sheet_id, r, c)))
    }
}

/// Split `Sheet!$A$1` (or `'Sheet 1'!$A$1`) into `("Sheet", "$A$1")`.
fn split_sheet_ref(text: &str) -> Option<(&str, &str)> {
    // Quoted sheet name path.
    if let Some(after_open) = text.strip_prefix('\'') {
        // For now, support unescaped names only — `''`-escaped single
        // quotes in sheet names is a follow-up edge case (real-world
        // incidence is near zero).
        let end_quote = after_open.find('\'')?;
        let sheet_name = &after_open[..end_quote];
        let after = &after_open[end_quote + 1..];
        let rest = after.strip_prefix('!')?;
        return Some((sheet_name, rest));
    }
    // Unquoted: split at first `!`.
    let bang = text.find('!')?;
    let sheet_name = &text[..bang];
    let rest = &text[bang + 1..];
    Some((sheet_name, rest))
}

/// Parse `$A$1` → `(row=0, col=0)`. Accepts mixed-mode (`A$1`,
/// `$A1`, `A1`) too — defined-names normally use absolute refs but
/// we don't reject relative.
fn parse_abs_cell(text: &str) -> Option<(RowId, ColId)> {
    let stripped: String = text.chars().filter(|c| *c != '$').collect();
    // Split at the first digit.
    let split_idx = stripped.find(|c: char| c.is_ascii_digit())?;
    let col_letters = &stripped[..split_idx];
    let row_digits = &stripped[split_idx..];

    let mut col: u32 = 0;
    for c in col_letters.chars() {
        if !c.is_ascii_alphabetic() {
            return None;
        }
        col = col * 26 + (c.to_ascii_uppercase() as u32 - b'A' as u32 + 1);
    }
    if col == 0 {
        return None;
    }
    let col = col - 1;
    let row: u32 = row_digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup_single(name: &str) -> HashMap<String, SheetId> {
        let mut m = HashMap::new();
        m.insert(name.to_string(), 0);
        m
    }

    #[test]
    fn parse_cell_target() {
        let l = lookup_single("Sheet1");
        match parse_name_target("Sheet1!$A$1", &l).unwrap() {
            NamedTarget::Cell(a) => {
                assert_eq!(a.sheet, 0);
                assert_eq!(a.row, 0);
                assert_eq!(a.col, 0);
            }
            other => panic!("expected Cell, got {other:?}"),
        }
    }

    #[test]
    fn parse_range_target() {
        let l = lookup_single("Sheet1");
        match parse_name_target("Sheet1!$A$1:$B$10", &l).unwrap() {
            NamedTarget::Range(r) => {
                assert_eq!(r.sheet, 0);
                assert_eq!(r.start_row, 0);
                assert_eq!(r.start_col, 0);
                assert_eq!(r.end_row, 9);
                assert_eq!(r.end_col, 1);
            }
            other => panic!("expected Range, got {other:?}"),
        }
    }

    #[test]
    fn parse_quoted_sheet_target() {
        let mut l = HashMap::new();
        l.insert("My Sheet".to_string(), 3);
        match parse_name_target("'My Sheet'!$C$5", &l).unwrap() {
            NamedTarget::Cell(a) => {
                assert_eq!(a.sheet, 3);
                assert_eq!(a.row, 4);
                assert_eq!(a.col, 2);
            }
            other => panic!("expected Cell, got {other:?}"),
        }
    }

    #[test]
    fn parse_numeric_constant() {
        let l = HashMap::new();
        match parse_name_target("42.5", &l).unwrap() {
            NamedTarget::Constant(Value::Number(n)) => assert!((n - 42.5).abs() < 1e-9),
            other => panic!("expected Constant(Number), got {other:?}"),
        }
    }

    #[test]
    fn parse_boolean_constants() {
        let l = HashMap::new();
        assert!(matches!(
            parse_name_target("TRUE", &l),
            Some(NamedTarget::Constant(Value::Boolean(true)))
        ));
        assert!(matches!(
            parse_name_target("false", &l),
            Some(NamedTarget::Constant(Value::Boolean(false)))
        ));
    }

    #[test]
    fn parse_quoted_string_constant() {
        let l = HashMap::new();
        match parse_name_target(r#""hello world""#, &l).unwrap() {
            NamedTarget::Constant(Value::Text(t)) => assert_eq!(t.as_ref(), "hello world"),
            other => panic!("expected Constant(Text), got {other:?}"),
        }
    }

    #[test]
    fn parse_unknown_sheet_returns_none() {
        let l = lookup_single("Sheet1");
        // Target sheet not in workbook — falls back to formula path
        // in caller.
        assert!(parse_name_target("Unknown!$A$1", &l).is_none());
    }
}
