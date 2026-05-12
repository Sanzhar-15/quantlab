//! Range-aggregate cache for Engine Phase 3.6 (W5-39, 2026-05-12) — AGG-3-01..04.
//!
//! Caches the result of aggregate-over-named-range evaluations (`SUM(Sales)`,
//! `AVERAGE(Discount)`, etc.) so a subsequent recompute that didn't touch any
//! cell inside the range returns the cached value instead of re-scanning every
//! cell in the range. This is the V1 of the spec's "aggregate cache nodes"
//! concept — cache lives at the session level, not on Graph nodes.
//!
//! ## Cache shape
//!
//! Keyed by `(range, function_name)`:
//! - `range: ql_types::Range` — the resolved range (sheet + start/end row+col).
//! - `function_name: Arc<str>` — canonical uppercase function name (`"SUM"`,
//!   `"AVERAGE"`, etc.). Matches what the parser produces.
//!
//! Stored: `ql_types::Value` — the aggregate's evaluated result.
//!
//! ## Invalidation (AGG-3-02)
//!
//! `invalidate_at(sheet, row, col)` drops every cache entry whose range
//! contains the cell. Called by `CalcgraphSession::mark_dirty_from_cell_write`
//! so the dirty-propagation pass and the cache invalidation pass run together.
//! Precision is exact — a write outside any cached range is a no-op.
//!
//! ## Hit/miss instrumentation
//!
//! `stats()` returns `(hits, misses)` counts since session construction.
//! Tests use this to prove AGG-3-01 (no rescan on unrelated writes): after
//! an unrelated write + recompute_dirty, the hit count goes up by 1.
//!
//! ## Interior mutability
//!
//! The scalar evaluator takes `&dyn AggregateCache` (immutable reference); the
//! cache uses `RefCell<HashMap<...>>` internally so a fresh `store` happens
//! during evaluation without needing `&mut`. The runtime borrows the session's
//! cache mutably between recomputes (e.g. during invalidation); the borrow
//! windows don't overlap so RefCell never panics.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use ql_types::{ColId, Range, RowId, SheetId, Value};

/// Read/write API the scalar evaluator and the runtime see. Two impls in
/// this module: [`NoAggregateCache`] (no-op) and [`InMemAggregateCache`]
/// (HashMap-backed, owned by `CalcgraphSession`).
pub trait AggregateCache {
    /// Return the cached aggregate value for `(range, fn_name)` if present.
    /// `None` means the caller MUST compute the value (and ideally call
    /// `store_aggregate` after).
    fn lookup_aggregate(&self, range: Range, fn_name: &str) -> Option<Value>;

    /// Store the freshly-computed `value`. Subsequent calls to
    /// `lookup_aggregate` with the same key return `Some(value)` until
    /// `invalidate_at` drops the entry (or `clear_all` wipes everything).
    fn store_aggregate(&self, range: Range, fn_name: &str, value: Value);
}

/// Default zero-cost no-op implementation. Useful for the legacy
/// `eval_scalar_with_registry` entry point that doesn't have a session
/// handy. Every lookup misses; every store is silently dropped.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoAggregateCache;

impl AggregateCache for NoAggregateCache {
    fn lookup_aggregate(&self, _range: Range, _fn_name: &str) -> Option<Value> {
        None
    }
    fn store_aggregate(&self, _range: Range, _fn_name: &str, _value: Value) {}
}

/// HashMap-backed real cache, owned by `CalcgraphSession`. Phase 3.6 V1.
///
/// Hit/miss counters are `RefCell<(u64, u64)>` for symmetric interior
/// mutability with the entry map. Wrap-on-overflow via `saturating_add`.
#[derive(Debug, Default)]
pub struct InMemAggregateCache {
    entries: RefCell<HashMap<(Range, Arc<str>), Value>>,
    stats: RefCell<AggregateCacheStats>,
}

/// Observability counters. Snapshotted by `InMemAggregateCache::stats()`;
/// the tests use these to prove AGG-3-01 (no rescan on unrelated writes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AggregateCacheStats {
    pub hits: u64,
    pub misses: u64,
    /// Cumulative entries dropped by `invalidate_at` since construction.
    /// Used to verify AGG-3-02 (intersecting write invalidates).
    pub invalidations: u64,
}

impl InMemAggregateCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read-only snapshot of the counters. Lock-free (clones the inner
    /// struct out of the RefCell).
    pub fn stats(&self) -> AggregateCacheStats {
        *self.stats.borrow()
    }

    /// Number of cached entries right now. Test introspection only.
    pub fn entry_count(&self) -> usize {
        self.entries.borrow().len()
    }

    /// AGG-3-02 invalidation hook. Drops every cache entry whose range
    /// contains `(sheet, row, col)`. Called by `CalcgraphSession::
    /// mark_dirty_from_cell_write` once per cell write so the cache
    /// stays coherent with the dirty set.
    ///
    /// Precision is exact: a write outside every cached range is a
    /// no-op (no allocation, no hash work beyond the `retain` scan).
    pub fn invalidate_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        let mut entries = self.entries.borrow_mut();
        let mut stats = self.stats.borrow_mut();
        let before = entries.len();
        entries.retain(|(range, _), _| {
            !(range.sheet == sheet
                && row >= range.start_row
                && row <= range.end_row
                && col >= range.start_col
                && col <= range.end_col)
        });
        let removed = (before - entries.len()) as u64;
        stats.invalidations = stats.invalidations.saturating_add(removed);
    }

    /// Drop every cached entry. Used by `CalcgraphSession::rebuild_from_workbook`
    /// — a fresh rebuild starts with no cached aggregates (every formula
    /// will recompute from scratch).
    pub fn clear_all(&mut self) {
        self.entries.borrow_mut().clear();
        // Stats stay — they're cumulative across rebuilds, useful for
        // long-running diagnostics.
    }
}

