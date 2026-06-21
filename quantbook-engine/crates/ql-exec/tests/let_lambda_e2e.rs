//! **Wave P (2026-06-20) — LET / LAMBDA acceptance suite.**
//!
//! Ports the formualizer reference-donor parity fixtures
//! (`.references/formualizer/.../builtins/lambda.rs` + `engine/tests/let_lambda.rs`)
//! through the real quantbook `lex → parse → bind → eval` chain, plus
//! quantbook-specific cases (column-shaped local names, etc.). These ARE the
//! master-plan week-14 LAMBDA-core acceptance gate (CORR-16).
//!
//! Harness note: the simple `bind().expect()` path is used for fixtures whose
//! result is a Value (including `ExprPlan::Error` → an Excel error value). The
//! use-before-bind `#NAME?` fixture and the workbook-name-shadow fixture need
//! the production recompute path (which maps a `BindError` to `#NAME?`); those
//! live in `let_lambda_recalc_contract.rs`.

use ql_exec::{eval_scalar_with_cache, MapEnv, NoAggregateCache};
use ql_formula_syntax::{lex, parse};
use ql_functions::default_registry;
use ql_types::{ErrorValue, Value};

/// Evaluate a formula (no leading `=`) against an empty grid.
fn eval(src: &str) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = ql_exec::bind(&ast, 0, &reg).expect("bind");
    let env = MapEnv::new();
    eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache)
}

fn num(n: f64) -> Value {
    Value::number(n)
}

// ---------------------------------------------------------------------
// LET — scalar (donor parity)
// ---------------------------------------------------------------------

#[test]
fn let_binds_values() {
    // donor: let_binds_values
    assert_eq!(eval("LET(x,2,x+3)"), num(5.0));
}

#[test]
fn let_nested_shadowing() {
    // donor: let_nested_shadowing — inner LET's x=5 is local; outer x=2.
    assert_eq!(eval("LET(x,2,LET(x,5,x)+x)"), num(7.0));
}

#[test]
fn let_multi_pair_left_to_right() {
    // donor docstring: LET(rate,0.08,price,125,price*(1+rate)) -> 135
    assert_eq!(eval("LET(rate,0.08,price,125,price*(1+rate))"), num(135.0));
}

#[test]
fn let_later_value_sees_earlier_binding() {
    // Left-to-right: `b` is defined using `a`.
    assert_eq!(eval("LET(a,10,b,a*2,a+b)"), num(30.0));
}

#[test]
fn let_names_are_case_insensitive() {
    // donor: let_and_lambda_names_are_case_insensitive (LET half).
    assert_eq!(eval("LET(x,1,X+1)"), num(2.0));
    assert_eq!(eval("LET(X,1,x+1)"), num(2.0));
}

#[test]
fn let_column_shaped_local_name() {
    // quantbook-specific: `dx` lexes as a BareColumn token, but in value
    // position the parser lowers it to `Expr::NameRef`, so it is a valid local
    // name and shadows nothing problematic. (A bare column is only a reference
    // in the colon form `DX:DX`.)
    assert_eq!(eval("LET(dx,2,dx+3)"), num(5.0));
    // single-letter column-shaped name.
    assert_eq!(eval("LET(c,7,c*2)"), num(14.0));
}

#[test]
fn let_body_reads_a_cell_via_function() {
    // A LET whose binding value is a scalar-returning function.
    // (No grid cells needed: SUM of a literal.)
    assert_eq!(eval("LET(t,SUM(1,2,3),t*2)"), num(12.0));
}

#[test]
fn let_rejects_non_identifier_name() {
    // donor: let_rejects_non_identifier_name — `A1` is a cell ref, not a name.
    assert_eq!(eval("LET(A1,2,A1)"), Value::Error(ErrorValue::Value));
}

#[test]
fn let_malformed_arity_even_arg_count_is_value_error() {
    // Even arg count (no final body) -> #VALUE!.
    assert_eq!(eval("LET(x,2)"), Value::Error(ErrorValue::Value));
}

