//! Scalar built-in functions for Phase 0.
//!
//! Each function is `fn(&[Value]) -> Value` with Excel-compatible semantics. Args are
//! pre-evaluated by the caller (the binder produces a flat arg list; range references
//! get expanded to per-cell Values before this layer).
//!
//! ## Phase 0 function set (W4-4)
//!
//! Numeric aggregates: SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, PRODUCT, VAR.S, VAR.P,
//! STDEV.S, STDEV.P.
//!
//! Logical: IF, AND, OR, NOT, IFERROR.
//!
//! Math: ABS, SQRT, ROUND, INT, MOD, POWER.
//!
//! Type coercion semantics mirror `ql-types::coercion`:
//! - SUM / AVERAGE / etc. use `to_number_strict` per arg; Text → #VALUE!.
//! - COUNT counts numeric values only (Bool/Text/Error/Blank skipped).
//! - COUNTA counts non-blank values (Error counted).
//! - Error propagation: any Error arg → return that error.

use ql_types::{coercion, ErrorValue, Value};

use crate::welford;
use crate::welford::WelfordState;

/// Helper: extract `f64` from a Value, propagating Error. Skip Blank (treats as
/// "absent" — caller decides whether that's an error or a no-op for the function).
enum NumericArg {
    Number(f64),
    Skip,
    Error(ErrorValue),
}

fn coerce_numeric(v: &Value) -> NumericArg {
    match v {
        Value::Error(e) => NumericArg::Error(*e),
        Value::Blank => NumericArg::Skip,
        other => match coercion::to_number_strict(other) {
            Ok(n) => NumericArg::Number(n),
            Err(e) => NumericArg::Error(e),
        },
    }
}

/// Helper: feed args through a Welford-style accumulator (streaming variant).
/// Errors short-circuit. Returns `Ok((state))` if all args usable.
fn welford_from_args(args: &[Value]) -> Result<WelfordState, ErrorValue> {
    let mut state = WelfordState::new();
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => state.update(n),
            NumericArg::Skip => {} // Blank skipped — Excel SUM/AVERAGE treats blanks as absent.
            NumericArg::Error(e) => return Err(e),
        }
    }
    Ok(state)
}

/// Helper: materialize args into a `Vec<f64>` for two-pass batch processing. Errors
/// short-circuit; Blank skipped.
fn numeric_args(args: &[Value]) -> Result<Vec<f64>, ErrorValue> {
    let mut out = Vec::with_capacity(args.len());
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => out.push(n),
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Err(e),
        }
    }
    Ok(out)
}

// ===== Aggregates =====

