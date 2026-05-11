//! Cell coordinate types — `SheetId`, `RowId`, `ColId`, `Address`, `Range`.
//!
//! Per spec Part V §2.8, these foundation types live in `ql-types` so every downstream crate
//! (ql-storage, ql-calcgraph, ql-formula-syntax, ql-functions) can consume them without a
//! mutual-dependency cycle. They're added in Week 2 Days 3-4 (when ql-storage first needs them)
//! rather than Days 1-2 (which was just `Value` + `ErrorValue` + coercion per master plan §6.3).
//!
//! Phase 0 representation choices (kept simple; pack/compact later if profiling demands):
//! - `SheetId = u16` — 65,536 sheets per workbook is far beyond any real workbook (Excel: 255).
//! - `RowId   = u32` — Excel has 1,048,576 rows; u32 (4.3B) covers it 4000× over.
//! - `ColId   = u32` — Excel has 16,384 cols; u32 covers it 260K× over.
//! - `Address` is a plain struct (12 bytes incl. padding). The Formualizer-style packed
//!   `Coord(u64)` is a future optimization — not premature for Phase 0.

use std::fmt;

/// 16-bit sheet index within a workbook. 0-indexed.
pub type SheetId = u16;

/// 32-bit row index within a sheet. 0-indexed (row "1" in Excel A1 notation = `RowId(0)`).
pub type RowId = u32;

/// 32-bit column index within a sheet. 0-indexed (column "A" = `ColId(0)`).
pub type ColId = u32;

/// Excel's row max — 1,048,576 rows means max 0-indexed row is 1,048,575. Used as the
/// upper bound for ColumnStore writes, Sheet::put, and any other grid-write op.
pub const MAX_ROW: RowId = 1_048_575;

/// Excel's column max — XFD = 16,383 (0-indexed). Used as the upper bound for grid writes.
pub const MAX_COLUMN: ColId = 16_383;

/// A sheet-qualified cell address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub struct Address {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
}

impl Address {
    pub const fn new(sheet: SheetId, row: RowId, col: ColId) -> Self {
        Self { sheet, row, col }
    }
}

impl fmt::Display for Address {
    /// Render in `sheet:row,col` form (0-indexed). The Excel-style A1 form lives in
    /// `ql-formula-syntax` because it's part of the formula-language surface; this is the
    /// engine-internal canonical form.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{},{}", self.sheet, self.row, self.col)
    }
}

/// A rectangular range within a single sheet. `start` ≤ `end` per `Ord` on `Address`,
/// enforced by the constructor. Empty ranges (start == end) are valid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Range {
    pub sheet: SheetId,
    /// Inclusive top-left row.
    pub start_row: RowId,
    /// Inclusive top-left column.
    pub start_col: ColId,
    /// Inclusive bottom-right row.
    pub end_row: RowId,
    /// Inclusive bottom-right column.
    pub end_col: ColId,
}

impl Range {
    /// Construct a range, normalizing so `start ≤ end` per axis.
    pub fn new(sheet: SheetId, row1: RowId, col1: ColId, row2: RowId, col2: ColId) -> Self {
        Self {
            sheet,
            start_row: row1.min(row2),
            start_col: col1.min(col2),
            end_row: row1.max(row2),
            end_col: col1.max(col2),
        }
    }

    /// Total number of cells in the range (inclusive on both ends).
    ///
    /// Uses widening then checked arithmetic. With u32 row/col bounds, the theoretical max
    /// is 2^32 × 2^32 = 2^64 = u64::MAX EXACTLY (1 too many for u64::MAX). For Excel-canonical
    /// bounds (1M rows × 16K cols = ~17B cells) this is comfortably under u64::MAX, but the
    /// arithmetic is bound-checked anyway (per opus arch F2 + founder "No Fallbacks" rule).
    pub fn cell_count(&self) -> u64 {
        let rows: u64 = u64::from(self.end_row - self.start_row) + 1;
        let cols: u64 = u64::from(self.end_col - self.start_col) + 1;
        rows.checked_mul(cols)
            .expect("Range::cell_count: overflow — range too large to count in u64")
    }

    /// True iff `addr` lies within this range (same sheet, inclusive bounds).
    pub fn contains(&self, addr: Address) -> bool {
        addr.sheet == self.sheet
            && (self.start_row..=self.end_row).contains(&addr.row)
            && (self.start_col..=self.end_col).contains(&addr.col)
    }

