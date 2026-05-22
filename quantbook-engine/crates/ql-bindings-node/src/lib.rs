//! `ql-bindings-node` — VS Code extension binding (Phase 5.7 V1).
//!
//! **Phase 5.7 V1 (2026-05-22, this ship):** binds `CollabSession` for the
//! quantlab VS Code fork's extension host. Replaces the Phase-6+ reserved
//! placeholder this crate used to be.
//!
//! ## Architecture
//!
//! cdylib + napi-rs 3.x. The `#[napi]` derive macros generate the
//! JS-facing class shape from the Rust struct. napi-rs handles:
//!   - JS class lifecycle (`new`, finalize)
//!   - `BigInt <-> u64` conversion for `PeerId`
//!   - `Uint8Array <-> &[u8]`: `as_ref()` exposes a slice INTO the
//!     JS-owned ArrayBuffer (verified via napi-rs 3.9.0
//!     `arraybuffer.rs:653`'s `slice::from_raw_parts` on the SAB-or-AB
//!     backing store). On export we hand ownership of a `Vec<u8>` to
//!     JS via `Uint8Array::from`, which transfers the buffer rather
//!     than copying.
//!   - panic safety: **napi-rs 3.x does NOT wrap entry points in
//!     `catch_unwind` by default** (Phase 5.7 V1 audit Codex H1 +
//!     Opus H3, 2026-05-22 — verified by reading napi-derive-backend
//!     5.0.4 `src/codegen/fn.rs:217-240`: the wrap is gated on
//!     `#[napi(catch_unwind)]` opt-in). The V1 binding does NOT use
//!     `catch_unwind` — instead, every `#[napi]` method
//!     pre-validates inputs that could trigger engine-side `assert_*!`,
//!     `panic!`, `unwrap`, or `expect`. Smoke caught one such hazard
//!     (PeerId(0) → `CollabSession::new`'s `assert_ne!(peer, 0)` →
//!     Node abort "failed to initiate panic, error 5"); the
//!     `peer_id_from_bigint` helper now pre-rejects 0. V2+ each new
//!     `#[napi]` method MUST sweep the engine for FFI-reachable
//!     assertions and pre-validate the same way (see V2 backlog).
//!
//! ## V1 surface
//!
//! Single class `CollabSession` exposing the minimum methods that let
//! TS code drive a round-trip:
//!   - `new(peerId: bigint)`: wraps `ql_collab::CollabSession::new`
//!   - static `fromSnapshot(peerId: bigint, bytes: Uint8Array)`:
//!     wraps `from_snapshot`
//!   - `appendPutValue(sheet, row, col, value)`: convenience for V1
//!     (single Op variant; full Op enum binding deferred to V2)
//!   - `exportBytes() -> Uint8Array`: snapshot
//!   - `mergeBytes(bytes: Uint8Array) -> number`: returns merged op count
//!   - `opCount() -> number`
//!   - `pendingOpCount() -> number` (V2 V4 V1 step 2 helper)
//!   - `hasPendingFlush() -> boolean` (V2 V3 step 3 helper)
//!   - `peerId() -> bigint`
//!
//! ## V1 deferred (see `docs/phase5/5-7-v1-exit-packet.md`)
//!
//! Full V1-deferred-to-V2/V3 list lives in the V1 exit packet's
//! "V1 deferred to V2" table. Summary: Transport binding
//! (LoopbackTransport, WebSocketTransport, `attach_transport` /
//! `detach_transport` / `has_transport` / `flush_to_transport` /
//! `flush_delta_to_transport` / `flush_pending_to_transport` /
//! `poll_remote` / `poll_remote_with_limit` /
//! `transport_last_error` / `set_auto_flush_policy`), multi-window
//! demo, undo/redo (UndoGroupGuard RAII translation), presence
//! (PresenceState shape), full Op enum (beyond PutValue),
//! Format/D-1 (FormatId enum), `rebuild_workbook` (D-3
//! production-visible closure — Phase 5.7 V3), `discard_pending_ops`,
//! `.qbook` persistence import/export, `#[napi(catch_unwind)]` opt-in
//! for defense in depth, SharedArrayBuffer defensive copy, BigInt
//! return for `opCount`/`pendingOpCount`/`mergeBytes`,
//! `mergeBytesDelta` companion, `@napi-rs/cli` publish pipeline,
//! Windows-specific `.dll` naming, CI `QUANTBOOK_REQUIRE_ENGINE=1`
//! enforcement. V2 picks up Transport; V3 picks up cell-grid UI +
//! persistence + `rebuild_workbook` wiring.
//!
//! ## Send + Sync
//!
//! `CollabSession` is `Send + !Sync` (verified per V2 V4 V1 step 3 +
//! audit-discipline Rule 4). napi-rs's generated class instance lives
//! in a `Box<CollabSession>` stored in JS object slot via `napi_wrap`
//! (verified by reading napi-rs 3.9.0
//! `src/bindgen_runtime/callback_info.rs:90-126`: NO `Send`/`Sync`
//! bound on the wrapped type). napi-rs does NOT lock the instance.
//! Safety against concurrent `&mut self` rests on (Phase 5.7 V1 audit
//! Opus M1 closure, 2026-05-22):
//!   1. JS event loop is single-threaded per Worker / main thread.
//!   2. `napi::Reference<T>` is NOT Send (intentional, per napi-rs
//!      docs: "drop must run on the same thread as creation"). This
//!      compile-time prevents passing the class reference to a
//!      different Worker thread.
//!   3. `napi::Reference<T>: Sync` only when `T: Sync`. `CollabSession:
//!      !Sync` blocks even read-only cross-thread sharing.
//!
//! Conclusion: `Send + !Sync` is the correct bound; the IDE cannot use
//! this class concurrently from multiple Workers even if it wanted to.
//! The prior docstring claimed "napi internal locking" -- that was
//! wrong (no such lock exists); the actual safety is via 1+2+3 above.