impl AggregateCache for InMemAggregateCache {
    fn lookup_aggregate(&self, range: Range, fn_name: &str) -> Option<Value> {
        let key = (range, Arc::<str>::from(fn_name));
        let entries = self.entries.borrow();
        let hit = entries.get(&key);
        let mut stats = self.stats.borrow_mut();
        match hit {
            Some(v) => {
                stats.hits = stats.hits.saturating_add(1);
                Some(v.clone())
            }
            None => {
                stats.misses = stats.misses.saturating_add(1);
                None
            }
        }
    }

    fn store_aggregate(&self, range: Range, fn_name: &str, value: Value) {
        let key = (range, Arc::<str>::from(fn_name));
        self.entries.borrow_mut().insert(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_range(sheet: SheetId, sr: RowId, sc: ColId, er: RowId, ec: ColId) -> Range {
        Range {
            sheet,
            start_row: sr,
            start_col: sc,
            end_row: er,
            end_col: ec,
        }
    }

    #[test]
    fn no_cache_always_misses() {
        let c = NoAggregateCache;
        let r = mk_range(0, 0, 0, 10, 0);
        assert_eq!(c.lookup_aggregate(r, "SUM"), None);
        // store is a no-op.
        c.store_aggregate(r, "SUM", Value::Number(42.0));
        assert_eq!(c.lookup_aggregate(r, "SUM"), None);
    }

    #[test]
    fn store_then_lookup_hits() {
        let c = InMemAggregateCache::new();
        let r = mk_range(0, 0, 0, 10, 0);
        assert_eq!(c.lookup_aggregate(r, "SUM"), None);
        c.store_aggregate(r, "SUM", Value::Number(55.0));
        assert_eq!(c.lookup_aggregate(r, "SUM"), Some(Value::Number(55.0)));
        let s = c.stats();
        assert_eq!(s.hits, 1);
        assert_eq!(s.misses, 1);
    }

    #[test]
    fn different_function_names_are_separate_entries() {
        let c = InMemAggregateCache::new();
        let r = mk_range(0, 0, 0, 10, 0);
        c.store_aggregate(r, "SUM", Value::Number(100.0));
        c.store_aggregate(r, "AVERAGE", Value::Number(10.0));
        assert_eq!(c.lookup_aggregate(r, "SUM"), Some(Value::Number(100.0)));
        assert_eq!(c.lookup_aggregate(r, "AVERAGE"), Some(Value::Number(10.0)));
        assert_eq!(c.entry_count(), 2);
    }

    #[test]
    fn invalidate_at_drops_entry_when_cell_in_range() {
        let mut c = InMemAggregateCache::new();
        let r = mk_range(0, 0, 0, 10, 0);
        c.store_aggregate(r, "SUM", Value::Number(55.0));
        c.invalidate_at(0, 5, 0);
        assert_eq!(c.lookup_aggregate(r, "SUM"), None);
        assert_eq!(c.stats().invalidations, 1);
    }

    #[test]
    fn invalidate_at_skips_entry_when_cell_outside_range() {
        let mut c = InMemAggregateCache::new();
        let r = mk_range(0, 0, 0, 10, 0); // A1:A11
        c.store_aggregate(r, "SUM", Value::Number(55.0));
        // Row 500 - outside the range.
        c.invalidate_at(0, 500, 0);
        assert_eq!(c.lookup_aggregate(r, "SUM"), Some(Value::Number(55.0)));
        // Column 1 - outside (range is col 0 only).
        c.invalidate_at(0, 5, 1);
        assert_eq!(c.lookup_aggregate(r, "SUM"), Some(Value::Number(55.0)));
        // Different sheet - outside.
        c.invalidate_at(1, 5, 0);
        assert_eq!(c.lookup_aggregate(r, "SUM"), Some(Value::Number(55.0)));
        assert_eq!(c.stats().invalidations, 0);
    }

    #[test]
    fn invalidate_at_drops_multiple_overlapping_entries() {
        let mut c = InMemAggregateCache::new();
        let r1 = mk_range(0, 0, 0, 10, 0); // A1:A11
        let r2 = mk_range(0, 0, 0, 5, 5); // A1:F6
        let r3 = mk_range(0, 100, 0, 200, 0); // A101:A201
        c.store_aggregate(r1, "SUM", Value::Number(1.0));
        c.store_aggregate(r2, "SUM", Value::Number(2.0));
        c.store_aggregate(r3, "SUM", Value::Number(3.0));
        // (0, 3, 0) — inside r1 + r2, outside r3.
        c.invalidate_at(0, 3, 0);
        assert_eq!(c.lookup_aggregate(r1, "SUM"), None);
        assert_eq!(c.lookup_aggregate(r2, "SUM"), None);
        assert_eq!(c.lookup_aggregate(r3, "SUM"), Some(Value::Number(3.0)));
        assert_eq!(c.stats().invalidations, 2);
    }

    #[test]
    fn clear_all_drops_everything_keeps_stats() {
        let mut c = InMemAggregateCache::new();
        let r = mk_range(0, 0, 0, 10, 0);
        c.store_aggregate(r, "SUM", Value::Number(55.0));
        let _ = c.lookup_aggregate(r, "SUM"); // hit
        c.clear_all();
        assert_eq!(c.entry_count(), 0);
        assert_eq!(c.lookup_aggregate(r, "SUM"), None);
        let s = c.stats();
        // hits/misses kept across clears (cumulative observability).
        assert_eq!(s.hits, 1);
        // The miss from the post-clear lookup adds 1.
        assert_eq!(s.misses, 1);
    }
}
