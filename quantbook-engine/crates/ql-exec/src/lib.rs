//! `ql-exec` — Quantbook expression executor.
//!
//! Module map (Phase 0 → Phase 3.10 + Phase 4.3 V1):
//!
//! - `plan.rs` (Phase 0 W4-1; extended Phase 2A.1, 2A.6, 2B.4) — `ExprPlan` IR
//!   including the Phase 2B.4 `AggregateNameRef` variant; `bind` /
//!   `bind_with_names` resolvers with Phase 2B.4 context-aware binding
//!   (`BindContext` + `is_aggregate_function`); `NameLookup` trait;
//!   `BindError` variants including `UnresolvedName`,
//!   `NamedTargetIs{Blank,Error}`, `NamedRangeInScalarContext`,
//!   `NamedFormulaUnsupported`, `UnsupportedVariant`.
//! - `plan_cache.rs` (Phase 2B.3) — bind-plan cache V0 keyed by
//!   (formula text, sheet, NameTable generation); `PlanCache` lives on
//!   `WorkbookRuntime`; `PlanCacheStats` for ql-profile observability.
//! - `env.rs` (Phase 0; extended Phase 3.6 for `read_range`) —
//!   `CellEnv` trait + `WorkbookEnv` / `MapEnv` impls. Phase 3.6
//!   added `read_range(Range) -> Vec<Value>` with WorkbookEnv
//!   override that clamps to `Sheet::bounds` for whole-column
//!   safety. `NameLookup for NameTable` bridge.
//! - `scalar.rs` (Phase 0 W4-1; extended Phase 2A.9, 2B.4, 3.6) —
//!   `eval_scalar` per-cell evaluator with Excel-canon arithmetic,
//!   error propagation, coercion. Phase 3.6 added
//!   `eval_scalar_with_cache` entry point that routes aggregate-
//!   over-named-range calls through an `AggregateCache` for cache-
//!   hit short-circuit. `AggregateNameRef` outside a Function
//!   context returns `#CALC!` defensively (binder normally rejects).
//! - `aggregate_cache.rs` (Phase 3.6 W5-39) — `AggregateCache`
//!   trait + `InMemAggregateCache` (RefCell-backed for `&self`
//!   stores) + `NoAggregateCache` no-op default. Stats counters
//!   (hits, misses, invalidations). Used by `CalcgraphSession`.
//! - `simd.rs` (Phase 0 W4-2/W4-3) — `multiversion`-dispatched SIMD kernels;
//!   OG-02 25M-cell hot path.
//! - `lower.rs` (Phase 0) — `classify` + `dispatch` for the SIMD shape
//!   heuristic.
//! - `workbook_runtime.rs` (Phase 1 W5-10; extended Phase 2A.1, 2A.3.b,
//!   2A.6, 2B.2, 2B.3, 2B.5, 2B.7; Phase 3.4 W5-37 adds
//!   `recompute_dirty`) — `WorkbookRuntime` live-formula facade
//!   wrapping lex → parse → bind → eval → persist + recompute_all.
//!   `RecomputeResult` aggregation (no more short-circuit). Op-log
//!   producer wrappers (`set_name` / `add_sheet` / `clear_formula`)
//!   emit ops when an `OpLog` is attached. Phase 2B.7 added
//!   `validate_formula` for IDE on-keystroke validation and
//!   pre-validation guards on `add_sheet`. Phase 3.4 added
//!   `recompute_dirty()` — runs Tarjan SCC over the attached
//!   session's dirty set; cycled members get
//!   `Value::Error(ErrorValue::Circ)`. `RuntimeError` family includes
//!   `InvalidSheet`, `InvalidCell`, `ConflictingOps`, `OpLog`,
//!   `Name`, `InvalidChunkRows`, `TooManySheets`.
//! - `transaction.rs` (Phase 2A.2; hardened Phase 2A.6, 2A.3.b, 2B.7) —
//!   `WorkbookTransaction` multi-cell batch API with eager validation,
//!   conflict detection. Phase 2B.7 reordered commit to append-first
//!   (BatchCommit appended BEFORE workbook mutations) so a serialization
//!   failure can't leave the workbook divergent from the log.
//! - `loader.rs` (Phase 2A.4; reshaped Phase 2B.2) —
//!   `load_workbook_and_recompute(path, &reg) -> Result<(Workbook,
//!   RecomputeResult), QbookError>` convenience. Phase 2B.2 removed the
//!   `LoadAndRecomputeError` wrapper enum; recompute failures are now
//!   aggregated into the returned `RecomputeResult` instead.
//! - `calcgraph_session.rs` (Phase 3.1 W5-34 → 3.2 W5-35 → 3.3 W5-36
//!   → 3.4 W5-37) — `CalcgraphSession` owns the `ql_calcgraph::Graph`
//!   plus per-formula `FormulaDeps`, `cell_to_formulas` reverse
//!   index, `name_to_formulas` reverse index, `volatile_formulas`,
//!   and a `dirty: HashSet<NodeId>`. The 5 mutation hooks fan out
//!   via `Graph::dependents_for_cell` (stripe + precision for range
//!   deps) and `cell_to_formulas` (direct deps), with BFS for
//!   transitive cascading (Phase 3.4). Forward `add_edge`s for
//!   direct cell→cell deps are added at extract time (Phase 3.4) so
//!   the Phase 0 W3-3 iterative Tarjan in `topo::schedule` can order
//!   chain dependents correctly. `schedule_dirty()` + `take_dirty()`
//!   are the scheduler entry points; `cell_address_for(NodeId)` is
//!   the inverse of `cell_node_for` for the runtime's evaluation
//!   loop.
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. Error enums
//! (`BindError`, `RuntimeError`) and `SimdShape` carry
//! `#[non_exhaustive]` — downstream consumers must include a `_` arm
//! when matching across crate boundaries. `ExprPlan` (the plan IR),
//! `ResolvedName`, and `EvalResult` are exhaustive by design;
//! adding a variant is a MAJOR-version event because every scalar /
//! aggregate / spill evaluator dispatcher must gain a new arm.
//!
//! # Module layout (Tier D1 split, 2026-05-18)
//!
//! `workbook_runtime` is a module directory with 9 sibling
//! submodules — each adds an `impl<'a> WorkbookRuntime<'a>` block to
//! the same struct via the sibling-module impl pattern. See
//! `docs/architecture/workbook-runtime-split-design.md`.
//!
//! - `workbook_runtime::mod` — struct, 4 constructors, `cache_stats`,
//!   `validate_sheet` / `validate_cell` shared helpers.
//! - `workbook_runtime::error` — `RuntimeError` + `RecomputeFailure`
//!   + `RecomputeResult` (re-exported at module root).
//! - `workbook_runtime::cells` — `set_formula`, `set_value`,
//!   `clear_formula`, spill helpers.
//! - `workbook_runtime::recompute` — `recompute_all`, `recompute_dirty`,
//!   recompute orchestrators.
//! - `workbook_runtime::tables` — table mutation API.
//! - `workbook_runtime::sheets` — sheet mutation API.
//! - `workbook_runtime::names` — defined-name registration.
//! - `workbook_runtime::formats` — format intern + cell-format binding.
//! - `workbook_runtime::config` — workbook-scoped reference-mode + locale.
//! - `workbook_runtime::validate` — `validate_formula` + `transaction`.
//!
//! Public API is unchanged: every method stays on `WorkbookRuntime`
//! and `pub use error::*` re-exports the result types.

