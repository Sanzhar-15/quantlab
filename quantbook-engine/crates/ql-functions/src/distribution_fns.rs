//! Statistical distribution functions (Wave 3 distributions batch).
//!
//! - **W5-D-1**: NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV —
//!   normal-distribution PDF / CDF / inverse-CDF.
//! - **W5-D-2 (this commit)**: T.DIST / T.DIST.2T / T.DIST.RT / T.INV /
//!   T.INV.2T — Student's t-distribution variants.
//!
//! ## Implementation strategy
//!
//! Numerical kernel uses `statrs` (pinned to 0.18.0 in workspace deps
//! — matches IronCalc's pin):
//!
//! - **NORM.\*** → `statrs::distribution::Normal`
//! - **T.\*** → `statrs::distribution::StudentsT` (location=0, scale=1,
//!   freedom=df)
//!
//! For inputs that successfully coerce to identical f64 tuples, our
//! `dist.pdf(x)` / `dist.cdf(x)` / `dist.inverse_cdf(p)` calls produce
//! results bit-identical to IronCalc's. **The coercion frontend,
//! however, diverges deliberately from IronCalc — see "IronCalc
//! divergences" below.**
//!
//! ## Excel canon (verified against Microsoft docs + LibreOffice 7.6)
//!
//! **W5-D-1 (normal):**
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
//! **W5-D-2 (Student's t):**
//!
//! - `T.DIST(x, deg_freedom, cumulative)` — 3 args. `cumulative=TRUE`
//!   gives left-tailed CDF; `FALSE` gives PDF. `df` truncated to
//!   integer; `df >= 1` else `#NUM!`.
//! - `T.DIST.2T(x, deg_freedom)` — 2 args. Two-tailed `P(|T| >= x)` =
//!   `2 * (1 - CDF(x))`. `x >= 0` (Microsoft canon) AND `df >= 1` else
//!   `#NUM!`. Result clamped to `[0, 1]` (defensive against
//!   floating-point overshoot near the tails).
//! - `T.DIST.RT(x, deg_freedom)` — 2 args. Right-tailed `P(T >= x)` =
//!   `1 - CDF(x)`. Negative `x` is **allowed** (unlike T.DIST.2T).
//!   `df >= 1` else `#NUM!`.
//! - `T.INV(probability, deg_freedom)` — 2 args. Left-tailed inverse
//!   CDF. `0 < p < 1` STRICT (both endpoints excluded); `df >= 1`.
//!   Else `#NUM!`.
//! - `T.INV.2T(probability, deg_freedom)` — 2 args. Two-tailed inverse,
//!   returns `|x|` such that `P(|T| >= x) = p`. Inverts via
//!   `CDF⁻¹(1 - p/2).abs()`. `0 < p <= 1` (upper-inclusive per
//!   Microsoft + IronCalc canon); `df >= 1`. Else `#NUM!`.
//!
//! ## Arg coercion
//!
//! Numeric args (`x`, `mean`, `sd`, `prob`, `deg_freedom`) are coerced
//! via `ql_types::coercion::to_number_strict` — `Blank → 0`, `Number →
//! n`, `Boolean → 0/1`, `Text → #VALUE!`, `Error → propagate`. The
//! `cumulative` flag uses `to_logical` — `Number → n != 0`,
//! `Boolean → b`, `Text "true"/"false"` (case-fold + trim) `→ bool`,
//! else `#VALUE!`. Arity mismatch → `#VALUE!` (codebase convention,
//! W5-D-1.1 closure of Opus HIGH-O-1; matches the 132 other arity
//! checks in scalar/range/financial/date/array fns).
//!
//! **W5-D-2 (T.\* fns)** additionally truncate `deg_freedom` to an
//! integer via `.trunc()` before the `df >= 1` pre-check (Microsoft +
//! IronCalc canon: `df=10.9` behaves identically to `df=10`). Per
//! IronCalc canon: T.DIST.2T clamps results to `[0, 1]` (defensive
//! against fp overshoot near tails); T.DIST.RT rejects negative
//! results (`1 - cdf(x)` can drift slightly negative for extreme `x`);
//! T.INV.2T returns `.abs()` of the inverse-CDF result (defensive
//! given the strict `p > 0` domain check, since `target_cdf = 1 - p/2`
//! is always `>= 0.5` ⇒ `inverse_cdf` always returns `>= 0`).
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

