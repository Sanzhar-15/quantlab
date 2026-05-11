//! Excel coercion rules — the boundary between heterogeneous `Value` and a typed Rust scalar
//! (`f64`, `bool`, `String`). Per spec Part V §2 Week 2 Day 1-2.
//!
//! Two flavours of numeric coercion:
//! - `to_number_strict` — rejects `Text` with `#VALUE!`. Used by function args that reject
//!   text (e.g. `SQRT("abc")` → `#VALUE!`).
//! - `to_number_lenient` — parses `Text` as ASCII-invariant number, also accepts the
//!   trailing-`%` form (`"50%"` → 0.5). Used by arithmetic operators (`"5" + 1` → 6).
//!
//! Coercion rules locked here (per Excel canon):
//! - `Blank` → 0.0 / false / "".
//! - `Number` → passes through; NaN/Inf produce `#NUM!` (the `Value::number` constructor
//!   enforces the same invariant).
//! - `Boolean` → `TRUE` = 1.0, `FALSE` = 0.0.
//! - `Text` → strict: `#VALUE!`. lenient: parse ASCII `[+\-]?digits[.digits]?(e\d+)?` with
//!   optional trailing `%`; whitespace trimmed.
//! - `Error` → propagates (returns the same error).
//!
//! Phase 0 is locale-agnostic — no thousand separators, no comma decimal. Locale-aware
//! coercion lands with `ql-functions::format` in Phase 3.

use crate::error::ErrorValue;
use crate::value::Value;

