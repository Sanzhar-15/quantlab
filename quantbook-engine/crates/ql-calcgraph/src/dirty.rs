//! Per-chunk dirty bitmap + reverse-adjacency propagation walk.
//!
//! Per spec Part V §4 Week 3 Day 2 + the W3-2 commit spec in `.plans/_active.md`. This is
//! where Phase 0 acceptance gate **OG-05** lives: "single-cell write marks only the
//! affected chunk." Without per-chunk granularity, a single-cell write would dirty the
//! whole column → 25M-cell `=A*2` (OG-02) recomputes ALL chunks on every edit → fail.
//!
//! ## Data model
//!
//! `ChunkDirtySet` is a sparse `BTreeMap<ChunkKey, Vec<u64>>` — only chunks with at least
//! one dirty cell appear. Within each chunk, dirtiness is a word-packed bitmap of size
//! `chunk_rows` bits (rounded up to whole `u64` words). A workbook with one dirty cell
//! has exactly one entry in the BTreeMap and one `u64` word with one bit set.
//!
//! `BTreeMap` (not `FxHashMap`) for two reasons:
//! 1. Deterministic iteration order — tests and the W3-7 graph-profile.json export both
//!    rely on stable ordering.
//! 2. Range queries by sheet+col, e.g. `chunks_for_column(sheet, col)` for the OG-05
//!    assertion, fall out naturally from the ordered key `(sheet, col, chunk_idx)`.
//!
//! The hot path's dominant cost is the bitset set/test, not the BTreeMap lookup —
//! workbooks have O(thousands) of dirty chunks per edit at worst.
//!
//! ## Propagation
//!
//! `propagate_from_cells(graph, dirty, seeds)` walks `graph.incoming(node)` BFS from each
//! seed. Each visited dependent node has its chunks marked dirty:
//! - `Node::Cell` → mark exactly one bit (the cell's chunk + bit-within-chunk).
//! - `Node::FormulaRegion` → mark all chunks the `target_rect` spans (every bit within
//!   the rect range, since the whole region recomputes).
//! - `Node::Range` → SKIPPED (range nodes don't own chunks; they're edge intermediaries
//!   from formula-vertex to source cells).
//! - `Node::Spill` → panics (Phase 3+ feature; should never appear in Phase 0).
//!
//! Cycles in the dirty walk are tolerated via the `visited` set: a node is processed at
//! most once even if the graph contains a self-loop or longer cycle. Cycle DETECTION (and
//! the `(sorted, cycled)` partition for the scheduler) lives in W3-3 `topo.rs`.

use std::collections::{BTreeMap, HashSet, VecDeque};

use ql_types::{ColId, RowId, SheetId, MAX_ROW};

use crate::graph::Graph;
use crate::node::{Node, NodeId};

/// Identifies a chunk in a workbook: `(sheet, col, chunk_idx)`. Chunk N covers rows
/// `[N * chunk_rows, (N+1) * chunk_rows)`. Ordering is lexicographic on the tuple so
/// `BTreeMap` iteration groups all chunks of a column together.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChunkKey {
    pub sheet: SheetId,
    pub col: ColId,
    pub chunk_idx: u32,
}

/// Sparse per-chunk dirty bitmap, parameterized by `chunk_rows`.
///
/// Construction takes the chunk size as a parameter because the calc-graph doesn't depend
/// on `ql-storage` directly — the caller (Week 4 `ql-exec`) reads `chunk_rows` from the
/// `ColumnStore` it's iterating and passes it in.
#[derive(Clone, Debug)]
pub struct ChunkDirtySet {
    chunk_rows: u32,
    chunks: BTreeMap<ChunkKey, Vec<u64>>,
}

impl ChunkDirtySet {
    /// New empty dirty set with the given chunk size in rows.
    ///
    /// Per no-fallbacks rule: invalid `chunk_rows == 0` panics rather than silently
    /// substituting a default — a zero-row chunk would divide-by-zero in `chunk_idx` math.
    pub fn new(chunk_rows: u32) -> Self {
        assert!(chunk_rows > 0, "ChunkDirtySet::new: chunk_rows must be > 0");
        Self {
            chunk_rows,
            chunks: BTreeMap::new(),
        }
    }

