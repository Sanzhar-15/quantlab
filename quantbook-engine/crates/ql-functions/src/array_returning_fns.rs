//! Array-returning function implementations.
//!
//! Phase 4.7.M (W5-106): the first wave of dynamic-array functions.
//! These functions register via `register_unified` and use the
//! `FunctionFn` ABI introduced in W5-96 (Phase 4.7.B), returning
//! `FunctionReturn::Array(_)` for the cell-boundary spill path.
//!
//! Per design doc § 6.2:
//! `docs/architecture/2026-05-14-array-formulas-and-spills.md`.
//!
//! ## Excel semantics
//!
//! At the cell boundary (the formula bar entry point), these return
//! arrays that the runtime materializes via `write_spill` into the
//! computed overlay. In any other context (sub-expression, scalar
//! arithmetic operand), the eval-site scalar dispatch surfaces the
//! return as `Value::Error(ErrorValue::Calc)` per design § 6.3 (Excel
//! 365's dynamic-array semantics; no implicit intersection in v1).
//!
//! ## Argument coercion
//!
//! `SEQUENCE(rows, cols?, start?, step?)` — all numeric args. Coerce
//! via the same lenient rules `scalar_fns` uses for scalar functions
//! (`to_number_lenient`): Numbers pass through, Booleans become 0/1,
//! text-that-parses-as-number coerces, anything else → `#VALUE!`.
//! `rows` and `cols` truncate toward zero (Excel canon) and must be
//! `>= 1`; otherwise the function returns a degenerate `ArrayValue`,
//! which the cell-boundary path surfaces as `#CALC!` per design § 8.1
//! step c.
//!
//! ## Bounds
//!
//! `rows * cols` is bounded by `u32::MAX` cells (the `ArrayValue`
//! capacity). The runtime spill writeback path additionally enforces
//! the workbook-grid bound (`MAX_ROW` / `MAX_COLUMN` at the anchor's
//! position).

use ql_types::{coercion, ArrayValue, ErrorValue, Value};

use crate::registry::{FunctionArg, FunctionContext, FunctionReturn};

/// Helper: coerce a `FunctionArg::Scalar` to an `f64` using the same
/// lenient rules `scalar_fns` uses internally. Non-Scalar args (Range,
/// Array) return `None` — they're not valid for SEQUENCE's numeric
/// parameter positions. Errors propagate as `None` so the caller can
/// surface them as a per-call return error.
///
/// `Value::Error` cases return `Some(Err(error))` so the caller can
/// propagate the SPECIFIC error (Excel canon: left-error-wins in arg
/// evaluation).
fn coerce_arg_to_f64(arg: &FunctionArg) -> Result<f64, Value> {
    match arg {
        FunctionArg::Scalar(v) => match v {
            Value::Error(e) => Err(Value::Error(*e)),
            other => match coercion::to_number_lenient(other) {
                Ok(n) => Ok(n),
                Err(e) => Err(Value::Error(e)),
            },
        },
        // Per Excel canon, passing a range/array to a scalar arg
        // position yields `#VALUE!` (legacy mode) or implicit
        // intersection (dynamic mode). v1 spec defers implicit
        // intersection (design § 6.3); surface `#VALUE!` for now.
        FunctionArg::Range { .. } | FunctionArg::Array(_) => Err(Value::Error(ErrorValue::Value)),
    }
}

