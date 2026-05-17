//! **W5-D-1.1 (Opus MEDIUM-O-1 closure):** end-to-end dispatch tests
//! for the Wave 3 distributions batch (NORM.DIST / NORM.S.DIST / NORM.INV
//! / NORM.S.INV).
//!
//! The unit tests in `crates/ql-functions/src/distribution_fns.rs` call
//! the impls directly with `Value` arrays — they prove the kernel math
//! is correct but bypass the dispatcher chain. Per the prior W5-180/181/
//! 182/183 depreciation-batch e2e pattern (in
//! `crates/ql-exec/tests/region_mul2_e2e.rs:452-504`), each new batch
//! ships at least one e2e dispatch test per fn confirming:
//!
//! 1. The formula-string parser recognizes the dotted-name `NORM.DIST`
//!    as a single fn token (not `NORM` `.` `DIST(...)`).
//! 2. The case-insensitive registry lookup routes the uppercase name
//!    correctly to the scalar-fn pointer.
//! 3. The eager-eval scalar path passes pre-evaluated args (Number /
//!    Boolean / Text) and surfaces results / errors correctly.

use ql_exec::{eval_scalar_with_registry, MapEnv};
use ql_formula_syntax::{lex, parse};
use ql_functions::default_registry;
use ql_types::{ErrorValue, Value};

fn eval(src: &str) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let plan = ql_exec::bind(&ast, 0).expect("bind");
    let env = MapEnv::new();
    let reg = default_registry();
    eval_scalar_with_registry(&plan, &env, &reg)
}

/// Approximate-equality helper for distribution-result tests.
fn assert_close(got: Value, expected: f64) {
    match got {
        Value::Number(n) => {
            let diff = (n - expected).abs();
            let denom = n.abs().max(expected.abs()).max(1.0);
            assert!(
                diff / denom < 1e-9,
                "expected ≈ {expected}, got {n} (diff = {diff})"
            );
        }
        other => panic!("expected Number ≈ {expected}, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// NORM.DIST
// ---------------------------------------------------------------------

#[test]
fn norm_dist_cdf_at_mean_through_dispatcher_returns_half() {
    assert_close(eval("NORM.DIST(0, 0, 1, TRUE)"), 0.5);
}

#[test]
fn norm_dist_libreoffice_anchor_through_dispatcher() {
    assert_close(eval("NORM.DIST(2, 1, 2, TRUE)"), 0.691_462_461_274_013);
}

#[test]
fn norm_dist_pdf_through_dispatcher() {
    assert_close(eval("NORM.DIST(1, 0, 1, FALSE)"), 0.241_970_724_519_143_4);
}

#[test]
fn norm_dist_zero_sd_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("NORM.DIST(1, 0, 0, TRUE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// NORM.S.DIST
// ---------------------------------------------------------------------

#[test]
fn norm_s_dist_at_one_sigma_through_dispatcher() {
    // LibreOffice anchor: Φ(1) ≈ 0.841344746068542.
    assert_close(eval("NORM.S.DIST(1, TRUE)"), 0.841_344_746_068_542_9);
}

#[test]
fn norm_s_dist_pdf_at_zero_through_dispatcher() {
    // 1/√(2π) ≈ 0.39894228...
    assert_close(eval("NORM.S.DIST(0, FALSE)"), 0.398_942_280_401_432_7);
}

// ---------------------------------------------------------------------
// NORM.INV
// ---------------------------------------------------------------------

#[test]
fn norm_inv_at_half_through_dispatcher_returns_mean() {
    assert_close(eval("NORM.INV(0.5, 5, 2)"), 5.0);
}

#[test]
fn norm_inv_ci_upper_through_dispatcher() {
    // LibreOffice anchor: NORM.INV(0.975, 0, 1) ≈ 1.95996398.
    assert_close(eval("NORM.INV(0.975, 0, 1)"), 1.959_963_984_540_054);
}

#[test]
fn norm_inv_zero_prob_through_dispatcher_returns_num_error() {
    assert_eq!(eval("NORM.INV(0, 0, 1)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// NORM.S.INV
// ---------------------------------------------------------------------

#[test]
fn norm_s_inv_at_half_through_dispatcher_returns_zero() {
    assert_close(eval("NORM.S.INV(0.5)"), 0.0);
}

#[test]
fn norm_s_inv_ci_upper_through_dispatcher() {
    assert_close(eval("NORM.S.INV(0.975)"), 1.959_963_984_540_054);
}

#[test]
fn norm_s_inv_one_prob_through_dispatcher_returns_num_error() {
    assert_eq!(eval("NORM.S.INV(1)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// Cross-cutting: dotted-name parsing + case-insensitive registry lookup
// ---------------------------------------------------------------------

#[test]
fn norm_dist_case_insensitive_lookup_works() {
    // Lowercase / mixed-case names round-trip through case-insensitive
    // registry lookup correctly.
    assert_close(eval("norm.dist(0, 0, 1, TRUE)"), 0.5);
    assert_close(eval("Norm.Dist(0, 0, 1, TRUE)"), 0.5);
}

#[test]
fn norm_s_inv_arity_mismatch_through_dispatcher_returns_value() {
    // **W5-D-1.1 (Opus HIGH-O-1 closure):** arity mismatch returns
    // `#VALUE!` per codebase convention (vs `#N/A` IronCalc divergence).
    // 0 args → #VALUE!.
    assert_eq!(eval("NORM.S.INV()"), Value::Error(ErrorValue::Value));
}
