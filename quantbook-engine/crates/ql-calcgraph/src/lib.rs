//! `ql-calcgraph` — Quantbook calculation dependency graph.
//!
//! Phase 0 scope per spec Part V §4 Week 3 + the Week 3 Day 0 reference deep-read
//! (`docs/phase0/references-reading-log.md`). All of W3-1..W3-9 are implemented in the
//! modules below.
//!
//! - `node.rs` — Node enum (Cell, Range, FormulaRegion, Spill) + payload structs.
//! - `edges.rs` — append-only adjacency vectors with reverse-lookup.
//! - `graph.rs` — top-level Graph with register_range_dependency, dependents_for_cell,
//!   record_chunked_reduce, node_counts_by_variant, stripe_index accessor, and
//!   `#[cfg(test)]` typed accessors for A4 assertions (CORR-24).
//! - `dirty.rs` — ChunkDirtySet (sparse per-chunk bitmap) and propagate_from_cells.
//!   Locks OG-05 acceptance ("single-cell write marks only the affected chunk").
//! - `topo.rs` — iterative Tarjan SCC over the dirty subset returning
//!   Schedule { sorted, cycled }. Applies CORR-23 (Tarjan, not Kahn).
//! - `fingerprint.rs` — fingerprint(&Expr) -> u64 for FormulaRegionNode memoization.
//! - `stripes.rs` — Formualizer-style StripeKey { Row|Column, index } map per CORR-21.
//!   Locks A5 acceptance (range-node prefix-SUM near-linear edge growth).
//! - `stats.rs` — GraphStats instrumentation counters (stripe_inserts,
//!   dependents_scan_fallback, chunked_reduce_chunks_processed).
//!
//! Benches under `benches/` cover A1 (region split/merge falsifier scaffold), A5
//! (prefix-SUM near-linear), and OG-05 (per-chunk dirty propagation).
//!
//! Audit hardening (2026-05-12): post-W3 audit applied H1 (malformed-range panic), H2
//! (deterministic Vec ordering on `dependents_for_cell`), and M3 (MAX_ROW bound on
//! chunk arithmetic). See commit message + the audit findings.
//!
//! ## Design intent (recap)
//!
//! This is the most architecturally risky crate in Phase 0. Without it, the 25M-cell
//! `=A*2` ≤100ms hot path (OG-02) is mathematically impossible — the graph must compress
//! range references into ONE node per distinct rectangle (NOT one per cell), the
//! formula-region pattern must avoid per-cell formula vertices for dense regions, and
//! dirty propagation must work at chunk granularity so a single-cell write doesn't
//! recompute neighboring chunks.
//!
//! See `_QUANTBOOK-v1-SPECIFICATION.md` Part V §1 OG-02/OG-05/A1/A4/A5 for the
//! acceptance criteria.

pub mod dirty;
pub mod edges;
pub mod fingerprint;
pub mod graph;
pub mod node;
pub mod stats;
pub mod stripes;
pub mod topo;

pub use dirty::{propagate_from_cells, ChunkDirtySet, ChunkKey};
pub use edges::AdjacencyVectors;
pub use fingerprint::fingerprint;
pub use graph::{Graph, NodeCountsByVariant};
pub use node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode, SpillNode};
pub use stats::GraphStats;
pub use stripes::{range_contains_rowcol, StripeIndex, StripeKey, StripeType};
pub use topo::{schedule, schedule_with_supplemental, Schedule};

// Re-exports — downstream crates that depend on ql-calcgraph can use the dependent AST
// types via this crate without needing a direct ql-formula-syntax dep.
pub use ql_formula_syntax::{RangeRef, SheetRef};

#[cfg(test)]
mod integration_tests {
    use super::*;
    use ql_formula_syntax::{RangeRef, SheetRef};