#[test]
fn let_too_few_args_is_value_error() {
    // < 3 args -> #VALUE!.
    assert_eq!(eval("LET(x)"), Value::Error(ErrorValue::Value));
}

#[test]
fn let_redeclaration_shadows_at_same_level() {
    // LET permits re-declaration; the later binding shadows the earlier
    // (LAMBDA params, by contrast, must be unique). `x` is rebound 1 -> 2.
    assert_eq!(eval("LET(x,1,x,2,x)"), num(2.0));
}

// ---------------------------------------------------------------------
// LAMBDA — closures + invocation (donor parity)
// ---------------------------------------------------------------------

#[test]
fn lambda_immediate_invocation() {
    // donor: "Inline lambda invocation" — LAMBDA(x,x+1)(41) -> 42.
    assert_eq!(eval("LAMBDA(x,x+1)(41)"), num(42.0));
}

#[test]
fn lambda_bound_in_let_and_invoked() {
    // donor: lambda_can_be_bound_and_invoked.
    assert_eq!(eval("LET(inc,LAMBDA(n,n+1),inc(41))"), num(42.0));
}

#[test]
fn lambda_closure_captures_outer_let_binding() {
    // donor: lambda_closure_captures_outer_bindings.
    assert_eq!(eval("LET(k,10,addk,LAMBDA(n,n+k),addk(5))"), num(15.0));
}

#[test]
fn lambda_closure_snapshot_semantics() {
    // donor: lambda_closure_snapshot_semantics — the closure captures k=1 at
    // creation; a LATER k=2 does not change what it sees. -> 1, not 2.
    assert_eq!(eval("LET(k,1,f,LAMBDA(x,x+k),k,2,f(0))"), num(1.0));
}

#[test]
fn lambda_param_shadows_outer_scope() {
    // donor: lambda_param_shadowing — the lambda's `n` shadows the LET `n`.
    assert_eq!(eval("LET(n,5,f,LAMBDA(n,n+1),f(10))"), num(11.0));
}

#[test]
fn lambda_names_case_insensitive() {
    // donor: let_and_lambda_names_are_case_insensitive (LAMBDA half).
    assert_eq!(eval("LET(F,LAMBDA(n,n+1),f(1))"), num(2.0));
}

#[test]
fn lambda_uninvoked_value_is_calc_error() {
    // donor: lambda_value_requires_invocation — a callable as a cell value.
    assert_eq!(eval("LAMBDA(x,x+1)"), Value::Error(ErrorValue::Calc));
}

