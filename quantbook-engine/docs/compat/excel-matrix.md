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
| PERCENTILE / PERCENTILE.INC / PERCENTILE.EXC | ❌ | 0 | 4.10 | |
| QUARTILE / QUARTILE.INC / QUARTILE.EXC | ❌ | 0 | 4.10 | |
| CORREL / COVARIANCE.P / COVARIANCE.S | ❌ | 0 | 4.10 | |
| PEARSON / RSQ / SLOPE / INTERCEPT | ❌ | 0 | 4.10 | |
| AVERAGEA / MAXA / MINA | ✅ | 10 | 4.10.C | W5-165: `*A`-variant aggregates. Per Excel canon: Number → as-is; Boolean → 1/0; Text → 0 (including ""); Blank → SKIPPED. Errors propagate. AVERAGEA: empty / all-blank → #DIV/0!. MAXA / MINA: empty / all-blank → 0. DIVERGES from base AVERAGE / MAX / MIN which skip text + bool entirely. |
| FREQUENCY | ❌ | 0 | 4.10 | Array-result; needs 4.7 |
| NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV | ❌ | 0 | 4.10 | |
| T.DIST / T.INV / CHISQ.DIST / CHISQ.INV / F.DIST / F.INV | ❌ | 0 | 4.10 | |
| BINOM.DIST / BINOM.INV / POISSON.DIST / EXPON.DIST | ❌ | 0 | 4.10 | |
| GAMMA / GAMMA.DIST / GAMMA.INV / GAMMALN | ❌ | 0 | 4.10 | |
| BETA.DIST / BETA.INV | ❌ | 0 | 4.10 | |
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
| SIN / COS / TAN / ASIN / ACOS / ATAN / ATAN2 | ✅ | 13 | 4.3 V2 | W5-51; ATAN2 uses Excel `(x, y)` arg order (not Rust's `(y, x)`); ATAN2(0,0)→#DIV/0!; ASIN/ACOS domain `|x|>1`→#NUM!; TAN(π/2) returns huge-finite (Excel canon, not error) |
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
| SUMX2MY2 / SUMX2PY2 / SUMXMY2 | ✅ | 9 | 4.10.D | W5-166: paired array sum-of-squares variants. RangeAwareFn; both args must be ranges; W5-60 strict 2D-shape check (shape mismatch → #VALUE!). Non-numeric cells coerce to 0 (lenient, matches IronCalc canon). Errors in either array propagate. |
| AGGREGATE | ❌ | 0 | 4.10 | Conditional aggregation; depends on 4.7 |
| SUBTOTAL | ❌ | 0 | 4.10 | |

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
| DOLLAR | ⚠️ | 3 | 4.10.E | W5-167: currency text with `$` prefix. ContextAwareFn. Always groups thousands. **V1 DIVERGENCE per W5-171 (Codex LOW-1):** Excel formats negatives with accounting parens (`($1,234.50)`) by default and uses locale-specific currency symbols (€, £, ¥). V1 uses `-$1,234.50` prefix and `$` only. Locale-aware currency symbols + accounting style deferred to a Phase 4.5 polish wave. |
| CHAR / CODE | ✅ | 5 | 4.10.E | W5-167: codepoint round-trip for code 1..=255. **DIVERGENCE**: Excel uses Windows-1252; we use Unicode codepoint mapping. Identical for 1-127 ASCII; positions 128-159 differ (Windows-1252 has extra glyphs; Unicode has C1 control characters). Document divergence; bundle Windows-1252 polish with deferred UTF-16 work. |
| UNICODE / UNICHAR | ✅ | 5 | 4.10.E | W5-167: full Unicode codepoint round-trip. UNICHAR: code 1..=char::MAX; surrogates (0xD800..=0xDFFF) → #N/A. Canonical match vs Excel. |
| REGEX / REGEXMATCH / REGEXEXTRACT / REGEXREPLACE | ❌ | 0 | post-v1 | Google Sheets extension; not in Excel canon |
| LEFTB / RIGHTB / MIDB / LENB / FINDB / SEARCHB | ❌ | 0 | 4.10 | Byte-length variants (DBCS) |
| TEXTBEFORE / TEXTAFTER / TEXTSPLIT | ❌ | 0 | 4.7 | Modern Excel; array-result |

### Date & Time

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| NOW / TODAY | ✅ | 5+ | 3.7 | Approximate Excel-1900 epoch; precise leap-year handling → 4.5 |
| DATE / TIME / DATEVALUE / TIMEVALUE | ❌ | 0 | 4.5 | |
| YEAR / MONTH / DAY / HOUR / MINUTE / SECOND | ❌ | 0 | 4.5 | |
| WEEKDAY / WEEKNUM / ISOWEEKNUM | ❌ | 0 | 4.5 | |
| DAYS / DAYS360 / NETWORKDAYS / NETWORKDAYS.INTL | ❌ | 0 | 4.5 | |
| WORKDAY / WORKDAY.INTL | ❌ | 0 | 4.5 | |
| EDATE / EOMONTH | ❌ | 0 | 4.5 | |
| DATEDIF | ❌ | 0 | 4.5 | Excel-specific; leap-month edge cases |
| YEARFRAC | ❌ | 0 | 4.5 | Multiple day-count bases |

### Lookup & Reference

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| VLOOKUP | ⚠️ | 8 | 4.3 V2 | (see Aggregates/Conditional section for full notes; W5-54 shipped) |
| HLOOKUP | ⚠️ | 2 | 4.3 V2 | (see W5-54 above) |
| LOOKUP | ❌ | 0 | 4.10 | Vector & array forms; less common — defer past V1 wave 1 |
| XLOOKUP | ✅ | 10 | 4.10.G | W5-169: scalar-return V1. Modes: match_mode (0=exact, -1=exact-or-next-smaller, 1=exact-or-next-larger, 2=wildcard); search_mode (1=forward, -1=reverse, ±2=binary). **W5-171 (Codex MEDIUM-3) divergence**: binary modes (`±2`) currently scan linearly — Excel relies on sorted input for `±2`; on unsorted data Excel returns invalid results, we return the same as `±1`. Real binary search deferred. Wildcard + binary (`match_mode=2 search_mode=±2`) rejected with `#VALUE!` (Excel + IronCalc canon). `if_not_found` arg returned on miss (default `#N/A`). lookup_array must be 1D; 2D return_array → `#VALUE!` (spill semantics await Phase 4.7 polish). |
| MATCH | ⚠️ | 7 | 4.3 V2 | W5-54 (see notes above) |
| XMATCH | ✅ | 4 | 4.10.G | W5-169: modern MATCH variant. Returns 1-based position; same match_mode + search_mode semantics as XLOOKUP. No match → `#N/A`. |
| INDEX | ⚠️ | 5 | 4.3 V2 | W5-54 (see notes above) |
| OFFSET | ❌ | 0 | 4.7 | Volatile; whitelisted in 3.2 but not implemented |
| INDIRECT | ❌ | 0 | 4.7 | Volatile; whitelisted in 3.2 but not implemented |
| ADDRESS | ✅ | 8 | 4.10.G | W5-169: cell address text formatter. `abs_num`: 1=$A$1 (default), 2=A$1, 3=$A1, 4=A1. `a1`: TRUE → A1 style (default), FALSE → R1C1. `sheet_text`: optional prefix; auto-quoted if it contains anything other than `[A-Za-z0-9_]`. row/col must be ≥ 1 → otherwise `#VALUE!`. Multi-letter columns supported (Z, AA, ZZ, AAA). |
| ROW / COLUMN / ROWS / COLUMNS | ❌ | 0 | 4.10 | |
| TRANSPOSE | ❌ | 0 | 4.7 | Array-result |
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
| ISFORMULA / ISREF | ❌ | 0 | Wave 3 reference-tier | Need a `Reference { sheet, row, col }` arg tier; bundle with FORMULATEXT / ROW / COLUMN etc. |
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
| XNPV / XIRR | ❌ | 0 | Wave 3 | Date-indexed variants of NPV / IRR; bundle with Wave 3 reference-tier / extended date arithmetic (needs DAYS or YEARFRAC-based discount-period math). |
| PRICE / YIELD / DURATION / MDURATION | ❌ | 0 | post-v1 | Bond math |
| DB / DDB / SLN / SYD / VDB | ❌ | 0 | 4.10 | Depreciation |
| FVSCHEDULE / RRI / PDURATION | ❌ | 0 | post-v1 | |
| ACCRINT / ACCRINTM / COUPDAYS / COUPNCD / COUPPCD | ❌ | 0 | post-v1 | Bond accrual |
| Currency / formatted (locale-specific symbols, accounting style) | ⚠️ | 0 | Phase 4.5 polish wave | DOLLAR shipped W5-167 (4.10.E) with `$` only + `-$X` for negatives; locale-specific currency symbols (€/£/¥) + accounting parens deferred. |

### Engineering (post-v1 unless flagged)

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| BITAND / BITOR / BITXOR / BITLSHIFT / BITRSHIFT | ❌ | 0 | 4.10 | |
| DEC2BIN / BIN2DEC / DEC2HEX / HEX2DEC / DEC2OCT / OCT2DEC | ❌ | 0 | 4.10 | Base conversion |
| COMPLEX / IMABS / IMARGUMENT / IMCONJUGATE | ❌ | 0 | post-v1 | Complex-number math |
| ERF / ERFC / GAMMA / GAMMALN | ❌ | 0 | 4.10 | |
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
