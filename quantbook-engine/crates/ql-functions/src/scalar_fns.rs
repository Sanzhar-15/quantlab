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

/// `ROUND(x, n)` — round to n decimal places using "round half away from zero" (the
/// Excel ROUND semantic). Implementation: `f64::round`. Audit D2 fix (2026-05-12):
/// previous doc called this "banker's rounding," which is the round-half-to-EVEN
/// rule — a different convention. Excel ROUND is away-from-zero, NOT banker's.
/// The implementation was correct all along; only the doc was wrong.
///
/// **Phase 2A.9 audit M4 — known limitation (general)**: the
/// `(x * 10^n).round() / 10^n` approach inherits f64's binary representation.
/// For inputs whose decimal value is not exactly representable in f64, the
/// result can disagree with Excel's decimal-aware ROUND. The specific case
/// the audit predicted (`ROUND(2.675, 2)`) actually matches Excel here via
/// double-rounding accident (multiplication produces `267.50000000000006`,
/// which `.round()` returns 268, giving 2.68). Other inputs may diverge.
/// Decimal-aware rounding requires either a decimal type or a format-string
/// round-trip; both are Phase 3+ work.
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

// ===== AI reservation (CORR-06 / T4-D05) =====

/// `AI(...)` — reserved Excel function name per CORR-06. Until Quantbook ships the AI
/// integration (v2 conditional), invocation returns `Error(ErrorValue::AINotAvailable)`
/// with the sigil `#AI_NOT_AVAILABLE_V1`. Args are ignored (Error propagation skipped on
/// purpose — even `=AI(BADREF)` returns AINotAvailable, not Ref, because the function
/// is not actually called).
///
/// Per the no-fallbacks rule's exception clause (CLAUDE.md "explicit, user-requested
/// error handling at system boundaries"): this is the canonical Quantbook sigil for
/// "AI feature not available," not a silent error swallow.
pub fn ai(_args: &[Value]) -> Value {
    Value::Error(ErrorValue::AINotAvailable)
}

// ===== Math (Phase 4.3 V1, W5-46, 2026-05-13) =====

/// Helper: read a single numeric arg or short-circuit with an error.
/// Used by single-arg math functions (EXP, LN, etc.). Blank coerces to 0
/// per Excel canon for numeric contexts (consistent with binary arithmetic).
fn one_number(args: &[Value], min_arity: usize, max_arity: usize) -> Result<f64, ErrorValue> {
    if args.len() < min_arity || args.len() > max_arity {
        return Err(ErrorValue::Value);
    }
    match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => Ok(n),
        NumericArg::Skip => Ok(0.0),
        NumericArg::Error(e) => Err(e),
    }
}

