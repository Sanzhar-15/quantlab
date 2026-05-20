//! **W5-110 (Phase 4.8.A):** table metadata storage.
//!
//! Mirrors the [`crate::NameTable`] pattern (Phase 2A.1). Tables are
//! workbook-level entities: a named, rectangular range with column
//! metadata + header/totals row flags. Structured references like
//! `Sales[Qty]` resolve through this table at bind time.
//!
//! This module is **data model only** for 4.8.A. Mutation API (create /
//! rename / resize / drop) lands in 4.8.H + 4.8.I + 4.8.J via the
//! `WorkbookRuntime` layer with op-log emission. Direct calls into
//! [`TableTable`]'s mutation methods are reserved for the qbook loader
//! and tests; product code uses the runtime API.
//!
//! See `docs/architecture/2026-05-14-structured-references-and-tables.md`
//! § 4 for the data-model design.

use std::collections::HashMap;
use std::sync::Arc;

use ql_types::{Address, ColId, Range, RowId, SheetId, MAX_COLUMN, MAX_ROW};

/// **W5-110 (Phase 4.8.A):** the per-column metadata inside a [`TableMetadata`].
///
/// The `id` field is a stable per-column identifier monotonically allocated
/// from the workbook-level counter (`TableTable::next_column_id`, private).
/// Stable across renames within the table; never reused. Future phases (4.10
/// calculated columns, Phase 5 column move) consume `id` to disambiguate
/// columns even when names collide ephemerally.
///
/// `name` is the lowercase canonical form for case-insensitive lookup;
/// `display` preserves the original case for printer round-trip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableColumn {
    /// Stable id, monotonically allocated. NOT the index in
    /// [`TableMetadata::columns`] — removing a column does NOT renumber
    /// subsequent ids.
    pub id: u32,
    /// Lowercase canonical name.
    pub name: Arc<str>,
    /// Case-preserving display name.
    pub display: Arc<str>,
    /// Phase 4.10 will auto-populate the totals row when this is `Some`;
    /// 4.8 just stores the metadata.
    pub totals_function: Option<TotalsFunction>,
}

/// **W5-110 (Phase 4.8.A):** per-column totals-row function metadata.
///
/// Phase 4.8 stores this; Phase 4.10 will auto-populate the totals row's
/// formula text from it. `Custom` indicates a user-typed formula in the
/// totals row that doesn't match any of the canonical Excel totals
/// functions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TotalsFunction {
    None,
    Average,
    Count,
    CountNums,
    Max,
    Min,
    StdDev,
    Sum,
    Variance,
    Custom,
}

/// **W5-110 (Phase 4.8.A):** workbook-level table metadata.
///
/// A table is a named rectangular range with column metadata. Structured
/// references `Sales[Qty]` resolve through this struct at bind time.
///
/// **Coordinate model:** `top_row` / `top_col` is the top-left cell;
/// `rows × cols` covers the FULL footprint including header + totals
/// rows. `has_header` (true) means row `top_row` is the header row;
/// `has_totals` (true) means row `top_row + rows - 1` is the totals row.
///
/// **Range helpers** ([`Self::header_range`], [`Self::totals_range`],
/// [`Self::data_range`], [`Self::all_range`], [`Self::column_data_range`])
/// compute concrete `Range` values from the metadata; they are pure
/// functions over `&self` with no internal caching.
///
/// See the design doc § 4.1 for invariants + § 4.3 for the workbook-level
/// invariants (overlap rules, namespace sharing with `NameTable`, etc.).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableMetadata {
    /// Canonical name (uppercase). Mirrors `NameTable`'s canonicalization.
    pub name: Arc<str>,
    /// Display name (case-preserving). Defaults to `name` if no
    /// case-preserving form was supplied at create time.
    pub display_name: Arc<str>,
    /// Anchor sheet.
    pub sheet: SheetId,
    /// Top-left row of the table's full footprint.
    pub top_row: RowId,
    /// Top-left column.
    pub top_col: ColId,
    /// Total rows including header + totals.
    pub rows: u32,
    /// Total columns.
    pub cols: u32,
    /// `true` iff `top_row` is a header row.
    pub has_header: bool,
    /// `true` iff `top_row + rows - 1` is a totals row.
    pub has_totals: bool,
    /// Ordered column roster. Length == `cols`. Lookup by canonical
    /// (lowercase) name; case-preserving display in each entry.
    pub columns: Vec<TableColumn>,
}

