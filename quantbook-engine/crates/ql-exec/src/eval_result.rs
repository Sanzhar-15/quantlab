//! `EvalResult` — the eval-boundary value type.
//!
//! **Phase 4.7.G (W5-100):** introduces the type the runtime will use
//! to distinguish scalar vs array results at the cell boundary.
//!
//! Design doc reference: `docs/architecture/2026-05-14-array-formulas-and-spills.md`
//! § 6.1.
//!
//! ## Why this type lives in `ql-exec`, not `ql-types`
//!
//! `EvalResult` is the eval-stage shape — produced by the evaluator,
//! consumed by the runtime's `set_formula` path. It carries an
//! `ArrayValue` from `ql-types` PLUS a `Value` variant for scalar
//! results. Placing it in `ql-exec` keeps `ql-types` lean (cells are
//! always scalar at the storage layer; arrays MATERIALIZE into per-
//! cell scalars in the computed overlay during spill writeback).
//!
//! ## Use sites
//!
//! - **W5-100 (this commit):** internal to the aggregate-arg expansion
//!   path; `eval_scalar_with_cache` consults the per-arg shape via
//!   `ExprPlan::Array` directly (no explicit `EvalResult` materialization
//!   in the dispatch path yet — but the type is exported so call sites
//!   can adopt it incrementally).
//! - **W5-102+ (Phase 4.7.J):** `WorkbookRuntime::set_formula` adopts
//!   `EvalResult` as the return type of a new cell-boundary entry point
//!   (`eval_at_cell_boundary`) so the spill-writeback path can detect
//!   `EvalResult::Array(_)` and route to spill-target writing.
//!
//! ## Why not `Value::Array(ArrayValue)`?
//!
//! Storage cells stay scalar by Excel canon. Adding an `Array` variant
//! to `Value` would force every `Sheet::read` caller to handle the
//! multi-cell case. Spill writeback materializes arrays at the moment
//! a formula evaluates to one — the cell-by-cell scalar property is
//! preserved at every read after that point. `EvalResult` lives only
//! at the eval boundary.

use ql_types::{ArrayValue, Value};

/// The result of evaluating an expression at the cell-boundary level.
///
/// - `Scalar(Value)` — single-cell result. The existing scalar evaluator
///   (`eval_scalar_with_cache`) produces this for every plan except
///   `ExprPlan::Array(_)`.
/// - `Array(ArrayValue)` — multi-cell result. Currently produced ONLY
///   by direct materialization of `ExprPlan::Array` (Phase 4.7.G); in
///   Phase 4.7.M/N, also by array-returning functions (SEQUENCE,
///   FILTER, TRANSPOSE).
///
/// **Cell-boundary contract (Phase 4.7.J):** `WorkbookRuntime::set_formula`
/// will call a new entry point that returns `EvalResult` and route
/// `Array(_)` results to the spill-writeback path. `Scalar(_)` follows
/// the existing single-cell write path.
#[derive(Clone, Debug, PartialEq)]
pub enum EvalResult {
    Scalar(Value),
    Array(ArrayValue),
}

impl EvalResult {
    /// True if this is `Array(_)`. Helper for spill-routing predicates.
    pub fn is_array(&self) -> bool {
        matches!(self, EvalResult::Array(_))
    }

    /// Extract the inner `Value` if scalar; convert an Array's first cell
    /// to a Value otherwise. **NB:** "first cell" is NOT the canonical
    /// scalar-context handling for arrays — per design § 6.3, array-in-
    /// scalar-context surfaces as `Value::Error(ErrorValue::Calc)`. This
    /// method is a TEST CONVENIENCE; production callers should pattern-
    /// match on the variant.
    #[cfg(test)]
    pub(crate) fn into_scalar_for_test(self) -> Value {
        match self {
            EvalResult::Scalar(v) => v,
            EvalResult::Array(a) if a.is_degenerate() => Value::Error(ql_types::ErrorValue::Calc),
            EvalResult::Array(a) => a.first().clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::ErrorValue;

    #[test]
    fn scalar_is_not_array() {
        let r = EvalResult::Scalar(Value::Number(42.0));
        assert!(!r.is_array());
    }

    #[test]
    fn array_is_array() {
        let r = EvalResult::Array(ArrayValue::singleton(Value::Number(7.0)));
        assert!(r.is_array());
    }

    #[test]
    fn equality_compares_scalar_to_scalar_only() {
        let a = EvalResult::Scalar(Value::Number(1.0));
        let b = EvalResult::Scalar(Value::Number(1.0));
        let c = EvalResult::Array(ArrayValue::singleton(Value::Number(1.0)));
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn into_scalar_for_test_returns_value_for_scalar() {
        let r = EvalResult::Scalar(Value::Number(5.0));
        assert!(matches!(r.into_scalar_for_test(), Value::Number(n) if n == 5.0));
    }

    #[test]
    fn into_scalar_for_test_returns_first_for_non_degenerate_array() {
        let arr = ArrayValue::row(vec![Value::Number(1.0), Value::Number(2.0)]);
        let r = EvalResult::Array(arr);
        assert!(matches!(r.into_scalar_for_test(), Value::Number(n) if n == 1.0));
    }

    #[test]
    fn into_scalar_for_test_returns_calc_for_degenerate_array() {
        let arr = ArrayValue::empty(0, 5);
        let r = EvalResult::Array(arr);
        assert!(matches!(
            r.into_scalar_for_test(),
            Value::Error(ErrorValue::Calc)
        ));
    }
}
