//! `ql-storage` — Workbook, Sheet, ColumnStore, SparseOverlay.
//!
//! Per spec Part V §4 Week 2 Days 3-4. Phase 0 minimum:
//! - [`workbook`] — top-level `Workbook` + `NameTable` stub.
//! - [`sheet`] — per-sheet `Sheet` + conservative `Bounds` tracking.
//! - [`column`] — `ColumnStore`: chunked Arrow base + per-chunk sparse overlay; default
//!   chunk size 16,384 rows (`QBOOK_CHUNK_ROWS` env override).
//! - [`overlay`] — `SparseOverlay`: per-chunk `BTreeMap<RowId, Value>`; overlay-first reads.
//!
//! Design locks (from spec): chunk-replace, not cell-mutate. Result columns from recompute
//! swap whole chunks via `ColumnStore::replace_chunk`; cell-level writes go through the
//! overlay (`ColumnStore::put`) and are never applied to the base array directly.

pub mod column;
pub mod overlay;
pub mod sheet;
pub mod workbook;

pub use column::{chunk_rows_from_env, ColumnStore, DEFAULT_CHUNK_ROWS};
pub use overlay::SparseOverlay;
pub use sheet::{Bounds, Sheet};
pub use workbook::{NameTable, NamedTarget, Workbook};

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::{Address, Value};

    #[test]
    fn end_to_end_minimum_workbook_read_write() {
        // The smallest E2E that touches every module: workbook → sheet → column → overlay.
        let mut wb = Workbook::new();
        let s = wb.add_sheet_with_chunk_rows("Sheet1", 16);
        wb.put(Address::new(s, 0, 0), Value::Number(42.0));
        assert_eq!(wb.read(Address::new(s, 0, 0)), Value::Number(42.0));
        // Confirms re-exports compile + integration is wired.
        let _: SparseOverlay = SparseOverlay::new();
        let _: ColumnStore = ColumnStore::new();
        let _: Sheet = Sheet::new("t");
        let _: NameTable = NameTable::new();
        let _: Bounds = Bounds::default();
    }
}
