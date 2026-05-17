//! Reference-aware function impls (W5-RT-2 / RT-V1-01 Step 2).
//!
//! Implements ROW / COLUMN / ROWS / COLUMNS — the address-only subset of
//! the reference-tier mini-phase. All four register through
//! `RegisteredFn::ReferenceAware` with `ArgContract::Eager`.
//!
//! Design doc: `docs/architecture/2026-05-17-reference-tier-design.md` § 5.6.
//! Audit summary: `docs/audits/2026-05-17-reference-tier-audit-summary.md`.
//!
//! ## v1 stance recap
//!
//! - **0-vs-1-indexed:** `RowId` / `ColId` are `u32` 0-indexed internally.
//!   ROW/COLUMN convert to Excel's 1-indexed output by `+ 1`.
//! - **`#REF!` propagation:** any `RefArg::Error(ev)` arg propagates `ev`
//!   first (per HIGH-F closure).
//! - **Non-reference args:** `Scalar` / `Shape` / `Array` (for ROW/COLUMN
//!   only; ROWS/COLUMNS accept arrays) → `#VALUE!`.
//! - **Arity mismatch:** > 1 arg for ROW/COLUMN → `#N/A`; wrong arity for
//!   ROWS/COLUMNS → `#N/A`.
//! - **Calling-cell context:** `ROW()` / `COLUMN()` with no arg use
//!   `RefContext::formula_cell`. If `None` (test envs without a formula
//!   cell), return `#REF!`.
//! - **Spill defer:** in scalar context, multi-cell range arg returns
//!   top-left (Excel pre-365 implicit intersection). At the cell boundary,
//!   the dispatcher guard in `eval_at_cell_boundary` intercepts and
//!   returns `#CALC!` — implemented in W5-RT-1, NOT here.

use ql_types::{ErrorValue, Value};

use crate::reference_aware_fns::{RefArg, RefContext};