pub mod aggregate_cache;
pub mod calcgraph_session;
pub mod env;
pub mod eval_result;
pub mod loader;
pub mod lower;
pub mod plan;
pub mod plan_cache;
pub mod scalar;
pub mod session;
pub mod simd;
pub mod transaction;
pub mod workbook_runtime;

pub use aggregate_cache::{
    AggregateCache, AggregateCacheStats, InMemAggregateCache, NoAggregateCache,
};
pub use calcgraph_session::{
    CalcgraphSession, FormulaDeps, HookCounts, RebuildFailure, RebuildResult,
};
pub use env::{CellEnv, MapEnv, WorkbookEnv};
pub use eval_result::EvalResult;
pub use loader::load_workbook_and_recompute;
pub use lower::{classify, dispatch, SimdShape};
pub use plan::{
    bind, bind_with_names, bind_with_names_and_sheets, bind_with_site, bind_with_site_no_tables,
    BindError, BindSite, ExprPlan, NameLookup, ResolvedName, SheetResolver, TableLookup,
};
pub use plan_cache::{PlanCache, PlanCacheKey, PlanCacheStats};
pub use scalar::{
    eval_at_cell_boundary, eval_scalar, eval_scalar_with_cache, eval_scalar_with_registry,
};
pub use session::WorkbookSession;
pub use simd::{
    // Phase 2A.13 audit cycle-3 M9: `div_array` removed (was dead code after
    // Phase 2A.9 H5 routed Operator::Div through scalar evaluator).
    add_array,
    add_scalar,
    mul_array,
    mul_scalar,
    scalar_sub,
    sub_array,
    sub_scalar,
};
pub use transaction::WorkbookTransaction;
pub use workbook_runtime::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};

/// Phase 2B.7 audit H3 (2026-05-12): compile-time proof that the two
/// engine state types the IDE binding will own are `Send + Sync`. If Loro
/// 1.x's `LoroDoc` (inside `OpLog`) loses `Sync` in a future version, or
/// if a Workbook field gains an `Rc`, this fails at build — at the right
/// time to fix it, not three days into Phase 6.3 binding work.
#[allow(dead_code)]
fn _assert_engine_state_is_send_sync() {
    fn check<T: Send + Sync>() {}
    check::<ql_storage::Workbook>();
    check::<ql_oplog::OpLog>();
}
