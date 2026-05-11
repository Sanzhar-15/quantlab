//! **A1 acceptance bench** — region split/merge under 10K random single-cell edits.
//!
//! Per Phase 0 spec Part V §1 A1: "region split/merge under 10K random single-cell
//! edits stays <50ms total."
//!
//! Phase 0 W3 ships the chassis (FormulaRegionNode + dirty propagation); explicit
//! region split/merge under edits lands Phase 4+ (when cells mid-region get a
//! different formula, the region must fragment). This bench measures what Phase 0
//! CAN measure: the cost of propagating dirty marks through a graph with one large
//! FormulaRegionNode + 10K source-cell seeds.
//!
//! ## Region sizing
//!
//! "25M cells" doesn't fit in a single Excel column (MAX_ROW = 1,048,575). The bench
//! uses a 24-column × 1,048,576-row region ≈ 25.16M cells. Source-cell write-targets
//! are sampled uniformly from column 0 rows [0, MAX_ROW].

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use ql_calcgraph::{propagate_from_cells, ChunkDirtySet, FormulaRegionNode, Graph, NodeId};
use ql_types::MAX_ROW;

const CHUNK_ROWS: u32 = 16_384;
/// 24 columns × 1,048,576 rows = ~25.16M cells, matching the A1 "25M cell" target while
/// respecting Excel's MAX_ROW.
const REGION_COLS: u32 = 24;

/// Build a graph with one 25M-cell FormulaRegionNode + N source CellNodes wired as
/// edges into the region. Returns `(graph, source_cell_ids)`.
fn build_25m_region_with_n_sources(n_source_cells: usize) -> (Graph, Vec<NodeId>) {
    let mut g = Graph::new();
    let region = g.add_formula_region_node(FormulaRegionNode {
        sheet: 0,
        target_start_row: 0,
        target_start_col: 1, // column B
        target_end_row: MAX_ROW,
        target_end_col: REGION_COLS, // covers cols B..X (1..24 inclusive)
        formula_fingerprint: 0xA1_AC_FA_15_E1_FE_C0_0F,
        chunk_count: (MAX_ROW + 1) / CHUNK_ROWS + 1,
    });

    // Deterministic LCG for reproducibility — no `rand` dep needed.
    let mut state: u64 = 0xC0FE_BABE;
    let mut sources: Vec<NodeId> = Vec::with_capacity(n_source_cells);
    for _ in 0..n_source_cells {
        // 64-bit Linear Congruential Generator (Knuth's MMIX constants).
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let row = ((state >> 32) as u32) % (MAX_ROW + 1);
        let id = g.add_cell_node(0, row, 0);
        sources.push(id);
        // The region depends on each source cell. Edge direction: region -> source.
        g.add_edge(region, id);
    }
    (g, sources)
}

fn bench_a1_region_dirty_propagation(c: &mut Criterion) {
    let mut group = c.benchmark_group("a1_region_25m_cells");
    group.sample_size(10);

    group.bench_function("propagate_10k_edits", |b| {
        b.iter_batched(
            || build_25m_region_with_n_sources(10_000),
            |(graph, sources)| {
                let mut dirty = ChunkDirtySet::new(CHUNK_ROWS);
                propagate_from_cells(&graph, &mut dirty, &sources);
                black_box(dirty);
            },
            BatchSize::PerIteration,
        );
    });

    group.finish();
}

criterion_group!(benches, bench_a1_region_dirty_propagation);
criterion_main!(benches);
