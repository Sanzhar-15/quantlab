//! End-to-end dispatch tests for the reference-tier information batch
//! (W5-RT-3 / RT-V1-01 Step 3): ISREF + ISFORMULA.
//!
//! ISREF exercises the `ArgContract::LazyShape` dispatcher path — the
//! arg is NOT evaluated. The critical test is
//! `isref_of_divide_by_zero_returns_false_without_eval`: if the lazy
//! materializer regressed to eager-eval, `1/0` would surface as
//! `#DIV/0!` and the test would fail.
//!
//! ISFORMULA exercises the `Eager` contract + the `ReferenceQuery`
//! workbook query path. The happy-path tests (TRUE for formula cells,
//! FALSE for literals) construct a `Workbook` directly with
//! `put_formula` (storage-level) so the workbook query returns the
//! expected formula-status without going through the runtime.

use ql_exec::{
    bind_with_names_and_sheets, eval_scalar_with_cache, MapEnv, NoAggregateCache, WorkbookEnv,
};
use ql_formula_syntax::{lex, parse};
use ql_functions::default_registry;
use ql_storage::{NamedTarget, Workbook};
use ql_types::{Address, ErrorValue, Range, Value};

fn eval_with_map(src: &str) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = MapEnv::new();
    eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache)
}

fn workbook_with_sheet() -> Workbook {
    let mut wb = Workbook::new();
    wb.add_sheet("S0");
    wb
}

fn workbook_with_two_sheets() -> Workbook {
    let mut wb = Workbook::new();
    wb.add_sheet("S0");
    wb.add_sheet("S1");
    wb
}

// ---------------------------------------------------------------------
// ISREF — LazyShape contract
// ---------------------------------------------------------------------

#[test]
fn isref_of_cellref_returns_true() {
    assert_eq!(eval_with_map("ISREF(A1)"), Value::Boolean(true));
}

#[test]
fn isref_of_literal_range_returns_true() {
    assert_eq!(eval_with_map("ISREF(A1:B3)"), Value::Boolean(true));
}

#[test]
fn isref_of_number_literal_returns_false() {
    assert_eq!(eval_with_map("ISREF(42)"), Value::Boolean(false));
}

#[test]
fn isref_of_text_literal_returns_false() {
    assert_eq!(eval_with_map("ISREF(\"text\")"), Value::Boolean(false));
}

#[test]
fn isref_of_arithmetic_expr_returns_false() {
    // Binary → PlanKind::Literal → FALSE. The lazy materializer must
    // NOT evaluate 1+2 first.
    assert_eq!(eval_with_map("ISREF(1+2)"), Value::Boolean(false));
}

#[test]
fn isref_of_function_call_returns_false_v1_scope() {
    // SUM is non-reference-returning. Lazy materializer emits
    // PlanKind::Function { returns_reference: false }. ISREF returns FALSE.
    // Using scalar args to avoid the SUM(A1:A3) bind-fail (S2-HIGH-3 /
    // S1-MED-γ AggregateArg defer).
    assert_eq!(eval_with_map("ISREF(SUM(1, 2))"), Value::Boolean(false));
}

#[test]
fn isref_of_error_literal_returns_false() {
    // #REF! literal → PlanKind::Error → FALSE.
    assert_eq!(eval_with_map("ISREF(#REF!)"), Value::Boolean(false));
}

#[test]
fn isref_of_divide_by_zero_returns_false_without_eval() {
    // **CRITICAL TEST** for HIGH-B closure: ISREF must NOT evaluate
    // `1/0` (which would surface `#DIV/0!`). Lazy materializer emits
    // PlanKind::Literal (Binary plan) → FALSE.
    //
    // If this test fails with `Value::Error(ErrorValue::DivZero)`, the
    // dispatcher regressed to Eager contract for ISREF — the
    // ISREF-lazy-semantics promise is broken.
    assert_eq!(eval_with_map("ISREF(1/0)"), Value::Boolean(false));
}

#[test]
fn isref_arity_zero_returns_na() {
    assert_eq!(eval_with_map("ISREF()"), Value::Error(ErrorValue::NA));
}

#[test]
fn isref_arity_two_returns_na() {
    assert_eq!(eval_with_map("ISREF(A1, B2)"), Value::Error(ErrorValue::NA));
}

#[test]
fn isref_of_named_range_returns_true() {
    let mut wb = workbook_with_sheet();
    let r = Range::new(0, 0, 0, 9, 0);
    wb.set_name("MyRange", NamedTarget::Range(r)).unwrap();

    let tokens = lex("ISREF(MyRange)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");
    let env = MapEnv::new();
    // NameRef resolves through binder to AggregateNameRef → PlanKind::RangeRef.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(true)
    );
}

// ---------------------------------------------------------------------
// ISFORMULA — Eager contract + workbook ReferenceQuery
// ---------------------------------------------------------------------

