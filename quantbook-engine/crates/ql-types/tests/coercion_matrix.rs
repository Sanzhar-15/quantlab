//! Phase 4.4.B — Type-pair coercion matrix integration tests (W5-65).
//!
//! Pins the §3.1 matrix from `docs/architecture/2026-05-13-coercion-matrix.md`:
//! **9 input cases × 5 contexts.** Each test below maps 1:1 to one cell of
//! that matrix. If the matrix doc changes, these tests need updating in lockstep.
//!
//! ## Input cases
//!
//! 1. `Blank`
//! 2. `Number(n)` finite
//! 3. `Number(NaN)`
//! 4. `Number(±Inf)`
//! 5. `Boolean(true)`
//! 6. `Boolean(false)`
//! 7. `Text(s)` parseable as number
//! 8. `Text(s)` unparseable
//! 9. `Error(e)`
//!
//! ## Contexts
//!
//! 1. `to_number_strict` — function args that reject text
//! 2. `to_number_lenient` — arithmetic operators (text parses if possible)
//! 3. `to_logical` — IF/AND/OR/comparison
//! 4. `to_text_for_display` — UI / criteria-key formation (infallible)
//! 5. `to_text_for_formula` — `&` operator (Error propagates)
//!
//! ## Test name convention
//!
//! - `*_canon_*` — Excel-canon behavior pinned.
//! - `*_v1_divergence_*` — Intentional Quantbook V1 divergence.
//! - `*_w5_64_policy_*` — Behavior set by the W5-64 NaN/Inf policy decision.
//!
//! Integration tests use the public API only.

use ql_types::coercion::{
    to_logical, to_number_lenient, to_number_strict, to_text_for_display, to_text_for_formula,
};
use ql_types::{ErrorValue, Value};

// ============================================================================
// CASE 1: Blank
// ============================================================================

#[test]
fn case_blank_strict_canon_is_zero() {
    assert_eq!(to_number_strict(&Value::Blank).unwrap(), 0.0);
}

#[test]
fn case_blank_lenient_canon_is_zero() {
    assert_eq!(to_number_lenient(&Value::Blank).unwrap(), 0.0);
}

#[test]
fn case_blank_logical_canon_is_false() {
    assert!(!to_logical(&Value::Blank).unwrap());
}

#[test]
fn case_blank_display_canon_is_empty_string() {
    assert_eq!(to_text_for_display(&Value::Blank), "");
}

#[test]
fn case_blank_formula_canon_is_empty_string_ok() {
    assert_eq!(to_text_for_formula(&Value::Blank).unwrap(), "");
}

// ============================================================================
// CASE 2: Number(n) finite
// ============================================================================

#[test]
fn case_number_finite_strict_canon_passthrough() {
    assert_eq!(to_number_strict(&Value::Number(2.5)).unwrap(), 2.5);
    assert_eq!(to_number_strict(&Value::Number(-7.0)).unwrap(), -7.0);
    assert_eq!(to_number_strict(&Value::Number(0.0)).unwrap(), 0.0);
}

#[test]
fn case_number_finite_lenient_canon_passthrough() {
    assert_eq!(to_number_lenient(&Value::Number(2.5)).unwrap(), 2.5);
}

#[test]
fn case_number_finite_logical_canon_nonzero_is_true() {
    assert!(to_logical(&Value::Number(1.0)).unwrap());
    assert!(to_logical(&Value::Number(-1.0)).unwrap());
    assert!(to_logical(&Value::Number(0.5)).unwrap());
    assert!(!to_logical(&Value::Number(0.0)).unwrap());
    assert!(!to_logical(&Value::Number(-0.0)).unwrap());
}

#[test]
fn case_number_finite_display_canon_invariant_rendering() {
    assert_eq!(to_text_for_display(&Value::Number(1.5)), "1.5");
    assert_eq!(to_text_for_display(&Value::Number(0.0)), "0");
    assert_eq!(to_text_for_display(&Value::Number(-2.5)), "-2.5");
}

#[test]
fn case_number_finite_formula_canon_invariant_rendering() {
    assert_eq!(to_text_for_formula(&Value::Number(1.5)).unwrap(), "1.5");
}

// ============================================================================
// CASE 3: Number(NaN) — W5-64 policy (Codex MEDIUM 1)
// ============================================================================

#[test]
fn case_number_nan_strict_canon_is_num_error() {
    assert_eq!(
        to_number_strict(&Value::Number(f64::NAN)).unwrap_err(),
        ErrorValue::Num
    );
}

#[test]
fn case_number_nan_lenient_canon_is_num_error() {
    assert_eq!(
        to_number_lenient(&Value::Number(f64::NAN)).unwrap_err(),
        ErrorValue::Num
    );
}

#[test]
fn case_number_nan_logical_canon_is_num_error() {
    assert_eq!(
        to_logical(&Value::Number(f64::NAN)).unwrap_err(),
        ErrorValue::Num
    );
}

