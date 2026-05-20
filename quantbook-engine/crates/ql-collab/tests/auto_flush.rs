//! Phase 5.5 V2 V2 (2026-05-21) — auto-flush on append integration tests.
//!
//! Verifies `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)`
//! propagates every local mutation through the attached transport
//! WITHOUT a manual `flush_to_transport` call.
//!
//! V2 V1 (Phase 5.5 V2 V1 ship `ffd8f6e5f05`) was deliberately
//! explicit-drive: caller invokes `flush_to_transport()` after each
//! batch. V2 V2 adds the opt-in `OnAppend` policy so IDE callers
//! (Phase 5.7) can rely on "every keystroke propagates" without
//! scheduling their own flush ticks.
//!
//! ## Coverage
//!
//! - Default policy is `Disabled` (V2 V1 behavior preserved).
//! - `OnAppend` with no transport: append_op succeeds; no error.
//! - `OnAppend` with LoopbackTransport pair: appends propagate without
//!   manual flush.
//! - `OnAppend` with closed transport: append_op surfaces Err with
//!   local op already committed (partial-state contract).
//! - Auto-flush triggers on every documented mutator: `append_op`,
//!   `merge_bytes`, `update_presence`, `clear_presence`,
//!   `sweep_presence`, `undo`, `redo`.
//! - Policy round-trip: set_auto_flush_policy returns previous,
//!   subsequent auto_flush_policy() reflects new value.
//! - Flip back to Disabled stops flushing.

use ql_collab::{
    AutoFlushPolicy, CollabSession, CollabSessionError, LoopbackTransport, NoopTransport, PeerId,
    PresenceState, Transport, TransportError,
};
use ql_oplog::{CellWireValue, Op};

fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
    Op::PutValue {
        sheet,
        row,
        col,
        value: CellWireValue::Number(n),
    }
}

fn add_sheet() -> Op {
    Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    }
}

// ===== Default policy + accessor round-trip =====

#[test]
fn default_policy_is_disabled() {
    let s = CollabSession::new(PeerId::new(1)).unwrap();
    assert_eq!(
        s.auto_flush_policy(),
        AutoFlushPolicy::Disabled,
        "default MUST be Disabled to preserve V2 V1 caller behavior"
    );
}

#[test]
fn default_policy_in_from_snapshot_is_disabled() {
    // Snapshot-join also defaults to Disabled.
    let base = CollabSession::new(PeerId::new(1)).unwrap();
    let bytes = base.export_bytes().unwrap();
    let s = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
    assert_eq!(s.auto_flush_policy(), AutoFlushPolicy::Disabled);
}

#[test]
fn set_auto_flush_policy_returns_previous() {
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    let prev = s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    assert_eq!(prev, AutoFlushPolicy::Disabled);
    assert_eq!(s.auto_flush_policy(), AutoFlushPolicy::OnAppend);
    let prev2 = s.set_auto_flush_policy(AutoFlushPolicy::Disabled);
    assert_eq!(prev2, AutoFlushPolicy::OnAppend);
    assert_eq!(s.auto_flush_policy(), AutoFlushPolicy::Disabled);
}

// ===== OnAppend with no transport: no error =====

#[test]
fn on_append_with_no_transport_is_noop() {
    // Policy OnAppend without attaching a transport must not error
    // on appends — the policy is harmless until a transport is wired.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
    assert_eq!(s.op_count(), 2);
    assert!(!s.has_transport());
}

// ===== OnAppend with LoopbackTransport pair: round-trip works =====
// (Counting per-mutator sends is covered by LoopbackTransport's
// pending_recv accessor in the tests below — better than NoopTransport's
// `sent: Vec<Vec<u8>>` field, which can't be introspected through the
// `Box<dyn Transport>` that attach_transport stores.)

#[test]
fn on_append_propagates_via_loopback_pair() {
    // Peer A: policy OnAppend, transport attached.
    // Peer B: holds the paired transport endpoint (NO session — we just
    //         drain via try_recv to verify peer A's auto-flush sent bytes).
    let (tx_a, mut tx_b) = LoopbackTransport::pair();

    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert_eq!(tx_b.pending_recv(), 0, "transport empty pre-append");

    peer_a.append_op(add_sheet()).unwrap();
    assert_eq!(
        tx_b.pending_recv(),
        1,
        "auto-flush MUST fire after append_op without manual flush_to_transport"
    );

    peer_a.append_op(put_value(0, 0, 0, 42.0)).unwrap();
    assert_eq!(tx_b.pending_recv(), 2, "second append → second auto-flush");

    // Drain tx_b: each blob must be a valid Loro snapshot (try_recv
    // returns Some bytes).
    let first = tx_b.try_recv().unwrap();
    assert!(
        first.is_some_and(|bytes| !bytes.is_empty()),
        "auto-flushed bytes are non-empty Loro snapshot"
    );
    let second = tx_b.try_recv().unwrap();
    assert!(second.is_some_and(|bytes| !bytes.is_empty()));
    assert_eq!(tx_b.try_recv().unwrap(), None, "queue drained");
}

