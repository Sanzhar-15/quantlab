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
//!   - `Uint8Array <-> Vec<u8>` for snapshot bytes (zero-copy on read,
//!     clone on write per napi-rs default)
//!   - panic safety: napi-rs wraps each `#[napi]` entry point in a
//!     `catch_unwind` and surfaces panics as JS exceptions (no Node
//!     process crash).
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
//! ## V1 deferred (see `.plans/_active.md`)
//!
//! Transport binding (LoopbackTransport, WebSocketTransport),
//! undo/redo, presence, full Op enum, format IDs, `rebuild_workbook`
//! (D-3 production-visible closure), all flush_* methods. V2 picks
//! these up.
//!
//! ## Send + Sync
//!
//! `CollabSession` is `Send + !Sync` (verified per V2 V4 V1 step 3 +
//! audit-discipline Rule 4 in the engine's audit memory). napi-rs's
//! generated class wraps each instance in a per-JS-object slot
//! accessed under napi's internal locking; we don't need `Sync` for
//! the binding to work — JS code can hold the object across an `await`
//! but cannot call methods concurrently (napi enforces this).

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

/// Helper: convert a JS `BigInt` to `PeerId` with explicit rejection of
/// FOUR failure modes:
///   - negative BigInt (signed bit set) — PeerId is u64-domain
///   - BigInt doesn't fit in u64 (lossless = false)
///   - `peer_id == 0` — Loro's LEGACY_PEER sentinel; rejected with a
///     PROACTIVE check here (the engine's `CollabSession::new` would
///     hit `assert_ne!` and panic, which napi-rs 3.x doesn't reliably
///     catch into a JS exception — observed during V1 smoke test:
///     "failed to initiate panic, error 5, aborting"). Pre-validate
///     in the FFI boundary to keep Node alive.
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
/// proactive pre-check at the FFI layer. V2 will sweep the engine for
/// similar assertions (PeerId(0) is the only known one today).
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
    #[napi(js_name = "appendPutValue")]
    pub fn append_put_value(&mut self, sheet: u16, row: u32, col: u32, value: f64) -> Result<()> {
        let op = Op::PutValue {
            sheet,
            row,
            col,
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
    /// Returns the number of ops actually merged (Loro dedupes).
    /// Mirrors `CollabSession::merge_bytes`.
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
