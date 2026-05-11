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

use std::collections::HashMap;

use ql_formula_syntax::RangeRef;
use ql_types::{ColId, RowId, SheetId};

use crate::edges::AdjacencyVectors;
use crate::node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode};
use crate::stats::GraphStats;
use crate::stripes::{range_contains_rowcol, StripeIndex};

/// The calc-graph container.
///
/// Append-only in Phase 0 (no removal). Borrows nothing — every node payload is owned by
/// the graph (Range/FormulaRegion carry their full payload by value). This keeps lifetime
/// management trivial at the cost of cloning small structs when callers query nodes; the
/// payload sizes are bounded (Cell = 12 bytes; FormulaRegion ≈ 36 bytes) so the cloning
/// cost is negligible compared to the hash/compare work in the dirty walk.
///
/// ## Range-dependency tracking (W3-5)
///
/// Two sidecar structures alongside nodes + edges:
///
/// - `stripes: StripeIndex` — per CORR-21, the per-row / per-column stripe map that lets
///   `dependents_for_cell` answer in O(touched_stripes) instead of O(formula_count).
/// - `formula_to_range_deps: HashMap<NodeId, Vec<RangeRef>>` — the canonical range list
///   per formula node. Used by `dependents_for_cell` for the precision-check that drops
///   stripe-match false positives (the stripe map is coarser than the actual range).
///
/// `register_range_dependency` populates BOTH atomically. Don't call them separately.
#[derive(Clone, Debug, Default)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: AdjacencyVectors,
    revision: u64,
    stripes: StripeIndex,
    formula_to_range_deps: HashMap<NodeId, Vec<RangeRef>>,
    stats: GraphStats,
}

/// Count of nodes by `Node` variant. Used by `graph-profile.json` export so a reader can
/// see at a glance how the graph mass distributes across leaf cells, compressed ranges,
/// dense formula regions, and (Phase 3+) spill anchors.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NodeCountsByVariant {
    pub cell: u64,
    pub range: u64,
    pub formula_region: u64,
    pub spill: u64,
}

impl NodeCountsByVariant {
    pub fn total(&self) -> u64 {
        self.cell + self.range + self.formula_region + self.spill
    }
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

    /// Register that `formula_node` depends on cells in `range`. Atomically updates BOTH
    /// the stripe index AND `formula_to_range_deps`. Callers should invoke this once per
    /// range reference in a formula's AST (a formula like `=SUM(A:A) + COUNT(B:B)` calls
    /// register_range_dependency twice).
    ///
    /// The Phase 0 W3-5 callers (Week 4 `ql-exec` binder) own:
    /// 1. Calling `add_cell_node` / `add_formula_region_node` for the formula's owning vertex.
    /// 2. Calling `register_range_dependency` for each range the formula references.
    /// 3. Optionally adding explicit edges via `add_edge` for direct cell-to-cell deps.
    pub fn register_range_dependency(
        &mut self,
        formula_node: NodeId,
        range: RangeRef,
        sheet_id: SheetId,
    ) {
        assert!(
            formula_node.index() < self.nodes.len(),
            "Graph::register_range_dependency: formula_node {} out of bounds",
            formula_node.index()
        );
        let inserts_before = self.stripes.total_insertions();
        self.stripes.register(formula_node, &range, sheet_id);
        let inserts_after = self.stripes.total_insertions();
        // `stripe_inserts` counts the NEW insertions this call produced. HashSet dedup
        // means a re-registration of the same (formula_node, range) might be a no-op,
        // in which case the delta is zero — matches Formualizer's instrumentation
        // semantics (`engine/graph/range_deps.rs:78-86`).
        self.stats.stripe_inserts = self
            .stats
            .stripe_inserts
            .checked_add((inserts_after - inserts_before) as u64)
            .expect("Graph::register_range_dependency: stripe_inserts overflowed u64");
        self.formula_to_range_deps
            .entry(formula_node)
            .or_default()
            .push(range);
        self.revision = self
            .revision
            .checked_add(1)
            .expect("Graph::register_range_dependency: revision counter overflowed u64");
    }

    /// Borrow the instrumentation counters. Used by tests + the W3-7 graph-profile.json
    /// export (OG-06 acceptance).
    pub fn stats(&self) -> GraphStats {
        self.stats
    }

