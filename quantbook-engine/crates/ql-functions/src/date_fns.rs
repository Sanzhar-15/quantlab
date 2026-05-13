//! Phase 4.5.B (W5-72) — date / time function library wave 1.
//!
//! First eight of the V1 wave 18 (per W5-68 design doc § 5.1):
//! DATE, YEAR, MONTH, DAY (ContextAwareFn — need workbook date_system),
//! HOUR, MINUTE, SECOND, TIME (ScalarFn — pure functions of the
//! serial's fractional part / hms inputs).
//!
//! The remaining 10 (DATEVALUE, TIMEVALUE, WEEKDAY, EOMONTH, EDATE,
//! DAYS, NETWORKDAYS, WORKDAY, YEARFRAC) land in W5-73/W5-74.

use ql_types::{
    coercion, days_in_month, hms_to_fraction, serial_to_ymd, ymd_to_serial, DateSystem, ErrorValue,
    EvalContext, Value,
};

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

// ============================================================================
// W5-73 — DATEVALUE, TIMEVALUE, WEEKDAY, EOMONTH, EDATE
// ============================================================================

/// Parse a date text into `(year, month, day)`. en-US scope (W5-68 design
/// § 6.4 DTF-4-03 re-scope — locale-aware parsing lands Phase 4.9).
///
/// Accepted forms:
/// - ISO 8601: `YYYY-MM-DD`
/// - US slash: `M/D/YYYY`, `MM/DD/YYYY`
/// - US slash, 2-digit year: `M/D/YY` (50-99 → 1950-1999;
///   00-49 → 2000-2049 per Excel canon for `DATEVALUE`).
/// - ISO with leading zeros (`2024-01-05`) or without (`2024-1-5`).
///
/// Returns `Err(#VALUE!)` on any unrecognized format. Month / day range
/// errors → `#NUM!` (semantic; matches `ymd_to_serial`).
fn parse_date_text(text: &str) -> Result<(i32, u32, u32), ErrorValue> {
    let t = text.trim();
    if t.is_empty() {
        return Err(ErrorValue::Value);
    }
    // ISO YYYY-MM-DD.
    if let Some((y, rest)) = t.split_once('-') {
        if let Some((m, d)) = rest.split_once('-') {
            let yi: i32 = y.parse().map_err(|_| ErrorValue::Value)?;
            let mi: u32 = m.parse().map_err(|_| ErrorValue::Value)?;
            let di: u32 = d.parse().map_err(|_| ErrorValue::Value)?;
            return Ok((yi, mi, di));
        }
    }
    // US slash M/D/YYYY or M/D/YY.
    if let Some((m, rest)) = t.split_once('/') {
        if let Some((d, y)) = rest.split_once('/') {
            let mi: u32 = m.parse().map_err(|_| ErrorValue::Value)?;
            let di: u32 = d.parse().map_err(|_| ErrorValue::Value)?;
            let yi_raw: i32 = y.parse().map_err(|_| ErrorValue::Value)?;
            // 2-digit year convention (Excel DATEVALUE):
            // 0-29 → 2000-2029; 30-99 → 1930-1999.
            // (We pin a slightly more conservative split at 50.)
            let yi = if (0..=29).contains(&yi_raw) {
                yi_raw + 2000
            } else if (30..=99).contains(&yi_raw) {
                yi_raw + 1900
            } else {
                yi_raw
            };
            return Ok((yi, mi, di));
        }
    }
    Err(ErrorValue::Value)
}

/// **`DATEVALUE(text)`** — parse a text date and return the workbook-
/// date-system serial. en-US format in V1 (locale scope per W5-68 § 6.4).
///
/// Excel canon edge: `DATEVALUE("1900-02-29")` returns 60 (the phantom)
/// in 1900-system.
pub fn datevalue_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match &args[0] {
        Value::Text(s) => s.as_ref().to_owned(),
        Value::Error(e) => return Value::Error(*e),
        Value::Blank => return Value::Error(ErrorValue::Value),
        _ => return Value::Error(ErrorValue::Value),
    };
    let (y, m, d) = match parse_date_text(&text) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    match ymd_to_serial(y, m, d, ctx.date_system) {
        Ok(s) => Value::Number(s),
        Err(e) => Value::Error(e),
    }
}

