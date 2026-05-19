//! `CollabSession` — per-peer collaboration state holder.
//!
//! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
//! with peer-id-aware operations + transport plumbing. Subsequent
//! phases populate richer behavior:
//!
//! - ~~**Phase 5.4**~~ ✅ V1 shipped at `89c02b9d83e` — per-peer
//!   Loro `UndoManager` tracks local appends. Undo APPENDS
//!   inverse ops + retracts originals from the visible `"ops"`
//!   list (NOT physical removal). Presence-origin commits
//!   excluded. See [`session::CollabSession::undo`].
//! - **Phase 5.5** — transport layer. V1 shipped at
//!   `924750819bc` (LoopbackTransport for in-process 2-peer
//!   tests). V2 V1 shipped at `ffd8f6e5f05` —
//!   `CollabSession::{attach,detach,has}_transport` +
//!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
//!   typed methods; explicit-drive (caller invokes flush + poll
//!   on a tick). V2 V2 / V3 pending — auto-flush + version-
//!   vector deltas + WebSocket impl.
//! - ~~**Phase 5.6**~~ ✅ V1 shipped at `c677e244704` — `presence`
//!   module + 4 `CollabSession` methods (`update_presence` /
//!   `peer_presence` / `clear_presence` / `peers_with_presence`).
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

use ql_oplog::{Op, OpLog, OpLogError, PRESENCE_COMMIT_ORIGIN};

use crate::peer::PeerId;
use crate::presence::{self, PresenceError, PresenceState};
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
    /// V2 V1 scope: caller drives flush + poll explicitly
    /// (no auto-flush on append). V2 V2 / V3 will add
    /// auto-flush + version-vector delta exports.
    transport: Option<Box<dyn Transport + Send>>,
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
    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
        let mut log = OpLog::new();
        log.set_peer_id(peer_id.as_u64())?;
        let undo = make_undo_manager(&log);
        Ok(Self {
            peer_id,
            log,
            undo,
            transport: None,
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
    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
        let mut log = OpLog::import_bytes(bytes)?;
        log.set_peer_id(peer_id.as_u64())?;
        let undo = make_undo_manager(&log);
        Ok(Self {
            peer_id,
            log,
            undo,
            transport: None,
        })
    }

    /// Stable peer id assigned at session creation.
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Append a local op. Delegates to `OpLog::append`. Phase 5.5
    /// will additionally push the appended bytes through the
    /// attached `Transport`; 5.2.a leaves transport integration to
    /// the caller.
    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
        self.log.append(op)?;
        Ok(())
    }

    /// Merge a remote peer's snapshot into this session's log. Loro's
    /// CRDT preserves both peers' concurrent appends in deterministic
    /// causal order (Fugue/origin-based with peer-id tiebreaker per
    /// Phase 5.1 audit Codex V1). Returns the new `len()` after merge.
    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
        Ok(self.log.merge_bytes(bytes)?)
    }

    /// Produce a Loro snapshot blob suitable for transport to other
    /// peers OR for `.qbook/oplog.bin` persistence.
    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
        Ok(self.log.export_bytes()?)
    }

    /// Borrow the underlying `OpLog` for replay against a `Workbook`.
    ///
    /// Typical usage:
    /// ```ignore
    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
    /// let mut wb = ql_storage::Workbook::new();
    /// let reg = ql_functions::default_registry();
    /// ql_oplog::replay_into(session.op_log(), &mut wb, &reg)?;
    /// ```
    pub fn op_log(&self) -> &OpLog {
        &self.log
    }

    /// Current number of ops in the log. Cheap (cached).
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
    /// attached and got replaced. V2 V1 does NOT auto-flush on
    /// `append_op` — caller drives flush + poll explicitly. V3
    /// will add auto-flush + version-vector delta exports.
    pub fn attach_transport<T: Transport + Send + 'static>(
        &mut self,
        transport: T,
    ) -> Option<Box<dyn Transport + Send>> {
        self.transport.replace(Box::new(transport))
    }

    /// **Phase 5.5 V2 V1 (2026-05-19):** detach the current
    /// transport. Returns it for caller cleanup; returns `None`
    /// if no transport was attached.
    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
        self.transport.take()
    }

    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
    /// currently attached.
    pub fn has_transport(&self) -> bool {
        self.transport.is_some()
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
    /// V2 V1 sends the FULL snapshot each call (O(state)). V2 V2
    /// will track per-transport version vectors and send deltas
    /// only.
    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
        let Some(transport) = self.transport.as_mut() else {
            return Ok(false);
        };
        let bytes = self.log.export_bytes()?;
        transport.send(&bytes)?;
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
        Ok(merged)
    }

    /// **Phase 5.6 V1 (2026-05-19):** write this session's own
    /// presence state into the shared `"presence"` LoroMap.
    ///
    /// Uses the session's `PeerId` as the map key (16-hex
    /// `Display` form). Subsequent calls overwrite the previous
    /// value (LWW per peer); merges with other peers'
    /// presence writes preserve all distinct peers.
    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
        let key = presence::peer_key(self.peer_id);
        let json = serde_json::to_string(&state).map_err(PresenceError::Serialize)?;
        self.log.presence_set(&key, &json)?;
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
    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
        let key = presence::peer_key(self.peer_id);
        self.log.presence_remove(&key)?;
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
    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
        Ok(self.undo.undo()?)
    }

    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
    /// Returns `Ok(true)` if a redo stack item was consumed,
    /// `Ok(false)` if the stack was empty.
    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
        Ok(self.undo.redo()?)
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
        s.detach_transport();
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