    /// Integration: the full W3-1 surface composes — build a 5-node graph with mixed
    /// types and verify reverse-adjacency.
    #[test]
    fn build_a_mini_graph() {
        let mut g = Graph::new();

        // Sheet 0:
        //   A1 = 1
        //   A2 = 2
        //   A3 = 3
        //   B1 = SUM(A:A) -- one Range node + one formula cell
        //   C1 = A1 + A2  -- a formula cell depending on two cells
        let a1 = g.add_cell_node(0, 0, 0);
        let a2 = g.add_cell_node(0, 1, 0);
        let a3 = g.add_cell_node(0, 2, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        let c1 = g.add_cell_node(0, 0, 2);

        let col_a_range = g.add_range_node(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        });

        // B1 depends on the range
        g.add_edge(b1, col_a_range);
        // C1 depends on A1 and A2
        g.add_edge(c1, a1);
        g.add_edge(c1, a2);

        assert_eq!(g.node_count(), 6);
        assert_eq!(g.edge_count(), 3);

        // Reverse-adjacency: who depends on A1?
        assert_eq!(g.incoming(a1), &[c1]);
        // Who depends on the range? B1.
        assert_eq!(g.incoming(col_a_range), &[b1]);
        // A3 has no dependents (it's just data).
        assert!(g.incoming(a3).is_empty());

        // Revision: 6 node adds + 3 edge adds = 9
        assert_eq!(g.revision(), 9);
    }

    #[test]
    fn formula_region_node_one_node_for_dense_column() {
        // The Quantbook bet: column B has 1000 cells, each =A_n * 2 — represented as ONE
        // FormulaRegionNode, not 1000 cell formulas. (Edge wiring to the source column
        // comes in W3-5 when stripes land.)
        let mut g = Graph::new();
        let region = g.add_formula_region_node(FormulaRegionNode {
            sheet: 0,
            target_start_row: 0,
            target_start_col: 1, // column B
            target_end_row: 999,
            target_end_col: 1,
            formula_fingerprint: 0xA1B2_C3D4_E5F6_7890,
            chunk_count: 1, // 1000 rows fits in one 16384-row chunk
        });
        assert_eq!(g.node_count(), 1);
        match g.node(region) {
            Node::FormulaRegion(frn) => {
                assert_eq!(frn.target_end_row - frn.target_start_row + 1, 1000);
            }
            _ => panic!(),
        }
    }

    // ===== W3-6: A4 Phase 0 acceptance assertions (CORR-24 typed accessor pattern) =====
    //
    // Per the Week 3 plan + the deep-read finding (no reference engine has a whole-graph
    // serialized dump), these tests consume `Graph`'s `#[cfg(test)] pub(crate)` typed
    // accessors directly. No JSON/DOT parse step.