/// `SEQUENCE(rows, [cols], [start], [step])` — generate a sequential
/// numeric array.
///
/// - `rows` (required): positive integer (truncated toward zero).
/// - `cols` (optional, default 1).
/// - `start` (optional, default 1.0).
/// - `step` (optional, default 1.0).
///
/// Result is a row-major `ArrayValue(rows, cols)` filled with
/// `start, start + step, start + 2*step, ...`.
///
/// Per design § 8.1 step c, a degenerate (`rows == 0 || cols == 0`)
/// result surfaces as `#CALC!` at the cell-boundary writeback;
/// SEQUENCE itself returns the degenerate `ArrayValue::empty(0, cols)`
/// (or empty rows, 0 cols) in those cases and lets the caller error
/// at the boundary. Negative `rows` / `cols` after truncation:
/// `#VALUE!` (Excel canon — can't have negative dimensions).
///
/// Arity validation: 1..=4 args; outside that range returns
/// `#N/A` (Excel canon for wrong-arity).
pub fn sequence(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    // Arity check.
    if args.is_empty() || args.len() > 4 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }

    // Coerce args. Left-error-wins: the first error arg's specific
    // error variant is what propagates.
    let rows_f = match coerce_arg_to_f64(&args[0]) {
        Ok(n) => n,
        Err(e) => return FunctionReturn::Scalar(e),
    };
    let cols_f = if args.len() >= 2 {
        match coerce_arg_to_f64(&args[1]) {
            Ok(n) => n,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };
    let start = if args.len() >= 3 {
        match coerce_arg_to_f64(&args[2]) {
            Ok(n) => n,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };
    let step = if args.len() >= 4 {
        match coerce_arg_to_f64(&args[3]) {
            Ok(n) => n,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };

    // Truncate rows/cols toward zero per Excel canon. NaN truncates
    // to 0; non-finite is rejected up front.
    if !rows_f.is_finite() || !cols_f.is_finite() {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }
    // **Codex audit MEDIUM closure**: reject negative dims BEFORE
    // truncation. `(-0.5).trunc()` is `-0.0` (sign-preserving), which
    // passes `< 0.0` (since `-0.0 < 0.0` is false). The post-trunc
    // check would then turn it into `0` and produce a misleading
    // degenerate-array (#CALC!) instead of the correct #VALUE! that
    // signals "negative dimension is wrong." Pre-trunc check catches
    // the (-1.0, 0.0) range correctly.
    if rows_f < 0.0 || cols_f < 0.0 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }
    let rows_trunc = rows_f.trunc();
    let cols_trunc = cols_f.trunc();

    // Bound by u32::MAX so cell-count doesn't overflow. Excel's actual
    // hard limit is 1M rows × 16K cols, but our grid-bound check at
    // write_spill catches that; here we just guard the multiplication.
    if rows_trunc > u32::MAX as f64 || cols_trunc > u32::MAX as f64 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
    }
    let rows = rows_trunc as u32;
    let cols = cols_trunc as u32;

    // Degenerate shape: return empty ArrayValue. The cell-boundary
    // writeback path surfaces this as `#CALC!` (design § 8.1 step c).
    if rows == 0 || cols == 0 {
        return FunctionReturn::Array(ArrayValue::empty(rows, cols));
    }

    // Total cell count. Guard against rows*cols overflow even after
    // individual u32 bound check — the product could exceed usize on
    // 32-bit targets in theory; bound to a reasonable cap.
    let total = (rows as u64).saturating_mul(cols as u64);
    if total > (i32::MAX as u64) {
        // Heuristic ceiling: u32::MAX cells × 8 bytes = 32 GiB. Even
        // a 1M × 16K Excel grid is 16G cells. Capping at i32::MAX (~2.1G
        // cells) is generous for any realistic use; surface #NUM!
        // beyond that.
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
    }
    let total = total as usize;

    let mut cells: Vec<Value> = Vec::with_capacity(total);
    for i in 0..total {
        let v = start + (i as f64) * step;
        // Sanitize NaN/Inf per Excel canon. Step can underflow to NaN
        // if start is Inf etc.; we already rejected non-finite scalar
        // args above, but i*step at extreme values could still
        // produce non-finite results.
        if !v.is_finite() {
            cells.push(Value::Error(ErrorValue::Num));
        } else {
            cells.push(Value::Number(v));
        }
    }

    let arr = ArrayValue::new(rows, cols, cells)
        .expect("rows*cols == total; ArrayValue::new must succeed");
    FunctionReturn::Array(arr)
}

