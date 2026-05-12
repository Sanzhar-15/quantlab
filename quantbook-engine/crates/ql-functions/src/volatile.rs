//! Volatile function implementations — Engine Phase 3.7 (W5-40, 2026-05-12).
//!
//! NOW, TODAY, RAND, RANDBETWEEN. These functions produce a different value
//! every time they're invoked (NOW changes every second; RAND every call); the
//! Phase 3.7 calcgraph treats them as graph roots that must be re-evaluated
//! when the user explicitly requests a recalc (`CalcgraphSession::
//! mark_volatile_dirty`).
//!
//! ## Determinism for tests
//!
//! Default behavior pulls from the system clock (NOW/TODAY) or a thread-local
//! xorshift64 PRNG seeded from time (RAND/RANDBETWEEN). Tests can pin the
//! values via:
//!
//! - `set_test_rng_seed(seed)` — locks the RNG to a known state. Subsequent
//!   `RAND()` calls produce a deterministic sequence.
//! - `set_test_now_secs(unix_secs)` — pins NOW/TODAY to a fixed Unix
//!   timestamp.
//!
//! Both helpers are thread-local (no cross-thread contention) and are reset
//! by `clear_test_overrides()`. Production code never touches these — they're
//! `#[cfg(test)]`-friendly but live outside `cfg(test)` so the engine's
//! `ql-exec` test suite can use them via the public crate API.
//!
//! ## Why xorshift64 (not rand::SmallRng)
//!
//! Phase 0 set a hard rule: no new crate dependencies without an explicit
//! pin-guard add (`scripts/check-cargo-lock-pins.sh`). The Excel canon for
//! RAND is "produces a uniform double in [0, 1)"; xorshift64 → upper 53 bits
//! satisfies it without taking on `rand` + `getrandom` + their transitive
//! deps. Phase 4.3 (function library expansion) may revisit if WeakRNG
//! quality becomes a problem.

use std::cell::Cell;
use std::time::{SystemTime, UNIX_EPOCH};

use ql_types::{coercion, ErrorValue, Value};

thread_local! {
    /// Xorshift64 state — non-zero. Default-initialized lazily on first
    /// access via `default_rng_seed`.
    static RNG_STATE: Cell<u64> = const { Cell::new(0) };
    /// Test-mode override for `now_secs()`. `None` = use SystemTime.
    static TEST_NOW_OVERRIDE: Cell<Option<u64>> = const { Cell::new(None) };
}

/// Pin the RNG state for deterministic tests. Subsequent `RAND()` /
/// `RANDBETWEEN(low, high)` calls produce a fixed sequence from this seed.
/// Zero is silently bumped to 1 (xorshift64 has a degenerate state at 0).
pub fn set_test_rng_seed(seed: u64) {
    RNG_STATE.with(|s| s.set(if seed == 0 { 1 } else { seed }));
}

/// Pin the current Unix timestamp (seconds) for `NOW()` / `TODAY()` in
/// tests. `clear_test_overrides()` reverts to system time.
pub fn set_test_now_secs(unix_secs: u64) {
    TEST_NOW_OVERRIDE.with(|s| s.set(Some(unix_secs)));
}

/// Clear all volatile-function test overrides (RNG state and clock pin).
/// Test fixtures should call this in their teardown or wrap test bodies
/// in a guard. Doesn't reset the RNG to the system-time seed; the next
/// `RAND()` call will re-seed lazily.
pub fn clear_test_overrides() {
    RNG_STATE.with(|s| s.set(0));
    TEST_NOW_OVERRIDE.with(|s| s.set(None));
}

fn default_rng_seed() -> u64 {
    // Mix nanoseconds (low 32 bits) with seconds (high 32 bits). Non-
    // zero by construction: the constant fallback is non-zero.
    let dur = SystemTime::now().duration_since(UNIX_EPOCH);
    let seed = match dur {
        Ok(d) => (d.as_secs().wrapping_shl(32)) | (d.subsec_nanos() as u64),
        Err(_) => 0xC0FF_EE12_3456_789Au64,
    };
    if seed == 0 {
        0xC0FF_EE12_3456_789Au64
    } else {
        seed
    }
}

fn next_xorshift64() -> u64 {
    RNG_STATE.with(|s| {
        let mut x = s.get();
        if x == 0 {
            x = default_rng_seed();
        }
        x ^= x.wrapping_shl(13);
        x ^= x.wrapping_shr(7);
        x ^= x.wrapping_shl(17);
        s.set(x);
        x
    })
}

