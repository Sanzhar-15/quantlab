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

use std::time::{Duration, Instant};

use ql_formula_syntax::Operator;
use ql_functions::FunctionRegistry;
use ql_types::{coercion, ArrayValue, ErrorValue, Value};

use crate::aggregate_cache::{AggregateCache, NoAggregateCache};
use crate::env::CellEnv;
use crate::eval_result::EvalResult;
use crate::plan::ExprPlan;

/// **6.4-3c (2026-05-29):** deadline bounding ONE blocking UDF call. The call
/// runs inline on the synchronous recalc thread (Model A, design §1), so this is
/// the maximum a single hung/slow UDF can stall recompute before
/// [`ql_udf::UdfWorker`] kills the worker and the cell becomes `#TIMEOUT!`.
/// v1 uses one session-wide constant; per-function / [`CancelPolicy`]-driven
/// deadlines are deferred. Lives here (the sole consumer is [`dispatch_udf`])
/// rather than on the session.
///
/// **Aggregate-stall caveat (Codex MED-2 / Opus MED-3, 6.4-3c audit):** this is
/// PER-CALL. A single `recalc_all` over N hung/slow UDF cells can block the
/// synchronous recalc thread — and the napi session `Mutex` it holds — for up to
/// `30s × N`, stalling every other JS call on that session. No deadlock (the
/// worker IPC is a separate process and never re-acquires the session lock), but
/// the aggregate stall is unbounded. An operation-level recalc budget / cancel
/// check is FILED-FORWARD for 6.4-3d alongside per-function deadlines.
const UDF_CALL_DEADLINE: Duration = Duration::from_secs(30);

/// **6.4B (item H):** operation-level UDF time budget for ONE recompute pass.
/// Without it, a pass touching N slow UDF cells could block the recalc thread for
/// up to N × [`UDF_CALL_DEADLINE`] (the "N×30s mutex stall" — design §H/I). The
/// recompute pass arms a deadline `Instant::now() + UDF_OP_BUDGET` once at the
/// start (only when a worker is attached); [`effective_udf_deadline`] then clamps
/// each call to the remaining budget and, once spent, skips the worker entirely
/// (a deterministic `#TIMEOUT!` + `udf_budget_exhausted`). 120s = 4 × the per-call
/// deadline: room for several genuinely-slow UDFs without an unbounded stall.
///
/// A session-level override (`WorkbookSession::set_udf_op_budget`) exists for
/// tests; it is not yet bound over napi (a follow-up — per-function deadlines +
/// host configurability are filed for 6.4B/later).
pub(crate) const UDF_OP_BUDGET: Duration = Duration::from_secs(120);

