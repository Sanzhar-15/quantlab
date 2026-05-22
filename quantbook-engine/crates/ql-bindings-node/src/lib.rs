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
//! **V2.4 (2026-05-22) UPDATE**: `CollabSession` is now `Send + Sync`
//! (was `Send + !Sync` in V1+V2.1+V2.2+V2.3). The shape changed in V2.4
//! from `inner: CoreCollabSession` to `inner: Arc<parking_lot::Mutex<CoreCollabSession>>`
//! as the closure for V2.3 audit's HIGH-1 (Rust UB via napi `&mut self`
//! async re-entry). The Arc<Mutex> composition adds Sync via interior
//! mutability — multiple shared `&CollabSession` references are sound;
//! mutation flows through the Mutex.
//!
//! **Compile-asserted proof** (lib.rs near end of file): both Send AND
//! Sync are pinned via `assert_send + assert_sync` const-fn pattern.
//! Per Rule 4: positive proof is required (this is the V2.4
//! re-pinning of what was V1's `!Sync` claim).
//!
//! **Underlying composition** (Send + Sync verified by source-walks):
//!   - `CoreCollabSession: Send + !Sync` (engine claim at
//!     `ql-collab/src/session.rs:87`, unchanged).
//!   - `parking_lot::Mutex<T>: Send + Sync` when `T: Send`
//!     (verified per `lock_api-0.4.14/src/mutex.rs:144`'s
//!     `impl<R: RawMutex + Sync, T: Send> Sync for Mutex<R, T>`).
//!   - `Arc<T>: Send + Sync` when `T: Send + Sync`.
//!   - Therefore the V2.4 binding wrapper composition is `Send + Sync`.
//!
//! **V2.4 V8-block hazard (Opus V2.4 HIGH-1, NOT runtime-unsound)**:
//! all napi methods on `CollabSession` acquire `self.inner.lock()`.
//! While `flushPendingToTransport`'s spawn_blocking task holds the
//! mutex during a Condvar wait (potentially seconds), JS sync method
//! calls on the SAME session block the V8 event loop waiting for the
//! lock. The IDE UI freezes for the wait duration. This is a UX
//! hazard, not a soundness hazard. V2.5+ work plan documented at the
//! `flushPendingToTransport` method below. The TS-side caller
//! discipline today is: don't call other session methods while
//! `flushPendingToTransport` is awaiting.

#![deny(clippy::all)]
#![allow(clippy::missing_safety_doc)] // napi-rs generated wrappers

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;