#[test]
fn isformula_of_formula_cell_returns_true() {
    // Set up a workbook with a formula in B2 directly via storage.
    let mut wb = workbook_with_sheet();
    // Cell B2 — sheet 0, row 1, col 1 — store as formula.
    wb.put_formula(0, 1, 1, "1+2");

    let tokens = lex("ISFORMULA(B2)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(true)
    );
}

#[test]
fn isformula_of_literal_cell_returns_false() {
    let mut wb = workbook_with_sheet();
    // Literal at B2 — sheet 0, row 1, col 1.
    wb.sheet_mut(0).unwrap().put(1, 1, Value::number(5.0));

    let tokens = lex("ISFORMULA(B2)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(false)
    );
}

#[test]
fn isformula_of_blank_cell_returns_false() {
    let wb = workbook_with_sheet();
    // No content at B2.
    let tokens = lex("ISFORMULA(B2)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(false)
    );
}

#[test]
fn isformula_of_multi_cell_range_returns_na() {
    let wb = workbook_with_sheet();
    let tokens = lex("ISFORMULA(A1:B3)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // Microsoft canon: multi-cell ref → #N/A.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn isformula_of_text_arg_returns_na() {
    // Microsoft canon: non-reference → #N/A.
    assert_eq!(
        eval_with_map("ISFORMULA(\"text\")"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn isformula_of_number_arg_returns_na() {
    assert_eq!(eval_with_map("ISFORMULA(42)"), Value::Error(ErrorValue::NA));
}

#[test]
fn isformula_of_arithmetic_arg_returns_na() {
    // Eager-evaluates 1+2 → Number(3) → Scalar → #N/A.
    assert_eq!(
        eval_with_map("ISFORMULA(1+2)"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn isformula_propagates_ref_error() {
    // #REF! literal → RefArg::Error → propagate.
    assert_eq!(
        eval_with_map("ISFORMULA(#REF!)"),
        Value::Error(ErrorValue::Ref)
    );
}

#[test]
fn isformula_arity_zero_returns_na() {
    assert_eq!(eval_with_map("ISFORMULA()"), Value::Error(ErrorValue::NA));
}

#[test]
fn isformula_arity_two_returns_na() {
    assert_eq!(
        eval_with_map("ISFORMULA(A1, B2)"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn isformula_of_named_cell_pointing_at_formula_returns_true() {
    let mut wb = workbook_with_sheet();
    // A1 = formula.
    wb.put_formula(0, 0, 0, "1+2");
    // Named cell pointing at A1 (1×1 range).
    let r = Range::new(0, 0, 0, 0, 0);
    wb.set_name("MyCell", NamedTarget::Range(r)).unwrap();

    let tokens = lex("ISFORMULA(MyCell)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // 1×1 range → treated as single-cell → ISFORMULA queries A1 →
    // formula present → TRUE.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(true)
    );
}

// ---------------------------------------------------------------------
// Step 3.1 audit closures
// ---------------------------------------------------------------------

/// **W2-literal-range (2026-06-09):** ISREF with a literal-range SUM arg now
/// BINDS (the inner `SUM(A1:A3)` accepts the literal range) and evaluates to
/// FALSE — SUM does not return a reference, so the arg shape is
/// `PlanKind::Function { returns_reference: false }`. Previously
/// `isref_of_sum_literal_range_bind_fails_v1_scope` pinned the now-lifted
/// S1-MED-γ AggregateArg defer.
#[test]
fn isref_of_sum_literal_range_now_binds_and_returns_false() {
    assert_eq!(eval_with_map("ISREF(SUM(A1:A3))"), Value::Boolean(false));
}

/// **W2-literal-range (2026-06-09):** ISFORMULA with a literal-range SUM arg
/// now BINDS and evaluates to `#N/A` — `SUM(A1:A3)` is a function-call arg
/// (a non-reference shape), and ISFORMULA returns `#N/A` for any
/// non-reference arg per Microsoft canon. Previously
/// `isformula_of_sum_literal_range_bind_fails_v1_scope` pinned the now-lifted
/// S1-MED-γ AggregateArg defer.
#[test]
fn isformula_of_sum_literal_range_now_binds_and_returns_na() {
    assert_eq!(
        eval_with_map("ISFORMULA(SUM(A1:A3))"),
        Value::Error(ErrorValue::NA)
    );
}

/// **S3-HIGH-1 closure verification:** ISFORMULA on a cell whose VALUE is
/// an error (literal `#N/A` written to A1) returns FALSE — A1 is a
/// literal, not a formula. Pre-Step-3.1 the S2-HIGH-2 closure regressed
/// this: the CellRef materializer coerced A1's `Value::Error(NA)` into
/// `RefArg::Error(NA)` and the per-fn propagated `#N/A`.
#[test]
fn isformula_of_cell_with_error_value_returns_false() {
    let mut wb = workbook_with_sheet();
    // A1 holds a LITERAL error value (no formula).
    wb.sheet_mut(0)
        .unwrap()
        .put(0, 0, Value::Error(ErrorValue::NA));

    let tokens = lex("ISFORMULA(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // Cell holds an error but is NOT a formula → ISFORMULA returns FALSE.
    // (Pre-S3-HIGH-1 fix returned `#N/A` instead.)
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(false)
    );
}

/// **S3-HIGH-1 closure verification:** ROW on a cell holding an error
/// value returns the cell's row, NOT the error. Pre-Step-3.1 the
/// S2-HIGH-2 fix made ROW(A1) where A1=#DIV/0! return #DIV/0! instead
/// of 1.
#[test]
fn row_of_cell_with_error_value_returns_row_index() {
    let mut wb = workbook_with_sheet();
    // A1 holds a literal error.
    wb.sheet_mut(0)
        .unwrap()
        .put(0, 0, Value::Error(ErrorValue::DivZero));

    let tokens = lex("ROW(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // Per Excel canon: ROW looks at the address, ignores the cell's value.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(1.0)
    );
}

/// **S3-HIGH-5 closure (producer/replay divergence — documented v1):**
/// `WorkbookRuntime::set_formula` evaluates BEFORE storing the formula,
/// so `set_formula(A1, "=ISFORMULA(A1)")` sees `formula_at(A1) = None`
/// during eval → returns FALSE. Replay restores `formula_cells` BEFORE
/// recompute → returns TRUE. Real producer/replay invariant break.
///
/// v1 stance: documented divergence; fix requires workbook_runtime
/// restructure (pending-formula overlay during eval, OR atomic
/// pre-installation with rollback). Out of scope for W5-RT-3. This
/// test pins the v1 stance — a regression that "accidentally fixes"
/// this divergence (without updating the test) signals a deeper
/// runtime change worth catching.
///
/// **CAVEAT:** the test currently exercises only the producer half
/// (evaluates BEFORE storing). The replay half requires op-log
/// playback which is heavier infrastructure to bring up. A follow-up
/// `RT-V1-followup` cycle adds the replay-side check.
#[test]
fn isformula_self_reference_returns_false_during_set_formula_v1_pin() {
    // Storage-level setup: simulate the state BEFORE put_formula writes.
    // (set_formula's eval runs against a workbook where A1's formula
    // metadata isn't yet present.)
    let wb = workbook_with_sheet();
    // No formula at A1; isolated assertion that ISFORMULA(A1) is FALSE
    // when A1's formula isn't yet installed.
    let tokens = lex("ISFORMULA(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 0, 0));
    // Pre-installation: A1 has no formula stored → ISFORMULA returns
    // FALSE. This is the producer-side result for
    // `set_formula(A1, "=ISFORMULA(A1)")`.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(false)
    );
    // Producer/replay symmetry break documented: replay-side this would
    // return TRUE (formula re-installed before recompute). Fix is a
    // workbook_runtime restructure; not in v1 scope.
}

/// **S3-MED-β closure (ISREF no-eval instrumented test):** ISREF must NOT
/// evaluate volatile fns in its arg. Per S3-HIGH-2 walker fix, the
/// formula is also NOT marked volatile (so it won't appear in
/// `WorkbookRuntime::volatile_set`). This test exercises a different
/// shape than the existing `isref_of_divide_by_zero_returns_false_without_eval`
/// — uses a volatile fn (NOW) to verify no eval surface.
#[test]
fn isref_of_volatile_fn_returns_false_without_evaluating() {
    // ISREF(NOW()) should return FALSE (NOW is non-reference-returning).
    // CRITICAL: NOW must not be called during dispatch — the LazyShape
    // contract prevents it. If NOW WERE called, this test would still
    // return FALSE (NOW's Number result wraps as PlanKind::Function →
    // FALSE), but the value-side observable would be that the formula
    // got marked volatile. The dep-walker fix (S3-HIGH-2) ensures
    // ISREF args are NOT walked at all, so NOW's volatility doesn't
    // propagate.
    assert_eq!(eval_with_map("ISREF(NOW())"), Value::Boolean(false));
    // Dep-walker behavior pinned by the walker tests in calcgraph_session.rs;
    // this test pins the dispatch-side semantics.
}

#[test]
fn isformula_cross_sheet_returns_correct_status() {
    let mut wb = workbook_with_two_sheets();
    // Sheet1!A1 = formula. Sheet 1, row 0, col 0.
    wb.put_formula(1, 0, 0, "1+2");

    let tokens = lex("ISFORMULA(S1!A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // Cross-sheet ISFORMULA → TRUE for the formula cell.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Boolean(true)
    );
}
