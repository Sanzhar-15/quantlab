//! `CollabSession` — per-peer collaboration state holder.
//!
//! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
//! with peer-id-aware operations + transport plumbing. Subsequent
//! phases populate richer behavior:
//!
//! - ~~**Phase 5.4**~~ ✅ V1 + V2 V1 + V2 V1.1 shipped — V1
//!   `89c02b9d83e`: 7 undo/redo methods. V2 V1 `6138a7203f6` +
//!   `e199a5fda5a`: `start_undo_group` / `end_undo_group` +
//!   `set_undo_merge_interval`. V2 V1.1: `start_undo_group_scoped`
//!   returns RAII `UndoGroupGuard` for panic/Err-safe grouping.
//!   Presence-origin commits auto-excluded.
//! - ~~**Phase 5.5**~~ ✅ V1 + V2 V1 + V2 V2 + V2 V3 V1 + V2 V4 V1 SHIPPED
//!   2026-05-21. V1 (`924750819bc`) -- `Transport` trait, `LoopbackTransport`,
//!   `NoopTransport`. V2 V1 (`ffd8f6e5f05`) -- attach/detach/has,
//!   `flush_to_transport`, `poll_remote*` typed methods. V2 V2
//!   (`51748b02944`, `b7aa4cb7bb9`) -- `AutoFlushPolicy::OnAppend`.
//!   V2 V3 steps 1-6 (`603bdc9aa6c` to `8a8236840f2`) -- delta flush,
//!   poll-side auto-flush, offline-write contract, WebSocket impl
//!   (`ql-collab-ws`), 3-way megaudit, exit packet. V2 V4 V1
//!   (`3342e21b964` to `397676899fb`) -- ack channel
//!   (`flush_pending_to_transport`), `pending_op_count`,
//!   `discard_pending_ops`, defensive hardening. V2 V4 V2 (K4 chunking)
//!   deferred. See `docs/phase5/v2-v3-exit-packet.md` and
//!   `docs/phase5/v2-v4-v1-exit-packet.md`.
//! - ~~**Phase 5.6**~~ ✅ V1 + V2 shipped — V1 `c677e244704`:
//!   `presence` module + 4 typed methods. V2: `sweep_presence`
//!   (caller-opt-in clean-slate on rejoin; closes V1 known
//!   persistence limitation).
//! - **Phase 5.7** ✅ V1 SHIPPED 2026-05-22 (cross-repo at engine
//!   `677ee03ee8b` → `6003db4ce2c` + IDE `1a7fc8bbe3f` → `a517d7c5f71`).
//!   New `crates/ql-bindings-node/` (napi-rs cdylib) binds
//!   `CollabSession` for the quantlab VS Code fork's extension
//!   host. V1 surface = constructor / `fromSnapshot` /
//!   `appendPutValue` / `exportBytes` / `mergeBytes` / observability
//!   accessors. V2 will bind Transport (3-5d, recommended next).
//!   V3 will bind `rebuild_workbook` + full Op enum + undo/redo +
//!   presence + persistence (cell-grid UI; 1-2wk). See
//!   `docs/phase5/5-7-v1-exit-packet.md`.
//!
//! What ships in 5.2.a (5.2.b update 2026-05-19):
//!
//! - `CollabSession::new(peer_id)` — fresh session with an empty
//!   `OpLog` and the peer-id wired through to
//!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
//!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
//!   fallible.
//! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
//!   shared base snapshot (used by both peers in the D-4 probe
//!   pattern). The reborn session's peer id is `peer_id`; existing
//!   ops in the imported snapshot retain their original
//!   attribution.
//! - `append_op(&mut self, Op)` — local append; delegates to
//!   `OpLog::append`.
//! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
//!   snapshot via Loro's CRDT merge; delegates to
//!   `OpLog::merge_bytes`.
//! - `export_bytes(&self)` — produce a snapshot for transport.
//! - `op_log(&self)` — read-only view of the underlying log
//!   (for replay against a workbook).
//! - `peer_id(&self)` — the session's stable peer id.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use loro::LoroValue;
use thiserror::Error;

use ql_functions::FunctionRegistry;
use ql_oplog::{replay_into, CellWireValue, Op, OpLog, OpLogError, PeerId, ReplayError, PRESENCE_COMMIT_ORIGIN};

/// **Phase 5.7 V3.4.0.2 (2026-05-23) -- per-cell snapshot-cache state.**
///
/// Internal cache-value type for `CollabSession::last_snapshot`.  Carries
/// the LAST-WRITE-WINS view of a single cell across the cell-keyed
/// `Op` variants the cache models (V3.4.0.2: `PutValue`, `PutFormula`,
/// `ClearFormula`).
///
/// **Why an Option<T> per field**: a cell may legitimately have a formula
/// without a literal value (e.g., `=A1+1` with no fallback Pending), and
/// vice versa.  Both fields are independently mutable via separate `Op`
/// variants; the LWW semantic is per-FIELD, not per-cell.
///
/// **Why this lives in `ql-collab/src/session.rs` (NOT `ql-oplog`)**:
/// `CellState` is a SESSION-CACHE type, not a wire type.  The wire
/// `Op` enum is unchanged.  The cache shape can evolve (e.g., V3.5+ adds
/// `format: Option<FormatId>` for `SetCellFormat`) without touching the
/// `ql-oplog` ABI.
///
/// **V3.4.0.1 decision D1 (hybrid)** locked this shape.  Cell-keyed
/// ops feed `CellState`; non-cell-keyed ops (`SetName`, `AddSheet`, etc.)
/// continue to live on `Workbook` state and are NOT cache-mirrored.
///
/// **Rule 4 per-field walk** (per V3.4.0.1 audit discipline +
/// V3.3.0.3 closure of V3.2.d Opus M4):
/// - `Option<T>`: `Send + Sync` when `T: Send + Sync` (std auto-trait).
/// - `value: Option<CellWireValue>`: `CellWireValue` is `Send + Sync`
///   per V1 audit (enum of f64 / bool / String / String / unit; all
///   variants Send + Sync).
/// - `formula: Option<String>`: `String` is `Send + Sync` trivially.
/// - **`format: Option<FormatId>` (V3.5.0.5 addition, 2026-05-24)**:
///   `FormatId` is `Builtin(u32) | Custom(PeerId, u32)` per D-1
///   (Phase 5.2 step 4) -- `u32` is Send + Sync + Copy trivially;
///   `PeerId(pub u64)` is Send + Sync + Copy trivially (newtype
///   around u64).  Composition: `FormatId: Send + Sync + Copy`
///   (enum of all-Copy variants).  `Option<FormatId>` is Send + Sync.
///   **No new Rule 4 trigger**; arc terminus stays at 6.
/// - Composition: `CellState: Send + Sync`.  Inherits external
///   synchronization from `Arc<Mutex<CollabSession>>` (V2.4 audit;
///   per-field walk in `ql-bindings-node/src/lib.rs::CollabSession`
///   docstring).
///
/// **No new negative-trait claim introduced.**  Rule 4 arc terminus
/// stays at 6 (V3.5.0.5 format field is a positive Send+Sync walk
/// over D-1's tagged FormatId enum).
///
/// **PartialEq** but NOT `Eq` because `CellWireValue` contains `f64`
/// which doesn't implement `Eq` (NaN != NaN).  Tests can still use
/// `assert_eq!`; that calls `PartialEq::eq` which is fine for non-NaN
/// numeric comparisons.  `FormatId` is `Eq` so doesn't change the
/// CellState's PartialEq-only property.
///
/// ## V3.5.0.5 per-field LWW semantics (extends V3.4.0.2)
///
/// - `Op::PutValue` writes `state.value`, preserves `formula` + `format`.
/// - `Op::PutFormula` writes `state.formula`, preserves `value` + `format`.
/// - `Op::ClearFormula` clears `state.formula`, preserves `value` + `format`.
/// - **`Op::SetCellFormat { id: Some(_) }` writes `state.format`, preserves
///   `value` + `formula`** (V3.5.0.5 new).
/// - **`Op::SetCellFormat { id: None }` clears `state.format`, preserves
///   `value` + `formula`** (V3.5.0.5 new; the W5-80 "clear overlay" semantic).
///
/// A cell can carry ANY combination of (value, formula, format).  E.g.,
/// `state.value = Some(42.0); state.formula = Some("=A1+1"); state.format =
/// Some(FormatId::Builtin(2))` is a formula-evaluated-to-42-rendered-as-
/// number-with-2-decimals cell.
///
/// ## Ghost-entry avoidance (V3.5.0.5 extends V3.4.0.X MEDIUM-1)
///
/// When ALL THREE fields are `None` after an op, the cache key is
/// REMOVED entirely (not left as an empty `CellState`).  Pre-V3.5.0.5
/// this rule covered (value, formula); V3.5.0.5 extends it to include
/// format -- otherwise a `SetCellFormat { id: None }` on a never-written
/// cell would leave a phantom cache entry that surfaces in
/// `list_sheets_from_cache`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellState {
    pub value: Option<CellWireValue>,
    pub formula: Option<String>,
    pub format: Option<FormatId>,
}

/// **Phase 5.7 V3.4.0.X HIGH-1 + MEDIUM-1 closure (2026-05-24)**: internal
/// representation of a single cache mutation extracted from an `Op`.
///
/// Lives at module scope (NOT inside `append_op`) so that both `append_op`
/// (O(1) live update) and `rebuild_snapshot_cache` (full walk) can use the
/// same `collect_cache_effects` + `apply_cache_effect` helpers.
/// Pre-V3.4.0.X this enum was local to `append_op` and the rebuild path
/// duplicated the match logic; the two paths drifted (rebuild ignored
/// `BatchCommit`, append did not handle ghost-cell formula-only delete).
/// Hoisting to module scope eliminates the drift surface.
enum CacheEffect {
    PutValue { key: (u16, u32, u32), value: CellWireValue },
    PutFormula { key: (u16, u32, u32), text: String },
    ClearFormula { key: (u16, u32, u32) },
    /// **V3.5.0.5 (2026-05-24)**: cell-keyed format set/clear.
    /// `format: Some(_)` writes `state.format`; `format: None` clears
    /// it (per `Op::SetCellFormat`'s `Option<FormatIdWire>` contract).
    /// Apply uses `get_mut` + skip-if-absent (ghost-entry avoidance,
    /// analogous to ClearFormula); clearing on a never-written cell
    /// is a no-op for the cache.  Formula-only-key removal extended:
    /// if both `value` and `formula` AND `format` are None after the
    /// apply, the entry is removed entirely.
    SetCellFormat { key: (u16, u32, u32), format: Option<FormatId> },
    /// **V3.5.0.X audit-closure Opus-H1 extension (2026-05-24)**:
    /// sheet tombstoned via `Op::RemoveSheet`.  Apply: insert the id
    /// into the tombstone tracker AND drop all existing snapshot
    /// entries for that sheet from `last_snapshot`.  All subsequent
    /// cell-keyed effects targeting the same sheet are silently
    /// dropped (matching the V3.5.0.3b engine-replay tombstone
    /// guard semantic, which the live cache walker previously
    /// LACKED -- the leak surfaced as phantom entries in
    /// `list_sheets_from_cache`).
    RemoveSheet { id: u16 },
    /// **V3.6.0.3 D2 (2026-05-24)**: session-wide format-table cache
    /// update from `Op::RegisterFormat`.  Apply: insert `(id, string)`
    /// into `format_table_cache`.
    ///
    /// **LWW caveat**: the engine `Workbook::FormatTable::register_at`
    /// REJECTS same-id-different-string registrations (returns
    /// `FormatTableError::AlreadyRegistered`).  The cache walker is
    /// downstream of replay and accepts all RegisterFormat effects
    /// blindly (LWW per iteration order); a cross-peer concurrent
    /// `Op::RegisterFormat { id: SAME, string: DIFFERENT }` would
    /// produce a cache that ends with the LAST iterated string but a
    /// Workbook that has the FIRST.  Acceptable because the napi
    /// `workbook_snapshot.formats` reads from the Workbook (authoritative
    /// source); the cache is internal-only discipline + future-use
    /// (V3.7+ incremental snapshot deltas).  V3.7+ could close the
    /// divergence by mirroring the rejection logic in the walker.
    ///
    /// `string` uses `Arc<str>` for cheap clones across the walker
    /// (collect_cache_effects -> apply_cache_effect).
    RegisterFormat { id: FormatId, string: Arc<str> },
}
use ql_storage::{FormatId, Workbook};

use crate::presence::{self, PresenceError, PresenceState};
use crate::repair::{
    repair_column_rename_chain, repair_sheet_rename_chain, repair_table_rename_chain,
    ColumnRepairReport, SheetRepairReport, TableRepairReport,
};
use crate::transport::{Transport, TransportError};

/// **Phase 5.5 V2 V1 audit closure (2026-05-19):** default cap on
/// the number of blobs `CollabSession::poll_remote` drains per
/// call. Prevents one poll from starving the calling thread when
/// an externally-fed transport produces faster than we merge.
/// Callers wanting a different bound use `poll_remote_with_limit`.
pub const DEFAULT_POLL_REMOTE_LIMIT: usize = 64;

// Phase 5.5 V2 V1 audit closure: pin the Send contract the
// docstring promises ("callers can move sessions between threads
// with attached transports"). If a future Loro dep bump or field
// addition breaks Send, this stops compiling.
const _ASSERT_COLLAB_SESSION_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<CollabSession>();
};

// **V2 V4 V1 step 3 audit closure (Codex L1 + Opus M1, 2026-05-21):**
// CollabSession is Send but NOT Sync — the
// `Option<Box<dyn Transport + Send>>` field carries no Sync bound on
// the trait object, so the field is `?Sync` and the struct inherits
// `!Sync`. This contrasts with `WebSocketTransport` (the concrete
// type), which IS Sync since all its concrete fields happen to be
// Sync. Compile-asserting `!Sync` is awkward in stable Rust;
// documented here via a probe-then-commented-out pattern so a future
// reader can verify the bound by un-commenting and watching the
// build error message naming the !Sync field.
//
// fn assert_collab_session_not_sync() {
//     fn assert_sync<T: Sync>() {}
//     assert_sync::<CollabSession>();  // EXPECTED COMPILE ERROR
// }

/// Errors emitted by `CollabSession` operations.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CollabSessionError {
    /// The underlying `OpLog` failed (Loro encode/decode, serde,
    /// etc.). Surfaces the wrapped `OpLogError` for diagnosis.
    #[error("op log error: {0}")]
    OpLog(#[from] OpLogError),

    /// A presence-layer call failed (serde, peer-key parse,
    /// underlying OpLog).
    #[error("presence error: {0}")]
    Presence(#[from] PresenceError),

    /// **Phase 5.4 V1:** a Loro `UndoManager` call (`undo` /
    /// `redo`) returned an error. Reachable when the underlying
    /// document is in an invalid state for the requested
    /// operation (e.g. mid-transaction).
    #[error("undo/redo error: {0}")]
    Undo(#[from] loro::LoroError),

    /// **Phase 5.5 V2 (2026-05-19):** the attached `Transport`
    /// returned an error.
    ///
    /// For `flush_to_transport`: the local `OpLog` is unaffected
    /// (the snapshot export happened first; the failed step was
    /// `Transport::send`). Caller can retry the flush.
    ///
    /// For `poll_remote`: any bytes successfully drained BEFORE
    /// the error were already `merge_bytes`'d into the local
    /// `OpLog` — those merges persist. The error indicates the
    /// transport itself is misbehaving (`Io`) — `Closed` is
    /// handled gracefully by `poll_remote` itself (returns
    /// `Ok(merged)`, see Codex+Opus 5.5 V2 V1 audit closure).
    /// Caller should detach + reattach a new transport instead
    /// of retrying poll.
    #[error("transport error: {0}")]
    Transport(#[from] TransportError),

    /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
    /// (Opus-A Scenario E HIGH).** `rebuild_workbook` invoked
    /// `replay_into` on the session's `OpLog` and replay failed at
    /// some op index. The fresh workbook constructed internally was
    /// in a HALF-MERGED state when the error fired and was DROPPED
    /// before the error was returned (the wrapper owns it). The
    /// session's `OpLog` is unaffected (replay reads only).
    ///
    /// Carries the underlying [`ReplayError`] via `#[source]` so
    /// callers can `match err.source()` for the original op index +
    /// diagnostic.
    #[error("replay error: {0}")]
    Replay(#[from] ReplayError),
}

impl CollabSessionError {
    /// **Phase 5.7 V2.7 (2026-05-22) — error-code discrimination.**
    ///
    /// Returns a stable `&'static str` identifier for this variant.
    /// For `Transport(inner)`, returns the inner `TransportError`'s
    /// kind (e.g. `"transport_closed"`) so JS callers can branch on
    /// the underlying transport state without unwrapping a wrapper
    /// kind. For all other variants, returns the wrapper kind
    /// directly (e.g. `"session_undo"`).
    ///
    /// **Stability**: see [`crate::TransportError::kind`].
    pub fn kind(&self) -> &'static str {
        match self {
            CollabSessionError::OpLog(_) => "session_oplog",
            CollabSessionError::Presence(_) => "session_presence",
            CollabSessionError::Undo(_) => "session_undo",
            CollabSessionError::Transport(inner) => inner.kind(),
            CollabSessionError::Replay(_) => "session_replay",
        }
    }
}

/// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
/// (Opus-A Scenario E HIGH):** result of
/// [`CollabSession::rebuild_workbook`]. Combines the replay op count
/// with the two repair reports so callers can log a single
/// diagnostic surface.
///
/// `#[non_exhaustive]` per Codex step 5b audit LOW closure: column
/// repair (Phase 5.3 step 5c) is expected to add another field
/// (`column_repair: ColumnRepairReport`) — external struct literal
/// construction is forbidden so future field additions are
/// non-breaking.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct SyncReport {
    /// Total ops applied by `replay_into`. Same as the success
    /// value of `replay_into` itself.
    pub ops_replayed: usize,
    /// Sheet rename-repair pass diagnostics (formulas rewritten,
    /// ambiguous-skipped rules).
    pub sheet_repair: SheetRepairReport,
    /// Table rename-repair pass diagnostics.
    pub table_repair: TableRepairReport,
    /// Column rename-repair pass diagnostics (Phase 5.3 step 5c —
    /// closes Opus-A megaudit V1 LIM #3 HIGH).
    pub column_repair: ColumnRepairReport,
}

/// Phase 5.3 step 5b audit closure (Opus MEDIUM-2) + step 5c update:
/// one-line `Display` impl for log-line diagnostic use. Format:
/// `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`.
impl std::fmt::Display for SyncReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "sync: ops={} sheet_rewrites={}(skip={}) table_rewrites={}(skip={}) column_rewrites={}(skip={})",
            self.ops_replayed,
            self.sheet_repair.formulas_rewritten,
            self.sheet_repair.ambiguous_rules_skipped.len(),
            self.table_repair.formulas_rewritten,
            self.table_repair.ambiguous_rules_skipped.len(),
            self.column_repair.formulas_rewritten,
            self.column_repair.ambiguous_rules_skipped.len(),
        )
    }
}

/// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy for
/// [`CollabSession`]. Determines when (if ever) the session pushes
/// its current snapshot through the attached transport without an
/// explicit [`CollabSession::flush_to_transport`] call.
///
/// V2 V2 (this ship) adds two variants. V2 V3 will add a `Threshold`
/// variant for byte-budget-based batching.
///
/// `#[non_exhaustive]` so adding a `Threshold(usize)` variant later
/// is non-breaking — callers MUST handle the `_` arm in `match`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum AutoFlushPolicy {
    /// Default. V2 V1 behavior preserved: caller drives flush + poll
    /// explicitly via [`CollabSession::flush_to_transport`] +
    /// [`CollabSession::poll_remote`]. Auto-flush never fires.
    #[default]
    Disabled,
    /// Flush automatically after every public method that mutates the
    /// underlying `LoroDoc`. Triggers on: `append_op`, `merge_bytes`,
    /// `update_presence`, `clear_presence`, `sweep_presence`,
    /// `undo`, `redo`, `poll_remote`, `poll_remote_with_limit`.
    ///
    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** auto-flush routes
    /// through [`flush_delta_to_transport`] (delta path) rather than
    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
    /// O(per-op delta) instead of O(full state). The idempotency
    /// short-circuit means a flush after no state change is a true
    /// no-op (no transport.send invocation) — this closes the V2 V2
    /// audit echo-loop class.
    ///
    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** `poll_remote*` now
    /// triggers auto-flush AFTER the drain batch (one flush per
    /// call, not per-blob) — bandwidth-efficient. Reverses the V2 V2
    /// "receive-side excluded by design" exclusion now that V2 V3
    /// step 1's idempotency guard prevents echo loops at the source
    /// (Loro-deduped merge leaves VV unchanged → flush short-circuits
    /// to `Ok(false)`). The 3-peer hub-fanout pattern now works
    /// automatically.
    ///
    /// Does NOT trigger on:
    /// - Accessor methods (read-only).
    /// - Undo-group boundary methods (`start_undo_group` /
    ///   `end_undo_group`) — only their inner appends fire, via
    ///   `append_op`. Each mid-group append produces ONE auto-flush;
    ///   the group is a LOCAL undo unit only (peers see each append
    ///   land independently). Phase 5.5 V2 V2 audit closure (Opus
    ///   L1) — undo-group atomicity-over-wire deferred to V2 V3.
    /// - Transport-lifecycle methods (`attach_transport` etc.).
    ///
    /// If no transport is attached, this is silently a no-op (the
    /// flush hook checks `self.transport.is_some()` first).
    ///
    /// **Partial-state contract on auto-flush error**: if the auto-
    /// flush attempt fails (transport closed, I/O error), the
    /// surrounding mutator (`append_op` etc.) returns
    /// `Err(CollabSessionError::Transport(_))`. The local mutation
    /// has ALREADY been committed to `self.log` (mutate-then-flush
    /// ordering — Loro doesn't support "ungrowing" an op log, V1
    /// limitation H7). Callers MUST treat their local state as
    /// authoritative for the local UI and either retry the flush
    /// (transport recovered) or detach the transport.
    ///
    /// **Symmetric-OnAppend (Phase 5.5 V2 V3 step 1 closure,
    /// 2026-05-21):** enabling `OnAppend` on BOTH peers of a paired
    /// transport is safe via the V2 V3 idempotency guard. The
    /// guard short-circuits `flush_delta_to_transport` when no ops
    /// have been appended since the last successful flush. A
    /// merged peer-snapshot that didn't actually advance local
    /// state (Loro CRDT dedupe) leaves the VV unchanged, so the
    /// subsequent auto-flush is a no-op send. The original V2 V2
    /// echo-loop concern is closed at the source. With V2 V3 step 2,
    /// `poll_remote` also auto-flushes — the round-trip back to the
    /// SAME paired transport hits the idempotency guard if the
    /// drained bytes were duplicates, otherwise sends the delta
    /// (peer's Loro dedupes any ops it already has).
    ///
    /// **V1 limit (V2 V3 step 2)**: auto-flush from `poll_remote`
    /// goes back to the SAME transport the bytes came from. In a
    /// true multi-transport hub topology, the merged state would
    /// only fan to ONE transport per session. V2 V3 step 4
    /// (WebSocket + multi-transport routing) may add per-transport
    /// fanout.
    ///
    /// **V1 bandwidth cost — symmetric-OnAppend 2× wire amplification
    /// (V2 V3 step 5 megaudit closure, Opus-B M6, 2026-05-21)**: in a
    /// symmetric 2-peer pairing (A↔B both OnAppend), every appended
    /// op pays a round-trip duplicate wire cost. Trace: A.append →
    /// flush sends to B → B.poll_remote drains → B.maybe_auto_flush
    /// fires (B's VV advanced) → B sends the merged delta (containing
    /// A's op) BACK to A → A.poll_remote drains → A.merge_bytes
    /// Loro-dedupes → A's VV unchanged → A.maybe_auto_flush
    /// idempotency-short-circuits (no further send). The loop
    /// terminates correctly (no echo loop, the V2 V3 step 1 idempotency
    /// guard prevents it), but each op costs 2× wire upload on average.
    /// For multi-peer mesh topologies, the amplification compounds —
    /// V2 V4 per-transport baselines (one `last_flushed_vv` per
    /// attached transport instead of per-session) will close this.
    /// V1-accepted cost; documented in case IDE consumers see "double
    /// bandwidth in network profiler" and need to know it's by design.
    OnAppend,
}

/// Per-peer collaboration state holder.
///
/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
/// at scaffold time; Phase 5.5 will add the live transport
/// integration via `Transport::send` / `try_recv`.
///
/// The session is the engine-side handle for one peer's view of a
/// shared workbook. Multiple peers each hold their own
/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
/// and call `merge_bytes` to incorporate remote ops. All sessions
/// converge to the same `OpLog` content after exchange (per Loro's
/// CRDT determinism — Phase 5.1 audit Codex V1).
pub struct CollabSession {
    peer_id: PeerId,
    log: OpLog,
    /// Phase 5.4 V1 — peer-local undo/redo.
    ///
    /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
    /// in DECLARATION order, so this drops LAST (after `log`).
    /// That is safe here because `loro::UndoManager` owns its own
    /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
    /// borrow from `log`'s doc and won't UAF when `log` drops first.
    undo: loro::UndoManager,
    /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
    /// transport. `None` until `attach_transport` is called.
    /// Boxed + `Send` so callers can move sessions between
    /// threads with attached transports.
    ///
    /// V2 V1 scope was explicit-drive (caller invokes flush + poll
    /// on a tick). V2 V2 (2026-05-21) adds `AutoFlushPolicy::OnAppend`
    /// for IDE callers who want every mutator to propagate.
    transport: Option<Box<dyn Transport + Send>>,
    /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy. Default
    /// is `Disabled` so existing V2 V1 callers see no behavior
    /// change. Set via [`set_auto_flush_policy`].
    auto_flush_policy: AutoFlushPolicy,
    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** tracks the
    /// `loro::VersionVector` at the time of the last successful
    /// `flush_to_transport` / `flush_delta_to_transport` call.
    ///
    /// `None` means "no successful flush yet" — the next delta-flush
    /// sends from the empty VV (= all ops the doc has ever seen).
    ///
    /// Lifecycle:
    /// - Initialized `None` in `new` + `from_snapshot`.
    /// - Reset to `None` on `attach_transport` (a new transport-peer
    ///   needs the full state from scratch) and `detach_transport`
    ///   (orphaned VV is meaningless).
    /// - Updated to `Some(current_vv)` after a successful send via
    ///   either `flush_to_transport` (full snapshot path) or
    ///   `flush_delta_to_transport` (V2 V3 delta path).
    /// - NOT updated on flush failure (`Err`) — caller can retry.
    last_flushed_vv: Option<loro::VersionVector>,

    /// **Phase 5.7 V3.3.0.3 (2026-05-22) -- incremental snapshot cache.**
    ///
    /// Keyed by `(sheet, row, col)`; value = LAST-WRITE-WINS state for
    /// that cell across all peers in the local op log's causal-merge
    /// order.  Read by [`Self::snapshot_cells`] + the napi
    /// `CollabSession::export_snapshot` accessor in
    /// O(total-cells-in-cache) instead of O(N) in op count.  Closes
    /// V3.2.d Opus MEDIUM-4 (`exportSnapshot` lock-hold time scales
    /// linearly with op log size).
    ///
    /// **V3.4.0.2 (2026-05-23) -- value type extended from `CellWireValue`
    /// to `CellState{value: Option<CellWireValue>, formula: Option<String>}`
    /// per V3.4.0.1 decision D1 (hybrid).**  Cache now models 3 cell-keyed
    /// `Op` variants: `PutValue` (writes `.value`), `PutFormula` (writes
    /// `.formula`), `ClearFormula` (clears `.formula`, preserves `.value`).
    /// Non-cell-keyed ops (`SetName`, `AddSheet`, etc.) continue to live on
    /// `Workbook` state and are NOT cache-mirrored.  V3.5+ extends `CellState`
    /// with `format: Option<FormatId>` for `SetCellFormat` when cell-grid
    /// rendering needs format info.
    ///
    /// **Update paths** (V3.3.0.X audit closure (MEDIUM-2, 2026-05-23):
    /// SEVEN op-log mutation sites + initialization, all enumerated below;
    /// pre-closure the docstring listed only 5 and the docs drifted from
    /// source -- see audit transcript at `docs/audits/2026-05-23-phase-5-7-
    /// v3-3-0-x-{codex,opus}.md`).  V3.4.0.2 extends each path's match arm
    /// from `PutValue`-only to `PutValue` + `PutFormula` + `ClearFormula`):
    /// - `new`: empty initialization.
    /// - `from_snapshot`: rebuilt by walking the imported log.
    /// - `append_op`: O(1) incremental upsert for any of the 3 cell-keyed
    ///   variants (local append is always at the causal frontier;
    ///   iteration order does not reorder existing entries).  Upsert
    ///   PRESERVES the other field of `CellState` (e.g., `PutValue`
    ///   on a cell that has a formula keeps the formula intact).
    /// - `merge_bytes`: REBUILT (atomic-swap rebuild from scratch).
    ///   Loro's CRDT merge can insert remote ops at causally-prior
    ///   positions, which changes the iteration order of EXISTING
    ///   entries; the "latest value at (sheet, row, col)" can shift
    ///   even though the local op log only GROWS.  Full rebuild is
    ///   correct + bounded at O(N) in op count (matches the
    ///   pre-V3.3.0.3 per-`export_snapshot` cost; amortizes if many
    ///   `export_snapshot` calls happen between merges).
    /// - `discard_pending_ops`: REBUILT (the log is replaced via
    ///   `fork_at_vv`, so prior cache entries may reference ops
    ///   no longer in the log).
    /// - `poll_remote_with_limit`: REBUILT after the drain batch
    ///   (the loop calls `self.log.merge_bytes` per blob, bypassing
    ///   the public `Self::merge_bytes` cache invalidation; one
    ///   rebuild at the END of the batch matches the auto-flush
    ///   cadence).
    /// - `undo` / `redo` (V3.3.0.X audit closure -- HIGH-1): both
    ///   methods call `UndoManager::undo`/`::redo` which append an
    ///   inverse op to the visible op log.  Pre-V3.3.0.X audit the
    ///   docstring claimed "every op-log mutation site" was covered
    ///   but undo/redo were NOT.  Now: both methods call
    ///   `rebuild_snapshot_cache()` when `consumed == true`.
    ///
    /// **Read paths**:
    /// - [`Self::snapshot_cells`] -- O(total cache entries); the
    ///   napi `export_snapshot` filters by sheet at the read site
    ///   (acceptable at V3.3 scale of a few sheets).  V3.x may
    ///   nest by sheet for O(cells-on-sheet) reads if profiling
    ///   justifies.
    /// - [`Self::list_sheets_from_cache`] -- O(cells-in-cache) via
    ///   `BTreeSet` walk over the cache keys.  Closes V3.3.0.X
    ///   Opus M3 (pre-closure `napi list_sheets` walked the entire
    ///   op log per call; now derives from cache).
    ///
    /// **Invalidation discipline**: with undo/redo now covered at
    /// V3.3.0.X, the cache stays canonical across every visible
    /// op-log mutation.  V3.4 binds undo/redo via napi + adds new
    /// IDE-side surfaces; the cache invariant holds for that work
    /// without further changes.  R-V3.3-2 closure pre-V3.4 entry.
    /// Test seam `force_clear_snapshot_cache()` (gated on `test-
    /// fixtures` feature) is available for V3.4+ undo-invalidation
    /// regression tests that need to force a cache rebuild
    /// independent of the normal mutation paths.
    ///
    /// **Rule 4 per-field walk** (per V3.3.0.1 audit discipline +
    /// V3.3.0.3 closure of V3.2.d Opus M4 + V3.4.0.2 extension to
    /// `CellState` value type):
    /// - `HashMap<K, V>` is `Send + Sync` when both `K` and `V` are
    ///   `Send + Sync` (std::collections::HashMap is `Send + Sync`
    ///   in its inherent impl, parameterized over `K: Send + Sync,
    ///   V: Send + Sync` for the auto-traits to compose).
    /// - `(u16, u32, u32)`: tuple of `Copy + 'static` integers.
    ///   Trivially `Send + Sync`.
    /// - `CellState`: per its own per-field walk docstring above,
    ///   `Send + Sync` (composition of two `Option<T>` fields whose
    ///   inner types are both `Send + Sync`).
    ///
    /// Therefore `last_snapshot: Send + Sync`.  Inherits external
    /// synchronization from `Arc<Mutex<CollabSession>>` (V2.4 audit;
    /// per-field walk in `ql-bindings-node/src/lib.rs::CollabSession`
    /// docstring).  No new negative-trait claim introduced at V3.4.0.2.
    /// Rule 4 arc terminus stays at 6.
    last_snapshot: HashMap<(u16, u32, u32), CellState>,

