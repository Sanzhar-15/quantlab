//! Statistical distribution functions (Wave 3 distributions batch).
//!
//! - **W5-D-1**: NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV —
//!   normal-distribution PDF / CDF / inverse-CDF.
//! - **W5-D-2**: T.DIST / T.DIST.2T / T.DIST.RT / T.INV / T.INV.2T —
//!   Student's t-distribution variants.
//! - **W5-D-3**: CHISQ.DIST / CHISQ.DIST.RT / CHISQ.INV /
//!   CHISQ.INV.RT + F.DIST / F.DIST.RT / F.INV / F.INV.RT —
//!   chi-squared and Fisher-Snedecor F distribution variants.
//! - **W5-D-4**: BINOM.DIST / BINOM.DIST.RANGE /
//!   BINOM.INV / NEGBINOM.DIST / POISSON.DIST / EXPON.DIST /
//!   LOGNORM.DIST / LOGNORM.INV — discrete (binomial + neg-binomial +
//!   Poisson) + continuous (exponential + log-normal) distributions.
//!   First discrete-distribution batch.
//! - **W5-D-5 (CLOSES Wave 3)**: GAMMA / GAMMA.DIST / GAMMA.INV /
//!   GAMMALN / GAMMALN.PRECISE / BETA.DIST / BETA.INV /
//!   CONFIDENCE.NORM / CONFIDENCE.T — gamma family (function +
//!   distribution + ln) + beta distribution (variadic with optional
//!   [A, B] bounds) + confidence-interval margins for normal +
//!   Student's t. All continuous.
//! - **W5-D-10 (this commit, Phase 4.10 V1-260 closeout)**: ERF /
//!   ERF.PRECISE / ERFC / ERFC.PRECISE — Gauss error function +
//!   complement. Companion to gamma family; closes the special-
//!   function cohort. Closed-form via `statrs::function::erf::{erf,
//!   erfc}`.
//!
//! ## Implementation strategy
//!
//! Numerical kernel uses `statrs` (pinned to 0.18.0 in workspace deps
//! — matches IronCalc's pin):
//!
//! - **NORM.\*** → `statrs::distribution::Normal`
//! - **T.\*** → `statrs::distribution::StudentsT` (location=0, scale=1,
//!   freedom=df)
//! - **CHISQ.\*** → `statrs::distribution::ChiSquared` (freedom=df)
//! - **F.\*** → `statrs::distribution::FisherSnedecor` (freedom_1=df1,
//!   freedom_2=df2)
//! - **BINOM.\*** → `statrs::distribution::Binomial` (probability=p,
//!   trials=n)
//! - **NEGBINOM.\*** → `statrs::distribution::NegativeBinomial`
//!   (successes=r, probability=p)
//! - **POISSON.\*** → `statrs::distribution::Poisson` (lambda=mean)
//! - **EXPON.\*** → closed-form (no statrs needed):
//!   CDF=`1 - exp(-λx)`, PDF=`λ·exp(-λx)`.
//! - **LOGNORM.\*** → `statrs::distribution::LogNormal` (location=mean,
//!   scale=sd) — parameters are the underlying normal's mean / sd.
//! - **GAMMA / GAMMALN / GAMMALN.PRECISE** → closed-form via
//!   `statrs::function::gamma::{gamma, ln_gamma}` (NOT
//!   distribution-backed — these are the gamma / log-gamma functions
//!   themselves, not the Gamma distribution).
//! - **GAMMA.DIST / GAMMA.INV** → `statrs::distribution::Gamma`
//!   (shape=alpha, rate=1/beta_scale). Note: statrs uses
//!   shape-rate, Excel uses shape-scale; convert at call site.
//! - **BETA.\*** → `statrs::distribution::Beta` (alpha, beta).
//!   Optional `[A, B]` bounds shift the [0, 1] standard Beta to
//!   `[A, B]` via `t = (x - A) / (B - A)`.
//! - **CONFIDENCE.NORM** → reuses NORM standard normal (W5-D-1
//!   `standard_normal()` helper). Returns
//!   `z(1 - α/2) · σ / √n` margin.
//! - **CONFIDENCE.T** → reuses StudentsT (W5-D-2 `students_t_with`)
//!   with `df = n - 1`. Returns `t_crit · σ / √n` margin.
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
//! **W5-D-3 (chi-squared):**
//!
//! - `CHISQ.DIST(x, deg_freedom, cumulative)` — 3 args. Left-tailed
//!   CDF (cumulative=TRUE) or PDF (FALSE). `x >= 0` else `#NUM!`. `df`
//!   truncated to integer; `df` in `[1, 10^10]` else `#NUM!`.
//! - `CHISQ.DIST.RT(x, deg_freedom)` — 2 args. Right-tailed `P(X > x)`
//!   via `statrs`'s survival-function `dist.sf(x)` (better numerical
//!   properties than `1 - cdf(x)` for chi-squared in the far right
//!   tail). Same domain checks as CHISQ.DIST minus `cumulative`.
//! - `CHISQ.INV(probability, deg_freedom)` — 2 args. Left-tailed
//!   inverse CDF. `0 <= p <= 1` INCLUSIVE (note: differs from
//!   T.INV/NORM.INV's strict `(0, 1)`). `df` in `[1, 10^10]`. Else
//!   `#NUM!`.
//! - `CHISQ.INV.RT(probability, deg_freedom)` — 2 args. Right-tailed
//!   inverse: solves `p = P(X > x) = 1 - CDF(x)`, returns
//!   `inverse_cdf(1 - p)`. Same domain as CHISQ.INV.
//!
//! **W5-D-3 (Fisher-Snedecor F):**
//!
//! - `F.DIST(x, deg_freedom1, deg_freedom2, cumulative)` — 4 args.
//!   Left-tailed CDF or PDF. `x >= 0`; `df1 >= 1`; `df2 >= 1`. Else
//!   `#NUM!`.
//! - `F.DIST.RT(x, deg_freedom1, deg_freedom2)` — 3 args. Right-tailed
//!   `P(F > x)` = `1 - CDF(x)`. Same domain checks as F.DIST minus
//!   `cumulative`.
//! - `F.INV(probability, deg_freedom1, deg_freedom2)` — 3 args.
//!   Left-tailed inverse CDF. `0 <= p <= 1` INCLUSIVE; `df1 >= 1`;
//!   `df2 >= 1`. Else `#NUM!`.
//! - `F.INV.RT(probability, deg_freedom1, deg_freedom2)` — 3 args.
//!   Right-tailed inverse: solves `p = P(F > x) = 1 - CDF(x)`,
//!   returns `inverse_cdf(1 - p)`. `0 < p <= 1` (lower-strict,
//!   upper-inclusive per IronCalc canon).
//!
//! **W5-D-4 (discrete + remaining continuous):**
//!
//! - `BINOM.DIST(number_s, trials, probability_s, cumulative)` — 4
//!   args. PMF (`cumulative=FALSE`) or CDF (`TRUE`).
//!   `number_s.trunc()` in `[0, trials]`; `trials.trunc() >= 0`;
//!   `0 <= p <= 1`. Else `#NUM!`. `number_s`, `trials` converted to
//!   u64 via truncation + u64::MAX bounds check.
//! - `BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])`
//!   — **VARIADIC** 3 or 4 args. Returns `P(number_s ≤ X ≤
//!   number_s2)`. When `number_s2` omitted, defaults to `number_s`
//!   (single-point probability). Same domain checks plus
//!   `number_s ≤ number_s2 ≤ trials`.
//! - `BINOM.INV(trials, probability_s, alpha)` — 3 args. Inverse via
//!   `DiscreteCDF::inverse_cdf`, returns smallest `k` such that
//!   `CDF(k) >= alpha`. `0 ≤ p ≤ 1` inclusive both (matches Microsoft
//!   canon and BINOM.DIST; W5-D-13.1 megaudit Opus MEDIUM-2 closure
//!   relaxed the prior strict-upper that incorrectly rejected p=1).
//!   `0 < alpha < 1` strict both ends. Degenerate cases short-
//!   circuited: p=0 → 0; p=1 → trials; n=0 → 0.
//! - `NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)` —
//!   4 args. PMF (`cumulative=FALSE`) or CDF (`TRUE`). `number_f >=
//!   0`, `number_s >= 1`, `0 < p < 1` strict both. statrs uses
//!   `NegativeBinomial::new(number_s, probability_s)`.
//! - `POISSON.DIST(x, mean, cumulative)` — 3 args. PMF or CDF.
//!   `x.trunc() >= 0`, `mean >= 0` (NOT strict — `mean=0` accepted,
//!   degenerate at 0). Else `#NUM!`. Special-case `mean == 0.0`
//!   handled inline (statrs rejects `Poisson::new(0.0)`).
//! - `EXPON.DIST(x, lambda, cumulative)` — 3 args. Closed-form, no
//!   statrs: `CDF = 1 - exp(-λx)`, `PDF = λ·exp(-λx)`. `x >= 0`,
//!   `lambda > 0` strict. Else `#NUM!`.
//! - `LOGNORM.DIST(x, mean, standard_dev, cumulative)` — 4 args. PDF
//!   or CDF. `x > 0` STRICT (log-normal undefined at 0); `sd > 0`
//!   strict. `mean` is the underlying normal's mean (can be negative).
//! - `LOGNORM.INV(probability, mean, standard_dev)` — 3 args. Inverse
//!   CDF. `0 < p < 1` strict both; `sd > 0`.
//!
//! **W5-D-5 (gamma family + beta + confidence intervals):**
//!
//! - `GAMMA(x)` — 1 arg. Closed-form gamma function via
//!   `statrs::function::gamma::gamma`. Reject `x < 0 && x.floor() ==
//!   x` (gamma is undefined at non-positive integers). Non-finite
//!   result → `#NUM!`.
//! - `GAMMA.DIST(x, alpha, beta, cumulative)` — 4 args. Gamma
//!   distribution PDF/CDF. `x >= 0`, `alpha > 0`, `beta > 0` strict.
//!   statrs `Gamma::new(alpha, 1/beta)` (shape-rate; Excel passes
//!   shape-scale).
//! - `GAMMA.INV(probability, alpha, beta)` — 3 args. Inverse gamma
//!   CDF. `0 <= p <= 1` INCLUSIVE; `alpha > 0`, `beta > 0`. Else
//!   `#NUM!`.
//! - `GAMMALN(x)` and `GAMMALN.PRECISE(x)` — 1 arg each. Log-gamma
//!   `ln(Γ(x))` via `statrs::function::gamma::ln_gamma`. Reject
//!   `x < 0`. (PRECISE is an alias of GAMMALN — Excel introduced it
//!   for naming consistency; same impl.)
//! - `BETA.DIST(x, alpha, beta, cumulative, [A], [B])` — **VARIADIC
//!   4-6 args**. Optional `[A, B]` bounds default to `[0, 1]`
//!   (standard Beta). Transforms via `t = (x - A) / (B - A)`. PDF
//!   scaled by `1 / (B - A)` per Jacobian. `x ∈ [A, B]`, `A < B`,
//!   `alpha > 0`, `beta > 0`.
//! - `BETA.INV(probability, alpha, beta, [A], [B])` — **VARIADIC
//!   3-5 args**. Same optional bounds. `0 < p < 1` STRICT both;
//!   `A < B`, `alpha > 0`, `beta > 0`. Returns
//!   `A + t * (B - A)` where `t = inverse_cdf(p)`.
//! - `CONFIDENCE.NORM(alpha, standard_dev, size)` — 3 args. Returns
//!   `z(1 - α/2) · σ / √n` (two-sided normal CI half-width).
//!   `0 < α < 1` strict, `σ > 0`, `size.floor() >= 1`. **Note: size
//!   uses `.floor()`, NOT `.trunc()`** — matches IronCalc.
//! - `CONFIDENCE.T(alpha, standard_dev, size)` — 3 args. Same as
//!   NORM but with `t(1 - α/2; df=n-1)` critical value. `size.trunc()
//!   >= 2` (df=n-1 must be ≥ 1). **`size < 2.0` returns `#DIV/0!`**
//!   (matches IronCalc + Excel canon — different error class from
//!   `#NUM!`). **Note: size uses `.trunc()`** (IronCalc divergence
//!   from CONFIDENCE.NORM's `.floor()`).
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
//! **W5-D-3 (CHISQ.\* + F.\* fns)** also truncate all `deg_freedom*`
//! args via `.trunc()`. **CHISQ.\* alone** enforces a `df <= 10^10`
//! ceiling via `MAX_CHISQ_DEGREES_OF_FREEDOM` (matches IronCalc's
//! `chisq.rs` constant). **F.\* has no explicit df ceiling** — statrs
//! `FisherSnedecor::new` only rejects NaN / `<= 0`, and IronCalc's
//! `fisher.rs` does not impose an upper bound. (W5-D-3.1 Codex LOW-3
//! closure: prior sentence ambiguously read as applying to both
//! families; clarified here.)
//!
//! All four right-tailed variants (CHISQ.DIST.RT, F.DIST.RT,
//! CHISQ.INV.RT, F.INV.RT) reject negative results from fp drift —
//! since chi-squared and F are non-negative random variables, a
//! negative `1 - cdf(x)` or `inverse_cdf` result signals a fp anomaly
//! and surfaces as `#NUM!`. CHISQ.DIST.RT uses `statrs`'s
//! `dist.sf(x)` (survival function) directly for better numerical
//! stability vs `1 - dist.cdf(x)` in the far right tail; F.DIST.RT
//! uses `1 - dist.cdf(x)` matching IronCalc canon.
//!
//! **W5-D-5 (CONFIDENCE.NORM / CONFIDENCE.T)** apply `.floor()` and
//! `.trunc()` respectively to the `size` argument before integer
//! conversion. The divergence is deliberate — matches IronCalc which
//! itself follows Excel canon. `.floor(-0.5) = -1` vs `.trunc(-0.5) =
//! 0`, but both fns reject `size < 1` (NORM) / `size < 2` (T) so the
//! divergence is invisible for in-domain inputs. `CONFIDENCE.T`
//! returns `#DIV/0!` (not `#NUM!`) for `size < 2` per Excel canon —
//! the only fn in distribution_fns that surfaces `#DIV/0!`.
//!
//! **W5-D-4 (BINOM.\* / NEGBINOM.\* / POISSON.\* fns)** convert
//! integer-typed args (`number_s`, `trials`, `number_s2`, `number_f`,
//! `x` for POISSON) from f64 to u64 via `.trunc()` after pre-checking
//! `>= 0.0 && <= u64::MAX as f64`. statrs's discrete distributions
//! (`Binomial`, `NegativeBinomial`, `Poisson`) take u64 args for the
//! observation point. Negative or NaN integer args → `#NUM!`.
//! **POISSON.DIST `mean == 0.0`** is special-cased inline (statrs's
//! `Poisson::new(0.0)` rejects); we return the degenerate-at-0
//! distribution (`P(X=0)=1`, `P(X>0)=0`, `CDF(k)=1` for any k≥0).
//! **EXPON.DIST** uses closed-form math directly (no statrs Continuous
//! kernel needed); kept here for module cohesion since the rest of
//! W5-D-4 is statrs-backed.
//!
//! **Microsoft canon divergences in W5-D-3 (W5-D-3.1 Codex LOW-3
//! closure):**
//!
//! 1. **F.INV.RT lower-strict `0 < p`**: matches IronCalc's
//!    `fisher.rs` exactly. Microsoft's F.INV.RT support page is
//!    ambiguous on whether `p == 0` is accepted; IronCalc rejects, we
//!    follow. F.INV / CHISQ.INV / CHISQ.INV.RT all accept `p == 0`
//!    inclusive.
//! 2. **F.* has no `df >= 10^10` upper bound**: Microsoft's F.INV /
//!    F.DIST support pages say `deg_freedom2 >= 10^10` returns
//!    `#NUM!`. IronCalc's `fisher.rs` does NOT impose this bound; we
//!    follow IronCalc. If Microsoft-doc parity becomes the stronger
//!    contract, add the guard symmetrically across the 4 F.* fns.
//! 3. **F-pdf at `x=0` with `df1=2`**: Microsoft + true math give 1;
//!    statrs returns 0 (special-cases the 0/0 limit by zeroing). We
//!    inherit statrs's behavior; no test pinned for this corner.
//!
//! **W5-D-4.1 (Codex HIGH-1 + Opus MEDIUM-O-2 closure): BINOM.INV
//! degenerate-distribution panic avoidance.** IronCalc has the same
//! statrs 0.18.0 pin as we do, and would panic for `BINOM.INV(0,
//! 0.5, 0.5)` (trials=0) or `BINOM.INV(10, 0, 0.5)` (p=0) — statrs's
//! default `DiscreteCDF::inverse_cdf` calls `integral_bisection_search`
//! which returns `None` for constant-CDF (degenerate) distributions,
//! then `.unwrap()`s. We short-circuit both corners explicitly and
//! return the mathematically-correct value 0 (only valid `k` for a
//! distribution concentrated at 0). **This is an intentional IronCalc-
//! divergent behavior** — Microsoft canon doesn't cover these corners,
//! and producing a value beats producing a panic.
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

use statrs::distribution::{
    Beta, Binomial, ChiSquared, Continuous, ContinuousCDF, Discrete, DiscreteCDF, FisherSnedecor,
    Gamma, LogNormal, NegativeBinomial, Normal, Poisson, StudentsT,
};
use statrs::function::erf::{erf as erf_fn, erfc as erfc_fn};
use statrs::function::gamma::{gamma as gamma_fn, ln_gamma};