impl TableMetadata {
    /// The header row's range if `has_header`, else `None`. Single-row
    /// `Range` covering all columns.
    pub fn header_range(&self) -> Option<Range> {
        if !self.has_header {
            return None;
        }
        Some(Range::new(
            self.sheet,
            self.top_row,
            self.top_col,
            self.top_row,
            self.top_col + self.cols - 1,
        ))
    }

    /// The totals row's range if `has_totals`, else `None`.
    pub fn totals_range(&self) -> Option<Range> {
        if !self.has_totals {
            return None;
        }
        let r = self.top_row + self.rows - 1;
        Some(Range::new(
            self.sheet,
            r,
            self.top_col,
            r,
            self.top_col + self.cols - 1,
        ))
    }

    /// The data range — rows excluding header + totals. Returns `None`
    /// for header-only / totals-only / header+totals-only tables where
    /// no data rows exist (`ql_types::Range` is inclusive and can't
    /// represent zero rows; see design § 16 q4 — binder maps `None`
    /// here to `BindError::StructuredRefDegenerateRange`).
    pub fn data_range(&self) -> Option<Range> {
        let mut first_data = self.top_row;
        let mut last_data = self.top_row + self.rows - 1;
        if self.has_header {
            first_data += 1;
        }
        if self.has_totals {
            // last_data is the totals row; data ends one above it.
            if last_data == 0 {
                return None;
            }
            last_data -= 1;
        }
        if first_data > last_data {
            return None;
        }
        Some(Range::new(
            self.sheet,
            first_data,
            self.top_col,
            last_data,
            self.top_col + self.cols - 1,
        ))
    }

    /// The full table footprint, including header + totals if present.
    pub fn all_range(&self) -> Range {
        Range::new(
            self.sheet,
            self.top_row,
            self.top_col,
            self.top_row + self.rows - 1,
            self.top_col + self.cols - 1,
        )
    }

    /// The data range for a single column, indexed by column position
    /// (0..self.cols). `None` if `col_idx` out of range OR no data rows.
    pub fn column_data_range(&self, col_idx: u32) -> Option<Range> {
        if col_idx >= self.cols {
            return None;
        }
        let data = self.data_range()?;
        let col = self.top_col + col_idx;
        Some(Range::new(
            self.sheet,
            data.start_row,
            col,
            data.end_row,
            col,
        ))
    }

    /// Look up a column by case-insensitive name. Returns `(col_idx,
    /// &TableColumn)` on hit. The canonical (lowercase) name lives in
    /// `TableColumn::name`; this method lowercases the query first so
    /// callers don't need to pre-canonicalize.
    pub fn lookup_column(&self, name: &str) -> Option<(u32, &TableColumn)> {
        let lower = name.to_ascii_lowercase();
        self.columns
            .iter()
            .enumerate()
            .find(|(_, c)| c.name.as_ref() == lower.as_str())
            .map(|(i, c)| (i as u32, c))
    }

    /// Does `addr` fall inside this table's full footprint (sheet +
    /// bounding rectangle)? Used by the `Workbook::table_at` reverse lookup.
    pub fn contains(&self, addr: Address) -> bool {
        addr.sheet == self.sheet
            && addr.row >= self.top_row
            && addr.row < self.top_row + self.rows
            && addr.col >= self.top_col
            && addr.col < self.top_col + self.cols
    }