/// **W5-107 (Phase 4.7.N) — TRANSPOSE.** Swap rows ↔ cols. Per
/// design § 11 and Excel canon.
///
/// `TRANSPOSE(array)` — single arg, returns a transposed `ArrayValue`
/// where `result.at(j, i) = array.at(i, j)`. Result shape is
/// `(cols, rows)`.
///
/// Arg shapes:
/// - `FunctionArg::Array(a)` → transpose `a`.
/// - `FunctionArg::Range { values, rows, cols }` — treat as a 2D
///   array, transpose it. Range arg position acts identically to
///   Array here (read-only over the cell values).
/// - `FunctionArg::Scalar(Value::Error(_))` → propagate (left-error
///   contract).
/// - `FunctionArg::Scalar(other)` → 1×1 transpose = 1×1 same value
///   (Excel: a scalar is implicitly a 1×1 array; TRANSPOSE of 1×1 is
///   1×1 unchanged).
///
/// Arity: exactly 1 arg. 0 or ≥ 2 → `#N/A`.
///
/// Degenerate input (`rows == 0 || cols == 0`) → degenerate output of
/// the swapped shape. Cell-boundary writeback surfaces `#CALC!` per
/// design § 8.1 step c.
pub fn transpose(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.len() != 1 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }

    let (in_rows, in_cols, cells): (u32, u32, Vec<Value>) = match &args[0] {
        FunctionArg::Scalar(Value::Error(e)) => {
            return FunctionReturn::Scalar(Value::Error(*e));
        }
        FunctionArg::Scalar(v) => {
            // Excel canon: scalar is implicitly 1×1. TRANSPOSE keeps shape.
            return FunctionReturn::Array(ArrayValue::singleton(v.clone()));
        }
        FunctionArg::Array(a) => {
            // Materialize cell vec; ArrayValue exposes row-major slice
            // via `cells()`. Clone is the simplest path; an in-place
            // permutation would save a copy but adds complexity for
            // little gain on realistic sizes.
            (a.rows(), a.cols(), a.cells().to_vec())
        }
        FunctionArg::Range { values, rows, cols } => {
            // Range carries explicit (rows, cols) per the unified ABI.
            // Bound to u32 for the ArrayValue API.
            if *rows > u32::MAX as usize || *cols > u32::MAX as usize {
                return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
            }
            (*rows as u32, *cols as u32, values.clone())
        }
    };

    // Degenerate input → degenerate transposed output (swapped shape).
    // ArrayValue::empty constructs the (rows, cols) variant with no
    // cells; the cell-boundary path surfaces this as `#CALC!`.
    if in_rows == 0 || in_cols == 0 {
        return FunctionReturn::Array(ArrayValue::empty(in_cols, in_rows));
    }

    // Allocate the output cell vec. Output has (in_cols, in_rows)
    // shape; `result_cells[j * in_rows + i] = cells[i * in_cols + j]`.
    let total = (in_rows as usize) * (in_cols as usize);
    let mut result_cells: Vec<Value> = Vec::with_capacity(total);
    // Iterate output row-major: outer loop over new rows j (was cols),
    // inner over new cols i (was rows).
    for j in 0..in_cols {
        for i in 0..in_rows {
            let src_idx = (i as usize) * (in_cols as usize) + (j as usize);
            result_cells.push(cells[src_idx].clone());
        }
    }
    let arr = ArrayValue::new(in_cols, in_rows, result_cells)
        .expect("rows*cols == total; ArrayValue::new must succeed");
    FunctionReturn::Array(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> FunctionContext<'static> {
        // Static EvalContext stand-in for tests that don't need
        // workbook awareness. Volatile fns need a real ctx; SEQUENCE
        // doesn't.
        use std::sync::OnceLock;
        static ECTX: OnceLock<ql_types::EvalContext> = OnceLock::new();
        FunctionContext::new(ECTX.get_or_init(ql_types::EvalContext::default))
    }

    fn n(v: f64) -> FunctionArg {
        FunctionArg::Scalar(Value::Number(v))
    }

    fn expect_array(ret: FunctionReturn) -> ArrayValue {
        match ret {
            FunctionReturn::Array(a) => a,
            FunctionReturn::Scalar(v) => panic!("expected array, got Scalar({:?})", v),
        }
    }

    fn expect_scalar_error(ret: FunctionReturn) -> ErrorValue {
        match ret {
            FunctionReturn::Scalar(Value::Error(e)) => e,
            other => panic!("expected scalar error, got {:?}", other),
        }
    }

    #[test]
    fn sequence_rows_only_produces_column_vector() {
        let arr = expect_array(sequence(&[n(3.0)], &ctx()));
        assert_eq!(arr.rows(), 3);
        assert_eq!(arr.cols(), 1);
        assert_eq!(arr.at(0, 0), &Value::Number(1.0));
        assert_eq!(arr.at(1, 0), &Value::Number(2.0));
        assert_eq!(arr.at(2, 0), &Value::Number(3.0));
    }

    #[test]
    fn sequence_rows_cols_row_major_fill() {
        let arr = expect_array(sequence(&[n(2.0), n(3.0)], &ctx()));
        assert_eq!(arr.rows(), 2);
        assert_eq!(arr.cols(), 3);
        // Row-major: 1, 2, 3 across row 0; 4, 5, 6 across row 1.
        assert_eq!(arr.at(0, 0), &Value::Number(1.0));
        assert_eq!(arr.at(0, 1), &Value::Number(2.0));
        assert_eq!(arr.at(0, 2), &Value::Number(3.0));
        assert_eq!(arr.at(1, 0), &Value::Number(4.0));
        assert_eq!(arr.at(1, 1), &Value::Number(5.0));
        assert_eq!(arr.at(1, 2), &Value::Number(6.0));
    }

    #[test]
    fn sequence_custom_start() {
        let arr = expect_array(sequence(&[n(3.0), n(1.0), n(10.0)], &ctx()));
        assert_eq!(arr.at(0, 0), &Value::Number(10.0));
        assert_eq!(arr.at(1, 0), &Value::Number(11.0));
        assert_eq!(arr.at(2, 0), &Value::Number(12.0));
    }

    #[test]
    fn sequence_custom_start_and_step() {
        let arr = expect_array(sequence(&[n(4.0), n(1.0), n(10.0), n(5.0)], &ctx()));
        assert_eq!(arr.at(0, 0), &Value::Number(10.0));
        assert_eq!(arr.at(1, 0), &Value::Number(15.0));
        assert_eq!(arr.at(2, 0), &Value::Number(20.0));
        assert_eq!(arr.at(3, 0), &Value::Number(25.0));
    }

    #[test]
    fn sequence_negative_step() {
        let arr = expect_array(sequence(&[n(3.0), n(1.0), n(10.0), n(-1.0)], &ctx()));
        assert_eq!(arr.at(0, 0), &Value::Number(10.0));
        assert_eq!(arr.at(1, 0), &Value::Number(9.0));
        assert_eq!(arr.at(2, 0), &Value::Number(8.0));
    }

    #[test]
    fn sequence_truncates_fractional_dims() {
        // 2.7 truncates to 2; 3.999 truncates to 3.
        let arr = expect_array(sequence(&[n(2.7), n(3.999)], &ctx()));
        assert_eq!(arr.rows(), 2);
        assert_eq!(arr.cols(), 3);
    }

    #[test]
    fn sequence_zero_rows_returns_degenerate_array() {
        // rows = 0 → ArrayValue::empty(0, 1) (degenerate).
        let arr = expect_array(sequence(&[n(0.0)], &ctx()));
        assert!(arr.is_degenerate());
        assert_eq!(arr.rows(), 0);
        assert_eq!(arr.cols(), 1);
    }

    #[test]
    fn sequence_zero_cols_returns_degenerate_array() {
        let arr = expect_array(sequence(&[n(3.0), n(0.0)], &ctx()));
        assert!(arr.is_degenerate());
    }

    #[test]
    fn sequence_negative_rows_returns_value_error() {
        let e = expect_scalar_error(sequence(&[n(-1.0)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    /// **Codex audit MEDIUM closure**: `SEQUENCE(-0.5)` must return
    /// `#VALUE!`, NOT a degenerate array (which surfaces as `#CALC!`).
    /// Pre-fix: `(-0.5).trunc()` is `-0.0` (sign-preserving f64),
    /// which passes `< 0.0` (since `-0.0 < 0.0` is false), then
    /// becomes `0` after `as u32` cast → degenerate ArrayValue →
    /// #CALC!. The fix moves the negativity check pre-trunc so
    /// fractional negatives are correctly rejected.
    #[test]
    fn sequence_negative_fractional_rows_returns_value_error_not_calc() {
        let e = expect_scalar_error(sequence(&[n(-0.5)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sequence_negative_fractional_cols_returns_value_error_not_calc() {
        let e = expect_scalar_error(sequence(&[n(1.0), n(-0.5)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sequence_zero_args_returns_na() {
        let e = expect_scalar_error(sequence(&[], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    #[test]
    fn sequence_five_args_returns_na() {
        let e = expect_scalar_error(sequence(&[n(1.0), n(1.0), n(1.0), n(1.0), n(1.0)], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    #[test]
    fn sequence_error_arg_propagates() {
        let div0 = FunctionArg::Scalar(Value::Error(ErrorValue::DivZero));
        let e = expect_scalar_error(sequence(&[div0], &ctx()));
        assert_eq!(
            e,
            ErrorValue::DivZero,
            "first-error-wins: SEQUENCE propagates the specific arg error"
        );
    }

    #[test]
    fn sequence_text_arg_that_parses_coerces_correctly() {
        let text_3 = FunctionArg::Scalar(Value::Text(std::sync::Arc::from("3")));
        let arr = expect_array(sequence(&[text_3], &ctx()));
        assert_eq!(arr.rows(), 3);
        assert_eq!(arr.cols(), 1);
    }

    #[test]
    fn sequence_text_arg_that_doesnt_parse_returns_value_error() {
        let bad = FunctionArg::Scalar(Value::Text(std::sync::Arc::from("not a number")));
        let e = expect_scalar_error(sequence(&[bad], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sequence_range_arg_returns_value_error() {
        let r = FunctionArg::Range {
            values: vec![Value::Number(1.0)],
            rows: 1,
            cols: 1,
        };
        let e = expect_scalar_error(sequence(&[r], &ctx()));
        assert_eq!(
            e,
            ErrorValue::Value,
            "range arg at scalar position: #VALUE! per v1 (implicit intersection deferred)"
        );
    }

    // ===== W5-107 (Phase 4.7.N.1) — TRANSPOSE =====

    fn arr(rows: u32, cols: u32, cells: Vec<Value>) -> FunctionArg {
        FunctionArg::Array(ArrayValue::new(rows, cols, cells).unwrap())
    }

    /// TRANSPOSE of a 1×3 row → 3×1 column.
    #[test]
    fn transpose_1x3_to_3x1() {
        let input = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 3);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
        assert_eq!(result.at(2, 0), &Value::Number(3.0));
    }

    /// TRANSPOSE of a 3×1 column → 1×3 row.
    #[test]
    fn transpose_3x1_to_1x3() {
        let input = arr(
            3,
            1,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 3);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(2.0));
        assert_eq!(result.at(0, 2), &Value::Number(3.0));
    }

    /// TRANSPOSE of a 2×2 — rows ↔ cols swap.
    /// Input:  {1, 2; 3, 4} → output: {1, 3; 2, 4}.
    #[test]
    fn transpose_2x2_swaps_off_diagonal() {
        let input = arr(
            2,
            2,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 2);
        assert_eq!(result.cols(), 2);
        // Row 0: 1, 3.
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(3.0));
        // Row 1: 2, 4.
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
        assert_eq!(result.at(1, 1), &Value::Number(4.0));
    }

    /// TRANSPOSE of a non-square 2×3 → 3×2.
    /// Input:  {1, 2, 3; 4, 5, 6} → output: {1, 4; 2, 5; 3, 6}.
    #[test]
    fn transpose_2x3_to_3x2() {
        let input = arr(
            2,
            3,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 3);
        assert_eq!(result.cols(), 2);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(4.0));
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
        assert_eq!(result.at(1, 1), &Value::Number(5.0));
        assert_eq!(result.at(2, 0), &Value::Number(3.0));
        assert_eq!(result.at(2, 1), &Value::Number(6.0));
    }

    /// TRANSPOSE of a Range arg — same shape semantics as Array arg.
    #[test]
    fn transpose_range_arg() {
        let input = FunctionArg::Range {
            values: vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
            rows: 2,
            cols: 2,
        };
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 2);
        assert_eq!(result.cols(), 2);
        assert_eq!(result.at(0, 1), &Value::Number(3.0));
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
    }

    /// TRANSPOSE of a scalar — implicit 1×1 array; result is 1×1
    /// containing the same value (Excel canon).
    #[test]
    fn transpose_scalar_returns_singleton() {
        let result = expect_array(transpose(&[n(42.0)], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Number(42.0));
    }

    /// TRANSPOSE of a degenerate input (0 rows) → degenerate with
    /// swapped shape (0 cols).
    #[test]
    fn transpose_degenerate_input_returns_degenerate() {
        let input = FunctionArg::Array(ArrayValue::empty(0, 3));
        let result = expect_array(transpose(&[input], &ctx()));
        assert!(result.is_degenerate());
        assert_eq!(result.rows(), 3);
        assert_eq!(result.cols(), 0);
    }

    /// Error arg propagates per left-error-wins.
    #[test]
    fn transpose_error_arg_propagates() {
        let div0 = FunctionArg::Scalar(Value::Error(ErrorValue::DivZero));
        let e = expect_scalar_error(transpose(&[div0], &ctx()));
        assert_eq!(e, ErrorValue::DivZero);
    }

    /// Arity violations — 0 args → #N/A.
    #[test]
    fn transpose_zero_args_returns_na() {
        let e = expect_scalar_error(transpose(&[], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    /// Arity violations — 2 args → #N/A.
    #[test]
    fn transpose_two_args_returns_na() {
        let e = expect_scalar_error(transpose(&[n(1.0), n(2.0)], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    /// Idempotent: TRANSPOSE(TRANSPOSE(x)) == x (shape and values).
    #[test]
    fn transpose_is_involutive() {
        let input = arr(
            2,
            3,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ],
        );
        // Save original cells for comparison.
        let original_cells: Vec<Value> = match &input {
            FunctionArg::Array(a) => a.cells().to_vec(),
            _ => unreachable!(),
        };
        let once = expect_array(transpose(&[input], &ctx()));
        let twice = expect_array(transpose(&[FunctionArg::Array(once)], &ctx()));
        assert_eq!(twice.rows(), 2);
        assert_eq!(twice.cols(), 3);
        assert_eq!(twice.cells(), original_cells.as_slice());
    }
}
