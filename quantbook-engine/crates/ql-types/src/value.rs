//! `Value` — the Phase 0 minimum cell-value type per spec Part V §2.
//!
//! Five variants — `Blank`, `Number(f64)`, `Boolean(bool)`, `Text(Arc<str>)`, `Error(ErrorValue)`.
//! No `Int`, `Date`, `Time`, `Array`, or `Pending` for Phase 0 — Excel itself stores numbers
//! as f64, and dates as f64 serials. Date/time helpers will live in `ql-functions` once
//! they're needed; Phase 0 acceptance is arithmetic-only.
//!
//! `Text` is `Arc<str>` so that string cells reachable from many formulas (e.g. a column of
//! `=$A$1 & "x"`) clone in 16 bytes instead of duplicating the underlying buffer.
//!
//! Invariants enforced by constructors (NOT `Value::Number(x)` directly):
//! - `Value::number()` rejects NaN and ±∞ — those map to `Error(ErrorValue::Num)` at the
//!   coercion boundary (see `coercion::sanitize_f64`). Constructing `Value::Number(NaN)`
//!   directly is legal at the *type* level (so callers can still build it during parsing if
//!   needed); the rule is: values produced by kernels should pass through `sanitize_f64`
//!   before being wrapped.

use std::fmt;
use std::sync::Arc;

use crate::error::ErrorValue;

/// Cell value. Five variants; nothing larger than a fat pointer at runtime
/// (Number = 8 bytes, Text = 16-byte Arc, Boolean = 1 byte, Blank/Error = 1 byte each;
/// `size_of::<Value>()` is 24 bytes on 64-bit including the discriminant + padding).
///
/// `Default` is `Blank` (matches Excel's empty-cell semantics).
#[derive(Clone, Debug, Default)]
pub enum Value {
    /// Empty cell (`Blank`). Coerces to 0.0 numerically, "" textually, false logically.
    #[default]
    Blank,
    /// IEEE 754 double — Excel's canonical numeric type. NaN/Inf are valid f64 bit patterns
    /// but represent broken inputs; `coercion::sanitize_f64` converts them to
    /// `Value::Error(ErrorValue::Num)`.
    Number(f64),
    /// `TRUE` / `FALSE`. Numerically coerces to 1.0 / 0.0.
    Boolean(bool),
    /// String value. `Arc<str>` for cheap clones across formula evaluations.
    Text(Arc<str>),
    /// One of the 13 error sigils — `#REF!`, `#VALUE!`, … See `ErrorValue`.
    Error(ErrorValue),
}

impl Value {
    /// Construct a `Number`, sanitizing NaN/Inf into `Error(Num)`. Use this in kernels.
    pub fn number(n: f64) -> Self {
        if n.is_nan() || n.is_infinite() {
            Value::Error(ErrorValue::Num)
        } else {
            Value::Number(n)
        }
    }

    /// Construct a `Text` from anything `Into<Arc<str>>`. `&str`, `String`, and `Arc<str>`
    /// all work; the underlying buffer is shared where possible.
    pub fn text(s: impl Into<Arc<str>>) -> Self {
        Value::Text(s.into())
    }

    /// True iff `self` is a `Value::Error`.
    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error(_))
    }

    /// True iff `self` is `Value::Blank`.
    pub fn is_blank(&self) -> bool {
        matches!(self, Value::Blank)
    }

    /// Borrow the inner `ErrorValue`, or `None` if `self` isn't an error.
    pub fn as_error(&self) -> Option<ErrorValue> {
        match self {
            Value::Error(e) => Some(*e),
            _ => None,
        }
    }
}

impl fmt::Display for Value {
    /// Invariant text representation. NOT locale-aware — for that, see future
    /// `ql-functions::format`.
    /// - `Blank` → ""
    /// - `Number(n)` → Rust's `{n}` (no thousands separators)
    /// - `Boolean(b)` → "TRUE"/"FALSE" (Excel canonical case)
    /// - `Text(s)` → the string body verbatim
    /// - `Error(e)` → the sigil (e.g. "#REF!")
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Blank => Ok(()),
            Value::Number(n) => write!(f, "{n}"),
            Value::Boolean(true) => f.write_str("TRUE"),
            Value::Boolean(false) => f.write_str("FALSE"),
            Value::Text(s) => f.write_str(s),
            Value::Error(e) => write!(f, "{e}"),
        }
    }
}

/// Structural equality. NaN follows IEEE rules — `Number(NaN) != Number(NaN)`. This matches
/// Excel: NaN is never produced via the public constructor (`Value::number` sanitizes it),
/// so the only way to reach `Number(NaN) == Number(NaN)` is by bypassing it, in which case
/// returning `false` matches f64 semantics.
impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Value::Blank, Value::Blank) => true,
            (Value::Number(a), Value::Number(b)) => a == b,
            (Value::Boolean(a), Value::Boolean(b)) => a == b,
            (Value::Text(a), Value::Text(b)) => a == b,
            (Value::Error(a), Value::Error(b)) => a == b,
            _ => false,
        }
    }
}

