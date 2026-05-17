//! Statistical distribution functions (Wave 3 distributions batch).
//!
//! - **W5-D-1 (this commit)**: NORM.DIST / NORM.S.DIST / NORM.INV /
//!   NORM.S.INV — normal-distribution PDF / CDF / inverse-CDF.
//!
//! ## Implementation strategy
//!
//! Numerical kernel reuses `statrs::distribution::Normal` (pinned to
//! 0.18.0 in workspace deps — matches IronCalc's pin). For inputs that
//! successfully coerce to identical f64 triples (mean, sd, x/prob),
//! our `dist.pdf(x)` / `dist.cdf(x)` / `dist.inverse_cdf(p)` calls
//! produce results bit-identical to IronCalc's. **The coercion
//! frontend, however, diverges deliberately from IronCalc — see
//! "IronCalc divergences" below.**
//!
//! ## Excel canon (verified against Microsoft docs + LibreOffice 7.6)
//!
//! - `NORM.DIST(x, mean, sd, cumulative)` — 4 args. `cumulative=TRUE`
//!   gives CDF; `FALSE` gives PDF. `sd > 0` else `#NUM!`.
//! - `NORM.S.DIST(z, cumulative)` — 2 args. Standard normal (mean=0,
//!   sd=1). `cumulative=TRUE` gives CDF; `FALSE` gives PDF.
//! - `NORM.INV(prob, mean, sd)` — 3 args. Returns inverse CDF (the
//!   x-value at which the CDF equals `prob`). `0 < prob < 1` strict;
//!   `sd > 0`. Else `#NUM!`.
//! - `NORM.S.INV(prob)` — 1 arg. Standard-normal inverse CDF. Same
//!   strict domain as NORM.INV.
//!
//! ## Arg coercion
//!
//! Numeric args (`x`, `mean`, `sd`, `prob`) are coerced via
//! `ql_types::coercion::to_number_strict` — `Blank → 0`, `Number → n`,
//! `Boolean → 0/1`, `Text → #VALUE!`, `Error → propagate`. The
//! `cumulative` flag uses `to_logical` — `Number → n != 0`,
//! `Boolean → b`, `Text "true"/"false"` (case-fold + trim) `→ bool`,
//! else `#VALUE!`. Arity mismatch → `#VALUE!` (codebase convention,
//! W5-D-1.1 closure of Opus HIGH-O-1; matches the 132 other arity
//! checks in scalar/range/financial/date/array fns).
//!
//! ## IronCalc divergences (W5-D-1.1 doc closure of Opus HIGH-O-2)
//!
//! Our coercion frontend differs from IronCalc's port source on two
//! dimensions for numeric args:
//!
//! | Input | This impl (`to_number_strict`) | IronCalc (`get_number_no_bools`) | Excel canon |
//! |-------|-------------------------------|---------------------------------|------------|
//! | `Boolean(true)` | `Ok(1.0)` (accepts) | `Err(#VALUE!)` (rejects) | Coerces to `1.0` |
//! | `Text("0.5")` (parseable) | `Err(#VALUE!)` | `Ok(0.5)` (via `cast_number`) | Coerces to `0.5` |
//! | `Text("abc")` | `Err(#VALUE!)` | `Err(#VALUE!)` | `#VALUE!` |
//!
//! Net: we are **more permissive than IronCalc on Booleans** (closer
//! to Excel canon) and **more strict than IronCalc on parseable text**
//! (further from Excel canon). The latter is the broader
//! `to_number_strict` convention used by all 50+ existing scalar fns
//! that take numeric args; aligning would require a project-wide
//! coercion-policy change, out of W5-D-1 scope.
//!
//! Error-class divergence: IronCalc maps `statrs` construction failure
//! to `Error::ERROR` (= `#ERROR!`); we normalize all distribution
//! errors to `#NUM!` (closer to Excel canon).

use statrs::distribution::{Continuous, ContinuousCDF, Normal};

use ql_types::{coercion, ErrorValue, Value};

