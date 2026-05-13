//! **A5 acceptance bench scaffold** — range-node prefix-SUM near-linear edge growth.
//!
//! Per Phase 0 spec Part V §1 A5: "registering N formulas SUM(A1:A_n) for varying n
//! produces <2x formula count edges (near-linear, NOT quadratic)." Already locked as a
//! unit test in `stripes::tests::a5_acceptance_100k_formulas_linear_scaling`; this bench
//! gives a wall-clock measurement of the registration path for Week 4's official run.
//!
//! The unit test asserts CORRECTNESS (stripe insertion count); this bench gives PERF
//! visibility — useful if a future change accidentally moves the path from O(N) to O(N²).

use ql_formula_syntax::SheetRef;
use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ql_calcgraph::{Graph, RangeRef};

fn build_n_sum_a1_to_an_formulas(n: u32) -> Graph {
    let mut g = Graph::new();
    for i in 1..=n {
        let id = g.add_cell_node(0, 0, i); // each formula gets its own cell ID
        g.register_range_dependency(
            id,
            RangeRef::Cells {
                sheet: SheetRef::Current,
                start_col: 0,
                start_row: 0,
                end_col: 0,
                end_row: i - 1,
                abs_start_col: false,
                abs_start_row: false,
                abs_end_col: false,
                abs_end_row: false,
            },
            0,
        );
    }
    g
}

fn bench_a5_prefix_sum_registration(c: &mut Criterion) {
    let mut group = c.benchmark_group("a5_prefix_sum_registration");
    for &n in &[1_000u32, 10_000, 100_000] {
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| {
                let g = build_n_sum_a1_to_an_formulas(n);
                black_box((
                    g.stripe_index().stripe_count(),
                    g.stripe_index().total_insertions(),
                ));
            });
        });
    }
    group.finish();
}

/// Sanity check: at scale N, total stripe insertions stays linear (under 2*N per the
/// A5 spec bound). This is a perf-bench assertion, not a unit test — the unit-test
/// equivalent at `stripes::tests::a5_acceptance_100k_formulas_linear_scaling` is the
/// authoritative pass/fail; this assertion is here so a regression that broke the spec
/// shows up immediately when someone runs `cargo bench`.
fn bench_a5_invariant_at_scale(c: &mut Criterion) {
    c.bench_function("a5_invariant_at_100k", |b| {
        b.iter(|| {
            let g = build_n_sum_a1_to_an_formulas(100_000);
            let total = g.stripe_index().total_insertions();
            assert!(
                total as u64 <= 2 * 100_000,
                "A5 invariant violated: total_insertions={total} > 2 * 100_000"
            );
            black_box(total);
        });
    });
}

criterion_group!(
    benches,
    bench_a5_prefix_sum_registration,
    bench_a5_invariant_at_scale
);
criterion_main!(benches);
