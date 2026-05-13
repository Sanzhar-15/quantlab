//! Stripe index — `(sheet, axis, index) → set of dependent NodeIds`. The A5 acceptance
//! piece: given a cell-coordinate write, find all formulas that reference a range
//! containing that cell, in time proportional to the number of distinct stripes touched
//! (not the number of formulas).
//!
//! ## Pattern (CORR-21)
//!
//! Per the Week 3 Day 0 reference deep-read (`docs/phase0/references-reading-log.md`),
//! Formualizer's `engine/graph/range_deps.rs:36-192` is the closest precedent. The
//! pattern:
//!
//! - `StripeKey { sheet_id, stripe_type: Row | Column, index: u32 }`.
//! - `stripe_to_dependents: HashMap<StripeKey, HashSet<NodeId>>`.
//! - At range registration, a **shape heuristic** picks the cheaper axis to index along:
//!   `if height > width → Column stripes`, `else → Row stripes`. So `SUM(A:A)` registers
//!   ONE Column-stripe entry (col 0); `SUM(A1:A1000)` also ONE Column entry; `SUM(A1:Z1)`
//!   ONE Row entry. A range `A1:Z1000` with height==width=tie goes to Row stripes (the
//!   `else` branch).
//!
//! We intentionally **skip** Formualizer's optional 256×256 Block stripes for Phase 0.
//! They add a third stripe axis only when `enable_block_stripes` is set AND the range
//! is 2D; the A5 falsifier doesn't need them. Revisit in Week 4 if A1 acceptance
//! reveals 2D-region perf cliffs.
//!
//! ## Precision-check requirement
//!
//! The stripe map is **coarser** than the range. `SUM(A1:A10)` registers under Column 0,
//! but a write to `A500` would falsely match. Callers MUST cross-check each candidate
//! returned by `dependents_for_cell` against the formula's actual `RangeRef` (stored on
//! `Graph::formula_to_range_deps`) before considering it a true dependent.
//!
//! `Graph::dependents_for_cell` (added in this commit) wraps both steps.

use std::collections::{HashMap, HashSet};

use ql_formula_syntax::RangeRef;
use ql_types::{ColId, RowId, SheetId};

use crate::node::NodeId;

/// Axis discriminator for `StripeKey`. Phase 0 has only Row and Column; Block is
/// deferred (see module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StripeType {
    Row,
    Column,
}

/// A single stripe identifier: `(sheet, axis, index)`. For `StripeType::Row`, `index` is
/// a `RowId`; for `StripeType::Column`, a `ColId`. Stored as `u32` since both type-alias
/// to `u32` upstream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StripeKey {
    pub sheet_id: SheetId,
    pub stripe_type: StripeType,
    pub index: u32,
}

/// Sparse per-stripe index of which formulas depend on each stripe.
///
/// Use via `Graph::register_range_dependency` and `Graph::dependents_for_cell` — those
/// wrap the stripe insertion and precision-check together.
///
/// ## Reverse index (Phase 4 / W5-50)
///
/// `formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>` records, per formula
/// node, every stripe key it has been registered against. Used by
/// `clear_for_formula` to revoke a formula's stripe membership on re-bind in
/// O(stripes-this-formula-is-in) instead of scanning the whole stripe map. The
/// reverse vector is append-on-newly-inserted (matches the forward
/// `HashSet::insert` returning `true`), so a re-registration of the same
/// `(formula, range)` does not duplicate the reverse entry.
#[derive(Clone, Debug, Default)]
pub struct StripeIndex {
    stripe_to_dependents: HashMap<StripeKey, HashSet<NodeId>>,
    /// Reverse lookup: which stripes does `formula_node` appear in? Mirror of
    /// `stripe_to_dependents` keyed by formula. Kept in lock-step with the
    /// forward map via the `insert` helper.
    formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>,
}

