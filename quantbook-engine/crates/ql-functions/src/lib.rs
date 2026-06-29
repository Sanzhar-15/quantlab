//! `ql-functions` — Quantbook built-in function library.
//!
//! Phase 0 W4-4 scope: 22 distinct functions (25 registry entries with aliases) covering
//! the most common Excel formula primitives:
//!
//! - **Aggregates**: SUM, AVERAGE/AVG, COUNT, COUNTA, MIN, MAX, PRODUCT.
//! - **Variance / stdev (Welford-backed for A6)**: VAR, VAR.S, VAR.P, STDEV, STDEV.S, STDEV.P.
//! - **Logical**: IF, AND, OR, NOT, IFERROR.
//! - **Math**: ABS, SQRT, ROUND, INT, MOD, POWER.
//!
//! All functions are `fn(&[Value]) -> Value` — pre-evaluated args, Excel-compatible
//! coercion + error propagation. Range references get expanded to per-cell Values
//! at the binder layer before reaching this module.
//!
//! ## A6 acceptance (NIST StRD numacc verification)
//!
//! VAR / VAR.S / STDEV / STDEV.S use Welford's online algorithm via
//! `welford::WelfordState`. Verified against an analytic large-offset + small-variance
//! dataset (`welford::tests::a6_acceptance_shape_lock_large_offset_small_variance`):
//! mean accurate to ≥12 significant digits, variance to ≥8 — meets the A6 spec.
//!
//! Literal NIST numacc dataset import (W4-5 follow-up) will add data fixtures via a
//! `Cargo`-tracked test asset; the Welford shape is locked here.
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. Error enums
//! (`FormatParseError`, `format::error::V2Token`) carry
//! `#[non_exhaustive]` — downstream consumers must include a `_` arm
//! when matching across crate boundaries. Function-registry dispatch
//! enums (`RegisteredFn`, `FunctionArg`, `FunctionReturn`, `FnArg`,
//! `RefArg`, `PlanKind`, `ArgContract`) are exhaustive by design;
//! adding a new dispatch tier is a MAJOR-version event because every
//! eval site needs the corresponding new arm.

pub mod array_returning_fns;
pub mod context_aware_fns;
pub mod date_fns;
pub mod distribution_fns;
pub mod financial_fns;
pub mod format;
pub mod range_aware_fns;
pub mod range_fns;
pub mod reference_aware_fns;
pub mod reference_fns;
pub mod registry;
pub mod scalar_fns;
pub mod volatile;
pub mod welford;
pub mod wildcard;

pub use context_aware_fns::ContextAwareFn;
pub use range_aware_fns::{FnArg, RangeAndContextAwareFn, RangeAwareFn};
pub use reference_aware_fns::{
    ArgContract, NoOpReferenceQuery, PlanKind, RefArg, RefContext, ReferenceAwareFn,
    ReferenceQuery, NO_OP_REFERENCE_QUERY,
};
pub use registry::{
    default_registry, FunctionArg, FunctionContext, FunctionFn, FunctionRegistry,
    FunctionRegistryError, FunctionReturn, RegisteredFn, ScalarFn,
};
pub use volatile::{clear_test_overrides, set_test_now_secs, set_test_rng_seed};
pub use welford::{
    mean, population_stdev, population_variance, sample_stdev, sample_variance, WelfordState,
};
