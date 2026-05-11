//! SIMD kernels for the OG-02 hot path.
//!
//! Phase 0 acceptance gate OG-02: 25M-cell `=A*2` recomputes in ≤100ms on the reference
//! target. The per-cell scalar evaluator at `scalar::eval_scalar` would walk the
//! ExprPlan tree 25M times — far too slow. This module provides bulk Float64Array
//! kernels for the common case: `col_out[i] = op(col_in[i], scalar)` and
//! `col_out[i] = op(col_lhs[i], col_rhs[i])`.
//!
//! ## Dispatch strategy (A2 acceptance)
//!
//! Each kernel uses `multiversion::multiversion` to emit per-target-feature clones.
//! At first call, the multiversion runtime detects host CPU features and binds the call
//! to the best clone (AVX2 > SSE4.2 > scalar on x86_64; NEON > scalar on aarch64).
//!
//! This is what A2 demands: "multiversion wrapper for Arrow kernels with disassembly
//! verification of runtime SIMD dispatch." We don't wrap Arrow's kernels directly —
//! Arrow's mul/add allocate result arrays + validity bitmaps which would inflate the
//! OG-02 cost. Instead, the kernels here take `&mut [f64]` out-buffers (caller-supplied)
//! and rely on LLVM's auto-vectorization at the target-feature level the multiversion
//! clone declares.
//!
//! ## Why pulp isn't in the hot path (yet)
//!
//! `pulp` (`workspace.dependencies` pin) provides hand-written SIMD intrinsics; useful
//! for cases where auto-vectorization fails (gather/scatter, masking). Phase 0's
//! straight-line `lhs[i] * rhs` loops auto-vectorize cleanly under multiversion, so we
//! ship without pulp invocations. The crate stays imported for Phase 4+ kernels that
//! need explicit lane operations (Welford reduction, conditional masking for SUMIF, etc.).
//!
//! ## OG-03 acceptance (allocation count = 0 per chunk)
//!
//! Every kernel takes `&[f64]` inputs + `&mut [f64]` outputs. No internal allocation.
//! Caller pre-allocates the output once per chunk + reuses across all chunks of a
//! column. The bench at `benches/og02_mul2.rs` verifies this by reusing one output
//! buffer across all chunks.

use multiversion::multiversion;

/// `out[i] = lhs[i] * scalar` over an entire chunk.
///
/// `lhs` and `out` must have equal length; otherwise panics. No internal allocation.
/// This is the inner loop of the OG-02 `=A*2` baseline.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn mul_scalar(lhs: &[f64], scalar: f64, out: &mut [f64]) {
    assert_eq!(
        lhs.len(),
        out.len(),
        "mul_scalar: lhs/out length mismatch (lhs={}, out={})",
        lhs.len(),
        out.len()
    );
    for i in 0..lhs.len() {
        out[i] = lhs[i] * scalar;
    }
}

/// `out[i] = lhs[i] + scalar`.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn add_scalar(lhs: &[f64], scalar: f64, out: &mut [f64]) {
    assert_eq!(lhs.len(), out.len(), "add_scalar: length mismatch");
    for i in 0..lhs.len() {
        out[i] = lhs[i] + scalar;
    }
}

/// `out[i] = lhs[i] - scalar`.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn sub_scalar(lhs: &[f64], scalar: f64, out: &mut [f64]) {
    assert_eq!(lhs.len(), out.len(), "sub_scalar: length mismatch");
    for i in 0..lhs.len() {
        out[i] = lhs[i] - scalar;
    }
}

/// `out[i] = scalar - rhs[i]` (operand order reversed from `sub_scalar`).
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn scalar_sub(scalar: f64, rhs: &[f64], out: &mut [f64]) {
    assert_eq!(rhs.len(), out.len(), "scalar_sub: length mismatch");
    for i in 0..rhs.len() {
        out[i] = scalar - rhs[i];
    }
}