/// **ROW([ref])** — returns the 1-indexed row number of `ref`'s top-left
/// cell, or of the calling cell if `ref` is omitted.
///
/// - `ROW()` returns the calling cell's 1-indexed row (or `#REF!` if no
///   calling cell is known — typical for non-cell evaluation paths).
/// - `ROW(A1)` returns `1`.
/// - `ROW(A1:B3)` returns `1` in scalar context (top-left row). At the
///   cell boundary the dispatcher guard rejects with `#CALC!` (HIGH-E
///   closure in W5-RT-1).
/// - `ROW("text")` / `ROW(1+2)` → `#VALUE!`.
/// - `ROW(#REF!)` → `#REF!` (error propagation).
/// - `ROW(arg1, arg2)` → `#N/A` (arity).
///
/// **v1 scope reduction (S2-HIGH-3 documentation closure):**
/// `ROW(SUM(A1:A3))` does NOT reach the design's `#VALUE!` outcome —
/// the inner `SUM(A1:A3)` literal-range argument bind-fails because
/// S1-MED-γ deferred AggregateArg-side `Expr::RangeRef` lowering (the
/// scalar/range-aware/unified dispatcher arms would each need new
/// consumer logic for `ExprPlan::RangeRef`). The named-range form —
/// `ROW(SUM(NamedRange))` — DOES work via the existing
/// `AggregateNameRef` path and evaluates eagerly; ROW receives a
/// Scalar arg and returns `#VALUE!` per the design. Lifting the
/// AggregateArg defer is a post-RT-V1 follow-up.
pub fn row(args: &[RefArg], ctx: &RefContext) -> Value {
    match args.len() {
        0 => match ctx.formula_cell {
            Some(addr) => Value::number(f64::from(addr.row) + 1.0),
            None => Value::Error(ErrorValue::Ref),
        },
        1 => match &args[0] {
            // Error propagation first (HIGH-F closure).
            RefArg::Error(ev) => Value::Error(*ev),
            RefArg::Reference { address, .. } => Value::number(f64::from(address.row) + 1.0),
            RefArg::Range { range, .. } => Value::number(f64::from(range.start_row) + 1.0),
            // ROW does NOT accept array literals (only ROWS does).
            // Microsoft canon: `ROW({1,2,3})` is array-context spill;
            // v1 returns `#VALUE!` in scalar context.
            RefArg::Array(_) => Value::Error(ErrorValue::Value),
            // Scalar (non-reference literal / eager-eval result) and Shape
            // (LazyShape — but ROW uses Eager contract, so Shape is
            // unreachable here): not a reference.
            RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value),
        },
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **COLUMN([ref])** — symmetric to [`row`], returning the 1-indexed
/// column number.
pub fn column(args: &[RefArg], ctx: &RefContext) -> Value {
    match args.len() {
        0 => match ctx.formula_cell {
            Some(addr) => Value::number(f64::from(addr.col) + 1.0),
            None => Value::Error(ErrorValue::Ref),
        },
        1 => match &args[0] {
            RefArg::Error(ev) => Value::Error(*ev),
            RefArg::Reference { address, .. } => Value::number(f64::from(address.col) + 1.0),
            RefArg::Range { range, .. } => Value::number(f64::from(range.start_col) + 1.0),
            RefArg::Array(_) => Value::Error(ErrorValue::Value),
            RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value),
        },
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **ROWS(arg)** — returns the row count of `arg`.
///
/// - `ROWS(A1)` → `1` (single cell).
/// - `ROWS(A1:B3)` → `3` (range).
/// - `ROWS(A:A)` → `1_048_576` (whole-column expands to `MAX_ROW + 1`).
/// - `ROWS({1,2,3;4,5,6})` → `2` (array literal — Microsoft canon, HIGH-C
///   closure in W5-RT-1).
/// - `ROWS(#REF!)` → `#REF!`.
/// - `ROWS("text")` / `ROWS(1+2)` → `#VALUE!`.
/// - `ROWS()` / `ROWS(a, b)` → `#N/A`.
pub fn rows(args: &[RefArg], _ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Range { range, .. }] => {
            // Inclusive count: end_row - start_row + 1. WholeColumn binds
            // to start_row=0, end_row=MAX_ROW=1_048_575 → 1_048_576.
            //
            // **Step 2.1 (S2-MED-β defensive guard):** `Range::new`
            // normalizes corners so `end >= start` for binder-produced
            // ranges. Public-API paths (qbook import, programmatic
            // `NamedTarget::Range(...)` construction) bypass that
            // normalization; an inverted range would underflow `u32`
            // subtraction. Surface `#REF!` via `checked_sub` rather than
            // panic or wrap.
            match range.end_row.checked_sub(range.start_row) {
                Some(diff) => Value::number(f64::from(diff + 1)),
                None => Value::Error(ErrorValue::Ref),
            }
        }
        [RefArg::Reference { .. }] => Value::number(1.0),
        // Array literal: row count = the array's first dimension.
        [RefArg::Array(av)] => Value::number(f64::from(av.rows())),
        [RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::Value),
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **COLUMNS(arg)** — symmetric to [`rows`], returning the column count.
pub fn columns(args: &[RefArg], _ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Range { range, .. }] => {
            // **Step 2.1 (S2-MED-β defensive guard):** see `rows` for
            // rationale — `checked_sub` defends against inverted ranges
            // from public-API paths that bypass `Range::new` normalization.
            match range.end_col.checked_sub(range.start_col) {
                Some(diff) => Value::number(f64::from(diff + 1)),
                None => Value::Error(ErrorValue::Ref),
            }
        }
        [RefArg::Reference { .. }] => Value::number(1.0),
        [RefArg::Array(av)] => Value::number(f64::from(av.cols())),
        [RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::Value),
        _ => Value::Error(ErrorValue::NA),
    }
}