    pub fn chunk_rows(&self) -> u32 {
        self.chunk_rows
    }

    /// Count of distinct (sheet, col, chunk_idx) entries — i.e. chunks with at least one
    /// dirty bit. NOT a count of dirty cells.
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Count of dirty chunks in a single column. The OG-05 acceptance assertion looks at
    /// this: a single-cell write to `(sheet, col, *)` should produce exactly 1 here.
    pub fn chunks_in_column(&self, sheet: SheetId, col: ColId) -> usize {
        let lo = ChunkKey {
            sheet,
            col,
            chunk_idx: 0,
        };
        let hi = ChunkKey {
            sheet,
            col,
            chunk_idx: u32::MAX,
        };
        self.chunks.range(lo..=hi).count()
    }

    /// All chunk indices dirty in a column, in ascending order. Used by tests and the
    /// W3-7 profile exporter.
    pub fn chunk_indices_in_column(&self, sheet: SheetId, col: ColId) -> Vec<u32> {
        let lo = ChunkKey {
            sheet,
            col,
            chunk_idx: 0,
        };
        let hi = ChunkKey {
            sheet,
            col,
            chunk_idx: u32::MAX,
        };
        self.chunks
            .range(lo..=hi)
            .map(|(k, _)| k.chunk_idx)
            .collect()
    }

    /// Mark a single cell dirty. O(log n) for the BTreeMap entry + O(1) for the bit set.
    ///
    /// Audit M3 (2026-05-12): asserts `row <= MAX_ROW` so downstream chunk-arithmetic
    /// `chunk_idx * chunk_rows` can't overflow u32. Phase 0 Excel cap is 1,048,575
    /// (well under u32::MAX); a malformed caller passing u32::MAX would silently wrap
    /// in release builds without this check.
    pub fn mark_cell(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        assert!(
            row <= MAX_ROW,
            "ChunkDirtySet::mark_cell: row {row} exceeds Excel MAX_ROW {MAX_ROW}"
        );
        let chunk_idx = row / self.chunk_rows;
        let in_chunk_row = (row % self.chunk_rows) as usize;
        let key = ChunkKey {
            sheet,
            col,
            chunk_idx,
        };
        let chunk_rows = self.chunk_rows;
        let bits = self.chunks.entry(key).or_insert_with(|| {
            let words = (chunk_rows as usize).div_ceil(64);
            vec![0u64; words]
        });
        bits[in_chunk_row / 64] |= 1u64 << (in_chunk_row % 64);
    }

    /// Mark every cell in `[start_row, end_row]` in one column dirty. Used by formula-
    /// region propagation when the whole region recomputes.
    ///
    /// Asserts `start_row <= end_row`. Spans across multiple chunks correctly.
    pub fn mark_range_in_column(
        &mut self,
        sheet: SheetId,
        start_row: RowId,
        end_row: RowId,
        col: ColId,
    ) {
        assert!(
            start_row <= end_row,
            "ChunkDirtySet::mark_range_in_column: start_row {start_row} > end_row {end_row}"
        );
        // Audit M3 (2026-05-12): bound rows under MAX_ROW so chunk-arithmetic stays in u32.
        assert!(
            end_row <= MAX_ROW,
            "ChunkDirtySet::mark_range_in_column: end_row {end_row} exceeds Excel MAX_ROW {MAX_ROW}"
        );
        let start_chunk = start_row / self.chunk_rows;
        let end_chunk = end_row / self.chunk_rows;
        for chunk_idx in start_chunk..=end_chunk {
            let chunk_first_row = chunk_idx * self.chunk_rows;
            let chunk_last_row = chunk_first_row + self.chunk_rows - 1;
            let row_lo = start_row.max(chunk_first_row);
            let row_hi = end_row.min(chunk_last_row);
            // Mark bits [row_lo - chunk_first_row, row_hi - chunk_first_row] inclusive.
            let chunk_rows = self.chunk_rows;
            let key = ChunkKey {
                sheet,
                col,
                chunk_idx,
            };
            let bits = self.chunks.entry(key).or_insert_with(|| {
                let words = (chunk_rows as usize).div_ceil(64);
                vec![0u64; words]
            });
            let bit_lo = (row_lo - chunk_first_row) as usize;
            let bit_hi = (row_hi - chunk_first_row) as usize;
            for bit in bit_lo..=bit_hi {
                bits[bit / 64] |= 1u64 << (bit % 64);
            }
        }
    }

