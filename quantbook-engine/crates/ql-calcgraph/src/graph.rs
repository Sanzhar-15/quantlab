//! The top-level `Graph` — append-only node + adjacency container.
//!
//! Phase 0 scope (Week 3):
//! - Insert nodes (Cell, Range, FormulaRegion). No delete; vertex IDs append-only.
//! - Insert directed edges between existing nodes.
//! - Revision counter bumped on every structural change (salsa-inspired) so callers can
//!   detect "did the graph change since I last looked?" cheaply.
//!
//! Out of W3-1 scope (later commits):
//! - W3-2 `dirty.rs` — per-chunk dirty bitmap + propagation walk.
//! - W3-3 `topo.rs` — iterative Tarjan SCC scheduler (CORR-23).
//! - W3-4 `fingerprint.rs` — Expr → u64 hash for formula-region memoization.
//! - W3-5 `stripes.rs` — stripe-index registration per CORR-21.
//! - W3-6 typed `#[cfg(test)]` accessors for the A4 assertions (CORR-24).
//!
//! ## Node + edge semantics (recap)
//!
//! Outgoing edge `u -> v` means **"u depends on v"** — recomputing u requires v's value.
//! When v changes, the dirty walk traverses `incoming(v)` (the reverse direction) to mark
//! dependents.
//!
//! ## Same-sheet only in Phase 0
//!
//! Every node carries a concrete `SheetId`. AST nodes (`Expr::CellRef`, `RangeRef::*`)
//! may carry `Option<SheetId>` for sheet-qualification deferred to Phase 3+; the graph
//! constructor (callers in `ql-exec` Week 4) is responsible for resolving the optional
//! to a concrete sheet before calling `add_*_node`.

use ql_types::{ColId, RowId, SheetId};

use crate::edges::AdjacencyVectors;
use crate::node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode};