    /// **Phase 5.7 V3.5.0.X audit-closure Opus-H1 (2026-05-24) -- cache-walker
    /// tombstone state.**
    ///
    /// Mirrors `Workbook.removed_sheets` (storage-layer tombstone set introduced
    /// at V3.5.0.3b) but lives on the cache walker so the live `append_op`
    /// path + `rebuild_snapshot_cache` can silently drop cell-keyed effects
    /// targeting tombstoned sheets.  Pre-closure, the cache walker was
    /// tombstone-blind: V3.5.0.3b's `Op::RemoveSheet` only updated the
    /// workbook (via engine `apply_op`); subsequent `Op::PutValue` /
    /// `Op::PutFormula` / `Op::ClearFormula` / `Op::SetCellFormat`
    /// (V3.5.0.5) on the tombstoned sheet wrote phantom entries into
    /// `last_snapshot` (workbook_snapshot napi filtered them out at the
    /// top level, but `list_sheets_from_cache` + `snapshot_cells` saw
    /// them; the V3.5.0.X audit caught this as Opus-H1 for SetCellFormat
    /// and the closure widened scope to cover all 4 cell-keyed variants).
    ///
    /// **Update paths** (kept in sync with `last_snapshot` via the cache
    /// walker; same set of mutation sites as `last_snapshot`):
    /// - `new` / `from_snapshot`: rebuilt fresh from the log via
    ///   `rebuild_snapshot_cache` (which iterates ops + tracks
    ///   `CacheEffect::RemoveSheet`).
    /// - `append_op`: incremental update on `Op::RemoveSheet`.
    /// - `merge_bytes` / `discard_pending_ops` / `poll_remote_with_limit` /
    ///   `undo` / `redo`: rebuilt via `rebuild_snapshot_cache`.
    /// - `invalidate_cell` (V3.5.0.6 partial): uses a LOCAL `local_tombstones`
    ///   tracker independent of this session-level set; the per-cell walk
    ///   computes its own tombstone state from the op log.  The session-
    ///   level field is NOT mutated by invalidate_cell.  (Doc previously
    ///   said "consults this set" -- corrected by V3.5.0.X follow-up audit
    ///   CLOSURE-CODEX-LOW-4 docstring drift fix.)
    ///
    /// **Rule 4 per-field walk**: `HashSet<u16>` is `Send + Sync` (std
    /// inherent impl); `u16` is `Copy + Send + Sync` trivially.  0 new
    /// triggers; arc terminus stays at 6.  V3.5.0.X audit-closure added
    /// this field; positive walk.
    removed_sheets: HashSet<u16>,

    /// **Phase 5.7 V3.6.0.2 (2026-05-24) D1 -- Loro UndoManager on_push
    /// callback handoff for partial-invalidate cells.**
    ///
    /// Replaces the V3.5.0.X conservative `pure_local_frontier` gate
    /// (which fell back to full `rebuild_snapshot_cache` whenever any
    /// remote op interleaved between local appends).  V3.6.0.2 wires
    /// Loro's `UndoManager::set_on_push` callback to capture the
    /// affected cells of every pushed op directly into `UndoItemMeta::
    /// value` as a `LoroValue::List<List<I64>>` triple.  `undo()` and
    /// `redo()` read `top_undo_meta()` / `top_redo_meta()` BEFORE
    /// calling the underlying Loro undo/redo, decode the cells, and
    /// fire `invalidate_cell` for each.  Partial-invalidate now fires
    /// correctly regardless of Loro's CRDT iteration order, closing
    /// the V3.5.0.X A-HIGH-1 / Opus-H2 convergent HIGH.
    ///
    /// **Handoff pattern**: `append_op()` pre-stages affected cells
    /// here via `Some(cells)` BEFORE calling `self.log.append(op)`
    /// (which fires `LoroDoc::commit()` -> triggers Loro's on_push
    /// callback synchronously).  The on_push closure reads the Mutex
    /// via `.take()` (drains to None) + encodes as `LoroValue`.
    /// `undo()` / `redo()` also pre-stage cells before their Loro
    /// call so the synthetic inverse op pushed onto the opposite
    /// stack gets the SAME meta (Loro does NOT preserve meta across
    /// stack transitions; see `loro-internal-1.12.0/src/undo.rs:858-872`
    /// which calls `on_push` with `DiffEvent = None` for the inverse).
    ///
    /// **Re-entrancy** (R-V3.6-1 mitigation): on_push runs synchronously
    /// inside `LoroDoc::commit()` which is inside `OpLog::append`.
    /// The Mutex is owned by the closure's Arc clone, NOT by `&mut self`,
    /// so there's no double-borrow.  The closure holds the lock only
    /// long enough to call `.take()` (microseconds).  No async drain
    /// pattern needed.
    ///
    /// **Rule 4 per-field walk**: `Arc<Mutex<Option<Vec<(u16, u32, u32)>>>>`
    /// is `Send + Sync` -- `Arc<T>` is `Send + Sync` iff `T: Send + Sync`;
    /// `Mutex<T>` is `Send + Sync` iff `T: Send`; `Option<T>` is `Send +
    /// Sync` iff `T: Send + Sync`; `Vec<T>` is `Send + Sync` iff `T: Send +
    /// Sync`; `(u16, u32, u32)` is `Copy + Send + Sync` trivially.  Net:
    /// the whole composition is `Send + Sync`.  Required for `OnPush`'s
    /// `Send + Sync` bounds.  Replaces the V3.5.0.X `pure_local_frontier:
    /// bool` field (which is REMOVED at V3.6.0.2); arc terminus stays
    /// at 6 (no new triggers; one field swapped for another).
    pending_undo_cells: Arc<Mutex<Option<Vec<(u16, u32, u32)>>>>,

    /// **Phase 5.7 V3.6.0.2 audit-closure (2026-05-24)** -- grouped-undo
    /// flag for the partial-invalidate fallback.
    ///
    /// `true` between `start_undo_group()` and `end_undo_group()`; `false`
    /// otherwise.  Used by `append_op` to gate the
    /// `pending_undo_cells` staging: when inside a group, stage EMPTY
    /// cells -> meta encodes empty list -> `undo()` decodes empty ->
    /// falls back to full `rebuild_snapshot_cache`.
    ///
    /// **Why**: Loro's `push_with_merge` (loro-internal-1.12.0/src/undo.rs:
    /// 389-396) DISCARDS the new meta when merging spans inside a
    /// group -- only the FIRST push contributes its meta.  V3.6.0.2's
    /// on_push handoff alone would invalidate only the first op's cells
    /// (Codex Lane A probe demonstrated the regression).  The clean
    /// fix (union cells via `set_top_undo_meta`) requires Loro's
    /// internal API which isn't exposed on the public `loro::UndoManager`;
    /// V3.6.0.2 audit-closure ships the conservative fallback instead
    /// (matches V3.5.0.6 semantics for grouped undo).  V3.6+ could
    /// optimize via an upstream patch to expose `set_top_undo_meta`.
    ///
    /// **Rule 4 per-field walk**: `bool` is `Copy + Send + Sync`
    /// trivially.  0 new triggers; arc terminus stays at 6.
    inside_group: bool,

    /// **Phase 5.7 V3.6.0.2 audit-closure (2026-05-24)** -- session-
    /// side mirror of Loro's UndoManager merge-interval setting.
    ///
    /// Loro's auto-merge (`set_change_merge_interval` / `set_merge_interval`)
    /// fires `push_with_merge` for consecutive appends within
    /// `merge_interval_in_ms` of each other (loro-internal-1.12.0/src/
    /// undo.rs:484-549).  Same meta-discard pathology as grouped undo:
    /// only the FIRST push's meta survives the merge.
    ///
    /// When `undo_merge_interval_ms > 0`, `append_op` stages EMPTY
    /// cells (same conservative fallback as `inside_group`).  Default
    /// 0 (no time-based merging) keeps partial-invalidate active.
    ///
    /// **Reapplied across `discard_pending_ops`**: the recreated
    /// UndoManager has Loro's default 0; we reapply the session-tracked
    /// value via `set_merge_interval` so user-set intervals persist
    /// across the discard pivot.
    ///
    /// **Rule 4**: `i64` is `Copy + Send + Sync` trivially.
    undo_merge_interval_ms: i64,

    /// **Phase 5.7 V3.6.0.3 D2 (2026-05-24)** -- session-wide
    /// FormatTable cache mirror.
    ///
    /// Tracks `(FormatId -> format_string)` entries registered via
    /// `Op::RegisterFormat`.  Maintained incrementally in `append_op`
    /// (via `CacheEffect::RegisterFormat`); rebuilt during
    /// `from_snapshot` + `merge_bytes` + `discard_pending_ops` (same
    /// 6-mutation-site discipline as `last_snapshot`).
    ///
    /// **Purpose**: discipline (every Op-emitted cache effect must
    /// update the session-side cache; without this, the walker would
    /// leave a gap for RegisterFormat).  Future use: V3.7+ incremental
    /// snapshot deltas may emit format-cache deltas directly from this
    /// field without re-iterating Workbook.formats.
    ///
    /// **Note on Builtin formats**: this cache holds ONLY Custom format
    /// registrations (the only ones that come from `Op::RegisterFormat`).
    /// Builtin formats (ids 0..=163 per Phase 5.2 D-1) are defined at
    /// `FormatTable` construction and never appear in an op log.  The
    /// napi `workbook_snapshot.formats` field iterates `Workbook.formats`
    /// (authoritative; merges Builtin + Custom) -- NOT this cache --
    /// so the IDE sees BOTH variants.
    ///
    /// **Cross-peer divergence**: see `CacheEffect::RegisterFormat`
    /// docstring.  Conservative LWW-by-iteration semantic in the cache;
    /// Workbook side rejects same-id-different-string.  Cache and
    /// Workbook diverge on cross-peer collision; tolerated because
    /// napi reads from Workbook.
    ///
    /// **Rule 4 per-field walk**: `HashMap<FormatId, Arc<str>>` is
    /// `Send + Sync` -- `HashMap<K, V>: Send + Sync` iff `K: Send + Sync
    /// && V: Send + Sync`.  `FormatId` (Phase 5.2 D-1) is enum of
    /// `Builtin(u32)` + `Custom(PeerId, u32)`; PeerId wraps u64; all
    /// primitive; Send + Sync trivially.  `Arc<str>: Send + Sync`
    /// (std inherent impl).  0 new triggers; arc terminus stays at 6.
    format_table_cache: HashMap<FormatId, Arc<str>>,
}

