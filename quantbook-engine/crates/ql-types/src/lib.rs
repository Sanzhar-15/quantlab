//! `ql-types` — Phase 0 minimum cell-value types for the Quantbook engine.
//!
//! Three modules, one shape:
//! - [`error`] — the 13-variant `ErrorValue` (Excel sigils + Quantbook-specific surfaces).
//! - [`value`] — the 5-variant `Value` (`Blank | Number | Boolean | Text | Error`).
//! - [`coercion`] — Excel-compatible boundary functions: `to_number_{strict,lenient}`,
//!   `to_logical`, `to_text`, `sanitize_f64`.
//!
//! Spec: `.plans/_QUANTBOOK-v1-SPECIFICATION.md` Part V §2 Week 2 Day 1-2.
//!
//! Phase 0 does NOT model `Int`, `Date`, `Time`, `Array`, `Pending` — those come later as
//! `ql-functions` and `ql-formula-semantics` need them. Stick to the five variants until then.

#![allow(dead_code)]

pub mod coercion;
pub mod error;
pub mod value;

pub use coercion::{sanitize_f64, to_logical, to_number_lenient, to_number_strict, to_text};
pub use error::{ErrorValue, ParseErrorValueError};
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
