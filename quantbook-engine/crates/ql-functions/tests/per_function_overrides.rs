//! Phase 4.4.B — Per-function override tests (W5-65).
//!
//! Pins the §3.4 matrix from `docs/architecture/2026-05-13-coercion-matrix.md`.
//! Each test maps 1:1 to one row of that table. These are direct-function-
//! call tests (not E2E through WorkbookRuntime) — the §3.4 matrix is about
//! function-internal coercion choices, not about the binder or dispatcher.
//!
//! ## Test name convention
//!
//! - `*_canon_*` — Excel canon behavior.
//! - `*_v1_divergence_*` — Intentional Quantbook V1 divergence.
//!
//! Tests use the public `default_registry()` to look up functions; we
//! don't import private fn bodies. If a function is renamed or removed
//! from the registry, the test fails loudly.

use ql_functions::{default_registry, FnArg};
use ql_types::{ErrorValue, Value};

fn r(values: Vec<Value>) -> FnArg {
    let cols = values.len();
    FnArg::Range {
        values,
        rows: 1,
        cols,
    }
}

fn r2d(values: Vec<Value>, rows: usize, cols: usize) -> FnArg {
    assert_eq!(rows * cols, values.len(), "shape mismatch in r2d");
    FnArg::Range { values, rows, cols }
}

fn s(v: Value) -> FnArg {
    FnArg::Scalar(v)
}

fn n(x: f64) -> Value {
    Value::Number(x)
}

// ============================================================================
// COUNT — skips errors, blanks, text, bools; counts only Number cells
// ============================================================================

#[test]
fn count_skips_errors_canon() {
    let reg = default_registry();
    let count = reg.lookup("COUNT").expect("COUNT is registered");
    let args = [
        Value::Number(1.0),
        Value::Error(ErrorValue::Ref),
        Value::Number(2.0),
        Value::Error(ErrorValue::NA),
        Value::Number(3.0),
    ];
    // 3 numbers, 2 errors → count = 3 (errors SKIPPED, not propagated).
    assert_eq!(count(&args), Value::Number(3.0));
}

#[test]
fn count_skips_text_and_blanks_canon() {
    let reg = default_registry();
    let count = reg.lookup("COUNT").expect("COUNT is registered");
    let args = [
        Value::Number(1.0),
        Value::text("hello"),
        Value::Blank,
        Value::Number(2.0),
        Value::Boolean(true),
    ];
    // Only the two Number cells count.
    assert_eq!(count(&args), Value::Number(2.0));
}

// ============================================================================
// COUNTA — counts everything non-blank, INCLUDING errors (diverges from COUNT)
// ============================================================================

#[test]
fn counta_counts_errors_canon() {
    let reg = default_registry();
    let counta = reg.lookup("COUNTA").expect("COUNTA is registered");
    let args = [
        Value::Number(1.0),
        Value::Error(ErrorValue::Ref),
        Value::Number(2.0),
        Value::Error(ErrorValue::NA),
    ];
    // Errors ARE counted (this is the explicit COUNT vs COUNTA divergence
    // Codex audit HIGH 3 flagged).
    assert_eq!(counta(&args), Value::Number(4.0));
}

#[test]
fn counta_skips_only_blanks_canon() {
    let reg = default_registry();
    let counta = reg.lookup("COUNTA").expect("COUNTA is registered");
    let args = [
        Value::Number(1.0),
        Value::Blank,
        Value::text("x"),
        Value::Blank,
        Value::Boolean(true),
    ];
    // 1 number + 1 text + 1 bool = 3; blanks skipped.
    assert_eq!(counta(&args), Value::Number(3.0));
}

// ============================================================================
// ISNUMBER / ISTEXT / ISBLANK / ISLOGICAL — introspect; never propagate
// ============================================================================

#[test]
fn isnumber_introspects_never_propagates_canon() {
    let reg = default_registry();
    let isnum = reg.lookup("ISNUMBER").expect("ISNUMBER is registered");
    assert_eq!(isnum(&[Value::Number(1.5)]), Value::Boolean(true));
    assert_eq!(isnum(&[Value::text("5")]), Value::Boolean(false));
    assert_eq!(isnum(&[Value::Boolean(true)]), Value::Boolean(false));
    assert_eq!(isnum(&[Value::Blank]), Value::Boolean(false));
    // Error: predicate returns false (does NOT propagate).
    assert_eq!(
        isnum(&[Value::Error(ErrorValue::Ref)]),
        Value::Boolean(false)
    );
}

#[test]
fn istext_introspects_never_propagates_canon() {
    let reg = default_registry();
    let istext = reg.lookup("ISTEXT").expect("ISTEXT is registered");
    assert_eq!(istext(&[Value::text("hello")]), Value::Boolean(true));
    assert_eq!(istext(&[Value::Number(1.0)]), Value::Boolean(false));
    assert_eq!(istext(&[Value::Blank]), Value::Boolean(false));
    assert_eq!(
        istext(&[Value::Error(ErrorValue::Num)]),
        Value::Boolean(false)
    );
}

