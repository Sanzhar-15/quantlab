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

    // Truncate rows/cols toward zero per Excel canon. Reject negative
    // values as `#VALUE!`. NaN truncates to 0 → falls into the
    // degenerate branch below.
    if !rows_f.is_finite() || !cols_f.is_finite() {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }
    let rows_trunc = rows_f.trunc();
    let cols_trunc = cols_f.trunc();
    if rows_trunc < 0.0 || cols_trunc < 0.0 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }

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
}
