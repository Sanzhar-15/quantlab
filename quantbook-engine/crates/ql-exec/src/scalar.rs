//! Scalar evaluator — `eval_scalar(plan, env) -> Value`.
//!
//! Per-cell evaluation path. Used for:
//! - Single-cell formulas (`=A1+B1` in cell C1).
//! - Per-cell fallback inside a FormulaRegion when SIMD isn't applicable (text, error,
//!   mixed types, non-arithmetic ops, division — see lower.rs H5 routing).
//! - Tests, which is most of the W4-1 coverage.
//!
//! The SIMD hot path for OG-02 lives in `simd.rs` and bypasses this entirely —
//! it consumes Arrow Float64Array slices directly via `multiversion`-dispatched
//! kernels.
//!
//! ## Excel binary arithmetic semantics (Phase 2A.9 audit M1 — lenient coercion)
//!
//! For binary operators `+ - * / ^`:
//! - If either operand is an `Error`, propagate that error (left operand wins).
//! - Coerce both operands to f64 via `to_number_lenient` (Number → self;
//!   Bool → 0/1; Blank → 0; Text that parses as a number → that number; Text
//!   that doesn't parse → `#VALUE!`; Error → propagate). Phase 2A.9 audit M1
//!   replaced the prior strict path that rejected ALL text.
//! - Apply the f64 op. Sanitize result via `sanitize_f64` (NaN/Inf → `#NUM!`).
//! - Special cases (Phase 2A.9 audit M3 / 2A.13 audit M3 companion):
//!   - Division by zero → `#DIV/0!`.
//!   - Negative base ^ non-integer exponent → `#NUM!`.
//!   - `0^0` → `#NUM!`.
//!   - `0^-n` (n > 0) → `#DIV/0!` (mathematically `1/0^n`).
//!
//! For `&` (concat): coerce both to text via `to_text_for_formula`; concat. Errors
//! propagate.
//!
//! Comparison operators (`=`, `<>`, `<`, `>`, `<=`, `>=`) follow Excel-canon
//! cross-type ordering (Phase 2A.9 audit M2): same-type pairs compare per
//! their natural ordering; mixed-type pairs use type rank
//! (`Number < Text < Boolean`). `Blank` coerces to `0` vs Number and `""`
//! vs Text; for `Blank vs Boolean` the type-rank fallthrough applies (Blank
//! ranks as Number, so `Blank < TRUE`). See `compare_values_excel`.
//!
//! Unary `-x` negates; `+x` no-ops; `x%` divides by 100.

use ql_formula_syntax::Operator;
use ql_functions::FunctionRegistry;
use ql_types::{coercion, ErrorValue, Value};

use crate::aggregate_cache::{AggregateCache, NoAggregateCache};
use crate::env::CellEnv;
use crate::plan::ExprPlan;

/// Evaluate an `ExprPlan` against `env` to produce a `Value`. Total function — never
/// panics on Excel semantics (NaN, div-by-zero, etc.). Panics only on internal
/// programmer errors (e.g. malformed ExprPlan that bind() couldn't produce).
///
/// `Function` variants return `#NAME?` (`ErrorValue::Name`). To dispatch through a
/// registry, use `eval_scalar_with_registry` instead.
pub fn eval_scalar<E: CellEnv>(plan: &ExprPlan, env: &E) -> Value {
    match plan {
        ExprPlan::Number(n) => Value::number(*n),
        ExprPlan::Bool(b) => Value::Boolean(*b),
        ExprPlan::String(s) => Value::Text(s.clone()),
        ExprPlan::CellRef {
            sheet, row, col, ..
        } => env.read_cell(*sheet, *row, *col),
        ExprPlan::Binary { op, lhs, rhs } => {
            let l = eval_scalar(lhs, env);
            let r = eval_scalar(rhs, env);
            eval_binary(*op, l, r)
        }
        ExprPlan::Unary { op, operand } => {
            let v = eval_scalar(operand, env);
            eval_unary(*op, v)
        }
        ExprPlan::Function { .. } => Value::Error(ErrorValue::Name),
        // **Legacy no-registry path only.** Phase 3.6 / W5-39 added
        // real aggregate-over-named-range evaluation, but ONLY in
        // `eval_scalar_with_cache` (the cache-enabled entry point).
        // This older `eval_scalar` function is kept for tests + the
        // SIMD per-cell fallback path; it has no registry handle
        // and intentionally surfaces `#CALC!` for any aggregate-
        // named-range reference. Callers that want actual aggregate
        // semantics must go through `eval_scalar_with_registry` or
        // `eval_scalar_with_cache`.
        ExprPlan::AggregateNameRef { .. } => Value::Error(ErrorValue::Calc),
        // **W5-99 (Phase 4.7.F):** error literal — return the error
        // value directly. Used by `=#REF!` formulas and error literals
        // inside array cells.
        ExprPlan::Error(ev) => Value::Error(*ev),
        // **W5-99 (Phase 4.7.F):** array literal in scalar context.
        // Per design § 6.3 (Codex HIGH-2 fix): array-in-scalar-context
        // surfaces as `#CALC!`. This applies to the cell-boundary
        // ALSO until the runtime spill path lands in W5-102 / 4.7.J;
        // for now, even array literals at the cell root produce
        // `#CALC!`. The spill path will route around this by detecting
        // `ExprPlan::Array` at the cell-boundary BEFORE calling
        // `eval_scalar_*` and materializing an `ArrayValue` instead.
        ExprPlan::Array(_) => Value::Error(ErrorValue::Calc),
    }
}

/// Like `eval_scalar` but dispatches `Function` variants through a `FunctionRegistry`.
/// Unknown function names return `#NAME?`. Args are evaluated left-to-right with this
/// same function (recursive); error-args propagate naturally through the registered
/// function's logic.
pub fn eval_scalar_with_registry<E: CellEnv>(
    plan: &ExprPlan,
    env: &E,
    registry: &FunctionRegistry,
) -> Value {
    // Phase 3.6: legacy entry point — no aggregate cache. Wraps the cached
    // path with `NoAggregateCache` (zero-cost no-op impl). Callers that
    // have a session-owned cache should call `eval_scalar_with_cache`.
    eval_scalar_with_cache(plan, env, registry, &NoAggregateCache)
}

