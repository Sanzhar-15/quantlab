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
    // **W5-171 (Codex MEDIUM-2):** near-zero `rate` in the iteration
    // would `0/0` inside `f` and `f'` (division by `rate` and `rate*rate`).
    // Perturb a near-zero current iterate to a small epsilon so N-R
    // can step away. Matches Excel canon — `RATE(...,0)` typically
    // converges from a perturbation rather than producing #NUM!.
    const NEAR_ZERO: f64 = 1e-12;
    let mut rate = if guess.abs() < NEAR_ZERO {
        NEAR_ZERO
    } else {
        guess
    };
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
        if f_prime == 0.0 || !f.is_finite() || !f_prime.is_finite() {
            return Err(ErrorValue::Num);
        }
        let new_rate = rate - f / f_prime;
        if new_rate <= -1.0 {
            return Err(ErrorValue::Num);
        }
        if (new_rate - rate).abs() < eps {
            return Ok(new_rate);
        }
        // Same near-zero guard on the iterate itself, not just the guess.
        rate = if new_rate.abs() < NEAR_ZERO {
            NEAR_ZERO
        } else {
            new_rate
        };
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
        // Root not in interval; try N-R at a much larger guess.
        // **W5-171 (Codex MEDIUM-5):** removed the symmetric "-2.0"
        // edge probe — it was dead code because `compute_npv` rejects
        // `rate <= -1` upstream (at the validation in this function's
        // own entry). The IronCalc version had the same bug; the
        // dropped probe was never a useful path.
        if let Ok(r) = irr_newton(values, 200.0) {
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

/// **W5-174 (Phase 4.10 polish, MIRR):** Modified Internal Rate of
/// Return — combines a `reinvest_rate` for positive cash flows with a
/// `finance_rate` for negative cash flows. Closed-form (no iteration):
///
/// $$ MIRR = \left( \frac{-NPV(r_r, v_+) \cdot (1 + r_r)^n}{NPV(r_f, v_-) \cdot (1 + r_f)} \right)^{1/(n-1)} - 1 $$
///
/// where `r_r` is the reinvest rate, `r_f` is the finance rate,
/// `v_+` / `v_-` are the per-period cash flows with the opposite-sign
/// terms zeroed, and `n = values.len()`.
///
/// Excel canon: requires at least one positive AND at least one
/// negative cash flow (otherwise `#DIV/0!`). `finance_rate = -1` and
/// `reinvest_rate = -1` get IronCalc-style cancellation handling so
/// the result remains defined where it makes sense.
pub(crate) fn compute_mirr(
    values: &[f64],
    finance_rate: f64,
    reinvest_rate: f64,
) -> Result<f64, ErrorValue> {
    let mut positives = Vec::with_capacity(values.len());
    let mut negatives = Vec::with_capacity(values.len());
    let mut has_positive = false;
    let mut has_negative = false;
    let mut last_negative_index: Option<usize> = None;
    for (i, &v) in values.iter().enumerate() {
        if v > 0.0 {
            positives.push(v);
            negatives.push(0.0);
            has_positive = true;
        } else if v < 0.0 {
            positives.push(0.0);
            negatives.push(v);
            has_negative = true;
            last_negative_index = Some(i);
        } else {
            // Exactly zero — contributes to neither stream.
            positives.push(0.0);
            negatives.push(0.0);
        }
    }
    if !has_positive || !has_negative {
        return Err(ErrorValue::DivZero);
    }
    let n = values.len();
    let years = n as f64;

    // top = -NPV(reinvest_rate, positives) * (1 + reinvest_rate)^n.
    // Special-case reinvest_rate == -1: `compute_npv` would reject
    // (rate <= -1), but analytically all but the LAST positive term
    // cancel — port IronCalc's limit (positives.last()).
    let top = if reinvest_rate == -1.0 {
        *positives
            .last()
            .expect("values non-empty: has_positive ensured")
    } else {
        let npv_pos = compute_npv(reinvest_rate, &positives)?;
        -npv_pos * (1.0 + reinvest_rate).powi(n as i32)
    };

    // bottom = NPV(finance_rate, negatives) * (1 + finance_rate).
    // Symmetric special case for finance_rate == -1: if the only
    // negative is at index 0, bottom equals that term; otherwise
    // |bottom| → ∞ and the eventual ratio → 0 → result = -1
    // (IronCalc treats the magnitude as effectively infinite).
    let bottom = if finance_rate == -1.0 {
        let last_idx = last_negative_index.expect("values non-empty: has_negative ensured");
        if last_idx == 0 {
            negatives[0]
        } else {
            f64::INFINITY
        }
    } else {
        let npv_neg = compute_npv(finance_rate, &negatives)?;
        npv_neg * (1.0 + finance_rate)
    };

    if bottom == 0.0 {
        return Err(ErrorValue::DivZero);
    }
    let ratio = top / bottom;
    if ratio < 0.0 {
        // Even/odd root of a negative — surface as #NUM! per Excel
        // canon. Reached only with pathological sign distributions.
        return Err(ErrorValue::Num);
    }
    let result = ratio.powf(1.0 / (years - 1.0)) - 1.0;
    if result.is_infinite() {
        return Err(ErrorValue::DivZero);
    }
    if result.is_nan() {
        return Err(ErrorValue::Num);
    }
    Ok(result)
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

/// **W5-180 (Phase 4.10 polish / Wave 3 depreciation batch starter):**
/// straight-line depreciation per Microsoft + IronCalc.
/// `SLN(cost, salvage, life) = (cost − salvage) / life`. `life = 0`
/// → `#DIV/0!` per Excel canon (note: SYD's identical degenerate
/// case returns `#NUM!` instead — asymmetric but documented).
pub(crate) fn compute_sln(cost: f64, salvage: f64, life: f64) -> Result<f64, ErrorValue> {
    if life == 0.0 {
        return Err(ErrorValue::DivZero);
    }
    Ok((cost - salvage) / life)
}

/// **W5-180 (Phase 4.10 polish / Wave 3 depreciation batch starter):**
/// sum-of-years digits depreciation per Microsoft + IronCalc.
/// `SYD(cost, salvage, life, per) = (cost − salvage) ·
/// (life − per + 1) · 2 / (life · (life + 1))`.
///
/// `per > life` or `per <= 0` → `#NUM!`. **`life = 0` → `#NUM!` per
/// IronCalc convention** (W5-182.1 Opus MEDIUM-2 closure: Microsoft's
/// SYD doc is silent on the error code for the degenerate case, so
/// the asymmetry vs SLN's `#DIV/0!` reflects IronCalc's choice, not
/// documented Microsoft canon. Verified by direct read of
/// `support.microsoft.com/.../syd-function-...`).
pub(crate) fn compute_syd(cost: f64, salvage: f64, life: f64, per: f64) -> Result<f64, ErrorValue> {
    if life == 0.0 {
        return Err(ErrorValue::Num);
    }
    if per > life || per <= 0.0 {
        return Err(ErrorValue::Num);
    }
    Ok(((cost - salvage) * (life - per + 1.0) * 2.0) / (life * (life + 1.0)))
}

/// **W5-180:** `SLN(cost, salvage, life)` — straight-line depreciation.
/// Three args required; `Blank` arg coerces to `0` per the existing
/// `arg_num` contract.
pub fn sln(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let cost = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let salvage = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let life = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    finish(compute_sln(cost, salvage, life))
}

/// **W5-180:** `SYD(cost, salvage, life, per)` — sum-of-years digits
/// depreciation. Four args required.
pub fn syd(args: &[Value]) -> Value {
    if args.len() != 4 {
        return Value::Error(ErrorValue::Value);
    }
    let cost = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let salvage = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let life = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let per = match arg_num(&args[3]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    finish(compute_syd(cost, salvage, life, per))
}

/// **W5-181 (Phase 4.10 polish / Wave 3 depreciation batch):**
/// double-declining-balance depreciation per Microsoft + IronCalc.
/// `DDB(cost, salvage, life, period, [factor=2])` — accelerated
/// depreciation where the rate is `factor / life` (capped at 1.0).
///
/// Closed-form despite the name (no period iteration):
/// - `rate = min(factor / life, 1)`.
/// - If `rate == 1`: value at start of `period` is `cost` when
///   `period == 1`, otherwise `0`.
/// - Else: `value = cost · (1 − rate)^(period − 1)`.
/// - `new_value = cost · (1 − rate)^period`.
/// - `result = max(value − max(salvage, new_value), 0)`.
///   The `max(salvage, new_value)` floor ensures depreciation stops
///   once the asset reaches salvage (Excel canon — diverges from
///   pure DDB which can over-depreciate).
///
/// Per IronCalc + Microsoft: `period > life`, `cost < 0`,
/// `salvage < 0`, `period <= 0`, or `factor <= 0` → `#NUM!`.
/// **Engine convention note:** IronCalc uses `get_number_no_bools`
/// for the `factor` arg only (rejects Boolean); our `arg_num`
/// allows Boolean coercion uniformly across all args. Deliberate
/// divergence for consistency with the rest of the financial family.
///
/// **Microsoft-canon divergence (W5-182.1 Opus MEDIUM-9 closure):**
/// Microsoft's DDB doc states "All five arguments must be positive
/// numbers." We follow IronCalc in accepting `cost == 0` (returns 0)
/// and `salvage == 0` (allows full depreciation to zero). Both
/// produce sensible numeric results rather than `#NUM!`.
pub(crate) fn compute_ddb(
    cost: f64,
    salvage: f64,
    life: f64,
    period: f64,
    factor: f64,
) -> Result<f64, ErrorValue> {
    if period > life || cost < 0.0 || salvage < 0.0 || period <= 0.0 || factor <= 0.0 {
        return Err(ErrorValue::Num);
    }
    let mut rate = factor / life;
    if rate > 1.0 {
        rate = 1.0;
    }
    let value = if rate == 1.0 {
        if period == 1.0 {
            cost
        } else {
            0.0
        }
    } else {
        cost * (1.0 - rate).powf(period - 1.0)
    };
    let new_value = cost * (1.0 - rate).powf(period);
    Ok(f64::max(value - f64::max(salvage, new_value), 0.0))
}

/// **W5-182 (Phase 4.10 polish / Wave 3 depreciation batch):**
/// fixed-declining-balance depreciation per Microsoft + IronCalc.
/// `DB(cost, salvage, life, period, [month=12])`.
///
/// Unlike DDB (closed-form), DB iterates period-by-period because
/// each period's depreciation depends on the accumulated book-value
/// from prior periods (not just `cost · (1 − rate)^k`). The rate
/// itself uses an Excel-specific 3-decimal rounding:
///
///   `rate = round((1 − (salvage/cost)^(1/life)) · 1000) / 1000`
///
/// First period is partial (uses `month / 12` of the rate); last
/// period (when `period = life + 1` with `month ≠ 12`) is the
/// complementary partial year using `(12 − month) / 12`.
///
/// Validation per Microsoft + IronCalc + W5-182.1 audit closures:
/// - `month == 12 && period > life` → `#NUM!` (no partial last period
///   when `month = 12`, so `period = life + 1` only valid for
///   `month < 12`).
/// - `period > life + 1` → `#NUM!`.
/// - `month <= 0` or `month > 12` → `#NUM!`.
/// - `period < 1` → `#NUM!` (W5-182.1: tightened from `<= 0`; fractional
///   `period in (0, 1)` previously slipped past and silently returned
///   period-2's depreciation).
/// - `cost < 0` → `#NUM!`.
/// - `life < 1` → `#NUM!` (W5-182.1: Codex caught `DB(1000, 100, 0, 1, 7)`
///   returning 583.33; Opus caught `DB(1000, 100, 0.5, 1, 6)` returning
///   495. The rate calculation handles `1/0 → ∞` cleanly in Rust IEEE
///   and fractional life under 1 gives `(salvage/cost)^(1/0.5) = ^2`
///   which produces a weird-but-finite rate. Both rejected here per
///   Microsoft's "number of periods" implication. Fractional `life > 1`
///   is still accepted — see "Fractional-life inheritance" below.).
/// - `life > i32::MAX || period > i32::MAX` → `#NUM!` (W5-182.1: defensive
///   DoS guard; `life.floor() as i32` saturates and the iteration loop
///   would otherwise run billions of times. Soundness divergence from
///   IronCalc which has the same overflow).
/// - `cost == 0` → return `0` directly (short-circuit before the
///   `(salvage/cost)` division would NaN).
///
/// **Engine convention note (matches DDB factor divergence):** IronCalc
/// uses `get_number_no_bools` for the `month` arg (rejects Boolean);
/// our `arg_num` allows Boolean coercion uniformly across all five args.
/// `DB(_, _, _, _, TRUE)` evaluates as `month = 1` here, but `#VALUE!`
/// in IronCalc. Same family convention as the DDB `factor` divergence.
///
/// **Fractional-life inheritance from IronCalc (MEDIUM-4 from Opus
/// audit):** rate is computed with raw `life`; iteration count and
/// last-period detection use `life.floor() as i32`. For `life = 5.99`
/// the rate is a 5.99-year rate but the schedule is a 5-year schedule.
/// Documented as inherited IronCalc quirk rather than fixed because
/// Excel's true behavior for fractional life is unverified.
pub(crate) fn compute_db(
    cost: f64,
    salvage: f64,
    life: f64,
    period: f64,
    month: f64,
) -> Result<f64, ErrorValue> {
    // **W5-182.1 (Codex HIGH-1 / Opus MEDIUM-5 + MEDIUM-6 + MEDIUM-7
    // closures):** the original validation chain (a verbatim port of
    // IronCalc) missed `life <= 0`, `period < 1` (which only `period <= 0`
    // covered for the integer case), and extreme inputs that overflow
    // `i32`. Three audit-driven additions:
    //
    // 1. `life <= 0` — Codex repro `DB(1000, 100, 0, 1, 7)` returned
    //    583.33 because `(0.1)^(1/0) → 0`, so `rate → 1`. Now `#NUM!`.
    // 2. `period < 1.0` — Opus repro `DB(1000, 100, 5, 0.5, 12)` returned
    //    period-2's value (232.74) silently because `0.5.floor() == 0`
    //    fell through both `period_int == 1` and `period_int == life_int + 1`.
    // 3. `life > i32::MAX as f64 || period > i32::MAX as f64` — Opus
    //    repro `DB(_, _, 1e15, _, _)` saturated `life_int` to `i32::MAX`,
    //    making `life_int + 1` panic in debug / wrap in release. Adding
    //    a finite-input guard is a deliberate divergence from IronCalc
    //    (they have the same overflow). Soundness > IronCalc fidelity.
    if (month == 12.0 && period > life)
        || period > life + 1.0
        || month <= 0.0
        || month > 12.0
        || period < 1.0
        || cost < 0.0
        || life < 1.0
        || life >= i32::MAX as f64
        || period >= i32::MAX as f64
    {
        return Err(ErrorValue::Num);
    }
    if cost == 0.0 {
        return Ok(0.0);
    }
    // Excel's 3-decimal rate rounding — peculiar but canonical.
    // Without the round, the cumulative-through-life would equal
    // exactly `cost − salvage`; the rounding deliberately introduces
    // a small per-period error that the last-partial-period absorbs.
    let rate = ((1.0 - (salvage / cost).powf(1.0 / life)) * 1000.0).round() / 1000.0;

    // First-period depreciation (partial: month/12 fraction).
    let mut accumulated = cost * rate * month / 12.0;
    let period_int = period.floor() as i32;
    let life_int = life.floor() as i32;

    if period_int == 1 {
        return Ok(accumulated);
    }

    // Iterate (period - 2) times so `accumulated` ends up as the
    // cumulative depreciation through period (k − 1).
    for _ in 0..(period_int - 2) {
        accumulated += (cost - accumulated) * rate;
    }

    if period_int == life_int + 1 {
        // Last partial period — complementary (12 − month)/12 fraction.
        return Ok((cost - accumulated) * rate * (12.0 - month) / 12.0);
    }
    Ok(rate * (cost - accumulated))
}

/// **W5-182:** `DB(cost, salvage, life, period, [month=12])` —
/// fixed-declining-balance depreciation. Four required args;
/// `month` optional (default 12). Truncates `month` to integer
/// per Microsoft + IronCalc.
pub fn db(args: &[Value]) -> Value {
    if !(4..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let cost = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let salvage = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let life = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let period = match arg_num(&args[3]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let month = if args.len() == 5 {
        match arg_num(&args[4]) {
            Ok(n) => n.trunc(),
            Err(e) => return Value::Error(e),
        }
    } else {
        12.0
    };
    finish(compute_db(cost, salvage, life, period, month))
}

/// **W5-183 (Phase 4.10 polish / CLOSES Wave 3 depreciation batch):**
/// variable-declining-balance depreciation per Microsoft canon.
/// `VDB(cost, salvage, life, start_period, end_period, [factor=2],
/// [no_switch=FALSE])`.
///
/// Most complex of the depreciation batch — period-iteration with
/// DDB-to-SLN crossover. IronCalc has it in docs nav but NOT in
/// Rust source (only stubbed); algorithm ported from Microsoft
/// docs examples + the canonical period-iteration form.
///
/// ## Algorithm
///
/// For each period `i` from 0 to `ceil(end_period) - 1`:
///   1. Compute DDB depreciation: `min(book * (factor/life), book − salvage)`,
///      floored at 0.
///   2. If `!no_switch` and SLN-from-here `(book − salvage) / max(life − i, 1)`
///      exceeds the DDB amount: switch to SLN permanently from this
///      period onward (lock in the SLN per-period amount at the
///      moment of switch). The `max(_, 1)` floor matters only for
///      fractional `life` (W5-183.1 Opus MEDIUM-1).
///   3. Compute overlap fraction `[max(i, start), min(i+1, end)]`.
///      Add `(overlap * period_dep)` to the total.
///   4. Subtract the FULL `period_dep` from `book` (not the overlap
///      fraction — depreciation continues whether or not the period
///      is in the requested range).
///
/// ## Validation (Microsoft: "All arguments except no_switch must be
/// positive numbers" — augmented per W5-183.1 audit closures)
///
/// - `cost < 0`, `salvage < 0`, `life <= 0`, `factor <= 0` → `#NUM!`.
/// - `salvage > cost` → `#NUM!` (W5-183.1 Codex HIGH-1: LibreOffice +
///   OpenFormula reject; previously silently returned `0` because
///   `book - salvage < 0` clamped DDB to `0` and the negative SLN
///   check never triggered a switch). `salvage == cost` returns `0`
///   (no depreciation possible) — the rule is `>`, not `>=`.
/// - `start_period < 0` or `end_period < start_period` → `#NUM!`.
/// - `end_period > life` → `#NUM!` (depreciation beyond the asset's
///   life is undefined).
/// - `life >= i32::MAX` or `end_period >= i32::MAX` → `#NUM!` (W5-183.1
///   Opus HIGH-1 / Codex MEDIUM-1: DoS guard tightened from `>` to `>=`.
///   Exactly `i32::MAX as f64` previously passed validation, then
///   `end_ceil = i32::MAX`, then the loop ran ~2.15 billion times
///   per cell. Same off-by-one corrected in `compute_db` this commit.).
/// - `cost == 0` short-circuits to `0` (W5-183.1 Opus LOW-1: motive
///   is "no depreciation possible from a zero-cost asset"; unlike DB
///   there's no `salvage/cost` division to guard against NaN).
/// - `start_period == end_period` returns `0` (empty range).
///
/// **Engine convention** (matches DDB / DB family): all numeric args
/// use `arg_num` which accepts Boolean coercion (TRUE→1, FALSE→0);
/// `no_switch` uses `arg_type` which extends `arg_num` with explicit
/// boolean semantics (non-zero numeric → TRUE; blank → FALSE; errors
/// propagate). This is **not** "Boolean-strict" — Boolean inputs
/// pass through naturally but numeric coercion is also accepted
/// (W5-183.1 Opus MEDIUM-2 / Codex LOW-2 — corrected from prior
/// "Boolean-strict" wording).
///
/// **Microsoft-canon divergence (W5-183.1 Opus MEDIUM-8):** Microsoft
/// VDB doc says "All arguments except no_switch must be positive
/// numbers." We follow the DDB family in accepting `cost == 0` and
/// `salvage == 0` (both return sensible numeric results).
pub(crate) fn compute_vdb(
    cost: f64,
    salvage: f64,
    life: f64,
    start_period: f64,
    end_period: f64,
    factor: f64,
    no_switch: bool,
) -> Result<f64, ErrorValue> {
    // **W5-183.1 audit closures:**
    // - `salvage > cost` rejection (Codex HIGH-1) — LibreOffice +
    //   OpenFormula reject; previously silently returned 0 because
    //   `book - salvage < 0` clamps DDB to 0 and the negative SLN
    //   check never triggers a switch.
    // - DoS guard tightened `>` → `>=` (Opus HIGH-1 / Codex MEDIUM-1).
    //   Exactly `i32::MAX as f64` previously passed validation, then
    //   `end_ceil = i32::MAX`, then the loop ran ~2.15 billion times
    //   per cell. Same off-by-one fixed in `compute_db` this commit.
    if cost < 0.0
        || salvage < 0.0
        || salvage > cost
        || life <= 0.0
        || start_period < 0.0
        || end_period < start_period
        || end_period > life
        || factor <= 0.0
        || life >= i32::MAX as f64
        || end_period >= i32::MAX as f64
    {
        return Err(ErrorValue::Num);
    }
    if start_period == end_period {
        return Ok(0.0);
    }
    if cost == 0.0 {
        return Ok(0.0);
    }

    let rate = factor / life;
    let mut book = cost;
    let mut total = 0.0_f64;
    let mut switched_to_sln = false;
    let mut sln_per_period = 0.0_f64;

    let end_ceil = end_period.ceil() as i32;

    for period in 0..end_ceil {
        let period_f = period as f64;

        // DDB depreciation for this period, capped by remaining book
        // above salvage (salvage floor — matches our DDB impl).
        let ddb_period = (book * rate).min(book - salvage).max(0.0);

        // Determine actual depreciation amount with DDB → SLN switch.
        let period_dep = if no_switch {
            ddb_period
        } else {
            // Periods remaining including this one. The `.max(1.0)`
            // floor matters for FRACTIONAL `life`: integer life
            // guarantees `period <= life - 1` so `life - period >= 1`,
            // but for `life = 4.5` the last iteration has
            // `period_f = 4` and `life - 4 = 0.5 < 1` (W5-183.1
            // Opus MEDIUM-1 closure — corrects the prior comment
            // that claimed the floor was redundant).
            let periods_remaining = (life - period_f).max(1.0);
            let sln_now = (book - salvage) / periods_remaining;

            if !switched_to_sln && sln_now > ddb_period {
                switched_to_sln = true;
                sln_per_period = sln_now;
            }

            if switched_to_sln {
                sln_per_period
            } else {
                ddb_period
            }
        };

        // Overlap of this period [period_f, period_f+1] with the
        // requested range [start_period, end_period].
        let overlap_start = period_f.max(start_period);
        let overlap_end = (period_f + 1.0).min(end_period);
        let overlap = (overlap_end - overlap_start).max(0.0);

        total += period_dep * overlap;

        // Book depletes by the full period's depreciation (not just
        // the overlap fraction) — depreciation accrues whether or not
        // the period is in the requested range.
        book -= period_dep;
        // Defensive floor (DDB salvage cap should keep this redundant,
        // but float drift over many periods could overshoot).
        if book < salvage {
            book = salvage;
        }
    }

    Ok(total)
}

/// **W5-183:** `VDB(cost, salvage, life, start_period, end_period,
/// [factor=2], [no_switch=FALSE])`. Five required args; `factor` +
/// `no_switch` optional.
pub fn vdb(args: &[Value]) -> Value {
    if !(5..=7).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let cost = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let salvage = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let life = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let start_period = match arg_num(&args[3]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let end_period = match arg_num(&args[4]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let factor = if args.len() >= 6 {
        match arg_num(&args[5]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        2.0
    };
    let no_switch = if args.len() == 7 {
        match arg_type(&args[6]) {
            Ok(b) => b,
            Err(e) => return Value::Error(e),
        }
    } else {
        false
    };
    finish(compute_vdb(
        cost,
        salvage,
        life,
        start_period,
        end_period,
        factor,
        no_switch,
    ))
}

/// **W5-181:** `DDB(cost, salvage, life, period, [factor=2])`.
/// Four required args; `factor` optional (default 2 = double-
/// declining-balance; pass 1 for single-declining-balance, etc).
pub fn ddb(args: &[Value]) -> Value {
    if !(4..=5).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let cost = match arg_num(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let salvage = match arg_num(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let life = match arg_num(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let period = match arg_num(&args[3]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let factor = if args.len() == 5 {
        match arg_num(&args[4]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        2.0
    };
    finish(compute_ddb(cost, salvage, life, period, factor))
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
            // **W5-171 (Codex HIGH-1):** Per Microsoft + IronCalc: IRR
            // IGNORES text and logical cells (same as NPV). Earlier draft
            // rejected with #VALUE! — incorrect.
            let mut out = Vec::new();
            for v in values {
                match v {
                    Value::Number(n) => out.push(*n),
                    Value::Blank => {} // skip
                    Value::Error(e) => return Value::Error(*e),
                    _ => {} // skip text/bool per Excel canon
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

/// **W5-174 (Phase 4.10 polish):** `MIRR(values, finance_rate,
/// reinvest_rate)` — Modified Internal Rate of Return. Like `IRR`
/// but uses separate rates for negative (financing) and positive
/// (reinvestment) cash flows. RangeAwareFn: first arg MUST be a
/// range; scalar `finance_rate` + `reinvest_rate` follow.
///
/// Excel canon: range must contain at least one positive AND one
/// negative cash flow (otherwise `#DIV/0!`). Text + Boolean + Blank
/// cells in the range are SKIPPED per the IRR/NPV convention
/// (W5-171 closure pattern).
pub fn mirr(args: &[FnArg]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let values = match &args[0] {
        FnArg::Range { values, .. } => {
            let mut out = Vec::new();
            for v in values {
                match v {
                    Value::Number(n) => out.push(*n),
                    Value::Blank => {} // skip per Excel canon
                    Value::Error(e) => return Value::Error(*e),
                    _ => {} // skip text/bool per Excel canon
                }
            }
            out
        }
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    if values.is_empty() {
        return Value::Error(ErrorValue::Num);
    }
    let finance_rate = match &args[1] {
        FnArg::Scalar(v) => match arg_num(v) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        },
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    let reinvest_rate = match &args[2] {
        FnArg::Scalar(v) => match arg_num(v) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        },
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    finish(compute_mirr(&values, finance_rate, reinvest_rate))
}

// ===== B2 (native quant fns): SHARPE / MAX_DRAWDOWN =====
//
// The cheapest tangible "beyond-Excel" win: native, range-aware quant
// functions that build directly on the engine's existing numerically-stable
// stddev/mean primitives (`crate::welford`) rather than reimplementing the
// math. Both are range-aware aggregates — the first arg MUST bind as a
// `FnArg::Range` (admitted to `is_aggregate_function` via the Phase-1.5
// `ArgContext::Aggregate` override list in `registry.rs`, otherwise the range
// collapses to an implicitly-intersected scalar at bind time).
//
// **Coercion canon (matches NPV/IRR/MIRR — W5-171):** within the data range,
// blank / text / boolean cells are SKIPPED; a cell error propagates as the
// function result. This is the documented Excel-financial convention reused
// verbatim — a returns series with a stray label row or a blank gap behaves
// like Excel's NPV/IRR rather than erroring on the whole range.

/// Collect the numeric values of a single range argument, applying the
/// NPV/IRR coercion canon (skip blank/text/bool, propagate cell errors).
/// `Ok(values)` preserves source order (row-major flatten of the range);
/// a scalar arg is rejected with `#VALUE!` (these functions operate on a
/// series, not a single value).
///
/// **Codex MED (B2 audit) — No-Fallbacks:** a non-finite numeric cell
/// (`NaN` / `±Inf`) is surfaced loudly as `#NUM!` rather than carried into
/// the kernel. `finish()` only sanitizes the *final* result, so a non-finite
/// input that produces a finite-but-bogus intermediate (e.g. `Inf/Inf = NaN`
/// in the drawdown ratio, then ignored by a `<` comparison) would otherwise
/// escape unnoticed. Rejecting at ingestion keeps the contract honest: the
/// inputs to a Sharpe/drawdown statistic must be real, finite numbers.
fn collect_series(arg: &FnArg) -> Result<Vec<f64>, ErrorValue> {
    match arg {
        FnArg::Range { values, .. } => {
            let mut out = Vec::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Number(n) => {
                        if !n.is_finite() {
                            return Err(ErrorValue::Num); // No-Fallbacks: NaN/Inf is bad data
                        }
                        out.push(*n);
                    }
                    Value::Blank => {}                 // skip per Excel canon
                    Value::Error(e) => return Err(*e), // propagate
                    _ => {}                            // skip text/bool per Excel canon
                }
            }
            Ok(out)
        }
        FnArg::Scalar(_) => Err(ErrorValue::Value),
    }
}

/// **B2:** `SHARPE` core — the (ex-post) Sharpe ratio of a periodic return
/// series.
///
/// Definition (Sharpe 1966 "Mutual Fund Performance"; revised Sharpe 1994
/// "The Sharpe Ratio", J. Portfolio Management):
///
/// ```text
/// SR = mean(R - Rf) / stdev(R)
/// ```
///
/// where `R` is the per-period return series and `Rf` is the (constant)
/// per-period risk-free rate. Since `Rf` is constant, `mean(R - Rf) =
/// mean(R) - Rf`, so we subtract `Rf` from the mean of returns rather than
/// from every element.
///
/// **Decisions (documented contract):**
/// - **Sample** standard deviation (Bessel-corrected, denominator `n-1`) — the
///   ex-post Sharpe estimated from a *sample* of returns; matches Excel
///   `STDEV.S` and the quant-standard estimator. Reuses
///   `crate::welford::sample_stdev` (NIST-numacc-accurate two-pass).
/// - **Annualization:** if `periods_per_year` is provided (> 0), the ratio is
///   scaled by `sqrt(periods_per_year)` — the standard Sharpe annualization
///   (a per-period Sharpe times √frequency). Omitted ⇒ raw per-period Sharpe.
/// - `Rf` is interpreted as a per-period rate matching the return series'
///   frequency (not annualized internally — the caller supplies it in the
///   series' own units).
///
/// **Errors (No-Fallbacks):**
/// - empty series (0 numeric values) ⇒ `#NUM!`
/// - `n < 2` (sample stdev undefined) ⇒ `#DIV/0!` (mirrors CONFIDENCE.T)
/// - zero dispersion (`stdev == 0`, a constant series) ⇒ `#DIV/0!`
/// - `periods_per_year <= 0` ⇒ `#NUM!` (a non-positive frequency has no √)
fn compute_sharpe(
    returns: &[f64],
    risk_free: f64,
    periods_per_year: Option<f64>,
) -> Result<f64, ErrorValue> {
    if returns.is_empty() {
        return Err(ErrorValue::Num);
    }
    if returns.len() < 2 {
        return Err(ErrorValue::DivZero);
    }
    let sd = match crate::welford::sample_stdev(returns) {
        Some(sd) => sd,
        None => return Err(ErrorValue::DivZero), // n < 2 (already guarded)
    };
    // **Codex HIGH (Wave A audit) -- sibling-class fix.** `sample_stdev`'s
    // two-pass `Σ(x-mean)^2` OVERFLOWS to `+Inf` for large-but-finite returns
    // (`(5e199)^2`). With sd=Inf the ratio `mean/Inf` is a finite `-0.0` that
    // `finish()` would silently accept -- a wrong result, not a visible error.
    // Surface it loudly as #NUM! (No-Fallbacks). SHARPE shares `welford` with
    // STDEV.S, so unlike SORTINO's self-contained downside it cannot cheaply
    // recover the true extreme value without diverging from STDEV.S; erroring
    // matches VOLATILITY (whose Inf stdev also `finish()`-resolves to #NUM!).
    if !sd.is_finite() {
        return Err(ErrorValue::Num);
    }
    if sd == 0.0 {
        return Err(ErrorValue::DivZero);
    }
    let mean = match crate::welford::mean(returns) {
        Some(m) => m,
        None => return Err(ErrorValue::Num), // empty (already guarded)
    };
    let mut sr = (mean - risk_free) / sd;
    if let Some(ppy) = periods_per_year {
        if ppy <= 0.0 {
            return Err(ErrorValue::Num);
        }
        sr *= ppy.sqrt();
    }
    Ok(sr)
}

/// **B2:** `MAX_DRAWDOWN` core — the maximum peak-to-trough decline of an
/// equity / price / NAV series.
///
/// Definition (Bacon, "Practical Portfolio Performance Measurement and
/// Attribution", 2nd ed.; the same quantity `empyrical.max_drawdown` reports):
///
/// ```text
/// MDD = min_t ( value_t / running_peak_t  -  1 )
/// ```
///
/// **Decisions (documented contract):**
/// - **Input is an equity / price level series** (a NAV / cumulative-value
///   curve), NOT a periodic-return series. We compute the running peak and the
///   largest fractional decline from it. (Compounding a returns series first is
///   a deliberately-deferred follow-on — see the plan; here the series is the
///   level itself, which is the conventional MDD input.)
/// - **Sign convention: a negative fraction.** A 25% peak-to-trough loss
///   returns `-0.25`; a monotonically non-decreasing series returns `0.0`.
///   This matches empyrical / common quant tooling (drawdown is a loss, so it
///   is signed negative).
///
/// **Errors (No-Fallbacks) — Codex LOW (B2 audit) closure, doc + impl aligned:**
/// - empty series (0 numeric values) ⇒ `#NUM!`
/// - a **negative** level (`value < 0`) is invalid data for a price/NAV series
///   ⇒ `#NUM!`. Without this guard a negative trough after a positive peak
///   would silently produce a drawdown below `-100%` (a meaningless ratio).
/// - a non-positive running **peak** (`peak <= 0`, i.e. the first level is `0`)
///   makes the fractional decline undefined (division by a non-positive
///   level) ⇒ `#DIV/0!`.
/// - a level of exactly `0` *after* a positive peak is a legitimate full loss
///   ⇒ contributes `-1.0` (a 100% drawdown); it is NOT rejected. So the only
///   accepted levels are `>= 0`, with `0` meaningful only once a positive peak
///   exists.
fn compute_max_drawdown(series: &[f64]) -> Result<f64, ErrorValue> {
    if series.is_empty() {
        return Err(ErrorValue::Num);
    }
    let mut peak = f64::NEG_INFINITY;
    let mut max_dd = 0.0_f64; // most-negative drawdown seen (0 if never below peak)
    for &v in series {
        // A negative price/NAV level is invalid input — surface loudly so a
        // sub-(-100%) drawdown can never be silently produced.
        if v < 0.0 {
            return Err(ErrorValue::Num);
        }
        if v > peak {
            peak = v;
        }
        // The first element sets the peak to itself ⇒ dd = 0 there. A
        // non-positive peak (first level == 0) makes the ratio undefined.
        if peak <= 0.0 {
            return Err(ErrorValue::DivZero);
        }
        let dd = v / peak - 1.0; // in [-1, 0]
        if dd < max_dd {
            max_dd = dd;
        }
    }
    Ok(max_dd)
}

/// **B2 (Wave A):** `VOLATILITY` core — the (ex-post) volatility of a periodic
/// return series: its sample standard deviation, optionally annualized.
///
/// Definition:
///
/// ```text
/// VOL = stdev(R)                          (raw, per-period)
/// VOL = stdev(R) * sqrt(periods_per_year) (annualized)
/// ```
///
/// **Decisions (documented contract):**
/// - **Sample** standard deviation (Bessel-corrected, denominator `n-1`) — the
///   SAME estimator SHARPE's denominator uses (`crate::welford::sample_stdev`,
///   matching Excel `STDEV.S`), so `=VOLATILITY(R)` equals SHARPE's risk term.
/// - **Annualization:** if `periods_per_year` is provided (> 0), the stdev is
///   scaled by `sqrt(periods_per_year)` — the standard √-frequency scaling.
///
/// **Errors (No-Fallbacks):**
/// - empty series (0 numeric values) ⇒ `#NUM!`
/// - `n < 2` (sample stdev undefined) ⇒ `#DIV/0!` (matches Excel `STDEV.S`
///   and SHARPE's `n < 2` guard)
/// - `periods_per_year <= 0` ⇒ `#NUM!`
///
/// **Distinct from SHARPE:** a CONSTANT series (`stdev == 0`) is NOT an error —
/// zero volatility is a legitimate, meaningful statistic (a flat return
/// stream), so this returns `0.0`. SHARPE rejects `stdev == 0` only because it
/// is the *denominator* of the ratio; here it is the result itself.
fn compute_volatility(returns: &[f64], periods_per_year: Option<f64>) -> Result<f64, ErrorValue> {
    if returns.is_empty() {
        return Err(ErrorValue::Num);
    }
    if returns.len() < 2 {
        return Err(ErrorValue::DivZero);
    }
    let mut sd = match crate::welford::sample_stdev(returns) {
        Some(sd) => sd,
        None => return Err(ErrorValue::DivZero), // n < 2 (already guarded)
    };
    // A constant series ⇒ sd == 0.0, returned as-is (NOT an error): zero
    // volatility is a valid answer, unlike SHARPE's zero denominator.
    if let Some(ppy) = periods_per_year {
        if ppy <= 0.0 {
            return Err(ErrorValue::Num);
        }
        sd *= ppy.sqrt();
    }
    Ok(sd)
}

/// **B2 (Wave A):** `SORTINO` core — the (ex-post) Sortino ratio of a periodic
/// return series: excess return per unit of DOWNSIDE deviation.
///
/// Definition (Sortino & Price 1994; the downside term matches
/// `empyrical.downside_risk` / `empyrical.sortino_ratio`):
///
/// ```text
/// SR_sortino = (mean(R) - MAR) / DD
/// DD         = sqrt( (1/N) * Σ_i min(0, R_i - MAR)^2 )
/// ```
///
/// where `R` is the per-period return series and `MAR` is the (constant)
/// minimum acceptable return / target return. Since `MAR` is constant,
/// `mean(R - MAR) = mean(R) - MAR`, so we subtract `MAR` from the mean rather
/// than from every element (mirrors SHARPE's risk-free handling).
///
/// **Decisions (documented contract):**
/// - **Downside deviation `DD`** uses the empyrical convention: square only the
///   *downside* shortfalls `min(0, R_i - MAR)` (an upside period contributes
///   `0`), average over **ALL `N`** observations (NOT just the downside ones —
///   a population-style denominator `N`, matching `empyrical.downside_risk`),
///   then take the root. Accumulated with a scaled sum-of-squares (factor out
///   `max|shortfall|`) so the statistic stays correct across the full finite
///   input range — a naive `Σ shortfall^2` overflows to `+Inf` (silent wrong
///   ratio) or underflows to `0` (spurious `#DIV/0!`) for extreme magnitudes.
/// - **Annualization:** if `periods_per_year` is provided (> 0), the ratio is
///   scaled by `sqrt(periods_per_year)` — IDENTICAL to SHARPE's convention (a
///   per-period ratio times √frequency), so SORTINO and SHARPE annualize the
///   same way on the same series.
/// - `MAR` is a per-period rate in the series' own units (not annualized
///   internally), mirroring SHARPE's `Rf`.
///
/// **Errors (No-Fallbacks):**
/// - empty series (0 numeric values) ⇒ `#NUM!`
/// - `n < 2` ⇒ `#DIV/0!` (a risk-adjusted ratio from a single observation is
///   meaningless; mirrors SHARPE for a consistent quant-aggregate contract)
/// - zero downside deviation (`DD == 0`, i.e. NO period fell below `MAR`)
///   ⇒ `#DIV/0!` (the denominator vanishes — surfaced loudly, never `+Inf`).
///   Checked BEFORE `periods_per_year` so a denominator-degenerate series beats
///   a bad frequency (same precedence as SHARPE's `stdev == 0` vs `ppy`).
/// - `periods_per_year <= 0` ⇒ `#NUM!`
fn compute_sortino(
    returns: &[f64],
    mar: f64,
    periods_per_year: Option<f64>,
) -> Result<f64, ErrorValue> {
    if returns.is_empty() {
        return Err(ErrorValue::Num);
    }
    if returns.len() < 2 {
        return Err(ErrorValue::DivZero);
    }
    // `crate::welford::mean` uses the streaming (online) update -- the
    // numerically-stable choice for ordinary return data (deliberately NOT a
    // two-pass `sum/n`, which loses precision on ill-conditioned series). A
    // documented consequence at the f64 magnitude EXTREME (Wave-A audit LOW,
    // unreachable with real returns): for opposite-sign extremes like
    // `[1.7e308, -1.7e308]` the online delta overflows so `mean` is `±Inf`
    // even though a two-pass sum would cancel to a finite mean -- the guard
    // below then surfaces #NUM!. Accepted: a loud error, never a silent wrong
    // value (No-Fallbacks), and a two-pass mean would regress normal-data
    // precision for a case real return series cannot reach.
    let mean = match crate::welford::mean(returns) {
        Some(m) => m,
        None => return Err(ErrorValue::Num), // empty (already guarded)
    };
    // Numerator: mean(R) - MAR. Both finite (`collect_series` rejects non-finite
    // cells; the scalar `mar` is `sanitize_f64`-screened), but the subtraction
    // itself can overflow for extreme finite operands (e.g. mean ~ -1e308,
    // MAR ~ +1e308) -> surface loudly as #NUM! rather than carry a non-finite
    // numerator into the ratio (No-Fallbacks). NOTE (Wave-A audit LOW): at this
    // magnitude extreme the #NUM! here may PRECEDE the no-downside #DIV/0! below
    // (e.g. `[1.7e308, 1.7e308]`, MAR=-1.7e308). The documented "DD==0 ⇒ #DIV/0!
    // before ppy" precedence holds for every input with a representable mean;
    // both extreme outcomes are loud errors, so the ordering is cosmetic.
    let excess_mean = mean - mar;
    if !excess_mean.is_finite() {
        return Err(ErrorValue::Num);
    }
    let n = returns.len() as f64;
    // Downside deviation: DD = sqrt( (1/N) * Σ min(0, R_i - MAR)^2 ) -- the
    // empyrical population-style (denominator N, ALL observations) convention.
    //
    // **Codex HIGH (Wave A audit) -- overflow/underflow-safe accumulation.**
    // A naive `Σ shortfall^2` squares each shortfall directly, which OVERFLOWS
    // to +Inf for large-but-finite returns (`(-1e200)^2`), producing dd=Inf and
    // then a finite-but-WRONG ratio (mean/Inf -> -0.0) that `finish()` would
    // silently accept -- and UNDERFLOWS to 0 for tiny returns (`(-1e-200)^2`),
    // producing a spurious #DIV/0! where the true Sortino is finite. We instead
    // use the standard scaled sum-of-squares (the `hypot` / BLAS `nrm2` trick):
    // factor out `scale = max|shortfall|`, accumulate `Σ (shortfall/scale)^2`
    // (each term in [0, 1], so the sum cannot overflow -- it is <= N), then
    // `dd = scale * sqrt(ssq / N)`. This is bit-identical to the naive form on
    // ordinary inputs (the divisions are exact when shortfall is a multiple of
    // scale) but stays correct across the full finite range. `scale == 0` means
    // EVERY shortfall is 0 (no downside) -> DD == 0 -> #DIV/0!, checked BEFORE
    // `periods_per_year` (denominator-degenerate beats a bad frequency, mirroring
    // SHARPE's `stdev == 0` vs `ppy` precedence).
    let mut scale = 0.0_f64;
    for &r in returns {
        let shortfall = (r - mar).min(0.0);
        if !shortfall.is_finite() {
            return Err(ErrorValue::Num); // R_i - MAR overflowed (No-Fallbacks)
        }
        let mag = shortfall.abs();
        if mag > scale {
            scale = mag;
        }
    }
    if scale == 0.0 {
        return Err(ErrorValue::DivZero); // no downside at all -> DD == 0
    }
    let mut ssq = 0.0_f64;
    for &r in returns {
        let normalized = (r - mar).min(0.0) / scale; // in [-1, 0]
        ssq += normalized * normalized;
    }
    let dd = scale * (ssq / n).sqrt();
    if dd == 0.0 {
        // Defensive: `scale > 0` already implies at least one nonzero shortfall,
        // so dd > 0 here. Kept so a future refactor that breaks the invariant
        // surfaces loudly rather than dividing by zero.
        return Err(ErrorValue::DivZero);
    }
    let mut sr = excess_mean / dd;
    if let Some(ppy) = periods_per_year {
        if ppy <= 0.0 {
            return Err(ErrorValue::Num);
        }
        sr *= ppy.sqrt();
    }
    Ok(sr)
}

/// `SHARPE(returns_range, [risk_free_rate=0], [periods_per_year])` —
/// ex-post Sharpe ratio. See [`compute_sharpe`] for the exact semantics
/// (sample stdev, optional √-frequency annualization, error contract).
///
/// RangeAwareFn: arg 0 MUST be a range (the return series); args 1–2 are
/// scalars. A range in a scalar position, or a missing/extra arg, is
/// `#VALUE!`.
pub fn sharpe(args: &[FnArg]) -> Value {
    if !(1..=3).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let returns = match collect_series(&args[0]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let risk_free = if args.len() >= 2 {
        match &args[1] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => n,
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        0.0
    };
    let periods_per_year = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => Some(n),
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        None
    };
    finish(compute_sharpe(&returns, risk_free, periods_per_year))
}

/// `MAX_DRAWDOWN(series_range)` — maximum peak-to-trough decline of an
/// equity/price level series, as a negative fraction. See
/// [`compute_max_drawdown`] for the exact semantics + error contract.
///
/// RangeAwareFn: arg 0 MUST be a range; exactly one arg.
pub fn max_drawdown(args: &[FnArg]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let series = match collect_series(&args[0]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    finish(compute_max_drawdown(&series))
}

/// `VOLATILITY(returns_range, [periods_per_year])` — ex-post volatility (the
/// sample stdev of the return series), optionally √-frequency annualized. See
/// [`compute_volatility`] for the exact semantics + error contract.
///
/// RangeAwareFn: arg 0 MUST be a range (the return series); arg 1 (optional) is
/// a scalar. A range in a scalar position, or a missing/extra arg, is `#VALUE!`.
pub fn volatility(args: &[FnArg]) -> Value {
    if !(1..=2).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let returns = match collect_series(&args[0]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let periods_per_year = if args.len() == 2 {
        match &args[1] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => Some(n),
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        None
    };
    finish(compute_volatility(&returns, periods_per_year))
}

/// `SORTINO(returns_range, [mar=0], [periods_per_year])` — ex-post Sortino
/// ratio (excess return over downside deviation). See [`compute_sortino`] for
/// the exact semantics + error contract.
///
/// RangeAwareFn: arg 0 MUST be a range (the return series); args 1–2 are
/// scalars. A range in a scalar position, or a missing/extra arg, is `#VALUE!`.
pub fn sortino(args: &[FnArg]) -> Value {
    if !(1..=3).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let returns = match collect_series(&args[0]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let mar = if args.len() >= 2 {
        match &args[1] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => n,
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        0.0
    };
    let periods_per_year = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => Some(n),
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        None
    };
    finish(compute_sortino(&returns, mar, periods_per_year))
}

// ===== W5-D-7 (Wave 3 closure — date-indexed cash flow): XNPV / XIRR =====
//
// XNPV is closed-form. XIRR uses Newton-Raphson on XNPV's derivative
// with bisection fallback (matches IronCalc pattern in
// `financial_util.rs:178-255`).

/// **W5-D-7 (Wave 3 closure — date-indexed cash flow):** XNPV core.
/// `XNPV = Σᵢ vᵢ / (1 + rate)^((dᵢ - d₀)/365)`. Returns `#NUM!` for
/// non-finite results.
pub(crate) fn compute_xnpv(rate: f64, values: &[f64], dates: &[f64]) -> Result<f64, ErrorValue> {
    debug_assert_eq!(
        values.len(),
        dates.len(),
        "compute_xnpv requires equal-length slices"
    );
    if values.is_empty() {
        return Err(ErrorValue::Num);
    }
    let mut xnpv = values[0];
    let d0 = dates[0];
    for i in 1..values.len() {
        xnpv += values[i] / (1.0 + rate).powf((dates[i] - d0) / 365.0);
    }
    if !xnpv.is_finite() {
        return Err(ErrorValue::Num);
    }
    Ok(xnpv)
}

/// **W5-D-7 (Wave 3 closure — date-indexed cash flow):** XNPV derivative
/// w.r.t. `rate`, used by Newton-Raphson in `compute_xirr`. Matches
/// IronCalc's `compute_xnpv_prime`.
fn compute_xnpv_prime(rate: f64, values: &[f64], dates: &[f64]) -> Result<f64, ErrorValue> {
    debug_assert_eq!(values.len(), dates.len());
    let mut deriv = 0.0;
    let d0 = dates[0];
    for i in 1..values.len() {
        let ratio = (dates[i] - d0) / 365.0;
        let power = (1.0 + rate).powf(ratio + 1.0);
        deriv -= values[i] * ratio / power;
    }
    if !deriv.is_finite() {
        return Err(ErrorValue::Num);
    }
    Ok(deriv)
}

/// **W5-D-7 (Wave 3 closure):** Newton-Raphson driver for XIRR.
///
/// **W5-D-7.1 (Codex HIGH-1 closure):** the IronCalc-port version
/// accepted convergence solely on step size (`|new_xirr - xirr| < 1e-7`).
/// That admits a non-root near the singularity at `rate = -1`, where
/// the derivative blows up and the Newton step is tiny even when the
/// residual is enormous. Codex repro: `values=[-100, 1000]`,
/// `dates=[40000, 40365]`, `guess=-0.999999999` → returns
/// `-0.999999998` (residual ≈ 5e11) when the true root is `9.0`.
///
/// Fix: require BOTH step-size convergence AND a residual check
/// (`|XNPV(new_xirr)| < residual_eps`) before returning Ok. If the
/// step is tiny but the residual is still large, signal Err so the
/// outer `compute_xirr` falls back to bisection.
///
/// **Intentional divergence from IronCalc** to protect financial
/// correctness — IronCalc has the same bug (no residual check) and
/// would return the wrong rate on this input. Same pattern as the
/// W5-D-4 BINOM.INV and W5-D-5 GAMMA.INV closures: diverge from
/// IronCalc when needed to avoid producing nonsense values.
fn xirr_newton(values: &[f64], dates: &[f64], guess: f64) -> Result<f64, ErrorValue> {
    let mut xirr = guess;
    let max_iterations = 100;
    let step_eps = 1e-7;
    let residual_eps = 1e-6;
    for _ in 1..=max_iterations {
        let f = compute_xnpv(xirr, values, dates)?;
        let f_prime = compute_xnpv_prime(xirr, values, dates)?;
        if f_prime == 0.0 {
            return Err(ErrorValue::Num);
        }
        let new_xirr = xirr - f / f_prime;
        if (new_xirr - xirr).abs() < step_eps {
            // Step is tiny — but verify the residual is actually small
            // at the candidate root. Near the rate=-1 singularity, the
            // step can be tiny while the residual is huge; reject and
            // let the outer fn fall back to bisection.
            let residual = compute_xnpv(new_xirr, values, dates)?;
            if residual.abs() < residual_eps {
                return Ok(new_xirr);
            }
            return Err(ErrorValue::Num);
        }
        xirr = new_xirr;
    }
    Err(ErrorValue::Num)
}

/// **W5-D-7 (Wave 3 closure — date-indexed cash flow):** XIRR core.
/// Newton-Raphson from `guess`; falls back to bisection on
/// `[-0.9999, 100]`; if that fails (no sign change in interval),
/// tries Newton-Raphson at `guess=200`. Matches IronCalc's `compute_xirr`.
pub(crate) fn compute_xirr(values: &[f64], dates: &[f64], guess: f64) -> Result<f64, ErrorValue> {
    // **W5-D-7.1 (Opus LOW closure):** NaN guess slips past
    // `guess <= -1.0` because all NaN comparisons return false.
    // Reject explicitly so NaN doesn't silently propagate into
    // Newton-Raphson (which would diverge to NaN or oscillate).
    if guess.is_nan() || guess <= -1.0 {
        return Err(ErrorValue::Value);
    }
    // Need at least one positive AND one negative cash flow.
    let all_non_neg = values.iter().all(|&x| x >= 0.0);
    let all_non_pos = values.iter().all(|&x| x <= 0.0);
    if all_non_neg || all_non_pos {
        return Err(ErrorValue::Num);
    }
    if let Ok(r) = xirr_newton(values, dates, guess) {
        return Ok(r);
    }
    // Bisection fallback in [-0.9999, 100].
    let x1 = -0.9999;
    let x2 = 100.0;
    let f1 = compute_xnpv(x1, values, dates)?;
    let f2 = compute_xnpv(x2, values, dates)?;
    if f1 * f2 > 0.0 {
        // Root not in interval; try Newton-Raphson at very large guess.
        if let Ok(r) = xirr_newton(values, dates, 200.0) {
            return Ok(r);
        }
        return Err(ErrorValue::Num);
    }
    let (mut rtb, mut dx) = if f1 < 0.0 {
        (x1, x2 - x1)
    } else {
        (x2, x1 - x2)
    };
    let eps = 1e-8;
    let max_iterations = 50;
    for _ in 1..max_iterations {
        dx *= 0.5;
        let x_mid = rtb + dx;
        let f_mid = compute_xnpv(x_mid, values, dates)?;
        if f_mid <= 0.0 {
            rtb = x_mid;
        }
        if f_mid.abs() < eps || dx.abs() < eps {
            return Ok(x_mid);
        }
    }
    Err(ErrorValue::Num)
}

/// **W5-D-7 collection helper for XNPV**: extracts numeric values from
/// a range. Per IronCalc's `get_array_of_numbers_xpnv`: empty cells
/// always reject with `#NUM!`; non-number cells reject with the
/// caller-specified error class. Errors in the range propagate.
/// No skipping — XNPV needs paired numeric vectors.
///
/// **W5-D-7.1 (Codex MEDIUM-2 + Opus MEDIUM-O-1 closure):** IronCalc
/// distinguishes the two XNPV args by error class for non-numeric
/// cells:
///
/// - `values` arg → non-numeric → `#NUM!`.
/// - `dates` arg → non-numeric → `#VALUE!`.
///
/// The prior unified `#NUM!` for both was an IronCalc-parity drift
/// caught by both auditors. `non_numeric_err` parameterizes the error
/// class so the two call sites get the right Excel-canon error.
fn collect_xnpv_range(arg: &FnArg, non_numeric_err: ErrorValue) -> Result<Vec<f64>, ErrorValue> {
    let values = match arg {
        FnArg::Range { values, .. } => values,
        FnArg::Scalar(_) => return Err(ErrorValue::Value),
    };
    let mut out = Vec::with_capacity(values.len());
    for v in values.iter() {
        match v {
            Value::Number(n) => out.push(*n),
            Value::Error(e) => return Err(*e),
            // Empty cells always reject with #NUM! (IronCalc canon).
            Value::Blank => return Err(ErrorValue::Num),
            // Non-numeric: error class depends on which arg this is
            // (values: #NUM!; dates: #VALUE!).
            _ => return Err(non_numeric_err),
        }
    }
    Ok(out)
}

/// **W5-D-7 collection helper for XIRR**: extracts numeric values from
/// a range. Per IronCalc's `get_array_of_numbers_xirr`: empty cells
/// become `0.0`; non-number cells (Text/Boolean) reject with #VALUE!.
/// Errors propagate.
fn collect_xirr_range(arg: &FnArg) -> Result<Vec<f64>, ErrorValue> {
    let values = match arg {
        FnArg::Range { values, .. } => values,
        FnArg::Scalar(_) => return Err(ErrorValue::Value),
    };
    let mut out = Vec::with_capacity(values.len());
    for v in values.iter() {
        match v {
            Value::Number(n) => out.push(*n),
            Value::Error(e) => return Err(*e),
            Value::Blank => out.push(0.0),
            _ => return Err(ErrorValue::Value),
        }
    }
    Ok(out)
}

/// Excel serial-date bounds. **W5-D-7.1 (Codex MEDIUM-1 + Opus
/// MEDIUM-O-2 closure):** lower bound corrected from `0.0` to `1.0`
/// to match IronCalc's `MINIMUM_DATE_SERIAL_NUMBER = 1` and our own
/// `ql-types::date` contract (serials `1..=2_958_465` map to real
/// dates; serial `0` is Excel's "1/0/1900" display oddity, not a
/// real YMD). The earlier `0.0` lower bound let blank date cells
/// (XIRR substitutes them as `0.0`) sneak through as valid schedule
/// anchors — incorrect.
const MIN_DATE_SERIAL: f64 = 1.0;
const MAX_DATE_SERIAL: f64 = 2_958_465.0;

/// **W5-D-7 shared validation**: dates same length as values; all dates
/// in Excel-serial range; no date precedes the starting date.
fn validate_xnpv_xirr_dates(values: &[f64], dates: &[f64]) -> Result<(), ErrorValue> {
    if values.len() != dates.len() {
        return Err(ErrorValue::Num);
    }
    if values.is_empty() {
        return Err(ErrorValue::Num);
    }
    let first_date = dates[0];
    for &d in dates {
        if !(MIN_DATE_SERIAL..=MAX_DATE_SERIAL).contains(&d) {
            return Err(ErrorValue::Num);
        }
        if d < first_date {
            return Err(ErrorValue::Num);
        }
    }
    Ok(())
}

/// **W5-D-7 (Wave 3 closure — CLOSES Wave 3):**
/// `XNPV(rate, values, dates)` — net present value of a cash flow
/// schedule with irregular payment periods. 3 args required.
///
/// - `rate > -1` STRICT (the `(1 + rate)^t` denominator requires
///   `1 + rate > 0`; `rate <= -1` → `#NUM!`). **W5-D-13.1 megaudit
///   Opus LOW-3 closure:** prior strict `rate > 0` was over-strict and
///   Excel-incompat. Excel accepts negative rates as long as
///   `1 + rate > 0`. Microsoft docs imply `rate > 0` for the typical
///   discount-rate semantics but actual Excel function evaluates
///   correctly for `rate ∈ (-1, 0)`.
/// - `values` + `dates` same length; both ranges; rejects empty/non-
///   numeric cells (IronCalc canon).
/// - Dates floored to integer; all dates in `[0, 2_958_465]` (Excel
///   serial-date range); no date precedes the first.
///
/// Formula:
/// ```text
/// XNPV = v₀ + Σᵢ₌₁ⁿ⁻¹ vᵢ / (1 + rate)^((dᵢ - d₀) / 365)
/// ```
pub fn xnpv(args: &[FnArg]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let rate = match &args[0] {
        FnArg::Scalar(v) => match arg_num(v) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        },
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    // **W5-D-13.1 megaudit Opus LOW-3 closure:** require `1 + rate > 0`
    // (i.e., `rate > -1`), not `rate > 0`. The math requires the
    // (1+rate)^t denominator be positive; negative rates with
    // 1+rate > 0 are mathematically defined and Excel-canonical.
    if rate <= -1.0 {
        return Value::Error(ErrorValue::Num);
    }
    // Per IronCalc canon: values-arg non-numeric → #NUM!;
    // dates-arg non-numeric → #VALUE!.
    let values = match collect_xnpv_range(&args[1], ErrorValue::Num) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let dates_raw = match collect_xnpv_range(&args[2], ErrorValue::Value) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Truncate fractional dates per IronCalc canon.
    let dates: Vec<f64> = dates_raw.iter().map(|d| d.floor()).collect();
    if let Err(e) = validate_xnpv_xirr_dates(&values, &dates) {
        return Value::Error(e);
    }
    finish(compute_xnpv(rate, &values, &dates))
}

/// **W5-D-7 (Wave 3 closure — CLOSES Wave 3):**
/// `XIRR(values, dates, [guess])` — internal rate of return for a
/// cash flow schedule with irregular payment periods. 2 or 3 args.
///
/// - `values` + `dates`: same length, both ranges. Empty cells in
///   values default to 0.0; non-numeric reject with `#VALUE!`.
/// - At least one positive AND one negative cash flow required (else
///   `#NUM!` — single-sign cash flow has no IRR).
/// - `guess > -1.0` strict; defaults to 0.1 if omitted.
/// - Newton-Raphson on `XNPV(r) = 0` from `guess`; bisection fallback
///   on `[-0.9999, 100]`; final-fallback Newton-Raphson from 200.
/// - Returns `#NUM!` if iteration fails to converge.
pub fn xirr(args: &[FnArg]) -> Value {
    if !(2..=3).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let values = match collect_xirr_range(&args[0]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let dates_raw = match collect_xirr_range(&args[1]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let dates: Vec<f64> = dates_raw.iter().map(|d| d.floor()).collect();
    let guess = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(v) => match arg_num(v) {
                Ok(n) => n,
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else {
        0.1
    };
    if let Err(e) = validate_xnpv_xirr_dates(&values, &dates) {
        return Value::Error(e);
    }
    finish(compute_xirr(&values, &dates, guess))
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

    /// **W5-171 (Codex MEDIUM-2):** RATE with guess=0 must NOT
    /// silently produce #NUM!. Near-zero iterate gets perturbed to
    /// a small epsilon to break out of the 0/0 trap.
    #[test]
    fn rate_zero_guess_perturbs_and_converges() {
        // FV grew 1000 → 1000*1.05^10 ≈ 1628.89 → rate ≈ 5%. With
        // guess=0 (would have hit 0/0 pre-fix), should still converge.
        let fv_at_5pct = 1000.0 * 1.05_f64.powi(10);
        approx(
            rate(&[n(10.0), n(0.0), n(-1000.0), n(fv_at_5pct), n(0.0), n(0.0)]),
            0.05,
            1e-4,
        );
    }

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
    fn irr_skips_text_and_bool_per_excel_canon() {
        // **W5-171 (Codex HIGH-1):** Per Microsoft + IronCalc: IRR
        // IGNORES non-numeric cells (same as NPV). Cash flow
        // [-1000, "skip", TRUE, 600, 600] effectively becomes
        // [-1000, 600, 600] → IRR ≈ 13.07%.
        let cash = r(vec![
            n(-1000.0),
            Value::text("skip"),
            Value::Boolean(true),
            n(600.0),
            n(600.0),
        ]);
        approx(irr(&[cash]), 0.13066, 1e-4);
    }

    #[test]
    fn irr_error_in_range_propagates() {
        // Errors still propagate even though text/bool are skipped.
        let cash = r(vec![n(-1000.0), Value::Error(ErrorValue::Ref), n(600.0)]);
        assert_eq!(irr(&[cash]), Value::Error(ErrorValue::Ref));
    }

    /// **W5-172 (Codex LOW-3 closure):** the previous Wave 2 audit
    /// flagged that no test exercised the bisection-fallback path —
    /// only N-R convergence + the upfront sign-change rejection were
    /// covered. This test deliberately forces N-R to fail by passing
    /// a guess (50.0) far from the true root for `[-1, 2]` (IRR=100%).
    ///
    /// At guess=50, N-R computes `new_iter ≈ 50 - 1250 = -1200` on
    /// the first step, hits the `new_rate <= -1.0` guard, returns Err.
    /// Bisection over `[-0.99999, 100]` then runs: `NPV(-0.99999) ≈
    /// 200000` (positive), `NPV(100) ≈ -0.98` (negative), so f1*f2<0
    /// and the bracketing finds rate=1.0 by halving.
    #[test]
    fn irr_bisection_fallback_when_newton_diverges() {
        let cash = r(vec![n(-1.0), n(2.0)]);
        approx(irr(&[cash, s(n(50.0))]), 1.0, 1e-6);
    }

    // --- MIRR (W5-174) ---

    /// Microsoft Excel canonical example from MIRR docs page:
    /// initial outflow $120k, five years of inflows $39k/$30k/$21k/
    /// $37k/$46k, finance_rate=10%, reinvest_rate=12% → ≈ 12.61%.
    #[test]
    fn mirr_microsoft_example() {
        let cash = r(vec![
            n(-120_000.0),
            n(39_000.0),
            n(30_000.0),
            n(21_000.0),
            n(37_000.0),
            n(46_000.0),
        ]);
        approx(mirr(&[cash, s(n(0.10)), s(n(0.12))]), 0.126094, 1e-5);
    }

    #[test]
    fn mirr_no_positive_is_div_zero() {
        let cash = r(vec![n(-1.0), n(-2.0), n(-3.0)]);
        assert_eq!(
            mirr(&[cash, s(n(0.10)), s(n(0.12))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn mirr_no_negative_is_div_zero() {
        let cash = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(
            mirr(&[cash, s(n(0.10)), s(n(0.12))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn mirr_all_zero_is_div_zero() {
        let cash = r(vec![n(0.0), n(0.0), n(0.0)]);
        assert_eq!(
            mirr(&[cash, s(n(0.10)), s(n(0.12))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn mirr_single_value_is_div_zero() {
        // n=1 → must be either positive-only or negative-only, both
        // caught by the sign-coverage guard. n=1 also dodges the
        // (n-1)=0 division-by-zero implicitly.
        let cash = r(vec![n(10.0)]);
        assert_eq!(
            mirr(&[cash, s(n(0.10)), s(n(0.12))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn mirr_wrong_arity() {
        let cash = r(vec![n(-1.0), n(2.0)]);
        // 1 arg — use `from_ref` (clippy::cloned_ref_to_slice_refs).
        assert_eq!(
            mirr(std::slice::from_ref(&cash)),
            Value::Error(ErrorValue::Value)
        );
        // 2 args
        assert_eq!(
            mirr(&[cash.clone(), s(n(0.10))]),
            Value::Error(ErrorValue::Value)
        );
        // 4 args
        assert_eq!(
            mirr(&[cash, s(n(0.10)), s(n(0.12)), s(n(0.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn mirr_scalar_first_arg_is_value_error() {
        // Excel requires `values` to be an array. A bare scalar → #VALUE!.
        assert_eq!(
            mirr(&[s(n(-1.0)), s(n(0.10)), s(n(0.12))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn mirr_range_rate_is_value_error() {
        // finance_rate / reinvest_rate must be scalars.
        let cash = r(vec![n(-1.0), n(2.0)]);
        let rate_range = r(vec![n(0.10), n(0.11)]);
        assert_eq!(
            mirr(&[cash.clone(), rate_range.clone(), s(n(0.12))]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            mirr(&[cash, s(n(0.10)), rate_range]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn mirr_error_in_range_propagates() {
        let cash = r(vec![n(-1.0), Value::Error(ErrorValue::Ref), n(2.0)]);
        assert_eq!(
            mirr(&[cash, s(n(0.10)), s(n(0.12))]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn mirr_skips_text_and_bool_per_excel_canon() {
        // Mixed range with text + bool — both skipped per Excel canon
        // (matches the IRR/NPV W5-171 closure). Computation runs on
        // the numeric subset only.
        let cash = r(vec![
            n(-120_000.0),
            Value::text("ignored"),
            n(39_000.0),
            Value::Boolean(true),
            n(30_000.0),
            n(21_000.0),
            n(37_000.0),
            n(46_000.0),
        ]);
        approx(mirr(&[cash, s(n(0.10)), s(n(0.12))]), 0.126094, 1e-5);
    }

    #[test]
    fn mirr_error_in_finance_rate_propagates() {
        let cash = r(vec![n(-1.0), n(2.0)]);
        assert_eq!(
            mirr(&[cash, s(Value::Error(ErrorValue::Name)), s(n(0.12))]),
            Value::Error(ErrorValue::Name)
        );
    }

    #[test]
    fn mirr_invalid_finance_rate_is_num() {
        // finance_rate < -1 → compute_npv rejects with #NUM!.
        let cash = r(vec![n(-1.0), n(2.0)]);
        assert_eq!(
            mirr(&[cash, s(n(-1.5)), s(n(0.12))]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- B2: SHARPE ---

    #[test]
    fn sharpe_basic_rf_zero() {
        // returns [0.01, 0.02, 0.03, 0.04]; mean=0.025;
        // sample stdev = sqrt(0.0005/3) = 0.0129099445;
        // SHARPE (Rf=0) = 0.025 / 0.0129099445 = 1.9364916731.
        let ret = r(vec![n(0.01), n(0.02), n(0.03), n(0.04)]);
        approx(sharpe(std::slice::from_ref(&ret)), 1.9364916731, 1e-9);
    }

    #[test]
    fn sharpe_with_risk_free() {
        // (0.025 - 0.01) / 0.0129099445 = 1.1618950039.
        let ret = r(vec![n(0.01), n(0.02), n(0.03), n(0.04)]);
        approx(sharpe(&[ret, s(n(0.01))]), 1.1618950039, 1e-9);
    }

    #[test]
    fn sharpe_annualized_sqrt_periods() {
        // 1.9364916731 * sqrt(4) = 3.8729833462.
        let ret = r(vec![n(0.01), n(0.02), n(0.03), n(0.04)]);
        approx(sharpe(&[ret, s(n(0.0)), s(n(4.0))]), 3.8729833462, 1e-9);
    }

    #[test]
    fn sharpe_uses_sample_stdev_not_population() {
        // Two-point series [1.0, 3.0]: mean=2, sample stdev = sqrt(2) ≈
        // 1.4142135624 (population stdev would be 1.0). SHARPE = 2/sqrt(2)
        // = sqrt(2) ≈ 1.4142135624. If population stdev were used the
        // answer would be 2.0 — this pins the sample-vs-population choice.
        let ret = r(vec![n(1.0), n(3.0)]);
        approx(
            sharpe(std::slice::from_ref(&ret)),
            std::f64::consts::SQRT_2,
            1e-12,
        );
    }

    #[test]
    fn sharpe_empty_range_is_num() {
        let empty = FnArg::Range {
            values: vec![],
            rows: 0,
            cols: 0,
        };
        assert_eq!(sharpe(&[empty]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn sharpe_single_value_is_div_zero() {
        // n=1: sample stdev undefined → #DIV/0! (mirrors CONFIDENCE.T).
        let ret = r(vec![n(0.05)]);
        assert_eq!(sharpe(&[ret]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn sharpe_zero_dispersion_is_div_zero() {
        // Constant series: stdev=0 → division by zero, surfaced loudly.
        let ret = r(vec![n(0.02), n(0.02), n(0.02)]);
        assert_eq!(sharpe(&[ret]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn sharpe_non_positive_periods_is_num() {
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        assert_eq!(
            sharpe(&[ret.clone(), s(n(0.0)), s(n(0.0))]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            sharpe(&[ret, s(n(0.0)), s(n(-12.0))]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn sharpe_skips_text_and_bool_per_excel_canon() {
        // Text + bool skipped; computation runs on [0.01,0.02,0.03,0.04].
        let ret = r(vec![
            n(0.01),
            Value::text("label"),
            n(0.02),
            Value::Boolean(true),
            n(0.03),
            n(0.04),
        ]);
        approx(sharpe(std::slice::from_ref(&ret)), 1.9364916731, 1e-9);
    }

    #[test]
    fn sharpe_error_in_range_propagates() {
        let ret = r(vec![n(0.01), Value::Error(ErrorValue::Ref), n(0.02)]);
        assert_eq!(
            sharpe(std::slice::from_ref(&ret)),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn sharpe_scalar_first_arg_is_value_error() {
        assert_eq!(sharpe(&[s(n(0.02))]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sharpe_range_in_scalar_position_is_value_error() {
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        let bad = r(vec![n(0.01)]);
        // risk_free as a range.
        assert_eq!(
            sharpe(&[ret.clone(), bad.clone()]),
            Value::Error(ErrorValue::Value)
        );
        // periods_per_year as a range.
        assert_eq!(
            sharpe(&[ret, s(n(0.0)), bad]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sharpe_wrong_arity() {
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        assert_eq!(sharpe(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            sharpe(&[ret, s(n(0.0)), s(n(12.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- B2: MAX_DRAWDOWN ---

    #[test]
    fn max_drawdown_basic() {
        // Equity series [100, 120, 90, 110, 80, 130]:
        // running peak 100,120,120,120,120,130.
        // drawdowns 0, 0, -0.25, -0.0833, -0.3333, 0.
        // MDD = 80/120 - 1 = -1/3 = -0.3333333...
        let eq = r(vec![
            n(100.0),
            n(120.0),
            n(90.0),
            n(110.0),
            n(80.0),
            n(130.0),
        ]);
        approx(max_drawdown(std::slice::from_ref(&eq)), -1.0 / 3.0, 1e-12);
    }

    #[test]
    fn max_drawdown_monotonic_is_zero() {
        // Non-decreasing series never dips below its running peak ⇒ 0.0.
        let eq = r(vec![n(100.0), n(110.0), n(120.0)]);
        assert_eq!(max_drawdown(&[eq]), Value::Number(0.0));
    }

    #[test]
    fn max_drawdown_single_value_is_zero() {
        // One observation: peak = itself, dd = 0 ⇒ 0.0 (NOT an error;
        // a single level has no decline, unlike a stdev which needs n≥2).
        let eq = r(vec![n(50.0)]);
        assert_eq!(max_drawdown(&[eq]), Value::Number(0.0));
    }

    #[test]
    fn max_drawdown_full_wipeout() {
        // Drop to zero from a positive peak ⇒ -1.0 (a 100% drawdown).
        let eq = r(vec![n(100.0), n(0.0)]);
        approx(max_drawdown(&[eq]), -1.0, 1e-12);
    }

    #[test]
    fn max_drawdown_empty_range_is_num() {
        let empty = FnArg::Range {
            values: vec![],
            rows: 0,
            cols: 0,
        };
        assert_eq!(max_drawdown(&[empty]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn max_drawdown_non_positive_peak_is_div_zero() {
        // A non-positive running peak makes the fractional decline undefined.
        // Leading zero → peak 0 on the first element ⇒ #DIV/0! (0 is NOT
        // rejected by the value<0 guard; only the peak<=0 guard fires).
        let eq = r(vec![n(0.0), n(10.0)]);
        assert_eq!(max_drawdown(&[eq]), Value::Error(ErrorValue::DivZero));
        // A leading NEGATIVE level is invalid data → #NUM! (the value<0 guard
        // fires before the peak guard; see max_drawdown_negative_level_is_num).
        let eq2 = r(vec![n(-5.0), n(10.0)]);
        assert_eq!(max_drawdown(&[eq2]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn max_drawdown_skips_text_and_bool_per_excel_canon() {
        // Text + bool skipped; runs on [100, 80] ⇒ -0.2.
        let eq = r(vec![
            n(100.0),
            Value::text("hdr"),
            Value::Boolean(false),
            n(80.0),
        ]);
        approx(max_drawdown(std::slice::from_ref(&eq)), -0.2, 1e-12);
    }

    #[test]
    fn max_drawdown_error_in_range_propagates() {
        let eq = r(vec![n(100.0), Value::Error(ErrorValue::Num), n(80.0)]);
        assert_eq!(max_drawdown(&[eq]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn max_drawdown_scalar_arg_is_value_error() {
        assert_eq!(
            max_drawdown(&[s(n(100.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn max_drawdown_wrong_arity() {
        let eq = r(vec![n(100.0), n(90.0)]);
        assert_eq!(max_drawdown(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            max_drawdown(&[eq, s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- B2: non-finite + negative-level guards (Codex MED + LOW closure) ---

    #[test]
    fn max_drawdown_non_finite_input_is_num() {
        // **Codex MED:** ±Inf / NaN in the series is bad data → #NUM!, not a
        // silently-finite bogus result. Without the collect_series guard,
        // [+Inf] gives Inf/Inf = NaN → ignored by `<` → returns 0.0.
        let eq = r(vec![n(100.0), n(f64::INFINITY), n(80.0)]);
        assert_eq!(max_drawdown(&[eq]), Value::Error(ErrorValue::Num));
        let eq2 = r(vec![n(f64::NAN)]);
        assert_eq!(max_drawdown(&[eq2]), Value::Error(ErrorValue::Num));
        let eq3 = r(vec![n(100.0), n(f64::NEG_INFINITY)]);
        assert_eq!(max_drawdown(&[eq3]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn max_drawdown_negative_level_is_num() {
        // **Codex LOW:** a negative price/NAV level is invalid input → #NUM!
        // (would otherwise produce a sub-(-100%) drawdown). A leading negative
        // is also #NUM! (caught by the value<0 guard before the peak guard).
        let eq = r(vec![n(100.0), n(120.0), n(-10.0)]);
        assert_eq!(max_drawdown(&[eq]), Value::Error(ErrorValue::Num));
        let eq2 = r(vec![n(-5.0), n(10.0)]);
        assert_eq!(max_drawdown(&[eq2]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn max_drawdown_zero_after_positive_peak_is_full_loss() {
        // A level of exactly 0 AFTER a positive peak is a legitimate 100%
        // loss → -1.0 (NOT rejected; only NEGATIVE levels error).
        let eq = r(vec![n(100.0), n(50.0), n(0.0), n(0.0)]);
        approx(max_drawdown(&[eq]), -1.0, 1e-12);
    }

    #[test]
    fn sharpe_non_finite_input_is_num() {
        // **Codex MED:** ±Inf / NaN in the returns range → #NUM!.
        let ret = r(vec![n(0.01), n(f64::INFINITY), n(0.03)]);
        assert_eq!(sharpe(&[ret]), Value::Error(ErrorValue::Num));
        let ret2 = r(vec![n(0.01), n(f64::NAN), n(0.02), n(0.03)]);
        assert_eq!(sharpe(&[ret2]), Value::Error(ErrorValue::Num));
    }

    // --- B2 (Wave A): VOLATILITY ---

    #[test]
    fn volatility_basic_sample_stdev() {
        // [0.01,0.02,0.03,0.04]: sample stdev = sqrt(0.0005/3) = 0.0129099445
        // — IDENTICAL to SHARPE's denominator on the same series.
        let ret = r(vec![n(0.01), n(0.02), n(0.03), n(0.04)]);
        approx(volatility(std::slice::from_ref(&ret)), 0.0129099445, 1e-9);
    }

    #[test]
    fn volatility_annualized_sqrt_periods() {
        // 0.0129099445 * sqrt(4) = 0.0258198890.
        let ret = r(vec![n(0.01), n(0.02), n(0.03), n(0.04)]);
        approx(volatility(&[ret, s(n(4.0))]), 0.0258198890, 1e-9);
    }

    #[test]
    fn volatility_uses_sample_stdev_not_population() {
        // Two-point series [1.0, 3.0]: sample stdev = sqrt(2) ≈ 1.4142135624
        // (population stdev would be 1.0). Pins the sample-vs-population choice.
        let ret = r(vec![n(1.0), n(3.0)]);
        approx(
            volatility(std::slice::from_ref(&ret)),
            std::f64::consts::SQRT_2,
            1e-12,
        );
    }

    #[test]
    fn volatility_constant_series_is_zero_not_error() {
        // **THE distinguishing case from SHARPE:** a constant series has zero
        // dispersion. SHARPE errors (#DIV/0! — it's the denominator), but
        // VOLATILITY returns it: zero volatility is a valid statistic.
        let ret = r(vec![n(0.02), n(0.02), n(0.02)]);
        approx(volatility(std::slice::from_ref(&ret)), 0.0, 1e-12);
        // ...and a constant series annualized is still 0.0 (0 * sqrt(ppy)).
        let ret2 = r(vec![n(0.02), n(0.02), n(0.02)]);
        approx(volatility(&[ret2, s(n(252.0))]), 0.0, 1e-12);
    }

    #[test]
    fn volatility_empty_range_is_num() {
        let empty = FnArg::Range {
            values: vec![],
            rows: 0,
            cols: 0,
        };
        assert_eq!(volatility(&[empty]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn volatility_single_value_is_div_zero() {
        // n=1: sample stdev undefined → #DIV/0! (matches STDEV.S / SHARPE).
        let ret = r(vec![n(0.05)]);
        assert_eq!(volatility(&[ret]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn volatility_non_positive_periods_is_num() {
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        assert_eq!(
            volatility(&[ret.clone(), s(n(0.0))]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            volatility(&[ret, s(n(-4.0))]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn volatility_error_in_range_propagates() {
        let ret = r(vec![n(0.01), Value::Error(ErrorValue::Ref), n(0.03)]);
        assert_eq!(volatility(&[ret]), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn volatility_non_finite_input_is_num() {
        let ret = r(vec![n(0.01), n(f64::INFINITY), n(0.03)]);
        assert_eq!(volatility(&[ret]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn volatility_scalar_first_arg_is_value_error() {
        assert_eq!(volatility(&[s(n(0.05))]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn volatility_range_in_scalar_position_is_value_error() {
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        let ppy_range = r(vec![n(4.0)]);
        assert_eq!(
            volatility(&[ret, ppy_range]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn volatility_wrong_arity() {
        assert_eq!(volatility(&[]), Value::Error(ErrorValue::Value));
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        assert_eq!(
            volatility(&[ret, s(n(4.0)), s(n(0.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- B2 (Wave A): SORTINO ---

    #[test]
    fn sortino_basic_mar_zero() {
        // [0.30,-0.10,0.10,-0.10], MAR=0: mean = 0.20/4 = 0.05.
        // downside shortfalls min(0,r) = [0,-0.10,0,-0.10]; squared = [0,0.01,
        // 0,0.01]; mean over ALL N=4 = 0.02/4 = 0.005; DD = sqrt(0.005) =
        // 0.0707106781. SORTINO = 0.05/0.0707106781 = 1/sqrt(2) = 0.7071067812.
        // (Dividing by the DOWNSIDE COUNT (2) instead of N would give DD=0.1 →
        // ratio 0.5; this value pins the population-N empyrical convention.)
        let ret = r(vec![n(0.30), n(-0.10), n(0.10), n(-0.10)]);
        approx(
            sortino(std::slice::from_ref(&ret)),
            std::f64::consts::FRAC_1_SQRT_2,
            1e-9,
        );
    }

    #[test]
    fn sortino_annualized_sqrt_periods() {
        // 0.7071067812 * sqrt(4) = sqrt(2) = 1.4142135624 (SHARPE's convention).
        let ret = r(vec![n(0.30), n(-0.10), n(0.10), n(-0.10)]);
        approx(
            sortino(&[ret, s(n(0.0)), s(n(4.0))]),
            std::f64::consts::SQRT_2,
            1e-9,
        );
    }

    #[test]
    fn sortino_with_mar_negative_ratio() {
        // [0.02,-0.06,0.10,-0.02], MAR=0.02: mean = 0.04/4 = 0.01, numerator =
        // mean-MAR = -0.01. Shortfalls min(0, r-0.02) = [0,-0.08,0,-0.04];
        // squared sum = 0.0064+0.0016 = 0.008; /N=4 = 0.002; DD = sqrt(0.002) =
        // 0.0447213595. SORTINO = -0.01/0.0447213595 = -1/sqrt(20) =
        // -0.2236067977. Pins MAR handling, a negative ratio, AND the N
        // denominator (downside-count=2 would give DD=0.0632 → ratio -0.158).
        let ret = r(vec![n(0.02), n(-0.06), n(0.10), n(-0.02)]);
        approx(sortino(&[ret, s(n(0.02))]), -0.2236067977, 1e-9);
    }

    #[test]
    fn sortino_no_downside_is_div_zero() {
        // Every return >= MAR → zero downside → DD == 0 → #DIV/0! (loud, never
        // +Inf). [0.01,0.02,0.03] all > MAR=0.
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        assert_eq!(sortino(&[ret]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn sortino_no_downside_div_zero_beats_bad_periods() {
        // Denominator-degenerate (DD==0) is checked BEFORE periods_per_year, so
        // a no-downside series with ppy<=0 surfaces #DIV/0!, mirroring SHARPE's
        // stdev==0-vs-ppy precedence.
        let ret = r(vec![n(0.01), n(0.02), n(0.03)]);
        assert_eq!(
            sortino(&[ret, s(n(0.0)), s(n(0.0))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn sortino_empty_range_is_num() {
        let empty = FnArg::Range {
            values: vec![],
            rows: 0,
            cols: 0,
        };
        assert_eq!(sortino(&[empty]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn sortino_single_value_is_div_zero() {
        // n=1 → #DIV/0! (a one-sample risk-adjusted ratio is meaningless;
        // mirrors SHARPE for a consistent quant-aggregate contract).
        let ret = r(vec![n(-0.05)]);
        assert_eq!(sortino(&[ret]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn sortino_non_positive_periods_is_num() {
        // A genuine downside exists (DD>0), so the ppy guard is reached: ppy<=0
        // → #NUM!.
        let ret = r(vec![n(0.30), n(-0.10), n(0.10), n(-0.10)]);
        assert_eq!(
            sortino(&[ret.clone(), s(n(0.0)), s(n(0.0))]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            sortino(&[ret, s(n(0.0)), s(n(-4.0))]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn sortino_downside_deviation_uses_all_n_not_downside_count() {
        // [0.10,-0.20,0.10,-0.20], MAR=0: mean = -0.20/4 = -0.05. Squared
        // downside = 0.04+0.04 = 0.08; /N=4 = 0.02; DD = sqrt(0.02) =
        // 0.1414213562; ratio = -0.05/0.1414213562 = -0.3535533906. Dividing
        // by the downside COUNT (2) would give DD=0.2 → ratio -0.25; this
        // explicitly pins the empyrical all-N denominator.
        let ret = r(vec![n(0.10), n(-0.20), n(0.10), n(-0.20)]);
        approx(sortino(std::slice::from_ref(&ret)), -0.3535533906, 1e-9);
    }

    #[test]
    fn sortino_error_in_range_propagates() {
        let ret = r(vec![n(0.01), Value::Error(ErrorValue::Ref), n(-0.03)]);
        assert_eq!(sortino(&[ret]), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn sortino_non_finite_input_is_num() {
        let ret = r(vec![n(0.01), n(f64::NAN), n(-0.03)]);
        assert_eq!(sortino(&[ret]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn sortino_scalar_first_arg_is_value_error() {
        assert_eq!(sortino(&[s(n(0.05))]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sortino_range_in_scalar_position_is_value_error() {
        let ret = r(vec![n(0.30), n(-0.10), n(0.10)]);
        let mar_range = r(vec![n(0.0)]);
        assert_eq!(
            sortino(&[ret.clone(), mar_range]),
            Value::Error(ErrorValue::Value)
        );
        let ppy_range = r(vec![n(4.0)]);
        assert_eq!(
            sortino(&[ret, s(n(0.0)), ppy_range]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sortino_wrong_arity() {
        assert_eq!(sortino(&[]), Value::Error(ErrorValue::Value));
        let ret = r(vec![n(0.30), n(-0.10), n(0.10)]);
        assert_eq!(
            sortino(&[ret, s(n(0.0)), s(n(4.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn volatility_skips_text_and_bool_per_excel_canon() {
        // Text + bool skipped; computation runs on [0.01,0.02,0.03,0.04].
        let ret = r(vec![
            n(0.01),
            Value::text("label"),
            n(0.02),
            Value::Boolean(true),
            n(0.03),
            n(0.04),
        ]);
        approx(volatility(std::slice::from_ref(&ret)), 0.0129099445, 1e-9);
    }

    #[test]
    fn sortino_skips_text_and_bool_per_excel_canon() {
        // Text + bool skipped; computation runs on [0.30,-0.10,0.10,-0.10].
        let ret = r(vec![
            n(0.30),
            Value::text("label"),
            n(-0.10),
            Value::Boolean(true),
            n(0.10),
            n(-0.10),
        ]);
        approx(
            sortino(std::slice::from_ref(&ret)),
            std::f64::consts::FRAC_1_SQRT_2,
            1e-9,
        );
    }

    // --- B2 (Wave A): numerical robustness (Codex HIGH closure) ---
    // A naive `Σ shortfall^2` (SORTINO) / `Σ(x-mean)^2` (SHARPE/VOLATILITY via
    // welford) overflows to +Inf or underflows to 0 for extreme-magnitude finite
    // returns. SORTINO's self-contained downside uses a scaled sum-of-squares and
    // stays CORRECT; SHARPE/VOLATILITY share welford with STDEV.S and instead
    // surface #NUM! (loud, not a silent wrong result -- No-Fallbacks).

    #[test]
    fn sortino_overflow_large_inputs_stays_correct() {
        // [-1e200, 0], MAR=0: a naive square (-1e200)^2 = +Inf -> dd=Inf ->
        // ratio -0.0 (silent WRONG). Scaled DD: scale=1e200, ssq=1, dd=
        // 1e200*sqrt(1/2), ratio = -5e199 / (1e200/sqrt2) = -1/sqrt(2). Correct.
        let ret = r(vec![n(-1e200), n(0.0)]);
        approx(
            sortino(std::slice::from_ref(&ret)),
            -std::f64::consts::FRAC_1_SQRT_2,
            1e-12,
        );
    }

    #[test]
    fn sortino_underflow_tiny_inputs_stays_correct() {
        // [-1e-200, 0], MAR=0: a naive square (-1e-200)^2 underflows to 0 ->
        // dd=0 -> spurious #DIV/0!. Scaled DD recovers the true -1/sqrt(2).
        let ret = r(vec![n(-1e-200), n(0.0)]);
        approx(
            sortino(std::slice::from_ref(&ret)),
            -std::f64::consts::FRAC_1_SQRT_2,
            1e-12,
        );
    }

    #[test]
    fn sharpe_overflow_input_is_num() {
        // [-1e200, 0]: welford `sample_stdev` overflows to +Inf; without the
        // finiteness guard `mean/Inf` is a finite -0.0 (silent wrong). Guarded
        // -> #NUM! (loud).
        let ret = r(vec![n(-1e200), n(0.0)]);
        assert_eq!(sharpe(&[ret]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn volatility_overflow_input_is_num() {
        // [-1e200, 0]: welford stdev overflows to +Inf; `finish()` sanitizes the
        // non-finite result to #NUM! (loud), matching SHARPE -- pinned so a
        // future change cannot regress it to a silent finite value.
        let ret = r(vec![n(-1e200), n(0.0)]);
        assert_eq!(volatility(&[ret]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn mirr_finance_rate_minus_one_special_single_negative_at_index_0() {
        // Special-case branch in compute_mirr: finance_rate == -1 with
        // the only negative at index 0 → bottom = negatives[0] (finite).
        // values=[-1, 2]: positives=[0, 2], negatives=[-1, 0], n=2.
        // top with reinvest_rate=0: NPV(0, [0, 2]) = 0/1 + 2/1 = 2; top = -2*1 = -2.
        // bottom = -1.
        // ratio = 2; (n-1)=1; result = 2^1 - 1 = 1.
        let cash = r(vec![n(-1.0), n(2.0)]);
        approx(mirr(&[cash, s(n(-1.0)), s(n(0.0))]), 1.0, 1e-9);
    }

    #[test]
    fn mirr_reinvest_rate_minus_one_special() {
        // reinvest_rate = -1 branch: top = positives.last() = 2.
        // finance_rate=0: NPV(0, [-1, 0]) = -1; bottom = -1 * 1 = -1.
        // ratio = -2 → ratio < 0 → return #NUM!. Pins the
        // ratio-negative guard along this branch.
        let cash = r(vec![n(-1.0), n(2.0)]);
        assert_eq!(
            mirr(&[cash, s(n(0.0)), s(n(-1.0))]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn mirr_zero_in_values_neutral() {
        // Zero values neither positive nor negative — neutral. The
        // sign-coverage guard treats them as neither stream.
        let cash = r(vec![n(-100.0), n(0.0), n(0.0), n(150.0)]);
        // top with rr=0.1: NPV(0.1, [0, 0, 0, 150]) = 150/1.1^4 ≈ 102.45;
        //   top = -102.45 * 1.1^4 ≈ -150.
        // bottom with fr=0.1: NPV(0.1, [-100, 0, 0, 0]) = -100/1.1 ≈ -90.91;
        //   bottom = -90.91 * 1.1 = -100.
        // ratio = 1.5; (n-1)=3; result = 1.5^(1/3) - 1 ≈ 0.14471.
        approx(mirr(&[cash, s(n(0.10)), s(n(0.10))]), 0.14471, 1e-4);
    }

    // --- SLN (W5-180) ---

    #[test]
    fn sln_basic() {
        // SLN(10000, 1000, 5) = (10000-1000)/5 = 1800.
        approx(sln(&[n(10000.0), n(1000.0), n(5.0)]), 1800.0, 1e-9);
    }

    #[test]
    fn sln_no_salvage() {
        // SLN(10000, 0, 10) = 1000.
        approx(sln(&[n(10000.0), n(0.0), n(10.0)]), 1000.0, 1e-9);
    }

    #[test]
    fn sln_microsoft_example() {
        // Microsoft docs: SLN(30000, 7500, 10) = 2250.
        approx(sln(&[n(30000.0), n(7500.0), n(10.0)]), 2250.0, 1e-9);
    }

    #[test]
    fn sln_life_zero_is_div_zero() {
        assert_eq!(
            sln(&[n(100.0), n(10.0), n(0.0)]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn sln_negative_life_passes_through() {
        // Per IronCalc canon: no upfront check on sign — formula
        // runs and produces a negative result. Excel docs don't
        // explicitly reject; matching IronCalc.
        approx(sln(&[n(1000.0), n(0.0), n(-5.0)]), -200.0, 1e-9);
    }

    #[test]
    fn sln_wrong_arity() {
        assert_eq!(sln(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(sln(&[n(100.0), n(10.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            sln(&[n(100.0), n(10.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sln_error_in_arg_propagates() {
        assert_eq!(
            sln(&[Value::Error(ErrorValue::Ref), n(10.0), n(5.0)]),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            sln(&[n(100.0), Value::Error(ErrorValue::Name), n(5.0)]),
            Value::Error(ErrorValue::Name)
        );
    }

    #[test]
    fn sln_blank_coerces_to_zero() {
        // Blank salvage → 0. (10000 - 0) / 5 = 2000.
        approx(sln(&[n(10000.0), Value::Blank, n(5.0)]), 2000.0, 1e-9);
    }

    // --- SYD (W5-180) ---

    #[test]
    fn syd_microsoft_example_first_year() {
        // Microsoft docs example: SYD(30000, 7500, 10, 1) ≈ 4090.909.
        // Compute expected via the formula directly to avoid awkward
        // digit-grouping in a literal (clippy::inconsistent_digit_grouping).
        let expected = 22500.0 * 10.0 * 2.0 / (10.0 * 11.0);
        approx(
            syd(&[n(30000.0), n(7500.0), n(10.0), n(1.0)]),
            expected,
            1e-9,
        );
    }

    #[test]
    fn syd_microsoft_example_final_year() {
        // SYD(30000, 7500, 10, 10) = (22500 * 1 * 2) / (10 * 11).
        let expected = 22500.0 * 1.0 * 2.0 / (10.0 * 11.0);
        approx(
            syd(&[n(30000.0), n(7500.0), n(10.0), n(10.0)]),
            expected,
            1e-9,
        );
    }

    #[test]
    fn syd_zero_per_is_num() {
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(5.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn syd_negative_per_is_num() {
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(5.0), n(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn syd_per_exceeds_life_is_num() {
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(5.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn syd_life_zero_is_num() {
        // SYD asymmetry with SLN: life=0 returns #NUM! here, not
        // #DIV/0!. Microsoft + IronCalc both confirm.
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn syd_per_equals_life_succeeds() {
        // per = life boundary case; should succeed (the constraint
        // is `per > life`, not `>=`).
        approx(
            syd(&[n(100.0), n(0.0), n(5.0), n(5.0)]),
            (100.0 * 1.0 * 2.0) / (5.0 * 6.0),
            1e-9,
        );
    }

    #[test]
    fn syd_wrong_arity() {
        assert_eq!(syd(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(5.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(5.0), n(1.0), n(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn syd_error_in_arg_propagates() {
        // Error in any of the four positional args.
        assert_eq!(
            syd(&[Value::Error(ErrorValue::Ref), n(10.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            syd(&[n(100.0), n(10.0), n(5.0), Value::Error(ErrorValue::Name)]),
            Value::Error(ErrorValue::Name)
        );
    }

    #[test]
    fn syd_sum_over_periods_equals_total_depreciation() {
        // Invariant: Σ SYD(cost, salvage, life, k) for k=1..life
        // = (cost - salvage). Pin to verify the formula's sum
        // identity, which is the whole point of "sum-of-years".
        let cost = 30000.0;
        let salvage = 7500.0;
        let life = 10.0;
        let mut total = 0.0;
        for k in 1..=10 {
            match syd(&[n(cost), n(salvage), n(life), n(k as f64)]) {
                Value::Number(d) => total += d,
                other => panic!("expected Number, got {other:?}"),
            }
        }
        assert!(
            (total - (cost - salvage)).abs() < 1e-6,
            "expected {}, got {total}",
            cost - salvage
        );
    }

    // --- DDB (W5-181) ---

    #[test]
    fn ddb_microsoft_example_first_year() {
        // Microsoft docs: DDB(2400, 300, 10, 1) = 480 (default factor=2).
        // rate=0.2; value=2400; new_value=1920; result=max(2400-max(300,1920),0)=480.
        approx(ddb(&[n(2400.0), n(300.0), n(10.0), n(1.0)]), 480.0, 1e-9);
    }

    #[test]
    fn ddb_microsoft_example_final_year() {
        // DDB(2400, 300, 10, 10) ≈ 22.12.
        // value = 2400·0.8^9; new_value = 2400·0.8^10; new_value<salvage=300
        // so floor kicks in: result = value − 300.
        let expected = 2400.0 * 0.8_f64.powi(9) - 300.0;
        approx(
            ddb(&[n(2400.0), n(300.0), n(10.0), n(10.0)]),
            expected,
            1e-9,
        );
    }

    #[test]
    fn ddb_life_in_months() {
        // DDB(2400, 300, 120, 1, 2) = 40 (Microsoft docs example).
        // rate=2/120; value=2400; new_value=2400·(118/120)=2360;
        // result=max(2400-max(300,2360),0)=40.
        approx(
            ddb(&[n(2400.0), n(300.0), n(120.0), n(1.0), n(2.0)]),
            40.0,
            1e-9,
        );
    }

    #[test]
    fn ddb_explicit_factor_one_single_declining() {
        // factor=1: rate=1/life=0.1. DDB(1000, 0, 10, 1, 1):
        // value=1000; new_value=900; result=max(1000-max(0,900),0)=100.
        approx(
            ddb(&[n(1000.0), n(0.0), n(10.0), n(1.0), n(1.0)]),
            100.0,
            1e-9,
        );
    }

    #[test]
    fn ddb_rate_clamps_to_one_when_factor_exceeds_life() {
        // factor=5, life=1 → rate=5/1=5, clamped to 1.
        // period=1, rate==1: value = cost = 1000; new_value = 0;
        // result = max(1000 - max(0, 0), 0) = 1000.
        approx(
            ddb(&[n(1000.0), n(0.0), n(1.0), n(1.0), n(5.0)]),
            1000.0,
            1e-9,
        );
    }

    #[test]
    fn ddb_rate_one_zero_after_first_period() {
        // factor=5, life=1, rate clamped to 1. period=1 returns cost
        // (covered above); the rate==1 branch says period>1 returns 0
        // — but with life=1, period>life=1 already rejects as #NUM!.
        // Construct a case where the rate-clamp branch is exercised
        // without tripping period>life: factor=10, life=2 →
        // rate=10/2=5, clamped to 1. period=2 (==life, valid):
        // value = 0 (rate==1, period!=1 branch); new_value = 0.
        // result = max(0 - max(0, 0), 0) = 0.
        approx(
            ddb(&[n(1000.0), n(0.0), n(2.0), n(2.0), n(10.0)]),
            0.0,
            1e-9,
        );
    }

    #[test]
    fn ddb_salvage_floor_clamps_to_zero() {
        // High salvage immediately floors out:
        // DDB(1000, 999, 10, 2, 2): rate=0.2; value=1000·0.8=800;
        // new_value=1000·0.64=640; max(salvage=999, new_value=640)=999;
        // result = max(800 - 999, 0) = 0.
        approx(
            ddb(&[n(1000.0), n(999.0), n(10.0), n(2.0), n(2.0)]),
            0.0,
            1e-9,
        );
    }

    #[test]
    fn ddb_period_exceeds_life_is_num() {
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_zero_period_is_num() {
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_negative_period_is_num() {
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0), n(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_negative_cost_is_num() {
        assert_eq!(
            ddb(&[n(-100.0), n(10.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_negative_salvage_is_num() {
        assert_eq!(
            ddb(&[n(100.0), n(-10.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_zero_factor_is_num() {
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0), n(1.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_negative_factor_is_num() {
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0), n(1.0), n(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn ddb_wrong_arity() {
        assert_eq!(ddb(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            ddb(&[n(100.0), n(10.0), n(5.0), n(1.0), n(2.0), n(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn ddb_error_in_arg_propagates() {
        assert_eq!(
            ddb(&[Value::Error(ErrorValue::Ref), n(10.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            ddb(&[
                n(100.0),
                n(10.0),
                n(5.0),
                n(1.0),
                Value::Error(ErrorValue::Name)
            ]),
            Value::Error(ErrorValue::Name)
        );
    }

    // --- DB (W5-182) ---
    //
    // Microsoft canonical fixture: DB(1_000_000, 100_000, 6, k, 7).
    // The published rate is round((1-(0.1)^(1/6))*1000)/1000 = 0.319.
    // Each period's expected value is computed against the canonical
    // formula in-test rather than hard-coded so the tolerance is
    // tied to the formula's intermediate float behavior, not to a
    // rounded Microsoft display string.

    fn db_microsoft_rate() -> f64 {
        ((1.0 - (100_000.0_f64 / 1_000_000.0).powf(1.0 / 6.0)) * 1000.0).round() / 1000.0
    }

    #[test]
    fn db_microsoft_rate_is_canonical() {
        // Sanity-check the published 0.319 rate so any later float
        // drift is caught here, not silently downstream.
        assert!((db_microsoft_rate() - 0.319).abs() < 1e-12);
    }

    #[test]
    fn db_microsoft_first_period_partial() {
        // DB(1M, 100k, 6, 1, 7): first period uses month/12 fraction.
        // = 1_000_000 * 0.319 * 7/12 = 186_083.333...
        let expected = 1_000_000.0 * db_microsoft_rate() * 7.0 / 12.0;
        approx(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(7.0)]),
            expected,
            1e-6,
        );
    }

    #[test]
    fn db_microsoft_second_period() {
        // Period 2: rate * (cost - first_period_dep).
        let rate = db_microsoft_rate();
        let first = 1_000_000.0 * rate * 7.0 / 12.0;
        let expected = rate * (1_000_000.0 - first);
        approx(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(2.0), n(7.0)]),
            expected,
            1e-6,
        );
    }

    #[test]
    fn db_microsoft_last_partial_period() {
        // Period 7 = life + 1: complementary (12-month)/12 fraction.
        // Verify by computing the iterative cumulative through period 6,
        // then applying the last-partial formula.
        let rate = db_microsoft_rate();
        let mut acc = 1_000_000.0 * rate * 7.0 / 12.0; // period 1
        for _ in 0..5 {
            // periods 2..6 (5 iterations: loop runs period-2 = 7-2 = 5 times)
            acc += (1_000_000.0 - acc) * rate;
        }
        let expected = (1_000_000.0 - acc) * rate * (12.0 - 7.0) / 12.0;
        approx(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(7.0), n(7.0)]),
            expected,
            1e-6,
        );
    }

    #[test]
    fn db_default_month_is_12() {
        // Omitting `month` uses 12 (full first year, no last-partial).
        // DB(1M, 100k, 6, 1) with implicit month=12.
        let expected = 1_000_000.0 * db_microsoft_rate(); // month/12 = 1
        approx(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0)]),
            expected,
            1e-6,
        );
    }

    #[test]
    fn db_full_year_period_equals_life_pins_value() {
        // **W5-182.1 (Opus HIGH-1 / Codex LOW-1 closure):** previously
        // only `matches!(_, Number(_))` — a regression returning 0 or
        // `cost` or the wrong intermediate would pass silently. Now
        // pins the actual value computed via the canonical formula:
        // first-period accumulated = cost*rate (month=12 → no partial).
        // Loop runs life - 2 = 4 iterations (periods 2..5). Final
        // return = rate * (cost - accumulated_through_5).
        let rate = db_microsoft_rate();
        let mut acc = 1_000_000.0 * rate; // period 1 (month=12)
        for _ in 0..4 {
            // periods 2..5: 4 iterations = (life - 2) with life=6
            acc += (1_000_000.0 - acc) * rate;
        }
        let expected = rate * (1_000_000.0 - acc);
        approx(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(6.0)]),
            expected,
            1e-6,
        );
    }

    #[test]
    fn db_month_12_period_exceeds_life_is_num() {
        // month=12 + period > life rejects (no last-partial branch
        // available when month=12).
        assert_eq!(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(7.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_period_exceeds_life_plus_one_is_num() {
        // Even with month<12, period > life+1 rejects.
        assert_eq!(
            db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(8.0), n(7.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_zero_month_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(1.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_month_exceeds_12_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(1.0), n(13.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_zero_period_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_negative_period_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_negative_cost_is_num() {
        assert_eq!(
            db(&[n(-1000.0), n(100.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_zero_cost_returns_zero() {
        // Short-circuit to avoid (salvage/0) NaN. Documented in canon.
        approx(db(&[n(0.0), n(0.0), n(5.0), n(1.0)]), 0.0, 1e-12);
    }

    #[test]
    fn db_month_fractional_truncates() {
        // month=7.7 → trunc to 7; should equal DB with month=7.
        let r1 = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(7.7)]);
        let r2 = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(7.0)]);
        assert_eq!(r1, r2);
    }

    #[test]
    fn db_wrong_arity() {
        assert_eq!(db(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(1.0), n(12.0), n(0.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn db_error_in_arg_propagates() {
        assert_eq!(
            db(&[Value::Error(ErrorValue::Ref), n(100.0), n(5.0), n(1.0)]),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            db(&[
                n(1000.0),
                n(100.0),
                n(5.0),
                n(1.0),
                Value::Error(ErrorValue::Name)
            ]),
            Value::Error(ErrorValue::Name)
        );
    }

    // --- DB W5-182.1 audit closures ---

    /// Codex HIGH-1: `life = 0` previously slipped past validation
    /// because the existing rejections were `period > life` (only
    /// when `month == 12`) and `period > life + 1`. With `life = 0`,
    /// `month < 12`, and `period = 1`, validation passed, then
    /// `(salvage/cost)^(1/0) → (salvage/cost)^∞ → 0` for normal
    /// `salvage < cost`, giving `rate = 1.0` and a finite return.
    #[test]
    fn db_zero_life_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(0.0), n(1.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
        // Also caught for the previously-existing `month == 12 && period > life`
        // path, but now uniformly via the explicit `life <= 0` guard.
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_negative_life_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(-1.0), n(1.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn db_fractional_life_below_one_is_num() {
        // Codex HIGH-1 / Opus MEDIUM-5 closure: `life = 0.5` previously
        // passed because `period > life + 1 = 1.5` is false for period=1.
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(0.5), n(1.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// Opus MEDIUM-6: fractional `period < 1` (e.g., `period = 0.5`)
    /// previously slipped past `period <= 0` and silently returned
    /// period-2's depreciation. Now rejected by the tightened
    /// `period < 1.0` validation.
    #[test]
    fn db_fractional_period_below_one_is_num() {
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(0.5), n(12.0)]),
            Value::Error(ErrorValue::Num)
        );
        // Edge: period = 0.999... → floor=0 → caught.
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(5.0), n(0.999_999_999), n(12.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// Opus MEDIUM-7: `life > i32::MAX` previously saturated `life_int`
    /// to `i32::MAX`, then `life_int + 1` panicked (debug) / wrapped
    /// (release). Iteration `0..(period_int - 2)` would also run
    /// billions of times for huge period. Now both rejected upfront.
    #[test]
    fn db_huge_life_rejected() {
        // 1e15 >> i32::MAX ≈ 2.15e9 → rejected by the DoS guard.
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(1e15), n(1.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
        // **W5-183.1 (Opus HIGH-1 closure):** boundary tightened
        // `>` → `>=`. EXACTLY `i32::MAX as f64` previously passed
        // (just like VDB's bug), then `life_int + 1` overflowed.
        // Now rejected uniformly.
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(i32::MAX as f64), n(1.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
        let just_over = i32::MAX as f64 + 1.0;
        assert_eq!(
            db(&[n(1000.0), n(100.0), n(just_over), n(1.0), n(6.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// Documents the W5-182 / W5-182.1 deliberate divergence vs IronCalc:
    /// our `arg_num` allows Boolean for the optional `month` arg
    /// (TRUE → 1, FALSE → 0). IronCalc rejects via `get_number_no_bools`.
    /// Same family-wide convention as DDB's `factor`.
    #[test]
    fn db_boolean_month_coerces_to_number() {
        // TRUE → month = 1 → first-month partial year.
        let with_true = db(&[
            n(1_000_000.0),
            n(100_000.0),
            n(6.0),
            n(1.0),
            Value::Boolean(true),
        ]);
        let with_one = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(1.0)]);
        assert_eq!(with_true, with_one);

        // FALSE → month = 0 → rejected by `month <= 0` validation.
        assert_eq!(
            db(&[
                n(1_000_000.0),
                n(100_000.0),
                n(6.0),
                n(1.0),
                Value::Boolean(false)
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- VDB (W5-183) — CLOSES Wave 3 depreciation batch ---
    //
    // All six Microsoft documented examples are pinned; expected
    // values are direct quotes from
    // https://support.microsoft.com/.../vdb-function-...

    #[test]
    fn vdb_microsoft_example_first_day() {
        // VDB(2400, 300, 10*365, 0, 1) = $1.32 (first day of 10-year life).
        approx(
            vdb(&[n(2400.0), n(300.0), n(3650.0), n(0.0), n(1.0)]),
            1.32,
            0.01,
        );
    }

    #[test]
    fn vdb_microsoft_example_first_month() {
        // VDB(2400, 300, 10*12, 0, 1) = $40.00 (first month).
        approx(
            vdb(&[n(2400.0), n(300.0), n(120.0), n(0.0), n(1.0)]),
            40.0,
            0.005,
        );
    }

    #[test]
    fn vdb_microsoft_example_first_year() {
        // VDB(2400, 300, 10, 0, 1) = $480.00 (first year, factor=2 default).
        approx(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(1.0)]),
            480.0,
            1e-9,
        );
    }

    #[test]
    fn vdb_microsoft_example_months_6_to_18() {
        // VDB(2400, 300, 10*12, 6, 18) = $396.31 (months 7 through 18).
        approx(
            vdb(&[n(2400.0), n(300.0), n(120.0), n(6.0), n(18.0)]),
            396.31,
            0.01,
        );
    }

    #[test]
    fn vdb_microsoft_example_factor_1_5_months_6_to_18() {
        // VDB(2400, 300, 10*12, 6, 18, 1.5) = $311.81.
        approx(
            vdb(&[n(2400.0), n(300.0), n(120.0), n(6.0), n(18.0), n(1.5)]),
            311.81,
            0.01,
        );
    }

    #[test]
    fn vdb_microsoft_example_partial_first_year_factor_1_5() {
        // VDB(2400, 300, 10, 0, 0.875, 1.5) = $315.00.
        // rate = 1.5/10 = 0.15; period-1 DDB = 2400 * 0.15 = 360.
        // SLN = (2400-300)/10 = 210; DDB > SLN, no switch.
        // Fraction 0.875 * 360 = 315.00.
        approx(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(0.875), n(1.5)]),
            315.0,
            0.01,
        );
    }

    /// **W5-183.1 (Opus MEDIUM-5 closure):** previously named
    /// `vdb_no_switch_keeps_ddb_throughout` and asserted both forms
    /// summed to `cost - salvage = 2100` for fixture (2400/300/10).
    /// That's actually the **salvage-cap invariant**, not a `no_switch`
    /// invariant — for fixture (2400/300/10) the DDB schedule HAPPENS
    /// to hit the salvage cap in the final period. Codex hand-traced
    /// (1000/100/10) where the cap does NOT bottom out in 10 periods,
    /// giving total = 892.6258176 ≠ 900. Pin both fixtures so the
    /// false-invariant claim cannot resurface.
    #[test]
    fn vdb_no_switch_full_life_salvage_cap_fixture() {
        // (2400/300/10): DDB schedule hits salvage cap in period 9
        // (book drops below salvage*1.05 in period 8 → cap kicks in).
        // Total no_switch depreciation = cost - salvage = 2100 exactly.
        approx(
            vdb(&[
                n(2400.0),
                n(300.0),
                n(10.0),
                n(0.0),
                n(10.0),
                n(2.0),
                Value::Boolean(true),
            ]),
            2100.0,
            1e-9,
        );
    }

    #[test]
    fn vdb_no_switch_full_life_below_cost_salvage_when_cap_not_reached() {
        // (1000/100/10): cost/salvage ratio is 10:1; DDB rate 0.2
        // halves book ~every 3.1 periods. After 10 periods book ≈
        // 107.3741824 (still above salvage=100), so the cap never
        // engages. Total depreciation = cost - book ≈ 892.6258176,
        // NOT 900 = cost - salvage. This contrasts with the (2400/
        // 300/10) fixture above and proves the W5-183 docstring
        // claim about no_switch "full depreciation either way" is
        // fixture-specific, not general.
        // Independent verification: Codex audit (LibreOffice port).
        approx(
            vdb(&[
                n(1000.0),
                n(100.0),
                n(10.0),
                n(0.0),
                n(10.0),
                n(2.0),
                Value::Boolean(true),
            ]),
            892.6258176,
            1e-6,
        );
    }

    /// **W5-183.1 (Codex MEDIUM-2 / Opus MEDIUM-4 closure):**
    /// previously asserted only `switched >= no_switch` inequality —
    /// would pass even if the switch was a no-op. Replaced with exact
    /// values from Codex's LibreOffice cross-check.
    #[test]
    fn vdb_default_vs_no_switch_partial_late_range_libreoffice() {
        // VDB(1000, 100, 10, 5, 10) = 227.68 (default: switches to SLN
        // mid-life since SLN > DDB by period 5+).
        // VDB(1000, 100, 10, 5, 10, 2, TRUE) = 220.3058176 (no_switch
        // stays on the decaying DDB schedule throughout, smaller sum).
        let extract = |args: Vec<Value>| -> f64 {
            match vdb(&args) {
                Value::Number(x) => x,
                other => panic!("expected Number, got {other:?}"),
            }
        };
        let switched = extract(vec![n(1000.0), n(100.0), n(10.0), n(5.0), n(10.0)]);
        let locked = extract(vec![
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            Value::Boolean(true),
        ]);
        assert!(
            (switched - 227.68).abs() < 1e-2,
            "switched expected ≈ 227.68, got {switched}"
        );
        assert!(
            (locked - 220.3058176).abs() < 1e-6,
            "locked expected ≈ 220.3058176, got {locked}"
        );
        // Meaningful divergence of ~7.37 between the two modes —
        // proves the switch flag actually matters for this fixture.
        assert!(
            (switched - locked).abs() > 5.0,
            "expected meaningful divergence > 5.0 between switched ({switched}) and locked ({locked})"
        );
    }

    // --- W5-183.1 LibreOffice cross-check fixtures (Codex MEDIUM-2 fill-in) ---
    //
    // Independent reference values Codex computed by running the
    // LibreOffice / OpenFormula VDB algorithm in Python. Pinned here
    // to provide non-Microsoft canonical verification beyond the 6
    // Microsoft docs examples.

    #[test]
    fn vdb_libreoffice_periods_5_to_7() {
        // VDB(1000, 100, 10, 5, 7) = 117.9648 — exercises the
        // crossover region (period 5 marks roughly where SLN > DDB
        // for this fixture).
        approx(
            vdb(&[n(1000.0), n(100.0), n(10.0), n(5.0), n(7.0)]),
            117.9648,
            1e-4,
        );
    }

    #[test]
    fn vdb_libreoffice_fractional_overlap_half_period_boundary() {
        // VDB(1000, 100, 10, 0.5, 1.5) = 180 — half of period 1 +
        // half of period 2. Exercises the fractional-overlap math
        // at both start and end of the range.
        // Period 1: book=1000, ddb=200; sln=(1000-100)/10=90; DDB > SLN, no switch.
        // Overlap of [0,1] with [0.5,1.5] = 0.5. Contribution = 200 * 0.5 = 100.
        // Book after period 1 (full update): 800.
        // Period 2: book=800, ddb=160; sln=(800-100)/9 ≈ 77.78; DDB > SLN, no switch.
        // Overlap of [1,2] with [0.5,1.5] = 0.5. Contribution = 160 * 0.5 = 80.
        // Total = 100 + 80 = 180.
        approx(
            vdb(&[n(1000.0), n(100.0), n(10.0), n(0.5), n(1.5)]),
            180.0,
            1e-9,
        );
    }

    #[test]
    fn vdb_libreoffice_fractional_overlap_mid_life() {
        // VDB(1000, 100, 10, 2.3, 4.7) = 249.344 — covers partial
        // period 3 (fraction 0.7), all of period 4, partial period 5
        // (fraction 0.7). Hand-traced via Codex's LibreOffice port.
        approx(
            vdb(&[n(1000.0), n(100.0), n(10.0), n(2.3), n(4.7)]),
            249.344,
            1e-3,
        );
    }

    // --- VDB validation closures ---

    #[test]
    fn vdb_start_equals_end_returns_zero() {
        // Empty range → 0 (depreciation over an empty period is 0).
        approx(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(3.0), n(3.0)]),
            0.0,
            1e-12,
        );
    }

    #[test]
    fn vdb_cost_zero_returns_zero() {
        approx(vdb(&[n(0.0), n(0.0), n(10.0), n(0.0), n(10.0)]), 0.0, 1e-12);
    }

    #[test]
    fn vdb_end_before_start_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(5.0), n(3.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_end_exceeds_life_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(11.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_negative_start_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(-1.0), n(5.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_zero_life_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(0.0), n(0.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_negative_cost_is_num() {
        assert_eq!(
            vdb(&[n(-2400.0), n(300.0), n(10.0), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_negative_salvage_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(-300.0), n(10.0), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_zero_factor_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(1.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// **W5-183.1 (Opus HIGH-1 / Codex MEDIUM-1 closure):** DoS
    /// guard was off-by-one — `>` allowed exactly `i32::MAX as f64`
    /// to pass validation, then loop ran ~2.15B iterations. Now `>=`.
    /// Pin both `1e15` (far above) and `i32::MAX as f64` (boundary)
    /// AND the end_period side of the guard.
    #[test]
    fn vdb_huge_life_rejected() {
        // 1e15 >> i32::MAX ≈ 2.147e9 — rejected (was always rejected).
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(1e15), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        // **W5-183.1 boundary fix:** EXACTLY i32::MAX as f64 must
        // now reject. Under W5-183 with `>` guard, this passed and
        // triggered the 2.15B-iteration loop.
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(i32::MAX as f64), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn vdb_huge_end_period_rejected() {
        // **W5-183.1 (Opus MEDIUM-6 closure):** end_period side of
        // the DoS guard was untested. Pin it explicitly.
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(i32::MAX as f64)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(1e15)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// **W5-183.1 (Codex HIGH-1 closure):** `salvage > cost`
    /// previously slipped past validation and silently returned 0.
    /// LibreOffice / OpenFormula reject; we now match.
    #[test]
    fn vdb_salvage_exceeds_cost_is_num() {
        assert_eq!(
            vdb(&[n(100.0), n(200.0), n(10.0), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
        // Boundary: salvage = cost exactly returns 0 (zero
        // depreciation possible from a fully-recoverable asset).
        approx(
            vdb(&[n(100.0), n(100.0), n(10.0), n(0.0), n(10.0)]),
            0.0,
            1e-12,
        );
    }

    /// **W5-183.1 (Opus MEDIUM-9 closure):** explicit negative-factor
    /// validation test (previously only `zero_factor` was pinned).
    #[test]
    fn vdb_negative_factor_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(1.0), n(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// **W5-183.1 (Opus MEDIUM-9 closure):** explicit negative-life
    /// validation (the `life <= 0` chain covers this, but pin it
    /// directly so a refactor that splits the chain can't regress).
    #[test]
    fn vdb_negative_life_is_num() {
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(-10.0), n(0.0), n(1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    /// **W5-183.1 (Opus MEDIUM-10 closure):** start_period=0 explicit
    /// boundary test. Microsoft examples all use start=0 implicitly;
    /// pin that the start=0 path is exercised correctly.
    #[test]
    fn vdb_start_period_zero_returns_full_first_period() {
        // VDB(2400, 300, 10, 0, 1) = 480 (first full year).
        approx(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(1.0)]),
            480.0,
            1e-9,
        );
    }

    /// **W5-183.1 (Opus LOW-2 closure):** start == end == 0 boundary —
    /// both upper and lower bounds at the start of life.
    #[test]
    fn vdb_start_zero_equals_end_zero_returns_zero() {
        approx(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0), n(0.0)]),
            0.0,
            1e-12,
        );
    }

    /// **W5-183.1 (Opus LOW-3 closure):** additivity invariant.
    /// VDB(start, k) + VDB(k, end) = VDB(start, end) for any k in
    /// `[start, end]`. Pin one concrete partition to catch
    /// regressions in either the overlap math or the per-period
    /// book accounting.
    #[test]
    fn vdb_additivity_invariant() {
        // VDB(2400, 300, 120, 0, 18) should equal
        // VDB(2400, 300, 120, 0, 6) + VDB(2400, 300, 120, 6, 18).
        let extract = |args: Vec<Value>| -> f64 {
            match vdb(&args) {
                Value::Number(x) => x,
                other => panic!("expected Number, got {other:?}"),
            }
        };
        let whole = extract(vec![n(2400.0), n(300.0), n(120.0), n(0.0), n(18.0)]);
        let left = extract(vec![n(2400.0), n(300.0), n(120.0), n(0.0), n(6.0)]);
        let right = extract(vec![n(2400.0), n(300.0), n(120.0), n(6.0), n(18.0)]);
        assert!(
            (whole - (left + right)).abs() < 1e-9,
            "additivity violated: whole={whole}, left+right={}",
            left + right
        );
    }

    #[test]
    fn vdb_wrong_arity() {
        assert_eq!(vdb(&[]), Value::Error(ErrorValue::Value));
        // 4 args (need at least 5)
        assert_eq!(
            vdb(&[n(2400.0), n(300.0), n(10.0), n(0.0)]),
            Value::Error(ErrorValue::Value)
        );
        // 8 args (max is 7)
        assert_eq!(
            vdb(&[
                n(2400.0),
                n(300.0),
                n(10.0),
                n(0.0),
                n(1.0),
                n(2.0),
                Value::Boolean(false),
                n(0.0)
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn vdb_error_in_arg_propagates() {
        assert_eq!(
            vdb(&[
                Value::Error(ErrorValue::Ref),
                n(300.0),
                n(10.0),
                n(0.0),
                n(1.0)
            ]),
            Value::Error(ErrorValue::Ref)
        );
        // Error in the optional no_switch arg too.
        assert_eq!(
            vdb(&[
                n(2400.0),
                n(300.0),
                n(10.0),
                n(0.0),
                n(1.0),
                n(2.0),
                Value::Error(ErrorValue::Name)
            ]),
            Value::Error(ErrorValue::Name)
        );
    }

    /// **W5-183.1 (Opus MEDIUM-3 closure):** previously the fixture
    /// used `VDB(2400, 300, 10, 0, 1, 2, TRUE/FALSE)` which produces
    /// $480 in BOTH cases (period 1 DDB > SLN so the switch flag is
    /// inert). The test would pass even if `no_switch` was completely
    /// ignored. Replaced with a fixture where the flag genuinely
    /// changes the output, plus a numeric-coercion-equivalence test.
    #[test]
    fn vdb_boolean_no_switch_genuinely_changes_result() {
        // Fixture chosen so the switch matters mid-life:
        // VDB(1000, 100, 10, 5, 10) with TRUE vs FALSE diverges by ~7.37.
        // Verified independently against LibreOffice / OpenFormula.
        let extract = |args: Vec<Value>| -> f64 {
            match vdb(&args) {
                Value::Number(x) => x,
                other => panic!("expected Number, got {other:?}"),
            }
        };
        let with_true = extract(vec![
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            Value::Boolean(true),
        ]);
        let with_false = extract(vec![
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            Value::Boolean(false),
        ]);
        assert!(
            (with_true - 220.3058176).abs() < 1e-6,
            "no_switch=TRUE expected ≈ 220.3058176, got {with_true}"
        );
        assert!(
            (with_false - 227.68).abs() < 1e-2,
            "no_switch=FALSE expected ≈ 227.68, got {with_false}"
        );
        assert!(
            (with_true - with_false).abs() > 5.0,
            "no_switch TRUE/FALSE must produce meaningfully \
             different results — TRUE={with_true}, FALSE={with_false}"
        );
    }

    /// **W5-183.1 (Opus MEDIUM-2 closure):** the `no_switch` arg uses
    /// `arg_type`, which is NOT "Boolean-strict" (despite earlier doc
    /// wording). It extends `arg_num` with numeric-to-bool coercion:
    /// non-zero numeric → TRUE; zero/blank → FALSE; errors propagate.
    /// Pin equivalence between Boolean and numeric forms.
    #[test]
    fn vdb_no_switch_numeric_coerces_to_bool() {
        // n(1.0) should be equivalent to Boolean(true) via `arg_type`.
        let bool_true = vdb(&[
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            Value::Boolean(true),
        ]);
        let num_one = vdb(&[
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            n(1.0),
        ]);
        assert_eq!(bool_true, num_one);

        // n(0.0) should be equivalent to Boolean(false).
        let bool_false = vdb(&[
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            Value::Boolean(false),
        ]);
        let num_zero = vdb(&[
            n(1000.0),
            n(100.0),
            n(10.0),
            n(5.0),
            n(10.0),
            n(2.0),
            n(0.0),
        ]);
        assert_eq!(bool_false, num_zero);
    }

    // ===== W5-D-7 (Wave 3 closure — date-indexed cash flow) =====
    //
    // XNPV / XIRR. Closed-form anchors via Excel's canonical examples;
    // round-trip XIRR ∘ XNPV (XIRR(values, dates) is the rate r such
    // that XNPV(r, values, dates) = 0); domain rejections per IronCalc.

    fn n2(x: f64) -> Value {
        // Local alias for date arity to keep tests readable.
        Value::Number(x)
    }

    // --- XNPV ---

    #[test]
    fn xnpv_microsoft_canonical_anchor() {
        // Microsoft canonical XNPV example:
        //   values = [-10000, 2750, 4250, 3250, 2750]
        //   dates  = [2008-01-01, 2008-03-01, 2008-10-30, 2009-02-15, 2009-04-01]
        //   rate = 0.09 (9%)
        //   result ≈ 2086.6478 (Microsoft anchor).
        // Excel serial dates: 1900-based.
        //   2008-01-01 = 39448
        //   2008-03-01 = 39508
        //   2008-10-30 = 39751
        //   2009-02-15 = 39859
        //   2009-04-01 = 39904
        let values = r(vec![
            n(-10000.0),
            n(2750.0),
            n(4250.0),
            n(3250.0),
            n(2750.0),
        ]);
        let dates = r(vec![
            n2(39448.0),
            n2(39508.0),
            n2(39751.0),
            n2(39859.0),
            n2(39904.0),
        ]);
        let result = xnpv(&[s(n(0.09)), values, dates]);
        match result {
            Value::Number(got) => assert!(
                (got - 2086.6478).abs() < 1.0,
                "expected ≈ 2086.65, got {got}"
            ),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn xnpv_single_value_returns_value_at_zero_offset() {
        // Single value at d0: XNPV = v0 (no discount applied; (di-d0)/365 = 0
        // for i=0 is implicit since we start the sum at i=0 with v[0]).
        let values = r(vec![n(100.0)]);
        let dates = r(vec![n2(40000.0)]);
        approx(xnpv(&[s(n(0.05)), values, dates]), 100.0, 1e-9);
    }

    #[test]
    fn xnpv_rate_at_or_below_negative_one_is_num_error() {
        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus LOW-3 closure):**
        // XNPV now accepts negative rates (rate ∈ (-1, 0]) per Excel
        // canon. Only `rate <= -1` is rejected because the `(1+rate)^t`
        // denominator requires `1+rate > 0`.
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        // rate = -1 → 1+rate = 0 → division-by-zero territory → #NUM!.
        assert_eq!(
            xnpv(&[s(n(-1.0)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
        // rate < -1 → 1+rate < 0 → fractional power undefined → #NUM!.
        let values2 = r(vec![n(-100.0), n(110.0)]);
        let dates2 = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(
            xnpv(&[s(n(-1.5)), values2, dates2]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xnpv_negative_rate_in_neg_one_zero_open_interval_works() {
        // **W5-D-13.1 megaudit Opus LOW-3 closure:** rate ∈ (-1, 0)
        // is now accepted (previously incorrectly rejected as #NUM!).
        // For a -5% rate the discount factor (1 + r)^t < 1 for t > 0
        // when r < 0; cash flows in the future are worth MORE than
        // their face value.
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        // Just verify the computation succeeds and produces a finite
        // numeric result; exact value depends on the discount formula.
        match xnpv(&[s(n(-0.05)), values, dates]) {
            Value::Number(v) if v.is_finite() => {
                // Sanity: at rate=-0.05, the future +110 is discounted
                // UP (worth more than 110). So XNPV should be > 110 -
                // 100 = 10.
                assert!(v > 10.0, "expected XNPV > 10 at rate=-0.05, got {v}");
            }
            other => panic!("expected finite Number, got {other:?}"),
        }
        // Rate = 0 (zero discount): XNPV ≡ sum of values.
        let values2 = r(vec![n(-100.0), n(110.0)]);
        let dates2 = r(vec![n2(40000.0), n2(40365.0)]);
        match xnpv(&[s(n(0.0)), values2, dates2]) {
            Value::Number(v) => {
                assert!((v - 10.0).abs() < 1e-9, "rate=0 sum should be 10, got {v}");
            }
            other => panic!("expected Number(10.0), got {other:?}"),
        }
    }

    #[test]
    fn xnpv_dates_length_mismatch_is_num_error() {
        let values = r(vec![n(-100.0), n(50.0), n(60.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xnpv_date_precedes_first_is_num_error() {
        let values = r(vec![n(-100.0), n(50.0)]);
        let dates = r(vec![n2(40000.0), n2(39000.0)]); // second date < first
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xnpv_date_outside_excel_serial_range_is_num_error() {
        let values = r(vec![n(-100.0), n(50.0)]);
        let dates = r(vec![n2(40000.0), n2(3_000_000.0)]); // exceeds MAX_DATE_SERIAL
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xnpv_empty_cell_in_values_is_num_error() {
        // Per IronCalc canon: empty cells in XNPV's value/date ranges reject.
        let values = r(vec![n(-100.0), Value::Blank, n(50.0)]);
        let dates = r(vec![n2(40000.0), n2(40100.0), n2(40365.0)]);
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xnpv_text_in_dates_is_value_error() {
        // **W5-D-7.1 (Codex MEDIUM-2 + Opus MEDIUM-O-1 closure):** XNPV
        // distinguishes its two array args by error class for
        // non-numeric cells per IronCalc canon:
        // - `values` arg → non-numeric → #NUM!
        // - `dates`  arg → non-numeric → #VALUE!
        // Prior test pinned the wrong class (#NUM! for both). Corrected.
        let values = r(vec![n(-100.0), n(50.0)]);
        let dates = r(vec![n2(40000.0), Value::text("not a date")]);
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn xnpv_text_in_values_is_num_error() {
        // **W5-D-7.1 (Codex MEDIUM-2 + Opus MEDIUM-O-1 closure):**
        // companion to `xnpv_text_in_dates_is_value_error` pinning the
        // values-side error class (#NUM!).
        let values = r(vec![n(-100.0), Value::text("not a number")]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xnpv_error_in_values_propagates() {
        let values = r(vec![n(-100.0), Value::Error(ErrorValue::Ref)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn xnpv_scalar_for_values_is_value_error() {
        assert_eq!(
            xnpv(&[s(n(0.05)), s(n(100.0)), r(vec![n2(40000.0)])]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn xnpv_arity_violations() {
        // 0, 1, 2, and 4+ args → #VALUE!.
        assert_eq!(xnpv(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(xnpv(&[s(n(0.05))]), Value::Error(ErrorValue::Value));
        assert_eq!(
            xnpv(&[s(n(0.05)), r(vec![n(100.0)])]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            xnpv(&[
                s(n(0.05)),
                r(vec![n(100.0)]),
                r(vec![n2(40000.0)]),
                s(n(0.0)),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- XIRR ---

    #[test]
    fn xirr_microsoft_canonical_anchor() {
        // Microsoft canonical XIRR example:
        //   values = [-10000, 2750, 4250, 3250, 2750]
        //   dates  = same as XNPV example above
        //   result ≈ 0.373362535 (37.33%).
        let values = r(vec![
            n(-10000.0),
            n(2750.0),
            n(4250.0),
            n(3250.0),
            n(2750.0),
        ]);
        let dates = r(vec![
            n2(39448.0),
            n2(39508.0),
            n2(39751.0),
            n2(39859.0),
            n2(39904.0),
        ]);
        let result = xirr(&[values, dates]);
        match result {
            Value::Number(got) => assert!(
                (got - 0.373362535).abs() < 1e-5,
                "expected ≈ 0.3734, got {got}"
            ),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn xirr_round_trip_with_xnpv() {
        // XNPV(xirr_result, values, dates) ≈ 0 (XIRR is the rate making
        // XNPV zero by definition).
        let values_vec = vec![-10000.0, 2750.0, 4250.0, 3250.0, 2750.0];
        let dates_vec = vec![39448.0, 39508.0, 39751.0, 39859.0, 39904.0];
        let values = r(vec![
            n(-10000.0),
            n(2750.0),
            n(4250.0),
            n(3250.0),
            n(2750.0),
        ]);
        let dates = r(vec![
            n2(39448.0),
            n2(39508.0),
            n2(39751.0),
            n2(39859.0),
            n2(39904.0),
        ]);
        let rate = match xirr(&[values, dates]) {
            Value::Number(r) => r,
            other => panic!("XIRR returned {other:?}"),
        };
        let npv_at_rate = compute_xnpv(rate, &values_vec, &dates_vec).expect("xnpv");
        assert!(
            npv_at_rate.abs() < 1e-4,
            "XNPV(XIRR(...)) should be ~0, got {npv_at_rate}"
        );
    }

    #[test]
    fn xirr_all_positive_values_is_num_error() {
        // No sign change → no IRR.
        let values = r(vec![n(100.0), n(200.0), n(300.0)]);
        let dates = r(vec![n2(40000.0), n2(40100.0), n2(40365.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn xirr_all_negative_values_is_num_error() {
        let values = r(vec![n(-100.0), n(-200.0), n(-300.0)]);
        let dates = r(vec![n2(40000.0), n2(40100.0), n2(40365.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn xirr_optional_guess() {
        // Guess defaults to 0.1; explicit guess should produce same result.
        let v1 = r(vec![n(-1000.0), n(500.0), n(600.0)]);
        let d1 = r(vec![n2(40000.0), n2(40180.0), n2(40365.0)]);
        let v2 = r(vec![n(-1000.0), n(500.0), n(600.0)]);
        let d2 = r(vec![n2(40000.0), n2(40180.0), n2(40365.0)]);
        let no_guess = xirr(&[v1, d1]);
        let with_guess = xirr(&[v2, d2, s(n(0.1))]);
        match (no_guess, with_guess) {
            (Value::Number(a), Value::Number(b)) => {
                assert!((a - b).abs() < 1e-9, "guess default mismatch: {a} vs {b}");
            }
            other => panic!("XIRR returned {other:?}"),
        }
    }

    #[test]
    fn xirr_guess_at_or_below_minus_one_is_value_error() {
        let values = r(vec![n(-100.0), n(50.0), n(60.0)]);
        let dates = r(vec![n2(40000.0), n2(40180.0), n2(40365.0)]);
        // compute_xirr returns Value error for guess <= -1.
        assert_eq!(
            xirr(&[values, dates, s(n(-1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn xirr_empty_cell_in_values_treated_as_zero() {
        // XIRR empty-cell rule (differs from XNPV): empty → 0.0.
        // Need at least one positive and one negative cash flow after
        // the substitution.
        let values = r(vec![n(-100.0), Value::Blank, n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(40180.0), n2(40365.0)]);
        // Should succeed (no rejection of empty); compute_xirr returns
        // some number.
        match xirr(&[values, dates]) {
            Value::Number(_) => {}
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn xirr_text_in_values_is_value_error() {
        // XIRR rejects text/bool with #VALUE!.
        let values = r(vec![n(-100.0), Value::text("nope"), n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(40180.0), n2(40365.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn xirr_dates_length_mismatch_is_num_error() {
        let values = r(vec![n(-100.0), n(50.0), n(60.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn xirr_date_precedes_first_is_num_error() {
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(39000.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn xirr_error_in_values_propagates() {
        let values = r(vec![n(-100.0), Value::Error(ErrorValue::DivZero)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn xirr_arity_violations() {
        assert_eq!(xirr(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            xirr(&[r(vec![n(-100.0), n(110.0)])]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            xirr(&[
                r(vec![n(-100.0), n(110.0)]),
                r(vec![n2(40000.0), n2(40365.0)]),
                s(n(0.1)),
                s(n(0.0)),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // === W5-D-7.1 audit-closure regression tests ===

    #[test]
    fn xirr_near_minus_one_guess_high1_regression() {
        // **W5-D-7.1 (Codex HIGH-1 closure):** Regression for the
        // residual-check fix. The IronCalc-port version of
        // `xirr_newton` accepted step-size convergence even when the
        // residual was huge (occurs near the `rate = -1` singularity).
        //
        // Repro: `values=[-100, 1000]`, `dates=[40000, 40365]`,
        // `guess=-0.999999999`. The true root is exactly `r=9.0`
        // because `-100 + 1000/(1+9) = 0`. The old impl returned
        // about `-0.999999998` (a non-root with residual ~5e11);
        // post-closure, the residual check kicks Newton out and the
        // bisection fallback (or larger-guess Newton) finds `9.0`.
        let values = r(vec![n(-100.0), n(1000.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        let result = xirr(&[values, dates, s(n(-0.999999999))]);
        match result {
            Value::Number(rate) => assert!(
                (rate - 9.0).abs() < 1e-4,
                "expected ≈ 9.0, got {rate} (non-root regression — residual check failed?)"
            ),
            other => panic!("expected Number ≈ 9.0, got {other:?}"),
        }
    }

    #[test]
    fn xirr_bisection_fallback_path() {
        // **W5-D-7.1 (Codex LOW-1 closure):** force Newton to fail by
        // using a guess that produces a near-zero derivative, then
        // verify bisection finds the root. The two-cash-flow schedule
        // `values=[-100, 110]` over one year (365 days) has analytic
        // root `r = 0.10` (10% annual return). Use a divergent guess
        // (`5.0` — far from root) so Newton may overshoot multiple
        // times before bisection takes over. Result should still be
        // ≈ 0.10.
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        let result = xirr(&[values, dates, s(n(5.0))]);
        match result {
            Value::Number(rate) => {
                assert!((rate - 0.10).abs() < 1e-4, "expected ≈ 0.10, got {rate}")
            }
            other => panic!("expected Number ≈ 0.10, got {other:?}"),
        }
    }

    #[test]
    fn xirr_nan_guess_is_num_error() {
        // **W5-D-7.1 (Opus LOW closure):** NaN guess is rejected at
        // the COERCION layer (`to_number_strict_skip_blank` returns
        // `#NUM!` for `Value::Number(NaN)`) BEFORE reaching the
        // `compute_xirr` domain check. The `guess.is_nan()` guard
        // added to `compute_xirr` is defense-in-depth for direct
        // callers that bypass the coercion layer; the public XIRR
        // surface returns `#NUM!`.
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(40000.0), n2(40365.0)]);
        assert_eq!(
            xirr(&[values, dates, s(n(f64::NAN))]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn compute_xirr_direct_nan_guess_is_value_error() {
        // **W5-D-7.1 (Opus LOW defense-in-depth):** pin the
        // `compute_xirr` NaN guard for callers that skip the
        // coercion layer (e.g. internal kernel reuse).
        let values = vec![-100.0, 110.0];
        let dates = vec![40000.0, 40365.0];
        assert_eq!(
            compute_xirr(&values, &dates, f64::NAN),
            Err(ErrorValue::Value)
        );
    }

    #[test]
    fn xnpv_date_serial_zero_is_num_error() {
        // **W5-D-7.1 (Codex MEDIUM-1 + Opus MEDIUM-O-2 closure):**
        // serial 0 is Excel's "1/0/1900" display oddity, not a real
        // YMD. IronCalc's `MINIMUM_DATE_SERIAL_NUMBER = 1`; we matched
        // by raising `MIN_DATE_SERIAL` from 0.0 to 1.0. Pin the
        // rejection of serial 0 in XNPV.
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(0.0), n2(365.0)]);
        assert_eq!(
            xnpv(&[s(n(0.05)), values, dates]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn xirr_date_serial_zero_is_num_error() {
        // Companion to `xnpv_date_serial_zero_is_num_error`.
        let values = r(vec![n(-100.0), n(110.0)]);
        let dates = r(vec![n2(0.0), n2(365.0)]);
        assert_eq!(xirr(&[values, dates]), Value::Error(ErrorValue::Num));
    }
}