/// `SUM(args...)` — sum of numeric values; Blank skipped; Error propagates.
pub fn sum(args: &[Value]) -> Value {
    let mut total = 0.0_f64;
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => total += n,
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    match coercion::sanitize_f64(total) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `AVERAGE(args...)` — arithmetic mean of numeric values; Blank skipped; #DIV/0! on
/// empty input. Uses Welford for numerical stability (matches A6 spec).
pub fn average(args: &[Value]) -> Value {
    let state = match welford_from_args(args) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    if state.count() == 0 {
        return Value::Error(ErrorValue::DivZero);
    }
    match coercion::sanitize_f64(state.mean()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `COUNT(args...)` — counts numeric values only. Bool/Text/Error/Blank skipped.
/// Always returns a non-negative count; errors do NOT propagate (per Excel COUNT
/// semantics — errors are part of the "not a number" category).
pub fn count(args: &[Value]) -> Value {
    let mut c = 0u64;
    for v in args {
        if matches!(v, Value::Number(_)) {
            c += 1;
        }
    }
    Value::Number(c as f64)
}

/// `COUNTA(args...)` — counts all non-blank values, including Error and Text.
pub fn counta(args: &[Value]) -> Value {
    let c = args.iter().filter(|v| !matches!(v, Value::Blank)).count();
    Value::Number(c as f64)
}

/// `MIN(args...)` — smallest numeric value; Blank skipped; Error propagates; empty
/// returns 0 per Excel.
pub fn min(args: &[Value]) -> Value {
    let mut current: Option<f64> = None;
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => {
                current = Some(match current {
                    Some(c) => c.min(n),
                    None => n,
                });
            }
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    Value::Number(current.unwrap_or(0.0))
}

/// `MAX(args...)` — largest numeric value.
pub fn max(args: &[Value]) -> Value {
    let mut current: Option<f64> = None;
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => {
                current = Some(match current {
                    Some(c) => c.max(n),
                    None => n,
                });
            }
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    Value::Number(current.unwrap_or(0.0))
}

/// `PRODUCT(args...)` — product of numeric values; Blank skipped; Error propagates;
/// empty returns 0 per Excel.
pub fn product(args: &[Value]) -> Value {
    let mut total: Option<f64> = None;
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => {
                total = Some(total.unwrap_or(1.0) * n);
            }
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    let result = total.unwrap_or(0.0);
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== Variance / stdev (Welford-backed; A6 spec) =====

/// `VAR.S(args...)` — sample variance via two-pass for batch-input precision (A6 spec).
pub fn var_s(args: &[Value]) -> Value {
    let nums = match numeric_args(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    match welford::sample_variance(&nums) {
        Some(v) => match coercion::sanitize_f64(v) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        None => Value::Error(ErrorValue::DivZero),
    }
}

/// `VAR.P(args...)` — population variance via two-pass.
pub fn var_p(args: &[Value]) -> Value {
    let nums = match numeric_args(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    match welford::population_variance(&nums) {
        Some(v) => match coercion::sanitize_f64(v) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        None => Value::Error(ErrorValue::DivZero),
    }
}

/// `STDEV.S(args...)` — sample stdev via two-pass.
pub fn stdev_s(args: &[Value]) -> Value {
    let nums = match numeric_args(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    match welford::sample_stdev(&nums) {
        Some(v) => match coercion::sanitize_f64(v) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        None => Value::Error(ErrorValue::DivZero),
    }
}

/// `STDEV.P(args...)` — population stdev via two-pass.
pub fn stdev_p(args: &[Value]) -> Value {
    let nums = match numeric_args(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    match welford::population_stdev(&nums) {
        Some(v) => match coercion::sanitize_f64(v) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        None => Value::Error(ErrorValue::DivZero),
    }
}

// ===== Logical =====

/// `IF(cond, then, else)` — exactly 3 args; cond coerced to bool; selects branch.
/// Error in cond propagates immediately. Errors in unselected branch are NOT evaluated
/// in Excel (lazy semantics) — but Phase 0 args are pre-evaluated, so an error in the
/// unselected branch arrives as a Value::Error and IS ignored if the other branch is
/// selected (matches Excel's apparent behavior). #VALUE! if wrong arg count.
pub fn r#if(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let cond = match &args[0] {
        Value::Error(e) => return Value::Error(*e),
        other => match coercion::to_logical(other) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        },
    };
    if cond {
        args[1].clone()
    } else {
        args[2].clone()
    }
}

/// `AND(args...)` — all-true. Empty input returns #VALUE!. Errors propagate.
pub fn and(args: &[Value]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let mut all = true;
    let mut any_non_blank = false;
    for v in args {
        match v {
            Value::Error(e) => return Value::Error(*e),
            Value::Blank => {}
            other => {
                any_non_blank = true;
                match coercion::to_logical(other) {
                    Ok(b) => all &= b,
                    Err(e) => return Value::Error(e),
                }
            }
        }
    }
    if !any_non_blank {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(all)
}

pub fn or(args: &[Value]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let mut any = false;
    let mut any_non_blank = false;
    for v in args {
        match v {
            Value::Error(e) => return Value::Error(*e),
            Value::Blank => {}
            other => {
                any_non_blank = true;
                match coercion::to_logical(other) {
                    Ok(b) => any |= b,
                    Err(e) => return Value::Error(e),
                }
            }
        }
    }
    if !any_non_blank {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(any)
}

pub fn not(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    match &args[0] {
        Value::Error(e) => Value::Error(*e),
        other => match coercion::to_logical(other) {
            Ok(b) => Value::Boolean(!b),
            Err(e) => Value::Error(e),
        },
    }
}

/// `IFERROR(value, fallback)` — if value is Error, return fallback; otherwise value.
/// Two args required. Per the user's no-fallbacks rule: this is an EXPLICIT,
/// user-requested error-handling primitive (Excel canonical) — NOT a Quantbook fallback.
pub fn iferror(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    match &args[0] {
        Value::Error(_) => args[1].clone(),
        v => v.clone(),
    }
}

// ===== Math =====

/// `ABS(x)` — absolute value.
pub fn abs(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => Value::Number(n.abs()),
        NumericArg::Skip => Value::Number(0.0),
        NumericArg::Error(e) => Value::Error(e),
    }
}

/// `SQRT(x)` — square root; #NUM! for negative input.
pub fn sqrt(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => {
            if n < 0.0 {
                return Value::Error(ErrorValue::Num);
            }
            match coercion::sanitize_f64(n.sqrt()) {
                Ok(s) => Value::Number(s),
                Err(e) => Value::Error(e),
            }
        }
        NumericArg::Skip => Value::Number(0.0),
        NumericArg::Error(e) => Value::Error(e),
    }
}

/// `ROUND(x, n)` — round to n decimal places (banker's rounding via f64::round, which
/// rounds half away from zero; Excel's ROUND is also away-from-zero, so this matches).
pub fn round(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let n = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let multiplier = 10.0_f64.powf(n);
    let rounded = (x * multiplier).round() / multiplier;
    match coercion::sanitize_f64(rounded) {
        Ok(s) => Value::Number(s),
        Err(e) => Value::Error(e),
    }
}

/// `INT(x)` — round toward negative infinity (Excel's INT).
pub fn int(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => Value::Number(n.floor()),
        NumericArg::Skip => Value::Number(0.0),
        NumericArg::Error(e) => Value::Error(e),
    }
}

/// `MOD(x, divisor)` — remainder. Excel's MOD has a specific sign convention: result
/// takes sign of divisor (matches Python's `%`, NOT Rust's `%`). #DIV/0! on zero
/// divisor.
pub fn r#mod(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let d = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    if d == 0.0 {
        return Value::Error(ErrorValue::DivZero);
    }
    // Excel: MOD(x, d) = x - d * INT(x/d), result has sign of d.
    let result = x - d * (x / d).floor();
    Value::Number(result)
}

/// `POWER(base, exponent)` — same semantics as `Operator::Pow`.
pub fn power(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let base = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let exp = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    if base < 0.0 && exp.fract() != 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(base.powf(exp)) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn n(x: f64) -> Value {
        Value::Number(x)
    }

    // ===== sum =====

    #[test]
    fn sum_basic() {
        assert_eq!(sum(&[n(1.0), n(2.0), n(3.0)]), n(6.0));
    }

    #[test]
    fn sum_empty() {
        assert_eq!(sum(&[]), n(0.0));
    }

    #[test]
    fn sum_with_blanks() {
        assert_eq!(sum(&[n(1.0), Value::Blank, n(2.0)]), n(3.0));
    }

    #[test]
    fn sum_with_bool() {
        // true coerces to 1.0 — Excel: SUM(TRUE, 1) = 2.
        assert_eq!(sum(&[Value::Boolean(true), n(1.0)]), n(2.0));
    }

    #[test]
    fn sum_error_propagates() {
        assert_eq!(
            sum(&[n(1.0), Value::Error(ErrorValue::Ref), n(2.0)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn sum_text_yields_value_error() {
        assert_eq!(
            sum(&[n(1.0), Value::text("hi")]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== average =====

    #[test]
    fn average_basic() {
        assert_eq!(average(&[n(2.0), n(4.0), n(6.0)]), n(4.0));
    }

    #[test]
    fn average_empty_is_div_zero() {
        assert_eq!(average(&[]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn average_uses_welford_for_large_offset() {
        // Same numacc-style test: large mean, small variance, should be precise.
        let data: Vec<Value> = (0..10).map(|i| n(1.0e9 + i as f64)).collect();
        let result = average(&data);
        // Analytic mean = 1e9 + 4.5.
        let expected = 1.0e9 + 4.5;
        if let Value::Number(m) = result {
            assert!(
                (m - expected).abs() < 1e-6,
                "mean {m} vs expected {expected}"
            );
        } else {
            panic!("expected Number");
        }
    }

    // ===== count / counta =====

    #[test]
    fn count_only_numbers() {
        let args = [
            n(1.0),
            Value::Boolean(true),
            Value::text("hi"),
            Value::Blank,
            Value::Error(ErrorValue::Ref),
            n(2.0),
        ];
        assert_eq!(count(&args), n(2.0));
    }

    #[test]
    fn counta_counts_non_blank() {
        let args = [
            n(1.0),
            Value::Boolean(true),
            Value::text("hi"),
            Value::Blank,
            Value::Error(ErrorValue::Ref),
            n(2.0),
        ];
        // 5 non-blank items
        assert_eq!(counta(&args), n(5.0));
    }

    // ===== min / max =====

    #[test]
    fn min_basic() {
        assert_eq!(min(&[n(3.0), n(1.0), n(2.0)]), n(1.0));
    }

    #[test]
    fn min_empty_is_zero() {
        assert_eq!(min(&[]), n(0.0));
    }

    #[test]
    fn max_basic() {
        assert_eq!(max(&[n(3.0), n(1.0), n(5.0), n(2.0)]), n(5.0));
    }

    // ===== product =====

    #[test]
    fn product_basic() {
        assert_eq!(product(&[n(2.0), n(3.0), n(4.0)]), n(24.0));
    }

    #[test]
    fn product_empty_zero_per_excel() {
        assert_eq!(product(&[]), n(0.0));
    }

    // ===== var / stdev =====

    #[test]
    fn var_s_simple() {
        // [1, 3]: sample variance = 2.
        assert_eq!(var_s(&[n(1.0), n(3.0)]), n(2.0));
    }

    #[test]
    fn var_p_simple() {
        // [1, 3]: population variance = 1.
        assert_eq!(var_p(&[n(1.0), n(3.0)]), n(1.0));
    }

    #[test]
    fn stdev_s_simple() {
        // sqrt(2)
        if let Value::Number(s) = stdev_s(&[n(1.0), n(3.0)]) {
            assert!((s - 2.0_f64.sqrt()).abs() < 1e-15);
        } else {
            panic!();
        }
    }

    #[test]
    fn var_single_sample_div_zero() {
        // Sample variance with n=1 → #DIV/0!.
        assert_eq!(var_s(&[n(5.0)]), Value::Error(ErrorValue::DivZero));
    }

    // ===== logical =====

    #[test]
    fn if_basic() {
        assert_eq!(r#if(&[Value::Boolean(true), n(1.0), n(2.0)]), n(1.0));
        assert_eq!(r#if(&[Value::Boolean(false), n(1.0), n(2.0)]), n(2.0));
    }

    #[test]
    fn if_wrong_arity() {
        assert_eq!(r#if(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn and_all_true() {
        assert_eq!(
            and(&[Value::Boolean(true), Value::Boolean(true)]),
            Value::Boolean(true)
        );
    }

    #[test]
    fn and_one_false() {
        assert_eq!(
            and(&[Value::Boolean(true), Value::Boolean(false)]),
            Value::Boolean(false)
        );
    }

    #[test]
    fn and_empty_is_value_error() {
        assert_eq!(and(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn or_any_true() {
        assert_eq!(
            or(&[Value::Boolean(false), Value::Boolean(true)]),
            Value::Boolean(true)
        );
    }

    #[test]
    fn not_basic() {
        assert_eq!(not(&[Value::Boolean(true)]), Value::Boolean(false));
        assert_eq!(not(&[Value::Boolean(false)]), Value::Boolean(true));
    }

    #[test]
    fn iferror_replaces_error() {
        assert_eq!(iferror(&[Value::Error(ErrorValue::Ref), n(42.0)]), n(42.0));
        // Non-error passes through.
        assert_eq!(iferror(&[n(7.0), n(42.0)]), n(7.0));
    }

    // ===== math =====

    #[test]
    fn abs_basic() {
        assert_eq!(abs(&[n(-5.0)]), n(5.0));
        assert_eq!(abs(&[n(5.0)]), n(5.0));
        assert_eq!(abs(&[n(0.0)]), n(0.0));
    }

    #[test]
    fn sqrt_basic() {
        if let Value::Number(s) = sqrt(&[n(16.0)]) {
            assert!((s - 4.0).abs() < 1e-15);
        } else {
            panic!();
        }
    }

    #[test]
    fn sqrt_negative_is_num_error() {
        assert_eq!(sqrt(&[n(-1.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn round_basic() {
        // Use 3.276 (not pi-approximation) to avoid the clippy `approx_constant` lint.
        assert_eq!(round(&[n(3.276), n(2.0)]), n(3.28));
        assert_eq!(round(&[n(3.5), n(0.0)]), n(4.0));
        assert_eq!(round(&[n(-3.5), n(0.0)]), n(-4.0)); // away-from-zero
    }

    #[test]
    fn int_floors_negative_correctly() {
        // INT(-1.5) = -2, NOT -1 (Excel INT rounds toward -∞).
        assert_eq!(int(&[n(-1.5)]), n(-2.0));
        assert_eq!(int(&[n(1.5)]), n(1.0));
    }

    #[test]
    fn mod_basic() {
        // MOD(10, 3) = 1
        assert_eq!(r#mod(&[n(10.0), n(3.0)]), n(1.0));
        // MOD(-10, 3) = 2 (Excel: result takes sign of divisor)
        assert_eq!(r#mod(&[n(-10.0), n(3.0)]), n(2.0));
        // MOD(10, -3) = -2
        assert_eq!(r#mod(&[n(10.0), n(-3.0)]), n(-2.0));
    }

    #[test]
    fn mod_zero_divisor() {
        assert_eq!(r#mod(&[n(10.0), n(0.0)]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn power_basic() {
        assert_eq!(power(&[n(2.0), n(10.0)]), n(1024.0));
    }

    #[test]
    fn power_negative_fractional_is_num() {
        assert_eq!(power(&[n(-2.0), n(0.5)]), Value::Error(ErrorValue::Num));
    }

    // ===== arg-list typing edge cases =====

    #[test]
    fn arc_str_value_preserved_through_iferror() {
        let s = Value::Text(Arc::from("hello"));
        assert_eq!(iferror(&[s.clone(), n(0.0)]), s);
    }
}