use ql_collab::AutoFlushPolicy as CoreAutoFlushPolicy;
use ql_collab::CollabSession as CoreCollabSession;
use ql_collab::LoopbackTransport;
use ql_collab::Transport as CoreTransport;
use ql_collab_ws::WebSocketTransport;
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
/// Validate a JS Number argument that represents a u32-domain value.
/// Rejects non-finite, negative, fractional, and out-of-u32 values
/// with a distinct error message naming the calling method + parameter.
///
/// Why this exists: napi-rs's `napi_get_value_uint32` (used for `u32`
/// params) applies ECMAScript `ToUint32`, silently coercing `-1` to
/// `u32::MAX`, `NaN`/`Infinity` to `0`, fractions to floor-toward-zero.
/// By taking the param as `f64` (raw `napi_get_value_double`) and
/// validating here, we surface bad inputs as explicit JS Errors
/// instead of corrupting workbook state.
///
/// **V2.2 audit closure (Codex LOW-1, 2026-05-22)**: added `method`
/// context parameter so the error message names the actual calling
/// method. Prior version hard-coded `"appendPutValue"` which produced
/// confusing diagnostics when called from `pollRemoteWithLimit`.
fn validate_u32_index(method: &str, name: &str, value: f64) -> Result<u32> {
    if !value.is_finite() {
        return Err(Error::from_reason(format!(
            "{method}: {name} must be a finite non-negative integer, got {value}"
        )));
    }
    if value < 0.0 {
        return Err(Error::from_reason(format!(
            "{method}: {name} must be a non-negative integer, got {value}"
        )));
    }
    if value.fract() != 0.0 {
        return Err(Error::from_reason(format!(
            "{method}: {name} must be an integer, got {value}"
        )));
    }
    if value > u32::MAX as f64 {
        return Err(Error::from_reason(format!(
            "{method}: {name} must be in [0, 4294967295] (u32::MAX), got {value}"
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

/// JS-facing wrapper for `ql_collab::CollabSession`.
///
/// **V2.4 refactor (2026-05-22)**: holds `Arc<Mutex<CoreCollabSession>>`
/// instead of `CoreCollabSession` directly. Closes V2.3 audit Codex+Opus
/// HIGH-1 (Rust UB via napi `&mut self` async re-entry) by:
///   - All napi methods take `&self` (not `&mut self`). napi-rs's
///     generated wrappers never produce two `&'static mut` to the same
///     CollabSession; the Arc + Mutex absorbs the mutation.
///   - Sync methods: `self.inner.lock()` acquires + holds the mutex
///     within the method body. parking_lot's Mutex is uncontended-fast
///     and never poisons.
///   - Async methods: `Arc::clone(&self.inner)` + `tokio::task::spawn_blocking`.
///     The clone-and-move pattern means the spawned task owns its own
///     `Arc` reference; the blocking lock acquisition happens off the
///     tokio runtime's worker pool (closes V2.3 HIGH-2 tokio starvation).
///
/// **Send + Sync (V2.4 update)**: the new shape is `Send + Sync` (was
/// `Send + !Sync` in V1+V2.1+V2.2). Sync now holds because
/// `Arc<Mutex<T>>: Sync` when `T: Send`, regardless of T: Sync. JS
/// single-threadedness still holds in practice; the Send + Sync bound
/// is a strict improvement (Rule 4 pin updated below).
#[napi]
pub struct CollabSession {
    inner: Arc<Mutex<CoreCollabSession>>,
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
        Ok(Self {
            inner: Arc::new(Mutex::new(session)),
        })
    }

    /// Reconstruct a session from a previously-exported snapshot.
    /// Mirrors `ql_collab::CollabSession::from_snapshot`.
    #[napi(factory, js_name = "fromSnapshot")]
    pub fn from_snapshot(peer_id: BigInt, bytes: Uint8Array) -> Result<Self> {
        let pid = peer_id_from_bigint(&peer_id)?;
        let session = CoreCollabSession::from_snapshot(pid, bytes.as_ref())
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(session)),
        })
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
    pub fn append_put_value(&self, sheet: u16, row: f64, col: f64, value: f64) -> Result<()> {
        // Validate row + col: finite, non-negative, integer, in u32 range.
        let row_u32 = validate_u32_index("appendPutValue", "row", row)?;
        let col_u32 = validate_u32_index("appendPutValue", "col", col)?;
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
        let mut inner = self.inner.lock();
        inner
            .append_op(op)
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(())
    }

    /// Export a full snapshot of this session's op log.
    /// Mirrors `CollabSession::export_bytes`.
    #[napi(js_name = "exportBytes")]
    pub fn export_bytes(&self) -> Result<Uint8Array> {
        let inner = self.inner.lock();
        let bytes = inner
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
    pub fn merge_bytes(&self, bytes: Uint8Array) -> Result<u32> {
        let mut inner = self.inner.lock();
        let count = inner
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
        let inner = self.inner.lock();
        u32::try_from(inner.op_count()).unwrap_or(u32::MAX)
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
        let inner = self.inner.lock();
        u32::try_from(inner.pending_op_count()).unwrap_or(u32::MAX)
    }

    /// V2 V3 step 3 helper: `true` when the local op log has ops
    /// that haven't been flushed to the currently-attached transport.
    #[napi(js_name = "hasPendingFlush")]
    pub fn has_pending_flush(&self) -> bool {
        let inner = self.inner.lock();
        inner.has_pending_flush()
    }

    /// Peer ID of this session, as a `BigInt` (u64-domain).
    #[napi(js_name = "peerId")]
    pub fn peer_id(&self) -> BigInt {
        let inner = self.inner.lock();
        BigInt::from(inner.peer_id().as_u64())
    }

    // ==========================================================
    // Phase 5.7 V2.1 (2026-05-22) — Transport surface
    // ==========================================================

    /// Attach a Transport to this session. Moves the inner boxed trait
    /// object out of the `transport` wrapper (consuming it from JS's
    /// perspective — subsequent calls fail).
    ///
    /// Mirrors `CollabSession::attach_transport_boxed` on the Rust side
    /// which delegates to the V2 V3 step 1 baseline-reset path: the
    /// next flush sends from empty VV (i.e., ALL local ops including
    /// any appended while no transport was attached — Loro's CRDT op
    /// log IS the implicit offline queue).
    ///
    /// V2.1 does NOT return the prior transport (if any) to JS. The
    /// Rust side drops the returned `Box` immediately. Rationale: the
    /// IDE has no use for the opaque prior transport, and exposing it
    /// would require either creating another `Transport` wrapper
    /// (defeating "this transport is now invalid" semantics) or a
    /// special-cased "detached prior" type. V2.3+ may revisit if a use
    /// case emerges.
    ///
    /// **Failure modes**:
    /// - `transport` has already been used (its `inner` is `None`) →
    ///   JS Error "Transport has already been consumed".
    #[napi(js_name = "attachTransport")]
    pub fn attach_transport(&self, transport: &mut Transport) -> Result<()> {
        let boxed = transport.take_inner().ok_or_else(|| {
            // V2.1 audit closure (Codex LOW-1, 2026-05-22): error wording
            // standardized. A "spent LoopbackPair" throws at takeA/takeB
            // BEFORE producing a Transport — so a consumed Transport
            // wrapper must have come from attachTransport (or a future
            // consumer added in V2.3+).
            Error::from_reason("Transport has already been consumed by attachTransport".to_string())
        })?;
        // attach_transport_boxed handles baseline-reset + replacement.
        // The Option<Box> it returns is the PRIOR transport; we drop
        // it here intentionally (see method docstring).
        let mut inner = self.inner.lock();
        let _prior = inner.attach_transport_boxed(boxed);
        Ok(())
    }

    /// Detach the currently-attached transport. Returns `true` if one
    /// was attached (now released), `false` if there was nothing to
    /// detach.
    ///
    /// **Background-task lifecycle (V2 V3 step 5 closure)**: detaching
    /// a `WebSocketTransport` (V2.3+) drops its reader + writer tasks.
    /// V2.1's LoopbackTransport has no background tasks; detach is
    /// pure memory release.
    ///
    /// The returned `Box<dyn Transport>` is dropped Rust-side. JS does
    /// NOT receive the prior transport — same rationale as
    /// `attachTransport`.
    #[napi(js_name = "detachTransport")]
    pub fn detach_transport(&self) -> bool {
        let mut inner = self.inner.lock();
        inner.detach_transport().is_some()
    }

    /// `true` iff a transport is currently attached.
    #[napi(js_name = "hasTransport")]
    pub fn has_transport(&self) -> bool {
        let inner = self.inner.lock();
        inner.has_transport()
    }

    /// Full-snapshot flush to the attached transport. Sends the entire
    /// op log as bytes. Returns `true` if bytes were actually sent.
    ///
    /// **Use `flushDeltaToTransport` instead in production** —
    /// full-snapshot flushes get expensive as the op log grows. V2.1
    /// exposes this method primarily for tests and "initial sync"
    /// scenarios; V2.2 ships the delta path.
    ///
    /// **Failure modes**:
    /// - No transport attached → returns `Ok(false)` (NOT an error).
    /// - Transport's `send` returns `Err(TransportError::*)` → JS Error.
    #[napi(js_name = "flushToTransport")]
    pub fn flush_to_transport(&self) -> Result<bool> {
        let mut inner = self.inner.lock();
        inner
            .flush_to_transport()
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Drain inbound BLOBS from the attached transport (single-pass).
    /// Returns the number of BLOBS drained (NOT the number of ops),
    /// capped by the engine's default poll limit (`DEFAULT_POLL_REMOTE_LIMIT
    /// = 64`). Each blob is one snapshot/delta that may contain many ops;
    /// to count ops, compare `opCount()` before vs after.
    ///
    /// **V2.1 audit closure (Codex MEDIUM-1, 2026-05-22)**: the prior
    /// docstring claimed "number of ops merged" which was wrong — the
    /// engine's `poll_remote_with_limit` returns blob count (`merged <=
    /// max_blobs` per its own doc). Mocha test "three-mutation chain
    /// across LoopbackPair" found this empirically (asserting `>= 3`
    /// failed against the actual blob-count semantics). The variable
    /// names + JSDoc here now use "blobs" consistently.
    ///
    /// V2.1 ships the un-limited variant (engine default cap = 64).
    /// `pollRemoteWithLimit(limit)` lands in V2.2.
    ///
    /// **Auto-flush integration (V2 V3 step 2)**: when AutoFlushPolicy
    /// is `OnAppend` and `blobs_drained > 0`, the underlying call also
    /// fires one delta flush back through the transport (idempotency
    /// guard prevents echo loops). V2.1 doesn't bind AutoFlushPolicy yet
    /// — V2.2 does.
    ///
    /// **Failure modes**:
    /// - No transport attached → returns `Ok(0)` (NOT an error).
    /// - Transport's `try_recv` returns `Err` → JS Error.
    /// - Merging the bytes returns Err → JS Error.
    #[napi(js_name = "pollRemote")]
    pub fn poll_remote(&self) -> Result<u32> {
        let mut inner = self.inner.lock();
        let blobs_drained = inner
            .poll_remote()
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(u32::try_from(blobs_drained).unwrap_or(u32::MAX))
    }

    // ==========================================================
    // Phase 5.7 V2.2 (2026-05-22) — full sync Transport surface
    // ==========================================================

    /// Delta flush to the attached transport. Sends ONLY the ops added
    /// since the last successful flush (via Loro's `ExportMode::Updates`
    /// from this session's `last_flushed_vv`). Returns `true` if bytes
    /// were actually sent.
    ///
    /// **This is the production default**; prefer it over
    /// `flushToTransport` (full-snapshot) which is O(full state). Delta
    /// flushes are O(per-op delta).
    ///
    /// **Idempotency short-circuit**: if `last_flushed_vv == Some(current)`
    /// — i.e., a previous flush already advanced the baseline to the
    /// current state — returns `Ok(false)` without invoking
    /// `transport.send`. Closes the V2 V2 audit echo-loop concern.
    ///
    /// **First flush after attach ALWAYS sends** even on an empty op
    /// log: attach resets `last_flushed_vv = None`, so the idempotency
    /// guard (which checks `Some(last_vv) == current_vv`) is bypassed.
    /// The first call encodes from the empty VV — for an empty op log
    /// this is a small baseline blob; for a non-empty log it's the
    /// full state. V2.2 mocha test
    /// `flushDeltaToTransport second call with no state change
    /// short-circuits to false` pins this exact contract.
    ///
    /// **Per Phase 5.5 V2 V3 step 1 contract**: attach_transport resets
    /// the per-session-per-transport `last_flushed_vv` to None. The
    /// next call to `flushDeltaToTransport` after an attach sends from
    /// the empty VV — delivering ALL local ops including any appended
    /// while offline (Loro's CRDT op log IS the implicit offline queue).
    ///
    /// **Failure modes**:
    /// - No transport attached → returns `Ok(false)` (NOT an error).
    /// - Transport's `send` returns `Err(TransportError::*)` → JS Error.
    #[napi(js_name = "flushDeltaToTransport")]
    pub fn flush_delta_to_transport(&self) -> Result<bool> {
        let mut inner = self.inner.lock();
        inner
            .flush_delta_to_transport()
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Like `pollRemote` but with an explicit cap on the number of
    /// blobs to drain per call. Returns the number of BLOBS drained
    /// (NOT ops), `<= limit`.
    ///
    /// **Limit semantics** (per engine docstring):
    /// - `limit == 0` → no-op, returns `Ok(0)` even if blobs queued.
    /// - If the returned count equals `limit`, more blobs may still
    ///   be queued — call again.
    /// - If less, the queue drained (either empty or transport
    ///   reported `Closed`).
    ///
    /// **Input validation** (per V1 megaudit closure pattern):
    /// `limit` takes `f64` to avoid napi-rs's `napi_get_value_uint32`
    /// ECMAScript ToUint32 silent coercion (`-1 → u32::MAX`, etc.).
    /// Validated finite + non-negative + integer + in `usize` range
    /// (on 64-bit systems usize = u64; we cap at u32::MAX for cross-
    /// platform safety).
    ///
    /// **Failure modes**:
    /// - No transport attached → returns `Ok(0)`.
    /// - `limit` not a finite non-negative integer in u32 range → JS Error.
    /// - Transport's `try_recv` returns `Err` → JS Error.
    #[napi(js_name = "pollRemoteWithLimit")]
    pub fn poll_remote_with_limit(&self, limit: f64) -> Result<u32> {
        let limit_u32 = validate_u32_index("pollRemoteWithLimit", "limit", limit)?;
        let mut inner = self.inner.lock();
        let blobs_drained = inner
            .poll_remote_with_limit(limit_u32 as usize)
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(u32::try_from(blobs_drained).unwrap_or(u32::MAX))
    }

    /// Returns the attached transport's most recent error message, or
    /// `null` if either no transport is attached OR the transport
    /// reports no error.
    ///
    /// **Use case**: IDE reconnect handshakes — after a mutator or
    /// `flush_*_to_transport` returns a JS Error containing
    /// "transport closed" (or similar), the IDE can call this to
    /// distinguish underlying causes (`"peer reset"` vs
    /// `"capacity exceeded"` for `WebSocketTransport`, etc.) and pick
    /// the right retry strategy.
    ///
    /// **V2.2 audit-deferred caveat (Opus MEDIUM-3, 2026-05-22)**:
    /// the engine surfaces errors as `Display` strings (lossy
    /// projection of the underlying enum discriminant). IDE callers
    /// today must substring-match to distinguish error categories.
    /// V2.3+ will add structured discrimination via napi `Error::with_code`
    /// (`#[napi(constructor)]` on a `TransportClosedError` etc.).
    /// For V2.2 the string is the contract.
    #[napi(js_name = "transportLastError")]
    pub fn transport_last_error(&self) -> Option<String> {
        let inner = self.inner.lock();
        inner.transport_last_error()
    }

    /// Set the auto-flush policy. Returns the prior policy.
    ///
    /// **Accepted strings**: `"disabled"` (default) or `"onAppend"`.
    /// Any other string returns a JS Error listing the accepted values.
    ///
    /// **`"onAppend"` semantics** (Phase 5.5 V2 V2 + V2 V3 steps 1+2):
    /// every public mutator (`append_op`, `merge_bytes`,
    /// `update_presence`, `clear_presence`, `sweep_presence`, `undo`,
    /// `redo`, `poll_remote`, `poll_remote_with_limit`) auto-fires a
    /// delta flush after the mutation. Idempotency short-circuits
    /// no-op state changes; `poll_remote*` fires the flush once after
    /// the batch (not per-blob).
    ///
    /// **Why string union over enum**: napi-rs binds Rust enums as
    /// JS objects with a discriminant field, which is verbose for
    /// 2-variant enums. The string-union approach is JS-idiomatic and
    /// easy to test. Forward-compat: the engine's `AutoFlushPolicy`
    /// is `#[non_exhaustive]` so future variants won't break this
    /// binding — they'll just be unparseable by this method until V2.3+
    /// adds string mappings.
    ///
    /// **Accepted alias forms (engine-side leniency)**: the engine
    /// parser also accepts `"Disabled"`, `"OnAppend"`, `"on-append"`
    /// as aliases for the canonical camelCase. The return value is
    /// always canonical camelCase. JS callers SHOULD pass the
    /// canonical forms (`"disabled"` / `"onAppend"`) only; the IDE-side
    /// `isAutoFlushPolicy` type guard enforces this on the TS side
    /// (rejects aliases). The lenient parser exists for engine-
    /// internal callers and config-file backward-compat — not as a
    /// public IDE contract. V2.2 audit closure (Opus HIGH-2): the
    /// alias-acceptance is NOT pinned by the IDE mocha tests; engine-
    /// side tests cover the parser.
    ///
    /// **Partial-state error contract (Codex MEDIUM-3 closure)**:
    /// under `onAppend`, a mutator call sequence is "1. commit local
    /// op → 2. flush to transport". If step 2 throws
    /// `Error("transport closed")`, the local op is ALREADY committed
    /// (step 1 succeeded). IDE retry logic must:
    /// - NOT retry the original mutation (would duplicate the op).
    /// - Reconnect the transport + call `flushDeltaToTransport`
    ///   explicitly to flush the pending op.
    /// V2.3+ will add structured `Error.code` discrimination so this
    /// retry-shape is machine-readable; until then, the IDE must
    /// substring-match `"transport"` in the error message.
    #[napi(js_name = "setAutoFlushPolicy")]
    pub fn set_auto_flush_policy(&self, policy: String) -> Result<String> {
        let policy_enum = parse_auto_flush_policy(&policy)?;
        let mut inner = self.inner.lock();
        let prior = inner.set_auto_flush_policy(policy_enum);
        // V2.2 audit closure (Opus HIGH-1): auto_flush_policy_to_string
        // now returns Result and throws on unknown variants. Propagate
        // the Result.
        auto_flush_policy_to_string(prior)
    }

    /// Read the current auto-flush policy. Returns one of
    /// `"disabled"` or `"onAppend"` (see `setAutoFlushPolicy`).
    ///
    /// **V2.2 audit closure (Opus HIGH-1, 2026-05-22)**: throws JS Error
    /// instead of returning a `'unknown'` sentinel when the engine
    /// reports a variant unknown to this binding (forward-compat skew
    /// between engine and binding crate versions). Per CLAUDE.md
    /// no-fallback rule: silent fall-through to `'unknown'` would
    /// cause JS code `policy === 'onAppend'` to silently take the
    /// `disabled` branch — corrupting reconnect logic. Throwing
    /// surfaces the skew loudly and forces a binding upgrade.
    #[napi(js_name = "autoFlushPolicy")]
    pub fn auto_flush_policy(&self) -> Result<String> {
        let inner = self.inner.lock();
        auto_flush_policy_to_string(inner.auto_flush_policy())
    }

    // ==========================================================
    // Phase 5.7 V2.4 (2026-05-22) — async Transport surface, REINTRODUCED
    // ==========================================================
    //
    // **V2.4 closure of V2.3 audit (2026-05-22)**: V2.3 shipped
    // `flushPendingToTransport` as `pub async unsafe fn(&mut self)`,
    // then REMOVED it in the V2.3 closure after Codex FAIL + Opus
    // PASS-WITH-FINDINGS converged on 2 HIGH (Rust UB via napi
    // `&mut self` async re-entry + tokio runtime starvation).
    //
    // V2.4 reintroduces via **Option (a) from V2.3's closure plan**:
    // engine refactor to `Arc<parking_lot::Mutex<CoreCollabSession>>`.
    // This refactor (above) converted ALL CollabSession napi methods
    // from `&mut self` to `&self` with internal `inner.lock()`. The
    // napi-rs codegen now produces `&'static CollabSession` (immutable
    // shared) instead of `&'static mut CollabSession` — no aliasing
    // hazard at all, since multiple `&` to the same instance are
    // sound by Rust's rules.
    //
    // For the async method specifically:
    //   - `&self` (not `&mut self`) → napi-rs no longer requires
    //     `unsafe`, AND no aliasing UB possible.
    //   - `Arc::clone(&self.inner)` → spawn_blocking → `lock()` inside
    //     the blocking task. The Condvar wait runs on a dedicated
    //     blocking thread (NOT a tokio worker), closing V2.3 HIGH-2.
    //   - The `Arc + Mutex` composition is `Send + Sync` (Mutex<T>:
    //     Send + Sync when T: Send), so the clone-and-move into
    //     spawn_blocking is sound.

    /// Async flush-pending — waits for the attached transport's writer
    /// task to drain (level-1 local ack per V2 V4 V1 Tier K1 contract).
    ///
    /// Returns a JS `Promise<void>` that resolves when:
    /// - the writer has completed `send` for every queued blob, OR
    /// - the transport has been detached / dropped / errored.
    ///
    /// **V2.4 soundness** (closes V2.3 audit Codex+Opus HIGH-1+HIGH-2):
    ///
    /// - Takes `&self` (not `&mut self`). napi-rs codegen produces
    ///   `&'static CollabSession` → multiple aliasing reads are sound
    ///   by Rust's rules. No UB even under JS re-entry.
    /// - `Arc::clone(&self.inner)` extracts a cloned reference to the
    ///   inner `Arc<Mutex<CoreCollabSession>>`. The clone is moved into
    ///   `tokio::task::spawn_blocking`, which runs on a dedicated
    ///   blocking thread (NOT a tokio worker). The Condvar wait
    ///   doesn't occupy the napi-rs runtime's worker pool — closes
    ///   V2.3 HIGH-2 (runtime starvation).
    /// - Inside the blocking task, `inner.lock()` acquires the mutex.
    ///   If a concurrent JS call holds the lock (e.g., another
    ///   mid-flight method), this call blocks until the lock is
    ///   available. No deadlock because mutex order is consistent
    ///   (all session methods acquire the SAME mutex).
    ///
    /// **Failure modes**:
    /// - No transport attached → returns `Ok(())` (NOT a rejection).
    /// - Transport error during the wait → JS Error.
    /// - The `spawn_blocking` task panics → JS Error.
    ///
    /// **V2.4 V8-block hazard (Opus V2.4 HIGH-1, 2026-05-22)** — known
    /// trade-off, documented for caller discipline:
    ///
    /// While this method's `spawn_blocking` task holds `self.inner.lock()`
    /// during a Condvar wait (the engine's `flush_pending_to_transport`
    /// blocks on writer-progress; can be seconds for slow WS peers),
    /// concurrent JS sync method calls on the SAME session block the
    /// V8 event loop on lock acquisition. IDE UI freezes for the wait
    /// duration.
    ///
    /// This is a UX hazard, NOT a soundness hazard (V2.3 audit's UB
    /// hazard remains closed; V2.4 just trades it for a contention
    /// hazard).
    ///
    /// **Caller discipline (today)**: don't call other `CollabSession`
    /// methods on the same session while a `flushPendingToTransport`
    /// promise is pending. Queue the calls behind the await.
    ///
    /// **V2.5+ engine refactor plan**: move the Condvar wait out of
    /// `&mut self` exclusive access — either (a) clone an
    /// `Arc<Transport>` inside the lock and release before waiting, or
    /// (b) replace Condvar with `tokio::sync::Notify` so the wait
    /// becomes truly async (no lock held). V2.5 will pick based on
    /// the engine's writer-task lifecycle constraints.
    #[napi(js_name = "flushPendingToTransport")]
    pub async fn flush_pending_to_transport(&self) -> Result<()> {
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let mut guard = inner.lock();
            guard.flush_pending_to_transport()
        })
        .await
        .map_err(|e| Error::from_reason(format!("flushPendingToTransport task: {e}")))?
        .map_err(|e| Error::from_reason(format!("{e}")))
    }
}

/// Phase 5.7 V2.2 (2026-05-22) — parse a JS string into
/// [`CoreAutoFlushPolicy`]. JS-idiomatic camelCase + lowercase aliases
/// accepted. Rejects unknown strings with a precise error.
fn parse_auto_flush_policy(s: &str) -> Result<CoreAutoFlushPolicy> {
    match s {
        "disabled" | "Disabled" => Ok(CoreAutoFlushPolicy::Disabled),
        "onAppend" | "on-append" | "OnAppend" => Ok(CoreAutoFlushPolicy::OnAppend),
        other => Err(Error::from_reason(format!(
            "AutoFlushPolicy must be 'disabled' or 'onAppend', got {other:?}"
        ))),
    }
}

/// Phase 5.7 V2.2 (2026-05-22) — render [`CoreAutoFlushPolicy`] as a JS
/// string. Uses canonical camelCase form ("disabled", "onAppend").
///
/// **V2.2 audit closure (Opus HIGH-1, 2026-05-22)**: returns `Result`
/// and throws a JS Error when the engine reports a variant unknown to
/// this binding (forward-compat skew). The prior version returned a
/// `'unknown'` sentinel string — a silent fall-through that violated
/// CLAUDE.md's no-fallback rule. JS code doing `policy === 'onAppend'`
/// would silently miss the new variant and fall through to the
/// `disabled` branch, corrupting reconnect / sync logic. Throwing is
/// the correct fail-loudly path: an engine that ships a new variant
/// ahead of the binding being upgraded surfaces the skew on first
/// `autoFlushPolicy()` call.
///
/// The engine's `AutoFlushPolicy` is `#[non_exhaustive]` so V2.3+ must
/// add new variants here when the engine ships them. The compile-time
/// match-exhaustiveness check helps but doesn't catch new variants
/// (because `#[non_exhaustive]` forces the catch-all arm).
fn auto_flush_policy_to_string(p: CoreAutoFlushPolicy) -> Result<String> {
    match p {
        CoreAutoFlushPolicy::Disabled => Ok("disabled".to_string()),
        CoreAutoFlushPolicy::OnAppend => Ok("onAppend".to_string()),
        // Throw on unknown variant rather than silently returning a
        // sentinel. See V2.2 audit closure note above for rationale.
        other => Err(Error::from_reason(format!(
            "autoFlushPolicy: engine reported unknown variant {other:?} — \
             this binding crate ({}) is older than the engine; upgrade \
             ql-bindings-node to add the new variant's JS string mapping",
            env!("CARGO_PKG_VERSION"),
        ))),
    }
}

// =============================================================
// Phase 5.7 V2.1 (2026-05-22) — Transport binding
// =============================================================

/// JS-facing opaque wrapper for a `Box<dyn ql_collab::Transport + Send>`.
///
/// **Design rationale (Phase 5.7 V1 megaudit Opus-B HIGH-2 closure,
/// 2026-05-22)**: napi-rs cannot bind generic functions. The engine's
/// `CollabSession::attach_transport<T>` accepts any `T: Transport + Send +
/// 'static`. To make this reachable from JS we:
///   1. Added `CollabSession::attach_transport_boxed(Box<dyn Transport + Send>)`
///      on the Rust side as a sibling entry point (V2.1 cycle).
///   2. Expose this opaque `Transport` class wrapping the boxed trait
///      object. JS code obtains instances from static factories
///      (`Transport.loopbackPair()` here; `Transport.websocketConnect(url)`
///      in V2.3) and passes them to `CollabSession.attachTransport(t)`.
///
/// **Single-use semantics**: an instance owns its boxed trait object.
/// `CollabSession.attachTransport` MOVES the box out of this wrapper,
/// leaving it consumed. Subsequent attach calls with the same wrapper
/// return a JS Error ("Transport has already been consumed by attachTransport").
/// This mirrors Rust ownership semantics within the constraint that JS
/// doesn't have a move primitive.
///
/// **Why opaque (no introspection methods)**: the inner `Box<dyn Transport>`
/// is a fat pointer to one of several impls (Loopback, WebSocket, ...).
/// V2.1 doesn't expose impl-specific accessors; future versions can add
/// `kind() -> string` if a use case emerges.
#[napi]
pub struct Transport {
    // `Option` so we can move the inner Box out at attach time without
    // dropping the wrapper. napi-rs's class instance has `&mut self`
    // discipline (per V1 module docs Send+!Sync rationale) — we cannot
    // consume `self` from a `#[napi]` method, only take from an Option.
    inner: Option<Box<dyn CoreTransport + Send>>,
}

#[napi]
impl Transport {
    /// `true` while this wrapper still owns its inner transport (not yet
    /// passed to `attachTransport`). Useful for IDE code that wants to
    /// branch on whether a Transport instance is still usable without
    /// catching an exception.
    #[napi(js_name = "isAttachable")]
    pub fn is_attachable(&self) -> bool {
        self.inner.is_some()
    }

    // ==========================================================
    // Phase 5.7 V2.3 (2026-05-22) — async WebSocket factory
    // ==========================================================

    /// Connect to a WebSocket peer and return a Transport wrapping the
    /// resulting `WebSocketTransport`. Returns a JS `Promise<Transport>`.
    ///
    /// **URL format**: standard `ws://host:port` (no TLS in V2.3 — V2.4+
    /// will add `wss://` once the engine's `ql-collab-ws` exposes TLS).
    ///
    /// **Failure modes** (all surface as JS Promise rejections):
    /// - `WebSocketError::InvalidUrl` — URL parse failed.
    /// - `WebSocketError::ConnectFailed` — TCP/DNS error.
    /// - `WebSocketError::HandshakeFailed` — WS upgrade rejected
    ///   (e.g., HTTP 401, protocol mismatch).
    ///
    /// **Lifecycle**: the returned Transport instance owns a
    /// `WebSocketTransport` with two background tokio tasks
    /// (reader + writer). On detach, the tasks are aborted via the
    /// engine's `WebSocketTransport::Drop`. Don't hold the Transport
    /// past detach (V2 V3 step 5 megaudit closure pattern).
    ///
    /// **napi-rs async pattern**: `#[napi]` on `async fn` runs the
    /// body on a tokio task spawned from napi-rs's built-in runtime
    /// (gated by the `async` feature in the workspace `Cargo.toml`).
    /// The Promise resolves on the V8 thread once the async fn
    /// completes — no manual ThreadsafeFunction plumbing needed.
    #[napi(js_name = "websocketConnect")]
    pub async fn websocket_connect(url: String) -> Result<Transport> {
        let ws = WebSocketTransport::connect(&url)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(Transport {
            inner: Some(Box::new(ws)),
        })
    }
}

impl Transport {
    /// **`pub(crate)` — only the napi `CollabSession::attach_transport`
    /// method should call this.** Move the inner Box out for attach.
    /// Called by the napi method, NOT the Rust generic
    /// `ql_collab::CollabSession::attach_transport`. After this returns
    /// `Some`, the wrapper is consumed; subsequent `is_attachable`
    /// returns `false` and the inner box has been handed off.
    ///
    /// **V2.1 audit closure (Opus LOW-4, 2026-05-22)**: the prior
    /// docstring said "Rust-only" which could be misread as private to
    /// this `impl` block. `pub(crate)` IS the visibility — but calling
    /// from any site other than `CollabSession::attach_transport`
    /// silently consumes the wrapper without an `attach`-paired side
    /// effect. Future contributors: do NOT call this from anywhere
    /// else.
    pub(crate) fn take_inner(&mut self) -> Option<Box<dyn CoreTransport + Send>> {
        self.inner.take()
    }
}

/// Two-ended in-process Transport pair (LoopbackTransport).
///
/// JS callers use this as a stepping-stone to obtain the two `Transport`
/// instances that share a Loopback queue:
///
/// ```ignore
/// const pair = new LoopbackPair();
/// const transportA = pair.takeA();
/// const transportB = pair.takeB();
/// sessionA.attachTransport(transportA);
/// sessionB.attachTransport(transportB);
/// ```
///
/// **Why this intermediate class** (Phase 5.7 V2.1 design note,
/// 2026-05-22): napi-rs's `#[napi(factory, ...)]` can only return a
/// single `Self`-typed class instance. Returning a 2-tuple or
/// `Vec<Transport>` fails the trait bound `ObjectFinalize` napi-rs
/// imposes on factory returns. The cleanest pattern that keeps each
/// `Transport` end as a separately-attachable class is to expose the
/// pair-creation step as its own short-lived class with two takers.
///
/// **Single-use takers**: each of `takeA` / `takeB` can be called once
/// per `LoopbackPair` instance. Calling a second time on the same end
/// returns a JS Error. (Calling a non-yet-taken end after the other has
/// been taken still works — the two ends are independent.)
#[napi]
pub struct LoopbackPair {
    // Both ends live here until taken. The pair is constructed eagerly
    // in `new()` so the shared queue exists before either end is
    // distributed.
    a: Option<LoopbackTransport>,
    b: Option<LoopbackTransport>,
}

impl Default for LoopbackPair {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl LoopbackPair {
    /// Construct a fresh Loopback pair. Both ends start un-taken.
    #[napi(constructor)]
    pub fn new() -> Self {
        let (a, b) = LoopbackTransport::pair();
        Self {
            a: Some(a),
            b: Some(b),
        }
    }

    /// Take ownership of end A. Errors if already taken.
    #[napi(js_name = "takeA")]
    pub fn take_a(&mut self) -> Result<Transport> {
        let end = self.a.take().ok_or_else(|| {
            Error::from_reason("LoopbackPair.takeA already called on this pair".to_string())
        })?;
        Ok(Transport {
            inner: Some(Box::new(end)),
        })
    }

    /// Take ownership of end B. Errors if already taken.
    #[napi(js_name = "takeB")]
    pub fn take_b(&mut self) -> Result<Transport> {
        let end = self.b.take().ok_or_else(|| {
            Error::from_reason("LoopbackPair.takeB already called on this pair".to_string())
        })?;
        Ok(Transport {
            inner: Some(Box::new(end)),
        })
    }
}

// =============================================================
// Send/Sync compile assertions (Rule 4 application)
// =============================================================

// **Phase 5.7 V2.4 (2026-05-22) — Send + Sync UPDATE.**
//
// V1 + V2.1 + V2.2 + V2.3 claimed `Send + !Sync` (per V1 megaudit
// Opus-A MEDIUM-1 closure). V2.4 changes the underlying shape from
// `inner: CoreCollabSession` to `inner: Arc<Mutex<CoreCollabSession>>`
// to close V2.3 audit's `&mut self` async aliasing UB hazard.
//
// **New Send + Sync result** (positive compile proof below):
// - `CoreCollabSession: Send + !Sync` (engine's claim, unchanged).
// - `Mutex<T>: Send + Sync` when `T: Send`. parking_lot's Mutex is
//   `Send + Sync` (no poison; pure atomic-CAS path uncontended).
// - `Arc<T>: Send + Sync` when `T: Send + Sync`.
// - Therefore `CollabSession { inner: Arc<Mutex<CoreCollabSession>> }`
//   is `Send + Sync`.
//
// This is a strict improvement over V1's `Send + !Sync`: V2.4 can
// be shared across tokio tasks (load-bearing for V2.4's
// `flushPendingToTransport` spawn_blocking pattern).
//
// Per audit-discipline Rule 4: positive Send + Sync proof below.
const _ASSERT_BINDING_COLLAB_SESSION_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}
    assert_send::<CollabSession>();
    // V2.4: CollabSession is now Sync (was !Sync pre-V2.4).
    assert_sync::<CollabSession>();
};

// **Phase 5.7 V2.1 (2026-05-22) Rule 4 application for `Transport`**:
// The wrapper holds `Option<Box<dyn CoreTransport + Send>>`. The trait
// object itself is `Send` (we declare it `dyn CoreTransport + Send`), and
// `Box<_>` of a `Send` trait object is `Send`, and `Option<T>` is `Send`
// when `T: Send`. So the composition is `Send`. Pin it.
const _ASSERT_BINDING_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<Transport>();
};

// **V2.1 audit closure (Opus MEDIUM-2, 2026-05-22)** — quality gap close
// for `LoopbackPair`. Wrapper holds `a: Option<LoopbackTransport>, b:
// Option<LoopbackTransport>`. The engine pins
// `_ASSERT_LOOPBACK_TRANSPORT_SEND_SYNC` in `ql-collab/src/transport.rs`,
// so by composition `LoopbackPair: Send`. Pin it here so a future
// refactor making LoopbackTransport `!Send` would fail this build (the
// napi class hands wrapped instances across the JS/Rust boundary on the
// same thread, so `Send` isn't strictly required for V2.1 — but losing
// it would break the V2.3+ Transport.websocketConnect async pattern
// which DOES require Send to move across the tokio runtime).
const _ASSERT_BINDING_LOOPBACK_PAIR_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<LoopbackPair>();
};