#[test]
fn on_append_two_peer_session_round_trip_via_auto_flush() {
    // Full two-peer scenario: peer A has policy OnAppend + transport
    // attached; peer B has NO auto-flush (V2 V1 explicit-drive) +
    // attached. Verify peer B sees peer A's ops just by calling
    // poll_remote, WITHOUT peer A calling flush_to_transport.
    let base = CollabSession::new(PeerId::new(100)).unwrap();
    let base_bytes = base.export_bytes().unwrap();

    let (tx_a, tx_b) = LoopbackTransport::pair();

    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
    peer_b.attach_transport(tx_b);
    // Peer B uses V2 V1 explicit-drive (default Disabled). Peer A's
    // auto-flush fires per mutation; peer B drains via poll_remote.

    peer_a.append_op(add_sheet()).unwrap();
    peer_a.append_op(put_value(0, 0, 0, 99.0)).unwrap();

    let merged = peer_b.poll_remote().unwrap();
    assert_eq!(
        merged, 2,
        "peer B receives 2 auto-flushed snapshots from peer A's appends"
    );
    // Peer B's log now contains peer A's ops (Loro merge semantics
    // — each blob is a snapshot of peer A's full log, but Loro
    // dedupes so each merge brings in NEW ops only).
    assert!(
        peer_b.op_count() >= 2,
        "peer B's op log must reflect peer A's appends: got {}",
        peer_b.op_count()
    );
}

// ===== OnAppend with closed transport: Err surfaces, local committed =====

#[test]
fn on_append_with_closed_transport_surfaces_err_after_local_commit() {
    // Partial-state contract: auto-flush failure returns Err but the
    // local op IS appended to self.log first (mutate-then-flush).
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    let mut noop = NoopTransport::new();
    noop.close();
    s.attach_transport(noop);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    let result = s.append_op(add_sheet());
    assert!(
        matches!(
            result,
            Err(CollabSessionError::Transport(TransportError::Closed))
        ),
        "closed transport MUST surface CollabSessionError::Transport(Closed); got {result:?}"
    );

    // Partial-state contract: local op IS committed even though flush failed.
    assert_eq!(
        s.op_count(),
        1,
        "local op MUST be committed before auto-flush; AppendOp succeeded, only flush failed"
    );
}

#[test]
fn on_append_close_mid_session_recovers_via_detach_and_reattach() {
    // Scenario: peer A is mid-session with OnAppend + LoopbackTransport.
    // The peer side closes the transport (network partition). Subsequent
    // appends MUST surface Err loudly (no silent retry per
    // CLAUDE.md No-Fallback rule). Recovery path: detach the failed
    // transport, attach a fresh one, resume appending.
    let (tx_a, tx_b) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.attach_transport(tx_a);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // First append — transport open, succeeds.
    s.append_op(add_sheet()).unwrap();
    assert_eq!(s.op_count(), 1);

    // Simulate peer-side disconnect: close peer B's endpoint.
    // LoopbackTransport::close uses Relaxed ordering — fine within
    // a single thread; same thread observes the close immediately.
    tx_b.close();
    // Drain whatever's in B's inbox so subsequent A.send fails (sender
    // sends to A's outbox = B's inbox; close blocks B's send AND A's
    // send-into-B since LoopbackTransport routes through paired
    // queues). Actually A.send writes to a queue that B drains; A's
    // close-state lives on A's endpoint, not B's. Closing B doesn't
    // block A.send.
    //
    // For this test we close A's OWN endpoint to simulate "the local
    // socket died" — which is what the partial-state contract is
    // really about. Re-acquire A's transport for the close — but we
    // can't, because attach_transport moved it. Use detach + re-close.
    let detached = s.detach_transport().unwrap();
    // Reattach the same endpoint and then close it via downcast — not
    // possible through dyn Transport. Instead, just attach a freshly-
    // closed NoopTransport to simulate the failure mode + recovery.
    let mut bad = NoopTransport::new();
    bad.close();
    s.attach_transport(bad);

    // Next append: auto-flush fails Closed.
    let result = s.append_op(put_value(0, 0, 0, 1.0));
    assert!(
        matches!(
            result,
            Err(CollabSessionError::Transport(TransportError::Closed))
        ),
        "closed transport mid-session MUST surface Err loudly; got {result:?}"
    );
    // But local op IS committed (partial-state contract).
    assert_eq!(s.op_count(), 2);

    // Recovery: detach bad, attach fresh, resume.
    let _bad = s.detach_transport();
    s.attach_transport(NoopTransport::new());
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
    assert_eq!(s.op_count(), 3);

    // Silence the original drop of tx_b detached.
    let _ = detached;
}

// ===== Auto-flush fires on every documented mutator =====