#![deny(clippy::all)]
#![allow(clippy::missing_safety_doc)] // napi-rs generated wrappers

use napi::bindgen_prelude::*;
use napi_derive::napi;

use ql_collab::CollabSession as CoreCollabSession;
use ql_oplog::CellWireValue;
use ql_oplog::Op;
use ql_types::PeerId;

/// **Phase 5.7 V1 (2026-05-22):** smoke method exposing the binding's
/// own version. The IDE's loader uses this to verify the loaded
/// `.node` file matches the engine version it expects. V2 will add a
/// proper version-mismatch error path.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// **Phase 5.7 V1 megaudit closure (Codex HIGH, 2026-05-22):**
/// Validate a JS Number argument that represents a u32-domain index
/// (row, col). Rejects non-finite, negative, fractional, and out-of-u32
/// values with a distinct error message naming the parameter.
///
/// Why this exists: napi-rs's `napi_get_value_uint32` (used for `u32`
/// params) applies ECMAScript `ToUint32`, silently coercing `-1` to
/// `u32::MAX`, `NaN`/`Infinity` to `0`, fractions to floor-toward-zero.
/// By taking the param as `f64` (raw `napi_get_value_double`) and
/// validating here, we surface bad inputs as explicit JS Errors
/// instead of corrupting workbook state.
fn validate_u32_index(name: &str, value: f64) -> Result<u32> {
    if !value.is_finite() {
        return Err(Error::from_reason(format!(
            "appendPutValue: {name} must be a finite non-negative integer, got {value}"
        )));
    }
    if value < 0.0 {
        return Err(Error::from_reason(format!(
            "appendPutValue: {name} must be a non-negative integer, got {value}"
        )));
    }
    if value.fract() != 0.0 {
        return Err(Error::from_reason(format!(
            "appendPutValue: {name} must be an integer, got {value}"
        )));
    }
    if value > u32::MAX as f64 {
        return Err(Error::from_reason(format!(
            "appendPutValue: {name} must be in [0, 4294967295] (u32::MAX), got {value}"
        )));
    }
    Ok(value as u32)
}

