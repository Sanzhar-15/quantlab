//! Phase 4.5.B (W5-72) — date / time function library wave 1.
//!
//! First eight of the V1 wave 18 (per W5-68 design doc § 5.1):
//! DATE, YEAR, MONTH, DAY (ContextAwareFn — need workbook date_system),
//! HOUR, MINUTE, SECOND, TIME (ScalarFn — pure functions of the
//! serial's fractional part / hms inputs).
//!
//! The remaining 10 (DATEVALUE, TIMEVALUE, WEEKDAY, EOMONTH, EDATE,
//! DAYS, NETWORKDAYS, WORKDAY, YEARFRAC) land in W5-73/W5-74.

use ql_types::{coercion, ymd_to_serial, ErrorValue, EvalContext, Value};

// ============================================================================
// Internal helpers
// ============================================================================

/// Coerce a single arg to an integer-like `i64` for date-arg use.
///
/// Numbers truncate toward zero. Bool 1/0. Blank 0. Text lenient-parse.
/// Error propagates. NaN/Inf → `#NUM!`.
fn to_int_date_arg(v: &Value) -> Result<i64, ErrorValue> {
    match v {
        Value::Number(n) => {
            if n.is_nan() || n.is_infinite() {
                Err(ErrorValue::Num)
            } else {
                Ok(n.trunc() as i64)
            }
        }
        Value::Boolean(b) => Ok(if *b { 1 } else { 0 }),
        Value::Blank => Ok(0),
        Value::Text(s) => match coercion::to_number_lenient(&Value::Text(s.clone())) {
            Ok(n) => {
                if n.is_nan() || n.is_infinite() {
                    Err(ErrorValue::Num)
                } else {
                    Ok(n.trunc() as i64)
                }
            }
            Err(_) => Err(ErrorValue::Value),
        },
        Value::Error(e) => Err(*e),
    }
}

/// Coerce a single arg to `f64` for a serial. Strict-text rejection
/// (no `"2024-01-01"` parsing here — that's DATEVALUE's job).
fn to_serial_arg(v: &Value) -> Result<f64, ErrorValue> {
    match v {
        Value::Number(n) => {
            if n.is_nan() || n.is_infinite() {
                Err(ErrorValue::Num)
            } else {
                Ok(*n)
            }
        }
        Value::Boolean(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Blank => Ok(0.0),
        Value::Text(_) => Err(ErrorValue::Value),
        Value::Error(e) => Err(*e),
    }
}

// ============================================================================
// DATE(y, m, d) — ContextAwareFn
// ============================================================================

/// **`DATE(year, month, day)`** — construct an Excel serial day from
/// three numeric args. Returns `#NUM!` if the result is outside the
/// supported range (`1900-01-01..=9999-12-31` in 1900-system;
/// `1904-01-01..=9999-12-31` in 1904-system).
///
/// **Excel canon (W5-68 design doc § 5.1):**
/// - `year` in `0..=1899` is coerced by adding 1900 (legacy two-digit
///   year support — `DATE(50, 1, 1)` is treated as `1950-01-01`).
/// - `year < 0` → `#NUM!`.
/// - `month` and `day` cascade: out-of-range values roll the date
///   forward or backward. `DATE(2024, 13, 1) = DATE(2025, 1, 1)`;
///   `DATE(2024, 1, 32) = DATE(2024, 2, 1)`; `DATE(2024, 0, 5) =
///   DATE(2023, 12, 5)`.
/// - In Excel1900, `DATE(1900, 2, 29) = 60` (the phantom day; per the
///   serial-60 contract pinned in W5-68 design doc § 3.2).
pub fn date_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let y = match to_int_date_arg(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let m = match to_int_date_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let d = match to_int_date_arg(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };

    // Excel canon: year 0..=1899 → year + 1900.
    let y = if (0..=1899).contains(&y) { y + 1900 } else { y };
    // Negative year is #NUM! in Excel.
    if !(0..=9999).contains(&y) {
        return Value::Error(ErrorValue::Num);
    }

    // Normalize month overflow. total_months counts from year 0 January
    // (0-indexed): year_index = (y - 1) * 12 + (m - 1) for y >= 1.
    // Use Euclidean div/mod so negative months roll backward correctly.
    let total_months = (y - 1) * 12 + (m - 1);
    let norm_y = (total_months.div_euclid(12) + 1) as i32;
    let norm_m = (total_months.rem_euclid(12) + 1) as u32;
    if !(1..=9999).contains(&norm_y) {
        return Value::Error(ErrorValue::Num);
    }

    // Cascade via SERIAL arithmetic (not unix-days) so the Excel1900
    // phantom-day-skip is correctly accounted for in BOTH directions:
    //   - DATE(1900, 2, 29) returns 60 directly (phantom).
    //   - DATE(1900, 1, 60) returns 60 (Jan 1 + 59 days = phantom).
    //   - DATE(1900, 3, 1) returns 61.
    // Going through unix_days_to_ymd loses this — proleptic Gregorian
    // can't represent the phantom Feb 29 1900.
    let base_serial = match ymd_to_serial(norm_y, norm_m, 1, ctx.date_system) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let final_serial = base_serial + (d as f64 - 1.0);
    if final_serial
        < (match ctx.date_system {
            ql_types::DateSystem::Excel1900 => 1.0,
            ql_types::DateSystem::Excel1904 => 0.0,
        })
        || final_serial > ql_types::MAX_EXCEL_SERIAL_DAY as f64
    {
        return Value::Error(ErrorValue::Num);
    }
    Value::Number(final_serial)
}

// ============================================================================
// YEAR / MONTH / DAY — ContextAwareFn (need date_system for serial interp)
// ============================================================================

/// **`YEAR(serial)`** — extract the year component. Range 1900..=9999.
pub fn year_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    match ql_types::serial_to_ymd(serial, ctx.date_system) {
        Ok((y, _, _)) => Value::Number(y as f64),
        Err(e) => Value::Error(e),
    }
}

