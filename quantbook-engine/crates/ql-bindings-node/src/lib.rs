//! `ql-bindings-node` -- VS Code extension binding (Phase 5.7 V1).
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
//!     Opus H3, 2026-05-22 -- verified by reading napi-derive-backend
//!     5.0.4 `src/codegen/fn.rs:217-240`: the wrap is gated on
//!     `#[napi(catch_unwind)]` opt-in). The V1 binding does NOT use
//!     `catch_unwind` -- instead, every `#[napi]` method
//!     pre-validates inputs that could trigger engine-side `assert_*!`,
//!     `panic!`, `unwrap`, or `expect`. Smoke caught one such hazard
//!     (PeerId(0) -> `CollabSession::new`'s `assert_ne!(peer, 0)` ->
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
//! production-visible closure -- Phase 5.7 V3), `discard_pending_ops`,
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
//! mutability -- multiple shared `&CollabSession` references are sound;
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
//! **V2.5 (2026-05-22): V8-block hazard CLOSED** (Opus V2.4 HIGH-1).
//!
//! The V2.4 binding pattern held `self.inner.lock()` across the
//! `spawn_blocking` Condvar wait -- concurrent JS sync method calls
//! blocked the V8 event loop on lock acquisition. V2.5 refactored
//! `flushPendingToTransport` to extract a detached `FlushAck`
//! handle (via `ql_collab::CollabSession::flush_pending_handle`)
//! under a brief lock acquisition, drop the lock, then wait on the
//! handle's Arc-cloned progress state inside `spawn_blocking`. The
//! handle owns no reference to the session mutex; concurrent JS
//! sync methods acquire the lock immediately while the wait runs.
//!
//! See `flushPendingToTransport`'s docstring below + the V2.5 audit
//! transcripts at `docs/audits/2026-05-22-phase-5-7-v2-5-{codex,opus}.md`
//! for the full closure rationale + post-implementation
//! source-walked verification (V8-block VERIFIED CLOSED in both
//! lanes via the `let inner = self.inner.lock(); … }` scope drop +
//! Arc-only handle-handoff to `spawn_blocking`).
//!
//! V2.5 caller note: there is NO V8-block-related caller discipline
//! required today. Concurrent session method calls during a pending
//! `flushPendingToTransport` are sound + non-blocking. The V2.6
//! contract test (`flushPendingToTransport does NOT block sync
//! methods on the same session`) empirically pins this -- opCount
//! during a 1000ms-blocked flush returned in <50ms on local dev.

#![deny(clippy::all)]
#![allow(clippy::missing_safety_doc)] // napi-rs generated wrappers

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;

use ql_collab::AutoFlushPolicy as CoreAutoFlushPolicy;
use ql_collab::CollabSession as CoreCollabSession;
use ql_collab::CollabSessionError;
use ql_collab::LoopbackTransport;
use ql_collab::PresenceState as CorePresenceState;
use ql_collab::Transport as CoreTransport;
use ql_collab::TransportError;
use ql_functions::default_registry;
use ql_io::oplog_persistence::{load_workbook_with_oplog, save_workbook_with_oplog, PersistenceError};
use ql_collab_ws::WebSocketError;
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
        return Err(bad_argument_error(format!(
            "{method}: {name} must be a finite non-negative integer, got {value}"
        )));
    }
    if value < 0.0 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be a non-negative integer, got {value}"
        )));
    }
    if value.fract() != 0.0 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be an integer, got {value}"
        )));
    }
    if value > u32::MAX as f64 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be in [0, 4294967295] (u32::MAX), got {value}"
        )));
    }
    Ok(value as u32)
}

/// **Phase 5.7 V3.6.0.X audit-of-D5 OPUS-HIGH-3 closure (2026-05-24)**:
/// u16 equivalent of [`validate_u32_index`].  Used by `appendPutValue` +
/// `appendPutFormula` for the `sheet: f64` parameter.
///
/// The V1 audit Opus H2 finding identified a class of silent coercions
/// at the FFI boundary when napi-rs auto-converts JS Numbers to a
/// typed unsigned integer.  The V1 closure addressed `u32` (row/col)
/// via [`validate_u32_index`] but a docstring at
/// `crates/ql-bindings-node/src/lib.rs::CollabSession::append_put_value`
/// (pre V3.6.0.X audit-of-D5) incorrectly claimed the class didn't
/// apply at `u16`.  Opus Lane B verified by reading napi-rs 3.9.0's
/// `FromNapiValue for u16`: it routes through `napi_get_value_uint32`
/// (ECMAScript ToUint32) THEN `try_into::<u16>()`.  ToUint32 itself
/// silently coerces NaN/Infinity to 0, negatives to two's-complement
/// wrap, fractions to truncate-toward-zero, and values >= 2^32 modulo
/// 2^32.  `try_into::<u16>()` then only rejects post-ToUint32 values
/// in [65536, 2^32) -- so the [0, 65535] in-range silent corruptions
/// (NaN -> 0; 0.5 -> 0; 2.7 -> 2; 2^32 -> 0; 65535.9 -> 65535) are
/// NOT rejected.  Same hazard class as the V1 finding, surfacing on
/// `appendPutValue.sheet` + `appendPutFormula.sheet`.
///
/// Closure: take `sheet` as `f64` (raw `napi_get_value_double` -- no
/// coercion) and validate finite + non-negative + integer + <= 65535
/// here, before casting to `u16`.  Direct callers that bypass the
/// IDE TS wrapper see precise `[bad_argument]` JS Errors instead of
/// silently corrupted writes to the wrong sheet.
fn validate_u16_index(method: &str, name: &str, value: f64) -> Result<u16> {
    if !value.is_finite() {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be a finite non-negative integer, got {value}"
        )));
    }
    if value < 0.0 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be a non-negative integer, got {value}"
        )));
    }
    if value.fract() != 0.0 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be an integer, got {value}"
        )));
    }
    if value > u16::MAX as f64 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be in [0, 65535] (u16::MAX), got {value}"
        )));
    }
    Ok(value as u16)
}

/// Helper: convert a JS `BigInt` to `PeerId` with explicit rejection of
/// FIVE failure modes:
///   - negative BigInt (signed bit set) -- PeerId is u64-domain
///   - BigInt doesn't fit in u64 (lossless = false)
///   - `peer_id == 0` -- Loro's LEGACY_PEER sentinel; rejected with a
///     PROACTIVE check here (the engine's `CollabSession::new` would
///     hit `assert_ne!` and panic, which napi-rs 3.x doesn't reliably
///     catch into a JS exception -- observed during V1 smoke test:
///     "failed to initiate panic, error 5, aborting"). Pre-validate
///     in the FFI boundary to keep Node alive.
///   - `peer_id == u64::MAX` -- Loro's `PeerID::MAX` sentinel (verified
///     via Loro 1.12 `loro-internal-1.12.0/src/loro.rs:184`:
///     `if peer == PeerID::MAX { return Err(...) }`). Loro returns a
///     CLEAN `Err` here (not a panic), so the FFI boundary is intact
///     either way -- but pre-rejecting at the binding gives a faster
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
        return Err(bad_argument_error(
            "peerId BigInt must be non-negative (PeerId is u64-domain)".to_string(),
        ));
    }
    if !lossless {
        return Err(bad_argument_error(
            "peerId BigInt does not fit in u64 (lossy conversion)".to_string(),
        ));
    }
    if peer_u64 == 0 {
        return Err(bad_argument_error(
            "peerId must be non-zero (PeerId(0) is LEGACY_PEER, reserved for pre-collab single-writer + qbook migration)".to_string(),
        ));
    }
    if peer_u64 == u64::MAX {
        return Err(bad_argument_error(
            "peerId must not be u64::MAX (Loro reserves PeerID::MAX as an internal sentinel)"
                .to_string(),
        ));
    }
    Ok(PeerId::new(peer_u64))
}

// ============================================================
// Phase 5.7 V2.7 (2026-05-22) -- error-code discrimination helpers
// ============================================================
//
// Closes V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards: every engine
// error type's variant discriminant is lost on the napi boundary
// because `Error::from_reason(format!("{e}"))` only carries the
// Display string.
//
// V2.7 design (Codex M3 + Opus V2.1/V2.2/V2.3 M3 convergent):
//
//   1. Engine: each error enum gets a `kind() -> &'static str`
//      accessor (`crates/ql-collab/src/transport.rs::TransportError`,
//      `crates/ql-collab-ws/src/lib.rs::WebSocketError`,
//      `crates/ql-collab/src/session.rs::CollabSessionError`).
//
//   2. Binding: the helpers below prepend `[<kind>]` to the napi
//      error message, producing strings like
//      `"[transport_closed] transport closed"`.
//
//   3. IDE: `parseQuantbookError(err)` in
//      `extensions/quantlab/src/quantbook/session.ts` extracts the
//      bracketed code into a typed `QuantbookErrorCode` so reconnect
//      logic can branch on `err.code === 'transport_closed'` etc.
//
// **V2.3 mocha test compatibility**: the existing Display strings
// remain intact AFTER the prefix, so substring-match tests like
// `/invalid WebSocket URL/` still match `"[websocket_invalid_url]
// invalid WebSocket URL: ..."`. No test breakage expected.
//
// **Why not napi-rs `Error::with_code`?**: napi-rs 3.9.0's `Error`
// uses `Status: enum` (no `Status::Custom(String)`). The standard
// status codes don't map to our error variants. Prefix-encoding
// in the message is the canonical workaround documented across the
// napi-rs ecosystem until a future custom-code API lands.

/// Map a [`CollabSessionError`] to a napi [`Error`] with a kind-
/// prefixed message. The kind comes from
/// [`CollabSessionError::kind`]; for `Transport(inner)` it
/// transparently passes through the inner kind (e.g.
/// `"transport_closed"` instead of `"session_transport"`).
fn collab_session_error_to_napi(e: CollabSessionError) -> Error {
    Error::from_reason(format!("[{}] {e}", e.kind()))
}

/// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)** -- helper for the
/// [`CollabSession::workbook_snapshot_delta`] fullRebuildRequired
/// / empty-delta paths.  Single source of truth for the "empty
/// arrays, just version + bool" shape; keeps the algorithm body
/// reading sequentially.
fn empty_delta(version: Buffer, full_rebuild_required: bool) -> WorkbookSnapshotDeltaJson {
    WorkbookSnapshotDeltaJson {
        changed_cells: Vec::new(),
        removed_cells: Vec::new(),
        sheets_changed: Vec::new(),
        sheets_removed: Vec::new(),
        formats_added: Vec::new(),
        version,
        full_rebuild_required,
    }
}

/// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)** -- classify a single op
/// for [`CollabSession::workbook_snapshot_delta`]'s delta walk.
///
/// Sets `has_rename = true` on any `Op::RenameSheet | RenameTable |
/// RenameColumn`; the caller's break-on-rename short-circuit takes
/// effect after this returns.  Otherwise extracts the cell coord,
/// sheet removal, or format registration into the appropriate
/// output collection.
///
/// Recurses into `Op::BatchCommit` to handle nested cell ops (mirrors
/// the V3.4.0.X HIGH-1 closure on `collect_cache_effects`).
///
/// Non-cell-keyed, non-rename, non-format ops (e.g., `SetName`,
/// `AddSheet`, `MoveSheet`, `CreateTable`, `DropTable`, etc.) are
/// silently skipped here.  V3.6.0.8.3 scope: their effects don't
/// emit in this delta surface (would require sheets_changed or new
/// surface fields; deferred to V3.6.0.8.4+).
fn classify_delta_op(
    op: &Op,
    has_rename: &mut bool,
    changed_cells: &mut std::collections::HashSet<(u16, u32, u32)>,
    removed_sheets: &mut Vec<u16>,
    new_formats: &mut Vec<ql_storage::FormatId>,
) {
    match op {
        Op::PutValue { sheet, row, col, .. }
        | Op::PutFormula { sheet, row, col, .. }
        | Op::ClearFormula { sheet, row, col }
        | Op::SetCellFormat { sheet, row, col, .. } => {
            changed_cells.insert((*sheet, *row, *col));
        }
        Op::RenameSheet { .. } | Op::RenameTable { .. } | Op::RenameColumn { .. } => {
            *has_rename = true;
        }
        Op::RemoveSheet { id } => {
            removed_sheets.push(*id);
        }
        Op::RegisterFormat { id, .. } => {
            new_formats.push(id.clone().to_storage());
        }
        Op::BatchCommit { ops } => {
            for inner in ops {
                classify_delta_op(
                    inner,
                    has_rename,
                    changed_cells,
                    removed_sheets,
                    new_formats,
                );
                if *has_rename {
                    return;
                }
            }
        }
        // **V3.6.0.8.4 CODEX-HIGH-2 closure (2026-05-25)**: allowlist
        // discipline.  Pre-closure the catch-all `_ => {}` arm silently
        // ignored metadata ops (AddSheet / MoveSheet / CreateTable /
        // DropTable / RenameTable / RenameColumn / ResizeTable /
        // SetName / SetLocale / SetReferenceMode / SetDateSystem) AND
        // ALSO advanced the cache token through them.  Result: IDE
        // calling workbookSnapshotDelta after an addSheet would see
        // empty delta + advanced version, missing the new sheet
        // entirely.  Post-closure: any op the cell-only fast-path
        // cannot represent in WorkbookSnapshotDeltaJson forces the
        // fullRebuild fallback by setting `has_rename = true` (which
        // breaks the enclosing scan loop + returns
        // `fullRebuildRequired=true` from `workbook_snapshot_delta`).
        // The `has_rename` flag name is overloaded for "force full
        // rebuild" semantically; a future cleanup at V3.6.0.8.5+ may
        // rename to `force_full_rebuild` for clarity.
        //
        // Known metadata ops are listed explicitly for reviewer
        // visibility.  `Op` is `#[non_exhaustive]` from another crate,
        // so Rust still requires a wildcard; future variants therefore
        // conservatively force a full rebuild until classified.
        Op::AddSheet { .. }
        | Op::MoveSheet { .. }
        | Op::CreateTable { .. }
        | Op::DropTable { .. }
        | Op::ResizeTable { .. }
        | Op::SetName { .. }
        | Op::SetLocale { .. }
        | Op::SetReferenceMode { .. }
        | Op::SetDateSystem { .. }
        // **V3.6.0.10 D8 closure**: Op::RestoreSheet forces fullRebuild.
        // Reasoning: restoring an un-tombstones a sheet whose cells are
        // preserved in Workbook storage but absent from the
        // CollabSession last_snapshot cache (the cache dropped them at
        // CacheEffect::RemoveSheet apply).  Walking the full op log to
        // re-emit pre-tombstone cell-keyed effects would duplicate
        // rebuild_snapshot_cache logic; fullRebuild is simpler + the
        // op is rare (user-initiated undo-of-delete).
        | Op::RestoreSheet { .. } => {
            *has_rename = true;
        }
        _ => {
            *has_rename = true;
        }
    }
}

/// Map a [`TransportError`] to a napi [`Error`] with a kind-
/// prefixed message. Used by `flushPendingToTransport`'s async
/// `wait_for_drain` path.
fn transport_error_to_napi(e: TransportError) -> Error {
    Error::from_reason(format!("[{}] {e}", e.kind()))
}

/// Map a [`WebSocketError`] to a napi [`Error`] with a kind-
/// prefixed message. Used by `Transport.websocketConnect`'s
/// rejection path.
fn websocket_error_to_napi(e: WebSocketError) -> Error {
    Error::from_reason(format!("[{}] {e}", e.kind()))
}

/// **Phase 5.7 V3.4.0.4a (2026-05-23)**: map a [`PersistenceError`] to
/// a napi [`Error`] with a kind-prefixed message.  The
/// [`PersistenceError`] variants don't have a `kind()` accessor like
/// [`CollabSessionError`] does; this mapper picks a stable code per
/// variant that the IDE-side `parseQuantbookError` can switch on.
///
/// Codes:
/// - `qbook_error`           -- workbook persistence layer (I/O, schema, malformed cell)
/// - `session_oplog`         -- op-log Loro snapshot decode (matches existing
///                              `CollabSessionError::OpLog` code for symmetry)
/// - `qbook_unsupported_version` -- `oplog.bin` schema version out of band
/// - `qbook_truncated_header`    -- `oplog.bin` magic-prefix present but header < 8 bytes
fn persistence_error_to_napi(e: PersistenceError) -> Error {
    // `PersistenceError` is `#[non_exhaustive]`; the wildcard arm is
    // required to keep the match exhaustive across future ql-io
    // schema additions.  Future variants surface as `qbook_unknown`
    // until this mapper is updated.
    let code = match &e {
        PersistenceError::Qbook(_) => "qbook_error",
        PersistenceError::OpLog(_) => "session_oplog",
        PersistenceError::OplogUnsupportedVersion { .. } => "qbook_unsupported_version",
        PersistenceError::OplogTruncatedHeader { .. } => "qbook_truncated_header",
        _ => "qbook_unknown",
    };
    Error::from_reason(format!("[{code}] {e}"))
}

/// **V2.7 audit closure (Opus MEDIUM-2, 2026-05-22)**: prefix napi-
/// layer argument-validation and single-use-violation errors with
/// `[bad_argument]` so IDE callers can branch on `info.code ===
/// 'bad_argument'` for "the caller passed bad input" recovery.
/// Without this prefix, these errors silently bucketed under
/// `'unknown'` in `parseQuantbookError`, re-opening the V2.1+V2.2+V2.3
/// MEDIUM-3 carryforward at the binding boundary.
///
/// Used by:
/// - `validate_u32_index` (ToUint32-hygiene checks)
/// - `peer_id_from_bigint` (BigInt range checks)
/// - `BlockingTransportFixture::new` (blockMs > 0)
/// - `LoopbackPair::{takeA, takeB}` (single-use violations)
/// - `BlockingTransportFixture::takeTransport` (single-use)
/// - `CollabSession::attachTransport` (consumed wrapper)
/// - `parse_auto_flush_policy` (unknown policy string)
/// - `auto_flush_policy_to_string` (engine drift)
fn bad_argument_error(message: String) -> Error {
    Error::from_reason(format!("[bad_argument] {message}"))
}

/// **Phase 5.7 V3.4.0.5 (2026-05-23) -- JS-facing PresenceState.**
///
/// Mirrors `ql_collab::presence::PresenceState` for the napi boundary.
/// Plain data struct (no methods) marked `#[napi(object)]` so napi-rs
/// generates a TypeScript interface with structural typing.  Field
/// names use camelCase to follow JS conventions (engine uses snake_case);
/// napi-rs maps Rust `snake_case` field names to JS `camelCase` by
/// default but the explicit conversion below makes the contract obvious
/// to readers.
///
/// All fields are required (no `Option`); the engine's `PresenceState`
/// is a `#[derive(Default)]`-able struct so callers can build minimal
/// state by setting cursor coords + `selectionEnd*` to match (collapsed
/// selection) + `typing: false`.
///
/// **Coordinate semantics** (carries from engine): `(sheet, row, col)`
/// = cursor cell; `(selectionEndRow, selectionEndCol)` = opposite
/// corner of selection rectangle (equals cursor coords when no range
/// selected); `typing` = true while peer is mid-edit (soft hint for IDE
/// cursor styling).
///
/// (The `#[napi(object)]` attribute for `PresenceStateJson` lives at the
/// struct definition further down, after the V3.5.0.2 snapshot-related
/// structs are defined.)

