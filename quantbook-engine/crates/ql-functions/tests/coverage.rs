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