    /// **A4-1**: `=SUM(A:A)` registration produces exactly ONE `RangeRef::WholeColumn`
    /// entry in `formula_to_range_deps` — verifies A:A is NOT exploded to per-cell
    /// dependencies. The single most load-bearing assertion in Phase 0; without it the
    /// 25M-cell `SUM(A:A)` would carry 25M edges → mathematically impossible to meet
    /// OG-02 (25M `=A*2` ≤ 100ms).
    #[test]
    fn a4_assertion_1_whole_column_compressed_to_one_range_ref() {
        let mut g = Graph::new();
        let formula = g.add_cell_node(0, 0, 1); // B1 = SUM(A:A)
        g.register_range_dependency(
            formula,
            RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
        let deps = g.formula_to_range_deps();
        let formula_ranges = deps
            .get(&formula)
            .expect("formula must have a range dep entry");
        assert_eq!(
            formula_ranges.len(),
            1,
            "SUM(A:A) must produce exactly ONE RangeRef, not N cell refs"
        );
        assert!(matches!(
            formula_ranges[0],
            RangeRef::WholeColumn {
                start_col: 0,
                end_col: 0,
                ..
            }
        ));
    }

    /// **A4-2**: 100 formulas all referencing `A:A` share ONE compressed Column-0 stripe.
    /// A write to `A500` finds all 100 dependents via the stripe lookup, not via a full
    /// vertex scan — proven by `dependents_for_cell` returning all 100 in one call and
    /// the `dependents_scan_fallback` counter staying at 0.
    #[test]
    fn a4_assertion_2_n_formulas_share_one_stripe_no_scan_fallback() {
        let mut g = Graph::new();
        let mut formula_ids = Vec::with_capacity(100);
        for col in 1..=100 {
            // 100 distinct formula cells in cols 1..=100, each referencing A:A
            let id = g.add_cell_node(0, 0, col);
            formula_ids.push(id);
            g.register_range_dependency(
                id,
                RangeRef::WholeColumn {
                    sheet: SheetRef::Current,
                    start_col: 0,
                    end_col: 0,
                    abs_start: false,
                    abs_end: false,
                },
                0,
            );
        }
        let stripes = g.stripes();
        assert_eq!(
            stripes.stripe_count(),
            1,
            "100 SUM(A:A) formulas must share ONE compressed stripe"
        );
        assert_eq!(
            stripes.total_insertions(),
            100,
            "exactly 100 (formula, stripe) insertions — linear with formula count"
        );

        // The structural raw-map shape check: the single stripe key is Column 0.
        let raw = stripes.raw_map();
        let (key, deps) = raw.iter().next().expect("one stripe entry");
        assert_eq!(key.index, 0);
        assert_eq!(key.stripe_type, StripeType::Column);
        assert_eq!(deps.len(), 100);

        // Edit to A500 finds all 100 via the stripe lookup (no scan fallback).
        let deps = g.dependents_for_cell(0, 500, 0);
        assert_eq!(deps.len(), 100, "stripe lookup returns all 100 formulas");
        assert_eq!(
            g.stats().dependents_scan_fallback,
            0,
            "Phase 0 never triggers the scan-fallback path"
        );
    }

    /// **A4-3**: `Graph::stats().chunked_reduce_chunks_processed` counter PRESENCE
    /// locked. Week 4 ql-exec will wire `Graph::record_chunked_reduce` to bump this on
    /// each chunk processed during a Range/FormulaRegion recompute. The W3-6 lock is
    /// that the counter exists + the API is stable + a manual increment via
    /// `record_chunked_reduce` works.
    #[test]
    fn a4_assertion_3_chunked_reduce_counter_present_and_writable() {
        let mut g = Graph::new();
        assert_eq!(
            g.stats().chunked_reduce_chunks_processed,
            0,
            "counter starts at zero"
        );
        // Week 4 simulation: ql-exec recomputed a SUM(A:A) over 25M / 16384 ≈ 1526 chunks.
        g.record_chunked_reduce(1526);
        assert_eq!(g.stats().chunked_reduce_chunks_processed, 1526);
        // Additional reductions accumulate.
        g.record_chunked_reduce(1526);
        assert_eq!(g.stats().chunked_reduce_chunks_processed, 3052);
    }

    /// Bonus: stripe_inserts counter increments on each `register_range_dependency`.
    #[test]
    fn stripe_inserts_counter_increments_on_register() {
        let mut g = Graph::new();
        let f1 = g.add_cell_node(0, 0, 1);
        let f2 = g.add_cell_node(0, 0, 2);
        assert_eq!(g.stats().stripe_inserts, 0);
        g.register_range_dependency(
            f1,
            RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
        assert_eq!(g.stats().stripe_inserts, 1);
        g.register_range_dependency(
            f2,
            RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
        assert_eq!(g.stats().stripe_inserts, 2);
        // Re-registering the same formula on the same range is a HashSet no-op
        // (already in the dependents set) — counter doesn't bump.
        g.register_range_dependency(
            f1,
            RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
        assert_eq!(
            g.stats().stripe_inserts,
            2,
            "duplicate registration produces zero stripe insertions"
        );
    }
}