    /// Bump `chunked_reduce_chunks_processed` by `n`. Phase 0 doesn't increment this
    /// from inside ql-calcgraph; Week 4 ql-exec calls this on each chunk it processes
    /// during a `SUM`/`COUNT`/etc. reduction. Locking the API in W3-6 means Week 4 just
    /// wires the increments without a graph-shape change.
    pub fn record_chunked_reduce(&mut self, chunks_processed: u64) {
        self.stats.chunked_reduce_chunks_processed = self
            .stats
            .chunked_reduce_chunks_processed
            .checked_add(chunks_processed)
            .expect("Graph::record_chunked_reduce: counter overflowed u64");
    }

    /// True dependents of a cell write at `(sheet, row, col)`. Two-pass:
    /// 1. Stripe lookup → candidate formula nodes (CORR-21 coarse-grained).
    /// 2. Precision filter against each candidate's `formula_to_range_deps` — drops
    ///    candidates whose actual range doesn't contain the cell.
    ///
    /// Returns the precise dependent set, **sorted ascending by `NodeId`** so callers
    /// receive deterministic ordering across runs. Audit H2 (2026-05-12): the previous
    /// implementation collected from a `HashSet` which leaked Rust's randomized hash
    /// state — two identical edits on the same workbook would produce different
    /// downstream scheduling order, silently breaking replay determinism.
    pub fn dependents_for_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Vec<NodeId> {
        let candidates = self.stripes.candidates_for_cell(sheet, row, col);
        let mut out: Vec<NodeId> = candidates
            .into_iter()
            .filter(|formula_id| {
                self.formula_to_range_deps
                    .get(formula_id)
                    .is_some_and(|ranges| ranges.iter().any(|r| range_contains_rowcol(r, row, col)))
            })
            .collect();
        out.sort();
        out
    }

    /// Total registered range-dependencies across all formula nodes. Counts each
    /// `register_range_dependency` call. Used by tests + W3-7 graph-profile export.
    pub fn range_dependency_count(&self) -> usize {
        self.formula_to_range_deps.values().map(Vec::len).sum()
    }

    /// Count nodes by variant. Used by W3-7 graph-profile.json export (OG-06) so a
    /// reader can quickly attribute total graph mass to the right node kind. O(n) over
    /// the node array; not on any hot path.
    pub fn node_counts_by_variant(&self) -> NodeCountsByVariant {
        let mut counts = NodeCountsByVariant::default();
        for n in &self.nodes {
            match n {
                Node::Cell(_) => counts.cell += 1,
                Node::Range(_) => counts.range += 1,
                Node::FormulaRegion(_) => counts.formula_region += 1,
                Node::Spill(_) => counts.spill += 1,
            }
        }
        counts
    }

    /// Borrow the stripe index — used by ql-profile to dump stripe-key cardinality.
    /// Read-only public access; mutation goes through `register_range_dependency`.
    pub fn stripe_index(&self) -> &StripeIndex {
        &self.stripes
    }

    /// Test-only typed accessor for A4 assertions (CORR-24).
    #[cfg(test)]
    pub(crate) fn stripes(&self) -> &StripeIndex {
        &self.stripes
    }

