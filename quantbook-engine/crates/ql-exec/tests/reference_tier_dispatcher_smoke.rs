//! **W5-RT-1 / Step 1.1 (S1-MED-α closure):** integration test for the
//! reference-aware dispatcher chain.
//!
//! Step 1 ships the infrastructure (RefArg, ArgContract, RegisteredFn::
//! ReferenceAware, dispatcher arm, materializers, etc.) but registers no
//! user-facing reference-aware fns — those land in Steps 2/3/4. This
//! integration test wires a placeholder reference-aware fn into a scratch
//! `FunctionRegistry` and confirms the binder → dispatcher → materializer
//! → per-fn-call chain works end-to-end BEFORE the first real fn lands.
//!
//! Without this test, Step 2 would be the first time the dispatch path
//! runs; any wiring bug in `eval_scalar_with_cache`'s `RegisteredFn::
//! ReferenceAware` arm, in `materialize_ref_arg_eager` / `_lazy`, or in
//! `RefContext::new` argument ordering would only surface during Step 2
//! implementation. That undermines the audit-discipline rationale for
//! "audit Step 1 BEFORE any user-facing fn registers".
//!
//! Audit context: Codex S1-MEDIUM-2 + Opus S1-LOW-1 both flagged this gap.

use ql_exec::{eval_scalar_with_cache, MapEnv, NoAggregateCache};
use ql_formula_syntax::{lex, parse};
use ql_functions::{ArgContract, FunctionRegistry, PlanKind, RefArg, RefContext};
use ql_types::{ArrayValue, ErrorValue, Value};

// =====================================================================
// Eager-contract placeholder: inspects RefArg variant, returns a sentinel
// value distinguishable per shape. Used to verify the eager materializer
// produces the expected RefArg per input plan shape.
// =====================================================================

fn placeholder_eager(args: &[RefArg], _ctx: &RefContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::NA);
    }
    match &args[0] {
        // Sentinel values are arbitrary; the test asserts the specific
        // value to prove which variant was produced.
        RefArg::Reference { address, .. } => {
            // Encode (sheet=0,row=R,col=C) → 1000*R + C
            Value::number(f64::from(address.row) * 1000.0 + f64::from(address.col))
        }
        RefArg::Range { range, values } => {
            // Encode rows×100 + cols; verify values is empty (coordinate-only path).
            assert!(
                values.is_empty(),
                "v1 coordinate-only: values must be empty"
            );
            let rows = range.end_row - range.start_row + 1;
            let cols = range.end_col - range.start_col + 1;
            Value::number(f64::from(rows) * 100.0 + f64::from(cols))
        }
        RefArg::Array(av) => {
            // Encode array shape: -100*rows - cols (negative to distinguish from Range).
            Value::number(-(f64::from(av.rows()) * 100.0 + f64::from(av.cols())))
        }
        RefArg::Scalar(v) => match v {
            Value::Number(n) => Value::number(*n + 0.5), // +0.5 marker so we can detect
            other => other.clone(),
        },
        RefArg::Error(ev) => Value::Error(*ev),
        // Lazy materializer never produces this with Eager contract.
        RefArg::Shape(_) => unreachable!("Eager contract should not produce RefArg::Shape"),
    }
}

// =====================================================================
// Lazy-contract placeholder: returns a per-PlanKind sentinel. Used to
// verify the lazy materializer produces the expected PlanKind per input
// plan shape WITHOUT evaluating values.
// =====================================================================

fn placeholder_lazy(args: &[RefArg], _ctx: &RefContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::NA);
    }
    match &args[0] {
        RefArg::Shape(PlanKind::CellRef) => Value::number(1.0),
        RefArg::Shape(PlanKind::RangeRef) => Value::number(2.0),
        RefArg::Shape(PlanKind::Function { returns_reference }) => {
            if *returns_reference {
                Value::number(3.5)
            } else {
                Value::number(3.0)
            }
        }
        RefArg::Shape(PlanKind::Literal) => Value::number(4.0),
        RefArg::Shape(PlanKind::Error) => Value::number(5.0),
        _ => unreachable!("LazyShape contract should produce only RefArg::Shape"),
    }
}

