//! Phase 4.4.B — Registry coverage check (W5-65).
//!
//! **Codex MEDIUM 4 fix:** the original `FunctionRegistry::names()` exposes
//! only the scalar `fns` table. Without an explicit guardrail, range-aware
//! functions (MATCH, VLOOKUP, COUNTIF, RANK, CONCAT, ...) can land in the
//! registry without anyone noticing they lack matrix-test coverage.
//!
//! This test enumerates BOTH tables via the new `names_all()` API and
//! asserts every registered name is either:
//! 1. Listed in the expected-coverage set below, OR
//! 2. Explicitly marked as "no matrix coverage required" with a reason.
//!
//! When a new function lands, this test FAILS until the author either:
//! - Adds a matrix-test entry in `per_function_overrides.rs` (or another
//!   matrix file) AND adds the name to `EXPECTED_COVERED` below, OR
//! - Adds the name to `EXPLICITLY_DEFERRED` with a phase-target reason.

use ql_functions::default_registry;

/// Functions that have at least one matrix-test entry pinning their
/// coercion / error / override behavior.
///
/// Kept alphabetically for diff-friendly maintenance. When you add a new
/// matrix test, add the function name here. The list is the source of
/// truth for "what's matrix-covered" — `per_function_overrides.rs` and
/// `coercion_matrix.rs` are the actual tests.
const EXPECTED_COVERED: &[&str] = &[
    // Aggregates / stats (via type-pair matrix in ql-types + per-fn overrides)
    "AVERAGE",
    "COUNT",
    "COUNTA",
    "LARGE",
    "MEDIAN",
    "MODE",
    "RANK",
    "RANK.AVG",
    "SMALL",
    "SUM",
    // Information predicates
    "ISBLANK",
    "ISERR",
    "ISERROR",
    "ISLOGICAL",
    "ISNA",
    "ISNUMBER",
    "ISTEXT",
    // Lookup family — W5-67 added HLOOKUP + CHOOSE (Sonnet mega-audit S1,
    // Codex HIGH 2: previously claimed transitively-covered but no real
    // test existed; now each path is explicitly pinned).
    "CHOOSE",
    "HLOOKUP",
    "MATCH",
    "VLOOKUP",
    // Math divergence — W5-67 added ROUNDUP binary-float divergence test
    // (Sonnet mega-audit MEDIUM-S5: divergence was doc-only, could regress
    // silently).
    "ROUNDUP",
    "ROUNDDOWN",
];

