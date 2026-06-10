//! Sparse per-sheet cell-STYLE overlay (FE-4 W4, 2026-06-10).
//!
//! The cell-style analog of [`crate::CellFormatOverlay`]. Cells with a
//! non-default visual style live in this overlay keyed by `(RowId, ColId)`;
//! cells without an entry render via [`crate::Style::default()`] semantics
//! (no styling). Resolution: look up the [`crate::StyleId`] here, then call
//! `workbook.styles().lookup(id)` to get the [`crate::Style`] value.
//!
//! **V1 design choice (mirrors `CellFormatOverlay`):** a single flat
//! `HashMap<(RowId, ColId), StyleId>` per sheet — most cells are unstyled,
//! so a sparse map costs proportional to the styled-cell count. The chunked
//! shape from the format-overlay design doc is deferred until benchmarking
//! justifies the structural complexity.

use std::collections::HashMap;

use ql_types::{ColId, RowId};

use crate::style::StyleId;

/// Sparse per-sheet `(row, col) → StyleId` overlay.
///
/// Cells absent from the overlay render via [`crate::Style::default()`].
#[derive(Clone, Debug, Default)]
pub struct CellStyleOverlay {
    entries: HashMap<(RowId, ColId), StyleId>,
}

impl CellStyleOverlay {
    /// Empty overlay.
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the style-id at `(row, col)`. `None` ≡ render via
    /// [`crate::Style::default()`].
    pub fn get(&self, row: RowId, col: ColId) -> Option<StyleId> {
        self.entries.get(&(row, col)).copied()
    }

    /// Set the style-id at `(row, col)`. Returns the prior id, if any.
    pub fn set(&mut self, row: RowId, col: ColId, id: StyleId) -> Option<StyleId> {
        self.entries.insert((row, col), id)
    }

    /// Clear the entry at `(row, col)`. Cell falls back to
    /// [`crate::Style::default()`]. Returns the cleared id, if any.
    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<StyleId> {
        self.entries.remove(&(row, col))
    }

    /// Number of entries currently in the overlay.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True iff no cells carry a custom style.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Wipe the entire overlay.
    pub fn clear_all(&mut self) {
        self.entries.clear();
    }

    /// Iterate `((row, col), StyleId)` entries. `HashMap` order; persistence
    /// consumers sort.
    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), StyleId)> + '_ {
        self.entries.iter().map(|(addr, id)| (*addr, *id))
    }

    /// Count entries referencing `id` (for future StyleTable compaction).
    pub fn count_refs(&self, id: StyleId) -> usize {
        self.entries.values().filter(|sid| **sid == id).count()
    }

    /// **W3 (insert/delete rows & columns):** re-key every entry by `remap`
    /// applied to the given axis. `remap(coord)` returns the new coordinate,
    /// or `None` if the cell was deleted (its entry is DROPPED — no orphans).
    /// `is_row = true` re-keys the row coordinate; `false` re-keys the column.
    /// Rebuilds the map so collisions resolve to last-writer (impossible for a
    /// valid shift — the remap is injective on survivors). EXACT mirror of
    /// [`crate::CellFormatOverlay::shift_axis`]; called from BOTH
    /// `Sheet::shift_rows` and `Sheet::shift_columns` or styles orphan on
    /// every insert/delete.
    pub fn shift_axis(&mut self, is_row: bool, remap: impl Fn(u32) -> Option<u32>) {
        let mut next: HashMap<(RowId, ColId), StyleId> = HashMap::with_capacity(self.entries.len());
        for ((row, col), id) in self.entries.iter() {
            let new_key = if is_row {
                remap(*row).map(|r| (r, *col))
            } else {
                remap(*col).map(|c| (*row, c))
            };
            if let Some(key) = new_key {
                next.insert(key, *id);
            }
            // None → cell deleted → entry dropped (no orphan).
        }
        self.entries = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::LEGACY_PEER;

    fn sid(counter: u32) -> StyleId {
        StyleId::new(LEGACY_PEER, counter)
    }

    #[test]
    fn default_is_empty() {
        let o = CellStyleOverlay::new();
        assert!(o.is_empty());
        assert_eq!(o.len(), 0);
    }

    #[test]
    fn get_miss_returns_none() {
        let o = CellStyleOverlay::new();
        assert_eq!(o.get(0, 0), None);
    }

    #[test]
    fn set_then_get() {
        let mut o = CellStyleOverlay::new();
        assert_eq!(o.set(5, 3, sid(0)), None);
        assert_eq!(o.get(5, 3), Some(sid(0)));
    }

    #[test]
    fn set_overwrites_and_returns_prior() {
        let mut o = CellStyleOverlay::new();
        assert_eq!(o.set(5, 3, sid(0)), None);
        assert_eq!(o.set(5, 3, sid(1)), Some(sid(0)));
        assert_eq!(o.get(5, 3), Some(sid(1)));
    }

    #[test]
    fn clear_removes_entry() {
        let mut o = CellStyleOverlay::new();
        o.set(5, 3, sid(0));
        assert_eq!(o.clear(5, 3), Some(sid(0)));
        assert_eq!(o.get(5, 3), None);
    }

    #[test]
    fn clear_missing_returns_none() {
        let mut o = CellStyleOverlay::new();
        assert_eq!(o.clear(999, 999), None);
    }

    #[test]
    fn count_refs_returns_match_count() {
        let mut o = CellStyleOverlay::new();
        o.set(0, 0, sid(0));
        o.set(0, 1, sid(0));
        o.set(0, 2, sid(1));
        assert_eq!(o.count_refs(sid(0)), 2);
        assert_eq!(o.count_refs(sid(1)), 1);
        assert_eq!(o.count_refs(sid(9)), 0);
    }

    #[test]
    fn shift_axis_rekeys_rows_no_orphans() {
        let mut o = CellStyleOverlay::new();
        o.set(3, 0, sid(0));
        // Insert 1 row at 0 → row 3 becomes row 4.
        o.shift_axis(true, |r| Some(r + 1));
        assert_eq!(o.get(4, 0), Some(sid(0)));
        assert_eq!(o.get(3, 0), None);
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn shift_axis_drops_deleted() {
        let mut o = CellStyleOverlay::new();
        o.set(2, 0, sid(7));
        // Delete row 2 → maps to None → dropped.
        o.shift_axis(true, |r| if r == 2 { None } else { Some(r) });
        assert!(o.is_empty());
    }

    #[test]
    fn distinct_addresses_isolated() {
        let mut o = CellStyleOverlay::new();
        o.set(0, 0, sid(0));
        o.set(0, 1, sid(1));
        o.set(1, 0, sid(2));
        assert_eq!(o.get(0, 0), Some(sid(0)));
        assert_eq!(o.get(0, 1), Some(sid(1)));
        assert_eq!(o.get(1, 0), Some(sid(2)));
        assert_eq!(o.get(1, 1), None);
    }
}
