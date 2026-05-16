//! **W5-168 (Phase 4.10.F)** — Financial functions.
//!
//! TVM family (PMT, FV, PV, NPER, RATE, IPMT, PPMT) + cash-flow
//! family (NPV, IRR). All Excel canon verified against IronCalc
//! references at `.references/ironcalc/base/src/functions/financial.rs`
//! and `.references/ironcalc/base/src/functions/financial_util.rs`.
//!
//! ## TVM equation
//!
//! ```text
//! pv * (1+rate)^nper
//!   + pmt * (1+rate*type) * ((1+rate)^nper - 1) / rate
//!   + fv = 0                                  // rate != 0
//!
//! pmt * nper + pv + fv = 0                    // rate == 0
//! ```
//!
//! - `type = 0` → payments at END of period (default).
//! - `type = 1` → payments at BEGINNING of period.
//! - Per Excel canon: any non-zero `type` is treated as `1`.
//!
//! ## Sign convention
//!
//! Outflows are negative, inflows positive. `PMT(loan)` returns a
//! negative number (money you pay out). Matches Excel + IronCalc.

use ql_types::{coercion, ErrorValue, Value};

use crate::range_aware_fns::{coerce_numeric, FnArg, NumericArg};

// ===== Argument helpers =====

/// Coerce an arg into a number. Blank → 0. Errors propagate.
fn arg_num(v: &Value) -> Result<f64, ErrorValue> {
    match coerce_numeric(v) {
        NumericArg::Number(n) => Ok(n),
        NumericArg::Skip => Ok(0.0),
        NumericArg::Error(e) => Err(e),
    }
}

/// Coerce optional `type` arg into the `period_start` bool. Per Excel:
/// any non-zero value is treated as TRUE (period start).
fn arg_type(v: &Value) -> Result<bool, ErrorValue> {
    match coerce_numeric(v) {
        NumericArg::Number(n) => Ok(n != 0.0),
        NumericArg::Skip => Ok(false),
        NumericArg::Error(e) => Err(e),
    }
}

// ===== Core TVM helpers (pure math; mirror IronCalc references) =====

/// `PMT` core. Returns `Err(ErrorValue::Num)` for NaN/Inf or
/// undefined inputs (rate ≤ -1).
pub(crate) fn compute_payment(
    rate: f64,
    nper: f64,
    pv: f64,
    fv: f64,
    period_start: bool,
) -> Result<f64, ErrorValue> {
    if rate == 0.0 {
        if nper == 0.0 {
            return Err(ErrorValue::Num);
        }
        return Ok(-(pv + fv) / nper);
    }
    if rate <= -1.0 {
        return Err(ErrorValue::Num);
    }
    let rate_nper = if nper == 0.0 {
        1.0
    } else {
        (1.0 + rate).powf(nper)
    };
    let result = if period_start {
        (fv + pv * rate_nper) * rate / ((1.0 + rate) * (1.0 - rate_nper))
    } else {
        (fv * rate + pv * rate * rate_nper) / (1.0 - rate_nper)
    };
    if result.is_nan() || result.is_infinite() {
        return Err(ErrorValue::Num);
    }
    Ok(result)
}

/// `FV` core.
pub(crate) fn compute_future_value(
    rate: f64,
    nper: f64,
    pmt: f64,
    pv: f64,
    period_start: bool,
) -> Result<f64, ErrorValue> {
    if rate == 0.0 {
        return Ok(-pv - pmt * nper);
    }
    if rate == -1.0 && nper < 0.0 {
        return Err(ErrorValue::DivZero);
    }
    let rate_nper = (1.0 + rate).powf(nper);
    let fv = if period_start {
        -pv * rate_nper - pmt * (1.0 + rate) * (rate_nper - 1.0) / rate
    } else {
        -pv * rate_nper - pmt * (rate_nper - 1.0) / rate
    };
    if fv.is_nan() {
        return Err(ErrorValue::Num);
    }
    if !fv.is_finite() {
        return Err(ErrorValue::DivZero);
    }
    Ok(fv)
}