    /// **W5-125 (Phase 4.8.O.1 — closing-megaudit HIGH-1):** validate
    /// that a footprint anchored at `(top_row, top_col)` with
    /// `(rows, cols)` extent fits within the Excel address grid.
    ///
    /// Producer (`WorkbookRuntime::create_table` / `resize_table`),
    /// replay (`apply_create_table` / `apply_resize_table`), and the
    /// v6 `.qbook` loader all call this BEFORE entering any footprint
    /// loop, which closes two failure modes Codex flagged in the
    /// 4.8.O megaudit:
    /// 1. `top_row + rows - 1 > MAX_ROW` (or same for col) — a table
    ///    can register cells beyond the addressable grid, causing
    ///    `Sheet::put` panics later on writes into those cells.
    /// 2. `top_row + rows` overflows `u32` — the footprint loop's
    ///    `for r in top_row..top_row + rows` becomes either an empty
    ///    range (skipping all overlap / spill-anchor checks) or runs
    ///    with wrapped bounds.
    ///
    /// Returns a `&'static str` reason on failure for caller-side
    /// error wrapping (`RuntimeError::TableCreateRejected` /
    /// `TableResizeRejected`, `ReplayError::*`, `QbookError::MalformedTable`).
    ///
    /// **Pre-condition:** `rows > 0 && cols > 0`. Callers enforce
    /// this separately so they can emit the more specific
    /// "rows and cols must both be > 0" error for the zero case.
    pub fn validate_footprint_bounds(
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
    ) -> Result<(), &'static str> {
        debug_assert!(rows > 0 && cols > 0, "caller must enforce non-zero dims");
        let last_row = top_row
            .checked_add(rows - 1)
            .ok_or("table footprint extends past addressable row range (u32 overflow)")?;
        if last_row > MAX_ROW {
            return Err("table footprint extends past MAX_ROW");
        }
        let last_col = top_col
            .checked_add(cols - 1)
            .ok_or("table footprint extends past addressable column range (u32 overflow)")?;
        if last_col > MAX_COLUMN {
            return Err("table footprint extends past MAX_COLUMN");
        }
        Ok(())
    }
}

/// **W5-110 (Phase 4.8.A):** workbook-level table registry.
///
/// Mirrors [`crate::NameTable`]: HashMap-backed storage keyed by
/// uppercase-canonical name + generation counter for plan-cache
/// invalidation. The `next_column_id` allocator hands out monotonic
/// per-column ids across the whole workbook (one counter, all tables
/// share); future phases (4.10 calculated columns, Phase 5 column move)
/// consume these ids.
///
/// **No mutation API in 4.8.A.** Direct `tables.insert` from the qbook
/// loader is fine; product code mutates via `WorkbookRuntime::create_table`
/// etc. (4.8.H+) which emit op-log entries.
#[derive(Clone, Debug, Default)]
pub struct TableTable {
    tables: HashMap<Arc<str>, TableMetadata>,
    /// Monotonic counter bumped on every successful mutation. Plan-cache
    /// invalidation keys can include this so column renames / resizes
    /// invalidate cached `ExprPlan::StructuredRef` entries. See design
    /// § 7.5.
    generation: u64,
    /// Monotonic per-column-id allocator. Shared across all tables.
    /// Allocated at column-create time; never reused.
    next_column_id: u32,
}