use ql_types::{coercion, ErrorValue, Value};

/// **W5-D-4 helper**: coerce an f64 to u64 for discrete-distribution
/// observation indices. Returns `None` if the value is negative, NaN,
/// or `>= u64::MAX as f64`. Caller pre-truncates via `.trunc()`.
///
/// **W5-D-4.1 (Codex MEDIUM-1 + Opus MEDIUM-O-1 closure):** the upper
/// guard is `>=` not `>` because `u64::MAX as f64` rounds up to `2^64`
/// in IEEE-754. With the looser `>` check, the f64 value `2^64.0`
/// would pass the guard, and `as u64` saturation would silently yield
/// `u64::MAX` — violating the "exceeds u64::MAX → #NUM!" contract.
/// Using `>=` against `u64::MAX as f64` (= `2^64.0`) rejects both
/// `2^64` and anything above.
fn to_u64_index(v: f64) -> Option<u64> {
    if v.is_nan() || v < 0.0 || v >= u64::MAX as f64 {
        None
    } else {
        Some(v as u64)
    }
}

/// **W5-D-3 canon ceiling for chi-squared degrees of freedom.** IronCalc
/// caps `df` at 10^10 (in `chisq.rs`) to avoid pathological compute
/// times in the far tails when `df` is in the millions. F.* doesn't
/// have an explicit ceiling in IronCalc — `FisherSnedecor::new` rejects
/// NaN / `<= 0` and that's the only guard. Match IronCalc on both
/// (ceiling for CHISQ.*, none for F.*).
const MAX_CHISQ_DEGREES_OF_FREEDOM: f64 = 10_000_000_000.0;

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
// W5-D-3: Chi-squared distribution (CHISQ.DIST / CHISQ.DIST.RT /
// CHISQ.INV / CHISQ.INV.RT)
// =====================================================================
//
// `statrs::ChiSquared::new(df)` parameterizes by degrees of freedom
// alone. statrs rejects only NaN or `df <= 0`; our coercion + pre-check
// (`df.trunc() in [1, 10^10]`) rules both out, so `.expect()` is
// principled (No-Fallbacks rule).

/// Build a chi-squared distribution with `df` degrees of freedom.
/// Call sites pre-check `df in [1, 10^10]` and coercion rejects NaN, so
/// construction cannot fail. `.expect()` per No-Fallbacks rule
/// (W5-D-1.1 closure pattern).
fn chi_squared_with(df: f64) -> ChiSquared {
    ChiSquared::new(df).expect(
        "upstream sanitize_f64 + df in [1, 10^10] pre-check guarantee ChiSquared::new succeeds",
    )
}

