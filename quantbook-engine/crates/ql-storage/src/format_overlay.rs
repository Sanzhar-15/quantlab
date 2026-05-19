//! Sparse per-sheet cell-format overlay (Phase 4.5.D part 3, W5-79).
//!
//! Cells with a non-General format live in this overlay; cells without an
//! entry render via `FormatId::GENERAL` semantics.
//!
//! Per design doc § 7.2: most cells have General format, so a per-cell
//! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
//! The sparse map keyed by `(RowId, ColId)` costs proportional to the
//! number of cells with actual custom formats — a small fraction in
//! typical workbooks.
//!
//! **V1 design choice (W5-79):** single `HashMap<(RowId, ColId),
//! FormatId>` per sheet. The design doc § 7.2 sketches a chunk-based
//! shape; benchmarking decides if that's worth the structural complexity.
//! For now, a flat map is correct + simple, and the per-sheet shape
//! mirrors how `NameTable` lives on the workbook (a flat map that scales
//! to ~50k entries without trouble).

use std::collections::HashMap;

use ql_types::{ColId, RowId};

use crate::format::FormatId;

/// Sparse per-sheet `(row, col) → FormatId` overlay.
///
/// Cells absent from the overlay render via `FormatId::GENERAL`.
#[derive(Clone, Debug, Default)]
pub struct CellFormatOverlay {
    entries: HashMap<(RowId, ColId), FormatId>,
}

impl CellFormatOverlay {
    /// Empty overlay.
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the format-id at `(row, col)`. `None` ≡ render via
    /// `FormatId::GENERAL`.
    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
        self.entries.get(&(row, col)).copied()
    }

    /// Set the format-id at `(row, col)`. Returns the prior id at that
    /// cell, if any.
    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
        self.entries.insert((row, col), id)
    }

    /// Clear the entry at `(row, col)`. Cell falls back to
    /// `FormatId::GENERAL`. Returns the cleared id, if any.
    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
        self.entries.remove(&(row, col))
    }

    /// Number of entries currently in the overlay.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True iff no cells carry a custom format.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Wipe the entire overlay.
    pub fn clear_all(&mut self) {
        self.entries.clear();
    }

    /// Iterate `((row, col), FormatId)` entries. Order is `HashMap`
    /// iteration order; persistence consumers should sort.
    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
        self.entries.iter().map(|(addr, id)| (*addr, *id))
    }

    /// Count entries that reference `id`. Used by FormatTable compaction
    /// (Phase 4.10 / GAP-F-07) to decide if an id has zero refs and can
    /// be reclaimed.
    pub fn count_refs(&self, id: FormatId) -> usize {
        self.entries.values().filter(|fid| **fid == id).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_empty() {
        let o = CellFormatOverlay::new();
        assert!(o.is_empty());
        assert_eq!(o.len(), 0);
    }

    #[test]
    fn get_miss_returns_none() {
        let o = CellFormatOverlay::new();
        assert_eq!(o.get(0, 0), None);
    }

    #[test]
    fn set_then_get() {
        let mut o = CellFormatOverlay::new();
        let id = FormatId::Builtin(14);
        assert_eq!(o.set(5, 3, id), None);
        assert_eq!(o.get(5, 3), Some(id));
    }

    #[test]
    fn set_overwrites_and_returns_prior() {
        let mut o = CellFormatOverlay::new();
        assert_eq!(o.set(5, 3, FormatId::Builtin(14)), None);
        assert_eq!(
            o.set(5, 3, FormatId::Builtin(15)),
            Some(FormatId::Builtin(14))
        );
        assert_eq!(o.get(5, 3), Some(FormatId::Builtin(15)));
    }

    #[test]
    fn clear_removes_entry() {
        let mut o = CellFormatOverlay::new();
        o.set(5, 3, FormatId::Builtin(14));
        assert_eq!(o.clear(5, 3), Some(FormatId::Builtin(14)));
        assert_eq!(o.get(5, 3), None);
    }

    #[test]
    fn clear_missing_returns_none() {
        let mut o = CellFormatOverlay::new();
        assert_eq!(o.clear(999, 999), None);
    }

    #[test]
    fn clear_all_wipes_overlay() {
        let mut o = CellFormatOverlay::new();
        o.set(0, 0, FormatId::Builtin(14));
        o.set(1, 1, FormatId::Builtin(15));
        o.clear_all();
        assert!(o.is_empty());
    }

    #[test]
    fn count_refs_returns_match_count() {
        let mut o = CellFormatOverlay::new();
        o.set(0, 0, FormatId::Builtin(14));
        o.set(0, 1, FormatId::Builtin(14));
        o.set(0, 2, FormatId::Builtin(15));
        assert_eq!(o.count_refs(FormatId::Builtin(14)), 2);
        assert_eq!(o.count_refs(FormatId::Builtin(15)), 1);
        // 999 maps to Custom(LEGACY_PEER, 835) under the new shape;
        // never registered, so count is 0.
        assert_eq!(o.count_refs(FormatId::legacy_from_u32(999)), 0);
    }

    #[test]
    fn iter_returns_all_entries() {
        let mut o = CellFormatOverlay::new();
        o.set(0, 0, FormatId::Builtin(14));
        o.set(1, 1, FormatId::Builtin(15));
        let collected: Vec<_> = o.iter().collect();
        assert_eq!(collected.len(), 2);
    }

    #[test]
    fn distinct_addresses_isolated() {
        let mut o = CellFormatOverlay::new();
        o.set(0, 0, FormatId::Builtin(14));
        o.set(0, 1, FormatId::Builtin(15));
        o.set(1, 0, FormatId::Builtin(16));
        assert_eq!(o.get(0, 0), Some(FormatId::Builtin(14)));
        assert_eq!(o.get(0, 1), Some(FormatId::Builtin(15)));
        assert_eq!(o.get(1, 0), Some(FormatId::Builtin(16)));
        assert_eq!(o.get(1, 1), None);
    }
}
