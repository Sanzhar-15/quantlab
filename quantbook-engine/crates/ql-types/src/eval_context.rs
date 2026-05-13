//! Phase 4.5.A.0 (W5-69) — evaluator context for date / locale / clock-aware functions.
//!
//! The W5-63 Phase 4.4 design and W5-68 Phase 4.5 design both surface the same gap:
//! the registry's `ScalarFn = fn(&[Value]) -> Value` signature can't carry workbook-
//! level state (date system, locale, current-clock provider). Date functions like
//! `DATE`, `WEEKDAY`, `NOW`, `TODAY`, `EOMONTH` need this state to behave correctly.
//!
//! Solution: a third registry tier (`ContextAwareFn`) sits between `RangeAwareFn`
//! and `ScalarFn` in the dispatch order, and receives an extra `&EvalContext` arg.
//!
//! ## V1 scope
//!
//! - [`DateSystem`] is the workbook's epoch choice. Excel1900 is the default;
//!   Excel1904 covers legacy macOS Excel files.
//! - [`Locale`] is a single-variant enum in V1 (only `EnUs`); Phase 4.9 populates
//!   the rest of the locale table.
//! - [`NowProvider`] is a `Copy` enum (not a trait object) in V1. `System` reads
//!   the actual clock at fire time; `Test` injects deterministic Unix-seconds +
//!   UTC offset for replay/test paths. WASM host-callback support lands in
//!   Phase 6.3 via a separate variant or trait migration.
//! - [`EvalContext`] bundles all three. The default `DEFAULT_EVAL_CONTEXT` is a
//!   `'static` value with `Excel1900 + EnUs + System`. `CellEnv::eval_context()`
//!   returns a reference to this by default; impls override when a workbook
//!   carries a non-default `DateSystem`.

use crate::ErrorValue;

/// Excel date-system choice. Stored at workbook level; not per-cell.
///
/// **W5-68 design § 3.2 (DTF-4-01).** The two systems differ by 1462 days
/// (the 1900 leap-year bug + the epoch shift). Conversion between them is a
/// constant offset on serials but a full re-render at the format layer.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DateSystem {
    /// 1900 epoch (1899-12-30 = serial 0). Windows Excel default.
    /// Includes the phantom 1900-02-29 = serial 60 for legacy Lotus 1-2-3
    /// compatibility (the "1900 leap-year bug").
    #[default]
    Excel1900,
    /// 1904 epoch (1904-01-01 = serial 0). Legacy macOS Excel default.
    /// No leap-year bug — serials are clean.
    Excel1904,
}

/// Locale tag for number/date/text rendering + parsing.
///
/// **W5-68 design § 6.4.** V1 ships en-US only; Phase 4.9 populates DE/FR
/// and friends with full separator + month-name + weekday-name tables.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Locale {
    /// en-US: decimal `.`, thousands `,`, English month / weekday names.
    #[default]
    EnUs,
}

/// Source of "what time is it" for NOW() / TODAY() / volatile fns.
///
/// **W5-68 design § 3.2.1 (Codex HIGH 4 fix).** Excel canon: NOW/TODAY
/// return LOCAL time. The native impl reads the system clock + local UTC
/// offset; the test impl pins both for deterministic tests + CRDT replay.
///
/// **WASM:** `System` panics on `wasm32-unknown-unknown` because
/// `std::time::SystemTime::now()` is unavailable. Phase 6.3 bindings will
/// EITHER inject `Test { unix_secs: <js-callback-result>, ... }` per call
/// OR migrate this enum to a trait object. Scaffolding contract: callers
/// must guard `System` behind a target check OR set `Test` explicitly.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NowProvider {
    /// Native system clock + local UTC offset (queried at fire time).
    #[default]
    System,
    /// Injected for tests + CRDT replay. `unix_secs` overrides
    /// `SystemTime::now().duration_since(UNIX_EPOCH)`; `utc_offset_seconds`
    /// overrides the local-zone offset (0 == UTC == local for replay).
    Test {
        unix_secs: u64,
        utc_offset_seconds: i32,
    },
}

impl NowProvider {
    /// Read `(unix_secs, utc_offset_seconds)` from this provider.
    ///
    /// Errors with `Err(#NUM!)` if the System path can't read the clock
    /// (e.g. duration_since(UNIX_EPOCH) fails because the system clock is
    /// before 1970). Test path is infallible.
    ///
    /// **W5-69 scaffolding contract:** this method is intentionally trivial
    /// in V1 — it does NOT yet call the actual `iana_time_zone` lookup (the
    /// utc_offset for System is currently 0). Sub-phase 4.5.A wires the
    /// real local-time lookup. See `docs/known-gaps.md` GAP-T-01.
    pub fn read(&self) -> Result<(u64, i32), ErrorValue> {
        match self {
            NowProvider::Test {
                unix_secs,
                utc_offset_seconds,
            } => Ok((*unix_secs, *utc_offset_seconds)),
            NowProvider::System => {
                // V1 scaffolding: return UTC. GAP-T-01 will replace this
                // with the actual local-offset lookup. Until then, NOW()
                // is UTC-equivalent — preserves the current pre-W5-69
                // behavior for compatibility.
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| ErrorValue::Num)?
                    .as_secs();
                Ok((secs, 0))
            }
        }
    }
}