/// `PV` core. Solves the TVM equation for `pv`.
pub(crate) fn compute_present_value(
    rate: f64,
    nper: f64,
    pmt: f64,
    fv: f64,
    period_start: bool,
) -> Result<f64, ErrorValue> {
    if rate == 0.0 {
        return Ok(-fv - pmt * nper);
    }
    if rate <= -1.0 {
        return Err(ErrorValue::Num);
    }
    let rate_nper = (1.0 + rate).powf(nper);
    let annuity_factor = if period_start {
        pmt * (1.0 + rate) * (rate_nper - 1.0) / rate
    } else {
        pmt * (rate_nper - 1.0) / rate
    };
    let result = -(fv + annuity_factor) / rate_nper;
    if result.is_nan() || result.is_infinite() {
        return Err(ErrorValue::Num);
    }
    Ok(result)
}

/// `NPER` core. Solves the TVM equation for `nper` using logarithms.
/// Returns `#NUM!` when no real solution exists.
pub(crate) fn compute_nper(
    rate: f64,
    pmt: f64,
    pv: f64,
    fv: f64,
    period_start: bool,
) -> Result<f64, ErrorValue> {
    if rate == 0.0 {
        if pmt == 0.0 {
            return Err(ErrorValue::Num);
        }
        return Ok(-(pv + fv) / pmt);
    }
    if rate <= -1.0 {
        return Err(ErrorValue::Num);
    }
    // pmt' = pmt * (1 + rate*type) / rate; want (1+rate)^nper * (pv + pmt') = pmt' - fv
    let pmt_factor = if period_start {
        pmt * (1.0 + rate) / rate
    } else {
        pmt / rate
    };
    let num = pmt_factor - fv;
    let den = pv + pmt_factor;
    if den == 0.0 {
        return Err(ErrorValue::Num);
    }
    let ratio = num / den;
    if ratio <= 0.0 {
        return Err(ErrorValue::Num);
    }
    let log_base = (1.0 + rate).ln();
    if log_base == 0.0 {
        return Err(ErrorValue::Num);
    }
    let nper = ratio.ln() / log_base;
    if nper.is_nan() || nper.is_infinite() {
        return Err(ErrorValue::Num);
    }
    Ok(nper)
}

/// `RATE` core — Newton-Raphson with bounded iterations.
/// Per IronCalc: 50 iterations, eps = 1e-7, guess > -1.
pub(crate) fn compute_rate(
    nper: f64,
    pmt: f64,
    pv: f64,
    fv: f64,
    period_start: bool,
    guess: f64,
) -> Result<f64, ErrorValue> {
    if guess <= -1.0 {
        return Err(ErrorValue::Value);
    }
    let mut rate = guess;
    let max_iterations = 50;
    let eps = 1e-7;
    let annuity_type = if period_start { 1.0 } else { 0.0 };
    for _ in 1..=max_iterations {
        // f(rate) = pv*(1+r)^nper + pmt*(1+r*type)*((1+r)^nper-1)/r + fv
        // f'(rate) is the derivative wrt rate.
        let t = (1.0 + rate).powf(nper - 1.0);
        let tt = t * (1.0 + rate);
        let f = pv * tt + pmt * (1.0 + rate * annuity_type) * (tt - 1.0) / rate + fv;
        let f_prime = pv * nper * t - pmt * (tt - 1.0) / (rate * rate)
            + pmt * (1.0 + rate * annuity_type) * t * nper / rate;
        if f_prime == 0.0 {
            return Err(ErrorValue::Num);
        }
        let new_rate = rate - f / f_prime;
        if new_rate <= -1.0 {
            return Err(ErrorValue::Num);
        }
        if (new_rate - rate).abs() < eps {
            return Ok(new_rate);
        }
        rate = new_rate;
    }
    Err(ErrorValue::Num)
}

/// `IPMT` core — interest portion of the `period`-th payment.
pub(crate) fn compute_ipmt(
    rate: f64,
    period: f64,
    nper: f64,
    pv: f64,
    fv: f64,
    period_start: bool,
) -> Result<f64, ErrorValue> {
    let payment = compute_payment(rate, nper, pv, fv, period_start)?;
    if period < 1.0 || period >= nper + 1.0 {
        return Err(ErrorValue::Num);
    }
    if period == 1.0 && period_start {
        return Ok(0.0);
    }
    let p = if period_start {
        period - 2.0
    } else {
        period - 1.0
    };
    let c = if period_start { -payment } else { 0.0 };
    let fv_at_p = compute_future_value(rate, p, payment, pv, period_start)?;
    Ok((fv_at_p + c) * rate)
}

