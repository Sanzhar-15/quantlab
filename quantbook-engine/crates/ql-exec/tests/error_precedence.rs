//! Phase 4.4.B — Error-precedence E2E tests (W5-65).
//!
//! Pins the §3.3 matrix from `docs/architecture/2026-05-13-coercion-matrix.md`.
//! Each test drives a formula through `WorkbookRuntime` and verifies the
//! resulting `Value` matches the documented precedence rule.
//!
//! Rules pinned:
//! - Left-argument-error wins (Excel's left-to-right arg evaluation).
//! - Binary operator: error on EITHER operand short-circuits before
//!   arithmetic/concat/comparison coercion (`scalar.rs::eval_binary`).
//! - `IFERROR(error, fallback)` returns `fallback` via post-eval
//!   introspection (NOT lazy 2nd-arg eval — that's FN4-03).
//! - `ISERROR`, `ISNA`, `ISERR` introspect; never propagate.
//! - Argument-error beats div-zero (`=A1/0` where A1 errored → A1's error).
//!
//! ## Test name convention
//!
//! - `precedence_*_canon_*` — Excel canon behavior.
//! - `precedence_*_w5_*_policy_*` — Behavior set by a specific W5-NN
//!   audit closure (e.g. W5-62 wildcard text-cell-only).

use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_oplog::OpLog;
use ql_storage::Workbook;
use ql_types::{ErrorValue, Value};

fn fresh_session() -> (Workbook, OpLog) {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    (wb, OpLog::new())
}

/// Helper: evaluate a formula at sheet/row/col and return the Value.
fn eval(rt: &mut WorkbookRuntime, sheet: u16, row: u32, col: u32, formula: &str) -> Value {
    rt.set_formula(sheet, row, col, formula).unwrap()
}

// ============================================================================
// §3.3 Row 1: =SUM(A1, B1) where A1=#REF!, B1=#NUM! → #REF! (first arg wins)
// ============================================================================

#[test]
fn precedence_sum_first_arg_error_wins_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    // Seed both A1 (col 0) and B1 (col 1) with distinct error values.
    rt.set_value(0, 0, 0, Value::Error(ErrorValue::Ref))
        .unwrap();
    rt.set_value(0, 0, 1, Value::Error(ErrorValue::Num))
        .unwrap();

    // =SUM(A1, B1) — both args are errors. Left wins.
    let v = eval(&mut rt, 0, 1, 0, "SUM(A1, B1)");
    assert_eq!(v, Value::Error(ErrorValue::Ref));
}

// ============================================================================
// §3.3 Row 2: ="x" + #REF! → #REF! (W5-63 Codex HIGH 1 fix)
// ============================================================================

#[test]
fn precedence_binary_op_error_propagates_before_coercion_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    // Seed B1 with #REF!.
    rt.set_value(0, 0, 1, Value::Error(ErrorValue::Ref))
        .unwrap();
    // Seed A1 with text "x".
    rt.set_value(0, 0, 0, Value::text("x")).unwrap();

    // =A1+B1 — A1="x", B1=#REF!. Pre-W5-63 the matrix was ambiguous;
    // current behavior (eval_binary at scalar.rs:240-247) propagates
    // the error on EITHER operand BEFORE coercion. So the text on the
    // left never reaches to_number_lenient; the #REF! wins.
    let v = eval(&mut rt, 0, 1, 0, "A1+B1");
    assert_eq!(v, Value::Error(ErrorValue::Ref));
}

// ============================================================================
// §3.3 Row 3: =#NUM! + #REF! → #NUM! (left-error)
// ============================================================================

#[test]
fn precedence_binary_op_left_error_wins_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Error(ErrorValue::Num))
        .unwrap();
    rt.set_value(0, 0, 1, Value::Error(ErrorValue::Ref))
        .unwrap();

    let v = eval(&mut rt, 0, 1, 0, "A1+B1");
    assert_eq!(v, Value::Error(ErrorValue::Num));
}

// ============================================================================
// §3.3 Row 4: =A1+B1 where A1=#DIV/0!, B1 valid → #DIV/0! propagates
// ============================================================================

#[test]
fn precedence_left_div_zero_error_propagates_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Error(ErrorValue::DivZero))
        .unwrap();
    rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();

    let v = eval(&mut rt, 0, 1, 0, "A1+B1");
    assert_eq!(v, Value::Error(ErrorValue::DivZero));
}

// ============================================================================
// §3.3 Row 5: =IF(#REF!, 1, 2) → #REF! (cond error short-circuits)
// ============================================================================

#[test]
fn precedence_if_cond_error_short_circuits_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Error(ErrorValue::Ref))
        .unwrap();

    let v = eval(&mut rt, 0, 1, 0, "IF(A1, 1, 2)");
    assert_eq!(v, Value::Error(ErrorValue::Ref));
}

