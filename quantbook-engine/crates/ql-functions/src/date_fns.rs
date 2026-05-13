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
    coercion, days_in_month, hms_to_fraction, is_leap_year, serial_to_ymd, ymd_to_serial,
    DateSystem, ErrorValue, EvalContext, Value,
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

// ============================================================================
// W5-74 — DAYS, NETWORKDAYS, WORKDAY, YEARFRAC (V1 wave 3, closes 18/18)
// ============================================================================

/// **`DAYS(end_date, start_date)`** — number of days between two serials.
/// Returns `INT(end) - INT(start)`. Negative result when end < start
/// (Excel canon).
///
/// **V1 divergence (filed as GAP-F-08):** strict numeric only. Text args
/// (which Excel would DATEVALUE) return `#VALUE!`. Use DATEVALUE
/// explicitly. Lands proper text support in Phase 4.10 polish.
///
/// Pure ScalarFn — doesn't need date_system (serial subtraction is
/// system-agnostic when both inputs are from the same system).
pub fn days(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let end = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let start = match to_serial_arg(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::Number(end.trunc() - start.trunc())
}

/// Internal: is the weekday at the given serial a working day (Mon–Fri)?
/// Bug-aware via the same direct serial formula `WEEKDAY` uses.
fn is_working_day(serial_int: i64, system: DateSystem) -> bool {
    let dow_sun_zero: i64 = match system {
        DateSystem::Excel1900 => (serial_int - 1).rem_euclid(7),
        DateSystem::Excel1904 => (serial_int + 5).rem_euclid(7),
    };
    // dow_sun_zero: 0=Sun, 1=Mon, ..., 6=Sat. Working = Mon..Fri = 1..=5.
    (1..=5).contains(&dow_sun_zero)
}

/// **`NETWORKDAYS(start_date, end_date)`** — number of working days
/// (Mon–Fri) between two serials, inclusive of both endpoints. Negative
/// count when end < start.
///
/// **V1 divergence (GAP-F-09):** the optional 3rd `holidays` arg is NOT
/// supported in V1 — the function tier (`ContextAwareFn`) can't see
/// range args. Calling with 3 args returns `#VALUE!`. Holidays-aware
/// version (and NETWORKDAYS.INTL with weekend mask) lands when the
/// 4th registry tier `RangeAndContextAwareFn` is built (Phase 4.5.C or
/// later — see W5-68 design § 4.A trade-off note).
pub fn networkdays_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 2 {
        // 3-arg form (with holidays) explicitly rejected as V1 divergence.
        return Value::Error(ErrorValue::Value);
    }
    let start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let end = match to_serial_arg(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let start_int = start.trunc() as i64;
    let end_int = end.trunc() as i64;
    let (lo, hi, sign) = if start_int <= end_int {
        (start_int, end_int, 1i64)
    } else {
        (end_int, start_int, -1i64)
    };
    let mut working = 0i64;
    for s in lo..=hi {
        if is_working_day(s, ctx.date_system) {
            working += 1;
        }
    }
    Value::Number((working * sign) as f64)
}

/// **`WORKDAY(start_date, days)`** — return the serial that is `days`
/// working days (Mon–Fri) after `start_date` (or before, if `days < 0`).
///
/// **V1 divergence (GAP-F-10):** optional 3rd `holidays` arg not
/// supported (same reason as NETWORKDAYS). 3-arg call returns
/// `#VALUE!`. WORKDAY.INTL waits for tier-4 plus weekend-mask support.
pub fn workday_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let days = match to_int_date_arg(&args[1]) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let mut cur = start.trunc() as i64;
    if days == 0 {
        return Value::Number(cur as f64);
    }
    let step: i64 = if days > 0 { 1 } else { -1 };
    let mut remaining = days.abs();
    while remaining > 0 {
        cur += step;
        if cur < 0 {
            return Value::Error(ErrorValue::Num);
        }
        if cur > ql_types::MAX_EXCEL_SERIAL_DAY {
            return Value::Error(ErrorValue::Num);
        }
        if is_working_day(cur, ctx.date_system) {
            remaining -= 1;
        }
    }
    Value::Number(cur as f64)
}

