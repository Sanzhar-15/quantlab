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

    /// **W5-50 — GAP-G-01 closure.** Revoke every outgoing edge from
    /// `node`, AND the symmetric back-pointer in each former target's
    /// `incoming` slot. Used by `CalcgraphSession::extract_and_register_deps`
    /// on re-bind so a formula whose direct cell deps changed
    /// (e.g. `=A1` → `=1`) doesn't leave stale forward edges that would
    /// confuse the Tarjan scheduler into seeing a false `#CIRC!` cycle.
    ///
    /// Bumps `revision` exactly once per call (not per edge), matching
    /// the existing semantics of `add_edge` / `register_range_dependency`.
    /// A node with no outgoing edges is a no-op.
    ///
    /// This is the documented exception to Phase 0's append-only invariant.
    /// See `docs/architecture/2026-05-13-graph-storage-decision.md`.
    pub fn clear_outgoing(&mut self, node: NodeId) {
        assert!(
            node.index() < self.nodes.len(),
            "Graph::clear_outgoing: node {} out of bounds",
            node.index()
        );
        let drained = self.edges.clear_outgoing(node);
        for target in drained {
            self.edges.remove_back_pointer(target, node);
        }
        self.revision = self
            .revision
            .checked_add(1)
            .expect("Graph::clear_outgoing: revision counter overflowed u64");
    }

    /// **W5-50 — GAP-G-01 closure (range side).** Revoke every range-dep
    /// registration held by `formula_node`. Clears both
    /// `formula_to_range_deps[formula_node]` and every stripe membership
    /// in `StripeIndex` (via `StripeIndex::clear_for_formula`). After
    /// this call, writes to cells in the OLD ranges no longer dirty
    /// `formula_node` via the precision-check path.
    ///
    /// Bumps `revision` once per call. Idempotent — a formula with no
    /// range deps is a no-op.
    ///
    /// Companion to `clear_outgoing`: the session-side `extract_and_register_deps`
    /// calls both before re-extracting the formula's new dep set.
    pub fn clear_range_deps_for_formula(&mut self, formula_node: NodeId) {
        assert!(
            formula_node.index() < self.nodes.len(),
            "Graph::clear_range_deps_for_formula: node {} out of bounds",
            formula_node.index()
        );
        self.formula_to_range_deps.remove(&formula_node);
        self.stripes.clear_for_formula(formula_node);
        self.revision = self
            .revision
            .checked_add(1)
            .expect("Graph::clear_range_deps_for_formula: revision counter overflowed u64");
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

    /// W5-50 — public accessor for the per-formula range-dep list. Returns
    /// an empty slice if the formula has no range deps (or doesn't exist).
    /// The runtime side uses this to build the supplemental adjacency for
    /// `topo::schedule_with_supplemental` (GAP-G-03 closure).
    pub fn range_deps_for(&self, formula_node: NodeId) -> &[RangeRef] {
        self.formula_to_range_deps
            .get(&formula_node)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// W5-50 — return the sheet a `RangeRef` resolves against. `None`
    /// means "use the formula's owning sheet" (the binder convention).
    /// Helper so runtime code doesn't have to match on `RangeRef`
    /// variants just to pull the sheet field.
    ///
    /// **W5-87 (Phase 4.6.A part 1):** returns `None` for both
    /// `SheetRef::Current` and `SheetRef::Name` (the latter is parser-
    /// only and shouldn't reach this code path in practice); `Some(id)`
    /// for `SheetRef::Id`. Callers that need post-resolution access
    /// should use the resolved `ExprPlan::CellRef.sheet` field instead.
    pub fn range_ref_sheet(range: &RangeRef) -> Option<SheetId> {
        match range {
            RangeRef::Cells { sheet, .. }
            | RangeRef::WholeColumn { sheet, .. }
            | RangeRef::WholeRow { sheet, .. } => sheet.id(),
            // **W5-139 (Phase 4.9.C):** intermediate R1C1 range —
            // shouldn't reach this point (storage canon lowers to
            // absolute before graph operations). Surface loudly.
            RangeRef::R1C1Cells { .. } => unreachable!(
                "range_ref_sheet: RangeRef::R1C1Cells is parser-intermediate; storage \
                 canon must lower to absolute Cells before graph queries."
            ),
        }
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
    use ql_formula_syntax::SheetRef;

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
                sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
                    sheet: SheetRef::Current,
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
                sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let col_b = RangeRef::WholeColumn {
            sheet: SheetRef::Current,
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
                sheet: SheetRef::Current,
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

    // ===== W5-50 (Phase 4 pre-V2): per-formula revocation API =====

    #[test]
    fn clear_outgoing_drops_edges_and_back_pointers() {
        // B1 depends on A1 and A2.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let a2 = g.add_cell_node(0, 1, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        g.add_edge(b1, a1);
        g.add_edge(b1, a2);
        assert_eq!(g.outgoing(b1), &[a1, a2]);
        assert_eq!(g.incoming(a1), &[b1]);
        assert_eq!(g.incoming(a2), &[b1]);
        let rev_before = g.revision();

        g.clear_outgoing(b1);

        assert!(g.outgoing(b1).is_empty());
        assert!(g.incoming(a1).is_empty(), "back-pointer dropped");
        assert!(g.incoming(a2).is_empty(), "back-pointer dropped");
        assert_eq!(g.revision(), rev_before + 1, "single revision bump");
    }

    #[test]
    fn clear_outgoing_preserves_other_dependents_back_pointers() {
        // B1 and C1 both depend on A1. Clearing B1 leaves C1's edge intact.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        let c1 = g.add_cell_node(0, 0, 2);
        g.add_edge(b1, a1);
        g.add_edge(c1, a1);

        g.clear_outgoing(b1);

        assert!(g.outgoing(b1).is_empty());
        assert_eq!(g.outgoing(c1), &[a1], "C1's edge untouched");
        assert_eq!(g.incoming(a1), &[c1], "A1's back-pointers now [c1]");
    }

    #[test]
    fn clear_outgoing_is_idempotent_and_handles_empty() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let rev = g.revision();
        g.clear_outgoing(a); // no edges; just bumps revision
        g.clear_outgoing(a); // idempotent
        assert_eq!(g.revision(), rev + 2);
        assert!(g.outgoing(a).is_empty());
    }

    #[test]
    fn clear_range_deps_for_formula_clears_stripes_and_map() {
        // B1 has SUM(A:A) + SUM(B1:B10): two stripes, two range-dep entries.
        let mut g = Graph::new();
        let b1 = g.add_cell_node(0, 0, 1);
        let col_a = RangeRef::WholeColumn {
            sheet: SheetRef::Current,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let col_b_part = RangeRef::Cells {
            sheet: SheetRef::Current,
            start_col: 1,
            start_row: 0,
            end_col: 1,
            end_row: 9,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        g.register_range_dependency(b1, col_a, 0);
        g.register_range_dependency(b1, col_b_part, 0);
        assert_eq!(g.range_dependency_count(), 2);
        assert_eq!(g.stripe_index().stripe_count(), 2);
        let rev_before = g.revision();

        g.clear_range_deps_for_formula(b1);

        assert_eq!(g.range_dependency_count(), 0);
        assert_eq!(
            g.stripe_index().stripe_count(),
            0,
            "stripes pruned to empty"
        );
        // A5 / B5 no longer find B1 as a candidate.
        assert!(g.dependents_for_cell(0, 5, 0).is_empty());
        assert!(g.dependents_for_cell(0, 5, 1).is_empty());
        assert_eq!(g.revision(), rev_before + 1);
    }

    #[test]
    fn clear_range_deps_preserves_other_formulas() {
        // B1 and C1 both register A:A. Clearing B1 leaves C1.
        let mut g = Graph::new();
        let b1 = g.add_cell_node(0, 0, 1);
        let c1 = g.add_cell_node(0, 0, 2);
        let col_a = RangeRef::WholeColumn {
            sheet: SheetRef::Current,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        g.register_range_dependency(b1, col_a.clone(), 0);
        g.register_range_dependency(c1, col_a, 0);
        assert_eq!(g.stripe_index().stripe_count(), 1);

        g.clear_range_deps_for_formula(b1);

        // C1 still registered.
        assert_eq!(g.range_dependency_count(), 1);
        assert_eq!(g.stripe_index().stripe_count(), 1, "stripe stays");
        let deps = g.dependents_for_cell(0, 5, 0);
        assert_eq!(deps, vec![c1]);
    }

    #[test]
    fn rebind_workflow_no_stale_false_circ() {
        // GAP-G-01 / H3 acceptance: clear_outgoing breaks the false-cycle
        // chain after rebind.
        //   1. B1 = "=A1"           → add_edge(B1, A1)
        //   2. B1 = "=1" (rebind)   → clear_outgoing(B1)
        //   3. A1 = "=B1"           → add_edge(A1, B1)
        // Tarjan over {A1, B1} must NOT report a cycle.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        g.add_edge(b1, a1); // step 1
        g.clear_outgoing(b1); // step 2 (rebind to constant)
        g.add_edge(a1, b1); // step 3

        let sched = crate::topo::schedule(&g, &[a1, b1]);
        assert!(sched.cycled.is_empty(), "no false #CIRC! after revocation");
        // Dependency-first order: B1 then A1 (A1 depends on B1).
        assert_eq!(sched.sorted, vec![b1, a1]);
    }

    #[test]
    fn rebind_workflow_no_stale_stripe_dirty() {
        // GAP-G-01 / H4 acceptance: clear_range_deps_for_formula breaks
        // the stale-dirty chain after range rebind.
        //   1. B1 = "=SUM(A:A)"    → register_range_dependency(B1, A:A)
        //   2. B1 = "=SUM(B:B)" (rebind)
        //        → clear_range_deps_for_formula(B1)
        //        → register_range_dependency(B1, B:B)
        //   3. write A5            → dependents_for_cell(A, 5) must NOT contain B1
        let mut g = Graph::new();
        let b1 = g.add_cell_node(0, 0, 1);
        let col_a = RangeRef::WholeColumn {
            sheet: SheetRef::Current,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let col_b = RangeRef::WholeColumn {
            sheet: SheetRef::Current,
            start_col: 1,
            end_col: 1,
            abs_start: false,
            abs_end: false,
        };
        g.register_range_dependency(b1, col_a, 0); // step 1
        g.clear_range_deps_for_formula(b1); // step 2a
        g.register_range_dependency(b1, col_b, 0); // step 2b

        // step 3: A5 no longer dirties B1.
        assert!(g.dependents_for_cell(0, 5, 0).is_empty());
        // B5 still dirties B1 (new range).
        assert_eq!(g.dependents_for_cell(0, 5, 1), vec![b1]);
    }

    #[test]
    fn determinism_rebind_same_plan_same_edges() {
        // Rebinding to the same target list (same plan) must yield the
        // same outgoing edge order — Tarjan's emission order depends on
        // adjacency order, so this is observable downstream.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 1, 0);
        let c1 = g.add_cell_node(0, 2, 0);
        let f = g.add_cell_node(0, 0, 3);

        // Initial bind.
        g.add_edge(f, a1);
        g.add_edge(f, b1);
        g.add_edge(f, c1);
        let initial: Vec<_> = g.outgoing(f).to_vec();

        // Rebind to identical targets.
        g.clear_outgoing(f);
        g.add_edge(f, a1);
        g.add_edge(f, b1);
        g.add_edge(f, c1);
        let rebound: Vec<_> = g.outgoing(f).to_vec();

        assert_eq!(initial, rebound, "edge order identical post-rebind");
    }
}