    /// Test whether a specific cell is marked dirty.
    pub fn is_cell_dirty(&self, sheet: SheetId, row: RowId, col: ColId) -> bool {
        let chunk_idx = row / self.chunk_rows;
        let in_chunk_row = (row % self.chunk_rows) as usize;
        let key = ChunkKey {
            sheet,
            col,
            chunk_idx,
        };
        match self.chunks.get(&key) {
            Some(bits) => (bits[in_chunk_row / 64] >> (in_chunk_row % 64)) & 1 == 1,
            None => false,
        }
    }
}

/// Walk the reverse adjacency from each seed, marking dependents' chunks dirty. Each node
/// is visited at most once even in the presence of cycles (a defensive precaution; W3-3
/// `topo::schedule` partitions cycled nodes into `Schedule::cycled` for the evaluator to
/// surface as `CellError(Cycle)`).
///
/// Seeds are the nodes that just changed. Semantics by seed type:
/// - `Node::Cell` — marks exactly the cell's chunk bit dirty.
/// - `Node::FormulaRegion` — marks every cell in the region's `target_rect` dirty.
/// - `Node::Range` — no-op for chunk marking (range nodes don't own chunks); the BFS
///   still walks through them to find downstream formula dependents.
/// - `Node::Spill` — panics; Phase 3+ feature, must not appear in Phase 0.
///
/// In practice callers seed with `CellNode`s (the binder feeds cell writes). The
/// FormulaRegion/Range/Spill behavior is documented for completeness; no Phase 0 code
/// path uses non-Cell seeds.
pub fn propagate_from_cells(graph: &Graph, dirty: &mut ChunkDirtySet, seeds: &[NodeId]) {
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut queue: VecDeque<NodeId> = VecDeque::new();

    for &id in seeds {
        if visited.insert(id) {
            mark_node_chunks(graph, dirty, id);
            queue.push_back(id);
        }
    }

    while let Some(node_id) = queue.pop_front() {
        for &dependent in graph.incoming(node_id) {
            if visited.insert(dependent) {
                mark_node_chunks(graph, dirty, dependent);
                queue.push_back(dependent);
            }
        }
    }
}

