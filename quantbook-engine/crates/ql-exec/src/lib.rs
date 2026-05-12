//! `ql-exec` — Quantbook expression executor.
//!
//! Phase 0 scope per spec Part V §4 Week 4:
//!
//! - `plan.rs` — `ExprPlan` execution-ready IR + `bind(expr, owning_sheet)` resolver.
//! - `env.rs` — `CellEnv` trait + `WorkbookEnv` and `MapEnv` implementations.
//! - `scalar.rs` — `eval_scalar(plan, env) -> Value` per-cell evaluator with Excel-
//!   compatible arithmetic, error propagation, and coercion semantics.
//!
//! Coming in subsequent Week 4 commits:
//!
//! - W4-2 `simd.rs` — pulp + multiversion SIMD kernels for Float64Array bulk ops.
//!   The OG-02 25M-cell `=A*2` ≤100ms hot path lives here.
//! - W4-3 A2 acceptance — multiversion wrapper around Arrow kernels, disassembly
//!   verification of runtime SIMD dispatch.
//! - W4-4 `runtime.rs` + function dispatch — top-level Runtime that consumes a
//!   `Schedule` from ql-calcgraph + ql-functions registry.
//! - W4-5 A6 acceptance — Welford VAR/STDEV passing NIST StRD numacc3.
//! - W4-6 acceptance benches — OG-02, OG-03, OG-04, A1, A7 RUNS.
//! - W4-7 Phase 0 exit packet + GO/NO-GO.

pub mod env;
pub mod lower;
pub mod plan;
pub mod scalar;
pub mod simd;
pub mod transaction;
pub mod workbook_runtime;

pub use env::{CellEnv, MapEnv, WorkbookEnv};
pub use lower::{classify, dispatch, SimdShape};
pub use plan::{bind, BindError, ExprPlan};
pub use scalar::{eval_scalar, eval_scalar_with_registry};
pub use simd::{
    add_array, add_scalar, div_array, mul_array, mul_scalar, scalar_sub, sub_array, sub_scalar,
};
pub use transaction::WorkbookTransaction;
pub use workbook_runtime::{RuntimeError, WorkbookRuntime};
