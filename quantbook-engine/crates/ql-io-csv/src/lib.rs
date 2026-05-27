//! `ql-io-csv` — pure-I/O CSV import/export for the engine (Phase 6.1B inc.2c-11).
//!
//! Mirrors `ql-io-xlsx`'s pure-I/O layering: this crate parses/serialises CSV
//! to/from a [`ql_storage::Workbook`] and does **not** depend on the compute
//! engine (`ql-exec`). CSV has no formulas — every cell is a literal value — so,
//! unlike xlsx import, there is no formula-recompute phase and no
//! `XlsxRecomputer`-style injection; this crate is a true leaf. The owning
//! `WorkbookSession::import("csv")` adopts the returned workbook (Option-1) with
//! a fresh op-log/undo history.
//!
//! ## v1 semantics (deliberate, documented)
//! - **Single sheet.** CSV is inherently flat: [`import_csv_bytes`] produces one
//!   sheet (`"Sheet1"`); [`export_csv_bytes`] serialises exactly one
//!   caller-chosen sheet. The owning session enforces "single live sheet" for
//!   export (it refuses a multi-sheet workbook loudly rather than dropping
//!   sheets silently).
//! - **No header row.** Row 0 is data like every other row — Excel does not drop
//!   the first CSV row on import.
//! - **Import never interprets a field as a formula** (this crate has no
//!   evaluator): a field that does not parse as a finite number is imported as
//!   text, so a leading `=` always stays text (`=1+1` → text `"=1+1"`) — no
//!   CSV-formula-injection on the import side. (A leading `+`/`-` becomes a
//!   *number* when the field is numeric, e.g. `-3.5`, and text otherwise.)
//! - **Type inference** (per field): empty → blank (omitted, sheet stays sparse);
//!   `TRUE`/`FALSE` (any case) → boolean; a finite `f64` → number (non-finite
//!   `inf`/`nan` stays text); everything else → text. No date/currency inference
//!   in v1 (a formatting minefield; deferred). Numeric inference is Excel-like
//!   and therefore lossy for number-shaped identifiers (`00123` → `123`,
//!   `+44` → `44`); this is intentional and matches Excel's CSV import.
//! - **Export is verbatim/value-only.** Cells are rendered faithfully (see
//!   below); export does NOT prefix-escape formula-trigger text (`=…`), because
//!   silently mutating the user's data would break round-trip fidelity and hide
//!   data (No-Fallbacks). CSV-injection mitigation for a consuming spreadsheet
//!   app is that app's import responsibility (matches Excel/Sheets export); an
//!   opt-in sanitising export mode is a documented future extension.
//! - **Export uses the sheet's conservative used-range** (`Sheet::bounds`), the
//!   same rectangle the xlsx exporter and `.qbook` saver use. ⚠️ Because
//!   `Sheet::put` grows `bounds` even on a `Blank` write, a workbook that has
//!   had a far cell *cleared* can carry an inflated used-range — a cross-cutting
//!   property of every serializer, tracked for a uniform storage-level
//!   effective-extent fix (a freshly *imported* CSV is unaffected: blank fields
//!   are skipped, so its bounds track real data).
//! - **UTF-8 only.** A non-UTF-8 byte stream fails loud as [`CsvError::Parse`]
//!   (the `csv` crate surfaces invalid UTF-8 as a parse error) — never a lossy
//!   substitution (No-Fallbacks).
//! - **Engine limits.** A CSV exceeding [`MAX_ROW`]/[`MAX_COLUMN`] fails loud as
//!   [`CsvError::ExceedsSheetLimits`] rather than panicking the storage layer
//!   (`Workbook::put_at` asserts on out-of-range addresses).
//! - **Value rendering on export** reuses [`ql_types::Value`]'s `Display`
//!   (Blank → `""`, Number → shortest round-trip, Boolean → `TRUE`/`FALSE`, Text
//!   → verbatim, Error → sigil). Number formats / styles are NOT applied — CSV is
//!   value-only in v1.

use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use thiserror::Error;