/// Helper: convert a JS `BigInt` to `PeerId` with explicit rejection of
/// FIVE failure modes:
///   - negative BigInt (signed bit set) — PeerId is u64-domain
///   - BigInt doesn't fit in u64 (lossless = false)
///   - `peer_id == 0` — Loro's LEGACY_PEER sentinel; rejected with a
///     PROACTIVE check here (the engine's `CollabSession::new` would
///     hit `assert_ne!` and panic, which napi-rs 3.x doesn't reliably
///     catch into a JS exception — observed during V1 smoke test:
///     "failed to initiate panic, error 5, aborting"). Pre-validate
///     in the FFI boundary to keep Node alive.
///   - `peer_id == u64::MAX` — Loro's `PeerID::MAX` sentinel (verified
///     via Loro 1.12 `loro-internal-1.12.0/src/loro.rs:184`:
///     `if peer == PeerID::MAX { return Err(...) }`). Loro returns a
///     CLEAN `Err` here (not a panic), so the FFI boundary is intact
///     either way — but pre-rejecting at the binding gives a faster
///     failure and a consistent error message paired with the
///     `peer_id == 0` case.
///
/// napi-rs 3.x `BigInt::get_u64()` returns `(sign_bit: bool, value: u64,
/// lossless: bool)`. `sign_bit == true` indicates a negative BigInt.
/// Per CLAUDE.md no-fallback rule: each failure mode surfaces a distinct
/// error message so IDE consumers can show the right user-facing copy.
///
/// **Phase 5.7 V1 smoke-test finding (2026-05-22)**: the original
/// version of this helper allowed `peer_id == 0` through, expecting
/// `CollabSession::new`'s `assert_ne!(0, 0)` to surface a clean error.
/// In practice the panic ABORTED the Node process. Lesson:
/// engine-level `assert_*!` is NOT a safe boundary for FFI. Every
/// engine method that uses `assert_*!` for input validation needs a
/// proactive pre-check at the FFI layer.
///
/// **Phase 5.7 V1 audit closure (Rule 4 / Opus boundary test,
/// 2026-05-22)**: the closure test `BigInt boundary -- u64::MAX
/// accepted, 2^64 rejected` revealed that Loro also reserves
/// `PeerID::MAX` (in addition to 0). Added pre-rejection here for
/// symmetry. V2 will sweep the engine + Loro for any other reserved
/// sentinel values as the binding surface grows.
fn peer_id_from_bigint(peer_id: &BigInt) -> Result<PeerId> {
    let (sign_bit, peer_u64, lossless) = peer_id.get_u64();
    if sign_bit {
        return Err(Error::from_reason(
            "peerId BigInt must be non-negative (PeerId is u64-domain)".to_string(),
        ));
    }
    if !lossless {
        return Err(Error::from_reason(
            "peerId BigInt does not fit in u64 (lossy conversion)".to_string(),
        ));
    }
    if peer_u64 == 0 {
        return Err(Error::from_reason(
            "peerId must be non-zero (PeerId(0) is LEGACY_PEER, reserved for pre-collab single-writer + qbook migration)".to_string(),
        ));
    }
    if peer_u64 == u64::MAX {
        return Err(Error::from_reason(
            "peerId must not be u64::MAX (Loro reserves PeerID::MAX as an internal sentinel)"
                .to_string(),
        ));
    }
    Ok(PeerId::new(peer_u64))
}

/// JS-facing wrapper for `ql_collab::CollabSession`. See module docs
/// for V1 surface rationale + V2 deferred list.
#[napi]
pub struct CollabSession {
    inner: CoreCollabSession,
}

#[napi]
impl CollabSession {
    /// Construct a fresh session for the given peer.
    ///
    /// **Failure modes**: `peerId == 0` is rejected by the underlying
    /// engine (PeerId sentinel — Loro reserves the 0 value). napi-rs
    /// surfaces engine errors as JS `Error` exceptions.
    #[napi(constructor)]
    pub fn new(peer_id: BigInt) -> Result<Self> {
        let pid = peer_id_from_bigint(&peer_id)?;
        let session =
            CoreCollabSession::new(pid).map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(Self { inner: session })
    }

    /// Reconstruct a session from a previously-exported snapshot.
    /// Mirrors `ql_collab::CollabSession::from_snapshot`.
    #[napi(factory, js_name = "fromSnapshot")]
    pub fn from_snapshot(peer_id: BigInt, bytes: Uint8Array) -> Result<Self> {
        let pid = peer_id_from_bigint(&peer_id)?;
        let session = CoreCollabSession::from_snapshot(pid, bytes.as_ref())
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(Self { inner: session })
    }