impl StripeIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Distinct stripe keys present in the map. Used by tests + W3-7 graph-profile export.
    pub fn stripe_count(&self) -> usize {
        self.stripe_to_dependents.len()
    }

    /// Total `(stripe_key, formula_node)` insertions across all stripes. The A5 acceptance
    /// test asserts this scales linearly with formula count (1 insert per formula via the
    /// shape heuristic), NOT with range size.
    pub fn total_insertions(&self) -> usize {
        self.stripe_to_dependents.values().map(|s| s.len()).sum()
    }

    /// Test-only read access for A4 structural assertions (CORR-24 typed accessor pattern).
    #[cfg(test)]
    pub(crate) fn raw_map(&self) -> &HashMap<StripeKey, HashSet<NodeId>> {
        &self.stripe_to_dependents
    }

    /// Register `formula_node`'s dependency on `range`. Picks the cheaper-to-index axis
    /// via the shape heuristic; inserts one entry per touched stripe index along that
    /// axis. Resolves the `RangeRef`'s optional sheet to `sheet_id` if `None`.
    ///
    /// **Panics** if the `range` has reversed bounds (start > end on any axis). Per the
    /// no-fallbacks rule (audit finding H1, 2026-05-12): malformed ranges previously
    /// silently no-op'd the stripe insert because `for c in start..=end` is an empty
    /// range when `start > end`. The formula would have appeared registered (entry in
    /// `formula_to_range_deps`) but be unreachable via writes — silent dependency loss.
    /// Now: loud panic at the boundary. Caller is responsible for normalizing before
    /// calling.
    pub fn register(&mut self, formula_node: NodeId, range: &RangeRef, sheet_id: SheetId) {
        match range {
            RangeRef::Cells {
                sheet,
                start_col,
                start_row,
                end_col,
                end_row,
                ..
            } => {
                assert!(
                    start_col <= end_col,
                    "StripeIndex::register: Cells range has reversed cols (start_col={start_col} > end_col={end_col})"
                );
                assert!(
                    start_row <= end_row,
                    "StripeIndex::register: Cells range has reversed rows (start_row={start_row} > end_row={end_row})"
                );
                let s = sheet.unwrap_or(sheet_id);
                let height = end_row - start_row + 1;
                let width = end_col - start_col + 1;
                if height > width {
                    for c in *start_col..=*end_col {
                        self.insert(
                            StripeKey {
                                sheet_id: s,
                                stripe_type: StripeType::Column,
                                index: c,
                            },
                            formula_node,
                        );
                    }
                } else {
                    for r in *start_row..=*end_row {
                        self.insert(
                            StripeKey {
                                sheet_id: s,
                                stripe_type: StripeType::Row,
                                index: r,
                            },
                            formula_node,
                        );
                    }
                }
            }
            RangeRef::WholeColumn {
                sheet,
                start_col,
                end_col,
                ..
            } => {
                assert!(
                    start_col <= end_col,
                    "StripeIndex::register: WholeColumn has reversed cols (start_col={start_col} > end_col={end_col})"
                );
                let s = sheet.unwrap_or(sheet_id);
                for c in *start_col..=*end_col {
                    self.insert(
                        StripeKey {
                            sheet_id: s,
                            stripe_type: StripeType::Column,
                            index: c,
                        },
                        formula_node,
                    );
                }
            }
            RangeRef::WholeRow {
                sheet,
                start_row,
                end_row,
                ..
            } => {
                assert!(
                    start_row <= end_row,
                    "StripeIndex::register: WholeRow has reversed rows (start_row={start_row} > end_row={end_row})"
                );
                let s = sheet.unwrap_or(sheet_id);
                for r in *start_row..=*end_row {
                    self.insert(
                        StripeKey {
                            sheet_id: s,
                            stripe_type: StripeType::Row,
                            index: r,
                        },
                        formula_node,
                    );
                }
            }
        }
    }

    fn insert(&mut self, key: StripeKey, formula_node: NodeId) {
        let newly_inserted = self
            .stripe_to_dependents
            .entry(key)
            .or_default()
            .insert(formula_node);
        // Mirror into the reverse index ONLY when the forward HashSet
        // accepted the entry as new. Re-registering the same
        // `(formula, range)` is a no-op on both sides — the original A5
        // stripe-inserts counter semantics rely on this.
        if newly_inserted {
            self.formula_to_stripe_keys
                .entry(formula_node)
                .or_default()
                .push(key);
        }
    }

    /// Revoke every stripe membership held by `formula_node`. Called by
    /// `Graph::clear_range_deps_for_formula` on re-bind so a formula whose
    /// range deps changed (`SUM(A:A) → SUM(B:B)`) no longer falsely dirty
    /// from writes to the OLD range.
    ///
    /// O(stripes-this-formula-is-in) thanks to the reverse index. A
    /// formula with no stripe membership (e.g., one that never called
    /// `register_range_dependency`) is a no-op.
    ///
    /// Empties stripe buckets are pruned: if `formula_node` was the last
    /// dependent on a stripe, the `StripeKey` entry is removed entirely.
    /// This keeps `stripe_count()` honest.
    ///
    /// Idempotent: calling twice on the same node yields the same final
    /// state.
    pub fn clear_for_formula(&mut self, formula_node: NodeId) {
        let Some(keys) = self.formula_to_stripe_keys.remove(&formula_node) else {
            return;
        };
        for key in keys {
            if let Some(set) = self.stripe_to_dependents.get_mut(&key) {
                set.remove(&formula_node);
                if set.is_empty() {
                    self.stripe_to_dependents.remove(&key);
                }
            }
        }
    }

    /// Test-only typed accessor for the reverse index (CORR-24 pattern).
    /// Returns the list of stripe keys the formula appears under, or
    /// `None` if it's never been registered.
    #[cfg(test)]
    pub(crate) fn stripe_keys_for_formula(&self, formula_node: NodeId) -> Option<&Vec<StripeKey>> {
        self.formula_to_stripe_keys.get(&formula_node)
    }

    /// Candidate dependents for a cell write at `(sheet, row, col)`. Returns the union of
    /// the Row-stripe-at-row and Column-stripe-at-col bucket contents. **Coarse**:
    /// candidates must be precision-checked against their `formula_to_range_deps` to
    /// drop false positives. `Graph::dependents_for_cell` performs the precision check.
    pub fn candidates_for_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> HashSet<NodeId> {
        let mut out = HashSet::new();
        let row_key = StripeKey {
            sheet_id: sheet,
            stripe_type: StripeType::Row,
            index: row,
        };
        if let Some(deps) = self.stripe_to_dependents.get(&row_key) {
            out.extend(deps.iter().copied());
        }
        let col_key = StripeKey {
            sheet_id: sheet,
            stripe_type: StripeType::Column,
            index: col,
        };
        if let Some(deps) = self.stripe_to_dependents.get(&col_key) {
            out.extend(deps.iter().copied());
        }
        out
    }
}

