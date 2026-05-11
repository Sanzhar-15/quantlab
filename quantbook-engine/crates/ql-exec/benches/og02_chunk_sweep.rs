//! **A7 acceptance bench** — chunk-size sweep over the OG-02 `=A*2` hot path.
//!
//! Per Phase 0 spec Part V §1 A7: measure the OG-02 baseline (`mul_scalar` over 25M
//! f64s) at multiple chunk sizes to identify the winning size. Informational — used
//! for the Phase 0 exit packet's chunk-size recommendation; no specific perf target.
//!
//! Sweeps {4_096, 8_192, 16_384, 32_768, 65_536} row chunks. The total work (25M
//! `mul_scalar(x, 2.0)`) is constant; only the chunk boundary moves.
//!
//! Expected: 16k or 32k wins on Apple Silicon / modern x86 (L1 cache friendly +
//! amortized loop overhead). Sub-4k chunks suffer per-call multiversion-dispatch +
//! loop-prologue overhead; >64k risks L1 spillover. The W3 plan's default of 16384
//! should be vindicated.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ql_exec::simd::mul_scalar;

const TOTAL_ROWS: usize = 25_000_000;
const CHUNK_SIZES: &[usize] = &[4_096, 8_192, 16_384, 32_768, 65_536];

fn build_input_chunks(chunk_rows: usize) -> Vec<Vec<f64>> {
    let chunk_count = TOTAL_ROWS.div_ceil(chunk_rows);
    let mut chunks = Vec::with_capacity(chunk_count);
    for chunk_idx in 0..chunk_count {
        let start = chunk_idx * chunk_rows;
        let end = (start + chunk_rows).min(TOTAL_ROWS);
        let chunk: Vec<f64> = (start..end).map(|i| i as f64).collect();
        chunks.push(chunk);
    }
    chunks
}

fn bench_a7_chunk_sweep(c: &mut Criterion) {
    let mut group = c.benchmark_group("a7_chunk_size_sweep_25m_mul2");
    group.sample_size(10);

    for &chunk_rows in CHUNK_SIZES {
        let input_chunks = build_input_chunks(chunk_rows);
        let mut out_buf = vec![0.0; chunk_rows];

        group.bench_with_input(
            BenchmarkId::from_parameter(chunk_rows),
            &chunk_rows,
            |b, _| {
                b.iter(|| {
                    for chunk in &input_chunks {
                        let len = chunk.len();
                        let out_slice = &mut out_buf[..len];
                        mul_scalar(chunk, 2.0, out_slice);
                    }
                    black_box(&out_buf);
                });
            },
        );
    }

    group.finish();
}

criterion_group!(benches, bench_a7_chunk_sweep);
criterion_main!(benches);