/// Functions that intentionally lack matrix coverage today, with a stated
/// reason. Each entry must reference either a known-gaps entry or a future
/// phase. The matrix-coverage check is allowed to skip these, but the
/// reason must remain accurate.
const EXPLICITLY_DEFERRED: &[(&str, &str)] = &[
    // -- Phase 4.4.B follow-on: these are covered by ql-types type-pair
    // matrix (which exercises all 5 contexts × 9 input cases against the
    // central coercion module), so per-fn overrides aren't strictly needed
    // for SUMs/MINs/MAXs that have no overrides beyond defaults. They land
    // in EXPECTED_COVERED in Phase 4.4.C if/when behavior diverges from
    // default.
    ("AVG", "alias of AVERAGE; covered transitively"),
    (
        "MIN",
        "no override beyond default empty-range → 0; deferred to 4.4.C",
    ),
    (
        "MAX",
        "no override beyond default empty-range → 0; deferred to 4.4.C",
    ),
    (
        "PRODUCT",
        "no override beyond default error/blank handling; deferred",
    ),
    ("VAR", "Welford-backed; covered by NIST numacc tests"),
    ("VAR.S", "Welford-backed; covered by NIST numacc tests"),
    ("VAR.P", "Welford-backed; covered by NIST numacc tests"),
    ("STDEV", "Welford-backed; covered by NIST numacc tests"),
    ("STDEV.S", "Welford-backed; covered by NIST numacc tests"),
    ("STDEV.P", "Welford-backed; covered by NIST numacc tests"),
    // Logical
    (
        "IF",
        "lazy eval gap GAP-F-02 / FN4-03; covered by error_precedence",
    ),
    ("IFERROR", "covered by error_precedence E2E"),
    (
        "AND",
        "deferred — Phase 4.4.C will add logical override tests",
    ),
    (
        "OR",
        "deferred — Phase 4.4.C will add logical override tests",
    ),
    (
        "NOT",
        "deferred — Phase 4.4.C will add logical override tests",
    ),
    // W5-163 (Phase 4.10.A) — logical fillins. Unit tests in
    // scalar_fns::tests pin each function's contract; per-fn matrix
    // overrides deferred to a future Phase 4.4.C / 4.10 polish wave.
    (
        "IFS",
        "W5-163; unit tests pin contract; matrix overrides deferred",
    ),
    (
        "IFNA",
        "W5-163; unit tests pin contract; matrix overrides deferred",
    ),
    (
        "XOR",
        "W5-163; unit tests pin contract; matrix overrides deferred",
    ),
    (
        "SWITCH",
        "W5-163; unit tests pin type-strictness + caseK error propagation; matrix overrides deferred",
    ),
    // W5-165 (Phase 4.10.C) — *A variants + info scalars.
    (
        "AVERAGEA",
        "W5-165; unit tests pin text→0 + bool→1/0 + skip-blanks; matrix overrides deferred",
    ),
    (
        "MAXA",
        "W5-165; unit tests pin text→0 + empty→0; matrix overrides deferred",
    ),
    (
        "MINA",
        "W5-165; unit tests pin text→0 + empty→0; matrix overrides deferred",
    ),
    (
        "NA",
        "W5-165; trivial — returns #N/A; unit tests pin arity",
    ),
    (
        "ERROR.TYPE",
        "W5-165; unit tests pin all 7 canonical error codes + non-error → #N/A",
    ),
    (
        "TYPE",
        "W5-165; unit tests pin Number=1, Text=2, Boolean=4, Error=16",
    ),
    (
        "ISEVEN",
        "W5-165; unit tests pin truncate-toward-zero parity",
    ),
    (
        "ISODD",
        "W5-165; unit tests pin truncate-toward-zero parity",
    ),
    (
        "ISNONTEXT",
        "W5-165; unit tests pin inverse-of-ISTEXT contract",
    ),
    (
        "N",
        "W5-165; unit tests pin Excel canon (text→0 NOT #VALUE!)",
    ),
    // W5-166 (Phase 4.10.D) — combinatorics + sum-of-squares variants.
    (
        "FACT",
        "W5-166; unit tests pin truncate-toward-zero + n>170 → #NUM!",
    ),
    (
        "FACTDOUBLE",
        "W5-166; unit tests pin FACTDOUBLE(-1)=1 special case + n<-1 → #NUM!",
    ),
    (
        "COMBIN",
        "W5-166; unit tests pin C(n,k) + k>n → #NUM!",
    ),
    (
        "COMBINA",
        "W5-166; unit tests pin C(n+k-1,k) + n=0,k>0 → #NUM!",
    ),
    (
        "PERMUT",
        "W5-166; unit tests pin P(n,k) + k>n → #NUM!",
    ),
    (
        "PERMUTATIONA",
        "W5-166; unit tests pin n^k (incl. 0^0=1, 0^k=0)",
    ),
    (
        "SUMSQ",
        "W5-166; unit tests pin sum-of-squares + blank-skip + error propagation",
    ),
    (
        "SUMX2MY2",
        "W5-166; unit tests pin Σ(x²-y²) + shape validation + non-numeric → 0",
    ),
    (
        "SUMX2PY2",
        "W5-166; unit tests pin Σ(x²+y²) + shape validation",
    ),
    (
        "SUMXMY2",
        "W5-166; unit tests pin Σ(x-y)² + zero-diff",
    ),
    // W5-167 (Phase 4.10.E) — text utility fillins.
    (
        "CHAR",
        "W5-167; unit tests pin code 1..=255 + Unicode codepoint mapping (Windows-1252 128-159 divergence documented in matrix)",
    ),
    (
        "CODE",
        "W5-167; unit tests pin first-char codepoint + empty-string → #VALUE!",
    ),
    (
        "UNICODE",
        "W5-167; unit tests pin first-char Unicode codepoint (canonical match vs Excel)",
    ),
    (
        "UNICHAR",
        "W5-167; unit tests pin code 1..=char::MAX + surrogate handling",
    ),
    (
        "VALUE",
        "W5-167; unit tests pin locale-aware decimal parsing + strict reject of wrong-locale `.`",
    ),
    (
        "FIXED",
        "W5-167; unit tests pin locale-aware thousands grouping + half-away rounding + negative decimals",
    ),
    (
        "DOLLAR",
        "W5-167 + W5-175; unit tests pin per-locale currency symbol (EnUs `$` prefix; De/Fr `€` suffix), accounting parens for EnUs negatives, leading minus for De/Fr negatives, locale-aware separators",
    ),
    (
        "TEXTJOIN",
        "W5-167; unit tests pin delimiter join + ignore_empty + range flatten + Excel 32,767 cap",
    ),
    // W5-173 (Phase 4.10 polish, NUMBERVALUE) — closes a deferred Wave 2
    // entry. Unit tests pin Microsoft canon: locale-default separators,
    // explicit-separator override, decimal == group → #VALUE!, multi-decimal
    // → #VALUE!, group-after-decimal → #VALUE!, trailing `%` divides by 100,
    // empty / whitespace text → 0 (NOT #VALUE!), internal space + NBSP
    // ignored, leading sign at position 0 only.
    (
        "NUMBERVALUE",
        "W5-173; unit tests pin Microsoft NUMBERVALUE canon (separator override + percent suffix + empty-text-is-zero)",
    ),
    // W5-174 (Phase 4.10 polish, MIRR) — closes second Wave 2 deferred
    // entry. Unit tests pin Microsoft Excel canonical example (≈12.61%),
    // sign-coverage guard (no-positive / no-negative → #DIV/0!), arity,
    // scalar/range arg validation, text+bool skip per IRR/NPV canon,
    // error propagation, finance_rate < -1 → #NUM!, and both
    // rate==-1 special-case branches (IronCalc-ported cancellation).
    (
        "MIRR",
        "W5-174; unit tests pin Excel MIRR canon (closed-form + sign-coverage + rate-edge cancellations)",
    ),
    // W5-177 (Phase 4.10 polish / Wave 3 starter, CORREL) — Pearson
    // correlation coefficient ported from IronCalc `fn_correl`. Unit
    // tests pin perfect-positive / perfect-negative / zero-correlation
    // baseline cases + non-numeric pair skip + constant-array →
    // #DIV/0! + sign-coverage + shape-mismatch + error propagation.
    (
        "CORREL",
        "W5-177; unit tests pin Pearson coefficient against known fixtures + skip-non-numeric-pair + constant-array → #DIV/0!",
    ),
    // W5-178 (Phase 4.10 polish / Wave 3 regression batch) — SLOPE +
    // INTERCEPT ported from IronCalc `fn_slope` / `fn_intercept`.
    // Share `LinearFitSums` + `compute_slope` (intercept needs slope
    // first). Unit tests pin known-fixture slope/intercept against
    // hand-computed values, sign-coverage, constant-x → #DIV/0!,
    // shape mismatch, error propagation, skip-non-numeric per
    // CORREL's IronCalc-canon rule.
    (
        "SLOPE",
        "W5-178; unit tests pin known-fixture slope (m=2 on y=2x baseline + manual y=ax+b case) + skip-non-numeric-pair + constant-x → #DIV/0!",
    ),
    (
        "INTERCEPT",
        "W5-178; unit tests pin known-fixture intercept (b=0 on y=2x + manual y=ax+b) + slope-failure inheritance",
    ),
    // W5-179 (Phase 4.10 polish / Wave 3 regression batch closure) —
    // PEARSON + RSQ + STEYX. PEARSON is a thin wrapper over
    // `correl(args)` (Microsoft + IronCalc both confirm they share
    // formula). RSQ multiplies CORREL by itself. STEYX is the only
    // real new work — two-pass over pairs to compute residuals.
    (
        "PEARSON",
        "W5-179; unit tests pin PEARSON==CORREL contract + delegation invariant on known fixtures",
    ),
    (
        "RSQ",
        "W5-179; unit tests pin R² = CORREL² invariant on perfect/known fixtures + same #DIV/0! paths",
    ),
    (
        "STEYX",
        "W5-179; unit tests pin known-fixture sey (zero on perfect-line + manual scatter case) + n>=3 requirement",
    ),
    // W5-180 (Phase 4.10 polish / Wave 3 depreciation batch starter) —
    // SLN + SYD: closed-form straight-line + sum-of-years digits
    // depreciation. Scalar; both ported from IronCalc `fn_sln` /
    // `fn_syd`. Asymmetric degenerate-case canon: SLN(life=0) →
    // #DIV/0!; SYD(life=0) → #NUM!. Pinned by tests.
    (
        "SLN",
        "W5-180; unit tests pin (cost-salvage)/life formula + life=0 → #DIV/0! + Microsoft example fixture",
    ),
    (
        "SYD",
        "W5-180; unit tests pin (cost-salvage)·(life-per+1)·2/(life·(life+1)) + per>life / per<=0 / life=0 → #NUM! + Microsoft example fixture (SYD(30k,7.5k,10,1)≈4090.91)",
    ),
    // W5-181 (Phase 4.10 polish / Wave 3 depreciation batch) — DDB:
    // double-declining-balance. Closed-form with salvage floor.
    // Optional `factor` (default 2). Validation rejects period>life
    // / period<=0 / cost<0 / salvage<0 / factor<=0 with #NUM!.
    (
        "DDB",
        "W5-181; unit tests pin Microsoft fixtures (DDB(2400,300,10,1)=480; DDB(2400,300,10,10)≈22.12) + salvage floor + rate-clamp-to-1 + validation #NUM! paths",
    ),
    // W5-168 (Phase 4.10.F) — financial TVM + cash-flow.
    (
        "PMT",
        "W5-168; unit tests pin TVM equation against IronCalc reference",
    ),
    (
        "FV",
        "W5-168; unit tests pin future-value formula + zero-rate edge",
    ),
    (
        "PV",
        "W5-168; unit tests pin present-value formula + inverse-of-PMT check",
    ),
    (
        "NPER",
        "W5-168; unit tests pin period count + zero-rate edge",
    ),
    (
        "RATE",
        "W5-168; unit tests pin Newton-Raphson convergence on known rate",
    ),
    (
        "IPMT",
        "W5-168; unit tests pin first-period interest + IPMT+PPMT=PMT invariant",
    ),
    (
        "PPMT",
        "W5-168; unit tests pin via IPMT+PPMT=PMT invariant",
    ),
    (
        "NPV",
        "W5-168; unit tests pin discount formula + skip-non-numeric + error propagation",
    ),
    (
        "IRR",
        "W5-168; unit tests pin Newton-Raphson + bisection fallback + sign-change requirement",
    ),
    // W5-169 (Phase 4.10.G) — modern lookups + ADDRESS.
    (
        "XLOOKUP",
        "W5-169 + W5-176; unit tests pin 4 match modes + 4 search modes (linear ±1 + real binary ±2) + ascending/descending bisection + unsorted-input divergence + if_not_found + 1D shape requirement",
    ),
    (
        "XMATCH",
        "W5-169 + W5-176; unit tests pin position return + match/search modes incl. binary ±2 (shared `xlookup_find_index` dispatch)",
    ),
    (
        "ADDRESS",
        "W5-169; unit tests pin all 4 abs_num modes + A1/R1C1 styles + sheet quoting + col-letter conversion",
    ),
    // Math (default coercion paths cover most; per-fn overrides deferred)
    ("ABS", "default; deferred"),
    ("SQRT", "domain error #NUM!; deferred"),
    ("ROUND", "default; deferred"),
    // (ROUNDUP / ROUNDDOWN moved to EXPECTED_COVERED in W5-67 — now have
    // explicit binary-float divergence tests.)
    ("INT", "default; deferred"),
    ("TRUNC", "default; deferred"),
    ("MOD", "div-zero handling; deferred"),
    ("POWER", "domain errors; deferred"),
    ("SIGN", "default; deferred"),
    ("EXP", "domain errors; deferred"),
    ("LN", "domain errors; deferred"),
    ("LOG", "domain errors; deferred"),
    ("LOG10", "domain errors; deferred"),
    ("PI", "no args; deferred"),
    ("DEGREES", "default; deferred"),
    ("RADIANS", "default; deferred"),
    // Trig
    ("SIN", "default; deferred"),
    ("COS", "default; deferred"),
    ("TAN", "huge-finite at π/2 documented in matrix"),
    ("ASIN", "domain error documented in matrix"),
    ("ACOS", "domain error documented in matrix"),
    ("ATAN", "default; deferred"),
    ("ATAN2", "0,0 → #DIV/0! documented in matrix"),
    ("SINH", "default; deferred"),
    ("COSH", "default; deferred"),
    ("TANH", "default; deferred"),
    ("ASINH", "default; deferred"),
    ("ACOSH", "domain error documented in matrix"),
    ("ATANH", "domain error documented in matrix"),
    // Math completion
    ("CEILING", "sign-rule documented in matrix"),
    ("FLOOR", "sign-rule documented in matrix"),
    ("CEILING.MATH", "W5-61 polish; documented in matrix"),
    ("FLOOR.MATH", "W5-61 polish; documented in matrix"),
    ("MROUND", "W5-60 nonzero-multiple-zero fix in matrix"),
    ("ODD", "default; deferred"),
    ("EVEN", "default; deferred"),
    ("QUOTIENT", "div-zero documented in matrix"),
    ("GCD", "integer-domain documented in matrix"),
    ("LCM", "integer-domain documented in matrix"),
    // Text wave 2
    ("LEN", "UTF-8 divergence documented in matrix"),
    ("UPPER", "Unicode divergence documented in matrix"),
    ("LOWER", "Unicode divergence documented in matrix"),
    ("TRIM", "default; deferred"),
    ("LEFT", "documented in matrix"),
    ("RIGHT", "documented in matrix"),
    ("MID", "documented in matrix"),
    ("FIND", "case-SENSITIVE; documented in matrix"),
    ("SEARCH", "W5-61 wildcards; documented in matrix"),
    ("SUBSTITUTE", "default; deferred"),
    ("REPLACE", "default; deferred"),
    (
        "CONCATENATE",
        "documented in matrix; CONCAT is range-aware variant",
    ),
    ("REPT", "32K cap documented in matrix"),
    ("EXACT", "default; deferred"),
    ("PROPER", "W5-61 polish; documented in matrix"),
    ("CLEAN", "W5-61 polish; documented in matrix"),
    // Volatile
    (
        "NOW",
        "non-deterministic; covered by volatile dedicated tests",
    ),
    (
        "TODAY",
        "non-deterministic; covered by volatile dedicated tests",
    ),
    (
        "RAND",
        "non-deterministic; deterministic-RNG-seed test exists",
    ),
    (
        "RANDBETWEEN",
        "non-deterministic; covered by volatile dedicated tests",
    ),
    // Phase 4.5.B wave 1 date/time fns (W5-72) — covered by
    // `date_fns::tests` module (31 unit tests pinning Excel-canon
    // edge cases including 1900-phantom day, month/day cascade,
    // negative-arg #NUM!, etc). Deferred from per_function_overrides
    // since the module-internal tests already do the coverage.
    ("DATE", "W5-72; covered by date_fns::tests"),
    ("YEAR", "W5-72; covered by date_fns::tests"),
    ("MONTH", "W5-72; covered by date_fns::tests"),
    ("DAY", "W5-72; covered by date_fns::tests"),
    ("HOUR", "W5-72; covered by date_fns::tests"),
    ("MINUTE", "W5-72; covered by date_fns::tests"),
    ("SECOND", "W5-72; covered by date_fns::tests"),
    ("TIME", "W5-72; covered by date_fns::tests"),
    ("DATEVALUE", "W5-73; covered by date_fns::tests_wave2"),
    ("TIMEVALUE", "W5-73; covered by date_fns::tests_wave2"),
    ("WEEKDAY", "W5-73; covered by date_fns::tests_wave2"),
    ("EOMONTH", "W5-73; covered by date_fns::tests_wave2"),
    ("EDATE", "W5-73; covered by date_fns::tests_wave2"),
    ("DAYS", "W5-74; covered by date_fns::tests_wave3"),
    (
        "NETWORKDAYS",
        "W5-74; V1 no-holidays — GAP-F-09 pinned by tests_wave3",
    ),
    (
        "WORKDAY",
        "W5-74; V1 no-holidays — GAP-F-10 pinned by tests_wave3",
    ),
    (
        "YEARFRAC",
        "W5-74; V1 simplified 30/360 — GAP-F-11 pinned by tests_wave3",
    ),
    ("DATEDIF", "W5-75 V2; covered by date_fns::tests_wave_c"),
    ("DAYS360", "W5-75 V2; covered by date_fns::tests_wave_c"),
    ("WEEKNUM", "W5-75 V2; covered by date_fns::tests_wave_c"),
    ("ISOWEEKNUM", "W5-75 V2; covered by date_fns::tests_wave_c"),
    // Phase 4.5.E — TEXT() formatter
    (
        "TEXT",
        "W5-83 Phase 4.5.E; covered by format::text_fn::tests + workbook_runtime end-to-end tests",
    ),
    // Range-aware
    ("SUMIF", "wildcards + V1 anchoring divergence in matrix"),
    ("COUNTIF", "wildcards covered in matrix"),
    ("SUMIFS", "2D shape validation pinned in W5-60"),
    ("COUNTIFS", "2D shape validation pinned in W5-60"),
    ("AVERAGEIF", "V1 anchoring divergence in matrix"),
    ("AVERAGEIFS", "2D shape validation pinned in W5-60"),
    ("SUMPRODUCT", "2D shape validation pinned in W5-60"),
    // W5-164 (Phase 4.10.B) — conditional-aggregate fillins. Unit
    // tests pin no-match → 0 (MINIFS/MAXIFS) and blank/empty-string
    // detection (COUNTBLANK); matrix overrides deferred.
    (
        "MINIFS",
        "W5-164; unit tests pin no-match → 0 + shape validation; matrix overrides deferred",
    ),
    (
        "MAXIFS",
        "W5-164; unit tests pin no-match → 0 + error propagation; matrix overrides deferred",
    ),
    (
        "COUNTBLANK",
        "W5-164; unit tests pin Blank + empty-string detection; matrix overrides deferred",
    ),
    // (HLOOKIP moved to EXPECTED_COVERED in W5-67 — Sonnet mega-audit S1
    // flagged that the prior "transitively covered by VLOOKUP" reason was
    // false; HLOOKUP is a separate function body, not an alias.)
    ("INDEX", "documented in matrix; array spill deferred to 4.7"),
    // (CHOOSE moved to EXPECTED_COVERED in W5-67 — Codex mega-audit HIGH 2
    // flagged that the "range-arg gotcha pinned" claim was about an older
    // module unit test, not the W5-65 matrix substrate. Now has explicit
    // matrix tests for each path.)
    (
        "RANK.EQ",
        "alias of RANK; covered by per_function_overrides via RANK",
    ),
    (
        "MODE.SNGL",
        "alias of MODE; covered by per_function_overrides via MODE",
    ),
    ("CONCAT", "W5-61 polish; 32K cap pinned"),
    // AI / future
    ("AI", "sentinel returns #AI_NOT_AVAILABLE_V1; phase 6.6"),
    // Phase 4.7.M (W5-106): first array-returning function via the
    // Unified ABI. Coverage matrix doesn't apply (arg-coverage is per-arg
    // numeric; the array-return shape is exercised end-to-end in
    // ql-exec set_formula + eval_at_cell_boundary tests).
    (
        "SEQUENCE",
        "array-returning fn — covered by ql-exec spill tests, not the \
         scalar arg-coverage matrix",
    ),
    (
        "TRANSPOSE",
        "array-returning fn (W5-107) — covered by ql-exec spill tests + \
         array_returning_fns unit tests, not the scalar arg-coverage \
         matrix",
    ),
    (
        "FILTER",
        "array-returning fn (W5-107) — covered by ql-exec spill tests + \
         array_returning_fns unit tests, not the scalar arg-coverage \
         matrix",
    ),
];