    /// Test-only typed accessor for A4 assertions (CORR-24).
    #[cfg(test)]
    pub(crate) fn formula_to_range_deps(&self) -> &HashMap<NodeId, Vec<RangeRef>> {
        &self.formula_to_range_deps
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
    fn register_range_dependency_inserts_into_stripes_and_lookup_map() {
        // SUM(A:A) formula at B1.
        let mut g = Graph::new();
        let b1 = g.add_cell_node(0, 0, 1); // formula cell
        let range = RangeRef::WholeColumn {
            sheet: None,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let rev_before = g.revision();
        g.register_range_dependency(b1, range, 0);
        assert_eq!(g.revision(), rev_before + 1);
        assert_eq!(g.range_dependency_count(), 1);
        // The stripe index has exactly one Column-0 entry.
        assert_eq!(g.stripes().stripe_count(), 1);
        // formula_to_range_deps has one entry for b1.
        assert_eq!(g.formula_to_range_deps().get(&b1).unwrap().len(), 1);
    }

    #[test]
    fn dependents_for_cell_precision_filters_false_positives() {
        // SUM(A1:A10) at B1, SUM(A:A) at C1. A write to A500 should match C1 but NOT
        // B1 (whose range only covers A1:A10).
        let mut g = Graph::new();
        let b1 = g.add_cell_node(0, 0, 1);
        let c1 = g.add_cell_node(0, 0, 2);
        let bounded = RangeRef::Cells {
            sheet: None,
            start_col: 0,
            start_row: 0,
            end_col: 0,
            end_row: 9,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        let whole_col = RangeRef::WholeColumn {
            sheet: None,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        g.register_range_dependency(b1, bounded, 0);
        g.register_range_dependency(c1, whole_col, 0);

        // Both registered under Column 0 stripe.
        assert_eq!(g.stripes().stripe_count(), 1);
        assert_eq!(g.stripes().total_insertions(), 2);

        // Write to A5 (in B1's range): both match. Output is sorted (audit H2 fix).
        let deps_at_5 = g.dependents_for_cell(0, 5, 0);
        let mut expected: Vec<NodeId> = [b1, c1].to_vec();
        expected.sort();
        assert_eq!(deps_at_5, expected);
        // Verify the returned Vec is sorted (H2 contract).
        assert!(deps_at_5.windows(2).all(|w| w[0] <= w[1]));

        // Write to A500 (outside B1's range, inside C1's): only C1 matches.
        assert_eq!(g.dependents_for_cell(0, 500, 0), vec![c1]);
    }

    /// Audit H2 (2026-05-12): `dependents_for_cell` must return a Vec sorted by NodeId
    /// for determinism. Previously the function collected from a HashSet which leaked
    /// Rust's randomized hash state to callers, silently breaking replay determinism.
    #[test]
    fn dependents_for_cell_returns_sorted_vec() {
        let mut g = Graph::new();
        // 50 formulas in random column order — internal HashSet iteration would yield
        // them in an arbitrary order. dependents_for_cell must sort before returning.
        let mut ids = Vec::with_capacity(50);
        for col in 0..50 {
            let id = g.add_cell_node(0, 0, col + 1);
            ids.push(id);
            g.register_range_dependency(
                id,
                RangeRef::WholeColumn {
                    sheet: None,
                    start_col: 0,
                    end_col: 0,
                    abs_start: false,
                    abs_end: false,
                },
                0,
            );
        }
        let deps = g.dependents_for_cell(0, 5, 0);
        assert_eq!(deps.len(), 50);
        // Strictly increasing by NodeId.
        assert!(deps.windows(2).all(|w| w[0] < w[1]));
        // And: same result on the second call (deterministic).
        assert_eq!(deps, g.dependents_for_cell(0, 5, 0));
    }

    #[test]
    fn dependents_for_cell_empty_when_no_ranges_registered() {
        let mut g = Graph::new();
        g.add_cell_node(0, 0, 0);
        assert!(g.dependents_for_cell(0, 0, 0).is_empty());
    }

    #[test]
    #[should_panic(expected = "out of bounds")]
    fn register_range_dependency_oob_panics() {
        let mut g = Graph::new();
        g.add_cell_node(0, 0, 0);
        g.register_range_dependency(
            NodeId(99),
            RangeRef::WholeColumn {
                sheet: None,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
    }

    #[test]
    fn multiple_ranges_per_formula_all_tracked() {
        // =SUM(A:A) + COUNT(B:B): one formula, two range dependencies.
        let mut g = Graph::new();
        let c1 = g.add_cell_node(0, 0, 2);
        let col_a = RangeRef::WholeColumn {
            sheet: None,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let col_b = RangeRef::WholeColumn {
            sheet: None,
            start_col: 1,
            end_col: 1,
            abs_start: false,
            abs_end: false,
        };
        g.register_range_dependency(c1, col_a, 0);
        g.register_range_dependency(c1, col_b, 0);
        assert_eq!(g.range_dependency_count(), 2);
        // Two distinct stripes (Column 0 and Column 1)
        assert_eq!(g.stripes().stripe_count(), 2);
        // A write to A500 matches.
        assert_eq!(g.dependents_for_cell(0, 500, 0), vec![c1]);
        // A write to B500 matches.
        assert_eq!(g.dependents_for_cell(0, 500, 1), vec![c1]);
        // A write to C500 doesn't.
        assert!(g.dependents_for_cell(0, 500, 2).is_empty());
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