#[test]
fn case_number_nan_display_w5_64_policy_is_num_sigil() {
    // Pre-W5-64 this rendered as the f64 Display "NaN". W5-64 policy
    // (Codex MEDIUM 1) surfaces non-finite numbers as the #NUM! sigil.
    assert_eq!(to_text_for_display(&Value::Number(f64::NAN)), "#NUM!");
}

#[test]
fn case_number_nan_formula_w5_64_policy_is_num_error() {
    assert_eq!(
        to_text_for_formula(&Value::Number(f64::NAN)).unwrap_err(),
        ErrorValue::Num
    );
}

// ============================================================================
// CASE 4: Number(±Inf) — W5-64 policy (Codex MEDIUM 1)
// ============================================================================

#[test]
fn case_number_inf_strict_canon_is_num_error() {
    assert_eq!(
        to_number_strict(&Value::Number(f64::INFINITY)).unwrap_err(),
        ErrorValue::Num
    );
    assert_eq!(
        to_number_strict(&Value::Number(f64::NEG_INFINITY)).unwrap_err(),
        ErrorValue::Num
    );
}

#[test]
fn case_number_inf_lenient_canon_is_num_error() {
    assert_eq!(
        to_number_lenient(&Value::Number(f64::INFINITY)).unwrap_err(),
        ErrorValue::Num
    );
}

#[test]
fn case_number_inf_logical_canon_is_num_error() {
    assert_eq!(
        to_logical(&Value::Number(f64::INFINITY)).unwrap_err(),
        ErrorValue::Num
    );
}

#[test]
fn case_number_inf_display_w5_64_policy_is_num_sigil() {
    assert_eq!(to_text_for_display(&Value::Number(f64::INFINITY)), "#NUM!");
    assert_eq!(
        to_text_for_display(&Value::Number(f64::NEG_INFINITY)),
        "#NUM!"
    );
}

#[test]
fn case_number_inf_formula_w5_64_policy_is_num_error() {
    assert_eq!(
        to_text_for_formula(&Value::Number(f64::INFINITY)).unwrap_err(),
        ErrorValue::Num
    );
}

// ============================================================================
// CASE 5: Boolean(true)
// ============================================================================

#[test]
fn case_bool_true_strict_canon_is_one() {
    assert_eq!(to_number_strict(&Value::Boolean(true)).unwrap(), 1.0);
}

#[test]
fn case_bool_true_lenient_canon_is_one() {
    assert_eq!(to_number_lenient(&Value::Boolean(true)).unwrap(), 1.0);
}

#[test]
fn case_bool_true_logical_canon_passthrough() {
    assert!(to_logical(&Value::Boolean(true)).unwrap());
}

#[test]
fn case_bool_true_display_canon_is_uppercase_true_literal() {
    assert_eq!(to_text_for_display(&Value::Boolean(true)), "TRUE");
}

#[test]
fn case_bool_true_formula_canon_is_uppercase_true_literal() {
    assert_eq!(to_text_for_formula(&Value::Boolean(true)).unwrap(), "TRUE");
}

// ============================================================================
// CASE 6: Boolean(false)
// ============================================================================

#[test]
fn case_bool_false_strict_canon_is_zero() {
    assert_eq!(to_number_strict(&Value::Boolean(false)).unwrap(), 0.0);
}

#[test]
fn case_bool_false_lenient_canon_is_zero() {
    assert_eq!(to_number_lenient(&Value::Boolean(false)).unwrap(), 0.0);
}

#[test]
fn case_bool_false_logical_canon_passthrough() {
    assert!(!to_logical(&Value::Boolean(false)).unwrap());
}

#[test]
fn case_bool_false_display_canon_is_uppercase_false_literal() {
    assert_eq!(to_text_for_display(&Value::Boolean(false)), "FALSE");
}

#[test]
fn case_bool_false_formula_canon_is_uppercase_false_literal() {
    assert_eq!(
        to_text_for_formula(&Value::Boolean(false)).unwrap(),
        "FALSE"
    );
}

// ============================================================================
// CASE 7: Text(s) parseable as number
// ============================================================================

#[test]
fn case_text_parseable_strict_canon_is_value_error() {
    // Strict rejects ALL text, even text that parses as a number.
    assert_eq!(
        to_number_strict(&Value::text("5")).unwrap_err(),
        ErrorValue::Value
    );
    assert_eq!(
        to_number_strict(&Value::text("2.5")).unwrap_err(),
        ErrorValue::Value
    );
}

#[test]
fn case_text_parseable_lenient_canon_parses() {
    assert_eq!(to_number_lenient(&Value::text("5")).unwrap(), 5.0);
    assert_eq!(to_number_lenient(&Value::text("2.5")).unwrap(), 2.5);
    assert_eq!(to_number_lenient(&Value::text("50%")).unwrap(), 0.5);
    assert_eq!(to_number_lenient(&Value::text("-1.5e2")).unwrap(), -150.0);
}