/// Strict numeric coercion. Used by builtins that reject text (`SQRT`, `EXP`, etc.).
///
/// Rules: `Blank` → 0.0; `Number(n)` → `Ok(n)` with NaN/Inf → `#NUM!`;
/// `Boolean(t)` → `1.0|0.0`; `Text(_)` → `#VALUE!`; `Error(e)` propagates.
pub fn to_number_strict(v: &Value) -> Result<f64, ErrorValue> {
    match v {
        Value::Blank => Ok(0.0),
        Value::Number(n) => sanitize_f64(*n),
        Value::Boolean(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Text(_) => Err(ErrorValue::Value),
        Value::Error(e) => Err(*e),
    }
}

/// Lenient numeric coercion. Used by arithmetic operators that mimic Excel's "5" + 1 = 6.
/// Falls back to text parsing when the input is `Text`.
pub fn to_number_lenient(v: &Value) -> Result<f64, ErrorValue> {
    match v {
        Value::Text(s) => parse_number_invariant(s).ok_or(ErrorValue::Value),
        _ => to_number_strict(v),
    }
}

/// Logical coercion. Used by `IF`, `AND`, `OR`, comparison operators.
///
/// Rules: `Blank` → false; `Number(n)` → `n != 0` (NaN/Inf → `#NUM!`); `Boolean(b)` → b;
/// `Text` "true"/"false" (ASCII case-fold, trimmed) → bool; other text → `#VALUE!`;
/// `Error(e)` propagates.
pub fn to_logical(v: &Value) -> Result<bool, ErrorValue> {
    match v {
        Value::Blank => Ok(false),
        Value::Number(n) => sanitize_f64(*n).map(|x| x != 0.0),
        Value::Boolean(b) => Ok(*b),
        Value::Text(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(ErrorValue::Value),
        },
        Value::Error(e) => Err(*e),
    }
}

/// Invariant text representation — identical to `Value::Display`. Locale-agnostic.
/// Used by string concatenation (`&`) and by criteria strings (`">="&A1`).
pub fn to_text(v: &Value) -> String {
    format!("{v}")
}

/// Clamp finite. NaN or ±∞ become `#NUM!`. Use in kernels right before wrapping into
/// `Value::Number`.
pub fn sanitize_f64(n: f64) -> Result<f64, ErrorValue> {
    if n.is_nan() || n.is_infinite() {
        Err(ErrorValue::Num)
    } else {
        Ok(n)
    }
}

/// Parse a number from invariant text — ASCII only, optional sign, optional decimal,
/// optional exponent, optional trailing `%` (which divides by 100). Whitespace trimmed.
///
/// Returns `None` for unparseable input. Caller maps to the appropriate Excel error
/// (`#VALUE!` for arithmetic context, `#NUM!` for finite-only context).
fn parse_number_invariant(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // Trailing % form: parse the rest, divide by 100.
    if let Some(stripped) = s.strip_suffix('%') {
        let inner = stripped.trim();
        let n: f64 = inner.parse().ok()?;
        if n.is_nan() || n.is_infinite() {
            return None;
        }
        return Some(n / 100.0);
    }
    let n: f64 = s.parse().ok()?;
    if n.is_nan() || n.is_infinite() {
        None
    } else {
        Some(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // -- sanitize_f64 ----------------------------------------------------------

    #[test]
    fn sanitize_passes_finite_numbers() {
        assert_eq!(sanitize_f64(1.5).unwrap(), 1.5);
        assert_eq!(sanitize_f64(0.0).unwrap(), 0.0);
        assert_eq!(sanitize_f64(-0.0).unwrap(), -0.0);
        assert_eq!(sanitize_f64(f64::MAX).unwrap(), f64::MAX);
        assert_eq!(sanitize_f64(f64::MIN_POSITIVE).unwrap(), f64::MIN_POSITIVE);
    }

    #[test]
    fn sanitize_rejects_nan_and_infinities() {
        assert_eq!(sanitize_f64(f64::NAN).unwrap_err(), ErrorValue::Num);
        assert_eq!(sanitize_f64(f64::INFINITY).unwrap_err(), ErrorValue::Num);
        assert_eq!(
            sanitize_f64(f64::NEG_INFINITY).unwrap_err(),
            ErrorValue::Num
        );
    }

    // -- to_number_strict ------------------------------------------------------

    #[test]
    fn strict_blank_is_zero() {
        assert_eq!(to_number_strict(&Value::Blank).unwrap(), 0.0);
    }

    #[test]
    fn strict_number_passthrough() {
        assert_eq!(to_number_strict(&Value::Number(2.5)).unwrap(), 2.5);
    }

    #[test]
    fn strict_number_nan_inf_becomes_num_error() {
        // Note: Value::Number(NaN) bypasses the safe constructor — we still want strict
        // coercion to translate it to #NUM! rather than letting it leak downstream.
        assert_eq!(
            to_number_strict(&Value::Number(f64::NAN)).unwrap_err(),
            ErrorValue::Num
        );
        assert_eq!(
            to_number_strict(&Value::Number(f64::INFINITY)).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn strict_boolean_to_unit_or_zero() {
        assert_eq!(to_number_strict(&Value::Boolean(true)).unwrap(), 1.0);
        assert_eq!(to_number_strict(&Value::Boolean(false)).unwrap(), 0.0);
    }

    #[test]
    fn strict_text_is_value_error() {
        assert_eq!(
            to_number_strict(&Value::text("1")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_strict(&Value::text("anything")).unwrap_err(),
            ErrorValue::Value
        );
    }

    #[test]
    fn strict_error_propagates() {
        for e in ErrorValue::ALL {
            assert_eq!(to_number_strict(&Value::Error(e)).unwrap_err(), e);
        }
    }

    // -- to_number_lenient -----------------------------------------------------

    #[test]
    fn lenient_text_simple() {
        assert_eq!(to_number_lenient(&Value::text("42")).unwrap(), 42.0);
        assert_eq!(to_number_lenient(&Value::text("2.5")).unwrap(), 2.5);
        assert_eq!(to_number_lenient(&Value::text("-7.5")).unwrap(), -7.5);
        assert_eq!(to_number_lenient(&Value::text("+10")).unwrap(), 10.0);
        assert_eq!(to_number_lenient(&Value::text("0")).unwrap(), 0.0);
    }

    #[test]
    fn lenient_text_with_whitespace_and_exponent() {
        assert_eq!(to_number_lenient(&Value::text(" 42 ")).unwrap(), 42.0);
        assert_eq!(to_number_lenient(&Value::text("1e3")).unwrap(), 1000.0);
        assert_eq!(to_number_lenient(&Value::text("-1.5e-2")).unwrap(), -0.015);
    }

    #[test]
    fn lenient_text_percent() {
        assert_eq!(to_number_lenient(&Value::text("50%")).unwrap(), 0.5);
        assert_eq!(to_number_lenient(&Value::text(" 12.5% ")).unwrap(), 0.125);
        assert_eq!(to_number_lenient(&Value::text("-25%")).unwrap(), -0.25);
        assert_eq!(to_number_lenient(&Value::text("0%")).unwrap(), 0.0);
    }

    #[test]
    fn lenient_text_unparseable_is_value_error() {
        assert_eq!(
            to_number_lenient(&Value::text("abc")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_lenient(&Value::text("")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_lenient(&Value::text("1.2.3")).unwrap_err(),
            ErrorValue::Value
        );
        // No thousand-separator support in invariant Phase 0.
        assert_eq!(
            to_number_lenient(&Value::text("1,000")).unwrap_err(),
            ErrorValue::Value
        );
        // No locale-comma decimal.
        assert_eq!(
            to_number_lenient(&Value::text("1,5")).unwrap_err(),
            ErrorValue::Value
        );
    }

    #[test]
    fn lenient_text_nan_inf_unparseable() {
        // Don't let "NaN" or "inf" sneak through.
        assert!(to_number_lenient(&Value::text("NaN")).is_err());
        assert!(to_number_lenient(&Value::text("inf")).is_err());
        assert!(to_number_lenient(&Value::text("-inf")).is_err());
    }

    #[test]
    fn lenient_non_text_same_as_strict() {
        assert_eq!(to_number_lenient(&Value::Blank).unwrap(), 0.0);
        assert_eq!(to_number_lenient(&Value::Number(1.5)).unwrap(), 1.5);
        assert_eq!(to_number_lenient(&Value::Boolean(true)).unwrap(), 1.0);
        assert_eq!(
            to_number_lenient(&Value::Error(ErrorValue::Ref)).unwrap_err(),
            ErrorValue::Ref
        );
    }

    // -- to_logical ------------------------------------------------------------

    #[test]
    fn logical_blank_is_false() {
        assert!(!to_logical(&Value::Blank).unwrap());
    }

    #[test]
    fn logical_boolean_passthrough() {
        assert!(to_logical(&Value::Boolean(true)).unwrap());
        assert!(!to_logical(&Value::Boolean(false)).unwrap());
    }

    #[test]
    fn logical_number_nonzero_is_true() {
        assert!(to_logical(&Value::Number(1.0)).unwrap());
        assert!(to_logical(&Value::Number(-1.0)).unwrap());
        assert!(to_logical(&Value::Number(0.0001)).unwrap());
        assert!(!to_logical(&Value::Number(0.0)).unwrap());
        // -0.0 is still zero
        assert!(!to_logical(&Value::Number(-0.0)).unwrap());
    }

    #[test]
    fn logical_number_nan_inf_is_num_error() {
        assert_eq!(
            to_logical(&Value::Number(f64::NAN)).unwrap_err(),
            ErrorValue::Num
        );
        assert_eq!(
            to_logical(&Value::Number(f64::INFINITY)).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn logical_text_true_false_case_insensitive() {
        for s in ["true", "True", "TRUE", "tRuE", " true ", " TRUE "] {
            assert!(
                to_logical(&Value::text(s)).unwrap(),
                "expected TRUE for {s:?}"
            );
        }
        for s in ["false", "False", "FALSE", "fAlSe", " false ", " FALSE "] {
            assert!(
                !to_logical(&Value::text(s)).unwrap(),
                "expected FALSE for {s:?}"
            );
        }
    }

    #[test]
    fn logical_text_other_is_value_error() {
        assert_eq!(
            to_logical(&Value::text("yes")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(to_logical(&Value::text("")).unwrap_err(), ErrorValue::Value);
        assert_eq!(
            to_logical(&Value::text("1")).unwrap_err(),
            ErrorValue::Value
        );
    }

    #[test]
    fn logical_error_propagates() {
        for e in ErrorValue::ALL {
            assert_eq!(to_logical(&Value::Error(e)).unwrap_err(), e);
        }
    }

    // -- to_text ---------------------------------------------------------------

    #[test]
    fn text_invariant_forms() {
        assert_eq!(to_text(&Value::Blank), "");
        assert_eq!(to_text(&Value::Number(1.5)), "1.5");
        assert_eq!(to_text(&Value::Number(0.0)), "0");
        assert_eq!(to_text(&Value::Number(-2.5)), "-2.5");
        assert_eq!(to_text(&Value::Boolean(true)), "TRUE");
        assert_eq!(to_text(&Value::Boolean(false)), "FALSE");
        assert_eq!(to_text(&Value::text("hi")), "hi");
        assert_eq!(to_text(&Value::Error(ErrorValue::Ref)), "#REF!");
        assert_eq!(
            to_text(&Value::Error(ErrorValue::Disconnected)),
            "#DISCONNECTED!"
        );
    }

    #[test]
    fn text_preserves_arc_str_content() {
        let s: Arc<str> = "anything-here".into();
        assert_eq!(to_text(&Value::Text(s)), "anything-here");
    }

    // -- error short-circuit precedence ---------------------------------------

    #[test]
    fn error_short_circuits_in_all_coercions() {
        // Same input, same error out — across strict / lenient / logical.
        let inp = Value::Error(ErrorValue::Calc);
        assert_eq!(to_number_strict(&inp).unwrap_err(), ErrorValue::Calc);
        assert_eq!(to_number_lenient(&inp).unwrap_err(), ErrorValue::Calc);
        assert_eq!(to_logical(&inp).unwrap_err(), ErrorValue::Calc);
    }

    // -- parse_number_invariant (private but worth direct coverage) ------------

    #[test]
    fn parse_number_invariant_edge_cases() {
        assert_eq!(parse_number_invariant("0"), Some(0.0));
        assert_eq!(parse_number_invariant("-0"), Some(0.0));
        assert_eq!(parse_number_invariant("1."), Some(1.0));
        assert_eq!(parse_number_invariant(".5"), Some(0.5));
        assert_eq!(parse_number_invariant("100%"), Some(1.0));
        assert_eq!(parse_number_invariant(" 50 % "), Some(0.5));
        assert_eq!(parse_number_invariant(""), None);
        assert_eq!(parse_number_invariant("   "), None);
        assert_eq!(parse_number_invariant("%"), None);
        assert_eq!(parse_number_invariant("abc"), None);
    }
}
