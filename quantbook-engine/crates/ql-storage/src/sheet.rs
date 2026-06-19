//! `Sheet` — a 2D collection of columns + dimension tracking.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - `columns: Vec<ColumnStore>`.
//! - `dimensions: Bounds` tracking the largest (row, col) ever written, conservative.
//! - Open-ended: reading a cell beyond `dimensions` returns `Value::Blank` (matches Excel).

use std::collections::BTreeSet;

use ql_types::{ColId, RowId, Value};

use crate::column::ColumnStore;
use crate::workbook::{NameTable, NameTableError, NamedTarget};

/// Conservative dimension tracking: max row and max col ever touched. Reads beyond return
/// `Blank` either way; `Bounds` exists for serialization + UI viewport sizing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bounds {
    /// One past the largest row ever written. Zero on an empty sheet.
    pub row_extent: RowId,
    /// One past the largest column ever touched.
    pub col_extent: ColId,
}

/// A single sheet. Columns are independent `ColumnStore`s; the sheet owns them.
#[derive(Clone, Debug, Default)]
pub struct Sheet {
    name: String,
    columns: Vec<ColumnStore>,
    bounds: Bounds,
    chunk_rows: u32,
    /// **W5-79 (Phase 4.5.D part 3):** per-sheet sparse cell-format
    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
    /// Resolution: lookup the id here, then call
    /// `workbook.formats().lookup(id)` to get the format-string, parse,
    /// and render.
    format_overlay: crate::CellFormatOverlay,
    /// **FE-4 W4 (2026-06-10):** per-sheet sparse cell-STYLE overlay (the
    /// visual-formatting analog of `format_overlay`). Cells without an entry
    /// render via `Style::default()` (no styling). Resolution: lookup the id
    /// here, then `workbook.styles().lookup(id)` to get the `Style` value.
    /// Re-keyed by `shift_rows`/`shift_columns` exactly like `format_overlay`.
    style_overlay: crate::CellStyleOverlay,
    /// **W5-92 (Phase 4.6.D):** sheet-scoped defined names. Lookup
    /// resolves sheet-scoped names first, then falls back to the
    /// workbook-scoped table; this is the storage half of that chain.
    /// `WorkbookEnv::lookup_named_target_for_sheet` (in `ql-exec`)
    /// owns the chain-walking logic. Same canonicalization rules as
    /// the workbook-scoped `NameTable` (ASCII-uppercase canonical).
    scoped_names: NameTable,
    /// **Wave G2 (engine-filter):** per-sheet sparse ROW-visibility set —
    /// rows present here are *hidden*; absent rows are visible (the default).
    /// Sparse + row-keyed (unlike the per-CELL `format_overlay`/`style_overlay`),
    /// so it is a `BTreeSet<RowId>` (deterministic iteration for snapshot/persist).
    /// Mutations route through `WorkbookRuntime::set_rows_hidden` (emits
    /// `Op::SetRowsHidden`); direct access stays for the loader + tests.
    /// Re-keyed by `shift_rows` ONLY (a ROW attribute) — `shift_columns` leaves
    /// it untouched, the one asymmetry vs the per-cell overlays. The
    /// `SUBTOTAL(101..=111)` "ignore hidden rows" variants read this set.
    hidden_rows: BTreeSet<RowId>,
}

impl Sheet {
    /// New empty sheet with the given name. Chunk size from env (or default).
    pub fn new(name: impl Into<String>) -> Self {
        Self::with_chunk_rows(name, crate::column::chunk_rows_from_env())
    }

    /// New empty sheet with an explicit chunk size — useful for tests.
    pub fn with_chunk_rows(name: impl Into<String>, chunk_rows: u32) -> Self {
        Self {
            name: name.into(),
            columns: Vec::new(),
            bounds: Bounds::default(),
            chunk_rows,
            format_overlay: crate::CellFormatOverlay::new(),
            style_overlay: crate::CellStyleOverlay::new(),
            scoped_names: NameTable::new(),
            hidden_rows: BTreeSet::new(),
        }
    }

    /// **W5-79 (Phase 4.5.D part 3):** read access to the per-sheet
    /// cell-format overlay.
    pub fn format_overlay(&self) -> &crate::CellFormatOverlay {
        &self.format_overlay
    }

    /// **W5-79 (Phase 4.5.D part 3):** mutable access for `set` /
    /// `clear`. Phase 4.5.D part 4 (W5-80) will route mutations through
    /// `WorkbookRuntime::set_cell_format` so they emit
    /// `Op::SetCellFormat`; direct access stays available for the
    /// loader + tests.
    pub fn format_overlay_mut(&mut self) -> &mut crate::CellFormatOverlay {
        &mut self.format_overlay
    }

    /// **FE-4 W4 (2026-06-10):** read access to the per-sheet cell-STYLE
    /// overlay (the visual-formatting analog of [`Self::format_overlay`]).
    pub fn style_overlay(&self) -> &crate::CellStyleOverlay {
        &self.style_overlay
    }

    /// **FE-4 W4 (2026-06-10):** mutable access for `set` / `clear`.
    /// Production callers route through `WorkbookRuntime::set_cell_style` so
    /// they emit `Op::SetCellStyle`; direct access stays available for the
    /// loader + tests (mirrors [`Self::format_overlay_mut`]).
    pub fn style_overlay_mut(&mut self) -> &mut crate::CellStyleOverlay {
        &mut self.style_overlay
    }

