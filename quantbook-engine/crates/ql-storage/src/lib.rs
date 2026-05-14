//! `ql-storage` — Workbook, Sheet, ColumnStore, SparseOverlay.
//!
//! Per spec Part V §4 Week 2 Days 3-4. Phase 0 minimum, with Phase 2A
//! extensions to `Workbook`:
//! - [`workbook`] — top-level `Workbook` + `NameTable` (real HashMap-backed
//!   storage since Phase 2A.1; canonicalizing-on-write since Phase 2A.6).
//! - [`sheet`] — per-sheet `Sheet` + conservative `Bounds` tracking.
//! - [`column`] — `ColumnStore`: chunked Arrow base + per-chunk sparse overlay; default
//!   chunk size 16,384 rows (`QBOOK_CHUNK_ROWS` env override).
//! - [`overlay`] — `SparseOverlay`: per-chunk `BTreeMap<RowId, Value>`; overlay-first reads.
//!
//! Design locks (from spec): chunk-replace, not cell-mutate. Result columns from recompute
//! swap whole chunks via `ColumnStore::replace_chunk`; cell-level writes go through the
//! overlay (`ColumnStore::put`) and are never applied to the base array directly.

pub mod column;
pub mod format;
pub mod format_overlay;
pub mod overlay;
pub mod sheet;
pub mod spill;
pub mod tables;
pub mod workbook;

pub use column::{chunk_rows_from_env, ColumnStore, DEFAULT_CHUNK_ROWS};
pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
pub use format_overlay::CellFormatOverlay;
pub use overlay::SparseOverlay;
pub use sheet::{Bounds, Sheet};
pub use spill::{SpillAnchorTable, SpillBlockError, SpillNotFoundError, SpillShape};
pub use tables::{TableColumn, TableMetadata, TableTable, TotalsFunction};
pub use workbook::{NameTable, NameTableError, NamedTarget, SheetNameError, Workbook};

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

    // ===== W5-79 / Phase 4.5.D part 3 — FormatTable + overlay integration =====

    #[test]
    fn workbook_default_has_format_table_with_builtins() {
        let wb = Workbook::new();
        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
        assert_eq!(wb.formats().lookup(FormatId(14)), Some("m/d/yyyy"));
    }

    #[test]
    fn workbook_intern_returns_existing_builtin_id() {
        let mut wb = Workbook::new();
        let id = wb.formats_mut().intern("0.00");
        assert_eq!(id, FormatId(2));
    }

    #[test]
    fn workbook_intern_new_string_allocates_custom_id() {
        let mut wb = Workbook::new();
        let id = wb.formats_mut().intern("\"⚓\" #,##0");
        assert_eq!(id.0, FIRST_CUSTOM_FORMAT_ID);
    }

    #[test]
    fn sheet_format_overlay_starts_empty() {
        let s = Sheet::new("Sheet1");
        assert!(s.format_overlay().is_empty());
    }

    #[test]
    fn sheet_format_overlay_set_and_clear_round_trip() {
        let mut s = Sheet::new("Sheet1");
        s.format_overlay_mut().set(3, 5, FormatId(14));
        assert_eq!(s.format_overlay().get(3, 5), Some(FormatId(14)));
        s.format_overlay_mut().clear(3, 5);
        assert!(s.format_overlay().get(3, 5).is_none());
    }

    #[test]
    fn workbook_independent_sheets_have_independent_overlays() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet_with_chunk_rows("A", 16);
        let s1 = wb.add_sheet_with_chunk_rows("B", 16);
        // Compose: set a format on A:(0,0) via the table + overlay APIs.
        let id = wb.formats_mut().intern("yyyy-mm-dd");
        wb.sheet_mut(s0).unwrap().format_overlay_mut().set(0, 0, id);
        // Sheet B should not see the entry.
        assert_eq!(wb.sheet(s0).unwrap().format_overlay().get(0, 0), Some(id));
        assert_eq!(wb.sheet(s1).unwrap().format_overlay().get(0, 0), None);
        // FormatTable lookup resolves back to the source string.
        assert_eq!(wb.formats().lookup(id), Some("yyyy-mm-dd"));
    }
}
