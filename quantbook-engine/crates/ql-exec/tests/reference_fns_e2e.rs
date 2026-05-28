//! End-to-end dispatch tests for the reference-tier address-only batch
//! (W5-RT-2 / RT-V1-01 Step 2): ROW / COLUMN / ROWS / COLUMNS.
//!
//! These tests exercise the full binder → dispatcher → materializer →
//! per-fn-call chain for the 4 newly-registered fns. The `reference_fns`
//! unit tests cover the per-fn logic directly with RefArg structs; the
//! `reference_tier_dispatcher_smoke` tests cover the dispatcher chain
//! with placeholder fns. This file is the integration that ties the
//! real fn names + real source-text formulas + the real registry +
//! the real WorkbookEnv.

use ql_exec::{
    eval_at_cell_boundary, eval_scalar_with_cache, EvalResult, MapEnv, NoAggregateCache,
};
use ql_formula_syntax::{lex, parse};
use ql_functions::default_registry;
use ql_types::{ErrorValue, Value};

fn eval_with_map(src: &str) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = MapEnv::new();
    eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache)
}

// ---------------------------------------------------------------------
// ROW
// ---------------------------------------------------------------------

#[test]
fn row_of_a1_through_dispatcher_returns_1() {
    assert_eq!(eval_with_map("ROW(A1)"), Value::number(1.0));
}

#[test]
fn row_of_b5_through_dispatcher_returns_5() {
    // LibreOffice cross-check.
    assert_eq!(eval_with_map("ROW(B5)"), Value::number(5.0));
}

#[test]
fn row_of_literal_range_returns_top_left_row() {
    // ROW(A1:B3) in scalar context = top-left row = 1.
    assert_eq!(eval_with_map("ROW(A1:B3)"), Value::number(1.0));
    // ROW(C7:D10) = 7.
    assert_eq!(eval_with_map("ROW(C7:D10)"), Value::number(7.0));
}

