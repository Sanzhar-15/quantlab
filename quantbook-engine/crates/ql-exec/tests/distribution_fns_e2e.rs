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

// =====================================================================
// W5-D-2: T.* — Student's t-distribution
// =====================================================================
//
// Same shape as W5-D-1 e2e tests: confirm the dotted-name parser
// recognizes `T.DIST` / `T.DIST.2T` / `T.DIST.RT` / `T.INV` / `T.INV.2T`
// as single fn tokens (the `.2T` / `.RT` suffixes are non-trivial — they
// start with a digit / continue with letters, so the lexer must accept
// them as part of the identifier rather than splitting them).

// ---------------------------------------------------------------------
// T.DIST
// ---------------------------------------------------------------------

#[test]
fn t_dist_cdf_at_zero_through_dispatcher_returns_half() {
    assert_close(eval("T.DIST(0, 10, TRUE)"), 0.5);
}

#[test]
fn t_dist_pdf_at_zero_df_one_through_dispatcher() {
    // For df=1 (Cauchy), pdf(0) = 1/π.
    assert_close(eval("T.DIST(0, 1, FALSE)"), std::f64::consts::FRAC_1_PI);
}

#[test]
fn t_dist_df_less_than_one_through_dispatcher_returns_num_error() {
    assert_eq!(eval("T.DIST(1, 0, TRUE)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// T.DIST.2T
// ---------------------------------------------------------------------

#[test]
fn t_dist_2t_at_one_df_one_through_dispatcher() {
    // For df=1: P(|T|>=1) = 0.5.
    assert_close(eval("T.DIST.2T(1, 1)"), 0.5);
}

#[test]
fn t_dist_2t_negative_x_through_dispatcher_returns_num_error() {
    assert_eq!(eval("T.DIST.2T(-0.5, 10)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// T.DIST.RT
// ---------------------------------------------------------------------

#[test]
fn t_dist_rt_at_zero_through_dispatcher_returns_half() {
    assert_close(eval("T.DIST.RT(0, 10)"), 0.5);
}

#[test]
fn t_dist_rt_at_one_df_one_through_dispatcher() {
    // For df=1: P(T>=1) = 0.25.
    assert_close(eval("T.DIST.RT(1, 1)"), 0.25);
}

// ---------------------------------------------------------------------
// T.INV
// ---------------------------------------------------------------------

#[test]
fn t_inv_at_half_through_dispatcher_returns_zero() {
    assert_close(eval("T.INV(0.5, 10)"), 0.0);
}

#[test]
fn t_inv_libreoffice_anchor_through_dispatcher() {
    // LibreOffice anchor: T.INV(0.975, 10) ≈ 2.2281388519...
    assert_close(eval("T.INV(0.975, 10)"), 2.228_138_851_938_055);
}

#[test]
fn t_inv_zero_prob_through_dispatcher_returns_num_error() {
    assert_eq!(eval("T.INV(0, 10)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// T.INV.2T
// ---------------------------------------------------------------------

#[test]
fn t_inv_2t_libreoffice_anchor_through_dispatcher() {
    // LibreOffice anchor: T.INV.2T(0.05, 30) ≈ 2.04227245630...
    assert_close(eval("T.INV.2T(0.05, 30)"), 2.042_272_456_301_236);
}

#[test]
fn t_inv_2t_at_p_one_through_dispatcher_returns_zero() {
    // p=1 is accepted per IronCalc + Microsoft canon (upper-inclusive).
    assert_close(eval("T.INV.2T(1, 10)"), 0.0);
}

#[test]
fn t_inv_2t_above_one_prob_through_dispatcher_returns_num_error() {
    assert_eq!(eval("T.INV.2T(1.5, 10)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// Cross-cutting: case-insensitivity + dotted-suffix parsing
// ---------------------------------------------------------------------

#[test]
fn t_dist_case_insensitive_lookup_works() {
    // The `.2T` / `.RT` suffixes start with a digit / capital letter; the
    // lexer must tokenize them as part of the identifier. Verify
    // case-insensitive normalization round-trips through the registry.
    assert_close(eval("t.dist(0, 10, TRUE)"), 0.5);
    assert_close(eval("t.dist.2t(0, 10)"), 1.0);
    assert_close(eval("t.dist.rt(0, 10)"), 0.5);
    assert_close(eval("T.Inv(0.5, 10)"), 0.0);
}

#[test]
fn t_dist_arity_mismatch_through_dispatcher_returns_value() {
    // Arity mismatch — codebase convention `#VALUE!`.
    assert_eq!(eval("T.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("T.DIST.2T()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("T.INV.2T(0.5)"), Value::Error(ErrorValue::Value));
}

// ---------------------------------------------------------------------
// **W5-D-2.1 (Opus LOW-O-5 closure):** additional dispatcher coverage
// for error-class round-trips not covered above.
// ---------------------------------------------------------------------

#[test]
fn t_dist_rt_df_less_than_one_through_dispatcher_returns_num_error() {
    assert_eq!(eval("T.DIST.RT(1, 0)"), Value::Error(ErrorValue::Num));
}

#[test]
fn t_dist_rt_negative_x_through_dispatcher_returns_above_half() {
    // T.DIST.RT(-1, 1) = 0.75 — negative x is ALLOWED (unlike T.DIST.2T).
    // Pins the documented divergence between RT and 2T variants at the
    // dispatcher level.
    assert_close(eval("T.DIST.RT(-1, 1)"), 0.75);
}

#[test]
fn t_inv_p_greater_or_equal_one_through_dispatcher_returns_num_error() {
    // T.INV's domain is strict `(0, 1)` — both endpoints excluded.
    assert_eq!(eval("T.INV(1, 10)"), Value::Error(ErrorValue::Num));
}

#[test]
fn t_inv_2t_zero_prob_through_dispatcher_returns_num_error() {
    // T.INV.2T rejects p == 0 (strict lower bound).
    assert_eq!(eval("T.INV.2T(0, 10)"), Value::Error(ErrorValue::Num));
}

#[test]
fn t_inv_t_dist_round_trip_through_dispatcher() {
    // Round-trip: T.DIST(T.INV(p, df), df, TRUE) ≈ p through the
    // dispatcher chain. Verifies both fns are wired to the same
    // underlying StudentsT and that the parser doesn't mangle nested
    // function calls.
    let inner = eval("T.INV(0.83, 5)");
    let t = match inner {
        Value::Number(n) => n,
        other => panic!("T.INV returned {other:?}"),
    };
    let formula = format!("T.DIST({t}, 5, TRUE)");
    assert_close(eval(&formula), 0.83);
}
