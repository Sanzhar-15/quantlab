//! Phase 4.5.A (W5-70) — Excel-compatible date / time serial conversion.
//!
//! Excel represents dates as `f64` serials: integer part = days since the
//! workbook's epoch; fractional part = time-of-day (0.5 = noon). This module
//! provides the pure conversion arithmetic: serial ↔ (year, month, day) and
//! fraction ↔ (hours, minutes, seconds).
//!
//! ## Two systems
//!
//! [`DateSystem::Excel1900`] is the Windows-default epoch with the famous
//! **1900 leap-year bug** — Excel treats 1900-02-29 (which didn't exist in
//! the Gregorian calendar) as a valid date with serial 60. Lotus 1-2-3
//! had this bug; Excel inherited it for compatibility.
//!
//! [`DateSystem::Excel1904`] is the legacy macOS-default epoch with no bug.
//!
//! ## Range
//!
//! Serials in `1..=2_958_465` map to real dates 1900-01-01 through
//! 9999-12-31 in the 1900-system. Serial `0` is the "1/0/1900" display
//! oddity — NOT a real YMD; `serial_to_ymd(0, _)` returns `#NUM!` per the
//! W5-68 design doc § 3.3 + Codex LOW 1.
//!
//! Serial `60` is the phantom 1900-02-29 in Excel1900-system only — that's
//! the serial-60 contract pinned by the W5-68 design doc § 3.2 + Codex
//! MEDIUM 1.
//!
//! ## Algorithm
//!
//! Day arithmetic uses Howard Hinnant's `days_from_civil` /
//! `civil_from_days` algorithm (proleptic Gregorian; reference epoch
//! 1970-01-01 = Unix epoch = day 0). The leap-year bug is special-cased
//! at the Excel-serial conversion boundary, not in the core algorithm.

use crate::eval_context::DateSystem;
use crate::ErrorValue;

// ============================================================================
// Range constants
// ============================================================================

/// Largest valid Excel serial day (year 9999-12-31 in either system).
///
/// In the 1900-system: 9999-12-31 = serial 2_958_465 (because of the
/// phantom day, this is +1 from the "real Gregorian days from 1900-01-01"
/// count). The 1904-system is offset by 1462 days (cleaned epoch).
pub const MAX_EXCEL_SERIAL_DAY: i64 = 2_958_465;

// 1900-system serial constants pinned by the design doc.
pub(crate) const SERIAL_1900_02_28: i64 = 59;
pub(crate) const SERIAL_PHANTOM_1900_02_29: i64 = 60;
/// Excel serial for 1900-03-01 in the 1900-system (= 61, NOT 60 — the
/// phantom day is skipped). Kept as a documented constant for tests +
/// future date-function implementations; referenced in the W5-68 design
/// doc § 3.2 serial-60 contract table.
#[allow(dead_code)]
pub(crate) const SERIAL_1900_03_01: i64 = 61;

/// Unix epoch as a 1900-system Excel serial. 1970-01-01 = 25569.
/// (Real Gregorian days from 1900-01-01 to 1970-01-01 = 25567, + 1 for
/// the conventional "Day 1 = 1900-01-01" Excel base, + 1 for the phantom
/// Feb 29 1900 = 25569.)
pub const UNIX_EPOCH_AS_1900_SERIAL: i64 = 25569;

/// Unix epoch as a 1904-system Excel serial. 1970-01-01 = 24107.
/// (1900-system_serial(1970-01-01) - 1462 = 25569 - 1462 = 24107.)
pub const UNIX_EPOCH_AS_1904_SERIAL: i64 = 24107;

// ============================================================================
// Calendar utilities
// ============================================================================

/// Proleptic Gregorian leap-year test.
pub fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0) && (year % 100 != 0 || year % 400 == 0)
}

/// Days in `month` of `year` (1-indexed month). Returns 0 for an invalid
/// month (caller should validate first, but the function is safe to call).
pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Howard Hinnant's `days_from_civil` — proleptic Gregorian (y, m, d) to
/// days-since-1970-01-01. Negative result for dates before Unix epoch.
///
/// Validity: caller has already validated month ∈ 1..=12 and day ∈
/// 1..=days_in_month(year, month). This function does NOT validate.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64; // [0, 399]
    let m_i = m as i64;
    let d_i = d as i64;
    let mp = if m_i <= 2 { m_i + 9 } else { m_i - 3 }; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d_i - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    (era as i64) * 146097 + doe - 719468
}