fn now_secs() -> u64 {
    if let Some(v) = TEST_NOW_OVERRIDE.with(|s| s.get()) {
        return v;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `NOW()` — current date+time as an Excel-style serial number (days
/// since 1899-12-30). For V1 we approximate with Unix-time-based
/// arithmetic; the Phase 4.5 date/time + format work pins the exact
/// epoch + leap-year rules.
pub fn now(args: &[Value]) -> Value {
    if !args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let secs = now_secs() as f64;
    // Excel epoch (1899-12-30) is 25569 days before Unix epoch
    // (1970-01-01). Convert seconds → days.
    let serial = (secs / 86_400.0) + 25_569.0;
    Value::number(serial)
}

/// `TODAY()` — current date (no time-of-day) as an Excel-style serial.
pub fn today(args: &[Value]) -> Value {
    if !args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let secs = now_secs();
    let days = secs / 86_400;
    let serial = days as f64 + 25_569.0;
    Value::number(serial)
}

/// `RAND()` — pseudo-random `f64` in `[0, 1)`. xorshift64 → upper 53
/// bits → divide by 2^53 for a uniform double.
pub fn rand(args: &[Value]) -> Value {
    if !args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let r = next_xorshift64();
    let bits53 = r >> 11; // top 53 bits
    let denom = (1u64 << 53) as f64;
    Value::number(bits53 as f64 / denom)
}

/// `RANDBETWEEN(low, high)` — random integer in `[low, high]` inclusive.
/// Excel canon: rounds `low` up and `high` down; if `low > high`, returns
/// `#NUM!`.
pub fn randbetween(args: &[Value]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let low = match coercion::to_number_lenient(&args[0]) {
        Ok(n) => n.ceil() as i64,
        Err(e) => return Value::Error(e),
    };
    let high = match coercion::to_number_lenient(&args[1]) {
        Ok(n) => n.floor() as i64,
        Err(e) => return Value::Error(e),
    };
    if low > high {
        return Value::Error(ErrorValue::Num);
    }
    let span = (high - low + 1) as u64;
    let r = next_xorshift64() % span;
    Value::number(low as f64 + r as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Setting the seed produces a deterministic RAND() sequence.
    #[test]
    fn rand_is_deterministic_with_seeded_rng() {
        set_test_rng_seed(0xDEAD_BEEF_CAFE_F00D);
        let a = rand(&[]);
        let b = rand(&[]);
        // Re-seed; same sequence repeats.
        set_test_rng_seed(0xDEAD_BEEF_CAFE_F00D);
        let a2 = rand(&[]);
        let b2 = rand(&[]);
        assert_eq!(a, a2);
        assert_eq!(b, b2);
        assert_ne!(a, b, "two consecutive RAND calls should differ");
        clear_test_overrides();
    }

    #[test]
    fn rand_returns_value_in_unit_interval() {
        for _ in 0..100 {
            let v = rand(&[]);
            match v {
                Value::Number(n) => assert!(
                    (0.0..1.0).contains(&n),
                    "RAND returned {n} which is outside [0, 1)"
                ),
                _ => panic!("RAND should return Number"),
            }
        }
        clear_test_overrides();
    }

    #[test]
    fn randbetween_inclusive_bounds() {
        set_test_rng_seed(1);
        for _ in 0..200 {
            let v = randbetween(&[Value::Number(1.0), Value::Number(10.0)]);
            match v {
                Value::Number(n) => {
                    assert!((1.0..=10.0).contains(&n), "RANDBETWEEN out of [1, 10]: {n}");
                    assert!(n.fract() == 0.0, "RANDBETWEEN must be integer: {n}");
                }
                _ => panic!("RANDBETWEEN should return Number"),
            }
        }
        clear_test_overrides();
    }

    #[test]
    fn randbetween_low_above_high_is_num_error() {
        let v = randbetween(&[Value::Number(10.0), Value::Number(1.0)]);
        assert_eq!(v, Value::Error(ErrorValue::Num));
    }

    #[test]
    fn randbetween_wrong_arity_is_value_error() {
        assert_eq!(randbetween(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            randbetween(&[Value::Number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            randbetween(&[Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn now_is_deterministic_with_test_override() {
        set_test_now_secs(0); // Unix epoch
        let v = now(&[]);
        // 1970-01-01 00:00:00 UTC = Excel serial 25569.0.
        assert_eq!(v, Value::Number(25_569.0));
        clear_test_overrides();
    }

    #[test]
    fn today_is_deterministic_with_test_override() {
        // Unix epoch + 1 day worth of seconds.
        set_test_now_secs(86_400);
        let v = today(&[]);
        assert_eq!(v, Value::Number(25_570.0));
        clear_test_overrides();
    }

    #[test]
    fn now_changes_after_clock_advance() {
        set_test_now_secs(1_000_000);
        let a = now(&[]);
        set_test_now_secs(1_000_500);
        let b = now(&[]);
        assert_ne!(a, b);
        clear_test_overrides();
    }

    #[test]
    fn arity_error_for_now_with_args() {
        assert_eq!(now(&[Value::Number(1.0)]), Value::Error(ErrorValue::Value));
        assert_eq!(
            today(&[Value::Number(1.0)]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(rand(&[Value::Number(1.0)]), Value::Error(ErrorValue::Value));
    }
}
