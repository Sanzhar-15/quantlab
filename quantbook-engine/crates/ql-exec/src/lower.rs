//! ExprPlan → SIMD kernel dispatch lowering.
//!
//! The W4-2 SIMD kernels in `simd.rs` operate on `&[f64]` slices. The W4-1 scalar
//! evaluator at `scalar::eval_scalar` works per-cell from an ExprPlan. This module
//! bridges them: classify an ExprPlan into a `SimdShape`, then `dispatch` the shape
//! against caller-supplied input chunks + output buffer.
//!
//! ## Phase 0 W4-3 scope
//!
//! Recognized shapes are the patterns FormulaRegionNode binding produces for the OG-02
//! hot path:
//!
//! - `Binary { op: Mul/Plus/Minus/Div, CellRef, Number }` → `*Scalar` kernels.
//! - `Binary { op: Mul/Plus/Minus/Div, Number, CellRef }` → commutative ops fold to
//!   `*Scalar`; `Minus` becomes the non-commutative `ScalarSub`.
//! - `Binary { op: Mul/Plus/Minus/Div, CellRef, CellRef }` → `*Array` kernels.
//! - Anything else (nested binaries, unary, function calls, comparisons, concat,
//!   string literals, etc.) → `NotApplicable`. The runtime evaluator falls back to
//!   `scalar::eval_scalar` per cell for these.
//!
//! Future shapes (W4-4+):
//! - `Binary { op, CellRef(col_a) * CellRef(col_b), Number(c) }` (FMA-friendly).
//! - `Function { name: "SUM" | "AVERAGE", args: [RangeRef(...)] }` → reduction kernel.
//! - `Binary { op: Eq/Lt/etc., CellRef, Number }` → comparison-bitmap kernel for SUMIF.
//!
//! ## Row-alignment trust
//!
//! The classifier does NOT verify that CellRef rows match the output row. The binder
//! (Week 4 W4-4 FormulaRegion lowering) is responsible for producing row-aligned plans.
//! A cross-row reference like `=A1 + B2` evaluated at row N would silently use chunk N
//! of column A and chunk N of column B, NOT row 1 / row 2. Caller's responsibility for
//! Phase 0; W4-4 will gate via a row-alignment assertion in the FormulaRegion binder.

use crate::plan::ExprPlan;
use crate::simd;
use ql_formula_syntax::Operator;
use ql_types::ColId;

/// Recognized SIMD-friendly shapes. `NotApplicable` triggers a per-cell scalar fallback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SimdShape {
    /// `out[i] = input_col[i] * scalar`. THE OG-02 pattern.
    MulScalar { input_col: ColId, scalar: f64 },
    /// `out[i] = input_col[i] + scalar`.
    AddScalar { input_col: ColId, scalar: f64 },
    /// `out[i] = input_col[i] - scalar`.
    SubScalar { input_col: ColId, scalar: f64 },
    /// `out[i] = scalar - input_col[i]`. Non-commutative inverse of `SubScalar`.
    ScalarSub { scalar: f64, input_col: ColId },
    /// `out[i] = input_col[i] / scalar`. **Caution**: branch-free; scalar==0 produces
    /// f64::INFINITY which the caller must sanitize.
    DivScalar { input_col: ColId, scalar: f64 },
    /// `out[i] = lhs_col[i] * rhs_col[i]`.
    MulArray { lhs_col: ColId, rhs_col: ColId },
    /// `out[i] = lhs_col[i] + rhs_col[i]`.
    AddArray { lhs_col: ColId, rhs_col: ColId },
    /// `out[i] = lhs_col[i] - rhs_col[i]`.
    SubArray { lhs_col: ColId, rhs_col: ColId },
    /// `out[i] = lhs_col[i] / rhs_col[i]`. Same caveat as `DivScalar`.
    DivArray { lhs_col: ColId, rhs_col: ColId },
    /// Pattern not recognized — caller falls back to scalar evaluator per-cell.
    NotApplicable,
}

impl SimdShape {
    /// True iff `dispatch` will route to a SIMD kernel rather than returning false.
    pub fn is_applicable(&self) -> bool {
        !matches!(self, SimdShape::NotApplicable)
    }
}