#[test]
fn on_append_fires_on_merge_bytes() {
    let base = CollabSession::new(PeerId::new(100)).unwrap();
    let base_bytes = base.export_bytes().unwrap();

    // Build a peer-B snapshot with one op to merge.
    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
    peer_b.append_op(add_sheet()).unwrap();
    let b_bytes = peer_b.export_bytes().unwrap();

    // Peer A: OnAppend + transport. Merging peer B's bytes must
    // auto-flush the post-merge union.
    let (tx_a, mut tx_observer) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert_eq!(tx_observer.pending_recv(), 0);
    peer_a.merge_bytes(&b_bytes).unwrap();
    assert_eq!(
        tx_observer.pending_recv(),
        1,
        "merge_bytes MUST auto-flush so 3rd-party peers see the merged union"
    );
    let _ = tx_observer.try_recv();
}

#[test]
fn on_append_fires_on_update_and_clear_presence() {
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert_eq!(observer.pending_recv(), 0);
    peer_a
        .update_presence(PresenceState::at_cell(0, 3, 4))
        .unwrap();
    assert_eq!(
        observer.pending_recv(),
        1,
        "update_presence MUST auto-flush — peers need cursor updates"
    );

    peer_a.clear_presence().unwrap();
    assert_eq!(
        observer.pending_recv(),
        2,
        "clear_presence MUST auto-flush — 'I left' must propagate"
    );
}

#[test]
fn on_append_fires_on_sweep_presence_once_per_call() {
    // sweep_presence removes N entries but auto-flushes ONCE per call
    // (not per-key) — bandwidth-friendly batching.
    let base = CollabSession::new(PeerId::new(100)).unwrap();
    let base_bytes = base.export_bytes().unwrap();

    // Pre-populate presence: two peers' entries.
    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
    peer_a
        .update_presence(PresenceState::at_cell(0, 1, 1))
        .unwrap();
    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
    peer_b
        .update_presence(PresenceState::at_cell(0, 2, 2))
        .unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    assert!(peer_a.peers_with_presence().unwrap().len() >= 2);

    // Now attach transport + OnAppend, then sweep.
    let (tx_a, observer) = LoopbackTransport::pair();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert_eq!(observer.pending_recv(), 0);
    let removed = peer_a.sweep_presence().unwrap();
    assert!(removed >= 2);
    assert_eq!(
        observer.pending_recv(),
        1,
        "sweep_presence MUST auto-flush ONCE for the batch, not per-key"
    );
}

#[test]
fn on_append_fires_on_undo_and_redo() {
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.append_op(add_sheet()).unwrap();
    peer_a.append_op(put_value(0, 0, 0, 99.0)).unwrap();

    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Undo: Loro appends an inverse op → auto-flush fires.
    assert_eq!(observer.pending_recv(), 0);
    let undone = peer_a.undo().unwrap();
    assert!(undone, "undo stack must have an item from the prior append");
    assert_eq!(
        observer.pending_recv(),
        1,
        "undo MUST auto-flush — peers need to see inverse ops"
    );

    // Redo: same.
    let redone = peer_a.redo().unwrap();
    assert!(redone);
    assert_eq!(
        observer.pending_recv(),
        2,
        "redo MUST auto-flush — peers need to see the redo's inverse-of-inverse"
    );
}

// ===== Flip-back: switching to Disabled stops auto-flush =====

#[test]
fn flip_back_to_disabled_stops_auto_flush() {
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.attach_transport(tx_a);

    // Disabled (default): no auto-flush.
    peer_a.append_op(add_sheet()).unwrap();
    assert_eq!(observer.pending_recv(), 0);

    // OnAppend: fires.
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    peer_a.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    assert_eq!(observer.pending_recv(), 1);

    // Flip back to Disabled.
    peer_a.set_auto_flush_policy(AutoFlushPolicy::Disabled);
    peer_a.append_op(put_value(0, 0, 1, 2.0)).unwrap();
    assert_eq!(
        observer.pending_recv(),
        1,
        "flip-back to Disabled MUST stop auto-flush — no new sends"
    );
    // But explicit flush still works for V2 V1 callers.
    peer_a.flush_to_transport().unwrap();
    assert_eq!(
        observer.pending_recv(),
        2,
        "explicit flush_to_transport remains available regardless of policy"
    );
}

// ===== Accessor methods must NOT trigger auto-flush =====

#[test]
fn accessor_methods_do_not_trigger_auto_flush() {
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.append_op(add_sheet()).unwrap();
    peer_a
        .update_presence(PresenceState::at_cell(0, 0, 0))
        .unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert_eq!(observer.pending_recv(), 0);

    // None of these should trigger auto-flush — they're all read-only.
    let _ = peer_a.peer_id();
    let _ = peer_a.op_count();
    let _ = peer_a.is_empty();
    let _ = peer_a.auto_flush_policy();
    let _ = peer_a.has_transport();
    let _ = peer_a.op_log();
    let _ = peer_a.can_undo();
    let _ = peer_a.can_redo();
    let _ = peer_a.undo_count();
    let _ = peer_a.redo_count();
    let _ = peer_a.peer_presence(PeerId::new(1)).unwrap();
    let _ = peer_a.peers_with_presence().unwrap();
    let _ = peer_a.export_bytes().unwrap();

    assert_eq!(
        observer.pending_recv(),
        0,
        "no accessor method may trigger auto-flush"
    );
}
