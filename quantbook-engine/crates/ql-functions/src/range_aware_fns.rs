//! Range-aware function dispatch (W5-53, GAP-F-05 closure).
//!
//! The base `ScalarFn = fn(&[Value]) -> Value` contract can't carry
//! per-argument range-vs-scalar metadata. Functions like SUMIF /
//! COUNTIF / VLOOKUP need to distinguish "this argument is a range
//! (criteria_range, sum_range, lookup_table)" from "this argument is
//! a single value (criteria, lookup_value)". Flattening every range
//! into a `Vec<Value>` and concatenating before dispatch loses that
//! structure.
//!
//! Phase 4.3 V2 (W5-53) introduces a parallel function-table tier
//! that preserves the shape:
//!
//! ```rust,ignore
//! pub enum FnArg {
//!     Scalar(Value),
//!     Range(Vec<Value>),
//! }
//! pub type RangeAwareFn = fn(&[FnArg]) -> Value;
//! ```
//!
//! The `eval_scalar_with_cache` dispatch in `ql-exec::scalar` checks
//! the range-aware table first; if a function is registered there,
//! args are built as `Vec<FnArg>` (AggregateNameRef → `Range`, other
//! plans → `Scalar(evaluated)`). Otherwise it falls through to the
//! existing `ScalarFn` path with `Vec<Value>` flattening.
//!
//! Migration of existing functions to `RangeAwareFn` is NOT required
//! — they keep working under `ScalarFn`. Only new functions that
//! genuinely need per-arg range distinction use the new tier.

use ql_types::Value;

/// A single argument to a range-aware function. `Scalar` carries a
/// pre-evaluated `Value`; `Range` carries the flat-iteration of a
/// range reference (row-major by `(row, col)` per `CellEnv::read_range`).
///
/// The `Range` payload is a `Vec<Value>` rather than a slice because
/// the producer (eval) owns the buffer. For very large ranges
/// (whole-column refs over millions of cells) this is the same cost
/// as the existing flattening path; range-aware functions just get
/// the structure preserved so they can pair `criteria_range[i]` with
/// `sum_range[i]`.
#[derive(Clone, Debug, PartialEq)]
pub enum FnArg {
    Scalar(Value),
    Range(Vec<Value>),
}

impl FnArg {
    /// Convenience for tests + scalar-only call sites: returns the
    /// inner `Value` if this is a scalar arg, panics otherwise.
    /// Production code should `match` on the variant explicitly.
    #[cfg(test)]
    pub fn unwrap_scalar(&self) -> &Value {
        match self {
            FnArg::Scalar(v) => v,
            FnArg::Range(_) => panic!("FnArg::unwrap_scalar called on a Range arg"),
        }
    }

    /// Convenience for tests: returns the inner Vec if Range, panics otherwise.
    #[cfg(test)]
    pub fn unwrap_range(&self) -> &[Value] {
        match self {
            FnArg::Range(v) => v.as_slice(),
            FnArg::Scalar(_) => panic!("FnArg::unwrap_range called on a Scalar arg"),
        }
    }
}

/// Signature for range-aware built-in functions. The evaluator
/// constructs the arg list with the correct `FnArg` variant per
/// position before dispatching.
pub type RangeAwareFn = fn(&[FnArg]) -> Value;
