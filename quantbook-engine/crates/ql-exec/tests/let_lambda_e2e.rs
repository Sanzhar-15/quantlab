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

/// **FU4c-C1 (2026-06-22):** assert a numeric result within `tol` (mirrors the `approx`
/// helper in `financial_fns.rs`). The financial reducers (SHARPE/VOLATILITY/SORTINO/NPV/
/// IRR/MIRR/XNPV/XIRR) yield irrational / iterative values; the pair-stats self-pairing
/// identities are exactly representable and use `num()` equality instead.
fn approx(actual: Value, expected: f64, tol: f64) {
    match actual {
        Value::Number(n) => assert!(
            (n - expected).abs() <= tol,
            "expected ~{expected} (tol {tol}), got {n}"
        ),
        other => panic!("expected Number ~{expected}, got {other:?}"),
    }
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
fn lambda_curried_through_let_body() {
    // **Wave P follow-up 2 (2026-06-20) — boundary CLOSED.** Currying where the
    // returned lambda is wrapped in a LET now works: `eval_binding`'s `Let` arm
    // routes the LET body back through `eval_binding` (binding-returning) instead
    // of scalarizing it, so the inner `LAMBDA(y,z+y)` survives as a callable.
    // `LAMBDA(x, LET(z,x, LAMBDA(y,z+y)))(5)(3)` → x=5, z=5, then (y -> 5+y)(3) = 8.
    // (Was a documented `#CALC!` boundary at Wave P core ship.)
    assert_eq!(eval("LAMBDA(x,LET(z,x,LAMBDA(y,z+y)))(5)(3)"), num(8.0));
}

#[test]
fn let_binding_if_wrapped_lambda_stays_calc_documented_boundary() {
    // **Wave P follow-up 2 — the boundary that REMAINS (moved from LET-wrapped to
    // Function-wrapped).** Only `ExprPlan::Let` was made binding-returning. A lambda
    // returned through any OTHER non-direct construct still scalarizes to `#CALC!`
    // via `eval_binding`'s `_` arm. `IF(TRUE, LAMBDA(x,x), 0)` is eager
    // (scalar-tier) → the lambda branch becomes `#CALC!` before IF selects it → `f`
    // is `#CALC!` → `f(3)` propagates `#CALC!`. LOUD, never a silent wrong value.
    // This PINS the residual boundary so closing it later is a deliberate change.
    assert_eq!(
        eval("LET(f,IF(TRUE,LAMBDA(x,x),0),f(3))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn let_body_uninvoked_lambda_is_calc_error() {
    // **Wave P follow-up 2 seam guard.** The SCALAR `Let` arm must keep scalarizing
    // its body, so a LET whose body is a bare uninvoked LAMBDA surfaces `#CALC!` at
    // a cell/scalar result position — a callable must NEVER escape into a cell value
    // (forbidden by `local_env.rs`). Only the binding-returning `eval_binding` path
    // (the currying case above) preserves the callable.
    assert_eq!(eval("LET(x,1,LAMBDA(y,y))"), Value::Error(ErrorValue::Calc));
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
fn lambda_heavy_body_via_let_runaway_is_num_not_stack_overflow() {
    // **Wave P follow-up 2 — depth-seed guard.** Same runaway recursion as above,
    // but each invocation's body is wrapped in a LET so the body eval routes through
    // `eval_binding`'s new `Let` arm → `eval_let_bindings`. That helper MUST seed
    // `depth` from `env.lambda_depth()` (not 0). If it reset to 0, the recursion
    // counter would never reach `MAX_LAMBDA_DEPTH` and the native stack would
    // overflow (SIGABRT the test process); with the depth threaded, it returns a
    // clean `#NUM!`. This is the regression guard for that seam.
    assert_eq!(
        eval("LET(g,LAMBDA(s,n,LET(d,1,IF(n<0,0,d+s(s,n+1)))),g(g,1))"),
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

// ---------------------------------------------------------------------
// FU3 (2026-06-21) — scalar-context pins. The `eval()` helper drives the
// SCALAR evaluator (`eval_scalar_with_cache`), NOT the cell boundary, so
// an array result is `#CALC!` here — only the boundary (production) path
// spills (see let_lambda_recalc_contract.rs `fu3_*`). These pin that FU3
// did NOT change scalar-context behavior (the cardinal soundness rule).
// ---------------------------------------------------------------------

#[test]
fn fu3_let_array_body_is_calc_in_scalar_context() {
    // =LET(x,5,SEQUENCE(x)) spills at the cell boundary, but in SCALAR context an array
    // body is #CALC! (no implicit intersection). Proves the boundary is the only spiller.
    assert_eq!(eval("LET(x,5,SEQUENCE(x))"), Value::Error(ErrorValue::Calc));
}

#[test]
fn fu3_let_array_local_arithmetic_is_calc() {
    // Array arithmetic on a local stays #CALC! (deferred boundary; eval_binary has no
    // array broadcast). Unchanged by FU3.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),s*2)"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4b_let_array_local_as_sum_arg_computes() {
    // **FU4b (2026-06-21) — FLIPPED from `fu3_let_array_local_as_sum_arg_is_calc`
    // (was #CALC!).** The scalar-aggregate array-as-arg relaxation (the substrate for
    // `SUM(row)` inside BYROW) ALSO lets a generic array local flow into a reducer:
    // =LET(s,SEQUENCE(3),SUM(s)) computes 1+2+3 = 6 (Excel-correct). The arithmetic
    // form (`s*2`, above) and the Unified/Reference tiers (`TRANSPOSE(s)`/`INDEX(s,1)`)
    // STAY #CALC! — the relaxation is scoped to the scalar-aggregate reducers only.
    assert_eq!(eval("LET(s,SEQUENCE(3),SUM(s))"), num(6.0));
}

#[test]
fn fu3_let_array_callee_is_calc_in_scalar_context() {
    // Megaudit (Codex HIGH): calling an array-valued local is #CALC! in scalar context too
    // (invoke_lambda's Array-callee arm) — EXACTLY the pre-FU3 result. Contrast the scalar
    // (non-array) non-callable local `LET(x,5,x(1))` which stays #VALUE! above.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),s(1))"),
        Value::Error(ErrorValue::Calc)
    );
}

// -------------------------------------------------------------------------
// FU4 (2026-06-21) — Tier-1 higher-order helpers, scalar-context + error model.
// The `eval()` helper drives the SCALAR evaluator, so an ARRAY result (MAP /
// MAKEARRAY / SCAN) is `#CALC!` here — only the cell boundary (production path,
// `let_lambda_recalc_contract.rs::fu4_*`) spills. REDUCE returns a genuine
// scalar, so it computes and composes even in scalar context.
// -------------------------------------------------------------------------

#[test]
fn fu4_map_array_result_is_calc_in_scalar_context() {
    assert_eq!(eval("MAP(SEQUENCE(3),LAMBDA(x,x*x))"), Value::Error(ErrorValue::Calc));
}

#[test]
fn fu4_makearray_array_result_is_calc_in_scalar_context() {
    assert_eq!(eval("MAKEARRAY(2,2,LAMBDA(r,c,r+c))"), Value::Error(ErrorValue::Calc));
}

#[test]
fn fu4_scan_array_result_is_calc_in_scalar_context() {
    assert_eq!(eval("SCAN(0,SEQUENCE(3),LAMBDA(a,v,a+v))"), Value::Error(ErrorValue::Calc));
}

#[test]
fn fu4_reduce_scalar_result_computes_in_scalar_context() {
    // REDUCE's result is a scalar, so it computes even in scalar context.
    assert_eq!(eval("REDUCE(0,SEQUENCE(4),LAMBDA(a,v,a+v))"), num(10.0));
}

#[test]
fn fu4_reduce_composes_as_a_scalar() {
    // Proves REDUCE composes in a sub-expression (`+1`) — it is genuinely scalar.
    assert_eq!(eval("REDUCE(0,SEQUENCE(4),LAMBDA(a,v,a+v))+1"), num(11.0));
}

#[test]
fn fu4_map_wrong_arity_lambda_is_value() {
    // A 2-param lambda for a single-array MAP → whole-result #VALUE! (the up-front
    // arity check: lambda param count must equal the array count). A single error,
    // not a spill of per-cell errors — so it surfaces directly even in scalar context.
    assert_eq!(eval("MAP({1,2,3},LAMBDA(a,b,a+b))"), Value::Error(ErrorValue::Value));
}

#[test]
fn fu4_map_two_array_one_param_lambda_is_value() {
    // The other arity direction: 2 arrays but a 1-param lambda → #VALUE!.
    assert_eq!(eval("MAP({1,2,3},{4,5,6},LAMBDA(a,a))"), Value::Error(ErrorValue::Value));
}

#[test]
fn fu4_map_non_lambda_slot_is_value() {
    // A non-lambda in the lambda slot → the WHOLE result is #VALUE! (resolve fails
    // up front), which is a scalar error and surfaces directly (not #CALC!).
    assert_eq!(eval("MAP({1,2,3},5)"), Value::Error(ErrorValue::Value));
}

#[test]
fn fu4_makearray_negative_dim_is_value() {
    assert_eq!(eval("MAKEARRAY(-1,2,LAMBDA(r,c,r))"), Value::Error(ErrorValue::Value));
}

#[test]
fn fu4_makearray_zero_dim_is_num() {
    // [confirm vs Excel] — SEQUENCE-consistent: a zero dimension → #NUM!.
    assert_eq!(eval("MAKEARRAY(0,2,LAMBDA(r,c,r))"), Value::Error(ErrorValue::Num));
}

#[test]
fn fu4_map_mismatched_dims_is_value() {
    // [confirm vs Excel — flip to #N/A if live Excel differs] — two MAP arrays of
    // different sizes → #VALUE! (a scalar error, surfaces directly).
    assert_eq!(eval("MAP({1,2,3},{1,2},LAMBDA(a,b,a+b))"), Value::Error(ErrorValue::Value));
}

#[test]
fn fu4_map_per_element_array_result_is_calc() {
    // A per-element lambda result that is an ARRAY (=MAP(SEQUENCE(2),LAMBDA(x,SEQUENCE(x))))
    // makes each cell #CALC! (Tier-1 lambdas must return scalars; the deferred boundary).
    // In scalar context the whole array is #CALC! anyway — this pins it doesn't panic.
    assert_eq!(eval("MAP(SEQUENCE(2),LAMBDA(x,SEQUENCE(x)))"), Value::Error(ErrorValue::Calc));
}

#[test]
fn fu4_reduce_runaway_lambda_is_num_not_stack_overflow() {
    // Depth threads into the helper's per-element invocation: a runaway self-applying
    // lambda inside a REDUCE body hits MAX_LAMBDA_DEPTH (64) → #NUM!, NOT a SIGABRT.
    assert_eq!(
        eval("REDUCE(0,SEQUENCE(1),LAMBDA(a,v,LET(g,LAMBDA(s,n,IF(n<0,0,1+s(s,n+1))),g(g,1))))"),
        Value::Error(ErrorValue::Num)
    );
}

#[test]
fn fu4_reduce_error_element_flows_into_lambda() {
    // **Megaudit (Codex MEDIUM):** an ERROR-valued scalar array source must flow INTO
    // the lambda (where IFERROR can recover it), not short-circuit before it runs.
    // REDUCE(0, 1/0, LAMBDA(a,x,IFERROR(x,42))) → the 1×1 [#DIV/0!] is folded → 42.
    assert_eq!(
        eval("REDUCE(0,1/0,LAMBDA(a,x,IFERROR(x,42)))"),
        num(42.0)
    );
}

#[test]
fn fu4_map_array_lambda_slot_is_calc() {
    // **Megaudit (Codex LOW, intentional):** an ARRAY in the lambda slot is #CALC!
    // (an array in a callee position; FU3-consistent — invoke_lambda's array-callee
    // arm is also #CALC!), NOT #VALUE!. A non-array non-lambda slot stays #VALUE!
    // (see fu4_map_non_lambda_slot_is_value).
    assert_eq!(eval("MAP({1},SEQUENCE(1))"), Value::Error(ErrorValue::Calc));
}

// --- FU4b — BYROW / BYCOL (scalar-context + error model) --------------------

#[test]
fn fu4b_byrow_array_result_is_calc_in_scalar_context() {
    // **FLIPPED from `fu4_byrow_unimplemented_is_name_error` (was #NAME?).** BYROW now
    // returns a column vector → in SCALAR context an array result is #CALC! (only the
    // cell boundary spills; the {3;7} value+shape assertions live in
    // let_lambda_recalc_contract.rs::fu4b_byrow_2d_spills_column).
    assert_eq!(
        eval("BYROW(SEQUENCE(3),LAMBDA(r,SUM(r)))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4b_bycol_array_result_is_calc_in_scalar_context() {
    // **FLIPPED from `fu4_bycol_unimplemented_is_name_error` (was #NAME?).** SEQUENCE(3)
    // is 3×1; BYCOL over a single column → a 1×1 result, still an EvalResult::Array →
    // #CALC! in scalar context.
    assert_eq!(
        eval("BYCOL(SEQUENCE(3),LAMBDA(c,SUM(c)))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4b_byrow_wrong_arity_lambda_is_value() {
    // BYROW's lambda takes exactly ONE param (a row); a 2-param lambda → whole-result
    // #VALUE! (a scalar error, surfaces directly even in scalar context).
    assert_eq!(
        eval("BYROW({1,2;3,4},LAMBDA(r,s,SUM(r)))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4b_byrow_non_lambda_slot_is_value() {
    // A non-lambda scalar in the lambda slot → whole-result #VALUE! (resolve fails up front).
    assert_eq!(eval("BYROW({1,2;3,4},5)"), Value::Error(ErrorValue::Value));
}

#[test]
fn fu4b_byrow_array_lambda_slot_is_calc() {
    // An ARRAY in the lambda slot → #CALC! (an array in a callee position; FU3-consistent),
    // NOT #VALUE!. Distinct from the non-array non-lambda slot above.
    assert_eq!(
        eval("BYROW({1,2;3,4},SEQUENCE(2))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4c_byrow_index_in_scalar_context_collapses_to_calc() {
    // **FU4c-B (2026-06-22):** INDEX now COMPUTES over an array-local row (it joined the
    // `is_range_aware_lookup` gate), but this scalar-context check is VACUOUS: a BYROW
    // result is an ARRAY, and the boundary maps ANY array result to #CALC! in scalar
    // context regardless of the per-cell values. So this stays #CALC! even though the
    // per-row INDEX now computes. The REAL FU4c-B win is asserted by the production pin
    // `fu4c_byrow_index_over_row_local_computes_in_production` (per-cell spill = {1;3})
    // and the standalone `LET(s,...,INDEX(s,2))` scalar pins (INDEX returns a scalar there).
    assert_eq!(
        eval("BYROW({1,2;3,4},LAMBDA(r,INDEX(r,1)))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4b_byrow_transpose_over_row_local_is_calc() {
    // Deferred-tier pin: a Unified-tier fn (TRANSPOSE) over the row array-local stays
    // #CALC! (consistent with fu3_let_array_local_as_unified_fn_arg_is_calc).
    assert_eq!(
        eval("BYROW({1,2;3,4},LAMBDA(r,TRANSPOSE(r)))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4c_byrow_median_in_scalar_context_collapses_to_calc() {
    // **FU4c (2026-06-22):** MEDIAN now COMPUTES over an array-local row (it joined the
    // `is_range_aware_reducer` gate), but this scalar-context check is VACUOUS: a BYROW
    // result is an ARRAY, and the boundary maps ANY array result to #CALC! in scalar
    // context regardless of the per-cell values. So this stays #CALC! even though the
    // per-row medians now compute. The REAL FU4c win is asserted by the production pin
    // `fu4c_byrow_median_over_row_local_computes_in_production` (per-cell spill = {2;5})
    // and the standalone `LET(s,…,MEDIAN(s))` scalar pins (MEDIAN returns a scalar there).
    assert_eq!(
        eval("BYROW({1,3,2;4,6,5},LAMBDA(r,MEDIAN(r)))"),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4b_byrow_empty_filter_source_is_calc() {
    // **Megaudit (Codex LOW):** a degenerate / empty source flows loudly to #CALC!,
    // no panic. FILTER with an all-FALSE mask returns #CALC! upstream; BYROW over it
    // stays #CALC! (whether via the upstream error or the defensive 0-area guard).
    assert_eq!(
        eval("BYROW(FILTER({1;2},{0;0}),LAMBDA(r,SUM(r)))"),
        Value::Error(ErrorValue::Calc)
    );
}

// =============================================================================
// FU4c (2026-06-22): array-local consumed by a RangeAware STATISTICAL REDUCER.
// These reducers return a SCALAR, so a standalone `LET(s,…,MEDIAN(s))` flips
// #CALC!→value in scalar context (unlike a BYROW result, which is an array and
// collapses to #CALC! at the boundary — see the renamed vacuous pin above).
// =============================================================================

#[test]
fn fu4c_let_median_over_array_local_computes() {
    // The scalar win: MEDIAN over a 5-element array-local = 3 (was #CALC! pre-FU4c).
    assert_eq!(eval("LET(s,SEQUENCE(5),MEDIAN(s))"), num(3.0));
}

#[test]
fn fu4c_let_large_small_over_array_local_compute() {
    assert_eq!(eval("LET(s,SEQUENCE(5),LARGE(s,1))"), num(5.0)); // largest
    assert_eq!(eval("LET(s,SEQUENCE(5),SMALL(s,1))"), num(1.0)); // smallest
    assert_eq!(eval("LET(s,SEQUENCE(5),LARGE(s,5))"), num(1.0)); // k = count edge
}

#[test]
fn fu4c_let_percentile_over_array_local_computes() {
    assert_eq!(eval("LET(s,SEQUENCE(5),PERCENTILE.INC(s,0.5))"), num(3.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),PERCENTILE.EXC(s,0.5))"), num(3.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),PERCENTILE(s,0.5))"), num(3.0)); // legacy alias
}

#[test]
fn fu4c_let_quartile_over_array_local_computes() {
    assert_eq!(eval("LET(s,SEQUENCE(5),QUARTILE.INC(s,1))"), num(2.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),QUARTILE.EXC(s,2))"), num(3.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),QUARTILE(s,1))"), num(2.0)); // legacy alias
}

#[test]
fn fu4c_let_rank_over_array_local_computes() {
    assert_eq!(eval("LET(s,SEQUENCE(5),RANK(2,s))"), num(4.0)); // descending default
    assert_eq!(eval("LET(s,SEQUENCE(5),RANK(2,s,1))"), num(2.0)); // ascending
    assert_eq!(eval("LET(s,SEQUENCE(5),RANK.EQ(2,s))"), num(4.0)); // alias of RANK
}

#[test]
fn fu4c_let_rank_avg_over_array_local_computes() {
    // RANK.AVG averages tied ranks. {30,20,20,10} desc → 20 at ranks 2 & 3 → 2.5.
    assert_eq!(eval("LET(s,{10,20,20,30},RANK.AVG(20,s))"), num(2.5));
}

#[test]
fn fu4c_let_mode_over_array_local_computes() {
    // MODE picks the most frequent value; MODE.SNGL is its alias.
    assert_eq!(eval("LET(s,{1,2,2,3},MODE(s))"), num(2.0));
    assert_eq!(eval("LET(s,{1,2,2,3},MODE.SNGL(s))"), num(2.0));
    // MODE on no-repeat data computes to #N/A, proving it RAN (not a deferred #CALC!).
    assert_eq!(
        eval("LET(s,SEQUENCE(5),MODE(s))"),
        Value::Error(ErrorValue::NA)
    );
}

// --- FU4c edge / error paths (the reducer's own validation, post-relaxation) --

#[test]
fn fu4c_reducer_k_out_of_range_is_num() {
    assert_eq!(
        eval("LET(s,SEQUENCE(3),LARGE(s,9))"), // k > count
        Value::Error(ErrorValue::Num)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),SMALL(s,0))"), // k < 1
        Value::Error(ErrorValue::Num)
    );
}

#[test]
fn fu4c_percentile_quartile_bounds_are_num() {
    // PERCENTILE.EXC valid window for n=3 is [1/4, 3/4]; 0.01 is below it.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),PERCENTILE.EXC(s,0.01))"),
        Value::Error(ErrorValue::Num)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),PERCENTILE.INC(s,1.5))"), // p > 1
        Value::Error(ErrorValue::Num)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),QUARTILE.EXC(s,4))"), // .EXC quart ∈ {1,2,3} only
        Value::Error(ErrorValue::Num)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),QUARTILE.EXC(s,0))"),
        Value::Error(ErrorValue::Num)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),QUARTILE.INC(s,5))"), // .INC quart ∈ {0..4}
        Value::Error(ErrorValue::Num)
    );
}

#[test]
fn fu4c_rank_not_found_is_na() {
    assert_eq!(
        eval("LET(s,SEQUENCE(3),RANK(99,s))"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn fu4c_reducer_wrong_slot_array_is_loud() {
    // The relaxation is position-blind (any array-local arg of a gated reducer → Range);
    // an array in a NON-data slot is rejected loudly by the reducer's own arg match — it
    // never silently computes. RANK's number slot (arg0) and LARGE's k slot (arg1):
    assert_eq!(
        eval("LET(s,SEQUENCE(3),RANK(s,s))"), // s in the `number` slot → #VALUE!
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),LARGE(s,s))"), // s in the `k` slot → #VALUE!
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c1_financial_pairstat_compute_choose_stays_loud() {
    // **FU4c-C1 (2026-06-22), guard rebased at FU4c-D (2026-06-22):** the financial + pair-stats
    // RangeAware reducers consume an array-local (CORREL/MAX_DRAWDOWN below — both EXACT-valued
    // witnesses). FU4c-D then gated the conditionals (SUMIF now COMPUTES — see the D block), so
    // the over-broad-gate guard moves to CHOOSE — the SOLE still-ungated RangeAware fn (a
    // passthrough, no data-array slot). The array-local takes the unchanged `other =>` path
    // (→ `FnArg::Scalar(#CALC!)`); CHOOSE returns that sentinel VERBATIM → `#CALC!` (NOT
    // `#VALUE!`). If the gate ever wrongly relaxed the WHOLE RangeAware tier, CHOOSE would
    // materialize `s` as a `Range` → its `FnArg::Range{..}=>Err(Value)` arm → `#VALUE!`, so this
    // pin FAILS — the guard distinguishes the two states.
    assert_eq!(eval("LET(s,SEQUENCE(5),CORREL(s,s))"), num(1.0)); // pair-stats: self-corr = 1
    assert_eq!(eval("LET(s,SEQUENCE(5),MAX_DRAWDOWN(s))"), num(0.0)); // financial: increasing → 0
    assert_eq!(
        eval("LET(s,SEQUENCE(5),CHOOSE(1,s))"),
        Value::Error(ErrorValue::Calc)
    ); // STILL ungated (CHOOSE: no data-array slot) — over-broad-gate guard, #CALC! verbatim
}

// =============================================================================
// FU4c-B (2026-06-22): array-local consumed by a RangeAware LOOKUP.
// The lookups are shape-aware (INDEX addresses by (row,col); MATCH/XLOOKUP/XMATCH
// scan; VLOOKUP/HLOOKUP read a 2-D table), so an array-local materializes as a
// shape-carrying Range -- byte-identical to a real range. These return a SCALAR, so a
// standalone `LET(s,...,INDEX(s,2))` is observable in scalar context (unlike a BYROW
// result, which is an array and collapses to #CALC! at the boundary).
// =============================================================================

#[test]
fn fu4c_let_index_over_array_local_computes() {
    // 1-col local: INDEX(s,2) = the 2nd element (single-col: row_num indexes the column).
    assert_eq!(eval("LET(s,SEQUENCE(5),INDEX(s,2))"), num(2.0));
}

#[test]
fn fu4c_let_index_2d_over_array_local_computes() {
    // 2-D local {1,2;3,4} binds row-major 2x2; INDEX(t,2,1) = row 2, col 1 = 3.
    assert_eq!(eval("LET(t,{1,2;3,4},INDEX(t,2,1))"), num(3.0));
}

#[test]
fn fu4c_let_index_out_of_bounds_is_ref() {
    assert_eq!(
        eval("LET(s,SEQUENCE(3),INDEX(s,9))"),
        Value::Error(ErrorValue::Ref)
    );
}

#[test]
fn fu4c_let_match_over_array_local_computes() {
    assert_eq!(eval("LET(s,SEQUENCE(5),MATCH(3,s,0))"), num(3.0)); // exact
    assert_eq!(eval("LET(s,{1,3,5,7},MATCH(4,s,1))"), num(2.0)); // approx: largest <= 4
}

#[test]
fn fu4c_let_match_not_found_is_na() {
    assert_eq!(
        eval("LET(s,SEQUENCE(5),MATCH(9,s,0))"),
        Value::Error(ErrorValue::NA)
    );
}

#[test]
fn fu4c_let_vlookup_over_2d_local_computes() {
    // 3x2 table: first col [1,2,3], find 2 -> row 2, return col 2 = 20.
    assert_eq!(
        eval("LET(t,{1,10;2,20;3,30},VLOOKUP(2,t,2,FALSE))"),
        num(20.0)
    );
}

#[test]
fn fu4c_let_vlookup_col_out_of_range_is_ref() {
    assert_eq!(
        eval("LET(t,{1,10;2,20},VLOOKUP(2,t,3,FALSE))"), // col 3 > cols 2
        Value::Error(ErrorValue::Ref)
    );
}

#[test]
fn fu4c_let_hlookup_over_2d_local_computes() {
    // 2x3 table: first row [1,2,3], find 2 -> col 2, return row 2 = 20.
    assert_eq!(
        eval("LET(t,{1,2,3;10,20,30},HLOOKUP(2,t,2,FALSE))"),
        num(20.0)
    );
}

#[test]
fn fu4c_let_xlookup_over_array_locals_computes() {
    // Same local for lookup + return: find 2 at index 1 -> ret[1] = 2.
    assert_eq!(eval("LET(s,SEQUENCE(3),XLOOKUP(2,s,s))"), num(2.0));
    // Distinct lookup/return locals (nested LET): find 2 in s -> r[1] = 20.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),LET(r,{10;20;30},XLOOKUP(2,s,r)))"),
        num(20.0)
    );
}

#[test]
fn fu4c_let_xlookup_if_not_found_over_array_local() {
    // 9 not in s -> the if_not_found scalar arg is returned.
    assert_eq!(eval("LET(s,SEQUENCE(3),XLOOKUP(9,s,s,99))"), num(99.0));
}

#[test]
fn fu4c_xlookup_if_not_found_array_local_is_lazy() {
    // **Codex MED -> pinned behavior.** XLOOKUP's `if_not_found` (arg3) is a LAZY fallback,
    // consulted ONLY on a miss. On a HIT the matched value is returned and arg3 is never
    // examined, so an array-local there is harmlessly ignored -> the genuine lookup result
    // (identical to the real-range path + Excel; NOT a silent wrong value). On a MISS arg3
    // IS consulted and a Range is rejected loudly. So the position-blind invariant holds
    // where it matters (a consulted slot); an UNUSED slot never produces a wrong value.
    assert_eq!(eval("LET(s,SEQUENCE(3),XLOOKUP(2,s,s,s))"), num(2.0)); // hit: arg3 ignored
    assert_eq!(
        eval("LET(s,SEQUENCE(3),XLOOKUP(9,s,s,s))"), // miss: arg3 Range rejected
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_let_xmatch_over_array_local_computes() {
    assert_eq!(eval("LET(s,SEQUENCE(5),XMATCH(3,s))"), num(3.0));
}

// --- FU4c-B position-blind + excluded/deferred (loud, never silent) ---

#[test]
fn fu4c_lookup_wrong_slot_array_is_loud() {
    // Position-blind: an array-local in a NON-data slot is rejected by the lookup's own
    // arg match -> #VALUE!. INDEX(s,s) -- arg0 is the valid data Range, arg1=s the
    // row_num Range -> #VALUE! (isolates the row_num slot); MATCH/VLOOKUP needle slot.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),INDEX(s,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),MATCH(s,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),VLOOKUP(s,s,1))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_choose_over_array_local_is_excluded_and_loud() {
    // CHOOSE is EXCLUDED (no data-array slot). The array-local takes the `other =>` path
    // -> FnArg::Scalar(#CALC!); CHOOSE(1,...) selects it and returns the #CALC! sentinel
    // VERBATIM -> loud, never a silent value. (Distinct code from the lookups' #VALUE!.)
    assert_eq!(
        eval("LET(s,SEQUENCE(3),CHOOSE(1,s,9))"),
        Value::Error(ErrorValue::Calc)
    );
}

// =============================================================================
// FU4c-C1 (2026-06-22): array-local consumed by a RangeAware FINANCIAL or PAIR-STATS
// reducer. Same gated arm as FU4c-A/B: the array-local materializes as a shape-carrying
// Range, byte-identical to a real range, so each computes exactly as over the equivalent
// range. Pair-stats self-pairing identities are EXACT (num()); financial values are
// irrational/iterative (approx(), anchored to the financial_fns.rs unit tests).
// =============================================================================

// --- pair-stats (exact, self-pairing identities) ---

#[test]
fn fu4c_c1_let_correl_pearson_rsq_self_pair_is_one() {
    // self-correlation of a non-constant series = 1 (num=denom); RSQ = r^2 = 1.
    assert_eq!(eval("LET(s,SEQUENCE(5),CORREL(s,s))"), num(1.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),PEARSON(s,s))"), num(1.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),RSQ(s,s))"), num(1.0));
}

#[test]
fn fu4c_c1_let_slope_intercept_over_array_locals() {
    // y=2x line (b=2a): regressing known_y=b on known_x=a → slope 2, intercept 0. Y-first.
    assert_eq!(eval("LET(a,{1,2,3},LET(b,{2,4,6},SLOPE(b,a)))"), num(2.0));
    assert_eq!(
        eval("LET(a,{1,2,3},LET(b,{2,4,6},INTERCEPT(b,a)))"),
        num(0.0)
    );
}

#[test]
fn fu4c_c1_let_covariance_self_pair_is_variance() {
    // COVARIANCE(X,X) = variance of X. s={1,2,3,4,5}: Σ(x-3)^2=10 → pop 10/5=2.0, samp 10/4=2.5.
    assert_eq!(eval("LET(s,SEQUENCE(5),COVARIANCE.P(s,s))"), num(2.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),COVARIANCE.S(s,s))"), num(2.5));
}

#[test]
fn fu4c_c1_let_steyx_self_pair_is_zero() {
    // perfect fit (y=x) → zero residual standard error. n=5 ≥ 3.
    assert_eq!(eval("LET(s,SEQUENCE(5),STEYX(s,s))"), num(0.0));
}

#[test]
fn fu4c_c1_let_paired_sum_of_squares_self_pair() {
    // SUMX2MY2(x,x)=Σ(x²−x²)=0; SUMXMY2(x,x)=Σ(x−x)²=0; SUMX2PY2(x,x)=Σ2x².
    // s={1,2,3,4,5}: Σx²=55 → SUMX2PY2 = 110.
    assert_eq!(eval("LET(s,SEQUENCE(5),SUMX2MY2(s,s))"), num(0.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),SUMXMY2(s,s))"), num(0.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),SUMX2PY2(s,s))"), num(110.0));
}

// --- financial (approx, anchored to financial_fns.rs unit tests) ---

#[test]
fn fu4c_c1_let_sharpe_over_array_local() {
    // returns {0.01,0.02,0.03,0.04}: mean 0.025 / sample sd 0.0129099445 = 1.9364916731
    // (rf=0, no annualization). Anchor: financial_fns.rs `sharpe_basic_rf_zero`.
    approx(
        eval("LET(r,{0.01,0.02,0.03,0.04},SHARPE(r))"),
        1.9364916731,
        1e-9,
    );
}

#[test]
fn fu4c_c1_let_volatility_over_array_local() {
    // same series: sample sd = 0.0129099445. Anchor: `volatility_basic_sample_stdev`.
    approx(
        eval("LET(r,{0.01,0.02,0.03,0.04},VOLATILITY(r))"),
        0.0129099445,
        1e-9,
    );
}

#[test]
fn fu4c_c1_let_sortino_over_array_local() {
    // {0.30,-0.10,0.10,-0.10}, MAR=0: mean 0.05 / downside-dev 0.0707106781 = 1/sqrt(2).
    // Anchor: `sortino_basic_mar_zero`.
    approx(
        eval("LET(r,{0.30,-0.10,0.10,-0.10},SORTINO(r))"),
        std::f64::consts::FRAC_1_SQRT_2,
        1e-9,
    );
}

#[test]
fn fu4c_c1_let_max_drawdown_over_array_local() {
    // {100,50}: peak 100, trough 50 → 50/100−1 = −0.5 (exact). (The increasing-series → 0
    // case is in `fu4c_c1_financial_pairstat_compute_choose_stays_loud`.)
    assert_eq!(eval("LET(eq,{100,50},MAX_DRAWDOWN(eq))"), num(-0.5));
}

#[test]
fn fu4c_c1_let_npv_over_array_local() {
    // NPV(0.1, {100,100,100}) = 100/1.1 + 100/1.21 + 100/1.331 ≈ 248.685. The cash-flow
    // array-local materializes as a Range (NPV's variadic slot accepts a Range). Anchor: `npv_basic`.
    approx(eval("LET(c,{100,100,100},NPV(0.1,c))"), 248.685, 1e-3);
}

#[test]
fn fu4c_c1_let_irr_over_array_local() {
    // IRR({-1000,600,600}) ≈ 0.13066. Anchor: `irr_basic`.
    approx(eval("LET(c,{-1000,600,600},IRR(c))"), 0.13066, 1e-4);
}

#[test]
fn fu4c_c1_let_mirr_over_array_local() {
    // Microsoft MIRR example: outflow 120k + 5 inflows, finance 10% / reinvest 12% ≈ 0.126094.
    // Anchor: `mirr_microsoft_example`.
    approx(
        eval("LET(c,{-120000,39000,30000,21000,37000,46000},MIRR(c,0.10,0.12))"),
        0.126094,
        1e-5,
    );
}

#[test]
fn fu4c_c1_let_xnpv_over_array_locals() {
    // Microsoft XNPV anchor: values + serial dates, rate 9% ≈ 2086.6478. Both array-locals.
    approx(
        eval(
            "LET(v,{-10000,2750,4250,3250,2750},\
             LET(d,{39448,39508,39751,39859,39904},XNPV(0.09,v,d)))",
        ),
        2086.6478,
        1e-2,
    );
}

#[test]
fn fu4c_c1_let_xirr_over_array_locals() {
    // -100 → +110 exactly 365 days apart = a clean 10% annual rate. Both array-locals.
    approx(
        eval("LET(v,{-100,110},LET(d,{40000,40365},XIRR(v,d)))"),
        0.10,
        1e-6,
    );
}

// --- FU4c-C1 position-blind / shape / behavioral (loud, never silent) ---

#[test]
fn fu4c_c1_financial_wrong_slot_array_is_loud() {
    // Position-blind: an array-local in a NON-data scalar slot is rejected loudly (#VALUE!)
    // by the fn's own arg match. NPV rate (arg0), SHARPE risk_free (arg1), IRR guess (arg1).
    assert_eq!(
        eval("LET(s,SEQUENCE(3),NPV(s,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),SHARPE(s,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),IRR(s,s))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c1_pairstat_shape_mismatch_is_loud() {
    // Two data arrays of unequal length → #VALUE! (collect_xy_pairs / paired_sum_inner
    // enforce equal 2-D shape).
    assert_eq!(
        eval("LET(a,{1,2,3},LET(b,{1,2},CORREL(a,b)))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(a,{1,2,3},LET(b,{1,2},SUMXMY2(a,b)))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c1_sortino_all_positive_is_div_zero() {
    // All returns ≥ MAR (=0) → zero downside → DD==0 → #DIV/0! (loud, never +Inf).
    // Behavioral pin (matches `sortino_no_downside_is_div_zero`).
    assert_eq!(
        eval("LET(r,{0.01,0.02,0.03},SORTINO(r))"),
        Value::Error(ErrorValue::DivZero)
    );
}

#[test]
fn fu4c_c1_volatility_constant_series_is_zero() {
    // A constant series has zero dispersion: VOLATILITY returns 0.0 (a valid statistic),
    // unlike SHARPE which errors #DIV/0! on the same denominator. Behavioral divergence pin.
    approx(eval("LET(r,{0.02,0.02,0.02},VOLATILITY(r))"), 0.0, 1e-12);
}

// =============================================================================
// FU4c-D (2026-06-22): array-local consumed by a RangeAware CONDITIONAL / TEXT / MULTI-RANGE
// / SUBTOTAL fn. Same gated arm as FU4c-A/B/C1: the array-local materializes as a
// shape-carrying Range, byte-identical to a real range, so each computes exactly as over the
// equivalent range. All results are EXACT (rationals / strings) -> num() / Value::text(); no
// approx() needed (unlike C1's irrational financials). Every non-data slot (criteria /
// delimiter / ignore_empty / function_num) rejects a Range LOUDLY -> #VALUE!.
// =============================================================================

// --- conditionals (exact) ---

#[test]
fn fu4c_d_let_sumif_over_array_local() {
    // single-range form: sum the crit-range cells matching ">2". {1..5}: 3+4+5 = 12.
    assert_eq!(eval("LET(s,SEQUENCE(5),SUMIF(s,\">2\"))"), num(12.0));
}

#[test]
fn fu4c_d_let_sumif_with_sum_range_over_array_locals() {
    // two-data-range form: sum t where s>1. s={1,2,3} (>1 at idx 1,2) -> t 20+30 = 50.
    assert_eq!(
        eval("LET(s,{1,2,3},LET(t,{10,20,30},SUMIF(s,\">1\",t)))"),
        num(50.0)
    );
}

#[test]
fn fu4c_d_let_countif_over_array_local() {
    // count {1..5} matching ">2" = {3,4,5} -> 3.
    assert_eq!(eval("LET(s,SEQUENCE(5),COUNTIF(s,\">2\"))"), num(3.0));
}

#[test]
fn fu4c_d_let_averageif_over_array_local() {
    // mean of {3,4,5} = 4.
    assert_eq!(eval("LET(s,SEQUENCE(5),AVERAGEIF(s,\">2\"))"), num(4.0));
}

#[test]
fn fu4c_d_let_sumifs_over_array_locals() {
    // sum t where s>2. s={1,2,3,4} (>2 at idx 2,3) -> t 30+40 = 70. Both array-locals.
    assert_eq!(
        eval("LET(s,{1,2,3,4},LET(t,{10,20,30,40},SUMIFS(t,s,\">2\")))"),
        num(70.0)
    );
}

#[test]
fn fu4c_d_let_countifs_over_array_local() {
    // count {1..5} matching ">=3" = {3,4,5} -> 3.
    assert_eq!(eval("LET(s,SEQUENCE(5),COUNTIFS(s,\">=3\"))"), num(3.0));
}

#[test]
fn fu4c_d_let_averageifs_over_array_locals() {
    // mean of t where s>2 = (30+40)/2 = 35.
    assert_eq!(
        eval("LET(s,{1,2,3,4},LET(t,{10,20,30,40},AVERAGEIFS(t,s,\">2\")))"),
        num(35.0)
    );
}

#[test]
fn fu4c_d_let_maxifs_minifs_over_array_locals() {
    // max / min of t where s>2 = max{30,40}=40, min{30,40}=30.
    assert_eq!(
        eval("LET(s,{1,2,3,4},LET(t,{10,20,30,40},MAXIFS(t,s,\">2\")))"),
        num(40.0)
    );
    assert_eq!(
        eval("LET(s,{1,2,3,4},LET(t,{10,20,30,40},MINIFS(t,s,\">2\")))"),
        num(30.0)
    );
}

#[test]
fn fu4c_d_let_countblank_over_array_local() {
    // A computed numeric array has no blanks -> 0 (proves it consumed the Range, not #VALUE!).
    assert_eq!(eval("LET(s,SEQUENCE(5),COUNTBLANK(s))"), num(0.0));
    // An empty-string element IS counted as blank -> {1,"",3} -> 1.
    assert_eq!(eval("LET(s,{1,\"\",3},COUNTBLANK(s))"), num(1.0));
}

// --- multi-range (exact) ---

#[test]
fn fu4c_d_let_sumproduct_over_array_locals() {
    // 1*4 + 2*5 + 3*6 = 32. Both array-locals materialize as Ranges (per-arg loop).
    assert_eq!(
        eval("LET(a,{1,2,3},LET(b,{4,5,6},SUMPRODUCT(a,b)))"),
        num(32.0)
    );
}

#[test]
fn fu4c_d_let_sumproduct_single_array_is_sum() {
    // SUMPRODUCT of one array = its sum. {1,2,3,4} -> 10.
    assert_eq!(eval("LET(s,SEQUENCE(4),SUMPRODUCT(s))"), num(10.0));
}

// --- text (exact strings) ---

#[test]
fn fu4c_d_let_concat_over_array_local() {
    // numeric cells render as integer text -> "123".
    assert_eq!(eval("LET(s,SEQUENCE(3),CONCAT(s))"), Value::text("123"));
}

#[test]
fn fu4c_d_let_concat_mixed_scalar_and_array() {
    // scalars + an array-local flatten in arg order -> "x" + "ab" + "y".
    assert_eq!(
        eval("LET(s,{\"a\",\"b\"},CONCAT(\"x\",s,\"y\"))"),
        Value::text("xaby")
    );
}

#[test]
fn fu4c_d_let_textjoin_over_array_local() {
    // delimiter "-", ignore_empty TRUE, data {1,2,3} -> "1-2-3".
    assert_eq!(
        eval("LET(s,SEQUENCE(3),TEXTJOIN(\"-\",TRUE,s))"),
        Value::text("1-2-3")
    );
}

#[test]
fn fu4c_d_let_textjoin_ignore_empty_false_keeps_blanks() {
    // ignore_empty FALSE keeps the empty element -> "a,,c" (behavioral pin).
    assert_eq!(
        eval("LET(t,{\"a\",\"\",\"c\"},TEXTJOIN(\",\",FALSE,t))"),
        Value::text("a,,c")
    );
}

// --- SUBTOTAL (exact; empty-mask equivalence) ---

#[test]
fn fu4c_d_let_subtotal_sum_and_average_over_array_local() {
    // function_num 9 = SUM, 1 = AVERAGE. {1..5}: sum 15, avg 3.
    assert_eq!(eval("LET(s,SEQUENCE(5),SUBTOTAL(9,s))"), num(15.0));
    assert_eq!(eval("LET(s,SEQUENCE(5),SUBTOTAL(1,s))"), num(3.0));
}

#[test]
fn fu4c_d_let_subtotal_9_equals_109_over_array_local() {
    // An array-local carries an EMPTY row_hidden mask, so the 101..=111 "ignore hidden"
    // variants are byte-identical to 1..=11 over the local: SUBTOTAL(109,s) == SUBTOTAL(9,s).
    let nine = eval("LET(s,SEQUENCE(5),SUBTOTAL(9,s))");
    let one_oh_nine = eval("LET(s,SEQUENCE(5),SUBTOTAL(109,s))");
    assert_eq!(nine, num(15.0));
    assert_eq!(one_oh_nine, nine);
}

// --- FU4c-D position-blind / shape / behavioral (loud, never silent) ---

#[test]
fn fu4c_d_conditional_criteria_slot_array_is_loud() {
    // The criteria slot is a NON-data scalar slot: an array-local there is rejected loudly.
    // (SUMIF/COUNTIF are gated, so BOTH args materialize as Ranges; the criteria arm rejects it.)
    assert_eq!(
        eval("LET(s,SEQUENCE(3),SUMIF(s,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),COUNTIF(s,s))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_d_textjoin_control_slot_array_is_loud() {
    // delimiter (arg0) and ignore_empty (arg1) are NON-data slots -> an array-local is #VALUE!.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),TEXTJOIN(s,TRUE,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(3),TEXTJOIN(\"-\",s,s))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_d_subtotal_function_num_slot_array_is_loud() {
    // function_num (arg0) is a NON-data slot -> an array-local is #VALUE!.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),SUBTOTAL(s,s))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_d_strict_shape_mismatch_is_loud() {
    // SUMIFS + SUMPRODUCT enforce STRICT 2-D shape -> mismatched array-locals -> #VALUE!.
    // (SUMIF is NOT here: it zip-truncates, so a mismatch does not error.)
    assert_eq!(
        eval("LET(a,{1,2,3},LET(b,{1,2},SUMIFS(a,b,\">0\")))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(a,{1,2,3},LET(b,{1,2},SUMPRODUCT(a,b)))"),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_d_averageif_no_match_is_div_zero() {
    // No cell matches ">9" -> #DIV/0! (loud, never NaN). Behavioral pin.
    assert_eq!(
        eval("LET(s,SEQUENCE(3),AVERAGEIF(s,\">9\"))"),
        Value::Error(ErrorValue::DivZero)
    );
}

#[test]
fn fu4c_d_maxifs_no_match_is_zero() {
    // Excel canon: MAXIFS with no matching cell -> 0 (not an error). Behavioral pin.
    assert_eq!(
        eval("LET(s,{1,2,3},LET(t,{10,20,30},MAXIFS(t,s,\">9\")))"),
        num(0.0)
    );
}
