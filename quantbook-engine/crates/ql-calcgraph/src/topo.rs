//! Topological scheduler — iterative Tarjan SCC over a dirty subset.
//!
//! Per CORR-23 (Week 3 Day 0 deep-read finding): both Formualizer (`engine/scheduler.rs:
//! 88-239`) and HyperFormula (`TopSort.ts:18-92`) use iterative Tarjan SCC rather than
//! Kahn's algorithm for topological scheduling. Reasons:
//!
//! 1. **Cycle detection in the same pass.** Tarjan partitions nodes into SCCs; SCCs of
//!    size 1 with no self-loop are acyclic (go to `sorted`), everything else is cyclic
//!    (goes to `cycled`). Kahn would need a separate "did all dirty nodes emit?" check
//!    after the toposort to identify cycle membership.
//!
//! 2. **Direct API for the Phase 0 cycle policy.** The spec's Phase 0 minimum: cycled
//!    cells become `CellError(Cycle)`; non-cycled cells evaluate in topological order.
//!    The `(sorted, cycled)` partition is exactly what the evaluator wants.
//!
//! 3. **Iterative implementation handles deep graphs.** A 10K-deep dependency chain
//!    would blow the default 8 MB stack with a recursive Tarjan. HyperFormula made the
//!    same choice for JS call-stack reasons; ours is for arbitrary-depth Rust workbooks.
//!
//! 4. **Phase 0 minimum is non-iteration**: cycles are terminal errors, not states to
//!    converge. Full iteration (with a `max_iterations` config) lands Phase 4+ when the
//!    function library includes goal-seek / iterative-solve UDFs.
//!
//! ## Algorithm shape
//!
//! Standard iterative Tarjan with two stacks:
//! - `dfs_stack: Vec<(NodeId, usize)>` — explicit DFS frame: (node, next-child-index).
//!   Replaces the recursion stack of the textbook algorithm.
//! - `scc_stack: Vec<NodeId>` — the Tarjan SCC stack of "currently-being-explored" nodes
//!   that may belong to the same SCC as the current root.
//!
//! Per-node state in `FxHashMap`-equivalent (we use `std::HashMap` to avoid a new dep):
//! - `indices[v]: u32` — DFS discovery order; assigned on first visit.
//! - `lowlinks[v]: u32` — smallest index reachable from v's subtree.
//! - `on_scc_stack[v]: bool` — is v currently on `scc_stack`?
//!
//! When a node's lowlink equals its index after all children are processed, it's the
//! root of an SCC. We pop the SCC stack down to that node.
//!
//! ## Edge filtering
//!
//! The scheduler operates ON the dirty subset only. Edges to non-dirty nodes are skipped
//! (those nodes aren't being re-evaluated; their current values are read as-is). A
//! `dirty: HashSet<NodeId>` membership check filters `graph.outgoing(v)`.
//!
//! ## Output ordering
//!
//! Tarjan emits SCCs in **reverse topological order of the condensation**. For our
//! graph orientation (edge `u → v` means "u depends on v"), this is exactly dependency-
//! first order: when we collect `sorted` by appending SCCs as Tarjan finds them, the
//! result is `[dependencies, ..., dependents]`. Callers evaluate `sorted[0]` first.

use std::collections::{HashMap, HashSet};

use crate::graph::Graph;
use crate::node::NodeId;

/// The output of a scheduling pass.
///
/// `sorted` is in dependency-first order: evaluate `sorted[0]` first, then `sorted[1]`,
/// etc. `cycled` is unordered — every cycled node should be assigned a cycle error.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Schedule {
    pub sorted: Vec<NodeId>,
    pub cycled: Vec<NodeId>,
}

impl Schedule {
    pub fn is_empty(&self) -> bool {
        self.sorted.is_empty() && self.cycled.is_empty()
    }

    pub fn total_count(&self) -> usize {
        self.sorted.len() + self.cycled.len()
    }
}