/// **`MONTH(serial)`** — extract month (1..=12).
pub fn month_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    match ql_types::serial_to_ymd(serial, ctx.date_system) {
        Ok((_, m, _)) => Value::Number(m as f64),
        Err(e) => Value::Error(e),
    }
}

/// **`DAY(serial)`** — extract day-of-month (1..=31).
pub fn day_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    match ql_types::serial_to_ymd(serial, ctx.date_system) {
        Ok((_, _, d)) => Value::Number(d as f64),
        Err(e) => Value::Error(e),
    }
}

// ============================================================================
// HOUR / MINUTE / SECOND — ScalarFn (pure function of fractional part)
// ============================================================================

/// **`HOUR(serial)`** — hour-of-day from the fractional part (0..=23).
/// Pure scalar; not affected by `date_system`.
pub fn hour(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    if serial < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let (h, _, _) = ql_types::fraction_to_hms(serial);
    Value::Number(h as f64)
}

/// **`MINUTE(serial)`** — minute (0..=59).
pub fn minute(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    if serial < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let (_, m, _) = ql_types::fraction_to_hms(serial);
    Value::Number(m as f64)
}

/// **`SECOND(serial)`** — second (0..=59). Integer truncation.
pub fn second(args: &[Value]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    if serial < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let (_, _, s) = ql_types::fraction_to_hms(serial);
    Value::Number(s as f64)
}

// ============================================================================
// TIME(h, m, s) — ScalarFn (pure)
// ============================================================================