/// Standard-normal distribution constructor. Cannot fail at runtime:
/// `Normal::new(0.0, 1.0)` is a compile-time-valid call — statrs only
/// rejects NaN / non-positive sd, and `0.0` / `1.0` are neither.
///
/// **W5-D-1.1 closure (Opus MEDIUM-O-5 / CLAUDE.md "No Fallbacks"
/// rule):** the prior `map_err(|_| ErrorValue::Num)` shape made this
/// path look fallible; `.expect()` asserts the impossible-error
/// invariant explicitly. If a future statrs version tightens its
/// validation (e.g., requires sd >= MIN_POSITIVE), this `.expect()`
/// surfaces the breakage loudly rather than silently degrading to `#NUM!`.
fn standard_normal() -> Normal {
    Normal::new(0.0, 1.0).expect("Normal::new(0, 1) is statically valid")
}

/// Parameterized normal constructor. Cannot fail in our flow:
/// - `mean` comes from `to_number_strict` which rejects NaN via
///   `sanitize_f64`.
/// - `sd` comes from the same path AND the call site pre-checks `sd > 0`.
///
/// statrs's `Normal::new` rejects only `NaN` mean / `sd <= 0` — both
/// excluded by upstream invariants.
///
/// **W5-D-1.1 closure (Opus MEDIUM-O-5):** `.expect()` asserts the
/// invariant. The prior `Result` return + silent `Err → #NUM!` mapping
/// was a fallback masking an impossible state.
fn normal_with(mean: f64, sd: f64) -> Normal {
    Normal::new(mean, sd)
        .expect("upstream sanitize_f64 + sd > 0 pre-check guarantee Normal::new succeeds")
}

/// Sanitize the result: `statrs` can return `NaN`/`±Inf` for extreme
/// inputs; Excel surfaces those as `#NUM!`.
fn finite_or_num(r: f64) -> Value {
    if r.is_finite() {
        Value::number(r)
    } else {
        Value::Error(ErrorValue::Num)
    }
}

