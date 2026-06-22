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
fn fu4b_byrow_index_over_row_local_is_calc_in_scalar_context() {
    // **Deferred-tier pin (the locked scope).** The array-as-arg relaxation is scoped to
    // the scalar-aggregate REDUCERS only; a RangeAware fn like INDEX over the row array
    // does NOT compute — it stays loud. In SCALAR context the whole BYROW array result
    // collapses to #CALC! regardless of the per-cell code. (The per-cell code is actually
    // #VALUE! — INDEX rejects the malformed scalar array arg — pinned precisely by the
    // production test `fu4b_byrow_index_over_row_local_is_deferred_loud_in_production`.)
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
fn fu4c_non_gated_range_aware_over_array_local_stays_loud() {
    // Reducers-only: a RangeAware fn OUTSIDE the gate keeps the unchanged `other =>`
    // path (array-local → `FnArg::Scalar(#CALC!)`), and its collector rejects a Scalar
    // arg → #VALUE!. CORREL (pair-stats) and SHARPE (financial) both look reducer-ish
    // but are deferred — this catches an over-broad gate.
    assert_eq!(
        eval("LET(s,SEQUENCE(5),CORREL(s,s))"),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        eval("LET(s,SEQUENCE(5),SHARPE(s))"),
        Value::Error(ErrorValue::Value)
    );
}