/// **`YEARFRAC(start, end, [basis])`** — fractional years between two
/// dates. `basis` selects the day-count convention (default 0):
///
/// - `0` US (NASD) 30/360 — implemented as European-30/360 in V1 (see
///   V1 divergence below).
/// - `1` Actual/actual — uses real day count; denominator handles
///   leap-year span via the average-year-length method.
/// - `2` Actual/360 — actual days / 360.
/// - `3` Actual/365 — actual days / 365.
/// - `4` European 30/360 — `(360*(y2-y1) + 30*(m2-m1) + (d2-d1)) / 360`.
///
/// **V1 divergence (GAP-F-11):** basis 0 (US NASD 30/360) uses the
/// European-30/360 algorithm in V1 (basis 4). The US convention's
/// end-of-month special-casing (Feb 28/29 → Feb 30; if d1=31 → d1=30;
/// if d2=31 and d1=30/31 → d2=30) lands in Phase 4.10. For most date
/// ranges the divergence is 0-1 days out of 360.
pub fn yearfrac_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let s_start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let s_end = match to_serial_arg(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let basis: i64 = if args.len() == 3 {
        match to_int_date_arg(&args[2]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        0
    };
    if !(0..=4).contains(&basis) {
        return Value::Error(ErrorValue::Num);
    }
    // Reject identical dates with positive denominator (Excel canon
    // returns 0.0).
    if s_start.trunc() == s_end.trunc() {
        return Value::Number(0.0);
    }
    // Ensure lo <= hi for the day-count.
    let (lo_serial, hi_serial) = if s_start <= s_end {
        (s_start, s_end)
    } else {
        (s_end, s_start)
    };
    let (ly, lm, ld) = match serial_to_ymd(lo_serial, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let (hy, hm, hd) = match serial_to_ymd(hi_serial, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let actual_days = (hi_serial.trunc() - lo_serial.trunc()).abs();
    let frac = match basis {
        2 => actual_days / 360.0,
        3 => actual_days / 365.0,
        1 => {
            // Actual/actual: split by year boundary or use
            // average-year-length. Use the Excel-canon simple rule:
            // if start and end are in the same year, use that year's
            // length. Otherwise, use 365.25 as an approximation. (Excel
            // uses a more elaborate algorithm; basis 1 is the most
            // complex basis. V1 approximation; pin Phase 4.10.)
            if ly == hy {
                let year_len = if is_leap_year(ly) { 366.0 } else { 365.0 };
                actual_days / year_len
            } else {
                actual_days / 365.25
            }
        }
        0 | 4 => {
            // European 30/360 (V1 also serves basis 0; see GAP-F-11).
            let days_360 = 360.0 * (hy as f64 - ly as f64)
                + 30.0 * (hm as f64 - lm as f64)
                + (hd as f64 - ld as f64);
            days_360 / 360.0
        }
        _ => unreachable!("basis range checked above"),
    };
    // Preserve sign: if user passed end < start, return negative frac.
    Value::Number(if s_start <= s_end { frac } else { -frac })
}

// ============================================================================
// W5-75 — DATEDIF, DAYS360, WEEKNUM, ISOWEEKNUM (Phase 4.5.C V2 wave, 4 of 6)
// ============================================================================

/// **`DATEDIF(start, end, unit)`** — date-difference with unit modes.
/// Excel-canon undocumented but widely used.
///
/// Units (case-insensitive):
/// - `"Y"` — complete years between start and end
/// - `"M"` — complete months
/// - `"D"` — total days (same as `end - start` truncated)
/// - `"YM"` — months ignoring years (0..=11)
/// - `"YD"` — days ignoring years
/// - `"MD"` — days ignoring months and years (CAUTION: this unit has
///   historically reported wrong results in real Excel for some dates;
///   we implement the documented intent, which may diverge from real
///   Excel's buggy output)
///
/// Negative result (start > end) → `#NUM!` per Excel canon.
pub fn datedif_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 3 {
        return Value::Error(ErrorValue::Value);
    }
    let start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let end = match to_serial_arg(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let unit = match &args[2] {
        Value::Text(s) => s.as_ref().to_ascii_uppercase(),
        Value::Error(e) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    if start > end {
        return Value::Error(ErrorValue::Num);
    }
    let (sy, sm, sd) = match serial_to_ymd(start, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let (ey, em, ed) = match serial_to_ymd(end, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let result: f64 = match unit.as_str() {
        "Y" => {
            let mut years = ey - sy;
            // Subtract 1 if we haven't reached the anniversary yet.
            if (em, ed) < (sm, sd) {
                years -= 1;
            }
            years as f64
        }
        "M" => {
            let mut months = (ey - sy) * 12 + (em as i32 - sm as i32);
            if ed < sd {
                months -= 1;
            }
            months as f64
        }
        "D" => end.trunc() - start.trunc(),
        "YM" => {
            let mut months = (em as i32 - sm as i32).rem_euclid(12);
            if ed < sd {
                months -= 1;
                if months < 0 {
                    months += 12;
                }
            }
            months as f64
        }
        "YD" => {
            // Days from (sy, sm, sd) to the same date in ey (i.e., the
            // anniversary), then days from that to (ey, em, ed).
            // Simpler: compute days from (sy, sm, sd) to (ey, em, ed)
            // ignoring full-year multiples.
            let anniversary_year = if (em, ed) >= (sm, sd) { ey } else { ey - 1 };
            // Phantom-aware year-start: if anniversary date falls into
            // Excel1900 feb 29 territory, ymd_to_serial handles it.
            let anniv_serial = match ymd_to_serial(anniversary_year, sm, sd, ctx.date_system) {
                Ok(s) => s,
                Err(_) => {
                    // (sm, sd) might be (2, 29) on a non-leap anniversary year — clamp.
                    let clamped_d = sd.min(days_in_month(anniversary_year, sm));
                    match ymd_to_serial(anniversary_year, sm, clamped_d, ctx.date_system) {
                        Ok(s) => s,
                        Err(e) => return Value::Error(e),
                    }
                }
            };
            end.trunc() - anniv_serial.trunc()
        }
        "MD" => {
            // Days ignoring months and years. Excel's documented intent:
            // (end_day - start_day) if end_day >= start_day, else end_day
            // + (days in start's month - start_day).
            if ed >= sd {
                (ed - sd) as f64
            } else {
                let dim = days_in_month(sy, sm);
                ((ed + dim) - sd) as f64
            }
        }
        _ => return Value::Error(ErrorValue::Num),
    };
    Value::Number(result)
}

/// **`DAYS360(start, end, [method])`** — 360-day year day-count.
/// `method = FALSE` (default) = US NASD; `method = TRUE` = European.
/// Returns `(360*Δy + 30*Δm + Δd)` under the chosen day-adjustment.
///
/// **V1 simplification (carries GAP-F-11 spirit):** US NASD's
/// end-of-month special-casing is partially implemented (d=31 → 30
/// rule). European method (no special-casing beyond day-31 → 30) is
/// the simpler path; both share most code.
///
/// Returns negative when end < start.
pub fn days360_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let start = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let end = match to_serial_arg(&args[1]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let european: bool = if args.len() == 3 {
        match &args[2] {
            Value::Boolean(b) => *b,
            Value::Number(n) => *n != 0.0,
            Value::Blank => false,
            Value::Error(e) => return Value::Error(*e),
            _ => return Value::Error(ErrorValue::Value),
        }
    } else {
        false
    };
    let (sy, sm, mut sd) = match serial_to_ymd(start, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let (ey, em, mut ed) = match serial_to_ymd(end, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Apply day-31 adjustment.
    if european {
        if sd == 31 {
            sd = 30;
        }
        if ed == 31 {
            ed = 30;
        }
    } else {
        // US NASD (simplified):
        //   if sd == 31, set sd = 30
        //   if ed == 31 AND sd in {30, 31} (after sd's own adjustment), set ed = 30
        if sd == 31 {
            sd = 30;
        }
        if ed == 31 && sd == 30 {
            ed = 30;
        }
    }
    let days = 360 * (ey - sy) + 30 * (em as i32 - sm as i32) + (ed as i32 - sd as i32);
    Value::Number(days as f64)
}

/// **`WEEKNUM(serial, [return_type])`** — week number of the year.
///
/// Return types (default 1):
/// - `1` — week starts Sunday; week containing Jan 1 is week 1.
/// - `2` — week starts Monday; week containing Jan 1 is week 1.
/// - `11..=17` — week starts on the named day (11=Mon, 12=Tue, ...,
///   17=Sun); week containing Jan 1 is week 1.
/// - `21` — ISO 8601 (same as ISOWEEKNUM).
///
/// **Algorithm:** for non-ISO return types, find the first day of the
/// year, walk backward to the prior week-start, then count weeks.
/// For ISO (21), defer to [`isoweeknum_ctx`].
pub fn weeknum_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.is_empty() || args.len() > 2 {
        return Value::Error(ErrorValue::Value);
    }
    let serial = match to_serial_arg(&args[0]) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let return_type: i64 = if args.len() == 2 {
        match to_int_date_arg(&args[1]) {
            Ok(n) => n,
            Err(e) => return Value::Error(e),
        }
    } else {
        1
    };
    if return_type == 21 {
        return isoweeknum_ctx(&[args[0].clone()], ctx);
    }
    // Determine week-start day-of-week (0=Sun..6=Sat).
    let week_start_dow: i64 = match return_type {
        1 | 17 => 0, // Sunday
        2 | 11 => 1, // Monday
        12 => 2,
        13 => 3,
        14 => 4,
        15 => 5,
        16 => 6,
        _ => return Value::Error(ErrorValue::Num),
    };
    let (y, _, _) = match serial_to_ymd(serial, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Compute the serial for Jan 1 of `y` under ctx.date_system.
    let jan1_serial = match ymd_to_serial(y, 1, 1, ctx.date_system) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    // Compute jan1's day-of-week using the bug-aware formula.
    let jan1_int = jan1_serial.trunc() as i64;
    let jan1_dow_sun_zero: i64 = match ctx.date_system {
        DateSystem::Excel1900 => (jan1_int - 1).rem_euclid(7),
        DateSystem::Excel1904 => (jan1_int + 5).rem_euclid(7),
    };
    // Days from jan1 back to the prior week-start.
    let offset = (jan1_dow_sun_zero - week_start_dow).rem_euclid(7);
    let week_anchor_int = jan1_int - offset;
    let serial_int = serial.trunc() as i64;
    if serial_int < week_anchor_int {
        return Value::Error(ErrorValue::Num);
    }
    let days_since = serial_int - week_anchor_int;
    let week_num = days_since / 7 + 1;
    Value::Number(week_num as f64)
}

/// **`ISOWEEKNUM(serial)`** — ISO 8601 week number.
///
/// ISO 8601 rules:
/// - Week starts on Monday.
/// - Week 1 is the week containing the year's first Thursday.
/// - Last few days of December may belong to week 1 of the next year;
///   first few days of January may belong to week 52/53 of the prior year.
///
/// Standard algorithm: take the Thursday of `serial`'s week (anchor),
/// find which year that Thursday belongs to (the "ISO year"), then count
/// from Jan 4 of that ISO year (which is always in week 1).
pub fn isoweeknum_ctx(args: &[Value], ctx: &EvalContext) -> Value {
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
    let serial_int = serial.trunc() as i64;
    // Day-of-week, Mon-indexed (0=Mon..6=Sun).
    let dow_sun_zero: i64 = match ctx.date_system {
        DateSystem::Excel1900 => (serial_int - 1).rem_euclid(7),
        DateSystem::Excel1904 => (serial_int + 5).rem_euclid(7),
    };
    let dow_mon_zero = (dow_sun_zero + 6).rem_euclid(7); // 0=Mon..6=Sun
                                                         // Anchor: this week's Thursday (3 in Mon-indexed).
    let thursday_int = serial_int + (3 - dow_mon_zero);
    let thursday_serial = thursday_int as f64;
    let (iso_y, _, _) = match serial_to_ymd(thursday_serial, ctx.date_system) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    // Jan 4 of iso_y is always in week 1. Find its Monday (week-1 anchor).
    let jan4_serial = match ymd_to_serial(iso_y, 1, 4, ctx.date_system) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let jan4_int = jan4_serial.trunc() as i64;
    let jan4_dow_sun_zero: i64 = match ctx.date_system {
        DateSystem::Excel1900 => (jan4_int - 1).rem_euclid(7),
        DateSystem::Excel1904 => (jan4_int + 5).rem_euclid(7),
    };
    let jan4_dow_mon_zero = (jan4_dow_sun_zero + 6).rem_euclid(7);
    let week1_monday_int = jan4_int - jan4_dow_mon_zero;
    // Find this week's Monday.
    let this_monday_int = serial_int - dow_mon_zero;
    let week_num = (this_monday_int - week1_monday_int) / 7 + 1;
    Value::Number(week_num as f64)
}

#[cfg(test)]
mod tests_wave_c {
    use super::*;

    fn ctx_1900() -> EvalContext {
        EvalContext::default()
    }
    fn n(x: f64) -> Value {
        Value::Number(x)
    }
    fn t(s: &str) -> Value {
        Value::text(s.to_string())
    }

    // ===== DATEDIF =====

    #[test]
    fn datedif_y_complete_years() {
        let start = date_ctx(&[n(2020.0), n(1.0), n(15.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("Y")], &ctx_1900()), n(4.0));
    }

    #[test]
    fn datedif_y_partial_year_rounds_down() {
        // 2020-01-15 to 2024-01-14 = 3 complete years (not 4).
        let start = date_ctx(&[n(2020.0), n(1.0), n(15.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(14.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("Y")], &ctx_1900()), n(3.0));
    }

    #[test]
    fn datedif_m_complete_months() {
        let start = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(7.0), n(15.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("M")], &ctx_1900()), n(6.0));
    }

    #[test]
    fn datedif_d_total_days() {
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(31.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("D")], &ctx_1900()), n(30.0));
    }

    #[test]
    fn datedif_ym_months_ignoring_years() {
        // 2020-01-15 to 2024-07-15 = 4 years + 6 months. YM = 6.
        let start = date_ctx(&[n(2020.0), n(1.0), n(15.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(7.0), n(15.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("YM")], &ctx_1900()), n(6.0));
    }

    #[test]
    fn datedif_md_days_ignoring_months_and_years() {
        // 2020-01-05 to 2024-03-20 = "MD" = 20 - 5 = 15.
        let start = date_ctx(&[n(2020.0), n(1.0), n(5.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(3.0), n(20.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("MD")], &ctx_1900()), n(15.0));
    }

    #[test]
    fn datedif_md_end_day_before_start_day_wraps() {
        // 2020-01-25 to 2024-03-05. MD: start month is Jan (31 days).
        // ed (5) < sd (25), so result = (5 + 31) - 25 = 11.
        let start = date_ctx(&[n(2020.0), n(1.0), n(25.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(3.0), n(5.0)], &ctx_1900());
        assert_eq!(datedif_ctx(&[start, end, t("MD")], &ctx_1900()), n(11.0));
    }

    #[test]
    fn datedif_negative_is_num_error() {
        let start = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        let end = date_ctx(&[n(2020.0), n(1.0), n(15.0)], &ctx_1900());
        assert_eq!(
            datedif_ctx(&[start, end, t("Y")], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn datedif_invalid_unit_is_num_error() {
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(12.0), n(31.0)], &ctx_1900());
        assert_eq!(
            datedif_ctx(&[start, end, t("X")], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn datedif_unit_case_insensitive() {
        let start = date_ctx(&[n(2020.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(
            datedif_ctx(&[start.clone(), end.clone(), t("y")], &ctx_1900()),
            n(4.0)
        );
    }

    // ===== DAYS360 =====

    #[test]
    fn days360_full_year_us() {
        // 2024-01-01 to 2025-01-01 in US 30/360 = 360.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2025.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(days360_ctx(&[start, end], &ctx_1900()), n(360.0));
    }

    #[test]
    fn days360_one_month_us() {
        // 2024-01-15 to 2024-02-15 = 30.
        let start = date_ctx(&[n(2024.0), n(1.0), n(15.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(2.0), n(15.0)], &ctx_1900());
        assert_eq!(days360_ctx(&[start, end], &ctx_1900()), n(30.0));
    }

    #[test]
    fn days360_day_31_adjustment_us() {
        // 2024-01-31 to 2024-02-29. US: sd=31→30, ed stays (sd not 31 now? No: post-adj sd=30,
        // ed=29; ed != 31 so no further adj. Result = 30*(2-1) + (29-30) = 29.
        let start = date_ctx(&[n(2024.0), n(1.0), n(31.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(2.0), n(29.0)], &ctx_1900());
        assert_eq!(days360_ctx(&[start, end], &ctx_1900()), n(29.0));
    }

    #[test]
    fn days360_european_method() {
        // 2024-01-31 to 2024-03-31, European: both 31→30. = 360*0 + 30*2 + 0 = 60.
        let start = date_ctx(&[n(2024.0), n(1.0), n(31.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(3.0), n(31.0)], &ctx_1900());
        assert_eq!(
            days360_ctx(&[start, end, Value::Boolean(true)], &ctx_1900()),
            n(60.0)
        );
    }

    // ===== WEEKNUM =====

    #[test]
    fn weeknum_default_return_type_1_jan_1_2024() {
        // 2024-01-01 = Monday. Default RT=1 (week starts Sunday).
        // Jan 1 2024 is in the week starting Sunday 2023-12-31, but
        // since 2023-12-31 is in 2023, the week containing Jan 1 of
        // 2024 starts at the last Sunday before/on Jan 1 = Dec 31
        // 2023. So Jan 1 2024 is in "week 1 of 2024" (the week
        // containing Jan 1). Result = 1.
        let serial = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(weeknum_ctx(&[serial], &ctx_1900()), n(1.0));
    }

    #[test]
    fn weeknum_return_type_2_mon_start() {
        // Jan 1 2024 is a Monday; RT=2 (Mon-start) → week 1.
        let serial = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(weeknum_ctx(&[serial, n(2.0)], &ctx_1900()), n(1.0));
    }

    #[test]
    fn weeknum_mid_year() {
        // 2024-07-04 (Thursday) — somewhere in mid-year, ~week 27.
        let serial = date_ctx(&[n(2024.0), n(7.0), n(4.0)], &ctx_1900());
        if let Value::Number(w) = weeknum_ctx(&[serial], &ctx_1900()) {
            assert!((27.0..=28.0).contains(&w), "expected ~27, got {w}");
        } else {
            panic!("expected Number");
        }
    }

    #[test]
    fn weeknum_invalid_return_type_is_num_error() {
        let serial = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(
            weeknum_ctx(&[serial, n(99.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    // ===== ISOWEEKNUM =====

    #[test]
    fn isoweeknum_mid_year_thursday() {
        // 2024-07-04 = Thursday. ISO week ~27.
        let serial = date_ctx(&[n(2024.0), n(7.0), n(4.0)], &ctx_1900());
        if let Value::Number(w) = isoweeknum_ctx(&[serial], &ctx_1900()) {
            assert!((26.0..=28.0).contains(&w), "expected ~27, got {w}");
        }
    }

    #[test]
    fn isoweeknum_jan_1_2024_is_week_1() {
        // 2024-01-01 is a Monday — definitively ISO week 1.
        let serial = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(isoweeknum_ctx(&[serial], &ctx_1900()), n(1.0));
    }

    #[test]
    fn isoweeknum_jan_1_2023_is_week_52_of_prior_year() {
        // 2023-01-01 was a Sunday. ISO week 1 of 2023 starts Mon Jan 2.
        // So Jan 1 2023 is week 52 of 2022.
        let serial = date_ctx(&[n(2023.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(isoweeknum_ctx(&[serial], &ctx_1900()), n(52.0));
    }

    #[test]
    fn isoweeknum_dec_31_2018_is_week_1_of_2019() {
        // 2018-12-31 was a Monday. ISO week 1 of 2019 starts that day.
        let serial = date_ctx(&[n(2018.0), n(12.0), n(31.0)], &ctx_1900());
        assert_eq!(isoweeknum_ctx(&[serial], &ctx_1900()), n(1.0));
    }

    #[test]
    fn weeknum_return_type_21_delegates_to_isoweeknum() {
        let serial = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let weeknum = weeknum_ctx(&[serial.clone(), n(21.0)], &ctx_1900());
        let iso = isoweeknum_ctx(&[serial], &ctx_1900());
        assert_eq!(weeknum, iso);
    }
}

#[cfg(test)]
mod tests_wave3 {
    use super::*;

    fn ctx_1900() -> EvalContext {
        EvalContext::default()
    }
    fn n(x: f64) -> Value {
        Value::Number(x)
    }

    // ===== DAYS =====

    #[test]
    fn days_basic_subtraction() {
        assert_eq!(days(&[n(100.0), n(50.0)]), n(50.0));
        assert_eq!(days(&[n(50.0), n(100.0)]), n(-50.0));
        assert_eq!(days(&[n(0.0), n(0.0)]), n(0.0));
    }

    #[test]
    fn days_truncates_fractional() {
        assert_eq!(days(&[n(100.9), n(50.1)]), n(50.0));
    }

    #[test]
    fn days_text_arg_is_value_error_v1_divergence() {
        // V1: text args not parsed (GAP-F-08). Use DATEVALUE explicitly.
        assert_eq!(
            days(&[Value::text("2024-01-01"), n(50.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn days_arity_error() {
        assert_eq!(days(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(days(&[n(1.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            days(&[n(1.0), n(2.0), n(3.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== NETWORKDAYS =====

    #[test]
    fn networkdays_single_week() {
        // 2024-01-01 (Mon) to 2024-01-05 (Fri) = 5 working days inclusive.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        assert_eq!(networkdays_ctx(&[start, end], &ctx_1900()), n(5.0));
    }

    #[test]
    fn networkdays_includes_endpoints_skips_weekend() {
        // 2024-01-05 (Fri) to 2024-01-08 (Mon) = 2 working days
        // (Fri + Mon; weekend skipped).
        let start = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(8.0)], &ctx_1900());
        assert_eq!(networkdays_ctx(&[start, end], &ctx_1900()), n(2.0));
    }

    #[test]
    fn networkdays_full_week_window() {
        // 2024-01-01 (Mon) to 2024-01-07 (Sun) = 5 working days.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(7.0)], &ctx_1900());
        assert_eq!(networkdays_ctx(&[start, end], &ctx_1900()), n(5.0));
    }

    #[test]
    fn networkdays_negative_when_end_before_start() {
        // End < start → negative count.
        let start = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(networkdays_ctx(&[start, end], &ctx_1900()), n(-5.0));
    }

    #[test]
    fn networkdays_with_holidays_arg_is_value_error_v1_divergence() {
        // GAP-F-09: 3-arg form not supported in V1.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        assert_eq!(
            networkdays_ctx(&[start, end, n(0.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== WORKDAY =====

    #[test]
    fn workday_forward_simple() {
        // 2024-01-01 (Mon) + 4 working days = 2024-01-05 (Fri).
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        assert_eq!(workday_ctx(&[start, n(4.0)], &ctx_1900()), expected);
    }

    #[test]
    fn workday_crosses_weekend() {
        // 2024-01-05 (Fri) + 1 working day = 2024-01-08 (Mon).
        let start = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(1.0), n(8.0)], &ctx_1900());
        assert_eq!(workday_ctx(&[start, n(1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn workday_backward() {
        // 2024-01-08 (Mon) - 1 working day = 2024-01-05 (Fri).
        let start = date_ctx(&[n(2024.0), n(1.0), n(8.0)], &ctx_1900());
        let expected = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        assert_eq!(workday_ctx(&[start, n(-1.0)], &ctx_1900()), expected);
    }

    #[test]
    fn workday_zero_days_returns_start() {
        let start = date_ctx(&[n(2024.0), n(1.0), n(5.0)], &ctx_1900());
        assert_eq!(workday_ctx(&[start.clone(), n(0.0)], &ctx_1900()), start);
    }

    #[test]
    fn workday_with_holidays_arg_is_value_error_v1_divergence() {
        // GAP-F-10: 3-arg form not supported.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(
            workday_ctx(&[start, n(1.0), n(0.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== YEARFRAC =====

    #[test]
    fn yearfrac_basis_3_actual_365() {
        // 2024-01-01 to 2025-01-01 = 366 days / 365 = ~1.0027.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2025.0), n(1.0), n(1.0)], &ctx_1900());
        if let Value::Number(v) = yearfrac_ctx(&[start, end, n(3.0)], &ctx_1900()) {
            assert!((v - 366.0 / 365.0).abs() < 1e-9);
        } else {
            panic!("expected Number");
        }
    }

    #[test]
    fn yearfrac_basis_2_actual_360() {
        // 2024-01-01 to 2024-12-31 = 365 days / 360 ~ 1.0139.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(12.0), n(31.0)], &ctx_1900());
        if let Value::Number(v) = yearfrac_ctx(&[start, end, n(2.0)], &ctx_1900()) {
            assert!((v - 365.0 / 360.0).abs() < 1e-9);
        }
    }

    #[test]
    fn yearfrac_basis_4_european_30_360() {
        // 2024-01-01 to 2024-12-31 in European 30/360.
        // (360*0 + 30*11 + (31-1)) / 360 = (0 + 330 + 30) / 360 = 1.0
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(12.0), n(31.0)], &ctx_1900());
        if let Value::Number(v) = yearfrac_ctx(&[start, end, n(4.0)], &ctx_1900()) {
            assert!((v - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn yearfrac_basis_1_same_leap_year() {
        // 2024-01-01 to 2024-12-31 in actual/actual (leap year = 366).
        // = 365 / 366 (Jan 1 to Dec 31 is 365 days, not 366).
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(12.0), n(31.0)], &ctx_1900());
        if let Value::Number(v) = yearfrac_ctx(&[start, end, n(1.0)], &ctx_1900()) {
            assert!((v - 365.0 / 366.0).abs() < 1e-9);
        }
    }

    #[test]
    fn yearfrac_default_basis_is_zero() {
        // No 3rd arg → basis 0.
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(12.0), n(31.0)], &ctx_1900());
        let with_default = yearfrac_ctx(&[start.clone(), end.clone()], &ctx_1900());
        let with_explicit_0 = yearfrac_ctx(&[start, end, n(0.0)], &ctx_1900());
        assert_eq!(with_default, with_explicit_0);
    }

    #[test]
    fn yearfrac_zero_for_same_date() {
        let s = date_ctx(&[n(2024.0), n(7.0), n(4.0)], &ctx_1900());
        assert_eq!(yearfrac_ctx(&[s.clone(), s.clone()], &ctx_1900()), n(0.0));
    }

    #[test]
    fn yearfrac_invalid_basis_is_num_error() {
        let start = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        let end = date_ctx(&[n(2024.0), n(12.0), n(31.0)], &ctx_1900());
        assert_eq!(
            yearfrac_ctx(&[start.clone(), end.clone(), n(5.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(
            yearfrac_ctx(&[start, end, n(-1.0)], &ctx_1900()),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn yearfrac_arity_error() {
        let s = date_ctx(&[n(2024.0), n(1.0), n(1.0)], &ctx_1900());
        assert_eq!(
            yearfrac_ctx(std::slice::from_ref(&s), &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            yearfrac_ctx(&[s.clone(), s.clone(), n(0.0), n(0.0)], &ctx_1900()),
            Value::Error(ErrorValue::Value)
        );
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