impl TableTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind-plan cache invalidation counter (see [`NameTable::generation`]
    /// for the pattern). Bumped on every successful mutation.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Case-insensitive lookup. Uppercases the query.
    pub fn lookup(&self, name: &str) -> Option<&TableMetadata> {
        let upper = name.to_ascii_uppercase();
        self.tables.get(upper.as_str())
    }

    /// Reverse lookup: which table contains the given cell, if any?
    /// O(num_tables) scan; tables-per-workbook is small (typically < 100).
    ///
    /// Used by:
    /// - the binder for `[@Col]` resolution (which table is the formula in?).
    /// - `create_table` / `resize_table` validation (does the proposed
    ///   footprint overlap another table?).
    pub fn table_at(&self, addr: Address) -> Option<&TableMetadata> {
        self.tables.values().find(|t| t.contains(addr))
    }

    /// All table entries; HashMap-arbitrary order.
    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &TableMetadata)> + '_ {
        self.tables.iter()
    }

    pub fn len(&self) -> usize {
        self.tables.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }

    /// **Loader / mutation-internal API.** Insert a table by canonical
    /// uppercase name. The caller is responsible for:
    /// - canonicalizing the key (uppercase) BEFORE calling.
    /// - validating uniqueness, non-overlap, valid Excel-shaped name
    ///   (design § 5.3) — `WorkbookRuntime::create_table` does this in
    ///   4.8.H.
    ///
    /// Bumps the generation counter on success.
    ///
    /// **W5-123 (Phase 4.8.L):** also auto-bumps `next_column_id` past
    /// the highest column id in `meta.columns`. The `.qbook` loader
    /// (Phase 4.8.L persistence) preserves stable column ids verbatim;
    /// without this self-maintenance the runtime allocator could
    /// later hand out an id that collides with one already in storage.
    pub fn insert(&mut self, canonical: Arc<str>, meta: TableMetadata) {
        if let Some(max_id) = meta.columns.iter().map(|c| c.id).max() {
            self.next_column_id = self.next_column_id.max(max_id + 1);
        }
        self.tables.insert(canonical, meta);
        self.generation = self.generation.wrapping_add(1);
    }

    /// Remove a table by canonical name. Bumps generation iff a removal
    /// occurred (idempotent no-op clears don't invalidate caches).
    pub fn remove(&mut self, canonical: &str) -> Option<TableMetadata> {
        let upper = canonical.to_ascii_uppercase();
        let removed = self.tables.remove(upper.as_str());
        if removed.is_some() {
            self.generation = self.generation.wrapping_add(1);
        }
        removed
    }

    /// Allocate and return the next column id. Each call returns a fresh
    /// id; the counter is monotonic across the workbook lifetime (per
    /// design § 4.1). Wraps at u32::MAX via `wrapping_add`; in practice
    /// 4 billion column allocations is unreachable.
    pub fn allocate_column_id(&mut self) -> u32 {
        let id = self.next_column_id;
        self.next_column_id = self.next_column_id.wrapping_add(1);
        id
    }

    /// Mutable access to a table by canonical name. Used by the loader
    /// and by mutation methods in 4.8.H+. Bumps generation on mutation
    /// is the CALLER's responsibility (since `&mut TableMetadata` lets
    /// the caller see no-op mutations too).
    pub fn get_mut(&mut self, canonical: &str) -> Option<&mut TableMetadata> {
        let upper = canonical.to_ascii_uppercase();
        self.tables.get_mut(upper.as_str())
    }

    /// Explicitly bump generation. For callers that mutated through
    /// `get_mut` and need to invalidate caches.
    pub fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(id: u32, name: &str) -> TableColumn {
        TableColumn {
            id,
            name: Arc::from(name.to_ascii_lowercase().as_str()),
            display: Arc::from(name),
            totals_function: None,
        }
    }

    fn sales_table() -> TableMetadata {
        // Sales: A1:D10 with header (row 0) + totals (row 9). 8 data rows.
        TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 10,
            cols: 4,
            has_header: true,
            has_totals: true,
            columns: vec![
                col(0, "Region"),
                col(1, "Product"),
                col(2, "Qty"),
                col(3, "Price"),
            ],
        }
    }

    #[test]
    fn header_range_matches_top_row() {
        let t = sales_table();
        let h = t.header_range().unwrap();
        assert_eq!((h.sheet, h.start_row, h.end_row), (0, 0, 0));
        assert_eq!((h.start_col, h.end_col), (0, 3));
    }

    #[test]
    fn totals_range_matches_bottom_row() {
        let t = sales_table();
        let r = t.totals_range().unwrap();
        assert_eq!((r.start_row, r.end_row), (9, 9));
        assert_eq!((r.start_col, r.end_col), (0, 3));
    }

    #[test]
    fn data_range_excludes_header_and_totals() {
        let t = sales_table();
        let d = t.data_range().unwrap();
        assert_eq!((d.start_row, d.end_row), (1, 8));
        assert_eq!((d.start_col, d.end_col), (0, 3));
    }

    #[test]
    fn all_range_covers_entire_footprint() {
        let t = sales_table();
        let a = t.all_range();
        assert_eq!((a.start_row, a.end_row), (0, 9));
        assert_eq!((a.start_col, a.end_col), (0, 3));
    }

    #[test]
    fn column_data_range_picks_one_column() {
        let t = sales_table();
        let qty = t.column_data_range(2).unwrap();
        assert_eq!((qty.start_row, qty.end_row), (1, 8));
        assert_eq!((qty.start_col, qty.end_col), (2, 2));
    }

    #[test]
    fn column_data_range_returns_none_for_out_of_range_idx() {
        let t = sales_table();
        assert_eq!(t.column_data_range(4), None);
    }

    #[test]
    fn header_only_table_has_no_data_range() {
        // 1 row, has_header — data range is empty.
        let t = TableMetadata {
            name: Arc::from("EMPTY"),
            display_name: Arc::from("Empty"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 1,
            cols: 2,
            has_header: true,
            has_totals: false,
            columns: vec![col(0, "A"), col(1, "B")],
        };
        assert_eq!(t.data_range(), None);
    }

    #[test]
    fn lookup_column_is_case_insensitive() {
        let t = sales_table();
        let (idx, c) = t.lookup_column("qty").unwrap();
        assert_eq!(idx, 2);
        assert_eq!(c.display.as_ref(), "Qty");
        let (idx2, _) = t.lookup_column("QTY").unwrap();
        assert_eq!(idx2, 2);
        let (idx3, _) = t.lookup_column("Qty").unwrap();
        assert_eq!(idx3, 2);
    }

    #[test]
    fn lookup_column_returns_none_for_missing() {
        let t = sales_table();
        assert!(t.lookup_column("Foobar").is_none());
    }

    #[test]
    fn contains_checks_full_footprint() {
        let t = sales_table();
        // Inside (row 5, col 2 — data area).
        assert!(t.contains(Address::new(0, 5, 2)));
        // Header row.
        assert!(t.contains(Address::new(0, 0, 0)));
        // Totals row.
        assert!(t.contains(Address::new(0, 9, 3)));
        // Outside col.
        assert!(!t.contains(Address::new(0, 5, 4)));
        // Outside row.
        assert!(!t.contains(Address::new(0, 10, 0)));
        // Different sheet.
        assert!(!t.contains(Address::new(1, 5, 2)));
    }

    #[test]
    fn table_table_insert_lookup_round_trip() {
        let mut tt = TableTable::new();
        let t = sales_table();
        tt.insert(Arc::clone(&t.name), t.clone());
        assert_eq!(tt.lookup("Sales"), Some(&t));
        assert_eq!(tt.lookup("SALES"), Some(&t));
        assert_eq!(tt.lookup("sales"), Some(&t));
        assert_eq!(tt.lookup("Other"), None);
        assert_eq!(tt.len(), 1);
        assert!(!tt.is_empty());
    }

    #[test]
    fn table_table_generation_bumps_on_mutation() {
        let mut tt = TableTable::new();
        let g0 = tt.generation();
        tt.insert(Arc::from("FOO"), sales_table());
        let g1 = tt.generation();
        assert_ne!(g0, g1);
        tt.remove("FOO");
        let g2 = tt.generation();
        assert_ne!(g1, g2);
        // Idempotent remove doesn't bump.
        tt.remove("FOO");
        assert_eq!(g2, tt.generation());
    }

    #[test]
    fn allocate_column_id_is_monotonic() {
        let mut tt = TableTable::new();
        assert_eq!(tt.allocate_column_id(), 0);
        assert_eq!(tt.allocate_column_id(), 1);
        assert_eq!(tt.allocate_column_id(), 2);
    }

    /// **W5-123 (Phase 4.8.L):** `insert` auto-bumps `next_column_id`
    /// past any column id in the inserted metadata. Without this, the
    /// `.qbook` loader (which preserves persisted column ids verbatim)
    /// would let `allocate_column_id` later hand out an id that
    /// collides with one already in storage.
    #[test]
    fn insert_bumps_next_column_id_past_loaded_ids() {
        let mut tt = TableTable::new();
        // Simulate loader inserting a table whose columns have ids
        // [10, 20, 30] (allocated in a previous session).
        let canonical: Arc<str> = Arc::from("LOADED");
        tt.insert(
            canonical,
            TableMetadata {
                name: Arc::from("LOADED"),
                display_name: Arc::from("Loaded"),
                sheet: 0,
                top_row: 0,
                top_col: 0,
                rows: 2,
                cols: 3,
                has_header: true,
                has_totals: false,
                columns: vec![col(10, "A"), col(20, "B"), col(30, "C")],
            },
        );
        // Next allocator call must return 31 (or higher), NEVER ≤ 30.
        let next = tt.allocate_column_id();
        assert_eq!(next, 31, "expected allocator to skip past id 30");
    }

    /// Two `insert` calls: the second table's column ids are LOWER than
    /// the first's. The allocator must STAY at the higher water mark.
    #[test]
    fn insert_preserves_high_water_across_multiple_inserts() {
        let mut tt = TableTable::new();
        tt.insert(
            Arc::from("A"),
            TableMetadata {
                name: Arc::from("A"),
                display_name: Arc::from("A"),
                sheet: 0,
                top_row: 0,
                top_col: 0,
                rows: 1,
                cols: 1,
                has_header: false,
                has_totals: false,
                columns: vec![col(100, "X")],
            },
        );
        tt.insert(
            Arc::from("B"),
            TableMetadata {
                name: Arc::from("B"),
                display_name: Arc::from("B"),
                sheet: 0,
                top_row: 0,
                top_col: 5,
                rows: 1,
                cols: 1,
                has_header: false,
                has_totals: false,
                columns: vec![col(5, "Y")],
            },
        );
        assert_eq!(
            tt.allocate_column_id(),
            101,
            "allocator must stay past highest seen (100)"
        );
    }

    #[test]
    fn insert_empty_columns_does_not_change_next_column_id() {
        let mut tt = TableTable::new();
        // Pre-bump to 5.
        for _ in 0..5 {
            let _ = tt.allocate_column_id();
        }
        tt.insert(
            Arc::from("EMPTY"),
            TableMetadata {
                name: Arc::from("EMPTY"),
                display_name: Arc::from("Empty"),
                sheet: 0,
                top_row: 0,
                top_col: 0,
                rows: 1,
                cols: 0,
                has_header: false,
                has_totals: false,
                columns: vec![],
            },
        );
        // Should still hand out 5 next.
        assert_eq!(tt.allocate_column_id(), 5);
    }

    #[test]
    fn table_at_finds_containing_table() {
        let mut tt = TableTable::new();
        tt.insert(Arc::from("SALES"), sales_table());
        // Header cell.
        assert_eq!(
            tt.table_at(Address::new(0, 0, 0)).map(|t| t.name.as_ref()),
            Some("SALES")
        );
        // Data cell.
        assert_eq!(
            tt.table_at(Address::new(0, 5, 2)).map(|t| t.name.as_ref()),
            Some("SALES")
        );
        // Outside.
        assert!(tt.table_at(Address::new(0, 100, 0)).is_none());
        assert!(tt.table_at(Address::new(1, 0, 0)).is_none());
    }

    // ===== W5-125 (Phase 4.8.O.1) — footprint-bounds helper =====

    #[test]
    fn validate_footprint_bounds_accepts_in_range_footprint() {
        // Pin the happy path: a small table at (0, 0).
        assert!(TableMetadata::validate_footprint_bounds(0, 0, 3, 2).is_ok());
        // Exactly at MAX_ROW / MAX_COLUMN.
        assert!(TableMetadata::validate_footprint_bounds(MAX_ROW, MAX_COLUMN, 1, 1).is_ok());
        assert!(TableMetadata::validate_footprint_bounds(MAX_ROW - 1, 0, 2, 1).is_ok());
    }

    #[test]
    fn validate_footprint_bounds_rejects_past_max_row() {
        // top_row + rows - 1 = MAX_ROW + 1 → past the grid.
        let err = TableMetadata::validate_footprint_bounds(MAX_ROW - 1, 0, 3, 1).unwrap_err();
        assert!(err.contains("MAX_ROW"), "reason: {err}");
        // Far over.
        let err2 = TableMetadata::validate_footprint_bounds(MAX_ROW, 0, 100, 1).unwrap_err();
        assert!(err2.contains("MAX_ROW"), "reason: {err2}");
    }

    #[test]
    fn validate_footprint_bounds_rejects_past_max_column() {
        let err = TableMetadata::validate_footprint_bounds(0, MAX_COLUMN - 1, 1, 3).unwrap_err();
        assert!(err.contains("MAX_COLUMN"), "reason: {err}");
    }

    #[test]
    fn validate_footprint_bounds_rejects_u32_overflow_on_rows() {
        // top_row + rows - 1 overflows u32 — the loop's `top_row + rows`
        // expression would wrap silently before this fix.
        let err = TableMetadata::validate_footprint_bounds(u32::MAX, 0, 2, 1).unwrap_err();
        assert!(
            err.contains("u32 overflow") || err.contains("addressable row"),
            "reason: {err}"
        );
    }

    #[test]
    fn validate_footprint_bounds_rejects_u32_overflow_on_cols() {
        let err = TableMetadata::validate_footprint_bounds(0, u32::MAX, 1, 2).unwrap_err();
        assert!(
            err.contains("u32 overflow") || err.contains("addressable column"),
            "reason: {err}"
        );
    }
}