/// **Phase 5.7 V3.5.0.2 (2026-05-24) -- JS-facing cell value mirror.**
///
/// Discriminated-union shape matching the V3.4.0.2 `CellValueJson`
/// discriminator used by `exportSnapshot`'s JSON output (kind tag +
/// per-variant optional payload).  Pre-V3.5.0.2 the discriminator lived
/// only in the serde_json::Value built inside `export_snapshot`; V3.5.0.2
/// promotes it to a `#[napi(object)]` struct so the `WorkbookSnapshot`
/// surface (nested `Vec<SheetSnapshotJson>` of `Vec<CellSnapshotJson>`)
/// has a typed value field instead of opaque `serde_json::Value`.
///
/// **Optional-fields-by-kind invariant**: exactly ONE of
/// `number / boolean / text / error` is `Some` per (kind != "pending");
/// `pending` has all four `None`.  IDE consumers MUST read the field
/// indicated by `kind`; cross-reading is undefined behavior at the
/// contract level.
///
/// **Rule 4 per-field walk** (V3.5.0.1 D3 trigger; V3.5.0.2 ship):
/// - `kind: String`: Send + Sync trivially.
/// - `number: Option<f64>`, `boolean: Option<bool>`, `text: Option<String>`,
///   `error: Option<String>`: Option<T> is Send + Sync when T is;
///   `f64`/`bool` are Copy + 'static + Send + Sync; `String` is
///   Send + Sync trivially.
/// - Composition: `CellValueJson: Send + Sync`.
/// - **0 new Rule 4 triggers**; arc terminus stays at 6.
#[napi(object)]
pub struct CellValueJson {
    pub kind: String,
    pub number: Option<f64>,
    pub boolean: Option<bool>,
    pub text: Option<String>,
    pub error: Option<String>,
}

impl From<CellWireValue> for CellValueJson {
    fn from(value: CellWireValue) -> Self {
        match value {
            CellWireValue::Number(n) => Self {
                kind: "number".to_string(),
                number: Some(n),
                boolean: None,
                text: None,
                error: None,
            },
            CellWireValue::Boolean(b) => Self {
                kind: "boolean".to_string(),
                number: None,
                boolean: Some(b),
                text: None,
                error: None,
            },
            CellWireValue::Text(s) => Self {
                kind: "text".to_string(),
                number: None,
                boolean: None,
                text: Some(s),
                error: None,
            },
            CellWireValue::Error(s) => Self {
                kind: "error".to_string(),
                number: None,
                boolean: None,
                text: None,
                error: Some(s),
            },
            CellWireValue::Pending => Self {
                kind: "pending".to_string(),
                number: None,
                boolean: None,
                text: None,
                error: None,
            },
        }
    }
}

/// **Phase 5.7 V3.5.0.5 (2026-05-24) -- JS-facing FormatId mirror.**
///
/// Tagged-union mirror of the engine's `ql_storage::FormatId` enum
/// (V5-D-1 / Phase 5.2 step 4 tagged shape: `Builtin(u32) | Custom(PeerId,
/// u32)`).  napi-rs `Option::None` -> absent JS property, so callers
/// MUST discriminate on `kind` and read the correct payload field.
///
/// **Variant -> field mapping**:
/// - `Builtin(id)` -> `{ kind: "builtin", builtin: id }` (other fields absent)
/// - `Custom(peer, counter)` -> `{ kind: "custom", customPeer: <peer as bigint>,
///                                  customCounter: counter }` (builtin absent)
///
/// `customPeer` is `u64` widened to JS BigInt (matches the PresenceState +
/// peerId conventions throughout V3.x).  `customCounter` is `u32`
/// (JS-number-safe).
///
/// **Rule 4 per-field walk**: `kind: String` Send + Sync;
/// `builtin: Option<u32>` Send + Sync; `custom_peer: Option<BigInt>`
/// (napi::bindgen_prelude::BigInt is a u128-sized struct wrapping
/// Vec<u64> + sign; Vec<u64> is Send + Sync; trivially Send + Sync);
/// `custom_counter: Option<u32>` Send + Sync.  Composition:
/// `FormatIdJson: Send + Sync`.  **0 new Rule 4 triggers**; arc
/// terminus stays at 6.
///
/// **V3.5.0.5 ship**: format passthrough only.  The IDE webview does
/// NOT consume format yet (buildHtml renders without format awareness);
/// the field round-trips through workbookSnapshot for V3.6+ format-
/// aware rendering.
#[napi(object)]
pub struct FormatIdJson {
    pub kind: String,
    /// Set when `kind == "builtin"`; absent otherwise.
    pub builtin: Option<u32>,
    /// Set when `kind == "custom"`; absent otherwise.  PeerId widened
    /// to BigInt (matches V3.4.0.4b generateUuidPeerId + V3.4.0.5a
    /// PresenceStateJson conventions).
    pub custom_peer: Option<BigInt>,
    /// Set when `kind == "custom"`; absent otherwise.
    pub custom_counter: Option<u32>,
}

impl From<ql_storage::FormatId> for FormatIdJson {
    fn from(id: ql_storage::FormatId) -> Self {
        match id {
            ql_storage::FormatId::Builtin(n) => Self {
                kind: "builtin".to_string(),
                builtin: Some(n),
                custom_peer: None,
                custom_counter: None,
            },
            ql_storage::FormatId::Custom(peer, counter) => Self {
                kind: "custom".to_string(),
                builtin: None,
                custom_peer: Some(BigInt::from(peer.0)),
                custom_counter: Some(counter),
            },
        }
    }
}

/// **Phase 5.7 V3.5.0.2 (2026-05-24) -- JS-facing cell snapshot.**
///
/// One cell entry in a sheet's snapshot.  `value: None` means the cell has
/// a formula but no cached literal value yet (formula-only cell, e.g.,
/// `=A1+1` with no computed value pinned to the cache).  `formula: None`
/// means the cell has a literal value but no formula text (pure
/// `PutValue`).  Both `Some` means the cell carries both (formula
/// evaluated to a numeric literal).  All three `None` cannot occur in
/// the snapshot (V3.4.0.X MEDIUM-1 closure extended at V3.5.0.5: such
/// entries are removed from the cache via `apply_cache_effect`'s
/// formula-only-key removal -- now extended to format).
///
/// **V3.5.0.5 (2026-05-24) -- adds `format: Option<FormatIdJson>`**:
/// passthrough for cell-keyed `Op::SetCellFormat`.  `format: None`
/// means the cell has no explicit format (renders with General per
/// the engine's FormatId::GENERAL default).  IDE webview does NOT
/// render format yet at V3.5.0.5 ship; the field round-trips for
/// V3.6+ format-aware rendering.
///
/// **Rule 4 per-field walk**: `row/col: u32` primitives; `value:
/// Option<CellValueJson>` composition over CellValueJson (Send + Sync
/// per its own walk above); `formula: Option<String>` (Send + Sync per
/// Option<String> auto-trait); **`format: Option<FormatIdJson>`** Send +
/// Sync per FormatIdJson's walk above (V3.5.0.5 addition).  Composition:
/// `CellSnapshotJson: Send + Sync`.  **0 new Rule 4 triggers; arc
/// terminus stays at 6** (FormatIdJson is positive Send+Sync via its
/// own per-field walk).
#[napi(object)]
pub struct CellSnapshotJson {
    pub row: u32,
    pub col: u32,
    pub value: Option<CellValueJson>,
    pub formula: Option<String>,
    /// **V3.5.0.5 (2026-05-24)**: format passthrough.  `None` = no
    /// explicit format (cell renders with FormatId::GENERAL default).
    pub format: Option<FormatIdJson>,
    /// **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**: pre-rendered formatted
    /// string for the cell value, produced by the engine via
    /// `ql_functions::format::render(value, parsed_format,
    /// eval_context)` where
    /// `eval_context.date_system = workbook.date_system()`,
    /// `eval_context.locale = workbook.locale()`, and
    /// `eval_context.now_provider = NowProvider::System`.
    ///
    /// **V3.6.0.X audit-of-D4 closures**:
    /// - CONVERGENT-MED-1: locale now flows from the workbook
    ///   (post-closure; pre-closure was hardcoded `Locale::EnUs`).
    ///   `format::render` ignores locale today (English month names
    ///   hardcoded in `render.rs`) but the passthrough prevents
    ///   silent forward-compat regression when locale-aware rendering
    ///   lands at V3.6.1+.
    /// - CONVERGENT-MED-2: per-snapshot parsed-format cache.
    ///   `format::parse` runs ONCE per unique `FormatId` per
    ///   `workbook_snapshot` call (was per-cell pre-closure).  V3.7+
    ///   may promote the cache to `CollabSession` (cross-call) if
    ///   profiling justifies.
    /// - CONVERGENT-HIGH-3: short-circuits `is_pending()` values
    ///   (pre-closure they rendered as `"0.00"` for number formats;
    ///   post-closure rendered=None so the IDE's `"(pending)"`
    ///   fallback fires).
    ///
    /// `None` when any of the following hold:
    /// - `format` is `None` (no format registered for this cell) ->
    ///   IDE falls back to value-based default rendering.
    /// - `value` is `None` (cell has formula but no evaluated value
    ///   yet) -> defer rendering until the formula evaluates.
    /// - `value` `is_pending()` -> post-audit-of-D4 HIGH-3 closure;
    ///   IDE shows `"(pending)"` via fallback.
    /// - `format` references a `FormatId` not in
    ///   `Workbook.formats()` (lookup miss; should not happen for
    ///   well-formed snapshots).
    /// - The registered format string fails to parse via
    ///   `ql_functions::format::parse` (V2 token, malformed grammar,
    ///   etc.) -> IDE falls back to value-default (silent fallback
    ///   per Phase 5.6 conservative discipline; no error surfaced).
    /// - The cell value carries an unknown error sigil
    ///   (`CellWireValue::Error("#WHATEVER!")` where the sigil
    ///   isn't in `parse_canonical_error_text`'s set) -> wire decode
    ///   errors out; IDE falls back.
    ///
    /// **CSP-safe**: the IDE renderer must `escapeHtml` the rendered
    /// string before inserting into `innerHTML` (V3.2.a discipline).
    /// Both server-side `cellGridHtml::renderRows` + injected
    /// client-side `renderRowsClient` apply `escapeHtml` to BOTH
    /// the rendered path AND the value-default fallback path; CSP
    /// invariant holds regardless of which branch fires.
    ///
    /// **Edit-flow note (V3.6.0.X audit-of-D4 OPUS-HIGH-2)**: the
    /// IDE consumer MUST emit a `data-raw-value` attribute carrying
    /// the parseable raw representation (not the rendered display
    /// string) for click-to-edit flows.  `parseCellRawInput` on
    /// commit does `Number(trimmed)` which NaN's on engine-rendered
    /// currency / percent / thousands / date strings.  See
    /// `extensions/quantlab/src/quantbook/cellGrid/cellGridHtml.ts`
    /// `renderRows` + `beginEdit` client function for the pattern.
    pub rendered: Option<String>,
}

/// **Phase 5.7 V3.5.0.2 (2026-05-24) -- JS-facing sheet snapshot.**
///
/// One sheet entry in the workbook snapshot.  `id` is the sheet's u16
/// `SheetId` widened to u32 for napi JS-number compatibility (BigInt
/// would be overkill for the 0..65535 range; the widening is lossless).
/// `name` is the sheet's display name (from `Op::AddSheet { name, .. }`).
/// `cells` is the cell-keyed cache for this sheet, sorted (row, col)
/// ascending per `snapshot_cells` contract.
///
/// **V3.5.0.2 ship limitation**: empty sheets (created via `addSheet`
/// but no `PutValue` / `PutFormula` yet) DO appear with `cells: []`
/// because V3.5.0.2 enumerates sheets via `Workbook::sheet_count()`
/// after `rebuild_workbook` -- this catches all `AddSheet` ops, not
/// just those with cells.  Differs from `list_sheets_from_cache` which
/// only returns sheets with cache entries.
///
/// **Rule 4 per-field walk**: `id: u32` primitive; `name: String` Send +
/// Sync; `cells: Vec<CellSnapshotJson>` -- Vec<T> is Send + Sync when T
/// is.  Composition: `SheetSnapshotJson: Send + Sync`.  **0 new triggers.**
#[napi(object)]
pub struct SheetSnapshotJson {
    pub id: u32,
    pub name: String,
    pub cells: Vec<CellSnapshotJson>,
}

/// **Phase 5.7 V3.5.0.2 (2026-05-24) -- JS-facing workbook snapshot.**
///
/// Flattened JSON-serializable view of the full workbook for IDE-side
/// consumption.  Per V3.5.0.1 D3: chosen over the alternative (mirror
/// full `ql-storage::Workbook` API across FFI) because the flattened
/// view is pre-shaped for the IDE renderer + matches the V3.4.0.5a
/// `PresenceStateJson` pattern at a higher level.
///
/// **V3.5.0.2 ship**: `sheets` only.  **V3.5.0.5 (2026-05-24) adds
/// per-cell format passthrough** via `SheetSnapshotJson.cells[i].format`;
/// the top-level WorkbookSnapshotJson shape was UNCHANGED at V3.5.
/// **V3.6.0.3 D2 (2026-05-24) adds the session-wide `formats:
/// Vec<FormatDefJson>` registry** (additive top-level field +
/// dedicated `FormatDefJson` napi struct).  Future surfaces: `names:
/// Vec<NamedRangeJson>` deferred to V3.6+/V3.7.
/// Additive; no shape break for `.sheets`-destructuring consumers
/// (exact-key / `Object.keys` / hash-stability consumers see the
/// new `.formats` field per V3.6.0.X audit-of-D2 LOW-1 carry).
///
/// **Performance note (R-V3.5-1)**: large workbooks (100k+ cells)
/// produce large JSON payloads.  V3.5.0.2 ships the full snapshot per
/// call; V3.6+ may add incremental deltas.  IDE callers MUST batch
/// snapshot calls (do NOT call per-keystroke).
///
/// **Rule 4 per-field walk**: `sheets: Vec<SheetSnapshotJson>` Send +
/// Sync via Vec composition.  **0 new Rule 4 triggers; arc terminus
/// stays at 6.**
#[napi(object)]
pub struct WorkbookSnapshotJson {
    pub sheets: Vec<SheetSnapshotJson>,
    /// **Phase 5.7 V3.6.0.3 D2 (2026-05-24)**: session-wide format
    /// registry, populated from the rebuilt-and-repaired Workbook's
    /// `FormatTable` (authoritative source -- merges Excel-canonical
    /// Builtin ids in the 0..=163 reserved range with Custom ids
    /// registered via `Op::RegisterFormat`).  Note: only ~20 of the
    /// 0..=163 Builtin ids are actually preloaded at
    /// `FormatTable::default()`; the remainder are reserved per
    /// Excel spec but not in the table until a producer emits an
    /// `Op::RegisterFormat` for them (Phase 4.6 D-1 semantic; the
    /// V3.6.0.X audit-of-D2 closure dropped Builtin RegisterFormat
    /// at the cache walker but the Workbook side still accepts
    /// them).
    ///
    /// Used by V3.6+ format-aware buildHtml rendering (D4): IDE looks
    /// up each cell's `format: FormatIdJson` against this list to find
    /// the format string (e.g., `"0.00%"`, `"yyyy-mm-dd"`) for
    /// number/date/currency rendering.
    ///
    /// **Sort order**: **V3.6.0.X audit-of-D2 closure
    /// (CONVERGENT-MED-1, 2026-05-23)**: sorted by `FormatId` via the
    /// derived `Ord` (Builtin variants first per enum order, then
    /// Custom lexicographically by `(peer, counter)`).  Pre-closure
    /// this field was raw HashMap-iter order which varied
    /// across consecutive `workbook_snapshot` calls (per-instance
    /// random hasher; `workbook_snapshot` rebuilds a fresh
    /// `Workbook::new()` each call so the hasher state differs).
    /// Sorted output gives consumers a stable shape across
    /// snapshots (hashable, diffable, JSON-stringify-equal).
    ///
    /// **Additive field** (V3.5.0.2 WorkbookSnapshotJson shape break-
    /// free extension): V3.5 IDE consumers that destructure
    /// `.sheets` continue to work; consumers wanting formats opt in
    /// via `.formats`.  Mirrors the V3.5.0.5 per-cell format additive
    /// extension on CellSnapshotJson.
    pub formats: Vec<FormatDefJson>,

    /// **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**: workbook-level date
    /// system, propagated to the engine `EvalContext` used by
    /// `format::render` for date/time format strings.  Two valid
    /// values:
    /// - `"Excel1900"`: 1900 epoch (1899-12-30 = serial 0); Windows
    ///   Excel default; includes the phantom 1900-02-29 = serial 60
    ///   for legacy Lotus 1-2-3 compatibility.
    /// - `"Excel1904"`: 1904 epoch (1904-01-01 = serial 0); legacy
    ///   macOS Excel default; no leap-year bug.
    ///
    /// Mapped from `ql_types::DateSystem` (see Phase 4.6 D-1).  IDE
    /// consumers needing to render dates directly (e.g., date
    /// pickers) should consult this field; cells with a date format
    /// are already pre-rendered via `CellSnapshotJson.rendered`.
    ///
    /// String enum vs napi enum struct: V3.6.0.5 ships String for
    /// simplicity (matches the FormatIdJson + CellValueJson `kind:
    /// String` pattern; no per-value wrapper struct).  IDE types.ts
    /// pins via a union type `"Excel1900" | "Excel1904"`.
    pub date_system: String,

    /// **Phase 5.7 V3.6.0.8.4 OPUS-HIGH-2 closure (2026-05-25)**:
    /// opaque Loro version-vector token captured at the moment of
    /// this snapshot.  IDE consumers store this alongside their
    /// rendered state + pass it back as `lastSeenVersion` on the
    /// next `workbookSnapshotDelta` call.  Encoded via
    /// `loro::VersionVector::encode()` (stable Loro 1.12.0 wire
    /// format; opaque to JS -- the IDE round-trips it through napi
    /// `Buffer` ⇄ `Vec<u8>` without decoding).
    ///
    /// **Why on `WorkbookSnapshotJson` and not a separate accessor**:
    /// V3.6.0.8.1 lock TBD'd a `currentVersion()` accessor.
    /// V3.6.0.8.3 shipped without it; the mocha tests worked around
    /// it by probing via empty-Buffer `workbookSnapshotDelta` calls.
    /// Opus Lane B audit at V3.6.0.8.4 flagged the workaround as a
    /// race-window risk in multi-window collab (the engine could
    /// receive a remote op between the IDE's `workbookSnapshot()`
    /// call + the IDE's subsequent probe, leaving the IDE pinned to
    /// a VV one step behind reality).  Bundling `version` into
    /// `WorkbookSnapshotJson` makes the populate-and-capture atomic
    /// (the napi method holds the `&mut inner.lock()` throughout, so
    /// the VV captured here matches the VV stamped into the
    /// workbook cache via `set_workbook_cache`).
    ///
    /// **Additive field**: V3.5/V3.6 IDE consumers that destructure
    /// the snapshot continue to work (extra field is ignored unless
    /// referenced); opt-in consumers consult `.version`.
    ///
    /// **Rule 4 walk**: `Buffer` is napi-rs 3.9.0's safe wrapper
    /// around `Vec<u8>` (Send + Sync via Vec composition); the
    /// underlying encoded bytes are owned + cloneable.
    pub version: Buffer,
}

/// **Phase 5.7 V3.6.0.3 D2 (2026-05-24)** -- one format registration
/// in the WorkbookSnapshot's `formats` array.  Pairs a `FormatIdJson`
/// (V3.5.0.5 wire shape) with its format string.
///
/// For V3.6+ format-aware buildHtml rendering (D4): IDE looks up
/// `CellSnapshotJson.format: Option<FormatIdJson>` against this list
/// to find the matching format string.
///
/// **Rule 4 per-field walk**: `id: FormatIdJson` Send + Sync via the
/// V3.5.0.5 walk (positive composition of primitives + Option<u32> +
/// Option<BigInt>); `string: String` Send + Sync trivially.
/// Composition: `FormatDefJson: Send + Sync`.  **0 new Rule 4
/// triggers**; arc terminus stays at 6.
#[napi(object)]
pub struct FormatDefJson {
    /// The FormatId in V3.5.0.5 wire shape (kind = "builtin" |
    /// "custom"; payload fields per kind).
    pub id: FormatIdJson,
    /// The format string (e.g., `"0.00%"`, `"yyyy-mm-dd"`).  Used by
    /// V3.6+ engine-side `FormatTable::render_value` for number / date
    /// / currency display.
    pub string: String,
}

/// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)** -- one cell entry in a
/// `WorkbookSnapshotDeltaJson.changedCells` payload.  Pairs a sheet
/// id with the per-cell snapshot data (same `CellSnapshotJson` shape
/// used by the full `workbookSnapshot()` reply).
///
/// **Rule 4 per-field walk**: `sheet: u32` primitive; `cell:
/// CellSnapshotJson` Send + Sync via the V3.5.0.5 / V3.6.0.5 walks.
/// Composition: `ChangedCellJson: Send + Sync`.  **0 new triggers.**
#[napi(object)]
pub struct ChangedCellJson {
    pub sheet: u32,
    pub cell: CellSnapshotJson,
}

/// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)** -- one removed-cell entry
/// in `WorkbookSnapshotDeltaJson.removedCells`.  The IDE clears its
/// cached cell at this coordinate (typical source: undo of a PutValue
/// op or remote tombstone via SetCellFormat-with-None).
///
/// **Rule 4 per-field walk**: three primitive `u32`s.  Composition:
/// `RemovedCellJson: Send + Sync`.  **0 new triggers.**
#[napi(object)]
pub struct RemovedCellJson {
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
}

/// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- incremental WorkbookSnapshot
/// delta reply.**
///
/// Returned by [`CollabSession::workbook_snapshot_delta`].  Locked at
/// V3.6.0.8.1 design lock (see `docs/architecture/ide-consumer-contract.md
/// § 4.1.z6` V3.6.0.8.1 sub-section for the full design).
///
/// **Two-call IDE protocol**:
/// 1. First call: IDE passes `Buffer.alloc(0)`.  Engine returns
///    `fullRebuildRequired=true` + empty arrays + current `version`.
/// 2. IDE calls `workbookSnapshot()` for the full state, records the
///    returned `version` token alongside.
/// 3. Subsequent calls: IDE passes the stored `version`.  Engine returns
///    either a delta (merge into prior render) OR
///    `fullRebuildRequired=true` (discard local state, call
///    `workbookSnapshot()` again).
///
/// **Additive over WorkbookSnapshotJson** -- no shape break for
/// V3.5/V3.6 IDE consumers; they call `workbookSnapshot()` as before
/// and ignore this delta surface entirely.
///
/// **Rule 4 per-field walk**: `changed_cells: Vec<ChangedCellJson>`,
/// `removed_cells: Vec<RemovedCellJson>`, `sheets_changed:
/// Vec<SheetSnapshotJson>`, `formats_added: Vec<FormatDefJson>` -- all
/// `Vec<T>: Send + Sync` iff `T: Send + Sync`; all four element types
/// pass.  `sheets_removed: Vec<u32>` primitive.  `version: Buffer`
/// Send + Sync via napi-rs (the underlying `Vec<u8>` is).
/// `full_rebuild_required: bool` Send + Sync trivially.  Composition:
/// `WorkbookSnapshotDeltaJson: Send + Sync`.  **0 new triggers; arc
/// terminus stays at 6.**
#[napi(object)]
pub struct WorkbookSnapshotDeltaJson {
    /// Cells that newly exist OR whose value / formula / format /
    /// rendered changed since `lastSeenVersion`.  Same `CellSnapshotJson`
    /// shape as a full `workbookSnapshot()` cell entry; the IDE merges
    /// each into its prior render keyed by `(sheet, row, col)`.
    pub changed_cells: Vec<ChangedCellJson>,

    /// Cells that no longer exist at their `(sheet, row, col)` (typical
    /// source: undo of a `PutValue`).  IDE clears its cached cell at
    /// each coordinate.  Empty at V3.6.0.8.3 baseline -- the cell-only
    /// fast-path emits removed_cells only when a delta op explicitly
    /// drops a cell (V3.6.0.8.3 conservative scope deferred -- see
    /// docstring on `workbook_snapshot_delta` below).
    pub removed_cells: Vec<RemovedCellJson>,

    /// Sheets whose metadata changed since `lastSeenVersion` (rename,
    /// move, name change).  The IDE replaces its sheet-level entry for
    /// each.  Includes the full `cells: Vec<CellSnapshotJson>` payload
    /// for sheets in the delta (V3.6.0.8.3 baseline: when a rename op
    /// is present, the full-rebuild branch fires and ALL sheets are
    /// surfaced; the cell-only fast-path doesn't emit `sheets_changed`
    /// because cell ops don't change sheet metadata).
    pub sheets_changed: Vec<SheetSnapshotJson>,

    /// Sheet ids tombstoned since `lastSeenVersion` (`Op::RemoveSheet`).
    /// The IDE removes its sheet entry for each.
    pub sheets_removed: Vec<u32>,

    /// Formats registered since `lastSeenVersion` (`Op::RegisterFormat`
    /// for Custom ids; Builtin ids are not emitted here per the
    /// V3.6.0.X audit-of-D2 closure).  The IDE merges each into its
    /// `formats` table by `FormatId`.
    pub formats_added: Vec<FormatDefJson>,

    /// Opaque version-vector token.  IDE stores it and passes back on
    /// the next call as `lastSeenVersion`.  Encoded via
    /// `loro::VersionVector::encode()` (Loro 1.12.0 stable wire format
    /// -- see registry/loro-internal-1.12.0/src/version.rs:843); the
    /// IDE does NOT decode it -- it's an opaque blob round-tripped
    /// through napi `Buffer` ⇄ `Vec<u8>`.
    pub version: Buffer,

    /// `true` when the engine could not produce a delta and the IDE
    /// MUST call `workbookSnapshot()` instead.  Sources:
    /// - First call (empty `lastSeenVersion`).
    /// - Cache miss (no prior `workbookSnapshot()` call to populate the
    ///   workbook cache).
    /// - Staleness (`lastSeenVersion` doesn't match the cached VV --
    ///   typically because an invalidation site fired between calls).
    /// - Malformed `lastSeenVersion` (Loro VV decode error).
    ///
    /// When `true`, `changedCells` / `removedCells` / `sheetsChanged`
    /// / `sheetsRemoved` / `formatsAdded` are all empty; `version`
    /// carries the engine's CURRENT VV so the IDE can immediately
    /// retry the delta call right after its `workbookSnapshot()`
    /// fetch + cache populate (no race window).
    pub full_rebuild_required: bool,
}

#[napi(object)]
pub struct PresenceStateJson {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    pub selection_end_row: u32,
    pub selection_end_col: u32,
    pub typing: bool,
}

impl From<CorePresenceState> for PresenceStateJson {
    fn from(s: CorePresenceState) -> Self {
        Self {
            sheet: s.sheet,
            row: s.row,
            col: s.col,
            selection_end_row: s.selection_end_row,
            selection_end_col: s.selection_end_col,
            typing: s.typing,
        }
    }
}