/// **CHISQ.DIST(x, deg_freedom, cumulative)** — chi-squared PDF
/// (`cumulative=FALSE`) or left-tailed CDF (`cumulative=TRUE`).
///
/// - Args: 3 required.
/// - `x >= 0` else `#NUM!` (chi-squared is non-negative).
/// - `deg_freedom` truncated to integer; must be in `[1, 10^10]` else
///   `#NUM!`.
pub fn chisq_dist(args: &[Value]) -> Value {
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
    if x < 0.0 || !(1.0..=MAX_CHISQ_DEGREES_OF_FREEDOM).contains(&df) {
        return Value::Error(ErrorValue::Num);
    }
    let dist = chi_squared_with(df);
    finite_or_num(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

/// **CHISQ.DIST.RT(x, deg_freedom)** — right-tailed chi-squared
/// probability `P(X > x)`. Uses `statrs`'s survival-function
/// `dist.sf(x)` directly for better numerical properties in the far
/// right tail vs `1 - dist.cdf(x)` (matches IronCalc canon).
///
/// - Args: 2 required.
/// - `x >= 0` else `#NUM!`.
/// - `df` in `[1, 10^10]` else `#NUM!`.
pub fn chisq_dist_rt(args: &[Value]) -> Value {
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
    if x < 0.0 || !(1.0..=MAX_CHISQ_DEGREES_OF_FREEDOM).contains(&df) {
        return Value::Error(ErrorValue::Num);
    }
    let dist = chi_squared_with(df);
    let result = dist.sf(x);
    if !result.is_finite() || result < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(result)
}

/// **CHISQ.INV(probability, deg_freedom)** — left-tailed inverse
/// chi-squared CDF.
///
/// - Args: 2 required.
/// - `0 <= probability <= 1` INCLUSIVE (note: differs from
///   T.INV/NORM.INV's strict `(0, 1)`; matches IronCalc + Microsoft
///   canon). `CHISQ.INV(0, df) = 0`; `CHISQ.INV(1, df)` would be
///   infinity and is rejected via the inline `!result.is_finite()`
///   guard (W5-D-3.1 LOW-O-1 closure: prior docstring incorrectly
///   said "via `finite_or_num`" — the impl uses the inline check + a
///   `result < 0.0` defense, since the inverse path also needs the
///   negative-result guard).
/// - `df` in `[1, 10^10]` else `#NUM!`.
pub fn chisq_inv(args: &[Value]) -> Value {
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
    if !(0.0..=1.0).contains(&p) || !(1.0..=MAX_CHISQ_DEGREES_OF_FREEDOM).contains(&df) {
        return Value::Error(ErrorValue::Num);
    }
    let dist = chi_squared_with(df);
    let x = dist.inverse_cdf(p);
    if !x.is_finite() || x < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(x)
}

/// **CHISQ.INV.RT(probability, deg_freedom)** — right-tailed inverse
/// chi-squared. Solves `p = P(X > x) = 1 - CDF(x)`, returns
/// `inverse_cdf(1 - p)`.
///
/// - Args: 2 required.
/// - Same domain as CHISQ.INV (`p` inclusive `[0, 1]`, `df` in
///   `[1, 10^10]`).
pub fn chisq_inv_rt(args: &[Value]) -> Value {
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
    if !(0.0..=1.0).contains(&p) || !(1.0..=MAX_CHISQ_DEGREES_OF_FREEDOM).contains(&df) {
        return Value::Error(ErrorValue::Num);
    }
    let dist = chi_squared_with(df);
    let x = dist.inverse_cdf(1.0 - p);
    if !x.is_finite() || x < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(x)
}

// =====================================================================
// W5-D-3: Fisher-Snedecor F distribution (F.DIST / F.DIST.RT / F.INV /
// F.INV.RT)
// =====================================================================
//
// `statrs::FisherSnedecor::new(df1, df2)` parameterizes by both
// degree-of-freedom args. statrs rejects NaN or `<= 0`; our coercion +
// pre-check (`df1.trunc() >= 1`, `df2.trunc() >= 1`) rule both out.

/// Build an F (Fisher-Snedecor) distribution. Call sites pre-check
/// `df1 >= 1` AND `df2 >= 1` and coercion rejects NaN; construction
/// cannot fail. `.expect()` per No-Fallbacks rule.
fn fisher_snedecor_with(df1: f64, df2: f64) -> FisherSnedecor {
    FisherSnedecor::new(df1, df2).expect(
        "upstream sanitize_f64 + df1>=1 + df2>=1 pre-check guarantee FisherSnedecor::new succeeds",
    )
}

/// **F.DIST(x, deg_freedom1, deg_freedom2, cumulative)** — F-distribution
/// PDF (`cumulative=FALSE`) or left-tailed CDF (`cumulative=TRUE`).
///
/// - Args: 4 required.
/// - `x >= 0` else `#NUM!` (F is non-negative).
/// - `df1 >= 1` AND `df2 >= 1` (truncated to integer) else `#NUM!`.
pub fn f_dist(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df1 = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let df2 = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[3]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 || df1 < 1.0 || df2 < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = fisher_snedecor_with(df1, df2);
    finite_or_num(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

/// **F.DIST.RT(x, deg_freedom1, deg_freedom2)** — right-tailed
/// F-distribution probability `P(F > x)` = `1 - CDF(x)` (matches
/// IronCalc canon — uses `1 - cdf(x)` rather than `sf(x)`).
///
/// - Args: 3 required.
/// - `x >= 0`; `df1 >= 1`; `df2 >= 1`. Else `#NUM!`.
pub fn f_dist_rt(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df1 = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let df2 = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 || df1 < 1.0 || df2 < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = fisher_snedecor_with(df1, df2);
    let result = 1.0 - dist.cdf(x);
    if !result.is_finite() || result < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(result)
}

/// **F.INV(probability, deg_freedom1, deg_freedom2)** — left-tailed
/// inverse F-distribution CDF.
///
/// - Args: 3 required.
/// - `0 <= probability <= 1` INCLUSIVE (like CHISQ.INV; differs from
///   T.INV's strict). `df1 >= 1`, `df2 >= 1`. Else `#NUM!`.
/// - **W5-D-3.1 (Opus LOW-O-2 closure):** `F.INV(0, df1, df2) = 0`;
///   `F.INV(1, df1, df2)` returns `#NUM!` via the inline
///   `!x.is_finite()` guard — the F right-tail is unbounded so
///   `inverse_cdf(1.0)` is non-finite. Matches CHISQ.INV's
///   domain-accepted-but-observably-#NUM! behavior at `p == 1`.
pub fn f_inv(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df1 = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let df2 = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if !(0.0..=1.0).contains(&p) || df1 < 1.0 || df2 < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = fisher_snedecor_with(df1, df2);
    let x = dist.inverse_cdf(p);
    if !x.is_finite() || x < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(x)
}

/// **F.INV.RT(probability, deg_freedom1, deg_freedom2)** — right-tailed
/// inverse F-distribution. Solves `p = P(F > x) = 1 - CDF(x)`, returns
/// `inverse_cdf(1 - p)`.
///
/// - Args: 3 required.
/// - `0 < p <= 1` (lower-strict, upper-inclusive per IronCalc canon).
///   `df1 >= 1`, `df2 >= 1`. Else `#NUM!`.
pub fn f_inv_rt(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let df1 = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let df2 = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if p <= 0.0 || p > 1.0 || df1 < 1.0 || df2 < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = fisher_snedecor_with(df1, df2);
    let x = dist.inverse_cdf(1.0 - p);
    if !x.is_finite() || x < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(x)
}

// =====================================================================
// W5-D-4: Binomial distribution (BINOM.DIST / BINOM.DIST.RANGE /
// BINOM.INV) — first discrete distribution
// =====================================================================
//
// `statrs::Binomial::new(p, n)` parameterizes by probability AND trial
// count. Observation point passed as u64 to `cdf` / `pmf`. statrs
// rejects NaN p, p outside [0, 1].

/// Build a Binomial distribution. Call sites pre-check
/// `0 <= p <= 1` (NaN already rejected by `to_number_strict`) so
/// `Binomial::new` cannot fail. `.expect()` per No-Fallbacks rule.
fn binomial_with(p: f64, n: u64) -> Binomial {
    Binomial::new(p, n)
        .expect("upstream sanitize_f64 + p in [0,1] pre-check guarantee Binomial::new succeeds")
}

/// **BINOM.DIST(number_s, trials, probability_s, cumulative)** —
/// binomial PMF (`cumulative=FALSE`) or CDF (`cumulative=TRUE`).
///
/// - Args: 4 required.
/// - `number_s.trunc()` in `[0, trials]`; `trials.trunc() >= 0`;
///   `0 <= p <= 1` (inclusive both ends). Else `#NUM!`.
/// - `trials` capped at `u64::MAX` (overflow → `#NUM!`).
pub fn binom_dist(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let number_s = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let trials = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let p = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[3]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if trials < 0.0 || number_s < 0.0 || number_s > trials || !(0.0..=1.0).contains(&p) {
        return Value::Error(ErrorValue::Num);
    }
    let n = match to_u64_index(trials) {
        Some(n) => n,
        None => return Value::Error(ErrorValue::Num),
    };
    let k = match to_u64_index(number_s) {
        Some(k) => k,
        None => return Value::Error(ErrorValue::Num),
    };
    let dist = binomial_with(p, n);
    finite_or_num(if cumulative { dist.cdf(k) } else { dist.pmf(k) })
}

/// **BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])**
/// — probability of `[number_s, number_s2]` successes in `trials`
/// independent trials. **VARIADIC** (3 or 4 args). When `number_s2`
/// omitted, defaults to `number_s` (single-point probability =
/// `dist.pmf(number_s)`).
///
/// Computed as `CDF(upper) - CDF(lower - 1)` when `lower > 0`, else
/// `CDF(upper)` directly. (**W5-D-4.1 Opus LOW-O-5 closure**: prior
/// comment said "underflow"; in Rust, `0u64 - 1u64` is debug-panic /
/// release-wrap, not undefined behavior. The short-circuit avoids
/// that branch entirely.)
pub fn binom_dist_range(args: &[Value]) -> Value {
    if !(3..=4).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let trials = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let p = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let number_s = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let number_s2 = if args.len() == 4 {
        match coercion::to_number_strict(&args[3]) {
            Ok(n) => n.trunc(),
            Err(e) => return Value::Error(e),
        }
    } else {
        number_s
    };
    if trials < 0.0
        || number_s < 0.0
        || number_s2 < 0.0
        || number_s > number_s2
        || number_s2 > trials
        || !(0.0..=1.0).contains(&p)
    {
        return Value::Error(ErrorValue::Num);
    }
    let n = match to_u64_index(trials) {
        Some(n) => n,
        None => return Value::Error(ErrorValue::Num),
    };
    let lower = match to_u64_index(number_s) {
        Some(v) => v,
        None => return Value::Error(ErrorValue::Num),
    };
    let upper = match to_u64_index(number_s2) {
        Some(v) => v,
        None => return Value::Error(ErrorValue::Num),
    };
    let dist = binomial_with(p, n);
    let prob = if lower == 0 {
        dist.cdf(upper)
    } else {
        dist.cdf(upper) - dist.cdf(lower - 1)
    };
    // **W5-D-4.1 (Opus LOW-O-3 closure):** apply the same fp-drift
    // defense as CHISQ.DIST.RT / F.DIST.RT (negative-result reject) —
    // `cdf(upper) - cdf(lower - 1)` is mathematically `>= 0` but
    // statrs's two cdf calls each have their own rounding error;
    // subtracting them can produce a slightly-negative result near
    // the tails. Surface as `#NUM!` rather than silently propagating
    // a nonsensical negative probability.
    if !prob.is_finite() || prob < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(prob)
}

/// **BINOM.INV(trials, probability_s, alpha)** — smallest `k` such
/// that `CDF(k) >= alpha`. Returns the result as a Number.
///
/// - Args: 3 required.
/// - `trials >= 0`, `0 <= p < 1` (note: STRICT upper for `p`,
///   inclusive lower — diverges from BINOM.DIST inclusive-both),
///   `0 < alpha < 1` strict both. Else `#NUM!`.
pub fn binom_inv(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let trials = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let p = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let alpha = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-2 closure):**
    // accept `p == 1.0` per Microsoft canon (which says `0 <= p <= 1`
    // inclusive). At `p = 1.0` the binomial is deterministic at `n`
    // (every trial succeeds), so `inverse_cdf(alpha)` for any
    // `alpha ∈ (0, 1)` is exactly `n`. Prior strict-upper `(0.0..1.0)`
    // half-open range over-rejected this valid input.
    if trials < 0.0 || !(0.0..=1.0).contains(&p) || alpha <= 0.0 || alpha >= 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let n = match to_u64_index(trials) {
        Some(n) => n,
        None => return Value::Error(ErrorValue::Num),
    };
    // **W5-D-4.1 (Codex HIGH-1 + Opus HIGH-O-1 closure):** Short-circuit
    // **both** known statrs degenerate-distribution panics for Binomial:
    //
    // 1. `p == 0.0`: distribution is degenerate at 0 (P(X=0)=1).
    //    `Binomial::new(0.0, n)` succeeds, but `cdf(k) = 1.0` for all
    //    `k >= 0` means the default `DiscreteCDF::inverse_cdf`'s
    //    `integral_bisection_search` returns `None` → `.unwrap()`
    //    panics.
    // 2. `n == 0` (trials == 0): single-point distribution at 0 for any
    //    `p`. `Binomial::new(p, 0)` succeeds, `cdf(0) = 1.0`,
    //    same bisection-search-returns-None panic shape.
    //
    // For both: the only valid `k` (smallest with `CDF(k) >= alpha` for
    // any `alpha ∈ (0, 1)`) is 0. **This diverges from IronCalc**,
    // which has the same statrs pin and would also panic on these
    // inputs. Microsoft canon doesn't cover these corners; the
    // mathematical interpretation gives 0 unambiguously. Documented in
    // the "IronCalc divergences" module-level section.
    if p == 0.0 || n == 0 {
        return Value::number(0.0);
    }
    // **W5-D-13.1 megaudit Opus MEDIUM-2 closure (p=1 short-circuit):**
    // at `p = 1.0` the distribution is deterministic at `n` — every
    // trial succeeds. Return `n` directly to avoid statrs corner
    // (statrs's Binomial at p=1 has the same bisection-search-returns-
    // None panic shape as p=0).
    if p == 1.0 {
        return Value::number(n as f64);
    }
    let dist = binomial_with(p, n);
    let k = dist.inverse_cdf(alpha);
    Value::number(k as f64)
}

// =====================================================================
// W5-D-4: Negative-binomial distribution (NEGBINOM.DIST)
// =====================================================================
//
// `statrs::NegativeBinomial::new(r, p)` parameterizes by successes
// (`r`, can be fractional) AND probability. `r` doesn't need u64
// conversion — statrs accepts f64. Observation `number_f` (failures)
// is u64.

/// Build a NegativeBinomial. Call sites pre-check `r >= 1` AND
/// `0 < p < 1` strict both; `to_number_strict` rejects NaN.
fn negative_binomial_with(r: f64, p: f64) -> NegativeBinomial {
    NegativeBinomial::new(r, p).expect(
        "upstream sanitize_f64 + r>=1 + p in (0,1) pre-check guarantee NegativeBinomial::new succeeds",
    )
}

/// **NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)** —
/// PMF or CDF.
///
/// - Args: 4 required.
/// - `number_f >= 0`, `number_s >= 1` (truncated), `0 < p < 1` strict
///   both. Else `#NUM!`.
pub fn negbinom_dist(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let number_f = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let number_s = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let p = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[3]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if number_f < 0.0 || number_s < 1.0 || p <= 0.0 || p >= 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let f_u = match to_u64_index(number_f) {
        Some(v) => v,
        None => return Value::Error(ErrorValue::Num),
    };
    let dist = negative_binomial_with(number_s, p);
    finite_or_num(if cumulative {
        dist.cdf(f_u)
    } else {
        dist.pmf(f_u)
    })
}

// =====================================================================
// W5-D-4: Poisson distribution (POISSON.DIST)
// =====================================================================
//
// `statrs::Poisson::new(lambda)` requires `lambda > 0`. `lambda == 0`
// is the degenerate distribution at 0 — handled inline since statrs
// rejects.

/// Build a Poisson distribution. Call sites pre-check `lambda > 0.0`;
/// `to_number_strict` rejects NaN. (`lambda == 0` is handled inline
/// in `poisson_dist`, never reaches this helper.)
fn poisson_with(lambda: f64) -> Poisson {
    Poisson::new(lambda)
        .expect("upstream sanitize_f64 + lambda > 0 pre-check guarantee Poisson::new succeeds")
}

/// **POISSON.DIST(x, mean, cumulative)** — Poisson PMF or CDF.
///
/// - Args: 3 required.
/// - `x.trunc() >= 0` (cast to u64); `mean >= 0` (NOT strict — `mean=0`
///   accepted, degenerate at 0). Else `#NUM!`.
/// - **Special case `mean == 0.0`**: returns degenerate distribution
///   (`P(X=0)=1`, `P(X>0)=0`; `CDF(k)=1` for any `k >= 0`). statrs's
///   `Poisson::new(0.0)` rejects, so this is handled inline.
pub fn poisson_dist(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    let lambda = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[2]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 || lambda < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let k = match to_u64_index(x) {
        Some(v) => v,
        None => return Value::Error(ErrorValue::Num),
    };
    // Special-case lambda == 0.0: degenerate distribution at 0.
    // For cumulative: CDF(k) = 1 for any k >= 0. For PMF: P(X=0) = 1,
    // P(X>0) = 0.
    if lambda == 0.0 {
        let result = if cumulative || k == 0 { 1.0 } else { 0.0 };
        return Value::number(result);
    }
    let dist = poisson_with(lambda);
    finite_or_num(if cumulative { dist.cdf(k) } else { dist.pmf(k) })
}

// =====================================================================
// W5-D-4: Exponential distribution (EXPON.DIST) — closed-form
// =====================================================================
//
// No statrs kernel — closed-form math directly. Kept in this module
// for cohesion with the rest of the distribution fns.

/// **EXPON.DIST(x, lambda, cumulative)** — exponential PDF or CDF.
/// Closed-form: `CDF(x) = 1 - exp(-λx)`, `PDF(x) = λ·exp(-λx)`.
///
/// - Args: 3 required.
/// - `x >= 0`; `lambda > 0` STRICT. Else `#NUM!`.
pub fn expon_dist(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let lambda = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[2]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 || lambda <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let result = if cumulative {
        1.0 - (-lambda * x).exp()
    } else {
        lambda * (-lambda * x).exp()
    };
    finite_or_num(result)
}

// =====================================================================
// W5-D-4: Log-normal distribution (LOGNORM.DIST / LOGNORM.INV)
// =====================================================================
//
// `statrs::LogNormal::new(location, scale)` parameterizes by the
// underlying normal's mean (location) and sd (scale). LogNormal::new
// rejects NaN location or `scale <= 0`; pre-check + coercion rule
// these out.

/// Build a LogNormal. Call sites pre-check `sd > 0.0`;
/// `to_number_strict` rejects NaN on both args.
fn log_normal_with(mean: f64, sd: f64) -> LogNormal {
    LogNormal::new(mean, sd)
        .expect("upstream sanitize_f64 + sd > 0 pre-check guarantee LogNormal::new succeeds")
}

/// **LOGNORM.DIST(x, mean, standard_dev, cumulative)** — log-normal
/// PDF or CDF.
///
/// - Args: 4 required.
/// - `x > 0` STRICT (log-normal is undefined at x=0); `sd > 0` STRICT.
///   Else `#NUM!`. `mean` may be negative (it's the underlying
///   normal's mean).
pub fn lognorm_dist(args: &[Value]) -> Value {
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
    if x <= 0.0 || sd <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = log_normal_with(mean, sd);
    finite_or_num(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

/// **LOGNORM.INV(probability, mean, standard_dev)** — inverse
/// log-normal CDF.
///
/// - Args: 3 required.
/// - `0 < p < 1` STRICT both; `sd > 0` strict. Else `#NUM!`.
pub fn lognorm_inv(args: &[Value]) -> Value {
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
    let dist = log_normal_with(mean, sd);
    finite_or_num(dist.inverse_cdf(p))
}

// =====================================================================
// W5-D-5: Gamma family (GAMMA / GAMMA.DIST / GAMMA.INV / GAMMALN /
// GAMMALN.PRECISE)
// =====================================================================
//
// `statrs::function::gamma::{gamma, ln_gamma}` for the closed-form
// gamma/log-gamma functions (NOT distribution-backed for GAMMA itself
// — these are the gamma functions). `statrs::distribution::Gamma` for
// GAMMA.DIST / GAMMA.INV (shape-rate parameterization; Excel passes
// shape-scale so we convert via `rate = 1/scale`).

/// Build a Gamma distribution from Excel shape (alpha) and scale
/// (beta) parameters. Converts to statrs's shape-rate parameterization
/// via `rate = 1/scale`. Call sites pre-check `alpha > 0` AND
/// `beta > 0`; `to_number_strict` rejects NaN. Construction cannot
/// fail when `rate` is finite. `.expect()` per No-Fallbacks rule.
///
/// **W5-D-5.1 (Codex HIGH-1 closure):** returns `Option<Gamma>`
/// because `1.0 / scale` overflows to `+Inf` for subnormal `scale`
/// (e.g. `5e-324`), which statrs 0.18.0 accepts (`Gamma::new` only
/// rejects NaN / `<= 0`, and infinite `rate` alone passes — only
/// `shape=Inf && rate=Inf` is rejected). statrs's `inverse_cdf`
/// then hangs in its bracketing loop because `cdf(any-finite-high) =
/// 0.0` so the doubling `while self.cdf(high) < p` never exits.
///
/// Callers must short-circuit `#NUM!` on `None`. Microsoft canon
/// doesn't cover this corner; IronCalc has the same unchecked
/// conversion and would hang too — we follow the W5-D-4 BINOM.INV
/// precedent of explicitly diverging from IronCalc to protect engine
/// availability.
///
/// **W5-D-13.1 (Phase 4.10 V1-260 megaudit Codex HIGH-3 closure):**
/// the W5-D-5.1 finite-rate guard was insufficient. For finite-but-
/// subnormal `scale` (e.g. `f64::MIN_POSITIVE / 2.0 = 1.11e-308`),
/// `1.0 / scale ≈ 8.98e307` is finite but enormous. `Gamma::new`
/// accepts it, but `inverse_cdf` panics inside statrs with
/// `Result::unwrap() on Err value: XInvalid` because the
/// distribution becomes numerically degenerate (effectively a Dirac
/// at 0). Reject subnormal scale outright — the iterative kernels
/// cannot operate reliably on parameters at the f64 subnormal
/// boundary. Compiled probe verified `f64::MIN_POSITIVE` and above
/// work; `f64::MIN_POSITIVE / 2.0` and below panic.
fn gamma_dist_with(alpha: f64, scale: f64) -> Option<Gamma> {
    // Reject subnormal scale to prevent statrs panic on numerically
    // degenerate parameters. Subnormals are < f64::MIN_POSITIVE
    // (~2.225e-308).
    if scale < f64::MIN_POSITIVE {
        return None;
    }
    let rate = 1.0 / scale;
    if !rate.is_finite() {
        return None;
    }
    Some(Gamma::new(alpha, rate).expect(
        "upstream sanitize_f64 + alpha>0 + scale>=MIN_POSITIVE + finite-rate guard guarantee Gamma::new succeeds",
    ))
}

/// **GAMMA(x)** — gamma function `Γ(x)`. Not the gamma distribution.
///
/// - Args: 1 required.
/// - Reject `x < 0 && x.floor() == x` (gamma function has poles at
///   non-positive integers).
/// - Non-finite result → `#NUM!`.
pub fn gamma_fn_excel(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    // Gamma function poles: non-positive integers (0, -1, -2, ...).
    // statrs's `gamma(0)` returns +Inf; `gamma(-1)` returns NaN; etc.
    // IronCalc's check is `x < 0.0 && x.floor() == x` — explicit
    // rejection of negative integers. We also reject 0 implicitly via
    // the finite-result guard (gamma(0) = +Inf → #NUM!).
    if x < 0.0 && x.floor() == x {
        return Value::Error(ErrorValue::Num);
    }
    finite_or_num(gamma_fn(x))
}

/// **GAMMA.DIST(x, alpha, beta, cumulative)** — gamma distribution
/// PDF (`cumulative=FALSE`) or CDF (`cumulative=TRUE`).
///
/// - Args: 4 required.
/// - `x >= 0`; `alpha > 0`; `beta > 0` STRICT. Else `#NUM!`.
/// - `alpha` is the shape parameter; `beta` is the scale parameter
///   (Excel canon). statrs uses shape-rate, so we pass
///   `rate = 1/beta` to the constructor.
pub fn gamma_dist(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let alpha = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let beta_scale = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[3]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 || alpha <= 0.0 || beta_scale <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    // **W5-D-5.1 (Codex HIGH-1 closure):** subnormal `beta_scale`
    // (e.g. `5e-324`) yields `rate = 1/scale = +Inf`. statrs accepts
    // it but produces non-spec results / hangs in `inverse_cdf`. The
    // helper now returns `None` for non-finite rate; surface `#NUM!`.
    let dist = match gamma_dist_with(alpha, beta_scale) {
        Some(d) => d,
        None => return Value::Error(ErrorValue::Num),
    };
    finite_or_num(if cumulative { dist.cdf(x) } else { dist.pdf(x) })
}

/// **GAMMA.INV(probability, alpha, beta)** — inverse gamma CDF.
///
/// - Args: 3 required.
/// - `0 <= probability <= 1` INCLUSIVE; `alpha > 0`; `beta > 0`. Else
///   `#NUM!`.
/// - Negative result (from fp drift) rejected via inline guard.
pub fn gamma_inv(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let alpha = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let beta_scale = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if !(0.0..=1.0).contains(&p) || alpha <= 0.0 || beta_scale <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    // **W5-D-5.1 (Codex HIGH-1 closure):** non-finite-rate guard
    // (see `gamma_dist_with` docstring). Without this short-circuit
    // statrs's `inverse_cdf` enters an infinite bracketing loop for
    // subnormal `beta_scale`.
    let dist = match gamma_dist_with(alpha, beta_scale) {
        Some(d) => d,
        None => return Value::Error(ErrorValue::Num),
    };
    let x = dist.inverse_cdf(p);
    if !x.is_finite() || x < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(x)
}

/// **GAMMALN(x)** — natural log of the absolute value of `Γ(x)`,
/// computed via `statrs::function::gamma::ln_gamma`.
///
/// - Args: 1 required.
/// - `x >= 0`; else `#NUM!`. (Excel canon: GAMMALN is defined for
///   positive reals; `x=0` produces `+Inf` and surfaces as `#NUM!`
///   via the finite-result guard.)
pub fn gamma_ln(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if x < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    finite_or_num(ln_gamma(x))
}

/// **GAMMALN.PRECISE(x)** — alias for `GAMMALN`. Excel introduced
/// `.PRECISE` variants in 2010 for naming consistency; the
/// implementation is identical.
pub fn gamma_ln_precise(args: &[Value]) -> Value {
    gamma_ln(args)
}

// =====================================================================
// W5-D-5: Beta distribution (BETA.DIST / BETA.INV)
// =====================================================================
//
// `statrs::Beta::new(alpha, beta)` parameterizes the standard Beta on
// `[0, 1]`. Excel adds optional `[A, B]` bounds to shift the domain
// to `[A, B]` via `t = (x - A) / (B - A)`. PDF must be scaled by
// `1 / (B - A)` (Jacobian).

/// Build a standard Beta distribution. Call sites pre-check `alpha >
/// 0` AND `beta > 0`; `to_number_strict` rejects NaN. Construction
/// cannot fail. `.expect()` per No-Fallbacks rule.
fn beta_dist_with(alpha: f64, beta_param: f64) -> Beta {
    Beta::new(alpha, beta_param)
        .expect("upstream sanitize_f64 + alpha>0 + beta>0 pre-check guarantee Beta::new succeeds")
}

/// **BETA.DIST(x, alpha, beta, cumulative, [A], [B])** — beta
/// distribution PDF or CDF on optional `[A, B]` domain.
///
/// - Args: **VARIADIC 4-6 required.** `A` defaults to 0, `B` defaults
///   to 1.
/// - `alpha > 0`, `beta > 0`, `A < B`, `A <= x <= B`. Else `#NUM!`.
/// - PDF scaled by `1 / (B - A)` (Jacobian for change of variables
///   `t = (x - A) / (B - A)`).
pub fn beta_dist(args: &[Value]) -> Value {
    if !(4..=6).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let alpha = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let beta_param = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cumulative = match coercion::to_logical(&args[3]) {
        Ok(b) => b,
        Err(e) => return Value::Error(e),
    };
    let a = if args.len() >= 5 {
        match coercion::to_number_strict(&args[4]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let b = if args.len() >= 6 {
        match coercion::to_number_strict(&args[5]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1.0
    };
    if alpha <= 0.0 || beta_param <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    if b == a || x < a || x > b {
        return Value::Error(ErrorValue::Num);
    }
    let width = b - a;
    let t = (x - a) / width;
    let dist = beta_dist_with(alpha, beta_param);
    let result = if cumulative {
        dist.cdf(t)
    } else {
        // General-interval beta PDF: f_X(x) = f_T(t) / (B - A).
        dist.pdf(t) / width
    };
    finite_or_num(result)
}

/// **BETA.INV(probability, alpha, beta, [A], [B])** — inverse beta
/// CDF on optional `[A, B]` domain.
///
/// - Args: **VARIADIC 3-5 required.** `A` defaults to 0, `B` defaults
///   to 1.
/// - `0 < probability < 1` STRICT both ends; `alpha > 0`; `beta > 0`;
///   `A < B`. Else `#NUM!`.
/// - Returns `A + t * (B - A)` where `t = inverse_cdf(probability)`.
pub fn beta_inv(args: &[Value]) -> Value {
    if !(3..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let p = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let alpha = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let beta_param = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let a = if args.len() >= 4 {
        match coercion::to_number_strict(&args[3]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let b = if args.len() >= 5 {
        match coercion::to_number_strict(&args[4]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1.0
    };
    if alpha <= 0.0 || beta_param <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    if p <= 0.0 || p >= 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    if b <= a {
        return Value::Error(ErrorValue::Num);
    }
    let dist = beta_dist_with(alpha, beta_param);
    let t = dist.inverse_cdf(p);
    // **W5-D-5.1 (Opus LOW-O-3 closure):** added `t < 0.0` defensive
    // guard for parity with GAMMA.INV. Beta distribution is supported
    // on `[0, 1]`, so `inverse_cdf` should never return negative —
    // but a fp-drift result of e.g. `-1e-15` would silently propagate
    // a non-spec value through the affine transform `a + t·(b-a)`.
    // Surface as `#NUM!` instead.
    if !t.is_finite() || t < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    Value::number(a + t * (b - a))
}

// =====================================================================
// W5-D-5: Confidence-interval margins (CONFIDENCE.NORM / CONFIDENCE.T)
// =====================================================================
//
// Reuse `standard_normal()` (W5-D-1) and `students_t_with(df)`
// (W5-D-2). The returned value is the CI half-width (margin), not the
// CI bounds themselves.

/// **CONFIDENCE.NORM(alpha, standard_dev, size)** — half-width of a
/// two-sided `(1 - alpha) · 100%` normal confidence interval:
/// `z(1 - α/2) · σ / √n`.
///
/// - Args: 3 required.
/// - `0 < alpha < 1` strict; `sd > 0` strict; `size.floor() >= 1`.
///   Else `#NUM!`. Non-finite quantile → `#NUM!`.
/// - **Size uses `.floor()`** (IronCalc canon).
pub fn confidence_norm(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let alpha = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let sd = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let size = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.floor(),
        Err(e) => return Value::Error(e),
    };
    if alpha <= 0.0 || alpha >= 1.0 || sd <= 0.0 || size < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    let dist = standard_normal();
    let quantile = dist.inverse_cdf(1.0 - alpha / 2.0);
    if !quantile.is_finite() {
        return Value::Error(ErrorValue::Num);
    }
    finite_or_num(quantile * sd / size.sqrt())
}

/// **CONFIDENCE.T(alpha, standard_dev, size)** — half-width of a
/// two-sided `(1 - alpha) · 100%` Student's t confidence interval:
/// `t(1 - α/2; df=n-1) · σ / √n`.
///
/// - Args: 3 required.
/// - `0 < alpha < 1` strict; `sd > 0` strict. Else `#NUM!`.
/// - `size.trunc() >= 2` (df = n - 1 must be `>= 1`). Else
///   **`#DIV/0!`** (NOT `#NUM!`) — matches IronCalc + Excel canon.
/// - **Size uses `.trunc()`** (IronCalc divergence from
///   CONFIDENCE.NORM's `.floor()`).
pub fn confidence_t(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let alpha = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let sd = match coercion::to_number_strict(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let size = match coercion::to_number_strict(&args[2]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    };
    if alpha <= 0.0 || alpha >= 1.0 || sd <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    if size < 2.0 {
        return Value::Error(ErrorValue::DivZero);
    }
    let df = size - 1.0;
    let dist = students_t_with(df);
    let t_crit = dist.inverse_cdf(1.0 - alpha / 2.0);
    if !t_crit.is_finite() {
        return Value::Error(ErrorValue::Num);
    }
    finite_or_num(t_crit * sd / size.sqrt())
}

// =====================================================================
// W5-D-10 (Phase 4.10 V1-260 closeout): Error function family
// =====================================================================
//
// ERF / ERFC and their Excel 2010 `.PRECISE` aliases. Closed-form via
// `statrs::function::erf::{erf, erfc}` — Abramowitz-Stegun-style
// rational approximations, accurate to ~10-13 significant figures
// across the f64 range.
//
// References:
// - `.references/ironcalc/base/src/functions/engineering/bessel.rs:127-177`
// - statrs `~/.cargo/registry/src/.../statrs-0.18.0/src/function/erf.rs`
//
// Identity: `erfc(x) = 1 - erf(x)`. For large `x` (≈ |x| > 5), `erf`
// approaches ±1 and `erfc` approaches 0/2; statrs handles both via
// stable rational approximation (no naive `1 - erf(x)` cancellation
// at large positive x).

/// **ERF(lower, [upper])** — Gauss error function. **VARIADIC 1-2 args.**
///
/// - 1 arg: returns `erf(lower)` (definite integral from 0 to lower
///   of `(2/√π)·e^(-t²) dt`).
/// - 2 args: returns `erf(upper) - erf(lower)` (definite integral
///   from lower to upper).
/// - Non-finite result → `#NUM!`.
pub fn erf_excel(args: &[Value]) -> Value {
    if !(1..=2).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let lower = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let result = if args.len() == 2 {
        let upper = match coercion::to_number_strict(&args[1]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        };
        erf_fn(upper) - erf_fn(lower)
    } else {
        erf_fn(lower)
    };
    finite_or_num(result)
}

/// **ERF.PRECISE(x)** — alias of `ERF(x)` (1-arg form). Excel 2010
/// introduced `.PRECISE` variants for naming consistency; the impl
/// is identical.
pub fn erf_precise(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    finite_or_num(erf_fn(x))
}

/// **ERFC(x)** — complementary error function = `1 - erf(x)`. statrs
/// computes via stable rational approximation (no cancellation at
/// large positive x).
pub fn erfc_excel(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coercion::to_number_strict(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    finite_or_num(erfc_fn(x))
}

/// **ERFC.PRECISE(x)** — alias of `ERFC(x)`. Same pattern as
/// `ERF.PRECISE`.
pub fn erfc_precise(args: &[Value]) -> Value {
    erfc_excel(args)
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

    // ===== CHISQ.DIST =====
    //
    // Closed-form anchor: chi-squared with df=2 is exponential(1/2),
    // CDF(x) = 1 - exp(-x/2), PDF(x) = 0.5 * exp(-x/2). At x=0:
    // CDF=0, PDF=0.5. At x=2: CDF = 1-e^-1, PDF = 0.5*e^-1.

    #[test]
    fn chisq_dist_cdf_at_zero_returns_zero() {
        assert_close(
            chisq_dist(&[Value::number(0.0), Value::number(1.0), Value::Boolean(true)]),
            0.0,
        );
    }

    #[test]
    fn chisq_dist_pdf_at_zero_df_two_libreoffice_anchor() {
        // For df=2: pdf(0) = 0.5 exactly (exponential(1/2) density at 0).
        assert_close(
            chisq_dist(&[
                Value::number(0.0),
                Value::number(2.0),
                Value::Boolean(false),
            ]),
            0.5,
        );
    }

    #[test]
    fn chisq_dist_cdf_at_two_df_two_libreoffice_anchor() {
        // For df=2: CDF(2) = 1 - e^-1.
        assert_close(
            chisq_dist(&[Value::number(2.0), Value::number(2.0), Value::Boolean(true)]),
            1.0 - (-1.0_f64).exp(),
        );
    }

    #[test]
    fn chisq_dist_libreoffice_anchor_df_one_at_3_84() {
        // CHISQ.DIST(3.841459, 1, TRUE) ≈ 0.95 (standard 5% critical).
        // LibreOffice cross-check: result ≈ 0.95.
        let result = chisq_dist(&[
            Value::number(3.841_458_820_694_124),
            Value::number(1.0),
            Value::Boolean(true),
        ]);
        match result {
            Value::Number(n) => assert!(
                approx(n, 0.95, 1e-9),
                "expected ≈ 0.95, got {n} (diff = {})",
                (n - 0.95).abs()
            ),
            other => panic!("expected Number ≈ 0.95, got {other:?}"),
        }
    }

    #[test]
    fn chisq_dist_negative_x_is_num_error() {
        assert_eq!(
            chisq_dist(&[
                Value::number(-1.0),
                Value::number(1.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_dist_df_less_than_one_is_num_error() {
        assert_eq!(
            chisq_dist(&[Value::number(1.0), Value::number(0.5), Value::Boolean(true)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_dist_df_above_max_is_num_error() {
        // **W5-D-3.1 (Opus LOW-O-6 closure):** reference the named
        // constant rather than the literal `1e11` so a future change
        // to `MAX_CHISQ_DEGREES_OF_FREEDOM` keeps the test aligned.
        assert_eq!(
            chisq_dist(&[
                Value::number(5.0),
                Value::number(super::MAX_CHISQ_DEGREES_OF_FREEDOM + 1.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_dist_text_arg_is_value_error() {
        assert_eq!(
            chisq_dist(&[
                Value::text("nope"),
                Value::number(1.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn chisq_dist_error_arg_propagates() {
        assert_eq!(
            chisq_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn chisq_dist_arity_mismatch_returns_value() {
        assert_eq!(chisq_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            chisq_dist(&[Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            chisq_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== CHISQ.DIST.RT =====

    #[test]
    fn chisq_dist_rt_at_zero_returns_one() {
        // P(X > 0) = 1 for any df.
        assert_close(
            chisq_dist_rt(&[Value::number(0.0), Value::number(1.0)]),
            1.0,
        );
    }

    #[test]
    fn chisq_dist_rt_at_two_df_two_libreoffice_anchor() {
        // P(X > 2) = exp(-1) for df=2 (exponential(1/2)).
        assert_close(
            chisq_dist_rt(&[Value::number(2.0), Value::number(2.0)]),
            (-1.0_f64).exp(),
        );
    }

    #[test]
    fn chisq_dist_rt_libreoffice_anchor_df_one_at_3_84() {
        // P(X > 3.841459) ≈ 0.05 for df=1.
        let result = chisq_dist_rt(&[Value::number(3.841_458_820_694_124), Value::number(1.0)]);
        match result {
            Value::Number(n) => assert!(approx(n, 0.05, 1e-9), "expected ≈ 0.05, got {n}"),
            other => panic!("expected Number ≈ 0.05, got {other:?}"),
        }
    }

    #[test]
    fn chisq_dist_rt_round_trip_with_chisq_dist() {
        // CDF + RT = 1.
        let x = 5.0;
        let df = 10.0;
        let cdf = match chisq_dist(&[Value::number(x), Value::number(df), Value::Boolean(true)]) {
            Value::Number(n) => n,
            other => panic!("CDF returned {other:?}"),
        };
        let rt = match chisq_dist_rt(&[Value::number(x), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("RT returned {other:?}"),
        };
        assert!(approx(cdf + rt, 1.0, 1e-12));
    }

    #[test]
    fn chisq_dist_rt_negative_x_is_num_error() {
        assert_eq!(
            chisq_dist_rt(&[Value::number(-0.5), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_dist_rt_df_less_than_one_is_num_error() {
        assert_eq!(
            chisq_dist_rt(&[Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_dist_rt_text_arg_is_value_error() {
        assert_eq!(
            chisq_dist_rt(&[Value::number(1.0), Value::text("one")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn chisq_dist_rt_error_arg_propagates() {
        assert_eq!(
            chisq_dist_rt(&[Value::Error(ErrorValue::DivZero), Value::number(1.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn chisq_dist_rt_arity_mismatch_returns_value() {
        assert_eq!(chisq_dist_rt(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            chisq_dist_rt(&[Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            chisq_dist_rt(&[Value::number(1.0), Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== CHISQ.INV =====

    #[test]
    fn chisq_inv_at_zero_returns_zero() {
        // CHISQ.INV(0, df) = 0 — note `p == 0` is ACCEPTED (inclusive
        // domain), unlike T.INV / NORM.INV which reject endpoints.
        assert_close(chisq_inv(&[Value::number(0.0), Value::number(1.0)]), 0.0);
    }

    #[test]
    fn chisq_inv_at_one_is_num_error() {
        // **W5-D-3.1 (Opus LOW-O-3 closure):** pin the inclusive-upper
        // boundary `p == 1`. Range check admits 1.0, but
        // `inverse_cdf(1.0)` is non-finite (chi-squared right-tail is
        // unbounded) and the `!result.is_finite()` guard surfaces
        // `#NUM!`. Matches IronCalc.
        assert_eq!(
            chisq_inv(&[Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_at_half_df_two_libreoffice_anchor() {
        // For df=2: CDF(x) = 1 - exp(-x/2) = 0.5 ⇒ x = 2*ln(2).
        assert_close(
            chisq_inv(&[Value::number(0.5), Value::number(2.0)]),
            2.0 * 2.0_f64.ln(),
        );
    }

    #[test]
    fn chisq_inv_95_pct_df_one_libreoffice_anchor() {
        // Classic critical value: CHISQ.INV(0.95, 1) ≈ 3.841458820694124.
        assert_close(
            chisq_inv(&[Value::number(0.95), Value::number(1.0)]),
            3.841_458_820_694_124,
        );
    }

    #[test]
    fn chisq_inv_inverse_of_chisq_dist_round_trip() {
        // chisq_dist(chisq_inv(p, df), df, TRUE) ≈ p.
        let p = 0.73;
        let df = 5.0;
        let x = match chisq_inv(&[Value::number(p), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("CHISQ.INV returned {other:?}"),
        };
        let p_back = match chisq_dist(&[Value::number(x), Value::number(df), Value::Boolean(true)])
        {
            Value::Number(n) => n,
            other => panic!("CHISQ.DIST returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn chisq_inv_p_above_one_is_num_error() {
        // p > 1 outside probability domain.
        assert_eq!(
            chisq_inv(&[Value::number(1.5), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_p_negative_is_num_error() {
        assert_eq!(
            chisq_inv(&[Value::number(-0.1), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_df_less_than_one_is_num_error() {
        assert_eq!(
            chisq_inv(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_text_arg_is_value_error() {
        assert_eq!(
            chisq_inv(&[Value::text("half"), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn chisq_inv_error_arg_propagates() {
        assert_eq!(
            chisq_inv(&[Value::Error(ErrorValue::Ref), Value::number(1.0)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn chisq_inv_arity_mismatch_returns_value() {
        assert_eq!(chisq_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            chisq_inv(&[Value::number(0.5)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            chisq_inv(&[Value::number(0.5), Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== CHISQ.INV.RT =====

    #[test]
    fn chisq_inv_rt_at_one_returns_zero() {
        // P(X > x) = 1 ⇒ x = 0.
        assert_close(chisq_inv_rt(&[Value::number(1.0), Value::number(1.0)]), 0.0);
    }

    #[test]
    fn chisq_inv_rt_at_zero_prob_is_num_error() {
        // **W5-D-3.1 (Codex LOW-2 + Opus LOW-O-3 closure):** the range
        // check `0.0..=1.0` admits `p == 0`, but the next line computes
        // `inverse_cdf(1.0 - 0.0) = inverse_cdf(1.0)` which is non-finite
        // for the unbounded-right chi-squared. The `!result.is_finite()`
        // guard surfaces `#NUM!`. This test pins that
        // domain-accepted-but-observably-#NUM! behavior so the coverage
        // docs claim of "p=0 ACCEPTED" cannot be misread as "p=0 returns
        // a finite value".
        assert_eq!(
            chisq_inv_rt(&[Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_rt_at_half_df_two_libreoffice_anchor() {
        // For df=2: same as CHISQ.INV(0.5, 2) by symmetry through
        // p ↔ 1-p substitution. Result: 2*ln(2).
        assert_close(
            chisq_inv_rt(&[Value::number(0.5), Value::number(2.0)]),
            2.0 * 2.0_f64.ln(),
        );
    }

    #[test]
    fn chisq_inv_rt_5_pct_df_one_libreoffice_anchor() {
        // CHISQ.INV.RT(0.05, 1) ≈ 3.841459 (same as CHISQ.INV(0.95, 1)
        // by definition).
        assert_close(
            chisq_inv_rt(&[Value::number(0.05), Value::number(1.0)]),
            3.841_458_820_694_124,
        );
    }

    #[test]
    fn chisq_inv_rt_round_trip_with_chisq_dist_rt() {
        // chisq_dist_rt(chisq_inv_rt(p, df), df) ≈ p.
        let p = 0.10;
        let df = 7.0;
        let x = match chisq_inv_rt(&[Value::number(p), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("CHISQ.INV.RT returned {other:?}"),
        };
        let p_back = match chisq_dist_rt(&[Value::number(x), Value::number(df)]) {
            Value::Number(n) => n,
            other => panic!("CHISQ.DIST.RT returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn chisq_inv_rt_p_above_one_is_num_error() {
        assert_eq!(
            chisq_inv_rt(&[Value::number(1.5), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_rt_p_negative_is_num_error() {
        assert_eq!(
            chisq_inv_rt(&[Value::number(-0.1), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_rt_df_less_than_one_is_num_error() {
        assert_eq!(
            chisq_inv_rt(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn chisq_inv_rt_text_arg_is_value_error() {
        assert_eq!(
            chisq_inv_rt(&[Value::number(0.5), Value::text("ten")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn chisq_inv_rt_error_arg_propagates() {
        assert_eq!(
            chisq_inv_rt(&[Value::Error(ErrorValue::DivZero), Value::number(1.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn chisq_inv_rt_arity_mismatch_returns_value() {
        assert_eq!(chisq_inv_rt(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            chisq_inv_rt(&[Value::number(0.5)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            chisq_inv_rt(&[Value::number(0.5), Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== F.DIST =====
    //
    // F-distribution symmetry: F(df1, df2) with df1=df2 has F(1)=0.5
    // by CDF symmetry. Useful as a closed-form anchor.

    #[test]
    fn f_dist_cdf_at_zero_returns_zero() {
        assert_close(
            f_dist(&[
                Value::number(0.0),
                Value::number(5.0),
                Value::number(10.0),
                Value::Boolean(true),
            ]),
            0.0,
        );
    }

    #[test]
    fn f_dist_cdf_at_one_equal_dfs_is_half() {
        // F(df1, df2) with df1=df2: P(F<=1) = 0.5 by CDF symmetry around 1.
        assert_close(
            f_dist(&[
                Value::number(1.0),
                Value::number(10.0),
                Value::number(10.0),
                Value::Boolean(true),
            ]),
            0.5,
        );
    }

    #[test]
    fn f_dist_pdf_at_one_equal_dfs_closed_form() {
        // **W5-D-3.1 (Opus MEDIUM-O-3 closure):** strengthened from a
        // bare positive-finite check to a closed-form anchor.
        //
        // For F(n, n) at x=1, the PDF simplifies to a closed form via
        // the Beta-function ratio. For n=10:
        //   pdf(1) = (1 / B(5, 5)) * (5^10 / 10^10)
        //          = (1 / B(5, 5)) * (1/2)^10
        //          = (1 / B(5, 5)) / 1024
        //   B(5, 5) = Γ(5)·Γ(5) / Γ(10) = (4!)^2 / 9! = 576 / 362880
        //          = 1/630
        //   ⇒ pdf(1) = 630 / 1024 = 0.615234375 (exact).
        assert_close(
            f_dist(&[
                Value::number(1.0),
                Value::number(10.0),
                Value::number(10.0),
                Value::Boolean(false),
            ]),
            630.0 / 1024.0,
        );
    }

    #[test]
    fn f_dist_statrs_self_consistent_95th_percentile_round_trip() {
        // **W5-D-3.1 (Opus LOW-O-5 closure):** renamed from
        // `f_dist_libreoffice_anchor_5_10_at_3_3258` to reflect what
        // this test actually pins. It is NOT a LibreOffice anchor —
        // it's a self-consistency pin against statrs's own F.INV value.
        //
        // F.DIST(x, 5, 10, TRUE) ≈ 0.95 at the statrs-computed 95th
        // percentile. Input is statrs's own F.INV(0.95, 5, 10) value
        // (`3.3258345304130046`); statrs's F.INV is approximate
        // (Newton-Raphson) and diverges from the true mathematical
        // value (`3.325835018413022` per R/LibreOffice) by ~5e-7. By
        // using statrs's self-consistent value the CDF round-trip is
        // exact to 1e-12 — pinning *statrs's internal consistency*
        // rather than agreement with an external reference. The
        // `f_inv_inverse_of_f_dist_round_trip` test elsewhere pins the
        // generic property; this one targets the specific 95th-pct
        // critical value.
        let result = f_dist(&[
            Value::number(3.325_834_530_413_004_6),
            Value::number(5.0),
            Value::number(10.0),
            Value::Boolean(true),
        ]);
        match result {
            Value::Number(n) => assert!(approx(n, 0.95, 1e-9), "expected ≈ 0.95, got {n}"),
            other => panic!("expected Number ≈ 0.95, got {other:?}"),
        }
    }

    #[test]
    fn f_dist_negative_x_is_num_error() {
        assert_eq!(
            f_dist(&[
                Value::number(-1.0),
                Value::number(5.0),
                Value::number(10.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_dist_df_less_than_one_is_num_error() {
        // df1 < 1.
        assert_eq!(
            f_dist(&[
                Value::number(1.0),
                Value::number(0.5),
                Value::number(10.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Num)
        );
        // df2 < 1.
        assert_eq!(
            f_dist(&[
                Value::number(1.0),
                Value::number(5.0),
                Value::number(0.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_dist_text_arg_is_value_error() {
        assert_eq!(
            f_dist(&[
                Value::text("nope"),
                Value::number(5.0),
                Value::number(10.0),
                Value::Boolean(true)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn f_dist_error_arg_propagates() {
        assert_eq!(
            f_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(5.0),
                Value::number(10.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn f_dist_arity_mismatch_returns_value() {
        assert_eq!(f_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            f_dist(&[Value::number(1.0), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            f_dist(&[
                Value::number(1.0),
                Value::number(5.0),
                Value::number(10.0),
                Value::Boolean(true),
                Value::number(0.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== F.DIST.RT =====

    #[test]
    fn f_dist_rt_at_zero_returns_one() {
        assert_close(
            f_dist_rt(&[Value::number(0.0), Value::number(5.0), Value::number(10.0)]),
            1.0,
        );
    }

    #[test]
    fn f_dist_rt_at_one_equal_dfs_is_half() {
        assert_close(
            f_dist_rt(&[Value::number(1.0), Value::number(10.0), Value::number(10.0)]),
            0.5,
        );
    }

    #[test]
    fn f_dist_rt_statrs_self_consistent_5_pct_round_trip() {
        // **W5-D-3.1 (Opus LOW-O-5 closure):** renamed from
        // `f_dist_rt_libreoffice_anchor_5_10_at_3_3258`. Same
        // self-consistency note as
        // `f_dist_statrs_self_consistent_95th_percentile_round_trip`:
        // input is statrs's own F.INV value, not the true F-math 95th
        // percentile. Pins statrs's internal consistency (CDF + RT = 1
        // at statrs's inverse value).
        let result = f_dist_rt(&[
            Value::number(3.325_834_530_413_004_6),
            Value::number(5.0),
            Value::number(10.0),
        ]);
        match result {
            Value::Number(n) => assert!(approx(n, 0.05, 1e-9), "expected ≈ 0.05, got {n}"),
            other => panic!("expected Number ≈ 0.05, got {other:?}"),
        }
    }

    #[test]
    fn f_dist_rt_round_trip_with_f_dist() {
        // CDF + RT = 1.
        let x = 2.5;
        let df1 = 5.0;
        let df2 = 10.0;
        let cdf = match f_dist(&[
            Value::number(x),
            Value::number(df1),
            Value::number(df2),
            Value::Boolean(true),
        ]) {
            Value::Number(n) => n,
            other => panic!("F.DIST returned {other:?}"),
        };
        let rt = match f_dist_rt(&[Value::number(x), Value::number(df1), Value::number(df2)]) {
            Value::Number(n) => n,
            other => panic!("F.DIST.RT returned {other:?}"),
        };
        assert!(approx(cdf + rt, 1.0, 1e-12));
    }

    #[test]
    fn f_dist_rt_negative_x_is_num_error() {
        assert_eq!(
            f_dist_rt(&[Value::number(-1.0), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_dist_rt_df_less_than_one_is_num_error() {
        assert_eq!(
            f_dist_rt(&[Value::number(1.0), Value::number(0.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_dist_rt_text_arg_is_value_error() {
        assert_eq!(
            f_dist_rt(&[Value::number(1.0), Value::text("five"), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn f_dist_rt_error_arg_propagates() {
        assert_eq!(
            f_dist_rt(&[
                Value::Error(ErrorValue::DivZero),
                Value::number(5.0),
                Value::number(10.0),
            ]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn f_dist_rt_arity_mismatch_returns_value() {
        assert_eq!(f_dist_rt(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            f_dist_rt(&[Value::number(1.0), Value::number(5.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            f_dist_rt(&[
                Value::number(1.0),
                Value::number(5.0),
                Value::number(10.0),
                Value::number(0.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== F.INV =====

    #[test]
    fn f_inv_at_zero_returns_zero() {
        // F.INV(0, df1, df2) = 0 (p == 0 ACCEPTED, inclusive domain).
        assert_close(
            f_inv(&[Value::number(0.0), Value::number(5.0), Value::number(10.0)]),
            0.0,
        );
    }

    #[test]
    fn f_inv_at_one_is_num_error() {
        // **W5-D-3.1 (Opus LOW-O-3 closure):** pin inclusive-upper
        // boundary `p == 1`. Range check admits 1.0, but
        // `inverse_cdf(1.0)` is non-finite (F right-tail is unbounded)
        // and the `!result.is_finite()` guard surfaces `#NUM!`.
        assert_eq!(
            f_inv(&[Value::number(1.0), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_at_half_equal_dfs_returns_one() {
        // F(df1=df2) median is 1.
        assert_close(
            f_inv(&[Value::number(0.5), Value::number(10.0), Value::number(10.0)]),
            1.0,
        );
    }

    #[test]
    fn f_inv_libreoffice_anchor_95_pct_5_10() {
        // F.INV(0.95, 5, 10) → statrs's internal Newton-Raphson result
        // `3.3258345304130046`. True mathematical value (per
        // R/LibreOffice) is `3.325835018413022` — statrs's approximation
        // diverges by ~5e-7. We pin statrs's value (= IronCalc's value)
        // since both projects use the same statrs 0.18.0 pin and thus
        // the same numerical kernel.
        assert_close(
            f_inv(&[Value::number(0.95), Value::number(5.0), Value::number(10.0)]),
            3.325_834_530_413_004_6,
        );
    }

    #[test]
    fn f_inv_inverse_of_f_dist_round_trip() {
        // f_dist(f_inv(p, df1, df2), df1, df2, TRUE) ≈ p.
        let p = 0.73;
        let df1 = 5.0;
        let df2 = 10.0;
        let x = match f_inv(&[Value::number(p), Value::number(df1), Value::number(df2)]) {
            Value::Number(n) => n,
            other => panic!("F.INV returned {other:?}"),
        };
        let p_back = match f_dist(&[
            Value::number(x),
            Value::number(df1),
            Value::number(df2),
            Value::Boolean(true),
        ]) {
            Value::Number(n) => n,
            other => panic!("F.DIST returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn f_inv_p_above_one_is_num_error() {
        assert_eq!(
            f_inv(&[Value::number(1.5), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_p_negative_is_num_error() {
        assert_eq!(
            f_inv(&[Value::number(-0.1), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_df_less_than_one_is_num_error() {
        assert_eq!(
            f_inv(&[Value::number(0.5), Value::number(0.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_text_arg_is_value_error() {
        assert_eq!(
            f_inv(&[Value::text("half"), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn f_inv_error_arg_propagates() {
        assert_eq!(
            f_inv(&[
                Value::Error(ErrorValue::Ref),
                Value::number(5.0),
                Value::number(10.0)
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn f_inv_arity_mismatch_returns_value() {
        assert_eq!(f_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            f_inv(&[Value::number(0.5), Value::number(5.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            f_inv(&[
                Value::number(0.5),
                Value::number(5.0),
                Value::number(10.0),
                Value::number(0.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== F.INV.RT =====

    #[test]
    fn f_inv_rt_at_one_returns_zero() {
        // p=1 (upper-inclusive per IronCalc canon) → x=0.
        assert_close(
            f_inv_rt(&[Value::number(1.0), Value::number(5.0), Value::number(10.0)]),
            0.0,
        );
    }

    #[test]
    fn f_inv_rt_at_half_equal_dfs_returns_one() {
        assert_close(
            f_inv_rt(&[Value::number(0.5), Value::number(10.0), Value::number(10.0)]),
            1.0,
        );
    }

    #[test]
    fn f_inv_rt_libreoffice_anchor_5_pct_5_10() {
        // F.INV.RT(0.05, 5, 10) = F.INV(0.95, 5, 10) by definition.
        // Pins statrs's internal value (= IronCalc's value); see
        // `f_inv_libreoffice_anchor_95_pct_5_10` for the statrs vs
        // true-F-distribution divergence note.
        assert_close(
            f_inv_rt(&[Value::number(0.05), Value::number(5.0), Value::number(10.0)]),
            3.325_834_530_413_004_6,
        );
    }

    #[test]
    fn f_inv_rt_round_trip_with_f_dist_rt() {
        // f_dist_rt(f_inv_rt(p, df1, df2), df1, df2) ≈ p.
        let p = 0.10;
        let df1 = 7.0;
        let df2 = 15.0;
        let x = match f_inv_rt(&[Value::number(p), Value::number(df1), Value::number(df2)]) {
            Value::Number(n) => n,
            other => panic!("F.INV.RT returned {other:?}"),
        };
        let p_back = match f_dist_rt(&[Value::number(x), Value::number(df1), Value::number(df2)]) {
            Value::Number(n) => n,
            other => panic!("F.DIST.RT returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn f_inv_rt_at_zero_prob_is_num_error() {
        // p=0 REJECTED (lower-strict, unlike F.INV/CHISQ.INV which
        // accept p=0). Matches IronCalc canon.
        assert_eq!(
            f_inv_rt(&[Value::number(0.0), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_rt_p_negative_is_num_error() {
        // **W5-D-3.1 (Codex LOW-4 closure):** pin negative-p rejection
        // independently of the p=0 boundary. Without this test, a
        // future edit that flipped `p <= 0.0` to `p < 0.0` (admitting
        // exactly zero) wouldn't be caught — the `p=0` test would
        // start passing for the wrong reason.
        assert_eq!(
            f_inv_rt(&[Value::number(-0.1), Value::number(5.0), Value::number(10.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_rt_p_above_one_is_num_error() {
        assert_eq!(
            f_inv_rt(&[Value::number(1.5), Value::number(5.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_rt_df_less_than_one_is_num_error() {
        assert_eq!(
            f_inv_rt(&[Value::number(0.5), Value::number(0.0), Value::number(10.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn f_inv_rt_text_arg_is_value_error() {
        assert_eq!(
            f_inv_rt(&[Value::number(0.5), Value::text("five"), Value::number(10.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn f_inv_rt_error_arg_propagates() {
        assert_eq!(
            f_inv_rt(&[
                Value::Error(ErrorValue::DivZero),
                Value::number(5.0),
                Value::number(10.0),
            ]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn f_inv_rt_arity_mismatch_returns_value() {
        assert_eq!(f_inv_rt(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            f_inv_rt(&[Value::number(0.5), Value::number(5.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            f_inv_rt(&[
                Value::number(0.5),
                Value::number(5.0),
                Value::number(10.0),
                Value::number(0.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== BINOM.DIST =====
    //
    // Closed-form anchors: for n=10, p=0.5, pmf(k) = C(10, k) / 1024.
    // pmf(0) = 1/1024, pmf(5) = 252/1024, pmf(10) = 1/1024.
    // CDF(k) = sum_{i=0..k} pmf(i).

    #[test]
    fn binom_dist_pmf_at_zero_n_10_p_half_closed_form() {
        // pmf(0; 10, 0.5) = 0.5^10 = 1/1024.
        assert_close(
            binom_dist(&[
                Value::number(0.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            1.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_pmf_at_five_n_10_p_half_closed_form() {
        // pmf(5; 10, 0.5) = C(10, 5) / 1024 = 252/1024.
        assert_close(
            binom_dist(&[
                Value::number(5.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            252.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_cdf_at_n_returns_one() {
        // CDF(10; 10, 0.5) = 1.0 (all outcomes).
        assert_close(
            binom_dist(&[
                Value::number(10.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            1.0,
        );
    }

    #[test]
    fn binom_dist_cdf_at_zero_equals_pmf_zero() {
        // CDF(0) = pmf(0) = 1/1024.
        assert_close(
            binom_dist(&[
                Value::number(0.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            1.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_k_greater_than_n_is_num_error() {
        assert_eq!(
            binom_dist(&[
                Value::number(11.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_dist_p_outside_unit_is_num_error() {
        // p > 1.
        assert_eq!(
            binom_dist(&[
                Value::number(5.0),
                Value::number(10.0),
                Value::number(1.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // p < 0.
        assert_eq!(
            binom_dist(&[
                Value::number(5.0),
                Value::number(10.0),
                Value::number(-0.1),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_dist_negative_k_is_num_error() {
        assert_eq!(
            binom_dist(&[
                Value::number(-1.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_dist_trials_at_u64_max_boundary_is_num_error() {
        // **W5-D-4.1 (Codex MEDIUM-1 + Opus MEDIUM-O-1 closure):**
        // `u64::MAX as f64` rounds up to `2^64` in IEEE-754. The
        // `to_u64_index` helper uses `>=` not `>` to reject this
        // boundary value cleanly. With the looser `>` check, `2^64.0`
        // would pass the guard and `as u64` would silently saturate
        // to `u64::MAX`. This test pins the boundary rejection.
        let two_pow_64 = u64::MAX as f64; // = 2^64.0 due to f64 rounding
        assert_eq!(
            binom_dist(&[
                Value::number(0.0),
                Value::number(two_pow_64),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_dist_text_arg_is_value_error() {
        assert_eq!(
            binom_dist(&[
                Value::text("nope"),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn binom_dist_error_arg_propagates() {
        assert_eq!(
            binom_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn binom_dist_arity_mismatch_returns_value() {
        assert_eq!(binom_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            binom_dist(&[Value::number(5.0), Value::number(10.0), Value::number(0.5),]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            binom_dist(&[
                Value::number(5.0),
                Value::number(10.0),
                Value::number(0.5),
                Value::Boolean(true),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== BINOM.DIST.RANGE =====

    #[test]
    fn binom_dist_range_full_returns_one() {
        // [0, 10] covers all outcomes — sum = 1.
        assert_close(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(0.0),
                Value::number(10.0),
            ]),
            1.0,
        );
    }

    #[test]
    fn binom_dist_range_single_point_equals_pmf() {
        // [5, 5] = pmf(5) = 252/1024.
        assert_close(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(5.0),
                Value::number(5.0),
            ]),
            252.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_range_three_arg_form_is_single_point() {
        // When number_s2 omitted, defaults to number_s — same as
        // [number_s, number_s] = pmf(number_s).
        assert_close(
            binom_dist_range(&[Value::number(10.0), Value::number(0.5), Value::number(5.0)]),
            252.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_range_middle_window_4_to_6() {
        // [4, 6] = pmf(4) + pmf(5) + pmf(6)
        //        = (210 + 252 + 210) / 1024 = 672/1024.
        assert_close(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(4.0),
                Value::number(6.0),
            ]),
            672.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_range_lower_zero_equals_cdf_upper() {
        // [0, k] = CDF(k). This pins the `if lower == 0` branch in
        // the impl that avoids the `cdf(0 - 1)` branch (would
        // debug-panic / release-wrap on u64).
        // CDF(5; 10, 0.5) = 638/1024.
        assert_close(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(0.0),
                Value::number(5.0),
            ]),
            638.0 / 1024.0,
        );
    }

    #[test]
    fn binom_dist_range_lower_above_upper_is_num_error() {
        assert_eq!(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(6.0),
                Value::number(4.0),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_dist_range_upper_above_trials_is_num_error() {
        assert_eq!(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(5.0),
                Value::number(11.0),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_dist_range_text_arg_is_value_error() {
        assert_eq!(
            binom_dist_range(&[Value::text("ten"), Value::number(0.5), Value::number(0.0),]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn binom_dist_range_error_arg_propagates() {
        assert_eq!(
            binom_dist_range(&[
                Value::Error(ErrorValue::DivZero),
                Value::number(0.5),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn binom_dist_range_arity_mismatch_returns_value() {
        assert_eq!(binom_dist_range(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            binom_dist_range(&[Value::number(10.0), Value::number(0.5)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            binom_dist_range(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(0.0),
                Value::number(5.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== BINOM.INV =====

    #[test]
    fn binom_inv_smallest_k_with_cdf_at_least_half() {
        // CDF(5; 10, 0.5) = 638/1024 ≈ 0.623 — first k where CDF >= 0.5.
        // (CDF(4) = 386/1024 ≈ 0.377.)
        assert_close(
            binom_inv(&[Value::number(10.0), Value::number(0.5), Value::number(0.5)]),
            5.0,
        );
    }

    #[test]
    fn binom_inv_small_alpha_returns_small_k() {
        // alpha = 0.001: CDF(0) = 1/1024 ≈ 0.000977 < 0.001;
        // CDF(1) = 11/1024 ≈ 0.01074 >= 0.001 ⇒ k = 1.
        assert_close(
            binom_inv(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(0.001),
            ]),
            1.0,
        );
    }

    #[test]
    fn binom_inv_p_one_returns_trials() {
        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-2 closure):**
        // p = 1 ACCEPTED per Microsoft canon (inclusive upper). At p=1
        // the binomial is deterministic at n (every trial succeeds),
        // so `inverse_cdf(any alpha in (0,1))` = n exactly. Prior
        // strict-upper `(0.0..1.0)` half-open range incorrectly
        // rejected this valid input.
        assert_close(
            binom_inv(&[Value::number(10.0), Value::number(1.0), Value::number(0.5)]),
            10.0,
        );
        // Edge: alpha near upper limit.
        assert_close(
            binom_inv(&[Value::number(7.0), Value::number(1.0), Value::number(0.99)]),
            7.0,
        );
        // Edge: alpha near lower limit.
        assert_close(
            binom_inv(&[Value::number(3.0), Value::number(1.0), Value::number(0.01)]),
            3.0,
        );
    }

    #[test]
    fn binom_inv_p_zero_accepted_but_returns_zero() {
        // p = 0 ACCEPTED (inclusive lower). Binomial with p=0 is
        // degenerate at 0, so inverse_cdf(any alpha) = 0.
        assert_close(
            binom_inv(&[Value::number(10.0), Value::number(0.0), Value::number(0.5)]),
            0.0,
        );
    }

    #[test]
    fn binom_inv_trials_zero_returns_zero_panic_regression() {
        // **W5-D-4.1 (Codex HIGH-1 + Opus HIGH-O-1 closure):** trials=0
        // is also a degenerate Binomial distribution (single point at
        // 0, regardless of p). Without the inline `n == 0`
        // short-circuit, statrs's `DiscreteCDF::inverse_cdf` panics
        // via `integral_bisection_search` returning `None`. This
        // regression test pins the panic-avoidance behavior.
        assert_close(
            binom_inv(&[Value::number(0.0), Value::number(0.5), Value::number(0.5)]),
            0.0,
        );
    }

    #[test]
    fn binom_dist_trials_zero_degenerate_pmf_at_zero() {
        // **W5-D-4.1 (Opus LOW-O-4 closure):** BINOM.DIST with
        // trials=0 (degenerate single-point at 0). statrs's
        // `Binomial::pmf(0)` with n=0 returns 1.0. Pins this
        // non-panicking degenerate corner so a future change to
        // `binom_dist` can't regress.
        assert_close(
            binom_dist(&[
                Value::number(0.0),
                Value::number(0.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            1.0,
        );
        // CDF(0; 0, p) = 1.0 (all probability at the only outcome).
        assert_close(
            binom_dist(&[
                Value::number(0.0),
                Value::number(0.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            1.0,
        );
    }

    #[test]
    fn binom_inv_alpha_outside_strict_unit_is_num_error() {
        // alpha = 0 STRICT lower.
        assert_eq!(
            binom_inv(&[Value::number(10.0), Value::number(0.5), Value::number(0.0),]),
            Value::Error(ErrorValue::Num)
        );
        // alpha = 1 STRICT upper.
        assert_eq!(
            binom_inv(&[Value::number(10.0), Value::number(0.5), Value::number(1.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_inv_negative_trials_is_num_error() {
        assert_eq!(
            binom_inv(&[Value::number(-1.0), Value::number(0.5), Value::number(0.5),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn binom_inv_text_arg_is_value_error() {
        assert_eq!(
            binom_inv(&[Value::text("ten"), Value::number(0.5), Value::number(0.5),]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn binom_inv_error_arg_propagates() {
        assert_eq!(
            binom_inv(&[
                Value::Error(ErrorValue::Ref),
                Value::number(0.5),
                Value::number(0.5),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn binom_inv_arity_mismatch_returns_value() {
        assert_eq!(binom_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            binom_inv(&[Value::number(10.0), Value::number(0.5)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            binom_inv(&[
                Value::number(10.0),
                Value::number(0.5),
                Value::number(0.5),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== NEGBINOM.DIST =====
    //
    // NegativeBinomial(r=successes, p): NEGBINOM.DIST(f, r, p,
    // cumulative) where f=failures. For r=1, p=0.5: pmf(0) = p^1 = 0.5
    // (probability of 0 failures before 1st success), pmf(1) =
    // (1-p)*p = 0.25, pmf(2) = (1-p)^2 * p = 0.125.

    #[test]
    fn negbinom_dist_pmf_at_zero_r_1_p_half_closed_form() {
        // pmf(0; r=1, p=0.5) = 0.5^1 = 0.5.
        assert_close(
            negbinom_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            0.5,
        );
    }

    #[test]
    fn negbinom_dist_pmf_at_one_r_1_p_half_closed_form() {
        // pmf(1; r=1, p=0.5) = 0.5 * 0.5 = 0.25.
        assert_close(
            negbinom_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            0.25,
        );
    }

    #[test]
    fn negbinom_dist_cdf_at_zero_r_1_p_half_closed_form() {
        // CDF(0) = pmf(0) = 0.5.
        assert_close(
            negbinom_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(true),
            ]),
            0.5,
        );
    }

    #[test]
    fn negbinom_dist_number_s_less_than_one_is_num_error() {
        assert_eq!(
            negbinom_dist(&[
                Value::number(0.0),
                Value::number(0.5),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn negbinom_dist_p_at_endpoints_is_num_error() {
        // p = 0 STRICT lower.
        assert_eq!(
            negbinom_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.0),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // p = 1 STRICT upper.
        assert_eq!(
            negbinom_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn negbinom_dist_negative_failures_is_num_error() {
        assert_eq!(
            negbinom_dist(&[
                Value::number(-1.0),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn negbinom_dist_text_arg_is_value_error() {
        assert_eq!(
            negbinom_dist(&[
                Value::text("nope"),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn negbinom_dist_error_arg_propagates() {
        assert_eq!(
            negbinom_dist(&[
                Value::Error(ErrorValue::DivZero),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn negbinom_dist_arity_mismatch_returns_value() {
        assert_eq!(negbinom_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            negbinom_dist(&[Value::number(0.0), Value::number(1.0), Value::number(0.5),]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            negbinom_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.5),
                Value::Boolean(false),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== POISSON.DIST =====

    #[test]
    fn poisson_dist_pmf_at_zero_lambda_one_closed_form() {
        // pmf(0; λ=1) = e^-1 ≈ 0.367879441.
        assert_close(
            poisson_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            (-1.0_f64).exp(),
        );
    }

    #[test]
    fn poisson_dist_cdf_at_one_lambda_one_closed_form() {
        // CDF(1; λ=1) = pmf(0) + pmf(1) = e^-1 + e^-1 = 2*e^-1.
        assert_close(
            poisson_dist(&[Value::number(1.0), Value::number(1.0), Value::Boolean(true)]),
            2.0 * (-1.0_f64).exp(),
        );
    }

    #[test]
    fn poisson_dist_lambda_zero_degenerate_pmf_at_zero() {
        // Special case: λ=0 → degenerate at 0. P(X=0) = 1, P(X>0) = 0.
        assert_close(
            poisson_dist(&[
                Value::number(0.0),
                Value::number(0.0),
                Value::Boolean(false),
            ]),
            1.0,
        );
    }

    #[test]
    fn poisson_dist_lambda_zero_degenerate_pmf_at_positive_k() {
        assert_close(
            poisson_dist(&[
                Value::number(5.0),
                Value::number(0.0),
                Value::Boolean(false),
            ]),
            0.0,
        );
    }

    #[test]
    fn poisson_dist_lambda_zero_degenerate_cdf_at_any_k() {
        // CDF for degenerate is 1.0 for any k >= 0.
        assert_close(
            poisson_dist(&[Value::number(5.0), Value::number(0.0), Value::Boolean(true)]),
            1.0,
        );
    }

    #[test]
    fn poisson_dist_negative_x_is_num_error() {
        assert_eq!(
            poisson_dist(&[
                Value::number(-1.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn poisson_dist_negative_lambda_is_num_error() {
        assert_eq!(
            poisson_dist(&[
                Value::number(0.0),
                Value::number(-0.5),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn poisson_dist_text_arg_is_value_error() {
        assert_eq!(
            poisson_dist(&[
                Value::text("five"),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn poisson_dist_error_arg_propagates() {
        assert_eq!(
            poisson_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn poisson_dist_arity_mismatch_returns_value() {
        assert_eq!(poisson_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            poisson_dist(&[Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            poisson_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== EXPON.DIST =====
    //
    // Closed-form: CDF(x) = 1 - exp(-λx), PDF(x) = λ·exp(-λx).

    #[test]
    fn expon_dist_pdf_at_zero_lambda_one_closed_form() {
        // PDF(0; λ=1) = 1 * exp(0) = 1.
        assert_close(
            expon_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            1.0,
        );
    }

    #[test]
    fn expon_dist_cdf_at_zero_returns_zero() {
        assert_close(
            expon_dist(&[Value::number(0.0), Value::number(1.0), Value::Boolean(true)]),
            0.0,
        );
    }

    #[test]
    fn expon_dist_cdf_at_one_lambda_one_closed_form() {
        // CDF(1; λ=1) = 1 - e^-1.
        assert_close(
            expon_dist(&[Value::number(1.0), Value::number(1.0), Value::Boolean(true)]),
            1.0 - (-1.0_f64).exp(),
        );
    }

    #[test]
    fn expon_dist_pdf_at_one_lambda_one_closed_form() {
        // PDF(1; λ=1) = 1 * e^-1.
        assert_close(
            expon_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            (-1.0_f64).exp(),
        );
    }

    #[test]
    fn expon_dist_lambda_2_at_1_cdf() {
        // CDF(1; λ=2) = 1 - e^-2.
        assert_close(
            expon_dist(&[Value::number(1.0), Value::number(2.0), Value::Boolean(true)]),
            1.0 - (-2.0_f64).exp(),
        );
    }

    #[test]
    fn expon_dist_negative_x_is_num_error() {
        assert_eq!(
            expon_dist(&[
                Value::number(-1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn expon_dist_lambda_zero_or_negative_is_num_error() {
        // λ = 0 STRICT.
        assert_eq!(
            expon_dist(&[Value::number(1.0), Value::number(0.0), Value::Boolean(true),]),
            Value::Error(ErrorValue::Num)
        );
        // λ < 0.
        assert_eq!(
            expon_dist(&[
                Value::number(1.0),
                Value::number(-0.5),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn expon_dist_text_arg_is_value_error() {
        assert_eq!(
            expon_dist(&[Value::text("x"), Value::number(1.0), Value::Boolean(true),]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn expon_dist_error_arg_propagates() {
        assert_eq!(
            expon_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn expon_dist_arity_mismatch_returns_value() {
        assert_eq!(expon_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            expon_dist(&[Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            expon_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== LOGNORM.DIST =====
    //
    // LogNormal(μ, σ): X = exp(N(μ, σ²)). For μ=0, σ=1 at x=1:
    // CDF(1) = Φ((ln(1) - 0)/1) = Φ(0) = 0.5.
    // PDF(1) = 1/(x·σ·√(2π)) · exp(-(ln(x)-μ)²/(2σ²))
    //        = 1/(1 · 1 · √(2π)) · exp(0) = 1/√(2π).

    #[test]
    fn lognorm_dist_cdf_at_one_standard_returns_half() {
        // CDF(1; μ=0, σ=1) = Φ(0) = 0.5.
        assert_close(
            lognorm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            0.5,
        );
    }

    #[test]
    fn lognorm_dist_pdf_at_one_standard_closed_form() {
        // PDF(1; μ=0, σ=1) = 1/√(2π) ≈ 0.39894228.
        assert_close(
            lognorm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            1.0 / (2.0 * std::f64::consts::PI).sqrt(),
        );
    }

    #[test]
    fn lognorm_dist_negative_mean_accepted() {
        // mean (μ) may be negative (it's the underlying normal's mean).
        // Sanity: positive result for valid inputs.
        let result = lognorm_dist(&[
            Value::number(1.0),
            Value::number(-2.0),
            Value::number(1.0),
            Value::Boolean(true),
        ]);
        match result {
            Value::Number(n) => {
                assert!((0.0..=1.0).contains(&n), "CDF out of range: {n}");
            }
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn lognorm_dist_x_zero_or_negative_is_num_error() {
        // x = 0 STRICT (log-normal undefined at 0).
        assert_eq!(
            lognorm_dist(&[
                Value::number(0.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // x < 0.
        assert_eq!(
            lognorm_dist(&[
                Value::number(-1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn lognorm_dist_sd_zero_or_negative_is_num_error() {
        assert_eq!(
            lognorm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(0.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            lognorm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(-1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn lognorm_dist_text_arg_is_value_error() {
        assert_eq!(
            lognorm_dist(&[
                Value::text("x"),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn lognorm_dist_error_arg_propagates() {
        assert_eq!(
            lognorm_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn lognorm_dist_arity_mismatch_returns_value() {
        assert_eq!(lognorm_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            lognorm_dist(&[Value::number(1.0), Value::number(0.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            lognorm_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== LOGNORM.INV =====

    #[test]
    fn lognorm_inv_median_at_half_returns_exp_mean() {
        // LogNormal median = exp(μ). For μ=0: median = 1.
        assert_close(
            lognorm_inv(&[Value::number(0.5), Value::number(0.0), Value::number(1.0)]),
            1.0,
        );
    }

    #[test]
    fn lognorm_inv_median_with_nonzero_mean() {
        // LogNormal(μ=5, σ=1) median = exp(5) ≈ 148.413159.
        assert_close(
            lognorm_inv(&[Value::number(0.5), Value::number(5.0), Value::number(1.0)]),
            5.0_f64.exp(),
        );
    }

    #[test]
    fn lognorm_inv_inverse_of_lognorm_dist_round_trip() {
        // lognorm_dist(lognorm_inv(p, μ, σ), μ, σ, TRUE) ≈ p.
        let p = 0.73;
        let mean = 1.5;
        let sd = 0.5;
        let x = match lognorm_inv(&[Value::number(p), Value::number(mean), Value::number(sd)]) {
            Value::Number(n) => n,
            other => panic!("LOGNORM.INV returned {other:?}"),
        };
        let p_back = match lognorm_dist(&[
            Value::number(x),
            Value::number(mean),
            Value::number(sd),
            Value::Boolean(true),
        ]) {
            Value::Number(n) => n,
            other => panic!("LOGNORM.DIST returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn lognorm_inv_p_at_endpoints_is_num_error() {
        // p = 0 STRICT lower.
        assert_eq!(
            lognorm_inv(&[Value::number(0.0), Value::number(0.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Num)
        );
        // p = 1 STRICT upper.
        assert_eq!(
            lognorm_inv(&[Value::number(1.0), Value::number(0.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn lognorm_inv_sd_zero_is_num_error() {
        assert_eq!(
            lognorm_inv(&[Value::number(0.5), Value::number(0.0), Value::number(0.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn lognorm_inv_text_arg_is_value_error() {
        assert_eq!(
            lognorm_inv(&[Value::text("half"), Value::number(0.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn lognorm_inv_error_arg_propagates() {
        assert_eq!(
            lognorm_inv(&[
                Value::Error(ErrorValue::Ref),
                Value::number(0.0),
                Value::number(1.0),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn lognorm_inv_arity_mismatch_returns_value() {
        assert_eq!(lognorm_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            lognorm_inv(&[Value::number(0.5), Value::number(0.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            lognorm_inv(&[
                Value::number(0.5),
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== GAMMA =====
    //
    // Closed-form Γ function. Γ(n) = (n-1)! for positive integers.
    // Γ(0.5) = √π ≈ 1.7724538509055159.
    // Γ(1) = 1, Γ(2) = 1, Γ(3) = 2, Γ(4) = 6, Γ(5) = 24.

    #[test]
    fn gamma_at_one_returns_one_closed_form() {
        // Γ(1) = 0! = 1.
        assert_close(gamma_fn_excel(&[Value::number(1.0)]), 1.0);
    }

    #[test]
    fn gamma_at_five_returns_24_closed_form() {
        // Γ(5) = 4! = 24.
        assert_close(gamma_fn_excel(&[Value::number(5.0)]), 24.0);
    }

    #[test]
    fn gamma_at_half_returns_sqrt_pi_closed_form() {
        // Γ(0.5) = √π.
        assert_close(
            gamma_fn_excel(&[Value::number(0.5)]),
            std::f64::consts::PI.sqrt(),
        );
    }

    #[test]
    fn gamma_at_negative_half_closed_form() {
        // Γ(-0.5) = -2√π.
        assert_close(
            gamma_fn_excel(&[Value::number(-0.5)]),
            -2.0 * std::f64::consts::PI.sqrt(),
        );
    }

    #[test]
    fn gamma_negative_integer_is_num_error() {
        // Γ has poles at negative integers.
        assert_eq!(
            gamma_fn_excel(&[Value::number(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            gamma_fn_excel(&[Value::number(-5.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_at_zero_is_num_error() {
        // Γ(0) = +Inf → #NUM! via finite-result guard.
        assert_eq!(
            gamma_fn_excel(&[Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_text_arg_is_value_error() {
        assert_eq!(
            gamma_fn_excel(&[Value::text("x")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn gamma_error_arg_propagates() {
        assert_eq!(
            gamma_fn_excel(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn gamma_arity_mismatch_returns_value() {
        assert_eq!(gamma_fn_excel(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            gamma_fn_excel(&[Value::number(1.0), Value::number(2.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== GAMMA.DIST =====
    //
    // For α=1 (shape=1), Gamma(1, β) is exponential with rate 1/β.
    // CDF(x; 1, β) = 1 - exp(-x/β). PDF(x; 1, β) = (1/β)·exp(-x/β).

    #[test]
    fn gamma_dist_cdf_at_zero_returns_zero() {
        assert_close(
            gamma_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            0.0,
        );
    }

    #[test]
    fn gamma_dist_cdf_alpha_one_beta_one_at_one_closed_form() {
        // For α=1, β=1: CDF(1) = 1 - e^-1 (matches EXPON.DIST(1, 1, TRUE)).
        assert_close(
            gamma_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            1.0 - (-1.0_f64).exp(),
        );
    }

    #[test]
    fn gamma_dist_pdf_alpha_one_beta_one_at_zero_closed_form() {
        // For α=1, β=1: PDF(0) = 1/1 · e^0 = 1.
        assert_close(
            gamma_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            1.0,
        );
    }

    #[test]
    fn gamma_dist_negative_x_is_num_error() {
        assert_eq!(
            gamma_dist(&[
                Value::number(-1.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_dist_alpha_or_beta_zero_is_num_error() {
        // α = 0 STRICT.
        assert_eq!(
            gamma_dist(&[
                Value::number(1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // β = 0 STRICT.
        assert_eq!(
            gamma_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_dist_text_arg_is_value_error() {
        assert_eq!(
            gamma_dist(&[
                Value::text("x"),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn gamma_dist_error_arg_propagates() {
        assert_eq!(
            gamma_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn gamma_dist_arity_mismatch_returns_value() {
        assert_eq!(gamma_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            gamma_dist(&[Value::number(1.0), Value::number(1.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            gamma_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== GAMMA.INV =====

    #[test]
    fn gamma_inv_at_zero_returns_zero() {
        // p = 0 INCLUSIVE — Gamma.INV(0, ...) = 0.
        assert_close(
            gamma_inv(&[Value::number(0.0), Value::number(1.0), Value::number(1.0)]),
            0.0,
        );
    }

    #[test]
    fn gamma_inv_inverse_of_gamma_dist_round_trip() {
        // gamma_dist(gamma_inv(p, α, β), α, β, TRUE) ≈ p.
        let p = 0.73;
        let alpha = 2.0;
        let beta = 3.0;
        let x = match gamma_inv(&[Value::number(p), Value::number(alpha), Value::number(beta)]) {
            Value::Number(n) => n,
            other => panic!("GAMMA.INV returned {other:?}"),
        };
        let p_back = match gamma_dist(&[
            Value::number(x),
            Value::number(alpha),
            Value::number(beta),
            Value::Boolean(true),
        ]) {
            Value::Number(n) => n,
            other => panic!("GAMMA.DIST returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn gamma_inv_alpha_one_at_half_closed_form() {
        // For α=1, β=1: Inverse of `1 - exp(-x)` at p=0.5 is ln(2).
        assert_close(
            gamma_inv(&[Value::number(0.5), Value::number(1.0), Value::number(1.0)]),
            2.0_f64.ln(),
        );
    }

    #[test]
    fn gamma_inv_p_above_one_is_num_error() {
        assert_eq!(
            gamma_inv(&[Value::number(1.5), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_inv_p_negative_is_num_error() {
        assert_eq!(
            gamma_inv(&[Value::number(-0.1), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_inv_alpha_or_beta_zero_is_num_error() {
        assert_eq!(
            gamma_inv(&[Value::number(0.5), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            gamma_inv(&[Value::number(0.5), Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_inv_subnormal_scale_is_num_error_not_panic() {
        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Codex HIGH-3 closure):**
        // subnormal `beta_scale` (below f64::MIN_POSITIVE ≈ 2.225e-308)
        // yields finite-but-enormous rate ≈ 8.98e307 which previously
        // passed the W5-D-5.1 `is_finite()` guard and then panicked inside
        // statrs's `inverse_cdf` with `Result::unwrap() on Err value:
        // XInvalid`. The new `scale < f64::MIN_POSITIVE` guard in
        // `gamma_dist_with` rejects these as `#NUM!` cleanly.
        assert_eq!(
            gamma_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(f64::MIN_POSITIVE / 2.0),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // Same probe at p = 1.0 (the Codex probe).
        assert_eq!(
            gamma_inv(&[
                Value::number(1.0),
                Value::number(0.5),
                Value::number(f64::MIN_POSITIVE / 2.0),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // The smallest finite-subnormal value (5e-324) also rejected.
        assert_eq!(
            gamma_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(5e-324),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // f64::MIN_POSITIVE itself (normal but smallest-normal) STILL
        // works — only subnormals are excluded.
        match gamma_inv(&[
            Value::number(0.5),
            Value::number(1.0),
            Value::number(f64::MIN_POSITIVE),
        ]) {
            Value::Number(_) | Value::Error(_) => {
                // Either a number or a defensible error code — just
                // must not panic.
            }
            other => panic!("unexpected result for MIN_POSITIVE: {other:?}"),
        }
    }

    #[test]
    fn gamma_dist_subnormal_scale_is_num_error_not_panic() {
        // **W5-D-13.1 (Codex HIGH-3 closure):** the same subnormal-
        // scale guard protects GAMMA.DIST (which also routes through
        // gamma_dist_with).
        assert_eq!(
            gamma_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::number(f64::MIN_POSITIVE / 2.0),
                Value::Boolean(false),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_inv_text_arg_is_value_error() {
        assert_eq!(
            gamma_inv(&[Value::text("half"), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn gamma_inv_error_arg_propagates() {
        assert_eq!(
            gamma_inv(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::number(1.0),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn gamma_inv_arity_mismatch_returns_value() {
        assert_eq!(gamma_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            gamma_inv(&[Value::number(0.5), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            gamma_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn gamma_inv_subnormal_scale_non_termination_regression() {
        // **W5-D-5.1 (Codex HIGH-1 closure):** subnormal `beta_scale`
        // (e.g. `5e-324`, the smallest positive f64 subnormal) yields
        // `rate = 1/scale = +Inf`. statrs 0.18.0 accepts `Gamma::new
        // (1, +Inf)` and `inverse_cdf` enters an infinite bracketing
        // loop. Codex's audit confirmed this with a 2-second
        // compiled-probe timeout. The W5-D-5.1 closure adds an
        // `is_finite()` guard in `gamma_dist_with` that returns
        // `None` for non-finite rate, surfaced here as `#NUM!`.
        assert_eq!(
            gamma_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(5e-324),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_dist_subnormal_scale_returns_num_error() {
        // **W5-D-5.1 (Codex HIGH-1 closure):** companion to
        // `gamma_inv_subnormal_scale_non_termination_regression`.
        // GAMMA.DIST with subnormal scale would produce non-spec
        // results via statrs's infinite-rate Gamma. Pin `#NUM!`.
        assert_eq!(
            gamma_dist(&[
                Value::number(1.0),
                Value::number(1.0),
                Value::number(5e-324),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_inv_at_one_is_num_error() {
        // **W5-D-5.1 (Codex LOW-1 + Opus LOW-O-1 closure):** the
        // domain check admits `p == 1.0`, but `inverse_cdf(1.0)`
        // returns `+Inf` for unbounded-right Gamma, then the
        // `!is_finite()` guard surfaces `#NUM!`. Pin the inclusive-
        // upper-but-observably-#NUM! behavior so docs can't be
        // misread.
        assert_eq!(
            gamma_inv(&[Value::number(1.0), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    // ===== GAMMALN =====
    //
    // ln(Γ(n)) = ln((n-1)!). ln(Γ(1)) = ln(0!) = 0. ln(Γ(2)) = ln(1) = 0.
    // ln(Γ(3)) = ln(2) ≈ 0.6931472. ln(Γ(4)) = ln(6) ≈ 1.7917595.

    #[test]
    fn gamma_ln_at_one_returns_zero_closed_form() {
        // ln(Γ(1)) = ln(1) = 0.
        assert_close(gamma_ln(&[Value::number(1.0)]), 0.0);
    }

    #[test]
    fn gamma_ln_at_two_returns_zero_closed_form() {
        // ln(Γ(2)) = ln(1!) = ln(1) = 0.
        assert_close(gamma_ln(&[Value::number(2.0)]), 0.0);
    }

    #[test]
    fn gamma_ln_at_four_returns_ln_six_closed_form() {
        // ln(Γ(4)) = ln(3!) = ln(6).
        assert_close(gamma_ln(&[Value::number(4.0)]), 6.0_f64.ln());
    }

    #[test]
    fn gamma_ln_at_half_returns_half_ln_pi_closed_form() {
        // ln(Γ(0.5)) = ln(√π) = 0.5 · ln(π).
        assert_close(
            gamma_ln(&[Value::number(0.5)]),
            0.5 * std::f64::consts::PI.ln(),
        );
    }

    #[test]
    fn gamma_ln_negative_x_is_num_error() {
        assert_eq!(
            gamma_ln(&[Value::number(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_ln_at_zero_is_num_error() {
        // ln(Γ(0)) = ln(+Inf) = +Inf → #NUM!.
        assert_eq!(
            gamma_ln(&[Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_ln_text_arg_is_value_error() {
        assert_eq!(
            gamma_ln(&[Value::text("x")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn gamma_ln_error_arg_propagates() {
        assert_eq!(
            gamma_ln(&[Value::Error(ErrorValue::DivZero)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn gamma_ln_arity_mismatch_returns_value() {
        assert_eq!(gamma_ln(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            gamma_ln(&[Value::number(1.0), Value::number(2.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== GAMMALN.PRECISE (alias of GAMMALN) =====

    #[test]
    fn gamma_ln_precise_matches_gamma_ln_at_four() {
        // PRECISE is an alias — must return identical values.
        let a = gamma_ln(&[Value::number(4.0)]);
        let b = gamma_ln_precise(&[Value::number(4.0)]);
        assert_eq!(a, b);
    }

    #[test]
    fn gamma_ln_precise_matches_gamma_ln_at_half() {
        let a = gamma_ln(&[Value::number(0.5)]);
        let b = gamma_ln_precise(&[Value::number(0.5)]);
        assert_eq!(a, b);
    }

    #[test]
    fn gamma_ln_precise_negative_x_is_num_error() {
        assert_eq!(
            gamma_ln_precise(&[Value::number(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn gamma_ln_precise_text_arg_is_value_error() {
        assert_eq!(
            gamma_ln_precise(&[Value::text("x")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn gamma_ln_precise_arity_mismatch_returns_value() {
        assert_eq!(gamma_ln_precise(&[]), Value::Error(ErrorValue::Value));
    }

    // ===== BETA.DIST =====
    //
    // Beta(1, 1) is uniform on [0, 1]: PDF(t) = 1, CDF(t) = t.
    // Beta(α, β) at x=0: PDF=0 (if α>1), CDF=0.
    // Beta(α, β) at x=1: PDF=0 (if β>1), CDF=1.

    #[test]
    fn beta_dist_uniform_cdf_at_half_returns_half_closed_form() {
        // Beta(1, 1) is U(0,1): CDF(0.5) = 0.5.
        assert_close(
            beta_dist(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            0.5,
        );
    }

    #[test]
    fn beta_dist_uniform_pdf_at_half_returns_one_closed_form() {
        // Beta(1, 1) is U(0,1): PDF(0.5) = 1.
        assert_close(
            beta_dist(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
            ]),
            1.0,
        );
    }

    #[test]
    fn beta_dist_cdf_at_one_returns_one_closed_form() {
        // Beta(2, 3): CDF(1) = 1.
        assert_close(
            beta_dist(&[
                Value::number(1.0),
                Value::number(2.0),
                Value::number(3.0),
                Value::Boolean(true),
            ]),
            1.0,
        );
    }

    #[test]
    fn beta_dist_optional_bounds_scaling() {
        // Beta(1,1) on [0, 10] is U(0, 10): PDF = 1/10 = 0.1 at x=5,
        // CDF = 5/10 = 0.5.
        assert_close(
            beta_dist(&[
                Value::number(5.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
                Value::number(0.0),
                Value::number(10.0),
            ]),
            0.1,
        );
        assert_close(
            beta_dist(&[
                Value::number(5.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
                Value::number(10.0),
            ]),
            0.5,
        );
    }

    #[test]
    fn beta_dist_x_outside_bounds_is_num_error() {
        // x < A.
        assert_eq!(
            beta_dist(&[
                Value::number(-0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
        // x > B.
        assert_eq!(
            beta_dist(&[
                Value::number(1.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn beta_dist_a_equals_b_is_num_error() {
        // A == B → #NUM! (zero-width interval).
        assert_eq!(
            beta_dist(&[
                Value::number(5.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(5.0),
                Value::number(5.0),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn beta_dist_alpha_or_beta_zero_is_num_error() {
        assert_eq!(
            beta_dist(&[
                Value::number(0.5),
                Value::number(0.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            beta_dist(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(0.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn beta_dist_text_arg_is_value_error() {
        assert_eq!(
            beta_dist(&[
                Value::text("x"),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn beta_dist_error_arg_propagates() {
        assert_eq!(
            beta_dist(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn beta_dist_arity_mismatch_returns_value() {
        // Below 4 args.
        assert_eq!(beta_dist(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            beta_dist(&[Value::number(0.5), Value::number(1.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Value)
        );
        // Above 6 args.
        assert_eq!(
            beta_dist(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn beta_dist_5_arg_variant_with_a_only() {
        // **W5-D-5.1 (Opus LOW-O-4 closure):** the 5-arg form
        // (A provided, B defaults to 1) wasn't exercised in W5-D-5.
        // Pin: Beta(1, 1) shifted to start at A=2 on [2, 1]... wait,
        // that's reversed. With A=2 and B defaulting to 1, A > B and
        // the impl rejects. Use A=0 so the default B=1 produces a
        // valid [0, 1] domain — same as 4-arg form, but exercises
        // the args.len() == 5 branch.
        assert_close(
            beta_dist(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(true),
                Value::number(0.0),
            ]),
            0.5,
        );
    }

    #[test]
    fn beta_dist_pdf_at_lower_bound_a() {
        // **W5-D-5.1 (Opus LOW-O-5 closure):** PDF at x=A boundary
        // not pinned (only PDF at x=B-side via earlier tests). For
        // Beta(1,1) shifted to [0, 10], PDF(0) = 1/(B-A) = 0.1
        // (uniform density at the lower boundary).
        assert_close(
            beta_dist(&[
                Value::number(0.0),
                Value::number(1.0),
                Value::number(1.0),
                Value::Boolean(false),
                Value::number(0.0),
                Value::number(10.0),
            ]),
            0.1,
        );
    }

    // ===== BETA.INV =====

    #[test]
    fn beta_inv_uniform_at_half_returns_half_closed_form() {
        // Beta(1, 1) is U(0,1): inverse CDF at 0.5 = 0.5.
        assert_close(
            beta_inv(&[Value::number(0.5), Value::number(1.0), Value::number(1.0)]),
            0.5,
        );
    }

    #[test]
    fn beta_inv_inverse_of_beta_dist_round_trip() {
        // beta_dist(beta_inv(p, α, β), α, β, TRUE) ≈ p.
        let p = 0.73;
        let alpha = 2.0;
        let beta_param = 5.0;
        let x = match beta_inv(&[
            Value::number(p),
            Value::number(alpha),
            Value::number(beta_param),
        ]) {
            Value::Number(n) => n,
            other => panic!("BETA.INV returned {other:?}"),
        };
        let p_back = match beta_dist(&[
            Value::number(x),
            Value::number(alpha),
            Value::number(beta_param),
            Value::Boolean(true),
        ]) {
            Value::Number(n) => n,
            other => panic!("BETA.DIST returned {other:?}"),
        };
        assert!(approx(p, p_back, 1e-12));
    }

    #[test]
    fn beta_inv_optional_bounds_scaling() {
        // U(0, 10) inverse at p=0.7 = 7.
        assert_close(
            beta_inv(&[
                Value::number(0.7),
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.0),
                Value::number(10.0),
            ]),
            7.0,
        );
    }

    #[test]
    fn beta_inv_4_arg_variant_with_a_only() {
        // **W5-D-5.1 (Opus LOW-O-4 closure):** 4-arg form (A provided,
        // B defaults to 1). For Beta(1, 1) with A=0, default B=1 →
        // U(0, 1); inverse(0.5) = 0.5. Exercises the args.len() == 4
        // branch specifically.
        assert_close(
            beta_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.0),
            ]),
            0.5,
        );
    }

    #[test]
    fn beta_inv_p_at_endpoints_is_num_error() {
        // p = 0 STRICT.
        assert_eq!(
            beta_inv(&[Value::number(0.0), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        // p = 1 STRICT.
        assert_eq!(
            beta_inv(&[Value::number(1.0), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn beta_inv_b_below_a_is_num_error() {
        assert_eq!(
            beta_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::number(10.0),
                Value::number(5.0),
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn beta_inv_alpha_or_beta_zero_is_num_error() {
        assert_eq!(
            beta_inv(&[Value::number(0.5), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            beta_inv(&[Value::number(0.5), Value::number(1.0), Value::number(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn beta_inv_text_arg_is_value_error() {
        assert_eq!(
            beta_inv(&[Value::text("half"), Value::number(1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn beta_inv_error_arg_propagates() {
        assert_eq!(
            beta_inv(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::number(1.0),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn beta_inv_arity_mismatch_returns_value() {
        assert_eq!(beta_inv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            beta_inv(&[Value::number(0.5), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        // Above 5 args.
        assert_eq!(
            beta_inv(&[
                Value::number(0.5),
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.0),
                Value::number(1.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== CONFIDENCE.NORM =====
    //
    // Margin = z(1 - α/2) · σ / √n. For α=0.05, σ=1, n=1: margin
    // = z(0.975) / √1 = z(0.975) ≈ 1.959963984540054.

    #[test]
    fn confidence_norm_alpha_5pct_size_1_returns_z_critical() {
        // CONFIDENCE.NORM(0.05, 1, 1) = z(0.975) · 1 / √1 ≈ 1.96.
        assert_close(
            confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(1.0)]),
            1.959_963_984_540_054,
        );
    }

    #[test]
    fn confidence_norm_size_4_halves_margin() {
        // For n=4: margin = z · σ / 2 → 1.96 / 2 = 0.98.
        assert_close(
            confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(4.0)]),
            1.959_963_984_540_054 / 2.0,
        );
    }

    #[test]
    fn confidence_norm_sd_scales_margin_linearly() {
        // Doubling σ doubles the margin.
        let m1 =
            match confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(1.0)]) {
                Value::Number(n) => n,
                other => panic!("returned {other:?}"),
            };
        let m2 =
            match confidence_norm(&[Value::number(0.05), Value::number(2.0), Value::number(1.0)]) {
                Value::Number(n) => n,
                other => panic!("returned {other:?}"),
            };
        assert!(approx(m2, 2.0 * m1, 1e-12));
    }

    #[test]
    fn confidence_norm_size_floors_fractional() {
        // size = 4.9 floors to 4 — same result as size = 4.
        let a = confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(4.9)]);
        let b = confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(4.0)]);
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => assert!(approx(x, y, 1e-15)),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn confidence_norm_vs_t_floor_trunc_divergence_visible_at_negative_fractional_size() {
        // **W5-D-5.1 (Opus LOW-O-2 closure):** the `.floor()` vs
        // `.trunc()` divergence between CONFIDENCE.NORM and
        // CONFIDENCE.T is invisible for positive in-domain sizes
        // (both produce the integer floor). They diverge only for
        // negative fractional sizes:
        //   .floor(-1.5) = -2   (NORM uses this)
        //   .trunc(-1.5) = -1   (T uses this)
        // Both fns then reject (size < 1 for NORM, size < 2 for T).
        // The divergence is in WHICH integer the rejection check
        // sees, but both reject for negative inputs anyway. This
        // test documents the divergence; the actual observable
        // difference is only on the boundary cases, where both reject.
        // Pin: both return #NUM!/`#DIV/0!` for negative fractional
        // size — confirming the divergence has no user-visible
        // semantic consequence in the valid-input domain.
        assert_eq!(
            confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(-1.5)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            confidence_t(&[Value::number(0.05), Value::number(1.0), Value::number(-1.5)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn confidence_norm_alpha_at_endpoints_is_num_error() {
        // α = 0 STRICT.
        assert_eq!(
            confidence_norm(&[Value::number(0.0), Value::number(1.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Num)
        );
        // α = 1 STRICT.
        assert_eq!(
            confidence_norm(&[Value::number(1.0), Value::number(1.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn confidence_norm_sd_zero_or_negative_is_num_error() {
        // **W5-D-5.1 (Opus MEDIUM-O-2 closure):** the test name
        // promised both `sd=0` and `sd<0` but only asserted `sd=0`.
        // A regression flipping `sd <= 0.0` to `sd < 0.0` would slip
        // through. Added the `sd<0` assertion.
        // sd = 0 STRICT.
        assert_eq!(
            confidence_norm(&[Value::number(0.05), Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        // sd < 0.
        assert_eq!(
            confidence_norm(&[Value::number(0.05), Value::number(-1.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn confidence_norm_size_less_than_one_is_num_error() {
        // size=0.9 floors to 0 → < 1 → #NUM!.
        assert_eq!(
            confidence_norm(&[Value::number(0.05), Value::number(1.0), Value::number(0.9),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn confidence_norm_text_arg_is_value_error() {
        assert_eq!(
            confidence_norm(&[Value::text("five"), Value::number(1.0), Value::number(1.0),]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn confidence_norm_error_arg_propagates() {
        assert_eq!(
            confidence_norm(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::number(1.0),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn confidence_norm_arity_mismatch_returns_value() {
        assert_eq!(confidence_norm(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            confidence_norm(&[Value::number(0.05), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            confidence_norm(&[
                Value::number(0.05),
                Value::number(1.0),
                Value::number(1.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== CONFIDENCE.T =====
    //
    // Margin = t(1 - α/2; df=n-1) · σ / √n.

    #[test]
    fn confidence_t_alpha_5pct_size_10_statrs_self_consistent() {
        // CONFIDENCE.T(0.05, 1, 10) = t(0.975; df=9) / √10.
        // True math gives ≈ 0.71531056. statrs's `inverse_cdf` is
        // Newton-Raphson approximate (~5e-5 off true value for df=9);
        // we pin statrs's value (`0.7153569059706643`) per the W5-D-3
        // statrs self-consistency pattern.
        let result = confidence_t(&[Value::number(0.05), Value::number(1.0), Value::number(10.0)]);
        match result {
            Value::Number(n) => assert!(
                approx(n, 0.715_356_905_970_664_3, 1e-9),
                "expected ≈ 0.715357, got {n}"
            ),
            other => panic!("expected Number ≈ 0.715357, got {other:?}"),
        }
    }

    #[test]
    fn confidence_t_size_less_than_two_is_div_zero() {
        // **WARNING: CONFIDENCE.T returns `#DIV/0!`, NOT `#NUM!`** for
        // size < 2 (df = n - 1 < 1). Matches IronCalc + Excel canon.
        // Unique error class in distribution_fns.
        assert_eq!(
            confidence_t(&[Value::number(0.05), Value::number(1.0), Value::number(1.0),]),
            Value::Error(ErrorValue::DivZero)
        );
        assert_eq!(
            confidence_t(&[Value::number(0.05), Value::number(1.0), Value::number(0.0),]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn confidence_t_size_truncs_fractional() {
        // size=10.9 truncates to 10. Same as size=10.
        let a = confidence_t(&[Value::number(0.05), Value::number(1.0), Value::number(10.9)]);
        let b = confidence_t(&[Value::number(0.05), Value::number(1.0), Value::number(10.0)]);
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => assert!(approx(x, y, 1e-15)),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn confidence_t_large_size_approaches_norm() {
        // As n → ∞, CONFIDENCE.T → CONFIDENCE.NORM (t-dist converges to
        // normal). For n=10000, the two should agree to ~1e-4.
        let t_margin = match confidence_t(&[
            Value::number(0.05),
            Value::number(1.0),
            Value::number(10000.0),
        ]) {
            Value::Number(n) => n,
            other => panic!("returned {other:?}"),
        };
        let norm_margin = match confidence_norm(&[
            Value::number(0.05),
            Value::number(1.0),
            Value::number(10000.0),
        ]) {
            Value::Number(n) => n,
            other => panic!("returned {other:?}"),
        };
        assert!(approx(t_margin, norm_margin, 1e-3));
    }

    #[test]
    fn confidence_t_alpha_at_endpoints_is_num_error() {
        assert_eq!(
            confidence_t(&[Value::number(0.0), Value::number(1.0), Value::number(10.0),]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            confidence_t(&[Value::number(1.0), Value::number(1.0), Value::number(10.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn confidence_t_sd_zero_is_num_error() {
        assert_eq!(
            confidence_t(&[Value::number(0.05), Value::number(0.0), Value::number(10.0),]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn confidence_t_text_arg_is_value_error() {
        assert_eq!(
            confidence_t(&[
                Value::text("alpha"),
                Value::number(1.0),
                Value::number(10.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn confidence_t_error_arg_propagates() {
        assert_eq!(
            confidence_t(&[
                Value::Error(ErrorValue::Ref),
                Value::number(1.0),
                Value::number(10.0),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn confidence_t_arity_mismatch_returns_value() {
        assert_eq!(confidence_t(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            confidence_t(&[Value::number(0.05), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            confidence_t(&[
                Value::number(0.05),
                Value::number(1.0),
                Value::number(10.0),
                Value::number(0.0),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== W5-D-10 (Phase 4.10 V1-260 closeout) — ERF / ERFC family =====

    // --- ERF ---

    #[test]
    fn erf_at_zero_returns_zero_closed_form() {
        // ERF(0) = 0 (identity: integral from 0 to 0 is 0).
        assert_close(erf_excel(&[Value::number(0.0)]), 0.0);
    }

    #[test]
    fn erf_odd_function_property() {
        // ERF(-x) = -ERF(x) (odd function).
        let x = 1.5;
        let pos = match erf_excel(&[Value::number(x)]) {
            Value::Number(n) => n,
            other => panic!("erf returned {other:?}"),
        };
        let neg = match erf_excel(&[Value::number(-x)]) {
            Value::Number(n) => n,
            other => panic!("erf returned {other:?}"),
        };
        assert!(approx(pos, -neg, 1e-12));
    }

    #[test]
    fn erf_at_one_libreoffice_anchor() {
        // ERF(1) ≈ 0.8427007929497149 (standard reference value).
        assert_close(erf_excel(&[Value::number(1.0)]), 0.842_700_792_949_714_9);
    }

    #[test]
    fn erf_at_two_libreoffice_anchor() {
        // ERF(2) ≈ 0.9953222650189527.
        assert_close(erf_excel(&[Value::number(2.0)]), 0.995_322_265_018_952_7);
    }

    #[test]
    fn erf_large_positive_approaches_one() {
        // ERF(x) → 1 as x → ∞. ERF(5) ≈ 1 to ~12 sig figs.
        let result = erf_excel(&[Value::number(5.0)]);
        match result {
            Value::Number(n) => assert!((1.0 - n).abs() < 1e-10, "expected ≈ 1, got {n}"),
            other => panic!("erf returned {other:?}"),
        }
    }

    #[test]
    fn erf_two_arg_definite_integral() {
        // ERF(0, 1) = ERF(1) - ERF(0) = ERF(1) ≈ 0.8427.
        assert_close(
            erf_excel(&[Value::number(0.0), Value::number(1.0)]),
            0.842_700_792_949_714_9,
        );
        // ERF(1, 2) = ERF(2) - ERF(1) ≈ 0.9953 - 0.8427 ≈ 0.1526.
        assert_close(
            erf_excel(&[Value::number(1.0), Value::number(2.0)]),
            0.995_322_265_018_952_7 - 0.842_700_792_949_714_9,
        );
    }

    #[test]
    fn erf_two_arg_swapped_negates() {
        // ERF(upper, lower) = -ERF(lower, upper) by anti-symmetry of
        // the definite integral.
        let forward = match erf_excel(&[Value::number(0.0), Value::number(1.5)]) {
            Value::Number(n) => n,
            other => panic!("{other:?}"),
        };
        let reverse = match erf_excel(&[Value::number(1.5), Value::number(0.0)]) {
            Value::Number(n) => n,
            other => panic!("{other:?}"),
        };
        assert!(approx(forward, -reverse, 1e-12));
    }

    #[test]
    fn erf_text_arg_is_value_error() {
        assert_eq!(
            erf_excel(&[Value::text("x")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn erf_error_arg_propagates() {
        assert_eq!(
            erf_excel(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn erf_2_arg_error_propagates_from_either_position() {
        // **W5-D-10.1 (Opus LOW-2 closure):** the 2-arg form must
        // propagate errors from BOTH arg positions. Prior coverage
        // only pinned arg[0] (via the 1-arg form). Now pin arg[1]
        // explicitly.
        // Error in lower (args[0]):
        assert_eq!(
            erf_excel(&[Value::Error(ErrorValue::DivZero), Value::number(1.0)]),
            Value::Error(ErrorValue::DivZero)
        );
        // Error in upper (args[1]):
        assert_eq!(
            erf_excel(&[Value::number(0.0), Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn erf_arity_mismatch_returns_value() {
        assert_eq!(erf_excel(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            erf_excel(&[Value::number(0.0), Value::number(1.0), Value::number(2.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- ERF.PRECISE ---

    #[test]
    fn erf_precise_matches_erf_1_arg() {
        // ERF.PRECISE(x) ≡ ERF(x) for 1-arg form. Pin alias parity.
        for x in [0.0, 0.5, 1.0, 1.5, 2.0, -1.0] {
            let a = erf_excel(&[Value::number(x)]);
            let b = erf_precise(&[Value::number(x)]);
            assert_eq!(a, b, "ERF.PRECISE diverges from ERF at x={x}");
        }
    }

    #[test]
    fn erf_precise_rejects_2_args() {
        // ERF.PRECISE is STRICTLY 1-arg (Excel canon; PRECISE
        // variants don't accept the definite-integral form).
        assert_eq!(
            erf_precise(&[Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn erf_precise_text_arg_is_value_error() {
        assert_eq!(
            erf_precise(&[Value::text("x")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn erf_precise_arity_mismatch_returns_value() {
        assert_eq!(erf_precise(&[]), Value::Error(ErrorValue::Value));
    }

    // --- ERFC ---

    #[test]
    fn erfc_at_zero_returns_one_closed_form() {
        // ERFC(0) = 1 - ERF(0) = 1.
        assert_close(erfc_excel(&[Value::number(0.0)]), 1.0);
    }

    #[test]
    fn erfc_complement_identity() {
        // ERFC(x) + ERF(x) = 1 identity (closed-form definition).
        for x in [-2.0, -1.0, -0.5, 0.5, 1.0, 2.0, 3.0] {
            let erf_v = match erf_excel(&[Value::number(x)]) {
                Value::Number(n) => n,
                _ => panic!(),
            };
            let erfc_v = match erfc_excel(&[Value::number(x)]) {
                Value::Number(n) => n,
                _ => panic!(),
            };
            assert!(
                approx(erf_v + erfc_v, 1.0, 1e-12),
                "ERF({x}) + ERFC({x}) = {} ≠ 1",
                erf_v + erfc_v
            );
        }
    }

    #[test]
    fn erfc_at_one_libreoffice_anchor() {
        // ERFC(1) = 1 - ERF(1) ≈ 0.1572992070502851.
        assert_close(
            erfc_excel(&[Value::number(1.0)]),
            1.0 - 0.842_700_792_949_714_9,
        );
    }

    #[test]
    fn erfc_large_positive_approaches_zero() {
        // ERFC(x) → 0 as x → ∞. statrs uses stable rational
        // approximation (no naive 1 - erf(x) cancellation).
        let result = erfc_excel(&[Value::number(5.0)]);
        match result {
            Value::Number(n) => assert!(n.abs() < 1e-10, "expected ≈ 0, got {n}"),
            other => panic!("erfc returned {other:?}"),
        }
    }

    #[test]
    fn erfc_large_negative_approaches_two() {
        // ERFC(-∞) = 2. ERFC(-5) ≈ 2.
        let result = erfc_excel(&[Value::number(-5.0)]);
        match result {
            Value::Number(n) => assert!((2.0 - n).abs() < 1e-10, "expected ≈ 2, got {n}"),
            other => panic!("erfc returned {other:?}"),
        }
    }

    #[test]
    fn erfc_text_arg_is_value_error() {
        assert_eq!(
            erfc_excel(&[Value::text("x")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn erfc_error_arg_propagates() {
        assert_eq!(
            erfc_excel(&[Value::Error(ErrorValue::DivZero)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn erfc_arity_mismatch_returns_value() {
        assert_eq!(erfc_excel(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            erfc_excel(&[Value::number(0.0), Value::number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- ERFC.PRECISE ---

    #[test]
    fn erfc_precise_matches_erfc() {
        // ERFC.PRECISE(x) ≡ ERFC(x). Pin alias parity.
        for x in [0.0, 0.5, 1.0, 1.5, 2.0, -1.0] {
            let a = erfc_excel(&[Value::number(x)]);
            let b = erfc_precise(&[Value::number(x)]);
            assert_eq!(a, b, "ERFC.PRECISE diverges from ERFC at x={x}");
        }
    }

    #[test]
    fn erfc_precise_arity_mismatch_returns_value() {
        assert_eq!(erfc_precise(&[]), Value::Error(ErrorValue::Value));
    }
}