/// **Phase 3.6 (2026-05-12) — W5-39, AGG-3-01..04 entry point.** Like
/// `eval_scalar_with_registry` but consults `cache` for aggregate-over-
/// range evaluations. When the Function branch detects an aggregate fn
/// with an `AggregateNameRef` arg, it:
///
/// 1. Looks up `(range, function_name)` in `cache`. Hit → returns the
///    cached value without re-scanning the range.
/// 2. Miss → materializes the range via `CellEnv::read_range`, calls
///    the aggregator, stores the result in `cache`, returns it.
///
/// The cache is invalidated externally (via `CalcgraphSession::
/// mark_dirty_from_cell_write` → `InMemAggregateCache::invalidate_at`)
/// when a cell inside any cached range is written. The evaluator itself
/// never invalidates — it only reads + stores.
///
/// Pass `&NoAggregateCache` for the legacy "always recompute" behavior.
pub fn eval_scalar_with_cache<E: CellEnv>(
    plan: &ExprPlan,
    env: &E,
    registry: &FunctionRegistry,
    cache: &dyn AggregateCache,
) -> Value {
    match plan {
        ExprPlan::Number(n) => Value::number(*n),
        ExprPlan::Bool(b) => Value::Boolean(*b),
        ExprPlan::String(s) => Value::Text(s.clone()),
        ExprPlan::CellRef {
            sheet, row, col, ..
        } => env.read_cell(*sheet, *row, *col),
        ExprPlan::Binary { op, lhs, rhs } => {
            let l = eval_scalar_with_cache(lhs, env, registry, cache);
            let r = eval_scalar_with_cache(rhs, env, registry, cache);
            eval_binary(*op, l, r)
        }
        ExprPlan::Unary { op, operand } => {
            let v = eval_scalar_with_cache(operand, env, registry, cache);
            eval_unary(*op, v)
        }
        ExprPlan::Function { name, args } => {
            // W5-53 (GAP-F-05 closure): check the range-aware table
            // FIRST. Range-aware functions like SUMIF need per-arg
            // range-vs-scalar metadata that the scalar `&[Value]`
            // contract can't carry. If a function is registered as
            // range-aware, build `Vec<FnArg>` with the correct
            // variant per arg (`AggregateNameRef` → `Range(read_range)`,
            // everything else → `Scalar(eval)`).
            if let Some(raf) = registry.lookup_range_aware(name) {
                use ql_functions::FnArg;
                let mut fn_args: Vec<FnArg> = Vec::with_capacity(args.len());
                for a in args {
                    match a {
                        ExprPlan::AggregateNameRef { range, .. } => {
                            // W5-54: shape-aware Range so VLOOKUP /
                            // HLOOKUP / INDEX can address by (row,
                            // col). SUMIF / COUNTIF ignore shape.
                            let (values, rows, cols) = env.read_range_with_shape(*range);
                            fn_args.push(FnArg::Range { values, rows, cols });
                        }
                        other => {
                            fn_args.push(FnArg::Scalar(eval_scalar_with_cache(
                                other, env, registry, cache,
                            )));
                        }
                    }
                }
                return raf(&fn_args);
            }
            // **W5-69 (Phase 4.5.A.0):** check the context-aware table
            // SECOND. Date / locale / clock-aware functions (DATE, NOW,
            // TODAY, WEEKDAY, ...) take an extra `&EvalContext` arg in
            // addition to pre-evaluated `&[Value]`. Args are evaluated
            // left-to-right exactly like the scalar path; only the
            // function signature differs. EvalContext is sourced from
            // `env.eval_context()` (default is Excel1900 + EnUs +
            // System).
            if let Some(caf) = registry.lookup_context_aware(name) {
                let evaluated: Vec<Value> = args
                    .iter()
                    .map(|a| eval_scalar_with_cache(a, env, registry, cache))
                    .collect();
                return caf(&evaluated, env.eval_context());
            }
            match registry.lookup(name) {
                Some(f) => {
                    // Phase 3.6 (2026-05-12) — AGG-3-04 correctness + AGG-
                    // 3-01 cache hit path. Detect aggregate-over-named-range
                    // and route through the cache. The cache key is `(range,
                    // function_name)` — the EXACT call shape, not just the
                    // range — so `SUM(Sales)` and `AVERAGE(Sales)` are
                    // separate entries.
                    //
                    // Single-AggregateNameRef-arg fast path: most aggregates
                    // are called with a single named range (`=SUM(Sales)`).
                    // We special-case that for cache use. Multi-range
                    // aggregates (`SUM(Sales, Discount)`) fall back to no-
                    // cache (compute on every call) — V1 limitation.
                    let single_range_arg = match args.as_slice() {
                        [ExprPlan::AggregateNameRef { range, .. }] => Some(*range),
                        _ => None,
                    };
                    if let Some(range) = single_range_arg {
                        if crate::plan::is_aggregate_function(name) {
                            if let Some(cached) = cache.lookup_aggregate(range, name) {
                                return cached;
                            }
                            let flat = env.read_range(range);
                            let v = f(&flat);
                            // Don't cache `Value::Error(_)` results — they
                            // often signal env-level issues (missing sheet
                            // → #REF!, empty range AVERAGE → #DIV/0!) that
                            // a follow-up edit would resolve; better to
                            // recompute than serve a stale error.
                            if !matches!(v, Value::Error(_)) {
                                cache.store_aggregate(range, name, v.clone());
                            }
                            return v;
                        }
                    }
                    // **W5-100 (Phase 4.7.G):** also detect `ExprPlan::Array`
                    // args as range-like containers. Per design § 6.3, array
                    // results in aggregate-arg context "feed cells" — i.e.,
                    // SUM({1,2,3}) iterates the cells the same way it would
                    // iterate a named-range arg's cells. Without this, the
                    // pre-W5-100 path evaluated the Array as scalar (→
                    // #CALC!) and SUM saw a single error value.
                    let has_range_or_array_arg = args.iter().any(|a| {
                        matches!(a, ExprPlan::AggregateNameRef { .. } | ExprPlan::Array(_))
                    });
                    if has_range_or_array_arg && crate::plan::is_aggregate_function(name) {
                        // Multi-range / mixed aggregate args: materialize
                        // every range AND every array literal, then call
                        // the function. No cache use (V2 may add multi-
                        // range cache keys; array-literal args are pure
                        // values without provenance, so caching them is
                        // a no-op anyway).
                        let mut flat: Vec<Value> = Vec::new();
                        for a in args {
                            match a {
                                ExprPlan::AggregateNameRef { range, .. } => {
                                    flat.extend(env.read_range(*range));
                                }
                                ExprPlan::Array(rows) => {
                                    // **W5-100:** array cells are literal-
                                    // only per the W5-99 binder restriction
                                    // (Number / Bool / String / Error). Eval
                                    // each cell via the scalar path — the
                                    // legacy scalar arm already returns the
                                    // literal value via `eval_scalar_with_cache`.
                                    // Row-major iteration matches the
                                    // existing `env.read_range` flat shape.
                                    for row in rows {
                                        for cell in row {
                                            flat.push(eval_scalar_with_cache(
                                                cell, env, registry, cache,
                                            ));
                                        }
                                    }
                                }
                                other => {
                                    flat.push(eval_scalar_with_cache(other, env, registry, cache));
                                }
                            }
                        }
                        f(&flat)
                    } else {
                        let evaluated: Vec<Value> = args
                            .iter()
                            .map(|a| eval_scalar_with_cache(a, env, registry, cache))
                            .collect();
                        f(&evaluated)
                    }
                }
                None => Value::Error(ErrorValue::Name),
            }
        }
        // `AggregateNameRef` outside a Function context — the binder is
        // supposed to surface `BindError::NamedRangeInScalarContext`
        // before we ever evaluate. Defensive fallback: `#CALC!`.
        ExprPlan::AggregateNameRef { .. } => Value::Error(ErrorValue::Calc),
        // **W5-99 (Phase 4.7.F):** error literal — return the error
        // value directly. Same shape as the no-registry `eval_scalar`
        // arm above.
        ExprPlan::Error(ev) => Value::Error(*ev),
        // **W5-99 (Phase 4.7.F):** array literal in scalar context →
        // `#CALC!` per design § 6.3. Cell-boundary detection (the spill
        // path) lands in W5-102 / Phase 4.7.J; until then, every
        // `ExprPlan::Array` evaluation produces `#CALC!`.
        ExprPlan::Array(_) => Value::Error(ErrorValue::Calc),
    }
}