// ============================================================================
// §3.3 Row 6: =IFERROR(#REF!, 0) → 0 (W5-63 Codex MEDIUM 2 clarification)
// ============================================================================

#[test]
fn precedence_iferror_catches_via_post_eval_introspection_canon() {
    // W5-63 Codex MEDIUM 2 clarified that this is the CURRENT behavior,
    // NOT aspirational. Args are pre-evaluated; iferror introspects
    // the Value::Error and returns the fallback. FN4-03 is about lazy
    // SECOND-arg eval (don't evaluate fallback if value is non-error),
    // not about this introspection case.
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Error(ErrorValue::Ref))
        .unwrap();

    let v = eval(&mut rt, 0, 1, 0, "IFERROR(A1, 0)");
    assert_eq!(v, Value::Number(0.0));
}

#[test]
fn precedence_iferror_passes_through_non_error_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Number(42.0)).unwrap();

    let v = eval(&mut rt, 0, 1, 0, "IFERROR(A1, 999)");
    assert_eq!(v, Value::Number(42.0));
}

// ============================================================================
// §3.3 Row 7: =ISERROR(#REF!) → TRUE (introspection, never propagates)
// ============================================================================

#[test]
fn precedence_iserror_introspects_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Error(ErrorValue::Ref))
        .unwrap();

    let v = eval(&mut rt, 0, 1, 0, "ISERROR(A1)");
    assert_eq!(v, Value::Boolean(true));
}

#[test]
fn precedence_iserror_non_error_is_false_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Number(42.0)).unwrap();

    let v = eval(&mut rt, 0, 1, 0, "ISERROR(A1)");
    assert_eq!(v, Value::Boolean(false));
}

#[test]
fn precedence_isna_distinguishes_na_from_other_errors_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    // A1=#N/A; B1=#REF!.
    rt.set_value(0, 0, 0, Value::Error(ErrorValue::NA)).unwrap();
    rt.set_value(0, 0, 1, Value::Error(ErrorValue::Ref))
        .unwrap();

    // ISNA distinguishes #N/A from other errors.
    let v_na = eval(&mut rt, 0, 1, 0, "ISNA(A1)");
    let v_ref = eval(&mut rt, 0, 2, 0, "ISNA(B1)");
    assert_eq!(v_na, Value::Boolean(true));
    assert_eq!(v_ref, Value::Boolean(false));
}

#[test]
fn precedence_iserr_excludes_na_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    // A1=#N/A; B1=#REF!.
    rt.set_value(0, 0, 0, Value::Error(ErrorValue::NA)).unwrap();
    rt.set_value(0, 0, 1, Value::Error(ErrorValue::Ref))
        .unwrap();

    let v_na = eval(&mut rt, 0, 1, 0, "ISERR(A1)");
    let v_ref = eval(&mut rt, 0, 2, 0, "ISERR(B1)");
    assert_eq!(v_na, Value::Boolean(false)); // #N/A excluded.
    assert_eq!(v_ref, Value::Boolean(true));
}

// ============================================================================
// §3.3 Row 8: =A1/0 where A1=#REF! → #REF! (arg-error beats div-zero)
// ============================================================================

#[test]
fn precedence_arg_error_beats_div_zero_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Error(ErrorValue::Ref))
        .unwrap();

    let v = eval(&mut rt, 0, 1, 0, "A1/0");
    assert_eq!(v, Value::Error(ErrorValue::Ref));
}

#[test]
fn precedence_actual_div_zero_when_no_arg_error_canon() {
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();

    let v = eval(&mut rt, 0, 1, 0, "A1/0");
    assert_eq!(v, Value::Error(ErrorValue::DivZero));
}

// ============================================================================
// Cross-cutting: error wins over text-coercion-failure
// ============================================================================

#[test]
fn precedence_error_wins_over_text_coercion_failure_canon() {
    // Pinned for W5-63 Codex HIGH 1: a Text value on one side and an
    // Error on the other should produce the Error, NOT the
    // #VALUE!-from-failed-text-coercion. eval_binary checks errors
    // first; the text never reaches coercion.
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    // A1=Text("abc"), B1=#NUM!.
    rt.set_value(0, 0, 0, Value::text("abc")).unwrap();
    rt.set_value(0, 0, 1, Value::Error(ErrorValue::Num))
        .unwrap();

    let v = eval(&mut rt, 0, 1, 0, "A1+B1");
    assert_eq!(v, Value::Error(ErrorValue::Num));
}

#[test]
fn precedence_lone_text_coercion_failure_is_value_error_canon() {
    // Control case: when there's NO error on either side, a text that
    // fails to coerce produces #VALUE! (not #REF!).
    let (mut wb, mut oplog) = fresh_session();
    let reg = default_registry();
    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

    rt.set_value(0, 0, 0, Value::text("abc")).unwrap();
    rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();

    let v = eval(&mut rt, 0, 1, 0, "A1+B1");
    assert_eq!(v, Value::Error(ErrorValue::Value));
}
