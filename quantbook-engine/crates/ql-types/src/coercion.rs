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

/// Invariant text representation for **display** contexts — UI rendering, debug, criteria-key
/// formation. Infallible; `Value::Error(e)` is rendered as its sigil (`"#REF!"`, `"#NUM!"`, ...).
/// Locale-agnostic.
///
/// **Do NOT use for the formula `&` operator** — see [`to_text_for_formula`]. Excel propagates
/// errors through concatenation: `=#REF! & "x"` evaluates to `#REF!`, not the string `"#REF!x"`.
pub fn to_text_for_display(v: &Value) -> String {
    format!("{v}")
}

/// Invariant text representation for **formula** contexts — the `&` operator and any builtin
/// that takes a text argument and would otherwise short-circuit on an error.
/// Returns `Err(e)` when the input is `Value::Error(e)`, matching Excel's error-propagation rule.
pub fn to_text_for_formula(v: &Value) -> Result<String, ErrorValue> {
    match v {
        Value::Error(e) => Err(*e),
        _ => Ok(format!("{v}")),
    }
}

/// Clamp finite. NaN or ±∞ become `#NUM!`. Use at the leaf of a kernel right before wrapping
/// into `Value::Number`.
///
/// **Contract for arithmetic kernels** (Week 4 ql-exec / ql-functions): `sanitize_f64` maps
/// every non-finite `f64` to `#NUM!` uniformly. Excel distinguishes a structural zero-divisor
/// (`=A/0` → `#DIV/0!`) from an overflow-to-infinity (`=1e308 * 10` → `#NUM!`). Both are `Inf`
/// at the f64 level, so kernels MUST check divisor-zero BEFORE the division and emit
/// `Err(ErrorValue::DivZero)` directly. Only call `sanitize_f64` on the result when the
/// operation is non-division (and even then, only for overflow / NaN propagation).
///
/// Pseudo-code for a div kernel:
/// ```text
/// fn div(a: f64, b: f64) -> Result<f64, ErrorValue> {
///     if b == 0.0 { return Err(ErrorValue::DivZero); }   // CHECK FIRST
///     sanitize_f64(a / b)                                 // then map overflow → #NUM!
/// }
/// ```
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

    // -- to_text_for_display ---------------------------------------------------

    #[test]
    fn display_text_invariant_forms() {
        assert_eq!(to_text_for_display(&Value::Blank), "");
        assert_eq!(to_text_for_display(&Value::Number(1.5)), "1.5");
        assert_eq!(to_text_for_display(&Value::Number(0.0)), "0");
        assert_eq!(to_text_for_display(&Value::Number(-2.5)), "-2.5");
        assert_eq!(to_text_for_display(&Value::Boolean(true)), "TRUE");
        assert_eq!(to_text_for_display(&Value::Boolean(false)), "FALSE");
        assert_eq!(to_text_for_display(&Value::text("hi")), "hi");
        // display path: errors render as sigil (for UI / debug / criteria-key formation)
        assert_eq!(to_text_for_display(&Value::Error(ErrorValue::Ref)), "#REF!");
        assert_eq!(
            to_text_for_display(&Value::Error(ErrorValue::Disconnected)),
            "#DISCONNECTED!"
        );
        assert_eq!(
            to_text_for_display(&Value::Error(ErrorValue::AINotAvailable)),
            "#AI_NOT_AVAILABLE_V1"
        );
    }

    #[test]
    fn display_text_preserves_arc_str_content() {
        let s: Arc<str> = "anything-here".into();
        assert_eq!(to_text_for_display(&Value::Text(s)), "anything-here");
    }

    // -- to_text_for_formula ---------------------------------------------------

    #[test]
    fn formula_text_non_errors_match_display() {
        // For non-Error inputs, formula text matches display text.
        for v in [
            Value::Blank,
            Value::Number(1.5),
            Value::Number(0.0),
            Value::Boolean(true),
            Value::Boolean(false),
            Value::text("hello"),
        ] {
            assert_eq!(
                to_text_for_formula(&v).unwrap(),
                to_text_for_display(&v),
                "mismatch for {v:?}"
            );
        }
    }

    #[test]
    fn formula_text_propagates_every_error_variant() {
        // Excel: `=#REF! & "x"` → #REF!, not "#REF!x".
        // Every ErrorValue variant must propagate through to_text_for_formula.
        for e in ErrorValue::ALL {
            assert_eq!(
                to_text_for_formula(&Value::Error(e)).unwrap_err(),
                e,
                "expected propagation of {e:?}"
            );
        }
    }

    // -- error short-circuit precedence ---------------------------------------

    #[test]
    fn error_short_circuits_in_all_coercions() {
        // Same input, same error out — across strict / lenient / logical / formula-text.
        let inp = Value::Error(ErrorValue::Calc);
        assert_eq!(to_number_strict(&inp).unwrap_err(), ErrorValue::Calc);
        assert_eq!(to_number_lenient(&inp).unwrap_err(), ErrorValue::Calc);
        assert_eq!(to_logical(&inp).unwrap_err(), ErrorValue::Calc);
        assert_eq!(to_text_for_formula(&inp).unwrap_err(), ErrorValue::Calc);
        // Display path is the deliberate exception — it renders the sigil for UI:
        assert_eq!(to_text_for_display(&inp), "#CALC!");
    }

    // -- division-zero seam contract (sanitize_f64 doc) -------------------------

    /// This test fixes the contract that future ql-functions / ql-exec kernels MUST honor:
    /// `sanitize_f64` is for overflow/underflow/NaN translation only. Division by zero must be
    /// surfaced as `#DIV/0!` BEFORE the f64 division; otherwise the kernel would emit
    /// `#NUM!` for the resulting `Inf`, which is Excel-wrong.
    #[test]
    fn sanitize_treats_infinity_as_num_so_div_kernels_must_check_zero_first() {
        // Bare `1.0 / 0.0` produces +Inf; sanitize_f64 maps that to #NUM!.
        // If a kernel skipped its divisor-zero check and relied on this fallback, =A/0 would
        // incorrectly become #NUM! instead of #DIV/0!.
        assert_eq!(sanitize_f64(1.0_f64 / 0.0).unwrap_err(), ErrorValue::Num);
        assert_eq!(sanitize_f64(-1.0_f64 / 0.0).unwrap_err(), ErrorValue::Num);
        // The right pattern (replicated here to lock the contract):
        fn div(a: f64, b: f64) -> Result<f64, ErrorValue> {
            if b == 0.0 {
                return Err(ErrorValue::DivZero); // check first
            }
            sanitize_f64(a / b)
        }
        assert_eq!(div(1.0, 0.0).unwrap_err(), ErrorValue::DivZero);
        assert_eq!(div(1.0, 2.0).unwrap(), 0.5);
        // Overflow still maps to #NUM! through sanitize_f64:
        assert_eq!(div(f64::MAX, 1e-308).unwrap_err(), ErrorValue::Num);
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

    // -- audit-flagged edge cases (opus-arch + codex r11) ----------------------

    #[test]
    fn negative_zero_equality_with_positive_zero() {
        // Excel + IEEE 754: -0.0 == 0.0 in numerical comparison. Test lock.
        assert_eq!(Value::Number(0.0), Value::Number(-0.0));
        // Through to_number_strict both flatten to 0.0.
        assert_eq!(to_number_strict(&Value::Number(0.0)).unwrap(), 0.0);
        assert_eq!(to_number_strict(&Value::Number(-0.0)).unwrap(), 0.0);
    }

    #[test]
    fn subnormal_numbers_pass_through_strict_and_lenient() {
        // Excel divergence intentionally documented: Excel may round subnormals to zero in
        // some contexts; we don't. The values below `f64::MIN_POSITIVE` are subnormals.
        let sub = f64::MIN_POSITIVE / 2.0;
        assert!(sub > 0.0); // sanity
        assert!(sub < f64::MIN_POSITIVE);
        assert_eq!(to_number_strict(&Value::Number(sub)).unwrap(), sub);
        assert_eq!(sanitize_f64(sub).unwrap(), sub);
    }

    #[test]
    fn integer_2_pow_53_boundary_collapses_per_f64_mantissa() {
        // f64 has a 52-bit mantissa + implicit 1; integers up to 2^53 are exactly representable.
        // 2^53 and 2^53 + 1 collapse to the same f64 value — same as Excel's number type.
        let a: f64 = 9007199254740992.0; // 2^53
        let b: f64 = 9007199254740993.0; // 2^53 + 1 (not representable; rounds to 2^53)
        assert_eq!(a, b);
        assert_eq!(Value::Number(a), Value::Number(b));
    }

    #[test]
    fn empty_string_vs_blank_logical_distinction() {
        // Distinct variants...
        assert_ne!(Value::Blank, Value::text(""));
        // ...with distinct logical-coercion behavior.
        assert!(!to_logical(&Value::Blank).unwrap()); // Blank → false
        assert_eq!(
            to_logical(&Value::text("")).unwrap_err(),
            ErrorValue::Value // "" → #VALUE! (not parseable as TRUE/FALSE)
        );
    }

    #[test]
    fn locale_currency_explicitly_rejected_v1_boundary() {
        // Locks the Phase 0 locale-agnostic rule. WHEN locale parsing lands in Phase 3, these
        // assertions need to be inverted; until then they're the v1.5 boundary marker.
        assert_eq!(
            to_number_lenient(&Value::text("$1000.50")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_lenient(&Value::text("$1,000.50")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_lenient(&Value::text("€500")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_lenient(&Value::text("£99.99")).unwrap_err(),
            ErrorValue::Value
        );
    }

    // -- systematic edge-case coverage (whitespace) ---------------------------

    #[test]
    fn whitespace_combinations() {
        assert_eq!(to_number_lenient(&Value::text("\t42")).unwrap(), 42.0);
        assert_eq!(to_number_lenient(&Value::text("42\n")).unwrap(), 42.0);
        assert_eq!(to_number_lenient(&Value::text("\r\n42\r\n")).unwrap(), 42.0);
        // Interior whitespace: rejected (matches f64::from_str rules).
        assert!(to_number_lenient(&Value::text("1 0")).is_err());
        assert!(to_number_lenient(&Value::text("1\t0")).is_err());
    }

    #[test]
    fn nbsp_and_bom_boundary_behavior() {
        // `str::trim` uses `char::is_whitespace` which classifies U+00A0 NBSP as whitespace
        // but does NOT include U+FEFF BOM (per Unicode `White_Space` property). Lock the
        // observed behavior:
        // - Edge NBSP: stripped by trim → f64 parses → Ok.
        // - Edge BOM: NOT stripped → f64::parse rejects (BOM char isn't a digit) → Err.
        // - Embedded NBSP: not stripped (only leading/trailing) → f64::parse rejects → Err.
        assert_eq!(
            to_number_lenient(&Value::text("\u{00A0}42\u{00A0}")).unwrap(),
            42.0
        );
        assert_eq!(
            to_number_lenient(&Value::text("\u{FEFF}42")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_number_lenient(&Value::text("4\u{00A0}2")).unwrap_err(),
            ErrorValue::Value
        );
    }

    // -- systematic edge-case coverage (number formats) -----------------------

    #[test]
    fn hex_octal_binary_prefixes_rejected() {
        // Excel doesn't accept 0x/0o/0b prefixes in normal numeric context (HEX2DEC etc.
        // require explicit conversion functions). f64::from_str rejects them anyway.
        assert!(to_number_lenient(&Value::text("0x1F")).is_err());
        assert!(to_number_lenient(&Value::text("0o17")).is_err());
        assert!(to_number_lenient(&Value::text("0b101")).is_err());
        assert!(to_number_lenient(&Value::text("0xFF")).is_err());
    }

    #[test]
    fn leading_zeros_accepted_as_decimal() {
        // Excel accepts "007" as 7 (decimal). Our f64::parse path agrees.
        assert_eq!(to_number_lenient(&Value::text("007")).unwrap(), 7.0);
        assert_eq!(to_number_lenient(&Value::text("00.5")).unwrap(), 0.5);
        assert_eq!(to_number_lenient(&Value::text("-007")).unwrap(), -7.0);
    }

    #[test]
    fn comma_decimal_separator_rejected_locale_v1() {
        // German/French "1,5" notation. Phase 0 locks invariant ASCII parse; locale comes in Phase 3.
        assert!(to_number_lenient(&Value::text("1,5")).is_err());
        assert!(to_number_lenient(&Value::text("1.000,5")).is_err());
    }

    // -- systematic edge-case coverage (exponent edges) -----------------------

    #[test]
    fn exponent_zero_forms_resolve_to_zero() {
        // 0e... is always zero regardless of exponent.
        assert_eq!(to_number_lenient(&Value::text("0e0")).unwrap(), 0.0);
        assert_eq!(to_number_lenient(&Value::text("0e+10")).unwrap(), 0.0);
        assert_eq!(to_number_lenient(&Value::text("0e-10")).unwrap(), 0.0);
        assert_eq!(to_number_lenient(&Value::text("-0e5")).unwrap(), 0.0);
    }

    #[test]
    fn exponent_overflow_to_infinity_is_rejected() {
        // 1e500 overflows to +Inf. Our parser rejects (returns #VALUE! via None).
        assert!(to_number_lenient(&Value::text("1e500")).is_err());
        assert!(to_number_lenient(&Value::text("-1e500")).is_err());
    }

    #[test]
    fn exponent_underflow_to_subnormal_or_zero() {
        // 1e-323 is still representable (smallest subnormal positive ~5e-324).
        let near_zero = to_number_lenient(&Value::text("1e-323")).unwrap();
        assert!(near_zero >= 0.0);
        // 1e-324 underflows to 0.0 (which is finite, so accepted).
        let result = to_number_lenient(&Value::text("1e-324"));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0.0);
    }

    #[test]
    fn exponent_malformed_rejected() {
        // "1e" no exponent digits.
        assert!(to_number_lenient(&Value::text("1e")).is_err());
        // "1e+" no exponent digits after sign.
        assert!(to_number_lenient(&Value::text("1e+")).is_err());
        // "e5" no mantissa.
        assert!(to_number_lenient(&Value::text("e5")).is_err());
        // Multiple exponents.
        assert!(to_number_lenient(&Value::text("1e2e3")).is_err());
    }

    // -- percent edge cases ----------------------------------------------------

    #[test]
    fn percent_with_decimal_and_exponent() {
        assert_eq!(to_number_lenient(&Value::text("12.5%")).unwrap(), 0.125);
        assert_eq!(to_number_lenient(&Value::text("1e2%")).unwrap(), 1.0); // 100% = 1.0
        assert_eq!(to_number_lenient(&Value::text("-50%")).unwrap(), -0.5);
    }

    #[test]
    fn percent_chaining_rejected() {
        // "50%%" — double percent isn't a thing in Excel; reject.
        assert!(to_number_lenient(&Value::text("50%%")).is_err());
        // Internal percent.
        assert!(to_number_lenient(&Value::text("5%0")).is_err());
    }

    #[test]
    fn percent_alone_rejected() {
        // Bare "%" or whitespace-only with trailing %.
        assert!(to_number_lenient(&Value::text("%")).is_err());
        assert!(to_number_lenient(&Value::text(" %")).is_err());
    }

    // -- sign edge cases -------------------------------------------------------

    #[test]
    fn sign_only_rejected() {
        assert!(to_number_lenient(&Value::text("+")).is_err());
        assert!(to_number_lenient(&Value::text("-")).is_err());
        assert!(to_number_lenient(&Value::text("+-5")).is_err());
        assert!(to_number_lenient(&Value::text("--5")).is_err());
    }

    #[test]
    fn space_between_sign_and_digits_rejected() {
        assert!(to_number_lenient(&Value::text("- 5")).is_err());
        assert!(to_number_lenient(&Value::text("+ 5")).is_err());
    }

    // -- decimal-point edge cases ---------------------------------------------

    #[test]
    fn dot_only_and_dotted_edges() {
        assert!(to_number_lenient(&Value::text(".")).is_err());
        assert_eq!(to_number_lenient(&Value::text("1.")).unwrap(), 1.0);
        assert_eq!(to_number_lenient(&Value::text(".5")).unwrap(), 0.5);
        assert_eq!(to_number_lenient(&Value::text("-0.5")).unwrap(), -0.5);
        // Multiple decimals.
        assert!(to_number_lenient(&Value::text("1.2.3")).is_err());
    }

    // -- NaN / inf textual rejected -------------------------------------------

    #[test]
    fn nan_inf_text_unparseable() {
        // f64::parse accepts "NaN" and "inf", but we want spreadsheet-strict — reject.
        // CURRENT BEHAVIOR: our parser DOES filter via the NaN/Inf check after parse,
        // returning None. Lock this contract.
        assert!(to_number_lenient(&Value::text("NaN")).is_err());
        assert!(to_number_lenient(&Value::text("inf")).is_err());
        assert!(to_number_lenient(&Value::text("Infinity")).is_err());
        assert!(to_number_lenient(&Value::text("-inf")).is_err());
        assert!(to_number_lenient(&Value::text("+Inf")).is_err());
    }

    // -- to_logical edge: whitespace + literal forms --------------------------

    #[test]
    fn logical_text_only_true_false_recognized() {
        // Only TRUE / FALSE in any ASCII case are accepted. "T", "F", "yes", "no", "1", "0" → #VALUE!.
        assert_eq!(
            to_logical(&Value::text("T")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_logical(&Value::text("F")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_logical(&Value::text("yes")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_logical(&Value::text("no")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_logical(&Value::text("1")).unwrap_err(),
            ErrorValue::Value
        );
        assert_eq!(
            to_logical(&Value::text("0")).unwrap_err(),
            ErrorValue::Value
        );
    }

    // -- size + max-precision boundary ----------------------------------------

    #[test]
    fn very_large_number_passes_strict() {
        assert_eq!(
            to_number_strict(&Value::Number(f64::MAX)).unwrap(),
            f64::MAX
        );
        // Just below positive infinity stays finite.
        let close = f64::MAX / 1.0001;
        assert_eq!(to_number_strict(&Value::Number(close)).unwrap(), close);
    }
}
