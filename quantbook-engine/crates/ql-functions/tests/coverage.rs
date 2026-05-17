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
    // W5-182 (Phase 4.10 polish / Wave 3 depreciation batch) — DB:
    // fixed-declining-balance. Period-iterating (each period
    // depends on accumulated book value from prior periods).
    // Excel-specific 3-decimal rate rounding. Optional `month`
    // (default 12) controls partial first / last periods.
    (
        "DB",
        "W5-182 + W5-182.1; unit tests pin Microsoft fixtures (DB(1M,100k,6,k,7) for k=1, 2, 6, 7 — period=6 value-pinned in W5-182.1 after Opus HIGH-1) + W5-182.1 audit closures (life<=0, period<1, life>i32::MAX, Boolean month coercion) + validation #NUM! paths",
    ),
    // W5-183 (Phase 4.10 polish / CLOSES Wave 3 depreciation batch)
    // — VDB: variable-declining-balance with DDB-to-SLN crossover.
    // IronCalc has VDB in docs nav only (no Rust impl); algorithm
    // ported directly from Microsoft canon. Tests pin all 6
    // Microsoft documented examples + edge cases.
    (
        "VDB",
        "W5-183 + W5-183.1; unit tests pin all 6 Microsoft fixtures (VDB(2400,300,10×{365,12,1},0,1) = $1.32/$40/$480; VDB(2400,300,120,6,18) = $396.31; factor=1.5 variants $311.81 and $315.00) + 5 LibreOffice/OpenFormula cross-check fixtures from Codex audit (VDB(1000,100,10,5,7) = 117.9648; periods 5..10 default/no_switch divergence; (0.5,1.5) and (2.3,4.7) fractional overlap) + W5-183.1 audit closures (salvage>cost → #NUM!, i32::MAX boundary tightened, no_switch genuinely-changes-result fixture, additivity invariant, negative-factor/-life/start=0 validations)",
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
    // W5-RT-2 (RT-V1-01 Step 2) — reference-tier address-only batch.
    // These functions take RefArg shapes (Reference / Range / Array /
    // Error), NOT scalar Values; the scalar arg-coverage matrix does not
    // apply. Coverage is via per-fn unit tests in `reference_fns.rs`
    // (8+ tests per fn covering anchor / range / whole-column / array
    // literal / error propagation / arity / non-reference) and e2e
    // dispatch tests in ql-exec.
    (
        "ROW",
        "reference-aware fn (W5-RT-2) — covered by reference_fns unit \
         tests (anchor / range / array literal / error propagation / \
         arity / non-reference) + ql-exec reference_fns_e2e (binder→ \
         dispatcher chain) + reference_fns_coverage_extensions (named- \
         range / cross-sheet / formula-cell happy path); structured- \
         ref + implicit-intersection deferred to Step 5 cross-cutting \
         suite. Scalar arg-coverage matrix N/A for reference-tier ABI",
    ),
    (
        "COLUMN",
        "reference-aware fn (W5-RT-2) — covered by reference_fns unit \
         tests + ql-exec reference_fns_e2e + reference_fns_coverage_ \
         extensions (named-range / cross-sheet); structured-ref + \
         implicit-intersection deferred to Step 5; scalar arg-coverage \
         matrix N/A",
    ),
    (
        "ROWS",
        "reference-aware fn (W5-RT-2) — covered by reference_fns unit \
         tests + ql-exec reference_fns_e2e + reference_fns_coverage_ \
         extensions (named-range / cross-sheet); structured-ref + \
         implicit-intersection deferred to Step 5; scalar arg-coverage \
         matrix N/A",
    ),
    (
        "COLUMNS",
        "reference-aware fn (W5-RT-2) — covered by reference_fns unit \
         tests + ql-exec reference_fns_e2e + reference_fns_coverage_ \
         extensions (named-range / cross-sheet); structured-ref + \
         implicit-intersection deferred to Step 5; scalar arg-coverage \
         matrix N/A",
    ),
    // W5-RT-3 (RT-V1-01 Step 3) — reference-tier information batch.
    // ISREF takes ArgContract::LazyShape (no eager-eval of arg);
    // ISFORMULA takes Eager + queries the workbook's ReferenceQuery::
    // is_formula_at. Coverage via per-fn unit tests + ql-exec e2e
    // (binder→materializer chain) + workbook-runtime e2e (ISFORMULA
    // happy path requires real formula-bearing cells). Scalar
    // arg-coverage matrix N/A for the reference-tier ABI.
    (
        "ISREF",
        "reference-aware fn (W5-RT-3) — LazyShape contract; covered by \
         reference_fns unit tests (each PlanKind variant + arity + \
         defensive Eager arms) + ql-exec e2e (binder→lazy-materializer \
         chain confirms NO eval of args); scalar arg-coverage matrix \
         N/A for the reference-tier ABI",
    ),
    (
        "ISFORMULA",
        "reference-aware fn (W5-RT-3) — Eager contract; covered by \
         reference_fns unit tests (NoOpReferenceQuery FALSE path + \
         arity + multi-cell #N/A + non-reference #N/A + error \
         propagation) + ql-exec WorkbookEnv-backed storage-level e2e \
         (formula-vs-literal cell TRUE/FALSE via Workbook::put_formula) \
         + Step 3.1 cell-with-error-value pinning (S3-HIGH-1); scalar \
         arg-coverage matrix N/A",
    ),
    // W5-RT-4 (RT-V1-01 Step 4 — CLOSES the reference-tier mini-phase) —
    // FORMULATEXT. Eager contract + ReferenceQuery::formula_text_at;
    // returns canonical formula text with leading `=` per Excel canon.
    (
        "FORMULATEXT",
        "reference-aware fn (W5-RT-4) — Eager contract; covered by \
         reference_fns unit tests (NoOpReferenceQuery NA path + arity + \
         multi-cell #N/A + non-reference #N/A + error propagation) + \
         ql-exec WorkbookEnv-backed storage-level e2e (formula text \
         with leading `=` via Workbook::put_formula + cross-sheet + \
         named-cell + 1×1 range + cell-with-error-value not-propagated); \
         scalar arg-coverage matrix N/A",
    ),
    // W5-D-1 (Wave 3 distributions batch — normal). NORM.DIST / NORM.S.DIST
    // / NORM.INV / NORM.S.INV. Scalar tier; statrs backing matching
    // IronCalc. Coverage via per-fn unit tests (anchor / LibreOffice
    // cross-check / round-trip / error class / arity); statrs gives
    // ~15 sig fig accuracy out-of-the-box. Scalar arg-coverage matrix
    // N/A — distribution fns aren't symmetric across the matrix's
    // input dimensions.
    (
        "NORM.DIST",
        "distribution fn (W5-D-1) — covered by distribution_fns unit \
         tests (mean=0/sd=1 PDF + CDF anchors, LibreOffice cross-checks, \
         #NUM! for sd <= 0, #VALUE! for text args, error propagation, \
         arity); scalar arg-coverage matrix N/A for statistical \
         distributions",
    ),
    (
        "NORM.S.DIST",
        "distribution fn (W5-D-1) — covered by distribution_fns unit \
         tests (Φ(z) anchors at 0/1/-2/8 LibreOffice cross-checks, PDF + \
         CDF, error class, arity); scalar arg-coverage matrix N/A",
    ),
    (
        "NORM.INV",
        "distribution fn (W5-D-1) — covered by distribution_fns unit \
         tests (CI-upper anchor at 0.975 LibreOffice cross-check, \
         inverse-of-CDF round-trip, #NUM! for prob outside (0,1) or \
         sd <= 0, error propagation, arity); scalar arg-coverage matrix N/A",
    ),
    (
        "NORM.S.INV",
        "distribution fn (W5-D-1) — covered by distribution_fns unit \
         tests (Φ⁻¹(0.5)=0, Φ⁻¹(0.975) LibreOffice anchor, round-trip, \
         #NUM! domain, error class, arity); scalar arg-coverage matrix N/A",
    ),
    // W5-D-2 (Wave 3 distributions batch — Student's t). T.DIST /
    // T.DIST.2T / T.DIST.RT / T.INV / T.INV.2T. Scalar tier;
    // statrs::StudentsT backing. Same coverage shape as W5-D-1: per-fn
    // unit tests + e2e dispatcher round-trip; ≥8 tests per fn (anchor /
    // LibreOffice cross-check / round-trip / domain error / text-arg /
    // error-arg / arity); statrs gives ~15 sig fig accuracy.
    (
        "T.DIST",
        "distribution fn (W5-D-2) — covered by distribution_fns unit \
         tests (CDF=0.5 at symmetry, df=1 closed-form PDF/CDF anchors \
         (1/π, ¾), df-truncation, df<1 #NUM!, large-df→Normal \
         convergence, text-arg #VALUE!, error propagation, arity); \
         scalar arg-coverage matrix N/A for statistical distributions",
    ),
    (
        "T.DIST.2T",
        "distribution fn (W5-D-2) — covered by distribution_fns unit \
         tests (two-tail at zero = 1, df=1 anchor (0.5), negative-x \
         #NUM!, df<1 #NUM!, [0,1]-clamp in far tail, error class, \
         arity); scalar arg-coverage matrix N/A",
    ),
    (
        "T.DIST.RT",
        "distribution fn (W5-D-2) — covered by distribution_fns unit \
         tests (right-tail at zero = 0.5, df=1 anchor (0.25), negative-x \
         allowed (above 0.5), df<1 #NUM!, round-trip with T.DIST sum=1, \
         error class, arity); scalar arg-coverage matrix N/A",
    ),
    (
        "T.INV",
        "distribution fn (W5-D-2) — covered by distribution_fns unit \
         tests (Φ⁻¹(0.5)=0, T.INV(0.975, 10) LibreOffice anchor \
         (2.2281...), round-trip with T.DIST, strict (0,1) domain \
         #NUM!, df<1 #NUM!, error class, arity); scalar arg-coverage \
         matrix N/A",
    ),
    (
        "T.INV.2T",
        "distribution fn (W5-D-2) — covered by distribution_fns unit \
         tests (T.INV.2T(0.05, 30) LibreOffice anchor 2.04227..., \
         round-trip with T.DIST.2T, p=1 boundary case accepted, p>1 \
         #NUM!, returns positive abs value, df<1 #NUM!, error class, \
         arity); scalar arg-coverage matrix N/A",
    ),
    // W5-D-3 (Wave 3 distributions batch — chi-squared + F).
    // CHISQ.DIST / CHISQ.DIST.RT / CHISQ.INV / CHISQ.INV.RT +
    // F.DIST / F.DIST.RT / F.INV / F.INV.RT. Scalar tier;
    // statrs::ChiSquared + statrs::FisherSnedecor backing. Same
    // coverage shape as W5-D-1 / W5-D-2: per-fn unit tests + e2e
    // dispatcher round-trip. ≥10 tests per fn (anchor / LibreOffice
    // cross-check / round-trip / domain error / text-arg / error-arg /
    // arity-under-and-over).
    (
        "CHISQ.DIST",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (CDF=0 at zero, df=2 closed-form PDF/CDF anchors \
         (0.5, 1-e^-1), 5% critical value (df=1, x≈3.84 → 0.95) \
         LibreOffice anchor, negative-x #NUM!, df<1 #NUM!, df>10^10 \
         #NUM! (IronCalc ceiling), text-arg #VALUE!, error \
         propagation, arity-under-and-over); scalar arg-coverage \
         matrix N/A",
    ),
    (
        "CHISQ.DIST.RT",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (P(X>0)=1, df=2 anchor e^-1, 5% critical anchor, \
         round-trip with CHISQ.DIST sum=1, statrs sf() rather than \
         1-cdf() for numerical stability, negative-x #NUM!, df<1 #NUM!, \
         error class, arity); scalar arg-coverage matrix N/A",
    ),
    (
        "CHISQ.INV",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (CHISQ.INV(0,df)=0 — note p=0 ACCEPTED (inclusive domain \
         differs from T.INV/NORM.INV strict), df=2 closed-form 2*ln(2), \
         classic critical 3.84 at p=0.95 df=1 anchor, inverse-of-CDF \
         round-trip, p>1 / p<0 #NUM!, df<1 #NUM!, text/error/arity); \
         scalar arg-coverage matrix N/A",
    ),
    (
        "CHISQ.INV.RT",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (CHISQ.INV.RT(1,df)=0, df=2 anchor 2*ln(2), 5% critical \
         anchor at p=0.05 df=1, round-trip with CHISQ.DIST.RT, p=0 \
         **domain-accepted but observably #NUM!** — the range check \
         admits 0, but `inverse_cdf(1.0 - 0.0) = inverse_cdf(1.0)` is \
         non-finite and the `!result.is_finite()` guard surfaces \
         #NUM!; pinned by `chisq_inv_rt_at_zero_prob_is_num_error` \
         test. p>1/p<0 #NUM!, df<1 #NUM!, text/error/arity); scalar \
         arg-coverage matrix N/A",
    ),
    (
        "F.DIST",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (CDF=0 at zero, F(n,n) CDF=0.5 at x=1 symmetry, F(10,10) \
         pdf(1) closed-form 630/1024 ≈ 0.6152, 95th-percentile (5,10) \
         statrs-internal x≈3.3258 → CDF≈0.95 anchor, negative-x #NUM!, \
         df1<1 OR df2<1 #NUM!, text/error/arity-under-and-over); scalar \
         arg-coverage matrix N/A. **Note**: `df1=2 pdf(0)` is NOT tested \
         — statrs returns 0 (handles 0/0 limit by zeroing) while true \
         math gives 1; out of W5-D-3 scope.",
    ),
    (
        "F.DIST.RT",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (P(F>0)=1, F(n,n) RT=0.5 at x=1, 5% critical anchor, \
         round-trip with F.DIST sum=1, uses 1-cdf() per IronCalc canon \
         (NOT sf()), negative-x #NUM!, df<1 #NUM!, text/error/arity); \
         scalar arg-coverage matrix N/A",
    ),
    (
        "F.INV",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (F.INV(0,df1,df2)=0 — p=0 ACCEPTED (inclusive domain), \
         F.INV(0.5, n, n) = 1 median anchor, classic 95% critical for \
         (5,10)=3.3258 LibreOffice anchor, inverse-of-CDF round-trip, \
         p>1/p<0 #NUM!, df<1 #NUM!, text/error/arity); scalar \
         arg-coverage matrix N/A",
    ),
    (
        "F.INV.RT",
        "distribution fn (W5-D-3) — covered by distribution_fns unit \
         tests (F.INV.RT(1,df1,df2)=0 (upper-inclusive p=1 ACCEPTED), \
         F.INV.RT(0.5, n, n) = 1 median anchor, 5% critical for \
         (5,10)=3.3258, round-trip with F.DIST.RT, p=0 REJECTED \
         (lower-strict — diverges from F.INV/CHISQ.INV/CHISQ.INV.RT \
         which accept p=0 inclusive), p>1 #NUM!, df<1 #NUM!, \
         text/error/arity); scalar arg-coverage matrix N/A",
    ),
    // W5-D-4 (Wave 3 distributions batch — discrete + remaining
    // continuous). BINOM.* / NEGBINOM.* / POISSON.* / EXPON.* /
    // LOGNORM.*. statrs Binomial / NegativeBinomial / Poisson /
    // LogNormal kernels + closed-form EXPON.DIST. First
    // discrete-distribution batch. **W5-D-4.1 (Codex LOW-2 + Opus
    // MEDIUM-O-3 closure):** Per-fn ≥8 tests (design § 7 MEDIUM-δ
    // threshold; actual counts range 8-11 per fn). Closed-form
    // anchors for symmetric / degenerate cases.
    (
        "BINOM.DIST",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (pmf(0)=1/1024 and pmf(5)=252/1024 for n=10 p=0.5 \
         closed-form anchors, CDF(0)=pmf(0), CDF(n)=1, k>n #NUM!, p \
         outside [0,1] #NUM!, negative k #NUM!, text/error/arity-both, \
         degenerate-n=0 regression); scalar arg-coverage matrix N/A. \
         W5-D-4.1 closure of Opus LOW-O-1: dropped pmf(10) claim — \
         test not pinned (would be redundant with pmf(0) by symmetry).",
    ),
    (
        "BINOM.DIST.RANGE",
        "distribution fn (W5-D-4, VARIADIC 3-or-4) — covered by \
         distribution_fns unit tests (full range [0,n]=1, single-point \
         3-arg form = pmf, middle window [4,6]=672/1024, lower==0 \
         short-circuit (avoids cdf(0-1) underflow), reversed range \
         #NUM!, upper>trials #NUM!, text/error/arity); scalar \
         arg-coverage matrix N/A",
    ),
    (
        "BINOM.INV",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (smallest k with CDF(k)>=alpha; for n=10 p=0.5 \
         alpha=0.5 → k=5; tiny-alpha anchor; **p=1 STRICT** (diverges \
         from BINOM.DIST inclusive both ends), p=0 ACCEPTED via \
         inline degenerate-distribution short-circuit (statrs's \
         default inverse_cdf panics on degenerate; documented), \
         alpha strict (0,1), text/error/arity); scalar arg-coverage \
         matrix N/A",
    ),
    (
        "NEGBINOM.DIST",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (pmf(0;r=1,p=0.5)=p^r=0.5, pmf(1;r=1,p=0.5)=(1-p)·p=0.25, \
         CDF(0)=pmf(0)=0.5 closed-form, r<1 #NUM!, p at strict \
         endpoints #NUM!, negative f #NUM!, text/error/arity); scalar \
         arg-coverage matrix N/A",
    ),
    (
        "POISSON.DIST",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (pmf(0;λ=1)=e^-1 closed-form, CDF(1;λ=1)=2e^-1 \
         closed-form, **λ=0 degenerate special case** (statrs rejects; \
         handled inline; P(X=0)=1, P(X>0)=0, CDF=1 for any k≥0), \
         negative x or λ #NUM!, text/error/arity); scalar arg-coverage \
         matrix N/A",
    ),
    (
        "EXPON.DIST",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (closed-form CDF=1-e^(-λx) PDF=λe^(-λx); PDF(0;λ=1)=1, \
         CDF(0)=0, CDF(1;λ=1)=1-e^-1, PDF(1;λ=1)=e^-1, CDF(1;λ=2) \
         anchor, x<0 #NUM!, λ<=0 STRICT #NUM!, text/error/arity); \
         scalar arg-coverage matrix N/A. **No statrs kernel** — pure \
         closed-form math.",
    ),
    (
        "LOGNORM.DIST",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (CDF(1;μ=0,σ=1) = Φ(0) = 0.5 closed-form, PDF(1;μ=0,σ=1) \
         = 1/√(2π) closed-form, negative μ accepted (underlying \
         normal's mean), x≤0 STRICT #NUM!, σ≤0 STRICT #NUM!, \
         text/error/arity); scalar arg-coverage matrix N/A",
    ),
    (
        "LOGNORM.INV",
        "distribution fn (W5-D-4) — covered by distribution_fns unit \
         tests (LOGNORM.INV(0.5,μ,σ) = exp(μ) median closed-form for \
         μ=0 (=1) and μ=5 (=e^5), round-trip with LOGNORM.DIST, \
         p∈(0,1) STRICT both ends, σ≤0 #NUM!, text/error/arity); \
         scalar arg-coverage matrix N/A",
    ),
    // W5-D-5 (Wave 3 distributions batch — CLOSES Wave 3).
    // Gamma family + beta + confidence intervals.
    // statrs::function::gamma::{gamma, ln_gamma} for closed-form Γ
    // and ln(Γ); statrs::Gamma / statrs::Beta for distributions;
    // CONFIDENCE.* reuses W5-D-1/W5-D-2 helpers. Per-fn ≥8 tests.
    (
        "GAMMA",
        "distribution fn (W5-D-5) — covered by distribution_fns unit \
         tests (closed-form Γ(1)=1, Γ(5)=24, Γ(0.5)=√π, Γ(-0.5)=-2√π, \
         negative-integer poles #NUM!, Γ(0)=Inf→#NUM!, text/error/\
         arity); scalar arg-coverage matrix N/A. **Not a distribution** \
         — the gamma function itself via statrs::function::gamma::gamma.",
    ),
    (
        "GAMMA.DIST",
        "distribution fn (W5-D-5) — covered by distribution_fns unit \
         tests (CDF=0 at zero, α=1/β=1 reduces to exponential(1) — \
         CDF(1)=1-e⁻¹ and PDF(0)=1 closed-form, negative x #NUM!, \
         α≤0 OR β≤0 STRICT #NUM!, text/error/arity-both); scalar \
         arg-coverage matrix N/A. Excel shape-scale converted to \
         statrs shape-rate via `rate=1/scale`.",
    ),
    (
        "GAMMA.INV",
        "distribution fn (W5-D-5) — covered by distribution_fns unit \
         tests (GAMMA.INV(0,α,β)=0 inclusive lower, α=1/β=1 inverse \
         exp(1) gives p=0.5 → ln(2), round-trip with GAMMA.DIST, p \
         outside [0,1] #NUM!, α≤0/β≤0 #NUM!, text/error/arity); \
         scalar arg-coverage matrix N/A",
    ),
    (
        "GAMMALN",
        "distribution fn (W5-D-5) — covered by distribution_fns unit \
         tests (closed-form: ln(Γ(1))=0, ln(Γ(2))=0, ln(Γ(4))=ln(6), \
         ln(Γ(0.5))=½·ln(π), negative x #NUM!, x=0 ln(Inf)→#NUM!, \
         text/error/arity); scalar arg-coverage matrix N/A. Uses \
         statrs::function::gamma::ln_gamma.",
    ),
    (
        "GAMMALN.PRECISE",
        "distribution fn (W5-D-5) — **alias of GAMMALN** (Excel 2010 \
         renamed for naming consistency; same numerical impl). \
         Covered by alias-equality tests at x=4 and x=0.5 + \
         independent error-class tests. Coverage shape ≥5 since alias.",
    ),
    (
        "BETA.DIST",
        "distribution fn (W5-D-5, VARIADIC 4-6) — covered by \
         distribution_fns unit tests (Beta(1,1) is U(0,1) — CDF(0.5)=0.5, \
         PDF(0.5)=1 closed-form, optional [A,B] bounds with U(0,10) \
         test PDF=0.1 and CDF=0.5 at x=5, x outside [A,B] #NUM!, \
         A=B #NUM!, α≤0/β≤0 #NUM!, text/error/arity-both); scalar \
         arg-coverage matrix N/A. PDF scaled by 1/(B-A) Jacobian.",
    ),
    (
        "BETA.INV",
        "distribution fn (W5-D-5, VARIADIC 3-5) — covered by \
         distribution_fns unit tests (Beta(1,1)=U(0,1) → inverse(0.5)=0.5, \
         round-trip with BETA.DIST, U(0,10) inverse(0.7)=7, p at \
         endpoints STRICT #NUM!, B≤A #NUM!, α≤0/β≤0 #NUM!, \
         text/error/arity-both); scalar arg-coverage matrix N/A.",
    ),
    (
        "CONFIDENCE.NORM",
        "distribution fn (W5-D-5) — covered by distribution_fns unit \
         tests (z(0.975)≈1.95996 at α=0.05/σ=1/n=1, margin scales \
         linearly with σ, margin scales as 1/√n, size uses .floor() \
         not .trunc(), α at strict endpoints #NUM!, σ≤0 #NUM!, size<1 \
         #NUM!, text/error/arity); scalar arg-coverage matrix N/A. \
         Reuses W5-D-1 standard_normal helper.",
    ),
    (
        "CONFIDENCE.T",
        "distribution fn (W5-D-5) — covered by distribution_fns unit \
         tests (t(0.975, df=9)/√10 statrs-internal anchor 0.71536, \
         size uses .trunc() not .floor() (diverges from \
         CONFIDENCE.NORM), large-n approaches CONFIDENCE.NORM, \
         **size<2 #DIV/0! not #NUM!** (Excel canon — only fn in \
         distribution_fns returning #DIV/0!), α at strict endpoints \
         #NUM!, σ≤0 #NUM!, text/error/arity); scalar arg-coverage \
         matrix N/A. Reuses W5-D-2 students_t_with helper.",
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
