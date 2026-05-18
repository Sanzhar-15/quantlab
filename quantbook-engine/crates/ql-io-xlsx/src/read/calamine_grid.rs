//! Calamine-backed cell-grid reader.
//!
//! Per Phase 4.11 architecture: calamine owns the common grid path
//! (sheet names/order, sparse cell values, formula text via
//! `worksheet_formula`). The OOXML scanner submodules supplement
//! calamine for metadata calamine compresses or drops.
//!
//! **W5-D-14a (this commit)** — minimum viable grid: sheets + cells +
//! formula text. date1904 / scoped names / tables / styles / feature
//! inventory land in subsequent W5-D-14 commits.

use crate::error::XlsxError;
use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use std::io::Cursor;

/// Iterate over the workbook's grid cells via calamine.
///
/// Calamine accepts paths or byte slices. We normalize to bytes
/// internally so the import_xlsx_path / import_xlsx_bytes entry
/// points share the same code path. Path-based callers read the
/// whole file into memory first; this is consistent with calamine's
/// memory model (it copies the zip contents into memory anyway).
pub(crate) struct CalamineGrid {
    workbook: Xlsx<Cursor<Vec<u8>>>,
}

/// A cell yielded by [`CalamineGrid::iter_sheet`].
///
/// Coordinates are **absolute** (sheet-local 0-based row, 0-based col).
/// `formula` is the formula text WITHOUT the leading `=` (matches
/// Quantbook's storage convention via `Workbook::put_formula`).
/// `value` is the cached cell value (the engine's recompute pass may
/// later overwrite this).
#[derive(Debug, Clone)]
pub(crate) struct GridCell {
    /// 0-based row index within the sheet.
    pub row: u32,
    /// 0-based column index within the sheet.
    pub col: u32,
    /// The cached cell value parsed from OOXML.
    pub value: ql_types::Value,
    /// Optional formula text (no leading `=`). `Some` only for cells
    /// that have a formula; `None` for pure values.
    pub formula: Option<String>,
}

impl CalamineGrid {
    /// Build a grid reader from raw xlsx bytes.
    pub(crate) fn from_bytes(bytes: Vec<u8>) -> Result<Self, XlsxError> {
        let cursor = Cursor::new(bytes);
        let workbook: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(cursor)
            .map_err(|e: calamine::XlsxError| XlsxError::Calamine(e.to_string()))?;
        Ok(Self { workbook })
    }

    /// Sheet names in workbook order, as calamine sees them.
    ///
    /// **Important**: this is calamine's view; the OOXML scanner may
    /// disagree on order/visibility. The hybrid reader's
    /// reconciliation step (W5-D-14 follow-up) makes the OOXML view
    /// authoritative.
    pub(crate) fn sheet_names(&self) -> Vec<String> {
        self.workbook.sheet_names()
    }

    /// Yield every populated cell in the named sheet.
    ///
    /// Combines `worksheet_range` (cell values) with
    /// `worksheet_formula` (formula text) into a single per-cell view.
    /// Empty cells are skipped.
    ///
    /// Coordinate convention: calamine's `Range::used_cells()` returns
    /// **range-local** (row, col) — i.e., zero-based relative to the
    /// range's top-left. We add the range's `start()` offset so the
    /// returned coordinates are **sheet-absolute** (the format
    /// `Workbook::put_at` expects).
    pub(crate) fn iter_sheet(&mut self, name: &str) -> Result<Vec<GridCell>, XlsxError> {
        let range = self
            .workbook
            .worksheet_range(name)
            .map_err(|e| XlsxError::Calamine(format!("worksheet_range({name}): {e}")))?;

        // Formula range is optional — sheets without formulas return
        // Err. Treat absence as "no formulas in this sheet".
        let formula_range = self.workbook.worksheet_formula(name).ok();

        let (start_row, start_col) = match range.start() {
            Some(s) => (s.0, s.1),
            // Empty range — no cells to yield.
            None => return Ok(Vec::new()),
        };
        let (formula_start_row, formula_start_col) = formula_range
            .as_ref()
            .and_then(|r| r.start())
            .map(|s| (s.0, s.1))
            .unwrap_or((0, 0));

        let mut out = Vec::with_capacity(range.used_cells().count());
        for (local_row, local_col, value) in range.used_cells() {
            let abs_row = start_row + local_row as u32;
            let abs_col = start_col + local_col as u32;

            let mapped_value = data_to_value(value);

            // Look up the formula at the same absolute address (if the
            // sheet has a formula range at all). Calamine's formula
            // range can have a different start offset than the value
            // range, so translate carefully.
            let formula = formula_range.as_ref().and_then(|fr| {
                // Compute local coordinates within the formula range.
                let f_row_signed = abs_row as i64 - formula_start_row as i64;
                let f_col_signed = abs_col as i64 - formula_start_col as i64;
                if f_row_signed < 0 || f_col_signed < 0 {
                    return None;
                }
                let f_row = f_row_signed as usize;
                let f_col = f_col_signed as usize;
                let (h, w) = fr.get_size();
                if f_row >= h || f_col >= w {
                    return None;
                }
                let s = fr.get((f_row, f_col))?;
                if s.is_empty() {
                    None
                } else {
                    // OOXML stores formulas without the leading `=`; calamine
                    // returns them the same way. Defense-in-depth: strip a
                    // leading `=` if present.
                    let trimmed = s.strip_prefix('=').unwrap_or(s);
                    Some(trimmed.to_string())
                }
            });

            out.push(GridCell {
                row: abs_row,
                col: abs_col,
                value: mapped_value,
                formula,
            });
        }
        Ok(out)
    }
}