    /// Top-left corner.
    pub fn top_left(&self) -> Address {
        Address::new(self.sheet, self.start_row, self.start_col)
    }

    /// Bottom-right corner.
    pub fn bottom_right(&self) -> Address {
        Address::new(self.sheet, self.end_row, self.end_col)
    }
}

impl fmt::Display for Range {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{},{}..{},{}",
            self.sheet, self.start_row, self.start_col, self.end_row, self.end_col
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Address ---------------------------------------------------------------

    #[test]
    fn address_const_new() {
        const A: Address = Address::new(0, 0, 0);
        assert_eq!(A.sheet, 0);
        assert_eq!(A.row, 0);
        assert_eq!(A.col, 0);
    }

    #[test]
    fn address_equality_and_ordering() {
        let a = Address::new(0, 1, 0);
        let b = Address::new(0, 1, 0);
        assert_eq!(a, b);
        let c = Address::new(0, 1, 1);
        assert!(a < c); // sort order: sheet → row → col
        let d = Address::new(0, 2, 0);
        assert!(c < d);
        let e = Address::new(1, 0, 0);
        assert!(d < e); // different sheet wins
    }

    #[test]
    fn address_display() {
        assert_eq!(format!("{}", Address::new(0, 0, 0)), "0:0,0");
        assert_eq!(
            format!("{}", Address::new(2, 1048575, 16383)),
            "2:1048575,16383"
        );
    }

    #[test]
    fn address_is_copy() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<Address>();
    }

    #[test]
    fn address_size_is_compact() {
        // 2 (sheet) + 4 (row) + 4 (col) = 10 raw; aligned to 12 bytes.
        assert!(
            std::mem::size_of::<Address>() <= 12,
            "Address grew to {} bytes",
            std::mem::size_of::<Address>()
        );
    }

    // -- Range -----------------------------------------------------------------

    #[test]
    fn range_normalizes_corners() {
        // start > end gets swapped on each axis.
        let r = Range::new(0, 10, 5, 0, 0);
        assert_eq!(r.start_row, 0);
        assert_eq!(r.start_col, 0);
        assert_eq!(r.end_row, 10);
        assert_eq!(r.end_col, 5);
    }

    #[test]
    fn range_already_normalized() {
        let r = Range::new(0, 0, 0, 10, 5);
        assert_eq!(r.start_row, 0);
        assert_eq!(r.end_row, 10);
    }

    #[test]
    fn range_single_cell_count() {
        let r = Range::new(0, 5, 5, 5, 5);
        assert_eq!(r.cell_count(), 1);
    }

    #[test]
    fn range_cell_count_matches_inclusive_bounds() {
        // A1:B3 = 3 rows × 2 cols = 6 cells (0-indexed: rows 0..2, cols 0..1).
        let r = Range::new(0, 0, 0, 2, 1);
        assert_eq!(r.cell_count(), 6);
        // 25M-cell phase0 fixture: 500_000 rows × 50 cols
        let p = Range::new(0, 0, 0, 499_999, 49);
        assert_eq!(p.cell_count(), 25_000_000);
    }

    #[test]
    fn range_contains_inclusive() {
        let r = Range::new(0, 0, 0, 10, 5);
        assert!(r.contains(Address::new(0, 0, 0))); // top-left inclusive
        assert!(r.contains(Address::new(0, 10, 5))); // bottom-right inclusive
        assert!(r.contains(Address::new(0, 5, 3)));
        assert!(!r.contains(Address::new(0, 11, 0))); // beyond row
        assert!(!r.contains(Address::new(0, 0, 6))); // beyond col
        assert!(!r.contains(Address::new(1, 0, 0))); // different sheet
    }

    #[test]
    fn range_corners() {
        let r = Range::new(2, 5, 3, 10, 8);
        assert_eq!(r.top_left(), Address::new(2, 5, 3));
        assert_eq!(r.bottom_right(), Address::new(2, 10, 8));
    }

    #[test]
    fn range_display() {
        let r = Range::new(0, 0, 0, 99, 49);
        assert_eq!(format!("{r}"), "0:0,0..99,49");
    }

    #[test]
    fn range_is_copy() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<Range>();
    }

    #[test]
    fn primitive_ids_size_check() {
        assert_eq!(std::mem::size_of::<SheetId>(), 2);
        assert_eq!(std::mem::size_of::<RowId>(), 4);
        assert_eq!(std::mem::size_of::<ColId>(), 4);
    }
}