/// `PPMT` core — principal portion of the `period`-th payment.
pub(crate) fn compute_ppmt(
    rate: f64,
    period: f64,
    nper: f64,
    pv: f64,
    fv: f64,
    period_start: bool,
) -> Result<f64, ErrorValue> {
    let payment = compute_payment(rate, nper, pv, fv, period_start)?;
    let ipmt = compute_ipmt(rate, period, nper, pv, fv, period_start)?;
    Ok(payment - ipmt)
}

// ===== NPV / IRR core =====

/// `NPV` core. Excel canon: each value is discounted by `(1+rate)^i`
/// where i starts at 1 (NOT 0 — values are END-of-period cash flows).
pub(crate) fn compute_npv(rate: f64, values: &[f64]) -> Result<f64, ErrorValue> {
    if rate <= -1.0 {
        return Err(ErrorValue::Num);
    }
    let mut npv = 0.0;
    for (i, v) in values.iter().enumerate() {
        npv += v / (1.0 + rate).powi(i as i32 + 1);
    }
    if npv.is_nan() || npv.is_infinite() {
        return Err(ErrorValue::Num);
    }
    Ok(npv)
}

/// NPV derivative for Newton-Raphson.
fn compute_npv_prime(rate: f64, values: &[f64]) -> Result<f64, ErrorValue> {
    let mut d = 0.0;
    for (i, v) in values.iter().enumerate() {
        d += -v * (i as f64 + 1.0) / (1.0 + rate).powi(i as i32 + 2);
    }
    if d.is_nan() || d.is_infinite() {
        return Err(ErrorValue::Num);
    }
    Ok(d)
}

fn irr_newton(values: &[f64], guess: f64) -> Result<f64, ErrorValue> {
    let mut irr = guess;
    let max_iterations = 50;
    let eps = 1e-8;
    for _ in 1..=max_iterations {
        let f = compute_npv(irr, values)?;
        let fp = compute_npv_prime(irr, values)?;
        if fp == 0.0 {
            return Err(ErrorValue::Num);
        }
        let new_irr = irr - f / fp;
        if (new_irr - irr).abs() < eps {
            return Ok(new_irr);
        }
        irr = new_irr;
    }
    Err(ErrorValue::Num)
}

/// `IRR` core — finds rate `r` such that `NPV(r, values) = 0`.
/// Per IronCalc: Newton-Raphson around guess; fall back to bisection
/// (with bracketing) if N-R fails. Inputs must include at least one
/// sign change in the cash flow (otherwise `#NUM!`).
pub(crate) fn compute_irr(values: &[f64], guess: f64) -> Result<f64, ErrorValue> {
    if guess <= -1.0 {
        return Err(ErrorValue::Value);
    }
    // Need at least one positive and one negative cash flow.
    let all_non_neg = values.iter().all(|&x| x >= 0.0);
    let all_non_pos = values.iter().all(|&x| x <= 0.0);
    if all_non_neg || all_non_pos {
        return Err(ErrorValue::Num);
    }
    if let Ok(r) = irr_newton(values, guess) {
        return Ok(r);
    }
    // Bisection fallback in [-0.99999, 100].
    let x1 = -0.99999;
    let x2 = 100.0;
    let f1 = compute_npv(x1, values)?;
    let f2 = compute_npv(x2, values)?;
    if f1 * f2 > 0.0 {
        // Root not in interval; try N-R at the edges.
        if let Ok(r) = irr_newton(values, 200.0) {
            return Ok(r);
        }
        if let Ok(r) = irr_newton(values, -2.0) {
            return Ok(r);
        }
        return Err(ErrorValue::Num);
    }
    let (mut rtb, mut dx) = if f1 < 0.0 {
        (x1, x2 - x1)
    } else {
        (x2, x1 - x2)
    };
    let eps = 1e-10;
    let max_iterations = 50;
    for _ in 1..max_iterations {
        dx *= 0.5;
        let x_mid = rtb + dx;
        let f_mid = compute_npv(x_mid, values)?;
        if f_mid <= 0.0 {
            rtb = x_mid;
        }
        if f_mid.abs() < eps || dx.abs() < eps {
            return Ok(x_mid);
        }
    }
    Err(ErrorValue::Num)
}

// ===== ScalarFn wrappers (registered as ScalarFn) =====