/// `ROUNDUP(number, digits)` — round AWAY from zero. Excel canon: a value
/// with absolute value less than `10^-digits` rounds up to the next multiple,
/// regardless of sign. `ROUNDUP(2.1, 0) = 3`; `ROUNDUP(-2.1, 0) = -3`.
pub fn roundup(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let value = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let digits = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n.trunc() as i32,
        NumericArg::Skip => 0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let factor = 10f64.powi(digits);
    let result = (value * factor).abs().ceil() * value.signum() / factor;
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ROUNDDOWN(number, digits)` — round TOWARD zero. Excel canon truncation
/// at the `digits` decimal place. `ROUNDDOWN(2.9, 0) = 2`;
/// `ROUNDDOWN(-2.9, 0) = -2`.
pub fn rounddown(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let value = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let digits = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n.trunc() as i32,
        NumericArg::Skip => 0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let factor = 10f64.powi(digits);
    let result = (value * factor).abs().floor() * value.signum() / factor;
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `TRUNC(number, [digits])` — truncate toward zero. Equivalent to
/// `ROUNDDOWN`, but the `digits` argument is optional (defaults to 0).
pub fn trunc(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let value = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let digits = if args.len() == 2 {
        match coerce_numeric(&args[1]) {
            NumericArg::Number(n) => n.trunc() as i32,
            NumericArg::Skip => 0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        0
    };
    let factor = 10f64.powi(digits);
    let result = (value * factor).trunc() / factor;
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `SIGN(number)` — returns `1` for positive, `-1` for negative, `0` for zero.
pub fn sign(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let result = if n > 0.0 {
        1.0
    } else if n < 0.0 {
        -1.0
    } else {
        0.0
    };
    Value::Number(result)
}

/// `EXP(number)` — `e^number`. `#NUM!` on overflow.
pub fn exp(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.exp()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `LN(number)` — natural log. Non-positive argument → `#NUM!`.
pub fn ln(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(n.ln()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `LOG(number, [base])` — logarithm with optional base (default 10).
/// Non-positive number or non-positive base or base == 1 → `#NUM!`.
pub fn log(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let value = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    if value <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let base = if args.len() == 2 {
        match coerce_numeric(&args[1]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        10.0
    };
    if base <= 0.0 || base == 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(value.log(base)) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `LOG10(number)` — base-10 logarithm.
pub fn log10(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n <= 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(n.log10()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `PI()` — π constant. No arguments.
pub fn pi(args: &[Value]) -> Value {
    if !args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    Value::Number(std::f64::consts::PI)
}

/// `DEGREES(radians)` — radians → degrees. Phase 3.10 audit M7
/// (2026-05-13): sanitize the output via `sanitize_f64` so an Inf
/// produced by `f64::to_degrees` on extreme inputs surfaces as
/// `#NUM!` rather than a silent non-finite Value::Number.
pub fn degrees(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.to_degrees()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `RADIANS(degrees)` — degrees → radians. Same sanitization
/// contract as DEGREES (Phase 3.10 audit M7).
pub fn radians(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.to_radians()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== Text (Phase 4.3 V1) =====

/// Helper: coerce a Value to its display string per Excel canon.
/// Numbers print as their f64 representation; Bool as TRUE/FALSE;
/// Text passes through; Blank as "" (empty string). Errors propagate.
fn coerce_text(v: &Value) -> Result<String, ErrorValue> {
    match v {
        Value::Error(e) => Err(*e),
        Value::Text(s) => Ok(s.as_ref().to_owned()),
        Value::Number(n) => Ok(format_number_for_text(*n)),
        Value::Boolean(b) => Ok(if *b { "TRUE" } else { "FALSE" }.to_owned()),
        Value::Blank => Ok(String::new()),
    }
}

/// Excel-canon number → text. Integers render without a trailing `.0`;
/// otherwise the default `f64` Display is good enough for V1. Phase 4.5
/// (number formats) replaces this with locale-aware formatting.
fn format_number_for_text(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// `LEN(text)` — character count of the text representation (UTF-8 chars).
/// Excel treats it as character count, not byte count.
pub fn len(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::Number(text.chars().count() as f64)
}

/// `UPPER(text)` — ASCII + Unicode uppercase. Excel's localization
/// (Turkish dotted/dotless I) lands Phase 4.9.
pub fn upper(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::text(text.to_uppercase())
}

/// `LOWER(text)` — ASCII + Unicode lowercase.
pub fn lower(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::text(text.to_lowercase())
}

/// `TRIM(text)` — strip leading/trailing whitespace AND collapse internal
/// runs of multiple spaces to a single space. Excel's canon collapses
/// only standard space (0x20) runs; we follow that.
pub fn trim(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let mut out = String::with_capacity(text.len());
    let mut prev_space = false;
    let trimmed = text.trim_matches(' ');
    for c in trimmed.chars() {
        if c == ' ' {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    Value::text(out)
}

// ===== Information (Phase 4.3 V1) =====

/// `ISNUMBER(value)` — TRUE iff value is a Number (not error, not text, etc.).
pub fn isnumber(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(matches!(args[0], Value::Number(_)))
}

/// `ISTEXT(value)` — TRUE iff value is Text. Blank → FALSE.
pub fn istext(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(matches!(args[0], Value::Text(_)))
}

/// `ISBLANK(value)` — TRUE iff value is Blank.
pub fn isblank(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(matches!(args[0], Value::Blank))
}

/// `ISLOGICAL(value)` — TRUE iff value is Bool.
pub fn islogical(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(matches!(args[0], Value::Boolean(_)))
}

/// `ISERROR(value)` — TRUE iff value is any error. Unlike Excel's ISERR
/// (which excludes #N/A), ISERROR catches all error variants.
pub fn iserror(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(matches!(args[0], Value::Error(_)))
}

/// `ISNA(value)` — TRUE iff value is specifically `#N/A`.
pub fn isna(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(matches!(args[0], Value::Error(ErrorValue::NA)))
}

/// `ISERR(value)` — TRUE iff value is any error EXCEPT `#N/A`.
pub fn iserr(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(match &args[0] {
        Value::Error(ErrorValue::NA) => false,
        Value::Error(_) => true,
        _ => false,
    })
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

    /// Phase 2A.9 audit M4 (turned out to be a false positive): the audit
    /// reasoning predicted that `ROUND(2.675, 2)` would return `2.67` here
    /// (binary repr → `2.6749999...` × 100 = `267.4999...` → .round() = 267 →
    /// 2.67), contradicting Excel's `2.68`. In practice the multiplication
    /// step's IEEE rounding goes the other way: f64 multiplication of
    /// `2.6749999999999998 × 100.0` yields `267.50000000000006` (verified by
    /// running the test below), so `.round()` returns 268 → 2.68 — matching
    /// Excel. ROUND is Excel-canon for this case via accidental
    /// double-rounding. The doc on `pub fn round` still calls out the
    /// general Phase 2 limitation for inputs where the multiplication path
    /// rounds differently (decimal-aware rounding remains Phase 3+).
    #[test]
    fn round_decimal_2_675_matches_excel_via_double_rounding() {
        // Excel: 2.68. f64 path also: 2.68 (multiplication rounding favors us
        // here). NOT a guarantee for all 2.5-suffix inputs.
        assert_eq!(round(&[n(2.675), n(2.0)]), n(2.68));
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

    // ===== AI reservation (CORR-06) =====

    #[test]
    fn ai_no_args_returns_not_available() {
        assert_eq!(ai(&[]), Value::Error(ErrorValue::AINotAvailable));
    }

    #[test]
    fn ai_with_args_still_returns_not_available() {
        // Args ignored — even arguments with errors don't propagate.
        let args = [Value::text("prompt"), Value::Error(ErrorValue::Ref)];
        assert_eq!(ai(&args), Value::Error(ErrorValue::AINotAvailable));
    }

    // ===== Phase 4.3 V1 (W5-46) — math + text + info =====

    fn t(s: &str) -> Value {
        Value::text(s)
    }

    // ROUNDUP

    #[test]
    fn roundup_positive_and_negative_round_away_from_zero() {
        assert_eq!(roundup(&[n(2.1), n(0.0)]), n(3.0));
        assert_eq!(roundup(&[n(-2.1), n(0.0)]), n(-3.0));
        assert_eq!(roundup(&[n(1.234), n(2.0)]), n(1.24));
        assert_eq!(roundup(&[n(1.5), n(-1.0)]), n(10.0));
    }

    #[test]
    fn roundup_zero_input_zero_output() {
        assert_eq!(roundup(&[n(0.0), n(2.0)]), n(0.0));
    }

    #[test]
    fn roundup_error_arg_propagates() {
        assert_eq!(
            roundup(&[Value::Error(ErrorValue::DivZero), n(0.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn roundup_wrong_arity_is_value_error() {
        assert_eq!(roundup(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(roundup(&[n(1.0)]), Value::Error(ErrorValue::Value));
    }

    // ROUNDDOWN

    #[test]
    fn rounddown_truncates_toward_zero() {
        assert_eq!(rounddown(&[n(2.9), n(0.0)]), n(2.0));
        assert_eq!(rounddown(&[n(-2.9), n(0.0)]), n(-2.0));
        assert_eq!(rounddown(&[n(1.999), n(2.0)]), n(1.99));
    }

    // TRUNC

    #[test]
    fn trunc_with_and_without_digits() {
        assert_eq!(trunc(&[n(2.9)]), n(2.0));
        assert_eq!(trunc(&[n(-2.9)]), n(-2.0));
        assert_eq!(trunc(&[n(1.999), n(2.0)]), n(1.99));
    }

    // SIGN

    #[test]
    fn sign_basic() {
        assert_eq!(sign(&[n(5.0)]), n(1.0));
        assert_eq!(sign(&[n(-5.0)]), n(-1.0));
        assert_eq!(sign(&[n(0.0)]), n(0.0));
    }

    // EXP / LN / LOG / LOG10

    #[test]
    fn exp_and_ln_round_trip() {
        // exp(ln(x)) ≈ x for positive x.
        match (ln(&[n(5.0)]), exp(&[n(1.6094379124341003)])) {
            (Value::Number(a), Value::Number(b)) => {
                assert!((b - 5.0).abs() < 1e-9);
                assert!((a - 1.6094379124341003).abs() < 1e-9);
            }
            _ => panic!("expected Number"),
        }
    }

    #[test]
    fn ln_non_positive_is_num_error() {
        assert_eq!(ln(&[n(0.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(ln(&[n(-1.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn log_default_base_is_ten() {
        match log(&[n(100.0)]) {
            Value::Number(n) => assert!((n - 2.0).abs() < 1e-9),
            _ => panic!("expected Number"),
        }
    }

    #[test]
    fn log_explicit_base() {
        match log(&[n(8.0), n(2.0)]) {
            Value::Number(n) => assert!((n - 3.0).abs() < 1e-9),
            _ => panic!("expected Number"),
        }
    }

    #[test]
    fn log_invalid_inputs() {
        assert_eq!(log(&[n(-1.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(log(&[n(10.0), n(1.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(log(&[n(10.0), n(0.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn log10_basic() {
        match log10(&[n(1000.0)]) {
            Value::Number(n) => assert!((n - 3.0).abs() < 1e-9),
            _ => panic!("expected Number"),
        }
    }

    // PI / DEGREES / RADIANS

    #[test]
    fn pi_constant() {
        assert_eq!(pi(&[]), Value::Number(std::f64::consts::PI));
    }

    #[test]
    fn pi_with_args_is_value_error() {
        assert_eq!(pi(&[n(1.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn degrees_and_radians_round_trip() {
        match degrees(&[Value::Number(std::f64::consts::PI)]) {
            Value::Number(n) => assert!((n - 180.0).abs() < 1e-9),
            _ => panic!("expected Number"),
        }
        match radians(&[n(180.0)]) {
            Value::Number(n) => assert!((n - std::f64::consts::PI).abs() < 1e-9),
            _ => panic!("expected Number"),
        }
    }

    // LEN / UPPER / LOWER / TRIM

    #[test]
    fn len_counts_chars_not_bytes() {
        assert_eq!(len(&[t("hello")]), n(5.0));
        assert_eq!(len(&[t("")]), n(0.0));
        // Multi-byte char: é is 1 char, 2 bytes in UTF-8.
        assert_eq!(len(&[t("café")]), n(4.0));
    }

    #[test]
    fn len_coerces_non_text_args() {
        assert_eq!(len(&[Value::Number(42.0)]), n(2.0));
        assert_eq!(len(&[Value::Boolean(true)]), n(4.0)); // "TRUE"
        assert_eq!(len(&[Value::Blank]), n(0.0));
    }

    #[test]
    fn upper_lower_basic() {
        assert_eq!(upper(&[t("Hello")]), t("HELLO"));
        assert_eq!(lower(&[t("Hello")]), t("hello"));
        assert_eq!(upper(&[t("café")]), t("CAFÉ"));
    }

    #[test]
    fn trim_collapses_internal_space_runs() {
        assert_eq!(trim(&[t("  hello   world  ")]), t("hello world"));
        assert_eq!(trim(&[t("abc")]), t("abc"));
        assert_eq!(trim(&[t("")]), t(""));
    }

    #[test]
    fn text_fns_propagate_errors() {
        for f in [&upper as &dyn Fn(&[Value]) -> Value, &lower, &trim, &len] {
            assert_eq!(
                f(&[Value::Error(ErrorValue::Ref)]),
                Value::Error(ErrorValue::Ref)
            );
        }
    }

    // Information

    #[test]
    fn isnumber_recognizes_numbers_only() {
        assert_eq!(isnumber(&[n(1.0)]), Value::Boolean(true));
        assert_eq!(isnumber(&[t("1")]), Value::Boolean(false));
        assert_eq!(isnumber(&[Value::Boolean(true)]), Value::Boolean(false));
        assert_eq!(isnumber(&[Value::Blank]), Value::Boolean(false));
        assert_eq!(
            isnumber(&[Value::Error(ErrorValue::Ref)]),
            Value::Boolean(false)
        );
    }

    #[test]
    fn istext_isblank_islogical() {
        assert_eq!(istext(&[t("x")]), Value::Boolean(true));
        assert_eq!(istext(&[n(1.0)]), Value::Boolean(false));
        assert_eq!(isblank(&[Value::Blank]), Value::Boolean(true));
        assert_eq!(isblank(&[t("")]), Value::Boolean(false));
        assert_eq!(islogical(&[Value::Boolean(false)]), Value::Boolean(true));
        assert_eq!(islogical(&[n(0.0)]), Value::Boolean(false));
    }

    #[test]
    fn iserror_catches_all_iserr_excludes_na() {
        let na = Value::Error(ErrorValue::NA);
        let div = Value::Error(ErrorValue::DivZero);
        assert_eq!(iserror(std::slice::from_ref(&na)), Value::Boolean(true));
        assert_eq!(iserror(std::slice::from_ref(&div)), Value::Boolean(true));
        assert_eq!(isna(std::slice::from_ref(&na)), Value::Boolean(true));
        assert_eq!(isna(std::slice::from_ref(&div)), Value::Boolean(false));
        assert_eq!(iserr(&[div]), Value::Boolean(true));
        assert_eq!(iserr(&[na]), Value::Boolean(false));
        assert_eq!(iserr(&[n(1.0)]), Value::Boolean(false));
    }

    // ===== Phase 3.10 audit closure (W5-48) — H5 (FN4-02 backfill) =====
    //
    // The original Phase 4.3 V1 batch tests had positive coverage but
    // were thin on arity / error / coercion per FN4-02. Codex deep-
    // audit flagged ROUNDDOWN/TRUNC/SIGN/EXP/LOG10/DEGREES/RADIANS/
    // UPPER/LOWER/TRIM. This block backfills those gates.

    #[test]
    fn h5_rounddown_arity_error_coercion() {
        assert_eq!(rounddown(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(rounddown(&[n(1.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            rounddown(&[Value::Error(ErrorValue::Ref), n(0.0)]),
            Value::Error(ErrorValue::Ref)
        );
        // Lenient text→number coercion via to_number_strict for now —
        // text that parses works, text that doesn't surfaces #VALUE!.
        assert_eq!(
            rounddown(&[Value::text("not-a-number"), n(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn h5_trunc_arity_error_coercion() {
        assert_eq!(trunc(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            trunc(&[n(1.0), n(2.0), n(3.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            trunc(&[Value::Error(ErrorValue::NA)]),
            Value::Error(ErrorValue::NA)
        );
        // Blank → 0 (Excel canon for numeric contexts).
        assert_eq!(trunc(&[Value::Blank]), n(0.0));
    }

    #[test]
    fn h5_sign_arity_error_coercion() {
        assert_eq!(sign(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(sign(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            sign(&[Value::Error(ErrorValue::Num)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(sign(&[Value::Blank]), n(0.0));
    }

    #[test]
    fn h5_exp_arity_error_overflow() {
        assert_eq!(exp(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(exp(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            exp(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
        // Overflow path: EXP(1000) ≈ Inf → sanitize → #NUM!.
        assert_eq!(exp(&[n(1000.0)]), Value::Error(ErrorValue::Num));
        // Underflow: EXP(-1000) ≈ 0 (finite). Return Number(0.0).
        assert_eq!(exp(&[n(-1000.0)]), n(0.0));
    }

    #[test]
    fn h5_log10_arity_error_coercion() {
        assert_eq!(log10(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(log10(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            log10(&[Value::Error(ErrorValue::Calc)]),
            Value::Error(ErrorValue::Calc)
        );
        // log10(1) = 0 — round-trip with our impl.
        assert_eq!(log10(&[n(1.0)]), n(0.0));
    }

    #[test]
    fn h5_degrees_radians_arity_error_overflow() {
        // Arity.
        assert_eq!(degrees(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(degrees(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(radians(&[]), Value::Error(ErrorValue::Value));
        // Error propagation.
        assert_eq!(
            degrees(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
        // M7 fix verification: extreme input → Inf → #NUM! (was a
        // silent non-finite Value::Number pre-W5-48).
        assert_eq!(degrees(&[n(f64::MAX)]), Value::Error(ErrorValue::Num));
        // Coercion: Blank → 0 → 0 degrees.
        assert_eq!(degrees(&[Value::Blank]), n(0.0));
    }

    #[test]
    fn h5_upper_lower_arity() {
        assert_eq!(upper(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(upper(&[t("a"), t("b")]), Value::Error(ErrorValue::Value));
        assert_eq!(lower(&[]), Value::Error(ErrorValue::Value));
        // German sharp-s known divergence: Rust to_uppercase("ß") =
        // "SS"; Excel UPPER("ß") = "ß". Phase 4.9 (localization)
        // closes; matrix already notes the divergence.
        assert_eq!(upper(&[t("ß")]), t("SS"));
    }

    #[test]
    fn h5_trim_arity_nbsp_preserved() {
        assert_eq!(trim(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(trim(&[t("a"), t("b")]), Value::Error(ErrorValue::Value));
        // Non-breaking space (U+00A0) is NOT collapsed by Excel TRIM;
        // only regular spaces (0x20). Our impl matches this contract.
        let nbsp = "\u{00A0}";
        let input = format!("{nbsp}hello{nbsp}");
        assert_eq!(trim(&[Value::text(input.clone())]), Value::text(input));
    }

    #[test]
    fn h5_len_known_unicode_divergence() {
        // LEN counts Unicode scalar values (`char`s), NOT UTF-16
        // code units like Excel. For a ZWJ emoji sequence (👨‍👩‍👧),
        // Rust scalars = 5 but Excel UTF-16 = 8. Matrix documents
        // this as a known divergence; this test pins our actual
        // behavior so a future change can't drift silently.
        let zwj_family = "👨\u{200D}👩\u{200D}👧";
        assert_eq!(len(&[Value::text(zwj_family)]), n(5.0));
    }

    #[test]
    fn is_fns_arity_check() {
        // Every IS* function rejects wrong arity with #VALUE!.
        for f in [
            &isnumber as &dyn Fn(&[Value]) -> Value,
            &istext,
            &isblank,
            &islogical,
            &iserror,
            &isna,
            &iserr,
        ] {
            assert_eq!(f(&[]), Value::Error(ErrorValue::Value));
            assert_eq!(
                f(&[Value::Number(1.0), Value::Number(2.0)]),
                Value::Error(ErrorValue::Value)
            );
        }
    }
}
