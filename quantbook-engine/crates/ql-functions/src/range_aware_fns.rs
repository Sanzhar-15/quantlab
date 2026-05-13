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

use ql_types::{coercion, ErrorValue, Value};

/// Cross-module ergonomic enum for "numeric coerce, with Blank-skip and
/// Error-propagation surfaced as distinct match arms." Wraps the central
/// `ql_types::coercion::to_number_strict_skip_blank` so callers can use a
/// match on three variants instead of `Result<Option<f64>, ErrorValue>`.
///
/// **W5-64 (Phase 4.4.A consolidation):** Was previously duplicated in
/// `scalar_fns.rs` and `range_fns.rs`. Codex audit MEDIUM 3: keep the central
/// API neutral (Result/Option) but the function-aware enum stays in
/// ql-functions where it belongs.
#[derive(Debug)]
pub enum NumericArg {
    Number(f64),
    Skip,
    Error(ErrorValue),
}

/// W5-64 (Phase 4.4.A): cross-module ergonomic wrapper around
/// `coercion::to_number_strict_skip_blank`. Both `scalar_fns` and `range_fns`
/// use this; the duplicate `coerce_numeric` previously in each module was
/// removed.
pub fn coerce_numeric(v: &Value) -> NumericArg {
    match coercion::to_number_strict_skip_blank(v) {
        Ok(Some(n)) => NumericArg::Number(n),
        Ok(None) => NumericArg::Skip,
        Err(e) => NumericArg::Error(e),
    }
}

/// A single argument to a range-aware function. `Scalar` carries a
/// pre-evaluated `Value`; `Range` carries the flat row-major
/// iteration of a range reference (per `CellEnv::read_range`) PLUS
/// its 2D shape (rows × cols).
///
/// Shape is required for 2D-addressing functions like VLOOKUP /
/// HLOOKUP / INDEX, which compute `values[row * cols + col]`. 1D
/// consumers (SUMIF, COUNTIF) ignore shape and iterate `values`
/// flat — `rows * cols == values.len()` is the invariant the eval
/// dispatch maintains.
///
/// `values` is a `Vec<Value>` rather than a slice because the
/// producer (eval) owns the buffer. For very large ranges (whole-
/// column refs over millions of cells) this is the same cost as the
/// existing flattening path; range-aware functions get both the
/// flat data and the structure.
#[derive(Clone, Debug, PartialEq)]
pub enum FnArg {
    Scalar(Value),
    Range {
        values: Vec<Value>,
        rows: usize,
        cols: usize,
    },
}

impl FnArg {
    /// Construct a 1D `Range` (1 row × N cols, or N rows × 1 col —
    /// caller decides which axis). Convenience for tests + 1D
    /// consumers; uses `rows = 1, cols = values.len()` by default.
    /// Production callers should construct the variant directly so
    /// the shape reflects the source range.
    #[cfg(test)]
    pub fn range_1d(values: Vec<Value>) -> Self {
        let cols = values.len();
        FnArg::Range {
            values,
            rows: 1,
            cols,
        }
    }

    /// Construct a 2D `Range` with explicit shape.
    #[cfg(test)]
    pub fn range_2d(values: Vec<Value>, rows: usize, cols: usize) -> Self {
        debug_assert_eq!(rows * cols, values.len(), "shape mismatch");
        FnArg::Range { values, rows, cols }
    }

    /// Convenience for tests + scalar-only call sites: returns the
    /// inner `Value` if this is a scalar arg, panics otherwise.
    /// Production code should `match` on the variant explicitly.
    #[cfg(test)]
    pub fn unwrap_scalar(&self) -> &Value {
        match self {
            FnArg::Scalar(v) => v,
            FnArg::Range { .. } => panic!("FnArg::unwrap_scalar called on a Range arg"),
        }
    }

    /// Convenience for tests: returns the inner values if Range,
    /// panics otherwise.
    #[cfg(test)]
    pub fn unwrap_range(&self) -> &[Value] {
        match self {
            FnArg::Range { values, .. } => values.as_slice(),
            FnArg::Scalar(_) => panic!("FnArg::unwrap_range called on a Scalar arg"),
        }
    }
}

/// Signature for range-aware built-in functions. The evaluator
/// constructs the arg list with the correct `FnArg` variant per
/// position before dispatching.
pub type RangeAwareFn = fn(&[FnArg]) -> Value;
