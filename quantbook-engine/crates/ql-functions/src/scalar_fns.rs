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

// W5-64 (Phase 4.4.A): the local `NumericArg` enum + `coerce_numeric` helper
// were promoted to `crate::range_aware_fns` as cross-module utilities (also
// used by `range_fns`). The shim there delegates to
// `ql_types::coercion::to_number_strict_skip_blank` (the central neutral API).
use crate::range_aware_fns::{coerce_numeric, NumericArg};

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

// ===== W5-165 (Phase 4.10.C) — `*A`-variant aggregates =====
//
// AVERAGEA / MAXA / MINA coerce more permissively than their base
// counterparts. Per Excel canon:
// - Number → as-is.
// - Boolean → 1.0 (TRUE) / 0.0 (FALSE).
// - Text → 0.0 (including empty string "").
// - Blank → SKIPPED (NOT counted for AVERAGEA's denominator).
// - Error → propagate.
//
// vs AVERAGE / MAX / MIN which skip text + bool entirely.

/// **W5-165 (Phase 4.10.C):** `*A`-variant coercion. See module-level
/// comment for the coercion canon. `Skip` is reserved for blanks.
enum AVariantArg {
    Number(f64),
    Skip,
    Error(ErrorValue),
}

fn coerce_a_variant(v: &Value) -> AVariantArg {
    match v {
        Value::Number(n) => AVariantArg::Number(*n),
        Value::Boolean(b) => AVariantArg::Number(if *b { 1.0 } else { 0.0 }),
        Value::Text(_) => AVariantArg::Number(0.0),
        Value::Blank => AVariantArg::Skip,
        Value::Error(e) => AVariantArg::Error(*e),
    }
}