/// Howard Hinnant's `civil_from_days` — inverse of `days_from_civil`.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let final_y = (if m <= 2 { y + 1 } else { y }) as i32;
    (final_y, m, d)
}

/// **W5-71 (Phase 4.5.A.2):** convert days-since-Unix-epoch to `(year,
/// month, day)`. Public so `volatile::now_ctx` / `today_ctx` can compute
/// the workbook's date-system-aware current serial. Calls the same
/// Hinnant algorithm as `serial_to_ymd`; no Excel-bug branch (Unix days
/// don't carry the phantom).
pub fn unix_days_to_ymd(unix_days: i64) -> (i32, u32, u32) {
    civil_from_days(unix_days)
}

/// **W5-71 (Phase 4.5.A.2):** convert `(year, month, day)` to
/// days-since-Unix-epoch. Inverse of [`unix_days_to_ymd`].
///
/// Validity: caller validates month ∈ 1..=12 and day ∈
/// 1..=days_in_month(year, month). For an invalid `(y, m, d)`, output
/// is unspecified (in practice: the algorithm extrapolates).
pub fn ymd_to_unix_days(year: i32, month: u32, day: u32) -> i64 {
    days_from_civil(year, month, day)
}

// ============================================================================
// serial ↔ ymd
// ============================================================================

/// Convert a numeric serial to `(year, month, day)`.
///
/// **Range:** valid serials are `1..=2_958_465` (1900-01-01 through
/// 9999-12-31 in the 1900-system; the 1904-system is shifted by 1462).
/// Out-of-range returns `Err(#NUM!)`.
///
/// **Excel1900 phantom day:** `serial == 60` returns `(1900, 2, 29)`.
/// This date doesn't exist in the proleptic Gregorian calendar — Excel
/// inherited the bug from Lotus 1-2-3 and we replicate it for compat.
///
/// **`serial == 0` returns `#NUM!`** — the "1/0/1900" rendering Excel
/// shows is a formatter oddity, NOT a real YMD tuple. Per W5-68 design
/// doc § 3.3 + Codex LOW 1.
///
/// **Fractional input:** only the integer part of `serial` is used.
/// `serial = 60.75` returns `(1900, 2, 29)` in 1900-system; fractional
/// is handled by [`fraction_to_hms`] separately.
pub fn serial_to_ymd(serial: f64, system: DateSystem) -> Result<(i32, u32, u32), ErrorValue> {
    if !serial.is_finite() {
        return Err(ErrorValue::Num);
    }
    if serial < 0.0 {
        return Err(ErrorValue::Num);
    }
    let day = serial.trunc() as i64;
    if day > MAX_EXCEL_SERIAL_DAY {
        return Err(ErrorValue::Num);
    }
    // **System-dependent serial-0 contract** (W5-68 design § 3.3 + Codex LOW 1
    // + W5-70 implementation):
    //   - Excel1900: serial 0 is the "1/0/1900" display oddity, NOT a real
    //     YMD. Returns `#NUM!`. The formatter's display path can render the
    //     "1/0/1900" string separately.
    //   - Excel1904: serial 0 IS the real epoch (1904-01-01). Returns it.
    match system {
        DateSystem::Excel1900 => {
            if day == 0 {
                return Err(ErrorValue::Num);
            }
            // 1900-system contract:
            //   serial 1..=59  ↔ 1900-01-01 .. 1900-02-28 (no phantom-skip)
            //   serial 60      ↔ 1900-02-29 (PHANTOM — does not exist)
            //   serial 61..    ↔ 1900-03-01 onwards (skip one day to compensate)
            if day == SERIAL_PHANTOM_1900_02_29 {
                return Ok((1900, 2, 29));
            }
            // Real days from 1900-01-01:
            //   serial in 1..=59  → real_days = serial - 1
            //   serial in 61..    → real_days = serial - 2
            let real_days = if day <= SERIAL_1900_02_28 {
                day - 1
            } else {
                day - 2
            };
            // Convert real_days-from-1900-01-01 to Unix days:
            //   unix_days = real_days + days_from_civil(1900, 1, 1)
            // days_from_civil(1900, 1, 1) == -25567.
            let unix_days = real_days + days_from_civil(1900, 1, 1);
            Ok(civil_from_days(unix_days))
        }
        DateSystem::Excel1904 => {
            // 1904-system: serial N = real_days_from_1904_01_01.
            // unix_days = serial + days_from_civil(1904, 1, 1).
            let unix_days = day + days_from_civil(1904, 1, 1);
            Ok(civil_from_days(unix_days))
        }
    }
}