/// Test whether `range` (sheet-resolved) contains the cell at `(row, col)`. The sheet
/// check is implicit (caller already filtered by sheet via the stripe key); this only
/// validates row/col bounds.
///
/// Public (W5-50) so the Phase 3 runtime can reuse it when building the
/// supplemental adjacency for `topo::schedule_with_supplemental`.
pub fn range_contains_rowcol(range: &RangeRef, row: RowId, col: ColId) -> bool {
    match range {
        RangeRef::Cells {
            start_col,
            start_row,
            end_col,
            end_row,
            ..
        } => row >= *start_row && row <= *end_row && col >= *start_col && col <= *end_col,
        RangeRef::WholeColumn {
            start_col, end_col, ..
        } => col >= *start_col && col <= *end_col,
        RangeRef::WholeRow {
            start_row, end_row, ..
        } => row >= *start_row && row <= *end_row,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(start_col: u32, start_row: u32, end_col: u32, end_row: u32) -> RangeRef {
        RangeRef::Cells {
            sheet: None,
            start_col,
            start_row,
            end_col,
            end_row,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        }
    }

    fn whole_col(start: u32, end: u32) -> RangeRef {
        RangeRef::WholeColumn {
            sheet: None,
            start_col: start,
            end_col: end,
            abs_start: false,
            abs_end: false,
        }
    }

    fn whole_row(start: u32, end: u32) -> RangeRef {
        RangeRef::WholeRow {
            sheet: None,
            start_row: start,
            end_row: end,
            abs_start: false,
            abs_end: false,
        }
    }

    #[test]
    fn empty_index_zero_stripes() {
        let idx = StripeIndex::new();
        assert_eq!(idx.stripe_count(), 0);
        assert_eq!(idx.total_insertions(), 0);
    }

    #[test]
    fn whole_column_registers_one_column_stripe() {
        // A:A → 1 Column stripe at col 0.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &whole_col(0, 0), 0);
        assert_eq!(idx.stripe_count(), 1);
        assert_eq!(idx.total_insertions(), 1);
        let candidates = idx.candidates_for_cell(0, 500, 0);
        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
    }

    #[test]
    fn whole_row_registers_one_row_stripe() {
        // 1:1 → 1 Row stripe at row 0.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &whole_row(0, 0), 0);
        assert_eq!(idx.stripe_count(), 1);
        let candidates = idx.candidates_for_cell(0, 0, 99);
        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
    }

    #[test]
    fn tall_cells_range_uses_column_stripes() {
        // A1:A1000 (height=1000, width=1, h>w) → 1 Column stripe at col 0.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &cells(0, 0, 0, 999), 0);
        assert_eq!(idx.stripe_count(), 1);
        assert_eq!(idx.total_insertions(), 1);
        let candidates = idx.candidates_for_cell(0, 500, 0);
        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
    }

    #[test]
    fn wide_cells_range_uses_row_stripes() {
        // A1:Z1 (height=1, width=26, h<=w) → 1 Row stripe at row 0.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &cells(0, 0, 25, 0), 0);
        assert_eq!(idx.stripe_count(), 1);
        assert_eq!(idx.total_insertions(), 1);
        let candidates = idx.candidates_for_cell(0, 0, 13);
        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
    }

    #[test]
    fn square_cells_range_ties_to_row_stripes() {
        // A1:B2 (height=2, width=2, h==w → else branch) → 2 Row stripes (rows 0 and 1).
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &cells(0, 0, 1, 1), 0);
        assert_eq!(idx.stripe_count(), 2);
        assert_eq!(idx.total_insertions(), 2);
        // Both rows 0 and 1 should find the formula
        assert_eq!(
            idx.candidates_for_cell(0, 0, 0),
            [NodeId(1)].into_iter().collect()
        );
        assert_eq!(
            idx.candidates_for_cell(0, 1, 0),
            [NodeId(1)].into_iter().collect()
        );
        // Row 2 is outside the range
        assert!(idx.candidates_for_cell(0, 2, 0).is_empty());
    }

    #[test]
    fn whole_column_spans_multiple_cols() {
        // A:C → 3 Column stripes at cols 0, 1, 2.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &whole_col(0, 2), 0);
        assert_eq!(idx.stripe_count(), 3);
        assert_eq!(idx.total_insertions(), 3);
        for col in 0..=2 {
            assert_eq!(
                idx.candidates_for_cell(0, 100, col),
                [NodeId(1)].into_iter().collect()
            );
        }
        assert!(idx.candidates_for_cell(0, 100, 3).is_empty());
    }

    #[test]
    fn many_formulas_one_stripe_bucket() {
        // The A5 motivation: 100 formulas all referencing A:A share the SINGLE Column-0
        // stripe — total stripe entries stay at 1 regardless of formula count.
        let mut idx = StripeIndex::new();
        for i in 1..=100u32 {
            idx.register(NodeId(i), &whole_col(0, 0), 0);
        }
        assert_eq!(idx.stripe_count(), 1);
        assert_eq!(idx.total_insertions(), 100);
        let candidates = idx.candidates_for_cell(0, 500, 0);
        assert_eq!(candidates.len(), 100);
    }

    #[test]
    fn cross_sheet_isolation() {
        // Same range registered on two different sheets → 2 stripe entries (different
        // sheet_ids). Cell write on sheet 0 doesn't match sheet 1 formula.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &whole_col(0, 0), 0);
        idx.register(NodeId(2), &whole_col(0, 0), 1);
        assert_eq!(idx.stripe_count(), 2);
        assert_eq!(
            idx.candidates_for_cell(0, 500, 0),
            [NodeId(1)].into_iter().collect()
        );
        assert_eq!(
            idx.candidates_for_cell(1, 500, 0),
            [NodeId(2)].into_iter().collect()
        );
    }

    #[test]
    fn range_contains_rowcol_for_cells_variant() {
        let r = cells(0, 0, 1, 9); // A1:B10
        assert!(range_contains_rowcol(&r, 0, 0));
        assert!(range_contains_rowcol(&r, 5, 1));
        assert!(range_contains_rowcol(&r, 9, 1));
        assert!(!range_contains_rowcol(&r, 10, 0)); // beyond end_row
        assert!(!range_contains_rowcol(&r, 0, 2)); // beyond end_col
    }

    #[test]
    fn range_contains_rowcol_for_whole_column() {
        let r = whole_col(0, 2); // A:C
                                 // Any row in cols 0..=2 is contained.
        assert!(range_contains_rowcol(&r, 0, 0));
        assert!(range_contains_rowcol(&r, u32::MAX, 2));
        assert!(!range_contains_rowcol(&r, 0, 3)); // col 3 outside
    }

    #[test]
    fn range_contains_rowcol_for_whole_row() {
        let r = whole_row(5, 7);
        assert!(range_contains_rowcol(&r, 5, 0));
        assert!(range_contains_rowcol(&r, 7, u32::MAX));
        assert!(!range_contains_rowcol(&r, 4, 0));
        assert!(!range_contains_rowcol(&r, 8, 0));
    }

    /// A5 ACCEPTANCE: register 100k formulas `SUM(A1:A_n)` with `n` varying. Total
    /// stripe entries (sum across all formulas' insertions) ≤ 2 × formula_count.
    ///
    /// With Formualizer's shape heuristic, each `Cells { 0, 0, 0, n-1 }` for n ≥ 2 has
    /// height=n, width=1, h>w → 1 Column stripe at col 0. For n=1 (h==w==1, tie → else
    /// branch) → 1 Row stripe at row 0. So all 100k formulas land in 2 buckets total
    /// (one Column at col 0 + one Row at row 0). `total_insertions == 100_000`.
    ///
    /// The 2× upper bound is the spec's guard against quadratic growth — actual scaling
    /// is far better (linear with formula count).
    #[test]
    fn a5_acceptance_100k_formulas_linear_scaling() {
        let mut idx = StripeIndex::new();
        const N: u32 = 100_000;
        for i in 1..=N {
            idx.register(NodeId(i), &cells(0, 0, 0, i - 1), 0);
        }
        // Two distinct stripe keys: Column at col 0 (for n>=2), Row at row 0 (for n=1).
        assert_eq!(idx.stripe_count(), 2);
        // Exactly N insertions — one per formula.
        assert_eq!(idx.total_insertions(), N as usize);
        // The bound from the spec:
        assert!(idx.total_insertions() as u64 <= 2 * (N as u64));

        // Cell write at A500 → all 100k-1 formulas (except n=1) match the Column stripe.
        // Plus the n=1 formula matches the Row 0 stripe (since 500 is the row but 0 is
        // the row of the n=1 range — wait, candidates_for_cell(0, 500, 0) checks Row 500
        // and Column 0. Row 500's stripe is empty; Column 0's stripe has all 99999
        // formulas (n>=2). The n=1 formula registered Row 0, not Row 500, so it
        // doesn't appear in the Row 500 stripe.
        let candidates = idx.candidates_for_cell(0, 500, 0);
        assert_eq!(candidates.len(), (N - 1) as usize); // n=2 through n=100_000
    }

    #[test]
    fn duplicate_register_idempotent() {
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &whole_col(0, 0), 0);
        idx.register(NodeId(1), &whole_col(0, 0), 0); // duplicate
        assert_eq!(idx.stripe_count(), 1);
        // HashSet dedupes; total_insertions counts distinct formulas per stripe.
        assert_eq!(idx.total_insertions(), 1);
    }

    // ===== Audit H1 fix (2026-05-12): malformed ranges panic instead of silently no-op =====

    #[test]
    #[should_panic(expected = "reversed cols")]
    fn register_panics_on_cells_reversed_cols() {
        let mut idx = StripeIndex::new();
        let bad = RangeRef::Cells {
            sheet: None,
            start_col: 5,
            start_row: 0,
            end_col: 2,
            end_row: 9,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        idx.register(NodeId(1), &bad, 0);
    }

    #[test]
    #[should_panic(expected = "reversed rows")]
    fn register_panics_on_cells_reversed_rows() {
        let mut idx = StripeIndex::new();
        let bad = RangeRef::Cells {
            sheet: None,
            start_col: 0,
            start_row: 9,
            end_col: 1,
            end_row: 2,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        idx.register(NodeId(1), &bad, 0);
    }

    #[test]
    #[should_panic(expected = "WholeColumn has reversed cols")]
    fn register_panics_on_whole_column_reversed() {
        let mut idx = StripeIndex::new();
        let bad = RangeRef::WholeColumn {
            sheet: None,
            start_col: 5,
            end_col: 2,
            abs_start: false,
            abs_end: false,
        };
        idx.register(NodeId(1), &bad, 0);
    }

    #[test]
    #[should_panic(expected = "WholeRow has reversed rows")]
    fn register_panics_on_whole_row_reversed() {
        let mut idx = StripeIndex::new();
        let bad = RangeRef::WholeRow {
            sheet: None,
            start_row: 9,
            end_row: 2,
            abs_start: false,
            abs_end: false,
        };
        idx.register(NodeId(1), &bad, 0);
    }

    #[test]
    fn raw_map_accessor_exposes_internals_for_a4() {
        // CORR-24 typed-accessor pattern — A4 assertions read directly off the map.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(1), &whole_col(0, 0), 0);
        idx.register(NodeId(2), &whole_col(0, 0), 0);
        let map = idx.raw_map();
        assert_eq!(map.len(), 1);
        let key = StripeKey {
            sheet_id: 0,
            stripe_type: StripeType::Column,
            index: 0,
        };
        assert_eq!(
            map.get(&key).unwrap(),
            &[NodeId(1), NodeId(2)].into_iter().collect::<HashSet<_>>()
        );
    }

    // ===== W5-50 (Phase 4 pre-V2): reverse index + clear_for_formula =====

    #[test]
    fn reverse_index_populated_on_register() {
        let mut idx = StripeIndex::new();
        idx.register(NodeId(7), &whole_col(0, 0), 0); // Col 0 stripe
        idx.register(NodeId(7), &whole_row(5, 5), 0); // Row 5 stripe
        let keys = idx.stripe_keys_for_formula(NodeId(7)).expect("present");
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&StripeKey {
            sheet_id: 0,
            stripe_type: StripeType::Column,
            index: 0,
        }));
        assert!(keys.contains(&StripeKey {
            sheet_id: 0,
            stripe_type: StripeType::Row,
            index: 5,
        }));
    }

    #[test]
    fn reverse_index_dedups_same_formula_same_stripe() {
        // Two ranges that share a stripe (`A:A` and `A1:A10` both hit Col 0)
        // for the same formula must NOT create two reverse-index entries —
        // the forward HashSet dedups; the reverse vector mirrors that.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(7), &whole_col(0, 0), 0);
        idx.register(NodeId(7), &cells(0, 0, 0, 9), 0); // A1:A10 → Col 0 (height>width)
        let keys = idx.stripe_keys_for_formula(NodeId(7)).expect("present");
        assert_eq!(keys.len(), 1, "two ranges, same stripe → one reverse entry");
        assert_eq!(idx.total_insertions(), 1);
    }

    #[test]
    fn clear_for_formula_removes_from_all_stripes() {
        // Formula registered on Col 0 and Row 5; clearing must drop both.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(7), &whole_col(0, 0), 0);
        idx.register(NodeId(7), &whole_row(5, 5), 0);
        assert_eq!(idx.stripe_count(), 2);
        assert_eq!(idx.total_insertions(), 2);

        idx.clear_for_formula(NodeId(7));

        assert_eq!(idx.stripe_count(), 0, "both stripes were singleton-pruned");
        assert_eq!(idx.total_insertions(), 0);
        assert!(idx.stripe_keys_for_formula(NodeId(7)).is_none());
        // Cell write at A5 finds no candidates.
        assert!(idx.candidates_for_cell(0, 5, 0).is_empty());
    }

    #[test]
    fn clear_for_formula_preserves_other_formulas() {
        // 100 formulas share Col 0 stripe; clearing one drops only that one.
        let mut idx = StripeIndex::new();
        for i in 1..=100u32 {
            idx.register(NodeId(i), &whole_col(0, 0), 0);
        }
        assert_eq!(idx.total_insertions(), 100);

        idx.clear_for_formula(NodeId(42));

        assert_eq!(idx.total_insertions(), 99, "only 1 removed");
        assert_eq!(idx.stripe_count(), 1, "stripe still has 99 deps");
        // The cleared formula no longer matches.
        let candidates = idx.candidates_for_cell(0, 0, 0);
        assert_eq!(candidates.len(), 99);
        assert!(!candidates.contains(&NodeId(42)));
    }

    #[test]
    fn clear_for_formula_is_idempotent() {
        let mut idx = StripeIndex::new();
        idx.register(NodeId(7), &whole_col(0, 0), 0);
        idx.clear_for_formula(NodeId(7));
        idx.clear_for_formula(NodeId(7)); // no-op
        idx.clear_for_formula(NodeId(999)); // never registered, no-op
        assert_eq!(idx.stripe_count(), 0);
        assert_eq!(idx.total_insertions(), 0);
    }

    #[test]
    fn re_register_after_clear_works() {
        // The rebind workflow: register A:A, clear, register B:B. The
        // post-clear state must accept the new registration cleanly.
        let mut idx = StripeIndex::new();
        idx.register(NodeId(7), &whole_col(0, 0), 0); // A:A
        idx.clear_for_formula(NodeId(7));
        idx.register(NodeId(7), &whole_col(1, 1), 0); // B:B

        assert_eq!(idx.stripe_count(), 1);
        // A5 no longer dirties; B5 does.
        assert!(idx.candidates_for_cell(0, 5, 0).is_empty());
        assert_eq!(
            idx.candidates_for_cell(0, 5, 1),
            [NodeId(7)].into_iter().collect()
        );
    }

    #[test]
    fn clear_for_formula_handles_stripe_with_multiple_deps_correctly() {
        // Col 0 has [B1, C1]; clearing B1 leaves [C1] and the stripe stays.
        let mut idx = StripeIndex::new();
        let b1 = NodeId(1);
        let c1 = NodeId(2);
        idx.register(b1, &whole_col(0, 0), 0);
        idx.register(c1, &whole_col(0, 0), 0);
        assert_eq!(idx.total_insertions(), 2);

        idx.clear_for_formula(b1);

        assert_eq!(idx.stripe_count(), 1, "stripe survives (C1 still in it)");
        assert_eq!(idx.total_insertions(), 1);
        let candidates = idx.candidates_for_cell(0, 5, 0);
        assert_eq!(candidates, [c1].into_iter().collect());
    }
}