// =====================================================================
// Tests — each fn ≥ 8 per the design § 7 + audit-discipline MEDIUM-δ
// =====================================================================
//
// LibreOffice 7.6 cross-checks (per design § 7 LOW-4 closure):
//   ROW(B5) = 5
//   COLUMN(B5) = 2
//   ROWS(A1:A5) = 5
//   ROWS(A:A) = 1048576
//   COLUMNS(A1:E1) = 5
//   COLUMNS(1:1) = 16384
//   ROWS({1,2,3;4,5,6}) = 2
//   COLUMNS({1,2,3;4,5,6}) = 3

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference_aware_fns::{PlanKind, NO_OP_REFERENCE_QUERY};
    use ql_types::{Address, ArrayValue, Range, DEFAULT_EVAL_CONTEXT};

    fn ctx_no_cell<'a>() -> RefContext<'a> {
        RefContext::new(&DEFAULT_EVAL_CONTEXT, None, &NO_OP_REFERENCE_QUERY)
    }

    fn ctx_at(sheet: u16, row: u32, col: u32) -> RefContext<'static> {
        RefContext::new(
            &DEFAULT_EVAL_CONTEXT,
            Some(Address::new(sheet, row, col)),
            &NO_OP_REFERENCE_QUERY,
        )
    }

    fn cell_ref(sheet: u16, row: u32, col: u32) -> RefArg {
        RefArg::Reference {
            address: Address::new(sheet, row, col),
            value: Value::Blank,
        }
    }

    fn range_ref(sheet: u16, r1: u32, c1: u32, r2: u32, c2: u32) -> RefArg {
        RefArg::Range {
            range: Range::new(sheet, r1, c1, r2, c2),
            values: vec![],
        }
    }

    // ----- ROW -----

    #[test]
    fn row_of_cell_a1_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(row(&[cell_ref(0, 0, 0)], &ctx), Value::number(1.0));
    }

    #[test]
    fn row_of_cell_b5_returns_5() {
        // LibreOffice cross-check: ROW(B5) = 5.
        let ctx = ctx_no_cell();
        assert_eq!(row(&[cell_ref(0, 4, 1)], &ctx), Value::number(5.0));
    }

    #[test]
    fn row_of_range_returns_top_left_row() {
        let ctx = ctx_no_cell();
        // Range A1:B3 → top-left row = 1.
        assert_eq!(row(&[range_ref(0, 0, 0, 2, 1)], &ctx), Value::number(1.0));
        // Range C5:D10 → top-left row = 5.
        assert_eq!(row(&[range_ref(0, 4, 2, 9, 3)], &ctx), Value::number(5.0));
    }

    #[test]
    fn row_zero_arg_with_formula_cell_returns_formula_row() {
        let ctx = ctx_at(0, 6, 2);
        // Formula cell at row 6 (0-indexed) → ROW() = 7.
        assert_eq!(row(&[], &ctx), Value::number(7.0));
    }

    #[test]
    fn row_zero_arg_without_formula_cell_returns_ref() {
        // Test path: no formula cell wired → #REF!.
        let ctx = ctx_no_cell();
        assert_eq!(row(&[], &ctx), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn row_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            row(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            row(&[RefArg::Error(ErrorValue::Name)], &ctx),
            Value::Error(ErrorValue::Name)
        );
    }

    #[test]
    fn row_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            row(&[RefArg::Scalar(Value::number(5.0))], &ctx),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            row(&[RefArg::Scalar(Value::Text("hello".into()))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn row_of_array_literal_is_value_error() {
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(2, 2, vec![Value::number(1.0); 4]).unwrap();
        assert_eq!(
            row(&[RefArg::Array(av)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn row_of_arity_zero_with_extra_args_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            row(&[cell_ref(0, 0, 0), cell_ref(0, 0, 0)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- COLUMN -----

    #[test]
    fn column_of_cell_a1_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(column(&[cell_ref(0, 0, 0)], &ctx), Value::number(1.0));
    }

    #[test]
    fn column_of_cell_b5_returns_2() {
        // LibreOffice cross-check: COLUMN(B5) = 2.
        let ctx = ctx_no_cell();
        assert_eq!(column(&[cell_ref(0, 4, 1)], &ctx), Value::number(2.0));
    }

    #[test]
    fn column_of_range_returns_top_left_col() {
        let ctx = ctx_no_cell();
        // Range A1:B3 → top-left col = 1.
        assert_eq!(
            column(&[range_ref(0, 0, 0, 2, 1)], &ctx),
            Value::number(1.0)
        );
        // Range D2:F5 → top-left col = 4.
        assert_eq!(
            column(&[range_ref(0, 1, 3, 4, 5)], &ctx),
            Value::number(4.0)
        );
    }

    #[test]
    fn column_zero_arg_with_formula_cell_returns_formula_col() {
        let ctx = ctx_at(0, 6, 2);
        // Formula cell at col 2 (0-indexed) → COLUMN() = 3.
        assert_eq!(column(&[], &ctx), Value::number(3.0));
    }

    #[test]
    fn column_zero_arg_without_formula_cell_returns_ref() {
        let ctx = ctx_no_cell();
        assert_eq!(column(&[], &ctx), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn column_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            column(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn column_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            column(&[RefArg::Scalar(Value::number(7.0))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn column_of_array_literal_is_value_error() {
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(1, 3, vec![Value::number(1.0); 3]).unwrap();
        assert_eq!(
            column(&[RefArg::Array(av)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    // ----- ROWS -----

    #[test]
    fn rows_of_single_cell_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[cell_ref(0, 5, 5)], &ctx), Value::number(1.0));
    }

    #[test]
    fn rows_of_range_a1_a5_returns_5() {
        // LibreOffice cross-check: ROWS(A1:A5) = 5.
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[range_ref(0, 0, 0, 4, 0)], &ctx), Value::number(5.0));
    }

    #[test]
    fn rows_of_range_a1_b3_returns_3() {
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[range_ref(0, 0, 0, 2, 1)], &ctx), Value::number(3.0));
    }

    #[test]
    fn rows_of_whole_column_returns_max_row_plus_1() {
        // LibreOffice cross-check: ROWS(A:A) = 1048576 (MAX_ROW=1_048_575 + 1).
        let ctx = ctx_no_cell();
        let r = range_ref(0, 0, 0, ql_types::MAX_ROW, 0);
        assert_eq!(rows(&[r], &ctx), Value::number(1_048_576.0));
    }

    #[test]
    fn rows_of_array_literal_returns_first_dim() {
        // LibreOffice cross-check: ROWS({1,2,3;4,5,6}) = 2.
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(
            2,
            3,
            vec![
                Value::number(1.0),
                Value::number(2.0),
                Value::number(3.0),
                Value::number(4.0),
                Value::number(5.0),
                Value::number(6.0),
            ],
        )
        .unwrap();
        assert_eq!(rows(&[RefArg::Array(av)], &ctx), Value::number(2.0));
    }

    #[test]
    fn rows_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            rows(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn rows_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            rows(&[RefArg::Scalar(Value::number(0.0))], &ctx),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            rows(&[RefArg::Scalar(Value::Text("text".into()))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn rows_arity_errors() {
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[], &ctx), Value::Error(ErrorValue::NA));
        assert_eq!(
            rows(&[cell_ref(0, 0, 0), cell_ref(0, 0, 1)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- COLUMNS -----

    #[test]
    fn columns_of_single_cell_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(columns(&[cell_ref(0, 5, 5)], &ctx), Value::number(1.0));
    }

    #[test]
    fn columns_of_range_a1_e1_returns_5() {
        // LibreOffice cross-check: COLUMNS(A1:E1) = 5.
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[range_ref(0, 0, 0, 0, 4)], &ctx),
            Value::number(5.0)
        );
    }

    #[test]
    fn columns_of_range_a1_b3_returns_2() {
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[range_ref(0, 0, 0, 2, 1)], &ctx),
            Value::number(2.0)
        );
    }

    #[test]
    fn columns_of_whole_row_returns_max_column_plus_1() {
        // LibreOffice cross-check: COLUMNS(1:1) = 16384 (MAX_COLUMN=16_383 + 1).
        let ctx = ctx_no_cell();
        let r = range_ref(0, 0, 0, 0, ql_types::MAX_COLUMN);
        assert_eq!(columns(&[r], &ctx), Value::number(16_384.0));
    }

    #[test]
    fn columns_of_array_literal_returns_second_dim() {
        // LibreOffice cross-check: COLUMNS({1,2,3;4,5,6}) = 3.
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(
            2,
            3,
            vec![
                Value::number(1.0),
                Value::number(2.0),
                Value::number(3.0),
                Value::number(4.0),
                Value::number(5.0),
                Value::number(6.0),
            ],
        )
        .unwrap();
        assert_eq!(columns(&[RefArg::Array(av)], &ctx), Value::number(3.0));
    }

    #[test]
    fn columns_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[RefArg::Error(ErrorValue::Value)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn columns_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[RefArg::Scalar(Value::Boolean(true))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn columns_arity_errors() {
        let ctx = ctx_no_cell();
        assert_eq!(columns(&[], &ctx), Value::Error(ErrorValue::NA));
        assert_eq!(
            columns(&[range_ref(0, 0, 0, 2, 1), range_ref(0, 0, 0, 0, 0)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- Cross-cutting: dispatcher won't produce RefArg::Shape with Eager
    // contract, but defensive arms are pinned. -----

    #[test]
    fn row_with_shape_arg_returns_value_error() {
        let ctx = ctx_no_cell();
        // Dispatcher won't produce this with Eager contract, but pin the
        // defensive arm.
        assert_eq!(
            row(&[RefArg::Shape(PlanKind::CellRef)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn rows_with_shape_arg_returns_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            rows(&[RefArg::Shape(PlanKind::RangeRef)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }
}