    /// **Wave G2 (engine-filter):** read access to the per-sheet hidden-row
    /// set (rows present are hidden). Used by the snapshot/getter, `.qbook`
    /// persistence, and the `SUBTOTAL(101..=111)` visibility check.
    pub fn hidden_rows(&self) -> &BTreeSet<RowId> {
        &self.hidden_rows
    }

    /// **Wave G2:** is `row` hidden? O(log n). The eval-time predicate behind
    /// `SUBTOTAL(101..=111)` (via `CellEnv::is_row_hidden`).
    pub fn is_row_hidden(&self, row: RowId) -> bool {
        self.hidden_rows.contains(&row)
    }

    /// **Wave G2:** hide (`hidden = true`) or show (`hidden = false`) a single
    /// row. Idempotent. Production callers route through
    /// `WorkbookRuntime::set_rows_hidden` (which emits `Op::SetRowsHidden` and
    /// dirties dependents); this low-level setter is for op-log replay + tests.
    pub fn set_row_hidden(&mut self, row: RowId, hidden: bool) {
        if hidden {
            self.hidden_rows.insert(row);
        } else {
            self.hidden_rows.remove(&row);
        }
    }

    /// **Wave G2:** mutable access for loader paths + op-log replay (mirrors
    /// [`Self::format_overlay_mut`]). Production callers route through
    /// `WorkbookRuntime::set_rows_hidden`.
    pub fn hidden_rows_mut(&mut self) -> &mut BTreeSet<RowId> {
        &mut self.hidden_rows
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// **W5-92 (Phase 4.6.D):** read access to the per-sheet named-target
    /// table. Storage-layer surface only — bind-time chain walking
    /// happens in `ql-exec::env::WorkbookEnv`.
    pub fn scoped_names(&self) -> &NameTable {
        &self.scoped_names
    }

    /// **W5-92 (Phase 4.6.D):** mutable access for loader paths +
    /// op-log replay. Production callers route through
    /// `WorkbookRuntime::set_sheet_scoped_name` (which emits
    /// `Op::SetName { scope: Some(_), .. }`).
    pub fn scoped_names_mut(&mut self) -> &mut NameTable {
        &mut self.scoped_names
    }

    /// **W5-92 (Phase 4.6.D):** register a sheet-scoped name. Mirrors
    /// `Workbook::set_name` (validate, append, propagate generation).
    /// Reserved-name guard still applies (CORR-06 / `AI`); callers see
    /// `NameTableError::Reserved` for those.
    pub fn set_scoped_name(
        &mut self,
        name: &str,
        target: NamedTarget,
    ) -> Result<(), NameTableError> {
        self.scoped_names.set(name, target)
    }

    /// **W5-92 (Phase 4.6.D):** drop a sheet-scoped name. Idempotent
    /// (no-op for unknown names).
    pub fn clear_scoped_name(&mut self, name: &str) {
        self.scoped_names.clear(name);
    }

    /// **Phase 4.6.C (W5-91):** in-place display-name update. Validation
    /// is the caller's responsibility (see `Workbook::rename_sheet` and
    /// `Workbook::validate_sheet_name`). This method is low-level and
    /// loader-only-friendly: it doesn't touch formula text, dependent
    /// names, or any cache; the runtime wrapper owns those concerns.
    pub fn set_name(&mut self, new_name: impl Into<String>) {
        self.name = new_name.into();
    }

    pub fn bounds(&self) -> Bounds {
        self.bounds
    }

    /// **M7 (6.3-2b):** the bounding box of cells whose *value* is non-blank — the
    /// **effective** value extent. Unlike [`Self::bounds`] (conservative: grows on
    /// `put(.., Blank)` and never shrinks), this tightens to the actual non-blank data, so
    /// trailing all-blank rows/cols are excluded. An empty / all-blank sheet → `Bounds::default()`.
    ///
    /// Serializer-only and purely additive — `bounds()` and its never-shrinks contract are
    /// untouched (the calcgraph / op-log / UI viewport still rely on the conservative extent).
    /// Honors the read cascade (a `Blank` overlay shadowing a non-null base reads Blank and
    /// is excluded). Note this is a VALUE extent: a cell that is value-blank but carries a
    /// format or a formula is NOT reflected here — callers that must preserve those
    /// (`.qbook` save, xlsx export) union in the format-overlay / formula positions themselves.
    pub fn effective_value_bounds(&self) -> Bounds {
        let mut max_row: Option<RowId> = None;
        let mut max_col: Option<ColId> = None;
        for (col_idx, col) in self.columns.iter().enumerate() {
            if let Some(r) = col.effective_max_row() {
                max_row = Some(max_row.map_or(r, |m| m.max(r)));
                let c = col_idx as ColId;
                max_col = Some(max_col.map_or(c, |m| m.max(c)));
            }
        }
        match (max_row, max_col) {
            (Some(r), Some(c)) => Bounds {
                row_extent: r.checked_add(1).expect("effective row extent overflow"),
                col_extent: c.checked_add(1).expect("effective col extent overflow"),
            },
            _ => Bounds::default(),
        }
    }

    /// Row count per chunk for this sheet. Used by ql-io (W5-6) to record the actual
    /// chunk layout for round-trip. Audit H5 fix (2026-05-12).
    pub fn chunk_rows(&self) -> u32 {
        self.chunk_rows
    }

    pub fn column_count(&self) -> usize {
        self.columns.len()
    }

    /// Borrow a column. None if `col` ≥ existing column count.
    pub fn column(&self, col: ColId) -> Option<&ColumnStore> {
        self.columns.get(col as usize)
    }

    /// Read a single cell. Out-of-bounds row/col reads as `Value::Blank`.
    pub fn read(&self, row: RowId, col: ColId) -> Value {
        match self.columns.get(col as usize) {
            Some(c) => c.read(row),
            None => Value::Blank,
        }
    }

    /// Write a cell. Autogrows columns as needed; updates bounds.
    ///
    /// Bound checks (opus arch F2): row/col within Excel limits; `row+1`/`col+1` use
    /// checked arithmetic to avoid u32 overflow at the boundary.
    pub fn put(&mut self, row: RowId, col: ColId, value: Value) {
        use ql_types::address::{MAX_COLUMN, MAX_ROW};
        assert!(
            row <= MAX_ROW,
            "Sheet::put: row {row} exceeds Excel max row {MAX_ROW}"
        );
        assert!(
            col <= MAX_COLUMN,
            "Sheet::put: col {col} exceeds Excel max column {MAX_COLUMN}"
        );
        let col_idx = col as usize;
        while self.columns.len() <= col_idx {
            self.columns
                .push(ColumnStore::with_chunk_rows(self.chunk_rows));
        }
        self.columns[col_idx].put(row, value);
        // Update bounds (one past max). Use checked_add to surface any boundary surprise.
        let row_extent_candidate = row
            .checked_add(1)
            .expect("Sheet::put: row+1 overflow (row == u32::MAX)");
        let col_extent_candidate = col
            .checked_add(1)
            .expect("Sheet::put: col+1 overflow (col == u32::MAX)");
        if row_extent_candidate > self.bounds.row_extent {
            self.bounds.row_extent = row_extent_candidate;
        }
        if col_extent_candidate > self.bounds.col_extent {
            self.bounds.col_extent = col_extent_candidate;
        }
    }

    /// **Phase 3.5 (2026-05-12).** Write a FORMULA-OUTPUT value to the cell's computed
    /// overlay. Mirrors `put` but routes to the computed-overlay lane; used by
    /// `WorkbookRuntime::set_formula` + `recompute_*` paths. Same bounds checks as `put`.
    pub fn put_computed(&mut self, row: RowId, col: ColId, value: Value) {
        use ql_types::address::{MAX_COLUMN, MAX_ROW};
        assert!(
            row <= MAX_ROW,
            "Sheet::put_computed: row {row} exceeds Excel max row {MAX_ROW}"
        );
        assert!(
            col <= MAX_COLUMN,
            "Sheet::put_computed: col {col} exceeds Excel max column {MAX_COLUMN}"
        );
        let col_idx = col as usize;
        while self.columns.len() <= col_idx {
            self.columns
                .push(ColumnStore::with_chunk_rows(self.chunk_rows));
        }
        self.columns[col_idx].put_computed(row, value);
        // Phase 3.5: bounds still grow on computed writes — the cell is now
        // observable through `read` even if no user-typed value lives at it.
        let row_extent_candidate = row
            .checked_add(1)
            .expect("Sheet::put_computed: row+1 overflow");
        let col_extent_candidate = col
            .checked_add(1)
            .expect("Sheet::put_computed: col+1 overflow");
        if row_extent_candidate > self.bounds.row_extent {
            self.bounds.row_extent = row_extent_candidate;
        }
        if col_extent_candidate > self.bounds.col_extent {
            self.bounds.col_extent = col_extent_candidate;
        }
    }

    /// **Phase 3.5.** Drop the cell's computed-overlay entry. Called by
    /// `Workbook::clear_formula` so a cell loses its stale formula output the moment
    /// the formula text is removed. No-op for out-of-bounds cells.
    pub fn clear_computed(&mut self, row: RowId, col: ColId) {
        if let Some(c) = self.columns.get_mut(col as usize) {
            c.clear_computed(row);
        }
    }

    /// **Phase 3.5.** Drop the cell's user-overlay entry. Called by
    /// `WorkbookRuntime::set_formula` before writing the new computed value, so a cell
    /// that's transitioning from "user-typed value" to "formula" doesn't keep its
    /// stale user value masking the new computed output via the read cascade.
    pub fn clear_user(&mut self, row: RowId, col: ColId) {
        if let Some(c) = self.columns.get_mut(col as usize) {
            c.clear_user(row);
        }
    }

    /// Append a fully-constructed column at the next column index. Used by xlsx import or
    /// bench-fixture loading.
    ///
    /// Per opus consistency N-3: the prior `column.row_count() as RowId` silently truncated
    /// u64 → u32. Excel rows fit u32 4000× over, but the cast was a latent fallback. Now uses
    /// `try_into` with `expect` so any malformed fixture (e.g. > 4.3B rows) fails visibly.
    pub fn append_column(&mut self, column: ColumnStore) {
        let col_idx: ColId = self
            .columns
            .len()
            .try_into()
            .expect("Sheet::append_column: column count exceeds ColId range");
        let row_extent: RowId = column
            .row_count()
            .try_into()
            .expect("Sheet::append_column: column row_count exceeds RowId range");
        self.columns.push(column);
        if let Some(new_col_extent) = col_idx.checked_add(1) {
            if new_col_extent > self.bounds.col_extent {
                self.bounds.col_extent = new_col_extent;
            }
        } else {
            panic!("Sheet::append_column: col_idx + 1 overflows ColId");
        }
        if row_extent > self.bounds.row_extent {
            self.bounds.row_extent = row_extent;
        }
    }

    /// **W3 (insert/delete rows & columns):** structurally shift every cell in
    /// every column along the ROW axis, then re-key the format overlay's row
    /// coordinate and recompute bounds. Cells inside a deleted block (or
    /// pushed past `MAX_ROW`) are dropped. The user/computed lane distinction
    /// is preserved (see [`ColumnStore::shift_rows`]).
    ///
    /// Bounds are recomputed from the post-shift data: unlike `put` (which
    /// grows-and-never-shrinks), a structural delete legitimately shrinks the
    /// sheet's row extent. Column count (and thus `col_extent`) is unchanged.
    pub fn shift_rows(&mut self, shift: crate::column::AxisShift) {
        for col in &mut self.columns {
            col.shift_rows(shift);
        }
        self.format_overlay
            .shift_axis(true, |r| shift.map_public(r, ql_types::MAX_ROW));
        // **FE-4 W4:** the cell-style overlay re-keys on the SAME axis or
        // styles orphan on every row insert/delete (the wave-3 overlay-orphan
        // class). MUST stay paired with the format_overlay shift above.
        self.style_overlay
            .shift_axis(true, |r| shift.map_public(r, ql_types::MAX_ROW));
        // **Wave G2:** the hidden-row set re-keys on the ROW axis too, or hidden
        // rows orphan/misalign on every row insert/delete. A row inside a deleted
        // block (`map_public -> None`) is dropped; survivors shift. MUST stay
        // paired with the overlay shifts above (same row-orphan class).
        self.hidden_rows = self
            .hidden_rows
            .iter()
            .filter_map(|&r| shift.map_public(r, ql_types::MAX_ROW))
            .collect();
        self.recompute_bounds();
    }

    /// **W3 (insert/delete rows & columns):** structurally shift columns along
    /// the COL axis by splicing the `Vec<ColumnStore>`, then re-key the format
    /// overlay's column coordinate and recompute bounds.
    ///
    /// - Insert: splice `count` fresh empty columns in at index `at`. Columns
    ///   pushed past `MAX_COLUMN` are dropped (they fall off the sheet).
    /// - Delete: remove the inclusive `[start, end]` column block.
    pub fn shift_columns(&mut self, shift: crate::column::AxisShift) {
        match shift {
            crate::column::AxisShift::Insert { at, count } => {
                let at = at as usize;
                let max_cols = ql_types::MAX_COLUMN as usize + 1;
                // **Codex L2 MED-4 closure:** cap the number of fresh columns
                // we physically splice so a huge `count` (e.g. u32::MAX) can't
                // OOM before the truncate. We never need more physical columns
                // than fit on the sheet from `at`.
                let count = (count as usize).min(max_cols.saturating_sub(at));
                if at <= self.columns.len() {
                    let fresh = (0..count).map(|_| ColumnStore::with_chunk_rows(self.chunk_rows));
                    self.columns.splice(at..at, fresh);
                }
                // Drop any existing column pushed past MAX_COLUMN.
                if self.columns.len() > max_cols {
                    self.columns.truncate(max_cols);
                }
            }
            crate::column::AxisShift::Delete { start, end } => {
                let start = start as usize;
                let end = end as usize;
                if start < self.columns.len() {
                    let stop = (end + 1).min(self.columns.len());
                    self.columns.drain(start..stop);
                }
            }
        }
        self.format_overlay
            .shift_axis(false, |c| shift.map_public(c, ql_types::MAX_COLUMN));
        // **FE-4 W4:** the cell-style overlay re-keys on the column axis too,
        // or styles orphan on every column insert/delete. MUST stay paired
        // with the format_overlay shift above.
        self.style_overlay
            .shift_axis(false, |c| shift.map_public(c, ql_types::MAX_COLUMN));
        self.recompute_bounds();
    }

    /// Recompute bounds from current column data. Used after a structural
    /// shift, which (unlike `put`'s grow-and-never-shrink contract) may shrink
    /// the extent — a row/column delete legitimately removes the bottom/right
    /// of the used region.
    ///
    /// **Codex L2 LOW-5 note (intentional):** this computes the EFFECTIVE
    /// VALUE extent (the same metric as [`Self::effective_value_bounds`]), not
    /// the conservative "ever-touched" extent. After a structural edit there is
    /// no meaningful "touched-but-blank" history to preserve — the shift
    /// rebuilds the columns — so the value extent is the correct post-edit
    /// bound for viewport sizing + the calcgraph. A cell that was `put(.., Blank)`
    /// then shifted contributes nothing to the new extent, which is the
    /// desired behavior for a structural edit.
    fn recompute_bounds(&mut self) {
        let mut max_row: Option<RowId> = None;
        for col in &self.columns {
            if let Some(r) = col.effective_max_row() {
                max_row = Some(max_row.map_or(r, |m| m.max(r)));
            }
        }
        let row_extent = max_row.map_or(0, |r| r + 1);
        // Column extent: one past the last NON-empty column. A structural
        // column delete can shrink this; an insert of empty columns does not
        // grow the effective extent (empty trailing columns carry no data).
        let mut col_extent: ColId = 0;
        for (idx, col) in self.columns.iter().enumerate() {
            if col.effective_max_row().is_some() {
                col_extent = idx as ColId + 1;
            }
        }
        self.bounds = Bounds {
            row_extent,
            col_extent,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::column::ColumnStore;
    use ql_types::ErrorValue;
    use std::sync::Arc;

    fn col_with(values: &[f64]) -> ColumnStore {
        let arr: Arc<dyn arrow_array::Array> =
            Arc::new(arrow_array::Float64Array::from(values.to_vec()));
        ColumnStore::from_chunks(values.len() as u32, vec![arr])
    }

    #[test]
    fn empty_sheet_reads_blank_everywhere() {
        let s = Sheet::new("Sheet1");
        assert_eq!(s.name(), "Sheet1");
        assert_eq!(s.column_count(), 0);
        assert_eq!(s.bounds(), Bounds::default());
        assert_eq!(s.read(0, 0), Value::Blank);
        assert_eq!(s.read(999, 999), Value::Blank);
    }

    #[test]
    fn put_grows_columns_and_bounds() {
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(5, 2, Value::Number(42.0));
        assert_eq!(s.column_count(), 3); // columns 0, 1, 2 allocated
        assert_eq!(
            s.bounds(),
            Bounds {
                row_extent: 6,
                col_extent: 3
            }
        );
        assert_eq!(s.read(5, 2), Value::Number(42.0));
        // Empty cells in the new columns:
        assert_eq!(s.read(0, 0), Value::Blank);
        assert_eq!(s.read(5, 0), Value::Blank);
    }

    #[test]
    fn append_column_updates_bounds() {
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.append_column(col_with(&[1.0, 2.0, 3.0, 4.0]));
        assert_eq!(s.column_count(), 1);
        assert_eq!(
            s.bounds(),
            Bounds {
                row_extent: 4,
                col_extent: 1
            }
        );
        s.append_column(col_with(&[10.0, 20.0]));
        assert_eq!(s.column_count(), 2);
        // row_extent grows to max
        assert_eq!(
            s.bounds(),
            Bounds {
                row_extent: 4,
                col_extent: 2
            }
        );
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        assert_eq!(s.read(1, 1), Value::Number(20.0));
        assert_eq!(s.read(2, 1), Value::Blank); // beyond short column
    }

    #[test]
    fn bounds_never_shrinks() {
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(10, 5, Value::Number(1.0));
        assert_eq!(
            s.bounds(),
            Bounds {
                row_extent: 11,
                col_extent: 6
            }
        );
        // Writing a lower-row value doesn't shrink bounds.
        s.put(0, 0, Value::Number(2.0));
        assert_eq!(
            s.bounds(),
            Bounds {
                row_extent: 11,
                col_extent: 6
            }
        );
    }

    // -- M7 (6.3-2b): effective_value_bounds -----------------------------------

    #[test]
    fn effective_value_bounds_empty_sheet_is_default() {
        let s = Sheet::with_chunk_rows("S", 4);
        assert_eq!(s.effective_value_bounds(), Bounds::default());
    }

    #[test]
    fn effective_value_bounds_single_value() {
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(5, 2, Value::Number(42.0));
        assert_eq!(
            s.effective_value_bounds(),
            Bounds {
                row_extent: 6,
                col_extent: 3
            }
        );
    }

    #[test]
    fn effective_value_bounds_shrinks_vs_bounds_on_explicit_blank() {
        // E1: a far explicit Blank grows `bounds` but NOT the effective extent.
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(0, 0, Value::Number(1.0));
        s.put(10, 5, Value::Blank);
        // Conservative bounds inflate to the far Blank…
        assert_eq!(
            s.bounds(),
            Bounds {
                row_extent: 11,
                col_extent: 6
            }
        );
        // …but the effective value extent is just the single real cell.
        assert_eq!(
            s.effective_value_bounds(),
            Bounds {
                row_extent: 1,
                col_extent: 1
            }
        );
    }

    #[test]
    fn effective_value_bounds_overlay_blank_shadows_nonnull_base() {
        // E2 (the trap): a base non-null cell shadowed by a Blank user overlay reads
        // Blank, so it must NOT count. Independent per-lane maxima would wrongly count
        // the base 4.0 at row 3.
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.append_column(col_with(&[5.0, 2.0, 3.0, 4.0])); // col 0, base rows 0..3 non-null
        s.put(3, 0, Value::Blank); // shadow the last base cell
        assert_eq!(s.read(3, 0), Value::Blank);
        // Highest non-blank effective row is 2 (value 3.0) → row_extent 3.
        assert_eq!(
            s.effective_value_bounds(),
            Bounds {
                row_extent: 3,
                col_extent: 1
            }
        );
    }

    #[test]
    fn effective_value_bounds_computed_blank_not_counted() {
        // E3: a formula cell whose computed value is Blank does not extend the value bbox…
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put_computed(7, 0, Value::Blank);
        assert_eq!(s.effective_value_bounds(), Bounds::default());
        // …but a non-blank computed value does.
        let mut s2 = Sheet::with_chunk_rows("S", 4);
        s2.put_computed(7, 0, Value::Number(1.0));
        assert_eq!(
            s2.effective_value_bounds(),
            Bounds {
                row_extent: 8,
                col_extent: 1
            }
        );
    }

    #[test]
    fn effective_value_bounds_ignores_format_only_cells() {
        // A format-bearing but value-blank cell is NOT a value cell.
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.format_overlay_mut()
            .set(9, 9, crate::FormatId::Builtin(14));
        assert_eq!(s.effective_value_bounds(), Bounds::default());
    }

    #[test]
    fn effective_value_bounds_mixed_user_computed_base_lanes() {
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(0, 2, Value::Number(7.0)); // user value, col 2
        s.put(2, 0, Value::Number(1.0)); // user value, col 0
        s.put_computed(4, 1, Value::Number(9.0)); // computed value, col 1
        assert_eq!(
            s.effective_value_bounds(),
            Bounds {
                row_extent: 5,
                col_extent: 3
            }
        );
    }

    #[test]
    fn effective_value_bounds_short_tail_overlay_beyond_base_len() {
        // E5: an overlay entry at rel >= base.len() (short last chunk) must be counted.
        let arr: Arc<dyn arrow_array::Array> =
            Arc::new(arrow_array::Float64Array::from(vec![1.0, 2.0])); // base len 2
        let col = ColumnStore::from_chunks(4, vec![arr]); // chunk_rows 4 > base len 2
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.append_column(col);
        s.put(3, 0, Value::Number(8.0)); // overlay at rel 3, beyond base.len() == 2
        assert_eq!(
            s.effective_value_bounds(),
            Bounds {
                row_extent: 4,
                col_extent: 1
            }
        );
    }

    #[test]
    fn effective_value_bounds_all_blank_allocated_column_shrinks_col_extent() {
        // E7: writing a Blank allocates intermediate columns but none carry a value →
        // col_extent shrinks to 0, not just row_extent.
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(0, 3, Value::Blank);
        assert!(s.bounds().col_extent >= 4); // columns 0..3 allocated, bounds grew
        assert_eq!(s.effective_value_bounds(), Bounds::default());
    }

    #[test]
    fn effective_value_bounds_error_value_counts() {
        // An error value is a real (non-blank) cell.
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(3, 1, Value::Error(ErrorValue::Ref));
        assert_eq!(
            s.effective_value_bounds(),
            Bounds {
                row_extent: 4,
                col_extent: 2
            }
        );
    }

    #[test]
    fn heterogeneous_writes_per_column() {
        let mut s = Sheet::with_chunk_rows("S", 4);
        s.put(0, 0, Value::Number(1.0));
        s.put(0, 1, Value::Boolean(true));
        s.put(0, 2, Value::text("hi"));
        s.put(0, 3, Value::Error(ErrorValue::Ref));
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        assert_eq!(s.read(0, 1), Value::Boolean(true));
        assert_eq!(s.read(0, 2), Value::text("hi"));
        assert_eq!(s.read(0, 3), Value::Error(ErrorValue::Ref));
    }

    // W5-92 (Phase 4.6.D) — sheet-scoped names.

    #[test]
    fn scoped_names_empty_by_default() {
        let s = Sheet::new("S");
        assert!(s.scoped_names().is_empty());
    }

    #[test]
    fn set_scoped_name_registers_canonicalized() {
        let mut s = Sheet::new("S");
        s.set_scoped_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        // Canonicalized (uppercase) on-write, matching workbook-scoped
        // NameTable behavior.
        assert!(matches!(
            s.scoped_names().lookup_ci("taxrate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        assert_eq!(s.scoped_names().len(), 1);
    }

    #[test]
    fn clear_scoped_name_removes_binding() {
        let mut s = Sheet::new("S");
        s.set_scoped_name("X", NamedTarget::Constant(Value::Number(1.0)))
            .unwrap();
        assert_eq!(s.scoped_names().len(), 1);
        s.clear_scoped_name("X");
        assert_eq!(s.scoped_names().len(), 0);
        assert!(s.scoped_names().lookup_ci("X").is_none());
    }

    #[test]
    fn set_scoped_name_reserved_name_rejected() {
        let mut s = Sheet::new("S");
        let err = s
            .set_scoped_name("AI", NamedTarget::Constant(Value::Number(42.0)))
            .unwrap_err();
        // Reserved-name guard fires on the sheet-scoped side too.
        assert!(matches!(err, crate::workbook::NameTableError::Reserved(_)));
    }

    #[test]
    fn scoped_names_independent_across_sheets() {
        let mut s1 = Sheet::new("S1");
        let mut s2 = Sheet::new("S2");
        s1.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        s2.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.10)))
            .unwrap();
        // Same name on different sheets → independent values.
        let r1 = s1.scoped_names().lookup_ci("Rate");
        let r2 = s2.scoped_names().lookup_ci("Rate");
        assert!(matches!(r1, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21));
        assert!(matches!(r2, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.10));
    }

    // ========================================================================
    // W3 (insert/delete rows & columns) — storage shift.
    // ========================================================================

    use crate::column::AxisShift;

    #[test]
    fn insert_rows_shifts_values_down() {
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.put(2, 0, Value::Number(10.0)); // A3
        s.put(5, 1, Value::Number(20.0)); // B6
        s.put(0, 0, Value::Number(1.0)); // A1 (above insert point)
        s.shift_rows(AxisShift::Insert { at: 1, count: 2 });
        // A1 unchanged (above the insert point).
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        // A3 (row 2) → row 4.
        assert_eq!(s.read(4, 0), Value::Number(10.0));
        assert_eq!(s.read(2, 0), Value::Blank);
        // B6 (row 5) → row 7.
        assert_eq!(s.read(7, 1), Value::Number(20.0));
    }

    #[test]
    fn delete_rows_removes_and_shifts_up() {
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.put(1, 0, Value::Number(2.0)); // A2 (index 1) — will be deleted
        s.put(4, 0, Value::Number(5.0)); // A5 (index 4) — shifts up by 2
        s.put(0, 0, Value::Number(1.0)); // A1 (index 0) — unchanged
        s.shift_rows(AxisShift::Delete { start: 1, end: 2 }); // delete indices 1,2
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        // A2 (index 1) gone; index 1 now reads blank.
        assert_eq!(s.read(1, 0), Value::Blank);
        // A5 (index 4) → index 2.
        assert_eq!(s.read(2, 0), Value::Number(5.0));
    }

    #[test]
    fn delete_rows_shift_math_exact() {
        let mut s = Sheet::with_chunk_rows("S", 16);
        s.put(9, 0, Value::Number(99.0)); // A10 (index 9)
        s.shift_rows(AxisShift::Delete { start: 1, end: 2 }); // delete 2 rows
                                                              // index 9 → 9 - 2 = 7.
        assert_eq!(s.read(7, 0), Value::Number(99.0));
        assert_eq!(s.read(9, 0), Value::Blank);
    }

    #[test]
    fn insert_columns_splices_blank_columns() {
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.put(0, 0, Value::Number(1.0)); // A1
        s.put(0, 1, Value::Number(2.0)); // B1
        s.shift_columns(AxisShift::Insert { at: 1, count: 1 });
        // A1 unchanged; B1 → C1; new blank column at B.
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        assert_eq!(s.read(0, 1), Value::Blank);
        assert_eq!(s.read(0, 2), Value::Number(2.0));
    }

    #[test]
    fn delete_columns_removes_block() {
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.put(0, 0, Value::Number(1.0)); // A1
        s.put(0, 1, Value::Number(2.0)); // B1 (deleted)
        s.put(0, 2, Value::Number(3.0)); // C1 (shifts to B)
        s.shift_columns(AxisShift::Delete { start: 1, end: 1 });
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        assert_eq!(s.read(0, 1), Value::Number(3.0));
        assert_eq!(s.read(0, 2), Value::Blank);
    }

    #[test]
    fn shift_rows_recomputes_bounds() {
        let mut s = Sheet::with_chunk_rows("S", 16);
        s.put(5, 0, Value::Number(1.0)); // row_extent 6
        assert_eq!(s.bounds().row_extent, 6);
        s.shift_rows(AxisShift::Delete { start: 0, end: 2 }); // remove 3 rows
                                                              // row 5 → row 2 → extent 3.
        assert_eq!(s.bounds().row_extent, 3);
    }

    #[test]
    fn shift_rows_preserves_string_values() {
        // Strings live only in the user overlay (base is Float64-only).
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.put(2, 0, Value::Text(Arc::from("hi")));
        s.shift_rows(AxisShift::Insert { at: 0, count: 1 });
        assert_eq!(s.read(3, 0), Value::Text(Arc::from("hi")));
    }

    #[test]
    fn shift_rows_rekeys_format_overlay_no_orphans() {
        use crate::FormatId;
        let mut s = Sheet::with_chunk_rows("S", 16);
        s.put(3, 0, Value::Number(1.0));
        s.format_overlay_mut().set(3, 0, FormatId::Builtin(5));
        let before = s.format_overlay().len();
        assert_eq!(before, 1);
        s.shift_rows(AxisShift::Insert { at: 0, count: 1 });
        // Entry must have moved to row 4, not orphaned at row 3.
        assert_eq!(s.format_overlay().get(4, 0), Some(FormatId::Builtin(5)));
        assert_eq!(s.format_overlay().get(3, 0), None);
        assert_eq!(s.format_overlay().len(), 1);
    }

    #[test]
    fn delete_rows_drops_format_overlay_entry_in_block() {
        use crate::FormatId;
        let mut s = Sheet::with_chunk_rows("S", 16);
        s.format_overlay_mut().set(2, 0, FormatId::Builtin(7));
        s.shift_rows(AxisShift::Delete { start: 2, end: 2 });
        // The format entry's cell was deleted → no orphan.
        assert_eq!(s.format_overlay().len(), 0);
    }

    // ===== FE-4 W4 — style overlay re-keys on row + column shifts =====

    #[test]
    fn shift_rows_rekeys_style_overlay_no_orphans() {
        use crate::StyleId;
        use ql_types::LEGACY_PEER;
        let mut s = Sheet::with_chunk_rows("S", 16);
        let sid = StyleId::new(LEGACY_PEER, 0);
        s.put(3, 0, Value::Number(1.0));
        s.style_overlay_mut().set(3, 0, sid);
        s.shift_rows(AxisShift::Insert { at: 0, count: 1 });
        // Entry must have moved to row 4, not orphaned at row 3.
        assert_eq!(s.style_overlay().get(4, 0), Some(sid));
        assert_eq!(s.style_overlay().get(3, 0), None);
        assert_eq!(s.style_overlay().len(), 1);
    }

    #[test]
    fn delete_rows_drops_style_overlay_entry_in_block() {
        use crate::StyleId;
        use ql_types::LEGACY_PEER;
        let mut s = Sheet::with_chunk_rows("S", 16);
        s.style_overlay_mut()
            .set(2, 0, StyleId::new(LEGACY_PEER, 0));
        s.shift_rows(AxisShift::Delete { start: 2, end: 2 });
        assert_eq!(s.style_overlay().len(), 0);
    }

    #[test]
    fn shift_columns_rekeys_style_overlay_no_orphans() {
        use crate::StyleId;
        use ql_types::LEGACY_PEER;
        let mut s = Sheet::with_chunk_rows("S", 16);
        let sid = StyleId::new(LEGACY_PEER, 2);
        s.style_overlay_mut().set(0, 3, sid);
        s.shift_columns(AxisShift::Insert { at: 0, count: 1 });
        assert_eq!(s.style_overlay().get(0, 4), Some(sid));
        assert_eq!(s.style_overlay().get(0, 3), None);
        assert_eq!(s.style_overlay().len(), 1);
    }

    #[test]
    fn delete_columns_drops_style_overlay_entry_in_block() {
        use crate::StyleId;
        use ql_types::LEGACY_PEER;
        let mut s = Sheet::with_chunk_rows("S", 16);
        s.style_overlay_mut()
            .set(0, 2, StyleId::new(LEGACY_PEER, 0));
        s.shift_columns(AxisShift::Delete { start: 2, end: 2 });
        assert_eq!(s.style_overlay().len(), 0);
    }

    // ===== Wave G2 (engine-filter) — hidden-row set =====

    #[test]
    fn hidden_rows_empty_by_default() {
        let s = Sheet::new("S");
        assert!(s.hidden_rows().is_empty());
        assert!(!s.is_row_hidden(0));
        assert!(!s.is_row_hidden(1_000_000));
    }

    #[test]
    fn set_row_hidden_toggles_membership() {
        let mut s = Sheet::new("S");
        s.set_row_hidden(3, true);
        s.set_row_hidden(7, true);
        assert!(s.is_row_hidden(3));
        assert!(s.is_row_hidden(7));
        assert!(!s.is_row_hidden(4));
        assert_eq!(s.hidden_rows().len(), 2);
        // Idempotent set.
        s.set_row_hidden(3, true);
        assert_eq!(s.hidden_rows().len(), 2);
        // Show clears the entry; clearing a visible row is a no-op.
        s.set_row_hidden(3, false);
        assert!(!s.is_row_hidden(3));
        s.set_row_hidden(99, false);
        assert_eq!(s.hidden_rows().len(), 1);
        assert_eq!(s.hidden_rows().iter().copied().collect::<Vec<_>>(), vec![7]);
    }

    #[test]
    fn insert_rows_shifts_hidden_rows_down() {
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.set_row_hidden(0, true); // above the insert point — stays
        s.set_row_hidden(2, true); // at/below — shifts down by 2
        s.set_row_hidden(5, true);
        s.shift_rows(AxisShift::Insert { at: 1, count: 2 });
        // 0 unchanged; 2 -> 4; 5 -> 7.
        assert_eq!(
            s.hidden_rows().iter().copied().collect::<Vec<_>>(),
            vec![0, 4, 7]
        );
    }

    #[test]
    fn delete_rows_drops_hidden_rows_in_block_and_shifts_rest() {
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.set_row_hidden(0, true); // before block — stays
        s.set_row_hidden(2, true); // inside [1,2] deleted block — dropped
        s.set_row_hidden(5, true); // after block — shifts up by 2
        s.shift_rows(AxisShift::Delete { start: 1, end: 2 });
        // 0 stays; 2 dropped; 5 -> 3.
        assert_eq!(
            s.hidden_rows().iter().copied().collect::<Vec<_>>(),
            vec![0, 3]
        );
    }

    #[test]
    fn shift_columns_leaves_hidden_rows_untouched() {
        // Hidden-rows is a ROW attribute: a COLUMN insert/delete must NOT move it.
        let mut s = Sheet::with_chunk_rows("S", 8);
        s.set_row_hidden(2, true);
        s.set_row_hidden(4, true);
        s.shift_columns(AxisShift::Insert { at: 0, count: 3 });
        s.shift_columns(AxisShift::Delete { start: 1, end: 1 });
        assert_eq!(
            s.hidden_rows().iter().copied().collect::<Vec<_>>(),
            vec![2, 4]
        );
    }
}