#[test]
fn case_text_parseable_logical_canon_only_true_false_match() {
    // Text parseable as a NUMBER is NOT a logical match.
    assert_eq!(
        to_logical(&Value::text("1")).unwrap_err(),
        ErrorValue::Value
    );
    assert_eq!(
        to_logical(&Value::text("0")).unwrap_err(),
        ErrorValue::Value
    );
    assert_eq!(
        to_logical(&Value::text("2.5")).unwrap_err(),
        ErrorValue::Value
    );
    // Only the literal strings TRUE / FALSE (case-insensitive) match.
    assert!(to_logical(&Value::text("TRUE")).unwrap());
    assert!(!to_logical(&Value::text("FALSE")).unwrap());
}

#[test]
fn case_text_parseable_display_canon_passthrough() {
    assert_eq!(to_text_for_display(&Value::text("5")), "5");
    assert_eq!(to_text_for_display(&Value::text("hello")), "hello");
}

#[test]
fn case_text_parseable_formula_canon_passthrough() {
    assert_eq!(to_text_for_formula(&Value::text("5")).unwrap(), "5");
}

// ============================================================================
// CASE 8: Text(s) unparseable
// ============================================================================

#[test]
fn case_text_unparseable_strict_canon_is_value_error() {
    assert_eq!(
        to_number_strict(&Value::text("abc")).unwrap_err(),
        ErrorValue::Value
    );
}

#[test]
fn case_text_unparseable_lenient_canon_is_value_error() {
    assert_eq!(
        to_number_lenient(&Value::text("abc")).unwrap_err(),
        ErrorValue::Value
    );
    assert_eq!(
        to_number_lenient(&Value::text("")).unwrap_err(),
        ErrorValue::Value
    );
    // Locale-comma rejected at v1 boundary.
    assert_eq!(
        to_number_lenient(&Value::text("1,5")).unwrap_err(),
        ErrorValue::Value
    );
}

#[test]
fn case_text_unparseable_logical_canon_is_value_error() {
    assert_eq!(
        to_logical(&Value::text("yes")).unwrap_err(),
        ErrorValue::Value
    );
}

#[test]
fn case_text_unparseable_display_canon_passthrough() {
    // Display path doesn't care whether text parses; it just renders.
    assert_eq!(to_text_for_display(&Value::text("garbage")), "garbage");
    assert_eq!(to_text_for_display(&Value::text("")), "");
}

#[test]
fn case_text_unparseable_formula_canon_passthrough() {
    assert_eq!(
        to_text_for_formula(&Value::text("garbage")).unwrap(),
        "garbage"
    );
}

// ============================================================================
// CASE 9: Error(e) — propagates uniformly
// ============================================================================

#[test]
fn case_error_strict_canon_propagates_all_variants() {
    for e in ErrorValue::ALL {
        assert_eq!(to_number_strict(&Value::Error(e)).unwrap_err(), e);
    }
}

#[test]
fn case_error_lenient_canon_propagates_all_variants() {
    for e in ErrorValue::ALL {
        assert_eq!(to_number_lenient(&Value::Error(e)).unwrap_err(), e);
    }
}

#[test]
fn case_error_logical_canon_propagates_all_variants() {
    for e in ErrorValue::ALL {
        assert_eq!(to_logical(&Value::Error(e)).unwrap_err(), e);
    }
}

#[test]
fn case_error_display_canon_renders_sigil() {
    assert_eq!(to_text_for_display(&Value::Error(ErrorValue::Ref)), "#REF!");
    assert_eq!(
        to_text_for_display(&Value::Error(ErrorValue::Value)),
        "#VALUE!"
    );
    assert_eq!(to_text_for_display(&Value::Error(ErrorValue::NA)), "#N/A");
    assert_eq!(
        to_text_for_display(&Value::Error(ErrorValue::DivZero)),
        "#DIV/0!"
    );
    assert_eq!(to_text_for_display(&Value::Error(ErrorValue::Num)), "#NUM!");
}

#[test]
fn case_error_formula_canon_propagates_all_variants() {
    // Formula text path propagates Error — Excel canon for the `&` operator.
    for e in ErrorValue::ALL {
        assert_eq!(to_text_for_formula(&Value::Error(e)).unwrap_err(), e);
    }
}

// ============================================================================
// Cross-cutting: error short-circuit precedence (single Value)
// ============================================================================

#[test]
fn cross_cutting_error_short_circuits_in_all_coercion_contexts() {
    // The same Error in the same Value short-circuits identically in
    // strict / lenient / logical / formula-text. Only display renders.
    let inp = Value::Error(ErrorValue::Calc);
    assert_eq!(to_number_strict(&inp).unwrap_err(), ErrorValue::Calc);
    assert_eq!(to_number_lenient(&inp).unwrap_err(), ErrorValue::Calc);
    assert_eq!(to_logical(&inp).unwrap_err(), ErrorValue::Calc);
    assert_eq!(to_text_for_formula(&inp).unwrap_err(), ErrorValue::Calc);
    assert_eq!(to_text_for_display(&inp), "#CALC!");
}
