//! Register parsed OOXML `<numFmt>` entries with the workbook's
//! `FormatTable`.
//!
//! **W5-D-14d scope**: format-code registration only. Per-cell
//! application (reading worksheet `<c r="A1" s="N">` and applying
//! the format from `cellXfs[N].num_fmt_id`) requires worksheet XML
//! parsing the engine doesn't yet do; deferred to a follow-up.
//!
//! The benefit of registering now (without per-cell application) is
//! that the workbook's `FormatTable` correctly carries the user's
//! custom format strings, so when per-cell wiring lands it can just
//! `FormatId(N)` directly without re-allocating ids.

use crate::error::XlsxError;
use crate::read::styles_xml::StyleIndex;
use ql_storage::{FormatId, Workbook};

/// Register every custom `numFmtId` (≥ 164) from the parsed
/// `StyleIndex` with the workbook's `FormatTable`. Reserved ids
/// (0-163) are Excel built-ins handled by the `FormatTable` defaults
/// — skipped here.
///
/// **Replay determinism**: uses `FormatTable::register_at` (not
/// `intern`) so the imported id matches the OOXML id exactly. This
/// is critical for round-trip — exporting back to xlsx writes the
/// same numFmtId attribute we read.
///
/// Returns the count of custom formats registered.
///
/// # Errors
///
/// - `XlsxError::MalformedOoxml` if a registration collides with an
///   existing entry under a different string — that indicates the
///   xlsx has two `<numFmt>` entries claiming the same id with
///   different format codes, which is malformed per OOXML spec.
pub(crate) fn register_custom_formats(
    workbook: &mut Workbook,
    style_index: &StyleIndex,
) -> Result<u64, XlsxError> {
    let mut count: u64 = 0;
    for entry in &style_index.num_fmts {
        // Reserved 0-163 are Excel built-ins — skip; the FormatTable
        // already has them.
        if entry.num_fmt_id < ql_storage::FIRST_CUSTOM_FORMAT_ID {
            continue;
        }
        let id = FormatId(entry.num_fmt_id);
        workbook
            .formats_mut()
            .register_at(id, &entry.format_code)
            .map_err(|e| XlsxError::MalformedOoxml {
                part: "xl/styles.xml".to_string(),
                message: format!(
                    "numFmt registration failed for id {}: {:?}",
                    entry.num_fmt_id, e
                ),
            })?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::styles_xml::NumFmtEntry;

    #[test]
    fn register_custom_skips_builtins_below_164() {
        let mut wb = Workbook::new();
        let baseline = wb.formats().len();
        let idx = StyleIndex {
            num_fmts: vec![
                NumFmtEntry {
                    num_fmt_id: 0,
                    format_code: "General".to_string(),
                },
                NumFmtEntry {
                    num_fmt_id: 14,
                    format_code: "m/d/yyyy".to_string(),
                },
            ],
            cell_xfs: vec![],
        };
        let n = register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(n, 0, "built-ins must not be re-registered");
        // FormatTable size unchanged.
        assert_eq!(wb.formats().len(), baseline);
    }

    #[test]
    fn register_custom_registers_id_164_and_above() {
        let mut wb = Workbook::new();
        let baseline = wb.formats().len();
        let idx = StyleIndex {
            num_fmts: vec![
                NumFmtEntry {
                    num_fmt_id: 164,
                    format_code: "yyyy-mm-dd".to_string(),
                },
                NumFmtEntry {
                    num_fmt_id: 165,
                    // A format code unique to this workbook (not a
                    // built-in re-definition).
                    format_code: "yyyy-mm-dd hh:mm:ss".to_string(),
                },
            ],
            cell_xfs: vec![],
        };
        let n = register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(n, 2);
        assert_eq!(wb.formats().len(), baseline + 2);
        // Lookup by id should hit.
        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
        assert_eq!(
            wb.formats().lookup(FormatId(165)),
            Some("yyyy-mm-dd hh:mm:ss")
        );
    }

    #[test]
    fn collision_with_existing_format_id_is_malformed_error() {
        // Register id 164 with one string, then try to register the
        // same id with a different string. The second call must
        // fail with MalformedOoxml.
        let mut wb = Workbook::new();
        wb.formats_mut()
            .register_at(FormatId(164), "yyyy-mm-dd")
            .unwrap();
        let idx = StyleIndex {
            num_fmts: vec![NumFmtEntry {
                num_fmt_id: 164,
                format_code: "DIFFERENT".to_string(),
            }],
            cell_xfs: vec![],
        };
        match register_custom_formats(&mut wb, &idx) {
            Err(XlsxError::MalformedOoxml { part, .. }) => {
                assert_eq!(part, "xl/styles.xml");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn re_registering_same_id_with_same_string_is_idempotent() {
        // Sanity: registering id 164 with "yyyy-mm-dd" twice is a
        // no-op (the register_at impl handles this).
        let mut wb = Workbook::new();
        let idx = StyleIndex {
            num_fmts: vec![NumFmtEntry {
                num_fmt_id: 164,
                format_code: "yyyy-mm-dd".to_string(),
            }],
            cell_xfs: vec![],
        };
        register_custom_formats(&mut wb, &idx).unwrap();
        // Second call: same id, same string → should succeed.
        register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
    }
}