fn mark_node_chunks(graph: &Graph, dirty: &mut ChunkDirtySet, node_id: NodeId) {
    match graph.node(node_id) {
        Node::Cell(c) => dirty.mark_cell(c.sheet, c.row, c.col),
        Node::FormulaRegion(frn) => {
            // The whole target rectangle recomputes; mark every cell.
            for col in frn.target_start_col..=frn.target_end_col {
                dirty.mark_range_in_column(
                    frn.sheet,
                    frn.target_start_row,
                    frn.target_end_row,
                    col,
                );
            }
        }
        Node::Range(_) => {
            // Range nodes don't own chunks — they're edge intermediaries from formula
            // vertices to source cells. The walk continues through them (the queue+visited
            // mechanism in propagate_from_cells handles that). No chunks to mark here.
        }
        Node::Spill(_) => {
            // Shape-locked Phase 3+ stub; the Graph constructor rejects Spill at
            // add_spill_node, so encountering one here would be a corruption.
            panic!(
                "propagate_from_cells: encountered Node::Spill — Phase 3+ feature, must \
                 never appear in Phase 0"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::FormulaRegionNode;
    use ql_formula_syntax::RangeRef;

    use crate::node::RangeNode;

    const CHUNK_ROWS: u32 = 16384;

    #[test]
    fn empty_dirty_set() {
        let d = ChunkDirtySet::new(CHUNK_ROWS);
        assert_eq!(d.chunk_count(), 0);
        assert_eq!(d.chunk_rows(), CHUNK_ROWS);
        assert!(!d.is_cell_dirty(0, 0, 0));
    }

    #[test]
    #[should_panic(expected = "chunk_rows must be > 0")]
    fn zero_chunk_rows_panics() {
        ChunkDirtySet::new(0);
    }

    #[test]
    fn mark_cell_creates_one_chunk_entry() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_cell(0, 5, 0);
        assert_eq!(d.chunk_count(), 1);
        assert!(d.is_cell_dirty(0, 5, 0));
        assert!(!d.is_cell_dirty(0, 6, 0)); // adjacent row in same chunk not dirty
        assert!(!d.is_cell_dirty(0, 5, 1)); // different column not dirty
    }

    #[test]
    fn mark_same_chunk_repeatedly_keeps_one_entry() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_cell(0, 5, 0);
        d.mark_cell(0, 100, 0);
        d.mark_cell(0, 16383, 0); // last row of chunk 0
        assert_eq!(d.chunk_count(), 1);
        assert!(d.is_cell_dirty(0, 5, 0));
        assert!(d.is_cell_dirty(0, 100, 0));
        assert!(d.is_cell_dirty(0, 16383, 0));
    }

    #[test]
    fn mark_different_chunks_in_same_column_produces_multiple_entries() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_cell(0, 5, 0); // chunk 0
        d.mark_cell(0, 16384, 0); // chunk 1
        d.mark_cell(0, 50000, 0); // chunk 3 (50000 / 16384 = 3)
        assert_eq!(d.chunk_count(), 3);
        assert_eq!(d.chunks_in_column(0, 0), 3);
        assert_eq!(d.chunk_indices_in_column(0, 0), vec![0, 1, 3]);
    }

    #[test]
    fn mark_different_columns_produces_separate_entries() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_cell(0, 5, 0);
        d.mark_cell(0, 5, 1);
        d.mark_cell(0, 5, 99);
        assert_eq!(d.chunk_count(), 3);
        assert_eq!(d.chunks_in_column(0, 0), 1);
        assert_eq!(d.chunks_in_column(0, 1), 1);
        assert_eq!(d.chunks_in_column(0, 50), 0);
        assert_eq!(d.chunks_in_column(0, 99), 1);
    }

    #[test]
    fn mark_range_in_single_chunk() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_range_in_column(0, 5, 10, 0);
        assert_eq!(d.chunk_count(), 1);
        for row in 0..5 {
            assert!(!d.is_cell_dirty(0, row, 0));
        }
        for row in 5..=10 {
            assert!(d.is_cell_dirty(0, row, 0));
        }
        for row in 11..20 {
            assert!(!d.is_cell_dirty(0, row, 0));
        }
    }

    #[test]
    fn mark_range_across_chunks() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        // Rows 500..50000 in col 0 → chunks 0, 1, 2 (since 50000/16384 = 3 but the LAST
        // row 50000 is in chunk 3; 500/16384 = 0 starts in chunk 0). So 4 chunks.
        d.mark_range_in_column(0, 500, 50000, 0);
        assert_eq!(d.chunks_in_column(0, 0), 4);
        assert_eq!(d.chunk_indices_in_column(0, 0), vec![0, 1, 2, 3]);
        // Spot check boundary bits:
        assert!(d.is_cell_dirty(0, 500, 0));
        assert!(d.is_cell_dirty(0, 50000, 0));
        assert!(!d.is_cell_dirty(0, 499, 0));
        assert!(!d.is_cell_dirty(0, 50001, 0));
        // Mid-range:
        assert!(d.is_cell_dirty(0, 16384, 0));
        assert!(d.is_cell_dirty(0, 32768, 0));
    }

    #[test]
    #[should_panic(expected = "start_row")]
    fn mark_range_with_reversed_bounds_panics() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_range_in_column(0, 10, 5, 0);
    }

    // Audit M3 (2026-05-12): row bounds enforced under MAX_ROW so chunk arithmetic
    // can't overflow u32 in release builds.

    #[test]
    #[should_panic(expected = "exceeds Excel MAX_ROW")]
    fn mark_cell_panics_on_row_over_max() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_cell(0, u32::MAX, 0);
    }

    #[test]
    #[should_panic(expected = "exceeds Excel MAX_ROW")]
    fn mark_range_panics_on_end_row_over_max() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_range_in_column(0, 0, u32::MAX, 0);
    }

    #[test]
    fn mark_cell_at_max_row_does_not_panic() {
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        d.mark_cell(0, MAX_ROW, 0);
        assert!(d.is_cell_dirty(0, MAX_ROW, 0));
    }

    // ===== propagation tests =====

    #[test]
    fn propagate_single_seed_no_dependents() {
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a1]);
        assert_eq!(d.chunk_count(), 1);
        assert_eq!(d.chunks_in_column(0, 0), 1);
        assert!(d.is_cell_dirty(0, 0, 0));
    }

    #[test]
    fn propagate_cell_to_cell_dependency() {
        // A1 = 1; B1 = =A1. Write A1, expect A1's chunk + B1's chunk dirty.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        g.add_edge(b1, a1); // B1 depends on A1
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a1]);
        assert_eq!(d.chunk_count(), 2);
        assert_eq!(d.chunks_in_column(0, 0), 1);
        assert_eq!(d.chunks_in_column(0, 1), 1);
        assert!(d.is_cell_dirty(0, 0, 0));
        assert!(d.is_cell_dirty(0, 0, 1));
    }

    #[test]
    fn propagate_through_range_node_intermediary() {
        // A1 = 1, A500 = 2. ColARange. B1 = SUM(A:A).
        // Edges: B1 -> ColARange (formula depends on range), ColARange -> A1, ColARange -> A500
        // (in the W3-5 stripe-based world these edges may not be explicit, but for W3-2 we
        // test the propagation mechanics with explicit edges).
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let a500 = g.add_cell_node(0, 500, 0);
        let col_a = g.add_range_node(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: None,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        });
        let b1 = g.add_cell_node(0, 0, 1);
        g.add_edge(col_a, a1);
        g.add_edge(col_a, a500);
        g.add_edge(b1, col_a);

        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a500]);

        // Expected:
        // - A500's chunk (col 0, chunk 0 — since 500/16384=0) → dirty
        // - ColARange has no chunks (intermediary)
        // - B1's chunk (col 1, chunk 0) → dirty
        // Total: 2 chunks dirty.
        assert_eq!(d.chunk_count(), 2);
        assert_eq!(d.chunks_in_column(0, 0), 1);
        assert_eq!(d.chunks_in_column(0, 1), 1);
        assert!(d.is_cell_dirty(0, 500, 0));
        assert!(d.is_cell_dirty(0, 0, 1));
    }

    #[test]
    fn propagate_through_formula_region_node() {
        // A1 = 1. FRN at column B rows 0..999 with target_rect (0..999, 1..1).
        // FRN depends on A1. Write A1 → FRN dirties all of column B rows 0..999 (one chunk).
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let frn = g.add_formula_region_node(FormulaRegionNode {
            sheet: 0,
            target_start_row: 0,
            target_start_col: 1,
            target_end_row: 999,
            target_end_col: 1,
            formula_fingerprint: 1,
            chunk_count: 1,
        });
        g.add_edge(frn, a1);

        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a1]);

        // A1's chunk + col 1 chunk 0 (since FRN spans rows 0..999, one chunk).
        assert_eq!(d.chunk_count(), 2);
        assert!(d.is_cell_dirty(0, 0, 0));
        // Every cell in FRN target is dirty.
        for row in 0..=999 {
            assert!(d.is_cell_dirty(0, row, 1));
        }
        // Beyond the FRN target, not dirty.
        assert!(!d.is_cell_dirty(0, 1000, 1));
    }

    #[test]
    fn propagate_diamond_dependency() {
        // A1 → {B1, C1} → D1. Write A1 → all four dirty.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        let c1 = g.add_cell_node(0, 0, 2);
        let d1 = g.add_cell_node(0, 0, 3);
        g.add_edge(b1, a1);
        g.add_edge(c1, a1);
        g.add_edge(d1, b1);
        g.add_edge(d1, c1);

        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a1]);
        assert_eq!(d.chunk_count(), 4);
        for col in 0..=3 {
            assert!(d.is_cell_dirty(0, 0, col));
        }
    }

    #[test]
    fn og05_acceptance_single_cell_write_marks_only_affected_chunk_in_source_column() {
        // OG-05: column A has 50000 cells; write to A5 (chunk 0). After propagation,
        // only chunk 0 should be dirty in column A — NOT chunks 1, 2, 3.
        let mut g = Graph::new();
        let mut cells = Vec::new();
        for row in [0, 5, 100, 16384, 30000, 49999] {
            // Add cell nodes at varied rows; only A5 receives a write.
            cells.push((row, g.add_cell_node(0, row, 0)));
        }
        let a5 = cells
            .iter()
            .find(|(r, _)| *r == 5)
            .map(|(_, id)| *id)
            .unwrap();
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a5]);
        // Exactly one chunk dirty in column A — the one containing row 5.
        assert_eq!(d.chunks_in_column(0, 0), 1);
        assert_eq!(d.chunk_indices_in_column(0, 0), vec![0]);
    }

    #[test]
    fn propagate_handles_cycles_via_visited_set() {
        // A1 ← B1 ← A1 (B1 depends on A1, A1 also depends on B1 — a cycle).
        // The walk should terminate without infinite loop and mark both chunks.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        g.add_edge(b1, a1);
        g.add_edge(a1, b1); // Cycle!
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a1]);
        assert_eq!(d.chunk_count(), 2);
        assert!(d.is_cell_dirty(0, 0, 0));
        assert!(d.is_cell_dirty(0, 0, 1));
    }

    #[test]
    fn propagate_multiple_seeds() {
        // Two unrelated writes in the same recompute pass.
        let mut g = Graph::new();
        let a1 = g.add_cell_node(0, 0, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        let c1 = g.add_cell_node(0, 0, 2);
        let d1 = g.add_cell_node(0, 0, 3);
        g.add_edge(b1, a1);
        g.add_edge(d1, c1);
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[a1, c1]);
        assert_eq!(d.chunk_count(), 4);
        for col in 0..=3 {
            assert!(d.is_cell_dirty(0, 0, col));
        }
    }

    #[test]
    fn empty_seeds_no_op() {
        let mut g = Graph::new();
        g.add_cell_node(0, 0, 0);
        let mut d = ChunkDirtySet::new(CHUNK_ROWS);
        propagate_from_cells(&g, &mut d, &[]);
        assert_eq!(d.chunk_count(), 0);
    }

    #[test]
    fn small_chunk_size_for_test_isolation() {
        // Verify that ChunkDirtySet works correctly with a small chunk size — useful for
        // tests that want to span chunks without writing 16k rows.
        let mut d = ChunkDirtySet::new(8);
        d.mark_cell(0, 0, 0); // chunk 0, bit 0
        d.mark_cell(0, 7, 0); // chunk 0, bit 7
        d.mark_cell(0, 8, 0); // chunk 1, bit 0
        d.mark_cell(0, 15, 0); // chunk 1, bit 7
        d.mark_cell(0, 16, 0); // chunk 2, bit 0
        assert_eq!(d.chunk_count(), 3);
        assert_eq!(d.chunks_in_column(0, 0), 3);
        assert_eq!(d.chunk_indices_in_column(0, 0), vec![0, 1, 2]);
        assert!(d.is_cell_dirty(0, 0, 0));
        assert!(d.is_cell_dirty(0, 7, 0));
        assert!(d.is_cell_dirty(0, 8, 0));
        assert!(d.is_cell_dirty(0, 16, 0));
    }
}