#[test]
fn isblank_introspects_never_propagates_canon() {
    let reg = default_registry();
    let isblank = reg.lookup("ISBLANK").expect("ISBLANK is registered");
    assert_eq!(isblank(&[Value::Blank]), Value::Boolean(true));
    assert_eq!(isblank(&[Value::Number(0.0)]), Value::Boolean(false));
    assert_eq!(isblank(&[Value::text("")]), Value::Boolean(false));
    assert_eq!(
        isblank(&[Value::Error(ErrorValue::Calc)]),
        Value::Boolean(false)
    );
}

#[test]
fn islogical_introspects_never_propagates_canon() {
    let reg = default_registry();
    let islogical = reg.lookup("ISLOGICAL").expect("ISLOGICAL is registered");
    assert_eq!(islogical(&[Value::Boolean(true)]), Value::Boolean(true));
    assert_eq!(islogical(&[Value::Boolean(false)]), Value::Boolean(true));
    assert_eq!(islogical(&[Value::Number(1.0)]), Value::Boolean(false));
    assert_eq!(islogical(&[Value::Blank]), Value::Boolean(false));
    assert_eq!(
        islogical(&[Value::Error(ErrorValue::Ref)]),
        Value::Boolean(false)
    );
}

// ============================================================================
// ISERROR / ISNA / ISERR — introspect errors specifically
// ============================================================================

#[test]
fn iserror_true_for_any_error_canon() {
    let reg = default_registry();
    let iserror = reg.lookup("ISERROR").expect("ISERROR is registered");
    for e in ErrorValue::ALL {
        assert_eq!(
            iserror(&[Value::Error(e)]),
            Value::Boolean(true),
            "ISERROR should be true for {e:?}"
        );
    }
    assert_eq!(iserror(&[Value::Number(1.0)]), Value::Boolean(false));
    assert_eq!(iserror(&[Value::Blank]), Value::Boolean(false));
}

#[test]
fn isna_true_only_for_na_canon() {
    let reg = default_registry();
    let isna = reg.lookup("ISNA").expect("ISNA is registered");
    assert_eq!(isna(&[Value::Error(ErrorValue::NA)]), Value::Boolean(true));
    assert_eq!(
        isna(&[Value::Error(ErrorValue::Ref)]),
        Value::Boolean(false)
    );
    assert_eq!(
        isna(&[Value::Error(ErrorValue::Num)]),
        Value::Boolean(false)
    );
    assert_eq!(isna(&[Value::Number(1.0)]), Value::Boolean(false));
}

#[test]
fn iserr_true_for_all_errors_except_na_canon() {
    let reg = default_registry();
    let iserr = reg.lookup("ISERR").expect("ISERR is registered");
    for e in ErrorValue::ALL {
        let expected = e != ErrorValue::NA;
        assert_eq!(
            iserr(&[Value::Error(e)]),
            Value::Boolean(expected),
            "ISERR for {e:?} should be {expected}"
        );
    }
    assert_eq!(iserr(&[Value::Number(1.0)]), Value::Boolean(false));
}

// ============================================================================
// AVERAGE on empty / all-blank → #DIV/0!
// ============================================================================

#[test]
fn average_empty_args_is_div_zero_canon() {
    let reg = default_registry();
    let avg = reg.lookup("AVERAGE").expect("AVERAGE is registered");
    assert_eq!(avg(&[]), Value::Error(ErrorValue::DivZero));
}

#[test]
fn average_all_blank_args_is_div_zero_canon() {
    let reg = default_registry();
    let avg = reg.lookup("AVERAGE").expect("AVERAGE is registered");
    assert_eq!(
        avg(&[Value::Blank, Value::Blank, Value::Blank]),
        Value::Error(ErrorValue::DivZero)
    );
}

// ============================================================================
// MEDIAN / MODE on empty range
// ============================================================================

#[test]
fn median_empty_range_is_num_canon() {
    let reg = default_registry();
    let median = reg.lookup_range_aware("MEDIAN").expect("MEDIAN registered");
    assert_eq!(median(&[r(vec![])]), Value::Error(ErrorValue::Num));
}

#[test]
fn mode_no_repeat_is_na_canon() {
    let reg = default_registry();
    let mode = reg.lookup_range_aware("MODE").expect("MODE registered");
    // All distinct values → no repeat → #N/A.
    assert_eq!(
        mode(&[r(vec![n(1.0), n(2.0), n(3.0)])]),
        Value::Error(ErrorValue::NA)
    );
}

// ============================================================================
// MATCH — not found → #N/A (NOT propagation of an arg error)
// ============================================================================