impl From<PresenceStateJson> for CorePresenceState {
    fn from(s: PresenceStateJson) -> Self {
        Self {
            sheet: s.sheet,
            row: s.row,
            col: s.col,
            selection_end_row: s.selection_end_row,
            selection_end_col: s.selection_end_col,
            typing: s.typing,
        }
    }
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
    /// engine (PeerId sentinel -- Loro reserves the 0 value). napi-rs
    /// surfaces engine errors as JS `Error` exceptions.
    #[napi(constructor)]
    pub fn new(peer_id: BigInt) -> Result<Self> {
        let pid = peer_id_from_bigint(&peer_id)?;
        let session = CoreCollabSession::new(pid).map_err(collab_session_error_to_napi)?;
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
            .map_err(collab_session_error_to_napi)?;
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
    ///   - `-1` -> `0xFFFFFFFF` (silent wrap to u32::MAX)
    ///   - `NaN` -> `0` (silent coercion)
    ///   - `Infinity` -> `0` (silent coercion)
    ///   - `2.5` -> `2` (silent floor-toward-zero)
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
    /// **Phase 5.7 V3.6.0.X audit-of-D5 OPUS-HIGH-3 closure (2026-05-24)**:
    /// `sheet: f64` (was `sheet: u16`).  Pre-closure this docstring
    /// incorrectly claimed the V1 H2 silent-wrap class didn't apply at
    /// u16 -- Opus Lane B audit verified by reading napi-rs 3.9.0
    /// `FromNapiValue for u16` that ToUint32 + `try_into::<u16>()` only
    /// rejects post-ToUint32 values in [65536, 2^32); the [0, 65535]
    /// in-range silent corruptions (NaN -> 0, fractional -> truncate,
    /// 2^32 -> 0, etc.) survive uncaught.  Same hazard class as the
    /// V1 row/col closure.  Now `sheet` goes through
    /// [`validate_u16_index`] -- same f64-raw + manual validation
    /// pattern.
    ///
    /// `value: f64` is already raw (Number -> double, no coercion);
    /// validate finiteness here too (NaN/Infinity rejection).
    ///
    /// The TS-side `appendPutValueValidated` wrapper becomes
    /// defense-in-depth -- it fails earlier with friendlier messages
    /// but the engine-side validation is the load-bearing contract
    /// for direct callers.
    /// **Phase 5.7 V3.4.0.4a (2026-05-23) -- append an `Op::AddSheet`
    /// to this session.**
    ///
    /// Sheet ids are deterministic + assigned by the engine on replay
    /// in op-log append order (the producer does NOT pin the id in the
    /// op).  Append order = id-assignment order: first `addSheet` call
    /// creates sheet 0, second creates sheet 1, etc.
    ///
    /// **Why surfaced at V3.4.0.4a (engine napi for .qbook persistence)**:
    /// `CollabSession.rebuild_workbook` (called internally by
    /// `to_qbook`) replays the op log into a fresh `Workbook`, and
    /// `Op::PutValue { sheet, ... }` replay REQUIRES the sheet to
    /// already exist.  Without an `addSheet` napi, sessions built
    /// purely via `appendPutValue` could not be saved (rebuild_workbook
    /// would fail with `session_replay -- invalid sheet`).  This
    /// minimal wrapper closes the gap; V3.5+ may expose a richer Op
    /// surface (RenameSheet, DeleteSheet, etc.).
    ///
    /// `chunkRows` is the per-sheet row partition size for the
    /// Workbook's internal storage (Phase 2A optimization for
    /// multi-million-cell scaling).  Pass a sane default (e.g., 1000)
    /// at V3.4.0.4a scale; V3.5+ may surface this as a configurable.
    ///
    /// **V3.4.0.X HIGH-2 closure (2026-05-24, single-lane Codex)**:
    /// argument typed `f64` + validated to `[1, u32::MAX]` integer range
    /// to match `appendPutValue`'s `ToUint32`-boundary discipline.
    /// Pre-closure the binding accepted `u32` directly + napi-rs's
    /// `ToUint32` would coerce `NaN/Infinity/negative/fractional` to
    /// integer-domain values (e.g., JS `-1` -> `4294967295`) -- a
    /// `chunk_rows = 0` AddSheet would replay successfully but then
    /// later `ColumnStore::with_chunk_rows(0)` would assert.  Engine-side
    /// `WorkbookRuntime::add_sheet` rejects `chunk_rows == 0` before
    /// appending the op; the napi-side validation gives the IDE caller
    /// a structured `[bad_argument]` error at the FFI boundary instead
    /// of a deep panic + a phantom op that fails replay later.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `chunkRows` is NaN / Infinity / negative /
    ///   fractional / zero / above `u32::MAX`.
    /// - Engine kind-prefixed (`session_oplog` for op-log append
    ///   failure; `session_replay` would NOT fire here -- replay
    ///   happens at rebuild_workbook time, not append time).
    #[napi(js_name = "addSheet")]
    pub fn add_sheet(&self, name: String, chunk_rows: f64) -> Result<()> {
        let chunk_rows_u32 = validate_u32_index("addSheet", "chunkRows", chunk_rows)?;
        if chunk_rows_u32 == 0 {
            return Err(bad_argument_error(format!(
                "addSheet: chunkRows must be >= 1 (engine rejects chunk_rows == 0 to prevent ColumnStore panic), got {chunk_rows}"
            )));
        }
        let op = Op::AddSheet {
            name,
            chunk_rows: chunk_rows_u32,
        };
        let mut inner = self.inner.lock();
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.5.0.3a (2026-05-24) -- append an `Op::RenameSheet`
    /// to this session.**
    ///
    /// Per V3.5.0.1 D4 (the first of three sheet-ops sub-steps; D4 split
    /// into 0.3a renameSheet / 0.3b deleteSheet / 0.3c moveSheet per
    /// V3.5.0.3a scope-discovery: Op::RemoveSheet + Op::MoveSheet do
    /// NOT exist on the wire yet and require fresh CRDT semantic locks).
    ///
    /// **Sheet id is the sheet's current u16 id**; the rename applies to
    /// whichever sheet currently lives at that id at replay time.  The
    /// `old_name` field is ADVISORY per Phase 5.3 step 2 Codex M2
    /// closure (replay does not validate old_name == current name;
    /// CRDT merge of concurrent renames legitimately produces
    /// old-name-mismatch).
    ///
    /// **Contract divergence from `WorkbookRuntime::rename_sheet`** (per
    /// `crates/ql-exec/src/workbook_runtime/sheets.rs:138-200`): the
    /// runtime path REWRITES all formula text referencing the old sheet
    /// name + emits the rewrites as `Op::PutFormula` ops bundled with
    /// `Op::RenameSheet` in a single `BatchCommit`.  This napi method
    /// is a THIN WRAPPER that appends ONLY `Op::RenameSheet` -- formula
    /// text in the cache stays stale until the next `workbookSnapshot`
    /// / `toQbook` call, which triggers `rebuild_workbook` ->
    /// `repair_sheet_rename_chain` (Phase 5.3 step 3) to resolve cross-
    /// sheet formula references at materialization time.  Acceptable
    /// for V3.5.0.3a scope (IDE consumer flow always reads via
    /// workbookSnapshot which routes through rebuild_workbook); V3.6+
    /// may add a runtime-equivalent napi method if profiling shows
    /// repair-at-materialization cost is too high.
    ///
    /// **Pre-V3.5.0.3a engine state lookup**: the napi reads the
    /// current sheet name from `inner.rebuild_workbook(&default_registry())`
    /// to populate the `old_name` field at append time (matches the
    /// producer-side debuggability contract; `old_name` records what
    /// the producer's local state was at write time).  This pays an
    /// O(N) replay cost per rename; acceptable at V3.5.0.3a scale
    /// (rename is a user-initiated UI action, ~1/min max).  V3.5.0.6+
    /// partial-invalidate undo work may eliminate this cost via a
    /// `current_sheet_name(id)` accessor on CollabSession.
    ///
    /// **CRDT convergence**: cross-peer renames converge via Phase 5.3
    /// step 3 `repair_sheet_rename_chain`; two peers concurrently
    /// renaming sheet 5 to different names produce a deterministic
    /// chain that resolves at rebuild_workbook time.  Pin in mocha via
    /// mergeBytes round-trip.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `id` exceeds u16 range OR refers to a
    ///   sheet id that does NOT exist in the current workbook (sheet_count
    ///   check happens at the rebuild_workbook step above).
    /// - `[session_oplog]` for op-log append failure.
    /// - `[session_replay]` if rebuild_workbook fails at the pre-append
    ///   lookup step (e.g., op-log corruption).
    #[napi(js_name = "renameSheet")]
    pub fn rename_sheet(&self, id: u32, new_name: String) -> Result<()> {
        // Validate `id` fits in SheetId (u16).
        if id > u16::MAX as u32 {
            return Err(bad_argument_error(format!(
                "renameSheet: id must be in [0, 65535] (u16::MAX), got {id}"
            )));
        }
        let sheet_id = id as u16;
        let mut inner = self.inner.lock();
        // Look up the current sheet name (advisory per Phase 5.3 Codex M2;
        // but recorded for debuggability + future strict-mode replay).
        // O(N) replay; see docstring on the per-call cost discussion.
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;
        let old_name = workbook
            .sheet(sheet_id)
            .map(|s| s.name().to_string())
            .ok_or_else(|| {
                bad_argument_error(format!(
                    "renameSheet: id {id} does not exist (workbook has {} sheets)",
                    workbook.sheet_count()
                ))
            })?;
        let op = Op::RenameSheet {
            id: sheet_id,
            old_name,
            new_name,
        };
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.5.0.3b (2026-05-24) -- append an `Op::RemoveSheet`
    /// to this session (tombstone the sheet at `id`).**
    ///
    /// Per V3.5.0.1 D4 (second of three sheet-ops sub-steps; 0.3b ships
    /// after 0.3a renameSheet) + V3.5.0.3b CRDT semantic decision lock:
    /// tombstone preserving the id slot (NOT hard delete; see
    /// `Op::RemoveSheet` docstring in `ql-oplog/src/op.rs` for the full
    /// rationale).
    ///
    /// **Pre-delete existence check**: validates `id <= u16::MAX` +
    /// pre-rebuilds the workbook to confirm `id < sheet_count`.  Already-
    /// tombstoned sheets ARE accepted at the napi layer (returns Ok; the
    /// resulting Op::RemoveSheet replay is an idempotent no-op).  This
    /// mirrors the CRDT-friendly idempotency contract: a peer that
    /// re-deletes is silently OK.
    ///
    /// **Behavior on tombstoned sheet at rebuild time**:
    /// - `workbookSnapshot` skips the sheet (filtered at the napi layer
    ///   per V3.5.0.3b's filter addition).
    /// - Cell-keyed ops (`PutValue` / `PutFormula` / `ClearFormula`)
    ///   targeting the tombstoned sheet are silently dropped at replay
    ///   per the new `is_sheet_removed` check in `apply_op`.
    /// - `renameSheet` on a tombstoned sheet currently SUCCEEDS at the
    ///   replay layer (renames the underlying Sheet; user-visible if the
    ///   tombstone is later cleared -- which V3.5.0.3b does NOT support).
    ///   V3.6+ may add explicit rejection if tombstone-rename ambiguity
    ///   surfaces as a user-facing concern.
    ///
    /// **Formula references to deleted sheets**: V3.5.0.3b leaves
    /// formula text intact (`=SheetN!A1` keeps pointing at the tombstoned
    /// sheet).  V3.6+ may extend `repair_sheet_rename_chain` to rewrite
    /// these as `#REF!` per xlsx/Sheets convention.  Today the deleted
    /// sheet's cells are unreachable via snapshot but the formula text
    /// referencing them stays as a string in cells that survive on
    /// other sheets.
    ///
    /// **Restore**: NOT supported at V3.5.0.3b.  Cell storage is
    /// preserved internally but no `restoreSheet` napi exists.  V3.6+
    /// may add this if user-facing undo-delete is needed.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `id` exceeds u16 range OR refers to a
    ///   sheet id that does NOT exist in the current workbook.
    /// - `[session_oplog]` for op-log append failure.
    /// - `[session_replay]` if the pre-delete rebuild_workbook fails.
    #[napi(js_name = "deleteSheet")]
    pub fn delete_sheet(&self, id: u32) -> Result<()> {
        if id > u16::MAX as u32 {
            return Err(bad_argument_error(format!(
                "deleteSheet: id must be in [0, 65535] (u16::MAX), got {id}"
            )));
        }
        let sheet_id = id as u16;
        let mut inner = self.inner.lock();
        // Pre-delete existence check via rebuild_workbook.  O(N) replay;
        // matches the renameSheet cost pattern (V3.5.0.6+ may eliminate
        // via a session-level cache of sheet id existence).
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;
        if (sheet_id as usize) >= workbook.sheet_count() {
            return Err(bad_argument_error(format!(
                "deleteSheet: id {id} does not exist (workbook has {} sheets)",
                workbook.sheet_count()
            )));
        }
        // Note: already-tombstoned sheet is NOT a bad_argument (CRDT
        // idempotency; the resulting Op::RemoveSheet replay is a no-op).
        let op = Op::RemoveSheet { id: sheet_id };
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.6.0.10 D8 (2026-05-25) -- append an
    /// `Op::RestoreSheet` to this session (un-tombstone a sheet
    /// previously deleted via `deleteSheet`).**
    ///
    /// Per V3.6.0.1 D8 lock: new wire variant `Op::RestoreSheet { id }`
    /// reverses the V3.5.0.3b tombstone effect.  Cells written
    /// BEFORE the original `deleteSheet` are preserved by the tombstone
    /// semantic and reappear on restore.  Cells silently-no-op'd
    /// while tombstoned do NOT reappear -- they never reached storage.
    ///
    /// **id validation**: `id <= u16::MAX` + pre-rebuild existence
    /// check (mirrors `deleteSheet`).  Already-restored or never-
    /// tombstoned ids are NOT a bad_argument (CRDT idempotency; the
    /// resulting `Op::RestoreSheet` replay is a no-op).
    ///
    /// **Cross-peer**: HashSet::remove on absent is a no-op.
    /// Concurrent {RemoveSheet, RestoreSheet} resolved by Loro's
    /// causal-merge order; both peers converge to the same final
    /// tombstone state (whichever op replays second wins).
    ///
    /// **Cache + delta interaction (V3.6.0.10 D8 classify_delta_op
    /// closure)**: `Op::RestoreSheet` is in the metadata-ops
    /// allowlist that forces `fullRebuildRequired=true` on the next
    /// `workbookSnapshotDelta` call.  The cell cache walker dropped
    /// pre-tombstone cells at `CacheEffect::RemoveSheet` apply; full
    /// rebuild is the cheapest way to get them back into the
    /// snapshot reply.  The underlying Workbook storage retained the
    /// cells (V3.5.0.3b preservation invariant), so the full rebuild
    /// has them available.
    ///
    /// # Errors
    /// - `[bad_argument]` if `id > 65535`.
    /// - `[bad_argument]` if `id >= sheet_count()` (sheet has never
    ///   been created in this workbook).
    /// - `[session_oplog]` if `rebuild_workbook` fails (replay error).
    #[napi(js_name = "restoreSheet")]
    pub fn restore_sheet(&self, id: u32) -> Result<()> {
        if id > u16::MAX as u32 {
            return Err(bad_argument_error(format!(
                "restoreSheet: id must be in [0, 65535] (u16::MAX), got {id}"
            )));
        }
        let sheet_id = id as u16;
        let mut inner = self.inner.lock();
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;
        if (sheet_id as usize) >= workbook.sheet_count() {
            return Err(bad_argument_error(format!(
                "restoreSheet: id {id} does not exist (workbook has {} sheets)",
                workbook.sheet_count()
            )));
        }
        // Note: already-untombstoned sheet is NOT a bad_argument (CRDT
        // idempotency; the resulting Op::RestoreSheet replay is a no-op).
        let op = Op::RestoreSheet { id: sheet_id };
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.5.0.3c (2026-05-24) -- append an `Op::MoveSheet`
    /// to this session (reorder display position; id stays stable).**
    ///
    /// Per V3.5.0.1 D4 (third of three sheet-ops sub-steps; 0.3a
    /// renameSheet shipped at `74aa5039e04`; 0.3b deleteSheet shipped at
    /// `9be3672ca01`; 0.3c moveSheet closes D4) + V3.5.0.3c CRDT
    /// semantic decision lock: **display-order overlay** (NOT id shift
    /// or replay-time remapping).  See `Op::MoveSheet` docstring in
    /// `ql-oplog/src/op.rs` for the full rationale.
    ///
    /// **id stability preserved**: the underlying `Workbook.sheets`
    /// vec is UNCHANGED.  Only `Workbook.sheet_display_order` (a
    /// separate `Vec<SheetId>` overlay) is mutated.  Subsequent ops
    /// referencing the moved sheet by id (`Op::PutValue { sheet: id,
    /// .. }` etc.) keep landing on the correct sheet.
    ///
    /// **`new_index` semantics**: 0-based position in the post-move
    /// display-order vec.  The replay handler:
    /// 1. Finds the current display position of `id`.
    /// 2. Removes `id` from its current position.
    /// 3. Inserts `id` at `new_index` (clamped to `[0,
    ///    display_order.len()]` -- out-of-range silently clamps to end
    ///    for CRDT idempotency).
    ///
    /// **Pre-move existence check** mirrors renameSheet + deleteSheet:
    /// validates `id <= u16::MAX` + pre-rebuilds the workbook to
    /// confirm `id < sheet_count`.  Already-at-position `new_index`
    /// (no-op move) is NOT a bad_argument (CRDT idempotency).
    ///
    /// **Move-tombstoned-sheet**: silently applies (display order
    /// remembers the user's reorder intent even for deleted sheets;
    /// `workbookSnapshot` filters tombstones AFTER display-order
    /// resolution).
    ///
    /// **Cross-peer convergence**: concurrent moves on the same sheet
    /// resolve via deterministic Loro causal-merge order; whichever
    /// replays second wins on display position.
    ///
    /// **Per-call cost**: O(N) replay for the pre-existence rebuild
    /// (matches renameSheet + deleteSheet pattern).  V3.5.0.6+ may
    /// eliminate via a session-level sheet-id cache.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `id` exceeds u16 range OR refers to a
    ///   non-existent sheet.  Tombstoned sheets are OK -- move on
    ///   tombstone is intentional.  `new_index >= sheet_count` is OK
    ///   (clamped at replay time).
    /// - `[session_oplog]` / `[session_replay]` per engine errors.
    #[napi(js_name = "moveSheet")]
    pub fn move_sheet(&self, id: u32, new_index: u32) -> Result<()> {
        if id > u16::MAX as u32 {
            return Err(bad_argument_error(format!(
                "moveSheet: id must be in [0, 65535] (u16::MAX), got {id}"
            )));
        }
        let sheet_id = id as u16;
        let mut inner = self.inner.lock();
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;
        if (sheet_id as usize) >= workbook.sheet_count() {
            return Err(bad_argument_error(format!(
                "moveSheet: id {id} does not exist (workbook has {} sheets)",
                workbook.sheet_count()
            )));
        }
        // Note: new_index out-of-range is OK (clamped at replay time).
        // Tombstoned sheets are OK (display order updates per CRDT
        // semantic; snapshot filter applies separately).
        let op = Op::MoveSheet {
            id: sheet_id,
            new_index,
        };
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    #[napi(js_name = "appendPutValue")]
    pub fn append_put_value(&self, sheet: f64, row: f64, col: f64, value: f64) -> Result<()> {
        // Validate sheet: finite, non-negative, integer, in u16 range.
        // V3.6.0.X audit-of-D5 OPUS-HIGH-3 closure (2026-05-24): pre-closure
        // sheet was napi-rs u16, which silently coerces NaN/Infinity/fractional/
        // 2^32+ to in-range u16 values via ToUint32 + try_into::<u16>().  Now
        // f64 + manual validation; precise [bad_argument] errors instead.
        let sheet_u16 = validate_u16_index("appendPutValue", "sheet", sheet)?;
        // Validate row + col: finite, non-negative, integer, in u32 range.
        let row_u32 = validate_u32_index("appendPutValue", "row", row)?;
        let col_u32 = validate_u32_index("appendPutValue", "col", col)?;
        // Validate value: finite (NaN/Infinity rejected).
        if !value.is_finite() {
            return Err(bad_argument_error(format!(
                "appendPutValue value must be finite, got {value}"
            )));
        }
        let op = Op::PutValue {
            sheet: sheet_u16,
            row: row_u32,
            col: col_u32,
            value: CellWireValue::Number(value),
        };
        let mut inner = self.inner.lock();
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.6.0.6 D5 (2026-05-24) -- IDE-facing PutFormula napi.**
    ///
    /// Thin wrapper over `Op::PutFormula { sheet, row, col, text }`
    /// (shipping engine-side since Phase 4.6.x).  Mirrors
    /// `appendPutValue`'s validation discipline -- validates row/col as
    /// finite, non-negative, integer, in u32 range BEFORE the Rust
    /// boundary (so the V1 audit ToUint32-coercion silent-wrap class
    /// stays closed for formulas too).  `sheet` is `u16` (napi-rs
    /// rejects out-of-range integers at the FFI boundary; matches
    /// `appendPutValue` shape).  `text` is the raw formula source the
    /// user typed (typically `"=SUM(A1:B10)"`); the engine stores it
    /// verbatim and `rebuild_workbook` materializes it via
    /// `repair_sheet_rename_chain` at snapshot time so cross-sheet
    /// refs to renamed sheets surface repaired text in
    /// `workbookSnapshot.sheets[].cells[].formula`.
    ///
    /// **No wire change**: `Op::PutFormula` is unchanged.  No new
    /// CacheEffect needed (the cell-keyed cache walker already handles
    /// PutFormula via `CacheEffect::Cell`).
    ///
    /// **V3.5.0.X A-HIGH-2 IDE-level verification gap closure**:
    /// V3.5.0.X landed `workbookSnapshot` reading from `rebuild_workbook`
    /// `formula_at` so renamed sheets surface repaired formula text.
    /// That was verified only by a Rust ql-collab test pre-D5 because
    /// the IDE had no PutFormula write-path.  Post-D5: the IDE can
    /// drive the end-to-end repaired-formula scenario via mocha
    /// (open .qbook, appendPutFormula referencing S, rename S, assert
    /// `workbookSnapshot()` surfaces the repaired text).
    ///
    /// **Edit-flow companion** (V3.6.0.X audit-of-D4 OPUS-HIGH-2 § G.2):
    /// IDE renderers that emit `data-raw-value` for click-to-edit
    /// SHOULD also emit `data-raw-formula` when a cell has formula
    /// text -- `beginEdit` should source the input value from
    /// `data-raw-formula` (formula source) when present, then
    /// `data-raw-value` (literal), then `data-original-text` (rendered
    /// display).  Otherwise a cell with both a formula AND a cached
    /// literal value would open editing on the literal (not the
    /// formula the user typed).
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `row` or `col` is NaN/Infinity/negative/
    ///   non-integer/out-of-u32-range.
    /// - `[session_oplog]` if the underlying `append_op` fails (e.g.,
    ///   codec encode error; the cell-keyed CacheEffect path).
    #[napi(js_name = "appendPutFormula")]
    pub fn append_put_formula(
        &self,
        sheet: f64,
        row: f64,
        col: f64,
        text: String,
    ) -> Result<()> {
        // V3.6.0.X audit-of-D5 OPUS-HIGH-3 closure (2026-05-24): sheet
        // is now f64 + validate_u16_index for the same reason as
        // appendPutValue's symmetric closure.  See validate_u16_index
        // docstring + the AUDIT transcript section C.3.
        let sheet_u16 = validate_u16_index("appendPutFormula", "sheet", sheet)?;
        let row_u32 = validate_u32_index("appendPutFormula", "row", row)?;
        let col_u32 = validate_u32_index("appendPutFormula", "col", col)?;
        let op = Op::PutFormula {
            sheet: sheet_u16,
            row: row_u32,
            col: col_u32,
            text,
        };
        let mut inner = self.inner.lock();
        inner.append_op(op).map_err(collab_session_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.2.a (2026-05-22) -- cell-snapshot export for the IDE grid widget.**
    ///
    /// Returns a JSON-serialized snapshot of the latest `PutValue`
    /// per `(row, col)` on the requested sheet. The IDE-side cell-
    /// grid widget (V3.2.b onward) parses this to render without
    /// leaking Loro internals across the FFI boundary.
    ///
    /// # Return shape (snapshot_format_version = 1)
    ///
    /// ```json
    /// {
    ///   "snapshot_format_version": 1,
    ///   "sheet": <u16>,
    ///   "entries": [
    ///     { "row": <u32>, "col": <u32>, "value": <CellValueJson> },
    ///     ...
    ///   ]
    /// }
    /// ```
    ///
    /// where `CellValueJson` is a tagged-union mirroring
    /// [`CellWireValue`]:
    /// - `{ "kind": "number",  "value": <f64> }`
    /// - `{ "kind": "boolean", "value": <bool> }`
    /// - `{ "kind": "text",    "value": <string> }`
    /// - `{ "kind": "error",   "value": <string> }`
    /// - `{ "kind": "pending" }`
    ///
    /// Entries are sorted by `(row, col)` for deterministic output
    /// (mocha snapshot tests + IDE virtualized rendering both rely
    /// on stable ordering).
    ///
    /// # Semantics
    ///
    /// V3.2.a scope: iterates this session's LOCAL op log and keeps
    /// the latest `PutValue` per `(row, col)` by application order.
    /// Last-write-wins is correct for `PutValue` ops under Loro's
    /// merge semantics; the op log applies remote ops via
    /// `merge_bytes` in deterministic order so this iteration is
    /// CRDT-consistent for V3.2.a's PutValue-only scope.
    ///
    /// V3.2.b+ may upgrade this to route through `rebuild_workbook`
    /// once the full Op enum (formulas, format, etc.) lands. See
    /// `.plans/_active.md` (V3.2 entry plan) Decision 1.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if the op log iterator emits a decode error.
    /// - `[bad_argument]` if JSON serialization fails (defensive;
    ///   `serde_json` shouldn't fail on the shapes used here).
    ///
    /// # Performance
    ///
    /// Iterates the entire op log per call (O(N) in op count). For
    /// V3.2.a-scale (thousands of cells), this is fast (<1ms per
    /// 10K ops on local dev). V3.x may add incremental snapshot
    /// caching if profiling justifies.
    #[napi(js_name = "exportSnapshot")]
    pub fn export_snapshot(&self, sheet: u16) -> Result<String> {
        // V3.3.0.3 (2026-05-22): reads from the engine's incremental
        // snapshot cache via `CollabSession::snapshot_cells(sheet)`.
        // The cache is maintained in sync by every op-mutation path
        // (`append_op` O(1) insert; `merge_bytes` + `discard_pending_ops`
        // + `from_snapshot` full rebuild).  Pre-V3.3.0.3 this method
        // walked the entire op log per call (V2.d Opus M4: O(N) lock-
        // hold time scales with op log size).  Now O(cells-in-cache)
        // filtered by sheet at the engine layer.
        //
        // V3.4.0.2 (2026-05-23): `snapshot_cells` now returns `CellState`
        // (per V3.4.0.1 D1 hybrid; carries both `value: Option<CellWire
        // Value>` and `formula: Option<String>`).  The V3.4.0.2 napi
        // JSON shape is UNCHANGED from V3.3.0.3 -- we extract `.value`
        // and SKIP entries where it's None (cells with a formula but no
        // literal value).  V3.4.0.5+ will introduce a separate napi
        // method or extend the JSON shape (with a `formula` field) to
        // surface formula-only cells; that's IDE-rendering work, not
        // V3.4.0.2's contract-preservation work.
        //
        // `snapshot_cells` returns entries pre-sorted by (row, col)
        // ascending; the filter_map + JSON-build preserves that order.
        let inner = self.inner.lock();
        let entries_vec = inner.snapshot_cells(sheet);
        let entries_json: Vec<serde_json::Value> = entries_vec
            .into_iter()
            .filter_map(|((row, col), state)| {
                // V3.4.0.2: extract literal value; skip formula-only cells.
                let value = state.value?;
                let value_json = match value {
                    CellWireValue::Number(n) => {
                        serde_json::json!({"kind": "number", "value": n})
                    }
                    CellWireValue::Boolean(b) => {
                        serde_json::json!({"kind": "boolean", "value": b})
                    }
                    CellWireValue::Text(s) => {
                        serde_json::json!({"kind": "text", "value": s})
                    }
                    CellWireValue::Error(s) => {
                        serde_json::json!({"kind": "error", "value": s})
                    }
                    CellWireValue::Pending => {
                        serde_json::json!({"kind": "pending"})
                    }
                };
                Some(serde_json::json!({"row": row, "col": col, "value": value_json}))
            })
            .collect();
        let payload = serde_json::json!({
            "snapshot_format_version": 1,
            "sheet": sheet,
            "entries": entries_json,
        });
        serde_json::to_string(&payload).map_err(|e| {
            bad_argument_error(format!("exportSnapshot: JSON serialization failed: {e}"))
        })
    }

    /// **Phase 5.7 V3.3.0.2 (2026-05-22) -- enumerate distinct sheets
    /// present in the local op log.**
    ///
    /// Walks the local op log, collects every distinct `sheet` u16
    /// referenced by a `PutValue` op, returns them as a sorted ascending
    /// `Vec<u16>`.  Empty if no `PutValue` ops have been appended.
    ///
    /// V3.3.0 design decision D3 (LOCKED at engine `5fd7ff73648`):
    /// u16-only return for this method.  Display name + color + hidden
    /// flags wait for a future `SheetMetadata` Op variant (V3.4+) and
    /// a separate `listSheetsMetadata()` accessor.
    ///
    /// # Semantics
    ///
    /// V3.3.0 scope: scans the entire op log per call (O(N) in op
    /// count).  Sheets only appear in the result if a `PutValue` op
    /// references them; an "empty" sheet that was created via a future
    /// `SheetMetadata` Op but received no values is NOT enumerated
    /// here (V3.4+ surface).
    ///
    /// CRDT-consistent: pollRemote-merged blobs from peers are
    /// already in the local op log before this method walks; cross-
    /// peer sheet sets converge.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if the op log iterator emits a decode error.
    ///
    /// # Performance
    ///
    /// Iterates the entire op log per call (O(N) in op count).  For
    /// V3.3 scale (couple thousand ops, few sheets), this is fast
    /// (<1ms on local dev).  V3.4+ may add an incremental cache if
    /// profiling justifies (mirrors the V3.2.d Opus M4 -> V3.3.0.3
    /// `exportSnapshot` incremental-cache decision).
    #[napi(js_name = "listSheets")]
    pub fn list_sheets(&self) -> Result<Vec<u16>> {
        // **V3.3.0.X audit closure (MEDIUM-3, 2026-05-23, Opus
        // adversarial lane)**: read sheets from the V3.3.0.3
        // incremental snapshot cache instead of walking the op log
        // per call.  Pre-closure this method was O(N) in op count
        // per invocation (V3.2.d Opus M4 ANALOG for listSheets);
        // post-closure it's O(cells-in-cache).  The cache is
        // maintained by 7 op-mutation paths (new / from_snapshot /
        // append_op / merge_bytes / discard_pending_ops / poll_remote_
        // with_limit + V3.3.0.X-added undo/redo); the sheet set
        // derived from cache keys is canonical for the same reason
        // `snapshot_cells` is canonical.
        let inner = self.inner.lock();
        Ok(inner.list_sheets_from_cache())
    }

    /// **Phase 5.7 V3.4.0.3 (2026-05-23) -- undo the session's last
    /// local op.**
    ///
    /// Thin wrapper over [`CoreCollabSession::undo`].  Returns `true`
    /// if a Loro `UndoManager` stack item was consumed (inverse op
    /// appended to the visible log) and `false` if the stack was
    /// empty (caller's "Cmd-Z when nothing to undo" no-op).
    ///
    /// **Local-only** per the engine method's Loro `UndoManager`
    /// contract: remote ops merged via `mergeBytes` / `pollRemote` are
    /// NOT affected.  Presence updates are excluded from the undo
    /// stack by construction (see `CollabSession::new`).
    ///
    /// **Cache invariant** (V3.3.0.X HIGH-1 closure carried + V3.4.0.2
    /// CellState shape): on `consumed == true` the engine method
    /// calls `rebuild_snapshot_cache` BEFORE auto-flush, so a
    /// subsequent `exportSnapshot` reads the post-undo `CellState`
    /// view atomically.  IDE consumers can follow `undo() == true`
    /// with `exportSnapshot` without re-locking.
    ///
    /// **Auto-flush** (V3.5 V2 V2 + Codex M2 audit closure): triggers
    /// per `setAutoFlushPolicy` ONLY when `consumed == true`.  An
    /// empty-stack undo never attempts the flush -- a closed transport
    /// cannot turn "nothing to undo" into a spurious
    /// `[transport_closed]` error.
    ///
    /// # Errors
    ///
    /// - Whatever `CollabSessionError::kind()` returns from the engine
    ///   layer (transport errors during the auto-flush after a
    ///   consumed undo, op-log decode failures during rebuild, etc.).
    ///   Mapped via `collab_session_error_to_napi`.
    #[napi(js_name = "undo")]
    pub fn undo(&self) -> Result<bool> {
        let mut inner = self.inner.lock();
        inner.undo().map_err(collab_session_error_to_napi)
    }

    /// **Phase 5.7 V3.4.0.3 (2026-05-23) -- redo the last undone op.**
    ///
    /// Thin wrapper over [`CoreCollabSession::redo`].  Returns `true`
    /// if a redo-stack item was consumed, `false` otherwise.
    ///
    /// **Cache + auto-flush + error semantics** mirror [`undo`] above;
    /// the engine method's docstring is the canonical reference.
    #[napi(js_name = "redo")]
    pub fn redo(&self) -> Result<bool> {
        let mut inner = self.inner.lock();
        inner.redo().map_err(collab_session_error_to_napi)
    }

    /// **Phase 5.7 V3.4.0.5 (2026-05-23) -- write this session's own
    /// presence state into the shared `"presence"` LoroMap.**
    ///
    /// Thin wrapper over [`CoreCollabSession::update_presence`].  Uses
    /// the session's `PeerId` as the map key.  Subsequent calls
    /// overwrite the prior value (LWW per peer); merges with other
    /// peers' presence writes preserve all distinct peers (LoroMap
    /// is per-key LWW).
    ///
    /// **Auto-flush** (V3.5 V2 V2): fires per `setAutoFlushPolicy`.
    /// Partial-state contract on flush failure: the presence write
    /// is already committed locally when the auto-flush attempt
    /// runs (same shape as `appendPutValue`).
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `state` fields are malformed (defensive;
    ///   the napi(object) conversion validates required fields at the
    ///   FFI boundary).
    /// - Engine kind-prefixed (e.g., `[transport_closed]` for
    ///   auto-flush failure after a consumed update).
    #[napi(js_name = "updatePresence")]
    pub fn update_presence(&self, state: PresenceStateJson) -> Result<()> {
        let mut inner = self.inner.lock();
        inner
            .update_presence(state.into())
            .map_err(collab_session_error_to_napi)
    }

    /// **Phase 5.7 V3.4.0.5 (2026-05-23) -- read a peer's most recent
    /// presence state.**
    ///
    /// Thin wrapper over [`CoreCollabSession::peer_presence`].  Returns
    /// `Some(state)` if the peer has updated presence in this session,
    /// `None` if the peer has never updated (or was removed via
    /// `clearPresence` / `sweepPresence`).
    ///
    /// Callers enumerating ALL peers should use [`peers_with_presence`]
    /// to get the peer-id list, then call this per peer.  V3.4.1+ may
    /// add a bulk `allPeerPresence(): Map<BigInt, PresenceStateJson>`
    /// accessor if profiling justifies.
    ///
    /// # Errors
    ///
    /// - Engine kind-prefixed for op-log decode failures + presence
    ///   deserialization errors (`PresenceError::Deserialize` if a
    ///   peer wrote a malformed PresenceState blob).
    #[napi(js_name = "peerPresence")]
    pub fn peer_presence(&self, peer: BigInt) -> Result<Option<PresenceStateJson>> {
        let pid = peer_id_from_bigint(&peer)?;
        let inner = self.inner.lock();
        Ok(inner
            .peer_presence(pid)
            .map_err(collab_session_error_to_napi)?
            .map(PresenceStateJson::from))
    }

    /// **Phase 5.7 V3.4.0.5 (2026-05-23) -- remove this session's own
    /// presence entry from the shared map.**
    ///
    /// Thin wrapper over [`CoreCollabSession::clear_presence`].  Use
    /// when the peer leaves the session (window close, disconnect).
    /// After removal, other peers' `peerPresence(selfId)` returns
    /// `None`.
    ///
    /// **Auto-flush** semantics match [`updatePresence`].
    #[napi(js_name = "clearPresence")]
    pub fn clear_presence(&self) -> Result<()> {
        let mut inner = self.inner.lock();
        inner
            .clear_presence()
            .map_err(collab_session_error_to_napi)
    }

    /// **Phase 5.7 V3.4.0.5 (2026-05-23) -- remove ALL presence
    /// entries from the shared map.**
    ///
    /// Thin wrapper over [`CoreCollabSession::sweep_presence`].
    /// Returns the count of peers removed.  V1 contract: sweeps every
    /// presence entry unconditionally (no threshold).  V3.4.1+ may add
    /// a threshold-based variant when per-peer staleness tracking
    /// (last-update timestamp) lands engine-side.
    ///
    /// **Use after `fromSnapshot`** for "rejoin with clean presence"
    /// pattern -- presence persists in the LoroDoc snapshot (V1 known
    /// limitation; documented in engine `presence.rs`).
    ///
    /// **Auto-flush**: triggers ONE auto-flush after the batch removal
    /// (not per-key -- N intermediate snapshots would be wasted
    /// bandwidth).  Partial-state contract: all N entries are removed
    /// locally before the auto-flush attempt.
    ///
    /// Returns count as `u32` for napi (engine returns `usize`; we
    /// cast).  In practice presence-peer counts are tiny (single-digit
    /// to low-double-digit); the cast is safe + the unit is "peers
    /// removed".
    #[napi(js_name = "sweepPresence")]
    pub fn sweep_presence(&self) -> Result<u32> {
        let mut inner = self.inner.lock();
        let removed = inner
            .sweep_presence()
            .map_err(collab_session_error_to_napi)?;
        Ok(removed as u32)
    }

    /// **Phase 5.7 V3.4.0.5 (2026-05-23) -- enumerate peers with
    /// presence entries.**
    ///
    /// Thin wrapper over [`CoreCollabSession::peers_with_presence`].
    /// Returns the peer-id list in Loro's iteration order (NOT
    /// guaranteed sorted; callers needing determinism should sort).
    ///
    /// Use as the V3.4.0.5 enumeration primitive for IDE consumers
    /// rendering "who's here" panels: first call
    /// `peersWithPresence()`, then call `peerPresence(peerId)` per
    /// returned id to fetch each peer's state.
    ///
    /// # Errors
    ///
    /// - Engine kind-prefixed (e.g., `[presence_peer_key_parse]` if a
    ///   map key can't be parsed as a PeerId -- only reachable if a
    ///   future writer uses an incompatible encoding).
    #[napi(js_name = "peersWithPresence")]
    pub fn peers_with_presence(&self) -> Result<Vec<BigInt>> {
        let inner = self.inner.lock();
        let peers = inner
            .peers_with_presence()
            .map_err(collab_session_error_to_napi)?;
        Ok(peers
            .into_iter()
            .map(|p| BigInt::from(p.as_u64()))
            .collect())
    }

    /// **Phase 5.7 V3.4.0.4a (2026-05-23) -- save this session to a
    /// `.qbook` directory at `path`.**
    ///
    /// Atomic two-file write (workbook.toml + oplog.bin) via
    /// [`ql_io::oplog_persistence::save_workbook_with_oplog`].  The
    /// .qbook directory uses the Tier D3 envelope format (workbook
    /// envelope at v2 per Phase 2A.8; oplog.bin wrapped in the
    /// Quantlab magic-prefix + schema-version header per D-1 step 7).
    ///
    /// **Internal `rebuild_workbook` routing** (V3.4.0.4 plan scope):
    /// the persistence helper requires a fully-rebuilt `Workbook`,
    /// so this method calls `inner.rebuild_workbook(&default_registry())`
    /// internally.  The Workbook NEVER crosses the FFI boundary --
    /// it's a write-only serializer input.  IDE-side Workbook
    /// consumption stays V3.5+ scope.
    ///
    /// **Workbook name**: hardcoded as `"quantbook"` at V3.4.0.4a.
    /// V3.4.0.4b IDE commands may pass a user-chosen name (e.g.,
    /// derived from the filename).
    ///
    /// # Atomicity
    ///
    /// `save_workbook_with_oplog` writes to a temp directory + renames
    /// atomically; readers cannot observe a partial workbook.  See
    /// `ql_io::qbook_format::save_workbook_extending` docstring for
    /// the full atomic-rename protocol.
    ///
    /// # Errors
    ///
    /// - `[session_oplog]` if `rebuild_workbook` fails (replay error,
    ///   rename-repair failure, etc.).
    /// - `[qbook_error]` if the persistence layer fails (I/O, schema
    ///   violation, malformed cell).
    /// - `[session_oplog]` if the Loro snapshot encode fails inside
    ///   `save_workbook_with_oplog`.
    #[napi(js_name = "toQbook")]
    pub fn to_qbook(&self, path: String) -> Result<()> {
        let inner = self.inner.lock();
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;
        save_workbook_with_oplog(
            &workbook,
            inner.op_log(),
            "quantbook",
            std::path::Path::new(&path),
        )
        .map_err(persistence_error_to_napi)?;
        Ok(())
    }

    /// **Phase 5.7 V3.5.0.2 (2026-05-24) -- export a full workbook
    /// snapshot for IDE rendering.**
    ///
    /// Returns the flattened `WorkbookSnapshotJson` view of the full
    /// workbook -- all sheets (including empty sheets created via
    /// `addSheet` but never written to), with each sheet's cells listed
    /// in `(row, col)` ascending order.
    ///
    /// **Implementation**: routes through `inner.rebuild_workbook(&
    /// default_registry())` to enumerate sheets + their names; cell
    /// state is read from the V3.3.0.3 / V3.4.0.2 `last_snapshot`
    /// incremental cache via `snapshot_cells(sheet_id)` (per-sheet
    /// O(cells-in-cache) sheet-filtered).  The rebuilt Workbook is
    /// DISCARDED after sheet metadata extraction -- only sheet count
    /// and per-sheet names cross the FFI boundary.  IDE-side Workbook
    /// consumption is deferred to V3.6+ (V3.5 ships read-only snapshot
    /// only, NOT a live-Workbook surface).
    ///
    /// **Per-call cost** (R-V3.5-1): rebuild_workbook is O(N) in op
    /// count + each `snapshot_cells` walk is O(cells-in-cache).  For
    /// V3.5.0.2 scale (workbook-open / Save-As / sheet-switch granularity
    /// IDE calls; ~1/sec maximum) this is acceptable.  IDE callers MUST
    /// batch (do NOT call per-keystroke).  V3.6+ may add incremental
    /// snapshot deltas if profiling shows the full-snapshot cost is too
    /// high.
    ///
    /// **JSON shape stability**: the V3.5.0.2 ship returns
    /// `WorkbookSnapshotJson { sheets: Vec<SheetSnapshotJson> }`.
    /// **V3.6.0.3 D2 SHIPPED**: `formats: Vec<FormatDefJson>` is
    /// populated from the rebuilt Workbook's FormatTable (sorted by
    /// FormatId per V3.6.0.X audit-of-D2 CONVERGENT-MED-1 closure).
    /// V3.7+ may add `names: Vec<NamedRangeJson>` once that
    /// session-wide cache lands; the addition is ADDITIVE (no field
    /// removal / rename), so V3.5.0.2 IDE consumers that destructure
    /// `.sheets` keep working.  Per `#[napi(object)]` Rust contract:
    /// fields are `pub`; future field additions are TS interface
    /// extensions.
    ///
    /// **Remaining known limitation** (post-V3.6.0.3 D2): this
    /// method does NOT surface named ranges, tables, spill
    /// anchors, etc.  V3.7+ may promote to a richer `CacheState
    /// { cells, formats, names, tables }` engine-side shape (per
    /// V3.5.0.1 D1 option (b) if profiling justifies).
    ///
    /// # Errors
    ///
    /// - `[session_oplog]` if `rebuild_workbook` fails (replay error,
    ///   rename-repair failure, etc.) -- same propagation as `to_qbook`.
    #[napi(js_name = "workbookSnapshot")]
    pub fn workbook_snapshot(&self) -> Result<WorkbookSnapshotJson> {
        // **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)**: hold the lock as
        // `&mut` so we can populate the workbook cache via
        // `set_workbook_cache` at the end.  The cache enables the
        // V3.6.0.8.3 `workbookSnapshotDelta` cell-only fast-path on
        // subsequent calls (no `rebuild_workbook` + repair walks for
        // ops appended since this call).
        let mut inner = self.inner.lock();
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;
        // **V3.6.0.8.3 D6**: pin the VV at the moment of rebuild so
        // delta-staleness check downstream is exact.  `oplog_vv()` is
        // a cheap clone of Loro's internal FxHashMap<PeerID, Counter>
        // (O(peer-count), not O(op-count) -- verified
        // `crates/ql-oplog/src/log.rs:424`).
        let cache_vv = inner.oplog_vv();
        // **V3.6.0.8.3 D6**: wrap the rebuilt+repaired workbook in
        // `Arc` BEFORE rendering so we can populate the cache without
        // a second clone.  Rendering reads through `Arc::deref` (cost
        // identical to `&Workbook`).
        let workbook = std::sync::Arc::new(workbook);
        // **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**: build the
        // EvalContext used by format::render.  date_system comes
        // from the workbook (Phase 4.6 D-1; post V3.6.0.X audit-
        // of-D4 CONVERGENT-HIGH-1 closure: `Op::SetDateSystem`
        // ensures replay applies the loaded `.qbook` envelope's
        // value).  Locale comes from the workbook (post V3.6.0.X
        // audit-of-D4 CONVERGENT-MED-1 closure: was hardcoded to
        // `Locale::EnUs`; render.rs ignores locale today but will
        // grow conditionals at V3.6.1+ -- threading through now
        // prevents silent forward-compat regression).  now_provider
        // stays at System default (date/time format strings that
        // reference NOW() / TODAY() in the format grammar get the
        // system clock; tests that need determinism can use
        // `for_test`).
        let workbook_date_system = workbook.date_system();
        let eval_ctx = ql_types::EvalContext {
            date_system: workbook_date_system,
            locale: workbook.locale(),
            now_provider: ql_types::NowProvider::System,
        };
        // **Phase 5.7 V3.6.0.X audit-of-D4 CONVERGENT-MED-2 closure
        // (2026-05-24)**: per-snapshot parsed-format cache.  Pre-
        // closure `format::parse` ran PER cell PER snapshot call
        // (Opus MED-2 + Codex LOW-2).  For a workbook with 100k
        // formatted cells sharing the same format, the parser
        // produced 100k identical FormatString instances per
        // workbook_snapshot.  Post-closure: a session-local
        // HashMap<FormatId, FormatString> caches the first parse
        // result per id; subsequent cells with the same format
        // reuse the cached parsed grammar.  V3.7+ could promote
        // the cache to `CollabSession` (cross-call) if profiling
        // justifies; bounded scope here.
        let mut parsed_format_cache: std::collections::HashMap<
            ql_storage::FormatId,
            ql_functions::format::FormatString,
        > = std::collections::HashMap::new();
        let sheet_count = workbook.sheet_count();
        // **V3.5.0.3c (2026-05-24)**: iterate the display-order overlay
        // instead of 0..sheet_count() so user-initiated `Op::MoveSheet`
        // reorderings surface in the snapshot.  Default order (no
        // moveSheet ops applied) is `[0, 1, ..., sheet_count() - 1]`,
        // matching the V3.5.0.3b iteration behavior for backward
        // compat.
        //
        // Defensive fallback: if `sheet_display_order` is somehow
        // shorter than `sheet_count` (impossible under normal
        // try_add_sheet_with_chunk_rows flow, but conceivable if a
        // future direct workbook mutation forgets to update the
        // overlay), enumerate the missing ids at the end.  This keeps
        // workbookSnapshot resilient against engine-internal bugs
        // without silently dropping sheets.
        let display = workbook.sheet_display_order().to_vec();
        let mut all_ids: Vec<u16> = display.clone();
        for sheet_id in 0u16..(sheet_count as u16) {
            if !display.contains(&sheet_id) {
                all_ids.push(sheet_id);
            }
        }
        let mut sheets: Vec<SheetSnapshotJson> = Vec::with_capacity(sheet_count);
        for sheet_id in all_ids {
            // **V3.5.0.3b (2026-05-24)**: filter tombstoned sheets per
            // the CRDT semantic decision lock.  Op::RemoveSheet marks
            // the sheet id as tombstoned (preserves id slot for id-
            // stability of subsequent ops); workbookSnapshot must skip
            // tombstoned slots so the IDE renderer doesn't surface
            // deleted sheets.
            //
            // **V3.5.0.3c (2026-05-24)**: tombstone filter is applied
            // AFTER display-order resolution so a tombstoned sheet
            // that was moved is still filtered (display order can
            // legitimately reference tombstoned ids per the V3.5.0.3c
            // move-on-tombstoned-sheet silent-apply contract).
            if workbook.is_sheet_removed(sheet_id) {
                continue;
            }
            // Sheet name from the materialized workbook (carries the
            // last RenameSheet effect; pre-rename names are NOT
            // surfaced).
            let name = workbook
                .sheet(sheet_id)
                .map(|s| s.name().to_string())
                .unwrap_or_default();
            // Cells from the V3.3.0.3 / V3.4.0.2 incremental cache.
            // snapshot_cells returns sorted (row, col) ascending per
            // its docstring contract; the V3.4.0.X HIGH-1 closure
            // ensures BatchCommit-nested cell ops are recursed into the
            // cache via collect_cache_effects.
            //
            // **V3.5.0.X audit-closure A-HIGH-2 (2026-05-24)**: formula
            // TEXT is read EXCLUSIVELY from the REPAIRED Workbook (via
            // `formula_at`).  Phase 5.3 step 3 `repair_sheet_rename_chain`
            // (+ table + column repair) rewrites formula references when
            // a sheet/table/column is renamed; pre-closure this napi
            // method discarded the rebuilt+repaired Workbook and
            // serialized stale formula text from the cache, so the
            // ide-consumer-contract.md 4.1.z5 contract (formulas surface
            // with rename-repair) was violated.
            //
            // **V3.5.0.X follow-up audit CLOSURE-CODEX-MED-4 (2026-05-24)**:
            // the prior closure version of this code used
            // `repaired_formula.or(state.formula)` as a defensive
            // fallback -- but that fallback could MASK a cache-vs-workbook
            // divergence (in the normal case, both should agree post-
            // V3.4.0.X MEDIUM-1 closure; a divergence indicates a bug
            // somewhere).  Codex flagged the fallback as invariant-
            // masking.  Now: use ONLY `repaired_formula` so any
            // divergence surfaces as missing formula text in the IDE
            // (rather than silently using the stale cache value).
            let cells: Vec<CellSnapshotJson> = inner
                .snapshot_cells(sheet_id)
                .into_iter()
                .map(|((row, col), state)| {
                    let repaired_formula = workbook
                        .formula_at(sheet_id, row, col)
                        .map(|s| s.as_ref().to_string());
                    // **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**:
                    // pre-render the cell value via
                    // `ql_functions::format::render` when the cell
                    // has a format AND a value (and the value isn't
                    // Pending).  Silent fallback to `None` on any
                    // of: no format / no value / Pending value /
                    // format-id lookup miss / format-string parse
                    // error / wire-decode error.  IDE consumer
                    // falls back to value-based default rendering
                    // when `rendered` is None.
                    //
                    // **V3.6.0.X audit-of-D4 CONVERGENT-HIGH-3
                    // closure**: skip pre-render for
                    // `CellWireValue::Pending` -- otherwise
                    // `to_value()` returns `Value::Blank` and
                    // route_section treats Blank as 0.0 for number
                    // formats, producing misleading "0.00"-like
                    // output for not-yet-evaluated formulas.  Pre-
                    // closure pending+format displayed as a
                    // formatted zero; post-closure rendered=None
                    // and the IDE falls back to its explicit
                    // "(pending)" display.
                    //
                    // **V3.6.0.X audit-of-D4 CONVERGENT-MED-2
                    // closure**: per-snapshot parse cache reuses
                    // the FormatString for repeated FormatIds.
                    //
                    // **V3.6.0.X audit-of-D4 Opus LOW-2 closure**:
                    // drop `.to_string()` on the lookup result;
                    // `format::parse` takes `&str`.
                    let rendered: Option<String> = match (
                        state.format.as_ref(),
                        state.value.as_ref(),
                    ) {
                        (Some(fmt_id), Some(wire_value)) if !wire_value.is_pending() => {
                            let fmt_id_copy = *fmt_id;
                            wire_value.to_value().ok().and_then(|value| {
                                // CONVERGENT-MED-2 parse cache: reuse
                                // FormatString across cells sharing a
                                // FormatId within a single snapshot.
                                if let Some(fmt) = parsed_format_cache.get(&fmt_id_copy) {
                                    return Some(ql_functions::format::render(
                                        &value, fmt, &eval_ctx,
                                    ));
                                }
                                // Cache miss: lookup + parse + insert.
                                let fmt_str = workbook.formats().lookup(fmt_id_copy)?;
                                let fmt = ql_functions::format::parse(fmt_str).ok()?;
                                let rendered_str =
                                    ql_functions::format::render(&value, &fmt, &eval_ctx);
                                parsed_format_cache.insert(fmt_id_copy, fmt);
                                Some(rendered_str)
                            })
                        }
                        _ => None,
                    };
                    CellSnapshotJson {
                        row,
                        col,
                        value: state.value.map(CellValueJson::from),
                        formula: repaired_formula,
                        // **V3.5.0.5 (2026-05-24)**: format passthrough
                        // from the V3.4.0.2 hybrid CellState extended with
                        // a `format: Option<FormatId>` field.  None ->
                        // absent JS property (napi-rs Option::None
                        // serialization).
                        format: state.format.map(FormatIdJson::from),
                        // **V3.6.0.5 D4 (2026-05-23)**: pre-rendered
                        // formatted value (see field docstring +
                        // CellSnapshotJson.rendered docstring for the
                        // None-fallback contract).
                        rendered,
                    }
                })
                .collect();
            sheets.push(SheetSnapshotJson {
                id: sheet_id as u32,
                name,
                cells,
            });
        }
        // **V3.6.0.3 D2 (2026-05-24)**: populate the `formats` field
        // from the rebuilt+repaired Workbook's FormatTable.  The
        // FormatTable is the AUTHORITATIVE source (merges Builtin ids
        // 0..=163 range with Custom ids registered via Op::RegisterFormat;
        // applies the same-id-different-string rejection via
        // register_at).  The session-side `format_table_cache` exists
        // for V3.7+ incremental-snapshot-delta + cross-peer-convergence
        // discipline but is NOT consulted here -- under cross-peer
        // concurrent RegisterFormat the cache could diverge from the
        // workbook (cache first-write-wins post V3.6.0.X closure
        // vs workbook reject) and we'd surface the WRONG string to the
        // IDE.  Workbook iteration is the safe choice.
        //
        // **V3.6.0.X audit-of-D2 closure (2026-05-23,
        // CONVERGENT-MED-1 -- Codex Lane A MED-1 + Opus Lane B
        // MED-2)**: SORT the formats by `FormatId` (Builtin variants
        // first per enum order, then Custom lexicographically by
        // (peer, counter)) BEFORE returning.  Pre-closure the field
        // was HashMap-iter order (per-instance random hasher; fresh
        // `Workbook::new()` per `workbook_snapshot` call ->
        // different orderings across consecutive calls; Codex Probe
        // 4 confirmed empirically over 8 iterations).  Sorted output
        // gives consumers a stable shape across snapshots (hashable,
        // diffable, JSON-stringify-equal).  Iteration + sort cost is
        // O(N_formats * log N_formats) where N_formats is typically
        // < 100; negligible vs rebuild_workbook + snapshot_cells.
        let mut format_pairs: Vec<(ql_storage::FormatId, &str)> = workbook.formats().iter().collect();
        format_pairs.sort_by_key(|(id, _)| *id);
        let formats: Vec<FormatDefJson> = format_pairs
            .into_iter()
            .map(|(id, s)| FormatDefJson {
                id: FormatIdJson::from(id),
                string: s.to_string(),
            })
            .collect();
        // **V3.6.0.5 D4 (2026-05-23)**: map ql_types::DateSystem
        // to the napi String discriminator (matches the
        // FormatIdJson / CellValueJson `kind: String` pattern).
        // Two valid values; IDE consumers pin via a union type
        // `"Excel1900" | "Excel1904"`.
        let date_system = match workbook_date_system {
            ql_types::DateSystem::Excel1900 => "Excel1900".to_string(),
            ql_types::DateSystem::Excel1904 => "Excel1904".to_string(),
        };
        // **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)**: populate the
        // workbook cache.  Subsequent `workbookSnapshotDelta` calls
        // pin against `cache_vv` for staleness + use the cached
        // `Arc<Workbook>` as the clone source for the cell-only fast-
        // path.  `Arc::clone` is O(1) (atomic refcount bump); no
        // Workbook clone here.  V3.6.0.8.2 `set_workbook_cache`
        // overwrites any prior cache atomically.
        // V3.6.0.8.4 OPUS-HIGH-2 closure (2026-05-25): capture the
        // encoded VV BEFORE set_workbook_cache moves cache_vv.  Both
        // the cache + the returned snapshot pin the SAME VV; the
        // caller stores `version` + passes it back as
        // `lastSeenVersion` for the next workbookSnapshotDelta call.
        let version_bytes: Buffer = cache_vv.encode().into();
        inner.set_workbook_cache(std::sync::Arc::clone(&workbook), cache_vv);
        Ok(WorkbookSnapshotJson {
            sheets,
            formats,
            date_system,
            version: version_bytes,
        })
    }

    /// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- incremental WorkbookSnapshot
    /// delta.**
    ///
    /// Returns the cells / sheets / formats that changed since the
    /// caller's `lastSeenVersion`, or `fullRebuildRequired=true` when
    /// the engine can't produce a delta and the IDE should call
    /// `workbookSnapshot()` instead.
    ///
    /// See [`WorkbookSnapshotDeltaJson`] for the consumer protocol +
    /// shape contract, and `docs/architecture/ide-consumer-contract.md
    /// § 4.1.z6 V3.6.0.8.1 sub-section` for the locked design.
    ///
    /// # Algorithm (V3.6.0.8.1 lock)
    ///
    /// 1. Empty `last_seen_version` Buffer OR no prior workbook cache
    ///    → return `fullRebuildRequired=true` + current VV.
    /// 2. Decode caller's VV via `loro::VersionVector::decode`.
    /// 3. Staleness: caller_vv != cached_vv → return
    ///    `fullRebuildRequired=true`.
    /// 4. Same-VV fast-path: current_vv == cached_vv (no ops since
    ///    last cache) → return empty delta.
    /// 5. Enumerate ops since cached `op_count` (positional range
    ///    `[cached_op_count, log.len())`).  V3.6.0.8.2 invalidation
    ///    discipline guarantees `append_op` is the ONLY way the log
    ///    grew between cache populate + delta call (merge_bytes /
    ///    discard_pending_ops / undo / redo all invalidated the
    ///    cache); positional indices since the cache are stable +
    ///    monotone.
    /// 6. Classify delta: detect any `Op::RenameSheet | RenameTable |
    ///    RenameColumn` in the range.
    /// 7. If rename: return `fullRebuildRequired=true` (V3.6.0.8.3
    ///    conservative scope; full delta JSON for rename ops deferred
    ///    to V3.6.0.8.4+ -- rename ops touch all formula cells via
    ///    `repair_*_chain` so the delta would degenerate to "all cells
    ///    with formulas"; calling `workbookSnapshot()` is simpler +
    ///    cheaper than building the equivalent delta).
    /// 8. Otherwise (cell-only): clone cached `Arc<Workbook>` via
    ///    `(*cached_arc).clone()` always-clone (V3.6.0.8.4 OPUS-MED-3
    ///    closure: V3.6.0.8.1 lock said `Arc::make_mut` but implementation
    ///    discovered `cached_arc = Arc::clone(arc)` capture has strong_count
    ///    >= 2 so `make_mut` would clone anyway; always-clone IS the right
    ///    pattern; R-V3.6-17 measurement: 692 μs at 100k cells, well under
    ///    20 ms threshold), replay `[cached_op_count, log.len())` via
    ///    `apply_ops_in_range` (skips repair walks per the cell-only
    ///    contract; new ops contain no renames), update cache,
    ///    emit per-cell delta entries + new formats + tombstoned
    ///    sheets.
    ///
    /// # V3.6.0.8.3 scope limitations
    ///
    /// - `removed_cells` is always empty (V3.7+ feature).  A clean-
    ///   formula or value-set-to-empty would surface as a
    ///   `changedCells` entry with the new state.  True removals
    ///   (undo of a `PutValue`) invalidate the cache via
    ///   `force_clear_workbook_cache` → next delta call returns
    ///   `fullRebuildRequired=true`.
    /// - Rename ops trigger full rebuild fallback rather than
    ///   incremental rename delta.
    /// - `sheets_changed` is always empty in the cell-only path (cell
    ///   ops don't change sheet metadata); full rebuild paths surface
    ///   sheets via `fullRebuildRequired=true` + the IDE's full
    ///   `workbookSnapshot()` re-fetch.
    ///
    /// # Errors
    ///
    /// - `[session_replay]` if `apply_ops_in_range` fails partway
    ///   through the cell-only fast-path.  The cache is cleared in
    ///   this case (cached Workbook is half-mutated) so the next
    ///   delta call falls back to `fullRebuildRequired=true`.
    /// - `[bad_argument]` on malformed `last_seen_version` Buffer
    ///   (Loro decode error).
    #[napi(js_name = "workbookSnapshotDelta")]
    pub fn workbook_snapshot_delta(
        &self,
        last_seen_version: Buffer,
    ) -> Result<WorkbookSnapshotDeltaJson> {
        let mut inner = self.inner.lock();
        let current_vv = inner.oplog_vv();
        let current_op_count = inner.log().len();
        let current_version_bytes: Buffer = current_vv.encode().into();

        // Step 1a: empty buffer → full rebuild required.
        if last_seen_version.is_empty() {
            return Ok(empty_delta(current_version_bytes, true));
        }

        // Step 1b: no prior cache → full rebuild required.
        let (cached_arc, cached_vv, cached_op_count) = match (
            inner.last_snapshot_workbook(),
            inner.last_snapshot_oplog_vv(),
            inner.last_snapshot_op_count(),
        ) {
            (Some(arc), Some(vv), Some(n)) => {
                (std::sync::Arc::clone(arc), vv.clone(), n)
            }
            _ => {
                return Ok(empty_delta(current_version_bytes, true));
            }
        };

        // Step 2: decode caller VV.
        let caller_vv = match ql_oplog::VersionVector::decode(last_seen_version.as_ref()) {
            Ok(vv) => vv,
            Err(_) => {
                // Malformed token → conservative: full rebuild.  We
                // don't `bad_argument` because the IDE consumer
                // protocol treats `fullRebuildRequired=true` as the
                // recovery path; returning Err here would force the
                // IDE into exception-handling for a recoverable case.
                return Ok(empty_delta(current_version_bytes, true));
            }
        };

        // Step 3: staleness check.
        if caller_vv != cached_vv {
            return Ok(empty_delta(current_version_bytes, true));
        }

        // Step 4: same-VV fast-path.
        if current_vv == cached_vv {
            return Ok(empty_delta(current_version_bytes, false));
        }

        // Step 5-6: enumerate ops since cached_op_count + classify.
        // V3.6.0.8.2 invalidation discipline guarantees positional
        // indices [cached_op_count, current_op_count) are stable
        // (append_op is the only growth path between cache populate
        // and now).
        if cached_op_count > current_op_count {
            // Invariant violation: cache says we had more ops than
            // we do now.  Should be impossible (invalidation triggers
            // on undo/discard/merge), but guard defensively.
            inner.force_clear_workbook_cache();
            return Ok(empty_delta(current_version_bytes, true));
        }
        let new_ops_range = cached_op_count..current_op_count;
        // Collect classification + the bodies we'll need for the
        // delta JSON.  Walk via OpLog::iter() with skip/take; mirrors
        // the apply_ops_in_range pattern but bounded by the slice we
        // already verified.
        let mut has_rename = false;
        let mut changed_cell_coords: std::collections::HashSet<(u16, u32, u32)> =
            std::collections::HashSet::new();
        let mut removed_sheet_ids: Vec<u16> = Vec::new();
        let mut new_format_ids: Vec<ql_storage::FormatId> = Vec::new();
        // Collect the slice of ops into an owned Vec so the borrow on
        // `inner.log()` ends before any potential mutable callback
        // (force_clear_workbook_cache).  Bounded by N_new_ops which is
        // small in steady-state editing (the cell-only fast-path
        // target); allocation cost is negligible vs the per-cell
        // rendering pipeline downstream.
        // **V3.6.0.8.4 OPUS-HIGH-3 closure (2026-05-25)**: random-
        // access via `OpLog::get(i)` for each index in the slice
        // instead of `iter().skip(N).take(M)` (which deserializes
        // ALL N skipped ops; see apply_ops_in_range for the full
        // closure rationale).  At 100k log + 10 new ops the pre-
        // closure pattern cost ~100k unnecessary `Op` deserializations
        // per delta call -- explains why the V3.6.0.8.3 bench showed
        // 100ms+ even for tiny deltas (Codex + Opus convergent
        // HIGH-3 surfaced this; the K * O(log N) random-access
        // pattern hits the V3.6.0.7 D6 perf contract).
        let new_ops: Vec<std::result::Result<Op, ql_oplog::OpLogError>> = {
            let log = inner.log();
            (new_ops_range.start..new_ops_range.end)
                .map(|i| {
                    log.get(i).unwrap_or_else(|| {
                        // Past-end indices: treat as decode error so
                        // the downstream Err arm handles them as
                        // "trust the cache + clear it" rather than
                        // silently dropping ops.  Defensive --
                        // `cached_op_count > current_op_count` is
                        // guarded earlier so we shouldn't reach here
                        // in practice.
                        Err(ql_oplog::OpLogError::SchemaMismatch(
                            "log shrunk between len() probe and get() walk",
                        ))
                    })
                })
                .collect()
        };
        // **V3.6.0.8.4 R-V3.6-15 closure (2026-05-25)**: monotonicity
        // debug-assert.  The three-field cache invariant ("all Some /
        // all None") + the V3.6.0.8.2 invalidation discipline
        // (merge_bytes / discard_pending_ops / undo / redo all clear
        // the cache) MUST ensure that between cache populate + this
        // delta call, the only log mutation is append_op.  append_op
        // grows the log monotonically; positional indices since the
        // cache are stable.  So `log.len() - cached_op_count` must
        // equal the number of ops we just enumerated.  If this
        // assertion ever fires, the invalidation discipline has been
        // broken silently and the delta is wrong.  Debug-only so
        // release builds don't pay the bounds check; production
        // safeguarding is via the invariant + tests.
        debug_assert_eq!(
            new_ops.len(),
            current_op_count - cached_op_count,
            "V3.6.0.8.4 R-V3.6-15 monotonicity invariant violated: enumerated {} ops but log range was {}..{}={} ops (cache invalidation discipline broken between populate + delta call)",
            new_ops.len(),
            cached_op_count,
            current_op_count,
            current_op_count - cached_op_count,
        );
        for op_result in new_ops {
            let op = match op_result {
                Ok(op) => op,
                Err(_) => {
                    // Op decode failure mid-walk: conservative full
                    // rebuild.  Invalidate cache too since we can't
                    // trust the ops range.
                    inner.force_clear_workbook_cache();
                    return Ok(empty_delta(current_version_bytes, true));
                }
            };
            classify_delta_op(
                &op,
                &mut has_rename,
                &mut changed_cell_coords,
                &mut removed_sheet_ids,
                &mut new_format_ids,
            );
            if has_rename {
                break;
            }
        }

        // Step 7: rename detected → full rebuild fallback.
        if has_rename {
            return Ok(empty_delta(current_version_bytes, true));
        }

        // Step 8: cell-only fast-path.  Clone the cached Workbook via
        // `Arc::make_mut` (forks on write; if the IDE is holding
        // another Arc clone, this returns a fresh clone, otherwise
        // mutates in place -- both safe).  Apply [cached_op_count,
        // current_op_count) forward via apply_ops_in_range -- no
        // repair walks needed because we confirmed no rename ops in
        // the range.
        let registry = default_registry();
        let mut next_workbook = (*cached_arc).clone();
        if let Err(e) = ql_oplog::apply_ops_in_range(
            inner.log(),
            &mut next_workbook,
            cached_op_count,
            current_op_count,
            &registry,
        ) {
            // Partial replay error: half-merged workbook.  Drop the
            // cache + tell IDE to full-rebuild.
            inner.force_clear_workbook_cache();
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                format!("[session_replay] apply_ops_in_range failed: {e}"),
            ));
        }
        let next_workbook = std::sync::Arc::new(next_workbook);
        // Build the per-cell delta entries from the updated workbook.
        // Reuses the rendering pipeline from `workbook_snapshot`.
        let eval_ctx = ql_types::EvalContext {
            date_system: next_workbook.date_system(),
            locale: next_workbook.locale(),
            now_provider: ql_types::NowProvider::System,
        };
        let mut parsed_format_cache: std::collections::HashMap<
            ql_storage::FormatId,
            ql_functions::format::FormatString,
        > = std::collections::HashMap::new();
        let mut changed_cells: Vec<ChangedCellJson> =
            Vec::with_capacity(changed_cell_coords.len());
        for (sheet, row, col) in changed_cell_coords {
            // **V3.6.0.8.4 CODEX-HIGH-3 closure (2026-05-25)**: O(1)
            // direct lookup via `snapshot_cell` instead of the pre-
            // closure `snapshot_cells(sheet).into_iter().find(...)`
            // which was O(cells_in_sheet) per delta-cell and caused
            // the 746 ms-at-100k delta regression.  `snapshot_cell`
            // hashes into the underlying HashMap.
            //
            // `None` here means the cell has no live state -- the op
            // was a ClearFormula or a removal that the cache walker
            // dropped.  Skip emitting an entry (consumer sees the cell
            // missing in next workbookSnapshot rather than as a
            // changedCells entry with all-None fields).
            let state = match inner.snapshot_cell(sheet, row, col) {
                Some(state) => state,
                None => continue,
            };
            let repaired_formula = next_workbook
                .formula_at(sheet, row, col)
                .map(|s| s.as_ref().to_string());
            let rendered: Option<String> = match (
                state.format.as_ref(),
                state.value.as_ref(),
            ) {
                (Some(fmt_id), Some(wire_value)) if !wire_value.is_pending() => {
                    let fmt_id_copy = *fmt_id;
                    wire_value.to_value().ok().and_then(|value| {
                        if let Some(fmt) = parsed_format_cache.get(&fmt_id_copy) {
                            return Some(ql_functions::format::render(
                                &value, fmt, &eval_ctx,
                            ));
                        }
                        let fmt_str = next_workbook.formats().lookup(fmt_id_copy)?;
                        let fmt = ql_functions::format::parse(fmt_str).ok()?;
                        let rendered_str =
                            ql_functions::format::render(&value, &fmt, &eval_ctx);
                        parsed_format_cache.insert(fmt_id_copy, fmt);
                        Some(rendered_str)
                    })
                }
                _ => None,
            };
            let cell = CellSnapshotJson {
                row,
                col,
                value: state.value.map(CellValueJson::from),
                formula: repaired_formula,
                format: state.format.map(FormatIdJson::from),
                rendered,
            };
            changed_cells.push(ChangedCellJson {
                sheet: sheet as u32,
                cell,
            });
        }
        // Sort for deterministic shape (mirrors V3.6.0.X audit-of-D2
        // CONVERGENT-MED-1 discipline on `formats`).
        changed_cells.sort_by_key(|c| (c.sheet, c.cell.row, c.cell.col));

        // **V3.6.0.8.4 OPUS-MED-2 closure (2026-05-25)**: sort by
        // FULL `FormatId` (engine-side derived Ord: Builtin variants
        // first, then Custom by (peer, counter)) BEFORE mapping to
        // the napi FormatIdJson.  Pre-closure was
        // `sort_by_key(|f| f.id.kind.clone())` which only sorted by
        // the `"builtin"` / `"custom"` string -- two Custom formats
        // with different (peer, counter) ended up in op-log order
        // within the same kind, non-deterministic across runs.
        // Mirrors `workbook_snapshot.formats`'s
        // `sort_by_key(|(id, _)| *id)` discipline (V3.6.0.X audit-of-
        // D2 CONVERGENT-MED-1 closure).
        let mut new_format_ids = new_format_ids;
        new_format_ids.sort();
        new_format_ids.dedup();
        let mut formats_added: Vec<FormatDefJson> = Vec::new();
        for fmt_id in new_format_ids {
            // Look up the registered string in the freshly-built
            // next_workbook (authoritative source).
            if let Some(s) = next_workbook.formats().lookup(fmt_id) {
                formats_added.push(FormatDefJson {
                    id: FormatIdJson::from(fmt_id),
                    string: s.to_string(),
                });
            }
        }

        // Build sheets_removed (already collected; just widen u16->u32
        // for napi).
        let mut sheets_removed: Vec<u32> =
            removed_sheet_ids.into_iter().map(|id| id as u32).collect();
        sheets_removed.sort();
        sheets_removed.dedup();

        // Update the cache: the next delta call's same-VV fast-path
        // will see the new VV.
        inner.set_workbook_cache(std::sync::Arc::clone(&next_workbook), current_vv);

        Ok(WorkbookSnapshotDeltaJson {
            changed_cells,
            removed_cells: Vec::new(),
            sheets_changed: Vec::new(),
            sheets_removed,
            formats_added,
            version: current_version_bytes,
            full_rebuild_required: false,
        })
    }

    /// **Phase 5.7 V3.4.0.4a (2026-05-23) -- load a session from a
    /// `.qbook` directory at `path`.**
    ///
    /// Reads workbook.toml + oplog.bin via
    /// [`ql_io::oplog_persistence::load_workbook_with_oplog`].
    /// Reconstructs a `CollabSession` rooted at the loaded op log via
    /// [`CoreCollabSession::from_snapshot`] (which rebuilds the
    /// V3.3.0.3 incremental snapshot cache from the imported log per
    /// the field-docstring contract).
    ///
    /// **PeerId derivation (V3.4.0.1 D5 scope -- DEVIATED at V3.4.0.4b)**:
    /// caller MUST pass `peer_id_override`.  The V3.4.0.4b IDE commands
    /// always generate a FRESH UUID-derived BigInt via `crypto.randomUUID()`
    /// per open (NOT a per-workbook stash, as originally locked).
    /// Implementation discovery: persisted-per-workbook PeerId would have
    /// an unsolvable two-windows-same-workspace collision (both windows
    /// would read the same stashed PeerId + violate Loro's PeerId-
    /// uniqueness contract).  Fresh-UUID-per-session is CRDT-correct +
    /// closes R-V3.3-5 fully + obviates the envelope v3 bump (no PeerId
    /// stash exists to persist).  Trade-off: no cross-restart
    /// op-attribution continuity for "this peer is User A" features;
    /// V3.4.1+ may revisit if a user-facing attribution feature surfaces.
    /// See `docs/architecture/ide-consumer-contract.md § 4.1.z4` for the
    /// full D5 DEVIATION rationale.  V3.4.0.X LOW-1 closure (cross-lane
    /// Codex L1 + Opus M1 doc-accuracy).
    ///
    /// **`peer_id_override` MUST be non-zero** (LEGACY_PEER sentinel
    /// per `CollabSession::from_snapshot` precondition).  Per
    /// `peer_id_from_bigint`, zero/negative/over-u64 inputs surface
    /// as `[bad_argument]` errors.
    ///
    /// **Loaded Workbook discarded**: the napi factory doesn't
    /// expose the `Workbook` (V3.5+ scope).  Only the op log
    /// reconstruction matters for V3.4.0.4a -- the rebuilt cache
    /// answers all V3.3+ IDE consumer queries (exportSnapshot,
    /// listSheets, etc.) without needing the Workbook.
    ///
    /// # Errors
    ///
    /// - `[bad_argument]` if `peer_id_override` is zero / negative /
    ///   exceeds u64.
    /// - `[qbook_error]` if workbook.toml is missing / malformed /
    ///   schema mismatch.
    /// - `[qbook_error]` with `MissingFile` payload if `oplog.bin` is
    ///   absent (this method requires both files per V3.4.0.4a
    ///   contract; the no-fallbacks rule surfaces the absence).
    /// - `[qbook_unsupported_version]` / `[qbook_truncated_header]`
    ///   for `oplog.bin` Tier D3 header issues.
    /// - `[session_oplog]` if Loro can't decode the snapshot bytes.
    #[napi(factory, js_name = "fromQbook")]
    pub fn from_qbook(path: String, peer_id_override: BigInt) -> Result<Self> {
        let pid = peer_id_from_bigint(&peer_id_override)?;
        let (loaded_workbook, oplog) = load_workbook_with_oplog(std::path::Path::new(&path))
            .map_err(persistence_error_to_napi)?;
        // Round-trip via export_bytes -> from_snapshot.  This pays a
        // double-Loro-serialization cost (load decodes; export re-
        // encodes; from_snapshot re-decodes).  At V3.4.0.4a scale
        // (workbook open is a user-initiated op, ~1/minute max),
        // the cost is irrelevant.  V3.4.1+ could add a
        // `CollabSession::from_oplog(peer_id, oplog: OpLog)` factory
        // that bypasses the round-trip if profiling justifies, but
        // it would require lifting the LoroDoc-set-peer-id concern
        // through a new API surface -- avoided here for simplicity.
        let bytes = oplog
            .export_bytes()
            .map_err(|e| persistence_error_to_napi(PersistenceError::OpLog(e)))?;
        let mut session = CoreCollabSession::from_snapshot(pid, &bytes)
            .map_err(collab_session_error_to_napi)?;
        // **Phase 5.7 V3.6.0.X audit-of-D4 CONVERGENT-HIGH-1 closure
        // (2026-05-24)**: seed `Op::SetDateSystem` when the loaded
        // workbook's date_system differs from the runtime default
        // (`ql_types::DateSystem::default()` = `Excel1900`).  Pre-
        // closure the `loaded_workbook` was discarded entirely; the
        // session was reconstructed from `oplog` alone via
        // `from_snapshot`, replay yielded `Workbook::default()`, and
        // `workbook.date_system()` reverted to `Excel1900` regardless
        // of the file's envelope.  Excel1904 workbooks then rendered
        // date-format cells off by 1462 days (Codex Lane A HIGH-1 +
        // Opus Lane B HIGH-1 both empirically demonstrated).  Post-
        // closure: append `Op::SetDateSystem` so subsequent
        // `rebuild_workbook` replays apply the loaded workbook's
        // actual date_system.
        //
        // Conditional emission (only when non-default) keeps the op
        // count idempotent for Excel1900 .qbook files (the common
        // case) -- existing IDE mocha tests that assert
        // `session.op_count() == oplog.count_before_fromQbook` keep
        // passing for default workbooks.  Excel1904 .qbook files
        // grow op_count by 1.
        //
        // V3.6.0.6+ may add `set_date_system` napi method (mirroring
        // `set_locale`) so the IDE can change date_system from the
        // user's perspective; that would also append `Op::SetDateSystem`
        // to the log.
        let loaded_date_system = loaded_workbook.date_system();
        if loaded_date_system != ql_types::DateSystem::default() {
            session
                .append_op(ql_oplog::Op::SetDateSystem {
                    date_system: ql_oplog::DateSystemWire::from_runtime(loaded_date_system),
                })
                .map_err(collab_session_error_to_napi)?;
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(session)),
        })
    }

    /// Export a full snapshot of this session's op log.
    /// Mirrors `CollabSession::export_bytes`.
    #[napi(js_name = "exportBytes")]
    pub fn export_bytes(&self) -> Result<Uint8Array> {
        let inner = self.inner.lock();
        let bytes = inner.export_bytes().map_err(collab_session_error_to_napi)?;
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
    /// `Uint8Array`s (which the V1 IDE demo does -- `exportBytes`
    /// returns a plain `Vec<u8>`-backed Uint8Array). V2 will add a
    /// defensive `to_vec()` copy at the FFI boundary OR a SAB-detect
    /// path via `napi_get_arraybuffer_info` (Codex H2 + Opus M3
    /// convergent finding).
    ///
    /// # u32 clamp on overflow
    ///
    /// Return type is `u32`. If the post-merge `op_count` exceeds
    /// `u32::MAX` (~=4 billion ops), the value is silently CLAMPED to
    /// `u32::MAX`. Practically unreachable in V1 (4 billion ops would
    /// consume terabytes of Loro storage) but flagged here per Opus M5
    /// "verify before claiming". V2 will switch to `BigInt` return
    /// type for unbounded sessions, matching `peerId()`'s precedent.
    #[napi(js_name = "mergeBytes")]
    pub fn merge_bytes(&self, bytes: Uint8Array) -> Result<u32> {
        let mut inner = self.inner.lock();
        let count = inner
            .merge_bytes(bytes.as_ref())
            .map_err(collab_session_error_to_napi)?;
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
    // Phase 5.7 V2.1 (2026-05-22) -- Transport surface
    // ==========================================================

    /// Attach a Transport to this session. Moves the inner boxed trait
    /// object out of the `transport` wrapper (consuming it from JS's
    /// perspective -- subsequent calls fail).
    ///
    /// Mirrors `CollabSession::attach_transport_boxed` on the Rust side
    /// which delegates to the V2 V3 step 1 baseline-reset path: the
    /// next flush sends from empty VV (i.e., ALL local ops including
    /// any appended while no transport was attached -- Loro's CRDT op
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
    /// - `transport` has already been used (its `inner` is `None`) ->
    ///   JS Error "Transport has already been consumed".
    #[napi(js_name = "attachTransport")]
    pub fn attach_transport(&self, transport: &mut Transport) -> Result<()> {
        let boxed = transport.take_inner().ok_or_else(|| {
            // V2.1 audit closure (Codex LOW-1, 2026-05-22): error wording
            // standardized. A "spent LoopbackPair" throws at takeA/takeB
            // BEFORE producing a Transport -- so a consumed Transport
            // wrapper must have come from attachTransport (or a future
            // consumer added in V2.3+).
            bad_argument_error("Transport has already been consumed by attachTransport".to_string())
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
    /// NOT receive the prior transport -- same rationale as
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
    /// **Use `flushDeltaToTransport` instead in production** --
    /// full-snapshot flushes get expensive as the op log grows. V2.1
    /// exposes this method primarily for tests and "initial sync"
    /// scenarios; V2.2 ships the delta path.
    ///
    /// **Failure modes**:
    /// - No transport attached -> returns `Ok(false)` (NOT an error).
    /// - Transport's `send` returns `Err(TransportError::*)` -> JS Error.
    #[napi(js_name = "flushToTransport")]
    pub fn flush_to_transport(&self) -> Result<bool> {
        let mut inner = self.inner.lock();
        inner
            .flush_to_transport()
            .map_err(collab_session_error_to_napi)
    }

    /// Drain inbound BLOBS from the attached transport (single-pass).
    /// Returns the number of BLOBS drained (NOT the number of ops),
    /// capped by the engine's default poll limit (`DEFAULT_POLL_REMOTE_LIMIT
    /// = 64`). Each blob is one snapshot/delta that may contain many ops;
    /// to count ops, compare `opCount()` before vs after.
    ///
    /// **V2.1 audit closure (Codex MEDIUM-1, 2026-05-22)**: the prior
    /// docstring claimed "number of ops merged" which was wrong -- the
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
    /// -- V2.2 does.
    ///
    /// **Failure modes**:
    /// - No transport attached -> returns `Ok(0)` (NOT an error).
    /// - Transport's `try_recv` returns `Err` -> JS Error.
    /// - Merging the bytes returns Err -> JS Error.
    #[napi(js_name = "pollRemote")]
    pub fn poll_remote(&self) -> Result<u32> {
        let mut inner = self.inner.lock();
        let blobs_drained = inner.poll_remote().map_err(collab_session_error_to_napi)?;
        Ok(u32::try_from(blobs_drained).unwrap_or(u32::MAX))
    }

    // ==========================================================
    // Phase 5.7 V2.2 (2026-05-22) -- full sync Transport surface
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
    /// -- i.e., a previous flush already advanced the baseline to the
    /// current state -- returns `Ok(false)` without invoking
    /// `transport.send`. Closes the V2 V2 audit echo-loop concern.
    ///
    /// **First flush after attach ALWAYS sends** even on an empty op
    /// log: attach resets `last_flushed_vv = None`, so the idempotency
    /// guard (which checks `Some(last_vv) == current_vv`) is bypassed.
    /// The first call encodes from the empty VV -- for an empty op log
    /// this is a small baseline blob; for a non-empty log it's the
    /// full state. V2.2 mocha test
    /// `flushDeltaToTransport second call with no state change
    /// short-circuits to false` pins this exact contract.
    ///
    /// **Per Phase 5.5 V2 V3 step 1 contract**: attach_transport resets
    /// the per-session-per-transport `last_flushed_vv` to None. The
    /// next call to `flushDeltaToTransport` after an attach sends from
    /// the empty VV -- delivering ALL local ops including any appended
    /// while offline (Loro's CRDT op log IS the implicit offline queue).
    ///
    /// **Failure modes**:
    /// - No transport attached -> returns `Ok(false)` (NOT an error).
    /// - Transport's `send` returns `Err(TransportError::*)` -> JS Error.
    #[napi(js_name = "flushDeltaToTransport")]
    pub fn flush_delta_to_transport(&self) -> Result<bool> {
        let mut inner = self.inner.lock();
        inner
            .flush_delta_to_transport()
            .map_err(collab_session_error_to_napi)
    }

    /// Like `pollRemote` but with an explicit cap on the number of
    /// blobs to drain per call. Returns the number of BLOBS drained
    /// (NOT ops), `<= limit`.
    ///
    /// **Limit semantics** (per engine docstring):
    /// - `limit == 0` -> no-op, returns `Ok(0)` even if blobs queued.
    /// - If the returned count equals `limit`, more blobs may still
    ///   be queued -- call again.
    /// - If less, the queue drained (either empty or transport
    ///   reported `Closed`).
    ///
    /// **Input validation** (per V1 megaudit closure pattern):
    /// `limit` takes `f64` to avoid napi-rs's `napi_get_value_uint32`
    /// ECMAScript ToUint32 silent coercion (`-1 -> u32::MAX`, etc.).
    /// Validated finite + non-negative + integer + in `usize` range
    /// (on 64-bit systems usize = u64; we cap at u32::MAX for cross-
    /// platform safety).
    ///
    /// **Failure modes**:
    /// - No transport attached -> returns `Ok(0)`.
    /// - `limit` not a finite non-negative integer in u32 range -> JS Error.
    /// - Transport's `try_recv` returns `Err` -> JS Error.
    #[napi(js_name = "pollRemoteWithLimit")]
    pub fn poll_remote_with_limit(&self, limit: f64) -> Result<u32> {
        let limit_u32 = validate_u32_index("pollRemoteWithLimit", "limit", limit)?;
        let mut inner = self.inner.lock();
        let blobs_drained = inner
            .poll_remote_with_limit(limit_u32 as usize)
            .map_err(collab_session_error_to_napi)?;
        Ok(u32::try_from(blobs_drained).unwrap_or(u32::MAX))
    }

    /// Returns the attached transport's most recent error message, or
    /// `null` if either no transport is attached OR the transport
    /// reports no error.
    ///
    /// **Use case**: IDE reconnect handshakes -- after a mutator or
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
    /// binding -- they'll just be unparseable by this method until V2.3+
    /// adds string mappings.
    ///
    /// **Accepted alias forms (engine-side leniency)**: the engine
    /// parser also accepts `"Disabled"`, `"OnAppend"`, `"on-append"`
    /// as aliases for the canonical camelCase. The return value is
    /// always canonical camelCase. JS callers SHOULD pass the
    /// canonical forms (`"disabled"` / `"onAppend"`) only; the IDE-side
    /// `isAutoFlushPolicy` type guard enforces this on the TS side
    /// (rejects aliases). The lenient parser exists for engine-
    /// internal callers and config-file backward-compat -- not as a
    /// public IDE contract. V2.2 audit closure (Opus HIGH-2): the
    /// alias-acceptance is NOT pinned by the IDE mocha tests; engine-
    /// side tests cover the parser.
    ///
    /// **Partial-state error contract (Codex MEDIUM-3 closure)**:
    /// under `onAppend`, a mutator call sequence is "1. commit local
    /// op -> 2. flush to transport". If step 2 throws
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
    /// `disabled` branch -- corrupting reconnect logic. Throwing
    /// surfaces the skew loudly and forces a binding upgrade.
    #[napi(js_name = "autoFlushPolicy")]
    pub fn auto_flush_policy(&self) -> Result<String> {
        let inner = self.inner.lock();
        auto_flush_policy_to_string(inner.auto_flush_policy())
    }

    // ==========================================================
    // Phase 5.7 V2.5 (2026-05-22) -- async Transport surface, V8-BLOCK CLOSED
    // ==========================================================
    //
    // **V2.5 closure of Opus V2.4 HIGH-1 (V8-block UX hazard)**:
    //
    // V2.4 reintroduced `flushPendingToTransport` soundly (closed
    // V2.3's UB + tokio-starvation HIGHs via the `Arc<Mutex<...>>`
    // refactor + `spawn_blocking`). BUT it held `self.inner.lock()`
    // during the Condvar wait -- concurrent JS sync method calls on
    // the SAME session blocked the V8 event loop on lock acquisition.
    // Opus V2.4 HIGH-1 (`docs/audits/2026-05-22-phase-5-7-v2-4-opus.md:112-302`)
    // documented this as a UX hazard (not a soundness hazard) and
    // recommended Option A: split the lock acquisition from the
    // Condvar wait via a detached ack handle.
    //
    // V2.5 implements Option A via:
    //   1. Engine: `Transport::ack_handle(&self) -> Option<Box<dyn FlushAck + Send>>`
    //      default-None trait method (`crates/ql-collab/src/transport.rs`).
    //   2. Engine: `WebSocketTransport::ack_handle` override returning
    //      a `WebSocketProgressAckHandle` cloning the transport's
    //      Arc<(Mutex, Condvar)> progress state + capturing the
    //      drain target at THIS call (Codex M1 contract).
    //   3. Engine: `CollabSession::flush_pending_handle(&self)` proxy
    //      (`crates/ql-collab/src/session.rs`).
    //   4. Binding (this method): extract the handle under the session
    //      lock, DROP the lock, then perform the wait without it held.
    //
    // Concurrent JS sync methods now acquire `self.inner.lock()`
    // immediately -- the V8 event loop stays responsive while the
    // Condvar wait runs in the spawn_blocking task on cloned Arcs.

    /// Async flush-pending -- waits for the attached transport's writer
    /// task to drain (level-1 local ack per V2 V4 V1 Tier K1 contract).
    ///
    /// **Resolution / rejection contract** (V2.8 megaudit Codex Lane A
    /// MEDIUM-1 closure, 2026-05-22):
    ///
    /// Returns a JS `Promise<void>` that:
    /// - **resolves** when the writer has completed `send` for every
    ///   blob queued AT THIS CALL (Codex V2.5 M1: target captured at
    ///   handle extraction, NOT at wait-start).
    /// - **resolves** when there is no attached transport, OR when the
    ///   attached transport implementation returns `None` from
    ///   `ack_handle()` (e.g., `LoopbackTransport`, `NoopTransport` --
    ///   no async-drain semantics; flush is synchronous-on-attach).
    /// - **rejects** with `[transport_closed] transport closed` (V2.7
    ///   structured code) if the transport's `wait_for_drain` reports
    ///   the closed flag was set on entry to the wait OR was tripped
    ///   while waiting. This is equivalent to the pre-V2.5 sync
    ///   `flush_pending_to_transport()` rejection path and is the
    ///   correct reconnect signal for callers.
    /// - **rejects** with `[transport_io]` or other transport-error
    ///   variants if the handle's wait surfaces a non-closed transport
    ///   error.
    ///
    /// **V2.5 V8-block CLOSURE** (Opus V2.4 HIGH-1, 2026-05-22):
    ///
    /// - Step 1: acquire session lock briefly, call
    ///   `inner.flush_pending_handle()` which proxies to
    ///   `Transport::ack_handle(&self)`. For `WebSocketTransport`,
    ///   this captures `queued_count` as the drain target + clones
    ///   the progress + closed Arcs.
    /// - Step 2: DROP the session lock (`parking_lot::MutexGuard::drop`).
    /// - Step 3: `tokio::task::spawn_blocking(move || handle.wait_for_drain())`.
    ///   The wait runs on a tokio blocking thread, holding ONLY the
    ///   handle's internal Arcs (NOT the session lock).
    ///
    /// Concurrent JS sync method calls on the same session (e.g.,
    /// `opCount`, `appendPutValue`, `pollRemote`) acquire
    /// `self.inner.lock()` immediately while this method's wait
    /// runs -- the V8 event loop stays responsive.
    ///
    /// **V2.3+V2.4 soundness retained** (UB + tokio-starvation HIGHs
    /// remain closed):
    /// - `&self`, not `&mut self`. napi-rs codegen produces shared
    ///   `&'static CollabSession`; no aliasing UB possible.
    /// - `spawn_blocking` runs on tokio's blocking pool (default
    ///   512 threads), NOT the worker pool. Condvar wait doesn't
    ///   occupy a worker.
    ///
    /// **Failure modes**:
    /// - No transport attached, OR transport's `ack_handle` returns
    ///   `None` (e.g., Loopback/Noop) -> returns `Ok(())` immediately.
    /// - Transport error during the wait -> JS Error with the
    ///   `TransportError` `Display` string.
    /// - The `spawn_blocking` task panics -> JS Error.
    #[napi(js_name = "flushPendingToTransport")]
    pub async fn flush_pending_to_transport(&self) -> Result<()> {
        // **V2.5 lock-release pattern (Opus V2.4 HIGH-1 closure)**:
        // extract the ack handle while holding the session lock,
        // then RELEASE the lock before awaiting the wait. The
        // scoped lock guard drops on the closing brace per
        // parking_lot's standard MutexGuard semantics
        // (`lock_api-0.4.14/src/mutex.rs::MutexGuard::drop`).
        let handle_opt: Option<Box<dyn ql_collab::FlushAck + Send>> = {
            let inner = self.inner.lock();
            inner.flush_pending_handle()
        };

        // No transport attached (or transport has no ack semantics --
        // Loopback/Noop default impl returns None). The contract
        // matches the V2.4 method: `Ok(())`, NOT a rejection.
        let Some(handle) = handle_opt else {
            return Ok(());
        };

        // Wait on the detached handle. The Condvar wait runs on
        // tokio's blocking pool; the session lock is NOT held.
        tokio::task::spawn_blocking(move || handle.wait_for_drain())
            .await
            .map_err(|e| Error::from_reason(format!("flushPendingToTransport task: {e}")))?
            .map_err(transport_error_to_napi)
    }
}

/// Phase 5.7 V2.2 (2026-05-22) -- parse a JS string into
/// [`CoreAutoFlushPolicy`]. JS-idiomatic camelCase + lowercase aliases
/// accepted. Rejects unknown strings with a precise error.
fn parse_auto_flush_policy(s: &str) -> Result<CoreAutoFlushPolicy> {
    match s {
        "disabled" | "Disabled" => Ok(CoreAutoFlushPolicy::Disabled),
        "onAppend" | "on-append" | "OnAppend" => Ok(CoreAutoFlushPolicy::OnAppend),
        other => Err(bad_argument_error(format!(
            "AutoFlushPolicy must be 'disabled' or 'onAppend', got {other:?}"
        ))),
    }
}

/// Phase 5.7 V2.2 (2026-05-22) -- render [`CoreAutoFlushPolicy`] as a JS
/// string. Uses canonical camelCase form ("disabled", "onAppend").
///
/// **V2.2 audit closure (Opus HIGH-1, 2026-05-22)**: returns `Result`
/// and throws a JS Error when the engine reports a variant unknown to
/// this binding (forward-compat skew). The prior version returned a
/// `'unknown'` sentinel string -- a silent fall-through that violated
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
        // V2.7 closure (Opus MEDIUM-2): use bad_argument prefix so
        // IDE callers can branch on `info.code === 'bad_argument'`
        // for engine-binding drift handling.
        other => Err(bad_argument_error(format!(
            "autoFlushPolicy: engine reported unknown variant {other:?} -- \
             this binding crate ({}) is older than the engine; upgrade \
             ql-bindings-node to add the new variant's JS string mapping",
            env!("CARGO_PKG_VERSION"),
        ))),
    }
}

// =============================================================
// Phase 5.7 V2.1 (2026-05-22) -- Transport binding
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
    // discipline (per V1 module docs Send+!Sync rationale) -- we cannot
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
    // Phase 5.7 V2.3 (2026-05-22) -- async WebSocket factory
    // ==========================================================

    /// Connect to a WebSocket peer and return a Transport wrapping the
    /// resulting `WebSocketTransport`. Returns a JS `Promise<Transport>`.
    ///
    /// **URL format**: standard `ws://host:port` (no TLS in V2.3 -- V2.4+
    /// will add `wss://` once the engine's `ql-collab-ws` exposes TLS).
    ///
    /// **Failure modes** (all surface as JS Promise rejections):
    /// - `WebSocketError::InvalidUrl` -- URL parse failed.
    /// - `WebSocketError::ConnectFailed` -- TCP/DNS error.
    /// - `WebSocketError::HandshakeFailed` -- WS upgrade rejected
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
    /// completes -- no manual ThreadsafeFunction plumbing needed.
    #[napi(js_name = "websocketConnect")]
    pub async fn websocket_connect(url: String) -> Result<Transport> {
        let ws = WebSocketTransport::connect(&url)
            .await
            .map_err(websocket_error_to_napi)?;
        Ok(Transport {
            inner: Some(Box::new(ws)),
        })
    }
}

impl Transport {
    /// **`pub(crate)` -- only the napi `CollabSession::attach_transport`
    /// method should call this.** Move the inner Box out for attach.
    /// Called by the napi method, NOT the Rust generic
    /// `ql_collab::CollabSession::attach_transport`. After this returns
    /// `Some`, the wrapper is consumed; subsequent `is_attachable`
    /// returns `false` and the inner box has been handed off.
    ///
    /// **V2.1 audit closure (Opus LOW-4, 2026-05-22)**: the prior
    /// docstring said "Rust-only" which could be misread as private to
    /// this `impl` block. `pub(crate)` IS the visibility -- but calling
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
/// been taken still works -- the two ends are independent.)
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
            bad_argument_error("LoopbackPair.takeA already called on this pair".to_string())
        })?;
        Ok(Transport {
            inner: Some(Box::new(end)),
        })
    }

    /// Take ownership of end B. Errors if already taken.
    #[napi(js_name = "takeB")]
    pub fn take_b(&mut self) -> Result<Transport> {
        let end = self.b.take().ok_or_else(|| {
            bad_argument_error("LoopbackPair.takeB already called on this pair".to_string())
        })?;
        Ok(Transport {
            inner: Some(Box::new(end)),
        })
    }
}

// =============================================================
// Phase 5.7 V2.6 (2026-05-22) -- BlockingTransportFixture
// =============================================================
//
// Test fixture for V2.5 contract testing (Opus V2.4 MEDIUM-2
// closure). JS-side helper that constructs a `BlockingTransport`
// (engine-side, feature-gated) and exposes:
//   - `takeTransport(): Transport` -- moves the fixture's inner
//     BlockingTransport into a Transport wrapper that can be passed
//     to `attachTransport(t)`. Mirrors V2.1 `LoopbackPair`'s
//     `takeA`/`takeB` single-use pattern.
//   - `release(): void` -- flips the engine-side release Condvar
//     so any in-progress `flush_pending` / `wait_for_drain` exits.
//   - `waitUntilBlocked(): Promise<void>` -- async wait until the
//     fixture's wait routine has actually entered the Condvar
//     wait. Closes Codex M3 (deterministic synchronization for the
//     V2.5 contract test -- without this, the test's `opCount()`
//     call could race ahead of the spawn_blocking task and pass
//     vacuously).
//
// Codex M2 fix: this is NOT exposed as `new BlockingTransport(...)`.
// The napi `attachTransport(t: &mut Transport)` only accepts the
// opaque `Transport` wrapper class; a separately-constructed
// `BlockingTransport` napi class would not be attachable. The
// fixture-controller pattern is the closest analog to V2.1's
// `LoopbackPair`.
//
// **V2.8 megaudit closure (Opus-B Lane C HIGH-1, 2026-05-22)**: the
// entire fixture surface is now gated behind the binding-side
// `test-fixtures` feature. Pre-V2.8 builds shipped the fixture in
// every production cdylib (because `ql-collab/test-fixtures` was
// enabled unconditionally in `Cargo.toml`); Lane C flagged this as a
// self-DoS surface (any in-process JS could park tokio blocking-pool
// threads for u32::MAX ms). Mocha + contention tests must rebuild
// with `--features test-fixtures`; production builds explicitly omit
// the flag. See `Cargo.toml`'s `[features]` block + V2 exit packet at
// `docs/phase5/5-7-v2-exit-packet.md`.

/// **Phase 5.7 V2.6 (2026-05-22) -- V2.5 contract-test fixture.**
///
/// JS class for constructing a `BlockingTransport` (engine-side
/// `ql_collab::BlockingTransport`, gated behind the `test-fixtures`
/// feature) and controlling its `release` + `blocked` Condvars from
/// JS. Used by IDE mocha contention tests to verify the V2.5
/// V8-block closure: a sync session method called concurrently with
/// a pending `flushPendingToTransport` MUST return immediately
/// (does NOT block on the session lock).
///
/// **NOT for production use** -- the underlying `BlockingTransport`
/// blocks `flush_pending` indefinitely until `release()` is called
/// (or the constructor's `block_ms` upper bound elapses). V2.8
/// megaudit closure (Opus-B Lane C HIGH-1) gates the entire type
/// behind the `test-fixtures` Cargo feature; production cdylib
/// builds (built without `--features test-fixtures`) do NOT carry
/// this class.
#[cfg(feature = "test-fixtures")]
#[napi]
pub struct BlockingTransportFixture {
    /// The fixture's inner `BlockingTransport`, taken once via
    /// `takeTransport()`. After taking, the fixture controller
    /// still owns the `release` + `blocked` Arcs so it can drive
    /// JS-side `release()` + `waitUntilBlocked()` against the
    /// transport that now lives inside a `CollabSession`.
    inner: Option<ql_collab::BlockingTransport>,
    /// Shared with the inner `BlockingTransport`. Flipped to `true`
    /// + notified by `release()`.
    release: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    /// Shared with the inner `BlockingTransport`. Set + notified by
    /// the transport when it enters the wait. `waitUntilBlocked()`
    /// awaits this signal.
    blocked: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}

#[cfg(feature = "test-fixtures")]
#[napi]
impl BlockingTransportFixture {
    /// JS: `new BlockingTransportFixture(blockMs: number)`.
    ///
    /// `blockMs` is the upper-bound wait duration. Must be in the
    /// range `[1, u32::MAX]` -- a strictly positive finite integer.
    ///
    /// **V2.5 audit closure (Codex MEDIUM-1, 2026-05-22)**: `0` is
    /// REJECTED at the napi boundary even though the engine's
    /// `BlockingTransport` accepts `0` as "wait indefinitely" for
    /// Rust unit tests. Rationale: this napi class ships in every
    /// production cdylib (gated only by the `test-fixtures` Cargo
    /// feature on `ql-collab`, enabled unconditionally by
    /// `ql-bindings-node`). Allowing JS callers to construct an
    /// indefinite-block fixture would let in-process IDE code park
    /// `flushPendingToTransport` blocking-pool tasks until process
    /// termination -- bounded self-DoS but unnecessary footgun. The
    /// engine `BlockingTransport::new(0, ..., ...)` constructor
    /// remains for Rust tests that explicitly want the `0` path.
    ///
    /// `blockMs` is taken as `f64` (per the V1 megaudit Codex H1
    /// ToUint32-hygiene pattern) and validated via
    /// `validate_u32_index` to reject non-finite, negative,
    /// fractional, or out-of-u32 values; then additionally checked
    /// `> 0` per the V2.5 closure above.
    ///
    /// V2 backlog (Opus V2.5 LOW-2): future production hardening
    /// will gate this entire napi class behind a `ql-bindings-node`-side
    /// feature, stripping it from production cdylib builds. The
    /// `block_ms > 0` check here is a defense-in-depth complement.
    #[napi(constructor)]
    pub fn new(block_ms: f64) -> Result<Self> {
        let block_ms_u32 = validate_u32_index("BlockingTransportFixture", "blockMs", block_ms)?;
        if block_ms_u32 == 0 {
            return Err(bad_argument_error(
                "BlockingTransportFixture: blockMs must be > 0 (strictly positive). \
                 Zero would allow indefinite blocking from JS -- V2.5 audit closure \
                 (Codex MEDIUM-1) rejects this at the napi boundary."
                    .to_string(),
            ));
        }
        let release =
            std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let blocked =
            std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let transport = ql_collab::BlockingTransport::new(
            block_ms_u32 as u64,
            std::sync::Arc::clone(&release),
            std::sync::Arc::clone(&blocked),
        );
        Ok(Self {
            inner: Some(transport),
            release,
            blocked,
        })
    }

    /// Take ownership of the inner `BlockingTransport`, wrapped in
    /// a `Transport` for attaching to a session. Single-use:
    /// errors on the second call.
    ///
    /// After taking, the fixture controller retains its Arc clones
    /// of `release` + `blocked`, so JS-side `release()` +
    /// `waitUntilBlocked()` still drive the transport that now
    /// lives inside the session.
    #[napi(js_name = "takeTransport")]
    pub fn take_transport(&mut self) -> Result<Transport> {
        let t = self.inner.take().ok_or_else(|| {
            bad_argument_error(
                "BlockingTransportFixture.takeTransport already called on this fixture".to_string(),
            )
        })?;
        Ok(Transport {
            inner: Some(Box::new(t)),
        })
    }

    /// Flip the release Condvar so any in-progress `flush_pending`
    /// or `wait_for_drain` exits. Idempotent (calling twice is
    /// safe; the flag is monotonic).
    #[napi]
    pub fn release(&self) {
        let (lock, cv) = &*self.release;
        // The std::sync::Mutex API; recover from poison via
        // PoisonError::into_inner so a panicked test thread doesn't
        // leave the fixture permanently broken.
        let mut released = match lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *released = true;
        cv.notify_all();
    }

    /// Async wait until the fixture's wait routine has actually
    /// entered the Condvar wait. Resolves when the engine-side
    /// transport's `wait_blocked` has set the `blocked` flag +
    /// notified.
    ///
    /// **Codex M3 fix (2026-05-22)**: this is the deterministic
    /// synchronization point that V2.5 contract tests need. Without
    /// it, an `opCount()` call could race ahead of the
    /// `flushPendingToTransport` task and pass vacuously
    /// (returning before the spawn_blocking task has even acquired
    /// the session lock + extracted the ack handle).
    ///
    /// Uses `spawn_blocking` because the inner wait is a sync
    /// `Condvar::wait` on `std::sync` primitives. Tokio-friendly:
    /// the wait runs on a blocking-pool thread, not a worker.
    #[napi(js_name = "waitUntilBlocked")]
    pub async fn wait_until_blocked(&self) -> Result<()> {
        let blocked = std::sync::Arc::clone(&self.blocked);
        tokio::task::spawn_blocking(move || -> std::result::Result<(), String> {
            let (lock, cv) = &*blocked;
            let mut flag = lock
                .lock()
                .map_err(|e| format!("blocked lock poisoned: {e}"))?;
            while !*flag {
                flag = cv
                    .wait(flag)
                    .map_err(|e| format!("blocked wait poisoned: {e}"))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| Error::from_reason(format!("waitUntilBlocked task: {e}")))?
        .map_err(Error::from_reason)
    }
}

// =============================================================
// Send/Sync compile assertions (Rule 4 application)
// =============================================================

// **Phase 5.7 V2.4 (2026-05-22) -- Send + Sync UPDATE.**
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
//
// **V2.8 megaudit (Opus-B Lane C MEDIUM-2, 2026-05-22) -- Sync NOT
// asserted; rationale documented here.** The `dyn ql_collab::Transport
// + Send` trait object does NOT carry a `Sync` bound (the trait itself
// has no `Sync` supertrait -- V1 design accepted this because the
// engine boxes transports per-session, not for shared use). Therefore
// `Box<dyn Transport + Send>: Send + !Sync`, and `Transport: !Sync`
// by composition. This is asymmetric vs `CollabSession` (Send + Sync
// since V2.4) and `LoopbackPair` / `BlockingTransportFixture` (Send +
// Sync -- see asserts below) -- by design: napi-rs holds Transport
// wrappers per-Worker and does not require cross-thread aliasing of a
// single Transport. If a future V3 multi-window flow needs to clone
// a Transport handle across Workers, the `Sync` bound would need to
// be added to `ql_collab::Transport` first.
const _ASSERT_BINDING_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<Transport>();
};

// **V2.1 audit closure (Opus MEDIUM-2, 2026-05-22)** -- quality gap close
// for `LoopbackPair`. Wrapper holds `a: Option<LoopbackTransport>, b:
// Option<LoopbackTransport>`. The engine pins
// `_ASSERT_LOOPBACK_TRANSPORT_SEND_SYNC` in `ql-collab/src/transport.rs`,
// so by composition `LoopbackPair: Send + Sync`. Pin BOTH bounds so a
// future refactor making LoopbackTransport `!Send` or `!Sync` fails this
// build (the napi class hands wrapped instances across the JS/Rust
// boundary on the same thread, so neither is strictly required for V2.1
// -- but losing Send would break the V2.3+ Transport.websocketConnect
// async pattern which DOES require Send to move across the tokio
// runtime).
//
// **V2.8 megaudit closure (Opus-B Lane C MEDIUM-2, 2026-05-22)**: V2.1
// only asserted Send. Lane C flagged the missing Sync assertion as Rule
// 4 silence (no negative claim, but the symmetry hole vs CollabSession
// was a latent SemVer gap). Adding the positive Sync proof closes it.
const _ASSERT_BINDING_LOOPBACK_PAIR_SEND_SYNC: fn() = || {
    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}
    assert_send::<LoopbackPair>();
    assert_sync::<LoopbackPair>();
};

// **Phase 5.7 V2.6 (2026-05-22) Rule 4 application for `BlockingTransportFixture`**:
// the fixture wraps `Option<BlockingTransport>` + two `Arc<(Mutex, Condvar)>`
// fields. `BlockingTransport: Send + Sync` is pinned in ql-collab;
// `Arc<T>: Send + Sync` when `T: Send + Sync`; `Mutex<T>` + `Condvar`
// are both `Send + Sync`. So the composition is `Send + Sync`. Pin both
// -- napi holds instances per-Worker so cross-Worker bounds aren't
// strictly required, but losing Send would break `waitUntilBlocked`'s
// `spawn_blocking` move-into pattern.
//
// **V2.8 megaudit closure (Opus-B Lane C MEDIUM-2, 2026-05-22)**: V2.6
// only asserted Send. Lane C flagged the missing Sync assertion. Adding
// positive Sync proof closes it.
//
// **V2.8 megaudit closure (Opus-B Lane C HIGH-1, 2026-05-22)**: this
// assert is now `#[cfg(feature = "test-fixtures")]`-gated because the
// `BlockingTransportFixture` type itself only exists under that
// feature. Production cdylib builds compile without either.
#[cfg(feature = "test-fixtures")]
const _ASSERT_BINDING_BLOCKING_TRANSPORT_FIXTURE_SEND_SYNC: fn() = || {
    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}
    assert_send::<BlockingTransportFixture>();
    assert_sync::<BlockingTransportFixture>();
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
        // Test the Rust side directly (no napi runtime here -- that
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
    // Phase 5.7 V2.1 (2026-05-22) -- Transport composition smoke
    //
    // **Cannot test napi-wrapping types here.** `cargo test` doesn't
    // link napi symbols (they're loaded dynamically when Node opens
    // the .node file), so any code path that touches `napi::Error`
    // -- including `Result<T, napi::Error>` from `LoopbackPair::take_a`
    // -- fails to link with `_napi_delete_reference` undefined.
    //
    // V2.1 napi-wrapper composition (LoopbackPair -> takeA -> Transport
    // -> CollabSession.attachTransport -> flushToTransport -> pollRemote)
    // is tested via mocha at
    // `quantlab/extensions/quantlab/test/quantbook-roundtrip.test.ts`
    // -- same pattern V1 uses (mocha owns the Node host; Rust unit
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