fn registry_with_placeholders() -> FunctionRegistry {
    let mut reg = ql_functions::default_registry();
    reg.register_reference_aware("__RT_EAGER__", placeholder_eager, ArgContract::Eager);
    reg.register_reference_aware("__RT_LAZY__", placeholder_lazy, ArgContract::LazyShape);
    reg
}

fn bind_and_eval(src: &str, env: &MapEnv, reg: &FunctionRegistry) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let plan = ql_exec::bind(&ast, 0).expect("bind");
    eval_scalar_with_cache(&plan, env, reg, &NoAggregateCache)
}

// ---------------------------------------------------------------------
// Eager-contract dispatch
// ---------------------------------------------------------------------

#[test]
fn eager_dispatch_with_cellref_produces_reference_variant() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // CellRef A1 (sheet 0, row 0, col 0) → encoded as 0*1000 + 0 = 0.
    // CellRef B5 (sheet 0, row 4, col 1) → encoded as 4*1000 + 1 = 4001.
    assert_eq!(
        bind_and_eval("__RT_EAGER__(A1)", &env, &reg),
        Value::number(0.0)
    );
    assert_eq!(
        bind_and_eval("__RT_EAGER__(B5)", &env, &reg),
        Value::number(4001.0)
    );
}

// **Note:** literal `Expr::RangeRef` binding to `ExprPlan::RangeRef` only
// fires for fn names in `is_reference_aware_function` (ROW/COLUMN/ROWS/
// COLUMNS/ISREF/ISFORMULA/FORMULATEXT — the 7 real names). Test
// placeholders `__RT_EAGER__` / `__RT_LAZY__` are NOT in the matcher,
// so `__RT_EAGER__(A1:B3)` binds the inner `A1:B3` under
// `BindContext::Scalar` and rejects with `UnsupportedVariant`. The
// Range-arg materialization is exercised end-to-end by Step 2 tests
// using real fn names (ROWS / COLUMNS). This smoke test covers the
// remaining dispatcher paths (CellRef, Array literal, Scalar fallback,
// LazyShape variants, RefContext wiring) — those don't require the
// binder gate.

#[test]
fn eager_dispatch_with_array_literal_produces_array_variant() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // Array {1,2,3;4,5,6} → shape (2,3) → encoded -(2*100 + 3) = -203.
    assert_eq!(
        bind_and_eval("__RT_EAGER__({1,2,3;4,5,6})", &env, &reg),
        Value::number(-203.0)
    );
}

#[test]
fn eager_dispatch_with_arithmetic_arg_eager_evaluates_to_scalar() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // 1+2 → Value::number(3.0) → Scalar(3.0) → +0.5 marker → 3.5.
    assert_eq!(
        bind_and_eval("__RT_EAGER__(1+2)", &env, &reg),
        Value::number(3.5)
    );
}

#[test]
fn eager_dispatch_with_arity_zero_returns_na() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    assert_eq!(
        bind_and_eval("__RT_EAGER__()", &env, &reg),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn eager_dispatch_propagates_ref_context_workbook_default_is_noop_reference_query() {
    // RefContext is constructed from CellEnv::reference_query(). MapEnv inherits
    // the default `&NO_OP_REFERENCE_QUERY`. Verify the noop default reaches the
    // per-fn impl.
    fn assert_noop_workbook(args: &[RefArg], ctx: &RefContext) -> Value {
        assert!(!args.is_empty());
        // Calling is_formula_at on the noop singleton should always return false.
        if ctx.workbook.is_formula_at(0, 0, 0) {
            Value::Boolean(true)
        } else {
            Value::Boolean(false)
        }
    }
    let mut reg = ql_functions::default_registry();
    reg.register_reference_aware("__RT_CTX_PROBE__", assert_noop_workbook, ArgContract::Eager);
    let env = MapEnv::new();
    assert_eq!(
        bind_and_eval("__RT_CTX_PROBE__(A1)", &env, &reg),
        Value::Boolean(false)
    );
}

// ---------------------------------------------------------------------
// Lazy-contract dispatch (ISREF-style)
// ---------------------------------------------------------------------

#[test]
fn lazy_dispatch_with_cellref_produces_planshape_cellref() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // CellRef → PlanKind::CellRef → 1.0
    assert_eq!(
        bind_and_eval("__RT_LAZY__(A1)", &env, &reg),
        Value::number(1.0)
    );
}