/// **6.4B (item H):** the effective timeout for ONE UDF call given the optional
/// operation-level budget deadline `op_deadline` and the current instant `now`.
///
/// - `None` budget (single-cell `set_formula`, tests, no recompute pass) →
///   `Some(UDF_CALL_DEADLINE)`: the per-call deadline alone, exactly as before.
/// - budget present and still open → `Some(min(UDF_CALL_DEADLINE, remaining))`.
/// - budget present and `now >= op_deadline` → `None`: **exhausted**, the caller
///   must NOT dispatch (skip → `#TIMEOUT!` + `udf_budget_exhausted`).
///
/// Pure (no clock read of its own) so the clamp/exhaustion logic is unit-testable
/// with synthetic instants.
fn effective_udf_deadline(op_deadline: Option<Instant>, now: Instant) -> Option<Duration> {
    match op_deadline {
        None => Some(UDF_CALL_DEADLINE),
        // `checked_duration_since` is `None` when `now` is later than the deadline;
        // a zero remaining (now == deadline) is also treated as exhausted.
        Some(dl) => match dl.checked_duration_since(now) {
            Some(remaining) if !remaining.is_zero() => Some(remaining.min(UDF_CALL_DEADLINE)),
            _ => None,
        },
    }
}

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
        // **W5-RT-1 (RT-V1-01):** literal range refs only reach reference-
        // aware functions; in this no-registry path there's no dispatcher
        // to consume them. Mirrors the `AggregateNameRef` precedent.
        ExprPlan::RangeRef { .. } => Value::Error(ErrorValue::Calc),
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
        // **W5-115 (Phase 4.8.F):** structured-ref in scalar context.
        // No-registry path: the legacy `eval_scalar` doesn't have access
        // to a `WorkbookEnv` with the formula cell, so `[@Col]` narrowing
        // can't fire here. Surface #CALC! (matches AggregateNameRef
        // precedent — callers needing actual semantics use
        // `eval_scalar_with_cache` which DOES narrow).
        ExprPlan::StructuredRef { .. } => Value::Error(ErrorValue::Calc),
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
            // **W5-100-AUDIT (Phase 4.7.G Sonnet closure):** dispatch
            // via `lookup_any` and match on `RegisteredFn` — one
            // HashMap lookup, one match. Pre-W5-100 the dispatcher
            // called `lookup_range_aware` → `lookup_context_aware` →
            // `lookup` in sequence (three separate HashMap lookups).
            // The unified registry storage (W5-96) made the migration
            // mechanical; doing it here lands the dispatch shape
            // needed for 4.7.J spill routing.
            use ql_functions::RegisteredFn;
            match registry.lookup_any(name) {
                Some(RegisteredFn::RangeAware(raf)) => {
                    // W5-53 (GAP-F-05 closure): range-aware functions
                    // like SUMIF need per-arg range-vs-scalar metadata
                    // that the scalar `&[Value]` contract can't carry.
                    // Build `Vec<FnArg>` with the correct variant per
                    // arg (`AggregateNameRef` → `Range(read_range)`,
                    // everything else → `Scalar(eval)`).
                    //
                    // W5-100 known gap: `ExprPlan::Array` args in
                    // range-aware functions (SUMIF / VLOOKUP / etc.)
                    // currently fall into the `Scalar(eval)` branch
                    // and produce `#CALC!`. Array-as-range-arg for
                    // range-aware functions is Phase 4.7+ work; for
                    // v1 only aggregate-context (scalar SUM/AVERAGE)
                    // arrays are supported per design § 6.3.
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
                            // **W5-116/117 (Phase 4.8.G + G.2):** structured-ref
                            // in range-aware function arg position. `[@Col]`
                            // narrows the resolved range to a single row at
                            // the formula's own cell (env.formula_cell()).
                            ExprPlan::StructuredRef {
                                resolved,
                                is_this_row,
                                ..
                            } => {
                                let r = narrow_structured_ref(*resolved, *is_this_row, env);
                                match r {
                                    Ok(range) => {
                                        let (values, rows, cols) = env.read_range_with_shape(range);
                                        fn_args.push(FnArg::Range { values, rows, cols });
                                    }
                                    Err(ev) => fn_args.push(FnArg::Scalar(Value::Error(ev))),
                                }
                            }
                            other => {
                                fn_args.push(FnArg::Scalar(eval_scalar_with_cache(
                                    other, env, registry, cache,
                                )));
                            }
                        }
                    }
                    raf(&fn_args)
                }
                Some(RegisteredFn::ContextAware(caf)) => {
                    // **W5-69 (Phase 4.5.A.0):** context-aware functions
                    // (DATE, NOW, TODAY, WEEKDAY, ...) take an extra
                    // `&EvalContext` arg. Args evaluated left-to-right
                    // exactly like the scalar path; only the function
                    // signature differs.
                    let evaluated: Vec<Value> = args
                        .iter()
                        .map(|a| eval_scalar_with_cache(a, env, registry, cache))
                        .collect();
                    caf(&evaluated, env.eval_context())
                }
                Some(RegisteredFn::Unified(uf)) => {
                    // **W5-100-AUDIT (Phase 4.7.G):** unified ABI path.
                    // No production callers from `default_registry`
                    // today; Phase 4.7.M/N register SEQUENCE / FILTER /
                    // TRANSPOSE through this tier. The arg materialization
                    // here is the minimum-viable shape: every plan arg
                    // becomes a `FunctionArg::Scalar(eval)`, EXCEPT
                    // `ExprPlan::Array` which becomes a `FunctionArg::Array`
                    // and `ExprPlan::AggregateNameRef` which becomes a
                    // `FunctionArg::Range`.
                    use ql_functions::{FunctionArg, FunctionContext, FunctionReturn};
                    let mut f_args: Vec<FunctionArg> = Vec::with_capacity(args.len());
                    for a in args {
                        match a {
                            ExprPlan::AggregateNameRef { range, .. } => {
                                let (values, rows, cols) = env.read_range_with_shape(*range);
                                f_args.push(FunctionArg::Range { values, rows, cols });
                            }
                            // **W5-116 (Phase 4.8.G):** structured-ref same
                            // shape as AggregateNameRef in unified-ABI
                            // function arg position. 4.8.G.2: `[@Col]`
                            // narrows resolved to single row.
                            ExprPlan::StructuredRef {
                                resolved,
                                is_this_row,
                                ..
                            } => {
                                let r = narrow_structured_ref(*resolved, *is_this_row, env);
                                match r {
                                    Ok(range) => {
                                        let (values, rows, cols) = env.read_range_with_shape(range);
                                        f_args.push(FunctionArg::Range { values, rows, cols });
                                    }
                                    Err(ev) => {
                                        f_args.push(FunctionArg::Scalar(Value::Error(ev)));
                                    }
                                }
                            }
                            ExprPlan::Array(rows) => {
                                // Materialize cells into an `ArrayValue`.
                                // Cells are literal-only per the W5-99
                                // binder restriction, so eval_scalar
                                // produces a clean `Value` per cell.
                                let row_count = rows.len() as u32;
                                let col_count = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
                                let mut cells: Vec<Value> =
                                    Vec::with_capacity((row_count * col_count) as usize);
                                for row in rows {
                                    for cell in row {
                                        cells.push(eval_scalar_with_cache(
                                            cell, env, registry, cache,
                                        ));
                                    }
                                }
                                let av = ql_types::ArrayValue::new(row_count, col_count, cells)
                                    .expect(
                                        "ExprPlan::Array passed binder validation; \
                                         shape should be intact",
                                    );
                                f_args.push(FunctionArg::Array(av));
                            }
                            other => {
                                f_args.push(FunctionArg::Scalar(eval_scalar_with_cache(
                                    other, env, registry, cache,
                                )));
                            }
                        }
                    }
                    let ctx = FunctionContext::new(env.eval_context());
                    let ret = uf(&f_args, &ctx);
                    match ret {
                        FunctionReturn::Scalar(v) => v,
                        // **W5-100-AUDIT:** unified-ABI array returns in
                        // SCALAR eval context are `#CALC!` per design
                        // § 6.3. The cell-boundary spill path (4.7.J)
                        // will route Unified-Array returns differently
                        // through a new `eval_at_cell_boundary` entry
                        // point that returns `EvalResult::Array`. Until
                        // then, any array-returning function called from
                        // a sub-expression position produces `#CALC!`.
                        FunctionReturn::Array(_) => Value::Error(ErrorValue::Calc),
                    }
                }
                Some(RegisteredFn::Scalar(f)) => {
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
                        // **W5-116/117 (Phase 4.8.G + G.2):** single-StructuredRef
                        // fast path. `SUM(Sales[Qty])` uses the same
                        // (range, function_name) aggregate cache key as
                        // `SUM(Sales)`. For `[@Col]` we narrow first; the
                        // cache key becomes the narrowed (single-row)
                        // range, which is still unambiguously cell-keyed.
                        [ExprPlan::StructuredRef {
                            resolved,
                            is_this_row,
                            ..
                        }] => narrow_structured_ref(*resolved, *is_this_row, env).ok(),
                        _ => None,
                    };
                    if let Some(range) = single_range_arg {
                        if crate::plan::is_aggregate_function(registry, name) {
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
                        matches!(
                            a,
                            ExprPlan::AggregateNameRef { .. }
                                | ExprPlan::Array(_)
                                | ExprPlan::StructuredRef { .. }
                        )
                    });
                    if has_range_or_array_arg && crate::plan::is_aggregate_function(registry, name)
                    {
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
                                // **W5-116/117 (Phase 4.8.G + G.2):** structured-ref
                                // in multi-range aggregate; `[@Col]` narrows.
                                ExprPlan::StructuredRef {
                                    resolved,
                                    is_this_row,
                                    ..
                                } => match narrow_structured_ref(*resolved, *is_this_row, env) {
                                    Ok(r) => flat.extend(env.read_range(r)),
                                    Err(ev) => flat.push(Value::Error(ev)),
                                },
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
                Some(RegisteredFn::ReferenceAware(rf, contract)) => {
                    // **W5-RT-1 (RT-V1-01):** reference-aware tier
                    // dispatch. Materialize each arg per the fn's
                    // `ArgContract`: `Eager` produces `RefArg::Scalar`/
                    // `Reference`/`Range`/`Array`/`Error`; `LazyShape`
                    // produces `RefArg::Shape(PlanKind)` without
                    // evaluating the arg (used by ISREF). See
                    // `ql-functions::reference_aware_fns` for the
                    // ABI definitions.
                    use ql_functions::{ArgContract, RefContext};
                    let mut ref_args: Vec<ql_functions::RefArg> = Vec::with_capacity(args.len());
                    for a in args {
                        ref_args.push(match contract {
                            ArgContract::Eager => {
                                materialize_ref_arg_eager(a, env, registry, cache)
                            }
                            ArgContract::LazyShape => materialize_ref_arg_lazy(a),
                        });
                    }
                    let ctx = RefContext::new(
                        env.eval_context(),
                        env.formula_cell_for_sref(),
                        env.reference_query(),
                    );
                    rf(&ref_args, &ctx)
                }
                // **6.4-3c (2026-05-29):** no built-in dispatch entry. Before
                // returning `#NAME?`, check the UDF table: a name registered
                // via `register_function` lives in `registry.udf_handles` (NOT
                // in `fns` — `fns` is keyed `&'static str`, UDF names are
                // runtime `String`s; see the design-doc Option-B note). Dispatch
                // it to the Python worker. SCALAR context: an array return
                // becomes `#CALC!` (mirrors the Unified arm above) — the
                // cell-boundary entry point spills it instead.
                None => match registry.udf_handle(name) {
                    Some(handle) => match marshal_udf_args(args, env, registry, cache) {
                        Ok(grid) => match dispatch_udf(handle.0, grid, env) {
                            ql_functions::FunctionReturn::Scalar(v) => v,
                            ql_functions::FunctionReturn::Array(_) => {
                                Value::Error(ErrorValue::Calc)
                            }
                        },
                        Err(ev) => Value::Error(ev),
                    },
                    None => Value::Error(ErrorValue::Name),
                },
            }
        }
        // `AggregateNameRef` outside a Function context — the binder is
        // supposed to surface `BindError::NamedRangeInScalarContext`
        // before we ever evaluate. Defensive fallback: `#CALC!`.
        ExprPlan::AggregateNameRef { .. } => Value::Error(ErrorValue::Calc),
        // **W5-RT-1 (RT-V1-01):** literal range refs only reach reference-
        // aware functions via the materializer. Outside that context
        // (e.g., a stray RangeRef arg to a non-reference-aware fn that
        // accepted it through some future change) returns #CALC!. The
        // binder gates this — `BindContext::ReferenceArg` is the only
        // context that produces `ExprPlan::RangeRef`.
        ExprPlan::RangeRef { .. } => Value::Error(ErrorValue::Calc),
        // **W5-99 (Phase 4.7.F):** error literal — return the error
        // value directly. Same shape as the no-registry `eval_scalar`
        // arm above.
        ExprPlan::Error(ev) => Value::Error(*ev),
        // **W5-99 (Phase 4.7.F):** array literal in scalar context →
        // `#CALC!` per design § 6.3. Cell-boundary detection (the spill
        // path) lands in W5-102 / Phase 4.7.J; until then, every
        // `ExprPlan::Array` evaluation produces `#CALC!`.
        ExprPlan::Array(_) => Value::Error(ErrorValue::Calc),
        // **W5-115/116/117 (Phase 4.8.F/G/G.2):** structured-ref at
        // top-level scalar context. `[@Col]` (is_this_row=true) narrows
        // to a single cell via the formula's own cell; reads that cell.
        // Multi-cell ranges (`Sales[Qty]`) surface as #CALC! per design
        // § 6.3 (same as AggregateNameRef bare-scalar position).
        ExprPlan::StructuredRef {
            resolved,
            is_this_row,
            ..
        } => match narrow_structured_ref(*resolved, *is_this_row, env) {
            Ok(range) if range.start_row == range.end_row && range.start_col == range.end_col => {
                env.read_cell(range.sheet, range.start_row, range.start_col)
            }
            Ok(_) => Value::Error(ErrorValue::Calc), // multi-cell in scalar context
            Err(ev) => Value::Error(ev),
        },
    }
}

