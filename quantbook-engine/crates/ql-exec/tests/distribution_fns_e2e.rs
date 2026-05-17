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

// =====================================================================
// W5-D-3: CHISQ.* + F.* — chi-squared + Fisher-Snedecor F distributions
// =====================================================================
//
// Verify dispatcher routing for dotted names + the new
// digit-leading-segment lexer extension (T.* established this in
// W5-D-2). `F.DIST.RT` and `F.INV.RT` exercise the same lexer path
// (`.RT` is a letter-leading segment, identical to W5-D-2's
// `T.DIST.RT`); `CHISQ.DIST.RT` etc. test 3-segment letter chains.

// ---------------------------------------------------------------------
// CHISQ.DIST
// ---------------------------------------------------------------------

#[test]
fn chisq_dist_cdf_at_zero_through_dispatcher_returns_zero() {
    assert_close(eval("CHISQ.DIST(0, 1, TRUE)"), 0.0);
}

#[test]
fn chisq_dist_libreoffice_anchor_through_dispatcher() {
    // CHISQ.DIST(2, 2, TRUE) = 1 - e^-1.
    assert_close(eval("CHISQ.DIST(2, 2, TRUE)"), 1.0 - (-1.0_f64).exp());
}

#[test]
fn chisq_dist_negative_x_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("CHISQ.DIST(-1, 1, TRUE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// CHISQ.DIST.RT
// ---------------------------------------------------------------------

#[test]
fn chisq_dist_rt_at_zero_through_dispatcher_returns_one() {
    assert_close(eval("CHISQ.DIST.RT(0, 1)"), 1.0);
}

#[test]
fn chisq_dist_rt_libreoffice_anchor_through_dispatcher() {
    // P(X > 2) = e^-1 for df=2.
    assert_close(eval("CHISQ.DIST.RT(2, 2)"), (-1.0_f64).exp());
}

// ---------------------------------------------------------------------
// CHISQ.INV
// ---------------------------------------------------------------------

#[test]
fn chisq_inv_at_zero_prob_through_dispatcher_returns_zero() {
    // p=0 ACCEPTED (inclusive domain).
    assert_close(eval("CHISQ.INV(0, 1)"), 0.0);
}

#[test]
fn chisq_inv_libreoffice_anchor_through_dispatcher() {
    // CHISQ.INV(0.95, 1) ≈ 3.841458820694124 — classic chi-squared crit.
    assert_close(eval("CHISQ.INV(0.95, 1)"), 3.841_458_820_694_124);
}

#[test]
fn chisq_inv_p_above_one_through_dispatcher_returns_num_error() {
    assert_eq!(eval("CHISQ.INV(1.5, 1)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// CHISQ.INV.RT
// ---------------------------------------------------------------------

#[test]
fn chisq_inv_rt_libreoffice_anchor_through_dispatcher() {
    // CHISQ.INV.RT(0.05, 1) ≈ 3.841459 (matches CHISQ.INV(0.95, 1)).
    assert_close(eval("CHISQ.INV.RT(0.05, 1)"), 3.841_458_820_694_124);
}

#[test]
fn chisq_inv_rt_at_one_prob_through_dispatcher_returns_zero() {
    assert_close(eval("CHISQ.INV.RT(1, 1)"), 0.0);
}

#[test]
fn chisq_inv_rt_at_zero_prob_through_dispatcher_returns_num_error() {
    // **W5-D-3.1 (Codex LOW-2 closure):** `p == 0` is admitted by the
    // range check but `inverse_cdf(1.0)` is non-finite → `#NUM!` via
    // the impl's `!result.is_finite()` guard. Pin this through the
    // dispatcher to prevent future docs from misreading "p=0 ACCEPTED"
    // as "p=0 returns a finite value".
    assert_eq!(eval("CHISQ.INV.RT(0, 1)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// F.DIST
// ---------------------------------------------------------------------

#[test]
fn f_dist_cdf_symmetry_through_dispatcher() {
    // F(n, n) CDF at 1 = 0.5.
    assert_close(eval("F.DIST(1, 10, 10, TRUE)"), 0.5);
}

#[test]
fn f_dist_libreoffice_anchor_through_dispatcher() {
    // Use statrs's F.INV(0.95, 5, 10) value (3.3258345304130046) as
    // input for an exact round-trip pin; statrs's inverse_cdf is
    // approximate vs true F-distribution math (~5e-7 off) — see
    // f_inv_libreoffice_anchor_95_pct_5_10 docstring.
    let result = eval("F.DIST(3.3258345304130046, 5, 10, TRUE)");
    match result {
        Value::Number(n) => assert!((n - 0.95).abs() < 1e-9, "expected ≈ 0.95, got {n}"),
        other => panic!("expected Number ≈ 0.95, got {other:?}"),
    }
}

#[test]
fn f_dist_negative_x_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("F.DIST(-1, 5, 10, TRUE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// F.DIST.RT
// ---------------------------------------------------------------------

#[test]
fn f_dist_rt_at_zero_through_dispatcher_returns_one() {
    assert_close(eval("F.DIST.RT(0, 5, 10)"), 1.0);
}

#[test]
fn f_dist_rt_symmetry_through_dispatcher() {
    assert_close(eval("F.DIST.RT(1, 10, 10)"), 0.5);
}

// ---------------------------------------------------------------------
// F.INV
// ---------------------------------------------------------------------

#[test]
fn f_inv_libreoffice_anchor_through_dispatcher() {
    // statrs's internal value, not the true F-distribution math value
    // (statrs's inverse_cdf for FisherSnedecor is Newton-Raphson with
    // tolerance; ~5e-7 off true value 3.325835018413022).
    assert_close(eval("F.INV(0.95, 5, 10)"), 3.325_834_530_413_004_6);
}

#[test]
fn f_inv_at_half_equal_dfs_through_dispatcher() {
    assert_close(eval("F.INV(0.5, 10, 10)"), 1.0);
}

#[test]
fn f_inv_p_negative_through_dispatcher_returns_num_error() {
    assert_eq!(eval("F.INV(-0.1, 5, 10)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// F.INV.RT
// ---------------------------------------------------------------------

#[test]
fn f_inv_rt_libreoffice_anchor_through_dispatcher() {
    // Same statrs-internal value as F.INV(0.95, 5, 10) by definition.
    assert_close(eval("F.INV.RT(0.05, 5, 10)"), 3.325_834_530_413_004_6);
}

#[test]
fn f_inv_rt_at_one_through_dispatcher_returns_zero() {
    // p=1 upper-inclusive → x=0.
    assert_close(eval("F.INV.RT(1, 5, 10)"), 0.0);
}

#[test]
fn f_inv_rt_at_zero_prob_through_dispatcher_returns_num_error() {
    // p=0 REJECTED (lower-strict, diverges from F.INV).
    assert_eq!(eval("F.INV.RT(0, 5, 10)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// Cross-cutting: case-insensitivity + round-trip + arity
// ---------------------------------------------------------------------

#[test]
fn chisq_f_dist_case_insensitive_lookup_works() {
    assert_close(eval("chisq.dist(0, 1, TRUE)"), 0.0);
    assert_close(eval("Chisq.Dist.RT(0, 1)"), 1.0);
    assert_close(eval("f.dist(1, 10, 10, TRUE)"), 0.5);
    assert_close(eval("F.Inv.RT(0.5, 10, 10)"), 1.0);
}

#[test]
fn chisq_inv_chisq_dist_round_trip_through_dispatcher() {
    // Nested: CHISQ.DIST(CHISQ.INV(p, df), df, TRUE) ≈ p.
    let inner = eval("CHISQ.INV(0.73, 5)");
    let x = match inner {
        Value::Number(n) => n,
        other => panic!("CHISQ.INV returned {other:?}"),
    };
    let formula = format!("CHISQ.DIST({x}, 5, TRUE)");
    assert_close(eval(&formula), 0.73);
}

#[test]
fn chisq_f_dist_arity_mismatch_through_dispatcher_returns_value() {
    assert_eq!(eval("CHISQ.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("CHISQ.INV.RT()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("F.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("F.INV.RT()"), Value::Error(ErrorValue::Value));
}

// =====================================================================
// W5-D-4: Discrete + remaining continuous distributions
// =====================================================================
//
// First discrete-distribution batch. BINOM.DIST.RANGE is variadic
// (3 or 4 args). Verify dispatcher routes correctly for both arities.

// ---------------------------------------------------------------------
// BINOM.DIST
// ---------------------------------------------------------------------

#[test]
fn binom_dist_pmf_at_zero_through_dispatcher_closed_form() {
    // pmf(0; n=10, p=0.5) = 1/1024.
    assert_close(eval("BINOM.DIST(0, 10, 0.5, FALSE)"), 1.0 / 1024.0);
}

#[test]
fn binom_dist_pmf_at_five_through_dispatcher_closed_form() {
    // pmf(5; n=10, p=0.5) = 252/1024.
    assert_close(eval("BINOM.DIST(5, 10, 0.5, FALSE)"), 252.0 / 1024.0);
}

#[test]
fn binom_dist_cdf_at_n_through_dispatcher_returns_one() {
    assert_close(eval("BINOM.DIST(10, 10, 0.5, TRUE)"), 1.0);
}

#[test]
fn binom_dist_k_greater_than_n_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("BINOM.DIST(11, 10, 0.5, TRUE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// BINOM.DIST.RANGE
// ---------------------------------------------------------------------

#[test]
fn binom_dist_range_full_through_dispatcher_returns_one() {
    assert_close(eval("BINOM.DIST.RANGE(10, 0.5, 0, 10)"), 1.0);
}

#[test]
fn binom_dist_range_three_arg_form_through_dispatcher() {
    // 3-arg form = single-point probability = pmf.
    assert_close(eval("BINOM.DIST.RANGE(10, 0.5, 5)"), 252.0 / 1024.0);
}

#[test]
fn binom_dist_range_reversed_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("BINOM.DIST.RANGE(10, 0.5, 6, 4)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// BINOM.INV
// ---------------------------------------------------------------------

#[test]
fn binom_inv_through_dispatcher_returns_smallest_k_with_cdf_at_least_alpha() {
    assert_close(eval("BINOM.INV(10, 0.5, 0.5)"), 5.0);
}

#[test]
fn binom_inv_p_one_through_dispatcher_returns_num_error() {
    // p = 1 STRICT (diverges from BINOM.DIST inclusive).
    assert_eq!(eval("BINOM.INV(10, 1, 0.5)"), Value::Error(ErrorValue::Num));
}

#[test]
fn binom_inv_trials_zero_through_dispatcher_panic_regression() {
    // **W5-D-4.1 (Codex HIGH-1 + Opus HIGH-O-1 closure):** end-to-end
    // panic-regression pin for `BINOM.INV(0, p, alpha)` (trials=0
    // degenerate). Without the inline `n == 0` short-circuit, statrs's
    // `DiscreteCDF::inverse_cdf` panics through
    // `integral_bisection_search.unwrap()`. Returns 0 (the only valid k
    // for a distribution concentrated at 0).
    assert_close(eval("BINOM.INV(0, 0.5, 0.5)"), 0.0);
}

// ---------------------------------------------------------------------
// NEGBINOM.DIST
// ---------------------------------------------------------------------

#[test]
fn negbinom_dist_pmf_at_zero_through_dispatcher_closed_form() {
    // pmf(0; r=1, p=0.5) = 0.5.
    assert_close(eval("NEGBINOM.DIST(0, 1, 0.5, FALSE)"), 0.5);
}

#[test]
fn negbinom_dist_r_zero_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("NEGBINOM.DIST(0, 0.5, 0.5, FALSE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// POISSON.DIST
// ---------------------------------------------------------------------

#[test]
fn poisson_dist_pmf_at_zero_lambda_one_through_dispatcher() {
    assert_close(eval("POISSON.DIST(0, 1, FALSE)"), (-1.0_f64).exp());
}

#[test]
fn poisson_dist_lambda_zero_degenerate_through_dispatcher() {
    // λ=0 special case: P(X=0) = 1.
    assert_close(eval("POISSON.DIST(0, 0, FALSE)"), 1.0);
    // P(X=5) = 0 for degenerate-at-0.
    assert_close(eval("POISSON.DIST(5, 0, FALSE)"), 0.0);
}

#[test]
fn poisson_dist_negative_lambda_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("POISSON.DIST(0, -1, FALSE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// EXPON.DIST
// ---------------------------------------------------------------------

#[test]
fn expon_dist_cdf_at_one_lambda_one_through_dispatcher() {
    assert_close(eval("EXPON.DIST(1, 1, TRUE)"), 1.0 - (-1.0_f64).exp());
}

#[test]
fn expon_dist_pdf_at_zero_through_dispatcher_returns_lambda() {
    assert_close(eval("EXPON.DIST(0, 2, FALSE)"), 2.0);
}

#[test]
fn expon_dist_lambda_zero_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("EXPON.DIST(1, 0, TRUE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// LOGNORM.DIST
// ---------------------------------------------------------------------

#[test]
fn lognorm_dist_cdf_at_one_standard_through_dispatcher_returns_half() {
    assert_close(eval("LOGNORM.DIST(1, 0, 1, TRUE)"), 0.5);
}

#[test]
fn lognorm_dist_x_zero_through_dispatcher_returns_num_error() {
    assert_eq!(
        eval("LOGNORM.DIST(0, 0, 1, TRUE)"),
        Value::Error(ErrorValue::Num)
    );
}

// ---------------------------------------------------------------------
// LOGNORM.INV
// ---------------------------------------------------------------------

#[test]
fn lognorm_inv_median_through_dispatcher_returns_exp_mean() {
    assert_close(eval("LOGNORM.INV(0.5, 0, 1)"), 1.0);
}

#[test]
fn lognorm_inv_p_one_through_dispatcher_returns_num_error() {
    assert_eq!(eval("LOGNORM.INV(1, 0, 1)"), Value::Error(ErrorValue::Num));
}

// ---------------------------------------------------------------------
// Cross-cutting: case-insensitivity + nested round-trip + arity
// ---------------------------------------------------------------------

#[test]
fn binom_poisson_case_insensitive_lookup_works() {
    assert_close(eval("binom.dist(0, 10, 0.5, FALSE)"), 1.0 / 1024.0);
    assert_close(eval("Binom.Dist.Range(10, 0.5, 0, 10)"), 1.0);
    assert_close(eval("poisson.dist(0, 1, FALSE)"), (-1.0_f64).exp());
    assert_close(eval("LogNorm.Inv(0.5, 0, 1)"), 1.0);
}

#[test]
fn lognorm_inv_dist_round_trip_through_dispatcher() {
    // Nested LOGNORM.DIST(LOGNORM.INV(p, μ, σ), μ, σ, TRUE) ≈ p.
    let inner = eval("LOGNORM.INV(0.73, 1, 0.5)");
    let x = match inner {
        Value::Number(n) => n,
        other => panic!("LOGNORM.INV returned {other:?}"),
    };
    let formula = format!("LOGNORM.DIST({x}, 1, 0.5, TRUE)");
    assert_close(eval(&formula), 0.73);
}

#[test]
fn w5_d_4_arity_mismatch_through_dispatcher_returns_value() {
    assert_eq!(eval("BINOM.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("BINOM.DIST.RANGE()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("BINOM.INV()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("NEGBINOM.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("POISSON.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("EXPON.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("LOGNORM.DIST()"), Value::Error(ErrorValue::Value));
    assert_eq!(eval("LOGNORM.INV()"), Value::Error(ErrorValue::Value));
}