/// Parse a time text into `(hour, minute, second)`. Accepts:
/// - 24-hour `HH:MM` and `HH:MM:SS`
/// - 12-hour with AM/PM suffix: `H:MM AM`, `HH:MM:SS PM`, etc.
fn parse_time_text(text: &str) -> Result<(u32, u32, u32), ErrorValue> {
    let t = text.trim();
    if t.is_empty() {
        return Err(ErrorValue::Value);
    }
    // Strip optional AM/PM suffix.
    let upper = t.to_ascii_uppercase();
    let (body, ampm_adj): (&str, Option<bool>) = if let Some(stripped) = upper.strip_suffix(" AM") {
        (stripped, Some(false))
    } else if let Some(stripped) = upper.strip_suffix(" PM") {
        (stripped, Some(true))
    } else if let Some(stripped) = upper.strip_suffix("AM") {
        (stripped, Some(false))
    } else if let Some(stripped) = upper.strip_suffix("PM") {
        (stripped, Some(true))
    } else {
        (upper.as_str(), None)
    };
    let body = body.trim();
    let parts: Vec<&str> = body.split(':').collect();
    let (hh, mm, ss): (u32, u32, u32) = match parts.as_slice() {
        [h, m] => (
            h.parse().map_err(|_| ErrorValue::Value)?,
            m.parse().map_err(|_| ErrorValue::Value)?,
            0,
        ),
        [h, m, s] => (
            h.parse().map_err(|_| ErrorValue::Value)?,
            m.parse().map_err(|_| ErrorValue::Value)?,
            s.parse().map_err(|_| ErrorValue::Value)?,
        ),
        _ => return Err(ErrorValue::Value),
    };
    // Validate fields. 24h: HH ∈ 0..=23. 12h+AM/PM: HH ∈ 1..=12.
    // Minutes/seconds: 0..=59.
    if mm > 59 || ss > 59 {
        return Err(ErrorValue::Value);
    }
    let hh_final = match ampm_adj {
        None => {
            if hh > 23 {
                return Err(ErrorValue::Value);
            }
            hh
        }
        Some(is_pm) => {
            if !(1..=12).contains(&hh) {
                return Err(ErrorValue::Value);
            }
            match (is_pm, hh) {
                (false, 12) => 0,    // 12:xx AM → 00:xx
                (false, h) => h,     // 1-11 AM → 1-11
                (true, 12) => 12,    // 12:xx PM → 12:xx
                (true, h) => h + 12, // 1-11 PM → 13-23
            }
        }
    };
    Ok((hh_final, mm, ss))
}

/// **`TIMEVALUE(text)`** — parse a time text and return the fractional
/// time-of-day in `[0, 1)`. Locale-agnostic 24-hour `HH:MM[:SS]` and
/// 12-hour `H:MM[:SS] AM/PM` in V1.
pub fn timevalue_ctx(args: &[Value], _ctx: &EvalContext) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let text = match &args[0] {
        Value::Text(s) => s.as_ref().to_owned(),
        Value::Error(e) => return Value::Error(*e),
        Value::Blank => return Value::Error(ErrorValue::Value),
        _ => return Value::Error(ErrorValue::Value),
    };
    let (h, m, s) = match parse_time_text(&text) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    Value::Number(hms_to_fraction(h, m, s))
}