/// **W5-117 (Phase 4.8.G.2):** narrow a `StructuredRef::resolved` range
/// to a single row for `[@Col]` forms. For non-`[@]` forms, returns the
/// range unchanged. For `[@]` forms, requires the formula's cell to be
/// inside the range's row span; if outside (e.g., `[@Qty]` typed in a
/// cell below the table), returns `#VALUE!` per Excel canon.
///
/// Cases:
/// - `is_this_row == false` → return `resolved` as-is.
/// - `is_this_row == true` + `env.formula_cell()` is `Some(addr)` with
///   `addr.row` ∈ `[resolved.start_row, resolved.end_row]` → narrow to
///   `(addr.row, addr.row, resolved.start_col, resolved.end_col)`.
/// - `is_this_row == true` + cell missing or out of range → `#VALUE!`.
fn narrow_structured_ref<E: CellEnv + ?Sized>(
    resolved: ql_types::Range,
    is_this_row: bool,
    env: &E,
) -> Result<ql_types::Range, ErrorValue> {
    if !is_this_row {
        return Ok(resolved);
    }
    // is_this_row: need cell context for the row.
    let cell = env_formula_cell(env).ok_or(ErrorValue::Value)?;
    if cell.row < resolved.start_row || cell.row > resolved.end_row {
        return Err(ErrorValue::Value);
    }
    Ok(ql_types::Range::new(
        resolved.sheet,
        cell.row,
        resolved.start_col,
        cell.row,
        resolved.end_col,
    ))
}

/// **W5-RT-1 (RT-V1-01):** eager materializer for reference-aware fns
/// using `ArgContract::Eager`. Each `ExprPlan` arg becomes a `RefArg`
/// variant per its plan shape; `Value::Error(_)` results from eval
/// surface as `RefArg::Error(ev)` for per-fn error-class propagation
/// (HIGH-F closure).
///
/// Coordinate-only path for `AggregateNameRef`/`RangeRef`/`StructuredRef`:
/// no `read_range_with_shape` call — ROWS/COLUMNS need dimensions, not
/// values, and `WorkbookEnv::read_range_with_shape` clamps to populated
/// bounds (env.rs:222) which would give wrong dimensions for
/// `ROWS(A:A)`. Values stay empty in v1; if a future iterating
/// reference-aware fn needs them, it can lazily call `read_range`.
///
/// **Step 1.1 / S1-HIGH-E note (volatile-asymmetry under dep-suppress):**
/// the fall-through `other` arm eagerly evaluates `ExprPlan::Function`
/// args via `eval_scalar_with_cache`. For dep-suppressed reference-aware
/// fns (ROW / COLUMN / ROWS / COLUMNS / ISREF — see
/// [`crate::calcgraph_session::is_address_only_reference_fn`]), the
/// walker's shape-aware policy (Step 1.1 / S1-HIGH-A closure) recurses
/// into Function arg subtrees via `walk_plan_for_address_only_deps`'s
/// fall-through. So volatile / value deps inside the fn-arg subtree DO
/// register, the formula IS marked volatile when needed, and recomputes
/// on cycles. The eager-eval of e.g. `ROW(NOW())` produces a Value that
/// the per-fn impl coerces to `#VALUE!` (Number isn't a reference);
/// wasted CPU per recompute is the acceptable v1 cost. If a future
/// Eager-contract reference-aware fn actually consumed the
/// Function-arg's value to inform its result, revisit this trade-off.
fn materialize_ref_arg_eager<E: CellEnv>(
    plan: &ExprPlan,
    env: &E,
    registry: &FunctionRegistry,
    cache: &dyn AggregateCache,
) -> ql_functions::RefArg {
    use ql_functions::RefArg;
    match plan {
        ExprPlan::CellRef {
            sheet, row, col, ..
        } => {
            // **W5-RT-3.1 (S3-HIGH-1 closure — reverts S2-HIGH-2):** emit
            // `RefArg::Reference { address }` from coordinates alone — DO
            // NOT read the cell's value here. The S2-HIGH-2 closure added
            // `env.read_cell` + error-coercion to surface missing-sheet
            // errors as `RefArg::Error`. That regressed `ISFORMULA(A1)`
            // when A1 holds a literal `#N/A` (returns `#N/A` instead of
            // FALSE) and any future fn that legitimately reads cells
            // with error values. The architecturally-correct shape — per
            // both Step 3 audits — is for the materializer to carry only
            // the address; per-fn impls call `read_cell` /
            // `is_formula_at` / `formula_text_at` directly when they
            // need the value. Missing-sheet errors are caught at bind
            // time (`BindError::UnknownSheet`); the runtime-stale-sheet
            // case S2-HIGH-2 worried about isn't reachable today (no
            // `delete_sheet` API) and a future deletion path will need
            // separate handling anyway.
            RefArg::Reference {
                address: ql_types::Address::new(*sheet, *row, *col),
            }
        }
        ExprPlan::AggregateNameRef { range, .. } => RefArg::Range {
            range: *range,
            values: vec![],
        },
        ExprPlan::RangeRef { range } => RefArg::Range {
            range: *range,
            values: vec![],
        },
        ExprPlan::StructuredRef {
            resolved,
            is_this_row,
            ..
        } => match narrow_structured_ref(*resolved, *is_this_row, env) {
            Ok(range) => RefArg::Range {
                range,
                values: vec![],
            },
            Err(ev) => RefArg::Error(ev),
        },
        ExprPlan::Array(rows) => {
            // Materialize cells into an ArrayValue (mirrors the
            // Unified-tier path at scalar.rs ~273-294).
            let row_count = rows.len() as u32;
            let col_count = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
            let mut cells: Vec<Value> = Vec::with_capacity((row_count * col_count) as usize);
            for row in rows {
                for cell in row {
                    cells.push(eval_scalar_with_cache(cell, env, registry, cache));
                }
            }
            let av = ArrayValue::new(row_count, col_count, cells)
                .expect("ExprPlan::Array passed binder validation; shape intact");
            RefArg::Array(av)
        }
        ExprPlan::Error(ev) => RefArg::Error(*ev),
        other => {
            let v = eval_scalar_with_cache(other, env, registry, cache);
            match v {
                Value::Error(ev) => RefArg::Error(ev),
                ok => RefArg::Scalar(ok),
            }
        }
    }
}

/// **W5-RT-1 (RT-V1-01):** lazy materializer for reference-aware fns
/// using `ArgContract::LazyShape`. The arg's `ExprPlan` shape is
/// translated to a `PlanKind` without any evaluation — no
/// `eval_scalar_with_cache` call, no aggregate cache touch, no
/// volatile-fn re-firing. ISREF uses this path (HIGH-B closure).
fn materialize_ref_arg_lazy(plan: &ExprPlan) -> ql_functions::RefArg {
    use ql_functions::{PlanKind, RefArg};
    let kind = match plan {
        ExprPlan::CellRef { .. } => PlanKind::CellRef,
        ExprPlan::AggregateNameRef { .. }
        | ExprPlan::RangeRef { .. }
        | ExprPlan::StructuredRef { .. } => PlanKind::RangeRef,
        // No reference-returning fns in v1 — see design § 1 out-of-scope
        // ("Reference-returning fns (OFFSET-class)"). `returns_reference`
        // stays false; ISREF on a function call returns FALSE accordingly.
        ExprPlan::Function { .. } => PlanKind::Function {
            returns_reference: false,
        },
        ExprPlan::Number(_)
        | ExprPlan::Bool(_)
        | ExprPlan::String(_)
        | ExprPlan::Array(_)
        | ExprPlan::Binary { .. }
        | ExprPlan::Unary { .. } => PlanKind::Literal,
        ExprPlan::Error(_) => PlanKind::Error,
    };
    RefArg::Shape(kind)
}