#[test]
fn row_with_text_arg_returns_value_error() {
    assert_eq!(
        eval_with_map("ROW(\"text\")"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn row_with_arithmetic_arg_returns_value_error() {
    // 1+2 evaluates eagerly to Number(3) → Scalar → #VALUE!.
    assert_eq!(eval_with_map("ROW(1+2)"), Value::Error(ErrorValue::Value));
}

#[test]
fn row_with_error_arg_propagates() {
    // ROW(#REF!) → #REF!.
    assert_eq!(eval_with_map("ROW(#REF!)"), Value::Error(ErrorValue::Ref));
}

#[test]
fn row_with_too_many_args_returns_na() {
    assert_eq!(eval_with_map("ROW(A1, B2)"), Value::Error(ErrorValue::NA));
}

#[test]
fn row_with_zero_args_in_scalar_context_returns_ref() {
    // No formula cell wired → #REF!.
    assert_eq!(eval_with_map("ROW()"), Value::Error(ErrorValue::Ref));
}

// ---------------------------------------------------------------------
// COLUMN
// ---------------------------------------------------------------------

#[test]
fn column_of_a1_returns_1() {
    assert_eq!(eval_with_map("COLUMN(A1)"), Value::number(1.0));
}

#[test]
fn column_of_b5_returns_2() {
    // LibreOffice cross-check.
    assert_eq!(eval_with_map("COLUMN(B5)"), Value::number(2.0));
}

#[test]
fn column_of_e10_returns_5() {
    assert_eq!(eval_with_map("COLUMN(E10)"), Value::number(5.0));
}

#[test]
fn column_of_literal_range_returns_top_left_col() {
    assert_eq!(eval_with_map("COLUMN(D2:G5)"), Value::number(4.0));
}

#[test]
fn column_with_arithmetic_arg_returns_value_error() {
    assert_eq!(
        eval_with_map("COLUMN(2*3)"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn column_with_error_arg_propagates() {
    assert_eq!(
        eval_with_map("COLUMN(#DIV/0!)"),
        Value::Error(ErrorValue::DivZero)
    );
}

// ---------------------------------------------------------------------
// ROWS
// ---------------------------------------------------------------------

#[test]
fn rows_of_a1_a5_returns_5() {
    // LibreOffice cross-check.
    assert_eq!(eval_with_map("ROWS(A1:A5)"), Value::number(5.0));
}

#[test]
fn rows_of_a1_b3_returns_3() {
    assert_eq!(eval_with_map("ROWS(A1:B3)"), Value::number(3.0));
}

#[test]
fn rows_of_single_cell_returns_1() {
    assert_eq!(eval_with_map("ROWS(C5)"), Value::number(1.0));
}

#[test]
fn rows_of_whole_column_returns_1048576() {
    // LibreOffice cross-check: ROWS(A:A) = 1_048_576.
    assert_eq!(eval_with_map("ROWS(A:A)"), Value::number(1_048_576.0));
}

#[test]
fn rows_of_array_literal_returns_first_dim() {
    // LibreOffice cross-check: ROWS({1,2,3;4,5,6}) = 2.
    assert_eq!(eval_with_map("ROWS({1,2,3;4,5,6})"), Value::number(2.0));
}

#[test]
fn rows_with_text_arg_returns_value_error() {
    assert_eq!(
        eval_with_map("ROWS(\"text\")"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn rows_with_no_args_returns_na() {
    assert_eq!(eval_with_map("ROWS()"), Value::Error(ErrorValue::NA));
}

#[test]
fn rows_with_error_arg_propagates() {
    assert_eq!(eval_with_map("ROWS(#REF!)"), Value::Error(ErrorValue::Ref));
}

// ---------------------------------------------------------------------
// COLUMNS
// ---------------------------------------------------------------------

#[test]
fn columns_of_a1_e1_returns_5() {
    // LibreOffice cross-check.
    assert_eq!(eval_with_map("COLUMNS(A1:E1)"), Value::number(5.0));
}

#[test]
fn columns_of_single_cell_returns_1() {
    assert_eq!(eval_with_map("COLUMNS(C5)"), Value::number(1.0));
}

#[test]
fn columns_of_whole_row_returns_16384() {
    // LibreOffice cross-check: COLUMNS(1:1) = 16_384.
    assert_eq!(eval_with_map("COLUMNS(1:1)"), Value::number(16_384.0));
}

#[test]
fn columns_of_array_literal_returns_second_dim() {
    // LibreOffice cross-check: COLUMNS({1,2,3;4,5,6}) = 3.
    assert_eq!(eval_with_map("COLUMNS({1,2,3;4,5,6})"), Value::number(3.0));
}

#[test]
fn columns_of_a1_b3_returns_2() {
    assert_eq!(eval_with_map("COLUMNS(A1:B3)"), Value::number(2.0));
}

#[test]
fn columns_with_no_args_returns_na() {
    assert_eq!(eval_with_map("COLUMNS()"), Value::Error(ErrorValue::NA));
}

// ---------------------------------------------------------------------
// Cell-boundary multi-cell #CALC! guard (S1-HIGH-B Step 1.1 closure)
// ---------------------------------------------------------------------

#[test]
fn row_of_multi_cell_range_at_cell_boundary_returns_calc_error() {
    // S1-HIGH-B: at the cell boundary (top-level), ROW(A1:B3) returns
    // #CALC! instead of silently top-left-truncating. The guard fires
    // BEFORE the per-fn impl runs.
    let tokens = lex("ROW(A1:B3)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = MapEnv::new();
    match eval_at_cell_boundary(&plan, &env, &reg, &NoAggregateCache) {
        EvalResult::Scalar(Value::Error(ErrorValue::Calc)) => {}
        other => panic!("expected #CALC! at cell boundary, got {other:?}"),
    }
}

#[test]
fn row_of_single_cell_range_at_cell_boundary_returns_top_left() {
    // Single-cell range A5:A5 → not multi-cell → guard doesn't fire →
    // per-fn returns top-left = 5.
    let tokens = lex("ROW(A5:A5)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = MapEnv::new();
    match eval_at_cell_boundary(&plan, &env, &reg, &NoAggregateCache) {
        EvalResult::Scalar(v) => assert_eq!(v, Value::number(5.0)),
        other => panic!("expected Scalar(5), got {other:?}"),
    }
}

#[test]
fn column_of_multi_cell_range_at_cell_boundary_returns_calc_error() {
    let tokens = lex("COLUMN(A1:C1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = MapEnv::new();
    match eval_at_cell_boundary(&plan, &env, &reg, &NoAggregateCache) {
        EvalResult::Scalar(Value::Error(ErrorValue::Calc)) => {}
        other => panic!("expected #CALC!, got {other:?}"),
    }
}

#[test]
fn row_in_scalar_context_with_range_returns_top_left() {
    // ROW(A1:A5)+0 — the +0 keeps it in scalar context (not cell boundary).
    // Excel pre-365 implicit-intersection semantics: top-left = 1; 1+0 = 1.
    assert_eq!(eval_with_map("ROW(A1:A5)+0"), Value::number(1.0));
}