/// `out[i] = lhs[i] + rhs[i]` elementwise.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn add_array(lhs: &[f64], rhs: &[f64], out: &mut [f64]) {
    assert_eq!(lhs.len(), rhs.len(), "add_array: lhs/rhs length mismatch");
    assert_eq!(lhs.len(), out.len(), "add_array: lhs/out length mismatch");
    for i in 0..lhs.len() {
        out[i] = lhs[i] + rhs[i];
    }
}

/// `out[i] = lhs[i] - rhs[i]` elementwise.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn sub_array(lhs: &[f64], rhs: &[f64], out: &mut [f64]) {
    assert_eq!(lhs.len(), rhs.len(), "sub_array: length mismatch");
    assert_eq!(lhs.len(), out.len(), "sub_array: lhs/out length mismatch");
    for i in 0..lhs.len() {
        out[i] = lhs[i] - rhs[i];
    }
}

/// `out[i] = lhs[i] * rhs[i]` elementwise.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn mul_array(lhs: &[f64], rhs: &[f64], out: &mut [f64]) {
    assert_eq!(lhs.len(), rhs.len(), "mul_array: length mismatch");
    assert_eq!(lhs.len(), out.len(), "mul_array: lhs/out length mismatch");
    for i in 0..lhs.len() {
        out[i] = lhs[i] * rhs[i];
    }
}