impl CollabSession {
    /// Construct a fresh session with an empty op log.
    ///
    /// Use this when no shared base snapshot exists yet (the first
    /// peer to open a brand-new workbook). The `peer_id` is wired
    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
    /// CRDT merge metadata attributes this session's appends to
    /// `peer_id` (not Loro's default random per-doc id).
    ///
    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
    /// - Two concurrent sessions MUST use distinct peer ids.
    ///   Duplicate ids corrupt the document via conflicting OpIDs.
    /// - Prefer per-process-random peer ids over user-/device-pinned
    ///   ids unless your transport layer enforces single-ownership.
    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
    ///   `CollabSessionError::OpLog`.
    /// - **Phase 5.2 D-1 step 4 (Opus step-2 L4 closure):**
    ///   `PeerId(0)` is reserved as `LEGACY_PEER` — the sentinel used
    ///   by the qbook envelope's pre-5.2 u32 → tagged-tuple FormatId
    ///   migration. Active multi-peer sessions MUST use a non-zero
    ///   peer id; **release builds enforce** this here so misuse
    ///   fails loudly in production too.
    ///
    /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-1,
    /// 2026-05-20):** the prior `debug_assert_ne!` was a no-op in
    /// `--release` builds. Now uses `assert!` so the guard fires
    /// regardless of build profile. Centralized in `OpLog::set_peer_id`
    /// too (see ql-oplog) for the lower-level construction path.
    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
        assert_ne!(
            peer_id.as_u64(),
            0,
            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
             Active CollabSession peers MUST use a non-zero PeerId."
        );
        let mut log = OpLog::new();
        log.set_peer_id(peer_id.as_u64())?;
        // V3.6.0.2 D1: Arc<Mutex<>> for the on_push handoff -- see
        // `pending_undo_cells` field docstring.  Constructed BEFORE
        // make_undo_manager so the closure can capture an Arc clone.
        let pending_undo_cells: Arc<Mutex<Option<Vec<(u16, u32, u32)>>>> =
            Arc::new(Mutex::new(None));
        let undo = make_undo_manager(&log, pending_undo_cells.clone());
        Ok(Self {
            peer_id,
            log,
            undo,
            transport: None,
            auto_flush_policy: AutoFlushPolicy::Disabled,
            last_flushed_vv: None,
            // V3.3.0.3: empty cache; no ops in a fresh session.
            last_snapshot: HashMap::new(),
            // V3.5.0.X: empty tombstone set; no RemoveSheet ops yet.
            removed_sheets: HashSet::new(),
            pending_undo_cells,
            // V3.6.0.2 audit-closure: fresh session, no group active.
            inside_group: false,
            // V3.6.0.2 audit-closure: Loro default (no time-merge).
            undo_merge_interval_ms: 0,
            // V3.6.0.3 D2: empty cache; no RegisterFormat ops yet.
            format_table_cache: HashMap::new(),
        })
    }

    /// Construct a session by importing a shared snapshot. Use this
    /// when joining a session that already has history (the second+
    /// peer to open a collaborative workbook).
    ///
    /// `bytes` is a `LoroDoc::export(ExportMode::Snapshot)` produced
    /// by an earlier `CollabSession::export_bytes` call (typically
    /// from the workbook owner / first peer). After import, this
    /// session's peer id is set to `peer_id` — distinct from the
    /// peer ids carried by the already-imported ops. Imported ops
    /// retain their original peer-id attribution (Loro semantics);
    /// only this session's future appends carry `peer_id`.
    ///
    /// **Caller pitfalls** (same as `CollabSession::new`):
    /// - The new `peer_id` MUST differ from every peer already
    ///   represented in the imported snapshot AND from every other
    ///   concurrent session — see `OpLog::set_peer_id` for details.
    /// - `PeerId(u64::MAX)` is reserved.
    /// - **Phase 5.2 D-1 step 4 audit Codex MEDIUM-2 closure:**
    ///   `PeerId(0)` is `LEGACY_PEER` — debug-asserted just like
    ///   `CollabSession::new`. Snapshot-join sessions also count as
    ///   active sessions and must use a non-zero peer id.
    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
        // Step 8 megaudit closure (Opus-B HIGH-1, 2026-05-20):
        // assert! (release-firing) replaces debug_assert_ne!.
        assert_ne!(
            peer_id.as_u64(),
            0,
            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
             Snapshot-join CollabSession peers MUST use a non-zero PeerId, same as `new`."
        );
        let mut log = OpLog::import_bytes(bytes)?;
        log.set_peer_id(peer_id.as_u64())?;
        // V3.6.0.2 D1: same Arc<Mutex<>> handoff as `new`.  The
        // imported log already has ops in it but Loro's undo stack
        // is empty (undo only tracks LOCAL appends post-construction;
        // imported ops are treated as remote/historical).  So the
        // first append_op on this session will be the first on_push
        // event, with the Mutex correctly staged by then.
        let pending_undo_cells: Arc<Mutex<Option<Vec<(u16, u32, u32)>>>> =
            Arc::new(Mutex::new(None));
        let undo = make_undo_manager(&log, pending_undo_cells.clone());
        let mut sess = Self {
            peer_id,
            log,
            undo,
            transport: None,
            auto_flush_policy: AutoFlushPolicy::Disabled,
            last_flushed_vv: None,
            // V3.3.0.3: populated by `rebuild_snapshot_cache` below
            // so callers of `snapshot_cells` see the imported state
            // immediately (without needing a subsequent op-log walk).
            last_snapshot: HashMap::new(),
            // V3.5.0.X: populated by `rebuild_snapshot_cache` alongside
            // `last_snapshot` -- the walker emits `CacheEffect::RemoveSheet`
            // for each `Op::RemoveSheet` it sees, which apply_cache_effect
            // inserts here.
            removed_sheets: HashSet::new(),
            pending_undo_cells,
            // V3.6.0.2 audit-closure: from_snapshot constructs a fresh
            // UndoManager via `make_undo_manager` (Loro's UndoManager
            // state is in-memory, not part of the snapshot).  The new
            // session starts with no active group regardless of the
            // source session's state.
            inside_group: false,
            // V3.6.0.2 audit-closure: Loro default (no time-merge).
            // User-set interval doesn't persist across snapshots
            // (it's UndoManager-state, not workbook-state).
            undo_merge_interval_ms: 0,
            // V3.6.0.3 D2: populated by `rebuild_snapshot_cache` below
            // alongside `last_snapshot` -- the walker emits
            // `CacheEffect::RegisterFormat` for each `Op::RegisterFormat`
            // it sees, which apply_cache_effect inserts here.
            format_table_cache: HashMap::new(),
        };
        sess.rebuild_snapshot_cache()?;
        Ok(sess)
    }

    /// Stable peer id assigned at session creation.
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Append a local op. Delegates to `OpLog::append`.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** if [`auto_flush_policy`]
    /// is `OnAppend` AND a transport is attached, fires
    /// [`flush_to_transport`] internally after the append. Transport
    /// failures during the auto-flush surface as
    /// `Err(CollabSessionError::Transport(_))` AFTER the op has been
    /// committed locally (partial-state contract — see
    /// [`AutoFlushPolicy::OnAppend`]).
    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
        // V3.3.0.3 + V3.4.0.2 incremental cache update: local appends are
        // always at the causal frontier (Loro's normal-flow append puts
        // the op at the local peer's vector-clock head), so iteration
        // order does NOT reorder existing entries.  Safe to incrementally
        // upsert WITHOUT a full cache rebuild.
        //
        // V3.4.0.2 (per V3.4.0.1 D1 hybrid): handle 3 cell-keyed variants
        // (PutValue / PutFormula / ClearFormula).  V3.4.0.X HIGH-1 closure
        // (cross-lane convergent Codex+Opus, 2026-05-24): also recurse into
        // `Op::BatchCommit { ops }` so production op-log shapes from
        // `WorkbookRuntime::set_value`-over-formula (which emits
        // `BatchCommit { PutValue, ClearFormula }` for atomicity) update
        // the cache.  V3.4.0.X MEDIUM-1 closure (single-lane Codex): after
        // ClearFormula clears `formula`, REMOVE the cache key entirely if
        // ALL fields are `None` -- otherwise a formula-only cell clearing
        // its formula leaves an empty CellState that surfaces in
        // `list_sheets_from_cache`.
        //
        // **V3.5.0.5 (2026-05-24)**: adds a 4th cell-keyed variant
        // `SetCellFormat { id: Option<FormatIdWire> }` to the cache
        // walker.  `id: Some(_)` writes `state.format`; `id: None`
        // clears it (mirroring ClearFormula's get_mut + skip-if-absent
        // + extended all-three-fields-None ghost-entry removal).  See
        // CacheEffect::SetCellFormat docstring for full semantics.
        //
        // We capture the cache-affecting fields BEFORE consuming `op` via
        // `self.log.append(op)` to avoid an unnecessary full-op clone
        // (CellWireValue::Text/Error + PutFormula::text own heap strings).
        let mut effects: Vec<CacheEffect> = Vec::new();
        Self::collect_cache_effects(&op, &mut effects);
        // **Phase 5.7 V3.6.0.2 D1 (2026-05-24) -- Loro on_push handoff**:
        // pre-stage the affected cells for this op BEFORE
        // `self.log.append(op)` triggers `LoroDoc::commit()` which
        // fires Loro's `on_push` callback synchronously.  The
        // closure (set up in `make_undo_manager`) reads via
        // `.take()` so the Mutex drains back to `None` after
        // the commit.  For non-cell-keyed ops (AddSheet /
        // RemoveSheet / RenameSheet / MoveSheet / RegisterFormat
        // / batched mixed) `affected_cells_for_partial_invalidate`
        // returns `None` -> we stage `Some(empty Vec)` -> meta
        // encodes empty list -> undo() decodes empty -> falls back
        // to full `rebuild_snapshot_cache` (correct conservative
        // path; same as pre-V3.6.0.2 V3.5.0.6 dispatch for these
        // shapes).
        // **Phase 5.7 V3.6.0.2 audit-closure (2026-05-24) -- grouped-undo
        // fallback**: Loro's `push_with_merge` (loro-internal-1.12.0/src/
        // undo.rs:389-396) DISCARDS the new meta when merging spans
        // during a grouped push -- only the FIRST push in the merge
        // group contributes meta to the stack item.  Pre-fix, this
        // caused `undo()` of a 5-op group to invalidate only the FIRST
        // op's cells (the other 4 cache entries stayed stale).  Codex
        // Lane A probe `codex_tmp_grouped_undo_cache_probe` demonstrated
        // the regression.
        //
        // The clean fix (union cells into top_undo_meta via
        // `set_top_undo_meta`) is BLOCKED: that API exists on
        // `loro_internal::undo::UndoManager` but is NOT exposed on the
        // public `loro::UndoManager`.  Pulling in loro-internal as a
        // direct dependency would reach into Loro's private API surface.
        //
        // Conservative closure (matches V3.5.0.6 semantics): when
        // `inside_group == true`, stage EMPTY cells -> meta encodes
        // empty list -> `undo()` decodes empty -> falls back to full
        // `rebuild_snapshot_cache` (correct + safe).  Partial-invalidate
        // optimization for grouped ops deferred to V3.6+ as a perf
        // polish IF profiling justifies (likely needs an upstream
        // contribution to expose `set_top_undo_meta`).
        // V3.6.0.2 audit-closure gate: fall back to full-rebuild on
        // undo whenever Loro might merge the next push.  Two cases:
        // - `inside_group`: explicit user-grouped op (start/end_undo_group).
        // - `undo_merge_interval_ms > 0`: user-set time-merge window
        //   active.  Even if THIS append doesn't actually merge (e.g.,
        //   long pause since last edit), we don't know without timing
        //   data we don't have.  Conservative.
        let staged_cells = if self.inside_group || self.undo_merge_interval_ms > 0 {
            Vec::new()
        } else {
            Self::affected_cells_for_partial_invalidate(&op).unwrap_or_default()
        };
        *self.pending_undo_cells.lock().expect("pending_undo_cells mutex poisoned") =
            Some(staged_cells);
        self.log.append(op)?;
        for effect in effects {
            // V3.5.0.X audit-closure: thread `removed_sheets` through so
            // RemoveSheet effects update the session-level tombstone set
            // + cell-keyed effects on tombstoned sheets are silently
            // dropped (Opus-H1 closure widened to all 4 cell-keyed
            // variants).
            Self::apply_cache_effect(
                &mut self.last_snapshot,
                &mut self.removed_sheets,
                &mut self.format_table_cache,
                effect,
            );
        }
        self.maybe_auto_flush()?;
        Ok(())
    }

    /// **Phase 5.7 V3.4.0.X HIGH-1 closure (2026-05-24)**: collect cache
    /// effects from an op, recursing into `Op::BatchCommit` for nested
    /// cell-keyed ops.  Used by both `append_op` (O(1) incremental path)
    /// and `rebuild_snapshot_cache` (full walk) so the two paths cannot
    /// drift on supported op shapes.
    ///
    /// Recursion is bounded by the op-log producer side; nested
    /// `BatchCommit { BatchCommit { ... } }` is schema-permitted but the
    /// producers in `ql-exec/src/workbook_runtime/` do not emit nested
    /// commits today.  Per `op.rs:174-175`, "Nested BatchCommits are
    /// permitted by the schema but produced one level deep".
    fn collect_cache_effects(op: &Op, out: &mut Vec<CacheEffect>) {
        match op {
            Op::PutValue { sheet, row, col, value } => out.push(CacheEffect::PutValue {
                key: (*sheet, *row, *col),
                value: value.clone(),
            }),
            Op::PutFormula { sheet, row, col, text } => out.push(CacheEffect::PutFormula {
                key: (*sheet, *row, *col),
                text: text.clone(),
            }),
            Op::ClearFormula { sheet, row, col } => out.push(CacheEffect::ClearFormula {
                key: (*sheet, *row, *col),
            }),
            // **V3.5.0.5 (2026-05-24)**: cell-keyed `SetCellFormat`
            // joins the cache walker.  `id: Some(_)` -> set state.format;
            // `id: None` -> clear state.format.  FormatIdWire is mapped
            // to storage `FormatId` via `to_storage()` (lossless).
            Op::SetCellFormat { sheet, row, col, id } => out.push(CacheEffect::SetCellFormat {
                key: (*sheet, *row, *col),
                format: id.map(|wire| wire.to_storage()),
            }),
            Op::BatchCommit { ops } => {
                for inner in ops {
                    Self::collect_cache_effects(inner, out);
                }
            }
            // **V3.5.0.X audit-closure Opus-H1 extension (2026-05-24)**:
            // sheet tombstone effect.  Pre-closure, Op::RemoveSheet was
            // a no-op for the cache walker (fell through `_ => {}`);
            // the engine workbook side was tombstoned via apply_op but
            // the cache walker had no way to know.  Now the walker
            // emits a `CacheEffect::RemoveSheet`, which apply_cache_effect
            // uses to (a) drop existing snapshot entries for the sheet
            // and (b) record the tombstone so subsequent cell-keyed
            // effects on the same sheet are silently skipped.
            Op::RemoveSheet { id } => out.push(CacheEffect::RemoveSheet { id: *id }),
            // **V3.6.0.3 D2 (2026-05-24)**: session-wide format-table
            // cache update.  Op::RegisterFormat carries `id: FormatIdWire`
            // (the wire shape) + `string: String`; convert id to storage
            // shape via `to_storage()` (lossless) and wrap the string in
            // Arc<str> for cheap clones across the walker.  See
            // CacheEffect::RegisterFormat docstring for the LWW caveat.
            Op::RegisterFormat { id, string } => out.push(CacheEffect::RegisterFormat {
                id: id.to_storage(),
                string: Arc::<str>::from(string.as_str()),
            }),
            _ => {}
        }
    }

    /// **Phase 5.7 V3.4.0.X helper (2026-05-24)**: apply one collected
    /// cache effect to a mutable snapshot map.  Shared between
    /// `append_op` (live cache) and `rebuild_snapshot_cache` (fresh
    /// build), keeping the per-field LWW + ghost-entry-avoidance +
    /// formula-only-key-removal invariants in ONE place.
    ///
    /// **V3.5.0.X audit-closure Opus-H1 extension (2026-05-24)**: now
    /// also threads a `tombstones: &mut HashSet<u16>` parameter.  On
    /// `CacheEffect::RemoveSheet { id }`, inserts the id into
    /// `tombstones` AND drops all existing snapshot entries for that
    /// sheet.  All subsequent cell-keyed effects targeting a tombstoned
    /// sheet are silently dropped (matching the engine `apply_op` guard
    /// that V3.5.0.3b added to PutValue/PutFormula/ClearFormula + that
    /// the V3.5.0.X closure added to SetCellFormat).  Pre-closure, the
    /// cache walker was tombstone-blind: cell-keyed effects on a
    /// tombstoned sheet wrote phantom entries.
    fn apply_cache_effect(
        snapshot: &mut HashMap<(u16, u32, u32), CellState>,
        tombstones: &mut HashSet<u16>,
        format_cache: &mut HashMap<FormatId, Arc<str>>,
        effect: CacheEffect,
    ) {
        // V3.5.0.X audit-closure: cell-keyed effects on tombstoned sheets
        // are silently dropped.  RemoveSheet + RegisterFormat handled
        // below; this branch covers the four cell-keyed variants.
        let target_sheet = match &effect {
            CacheEffect::PutValue { key, .. } => Some(key.0),
            CacheEffect::PutFormula { key, .. } => Some(key.0),
            CacheEffect::ClearFormula { key } => Some(key.0),
            CacheEffect::SetCellFormat { key, .. } => Some(key.0),
            CacheEffect::RemoveSheet { .. } => None,
            CacheEffect::RegisterFormat { .. } => None,
        };
        if let Some(sheet) = target_sheet {
            if tombstones.contains(&sheet) {
                return;
            }
        }
        match effect {
            CacheEffect::PutValue { key, value } => {
                snapshot.entry(key).or_default().value = Some(value);
            }
            CacheEffect::PutFormula { key, text } => {
                snapshot.entry(key).or_default().formula = Some(text);
            }
            CacheEffect::ClearFormula { key } => {
                // get_mut + skip-if-absent: ClearFormula on a never-set
                // cell is a no-op for the cache (it's also semantically
                // a no-op for `Workbook` -- there was no formula to
                // clear).  Avoids ghost-sheet entries in
                // `list_sheets_from_cache`.
                //
                // V3.4.0.X MEDIUM-1 closure: if ALL fields (value,
                // formula, format -- V3.5.0.5 adds format) are None
                // after the clear, DELETE the key so the empty
                // CellState doesn't surface in
                // `list_sheets_from_cache` either.
                if let Some(state) = snapshot.get_mut(&key) {
                    state.formula = None;
                    if state.value.is_none() && state.formula.is_none() && state.format.is_none() {
                        snapshot.remove(&key);
                    }
                }
            }
            // **V3.5.0.5 (2026-05-24)**: cell-keyed format set/clear.
            // Mirrors ClearFormula's ghost-entry-avoidance discipline:
            // - `format: Some(_)` -> entry().or_default().format = Some(id)
            //   (analogous to PutValue / PutFormula).
            // - `format: None` -> get_mut + skip-if-absent (analogous
            //   to ClearFormula).  If all three fields are None after,
            //   remove the entry.
            //
            // CRDT per-cell LWW: concurrent `SetCellFormat` from two
            // peers on the same cell converges via Loro's causal-merge
            // iteration order (same invariant as PutValue / PutFormula).
            CacheEffect::SetCellFormat { key, format } => {
                match format {
                    Some(id) => {
                        snapshot.entry(key).or_default().format = Some(id);
                    }
                    None => {
                        if let Some(state) = snapshot.get_mut(&key) {
                            state.format = None;
                            if state.value.is_none() && state.formula.is_none() && state.format.is_none() {
                                snapshot.remove(&key);
                            }
                        }
                    }
                }
            }
            // V3.5.0.X audit-closure Opus-H1 extension (2026-05-24):
            // tombstone the sheet + drop all existing snapshot entries
            // for it.  Subsequent cell-keyed effects targeting this
            // sheet are silently dropped via the early-return above.
            // Idempotent: a second RemoveSheet for the same id leaves
            // the tombstone set + snapshot unchanged.
            CacheEffect::RemoveSheet { id } => {
                tombstones.insert(id);
                snapshot.retain(|(sheet, _, _), _| *sheet != id);
            }
            // V3.6.0.3 D2 (2026-05-24): session-wide format-table cache
            // mirror.  LWW-by-iteration (later RegisterFormat with same
            // id overwrites earlier).  Cross-peer divergence with
            // Workbook side is documented + tolerated (see field docstring
            // + CacheEffect::RegisterFormat docstring).  No tombstone
            // check needed (RegisterFormat is sheet-independent).
            CacheEffect::RegisterFormat { id, string } => {
                format_cache.insert(id, string);
            }
        }
    }

    /// Merge a remote peer's snapshot into this session's log. Loro's
    /// CRDT preserves both peers' concurrent appends in deterministic
    /// causal order (Fugue/origin-based with peer-id tiebreaker per
    /// Phase 5.1 audit Codex V1). Returns the new `len()` after merge.
    ///
    /// **Phase 5.3 step 5b audit closure (Codex MEDIUM-2):** does NOT
    /// auto-invoke the repair pass — audit-locked D-5.3-1 keeps repair
    /// caller-driven so callers can batch multiple `merge_bytes` calls
    /// before paying the replay+repair cost. Collaborative callers
    /// rebuilding a workbook from the post-merge log MUST then call
    /// [`Self::rebuild_workbook`] (NOT raw `replay_into`) so the
    /// rename-repair pass fires and concurrent-rename formulas resolve
    /// correctly. Without `rebuild_workbook`, those formulas surface
    /// as `#NAME?` at recompute time.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
    /// [`auto_flush_policy`]. After merging peer ops the local snapshot
    /// contains the union; auto-flushing it propagates the union to
    /// any third-party peer attached via the transport (3+ peer fanout
    /// via this session's transport endpoint). Same partial-state
    /// contract as `append_op` if the auto-flush fails — the local
    /// merge is already committed.
    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
        let new_len = self.log.merge_bytes(bytes)?;
        // V3.3.0.3: REBUILD the cache from scratch.  Loro's CRDT merge
        // can insert remote ops at causally-prior positions, which
        // changes the iteration order of EXISTING entries — the
        // "latest value at (sheet, row, col)" can shift even when the
        // local op log only grows.  Cheap incremental update is NOT
        // correct here; full rebuild is.  See the `last_snapshot`
        // field docstring for the formal argument.
        self.rebuild_snapshot_cache()?;
        // V3.6.0.2 D1 (2026-05-24): the V3.5.0.X `pure_local_frontier`
        // field was REMOVED.  Partial-invalidate undo/redo now uses
        // Loro's `top_undo_meta()` / `top_redo_meta()` to retrieve the
        // EXACT cells the to-be-popped op affected -- regardless of
        // iteration order.  No frontier-state mutation needed here;
        // the meta on the local undo stack is unaffected by remote
        // merges (it's stack-local to this peer's UndoManager).
        self.maybe_auto_flush()?;
        Ok(new_len)
    }

    /// Produce a Loro snapshot blob suitable for **transport to other
    /// peers** (consumed by [`Self::merge_bytes`] on the receiving end
    /// OR by `OpLog::merge_bytes` directly).
    ///
    /// **Phase 5.2 D-1 step 7 audit closure (2026-05-20):** these are
    /// RAW Loro snapshot bytes — NOT directly suitable as
    /// `.qbook/oplog.bin` file contents. The post-Tier-D3 file format
    /// requires a Quantlab header (`OPLOG_MAGIC` + version u32) that
    /// this function does NOT add. Use
    /// `ql_io::oplog_persistence::save_workbook_with_oplog` for file
    /// writes; that wrapper prepends the header. Writing raw export
    /// bytes directly to `oplog.bin` would still load (via the
    /// legacy backward-compat path) but bypasses the version header
    /// and defeats forward-compat versioning.
    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
        Ok(self.log.export_bytes()?)
    }

    /// Borrow the underlying `OpLog` for snapshot inspection or tests.
    ///
    /// **Prefer [`Self::rebuild_workbook`] over this raw accessor** for
    /// production collaboration flows — `rebuild_workbook` atomically
    /// constructs a fresh `Workbook` + pairs `replay_into` with the
    /// Phase 5.3 rename-repair passes (audit-locked D-5.3-1 caller
    /// contract).
    ///
    /// Typical usage (raw, e.g., for diagnostics or non-rebuild flows):
    /// ```ignore
    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
    /// let op_count = session.op_log().len();
    /// ```
    ///
    /// Preferred usage for collaboration flows:
    /// ```ignore
    /// let mut session = CollabSession::from_snapshot(peer_id, &bytes)?;
    /// session.merge_bytes(&peer_b_bytes)?;
    /// let reg = ql_functions::default_registry();
    /// let (wb, report) = session.rebuild_workbook(&reg)?;
    /// // log via `report.to_string()` (Display impl)
    /// ```
    pub fn op_log(&self) -> &OpLog {
        &self.log
    }

    /// **Phase 5.7 V3.3.0.X audit closure (MEDIUM-3, 2026-05-23) --
    /// listSheets reads from the incremental snapshot cache.**
    ///
    /// Returns the distinct u16 sheets referenced by `Op::PutValue`
    /// entries currently in the cache.  Output is sorted ascending
    /// via `BTreeSet` collection.
    ///
    /// Pre-V3.3.0.X audit, the napi `list_sheets` walked the entire
    /// op log per call (O(N) in op count).  The V3.3.0.3 incremental
    /// cache already keyed entries by `(sheet, row, col)` so deriving
    /// the sheet set from cache keys is O(cells-in-cache) -- the
    /// same complexity as `snapshot_cells` but typically much
    /// smaller than the op log (cells <= ops; one op per cell
    /// in the LWW-only case).
    ///
    /// Empty if no `PutValue` ops have been observed.  Cross-peer
    /// convergence is identical to the cache's: post-mergeBytes,
    /// two peers' cache keys converge.
    ///
    /// V3.4+ migration path (per V3.2.d Opus M4 + V3.3.0.X Opus M3):
    /// when the `Op` enum extends beyond `PutValue` (RegisterFormat,
    /// SetCellFormat etc. at V3.5+), the cache shape will need to
    /// extend too -- decision deferred to V3.4 entry.  Until then,
    /// this method returns the PutValue-sheet set, which matches
    /// the current cell-grid IDE consumer contract.
    pub fn list_sheets_from_cache(&self) -> Vec<u16> {
        let mut sheets: std::collections::BTreeSet<u16> = std::collections::BTreeSet::new();
        for (sheet, _row, _col) in self.last_snapshot.keys() {
            sheets.insert(*sheet);
        }
        sheets.into_iter().collect()
    }

    /// **Phase 5.7 V3.6.0.3 D2 (2026-05-24)** -- iterate the session-
    /// wide format-table cache (`(FormatId, format_string)` pairs).
    ///
    /// Contains entries from `Op::RegisterFormat` applications in the
    /// op log.  Does NOT include Builtin formats (those are static at
    /// `FormatTable` construction; not emitted via any Op).  Iteration
    /// order is HashMap iteration (NOT deterministic across runs);
    /// callers wanting stable order should sort.
    ///
    /// **Authoritative source caveat**: the engine `Workbook::FormatTable`
    /// is the authoritative source (it merges Builtin + Custom + applies
    /// the same-id-different-string rejection).  The session cache is
    /// a downstream mirror; under cross-peer concurrent
    /// `Op::RegisterFormat { id: SAME, string: DIFFERENT }`, the cache
    /// + Workbook may diverge.  napi `workbook_snapshot.formats` reads
    /// from the Workbook (NOT this cache) to avoid surfacing divergence.
    /// This accessor is for V3.7+ incremental-snapshot-delta use cases
    /// + cross-peer-convergence regression tests.
    pub fn format_table_cache_iter(&self) -> impl Iterator<Item = (&FormatId, &Arc<str>)> {
        self.format_table_cache.iter()
    }

    /// **Phase 5.7 V3.3.0.X audit closure (MEDIUM-5, 2026-05-23) --
    /// test-only snapshot cache invalidation seam.**
    ///
    /// Gated behind the `test-fixtures` feature so production cdylib
    /// builds (built without `--features test-fixtures`) do NOT
    /// expose this method.  Used by V3.4 undo-invalidation tests
    /// (and any future test that needs to force a cache rebuild
    /// independent of the normal mutation paths).
    ///
    /// **Not for production use.**  Production callers should never
    /// need to force cache invalidation -- the 6 op-mutation paths
    /// (new / from_snapshot / append_op / merge_bytes / discard_pending_ops /
    /// poll_remote_with_limit + V3.3.0.X-added undo/redo) cover every
    /// state transition that should affect the cache.
    ///
    /// Required by V3.3 risk register R-V3.3-2 (`.plans/_active.md`).
    ///
    /// **V3.5.0.X audit-closure follow-up B-FINDING-1 (2026-05-24)**: also
    /// clears `self.removed_sheets` (the cache-walker tombstone tracker
    /// added by the Opus-H1 scope-widened closure).  The seam contract
    /// is "force cache to a clean state independent of normal mutation
    /// paths"; both `last_snapshot` and `removed_sheets` are part of
    /// the cache walker state, so both should reset.  In the canonical
    /// test pattern (force_clear -> rebuild_snapshot_cache) the rebuild
    /// would overwrite both fields atomically, so leaving `removed_sheets`
    /// stale between the two calls was benign in practice -- but a
    /// future test using `force_clear` WITHOUT a subsequent rebuild and
    /// then appending an op on a previously-tombstoned sheet would see
    /// the tombstone gate suppress the new append (confusing test
    /// behavior).  Defensive reset.
    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn force_clear_snapshot_cache(&mut self) {
        self.last_snapshot.clear();
        self.removed_sheets.clear();
        // V3.6.0.3 D2: also clear the format-table cache.  Same
        // rationale as removed_sheets above: the test seam is "force
        // cache to a clean state" + all cache-walker state should
        // reset together.  rebuild_snapshot_cache overwrites both
        // atomically in the canonical pattern; defensive reset for
        // tests using force_clear in isolation.
        self.format_table_cache.clear();
    }

    /// **Phase 5.7 V3.3.0.3 + V3.4.0.2 -- snapshot cache accessor
    /// for cell-grid IDE consumers.**
    ///
    /// Returns the cell-snapshot entries for `sheet` as a sorted
    /// ascending `Vec<((u32, u32), CellState)>` -- one entry per
    /// distinct `(row, col)` in the requested sheet with the LATEST
    /// per-field state (value + formula) across all peers' op-log
    /// iteration.
    ///
    /// **V3.4.0.2 signature change** (per V3.4.0.1 D1 hybrid): the
    /// value type changed from `CellWireValue` to `CellState{value,
    /// formula}`.  Callers reading ONLY the literal value (e.g., the
    /// napi `export_snapshot` for V3.4.0.2) should extract
    /// `state.value` and skip None entries.  Callers reading formulas
    /// (V3.4.0.5+ presence + formula cells) consume `state.formula`.
    ///
    /// O(cells-in-cache) per call (with a sheet-filter pass).  V3.x
    /// may nest the cache by sheet for O(cells-on-sheet) if profiling
    /// justifies; out of V3.3.0.3 scope.
    ///
    /// Empty if no cell-keyed op has been observed on this sheet.
    /// Use [`Self::list_sheets_from_cache`] to enumerate sheets that
    /// have entries.
    ///
    /// Semantics-equivalent to walking `self.op_log().iter()` and
    /// folding each cell-keyed op into the per-cell `CellState`; the
    /// cache is maintained in sync by the seven op-mutation paths
    /// (see `last_snapshot` field docstring).
    pub fn snapshot_cells(&self, sheet: u16) -> Vec<((u32, u32), CellState)> {
        let mut entries: Vec<((u32, u32), CellState)> = self
            .last_snapshot
            .iter()
            .filter_map(|((s, r, c), state)| {
                if *s == sheet { Some(((*r, *c), state.clone())) } else { None }
            })
            .collect();
        entries.sort_by_key(|((row, col), _)| (*row, *col));
        entries
    }

    /// **Phase 5.7 V3.3.0.3 + V3.4.0.2 -- rebuild the snapshot cache
    /// from the current op log.**
    ///
    /// Internal helper.  Walks `self.log.iter()` and collects the
    /// latest state per `(sheet, row, col)` into `self.last_snapshot`.
    /// LAST-WRITE-WINS per field via HashMap upsert in iteration order;
    /// iteration order = Loro's causal-merge order which converges
    /// across peers per Phase 5.1 audit Codex V1.
    ///
    /// **V3.4.0.2 (per D1 hybrid)**: handles 3 cell-keyed op variants:
    /// - `Op::PutValue` -> writes `CellState.value = Some(...)`,
    ///   preserves `formula`.
    /// - `Op::PutFormula` -> writes `CellState.formula = Some(...)`,
    ///   preserves `value`.
    /// - `Op::ClearFormula` -> writes `CellState.formula = None`,
    ///   preserves `value`.  Uses `get_mut` + skip-if-absent to avoid
    ///   creating ghost cache entries for cells that were never written
    ///   (preserves `list_sheets_from_cache` correctness).
    /// All other Op variants are no-ops for the cache (handled by
    /// `Workbook` state for non-cell-keyed ops; deferred to V3.5+ for
    /// cell-keyed format ops).
    ///
    /// Called by:
    /// - `from_snapshot` (after `import_bytes`).
    /// - `merge_bytes` (Loro can causally-reorder; cache MUST rebuild).
    /// - `discard_pending_ops` (log was replaced via `fork_at_vv`).
    /// - `poll_remote_with_limit` (drain bypasses Self::merge_bytes).
    /// - `undo` / `redo` (V3.3.0.X HIGH-1; inverse-op append to log).
    ///
    /// NOT called by `append_op` -- local appends are at the causal
    /// frontier; an O(1) incremental upsert is correct.
    ///
    /// Returns `Err(OpLog(_))` if the op-log iterator emits a decode
    /// error.  Same propagation as `export_snapshot` in the napi
    /// binding.
    fn rebuild_snapshot_cache(&mut self) -> Result<(), CollabSessionError> {
        // **V3.3.0.X audit closure (MEDIUM-1, 2026-05-23, convergent
        // Codex + Opus)**: build into a FRESH local HashMap, then swap
        // on success.  Pre-closure this method cleared `last_snapshot`
        // FIRST and then walked the iterator; an iter-error mid-walk
        // returned Err with the cache PARTIALLY rebuilt (subset of the
        // correct state), which subsequent `snapshot_cells` callers
        // would see as if it were complete.  Now: on iter-Err, the
        // `fresh` local drops + `self.last_snapshot` retains its
        // pre-call state (consistent with the LAST successful
        // rebuild).  Slightly more memory pressure (transient
        // duplicate during the build); trades for atomicity.
        //
        // **V3.4.0.X HIGH-1 closure (2026-05-24, single-lane Codex)**:
        // walks via `collect_cache_effects` + `apply_cache_effect` so
        // `Op::BatchCommit { ops }` (e.g., production
        // `WorkbookRuntime::set_value`-over-formula atomic pair) is
        // recursed.  Pre-closure this match arm omitted BatchCommit
        // entirely; cells written via the runtime's atomic-replace path
        // were ABSENT from the cache after `from_snapshot` /
        // `merge_bytes` rebuild, even though `rebuild_workbook` saw
        // them via `replay_into`'s recursion.
        //
        // **LWW iteration-order invariant (Opus M5 closure)**: per-cell
        // last-write-wins is computed from Loro's `iter()` order. Loro
        // guarantees this is the deterministic causal-merge order
        // (Fugue/origin-based with peer-id tiebreaker, audited at Phase
        // 5.1 Codex V1).  Across peers, the same op-log content +
        // version-vector produces the same iteration order, so all
        // peers converge to the same cache.  If a future Loro bump
        // changes the iteration-order semantics (e.g., switches to
        // insertion-order-by-peer instead of causal merge), THIS cache
        // rebuild + the V3.4.0.2 per-field LWW semantics BREAK.  Pin
        // the invariant in any future Loro upgrade audit.
        let mut fresh: HashMap<(u16, u32, u32), CellState> = HashMap::new();
        // V3.5.0.X audit-closure Opus-H1: rebuild the tombstone tracker
        // alongside the cache.  CacheEffect::RemoveSheet emitted by
        // `collect_cache_effects` is applied here; subsequent cell-keyed
        // effects in iteration order are filtered against `fresh_tombstones`.
        // Atomic-swap with `self.removed_sheets` only after the rebuild
        // succeeds (mirrors the `fresh -> self.last_snapshot` swap).
        let mut fresh_tombstones: HashSet<u16> = HashSet::new();
        // V3.6.0.3 D2: rebuild the format-table cache alongside the
        // cell cache.  Atomic-swap with `self.format_table_cache` after
        // rebuild succeeds.  Same pattern as `fresh_tombstones`.
        let mut fresh_format_cache: HashMap<FormatId, Arc<str>> = HashMap::new();
        let mut effects: Vec<CacheEffect> = Vec::new();
        for op_result in self.log.iter() {
            let op = op_result.map_err(CollabSessionError::OpLog)?;
            effects.clear();
            Self::collect_cache_effects(&op, &mut effects);
            for effect in effects.drain(..) {
                Self::apply_cache_effect(
                    &mut fresh,
                    &mut fresh_tombstones,
                    &mut fresh_format_cache,
                    effect,
                );
            }
        }
        self.last_snapshot = fresh;
        self.removed_sheets = fresh_tombstones;
        self.format_table_cache = fresh_format_cache;
        Ok(())
    }

    /// **Phase 5.7 V3.5.0.6 (2026-05-24) -- partial cache invalidation
    /// for a single cell (D2 from V3.5.0.1 decision lock).**
    ///
    /// Drops the `(sheet, row, col)` entry from `last_snapshot`, then
    /// walks the op log replaying ONLY ops that touch this cell, then
    /// re-emits the resulting `CellState` if any ops surfaced.
    ///
    /// Used by `undo` / `redo` when the retracted op was cell-keyed
    /// (PutValue / PutFormula / ClearFormula / SetCellFormat).  Avoids
    /// touching unrelated cells: their existing `CellState` entries in
    /// `last_snapshot` stay byte-identical across the call.  Cells that
    /// AREN'T `(sheet, row, col)` are NEVER walked through their op
    /// histories.
    ///
    /// **Cost**: O(N) op-log walk (same big-O as `rebuild_snapshot_cache`)
    /// BUT only O(1) HashMap writes (the one cell), versus full rebuild's
    /// O(cells) writes.  The real performance win comes V3.6+ if a
    /// per-cell op-index lands; for V3.5.0.6 the architectural shape
    /// ships now (foundation for incremental optimizations).
    ///
    /// **Correctness equivalence**: a call to `invalidate_cell(s, r, c)`
    /// followed by reading `last_snapshot[(s, r, c)]` MUST produce the
    /// same value as a full `rebuild_snapshot_cache()` followed by the
    /// same read.  Pinned by the V3.5.0.6 side-by-side regression tests.
    ///
    /// **Ghost-entry-avoidance**: if the walk produces no effects on the
    /// cell (the cell has no surviving cell-keyed ops, e.g., after undo
    /// of the only op that touched it), the entry is REMOVED entirely
    /// from `last_snapshot` (not left as an empty `CellState`).  Mirrors
    /// `apply_cache_effect`'s extended all-fields-None removal contract.
    ///
    /// Returns `Err(OpLog(_))` if the op-log iterator emits a decode
    /// error during the walk.
    pub(crate) fn invalidate_cell(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
    ) -> Result<(), CollabSessionError> {
        let target_key = (sheet, row, col);
        // Drop the existing entry FIRST so the per-cell rebuild starts
        // from a clean slate (mirrors rebuild_snapshot_cache's
        // build-into-fresh pattern at the per-cell granularity).
        self.last_snapshot.remove(&target_key);
        // Walk the log, applying ONLY effects targeting `target_key`.
        // Using the same `collect_cache_effects` + `apply_cache_effect`
        // helpers as rebuild_snapshot_cache guarantees parity with the
        // full-rebuild path (any op shape supported there is supported
        // here).  The filter on key happens at apply time so BatchCommit
        // recursion still surfaces its inner ops (we just discard the
        // ones for other cells).
        let mut effects: Vec<CacheEffect> = Vec::new();
        let mut local_snapshot: HashMap<(u16, u32, u32), CellState> = HashMap::new();
        // V3.5.0.X audit-closure Opus-H1: track tombstones during the
        // per-cell walk so `RemoveSheet` for `target_key.0` suppresses
        // any subsequent cell-keyed effect on that cell.  This local
        // tracker mirrors the rebuild_snapshot_cache pattern.
        let mut local_tombstones: HashSet<u16> = HashSet::new();
        // V3.6.0.3 D2: invalidate_cell does NOT mutate the format-table
        // cache (it's session-wide, not per-cell).  Use a throwaway
        // local cache for apply_cache_effect's signature; the cache's
        // session-level value stays untouched by this method.
        let mut local_format_cache: HashMap<FormatId, Arc<str>> = HashMap::new();
        for op_result in self.log.iter() {
            let op = op_result.map_err(CollabSessionError::OpLog)?;
            effects.clear();
            Self::collect_cache_effects(&op, &mut effects);
            for effect in effects.drain(..) {
                // Only apply effects targeting the requested cell OR the
                // RemoveSheet effect (which we always apply locally so
                // subsequent cell-keyed effects on the tombstoned sheet
                // are filtered).  RegisterFormat is SKIPPED here -- the
                // session-level format_table_cache is not invalidated
                // per-cell; only rebuild_snapshot_cache reconstructs it.
                let apply = match &effect {
                    CacheEffect::PutValue { key, .. } => *key == target_key,
                    CacheEffect::PutFormula { key, .. } => *key == target_key,
                    CacheEffect::ClearFormula { key } => *key == target_key,
                    CacheEffect::SetCellFormat { key, .. } => *key == target_key,
                    // Always apply RemoveSheet so the local tombstone
                    // tracker stays current; apply_cache_effect's retain
                    // operation is O(local_snapshot size) which is at
                    // most 1 entry during invalidate_cell.
                    CacheEffect::RemoveSheet { .. } => true,
                    // V3.6.0.3 D2: RegisterFormat effects are session-wide;
                    // invalidate_cell never touches them.
                    CacheEffect::RegisterFormat { .. } => false,
                };
                if apply {
                    Self::apply_cache_effect(
                        &mut local_snapshot,
                        &mut local_tombstones,
                        &mut local_format_cache,
                        effect,
                    );
                }
            }
        }
        // Move the (single) resulting entry (if any) into the main
        // snapshot.  apply_cache_effect's ghost-entry-avoidance may
        // have removed the entry entirely (e.g., if the only effect
        // was a ClearFormula on a never-set cell); in that case
        // local_snapshot is empty and we leave last_snapshot's removed
        // state intact.
        if let Some(state) = local_snapshot.remove(&target_key) {
            self.last_snapshot.insert(target_key, state);
        }
        Ok(())
    }

    /// **Phase 5.7 V3.5.0.6 (2026-05-24) -- extract affected cell coords
    /// from a cell-keyed Op (or BatchCommit of all-cell-keyed inner ops).**
    ///
    /// Returns `Some(cells)` if the op (and all inner ops for BatchCommit)
    /// are cell-keyed.  `None` signals "non-cell-keyed op present -- caller
    /// MUST fall back to full `rebuild_snapshot_cache`".  Used by the
    /// undo/redo dispatch to decide between partial-invalidate + full-
    /// rebuild paths.
    ///
    /// **Conservative**: BatchCommit with ANY non-cell-keyed inner op
    /// returns None.  Mixed cell-keyed + session-wide BatchCommit shapes
    /// don't currently exist in production (V3.5.0.6 ship; `WorkbookRuntime`
    /// emits only homogeneous BatchCommit groups), but the conservative
    /// behavior keeps the dispatch correct even if a future producer
    /// emits mixed shapes.
    ///
    /// **Deduplication**: a BatchCommit { PutValue(s, r, c), ClearFormula(s, r, c) }
    /// returns `Some(vec![(s, r, c)])` (one entry per unique cell, not
    /// per op).  Caller calls `invalidate_cell` once per coord.
    fn affected_cells_for_partial_invalidate(op: &Op) -> Option<Vec<(u16, u32, u32)>> {
        let mut cells: Vec<(u16, u32, u32)> = Vec::new();
        if !Self::collect_affected_cells_recursive(op, &mut cells) {
            return None;
        }
        // Dedup (BatchCommit can touch the same cell from multiple inner ops).
        cells.sort_unstable();
        cells.dedup();
        Some(cells)
    }

    /// Helper: recurse into BatchCommit; return false if any inner op
    /// is non-cell-keyed.
    fn collect_affected_cells_recursive(op: &Op, out: &mut Vec<(u16, u32, u32)>) -> bool {
        match op {
            Op::PutValue { sheet, row, col, .. } => {
                out.push((*sheet, *row, *col));
                true
            }
            Op::PutFormula { sheet, row, col, .. } => {
                out.push((*sheet, *row, *col));
                true
            }
            Op::ClearFormula { sheet, row, col } => {
                out.push((*sheet, *row, *col));
                true
            }
            Op::SetCellFormat { sheet, row, col, .. } => {
                out.push((*sheet, *row, *col));
                true
            }
            Op::BatchCommit { ops } => {
                for inner in ops {
                    if !Self::collect_affected_cells_recursive(inner, out) {
                        return false;
                    }
                }
                true
            }
            // All other variants are session-wide (AddSheet, RenameSheet,
            // RemoveSheet, MoveSheet, RegisterFormat, table ops, etc.)
            // OR not currently supported by collect_cache_effects's
            // cell-keyed walker.  Conservative fallback.
            _ => false,
        }
    }

    /// **Phase 5.3 step 5b + 5b audit closure + step 5c (2026-05-20) —
    /// production wiring closure (Opus-A Scenario E HIGH + V1 LIM #3,
    /// audit-locked D-5.3-1):** atomically rebuild a FRESH `Workbook`
    /// from this session's `OpLog`, running:
    ///
    ///   1. `let mut wb = Workbook::new();`
    ///   2. `ql_oplog::replay_into(self.op_log(), &mut wb, registry)`
    ///   3. `repair_sheet_rename_chain(&mut wb, self.op_log())`
    ///   4. `repair_table_rename_chain(&mut wb, self.op_log())`
    ///   5. `repair_column_rename_chain(&mut wb, self.op_log())`
    ///
    /// in that order. **Order matters**: sheet repair must run before
    /// table repair (sheet renames can affect table refs via
    /// fully-qualified `Sheet!Table[col]` paths, but currently the
    /// formula language doesn't support this — order is preserved for
    /// V2 future-proofing). Table repair must run before column repair
    /// because column rules are keyed by `(table_canonical, ...)` and
    /// would fail to match if the table is still under its historic
    /// name post-replay (V1 limitation acknowledged in
    /// `repair_column_rename_chain` docs). Returns `(wb, SyncReport)` — the caller owns the
    /// returned workbook and is responsible for downstream evaluation
    /// (`WorkbookRuntime::recompute_all`).
    ///
    /// # Why the workbook is constructed internally
    ///
    /// **Phase 5.3 step 5b audit closure (Codex MEDIUM-1, Opus HIGH-2,
    /// Opus HIGH-3):** the prior `sync_workbook(&self, &mut Workbook,
    /// &FunctionRegistry)` shape took the workbook by mut-ref. Both
    /// auditors flagged the same silent-corruption class:
    ///
    /// - Double invocation against the same workbook re-applied all
    ///   ops; `AddSheet` re-fired and Loro D-2 auto-rename created
    ///   `S(2)` sheets (empirical probe P1 from Opus audit).
    /// - Stale workbook from a different log silently double-applied
    ///   ops + rewrote formula text against the wrong base.
    /// - Empty-log fast path silently reused prior workbook state
    ///   (empirical probe P10).
    ///
    /// Eliminating the caller-misuse class entirely was the cleanest
    /// closure: the function now constructs a fresh `Workbook::new()`
    /// internally and returns it. Double-invocation produces two
    /// distinct fresh workbooks; empty session produces a fresh empty
    /// workbook + `SyncReport::default()`. The caller cannot pass a
    /// stale workbook because the API doesn't accept one.
    ///
    /// # Audit-locked D-5.3-1 caller contract
    ///
    /// Repair is NOT auto-invoked by `merge_bytes` (callers may want
    /// manual control for batch-merge scenarios). The production path
    /// through `CollabSession` MUST pair replay + repair to close the
    /// D-3 V1 limitation (concurrent-rename formulas → `#NAME?`).
    /// `rebuild_workbook` is the entry point.
    ///
    /// # Error handling
    ///
    /// On `Err(_)`, the partially-replayed workbook is DROPPED before
    /// the error is returned (the wrapper owns it; rustc drops at
    /// scope exit). The session's `OpLog` is unaffected (replay reads
    /// only). The caller never observes a half-merged workbook.
    ///
    /// # Empty-log fast path
    ///
    /// When `self.op_log().is_empty()` the function returns immediately
    /// with `(Workbook::new(), SyncReport::default())` — no replay, no
    /// repair work. The returned workbook is guaranteed fresh (the new
    /// API contract).
    ///
    /// # Caller pitfalls (V1 known limitations)
    ///
    /// - The `registry` parameter is reserved for future replay-side
    ///   recompute integration (today replay persists formula text
    ///   without re-evaluating; callers drive evaluation through
    ///   `WorkbookRuntime::recompute_all` after this returns).
    /// - HIGH-1 (Opus step 5b audit): `rebuild_workbook` is shipped as
    ///   the API entry point but is NOT yet wired by any production
    ///   binding. **Phase 5.7 V1 SHIPPED 2026-05-22 WITHOUT wiring
    ///   `rebuild_workbook`** — V1 binds only the minimum
    ///   `CollabSession` surface (constructor / `fromSnapshot` /
    ///   `appendPutValue` / `exportBytes` / `mergeBytes` /
    ///   observability accessors; see `crates/ql-bindings-node/src/lib.rs`
    ///   module docs for full V1 scope). Wiring `rebuild_workbook` from
    ///   JS requires binding `FunctionRegistry` first, which is deferred
    ///   to **Phase 5.7 V3** (cell-grid UI + persistence) where the
    ///   merge-then-recompute path becomes user-visible. V2 (Transport
    ///   binding) does not need `rebuild_workbook` either. Tracked at
    ///   `docs/PHASE-4-V2-BACKLOG.md` H9.
    #[must_use = "rebuild_workbook returns a (Workbook, SyncReport) — both \
                  carry load-bearing post-merge state. Ignoring discards \
                  the workbook (silent data loss) and the no-fallback \
                  diagnostic surface from SyncReport (Display impl available)."]
    pub fn rebuild_workbook(
        &self,
        registry: &FunctionRegistry,
    ) -> Result<(Workbook, SyncReport), CollabSessionError> {
        let mut workbook = Workbook::new();
        if self.log.is_empty() {
            return Ok((workbook, SyncReport::default()));
        }
        let ops_replayed = replay_into(&self.log, &mut workbook, registry)?;
        let sheet_repair = repair_sheet_rename_chain(&mut workbook, &self.log)?;
        let table_repair = repair_table_rename_chain(&mut workbook, &self.log)?;
        let column_repair = repair_column_rename_chain(&mut workbook, &self.log)?;
        Ok((
            workbook,
            SyncReport {
                ops_replayed,
                sheet_repair,
                table_repair,
                column_repair,
            },
        ))
    }

    /// Current number of ops in the log. Wraps [`OpLog::len`] — queries
    /// Loro on each call (Phase 5.4 V1 closure: the previously-cached
    /// `usize` field was retired because the cache became stale across
    /// undo/redo). O(1) but not a free local read.
    pub fn op_count(&self) -> usize {
        self.log.len()
    }

    /// True iff the log has no ops (session just opened, no edits yet).
    pub fn is_empty(&self) -> bool {
        self.log.is_empty()
    }

    /// **Phase 5.5 V2 V1 (2026-05-19):** attach a `Transport`
    /// implementation to this session. Subsequent
    /// [`flush_to_transport`] calls push the session's current
    /// snapshot through it; [`poll_remote`] drains incoming
    /// bytes and merges them.
    ///
    /// Returns `Some(previous)` if a transport was already
    /// attached and got replaced.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** V2 V1 was explicit-drive
    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
    /// the opt-in [`AutoFlushPolicy::OnAppend`] for IDE callers who
    /// want every mutator to propagate without scheduling their
    /// own ticks. Default policy remains
    /// [`AutoFlushPolicy::Disabled`] so V2 V1 callers see no
    /// behavior change; switch via [`set_auto_flush_policy`].
    ///
    /// **Phase 5.5 V2 V3 step 3 (2026-05-21) — offline-write story
    /// for reconnect**: this method resets `last_flushed_vv` to
    /// `None` (V2 V3 step 1 contract). A new transport-peer hasn't
    /// seen any of this session's ops. The next
    /// [`flush_delta_to_transport`] (or any auto-flushing mutator)
    /// sends from the empty VV — i.e., ALL local ops including
    /// those appended while offline. **Loro's CRDT op log IS the
    /// offline queue; no separate buffer needed.**
    ///
    /// **Idiom for explicit reattach-then-sync** (recommended for
    /// callers that want the new peer to see all state
    /// immediately, rather than waiting for the next mutator):
    /// ```ignore
    /// let _ = session.attach_transport(new_transport);
    /// if session.has_pending_flush() {
    ///     session.flush_delta_to_transport()?;
    /// }
    /// ```
    /// `attach_transport` itself does NOT auto-flush — it's a
    /// lifecycle event, not a mutation, and the existing API
    /// returns `Option<previous>` rather than `Result<>` (changing
    /// that would be a breaking V2 V1 API change). Callers needing
    /// immediate sync trigger it explicitly.
    // **NOTE on `#[must_use]` asymmetry** (V1 megaudit Opus-B LOW-3 +
    // V2.1 audit Opus MEDIUM-1): the matching `detach_transport` carries
    // `#[must_use]` because the returned `Box<dyn Transport + Send>`
    // owns background tasks. `attach_transport<T>` returns a
    // structurally-identical box (the PRIOR transport, on replacement)
    // and SHOULD carry the same annotation. Adding it here would
    // require updating ~80 existing call sites with `let _ = ...`
    // prefixes; V2.1 keeps the existing surface unchanged and defers
    // the sweep to a dedicated V2.2 (or later) cleanup. The new
    // `attach_transport_boxed` sibling DOES carry `#[must_use]` (no
    // existing call sites). Tracked in V2 backlog.
    pub fn attach_transport<T: Transport + Send + 'static>(
        &mut self,
        transport: T,
    ) -> Option<Box<dyn Transport + Send>> {
        // **Phase 5.7 V2.1 (2026-05-22) HIGH-2 closure**: this method
        // now delegates to `attach_transport_boxed`. The V2 V3 step 1
        // baseline-reset invariant (`last_flushed_vv = None`) lives in
        // the boxed sibling — see its docstring + body for the
        // load-bearing contract. The prior version of this function
        // body had a 6-line block comment about the VV reset attached
        // here; the V2.1 megaudit (Opus HIGH-2) flagged this as a Rule
        // 4 doc-drift hazard since the body no longer performed the
        // reset itself.
        self.attach_transport_boxed(Box::new(transport))
    }

    /// **Phase 5.7 V2.1 (2026-05-22):** Box-taking sibling of
    /// [`attach_transport`]. Same semantics, takes a pre-boxed
    /// trait object instead of a generic.
    ///
    /// Exists because napi-rs cannot bind generic functions (per
    /// Phase 5.7 V1 megaudit Opus-B HIGH-2). The IDE binding's
    /// `Transport` opaque class extracts its inner
    /// `Box<dyn Transport + Send>` and passes it here. The generic
    /// `attach_transport<T>` stays as the ergonomic entry point for
    /// direct Rust callers and now delegates to this method to keep
    /// the baseline-reset + replacement semantics in one place.
    ///
    /// **V2.1 audit closure (Opus MEDIUM-1, 2026-05-22)**: marked
    /// `#[must_use]` to match `detach_transport`. The returned
    /// `Option<Box<dyn Transport + Send>>` owns the prior transport's
    /// background tasks (e.g., WebSocketTransport's reader+writer
    /// tasks + TCP socket); silent drops leak the socket. The matching
    /// annotation on `attach_transport<T>` also closes V1 megaudit
    /// Opus-B LOW-3 (asymmetry between attach + detach).
    #[must_use = "drop the returned prior transport to release its background tasks; \
                  holding it past attach keeps the old TCP socket alive"]
    pub fn attach_transport_boxed(
        &mut self,
        transport: Box<dyn Transport + Send>,
    ) -> Option<Box<dyn Transport + Send>> {
        // **V2 V3 step 1 contract**: every attach resets the VV baseline
        // so the next flush sends from empty. A new transport-peer hasn't
        // seen ANY of this session's ops; without this reset they'd miss
        // ops 0..stale_vv and end up with a corrupt view. This is the
        // authoritative site for the invariant — `attach_transport<T>`
        // delegates here (V2.1 refactor).
        self.last_flushed_vv = None;
        self.transport.replace(transport)
    }

    /// **Phase 5.5 V2 V1 (2026-05-19):** detach the current
    /// transport. Returns it for caller cleanup; returns `None`
    /// if no transport was attached.
    ///
    /// **V2 V3 step 5 megaudit closure (Opus-A M3, 2026-05-21):**
    /// the returned `Box` owns the transport's background tasks
    /// (e.g., `WebSocketTransport`'s reader + writer). Drop the box
    /// to release them — holding it past the reconnect handshake
    /// keeps the old TCP socket alive + the old `last_error()`
    /// reachable. The typical pattern is `let _ = session.detach_transport();`
    /// before attaching a new one.
    #[must_use = "drop the returned transport to release its background tasks; \
                  holding it past detach keeps the old TCP socket alive"]
    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
        // Phase 5.5 V2 V3 step 1: orphaned VV is meaningless. Clear so
        // a subsequent `attach_transport` lands on a clean baseline.
        self.last_flushed_vv = None;
        self.transport.take()
    }

    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
    /// currently attached.
    pub fn has_transport(&self) -> bool {
        self.transport.is_some()
    }

    /// **Phase 5.5 V2 V3 step 5 megaudit closure (Opus-A H1,
    /// 2026-05-21):** proxy through to the attached transport's
    /// [`Transport::last_error`]. Returns `None` if no transport is
    /// attached OR the transport reports no error.
    ///
    /// Use for IDE reconnect handshakes: after observing
    /// `Err(CollabSessionError::Transport(TransportError::Closed))`
    /// from any mutator or `flush_*_to_transport` call, query this
    /// to distinguish the underlying cause (e.g., `WebSocketTransport`
    /// surfaces `"peer reset"` vs `"capacity exceeded"`). Choose the
    /// retry strategy accordingly — e.g., immediate reconnect for
    /// transient I/O vs auth-prompt for `HandshakeFailed("401")`.
    ///
    /// Returns `Option<String>` (lossy) to keep `Transport` trait-
    /// dyn-compatible without leaking impl-specific error types
    /// across the public API.
    pub fn transport_last_error(&self) -> Option<String> {
        self.transport.as_ref().and_then(|t| t.last_error())
    }

    /// **Phase 5.5 V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
    /// Block until every byte blob previously queued via the attached
    /// transport's `send` has reached the wire. Returns `Ok(())`
    /// immediately if no transport is attached.
    ///
    /// Closes the V2 V3 step 5 megaudit's convergent finding (Codex
    /// M1 + Opus-B M1): after `flush_delta_to_transport()` returns
    /// `Ok(true)`, the bytes are queued in the (buffered)
    /// transport's internal channel, NOT yet on the wire. Without
    /// this proxy, `has_pending_flush() == false` could be observed
    /// while bytes have not actually been written. Calling
    /// `flush_pending_to_transport()` AFTER `flush_delta_to_transport`
    /// (or any mutator under `OnAppend`) closes that gap — Ok return
    /// confirms the local writer task has caught up, providing a
    /// level-1 ack (bytes hit the underlying transport's wire).
    ///
    /// # Errors
    /// - `Err(CollabSessionError::Transport(Closed))` if the transport
    ///   closed before completing the drain (e.g., writer task failed
    ///   mid-flush; reconnect via `detach_transport` + new
    ///   `attach_transport` will redeliver the bytes via the V2 V3
    ///   step 1 baseline-reset contract).
    /// - `Err(CollabSessionError::Transport(Io))` for internal
    ///   synchronization failures (mutex poisoning from a panicked
    ///   task — recovery requires reconnect).
    ///
    /// # Async-context caveat
    ///
    /// This is blocking-sync. Calling from inside a tokio task body
    /// will block a runtime worker. Wrap with
    /// `tokio::task::block_in_place` (multi-thread runtime) or
    /// `tokio::task::spawn_blocking` (any runtime).
    pub fn flush_pending_to_transport(&mut self) -> Result<(), CollabSessionError> {
        if let Some(t) = self.transport.as_mut() {
            t.flush_pending().map_err(CollabSessionError::Transport)
        } else {
            Ok(())
        }
    }

    /// **Phase 5.7 V2.5 (2026-05-22) — async-flush ack handle proxy.**
    ///
    /// Returns a detached [`FlushAck`] handle for the attached
    /// transport's drain wait, captured at THIS call's instant
    /// (Codex M1 contract). `None` if no transport is attached or
    /// the attached transport's [`Transport::ack_handle`] returns
    /// `None` (e.g., [`LoopbackTransport`], [`NoopTransport`]).
    ///
    /// Takes [`&self`] (no `&mut`) so napi-binding callers wrapping
    /// the session in `Arc<Mutex<CollabSession>>` can extract the
    /// handle under a brief lock acquisition, drop the lock, then
    /// perform the wait on a `tokio::task::spawn_blocking` thread
    /// without holding the session lock. Closes Opus V2.4 HIGH-1
    /// (V8-block UX hazard) per
    /// `docs/audits/2026-05-22-phase-5-7-v2-4-opus.md:215-248`.
    ///
    /// The returned [`Box<dyn FlushAck + Send>`] is single-use: its
    /// [`FlushAck::wait_for_drain`] waits for the drain target
    /// captured AT THIS CALL, not later. See
    /// [`Transport::ack_handle`] documentation for the
    /// target-snapshot contract.
    pub fn flush_pending_handle(&self) -> Option<Box<dyn crate::FlushAck + Send>> {
        self.transport.as_ref().and_then(|t| t.ack_handle())
    }

    /// **Phase 5.5 V2 V2 (2026-05-21):** set the auto-flush policy
    /// for this session. Returns the previous policy.
    ///
    /// Default is [`AutoFlushPolicy::Disabled`] (V2 V1 behavior:
    /// caller drives flush explicitly). Setting
    /// [`AutoFlushPolicy::OnAppend`] makes every public mutator on
    /// this session (`append_op`, `merge_bytes`, presence writes,
    /// `undo`, `redo` when consumed, `sweep_presence`) auto-invoke
    /// [`flush_delta_to_transport`] internally — IDE callers can
    /// stop scheduling their own flush ticks.
    ///
    /// **Phase 5.5 V2 V3 step 1 audit closure (Opus M2, 2026-05-21):**
    /// auto-flush routes through the delta path
    /// ([`flush_delta_to_transport`]), not the full-snapshot path
    /// ([`flush_to_transport`]). Wire payload is O(per-op delta)
    /// instead of O(state). See [`AutoFlushPolicy::OnAppend`] for
    /// the full partial-state contract on transport failure.
    ///
    /// Orthogonal to [`attach_transport`]: setting `OnAppend` without
    /// a transport is harmless (auto-flush is silently a no-op until
    /// a transport is attached). Conversely, both explicit
    /// [`flush_to_transport`] (snapshot) and
    /// [`flush_delta_to_transport`] (delta) remain available
    /// regardless of policy — callers can mix-and-match.
    ///
    /// **Partial-state contract**: if an auto-flush attempt fails
    /// (transport closed, I/O error), the surrounding mutator
    /// returns `Err(CollabSessionError::Transport(_))`. The local
    /// mutation is ALREADY committed at that point — see
    /// [`AutoFlushPolicy::OnAppend`] for the full contract.
    pub fn set_auto_flush_policy(&mut self, policy: AutoFlushPolicy) -> AutoFlushPolicy {
        std::mem::replace(&mut self.auto_flush_policy, policy)
    }

    /// **Phase 5.5 V2 V2 (2026-05-21):** read the current auto-flush
    /// policy. Default is [`AutoFlushPolicy::Disabled`].
    pub fn auto_flush_policy(&self) -> AutoFlushPolicy {
        self.auto_flush_policy
    }

    /// **Phase 5.5 V2 V3 step 3 (2026-05-21):** true iff there
    /// are local ops in `self.log` that have NOT yet been
    /// successfully flushed to the currently-attached transport.
    ///
    /// Implementation: compares `self.log.oplog_vv()` to
    /// `self.last_flushed_vv.clone().unwrap_or_default()`. Returns
    /// `true` when they differ — i.e., either (a) no successful
    /// flush has occurred yet AND the log is non-empty, OR (b)
    /// ops have been appended (or merged) since the last
    /// successful flush.
    ///
    /// O(peer-count) — clones two `VersionVector`s and compares.
    /// Cheap relative to a full flush.
    ///
    /// # Use cases
    ///
    /// - IDE status indicator: "Synced" vs "Unsynced changes".
    /// - Reconnect handshake: caller knows whether to fire a
    ///   manual [`flush_delta_to_transport`] after attach.
    /// - Offline-mode UI: caller can warn user before navigating
    ///   away with pending unflushed state.
    ///
    /// # What it does NOT distinguish (V2 V3 step 3 audit closure
    /// — Codex L1 + Opus M1, 2026-05-21)
    ///
    /// The helper compares VVs; it doesn't know about transports.
    /// Three scenarios that return `false`:
    /// 1. Brand-new `CollabSession::new(...)` with no ops + no
    ///    flushes — `current_vv = default` matches
    ///    `last_flushed_vv.unwrap_or_default() = default`.
    /// 2. All ops flushed — `last_flushed_vv = Some(current_vv)`.
    /// 3. Brand-new session AFTER `detach_transport` AND no further
    ///    mutations — `current_vv = default` matches `default`.
    ///
    /// Three scenarios that return `true` even though no transport
    /// is attached:
    /// 1. Brand-new session with offline appends (no transport
    ///    ever attached) — `current_vv` reflects local ops;
    ///    `last_flushed_vv = None` → `default`.
    /// 2. `CollabSession::from_snapshot(peer_id, bytes)` IMMEDIATELY
    ///    after construction — `current_vv` reflects the IMPORTED
    ///    ops (typically non-empty); `last_flushed_vv = None`.
    ///    Callers building IDE "Synced / Unsynced" indicators
    ///    should either suppress until first user-driven mutation
    ///    OR wrap with `has_transport() && has_pending_flush()`
    ///    to gate the indicator on the transport-attached state.
    /// 3. Post-`detach_transport` non-empty session — the orphaned
    ///    `last_flushed_vv` was reset to `None`; `current_vv` is
    ///    still non-empty.
    ///
    /// Bottom line: combine with [`has_transport`] when the IDE
    /// status should reflect "do we have an active sync path"
    /// rather than just "is there local state."
    ///
    /// # Offline-write story (Phase 5.5 V2 V3 step 3)
    ///
    /// Append while no transport attached: `append_op` succeeds
    /// (V2 V2 contract — `maybe_auto_flush` returns `Ok(())`
    /// silently when no transport). The op is committed locally;
    /// `has_pending_flush()` returns `true`. On
    /// [`attach_transport`], `last_flushed_vv` resets to `None`.
    /// The next mutator (or explicit `flush_delta_to_transport`)
    /// sends the delta from empty VV — i.e., ALL accumulated ops
    /// including the offline ones. Loro's CRDT op log IS the
    /// offline queue.
    pub fn has_pending_flush(&self) -> bool {
        let current = self.log.oplog_vv();
        let last = self.last_flushed_vv.clone().unwrap_or_default();
        current != last
    }

    /// **Phase 5.5 V2 V4 V1 step 2 (2026-05-21) — Tier I1.** Count of
    /// Loro causal-history entries (per-peer counter deltas) added to
    /// the local op log since the last successful flush to the
    /// currently-attached transport. Sibling to [`has_pending_flush`] —
    /// same underlying invariant (`current_vv != last_flushed_vv`),
    /// finer-grained observable (returns the **magnitude** of the
    /// difference rather than just a boolean).
    ///
    /// # Implementation
    ///
    /// Computed by VV math: for each peer in `current_vv`, take the
    /// per-peer counter delta from the corresponding entry in
    /// `last_flushed_vv` (or 0 if absent), and sum the positive
    /// deltas. VV counters are monotonic per peer in Loro's causal
    /// history — they only INCREASE within a single peer's lifetime
    /// (each new op the peer authors gets the next counter value).
    /// This makes the VV-based count strictly monotonic under all
    /// existing log mutations including `undo` (which Loro records as
    /// a new causal-history entry that advances the VV even though it
    /// retracts a visible op from the LoroList).
    ///
    /// **V2 V4 V1 step 2 audit closure (Codex M1 / Opus H1,
    /// 2026-05-21):** the initial ship used `self.log.len()` (visible
    /// LoroList length) as the count source. That's NOT monotonic
    /// under undo — Loro's `UndoManager` retracts ops from the visible
    /// list, so `log.len()` can shrink while `current_vv` still
    /// advances. Result: `pending_op_count() == 0` while
    /// `has_pending_flush() == true` — divergent observability that
    /// breaks the documented sibling relationship. The convergent
    /// audit finding caught this; the closure switched to VV math,
    /// which is monotonic under undo (the undo's inverse op is a new
    /// VV entry).
    ///
    /// # IDE consumer use cases
    ///
    /// - **Bounded-queue policy**: "if `pending_op_count() > 1000`,
    ///   switch the editor to read-only mode until reconnect."
    /// - **Status indicator gradient**: "🟢 Synced if 0, 🟡 N pending
    ///   if 1..50, 🟠 backlog warning if >50."
    /// - **Memory pressure rough estimate**: each VV entry maps to one
    ///   Loro op (causal-history-wise); `pending_op_count() *
    ///   size_of_avg_op` is a memory floor for the not-yet-delivered
    ///   delta blob.
    ///
    /// # Semantic note — count includes peer ops AND undo ops
    ///
    /// The returned count is the magnitude of "VV entries the
    /// currently-attached transport hasn't seen," NOT "user's own
    /// unsynced edits." Includes BOTH local appends AND ops merged
    /// from peers since the last flush. **Includes undo ops** — each
    /// undo is a new causal-history entry (even though it retracts a
    /// visible op). For finer-grained "my net visible edits" an IDE
    /// builds its own peer-id-filtered counter — out of V2 V4 V1
    /// scope.
    ///
    /// # Edge cases
    ///
    /// - Fresh `CollabSession::new` session, no ops, no transport:
    ///   returns `0` (`current_vv == default`, `last_flushed_vv` is
    ///   `None.unwrap_or_default() = default`).
    /// - `from_snapshot` session: returns the imported VV's total
    ///   counter sum immediately, even before `attach_transport`.
    ///   Matches `has_pending_flush() == true` for the same scenario.
    /// - Post-`attach_transport`: baseline reset to `None`; count
    ///   includes ALL local ops (matches V2 V3 step 1 contract that
    ///   next flush sends from empty VV).
    /// - Post-successful-flush: baseline at `current_vv`; count `0`
    ///   (paired with `has_pending_flush() == false`).
    /// - Post-undo (with disabled auto-flush or no working transport):
    ///   count GROWS by 1 (the undo's inverse op is a new VV entry);
    ///   `has_pending_flush() == true`. The sibling relationship
    ///   `pending_op_count() > 0 ⟺ has_pending_flush() == true` holds
    ///   for all current mutators.
    pub fn pending_op_count(&self) -> usize {
        let current = self.log.oplog_vv();
        let last = self.last_flushed_vv.clone().unwrap_or_default();
        // Sum positive per-peer counter deltas. VV counters are
        // monotonic per peer in Loro's causal history, so
        // current[peer] >= last[peer] always holds; we use
        // `saturating_sub` as defensive insurance.
        let mut total: u64 = 0;
        for (peer, current_counter) in current.iter() {
            let last_counter = last.get(peer).copied().unwrap_or(0);
            let diff = (*current_counter as i64)
                .saturating_sub(last_counter as i64)
                .max(0) as u64;
            total = total.saturating_add(diff);
        }
        total as usize
    }

    /// **Phase 5.5 V2 V4 V1 step 5 (2026-05-21) — Tier I2.** Discard
    /// all ops appended to the local log since the last successful
    /// flush. Returns the count of ops discarded (matches the
    /// pre-call `pending_op_count()` return).
    ///
    /// # When to use
    ///
    /// IDE workflows that need a "discard unsynced changes" gesture
    /// — e.g., a user clicks "Discard" in a window-close dialog, or
    /// the IDE detects that local edits violate a server-enforced
    /// constraint and wants to revert.
    ///
    /// # What's discarded
    ///
    /// - Local appends since `last_flushed_vv` (via `append_op`,
    ///   `undo`, `redo` when consumed).
    /// - Merges from peers since `last_flushed_vv` (`merge_bytes`).
    /// - Presence ops since `last_flushed_vv` (presence is in the
    ///   same `LoroDoc`).
    /// - The internal `UndoManager`'s history of those ops.
    ///
    /// # What's preserved
    ///
    /// - `peer_id` (re-set on the forked doc).
    /// - The attached transport (still attached; not detached).
    /// - `auto_flush_policy`.
    /// - `last_flushed_vv` (the checkpoint we reverted to).
    /// - The transport's `last_error` (V2 V3 step 5 accessor still
    ///   reachable via `transport_last_error()`).
    ///
    /// # Edge cases
    ///
    /// - `pending_op_count() == 0` on entry: returns `Ok(0)`,
    ///   no-op fast-path. Skips the fork entirely.
    /// - `last_flushed_vv == None` (never flushed): discards
    ///   EVERYTHING. The log becomes empty. This covers the
    ///   `from_snapshot` session that imported state and never
    ///   flushed — caller's responsibility to know they're
    ///   discarding the imported snapshot too.
    /// - **Active undo group**: caller MUST end the group BEFORE
    ///   calling. If a group is active, this method tears down the
    ///   underlying `UndoManager` (recreated against the forked
    ///   doc), leaving the dangling `UndoGroupGuard` in an
    ///   undefined state. Don't do that.
    ///
    /// # Post-condition
    ///
    /// - `pending_op_count() == 0`.
    /// - `has_pending_flush() == false`.
    /// - `op_count() == last_flushed_op_count_logical` (the
    ///   op-count at the checkpoint we forked from; matches the
    ///   `op_count()` value at the last successful flush).
    ///
    /// # Local-only (V2 V4 V1 step 5 audit closure, Codex L1 / Opus M2)
    ///
    /// Discard is LOCAL ONLY — it does NOT instruct peers to
    /// revert. If a discarded op already reached a peer (via the
    /// attached transport or a prior session that broadcast it),
    /// the peer still has the op. When the local session subsequently
    /// `merge_bytes` from that peer (directly or via `poll_remote`),
    /// the discarded op will RE-APPEAR in the local log via CRDT
    /// convergence. The "discard" effect is durable only if (a) the
    /// caller also detaches the transport, OR (b) the discarded ops
    /// were never delivered (writer-task abort, never-flushed
    /// offline edits). For protocol-level peer rollback the IDE
    /// must layer a domain-specific revert op on top of `append_op`
    /// — out of `discard_pending_ops` scope.
    ///
    /// # Partial-state contract on Err (V2 V4 V1 step 5 audit closure, Opus M1)
    ///
    /// `self.log` is replaced UNCONDITIONALLY (before `set_peer_id`).
    /// If `set_peer_id` errors after the replacement, the session is
    /// in a half-state: new log + Loro-default peer_id + stale
    /// `UndoManager` field (not yet recreated). In practice this is
    /// unreachable when the session was constructed via a path that
    /// pre-rejects sentinel PeerIds (`CollabSession::new` /
    /// `from_snapshot` both `assert_ne!(peer_id.as_u64(), 0)`, and
    /// the `ql-bindings-node` FFI's `peer_id_from_bigint` pre-rejects
    /// both 0 and `u64::MAX`). The stored `self.peer_id` is therefore
    /// non-sentinel by construction along the V1 paths.
    ///
    /// **Phase 5.7 V1 megaudit closure (Opus-B HIGH-1, 2026-05-22):**
    /// the prior docstring claimed "`PeerId::new` rejects the only
    /// sentinel Loro would reject" — that was FALSE. `PeerId::new`
    /// (`ql-types/src/peer.rs::PeerId::new`) is a `const fn` accepting
    /// any u64 unchecked. The actual rejection lives at the layers
    /// ABOVE (FFI + CollabSession constructors). Rule 4: negative
    /// reject claims need positive proof at the layer making the
    /// claim. V2+ caveat: if a new path constructs `CollabSession`
    /// from a `PeerId` not vetted by `peer_id_from_bigint` (e.g.,
    /// via `presence::parse_peer_key`'s `PeerId::new(raw)`), this
    /// docstring becomes load-bearing — at that point either pin
    /// `PeerId::new` to reject sentinels itself OR pre-validate at
    /// the new construction site.
    ///
    /// Recovery from partial state: drop the session and reconstruct.
    ///
    /// # Errors
    ///
    /// - `CollabSessionError::OpLog(OpLogError::InvalidVersionVector(_))`
    ///   if `fork_at_vv` rejects the baseline (should not happen if
    ///   `last_flushed_vv` came from this session's own `oplog_vv`
    ///   — Loro round-trip guaranteed). Added in V2 V4 V1 step 5
    ///   audit closure (Codex M1) to prevent a Loro internal panic.
    /// - `CollabSessionError::OpLog(_)` if `OpLog::fork_at_vv`
    ///   otherwise fails.
    /// - `CollabSessionError::OpLog(_)` if the post-fork
    ///   `set_peer_id` fails (Loro reserves `u64::MAX`; pre-validation
    ///   along V1 paths prevents the sentinel from reaching this
    ///   point, so this Err arm is unreachable in V1 — see the
    ///   "half-state" note above for the V2+ caveat).
    pub fn discard_pending_ops(&mut self) -> Result<usize, CollabSessionError> {
        let pre_count = self.pending_op_count();
        if pre_count == 0 {
            return Ok(0);
        }
        let new_log = match self.last_flushed_vv.clone() {
            Some(vv) => self.log.fork_at_vv(&vv)?,
            None => {
                // Never flushed → discard ALL ops → start fresh.
                // The `from_snapshot` session case ends up here too;
                // documented as caller's responsibility.
                ql_oplog::OpLog::new()
            }
        };
        self.log = new_log;
        // Restore the stable peer_id on the new doc (fork_at gives
        // a fresh Loro-default peer_id; we want our session's PeerId).
        self.log.set_peer_id(self.peer_id.as_u64())?;
        // UndoManager is tied to the prior LoroDoc; recreate against
        // the new one. Active undo groups become invalid (documented
        // as caller's responsibility).
        // V3.6.0.2 D1: thread the same `pending_undo_cells` Arc into
        // the recreated UndoManager.  The Arc is owned by the
        // CollabSession; cloning it preserves the closure-side handle.
        // The OLD UndoManager's on_push closure goes away with the old
        // UndoManager (its Arc clone is dropped); the NEW closure
        // captures a fresh Arc clone but points at the SAME Mutex.
        self.undo = make_undo_manager(&self.log, self.pending_undo_cells.clone());
        // V3.3.0.3: the log was REPLACED via `fork_at_vv`; prior
        // cache entries may reference ops no longer in the log
        // (specifically the discarded pending ops past the last
        // flushed VV).  Rebuild from the new log.
        self.rebuild_snapshot_cache()?;
        // V3.6.0.2 D1: also reset the pending cells stash -- the prior
        // staged value (if any) referred to an op that was just
        // discarded along with the rest of the pending-op tail.
        *self.pending_undo_cells.lock().expect("pending_undo_cells mutex poisoned") = None;
        // V3.6.0.2 audit-closure: the UndoManager was recreated via
        // `make_undo_manager` so any open group is gone (group state
        // was part of the discarded UndoManager).  Clear the flag.
        self.inside_group = false;
        // V3.6.0.2 audit-closure: reapply the merge-interval to the
        // recreated UndoManager.  Loro defaults to 0; if the user had
        // set a non-default interval, we preserve that semantic across
        // the discard pivot.
        if self.undo_merge_interval_ms != 0 {
            self.undo.set_merge_interval(self.undo_merge_interval_ms);
        }
        // V3.6.0.3 D2: format_table_cache was rebuilt by
        // `rebuild_snapshot_cache` above (alongside last_snapshot +
        // removed_sheets); no extra reset needed here.
        Ok(pre_count)
    }

    /// **Phase 5.5 V2 V2 (2026-05-21):** internal hook called by every
    /// public mutator after a successful state change. Fires
    /// [`flush_to_transport`] when policy is `OnAppend` AND a transport
    /// is attached; otherwise no-op.
    ///
    /// Errors propagate to the caller; the local mutation is already
    /// committed at the point this is called (per the partial-state
    /// contract documented at [`AutoFlushPolicy::OnAppend`]).
    ///
    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** routes through
    /// [`flush_delta_to_transport`] (delta path) instead of
    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
    /// now O(ops since last flush) instead of O(state); a flush
    /// after no state change short-circuits to `Ok(false)`.
    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
        match self.auto_flush_policy {
            AutoFlushPolicy::Disabled => Ok(()),
            AutoFlushPolicy::OnAppend => {
                if self.transport.is_none() {
                    return Ok(());
                }
                let _sent = self.flush_delta_to_transport()?;
                Ok(())
            }
        }
    }

    /// **Phase 5.5 V2 V1 (2026-05-19):** export the current
    /// session snapshot and push it through the attached
    /// transport. No-op (returns `Ok(false)`) if no transport
    /// attached.
    ///
    /// Returns `Ok(true)` if bytes were sent. Errors:
    /// - `CollabSessionError::OpLog` if `OpLog::export_bytes`
    ///   fails (Loro encode error).
    /// - `CollabSessionError::Transport` if `Transport::send`
    ///   fails (Closed, Io).
    ///
    /// In both error cases the local `OpLog` is unaffected
    /// (export runs first, send is the last step). Caller can
    /// retry the flush after addressing the underlying cause.
    ///
    /// V2 V1 sends the FULL snapshot each call (O(state)). V2 V3
    /// will track per-transport version vectors and send deltas
    /// only.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** this method remains
    /// available for explicit-drive callers regardless of
    /// [`auto_flush_policy`]. With `OnAppend`, [`append_op`] etc.
    /// invoke this internally — calling it directly is harmless
    /// (just sends an extra idempotent snapshot). Mix-and-match
    /// is supported: set `OnAppend` for steady-state appends but
    /// still call `flush_to_transport` after an explicit batch
    /// operation if you want a deterministic flush point.
    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
        let Some(transport) = self.transport.as_mut() else {
            return Ok(false);
        };
        let bytes = self.log.export_bytes()?;
        transport.send(&bytes)?;
        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** advance
        // `last_flushed_vv` to current. The peer now has everything
        // up to this VV; subsequent `flush_delta_to_transport` calls
        // send only ops appended AFTER this point. Without this
        // update, a mixed-call sequence (`flush_to_transport` then
        // `flush_delta_to_transport`) would re-send the snapshot's
        // contents as a delta — wasted bandwidth, no correctness
        // issue (Loro dedupes on import).
        self.last_flushed_vv = Some(self.log.oplog_vv());
        Ok(true)
    }

    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export and send the
    /// DELTA of ops added since the last successful flush to the
    /// attached transport. Returns `Ok(true)` if bytes were sent,
    /// `Ok(false)` if no transport is attached OR if no ops have
    /// been appended since the last flush (idempotency short-
    /// circuit — closes V2 V2 audit M2/M3 echo-loop class for
    /// step 2's `poll_remote` auto-flush wiring).
    ///
    /// Wire bytes are `LoroDoc::ExportMode::Updates { from: last_flushed_vv }`.
    /// The first flush after `attach_transport` (or after `new`)
    /// sends from the empty VV — equivalent to `all_updates()` —
    /// delivering the full history to the new transport-peer.
    /// Subsequent flushes send only the delta since the prior flush.
    ///
    /// Loro's `LoroDoc::import` transparently consumes both
    /// `Snapshot` and `Updates` blobs, so the wire format is opaque
    /// to peers — switching from snapshots to deltas is a
    /// SENDER-SIDE optimization with NO PEER-SIDE CHANGES required.
    ///
    /// # Mix-and-match with `flush_to_transport`
    ///
    /// Both APIs maintain the SHARED `last_flushed_vv` field, so
    /// callers can interleave full snapshots and deltas freely. A
    /// typical pattern:
    /// - Initial handshake: `flush_to_transport` to seed the peer
    ///   with full state.
    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
    ///   `flush_delta_to_transport`) sends tiny deltas per
    ///   mutation.
    /// - On peer reconnect: caller may choose to `flush_to_transport`
    ///   again as a safety net (Loro deduplicates on import; no
    ///   harm even if the peer already has those ops).
    ///
    /// # Error handling
    ///
    /// Same partial-state contract as `flush_to_transport`:
    /// - `CollabSessionError::OpLog` on `export_delta_bytes` failure.
    /// - `CollabSessionError::Transport` on `send` failure (Closed, Io).
    /// - `last_flushed_vv` is NOT updated on `Err` — a retry sends
    ///   the same delta the failed call would have sent.
    ///
    /// # Delivery semantics — queued vs acked
    ///
    /// **V2 V3 step 5 megaudit closure (Codex M1 + Opus-B M1,
    /// 2026-05-21):** "successful flush" means
    /// [`Transport::send`] returned `Ok` — which, per the trait
    /// contract, means bytes are **queued for send** to the currently-
    /// attached transport. For buffered async impls
    /// (`WebSocketTransport`), the bytes sit in an internal mpsc
    /// channel until the background writer task pushes them to the
    /// WebSocket sink. **`last_flushed_vv` advances at queue-success,
    /// not at wire-delivery confirmation.**
    ///
    /// Concrete consequences:
    /// - `has_pending_flush() == false` AFTER a successful flush means
    ///   "queued to the currently-attached transport," NOT "the peer
    ///   has received the ops."
    /// - If the transport is dropped between queue and wire (e.g., tab
    ///   close, app shutdown, transport panic), the in-flight bytes
    ///   are lost silently and the peer never receives them.
    /// - Recovery from transport drop is the same as recovery from
    ///   `Err(Closed)`: detach + reattach a new transport. The V2 V3
    ///   step 1 baseline-reset re-sends from empty VV — all ops are
    ///   redelivered, including the previously-"flushed" ones the
    ///   prior transport never put on the wire.
    ///
    /// For IDE consumers building "safe to close window?" workflows,
    /// the `has_pending_flush() == false` signal is insufficient on
    /// its own. **V2 V4 V1 step 1 (2026-05-21) Tier K1 closure**:
    /// call [`Self::flush_pending_to_transport`] after this method
    /// to block until the writer task has completed `ws_sink.send`
    /// for every queued blob — level-1 (local writer) ack. For
    /// TCP-level or peer-application-level ack, build a custom ack-op
    /// layered on `merge_bytes` (out of scope for V2 V4 V1).
    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
        if self.transport.is_none() {
            return Ok(false);
        }
        let current_vv = self.log.oplog_vv();
        // Idempotency short-circuit: no state change since last flush.
        // Closes V2 V2 audit M2/M3 (echo-loop). NOTE: VersionVector
        // equality is by value (Loro impls PartialEq via the
        // underlying op count per peer); a session that hasn't
        // appended/merged anything since the prior flush returns
        // Ok(false) without invoking transport.send.
        if let Some(last_vv) = self.last_flushed_vv.as_ref() {
            if last_vv == &current_vv {
                return Ok(false);
            }
        }
        // Encode delta bytes. `from = last_flushed_vv` (or empty if None).
        let bytes = match self.last_flushed_vv.as_ref() {
            Some(from) => self.log.export_delta_bytes(from)?,
            None => self
                .log
                .export_delta_bytes(&loro::VersionVector::default())?,
        };
        // Now borrow transport mutably for the send. Done in two
        // phases because we needed self.log (immut) above and need
        // self.transport (mut) here — borrow-checker dance.
        let transport = self.transport.as_mut().expect("just-checked is_some above");
        transport.send(&bytes)?;
        // Advance the VV checkpoint. Only on success — Err leaves
        // last_flushed_vv at its prior value so retry sends the
        // same delta.
        self.last_flushed_vv = Some(current_vv);
        Ok(true)
    }

    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain
    /// the attached transport's recv queue up to a default cap
    /// (`DEFAULT_POLL_REMOTE_LIMIT = 64` blobs), merging each
    /// blob into the local `OpLog`. Returns the number of blobs
    /// merged.
    ///
    /// For unbounded drain (or a different cap), use
    /// [`poll_remote_with_limit`]. The cap prevents one
    /// `poll_remote` call from starving the calling thread when
    /// a future externally-fed transport is producing faster
    /// than we drain.
    ///
    /// Returns `Ok(0)` if no transport attached.
    /// `TransportError::Closed` is handled gracefully — the
    /// trait contract guarantees Closed only after the queue
    /// drains, so the merge count reflects all queued blobs and
    /// the function returns `Ok(merged)`. `Io` errors propagate
    /// as `CollabSessionError::Transport` — any merges before
    /// the error already persist in the local `OpLog`.
    ///
    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** triggers ONE
    /// auto-flush after the drain batch (not per-blob), routed
    /// through [`flush_delta_to_transport`] when
    /// [`auto_flush_policy`] is `OnAppend` AND at least one blob
    /// was actually drained. V2 V3 step 1's idempotency short-
    /// circuit handles the Loro-deduped (no-op) merge case: if
    /// the drained bytes contained only ops already known
    /// locally, the post-merge VV doesn't advance and the
    /// auto-flush returns `Ok(false)` without invoking
    /// `transport.send`.
    ///
    /// V2 V2 audit (Codex M1 + Opus M1) flagged the prior
    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
    /// version-vector idempotency guard makes wiring it in safe
    /// (no echo loop), and V2 V3 step 2 (this) reverses the
    /// exclusion. The 3-peer fanout pattern (hub drains peer B's
    /// blob → hub auto-flushes merged state onward) now works
    /// automatically under `OnAppend`.
    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
    }

    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** like
    /// [`poll_remote`] but with an explicit per-call cap on the
    /// number of blobs to drain.
    ///
    /// `max_blobs == 0` is a no-op (returns `Ok(0)` even if
    /// blobs are queued — call again with a non-zero cap).
    ///
    /// Returns `Ok(merged)` where `merged <= max_blobs`. If the
    /// returned count equals `max_blobs`, more blobs may still
    /// be queued — call again. If less, the queue drained
    /// (either empty or transport reported `Closed`).
    ///
    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** when at least one
    /// blob was drained AND [`auto_flush_policy`] is `OnAppend`,
    /// fires ONE auto-flush after the loop (per-batch, not
    /// per-blob — bandwidth efficient). Routed through
    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
    /// guard short-circuits when the post-merge VV equals the
    /// pre-poll `last_flushed_vv` (i.e., the drained blobs only
    /// contained ops already known locally — Loro-deduped merge).
    ///
    /// **Auto-flush firing precision (V2 V4 V1 step 4 audit closures,
    /// Codex L1 + Codex L2, 2026-05-21)**: the precise rule is
    /// "after a non-empty drain that exits without error" — three
    /// normal exit paths fire the post-loop `maybe_auto_flush`:
    /// (a) loop reaches `max_blobs` cap → `while merged < max_blobs`
    /// condition false → fall through to `maybe_auto_flush`;
    /// (b) inner match returns `Ok(None)` → `break`;
    /// (c) inner match returns `Err(TransportError::Closed)` →
    /// `break` (treated as graceful EOF).
    /// If a later blob's `merge_bytes` errors (Loro decode failure)
    /// or `try_recv` errors with `Err(TransportError::Io(_))` (the
    /// only non-Closed `TransportError` variant today; future
    /// `#[non_exhaustive]` additions are similarly treated) after
    /// earlier blobs already merged, `current_vv` has advanced
    /// (earlier merges committed) but the post-loop
    /// `maybe_auto_flush` is SKIPPED via the `?` early return. This
    /// is NOT a false-synced state: `last_flushed_vv` is unchanged
    /// → `has_pending_flush()` returns `true` → next
    /// `flush_delta_to_transport` (or next `poll_remote_with_limit`
    /// that reaches a normal exit) WILL send the accumulated delta.
    /// Recovery is automatic; just bounded by when the next flush
    /// path actually fires.
    ///
    /// **Partial-state contract on auto-flush failure**: if the
    /// post-batch auto-flush fails (closed transport, I/O error
    /// during the send), the method returns
    /// `Err(CollabSessionError::Transport(_))` AFTER all `merged`
    /// blobs have been committed to `self.log`. The caller never
    /// sees `Ok(merged)` in this case; inspect `op_count()` to
    /// determine how many merges actually committed locally.
    /// `last_flushed_vv` is NOT advanced on flush Err — a retry
    /// (e.g., manual [`flush_delta_to_transport`] after detaching
    /// and reattaching a working transport) sends the same delta the
    /// failed call would have.
    pub fn poll_remote_with_limit(
        &mut self,
        max_blobs: usize,
    ) -> Result<usize, CollabSessionError> {
        let Some(transport) = self.transport.as_mut() else {
            return Ok(0);
        };
        let mut merged = 0usize;
        while merged < max_blobs {
            match transport.try_recv() {
                Ok(Some(bytes)) => {
                    self.log.merge_bytes(&bytes)?;
                    merged += 1;
                }
                Ok(None) => break,
                Err(TransportError::Closed) => {
                    // Trait contract: Closed only after queue drains. Any
                    // already-drained bytes are accounted in `merged`.
                    // Treat as graceful end-of-stream.
                    break;
                }
                Err(other) => return Err(CollabSessionError::Transport(other)),
            }
        }
        // **Phase 5.5 V2 V3 step 2 (2026-05-21):** auto-flush after
        // the drain batch. ONE flush per call (not per-blob) —
        // bandwidth-efficient. V2 V3 step 1's idempotency guard at
        // `flush_delta_to_transport` returns Ok(false) without
        // invoking transport.send when no state advanced (Loro-
        // deduped merge). Skip when 0 blobs drained: state didn't
        // change locally, no point firing the VV-clone+compare
        // path (defensive optimization).
        if merged > 0 {
            // V3.3.0.3: rebuild snapshot cache after drain.  Each
            // `self.log.merge_bytes` above bypassed the public
            // `CollabSession::merge_bytes` (to avoid per-blob auto-
            // flush + Result-error wrapping noise), so the cache
            // does NOT get invalidated incrementally.  One rebuild
            // per drain batch matches the `maybe_auto_flush` cadence
            // below.  Same correctness argument as `merge_bytes`:
            // Loro's CRDT merge can causally-reorder; full rebuild
            // is required.
            self.rebuild_snapshot_cache()?;
            // V3.6.0.2 D1: no frontier-state mutation needed -- the
            // Loro UndoManager's stack carries per-item meta with the
            // exact cells, which is preserved across remote merges.
            self.maybe_auto_flush()?;
        }
        Ok(merged)
    }

    /// **Phase 5.6 V1 (2026-05-19):** write this session's own
    /// presence state into the shared `"presence"` LoroMap.
    ///
    /// Uses the session's `PeerId` as the map key (16-hex
    /// `Display` form). Subsequent calls overwrite the previous
    /// value (LWW per peer); merges with other peers'
    /// presence writes preserve all distinct peers.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
    /// [`auto_flush_policy`]. Partial-state contract on flush
    /// failure: the presence write is already committed to
    /// `self.log` when the auto-flush attempt runs — same shape
    /// as `append_op` (see [`AutoFlushPolicy::OnAppend`]).
    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
        let key = presence::peer_key(self.peer_id);
        let json = serde_json::to_string(&state).map_err(PresenceError::Serialize)?;
        self.log.presence_set(&key, &json)?;
        self.maybe_auto_flush()?;
        Ok(())
    }

    /// **Phase 5.6 V1 (2026-05-19):** read a peer's most recent
    /// presence state. Returns `Ok(None)` if the peer has never
    /// updated its presence in this session (or has been removed
    /// via `clear_presence`).
    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
        let key = presence::peer_key(peer);
        let Some(json) = self.log.presence_get(&key)? else {
            return Ok(None);
        };
        let state: PresenceState =
            serde_json::from_str(&json).map_err(|source| PresenceError::Deserialize {
                peer_key: key,
                source,
            })?;
        Ok(Some(state))
    }

    /// **Phase 5.6 V1 (2026-05-19):** remove this session's own
    /// presence entry from the shared map. Use this when the
    /// peer leaves the session (window close, disconnect). After
    /// removal, other peers' `peer_presence(self_id)` returns
    /// `Ok(None)`.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
    /// [`auto_flush_policy`]. Same partial-state contract as
    /// `update_presence` — the removal is committed locally
    /// before the auto-flush attempt.
    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
        let key = presence::peer_key(self.peer_id);
        self.log.presence_remove(&key)?;
        self.maybe_auto_flush()?;
        Ok(())
    }

    /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
    /// local op. Loro's `UndoManager` semantically inverts it by
    /// appending an inverse op (NOT by physical removal). Returns
    /// `Ok(true)` if an undo stack item was consumed,
    /// `Ok(false)` if the stack was empty.
    ///
    /// Local-only per Loro's `UndoManager` contract — remote ops
    /// from other peers (merged via `merge_bytes`) are NOT
    /// affected.
    ///
    /// Presence updates are excluded from the undo stack by
    /// construction (see `CollabSession::new`), so cursor movements
    /// don't consume undo slots.
    ///
    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** triggers
    /// auto-flush per [`auto_flush_policy`], but ONLY when
    /// `consumed == true` (an inverse op was actually appended).
    /// `Ok(false)` on an empty stack never attempts the flush, so
    /// a closed transport cannot turn a "nothing to undo" into a
    /// spurious `Err(Transport(_))` (Codex M2 closure). Partial-
    /// state contract on flush failure when `consumed == true`:
    /// the inverse op is already committed to `self.log` — same
    /// shape as `append_op`.
    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
        // **Phase 5.7 V3.6.0.2 (2026-05-24) D1 -- Loro on_pop / top_undo_meta
        // partial-invalidate**:
        //
        // V3.5.0.6 partial-invalidate captured `self.log.iter().last()`
        // as a PROXY for the to-be-retracted op.  Wrong under causal
        // iteration order when a remote op trails the local op (Codex
        // A-HIGH-1 / Opus H2).  V3.5.0.X added a conservative
        // `pure_local_frontier` gate that fell back to full rebuild
        // whenever a remote op had interleaved.  V3.6.0.2 REMOVES the
        // proxy + gate entirely by reading `top_undo_meta()` BEFORE
        // calling Loro's undo.  The meta was set by the on_push
        // callback (configured in `make_undo_manager`) at the moment
        // the user pushed the op, with the EXACT cells encoded as
        // `LoroValue::List<List<I64>>` via `encode_cells_to_loro_value`.
        //
        // Pre-staging into `pending_undo_cells`: Loro's undo()
        // INTERNALLY pushes a synthetic inverse op onto the redo stack
        // (see loro-internal-1.12.0/src/undo.rs:858-872).  That push
        // fires `on_push` with `DiffEvent = None` and a fresh
        // CounterSpan.  Loro does NOT preserve the original meta
        // across stack transitions; our on_push closure must read
        // from `pending_undo_cells` to know what to encode.  We stage
        // the SAME cells we just decoded, so the redo-stack item gets
        // the matching meta -- preserving partial-invalidate
        // correctness across undo->redo->undo chains.
        //
        // Falls back to full rebuild on:
        // - Empty undo stack (no top_undo_meta).
        // - Decode failure (meta value isn't the expected LoroValue::List
        //   shape -- legacy session-snapshot import, malformed binding).
        // - Empty cells vector (non-cell-keyed op was originally
        //   pushed with `Some(empty Vec)` staged; see `append_op`).
        let captured_cells: Option<Vec<(u16, u32, u32)>> = self
            .undo
            .top_undo_meta()
            .and_then(|meta| decode_cells_from_loro_value(&meta.value));
        // Pre-stage these cells for the synthetic inverse op's on_push
        // (see docstring above).  We clone instead of moving so the
        // captured value stays available for the post-undo invalidate
        // loop below.  Empty Vec for the "no captured cells / full
        // rebuild" path is also pre-staged so the redo-stack item's
        // meta encodes empty.
        let pending_value = captured_cells.clone().unwrap_or_default();
        *self.pending_undo_cells.lock().expect("pending_undo_cells mutex poisoned") =
            Some(pending_value);
        let consumed = self.undo.undo()?;
        // **Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21):** only
        // auto-flush when an undo item was actually consumed. The prior
        // "flush unconditionally" pattern turned `Ok(false)` into
        // `Err(Transport(_))` when the transport was closed AND the
        // undo stack was empty — spurious failure semantics. With the
        // gate, `undo` on an empty stack stays `Ok(false)` regardless
        // of transport state (no mutation, no flush attempt).
        if consumed {
            match captured_cells {
                Some(cells) if !cells.is_empty() => {
                    for (sheet, row, col) in cells {
                        self.invalidate_cell(sheet, row, col)?;
                    }
                }
                _ => {
                    // Empty cells OR decode failed -- non-cell-keyed op
                    // OR legacy/malformed meta.  Conservative full
                    // rebuild (matches the V3.5.0.6 fallback semantic).
                    self.rebuild_snapshot_cache()?;
                }
            }
            self.maybe_auto_flush()?;
        } else {
            // Loro's undo() was a no-op (empty stack OR processing_undo
            // re-entrance guard).  Pending cells stash NOT drained by
            // on_push (which never fired).  Clear it so a subsequent
            // append_op doesn't see stale staged data.  Defensive --
            // the staged value would have been overwritten anyway, but
            // keeping the invariant "pending is None between calls"
            // simplifies reasoning.
            *self.pending_undo_cells.lock().expect("pending_undo_cells mutex poisoned") = None;
        }
        Ok(consumed)
    }

    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
    /// Returns `Ok(true)` if a redo stack item was consumed,
    /// `Ok(false)` if the stack was empty.
    ///
    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** matches
    /// [`undo`] — auto-flush fires only when `consumed == true`.
    /// Partial-state contract on flush failure when consumed:
    /// the redo's appended op is already in `self.log` (mutate-
    /// then-flush).
    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
        // **Phase 5.7 V3.6.0.2 (2026-05-24) D1 -- Loro top_redo_meta
        // partial-invalidate**: mirrors `undo` dispatch.  Read
        // `top_redo_meta()` BEFORE calling Loro's redo so we know
        // the EXACT cells the to-be-pushed op affects (encoded via
        // the on_push callback at the original local append AND
        // re-encoded by on_push during the prior undo when this
        // item was moved to the redo stack).
        //
        // Pre-staging into `pending_undo_cells`: Loro's redo()
        // pushes the original op back onto the undo stack via the
        // synthetic on_push call (DiffEvent = None).  We stage the
        // same cells so the undo-stack item gets the correct meta,
        // preserving partial-invalidate across redo->undo->redo
        // chains.
        //
        // Falls back to full rebuild on:
        // - Empty redo stack (no top_redo_meta).
        // - Decode failure.
        // - Empty cells (non-cell-keyed op originally pushed with
        //   `Some(empty Vec)` staged via `append_op`).
        let captured_cells: Option<Vec<(u16, u32, u32)>> = self
            .undo
            .top_redo_meta()
            .and_then(|meta| decode_cells_from_loro_value(&meta.value));
        let pending_value = captured_cells.clone().unwrap_or_default();
        *self.pending_undo_cells.lock().expect("pending_undo_cells mutex poisoned") =
            Some(pending_value);
        let consumed = self.undo.redo()?;
        // Phase 5.5 V2 V2 audit closure (Codex M2): gate matches `undo`.
        if consumed {
            match captured_cells {
                Some(cells) if !cells.is_empty() => {
                    for (sheet, row, col) in cells {
                        self.invalidate_cell(sheet, row, col)?;
                    }
                }
                _ => {
                    self.rebuild_snapshot_cache()?;
                }
            }
            self.maybe_auto_flush()?;
        } else {
            // Mirrors `undo()` -- clear stale staged data when redo()
            // was a no-op (on_push never fired).
            *self.pending_undo_cells.lock().expect("pending_undo_cells mutex poisoned") = None;
        }
        Ok(consumed)
    }

    /// **Phase 5.4 V1 (2026-05-19):** true iff the undo stack has
    /// at least one item.
    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    /// **Phase 5.4 V1 (2026-05-19):** true iff the redo stack has
    /// at least one item.
    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }

    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
    /// on the undo stack.
    pub fn undo_count(&self) -> usize {
        self.undo.undo_count()
    }

    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
    /// on the redo stack.
    pub fn redo_count(&self) -> usize {
        self.undo.redo_count()
    }

    /// **Phase 5.4 V1 (2026-05-19):** clear both undo and redo
    /// stacks. Use when starting a fresh logical session (e.g.
    /// opening a new workbook tab while reusing the
    /// `CollabSession` shell).
    pub fn clear_undo_stack(&self) {
        self.undo.clear();
    }

    /// **Phase 5.4 V2 V1 (2026-05-19):** begin a new undo group.
    /// All subsequent appends merge into a SINGLE undo unit on
    /// the undo stack; one `undo()` call after `end_undo_group`
    /// reverts all of them as a unit. Useful for atomic multi-
    /// cell operations (paste, fill-down, table import) where
    /// per-cell undo would surprise the user.
    ///
    /// Pair with [`end_undo_group`]. Calling `start_undo_group`
    /// while a group is already open returns
    /// `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
    /// deterministically (Loro 1.12.0 `loro-internal::undo:674-688`).
    /// Nesting is NOT supported.
    ///
    /// **Caller pitfall — panic / error mid-group:** if a call
    /// between `start_undo_group` and `end_undo_group` returns
    /// `Err` (via `?`) or panics, the group stays open and the
    /// next `start_undo_group` will fail with the deterministic
    /// `UndoGroupAlreadyStarted` error. **Prefer
    /// [`start_undo_group_scoped`]** (Phase 5.4 V2 V1.1 — RAII
    /// guard that auto-closes the group on scope exit, including
    /// on panic-unwind) over manual start/end pairing for any
    /// code path that can return `Err` mid-group.
    ///
    /// Closes GAP-C-04's "command grouping" half. Merge-interval
    /// auto-grouping is the complement — see
    /// [`set_undo_merge_interval`].
    pub fn start_undo_group(&mut self) -> Result<(), CollabSessionError> {
        self.undo.group_start()?;
        // V3.6.0.2 audit-closure (2026-05-24) -- grouped-undo flag.
        // Tracks "we're inside a Loro undo group" so `append_op` knows
        // to stage EMPTY cells (forcing full-rebuild fallback on undo).
        // Reason: Loro's `push_with_merge` discards subsequent meta when
        // merging spans inside a group; only the FIRST push's meta
        // survives.  Pre-fix, this caused undo of a grouped op to
        // invalidate only the first op's cells (stale cache).  Set
        // AFTER `group_start()` succeeds so a failing start (e.g.,
        // already-in-group error) doesn't toggle the flag.
        self.inside_group = true;
        Ok(())
    }

    /// **Phase 5.4 V2 V1 (2026-05-19):** close the current undo
    /// group started by [`start_undo_group`]. All appends since
    /// the matching `start_undo_group` are now a single undo
    /// unit.
    ///
    /// Loro's `group_end` is infallible; calling it without a
    /// matching `group_start` is a no-op. Safe to call in `Drop`
    /// guards.
    pub fn end_undo_group(&mut self) {
        self.undo.group_end();
        // V3.6.0.2 audit-closure: clear the grouped-undo flag.
        // Idempotent: calling end_undo_group without a matching
        // start (Loro's no-op semantic) safely clears an already-false
        // flag.  Safe to call from Drop guards (UndoGroupGuard).
        self.inside_group = false;
    }

    /// **Phase 5.4 V2 V1 (2026-05-19):** set the auto-merge
    /// interval in milliseconds. Consecutive changes within this
    /// window auto-merge into a single undo unit — useful for
    /// rapid typing where per-keystroke undo is too granular.
    ///
    /// `0` (Loro default) disables auto-merge. Negative values
    /// behave as `0` (Loro stores the raw `i64` and the compare
    /// `now - last_undo_time < interval_ms` is false for any
    /// non-negative elapsed time vs a negative threshold). Phase
    /// 5.4 V1 used the default; V2 V1 callers can opt in via
    /// this method. Recommended IDE settings: 200-500 ms for
    /// typing windows.
    ///
    /// Orthogonal to [`start_undo_group`] / [`end_undo_group`] —
    /// explicit groups take precedence over the interval.
    pub fn set_undo_merge_interval(&mut self, interval_ms: i64) {
        self.undo.set_merge_interval(interval_ms);
        // V3.6.0.2 audit-closure: mirror onto the session-side field so
        // `append_op` gates partial-invalidate correctly + so
        // `discard_pending_ops` can reapply the interval to the
        // recreated UndoManager.
        self.undo_merge_interval_ms = interval_ms;
    }

    /// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII variant of
    /// [`start_undo_group`]. Returns an [`UndoGroupGuard`] that
    /// holds a `&mut` borrow of this session; `Drop` on the
    /// guard automatically calls [`end_undo_group`].
    ///
    /// Panic-safe: if any code between this call and the guard's
    /// drop panics (including the body of a paste / fill-down /
    /// table-import operation), the guard's `Drop` still runs
    /// during unwinding and closes the group cleanly. Compare
    /// the manual start/end pattern which leaks group state on
    /// panic.
    ///
    /// Usage:
    /// ```ignore
    /// {
    ///     let mut guard = session.start_undo_group_scoped()?;
    ///     for (row, col, value) in paste_data {
    ///         guard.append_op(Op::PutValue { sheet: 0, row, col, value })?;
    ///     }
    ///     // guard drops here → end_undo_group runs.
    /// }
    /// // All N PutValue ops are now one undo unit.
    /// ```
    ///
    /// The guard implements `Deref<Target = CollabSession>` +
    /// `DerefMut`, so all of `CollabSession`'s methods are
    /// callable directly on the guard.
    ///
    /// Errors from [`start_undo_group`] propagate (nested call
    /// returns `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`).
    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, CollabSessionError> {
        self.start_undo_group()?;
        Ok(UndoGroupGuard { session: self })
    }

    /// **Phase 5.6 V2 (2026-05-19):** clear ALL presence entries
    /// from the shared `"presence"` LoroMap. Returns the number
    /// of entries removed.
    ///
    /// Use after [`from_snapshot`] when the caller wants a clean
    /// slate — without this call, presence entries persist across
    /// `.qbook` save/load (V1 known limitation: presence lives in
    /// the same `LoroDoc` whose snapshot is wrapped into the
    /// post-Tier-D3 `oplog.bin` file format).
    ///
    /// Typical pattern for "rejoin with clean presence":
    /// ```ignore
    /// let mut s = CollabSession::from_snapshot(peer_id, bytes)?;
    /// s.sweep_presence()?;
    /// // Presence is empty; first update_presence sets self fresh.
    /// ```
    ///
    /// Caller-opt-in by design: a session that WANTS to see other
    /// peers' last-known positions (e.g. an IDE rejoining a live
    /// collab session) skips the sweep.
    ///
    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers ONE auto-flush
    /// after the batch removal (not per-key — N intermediate
    /// snapshots would be wasted bandwidth). Partial-state contract
    /// on flush failure: all N presence entries are already
    /// removed locally when the auto-flush attempt runs.
    pub fn sweep_presence(&mut self) -> Result<usize, CollabSessionError> {
        let keys = self.log.presence_peers();
        let count = keys.len();
        for key in keys {
            self.log.presence_remove(&key)?;
        }
        // Phase 5.5 V2 V2: single auto-flush after the batch removal,
        // not per-key. Sending N intermediate snapshots would be wasted
        // bandwidth (peers only need the final post-sweep state).
        self.maybe_auto_flush()?;
        Ok(count)
    }

    /// **Phase 5.6 V1 (2026-05-19):** list every peer with a
    /// presence entry in the shared map.
    ///
    /// Order is Loro's iteration order. Sort the result if you
    /// need determinism.
    ///
    /// Returns `Err(CollabSessionError::Presence(PresenceError::PeerKeyParse))`
    /// if a key in the map can't be parsed as a `PeerId` (only
    /// reachable if a future writer uses an incompatible
    /// encoding).
    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, CollabSessionError> {
        let keys = self.log.presence_peers();
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            out.push(presence::parse_peer_key(&k)?);
        }
        Ok(out)
    }
}

