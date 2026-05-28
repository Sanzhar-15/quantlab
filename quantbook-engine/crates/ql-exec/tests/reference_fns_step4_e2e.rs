//! End-to-end dispatch tests for the reference-tier text batch
//! (W5-RT-4 / RT-V1-01 Step 4 — CLOSES the mini-phase): FORMULATEXT.
//!
//! FORMULATEXT uses `ArgContract::Eager` + queries the workbook via
//! `ReferenceQuery::formula_text_at`, which prepends `=` to the
//! canonical stored formula text. The happy-path tests (real formula
//! string returned) require a `Workbook` with `formula_cells` populated
//! via storage-level `Workbook::put_formula`.
//!
//! Key tests:
//! - Happy path: cell with formula → text with leading `=`.
//! - Cross-sheet: `FORMULATEXT(S1!A1)` → formula text from sheet 1.
//! - Leading-`=` verification: the returned text always starts with `=`.
//! - Multi-cell `#N/A` (Microsoft canon vs IronCalc `#ERROR!`).
//! - Error propagation, arity, non-reference args.

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
// FORMULATEXT happy paths
// ---------------------------------------------------------------------

#[test]
fn formulatext_of_formula_cell_returns_text_with_leading_eq() {
    let mut wb = workbook_with_sheet();
    // A1 = `1+2` (stored as canonical text without `=`).
    wb.put_formula(0, 0, 0, "1+2");

    let tokens = lex("FORMULATEXT(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    let result = eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache);

    // Excel canon: FORMULATEXT returns the formula WITH leading `=`.
    match result {
        Value::Text(text) => {
            assert!(
                text.starts_with('='),
                "FORMULATEXT must prepend `=` to canonical text; got {text:?}"
            );
            assert_eq!(text.as_ref(), "=1+2");
        }
        other => panic!("expected Text, got {other:?}"),
    }
}

#[test]
fn formulatext_of_complex_formula_returns_canonical_text() {
    let mut wb = workbook_with_sheet();
    wb.put_formula(0, 1, 1, "SUM(B1:B3)+1");

    let tokens = lex("FORMULATEXT(B2)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    let result = eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache);
    match result {
        Value::Text(text) => {
            assert!(text.starts_with('='));
            // Stored text is whatever put_formula was given (no
            // canonicalization at the storage level — that happens at
            // WorkbookRuntime::set_formula). For this test, the stored
            // text == input text + leading `=`.
            assert_eq!(text.as_ref(), "=SUM(B1:B3)+1");
        }
        other => panic!("expected Text, got {other:?}"),
    }
}

#[test]
fn formulatext_of_literal_cell_returns_na() {
    let mut wb = workbook_with_sheet();
    // Literal at A1 (no formula).
    wb.sheet_mut(0).unwrap().put(0, 0, Value::number(5.0));

    let tokens = lex("FORMULATEXT(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn formulatext_of_blank_cell_returns_na() {
    let wb = workbook_with_sheet();
    let tokens = lex("FORMULATEXT(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn formulatext_of_1x1_range_pointing_at_formula_returns_text() {
    let mut wb = workbook_with_sheet();
    wb.put_formula(0, 0, 0, "1+2");

    // FORMULATEXT(A1:A1) — 1×1 range → treated as single-cell.
    let tokens = lex("FORMULATEXT(A1:A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    let result = eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache);
    match result {
        Value::Text(text) => assert_eq!(text.as_ref(), "=1+2"),
        other => panic!("expected Text(\"=1+2\"), got {other:?}"),
    }
}

#[test]
fn formulatext_of_multi_cell_range_returns_na() {
    let wb = workbook_with_sheet();
    let tokens = lex("FORMULATEXT(A1:B3)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // Microsoft canon: multi-cell ref → #N/A (vs IronCalc's #ERROR!).
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::NA)
    );
}

// ---------------------------------------------------------------------
// Error / non-reference / arity
// ---------------------------------------------------------------------

#[test]
fn formulatext_of_text_arg_returns_na() {
    // Microsoft canon: non-reference → #N/A.
    assert_eq!(
        eval_with_map("FORMULATEXT(\"text\")"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn formulatext_of_number_arg_returns_na() {
    assert_eq!(
        eval_with_map("FORMULATEXT(42)"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn formulatext_of_arithmetic_arg_returns_na() {
    // Eager-evaluates 1+2 → Number(3) → Scalar → #N/A.
    assert_eq!(
        eval_with_map("FORMULATEXT(1+2)"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn formulatext_propagates_ref_error() {
    assert_eq!(
        eval_with_map("FORMULATEXT(#REF!)"),
        Value::Error(ErrorValue::Ref)
    );
}

#[test]
fn formulatext_of_cell_with_error_value_returns_na_not_propagated_error() {
    // S3-HIGH-1 verification (same pattern as ISFORMULA): cell holds a
    // literal `#N/A` (value-error, NOT a formula). FORMULATEXT must
    // return `#N/A` because no formula is stored — NOT propagate the
    // cell's error.
    let mut wb = workbook_with_sheet();
    wb.sheet_mut(0)
        .unwrap()
        .put(0, 0, Value::Error(ErrorValue::DivZero));

    let tokens = lex("FORMULATEXT(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    // No formula at A1 → #N/A (NOT #DIV/0! from A1's value).
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn formulatext_arity_zero_returns_na() {
    assert_eq!(eval_with_map("FORMULATEXT()"), Value::Error(ErrorValue::NA));
}

#[test]
fn formulatext_arity_two_returns_na() {
    assert_eq!(
        eval_with_map("FORMULATEXT(A1, B2)"),
        Value::Error(ErrorValue::NA)
    );
}

// ---------------------------------------------------------------------
// Cross-sheet + named-range paths
// ---------------------------------------------------------------------

#[test]
fn formulatext_cross_sheet_returns_text() {
    let mut wb = workbook_with_two_sheets();
    // Sheet1!B5 = `=A1*2`.
    wb.put_formula(1, 4, 1, "A1*2");

    let tokens = lex("FORMULATEXT(S1!B5)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    match eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache) {
        Value::Text(text) => assert_eq!(text.as_ref(), "=A1*2"),
        other => panic!("expected Text(\"=A1*2\"), got {other:?}"),
    }
}

#[test]
fn formulatext_of_named_cell_pointing_at_formula_returns_text() {
    let mut wb = workbook_with_sheet();
    wb.put_formula(0, 0, 0, "1+2");
    let r = Range::new(0, 0, 0, 0, 0);
    wb.set_name("MyCell", NamedTarget::Range(r)).unwrap();

    let tokens = lex("FORMULATEXT(MyCell)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 4, 4));
    match eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache) {
        Value::Text(text) => assert_eq!(text.as_ref(), "=1+2"),
        other => panic!("expected Text(\"=1+2\"), got {other:?}"),
    }
}

#[test]
fn formulatext_of_sum_literal_range_bind_fails_v1_scope() {
    // S2-HIGH-3 propagation: literal-range nested SUM bind-fails per
    // S1-MED-γ AggregateArg defer.
    let tokens = lex("FORMULATEXT(SUM(A1:A3))").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let result = ql_exec::bind(&ast, 0, &reg);
    assert!(
        result.is_err(),
        "v1 scope: FORMULATEXT(SUM(A1:A3)) bind-fails per S1-MED-γ \
         AggregateArg defer; got Ok({result:?})"
    );
}

/// **S4-HIGH-2 closure (parallel to S3-HIGH-5 for ISFORMULA):**
/// `=FORMULATEXT(A1)` typed at A1 has the same producer/replay
/// divergence pattern as `=ISFORMULA(A1)`. `WorkbookRuntime::set_formula`
/// evaluates BEFORE installing formula text → `formula_text_at(A1) =
/// None` → FORMULATEXT returns `#N/A` (producer-side). Op-log replay
/// restores formula text BEFORE recompute → FORMULATEXT returns
/// `"=FORMULATEXT(A1)"` (replay-side). Real producer/replay invariant
/// break; fix requires workbook_runtime restructure (pending-formula
/// overlay OR atomic pre-install with rollback) — out of W5-RT-4
/// scope. v1 stance documented; pin the producer-side behavior.
#[test]
fn formulatext_self_reference_returns_na_during_set_formula_v1_pin() {
    // Storage state mirroring the moment INSIDE set_formula: A1's
    // formula text is not yet installed.
    let wb = workbook_with_sheet();
    let tokens = lex("FORMULATEXT(A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
        let reg = default_registry();
let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 0, 0));
    // Pre-installation: A1 has no formula → FORMULATEXT returns #N/A.
    // This is the producer-side result for set_formula(A1, "=FORMULATEXT(A1)").
    // Replay-side would return Text("=FORMULATEXT(A1)") since op-log
    // installs formula_cells before recompute.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::NA)
    );
}
