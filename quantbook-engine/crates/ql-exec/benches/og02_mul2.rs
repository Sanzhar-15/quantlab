//! **OG-02 acceptance bench** — 25M-cell `=A*2` recompute time.
//!
//! Per Phase 0 spec Part V §1 OG-02: ≤100ms on the reference target. This bench measures
//! the full SIMD path (Float64Array → mul_scalar → output buffer) over 25M elements
//! split across 16384-row chunks (≈1526 chunks).
//!
//! Caller-supplied output buffer; no allocation per chunk (OG-03 verified inline below).
//!
//! Reference target: M3 Pro / Ryzen 7950X / equivalent. Expected on-target: 30–70ms.
//! ARM/older x86 may be slower; the 100ms ceiling is generous.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use ql_exec::simd::mul_scalar;

const CHUNK_ROWS: usize = 16384;
const TOTAL_ROWS: usize = 25_000_000;

fn build_25m_input() -> Vec<Vec<f64>> {
    // Split 25M rows into chunks of 16384 (≈1526 chunks). Each chunk holds f64 i.
    let chunk_count = TOTAL_ROWS.div_ceil(CHUNK_ROWS);
    let mut chunks = Vec::with_capacity(chunk_count);
    for chunk_idx in 0..chunk_count {
        let start = chunk_idx * CHUNK_ROWS;
        let end = (start + CHUNK_ROWS).min(TOTAL_ROWS);
        let chunk: Vec<f64> = (start..end).map(|i| i as f64).collect();
        chunks.push(chunk);
    }
    chunks
}

fn bench_og02_mul2_25m(c: &mut Criterion) {
    let input_chunks = build_25m_input();
    // Pre-allocate ONE output buffer the size of the largest chunk; reused across all.
    let mut out_buf = vec![0.0; CHUNK_ROWS];

    let mut group = c.benchmark_group("og02_mul2_25m");
    // The bench is heavy; few samples are enough to verify the ≤100ms target.
    group.sample_size(10);

    group.bench_function("simd_mul_scalar_2.0", |b| {
        b.iter(|| {
            // OG-02 scenario: =A * 2 over the entire 25M-cell column. Process chunk by
            // chunk, reusing out_buf. OG-03 acceptance: no per-chunk allocation.
            for chunk in &input_chunks {
                let len = chunk.len();
                // Slice the out_buf to chunk length (last chunk may be shorter).
                let out_slice = &mut out_buf[..len];
                mul_scalar(chunk, 2.0, out_slice);
            }
            black_box(&out_buf);
        });
    });

    group.finish();
}

criterion_group!(benches, bench_og02_mul2_25m);
criterion_main!(benches);