/// Schedule the given dirty subset for evaluation. Returns `(sorted, cycled)` where
/// `sorted` is in dependency-first topological order and `cycled` contains all nodes in
/// non-trivial strongly connected components (size > 1) plus all self-loops (size 1 + an
/// edge to self).
///
/// Edges to nodes outside `dirty_subset` are not traversed — those nodes aren't being
/// re-evaluated, just read.
///
/// Duplicate entries in `dirty_subset` are tolerated (deduped internally via a HashSet).
pub fn schedule(graph: &Graph, dirty_subset: &[NodeId]) -> Schedule {
    let dirty: HashSet<NodeId> = dirty_subset.iter().copied().collect();
    if dirty.is_empty() {
        return Schedule::default();
    }

    let mut indices: HashMap<NodeId, u32> = HashMap::with_capacity(dirty.len());
    let mut lowlinks: HashMap<NodeId, u32> = HashMap::with_capacity(dirty.len());
    let mut on_scc_stack: HashMap<NodeId, bool> = HashMap::with_capacity(dirty.len());
    let mut scc_stack: Vec<NodeId> = Vec::with_capacity(dirty.len());
    let mut next_index: u32 = 0;

    let mut sorted: Vec<NodeId> = Vec::with_capacity(dirty.len());
    let mut cycled: Vec<NodeId> = Vec::new();

    // Visit every node in the dirty subset. Iteration order is from the input slice (not
    // the HashSet's randomized order) so callers get deterministic schedules from
    // deterministic inputs. Deduplicated via `indices.contains_key`.
    for &seed in dirty_subset {
        if indices.contains_key(&seed) {
            continue;
        }
        tarjan_dfs(
            seed,
            graph,
            &dirty,
            &mut indices,
            &mut lowlinks,
            &mut on_scc_stack,
            &mut scc_stack,
            &mut next_index,
            &mut sorted,
            &mut cycled,
        );
    }

    Schedule { sorted, cycled }
}

#[allow(clippy::too_many_arguments)]
fn tarjan_dfs(
    seed: NodeId,
    graph: &Graph,
    dirty: &HashSet<NodeId>,
    indices: &mut HashMap<NodeId, u32>,
    lowlinks: &mut HashMap<NodeId, u32>,
    on_scc_stack: &mut HashMap<NodeId, bool>,
    scc_stack: &mut Vec<NodeId>,
    next_index: &mut u32,
    sorted: &mut Vec<NodeId>,
    cycled: &mut Vec<NodeId>,
) {
    // Explicit DFS frame: (node, child index in outgoing(node) — within-dirty filter).
    // We compute the child slice once at first visit + iterate it index-by-index across
    // frames. Filtering "is this child in dirty?" happens at child-visit time so we don't
    // pre-allocate filtered child vectors per node (the hot path under no-cycles is one
    // outgoing-slice scan per node, period).
    let mut dfs_stack: Vec<(NodeId, usize)> = Vec::new();

    // First visit of seed.
    visit_first(seed, next_index, indices, lowlinks, on_scc_stack, scc_stack);
    dfs_stack.push((seed, 0));

    while let Some(&(v, child_idx)) = dfs_stack.last() {
        let children = graph.outgoing(v);

        // Find the next not-yet-considered child that's in the dirty subset.
        let mut next_child: Option<NodeId> = None;
        let mut new_child_idx = child_idx;
        while new_child_idx < children.len() {
            let candidate = children[new_child_idx];
            new_child_idx += 1;
            if dirty.contains(&candidate) {
                next_child = Some(candidate);
                break;
            }
        }

        // Update this frame's child cursor regardless of whether we recurse or finish.
        let frame_idx = dfs_stack.len() - 1;
        dfs_stack[frame_idx].1 = new_child_idx;

        if let Some(w) = next_child {
            if !indices.contains_key(&w) {
                // Unvisited dirty child — recurse.
                visit_first(w, next_index, indices, lowlinks, on_scc_stack, scc_stack);
                dfs_stack.push((w, 0));
            } else if *on_scc_stack.get(&w).unwrap_or(&false) {
                // Back-edge or cross-edge to a node currently on the SCC stack — update
                // v's lowlink with w's index.
                let w_idx = indices[&w];
                let v_low = lowlinks[&v];
                if w_idx < v_low {
                    lowlinks.insert(v, w_idx);
                }
            }
            // Else: w is in a completed SCC; ignore the cross-edge.
        } else {
            // All children processed — post-order completion.
            dfs_stack.pop();

            // If v is the root of an SCC, pop it off the SCC stack.
            if lowlinks[&v] == indices[&v] {
                let mut scc: Vec<NodeId> = Vec::new();
                loop {
                    let w = scc_stack
                        .pop()
                        .expect("scc_stack drained mid-pop — algorithm invariant violated");
                    on_scc_stack.insert(w, false);
                    scc.push(w);
                    if w == v {
                        break;
                    }
                }

                // Classify the SCC.
                let is_cycle = scc.len() > 1
                    || (scc.len() == 1
                        && graph
                            .outgoing(scc[0])
                            .iter()
                            .any(|&t| t == scc[0] && dirty.contains(&t)));
                if is_cycle {
                    cycled.extend(scc);
                } else {
                    // Single acyclic node — append to sorted.
                    sorted.extend(scc);
                }
            }

            // Propagate v's lowlink up to its parent (post-order).
            if let Some(&(parent, _)) = dfs_stack.last() {
                let v_low = lowlinks[&v];
                let p_low = lowlinks[&parent];
                if v_low < p_low {
                    lowlinks.insert(parent, v_low);
                }
            }
        }
    }
}

