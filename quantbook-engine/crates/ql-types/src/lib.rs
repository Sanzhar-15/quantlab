//! `ql-types` — Phase 0 minimum cell-value types for the Quantbook engine.
//!
//! Four modules, one shape:
//! - [`error`] — the 14-variant `ErrorValue` (Excel sigils + Quantbook-specific surfaces + AI reservation).
//! - [`value`] — the 5-variant `Value` (`Blank | Number | Boolean | Text | Error`).
//! - [`coercion`] — Excel-compatible boundary functions: `to_number_{strict,lenient}`,
//!   `to_logical`, `to_text_for_{display,formula,arg}`, `to_int_arg`,
//!   `to_number_strict_skip_blank`, `format_number_for_arg`, `sanitize_f64`.
//! - [`address`] — cell coordinate types: `SheetId`, `RowId`, `ColId`, `Address`, `Range`.
//!
//! Spec: `.plans/_QUANTBOOK-v1-SPECIFICATION.md` Part V §2 Week 2 Day 1-2.
//!
//! Phase 0 does NOT model `Int`, `Date`, `Time`, `Array`, `Pending` — those come later as
//! `ql-functions` and `ql-formula-semantics` need them. Stick to the five variants until then.

pub mod address;
pub mod coercion;
pub mod date;
pub mod error;
pub mod eval_context;
pub mod value;

pub use address::{Address, ColId, Range, RowId, SheetId, MAX_COLUMN, MAX_ROW};
pub use coercion::{
    format_number_for_arg, sanitize_f64, to_int_arg, to_logical, to_number_lenient,
    to_number_strict, to_number_strict_skip_blank, to_text_for_arg, to_text_for_display,
    to_text_for_formula,
};
pub use date::{
    days_in_month, fraction_to_hms, hms_to_fraction, is_leap_year, serial_to_ymd, unix_days_to_ymd,
    ymd_to_serial, ymd_to_unix_days, MAX_EXCEL_SERIAL_DAY, UNIX_EPOCH_AS_1900_SERIAL,
    UNIX_EPOCH_AS_1904_SERIAL,
};
pub use error::{ErrorValue, ParseErrorValueError};
pub use eval_context::{DateSystem, EvalContext, Locale, NowProvider, DEFAULT_EVAL_CONTEXT};
pub use value::Value;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reexports_compile() {
        let _: Value = Value::Blank;
        let _: ErrorValue = ErrorValue::Ref;
        let _: Result<f64, ErrorValue> = sanitize_f64(1.5);
        let _: Result<f64, ErrorValue> = to_number_strict(&Value::Blank);
    }
}