/// Convert `(year, month, day)` to an Excel serial day (integer-valued `f64`).
///
/// **Validity:** year must be in `1900..=9999` for the 1900-system or
/// `1904..=9999` for the 1904-system; month ∈ `1..=12`; day ∈
/// `1..=days_in_month(year, month)`. The Excel1900 phantom day
/// `(1900, 2, 29)` is accepted and returns `60.0`.
///
/// Out-of-range / invalid → `Err(#NUM!)`.
pub fn ymd_to_serial(
    year: i32,
    month: u32,
    day: u32,
    system: DateSystem,
) -> Result<f64, ErrorValue> {
    if !(1..=12).contains(&month) {
        return Err(ErrorValue::Num);
    }
    // Excel1900 phantom day: accept (1900, 2, 29) → 60.0 BEFORE the day-
    // range check (since 29 > days_in_month(1900, 2) = 28).
    if system == DateSystem::Excel1900 && year == 1900 && month == 2 && day == 29 {
        return Ok(60.0);
    }
    if day == 0 || day > days_in_month(year, month) {
        return Err(ErrorValue::Num);
    }
    match system {
        DateSystem::Excel1900 => {
            if !(1900..=9999).contains(&year) {
                return Err(ErrorValue::Num);
            }
            let unix_days = days_from_civil(year, month, day);
            let real_days_from_1900_01_01 = unix_days - days_from_civil(1900, 1, 1);
            // Inverse of the 1900-system extraction:
            //   real_days <= 58  (≤ 1900-02-28): serial = real_days + 1
            //   real_days >= 59  (≥ 1900-03-01): serial = real_days + 2
            let serial = if real_days_from_1900_01_01 <= 58 {
                real_days_from_1900_01_01 + 1
            } else {
                real_days_from_1900_01_01 + 2
            };
            if !(1..=MAX_EXCEL_SERIAL_DAY).contains(&serial) {
                return Err(ErrorValue::Num);
            }
            Ok(serial as f64)
        }
        DateSystem::Excel1904 => {
            if !(1904..=9999).contains(&year) {
                return Err(ErrorValue::Num);
            }
            let unix_days = days_from_civil(year, month, day);
            let serial = unix_days - days_from_civil(1904, 1, 1);
            if !(0..=MAX_EXCEL_SERIAL_DAY).contains(&serial) {
                return Err(ErrorValue::Num);
            }
            Ok(serial as f64)
        }
    }
}

// ============================================================================
// fraction ↔ hms
// ============================================================================

/// Convert the fractional part of a serial to `(hour, minute, second)`.
/// Hours in 0..=23, minutes/seconds in 0..=59.
///
/// **Excel canon:** integer seconds only (no sub-second precision). The
/// `frac` argument may be the whole serial or just the fractional part;
/// only the fractional component is used. Negative or NaN/Inf inputs
/// produce `(0, 0, 0)` per the principle of "do something sensible".
pub fn fraction_to_hms(frac: f64) -> (u32, u32, u32) {
    if !frac.is_finite() {
        return (0, 0, 0);
    }
    let f = frac.fract().abs();
    // Round-to-nearest seconds: f64 fractional → 86400 quanta.
    let total_secs = (f * 86_400.0).round() as i64;
    // Clamp the rare case where rounding produced exactly 86400 (which
    // would mean "24:00:00" — wrap to 00:00:00).
    let total_secs = total_secs.rem_euclid(86_400);
    let h = (total_secs / 3600) as u32;
    let m = ((total_secs % 3600) / 60) as u32;
    let s = (total_secs % 60) as u32;
    (h, m, s)
}