/// Classify an `ExprPlan` against the SIMD kernel set. Pure function over the plan tree
/// — no side effects, no allocation.
pub fn classify(plan: &ExprPlan) -> SimdShape {
    let ExprPlan::Binary { op, lhs, rhs } = plan else {
        return SimdShape::NotApplicable;
    };

    match (op, lhs.as_ref(), rhs.as_ref()) {
        // CellRef <op> Number — straight 1-arg kernel.
        (Operator::Mul, ExprPlan::CellRef { col, .. }, ExprPlan::Number(n)) => {
            SimdShape::MulScalar {
                input_col: *col,
                scalar: *n,
            }
        }
        (Operator::Plus, ExprPlan::CellRef { col, .. }, ExprPlan::Number(n)) => {
            SimdShape::AddScalar {
                input_col: *col,
                scalar: *n,
            }
        }
        (Operator::Minus, ExprPlan::CellRef { col, .. }, ExprPlan::Number(n)) => {
            SimdShape::SubScalar {
                input_col: *col,
                scalar: *n,
            }
        }
        (Operator::Div, ExprPlan::CellRef { col, .. }, ExprPlan::Number(n)) => {
            SimdShape::DivScalar {
                input_col: *col,
                scalar: *n,
            }
        }

        // Number <op> CellRef — commutative folds to the same kernel; non-commutative
        // (Sub) becomes ScalarSub. Div lacks a SIMD inverse kernel (would need
        // `scalar / x` analog) so falls through to scalar.
        (Operator::Mul, ExprPlan::Number(n), ExprPlan::CellRef { col, .. }) => {
            SimdShape::MulScalar {
                input_col: *col,
                scalar: *n,
            }
        }
        (Operator::Plus, ExprPlan::Number(n), ExprPlan::CellRef { col, .. }) => {
            SimdShape::AddScalar {
                input_col: *col,
                scalar: *n,
            }
        }
        (Operator::Minus, ExprPlan::Number(n), ExprPlan::CellRef { col, .. }) => {
            SimdShape::ScalarSub {
                scalar: *n,
                input_col: *col,
            }
        }

        // CellRef <op> CellRef — two-column kernels.
        (Operator::Mul, ExprPlan::CellRef { col: l, .. }, ExprPlan::CellRef { col: r, .. }) => {
            SimdShape::MulArray {
                lhs_col: *l,
                rhs_col: *r,
            }
        }
        (Operator::Plus, ExprPlan::CellRef { col: l, .. }, ExprPlan::CellRef { col: r, .. }) => {
            SimdShape::AddArray {
                lhs_col: *l,
                rhs_col: *r,
            }
        }
        (Operator::Minus, ExprPlan::CellRef { col: l, .. }, ExprPlan::CellRef { col: r, .. }) => {
            SimdShape::SubArray {
                lhs_col: *l,
                rhs_col: *r,
            }
        }
        (Operator::Div, ExprPlan::CellRef { col: l, .. }, ExprPlan::CellRef { col: r, .. }) => {
            SimdShape::DivArray {
                lhs_col: *l,
                rhs_col: *r,
            }
        }

        // Anything else (nested binaries, comparisons, concat, etc.) — scalar fallback.
        _ => SimdShape::NotApplicable,
    }
}

