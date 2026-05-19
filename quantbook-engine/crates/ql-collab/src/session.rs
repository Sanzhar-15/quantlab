//! `CollabSession` — per-peer collaboration state holder.
//!
//! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
//! with peer-id-aware operations + transport plumbing. Subsequent
//! phases populate richer behavior:
//!
//! - **Phase 5.4** — undo manager integration (per-peer Loro
//!   `UndoManager` tracks local appends; undo removes them from
//!   the log).
//! - **Phase 5.5** — automatic transport integration: append a
//!   local op → broadcast bytes via [`crate::Transport::send`];
//!   poll [`crate::Transport::try_recv`] for remote bytes →
//!   `merge_bytes`.
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

use ql_oplog::{Op, OpLog, OpLogError};

use crate::peer::PeerId;
use crate::presence::{self, PresenceError, PresenceState};

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
        let log = OpLog::new();
        log.set_peer_id(peer_id.as_u64())?;
        Ok(Self { peer_id, log })
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
        let log = OpLog::import_bytes(bytes)?;
        log.set_peer_id(peer_id.as_u64())?;
        Ok(Self { peer_id, log })
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
            .finish()
    }
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
