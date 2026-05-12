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

pub mod registry;
pub mod scalar_fns;
pub mod volatile;
pub mod welford;

pub use registry::{default_registry, FunctionRegistry, ScalarFn};
pub use volatile::{clear_test_overrides, set_test_now_secs, set_test_rng_seed};
pub use welford::{
    mean, population_stdev, population_variance, sample_stdev, sample_variance, WelfordState,
};