/// CSV import/export failure. `#[non_exhaustive]` — downstream `match`es must
/// carry a wildcard arm (the owning session maps that to a loud
/// `unmapped_csv_error`, never a silent default).
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CsvError {
    /// Underlying I/O failure (writer flush, etc.).
    #[error("csv I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// CSV framing / parse failure, including invalid UTF-8 (the `csv` crate
    /// surfaces a non-UTF-8 field as a parse error of kind `Utf8`).
    #[error("csv parse error: {0}")]
    Parse(#[from] csv::Error),
    /// The CSV is larger than the engine's addressable sheet
    /// ([`MAX_ROW`] + 1 rows or [`MAX_COLUMN`] + 1 columns). Fails loud here so
    /// the storage layer's `put_at` assertion is never reached.
    #[error("csv exceeds engine sheet limits: {what} index {index} exceeds max {max}")]
    ExceedsSheetLimits {
        /// `"row"` or `"column"`.
        what: &'static str,
        /// The 0-based index that overflowed.
        index: u64,
        /// The inclusive maximum.
        max: u64,
    },
    /// Export was asked for a sheet id that does not exist in the workbook.
    #[error("csv export: sheet {0} does not exist in the workbook")]
    SheetNotFound(SheetId),
}

/// Options for [`import_csv_bytes`].
#[derive(Clone, Copy, Debug)]
pub struct CsvImportOptions {
    /// Field delimiter (default `b','`).
    pub delimiter: u8,
}

impl Default for CsvImportOptions {
    fn default() -> Self {
        Self { delimiter: b',' }
    }
}

/// Options for [`export_csv_bytes`].
#[derive(Clone, Copy, Debug)]
pub struct CsvExportOptions {
    /// Field delimiter (default `b','`).
    pub delimiter: u8,
}

impl Default for CsvExportOptions {
    fn default() -> Self {
        Self { delimiter: b',' }
    }
}

/// What [`import_csv_bytes`] loaded (parallels `ql_io_xlsx::XlsxImportResult`).
#[derive(Debug)]
pub struct CsvImportResult {
    /// The reconstructed single-sheet workbook.
    pub workbook: Workbook,
    /// Load summary (counts; CSV has no fidelity-loss channel to report).
    pub report: CsvImportReport,
}

/// Summary counts for a CSV import.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CsvImportReport {
    /// Number of records (rows) read from the CSV.
    pub rows: usize,
    /// Number of non-blank cells written into the workbook.
    pub cells_loaded: usize,
}

/// Infer a [`Value`] from one raw CSV field. See the module-level "type
/// inference" note for the rules. A leading `=`/`+`/`-`/`@` does NOT make a
/// field a formula (this crate has no evaluator); such fields stay text unless
/// they parse as a finite number (e.g. `-3.5`).
fn infer_value(field: &str) -> Value {
    if field.is_empty() {
        return Value::Blank;
    }
    // Booleans: Excel's canonical TRUE/FALSE, case-insensitive. Only the exact
    // tokens — never "yes"/"no"/"1"/"0".
    if field.eq_ignore_ascii_case("TRUE") {
        return Value::Boolean(true);
    }
    if field.eq_ignore_ascii_case("FALSE") {
        return Value::Boolean(false);
    }
    // Numbers: a finite f64. `f64::from_str` also accepts "inf"/"nan"
    // (case-insensitive); the `is_finite` guard keeps those as text so a CSV
    // cell literally reading "inf" round-trips as text, not a sanitised error.
    if let Ok(n) = field.parse::<f64>() {
        if n.is_finite() {
            return Value::Number(n);
        }
    }
    Value::text(field)
}

/// Import a CSV byte buffer into a fresh single-sheet [`Workbook`].
///
/// The buffer must be UTF-8; a non-UTF-8 field fails loud as
/// [`CsvError::Parse`]. A leading UTF-8 BOM (`EF BB BF`, which Excel emits on
/// "CSV UTF-8" export) is stripped so it does not contaminate cell `(0, 0)` —
/// the `csv` crate does not strip it. Records are ragged-tolerant (`flexible`);
/// row 0 is data (no header handling). See the module docs for type-inference
/// rules and the injection-safety stance on leading `=`.
pub fn import_csv_bytes(
    bytes: &[u8],
    options: CsvImportOptions,
) -> Result<CsvImportResult, CsvError> {
    // Strip a leading UTF-8 BOM if present (the `csv` crate keeps it, which would
    // otherwise prepend U+FEFF to the first field — corrupting an Excel-exported
    // "CSV UTF-8" file's top-left cell).
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(options.delimiter)
        .from_reader(bytes);

    let mut wb = Workbook::new();
    let sheet: SheetId = wb.add_sheet("Sheet1");
    let mut rows = 0usize;
    let mut cells_loaded = 0usize;

    for (row_idx, record) in rdr.records().enumerate() {
        let record = record?;
        // Guard the engine row limit BEFORE any `put_at` (which would assert).
        if row_idx as u64 > MAX_ROW as u64 {
            return Err(CsvError::ExceedsSheetLimits {
                what: "row",
                index: row_idx as u64,
                max: MAX_ROW as u64,
            });
        }
        rows += 1;
        let row = row_idx as RowId;
        for (col_idx, field) in record.iter().enumerate() {
            if col_idx as u64 > MAX_COLUMN as u64 {
                return Err(CsvError::ExceedsSheetLimits {
                    what: "column",
                    index: col_idx as u64,
                    max: MAX_COLUMN as u64,
                });
            }
            let value = infer_value(field);
            // Keep the sheet sparse: a blank field writes nothing.
            if matches!(value, Value::Blank) {
                continue;
            }
            wb.put_at(sheet, row, col_idx as ColId, value);
            cells_loaded += 1;
        }
    }

    Ok(CsvImportResult {
        workbook: wb,
        report: CsvImportReport { rows, cells_loaded },
    })
}