// **V2.4 (2026-05-22) update**: this block previously documented the
// `!Sync` claim for V1 + V2.1-V2.3's `inner: CoreCollabSession` shape.
// V2.4 refactored to `inner: Arc<Mutex<CoreCollabSession>>` which is
// `Send + Sync`; the V2.4 compile assert above pins BOTH. The historical
// `!Sync` probe pattern is no longer applicable to the binding crate
// itself.
//
// The probe-then-commented-out pattern is still the canonical Rule 4
// application pattern for `!Sync` claims elsewhere in the codebase
// (see `ql-collab/src/session.rs` for the engine's `CoreCollabSession:
// !Sync` claim, which V2.4's wrapper composition still relies on).
//
// Historical context for future code archaeologists: V1+V2.x audit
// closures documented "Send + !Sync" with this commented probe. V2.4
// changed the composition; documentation now matches the runtime
// reality (Send + Sync, verified by source-walking parking_lot's
// `lock_api-0.4.14/src/mutex.rs:144`).

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

    // ==========================================================
    // Phase 5.7 V2.1 (2026-05-22) — Transport composition smoke
    //
    // **Cannot test napi-wrapping types here.** `cargo test` doesn't
    // link napi symbols (they're loaded dynamically when Node opens
    // the .node file), so any code path that touches `napi::Error`
    // — including `Result<T, napi::Error>` from `LoopbackPair::take_a`
    // — fails to link with `_napi_delete_reference` undefined.
    //
    // V2.1 napi-wrapper composition (LoopbackPair → takeA → Transport
    // → CollabSession.attachTransport → flushToTransport → pollRemote)
    // is tested via mocha at
    // `quantlab/extensions/quantlab/test/quantbook-roundtrip.test.ts`
    // — same pattern V1 uses (mocha owns the Node host; Rust unit
    // tests handle core-type plumbing only).
    //
    // This smoke validates that the engine-side `attach_transport_boxed`
    // entry point composes with `LoopbackTransport::pair()` directly
    // (no napi). Catches engine-side regressions independent of the
    // napi layer.
    // ==========================================================

    #[test]
    fn engine_attach_transport_boxed_round_trip() {
        use ql_collab::LoopbackTransport;
        let (a_end, b_end) = LoopbackTransport::pair();

        let mut session_a = CoreCollabSession::new(PeerId::new(1)).expect("session A");
        let mut session_b = CoreCollabSession::new(PeerId::new(2)).expect("session B");

        // The boxed entry point is what the napi layer calls.
        let prior_a = session_a.attach_transport_boxed(Box::new(a_end));
        let prior_b = session_b.attach_transport_boxed(Box::new(b_end));
        assert!(prior_a.is_none() && prior_b.is_none());

        let op = Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        };
        session_a.append_op(op).expect("append");
        let sent = session_a.flush_to_transport().expect("flush sends ok");
        assert!(sent, "flush_to_transport returns true when bytes sent");

        let merged = session_b.poll_remote().expect("poll ok");
        assert!(merged >= 1, "B merged at least 1 op, got {merged}");
        assert_eq!(session_b.op_count(), session_a.op_count());
    }
}