/// The calc-graph container.
///
/// Append-only in Phase 0 (no removal). Borrows nothing — every node payload is owned by
/// the graph (Range/FormulaRegion carry their full payload by value). This keeps lifetime
/// management trivial at the cost of cloning small structs when callers query nodes; the
/// payload sizes are bounded (Cell = 12 bytes; FormulaRegion ≈ 36 bytes) so the cloning
/// cost is negligible compared to the hash/compare work in the dirty walk.
#[derive(Clone, Debug, Default)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: AdjacencyVectors,
    revision: u64,
}

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Total nodes added. Always equal to `revision_after_last_node_add` minus the count
    /// of edge-only revisions — but Phase 0 doesn't distinguish, since both bump revision.
    pub fn node_count(&self) -> usize {
        debug_assert_eq!(self.nodes.len(), self.edges.node_count());
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.edge_count()
    }

    /// Monotonic version counter. Bumped on every structural change (node add, edge add).
    /// Callers comparing graph state across operations rely on this — e.g. the dirty walk
    /// re-runs only if `graph.revision() != self.last_walked_revision`.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Borrow a node by id. Panics on out-of-bounds — graph callers should never construct
    /// `NodeId`s by hand; ids only come from `add_*_node` return values.
    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.index()]
    }

    /// Iterate `node` -> dependencies (what `node` depends on).
    pub fn outgoing(&self, node: NodeId) -> &[NodeId] {
        self.edges.outgoing(node)
    }

    /// Iterate dependents -> `node` (what depends on `node`). The dirty walk uses this.
    pub fn incoming(&self, node: NodeId) -> &[NodeId] {
        self.edges.incoming(node)
    }

    fn push_node(&mut self, node: Node) -> NodeId {
        let id = NodeId(
            self.nodes
                .len()
                .try_into()
                .expect("Graph::push_node: node count exceeds u32::MAX"),
        );
        self.nodes.push(node);
        self.edges.push_node();
        self.revision = self
            .revision
            .checked_add(1)
            .expect("Graph::push_node: revision counter overflowed u64");
        id
    }

    pub fn add_cell_node(&mut self, sheet: SheetId, row: RowId, col: ColId) -> NodeId {
        self.push_node(Node::Cell(CellNode { sheet, row, col }))
    }

    pub fn add_range_node(&mut self, range: RangeNode) -> NodeId {
        self.push_node(Node::Range(range))
    }

    pub fn add_formula_region_node(&mut self, region: FormulaRegionNode) -> NodeId {
        self.push_node(Node::FormulaRegion(region))
    }

    /// Spill nodes are Phase 3+ — panic loudly if Phase 0 callers attempt construction.
    /// Per the no-fallbacks rule: don't silently accept an unreachable variant.
    pub fn add_spill_node(&mut self, _anchor: NodeId, _shape: (RowId, ColId)) -> NodeId {
        panic!(
            "Graph::add_spill_node: Phase 3+ feature (dynamic array spill anchors); not \
             constructed in Phase 0. Tracked via the shape-locked Node::Spill variant."
        );
    }

    /// Add a directed edge `from -> to` ("from depends on to"). Both ids must already exist.
    /// Caller is responsible for not double-adding (Phase 0 has no dedup; see edges.rs).
    pub fn add_edge(&mut self, from: NodeId, to: NodeId) {
        self.edges.add_edge(from, to);
        self.revision = self
            .revision
            .checked_add(1)
            .expect("Graph::add_edge: revision counter overflowed u64");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_formula_syntax::RangeRef;

    #[test]
    fn empty_graph_has_zero_state() {
        let g = Graph::new();
        assert_eq!(g.node_count(), 0);
        assert_eq!(g.edge_count(), 0);
        assert_eq!(g.revision(), 0);
    }

    #[test]
    fn add_cell_node_bumps_revision_and_returns_sequential_ids() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        assert_eq!(a, NodeId(0));
        assert_eq!(g.revision(), 1);
        assert_eq!(g.node_count(), 1);

        let b = g.add_cell_node(0, 0, 1);
        assert_eq!(b, NodeId(1));
        assert_eq!(g.revision(), 2);
        assert_eq!(g.node_count(), 2);
    }

    #[test]
    fn add_range_node_returns_correct_variant() {
        let mut g = Graph::new();
        let id = g.add_range_node(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: None,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        });
        match g.node(id) {
            Node::Range(rn) => assert!(matches!(
                rn.range,
                RangeRef::WholeColumn { start_col: 0, .. }
            )),
            _ => panic!("expected Range variant"),
        }
    }

    #[test]
    fn add_formula_region_node_carries_fingerprint() {
        let mut g = Graph::new();
        let id = g.add_formula_region_node(FormulaRegionNode {
            sheet: 0,
            target_start_row: 0,
            target_start_col: 1,
            target_end_row: 99,
            target_end_col: 1,
            formula_fingerprint: 0xCAFE_F00D_DEAD_BEEF,
            chunk_count: 1,
        });
        match g.node(id) {
            Node::FormulaRegion(frn) => {
                assert_eq!(frn.formula_fingerprint, 0xCAFE_F00D_DEAD_BEEF);
                assert_eq!(frn.chunk_count, 1);
            }
            _ => panic!("expected FormulaRegion variant"),
        }
    }

    #[test]
    fn add_edge_bumps_revision_and_populates_adjacency() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let b = g.add_cell_node(0, 1, 0);
        let rev_before = g.revision();
        g.add_edge(a, b);
        assert_eq!(g.revision(), rev_before + 1);
        assert_eq!(g.edge_count(), 1);
        assert_eq!(g.outgoing(a), &[b]);
        assert_eq!(g.incoming(b), &[a]);
        assert!(g.outgoing(b).is_empty());
        assert!(g.incoming(a).is_empty());
    }

    #[test]
    fn revision_only_bumps_on_structural_change() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let rev = g.revision();
        // Queries don't bump revision.
        let _ = g.node(a);
        let _ = g.node_count();
        let _ = g.outgoing(a);
        assert_eq!(g.revision(), rev);
    }

    #[test]
    fn diamond_graph() {
        // SUM(A1, A2) where A1 = 1, A2 = 2 — formula B1 depends on both.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let a2 = g.add_cell_node(0, 1, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        g.add_edge(b1, a1);
        g.add_edge(b1, a2);
        assert_eq!(g.outgoing(b1).len(), 2);
        assert_eq!(g.incoming(a1), &[b1]);
        assert_eq!(g.incoming(a2), &[b1]);
    }

    #[test]
    #[should_panic(expected = "Phase 3+ feature")]
    fn add_spill_node_panics() {
        let mut g = Graph::new();
        let anchor = g.add_cell_node(0, 0, 0);
        g.add_spill_node(anchor, (3, 3));
    }

    #[test]
    fn many_cell_nodes_get_sequential_ids() {
        let mut g = Graph::new();
        let mut ids = Vec::new();
        for r in 0..100 {
            ids.push(g.add_cell_node(0, r, 0));
        }
        for (i, id) in ids.iter().enumerate() {
            assert_eq!(*id, NodeId(i as u32));
        }
        assert_eq!(g.node_count(), 100);
    }

    #[test]
    fn out_of_bounds_node_lookup_panics() {
        let g = Graph::new();
        let result = std::panic::catch_unwind(|| {
            let _ = g.node(NodeId(0));
        });
        assert!(result.is_err());
    }

    #[test]
    fn out_of_bounds_add_edge_panics() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Wrap in a fresh graph since `g` is borrowed by AssertUnwindSafe
            let mut g2 = Graph::new();
            g2.add_cell_node(0, 0, 0);
            g2.add_edge(a, NodeId(5));
        }));
        assert!(result.is_err());
    }

    #[test]
    fn edge_order_preserved() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let b = g.add_cell_node(0, 1, 0);
        let c = g.add_cell_node(0, 2, 0);
        let d = g.add_cell_node(0, 3, 0);
        // a depends on b, c, d in that order
        g.add_edge(a, b);
        g.add_edge(a, c);
        g.add_edge(a, d);
        assert_eq!(g.outgoing(a), &[b, c, d]);
    }

    #[test]
    fn mixed_node_types_in_one_graph() {
        let mut g = Graph::new();
        let cell_a = g.add_cell_node(0, 0, 0);
        let range = g.add_range_node(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: None,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        });
        let region = g.add_formula_region_node(FormulaRegionNode {
            sheet: 0,
            target_start_row: 0,
            target_start_col: 1,
            target_end_row: 99,
            target_end_col: 1,
            formula_fingerprint: 1,
            chunk_count: 1,
        });
        assert_eq!(g.node_count(), 3);
        assert!(matches!(g.node(cell_a), Node::Cell(_)));
        assert!(matches!(g.node(range), Node::Range(_)));
        assert!(matches!(g.node(region), Node::FormulaRegion(_)));
    }
}
