//! `ql-exec` — Quantbook expression executor.
//!
//! Module map (Phase 0 → Phase 2A):
//!
//! - `plan.rs` (Phase 0 W4-1; extended Phase 2A.1, .6) — `ExprPlan` IR;
//!   `bind` / `bind_with_names` resolvers; `NameLookup` trait;
//!   `BindError` variants including `UnresolvedName`, `NamedTargetIsBlank`,
//!   `NamedTargetIsError`, `UnsupportedVariant`.
//! - `env.rs` (Phase 0) — `CellEnv` trait + `WorkbookEnv` / `MapEnv` impls;
//!   `NameLookup for NameTable` bridge (Phase 2A.1; case-insensitive lookup
//!   per Phase 2A.6 audit H2).
//! - `scalar.rs` (Phase 0 W4-1) — `eval_scalar` per-cell evaluator with
//!   Excel-compatible arithmetic, error propagation, coercion.
//! - `simd.rs` (Phase 0 W4-2/W4-3) — `multiversion`-dispatched SIMD kernels;
//!   OG-02 25M-cell hot path.
//! - `lower.rs` (Phase 0) — `classify` + `dispatch` for the SIMD shape
//!   heuristic.
//! - `workbook_runtime.rs` (Phase 1 W5-10; extended Phase 2A.1, .6) —
//!   `WorkbookRuntime` live-formula facade (lex → parse → bind → eval →
//!   persist + recompute_all); `RuntimeError` family including
//!   `InvalidSheet` and `ConflictingOps`.
//! - `transaction.rs` (Phase 2A.2; hardened Phase 2A.6) —
//!   `WorkbookTransaction` multi-cell batch API with two-pass commit,
//!   eager validation, conflict detection.
//! - `loader.rs` (Phase 2A.4) — `load_workbook_and_recompute` convenience
//!   wrapping `ql_io::load_workbook` + `recompute_all`.

pub mod env;
pub mod loader;
pub mod lower;
pub mod plan;
pub mod scalar;
pub mod simd;
pub mod transaction;
pub mod workbook_runtime;

pub use env::{CellEnv, MapEnv, WorkbookEnv};
pub use loader::{load_workbook_and_recompute, LoadAndRecomputeError};
pub use lower::{classify, dispatch, SimdShape};
pub use plan::{bind, BindError, ExprPlan};
pub use scalar::{eval_scalar, eval_scalar_with_registry};
pub use simd::{
    add_array, add_scalar, div_array, mul_array, mul_scalar, scalar_sub, sub_array, sub_scalar,
};
pub use transaction::WorkbookTransaction;
pub use workbook_runtime::{RuntimeError, WorkbookRuntime};