/// `out[i] = lhs[i] / rhs[i]` elementwise. **Does NOT check for division by zero** —
/// callers are responsible for handling `f64::INFINITY` / `f64::NAN` results. Phase 0
/// `scalar::eval_arithmetic` checks `rhs == 0.0` explicitly to produce `#DIV/0!`; the
/// SIMD path passes through and a post-pass sanitizes via `sanitize_f64`. The bulk
/// kernel stays branch-free for maximum SIMD throughput.
#[multiversion(targets("x86_64+avx2", "x86_64+sse4.2", "aarch64+neon"))]
pub fn div_array(lhs: &[f64], rhs: &[f64], out: &mut [f64]) {
    assert_eq!(lhs.len(), rhs.len(), "div_array: length mismatch");
    assert_eq!(lhs.len(), out.len(), "div_array: lhs/out length mismatch");
    for i in 0..lhs.len() {
        out[i] = lhs[i] / rhs[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_scalar_small() {
        let lhs = [1.0, 2.0, 3.0, 4.0];
        let mut out = [0.0; 4];
        mul_scalar(&lhs, 2.0, &mut out);
        assert_eq!(out, [2.0, 4.0, 6.0, 8.0]);
    }

    #[test]
    fn mul_scalar_empty() {
        let lhs: [f64; 0] = [];
        let mut out: [f64; 0] = [];
        mul_scalar(&lhs, 2.0, &mut out);
    }

    #[test]
    fn mul_scalar_one_chunk() {
        // Chunk-sized: simulate a 16384-row column chunk.
        let lhs: Vec<f64> = (0..16384).map(|i| i as f64).collect();
        let mut out = vec![0.0; 16384];
        mul_scalar(&lhs, 2.0, &mut out);
        for (i, &v) in out.iter().enumerate() {
            assert_eq!(v, (i as f64) * 2.0);
        }
    }

    #[test]
    fn mul_scalar_large() {
        // ~1M elements — exercise SIMD vectorization at scale.
        let n = 1_000_000;
        let lhs: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let mut out = vec![0.0; n];
        mul_scalar(&lhs, 1.5, &mut out);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 1.5);
        assert_eq!(out[100], 150.0);
        assert_eq!(out[n - 1], (n - 1) as f64 * 1.5);
    }

    #[test]
    #[should_panic(expected = "length mismatch")]
    fn mul_scalar_length_mismatch_panics() {
        let lhs = [1.0, 2.0, 3.0];
        let mut out = [0.0; 2];
        mul_scalar(&lhs, 2.0, &mut out);
    }

    #[test]
    fn add_scalar_basic() {
        let lhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        add_scalar(&lhs, 5.0, &mut out);
        assert_eq!(out, [15.0, 25.0, 35.0]);
    }

    #[test]
    fn sub_scalar_basic() {
        let lhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        sub_scalar(&lhs, 3.0, &mut out);
        assert_eq!(out, [7.0, 17.0, 27.0]);
    }

    #[test]
    fn scalar_sub_basic() {
        // `100 - x` not `x - 100`. Important for non-commutative cases.
        let rhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        scalar_sub(100.0, &rhs, &mut out);
        assert_eq!(out, [90.0, 80.0, 70.0]);
    }

    #[test]
    fn add_array_basic() {
        let lhs = [1.0, 2.0, 3.0];
        let rhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        add_array(&lhs, &rhs, &mut out);
        assert_eq!(out, [11.0, 22.0, 33.0]);
    }

    #[test]
    fn mul_array_basic() {
        let lhs = [2.0, 3.0, 4.0];
        let rhs = [5.0, 6.0, 7.0];
        let mut out = [0.0; 3];
        mul_array(&lhs, &rhs, &mut out);
        assert_eq!(out, [10.0, 18.0, 28.0]);
    }

    #[test]
    fn div_array_passes_through_inf_for_div_by_zero() {
        // Per the kernel docstring: no branch for rhs==0. Result is INFINITY, caller
        // post-sanitizes via sanitize_f64 → #DIV/0! upstream of the kernel boundary.
        let lhs = [10.0, 20.0];
        let rhs = [2.0, 0.0];
        let mut out = [0.0; 2];
        div_array(&lhs, &rhs, &mut out);
        assert_eq!(out[0], 5.0);
        assert!(out[1].is_infinite());
    }

    #[test]
    fn og02_correctness_consistency_with_scalar_path() {
        // For =A*2 over a chunk, the SIMD kernel must produce exactly the same values
        // the per-cell scalar evaluator would have. Compare both paths.
        use crate::env::MapEnv;
        use crate::plan::ExprPlan;
        use crate::scalar::eval_scalar;
        use ql_formula_syntax::Operator;
        use ql_types::Value;

        // Build a 1000-element input.
        let n = 1000;
        let input: Vec<f64> = (0..n).map(|i| (i as f64) * 0.5 + 1.0).collect();

        // SIMD path.
        let mut simd_out = vec![0.0; n];
        mul_scalar(&input, 2.0, &mut simd_out);

        // Scalar path: evaluate =CellRef(0, i) * 2.0 for each i.
        let mut env = MapEnv::new();
        for (i, &v) in input.iter().enumerate() {
            env.put(0, i as u32, 0, Value::Number(v));
        }
        for (i, &simd_v) in simd_out.iter().enumerate() {
            let plan = ExprPlan::Binary {
                op: Operator::Mul,
                lhs: Box::new(ExprPlan::CellRef {
                    sheet: 0,
                    row: i as u32,
                    col: 0,
                    abs_col: false,
                    abs_row: false,
                }),
                rhs: Box::new(ExprPlan::Number(2.0)),
            };
            let scalar_result = eval_scalar(&plan, &env);
            assert_eq!(scalar_result, Value::Number(simd_v));
        }
    }

    /// OG-03 acceptance lock: caller pre-allocates the output buffer once and reuses
    /// it across N invocations. The kernel does not allocate internally — verified by
    /// the absence of any `Vec::new`, `Box::new`, etc. in the function body. This test
    /// proves the reuse pattern works correctly (output gets overwritten, not appended).
    #[test]
    fn og03_output_buffer_reuse_across_chunks() {
        let chunk_a: Vec<f64> = (0..16384).map(|i| i as f64).collect();
        let chunk_b: Vec<f64> = (16384..32768).map(|i| i as f64).collect();
        let mut out = vec![0.0; 16384]; // ONE allocation for both chunks.

        mul_scalar(&chunk_a, 2.0, &mut out);
        // Check a few values from chunk A's results.
        assert_eq!(out[0], 0.0);
        assert_eq!(out[100], 200.0);
        assert_eq!(out[16383], 32766.0);

        // Reuse same out buffer for chunk B.
        mul_scalar(&chunk_b, 2.0, &mut out);
        // out has been overwritten with chunk B's results.
        assert_eq!(out[0], 32768.0);
        assert_eq!(out[100], 32968.0);
        assert_eq!(out[16383], 65534.0);
    }
}