#[test]
fn match_not_found_is_na_canon() {
    let reg = default_registry();
    let match_fn = reg.lookup_range_aware("MATCH").expect("MATCH registered");
    let hay = r(vec![n(1.0), n(2.0), n(3.0)]);
    // Looking for 99 — not present → #N/A.
    assert_eq!(
        match_fn(&[s(n(99.0)), hay, s(n(0.0))]),
        Value::Error(ErrorValue::NA)
    );
}

// ============================================================================
// VLOOKUP / HLOOKUP — distinct error returns per failure mode
// ============================================================================

#[test]
fn vlookup_col_index_less_than_one_is_value_canon() {
    let reg = default_registry();
    let vlookup = reg.lookup_range_aware("VLOOKUP").expect("VLOOKUP");
    let table = r2d(vec![n(1.0), n(10.0), n(2.0), n(20.0)], 2, 2);
    // col_index = 0 → #VALUE!.
    assert_eq!(
        vlookup(&[s(n(1.0)), table, s(n(0.0))]),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn vlookup_col_index_greater_than_cols_is_ref_canon() {
    let reg = default_registry();
    let vlookup = reg.lookup_range_aware("VLOOKUP").expect("VLOOKUP");
    let table = r2d(vec![n(1.0), n(10.0), n(2.0), n(20.0)], 2, 2);
    // col_index = 5 (only 2 cols) → #REF!.
    assert_eq!(
        vlookup(&[s(n(1.0)), table, s(n(5.0))]),
        Value::Error(ErrorValue::Ref)
    );
}

#[test]
fn vlookup_not_found_is_na_canon() {
    let reg = default_registry();
    let vlookup = reg.lookup_range_aware("VLOOKUP").expect("VLOOKUP");
    let table = r2d(vec![n(1.0), n(10.0), n(2.0), n(20.0)], 2, 2);
    // Looking for 99 with exact-match → #N/A.
    assert_eq!(
        vlookup(&[s(n(99.0)), table, s(n(2.0)), s(Value::Boolean(false))]),
        Value::Error(ErrorValue::NA)
    );
}

// ============================================================================
// RANK / RANK.AVG — value not in ref → #N/A
// ============================================================================

#[test]
fn rank_value_not_in_ref_is_na_canon() {
    let reg = default_registry();
    let rank = reg.lookup_range_aware("RANK").expect("RANK");
    let arr = r(vec![n(10.0), n(20.0), n(30.0)]);
    assert_eq!(rank(&[s(n(99.0)), arr]), Value::Error(ErrorValue::NA));
}

#[test]
fn rank_avg_value_not_in_ref_is_na_canon() {
    let reg = default_registry();
    let rank_avg = reg.lookup_range_aware("RANK.AVG").expect("RANK.AVG");
    let arr = r(vec![n(10.0), n(20.0), n(30.0)]);
    assert_eq!(rank_avg(&[s(n(99.0)), arr]), Value::Error(ErrorValue::NA));
}

// ============================================================================
// LARGE / SMALL — k out of bounds → #NUM!
// ============================================================================

#[test]
fn large_k_too_large_is_num_canon() {
    let reg = default_registry();
    let large = reg.lookup_range_aware("LARGE").expect("LARGE");
    let arr = r(vec![n(1.0), n(2.0), n(3.0)]);
    assert_eq!(large(&[arr, s(n(99.0))]), Value::Error(ErrorValue::Num));
}

#[test]
fn small_k_less_than_one_is_num_canon() {
    let reg = default_registry();
    let small = reg.lookup_range_aware("SMALL").expect("SMALL");
    let arr = r(vec![n(1.0), n(2.0), n(3.0)]);
    assert_eq!(small(&[arr, s(n(0.0))]), Value::Error(ErrorValue::Num));
}

// ============================================================================
// LARGE / SMALL / MEDIAN with text in range → #VALUE! (V1 strict divergence)
// ============================================================================

#[test]
fn large_text_in_range_v1_divergence_value_error() {
    // V1-DIV: Excel skips text cells in stats functions over ranges;
    // Quantbook V1 surfaces #VALUE! to make type confusion visible.
    let reg = default_registry();
    let large = reg.lookup_range_aware("LARGE").expect("LARGE");
    let arr = r(vec![n(1.0), Value::text("oops"), n(3.0)]);
    assert_eq!(large(&[arr, s(n(1.0))]), Value::Error(ErrorValue::Value));
}

#[test]
fn median_text_in_range_v1_divergence_value_error() {
    let reg = default_registry();
    let median = reg.lookup_range_aware("MEDIAN").expect("MEDIAN");
    let arr = r(vec![n(1.0), Value::text("oops"), n(3.0)]);
    assert_eq!(median(&[arr]), Value::Error(ErrorValue::Value));
}