/// **W5-117 (Phase 4.8.G.2):** access the formula cell from an env if
/// the env carries one. CellEnv doesn't expose this; we downcast to the
/// concrete `WorkbookEnv` type. Other CellEnv impls (MapEnv in tests)
/// always return None.
fn env_formula_cell<E: CellEnv + ?Sized>(env: &E) -> Option<ql_types::Address> {
    // Downcast trick — only WorkbookEnv carries a formula_cell. Since
    // CellEnv is a trait without `Any`-supertrait, we use a separate
    // accessor: callers wrapping a WorkbookEnv have type info at the
    // construction site, but inside the generic eval path we don't.
    // For now expose the cell via a no-op trait method; only WorkbookEnv
    // overrides it.
    env.formula_cell_for_sref()
}
/// `EvalResult::Scalar` for every plan shape that does NOT produce an
/// array at the cell root, and `EvalResult::Array` ONLY for top-level
/// `ExprPlan::Array` (Phase 4.7.J.1) and, in future, array-returning
/// function calls (Phase 4.7.M for SEQUENCE; 4.7.N for FILTER/TRANSPOSE).
///
/// **Contract divergence from `eval_scalar_with_cache`:** the scalar
/// evaluator treats `ExprPlan::Array(_)` as array-in-scalar-context and
/// returns `Value::Error(ErrorValue::Calc)` per design § 6.3. This is
/// the correct semantics ANYWHERE an array surfaces inside an arithmetic
/// or comparison context — and it stays unchanged.
///
/// At the CELL boundary, however, an array result is a SPILL request,
/// not an error. The runtime's spill-writeback path (Phase 4.7.J.2)
/// pattern-matches on `EvalResult::Array(_)` and materializes the
/// array into per-cell computed-overlay writes. By keeping THIS
/// function the only path that returns `EvalResult::Array`, every
/// non-cell-boundary call site continues to produce `#CALC!` for
/// arrays — preserving the scalar-context contract.
///
/// **What about nested array results inside expressions?** Per § 3.3,
/// array literals at non-root positions are parser-rejected, and binder
/// validation forbids non-literal cell-plans inside `ExprPlan::Array`.
/// So at the cell boundary, only the OUTERMOST plan node can be an
/// `Array`. Any deeper subtree is normal scalar-producing code.
///
/// **Materialization detail.** Each cell-plan inside an
/// `ExprPlan::Array` is a literal (Number / Bool / String / Error) per
/// binder rules. We still route the per-cell evaluation through
/// `eval_scalar_with_cache` for uniformity — there's no shortcut here,
/// since the literal-only restriction is a binder-side invariant and
/// the evaluator stays plan-shape-agnostic.
///
/// **`ArrayValue::new` invariants.** The binder rejects
/// `ExprPlan::Array(vec![])` (`BindError::EmptyArrayLiteral`) and
/// `ExprPlan::Array(vec![vec![]])` likewise, AND row-arity mismatch
/// (`BindError::ArrayRowArityMismatch`). So when we reach this code,
/// `rows.len() >= 1`, every row has the same `>= 1` width, and the
/// flattened `cells` vec satisfies `len == rows.len() * cols`.
/// `ArrayValue::new` therefore CANNOT fail here (the only error case
/// is `CellCountMismatch`). We assert via `expect` rather than building
/// a fallback path; per the no-fallbacks rule, a binder regression
/// should panic loudly, not silently produce `#CALC!`.
pub fn eval_at_cell_boundary<E: CellEnv>(
    plan: &ExprPlan,
    env: &E,
    registry: &FunctionRegistry,
    cache: &dyn AggregateCache,
) -> EvalResult {
    match plan {
        ExprPlan::Array(rows) => {
            // Binder invariants (see doc comment): rows non-empty,
            // first row determines column count, every row matches.
            let array_rows = rows.len() as u32;
            let array_cols = rows[0].len() as u32;
            let mut cells: Vec<Value> = Vec::with_capacity(rows.len() * rows[0].len());
            for row in rows {
                for cell_plan in row {
                    cells.push(eval_scalar_with_cache(cell_plan, env, registry, cache));
                }
            }
            // `ArrayShapeError::CellCountMismatch` is unreachable from this
            // code path: binder enforces `EmptyArrayLiteral` rejection,
            // `ArrayRowArityMismatch` rejection, and `ArrayCellNotLiteral`
            // rejection — so the input `ExprPlan::Array(rows)` satisfies
            // `rows.len() >= 1`, all rows have equal width `>= 1`, and
            // every cell-plan is a literal. The flatten above pushes
            // exactly `rows.len() * rows[0].len()` cells. If this
            // `expect` ever fires, EITHER the binder validation was
            // bypassed (e.g. a direct `ExprPlan::Array(...)` constructor
            // call in tests/host code), OR `ArrayValue::new` gained a
            // new error variant. Both are upstream bugs — surface
            // loudly per CLAUDE.md no-fallbacks rule.
            let array = ArrayValue::new(array_rows, array_cols, cells).expect(
                "eval_at_cell_boundary: ArrayValue::new failed — \
                 binder validation should make CellCountMismatch \
                 unreachable; ExprPlan::Array constructed directly \
                 (bypassing binder) is the most likely cause",
            );
            EvalResult::Array(array)
        }
        // **W5-106 (Phase 4.7.M)**: top-level array-returning function
        // call. If the plan is `ExprPlan::Function` AND the registered
        // function is a Unified-tier callable (the only tier that can
        // return `FunctionReturn::Array`), dispatch HERE so an Array
        // return surfaces as `EvalResult::Array` for the spill writeback
        // path. Scalar returns flow through normally.
        //
        // Functions on non-Unified tiers (Scalar / RangeAware /
        // ContextAware) always return `Value` and can never produce an
        // Array; they take the scalar fallthrough below.
        ExprPlan::Function { name, args }
            if matches!(
                registry.lookup_any(name),
                Some(ql_functions::RegisteredFn::Unified(_))
            ) =>
        {
            // Pull out the unified fn pointer. Unwrap is safe — the
            // guard above just matched it.
            let uf = match registry.lookup_any(name) {
                Some(ql_functions::RegisteredFn::Unified(f)) => *f,
                _ => unreachable!(
                    "eval_at_cell_boundary: registry contract violated \
                     between guard and re-lookup"
                ),
            };
            // Materialize args into `FunctionArg`. Mirrors the scalar
            // dispatch path's arg construction (scalar.rs ~258-310):
            //   - `AggregateNameRef` → `FunctionArg::Range`.
            //   - `StructuredRef`     → `FunctionArg::Range` (narrowed).
            //   - `ExprPlan::Array`   → `FunctionArg::Array`.
            //   - Everything else     → `FunctionArg::Scalar(eval)`.
            use ql_functions::{FunctionArg, FunctionContext, FunctionReturn};
            let mut f_args: Vec<FunctionArg> = Vec::with_capacity(args.len());
            for a in args {
                match a {
                    ExprPlan::AggregateNameRef { range, .. } => {
                        let (values, rows, cols) = env.read_range_with_shape(*range);
                        f_args.push(FunctionArg::Range { values, rows, cols });
                    }
                    // **MEGAUDIT fix (2026-05-29; Codex-A HIGH / Opus-marshal
                    // MED):** the scalar Unified arm (scalar.rs:280-295) reads a
                    // `StructuredRef` as a `Range`, but this boundary arm was
                    // missing it — a `StructuredRef` fell to the `other` arm and
                    // was scalar-evaluated. That mis-fed `=TRANSPOSE(Table[Col])`
                    // (typed directly AND, after the 6.4-3c audit-fix routed
                    // array-capable UDF args through here, as a UDF arg). Mirror
                    // the scalar path: narrow `[@Col]`, then read the range.
                    ExprPlan::StructuredRef {
                        resolved,
                        is_this_row,
                        ..
                    } => match narrow_structured_ref(*resolved, *is_this_row, env) {
                        Ok(range) => {
                            let (values, rows, cols) = env.read_range_with_shape(range);
                            f_args.push(FunctionArg::Range { values, rows, cols });
                        }
                        Err(ev) => f_args.push(FunctionArg::Scalar(Value::Error(ev))),
                    },
                    ExprPlan::Array(rows) => {
                        let row_count = rows.len() as u32;
                        let col_count = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
                        let mut cells: Vec<Value> =
                            Vec::with_capacity((row_count * col_count) as usize);
                        for row in rows {
                            for cell in row {
                                cells.push(eval_scalar_with_cache(cell, env, registry, cache));
                            }
                        }
                        let av = ArrayValue::new(row_count, col_count, cells)
                            .expect("ExprPlan::Array passed binder validation; shape intact");
                        f_args.push(FunctionArg::Array(av));
                    }
                    other => {
                        f_args.push(FunctionArg::Scalar(eval_scalar_with_cache(
                            other, env, registry, cache,
                        )));
                    }
                }
            }
            let ctx = FunctionContext::new(env.eval_context());
            match uf(&f_args, &ctx) {
                FunctionReturn::Scalar(v) => EvalResult::Scalar(v),
                FunctionReturn::Array(a) => EvalResult::Array(a),
            }
        }
        // **W5-RT-1 (RT-V1-01) / HIGH-E + Step 1.1 S1-HIGH-B closures:** at
        // the cell boundary, ROW/COLUMN with a single multi-cell range or
        // array arg returns `#CALC!` instead of silently truncating to
        // top-left. In modern Excel-compatible workbooks `=ROW(A1:A5)`
        // typed at the cell root spills `{1;2;3;4;5}`; until v1 of the
        // spill path lands, an explicit error is the correct stance —
        // silent scalar truncation would be a wrong-result regression.
        //
        // Scalar context (e.g. `=ROW(A1:A5)+0` as a sub-expression) is
        // unaffected — the per-fn impl returns top-left there, matching
        // Excel pre-365 implicit-intersection semantics.
        //
        // **S1-HIGH-B (Codex):** the initial Step 1 guard checked only
        // RangeRef / AggregateNameRef / Array; `ROW(Sales[Qty])` bypassed
        // it because StructuredRef takes a different plan shape. Step
        // 1.1 closure adds the StructuredRef branch, narrowing first via
        // `narrow_structured_ref` so `Sales[@Qty]` (single-cell after
        // `[@]` narrowing) is NOT rejected while `Sales[Qty]` (full
        // column) IS rejected when multi-cell.
        ExprPlan::Function { name, args }
            if args.len() == 1
                && matches!(name.as_ref(), "ROW" | "COLUMN")
                && matches!(
                    registry.lookup_any(name),
                    Some(ql_functions::RegisteredFn::ReferenceAware(_, _))
                ) =>
        {
            let multi_cell = match &args[0] {
                ExprPlan::RangeRef { range } => {
                    range.start_row != range.end_row || range.start_col != range.end_col
                }
                ExprPlan::AggregateNameRef { range, .. } => {
                    range.start_row != range.end_row || range.start_col != range.end_col
                }
                ExprPlan::StructuredRef {
                    resolved,
                    is_this_row,
                    ..
                } => match narrow_structured_ref(*resolved, *is_this_row, env) {
                    Ok(range) => {
                        range.start_row != range.end_row || range.start_col != range.end_col
                    }
                    // Narrowing-error case (e.g., formula cell outside
                    // the table's data range) — defer to scalar eval to
                    // surface the error normally; not multi-cell.
                    Err(_) => false,
                },
                ExprPlan::Array(rows) => {
                    rows.len() != 1 || rows.first().map(|r| r.len()).unwrap_or(0) != 1
                }
                _ => false,
            };
            if multi_cell {
                return EvalResult::Scalar(Value::Error(ErrorValue::Calc));
            }
            EvalResult::Scalar(eval_scalar_with_cache(plan, env, registry, cache))
        }
        // **6.4-3c (2026-05-29):** top-level UDF call. A UDF can return an N×M
        // grid (the wedge — a Python function producing a table); at the cell
        // boundary that must surface as `EvalResult::Array` so the existing
        // `write_spill` writeback (recompute.rs) spills it, NOT collapse to
        // `#CALC!` (the ROW/COLUMN wrong-result lesson above). Mutually
        // exclusive with the Unified / ROW-COLUMN guards by construction:
        // `udf_handle` is `Some` ONLY for UDFs, and those guards' `lookup_any`
        // returns `None` for a UDF (a name is never both a built-in and a UDF —
        // `register_udf`'s Conflict check enforces it). Must precede `_`.
        // (Opus LOW-3, 6.4-3c audit: that invariant relies on every built-in in
        // `fns` having metadata, which `default_registry`'s boot-time assert
        // guarantees; a hand-built registry that inserts a `fns` entry WITHOUT
        // metadata and then `register_udf`s the same name could populate both
        // tables — there the built-in guards still win, so no wrong result, but
        // the exclusivity is construction-dependent, not structural.)
        ExprPlan::Function { name, args } if registry.udf_handle(name).is_some() => {
            let handle = registry
                .udf_handle(name)
                .expect("guard above matched udf_handle(name).is_some()");
            match marshal_udf_args(args, env, registry, cache) {
                Ok(grid) => match dispatch_udf(handle.0, grid, env) {
                    ql_functions::FunctionReturn::Scalar(v) => EvalResult::Scalar(v),
                    ql_functions::FunctionReturn::Array(a) => EvalResult::Array(a),
                },
                Err(ev) => EvalResult::Scalar(Value::Error(ev)),
            }
        }
        _ => EvalResult::Scalar(eval_scalar_with_cache(plan, env, registry, cache)),
    }
}

