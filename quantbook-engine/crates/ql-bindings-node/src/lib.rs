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
use ql_collab_ws::WebSocketError;
use ql_collab_ws::WebSocketTransport;
// **inc.2d (2026-05-27):** the owning single-writer session + its contract.
use ql_exec::structural::{
    build_structural_batch, StructuralAxis, StructuralError, StructuralKind,
};
use ql_exec::WorkbookSession as CoreWorkbookSession;
use ql_functions::default_registry;
use ql_io::oplog_persistence::{
    load_workbook_with_oplog, save_workbook_with_oplog, PersistenceError,
};
use ql_oplog::CellWireValue;
use ql_oplog::Op;
use ql_session::session::FunctionImplHandle;
use ql_session::{EngineError, EngineSession, ErrorClass, FullRebuildReason};
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

/// **R9 / Wave B (2026-06-17):** validate a signed decimal-nudge `delta` from
/// JS — must be a finite, non-zero integer within ±30 (Excel caps number
/// formats at 30 decimal places). Mirrors [`validate_u32_index`]'s no-coercion
/// discipline: NaN / fractional / zero / out-of-range are all rejected loudly
/// (No-Fallbacks).
fn validate_nudge_delta(method: &str, value: f64) -> Result<i32> {
    // Excel's decimal-place ceiling; a larger |delta| is meaningless.
    const MAX_NUDGE_DELTA: f64 = 30.0;
    if !value.is_finite() {
        return Err(bad_argument_error(format!(
            "{method}: delta must be a finite non-zero integer, got {value}"
        )));
    }
    if value.fract() != 0.0 {
        return Err(bad_argument_error(format!(
            "{method}: delta must be an integer, got {value}"
        )));
    }
    if value == 0.0 {
        return Err(bad_argument_error(format!(
            "{method}: delta must be non-zero (+N increases, -N decreases decimal places)"
        )));
    }
    if value.abs() > MAX_NUDGE_DELTA {
        return Err(bad_argument_error(format!(
            "{method}: delta magnitude must be in [1, 30], got {value}"
        )));
    }
    Ok(value as i32)
}

// **W3 (insert/delete rows & columns):** `StructuralAxis`, `StructuralKind`,
// and `shifted_position` were lifted to `ql_exec::structural` (imported above)
// so the OWNING `Session` path can reuse the SAME audited producer core that
// the `CollabSession` path uses, instead of re-deriving it. See
// `crates/ql-exec/src/structural.rs` for the (7-audit-pass) logic.

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
///
/// **6.3-1c:** `full_rebuild_reason` (`Some` only when `full_rebuild_required`)
/// carries the contract-§4.3 reason; `schema_version` is stamped from
/// [`ql_session::SCHEMA_VERSION`] on every delta DTO (M5).
fn empty_delta(
    version: Buffer,
    full_rebuild_required: bool,
    full_rebuild_reason: Option<FullRebuildReason>,
) -> WorkbookSnapshotDeltaJson {
    // A reason is only meaningful alongside a required rebuild.
    debug_assert!(
        full_rebuild_required || full_rebuild_reason.is_none(),
        "full_rebuild_reason must be None when full_rebuild_required is false"
    );
    WorkbookSnapshotDeltaJson {
        changed_cells: Vec::new(),
        removed_cells: Vec::new(),
        sheets_changed: Vec::new(),
        sheets_removed: Vec::new(),
        formats_added: Vec::new(),
        styles_added: Vec::new(),
        version,
        full_rebuild_required,
        full_rebuild_reason: full_rebuild_reason.map(|r| full_rebuild_reason_str(r).to_string()),
        schema_version: ql_session::SCHEMA_VERSION,
    }
}