/// Translate a calamine `Data` into a Quantbook `Value`.
///
/// OOXML cell types map cleanly except:
/// - `DateTime` / `DateTimeIso` / `DurationIso` collapse to `Number`
///   (the serial-date number). The number-format style on the cell
///   distinguishes them visually; format mapping is W5-D-14b work.
/// - `Empty` cells shouldn't reach this fn (`used_cells()` filters
///   them), but if it does we map to `Value::Blank`.
fn data_to_value(d: &Data) -> ql_types::Value {
    use ql_types::{ErrorValue, Value};
    match d {
        Data::Int(n) => Value::Number(*n as f64),
        Data::Float(n) => Value::Number(*n),
        Data::String(s) => Value::text(s.as_str()),
        Data::Bool(b) => Value::Boolean(*b),
        // Excel stores dates as serial day numbers; calamine's
        // `DateTime` wraps that with a typed timestamp helper. We
        // recover the underlying serial for engine storage.
        Data::DateTime(dt) => Value::Number(dt.as_f64()),
        // ISO-8601 string forms — preserve as text for now; W5-D-14b
        // adds a parsing pass to convert these to serial-date numbers
        // using the workbook's date system (1900 or 1904).
        Data::DateTimeIso(s) | Data::DurationIso(s) => Value::text(s.as_str()),
        Data::Error(e) => Value::Error(match e {
            calamine::CellErrorType::Div0 => ErrorValue::DivZero,
            calamine::CellErrorType::NA => ErrorValue::NA,
            calamine::CellErrorType::Name => ErrorValue::Name,
            calamine::CellErrorType::Null => ErrorValue::Null,
            calamine::CellErrorType::Num => ErrorValue::Num,
            calamine::CellErrorType::Ref => ErrorValue::Ref,
            calamine::CellErrorType::Value => ErrorValue::Value,
            // `GettingData` is an Excel-protocol intermediate state;
            // for engine storage treat it as #N/A (closest semantic).
            calamine::CellErrorType::GettingData => ErrorValue::NA,
        }),
        Data::Empty => Value::Blank,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_to_value_maps_each_variant() {
        use ql_types::{ErrorValue, Value};
        assert_eq!(data_to_value(&Data::Int(42)), Value::Number(42.0));
        assert_eq!(data_to_value(&Data::Float(2.5)), Value::Number(2.5));
        assert_eq!(data_to_value(&Data::Bool(true)), Value::Boolean(true));
        assert_eq!(data_to_value(&Data::Empty), Value::Blank);
        assert_eq!(
            data_to_value(&Data::Error(calamine::CellErrorType::Div0)),
            Value::Error(ErrorValue::DivZero)
        );
        assert_eq!(
            data_to_value(&Data::Error(calamine::CellErrorType::GettingData)),
            Value::Error(ErrorValue::NA)
        );
        match data_to_value(&Data::String("hello".to_string())) {
            Value::Text(s) => assert_eq!(&*s, "hello"),
            other => panic!("expected Text, got {other:?}"),
        }
    }
}