use statrs::distribution::{Continuous, ContinuousCDF, Normal, StudentsT};

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
// W5-D-2: Student's t-distribution (T.DIST / T.DIST.2T / T.DIST.RT /
// T.INV / T.INV.2T)
// =====================================================================
//
// `statrs::StudentsT::new(location, scale, freedom)` parameterizes the
// distribution; T.* always uses location=0, scale=1, freedom=df. Excel
// canon truncates `df` to an integer (.trunc()) per IronCalc + Microsoft
// docs.

/// Build a Student's t-distribution with `df` degrees of freedom.
/// statrs only rejects NaN params or `freedom <= 0`. Call sites
/// pre-check `df >= 1.0` (Excel canon) AND coercion rejects NaN, so
/// construction cannot fail in our flow. `.expect()` per the No-Fallbacks
/// rule (W5-D-1.1 closure pattern).
fn students_t_with(df: f64) -> StudentsT {
    StudentsT::new(0.0, 1.0, df)
        .expect("upstream sanitize_f64 + df >= 1 pre-check guarantee StudentsT::new succeeds")
}

/// **T.DIST(x, deg_freedom, cumulative)** — Student's t PDF (`cumulative=
/// FALSE`) or left-tailed CDF (`cumulative=TRUE`).
///
/// - Args: 3 required.
/// - `deg_freedom` truncated to integer; must be `>= 1` else `#NUM!`.
/// - IronCalc + Microsoft canon: 3-arg variant returns left-tailed CDF
///   when `cumulative=TRUE`. (Different from T.DIST.RT / T.DIST.2T below.)
pub fn t_dist(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[2]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if df < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = students_t_with(df);
    finite_or_num(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

/// **T.DIST.2T(x, deg_freedom)** — two-tailed Student's t probability
/// `P(|T| >= x)` = `2 * P(T >= x)` = `2 * (1 - CDF(x))`.
///
/// - Args: 2 required.
/// - `x >= 0` else `#NUM!` (the two-tailed test is symmetric; negative
///   `x` is ill-defined per Microsoft + IronCalc canon).
/// - `df >= 1` else `#NUM!`.
/// - Result clamped to `[0, 1]` per IronCalc (defensive against
///   floating-point overshoot near the tails).
pub fn t_dist_2t(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 || df < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = students_t_with(df);
    let upper_tail = 1.0 - dist.cdf(x);
    // **W5-D-2.1 (Opus LOW-O-3 note):** Per IronCalc + Excel canon: silently
    // clamp rather than `#NUM!` on near-boundary overshoot. statrs's
    // cdf is well-bounded in [0, 1] (verified in statrs 0.18.0 source);
    // this clamp never fires in practice but is defensive against
    // future statrs regressions in the far tails. Aligning with Excel
    // canon is the right call here even though strict reading of the
    // CLAUDE.md No-Fallbacks rule would prefer surfacing a `#NUM!`.
    let result = (2.0 * upper_tail).clamp(0.0, 1.0);
    finite_or_num(result)
}

/// **T.DIST.RT(x, deg_freedom)** — right-tailed Student's t probability
/// `P(T >= x)` = `1 - CDF(x)`.
///
/// - Args: 2 required.
/// - `df >= 1` else `#NUM!`.
/// - Unlike T.DIST.2T, `x` may be negative — `T.DIST.RT(-1, df)` is
///   the right-tail at `-1`, i.e., greater than the left half of the
///   distribution.
pub fn t_dist_rt(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if df < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = students_t_with(df);
    let result = 1.0 - dist.cdf(x);
    // **W5-D-2.1 (Opus LOW-O-2 note):** Cannot use `finite_or_num` here
    // — the IronCalc canon requires the additional `result < 0.0`
    // defensive check that the shared helper doesn't have. Adding it
    // to `finite_or_num` would change behavior for all distribution-fn
    // callers, so the inline check is the right scoping.
    if !result.is_finite() || result < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(result)
}

/// **T.INV(probability, deg_freedom)** — left-tailed inverse Student's
/// t CDF.
///
/// - Args: 2 required.
/// - `0 < probability < 1` strict, `df >= 1`. Else `#NUM!`.
pub fn t_inv(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if p <= 0.0 || p >= 1.0 || df < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = students_t_with(df);
    finite_or_num(dist.inverse_cdf(p))
}

/// **T.INV.2T(probability, deg_freedom)** — two-tailed inverse Student's
/// t. Returns the positive `x` such that `P(|T| >= x) = probability`.
///
/// - Args: 2 required.
/// - `0 < probability <= 1` (note: `p = 1` accepted, gives `x = 0`).
///   `df >= 1`. Else `#NUM!`.
/// - Inverts `2 * (1 - CDF(x)) = p` ⇒ `CDF(x) = 1 - p/2`. Returns
///   `|x|` to match the two-tailed sign convention.
pub fn t_inv_2t(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    // Note: IronCalc accepts p == 1.0 (inclusive on upper end) and
    // rejects p == 0.0 (exclusive on lower end). Matches Microsoft canon.
    if p <= 0.0 || p > 1.0 || df < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = students_t_with(df);
    let target_cdf = 1.0 - p / 2.0;
    // **W5-D-2.1 (Opus LOW-O-4 note):** `.abs()` is defensive — given
    // the strict `p > 0` AND `p <= 1` domain check above, `target_cdf
    // = 1 - p/2` is always in `[0.5, 1)` so `inverse_cdf(target_cdf)`
    // is always `>= 0` (Student's t is symmetric around 0; cdf(0) =
    // 0.5; inverse-cdf monotonic). In the valid domain `.abs()` is a
    // no-op. Retained for parity with IronCalc + as forward-compat
    // armor against future statrs precision regressions near
    // target_cdf=0.5.
    finite_or_num(dist.inverse_cdf(target_cdf).abs())
}

// =====================================================================
// Tests — ≥8 per fn per design § 7 audit-discipline MEDIUM-δ pattern.
// LibreOffice 7.6 cross-checks: anchor values verified against
// LibreOffice's NORM.* / T.* identical-named fns.
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

    // ===== T.DIST =====
    //
    // LibreOffice 7.6 and Microsoft Excel anchor values cross-checked
    // against the canonical Student's t formulas (closed-form values for
    // df=1 are exact: pdf(t) = 1/(π(1+t²)), cdf(t) = ½ + (1/π)arctan(t)).

    #[test]
    fn t_dist_cdf_at_zero_returns_half_for_any_df() {
        // Symmetry of Student's t around 0: CDF(0) = 0.5 for any df.
        assert_close(
            t_dist(&[Value::number(0.0), Value::number(1.0), Value::Boolean(true)]),
            0.5,
        );
        assert_close(
            t_dist(&[
                Value::number(0.0),
                Value::number(30.0),
                Value::Boolean(true),
            ]),
            0.5,
        );
    }

    #[test]
    fn t_dist_pdf_at_zero_df_one_libreoffice_anchor() {
        // For df=1 (Cauchy), pdf(0) = 1/π ≈ 0.318309886183790...
        assert_close(
            t_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            std::f64::consts::FRAC_1_PI,
        );
    }

    #[test]
    fn t_dist_cdf_at_one_df_one_libreoffice_anchor() {
        // For df=1, cdf(1) = ½ + (1/π)·arctan(1) = 0.5 + 0.25 = 0.75.
        assert_close(
            t_dist(&[Value::number(1.0), Value::number(1.0), Value::Boolean(true)]),
            0.75,
        );
    }

    #[test]
    fn t_dist_pdf_at_one_df_one_libreoffice_anchor() {
        // For df=1, pdf(1) = 1/(π(1+1)) = 1/(2π) ≈ 0.159154943091895...
        assert_close(
            t_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            0.5 / std::f64::consts::PI,
        );
    }

    #[test]
    fn t_dist_df_truncates_fractional() {
        // df=10.9 truncates to 10 — same result as df=10 exact.
        let a = t_dist(&[
            Value::number(1.5),
            Value::number(10.9),
            Value::Boolean(true),
        ]);
        let b = t_dist(&[
            Value::number(1.5),
            Value::number(10.0),
            Value::Boolean(true),
        ]);
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => assert!(approx(x, y, 1e-15)),
            other => panic!("expected matching numbers, got {other:?}"),
        }
    }

    #[test]
    fn t_dist_df_less_than_one_is_num_error() {
        // df=0 (trunc of 0.9 is 0) → #NUM!.
        assert_eq!(
            t_dist(&[Value::number(1.0), Value::number(0.9), Value::Boolean(true)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_dist_text_arg_is_value_error() {
        assert_eq!(
            t_dist(&[
                Value::text("abc"),
                Value::number(10.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_dist_error_arg_propagates() {
        // Distinguishable error (#REF!) to prove propagation, not domain.
        assert_eq!(
            t_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(10.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn t_dist_arity_mismatch_returns_value() {
        // **W5-D-2.1 (Opus LOW-O-1 closure):** cover both under- and
        // over-arity. The arity check is symmetric, but matching the
        // W5-D-1 NORM.* test-shape convention.
        assert_eq!(t_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            t_dist(&[Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            t_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_dist_converges_to_normal_at_large_df() {
        // As df→∞, T converges to standard normal.
        // T.DIST(1, 10000, TRUE) ≈ NORM.S.DIST(1, TRUE) ≈ 0.8413447...
        let result = t_dist(&[
            Value::number(1.0),
            Value::number(10_000.0),
            Value::Boolean(true),
        ]);
        match result {
            Value::Number(n) => assert!(
                approx(n, 0.841_344_746_068_543, 1e-4),
                "T.DIST(1, 10000, TRUE) should ≈ Φ(1), got {n}"
            ),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    // ===== T.DIST.2T =====

    #[test]
    fn t_dist_2t_at_zero_returns_one() {
        // P(|T| >= 0) = 1.
        assert_close(t_dist_2t(&[Value::number(0.0), Value::number(10.0)]), 1.0);
    }

    #[test]
    fn t_dist_2t_at_one_df_one_libreoffice_anchor() {
        // For df=1, P(|T|>=1) = 2·(1-cdf(1)) = 2·0.25 = 0.5.
        assert_close(t_dist_2t(&[Value::number(1.0), Value::number(1.0)]), 0.5);
    }

    #[test]
    fn t_dist_2t_negative_x_is_num_error() {
        // x must be >= 0 per Microsoft canon.
        assert_eq!(
            t_dist_2t(&[Value::number(-0.5), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_dist_2t_df_less_than_one_is_num_error() {
        assert_eq!(
            t_dist_2t(&[Value::number(1.0), Value::number(0.5)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_dist_2t_text_arg_is_value_error() {
        assert_eq!(
            t_dist_2t(&[Value::text("nope"), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_dist_2t_error_arg_propagates() {
        assert_eq!(
            t_dist_2t(&[Value::Error(ErrorValue::DivZero), Value::number(10.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn t_dist_2t_arity_mismatch_returns_value() {
        assert_eq!(t_dist_2t(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            t_dist_2t(&[Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            t_dist_2t(&[Value::number(1.0), Value::number(10.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_dist_2t_far_tail_in_unit_range() {
        // **W5-D-2.1 (Opus LOW-O-6 rename):** for `T.DIST.2T(50, 2)`,
        // statrs's `1 - cdf(50)` is small but well-defined (~1.96e-4),
        // so `2 * upper_tail ≈ 3.92e-4` — the clamp doesn't actually
        // fire here. This test pins the **invariant** (result in
        // `[0, 1]`) rather than the clamp-firing condition (which
        // requires an extreme input where statrs's cdf overshoots
        // [0, 1] — no portable input exists for that today).
        let result = t_dist_2t(&[Value::number(50.0), Value::number(2.0)]);
        match result {
            Value::Number(n) => {
                assert!((0.0..=1.0).contains(&n), "result {n} must be in [0,1]");
            }
            other => panic!("expected Number, got {other:?}"),
        }
    }

    // ===== T.DIST.RT =====

    #[test]
    fn t_dist_rt_at_zero_returns_half() {
        // P(T >= 0) = 0.5 by symmetry.
        assert_close(t_dist_rt(&[Value::number(0.0), Value::number(10.0)]), 0.5);
    }

    #[test]
    fn t_dist_rt_at_one_df_one_libreoffice_anchor() {
        // For df=1, P(T>=1) = 1 - 0.75 = 0.25.
        assert_close(t_dist_rt(&[Value::number(1.0), Value::number(1.0)]), 0.25);
    }

    #[test]
    fn t_dist_rt_negative_x_above_half() {
        // T.DIST.RT(-1, 1) = 1 - cdf(-1) = 1 - 0.25 = 0.75. Negative x
        // is allowed (unlike T.DIST.2T).
        assert_close(t_dist_rt(&[Value::number(-1.0), Value::number(1.0)]), 0.75);
    }

    #[test]
    fn t_dist_rt_df_less_than_one_is_num_error() {
        assert_eq!(
            t_dist_rt(&[Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_dist_rt_text_arg_is_value_error() {
        assert_eq!(
            t_dist_rt(&[Value::number(1.0), Value::text("ten")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_dist_rt_error_arg_propagates() {
        assert_eq!(
            t_dist_rt(&[Value::Error(ErrorValue::Ref), Value::number(10.0)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn t_dist_rt_arity_mismatch_returns_value() {
        // **W5-D-2.1 (Opus LOW-O-1 closure):** cover both under- and
        // over-arity per W5-D-1 NORM.* convention.
        assert_eq!(t_dist_rt(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            t_dist_rt(&[Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            t_dist_rt(&[Value::number(1.0), Value::number(10.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_dist_rt_inverse_of_t_dist_round_trip() {
        // Round-trip: t_dist_rt(x, df) + t_dist(x, df, TRUE) = 1.0
        let x = 1.234;
        let df = 7.0;
        let cdf = match t_dist(&[Value::number(x), Value::number(df), Value::Boolean(true)]) {
            Value::Number(n) => n,
            other => panic!("CDF returned {other:?}"),
        };
        let rt = match t_dist_rt(&[Value::number(x), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("RT returned {other:?}"),
        };
        assert!(approx(cdf + rt, 1.0, 1e-12));
    }

    // ===== T.INV =====

    #[test]
    fn t_inv_at_half_returns_zero() {
        assert_close(t_inv(&[Value::number(0.5), Value::number(10.0)]), 0.0);
    }

    #[test]
    fn t_inv_at_975_pct_df_10_libreoffice_anchor() {
        // T.INV(0.975, 10) ≈ 2.228138851...
        assert_close(
            t_inv(&[Value::number(0.975), Value::number(10.0)]),
            2.228_138_851_938_055,
        );
    }

    #[test]
    fn t_inv_inverse_of_t_dist_round_trip() {
        // Round-trip: t_dist(t_inv(p, df), df, TRUE) = p.
        let p = 0.83;
        let df = 5.0;
        let t = match t_inv(&[Value::number(p), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("T.INV returned {other:?}"),
        };
        let p_back = match t_dist(&[Value::number(t), Value::number(df), Value::Boolean(true)]) {
            Value::Number(n) => n,
            other => panic!("T.DIST returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn t_inv_at_zero_prob_is_num_error() {
        assert_eq!(
            t_inv(&[Value::number(0.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_inv_at_one_prob_is_num_error() {
        // T.INV's domain is strictly (0, 1) — both endpoints excluded.
        assert_eq!(
            t_inv(&[Value::number(1.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_inv_df_less_than_one_is_num_error() {
        assert_eq!(
            t_inv(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_inv_text_arg_is_value_error() {
        assert_eq!(
            t_inv(&[Value::text("half"), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_inv_error_arg_propagates() {
        assert_eq!(
            t_inv(&[Value::Error(ErrorValue::Ref), Value::number(10.0)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn t_inv_arity_mismatch_returns_value() {
        // **W5-D-2.1 (Opus LOW-O-1 closure):** cover both under- and
        // over-arity per W5-D-1 NORM.* convention.
        assert_eq!(t_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            t_inv(&[Value::number(0.5)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            t_inv(&[Value::number(0.5), Value::number(10.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== T.INV.2T =====

    #[test]
    fn t_inv_2t_at_p_one_returns_zero() {
        // T.INV.2T(1, df) = 0 (p=1 boundary case is accepted per IronCalc;
        // inverse_cdf(0.5) = 0).
        assert_close(t_inv_2t(&[Value::number(1.0), Value::number(10.0)]), 0.0);
    }

    #[test]
    fn t_inv_2t_at_05_df_30_libreoffice_anchor() {
        // T.INV.2T(0.05, 30) ≈ 2.04227245630... (standard 5% two-tailed
        // critical value for df=30, used pervasively in stats).
        assert_close(
            t_inv_2t(&[Value::number(0.05), Value::number(30.0)]),
            2.042_272_456_301_236,
        );
    }

    #[test]
    fn t_inv_2t_inverse_of_t_dist_2t_round_trip() {
        // Round-trip: t_dist_2t(t_inv_2t(p, df), df) = p.
        let p = 0.05;
        let df = 20.0;
        let crit = match t_inv_2t(&[Value::number(p), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("T.INV.2T returned {other:?}"),
        };
        let p_back = match t_dist_2t(&[Value::number(crit), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("T.DIST.2T returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn t_inv_2t_returns_positive_value() {
        // T.INV.2T always returns the positive (absolute-value) critical.
        let result = t_inv_2t(&[Value::number(0.1), Value::number(15.0)]);
        match result {
            Value::Number(n) => assert!(n > 0.0, "expected positive, got {n}"),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn t_inv_2t_at_zero_prob_is_num_error() {
        // p=0 is strictly excluded (would correspond to infinity).
        assert_eq!(
            t_inv_2t(&[Value::number(0.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_inv_2t_above_one_prob_is_num_error() {
        // p > 1 is outside the probability domain.
        assert_eq!(
            t_inv_2t(&[Value::number(1.5), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_inv_2t_df_less_than_one_is_num_error() {
        assert_eq!(
            t_inv_2t(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn t_inv_2t_text_arg_is_value_error() {
        assert_eq!(
            t_inv_2t(&[Value::text("nope"), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn t_inv_2t_error_arg_propagates() {
        assert_eq!(
            t_inv_2t(&[Value::Error(ErrorValue::DivZero), Value::number(10.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn t_inv_2t_arity_mismatch_returns_value() {
        assert_eq!(t_inv_2t(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            t_inv_2t(&[Value::number(0.5)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            t_inv_2t(&[Value::number(0.5), Value::number(10.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }
}