/// Dispatch a classified shape against caller-supplied input chunks + output buffer.
/// Returns `true` if a SIMD kernel was invoked, `false` if the shape was `NotApplicable`
/// (in which case caller must fall back to scalar evaluation per cell).
///
/// For 1-column shapes (MulScalar, AddScalar, SubScalar, ScalarSub, DivScalar):
/// `lhs_chunk` is the input column data; `rhs_chunk` is ignored (pass `&[]` if you have
/// nothing).
///
/// For 2-column shapes (MulArray, AddArray, SubArray, DivArray):
/// both `lhs_chunk` and `rhs_chunk` are read; they must be equal length and equal to
/// `out.len()`.
pub fn dispatch(shape: &SimdShape, lhs_chunk: &[f64], rhs_chunk: &[f64], out: &mut [f64]) -> bool {
    match shape {
        SimdShape::MulScalar { scalar, .. } => simd::mul_scalar(lhs_chunk, *scalar, out),
        SimdShape::AddScalar { scalar, .. } => simd::add_scalar(lhs_chunk, *scalar, out),
        SimdShape::SubScalar { scalar, .. } => simd::sub_scalar(lhs_chunk, *scalar, out),
        SimdShape::ScalarSub { scalar, .. } => simd::scalar_sub(*scalar, lhs_chunk, out),
        SimdShape::DivScalar { scalar, .. } => {
            // Divide each element by the scalar — express as multiplication by reciprocal
            // for SIMD-friendliness AND consistent NaN/Inf semantics on scalar==0.
            // Note: 1.0 / 0.0 = Inf in IEEE-754, then x * Inf = ±Inf or NaN. Caller
            // post-sanitizes via coercion::sanitize_f64 to surface #DIV/0!.
            simd::mul_scalar(lhs_chunk, 1.0 / *scalar, out)
        }
        SimdShape::MulArray { .. } => simd::mul_array(lhs_chunk, rhs_chunk, out),
        SimdShape::AddArray { .. } => simd::add_array(lhs_chunk, rhs_chunk, out),
        SimdShape::SubArray { .. } => simd::sub_array(lhs_chunk, rhs_chunk, out),
        SimdShape::DivArray { .. } => simd::div_array(lhs_chunk, rhs_chunk, out),
        SimdShape::NotApplicable => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cellref(col: ColId) -> ExprPlan {
        ExprPlan::CellRef {
            sheet: 0,
            row: 0,
            col,
            abs_col: false,
            abs_row: false,
        }
    }

    fn binary(op: Operator, lhs: ExprPlan, rhs: ExprPlan) -> ExprPlan {
        ExprPlan::Binary {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        }
    }

    // ===== classify — single-column shapes =====

    #[test]
    fn classify_og02_mul_scalar() {
        // =A * 2 — THE OG-02 pattern.
        let p = binary(Operator::Mul, cellref(0), ExprPlan::Number(2.0));
        assert_eq!(
            classify(&p),
            SimdShape::MulScalar {
                input_col: 0,
                scalar: 2.0
            }
        );
    }

    #[test]
    fn classify_mul_scalar_commutative() {
        // =2 * A — should also classify as MulScalar (commutative folding).
        let p = binary(Operator::Mul, ExprPlan::Number(2.0), cellref(0));
        assert_eq!(
            classify(&p),
            SimdShape::MulScalar {
                input_col: 0,
                scalar: 2.0
            }
        );
    }

    #[test]
    fn classify_add_scalar_commutative() {
        let p1 = binary(Operator::Plus, cellref(0), ExprPlan::Number(5.0));
        let p2 = binary(Operator::Plus, ExprPlan::Number(5.0), cellref(0));
        let expected = SimdShape::AddScalar {
            input_col: 0,
            scalar: 5.0,
        };
        assert_eq!(classify(&p1), expected);
        assert_eq!(classify(&p2), expected);
    }

    #[test]
    fn classify_sub_scalar_non_commutative() {
        // =A - 5 → SubScalar
        let p_sub = binary(Operator::Minus, cellref(0), ExprPlan::Number(5.0));
        assert_eq!(
            classify(&p_sub),
            SimdShape::SubScalar {
                input_col: 0,
                scalar: 5.0
            }
        );
        // =5 - A → ScalarSub (different kernel)
        let p_inv = binary(Operator::Minus, ExprPlan::Number(5.0), cellref(0));
        assert_eq!(
            classify(&p_inv),
            SimdShape::ScalarSub {
                scalar: 5.0,
                input_col: 0,
            }
        );
    }

    #[test]
    fn classify_div_scalar() {
        // =A / 2 → DivScalar (lowers to mul by reciprocal at dispatch).
        let p = binary(Operator::Div, cellref(0), ExprPlan::Number(2.0));
        assert_eq!(
            classify(&p),
            SimdShape::DivScalar {
                input_col: 0,
                scalar: 2.0
            }
        );
    }

    #[test]
    fn classify_scalar_div_cellref_not_applicable() {
        // =2 / A — no SIMD inverse kernel; falls back to scalar evaluator.
        let p = binary(Operator::Div, ExprPlan::Number(2.0), cellref(0));
        assert_eq!(classify(&p), SimdShape::NotApplicable);
    }

    // ===== classify — two-column shapes =====

    #[test]
    fn classify_array_kernels() {
        let cases = [
            (
                Operator::Mul,
                SimdShape::MulArray {
                    lhs_col: 0,
                    rhs_col: 1,
                },
            ),
            (
                Operator::Plus,
                SimdShape::AddArray {
                    lhs_col: 0,
                    rhs_col: 1,
                },
            ),
            (
                Operator::Minus,
                SimdShape::SubArray {
                    lhs_col: 0,
                    rhs_col: 1,
                },
            ),
            (
                Operator::Div,
                SimdShape::DivArray {
                    lhs_col: 0,
                    rhs_col: 1,
                },
            ),
        ];
        for (op, expected) in cases {
            let p = binary(op, cellref(0), cellref(1));
            assert_eq!(classify(&p), expected, "op={op:?}");
        }
    }

    // ===== classify — non-applicable cases =====

    #[test]
    fn classify_single_cellref_not_applicable() {
        assert_eq!(classify(&cellref(0)), SimdShape::NotApplicable);
    }

    #[test]
    fn classify_single_number_not_applicable() {
        assert_eq!(classify(&ExprPlan::Number(42.0)), SimdShape::NotApplicable);
    }

    #[test]
    fn classify_nested_binary_not_applicable() {
        // =(A + B) * 2 — nested. Phase 0 falls back to scalar; Phase 4+ may add a
        // tree-flattening pass.
        let inner = binary(Operator::Plus, cellref(0), cellref(1));
        let outer = binary(Operator::Mul, inner, ExprPlan::Number(2.0));
        assert_eq!(classify(&outer), SimdShape::NotApplicable);
    }

    #[test]
    fn classify_unary_not_applicable() {
        let p = ExprPlan::Unary {
            op: Operator::Minus,
            operand: Box::new(cellref(0)),
        };
        assert_eq!(classify(&p), SimdShape::NotApplicable);
    }

    #[test]
    fn classify_comparison_not_applicable() {
        // =A < 5 — comparison; Phase 0 has no comparison kernels (W4-4+ for SUMIF).
        let p = binary(Operator::Lt, cellref(0), ExprPlan::Number(5.0));
        assert_eq!(classify(&p), SimdShape::NotApplicable);
    }

    #[test]
    fn is_applicable_helper() {
        assert!(SimdShape::MulScalar {
            input_col: 0,
            scalar: 1.0
        }
        .is_applicable());
        assert!(!SimdShape::NotApplicable.is_applicable());
    }

    // ===== dispatch — verify each shape produces correct output =====

    #[test]
    fn dispatch_mul_scalar() {
        let shape = SimdShape::MulScalar {
            input_col: 0,
            scalar: 2.0,
        };
        let lhs = [1.0, 2.0, 3.0];
        let mut out = [0.0; 3];
        assert!(dispatch(&shape, &lhs, &[], &mut out));
        assert_eq!(out, [2.0, 4.0, 6.0]);
    }

    #[test]
    fn dispatch_scalar_sub() {
        let shape = SimdShape::ScalarSub {
            scalar: 100.0,
            input_col: 0,
        };
        let lhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        assert!(dispatch(&shape, &lhs, &[], &mut out));
        assert_eq!(out, [90.0, 80.0, 70.0]);
    }

    #[test]
    fn dispatch_div_scalar_via_reciprocal_mul() {
        // =A / 2 should produce A * 0.5 results.
        let shape = SimdShape::DivScalar {
            input_col: 0,
            scalar: 2.0,
        };
        let lhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        assert!(dispatch(&shape, &lhs, &[], &mut out));
        assert_eq!(out, [5.0, 10.0, 15.0]);
    }

    #[test]
    fn dispatch_div_scalar_by_zero_produces_inf() {
        // =A / 0 → caller responsibility to sanitize. Reciprocal-mul produces ±Inf.
        let shape = SimdShape::DivScalar {
            input_col: 0,
            scalar: 0.0,
        };
        let lhs = [10.0, 20.0, 30.0];
        let mut out = [0.0; 3];
        dispatch(&shape, &lhs, &[], &mut out);
        for &v in &out {
            assert!(v.is_infinite() || v.is_nan());
        }
    }

    #[test]
    fn dispatch_mul_array() {
        let shape = SimdShape::MulArray {
            lhs_col: 0,
            rhs_col: 1,
        };
        let lhs = [2.0, 3.0, 4.0];
        let rhs = [5.0, 6.0, 7.0];
        let mut out = [0.0; 3];
        assert!(dispatch(&shape, &lhs, &rhs, &mut out));
        assert_eq!(out, [10.0, 18.0, 28.0]);
    }

    #[test]
    fn dispatch_not_applicable_returns_false() {
        let shape = SimdShape::NotApplicable;
        let mut out = [0.0; 3];
        let did_simd = dispatch(&shape, &[], &[], &mut out);
        assert!(!did_simd);
        // Out buffer untouched (still zeros).
        assert_eq!(out, [0.0; 3]);
    }

    /// End-to-end: classify the OG-02 pattern then dispatch and verify output.
    #[test]
    fn og02_e2e_classify_then_dispatch() {
        // =A * 2 — bind, classify, dispatch over a small chunk.
        let plan = binary(Operator::Mul, cellref(0), ExprPlan::Number(2.0));
        let shape = classify(&plan);
        assert!(shape.is_applicable());

        let input: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        let mut out = vec![0.0; 1000];
        assert!(dispatch(&shape, &input, &[], &mut out));
        for (i, &v) in out.iter().enumerate() {
            assert_eq!(v, (i as f64) * 2.0);
        }
    }
}