// Note: lazy RangeRef test would require literal `A1:B3` to bind to
// `ExprPlan::RangeRef`, which only happens for fn names in
// `is_reference_aware_function`. Step 2 ISREF tests cover this path.

#[test]
fn lazy_dispatch_with_function_call_produces_planshape_function() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // Function (SUM with scalar literal args — avoids the SUM(A1:A3)
    // literal-RangeRef-binding rejection) → PlanKind::Function{false} → 3.0
    // The lazy materializer MUST NOT evaluate SUM (no value access). The
    // inner SUM never executes — the dispatcher's lazy materializer
    // produces PlanKind::Function before any eval happens.
    assert_eq!(
        bind_and_eval("__RT_LAZY__(SUM(1, 2, 3))", &env, &reg),
        Value::number(3.0)
    );
}

#[test]
fn lazy_dispatch_with_arithmetic_produces_planshape_literal() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // Binary 1+2 → PlanKind::Literal → 4.0. The lazy materializer must NOT
    // evaluate 1+2 to 3 first.
    assert_eq!(
        bind_and_eval("__RT_LAZY__(1+2)", &env, &reg),
        Value::number(4.0)
    );
}

#[test]
fn lazy_dispatch_with_number_literal_produces_planshape_literal() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    assert_eq!(
        bind_and_eval("__RT_LAZY__(42)", &env, &reg),
        Value::number(4.0)
    );
}

#[test]
fn lazy_dispatch_with_string_literal_produces_planshape_literal() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    assert_eq!(
        bind_and_eval("__RT_LAZY__(\"text\")", &env, &reg),
        Value::number(4.0)
    );
}

#[test]
fn lazy_dispatch_with_error_literal_produces_planshape_error() {
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // `#REF!` literal → ExprPlan::Error → PlanKind::Error → 5.0
    assert_eq!(
        bind_and_eval("__RT_LAZY__(#REF!)", &env, &reg),
        Value::number(5.0)
    );
}

#[test]
fn lazy_dispatch_does_not_evaluate_div_by_zero() {
    // The critical lazy-contract invariant per HIGH-B from the v2 pre-review:
    // `ISREF(1/0)` returns FALSE without surfacing `#DIV/0!`. Equivalent here
    // for our placeholder: `__RT_LAZY__(1/0)` returns the Literal sentinel
    // (4.0) — proving the dispatcher did NOT call `eval_scalar_with_cache(1/0)`.
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    assert_eq!(
        bind_and_eval("__RT_LAZY__(1/0)", &env, &reg),
        Value::number(4.0)
    );
}

// ---------------------------------------------------------------------
// Sanity: array materializer construction
// ---------------------------------------------------------------------

#[test]
fn ref_arg_array_shape_matches_array_literal_shape() {
    // 3x2 array literal.
    let _av = ArrayValue::new(
        3,
        2,
        vec![
            Value::number(1.0),
            Value::number(2.0),
            Value::number(3.0),
            Value::number(4.0),
            Value::number(5.0),
            Value::number(6.0),
        ],
    )
    .expect("3x2 valid");
    let env = MapEnv::new();
    let reg = registry_with_placeholders();
    // Encode -(3*100 + 2) = -302.
    assert_eq!(
        bind_and_eval("__RT_EAGER__({1,2;3,4;5,6})", &env, &reg),
        Value::number(-302.0)
    );
}
