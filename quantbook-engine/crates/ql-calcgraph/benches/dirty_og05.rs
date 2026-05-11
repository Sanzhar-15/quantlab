//! **OG-05 acceptance bench scaffold** — single-cell write marks only the affected chunk.
//!
//! Per Phase 0 spec Part V §1 OG-05. Already locked as a unit test in
//! `dirty::tests::og05_acceptance_single_cell_write_marks_only_affected_chunk_in_source_column`;
//! this bench measures the wall-clock cost of the per-chunk dirty bitmap path so a future
//! regression that introduces O(column-size) cell-marking shows up loudly.
//!
//! What this bench measures (and what it doesn't):
//!
//! - `mark_cell` cost (the bitset set operation + BTreeMap entry lookup) at varied
//!   workbook sizes.
//! - `propagate_from_cells` cost on a small dependency graph.
//!
//! It does NOT yet measure ColumnStore integration — that lands in Week 4's E2E test
//! when `ql-exec` wires the write path through ColumnStore → calcgraph → ChunkDirtySet.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ql_calcgraph::{propagate_from_cells, ChunkDirtySet, Graph, NodeId};

fn bench_og05_single_cell_mark(c: &mut Criterion) {
    let mut group = c.benchmark_group("og05_single_cell_mark");
    for &cols in &[10u32, 1_000, 100_000] {
        group.bench_with_input(BenchmarkId::from_parameter(cols), &cols, |b, &cols| {
            b.iter(|| {
                let mut dirty = ChunkDirtySet::new(16384);
                // Mark one cell per column to verify chunks_in_column behaves linearly with
                // touched columns, not all columns.
                for col in 0..cols {
                    dirty.mark_cell(0, 5, col);
                }
                black_box(dirty.chunk_count());
            });
        });
    }
    group.finish();
}

fn bench_og05_propagate_small_chain(c: &mut Criterion) {
    c.bench_function("og05_propagate_chain_100", |b| {
        b.iter_with_setup(
            || {
                let mut g = Graph::new();
                let mut ids: Vec<NodeId> = Vec::with_capacity(100);
                for col in 0..100 {
                    ids.push(g.add_cell_node(0, 0, col));
                }
                // Chain: ids[i+1] depends on ids[i] for i in 0..99.
                for i in 0..99 {
                    g.add_edge(ids[i + 1], ids[i]);
                }
                (g, ids)
            },
            |(g, ids)| {
                let mut dirty = ChunkDirtySet::new(16384);
                propagate_from_cells(&g, &mut dirty, &ids[..1]); // seed only the head
                                                                 // After propagation, all 100 columns should have 1 dirty chunk each.
                assert_eq!(dirty.chunk_count(), 100);
                black_box(dirty);
            },
        );
    });
}

criterion_group!(
    benches,
    bench_og05_single_cell_mark,
    bench_og05_propagate_small_chain
);
criterion_main!(benches);