/// **6.4-3c (2026-05-29):** marshal a UDF call's evaluated arguments into the
/// SINGLE `ArrayValue` the wire protocol carries (`ql_udf::CallPayload.args`).
/// The v1 shape rule (design §3 + the 6.4-3c plan; the worker receives one grid):
///   - N scalar args → a 1×N row grid (a single scalar arg → 1×1).
///   - exactly ONE grid arg → that arg's full grid (its native shape).
///   - mixed scalar+grid, OR ≥2 grid args → `Err(#VALUE!)` — these can't
///     be expressed in one rectangular grid; a richer args protocol (list-of-
///     grids) is deferred. The limitation is a VISIBLE `#VALUE!`, never silent.
///
/// **Classification is by RUNTIME shape, not plan shape** (CODEX-HIGH-1, 6.4-3c
/// 3-way audit). A "grid" arg is a range reference (`AggregateNameRef` /
/// `RangeRef` / `StructuredRef`), a literal array (`{1,2}`), OR a function call
/// that actually PRODUCES an array at runtime — a Unified-tier built-in (the
/// only built-in tier that can return `FunctionReturn::Array`, e.g.
/// `SEQUENCE(2,2)`) or a nested UDF that returns a grid. Those function args are
/// evaluated through [`eval_at_cell_boundary`] so their `Array` return is
/// preserved; without this they would fall to scalar eval, which collapses an
/// array to `#CALC!`, and the UDF would silently receive a 1×1 error grid
/// instead of the table the user wrote. Everything else (cell refs, literals,
/// arithmetic, and non-array built-ins INCLUDING `ROW`/`COLUMN` — `ReferenceAware`,
/// not `Unified` — which keep their implicit-intersection scalar semantics at a
/// UDF arg) is a scalar.
///
/// A `StructuredRef` whose `[@]` narrowing fails surfaces its error as `Err`.
///
/// **Error-valued args are forwarded** (Opus MED, 6.4-3c audit — intentional):
/// `=MYUDF(1/0)` packs `#DIV/0!` into the grid and sends it to Python, matching
/// Excel, where a UDF receives error values as arguments and may handle them
/// (e.g. an `IFERROR`-style UDF). It is NOT short-circuited to the error.
///
/// Range-shaped args reach here per the UDF's registered `ArgContext`: an
/// Aggregate-context UDF binds `=MYUDF(SomeRange)` to `AggregateNameRef`
/// (session.rs `register_function_with_aggregate_arg_context_admits_named_range_args`).
fn marshal_udf_args<E: CellEnv>(
    args: &[ExprPlan],
    env: &E,
    registry: &FunctionRegistry,
    cache: &dyn AggregateCache,
) -> Result<ArrayValue, ErrorValue> {
    // One evaluated argument: either a single value or a full grid, decided by
    // RUNTIME shape (see the fn doc — CODEX-HIGH-1 audit fix).
    enum Arg {
        Scalar(Value),
        Grid(ArrayValue),
    }

    fn eval_arg<E: CellEnv>(
        a: &ExprPlan,
        env: &E,
        registry: &FunctionRegistry,
        cache: &dyn AggregateCache,
    ) -> Result<Arg, ErrorValue> {
        match a {
            ExprPlan::AggregateNameRef { range, .. } | ExprPlan::RangeRef { range } => {
                let (values, rows, cols) = env.read_range_with_shape(*range);
                Ok(Arg::Grid(
                    ArrayValue::new(rows as u32, cols as u32, values)
                        .map_err(|_| ErrorValue::Value)?,
                ))
            }
            ExprPlan::StructuredRef {
                resolved,
                is_this_row,
                ..
            } => {
                let range = narrow_structured_ref(*resolved, *is_this_row, env)?;
                let (values, rows, cols) = env.read_range_with_shape(range);
                Ok(Arg::Grid(
                    ArrayValue::new(rows as u32, cols as u32, values)
                        .map_err(|_| ErrorValue::Value)?,
                ))
            }
            ExprPlan::Array(rows) => {
                let row_count = rows.len() as u32;
                let col_count = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
                let mut cells: Vec<Value> =
                    Vec::with_capacity((row_count as usize) * (col_count as usize));
                for row in rows {
                    for cell in row {
                        cells.push(eval_scalar_with_cache(cell, env, registry, cache));
                    }
                }
                Ok(Arg::Grid(
                    ArrayValue::new(row_count, col_count, cells).map_err(|_| ErrorValue::Value)?,
                ))
            }
            // Array-CAPABLE function: a Unified-tier built-in (the only built-in
            // tier that can return an Array) or a nested UDF. Evaluate at the
            // cell boundary so an Array return is preserved, not scalarized to
            // `#CALC!`. A scalar return (e.g. `SUM(..)`, or a UDF returning 1×1)
            // flows through as a scalar — no behavior change.
            ExprPlan::Function { name, .. }
                if matches!(
                    registry.lookup_any(name),
                    Some(ql_functions::RegisteredFn::Unified(_))
                ) || registry.udf_handle(name).is_some() =>
            {
                match eval_at_cell_boundary(a, env, registry, cache) {
                    EvalResult::Scalar(v) => Ok(Arg::Scalar(v)),
                    EvalResult::Array(av) => Ok(Arg::Grid(av)),
                }
            }
            // Plain scalar arg.
            other => Ok(Arg::Scalar(eval_scalar_with_cache(
                other, env, registry, cache,
            ))),
        }
    }

    let mut evaluated: Vec<Arg> = Vec::with_capacity(args.len());
    for a in args {
        evaluated.push(eval_arg(a, env, registry, cache)?);
    }
    let n_grid = evaluated
        .iter()
        .filter(|a| matches!(a, Arg::Grid(_)))
        .count();

    // All scalar (incl. the zero-arg case → a 1×0 row): pack a 1×N row.
    if n_grid == 0 {
        let cells: Vec<Value> = evaluated
            .into_iter()
            .map(|a| match a {
                Arg::Scalar(v) => v,
                Arg::Grid(_) => unreachable!("n_grid==0 ⇒ no Grid args"),
            })
            .collect();
        return Ok(ArrayValue::row(cells));
    }

    // Exactly one grid arg AND it is the only arg → its native grid.
    if n_grid == 1 && evaluated.len() == 1 {
        return match evaluated.into_iter().next() {
            Some(Arg::Grid(g)) => Ok(g),
            _ => unreachable!("n_grid==1 && len==1 ⇒ the sole arg is a Grid"),
        };
    }

    // Mixed scalar+grid, or ≥2 grid args: can't fit one rectangular grid →
    // VISIBLE `#VALUE!`, never a silent scalarization. (list-of-grids deferred.)
    Err(ErrorValue::Value)
}