fn visit_first(
    v: NodeId,
    next_index: &mut u32,
    indices: &mut HashMap<NodeId, u32>,
    lowlinks: &mut HashMap<NodeId, u32>,
    on_scc_stack: &mut HashMap<NodeId, bool>,
    scc_stack: &mut Vec<NodeId>,
) {
    let idx = *next_index;
    *next_index = next_index
        .checked_add(1)
        .expect("Tarjan next_index overflow u32 — graphs > 4.3B nodes are not supported");
    indices.insert(v, idx);
    lowlinks.insert(v, idx);
    scc_stack.push(v);
    on_scc_stack.insert(v, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: ids of `n` cell nodes in row 0, distinct columns.
    fn n_cells(g: &mut Graph, n: u32) -> Vec<NodeId> {
        (0..n).map(|c| g.add_cell_node(0, 0, c)).collect()
    }

    #[test]
    fn empty_dirty_returns_empty_schedule() {
        let g = Graph::new();
        let s = schedule(&g, &[]);
        assert!(s.is_empty());
        assert_eq!(s.total_count(), 0);
    }

    #[test]
    fn single_node_no_edges_goes_to_sorted() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let s = schedule(&g, &[a]);
        assert_eq!(s.sorted, vec![a]);
        assert!(s.cycled.is_empty());
    }

    #[test]
    fn single_node_with_self_loop_goes_to_cycled() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        g.add_edge(a, a);
        let s = schedule(&g, &[a]);
        assert!(s.sorted.is_empty());
        assert_eq!(s.cycled, vec![a]);
    }

    #[test]
    fn linear_chain_yields_dependency_first_order() {
        // A -> B -> C. A depends on B; B depends on C. Eval order: C, B, A.
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 3);
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        g.add_edge(a, b);
        g.add_edge(b, c);
        let s = schedule(&g, &[a, b, c]);
        assert_eq!(s.sorted, vec![c, b, a]);
        assert!(s.cycled.is_empty());
    }

    #[test]
    fn diamond_dependency_orders_correctly() {
        // A -> {B1, B2} -> C. Eval order: C first, then B1+B2 in either order, then A.
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 4);
        let (a, b1, b2, c) = (ids[0], ids[1], ids[2], ids[3]);
        g.add_edge(a, b1);
        g.add_edge(a, b2);
        g.add_edge(b1, c);
        g.add_edge(b2, c);
        let s = schedule(&g, &[a, b1, b2, c]);
        // C must come first
        assert_eq!(s.sorted[0], c);
        // A must come last
        assert_eq!(s.sorted[3], a);
        // B1 and B2 must come between
        let mid: std::collections::HashSet<_> = [s.sorted[1], s.sorted[2]].into_iter().collect();
        assert_eq!(mid, [b1, b2].into_iter().collect());
        assert!(s.cycled.is_empty());
    }

    #[test]
    fn two_node_cycle_goes_to_cycled() {
        // A <-> B. Both belong to the same SCC of size 2.
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 2);
        let (a, b) = (ids[0], ids[1]);
        g.add_edge(a, b);
        g.add_edge(b, a);
        let s = schedule(&g, &[a, b]);
        assert!(s.sorted.is_empty());
        assert_eq!(s.cycled.len(), 2);
        let cycled: std::collections::HashSet<_> = s.cycled.iter().copied().collect();
        assert_eq!(cycled, [a, b].into_iter().collect());
    }

    #[test]
    fn mixed_cycle_and_acyclic_in_same_dirty_subset() {
        // Cycle {A, B} disjoint from acyclic chain C -> D -> E.
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 5);
        let (a, b, c, d, e) = (ids[0], ids[1], ids[2], ids[3], ids[4]);
        g.add_edge(a, b);
        g.add_edge(b, a); // cycle
        g.add_edge(c, d);
        g.add_edge(d, e);
        let s = schedule(&g, &[a, b, c, d, e]);
        // Cycled has both a and b.
        let cycled: std::collections::HashSet<_> = s.cycled.iter().copied().collect();
        assert_eq!(cycled, [a, b].into_iter().collect());
        // Sorted has [e, d, c] (dependency-first).
        assert_eq!(s.sorted, vec![e, d, c]);
    }

    #[test]
    fn dirty_subset_filters_edges_to_clean_nodes() {
        // A -> B -> C in graph; dirty subset = [A, B] only. Edge B -> C should be
        // ignored (C is clean / read-as-is).
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 3);
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        g.add_edge(a, b);
        g.add_edge(b, c);
        let s = schedule(&g, &[a, b]);
        assert_eq!(s.sorted, vec![b, a]);
        assert!(s.cycled.is_empty());
        // C never appears.
        assert!(!s.sorted.contains(&c));
        assert!(!s.cycled.contains(&c));
    }

    #[test]
    fn duplicate_seeds_are_deduped() {
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        let s = schedule(&g, &[a, a, a, a]);
        assert_eq!(s.sorted, vec![a]);
    }

    #[test]
    fn deep_linear_chain_no_stack_overflow() {
        // 10,000-node linear chain. A recursive Tarjan would blow the 8MB stack ~around
        // depth 8k-16k depending on frame size. The iterative implementation should
        // handle this trivially.
        const N: u32 = 10_000;
        let mut g = Graph::new();
        let ids: Vec<NodeId> = (0..N).map(|i| g.add_cell_node(0, i, 0)).collect();
        for i in 0..(N as usize - 1) {
            g.add_edge(ids[i], ids[i + 1]); // i depends on i+1
        }
        let s = schedule(&g, &ids);
        assert_eq!(s.sorted.len(), N as usize);
        assert!(s.cycled.is_empty());
        // Last node (highest index) must come first (it's the deepest dependency).
        assert_eq!(s.sorted[0], ids[(N - 1) as usize]);
        // Source (index 0) must come last.
        assert_eq!(*s.sorted.last().unwrap(), ids[0]);
    }

    #[test]
    fn three_node_cycle() {
        // A -> B -> C -> A.
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 3);
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        g.add_edge(a, b);
        g.add_edge(b, c);
        g.add_edge(c, a);
        let s = schedule(&g, &[a, b, c]);
        assert!(s.sorted.is_empty());
        assert_eq!(s.cycled.len(), 3);
    }

    #[test]
    fn cycle_with_acyclic_dependent() {
        // {A, B} cycle, plus C -> A. C should be in sorted (depends on a cycled SCC, but
        // C itself is not in the cycle).
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 3);
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        g.add_edge(a, b);
        g.add_edge(b, a);
        g.add_edge(c, a);
        let s = schedule(&g, &[a, b, c]);
        // a, b cycled; c sorted.
        let cycled: std::collections::HashSet<_> = s.cycled.iter().copied().collect();
        assert_eq!(cycled, [a, b].into_iter().collect());
        assert_eq!(s.sorted, vec![c]);
    }

    #[test]
    fn self_loop_in_dirty_subset_only_cycles_if_target_also_dirty() {
        // Self-loop A -> A. If A is in dirty, it's cycled. If A's "self" edge target
        // happened to point to a non-dirty version of itself, the cycle detection skips
        // it — but that's a contrived case since `NodeId` identity is global. Test the
        // straightforward case: self-loop + dirty = cycled.
        let mut g = Graph::new();
        let a = g.add_cell_node(0, 0, 0);
        g.add_edge(a, a);
        let s = schedule(&g, &[a]);
        assert_eq!(s.cycled, vec![a]);
    }

    #[test]
    fn nodes_not_in_dirty_subset_never_appear_in_output() {
        let mut g = Graph::new();
        let ids = n_cells(&mut g, 5);
        let (a, b, _c, _d, _e) = (ids[0], ids[1], ids[2], ids[3], ids[4]);
        g.add_edge(a, b);
        let s = schedule(&g, &[a, b]);
        assert_eq!(s.total_count(), 2);
        // 3 nodes exist in the graph but only 2 are in the schedule.
        for node in &s.sorted {
            assert!([a, b].contains(node));
        }
    }
}
