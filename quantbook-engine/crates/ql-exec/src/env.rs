//! Cell-read environment for the scalar evaluator.
//!
//! The evaluator needs to look up cell values when it encounters `ExprPlan::CellRef`.
//! Rather than coupling to `ql-storage::Workbook` directly, we abstract via a trait so:
//!
//! - Test harnesses can supply a `HashMap`-backed fake environment.
//! - The Week 4+ runtime can wrap a real `Workbook` + `ColumnStore` chain.
//! - Future cross-workbook references (Phase 6+) can implement the trait against an
//!   external dataset adapter.
//!
//! The trait is intentionally narrow: just `read_cell`. Sheet-/column-bulk reads belong on
//! `ql-storage` directly and the SIMD path (W4-2) doesn't go through this trait at all —
//! it reads Arrow chunks via `ColumnStore::iter_chunks` for batch processing.

use ql_types::{ColId, RowId, SheetId, Value};

/// Read a single cell value. Out-of-bounds reads return `Value::Blank` per Excel semantics.
pub trait CellEnv {
    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value;
}

/// `ql-storage::Workbook`-backed implementation. Wraps a Workbook reference; reads dispatch
/// via the Workbook's sheet lookup + the sheet's `read(row, col)`.
pub struct WorkbookEnv<'w> {
    workbook: &'w ql_storage::Workbook,
}

impl<'w> WorkbookEnv<'w> {
    pub fn new(workbook: &'w ql_storage::Workbook) -> Self {
        Self { workbook }
    }
}

impl<'w> CellEnv for WorkbookEnv<'w> {
    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value {
        match self.workbook.sheet(sheet) {
            Some(s) => s.read(row, col),
            // Out-of-bounds sheet — Excel returns #REF!. Per no-fallbacks rule, this is
            // a SEMANTIC choice (not a fallback): Phase 0 evaluator deliberately maps
            // missing-sheet to Blank for now, matching the Excel "removed sheet" behavior.
            // When sheet-deletion lands Phase 3+, this maps to ErrorValue::Ref.
            None => Value::Blank,
        }
    }
}

/// HashMap-backed env for tests + simple harnesses. Stores `((sheet, row, col), Value)`
/// triples; missing keys return `Value::Blank` per Excel semantics.
#[derive(Clone, Debug, Default)]
pub struct MapEnv {
    cells: std::collections::HashMap<(SheetId, RowId, ColId), Value>,
}

impl MapEnv {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        self.cells.insert((sheet, row, col), value);
    }
}

impl CellEnv for MapEnv {
    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value {
        self.cells
            .get(&(sheet, row, col))
            .cloned()
            .unwrap_or(Value::Blank)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_env_blank_for_missing() {
        let e = MapEnv::new();
        assert_eq!(e.read_cell(0, 0, 0), Value::Blank);
    }

    #[test]
    fn map_env_roundtrip() {
        let mut e = MapEnv::new();
        e.put(0, 5, 3, Value::Number(42.0));
        assert_eq!(e.read_cell(0, 5, 3), Value::Number(42.0));
        assert_eq!(e.read_cell(0, 5, 2), Value::Blank);
    }

    #[test]
    fn workbook_env_blank_for_missing_sheet() {
        let wb = ql_storage::Workbook::new();
        let e = WorkbookEnv::new(&wb);
        assert_eq!(e.read_cell(99, 0, 0), Value::Blank);
    }

    #[test]
    fn workbook_env_reads_existing_cell() {
        let mut wb = ql_storage::Workbook::new();
        let sheet_id = wb.add_sheet("S1");
        wb.sheet_mut(sheet_id)
            .unwrap()
            .put(5, 3, Value::Number(7.0));
        let e = WorkbookEnv::new(&wb);
        assert_eq!(e.read_cell(sheet_id, 5, 3), Value::Number(7.0));
        assert_eq!(e.read_cell(sheet_id, 0, 0), Value::Blank);
    }
}