impl std::fmt::Debug for CollabSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollabSession")
            .field("peer_id", &self.peer_id)
            .field("op_count", &self.log.len())
            .field("undo_count", &self.undo.undo_count())
            .field("redo_count", &self.undo.redo_count())
            .field("transport_attached", &self.transport.is_some())
            .finish()
    }
}

/// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII guard returned by
/// [`CollabSession::start_undo_group_scoped`]. `Drop` calls
/// `end_undo_group` automatically — runs on scope exit, on `?`
/// propagation, AND on panic-unwind. Use this in any code path
/// that can fail mid-group; the manual `start_undo_group` /
/// `end_undo_group` pair only handles the happy path.
///
/// Implements `Deref<Target = CollabSession>` + `DerefMut`, so
/// all `CollabSession` methods are callable directly on the
/// guard during its lifetime.
pub struct UndoGroupGuard<'a> {
    session: &'a mut CollabSession,
}

impl std::fmt::Debug for UndoGroupGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UndoGroupGuard")
            .field("session", &self.session)
            .finish()
    }
}

impl std::ops::Deref for UndoGroupGuard<'_> {
    type Target = CollabSession;
    fn deref(&self) -> &CollabSession {
        self.session
    }
}

impl std::ops::DerefMut for UndoGroupGuard<'_> {
    fn deref_mut(&mut self) -> &mut CollabSession {
        self.session
    }
}

