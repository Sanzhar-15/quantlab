//! `SparseOverlay` — per-chunk sparse edit buffer that takes precedence over the base
//! Arrow chunk on read.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - One overlay per chunk; index is row-within-chunk (0..chunk_rows), NOT absolute row.
//! - Append-only writes — repeated writes to the same row overwrite the prior value
//!   (BTreeMap semantics); the overlay is not log-shaped, it's a small index.
//! - Periodic compaction (caller-driven) re-materializes overlay+base into a new chunk and
//!   resets the overlay to empty.
//! - Read merge: overlay-first, base-fallback. The base chunk is owned by the parent
//!   `ColumnStore` and is never mutated.

use std::collections::BTreeMap;

use ql_types::{RowId, Value};

/// Per-chunk sparse overlay. Keys are row offsets *within the chunk* (0-indexed).
#[derive(Clone, Debug, Default)]
pub struct SparseOverlay {
    entries: BTreeMap<RowId, Value>,
}

impl SparseOverlay {
    /// New empty overlay.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or overwrite `value` at chunk-relative row `rel_row`.
    /// Returns the prior value at that row, if any.
    pub fn put(&mut self, rel_row: RowId, value: Value) -> Option<Value> {
        self.entries.insert(rel_row, value)
    }

    /// Read the overlay value at `rel_row`, or `None` if no overlay edit covers it.
    /// The caller (column_store) consults the base chunk on `None`.
    pub fn get(&self, rel_row: RowId) -> Option<&Value> {
        self.entries.get(&rel_row)
    }

    /// Remove an overlay entry, returning the prior value if any. A removed entry means the
    /// chunk's base value is what reads will see.
    pub fn remove(&mut self, rel_row: RowId) -> Option<Value> {
        self.entries.remove(&rel_row)
    }

    /// Number of overlay edits currently held.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True iff there are no overlay edits.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Clear all overlay edits — typically called after a chunk-replace compaction.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Iterate `(rel_row, &Value)` in ascending row order. Useful for compaction.
    pub fn iter(&self) -> impl Iterator<Item = (RowId, &Value)> {
        self.entries.iter().map(|(r, v)| (*r, v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::ErrorValue;

    #[test]
    fn default_is_empty() {
        let o = SparseOverlay::new();
        assert!(o.is_empty());
        assert_eq!(o.len(), 0);
    }

    #[test]
    fn put_then_get() {
        let mut o = SparseOverlay::new();
        assert_eq!(o.put(5, Value::Number(42.0)), None);
        assert_eq!(o.get(5), Some(&Value::Number(42.0)));
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn get_miss_returns_none() {
        let mut o = SparseOverlay::new();
        o.put(5, Value::Number(1.0));
        assert_eq!(o.get(6), None);
        assert_eq!(o.get(4), None);
    }

    #[test]
    fn put_overwrites_returns_prior() {
        let mut o = SparseOverlay::new();
        assert_eq!(o.put(5, Value::Number(1.0)), None);
        assert_eq!(o.put(5, Value::Number(2.0)), Some(Value::Number(1.0)));
        assert_eq!(o.get(5), Some(&Value::Number(2.0)));
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn remove_clears_entry() {
        let mut o = SparseOverlay::new();
        o.put(5, Value::Number(42.0));
        assert_eq!(o.remove(5), Some(Value::Number(42.0)));
        assert_eq!(o.get(5), None);
        assert!(o.is_empty());
    }

    #[test]
    fn remove_missing_returns_none() {
        let mut o = SparseOverlay::new();
        assert_eq!(o.remove(999), None);
    }

    #[test]
    fn clear_resets_to_empty() {
        let mut o = SparseOverlay::new();
        for r in 0..10 {
            o.put(r, Value::Number(r as f64));
        }
        o.clear();
        assert!(o.is_empty());
    }

    #[test]
    fn iter_returns_ascending_rows() {
        let mut o = SparseOverlay::new();
        // Insert out of order; iteration should sort.
        o.put(5, Value::Number(5.0));
        o.put(1, Value::Number(1.0));
        o.put(3, Value::Number(3.0));
        let rows: Vec<RowId> = o.iter().map(|(r, _)| r).collect();
        assert_eq!(rows, vec![1, 3, 5]);
    }

    #[test]
    fn heterogeneous_values_allowed() {
        // Excel allows mixed types in a column at the cell level — overlay must support it
        // even though the base chunk is type-homogeneous (Float64Array).
        let mut o = SparseOverlay::new();
        o.put(0, Value::Number(1.0));
        o.put(1, Value::text("hello"));
        o.put(2, Value::Boolean(true));
        o.put(3, Value::Error(ErrorValue::Ref));
        o.put(4, Value::Blank);
        assert_eq!(o.get(0), Some(&Value::Number(1.0)));
        assert_eq!(o.get(1), Some(&Value::text("hello")));
        assert_eq!(o.get(2), Some(&Value::Boolean(true)));
        assert_eq!(o.get(3), Some(&Value::Error(ErrorValue::Ref)));
        assert_eq!(o.get(4), Some(&Value::Blank));
    }
}