/// **NORM.DIST(x, mean, standard_dev, cumulative)** — normal distribution
/// PDF (`cumulative=FALSE`) or CDF (`cumulative=TRUE`).
///
/// - Args: 4 required.
/// - `standard_dev > 0` else `#NUM!`.
/// - Error-arg propagation: any `#REF!`, `#DIV/0!`, etc. in any arg
///   propagates as the result.
/// - Text args → `#VALUE!`. `cumulative` accepts numeric/bool/text-bool.
pub fn norm_dist(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let mean = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let sd = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[3]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if sd <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = normal_with(mean, sd);
    finite_or_num(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

/// **NORM.S.DIST(z, cumulative)** — standard normal (mean=0, sd=1) PDF
/// or CDF.
///
/// - Args: 2 required.
/// - Same coercion + error-prop pattern as NORM.DIST.
pub fn norm_s_dist(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let z = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[1]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    let dist = standard_normal();
    finite_or_num(if cumulative { dist.cdf(z) } else { dist.pdf(z) })
}

/// **NORM.INV(probability, mean, standard_dev)** — inverse normal CDF.
/// Returns the x-value at which the CDF equals `probability`.
///
/// - Args: 3 required.
/// - `0 < probability < 1` strict; `standard_dev > 0`. Else `#NUM!`.
/// - IronCalc canon: probability outside (0, 1) including the endpoints
///   → `#NUM!`. Excel: same.
pub fn norm_inv(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let mean = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let sd = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if p <= 0.0 || p >= 1.0 || sd <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = normal_with(mean, sd);
    finite_or_num(dist.inverse_cdf(p))
}

/// **NORM.S.INV(probability)** — standard-normal inverse CDF.
///
/// - Args: 1 required.
/// - `0 < probability < 1` strict. Else `#NUM!`.
pub fn norm_s_inv(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if p <= 0.0 || p >= 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = standard_normal();
    finite_or_num(dist.inverse_cdf(p))
}

// =====================================================================
// Tests — ≥8 per fn per design § 7 audit-discipline MEDIUM-δ pattern.
// LibreOffice 7.6 cross-checks: anchor values verified against
// LibreOffice's NORM.* identical-named fns.
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Approximate-equality helper for f64 distribution-result tests.
    /// Excel-grade NORM.* typically agrees to ≥10 significant figures
    /// via statrs; we accept 1e-9 relative as a tight bound.
    fn approx(a: f64, b: f64, eps: f64) -> bool {
        if a == b {
            return true;
        }
        let denom = a.abs().max(b.abs()).max(1.0);
        ((a - b) / denom).abs() < eps
    }

    fn assert_close(got: Value, expected: f64) {
        match got {
            Value::Number(n) => assert!(
                approx(n, expected, 1e-9),
                "expected ≈ {expected}, got {n} (diff = {})",
                (n - expected).abs()
            ),
            other => panic!("expected Number ≈ {expected}, got {other:?}"),
        }
    }

    // ===== NORM.DIST =====

    #[test]
    fn norm_dist_cdf_at_mean_returns_half() {
        // NORM.DIST(0, 0, 1, TRUE) = 0.5 (CDF at mean).
        assert_close(
            norm_dist(&[
                Value::number(0.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            0.5,
        );
    }

    #[test]
    fn norm_dist_pdf_at_mean_returns_inv_sqrt_2pi() {
        // NORM.DIST(0, 0, 1, FALSE) = 1/sqrt(2π) ≈ 0.39894228...
        assert_close(
            norm_dist(&[
                Value::number(0.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            0.398_942_280_401_432_7,
        );
    }

    #[test]
    fn norm_dist_libreoffice_anchor_x_1_sd_2() {
        // LibreOffice cross-check: NORM.DIST(2, 1, 2, TRUE) ≈ 0.691462...
        // (Φ((2-1)/2) = Φ(0.5)).
        assert_close(
            norm_dist(&[
                Value::number(2.0),
                Value::number(1.0),
                Value::number(2.0),
                Value::Boolean(true),
            ]),
            0.691_462_461_274_013,
        );
    }

    #[test]
    fn norm_dist_pdf_libreoffice_anchor() {
        // NORM.DIST(1, 0, 1, FALSE) = (1/sqrt(2π)) * exp(-0.5) ≈ 0.241970...
        assert_close(
            norm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            0.241_970_724_519_143_4,
        );
    }

    #[test]
    fn norm_dist_zero_sd_is_num_error() {
        assert_eq!(
            norm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(0.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_dist_negative_sd_is_num_error() {
        assert_eq!(
            norm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(-1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_dist_text_arg_is_value_error() {
        assert_eq!(
            norm_dist(&[
                Value::Text("x".into()),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn norm_dist_error_arg_propagates() {
        assert_eq!(
            norm_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn norm_dist_arity_mismatch_returns_value() {
        assert_eq!(
            norm_dist(&[Value::number(0.0), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(norm_dist(&[]), Value::Error(ErrorValue::Value));
    }

    // ===== NORM.S.DIST =====

    #[test]
    fn norm_s_dist_cdf_at_zero_returns_half() {
        // NORM.S.DIST(0, TRUE) = 0.5.
        assert_close(
            norm_s_dist(&[Value::number(0.0), Value::Boolean(true)]),
            0.5,
        );
    }

    #[test]
    fn norm_s_dist_pdf_at_zero_returns_inv_sqrt_2pi() {
        assert_close(
            norm_s_dist(&[Value::number(0.0), Value::Boolean(false)]),
            0.398_942_280_401_432_7,
        );
    }

    #[test]
    fn norm_s_dist_cdf_at_one_sigma_libreoffice_anchor() {
        // LibreOffice cross-check: NORM.S.DIST(1, TRUE) ≈ 0.841345 (Φ(1)).
        assert_close(
            norm_s_dist(&[Value::number(1.0), Value::Boolean(true)]),
            0.841_344_746_068_542_9,
        );
    }

    #[test]
    fn norm_s_dist_cdf_at_neg_two_libreoffice_anchor() {
        // NORM.S.DIST(-2, TRUE) ≈ 0.0227501 (Φ(-2)).
        assert_close(
            norm_s_dist(&[Value::number(-2.0), Value::Boolean(true)]),
            0.022_750_131_948_179_22,
        );
    }

    #[test]
    fn norm_s_dist_cdf_at_extreme_positive_is_close_to_one() {
        // Φ(8) is effectively 1.0 (≈ 1 - 6e-16). Sanity check.
        let v = norm_s_dist(&[Value::number(8.0), Value::Boolean(true)]);
        match v {
            Value::Number(n) => assert!((1.0 - n).abs() < 1e-13, "Φ(8) should be ≈ 1, got {n}"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn norm_s_dist_text_arg_is_value_error() {
        assert_eq!(
            norm_s_dist(&[Value::Text("x".into()), Value::Boolean(true)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn norm_s_dist_error_arg_propagates() {
        assert_eq!(
            norm_s_dist(&[Value::Error(ErrorValue::DivZero), Value::Boolean(true)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn norm_s_dist_arity_mismatch_returns_value() {
        assert_eq!(
            norm_s_dist(&[Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            norm_s_dist(&[Value::number(0.0), Value::Boolean(true), Value::number(1.0),]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== NORM.INV =====

    #[test]
    fn norm_inv_at_half_returns_mean() {
        // NORM.INV(0.5, 5, 2) = 5 (inverse CDF of 0.5 is the mean).
        assert_close(
            norm_inv(&[Value::number(0.5), Value::number(5.0), Value::number(2.0)]),
            5.0,
        );
    }

    #[test]
    fn norm_inv_libreoffice_anchor_at_975_pct() {
        // LibreOffice cross-check: NORM.INV(0.975, 0, 1) ≈ 1.95996398 (95% CI upper).
        assert_close(
            norm_inv(&[Value::number(0.975), Value::number(0.0), Value::number(1.0)]),
            1.959_963_984_540_054,
        );
    }

    #[test]
    fn norm_inv_inverse_of_norm_dist_round_trip() {
        // NORM.INV(NORM.DIST(x, 0, 1, TRUE), 0, 1) ≈ x.
        let x = 1.7;
        let p = norm_dist(&[
            Value::number(x),
            Value::number(0.0),
            Value::number(1.0),
            Value::Boolean(true),
        ]);
        let p = match p {
            Value::Number(n) => n,
            other => panic!("expected Number, got {other:?}"),
        };
        assert_close(
            norm_inv(&[Value::number(p), Value::number(0.0), Value::number(1.0)]),
            x,
        );
    }

    #[test]
    fn norm_inv_at_zero_prob_is_num_error() {
        assert_eq!(
            norm_inv(&[Value::number(0.0), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_inv_at_one_prob_is_num_error() {
        assert_eq!(
            norm_inv(&[Value::number(1.0), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_inv_negative_prob_is_num_error() {
        assert_eq!(
            norm_inv(&[Value::number(-0.1), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_inv_zero_sd_is_num_error() {
        assert_eq!(
            norm_inv(&[Value::number(0.5), Value::number(0.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_inv_text_arg_is_value_error() {
        // **Codex LOW-2 closure:** NORM.INV with any text arg → #VALUE!.
        // Other 3 NORM.* fns have analogous tests; this fills the gap.
        assert_eq!(
            norm_inv(&[
                Value::Text("0.5".into()),
                Value::number(0.0),
                Value::number(1.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn norm_inv_error_arg_propagates() {
        assert_eq!(
            norm_inv(&[
                Value::Error(ErrorValue::Ref),
                Value::number(0.0),
                Value::number(1.0)
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn norm_inv_arity_mismatch_returns_value() {
        assert_eq!(
            norm_inv(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== NORM.S.INV =====

    #[test]
    fn norm_s_inv_at_half_returns_zero() {
        assert_close(norm_s_inv(&[Value::number(0.5)]), 0.0);
    }

    #[test]
    fn norm_s_inv_at_975_pct_libreoffice_anchor() {
        // 95% CI upper z-value: ≈ 1.95996398.
        assert_close(norm_s_inv(&[Value::number(0.975)]), 1.959_963_984_540_054);
    }

    #[test]
    fn norm_s_inv_inverse_of_norm_s_dist_round_trip() {
        let z = 1.96;
        let p = norm_s_dist(&[Value::number(z), Value::Boolean(true)]);
        let p = match p {
            Value::Number(n) => n,
            other => panic!("expected Number, got {other:?}"),
        };
        assert_close(norm_s_inv(&[Value::number(p)]), z);
    }

    #[test]
    fn norm_s_inv_at_zero_prob_is_num_error() {
        assert_eq!(
            norm_s_inv(&[Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_s_inv_at_one_prob_is_num_error() {
        assert_eq!(
            norm_s_inv(&[Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_s_inv_negative_prob_is_num_error() {
        assert_eq!(
            norm_s_inv(&[Value::number(-0.5)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn norm_s_inv_text_arg_is_value_error() {
        assert_eq!(
            norm_s_inv(&[Value::Text("0.5".into())]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn norm_s_inv_error_arg_propagates() {
        // **Codex LOW-3 closure:** use a distinguishable error class
        // (`#REF!`, not `#NUM!`) so the test proves propagation rather
        // than coincidentally matching the domain-error class.
        assert_eq!(
            norm_s_inv(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn norm_s_inv_arity_mismatch_returns_value() {
        assert_eq!(norm_s_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            norm_s_inv(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }
}