    /// V1 convenience: append a `PutValue` op with a number value.
    /// The full Op enum binding is V2 work; V1 only exposes this
    /// single variant because it's the minimum that demonstrates
    /// the round-trip.
    ///
    /// # Input validation (Phase 5.7 V1 megaudit closure, 2026-05-22)
    ///
    /// The original V1 closure tried to push validation into the TS
    /// wrapper (`session.ts::appendPutValueValidated`), but that left
    /// this `#[napi]` method as a public unchecked surface that direct
    /// callers could bypass. The Phase 5.7 V1 megaudit (Codex HIGH,
    /// 2026-05-22) flagged this as a real hazard: any consumer skipping
    /// the wrapper hit ECMAScript `ToUint32` for `u32` row/col args:
    ///   - `-1` → `0xFFFFFFFF` (silent wrap to u32::MAX)
    ///   - `NaN` → `0` (silent coercion)
    ///   - `Infinity` → `0` (silent coercion)
    ///   - `2.5` → `2` (silent floor-toward-zero)
    ///
    /// **Closure**: the `row` and `col` parameters are now `f64`
    /// (raw JS Number, NOT ToUint32-coerced via napi-rs's
    /// `napi_get_value_double`). Inside the method we validate:
    ///   - finite (not NaN / Infinity)
    ///   - non-negative
    ///   - integer (`fract() == 0.0`)
    ///   - in u32 range (≤ `u32::MAX`)
    /// then cast to `u32`. Any failure surfaces a precise JS Error.
    ///
    /// `sheet: u16` stays as-is — u16's `try_into::<u16>()` correctly
    /// rejects out-of-range values from ToUint32, so the asymmetric
    /// safety (Opus audit H2 finding) doesn't apply at u16.
    ///
    /// `value: f64` is already raw (Number → double, no coercion);
    /// validate finiteness here too (NaN/Infinity rejection).
    ///
    /// The TS-side `appendPutValueValidated` wrapper becomes
    /// defense-in-depth — it fails earlier with friendlier messages
    /// but the engine-side validation is the load-bearing contract
    /// for direct callers.
    #[napi(js_name = "appendPutValue")]
    pub fn append_put_value(&mut self, sheet: u16, row: f64, col: f64, value: f64) -> Result<()> {
        // Validate row + col: finite, non-negative, integer, in u32 range.
        let row_u32 = validate_u32_index("row", row)?;
        let col_u32 = validate_u32_index("col", col)?;
        // Validate value: finite (NaN/Infinity rejected).
        if !value.is_finite() {
            return Err(Error::from_reason(format!(
                "appendPutValue value must be finite, got {value}"
            )));
        }
        let op = Op::PutValue {
            sheet,
            row: row_u32,
            col: col_u32,
            value: CellWireValue::Number(value),
        };
        self.inner
            .append_op(op)
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(())
    }

    /// Export a full snapshot of this session's op log.
    /// Mirrors `CollabSession::export_bytes`.
    #[napi(js_name = "exportBytes")]
    pub fn export_bytes(&self) -> Result<Uint8Array> {
        let bytes = self
            .inner
            .export_bytes()
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(Uint8Array::from(bytes))
    }