/// **`TIME(hour, minute, second)`** — return a time-of-day fraction in
/// `[0, 1)`. Excel canon: each arg truncated to integer; negative args
/// → `#NUM!`. Hours ≥ 24 wrap modulo 24; cascading minutes/seconds.
/// `TIME(25, 0, 0) == TIME(1, 0, 0) == 1.0/24.0`.
pub fn time(args: &[Value]) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let h = match to_int_date_arg(&args[0]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let m = match to_int_date_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let s = match to_int_date_arg(&args[2]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if h < 0 || m < 0 || s < 0 {
        return Value::Error(ErrorValue::Num);
    }
    // Cap h to a reasonable bound to avoid overflow in
    // `h*3600 + m*60 + s`. Excel canon: h up to ~32767. We bound at u32 max.
    if h > u32::MAX as i64 || m > u32::MAX as i64 || s > u32::MAX as i64 {
        return Value::Error(ErrorValue::Num);
    }
    let frac = ql_types::hms_to_fraction(h as u32, m as u32, s as u32);
    Value::Number(frac)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::DateSystem;

    fn ctx_1900() -> EvalContext {
        EvalContext::default()
    }

    fn ctx_1904() -> EvalContext {
        EvalContext {
            date_system: DateSystem::Excel1904,
            ..EvalContext::default()
        }
    }

    fn n(x: f64) -> Value {
        Value::Number(x)
    }

    // ===== DATE =====

    #[test]
    fn date_happy_path_1900_system() {
        // 1900-01-01 → serial 1.
        assert_eq!(date_ctx(&[n(1900.0), n(1.0), n(1.0)], &ctx_1900()), n(1.0));
        // 1970-01-01 → 25569.
        assert_eq!(
            date_ctx(&[n(1970.0), n(1.0), n(1.0)], &ctx_1900()),
            n(25569.0)
        );
        // 9999-12-31 → 2_958_465.
        assert_eq!(
            date_ctx(&[n(9999.0), n(12.0), n(31.0)], &ctx_1900()),
            n(2_958_465.0)
        );
    }

    #[test]
    fn date_phantom_day_in_excel1900() {
        // DATE(1900, 2, 29) returns the phantom serial 60 in 1900-system.
        assert_eq!(
            date_ctx(&[n(1900.0), n(2.0), n(29.0)], &ctx_1900()),
            n(60.0)
        );
    }

    #[test]
    fn date_two_digit_year_coerced_to_19xx() {
        // Excel canon: year 50 → 1950.
        assert_eq!(
            date_ctx(&[n(50.0), n(1.0), n(1.0)], &ctx_1900()),
            n(18264.0)
        );
        // year 0 → 1900.
        assert_eq!(date_ctx(&[n(0.0), n(1.0), n(1.0)], &ctx_1900()), n(1.0));
        // year 1899 → 3799 (1899 + 1900) — IN range. Valid serial.
        // (Not a #NUM! — Excel docs say year 1899 → 1899 + 1900 = 3799.)
        let r = date_ctx(&[n(1899.0), n(1.0), n(1.0)], &ctx_1900());
        assert!(matches!(r, Value::Number(_)), "expected Number, got {r:?}");
    }

    #[test]
    fn date_month_overflow_cascades_forward() {
        // DATE(2024, 13, 1) = DATE(2025, 1, 1).
        let target = date_ctx(&[n(2025.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(date_ctx(&[n(2024.0), n(13.0), n(1.0)], &ctx_1900()), target);
        // DATE(2024, 25, 1) = DATE(2026, 1, 1).
        let target2 = date_ctx(&[n(2026.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(
            date_ctx(&[n(2024.0), n(25.0), n(1.0)], &ctx_1900()),
            target2
        );
    }

    #[test]
    fn date_month_zero_or_negative_cascades_backward() {
        // DATE(2024, 0, 5) = DATE(2023, 12, 5).
        let target = date_ctx(&[n(2023.0), n(12.0), n(5.0)], &ctx_1900());
        assert_eq!(date_ctx(&[n(2024.0), n(0.0), n(5.0)], &ctx_1900()), target);
        // DATE(2024, -1, 5) = DATE(2023, 11, 5).
        let target2 = date_ctx(&[n(2023.0), n(11.0), n(5.0)], &ctx_1900());
        assert_eq!(
            date_ctx(&[n(2024.0), n(-1.0), n(5.0)], &ctx_1900()),
            target2
        );
    }

    #[test]
    fn date_day_overflow_cascades_forward() {
        // DATE(2024, 1, 32) = DATE(2024, 2, 1).
        let target = date_ctx(&[n(2024.0), n(2.0), n(1.0)], &ctx_1900());
        assert_eq!(date_ctx(&[n(2024.0), n(1.0), n(32.0)], &ctx_1900()), target);
    }

    #[test]
    fn date_negative_year_is_num_error() {
        assert_eq!(
            date_ctx(&[n(-1.0), n(1.0), n(1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn date_year_above_9999_is_num_error() {
        assert_eq!(
            date_ctx(&[n(10000.0), n(1.0), n(1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn date_excel1904_year_before_1904_is_num_error() {
        assert_eq!(
            date_ctx(&[n(1903.0), n(12.0), n(31.0)], &ctx_1904()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn date_arity_error() {
        assert_eq!(
            date_ctx(&[n(2024.0), n(1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            date_ctx(&[n(2024.0), n(1.0), n(1.0), n(1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== YEAR / MONTH / DAY =====

    #[test]
    fn year_month_day_basic_1900_system() {
        let serial = 25569.0; // 1970-01-01
        assert_eq!(year_ctx(&[n(serial)], &ctx_1900()), n(1970.0));
        assert_eq!(month_ctx(&[n(serial)], &ctx_1900()), n(1.0));
        assert_eq!(day_ctx(&[n(serial)], &ctx_1900()), n(1.0));
    }

    #[test]
    fn year_month_day_phantom_serial_60_in_excel1900() {
        // serial 60 in 1900-system = (1900, 2, 29).
        let s = 60.0;
        assert_eq!(year_ctx(&[n(s)], &ctx_1900()), n(1900.0));
        assert_eq!(month_ctx(&[n(s)], &ctx_1900()), n(2.0));
        assert_eq!(day_ctx(&[n(s)], &ctx_1900()), n(29.0));
    }

    #[test]
    fn year_month_day_serial_60_in_excel1904_is_real_date() {
        // 1904-system: serial 60 = (1904, 3, 1).
        let s = 60.0;
        assert_eq!(year_ctx(&[n(s)], &ctx_1904()), n(1904.0));
        assert_eq!(month_ctx(&[n(s)], &ctx_1904()), n(3.0));
        assert_eq!(day_ctx(&[n(s)], &ctx_1904()), n(1.0));
    }

    #[test]
    fn year_month_day_strips_fractional_time() {
        // 25569.75 = 1970-01-01 18:00. YMD same as the integer day.
        let s = 25569.75;
        assert_eq!(year_ctx(&[n(s)], &ctx_1900()), n(1970.0));
        assert_eq!(month_ctx(&[n(s)], &ctx_1900()), n(1.0));
        assert_eq!(day_ctx(&[n(s)], &ctx_1900()), n(1.0));
    }

    #[test]
    fn year_serial_zero_in_excel1900_is_num_error() {
        // Per W5-70 (the "1/0/1900" display oddity).
        assert_eq!(
            year_ctx(&[n(0.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn year_negative_serial_is_num_error() {
        assert_eq!(
            year_ctx(&[n(-1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn year_arity_error() {
        assert_eq!(year_ctx(&[], &ctx_1900()), Value::Error(ErrorValue::Value));
        assert_eq!(
            year_ctx(&[n(1.0), n(2.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== HOUR / MINUTE / SECOND =====

    #[test]
    fn hour_minute_second_at_known_fractions() {
        // 25569.5 = noon (12:00:00).
        let s = 25569.5;
        assert_eq!(hour(&[n(s)]), n(12.0));
        assert_eq!(minute(&[n(s)]), n(0.0));
        assert_eq!(second(&[n(s)]), n(0.0));
    }

    #[test]
    fn hour_minute_second_6_30_45() {
        // 0.27135 ≈ 6:30:45.
        let frac = (6.0 * 3600.0 + 30.0 * 60.0 + 45.0) / 86400.0;
        assert_eq!(hour(&[n(frac)]), n(6.0));
        assert_eq!(minute(&[n(frac)]), n(30.0));
        assert_eq!(second(&[n(frac)]), n(45.0));
    }

    #[test]
    fn hour_strips_integer_part() {
        // Same fractional, different integer day → same hour.
        assert_eq!(hour(&[n(1.5)]), n(12.0));
        assert_eq!(hour(&[n(25569.5)]), n(12.0));
        assert_eq!(hour(&[n(100000.5)]), n(12.0));
    }

    #[test]
    fn hour_minute_second_zero_at_midnight() {
        assert_eq!(hour(&[n(1.0)]), n(0.0));
        assert_eq!(minute(&[n(1.0)]), n(0.0));
        assert_eq!(second(&[n(1.0)]), n(0.0));
    }

    #[test]
    fn hour_negative_serial_is_num_error() {
        assert_eq!(hour(&[n(-0.5)]), Value::Error(ErrorValue::Num));
        assert_eq!(minute(&[n(-0.5)]), Value::Error(ErrorValue::Num));
        assert_eq!(second(&[n(-0.5)]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn hour_arity_error() {
        assert_eq!(hour(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(hour(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn second_propagates_error() {
        assert_eq!(
            second(&[Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    // ===== TIME =====

    #[test]
    fn time_known_values() {
        assert_eq!(time(&[n(0.0), n(0.0), n(0.0)]), n(0.0));
        assert_eq!(time(&[n(12.0), n(0.0), n(0.0)]), n(0.5));
        assert_eq!(time(&[n(6.0), n(0.0), n(0.0)]), n(0.25));
    }

    #[test]
    fn time_wraps_24h() {
        // TIME(24, 0, 0) == TIME(0, 0, 0) == 0.
        assert_eq!(time(&[n(24.0), n(0.0), n(0.0)]), n(0.0));
        // TIME(25, 0, 0) == TIME(1, 0, 0) == 1/24.
        let expected = 1.0 / 24.0;
        if let Value::Number(actual) = time(&[n(25.0), n(0.0), n(0.0)]) {
            assert!((actual - expected).abs() < 1e-12);
        } else {
            panic!("expected Number");
        }
    }

    #[test]
    fn time_cascading_minutes_and_seconds() {
        // TIME(1, 60, 60) == TIME(2, 1, 0) → 2*3600 + 60 = 7260 sec / 86400.
        let expected = 7260.0 / 86400.0;
        if let Value::Number(actual) = time(&[n(1.0), n(60.0), n(60.0)]) {
            assert!((actual - expected).abs() < 1e-12);
        }
    }

    #[test]
    fn time_negative_arg_is_num_error() {
        assert_eq!(
            time(&[n(-1.0), n(0.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            time(&[n(0.0), n(-1.0), n(0.0)]),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            time(&[n(0.0), n(0.0), n(-1.0)]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn time_arity_error() {
        assert_eq!(time(&[n(1.0), n(2.0)]), Value::Error(ErrorValue::Value));
    }

    // ===== Cross-cutting: error propagation =====

    #[test]
    fn date_propagates_error_in_any_arg() {
        let err = Value::Error(ErrorValue::Ref);
        assert_eq!(
            date_ctx(&[err.clone(), n(1.0), n(1.0)], &ctx_1900()),
            err.clone()
        );
        assert_eq!(
            date_ctx(&[n(2024.0), err.clone(), n(1.0)], &ctx_1900()),
            err.clone()
        );
        assert_eq!(
            date_ctx(&[n(2024.0), n(1.0), err.clone()], &ctx_1900()),
            err
        );
    }

    #[test]
    fn time_propagates_error_in_any_arg() {
        let err = Value::Error(ErrorValue::Num);
        assert_eq!(time(&[err.clone(), n(0.0), n(0.0)]), err);
    }
}