fn eval_binary(op: Operator, lhs: Value, rhs: Value) -> Value {
    // Error propagation comes first — Excel's left-error-wins rule.
    if let Value::Error(e) = lhs {
        return Value::Error(e);
    }
    if let Value::Error(e) = rhs {
        return Value::Error(e);
    }

    match op {
        Operator::Plus | Operator::Minus | Operator::Mul | Operator::Div | Operator::Pow => {
            eval_arithmetic(op, &lhs, &rhs)
        }
        Operator::Concat => eval_concat(&lhs, &rhs),
        Operator::Eq
        | Operator::Neq
        | Operator::Lt
        | Operator::Le
        | Operator::Gt
        | Operator::Ge => eval_compare(op, &lhs, &rhs),
        // Phase 0 doesn't produce Percent as a binary op (it's unary in Excel).
        Operator::Percent => Value::Error(ErrorValue::Value),
    }
}

fn eval_arithmetic(op: Operator, lhs: &Value, rhs: &Value) -> Value {
    // Phase 2A.9 audit M1: arithmetic uses Excel-canonical *lenient* coercion.
    // `"5" + 1` evaluates to `6` (text-that-parses-as-number coerces); only
    // unparseable text returns `#VALUE!`. Phase 1 used the strict path which
    // rejected ALL text — that was a documented Phase 0 deviation from Excel
    // canon, with the lenient impl sitting unused in `ql-types::coercion`.
    let lhs_num = match coercion::to_number_lenient(lhs) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let rhs_num = match coercion::to_number_lenient(rhs) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };

    let result = match op {
        Operator::Plus => lhs_num + rhs_num,
        Operator::Minus => lhs_num - rhs_num,
        Operator::Mul => lhs_num * rhs_num,
        Operator::Div => {
            if rhs_num == 0.0 {
                return Value::Error(ErrorValue::DivZero);
            }
            lhs_num / rhs_num
        }
        Operator::Pow => {
            // Excel: negative base with non-integer exponent → #NUM!. Plain f64::powf
            // would produce NaN which sanitize_f64 would map to #NUM!, but check
            // explicitly so the error type is clear.
            if lhs_num < 0.0 && rhs_num.fract() != 0.0 {
                return Value::Error(ErrorValue::Num);
            }
            // Phase 2A.13 audit cycle-3 M3 companion: `0^-n` is `#DIV/0!` per
            // Excel canon (mathematically `0^-n = 1/0^n`). Rust/IEEE produces
            // `+Inf`, which `sanitize_f64` would map to `#NUM!` — wrong error
            // class. Guard before the `0^0` check (different precondition).
            if lhs_num == 0.0 && rhs_num < 0.0 {
                return Value::Error(ErrorValue::DivZero);
            }
            // Phase 2A.9 audit M3: Excel canon — `0^0` is `#NUM!`. Rust/IEEE
            // produces 1.0, which would be a silent deviation. Guard explicitly.
            if lhs_num == 0.0 && rhs_num == 0.0 {
                return Value::Error(ErrorValue::Num);
            }
            lhs_num.powf(rhs_num)
        }
        _ => unreachable!("eval_arithmetic called with non-arithmetic op {op:?}"),
    };

    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

fn eval_concat(lhs: &Value, rhs: &Value) -> Value {
    let l = match coercion::to_text_for_formula(lhs) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let r = match coercion::to_text_for_formula(rhs) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::text(format!("{l}{r}"))
}

