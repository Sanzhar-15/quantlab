//! Phase 4.5.A.0 (W5-69) — context-aware function dispatch tier.
//!
//! Third registry table alongside `ScalarFn` and `RangeAwareFn`. The W5-68
//! Phase 4.5 design surfaces the gap: `ScalarFn = fn(&[Value]) -> Value`
//! can't carry workbook-level state (date system, locale, current-clock
//! provider). Date functions like `DATE`, `WEEKDAY`, `NOW`, `TODAY`,
//! `EOMONTH` need this state to behave correctly.
//!
//! ## Dispatch order
//!
//! `crate::scalar::eval_scalar_with_cache` checks the three tables in
//! order:
//!
//! 1. `range_aware_fns` — first; arg-shape-aware (SUMIF/VLOOKUP/...).
//! 2. `context_aware_fns` — second; takes `&EvalContext` (date/locale/clock).
//! 3. `fns` (scalar) — last; pre-eval'd args only.
//!
//! Disjointness invariant: a single name MUST NOT live in more than one
//! table. `FunctionRegistry::register_context_aware` panics on cross-table
//! collision.
//!
//! ## Why a third tier (not a unified `EnhancedFn`)?
//!
//! W5-68 design § 4.A: a unified `fn(&[FnArg], &EvalContext) -> Value` is
//! the right long-term shape but would force migrating ~78 existing
//! scalar fns. The third-tier approach is the smallest-viable change for
//! Phase 4.5 (mirrors the W5-53 RangeAwareFn precedent). If Phase 4.7
//! array formulas need yet ANOTHER tier, that's the trigger to refactor
//! to the unified shape.

use ql_types::{EvalContext, Value};

/// Signature for context-aware built-in functions.
///
/// Receives pre-evaluated args + the call site's `EvalContext` (carries
/// date_system, locale, now_provider).
pub type ContextAwareFn = fn(&[Value], &EvalContext) -> Value;
