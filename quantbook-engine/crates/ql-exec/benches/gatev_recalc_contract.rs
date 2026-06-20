//! GATE-V (2026-06-20) — honest end-to-end recalc-contract benches.
//!
//! `og02_mul2` times only the SIMD `mul_scalar` KERNEL over preallocated chunks
//! (3.4ms / 25M) and `a3_10k_dirty_recompute` times a 10k chain — neither times
//! the realistic interactive paths the DoD #4 contract is actually about:
//!
//!   - "single edit recalc < 15ms" — on a LARGE workbook, not a 10k toy.
//!   - "25M recalc < 100ms" — through the real eval path (parse + Tarjan +
//!     evaluate), not just the SIMD kernel.
//!
//! Scenarios (registry construction is HOISTED out of every measured region so
//! the numbers are the engine paths, not harness setup):
//!
//! 1. **set_value_1m** — on a 1,000,000-cell grid, time just `set_value` (the
//!    edit + dirty-mark), no recompute. Isolates the edit/mark cost.
//! 2. **recompute_dirty_1m** — same grid, the edit pre-applied in setup; time
//!    just `recompute_dirty` for the ONE dirty dependent. Isolates the
//!    incremental recompute cost. Together (1)+(2) split the interactive
//!    edit-latency budget (DoD #4: < 15ms) and reveal whether either path
//!    scales with GRAPH size rather than DIRTY-SET size.
//! 3. **cold_full_recalc** — the `recompute_all` LOAD/REPLAY path (re-parses
//!    every formula, builds an ephemeral graph, evaluates) over a chain. The
//!    conservative full-eval cost (NOT the SIMD region fast-path), for honesty.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use ql_exec::{CalcgraphSession, WorkbookRuntime};
use ql_functions::{default_registry, FunctionRegistry};
use ql_storage::Workbook;
use ql_types::Value;

const GRID_N: u32 = 1_000_000;

/// Independent input→formula pairs: column A holds literals, column B holds
/// `=A*2`. Editing one A-cell dirties exactly one B-cell. Returns
/// `(wb, graph, registry)` with a complete, clean dirty set; the registry is
/// returned so callers can keep it OUT of the measured region.
fn build_independent_grid(n: u32) -> (Workbook, CalcgraphSession, FunctionRegistry) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        for r in 0..n {
            rt.set_value(0, r, 0, Value::Number(r as f64)).unwrap();
            let text = format!("A{} * 2", r + 1); // internal row r -> "A{r+1}"
            rt.set_formula(0, r, 1, text.as_str()).unwrap();
        }
    }
    let r = CalcgraphSession::rebuild_from_workbook(&wb);
    assert!(r.is_complete(), "{} build failures", r.failures.len());
    (wb, r.session, reg)
}

/// A `=prev+1` chain in column A (no session attached) for the `recompute_all`
/// cold-load path. Returns `(wb, registry)`.
fn build_chain(n: u32) -> (Workbook, FunctionRegistry) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
        for r in 1..n {
            let text = format!("A{} + 1", r);
            rt.set_formula(0, r, 0, text.as_str()).unwrap();
        }
    }
    (wb, reg)
}

/// (1) Just the edit + dirty-mark on a 1M-cell grid.
fn bench_set_value_1m(c: &mut Criterion) {
    let mut group = c.benchmark_group("gatev_set_value_1m_grid");
    group.sample_size(10);
    group.bench_function("set_value_one_cell", |b| {
        b.iter_batched(
            || build_independent_grid(GRID_N),
            |(mut wb, mut graph, reg)| {
                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
                rt.set_value(0, 0, 0, Value::Number(999.0)).unwrap();
                black_box(&mut graph);
            },
            BatchSize::LargeInput,
        );
    });
    group.finish();
}

/// (2) Just `recompute_dirty` for ONE dirty dependent on a 1M-cell grid (edit
/// pre-applied in setup, OUT of the measured region).
fn bench_recompute_dirty_1m(c: &mut Criterion) {
    let mut group = c.benchmark_group("gatev_recompute_dirty_1m_grid");
    group.sample_size(10);
    group.bench_function("recompute_dirty_one_dependent", |b| {
        b.iter_batched(
            || {
                let (mut wb, mut graph, reg) = build_independent_grid(GRID_N);
                {
                    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
                    // Mark A1 dirty WITHOUT recomputing — recompute is the measured op.
                    rt.set_value(0, 0, 0, Value::Number(999.0)).unwrap();
                }
                (wb, graph, reg)
            },
            |(mut wb, mut graph, reg)| {
                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
                let result = rt.recompute_dirty().expect("graph attached");
                assert_eq!(result.attempted, 1, "exactly one dependent, not the grid");
                black_box(result);
            },
            BatchSize::LargeInput,
        );
    });
    group.finish();
}

/// (3) `recompute_all` cold-load full-eval path over a 100k chain.
fn bench_cold_full_recalc(c: &mut Criterion) {
    const N: u32 = 100_000;
    let mut group = c.benchmark_group("gatev_cold_full_recalc_100k_chain");
    group.sample_size(10);
    group.bench_function("recompute_all", |b| {
        b.iter_batched(
            || build_chain(N),
            |(mut wb, reg)| {
                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
                let result = rt.recompute_all();
                assert_eq!(result.attempted, (N - 1) as usize, "every formula recomputed");
                black_box(result);
            },
            BatchSize::LargeInput,
        );
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_set_value_1m,
    bench_recompute_dirty_1m,
    bench_cold_full_recalc
);
criterion_main!(benches);
