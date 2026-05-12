//! **A3-03 acceptance bench** — 10k-formula dirty recompute time.
//!
//! Per the Phase 3.10 megaudit spec: "10k-formula dirty recompute
//! benchmark checked in". Measures the wall-clock cost of the graph-
//! driven `recompute_dirty` path on a synthetic 10,000-cell formula
//! chain. The chain is the worst case: every formula depends on the
//! prior cell, so Tarjan must serialize them, the dirty BFS must
//! traverse the entire chain, and every cell recomputes once.
//!
//! Scenarios:
//!
//! 1. **Cold edit** — edit the chain head; recompute_dirty propagates
//!    through all 10k. Real values change at each step (chain is
//!    `=prev + 1`).
//! 2. **Idempotent edit** — edit the chain head to its same value;
//!    Phase 3.8 VEQ should skip every downstream after the head's
//!    re-evaluation matches its prior. This benchmark measures the
//!    VEQ short-circuit perf gain.
//!
//! Bench is heavy: small sample size; the goal is regression
//! detection, not perf tuning at the microsecond level.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use ql_exec::{CalcgraphSession, WorkbookRuntime};
use ql_functions::default_registry;
use ql_storage::Workbook;
use ql_types::Value;

const CHAIN_LEN: u32 = 10_000;

/// Build a workbook with a CHAIN_LEN-long chain in column A:
/// A1 = literal 0; A2 = A1+1; A3 = A2+1; ...; A{CHAIN_LEN} = prior+1.
/// Returns (wb, graph) with all formulas registered + a clean dirty
/// set. Each call constructs fresh state so benchmark iterations don't
/// reuse populated caches.
fn build_chain_workbook() -> (Workbook, CalcgraphSession) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
        for r in 1..CHAIN_LEN {
            let prev_row = r - 1;
            // Excel-1-based formula text: row 1 = "A1", row 2 = "A2", etc.
            // Internal row 0 = A1, so prev_row internal → prev_row+1 in Excel.
            let text = format!("A{} + 1", prev_row + 1);
            rt.set_formula(0, r, 0, text.as_str()).unwrap();
        }
    }
    // Rebuild a session against the constructed workbook so the graph
    // has every formula's deps + the cell_index is complete.
    let r = CalcgraphSession::rebuild_from_workbook(&wb);
    assert!(r.is_complete(), "{} failures", r.failures.len());
    (wb, r.session)
}

fn bench_a3_10k_chain_cold_edit(c: &mut Criterion) {
    let mut group = c.benchmark_group("a3_10k_chain_cold_edit");
    group.sample_size(10);
    group.bench_function("recompute_dirty", |b| {
        b.iter_batched(
            // Setup: fresh workbook + graph each iter. Outside the measured region.
            build_chain_workbook,
            |(mut wb, mut graph)| {
                let reg = default_registry();
                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
                // Cold edit: change A1 from 0 to a different value.
                rt.set_value(0, 0, 0, Value::Number(42.0)).unwrap();
                let result = rt.recompute_dirty().expect("graph attached");
                black_box(result);
            },
            criterion::BatchSize::LargeInput,
        );
    });
    group.finish();
}

fn bench_a3_10k_chain_idempotent_edit(c: &mut Criterion) {
    let mut group = c.benchmark_group("a3_10k_chain_idempotent_edit");
    group.sample_size(10);
    group.bench_function("recompute_dirty_veq", |b| {
        b.iter_batched(
            build_chain_workbook,
            |(mut wb, mut graph)| {
                let reg = default_registry();
                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
                // Idempotent edit: A1 stays at 0. Phase 3.8 VEQ should
                // skip all downstream after A2's recompute matches.
                rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
                let result = rt.recompute_dirty().expect("graph attached");
                // Sanity: VEQ counter is non-zero. If this fails the
                // bench is measuring the wrong thing.
                assert!(result.skipped_value_equality > 0);
                black_box(result);
            },
            criterion::BatchSize::LargeInput,
        );
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_a3_10k_chain_cold_edit,
    bench_a3_10k_chain_idempotent_edit
);
criterion_main!(benches);