/// Serialise one sheet of `workbook` to CSV bytes.
///
/// Emits the sheet's used-range rectangle (`0..row_extent` × `0..col_extent`
/// from [`ql_storage::Sheet::bounds`]); trailing blank cells within the
/// rectangle render as empty fields. Each cell is rendered **verbatim** via
/// [`ql_types::Value`]'s `Display` (no formula-trigger escaping — see the module
/// docs); the `csv` writer applies RFC 4180 quoting. An empty sheet produces
/// empty output.
///
/// ⚠️ The used-range is conservative (`Sheet::put` grows it even on a `Blank`
/// write), matching the xlsx exporter and `.qbook` saver — see the module-level
/// "Export uses the sheet's conservative used-range" note and the tracked
/// cross-cutting effective-extent follow-up.
pub fn export_csv_bytes(
    workbook: &Workbook,
    sheet_id: SheetId,
    options: CsvExportOptions,
) -> Result<Vec<u8>, CsvError> {
    let sheet = workbook
        .sheet(sheet_id)
        .ok_or(CsvError::SheetNotFound(sheet_id))?;
    let bounds = sheet.bounds();

    let mut wtr = csv::WriterBuilder::new()
        .delimiter(options.delimiter)
        .from_writer(Vec::<u8>::new());

    let mut record: Vec<String> = Vec::with_capacity(bounds.col_extent as usize);
    for row in 0..bounds.row_extent {
        record.clear();
        for col in 0..bounds.col_extent {
            // `Value`'s Display is the canonical invariant text form
            // (Blank → "", Number → shortest, Boolean → TRUE/FALSE, …).
            record.push(sheet.read(row, col).to_string());
        }
        wtr.write_record(&record)?;
    }

    wtr.into_inner().map_err(|e| CsvError::Io(e.into_error()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_value_rules() {
        assert_eq!(infer_value(""), Value::Blank);
        assert_eq!(infer_value("TRUE"), Value::Boolean(true));
        assert_eq!(infer_value("true"), Value::Boolean(true));
        assert_eq!(infer_value("FALSE"), Value::Boolean(false));
        assert_eq!(infer_value("42"), Value::Number(42.0));
        assert_eq!(infer_value("-3.5"), Value::Number(-3.5));
        assert_eq!(infer_value("1e3"), Value::Number(1000.0));
        // Non-finite literals stay text (no silent sanitisation to an error).
        assert_eq!(infer_value("inf"), Value::text("inf"));
        assert_eq!(infer_value("nan"), Value::text("nan"));
        // Leading '=' is NOT a formula — injection-safe.
        assert_eq!(infer_value("=1+1"), Value::text("=1+1"));
        assert_eq!(infer_value("hello"), Value::text("hello"));
        // Surrounding whitespace keeps it text (conservative).
        assert_eq!(infer_value(" 5 "), Value::text(" 5 "));
    }

    #[test]
    fn import_basic_grid() {
        let csv = b"a,1,TRUE\nhello,2.5,=danger\n";
        let result = import_csv_bytes(csv, CsvImportOptions::default()).unwrap();
        let wb = &result.workbook;
        let s: SheetId = 0;
        assert_eq!(wb.sheet(s).unwrap().read(0, 0), Value::text("a"));
        assert_eq!(wb.sheet(s).unwrap().read(0, 1), Value::Number(1.0));
        assert_eq!(wb.sheet(s).unwrap().read(0, 2), Value::Boolean(true));
        assert_eq!(wb.sheet(s).unwrap().read(1, 0), Value::text("hello"));
        assert_eq!(wb.sheet(s).unwrap().read(1, 1), Value::Number(2.5));
        assert_eq!(wb.sheet(s).unwrap().read(1, 2), Value::text("=danger"));
        assert_eq!(result.report.rows, 2);
        assert_eq!(result.report.cells_loaded, 6);
    }

    #[test]
    fn import_blank_field_stays_sparse() {
        let csv = b"x,,y\n";
        let result = import_csv_bytes(csv, CsvImportOptions::default()).unwrap();
        let s: SheetId = 0;
        assert_eq!(
            result.workbook.sheet(s).unwrap().read(0, 0),
            Value::text("x")
        );
        assert_eq!(result.workbook.sheet(s).unwrap().read(0, 1), Value::Blank);
        assert_eq!(
            result.workbook.sheet(s).unwrap().read(0, 2),
            Value::text("y")
        );
        assert_eq!(result.report.cells_loaded, 2);
    }

    #[test]
    fn import_strips_leading_utf8_bom() {
        // Excel's "CSV UTF-8" export prepends EF BB BF. It must NOT contaminate
        // cell (0,0).
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"name,2\n");
        let result = import_csv_bytes(&bytes, CsvImportOptions::default()).unwrap();
        assert_eq!(
            result.workbook.sheet(0).unwrap().read(0, 0),
            Value::text("name")
        );
        assert_eq!(
            result.workbook.sheet(0).unwrap().read(0, 1),
            Value::Number(2.0)
        );
    }

    #[test]
    fn import_numeric_inference_is_excel_like_and_lossy() {
        // Documented, intentional: number-shaped identifiers lose lexical form
        // (matches Excel's CSV import). Pinned so the behavior is explicit.
        let result = import_csv_bytes(b"00123,+44,1.0\n", CsvImportOptions::default()).unwrap();
        let s = result.workbook.sheet(0).unwrap();
        assert_eq!(s.read(0, 0), Value::Number(123.0)); // leading zeros lost
        assert_eq!(s.read(0, 1), Value::Number(44.0)); // leading '+' consumed
        assert_eq!(s.read(0, 2), Value::Number(1.0));
    }

    #[test]
    fn import_non_utf8_fails_loud() {
        // 0xFF is never valid UTF-8.
        let bytes = [b'a', b',', 0xFF, b'\n'];
        let err = import_csv_bytes(&bytes, CsvImportOptions::default()).unwrap_err();
        assert!(matches!(err, CsvError::Parse(_)), "got {err:?}");
    }

    #[test]
    fn import_too_many_columns_fails_loud_not_panics() {
        // One row with MAX_COLUMN + 2 fields → column index MAX_COLUMN + 1 trips
        // the guard. (The row-limit guard is symmetric; not exercised here
        // because a > 1,048,576-row fixture is impractical in a unit test.)
        let row = vec!["1"; (MAX_COLUMN as usize) + 2].join(",");
        let err = import_csv_bytes(row.as_bytes(), CsvImportOptions::default()).unwrap_err();
        match err {
            CsvError::ExceedsSheetLimits { what, max, .. } => {
                assert_eq!(what, "column");
                assert_eq!(max, MAX_COLUMN as u64);
            }
            other => panic!("expected ExceedsSheetLimits, got {other:?}"),
        }
    }

    #[test]
    fn export_renders_values_and_quotes() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::text("plain"));
        wb.put_at(s, 0, 1, Value::Number(20.0));
        wb.put_at(s, 0, 2, Value::Boolean(true));
        // Cell needing quotes: contains the delimiter, a quote, and a newline.
        wb.put_at(s, 1, 0, Value::text("a,b\"c\nd"));
        // (1,1) left blank → empty field; (1,2) blank too.
        let bytes = export_csv_bytes(&wb, s, CsvExportOptions::default()).unwrap();
        let out = String::from_utf8(bytes).unwrap();
        // Row 0: plain,20,TRUE  (number Display drops the .0; bool canonical case)
        assert!(out.contains("plain,20,TRUE"), "out=<{out}>");
        // Row 1: the messy cell is quoted with the embedded quote doubled.
        assert!(out.contains("\"a,b\"\"c\nd\""), "out=<{out}>");
    }

    #[test]
    fn export_empty_sheet_is_empty() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let bytes = export_csv_bytes(&wb, s, CsvExportOptions::default()).unwrap();
        assert!(bytes.is_empty());
    }

    #[test]
    fn export_unknown_sheet_fails_loud() {
        let wb = Workbook::new();
        let err = export_csv_bytes(&wb, 7, CsvExportOptions::default()).unwrap_err();
        assert!(matches!(err, CsvError::SheetNotFound(7)), "got {err:?}");
    }

    #[test]
    fn round_trip_preserves_values() {
        let original = b"name,score,passed\nAlice,91.5,TRUE\nBob,0,FALSE\n";
        let imported = import_csv_bytes(original, CsvImportOptions::default()).unwrap();
        let bytes = export_csv_bytes(&imported.workbook, 0, CsvExportOptions::default()).unwrap();
        let out = String::from_utf8(bytes).unwrap();
        // Values survive the round-trip (numbers as shortest form, bools canonical).
        assert!(out.contains("name,score,passed"));
        assert!(out.contains("Alice,91.5,TRUE"));
        assert!(out.contains("Bob,0,FALSE"));
    }
}