/// Convert `(hour, minute, second)` to a fractional time-of-day in `[0, 1)`.
///
/// Hour ≥ 24 wraps modulo 24 (Excel canon: `TIME(25, 0, 0) == TIME(1, 0, 0)`).
/// Minute/second similarly cascade. Returns `0.0` for the all-zero input.
pub fn hms_to_fraction(h: u32, m: u32, s: u32) -> f64 {
    let total = (h as u64) * 3600 + (m as u64) * 60 + (s as u64);
    (total % 86_400) as f64 / 86_400.0
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================================
    // is_leap_year
    // ============================================================================

    #[test]
    fn leap_year_divisible_by_4() {
        assert!(is_leap_year(2024));
        assert!(is_leap_year(2020));
        assert!(is_leap_year(1996));
    }

    #[test]
    fn leap_year_not_divisible_by_4() {
        assert!(!is_leap_year(2023));
        assert!(!is_leap_year(2021));
        assert!(!is_leap_year(1999));
    }

    #[test]
    fn leap_year_century_rule() {
        // 1900 is NOT a leap year (divisible by 100, not by 400).
        // (Excel BUG: treats 1900-02-29 as valid, but is_leap_year correctly
        // reports false — the bug is at the Excel-serial layer, not the
        // calendar layer.)
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(2100));
        assert!(!is_leap_year(1700));
    }

    #[test]
    fn leap_year_400_rule() {
        // 2000 IS a leap year (divisible by 400).
        assert!(is_leap_year(2000));
        assert!(is_leap_year(1600));
        assert!(is_leap_year(2400));
    }

    // ============================================================================
    // days_in_month
    // ============================================================================

    #[test]
    fn days_31_months() {
        for m in [1, 3, 5, 7, 8, 10, 12] {
            assert_eq!(days_in_month(2024, m), 31, "month {m}");
        }
    }

    #[test]
    fn days_30_months() {
        for m in [4, 6, 9, 11] {
            assert_eq!(days_in_month(2024, m), 30, "month {m}");
        }
    }

    #[test]
    fn days_feb_leap_vs_non_leap() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2023, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29); // 400-rule
        assert_eq!(days_in_month(1900, 2), 28); // 100-rule (no Excel bug here)
    }

    #[test]
    fn days_invalid_month_is_zero() {
        assert_eq!(days_in_month(2024, 0), 0);
        assert_eq!(days_in_month(2024, 13), 0);
    }

    // ============================================================================
    // Hinnant round-trip
    // ============================================================================

    #[test]
    fn hinnant_round_trip_known_dates() {
        for (y, m, d) in [
            (1970, 1, 1),   // unix epoch → day 0
            (1900, 1, 1),   // -25567
            (2000, 1, 1),   // 10957
            (2024, 7, 4),   // some recent date
            (9999, 12, 31), // max for Excel
            (1, 1, 1),      // proleptic year 1
        ] {
            let days = days_from_civil(y, m, d);
            let (y2, m2, d2) = civil_from_days(days);
            assert_eq!((y, m, d), (y2, m2, d2), "round-trip for {y}-{m}-{d}");
        }
    }

    #[test]
    fn hinnant_unix_epoch_is_day_zero() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn hinnant_1900_01_01_is_minus_25567() {
        assert_eq!(days_from_civil(1900, 1, 1), -25567);
    }

    // ============================================================================
    // serial_to_ymd — 1900-system happy path
    // ============================================================================

    #[test]
    fn serial_1_is_1900_01_01() {
        assert_eq!(
            serial_to_ymd(1.0, DateSystem::Excel1900).unwrap(),
            (1900, 1, 1)
        );
    }

    #[test]
    fn serial_2_is_1900_01_02() {
        assert_eq!(
            serial_to_ymd(2.0, DateSystem::Excel1900).unwrap(),
            (1900, 1, 2)
        );
    }

    #[test]
    fn serial_59_is_1900_02_28() {
        assert_eq!(
            serial_to_ymd(59.0, DateSystem::Excel1900).unwrap(),
            (1900, 2, 28)
        );
    }

    #[test]
    fn serial_61_is_1900_03_01() {
        // CRITICAL: the leap-year-bug boundary. Serial 60 is the phantom;
        // serial 61 is real 1900-03-01.
        assert_eq!(
            serial_to_ymd(61.0, DateSystem::Excel1900).unwrap(),
            (1900, 3, 1)
        );
    }

    #[test]
    fn serial_25569_is_unix_epoch() {
        assert_eq!(
            serial_to_ymd(25569.0, DateSystem::Excel1900).unwrap(),
            (1970, 1, 1)
        );
    }

    #[test]
    fn serial_max_is_9999_12_31() {
        assert_eq!(
            serial_to_ymd(MAX_EXCEL_SERIAL_DAY as f64, DateSystem::Excel1900).unwrap(),
            (9999, 12, 31)
        );
    }

    // ============================================================================
    // serial_to_ymd — Excel1900 phantom day (W5-68 design § 3.2 + Codex MEDIUM 1)
    // ============================================================================

    #[test]
    fn serial_60_is_phantom_feb_29_1900_in_excel1900() {
        assert_eq!(
            serial_to_ymd(60.0, DateSystem::Excel1900).unwrap(),
            (1900, 2, 29)
        );
    }

    #[test]
    fn serial_60_in_excel1904_is_real_1904_03_01() {
        // 1904-system: no phantom. serial 60 = 1904-03-01 (real).
        assert_eq!(
            serial_to_ymd(60.0, DateSystem::Excel1904).unwrap(),
            (1904, 3, 1)
        );
    }

    #[test]
    fn serial_60_fractional_still_phantom() {
        // Only integer part matters; fractional is time-of-day.
        assert_eq!(
            serial_to_ymd(60.75, DateSystem::Excel1900).unwrap(),
            (1900, 2, 29)
        );
    }

    // ============================================================================
    // serial_to_ymd — error paths
    // ============================================================================

    #[test]
    fn serial_0_in_excel1900_is_num_error_v1_display_oddity() {
        // The "1/0/1900" Excel renders in 1900-system is a formatter
        // oddity, not a real YMD. serial_to_ymd(0, Excel1900) returns
        // #NUM! per W5-68 design § 3.3 + Codex LOW 1.
        assert_eq!(
            serial_to_ymd(0.0, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn serial_0_in_excel1904_is_real_epoch() {
        // In 1904-system, serial 0 IS the legitimate epoch (1904-01-01).
        // Excel canon — round-trip preserves this.
        assert_eq!(
            serial_to_ymd(0.0, DateSystem::Excel1904).unwrap(),
            (1904, 1, 1)
        );
    }

    #[test]
    fn serial_negative_is_num_error() {
        assert_eq!(
            serial_to_ymd(-1.0, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn serial_beyond_9999_is_num_error() {
        assert_eq!(
            serial_to_ymd((MAX_EXCEL_SERIAL_DAY + 1) as f64, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn serial_nan_or_inf_is_num_error() {
        assert_eq!(
            serial_to_ymd(f64::NAN, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
        assert_eq!(
            serial_to_ymd(f64::INFINITY, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
        assert_eq!(
            serial_to_ymd(f64::NEG_INFINITY, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    // ============================================================================
    // ymd_to_serial — happy path (1900-system)
    // ============================================================================

    #[test]
    fn ymd_1900_01_01_is_serial_1() {
        assert_eq!(
            ymd_to_serial(1900, 1, 1, DateSystem::Excel1900).unwrap(),
            1.0
        );
    }

    #[test]
    fn ymd_1900_02_28_is_serial_59() {
        assert_eq!(
            ymd_to_serial(1900, 2, 28, DateSystem::Excel1900).unwrap(),
            59.0
        );
    }

    #[test]
    fn ymd_1900_03_01_is_serial_61() {
        // The phantom-day-skip boundary: 1900-02-28 → 59, 1900-03-01 → 61
        // (skipping serial 60 which is the phantom).
        assert_eq!(
            ymd_to_serial(1900, 3, 1, DateSystem::Excel1900).unwrap(),
            61.0
        );
    }

    #[test]
    fn ymd_1970_01_01_is_serial_25569() {
        assert_eq!(
            ymd_to_serial(1970, 1, 1, DateSystem::Excel1900).unwrap(),
            25569.0
        );
    }

    #[test]
    fn ymd_9999_12_31_is_max_serial() {
        assert_eq!(
            ymd_to_serial(9999, 12, 31, DateSystem::Excel1900).unwrap(),
            MAX_EXCEL_SERIAL_DAY as f64
        );
    }

    // ============================================================================
    // ymd_to_serial — phantom-day contract (W5-68 design § 3.2)
    // ============================================================================

    #[test]
    fn ymd_1900_02_29_is_serial_60_in_excel1900() {
        // Phantom day in 1900-system. Excel accepts it; we replicate.
        assert_eq!(
            ymd_to_serial(1900, 2, 29, DateSystem::Excel1900).unwrap(),
            60.0
        );
    }

    #[test]
    fn ymd_1900_02_29_is_num_error_in_excel1904() {
        // No phantom in 1904-system. 1900-02-29 doesn't exist (and 1900
        // is also outside the 1904-system's valid range).
        assert_eq!(
            ymd_to_serial(1900, 2, 29, DateSystem::Excel1904).unwrap_err(),
            ErrorValue::Num
        );
    }

    // ============================================================================
    // ymd_to_serial — error paths
    // ============================================================================

    #[test]
    fn ymd_year_before_1900_excel1900_is_num_error() {
        assert_eq!(
            ymd_to_serial(1899, 12, 31, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
        assert_eq!(
            ymd_to_serial(1, 1, 1, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn ymd_year_before_1904_excel1904_is_num_error() {
        assert_eq!(
            ymd_to_serial(1903, 12, 31, DateSystem::Excel1904).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn ymd_year_beyond_9999_is_num_error() {
        assert_eq!(
            ymd_to_serial(10000, 1, 1, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn ymd_invalid_month_is_num_error() {
        assert_eq!(
            ymd_to_serial(2024, 0, 1, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
        assert_eq!(
            ymd_to_serial(2024, 13, 1, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    #[test]
    fn ymd_invalid_day_is_num_error() {
        // Feb 30 in a non-leap year.
        assert_eq!(
            ymd_to_serial(2023, 2, 30, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
        // Apr 31.
        assert_eq!(
            ymd_to_serial(2024, 4, 31, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
        // Day 0.
        assert_eq!(
            ymd_to_serial(2024, 1, 0, DateSystem::Excel1900).unwrap_err(),
            ErrorValue::Num
        );
    }

    // ============================================================================
    // serial ↔ ymd round-trip
    // ============================================================================

    #[test]
    fn round_trip_1900_system_common_dates() {
        for (y, m, d) in [
            (1900, 1, 1),
            (1900, 1, 31),
            (1900, 2, 28),
            (1900, 2, 29), // phantom
            (1900, 3, 1),
            (1970, 1, 1),
            (2000, 1, 1),
            (2000, 2, 29),
            (2024, 7, 4),
            (9999, 12, 31),
        ] {
            let serial = ymd_to_serial(y, m, d, DateSystem::Excel1900)
                .unwrap_or_else(|_| panic!("ymd_to_serial({y}, {m}, {d}) failed"));
            let (y2, m2, d2) = serial_to_ymd(serial, DateSystem::Excel1900)
                .unwrap_or_else(|_| panic!("serial_to_ymd({serial}) failed"));
            assert_eq!((y, m, d), (y2, m2, d2), "round-trip {y}-{m}-{d}");
        }
    }

    #[test]
    fn round_trip_1904_system_common_dates() {
        for (y, m, d) in [
            (1904, 1, 1),
            (1904, 3, 1),
            (1970, 1, 1),
            (2024, 7, 4),
            (9999, 12, 31),
        ] {
            let serial = ymd_to_serial(y, m, d, DateSystem::Excel1904)
                .unwrap_or_else(|_| panic!("ymd_to_serial({y}, {m}, {d}) failed"));
            let (y2, m2, d2) = serial_to_ymd(serial, DateSystem::Excel1904)
                .unwrap_or_else(|_| panic!("serial_to_ymd({serial}) failed"));
            assert_eq!((y, m, d), (y2, m2, d2), "round-trip {y}-{m}-{d}");
        }
    }

    // ============================================================================
    // 1904-system epoch
    // ============================================================================

    #[test]
    fn serial_1_in_excel1904_is_1904_01_02() {
        assert_eq!(
            serial_to_ymd(1.0, DateSystem::Excel1904).unwrap(),
            (1904, 1, 2)
        );
    }

    #[test]
    fn ymd_1904_01_01_in_excel1904_is_serial_0() {
        // Forward direction allows serial 0 (epoch).
        assert_eq!(
            ymd_to_serial(1904, 1, 1, DateSystem::Excel1904).unwrap(),
            0.0
        );
    }

    // ============================================================================
    // fraction_to_hms
    // ============================================================================

    #[test]
    fn fraction_zero_is_midnight() {
        assert_eq!(fraction_to_hms(0.0), (0, 0, 0));
    }

    #[test]
    fn fraction_half_is_noon() {
        assert_eq!(fraction_to_hms(0.5), (12, 0, 0));
    }

    #[test]
    fn fraction_quarter_is_6am() {
        assert_eq!(fraction_to_hms(0.25), (6, 0, 0));
    }

    #[test]
    fn fraction_three_quarter_is_6pm() {
        assert_eq!(fraction_to_hms(0.75), (18, 0, 0));
    }

    #[test]
    fn fraction_one_second() {
        // 1/86400 == 1 second.
        assert_eq!(fraction_to_hms(1.0 / 86400.0), (0, 0, 1));
    }

    #[test]
    fn fraction_strips_integer_part() {
        // 25569.5 → 0.5 fractional → noon.
        assert_eq!(fraction_to_hms(25569.5), (12, 0, 0));
    }

    #[test]
    fn fraction_handles_nan_or_inf() {
        assert_eq!(fraction_to_hms(f64::NAN), (0, 0, 0));
        assert_eq!(fraction_to_hms(f64::INFINITY), (0, 0, 0));
    }

    #[test]
    fn fraction_wraps_at_24_hours() {
        // A fractional that rounds to exactly 86400 seconds wraps to 00:00:00.
        // Hard to construct via fract() alone, but verify the wrap is safe.
        let near_one = 86399.9 / 86400.0;
        let (h, _m, _s) = fraction_to_hms(near_one);
        assert!(h < 24);
    }

    // ============================================================================
    // hms_to_fraction
    // ============================================================================

    #[test]
    fn hms_zero_is_zero() {
        assert_eq!(hms_to_fraction(0, 0, 0), 0.0);
    }

    #[test]
    fn hms_noon_is_half() {
        assert_eq!(hms_to_fraction(12, 0, 0), 0.5);
    }

    #[test]
    fn hms_round_trip_at_arbitrary_time() {
        for (h, m, s) in [(0, 0, 0), (12, 0, 0), (6, 30, 45), (23, 59, 59), (1, 1, 1)] {
            let frac = hms_to_fraction(h, m, s);
            assert_eq!(
                fraction_to_hms(frac),
                (h, m, s),
                "round-trip for {h}:{m}:{s}"
            );
        }
    }

    #[test]
    fn hms_wraps_24_hour_to_zero() {
        // TIME(24, 0, 0) == TIME(0, 0, 0) == 0.0.
        assert_eq!(hms_to_fraction(24, 0, 0), 0.0);
    }

    #[test]
    fn hms_25_hours_is_one_am() {
        // TIME(25, 0, 0) == TIME(1, 0, 0).
        assert_eq!(hms_to_fraction(25, 0, 0), hms_to_fraction(1, 0, 0));
    }

    #[test]
    fn hms_cascading_minutes_and_seconds() {
        // 1h 60m 60s == 2:01:00 == hms_to_fraction(2, 1, 0).
        let cascade = hms_to_fraction(1, 60, 60);
        let canonical = hms_to_fraction(2, 1, 0);
        assert_eq!(cascade, canonical);
    }
}
