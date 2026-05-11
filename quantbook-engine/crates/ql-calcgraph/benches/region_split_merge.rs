//! **A1 acceptance bench scaffold** (Week 4 acceptance run).
//!
//! Per Phase 0 spec Part V §1 A1: "region split/merge under 10K random single-cell edits
//! stays <50ms total." Phase 0 W3-8 ships the harness; the actual run happens in Week 4
//! after `ql-exec` lands the region split/merge logic (which currently doesn't exist —
//! FormulaRegionNode in Phase 0 W3 has shape, but no split/merge under cell edits).
//!
//! This scaffold exercises what Phase 0 W3 CAN measure today:
//! - Build a FormulaRegionNode covering 25M cells in target_rect.
//! - Wire 10K source-column-A CellNodes as edges into the region.
//! - Time `propagate_from_cells` walking all 10K dirty seeds.
//!
//! The 50ms target won't necessarily hold until Week 4 wires split/merge — this commit
//! locks the BENCH SHAPE so Week 4 just adds the split/merge call sites + measures.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use ql_calcgraph::{propagate_from_cells, ChunkDirtySet, FormulaRegionNode, Graph, NodeId};

/// Build a graph with one 25M-cell FormulaRegionNode + N source CellNodes wired as edges
/// into the region. Returns `(graph, source_cell_ids)`.
///
/// `n_source_cells` should be small relative to 25M so the bench setup doesn't allocate
/// 25M nodes. 10K matches the A1 spec wording.
fn build_25m_region_with_n_sources(n_source_cells: usize) -> (Graph, Vec<NodeId>) {
    let mut g = Graph::new();
    let region = g.add_formula_region_node(FormulaRegionNode {
        sheet: 0,
        target_start_row: 0,
        target_start_col: 1, // column B
        target_end_row: 24_999_999,
        target_end_col: 1,
        formula_fingerprint: 0xA1_AC_FA_15_E1_FE_C0_0F,
        chunk_count: 24_999_999u32 / 16_384 + 1,
    });

    // Deterministic LCG for reproducibility — no `rand` dep needed.
    let mut state: u64 = 0xC0FE_BABE;
    let mut sources: Vec<NodeId> = Vec::with_capacity(n_source_cells);
    for _ in 0..n_source_cells {
        // 64-bit Linear Congruential Generator (Knuth's MMIX constants).
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let row = (state >> 32) as u32 % 25_000_000;
        let id = g.add_cell_node(0, row, 0);
        sources.push(id);
        // The region depends on each source cell. Edge direction: region -> source.
        g.add_edge(region, id);
    }
    (g, sources)
}

fn bench_a1_region_dirty_propagation(c: &mut Criterion) {
    let mut group = c.benchmark_group("a1_region_25m_cells");
    group.sample_size(10); // benchmark is heavyweight; few samples are fine for scaffold

    group.bench_function("propagate_10k_edits", |b| {
        b.iter_batched(
            || build_25m_region_with_n_sources(10_000),
            |(graph, sources)| {
                let mut dirty = ChunkDirtySet::new(16384);
                propagate_from_cells(&graph, &mut dirty, &sources);
                // Force the dirty set to be observed so the optimizer doesn't elide it.
                black_box(dirty);
            },
            BatchSize::PerIteration,
        );
    });

    group.finish();
}

criterion_group!(benches, bench_a1_region_dirty_propagation);
criterion_main!(benches);