impl Drop for UndoGroupGuard<'_> {
    fn drop(&mut self) {
        // `end_undo_group` is infallible per Loro 1.12.0; safe in
        // Drop. If the group has already been closed manually
        // (shouldn't happen via this guard, but defensively), Loro
        // treats it as a no-op.
        self.session.end_undo_group();
    }
}

/// Construct + configure a Loro `UndoManager` bound to `log`'s
/// underlying doc.
///
/// Phase 5.4 V1 setup: register `PRESENCE_COMMIT_ORIGIN` as an
/// exclude prefix so cursor-movement commits don't fill the
/// undo stack. (Phase 5.6 V1 tags presence writes with that
/// origin via `OpLog::presence_set` / `presence_remove`.)
///
/// **Phase 5.7 V3.6.0.2 (2026-05-24) D1**: also wires Loro's
/// `set_on_push` callback to capture affected cells of every
/// pushed op into `UndoItemMeta::value` (encoded as
/// `LoroValue::List<List<I64>>` per `encode_cells_to_loro_value`).
/// The cells come from `pending_undo_cells` (set by `append_op`
/// before its `self.log.append(op)` call OR by `undo()` /
/// `redo()` before their Loro call -- the latter for the
/// synthetic inverse op that Loro pushes onto the opposite
/// stack).  `undo()` / `redo()` read back via `top_undo_meta()`
/// / `top_redo_meta()` to know which cells to invalidate.  See
/// `pending_undo_cells` field docstring for the full handoff
/// pattern + re-entrancy analysis.
///
/// The Arc is cloned into the closure (`on_push` requires
/// `Send + Sync`); the original Arc stays on `CollabSession`.
/// Re-creating the UndoManager (in `discard_pending_ops`) drops
/// the OLD closure (and its Arc clone) and creates a fresh
/// closure with a NEW Arc clone -- both clones point at the
/// SAME Mutex, so the handoff pattern keeps working.
fn make_undo_manager(
    log: &OpLog,
    pending_undo_cells: Arc<Mutex<Option<Vec<(u16, u32, u32)>>>>,
) -> loro::UndoManager {
    let mut undo = log.new_undo_manager();
    undo.add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN);
    undo.set_on_push(Some(Box::new(move |_source, _span, _diff| {
        // Drain the pre-staged cells (set by append_op /
        // undo / redo before the Loro op that triggered this
        // push).  Take() leaves the Mutex at None so a
        // subsequent (unstaged) push encodes empty cells ->
        // full rebuild fallback.
        let cells = pending_undo_cells
            .lock()
            .expect("pending_undo_cells mutex poisoned in on_push")
            .take()
            .unwrap_or_default();
        loro::UndoItemMeta {
            value: encode_cells_to_loro_value(&cells),
            cursors: Default::default(),
        }
    })));
    undo
}

/// **Phase 5.7 V3.6.0.2 D1 (2026-05-24)** -- encode a Vec of
/// (sheet, row, col) cell coordinates into a `LoroValue` for
/// storage in `UndoItemMeta::value`.
///
/// Shape: `LoroValue::List` of `LoroValue::List` of three
/// `LoroValue::I64`s `[sheet, row, col]`.  Chosen over
/// `LoroValue::Map { "cells": List, ... }` for compactness +
/// straightforward decoder (no key lookup; pure index access).
///
/// **Encoding cost**: O(N) where N = cells.len().  Typical N
/// per op = 1 (PutValue / PutFormula / ClearFormula /
/// SetCellFormat each affect one cell); BatchCommit with all-
/// cell-keyed inner ops bumps N to inner-op count.  Encoded
/// LoroValue is wrapped in `Arc<Vec<LoroValue>>` so the
/// `UndoItemMeta::value` clone (one of which happens on every
/// `top_undo_meta()` read) is O(1) -- Loro Arc-clones the
/// outer container.
///
/// **Negative cases**: `cells.is_empty()` returns
/// `LoroValue::List(empty)` which decodes back to
/// `Some(Vec::new())`.  The undo/redo dispatch treats empty
/// cells as a "fall back to full rebuild" signal (semantically
/// equivalent to the V3.5.0.6 non-cell-keyed-op path).
fn encode_cells_to_loro_value(cells: &[(u16, u32, u32)]) -> LoroValue {
    let inner: Vec<LoroValue> = cells
        .iter()
        .map(|(sheet, row, col)| {
            LoroValue::List(
                vec![
                    LoroValue::I64(*sheet as i64),
                    LoroValue::I64(*row as i64),
                    LoroValue::I64(*col as i64),
                ]
                .into(),
            )
        })
        .collect();
    LoroValue::List(inner.into())
}