/// **Phase 6.3-1c (2026-05-30)**: stable snake_case wire string for a
/// [`FullRebuildReason`] (mirrors its `#[serde(rename_all = "snake_case")]`),
/// the single source of truth for the `full_rebuild_reason` DTO field + TS mirror.
fn full_rebuild_reason_str(r: FullRebuildReason) -> &'static str {
    match r {
        FullRebuildReason::NoPriorVersion => "no_prior_version",
        FullRebuildReason::CacheCleared => "cache_cleared",
        FullRebuildReason::StaleHorizon => "stale_horizon",
        FullRebuildReason::EpochMismatch => "epoch_mismatch",
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
    new_styles: &mut Vec<ql_storage::StyleId>,
) {
    match op {
        // **F2 Blank-durability closure (2026-05-27)**: Op::ClearValue
        // joins the cell-keyed fast path. The delta's changedCells
        // entry for the cleared cell carries its new (Blank) value when
        // the IDE re-reads it; no full rebuild needed.
        //
        // **FE-4 W4 (2026-06-10):** Op::SetCellStyle is cell-keyed too
        // (mirrors SetCellFormat) — the delta's changedCells entry carries
        // the cell's new style_id when the IDE re-reads it.
        Op::PutValue { sheet, row, col, .. }
        | Op::ClearValue { sheet, row, col }
        | Op::PutFormula { sheet, row, col, .. }
        | Op::ClearFormula { sheet, row, col }
        | Op::SetCellFormat { sheet, row, col, .. }
        | Op::SetCellStyle { sheet, row, col, .. } => {
            changed_cells.insert((*sheet, *row, *col));
        }
        Op::RenameSheet { .. } | Op::RenameTable { .. } | Op::RenameColumn { .. } => {
            *has_rename = true;
        }
        Op::RemoveSheet { id } => {
            removed_sheets.push(*id);
        }
        Op::RegisterFormat { id, .. } => {
            new_formats.push((*id).to_storage());
        }
        // **FE-4 W4 (2026-06-10):** style registration → stylesAdded (mirrors
        // RegisterFormat).
        Op::RegisterStyle { id, .. } => {
            new_styles.push((*id).to_storage());
        }
        Op::BatchCommit { ops } => {
            for inner in ops {
                classify_delta_op(
                    inner,
                    has_rename,
                    changed_cells,
                    removed_sheets,
                    new_formats,
                    new_styles,
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
        // **FE-5 W-N (2026-06-12):** Op::RemoveName is a defined-name change,
        // delta-invisible like SetName — force a full rebuild so the IDE
        // refetches the names list via workbookSnapshot (mirrors SetName).
        | Op::RemoveName { .. }
        | Op::SetLocale { .. }
        | Op::SetReferenceMode { .. }
        | Op::SetDateSystem { .. }
        // **W3 (insert/delete rows & columns) — Codex L5 HIGH-1 closure**:
        // a structural row/column edit moves cell POSITIONS en masse; the
        // cell-only delta cannot express the shift (cached cells stay at old
        // keys). Force a full rebuild so the IDE refetches the shifted
        // snapshot. (The existing `_` wildcard already did this; listing them
        // explicitly documents the intent + matches the allowlist discipline.)
        | Op::InsertRows { .. }
        | Op::DeleteRows { .. }
        | Op::InsertColumns { .. }
        | Op::DeleteColumns { .. }
        // **V3.6.0.10 D8 closure**: Op::RestoreSheet forces fullRebuild.
        // Reasoning: restoring an un-tombstones a sheet whose cells are
        // preserved in Workbook storage but absent from the
        // CollabSession last_snapshot cache (the cache dropped them at
        // CacheEffect::RemoveSheet apply).  Walking the full op log to
        // re-emit pre-tombstone cell-keyed effects would duplicate
        // rebuild_snapshot_cache logic; fullRebuild is simpler + the
        // op is rare (user-initiated undo-of-delete).
        | Op::RestoreSheet { .. }
        // **Wave G2 (engine-filter):** a hidden-row change is sheet metadata the
        // cell-only delta DTO cannot express (no `hiddenRows` field). Force a
        // full rebuild so the IDE refetches via workbookSnapshot + getHiddenRows.
        // (The `_` wildcard already did this; listing it explicitly matches the
        // V3.6.0.8.4 allowlist discipline.)
        | Op::SetRowsHidden { .. }
        // **Wave Q1 (2026-06-23):** chart object add/update/remove is workbook
        // metadata the cell-only delta DTO cannot express (no `charts` field).
        // Force a full rebuild so the IDE refetches via `listCharts`. (The `_`
        // wildcard already did this; listing it explicitly matches the
        // allowlist discipline.)
        | Op::AddChart { .. }
        | Op::UpdateChart { .. }
        | Op::RemoveChart { .. } => {
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
/// - `session_oplog`         -- op-log Loro snapshot decode (matches the existing `CollabSessionError::OpLog` code for symmetry)
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

/// **W3 (insert/delete rows & columns):** map a [`StructuralError`] from the
/// shared `ql_exec::structural` producer back to a `[bad_argument]` napi error,
/// prefixed with the calling napi `method` name. Every `StructuralError` variant
/// (missing sheet / tombstoned sheet / preflight rejection) is a caller-input
/// problem, so they all map to `[bad_argument]` — matching the pre-extraction
/// inline behavior byte-for-byte (the `{method}:` prefix is preserved). No
/// fallback: there is no swallow path — a producer rejection always surfaces.
fn structural_error_to_napi(method: &str, e: StructuralError) -> Error {
    bad_argument_error(format!("{method}: {}", e.message()))
}

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
/// peerId conventions throughout V3.x).  `builtin`/`customCounter` are
/// **`Option<f64>`** as of the 6.3-2 hardening (megaudit H1): they carry a
/// u32-domain value but are typed `f64` so a malformed JS Number reaches
/// `session_format_id_from_json` UN-coerced and is validated via
/// `validate_u32_index` (rather than letting napi-rs silently `ToUint32` it).
///
/// **Rule 4 per-field walk**: `kind: String` Send + Sync;
/// `builtin: Option<f64>` Send + Sync; `custom_peer: Option<BigInt>`
/// (napi::bindgen_prelude::BigInt is a u128-sized struct wrapping
/// Vec<u64> + sign; Vec<u64> is Send + Sync; trivially Send + Sync);
/// `custom_counter: Option<f64>` Send + Sync.  Composition:
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
    /// Set when `kind == "builtin"`; absent otherwise. **6.3-2 hardening
    /// (2026-05-30, megaudit H1):** typed `Option<f64>` (not `Option<u32>`) so
    /// the JS Number reaches `session_format_id_from_json` UN-coerced and is
    /// validated via [`validate_u32_index`] — a `u32` field would let napi-rs
    /// silently `ToUint32` a malformed input (NaN/Inf->0, 2.9->2, -1->u32::MAX)
    /// into a valid-looking format id. Engine-produced values are whole u32s.
    pub builtin: Option<f64>,
    /// Set when `kind == "custom"`; absent otherwise.  PeerId widened
    /// to BigInt (matches V3.4.0.4b generateUuidPeerId + V3.4.0.5a
    /// PresenceStateJson conventions).
    pub custom_peer: Option<BigInt>,
    /// Set when `kind == "custom"`; absent otherwise. `Option<f64>` for the same
    /// no-coercion reason as `builtin` (6.3-2 hardening H1).
    pub custom_counter: Option<f64>,
}

impl From<ql_storage::FormatId> for FormatIdJson {
    fn from(id: ql_storage::FormatId) -> Self {
        match id {
            ql_storage::FormatId::Builtin(n) => Self {
                kind: "builtin".to_string(),
                builtin: Some(n as f64),
                custom_peer: None,
                custom_counter: None,
            },
            ql_storage::FormatId::Custom(peer, counter) => Self {
                kind: "custom".to_string(),
                builtin: None,
                custom_peer: Some(BigInt::from(peer.0)),
                custom_counter: Some(counter as f64),
            },
        }
    }
}

/// **FE-4 W4 (2026-06-10):** JS-facing cell-STYLE id (the visual-formatting
/// analog of [`FormatIdJson`]). A peer-allocated `(peer, counter)` tuple —
/// NO `kind`/`builtin` discriminant, because styles have no Excel-canonical
/// registry. `peer` is a `BigInt` (widened from the engine's `u64`); `counter`
/// is `f64` (the 6.3-2-hardening no-coercion discipline — validated via
/// `validate_u32_index`, never silently `ToUint32`-coerced).
#[napi(object)]
pub struct StyleIdJson {
    /// Registering peer id (u64 widened to BigInt).
    pub peer: BigInt,
    /// Per-peer counter (u32-domain, typed f64 for no-coercion validation).
    pub counter: f64,
}

impl From<ql_storage::StyleId> for StyleIdJson {
    fn from(id: ql_storage::StyleId) -> Self {
        Self {
            peer: BigInt::from(id.peer.0),
            counter: id.counter as f64,
        }
    }
}

/// **FE-4 W4 (2026-06-10):** map a storage `ql_storage::Style` directly to the
/// JS [`StyleJson`] (used by the dormant `CollabSession` snapshot path, which
/// reads the Workbook's `StyleTable` rather than the `ql_session` DTOs).
fn style_json_from_storage(s: ql_storage::Style) -> StyleJson {
    fn rgb(c: ql_storage::Rgb) -> RgbJson {
        RgbJson {
            r: c.r as f64,
            g: c.g as f64,
            b: c.b as f64,
        }
    }
    fn border_style_str(s: ql_storage::BorderStyle) -> &'static str {
        match s {
            ql_storage::BorderStyle::None => "none",
            ql_storage::BorderStyle::Thin => "thin",
            ql_storage::BorderStyle::Medium => "medium",
            ql_storage::BorderStyle::Thick => "thick",
            ql_storage::BorderStyle::Dashed => "dashed",
            ql_storage::BorderStyle::Dotted => "dotted",
            ql_storage::BorderStyle::Double => "double",
        }
    }
    fn edge(e: ql_storage::BorderEdge) -> BorderEdgeJson {
        BorderEdgeJson {
            style: border_style_str(e.style).to_string(),
            color: rgb(e.color),
        }
    }
    let align = match s.align {
        ql_storage::HAlign::General => "general",
        ql_storage::HAlign::Left => "left",
        ql_storage::HAlign::Center => "center",
        ql_storage::HAlign::Right => "right",
    };
    StyleJson {
        bold: s.bold,
        italic: s.italic,
        // FE-7: emit absent-when-off (mirrors fill/text_color "absent ⇒ default"); the IDE
        // resolver reads `=== true`, so None and Some(false) are equivalent — None keeps the wire minimal.
        underline: if s.underline { Some(true) } else { None },
        strike: if s.strike { Some(true) } else { None },
        fill: s.fill.map(rgb),
        text_color: s.text_color.map(rgb),
        align: Some(align.to_string()),
        border_top: Some(edge(s.borders.top)),
        border_bottom: Some(edge(s.borders.bottom)),
        border_left: Some(edge(s.borders.left)),
        border_right: Some(edge(s.borders.right)),
    }
}

/// **FE-4 W4 (2026-06-10):** JS-facing RGB color (`{ r, g, b }`, each a
/// u8-domain `f64` for no-coercion validation).
#[napi(object)]
pub struct RgbJson {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

/// **FE-4 W4 (2026-06-10):** JS-facing border edge (`{ style, color }`).
/// `style` is one of `none|thin|medium|thick|dashed|dotted|double`.
#[napi(object)]
pub struct BorderEdgeJson {
    /// Stroke style string (`none` ⇒ no border on this edge).
    pub style: String,
    /// Stroke color.
    pub color: RgbJson,
}

/// **FE-4 W4 (2026-06-10):** JS-facing cell VISUAL style — bold/italic/fill/
/// align + per-edge borders (operator decision #4 schema). The input DTO for
/// [`Session::register_style`] and the value carried in [`StyleDefJson`].
/// `align` is one of `general|left|center|right`. `fill`/border fields are
/// optional (absent ⇒ no fill / no border on that edge).
///
/// **FE-7 (2026-06-13):** adds the font attrs `underline` / `strike` (clones
/// of `bold` / `italic`) and `text_color` (clone of `fill`; camelCase JSON
/// `textColor`, absent ⇒ no text color). `register_style` round-trips all
/// three into the engine `Style`, and the snapshot emits them.
#[napi(object)]
pub struct StyleJson {
    /// Bold font weight.
    pub bold: bool,
    /// Italic font slant.
    pub italic: bool,
    /// Underline toggle (FE-7); absent ⇒ off (optional like `fill`, so a caller
    /// that omits it — the IDE "carry only when on" convention — is valid input).
    pub underline: Option<bool>,
    /// Strikethrough toggle (FE-7); absent ⇒ off (optional like `fill`).
    pub strike: Option<bool>,
    /// Background fill color; absent ⇒ no fill.
    pub fill: Option<RgbJson>,
    /// Font color (FE-7; camelCase `textColor`); absent ⇒ no text color.
    pub text_color: Option<RgbJson>,
    /// Horizontal alignment string (`general|left|center|right`); absent ⇒ general.
    pub align: Option<String>,
    /// Top border edge; absent ⇒ no top border.
    pub border_top: Option<BorderEdgeJson>,
    /// Bottom border edge; absent ⇒ no bottom border.
    pub border_bottom: Option<BorderEdgeJson>,
    /// Left border edge; absent ⇒ no left border.
    pub border_left: Option<BorderEdgeJson>,
    /// Right border edge; absent ⇒ no right border.
    pub border_right: Option<BorderEdgeJson>,
}

/// **FE-4 W4 (2026-06-10):** one style registration in a
/// `WorkbookSnapshotJson.styles` array — pairs a [`StyleIdJson`] with its
/// [`StyleJson`] value (the visual-formatting analog of [`FormatDefJson`]).
/// The IDE resolves each cell's `style_id` against this list to render.
#[napi(object)]
pub struct StyleDefJson {
    /// The style id.
    pub id: StyleIdJson,
    /// The style value (bold/italic/fill/align/borders).
    pub style: StyleJson,
}

/// **FE-5 W-N (2026-06-12):** JS-facing defined-name TARGET — a discriminated
/// union (the napi convention: `kind` tag + per-variant optional payload,
/// matching [`CellValueJson`] / [`FormatIdJson`]). Mirrors the four
/// `ql_session::NamedTargetDto` variants; ALL FOUR round-trip faithfully (a
/// loaded `.qbook` can carry Constant/Formula names even though the IDE's
/// `setName` only creates Range — they are NOT coerced down to Range).
///
/// **Variant → field mapping** (read the field indicated by `kind`; the others
/// are absent):
/// - `Cell`     → `{ kind: "cell", cell: CellAddrJson }`
/// - `Range`    → `{ kind: "range", range: NamedRangeTargetJson }`
/// - `Constant` → `{ kind: "constant", value: CellValueJson }`
/// - `Formula`  → `{ kind: "formula", formula: String }`
#[napi(object)]
pub struct NamedTargetJson {
    pub kind: String,
    /// Set when `kind == "cell"`.
    pub cell: Option<CellAddrJson>,
    /// Set when `kind == "range"`.
    pub range: Option<NamedRangeTargetJson>,
    /// Set when `kind == "constant"`.
    pub value: Option<CellValueJson>,
    /// Set when `kind == "formula"` (raw source, no leading `=`).
    pub formula: Option<String>,
}

/// **FE-5 W-N (2026-06-12):** JS-facing rectangular range for a `Range`-kind
/// defined-name target. OUTBOUND read shape (engine → JS): all coords are plain
/// `u32` (lossless from the engine ids), unlike the INBOUND [`CellRangeJson`]
/// which uses `f64` for boundary validation. Inclusive bounds.
#[napi(object)]
pub struct NamedRangeTargetJson {
    pub sheet: u32,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// **FE-5 W-N (2026-06-12):** one defined name in the workbook — its canonical
/// (upper-case) `name`, its [`NamedTargetJson`], and its `scope` (`None` =
/// workbook-scoped; `Some(sheetId)` = sheet-scoped). Surfaced in
/// `WorkbookSnapshotJson.names` and returned by `Session.listNames`.
#[napi(object)]
pub struct NamedRangeJson {
    pub name: String,
    pub target: NamedTargetJson,
    /// Absent for a workbook-scoped name; the sheet id for a sheet-scoped name.
    pub scope: Option<u32>,
}

/// **FE-5 W-? (Builder E, 2026-06-13):** one structured table's metadata in
/// `WorkbookSnapshotJson.tables` — the JS read surface the IDE renders table chrome
/// from (header/totals styling, banded rows, the table-name badge). Mirrors
/// [`ql_session::TableSnapshot`] (the snapshot OUTPUT DTO — distinct from the
/// `createTable`-INPUT [`TableSpecJson`], which has no `displayName` / carries the
/// create-only `columnNames`).
///
/// napi-rs serializes the snake_case Rust field names to camelCase JSON:
/// `display_name`→`displayName`, `top_row`→`topRow`, `top_col`→`topCol`,
/// `has_header`→`hasHeader`, `has_totals`→`hasTotals` (matching the sibling
/// `TableSpecJson`/`CellRangeJson` convention). Coordinates are emitted as the
/// engine's `u32`/`u16` (no `f64` widening — this is an OUTPUT, read directly).
#[napi(object)]
pub struct TableSnapshotJson {
    /// Canonical (uppercase) table name.
    pub name: String,
    /// Display name (case-preserving). Equals `name` when none was supplied.
    pub display_name: String,
    /// Anchor sheet id — which sheet the IDE draws the table chrome on.
    pub sheet: u32,
    /// Top-left row of the full footprint.
    pub top_row: u32,
    /// Top-left column of the full footprint.
    pub top_col: u32,
    /// Total rows (incl. header/totals if present).
    pub rows: u32,
    /// Total columns.
    pub cols: u32,
    /// `true` iff the first footprint row is a header row.
    pub has_header: bool,
    /// `true` iff the last footprint row is a totals row.
    pub has_totals: bool,
}

/// **Wave Q1 (2026-06-23):** one chart object returned by `Session.listCharts`.
/// Mirrors [`ql_storage::ChartObject`]. `chartType` is the lowercase wire token
/// (`"line"`/`"bar"`/`"scatter"`). Coordinates are the engine's native
/// `u32`/`u16` (sheet widened to `u32` for JS); the source range is carried as
/// explicit `src*` fields (it may live on a different sheet than the anchor).
#[napi(object)]
pub struct ChartJson {
    pub id: u32,
    pub name: String,
    pub chart_type: String,
    pub sheet: u32,
    pub anchor_row: u32,
    pub anchor_col: u32,
    pub width_px: u32,
    pub height_px: u32,
    pub src_sheet: u32,
    pub src_start_row: u32,
    pub src_start_col: u32,
    pub src_end_row: u32,
    pub src_end_col: u32,
    pub title: Option<String>,
}

/// **Wave Q1 (2026-06-23):** the INPUT spec for `Session.addChart` /
/// `Session.updateChart` (no `id` -- `add` allocates it, `update` takes it as a
/// separate arg). `chartType` must be `"line"`/`"bar"`/`"scatter"` (an unknown
/// token -> `[bad_argument]`). Numeric fields are `f64` ON PURPOSE: napi's
/// `u32`/`u16` getters apply ECMAScript `ToUint32` (silently mapping `-1` ->
/// `u32::MAX`, `0.5` -> `0`, `NaN`/`Inf` -> `0`), which would corrupt workbook
/// state before validation. Taking the raw `f64` and routing every field through
/// `validate_u{16,32}_index` (in `parse_chart_spec`) surfaces bad inputs as loud
/// JS Errors instead (No-Fallbacks; mirrors the cell-edit napi surface).
#[napi(object)]
pub struct ChartSpecJson {
    pub name: String,
    pub chart_type: String,
    pub sheet: f64,
    pub anchor_row: f64,
    pub anchor_col: f64,
    pub width_px: f64,
    pub height_px: f64,
    pub src_sheet: f64,
    pub src_start_row: f64,
    pub src_start_col: f64,
    pub src_end_row: f64,
    pub src_end_col: f64,
    pub title: Option<String>,
}

/// **Wave Q1:** project a session [`ql_storage::ChartObject`] into the
/// JS-facing [`ChartJson`].
fn chart_json_from_object(c: ql_storage::ChartObject) -> ChartJson {
    ChartJson {
        id: c.id,
        name: c.name,
        chart_type: c.chart_type.as_wire_str().to_string(),
        sheet: c.sheet as u32,
        anchor_row: c.anchor_row,
        anchor_col: c.anchor_col,
        width_px: c.width_px,
        height_px: c.height_px,
        src_sheet: c.source_range.sheet as u32,
        src_start_row: c.source_range.start_row,
        src_start_col: c.source_range.start_col,
        src_end_row: c.source_range.end_row,
        src_end_col: c.source_range.end_col,
        title: c.title,
    }
}

/// **Wave Q1:** a fully-validated chart spec, ready for the engine call. Every
/// numeric field has cleared `validate_u{16,32}_index` (rejecting the JS
/// `ToUint32` coercions) plus the structural checks (non-zero size, in-grid
/// coordinates). `name`/`title` are read from the `ChartSpecJson` directly
/// (Strings carry no coercion hazard).
struct ParsedChartSpec {
    kind: ql_storage::ChartKind,
    sheet: u16,
    anchor_row: u32,
    anchor_col: u32,
    width_px: u32,
    height_px: u32,
    src: ql_types::Range,
}

/// **Wave Q1:** validate + convert a [`ChartSpecJson`] into a [`ParsedChartSpec`].
/// Fail-loud `[bad_argument]` (No-Fallbacks -- no silent default/clamp) on: an
/// unknown `chartType`; any numeric field that is non-finite / negative /
/// fractional / out of its index range (every field routes through
/// `validate_u{16,32}_index`, which take the RAW `f64` so napi's `ToUint32`
/// cannot pre-corrupt it -- see `validate_u32_index`); a zero `widthPx`/
/// `heightPx`; or an anchor / source coordinate past the addressable grid
/// (`MAX_ROW` / `MAX_COLUMN`). An INVERTED source range (`startRow > endRow`
/// etc.) is NOT rejected: `Range::new` normalizes it (round-trips to the
/// normalized form), matching the qbook loader's chart validation.
fn parse_chart_spec(method: &str, spec: &ChartSpecJson) -> Result<ParsedChartSpec> {
    let kind = ql_storage::ChartKind::from_wire_str(&spec.chart_type).ok_or_else(|| {
        bad_argument_error(format!(
            "unknown chartType {:?} (expected \"line\", \"bar\", or \"scatter\")",
            spec.chart_type
        ))
    })?;
    let sheet = validate_u16_index(method, "sheet", spec.sheet)?;
    let src_sheet = validate_u16_index(method, "srcSheet", spec.src_sheet)?;
    let anchor_row = validate_u32_index(method, "anchorRow", spec.anchor_row)?;
    let anchor_col = validate_u32_index(method, "anchorCol", spec.anchor_col)?;
    let width_px = validate_u32_index(method, "widthPx", spec.width_px)?;
    let height_px = validate_u32_index(method, "heightPx", spec.height_px)?;
    let src_start_row = validate_u32_index(method, "srcStartRow", spec.src_start_row)?;
    let src_start_col = validate_u32_index(method, "srcStartCol", spec.src_start_col)?;
    let src_end_row = validate_u32_index(method, "srcEndRow", spec.src_end_row)?;
    let src_end_col = validate_u32_index(method, "srcEndCol", spec.src_end_col)?;
    if width_px == 0 || height_px == 0 {
        return Err(bad_argument_error(
            "chart widthPx and heightPx must both be > 0".to_string(),
        ));
    }
    if anchor_row > ql_types::MAX_ROW || anchor_col > ql_types::MAX_COLUMN {
        return Err(bad_argument_error(format!(
            "anchor cell (row {anchor_row}, col {anchor_col}) is beyond the addressable grid \
             (MAX_ROW {}, MAX_COLUMN {})",
            ql_types::MAX_ROW,
            ql_types::MAX_COLUMN
        )));
    }
    if src_start_row > ql_types::MAX_ROW
        || src_end_row > ql_types::MAX_ROW
        || src_start_col > ql_types::MAX_COLUMN
        || src_end_col > ql_types::MAX_COLUMN
    {
        return Err(bad_argument_error(format!(
            "source range is beyond the addressable grid (MAX_ROW {}, MAX_COLUMN {})",
            ql_types::MAX_ROW,
            ql_types::MAX_COLUMN
        )));
    }
    let src = ql_types::Range::new(src_sheet, src_start_row, src_start_col, src_end_row, src_end_col);
    Ok(ParsedChartSpec {
        kind,
        sheet,
        anchor_row,
        anchor_col,
        width_px,
        height_px,
        src,
    })
}

/// **FE-5 W-N (2026-06-12):** project a storage `ql_storage::NamedTarget`
/// DIRECTLY into the JS [`NamedTargetJson`] — used by the CollabSession
/// `workbook_snapshot` path (which holds a rebuilt `ql_storage::Workbook`, not a
/// `ql_session::WorkbookSnapshot`). TOTAL over all four variants (No-Fallbacks:
/// a Constant/Formula is never collapsed to a Range). `Constant` reuses the
/// `CellWireValue` vocabulary via the existing `From<CellWireValue>` —
/// `CellWireValue::from_value` returns `None` only for `Value::Blank`, which a
/// named Constant practically never is; that case maps to a `blank` cell value.
fn named_target_json_from_storage(target: &ql_storage::NamedTarget) -> NamedTargetJson {
    match target {
        ql_storage::NamedTarget::Cell(addr) => NamedTargetJson {
            kind: "cell".to_string(),
            cell: Some(CellAddrJson {
                sheet: u32::from(addr.sheet),
                row: addr.row,
                col: addr.col,
            }),
            range: None,
            value: None,
            formula: None,
        },
        ql_storage::NamedTarget::Range(r) => NamedTargetJson {
            kind: "range".to_string(),
            cell: None,
            range: Some(NamedRangeTargetJson {
                sheet: u32::from(r.sheet),
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
            }),
            value: None,
            formula: None,
        },
        ql_storage::NamedTarget::Constant(v) => {
            // Map the value through the wire vocabulary; Blank (the only None
            // case) → a "blank" cell value, faithfully (NOT coerced to Range).
            let value = match CellWireValue::from_value(v) {
                Some(wire) => CellValueJson::from(wire),
                None => CellValueJson {
                    kind: "blank".to_string(),
                    number: None,
                    boolean: None,
                    text: None,
                    error: None,
                },
            };
            NamedTargetJson {
                kind: "constant".to_string(),
                cell: None,
                range: None,
                value: Some(value),
                formula: None,
            }
        }
        ql_storage::NamedTarget::Formula(src) => NamedTargetJson {
            kind: "formula".to_string(),
            cell: None,
            range: None,
            value: None,
            formula: Some(src.as_ref().to_owned()),
        },
    }
}

/// **FE-5 W-N (2026-06-12):** walk a rebuilt `ql_storage::Workbook` for ALL its
/// defined names (BOTH workbook-scoped AND every sheet's sheet-scoped names —
/// missing either scope is a silent data loss) and produce a sorted
/// `Vec<NamedRangeJson>`. Used by the CollabSession `workbook_snapshot` path.
/// Sort order matches the owning-Session `collect_named_ranges`: workbook-scoped
/// first, then by sheet id, then by name.
fn collect_named_ranges_json(workbook: &ql_storage::Workbook) -> Vec<NamedRangeJson> {
    let mut names: Vec<NamedRangeJson> = Vec::new();
    for (name, target) in workbook.names().iter() {
        names.push(NamedRangeJson {
            name: name.as_ref().to_owned(),
            target: named_target_json_from_storage(target),
            scope: None,
        });
    }
    for sheet_id in 0..workbook.sheet_count() as u16 {
        if let Some(sheet) = workbook.sheet(sheet_id) {
            for (name, target) in sheet.scoped_names().iter() {
                names.push(NamedRangeJson {
                    name: name.as_ref().to_owned(),
                    target: named_target_json_from_storage(target),
                    scope: Some(u32::from(sheet_id)),
                });
            }
        }
    }
    names.sort_by(|a, b| a.scope.cmp(&b.scope).then_with(|| a.name.cmp(&b.name)));
    names
}

/// **FE-5 W-? (Builder E, 2026-06-13):** map a contract [`ql_session::TableSnapshot`]
/// to the JS [`TableSnapshotJson`] — used by the owning-`Session` snapshot path
/// (which holds a `ql_session::WorkbookSnapshot`). TOTAL field map (No-Fallbacks).
fn table_snapshot_json_from_session(t: ql_session::TableSnapshot) -> TableSnapshotJson {
    TableSnapshotJson {
        name: t.name,
        display_name: t.display_name,
        sheet: u32::from(t.sheet),
        top_row: t.top_row,
        top_col: t.top_col,
        rows: t.rows,
        cols: t.cols,
        has_header: t.has_header,
        has_totals: t.has_totals,
    }
}

/// **FE-5 W-? (Builder E, 2026-06-13):** walk a rebuilt `ql_storage::Workbook` for
/// ALL its structured tables (the table table is workbook-level + name-keyed, so
/// one `tables().iter()` yields every table once; each carries its own anchor
/// `sheet`). Used by the CollabSession `workbook_snapshot` path (which holds a
/// rebuilt `ql_storage::Workbook`, not a `ql_session::WorkbookSnapshot`). Sorted by
/// `(sheet, name)` to match the owning-Session `collect_tables`. TOTAL field map.
fn collect_tables_json(workbook: &ql_storage::Workbook) -> Vec<TableSnapshotJson> {
    let mut tables: Vec<TableSnapshotJson> = workbook
        .tables()
        .iter()
        .map(|(_canonical, meta)| TableSnapshotJson {
            name: meta.name.as_ref().to_owned(),
            display_name: meta.display_name.as_ref().to_owned(),
            sheet: u32::from(meta.sheet),
            top_row: meta.top_row,
            top_col: meta.top_col,
            rows: meta.rows,
            cols: meta.cols,
            has_header: meta.has_header,
            has_totals: meta.has_totals,
        })
        .collect();
    tables.sort_by(|a, b| a.sheet.cmp(&b.sheet).then_with(|| a.name.cmp(&b.name)));
    tables
}

/// **FE-5 W-N (2026-06-12):** map a contract [`ql_session::NamedRange`] to the
/// JS [`NamedRangeJson`]. The `target` projection is TOTAL — every
/// `NamedTargetDto` variant maps to its faithful JS shape (No-Fallbacks: a
/// Constant/Formula is never silently collapsed to a Range).
fn named_range_json_from_session(nr: ql_session::NamedRange) -> NamedRangeJson {
    let target = match nr.target {
        ql_session::NamedTargetDto::Cell { cell } => NamedTargetJson {
            kind: "cell".to_string(),
            cell: Some(CellAddrJson {
                sheet: u32::from(cell.sheet),
                row: cell.row,
                col: cell.col,
            }),
            range: None,
            value: None,
            formula: None,
        },
        ql_session::NamedTargetDto::Range { range } => NamedTargetJson {
            kind: "range".to_string(),
            cell: None,
            range: Some(NamedRangeTargetJson {
                sheet: u32::from(range.sheet),
                start_row: range.start_row,
                start_col: range.start_col,
                end_row: range.end_row,
                end_col: range.end_col,
            }),
            value: None,
            formula: None,
        },
        ql_session::NamedTargetDto::Constant { value } => NamedTargetJson {
            kind: "constant".to_string(),
            cell: None,
            range: None,
            value: Some(cell_value_json_from_session(value)),
            formula: None,
        },
        ql_session::NamedTargetDto::Formula { source } => NamedTargetJson {
            kind: "formula".to_string(),
            cell: None,
            range: None,
            value: None,
            formula: Some(source),
        },
    };
    NamedRangeJson {
        name: nr.name,
        target,
        scope: nr.scope.map(u32::from),
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
    /// **FE-4 W4 (2026-06-10):** cell visual-STYLE id passthrough. `None` =
    /// no explicit style (renders unstyled). Resolve against
    /// `WorkbookSnapshotJson.styles` / `WorkbookSnapshotDeltaJson.stylesAdded`
    /// to get the `StyleJson` value. (FE-5 consumes this for canvas rendering;
    /// FE-4 ships engine-only — the field round-trips through the snapshot.)
    pub style_id: Option<StyleIdJson>,
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

    /// **FE-4 W4 (2026-06-10):** session-wide cell-style registry (the
    /// visual-formatting analog of `formats`). Resolves each cell's
    /// `style_id` to a `StyleJson` value. Sorted by `StyleId`. Empty when no
    /// styles are registered. Consumed by FE-5 canvas rendering; FE-4 ships
    /// the passthrough only.
    pub styles: Vec<StyleDefJson>,

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

    /// **Phase 6.3-1c M5 (2026-05-30)**: the contract DTO schema version
    /// ([`ql_session::SCHEMA_VERSION`]) every DTO crossing the boundary carries
    /// (contract §4.1). The IDE asserts it matches the version its mirrors were
    /// built against; a mismatch is a fail-loud `unsupported_schema_version`
    /// (the IDE is the producer of that code) rather than a silent shape drift.
    /// napi serializes as `schemaVersion`.
    pub schema_version: u16,

    /// **FE-5 W-N (2026-06-12):** all defined names in the workbook — BOTH
    /// workbook-scoped (`scope` absent) AND every sheet's sheet-scoped names
    /// (`scope` = the sheet id). Sorted (workbook-scoped first, then by sheet
    /// id, then by name) for a stable shape. Empty when none are defined.
    ///
    /// The Name-Manager UI is the consumer: defined-name changes are
    /// delta-INVISIBLE (not in `WorkbookSnapshotDeltaJson`), so the IDE
    /// refreshes the list via a full `workbookSnapshot()` / `snapshot()` call,
    /// not via `snapshotDelta`.
    ///
    /// **Additive field** (the snapshot schema bumped 1 → 2 alongside this):
    /// `.sheets`/`.formats`-destructuring consumers are unaffected.
    pub names: Vec<NamedRangeJson>,

    /// **FE-5 W-? (Builder E, 2026-06-13):** every structured table in the workbook
    /// (across ALL sheets), so the IDE can render table chrome. Sorted (by sheet id,
    /// then canonical name) for a stable shape. Empty when no tables are defined.
    ///
    /// Like `names`, structured-table changes are delta-INVISIBLE (not in
    /// `WorkbookSnapshotDeltaJson` — a table op bumps the epoch and forces a full
    /// reseed), so the IDE refreshes the table list via a full
    /// `workbookSnapshot()` / `snapshot()` call, not via `snapshotDelta`.
    ///
    /// **Additive field** (the snapshot schema bumped 2 → 3 alongside this):
    /// `.sheets`/`.formats`/`.names`-destructuring consumers are unaffected.
    pub tables: Vec<TableSnapshotJson>,
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

    /// **FE-4 W4 (2026-06-10):** styles registered since `lastSeenVersion`
    /// (the visual-formatting analog of `formats_added`). The IDE merges each
    /// into its `styles` table by `StyleId`.
    pub styles_added: Vec<StyleDefJson>,

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

    /// **Phase 6.3-1c (2026-05-30, MED-2 / contract §4.3)**: when
    /// `full_rebuild_required` is `true` for an ENUMERATED, designed resync
    /// state, the reason string (`"no_prior_version"` / `"cache_cleared"` /
    /// `"stale_horizon"` / `"epoch_mismatch"` — [`ql_session::FullRebuildReason`]
    /// snake_case). `None` when `full_rebuild_required` is `false`, or for the
    /// collab-path full-rebuild cases that are not one of the four designed
    /// states (a malformed token — which contract §4.3 reserves for a fail-loud
    /// `invalid_version_token`, but the legacy collab path treats as a
    /// recoverable resync — a rename, or a defensive cache-invariant guard).
    /// napi serializes as `fullRebuildReason`.
    pub full_rebuild_reason: Option<String>,

    /// **Phase 6.3-1c M5 (2026-05-30)**: contract DTO schema version
    /// ([`ql_session::SCHEMA_VERSION`], contract §4.1) — see
    /// [`WorkbookSnapshotJson::schema_version`]. napi serializes as
    /// `schemaVersion`.
    pub schema_version: u16,
}

/// **Phase 6.3-3 (2026-05-30):** result of `undo`/`redo` (mirrors
/// [`ql_session::dto::UndoRedoResult`], contract §3.8). `consumed: false` means
/// the stack was empty — that is a normal outcome, NOT an error. `version` is the
/// opaque post-step [`ql_session::SessionVersion`] as a `Buffer`; undo/redo clears
/// the delta cache, so the NEXT `snapshotDelta` against an older token
/// full-rebuilds.
#[napi(object)]
pub struct UndoRedoResultJson {
    pub consumed: bool,
    pub version: Buffer,
}

/// **Phase 5.7 V3.4.0.5 (2026-05-23) -- JS-facing PresenceState.**
///
/// Mirrors `ql_collab::presence::PresenceState` for the napi boundary.
/// Plain data struct (no methods) marked `#[napi(object)]` so napi-rs
/// generates a TypeScript interface with structural typing.  Field
/// names use camelCase to follow JS conventions (engine uses snake_case);
/// napi-rs maps Rust `snake_case` field names to JS `camelCase` by
/// default but the explicit conversion makes the contract obvious to
/// readers.
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

    /// **W3 (insert/delete rows & columns) — insert `count` blank rows at row
    /// index `at` on `sheet`.**
    ///
    /// Producer model (mirrors `WorkbookRuntime::rename_sheet`): rebuild the
    /// current workbook, compute the formula-TEXT shift for every formula
    /// referencing the edited sheet (`=A5` -> `=A6`; deleted refs -> `#REF!`)
    /// via `ql_formula_syntax::shift_formula_text`, then append a single
    /// `Op::BatchCommit { [Op::InsertRows, Op::PutFormula × N] }`. The
    /// `InsertRows` op (replayed first) performs the POSITIONAL shift (cell
    /// storage + formula-cell KEYS + named ranges + table footprints); the
    /// `PutFormula` ops write the rewritten TEXT at the new positions.
    ///
    /// All coordinates are 0-indexed (engine convention; A1 == row 0, col 0).
    ///
    /// # Errors
    /// - `[bad_argument]` if `sheet` exceeds u16, or `at`/`count` are out of
    ///   range, or the edit would split a table footprint / push it off-grid.
    /// - `[session_oplog]` for op-log append failure.
    /// - `[session_replay]` if the pre-append rebuild fails.
    #[napi(js_name = "insertRows")]
    pub fn insert_rows(&self, sheet: u32, at: f64, count: f64) -> Result<()> {
        let at = validate_u32_index("insertRows", "at", at)?;
        let count = validate_u32_index("insertRows", "count", count)?;
        self.append_structural_edit(
            "insertRows",
            sheet,
            StructuralAxis::Row,
            StructuralKind::Insert { at, count },
        )
    }

    /// **W3 — delete the INCLUSIVE row block `[start, end]` on `sheet`.**
    /// See [`Self::insert_rows`] for the producer model. `end` is inclusive
    /// and 0-indexed. Refs into the deleted block become `#REF!`.
    #[napi(js_name = "deleteRows")]
    pub fn delete_rows(&self, sheet: u32, start: f64, end: f64) -> Result<()> {
        let start = validate_u32_index("deleteRows", "start", start)?;
        let end = validate_u32_index("deleteRows", "end", end)?;
        self.append_structural_edit(
            "deleteRows",
            sheet,
            StructuralAxis::Row,
            StructuralKind::Delete { start, end },
        )
    }

    /// **W3 — insert `count` blank columns at column index `at` on `sheet`.**
    #[napi(js_name = "insertColumns")]
    pub fn insert_columns(&self, sheet: u32, at: f64, count: f64) -> Result<()> {
        let at = validate_u32_index("insertColumns", "at", at)?;
        let count = validate_u32_index("insertColumns", "count", count)?;
        self.append_structural_edit(
            "insertColumns",
            sheet,
            StructuralAxis::Col,
            StructuralKind::Insert { at, count },
        )
    }

    /// **W3 — delete the INCLUSIVE column block `[start, end]` on `sheet`.**
    #[napi(js_name = "deleteColumns")]
    pub fn delete_columns(&self, sheet: u32, start: f64, end: f64) -> Result<()> {
        let start = validate_u32_index("deleteColumns", "start", start)?;
        let end = validate_u32_index("deleteColumns", "end", end)?;
        self.append_structural_edit(
            "deleteColumns",
            sheet,
            StructuralAxis::Col,
            StructuralKind::Delete { start, end },
        )
    }

    /// **W3 (insert/delete rows & columns):** shared producer for the four
    /// structural-edit napi methods. Validates inputs, rebuilds the workbook,
    /// computes the formula-text shift, and appends the `BatchCommit`.
    fn append_structural_edit(
        &self,
        method: &str,
        sheet: u32,
        axis: StructuralAxis,
        kind: StructuralKind,
    ) -> Result<()> {
        // Validate sheet fits SheetId (u16).
        if sheet > u16::MAX as u32 {
            return Err(bad_argument_error(format!(
                "{method}: sheet must be in [0, 65535] (u16::MAX), got {sheet}"
            )));
        }
        let sheet_id = sheet as u16;
        // Validate the axis range bounds against Excel limits + delete order.
        let axis_max = match axis {
            StructuralAxis::Row => ql_types::MAX_ROW,
            StructuralAxis::Col => ql_types::MAX_COLUMN,
        };
        match kind {
            StructuralKind::Insert { at, count } => {
                if count == 0 {
                    return Err(bad_argument_error(format!("{method}: count must be >= 1")));
                }
                if at > axis_max {
                    return Err(bad_argument_error(format!(
                        "{method}: at {at} exceeds axis maximum {axis_max}"
                    )));
                }
            }
            StructuralKind::Delete { start, end } => {
                if start > end {
                    return Err(bad_argument_error(format!(
                        "{method}: start {start} must be <= end {end}"
                    )));
                }
                if end > axis_max {
                    return Err(bad_argument_error(format!(
                        "{method}: end {end} exceeds axis maximum {axis_max}"
                    )));
                }
            }
        }

        let mut inner = self.inner.lock();
        let registry = default_registry();
        let (workbook, _report) = inner
            .rebuild_workbook(&registry)
            .map_err(collab_session_error_to_napi)?;

        // **Audited producer core (7 audit passes).** The sheet-existence +
        // tombstone refusal (Codex L5 MED-2), the clone-preflight (Codex L5
        // MED-3), the per-formula text-shift, and the `[structural_op,
        // PutFormula×N]` assembly all live in `ql_exec::structural` now so the
        // owning `Session` path reuses the SAME logic. The `{method}:` prefix
        // keeps the binding's error strings byte-identical to the pre-extraction
        // behavior (the napi-arg validation above already covers the
        // count==0 / bounds-order class with the historical messages).
        let ops = build_structural_batch(&workbook, sheet_id, axis, kind, axis_max)
            .map_err(|e| structural_error_to_napi(method, e))?;
        inner
            .append_op(Op::BatchCommit { ops })
            .map_err(collab_session_error_to_napi)?;
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
    pub fn append_put_formula(&self, sheet: f64, row: f64, col: f64, text: String) -> Result<()> {
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
    /// **DEAD / LEGACY SURFACE + HARDENING GUARDRAIL (conductor follow-up,
    /// 2026-06).** This napi (and `listSheets`) is a dormant V3.2-V3.3
    /// surface: the product reaches snapshots through
    /// `SessionInstance`/CoreWorkbookSession (`workbookSnapshot`), which
    /// independently rebuilds via `replay_into` and fails closed. **Do NOT
    /// "harden" this read by routing it through `rebuild_workbook`** -- an
    /// earlier revision of this very doc suggested exactly that ("V3.2.b+
    /// may upgrade this to route through `rebuild_workbook`"), and a later
    /// re-megaudit echoed it as a "~2-line fix". It does not work:
    /// `rebuild_workbook` -> `replay_into` -> `validate_cell` REJECTS
    /// `sheet >= sheet_count`, but this surface accepts LENIENT logs --
    /// bare `PutValue` to arbitrary sheet ids with NO `AddSheet` (the mocha
    /// `listSheets` suite + `appendPutValue` both depend on this) -- so
    /// routing through rebuild returns `Err` on its own valid inputs. The
    /// cache IS the correct lenient reader for this surface; its
    /// correctness rests on the op-walker (`collect_cache_effects` in
    /// ql-collab), which is locked for structural ops by the W3 AxisShift
    /// arms + `insert_rows_shifts_snapshot_cache_live_append`. Fail-closed
    /// behavior here is bounded to op-log DECODE errors (below); a
    /// walker-LOGIC gap (a new Op kind with no `CacheEffect`) is the
    /// silent-corruption risk, guarded at `collect_cache_effects`'s
    /// `_ => {}` arm, not here.
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
        // 5.8 megaudit Lane B#1 (2026-05-26): the cache PRESERVES cells on a
        // tombstoned sheet (R-V3.6-19 no-prune), and `snapshot_cells` is
        // tombstone-AGNOSTIC.  Filter here -- mirroring the `workbook_snapshot`
        // `is_sheet_removed` skip (~lib.rs:2226) + `list_sheets_from_cache` --
        // so a removed sheet does NOT leak its pre-tombstone cells.  An empty
        // entries list (cells hidden) is the correct shape, not an error.
        let entries_vec = if inner.is_sheet_removed_in_cache(sheet) {
            Vec::new()
        } else {
            inner.snapshot_cells(sheet)
        };
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
    ///
    /// **DEAD / LEGACY SURFACE (2026-06).** Dormant V3.2-V3.3 napi; the
    /// product enumerates sheets via `SessionInstance`/CoreWorkbookSession.
    /// Reads the value-bearing-sheet set from the cache (empty `AddSheet`
    /// sheets are intentionally NOT enumerated -- this surface's contract).
    /// **Do NOT route through `rebuild_workbook` to "harden" it** -- see the
    /// `exportSnapshot` docstring for why (lenient bare-`PutValue` logs that
    /// strict replay rejects); the cache is the correct lenient reader and
    /// its consistency is locked at `collect_cache_effects`.
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
        inner.clear_presence().map_err(collab_session_error_to_napi)
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
    ///
    /// **Wave H1 (2026-06-19) — Gap-C:** `CollabSession` is the DORMANT collab
    /// facade. v1's live single-writer path is `Session::save`/`open`, which
    /// Wave H1 switched to the single-file `.qbook` container. `toQbook` /
    /// `fromQbook` intentionally stay on the DIRECTORY format
    /// (`save_workbook_with_oplog` / `load_workbook_with_oplog`) — they are not
    /// on any live `.qbook` I/O path. If collab is revived, give them the same
    /// `is_dir`/file dispatch as `WorkbookSession::open` (a
    /// `load_workbook_with_oplog_any` helper). Tracked follow-up; NOT a silent
    /// half-migration.
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
                    let rendered: Option<String> =
                        match (state.format.as_ref(), state.value.as_ref()) {
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
                        // FE-4 W4: cell-style id passthrough (CollabSession cache path).
                        style_id: state.style.map(StyleIdJson::from),
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
        let mut format_pairs: Vec<(ql_storage::FormatId, &str)> =
            workbook.formats().iter().collect();
        format_pairs.sort_by_key(|(id, _)| *id);
        let formats: Vec<FormatDefJson> = format_pairs
            .into_iter()
            .map(|(id, s)| FormatDefJson {
                id: FormatIdJson::from(id),
                string: s.to_string(),
            })
            .collect();
        // **FE-4 W4 (2026-06-10):** populate `styles` from the rebuilt
        // Workbook's StyleTable (authoritative; same rationale as `formats`).
        // Sorted by StyleId for a stable wire shape across snapshots.
        let mut style_pairs: Vec<(ql_storage::StyleId, ql_storage::Style)> =
            workbook.styles().iter().collect();
        style_pairs.sort_by_key(|(id, _)| *id);
        let styles: Vec<StyleDefJson> = style_pairs
            .into_iter()
            .map(|(id, style)| StyleDefJson {
                id: StyleIdJson::from(id),
                style: style_json_from_storage(style),
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
        // FE-5 W-N: defined names from the rebuilt workbook (both scopes,
        // sorted). `set_workbook_cache` above only `Arc::clone`d `workbook`
        // (no move), so borrowing it here is fine.
        let names = collect_named_ranges_json(&workbook);
        // Builder E (2026-06-13): structured tables from the rebuilt workbook
        // (workbook-level table table; both `workbook` borrows are fine — the
        // earlier `set_workbook_cache` only `Arc::clone`d, no move).
        let tables = collect_tables_json(&workbook);
        Ok(WorkbookSnapshotJson {
            sheets,
            formats,
            styles,
            date_system,
            version: version_bytes,
            // 6.3-1c M5: stamp the contract schema version on every snapshot DTO.
            schema_version: ql_session::SCHEMA_VERSION,
            names,
            tables,
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
            return Ok(empty_delta(
                current_version_bytes,
                true,
                Some(FullRebuildReason::NoPriorVersion),
            ));
        }

        // Step 1b: no prior cache → full rebuild required.
        let (cached_arc, cached_vv, cached_op_count) = match (
            inner.last_snapshot_workbook(),
            inner.last_snapshot_oplog_vv(),
            inner.last_snapshot_op_count(),
        ) {
            (Some(arc), Some(vv), Some(n)) => (std::sync::Arc::clone(arc), vv.clone(), n),
            _ => {
                return Ok(empty_delta(
                    current_version_bytes,
                    true,
                    Some(FullRebuildReason::CacheCleared),
                ));
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
                // **6.3-1c:** reason `None` — contract §4.3 reserves a malformed
                // token for a fail-loud `invalid_version_token`, NOT one of the
                // four designed resync reasons; the legacy collab path keeps the
                // recoverable rebuild, so it carries no enumerated reason.
                return Ok(empty_delta(current_version_bytes, true, None));
            }
        };

        // Step 3: staleness check.
        if caller_vv != cached_vv {
            return Ok(empty_delta(
                current_version_bytes,
                true,
                Some(FullRebuildReason::StaleHorizon),
            ));
        }

        // Step 4: same-VV fast-path.
        if current_vv == cached_vv {
            return Ok(empty_delta(current_version_bytes, false, None));
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
            // **6.3-1c:** reason `None` — a defensive cache-invariant guard
            // (cached_op_count > current_op_count is supposed to be impossible),
            // not one of the four designed §4.3 resync states.
            return Ok(empty_delta(current_version_bytes, true, None));
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
        // FE-4 W4: style registrations in the new-ops window → stylesAdded.
        let mut new_style_ids: Vec<ql_storage::StyleId> = Vec::new();
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
                    // **6.3-1c:** reason `None` — an op-decode failure mid-walk
                    // is a defensive conservative rebuild, not a designed §4.3
                    // resync state.
                    return Ok(empty_delta(current_version_bytes, true, None));
                }
            };
            classify_delta_op(
                &op,
                &mut has_rename,
                &mut changed_cell_coords,
                &mut removed_sheet_ids,
                &mut new_format_ids,
                &mut new_style_ids,
            );
            if has_rename {
                break;
            }
        }

        // Step 7: rename detected → full rebuild fallback.
        if has_rename {
            // **6.3-1c:** reason `None` — a rename forces a full rebuild but is
            // not one of the four designed §4.3 resync states.
            return Ok(empty_delta(current_version_bytes, true, None));
        }

        // Step 8: cell-only fast-path.  Clone the cached Workbook via
        // `(*cached_arc).clone()` always-clone (V3.6.0.8.4 OPUS-MED-3 +
        // V3.6.0.X phase-termination OPUS-PT-B2-MED closures: V3.6.0.8.1
        // lock said `Arc::make_mut` but implementation discovered
        // `cached_arc = Arc::clone(arc)` capture has strong_count >= 2
        // by construction so `make_mut` would clone anyway; always-clone
        // IS the right pattern.  V3.6.0.8.4 R-V3.6-17 measurement:
        // 692 μs at 100k cells, well under the 20 ms threshold).
        // Apply [cached_op_count, current_op_count) forward via
        // apply_ops_in_range -- no repair walks needed because we
        // confirmed no rename ops in the range.
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
        // **V3.6.0.X phase-termination closure (2026-05-26, CONVERGENT-
        // HIGH-1)**: the session cache no longer prunes cells on
        // RemoveSheet (cache mirrors V3.5.0.3b Workbook storage-
        // preservation discipline -- required for D8 RestoreSheet to
        // resurface preserved cells via the napi snapshot path).
        // Pre-closure the cache prune incidentally suppressed
        // changedCells for a cell-write + later RemoveSheet in the
        // same delta window; post-closure we must filter explicitly
        // against `removed_sheet_ids` so the IDE doesn't see a
        // changedCells entry for a sheet it just learned was removed.
        // Build the lookup set once (Vec→HashSet) for O(1) per-cell
        // check.
        let removed_sheet_set: std::collections::HashSet<u16> =
            removed_sheet_ids.iter().copied().collect();
        let mut changed_cells: Vec<ChangedCellJson> = Vec::with_capacity(changed_cell_coords.len());
        for (sheet, row, col) in changed_cell_coords {
            // V3.6.0.X phase-termination filter + 5.8 megaudit S2-01 closure
            // (2026-05-26): skip a changedCells entry for a TOMBSTONED sheet.
            // `removed_sheet_set` only covers RemoveSheet ops IN THIS delta
            // window; a sheet tombstoned in a PRIOR window and then written
            // via a later PutValue would otherwise leak a changedCells entry
            // for an already-removed sheet (cross-window leak -- the live-path
            // counterpart of the B#1 export_snapshot gap, converged by Codex +
            // Sonnet audit lanes).  `is_sheet_removed_in_cache` reflects ALL
            // tombstones (the cache's removed_sheets tracker), so it covers
            // both the current and prior windows; the `removed_sheet_set`
            // check is retained for explicitness.
            if removed_sheet_set.contains(&sheet) || inner.is_sheet_removed_in_cache(sheet) {
                continue;
            }
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
            let rendered: Option<String> = match (state.format.as_ref(), state.value.as_ref()) {
                (Some(fmt_id), Some(wire_value)) if !wire_value.is_pending() => {
                    let fmt_id_copy = *fmt_id;
                    wire_value.to_value().ok().and_then(|value| {
                        if let Some(fmt) = parsed_format_cache.get(&fmt_id_copy) {
                            return Some(ql_functions::format::render(&value, fmt, &eval_ctx));
                        }
                        let fmt_str = next_workbook.formats().lookup(fmt_id_copy)?;
                        let fmt = ql_functions::format::parse(fmt_str).ok()?;
                        let rendered_str = ql_functions::format::render(&value, &fmt, &eval_ctx);
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
                // FE-4 W4: cell-style id passthrough (CollabSession cache path).
                style_id: state.style.map(StyleIdJson::from),
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
        // D2 CONVERGENT-MED-1 closure). `new_format_ids` is already `mut`
        // (declared above), so sort/dedup it in place.
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
        // **FE-4 W4 (2026-06-10):** resolve style registrations → stylesAdded
        // (mirrors formats_added; sorted by StyleId for a stable shape).
        new_style_ids.sort();
        new_style_ids.dedup();
        let mut styles_added: Vec<StyleDefJson> = Vec::new();
        for style_id in new_style_ids {
            if let Some(style) = next_workbook.styles().lookup(style_id) {
                styles_added.push(StyleDefJson {
                    id: StyleIdJson::from(style_id),
                    style: style_json_from_storage(style),
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
            styles_added,
            version: current_version_bytes,
            full_rebuild_required: false,
            // 6.3-1c: a successful incremental delta — no rebuild, no reason.
            full_rebuild_reason: None,
            // 6.3-1c M5: stamp the contract schema version on every delta DTO.
            schema_version: ql_session::SCHEMA_VERSION,
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
    ///
    /// **Wave H1 (2026-06-19) — Gap-C:** stays on the DIRECTORY format
    /// (`load_workbook_with_oplog`); see `toQbook` for the rationale (dormant
    /// collab facade; live `.qbook` I/O is `Session`, now single-file).
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
        let mut session =
            CoreCollabSession::from_snapshot(pid, &bytes).map_err(collab_session_error_to_napi)?;
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

    // **M1 (6.3-1a) panic boundary — tested END-TO-END in the Node host, not
    // here.** `cargo test -p ql-bindings-node` cannot LINK a standalone test
    // executable: the `napi_*` runtime symbols (e.g. `napi_delete_reference`,
    // pulled by `napi::Error`'s `Drop`) are supplied by the Node process at
    // dlopen time, not statically. So any unit test that constructs/drops a
    // `napi::Error` (what `guarded` returns) fails to link. The boundary is
    // instead proven by `tests/smoke_session.mjs` (`__forcePanicForTest` →
    // asserts a `[panic]` JS error is thrown AND the host stays alive + the
    // session remains usable), and the engine-side panic mechanics (FaultGuard +
    // op terminalization) are covered by `ql-exec`'s
    // `run_recalc_panic_terminalizes_op_and_faults_session`.

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

    // **W3 (insert/delete rows & columns):** the `shifted_position` unit tests
    // moved WITH the helper to `ql_exec::structural` (the audited coverage
    // travels with the audited code). See `crates/ql-exec/src/structural.rs`.
}

// ===========================================================================
// Phase 6.1B inc.2d (2026-05-27) — the owning `WorkbookSession` over napi.
//
// The product-neutral `Session` class wraps `ql_exec::WorkbookSession` (the sole
// `ql_session::EngineSession` implementor) so the IDE edit/recalc/snapshot path
// can run through the single-writer owning session instead of the `CollabSession`
// CRDT façade (decision-lock §2 item 3 + risk-mitigation #1). This is the
// engine-side ENABLER; the IDE-side wiring + mocha proof (and the B#1/S2-01
// cross-window tests) are the cross-repo follow-up. The existing `CollabSession`
// class is untouched (collab = v1.5).
//
// All index args are `f64` + manually validated via `validate_u16_index` /
// `validate_u32_index` (the documented Codex-HIGH closure that avoids JS
// `ToUint32` silent coercion — same discipline as `appendPutValue` / `addSheet`).
// Errors map through `engine_error_to_napi` (`EngineError::Display == "[code]
// message"`, mirroring `collab_session_error_to_napi`).
// ===========================================================================

/// JS-facing lightweight sheet descriptor for [`Session::list_sheets`] (no cells).
/// `id` is the u16 `SheetId` widened to u32 (lossless; matches
/// [`SheetSnapshotJson`]'s `id`).
#[napi(object)]
pub struct SheetInfoJson {
    /// Sheet id (u16 widened to u32).
    pub id: u32,
    /// Sheet display name.
    pub name: String,
}

/// **6.3-1c — structured-error reshape (contract §5.1).** Map a structured
/// [`EngineError`] to a NATIVE JS error and throw it: the JS `Error` carries the
/// stable `code`, `class`, `retryable` (+ `details` / `source` when present) as
/// **own data properties**, not parsed from a `[code]`-prefix message.
///
/// **Mechanism (napi-rs 3.9.0):** the `#[napi] -> Result<T>` path can only return
/// the default-`Status` `napi::Error` (no custom `.code`, no extra props). The
/// supported escape hatch is to build the JS error object via [`Env`]
/// ([`throw_structured`]) and `napi_throw` it ourselves, then return
/// `Error::new(Status::PendingException, …)` — napi's `throw_into` short-circuits
/// on `PendingException` (`napi-3.9.0/src/error.rs:488`), so OUR augmented object
/// propagates verbatim, no double-throw.
///
/// **Scope line:** this is for the engine error TAXONOMY (`EngineSession` results
/// — `sheet_not_found`, `conflicting_ops`, `formula_parse`, … which carry real
/// `class`/`details`). FFI-boundary argument validation (`bad_argument` from
/// [`validate_u32_index`] / [`bad_argument_error`]) keeps the existing
/// `[code]`-prefix string — it is uniformly `class=bad_argument` with no details,
/// the IDE's `parseQuantbookError` reads its code from the prefix exactly as
/// today, and collab (`collab_session_error_to_napi`) is unchanged. The IDE reads
/// native fields when present and falls back to the prefix otherwise (dual-format,
/// monotonic — no regression).
///
/// If building/throwing the native object itself fails (a napi-internal failure,
/// not expected), `e` is STILL surfaced loudly via the legacy prefix string — the
/// real error is never swallowed; only its field richness degrades (No-Fallbacks:
/// we degrade richness, never mask a failure).
fn engine_error_to_napi(env: Env, e: EngineError) -> Error {
    match throw_structured(env, &e) {
        Ok(()) => Error::new(Status::PendingException, String::new()),
        // **6.3-1c closure-audit (Codex LOW):** the real error `e` is still
        // surfaced loud via its `[code] message` Display (so `parseQuantbookError`
        // still recovers the code from the prefix); ALSO append the napi-build
        // failure so the binding defect is VISIBLE, not silently dropped (a
        // structured-throw build failure would otherwise be invisible behind a
        // normal-looking prefixed error).
        Err(build_err) => {
            Error::from_reason(format!("{e} [structured-error build failed: {build_err}]"))
        }
    }
}

/// Build the native JS `Error` object for an [`EngineError`] and `napi_throw` it.
/// Augments a real `Error` (so `instanceof Error` + `.cause` walking still hold)
/// with the contract-§5.1 own-properties. `details` is carried as a JSON string
/// (`details`): napi-rs's `serde-json` feature is not enabled in v1, so a native
/// nested object is deferred; the data is delivered losslessly and the IDE parses
/// it on demand. Returns `Err` only if napi object construction fails.
fn throw_structured(env: Env, e: &EngineError) -> Result<()> {
    let mut obj = env.create_error(Error::from_reason(e.message.clone()))?;
    obj.set("code", e.code.as_str())?;
    obj.set("class", class_str(e.class))?;
    obj.set("retryable", e.retryable)?;
    if !e.details.is_empty() {
        // serde_json::to_string of a BTreeMap<String, Value> only fails on a
        // non-serializable value (not possible here); surface loud if it ever does.
        let details_json = serde_json::to_string(&e.details).map_err(|err| {
            Error::from_reason(format!(
                "[panic] EngineError.details serialize failed: {err}"
            ))
        })?;
        obj.set("details", details_json.as_str())?;
    }
    if let Some(src) = &e.source {
        obj.set("source", src.as_str())?;
    }
    env.throw(obj)?;
    Ok(())
}

/// Stable snake_case wire string for an [`ErrorClass`] (mirrors its
/// `#[serde(rename_all = "snake_case")]`); set as the JS error's `.class`.
fn class_str(c: ErrorClass) -> &'static str {
    match c {
        ErrorClass::BadArgument => "bad_argument",
        ErrorClass::Lifecycle => "lifecycle",
        ErrorClass::NotFound => "not_found",
        ErrorClass::Conflict => "conflict",
        ErrorClass::Compute => "compute",
        ErrorClass::Persistence => "persistence",
        ErrorClass::Protocol => "protocol",
        ErrorClass::Canceled => "canceled",
        ErrorClass::Capability => "capability",
        ErrorClass::Internal => "internal",
    }
}

/// **M1 (6.3-1a) — napi panic boundary.** Run a `Session` method body under
/// `catch_unwind` and map a caught panic to a structured `[panic]` engine error.
///
/// napi-rs 3.x does NOT wrap entry points in `catch_unwind` by default, so a Rust
/// panic in the engine (an `assert!`/`unwrap`/`expect`/`panic!` that input
/// pre-validation didn't pre-empt) would otherwise unwind across the generated
/// `extern "C"` trampoline and **abort the IDE host process**. This catches the
/// unwind and returns `EngineError::panic(..)` → `[panic] <method>: <msg>`, so the
/// host keeps running and the IDE sees a recognizable structured error.
///
/// Soundness of `AssertUnwindSafe`: during the unwind the session's own
/// `FaultGuard` (in `ql-exec`) already sealed it `Faulted`, and the napi `Mutex`
/// is `parking_lot` (no poisoning), so the lock is released and the next call
/// observes a consistent (Faulted → `[invalid_state]`) session. We never resume
/// normal logic on a half-updated value — we return an error. The
/// `#[napi(catch_unwind)]` attribute on each method is a belt-and-suspenders
/// backstop for panics in napi-rs's OWN argument marshalling (before this closure
/// runs); THIS helper is what yields the structured `[panic]` code.
fn guarded<R>(env: Env, method: &str, f: impl FnOnce() -> Result<R>) -> Result<R> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => Err(engine_error_to_napi(
            env,
            EngineError::panic(format!(
                "{method}: {}",
                panic_payload_message(payload.as_ref())
            )),
        )),
    }
}

/// Best-effort extraction of a panic's message from its `Box<dyn Any>` payload
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

/// Build a validated [`ql_session::CellAddr`] from raw JS Numbers. `sheet` is a
/// u16 `SheetId`; `row`/`col` are u32 `RowId`/`ColId`. Reuses the same
/// finite/non-negative/integer/in-range validators as the collab append path.
fn session_addr_from_f64(
    method: &str,
    sheet: f64,
    row: f64,
    col: f64,
) -> Result<ql_session::CellAddr> {
    let sheet = validate_u16_index(method, "sheet", sheet)?;
    let row = validate_u32_index(method, "row", row)?;
    let col = validate_u32_index(method, "col", col)?;
    Ok(ql_session::CellAddr { sheet, row, col })
}

/// Map a JS-supplied [`CellValueJson`] to a [`ql_session::CellValue`] for
/// `setValue`. Discriminates on `kind`; the payload field for that kind MUST be
/// present (fail-loud `[bad_argument]` otherwise — No-Fallbacks, no silent
/// default). A `number` must be finite (NaN/Inf rejected). `blank` clears the
/// cell's value. `error`/`pending` are READ-only states (produced by the engine,
/// never set by a caller) → rejected; an unknown `kind` is rejected.
fn session_cell_value_from_json(v: CellValueJson) -> Result<ql_session::CellValue> {
    // **6.3-2 hardening (2026-05-30, megaudit M1):** strict tagged union — each
    // `kind` admits ONLY its own payload. An extraneous-for-kind field (e.g.
    // `{kind:"blank", number:123}` or `{kind:"number", number:1, text:"x"}`) is a
    // malformed DTO and is REJECTED loudly, not silently dropped (No-Fallbacks;
    // same discipline as `session_op_from_json`/`arity_from_json`).
    let CellValueJson {
        kind,
        number,
        boolean,
        text,
        error,
    } = v;
    let reject_extra = |present: bool, field: &str, kind: &str| -> Result<()> {
        if present {
            return Err(bad_argument_error(format!(
                "setValue: value kind '{kind}' must not carry a '{field}' field"
            )));
        }
        Ok(())
    };
    match kind.as_str() {
        "number" => {
            reject_extra(boolean.is_some(), "boolean", "number")?;
            reject_extra(text.is_some(), "text", "number")?;
            reject_extra(error.is_some(), "error", "number")?;
            let n = number.ok_or_else(|| {
                bad_argument_error("setValue: kind 'number' requires a 'number' field".into())
            })?;
            if !n.is_finite() {
                return Err(bad_argument_error(format!(
                    "setValue: number must be finite, got {n}"
                )));
            }
            Ok(ql_session::CellValue::Number { number: n })
        }
        "boolean" => {
            reject_extra(number.is_some(), "number", "boolean")?;
            reject_extra(text.is_some(), "text", "boolean")?;
            reject_extra(error.is_some(), "error", "boolean")?;
            let b = boolean.ok_or_else(|| {
                bad_argument_error("setValue: kind 'boolean' requires a 'boolean' field".into())
            })?;
            Ok(ql_session::CellValue::Boolean { boolean: b })
        }
        "text" => {
            reject_extra(number.is_some(), "number", "text")?;
            reject_extra(boolean.is_some(), "boolean", "text")?;
            reject_extra(error.is_some(), "error", "text")?;
            let t = text.ok_or_else(|| {
                bad_argument_error("setValue: kind 'text' requires a 'text' field".into())
            })?;
            Ok(ql_session::CellValue::Text { text: t })
        }
        "blank" => {
            reject_extra(number.is_some(), "number", "blank")?;
            reject_extra(boolean.is_some(), "boolean", "blank")?;
            reject_extra(text.is_some(), "text", "blank")?;
            reject_extra(error.is_some(), "error", "blank")?;
            Ok(ql_session::CellValue::Blank)
        }
        other => Err(bad_argument_error(format!(
            "setValue: unsupported value kind '{other}' \
             (expected number|boolean|text|blank; 'error'/'pending' are engine-produced, read-only)"
        ))),
    }
}

/// Map a [`ql_session::CellValue`] to the JS [`CellValueJson`] discriminated
/// union (mirrors the `From<CellWireValue>` impl; adds the `blank` kind).
fn cell_value_json_from_session(v: ql_session::CellValue) -> CellValueJson {
    use ql_session::CellValue as V;
    let (kind, number, boolean, text, error) = match v {
        V::Number { number } => ("number", Some(number), None, None, None),
        V::Boolean { boolean } => ("boolean", None, Some(boolean), None, None),
        V::Text { text } => ("text", None, None, Some(text), None),
        V::Error { error } => ("error", None, None, None, Some(error)),
        V::Blank => ("blank", None, None, None, None),
        V::Pending => ("pending", None, None, None, None),
    };
    CellValueJson {
        kind: kind.to_string(),
        number,
        boolean,
        text,
        error,
    }
}

/// Map a [`ql_session::FormatId`] to the JS [`FormatIdJson`] tagged union
/// (mirrors `From<ql_storage::FormatId>`; `ql_session` carries the peer as a
/// raw u64 rather than `PeerId`).
fn format_id_json_from_session(id: ql_session::FormatId) -> FormatIdJson {
    match id {
        ql_session::FormatId::Builtin { builtin } => FormatIdJson {
            kind: "builtin".to_string(),
            builtin: Some(builtin as f64),
            custom_peer: None,
            custom_counter: None,
        },
        ql_session::FormatId::Custom { peer, counter } => FormatIdJson {
            kind: "custom".to_string(),
            builtin: None,
            custom_peer: Some(BigInt::from(peer)),
            custom_counter: Some(counter as f64),
        },
    }
}

/// **Phase 6.3-2a (2026-05-30):** the reverse of [`format_id_json_from_session`]
/// — build a validated [`ql_session::FormatId`] from a JS-supplied
/// [`FormatIdJson`] for `setFormat`. Discriminates on `kind`; the payload field
/// for that kind MUST be present (fail-loud `[bad_argument]` otherwise —
/// No-Fallbacks, no silent default). `custom_peer` is a `BigInt` widened from the
/// engine's `u64` peer id; reject a negative (sign bit) or lossy (> `u64::MAX`)
/// value loud, mirroring the `awaitRecalc`/`pollEvents` BigInt discipline.
fn session_format_id_from_json(id: FormatIdJson) -> Result<ql_session::FormatId> {
    // **6.3-2 hardening (2026-05-30, megaudit H1+M2):** strict tagged union —
    // each `kind` admits ONLY its own payload (an extraneous-for-kind field is a
    // malformed DTO, rejected loudly like `arity_from_json`/`session_op_from_json`,
    // not silently dropped) — AND the numeric payloads (`builtin`/`customCounter`)
    // arrive as `f64` and are validated via `validate_u32_index` rather than letting
    // napi-rs silently `ToUint32`-coerce a malformed JS Number.
    let FormatIdJson {
        kind,
        builtin,
        custom_peer,
        custom_counter,
    } = id;
    match kind.as_str() {
        "builtin" => {
            if custom_peer.is_some() || custom_counter.is_some() {
                return Err(bad_argument_error(
                    "setFormat: format id kind 'builtin' must not carry 'customPeer'/'customCounter'"
                        .into(),
                ));
            }
            let builtin = builtin.ok_or_else(|| {
                bad_argument_error("setFormat: kind 'builtin' requires a 'builtin' field".into())
            })?;
            let builtin = validate_u32_index("setFormat", "builtin", builtin)?;
            Ok(ql_session::FormatId::Builtin { builtin })
        }
        "custom" => {
            if builtin.is_some() {
                return Err(bad_argument_error(
                    "setFormat: format id kind 'custom' must not carry 'builtin'".into(),
                ));
            }
            let peer_bigint = custom_peer.ok_or_else(|| {
                bad_argument_error("setFormat: kind 'custom' requires a 'customPeer' field".into())
            })?;
            let (sign_bit, peer, lossless) = peer_bigint.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "setFormat: customPeer must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "setFormat: customPeer exceeds u64::MAX (lossy conversion rejected)".into(),
                ));
            }
            let counter = custom_counter.ok_or_else(|| {
                bad_argument_error(
                    "setFormat: kind 'custom' requires a 'customCounter' field".into(),
                )
            })?;
            let counter = validate_u32_index("setFormat", "customCounter", counter)?;
            Ok(ql_session::FormatId::Custom { peer, counter })
        }
        other => Err(bad_argument_error(format!(
            "setFormat: unsupported format id kind '{other}' (expected builtin|custom)"
        ))),
    }
}

// ===== FE-4 W4 (2026-06-10): Style DTO conversions (napi ↔ ql_session) =====

/// Map a [`ql_session::StyleId`] to the JS [`StyleIdJson`] (peer widened to
/// BigInt; counter as f64).
fn style_id_json_from_session(id: ql_session::StyleId) -> StyleIdJson {
    StyleIdJson {
        peer: BigInt::from(id.peer),
        counter: id.counter as f64,
    }
}

/// Build a validated [`ql_session::StyleId`] from a JS [`StyleIdJson`]
/// (`setStyle` path). `peer` is a non-negative, lossless `u64`; `counter` is a
/// `u32` validated via [`validate_u32_index`] (No-Fallbacks — no silent
/// coercion). Mirrors the `custom` arm of [`session_format_id_from_json`].
fn session_style_id_from_json(id: StyleIdJson) -> Result<ql_session::StyleId> {
    let StyleIdJson { peer, counter } = id;
    let (sign_bit, peer, lossless) = peer.get_u64();
    if sign_bit {
        return Err(bad_argument_error(
            "setStyle: style id peer must be a non-negative BigInt".into(),
        ));
    }
    if !lossless {
        return Err(bad_argument_error(
            "setStyle: style id peer exceeds u64::MAX (lossy conversion rejected)".into(),
        ));
    }
    let counter = validate_u32_index("setStyle", "counter", counter)?;
    Ok(ql_session::StyleId { peer, counter })
}

/// Validate a single u8 color channel from an f64 (no-coercion discipline).
fn validate_u8_channel(method: &str, name: &str, value: f64) -> Result<u8> {
    let v = validate_u32_index(method, name, value)?;
    if v > u8::MAX as u32 {
        return Err(bad_argument_error(format!(
            "{method}: {name} must be in [0, 255], got {v}"
        )));
    }
    Ok(v as u8)
}

fn rgb_json_from_session(c: ql_session::Rgb) -> RgbJson {
    RgbJson {
        r: c.r as f64,
        g: c.g as f64,
        b: c.b as f64,
    }
}

fn session_rgb_from_json(method: &str, c: RgbJson) -> Result<ql_session::Rgb> {
    Ok(ql_session::Rgb {
        r: validate_u8_channel(method, "color.r", c.r)?,
        g: validate_u8_channel(method, "color.g", c.g)?,
        b: validate_u8_channel(method, "color.b", c.b)?,
    })
}

fn halign_str_from_session(a: ql_session::HAlign) -> &'static str {
    match a {
        ql_session::HAlign::General => "general",
        ql_session::HAlign::Left => "left",
        ql_session::HAlign::Center => "center",
        ql_session::HAlign::Right => "right",
    }
}

fn session_halign_from_str(method: &str, s: &str) -> Result<ql_session::HAlign> {
    match s {
        "general" => Ok(ql_session::HAlign::General),
        "left" => Ok(ql_session::HAlign::Left),
        "center" => Ok(ql_session::HAlign::Center),
        "right" => Ok(ql_session::HAlign::Right),
        other => Err(bad_argument_error(format!(
            "{method}: unsupported align '{other}' (expected general|left|center|right)"
        ))),
    }
}

fn border_style_str_from_session(s: ql_session::BorderStyle) -> &'static str {
    match s {
        ql_session::BorderStyle::None => "none",
        ql_session::BorderStyle::Thin => "thin",
        ql_session::BorderStyle::Medium => "medium",
        ql_session::BorderStyle::Thick => "thick",
        ql_session::BorderStyle::Dashed => "dashed",
        ql_session::BorderStyle::Dotted => "dotted",
        ql_session::BorderStyle::Double => "double",
    }
}

fn session_border_style_from_str(method: &str, s: &str) -> Result<ql_session::BorderStyle> {
    match s {
        "none" => Ok(ql_session::BorderStyle::None),
        "thin" => Ok(ql_session::BorderStyle::Thin),
        "medium" => Ok(ql_session::BorderStyle::Medium),
        "thick" => Ok(ql_session::BorderStyle::Thick),
        "dashed" => Ok(ql_session::BorderStyle::Dashed),
        "dotted" => Ok(ql_session::BorderStyle::Dotted),
        "double" => Ok(ql_session::BorderStyle::Double),
        other => Err(bad_argument_error(format!(
            "{method}: unsupported border style '{other}' \
             (expected none|thin|medium|thick|dashed|dotted|double)"
        ))),
    }
}

fn border_edge_json_from_session(e: ql_session::BorderEdge) -> BorderEdgeJson {
    BorderEdgeJson {
        style: border_style_str_from_session(e.style).to_string(),
        color: rgb_json_from_session(e.color),
    }
}

/// Convert an optional JS border edge → DTO. Absent ⇒ a no-border edge (the
/// `BorderEdge::default()` equivalent).
fn session_border_edge_from_json(
    method: &str,
    e: Option<BorderEdgeJson>,
) -> Result<ql_session::BorderEdge> {
    match e {
        None => Ok(ql_session::BorderEdge::default()),
        Some(e) => Ok(ql_session::BorderEdge {
            style: session_border_style_from_str(method, &e.style)?,
            color: session_rgb_from_json(method, e.color)?,
        }),
    }
}

fn style_json_from_session(s: ql_session::Style) -> StyleJson {
    StyleJson {
        bold: s.bold,
        italic: s.italic,
        // FE-7: absent-when-off (mirrors style_json_from_storage).
        underline: if s.underline { Some(true) } else { None },
        strike: if s.strike { Some(true) } else { None },
        fill: s.fill.map(rgb_json_from_session),
        text_color: s.text_color.map(rgb_json_from_session),
        align: Some(halign_str_from_session(s.align).to_string()),
        border_top: Some(border_edge_json_from_session(s.borders.top)),
        border_bottom: Some(border_edge_json_from_session(s.borders.bottom)),
        border_left: Some(border_edge_json_from_session(s.borders.left)),
        border_right: Some(border_edge_json_from_session(s.borders.right)),
    }
}

/// Build a validated [`ql_session::Style`] from a JS [`StyleJson`]
/// (`registerStyle` path). Absent optional fields default to no-fill /
/// general / no-border (No-Fallbacks: present-but-malformed values throw).
fn session_style_from_json(method: &str, s: StyleJson) -> Result<ql_session::Style> {
    let fill = match s.fill {
        None => None,
        Some(c) => Some(session_rgb_from_json(method, c)?),
    };
    // FE-7: text_color mirrors fill's validate-or-error (No-Fallbacks —
    // present-but-malformed RGB throws, absent ⇒ None).
    let text_color = match s.text_color {
        None => None,
        Some(c) => Some(session_rgb_from_json(method, c)?),
    };
    let align = match s.align.as_deref() {
        None => ql_session::HAlign::General,
        Some(a) => session_halign_from_str(method, a)?,
    };
    Ok(ql_session::Style {
        bold: s.bold,
        italic: s.italic,
        // FE-7: absent ⇒ off (optional input, like fill ⇒ no-fill). Not a masking
        // fallback — an omitted optional field is a legitimate "off" state, not a swallowed error.
        underline: s.underline.unwrap_or(false),
        strike: s.strike.unwrap_or(false),
        fill,
        text_color,
        align,
        borders: ql_session::Borders {
            top: session_border_edge_from_json(method, s.border_top)?,
            bottom: session_border_edge_from_json(method, s.border_bottom)?,
            left: session_border_edge_from_json(method, s.border_left)?,
            right: session_border_edge_from_json(method, s.border_right)?,
        },
    })
}

fn style_def_json_from_session(sd: ql_session::StyleDef) -> StyleDefJson {
    StyleDefJson {
        id: style_id_json_from_session(sd.id),
        style: style_json_from_session(sd.style),
    }
}

/// **Phase 6.3-2a (2026-05-30):** build a validated [`ql_session::CellRange`]
/// from a JS-supplied [`CellRangeJson`] for `queryRange`. `sheet` is a `u16`
/// `SheetId`; the four bounds are `u32` `RowId`/`ColId` — same
/// finite/non-negative/integer/in-range validators as [`session_addr_from_f64`].
/// (Inverted bounds — `end < start` — are the engine's `bad_argument` to reject,
/// not the binding's, so they reach `query_range` verbatim.)
fn session_range_from_json(method: &str, range: CellRangeJson) -> Result<ql_session::CellRange> {
    let sheet = validate_u16_index(method, "sheet", range.sheet)?;
    let start_row = validate_u32_index(method, "startRow", range.start_row)?;
    let start_col = validate_u32_index(method, "startCol", range.start_col)?;
    let end_row = validate_u32_index(method, "endRow", range.end_row)?;
    let end_col = validate_u32_index(method, "endCol", range.end_col)?;
    Ok(ql_session::CellRange {
        sheet,
        start_row,
        start_col,
        end_row,
        end_col,
    })
}

/// **Phase 6.3-2d:** convert a JS [`TableSpecJson`] into an engine
/// [`ql_session::TableSpec`], validating coords/dimensions to `u16`/`u32` at the
/// boundary (mirrors `session_range_from_json`). `rows`/`cols` are validated only
/// as u32 (the validator permits `0`); the engine enforces the `> 0` invariant and
/// the `columnNames`-length / uniqueness rules, surfacing `[table_create_rejected]`.
fn session_table_spec_from_json(
    method: &str,
    spec: TableSpecJson,
) -> Result<ql_session::TableSpec> {
    let sheet = validate_u16_index(method, "sheet", spec.sheet)?;
    let top_row = validate_u32_index(method, "topRow", spec.top_row)?;
    let top_col = validate_u32_index(method, "topCol", spec.top_col)?;
    let rows = validate_u32_index(method, "rows", spec.rows)?;
    let cols = validate_u32_index(method, "cols", spec.cols)?;
    // **6.3-5 (MED-2):** `columnNames` is required — a MISSING field surfaces
    // structured `[bad_argument]` (like the pyo3 `req_str_list`), not a generic
    // napi-deserialize `Status` error.
    let column_names = spec.column_names.ok_or_else(|| {
        bad_argument_error(format!("{method}: spec requires a 'columnNames' field"))
    })?;
    Ok(ql_session::TableSpec {
        name: spec.name,
        sheet,
        top_row,
        top_col,
        rows,
        cols,
        has_header: spec.has_header,
        has_totals: spec.has_totals,
        column_names,
    })
}

/// **Phase 6.3-2e (2026-05-30):** convert a JS [`SessionOpJson`] (a `kind`-tagged
/// union) into an engine [`ql_session::SessionOp`]. Strict like [`arity_from_json`]:
/// each `kind` requires its own payload (`setValue`→`value`, `setFormula`→`text`,
/// `setFormat`→`format`, `clear`→none) and a missing payload or unknown `kind` is a
/// loud `[bad_argument]` (No-Fallbacks — a malformed op is never normalized away).
/// The address is always validated via [`session_addr_from_f64`].
fn session_op_from_json(method: &str, op: SessionOpJson) -> Result<ql_session::session::SessionOp> {
    use ql_session::session::SessionOp;
    let addr = session_addr_from_f64(method, op.sheet, op.row, op.col)?;
    // Strict tagged union (mirrors `arity_from_json`): each `kind` admits ONLY its
    // own payload. An extraneous-for-kind field (e.g. a `clear` carrying `value`) is
    // a malformed DTO and is REJECTED loudly, not silently dropped (No-Fallbacks).
    let SessionOpJson {
        kind,
        value,
        text,
        format,
        style,
        ..
    } = op;
    let reject_extra = |present: bool, field: &str, kind: &str| -> Result<()> {
        if present {
            return Err(bad_argument_error(format!(
                "{method}: SessionOp kind '{kind}' must not carry a '{field}' field"
            )));
        }
        Ok(())
    };
    match kind.as_str() {
        "setValue" => {
            reject_extra(text.is_some(), "text", "setValue")?;
            reject_extra(format.is_some(), "format", "setValue")?;
            reject_extra(style.is_some(), "style", "setValue")?;
            let value = value.ok_or_else(|| {
                bad_argument_error(format!(
                    "{method}: SessionOp kind 'setValue' requires a 'value' field"
                ))
            })?;
            let value = session_cell_value_from_json(value)?;
            Ok(SessionOp::SetValue { addr, value })
        }
        "setFormula" => {
            reject_extra(value.is_some(), "value", "setFormula")?;
            reject_extra(format.is_some(), "format", "setFormula")?;
            reject_extra(style.is_some(), "style", "setFormula")?;
            let text = text.ok_or_else(|| {
                bad_argument_error(format!(
                    "{method}: SessionOp kind 'setFormula' requires a 'text' field"
                ))
            })?;
            Ok(SessionOp::SetFormula { addr, text })
        }
        "clear" => {
            reject_extra(value.is_some(), "value", "clear")?;
            reject_extra(text.is_some(), "text", "clear")?;
            reject_extra(format.is_some(), "format", "clear")?;
            reject_extra(style.is_some(), "style", "clear")?;
            Ok(SessionOp::Clear { addr })
        }
        "setFormat" => {
            reject_extra(value.is_some(), "value", "setFormat")?;
            reject_extra(text.is_some(), "text", "setFormat")?;
            reject_extra(style.is_some(), "style", "setFormat")?;
            let format = format.ok_or_else(|| {
                bad_argument_error(format!(
                    "{method}: SessionOp kind 'setFormat' requires a 'format' field"
                ))
            })?;
            let format = session_format_id_from_json(format)?;
            Ok(SessionOp::SetFormat { addr, format })
        }
        // **FE-4 W4 (2026-06-10):** the cell-style op (mirrors setFormat).
        "setStyle" => {
            reject_extra(value.is_some(), "value", "setStyle")?;
            reject_extra(text.is_some(), "text", "setStyle")?;
            reject_extra(format.is_some(), "format", "setStyle")?;
            let style = style.ok_or_else(|| {
                bad_argument_error(format!(
                    "{method}: SessionOp kind 'setStyle' requires a 'style' field"
                ))
            })?;
            let style = session_style_id_from_json(style)?;
            Ok(SessionOp::SetStyle { addr, style })
        }
        other => Err(bad_argument_error(format!(
            "{method}: unknown SessionOp kind '{other}' \
             (expected setValue|setFormula|clear|setFormat|setStyle)"
        ))),
    }
}

/// **Phase 6.3-2e (2026-05-30):** BigInt → [`ql_session::TransactionId`] (`u64`),
/// rejecting a negative (sign bit) or lossy (> u64::MAX) value loudly per
/// No-Fallbacks — the same discipline as `awaitRecalc`'s `OperationId` conversion.
fn transaction_id_from_bigint(
    method: &str,
    txn: BigInt,
) -> Result<ql_session::session::TransactionId> {
    let (sign_bit, raw, lossless) = txn.get_u64();
    if sign_bit {
        return Err(bad_argument_error(format!(
            "{method}: txn must be a non-negative BigInt"
        )));
    }
    if !lossless {
        return Err(bad_argument_error(format!(
            "{method}: txn exceeds u64::MAX (lossy conversion rejected)"
        )));
    }
    Ok(ql_session::session::TransactionId(raw))
}

/// **Phase 6.3-2e (2026-05-30):** parse a section-3.5 `data` payload (a JSON
/// string — the napi `serde-json` feature is not enabled, so opaque JSON crosses the
/// boundary as text, mirroring the 6.3-1c `details` convention). Invalid JSON is a
/// loud `[bad_argument]`. Used only by the reserved `publishDataset`/`materializeQuery`
/// forwarders, which then surface `not_implemented_in_v1_core`.
fn parse_reserved_json_payload(method: &str, data: &str) -> Result<serde_json::Value> {
    serde_json::from_str(data)
        .map_err(|e| bad_argument_error(format!("{method}: data must be valid JSON text ({e})")))
}

/// **Phase 6.3-2a (2026-05-30):** stable snake_case wire string for a
/// [`ql_session::LifecycleState`] (mirrors `#[serde(rename_all = "snake_case")]`
/// — though the enum is read via this helper, not serde) — the value returned by
/// `lifecycleState()`. The single source of truth for the lifecycle wire strings
/// + the IDE `QuantbookLifecycleState` union.
fn lifecycle_state_str(s: ql_session::LifecycleState) -> &'static str {
    use ql_session::LifecycleState as L;
    match s {
        L::New => "new",
        L::Ready => "ready",
        L::Busy => "busy",
        L::Closed => "closed",
        L::Faulted => "faulted",
    }
}

/// **Phase 6.3-2a (2026-05-30):** map a [`ql_session::RangeResult`] to the JS
/// [`RangeResultJson`] (columnar). Forwards the engine DTO's own `schema_version`
/// (single source of truth, §4b) and maps each `CellValue` via the existing
/// [`cell_value_json_from_session`] (which already emits `blank`/`pending`).
fn range_result_json_from_session(r: ql_session::RangeResult) -> RangeResultJson {
    RangeResultJson {
        schema_version: r.schema_version,
        range: CellRangeJson {
            sheet: f64::from(r.range.sheet),
            start_row: f64::from(r.range.start_row),
            start_col: f64::from(r.range.start_col),
            end_row: f64::from(r.range.end_row),
            end_col: f64::from(r.range.end_col),
        },
        n_rows: r.n_rows,
        n_cols: r.n_cols,
        columns: r
            .columns
            .into_iter()
            .map(|c| RangeColumnJson {
                values: c
                    .values
                    .into_iter()
                    .map(cell_value_json_from_session)
                    .collect(),
            })
            .collect(),
    }
}

/// Map a [`ql_session::CellSnapshot`] to the JS [`CellSnapshotJson`].
fn cell_snapshot_json_from_session(c: ql_session::CellSnapshot) -> CellSnapshotJson {
    CellSnapshotJson {
        row: c.row,
        col: c.col,
        value: c.value.map(cell_value_json_from_session),
        formula: c.formula,
        format: c.format.map(format_id_json_from_session),
        // FE-4 W4: the cell-style id passthrough (owning-Session path).
        style_id: c.style.map(style_id_json_from_session),
        rendered: c.rendered,
    }
}

/// Map a [`ql_session::SheetSnapshot`] to the JS [`SheetSnapshotJson`].
fn sheet_snapshot_json_from_session(s: ql_session::SheetSnapshot) -> SheetSnapshotJson {
    SheetSnapshotJson {
        id: u32::from(s.id),
        name: s.name,
        cells: s
            .cells
            .into_iter()
            .map(cell_snapshot_json_from_session)
            .collect(),
    }
}

/// Map a [`ql_session::WorkbookSnapshot`] to the JS [`WorkbookSnapshotJson`].
/// The opaque `version` token round-trips verbatim as a `Buffer` (contract §4.0
/// — callers MUST NOT interpret it).
fn workbook_snapshot_json_from_session(snap: ql_session::WorkbookSnapshot) -> WorkbookSnapshotJson {
    let date_system = match snap.date_system {
        ql_session::DateSystem::Excel1900 => "Excel1900",
        ql_session::DateSystem::Excel1904 => "Excel1904",
    };
    WorkbookSnapshotJson {
        sheets: snap
            .sheets
            .into_iter()
            .map(sheet_snapshot_json_from_session)
            .collect(),
        formats: snap
            .formats
            .into_iter()
            .map(|fd| FormatDefJson {
                id: format_id_json_from_session(fd.id),
                string: fd.string,
            })
            .collect(),
        // FE-4 W4: the session-wide style table.
        styles: snap
            .styles
            .into_iter()
            .map(style_def_json_from_session)
            .collect(),
        date_system: date_system.to_string(),
        version: Buffer::from(snap.version.0),
        // 6.3-1c M5: forward the engine snapshot's own schema_version (contract
        // §4.1) rather than re-deriving — single source of truth on the DTO.
        schema_version: snap.schema_version,
        // FE-5 W-N: defined names (both scopes; already sorted engine-side).
        names: snap
            .names
            .into_iter()
            .map(named_range_json_from_session)
            .collect(),
        // Builder E (2026-06-13): structured tables (all sheets; already sorted
        // engine-side by collect_tables).
        tables: snap
            .tables
            .into_iter()
            .map(table_snapshot_json_from_session)
            .collect(),
    }
}

/// **Phase 6.3-3 (2026-05-30):** map the owning-`Session` engine delta
/// [`ql_session::WorkbookSnapshotDelta`] to the JS [`WorkbookSnapshotDeltaJson`]
/// (the `snapshotDelta` return). Mirrors [`workbook_snapshot_json_from_session`]
/// and reuses its sub-converters; forwards the engine delta's own
/// `schema_version` (M5 — NOT re-derived) and maps `full_rebuild_reason` via
/// [`full_rebuild_reason_str`]. NOTE: this is the engine `EngineSession` delta
/// path — distinct from the legacy `CollabSession` CRDT delta builder (which uses
/// `empty_delta` + the loro version-vector). `version` round-trips verbatim as a
/// `Buffer`; the caller stores it for the next `snapshotDelta`.
fn workbook_snapshot_delta_json_from_session(
    delta: ql_session::WorkbookSnapshotDelta,
) -> WorkbookSnapshotDeltaJson {
    WorkbookSnapshotDeltaJson {
        changed_cells: delta
            .changed_cells
            .into_iter()
            .map(|c| ChangedCellJson {
                sheet: u32::from(c.sheet),
                cell: cell_snapshot_json_from_session(c.cell),
            })
            .collect(),
        removed_cells: delta
            .removed_cells
            .into_iter()
            .map(|r| RemovedCellJson {
                sheet: u32::from(r.sheet),
                row: r.row,
                col: r.col,
            })
            .collect(),
        sheets_changed: delta
            .sheets_changed
            .into_iter()
            .map(sheet_snapshot_json_from_session)
            .collect(),
        sheets_removed: delta.sheets_removed.into_iter().map(u32::from).collect(),
        formats_added: delta
            .formats_added
            .into_iter()
            .map(|fd| FormatDefJson {
                id: format_id_json_from_session(fd.id),
                string: fd.string,
            })
            .collect(),
        // FE-4 W4: styles registered since lastSeenVersion.
        styles_added: delta
            .styles_added
            .into_iter()
            .map(style_def_json_from_session)
            .collect(),
        version: Buffer::from(delta.version.0),
        full_rebuild_required: delta.full_rebuild_required,
        full_rebuild_reason: delta
            .full_rebuild_reason
            .map(|r| full_rebuild_reason_str(r).to_string()),
        schema_version: delta.schema_version,
    }
}

// ============================================================================
// 6.4-2 (2026-05-28) — function-metadata DTOs over napi.
//
// Mirrors `ql_session::function_meta::FunctionMetadata` for the JS surface.
// String-discriminated enums match the engine's `#[serde(rename_all =
// "snake_case")]` serialization (so the wire bytes are stable if the IDE ever
// round-trips through JSON). Unknown JS-input strings surface as
// `[bad_argument]` engine-shaped errors (No-Fallbacks; never a silent default).
//
// `Arity` is a tagged union: `kind: "fixed" | "range" | "variadic"` plus
// per-variant fields (`n` / `min` / `max`). napi-rs doesn't support `enum`
// over the boundary, so the tagged-union pattern (same as `CellValueJson`)
// is the canonical shape.
// ============================================================================

/// **6.4-2:** JS-facing `Arity` mirror — a strict tagged union on `kind`.
///
/// - `"fixed"` requires `n`, and must NOT carry `min`/`max`.
/// - `"range"` requires `min`, optionally `max` (absent ≡ unbounded), and must
///   NOT carry `n`; `max` (when present) must be `>= min`.
/// - `"variadic"` carries no payload (`n`/`min`/`max` must all be absent).
///
/// Any mismatch — wrong/extraneous field, missing required field, inverted
/// range, or out-of-`u8`-range value — surfaces `[bad_argument]` (No-Fallbacks;
/// 6.4-2 cycle-2 audit-fix F3 hardened the extraneous-field cases).
///
/// **`null` vs `undefined` (6.4-2 cycle-2 audit-fix F4):** optional fields use
/// napi `Option<f64>`, which maps a MISSING/`undefined` JS field to `None`.
/// Passing an explicit JS `null` triggers a generated napi `NumberExpected`
/// conversion error BEFORE this mapper runs — so callers MUST OMIT optional
/// fields (or set them `undefined`), not pass `null`. e.g. an unbounded range is
/// `{kind:"range", min:1}` (omit `max`), never `{..., max:null}`.
///
/// **6.3-2 hardening (2026-05-30, megaudit H2):** `n`/`min`/`max` are typed
/// `Option<f64>` (not `Option<u32>`) so a malformed JS Number reaches
/// `arity_from_json` UN-coerced and is validated via [`validate_u32_index`]
/// before the `u8` cast — a `u32` field would let napi-rs silently `ToUint32`
/// `2.9`->2 / `NaN`->0 into a valid-looking arity. Engine-produced values are
/// whole `u8`s.
#[napi(object)]
pub struct ArityJson {
    pub kind: String,
    pub n: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// **6.4-2:** JS-facing `FunctionMetadata` mirror. All fields are flat
/// primitives or strings (per `#[serde(rename_all = "snake_case")]` on the
/// engine enums); the `Arity` is the only nested union (see [`ArityJson`]).
///
/// **String-enum policy:**
/// - `volatility`: `"pure" | "volatile" | "dynamic"`.
/// - `dep_shape`: `"value_deps" | "address_only" | "lazy_shape" | "custom"`.
/// - `batch_shape`: `"scalar" | "array_batch"`.
/// - `arg_policy`: `"strict" | "coercing"`.
/// - `cancellation`: `"cooperative" | "worker_kill" | "non_cancelable"`.
/// - `arg_context`: `"scalar" | "aggregate" | "reference"`.
///
/// Unknown strings on JS→Rust input fail loud with `[bad_argument]`.
///
/// **6.3-5 (MED-2):** `aliases` / `provenanceTags` are modeled as
/// `Option<Vec<String>>` (not bare `Vec<String>`) so a MISSING field surfaces the
/// project's structured `[bad_argument]` (via the explicit presence check in
/// `function_metadata_from_json`) rather than a generic napi-rs deserialize
/// `Status` error — matching the pyo3 `req_str_list` reject-missing behavior. An
/// explicit `null` is also rejected (napi-rs treats a present `null` as `None`,
/// indistinguishable from missing — both fail loud). On the OUTPUT side
/// (`function_metadata_to_json`) both are always emitted as a present array.
#[napi(object)]
pub struct FunctionMetadataJson {
    pub canonical_name: String,
    pub display_name: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub arity: ArityJson,
    pub volatility: String,
    pub determinism: bool,
    pub dep_shape: String,
    pub batch_shape: String,
    pub arg_policy: String,
    pub cancellation: String,
    pub arg_context: String,
    pub provenance_tags: Option<Vec<String>>,
}

/// **6.4-3d (2026-05-29):** config for the out-of-process Python-UDF worker the
/// IDE injects via [`Session::set_udf_worker`]. Mirrors
/// [`ql_udf::PythonWorkerConfig`]; the IDE resolves these from
/// trusted-workspace config (`quantlab.pythonPath` cascade + the workspace UDF
/// dir). Optional fields fall back to the engine defaults (module
/// `"quantbook.worker"`, 5s handshake, current protocol version, no extra
/// `PYTHONPATH` / udf module). Per napi-rs, OMIT optional fields (undefined) —
/// do not pass `null`.
#[napi(object)]
pub struct PythonWorkerConfigJson {
    /// Absolute path to the Python interpreter to launch (required).
    pub python: String,
    /// The `-m` module that runs the worker loop. Defaults to `"quantbook.worker"`.
    pub module: Option<String>,
    /// Directories prepended to `PYTHONPATH` (the worker module + `quantbook`
    /// package must resolve). Typically the engine's `quantbook-py/python` plus
    /// the workspace UDF dir.
    pub pythonpath: Option<Vec<String>>,
    /// The trusted user module the worker imports to register UDFs by handle
    /// (passed as `QUANTBOOK_UDF_MODULE`).
    pub udf_module: Option<String>,
    /// Handshake timeout in milliseconds (HELLO_ACK wait). Defaults to 5000.
    pub handshake_timeout_ms: Option<f64>,
}

// ============================================================================
// 6.4-3d Step 5 (2026-05-29) — event-stream DTOs (`pollEvents`).
//
// The engine's `Event` ring (contract §9) is surfaced to JS so `CellDiagnostic`
// (the UDF no-worker / raised / timeout / died sink shipped in 6.4-3d Steps 1-3)
// reaches the IDE — without it the IDE can render `#CALC!` but not WHY. Every
// `Event` variant is modeled faithfully (No-Fallbacks: no variant is silently
// dropped). napi-rs camelCases the object field names (e.g. `next_cursor` →
// `nextCursor`, `structure_kind` → `structureKind`).
// ============================================================================

/// JS-facing cell address (mirrors [`ql_session::CellAddr`]); `sheet` widened
/// u16→u32 (lossless), `row`/`col` are the 0-indexed u32 ids.
#[napi(object)]
pub struct CellAddrJson {
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
}

/// JS-facing per-cell diagnostic (mirrors [`ql_session::Diagnostic`]).
/// `severity` is `"info"` | `"warning"` | `"error"`; `addr` is absent for a
/// workbook-level diagnostic.
#[napi(object)]
pub struct DiagnosticJson {
    pub addr: Option<CellAddrJson>,
    pub severity: String,
    pub code: String,
    pub message: String,
}

/// **6.3-5 (MED-5):** JS-facing structured operation error — the NESTED object
/// carried by [`OperationStateJson::error`] when `state == "failed"`. Mirrors the
/// contract-§5.1 [`ql_session::error::EngineError`] shape (the same fields
/// `throw_structured` sets on a thrown native error): `code`/`class`/`retryable`
/// always present; `details` (a JSON string, like the main error channel) +
/// `source` present only when non-empty. This RETIRES the `[code] message` string
/// anti-pattern the main error channel already dropped (6.3-1c) — a Failed op now
/// carries the same structured shape, not a code-prefixed display string.
#[napi(object)]
pub struct OperationErrorJson {
    pub code: String,
    pub class: String,
    pub retryable: bool,
    pub details: Option<String>,
    pub source: Option<String>,
}

/// JS-facing operation state (mirrors [`ql_session::OperationState`]).
/// `state` is `"running"` | `"completed"` | `"canceled"` | `"failed"`; `error`
/// carries the structured [`OperationErrorJson`] ONLY when `state == "failed"`.
#[napi(object)]
pub struct OperationStateJson {
    pub state: String,
    pub error: Option<OperationErrorJson>,
}

/// **Phase 6.3-2a (2026-05-30):** JS-facing rectangular range (mirrors
/// [`ql_session::CellRange`]). All five coordinates are JS Numbers, validated to
/// `u16`/`u32` at the boundary (same finite/non-negative/integer/in-range
/// discipline as [`CellAddrJson`]); `sheet` is a `u16` `SheetId`,
/// `start*`/`end*` are `u32` `RowId`/`ColId`. Inclusive bounds.
#[napi(object)]
pub struct CellRangeJson {
    pub sheet: f64,
    pub start_row: f64,
    pub start_col: f64,
    pub end_row: f64,
    pub end_col: f64,
}

/// **Phase 6.3-2d (2026-05-30):** spec for `createTable` (mirrors
/// [`ql_session::TableSpec`]). `sheet`/`topRow`/`topCol`/`rows`/`cols` are JS
/// Numbers validated to `u16`/`u32` at the boundary (same
/// finite/non-negative/integer/in-range discipline as [`CellRangeJson`]); `sheet`
/// is a `u16` `SheetId`, `top*` are `u32` `RowId`/`ColId`, `rows`/`cols` are u32
/// counts (the engine requires both `> 0` — a `0` reaches the engine and surfaces
/// `[table_create_rejected]`, not a boundary `[bad_argument]`). `columnNames`
/// length must match `cols`. The name is canonicalized (uppercase) by the engine.
///
/// **6.3-5 (MED-2):** `columnNames` is `Option<Vec<String>>` (not bare
/// `Vec<String>`) so a MISSING field surfaces the project's structured
/// `[bad_argument]` (via the explicit presence check in
/// `session_table_spec_from_json`) rather than a generic napi-rs deserialize
/// `Status` error — matching the pyo3 `req_str_list` reject-missing behavior.
#[napi(object)]
pub struct TableSpecJson {
    pub name: String,
    pub sheet: f64,
    pub top_row: f64,
    pub top_col: f64,
    pub rows: f64,
    pub cols: f64,
    pub has_header: bool,
    pub has_totals: bool,
    pub column_names: Option<Vec<String>>,
}

/// **Phase 6.3-2e (2026-05-30):** one op in a `batch`/transaction (a `kind`-tagged
/// mirror of the 4-variant [`ql_session::SessionOp`]). Exactly one payload field is
/// required per `kind`: `setValue`→`value`, `setFormula`→`text`, `setFormat`→`format`,
/// `clear`→none. `sheet`/`row`/`col` are JS Numbers validated to `u16`/`u32` at the
/// boundary (same discipline as `setValue`). Converted by `session_op_from_json`.
#[napi(object)]
pub struct SessionOpJson {
    pub kind: String,
    pub sheet: f64,
    pub row: f64,
    pub col: f64,
    pub value: Option<CellValueJson>,
    pub text: Option<String>,
    pub format: Option<FormatIdJson>,
    /// **FE-4 W4 (2026-06-10):** required for `kind == "setStyle"`; the
    /// registered style id to bind (from `registerStyle`).
    pub style: Option<StyleIdJson>,
}

/// **Phase 6.3-2e (2026-05-30):** options for `batch` (mirrors
/// [`ql_session::BatchOptions`]). `undoLabel` groups the batch under a named undo unit.
#[napi(object)]
pub struct BatchOptionsJson {
    pub undo_label: Option<String>,
}

/// **Phase 6.3-2e (2026-05-30):** result of a `batch`/`commitTransaction` (mirrors
/// [`ql_session::BatchResult`]). `applied` is the op count; `version` is the opaque
/// post-batch [`ql_session::SessionVersion`] as a `Buffer` (round-trip it into the
/// next `snapshotDelta`, exactly like `WorkbookSnapshotJson.version`).
#[napi(object)]
pub struct BatchResultJson {
    pub applied: f64,
    pub version: Buffer,
}

/// **Phase 6.5-4:** result of `writeRange` (mirrors [`ql_session::WriteRangeResult`]).
/// `written` is the cell count; `version` is the opaque post-write version token as a
/// `Buffer` (same semantics as `BatchResultJson.version`).
#[napi(object)]
pub struct WriteRangeResultJson {
    pub written: f64,
    pub version: Buffer,
}

/// **Phase 6.5-4:** result of `refreshSource` (mirrors [`ql_session::DirtyResult`]).
/// `dirtied` is the number of dependent cells dirtied; `version` is the opaque
/// post-refresh version token as a `Buffer`.
#[napi(object)]
pub struct DirtyResultJson {
    pub dirtied: f64,
    pub version: Buffer,
}

/// **Phase 6.5-4:** reference to a published/materialized artifact (mirrors
/// [`ql_session::PublishedRef`]). `id` is the stable artifact id (the caller's
/// `queryId` / `name` echoed back).
#[napi(object)]
pub struct PublishedRefJson {
    pub id: String,
}

/// **ENG-FUSION:** a bound overlay range (mirrors [`ql_session::BoundRange`]).
/// `bindingId` is the stable binding id (the caller's id echoed back).
#[napi(object)]
pub struct BoundRangeJson {
    pub binding_id: String,
}

/// **Phase 6.3-2a (2026-05-30):** which extras a `queryRange` read includes
/// (mirrors [`ql_session::RangeQueryOptions`]). In v1 the engine fail-loud
/// rejects any `true` here with `not_implemented_in_v1_core` (the columnar value
/// read is the v1 surface); declared now for forward-compatible field-parity.
#[napi(object)]
pub struct RangeQueryOptionsJson {
    pub include_formulas: bool,
    pub include_formats: bool,
    pub include_rendered: bool,
}

/// **Phase 6.3-2a (2026-05-30):** one column of a [`RangeResultJson`] (columnar
/// layout; mirrors [`ql_session::RangeColumn`]). `values` is top-to-bottom and
/// has length `RangeResultJson.n_rows`; each entry is the same discriminated
/// [`CellValueJson`] as elsewhere (incl. `blank` for an empty cell and `pending`
/// for a not-yet-computed one).
#[napi(object)]
pub struct RangeColumnJson {
    pub values: Vec<CellValueJson>,
}

/// **Phase 6.3-2a (2026-05-30):** a batch-shaped columnar range read (mirrors
/// [`ql_session::RangeResult`]). `columns` has length `n_cols`; each column has
/// length `n_rows`. **§4b field-parity:** carries `schema_version` (forwarded
/// from the engine DTO, contract §4.1) — the IDE asserts it at ingest.
#[napi(object)]
pub struct RangeResultJson {
    pub schema_version: u16,
    pub range: CellRangeJson,
    pub n_rows: u32,
    pub n_cols: u32,
    pub columns: Vec<RangeColumnJson>,
}

/// JS-facing event (mirrors [`ql_session::session::Event`]). A tagged union: the
/// `kind` discriminator selects which optional payload fields are populated —
/// the same shape discipline as [`CellValueJson`]. Variant → fields:
/// - `"recalc_progress"`: `op`, `done`, `total`
/// - `"cell_diagnostic"`: `diagnostic`
/// - `"operation_completed"`: `op`, `state`
/// - `"provenance"`: `addr`, `source`
/// - `"structure_changed"`: `structureKind`, `target`
/// - `"full_resync_required"`: (no payload — the consumer must reseed via
///   `snapshot()`, contract §9)
#[napi(object)]
pub struct EventJson {
    pub kind: String,
    /// `recalc_progress` / `operation_completed`: the operation id.
    pub op: Option<BigInt>,
    /// `recalc_progress`: nodes done so far.
    pub done: Option<BigInt>,
    /// `recalc_progress`: total nodes.
    pub total: Option<BigInt>,
    /// `cell_diagnostic`: the diagnostic.
    pub diagnostic: Option<DiagnosticJson>,
    /// `operation_completed`: the terminal state.
    pub state: Option<OperationStateJson>,
    /// `provenance`: the cell the provenance applies to.
    pub addr: Option<CellAddrJson>,
    /// `provenance`: the source descriptor.
    pub source: Option<String>,
    /// `structure_changed`: the structure kind (`"sheet"`/`"table"`/`"name"`).
    /// (`kind` is taken by the discriminator, hence `structureKind` in JS.)
    pub structure_kind: Option<String>,
    /// `structure_changed`: the affected target id/name.
    pub target: Option<String>,
}

/// JS-facing page of events read from a cursor (mirrors
/// [`ql_session::session::EventPage`]). Reading does NOT drain the ring; pass
/// `nextCursor` to the next `pollEvents` call. `dropped == true` pairs with a
/// `full_resync_required` event — the consumer fell behind the retention
/// horizon and MUST reseed via `snapshot()` (v1 uses an unbounded ring, so this
/// never fires yet).
#[napi(object)]
pub struct EventPageJson {
    pub events: Vec<EventJson>,
    pub next_cursor: BigInt,
    pub dropped: bool,
}

fn severity_to_str(s: ql_session::Severity) -> &'static str {
    use ql_session::Severity;
    match s {
        Severity::Info => "info",
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}

fn cell_addr_json_from_session(a: ql_session::CellAddr) -> CellAddrJson {
    CellAddrJson {
        sheet: u32::from(a.sheet),
        row: a.row,
        col: a.col,
    }
}

fn diagnostic_json_from_session(d: ql_session::Diagnostic) -> DiagnosticJson {
    DiagnosticJson {
        addr: d.addr.map(cell_addr_json_from_session),
        severity: severity_to_str(d.severity).to_string(),
        code: d.code,
        message: d.message,
    }
}

/// Map an [`ql_session::OperationState`] to its JS DTO. **6.3-5 (MED-5):** the
/// `Failed` error is rendered as a NESTED structured [`OperationErrorJson`]
/// `{code, class, retryable, details?, source?}` (same field extraction as
/// `throw_structured`), NOT the retired `[code] message` display string.
fn operation_state_json_from_session(s: ql_session::OperationState) -> OperationStateJson {
    use ql_session::OperationState;
    match s {
        OperationState::Running => OperationStateJson {
            state: "running".to_string(),
            error: None,
        },
        OperationState::Completed => OperationStateJson {
            state: "completed".to_string(),
            error: None,
        },
        OperationState::Canceled => OperationStateJson {
            state: "canceled".to_string(),
            error: None,
        },
        OperationState::Failed { error } => OperationStateJson {
            state: "failed".to_string(),
            error: Some(operation_error_json_from_engine_error(&error)),
        },
    }
}

/// **6.3-5 (MED-5):** extract the contract-§5.1 structured fields from an
/// [`EngineError`] into an [`OperationErrorJson`] — the same `code`/`class`/
/// `retryable`/`details`(JSON string)/`source` projection `throw_structured`
/// uses for the main error channel. `details` is emitted only when non-empty
/// (matching the main channel + the IDE's optional `details`).
fn operation_error_json_from_engine_error(e: &EngineError) -> OperationErrorJson {
    let details = if e.details.is_empty() {
        None
    } else {
        // serde_json::to_string of a BTreeMap<String, Value> only fails on a
        // non-serializable value (not possible here); fall back to None-free
        // visibility by stringifying the serde error so it is never silently lost.
        Some(
            serde_json::to_string(&e.details)
                .unwrap_or_else(|err| format!("[details serialize failed: {err}]")),
        )
    };
    OperationErrorJson {
        code: e.code.clone(),
        class: class_str(e.class).to_string(),
        retryable: e.retryable,
        details,
        source: e.source.clone(),
    }
}

fn event_json_from_session(e: ql_session::session::Event) -> EventJson {
    use ql_session::session::Event;
    // All-None base; each arm fills only its own variant's payload fields.
    let base = EventJson {
        kind: String::new(),
        op: None,
        done: None,
        total: None,
        diagnostic: None,
        state: None,
        addr: None,
        source: None,
        structure_kind: None,
        target: None,
    };
    match e {
        Event::RecalcProgress { op, done, total } => EventJson {
            kind: "recalc_progress".to_string(),
            op: Some(BigInt::from(op.0)),
            done: Some(BigInt::from(done)),
            total: Some(BigInt::from(total)),
            ..base
        },
        Event::CellDiagnostic { diagnostic } => EventJson {
            kind: "cell_diagnostic".to_string(),
            diagnostic: Some(diagnostic_json_from_session(diagnostic)),
            ..base
        },
        Event::OperationCompleted { op, state } => EventJson {
            kind: "operation_completed".to_string(),
            op: Some(BigInt::from(op.0)),
            state: Some(operation_state_json_from_session(state)),
            ..base
        },
        Event::Provenance { addr, source } => EventJson {
            kind: "provenance".to_string(),
            addr: Some(cell_addr_json_from_session(addr)),
            source: Some(source),
            ..base
        },
        Event::StructureChanged { kind, target } => EventJson {
            kind: "structure_changed".to_string(),
            structure_kind: Some(kind),
            target: Some(target),
            ..base
        },
        Event::FullResyncRequired => EventJson {
            kind: "full_resync_required".to_string(),
            ..base
        },
    }
}

fn event_page_json_from_session(p: ql_session::session::EventPage) -> EventPageJson {
    EventPageJson {
        events: p.events.into_iter().map(event_json_from_session).collect(),
        next_cursor: BigInt::from(p.next_cursor.0),
        dropped: p.dropped,
    }
}

/// **6.4-3d (2026-05-29):** map a worker spawn/handshake [`ql_udf::UdfError`] to
/// a napi `[code] message` error. Only the startup variants are reachable from
/// `ProcessWorker::ensure_started` (a missing interpreter / worker death during
/// startup → `WorkerDied`; an incompatible protocol → `Handshake`). A per-call
/// dispatch failure is NOT routed here — that surfaces as a cell error value +
/// a `CellDiagnostic`, never a JS exception.
fn udf_spawn_error_to_napi(e: ql_udf::UdfError) -> Error {
    match e {
        ql_udf::UdfError::Handshake { .. } => Error::from_reason(format!("[worker_handshake] {e}")),
        other => Error::from_reason(format!("[worker_spawn_failed] {other}")),
    }
}

/// **6.4-2:** JS→Rust enum-string mapper. Free-fn rather than a method to keep
/// the DTO type itself a plain data carrier (no impl blocks on `#[napi(object)]`
/// types — napi-rs is happiest that way).
fn arity_from_json(a: ArityJson) -> Result<ql_session::function_meta::Arity> {
    use ql_session::function_meta::Arity;
    // **6.4-2 cycle-2 audit-fix (F3 — Codex / Opus L2):** strict tagged union.
    // Each `kind` admits ONLY its own payload fields; an extraneous field
    // (e.g. `{kind:"variadic", n:7}` or `{kind:"fixed", n:3, min:5}`) is a
    // malformed DTO and is REJECTED loudly, not silently ignored. This keeps the
    // JS→Rust mapper as strict as the enum-string mappers (No-Fallbacks: a
    // caller's malformed DTO surfaces, it is not normalized away).
    match a.kind.as_str() {
        "fixed" => {
            if a.min.is_some() || a.max.is_some() {
                return Err(bad_argument_error(
                    "ArityJson kind 'fixed' must carry only 'n' (got 'min'/'max')".into(),
                ));
            }
            let n = a.n.ok_or_else(|| {
                bad_argument_error("ArityJson kind 'fixed' requires field 'n'".into())
            })?;
            let n = validate_u32_index("registerFunction", "arity.n", n)?;
            let n = u8::try_from(n).map_err(|_| {
                bad_argument_error(format!(
                    "ArityJson 'fixed': n={n} exceeds u8 range (0..=255)"
                ))
            })?;
            Ok(Arity::Fixed { n })
        }
        "range" => {
            if a.n.is_some() {
                return Err(bad_argument_error(
                    "ArityJson kind 'range' must carry 'min'/'max', not 'n'".into(),
                ));
            }
            let min = a.min.ok_or_else(|| {
                bad_argument_error("ArityJson kind 'range' requires field 'min'".into())
            })?;
            let min = validate_u32_index("registerFunction", "arity.min", min)?;
            let min = u8::try_from(min).map_err(|_| {
                bad_argument_error(format!(
                    "ArityJson 'range': min={min} exceeds u8 range (0..=255)"
                ))
            })?;
            let max = a
                .max
                .map(|m| {
                    let m = validate_u32_index("registerFunction", "arity.max", m)?;
                    u8::try_from(m).map_err(|_| {
                        bad_argument_error(format!(
                            "ArityJson 'range': max={m} exceeds u8 range (0..=255)"
                        ))
                    })
                })
                .transpose()?;
            // Reject an inverted range loudly (max < min is not a valid arity).
            if let Some(mx) = max {
                if mx < min {
                    return Err(bad_argument_error(format!(
                        "ArityJson 'range': max ({mx}) must be >= min ({min})"
                    )));
                }
            }
            Ok(Arity::Range { min, max })
        }
        "variadic" => {
            if a.n.is_some() || a.min.is_some() || a.max.is_some() {
                return Err(bad_argument_error(
                    "ArityJson kind 'variadic' must carry no payload (got 'n'/'min'/'max')".into(),
                ));
            }
            Ok(Arity::Variadic)
        }
        other => Err(bad_argument_error(format!(
            "ArityJson: unknown kind {other:?} (expected 'fixed'|'range'|'variadic')"
        ))),
    }
}

fn arity_to_json(a: ql_session::function_meta::Arity) -> ArityJson {
    use ql_session::function_meta::Arity;
    match a {
        Arity::Fixed { n } => ArityJson {
            kind: "fixed".to_string(),
            n: Some(f64::from(n)),
            min: None,
            max: None,
        },
        Arity::Range { min, max } => ArityJson {
            kind: "range".to_string(),
            n: None,
            min: Some(f64::from(min)),
            max: max.map(f64::from),
        },
        Arity::Variadic => ArityJson {
            kind: "variadic".to_string(),
            n: None,
            min: None,
            max: None,
        },
    }
}

fn volatility_from_str(s: &str) -> Result<ql_session::function_meta::Volatility> {
    use ql_session::function_meta::Volatility;
    match s {
        "pure" => Ok(Volatility::Pure),
        "volatile" => Ok(Volatility::Volatile),
        "dynamic" => Ok(Volatility::Dynamic),
        other => Err(bad_argument_error(format!(
            "unknown volatility {other:?} (expected 'pure'|'volatile'|'dynamic')"
        ))),
    }
}

fn volatility_to_str(v: ql_session::function_meta::Volatility) -> &'static str {
    use ql_session::function_meta::Volatility;
    match v {
        Volatility::Pure => "pure",
        Volatility::Volatile => "volatile",
        Volatility::Dynamic => "dynamic",
    }
}

fn dep_shape_from_str(s: &str) -> Result<ql_session::function_meta::DepShape> {
    use ql_session::function_meta::DepShape;
    match s {
        "value_deps" => Ok(DepShape::ValueDeps),
        "address_only" => Ok(DepShape::AddressOnly),
        "lazy_shape" => Ok(DepShape::LazyShape),
        "custom" => Ok(DepShape::Custom),
        other => Err(bad_argument_error(format!(
            "unknown dep_shape {other:?} \
             (expected 'value_deps'|'address_only'|'lazy_shape'|'custom')"
        ))),
    }
}

fn dep_shape_to_str(d: ql_session::function_meta::DepShape) -> &'static str {
    use ql_session::function_meta::DepShape;
    match d {
        DepShape::ValueDeps => "value_deps",
        DepShape::AddressOnly => "address_only",
        DepShape::LazyShape => "lazy_shape",
        DepShape::Custom => "custom",
    }
}

fn batch_shape_from_str(s: &str) -> Result<ql_session::function_meta::BatchShape> {
    use ql_session::function_meta::BatchShape;
    match s {
        "scalar" => Ok(BatchShape::Scalar),
        "array_batch" => Ok(BatchShape::ArrayBatch),
        other => Err(bad_argument_error(format!(
            "unknown batch_shape {other:?} (expected 'scalar'|'array_batch')"
        ))),
    }
}

fn batch_shape_to_str(b: ql_session::function_meta::BatchShape) -> &'static str {
    use ql_session::function_meta::BatchShape;
    match b {
        BatchShape::Scalar => "scalar",
        BatchShape::ArrayBatch => "array_batch",
    }
}

fn arg_policy_from_str(s: &str) -> Result<ql_session::function_meta::ArgPolicy> {
    use ql_session::function_meta::ArgPolicy;
    match s {
        "strict" => Ok(ArgPolicy::Strict),
        "coercing" => Ok(ArgPolicy::Coercing),
        other => Err(bad_argument_error(format!(
            "unknown arg_policy {other:?} (expected 'strict'|'coercing')"
        ))),
    }
}

fn arg_policy_to_str(a: ql_session::function_meta::ArgPolicy) -> &'static str {
    use ql_session::function_meta::ArgPolicy;
    match a {
        ArgPolicy::Strict => "strict",
        ArgPolicy::Coercing => "coercing",
    }
}

fn cancellation_from_str(s: &str) -> Result<ql_session::function_meta::CancelPolicy> {
    use ql_session::function_meta::CancelPolicy;
    match s {
        "cooperative" => Ok(CancelPolicy::Cooperative),
        "worker_kill" => Ok(CancelPolicy::WorkerKill),
        "non_cancelable" => Ok(CancelPolicy::NonCancelable),
        other => Err(bad_argument_error(format!(
            "unknown cancellation {other:?} \
             (expected 'cooperative'|'worker_kill'|'non_cancelable')"
        ))),
    }
}

fn cancellation_to_str(c: ql_session::function_meta::CancelPolicy) -> &'static str {
    use ql_session::function_meta::CancelPolicy;
    match c {
        CancelPolicy::Cooperative => "cooperative",
        CancelPolicy::WorkerKill => "worker_kill",
        CancelPolicy::NonCancelable => "non_cancelable",
    }
}

fn arg_context_from_str(s: &str) -> Result<ql_session::function_meta::ArgContext> {
    use ql_session::function_meta::ArgContext;
    match s {
        "scalar" => Ok(ArgContext::Scalar),
        "aggregate" => Ok(ArgContext::Aggregate),
        "reference" => Ok(ArgContext::Reference),
        other => Err(bad_argument_error(format!(
            "unknown arg_context {other:?} (expected 'scalar'|'aggregate'|'reference')"
        ))),
    }
}

fn arg_context_to_str(a: ql_session::function_meta::ArgContext) -> &'static str {
    use ql_session::function_meta::ArgContext;
    match a {
        ArgContext::Scalar => "scalar",
        ArgContext::Aggregate => "aggregate",
        ArgContext::Reference => "reference",
    }
}

/// **6.4-2:** JS→Rust `FunctionMetadata` mapper. Validates every enum string;
/// unknown strings surface `[bad_argument]`.
fn function_metadata_from_json(
    m: FunctionMetadataJson,
) -> Result<ql_session::function_meta::FunctionMetadata> {
    // **6.3-5 (MED-2):** the required string-list fields are `Option` so a MISSING
    // one surfaces structured `[bad_argument]` (like the pyo3 `req_str_list`),
    // not a generic napi-deserialize `Status` error. An empty list is fine
    // (caller supplied it explicitly).
    let aliases = m.aliases.ok_or_else(|| {
        bad_argument_error("registerFunction: metadata requires an 'aliases' field".into())
    })?;
    let provenance_tags = m.provenance_tags.ok_or_else(|| {
        bad_argument_error("registerFunction: metadata requires a 'provenanceTags' field".into())
    })?;
    Ok(ql_session::function_meta::FunctionMetadata {
        canonical_name: m.canonical_name,
        display_name: m.display_name,
        aliases,
        arity: arity_from_json(m.arity)?,
        volatility: volatility_from_str(&m.volatility)?,
        determinism: m.determinism,
        dep_shape: dep_shape_from_str(&m.dep_shape)?,
        batch_shape: batch_shape_from_str(&m.batch_shape)?,
        arg_policy: arg_policy_from_str(&m.arg_policy)?,
        cancellation: cancellation_from_str(&m.cancellation)?,
        arg_context: arg_context_from_str(&m.arg_context)?,
        provenance_tags,
    })
}

/// **6.4-2:** Rust→JS `FunctionMetadata` mapper. Total — every Rust value maps
/// to a string (no failure mode at this direction).
fn function_metadata_to_json(
    m: ql_session::function_meta::FunctionMetadata,
) -> FunctionMetadataJson {
    FunctionMetadataJson {
        canonical_name: m.canonical_name,
        display_name: m.display_name,
        // **6.3-5 (MED-2):** always emit the required lists as a present array
        // (the field is `Option` only so a MISSING *input* fails loud).
        aliases: Some(m.aliases),
        arity: arity_to_json(m.arity),
        volatility: volatility_to_str(m.volatility).to_string(),
        determinism: m.determinism,
        dep_shape: dep_shape_to_str(m.dep_shape).to_string(),
        batch_shape: batch_shape_to_str(m.batch_shape).to_string(),
        arg_policy: arg_policy_to_str(m.arg_policy).to_string(),
        cancellation: cancellation_to_str(m.cancellation).to_string(),
        arg_context: arg_context_to_str(m.arg_context).to_string(),
        provenance_tags: Some(m.provenance_tags),
    }
}

/// JS-facing wrapper for the owning [`ql_exec::WorkbookSession`] (the product
/// single-writer session). Holds `Arc<Mutex<…>>` for the same `Send + Sync`
/// reason as [`CollabSession`] (positive proof at the bottom of this file): the
/// engine session is `Send + !Sync`, and `Arc<Mutex<Send>>` is `Send + Sync`.
///
/// **Scope (inc.2d + 6.4-2):** the minimal edit→recalc→snapshot smoke surface
/// (construct, single-cell edits, recalc, snapshot/read, close) PLUS the 6.4-2
/// function-registration surface (`registerFunction` / `unregisterFunction` /
/// `listFunctions`). The richer surface (batch/transaction/import/export/undo/
/// delta) is 6.3 Full Bindings. The 6.4-2 methods route through the substrate
/// shipped at 6.4-0 + 6.4-1: registry `register_udf` / `unregister_metadata` /
/// `sorted_metadata` + calcgraph `on_function_(un)registered` + the
/// `map_function_registry_err` mapper for the Appendix A `function_exists` /
/// `function_not_found` codes.
#[napi(js_name = "Session")]
pub struct Session {
    inner: Arc<Mutex<CoreWorkbookSession>>,
}

#[napi]
impl Session {
    /// Construct a fresh, empty in-memory session (lifecycle `Ready`).
    ///
    /// **6.3-5 closure (HIGH-B):** routed through `guarded` like every other bound
    /// method so a panic in `CoreWorkbookSession::new()` surfaces as the structured
    /// `[panic]` error (native `.code="panic"`/`.class="internal"`), not napi's
    /// default. Construction is allocation-only and realistically infallible; the
    /// guard makes the panic-boundary contract uniform across 100% of the surface.
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env) -> Result<Self> {
        guarded(env, "constructor", || {
            Ok(Self {
                inner: Arc::new(Mutex::new(CoreWorkbookSession::new())),
            })
        })
    }

    /// Add a sheet; returns its assigned `SheetId` (u16 widened to u32).
    /// `chunkRows` is the per-sheet row partition size (must be ≥ 1; the engine
    /// rejects 0 to prevent a `ColumnStore` panic).
    #[napi(js_name = "addSheet", catch_unwind)]
    pub fn add_sheet(&self, env: Env, name: String, chunk_rows: f64) -> Result<u32> {
        guarded(env, "addSheet", || {
            let chunk_rows = validate_u32_index("addSheet", "chunkRows", chunk_rows)?;
            if chunk_rows == 0 {
                return Err(bad_argument_error(
                    "addSheet: chunkRows must be >= 1 (engine rejects chunk_rows == 0)".into(),
                ));
            }
            let id = self
                .inner
                .lock()
                .add_sheet(&name, chunk_rows)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(u32::from(id))
        })
    }

    /// Set a cell's literal value (clears any formula). `value` is the
    /// discriminated-union [`CellValueJson`]; `blank` clears the value.
    #[napi(js_name = "setValue", catch_unwind)]
    pub fn set_value(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        value: CellValueJson,
    ) -> Result<()> {
        guarded(env, "setValue", || {
            let addr = session_addr_from_f64("setValue", sheet, row, col)?;
            let value = session_cell_value_from_json(value)?;
            self.inner
                .lock()
                .set_value(addr, value)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Set a cell's formula. `text` is the formula BODY **without** a leading
    /// `=` (e.g. `"A1+1"`) — matching `appendPutFormula` + the engine op-log
    /// convention; the IDE strips the `=` client-side. The engine canonicalizes
    /// the text (e.g. `"A1+1"` → `"A1 + 1"`). A lex/parse failure surfaces
    /// `[formula_parse]`; a **bind** failure (e.g. an unresolvable structured
    /// reference) surfaces `[formula_bind]` (Compute class), not `[formula_parse]`
    /// — both are structured engine errors thrown at set time.
    #[napi(js_name = "setFormula", catch_unwind)]
    pub fn set_formula(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        text: String,
    ) -> Result<()> {
        guarded(env, "setFormula", || {
            let addr = session_addr_from_f64("setFormula", sheet, row, col)?;
            self.inner
                .lock()
                .set_formula(addr, &text)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Clear a cell's formula — **convert-to-literal**: removes the formula but
    /// PRESERVES the last computed value (maps to `clear_formula` / the inc.2c-6
    /// contract; Excel "convert to value"). To also clear the value, call
    /// `setValue(.., { kind: "blank" })`. (A single "delete contents"
    /// value+formula command is a 6.1C contract decision — see handoff.)
    #[napi(js_name = "clear", catch_unwind)]
    pub fn clear(&self, env: Env, sheet: f64, row: f64, col: f64) -> Result<()> {
        guarded(env, "clear", || {
            let addr = session_addr_from_f64("clear", sheet, row, col)?;
            self.inner
                .lock()
                .clear(addr)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Recompute the dirty set (incremental). Returns the operation id (u64 as
    /// BigInt). In v1 a recalc is synchronous; cancel is honored pre-start only.
    #[napi(js_name = "recalcDirty", catch_unwind)]
    pub fn recalc_dirty(&self, env: Env) -> Result<BigInt> {
        guarded(env, "recalcDirty", || {
            let op = self
                .inner
                .lock()
                .recalc_dirty()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BigInt::from(op.0))
        })
    }

    /// Recompute everything. Returns the operation id (u64 as BigInt).
    #[napi(js_name = "recalcAll", catch_unwind)]
    pub fn recalc_all(&self, env: Env) -> Result<BigInt> {
        guarded(env, "recalcAll", || {
            let op = self
                .inner
                .lock()
                .recalc_all()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BigInt::from(op.0))
        })
    }

    /// **M2 (6.3-1b):** reserve an incremental (dirty-set) recalc WITHOUT running
    /// it; returns the operation id (u64 as BigInt). The session goes `Busy` and the
    /// lock is released on return, opening a **pre-start cancel window**: call
    /// [`Self::cancel`] with this id before [`Self::await_recalc`] to prevent the
    /// run (contract §6.4). You MUST then call `awaitRecalc(op)` (even after a
    /// `cancel`) to actually run-or-skip the recompute and release `Busy`. For the
    /// common "recompute now" path with no cancellation, prefer
    /// [`Self::recalc_dirty`] (one call, no window).
    #[napi(js_name = "startRecalcDirty", catch_unwind)]
    pub fn start_recalc_dirty(&self, env: Env) -> Result<BigInt> {
        guarded(env, "startRecalcDirty", || {
            let op = self
                .inner
                .lock()
                .start_recalc(ql_session::RecalcKind::Dirty)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BigInt::from(op.0))
        })
    }

    /// **M2 (6.3-1b):** reserve a full recalc WITHOUT running it; the
    /// `startRecalcAll` counterpart of [`Self::start_recalc_dirty`] (same window +
    /// `awaitRecalc` contract). Prefer [`Self::recalc_all`] for the no-cancel path.
    #[napi(js_name = "startRecalcAll", catch_unwind)]
    pub fn start_recalc_all(&self, env: Env) -> Result<BigInt> {
        guarded(env, "startRecalcAll", || {
            let op = self
                .inner
                .lock()
                .start_recalc(ql_session::RecalcKind::All)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BigInt::from(op.0))
        })
    }

    /// **M2 (6.3-1b):** run (or skip) the recalc reserved by `startRecalcDirty` /
    /// `startRecalcAll`. If a [`Self::cancel`] won the pre-start window the
    /// recompute is SKIPPED (the op surfaces `Canceled`); otherwise it runs to
    /// `Completed`/`Failed`. Errors `[bad_argument]` if `op` is not the in-flight
    /// recalc. (Read the resulting state via `operationStatus` once it is bound —
    /// 6.3-1c/6.3-2.)
    #[napi(js_name = "awaitRecalc", catch_unwind)]
    pub fn await_recalc(&self, env: Env, op: BigInt) -> Result<()> {
        guarded(env, "awaitRecalc", || {
            // BigInt → u64, mirroring the `pollEvents`/`registerFunction` discipline:
            // reject negative (sign bit) / lossy (> u64::MAX) loud per No-Fallbacks.
            let (sign_bit, raw, lossless) = op.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "awaitRecalc: op must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "awaitRecalc: op exceeds u64::MAX (lossy conversion rejected)".into(),
                ));
            }
            self.inner
                .lock()
                .await_recalc(ql_session::OperationId(raw))
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **M2 (6.3-1b):** cancel an operation by id. Returns `true` if the op was
    /// `Running` and is now `Canceled`, `false` if it was already terminal
    /// (completed/canceled/failed). For in-engine recalc this is honored only in the
    /// pre-start window (before `awaitRecalc` begins the synchronous pass — §6.4).
    /// Legal while the session is `Busy`. Errors `[operation_not_found]` for an
    /// unknown id.
    #[napi(js_name = "cancel", catch_unwind)]
    pub fn cancel(&self, env: Env, op: BigInt) -> Result<bool> {
        guarded(env, "cancel", || {
            let (sign_bit, raw, lossless) = op.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "cancel: op must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "cancel: op exceeds u64::MAX (lossy conversion rejected)".into(),
                ));
            }
            self.inner
                .lock()
                .cancel(ql_session::OperationId(raw))
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **6.3-1c (2026-05-30):** read an operation's terminal-or-running state by
    /// id — `{ state: "running" | "completed" | "canceled" | "failed", error? }`
    /// (contract §6.1). This is how the 6.3-1b `startRecalc*`/`awaitRecalc` +
    /// `cancel` OUTCOME is observed from JS: after `awaitRecalc(op)` the op is
    /// `completed` (or `canceled` if a `cancel` won the pre-start window, or
    /// `failed` with the `[code] message` of the recompute error). Legal in ALL
    /// lifecycle states including terminal/Busy (it is a pure read, never gated).
    /// Errors `[operation_not_found]` for an unknown id, `[bad_argument]` for a
    /// negative / lossy BigInt.
    ///
    /// **v1 note:** `error` is the engine error's `[code] message` string (a DTO
    /// data field, parseable by `parseQuantbookError`); nesting the structured
    /// `{code,class,details}` object here is a filed-forward follow-on.
    #[napi(js_name = "operationStatus", catch_unwind)]
    pub fn operation_status(&self, env: Env, op: BigInt) -> Result<OperationStateJson> {
        guarded(env, "operationStatus", || {
            // BigInt -> u64, mirroring the `cancel`/`awaitRecalc` discipline.
            let (sign_bit, raw, lossless) = op.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "operationStatus: op must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "operationStatus: op exceeds u64::MAX (lossy conversion rejected)".into(),
                ));
            }
            let state = self
                .inner
                .lock()
                .operation_status(ql_session::OperationId(raw))
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(operation_state_json_from_session(state))
        })
    }

    /// Full workbook snapshot (carries the opaque `version` token as a `Buffer`).
    #[napi(js_name = "snapshot", catch_unwind)]
    pub fn snapshot(&self, env: Env) -> Result<WorkbookSnapshotJson> {
        guarded(env, "snapshot", || {
            let snap = self
                .inner
                .lock()
                .snapshot()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(workbook_snapshot_json_from_session(snap))
        })
    }

    /// Single-cell lookup. `null` if the cell is empty/absent.
    #[napi(js_name = "cell", catch_unwind)]
    pub fn cell(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
    ) -> Result<Option<CellSnapshotJson>> {
        guarded(env, "cell", || {
            let addr = session_addr_from_f64("cell", sheet, row, col)?;
            let cell = self
                .inner
                .lock()
                .cell(addr)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(cell.map(cell_snapshot_json_from_session))
        })
    }

    /// List (non-tombstoned) sheets (id + name, no cells).
    #[napi(js_name = "listSheets", catch_unwind)]
    pub fn list_sheets(&self, env: Env) -> Result<Vec<SheetInfoJson>> {
        guarded(env, "listSheets", || {
            let sheets = self
                .inner
                .lock()
                .list_sheets()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(sheets
                .into_iter()
                .map(|s| SheetInfoJson {
                    id: u32::from(s.id),
                    name: s.name,
                })
                .collect())
        })
    }

    // ============================================================================
    // 6.3-2a (2026-05-30) — read / lifecycle / format / validate cluster.
    //
    // The first 6.3-2 sub-increment: bind 6 engine-implemented `EngineSession`
    // methods over napi, inheriting the locked 6.3-1 contract (guarded + the
    // structured native error + schemaVersion on DTOs). Pure FFI plumbing — the
    // engine work is done (crates/ql-exec/src/session.rs). The rest of 6.3-2
    // (persistence / structure / tables / atomic groups + the reserved §2c
    // capability stubs) rides later sub-increments; the live-grid cluster
    // (undo/redo/snapshot_delta-on-Session) is 6.3-3.
    // ============================================================================

    /// Current lifecycle state as a wire string (`"new"` | `"ready"` | `"busy"` |
    /// `"closed"` | `"faulted"`; contract §2.3). Infallible — legal in every
    /// state, including the terminal ones (it is how the IDE reads them). This is
    /// the only read that works on a `Faulted`/`Closed` session.
    #[napi(js_name = "lifecycleState", catch_unwind)]
    pub fn lifecycle_state(&self, env: Env) -> Result<String> {
        guarded(env, "lifecycleState", || {
            Ok(lifecycle_state_str(self.inner.lock().lifecycle_state()).to_string())
        })
    }

    /// Parse + bind a formula WITHOUT mutating (the keystroke-validation path).
    /// Returns the diagnostics as DATA (a `Vec<DiagnosticJson>`) — a malformed
    /// formula yields diagnostics, NOT a thrown error (contract §3.2). An empty
    /// result means the formula is valid.
    #[napi(js_name = "validateFormula", catch_unwind)]
    pub fn validate_formula(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        text: String,
    ) -> Result<Vec<DiagnosticJson>> {
        guarded(env, "validateFormula", || {
            let addr = session_addr_from_f64("validateFormula", sheet, row, col)?;
            let diags = self
                .inner
                .lock()
                .validate_formula(addr, &text)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(diags
                .into_iter()
                .map(diagnostic_json_from_session)
                .collect())
        })
    }

    /// Batch-shaped columnar range read (contract §3.6). Returns a
    /// [`RangeResultJson`] (`n_rows` × `n_cols`, column-major). In v1 every
    /// `include_*` option must be `false` — the engine fail-loud rejects a `true`
    /// with `not_implemented_in_v1_core` (only the columnar value read is the v1
    /// surface). `bad_argument` for an invalid/inverted range.
    #[napi(js_name = "queryRange", catch_unwind)]
    pub fn query_range(
        &self,
        env: Env,
        range: CellRangeJson,
        options: RangeQueryOptionsJson,
    ) -> Result<RangeResultJson> {
        guarded(env, "queryRange", || {
            let range = session_range_from_json("queryRange", range)?;
            let options = ql_session::RangeQueryOptions {
                include_formulas: options.include_formulas,
                include_formats: options.include_formats,
                include_rendered: options.include_rendered,
            };
            let result = self
                .inner
                .lock()
                .query_range(range, options)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(range_result_json_from_session(result))
        })
    }

    /// Mark every volatile function dirty (so the next recalc recomputes them).
    /// Mutating command — rejected with `session_busy`/`invalid_state` off Ready.
    #[napi(js_name = "markVolatilesDirty", catch_unwind)]
    pub fn mark_volatiles_dirty(&self, env: Env) -> Result<()> {
        guarded(env, "markVolatilesDirty", || {
            self.inner
                .lock()
                .mark_volatiles_dirty()
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Set a cell's format to a registered [`FormatIdJson`] (builtin index or a
    /// session-custom id from [`Self::register_format`]). `bad_argument` for
    /// invalid coords or a malformed format id; `not_found` for an unknown
    /// custom id.
    #[napi(js_name = "setFormat", catch_unwind)]
    pub fn set_format(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        format_id: FormatIdJson,
    ) -> Result<()> {
        guarded(env, "setFormat", || {
            let addr = session_addr_from_f64("setFormat", sheet, row, col)?;
            let format = session_format_id_from_json(format_id)?;
            self.inner
                .lock()
                .set_format(addr, format)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Register a session-wide custom number format, returning its
    /// [`FormatIdJson`] (a `kind:"custom"` id) for use with [`Self::set_format`].
    /// `bad_argument` for an invalid format string.
    #[napi(js_name = "registerFormat", catch_unwind)]
    pub fn register_format(&self, env: Env, format_string: String) -> Result<FormatIdJson> {
        guarded(env, "registerFormat", || {
            let id = self
                .inner
                .lock()
                .register_format(&format_string)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(format_id_json_from_session(id))
        })
    }

    /// **R9 / Wave B (2026-06-17):** increase (`delta > 0`) / decrease
    /// (`delta < 0`) the decimal places shown by a cell's number format —
    /// Excel's "Increase/Decrease Decimal". The cell's current format is read
    /// (an unbound / `General` cell is treated as the integer base `"0"`),
    /// nudged, and rebound if it changed; a no-op (clamp boundary, a
    /// non-numeric/date format, or `delta == 0` — rejected) leaves the cell
    /// untouched. Convenience over `registerFormat` + `setFormat`: the IDE
    /// calls it once per selected cell. `bad_argument` for invalid coords or a
    /// non-integer / zero / out-of-range (±30) delta.
    #[napi(js_name = "nudgeDecimals", catch_unwind)]
    pub fn nudge_decimals(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        delta: f64,
    ) -> Result<()> {
        guarded(env, "nudgeDecimals", || {
            let addr = session_addr_from_f64("nudgeDecimals", sheet, row, col)?;
            let delta = validate_nudge_delta("nudgeDecimals", delta)?;
            self.inner
                .lock()
                .nudge_cell_decimals(addr, delta)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **R9 / Wave C (2026-06-18):** the READ-ONLY half of [`Self::nudge_decimals`] — compute the
    /// number-format STRING a cell would carry after an increase (`delta > 0`) / decrease (`delta < 0`)
    /// of its decimal places, WITHOUT interning a format or rebinding the cell. Returns the nudged format
    /// string, or `null` for a no-op (the clamp boundary, or the cell already carries the nudged format).
    /// (`delta == 0` never reaches the no-op branch here — it is rejected as `bad_argument` below.)
    /// Pure read — never touches the undo history.
    ///
    /// The IDE uses THIS (not [`Self::nudge_decimals`]) for the toolbar's decimal pair: it previews each
    /// selected cell, registers the distinct returned strings via `registerFormat`, and applies them in
    /// ONE `batch` of `setFormat` ops — so one undo reverts the WHOLE multi-cell nudge (the cell edits are
    /// one batch commit; the per-cell apply `nudgeDecimals` is one Loro commit each, i.e. N undos). Like the
    /// number-format presets, registering a first-seen custom format is a separate commit that leaves one
    /// trailing, invisible undo step. `bad_argument` for invalid coords or a non-integer / zero /
    /// out-of-range (±30) delta; `invalid_format` for a `[Red]`/conditional/elapsed-time format the engine
    /// cannot model (No-Fallbacks — never silently mangled).
    #[napi(js_name = "nudgeDecimalsPreview", catch_unwind)]
    pub fn nudge_decimals_preview(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        delta: f64,
    ) -> Result<Option<String>> {
        guarded(env, "nudgeDecimalsPreview", || {
            let addr = session_addr_from_f64("nudgeDecimalsPreview", sheet, row, col)?;
            let delta = validate_nudge_delta("nudgeDecimalsPreview", delta)?;
            self.inner
                .lock()
                .nudge_decimals_preview(addr, delta)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **Wave G2 (engine-filter):** hide (`hidden = true`) or show
    /// (`hidden = false`) a set of ROWS on `sheet`. A hidden row is excluded by
    /// the `SUBTOTAL(101..=111)` "ignore hidden rows" variants, and dependents
    /// recompute. Idempotent per row — only state-changing rows are recorded and
    /// undoable, so hiding an already-hidden row is a no-op. The host drives this
    /// from the row-gutter hide action and the future autofilter. `bad_argument`
    /// for a non-integer / out-of-range sheet or row; a row past `MAX_ROW` (or a
    /// missing/tombstoned sheet) surfaces the engine's loud error (No-Fallbacks).
    #[napi(js_name = "setRowsHidden", catch_unwind)]
    pub fn set_rows_hidden(
        &self,
        env: Env,
        sheet: f64,
        rows: Vec<f64>,
        hidden: bool,
    ) -> Result<()> {
        guarded(env, "setRowsHidden", || {
            let sheet = validate_u16_index("setRowsHidden", "sheet", sheet)?;
            let rows: Vec<u32> = rows
                .into_iter()
                .map(|r| validate_u32_index("setRowsHidden", "row", r))
                .collect::<Result<_>>()?;
            self.inner
                .lock()
                .set_rows_hidden(sheet, &rows, hidden)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **Wave G2:** the sorted list of currently-hidden rows on `sheet` (the READ
    /// half of [`Self::set_rows_hidden`]). The renderer pulls this on a sheet
    /// switch / after a hide to collapse hidden rows. `bad_argument` for an
    /// invalid sheet; a missing/tombstoned sheet surfaces the engine's loud error.
    #[napi(js_name = "getHiddenRows", catch_unwind)]
    pub fn get_hidden_rows(&self, env: Env, sheet: f64) -> Result<Vec<u32>> {
        guarded(env, "getHiddenRows", || {
            let sheet = validate_u16_index("getHiddenRows", "sheet", sheet)?;
            self.inner
                .lock()
                .hidden_rows(sheet)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **FE-4 W4 (2026-06-10):** set a cell's visual style to a registered
    /// [`StyleIdJson`] (from [`Self::register_style`]). `bad_argument` for
    /// invalid coords or an unknown/malformed style id. The visual-formatting
    /// analog of [`Self::set_format`]; lands on the OWNING `Session` (the
    /// product grid's session — NOT the dormant `CollabSession`).
    #[napi(js_name = "setStyle", catch_unwind)]
    pub fn set_style(
        &self,
        env: Env,
        sheet: f64,
        row: f64,
        col: f64,
        style_id: StyleIdJson,
    ) -> Result<()> {
        guarded(env, "setStyle", || {
            let addr = session_addr_from_f64("setStyle", sheet, row, col)?;
            let id = session_style_id_from_json(style_id)?;
            self.inner
                .lock()
                .set_style(addr, id)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **FE-4 W4 (2026-06-10):** register a session-wide cell style, returning
    /// its [`StyleIdJson`] for use with [`Self::set_style`]. `bad_argument` for
    /// a malformed style (e.g. an unknown align/border-style string). The
    /// visual-formatting analog of [`Self::register_format`]. Idempotent —
    /// re-registering an identical style returns the same id.
    #[napi(js_name = "registerStyle", catch_unwind)]
    pub fn register_style(&self, env: Env, style: StyleJson) -> Result<StyleIdJson> {
        guarded(env, "registerStyle", || {
            let style = session_style_from_json("registerStyle", style)?;
            let id = self
                .inner
                .lock()
                .register_style(style)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(style_id_json_from_session(id))
        })
    }

    /// Deterministically release the underlying [`ql_exec::WorkbookSession`]
    /// state — transitions the session to `Closed` (terminal). Subsequent
    /// command calls return a structured `[invalid_state]` engine error rather
    /// than panic. Any open transaction buffers are dropped (their handles
    /// become `[transaction_not_found]` if reused, never silent no-ops).
    ///
    /// **6.1C audit-fix M8 — closes the lifecycle hole.** Without this,
    /// JS-side the only way to free the workbook + op-log + plan cache + Loro
    /// substrate was to GC the JS handle — non-deterministic, can hold large
    /// workbooks in memory long after the IDE panel closes. Calling `close()`
    /// frees the engine state synchronously (engine `WorkbookSession::close`
    /// at `crates/ql-exec/src/session.rs`).
    #[napi(js_name = "close", catch_unwind)]
    pub fn close(&self, env: Env) -> Result<()> {
        guarded(env, "close", || {
            self.inner
                .lock()
                .close()
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    // ============================================================================
    // 6.3-2b (2026-05-30) — persistence over napi.
    //
    // Binds the four already-implemented engine persistence methods (inc.2c-9/10/
    // 11/12): `.qbook` open/save, multi-format import/export. Byte payloads cross as
    // `Uint8Array`. Each inherits the locked 6.3-1 contract — `guarded(env,..)` +
    // `catch_unwind`, native structured errors via `engine_error_to_napi`.
    // ============================================================================

    /// Open a `.qbook` workbook from `path` (New → Ready; engine re-mints the epoch,
    /// so any prior delta token full-rebuilds, and recomputes on load). A missing
    /// file / bad envelope / corrupt op-log sidecar surfaces a structured
    /// `[persistence]` engine error (No-Fallbacks). `[invalid_state]` off an openable
    /// state.
    #[napi(js_name = "open", catch_unwind)]
    pub fn open(&self, env: Env, path: String) -> Result<()> {
        guarded(env, "open", || {
            self.inner
                .lock()
                .open(&path)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Import a workbook from in-memory `bytes` in `format` — v1 supports `"xlsx"`
    /// (recomputed BestEffort on import) and `"csv"` (no formulas). Any other format
    /// is a loud `[bad_argument]`; malformed bytes surface `[persistence]`; a
    /// well-formed CSV that exceeds the row/col/cell limits surfaces
    /// `[csv_exceeds_limits]` (BadArgument), distinct from malformed bytes. Adopts the
    /// imported workbook as a fresh session (epoch re-minted).
    ///
    /// **V1 SharedArrayBuffer note** (mirrors `mergeBytes`): `bytes.as_ref()` lends a
    /// slice INTO the JS-owned buffer; the engine consumes it synchronously into a
    /// workbook before returning, so the V1 direct read is safe (a concurrent mutation
    /// of a `SharedArrayBuffer` during the call is the documented V2 hardening target).
    #[napi(js_name = "import", catch_unwind)]
    pub fn import(&self, env: Env, bytes: Uint8Array, format: String) -> Result<()> {
        guarded(env, "import", || {
            self.inner
                .lock()
                .import(bytes.as_ref(), &format)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Save the live workbook + this session's op-log to a single-file `.qbook`
    /// container at `path` (**Wave H1** — formerly a `.qbook` directory; one
    /// atomic `rename`). The workbook display name is derived from the path's
    /// file stem — a path with no stem is `[bad_argument]`. `[invalid_state]`
    /// off a readable state; I/O / serialization failures surface `[persistence]`.
    /// Saving onto an existing legacy `.qbook` DIRECTORY is refused `[persistence]`.
    #[napi(js_name = "save", catch_unwind)]
    pub fn save(&self, env: Env, path: String) -> Result<()> {
        guarded(env, "save", || {
            self.inner
                .lock()
                .save(&path)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Export the live workbook to in-memory bytes in `format` — v1 supports `"csv"`
    /// (single live sheet; >1 → loud `[bad_argument]`) and `"xlsx"` (whole workbook,
    /// only when the engine is built with the `xlsx-write` feature; otherwise the
    /// honest `[not_implemented_in_v1_core]`). Any other format is `[bad_argument]`.
    /// Returns the bytes as a `Uint8Array`.
    #[napi(js_name = "export", catch_unwind)]
    pub fn export(&self, env: Env, format: String) -> Result<Uint8Array> {
        guarded(env, "export", || {
            let bytes = self
                .inner
                .lock()
                .export(&format)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(Uint8Array::from(bytes))
        })
    }

    // ============================================================================
    // 6.3-2c (2026-05-30) — structure / sheets over napi.
    //
    // Binds the already-implemented engine structure mutators (§3.3):
    // sheet rename / delete (tombstone) / restore / move (reorder) + defined-name
    // binding. `addSheet` is bound above (it predates this cluster). Each inherits
    // the locked 6.3-1 contract — `guarded(env,..)` + `catch_unwind`, native
    // structured errors via `engine_error_to_napi`. Sheet ids are validated as u16
    // (the `SheetId` width) via `validate_u16_index`; the move index as u32 via
    // `validate_u32_index`; `setName`'s range reuses the 6.3-2a `session_range_from_json`
    // converter (no new DTO).
    // ============================================================================

    /// Rename a sheet by id. Unknown id surfaces `[sheet_not_found]` (NotFound);
    /// a name colliding with another live sheet surfaces `[sheet_name_duplicate]`
    /// (Conflict). `[invalid_state]` off a Ready session. `id` is validated to the
    /// `SheetId` (u16) range — out of range is a loud `[bad_argument]`.
    #[napi(js_name = "renameSheet", catch_unwind)]
    pub fn rename_sheet(&self, env: Env, id: f64, new_name: String) -> Result<()> {
        guarded(env, "renameSheet", || {
            let id = validate_u16_index("renameSheet", "id", id)?;
            self.inner
                .lock()
                .rename_sheet(id, &new_name)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Tombstone a sheet by id (preserves its cells for `restoreSheet`; NOT a
    /// silent storage no-op). Unknown id surfaces `[sheet_not_found]` (NotFound);
    /// `[invalid_state]` off a Ready session.
    #[napi(js_name = "deleteSheet", catch_unwind)]
    pub fn delete_sheet(&self, env: Env, id: f64) -> Result<()> {
        guarded(env, "deleteSheet", || {
            let id = validate_u16_index("deleteSheet", "id", id)?;
            self.inner
                .lock()
                .delete_sheet(id)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Restore a previously-tombstoned sheet by id. Unknown id surfaces
    /// `[sheet_not_found]` (NotFound); a not-tombstoned (still-live) sheet surfaces
    /// `[sheet_not_deleted]` (Conflict). `[invalid_state]` off a Ready session.
    #[napi(js_name = "restoreSheet", catch_unwind)]
    pub fn restore_sheet(&self, env: Env, id: f64) -> Result<()> {
        guarded(env, "restoreSheet", || {
            let id = validate_u16_index("restoreSheet", "id", id)?;
            self.inner
                .lock()
                .restore_sheet(id)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Reorder a sheet to display position `newIndex`. Unknown id surfaces
    /// `[sheet_not_found]` (NotFound); an out-of-range index (valid positions are
    /// `[0, sheet_count)`) surfaces a loud `[bad_argument]` (NOT a silent clamp);
    /// moving to the current position is a no-op (no version advance, no throw).
    /// `[invalid_state]` off a Ready session.
    #[napi(js_name = "moveSheet", catch_unwind)]
    pub fn move_sheet(&self, env: Env, id: f64, new_index: f64) -> Result<()> {
        guarded(env, "moveSheet", || {
            let id = validate_u16_index("moveSheet", "id", id)?;
            let index = validate_u32_index("moveSheet", "newIndex", new_index)?;
            self.inner
                .lock()
                .move_sheet(id, index)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Define a workbook name bound to a range (`target` is the 6.3-2a
    /// [`CellRangeJson`]). A defined name is delta-invisible (not part of
    /// `WorkbookSnapshot`/`WorkbookSnapshotDelta`), so this only signals success.
    /// Invalid range coords surface a loud `[bad_argument]` at the converter;
    /// engine-side name/target failures map natively. `[invalid_state]` off a
    /// Ready session.
    ///
    /// **Range orientation (documented contract, NOT silent):** an unordered /
    /// inverted `target` (e.g. `startRow > endRow`) is **normalized** to
    /// `start <= end` per axis by the engine's canonical `Range` constructor —
    /// a defined name is a rectangle, so the corner order carries no meaning
    /// (matching Excel/Sheets named-range semantics). This deliberately differs
    /// from `queryRange`, which *rejects* an inverted range with `[bad_argument]`
    /// because its `end - start + 1` span arithmetic would underflow — a hazard
    /// `set_name` does not have. (The `query_range`-vs-`set_name` inversion
    /// asymmetry is an engine-side API choice, filed forward, not a binding defect.)
    #[napi(js_name = "setName", catch_unwind)]
    pub fn set_name(&self, env: Env, name: String, target: CellRangeJson) -> Result<()> {
        guarded(env, "setName", || {
            let range = session_range_from_json("setName", target)?;
            self.inner
                .lock()
                .set_name(&name, range)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **FE-5 W-N (2026-06-12):** remove a defined name. `scope` is absent/null
    /// for a workbook-scoped name (the only kind the IDE's `setName` creates) or
    /// the sheet id (validated to `u16`) for a sheet-scoped name. A name that
    /// isn't registered in the target scope surfaces a loud `[name_not_found]`
    /// (NotFound) — NOT a silent no-op (No-Fallbacks). Persists a compensating
    /// `Op::RemoveName` so an undo/redo re-materialization does not resurrect the
    /// deleted name. A defined-name change is delta-invisible
    /// (`WorkbookSnapshot`/-`Delta`), so the IDE Name-Manager refreshes via a
    /// full `snapshot()` (or `listNames`). `[invalid_state]` off a Ready session.
    #[napi(js_name = "deleteName", catch_unwind)]
    pub fn delete_name(&self, env: Env, name: String, scope: Option<f64>) -> Result<()> {
        guarded(env, "deleteName", || {
            let scope = match scope {
                Some(s) => Some(validate_u16_index("deleteName", "scope", s)?),
                None => None,
            };
            self.inner
                .lock()
                .delete_name(&name, scope)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **FE-5 W-N (2026-06-12):** list every defined name in the workbook — BOTH
    /// workbook-scoped (`scope` absent) AND every sheet's sheet-scoped names
    /// (`scope` = sheet id). Sorted (workbook-scoped first, then by sheet id,
    /// then by name). The lightweight read backing the Name-Manager UI (the same
    /// data also rides `snapshot().names`). All four target kinds round-trip
    /// faithfully (`cell` / `range` / `constant` / `formula`).
    #[napi(js_name = "listNames", catch_unwind)]
    pub fn list_names(&self, env: Env) -> Result<Vec<NamedRangeJson>> {
        guarded(env, "listNames", || {
            let names = self
                .inner
                .lock()
                .list_names()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(names
                .into_iter()
                .map(named_range_json_from_session)
                .collect())
        })
    }

    // ============================================================================
    // Wave Q1 (2026-06-23) -- chart-object CRUD over napi.
    //
    // Bind the owning `WorkbookSession::{add,update,remove,list}_chart`. Chart
    // objects are inert workbook metadata persisted in the v12 `.qbook` envelope
    // (no formula deps). A chart mutation `bump_epoch`s the owning session, so
    // the next `snapshot_delta` reports `full_rebuild_required` and the IDE
    // reseeds + re-reads via `listCharts` (see the chart-CRUD note in
    // `session.rs`; the legacy CollabSession path signals the same via
    // `classify_delta_op`). `id` is validated to u32 via `validate_u32_index`
    // (avoids JS `ToUint32` silent coercion); spec validation (chartType, sheet
    // range, non-zero size, in-grid coordinates) lives in `parse_chart_spec`.
    // Engine rejections (e.g. `ChartNotFound`, dead sheet) map natively through
    // `engine_error_to_napi`.
    // ============================================================================

    /// Add a chart object; returns its stable id. `[bad_argument]` for an
    /// unknown `chartType`, out-of-range sheet, zero size, or off-grid
    /// coordinate; `[sheet_not_found]` for a dead anchor/source sheet;
    /// `[invalid_state]` off a Ready session.
    #[napi(js_name = "addChart", catch_unwind)]
    pub fn add_chart(&self, env: Env, spec: ChartSpecJson) -> Result<u32> {
        guarded(env, "addChart", || {
            let p = parse_chart_spec("addChart", &spec)?;
            self.inner
                .lock()
                .add_chart(
                    &spec.name,
                    p.kind,
                    p.sheet,
                    p.anchor_row,
                    p.anchor_col,
                    p.width_px,
                    p.height_px,
                    p.src,
                    spec.title.clone(),
                )
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Replace a chart object's full state. `[bad_argument]` for a bad spec;
    /// the engine returns a not-found error if `id` isn't registered.
    #[napi(js_name = "updateChart", catch_unwind)]
    pub fn update_chart(&self, env: Env, id: f64, spec: ChartSpecJson) -> Result<()> {
        guarded(env, "updateChart", || {
            let id = validate_u32_index("updateChart", "id", id)?;
            let p = parse_chart_spec("updateChart", &spec)?;
            self.inner
                .lock()
                .update_chart(
                    id,
                    &spec.name,
                    p.kind,
                    p.sheet,
                    p.anchor_row,
                    p.anchor_col,
                    p.width_px,
                    p.height_px,
                    p.src,
                    spec.title.clone(),
                )
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Remove a chart object by id. The engine returns a not-found error if
    /// `id` isn't registered.
    #[napi(js_name = "removeChart", catch_unwind)]
    pub fn remove_chart(&self, env: Env, id: f64) -> Result<()> {
        guarded(env, "removeChart", || {
            let id = validate_u32_index("removeChart", "id", id)?;
            self.inner
                .lock()
                .remove_chart(id)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// List every chart object in the workbook (HashMap-arbitrary order; the IDE
    /// sorts/positions). The same data also survives `.qbook` save/reopen.
    #[napi(js_name = "listCharts", catch_unwind)]
    pub fn list_charts(&self, env: Env) -> Result<Vec<ChartJson>> {
        guarded(env, "listCharts", || {
            let charts = self
                .inner
                .lock()
                .list_charts()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(charts.into_iter().map(chart_json_from_object).collect())
        })
    }

    // ============================================================================
    // W3 (insert/delete rows & columns) — structural-axis edits over napi.
    //
    // These bind the owning `WorkbookSession::{insert,delete}_{rows,columns}`
    // (the audited producer core lives in `ql_exec::structural`). This is the
    // PATH THE PRODUCT GRID RUNS ON — the IDE's `quantbookCommands` structural
    // op calls `session.insertRows/deleteRows/insertColumns/deleteColumns`
    // directly on this owning `Session` (the dormant `CollabSession` is v1.5).
    //
    // Args follow the locked 6.3-1 contract: `sheet` validated to the `SheetId`
    // (u16) range via `validate_u16_index`; the row/col indices to u32 via
    // `validate_u32_index` (both avoid JS `ToUint32` silent coercion). Engine
    // rejections (NotFound / BadArgument / invalid_state) map natively through
    // `engine_error_to_napi`. `guarded(env,..)` + `catch_unwind` make a panic a
    // structured `[panic]` error rather than a Node abort.
    //
    // **deleteRows/deleteColumns take `end` INCLUSIVE** — the IDE command passes
    // `(index, index + count - 1)` (quantbookCommands.ts), matching the engine
    // `Op::Delete{Rows,Columns}` `[start, end]` inclusive contract.
    // ============================================================================

    /// Insert `count` blank rows at row index `at` on `sheet`. Rows at/below
    /// `at` shift down; formula refs into the edited sheet are rewritten to
    /// follow. `count == 0` / off-grid / table-split → `[bad_argument]`; unknown
    /// sheet → `[sheet_not_found]`; off a Ready session → `[invalid_state]`.
    #[napi(js_name = "insertRows", catch_unwind)]
    pub fn insert_rows(&self, env: Env, sheet: f64, at: f64, count: f64) -> Result<()> {
        guarded(env, "insertRows", || {
            let sheet = validate_u16_index("insertRows", "sheet", sheet)?;
            let at = validate_u32_index("insertRows", "at", at)?;
            let count = validate_u32_index("insertRows", "count", count)?;
            self.inner
                .lock()
                .insert_rows(sheet, at, count)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Delete the INCLUSIVE row block `[start, end]` on `sheet`. Rows below
    /// `end` shift up; refs into the deleted block become `#REF!`. `start > end`
    /// / off-grid → `[bad_argument]`. `end` is INCLUSIVE (the IDE passes
    /// `index, index + count - 1`).
    #[napi(js_name = "deleteRows", catch_unwind)]
    pub fn delete_rows(&self, env: Env, sheet: f64, start: f64, end: f64) -> Result<()> {
        guarded(env, "deleteRows", || {
            let sheet = validate_u16_index("deleteRows", "sheet", sheet)?;
            let start = validate_u32_index("deleteRows", "start", start)?;
            let end = validate_u32_index("deleteRows", "end", end)?;
            self.inner
                .lock()
                .delete_rows(sheet, start, end)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Insert `count` blank columns at column index `at` on `sheet`. See
    /// [`Self::insert_rows`].
    #[napi(js_name = "insertColumns", catch_unwind)]
    pub fn insert_columns(&self, env: Env, sheet: f64, at: f64, count: f64) -> Result<()> {
        guarded(env, "insertColumns", || {
            let sheet = validate_u16_index("insertColumns", "sheet", sheet)?;
            let at = validate_u32_index("insertColumns", "at", at)?;
            let count = validate_u32_index("insertColumns", "count", count)?;
            self.inner
                .lock()
                .insert_columns(sheet, at, count)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Delete the INCLUSIVE column block `[start, end]` on `sheet`. See
    /// [`Self::delete_rows`]. `end` is INCLUSIVE.
    #[napi(js_name = "deleteColumns", catch_unwind)]
    pub fn delete_columns(&self, env: Env, sheet: f64, start: f64, end: f64) -> Result<()> {
        guarded(env, "deleteColumns", || {
            let sheet = validate_u16_index("deleteColumns", "sheet", sheet)?;
            let start = validate_u32_index("deleteColumns", "start", start)?;
            let end = validate_u32_index("deleteColumns", "end", end)?;
            self.inner
                .lock()
                .delete_columns(sheet, start, end)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    // ============================================================================
    // 6.3-2d (2026-05-30) — tables over napi.
    //
    // Binds the already-implemented engine table mutators (§3.3): create / rename
    // table / rename column / resize / drop. The FIRST 6.3-2 sub-increment that
    // adds a new DTO — `TableSpecJson` (mirrors `ql_session::TableSpec`), converted
    // via `session_table_spec_from_json` (sheet -> u16, top/rows/cols -> u32, with
    // the same boundary validation as `session_range_from_json`). Each method
    // inherits the locked 6.3-1 contract — `guarded(env,..)` + `catch_unwind`,
    // native structured errors via `engine_error_to_napi`. Table ops are not
    // delta-expressible (they rewrite cells the session cannot enumerate), so the
    // engine bumps the epoch — consumers reseed from a fresh snapshot.
    // ============================================================================

    /// Create a table from `spec`. A duplicate name (shared Table+Name namespace),
    /// zero `rows`/`cols`, a footprint that exceeds the grid / overlaps an existing
    /// table / contains a spill anchor, a `columnNames` length mismatch, or empty /
    /// non-unique column names all surface `[table_create_rejected]` (Conflict). An
    /// unknown or tombstoned `sheet` surfaces `[sheet_not_found]` (NotFound).
    /// `[invalid_state]` off a Ready session. Coords are validated to u16/u32 at the
    /// converter (a loud `[bad_argument]` for non-integer / negative / out-of-range).
    #[napi(js_name = "createTable", catch_unwind)]
    pub fn create_table(&self, env: Env, spec: TableSpecJson) -> Result<()> {
        guarded(env, "createTable", || {
            let spec = session_table_spec_from_json("createTable", spec)?;
            self.inner
                .lock()
                .create_table(spec)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Rename a table. Unknown `oldName` surfaces `[table_not_found]` (NotFound); a
    /// `newName` colliding with another table or defined name surfaces
    /// `[table_create_rejected]` (Conflict). Rewrites stored formula text that
    /// references the table (Excel canon) as one undo unit. `[invalid_state]` off a
    /// Ready session.
    #[napi(js_name = "renameTable", catch_unwind)]
    pub fn rename_table(&self, env: Env, old_name: String, new_name: String) -> Result<()> {
        guarded(env, "renameTable", || {
            self.inner
                .lock()
                .rename_table(&old_name, &new_name)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Rename a column within a table. An unknown `table` surfaces
    /// `[table_not_found]`; an unknown `oldCol` surfaces `[table_column_not_found]`;
    /// a `newCol` colliding with another column surfaces `[table_column_rejected]`
    /// (Conflict). Rewrites stored structured-reference formula text as one undo
    /// unit. `[invalid_state]` off a Ready session.
    #[napi(js_name = "renameColumn", catch_unwind)]
    pub fn rename_column(
        &self,
        env: Env,
        table: String,
        old_col: String,
        new_col: String,
    ) -> Result<()> {
        guarded(env, "renameColumn", || {
            self.inner
                .lock()
                .rename_column(&table, &old_col, &new_col)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Resize a table to `newRows` x `newCols`, adding/removing the named columns.
    /// An unknown `name` surfaces `[table_not_found]`; invalid dimensions / column
    /// lists surface `[table_resize_rejected]` (BadArgument). `newRows`/`newCols`
    /// are validated to u32 at the boundary (a loud `[bad_argument]` for
    /// non-integer / negative / out-of-range). `[invalid_state]` off a Ready session.
    #[napi(js_name = "resizeTable", catch_unwind)]
    pub fn resize_table(
        &self,
        env: Env,
        name: String,
        new_rows: f64,
        new_cols: f64,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    ) -> Result<()> {
        guarded(env, "resizeTable", || {
            let new_rows = validate_u32_index("resizeTable", "newRows", new_rows)?;
            let new_cols = validate_u32_index("resizeTable", "newCols", new_cols)?;
            self.inner
                .lock()
                .resize_table(&name, new_rows, new_cols, added_columns, removed_columns)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Drop a table. Its metadata is removed; cells inside the footprint are left
    /// in place, and formulas referencing the table re-bind to `#NAME?` on the next
    /// recompute. An unknown `name` surfaces `[table_not_found]` (NotFound).
    /// `[invalid_state]` off a Ready session.
    #[napi(js_name = "dropTable", catch_unwind)]
    pub fn drop_table(&self, env: Env, name: String) -> Result<()> {
        guarded(env, "dropTable", || {
            self.inner
                .lock()
                .drop_table(&name)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **FE-8.3 (2026-06-15):** list a table's column display names, in order. The
    /// lightweight read backing FE-8.1's column-shrink (the IDE needs the trailing
    /// column names for `resizeTable`'s `removedColumns`) and the rename-column
    /// picker — the names live in the engine's `TableMetadata` but the snapshot
    /// (`workbookSnapshot().tables`) omits them. An unknown `table` surfaces
    /// `[table_not_found]` (NotFound, matched case-insensitively, identical to
    /// drop/rename). `[invalid_state]` off a readable session.
    #[napi(js_name = "tableColumns", catch_unwind)]
    pub fn table_columns(&self, env: Env, table: String) -> Result<Vec<String>> {
        guarded(env, "tableColumns", || {
            self.inner
                .lock()
                .table_columns(&table)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    // ============================================================================
    // 6.3-2e (2026-05-30) — atomic groups + the §3.5 bulk methods over napi.
    //
    // Binds the already-implemented atomic-group methods (§3.4) — `batch` + the
    // multi-call transaction handle (`begin`/`txnAdd`/`commit`/`rollback`) — plus
    // the 5 §3.5 bulk methods (all LIVE since 6.5 / ENG-FUSION; were stubs at 6.3-2e). The
    // FIFTH and final 6.3-2 sub-increment (completes 6.3-2). New DTOs: `SessionOpJson`
    // (the op union), `BatchOptionsJson`, `BatchResultJson`. Each method inherits the
    // locked 6.3-1 contract — `guarded(env,..)` + `catch_unwind`, native
    // `engine_error_to_napi`. `TransactionId` is a `u64` carried as a JS `BigInt`
    // (sign/lossless-validated on input, exactly like `OperationId`).
    // ============================================================================

    /// Apply a sequence of ops atomically as ONE undo unit / ONE op-log entry
    /// (`Op::BatchCommit`, §3.4) — all-or-nothing. An invalid op (e.g. a non-finite
    /// value → `[bad_argument]`) or a same-cell value/formula conflict (two such ops
    /// on one cell → `[conflicting_batch_ops]`) rejects the WHOLE batch with no
    /// partial mutation (validated pre-mutation). Returns
    /// the applied count + the post-batch version token. `[invalid_state]` off a Ready
    /// session; a tombstoned target sheet → `[sheet_not_found]`.
    ///
    /// **Invariant note (megaudit Opus-2 LOW, visibility):** validation is Phase-1;
    /// the Phase-3 apply is designed-infallible after Phase-1 passes — a Phase-3
    /// failure (engine invariant violation) is the only path that could leave a
    /// partial mutation + Ready session, and is treated as a bug, not a normal error.
    #[napi(js_name = "batch", catch_unwind)]
    pub fn batch(
        &self,
        env: Env,
        ops: Vec<SessionOpJson>,
        options: BatchOptionsJson,
    ) -> Result<BatchResultJson> {
        guarded(env, "batch", || {
            let ops = ops
                .into_iter()
                .map(|op| session_op_from_json("batch", op))
                .collect::<Result<Vec<_>>>()?;
            let options = ql_session::BatchOptions {
                undo_label: options.undo_label,
            };
            let result = self
                .inner
                .lock()
                .batch(ops, options)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BatchResultJson {
                applied: result.applied as f64,
                version: Buffer::from(result.version.0),
            })
        })
    }

    /// Open a multi-call transaction; returns its id (u64 as BigInt). Stage ops with
    /// `txnAdd`, then `commitTransaction` (atomic, one undo unit) or
    /// `rollbackTransaction` (discard). `[invalid_state]` off a Ready session.
    #[napi(js_name = "beginTransaction", catch_unwind)]
    pub fn begin_transaction(&self, env: Env) -> Result<BigInt> {
        guarded(env, "beginTransaction", || {
            let txn = self
                .inner
                .lock()
                .begin_transaction()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BigInt::from(txn.0))
        })
    }

    /// Stage an op into an open transaction. An unknown txn id surfaces
    /// `[transaction_not_found]` (NotFound); a malformed BigInt id or a malformed op
    /// surfaces `[bad_argument]`. Staged ops do not apply until `commitTransaction`.
    #[napi(js_name = "txnAdd", catch_unwind)]
    pub fn txn_add(&self, env: Env, txn: BigInt, op: SessionOpJson) -> Result<()> {
        guarded(env, "txnAdd", || {
            let txn = transaction_id_from_bigint("txnAdd", txn)?;
            let op = session_op_from_json("txnAdd", op)?;
            self.inner
                .lock()
                .txn_add(txn, op)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// Commit a transaction atomically (one undo unit). Same all-or-nothing semantics
    /// as `batch`. An unknown txn id surfaces `[transaction_not_found]` (NotFound); a
    /// malformed BigInt id surfaces `[bad_argument]`. On a FAILED commit the engine
    /// restores the buffer (the transaction stays open for fix-and-retry/rollback); a
    /// successful commit consumes the handle. Returns the applied count + the
    /// post-commit version token.
    #[napi(js_name = "commitTransaction", catch_unwind)]
    pub fn commit_transaction(&self, env: Env, txn: BigInt) -> Result<BatchResultJson> {
        guarded(env, "commitTransaction", || {
            let txn = transaction_id_from_bigint("commitTransaction", txn)?;
            let result = self
                .inner
                .lock()
                .commit_transaction(txn)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BatchResultJson {
                applied: result.applied as f64,
                version: Buffer::from(result.version.0),
            })
        })
    }

    /// Roll back (discard) a transaction; its staged ops never apply and the handle is
    /// consumed. An unknown txn id surfaces `[transaction_not_found]` (NotFound); a
    /// malformed BigInt id surfaces `[bad_argument]`.
    #[napi(js_name = "rollbackTransaction", catch_unwind)]
    pub fn rollback_transaction(&self, env: Env, txn: BigInt) -> Result<()> {
        guarded(env, "rollbackTransaction", || {
            let txn = transaction_id_from_bigint("rollbackTransaction", txn)?;
            self.inner
                .lock()
                .rollback_transaction(txn)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    // --- Reserved §3.5 capability stubs (real impls land in 6.4 / 6.5) ---
    //
    // These ALWAYS surface `not_implemented_in_v1_core` (Capability) in v1 — that is
    // the AUTHORITATIVE v1 signal ("this feature does not exist yet"). Each is declared
    // `-> ()` (it never returns a value) and forwards to the engine via `.map(|_| ())`
    // on the unreachable Ok arm — a real impl only swaps the return type. Inputs are
    // converted enough to keep types honest (bad coords / cell values / JSON →
    // `[bad_argument]`); the FULL input contract (e.g. `writeRange`'s rectangular
    // matrix-shape rule) is deliberately NOT enforced here — it lands with the real
    // implementation in 6.4 (publish/bind) / 6.5 (SQL materialize), which defines it.

    /// Bulk-write a rectangular value matrix into `range`; dirties dependents.
    /// Returns `{ written, version }`. `[bad_argument]` for an inverted/out-of-bounds
    /// range, a mismatched matrix shape, or a non-finite value. `[invalid_state]` off
    /// a Ready session.
    #[napi(js_name = "writeRange", catch_unwind)]
    pub fn write_range(
        &self,
        env: Env,
        range: CellRangeJson,
        values: Vec<Vec<CellValueJson>>,
    ) -> Result<WriteRangeResultJson> {
        guarded(env, "writeRange", || {
            let range = session_range_from_json("writeRange", range)?;
            let values = values
                .into_iter()
                .map(|row| row.into_iter().map(session_cell_value_from_json).collect())
                .collect::<Result<Vec<Vec<_>>>>()?;
            let result = self
                .inner
                .lock()
                .write_range(range, values)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(WriteRangeResultJson {
                written: result.written as f64,
                version: Buffer::from(result.version.0),
            })
        })
    }

    /// **ENG-FUSION** (§3.5; `qb.publish()`): publish a value-matrix dataset into a
    /// target. `data` is a JSON string (the napi `serde-json` feature is not enabled) —
    /// `{"values":[[scalar|null,...],...]}`, converted per cell. Writes ONE BatchCommit,
    /// records provenance keyed by `name`, and on re-publish dirties the dependents of
    /// vacated cells. Returns `{ id: name }`. `[bad_argument]` for an inverted/out-of-
    /// bounds target, a result that does not fit, or malformed/non-rectangular/non-scalar
    /// `data`; `[invalid_state]` off a Ready session.
    #[napi(js_name = "publishDataset", catch_unwind)]
    pub fn publish_dataset(
        &self,
        env: Env,
        name: String,
        data: String,
        target: CellRangeJson,
    ) -> Result<PublishedRefJson> {
        guarded(env, "publishDataset", || {
            let data = parse_reserved_json_payload("publishDataset", &data)?;
            let target = session_range_from_json("publishDataset", target)?;
            let result = self
                .inner
                .lock()
                .publish_dataset(&name, data, target)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(PublishedRefJson { id: result.id })
        })
    }

    /// **ENG-FUSION** (§3.5; `qb.bind()`): register `bindingId -> target` as a
    /// `BoundFrame` overlay region (round-trip reads go through `queryRange`). Returns
    /// `{ bindingId }`. `[bad_argument]` for an inverted/out-of-bounds target;
    /// `[sheet_not_found]` for an unknown sheet; `[invalid_state]` off a Ready session.
    #[napi(js_name = "bindRange", catch_unwind)]
    pub fn bind_range(
        &self,
        env: Env,
        binding_id: String,
        target: CellRangeJson,
    ) -> Result<BoundRangeJson> {
        guarded(env, "bindRange", || {
            let target = session_range_from_json("bindRange", target)?;
            let result = self
                .inner
                .lock()
                .bind_range(&binding_id, target)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(BoundRangeJson {
                binding_id: result.binding_id,
            })
        })
    }

    /// Refresh an external source by revision; dirties dependent cells. `revision` is a
    /// u64 (BigInt). A `revision <= last stored` is a no-op (`dirtied:0`). Returns
    /// `{ dirtied, version }`. `[invalid_state]` off a Ready session.
    #[napi(js_name = "refreshSource", catch_unwind)]
    pub fn refresh_source(
        &self,
        env: Env,
        source_id: String,
        revision: BigInt,
    ) -> Result<DirtyResultJson> {
        guarded(env, "refreshSource", || {
            let (sign_bit, revision, lossless) = revision.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "refreshSource: revision must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "refreshSource: revision exceeds u64::MAX (lossy conversion rejected)".into(),
                ));
            }
            let result = self
                .inner
                .lock()
                .refresh_source(&source_id, revision)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(DirtyResultJson {
                dirtied: result.dirtied as f64,
                version: Buffer::from(result.version.0),
            })
        })
    }

    /// Materialize a SQL query result into `target`. `data` is a JSON string (e.g.
    /// `{"sql":"SELECT ..."}`) — the napi `serde-json` feature is off, so it crosses as
    /// opaque text and the engine parses it. Returns `{ id: queryId }`. `[bad_argument]`
    /// for an inverted/out-of-bounds target, a result that does not fit, DDL/DML/
    /// statements, or malformed JSON text; `[sql_error]` for a query that fails to
    /// parse/plan/execute; `[sql_table_build]` if the workbook->Arrow table build fails.
    /// `[invalid_state]` off a Ready session.
    #[napi(js_name = "materializeQuery", catch_unwind)]
    pub fn materialize_query(
        &self,
        env: Env,
        query_id: String,
        target: CellRangeJson,
        data: String,
    ) -> Result<PublishedRefJson> {
        guarded(env, "materializeQuery", || {
            let target = session_range_from_json("materializeQuery", target)?;
            let data = parse_reserved_json_payload("materializeQuery", &data)?;
            let result = self
                .inner
                .lock()
                .materialize_query(&query_id, target, data)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(PublishedRefJson { id: result.id })
        })
    }

    // ============================================================================
    // 6.4-2 (2026-05-28) — function registration over napi.
    //
    // Wires the substrate shipped at 6.4-0 (function-metadata storage + hooks)
    // and 6.4-1 (binder ArgContext migration + PlanCache fn_gen invalidation +
    // M3 sorted_metadata + M5 mapper + I1 LazyShape) to the JS surface.
    // ============================================================================

    /// **6.4-2:** Register a UDF — `metadata` is a `FunctionMetadataJson`
    /// describing the function's contract-§10.2 properties; `implHandle` is the
    /// opaque dispatch-pointer the worker dispatcher will consult at eval time
    /// (6.4-3). v1 stores the handle but does NOT yet dispatch to a Python
    /// worker — that lands at 6.4-3 (Arrow IPC + debugpy).
    ///
    /// **Behavior:**
    /// - Validates every enum string field at the napi boundary; unknown
    ///   strings surface a structured `[bad_argument]` engine error
    ///   (No-Fallbacks; never silent default).
    /// - Dirties + transitive-fans every formula that referenced the
    ///   (previously-unknown) `canonicalName` via the calcgraph hook.
    /// - Bumps the registry's `fn_gen` so the bind cache invalidates for
    ///   formulas needing re-extraction against the new metadata
    ///   (contract §10.3 "re-extract deps" half — option A from the 6.4-0
    ///   audit, shipped at 6.4-1 H3).
    /// - Lifecycle gate: rejects on Closed/Busy/New/Faulted with
    ///   `[invalid_state]` or `[session_busy]`.
    ///
    /// **Errors (Appendix A):**
    /// - `[function_exists]` — canonical name already registered (built-in
    ///   or existing UDF). `EngineError{Conflict, "function_exists"}`.
    /// - `[bad_argument]` — invalid enum string, OR empty/non-canonical
    ///   (lower-case) canonical_name. **6.4-2 cycle-2 audit-fix (H1):** the
    ///   trait method `WorkbookSession::register_function` VALIDATES the
    ///   canonical name before touching the registry and returns a structured
    ///   `[bad_argument]` for empty/lower-case names. (Pre-fix it forwarded the
    ///   name unchecked and the registry's `assert!` PANICKED across this
    ///   catch_unwind-free boundary, sealing the session — that path no longer
    ///   exists.) Callers should still pass ASCII-uppercase canonical names; the
    ///   IDE is expected to uppercase before the call.
    /// - `[invalid_state]` — session is not Ready.
    #[napi(js_name = "registerFunction", catch_unwind)]
    pub fn register_function(
        &self,
        env: Env,
        metadata: FunctionMetadataJson,
        impl_handle: BigInt,
    ) -> Result<()> {
        guarded(env, "registerFunction", || {
            let meta = function_metadata_from_json(metadata)?;
            // BigInt → u64: the napi-rs `BigInt::get_u64()` returns `(sign_bit,
            // value, lossless)`. Reject negative (sign bit set) + lossy (anything
            // above u64::MAX) loud per No-Fallbacks. Matches the `peerId` validation
            // discipline at `CollabSession::new`.
            let (sign_bit, raw, lossless) = impl_handle.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "registerFunction: implHandle must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "registerFunction: implHandle exceeds u64::MAX (lossy conversion rejected)"
                        .into(),
                ));
            }
            let handle = FunctionImplHandle(raw);
            self.inner
                .lock()
                .register_function(meta, handle)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **6.4-2:** Unregister a UDF. Symmetric to [`Self::register_function`].
    /// Removes BOTH the metadata and the dispatch handle atomically (via the
    /// registry's `unregister_metadata` extension that clears
    /// `udf_handles[name]` on success). Dirties + transitive-fans every
    /// dependent formula via the calcgraph hook; the next eval will surface
    /// `#NAME?` because dispatch is now missing.
    ///
    /// **Errors (Appendix A):**
    /// - `[function_not_found]` — no UDF registered under `canonicalName`.
    /// - `[function_exists]` — `canonicalName` is a built-in (dispatch entry
    ///   still present; the registry's builtin-guard refuses removal). The
    ///   `Conflict / function_exists` class is the same as duplicate-register;
    ///   the message disambiguates (`"is a registered built-in"`).
    /// - `[invalid_state]` — session is not Ready.
    #[napi(js_name = "unregisterFunction", catch_unwind)]
    pub fn unregister_function(&self, env: Env, canonical_name: String) -> Result<()> {
        guarded(env, "unregisterFunction", || {
            self.inner
                .lock()
                .unregister_function(&canonical_name)
                .map_err(|e| engine_error_to_napi(env, e))
        })
    }

    /// **6.4-2:** List every registered function (built-ins + UDFs) with full
    /// metadata. Returned sorted ascending by `canonical_name` (per the 6.4-1
    /// M3 `sorted_metadata` discipline + the 6.1C H2 deterministic-ordering
    /// rule for snapshot DTOs).
    ///
    /// Allocates the full metadata table (~260 entries at v1; cheap for an
    /// IDE poll). Use sparingly — this is not a per-keystroke surface.
    ///
    /// **Errors:** `[invalid_state]` if the session is Closed/New/Faulted
    /// (Busy is OK — this is a read).
    #[napi(js_name = "listFunctions", catch_unwind)]
    pub fn list_functions(&self, env: Env) -> Result<Vec<FunctionMetadataJson>> {
        guarded(env, "listFunctions", || {
            let metas = self
                .inner
                .lock()
                .list_functions()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(metas.into_iter().map(function_metadata_to_json).collect())
        })
    }

    /// **6.4-3d (2026-05-29):** attach an out-of-process Python-UDF worker to
    /// this session, built from `config` (a trusted-workspace `ProcessWorker`).
    /// The worker is spawned + handshaked EAGERLY here (fail-loud) so a missing
    /// interpreter / protocol mismatch surfaces NOW as a clear error, not later
    /// as a silent `#CALC!` on the first `=MYUDF(..)`. After injecting, the IDE
    /// should call `recalcAll` so existing UDF cells pick up the worker — a UDF
    /// cell computed before injection is a clean `#CALC!` that `recalcDirty`
    /// will NOT heal (see engine `WorkbookSession::set_udf_worker`). Calling
    /// again REPLACES the worker (the prior one is dropped → its child killed).
    ///
    /// **Errors (Appendix A):**
    /// - `[worker_spawn_failed]` — the interpreter could not be launched / the
    ///   worker died during startup (python not found, import error, …).
    /// - `[worker_handshake]` — the worker reported an incompatible protocol
    ///   version.
    /// - `[bad_argument]` — `handshakeTimeoutMs` is negative / non-finite / above
    ///   the 10-minute cap.
    /// - `[invalid_state]` — session is not `Ready` (New / Closed / Faulted); the
    ///   just-spawned worker is dropped (its child killed) without being attached.
    /// - `[session_busy]` — a long operation is in progress.
    ///
    /// **Trust:** the IDE MUST gate this call on workspace trust — spawning a
    /// worker runs arbitrary workspace Python. The engine has no workspace
    /// concept, so the trust gate lives in the IDE (`worker_untrusted_workspace`
    /// is an IDE-side code, never emitted here).
    #[napi(js_name = "setUdfWorker", catch_unwind)]
    pub fn set_udf_worker(&self, env: Env, config: PythonWorkerConfigJson) -> Result<()> {
        guarded(env, "setUdfWorker", || {
            let mut cfg = ql_udf::PythonWorkerConfig::new(&config.python);
            if let Some(module) = config.module {
                cfg.module = module;
            }
            if let Some(paths) = config.pythonpath {
                for p in paths {
                    cfg = cfg.with_pythonpath(p);
                }
            }
            if let Some(udf_module) = config.udf_module {
                cfg = cfg.with_udf_module(udf_module);
            }
            if let Some(ms) = config.handshake_timeout_ms {
                // **6.4-3d audit-fix (LOW):** require a non-negative finite value AND
                // cap it (10 min) so a huge `f64` cannot saturate `as u64` into an
                // effectively-unbounded handshake wait. The inclusive-range
                // `!contains` rejects NaN/Inf (neither is `>= 0.0`) as well as a
                // negative or above-cap value in one expression. Fractional ms
                // truncate (harmless).
                // (6.4-3d Step 5: rewritten from the `ms < 0.0 || ms > MAX` form to
                // satisfy clippy `manual_range_contains` under rust 1.95's stricter
                // `deny(clippy::all)`; behavior-identical.)
                const MAX_HANDSHAKE_MS: f64 = 600_000.0;
                if !(0.0..=MAX_HANDSHAKE_MS).contains(&ms) {
                    return Err(bad_argument_error(format!(
                    "setUdfWorker: handshakeTimeoutMs must be a finite number in [0, {MAX_HANDSHAKE_MS}] ms"
                )));
                }
                cfg.handshake_timeout = std::time::Duration::from_millis(ms as u64);
            }
            // Spawn + handshake EAGERLY (outside the session lock — the spawn is a
            // process op) so a failure is reported here, not deferred to first call.
            // **NOTE (audit MED, filed for IDE Step 5):** this is a SYNCHRONOUS napi
            // method and blocks the calling JS thread for up to the handshake timeout
            // — the IDE MUST call it off the UI/main thread.
            let mut worker = ql_udf::ProcessWorker::new(cfg);
            worker.ensure_started().map_err(udf_spawn_error_to_napi)?;
            // **6.4-3d audit-fix (HIGH-3):** inject UNDER the lock via the
            // lifecycle-gated setter — a Closed/Faulted/New/Busy session rejects with
            // `[invalid_state]`/`[session_busy]` and the just-spawned `worker` drops
            // here (its child killed + reaped), closing the inject-vs-close race.
            self.inner
                .lock()
                .set_udf_worker_checked(Box::new(worker))
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(())
        })
    }

    /// **6.4-3d Step 5 (2026-05-29):** drain a page of structured events from the
    /// session's event ring (contract §9), starting at `cursor` (pass `0n` to read
    /// from the start, then the returned `nextCursor` on each subsequent call).
    /// Reading does NOT drain the ring, so independent pollers never starve each
    /// other. The IDE consumes this to surface `cell_diagnostic` events (the UDF
    /// no-worker / raised / timeout / died sink from 6.4-3d Steps 1-3) as cell
    /// tooltips, plus `recalc_progress` / `operation_completed` for long ops.
    ///
    /// If `dropped == true` (paired with a `full_resync_required` event) the
    /// consumer fell behind the retention horizon and MUST reseed via `snapshot()`
    /// (v1 uses an unbounded ring, so this never fires yet).
    ///
    /// **Lifecycle:** unlike the mutators, the engine `poll_events` does NOT gate
    /// on lifecycle (it is a pure read of the buffered ring) — polling a Closed
    /// session returns whatever was already buffered, never `[invalid_state]`.
    ///
    /// **Errors:** `[bad_argument]` if `cursor` is negative or exceeds `u64::MAX`.
    #[napi(js_name = "pollEvents", catch_unwind)]
    pub fn poll_events(&self, env: Env, cursor: BigInt) -> Result<EventPageJson> {
        guarded(env, "pollEvents", || {
            // BigInt → u64, mirroring the `registerFunction` implHandle discipline:
            // reject a negative (sign bit) or lossy (> u64::MAX) cursor loud per
            // No-Fallbacks rather than silently truncating to a wrong ring position.
            let (sign_bit, raw, lossless) = cursor.get_u64();
            if sign_bit {
                return Err(bad_argument_error(
                    "pollEvents: cursor must be a non-negative BigInt".into(),
                ));
            }
            if !lossless {
                return Err(bad_argument_error(
                    "pollEvents: cursor exceeds u64::MAX (lossy conversion rejected)".into(),
                ));
            }
            let page = self
                .inner
                .lock()
                .poll_events(ql_session::session::EventCursor(raw))
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(event_page_json_from_session(page))
        })
    }

    // ============================================================================
    // 6.3-3 (2026-05-30) — live-grid + ops over napi.
    //
    // Binds the already-implemented `EngineSession` delta/undo/redo methods on the
    // owning `Session` class (the remaining live-grid cluster — `cancel`/
    // `operationStatus`/`pollEvents` landed at 6.3-1b/c + 6.4-3d). Each inherits
    // the locked 6.3-1 contract — `guarded(env,..)` + `catch_unwind`, native
    // `engine_error_to_napi`. The opaque `SessionVersion` round-trips as a
    // `Buffer`; the IDE seeds from `snapshot()` then pulls `snapshotDelta`.
    // ============================================================================

    /// Compute the incremental delta since the caller's `lastVersion` token (the
    /// `version` from a prior `snapshot`/`snapshotDelta`/`batch`/`undo`/`redo`).
    /// A first/stale/unrecognized token is NOT an error — the engine returns
    /// `fullRebuildRequired = true` with a `fullRebuildReason` and the caller
    /// reseeds via `snapshot()`. `schemaVersion` is forwarded from the engine
    /// delta. `[invalid_state]` off a readable session.
    #[napi(js_name = "snapshotDelta", catch_unwind)]
    pub fn snapshot_delta(
        &self,
        env: Env,
        last_version: Buffer,
    ) -> Result<WorkbookSnapshotDeltaJson> {
        guarded(env, "snapshotDelta", || {
            let last = ql_session::SessionVersion(last_version.to_vec());
            let delta = self
                .inner
                .lock()
                .snapshot_delta(&last)
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(workbook_snapshot_delta_json_from_session(delta))
        })
    }

    /// Undo the last committed step. Returns `{ consumed, version }`: an empty
    /// undo stack yields `consumed: false` (NOT an error). Undo/redo clears the
    /// delta cache, so the next `snapshotDelta` against an older token
    /// full-rebuilds. `[invalid_state]` off a Ready session.
    #[napi(js_name = "undo", catch_unwind)]
    pub fn undo(&self, env: Env) -> Result<UndoRedoResultJson> {
        guarded(env, "undo", || {
            let r = self
                .inner
                .lock()
                .undo()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(UndoRedoResultJson {
                consumed: r.consumed,
                version: Buffer::from(r.version.0),
            })
        })
    }

    /// Redo the last undone step. Symmetric to [`Self::undo`] — an empty redo
    /// stack yields `consumed: false` (NOT an error). `[invalid_state]` off a
    /// Ready session.
    #[napi(js_name = "redo", catch_unwind)]
    pub fn redo(&self, env: Env) -> Result<UndoRedoResultJson> {
        guarded(env, "redo", || {
            let r = self
                .inner
                .lock()
                .redo()
                .map_err(|e| engine_error_to_napi(env, e))?;
            Ok(UndoRedoResultJson {
                consumed: r.consumed,
                version: Buffer::from(r.version.0),
            })
        })
    }

    /// Whether an undo step is available (pure read; `guarded` for the panic
    /// boundary). Never throws on a Ready session.
    #[napi(js_name = "canUndo", catch_unwind)]
    pub fn can_undo(&self, env: Env) -> Result<bool> {
        guarded(env, "canUndo", || Ok(self.inner.lock().can_undo()))
    }

    /// Whether a redo step is available (pure read). Never throws on a Ready
    /// session.
    #[napi(js_name = "canRedo", catch_unwind)]
    pub fn can_redo(&self, env: Env) -> Result<bool> {
        guarded(env, "canRedo", || Ok(self.inner.lock().can_redo()))
    }
}

/// **M1 (6.3-1a) — test-only panic-boundary probe, in its OWN whole-block-gated
/// impl.** The `#[cfg(debug_assertions)]` MUST gate the entire `#[napi] impl`
/// block, not a single method inside the main (unconditionally-compiled) block:
/// napi-derive emits an ungated module-level registration that references the
/// per-method callback, so a method-level `cfg` removes the body in release
/// while leaving a dangling registration symbol → the **release cdylib fails to
/// link** (6.3-1a closure-audit HIGH; mirrors the `BlockingTransportFixture`
/// whole-block `cfg` pattern). Whole-block gating keeps the probe entirely
/// absent from release builds.
///
/// Forces a Rust panic INSIDE [`guarded`] so `tests/smoke_session.mjs` can
/// assert end-to-end that a panic in a `#[napi]` method surfaces as a `[panic]`
/// JS error and does NOT abort the Node host — and that the session remains
/// usable afterward (a bare panic here does not arm the engine `FaultGuard`, so
/// it is recoverable, unlike a panic through `run_recalc`). This is the only way
/// to exercise the boundary, since `cargo test` cannot link the napi runtime
/// symbols standalone.
#[cfg(debug_assertions)]
#[napi]
impl Session {
    #[napi(js_name = "__forcePanicForTest", catch_unwind)]
    pub fn force_panic_for_test(&self, env: Env) -> Result<()> {
        guarded(env, "__forcePanicForTest", || -> Result<()> {
            panic!("forced panic for the M1 panic-boundary smoke test");
        })
    }
}

// **Phase 6.1B inc.2d (2026-05-27) — Send + Sync positive proof (audit Rule 4).**
//
// `Session { inner: Arc<Mutex<CoreWorkbookSession>> }` mirrors `CollabSession`:
//   - `CoreWorkbookSession` (`ql_exec::WorkbookSession`) is asserted `Send`
//     below. It owns the same Loro substrate (an `OpLog` + a `loro::UndoManager`,
//     each holding an internal `Arc<LoroDoc>`) as `CoreCollabSession` (documented
//     `Send + !Sync`), plus `Workbook` / `CalcgraphSession` / `PlanCache` /
//     `Arc<FunctionRegistry>` / plain collections.
//   - `parking_lot::Mutex<T>: Send + Sync` when `T: Send` (no poison flag).
//   - `Arc<T>: Send + Sync` when `T: Send + Sync`.
//   - Therefore `Session` is `Send + Sync`.
//
// If `assert_send::<CoreWorkbookSession>()` fails to compile, that is a REAL
// contract finding — the owning engine session is not FFI-shareable as-is — NOT
// something to paper over. Surfacing exactly this class of gap is the point of
// migrating the Node path early (decision-lock risk-mitigation #1).
const _ASSERT_BINDING_SESSION_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}
    assert_send::<CoreWorkbookSession>();
    assert_send::<Session>();
    assert_sync::<Session>();
};
