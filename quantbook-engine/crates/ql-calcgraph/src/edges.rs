//! Per-node adjacency storage for the calc graph.
//!
//! Per spec Decision A (T1-D02): hand-rolled compact adjacency vectors. petgraph would be
//! convenient but its `StableGraph` allocates a `HashSet<EdgeIndex>` per node — orders of
//! magnitude more memory than we can afford at 25M-cell scale.
//!
//! Phase 0 uses plain `Vec<NodeId>` per direction per node. The Week 3 plan flagged
//! `SmallVec<[NodeId; 4]>` as an option (most cells depend on ≤4 things, inline storage
//! avoids the allocation). That optimization is a Week 4 perf concern, NOT a Week 3
//! requirement — Phase 0 ships with plain `Vec`s so we don't add a new workspace dep.
//!
//! The opus-arch audit + the reference deep-read both flagged that HyperFormula's
//! `Array.includes()`-based dedup on edge insertion is O(out-degree) per add
//! (`Graph.ts:177-181`, internally acknowledged at `Graph.ts:25-27`). Quantbook avoids the
//! dedup cost entirely by NOT deduplicating on insert — callers must not double-add the
//! same edge. If profiling later shows duplicate edges are a problem, switching to
//! `FxHashSet<NodeId>` per node is a localized change.

use crate::node::NodeId;

/// Per-node outgoing + incoming adjacency vectors.
///
/// Outgoing edge `u -> v` means "u depends on v" — when v changes, u must recompute.
/// Incoming is the reverse, for the dirty-propagation walk (W3-2).
///
/// Invariants:
/// - `outgoing.len() == incoming.len() == graph.node_count()`. The `Graph` constructor
///   maintains this via `push_node()` calls below.
/// - For every `v in outgoing[u]`, `u in incoming[v]` (symmetry). `add_edge` maintains.
/// - Phase 0 has NO removal. `remove_edge` is a Phase 3+ feature when row/col delete lands.
#[derive(Clone, Debug, Default)]
pub struct AdjacencyVectors {
    outgoing: Vec<Vec<NodeId>>,
    incoming: Vec<Vec<NodeId>>,
}