fn finish(result: Result<f64, ErrorValue>) -> Value {
    match result {
        Ok(n) => match coercion::sanitize_f64(n) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

/// `PMT(rate, nper, pv, [fv=0], [type=0])`
pub fn pmt(args: &[Value]) -> Value {
    if !(3..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let nper = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pv = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let fv = if args.len() > 3 {
        match arg_num(&args[3]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() == 5 {
        match arg_type(&args[4]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_payment(rate, nper, pv, fv, period_start))
}

/// `FV(rate, nper, pmt, [pv=0], [type=0])`
pub fn fv(args: &[Value]) -> Value {
    if !(3..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let nper = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pmt_val = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pv = if args.len() > 3 {
        match arg_num(&args[3]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() == 5 {
        match arg_type(&args[4]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_future_value(rate, nper, pmt_val, pv, period_start))
}

/// `PV(rate, nper, pmt, [fv=0], [type=0])`
pub fn pv(args: &[Value]) -> Value {
    if !(3..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let nper = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pmt_val = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let fv_val = if args.len() > 3 {
        match arg_num(&args[3]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() == 5 {
        match arg_type(&args[4]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_present_value(
        rate,
        nper,
        pmt_val,
        fv_val,
        period_start,
    ))
}

/// `NPER(rate, pmt, pv, [fv=0], [type=0])`
pub fn nper(args: &[Value]) -> Value {
    if !(3..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pmt_val = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pv = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let fv_val = if args.len() > 3 {
        match arg_num(&args[3]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() == 5 {
        match arg_type(&args[4]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_nper(rate, pmt_val, pv, fv_val, period_start))
}

/// `RATE(nper, pmt, pv, [fv=0], [type=0], [guess=0.1])`
pub fn rate(args: &[Value]) -> Value {
    if !(3..=6).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let nper = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pmt_val = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pv = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let fv_val = if args.len() > 3 {
        match arg_num(&args[3]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() > 4 {
        match arg_type(&args[4]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    // Excel default guess = 0.1 (10%).
    let guess = if args.len() == 6 {
        match arg_num(&args[5]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.1
    };
    finish(compute_rate(nper, pmt_val, pv, fv_val, period_start, guess))
}

/// `IPMT(rate, period, nper, pv, [fv=0], [type=0])`
pub fn ipmt(args: &[Value]) -> Value {
    if !(4..=6).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let period = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let nper = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pv = match arg_num(&args[3]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let fv_val = if args.len() > 4 {
        match arg_num(&args[4]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() == 6 {
        match arg_type(&args[5]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_ipmt(rate, period, nper, pv, fv_val, period_start))
}

/// `PPMT(rate, period, nper, pv, [fv=0], [type=0])`
pub fn ppmt(args: &[Value]) -> Value {
    if !(4..=6).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let period = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let nper = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let pv = match arg_num(&args[3]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let fv_val = if args.len() > 4 {
        match arg_num(&args[4]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0.0
    };
    let period_start = if args.len() == 6 {
        match arg_type(&args[5]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_ppmt(rate, period, nper, pv, fv_val, period_start))
}

// ===== RangeAwareFn wrappers — NPV / IRR =====

/// Collect numeric values from a variadic mix of scalars + ranges.
/// Non-numeric cells (text, blank) are SKIPPED per Excel NPV canon
/// (matches IronCalc's `get_array_of_numbers`). Errors propagate.
fn collect_cashflow(args: &[FnArg]) -> Result<Vec<f64>, ErrorValue> {
    let mut out = Vec::new();
    for arg in args {
        match arg {
            FnArg::Scalar(v) => match v {
                Value::Number(n) => out.push(*n),
                Value::Blank => {} // skip
                Value::Error(e) => return Err(*e),
                _ => {} // skip text/bool (Excel NPV canon)
            },
            FnArg::Range { values, .. } => {
                for v in values {
                    match v {
                        Value::Number(n) => out.push(*n),
                        Value::Blank => {} // skip
                        Value::Error(e) => return Err(*e),
                        _ => {} // skip text/bool
                    }
                }
            }
        }
    }
    Ok(out)
}

/// `NPV(rate, value1, [value2], ...)` — net present value.
/// First arg is the discount rate; subsequent args are END-of-period
/// cash flows. RangeAwareFn so range args are accepted; ranges
/// flatten row-major. Empty cash-flow → `#NUM!`.
pub fn npv(args: &[FnArg]) -> Value {
    if args.len() < 2 {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match &args[0] {
        FnArg::Scalar(v) => match arg_num(v) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        },
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    let values = match collect_cashflow(&args[1..]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if values.is_empty() {
        return Value::Error(ErrorValue::Num);
    }
    finish(compute_npv(rate, &values))
}

/// `IRR(values, [guess=0.1])` — internal rate of return. Iterative
/// (Newton-Raphson around guess; bisection fallback per IronCalc
/// pattern). Cash-flow must include at least one positive and one
/// negative value → otherwise `#NUM!`.
pub fn irr(args: &[FnArg]) -> Value {
    if !(1..=2).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let values = match &args[0] {
        FnArg::Range { values, .. } => {
            // Per IronCalc: numeric values only; non-numeric (text, bool)
            // → #VALUE!. Blank → skip. Errors propagate.
            let mut out = Vec::new();
            for v in values {
                match v {
                    Value::Number(n) => out.push(*n),
                    Value::Blank => {}
                    Value::Error(e) => return Value::Error(*e),
                    _ => return Value::Error(ErrorValue::Value),
                }
            }
            out
        }
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    if values.is_empty() {
        return Value::Error(ErrorValue::Num);
    }
    let guess = if args.len() == 2 {
        match &args[1] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => n,
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        0.1
    };
    finish(compute_irr(&values, guess))
}

// ===== Tests =====

#[cfg(test)]
mod tests {
    use super::*;

    fn n(x: f64) -> Value {
        Value::Number(x)
    }
    fn approx(actual: Value, expected: f64, tol: f64) {
        match actual {
            Value::Number(got) => assert!(
                (got - expected).abs() < tol,
                "expected ≈ {expected}, got {got}"
            ),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    // --- PMT ---

    #[test]
    fn pmt_loan() {
        // PMT(0.005, 360, -100000) — 30-year loan @ 6% APR (0.5%/mo),
        // $100k principal. Payment ≈ $599.55 (positive — money coming in).
        // We use pv=-100000 (loan disbursed) → PMT positive.
        approx(pmt(&[n(0.005), n(360.0), n(-100000.0)]), 599.55, 0.01);
    }

    #[test]
    fn pmt_zero_rate() {
        // 0% rate: pmt = -(pv + fv) / nper = -(100 + 0) / 10 = -10.
        approx(pmt(&[n(0.0), n(10.0), n(100.0)]), -10.0, 1e-9);
    }

    #[test]
    fn pmt_wrong_arity() {
        assert_eq!(pmt(&[n(0.1), n(10.0)]), Value::Error(ErrorValue::Value));
    }

    // --- FV ---

    #[test]
    fn fv_savings() {
        // FV(0.005, 12, -100): saving $100/mo for 12 months at 0.5%/mo
        // → ≈ 1233.56.
        approx(fv(&[n(0.005), n(12.0), n(-100.0)]), 1233.56, 0.01);
    }

    #[test]
    fn fv_zero_rate() {
        // FV(0, 10, -50, 0) = -(-50)*10 = 500. Actually: -pv - pmt*nper
        // = -0 - (-50)*10 = 500.
        approx(fv(&[n(0.0), n(10.0), n(-50.0)]), 500.0, 1e-9);
    }

    // --- PV ---

    #[test]
    fn pv_zero_rate() {
        // PV(0, 10, -50) = -fv - pmt*nper = -0 - (-50)*10 = 500.
        approx(pv(&[n(0.0), n(10.0), n(-50.0)]), 500.0, 1e-9);
    }

    #[test]
    fn pv_loan() {
        // PV(0.005, 360, -599.55) ≈ 99999.5 (inverse of PMT loan above).
        approx(pv(&[n(0.005), n(360.0), n(-599.55)]), 99999.55, 1.0);
    }

    // --- NPER ---

    #[test]
    fn nper_zero_rate() {
        // NPER(0, -100, 1000) = 10. -(pv+fv)/pmt = -(1000+0)/(-100) = 10.
        approx(nper(&[n(0.0), n(-100.0), n(1000.0)]), 10.0, 1e-9);
    }

    #[test]
    fn nper_zero_rate_zero_pmt_is_num() {
        // 0% + 0 pmt + non-zero pv → can never reach fv.
        assert_eq!(
            nper(&[n(0.0), n(0.0), n(1000.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- RATE ---

    #[test]
    fn rate_zero_pmt() {
        // FV grew from -1000 to 1000 * 1.05^10 ≈ 1628.89 over 10 periods
        // → rate ≈ 5%. PMT = 0; type = 0.
        let fv_at_5pct = 1000.0 * 1.05_f64.powi(10);
        approx(
            rate(&[n(10.0), n(0.0), n(-1000.0), n(fv_at_5pct)]),
            0.05,
            1e-6,
        );
    }

    // --- IPMT / PPMT ---

    #[test]
    fn ipmt_first_period_loan() {
        // 100k loan @ 6%/yr, 30 yr. period 1 interest ≈ -500.
        // (Monthly rate = 0.005; first period interest = -100k * 0.005 = -500.)
        approx(
            ipmt(&[n(0.005), n(1.0), n(360.0), n(100000.0)]),
            -500.0,
            0.1,
        );
    }

    #[test]
    fn ipmt_plus_ppmt_equals_pmt() {
        // For any period k: IPMT + PPMT = PMT.
        let r = 0.005;
        let np = 360.0;
        let p = 50.0; // mid-loan period
        let pv_val = 100000.0;
        let total = match (
            ipmt(&[n(r), n(p), n(np), n(pv_val)]),
            ppmt(&[n(r), n(p), n(np), n(pv_val)]),
            pmt(&[n(r), n(np), n(pv_val)]),
        ) {
            (Value::Number(i), Value::Number(pp), Value::Number(pm)) => (i + pp, pm),
            _ => panic!(),
        };
        assert!((total.0 - total.1).abs() < 1e-6);
    }

    #[test]
    fn ipmt_invalid_period_is_num() {
        assert_eq!(
            ipmt(&[n(0.005), n(0.0), n(360.0), n(100000.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- NPV / IRR ---

    fn r(vs: Vec<Value>) -> FnArg {
        let cols = vs.len();
        FnArg::Range {
            values: vs,
            rows: 1,
            cols,
        }
    }
    fn s(v: Value) -> FnArg {
        FnArg::Scalar(v)
    }

    #[test]
    fn npv_basic() {
        // NPV(0.1, 100, 100, 100) = 100/1.1 + 100/1.21 + 100/1.331 ≈ 248.685.
        approx(
            npv(&[s(n(0.1)), s(n(100.0)), s(n(100.0)), s(n(100.0))]),
            248.685,
            0.001,
        );
    }

    #[test]
    fn npv_with_range() {
        let cash = r(vec![n(100.0), n(100.0), n(100.0)]);
        approx(npv(&[s(n(0.1)), cash]), 248.685, 0.001);
    }

    #[test]
    fn npv_empty_cash_flow_is_num() {
        assert_eq!(npv(&[s(n(0.1))]), Value::Error(ErrorValue::Value));
        // Empty range → 0 values collected.
        let empty: FnArg = FnArg::Range {
            values: vec![],
            rows: 0,
            cols: 0,
        };
        assert_eq!(npv(&[s(n(0.1)), empty]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn npv_skips_text() {
        // Text cells skipped per Excel canon.
        let cash = r(vec![n(100.0), Value::text("skip me"), n(100.0)]);
        // 100/1.1 + 100/1.21 ≈ 173.553.
        approx(npv(&[s(n(0.1)), cash]), 173.553, 0.001);
    }

    #[test]
    fn npv_propagates_errors() {
        let cash = r(vec![n(100.0), Value::Error(ErrorValue::Ref)]);
        assert_eq!(npv(&[s(n(0.1)), cash]), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn irr_basic() {
        // Cash flow [-1000, 600, 600] → IRR ≈ 13.07%.
        let cash = r(vec![n(-1000.0), n(600.0), n(600.0)]);
        approx(irr(&[cash]), 0.13066, 1e-4);
    }

    #[test]
    fn irr_all_positive_is_num() {
        let cash = r(vec![n(100.0), n(200.0), n(300.0)]);
        assert_eq!(irr(&[cash]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn irr_all_negative_is_num() {
        let cash = r(vec![n(-100.0), n(-200.0)]);
        assert_eq!(irr(&[cash]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn irr_with_guess() {
        let cash = r(vec![n(-1000.0), n(600.0), n(600.0)]);
        approx(irr(&[cash, s(n(0.1))]), 0.13066, 1e-4);
    }

    #[test]
    fn irr_scalar_arg_is_value_error() {
        assert_eq!(irr(&[s(n(1.0))]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn irr_text_in_range_is_value_error() {
        let cash = r(vec![n(-1000.0), Value::text("ouch"), n(600.0)]);
        assert_eq!(irr(&[cash]), Value::Error(ErrorValue::Value));
    }
}