/// **Phase 5.7 V3.6.0.2 D1 (2026-05-24)** -- decode the
/// inverse of `encode_cells_to_loro_value`.  Returns `Some(Vec)`
/// on success (including `Some(Vec::new())` for the empty
/// case), `None` on any structural mismatch (legacy / corrupt
/// / future-version meta).
///
/// **Defensive over-restrictive decoding**: any inner element
/// that isn't a 3-element list of I64s causes the whole decode
/// to return None.  Callers fall back to full rebuild in that
/// case -- safe but conservative.  V3.6+ schema additions
/// would be additive (longer inner lists with new trailing
/// fields) and could backward-compat extend this decoder.
///
/// **Range checks**: i64 -> u16/u32 conversion via `try_into`
/// fails if the value is negative or out of range.  Returns
/// None on failure.  Realistic encoder always emits non-negative
/// values within range (CellWireValue's sheet/row/col are
/// u16/u32 by construction).
fn decode_cells_from_loro_value(value: &LoroValue) -> Option<Vec<(u16, u32, u32)>> {
    let outer = value.as_list()?;
    let mut cells = Vec::with_capacity(outer.len());
    for inner_value in outer.iter() {
        let inner = inner_value.as_list()?;
        if inner.len() != 3 {
            return None;
        }
        let sheet_i64 = *inner[0].as_i64()?;
        let row_i64 = *inner[1].as_i64()?;
        let col_i64 = *inner[2].as_i64()?;
        let sheet: u16 = sheet_i64.try_into().ok()?;
        let row: u32 = row_i64.try_into().ok()?;
        let col: u32 = col_i64.try_into().ok()?;
        cells.push((sheet, row, col));
    }
    Some(cells)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_oplog::CellWireValue;

    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
        Op::PutValue {
            sheet,
            row,
            col,
            value: CellWireValue::Number(n),
        }
    }

    /// V3.4.0.2 test helper -- mirrors `put_value` for formula ops.
    fn put_formula(sheet: u16, row: u32, col: u32, text: &str) -> Op {
        Op::PutFormula {
            sheet,
            row,
            col,
            text: text.to_string(),
        }
    }

    /// V3.4.0.2 test helper -- mirrors `put_value` for clear-formula ops.
    fn clear_formula(sheet: u16, row: u32, col: u32) -> Op {
        Op::ClearFormula { sheet, row, col }
    }

    /// **V3.5.0.5 test helper (2026-05-24)** -- mirrors `put_value` for
    /// `Op::SetCellFormat` ops with a `Builtin(_)` format.  Use this
    /// for the common case of setting a built-in Excel format id.
    /// `id: None` -> clear (separate `clear_cell_format` helper).
    fn set_cell_format_builtin(sheet: u16, row: u32, col: u32, builtin: u32) -> Op {
        Op::SetCellFormat {
            sheet,
            row,
            col,
            id: Some(ql_oplog::wire::FormatIdWire::Builtin { id: builtin }),
        }
    }

    /// **V3.5.0.5 test helper (2026-05-24)** -- emit a `Op::SetCellFormat`
    /// with `id: None` (clears the cell's format).  Matches the W5-80
    /// "clear overlay" semantic.
    fn clear_cell_format(sheet: u16, row: u32, col: u32) -> Op {
        Op::SetCellFormat {
            sheet,
            row,
            col,
            id: None,
        }
    }

    /// **V3.6.0.3 D2 test helper (2026-05-24)** -- emit a custom
    /// `Op::RegisterFormat` for the local peer.  `counter` is the
    /// per-peer FormatId counter (caller's responsibility to advance).
    fn register_custom_format(peer: PeerId, counter: u32, s: &str) -> Op {
        Op::RegisterFormat {
            id: ql_oplog::wire::FormatIdWire::Custom { peer, counter },
            string: s.to_string(),
        }
    }

    #[test]
    fn new_session_is_empty() {
        let s = CollabSession::new(PeerId::new(1)).unwrap();
        assert_eq!(s.peer_id(), PeerId::new(1));
        assert_eq!(s.op_count(), 0);
        assert!(s.is_empty());
    }

    #[test]
    fn append_grows_log() {
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
        assert_eq!(s.op_count(), 2);
        assert!(!s.is_empty());
    }

    #[test]
    fn from_snapshot_reconstructs_op_count() {
        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
        origin
            .append_op(Op::AddSheet {
                name: "S".to_owned(),
                chunk_rows: 16384,
            })
            .unwrap();
        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();

        let bytes = origin.export_bytes().unwrap();
        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
        assert_eq!(reborn.peer_id(), PeerId::new(2));
        assert_eq!(reborn.op_count(), 2);
    }

    #[test]
    fn merge_bytes_grows_log_with_remote_ops() {
        // Two peers, shared base, each appends; one merges the other.
        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
        base.append_op(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();

        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();

        // Peer A pulls peer B's bytes.
        let b_bytes = peer_b.export_bytes().unwrap();
        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
        assert!(
            merged_count >= 3,
            "merged log has at least AddSheet + 2× PutValue (got {merged_count})"
        );
    }

    #[test]
    fn debug_impl_includes_peer_id_and_count() {
        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).ok();
        let d = format!("{s:?}");
        assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
        assert!(d.contains("op_count"), "Debug must include op_count: {d}");
    }

    #[test]
    fn peer_id_is_wired_to_underlying_loro_doc() {
        // Regression: prior to Phase 5.2.b the PeerId was stored on
        // CollabSession but never passed to LoroDoc::set_peer_id, so
        // op attribution at the CRDT layer used Loro's random
        // per-doc peer id. After 5.2.b the configured PeerId MUST
        // appear as the underlying log's peer_id().
        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
    }

    #[test]
    fn from_snapshot_overrides_imported_peer_id() {
        // The origin session writes ops under PeerId(11). The reborn
        // session imports the snapshot but uses its own PeerId(22)
        // for future appends — the imported ops keep their original
        // attribution (Loro semantics), but log.peer_id() reflects
        // the reborn's configured PeerId.
        //
        // Codex/Opus 5.2.b audit caught: the prior version exported
        // an empty origin, so the "imported ops retain peer 11"
        // promise was never exercised. Now we append before export
        // and assert the imported op survives the peer-id change.
        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
        origin
            .append_op(Op::AddSheet {
                name: "S".to_owned(),
                chunk_rows: 16384,
            })
            .unwrap();
        let bytes = origin.export_bytes().unwrap();

        let mut reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
        assert_eq!(reborn.op_log().peer_id(), 22);
        assert_eq!(
            reborn.op_count(),
            1,
            "imported op must survive peer-id swap"
        );
        // Reborn can append under its new peer id.
        reborn.append_op(put_value(0, 0, 0, 99.0)).unwrap();
        assert_eq!(reborn.op_count(), 2);
        assert_eq!(reborn.op_log().peer_id(), 22);
    }

    #[test]
    fn presence_round_trip_within_one_session() {
        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
        // No presence yet.
        assert_eq!(s.peer_presence(PeerId::new(7)).unwrap(), None);
        assert!(s.peers_with_presence().unwrap().is_empty());

        // Set our own.
        let state = PresenceState {
            sheet: 1,
            row: 10,
            col: 5,
            selection_end_row: 12,
            selection_end_col: 7,
            typing: true,
        };
        s.update_presence(state).unwrap();

        let read = s.peer_presence(PeerId::new(7)).unwrap().unwrap();
        assert_eq!(read, state);
        let peers = s.peers_with_presence().unwrap();
        assert_eq!(peers, vec![PeerId::new(7)]);

        // Overwrite (LWW per key).
        let state2 = PresenceState::at_cell(0, 0, 0);
        s.update_presence(state2).unwrap();
        let read2 = s.peer_presence(PeerId::new(7)).unwrap().unwrap();
        assert_eq!(read2, state2);
        assert_eq!(s.peers_with_presence().unwrap().len(), 1);

        // Clear.
        s.clear_presence().unwrap();
        assert_eq!(s.peer_presence(PeerId::new(7)).unwrap(), None);
        assert!(s.peers_with_presence().unwrap().is_empty());
    }

    #[test]
    fn presence_two_peer_merge_preserves_both() {
        // Both peers fork from the same empty base. Each writes
        // its own presence; one merges the other's snapshot. After
        // merge BOTH peers see BOTH presences (LoroMap LWW per key
        // keeps distinct keys).
        let base = CollabSession::new(PeerId::new(1)).unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0x0a), &base_bytes).unwrap();
        peer_a
            .update_presence(PresenceState::at_cell(0, 3, 4))
            .unwrap();

        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0x0b), &base_bytes).unwrap();
        peer_b
            .update_presence(PresenceState::at_cell(1, 100, 200))
            .unwrap();

        // Peer A merges peer B's snapshot.
        let b_bytes = peer_b.export_bytes().unwrap();
        peer_a.merge_bytes(&b_bytes).unwrap();

        // Peer A now sees BOTH presences.
        let a = peer_a.peer_presence(PeerId::new(0x0a)).unwrap().unwrap();
        assert_eq!(a, PresenceState::at_cell(0, 3, 4));
        let b = peer_a.peer_presence(PeerId::new(0x0b)).unwrap().unwrap();
        assert_eq!(b, PresenceState::at_cell(1, 100, 200));

        let mut peers = peer_a.peers_with_presence().unwrap();
        peers.sort();
        assert_eq!(peers, vec![PeerId::new(0x0a), PeerId::new(0x0b)]);
    }

    #[test]
    fn presence_merge_is_commutative() {
        // Audit-discipline closure (Codex 5.6 V1 LOW-1): the
        // existing 2-peer test only verifies one merge direction.
        // This test exercises BOTH directions and asserts the
        // final state is identical.
        fn make_pair() -> (CollabSession, CollabSession) {
            let base = CollabSession::new(PeerId::new(1)).unwrap();
            let base_bytes = base.export_bytes().unwrap();
            let mut a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
            a.update_presence(PresenceState::at_cell(0, 1, 2)).unwrap();
            let mut b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
            b.update_presence(PresenceState::at_cell(3, 4, 5)).unwrap();
            (a, b)
        }

        // Direction 1: A merges B.
        let (mut a1, b1) = make_pair();
        a1.merge_bytes(&b1.export_bytes().unwrap()).unwrap();

        // Direction 2: B merges A (fresh pair to avoid state pollution).
        let (a2, mut b2) = make_pair();
        b2.merge_bytes(&a2.export_bytes().unwrap()).unwrap();

        // Both ended states must agree on the peer set + per-peer
        // values.
        let mut a1_peers = a1.peers_with_presence().unwrap();
        let mut b2_peers = b2.peers_with_presence().unwrap();
        a1_peers.sort();
        b2_peers.sort();
        assert_eq!(a1_peers, b2_peers);
        for peer in a1_peers {
            assert_eq!(
                a1.peer_presence(peer).unwrap(),
                b2.peer_presence(peer).unwrap(),
                "peer {peer:?} state must agree across merge directions"
            );
        }
    }

    #[test]
    fn presence_tombstone_propagates_through_merge() {
        // Audit-discipline closure (Codex 5.6 V1 LOW-1 / C4): peer A
        // sets presence, B merges + sees A. Then A clears its
        // presence and re-exports. B merges the cleared snapshot
        // and MUST observe A as gone.
        let base = CollabSession::new(PeerId::new(1)).unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xaa), &base_bytes).unwrap();
        peer_a
            .update_presence(PresenceState::at_cell(0, 0, 0))
            .unwrap();

        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xbb), &base_bytes).unwrap();
        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
        assert!(
            peer_b.peer_presence(PeerId::new(0xaa)).unwrap().is_some(),
            "B must initially see A's presence after first merge"
        );

        // A leaves the session.
        peer_a.clear_presence().unwrap();

        // B pulls A's new state.
        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
        assert_eq!(
            peer_b.peer_presence(PeerId::new(0xaa)).unwrap(),
            None,
            "B must see A as cleared after merging the tombstone"
        );
    }

    #[test]
    fn undo_redo_local_appends() {
        // Append two ops, undo both, redo both. Verify can_undo /
        // can_redo / undo_count / redo_count track correctly.
        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
        assert!(!s.can_undo());
        assert!(!s.can_redo());
        assert_eq!(s.undo_count(), 0);
        assert_eq!(s.redo_count(), 0);

        s.append_op(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        assert!(s.can_undo());
        assert_eq!(s.undo_count(), 2);
        assert_eq!(s.redo_count(), 0);

        // Undo the second op.
        assert!(s.undo().unwrap());
        assert_eq!(s.undo_count(), 1);
        assert_eq!(s.redo_count(), 1);
        assert!(s.can_redo());

        // Undo the first op.
        assert!(s.undo().unwrap());
        assert_eq!(s.undo_count(), 0);
        assert_eq!(s.redo_count(), 2);
        assert!(!s.can_undo());

        // Undo on empty stack returns false.
        assert!(!s.undo().unwrap());

        // Redo both back.
        assert!(s.redo().unwrap());
        assert!(s.redo().unwrap());
        assert_eq!(s.undo_count(), 2);
        assert_eq!(s.redo_count(), 0);
        assert!(!s.can_redo());
        assert!(!s.redo().unwrap());
    }

    #[test]
    fn presence_updates_do_not_consume_undo_stack() {
        // 5.4 V1 acceptance: cursor movement (presence_set) MUST
        // NOT push items onto the undo stack. Otherwise every
        // keystroke would burn an undo slot.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let baseline_undo = s.undo_count();

        for row in 0..10 {
            s.update_presence(PresenceState::at_cell(0, row, 0))
                .unwrap();
        }

        assert_eq!(
            s.undo_count(),
            baseline_undo,
            "presence writes must be excluded from the undo stack \
             (PRESENCE_COMMIT_ORIGIN excludes them via UndoManager::add_exclude_origin_prefix)"
        );
    }

    #[test]
    fn undo_group_collapses_appends_to_single_unit() {
        // Phase 5.4 V2 V1 acceptance: 5 appends inside a group
        // collapse to ONE undo stack item. A single undo() call
        // reverts all 5 as a unit.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        assert_eq!(s.undo_count(), 0);

        s.start_undo_group().unwrap();
        for col in 0..5 {
            s.append_op(put_value(0, 0, col, col as f64)).unwrap();
        }
        s.end_undo_group();

        // After group_end, the stack has ONE item, not 5.
        assert_eq!(
            s.undo_count(),
            1,
            "5 grouped appends must collapse to 1 undo unit"
        );

        // One undo reverts all 5 (the visible op count must drop
        // to ≤ 0 — Loro retracts all 5 from the visible list).
        assert!(s.undo().unwrap());
        assert_eq!(s.undo_count(), 0);
        assert_eq!(s.redo_count(), 1);
        assert_eq!(
            s.op_log().iter().count(),
            0,
            "all 5 grouped ops retracted from visible log"
        );

        // Redo restores all 5 as a unit too.
        assert!(s.redo().unwrap());
        assert_eq!(s.op_log().iter().count(), 5);
        assert_eq!(s.undo_count(), 1);
        assert_eq!(s.redo_count(), 0, "redo consumed the only redo item");
    }

    #[test]
    fn grouped_undo_clears_cache_for_all_cells_in_the_group() {
        // **V3.6.0.2 audit-closure (2026-05-24)** -- regression test
        // for the V3.6.0.2 grouped-undo bug that Codex Lane A's probe
        // discovered.
        //
        // Pre-fix scenario:
        // 1. start_undo_group; append 5 PutValue ops at (0,0,0)..(0,0,4);
        //    end_undo_group.
        // 2. Loro's `push_with_merge` (loro-internal-1.12.0/src/undo.rs:
        //    389-396) merges all 5 spans into ONE stack item; the meta
        //    of the FIRST push survives (cells = [(0,0,0)]); the other
        //    4 metas are DISCARDED.
        // 3. undo() reads top_undo_meta = [(0,0,0)] -> partial-invalidate
        //    drops cache entry for (0,0,0) -> the other 4 entries STAY
        //    STALE in `last_snapshot`.
        //
        // V3.6.0.2 audit-closure fix: `inside_group: bool` field on
        // CollabSession.  start_undo_group sets true; end_undo_group
        // clears.  When inside_group, `append_op` stages EMPTY cells
        // (not the op's actual cells) -> meta encodes empty -> undo
        // decodes empty -> falls back to full `rebuild_snapshot_cache`.
        // Matches V3.5.0.6 semantics for grouped undo.
        //
        // This test pins the post-fix behavior: ALL 5 cells must be
        // gone from the cache after undo of the group.  Pre-fix it
        // would fail with len = 4 (cells (0,0,1)..(0,0,4) stale).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.start_undo_group().unwrap();
        for col in 0..5 {
            s.append_op(put_value(0, 0, col, col as f64)).unwrap();
        }
        s.end_undo_group();

        // Pre-undo: all 5 cells present in cache.
        assert_eq!(
            s.snapshot_cells(0).len(),
            5,
            "pre-undo: all 5 grouped PutValues populate the cache"
        );

        // Undo the group.
        assert!(s.undo().unwrap());
        assert_eq!(s.op_log().iter().count(), 0, "all 5 ops retracted");
        assert_eq!(
            s.snapshot_cells(0).len(),
            0,
            "post-undo: ALL 5 cells must be gone from the cache \
             (V3.6.0.2 audit-closure: full-rebuild fallback for grouped \
             undo; matches V3.5.0.6 semantics; the on_push meta-only \
             path cannot accumulate cells across Loro's push_with_merge)"
        );

        // Redo restores all 5; cache repopulates.
        assert!(s.redo().unwrap());
        assert_eq!(s.op_log().iter().count(), 5);
        assert_eq!(
            s.snapshot_cells(0).len(),
            5,
            "post-redo: all 5 cells back in the cache (full-rebuild path \
             also handles redo correctly)"
        );

        // Verify the cells are at the expected coords with expected values.
        let entries: Vec<_> = s.snapshot_cells(0).into_iter().collect();
        for col in 0..5 {
            assert!(
                entries.iter().any(|((r, c), st)| *r == 0
                    && *c == col
                    && matches!(&st.value, Some(CellWireValue::Number(n)) if *n == col as f64)),
                "post-redo: cell (0, 0, {}) with value {} expected",
                col,
                col
            );
        }
    }

    #[test]
    fn merge_interval_undo_clears_cache_for_all_cells_in_window() {
        // **V3.6.0.2 audit-closure (2026-05-24)** -- regression test
        // for the time-merge variant of the same Loro `push_with_merge`
        // pathology that grouped undo exposed.
        //
        // Setting `set_undo_merge_interval(large_value)` makes Loro
        // merge consecutive appends within the time window.  The
        // meta-discard issue is identical: only the FIRST push's meta
        // survives the merge.
        //
        // V3.6.0.2 audit-closure fix: `undo_merge_interval_ms > 0`
        // forces empty-cells staging in `append_op` (full-rebuild
        // fallback on undo).  This test verifies the cache is cleared
        // correctly when undoing a time-merged sequence.
        //
        // i64::MAX as the interval makes EVERY append merge into the
        // prior stack item -- deterministic (no timing flakiness).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.set_undo_merge_interval(i64::MAX);
        for col in 0..5 {
            s.append_op(put_value(0, 0, col, col as f64)).unwrap();
        }

        // All 5 appends merged into one undo stack item.
        assert_eq!(
            s.undo_count(),
            1,
            "i64::MAX merge interval collapses all 5 to one undo unit"
        );
        assert_eq!(s.snapshot_cells(0).len(), 5, "all 5 cells in cache");

        // Undo the merged group.
        assert!(s.undo().unwrap());
        assert_eq!(s.op_log().iter().count(), 0, "all 5 ops retracted");
        assert_eq!(
            s.snapshot_cells(0).len(),
            0,
            "post-undo: cache fully cleared via full-rebuild fallback \
             (V3.6.0.2 audit-closure: `undo_merge_interval_ms > 0` \
             gates empty-cells staging in append_op)"
        );
    }

    #[test]
    fn register_format_op_populates_session_format_table_cache() {
        // **V3.6.0.3 D2 (2026-05-24)** -- regression test: an
        // `Op::RegisterFormat` append updates the session-side
        // `format_table_cache` via `CacheEffect::RegisterFormat`.
        //
        // Verifies the cache walker discipline: every Op that emits
        // cache effects has them propagated to the session-side
        // cache via append_op's per-effect apply loop.
        let peer = PeerId::new(7);
        let mut s = CollabSession::new(peer).unwrap();

        // Pre-condition: empty cache.
        assert_eq!(
            s.format_table_cache_iter().count(),
            0,
            "fresh session has empty format_table_cache"
        );

        // Append three RegisterFormat ops with distinct ids + strings.
        s.append_op(register_custom_format(peer, 0, "0.00%")).unwrap();
        s.append_op(register_custom_format(peer, 1, "yyyy-mm-dd")).unwrap();
        s.append_op(register_custom_format(peer, 2, "$#,##0.00")).unwrap();

        // Post-condition: cache has all three entries.
        let entries: Vec<(FormatId, String)> = s
            .format_table_cache_iter()
            .map(|(id, s)| (*id, s.as_ref().to_string()))
            .collect();
        assert_eq!(entries.len(), 3, "three RegisterFormat ops -> three cache entries");

        // Verify each entry is present.
        for (expected_counter, expected_string) in [
            (0u32, "0.00%"),
            (1, "yyyy-mm-dd"),
            (2, "$#,##0.00"),
        ] {
            let expected_id = FormatId::Custom(peer, expected_counter);
            let found = entries.iter().any(|(id, s)| *id == expected_id && s == expected_string);
            assert!(
                found,
                "cache must contain ({:?}, {:?})",
                expected_id, expected_string
            );
        }
    }

    #[test]
    fn register_format_cache_rebuilds_from_log_via_rebuild_snapshot_cache() {
        // **V3.6.0.3 D2** -- verify that `rebuild_snapshot_cache` (the
        // path used by merge_bytes / from_snapshot / discard_pending_ops)
        // correctly rebuilds the format_table_cache alongside
        // last_snapshot + removed_sheets.
        let peer = PeerId::new(7);
        let mut s = CollabSession::new(peer).unwrap();
        s.append_op(register_custom_format(peer, 0, "0.00%")).unwrap();
        s.append_op(register_custom_format(peer, 1, "yyyy-mm-dd")).unwrap();

        // Pre-condition: incremental cache populated.
        assert_eq!(s.format_table_cache_iter().count(), 2);

        // Force a full rebuild via the test seam.
        s.force_clear_snapshot_cache();
        assert_eq!(
            s.format_table_cache_iter().count(),
            0,
            "force_clear_snapshot_cache also clears format_table_cache (V3.6.0.3 \
             extended the test seam alongside last_snapshot + removed_sheets clears)"
        );
        // Rebuild from the log; format_table_cache should repopulate.
        s.rebuild_snapshot_cache().unwrap();
        let entries: Vec<(FormatId, String)> = s
            .format_table_cache_iter()
            .map(|(id, s)| (*id, s.as_ref().to_string()))
            .collect();
        assert_eq!(
            entries.len(),
            2,
            "rebuild_snapshot_cache repopulates the format_table_cache from the op log"
        );
        for (counter, string) in [(0u32, "0.00%"), (1, "yyyy-mm-dd")] {
            let expected = FormatId::Custom(peer, counter);
            assert!(
                entries.iter().any(|(id, s)| *id == expected && s == string),
                "post-rebuild: cache contains ({:?}, {:?})",
                expected,
                string
            );
        }
    }

    #[test]
    fn nested_start_undo_group_returns_already_started_error() {
        // Codex+Opus 5.4 V2 V1 audit MEDIUM-1 closure: Loro's
        // group_start returns `Err(LoroError::UndoGroupAlreadyStarted)`
        // deterministically. Pin the contract so a future Loro
        // upgrade can't silently change it.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.start_undo_group().unwrap();
        let err = s.start_undo_group().unwrap_err();
        assert!(
            matches!(err, CollabSessionError::Undo(_)),
            "nested start_undo_group must return Undo(LoroError::UndoGroupAlreadyStarted), got {err:?}"
        );
        // Recovery works after explicit end.
        s.end_undo_group();
        assert!(s.start_undo_group().is_ok(), "fresh start after end works");
        s.end_undo_group();
    }

    #[test]
    fn scoped_undo_group_collapses_on_drop() {
        // Phase 5.4 V2 V1.1: RAII guard drops at scope exit and
        // calls end_undo_group. 3 appends inside the guard scope
        // collapse to 1 undo unit.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        assert_eq!(s.undo_count(), 0);
        {
            let mut guard = s.start_undo_group_scoped().unwrap();
            guard.append_op(put_value(0, 0, 0, 1.0)).unwrap();
            guard.append_op(put_value(0, 0, 1, 2.0)).unwrap();
            guard.append_op(put_value(0, 0, 2, 3.0)).unwrap();
        } // guard drops here → end_undo_group
        assert_eq!(s.undo_count(), 1, "RAII guard must close group on drop");
        // One undo retracts all 3.
        assert!(s.undo().unwrap());
        assert_eq!(s.op_log().iter().count(), 0);
    }

    #[test]
    fn scoped_undo_group_closes_on_early_return_with_err() {
        // V2 V1.1 panic/Err safety: even if the body of the
        // closure returns Err via `?`, the guard's Drop still
        // runs and closes the group. Pin this so callers can
        // rely on it.
        fn try_op(s: &mut CollabSession) -> Result<(), CollabSessionError> {
            let mut guard = s.start_undo_group_scoped()?;
            guard.append_op(put_value(0, 0, 0, 1.0))?;
            // Simulate a mid-group error by returning Err here.
            // The guard's Drop runs as we unwind to the caller.
            // We use a contrived CollabSession-error to exercise
            // the propagation path.
            return Err(CollabSessionError::OpLog(
                ql_oplog::OpLogError::SchemaMismatch("forced error for test"),
            ));
            #[allow(unreachable_code)]
            {
                guard.append_op(put_value(0, 0, 1, 2.0))?;
                Ok(())
            }
        }

        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let result = try_op(&mut s);
        assert!(result.is_err(), "forced error must propagate");
        // After the error, the group is closed (one append got
        // through before the forced error; that one is in a
        // (now closed) undo group).
        assert_eq!(
            s.undo_count(),
            1,
            "guard Drop must close group even on Err early-return"
        );
        // A subsequent start_undo_group_scoped must succeed (no
        // leaked open group).
        let _guard = s.start_undo_group_scoped().unwrap();
    }

    #[test]
    fn scoped_undo_group_supports_deref_to_session() {
        // The guard implements Deref + DerefMut, so callers can
        // invoke CollabSession methods directly on the guard
        // (append_op, peer_id, op_count, etc.).
        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
        let mut guard = s.start_undo_group_scoped().unwrap();
        assert_eq!(guard.peer_id(), PeerId::new(7), "Deref reads work");
        assert_eq!(guard.op_count(), 0);
        guard.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        assert_eq!(guard.op_count(), 1, "DerefMut writes work");
        drop(guard);
        assert_eq!(s.undo_count(), 1);
    }

    #[test]
    fn scoped_undo_group_nested_returns_err() {
        // Nested start_undo_group_scoped (without ending the
        // outer first) must return Err, just like the non-
        // scoped variant.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let _guard1 = s.start_undo_group_scoped().unwrap();
        // Cannot call start_undo_group_scoped on s while guard1
        // is alive (borrow checker). Test the equivalent via
        // the underlying method on the guarded session:
        // ... actually the borrow checker prevents this at
        // compile time, which is GOOD — the RAII guard makes
        // accidental nesting a compile error rather than a
        // runtime error. Document this fact:
        // let _guard2 = s.start_undo_group_scoped(); // <-- borrow error
        //
        // To verify the runtime contract still holds for
        // non-scoped nesting, drop guard1 then re-test:
        drop(_guard1);
        // Now manually open a non-scoped group + try to start
        // a scoped one.
        s.start_undo_group().unwrap();
        let is_err = {
            let result = s.start_undo_group_scoped();
            let is_err = matches!(&result, Err(CollabSessionError::Undo(_)));
            // Drop `result` here so its potential Ok-arm borrow
            // doesn't extend into the `s.end_undo_group()` call.
            drop(result);
            is_err
        };
        assert!(is_err, "scoped variant must also return Err on nested call");
        s.end_undo_group();
    }

    #[test]
    fn empty_undo_group_pushes_no_unit() {
        // Codex+Opus 5.4 V2 V1 audit LOW-1 closure: a group with
        // no appends between start and end must NOT push a phantom
        // undo unit onto the stack.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let baseline = s.undo_count();
        s.start_undo_group().unwrap();
        s.end_undo_group();
        assert_eq!(s.undo_count(), baseline, "empty group must not push a unit");
    }

    #[test]
    fn undo_group_appends_outside_group_remain_individual() {
        // Phase 5.4 V2 V1: appends BEFORE a group + appends INSIDE
        // a group + appends AFTER must produce 3 distinct undo
        // stack items.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();

        s.start_undo_group().unwrap();
        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        s.append_op(put_value(0, 0, 2, 3.0)).unwrap();
        s.end_undo_group();

        s.append_op(put_value(0, 0, 3, 4.0)).unwrap();

        assert_eq!(
            s.undo_count(),
            3,
            "before + grouped + after = 3 undo units (got {})",
            s.undo_count()
        );
    }

    #[test]
    fn end_undo_group_without_start_is_noop() {
        // Loro's group_end is infallible; calling it without a
        // matching start should be safe (acts as a no-op).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.end_undo_group(); // No panic.
        s.end_undo_group(); // Idempotent.
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        // Stray group_end didn't corrupt the stack.
        assert_eq!(s.undo_count(), 1);
    }

    #[test]
    fn set_undo_merge_interval_does_not_panic() {
        // Smoke test: setting the merge interval doesn't panic
        // and is callable in both directions (enable + disable).
        // Actual merge-interval behavior is Loro's responsibility;
        // we just expose the knob.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.set_undo_merge_interval(0); // Loro default — disabled.
        s.set_undo_merge_interval(500); // 500ms typing window.
        s.set_undo_merge_interval(0); // Back to disabled.
                                      // Op-log unaffected by interval changes.
        assert_eq!(s.op_count(), 0);
    }

    #[test]
    fn clear_undo_stack_resets_both_stacks() {
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        s.undo().unwrap();
        assert_eq!(s.undo_count(), 1);
        assert_eq!(s.redo_count(), 1);

        s.clear_undo_stack();
        assert_eq!(s.undo_count(), 0);
        assert_eq!(s.redo_count(), 0);
        assert!(!s.can_undo());
        assert!(!s.can_redo());
    }

    #[test]
    fn undo_invalidates_snapshot_cache() {
        // V3.3.0.X audit closure (HIGH-1, 2026-05-23, convergent
        // Codex + Opus): pre-closure `undo()` bypassed
        // `rebuild_snapshot_cache`, so `snapshot_cells` returned
        // the undone cell as if undo never fired.  Post-closure
        // both `undo` + `redo` rebuild the cache when consumed.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        assert_eq!(s.snapshot_cells(0).len(), 2,
            "pre-undo: cache has both cells");

        assert!(s.undo().unwrap());
        // V3.3.0.X HIGH-1 pin: cache MUST reflect the undo (the
        // most-recently-appended cell at (0, 1) is gone).
        let post_undo = s.snapshot_cells(0);
        assert_eq!(post_undo.len(), 1,
            "post-undo: cache reflects retraction; pre-closure this FAILED");
        // The remaining cell is the first one we appended.
        assert_eq!(post_undo[0].0, (0, 0));

        // Redo restores: cache rebuild on redo also.
        assert!(s.redo().unwrap());
        assert_eq!(s.snapshot_cells(0).len(), 2,
            "post-redo: cache reflects restoration");
    }

    #[test]
    fn force_clear_snapshot_cache_test_seam() {
        // V3.3.0.X audit closure (MEDIUM-5, 2026-05-23, Opus M5):
        // verify the `force_clear_snapshot_cache` test-only seam is
        // available + functionally clears the cache without
        // touching the op log.  Gated on `test-fixtures` feature
        // (this test runs under cargo test so cfg(test) gate
        // applies regardless of feature flag).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        assert_eq!(s.snapshot_cells(0).len(), 2);
        assert_eq!(s.op_log().iter().count(), 2);

        // Force the cache to empty without mutating the op log.
        s.force_clear_snapshot_cache();

        // Cache is now empty; op log is unchanged.
        assert_eq!(s.snapshot_cells(0).len(), 0);
        assert_eq!(s.op_log().iter().count(), 2,
            "op log untouched by force_clear_snapshot_cache");

        // Subsequent op mutation triggers rebuild + restores cache.
        s.append_op(put_value(0, 1, 0, 3.0)).unwrap();
        // append_op rebuilt nothing; it's the O(1) incremental path.
        // The cache now has ONLY the new cell (the prior cells are
        // gone because force_clear nuked them + append_op only
        // inserts the new one, not a full rebuild).  Subsequent
        // merge_bytes / discard_pending_ops / poll_remote_with_limit
        // would do a full rebuild; tests can leverage this seam to
        // verify undo-invalidation paths at V3.4.
        let post_force = s.snapshot_cells(0);
        assert_eq!(post_force.len(), 1);
        assert_eq!(post_force[0].0, (1, 0));
    }

    #[test]
    fn cell_state_formula_roundtrip() {
        // V3.4.0.2 (per V3.4.0.1 D1 hybrid): a cell can carry BOTH a
        // literal value AND a formula text simultaneously (e.g., the
        // user types =A1+1 and the engine caches the formula text in
        // addition to whatever last PutValue produced).  Pin that the
        // cache preserves both fields independently across the 3
        // cell-keyed op variants.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 5, 5, 1.0)).unwrap();
        s.append_op(put_formula(0, 5, 5, "=A1+1")).unwrap();

        let entries = s.snapshot_cells(0);
        assert_eq!(entries.len(), 1, "single cell with both value + formula");
        let ((row, col), state) = &entries[0];
        assert_eq!((*row, *col), (5, 5));
        assert_eq!(state.value, Some(CellWireValue::Number(1.0)),
            "PutValue's value preserved after PutFormula upsert");
        assert_eq!(state.formula, Some("=A1+1".to_string()),
            "PutFormula's text in cache");

        // Reverse order also works: PutFormula first, then PutValue.
        let mut s2 = CollabSession::new(PeerId::new(2)).unwrap();
        s2.append_op(put_formula(0, 5, 5, "=B1*2")).unwrap();
        s2.append_op(put_value(0, 5, 5, 42.0)).unwrap();
        let entries2 = s2.snapshot_cells(0);
        let ((_, _), state2) = &entries2[0];
        assert_eq!(state2.value, Some(CellWireValue::Number(42.0)));
        assert_eq!(state2.formula, Some("=B1*2".to_string()),
            "PutValue does NOT clobber formula (per-field LWW)");
    }

    #[test]
    fn cell_state_clear_formula_invariant() {
        // V3.4.0.2 (per V3.4.0.1 D1 hybrid): ClearFormula nulls the
        // formula field but PRESERVES the value field.  Mirrors the
        // Workbook::clear_formula semantic (cell becomes literal-only).
        // Also pin the ghost-entry-avoidance: ClearFormula on a
        // never-written cell does NOT create a cache entry, so
        // list_sheets_from_cache doesn't surface phantom sheets.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 99.0)).unwrap();
        s.append_op(put_formula(0, 0, 0, "=SUM(A1:A10)")).unwrap();
        s.append_op(clear_formula(0, 0, 0)).unwrap();

        let entries = s.snapshot_cells(0);
        assert_eq!(entries.len(), 1);
        let ((_, _), state) = &entries[0];
        assert_eq!(state.value, Some(CellWireValue::Number(99.0)),
            "ClearFormula preserves value");
        assert_eq!(state.formula, None,
            "ClearFormula nulls formula");

        // Ghost-entry-avoidance: ClearFormula on a never-set cell on
        // a different sheet should NOT create a cache entry +
        // therefore should NOT add that sheet to list_sheets_from_cache.
        let mut s2 = CollabSession::new(PeerId::new(2)).unwrap();
        assert_eq!(s2.list_sheets_from_cache(), Vec::<u16>::new());
        s2.append_op(clear_formula(7, 0, 0)).unwrap();
        assert_eq!(s2.list_sheets_from_cache(), Vec::<u16>::new(),
            "ClearFormula on never-written cell must not create ghost sheet entry");
        assert_eq!(s2.snapshot_cells(7).len(), 0,
            "cache has no entry for never-written cell");
    }

    #[test]
    fn cell_state_formula_only_clear_removes_cache_key() {
        // V3.4.0.X MEDIUM-1 closure (single-lane Codex, 2026-05-24):
        // ClearFormula on a formula-only cell (no PutValue) must REMOVE
        // the cache key entirely, NOT leave an empty CellState that
        // surfaces in list_sheets_from_cache.  Pre-closure the cache
        // retained `CellState { value: None, formula: None }` after
        // PutFormula -> ClearFormula on the same cell; the empty state
        // surfaced sheet 7 via list_sheets_from_cache even though replay
        // leaves no cell on sheet 7.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_formula(7, 0, 0, "=A1+1")).unwrap();
        // Sanity: pre-clear, sheet 7 surfaces.
        assert_eq!(s.list_sheets_from_cache(), vec![7]);
        assert_eq!(s.snapshot_cells(7).len(), 1);
        let pre = &s.snapshot_cells(7)[0].1;
        assert_eq!(pre.value, None);
        assert_eq!(pre.formula, Some("=A1+1".to_string()));

        // Clear the formula.  Post-clear, both fields are None ->
        // the cache key must be removed.
        s.append_op(clear_formula(7, 0, 0)).unwrap();
        assert_eq!(s.list_sheets_from_cache(), Vec::<u16>::new(),
            "formula-only clear removes the cache key + does not surface sheet 7");
        assert_eq!(s.snapshot_cells(7).len(), 0,
            "no cache entry for formula-only cleared cell");

        // Symmetric check on the rebuild_snapshot_cache path: an
        // import/merge-then-rebuild of the same op sequence must produce
        // the same empty cache.
        let bytes = s.export_bytes().unwrap();
        let s2 = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
        assert_eq!(s2.list_sheets_from_cache(), Vec::<u16>::new(),
            "from_snapshot rebuild also removes formula-only cleared key");
        assert_eq!(s2.snapshot_cells(7).len(), 0);

        // Edge case: PutValue + PutFormula + ClearFormula should NOT
        // remove the key because value is still set (existing test
        // pins this; re-asserting here for completeness against the new
        // remove-when-both-None branch).
        let mut s3 = CollabSession::new(PeerId::new(3)).unwrap();
        s3.append_op(put_value(7, 0, 0, 1.0)).unwrap();
        s3.append_op(put_formula(7, 0, 0, "=B1")).unwrap();
        s3.append_op(clear_formula(7, 0, 0)).unwrap();
        let state = &s3.snapshot_cells(7)[0].1;
        assert_eq!(state.value, Some(CellWireValue::Number(1.0)));
        assert_eq!(state.formula, None);
        assert!(!s3.snapshot_cells(7).is_empty(),
            "value-bearing cell survives formula clear");
    }

    #[test]
    fn cell_state_batch_commit_recurses_into_cache() {
        // V3.4.0.X HIGH-1 closure (single-lane Codex, 2026-05-24):
        // Op::BatchCommit { ops: [PutValue, ClearFormula] } is the
        // production op shape from WorkbookRuntime::set_value-over-formula
        // (atomic literal-replace).  Pre-closure the cache rebuild
        // skipped BatchCommit entirely; cells written via the runtime's
        // atomic path were ABSENT from the cache after from_snapshot,
        // even though rebuild_workbook saw them via replay_into's
        // recursion.
        //
        // Pin: a BatchCommit appended directly via append_op (live path)
        // AND walked via rebuild_snapshot_cache (full-walk path) both
        // surface the nested cell ops.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        // First populate the cell with a formula.
        s.append_op(put_formula(0, 5, 5, "=A1+1")).unwrap();
        // Then atomic BatchCommit: replace formula with literal.
        s.append_op(Op::BatchCommit {
            ops: vec![
                Op::PutValue {
                    sheet: 0,
                    row: 5,
                    col: 5,
                    value: CellWireValue::Number(42.0),
                },
                Op::ClearFormula {
                    sheet: 0,
                    row: 5,
                    col: 5,
                },
            ],
        }).unwrap();

        // Live append_op path: cache must reflect both inner ops.
        let entries_live = s.snapshot_cells(0);
        assert_eq!(entries_live.len(), 1, "single cell in cache");
        let state_live = &entries_live[0].1;
        assert_eq!(state_live.value, Some(CellWireValue::Number(42.0)),
            "BatchCommit's nested PutValue surfaces in live cache");
        assert_eq!(state_live.formula, None,
            "BatchCommit's nested ClearFormula clears formula in live cache");

        // Round-trip via from_snapshot to exercise rebuild_snapshot_cache.
        let bytes = s.export_bytes().unwrap();
        let s2 = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
        let entries_rebuilt = s2.snapshot_cells(0);
        assert_eq!(entries_rebuilt.len(), 1);
        let state_rebuilt = &entries_rebuilt[0].1;
        assert_eq!(state_rebuilt.value, Some(CellWireValue::Number(42.0)),
            "BatchCommit's nested PutValue surfaces in rebuilt cache");
        assert_eq!(state_rebuilt.formula, None,
            "BatchCommit's nested ClearFormula clears formula in rebuilt cache");
    }

    #[test]
    fn cell_state_undo_preserves_invariants_after_full_rebuild() {
        // V3.4.0.2 + V3.3.0.X HIGH-1 closure: undo triggers a full
        // rebuild_snapshot_cache.  The CellState upsert logic in
        // rebuild_snapshot_cache walks the post-undo op log fresh,
        // so the post-undo cache is exactly what walking from scratch
        // would produce.  Pin that:
        //   1. undo of a PutValue does NOT clobber an earlier formula.
        //   2. undo of a PutFormula does NOT clobber an earlier value.
        // The intermediate post-undo state should match what the
        // op-log walk produces (test does the walk-comparison
        // implicitly by checking expected values).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_formula(0, 1, 1, "=A1+1")).unwrap();
        s.append_op(put_value(0, 1, 1, 7.0)).unwrap();

        // Pre-undo: both fields populated.
        let pre = &s.snapshot_cells(0)[0].1;
        assert_eq!(pre.formula, Some("=A1+1".to_string()));
        assert_eq!(pre.value, Some(CellWireValue::Number(7.0)));

        // Undo the PutValue.  Loro retracts it; rebuild walks the
        // post-undo log; cache reflects ONLY the PutFormula now.
        assert!(s.undo().unwrap());
        let post = &s.snapshot_cells(0)[0].1;
        assert_eq!(post.formula, Some("=A1+1".to_string()),
            "undo of PutValue must not clobber prior PutFormula");
        assert_eq!(post.value, None,
            "undo of PutValue removes the value");
    }

    // ========================================================================
    // V3.5.0.5 (2026-05-24) -- CellState.format extension + Op::SetCellFormat
    // cache integration
    // ========================================================================

    #[test]
    fn set_cell_format_writes_state_format() {
        // V3.5.0.5 D1: cell-keyed Op::SetCellFormat updates state.format
        // via the live append_op path.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(set_cell_format_builtin(0, 0, 0, 2)).unwrap();
        let cells = s.snapshot_cells(0);
        assert_eq!(cells.len(), 1, "SetCellFormat creates a cache entry");
        let state = &cells[0].1;
        assert_eq!(state.format, Some(FormatId::Builtin(2)));
        assert_eq!(state.value, None, "no value set");
        assert_eq!(state.formula, None, "no formula set");
    }

    #[test]
    fn set_cell_format_preserves_value_and_formula_per_field_lww() {
        // V3.5.0.5 per-field LWW: SetCellFormat must NOT clobber
        // existing value or formula on the same cell.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 5, 5, 42.0)).unwrap();
        s.append_op(put_formula(0, 5, 5, "=A1+1")).unwrap();
        s.append_op(set_cell_format_builtin(0, 5, 5, 7)).unwrap();
        let state = &s.snapshot_cells(0)[0].1;
        assert_eq!(state.value, Some(CellWireValue::Number(42.0)),
            "PutValue preserved across SetCellFormat");
        assert_eq!(state.formula, Some("=A1+1".to_string()),
            "PutFormula preserved across SetCellFormat");
        assert_eq!(state.format, Some(FormatId::Builtin(7)));
    }

    #[test]
    fn put_value_after_set_cell_format_preserves_format() {
        // Reverse direction: SetCellFormat first, then PutValue must
        // preserve the format.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(set_cell_format_builtin(0, 0, 0, 3)).unwrap();
        s.append_op(put_value(0, 0, 0, 99.0)).unwrap();
        let state = &s.snapshot_cells(0)[0].1;
        assert_eq!(state.format, Some(FormatId::Builtin(3)),
            "PutValue must not clobber SetCellFormat");
        assert_eq!(state.value, Some(CellWireValue::Number(99.0)));
    }

    #[test]
    fn set_cell_format_lww_overwrites_previous_format() {
        // Per-cell LWW: two SetCellFormat ops on the same cell -- the
        // second wins (Loro causal-merge order; local appends are at
        // the frontier per the cache's local-append invariant).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(set_cell_format_builtin(0, 0, 0, 2)).unwrap();
        s.append_op(set_cell_format_builtin(0, 0, 0, 7)).unwrap();
        let state = &s.snapshot_cells(0)[0].1;
        assert_eq!(state.format, Some(FormatId::Builtin(7)),
            "second SetCellFormat wins for the cell");
    }

    #[test]
    fn clear_cell_format_clears_state_format() {
        // V3.5.0.5: SetCellFormat { id: None } clears the format
        // (W5-80 "clear overlay" semantic).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(set_cell_format_builtin(0, 0, 0, 5)).unwrap();
        assert_eq!(s.snapshot_cells(0)[0].1.format, Some(FormatId::Builtin(5)));
        s.append_op(clear_cell_format(0, 0, 0)).unwrap();
        let state = &s.snapshot_cells(0)[0].1;
        assert_eq!(state.format, None, "clear-format wipes state.format");
        assert_eq!(state.value, Some(CellWireValue::Number(1.0)),
            "clear-format preserves value");
    }

    #[test]
    fn format_only_clear_removes_cache_key() {
        // V3.5.0.5 ghost-entry-avoidance (extends V3.4.0.X MEDIUM-1
        // to format): SetCellFormat { id: Some(_) } -> clear leaves
        // (value, formula, format) all None -> entry removed.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(set_cell_format_builtin(7, 0, 0, 2)).unwrap();
        assert_eq!(s.list_sheets_from_cache(), vec![7]);
        s.append_op(clear_cell_format(7, 0, 0)).unwrap();
        assert_eq!(s.list_sheets_from_cache(), Vec::<u16>::new(),
            "format-only clear removes the cache key + does not surface sheet 7");
        assert_eq!(s.snapshot_cells(7).len(), 0);
    }

    #[test]
    fn clear_format_on_never_set_cell_is_noop() {
        // Mirrors the V3.4.0.X ClearFormula skip-if-absent behavior:
        // SetCellFormat { id: None } on a never-set cell must NOT
        // create a phantom cache entry.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(clear_cell_format(5, 0, 0)).unwrap();
        assert_eq!(s.list_sheets_from_cache(), Vec::<u16>::new(),
            "clear-format on never-set cell does not create a cache entry");
        assert_eq!(s.snapshot_cells(5).len(), 0);
    }

    #[test]
    fn cross_peer_set_cell_format_converges_via_merge_bytes() {
        // CRDT convergence: peer A sets format, peer B merges peer A's
        // snapshot and sees the format via rebuild_snapshot_cache.
        let mut s_a = CollabSession::new(PeerId::new(1)).unwrap();
        s_a.append_op(set_cell_format_builtin(0, 3, 4, 9)).unwrap();
        let bytes = s_a.export_bytes().unwrap();
        let s_b = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
        let state_b = &s_b.snapshot_cells(0)[0].1;
        assert_eq!(state_b.format, Some(FormatId::Builtin(9)),
            "peer B sees the format via rebuild_snapshot_cache");
    }

    #[test]
    fn rebuild_snapshot_cache_round_trip_preserves_format() {
        // Round-trip via export_bytes + from_snapshot rebuilds the
        // cache from scratch; format must survive.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(2, 1, 1, 11.0)).unwrap();
        s.append_op(set_cell_format_builtin(2, 1, 1, 4)).unwrap();
        s.append_op(put_formula(2, 1, 1, "=B2")).unwrap();
        let bytes = s.export_bytes().unwrap();
        let s2 = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
        let state = &s2.snapshot_cells(2)[0].1;
        assert_eq!(state.value, Some(CellWireValue::Number(11.0)));
        assert_eq!(state.formula, Some("=B2".to_string()));
        assert_eq!(state.format, Some(FormatId::Builtin(4)),
            "format round-trips through rebuild_snapshot_cache");
    }

    #[test]
    fn batch_commit_with_set_cell_format_recurses_into_cache() {
        // V3.4.0.X HIGH-1 carry: BatchCommit nesting works for the new
        // SetCellFormat variant via collect_cache_effects recursion.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::BatchCommit {
            ops: vec![
                put_value(0, 0, 0, 5.0),
                set_cell_format_builtin(0, 0, 0, 2),
            ],
        }).unwrap();
        let state = &s.snapshot_cells(0)[0].1;
        assert_eq!(state.value, Some(CellWireValue::Number(5.0)),
            "BatchCommit nested PutValue surfaces");
        assert_eq!(state.format, Some(FormatId::Builtin(2)),
            "BatchCommit nested SetCellFormat surfaces (recursion works for new variant)");
    }

    #[test]
    fn set_cell_format_custom_variant_via_cache() {
        // FormatId::Custom(PeerId, u32) round-trip: the wire form
        // FormatIdWire::Custom { peer, counter } converts losslessly
        // via to_storage().
        let custom_wire = ql_oplog::wire::FormatIdWire::Custom {
            peer: PeerId::new(42),
            counter: 100,
        };
        let op = Op::SetCellFormat {
            sheet: 0,
            row: 0,
            col: 0,
            id: Some(custom_wire),
        };
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(op).unwrap();
        let state = &s.snapshot_cells(0)[0].1;
        assert_eq!(state.format, Some(FormatId::Custom(PeerId::new(42), 100)),
            "Custom(PeerId, u32) round-trips through cache via to_storage");
    }

    #[test]
    fn undo_preserves_format_lww_after_full_rebuild() {
        // V3.4.0.X HIGH-1 carry: undo triggers a full rebuild_snapshot_cache.
        // For V3.5.0.5, this also exercises the new SetCellFormat handler
        // in the rebuild path (not just append_op).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(set_cell_format_builtin(0, 0, 0, 2)).unwrap();
        s.append_op(put_value(0, 0, 0, 99.0)).unwrap();
        let state_pre = &s.snapshot_cells(0)[0].1;
        assert_eq!(state_pre.value, Some(CellWireValue::Number(99.0)));
        assert_eq!(state_pre.format, Some(FormatId::Builtin(2)));

        // Undo last PutValue.  Rebuild walks the post-undo log:
        // PutValue(1.0) + SetCellFormat(2).  Cache must reflect both.
        assert!(s.undo().unwrap());
        let state_post = &s.snapshot_cells(0)[0].1;
        assert_eq!(state_post.value, Some(CellWireValue::Number(1.0)),
            "undo of last PutValue reveals the prior PutValue");
        assert_eq!(state_post.format, Some(FormatId::Builtin(2)),
            "format survives the rebuild via SetCellFormat replay");
    }

    #[test]
    fn put_value_on_tombstoned_sheet_is_silently_dropped() {
        // V3.5.0.X audit-closure discovery (2026-05-24): the V3.5.0.3b
        // engine tombstone guard (replay.rs:415-417) silent-drops writes
        // at REPLAY time but the live cache walker (apply_cache_effect)
        // has no tombstone awareness.  Without a fix, PutValue to a
        // tombstoned sheet writes a phantom entry into last_snapshot.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::RemoveSheet { id: 0 }).unwrap();
        let r = s.append_op(put_value(0, 0, 0, 1.0));
        assert!(r.is_ok(),
            "PutValue on tombstoned sheet must NOT error (silent drop)");
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "tombstoned sheet must not surface any cached cells after PutValue");
        assert!(!s.list_sheets_from_cache().contains(&0),
            "list_sheets_from_cache must NOT include the tombstoned sheet");
    }

    #[test]
    fn set_cell_format_on_tombstoned_sheet_is_silently_dropped() {
        // V3.5.0.X audit-closure Opus-H1 (2026-05-24): SetCellFormat to
        // a tombstoned sheet must be a silent no-op, mirroring the
        // V3.5.0.3b tombstone guards on PutValue/PutFormula/ClearFormula.
        // Pre-closure, the SetCellFormat handler wrote to format_overlay
        // unconditionally -> phantom cache entry surfacing in
        // list_sheets_from_cache for the tombstoned sheet.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        // Need a format registered for the SetCellFormat to be considered
        // valid (otherwise replay errors before reaching the tombstone
        // guard).  Built-in id 2 is registered by default.
        // Tombstone sheet 0 first.
        s.append_op(Op::RemoveSheet { id: 0 }).unwrap();
        // Now SetCellFormat on the tombstoned sheet: must be silent no-op.
        let r = s.append_op(set_cell_format_builtin(0, 0, 0, 2));
        assert!(r.is_ok(),
            "SetCellFormat on tombstoned sheet must NOT error (silent drop)");
        // The cache must not contain a phantom entry for the tombstoned sheet.
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "tombstoned sheet must not surface any cached cells after SetCellFormat");
        assert!(!s.list_sheets_from_cache().contains(&0),
            "list_sheets_from_cache must NOT include the tombstoned sheet \
             (no phantom entry from format_overlay)");
    }

    #[test]
    fn set_cell_format_clear_on_tombstoned_sheet_is_silently_dropped() {
        // Same as above but for the `id: None` (clear-overlay) variant.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::RemoveSheet { id: 0 }).unwrap();
        let r = s.append_op(clear_cell_format(0, 0, 0));
        assert!(r.is_ok(),
            "SetCellFormat(None) on tombstoned sheet must NOT error");
        assert_eq!(s.snapshot_cells(0).len(), 0);
        assert!(!s.list_sheets_from_cache().contains(&0));
    }

    #[test]
    fn put_formula_on_tombstoned_sheet_is_silently_dropped() {
        // V3.5.0.X follow-up audit CLOSURE-CODEX-LOW-3: extend
        // tombstone-guard coverage to PutFormula.  Pre-Opus-H1-widening
        // a PutFormula op on a tombstoned sheet would have written a
        // phantom entry to the cache.  Post-widening the cache walker
        // tombstone tracker silent-drops cell-keyed effects on
        // tombstoned sheets for ALL four cell-keyed variants.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::RemoveSheet { id: 0 }).unwrap();
        let r = s.append_op(put_formula(0, 0, 0, "=A1+1"));
        assert!(r.is_ok(),
            "PutFormula on tombstoned sheet must NOT error (silent drop)");
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "tombstoned sheet must not surface any cached cells after PutFormula");
        assert!(!s.list_sheets_from_cache().contains(&0),
            "list_sheets_from_cache must NOT include the tombstoned sheet");
    }

    #[test]
    fn clear_formula_on_tombstoned_sheet_is_silently_dropped() {
        // V3.5.0.X follow-up audit CLOSURE-CODEX-LOW-3: extend
        // tombstone-guard coverage to ClearFormula.  Even though
        // ClearFormula is itself a no-op-if-absent, the cache walker
        // should still treat it as silent-dropped on a tombstoned
        // sheet (don't create a phantom entry just to clear it).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::RemoveSheet { id: 0 }).unwrap();
        let r = s.append_op(clear_formula(0, 0, 0));
        assert!(r.is_ok(),
            "ClearFormula on tombstoned sheet must NOT error (silent drop)");
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "tombstoned sheet must not surface any cached cells after ClearFormula");
        assert!(!s.list_sheets_from_cache().contains(&0));
    }

    #[test]
    fn valid_add_remove_sheet_then_cell_op_silent_dropped() {
        // V3.5.0.X follow-up audit CLOSURE-CODEX-LOW-3: cover the
        // VALID sequence (the prior three tests use out-of-range
        // RemoveSheet which is the contrived scenario flagged by
        // CLOSURE-CODEX-MED-1 -- known divergence).  This test uses
        // the canonical sequence: AddSheet creates the sheet at id 0,
        // RemoveSheet tombstones it, then a cell-keyed op on the
        // tombstoned sheet is silent-dropped by both engine apply_op
        // AND the cache walker.  Validates parity for the production
        // path that V3.5.0.4a's deleteSheet napi exercises.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::AddSheet {
            name: "ToDelete".to_string(),
            chunk_rows: 100,
        }).unwrap();
        // Pre-tombstone PutValue surfaces normally.
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        assert_eq!(s.snapshot_cells(0).len(), 1);
        // RemoveSheet tombstones the sheet.  Existing cache entries
        // for sheet 0 are DROPPED via apply_cache_effect's retain.
        s.append_op(Op::RemoveSheet { id: 0 }).unwrap();
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "post-RemoveSheet: existing entries dropped from cache");
        assert!(!s.list_sheets_from_cache().contains(&0));
        // Post-tombstone cell-keyed ops are silent-dropped.
        for op in [
            put_value(0, 1, 0, 2.0),
            put_formula(0, 2, 0, "=A1+B1"),
            clear_formula(0, 3, 0),
            set_cell_format_builtin(0, 4, 0, 2),
        ] {
            assert!(s.append_op(op).is_ok());
        }
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "all 4 cell-keyed ops post-tombstone silent-dropped");
        assert!(!s.list_sheets_from_cache().contains(&0));
    }

    #[test]
    fn redo_after_remote_interleave_uses_partial_invalidate_correctly() {
        // **V3.6.0.2 D1 (2026-05-24)** -- REWRITE of V3.5.0.X
        // `redo_after_remote_interleave_falls_back_to_full_rebuild`.
        //
        // V3.5.0.X conservative gate: when a remote op interleaved
        // between undo and redo, `pure_local_frontier = false` forced
        // a full `rebuild_snapshot_cache` on redo.  V3.6.0.2 replaces
        // that with Loro's `top_redo_meta()` API which returns the
        // EXACT cells of the to-be-pushed op (set via on_push at the
        // original local append, preserved on the redo stack across
        // the remote merge).  Partial-invalidate now FIRES correctly.
        //
        // This rewritten test verifies the post-V3.6.0.2 behavior:
        // (1) the post-redo cache matches a forced full rebuild
        //     (correctness pin -- both paths must converge);
        // (2) the dispatch ran the PARTIAL path, not the full
        //     rebuild path (verified indirectly via the captured
        //     cells from top_redo_meta).
        let mut s_a = CollabSession::new(PeerId::new(1)).unwrap();
        s_a.append_op(Op::AddSheet {
            name: "S".to_string(),
            chunk_rows: 100,
        }).unwrap();
        let base_bytes = s_a.export_bytes().unwrap();

        // Peer A: append local PutValue.
        s_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
        // Peer A: undo the PutValue (fully local; partial-invalidate fires).
        assert!(s_a.undo().unwrap());

        // Peer B: appends a remote PutValue.
        let mut s_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
        s_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
        let b_bytes = s_b.export_bytes().unwrap();

        // Peer A: merges B's bytes.  Post-V3.6.0.2 the redo stack's
        // meta is UNAFFECTED by the merge (the meta is stack-local
        // to Peer A's UndoManager; remote merges only touch the
        // Loro doc state, not the undo/redo stacks' UndoItemMeta).
        s_a.merge_bytes(&b_bytes).unwrap();

        // V3.6.0.2 invariant pin: top_redo_meta() returns the cells
        // of the to-be-redone op (Peer A's PutValue at (0, 0, 0)),
        // NOT Peer B's remote op.  This is the property that lets
        // partial-invalidate fire correctly.
        let top_meta = s_a.undo.top_redo_meta()
            .expect("redo stack has one item (Peer A's undone PutValue)");
        let cells = decode_cells_from_loro_value(&top_meta.value)
            .expect("redo-stack meta encodes the cells correctly");
        assert_eq!(cells, vec![(0u16, 0u32, 0u32)],
            "V3.6.0.2 invariant: top_redo_meta returns the exact cells \
             of the to-be-redone op (A's PutValue at (0,0,0)), regardless \
             of remote-interleave -- this is what lets partial-invalidate \
             fire correctly post-V3.6.0.2");

        // Peer A: redo the undone PutValue.  Partial-invalidate
        // path fires (NOT full rebuild).
        let consumed = s_a.redo().unwrap();
        assert!(consumed, "redo must consume A's undone PutValue");

        // Compare the post-redo cache to a forced full rebuild on the
        // same log (the correctness equivalence pin -- partial path
        // must converge to the same cache as full rebuild).
        let cache_dispatch = capture_full_cache(&s_a);
        s_a.force_clear_snapshot_cache();
        s_a.rebuild_snapshot_cache().unwrap();
        let cache_full_rebuild = capture_full_cache(&s_a);
        assert_eq!(cache_dispatch, cache_full_rebuild,
            "V3.6.0.2 correctness: partial-invalidate redo after remote \
             interleave produces the same cache as a forced full rebuild \
             (proving that on_push meta captured the right cells)");
    }

    #[test]
    fn rebuilt_workbook_carries_repaired_formula_but_cache_does_not() {
        // V3.5.0.X audit-closure A-HIGH-2 (2026-05-24): workbook_snapshot
        // napi PRE-CLOSURE serialized formula text from `last_snapshot`
        // (the cache), which does NOT carry the rename-repair effect.
        // The rebuilt+repaired Workbook DOES.  Post-closure the napi
        // reads from the Workbook (via formula_at) so the repaired text
        // surfaces to IDE consumers.  This Rust test pins the divergence:
        // it proves that pre-closure the napi was reading from the wrong
        // source.  The actual napi binding edit is a 3-line change at
        // lib.rs:1580 (`repaired_formula.or(state.formula)`); code-review
        // verifies that side; this test proves the underlying mechanism
        // (rebuild_workbook produces the repaired form, cache does not).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(Op::AddSheet {
            name: "S".to_string(),
            chunk_rows: 100,
        }).unwrap();
        // Write a formula referencing sheet "S".
        s.append_op(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_string(),
        }).unwrap();
        // Rename sheet 0 from "S" to "Renamed".  Phase 5.3 repair pass
        // rewrites the formula at (0, 1, 0) to "Renamed!A1".
        s.append_op(Op::RenameSheet {
            id: 0,
            old_name: "S".to_string(),
            new_name: "Renamed".to_string(),
        }).unwrap();

        // Cache surfaces the STALE formula text (no repair).
        let stale = s.snapshot_cells(0)
            .into_iter()
            .find(|((r, c), _)| *r == 1 && *c == 0)
            .map(|(_, st)| st.formula);
        assert_eq!(stale, Some(Some("S!A1".to_string())),
            "pre-closure: cache carries the UNREPAIRED formula text");

        // Rebuilt workbook carries the REPAIRED formula text.
        let reg = ql_functions::default_registry();
        let (wb, report) = s.rebuild_workbook(&reg).unwrap();
        assert_eq!(report.sheet_repair.formulas_rewritten, 1,
            "repair pass rewrites the formula referencing the renamed sheet");
        let repaired = wb.formula_at(0, 1, 0).map(|s| s.to_string());
        assert_eq!(repaired, Some("Renamed!A1".to_string()),
            "post-closure: workbook_snapshot reads from this (via formula_at) \
             so IDE consumers see the repaired text");

        // Sanity: the cache and the workbook DIVERGE.  This is the
        // motivation for the A-HIGH-2 closure -- workbook_snapshot must
        // read from the workbook side, not the cache side.
        assert_ne!(stale.flatten(), repaired,
            "cache and workbook formula text diverge after rename; \
             workbook_snapshot must prefer the workbook form");
    }

    #[test]
    fn undo_after_remote_interleave_uses_partial_invalidate_correctly() {
        // **V3.6.0.2 D1 (2026-05-24)** -- REWRITE of V3.5.0.X
        // `undo_after_remote_interleave_falls_back_to_full_rebuild`.
        //
        // V3.5.0.X CONVERGENT HIGH (Codex A-HIGH-1 / Opus H2): the
        // V3.5.0.6 dispatch used `self.log.iter().last()` as a proxy
        // for the to-be-retracted op; that proxy returns the REMOTE
        // op (PutValue at (0,1,0)) when remote ops trail the local
        // op in causal iteration order.  Partial-invalidate would
        // target the WRONG cell, leaving (0,0,0) stale.  V3.5.0.X
        // shipped a conservative `pure_local_frontier` gate that
        // FORCED full rebuild after any remote merge -- correct but
        // partial-invalidate was bypassed in the collab case.
        //
        // V3.6.0.2 D1: replaces the proxy + the gate with Loro's
        // `top_undo_meta()` API.  The undo stack's top item carries
        // a `UndoItemMeta::value` set by `on_push` at the original
        // local append, with the EXACT cells of A's op encoded.
        // Remote merges DO NOT touch the undo stack's per-item meta
        // (the stack is local to each peer's UndoManager).  So
        // top_undo_meta() returns A's cell, partial-invalidate
        // fires correctly, no full rebuild needed.
        //
        // This rewritten test verifies that:
        // (1) The top_undo_meta() returns A's cell (NOT B's),
        //     proving the proxy is gone.
        // (2) The post-undo cache matches a forced full rebuild,
        //     proving partial-invalidate converges to the correct
        //     state (same correctness equivalence pin as V3.5.0.X).
        // (3) (0,0,0) is correctly absent (A's op was undone);
        //     (0,1,0) is present (B's op is still in the log).
        let mut s_a = CollabSession::new(PeerId::new(1)).unwrap();
        // Both peers need the same base sheet to write into.
        s_a.append_op(Op::AddSheet {
            name: "S".to_string(),
            chunk_rows: 100,
        }).unwrap();
        let base_bytes = s_a.export_bytes().unwrap();

        // Peer A appends a local PutValue at (0,0,0).
        s_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();

        // Peer B (constructed from the shared base) appends PutValue at (0,1,0).
        let mut s_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
        s_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
        let b_bytes = s_b.export_bytes().unwrap();

        // Peer A merges B's bytes.  Post-V3.6.0.2: this does NOT
        // affect the undo-stack meta (which still has A's cell
        // encoded from the original on_push at append).
        s_a.merge_bytes(&b_bytes).unwrap();

        // V3.6.0.2 invariant pin: top_undo_meta returns A's cell
        // (0, 0, 0), NOT B's (0, 1, 0).  This is the property that
        // makes partial-invalidate correct under remote-interleave.
        let top_meta = s_a.undo.top_undo_meta()
            .expect("undo stack has one item (A's PutValue)");
        let cells = decode_cells_from_loro_value(&top_meta.value)
            .expect("undo-stack meta encodes cells correctly");
        assert_eq!(cells, vec![(0u16, 0u32, 0u32)],
            "V3.6.0.2 invariant: top_undo_meta returns A's PutValue cell \
             (0,0,0), NOT B's remote op cell (0,1,0).  This is the \
             property that lets partial-invalidate fire correctly post-\
             V3.6.0.2 (the proxy `self.log.iter().last()` returned B's \
             cell pre-closure -- the Codex A-HIGH-1 native-binding repro).");

        // Peer A undoes its local op.  Partial-invalidate runs (NOT
        // full rebuild) -- the on_pop / top_undo_meta path gives the
        // exact cells.
        let consumed = s_a.undo().unwrap();
        assert!(consumed, "undo must consume A's PutValue");

        // The post-undo cache must equal what a forced full rebuild
        // would produce on the SAME post-undo log -- proving that
        // partial-invalidate converges to the correct state.
        let cache_dispatch = capture_full_cache(&s_a);
        s_a.force_clear_snapshot_cache();
        s_a.rebuild_snapshot_cache().unwrap();
        let cache_full_rebuild = capture_full_cache(&s_a);
        assert_eq!(cache_dispatch, cache_full_rebuild,
            "V3.6.0.2 correctness: partial-invalidate undo after remote \
             interleave produces the same cache as a forced full rebuild \
             (proving that on_push meta captured the right cells)");

        // Sanity: (0,1,0) (B's cell) is present; (0,0,0) (A's cell, undone)
        // is absent.  This is what the full-rebuild path produces; if the
        // partial-invalidate path had run (pre-closure), (0,0,0) would
        // be incorrectly present.
        let entries: Vec<_> = s_a.snapshot_cells(0).into_iter().collect();
        assert!(
            entries.iter().any(|((r, c), _)| *r == 1 && *c == 0),
            "B's cell (0,1,0) must be present"
        );
        assert!(
            entries.iter().all(|((r, c), _)| !(*r == 0 && *c == 0)),
            "A's undone cell (0,0,0) must be absent"
        );
    }

    // ========================================================================
    // V3.5.0.6 (2026-05-24) -- partial-invalidate undo (D2)
    // ========================================================================

    /// V3.5.0.6 test helper: capture the current `last_snapshot` cache
    /// via `snapshot_cells` for every sheet that surfaces.  Returns a
    /// HashMap mirroring the cache contents so tests can compare two
    /// post-undo states for equality (partial vs full-rebuild).
    fn capture_full_cache(s: &CollabSession) -> HashMap<(u16, u32, u32), CellState> {
        let mut out: HashMap<(u16, u32, u32), CellState> = HashMap::new();
        for sheet in s.list_sheets_from_cache() {
            for ((row, col), state) in s.snapshot_cells(sheet) {
                out.insert((sheet, row, col), state);
            }
        }
        out
    }

    /// V3.5.0.6 helper: run undo with the current dispatch (partial-or-
    /// full per the production logic), capture the resulting cache.
    fn undo_and_capture(s: &mut CollabSession) -> HashMap<(u16, u32, u32), CellState> {
        assert!(s.undo().unwrap(), "undo must consume a stack item");
        capture_full_cache(s)
    }

    /// V3.5.0.6 helper: undo via the production dispatch, then FORCE a
    /// full cache rebuild via the test-fixture seam
    /// (`force_clear_snapshot_cache` + `rebuild_snapshot_cache`), then
    /// capture.  Used by side-by-side tests to compare the dispatch's
    /// post-undo cache against the full-rebuild ground truth on the
    /// IDENTICAL post-undo op log.
    ///
    /// The full-rebuild call AFTER the undo guarantees that whatever
    /// the dispatch chose (partial or full path), the capture reflects
    /// what `rebuild_snapshot_cache` would produce.  Equality between
    /// this and `undo_and_capture` on a mirror session proves the
    /// dispatch's partial path matches the full-rebuild ground truth.
    fn undo_then_force_full_rebuild_and_capture(s: &mut CollabSession) -> HashMap<(u16, u32, u32), CellState> {
        assert!(s.undo().unwrap(), "undo must consume a stack item");
        s.force_clear_snapshot_cache();
        s.rebuild_snapshot_cache().unwrap();
        capture_full_cache(s)
    }

    #[test]
    fn invalidate_cell_matches_full_rebuild_for_single_put_value() {
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
        s.append_op(put_value(0, 1, 0, 7.0)).unwrap();
        // Sanity: both cells present.
        assert_eq!(s.snapshot_cells(0).len(), 2);
        // Capture full-rebuild baseline.
        let baseline = capture_full_cache(&s);
        // Drop cell (0, 0, 0) from cache + re-derive via invalidate_cell.
        s.invalidate_cell(0, 0, 0).unwrap();
        let partial = capture_full_cache(&s);
        assert_eq!(partial, baseline,
            "invalidate_cell re-derives the exact CellState the full rebuild produces");
    }

    #[test]
    fn invalidate_cell_preserves_unrelated_cells_byte_identical() {
        // V3.5.0.6 key property: invalidate_cell touches ONLY the named
        // (sheet, row, col) entry; other entries in last_snapshot stay
        // structurally identical (HashMap entry not replaced).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s.append_op(put_value(0, 2, 0, 3.0)).unwrap();
        // Read out the unrelated cells' states.
        let unrelated_before: Vec<((u32, u32), CellState)> = s.snapshot_cells(0)
            .into_iter()
            .filter(|((row, col), _)| !(*row == 0 && *col == 0))
            .collect();
        s.invalidate_cell(0, 0, 0).unwrap();
        let unrelated_after: Vec<((u32, u32), CellState)> = s.snapshot_cells(0)
            .into_iter()
            .filter(|((row, col), _)| !(*row == 0 && *col == 0))
            .collect();
        assert_eq!(unrelated_after, unrelated_before,
            "invalidate_cell on (0,0,0) must not touch other cells");
    }

    #[test]
    fn invalidate_cell_ghost_entry_removal_after_full_clear() {
        // V3.5.0.6 ghost-entry-avoidance: a cell with all fields None
        // after the walk must be REMOVED from cache (not left as empty
        // CellState).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        // Setup: append a PutFormula then a ClearFormula on the same cell.
        // After the walk, value=None, formula=None, format=None.
        // V3.4.0.X MEDIUM-1 ghost-entry-avoidance applies via the cache
        // walker, so the cell should be removed at apply time.
        s.append_op(put_formula(0, 0, 0, "=A1+1")).unwrap();
        s.append_op(clear_formula(0, 0, 0)).unwrap();
        // The live append_op path already removed the entry; verify.
        assert_eq!(s.snapshot_cells(0).len(), 0);
        // Now exercise invalidate_cell on the same coord -- should also
        // result in no entry.
        s.invalidate_cell(0, 0, 0).unwrap();
        assert_eq!(s.snapshot_cells(0).len(), 0,
            "invalidate_cell of formula-only-then-clear leaves no ghost entry");
    }

    #[test]
    fn undo_partial_invalidate_matches_full_rebuild_put_value() {
        // V3.5.0.6 side-by-side ground-truth pin: undo via partial-
        // invalidate dispatch + undo via forced full-rebuild produce
        // IDENTICAL caches for cell-keyed retraction.
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_partial.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s_partial.append_op(put_value(0, 0, 1, 99.0)).unwrap();
        // Mirror session for the full-rebuild comparison.
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_full.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s_full.append_op(put_value(0, 0, 1, 99.0)).unwrap();

        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo via partial-invalidate dispatch produces same cache as full rebuild");
    }

    #[test]
    fn undo_partial_invalidate_matches_full_rebuild_put_formula() {
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 10.0)).unwrap();
        s_partial.append_op(put_formula(0, 0, 0, "=B1")).unwrap();
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 0, 0, 10.0)).unwrap();
        s_full.append_op(put_formula(0, 0, 0, "=B1")).unwrap();

        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo of PutFormula: partial == full");
    }

    #[test]
    fn undo_partial_invalidate_matches_full_rebuild_clear_formula() {
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 10.0)).unwrap();
        s_partial.append_op(put_formula(0, 0, 0, "=B1")).unwrap();
        s_partial.append_op(clear_formula(0, 0, 0)).unwrap();
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 0, 0, 10.0)).unwrap();
        s_full.append_op(put_formula(0, 0, 0, "=B1")).unwrap();
        s_full.append_op(clear_formula(0, 0, 0)).unwrap();

        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo of ClearFormula: partial == full");
    }

    #[test]
    fn undo_partial_invalidate_matches_full_rebuild_set_cell_format() {
        // V3.5.0.5 new variant integrated with V3.5.0.6 partial-invalidate.
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 5.0)).unwrap();
        s_partial.append_op(set_cell_format_builtin(0, 0, 0, 2)).unwrap();
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 0, 0, 5.0)).unwrap();
        s_full.append_op(set_cell_format_builtin(0, 0, 0, 2)).unwrap();

        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo of SetCellFormat: partial == full (V3.5.0.5 + V3.5.0.6 integration)");
    }

    #[test]
    fn undo_falls_back_to_full_rebuild_for_non_cell_keyed_op() {
        // V3.5.0.6 fallback path: undo retracting a non-cell-keyed op
        // (here Op::AddSheet) takes the full rebuild branch, NOT
        // partial.  We can't directly observe "which branch ran" but
        // we can verify the cache is correct + the side-by-side equality
        // still holds (defensive).
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(Op::AddSheet { name: "S1".to_string(), chunk_rows: 100 }).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_partial.append_op(Op::AddSheet { name: "S2".to_string(), chunk_rows: 100 }).unwrap();
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(Op::AddSheet { name: "S1".to_string(), chunk_rows: 100 }).unwrap();
        s_full.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_full.append_op(Op::AddSheet { name: "S2".to_string(), chunk_rows: 100 }).unwrap();

        // Undo retracts the last AddSheet (non-cell-keyed -> full rebuild path).
        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo of AddSheet: full-rebuild dispatch produces same cache");
        // Sanity: the put_value cell still exists.
        let entries = s_partial.snapshot_cells(0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].1.value, Some(CellWireValue::Number(1.0)));
    }

    #[test]
    fn undo_batch_commit_cell_keyed_uses_partial_invalidate() {
        // V3.5.0.6: BatchCommit of only-cell-keyed inner ops -> partial path.
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 5, 5, 10.0)).unwrap();
        s_partial.append_op(Op::BatchCommit {
            ops: vec![
                put_value(0, 5, 5, 20.0),
                set_cell_format_builtin(0, 5, 5, 3),
            ],
        }).unwrap();
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 5, 5, 10.0)).unwrap();
        s_full.append_op(Op::BatchCommit {
            ops: vec![
                put_value(0, 5, 5, 20.0),
                set_cell_format_builtin(0, 5, 5, 3),
            ],
        }).unwrap();

        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo of BatchCommit (all cell-keyed): partial == full");
        // Sanity: the prior PutValue(10.0) is now what cell (5,5) shows
        // after the batch was undone.
        let state = &s_partial.snapshot_cells(0)[0].1;
        assert_eq!(state.value, Some(CellWireValue::Number(10.0)));
        assert_eq!(state.format, None, "format from batch is gone");
    }

    #[test]
    fn redo_partial_invalidate_matches_full_rebuild() {
        // V3.5.0.6: redo dispatch mirrors undo.
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_partial.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s_partial.undo().unwrap();
        // Now redo:
        assert!(s_partial.redo().unwrap());
        let cache_partial = capture_full_cache(&s_partial);

        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_full.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s_full.undo().unwrap();
        assert!(s_full.redo().unwrap());
        // Force a full rebuild AFTER the redo (NOT another undo) so the
        // capture reflects rebuild_snapshot_cache's ground truth.
        s_full.force_clear_snapshot_cache();
        s_full.rebuild_snapshot_cache().unwrap();
        let cache_full = capture_full_cache(&s_full);
        assert_eq!(cache_partial, cache_full,
            "redo via partial-invalidate dispatch produces same cache as full rebuild");
    }

    #[test]
    fn undo_partial_invalidate_via_multiple_cells_in_batch() {
        // V3.5.0.6: BatchCommit touching MULTIPLE distinct cells.  Each
        // unique cell coord gets one invalidate_cell call.
        let mut s_partial = CollabSession::new(PeerId::new(1)).unwrap();
        s_partial.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_partial.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s_partial.append_op(Op::BatchCommit {
            ops: vec![
                put_value(0, 0, 0, 100.0),
                put_value(0, 1, 0, 200.0),
                put_value(0, 2, 0, 300.0),
            ],
        }).unwrap();
        let mut s_full = CollabSession::new(PeerId::new(1)).unwrap();
        s_full.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s_full.append_op(put_value(0, 1, 0, 2.0)).unwrap();
        s_full.append_op(Op::BatchCommit {
            ops: vec![
                put_value(0, 0, 0, 100.0),
                put_value(0, 1, 0, 200.0),
                put_value(0, 2, 0, 300.0),
            ],
        }).unwrap();

        let cache_partial = undo_and_capture(&mut s_partial);
        let cache_full = undo_then_force_full_rebuild_and_capture(&mut s_full);
        assert_eq!(cache_partial, cache_full,
            "undo of multi-cell BatchCommit: partial == full");
    }

    #[test]
    fn affected_cells_helper_returns_none_for_non_cell_keyed() {
        // Direct unit test for the dispatcher's classification helper.
        let add_sheet = Op::AddSheet { name: "S".to_string(), chunk_rows: 100 };
        assert!(CollabSession::affected_cells_for_partial_invalidate(&add_sheet).is_none(),
            "AddSheet -> None (forces full rebuild)");
        let rename_sheet = Op::RenameSheet {
            id: 0, old_name: "A".to_string(), new_name: "B".to_string(),
        };
        assert!(CollabSession::affected_cells_for_partial_invalidate(&rename_sheet).is_none(),
            "RenameSheet -> None");
        let mixed_batch = Op::BatchCommit {
            ops: vec![
                put_value(0, 0, 0, 1.0),
                Op::AddSheet { name: "S".to_string(), chunk_rows: 100 },
            ],
        };
        assert!(CollabSession::affected_cells_for_partial_invalidate(&mixed_batch).is_none(),
            "BatchCommit with non-cell-keyed inner -> None (conservative)");
    }

    #[test]
    fn affected_cells_helper_returns_dedup_sorted_for_cell_keyed() {
        let batch = Op::BatchCommit {
            ops: vec![
                put_value(0, 5, 5, 1.0),
                put_value(0, 1, 1, 2.0),
                put_formula(0, 5, 5, "=A1"),  // duplicate cell coord
                set_cell_format_builtin(0, 5, 5, 2),  // duplicate again
            ],
        };
        let cells = CollabSession::affected_cells_for_partial_invalidate(&batch).unwrap();
        assert_eq!(cells, vec![(0, 1, 1), (0, 5, 5)],
            "deduplicated + sorted");
    }

    #[test]
    fn undo_retracts_visible_op_from_op_log_len() {
        // Codex 5.4 V1 audit HIGH closure: after undo, the visible
        // `"ops"` LoroList shrinks (Loro retracts the original op).
        // Pre-closure `OpLog::cached_len` was stale; post-closure
        // `len()` queries Loro directly so it tracks correctly.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        assert_eq!(s.op_count(), 2);
        assert_eq!(s.op_log().iter().count(), 2);

        assert!(s.undo().unwrap());
        // op_count + iter().count() must agree post-undo.
        assert_eq!(s.op_log().iter().count(), s.op_count());
        assert_eq!(s.op_count(), 1, "visible op count must shrink to 1");

        // Redo restores.
        assert!(s.redo().unwrap());
        assert_eq!(s.op_log().iter().count(), s.op_count());
        assert_eq!(s.op_count(), 2);
    }

    #[test]
    fn reborn_session_has_empty_undo_stack() {
        // Codex 5.4 V1 audit C3 closure: imported ops are NOT
        // undoable by the reborn peer (Loro local-only undo
        // semantics — `loro-internal::undo:615-643` composes
        // imported events into `remote_event` rather than pushing
        // them onto the undo stack).
        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        origin.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        assert!(origin.can_undo());
        let bytes = origin.export_bytes().unwrap();

        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
        assert_eq!(
            reborn.undo_count(),
            0,
            "reborn session must NOT inherit origin's undo stack"
        );
        assert!(!reborn.can_undo());
        // But it sees the imported ops in the log.
        assert_eq!(reborn.op_count(), 2);
    }

    #[test]
    fn local_undo_after_remote_merge_preserves_remote_ops() {
        // Codex 5.4 V1 audit C2 closure: peer A appends, B merges A's
        // bytes, A undoes A's append, B re-merges. After re-merge, B
        // sees A's op as retracted (Loro propagates the undo's inverse
        // through the CRDT). The remote contribution from B's own
        // appends survives unchanged.
        let base = CollabSession::new(PeerId::new(1)).unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();

        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
        let b_count_before = peer_b.op_count();
        assert!(b_count_before >= 2, "B sees A's + B's ops");

        // A undoes its append. iter().count() shrinks on A.
        assert!(peer_a.undo().unwrap());
        let a_iter = peer_a.op_log().iter().count();
        assert!(
            a_iter < 1 || a_iter == 0,
            "A's visible ops shrink post-undo, got {a_iter}"
        );

        // B merges A's post-undo state. A's retract should propagate.
        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
        let b_iter_after = peer_b.op_log().iter().count();
        assert!(
            b_iter_after < b_count_before,
            "B's visible op count must shrink after merging A's undo (was {b_count_before}, now {b_iter_after})"
        );
        // But B still sees its OWN op — undo is local-only.
        assert!(
            b_iter_after >= 1,
            "B's own op must survive A's local undo (local-only semantics)"
        );
    }

    #[test]
    fn attach_transport_returns_none_when_no_prior() {
        use crate::transport::NoopTransport;
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        assert!(!s.has_transport());
        let prior = s.attach_transport(NoopTransport::new());
        assert!(prior.is_none());
        assert!(s.has_transport());
    }

    #[test]
    fn attach_transport_returns_previous_on_replace() {
        use crate::transport::NoopTransport;
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.attach_transport(NoopTransport::new());
        let prior = s.attach_transport(NoopTransport::new());
        assert!(prior.is_some(), "second attach must return the first");
    }

    #[test]
    fn attach_transport_boxed_equivalent_to_generic() {
        // Phase 5.7 V2.1 (2026-05-22): pin that the Box-taking sibling
        // matches the generic version's semantics. The IDE binding's
        // napi Transport class extracts its inner Box and calls
        // attach_transport_boxed; this test pins the contract those
        // two entry points share.
        use crate::transport::NoopTransport;
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        assert!(!s.has_transport());

        // First attach via boxed entry point.
        let prior = s.attach_transport_boxed(Box::new(NoopTransport::new()));
        assert!(prior.is_none(), "first attach returns no prior");
        assert!(s.has_transport(), "transport now attached");

        // Replace via boxed entry point.
        let prior = s.attach_transport_boxed(Box::new(NoopTransport::new()));
        assert!(prior.is_some(), "replace returns the prior box");
        assert!(s.has_transport());

        // Replace via generic entry point — must also return prior.
        let prior = s.attach_transport(NoopTransport::new());
        assert!(
            prior.is_some(),
            "generic attach over boxed must also return prior"
        );
        assert!(s.has_transport());
    }

    #[test]
    fn attach_transport_boxed_resets_vv_baseline() {
        // Phase 5.7 V2.1 (2026-05-22): the boxed sibling must inherit
        // the V2 V3 step 1 contract — every attach (boxed or generic)
        // resets last_flushed_vv so the next flush sends from empty.
        //
        // **V2.1 audit closure (Opus LOW-2, 2026-05-22)**: this test
        // exercises the ENGINE sibling directly (NoopTransport + Loopback).
        // The NAPI binding's behavior is pinned by mocha in
        // `quantlab/extensions/quantlab/test/quantbook-roundtrip.test.ts`
        // ("reattach a different transport resets VV baseline"). The
        // engine-level test here catches engine regressions; the
        // mocha test catches napi-binding regressions. Both layers
        // independently exercise the same contract.
        use crate::transport::{LoopbackTransport, NoopTransport};
        let (a, _b) = LoopbackTransport::pair();
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.attach_transport(a);
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        let _ = s.flush_delta_to_transport().unwrap();
        assert!(!s.has_pending_flush(), "after flush, no pending");

        // Reattach via boxed entry point. Baseline must reset →
        // has_pending_flush flips back to true (because the new
        // peer hasn't seen any ops).
        let _ = s.attach_transport_boxed(Box::new(NoopTransport::new()));
        assert!(
            s.has_pending_flush(),
            "boxed reattach resets VV baseline; flush is pending again"
        );
    }

    #[test]
    fn detach_transport_returns_box_then_clears() {
        use crate::transport::NoopTransport;
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.attach_transport(NoopTransport::new());
        assert!(s.has_transport());
        let detached = s.detach_transport();
        assert!(detached.is_some());
        assert!(!s.has_transport());
        assert!(s.detach_transport().is_none(), "second detach is None");
    }

    #[test]
    fn flush_to_transport_noop_without_attached() {
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let flushed = s.flush_to_transport().unwrap();
        assert!(!flushed, "flush with no transport returns false");
    }

    #[test]
    fn poll_remote_noop_without_attached() {
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let drained = s.poll_remote().unwrap();
        assert_eq!(drained, 0, "poll with no transport returns 0");
    }

    #[test]
    fn flush_to_transport_pushes_bytes_via_attached() {
        use crate::transport::LoopbackTransport;
        let (tx_a, mut tx_b) = LoopbackTransport::pair();
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
        s.attach_transport(tx_a);

        assert_eq!(
            tx_b.pending_recv(),
            0,
            "transport idle until flush is called"
        );
        let flushed = s.flush_to_transport().unwrap();
        assert!(flushed);
        assert_eq!(tx_b.pending_recv(), 1, "flush pushed exactly one blob");

        // Sanity: the pushed bytes are a valid Loro snapshot
        // (poll on B's side drains them).
        let received = tx_b.try_recv().unwrap().expect("tx_b drains one blob");
        assert!(!received.is_empty());
    }

    #[test]
    fn poll_remote_drains_attached_transport() {
        use crate::transport::LoopbackTransport;
        let (tx_a, tx_b) = LoopbackTransport::pair();
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        // Pre-populate tx_a's inbox by writing into tx_b's outbox via
        // tx_b's send. (tx_b.send → tx_a.inbox)
        let snapshot = {
            let other = CollabSession::new(PeerId::new(2)).unwrap();
            other.export_bytes().unwrap()
        };
        let mut tx_b = tx_b; // own it for send
        tx_b.send(&snapshot).unwrap();
        tx_b.send(&snapshot).unwrap();

        s.attach_transport(tx_a);
        let drained = s.poll_remote().unwrap();
        assert_eq!(drained, 2, "poll drained both queued blobs");

        // Next poll is a no-op (queue empty).
        let drained2 = s.poll_remote().unwrap();
        assert_eq!(drained2, 0);
    }

    #[test]
    fn two_sessions_converge_via_attached_loopback() {
        use crate::transport::LoopbackTransport;
        let (tx_a, tx_b) = LoopbackTransport::pair();

        let base = CollabSession::new(PeerId::new(1)).unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
        peer_a.attach_transport(tx_a);
        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
        peer_b.attach_transport(tx_b);

        // A appends + flushes; B polls.
        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
        peer_a.flush_to_transport().unwrap();
        let drained_b = peer_b.poll_remote().unwrap();
        assert_eq!(drained_b, 1);
        assert!(peer_b.op_count() >= peer_a.op_count());

        // Reverse: B appends + flushes; A polls.
        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
        peer_b.flush_to_transport().unwrap();
        let drained_a = peer_a.poll_remote().unwrap();
        assert_eq!(drained_a, 1);
        assert_eq!(peer_a.op_count(), peer_b.op_count());
    }

    #[test]
    fn flush_to_transport_errors_when_transport_closed() {
        // Codex+Opus 5.5 V2 V1 audit closure: missing test for
        // flush-on-closed-transport. Attach a LoopbackTransport,
        // close it, then attempt flush — expect Transport::Closed.
        use crate::transport::LoopbackTransport;
        let (tx_a, _tx_b) = LoopbackTransport::pair();
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        // Close BEFORE attaching: close() takes &self so we can do
        // this on the raw transport.
        tx_a.close();
        s.attach_transport(tx_a);
        let result = s.flush_to_transport();
        assert!(
            matches!(
                result,
                Err(CollabSessionError::Transport(TransportError::Closed))
            ),
            "flush on closed transport must Err(Closed), got {result:?}"
        );
        // Local OpLog unaffected — op still in the log.
        assert!(s.op_count() >= 1);
    }

    #[test]
    fn poll_remote_treats_closed_as_graceful_end_of_stream() {
        // Codex+Opus 5.5 V2 V1 audit closure: pin partial-merge-
        // then-Closed semantics. The trait contract guarantees
        // Closed only after queue drains; CollabSession::poll_remote
        // returns Ok(merged) on Closed (NOT Err) so the caller sees
        // the merge count.
        use crate::transport::LoopbackTransport;
        let (tx_a, mut tx_b) = LoopbackTransport::pair();
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();

        // Queue 3 snapshots in tx_a's inbox.
        let snapshot = {
            let other = CollabSession::new(PeerId::new(2)).unwrap();
            other.export_bytes().unwrap()
        };
        for _ in 0..3 {
            tx_b.send(&snapshot).unwrap();
        }
        // Close tx_a's endpoint. Per trait contract, A.try_recv
        // drains 3 queued blobs first, then returns Closed.
        tx_a.close();
        s.attach_transport(tx_a);

        let drained = s.poll_remote().unwrap();
        assert_eq!(
            drained, 3,
            "poll_remote must drain all queued blobs even when transport is closed"
        );
        // Next poll: queue is empty + closed → still Ok(0) (graceful).
        let drained2 = s.poll_remote().unwrap();
        assert_eq!(drained2, 0);
    }

    #[test]
    fn poll_remote_with_limit_caps_drain() {
        // Codex+Opus 5.5 V2 V1 audit closure (H1): poll_remote_with_limit
        // bounds the drain. Pre-populate 10 blobs, drain 4 at a time.
        use crate::transport::LoopbackTransport;
        let (tx_a, mut tx_b) = LoopbackTransport::pair();
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();

        let snapshot = {
            let other = CollabSession::new(PeerId::new(2)).unwrap();
            other.export_bytes().unwrap()
        };
        for _ in 0..10 {
            tx_b.send(&snapshot).unwrap();
        }
        s.attach_transport(tx_a);

        let d1 = s.poll_remote_with_limit(4).unwrap();
        assert_eq!(d1, 4, "first call drains 4");
        let d2 = s.poll_remote_with_limit(4).unwrap();
        assert_eq!(d2, 4, "second call drains 4");
        let d3 = s.poll_remote_with_limit(4).unwrap();
        assert_eq!(d3, 2, "third call drains the remaining 2");
        let d4 = s.poll_remote_with_limit(4).unwrap();
        assert_eq!(d4, 0, "queue empty");

        // limit = 0 is a no-op even with queued blobs.
        tx_b.send(&snapshot).unwrap();
        let d5 = s.poll_remote_with_limit(0).unwrap();
        assert_eq!(d5, 0, "limit=0 must be a no-op");
    }

    #[test]
    fn attach_flush_detach_reattach_cycle() {
        // Codex+Opus 5.5 V2 V1 audit closure: missing test for
        // full attach-flush-detach-reattach lifecycle.
        use crate::transport::LoopbackTransport;
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();

        // Cycle 1: attach, flush, detach.
        let (tx_a1, tx_b1) = LoopbackTransport::pair();
        s.attach_transport(tx_a1);
        assert!(s.flush_to_transport().unwrap());
        assert_eq!(tx_b1.pending_recv(), 1, "first cycle: 1 blob in tx_b1");
        let detached1 = s.detach_transport();
        assert!(detached1.is_some());
        assert!(!s.has_transport());

        // Cycle 2: attach DIFFERENT transport, flush, detach.
        let (tx_a2, tx_b2) = LoopbackTransport::pair();
        s.attach_transport(tx_a2);
        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
        assert!(s.flush_to_transport().unwrap());
        assert_eq!(tx_b2.pending_recv(), 1, "second cycle: 1 blob in tx_b2");
        // tx_b1 unaffected by the second cycle.
        assert_eq!(tx_b1.pending_recv(), 1, "tx_b1 isolated from second attach");
        let _ = s.detach_transport();
    }

    #[test]
    fn debug_includes_transport_attached() {
        use crate::transport::NoopTransport;
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let d_pre = format!("{s:?}");
        assert!(
            d_pre.contains("transport_attached: false"),
            "Debug must include transport_attached: false: {d_pre}"
        );
        s.attach_transport(NoopTransport::new());
        let d_post = format!("{s:?}");
        assert!(
            d_post.contains("transport_attached: true"),
            "Debug must reflect attached: {d_post}"
        );
    }

    #[test]
    fn two_sessions_exchange_state_via_loopback_transport() {
        // Phase 5.5 V1 integration: drive two CollabSessions
        // through a LoopbackTransport pair. V1 doesn't auto-
        // flush appends to the transport (5.5 V2 work), so the
        // test manually exports/sends/recvs/merges to verify the
        // wire actually carries the right bytes.
        use crate::transport::{LoopbackTransport, Transport};
        let (mut tx_a, mut tx_b) = LoopbackTransport::pair();

        let base = CollabSession::new(PeerId::new(1)).unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();

        // Peer A appends an op, exports, sends over the wire.
        peer_a.append_op(put_value(0, 0, 0, 42.0)).unwrap();
        let a_bytes = peer_a.export_bytes().unwrap();
        tx_a.send(&a_bytes).unwrap();

        // Peer B drains the transport and merges.
        let received = tx_b
            .try_recv()
            .unwrap()
            .expect("tx_b must receive A's bytes");
        assert_eq!(received, a_bytes);
        peer_b.merge_bytes(&received).unwrap();
        assert!(peer_b.op_count() >= 1, "B must see A's op after merge");

        // Reverse direction: B appends, sends to A.
        peer_b.append_op(put_value(0, 1, 0, 99.0)).unwrap();
        tx_b.send(&peer_b.export_bytes().unwrap()).unwrap();
        let b_received = tx_a
            .try_recv()
            .unwrap()
            .expect("tx_a must receive B's bytes");
        peer_a.merge_bytes(&b_received).unwrap();

        // After the exchange, both sessions converge on the same op count.
        assert_eq!(peer_a.op_count(), peer_b.op_count());
    }

    #[test]
    fn debug_includes_undo_redo_counts() {
        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
        let d = format!("{s:?}");
        assert!(
            d.contains("undo_count"),
            "Debug must include undo_count: {d}"
        );
        assert!(
            d.contains("redo_count"),
            "Debug must include redo_count: {d}"
        );
    }

    #[test]
    fn sweep_presence_clears_all_entries_and_returns_count() {
        // Phase 5.6 V2: sweep_presence removes ALL presence
        // entries (including own + remote peers) and returns the
        // count cleared. Closes the V1 "stale presence after
        // .qbook reload" known limitation as a caller-opt-in.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        s.update_presence(PresenceState::at_cell(0, 0, 0)).unwrap();
        // Simulate a remote peer's presence via the lower-level
        // OpLog write (we don't have a multi-peer setup in this
        // test).
        s.log
            .presence_set("0000000000000002", r#"{"sheet":1,"row":2,"col":3,"selection_end_row":2,"selection_end_col":3,"typing":false}"#)
            .unwrap();
        assert_eq!(s.peers_with_presence().unwrap().len(), 2);

        let cleared = s.sweep_presence().unwrap();
        assert_eq!(cleared, 2, "sweep returns count of removed entries");
        assert!(s.peers_with_presence().unwrap().is_empty());
        assert_eq!(s.peer_presence(PeerId::new(1)).unwrap(), None);
        assert_eq!(s.peer_presence(PeerId::new(2)).unwrap(), None);

        // Subsequent update_presence works (sweep didn't corrupt
        // the LoroMap).
        s.update_presence(PresenceState::at_cell(2, 5, 5)).unwrap();
        assert_eq!(s.peers_with_presence().unwrap().len(), 1);
    }

    #[test]
    fn sweep_presence_on_empty_map_returns_zero() {
        // Edge case: sweep on a session with no presence entries
        // returns Ok(0), not an error.
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let cleared = s.sweep_presence().unwrap();
        assert_eq!(cleared, 0);
        // Sweep is idempotent — second call also returns 0.
        let cleared2 = s.sweep_presence().unwrap();
        assert_eq!(cleared2, 0);
    }

    #[test]
    fn sweep_presence_after_from_snapshot_gives_clean_slate() {
        // Acceptance: documented rejoin pattern. Origin writes
        // presence + exports. Reborn imports + sweeps → empty.
        let mut origin = CollabSession::new(PeerId::new(0xa)).unwrap();
        origin
            .update_presence(PresenceState::at_cell(0, 3, 4))
            .unwrap();
        let bytes = origin.export_bytes().unwrap();

        let mut reborn = CollabSession::from_snapshot(PeerId::new(0xa), &bytes).unwrap();
        // Without sweep: reborn sees origin's stale entry.
        assert_eq!(
            reborn.peers_with_presence().unwrap().len(),
            1,
            "without sweep, reborn inherits origin's presence"
        );
        // With sweep: clean slate.
        reborn.sweep_presence().unwrap();
        assert!(
            reborn.peers_with_presence().unwrap().is_empty(),
            "after sweep, reborn has no presence entries"
        );
    }

    #[test]
    fn presence_does_not_dirty_op_log() {
        // Updating presence MUST NOT add ops to the op log
        // (presence is a separate Loro container).
        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
        let baseline_ops = s.op_count();
        s.update_presence(PresenceState::at_cell(0, 0, 0)).unwrap();
        assert_eq!(
            s.op_count(),
            baseline_ops,
            "update_presence must not append to the op log"
        );
    }

    #[test]
    fn peer_id_max_is_rejected_by_constructors() {
        // PeerId(u64::MAX) is Loro's reserved sentinel; both
        // constructors should surface the error.
        let result = CollabSession::new(PeerId::new(u64::MAX));
        assert!(
            matches!(result, Err(CollabSessionError::OpLog(_))),
            "new(u64::MAX) must fail; got {result:?}"
        );
        // For from_snapshot we need a valid empty snapshot first.
        let origin = CollabSession::new(PeerId::new(1)).unwrap();
        let bytes = origin.export_bytes().unwrap();
        let result = CollabSession::from_snapshot(PeerId::new(u64::MAX), &bytes);
        assert!(
            matches!(result, Err(CollabSessionError::OpLog(_))),
            "from_snapshot(u64::MAX) must fail; got {result:?}"
        );
    }

    // ============================================================
    // Phase 5.7 V2.7 (2026-05-22) — error-code discrimination
    // ============================================================

    #[test]
    fn collab_session_error_kind_transport_inner_passthrough() {
        // Transport(inner) should return the inner's kind, NOT a
        // generic "session_transport" wrapper string. This is the
        // contract IDE callers depend on for reconnect logic.
        use crate::transport::TransportError;
        let e = super::CollabSessionError::Transport(TransportError::Closed);
        assert_eq!(e.kind(), "transport_closed");

        let e = super::CollabSessionError::Transport(TransportError::Io("dead".into()));
        assert_eq!(e.kind(), "transport_io");
    }
}