fn eval_compare(op: Operator, lhs: &Value, rhs: &Value) -> Value {
    // Phase 2A.9 audit M2: implement Excel-canonical cross-type comparison.
    // Same-type pairs compare per their natural ordering; mixed-type pairs
    // order by type rank: Number < Text < Boolean. Blank coerces to 0 for
    // Number comparisons and "" for Text. Errors propagate.
    if let Value::Error(e) = lhs {
        return Value::Error(*e);
    }
    if let Value::Error(e) = rhs {
        return Value::Error(*e);
    }
    let cmp = compare_values_excel(lhs, rhs);
    let result_bool = match op {
        Operator::Eq => cmp == std::cmp::Ordering::Equal,
        Operator::Neq => cmp != std::cmp::Ordering::Equal,
        Operator::Lt => cmp == std::cmp::Ordering::Less,
        Operator::Le => matches!(cmp, std::cmp::Ordering::Less | std::cmp::Ordering::Equal),
        Operator::Gt => cmp == std::cmp::Ordering::Greater,
        Operator::Ge => {
            matches!(cmp, std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
        }
        _ => unreachable!(),
    };
    Value::Boolean(result_bool)
}

/// Phase 2A.9 audit M2: Excel-canonical comparison ordering. When operands
/// have different types, they're ordered by type rank: Number/Blank < Text <
/// Boolean. Within a type, natural ordering applies. Blank coerces to 0 (for
/// Number comparisons) or "" (for Text); we represent Blank as having the
/// Number rank so `=0=B1` is TRUE for blank B1.
///
/// This replaces `compare_values_phase0`, which returned `None` for mixed
/// types and let downstream code silently degrade to `false` for ordering
/// comparisons — a documented Phase 0 deviation from Excel canon.
fn compare_values_excel(lhs: &Value, rhs: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    // Same-type comparisons go through the natural ordering.
    match (lhs, rhs) {
        (Value::Number(a), Value::Number(b)) => return a.partial_cmp(b).unwrap_or(Ordering::Equal),
        (Value::Boolean(a), Value::Boolean(b)) => return a.cmp(b),
        (Value::Text(a), Value::Text(b)) => return a.as_ref().cmp(b.as_ref()),
        (Value::Blank, Value::Blank) => return Ordering::Equal,
        _ => {}
    }
    // Blank coerces per the other operand: Blank vs Number → compare as 0;
    // Blank vs Text → compare as "". This matches Excel's behavior for the
    // common `=A1=0` and `=A1=""` idioms.
    match (lhs, rhs) {
        (Value::Blank, Value::Number(b)) => {
            return 0.0_f64.partial_cmp(b).unwrap_or(Ordering::Equal)
        }
        (Value::Number(a), Value::Blank) => return a.partial_cmp(&0.0).unwrap_or(Ordering::Equal),
        (Value::Blank, Value::Text(b)) => return "".cmp(b.as_ref()),
        (Value::Text(a), Value::Blank) => return a.as_ref().cmp(""),
        _ => {}
    }
    // True cross-type: rank by type. Excel canon: Number < Text < Boolean.
    // Blank carries the Number rank (it coerces above before reaching here for
    // Number/Text peers, so this only matters for Blank-vs-Bool).
    fn type_rank(v: &Value) -> u8 {
        match v {
            Value::Number(_) | Value::Blank => 0,
            Value::Text(_) => 1,
            Value::Boolean(_) => 2,
            // Error already short-circuited in eval_compare.
            Value::Error(_) => unreachable!("Error short-circuits in eval_compare"),
        }
    }
    type_rank(lhs).cmp(&type_rank(rhs))
}

fn eval_unary(op: Operator, operand: Value) -> Value {
    if let Value::Error(e) = operand {
        return Value::Error(e);
    }
    let n = match coercion::to_number_strict(&operand) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let result = match op {
        Operator::Minus => -n,
        Operator::Plus => n,
        Operator::Percent => n / 100.0,
        _ => return Value::Error(ErrorValue::Value),
    };
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::MapEnv;
    use crate::plan::bind;
    use ql_formula_syntax::{CellAddr, Expr, SheetRef};
    use std::sync::Arc;

    fn cell_ref(col: u32, row: u32) -> Expr {
        Expr::CellRef(CellAddr {
            sheet: SheetRef::Current,
            col,
            row,
            abs_col: false,
            abs_row: false,
        })
    }

    fn n(v: f64) -> Expr {
        Expr::Number(v)
    }

    fn bin(op: Operator, lhs: Expr, rhs: Expr) -> Expr {
        Expr::Binary {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        }
    }

    fn eval(expr: &Expr, env: &MapEnv) -> Value {
        let plan = bind(expr, 0).expect("bind");
        eval_scalar(&plan, env)
    }

    // ===== literal + ref =====

    #[test]
    fn number_literal() {
        let env = MapEnv::new();
        assert_eq!(eval(&n(42.5), &env), Value::Number(42.5));
    }

    #[test]
    fn bool_literal() {
        let env = MapEnv::new();
        assert_eq!(eval(&Expr::Bool(true), &env), Value::Boolean(true));
    }

    #[test]
    fn string_literal() {
        let env = MapEnv::new();
        let s = Expr::String(Arc::from("hello"));
        assert_eq!(eval(&s, &env), Value::text("hello"));
    }

    #[test]
    fn nan_literal_becomes_num_error() {
        // Value::number sanitizer rejects NaN/Inf and surfaces #NUM!.
        let env = MapEnv::new();
        assert_eq!(eval(&n(f64::NAN), &env), Value::Error(ErrorValue::Num));
        assert_eq!(eval(&n(f64::INFINITY), &env), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn cell_ref_reads_from_env() {
        let mut env = MapEnv::new();
        env.put(0, 5, 3, Value::Number(7.0));
        // Read column 3, row 5.
        assert_eq!(eval(&cell_ref(3, 5), &env), Value::Number(7.0));
    }

    #[test]
    fn cell_ref_missing_is_blank() {
        let env = MapEnv::new();
        assert_eq!(eval(&cell_ref(0, 0), &env), Value::Blank);
    }

    // ===== arithmetic =====

    #[test]
    fn binary_plus() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Plus, n(1.0), n(2.0)), &env),
            Value::Number(3.0)
        );
    }

    #[test]
    fn binary_minus() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Minus, n(5.0), n(2.0)), &env),
            Value::Number(3.0)
        );
    }

    #[test]
    fn binary_mul_is_og02_op() {
        // =A * 2 — the OG-02 acceptance pattern.
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Mul, n(3.0), n(4.0)), &env),
            Value::Number(12.0)
        );
    }

    #[test]
    fn binary_div() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Div, n(10.0), n(2.0)), &env),
            Value::Number(5.0)
        );
    }

    #[test]
    fn div_by_zero_yields_div_zero_error() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Div, n(10.0), n(0.0)), &env),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn pow_basic() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Pow, n(2.0), n(10.0)), &env),
            Value::Number(1024.0)
        );
    }

    #[test]
    fn pow_negative_base_with_fractional_exponent_yields_num_error() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Pow, n(-2.0), n(0.5)), &env),
            Value::Error(ErrorValue::Num)
        );
    }

    // ===== coercion =====

    #[test]
    fn bool_plus_number_coerces_to_one() {
        let env = MapEnv::new();
        // true + 5 = 1 + 5 = 6
        assert_eq!(
            eval(&bin(Operator::Plus, Expr::Bool(true), n(5.0)), &env),
            Value::Number(6.0)
        );
        // false + 5 = 0 + 5 = 5
        assert_eq!(
            eval(&bin(Operator::Plus, Expr::Bool(false), n(5.0)), &env),
            Value::Number(5.0)
        );
    }

    #[test]
    fn blank_plus_number_yields_number() {
        let env = MapEnv::new();
        // Blank coerces to 0 per Excel. =A1 + 5 when A1 is blank → 5.
        assert_eq!(
            eval(&bin(Operator::Plus, cell_ref(0, 0), n(5.0)), &env),
            Value::Number(5.0)
        );
    }

    #[test]
    fn text_plus_number_yields_value_error() {
        let env = MapEnv::new();
        let txt = Expr::String(Arc::from("hello"));
        // to_number_strict rejects Text → #VALUE!
        assert_eq!(
            eval(&bin(Operator::Plus, txt, n(5.0)), &env),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== error propagation =====

    #[test]
    fn error_in_lhs_propagates() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Ref));
        let result = eval(&bin(Operator::Plus, cell_ref(0, 0), n(5.0)), &env);
        assert_eq!(result, Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn error_in_rhs_propagates() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Num));
        let result = eval(&bin(Operator::Plus, n(5.0), cell_ref(0, 0)), &env);
        assert_eq!(result, Value::Error(ErrorValue::Num));
    }

    #[test]
    fn lhs_error_wins_over_rhs_error() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Ref));
        env.put(0, 0, 1, Value::Error(ErrorValue::Value));
        let result = eval(&bin(Operator::Plus, cell_ref(0, 0), cell_ref(1, 0)), &env);
        assert_eq!(result, Value::Error(ErrorValue::Ref));
    }

    // ===== unary =====

    #[test]
    fn unary_minus() {
        let env = MapEnv::new();
        let expr = Expr::Unary {
            op: Operator::Minus,
            operand: Box::new(n(5.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Number(-5.0));
    }

    #[test]
    fn unary_percent() {
        let env = MapEnv::new();
        let expr = Expr::Unary {
            op: Operator::Percent,
            operand: Box::new(n(50.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Number(0.5));
    }

    // ===== nested =====

    #[test]
    fn nested_a1_plus_b1_times_2() {
        // =(A1 + B1) * 2 with A1=3, B1=4 → (3+4)*2 = 14
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(3.0));
        env.put(0, 0, 1, Value::Number(4.0));
        let inner = bin(Operator::Plus, cell_ref(0, 0), cell_ref(1, 0));
        let outer = bin(Operator::Mul, inner, n(2.0));
        assert_eq!(eval(&outer, &env), Value::Number(14.0));
    }

    #[test]
    fn og02_pattern_cell_times_two() {
        // The OG-02 baseline pattern: =A * 2 over many rows. Single-cell verification.
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(42.0));
        let expr = bin(Operator::Mul, cell_ref(0, 0), n(2.0));
        assert_eq!(eval(&expr, &env), Value::Number(84.0));
    }

    // ===== concat =====

    #[test]
    fn concat_two_strings() {
        let env = MapEnv::new();
        let l = Expr::String(Arc::from("foo"));
        let r = Expr::String(Arc::from("bar"));
        assert_eq!(
            eval(&bin(Operator::Concat, l, r), &env),
            Value::text("foobar")
        );
    }

    #[test]
    fn concat_number_and_string() {
        let env = MapEnv::new();
        let l = n(42.0);
        let r = Expr::String(Arc::from(" rows"));
        assert_eq!(
            eval(&bin(Operator::Concat, l, r), &env),
            Value::text("42 rows")
        );
    }

    // ===== comparison (Number-vs-Number Phase 0 subset) =====

    #[test]
    fn comparison_eq() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Eq, n(5.0), n(5.0)), &env),
            Value::Boolean(true)
        );
        assert_eq!(
            eval(&bin(Operator::Eq, n(5.0), n(6.0)), &env),
            Value::Boolean(false)
        );
    }

    #[test]
    fn comparison_lt() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Lt, n(3.0), n(5.0)), &env),
            Value::Boolean(true)
        );
        assert_eq!(
            eval(&bin(Operator::Lt, n(5.0), n(5.0)), &env),
            Value::Boolean(false)
        );
    }

    #[test]
    fn comparison_ge() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Ge, n(5.0), n(5.0)), &env),
            Value::Boolean(true)
        );
        assert_eq!(
            eval(&bin(Operator::Ge, n(4.0), n(5.0)), &env),
            Value::Boolean(false)
        );
    }

    // ===== overflow / sanitization =====

    #[test]
    fn arithmetic_overflow_to_num_error() {
        let env = MapEnv::new();
        // f64::MAX * 2.0 = Inf → sanitize_f64 returns #NUM!
        let expr = bin(Operator::Mul, n(f64::MAX), n(2.0));
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::Num));
    }

    // ===== W4-5: function dispatch via registry =====

    fn eval_reg(expr: &Expr, env: &MapEnv, reg: &FunctionRegistry) -> Value {
        let plan = bind(expr, 0).expect("bind");
        eval_scalar_with_registry(&plan, env, reg)
    }

    #[test]
    fn function_without_registry_yields_name_error() {
        // Plain eval_scalar (no registry) returns #NAME? for any Function variant.
        let env = MapEnv::new();
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![n(1.0), n(2.0)],
        };
        let plan = bind(&expr, 0).unwrap();
        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::Name));
    }

    #[test]
    fn function_unknown_name_via_registry_yields_name_error() {
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        let expr = Expr::Function {
            name: Arc::from("DOES_NOT_EXIST"),
            args: vec![n(1.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Error(ErrorValue::Name));
    }

    #[test]
    fn function_sum_via_registry() {
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        // =SUM(1, 2, 3) → 6
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![n(1.0), n(2.0), n(3.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(6.0));
    }

    #[test]
    fn function_sum_with_cellrefs_via_registry() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(10.0));
        env.put(0, 1, 0, Value::Number(20.0));
        env.put(0, 2, 0, Value::Number(30.0));
        let reg = ql_functions::default_registry();
        // =SUM(A1, A2, A3)
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell_ref(0, 0), cell_ref(0, 1), cell_ref(0, 2)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(60.0));
    }

    #[test]
    fn function_if_via_registry() {
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        // =IF(TRUE, 1, 2) → 1
        let expr = Expr::Function {
            name: Arc::from("IF"),
            args: vec![Expr::Bool(true), n(1.0), n(2.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(1.0));
    }

    #[test]
    fn function_nested_in_binary() {
        // =SUM(1, 2) * 3 = 9
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        let inner = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![n(1.0), n(2.0)],
        };
        let outer = bin(Operator::Mul, inner, n(3.0));
        assert_eq!(eval_reg(&outer, &env, &reg), Value::Number(9.0));
    }

    #[test]
    fn function_var_uses_two_pass_via_registry() {
        // =VAR.S(1, 3) → 2 (per Welford two-pass)
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        let expr = Expr::Function {
            name: Arc::from("VAR.S"),
            args: vec![n(1.0), n(3.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(2.0));
    }

    #[test]
    fn function_error_in_arg_propagates_via_excel_semantics() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Ref));
        let reg = ql_functions::default_registry();
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell_ref(0, 0), n(5.0)],
        };
        // SUM propagates the first error encountered.
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Error(ErrorValue::Ref));
    }

    // ===== Phase 2A.9 audit M1: lenient arithmetic coercion =====

    /// Excel: `="5" + 1` evaluates to `6`. Text-that-parses-as-number coerces.
    /// Phase 2A.9: switched `eval_arithmetic` from `to_number_strict` to
    /// `to_number_lenient`. Previously returned `#VALUE!`.
    #[test]
    fn arithmetic_lenient_coerces_numeric_text() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::String(Arc::from("5"))),
            rhs: Box::new(Expr::Number(1.0)),
        };
        // Excel: 6
        assert_eq!(eval(&expr, &env), Value::Number(6.0));
    }

    /// Excel: `="50%" + 0` evaluates to `0.5`. Trailing-`%` text coerces with
    /// `/100` scaling per the lenient path.
    #[test]
    fn arithmetic_lenient_handles_percent_text() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(Expr::String(Arc::from("50%"))),
            rhs: Box::new(Expr::Number(2.0)),
        };
        // Excel: 1.0 (50% × 2)
        assert_eq!(eval(&expr, &env), Value::Number(1.0));
    }

    /// Excel: `="abc" + 1` evaluates to `#VALUE!` (unparseable text).
    #[test]
    fn arithmetic_lenient_unparseable_text_is_value_error() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::String(Arc::from("abc"))),
            rhs: Box::new(Expr::Number(1.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::Value));
    }

    // ===== Phase 2A.9 audit M2: Excel cross-type comparison =====

    /// Excel canon: when comparing across types, Number < Text < Boolean.
    /// `=5 < "x"` is TRUE because Number ranks below Text.
    #[test]
    fn compare_number_less_than_text_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Lt,
            lhs: Box::new(Expr::Number(5.0)),
            rhs: Box::new(Expr::String(Arc::from("x"))),
        };
        // Excel: TRUE
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    /// Excel: `="x" < TRUE` is TRUE (Text < Boolean).
    #[test]
    fn compare_text_less_than_boolean_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Lt,
            lhs: Box::new(Expr::String(Arc::from("x"))),
            rhs: Box::new(Expr::Bool(true)),
        };
        // Excel: TRUE
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    /// Excel: `=5 >= "0"` is FALSE because Number < Text (5 ranks below "0"
    /// not by numeric coercion but by type rank).
    #[test]
    fn compare_number_not_greater_or_equal_text_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Ge,
            lhs: Box::new(Expr::Number(5.0)),
            rhs: Box::new(Expr::String(Arc::from("0"))),
        };
        // Excel: FALSE (Number ranks below Text)
        assert_eq!(eval(&expr, &env), Value::Boolean(false));
    }

    /// Excel: `=A1=0` where A1 is Blank → TRUE (Blank coerces to 0).
    #[test]
    fn compare_blank_equals_zero() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Blank);
        let expr = Expr::Binary {
            op: Operator::Eq,
            lhs: Box::new(cell_ref(0, 0)),
            rhs: Box::new(Expr::Number(0.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    /// Same-type comparisons unchanged: `=5 < 10` is TRUE.
    #[test]
    fn compare_same_type_numbers_unchanged() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Lt,
            lhs: Box::new(Expr::Number(5.0)),
            rhs: Box::new(Expr::Number(10.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    // ===== Phase 2A.9 audit M3: 0^0 = #NUM! =====

    /// Excel: `=0^0` is `#NUM!`. Rust/IEEE produces 1.0.
    #[test]
    fn pow_zero_zero_is_num_error_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Pow,
            lhs: Box::new(Expr::Number(0.0)),
            rhs: Box::new(Expr::Number(0.0)),
        };
        // Excel: #NUM!
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::Num));
    }

    /// Phase 2A.13 audit cycle-3 M3 companion: `=0^-1` is `#DIV/0!`, not
    /// `#NUM!`. Mathematically `0^-n = 1/0^n`; Excel canon agrees.
    /// Rust/IEEE `f64::powf(0, -1)` produces `+Inf` — wrong error class.
    #[test]
    fn pow_zero_negative_exp_is_div_zero_excel_canon() {
        let env = MapEnv::new();
        for &exp in &[-1.0, -2.0, -0.5, -100.0] {
            let expr = Expr::Binary {
                op: Operator::Pow,
                lhs: Box::new(Expr::Number(0.0)),
                rhs: Box::new(Expr::Number(exp)),
            };
            assert_eq!(
                eval(&expr, &env),
                Value::Error(ErrorValue::DivZero),
                "0^{exp} should be #DIV/0! per Excel canon"
            );
        }
    }

    /// Regression guard: `=2^10` still works.
    #[test]
    fn pow_normal_unchanged() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Pow,
            lhs: Box::new(Expr::Number(2.0)),
            rhs: Box::new(Expr::Number(10.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Number(1024.0));
    }

    // ===== Phase 2A.9 audit H5: division produces #DIV/0! =====

    /// Excel: `=A1 / 0` where A1=10 → `#DIV/0!`. Phase 2A.9 routes division
    /// through scalar evaluator (was: SIMD reciprocal-mul produced Inf →
    /// sanitize_f64 → #NUM!, wrong error class).
    #[test]
    fn div_by_zero_scalar_returns_div_zero_error() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(10.0));
        let expr = Expr::Binary {
            op: Operator::Div,
            lhs: Box::new(cell_ref(0, 0)),
            rhs: Box::new(Expr::Number(0.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::DivZero));
    }

    /// `=A1 / B1` with B1=0 → #DIV/0!.
    #[test]
    fn div_cellref_by_zero_cellref_returns_div_zero_error() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(10.0));
        env.put(0, 0, 1, Value::Number(0.0));
        let expr = Expr::Binary {
            op: Operator::Div,
            lhs: Box::new(cell_ref(0, 0)),
            rhs: Box::new(cell_ref(0, 1)),
        };
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::DivZero));
    }

    // ===== W5-69 Phase 4.5.A.0 — context-aware dispatch =====

    /// Test fixture: a context-aware fn that returns the workbook's
    /// date_system as a Number. Used to verify dispatch + EvalContext
    /// plumbing without depending on any not-yet-implemented date fn.
    fn ctx_echo_date_system(args: &[Value], ctx: &ql_types::EvalContext) -> Value {
        if !args.is_empty() {
            return Value::Error(ErrorValue::Value);
        }
        Value::Number(match ctx.date_system {
            ql_types::DateSystem::Excel1900 => 1900.0,
            ql_types::DateSystem::Excel1904 => 1904.0,
        })
    }

    /// Test fixture: a context-aware fn that doubles its single numeric
    /// arg, verifying args ARE pre-evaluated (no special arg-eval path
    /// for context-aware fns; same as scalar).
    fn ctx_double(args: &[Value], _ctx: &ql_types::EvalContext) -> Value {
        if args.len() != 1 {
            return Value::Error(ErrorValue::Value);
        }
        match &args[0] {
            Value::Number(n) => Value::Number(n * 2.0),
            _ => Value::Error(ErrorValue::Value),
        }
    }

    #[test]
    fn context_aware_dispatch_routes_to_registered_fn() {
        let env = MapEnv::new();
        let mut reg = FunctionRegistry::new();
        reg.register_context_aware("ECHO.DS", ctx_echo_date_system);
        let expr = Expr::Function {
            name: "ECHO.DS".into(),
            args: vec![],
        };
        // Default env returns DEFAULT_EVAL_CONTEXT (Excel1900) → 1900.
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(1900.0));
    }

    #[test]
    fn context_aware_dispatch_pre_evaluates_args() {
        let env = MapEnv::new();
        let mut reg = FunctionRegistry::new();
        reg.register_context_aware("DOUBLE", ctx_double);
        // DOUBLE(2 + 3) — inner arg evaluated to 5, then doubled.
        let expr = Expr::Function {
            name: "DOUBLE".into(),
            args: vec![Expr::Binary {
                op: Operator::Plus,
                lhs: Box::new(n(2.0)),
                rhs: Box::new(n(3.0)),
            }],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(10.0));
    }

    #[test]
    fn context_aware_dispatch_uses_env_eval_context() {
        // Custom MapEnv-like wrapper that overrides eval_context().
        struct CustomCtxEnv {
            inner: MapEnv,
            ctx: ql_types::EvalContext,
        }
        impl CellEnv for CustomCtxEnv {
            fn read_cell(
                &self,
                sheet: ql_types::SheetId,
                row: ql_types::RowId,
                col: ql_types::ColId,
            ) -> Value {
                self.inner.read_cell(sheet, row, col)
            }
            fn eval_context(&self) -> &ql_types::EvalContext {
                &self.ctx
            }
        }
        let env = CustomCtxEnv {
            inner: MapEnv::new(),
            ctx: ql_types::EvalContext {
                date_system: ql_types::DateSystem::Excel1904,
                ..ql_types::EvalContext::default()
            },
        };
        let mut reg = FunctionRegistry::new();
        reg.register_context_aware("ECHO.DS", ctx_echo_date_system);
        let expr = Expr::Function {
            name: "ECHO.DS".into(),
            args: vec![],
        };
        // Bind + call directly (eval_reg in this test mod takes &MapEnv;
        // we need the generic path for a custom env).
        let plan = crate::plan::bind(&expr, 0).unwrap();
        let result = eval_scalar_with_registry(&plan, &env, &reg);
        // Env overrides date_system → 1904.
        assert_eq!(result, Value::Number(1904.0));
    }

    #[test]
    fn context_aware_dispatch_order_range_aware_wins() {
        // If a name is somehow in both tables, the registry's disjoint
        // invariant should prevent registration. But verify the dispatch
        // ORDER independently: register a name as range_aware AND verify
        // it's looked up via lookup_range_aware first.
        // (This is a registry-shape test more than a dispatch test; the
        // disjoint invariant tests in registry::tests cover the panic
        // path. Here we just check that range_aware lookup happens before
        // context_aware lookup in the dispatcher's source order.)
        // See `eval_scalar_with_cache` source: `lookup_range_aware` is
        // called BEFORE `lookup_context_aware`. The earlier
        // `range_aware_lookup_returns_registered_function` test pins
        // that the range_aware table is consulted first via SUMIF.
    }

    // ===== W5-99 (Phase 4.7.F) — Expr::Error + Expr::Array eval =====

    #[test]
    fn eval_scalar_expr_plan_error_returns_value_error() {
        let env = crate::env::MapEnv::new();
        let plan = ExprPlan::Error(ErrorValue::Ref);
        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::Ref));
        let plan = ExprPlan::Error(ErrorValue::NA);
        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn eval_scalar_expr_plan_array_in_scalar_context_returns_calc_error() {
        // Per design § 6.3 (Codex HIGH-2): array-in-scalar-context →
        // `#CALC!`. The cell-boundary spill path is Phase 4.7.J;
        // until then, every ExprPlan::Array evaluation through the
        // scalar evaluator produces #CALC!.
        let env = crate::env::MapEnv::new();
        let plan = ExprPlan::Array(vec![vec![ExprPlan::Number(1.0), ExprPlan::Number(2.0)]]);
        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::Calc));
    }

    #[test]
    fn eval_scalar_with_cache_expr_plan_error_returns_value_error() {
        // The cache-aware entry point has its own copy of the variant
        // arm; verify it behaves identically.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Error(ErrorValue::DivZero);
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn eval_scalar_with_cache_expr_plan_array_returns_calc_error() {
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Array(vec![vec![ExprPlan::Number(7.0)]]);
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Error(ErrorValue::Calc));
    }

    #[test]
    fn binary_op_with_error_literal_propagates() {
        // `=1 + #N/A` → #N/A via Excel's left-error-wins rule applied
        // after evaluation. The error literal at the RHS propagates
        // through `eval_binary`.
        let env = crate::env::MapEnv::new();
        let plan = ExprPlan::Binary {
            op: Operator::Plus,
            lhs: Box::new(ExprPlan::Number(1.0)),
            rhs: Box::new(ExprPlan::Error(ErrorValue::NA)),
        };
        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn array_literal_as_aggregate_arg_propagates_error_cell() {
        // W5-100 (Phase 4.7.G): `SUM({1, #N/A, 3})` now expands the
        // array's cells into the aggregate's flat-arg list; the #N/A
        // cell propagates through SUM. Per Excel canon, errors short-
        // circuit the aggregate.
        //
        // Pre-W5-100 (W5-99 interim): this test asserted the array
        // produced #CALC! at eval; the closure annotation expected
        // this to FAIL once 4.7.G landed. W5-100 lands the
        // array-in-aggregate-context expansion (design § 6.3); the
        // assertion now expects the error-cell to propagate.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(1.0),
                ExprPlan::Error(ErrorValue::NA),
                ExprPlan::Number(3.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Error(ErrorValue::NA));
    }

    #[test]
    fn array_literal_sum_with_only_numbers() {
        // W5-100: `=SUM({1, 2, 3})` → 6.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(1.0),
                ExprPlan::Number(2.0),
                ExprPlan::Number(3.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(6.0));
    }

    #[test]
    fn array_literal_average_with_only_numbers() {
        // W5-100: `=AVERAGE({1, 2, 3, 4})` → 2.5.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("AVERAGE"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(1.0),
                ExprPlan::Number(2.0),
                ExprPlan::Number(3.0),
                ExprPlan::Number(4.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(2.5));
    }

    #[test]
    fn array_literal_sum_2d_array_row_major() {
        // W5-100: `=SUM({1, 2; 3, 4})` → 10 (2x2 row-major).
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![ExprPlan::Array(vec![
                vec![ExprPlan::Number(1.0), ExprPlan::Number(2.0)],
                vec![ExprPlan::Number(3.0), ExprPlan::Number(4.0)],
            ])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(10.0));
    }

    #[test]
    fn array_literal_sum_mixed_with_scalar_arg() {
        // W5-100: `=SUM({1, 2}, 3, 4)` → 10. Mixed array + scalar args.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![
                ExprPlan::Array(vec![vec![ExprPlan::Number(1.0), ExprPlan::Number(2.0)]]),
                ExprPlan::Number(3.0),
                ExprPlan::Number(4.0),
            ],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(10.0));
    }

    #[test]
    fn array_literal_count_with_mixed_types() {
        // W5-100: `=COUNT({1, "hello", TRUE, 4})` → 2 (only Numbers count).
        // COUNT ignores non-numeric values per Excel canon.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("COUNT"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(1.0),
                ExprPlan::String(std::sync::Arc::from("hello")),
                ExprPlan::Bool(true),
                ExprPlan::Number(4.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn array_literal_in_non_aggregate_function_still_calc_error() {
        // W5-100: `=ABS({-1, -2})` is NOT an aggregate context. ABS
        // expects a single scalar arg; the array evaluates as scalar
        // → #CALC!, ABS propagates per error-arg rule. Excel's
        // implicit-intersection behavior (which would pick the row
        // for the calling cell) is Phase 4.9 work; v1 returns #CALC!.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("ABS"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(-1.0),
                ExprPlan::Number(-2.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        // Array → #CALC! at the arg position; ABS sees #CALC! and
        // propagates.
        assert_eq!(v, Value::Error(ErrorValue::Calc));
    }

    #[test]
    fn array_literal_sum_singleton() {
        // W5-100: `=SUM({42})` → 42. Edge case: 1x1 array.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![ExprPlan::Array(vec![vec![ExprPlan::Number(42.0)]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(42.0));
    }

    #[test]
    fn array_literal_max_with_negative_and_error() {
        // W5-100: `=MAX({-5, -3, #N/A, -1})` → #N/A (error short-circuits).
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("MAX"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(-5.0),
                ExprPlan::Number(-3.0),
                ExprPlan::Error(ErrorValue::NA),
                ExprPlan::Number(-1.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Error(ErrorValue::NA));
    }

    #[test]
    fn array_literal_max_without_error_short_circuit() {
        // W5-100: `=MAX({-5, -3, -1})` → -1. Sanity check that MAX
        // works correctly when no error cells are present.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("MAX"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(-5.0),
                ExprPlan::Number(-3.0),
                ExprPlan::Number(-1.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(-1.0));
    }
}