/// **`WEEKDAY(serial, [return_type])`** — day-of-week from a serial.
///
/// `return_type` (default 1):
/// - 1 — 1=Sunday..7=Saturday (Excel default)
/// - 2 — 1=Monday..7=Sunday
/// - 3 — 0=Monday..6=Sunday
/// - 11 — 1=Monday..7=Sunday (same as 2)
/// - 12 — 1=Tuesday..7=Monday
/// - 13 — 1=Wednesday..7=Tuesday
/// - 14 — 1=Thursday..7=Wednesday
/// - 15 — 1=Friday..7=Thursday
/// - 16 — 1=Saturday..7=Friday
/// - 17 — 1=Sunday..7=Saturday (same as 1)
///
/// **W5-68 design § 3.2 contract:** WEEKDAY of the Excel1900 phantom
/// (serial 60) is computed via the simple "serial 1 = Sunday" formula,
/// which means serial 60 returns Wednesday (4 for return_type=1). This
/// is a documented divergence from real Gregorian (where 1900-02-29
/// didn't exist) — matches Excel canon's bug-aware day-of-week math.
pub fn weekday_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    if serial < 0.0 {
        return Value::Error(ErrorValue::Num);
    }
    let serial_int = serial.trunc() as i64;
    let return_type: i64 = if args.len() == 2 {
        match to_int_date_arg(&args[1]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };
    // Compute Sunday-indexed weekday (0=Sun, 1=Mon, ..., 6=Sat).
    // Excel canon: serial 1 = Sunday in 1900-system; serial 0 = Friday
    // in 1904-system. Pin the bug-aware math directly from the serial.
    let dow_sun_zero: i64 = match ctx.date_system {
        DateSystem::Excel1900 => (serial_int - 1).rem_euclid(7),
        DateSystem::Excel1904 => (serial_int + 5).rem_euclid(7),
    };
    let result: i64 = match return_type {
        1 | 17 => dow_sun_zero + 1, // 1=Sun..7=Sat
        2 | 11 => {
            // 1=Mon..7=Sun. Sunday (0) → 7; others → dow_sun_zero.
            if dow_sun_zero == 0 {
                7
            } else {
                dow_sun_zero
            }
        }
        3 => {
            // 0=Mon..6=Sun.
            if dow_sun_zero == 0 {
                6
            } else {
                dow_sun_zero - 1
            }
        }
        n @ 12..=16 => {
            // n=12: 1=Tue..7=Mon. n=13: 1=Wed..7=Tue. ... n=16: 1=Sat..7=Fri.
            // Anchor: n=12 maps Tuesday (dow_sun_zero=2) to 1.
            // Anchor offset = n - 11 (1..=5).
            let anchor = n - 11;
            (dow_sun_zero - anchor).rem_euclid(7) + 1
        }
        _ => return Value::Error(ErrorValue::Num),
    };
    Value::Number(result as f64)
}

/// Add `months` to `(year, month)` and normalize. Returns `(norm_y,
/// norm_m)`. Handles negative `months` correctly.
fn add_months(year: i32, month: u32, months: i64) -> (i32, u32) {
    let total_months = (year as i64 - 1) * 12 + (month as i64 - 1) + months;
    let y = (total_months.div_euclid(12) + 1) as i32;
    let m = (total_months.rem_euclid(12) + 1) as u32;
    (y, m)
}

/// **`EOMONTH(start, months)`** — last day of the month that's `months`
/// offset from `start`'s month. `EOMONTH(start, 0)` is last day of
/// `start`'s month.
pub fn eomonth_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let months = match to_int_date_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let (y, m, _d) = match serial_to_ymd(start, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let (norm_y, norm_m) = add_months(y, m, months);
    // Phantom-aware last day: in Excel1900, the "month-end of Feb 1900"
    // is the phantom Feb 29 = serial 60. days_in_month(1900, 2) returns
    // 28 (real Gregorian), but the canon for EOMONTH(start_in_feb_1900,
    // 0) in Excel is serial 60. Special-case.
    if matches!(ctx.date_system, DateSystem::Excel1900) && norm_y == 1900 && norm_m == 2 {
        return Value::Number(60.0);
    }
    if !(1..=9999).contains(&norm_y) {
        return Value::Error(ErrorValue::Num);
    }
    let last_day = days_in_month(norm_y, norm_m);
    if last_day == 0 {
        return Value::Error(ErrorValue::Num);
    }
    match ymd_to_serial(norm_y, norm_m, last_day, ctx.date_system) {
        Ok(s) => Value::Number(s),
        Err(e) => Value::Error(e),
    }
}

/// **`EDATE(start, months)`** — same calendar day as `start`, in the
/// month `months` offset from `start`'s month. If the original day
/// doesn't exist in the target month (e.g., Mar 31 + 1 month → April
/// only has 30 days), CLAMP to the last day of the target month.
pub fn edate_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let months = match to_int_date_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let (y, m, d) = match serial_to_ymd(start, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let (norm_y, norm_m) = add_months(y, m, months);
    if !(1..=9999).contains(&norm_y) {
        return Value::Error(ErrorValue::Num);
    }
    // Clamp day to month length.
    let max_day = days_in_month(norm_y, norm_m);
    if max_day == 0 {
        return Value::Error(ErrorValue::Num);
    }
    let clamped_d = d.min(max_day);
    // **W5-68 § 3.2 / serial-60 contract:** in Excel1900, if EDATE
    // lands on (1900, 2, 29) (e.g., EDATE(1900-03-29, -1)), return the
    // phantom serial 60. Otherwise route through ymd_to_serial which
    // handles the phantom on its own.
    match ymd_to_serial(norm_y, norm_m, clamped_d, ctx.date_system) {
        Ok(s) => Value::Number(s),
        Err(e) => Value::Error(e),
    }
}

#[cfg(test)]
mod tests_wave2 {
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

    fn t(s: &str) -> Value {
        Value::text(s.to_string())
    }