#[test]
fn every_registered_function_has_a_coverage_decision() {
    let reg = default_registry();
    let mut missing: Vec<String> = Vec::new();

    let deferred_names: std::collections::HashSet<&str> =
        EXPLICITLY_DEFERRED.iter().map(|(name, _)| *name).collect();
    let covered_names: std::collections::HashSet<&str> = EXPECTED_COVERED.iter().copied().collect();

    for name in reg.names_all() {
        if covered_names.contains(*name) {
            continue;
        }
        if deferred_names.contains(*name) {
            continue;
        }
        missing.push((*name).to_string());
    }

    missing.sort();
    assert!(
        missing.is_empty(),
        "Phase 4.4.B coverage gap — these registered functions have no \
         matrix coverage decision (add to EXPECTED_COVERED or \
         EXPLICITLY_DEFERRED in `crates/ql-functions/tests/coverage.rs`): \
         {missing:?}"
    );
}

#[test]
fn no_stale_coverage_entries_for_unregistered_functions() {
    // The flipside: if EXPECTED_COVERED or EXPLICITLY_DEFERRED names a
    // function that's no longer registered (deleted, renamed), surface it.
    let reg = default_registry();
    let all_names: std::collections::HashSet<String> =
        reg.names_all().map(|s| (*s).to_string()).collect();

    let mut stale: Vec<&str> = Vec::new();
    for name in EXPECTED_COVERED {
        if !all_names.contains(*name) {
            stale.push(name);
        }
    }
    for (name, _reason) in EXPLICITLY_DEFERRED {
        if !all_names.contains(*name) {
            stale.push(name);
        }
    }
    stale.sort();
    assert!(
        stale.is_empty(),
        "Coverage list references unregistered function names: {stale:?}"
    );
}

#[test]
fn coverage_lists_are_disjoint() {
    // A function should not appear in BOTH EXPECTED_COVERED and
    // EXPLICITLY_DEFERRED — that would mask intent.
    let covered: std::collections::HashSet<&str> = EXPECTED_COVERED.iter().copied().collect();
    let mut overlap: Vec<&str> = Vec::new();
    for (name, _) in EXPLICITLY_DEFERRED {
        if covered.contains(*name) {
            overlap.push(name);
        }
    }
    overlap.sort();
    assert!(
        overlap.is_empty(),
        "Functions appear in BOTH coverage lists: {overlap:?}"
    );
}