/// **W5-165:** `AVERAGEA(args...)` — like `AVERAGE` but text counts
/// as 0 and bool counts as 0/1 in BOTH sum and denominator. Empty
/// input → `#DIV/0!`. Errors propagate.
pub fn averagea(args: &[Value]) -> Value {
    let mut total = 0.0_f64;
    let mut count: usize = 0;
    for v in args {
        match coerce_a_variant(v) {
            AVariantArg::Number(n) => {
                total += n;
                count += 1;
            }
            AVariantArg::Skip => {}
            AVariantArg::Error(e) => return Value::Error(e),
        }
    }
    if count == 0 {
        return Value::Error(ErrorValue::DivZero);
    }
    match coercion::sanitize_f64(total / count as f64) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-165:** `MAXA(args...)` — like `MAX` but text/bool participate
/// (per `*A` canon). Empty input → 0 (matches MAX canon).
pub fn maxa(args: &[Value]) -> Value {
    let mut acc: Option<f64> = None;
    for v in args {
        match coerce_a_variant(v) {
            AVariantArg::Number(n) => {
                acc = Some(acc.map_or(n, |a| a.max(n)));
            }
            AVariantArg::Skip => {}
            AVariantArg::Error(e) => return Value::Error(e),
        }
    }
    Value::Number(acc.unwrap_or(0.0))
}

/// **W5-165:** `MINA(args...)` — like `MIN` but text/bool participate.
/// Empty input → 0 (matches MIN canon).
pub fn mina(args: &[Value]) -> Value {
    let mut acc: Option<f64> = None;
    for v in args {
        match coerce_a_variant(v) {
            AVariantArg::Number(n) => {
                acc = Some(acc.map_or(n, |a| a.min(n)));
            }
            AVariantArg::Skip => {}
            AVariantArg::Error(e) => return Value::Error(e),
        }
    }
    Value::Number(acc.unwrap_or(0.0))
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

/// **W5-163 (Phase 4.10.A):** `IFNA(value, fallback)` — like `IFERROR`
/// but only catches `#N/A`. Other errors propagate. Variadic check:
/// exactly 2 args required.
pub fn ifna(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    match &args[0] {
        Value::Error(ErrorValue::NA) => args[1].clone(),
        v => v.clone(),
    }
}

/// **W5-163 (Phase 4.10.A):** `IFS(test1, value1, test2, value2, ...)`
/// — multi-condition selector. Returns `valueK` for the first true
/// `testK`. Excel canon:
/// - Variadic; ≥2 args.
/// - Errors in tests propagate (mirrors `IF`, contrasts with `SWITCH`
///   which propagates errors in caseK values too).
/// - No match → `#N/A`. Odd arg count → unpaired trailing arg is
///   silently discarded (no match found → still `#N/A`; matches
///   Excel canon, not a syntax error).
/// - Empty input → `#VALUE!`.
pub fn ifs(args: &[Value]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let mut i = 0;
    while i + 1 < args.len() {
        match &args[i] {
            Value::Error(e) => return Value::Error(*e),
            other => match coercion::to_logical(other) {
                Ok(true) => return args[i + 1].clone(),
                Ok(false) => {}
                Err(e) => return Value::Error(e),
            },
        }
        i += 2;
    }
    Value::Error(ErrorValue::NA)
}

/// **W5-163 (Phase 4.10.A):** `XOR(args...)` — variadic logical XOR;
/// true iff an odd number of args are true. Mirrors `AND` / `OR`
/// arg handling: skip blanks, coerce non-bool via `to_logical`,
/// propagate errors, require ≥1 non-blank → otherwise `#VALUE!`.
pub fn xor(args: &[Value]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let mut count: u64 = 0;
    let mut any_non_blank = false;
    for v in args {
        match v {
            Value::Error(e) => return Value::Error(*e),
            Value::Blank => {}
            other => {
                any_non_blank = true;
                match coercion::to_logical(other) {
                    Ok(true) => count += 1,
                    Ok(false) => {}
                    Err(e) => return Value::Error(e),
                }
            }
        }
    }
    if !any_non_blank {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(count % 2 == 1)
}

/// **W5-163 (Phase 4.10.A):** `SWITCH(expression, value1, result1,
/// value2, result2, ..., [default])` — value-matching selector.
///
/// Per Excel canon + Codex pre-review (verified against IronCalc
/// `compare_values` + `logical/switch.rs` + Microsoft docs):
/// - **Type-strict equality**: Number ≠ "1" (Number↔String never
///   match). NaN never matches NaN.
/// - **Errors in caseK values PROPAGATE** (NOT skipped — corrects
///   the v1 design-doc draft).
/// - Errors in `expression` propagate.
/// - Variadic ≥3 args (1 expression + at least 1 value+result pair).
/// - Even args after expression → no default → `#N/A` on no match.
/// - Odd args after expression → trailing unpaired arg is the
///   default.
pub fn switch(args: &[Value]) -> Value {
    if args.len() < 3 {
        return Value::Error(ErrorValue::Value);
    }
    let expr = &args[0];
    if let Value::Error(e) = expr {
        return Value::Error(*e);
    }
    let mut i = 1;
    while i + 1 < args.len() {
        let v = &args[i];
        // Codex HIGH-1: errors in caseK PROPAGATE before the no-match
        // → #N/A path runs.
        if let Value::Error(e) = v {
            return Value::Error(*e);
        }
        if values_match_strict(expr, v) {
            return args[i + 1].clone();
        }
        i += 2;
    }
    // i == args.len() - 1 → trailing unpaired arg is the default.
    if i < args.len() {
        return args[i].clone();
    }
    Value::Error(ErrorValue::NA)
}

/// **W5-163 (Phase 4.10.A):** type-strict equality used by `SWITCH`.
/// - Number == Number iff bitwise equal (NaN never matches anything).
/// - Boolean == Boolean iff exact.
/// - String == String iff case-INsensitive ASCII equal (matches
///   Excel canon; Unicode case-folding awaits the deferred UTF-16
///   work tracked in the matrix).
/// - Blank == Blank.
/// - Cross-type (Number↔String, Bool↔Number, Bool↔String, etc.) →
///   never matches.
/// - Error values handled upstream; this helper assumes both sides
///   are non-error.
fn values_match_strict(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.to_bits() == y.to_bits() && !x.is_nan(),
        (Value::Boolean(x), Value::Boolean(y)) => x == y,
        (Value::Text(x), Value::Text(y)) => x.eq_ignore_ascii_case(y),
        (Value::Blank, Value::Blank) => true,
        _ => false,
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

// ===== Trigonometry (Phase 4.3 V2, W5-51) =====
//
// Excel canon: SIN / COS / TAN / SINH / COSH / TANH take an angle in
// RADIANS. Use RADIANS(deg) if input is in degrees. ASIN / ACOS / ATAN /
// ATAN2 RETURN radians.
//
// Domain errors → #NUM!:
//   - ASIN(x), ACOS(x): |x| > 1
//   - ATAN2(0, 0): both args zero (per Excel; Rust f64::atan2 returns 0)
//   - SINH(x), COSH(x): very large |x| may overflow to ±Inf — sanitize
//     surfaces as #NUM!.
//
// TAN(pi/2) does NOT error in Excel — it returns a huge but finite
// float (≈1.6e16). The IEEE 754 result of `(π/2).tan()` is finite
// because π/2 cannot be exactly represented; sanitize_f64 lets it
// through. Matches IronCalc behavior.

/// `SIN(angle_in_radians)` — sine. Standard f64 sin.
pub fn sin(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.sin()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `COS(angle_in_radians)` — cosine. Standard f64 cos.
pub fn cos(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.cos()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `TAN(angle_in_radians)` — tangent. Excel does NOT error at
/// asymptotes; the IEEE 754 result of `(π/2).tan()` is finite (the
/// argument isn't exactly π/2 in floating point). `sanitize_f64`
/// surfaces a NaN or non-finite result as `#NUM!`.
pub fn tan(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.tan()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ASIN(value)` — arc sine. Returns radians in `[-π/2, π/2]`. Domain
/// `|value| > 1` → `#NUM!` (matches Excel; Rust returns NaN which
/// `sanitize_f64` would also surface as `#NUM!`, but we check
/// up-front for the canonical error message and to avoid relying on
/// NaN-propagation behavior).
pub fn asin(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if !(-1.0..=1.0).contains(&n) {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(n.asin()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ACOS(value)` — arc cosine. Returns radians in `[0, π]`. Domain
/// `|value| > 1` → `#NUM!`.
pub fn acos(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if !(-1.0..=1.0).contains(&n) {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(n.acos()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ATAN(value)` — arc tangent. Returns radians in `(-π/2, π/2)`.
/// Total domain: any real input.
pub fn atan(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.atan()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== Math completion (W5-57, Phase 4.3 V2) =====
//
// CEILING / FLOOR / MROUND / ODD / EVEN / QUOTIENT / GCD / LCM.
// All scalar. Excel rounding-canon sign rules:
// - CEILING / FLOOR / MROUND: if number > 0 and significance < 0,
//   return #NUM!. Same for the reverse (number < 0 with significance
//   > 0 is allowed but rounds TOWARD zero).
// - QUOTIENT: integer truncation toward zero (NOT floor); 0
//   denominator → #DIV/0!.
// - GCD / LCM: all args must be non-negative integers; mixed-sign or
//   non-integer → #NUM!.

/// `CEILING(number, [significance])` — round `number` UP (away from
/// zero) to the nearest multiple of `significance`. Default
/// significance = 1.
///
/// Sign rule (Excel canon): if `number > 0` and `significance < 0`,
/// returns `#NUM!`. `significance = 0` returns 0.
pub fn ceiling(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let number = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let significance = if args.len() == 2 {
        match coerce_numeric(&args[1]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        1.0
    };
    if significance == 0.0 {
        return Value::Number(0.0);
    }
    if number > 0.0 && significance < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64((number / significance).ceil() * significance) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `FLOOR(number, [significance])` — round `number` DOWN (toward
/// zero) to the nearest multiple of `significance`. Default
/// significance = 1.
///
/// Same sign rule as CEILING.
pub fn floor(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let number = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let significance = if args.len() == 2 {
        match coerce_numeric(&args[1]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        1.0
    };
    if significance == 0.0 {
        if number == 0.0 {
            return Value::Number(0.0);
        }
        // Non-zero / 0 → #DIV/0! per Excel FLOOR canon (vs CEILING
        // which returns 0 — yes, the two differ in this edge).
        return Value::Error(ErrorValue::DivZero);
    }
    if number > 0.0 && significance < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64((number / significance).floor() * significance) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `CEILING.MATH(number, [significance], [mode])` — round `number` UP
/// (toward +∞) to the nearest multiple of `significance`. Unlike
/// CEILING, uses **absolute** significance and has a `mode` flag for
/// negative numbers.
///
/// Excel canon:
/// - Default `significance` = 1; default `mode` = 0.
/// - `significance` is taken as `abs(significance)` — sign is ignored
///   (unlike CEILING which errors on number > 0 + significance < 0).
/// - Positive `number`: round toward +∞ (away from zero).
/// - Negative `number`:
///   - `mode = 0` (default): round toward +∞ (i.e. toward zero).
///   - `mode ≠ 0`: round toward -∞ (i.e. away from zero).
/// - `significance = 0` returns 0.
pub fn ceiling_math(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let number = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let significance = if args.len() >= 2 {
        match coerce_numeric(&args[1]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        1.0
    };
    let mode = if args.len() == 3 {
        match coerce_numeric(&args[2]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    if significance == 0.0 {
        return Value::Number(0.0);
    }
    let abs_sig = significance.abs();
    // Direction:
    //   - Positive number: always toward +∞ (.ceil()).
    //   - Negative + mode=0: toward +∞ (toward zero) — .ceil().
    //   - Negative + mode≠0: toward -∞ (away from zero) — .floor().
    let result = if number >= 0.0 || mode == 0.0 {
        (number / abs_sig).ceil() * abs_sig
    } else {
        (number / abs_sig).floor() * abs_sig
    };
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `FLOOR.MATH(number, [significance], [mode])` — round `number` DOWN
/// (toward -∞) to the nearest multiple of `significance`. Mirror of
/// CEILING.MATH with the opposite default direction.
///
/// Excel canon:
/// - Default `significance` = 1; default `mode` = 0.
/// - `significance` = `abs(significance)`.
/// - Positive `number`: round toward -∞ (toward zero).
/// - Negative `number`:
///   - `mode = 0` (default): round toward -∞ (away from zero).
///   - `mode ≠ 0`: round toward +∞ (toward zero).
/// - `significance = 0` returns `#DIV/0!` per Excel canon (FLOOR.MATH
///   diverges from CEILING.MATH here; matches Excel).
pub fn floor_math(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let number = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let significance = if args.len() >= 2 {
        match coerce_numeric(&args[1]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        1.0
    };
    let mode = if args.len() == 3 {
        match coerce_numeric(&args[2]) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    if significance == 0.0 {
        if number == 0.0 {
            return Value::Number(0.0);
        }
        return Value::Error(ErrorValue::DivZero);
    }
    let abs_sig = significance.abs();
    // Direction (mirror of CEILING.MATH):
    //   - Positive number: always toward -∞ (.floor()).
    //   - Negative + mode=0: toward -∞ (away from zero) — .floor().
    //   - Negative + mode≠0: toward +∞ (toward zero) — .ceil().
    let result = if number >= 0.0 || mode == 0.0 {
        (number / abs_sig).floor() * abs_sig
    } else {
        (number / abs_sig).ceil() * abs_sig
    };
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `MROUND(number, multiple)` — round `number` to the nearest
/// multiple of `multiple`. .5 rounds away from zero (Excel canon).
/// Sign rule: number and multiple must have the same sign; mixed →
/// `#NUM!`. **W5-60 fix:** `MROUND(0, 0) = 0`, but `MROUND(non-zero, 0) = #NUM!`
/// per Excel canon. The W5-57 ship returned 0 unconditionally for
/// `multiple = 0`, which is wrong; Sonnet mega-audit caught it.
pub fn mround(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let number = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let multiple = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    if multiple == 0.0 {
        // MROUND(0, 0) = 0 per Excel; MROUND(n, 0) for non-zero n = #NUM!.
        if number == 0.0 {
            return Value::Number(0.0);
        }
        return Value::Error(ErrorValue::Num);
    }
    if (number > 0.0 && multiple < 0.0) || (number < 0.0 && multiple > 0.0) {
        return Value::Error(ErrorValue::Num);
    }
    // Round-half-away-from-zero. `(x).round()` already does that
    // in Rust for non-negative; for negative the rounding goes the
    // other way. We use the formula `((x / m + 0.5*sign(x)).trunc()) * m`.
    let q = number / multiple;
    let rounded = if q >= 0.0 {
        (q + 0.5).floor()
    } else {
        (q - 0.5).ceil()
    };
    match coercion::sanitize_f64(rounded * multiple) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ODD(number)` — round AWAY from zero to the nearest odd integer.
/// ODD(0) = 1 per Excel canon.
pub fn odd(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n == 0.0 {
        return Value::Number(1.0);
    }
    // Round away from zero to the next integer of the right parity.
    let away = if n > 0.0 { n.ceil() } else { n.floor() };
    let away_i = away as i64;
    // If even, bump by ±1 to get to odd.
    let adjusted = if away_i % 2 == 0 {
        if n > 0.0 {
            away_i + 1
        } else {
            away_i - 1
        }
    } else {
        away_i
    };
    Value::Number(adjusted as f64)
}

/// `EVEN(number)` — round AWAY from zero to the nearest even
/// integer. EVEN(0) = 0.
pub fn even(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n == 0.0 {
        return Value::Number(0.0);
    }
    let away = if n > 0.0 { n.ceil() } else { n.floor() };
    let away_i = away as i64;
    let adjusted = if away_i % 2 != 0 {
        if n > 0.0 {
            away_i + 1
        } else {
            away_i - 1
        }
    } else {
        away_i
    };
    Value::Number(adjusted as f64)
}

/// `QUOTIENT(numerator, denominator)` — integer quotient, truncated
/// TOWARD ZERO (not floored). `denominator = 0` → `#DIV/0!`.
pub fn quotient(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let num = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let den = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    if den == 0.0 {
        return Value::Error(ErrorValue::DivZero);
    }
    Value::Number((num / den).trunc())
}

/// Helper for GCD / LCM: collect args as non-negative integers.
/// Variadic; rejects mixed signs, non-integers, errors.
fn collect_nonneg_integers(args: &[Value]) -> Result<Vec<u64>, ErrorValue> {
    if args.is_empty() {
        return Err(ErrorValue::Value);
    }
    let mut out = Vec::with_capacity(args.len());
    for a in args {
        let n = match coerce_numeric(a) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(e) => return Err(e),
        };
        if n < 0.0 {
            return Err(ErrorValue::Num);
        }
        let truncated = n.trunc();
        // Excel: GCD/LCM truncate to integer per docs (not error).
        // Bound for safety.
        if !truncated.is_finite() || truncated > (u64::MAX as f64) {
            return Err(ErrorValue::Num);
        }
        out.push(truncated as u64);
    }
    Ok(out)
}

fn gcd2(a: u64, b: u64) -> u64 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

/// `GCD(num1, num2, ...)` — greatest common divisor. Variadic.
/// All args must be non-negative; mixed sign / negative → `#NUM!`.
/// Excel: `GCD(0, 0, ..., 0) = 0`.
pub fn gcd(args: &[Value]) -> Value {
    let nums = match collect_nonneg_integers(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let mut g: u64 = 0;
    for n in nums {
        g = gcd2(g, n);
    }
    Value::Number(g as f64)
}

/// `LCM(num1, num2, ...)` — least common multiple. Variadic.
/// All args must be non-negative integers; mixed sign / negative →
/// `#NUM!`. LCM with any 0 returns 0.
pub fn lcm(args: &[Value]) -> Value {
    let nums = match collect_nonneg_integers(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // LCM identity is 1; but if any arg is 0, result is 0.
    if nums.contains(&0) {
        return Value::Number(0.0);
    }
    let mut result: u128 = 1;
    for n in nums {
        let n_u128 = n as u128;
        let g = gcd2(result as u64, n) as u128;
        // result = (result * n) / gcd. Use u128 to defer overflow.
        match result.checked_mul(n_u128 / g) {
            Some(v) => result = v,
            None => return Value::Error(ErrorValue::Num),
        }
    }
    if result > (u64::MAX as u128) || (result as f64) > f64::MAX {
        return Value::Error(ErrorValue::Num);
    }
    Value::Number(result as f64)
}

// ===== W5-166 (Phase 4.10.D) — combinatorics + sum-of-squares =====

/// Helper: coerce a single arg, truncate toward zero, require non-negative.
/// Returns the truncated `i64` value or an `ErrorValue` describing why.
fn coerce_nonneg_int(v: &Value) -> Result<i64, ErrorValue> {
    let n = match coerce_numeric(v) {
        NumericArg::Number(n) => n,
        // Blank → 0 (Excel canon for combinatoric args).
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Err(e),
    };
    let truncated = n.trunc();
    if truncated < 0.0 {
        return Err(ErrorValue::Num);
    }
    // Cap at i64 range; FACT/COMBIN overflow detection happens later.
    if truncated > i64::MAX as f64 {
        return Err(ErrorValue::Num);
    }
    Ok(truncated as i64)
}

/// **W5-166:** `FACT(n)` — factorial. Excel canon: truncate toward zero
/// (`FACT(2.9) = 2! = 2`), negative → #NUM!, n > 170 → #NUM! (f64
/// overflow at 170! ≈ 7.26e306; 171! exceeds f64::MAX).
pub fn fact(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_nonneg_int(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n > 170 {
        return Value::Error(ErrorValue::Num);
    }
    let mut result = 1.0_f64;
    for k in 2..=n {
        result *= k as f64;
    }
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166:** `FACTDOUBLE(n)` — double factorial: `n!! = n*(n-2)*(n-4)*...`.
/// Excel canon: `FACTDOUBLE(0) = 1`, `FACTDOUBLE(-1) = 1` (special case),
/// `n < -1` → #NUM!. Even and odd values are independently chained.
/// Truncate toward zero. Overflow → #NUM! via `sanitize_f64`.
pub fn factdouble(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let raw = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let n = raw.trunc() as i64;
    // Special cases: FACTDOUBLE(-1) = 1, FACTDOUBLE(0) = 1.
    if n == -1 || n == 0 {
        return Value::Number(1.0);
    }
    if n < -1 {
        return Value::Error(ErrorValue::Num);
    }
    let mut result = 1.0_f64;
    let mut k = n;
    while k > 1 {
        result *= k as f64;
        k -= 2;
    }
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166:** `COMBIN(n, k)` — combinations without repetition (the
/// binomial coefficient `C(n, k) = n! / (k!(n-k)!)`). Excel canon
/// (verified vs IronCalc `fn_combin`): truncate args toward zero,
/// require non-negative, `k > n` → #NUM!. Iterative product avoids
/// factorial overflow for large n.
pub fn combin(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_nonneg_int(&args[0]) {
        Ok(n) => n as f64,
        Err(e) => return Value::Error(e),
    };
    let k = match coerce_nonneg_int(&args[1]) {
        Ok(k) => k as f64,
        Err(e) => return Value::Error(e),
    };
    if k > n {
        return Value::Error(ErrorValue::Num);
    }
    // Iterative C(n,k) = product over i in 0..k of (n - i) / (i + 1).
    let mut result = 1.0_f64;
    let k_int = k as i64;
    for i in 0..k_int {
        result *= (n - i as f64) / (i as f64 + 1.0);
    }
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166:** `COMBINA(n, k)` — combinations WITH repetition:
/// `C(n + k - 1, k)`. Excel canon (verified vs IronCalc `fn_combina`):
/// `n = 0, k > 0` → #NUM! (degenerate). Other non-negative integer
/// args accepted; truncate toward zero.
pub fn combina(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_nonneg_int(&args[0]) {
        Ok(n) => n as f64,
        Err(e) => return Value::Error(e),
    };
    let k = match coerce_nonneg_int(&args[1]) {
        Ok(k) => k as f64,
        Err(e) => return Value::Error(e),
    };
    // Excel canon: n=0, k>0 → #NUM!. n=0, k=0 → 1.
    if n == 0.0 && k > 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let mut result = 1.0_f64;
    let k_int = k as i64;
    for i in 0..k_int {
        result *= (n + i as f64) / (i as f64 + 1.0);
    }
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166:** `PERMUT(n, k)` — permutations without repetition:
/// `P(n, k) = n! / (n - k)!`. Excel canon: truncate toward zero,
/// non-negative integers, `k > n` → #NUM!. Iterative product.
pub fn permut(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_nonneg_int(&args[0]) {
        Ok(n) => n as f64,
        Err(e) => return Value::Error(e),
    };
    let k = match coerce_nonneg_int(&args[1]) {
        Ok(k) => k as f64,
        Err(e) => return Value::Error(e),
    };
    if k > n {
        return Value::Error(ErrorValue::Num);
    }
    let mut result = 1.0_f64;
    let k_int = k as i64;
    for i in 0..k_int {
        result *= n - i as f64;
    }
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166:** `PERMUTATIONA(n, k)` — permutations WITH repetition:
/// `n^k`. Excel canon: truncate toward zero, non-negative integers.
/// `n = 0, k = 0` → 1 (mathematical convention); `n = 0, k > 0` →
/// 0; `n > 0, k = 0` → 1. Overflow → #NUM!.
pub fn permutationa(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_nonneg_int(&args[0]) {
        Ok(n) => n as f64,
        Err(e) => return Value::Error(e),
    };
    let k = match coerce_nonneg_int(&args[1]) {
        Ok(k) => k as f64,
        Err(e) => return Value::Error(e),
    };
    // 0^0 = 1 by mathematical convention; f64::powf already follows this.
    let result = n.powf(k);
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166:** `SUMSQ(args...)` — variadic sum of squares. ScalarFn
/// over scalar args; range args flatten through eval dispatch (same
/// as `SUM`). Per Excel canon: text + blank skipped, bool coerced
/// (TRUE=1, FALSE=0), errors propagate. Empty input → 0.
pub fn sumsq(args: &[Value]) -> Value {
    let mut total = 0.0_f64;
    for v in args {
        match coerce_numeric(v) {
            NumericArg::Number(n) => total += n * n,
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    match coercion::sanitize_f64(total) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== Hyperbolic trig (W5-57, Phase 4.3 V2) =====

/// `SINH(number)` — hyperbolic sine. Overflow → #NUM! via
/// `sanitize_f64`.
pub fn sinh(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.sinh()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `COSH(number)` — hyperbolic cosine. Overflow → #NUM!.
pub fn cosh(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.cosh()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `TANH(number)` — hyperbolic tangent. Saturates to ±1 for large
/// |n| (no overflow). Total domain.
pub fn tanh(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.tanh()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ASINH(number)` — inverse hyperbolic sine. Total real domain.
pub fn asinh(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    match coercion::sanitize_f64(n.asinh()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ACOSH(number)` — inverse hyperbolic cosine. Domain `n >= 1`;
/// out-of-domain → `#NUM!`.
pub fn acosh(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n < 1.0 {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(n.acosh()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ATANH(number)` — inverse hyperbolic tangent. Domain `|n| < 1`;
/// out-of-domain → `#NUM!`. (Excel canon: ATANH(±1) is undefined and
/// returns #NUM! rather than ±∞.)
pub fn atanh(args: &[Value]) -> Value {
    let n = match one_number(args, 1, 1) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if !(n > -1.0 && n < 1.0) {
        return Value::Error(ErrorValue::Num);
    }
    match coercion::sanitize_f64(n.atanh()) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `ATAN2(x_num, y_num)` — two-argument arc tangent. Returns
/// radians in `(-π, π]`. Excel takes the angle's x-coordinate FIRST,
/// then y — the inverse of Rust's `f64::atan2(y, x)`. Per IronCalc +
/// the W3C / OOXML reference, Quantbook takes `args[0]` as `x` and
/// `args[1]` as `y` and internally calls `y.atan2(x)`. Returns
/// `#DIV/0!` if both args are zero (Excel canon; Rust's
/// `f64::atan2(0.0, 0.0)` would silently return 0.0). The W5-52
/// audit closure fixed this docstring's title — it previously said
/// `ATAN2(y, x)`, inverting the labels.
pub fn atan2(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let x = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let y = match coerce_numeric(&args[1]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    if x == 0.0 && y == 0.0 {
        return Value::Error(ErrorValue::DivZero);
    }
    // Excel arg order is (x, y); Rust's f64::atan2 is (y, x).
    match coercion::sanitize_f64(y.atan2(x)) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== Text (Phase 4.3 V1) =====

/// Helper: coerce a Value to its display string per Excel canon.
/// Numbers print as their f64 representation; Bool as TRUE/FALSE;
/// Text passes through; Blank as "" (empty string). Errors propagate.
// W5-64 (Phase 4.4.A): the private `coerce_text` + `format_number_for_text`
// helpers were promoted to `ql_types::coercion::{to_text_for_arg,
// format_number_for_arg}`. Local aliases preserved here for callers within
// this module — keeps the diff readable. `coerce_text` shadows the central
// `to_text_for_arg` and gets the new NaN/Inf policy "for free" (raw NaN/Inf
// → #NUM!), which is byte-for-byte the W5-64 design contract.
use ql_types::coercion::to_text_for_arg as coerce_text;

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

/// `PROPER(text)` — title-case each "word". A word starts after any
/// non-letter character (Unicode). First letter of each word is
/// uppercased; all other letters lowercased. Digits and punctuation
/// pass through unchanged.
///
/// Excel canon: `PROPER("o'neill 123abc")` → `"O'Neill 123Abc"` (the
/// digit ends the word, so `a` becomes uppercase).
pub fn proper(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let mut out = String::with_capacity(text.len());
    let mut prev_is_letter = false;
    for c in text.chars() {
        if c.is_alphabetic() {
            if !prev_is_letter {
                out.extend(c.to_uppercase());
            } else {
                out.extend(c.to_lowercase());
            }
            prev_is_letter = true;
        } else {
            out.push(c);
            prev_is_letter = false;
        }
    }
    Value::text(out)
}

/// `CLEAN(text)` — strip all non-printable ASCII control characters
/// (code points 0x00–0x1F, inclusive) from `text`. Excel canon: removes
/// the "low" control range only; tab (0x09), LF (0x0A), CR (0x0D) etc.
/// are ALL stripped. Higher code points (≥ 0x20) and Unicode characters
/// pass through unchanged.
pub fn clean(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let out: String = text.chars().filter(|c| (*c as u32) >= 0x20).collect();
    Value::text(out)
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

// ===== Text functions wave 2 (W5-56, Phase 4.3 V2) =====
//
// LEFT / RIGHT / MID / FIND / SEARCH / SUBSTITUTE / REPLACE /
// CONCATENATE / REPT / EXACT. All scalar (`ScalarFn`). Excel uses
// 1-based character indices for FIND/SEARCH/MID/REPLACE.
//
// **Unicode caveat (same as LEN W5-46/48):** indexing/length is
// done in Unicode scalar values via `.chars()`, NOT in UTF-16 code
// units as Excel does. Matches for ASCII / BMP; diverges for emoji
// ZWJ sequences. Documented in `docs/compat/excel-matrix.md`;
// pinned to Phase 4.9.

// Integer-arg coercion for text-function position/length fields.
// **W5-67 closure (Codex mega-audit LOW 1):** the prior comment said "Text
// rejected as #VALUE!" — actually `to_int_arg` parses text leniently via
// `to_number_lenient` and only returns `#VALUE!` on parse FAILURE. See
// `ql_types::coercion::to_int_arg` for the canonical contract.
//
// W5-64 (Phase 4.4.A): private `coerce_int_arg` was promoted to
// `ql_types::coercion::to_int_arg`. Local alias retained for in-module
// callers (LEFT, RIGHT, MID, FIND, SEARCH, REPLACE, REPT, SUBSTITUTE).
use ql_types::coercion::to_int_arg as coerce_int_arg;

/// `LEFT(text, [num_chars])` — leftmost `num_chars` characters of
/// `text`. Default num_chars=1. Negative → #VALUE!. num_chars
/// greater than text length returns the whole text. Empty text
/// returns empty.
pub fn left(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let n = if args.len() == 2 {
        match coerce_int_arg(&args[1]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };
    if n < 0 {
        return Value::Error(ErrorValue::Value);
    }
    let out: String = text.chars().take(n as usize).collect();
    Value::text(out)
}

/// `RIGHT(text, [num_chars])` — rightmost `num_chars` characters.
/// Same caveats as LEFT.
pub fn right(args: &[Value]) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let n = if args.len() == 2 {
        match coerce_int_arg(&args[1]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };
    if n < 0 {
        return Value::Error(ErrorValue::Value);
    }
    let total = text.chars().count();
    let take_from = total.saturating_sub(n as usize);
    let out: String = text.chars().skip(take_from).collect();
    Value::text(out)
}

/// `MID(text, start_num, num_chars)` — substring starting at
/// `start_num` (1-based) of length `num_chars`. start_num < 1 →
/// #VALUE!; num_chars < 0 → #VALUE!. start_num past end → empty.
pub fn mid(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let start = match coerce_int_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let len = match coerce_int_arg(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if start < 1 || len < 0 {
        return Value::Error(ErrorValue::Value);
    }
    let skip = (start - 1) as usize;
    let take = len as usize;
    let out: String = text.chars().skip(skip).take(take).collect();
    Value::text(out)
}

/// `FIND(find_text, within_text, [start_num])` — 1-based position
/// of `find_text` inside `within_text`, starting search at
/// `start_num` (default 1). **Case-sensitive.** Not found → #VALUE!.
/// start_num < 1 or > length → #VALUE!. No wildcard support.
pub fn find(args: &[Value]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let hay = match coerce_text(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let start = if args.len() == 3 {
        match coerce_int_arg(&args[2]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };
    let total = hay.chars().count();
    if start < 1 || (start as usize) > total + 1 {
        return Value::Error(ErrorValue::Value);
    }
    let start_idx = (start - 1) as usize;
    // Collect chars to allow indexing by char position.
    let chars: Vec<char> = hay.chars().collect();
    let needle_chars: Vec<char> = needle.chars().collect();
    if needle_chars.is_empty() {
        // Empty needle matches at start_num per Excel canon.
        return Value::Number(start as f64);
    }
    let n_len = needle_chars.len();
    let h_len = chars.len();
    if start_idx + n_len > h_len {
        return Value::Error(ErrorValue::Value);
    }
    for i in start_idx..=(h_len - n_len) {
        if chars[i..i + n_len] == needle_chars[..] {
            return Value::Number((i + 1) as f64);
        }
    }
    Value::Error(ErrorValue::Value)
}

/// `SEARCH(find_text, within_text, [start_num])` — like FIND but
/// **case-insensitive**. **W5-61**: honors Excel's `?` (single char)
/// and `*` (zero or more chars) wildcards. Escape with `~` (`~?`,
/// `~*`, `~~`).
///
/// **W5-62 (Codex audit L1):** SEARCH unconditionally routes through
/// `WildcardPattern::search_in` regardless of whether the needle
/// contains wildcards. A wildcard-free needle compiles to a single
/// Literal part and behaves identically to a plain case-insensitive
/// substring search (matched byte-for-byte against the pre-W5-61
/// behavior in tests). Empty needle still short-circuits to
/// `Number(start)`.
pub fn search(args: &[Value]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let hay = match coerce_text(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let start = if args.len() == 3 {
        match coerce_int_arg(&args[2]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };
    let total = hay.chars().count();
    if start < 1 || (start as usize) > total + 1 {
        return Value::Error(ErrorValue::Value);
    }
    let start_idx = (start - 1) as usize;
    // Empty-needle edge case: Excel returns `start` directly.
    if needle.is_empty() {
        return Value::Number(start as f64);
    }
    // W5-61: SEARCH always routes through WildcardPattern. The
    // pattern compiler correctly handles escaped wildcards (`~?`,
    // `~*`, `~~`) AND no-wildcard inputs (which compile to a single
    // Literal part and behave identically to the pre-W5-61
    // case-insensitive substring search). Routing unconditionally
    // through this path also avoids the bug where `has_wildcards`
    // returned false for `~?` but the substring path would have
    // searched for the literal "~?" instead of the literal "?".
    let pat = crate::wildcard::WildcardPattern::compile(&needle);
    match pat.search_in(&hay, start_idx) {
        Some(i) => Value::Number((i + 1) as f64),
        None => Value::Error(ErrorValue::Value),
    }
}

/// `SUBSTITUTE(text, old_text, new_text, [instance_num])` —
/// replace `old_text` with `new_text` inside `text`. If
/// `instance_num` is omitted, replaces all occurrences; otherwise
/// replaces only the Nth (1-based) occurrence. Case-sensitive.
pub fn substitute(args: &[Value]) -> Value {
    if args.len() < 3 || args.len() > 4 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let old = match coerce_text(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let new_t = match coerce_text(&args[2]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    // Empty `old` is a no-op (Excel returns the text unchanged).
    if old.is_empty() {
        return Value::text(text);
    }
    let instance: Option<i64> = if args.len() == 4 {
        match coerce_int_arg(&args[3]) {
            Ok(n) if n >= 1 => Some(n),
            Ok(_) => return Value::Error(ErrorValue::Value),
            Err(e) => return Value::Error(e),
        }
    } else {
        None
    };
    match instance {
        None => {
            // Replace all.
            Value::text(text.replace(&old, &new_t))
        }
        Some(target) => {
            // Replace only the Nth occurrence.
            let mut out = String::with_capacity(text.len());
            let mut remainder = text.as_str();
            let mut count: i64 = 0;
            while let Some(idx) = remainder.find(&old) {
                count += 1;
                if count == target {
                    out.push_str(&remainder[..idx]);
                    out.push_str(&new_t);
                    out.push_str(&remainder[idx + old.len()..]);
                    return Value::text(out);
                }
                // Copy past this occurrence unchanged.
                out.push_str(&remainder[..idx + old.len()]);
                remainder = &remainder[idx + old.len()..];
            }
            // Target instance not found — return original text.
            out.push_str(remainder);
            Value::text(out)
        }
    }
}

/// `REPLACE(old_text, start_num, num_chars, new_text)` — replace
/// the `num_chars` characters starting at 1-based `start_num` in
/// `old_text` with `new_text`. Excel canon: start_num past end
/// appends; num_chars > remaining length truncates to end. start_num
/// < 1 or num_chars < 0 → #VALUE!.
pub fn replace_fn(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let start = match coerce_int_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let cnt = match coerce_int_arg(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let new_t = match coerce_text(&args[3]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    if start < 1 || cnt < 0 {
        return Value::Error(ErrorValue::Value);
    }
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let start_idx = (start - 1) as usize;
    let mut out = String::new();
    // Prefix: 0..min(start_idx, total).
    let prefix_end = start_idx.min(total);
    out.extend(chars[..prefix_end].iter());
    // Inserted text.
    out.push_str(&new_t);
    // Suffix: chars after the removed slice (start_idx + cnt).
    let suffix_start = (start_idx + cnt as usize).min(total);
    out.extend(chars[suffix_start..].iter());
    Value::text(out)
}

/// `CONCATENATE(text1, text2, ...)` — concatenate scalar text args.
/// Variadic; needs at least 1 arg. Errors propagate. Numbers coerce
/// to their text representation.
pub fn concatenate(args: &[Value]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let mut out = String::new();
    for a in args {
        match coerce_text(a) {
            Ok(s) => out.push_str(&s),
            Err(e) => return Value::Error(e),
        }
    }
    Value::text(out)
}

/// `REPT(text, num_times)` — repeat `text` `num_times` times.
/// num_times < 0 → #VALUE!. num_times = 0 → empty.
pub fn rept(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let n = match coerce_int_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if n < 0 {
        return Value::Error(ErrorValue::Value);
    }
    // Guard against pathological inputs.
    let target_len = text.len().saturating_mul(n as usize);
    if target_len > 32_767 {
        // Excel REPT length cap is 32,767 chars; clamp + return #VALUE!
        // matching the canonical limit.
        return Value::Error(ErrorValue::Value);
    }
    Value::text(text.repeat(n as usize))
}

/// `EXACT(text1, text2)` — case-sensitive equality. Returns TRUE/
/// FALSE. Numbers coerce to text first.
pub fn exact(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let a = match coerce_text(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let b = match coerce_text(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::Boolean(a == b)
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

// ===== W5-165 (Phase 4.10.C) — info scalar fillins =====

/// **W5-165:** `NA()` — returns `#N/A`. Arity 0. Non-zero args →
/// `#VALUE!` (matches Excel canon).
pub fn na(args: &[Value]) -> Value {
    if !args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    Value::Error(ErrorValue::NA)
}

/// **W5-165:** `ERROR.TYPE(value)` — returns the numeric error-type
/// code per Excel canon:
/// - `#NULL!` → 1
/// - `#DIV/0!` → 2
/// - `#VALUE!` → 3
/// - `#REF!` → 4
/// - `#NAME?` → 5
/// - `#NUM!` → 6
/// - `#N/A` → 7
///
/// Non-error value → `#N/A` (matches Excel canon; verified against
/// IronCalc).
///
/// Quantbook-specific sigils (`#SPILL!`, `#CALC!`, `#DISCONNECTED!`,
/// `#BINDING!`, `#TIMEOUT!`) are mapped to extension codes 8-12 since
/// Excel doesn't enumerate them; Excel's official table stops at 7.
pub fn error_type(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    match &args[0] {
        Value::Error(e) => {
            let code = match e {
                ErrorValue::Null => 1,
                ErrorValue::DivZero => 2,
                ErrorValue::Value => 3,
                ErrorValue::Ref => 4,
                ErrorValue::Name => 5,
                ErrorValue::Num => 6,
                ErrorValue::NA => 7,
                // Quantbook-specific sigils — Excel doesn't enumerate them.
                // Use 8+ codes for the engine's extension errors so a
                // formula like ERROR.TYPE(#TIMEOUT!) returns SOMETHING
                // distinguishable rather than collapsing to a plain
                // canonical code. Callers that care about Excel canon
                // strict should branch on the cell's value first.
                ErrorValue::Spill => 8,
                ErrorValue::Calc => 9,
                ErrorValue::Disconnected => 10,
                ErrorValue::Binding => 11,
                ErrorValue::Timeout => 12,
                // Any future variants default to 0; loud-fail vs
                // silent-mapping: the function still returns a number
                // so the formula doesn't break, but the unknown code
                // is observably distinct.
                #[allow(unreachable_patterns)]
                _ => 0,
            };
            Value::Number(code as f64)
        }
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **W5-165:** `TYPE(value)` — returns the numeric type code per
/// Excel canon: 1=Number, 2=Text, 4=Boolean, 16=Error. Excel's
/// 64=Array code is unreachable on this scalar path; range / array
/// shapes are flattened by the eval dispatch before reaching here.
/// Blank → 1 (Number) per Excel canon (blank coerces to 0).
pub fn type_of(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let code = match &args[0] {
        Value::Number(_) | Value::Blank => 1,
        Value::Text(_) => 2,
        Value::Boolean(_) => 4,
        Value::Error(_) => 16,
    };
    Value::Number(code as f64)
}

/// **W5-165:** `ISEVEN(n)` — TRUE iff `n` truncates to an even integer.
/// Non-numeric arg (text, blank-coerced-loose path) → `#VALUE!`.
/// Negative numbers truncate toward zero (Excel canon — `ISEVEN(-2.5)`
/// truncates to -2, even). Errors propagate.
pub fn iseven(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        // Blank → coerces to 0 → even.
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let truncated = n.trunc() as i64;
    Value::Boolean(truncated % 2 == 0)
}

/// **W5-165:** `ISODD(n)` — mirror of `ISEVEN`. Truncate toward zero
/// then check parity.
pub fn isodd(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let n = match coerce_numeric(&args[0]) {
        NumericArg::Number(n) => n,
        NumericArg::Skip => 0.0,
        NumericArg::Error(e) => return Value::Error(e),
    };
    let truncated = n.trunc() as i64;
    Value::Boolean(truncated % 2 != 0)
}

/// **W5-165:** `ISNONTEXT(value)` — TRUE unless the value is a Text.
/// Inverse of `ISTEXT`. Blank → TRUE (not text). Numbers / bools /
/// errors → TRUE.
pub fn isnontext(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    Value::Boolean(!matches!(args[0], Value::Text(_)))
}

/// **W5-165:** `N(value)` — coerce to number per Excel canon:
/// - Number → same.
/// - Blank → 0.
/// - Boolean → 1 (TRUE) / 0 (FALSE).
/// - Text → 0 (NOT `#VALUE!` — Excel canon; verified against
///   IronCalc).
/// - Error → propagate.
///
/// Date values are stored as Number in this engine (no separate
/// `Value::Date` variant); dates round-trip through Number → N is
/// identity for date serials.
pub fn n_value(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    match &args[0] {
        Value::Number(n) => Value::Number(*n),
        Value::Blank => Value::Number(0.0),
        Value::Boolean(true) => Value::Number(1.0),
        Value::Boolean(false) => Value::Number(0.0),
        Value::Text(_) => Value::Number(0.0),
        Value::Error(e) => Value::Error(*e),
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

    // ===== W5-163 (Phase 4.10.A) — Logical fillins =====

    // ----- IFNA -----

    #[test]
    fn ifna_replaces_na_with_fallback() {
        assert_eq!(ifna(&[Value::Error(ErrorValue::NA), n(7.0)]), n(7.0));
    }

    #[test]
    fn ifna_passes_non_na_value_through() {
        assert_eq!(ifna(&[n(42.0), n(7.0)]), n(42.0));
        assert_eq!(ifna(&[Value::text("ok"), n(7.0)]), Value::text("ok"));
    }

    #[test]
    fn ifna_propagates_non_na_errors() {
        // Unlike IFERROR, IFNA only catches #N/A. Other errors pass through.
        assert_eq!(
            ifna(&[Value::Error(ErrorValue::Ref), n(7.0)]),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            ifna(&[Value::Error(ErrorValue::Value), n(7.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            ifna(&[Value::Error(ErrorValue::DivZero), n(7.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn ifna_wrong_arity_returns_value_error() {
        assert_eq!(ifna(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(ifna(&[n(1.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            ifna(&[n(1.0), n(2.0), n(3.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ----- IFS -----

    #[test]
    fn ifs_returns_first_matching_value() {
        assert_eq!(
            ifs(&[
                Value::Boolean(false),
                n(1.0),
                Value::Boolean(true),
                n(2.0),
                Value::Boolean(true),
                n(3.0),
            ]),
            n(2.0)
        );
    }

    #[test]
    fn ifs_no_match_returns_na() {
        assert_eq!(
            ifs(&[Value::Boolean(false), n(1.0), Value::Boolean(false), n(2.0),]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn ifs_empty_args_is_value_error() {
        assert_eq!(ifs(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn ifs_odd_arg_count_silently_discards_trailing() {
        // 3 args: test1=false, value1=1, trailing test2=true (no paired value).
        // Excel canon: trailing unpaired arg is silently discarded; no match
        // among complete pairs → #N/A.
        assert_eq!(
            ifs(&[Value::Boolean(false), n(1.0), Value::Boolean(true),]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn ifs_propagates_test_errors() {
        // Error in test1 propagates immediately, even if a later test would match.
        assert_eq!(
            ifs(&[
                Value::Error(ErrorValue::Ref),
                n(1.0),
                Value::Boolean(true),
                n(2.0),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn ifs_coerces_numeric_test_via_to_logical() {
        // Non-zero number is truthy.
        assert_eq!(ifs(&[n(1.0), Value::text("yes")]), Value::text("yes"));
        // Zero is falsy → #N/A.
        assert_eq!(
            ifs(&[n(0.0), Value::text("yes")]),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- XOR -----

    #[test]
    fn xor_zero_trues_is_false() {
        assert_eq!(
            xor(&[Value::Boolean(false), Value::Boolean(false)]),
            Value::Boolean(false)
        );
    }

    #[test]
    fn xor_one_true_is_true() {
        assert_eq!(
            xor(&[Value::Boolean(true), Value::Boolean(false)]),
            Value::Boolean(true)
        );
    }

    #[test]
    fn xor_two_trues_is_false() {
        // Even count of true → false.
        assert_eq!(
            xor(&[Value::Boolean(true), Value::Boolean(true)]),
            Value::Boolean(false)
        );
    }

    #[test]
    fn xor_three_trues_is_true() {
        // Odd count of true → true.
        assert_eq!(
            xor(&[
                Value::Boolean(true),
                Value::Boolean(true),
                Value::Boolean(true),
            ]),
            Value::Boolean(true)
        );
    }

    #[test]
    fn xor_empty_args_is_value_error() {
        assert_eq!(xor(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn xor_all_blanks_is_value_error() {
        // Mirrors AND/OR canon: no non-blank arg → #VALUE!.
        assert_eq!(
            xor(&[Value::Blank, Value::Blank]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn xor_propagates_errors() {
        assert_eq!(
            xor(&[Value::Boolean(true), Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn xor_skips_blanks_and_coerces_numeric() {
        // 1 (truthy) + Blank (skipped) + 0 (falsy) → 1 true → odd → true.
        assert_eq!(xor(&[n(1.0), Value::Blank, n(0.0)]), Value::Boolean(true));
    }

    // ----- SWITCH -----

    #[test]
    fn switch_returns_first_matching_result() {
        assert_eq!(
            switch(&[
                n(2.0),
                n(1.0),
                Value::text("one"),
                n(2.0),
                Value::text("two")
            ]),
            Value::text("two")
        );
    }

    #[test]
    fn switch_no_match_no_default_is_na() {
        assert_eq!(
            switch(&[
                n(3.0),
                n(1.0),
                Value::text("one"),
                n(2.0),
                Value::text("two")
            ]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn switch_default_branch_when_no_match() {
        // Odd arg count after expression → trailing arg is the default.
        assert_eq!(
            switch(&[
                n(3.0),
                n(1.0),
                Value::text("one"),
                n(2.0),
                Value::text("two"),
                Value::text("other"),
            ]),
            Value::text("other")
        );
    }

    #[test]
    fn switch_type_strict_number_vs_string_never_matches() {
        // SWITCH(1, "1", "Text", 1, "Number") → "Number" (type-strict per Excel canon).
        assert_eq!(
            switch(&[
                n(1.0),
                Value::text("1"),
                Value::text("Text"),
                n(1.0),
                Value::text("Number"),
            ]),
            Value::text("Number")
        );
    }

    #[test]
    fn switch_case_insensitive_string_match() {
        assert_eq!(
            switch(&[
                Value::text("HELLO"),
                Value::text("hello"),
                Value::text("matched"),
            ]),
            Value::text("matched")
        );
    }

    #[test]
    fn switch_too_few_args_is_value_error() {
        assert_eq!(switch(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(switch(&[n(1.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(switch(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn switch_error_in_expression_propagates() {
        assert_eq!(
            switch(&[Value::Error(ErrorValue::Ref), n(1.0), Value::text("one"),]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn switch_error_in_case_value_propagates() {
        // Codex HIGH-1: errors in caseK PROPAGATE (verified vs IronCalc).
        // Pre-correction draft had "skip errors" — wrong.
        assert_eq!(
            switch(&[
                n(2.0),
                n(1.0),
                Value::text("one"),
                Value::Error(ErrorValue::Ref),
                Value::text("won't reach"),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn switch_nan_never_matches() {
        // NaN ≠ NaN per type-strict equality contract.
        let nan = Value::Number(f64::NAN);
        assert_eq!(
            switch(&[nan.clone(), nan.clone(), Value::text("matched")]),
            Value::Error(ErrorValue::NA)
        );
    }

    // ===== W5-165 (Phase 4.10.C) — `*A` variants + info scalars =====

    // ----- AVERAGEA -----

    #[test]
    fn averagea_counts_text_and_bool() {
        // [10, TRUE, "hi", FALSE] → (10 + 1 + 0 + 0) / 4 = 2.75.
        assert_eq!(
            averagea(&[
                n(10.0),
                Value::Boolean(true),
                Value::text("hi"),
                Value::Boolean(false)
            ]),
            n(2.75)
        );
    }

    #[test]
    fn averagea_skips_blanks() {
        // Blanks NOT counted in denominator.
        // [10, Blank, 20] → (10 + 20) / 2 = 15.
        assert_eq!(averagea(&[n(10.0), Value::Blank, n(20.0)]), n(15.0));
    }

    #[test]
    fn averagea_empty_is_div_zero() {
        assert_eq!(averagea(&[]), Value::Error(ErrorValue::DivZero));
        // All-blank also div_zero (every arg skipped).
        assert_eq!(
            averagea(&[Value::Blank, Value::Blank]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn averagea_propagates_errors() {
        assert_eq!(
            averagea(&[n(10.0), Value::Error(ErrorValue::Num)]),
            Value::Error(ErrorValue::Num)
        );
    }

    // ----- MAXA -----

    #[test]
    fn maxa_text_counts_as_zero() {
        // [-5, "hi"] → max(-5, 0) = 0. (Diverges from MAX, which would skip "hi".)
        assert_eq!(maxa(&[n(-5.0), Value::text("hi")]), n(0.0));
    }

    #[test]
    fn maxa_true_is_one() {
        // [0.5, TRUE] → max(0.5, 1) = 1.
        assert_eq!(maxa(&[n(0.5), Value::Boolean(true)]), n(1.0));
    }

    #[test]
    fn maxa_empty_is_zero() {
        assert_eq!(maxa(&[]), n(0.0));
    }

    // ----- MINA -----

    #[test]
    fn mina_text_counts_as_zero() {
        // [5, "hi"] → min(5, 0) = 0.
        assert_eq!(mina(&[n(5.0), Value::text("hi")]), n(0.0));
    }

    #[test]
    fn mina_false_is_zero() {
        // [5, FALSE] → min(5, 0) = 0.
        assert_eq!(mina(&[n(5.0), Value::Boolean(false)]), n(0.0));
    }

    #[test]
    fn mina_empty_is_zero() {
        assert_eq!(mina(&[]), n(0.0));
    }

    // ----- NA -----

    #[test]
    fn na_returns_na_with_no_args() {
        assert_eq!(na(&[]), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn na_with_args_is_value_error() {
        assert_eq!(na(&[n(1.0)]), Value::Error(ErrorValue::Value));
    }

    // ----- ERROR.TYPE -----

    #[test]
    fn error_type_canonical_codes() {
        assert_eq!(error_type(&[Value::Error(ErrorValue::Null)]), n(1.0));
        assert_eq!(error_type(&[Value::Error(ErrorValue::DivZero)]), n(2.0));
        assert_eq!(error_type(&[Value::Error(ErrorValue::Value)]), n(3.0));
        assert_eq!(error_type(&[Value::Error(ErrorValue::Ref)]), n(4.0));
        assert_eq!(error_type(&[Value::Error(ErrorValue::Name)]), n(5.0));
        assert_eq!(error_type(&[Value::Error(ErrorValue::Num)]), n(6.0));
        assert_eq!(error_type(&[Value::Error(ErrorValue::NA)]), n(7.0));
    }

    #[test]
    fn error_type_non_error_returns_na() {
        // Per Excel canon: ERROR.TYPE on a non-error value returns #N/A.
        assert_eq!(error_type(&[n(42.0)]), Value::Error(ErrorValue::NA));
        assert_eq!(
            error_type(&[Value::text("hello")]),
            Value::Error(ErrorValue::NA)
        );
        assert_eq!(error_type(&[Value::Blank]), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn error_type_wrong_arity_is_value_error() {
        assert_eq!(error_type(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            error_type(&[Value::Error(ErrorValue::Ref), n(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ----- TYPE -----

    #[test]
    fn type_of_codes() {
        assert_eq!(type_of(&[n(42.0)]), n(1.0));
        assert_eq!(type_of(&[Value::Blank]), n(1.0)); // Blank → 1 (coerces to 0/Number)
        assert_eq!(type_of(&[Value::text("hi")]), n(2.0));
        assert_eq!(type_of(&[Value::Boolean(true)]), n(4.0));
        assert_eq!(type_of(&[Value::Error(ErrorValue::Ref)]), n(16.0));
    }

    // ----- ISEVEN / ISODD -----

    #[test]
    fn iseven_basic() {
        assert_eq!(iseven(&[n(2.0)]), Value::Boolean(true));
        assert_eq!(iseven(&[n(3.0)]), Value::Boolean(false));
        assert_eq!(iseven(&[n(0.0)]), Value::Boolean(true));
        // Truncate toward zero.
        assert_eq!(iseven(&[n(2.9)]), Value::Boolean(true));
        assert_eq!(iseven(&[n(-2.5)]), Value::Boolean(true));
    }

    #[test]
    fn iseven_text_is_value_error() {
        assert_eq!(
            iseven(&[Value::text("abc")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn iseven_blank_is_true() {
        // Blank → 0 → even.
        assert_eq!(iseven(&[Value::Blank]), Value::Boolean(true));
    }

    #[test]
    fn isodd_basic() {
        assert_eq!(isodd(&[n(1.0)]), Value::Boolean(true));
        assert_eq!(isodd(&[n(2.0)]), Value::Boolean(false));
        assert_eq!(isodd(&[n(-3.5)]), Value::Boolean(true)); // trunc → -3
    }

    // ----- ISNONTEXT -----

    #[test]
    fn isnontext_basic() {
        assert_eq!(isnontext(&[Value::text("hi")]), Value::Boolean(false));
        assert_eq!(isnontext(&[n(1.0)]), Value::Boolean(true));
        assert_eq!(isnontext(&[Value::Boolean(true)]), Value::Boolean(true));
        assert_eq!(isnontext(&[Value::Blank]), Value::Boolean(true));
        assert_eq!(
            isnontext(&[Value::Error(ErrorValue::Ref)]),
            Value::Boolean(true)
        );
    }

    // ----- N -----

    #[test]
    fn n_value_coerces() {
        assert_eq!(n_value(&[n(42.0)]), n(42.0));
        assert_eq!(n_value(&[Value::Blank]), n(0.0));
        assert_eq!(n_value(&[Value::Boolean(true)]), n(1.0));
        assert_eq!(n_value(&[Value::Boolean(false)]), n(0.0));
        // Excel canon: text → 0 (NOT #VALUE!).
        assert_eq!(n_value(&[Value::text("hello")]), n(0.0));
    }

    #[test]
    fn n_value_propagates_errors() {
        assert_eq!(
            n_value(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
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

    // ===== W5-51 (Phase 4.3 V2): trigonometry tests =====

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn sin_cos_tan_basic_values() {
        // sin(0) = 0, cos(0) = 1, tan(0) = 0
        match sin(&[n(0.0)]) {
            Value::Number(v) => assert!(approx(v, 0.0)),
            _ => panic!(),
        }
        match cos(&[n(0.0)]) {
            Value::Number(v) => assert!(approx(v, 1.0)),
            _ => panic!(),
        }
        match tan(&[n(0.0)]) {
            Value::Number(v) => assert!(approx(v, 0.0)),
            _ => panic!(),
        }

        // sin(π/2) ≈ 1, cos(π/2) ≈ 0
        let half_pi = std::f64::consts::FRAC_PI_2;
        match sin(&[n(half_pi)]) {
            Value::Number(v) => assert!(approx(v, 1.0)),
            _ => panic!(),
        }
        match cos(&[n(half_pi)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }

        // sin(π) ≈ 0, cos(π) ≈ -1
        match sin(&[n(std::f64::consts::PI)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }
        match cos(&[n(std::f64::consts::PI)]) {
            Value::Number(v) => assert!(approx(v, -1.0)),
            _ => panic!(),
        }
    }

    #[test]
    fn tan_at_quarter_pi_is_one() {
        // tan(π/4) = 1.
        let quarter_pi = std::f64::consts::FRAC_PI_4;
        match tan(&[n(quarter_pi)]) {
            Value::Number(v) => assert!(approx(v, 1.0)),
            _ => panic!(),
        }
    }

    #[test]
    fn tan_near_half_pi_is_huge_finite_not_error() {
        // Excel canon: TAN(PI()/2) returns a huge but finite number,
        // not an error. The IEEE 754 result of (π/2).tan() is finite
        // because π/2 cannot be exactly represented in f64.
        let half_pi = std::f64::consts::FRAC_PI_2;
        match tan(&[n(half_pi)]) {
            Value::Number(v) => {
                assert!(v.is_finite(), "tan(π/2) must be finite, got {v}");
                assert!(v.abs() > 1e10, "tan(π/2) should be huge, got {v}");
            }
            other => panic!("expected huge finite Number, got {other:?}"),
        }
    }

    #[test]
    fn asin_acos_atan_basic_inverses() {
        // asin(0) = 0, asin(1) = π/2
        match asin(&[n(0.0)]) {
            Value::Number(v) => assert!(approx(v, 0.0)),
            _ => panic!(),
        }
        match asin(&[n(1.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_2)),
            _ => panic!(),
        }
        // acos(1) = 0, acos(0) = π/2, acos(-1) = π
        match acos(&[n(1.0)]) {
            Value::Number(v) => assert!(approx(v, 0.0)),
            _ => panic!(),
        }
        match acos(&[n(0.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_2)),
            _ => panic!(),
        }
        match acos(&[n(-1.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::PI)),
            _ => panic!(),
        }
        // atan(1) = π/4
        match atan(&[n(1.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_4)),
            _ => panic!(),
        }
    }

    #[test]
    fn asin_acos_domain_errors() {
        // |x| > 1 → #NUM!
        assert_eq!(asin(&[n(1.5)]), Value::Error(ErrorValue::Num));
        assert_eq!(asin(&[n(-2.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(acos(&[n(1.5)]), Value::Error(ErrorValue::Num));
        assert_eq!(acos(&[n(-2.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn asin_acos_boundary_values_ok() {
        // |x| == 1 is in domain.
        assert!(matches!(asin(&[n(1.0)]), Value::Number(_)));
        assert!(matches!(asin(&[n(-1.0)]), Value::Number(_)));
        assert!(matches!(acos(&[n(1.0)]), Value::Number(_)));
        assert!(matches!(acos(&[n(-1.0)]), Value::Number(_)));
    }

    #[test]
    fn atan_extreme_inputs_converge() {
        // atan saturates at ±π/2.
        match atan(&[n(1e100)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_2)),
            _ => panic!(),
        }
        match atan(&[n(-1e100)]) {
            Value::Number(v) => assert!(approx(v, -std::f64::consts::FRAC_PI_2)),
            _ => panic!(),
        }
    }

    #[test]
    fn atan2_basic_quadrants() {
        // Excel arg order: ATAN2(x, y). Internally we call y.atan2(x).
        // atan2(1, 0) → angle pointing along +x → 0
        match atan2(&[n(1.0), n(0.0)]) {
            Value::Number(v) => assert!(approx(v, 0.0)),
            _ => panic!(),
        }
        // atan2(0, 1) → angle pointing along +y → π/2
        match atan2(&[n(0.0), n(1.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_2)),
            _ => panic!(),
        }
        // atan2(-1, 0) → π (along -x)
        match atan2(&[n(-1.0), n(0.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::PI)),
            _ => panic!(),
        }
        // atan2(1, 1) → π/4
        match atan2(&[n(1.0), n(1.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_4)),
            _ => panic!(),
        }
    }

    #[test]
    fn atan2_zero_zero_is_div_zero() {
        // Excel canon: ATAN2(0, 0) → #DIV/0!. Rust's f64::atan2(0,0)
        // would return 0.0; we check up-front.
        assert_eq!(atan2(&[n(0.0), n(0.0)]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn trig_arity_errors() {
        // 0 args or 2+ args → #VALUE! for the single-arg fns.
        let single_arg: [fn(&[Value]) -> Value; 6] = [sin, cos, tan, asin, acos, atan];
        for f in single_arg.iter() {
            assert_eq!(f(&[]), Value::Error(ErrorValue::Value));
            assert_eq!(f(&[n(0.0), n(1.0)]), Value::Error(ErrorValue::Value));
        }
        // ATAN2: 0, 1, or 3+ args → #VALUE!.
        assert_eq!(atan2(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(atan2(&[n(1.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            atan2(&[n(1.0), n(1.0), n(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn trig_error_propagation() {
        // Any Error arg → that error.
        let err = Value::Error(ErrorValue::DivZero);
        let single_arg: [fn(&[Value]) -> Value; 6] = [sin, cos, tan, asin, acos, atan];
        for f in single_arg.iter() {
            assert_eq!(
                f(std::slice::from_ref(&err)),
                Value::Error(ErrorValue::DivZero)
            );
        }
        assert_eq!(
            atan2(&[err.clone(), n(1.0)]),
            Value::Error(ErrorValue::DivZero)
        );
        assert_eq!(atan2(&[n(1.0), err]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn trig_text_arg_is_value_error() {
        // Module canon (line 17): Text → #VALUE! for numeric-context
        // aggregates and math fns. `coerce_numeric` runs Text through
        // `to_number_strict` which rejects it. Matches SIN/COS/TAN
        // behavior in Excel for non-numeric text.
        let bad = Value::Text(std::sync::Arc::from("hello"));
        assert_eq!(
            sin(std::slice::from_ref(&bad)),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            cos(std::slice::from_ref(&bad)),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(atan2(&[bad, n(1.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn trig_blank_coerces_to_zero() {
        // Blank → 0 per the existing one_number / coerce_numeric convention.
        match sin(&[Value::Blank]) {
            Value::Number(v) => assert!(approx(v, 0.0)),
            _ => panic!(),
        }
        match cos(&[Value::Blank]) {
            Value::Number(v) => assert!(approx(v, 1.0)),
            _ => panic!(),
        }
    }

    // ===== W5-53 (audit gap closure): trig edge cases =====

    #[test]
    fn trig_non_finite_input_is_num_error_at_coercion() {
        // `to_number_strict` (`ql_types::coercion`) rejects NaN/Inf at
        // INPUT — Value::Number(±Inf) and Value::Number(NaN) never reach
        // the trig fn body. So EVERY trig fn returns #NUM! on these
        // inputs uniformly. Even atan, whose math IS well-defined for
        // ±Inf (→ ±π/2), can't see the value because coercion gates it.
        let trig_fns: [fn(&[Value]) -> Value; 6] = [sin, cos, tan, asin, acos, atan];
        for f in trig_fns.iter() {
            assert_eq!(f(&[n(f64::INFINITY)]), Value::Error(ErrorValue::Num));
            assert_eq!(f(&[n(f64::NEG_INFINITY)]), Value::Error(ErrorValue::Num));
            assert_eq!(f(&[n(f64::NAN)]), Value::Error(ErrorValue::Num));
        }
        assert_eq!(
            atan2(&[n(f64::INFINITY), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(atan2(&[n(1.0), n(f64::NAN)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn atan2_blank_args_treated_as_zero() {
        // Blank coerces to 0 per scalar_fns convention. ATAN2(blank, 1) =
        // ATAN2(0, 1) = π/2 (along +y axis).
        match atan2(&[Value::Blank, n(1.0)]) {
            Value::Number(v) => assert!(approx(v, std::f64::consts::FRAC_PI_2)),
            other => panic!("expected π/2, got {other:?}"),
        }
        // ATAN2(blank, blank) — both coerce to 0 → #DIV/0! per the
        // explicit (0, 0) check.
        assert_eq!(
            atan2(&[Value::Blank, Value::Blank]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    // ===== W5-56: text functions wave 2 =====

    fn vt(s: &str) -> Value {
        Value::Text(std::sync::Arc::from(s))
    }

    #[test]
    fn left_default_and_explicit_count() {
        assert_eq!(left(&[vt("hello")]), vt("h"));
        assert_eq!(left(&[vt("hello"), n(3.0)]), vt("hel"));
        assert_eq!(left(&[vt("hello"), n(0.0)]), vt(""));
        // num_chars > len: returns whole string.
        assert_eq!(left(&[vt("hi"), n(99.0)]), vt("hi"));
    }

    #[test]
    fn left_negative_count_is_value_error() {
        assert_eq!(left(&[vt("hi"), n(-1.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn left_empty_text() {
        assert_eq!(left(&[vt(""), n(3.0)]), vt(""));
    }

    #[test]
    fn left_arity_errors() {
        assert_eq!(left(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            left(&[vt("a"), n(1.0), n(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn right_default_and_explicit() {
        assert_eq!(right(&[vt("hello")]), vt("o"));
        assert_eq!(right(&[vt("hello"), n(3.0)]), vt("llo"));
        assert_eq!(right(&[vt("hello"), n(0.0)]), vt(""));
        assert_eq!(right(&[vt("hi"), n(99.0)]), vt("hi"));
    }

    #[test]
    fn mid_basic() {
        // MID("hello", 2, 3) → "ell" (1-based start).
        assert_eq!(mid(&[vt("hello"), n(2.0), n(3.0)]), vt("ell"));
        // Start past end → empty.
        assert_eq!(mid(&[vt("hi"), n(10.0), n(3.0)]), vt(""));
        // Length 0 → empty.
        assert_eq!(mid(&[vt("hi"), n(1.0), n(0.0)]), vt(""));
    }

    #[test]
    fn mid_start_below_one_is_value_error() {
        assert_eq!(
            mid(&[vt("hi"), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            mid(&[vt("hi"), n(-1.0), n(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn find_case_sensitive() {
        // FIND("ll", "hello") → 3.
        assert_eq!(find(&[vt("ll"), vt("hello")]), n(3.0));
        // Case sensitive: not found.
        assert_eq!(
            find(&[vt("LL"), vt("hello")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn find_with_start_num() {
        // "to_loop" positions (1-based): t=1 o=2 _=3 l=4 o=5 o=6 p=7.
        // FIND("o", "to_loop", 4) — start at position 4 → finds at 5.
        assert_eq!(find(&[vt("o"), vt("to_loop"), n(4.0)]), n(5.0));
        // Start at 6 → finds at 6.
        assert_eq!(find(&[vt("o"), vt("to_loop"), n(6.0)]), n(6.0));
        // Start at 7 → no more 'o' → #VALUE!.
        assert_eq!(
            find(&[vt("o"), vt("to_loop"), n(7.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn find_empty_needle_matches_start() {
        assert_eq!(find(&[vt(""), vt("hello")]), n(1.0));
        assert_eq!(find(&[vt(""), vt("hello"), n(3.0)]), n(3.0));
    }

    #[test]
    fn find_not_found_is_value_error() {
        assert_eq!(
            find(&[vt("x"), vt("hello")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn search_case_insensitive() {
        assert_eq!(search(&[vt("LL"), vt("hello")]), n(3.0));
        assert_eq!(search(&[vt("Hello"), vt("HELLO")]), n(1.0));
    }

    #[test]
    fn search_not_found() {
        assert_eq!(
            search(&[vt("zzz"), vt("hello")]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== W5-61 SEARCH wildcards =====

    #[test]
    fn search_wildcard_star_finds_substring() {
        // "foo*" matches anything starting with "foo".
        // In "abcfoobar", the match starts at position 4 (1-based).
        assert_eq!(search(&[vt("foo*"), vt("abcfoobar")]), n(4.0));
    }

    #[test]
    fn search_wildcard_question_matches_single() {
        // "?o" matches one char + "o". In "fool", matches at 1.
        assert_eq!(search(&[vt("?o"), vt("fool")]), n(1.0));
    }

    #[test]
    fn search_wildcard_escape_literal() {
        // "~?" — literal `?`. In "what?", matches at 5 (1-based).
        assert_eq!(search(&[vt("~?"), vt("what?")]), n(5.0));
    }

    #[test]
    fn search_wildcard_no_match() {
        assert_eq!(
            search(&[vt("z*"), vt("apple")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn search_wildcard_with_start_skips_earlier_match() {
        // "?o" — without start, matches at 1 (fo). With start=2,
        // skips first match → finds next 'o' at position 3 (oo).
        assert_eq!(search(&[vt("?o"), vt("foozoo"), n(2.0)]), n(2.0));
    }

    #[test]
    fn substitute_replace_all() {
        // Default: replace all "o" with "0".
        assert_eq!(substitute(&[vt("foo"), vt("o"), vt("0")]), vt("f00"));
    }

    #[test]
    fn substitute_nth_only() {
        // Replace only the 2nd "o".
        assert_eq!(
            substitute(&[vt("foo"), vt("o"), vt("0"), n(2.0)]),
            vt("fo0")
        );
    }

    #[test]
    fn substitute_empty_old_no_op() {
        assert_eq!(substitute(&[vt("hello"), vt(""), vt("X")]), vt("hello"));
    }

    #[test]
    fn substitute_target_instance_not_present_returns_text_unchanged() {
        // Only 2 "o"s in "foo"; asking for instance 5 → return as-is.
        assert_eq!(
            substitute(&[vt("foo"), vt("o"), vt("0"), n(5.0)]),
            vt("foo")
        );
    }

    #[test]
    fn replace_basic() {
        // REPLACE("abcdef", 2, 3, "XYZ") → "aXYZef" (replaces 3 chars
        // starting at position 2: 'bcd' → 'XYZ').
        assert_eq!(
            replace_fn(&[vt("abcdef"), n(2.0), n(3.0), vt("XYZ")]),
            vt("aXYZef")
        );
    }

    #[test]
    fn replace_insert_at_end() {
        // start past end + num_chars=0 → pure append.
        assert_eq!(
            replace_fn(&[vt("abc"), n(4.0), n(0.0), vt("DEF")]),
            vt("abcDEF")
        );
    }

    #[test]
    fn replace_start_below_one_is_value_error() {
        assert_eq!(
            replace_fn(&[vt("abc"), n(0.0), n(1.0), vt("X")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn concatenate_basic() {
        assert_eq!(
            concatenate(&[vt("hello"), vt(" "), vt("world")]),
            vt("hello world")
        );
    }

    #[test]
    fn concatenate_coerces_numbers() {
        assert_eq!(concatenate(&[vt("v="), n(42.0)]), vt("v=42"));
    }

    #[test]
    fn concatenate_propagates_errors() {
        assert_eq!(
            concatenate(&[vt("x"), Value::Error(ErrorValue::Num)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn concatenate_empty_args_is_value_error() {
        assert_eq!(concatenate(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn rept_basic() {
        assert_eq!(rept(&[vt("ab"), n(3.0)]), vt("ababab"));
        assert_eq!(rept(&[vt("x"), n(0.0)]), vt(""));
    }

    #[test]
    fn rept_negative_count_is_value_error() {
        assert_eq!(rept(&[vt("a"), n(-1.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn rept_excessive_length_is_value_error() {
        // text="x"(1 char), num_times=33000 → 33000 chars > 32767.
        assert_eq!(
            rept(&[vt("x"), n(33000.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn exact_case_sensitive() {
        assert_eq!(exact(&[vt("Hello"), vt("Hello")]), Value::Boolean(true));
        assert_eq!(exact(&[vt("Hello"), vt("hello")]), Value::Boolean(false));
        assert_eq!(exact(&[vt(""), vt("")]), Value::Boolean(true));
    }

    #[test]
    fn exact_number_coercion() {
        // Numbers coerce to text first, then case-sensitive compare.
        assert_eq!(exact(&[n(5.0), vt("5")]), Value::Boolean(true));
    }

    // ===== W5-57: math completion + hyperbolic trig =====

    #[test]
    fn ceiling_default_significance_is_one() {
        assert_eq!(ceiling(&[n(2.5)]), n(3.0));
        assert_eq!(ceiling(&[n(-2.5)]), n(-2.0));
        assert_eq!(ceiling(&[n(7.0)]), n(7.0));
    }

    #[test]
    fn ceiling_explicit_significance() {
        assert_eq!(ceiling(&[n(7.0), n(5.0)]), n(10.0));
        assert_eq!(ceiling(&[n(-2.5), n(-2.0)]), n(-4.0));
        assert_eq!(ceiling(&[n(-2.5), n(2.0)]), n(-2.0));
    }

    #[test]
    fn ceiling_positive_with_negative_significance_is_num() {
        assert_eq!(ceiling(&[n(2.5), n(-1.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn ceiling_zero_significance_returns_zero() {
        assert_eq!(ceiling(&[n(7.0), n(0.0)]), n(0.0));
    }

    #[test]
    fn floor_basic() {
        assert_eq!(floor(&[n(2.7)]), n(2.0));
        assert_eq!(floor(&[n(-2.7)]), n(-3.0));
        assert_eq!(floor(&[n(7.0), n(5.0)]), n(5.0));
    }

    #[test]
    fn floor_zero_significance_nonzero_number_is_div_zero() {
        assert_eq!(floor(&[n(7.0), n(0.0)]), Value::Error(ErrorValue::DivZero));
        assert_eq!(floor(&[n(0.0), n(0.0)]), n(0.0));
    }

    #[test]
    fn floor_positive_with_negative_significance_is_num() {
        assert_eq!(floor(&[n(2.5), n(-1.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn mround_basic() {
        assert_eq!(mround(&[n(7.0), n(5.0)]), n(5.0));
        assert_eq!(mround(&[n(8.0), n(5.0)]), n(10.0));
        assert_eq!(mround(&[n(2.5), n(1.0)]), n(3.0)); // .5 rounds away
        assert_eq!(mround(&[n(-2.5), n(-1.0)]), n(-3.0));
    }

    #[test]
    fn mround_sign_mismatch_is_num() {
        assert_eq!(mround(&[n(7.0), n(-5.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(mround(&[n(-7.0), n(5.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn mround_zero_multiple_with_zero_number_returns_zero() {
        assert_eq!(mround(&[n(0.0), n(0.0)]), n(0.0));
    }

    #[test]
    fn mround_zero_multiple_with_nonzero_number_is_num() {
        // W5-60 (Sonnet mega-audit HIGH H1): Excel canon — MROUND(n, 0)
        // for non-zero n returns #NUM!, NOT 0. The W5-57 ship returned
        // 0 unconditionally; corrected.
        assert_eq!(mround(&[n(7.0), n(0.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(mround(&[n(-3.0), n(0.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn odd_basic() {
        assert_eq!(odd(&[n(1.5)]), n(3.0));
        assert_eq!(odd(&[n(3.0)]), n(3.0)); // already odd
        assert_eq!(odd(&[n(2.0)]), n(3.0));
        assert_eq!(odd(&[n(-1.5)]), n(-3.0));
        assert_eq!(odd(&[n(0.0)]), n(1.0)); // Excel canon
    }

    // ===== W5-61 Phase 4.3 polish: PROPER / CLEAN / CEILING.MATH / FLOOR.MATH =====
    // Uses the `t(&str)` helper defined earlier in this test module
    // (line ~2246, Phase 4.3 V1 helper).

    #[test]
    fn proper_simple_words() {
        assert_eq!(proper(&[t("hello world")]), t("Hello World"));
        assert_eq!(proper(&[t("HELLO WORLD")]), t("Hello World"));
        assert_eq!(proper(&[t("hELLO wORLD")]), t("Hello World"));
    }

    #[test]
    fn proper_digits_break_words() {
        // Excel canon: a digit ends the word, so the letter after it
        // becomes uppercase.
        assert_eq!(proper(&[t("123abc")]), t("123Abc"));
        assert_eq!(proper(&[t("abc123def")]), t("Abc123Def"));
    }

    #[test]
    fn proper_punctuation_breaks_words() {
        assert_eq!(proper(&[t("o'neill")]), t("O'Neill"));
        assert_eq!(proper(&[t("mary-jane")]), t("Mary-Jane"));
    }

    #[test]
    fn proper_empty_and_blank() {
        assert_eq!(proper(&[t("")]), t(""));
        assert_eq!(proper(&[Value::Blank]), t(""));
    }

    #[test]
    fn proper_propagates_errors() {
        assert_eq!(
            proper(&[Value::Error(ErrorValue::DivZero)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn proper_arity_error() {
        assert_eq!(proper(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(proper(&[t("a"), t("b")]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn clean_strips_low_control_chars() {
        // Tab, LF, CR, all 0x00-0x1F.
        let input: String = "ab\tcd\nef\r".to_string();
        assert_eq!(clean(&[t(&input)]), t("abcdef"));
    }

    #[test]
    fn clean_preserves_high_chars() {
        // Space (0x20) and above are preserved.
        assert_eq!(clean(&[t("hello world")]), t("hello world"));
        assert_eq!(clean(&[t("café")]), t("café")); // Unicode preserved
    }

    #[test]
    fn clean_empty_input() {
        assert_eq!(clean(&[t("")]), t(""));
    }

    #[test]
    fn clean_propagates_errors() {
        assert_eq!(
            clean(&[Value::Error(ErrorValue::Num)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ceiling_math_positive_default() {
        // Default significance = 1, mode = 0.
        assert_eq!(ceiling_math(&[n(4.3)]), n(5.0));
        assert_eq!(ceiling_math(&[n(4.0)]), n(4.0));
    }

    #[test]
    fn ceiling_math_with_significance() {
        // Round 7.3 up to nearest 0.5 → 7.5.
        assert_eq!(ceiling_math(&[n(7.3), n(0.5)]), n(7.5));
        // Round 11 up to nearest 3 → 12.
        assert_eq!(ceiling_math(&[n(11.0), n(3.0)]), n(12.0));
    }

    #[test]
    fn ceiling_math_uses_abs_significance() {
        // Unlike CEILING, CEILING.MATH ignores significance sign.
        // CEILING(4.3, -1) is #NUM!; CEILING.MATH(4.3, -1) is 5.
        assert_eq!(ceiling_math(&[n(4.3), n(-1.0)]), n(5.0));
        assert_eq!(ceiling_math(&[n(11.0), n(-3.0)]), n(12.0));
    }

    #[test]
    fn ceiling_math_negative_default_mode_zero() {
        // Negative number, mode=0 → round toward +∞ (toward zero).
        // -4.3 → -4.
        assert_eq!(ceiling_math(&[n(-4.3)]), n(-4.0));
        assert_eq!(ceiling_math(&[n(-4.3), n(0.5)]), n(-4.0));
    }

    #[test]
    fn ceiling_math_negative_mode_one() {
        // Negative number, mode=1 → round toward -∞ (away from zero).
        // -4.3 → -5.
        assert_eq!(ceiling_math(&[n(-4.3), n(1.0), n(1.0)]), n(-5.0));
        assert_eq!(ceiling_math(&[n(-4.3), n(0.5), n(1.0)]), n(-4.5));
    }

    #[test]
    fn ceiling_math_zero_significance_returns_zero() {
        // Matches CEILING canon (unlike FLOOR.MATH).
        assert_eq!(ceiling_math(&[n(4.3), n(0.0)]), n(0.0));
        assert_eq!(ceiling_math(&[n(-4.3), n(0.0)]), n(0.0));
    }

    #[test]
    fn ceiling_math_arity_error() {
        assert_eq!(ceiling_math(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            ceiling_math(&[n(1.0), n(2.0), n(3.0), n(4.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn floor_math_positive_default() {
        assert_eq!(floor_math(&[n(4.7)]), n(4.0));
        assert_eq!(floor_math(&[n(4.0)]), n(4.0));
    }

    #[test]
    fn floor_math_with_significance() {
        // Round 7.7 down to nearest 0.5 → 7.5.
        assert_eq!(floor_math(&[n(7.7), n(0.5)]), n(7.5));
    }

    #[test]
    fn floor_math_uses_abs_significance() {
        assert_eq!(floor_math(&[n(4.7), n(-1.0)]), n(4.0));
    }

    #[test]
    fn floor_math_negative_default_mode_zero() {
        // Negative + mode=0 → round toward -∞ (away from zero).
        // -4.3 → -5.
        assert_eq!(floor_math(&[n(-4.3)]), n(-5.0));
    }

    #[test]
    fn floor_math_negative_mode_one() {
        // Negative + mode≠0 → round toward +∞ (toward zero).
        // -4.3 → -4.
        assert_eq!(floor_math(&[n(-4.3), n(1.0), n(1.0)]), n(-4.0));
    }

    #[test]
    fn floor_math_zero_significance_nonzero_number_is_div_zero() {
        // Matches FLOOR canon (NOT CEILING.MATH which returns 0).
        assert_eq!(
            floor_math(&[n(4.3), n(0.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn floor_math_zero_significance_zero_number_is_zero() {
        assert_eq!(floor_math(&[n(0.0), n(0.0)]), n(0.0));
    }

    #[test]
    fn floor_math_arity_error() {
        assert_eq!(floor_math(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            floor_math(&[n(1.0), n(2.0), n(3.0), n(4.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn even_basic() {
        assert_eq!(even(&[n(1.5)]), n(2.0));
        assert_eq!(even(&[n(2.0)]), n(2.0)); // already even
        assert_eq!(even(&[n(3.0)]), n(4.0));
        assert_eq!(even(&[n(-1.5)]), n(-2.0));
        assert_eq!(even(&[n(0.0)]), n(0.0)); // even(0) = 0
    }

    #[test]
    fn quotient_basic() {
        assert_eq!(quotient(&[n(7.0), n(3.0)]), n(2.0));
        assert_eq!(quotient(&[n(8.0), n(3.0)]), n(2.0));
        // Negative truncates toward zero (NOT floor).
        assert_eq!(quotient(&[n(-7.0), n(3.0)]), n(-2.0));
        assert_eq!(quotient(&[n(7.0), n(-3.0)]), n(-2.0));
    }

    #[test]
    fn quotient_zero_denominator_is_div_zero() {
        assert_eq!(
            quotient(&[n(7.0), n(0.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn gcd_basic() {
        assert_eq!(gcd(&[n(8.0), n(12.0)]), n(4.0));
        assert_eq!(gcd(&[n(8.0), n(12.0), n(16.0)]), n(4.0));
        assert_eq!(gcd(&[n(8.0), n(0.0)]), n(8.0));
        assert_eq!(gcd(&[n(0.0), n(0.0)]), n(0.0));
        assert_eq!(gcd(&[n(7.0)]), n(7.0));
    }

    #[test]
    fn gcd_negative_arg_is_num() {
        assert_eq!(gcd(&[n(8.0), n(-4.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn gcd_truncates_to_integer() {
        // Excel: GCD truncates non-integer args toward zero.
        assert_eq!(gcd(&[n(8.5), n(12.0)]), n(4.0));
    }

    #[test]
    fn gcd_arity() {
        assert_eq!(gcd(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn lcm_basic() {
        assert_eq!(lcm(&[n(4.0), n(6.0)]), n(12.0));
        assert_eq!(lcm(&[n(4.0), n(6.0), n(8.0)]), n(24.0));
        // Any zero → 0.
        assert_eq!(lcm(&[n(4.0), n(0.0)]), n(0.0));
        assert_eq!(lcm(&[n(7.0)]), n(7.0));
    }

    #[test]
    fn lcm_negative_arg_is_num() {
        assert_eq!(lcm(&[n(4.0), n(-6.0)]), Value::Error(ErrorValue::Num));
    }

    // === W5-166 (Phase 4.10.D) — combinatorics + SUMSQ ===

    // --- FACT ---

    #[test]
    fn fact_basic() {
        assert_eq!(fact(&[n(0.0)]), n(1.0));
        assert_eq!(fact(&[n(1.0)]), n(1.0));
        assert_eq!(fact(&[n(5.0)]), n(120.0));
        assert_eq!(fact(&[n(10.0)]), n(3628800.0));
    }

    #[test]
    fn fact_truncates_toward_zero() {
        // FACT(2.9) = 2! = 2.
        assert_eq!(fact(&[n(2.9)]), n(2.0));
    }

    #[test]
    fn fact_negative_is_num_error() {
        assert_eq!(fact(&[n(-1.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn fact_above_170_is_num_error() {
        // 170! is f64-finite (~7.26e306). 171! overflows.
        assert_eq!(fact(&[n(171.0)]), Value::Error(ErrorValue::Num));
        // 170 itself is finite.
        match fact(&[n(170.0)]) {
            Value::Number(_) => {}
            other => panic!("FACT(170) expected number, got {other:?}"),
        }
    }

    // --- FACTDOUBLE ---

    #[test]
    fn factdouble_basic() {
        assert_eq!(factdouble(&[n(0.0)]), n(1.0));
        assert_eq!(factdouble(&[n(-1.0)]), n(1.0)); // Excel canon special case
        assert_eq!(factdouble(&[n(5.0)]), n(15.0)); // 5*3*1
        assert_eq!(factdouble(&[n(6.0)]), n(48.0)); // 6*4*2
        assert_eq!(factdouble(&[n(7.0)]), n(105.0)); // 7*5*3*1
    }

    #[test]
    fn factdouble_negative_below_minus_one_is_num_error() {
        assert_eq!(factdouble(&[n(-2.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(factdouble(&[n(-3.5)]), Value::Error(ErrorValue::Num));
    }

    // --- COMBIN ---

    #[test]
    fn combin_basic() {
        // C(5, 2) = 10.
        assert_eq!(combin(&[n(5.0), n(2.0)]), n(10.0));
        // C(5, 0) = 1.
        assert_eq!(combin(&[n(5.0), n(0.0)]), n(1.0));
        // C(5, 5) = 1.
        assert_eq!(combin(&[n(5.0), n(5.0)]), n(1.0));
        // C(10, 3) = 120.
        assert_eq!(combin(&[n(10.0), n(3.0)]), n(120.0));
    }

    #[test]
    fn combin_k_greater_than_n_is_num_error() {
        assert_eq!(combin(&[n(5.0), n(10.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn combin_negative_is_num_error() {
        assert_eq!(combin(&[n(-5.0), n(2.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(combin(&[n(5.0), n(-2.0)]), Value::Error(ErrorValue::Num));
    }

    // --- COMBINA ---

    #[test]
    fn combina_basic() {
        // C(n+k-1, k): COMBINA(5, 2) = C(6, 2) = 15.
        assert_eq!(combina(&[n(5.0), n(2.0)]), n(15.0));
        // COMBINA(3, 2) = C(4, 2) = 6.
        assert_eq!(combina(&[n(3.0), n(2.0)]), n(6.0));
        // COMBINA(n, 0) = 1.
        assert_eq!(combina(&[n(5.0), n(0.0)]), n(1.0));
        // COMBINA(0, 0) = 1.
        assert_eq!(combina(&[n(0.0), n(0.0)]), n(1.0));
    }

    #[test]
    fn combina_n_zero_k_positive_is_num_error() {
        // Excel + IronCalc: degenerate case.
        assert_eq!(combina(&[n(0.0), n(3.0)]), Value::Error(ErrorValue::Num));
    }

    // --- PERMUT ---

    #[test]
    fn permut_basic() {
        // P(5, 2) = 5!/(5-2)! = 20.
        assert_eq!(permut(&[n(5.0), n(2.0)]), n(20.0));
        // P(5, 5) = 120.
        assert_eq!(permut(&[n(5.0), n(5.0)]), n(120.0));
        // P(5, 0) = 1.
        assert_eq!(permut(&[n(5.0), n(0.0)]), n(1.0));
    }

    #[test]
    fn permut_k_greater_than_n_is_num_error() {
        assert_eq!(permut(&[n(5.0), n(10.0)]), Value::Error(ErrorValue::Num));
    }

    // --- PERMUTATIONA ---

    #[test]
    fn permutationa_basic() {
        // n^k: PERMUTATIONA(3, 2) = 9.
        assert_eq!(permutationa(&[n(3.0), n(2.0)]), n(9.0));
        // PERMUTATIONA(5, 3) = 125.
        assert_eq!(permutationa(&[n(5.0), n(3.0)]), n(125.0));
        // PERMUTATIONA(0, 0) = 1 (mathematical convention).
        assert_eq!(permutationa(&[n(0.0), n(0.0)]), n(1.0));
        // PERMUTATIONA(0, k>0) = 0.
        assert_eq!(permutationa(&[n(0.0), n(3.0)]), n(0.0));
        // PERMUTATIONA(n>0, 0) = 1.
        assert_eq!(permutationa(&[n(5.0), n(0.0)]), n(1.0));
    }

    // --- SUMSQ ---

    #[test]
    fn sumsq_basic() {
        // 1² + 2² + 3² = 14.
        assert_eq!(sumsq(&[n(1.0), n(2.0), n(3.0)]), n(14.0));
    }

    #[test]
    fn sumsq_empty_is_zero() {
        assert_eq!(sumsq(&[]), n(0.0));
    }

    #[test]
    fn sumsq_skips_blanks() {
        // Blanks contribute 0.
        assert_eq!(sumsq(&[n(3.0), Value::Blank, n(4.0)]), n(25.0));
    }

    #[test]
    fn sumsq_propagates_errors() {
        assert_eq!(
            sumsq(&[n(1.0), Value::Error(ErrorValue::Ref), n(3.0)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    // --- Hyperbolic trig ---

    #[test]
    fn sinh_basic() {
        match sinh(&[n(0.0)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }
        match sinh(&[n(1.0)]) {
            Value::Number(v) => assert!((v - 1.175_201_193_643_801_4).abs() < 1e-12),
            _ => panic!(),
        }
    }

    #[test]
    fn cosh_basic() {
        assert_eq!(cosh(&[n(0.0)]), n(1.0));
        match cosh(&[n(1.0)]) {
            Value::Number(v) => assert!((v - 1.543_080_634_815_243_7).abs() < 1e-12),
            _ => panic!(),
        }
    }

    #[test]
    fn tanh_basic_and_saturation() {
        match tanh(&[n(0.0)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }
        // tanh(±large) saturates to ±1.
        match tanh(&[n(100.0)]) {
            Value::Number(v) => assert!((v - 1.0).abs() < 1e-12),
            _ => panic!(),
        }
        match tanh(&[n(-100.0)]) {
            Value::Number(v) => assert!((v + 1.0).abs() < 1e-12),
            _ => panic!(),
        }
    }

    #[test]
    fn sinh_overflow_is_num() {
        // SINH(1000) overflows.
        assert_eq!(sinh(&[n(1000.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(cosh(&[n(1000.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn asinh_basic() {
        match asinh(&[n(0.0)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }
        // asinh(1) = ln(1 + sqrt(2)) ≈ 0.881_373_587_019_543
        match asinh(&[n(1.0)]) {
            Value::Number(v) => assert!((v - 0.881_373_587_019_543).abs() < 1e-12),
            _ => panic!(),
        }
    }

    #[test]
    fn acosh_domain_and_basic() {
        // acosh(1) = 0.
        match acosh(&[n(1.0)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }
        // acosh(2) = ln(2 + sqrt(3)) ≈ 1.316_957_896_924_816_7
        match acosh(&[n(2.0)]) {
            Value::Number(v) => assert!((v - 1.316_957_896_924_816_7).abs() < 1e-12),
            _ => panic!(),
        }
        // Domain: x < 1 → #NUM!.
        assert_eq!(acosh(&[n(0.5)]), Value::Error(ErrorValue::Num));
        assert_eq!(acosh(&[n(-1.0)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn atanh_domain_and_basic() {
        match atanh(&[n(0.0)]) {
            Value::Number(v) => assert!(v.abs() < 1e-9),
            _ => panic!(),
        }
        // |x| ≥ 1 → #NUM! (Excel canon, not ±∞).
        assert_eq!(atanh(&[n(1.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(atanh(&[n(-1.0)]), Value::Error(ErrorValue::Num));
        assert_eq!(atanh(&[n(1.5)]), Value::Error(ErrorValue::Num));
        // |x| < 1 ok.
        match atanh(&[n(0.5)]) {
            Value::Number(v) => assert!((v - 0.549_306_144_334_054_8).abs() < 1e-12),
            _ => panic!(),
        }
    }

    #[test]
    fn hyperbolic_arity_errors() {
        let fns: [fn(&[Value]) -> Value; 6] = [sinh, cosh, tanh, asinh, acosh, atanh];
        for f in fns.iter() {
            assert_eq!(f(&[]), Value::Error(ErrorValue::Value));
            assert_eq!(f(&[n(0.0), n(0.0)]), Value::Error(ErrorValue::Value));
        }
    }
}
