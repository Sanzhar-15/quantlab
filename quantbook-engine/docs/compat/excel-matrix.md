# Excel Compatibility Matrix

**Phase:** Engine Phase 4.2 (W5-45, 2026-05-12).
**Spec ID:** ECM-4-01 (matrix exists), ECM-4-02 (each function carries
status / tests / category / Excel parity notes), ECM-4-03 (CI can
report coverage percentage).
**Companion script:** `scripts/report-compat-coverage.sh` reports the
implemented / total count by category.

This document is the canonical machine-parseable reference for what
Excel features Quantbook implements. Categories: operators, coercion,
errors, functions, arrays/spills, tables, date systems, localization,
xlsx round-trip.

**Companion: `docs/compat/error-matrix.md`** (W5-66, Phase 4.4.C) —
distilled per-function error semantics + coercion overrides. When a
function row in THIS doc says "see error-matrix" in the Notes column,
that's the place to look up which sigil it returns when.

**Phase 3.10/Codex audit closure (W5-48, 2026-05-13):** ECM-4-02
was originally written as "each function has status + tests +
category + Excel parity notes." After the audit caught the schema
mismatch (function tables have no `Category` column; categories
are encoded as `###` SECTION HEADERS under `## 1. Functions`), the
ECM-4-02 acceptance is now: each function row carries Status +
Tests + Phase + Notes; the function's CATEGORY is determined by
the `###` section it lives under (Aggregates/Statistical, Logical,
Math&Trig, Text, Date&Time, Lookup&Reference, Information,
Financial, Engineering, Database, Reserved). Many rows still have
empty/short Notes; per-row parity-note expansion is the
documented Phase 4.3+ follow-up (also captured in §"Open
follow-ups" below).

Each function row carries:

- **Status:** ✅ implemented · ⚠️ partial · 🔄 reserved · ❌ not-yet
- **Tests:** existing test count (`-` for non-function rows)
- **Phase:** Phase that closes / closed this row.
- **Notes:** Excel parity notes, known limitations, divergences.

The category for each row comes from the `###` section header it's
listed under (not a per-row column).

The `Status` column is the format `scripts/report-compat-coverage.sh`
counts: rows with `✅` count as implemented, rows with `⚠️` count
as partial, rows with `❌` are missing.

---

## 1. Functions

### Aggregates / Statistical (basic)

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| SUM | ✅ | 30+ | 0 | Aggregate over range/named-range works (Phase 3.6 cache); error propagation per Excel canon |
| AVERAGE (alias: AVG) | ✅ | 10+ | 0 | Welford-backed (A6 spec); empty range → #DIV/0! |
| COUNT | ✅ | 5+ | 0 | Numeric values only; errors / text / blanks skipped |
| COUNTA | ✅ | 3+ | 0 | All non-blank; errors + text counted |
| MIN | ✅ | 5+ | 0 | Empty → 0 (Excel canon); error propagates |
| MAX | ✅ | 5+ | 0 | Empty → 0 (Excel canon); error propagates |
| PRODUCT | ✅ | 5+ | 0 | Empty → 0 |
| VAR (alias: VAR.S) | ✅ | A6 | 0 | Welford-backed |
| VAR.P | ✅ | A6 | 0 | Welford-backed |
| STDEV (alias: STDEV.S) | ✅ | A6 | 0 | Welford-backed |
| STDEV.P | ✅ | A6 | 0 | Welford-backed |
| SUMIF | ⚠️ | 17 | 4.3 V2 | W5-53 + W5-61: supports number/text/bool/blank criteria + comparators `> < >= <= <> =`. **Wildcards `?` / `*` shipped W5-61** (escape with `~`); apply only to Eq/Ne text criteria, only against text cells (not coerced numbers). 2-arg + 3-arg forms; sum_range default to range. Error in sum_range cell propagates (Excel canon). **W5-60 KNOWN DIVERGENCE**: when `sum_range` size differs from `range`, Quantbook does a flat-index zip; Excel anchors the top-left of `sum_range` and uses `range`'s shape, ignoring `sum_range`'s declared extent. Behavior matches only when `sum_range.len() == range.len()`. Pin Phase 4.3 polish or 4.10. |
| VLOOKUP | ⚠️ | 8 | 4.3 V2 | W5-54: exact match (range_lookup=FALSE/0) and approximate match (default, sorted ascending). col_index_num<1 → #VALUE!; col_index_num>cols → #REF!; not-found → #N/A. Case-insensitive text equality. Wildcards deferred. |
| HLOOKUP | ⚠️ | 2 | 4.3 V2 | W5-54: row-direction mirror of VLOOKUP. Same caveats. |
| MATCH | ⚠️ | 7 | 4.3 V2 | W5-54: match_type 0/1/-1 (exact / largest-≤ / smallest-≥). 1-based result. Not-found → #N/A. Linear scan (V1 — no binary-search optimization yet). |
| INDEX | ⚠️ | 5 | 4.3 V2 | W5-54: scalar result only. 1D and 2D variants. row_num=0 / col_num=0 (array spill) → #REF! pending Phase 4.7 array formulas. Out-of-bounds → #REF!. |
| CHOOSE | ✅ | 5 | 4.3 V2 | W5-54: scalar args only, 1-based index. Out-of-bounds → #VALUE!. Fractional indexes truncated per Excel canon. |
| SUMIFS | ⚠️ | 6 | 4.3 V2 | W5-55 + W5-61: multi-condition AND. Excel arg order: `sum_range FIRST`, then (criteria_range, criteria) pairs. All criteria ranges + sum range must share the same `(rows, cols)` shape (W5-60 strict 2D-shape validation). Same predicate suite as SUMIF, **including W5-61 wildcards** (`?` `*` with `~` escape). |
| COUNTIF | ✅ | 21 | 4.3 polish | W5-53 + W5-61: same predicate suite as SUMIF, including W5-61 wildcards `?` / `*` (escape with `~`). Error cells in the range are NOT propagated (Excel canon — COUNTIF ignores errors, unlike SUMIF). |
| COUNTIFS | ⚠️ | 3 | 4.3 V2 | W5-55: multi-condition AND count. Errors in range cells don't propagate (Excel canon). |
| AVERAGEIF | ⚠️ | 6 | 4.3 V2 | W5-55: same predicate suite as SUMIF; #DIV/0! on no matches; optional separate average_range. **W5-60 KNOWN DIVERGENCE**: same as SUMIF — when `average_range` size differs from `range`, Quantbook does a flat-index zip; Excel anchors the top-left of `average_range` and uses `range`'s shape. Behavior matches only when sizes are equal. Pin Phase 4.3 polish or 4.10. |
| AVERAGEIFS | ⚠️ | 2 | 4.3 V2 | W5-55: multi-condition AND average; #DIV/0! on no matches. |
| MINIFS / MAXIFS | ✅ | 9 | 4.10.B | W5-164: multi-condition min/max. Mirrors SUMIFS / AVERAGEIFS shape: value_range first, then (criteria_range, criteria) pairs; W5-60 2D-shape enforcement applies. **Excel canon**: no matching numeric cells → `0` (NOT `#NUM!` or `#DIV/0!`; verified vs IronCalc `fn_minifs` / `fn_maxifs`). Same predicate suite as SUMIFS (numbers, text, bool, blank, `<=>≠` comparators, W5-61 wildcards). Errors in value_range propagate. |
| COUNTBLANK | ✅ | 6 | 4.10.B | W5-164: count blank cells in a single range. Per Excel canon (verified vs IronCalc `fn_countblank`): both `Value::Blank` AND empty strings (`""`) count as blank; errors are NOT blank (skipped). Single range arg required (scalar → `#VALUE!`; use COUNTIF for scalar shapes). |
| MEDIAN | ✅ | 6 | 4.3 V2 | W5-58: even-count averages two middles; mixed scalar/range args supported; empty → #NUM!; text in range → #VALUE! (strict, matches SUM/AVERAGE). |
| MODE / MODE.SNGL | ✅ | 5 | 4.3 V2 | W5-58: most frequent value; first-appearance tie-break; no repeats → #N/A; empty → #NUM!. Float bit-pattern equality (exact, no epsilon). MODE.SNGL is a registry alias of MODE. |
| MODE.MULT | ❌ | 0 | 4.7 | Returns array of multiple modes — needs dynamic-array spill. |
| LARGE / SMALL | ✅ | 5 | 4.3 V2 | W5-58: 1-based k-th order statistic; k out of [1, count] → #NUM!; empty → #NUM!. |
| RANK / RANK.EQ | ✅ | 5 | 4.3 V2 | W5-58: 1-based rank in `ref`. order = 0/omitted = descending (largest = 1); != 0 = ascending. Ties get same rank (Excel RANK.EQ semantics). Value not in `ref` → #N/A. RANK.EQ is a registry alias of RANK. |
| RANK.AVG | ✅ | 7 | 4.3 polish | W5-61: average rank for tied values. Tie of size k starting at base rank r returns r + (k-1)/2. Otherwise identical semantics to RANK / RANK.EQ. |
| PERCENTILE.INC | ✅ | 17 | 4.10 V1-260 (W5-D-11) | W5-D-11: k-th percentile, inclusive bounds. Range-aware; array sort + linear interpolation at position `k * (n − 1)`. Microsoft canon (k ∈ [0, 1]; out-of-range → #NUM!). Microsoft example anchor (k=0.3 on {1..4} → 1.9). Empty after coercion → #NUM! (matches LARGE/SMALL/MEDIAN). **Engine divergence**: Text values in range raise #VALUE! per the W5-58 strict convention; Microsoft canon skips text. Blanks skipped. NaN k → #NUM! (panic-safety pinned via W5-D-11.1 closure). IronCalc does NOT ship — original port. |
| PERCENTILE.EXC | ✅ | 16 | 4.10 V1-260 (W5-D-11) | W5-D-11: k-th percentile, exclusive bounds. Position formula `k * (n + 1) − 1` with the additional Excel canon constraint `1/(n+1) ≤ k ≤ n/(n+1)` (else #NUM!). Microsoft anchor (k=0.25 on {1..4} → 1.25). For n=1 only k=0.5 is valid. Same engine-divergence on text → #VALUE! as PERCENTILE.INC. NaN k → #NUM!. Boolean k coerces (TRUE→1.0/FALSE→0.0; both fall outside EXC bounds for any n ≥ 1 → #NUM!). IronCalc does NOT ship — original port. |
| PERCENTILE | ✅ | 1 | 4.10 V1-260 (W5-D-11) | W5-D-11: legacy alias of PERCENTILE.INC (Excel 2010+ convention — same shared kernel, registered separately for name-equivalence). **W5-D-11.1 (Codex LOW-001 closure):** alias-parity verified via fn-pointer address comparison in the W5-D-11 e2e dispatch test, not just `is_some()`. |
| QUARTILE.INC | ✅ | 15 | 4.10 V1-260 (W5-D-11) | W5-D-11: quartile via `PERCENTILE.INC(arr, q/4)` for q ∈ {0, 1, 2, 3, 4}. Truncates fractional `quart` toward zero per Microsoft TRUNC canon (verified against Microsoft TRUNC + QUARTILE.INC docs; pinned by W5-D-11.1 closure with q=-0.5 → minimum, q=-0.99 → minimum, q=-1.01 → #NUM!). q outside → #NUM!. NaN q → #NUM! (W5-D-11.1 Codex MEDIUM-001 closure: explicit guard prevents `NaN.trunc() as i64` saturating to 0). Algebraic equivalence with PERCENTILE.INC pinned. Same engine-divergence on text → #VALUE! as PERCENTILE.INC. IronCalc does NOT ship — original port. |
| QUARTILE.EXC | ✅ | 12 | 4.10 V1-260 (W5-D-11) | W5-D-11: quartile via `PERCENTILE.EXC(arr, q/4)` for q ∈ {1, 2, 3}. q = 0 or q = 4 → #NUM! (Microsoft canon — use .INC for min/max). Microsoft anchor ({1,2,4,7,8,9,10,12} q=2 → 7.5). Small-array EXC-bound propagation pinned (n=2: q=1, q=3 → #NUM!). NaN q → #NUM!. Same engine-divergence on text → #VALUE! as PERCENTILE.EXC. IronCalc does NOT ship — original port. |
| QUARTILE | ✅ | 1 | 4.10 V1-260 (W5-D-11) | W5-D-11: legacy alias of QUARTILE.INC (Excel 2010+ convention). **W5-D-11.1 (Codex LOW-001 closure):** alias-parity verified via fn-pointer address comparison in the W5-D-11 e2e dispatch test. |
| CORREL | ✅ | 14 | 4.10 polish | W5-177: Pearson correlation coefficient ported from IronCalc `fn_correl`. Closed-form sum-of-cross-products: `r = (n·Σxy − Σx·Σy) / √((n·Σx² − (Σx)²) · (n·Σy² − (Σy)²))`. RangeAwareFn; both args MUST be ranges of identical shape. Excel canon: pairs with non-numeric on EITHER side are skipped (Text/Boolean/Blank all map to "drop the pair" — Booleans NOT coerced to 1/0 unlike SUM). Need ≥2 numeric pairs → otherwise `#DIV/0!`. Constant array on either side → `#DIV/0!`. Errors in either array propagate. **Shape-mismatch divergence**: Microsoft canon says `#N/A`; we follow IronCalc + the in-codebase paired-array convention (SUMX2MY2 / SUMX2PY2 / SUMXMY2) which uses `#VALUE!`. Consistent within the engine but diverges from Excel for this specific error code. |
| COVARIANCE.P | ✅ | 9 | Wave 3 closure (W5-D-6) | W5-D-6: population covariance via shared `compute_covariance(xs, ys, 0.0)` kernel. RangeAwareFn paired-array (same shape as CORREL). Closed-form anchors: y=2x → cov=2.5, y=-2x → cov=-2.5. Constant array → cov=0 (NOT #DIV/0! like CORREL). Single pair → cov=0. No-numeric-pairs → #DIV/0!. Shape mismatch → #VALUE! (engine convention vs Microsoft #N/A). |
| COVARIANCE.S | ✅ | 11 | Wave 3 closure (W5-D-6) | W5-D-6: sample covariance via Bessel correction (`compute_covariance(xs, ys, 1.0)`, divisor n-1). Microsoft canonical anchor (data1=[2,4,8], data2=[5,11,12]) → 29/3 ≈ 9.667 pinned. Algebraic relationship `COVARIANCE.S = COVARIANCE.P · n/(n-1)` pinned. Single pair → #DIV/0! (n-1=0). Constant array → cov=0 (NOT #DIV/0! like CORREL). No-numeric-pairs → #DIV/0!. Shape mismatch → #VALUE! (engine convention). Non-numeric pairs skipped per IronCalc rule. (W5-D-6.1 Codex MEDIUM-001 closure: prior test labelled as Microsoft canonical .S example was actually Microsoft's .P example transformed via Bessel; explicit Microsoft .S anchor added.) |
| SLOPE | ✅ | 11 | 4.10 polish | W5-178: least-squares slope ported from IronCalc `fn_slope`. RangeAwareFn `SLOPE(known_y, known_x)` (note Y-first arg order — opposite of CORREL's `(x, y)`). Formula: `m = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)`. Shares `compute_slope` + `LinearFitSums` with INTERCEPT. Pairs with non-numeric on EITHER side dropped (Booleans not coerced; matches CORREL canon). Need ≥2 numeric pairs → otherwise `#DIV/0!`. Constant x-array (denom = 0) → `#DIV/0!`. Same shape-mismatch divergence as CORREL: `#VALUE!` (in-codebase paired-array convention; Microsoft says `#N/A`). |
| INTERCEPT | ✅ | 7 | 4.10 polish | W5-178: y-intercept of the least-squares regression line. Computed as `b = (Σy − slope · Σx) / n` after deriving slope via `compute_slope`. Same arg signature, error semantics, divergence as SLOPE; inherits SLOPE's `#DIV/0!` when slope is undefined. |
| PEARSON | ✅ | 3 | 4.10 polish | W5-179: Pearson product-moment correlation coefficient. Mathematically IDENTICAL to CORREL per Microsoft + IronCalc; routes through `correl()`. Excel exposes them as two separate functions for terminology / discoverability. Same arg signature, semantics, error paths, shape-mismatch divergence (`#VALUE!` not `#N/A`) as CORREL. |
| RSQ | ✅ | 7 | 4.10 polish | W5-179: coefficient of determination R² = CORREL². RangeAwareFn; same arg signature + canon as CORREL. Computed as `(compute_correl(xs, ys))²` after the shared `collect_xy_pairs` extraction. Inherits CORREL's `#DIV/0!` for too-few-pairs and constant-array cases. |
| STEYX | ✅ | 9 | 4.10 polish | W5-179: standard error of the predicted y in least-squares regression. Formula `sey = √(SSE / (n − 2))` where `SSE = Σ(y − ŷ)²` and `ŷ = intercept + slope · x`. RangeAwareFn `STEYX(known_y, known_x)` — Y-first like SLOPE / INTERCEPT. Two-pass: first builds `LinearFitSums` and derives slope + intercept via `compute_slope`; second walks the preserved pairs for residuals. Requires ≥3 numeric pairs (denominator is `n − 2`) → otherwise `#DIV/0!`. Constant x-array → `#DIV/0!` (inherits from `compute_slope`). Same non-numeric-pair skip + shape-mismatch divergence as CORREL. |
| AVERAGEA / MAXA / MINA | ✅ | 10 | 4.10.C | W5-165: `*A`-variant aggregates. Per Excel canon: Number → as-is; Boolean → 1/0; Text → 0 (including ""); Blank → SKIPPED. Errors propagate. AVERAGEA: empty / all-blank → #DIV/0!. MAXA / MINA: empty / all-blank → 0. DIVERGES from base AVERAGE / MAX / MIN which skip text + bool entirely. |
| FREQUENCY | ❌ | 0 | 4.10 | Array-result; needs 4.7 |
| NORM.DIST | ✅ | 9 | Wave 3 D-1 (W5-D-1) | W5-D-1: normal PDF/CDF via `statrs::Normal` (pinned 0.18.0; matches IronCalc's pin). 4 args; `cumulative=TRUE` → CDF, `FALSE` → PDF. `sd <= 0` → `#NUM!`. Text args → `#VALUE!`. Error propagation. LibreOffice anchors pinned. |
| NORM.S.DIST | ✅ | 8 | Wave 3 D-1 (W5-D-1) | W5-D-1: standard normal (mean=0, sd=1) PDF/CDF; 2 args. Same error semantics. LibreOffice Φ(z) anchors at z=0, 1, -2, 8 pinned. |
| NORM.INV | ✅ | 9 | Wave 3 D-1 (W5-D-1) | W5-D-1: inverse normal CDF; 3 args. `0 < prob < 1` strict; `sd > 0` strict. Else `#NUM!`. CI-upper anchor at p=0.975 (≈1.95996398) pinned; inverse-of-CDF round-trip verified. |
| NORM.S.INV | ✅ | 9 | Wave 3 D-1 (W5-D-1) | W5-D-1: standard-normal inverse CDF; 1 arg. Same domain. |
| T.DIST | ✅ | 10 | Wave 3 D-2 (W5-D-2) | W5-D-2: Student's t PDF/CDF via `statrs::StudentsT` (pinned 0.18.0; matches IronCalc). 3 args. `cumulative=TRUE` → left-tailed CDF, `FALSE` → PDF. `df` truncated to integer; `df < 1` → `#NUM!`. Closed-form df=1 anchors (1/π, ¾) + large-df→Normal convergence pinned. |
| T.DIST.2T | ✅ | 8 | Wave 3 D-2 (W5-D-2) | W5-D-2: two-tailed Student's t probability `P(\|T\| ≥ x)` = `2·(1 - CDF(x))`; 2 args. `x < 0` → `#NUM!` (Microsoft canon: x must be non-negative). `df < 1` → `#NUM!`. Result clamped to `[0, 1]` (defensive against float overshoot in far tails). |
| T.DIST.RT | ✅ | 8 | Wave 3 D-2 (W5-D-2) | W5-D-2: right-tailed Student's t probability `P(T ≥ x)` = `1 - CDF(x)`; 2 args. Unlike T.DIST.2T, negative `x` is allowed (gives > 0.5). `df < 1` → `#NUM!`. Round-trip with T.DIST (CDF + RT = 1) pinned. |
| T.INV | ✅ | 9 | Wave 3 D-2 (W5-D-2) | W5-D-2: left-tailed inverse Student's t CDF; 2 args. `0 < probability < 1` strict; `df < 1` → `#NUM!`. LibreOffice anchor T.INV(0.975, 10) ≈ 2.22814 pinned; inverse-of-CDF round-trip verified. |
| T.INV.2T | ✅ | 10 | Wave 3 D-2 (W5-D-2) | W5-D-2: two-tailed inverse Student's t. Returns positive critical x s.t. `P(\|T\| ≥ x) = p`. Inverts via `CDF⁻¹(1 - p/2).abs()`. `0 < p ≤ 1` (upper-inclusive per IronCalc + Microsoft canon). `df < 1` → `#NUM!`. LibreOffice anchor T.INV.2T(0.05, 30) ≈ 2.04227 pinned. |
| CHISQ.DIST | ✅ | 10 | Wave 3 D-3 (W5-D-3) | W5-D-3: chi-squared PDF/CDF via `statrs::ChiSquared` (pinned 0.18.0; matches IronCalc). 3 args. `x ≥ 0`; `df.trunc()` in `[1, 10^10]` else `#NUM!`. Closed-form df=2 anchors (pdf(0)=0.5, CDF(2)=1-e⁻¹) + classic 95th percentile df=1 ≈ 3.84146 pinned. |
| CHISQ.DIST.RT | ✅ | 9 | Wave 3 D-3 (W5-D-3) | W5-D-3: right-tailed chi-squared `P(X > x)` via `statrs`'s `sf(x)` survival function (better numerical properties than `1-cdf(x)` in far right tail; matches IronCalc canon). 2 args. Same domain as CHISQ.DIST minus cumulative. Round-trip with CHISQ.DIST (CDF + RT = 1) pinned. |
| CHISQ.INV | ✅ | 10 | Wave 3 D-3 (W5-D-3) | W5-D-3: left-tailed inverse chi-squared CDF. 2 args. **`0 ≤ p ≤ 1` INCLUSIVE** — diverges from T.INV/NORM.INV's strict `(0,1)`; matches IronCalc + Microsoft canon. `df` in `[1, 10^10]`. df=2 closed-form anchor `CHISQ.INV(0.5, 2) = 2·ln(2)` + classic critical `CHISQ.INV(0.95, 1) ≈ 3.84146` pinned. |
| CHISQ.INV.RT | ✅ | 10 | Wave 3 D-3 (W5-D-3) | W5-D-3: right-tailed inverse chi-squared. Solves `p = P(X > x) = 1 - CDF(x)`, returns `inverse_cdf(1 - p)`. Same domain as CHISQ.INV. `CHISQ.INV.RT(0.05, 1) ≈ 3.84146` (matches CHISQ.INV(0.95, 1) by definition) pinned. |
| F.DIST | ✅ | 9 | Wave 3 D-3 (W5-D-3) | W5-D-3: F-distribution PDF/CDF via `statrs::FisherSnedecor`. 4 args. `x ≥ 0`; `df1 ≥ 1`; `df2 ≥ 1` (truncated) else `#NUM!`. F(df1=df2) CDF symmetry (median at x=1) + F(10,10) PDF at x=1 closed-form `630/1024 ≈ 0.6152` + classic 95% crit F.DIST(statrs-internal x ≈ 3.3258, 5, 10) ≈ 0.95 anchor pinned. (`df1=2 pdf(0)` is *not* tested — statrs returns 0 there while true math gives 1; out of W5-D-3 scope.) |
| F.DIST.RT | ✅ | 9 | Wave 3 D-3 (W5-D-3) | W5-D-3: right-tailed F `P(F > x)` = `1 - CDF(x)` (matches IronCalc — uses `1-cdf()` rather than `sf()`). 3 args. Round-trip with F.DIST pinned. F(df1=df2) RT=0.5 at x=1 symmetry anchor. |
| F.INV | ✅ | 10 | Wave 3 D-3 (W5-D-3) | W5-D-3: left-tailed inverse F-distribution. 3 args. **`0 ≤ p ≤ 1` INCLUSIVE** (like CHISQ.INV). `df1 ≥ 1`, `df2 ≥ 1`. F.INV(0.5, n, n) = 1 median + classic F.INV(0.95, 5, 10) ≈ 3.3258 LibreOffice anchor pinned. |
| F.INV.RT | ✅ | 10 | Wave 3 D-3 (W5-D-3) | W5-D-3: right-tailed inverse F. Solves `p = P(F > x) = 1-CDF(x)`. 3 args. **`0 < p ≤ 1`** — lower-strict (diverges from F.INV/CHISQ.INV/CHISQ.INV.RT inclusive lower; matches IronCalc canon). df1≥1, df2≥1. F.INV.RT(0.05, 5, 10) ≈ 3.3258 (matches F.INV(0.95, 5, 10)) pinned. |
| BINOM.DIST | ✅ | 10 | Wave 3 D-4 (W5-D-4) | W5-D-4: binomial PMF/CDF via `statrs::Binomial`. 4 args. `0 ≤ k ≤ n` (truncated to u64); `0 ≤ p ≤ 1` INCLUSIVE both. Closed-form anchors for n=10, p=0.5: `pmf(0)=1/1024`, `pmf(5)=252/1024`. (W5-D-4.1 Codex LOW-1 closure: anchor description rewritten — prior `1/252/1024-1024` was malformed.) First discrete-distribution batch. |
| BINOM.DIST.RANGE | ✅ | 10 | Wave 3 D-4 (W5-D-4) | W5-D-4: **VARIADIC** (3 or 4 args). `P(lower ≤ X ≤ upper)` via `CDF(upper) - CDF(lower-1)` when `lower > 0`, else `CDF(upper)` directly (avoids u64 underflow). 3-arg form uses single-point lower=upper. |
| BINOM.INV | ✅ | 9 | Wave 3 D-4 (W5-D-4) | W5-D-4: smallest k s.t. `CDF(k) ≥ alpha`. 3 args. **`0 ≤ p < 1` STRICT upper** (diverges from BINOM.DIST inclusive); `0 < alpha < 1` strict both. **`p=0` special-cased inline** — statrs's default `DiscreteCDF::inverse_cdf` panics on degenerate distributions; we return 0 directly. |
| NEGBINOM.DIST | ✅ | 9 | Wave 3 D-4 (W5-D-4) | W5-D-4: negative-binomial PMF/CDF via `statrs::NegativeBinomial`. 4 args (failures, successes, p, cumulative). `failures ≥ 0`, `successes ≥ 1`, `0 < p < 1` strict both. Closed-form anchors for r=1: pmf(0)=p, pmf(k)=(1-p)^k·p. |
| POISSON.DIST | ✅ | 10 | Wave 3 D-4 (W5-D-4) | W5-D-4: Poisson PMF/CDF via `statrs::Poisson`. 3 args. `x ≥ 0`, `mean ≥ 0`. Closed-form anchors: pmf(0;λ=1)=e⁻¹, CDF(1;λ=1)=2e⁻¹. **λ=0 special-cased inline** (statrs rejects; degenerate distribution: P(X=0)=1, P(X>0)=0). |
| EXPON.DIST | ✅ | 10 | Wave 3 D-4 (W5-D-4) | W5-D-4: exponential PDF/CDF **closed-form** (no statrs kernel): `CDF=1-e^(-λx)`, `PDF=λe^(-λx)`. 3 args. `x ≥ 0`, `λ > 0` STRICT. |
| LOGNORM.DIST | ✅ | 8 | Wave 3 D-4 (W5-D-4) | W5-D-4: log-normal PDF/CDF via `statrs::LogNormal`. 4 args. `x > 0` STRICT (log-normal undefined at 0); `σ > 0` strict. `μ` may be negative (underlying normal's mean). Closed-form anchors: CDF(1;μ=0,σ=1) = Φ(0) = 0.5, PDF(1;μ=0,σ=1) = 1/√(2π). |
| LOGNORM.INV | ✅ | 8 | Wave 3 D-4 (W5-D-4) | W5-D-4: inverse log-normal CDF via `statrs::LogNormal`. 3 args. `0 < p < 1` strict both; `σ > 0` strict. Closed-form median: `LOGNORM.INV(0.5, μ, σ) = exp(μ)`. |
| GAMMA | ✅ | 9 | Wave 3 D-5 (W5-D-5) | W5-D-5: gamma function `Γ(x)` via `statrs::function::gamma::gamma` (NOT distribution-backed). Closed-form anchors: `Γ(1)=1`, `Γ(5)=24`, `Γ(0.5)=√π`, `Γ(-0.5)=-2√π`. Reject negative integers (poles); `Γ(0)=Inf → #NUM!` via finite-result guard. |
| GAMMA.DIST | ✅ | 8 | Wave 3 D-5 (W5-D-5) | W5-D-5: gamma distribution PDF/CDF via `statrs::Gamma`. 4 args. `x ≥ 0`, `α > 0`, `β > 0` STRICT. Excel shape-scale `(α, β)` converted to statrs shape-rate via `rate=1/β`. α=1 reduces to exponential(1) — closed-form anchors verified. |
| GAMMA.INV | ✅ | 9 | Wave 3 D-5 (W5-D-5) | W5-D-5: inverse gamma CDF. 3 args. `0 ≤ p ≤ 1` INCLUSIVE; `α > 0`, `β > 0`. Closed-form anchor: GAMMA.INV(0.5, 1, 1) = ln(2). |
| GAMMALN | ✅ | 9 | Wave 3 D-5 (W5-D-5) | W5-D-5: `ln(Γ(x))` via `statrs::function::gamma::ln_gamma`. 1 arg. `x ≥ 0`; reject negative. Closed-form anchors: `ln(Γ(1))=0`, `ln(Γ(4))=ln(6)`, `ln(Γ(0.5))=½·ln(π)`. |
| GAMMALN.PRECISE | ✅ | 5 | Wave 3 D-5 (W5-D-5) | W5-D-5: **alias of GAMMALN** (Excel 2010 renamed for naming consistency; same impl). Covered by alias-equality tests + independent error/arity tests. |
| BETA.DIST | ✅ | 10 | Wave 3 D-5 (W5-D-5) | W5-D-5: beta distribution PDF/CDF via `statrs::Beta`. **VARIADIC 4-6 args**: optional `[A, B]` bounds default to `[0, 1]`. Transforms via `t=(x-A)/(B-A)`; PDF scaled by `1/(B-A)` Jacobian. Beta(1,1) is U(0,1) — closed-form anchors. `α > 0`, `β > 0`, `A < B`, `A ≤ x ≤ B`. |
| BETA.INV | ✅ | 9 | Wave 3 D-5 (W5-D-5) | W5-D-5: inverse beta CDF. **VARIADIC 3-5 args**: optional `[A, B]`. `0 < p < 1` STRICT both; `α > 0`, `β > 0`, `A < B`. Returns `A + t·(B-A)` where `t=inverse_cdf(p)`. |
| CONFIDENCE.NORM | ✅ | 10 | Wave 3 D-5 (W5-D-5) | W5-D-5: normal-CI half-width `z(1-α/2)·σ/√n`. 3 args. `0 < α < 1` strict, `σ > 0`, `size.floor() ≥ 1`. Size uses `.floor()` (matches IronCalc). Reuses W5-D-1 `standard_normal()` helper. |
| CONFIDENCE.T | ✅ | 9 | Wave 3 D-5 (W5-D-5) | W5-D-5: Student's-t CI half-width `t(1-α/2; df=n-1)·σ/√n`. 3 args. **`size < 2` → `#DIV/0!`** (NOT `#NUM!` — Excel canon; only fn in distribution_fns returning `#DIV/0!`). Size uses `.trunc()` (diverges from CONFIDENCE.NORM's `.floor()`). Reuses W5-D-2 `students_t_with`. |
| TREND / FORECAST / LINEST / LOGEST | ❌ | 0 | 4.10 | Array-result; needs 4.7 |

### Logical

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| IF | ⚠️ | 8+ | 0 (eager) | Eager both-branch eval; lazy semantics → 4.3 (FN4-03) |
| IFS | ✅ | 6 | 4.10.A | W5-163: variadic test+value pairs; first true wins. Errors in tests propagate. No match → #N/A. Odd arg count silently discards trailing unpaired arg (matches Excel canon). Empty → #VALUE!. Non-bool tests coerce via `to_logical`. |
| IFERROR | ⚠️ | 5+ | 0 (eager) | Eager eval; lazy → 4.3 |
| IFNA | ✅ | 4 | 4.10.A | W5-163: like IFERROR but only catches `#N/A`. Other errors propagate. Exactly 2 args. |
| AND / OR | ✅ | 5+ | 0 | Eager; truthy semantics per Excel |
| NOT | ✅ | 3+ | 0 | |
| XOR | ✅ | 8 | 4.10.A | W5-163: variadic parity (true iff odd count of true args). Mirrors AND/OR arg handling: skip blanks, coerce non-bool via `to_logical`, propagate errors, require ≥1 non-blank → otherwise #VALUE!. |
| TRUE / FALSE | ⚠️ | — | 0 | Parsed as identifiers; promoted at bind; explicit `Bool` Token deferred to 4.1 follow-up |
| SWITCH | ✅ | 10 | 4.10.A | W5-163: type-strict equality (Number≠"1"; verified vs IronCalc + Microsoft docs). Errors in caseK values PROPAGATE (Codex HIGH-1 correction). NaN never matches. Odd args after expression → trailing unpaired arg is the default. No match + no default → #N/A. Case-insensitive ASCII String equality. |

### Math & Trigonometry

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| ABS | ✅ | 3+ | 0 | |
| SQRT | ✅ | 3+ | 0 | Negative → #NUM! |
| ROUND | ✅ | 5+ | 0 | |
| ROUNDUP | ⚠️ | 4 | 4.3 V1 | Round away from zero; sign-preserving. **Binary-float gotcha:** `ROUNDUP(0.1 + 0.2, 1)` rounds `0.30000000000000004` to `0.4`, while Excel's 15-digit display-aware rounding usually yields `0.3`. Decimal-aware rounding lands Phase 4.5 (number formats). |
| ROUNDDOWN | ⚠️ | 2 | 4.3 V1 | Truncate toward zero. Same binary-float gotcha as ROUNDUP. **Negative-zero leak:** very-small negative inputs produce `Value::Number(-0.0)` (PartialEq says `0.0 == -0.0`; cosmetic only — display may show `-0`). |
| MROUND | ✅ | 4 | 4.3 V2 | W5-57 + W5-60 fix: round-half-away-from-zero; sign-mismatch number/multiple → #NUM!. **W5-60**: `MROUND(0, 0)` → `0` (matches Excel); `MROUND(nonzero, 0)` → `#NUM!` (was incorrectly returning `0` per Sonnet HIGH H1). |
| CEILING | ✅ | 4 | 4.3 V2 | W5-57: round away from zero to nearest multiple of significance. Default significance=1. Excel sign rule: number > 0 with significance < 0 → #NUM!. CEILING.MATH (mode flag) deferred. |
| FLOOR | ✅ | 3 | 4.3 V2 | W5-57: round toward zero to nearest multiple. Same sign rule as CEILING. significance=0 with non-zero number → #DIV/0! (Excel canon — diverges from CEILING which returns 0). FLOOR.MATH deferred. |
| CEILING.MATH | ✅ | 7 | 4.3 polish | W5-61: signature `(number, [significance], [mode])`. Significance is `abs(significance)` — sign ignored (unlike CEILING). Default significance=1, mode=0. Positive number always rounds toward +∞; negative number with mode=0 rounds toward +∞ (toward zero), with mode≠0 rounds toward -∞ (away from zero). significance=0 returns 0. CEILING.PRECISE deferred to 4.10. |
| FLOOR.MATH | ✅ | 8 | 4.3 polish | W5-61: signature `(number, [significance], [mode])`. Mirror of CEILING.MATH. Positive number rounds toward -∞; negative+mode=0 toward -∞ (away from zero); negative+mode≠0 toward +∞ (toward zero). significance=0 + nonzero number → #DIV/0! (mirrors FLOOR canon, diverges from CEILING.MATH). FLOOR.PRECISE deferred to 4.10. |
| INT | ✅ | 3+ | 0 | Truncation toward -∞ |
| TRUNC | ✅ | 1 | 4.3 V1 | Truncation toward 0; optional `digits` arg |
| MOD | ✅ | 3+ | 0 | Excel mod semantics, sign-of-divisor |
| QUOTIENT | ✅ | 2 | 4.3 V2 | W5-57: integer truncation TOWARD ZERO (not floor). 0 denominator → #DIV/0!. |
| ODD | ✅ | 1 | 4.3 V2 | W5-57: round away from zero to nearest odd integer. ODD(0) = 1 (Excel canon). |
| EVEN | ✅ | 1 | 4.3 V2 | W5-57: round away from zero to nearest even integer. EVEN(0) = 0. |
| POWER | ✅ | 5+ | 0 | Same special cases as `^` operator |
| EXP | ✅ | 1 | 4.3 V1 | `#NUM!` on overflow |
| LN | ✅ | 2 | 4.3 V1 | Natural log; non-positive → `#NUM!` |
| LOG | ✅ | 3 | 4.3 V1 | Optional base; base=1 or non-positive → `#NUM!` |
| LOG10 | ✅ | 1 | 4.3 V1 | Base-10 log; non-positive → `#NUM!` |
| SIN / COS / TAN / ASIN / ACOS / ATAN / ATAN2 | ✅ | 13 | 4.3 V2 | W5-51; ATAN2 uses Excel `(x, y)` arg order (not Rust's `(y, x)`); ATAN2(0,0)→#DIV/0!; ASIN/ACOS domain `|x|>1`→#NUM!; TAN(π/2) returns huge-finite (Excel canon, not error). **W5-D-13.1 megaudit closure (Codex HIGH-002 / Opus HIGH-2):** ATAN2 was previously unreachable from formula source (`ATAN2(1,1)` lex-errored with `ColumnTooLarge("ATAN")` — 4-letter prefix exceeded the 3-letter column-ref limit). The W5-D-13.1 lexer letters>3+digit Ident-fallback now emits `Ident("ATAN2")` so the parser dispatches correctly. |
| SINH / COSH / TANH / ASINH / ACOSH / ATANH | ✅ | 8 | 4.3 V2 | W5-57: hyperbolic + inverse hyperbolic. ACOSH domain x≥1 → #NUM! otherwise. ATANH domain \|x\|<1 (Excel canon: ATANH(±1) → #NUM!, not ±∞). SINH/COSH overflow → #NUM! via sanitize_f64. |
| PI | ✅ | 2 | 4.3 V1 | Constant; arity check |
| DEGREES | ✅ | 1 | 4.3 V1 | Radians → degrees |
| RADIANS | ✅ | 1 | 4.3 V1 | Degrees → radians |
| SIGN | ✅ | 1 | 4.3 V1 | -1/0/1 |
| FACT / FACTDOUBLE | ✅ | 6 | 4.10.D | W5-166: factorial + double factorial. FACT truncates toward zero, n<0 → #NUM!, n>170 → #NUM! (f64 overflow). FACTDOUBLE(0)=1, FACTDOUBLE(-1)=1 (Excel canon special case), n<-1 → #NUM!. |
| COMBIN / COMBINA | ✅ | 6 | 4.10.D | W5-166: combinations without/with repetition. Iterative product avoids factorial overflow for large n. Truncate args toward zero; non-negative integers; k>n → #NUM!. COMBINA: n=0,k>0 → #NUM! (degenerate; verified vs IronCalc); n=0,k=0 → 1. |
| PERMUT / PERMUTATIONA | ✅ | 3 | 4.10.D | W5-166: permutations without/with repetition. PERMUT: P(n,k)=n!/(n-k)!; k>n → #NUM!. PERMUTATIONA: n^k; 0^0=1 (mathematical convention via `f64::powf`). |
| GCD / LCM | ✅ | 6 | 4.3 V2 | W5-57: variadic non-negative integers. Negative arg → #NUM!. Non-integer truncated toward zero (Excel canon). LCM with any 0 returns 0; GCD with all-0 returns 0. Range args not supported (V1 scalar-only). |
| RAND / RANDBETWEEN | ✅ | 3+ | 3.7 | xorshift64, seeded test fixture |
| RANDARRAY | ❌ | 0 | 4.7 | Array-result; needs 4.7 |
| SUMPRODUCT | ✅ | 7 | 4.3 V2 | W5-55: element-wise multiply arrays then sum. All arrays must have same length. Non-numeric cells treated as 0 (lenient — Excel canon for SUMPRODUCT). Error cells propagate. Scalar args act as constant multipliers. |
| SUMSQ | ✅ | 4 | 4.10.D | W5-166: variadic sum of squares (ScalarFn; range args flatten via dispatch like SUM). Text + blank skipped, bool coerced (TRUE=1, FALSE=0), errors propagate. Empty → 0. |
| SUMX2MY2 / SUMX2PY2 / SUMXMY2 | ✅ | 9 | 4.10.D | W5-166: paired array sum-of-squares variants. RangeAwareFn; both args must be ranges; W5-60 strict 2D-shape check (shape mismatch → #VALUE!). Non-numeric cells coerce to 0 (lenient, matches IronCalc canon). Errors in either array propagate. **W5-D-13.1 megaudit closure (Codex HIGH-002 / Opus HIGH-2):** SUMXMY2 was previously unreachable from formula source (`SUMXMY2(...)` lex-errored with `ColumnTooLarge("SUMXMY")`). The W5-D-13.1 lexer letters>3+digit Ident-fallback fixed it. SUMX2MY2 / SUMX2PY2 were already reachable via the W5-D-9 letters-digits-letters extension. Also admitted to `is_aggregate_function` in W5-D-13.1 for named-range arg support. |
| AGGREGATE | ❌ | 0 | 4.10 | Conditional aggregation; depends on 4.7 |
| SUBTOTAL | 🟡 | 31 | 4.10 V1-260 sealer (W5-D-12) | W5-D-12: conditional aggregate dispatcher. Range-aware; routes function_num ∈ {1..=11, 101..=111} to AVERAGE/COUNT/COUNTA/MAX/MIN/PRODUCT/STDEV.S/STDEV.P/SUM/VAR.S/VAR.P. **v1 divergences (documented)**: (1) 101..=111 normalize to 1..=11 because the engine has no hidden-row metadata; (2) nested SUBTOTAL calls in arg ranges are NOT skipped (engine evaluates args before dispatch — AST not available); (3) inherited from dispatched aggregates: text in data → #VALUE! (vs IronCalc/Excel skip); Boolean in data → coerced 1/0 (vs skip); Blank scalar → skipped (vs IronCalc push-as-0); PRODUCT of empty → 0 (vs 1.0 multiplicative identity). function_num truncates toward zero. NaN function_num → #NUM! (error-code consistency, not panic-safety). Boolean function_num coerces TRUE→1/FALSE→0 (IronCalc match, Excel-divergent). Text function_num always → #VALUE! (engine W5-58 strict, vs IronCalc lenient parse). **W5-D-12.1 binder admission is PARTIAL**: named-range args (`SUBTOTAL(9, SalesRange)`) work; literal range args (`SUBTOTAL(9, A1:A10)`) do NOT bind in v1 — same engine-wide `AggregateArg`-side deferral that affects standalone `SUM(A1:A10)`. Scalar args + named ranges supported. IronCalc reference: `subtotal.rs` line-by-line on dispatch shape; row-visibility + nested-skip + data-coercion semantics differ. **CLOSES Phase 4.10 V1-260 at 260 registered fns.** 🟡 = partial: numeric work shipped, literal-range-arg lift pending engine-wide. |

### Text

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| LEN | ✅ | 3 | 4.3 V1 | **DIVERGES from Excel for emoji ZWJ sequences.** Rust counts Unicode scalar values (`.chars().count()`); Excel counts UTF-16 code units (`LENB`-like for non-BMP). For ASCII / BMP-plane text, both match. ZWJ family emoji like `👨‍👩‍👧`: Quantbook = 5, Excel = 8. (Originally anticipated for Phase 4.9 — that phase shipped R1C1+locale-separators+`@`, NOT UTF-16 string semantics. Awaiting a future Phase.) |
| LEFT / RIGHT / MID | ⚠️ | 9 | 4.3 V2 | W5-56: 1-based positions; UTF-8 char-count (UTF-16 canon deferred to a future Phase, same divergence class as LEN). Negative num_chars → #VALUE!; MID start < 1 → #VALUE!. |
| UPPER | ⚠️ | 2 | 4.3 V1 | Rust's Unicode-default mapping. **DIVERGES from Excel for German ß** (Quantbook = `SS`, Excel = `ß`) and any other locale-sensitive mapping (Turkish I, Greek final sigma). For ASCII-only text both match. (Originally anticipated for Phase 4.9 locale-aware case — that phase did NOT address case mapping. Awaiting a future Phase.) |
| LOWER | ⚠️ | 1 | 4.3 V1 | Rust Unicode-default. Same divergence class as UPPER. Awaiting a future Phase. |
| PROPER | ✅ | 6 | 4.3 polish | W5-61: title-case each "word". A word starts after any non-letter character (Unicode). Digits and punctuation break words (Excel canon — `"123abc"` → `"123Abc"`, `"o'neill"` → `"O'Neill"`). |
| TRIM | ✅ | 1 | 4.3 V1 | Strip + collapse internal space runs |
| CLEAN | ✅ | 4 | 4.3 polish | W5-61: strip ASCII control chars 0x00–0x1F (tab, LF, CR, and the rest). Chars ≥ 0x20 and all Unicode pass through. |
| CONCATENATE | ⚠️ | 4 | 4.3 V2 | W5-56: variadic scalar args, no range support (Excel CONCATENATE is the legacy non-range version). Errors propagate. CONCAT (range-aware variant) deferred to next batch. |
| CONCAT | ✅ | 7 | 4.3 polish | W5-61: range-aware variant of CONCATENATE. Accepts ranges (flattens row-major) and scalars. Blanks become empty strings (no skip). Numbers / bools coerce to text representation. Errors propagate (first one returned). Variadic; ≥1 arg required. |
| TEXTJOIN | ✅ | 9 | 4.10.E | W5-167: variadic delimiter join. RangeAwareFn — accepts scalars + ranges; ranges flatten row-major. Args: `delimiter` (scalar text; blank→empty), `ignore_empty` (bool; TRUE skips empty strings and blanks), `args...`. Errors propagate. Excel 32,767-char cap enforced (matches CONCAT/REPT). |
| FIND | ⚠️ | 5 | 4.3 V2 | W5-56: case-SENSITIVE substring search; 1-based result; not found → #VALUE!. Optional start_num. Empty needle returns start_num. No wildcards (FIND never supports wildcards in Excel anyway). |
| SEARCH | ✅ | 7 | 4.3 polish | W5-56 + W5-61: case-INSENSITIVE substring search. **Wildcards `?` (single char) and `*` (any chars) supported W5-61.** Escape with `~` (`~?`, `~*`, `~~`). Same start_num + not-found semantics as FIND. Empty needle returns start_num. |
| SUBSTITUTE | ⚠️ | 4 | 4.3 V2 | W5-56: case-sensitive find-and-replace. Optional instance_num replaces only the Nth occurrence (1-based). Empty old_text is a no-op (Excel canon). |
| REPLACE | ⚠️ | 3 | 4.3 V2 | W5-56: position-based replace. 1-based start_num; num_chars 0 = pure insert; start past end appends. Out-of-bounds args clamp gracefully. |
| REPT | ⚠️ | 3 | 4.3 V2 | W5-56: text repeat. Excel canonical 32,767-character cap enforced (returns #VALUE! when exceeded). Negative num_times → #VALUE!. |
| EXACT | ✅ | 2 | 4.3 V2 | W5-56: case-sensitive equality. Numbers coerce to text before compare. |
| TEXT | ✅ | 28 | 4.5.E | W5-83: render Value via parsed Excel format string. Built on the W5-77→W5-82 format module (parser+renderer+FormatTable+overlay+runtime). Parse failures (incl. V2-deferred [Red]/conditionals/elapsed/fraction) surface as #VALUE!. Tests in `format::text_fn::tests` + `workbook_runtime::tests::text_formula_*` + e2e `format_persistence_round_trip_through_qbook`. |
| VALUE | ✅ | 7 | 4.10.E | W5-167: parse text as number, locale-aware decimal separator (EnUs `.`; De/Fr `,`). ContextAwareFn. Trim whitespace; reject empty / non-numeric → #VALUE!. Numbers pass through; Blank → 0. **Strict locale-confusion guard**: in De/Fr locale, `.` in the numeric string → #VALUE! (closes ambiguity for "1.5" vs "1,5"). Currency prefixes + thousands grouping NOT parsed in V1; bundle with Phase 4.5 polish wave. |
| NUMBERVALUE | ✅ | 29 | 4.10 polish | W5-173: locale-explicit text→number. ContextAwareFn. 1-3 args; optional `decimal_separator` + `group_separator` (multi-char inputs use first char per Microsoft canon; defaults from `ctx.locale`). Empty / whitespace-only text → 0 (DIVERGES from VALUE which returns #VALUE!). Trailing `%` divides by 100 (n marks → /100^n). Decimal == group → #VALUE!; decimal repeated → #VALUE!; group AFTER decimal → #VALUE!. Group BEFORE decimal allowed any number of times without 3-digit grouping enforcement. Internal ASCII space + NBSP ignored per "spaces inside Text are ignored" rule. Leading sign only at position 0. Letters / currency symbols / scientific notation NOT supported (V1 strict). **DIVERGENCES vs Excel**: (1) scientific notation (`1.5e3`) → #VALUE! here, parsed in Excel; (2) when `group_separator` is ASCII space (Fr locale default), the "group after decimal → #VALUE!" rule does not fire because the universal "spaces are ignored" walk skips spaces before reaching the group check — pragmatically this matches Excel's own canon for the common `"1 234,5"` case but diverges on the contrived `"1,234 5"` case (Excel: #VALUE!; here: 1.2345). Bundle both with currency-prefix polish in Phase 4.5 polish wave. |
| FIXED | ✅ | 6 | 4.10.E | W5-167: number → text with fixed decimals + locale-aware thousands grouping. ContextAwareFn. Default decimals=2; negative decimals round LEFT of decimal point; `no_commas=TRUE` suppresses grouping. Half-away-from-zero rounding. Locale-aware separators (EnUs: `,` thousands `.` decimal; De: `.` thousands `,` decimal; Fr: ` ` thousands `,` decimal). |
| DOLLAR | ✅ | 13 | 4.10 polish | W5-167 (initial) + W5-175 (locale + accounting parens): currency text with locale-specific symbol + accounting-style negatives. ContextAwareFn. Always groups thousands. **EnUs:** `$1,234.50` / `($1,234.50)` (accounting parens, no minus, currency inside parens). **De:** `1.234,50 €` / `-1.234,50 €` (euro suffix with space, leading minus). **Fr:** `1 234,50 €` / `-1 234,50 €` (euro suffix with space + ASCII space thousands grouping, leading minus). V1 picks one canonical form per locale; Excel's Windows-regional-setting variations (e.g. De with parens-style negatives) deferred to a follow-on polish if needed. £/¥ + other minor currencies post-v1. |
| CHAR / CODE | ✅ | 5 | 4.10.E | W5-167: codepoint round-trip for code 1..=255. **DIVERGENCE**: Excel uses Windows-1252; we use Unicode codepoint mapping. Identical for 1-127 ASCII; positions 128-159 differ (Windows-1252 has extra glyphs; Unicode has C1 control characters). Document divergence; bundle Windows-1252 polish with deferred UTF-16 work. |
| UNICODE / UNICHAR | ✅ | 5 | 4.10.E | W5-167: full Unicode codepoint round-trip. UNICHAR: code 1..=char::MAX; surrogates (0xD800..=0xDFFF) → #N/A. Canonical match vs Excel. |
| REGEX / REGEXMATCH / REGEXEXTRACT / REGEXREPLACE | ❌ | 0 | post-v1 | Google Sheets extension; not in Excel canon |
| LEFTB / RIGHTB / MIDB / LENB / FINDB / SEARCHB | ❌ | 0 | 4.10 | Byte-length variants (DBCS) |
| TEXTBEFORE / TEXTAFTER / TEXTSPLIT | ❌ | 0 | 4.7 | Modern Excel; array-result |

### Date & Time

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| NOW / TODAY | ✅ | 5+ | 3.7 | Approximate Excel-1900 epoch; precise leap-year handling → 4.5 |
| DATE / TIME / DATEVALUE / TIMEVALUE | ✅ | 125 | 4.5 (W5-75 + W5-76) | W5-D-13.1 matrix drift closure: all 4 registered via `register_context_aware` (date_fns module). 125 date/time unit tests cover the whole 4.5 family (this row + the next 5). |
| YEAR / MONTH / DAY / HOUR / MINUTE / SECOND | ✅ | (see DATE row) | 4.5 (W5-75 + W5-76) | W5-D-13.1: all 6 registered; tests counted in DATE row. |
| WEEKDAY / WEEKNUM / ISOWEEKNUM | ✅ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: all 3 registered; tests counted in DATE row. |
| DAYS / DAYS360 / NETWORKDAYS / NETWORKDAYS.INTL | ⚠️ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: DAYS, DAYS360, NETWORKDAYS registered. **NETWORKDAYS.INTL not registered** (locale-aware variant — defer). DAYS360 was previously also blocked at lex time (4-letter prefix); W5-D-13.1 lexer Ident-fallback closure makes it reachable from source text. |
| WORKDAY / WORKDAY.INTL | ⚠️ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: WORKDAY registered. **WORKDAY.INTL not registered** (locale-aware variant — defer). |
| EDATE / EOMONTH | ✅ | (see DATE row) | 4.5 (W5-75) | W5-D-13.1: both registered; tests counted in DATE row. |
| DATEDIF | ✅ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: registered. Excel-specific; leap-month edge cases covered in date_fns tests. |
| YEARFRAC | ✅ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: registered. Multiple day-count bases supported via the `basis` arg. |

### Lookup & Reference

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| VLOOKUP | ⚠️ | 8 | 4.3 V2 | (see Aggregates/Conditional section for full notes; W5-54 shipped) |
| HLOOKUP | ⚠️ | 2 | 4.3 V2 | (see W5-54 above) |
| LOOKUP | ❌ | 0 | 4.10 | Vector & array forms; less common — defer past V1 wave 1 |
| XLOOKUP | ✅ | 20 | 4.10.G + 4.10 polish | W5-169 (initial) + W5-176 (real binary search). Scalar-return V1. Modes: match_mode (0=exact, -1=exact-or-next-smaller, 1=exact-or-next-larger, 2=wildcard); search_mode (1=forward, -1=reverse, ±2=binary). **W5-176 closure**: binary modes (`±2`) now use real lower-bound bisection (`xlookup_find_index_binary`) instead of linear scan. Per Excel canon: caller is responsible for the sort invariant — unsorted input to binary mode produces undefined results (typically `#N/A`), matching Excel which does not validate sort order. Mode `2` = ascending; mode `-2` = descending (comparator inverted). Wildcard + binary (`match_mode=2 search_mode=±2`) rejected with `#VALUE!` (Excel + IronCalc canon). `if_not_found` arg returned on miss (default `#N/A`). lookup_array must be 1D; 2D return_array → `#VALUE!` (spill semantics await Phase 4.7 polish). |
| MATCH | ⚠️ | 7 | 4.3 V2 | W5-54 (see notes above) |
| XMATCH | ✅ | 6 | 4.10.G + 4.10 polish | W5-169 (initial) + W5-176 (binary search inherited via shared `xlookup_find_index`). Modern MATCH variant. Returns 1-based position; same match_mode + search_mode semantics as XLOOKUP. No match → `#N/A`. |
| INDEX | ⚠️ | 5 | 4.3 V2 | W5-54 (see notes above) |
| OFFSET | ❌ | 0 | 4.7 | Volatile; whitelisted in 3.2 but not implemented |
| INDIRECT | ❌ | 0 | 4.7 | Volatile; whitelisted in 3.2 but not implemented |
| ADDRESS | ✅ | 8 | 4.10.G | W5-169: cell address text formatter. `abs_num`: 1=$A$1 (default), 2=A$1, 3=$A1, 4=A1. `a1`: TRUE → A1 style (default), FALSE → R1C1. `sheet_text`: optional prefix; auto-quoted if it contains anything other than `[A-Za-z0-9_]`. row/col must be ≥ 1 → otherwise `#VALUE!`. Multi-letter columns supported (Z, AA, ZZ, AAA). |
| ROW | ✅ | 9+8 e2e | RT-V1-01 Step 2 (W5-RT-2) | W5-RT-2: 1-indexed row of arg's top-left cell (Reference / Range / single-cell Range), or calling cell's row if omitted. Multi-cell range arg in scalar context returns top-left row (Excel pre-365 implicit-intersection); at cell-boundary `#CALC!` (S1-HIGH-B/E guard prevents silent truncation). `ROW(#REF!)` → `#REF!` (HIGH-F). Array literal → `#VALUE!` in scalar context. |
| COLUMN | ✅ | 8+6 e2e | RT-V1-01 Step 2 (W5-RT-2) | W5-RT-2: symmetric to ROW; 1-indexed column index. |
| ROWS | ✅ | 8+8 e2e | RT-V1-01 Step 2 (W5-RT-2) | W5-RT-2: row count of arg. Accepts Reference, Range, Array literal (HIGH-C: `ROWS({1,2,3;4,5,6})=2`). Whole-column `ROWS(A:A)=1_048_576`. Non-reference → `#VALUE!`; error propagation. |
| COLUMNS | ✅ | 8+6 e2e | RT-V1-01 Step 2 (W5-RT-2) | W5-RT-2: column count; symmetric to ROWS. Whole-row `COLUMNS(1:1)=16_384`. |
| TRANSPOSE | ✅ | 12 | 4.7.N (W5-107) | W5-D-13.1 matrix drift closure: registered via `register_unified` (array-returning Unified-ABI). Returns array; spills via the cell-boundary write_spill path. Admitted to `is_aggregate_function` since W5-107 for named-range/Range arg support. |
| FILTER / SORT / SORTBY / UNIQUE | ❌ | 0 | 4.7 | Dynamic-array; modern Excel |
| CHOOSE | ✅ | 5 | 4.3 V2 | W5-54 (see notes above) |
| CHOOSEROWS / CHOOSECOLS | ❌ | 0 | 4.7 | Dynamic-array companions |
| HYPERLINK | ❌ | 0 | post-v1 | Display-side, UI-coupled |

### Information

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| ISNUMBER | ✅ | 1 | 4.3 V1 | TRUE iff Value::Number |
| ISTEXT | ✅ | 1 | 4.3 V1 | TRUE iff Value::Text |
| ISBLANK | ✅ | 1 | 4.3 V1 | TRUE iff Value::Blank |
| ISLOGICAL | ✅ | 1 | 4.3 V1 | TRUE iff Value::Boolean |
| ISERROR | ✅ | 2 | 4.3 V1 | TRUE for ANY error |
| ISNA | ✅ | 1 | 4.3 V1 | TRUE only for `#N/A` |
| ISERR | ✅ | 1 | 4.3 V1 | TRUE for errors EXCEPT `#N/A` |
| ISREF | ✅ | 10+11 e2e | RT-V1-01 Step 3 (W5-RT-3) | W5-RT-3: TRUE for cell/range refs (and reference-returning fns in future). Uses `ArgContract::LazyShape` — does NOT evaluate arg, so `ISREF(1/0)` returns FALSE (no #DIV/0!). v1: no reference-returning fns, so `ISREF(SUM(...))` = FALSE always. |
| ISFORMULA | ✅ | 9+10 e2e | RT-V1-01 Step 3 (W5-RT-3) | W5-RT-3: TRUE iff cell stores a formula. Uses `Eager` + `ReferenceQuery::is_formula_at`. Multi-cell range → `#N/A` (Microsoft canon; IronCalc returns `#VALUE!` divergence documented). Non-reference → `#N/A`. v1 cost: registers value-dep on referenced cell (formula-status dep kind deferred per design § 8 R8). |
| FORMULATEXT | ✅ | 9+15 e2e | RT-V1-01 Step 4 (W5-RT-4) | W5-RT-4: returns stored formula text WITH leading `=` (Excel canon). Uses `Eager` + `ReferenceQuery::formula_text_at` (impl on `WorkbookEnv` prepends `=`). Multi-cell → `#N/A` (vs IronCalc's `#ERROR!`). Non-reference → `#N/A`. No formula at cell → `#N/A`. **Producer canonicalization divergence (S4-HIGH-1):** `WorkbookRuntime::set_formula` stores canonical printer output; `WorkbookTransaction::put_formula` stores raw text — FORMULATEXT returns whichever was stored. **Self-reference producer/replay divergence (S4-HIGH-2):** `=FORMULATEXT(A1)` typed at A1 returns `#N/A` producer-side, full text replay-side; documented v1 divergence (pinned). CLOSES the reference-tier mini-phase (RT-V1-01). |
| ISEVEN / ISODD | ✅ | 4 | 4.10.C | W5-165: truncate toward zero (matches Excel canon — `ISEVEN(-2.5)` truncates to -2 → even). Blank coerces to 0 → ISEVEN(blank) = TRUE. Text → #VALUE!. |
| ISNONTEXT | ✅ | 1 | 4.10.C | W5-165: inverse of ISTEXT. Blank / Number / Boolean / Error → TRUE; only Text → FALSE. |
| TYPE | ✅ | 1 | 4.10.C | W5-165: 1=Number (Blank also coerces to 1), 2=Text, 4=Boolean, 16=Error. Excel's 64=Array unreachable on this scalar path; flattening happens in eval dispatch. |
| N | ✅ | 2 | 4.10.C | W5-165: Number → same; Blank → 0; Boolean → 1/0; **Text → 0 (NOT `#VALUE!` per Excel canon; verified vs IronCalc)**; Error → propagate. Date values (stored as Number) round-trip identically. |
| NA | ✅ | 2 | 4.10.C | W5-165: arity 0 → `#N/A`. Args → `#VALUE!`. |
| ERROR.TYPE | ✅ | 3 | 4.10.C | W5-165: 1=#NULL!, 2=#DIV/0!, 3=#VALUE!, 4=#REF!, 5=#NAME?, 6=#NUM!, 7=#N/A. Non-error → #N/A. Quantbook-specific sigils (#SPILL!, #CALC!, #DISCONNECTED!, #BINDING!, #TIMEOUT!) get extension codes 8-12. |
| INFO | ❌ | 0 | 4.7 | Volatile; whitelisted but not implemented |
| CELL | ❌ | 0 | 4.7 | Volatile; whitelisted but not implemented |
| SHEET / SHEETS | ❌ | 0 | 4.6 | Depends on cross-sheet machinery |

### Financial

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| PMT / FV / PV / NPER | ✅ | 9 | 4.10.F | W5-168: TVM equation `pv*(1+rate)^nper + pmt*(1+rate*type)*((1+rate)^nper - 1)/rate + fv = 0` (rate≠0); `pmt*nper + pv + fv = 0` (rate=0). `type=0` end of period; `type=1` (or any nonzero) beginning. Sign convention: outflows negative. Verified against IronCalc references. Returns `#NUM!` on undefined inputs (rate ≤ -1, NaN/Inf results). |
| RATE | ✅ | 1 | 4.10.F | W5-168: Newton-Raphson, 50 iterations max, eps=1e-7. Guess defaults to 0.1 (Excel canon). Fails to converge → `#NUM!`. Initial guess ≤ -1 → `#VALUE!`. |
| IPMT / PPMT | ✅ | 3 | 4.10.F | W5-168: interest + principal portions of period `k` payment. Invariant: `IPMT(k) + PPMT(k) = PMT`. Period < 1 or > nper+1 → `#NUM!`. |
| NPV | ✅ | 5 | 4.10.F | W5-168: Σ values[i] / (1+rate)^(i+1) (values are END-of-period cash flows; first value discounted). Variadic — accepts scalar + range args; ranges flatten row-major. Per Excel canon: non-numeric cells (text, bool) SKIPPED, blanks skipped, errors propagate. Empty cash-flow → `#NUM!`. |
| IRR | ✅ | 6 | 4.10.F | W5-168: Newton-Raphson around guess (default 0.1), bisection fallback over `[-0.99999, 100]`, 50 iterations max, eps=1e-8 / 1e-10. Requires sign-change in cash-flow → otherwise `#NUM!`. Non-numeric cells in range → `#VALUE!` (stricter than NPV per IronCalc canon). |
| MIRR | ✅ | 13 | 4.10 polish | W5-174: Modified IRR — closed-form per Microsoft + IronCalc port. Formula: `((-NPV(reinvest, pos) · (1+reinvest)^n) / (NPV(finance, neg) · (1+finance)))^(1/(n-1)) − 1` where `pos` / `neg` are the cash flows with opposite-sign terms zeroed. Excel canon: requires ≥1 positive AND ≥1 negative cash flow → otherwise `#DIV/0!`. Text + Bool + Blank cells in range SKIPPED per IRR/NPV convention (W5-171 closure pattern). `finance_rate < -1` → `#NUM!` via `compute_npv` guard. `finance_rate == -1` and `reinvest_rate == -1` get IronCalc cancellation analysis so the result stays defined where it makes sense. |
| XNPV | ✅ | 11 | Wave 3 closure (W5-D-7) | W5-D-7: closed-form date-indexed NPV. RangeAwareFn 3 args (rate + values + dates). Discount `(1+rate)^((dᵢ-d₀)/365)`. `rate > 0` STRICT. Microsoft canonical anchor ([-10000, 2750, 4250, 3250, 2750] @ [Jan-Mar-Oct 2008 / Feb-Apr 2009], rate=9% → ≈2086.65) pinned. Empty/non-numeric → #NUM! (strict; XNPV rejects unlike NPV which skips). Dates floored, must be in Excel-serial range `[0, 2_958_465]`, must not precede first date. |
| XIRR | ✅ | 12 | Wave 3 closure (W5-D-7) | W5-D-7: date-indexed IRR via Newton-Raphson on `compute_xnpv` derivative; bisection fallback on [-0.9999, 100]; final Newton-Raphson at guess=200 if bisection misses. RangeAwareFn 2-3 args (values + dates + [guess=0.1]). At least one positive AND one negative value required (else #NUM!). Microsoft canonical anchor → ≈0.3734 (37.34%) pinned. Round-trip XNPV(xirr_result, ...) ≈ 0 pinned. Empty cells in values default to 0.0 (XIRR-specific divergence from XNPV's strict rejection). Text → #VALUE!. |
| PRICE / YIELD / DURATION / MDURATION | ❌ | 0 | post-v1 | Bond math |
| SLN | ✅ | 8 | 4.10 polish | W5-180: straight-line depreciation. ScalarFn. Formula: `(cost − salvage) / life`. `life = 0` → `#DIV/0!` per Microsoft + IronCalc. `Blank` args coerce to `0` per the `arg_num` contract (consistent with the TVM family). Negative `life` passes through to a negative result — Microsoft docs don't explicitly reject; we match IronCalc's no-sign-check behavior. |
| SYD | ✅ | 10 | 4.10 polish | W5-180 + W5-182.1: sum-of-years digits depreciation. ScalarFn. Formula: `(cost − salvage) · (life − per + 1) · 2 / (life · (life + 1))`. **Asymmetric degenerate-case canon with SLN**: SYD `life = 0` → `#NUM!` (NOT `#DIV/0!`). W5-182.1 audit closure (Opus MEDIUM-2): this asymmetry is **IronCalc convention**, not documented Microsoft canon — Microsoft's SYD doc is silent on the error code for `life = 0`. `per <= 0` or `per > life` → `#NUM!`. `per = life` boundary is valid (the rule is `>`, not `>=`). Pinned by `syd_sum_over_periods_equals_total_depreciation` invariant test: Σ SYD over k=1..life = (cost − salvage). |
| DDB | ✅ | 16 | 4.10 polish | W5-181 + W5-182.1: double-declining-balance depreciation. ScalarFn, 4-5 args (`factor` defaults to 2). Closed-form despite the name (no period iteration). Formula: `rate = min(factor/life, 1)`; `value = cost·(1−rate)^(period−1)` if rate<1 else (cost if period==1 else 0); `new_value = cost·(1−rate)^period`; `result = max(value − max(salvage, new_value), 0)`. The salvage floor stops depreciation before over-depreciating (Excel canon). Validation: `period>life`, `cost<0`, `salvage<0`, `period<=0`, `factor<=0` all → `#NUM!`. **Engine-convention divergence vs IronCalc**: IronCalc rejects Boolean for `factor` only (via `get_number_no_bools`); our `arg_num` allows Boolean uniformly across all args for consistency with the rest of the financial family. **W5-182.1 Microsoft-canon divergence (Opus MEDIUM-9)**: Microsoft's DDB doc states "All five arguments must be positive numbers"; we follow IronCalc in accepting `cost == 0` and `salvage == 0` (both return sensible numeric results). |
| DB | ✅ | 22 | 4.10 polish | W5-182 + W5-182.1: fixed-declining-balance depreciation. ScalarFn, 4-5 args (`month` defaults to 12, truncated to integer **before** validation — so `month = 12.9` truncates to 12 and passes; `month = 0.5` truncates to 0 and is rejected). **Period-iterating** (each period depends on accumulated book value) — unlike DDB which is closed-form. Excel-specific 3-decimal rate rounding: `rate = round((1 − (salvage/cost)^(1/life)) · 1000) / 1000` deliberately introduces per-period error absorbed by the last-partial-period. First period uses `month/12` fraction; last period (`period = life + 1` and `month ≠ 12`) uses complementary `(12 − month)/12` fraction. Validation (W5-182.1 audit closures expanded): `month == 12 && period > life`, `period > life + 1`, `month <= 0`, `month > 12`, `period < 1` (W5-182.1: tightened from `<= 0` after Opus MEDIUM-6 — fractional `period < 1` silently returned period-2's value), `cost < 0`, `life <= 0` (W5-182.1: Codex HIGH-1 — `DB(1000, 100, 0, 1, 7)` previously returned 583.33), `life > i32::MAX || period > i32::MAX` (W5-182.1: DoS-class — Opus MEDIUM-7), all → `#NUM!`. `cost == 0` short-circuits to `0` (avoiding `(salvage/0)` NaN). **Engine-convention divergence vs IronCalc (W5-182.1 Codex MEDIUM-1 / Opus MEDIUM-3)**: IronCalc rejects Boolean for `month` via `get_number_no_bools`; our `arg_num` allows Boolean uniformly. **Fractional-life IronCalc-inherited quirk (W5-182.1 Opus MEDIUM-4)**: rate uses raw `life`, iteration uses `life.floor()` — internally inconsistent for fractional `life`; documented but not fixed without verified Excel behavior. |
| VDB | ✅ | 33 | 4.10 polish | W5-183 + W5-183.1 audit closures: variable-declining-balance depreciation. ScalarFn, 5-7 args (`factor` defaults to 2, `no_switch` defaults to FALSE). **Most complex single function in the depreciation batch.** Period-iterating with DDB-to-SLN crossover: for each period, compute DDB depreciation (`min(book·factor/life, book−salvage)`); compute SLN-from-here `(book−salvage)/max(life−period, 1)` (the `max(_, 1)` floor matters for fractional life only — Opus MEDIUM-1 corrected wording); if `!no_switch` AND `sln_now > ddb_now` permanently switch to SLN (lock in the per-period amount at switch time — mathematically equivalent to recompute-each-period). Add `period_dep · overlap_fraction` to total where overlap is `[max(period, start), min(period+1, end)]`. Book depletes by FULL `period_dep` (not the overlap fraction) since depreciation accrues whether or not the period is in the requested range. **IronCalc has VDB in docs nav only (no Rust impl)**; algorithm ported directly from Microsoft canon + 6 documented examples + independently verified against LibreOffice / OpenFormula via Codex audit (5 cross-check fixtures pinned in tests). Validation (W5-183.1 audit closures expanded): `cost<0`, `salvage<0`, `salvage>cost` (Codex HIGH-1 closure — LibreOffice + OpenFormula reject), `life<=0`, `start<0`, `end<start`, `end>life`, `factor<=0` all → `#NUM!`. `life >= i32::MAX || end >= i32::MAX` → `#NUM!` (W5-183.1: DoS guard tightened from `>` to `>=` after Opus HIGH-1 caught exact `i32::MAX as f64` slipping through; same fix applied to DB). `start == end`, `salvage == cost`, and `cost == 0` short-circuit to 0. **Engine convention**: `no_switch` uses `arg_type` which extends `arg_num` with explicit logical coercion (non-zero numeric → TRUE; blank → FALSE; errors propagate) — NOT "Boolean-strict" per W5-183.1 Opus MEDIUM-2 closure. Other args use `arg_num` (allows Boolean coercion) — same family pattern as DDB/DB. **Microsoft-canon divergence (W5-183.1 Opus MEDIUM-8)**: Microsoft says "all args except no_switch must be positive numbers"; we accept `cost==0` and `salvage==0` per the DDB-family convention. |
| FVSCHEDULE / RRI / PDURATION | ❌ | 0 | post-v1 | |
| ACCRINT / ACCRINTM / COUPDAYS / COUPNCD / COUPPCD | ❌ | 0 | post-v1 | Bond accrual |
| Currency / formatted (locale-specific symbols, accounting style) | ⚠️ | 0 | Phase 4.5 polish wave | DOLLAR shipped W5-167 (4.10.E) with `$` only + `-$X` for negatives; locale-specific currency symbols (€/£/¥) + accounting parens deferred. |

### Engineering (post-v1 unless flagged)

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| BITAND | ✅ | 10 | 4.10 V1-260 closeout (W5-D-8) | W5-D-8: bitwise AND. Both args `[0, 2^48-1]` integer. Closed-form `0b1100 & 0b1010 = 8`. |
| BITOR | ✅ | 10 | 4.10 V1-260 closeout (W5-D-8) | W5-D-8: bitwise OR. Same domain. `0b1100 \| 0b1010 = 14`. |
| BITXOR | ✅ | 9 | 4.10 V1-260 closeout (W5-D-8) | W5-D-8: bitwise XOR. Same domain. `0b1100 ^ 0b1010 = 6`. Self-XOR = 0. |
| BITLSHIFT | ✅ | 11 | 4.10 V1-260 closeout (W5-D-8) | W5-D-8: bitwise left shift. `number` in `[0, 2^48-1]`; `\|shift\| ≤ 53`. **Negative shift inverts direction** (Excel canon). Result overflow → `#NUM!`. |
| BITRSHIFT | ✅ | 11 | 4.10 V1-260 closeout (W5-D-8) | W5-D-8: bitwise right shift. Same domain. Negative-shift inverts to left-shift. Round-trip with BITLSHIFT pinned. |
| DEC2BIN | ✅ | 11 | 4.10 V1-260 closeout (W5-D-9) | W5-D-9: decimal → binary string. 1-2 args. `number` in `[-512, 511]`. Negative two's-complement → 10 digits. Optional `places` in `[1, 10]` zero-pads positive output. |
| DEC2OCT | ✅ | 10 | 4.10 V1-260 closeout (W5-D-9) | W5-D-9: decimal → octal string. 1-2 args. `number` in `[-2^29, 2^29-1]`. Same negative + places semantics. |
| DEC2HEX | ✅ | 11 | 4.10 V1-260 closeout (W5-D-9) | W5-D-9: decimal → hex string. 1-2 args. `number` in `[-2^39, 2^39-1]`. **Uppercase canon**. Same negative + places semantics. |
| BIN2DEC | ✅ | 8 | 4.10 V1-260 closeout (W5-D-9) | W5-D-9: binary numeric → decimal. **Strict 1-arg** (Microsoft canon). Takes NUMBER not text. High-bit-set sign-extends to negative. |
| OCT2DEC | ✅ | 8 | 4.10 V1-260 closeout (W5-D-9) | W5-D-9: octal → decimal. **Strict 1-arg**. **W5-D-9.1 closure**: auto-coerces Number → string (Excel canon; `OCT2DEC(10) = 8`). Length>10 → `#NUM!`. High-bit sign-extension. |
| HEX2DEC | ✅ | 8 | 4.10 V1-260 closeout (W5-D-9) | W5-D-9: hex → decimal. **Strict 1-arg**. **W5-D-9.1 closure**: auto-coerces Number → string (Excel canon; `HEX2DEC(10) = 16`). Length>10 → `#NUM!`. Mixed case accepted. High-bit sign-extension. |
| COMPLEX / IMABS / IMARGUMENT / IMCONJUGATE | ❌ | 0 | post-v1 | Complex-number math |
| ERF | ✅ | 10 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: Gauss error function via `statrs::function::erf::erf`. VARIADIC 1-2 args. With 1 arg: returns `erf(x)`; 2 args: definite-integral `erf(b) - erf(a)`. Closed-form anchors: `ERF(0)=0`, `ERF(1)≈0.84270`, `ERF(2)≈0.99532`. Odd-function symmetry pinned. |
| ERF.PRECISE | ✅ | 4 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: alias of ERF (1-arg form). Excel 2010 PRECISE variant. Pin alias parity at 6 x-values. Rejects 2-arg form. |
| ERFC | ✅ | 8 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: complementary error function via `statrs::function::erf::erfc`. `ERFC(x) = 1 - ERF(x)` identity pinned. statrs uses stable rational approximation (no cancellation at large positive x). |
| ERFC.PRECISE | ✅ | 2 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: alias of ERFC. Excel 2010 PRECISE variant. Alias parity pinned. |
| CONVERT | ❌ | 0 | post-v1 | Unit conversion (large table) |

### Database (DGET, DSUM, etc.) — defer post-v1

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| DGET / DSUM / DCOUNT / DAVERAGE / DMAX / DMIN / DPRODUCT / DSTDEV / DVAR | ❌ | 0 | post-v1 | Database functions; rare in practice |

### Reserved / Quantbook-specific

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| AI | 🔄 | 3+ | 0 | Returns `#AI_NOT_AVAILABLE_V1` sentinel per CORR-06 / T4-D05; real impl Phase 6.6 |
| LAMBDA | ❌ | 0 | post-v1 | Excel 365 closures; not in v1 target |

---

## 2. Operators

| Operator | Status | Tests | Notes |
|---|---|---|---|
| `+` (Plus) | ✅ | 50+ | Lenient text-to-number coercion (2A.9 M1) |
| `-` (Minus binary + unary) | ✅ | 30+ | |
| `*` (Mul) | ✅ | 30+ | |
| `/` (Div) | ✅ | 20+ | Excel-canon `#DIV/0!`; SIMD intentionally NOT lowered (2A.9 H5) |
| `^` (Pow) | ✅ | 20+ | `0^0 = #NUM!`; `0^-n = #DIV/0!`; negative base + non-integer exp = `#NUM!` |
| `%` (Percent unary postfix) | ✅ | 5+ | |
| `&` (Concat) | ✅ | 10+ | Coerces both via `to_text_for_formula` |
| `=` / `<>` / `<` / `<=` / `>` / `>=` | ✅ | 30+ | Excel-canon cross-type ordering (2A.9 M2): Number < Text < Bool |
| `:` (Range) | ✅ | 30+ | Token + bind path for `A1:B10`, `A:A`, `1:1` |
| `,` (Argument separator) | ✅ | 100+ | Localization → 4.9 (could be `;` per locale) |
| `;` (Statement separator) | ✅ | 5+ | Reserved for array literals (4.7) |
| `!` (Sheet qualifier) | ❌ | 0 | Phase 4.6 |
| `@` (Implicit intersection) | ❌ | 0 | Phase 4.9 |
| `#` (Spill range) | ❌ | 0 | Phase 4.7 |
| `[]` (Structured ref subscript) | ❌ | 0 | Phase 4.8 |

---

## 3. Coercion rules

| Rule | Status | Notes |
|---|---|---|
| Binary arithmetic text→number (lenient) | ✅ | `"5" + 1 = 6`; unparseable → `#VALUE!` (2A.9 M1) |
| Binary arithmetic bool→number | ✅ | `TRUE → 1`, `FALSE → 0` |
| Binary arithmetic blank→number | ✅ | `Blank → 0` |
| Binary comparison cross-type (Number < Text < Bool) | ✅ | 2A.9 M2 |
| Function-arg numeric coercion (SUM/AVERAGE skip non-numeric) | ✅ | |
| Function-arg numeric coercion (MIN/MAX skip non-numeric) | ✅ | |
| Function-arg numeric coercion (PRODUCT skip non-numeric) | ✅ | |
| Function-arg text→number (strict path) | ⚠️ | `to_number_strict` exists; usage scoped |
| Function-arg text→formula coercion | ✅ | `to_text_for_formula` for `&` |
| Date serial coercion | ❌ | Phase 4.5 |
| Empty-arg behavior in aggregates | ✅ | AVERAGE empty → `#DIV/0!`; MIN/MAX empty → 0; SUM empty → 0; PRODUCT empty → 0 |

---

## 4. Errors

| Variant | Sigil | Status | Notes |
|---|---|---|---|
| `Ref` | `#REF!` | ✅ | Missing-sheet read (2A.7 H6); xlsx-import-broken refs (4.11) |
| `Value` | `#VALUE!` | ✅ | Wrong-type op input |
| `NA` | `#N/A` | ✅ | Lookup-miss reserved class |
| `DivZero` | `#DIV/0!` | ✅ | `/0`, `0^-n`, AVERAGE empty |
| `Null` | `#NULL!` | ✅ | Intersection-of-disjoint-ranges (legacy v1 wire format ambiguity migrated in 2A.13 H4) |
| `Num` | `#NUM!` | ✅ | NaN, Inf, `0^0`, negative base + non-integer exp |
| `Name` | `#NAME?` | ✅ | Unresolved function name; bind-time UnresolvedName surfaces here too |
| `Spill` | `#SPILL!` | ⚠️ | Variant exists; emit logic in 4.7 |
| `Calc` | `#CALC!` | ✅ | Defensive fallback for AggregateNameRef pre-3.6; now unused but reserved |
| `Disconnected` | `#DISCONNECTED!` | ⚠️ | Variant exists; Phase 6.5 connectors |
| `Binding` | `#BINDING!` | ⚠️ | Variant exists; Phase 6.3 binding round-trips |
| `Timeout` | `#TIMEOUT!` | ⚠️ | Variant exists; Phase 6.1 (cancellation) + 6.4 (UDFs) |
| `Permission` | `#PERMISSION!` | ⚠️ | Variant exists; Phase 6.5 |
| `AINotAvailable` | `#AI_NOT_AVAILABLE_V1` | ✅ | CORR-06 sentinel; real impl 6.6 |
| `Circ` | `#CIRC!` | ✅ | Phase 3.4 Tarjan SCC emits for cycle members |

---

## 5. Arrays / spills

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Array literals `{1,2;3,4}` | ❌ | 4.7 | Lex tokens `{`, `}`, `\`, `;` not in 4.1 scope |
| Dynamic-array functions (SPILL semantics for FILTER, SEQUENCE, etc.) | ⚠️ | 4.7 | XLOOKUP shipped W5-169 scalar-return only; FILTER + SEQUENCE shipped 4.7.M/N. True dynamic-array spill semantics still 4.7. |
| Spill ranges (`A1#`) | ❌ | 4.7 | |
| Spill blocking (`#SPILL!`) | ❌ | 4.7 | |
| Spill invalidation on resize | ❌ | 4.7 | |
| Computed overlay writeback for spills | ⚠️ | 4.7 | Phase 3.5 overlay split is the substrate |
| Array-context evaluation | ⚠️ | 4.7 | Phase 2B.4 `BindContext::AggregateArg` is the substrate |

---

## 6. Tables (structured references)

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Table metadata in storage | ❌ | 4.8 | GAP-S-04 |
| `Table[Column]` parse | ❌ | 4.8 | Needs `[`, `]` tokens (per 4.1 gap matrix) |
| `Table[#All]` / `Table[#Headers]` / `Table[#Data]` | ❌ | 4.8 | |
| `Table[@Column]` (current-row) | ❌ | 4.8 | |
| Column insert/delete adjusts refs | ❌ | 4.8 | |
| Table aggregate deps via range graph | ❌ | 4.8 | Reuses Phase 3.3 stripe path |
| xlsx import creates tables | ❌ | 4.11 | |

---

## 7. Date systems

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Excel 1900 epoch (Windows default) | ⚠️ | 4.5 | NOW/TODAY use approximate 1899-12-30 epoch; 1900 leap-year quirk NOT modeled |
| Excel 1904 epoch (Mac legacy) | ✅ | 4.5.A | DTF-4-01 shipped W5-71; Workbook::date_system + .qbook v3 migration |
| Date serial arithmetic | ✅ | 4.5.B/C | 22 date/time fns shipped W5-72→W5-75 (V1 18/18 + V2 4/6) |
| Time serial arithmetic | ✅ | 4.5.B | HOUR/MINUTE/SECOND/TIME shipped W5-72 |
| Display format parsing | ✅ | 4.5.D | DTF-4-04 shipped W5-77→W5-82: parser + renderer + FormatTable + sparse overlay + .qbook v4 + WorkbookRuntime::read_display |
| Locale-sensitive date formats | ⚠️ | 4.9 | en-US only in V1 (Phase 4.5 ships); de/fr fixtures land Phase 4.9 per Codex HIGH 3 re-scope |

---

## 8. Localization

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Decimal separator (`.` vs `,`) | ❌ | 4.9 | Lexer-side |
| Argument separator (`,` vs `;`) | ❌ | 4.9 | Lexer-side |
| Function name localization | ❌ | 4.9 | Excel translates function names per locale; we use English-canonical |
| Error sigil localization | ❌ | 4.9 | |
| R1C1 mode | ❌ | 4.9 | LOC-4-01 |
| Implicit intersection | ❌ | 4.9 | LOC-4-03 (`@` operator) |
| Locale toggle in IDE | ❌ | 4.9 | LOC-4-04 |

---

## 9. xlsx round-trip

| Feature | Status | Phase | Notes |
|---|---|---|---|
| xlsx import (read) | ❌ | 4.11 | `ql-io-xlsx` is a 15-line stub (GAP-P-02) |
| xlsx export (write) | ❌ | 4.11 | |
| Cached values | ❌ | 4.11 | XLSX-4-02 must recalc through graph |
| Names / tables / formats round-trip | ❌ | 4.11 | XLSX-4-03 |
| Corruption surfaces clean errors | ❌ | 4.11 | XLSX-4-04 |
| `.ods` import/export | ❌ | post-v1 | `ql-io-ods` stub (GAP-P-02) |

---

## How to use this matrix

### For implementers (Phase 4.3+)

Find your function row. Status = ❌ → implement it. Status = ⚠️ → fix
the noted partial. Update the row when shipping: change ❌→✅, add a
test count, add a Phase ref (the commit that closed it).

### For reviewers

Use this matrix to verify "is this function safe to call in
production Quantbook?" — ✅ rows are safe; ⚠️ rows have known
limitations documented in Notes; ❌ rows return `#NAME?` at runtime
(unknown function).

### For coverage tracking

Run `bash scripts/report-compat-coverage.sh` to get the current
implemented / partial / missing counts. The script greps this file
for the status emojis.

---

## Open follow-ups

1. **Function row count vs Phase 4.3/4.10 targets.** This matrix
   currently lists ~180 functions across categories. Phase 4.3
   targets 100 implemented; Phase 4.10 targets ~260. The matrix
   should grow to ~260 rows by 4.10 entry; many "post-v1" rows above
   should be promoted into 4.10 scope.
2. **Tests column accuracy.** The Tests column today is an estimate
   (visual scan of the test files). The script should be updated to
   parse `cargo test --workspace` output and reconcile against the
   matrix at CI time.
3. **Excel parity notes**. Most rows say "Phase X to close" without
   pinning the exact Excel semantic difference. Per ECM-4-02, each
   function row should grow a "parity note" describing Excel-vs-
   Quantbook semantics where they differ.
