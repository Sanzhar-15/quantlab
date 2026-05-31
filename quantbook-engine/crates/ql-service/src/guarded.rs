//! Phase 6.2-0 (2026-06-01) -- service-side panic boundary.
//!
//! Port of the napi `guarded` helper (`ql-bindings-node`). A panic inside an
//! engine call would otherwise unwind out of the tokio task (aborting just that
//! connection task, but leaving the session lock state ambiguous and the client
//! with a dropped connection rather than a structured error). We run the locked
//! synchronous call under `catch_unwind` and convert a caught panic into a
//! structured `[panic]` / `class=internal` [`EngineError`], so the client gets a
//! 500 problem+json and the server keeps running.
//!
//! Soundness of `AssertUnwindSafe`: the session handle is a `parking_lot::Mutex`
//! (no poisoning), and the engine's own `FaultGuard` (in `ql-exec`) seals the
//! session `Faulted` during the unwind, so after the catch the lock is released
//! and the next call observes a consistent (`Faulted` -> `[invalid_state]`)
//! session. We never resume normal logic on a half-updated value -- we return an
//! error.

use ql_session::EngineError;

/// Run `f` (a locked synchronous engine call) under `catch_unwind`, mapping a
/// caught panic to a structured `[panic]` engine error tagged with `method`.
pub fn guarded<R>(
    method: &str,
    f: impl FnOnce() -> Result<R, EngineError>,
) -> Result<R, EngineError> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => Err(EngineError::panic(format!(
            "{method}: {}",
            panic_payload_message(payload.as_ref())
        ))),
    }
}

/// Best-effort extraction of a panic message from its `Box<dyn Any>` payload
/// (the common `&'static str` / `String` cases; otherwise a placeholder).
fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}