/// Bundle passed to context-aware functions alongside their `&[Value]` args.
///
/// **W5-69 scaffolding contract:** `EvalContext` is `Copy` (all three fields
/// are `Copy` enums). The runtime supplies one at every eval site; the cheap
/// default (`DEFAULT_EVAL_CONTEXT`) is sufficient until Sub-phase 4.5.A
/// upgrades the runtime to read the workbook's actual date_system.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct EvalContext {
    pub date_system: DateSystem,
    pub locale: Locale,
    pub now_provider: NowProvider,
}

impl EvalContext {
    /// Builder convenience: an `EvalContext` with everything default
    /// (Excel1900 + EnUs + System). Same as `EvalContext::default()` but
    /// usable as a `const` initializer.
    pub const DEFAULT: EvalContext = EvalContext {
        date_system: DateSystem::Excel1900,
        locale: Locale::EnUs,
        now_provider: NowProvider::System,
    };

    /// Test-friendly constructor: pin `unix_secs` + UTC offset.
    pub fn for_test(unix_secs: u64, utc_offset_seconds: i32) -> EvalContext {
        EvalContext {
            date_system: DateSystem::Excel1900,
            locale: Locale::EnUs,
            now_provider: NowProvider::Test {
                unix_secs,
                utc_offset_seconds,
            },
        }
    }
}

/// `'static` default context. Returned by `CellEnv::eval_context()`'s default
/// impl, so callers without a workbook (tests, MapEnv, benches) get sensible
/// behavior without plumbing.
pub static DEFAULT_EVAL_CONTEXT: EvalContext = EvalContext::DEFAULT;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_excel1900_enus_system() {
        let ctx = EvalContext::default();
        assert_eq!(ctx.date_system, DateSystem::Excel1900);
        assert_eq!(ctx.locale, Locale::EnUs);
        assert_eq!(ctx.now_provider, NowProvider::System);
    }

    #[test]
    fn static_default_matches_const() {
        // DEFAULT_EVAL_CONTEXT static should equal EvalContext::DEFAULT.
        assert_eq!(DEFAULT_EVAL_CONTEXT, EvalContext::DEFAULT);
    }

    #[test]
    fn for_test_helper_pins_clock() {
        let ctx = EvalContext::for_test(1_700_000_000, -28800);
        assert_eq!(
            ctx.now_provider,
            NowProvider::Test {
                unix_secs: 1_700_000_000,
                utc_offset_seconds: -28800,
            }
        );
        // date_system + locale still default.
        assert_eq!(ctx.date_system, DateSystem::Excel1900);
        assert_eq!(ctx.locale, Locale::EnUs);
    }

    #[test]
    fn now_provider_test_path_returns_pinned_values() {
        let provider = NowProvider::Test {
            unix_secs: 12345,
            utc_offset_seconds: -3600,
        };
        let (secs, offset) = provider.read().unwrap();
        assert_eq!(secs, 12345);
        assert_eq!(offset, -3600);
    }

    #[test]
    fn now_provider_system_returns_some_secs_with_zero_offset_v1() {
        // V1 scaffolding (GAP-T-01): System path returns UTC offset 0.
        // Once GAP-T-01 closes, this test should pin the actual local
        // offset OR be removed in favor of an integration test.
        let provider = NowProvider::System;
        let (secs, offset) = provider.read().unwrap();
        // Some plausibly current Unix seconds (after 2024-01-01).
        assert!(secs > 1_700_000_000, "system clock too old: {secs}");
        assert_eq!(offset, 0, "GAP-T-01 scaffolding: System offset is 0 in V1");
    }

    #[test]
    fn date_system_default_is_excel1900() {
        assert_eq!(DateSystem::default(), DateSystem::Excel1900);
    }

    #[test]
    fn locale_default_is_enus() {
        assert_eq!(Locale::default(), Locale::EnUs);
    }

    #[test]
    fn now_provider_default_is_system() {
        assert_eq!(NowProvider::default(), NowProvider::System);
    }

    #[test]
    fn eval_context_is_copy() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<EvalContext>();
        assert_copy::<DateSystem>();
        assert_copy::<Locale>();
        assert_copy::<NowProvider>();
    }
}