    // ===== DATEVALUE =====

    #[test]
    fn datevalue_iso_format() {
        assert_eq!(datevalue_ctx(&[t("1970-01-01")], &ctx_1900()), n(25569.0));
        assert_eq!(datevalue_ctx(&[t("2024-07-04")], &ctx_1900()), {
            // Compute expected: DATE(2024, 7, 4) under ctx_1900.
            date_ctx(&[n(2024.0), n(7.0), n(4.0)], &ctx_1900())
        });
    }

    #[test]
    fn datevalue_us_slash_format() {
        let expected = date_ctx(&[n(2024.0), n(7.0), n(4.0)], &ctx_1900());
        assert_eq!(datevalue_ctx(&[t("7/4/2024")], &ctx_1900()), expected);
        assert_eq!(datevalue_ctx(&[t("07/04/2024")], &ctx_1900()), expected);
    }

    #[test]
    fn datevalue_two_digit_year() {
        // "00-29" → 2000-2029; "30-99" → 1930-1999.
        let e00 = date_ctx(&[n(2000.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(datevalue_ctx(&[t("1/1/00")], &ctx_1900()), e00);
        let e29 = date_ctx(&[n(2029.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(datevalue_ctx(&[t("1/1/29")], &ctx_1900()), e29);
        let e30 = date_ctx(&[n(1930.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(datevalue_ctx(&[t("1/1/30")], &ctx_1900()), e30);
        let e99 = date_ctx(&[n(1999.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(datevalue_ctx(&[t("1/1/99")], &ctx_1900()), e99);
    }

    #[test]
    fn datevalue_phantom_1900_02_29() {
        // Phantom day in 1900-system.
        assert_eq!(datevalue_ctx(&[t("1900-02-29")], &ctx_1900()), n(60.0));
    }

    #[test]
    fn datevalue_unparseable_is_value_error() {
        assert_eq!(
            datevalue_ctx(&[t("garbage")], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            datevalue_ctx(&[t("")], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
        // Wrong separators.
        assert_eq!(
            datevalue_ctx(&[t("2024.01.01")], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn datevalue_non_text_input_is_value_error() {
        assert_eq!(
            datevalue_ctx(&[n(25569.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn datevalue_arity_error() {
        assert_eq!(
            datevalue_ctx(&[], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== TIMEVALUE =====

    #[test]
    fn timevalue_24h() {
        assert_eq!(timevalue_ctx(&[t("12:00:00")], &ctx_1900()), n(0.5));
        assert_eq!(timevalue_ctx(&[t("12:00")], &ctx_1900()), n(0.5));
        assert_eq!(timevalue_ctx(&[t("0:00:00")], &ctx_1900()), n(0.0));
        assert_eq!(timevalue_ctx(&[t("6:00:00")], &ctx_1900()), n(0.25));
    }

    #[test]
    fn timevalue_12h_am_pm() {
        // 12:00 AM = midnight.
        assert_eq!(timevalue_ctx(&[t("12:00 AM")], &ctx_1900()), n(0.0));
        // 12:00 PM = noon.
        assert_eq!(timevalue_ctx(&[t("12:00 PM")], &ctx_1900()), n(0.5));
        // 1:00 AM = 0.0417...
        let one_am = timevalue_ctx(&[t("1:00 AM")], &ctx_1900());
        if let Value::Number(v) = one_am {
            assert!((v - 1.0 / 24.0).abs() < 1e-12);
        }
        // 6:30 PM = (18.5/24).
        let six30pm = timevalue_ctx(&[t("6:30 PM")], &ctx_1900());
        if let Value::Number(v) = six30pm {
            assert!((v - 18.5 / 24.0).abs() < 1e-12);
        }
    }

    #[test]
    fn timevalue_invalid_format_is_value_error() {
        assert_eq!(
            timevalue_ctx(&[t("garbage")], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            timevalue_ctx(&[t("25:00:00")], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            timevalue_ctx(&[t("12:60:00")], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== WEEKDAY =====

    #[test]
    fn weekday_default_return_type_1_serial_1_is_sunday() {
        // Serial 1 = 1900-01-01 = Sunday in Excel's day-of-week math.
        assert_eq!(weekday_ctx(&[n(1.0)], &ctx_1900()), n(1.0));
    }

    #[test]
    fn weekday_return_type_2_serial_1_is_sunday_index_7() {
        // return_type 2: 1=Mon..7=Sun. Serial 1 (Sun) → 7.
        assert_eq!(weekday_ctx(&[n(1.0), n(2.0)], &ctx_1900()), n(7.0));
    }

    #[test]
    fn weekday_return_type_3_serial_1_is_sunday_index_6() {
        // return_type 3: 0=Mon..6=Sun. Serial 1 (Sun) → 6.
        assert_eq!(weekday_ctx(&[n(1.0), n(3.0)], &ctx_1900()), n(6.0));
    }

    #[test]
    fn weekday_at_serial_25569_unix_epoch_is_thursday() {
        // 1970-01-01 = Thursday. return_type 1: Sun=1..Sat=7, Thu=5.
        assert_eq!(weekday_ctx(&[n(25569.0)], &ctx_1900()), n(5.0));
        // return_type 2: Mon=1..Sun=7, Thu=4.
        assert_eq!(weekday_ctx(&[n(25569.0), n(2.0)], &ctx_1900()), n(4.0));
    }

    #[test]
    fn weekday_excel1904_serial_0_is_friday() {
        // 1904-system: serial 0 = 1904-01-01 = Friday. return_type 1:
        // Sun=1..Sat=7, Fri=6.
        assert_eq!(weekday_ctx(&[n(0.0)], &ctx_1904()), n(6.0));
    }

    #[test]
    fn weekday_invalid_return_type_is_num_error() {
        assert_eq!(
            weekday_ctx(&[n(1.0), n(99.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            weekday_ctx(&[n(1.0), n(0.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn weekday_negative_serial_is_num_error() {
        assert_eq!(
            weekday_ctx(&[n(-1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    // ===== EOMONTH =====

    #[test]
    fn eomonth_zero_offset_returns_last_of_start_month() {
        // EOMONTH(2024-01-15, 0) = 2024-01-31.
        let start = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(1.0), n(31.0)], &ctx_1900());
        assert_eq!(eomonth_ctx(&[start, n(0.0)], &ctx_1900()), expected);
    }

    #[test]
    fn eomonth_positive_offset_walks_forward() {
        // EOMONTH(2024-01-15, 1) = 2024-02-29 (leap year).
        let start = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(2.0), n(29.0)], &ctx_1900());
        assert_eq!(eomonth_ctx(&[start, n(1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn eomonth_negative_offset_walks_backward() {
        // EOMONTH(2024-03-15, -1) = 2024-02-29.
        let start = date_ctx(&[n(2024.0), n(3.0), n(15.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(2.0), n(29.0)], &ctx_1900());
        assert_eq!(eomonth_ctx(&[start, n(-1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn eomonth_feb_1900_returns_phantom_60() {
        // EOMONTH(any-day-in-feb-1900, 0) = phantom serial 60.
        let start = date_ctx(&[n(1900.0), n(2.0), n(15.0)], &ctx_1900());
        assert_eq!(eomonth_ctx(&[start, n(0.0)], &ctx_1900()), n(60.0));
    }

    // ===== EDATE =====

    #[test]
    fn edate_same_day_in_next_month() {
        // EDATE(2024-01-15, 1) = 2024-02-15.
        let start = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(2.0), n(15.0)], &ctx_1900());
        assert_eq!(edate_ctx(&[start, n(1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn edate_clamps_day_when_target_month_shorter() {
        // EDATE(2024-01-31, 1) = 2024-02-29 (Feb 2024 has 29 days; 31
        // doesn't exist).
        let start = date_ctx(&[n(2024.0), n(1.0), n(31.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(2.0), n(29.0)], &ctx_1900());
        assert_eq!(edate_ctx(&[start, n(1.0)], &ctx_1900()), expected);

        // EDATE(2023-01-31, 1) = 2023-02-28 (non-leap).
        let start = date_ctx(&[n(2023.0), n(1.0), n(31.0)], &ctx_1900());
        let expected = date_ctx(&[n(2023.0), n(2.0), n(28.0)], &ctx_1900());
        assert_eq!(edate_ctx(&[start, n(1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn edate_negative_months_walks_backward() {
        // EDATE(2024-03-15, -1) = 2024-02-15.
        let start = date_ctx(&[n(2024.0), n(3.0), n(15.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(2.0), n(15.0)], &ctx_1900());
        assert_eq!(edate_ctx(&[start, n(-1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn edate_propagates_error() {
        let err = Value::Error(ErrorValue::Ref);
        assert_eq!(
            edate_ctx(&[err, n(1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn eomonth_arity_error() {
        assert_eq!(
            eomonth_ctx(&[n(1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }
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