#[test]
fn lambda_bound_but_not_invoked_is_calc_error() {
    // donor: non_invoked_lambda_in_let_is_calc_error.
    assert_eq!(
        eval("LET(f,LAMBDA(x,x+1),f)"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn lambda_wrong_arity_is_value_error() {
    // donor: lambda_arity_errors — exact arity; 2 args to a 1-param lambda.
    assert_eq!(
        eval("LET(inc,LAMBDA(n,n+1),inc(1,2))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn lambda_duplicate_params_is_value_error() {
    // donor: lambda_rejects_duplicate_params — LAMBDA(x,x,x+1).
    assert_eq!(eval("LAMBDA(x,x,x+1)"), Value::Error(ErrorValue::Value));
}

#[test]
fn lambda_self_application_runaway_hits_depth_guard() {
    // A closure passed to itself with no terminating base case (our IF is eager,
    // so it cannot short-circuit one) recurses unboundedly — the depth guard
    // turns it into a loud `#NUM!` instead of a native stack overflow.
    assert_eq!(
        eval("LET(g,LAMBDA(self,n,self(self,n+1)),g(g,1))"),
        Value::Error(ErrorValue::Num)
    );
}

#[test]
fn lambda_two_params() {
    // Multi-param lambda, immediate invocation.
    assert_eq!(eval("LAMBDA(a,b,a*b)(6,7)"), num(42.0));
}

#[test]
fn lambda_nested_let_in_body() {
    // donor engine test shape: a LET inside a lambda body.
    assert_eq!(eval("LET(a,10,f,LAMBDA(x,LET(y,x+a,y)),f(2))"), num(12.0));
}

// ---------------------------------------------------------------------
// Wave P — megaudit-pinned (2026-06-20)
// ---------------------------------------------------------------------

#[test]
fn lambda_curried_immediate() {
    // Codex megaudit HIGH #1: a lambda RETURNING a lambda (currying) preserves
    // callable identity through the call. LAMBDA(x,LAMBDA(y,x+y))(5)(3) -> 8.
    assert_eq!(eval("LAMBDA(x,LAMBDA(y,x+y))(5)(3)"), num(8.0));
}

#[test]
fn lambda_curried_via_let() {
    // The LET-bound currying form: make(5) returns a closure stored in `adder`,
    // which then adds 5. (NOTE: the local name must NOT be cell-ref-shaped —
    // `add5` would lex as cell ADD5 and be rejected as a non-identifier name.)
    assert_eq!(
        eval("LET(make,LAMBDA(x,LAMBDA(y,x+y)),adder,make(5),adder(3))"),
        num(8.0)
    );
    // And the inline chained form through a LET-bound make.
    assert_eq!(
        eval("LET(make,LAMBDA(x,LAMBDA(y,x+y)),make(5)(3))"),
        num(8.0)
    );
}

#[test]
fn lambda_deeper_currying_through_let_is_calc_documented_boundary() {
    // **Documented v1 boundary (Codex re-audit HIGH #1, gated):** currying where
    // the returned lambda is wrapped in a LET (or any non-direct expression) is
    // NOT supported — it degrades LOUDLY to `#CALC!`, never a silent wrong value.
    // `LAMBDA(x, LET(z,x, LAMBDA(y,z+y)))(5)(3)` would be 8 in Excel; here the
    // inner `LET(...) -> lambda` is scalarized to `#CALC!`. The fix is to make
    // the LET-body eval binding-returning (symmetric to the `CallLambda` fix);
    // deferred as a named follow-up. This test PINS the current boundary.
    assert_eq!(
        eval("LAMBDA(x,LET(z,x,LAMBDA(y,z+y)))(5)(3)"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn lambda_heavy_body_runaway_is_num_not_stack_overflow() {
    // Megaudit MED (2 lanes): a heavy IF-wrapped runaway recursion (no reachable
    // base case) must fire the depth guard as a clean `#NUM!`, NOT overflow the
    // native stack (which SIGABRTs the whole test process). MAX_LAMBDA_DEPTH was
    // lowered to 64 so even a heavy debug-build frame stays under the 2 MiB
    // thread stack. This is the regression guard for that calibration.
    assert_eq!(
        eval("LET(g,LAMBDA(s,n,IF(n<0,0,1+s(s,n+1))),g(g,1))"),
        Value::Error(ErrorValue::Num)
    );
}

#[test]
fn let_numeric_name_is_value_error() {
    // Lane 3 suggestion: a numeric LET name is not an identifier -> #VALUE!.
    assert_eq!(eval("LET(5,1,5)"), Value::Error(ErrorValue::Value));
}

#[test]
fn let_local_shadows_builtin_when_called() {
    // Lane 3 suggestion: a local bound to a lambda shadows a same-named BUILTIN
    // when CALLED — LET(SUM, LAMBDA(x,x*10), SUM(4)) invokes the lambda (40),
    // not the builtin SUM.
    assert_eq!(eval("LET(SUM,LAMBDA(x,x*10),SUM(4))"), num(40.0));
}

#[test]
fn let_local_value_called_as_function_is_value_error() {
    // A non-callable local invoked as a function -> #VALUE! (Excel canon).
    assert_eq!(eval("LET(x,5,x(1))"), Value::Error(ErrorValue::Value));
}