impl From<f64> for Value {
    /// Convenience constructor: applies sanitization, so `Value::from(f64::NAN)` is
    /// `Value::Error(Num)`. Identical to `Value::number(n)`.
    fn from(n: f64) -> Self {
        Value::number(n)
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Boolean(b)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::text(s)
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::text(s)
    }
}

impl From<ErrorValue> for Value {
    fn from(e: ErrorValue) -> Self {
        Value::Error(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_blank() {
        assert!(matches!(Value::default(), Value::Blank));
    }

    #[test]
    fn number_constructor_sanitizes_nan_and_inf() {
        assert_eq!(Value::number(f64::NAN), Value::Error(ErrorValue::Num));
        assert_eq!(Value::number(f64::INFINITY), Value::Error(ErrorValue::Num));
        assert_eq!(
            Value::number(f64::NEG_INFINITY),
            Value::Error(ErrorValue::Num)
        );
        assert_eq!(Value::number(1.5), Value::Number(1.5));
        assert_eq!(Value::number(0.0), Value::Number(0.0));
        assert_eq!(Value::number(-0.0), Value::Number(-0.0));
    }

    #[test]
    fn text_constructor_shares_buffer_for_arc_input() {
        let arc: Arc<str> = "hi".into();
        let v = Value::text(Arc::clone(&arc));
        if let Value::Text(t) = v {
            assert!(Arc::ptr_eq(&arc, &t));
        } else {
            panic!();
        }
    }

    #[test]
    fn is_error_helper() {
        assert!(Value::Error(ErrorValue::Ref).is_error());
        assert!(!Value::Number(1.0).is_error());
        assert!(!Value::Blank.is_error());
    }

    #[test]
    fn is_blank_helper() {
        assert!(Value::Blank.is_blank());
        assert!(!Value::Number(0.0).is_blank());
        assert!(!Value::text("").is_blank()); // "" is Text, not Blank
    }

    #[test]
    fn as_error_yields_error_only() {
        assert_eq!(
            Value::Error(ErrorValue::Num).as_error(),
            Some(ErrorValue::Num)
        );
        assert_eq!(Value::Number(1.0).as_error(), None);
        assert_eq!(Value::Blank.as_error(), None);
    }

    #[test]
    fn display_matches_excel_invariant_forms() {
        assert_eq!(format!("{}", Value::Blank), "");
        assert_eq!(format!("{}", Value::Number(1.5)), "1.5");
        assert_eq!(format!("{}", Value::Number(0.0)), "0");
        assert_eq!(format!("{}", Value::Boolean(true)), "TRUE");
        assert_eq!(format!("{}", Value::Boolean(false)), "FALSE");
        assert_eq!(format!("{}", Value::text("hi")), "hi");
        assert_eq!(format!("{}", Value::Error(ErrorValue::Ref)), "#REF!");
    }

    #[test]
    fn equality_is_structural_per_variant() {
        assert_eq!(Value::Blank, Value::Blank);
        assert_eq!(Value::Number(1.5), Value::Number(1.5));
        assert_eq!(Value::Boolean(true), Value::Boolean(true));
        assert_eq!(Value::text("a"), Value::text("a"));
        assert_eq!(Value::Error(ErrorValue::Ref), Value::Error(ErrorValue::Ref));
        // Cross-variant inequality:
        assert_ne!(Value::Blank, Value::Number(0.0));
        assert_ne!(Value::Number(0.0), Value::Boolean(false));
        assert_ne!(Value::text(""), Value::Blank);
    }

    #[test]
    fn nan_number_unequal_per_ieee() {
        // Note: Value::number sanitizes NaN, so the only way to construct Number(NaN) is via
        // the raw variant. We construct it explicitly here to lock in the IEEE-754 semantics.
        let a = Value::Number(f64::NAN);
        let b = Value::Number(f64::NAN);
        assert_ne!(a, b);
    }

    #[test]
    fn from_impls() {
        assert_eq!(Value::from(1.5_f64), Value::Number(1.5));
        assert_eq!(Value::from(f64::NAN), Value::Error(ErrorValue::Num));
        assert_eq!(Value::from(true), Value::Boolean(true));
        assert_eq!(Value::from("hi"), Value::text("hi"));
        assert_eq!(Value::from(String::from("x")), Value::text("x"));
        assert_eq!(
            Value::from(ErrorValue::Permission),
            Value::Error(ErrorValue::Permission)
        );
    }

    #[test]
    fn size_of_value_is_reasonable() {
        // 24 bytes on 64-bit is the natural size (Arc fat pointer + discriminant + padding).
        // If this gets larger something added a heap-bearing variant — flag it loudly.
        assert!(
            std::mem::size_of::<Value>() <= 24,
            "Value grew to {} bytes — investigate",
            std::mem::size_of::<Value>()
        );
    }
}
