//! `ql-calcgraph` — Quantbook calculation dependency graph.
//!
//! Phase 0 scope per spec Part V §4 Week 3 + the Week 3 Day 0 reference deep-read
//! (`docs/phase0/references-reading-log.md`):
//!
//! - **W3-1 (THIS COMMIT)**: Node + edges + Graph container. Append-only nodes, directed
//!   edges with reverse adjacency, revision counter. ~600 LOC + 24 tests across the three
//!   modules.
//! - **W3-2** (next): `dirty.rs` — per-chunk dirty bitmap (`ChunkDirtySet`) + propagation.
//!   OG-05 acceptance ("single-cell write marks only one chunk") locked here.
//! - **W3-3**: `topo.rs` — iterative Tarjan SCC scheduler returning `(sorted, cycled)`.
//!   CORR-23 applied (Tarjan, not Kahn).
//! - **W3-4**: `fingerprint.rs` — `fn fingerprint(&Expr) -> u64` for formula-region
//!   memoization. ahash via the workspace.
//! - **W3-5**: `stripes.rs` — Formualizer-style stripe map per CORR-21. The A5
//!   acceptance piece.
//! - **W3-6**: typed `#[cfg(test)]` accessors on `Graph` per CORR-24. The 3 A4
//!   acceptance assertions.
//! - **W3-7..9**: ql-profile `graph-profile.json` export (OG-06); A1 + A5 bench scaffolds.
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
pub mod stripes;
pub mod topo;

pub use dirty::{propagate_from_cells, ChunkDirtySet, ChunkKey};
pub use edges::AdjacencyVectors;
pub use fingerprint::fingerprint;
pub use graph::Graph;
pub use node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode, SpillNode};
pub use stripes::{StripeIndex, StripeKey, StripeType};
pub use topo::{schedule, Schedule};

#[cfg(test)]
mod integration_tests {
    use super::*;
    use ql_formula_syntax::RangeRef;

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
                sheet: None,
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
}