/// **6.4-3c (2026-05-29):** dispatch ONE UDF call to the session-injected
/// out-of-process Python worker (reached via `env.udf_worker()`), mapping the
/// result / [`ql_udf::UdfError`] to a [`ql_functions::FunctionReturn`].
///
/// **Panic-free by contract:** every `UdfError` maps to a cell error value, so a
/// UDF failure can NEVER trip the recompute `FaultGuard` that seals the session
/// (6.1C M3 / design §5 — worker death is leaf I/O, a cell error, not an engine
/// fault). A registered UDF with NO worker configured is a deterministic
/// `#CALC!` (No-Fallbacks-honest: a visible error, never a silent no-op or panic).
///
/// The `RefCell` borrow is taken only here, AFTER `marshal_udf_args` finished
/// evaluating every arg — so a nested `=MYUDF(MYUDF2(A1))` released its inner
/// borrow before this outer one. The borrow is held across the single blocking
/// IPC round-trip, which never re-enters eval (the worker is a leaf).
fn dispatch_udf<E: CellEnv>(
    handle: u64,
    args_grid: ArrayValue,
    env: &E,
) -> ql_functions::FunctionReturn {
    use ql_functions::FunctionReturn;
    let Some(worker_cell) = env.udf_worker() else {
        // Registered, but no worker wired to this session → can't compute.
        // **6.4-3d (blocker G):** record WHY as a structured diagnostic
        // (additive — the cell value is still `#CALC!`); distinguishes
        // no-worker from a Python raise / worker death for the IDE.
        push_udf_cell_diagnostic(
            env,
            "udf_no_worker",
            "no Python worker is configured for this session".to_string(),
        );
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Calc));
    };
    // **6.4B (item H):** operation-level budget gate. If this recompute pass has
    // already spent its UDF time budget, SKIP the call — a deterministic `#TIMEOUT!`
    // + `udf_budget_exhausted` diagnostic — rather than block the recalc thread for
    // another full per-call deadline (the N×30s stall). Otherwise the call's timeout
    // is clamped to the remaining budget so a mid-pass overrun is killed at the op
    // deadline (worker-kill IS the cancel under GIL-only Python), not 30s later.
    let Some(effective) = effective_udf_deadline(env.udf_op_deadline(), Instant::now()) else {
        push_udf_cell_diagnostic(
            env,
            "udf_budget_exhausted",
            "recompute UDF time budget exhausted before this cell; not dispatched".to_string(),
        );
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Timeout));
    };
    let mut worker = worker_cell.borrow_mut();
    match worker.call(handle, &args_grid, effective) {
        Ok(grid) => {
            if grid.rows() == 1 && grid.cols() == 1 {
                // 1×1 result → a scalar cell value. `get(0,0)` on a grid we just
                // confirmed is 1×1 is always `Some`; a `None` here would mean an
                // internally-inconsistent `ArrayValue` from the worker. Surface it
                // as a VISIBLE `#CALC!` (No-Fallbacks), NOT a silent `Blank` (Opus
                // LOW-1, 6.4-3c audit) — AND emit a diagnostic saying WHY, mirroring
                // the `Err` arm below so the invariant violation is never silent
                // (6.4B closure-audit LOW, Codex).
                FunctionReturn::Scalar(match grid.get(0, 0).cloned() {
                    Some(v) => v,
                    None => {
                        push_udf_cell_diagnostic(
                            env,
                            "udf_protocol",
                            "worker returned a 1x1 grid with no cell at (0,0) — \
                             internally-inconsistent ArrayValue"
                                .to_string(),
                        );
                        Value::Error(ErrorValue::Calc)
                    }
                })
            } else {
                // N×M (incl. degenerate) → an array; the cell-boundary caller
                // spills it, the scalar-context caller maps it to `#CALC!`.
                FunctionReturn::Array(grid)
            }
        }
        Err(e) => {
            // **6.4-3d (blocker G):** emit a structured diagnostic alongside
            // the cell error value (the value mapping is unchanged — still
            // `#TIMEOUT!`/`#CALC!`).
            let (code, message) = udf_error_diagnostic(&e);
            push_udf_cell_diagnostic(env, code, message);
            FunctionReturn::Scalar(Value::Error(map_udf_error(&e)))
        }
    }
}

/// **6.4-3d (2026-05-29; megaudit blocker G):** push a [`UdfCellDiagnostic`] for
/// the current formula cell into the env's per-recompute collector (a no-op when
/// the env carries no collector or no formula cell). Keyed by the formula's own
/// address (`env_formula_cell`), which the recompute / `set_formula` env sites
/// always set.
fn push_udf_cell_diagnostic<E: CellEnv + ?Sized>(env: &E, code: &'static str, message: String) {
    if let Some(addr) = env_formula_cell(env) {
        env.push_udf_diagnostic(crate::env::UdfCellDiagnostic {
            addr,
            code,
            message,
        });
    }
}

/// **6.4-3d (2026-05-29; megaudit blocker G):** map a [`ql_udf::UdfError`] to a
/// stable diagnostic `code` + a human-readable `message`. Parallels
/// [`map_udf_error`] (which maps to the cell VALUE); this maps to the structured
/// `CellDiagnostic` detail so the IDE can show WHY a UDF failed (exit test 7).
fn udf_error_diagnostic(e: &ql_udf::UdfError) -> (&'static str, String) {
    use ql_udf::UdfError;
    match e {
        UdfError::Raised { exc_type, message } => ("udf_raised", format!("{exc_type}: {message}")),
        UdfError::Timeout(d) => (
            "udf_timeout",
            format!("UDF call exceeded its deadline ({d:?})"),
        ),
        UdfError::Cancelled => ("udf_cancelled", "UDF call cancelled".to_string()),
        UdfError::Handshake { expected, got } => (
            "udf_handshake",
            format!("worker handshake failed: protocol mismatch (engine {expected}, worker {got})"),
        ),
        UdfError::Protocol(m) => ("udf_protocol", format!("worker protocol violation: {m}")),
        UdfError::WorkerDied(m) => (
            "udf_worker_died",
            format!("Python worker died / transport broken: {m}"),
        ),
        // **6.4B (item I):** a cap breach is its own code so the IDE can say "grid
        // too large" rather than a generic codec error; the cell value is `#VALUE!`.
        UdfError::Codec(c) if is_grid_too_large(c) => (
            "udf_grid_too_large",
            format!("UDF grid exceeds a resource cap: {c}"),
        ),
        UdfError::Codec(c) => ("udf_codec", format!("UDF argument/return codec error: {c}")),
    }
}