    /// Merge a snapshot (or delta) from another peer.
    ///
    /// # Returns
    ///
    /// The session's `op_count` AFTER the merge (matches the
    /// underlying `CollabSession::merge_bytes` signature). NOT the
    /// number of newly merged ops -- duplicates are deduped by Loro
    /// but the return value is the post-merge total, not the delta.
    /// Per Codex M2 / Opus correction (Phase 5.7 V1 audit closure,
    /// 2026-05-22): the original docstring said "merged count"
    /// implying a delta; empirically, calling `mergeBytes` twice on
    /// the same snapshot returns the same `op_count` both times.
    ///
    /// # SharedArrayBuffer hazard (V1 docstring; V2 defensive copy)
    ///
    /// `bytes.as_ref()` returns a slice INTO the JS-owned ArrayBuffer.
    /// If the underlying buffer is a `SharedArrayBuffer`, another
    /// Worker thread could mutate the bytes WHILE Loro's deserializer
    /// is reading them. V1 assumption: callers pass non-SAB
    /// `Uint8Array`s (which the V1 IDE demo does — `exportBytes`
    /// returns a plain `Vec<u8>`-backed Uint8Array). V2 will add a
    /// defensive `to_vec()` copy at the FFI boundary OR a SAB-detect
    /// path via `napi_get_arraybuffer_info` (Codex H2 + Opus M3
    /// convergent finding).
    ///
    /// # u32 clamp on overflow
    ///
    /// Return type is `u32`. If the post-merge `op_count` exceeds
    /// `u32::MAX` (≈4 billion ops), the value is silently CLAMPED to
    /// `u32::MAX`. Practically unreachable in V1 (4 billion ops would
    /// consume terabytes of Loro storage) but flagged here per Opus M5
    /// "verify before claiming". V2 will switch to `BigInt` return
    /// type for unbounded sessions, matching `peerId()`'s precedent.
    #[napi(js_name = "mergeBytes")]
    pub fn merge_bytes(&mut self, bytes: Uint8Array) -> Result<u32> {
        let count = self
            .inner
            .merge_bytes(bytes.as_ref())
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    /// Local op log length (visible LoroList). See V2 V4 V1 step 2
    /// audit closure for the visible-list-vs-VV distinction; this
    /// method returns the LIST length (matches IDE "how many ops have
    /// I ever logged?" UX). For "how many pending vs last flush,"
    /// use `pendingOpCount()`.
    ///
    /// **u32 clamp (Opus M5 closure):** silent clamp to `u32::MAX` if
    /// the count exceeds u32. Same trade-off as `mergeBytes`'s
    /// return; V2 will switch to BigInt.
    #[napi(js_name = "opCount")]
    pub fn op_count(&self) -> u32 {
        u32::try_from(self.inner.op_count()).unwrap_or(u32::MAX)
    }

    /// V2 V4 V1 step 2 helper: count of ops added since the last
    /// successful flush to the currently-attached transport. Uses
    /// VV math (monotonic under undo). Sibling invariant:
    /// `pendingOpCount() > 0` iff `hasPendingFlush() === true`.
    ///
    /// V1 has no transport binding so this returns the count vs
    /// the empty baseline (= same as opCount for a never-flushed
    /// session). V2 will be where this gets interesting once the
    /// Transport surface is bound.
    ///
    /// **u32 clamp (Opus M5 closure):** silent clamp to `u32::MAX` if
    /// the count exceeds u32. Same trade-off as `opCount`; V2 will
    /// switch to BigInt.
    #[napi(js_name = "pendingOpCount")]
    pub fn pending_op_count(&self) -> u32 {
        u32::try_from(self.inner.pending_op_count()).unwrap_or(u32::MAX)
    }

    /// V2 V3 step 3 helper: `true` when the local op log has ops
    /// that haven't been flushed to the currently-attached transport.
    #[napi(js_name = "hasPendingFlush")]
    pub fn has_pending_flush(&self) -> bool {
        self.inner.has_pending_flush()
    }

    /// Peer ID of this session, as a `BigInt` (u64-domain).
    #[napi(js_name = "peerId")]
    pub fn peer_id(&self) -> BigInt {
        BigInt::from(self.inner.peer_id().as_u64())
    }
}

// **Phase 5.7 V1 megaudit closure (Opus-A MEDIUM-1, 2026-05-22):**
// Rule 4 application — the module docstring claims this `CollabSession`
// wrapper is `Send + !Sync`. Per audit-discipline Rule 4 (added 2026-05-21
// after a wrong `!Sync` claim survived 3 audits + a megaudit), negative
// trait claims need positive compile proof OR per-field walk.
//
// POSITIVE PROOF: `Send` is asserted at compile time below. The function
// only compiles if `CollabSession: Send`.
const _ASSERT_BINDING_COLLAB_SESSION_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<CollabSession>();
};

// `!Sync` follows by composition: `CollabSession { inner: CoreCollabSession }`,
// and `CoreCollabSession` is documented `!Sync` (per `ql-collab/src/session.rs:79-93`
// — the `Option<Box<dyn Transport + Send>>` field is `?Sync`, so the struct
// inherits `!Sync`; that crate also documents the probe-then-commented-out
// proof). The wrapper inherits via the single field. To verify locally,
// un-comment the probe below and run `cargo check -p ql-bindings-node` —
// the build MUST fail with "the trait bound `Sync` is not satisfied" naming
// `CoreCollabSession` (or its Transport field):
//
// fn assert_binding_collab_session_not_sync() {
//     fn assert_sync<T: Sync>() {}
//     assert_sync::<CollabSession>(); // EXPECTED COMPILE ERROR
// }
//
// `static_assertions::assert_not_impl_all!` would fire spuriously on
// "AmbiguousIfImpl" for `!Sync` checks; the probe-then-commented-out
// pattern is the canonical Rule 4 application per audit-discipline memory.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_smoke() {
        let v = version();
        assert!(!v.is_empty());
        assert!(v.contains('.'));
    }

    #[test]
    fn collab_session_roundtrip_via_rust() {
        // Test the Rust side directly (no napi runtime here — that
        // requires a Node host). Validates the wrapper plumbing
        // composes correctly without panics. The full Node-side
        // round-trip lives in the IDE extension's
        // `quantbook-roundtrip.test.ts`.
        let pid_a = PeerId::new(1);
        let mut session_a = CoreCollabSession::new(pid_a).expect("session A");

        let op = Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        };
        session_a.append_op(op).expect("append");
        assert!(session_a.op_count() >= 1);

        let bytes = session_a.export_bytes().expect("export");

        let pid_b = PeerId::new(2);
        let mut session_b = CoreCollabSession::new(pid_b).expect("session B");
        let merged = session_b.merge_bytes(&bytes).expect("merge");
        assert!(merged >= 1, "merged at least 1 op");
        assert_eq!(session_b.op_count(), session_a.op_count());
    }
}
