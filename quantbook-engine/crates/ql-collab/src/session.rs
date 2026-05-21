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
//! - **Phase 5.5** — transport layer. V1 shipped at
//!   `924750819bc` (LoopbackTransport for in-process 2-peer
//!   tests). V2 V1 shipped at `ffd8f6e5f05` —
//!   `CollabSession::{attach,detach,has}_transport` +
//!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
//!   typed methods; explicit-drive (caller invokes flush + poll
//!   on a tick). V2 V2 / V3 pending — auto-flush + version-
//!   vector deltas + WebSocket impl.
//! - ~~**Phase 5.6**~~ ✅ V1 + V2 shipped — V1 `c677e244704`:
//!   `presence` module + 4 typed methods. V2: `sweep_presence`
//!   (caller-opt-in clean-slate on rejoin; closes V1 known
//!   persistence limitation).
//! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
//!   handle that the IDE attaches to each open workbook.
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

use thiserror::Error;

use ql_functions::FunctionRegistry;
use ql_oplog::{replay_into, Op, OpLog, OpLogError, PeerId, ReplayError, PRESENCE_COMMIT_ORIGIN};
use ql_storage::Workbook;

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
        let undo = make_undo_manager(&log);
        Ok(Self {
            peer_id,
            log,
            undo,
            transport: None,
            auto_flush_policy: AutoFlushPolicy::Disabled,
            last_flushed_vv: None,
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
        let undo = make_undo_manager(&log);
        Ok(Self {
            peer_id,
            log,
            undo,
            transport: None,
            auto_flush_policy: AutoFlushPolicy::Disabled,
            last_flushed_vv: None,
        })
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
        self.log.append(op)?;
        self.maybe_auto_flush()?;
        Ok(())
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
    ///   the API entry point for Phase 5.7 IDE binding to wire. No
    ///   production code path calls it yet — the user-visible D-3
    ///   closure happens at step 7, not 5b.
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
    pub fn attach_transport<T: Transport + Send + 'static>(
        &mut self,
        transport: T,
    ) -> Option<Box<dyn Transport + Send>> {
        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** reset `last_flushed_vv`
        // to `None`. A new transport-peer hasn't seen ANY of this
        // session's ops, so the next `flush_delta_to_transport` must
        // send from the empty VV (= all ops). If we kept the stale
        // VV from a prior transport, the new peer would miss ops
        // 0..stale_vv and end up with a corrupt view.
        self.last_flushed_vv = None;
        self.transport.replace(Box::new(transport))
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
        let consumed = self.undo.undo()?;
        // **Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21):** only
        // auto-flush when an undo item was actually consumed. The prior
        // "flush unconditionally" pattern turned `Ok(false)` into
        // `Err(Transport(_))` when the transport was closed AND the
        // undo stack was empty — spurious failure semantics. With the
        // gate, `undo` on an empty stack stays `Ok(false)` regardless
        // of transport state (no mutation, no flush attempt).
        if consumed {
            self.maybe_auto_flush()?;
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
        let consumed = self.undo.redo()?;
        // Phase 5.5 V2 V2 audit closure (Codex M2): gate matches `undo`.
        if consumed {
            self.maybe_auto_flush()?;
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
        Ok(self.undo.group_start()?)
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
fn make_undo_manager(log: &OpLog) -> loro::UndoManager {
    let mut undo = log.new_undo_manager();
    undo.add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN);
    undo
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
}