/// **6.4B (item I):** distinguish a grid cap breach ([`CodecError::GridTooManyCells`]
/// / [`CodecError::GridTooManyBytes`]) from a malformed-bytes codec error. Cap
/// breaches map to `#VALUE!` + `udf_grid_too_large`; other codec errors stay
/// `#CALC!` + `udf_codec`.
///
/// [`CodecError::GridTooManyCells`]: ql_udf::codec::CodecError::GridTooManyCells
/// [`CodecError::GridTooManyBytes`]: ql_udf::codec::CodecError::GridTooManyBytes
fn is_grid_too_large(c: &ql_udf::codec::CodecError) -> bool {
    matches!(
        c,
        ql_udf::codec::CodecError::GridTooManyCells { .. }
            | ql_udf::codec::CodecError::GridTooManyBytes { .. }
    )
}

/// **6.4-3c (2026-05-29):** map a [`ql_udf::UdfError`] to a deterministic cell
/// error value. v1 is coarse: only `Timeout` → `#TIMEOUT!`; everything else
/// (`Raised`/`Cancelled`/`Handshake`/`Protocol`/`WorkerDied`/`Codec`) → `#CALC!`.
/// This maps only the cell VALUE; the structured `CellDiagnostic` that
/// distinguishes the variants (no-worker / raise / death — exit test 7's target)
/// is emitted ADDITIONALLY by [`dispatch_udf`] via [`udf_error_diagnostic`] +
/// [`push_udf_cell_diagnostic`] (6.4-3d, megaudit blocker G).
fn map_udf_error(e: &ql_udf::UdfError) -> ErrorValue {
    match e {
        ql_udf::UdfError::Timeout(_) => ErrorValue::Timeout,
        // **6.4B (item I):** a grid breaching the cell/byte cap is a sizing error
        // in the UDF's args or result → `#VALUE!`, distinct from the generic codec
        // `#CALC!`. (Paired with the `udf_grid_too_large` diagnostic below.)
        ql_udf::UdfError::Codec(c) if is_grid_too_large(c) => ErrorValue::Value,
        // Adding a new `UdfError` variant? Reconsider this wildcard before it
        // silently maps to `#CALC!` — a future variant (e.g. a memory-limit
        // breach) may warrant a distinct cell value. The companion
        // `udf_error_diagnostic` IS exhaustive (no wildcard), so a new variant is
        // a compile error THERE — that break is the prompt to revisit this arm.
        _ => ErrorValue::Calc,
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
    use std::sync::{Arc, LazyLock};

    use super::*;
    use crate::env::MapEnv;
    use crate::plan::bind;
    use ql_formula_syntax::{CellAddr, Expr, SheetRef};

    /// **6.4-1 (2026-05-28; H1):** shared default registry for binder calls
    /// in these tests. Lazily constructed (one-time builtin-metadata pop).
    static TEST_REGISTRY: LazyLock<FunctionRegistry> =
        LazyLock::new(ql_functions::default_registry);

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
        let plan = bind(expr, 0, &TEST_REGISTRY).expect("bind");
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
        let plan = bind(expr, 0, &TEST_REGISTRY).expect("bind");
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
        let plan = bind(&expr, 0, &TEST_REGISTRY).unwrap();
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
        let plan = crate::plan::bind(&expr, 0, &TEST_REGISTRY).unwrap();
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

    // W5-100-AUDIT (Sonnet closure): additional aggregate coverage.

    #[test]
    fn array_literal_product_with_only_numbers() {
        // L2 — `=PRODUCT({2, 3, 4})` → 24. Multiplicative aggregate
        // path is structurally identical to SUM but worth pinning.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("PRODUCT"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(2.0),
                ExprPlan::Number(3.0),
                ExprPlan::Number(4.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(24.0));
    }

    #[test]
    fn array_literal_counta_with_mixed_types() {
        // L3 — `=COUNTA({1, "hi", TRUE, #N/A})` — COUNTA counts non-
        // blank cells. Pins the W5-100 documented assumption that
        // error cells count as non-blank.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("COUNTA"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(1.0),
                ExprPlan::String(std::sync::Arc::from("hi")),
                ExprPlan::Bool(true),
                ExprPlan::Error(ErrorValue::NA),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(4.0));
    }

    #[test]
    fn array_literal_nested_aggregate_sum_of_sum() {
        // L5 — `=SUM(SUM({5}), {1, 2, 3})` = SUM(5, {1,2,3}) =
        // 5 + 6 = 11. Nested aggregate calls: outer SUM sees a
        // mixture of scalar (from inner SUM eval) + array literal.
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let inner_sum = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![ExprPlan::Array(vec![vec![ExprPlan::Number(5.0)]])],
        };
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUM"),
            args: vec![
                inner_sum,
                ExprPlan::Array(vec![vec![
                    ExprPlan::Number(1.0),
                    ExprPlan::Number(2.0),
                    ExprPlan::Number(3.0),
                ]]),
            ],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        assert_eq!(v, Value::Number(11.0));
    }

    #[test]
    fn array_literal_in_range_aware_function_still_calc_error() {
        // L4 / W5-100-AUDIT — SUMPRODUCT is range-aware; the W5-100
        // range-aware dispatch arm DOES NOT yet handle `ExprPlan::Array`
        // args. Per the new comment in the RangeAware match arm:
        // array-as-range-arg for range-aware functions is Phase 4.7+
        // (or later) work; only aggregate-context (scalar SUM /
        // AVERAGE / etc.) arrays are supported per design § 6.3.
        //
        // Pin this interim behavior so a future array-aware range-
        // aware dispatch lands as a FAILing test that triggers the
        // assertion update — same migration-trigger pattern as the
        // W5-99 → W5-100 transition for SUM({1,#N/A,3}).
        let env = crate::env::MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: std::sync::Arc::from("SUMPRODUCT"),
            args: vec![ExprPlan::Array(vec![vec![
                ExprPlan::Number(1.0),
                ExprPlan::Number(2.0),
                ExprPlan::Number(3.0),
            ]])],
        };
        let v = eval_scalar_with_cache(&plan, &env, &registry, &cache);
        // Interim: SUMPRODUCT sees the array as `FnArg::Scalar(#CALC!)`
        // and propagates the error.
        assert_eq!(v, Value::Error(ErrorValue::Calc));
    }

    // ===== W5-103 (Phase 4.7.J.1) — eval_at_cell_boundary =====

    /// Scalar plans pass straight through as `EvalResult::Scalar`. The
    /// boundary entry point delegates to `eval_scalar_with_cache` for
    /// every non-Array plan shape.
    #[test]
    fn eval_at_cell_boundary_scalar_plan_returns_scalar() {
        let env = MapEnv::new();
        let registry = FunctionRegistry::default();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Number(7.5);
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        assert_eq!(r, EvalResult::Scalar(Value::Number(7.5)));
    }

    /// `{1,2;3,4}` materializes a 2×2 ArrayValue at the cell boundary.
    /// Same plan through `eval_scalar_with_cache` would yield `#CALC!`
    /// (scalar-context contract); the boundary entry point routes
    /// Array plans differently.
    #[test]
    fn eval_at_cell_boundary_2x2_array_literal_returns_array_value() {
        let env = MapEnv::new();
        let registry = FunctionRegistry::default();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Array(vec![
            vec![ExprPlan::Number(1.0), ExprPlan::Number(2.0)],
            vec![ExprPlan::Number(3.0), ExprPlan::Number(4.0)],
        ]);
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        match r {
            EvalResult::Array(a) => {
                assert_eq!(a.rows(), 2);
                assert_eq!(a.cols(), 2);
                assert_eq!(a.cells().len(), 4);
                assert_eq!(a.at(0, 0), &Value::Number(1.0));
                assert_eq!(a.at(0, 1), &Value::Number(2.0));
                assert_eq!(a.at(1, 0), &Value::Number(3.0));
                assert_eq!(a.at(1, 1), &Value::Number(4.0));
            }
            EvalResult::Scalar(v) => panic!("expected array, got Scalar({:?})", v),
        }
    }

    /// 1×1 array does NOT auto-scalarize. Spill writeback at the runtime
    /// (Phase 4.7.J.2) decides what to do with a 1×1 — Excel's behavior
    /// is to spill it (single-cell spill), but THIS function's contract
    /// is purely "did the plan produce an array, yes/no." Auto-scalarizing
    /// here would mask that distinction from the runtime.
    #[test]
    fn eval_at_cell_boundary_1x1_array_stays_array() {
        let env = MapEnv::new();
        let registry = FunctionRegistry::default();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Array(vec![vec![ExprPlan::Number(42.0)]]);
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        assert!(r.is_array(), "1×1 must remain Array at the boundary");
    }

    /// Per-cell errors inside the array materialize into the
    /// `ArrayValue` as `Value::Error(_)` — they do NOT short-circuit
    /// the surrounding array. (Excel ranks per-cell errors at the same
    /// level as per-cell numbers; the array as a whole is still an
    /// array.)
    #[test]
    fn eval_at_cell_boundary_array_with_error_cell_preserves_error_per_cell() {
        let env = MapEnv::new();
        let registry = FunctionRegistry::default();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Array(vec![vec![
            ExprPlan::Number(1.0),
            ExprPlan::Error(ErrorValue::DivZero),
        ]]);
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        match r {
            EvalResult::Array(a) => {
                assert_eq!(a.at(0, 0), &Value::Number(1.0));
                assert_eq!(a.at(0, 1), &Value::Error(ErrorValue::DivZero));
            }
            EvalResult::Scalar(v) => panic!("expected array, got Scalar({:?})", v),
        }
    }

    /// `ExprPlan::Function` returning a SCALAR keeps the `Scalar` boundary
    /// result. (Array-returning functions land in 4.7.M/N; this test
    /// pins that the dispatch path doesn't accidentally promote a scalar
    /// function call to an Array.)
    #[test]
    fn eval_at_cell_boundary_function_returning_scalar_stays_scalar() {
        let env = MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        // SUM(1, 2, 3) — registered SUM produces a single Number.
        let plan = ExprPlan::Function {
            name: Arc::from("SUM"),
            args: vec![
                ExprPlan::Number(1.0),
                ExprPlan::Number(2.0),
                ExprPlan::Number(3.0),
            ],
        };
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        assert_eq!(r, EvalResult::Scalar(Value::Number(6.0)));
    }

    // ===== W5-106 (Phase 4.7.M) — SEQUENCE at the cell boundary =====

    /// `=SEQUENCE(3)` at the cell boundary materializes as
    /// `EvalResult::Array(ArrayValue(3, 1, [1, 2, 3]))`. Unified-tier
    /// function dispatch must surface `FunctionReturn::Array` as
    /// `EvalResult::Array` (not `EvalResult::Scalar(#CALC!)`, which is
    /// the scalar-context fallback).
    #[test]
    fn eval_at_cell_boundary_sequence_returns_array() {
        let env = MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: Arc::from("SEQUENCE"),
            args: vec![ExprPlan::Number(3.0)],
        };
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        match r {
            EvalResult::Array(a) => {
                assert_eq!(a.rows(), 3);
                assert_eq!(a.cols(), 1);
                assert_eq!(a.at(0, 0), &Value::Number(1.0));
                assert_eq!(a.at(1, 0), &Value::Number(2.0));
                assert_eq!(a.at(2, 0), &Value::Number(3.0));
            }
            EvalResult::Scalar(v) => panic!("expected Array, got Scalar({:?})", v),
        }
    }

    /// `=SEQUENCE(2, 2)` materializes as `Array(2, 2, [1,2,3,4])`.
    #[test]
    fn eval_at_cell_boundary_sequence_2x2_returns_array() {
        let env = MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: Arc::from("SEQUENCE"),
            args: vec![ExprPlan::Number(2.0), ExprPlan::Number(2.0)],
        };
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        match r {
            EvalResult::Array(a) => {
                assert_eq!(a.rows(), 2);
                assert_eq!(a.cols(), 2);
                assert_eq!(a.cells().len(), 4);
            }
            EvalResult::Scalar(v) => panic!("expected Array, got Scalar({:?})", v),
        }
    }

    /// `SEQUENCE` in a non-cell-boundary context (e.g. inside a binary
    /// op like `SEQUENCE(3) + 1`) takes the scalar-context path and
    /// produces `#CALC!`. Pins that the cell-boundary array surfacing
    /// is INTENTIONALLY top-level only.
    #[test]
    fn sequence_in_scalar_subexpression_produces_calc_error() {
        let env = MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        // SEQUENCE(3) + 1 — outer is Binary, SEQUENCE is the lhs.
        // eval_at_cell_boundary delegates non-Array non-Function plans
        // to eval_scalar_with_cache, which sees the Function inside
        // Binary and dispatches it through the scalar arm (returning
        // #CALC! for the Array return per design § 6.3).
        let plan = ExprPlan::Binary {
            op: ql_formula_syntax::Operator::Plus,
            lhs: Box::new(ExprPlan::Function {
                name: Arc::from("SEQUENCE"),
                args: vec![ExprPlan::Number(3.0)],
            }),
            rhs: Box::new(ExprPlan::Number(1.0)),
        };
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        // Binary op with one #CALC! operand propagates #CALC!.
        assert_eq!(r, EvalResult::Scalar(Value::Error(ErrorValue::Calc)));
    }

    /// `=SEQUENCE(0)` returns scalar `#NUM!` per design § 13.1
    /// (W5-108 / Phase 4.7.O Codex M2 closure). Pre-fix returned a
    /// degenerate ArrayValue which the writeback path mapped to
    /// `#CALC!`; design says Excel canon is `#NUM!` for `rows < 1`.
    #[test]
    fn eval_at_cell_boundary_sequence_zero_returns_num_error() {
        let env = MapEnv::new();
        let registry = ql_functions::default_registry();
        let cache = NoAggregateCache;
        let plan = ExprPlan::Function {
            name: Arc::from("SEQUENCE"),
            args: vec![ExprPlan::Number(0.0)],
        };
        let r = eval_at_cell_boundary(&plan, &env, &registry, &cache);
        match r {
            EvalResult::Scalar(Value::Error(ErrorValue::Num)) => {}
            other => panic!("expected Scalar(#NUM!), got {other:?}"),
        }
    }

    // ---- 6.4B (items H + I): UDF hardening unit tests ----

    /// **6.4B (item H):** the pure budget clamp/exhaustion logic.
    #[test]
    fn effective_udf_deadline_no_budget_yields_per_call() {
        let now = Instant::now();
        assert_eq!(effective_udf_deadline(None, now), Some(UDF_CALL_DEADLINE));
    }

    #[test]
    fn effective_udf_deadline_clamps_to_remaining_below_per_call() {
        let t0 = Instant::now();
        // 5s remaining < 30s per-call -> clamp to ~5s.
        assert_eq!(
            effective_udf_deadline(Some(t0 + Duration::from_secs(5)), t0),
            Some(Duration::from_secs(5))
        );
    }

    #[test]
    fn effective_udf_deadline_caps_at_per_call_when_remaining_larger() {
        let t0 = Instant::now();
        // 100s remaining > 30s per-call -> per-call wins.
        assert_eq!(
            effective_udf_deadline(Some(t0 + Duration::from_secs(100)), t0),
            Some(UDF_CALL_DEADLINE)
        );
    }

    #[test]
    fn effective_udf_deadline_spent_budget_is_exhausted() {
        let t0 = Instant::now();
        // past the deadline -> None (skip).
        assert_eq!(
            effective_udf_deadline(Some(t0), t0 + Duration::from_secs(1)),
            None
        );
        // exactly at the deadline (zero remaining) -> None.
        assert_eq!(effective_udf_deadline(Some(t0), t0), None);
    }

    /// **6.4B (item I):** a grid cap breach maps to #VALUE! + udf_grid_too_large;
    /// other codec errors stay #CALC! + udf_codec.
    #[test]
    fn grid_too_large_maps_to_value_error_and_diagnostic() {
        use ql_udf::codec::CodecError;
        for err in [
            CodecError::GridTooManyCells { cells: 10, max: 5 },
            CodecError::GridTooManyBytes { bytes: 100, max: 8 },
        ] {
            let e = ql_udf::UdfError::Codec(err);
            assert_eq!(map_udf_error(&e), ErrorValue::Value);
            assert_eq!(udf_error_diagnostic(&e).0, "udf_grid_too_large");
        }
        let other = ql_udf::UdfError::Codec(CodecError::Empty);
        assert_eq!(map_udf_error(&other), ErrorValue::Calc);
        assert_eq!(udf_error_diagnostic(&other).0, "udf_codec");
    }
}