impl AdjacencyVectors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn node_count(&self) -> usize {
        debug_assert_eq!(self.outgoing.len(), self.incoming.len());
        self.outgoing.len()
    }

    /// Reserve adjacency slots for a newly-allocated node. The `Graph` calls this once per
    /// `add_*_node` so adjacency lookups by `NodeId` are always in bounds.
    pub fn push_node(&mut self) {
        self.outgoing.push(Vec::new());
        self.incoming.push(Vec::new());
    }

    /// Add a directed edge `from -> to` ("from depends on to"). Updates both adjacency
    /// vectors so reverse lookups (incoming) are O(1) after construction.
    ///
    /// Panics if either id is out of bounds — the graph constructor is responsible for
    /// calling `push_node()` before any edge that references the new id.
    ///
    /// No dedup: caller must not double-add. Phase 0 callers (range registration,
    /// formula-region wiring) add each edge exactly once at construction time.
    pub fn add_edge(&mut self, from: NodeId, to: NodeId) {
        let from_idx = from.index();
        let to_idx = to.index();
        assert!(
            from_idx < self.outgoing.len(),
            "add_edge: from NodeId({from_idx}) out of bounds (have {} nodes)",
            self.outgoing.len()
        );
        assert!(
            to_idx < self.incoming.len(),
            "add_edge: to NodeId({to_idx}) out of bounds (have {} nodes)",
            self.incoming.len()
        );
        self.outgoing[from_idx].push(to);
        self.incoming[to_idx].push(from);
    }

    /// All nodes that `node` depends on (`node -> *`). Borrowed slice — Phase 0 won't mutate
    /// during a dirty walk.
    pub fn outgoing(&self, node: NodeId) -> &[NodeId] {
        &self.outgoing[node.index()]
    }

    /// All nodes that depend on `node` (`* -> node`). Reverse adjacency for dirty propagation.
    pub fn incoming(&self, node: NodeId) -> &[NodeId] {
        &self.incoming[node.index()]
    }

    pub fn outgoing_count(&self, node: NodeId) -> usize {
        self.outgoing[node.index()].len()
    }

    pub fn incoming_count(&self, node: NodeId) -> usize {
        self.incoming[node.index()].len()
    }

    /// Total edge count (sum of all outgoing lists). Used by the A5 acceptance assertion
    /// that range-node prefix-SUM produces <2× formula count edges.
    pub fn edge_count(&self) -> usize {
        self.outgoing.iter().map(Vec::len).sum()
    }

    /// Drain every outgoing edge from `from` and return the prior target list.
    /// Caller is responsible for removing the back-pointer in each target's
    /// `incoming` slot (see `Graph::clear_outgoing` for the wrapper that does
    /// both halves of the symmetric invariant).
    ///
    /// Phase 4 / W5-50: introduced for the per-formula edge revocation API
    /// that fixes GAP-G-01 (rebind staleness). Append-only is no longer the
    /// global invariant — the revocation path is the documented exception.
    ///
    /// Returns the drained `Vec<NodeId>` so the caller can iterate to clean
    /// up `incoming`. The internal storage is left as an empty `Vec`, which
    /// matches the layout of a brand-new node and preserves the
    /// `outgoing.len() == node_count` invariant.
    pub fn clear_outgoing(&mut self, from: NodeId) -> Vec<NodeId> {
        let idx = from.index();
        assert!(
            idx < self.outgoing.len(),
            "clear_outgoing: NodeId({idx}) out of bounds (have {} nodes)",
            self.outgoing.len()
        );
        std::mem::take(&mut self.outgoing[idx])
    }

    /// Remove a single `from -> target` back-pointer from `incoming[target]`.
    /// Used by `Graph::clear_outgoing` after `clear_outgoing` returns the
    /// drained outgoing list — for each target, walk `incoming` once and
    /// retain only entries that are NOT `from`.
    ///
    /// Phase 0's append-only contract had no caller-driven dedup, so a
    /// `(from -> target)` edge added twice has two back-pointers in
    /// `incoming[target]`. `retain` removes all of them, which is the
    /// intended behavior for the per-formula revocation path: clearing
    /// a formula's outgoing list must drop every back-pointer for that
    /// formula, not just one.
    pub fn remove_back_pointer(&mut self, target: NodeId, from: NodeId) {
        let idx = target.index();
        assert!(
            idx < self.incoming.len(),
            "remove_back_pointer: NodeId({idx}) out of bounds (have {} nodes)",
            self.incoming.len()
        );
        self.incoming[idx].retain(|&n| n != from);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_adjacency_is_zero_everywhere() {
        let a = AdjacencyVectors::new();
        assert_eq!(a.node_count(), 0);
        assert_eq!(a.edge_count(), 0);
    }

    #[test]
    fn push_node_grows_both_directions() {
        let mut a = AdjacencyVectors::new();
        a.push_node();
        assert_eq!(a.node_count(), 1);
        a.push_node();
        a.push_node();
        assert_eq!(a.node_count(), 3);
        assert!(a.outgoing(NodeId(0)).is_empty());
        assert!(a.incoming(NodeId(2)).is_empty());
    }

    #[test]
    fn add_edge_populates_both_sides() {
        let mut a = AdjacencyVectors::new();
        a.push_node(); // 0
        a.push_node(); // 1
        a.add_edge(NodeId(0), NodeId(1));
        assert_eq!(a.outgoing(NodeId(0)), &[NodeId(1)]);
        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0)]);
        assert_eq!(a.outgoing(NodeId(1)), &[]); // 1 doesn't depend on anything
        assert_eq!(a.incoming(NodeId(0)), &[]); // nothing depends on 0
        assert_eq!(a.edge_count(), 1);
    }

    #[test]
    fn diamond_dependency() {
        // 0 -> {1, 2} -> 3
        let mut a = AdjacencyVectors::new();
        for _ in 0..4 {
            a.push_node();
        }
        a.add_edge(NodeId(0), NodeId(1));
        a.add_edge(NodeId(0), NodeId(2));
        a.add_edge(NodeId(1), NodeId(3));
        a.add_edge(NodeId(2), NodeId(3));
        assert_eq!(a.edge_count(), 4);
        assert_eq!(a.outgoing_count(NodeId(0)), 2);
        assert_eq!(a.incoming_count(NodeId(3)), 2);
        // Order of insertion preserved (no dedup, no sort).
        let out0: &[NodeId] = a.outgoing(NodeId(0));
        assert_eq!(out0, &[NodeId(1), NodeId(2)]);
    }

    #[test]
    fn multiple_edges_to_same_target_not_deduped() {
        // Phase 0 explicitly does NOT dedup — see module docstring.
        let mut a = AdjacencyVectors::new();
        a.push_node();
        a.push_node();
        a.add_edge(NodeId(0), NodeId(1));
        a.add_edge(NodeId(0), NodeId(1));
        assert_eq!(a.outgoing(NodeId(0)), &[NodeId(1), NodeId(1)]);
        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0), NodeId(0)]);
    }

    #[test]
    #[should_panic(expected = "out of bounds")]
    fn add_edge_from_oob_panics() {
        let mut a = AdjacencyVectors::new();
        a.push_node();
        a.add_edge(NodeId(5), NodeId(0));
    }

    #[test]
    #[should_panic(expected = "out of bounds")]
    fn add_edge_to_oob_panics() {
        let mut a = AdjacencyVectors::new();
        a.push_node();
        a.add_edge(NodeId(0), NodeId(5));
    }

    // ===== W5-50 (Phase 4 pre-V2): edge revocation =====

    #[test]
    fn clear_outgoing_returns_prior_targets_and_empties() {
        let mut a = AdjacencyVectors::new();
        for _ in 0..3 {
            a.push_node();
        }
        a.add_edge(NodeId(0), NodeId(1));
        a.add_edge(NodeId(0), NodeId(2));
        assert_eq!(a.outgoing(NodeId(0)).len(), 2);

        let drained = a.clear_outgoing(NodeId(0));
        assert_eq!(drained, vec![NodeId(1), NodeId(2)]);
        assert!(a.outgoing(NodeId(0)).is_empty());
        // Back-pointers untouched by clear_outgoing alone (caller's job).
        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0)]);
    }

    #[test]
    fn clear_outgoing_on_node_with_no_edges_is_empty() {
        let mut a = AdjacencyVectors::new();
        a.push_node();
        let drained = a.clear_outgoing(NodeId(0));
        assert!(drained.is_empty());
        assert!(a.outgoing(NodeId(0)).is_empty());
    }

    #[test]
    #[should_panic(expected = "out of bounds")]
    fn clear_outgoing_oob_panics() {
        let mut a = AdjacencyVectors::new();
        a.push_node();
        let _ = a.clear_outgoing(NodeId(5));
    }

    #[test]
    fn remove_back_pointer_removes_all_matching_entries() {
        // Two `from -> target` edges → two back-pointers; remove drops both.
        let mut a = AdjacencyVectors::new();
        a.push_node();
        a.push_node();
        a.add_edge(NodeId(0), NodeId(1));
        a.add_edge(NodeId(0), NodeId(1));
        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0), NodeId(0)]);

        a.remove_back_pointer(NodeId(1), NodeId(0));
        assert!(a.incoming(NodeId(1)).is_empty());
    }

    #[test]
    fn remove_back_pointer_preserves_others() {
        // (0,1) and (2,1); removing (0,1)'s back-pointer leaves (2,1)'s.
        let mut a = AdjacencyVectors::new();
        for _ in 0..3 {
            a.push_node();
        }
        a.add_edge(NodeId(0), NodeId(1));
        a.add_edge(NodeId(2), NodeId(1));
        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0), NodeId(2)]);

        a.remove_back_pointer(NodeId(1), NodeId(0));
        assert_eq!(a.incoming(NodeId(1)), &[NodeId(2)]);
    }
}
