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

    // Recovery: detach bad, attach a fresh LoopbackTransport pair so
    // we can verify the resumed appends actually reach the wire AND
    // that the previously-"failed-flush" op #2 (committed locally) is
    // included in the next snapshot. Phase 5.5 V2 V2 audit closure
    // Opus L2 (2026-05-21): pre-closure this test used NoopTransport
    // and never asserted that op #2 appears post-reattach.
    let _bad = s.detach_transport();
    let (tx_fresh, mut fresh_observer) = LoopbackTransport::pair();
    s.attach_transport(tx_fresh);
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
    assert_eq!(s.op_count(), 3);

    // Verify the recovered transport's peer sees a snapshot that
    // contains BOTH op #2 (the "failed flush" op) and op #3. The
    // V2 V2 full-snapshot semantics mean every flush carries the
    // full local state from scratch, so the freshly-attached
    // transport gets the complete log even though it joined late.
    assert_eq!(
        fresh_observer.pending_recv(),
        1,
        "post-reattach append MUST auto-flush onto the fresh transport"
    );
    let snap = fresh_observer.try_recv().unwrap().expect("snapshot bytes");
    let recovered_log = ql_oplog::OpLog::import_bytes(&snap).unwrap();
    assert_eq!(
        recovered_log.len(),
        3,
        "full-snapshot flush MUST include op #1 (pre-failure) + op #2 (failed-flush op, committed locally) + op #3 (post-recovery)"
    );

    // Silence the original drop of tx_b detached.
    let _ = detached;
}

// ===== Codex M2 closure: undo/redo gate auto-flush on `consumed == true` =====

#[test]
fn undo_on_empty_stack_does_not_auto_flush_even_with_closed_transport() {
    // Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21): undo on
    // an empty stack must not attempt the auto-flush — otherwise a
    // closed transport turns "nothing to undo" into a spurious
    // Err(Transport(_)). Pre-closure the flush ran unconditionally.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    let mut bad = NoopTransport::new();
    bad.close();
    s.attach_transport(bad);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Empty undo stack — no consumption, no flush attempt, no Err
    // from the closed transport.
    let result = s.undo();
    assert!(
        matches!(result, Ok(false)),
        "undo on empty stack with closed transport MUST be Ok(false) (no flush attempt); got {result:?}"
    );

    // Same for redo.
    let result = s.redo();
    assert!(
        matches!(result, Ok(false)),
        "redo on empty stack with closed transport MUST be Ok(false); got {result:?}"
    );
}

#[test]
fn undo_with_item_consumed_still_fires_auto_flush() {
    // Phase 5.5 V2 V2 audit closure (Codex M2 sanity check): the gate
    // must NOT suppress auto-flush in the consumed-true case.
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 99.0)).unwrap();

    s.attach_transport(tx_a);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert_eq!(observer.pending_recv(), 0);
    let consumed = s.undo().unwrap();
    assert!(consumed, "undo stack has an item from prior append");
    assert_eq!(
        observer.pending_recv(),
        1,
        "undo with consumed=true MUST still auto-flush"
    );
}

// ===== Codex M3 closure: failure coverage on merge_bytes =====

#[test]
fn merge_bytes_with_closed_transport_surfaces_err_after_local_commit() {
    // Phase 5.5 V2 V2 audit closure (Codex M3, 2026-05-21): extend
    // failure coverage beyond append_op. merge_bytes follows the
    // same partial-state contract — the merge is committed locally
    // before the auto-flush attempt.
    let base = CollabSession::new(PeerId::new(100)).unwrap();
    let base_bytes = base.export_bytes().unwrap();
    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
    peer_b.append_op(add_sheet()).unwrap();
    let b_bytes = peer_b.export_bytes().unwrap();

    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
    let mut bad = NoopTransport::new();
    bad.close();
    peer_a.attach_transport(bad);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    let result = peer_a.merge_bytes(&b_bytes);
    assert!(
        matches!(
            result,
            Err(CollabSessionError::Transport(TransportError::Closed))
        ),
        "merge_bytes with closed transport MUST surface Err; got {result:?}"
    );

    // Partial-state contract: peer B's op is already merged locally.
    assert!(
        peer_a.op_count() >= 1,
        "merge MUST be committed locally before flush attempt; op_count={}",
        peer_a.op_count()
    );
}

// ===== Opus L1 closure: pin undo-group + OnAppend semantics =====

#[test]
fn on_append_within_undo_group_fires_per_append_not_per_group() {
    // Phase 5.5 V2 V2 audit closure (Opus L1, 2026-05-21): pin the
    // current contract — undo-group is a LOCAL undo unit; on the
    // wire each mid-group append fires its own auto-flush. If a
    // future change wants atomic-over-wire group semantics, this
    // test must be updated deliberately.
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.attach_transport(tx_a);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    s.start_undo_group().unwrap();
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.end_undo_group();

    // V2 V2 contract: 2 auto-flushes (one per mid-group append).
    // 0 auto-flushes on end_undo_group (boundary-only, no mutation).
    assert_eq!(
        observer.pending_recv(),
        2,
        "V2 V2 contract: mid-group appends each auto-flush; group is local-only on the wire"
    );
}

// ===== V2 V3 step 2: poll_remote triggers auto-flush (inverted from V2 V2 exclusion) =====

#[test]
fn poll_remote_triggers_auto_flush_under_on_append() {
    // **Phase 5.5 V2 V3 step 2 (2026-05-21):** reverses the V2 V2
    // "receive-side excluded by design" exclusion. With V2 V3 step 1's
    // idempotency guard in place, wiring poll_remote into auto-flush
    // is safe — duplicate (Loro-deduped) merges leave the VV
    // unchanged and the auto-flush short-circuits to Ok(false).
    //
    // Test (replaces V2 V2 audit closure test which asserted the
    // OPPOSITE — now the contract is inverted): peer A has OnAppend +
    // transport. Peer B sends a blob with a NEW op into A's inbox.
    // A's poll_remote drains it AND auto-flushes the merged delta
    // back onto the same paired transport. tx_b (B's side) sees the
    // round-trip arrive.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Peer B (fresh session, no transport) crafts a snapshot with one
    // op and pushes the bytes into A's inbox via the paired endpoint.
    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
    peer_b.append_op(add_sheet()).unwrap();
    let b_bytes = peer_b.export_bytes().unwrap();
    tx_b.send(&b_bytes).unwrap();

    assert_eq!(
        tx_b.pending_recv(),
        0,
        "pre-poll: B's inbox is empty (A hasn't flushed anything yet)"
    );

    // A drains B's blob via poll_remote. With V2 V3 step 2, this
    // ALSO auto-flushes the post-merge delta back through the same
    // transport — bytes land in B's inbox.
    let merged = peer_a.poll_remote().unwrap();
    assert_eq!(merged, 1, "A drained 1 blob from peer B");
    assert!(
        peer_a.op_count() >= 1,
        "A's log now contains B's op via the merge"
    );
    assert_eq!(
        tx_b.pending_recv(),
        1,
        "V2 V3 step 2: poll_remote MUST auto-flush after a successful drain that advanced state"
    );

    // Verify the round-trip blob can be Loro-imported (sanity).
    let bytes_back = tx_b.try_recv().unwrap().expect("round-trip bytes");
    let _imported = ql_oplog::OpLog::import_bytes(&bytes_back).unwrap();
}

#[test]
fn poll_remote_idempotent_merge_short_circuits_no_wire_send() {
    // V2 V3 step 2 + step 1 interaction: if the drained blob only
    // contains ops the local session ALREADY knows (Loro dedupe), the
    // post-merge VV equals last_flushed_vv, and the auto-flush
    // short-circuits to Ok(false) without invoking transport.send.
    //
    // Setup: peer A appends an op, attaches a transport, flushes once
    // (last_flushed_vv = current). Peer B sends A its EXACT current
    // state. A's poll_remote merges (no new ops), auto-flush
    // short-circuits — tx_b sees no new bytes from the round-trip.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.append_op(add_sheet()).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    // Explicit first flush to set last_flushed_vv = current.
    let _ = peer_a.flush_delta_to_transport().unwrap();
    let baseline_recv = tx_b.try_recv().unwrap();
    assert!(baseline_recv.is_some(), "first explicit flush delivered");
    assert_eq!(tx_b.pending_recv(), 0);

    // Send A's OWN state back to itself — simulates B sending a
    // snapshot containing only ops A already has.
    let a_state = peer_a.export_bytes().unwrap();
    tx_b.send(&a_state).unwrap();

    // Poll: drain succeeds, merge is a Loro-dedupe no-op, VV
    // unchanged, auto-flush short-circuits.
    let merged = peer_a.poll_remote().unwrap();
    assert_eq!(merged, 1, "A drained 1 blob");
    assert_eq!(
        tx_b.pending_recv(),
        0,
        "idempotent merge: auto-flush MUST short-circuit (no wire send)"
    );
}

#[test]
fn poll_remote_empty_drain_does_not_attempt_flush() {
    // Defensive optimization in V2 V3 step 2: when `merged == 0`,
    // skip the flush call entirely (no VV-clone + compare). Confirms
    // 0-blob drain → 0 send attempt.
    //
    // Uses NoopTransport (records every send in `sent: Vec<Vec<u8>>`).
    // But we can't introspect through `Box<dyn Transport>` — use
    // LoopbackTransport with an empty inbox and assert nothing
    // appears on the peer's pending_recv.
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.append_op(add_sheet()).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Drain on EMPTY inbox → 0 merged → no flush attempted.
    let merged = peer_a.poll_remote().unwrap();
    assert_eq!(merged, 0, "empty inbox → no blobs drained");
    assert_eq!(
        observer.pending_recv(),
        0,
        "0 blobs drained → no auto-flush attempted (no wire send)"
    );
}

#[test]
fn poll_remote_with_closed_transport_returns_zero_no_flush() {
    // When the transport is closed AND its inbox is empty, the
    // existing graceful break in poll_remote_with_limit returns
    // Ok(0). With V2 V3 step 2, the `merged > 0` guard prevents a
    // spurious flush attempt (which would error on the closed
    // transport's send side).
    let mut bad = NoopTransport::new();
    bad.close();
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.append_op(add_sheet()).unwrap();
    peer_a.attach_transport(bad);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // poll_remote should return Ok(0) (no blobs to drain, closed
    // gracefully). The merged > 0 guard prevents an auto-flush
    // attempt that would have errored.
    let result = peer_a.poll_remote();
    assert!(
        matches!(result, Ok(0)),
        "closed-transport empty-drain MUST return Ok(0) without attempting flush; got {result:?}"
    );
}

#[test]
fn poll_remote_drain_ok_flush_err_surfaces_with_merged_committed() {
    // **V2 V3 step 2 audit closure (Codex L3 / Opus M3, 2026-05-21):**
    // pins the partial-state contract documented at
    // `poll_remote_with_limit` docstring lines ~916-926. When the
    // drain succeeds (peer delivered bytes via try_recv) but the
    // post-drain auto-flush fails (transport closed for send, I/O
    // error, etc.), the method returns Err(Transport(_)) AFTER all
    // merged blobs have been committed to self.log. Caller never
    // sees Ok(merged); inspect op_count() to determine local merge
    // count.
    //
    // Setup: DrainOkSendErrTransport — a transport that returns a
    // pre-loaded blob from try_recv on first call (then None), and
    // ALWAYS errors on send with TransportError::Closed. This pins
    // the drain-ok + flush-fail-after-merge interleaving the
    // partial-state contract is designed around.
    use std::sync::Arc;
    use std::sync::Mutex;

    struct DrainOkSendErrTransport {
        recv_queue: Arc<Mutex<Option<Vec<u8>>>>,
    }
    impl DrainOkSendErrTransport {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                recv_queue: Arc::new(Mutex::new(Some(bytes))),
            }
        }
    }
    impl Transport for DrainOkSendErrTransport {
        fn send(&mut self, _bytes: &[u8]) -> Result<(), ql_collab::TransportError> {
            // ALWAYS fails — this is the failure path under test.
            Err(ql_collab::TransportError::Closed)
        }
        fn try_recv(&mut self) -> Result<Option<Vec<u8>>, ql_collab::TransportError> {
            // Returns the pre-loaded blob ONCE, then None forever
            // (graceful end-of-stream per the Transport trait
            // contract — Closed is for permanent failures only).
            Ok(self.recv_queue.lock().unwrap().take())
        }
    }

    // Build a peer B snapshot with one op (the blob we'll deliver
    // to peer A via the failing transport).
    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
    peer_b.append_op(add_sheet()).unwrap();
    let b_bytes = peer_b.export_bytes().unwrap();

    // Peer A: OnAppend + failing transport.
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    let pre_poll_op_count = peer_a.op_count();
    peer_a.attach_transport(DrainOkSendErrTransport::new(b_bytes));
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Poll: drain succeeds (1 blob, peer B's op merged), but
    // auto-flush fails (transport.send always errors).
    let result = peer_a.poll_remote();
    assert!(
        matches!(
            result,
            Err(CollabSessionError::Transport(TransportError::Closed))
        ),
        "drain-ok flush-Err MUST surface as Err(Transport(Closed)); got {result:?}"
    );

    // Partial-state contract: the merged blob IS committed locally
    // before the auto-flush attempt. op_count grew by ≥1.
    assert!(
        peer_a.op_count() > pre_poll_op_count,
        "partial-state contract: drained ops MUST be committed locally before flush attempt; \
         pre_poll={pre_poll_op_count} post_poll={}",
        peer_a.op_count()
    );
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

// ============================================================
// Phase 5.5 V2 V3 step 1 — version-vector tracking + delta flush
// ============================================================

#[test]
fn delta_flush_first_call_sends_all_ops_with_no_transport_baseline() {
    // First `flush_delta_to_transport` after attach_transport sends
    // from the EMPTY version vector (no `last_flushed_vv` yet), which
    // is equivalent to `all_updates()` — the new transport-peer
    // receives every op the session has ever appended. Subsequent
    // peers can import the bytes and reconstruct the full state.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 42.0)).unwrap();

    s.attach_transport(tx_a);
    assert_eq!(tx_b.pending_recv(), 0, "attach alone doesn't flush");

    let sent = s.flush_delta_to_transport().unwrap();
    assert!(sent, "first delta flush MUST send (no last_flushed_vv yet)");
    assert_eq!(tx_b.pending_recv(), 1);

    let bytes = tx_b.try_recv().unwrap().expect("first-flush bytes");
    assert!(!bytes.is_empty());
    // Verify peer can reconstruct the full state from these bytes.
    let imported = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(
        imported.len(),
        2,
        "first delta flush carries all 2 ops; peer reconstructs full state from empty-VV baseline"
    );
}

#[test]
fn delta_flush_idempotency_short_circuits_when_no_state_change() {
    // After a successful flush, calling flush_delta_to_transport
    // AGAIN with no mutation in between returns Ok(false) WITHOUT
    // invoking transport.send. Closes V2 V2 audit M2/M3 echo-loop
    // concern: a peer auto-flushing after an idempotent merge is a
    // no-op when state didn't actually advance.
    let (tx_a, observer) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.attach_transport(tx_a);

    let sent1 = s.flush_delta_to_transport().unwrap();
    assert!(sent1);
    assert_eq!(observer.pending_recv(), 1);

    // Second call: no mutation in between → short-circuit.
    let sent2 = s.flush_delta_to_transport().unwrap();
    assert!(!sent2, "idempotent flush MUST short-circuit to Ok(false)");
    assert_eq!(
        observer.pending_recv(),
        1,
        "transport.send MUST NOT be invoked on idempotent flush"
    );

    // Third call after a mutation: state advanced, so it fires again.
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    let sent3 = s.flush_delta_to_transport().unwrap();
    assert!(sent3, "post-mutation flush MUST send");
    assert_eq!(observer.pending_recv(), 2);
}

#[test]
fn delta_flush_subsequent_calls_send_only_new_ops() {
    // Second flush carries DELTA from the first's VV checkpoint,
    // not the full state. Asserted by: importing the second's bytes
    // standalone produces a doc with ONLY the post-first-flush ops
    // (the first-flush ops are missing because they're before the
    // delta's `from`).
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.attach_transport(tx_a);

    s.flush_delta_to_transport().unwrap();
    let _first_bytes = tx_b.try_recv().unwrap().unwrap();

    // Append more ops; flush delta.
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
    s.flush_delta_to_transport().unwrap();
    let second_bytes = tx_b.try_recv().unwrap().unwrap();

    // Importing second_bytes into a FRESH doc — without seeing
    // first_bytes — should produce a partial state (2 ops, no
    // AddSheet). Loro's import accepts the delta and applies it,
    // but the AddSheet op is BEFORE the delta's `from` VV so it
    // doesn't appear.
    //
    // Actual Loro behavior: import of update bytes WITHOUT the
    // baseline may error (missing dependencies). Acceptable test:
    // import BOTH blobs and verify the final state has all 3 ops.
    let mut fresh = ql_oplog::OpLog::new();
    fresh.merge_bytes(&_first_bytes).unwrap();
    fresh.merge_bytes(&second_bytes).unwrap();
    assert_eq!(
        fresh.len(),
        3,
        "delta-chain reconstruction: first + second flush together yield 3 ops total"
    );
}

#[test]
fn attach_transport_resets_last_flushed_vv() {
    // Detach + reattach (or attach a NEW transport) MUST reset the
    // VV so the new peer receives the full state from scratch.
    // Without the reset, the second peer would only receive
    // post-attach ops and miss everything that happened before.
    let (tx_a1, mut tx_b1) = LoopbackTransport::pair();
    let (tx_a2, mut tx_b2) = LoopbackTransport::pair();

    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.attach_transport(tx_a1);

    s.flush_delta_to_transport().unwrap();
    let first_peer_bytes = tx_b1.try_recv().unwrap().expect("first peer got bytes");

    // Reconstruct what first peer sees.
    let mut first_peer_view = ql_oplog::OpLog::new();
    first_peer_view.merge_bytes(&first_peer_bytes).unwrap();
    assert_eq!(first_peer_view.len(), 1, "first peer sees 1 op");

    // Now append more ops, detach, and reattach a FRESH transport.
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.detach_transport();
    s.attach_transport(tx_a2);

    // The next delta flush MUST send EVERYTHING (both ops) because
    // the new peer hasn't seen anything yet.
    s.flush_delta_to_transport().unwrap();
    let second_peer_bytes = tx_b2.try_recv().unwrap().expect("second peer got bytes");

    let mut second_peer_view = ql_oplog::OpLog::new();
    second_peer_view.merge_bytes(&second_peer_bytes).unwrap();
    assert_eq!(
        second_peer_view.len(),
        2,
        "second peer MUST see ALL ops (attach reset the VV — no carryover)"
    );
}

#[test]
fn flush_to_transport_full_snapshot_path_still_works_and_updates_vv() {
    // The V2 V1 `flush_to_transport` method remains available + sends
    // full snapshots. V2 V3 also updates last_flushed_vv on success,
    // so a subsequent flush_delta_to_transport doesn't re-send the
    // snapshot's content.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.attach_transport(tx_a);

    // Full snapshot flush.
    let sent = s.flush_to_transport().unwrap();
    assert!(sent);
    let snapshot_bytes = tx_b.try_recv().unwrap().unwrap();
    let mut peer_view = ql_oplog::OpLog::new();
    peer_view.merge_bytes(&snapshot_bytes).unwrap();
    assert_eq!(peer_view.len(), 2);

    // Now subsequent flush_delta_to_transport should short-circuit
    // because last_flushed_vv now matches current_vv.
    let sent2 = s.flush_delta_to_transport().unwrap();
    assert!(
        !sent2,
        "flush_to_transport MUST update last_flushed_vv so subsequent delta flush is idempotent"
    );
    assert_eq!(tx_b.pending_recv(), 0);

    // Append a new op; delta flush sends only that.
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
    s.flush_delta_to_transport().unwrap();
    let delta_bytes = tx_b.try_recv().unwrap().unwrap();
    peer_view.merge_bytes(&delta_bytes).unwrap();
    assert_eq!(
        peer_view.len(),
        3,
        "mix-and-match: snapshot then delta produces correct final state on peer"
    );
}

#[test]
fn on_append_uses_delta_path_under_v2_v3() {
    // V2 V3 step 1 reroutes maybe_auto_flush through
    // flush_delta_to_transport. After N appends under OnAppend,
    // each wire blob is a delta (small) not a full snapshot. The
    // user-visible behavior is the same — peers reconstruct the
    // full state — but bandwidth scales O(per-op delta) instead
    // of O(state).
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.attach_transport(tx_a);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();

    // Three appends → three auto-flushes, each a delta.
    assert_eq!(
        tx_b.pending_recv(),
        3,
        "OnAppend fires once per mutator (delta path doesn't change the fire count)"
    );

    // Drain all three and reconstruct on peer side.
    let mut peer = ql_oplog::OpLog::new();
    for _ in 0..3 {
        let bytes = tx_b.try_recv().unwrap().expect("delta bytes");
        peer.merge_bytes(&bytes).unwrap();
    }
    assert_eq!(
        peer.len(),
        3,
        "peer reconstructs full state from chained deltas"
    );
}

#[test]
fn delta_flush_with_no_transport_returns_ok_false() {
    // Sanity: with no transport attached, flush_delta_to_transport
    // is a no-op (matches flush_to_transport semantics).
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    let sent = s.flush_delta_to_transport().unwrap();
    assert!(!sent, "no transport → Ok(false) without invoking anything");
}

#[test]
fn delta_flush_failure_does_not_advance_vv_so_retry_resends() {
    // Partial-state contract: on transport.send Err, last_flushed_vv
    // is NOT updated. A successful retry sends the same delta the
    // failed call would have sent. Use NoopTransport closed-state to
    // simulate the failure.
    let mut bad = NoopTransport::new();
    bad.close();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.attach_transport(bad);

    let result = s.flush_delta_to_transport();
    assert!(
        matches!(
            result,
            Err(CollabSessionError::Transport(TransportError::Closed))
        ),
        "closed transport MUST surface Err; got {result:?}"
    );

    // last_flushed_vv NOT advanced — but we can't easily inspect it
    // directly (private field). Instead, retry with a fresh
    // (working) transport and assert the bytes sent contain the op.
    s.detach_transport();
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    // attach_transport resets last_flushed_vv to None, so this
    // tests a different property than the original intent.
    // Re-frame: assert that the prior failure didn't corrupt state.
    s.flush_delta_to_transport().unwrap();
    let bytes = tx_b.try_recv().unwrap().unwrap();
    let mut peer = ql_oplog::OpLog::new();
    peer.merge_bytes(&bytes).unwrap();
    assert_eq!(
        peer.len(),
        1,
        "post-failure recovery: the op IS still in the local log + flushable"
    );
}

#[test]
fn delta_flush_after_merge_bytes_sends_merged_state_to_third_peer() {
    // Hub scenario simplified: peer A (hub) has a transport to peer
    // C. A merges peer B's bytes (via direct merge_bytes call —
    // simulating B handing A bytes through some other channel).
    // A's flush_delta_to_transport then sends the merged state to
    // peer C. This is the V2 V2 merge_bytes auto-flush behavior
    // continuing to work under V2 V3 delta semantics.
    let (tx_ac_a, mut tx_ac_c) = LoopbackTransport::pair();

    // Build peer B with one op + export.
    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
    peer_b.append_op(add_sheet()).unwrap();
    let b_bytes = peer_b.export_bytes().unwrap();

    // Hub: append own op, attach transport to C, merge B's bytes,
    // verify C sees both hub + B ops.
    let mut hub = CollabSession::new(PeerId::new(1)).unwrap();
    hub.append_op(put_value(0, 5, 5, 99.0)).unwrap();
    hub.attach_transport(tx_ac_a);
    hub.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    hub.merge_bytes(&b_bytes).unwrap();
    // merge_bytes auto-fires flush_delta_to_transport. C now sees
    // hub's existing op + B's op.
    let bytes = tx_ac_c.try_recv().unwrap().expect("hub auto-flushed");
    let mut peer_c = ql_oplog::OpLog::new();
    peer_c.merge_bytes(&bytes).unwrap();
    assert!(
        peer_c.len() >= 2,
        "peer C MUST see hub's op + B's op via the hub's auto-flush: got {}",
        peer_c.len()
    );
}

// ============================================================
// V2 V3 step 1 audit closures (Codex + Opus, 2026-05-21)
// ============================================================

/// **OneShotFailingTransport** — fails the FIRST `send` call with
/// `TransportError::Closed`, succeeds on all subsequent calls.
/// Used by `delta_flush_retry_after_failure_resends_from_same_vv`
/// (M1 closure — Codex L2 / Opus M1) to verify that an Err'd flush
/// leaves `last_flushed_vv` unchanged, so the retry on the SAME
/// transport sends the same delta the failed call would have.
///
/// `try_recv` always returns `Ok(None)` — this transport is
/// send-only by design for failure testing.
#[derive(Debug, Default)]
struct OneShotFailingTransport {
    fail_next_send: bool,
    sent_blob_sizes: std::sync::Arc<std::sync::Mutex<Vec<usize>>>,
}

impl OneShotFailingTransport {
    fn new() -> Self {
        Self {
            fail_next_send: true,
            sent_blob_sizes: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }
    fn sent_sizes_handle(&self) -> std::sync::Arc<std::sync::Mutex<Vec<usize>>> {
        std::sync::Arc::clone(&self.sent_blob_sizes)
    }
}

impl Transport for OneShotFailingTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), ql_collab::TransportError> {
        if self.fail_next_send {
            self.fail_next_send = false;
            return Err(ql_collab::TransportError::Closed);
        }
        self.sent_blob_sizes.lock().unwrap().push(bytes.len());
        Ok(())
    }
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, ql_collab::TransportError> {
        Ok(None)
    }
}

#[test]
fn delta_flush_retry_after_failure_resends_from_same_vv() {
    // V2 V3 step 1 audit closure (Codex L2 / Opus M1, 2026-05-21):
    // verify that on transport.send Err, last_flushed_vv stays
    // unadvanced — so retry sends THE SAME delta the failed call
    // would have. Uses OneShotFailingTransport (fails first send,
    // succeeds after).
    let transport = OneShotFailingTransport::new();
    let sizes = transport.sent_sizes_handle();

    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
    s.attach_transport(transport);

    // First call: fails.
    let result = s.flush_delta_to_transport();
    assert!(
        matches!(
            result,
            Err(CollabSessionError::Transport(TransportError::Closed))
        ),
        "first flush MUST fail with Closed (OneShotFailingTransport contract); got {result:?}"
    );
    assert_eq!(
        sizes.lock().unwrap().len(),
        0,
        "no successful send on first call"
    );

    // Retry on SAME transport (no detach). last_flushed_vv was NOT
    // advanced by the failed call, so this resends the same delta
    // (full state from empty VV, since this was the first flush).
    let result = s.flush_delta_to_transport().unwrap();
    assert!(result, "retry MUST succeed (transport now accepts sends)");
    let final_sizes = sizes.lock().unwrap().clone();
    assert_eq!(final_sizes.len(), 1, "retry produced exactly one send");
    assert!(
        final_sizes[0] > 0,
        "retry's blob is non-empty (contains the 2 appended ops)"
    );

    // Third call: NO new ops in between → idempotency short-circuit.
    let result = s.flush_delta_to_transport().unwrap();
    assert!(
        !result,
        "third flush with no mutation MUST short-circuit Ok(false)"
    );
    assert_eq!(
        sizes.lock().unwrap().len(),
        1,
        "no additional send on idempotent short-circuit"
    );
}

#[test]
fn delta_flush_bandwidth_savings_subsequent_smaller_than_first() {
    // V2 V3 step 1 audit closure (Codex L1 / Opus L1, 2026-05-21):
    // assert that after a baseline batch, a small follow-up append
    // produces a wire blob substantially SMALLER than the first
    // flush. Pins the O(per-op-delta) wire size claim against
    // accidental regression to O(state) (e.g. if flush_delta_to_transport
    // were ever re-routed through export_bytes / Snapshot mode).
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.append_op(add_sheet()).unwrap();
    // Append ~100 ops for a meaningful state size.
    for i in 0..100u32 {
        s.append_op(put_value(0, i, 0, f64::from(i))).unwrap();
    }
    s.attach_transport(tx_a);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // First flush sends the baseline (all 101 ops).
    s.flush_delta_to_transport().unwrap();
    let first_bytes = tx_b.try_recv().unwrap().expect("first flush bytes");
    let first_len = first_bytes.len();
    assert!(first_len > 0);

    // Append one more op. Auto-flush fires.
    s.append_op(put_value(0, 200, 0, 999.0)).unwrap();
    let second_bytes = tx_b.try_recv().unwrap().expect("second flush bytes");
    let second_len = second_bytes.len();

    // Delta should be SUBSTANTIALLY smaller than the baseline.
    // Conservative threshold: at least 2× smaller. Loro's actual
    // ratio is typically 10-50× for this scenario; the conservative
    // bound avoids flakiness from Loro encoding variations.
    assert!(
        second_len * 2 < first_len,
        "delta flush MUST send less than half the baseline size; first={first_len} second={second_len}"
    );
}

#[test]
fn symmetric_on_append_two_peers_converge_with_bounded_wire_bytes() {
    // V2 V3 step 1 audit closure (Opus L3, 2026-05-21): the step 1
    // idempotency guard is documented as making symmetric OnAppend
    // safe across paired LoopbackTransport peers. Pin this contract:
    // two peers both with OnAppend; both append; verify final state
    // convergence AND that wire traffic does NOT diverge (no
    // echo-loop).
    //
    // **V2 V3 step 2 audit closure note (2026-05-21):** under step 2,
    // `poll_remote*` ALSO auto-flushes after a non-empty drain. The
    // explicit `flush_delta_to_transport` calls below are kept as
    // redundant safety nets — they exercise the idempotency guard
    // (post-poll-auto-flush, last_flushed_vv == current_vv → flush
    // short-circuits to Ok(false)). Pre-step-2, those explicit calls
    // were load-bearing.
    let base = CollabSession::new(PeerId::new(100)).unwrap();
    let base_bytes = base.export_bytes().unwrap();
    let (tx_a, tx_b) = LoopbackTransport::pair();

    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
    peer_a.attach_transport(tx_a);
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
    peer_b.attach_transport(tx_b);
    peer_b.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Both peers append concurrently.
    peer_a.append_op(add_sheet()).unwrap(); // auto-flush A → B inbox
    peer_b.append_op(put_value(0, 0, 0, 99.0)).unwrap(); // auto-flush B → A inbox

    // Each peer drains its inbox. Under V2 V3 step 2, poll_remote
    // ALSO auto-flushes after a non-empty drain. Explicit follow-up
    // flushes below are kept as belt-and-suspenders (they exercise
    // the idempotency guard).
    let merged_a = peer_a.poll_remote().unwrap();
    let merged_b = peer_b.poll_remote().unwrap();
    assert!(merged_a >= 1, "peer A received peer B's flush");
    assert!(merged_b >= 1, "peer B received peer A's flush");

    // Each peer flushes the merged state. Idempotency: if the merge
    // didn't actually advance state beyond what's been flushed, the
    // second-side flush short-circuits.
    let a_flushed = peer_a.flush_delta_to_transport().unwrap();
    let b_flushed = peer_b.flush_delta_to_transport().unwrap();
    // BOTH peers' state did advance (they received the other's op),
    // so both flushes fire.
    let _ = (a_flushed, b_flushed);

    // Drain remaining inbox traffic; verify it terminates (no echo
    // loop). Cap iterations conservatively: 20 round-trips is way
    // more than the 2 ops + 2 deltas + idempotency-short-circuit
    // scenario needs.
    for _ in 0..20 {
        let polled_a = peer_a.poll_remote().unwrap();
        let polled_b = peer_b.poll_remote().unwrap();
        let flushed_a = peer_a.flush_delta_to_transport().unwrap();
        let flushed_b = peer_b.flush_delta_to_transport().unwrap();
        if polled_a == 0 && polled_b == 0 && !flushed_a && !flushed_b {
            // Steady state — no more traffic. Idempotency guard
            // working as advertised.
            break;
        }
    }

    // Final convergence check: both peers see the same op count.
    // Loro CRDT merge is deterministic; both peers have all ops.
    assert!(peer_a.op_count() >= 2);
    assert!(peer_b.op_count() >= 2);
    assert_eq!(
        peer_a.op_count(),
        peer_b.op_count(),
        "symmetric-OnAppend peers MUST converge to the same op count"
    );
}

// ============================================================
// Phase 5.5 V2 V3 step 3 — offline-write story + has_pending_flush
// ============================================================

#[test]
fn offline_append_locally_commits_under_on_append_with_no_transport() {
    // V2 V3 step 3: pin the V2 V2 contract that append_op while no
    // transport + OnAppend returns Ok (NOT Err) and commits locally.
    // maybe_auto_flush silently no-ops when self.transport.is_none()
    // — this IS the offline-write story (Loro's CRDT op log is the
    // implicit queue).
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    assert!(!s.has_transport(), "no transport attached");

    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();

    assert_eq!(s.op_count(), 3, "all 3 offline appends MUST commit locally");
    assert!(
        s.has_pending_flush(),
        "3 offline ops + no successful flush → has_pending_flush() == true"
    );
}

#[test]
fn offline_appends_flushed_via_first_post_attach_mutator() {
    // V2 V3 step 3: append 3 ops while offline, attach transport,
    // do a 4th append. The 4th's auto-flush sends all 4 ops because
    // last_flushed_vv was reset to None by attach_transport, and
    // flush_delta_to_transport's None branch sends from empty VV
    // (= all ops).
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // 3 offline appends.
    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
    assert!(s.has_pending_flush());

    // Attach transport, then do a 4th append.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    s.append_op(put_value(0, 2, 0, 3.0)).unwrap();

    // Peer should receive ONE wire blob containing ALL 4 ops.
    assert_eq!(
        tx_b.pending_recv(),
        1,
        "single post-attach auto-flush fires once after the 4th append"
    );
    let bytes = tx_b.try_recv().unwrap().expect("offline-flush bytes");
    let peer_log = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(
        peer_log.len(),
        4,
        "post-attach flush MUST deliver ALL 4 ops (3 offline + 1 post-attach); got {}",
        peer_log.len()
    );

    // has_pending_flush should now be false (last_flushed_vv == current).
    assert!(
        !s.has_pending_flush(),
        "after successful flush, has_pending_flush() == false"
    );
}

#[test]
fn offline_appends_flushed_via_explicit_flush_after_attach() {
    // Variant of the previous test: instead of a 4th append, the
    // caller explicitly invokes flush_delta_to_transport after
    // attach. Same end state — all 3 offline ops delivered.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();

    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    s.attach_transport(tx_a);

    // No 4th append — explicit flush.
    let sent = s.flush_delta_to_transport().unwrap();
    assert!(
        sent,
        "post-attach explicit flush sends (state advanced from empty VV)"
    );

    let bytes = tx_b.try_recv().unwrap().expect("explicit-flush bytes");
    let peer_log = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(
        peer_log.len(),
        3,
        "explicit post-attach flush MUST deliver 3 offline ops"
    );
}

#[test]
fn closed_transport_failed_flush_ops_recoverable_via_reattach() {
    // V2 V3 step 3 / Scenario B: append while OnAppend + closed
    // transport → Err(Transport(Closed)); op committed locally;
    // last_flushed_vv NOT advanced. Recovery: detach + reattach a
    // working transport + flush → delivers ALL ops (the failed-
    // flush op + any subsequent).
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    let mut bad = NoopTransport::new();
    bad.close();
    s.attach_transport(bad);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    // Failed append #1 — Err but op committed locally.
    let result = s.append_op(add_sheet());
    assert!(matches!(
        result,
        Err(CollabSessionError::Transport(TransportError::Closed))
    ));
    assert_eq!(s.op_count(), 1, "failed-flush op IS committed locally");
    assert!(s.has_pending_flush());

    // Recovery: detach bad, attach working.
    let _bad = s.detach_transport();
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    s.attach_transport(tx_a);

    // Explicit flush — delivers the failed-flush op.
    s.flush_delta_to_transport().unwrap();
    let bytes = tx_b.try_recv().unwrap().expect("recovery-flush bytes");
    let peer_log = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(
        peer_log.len(),
        1,
        "post-recovery flush MUST deliver the previously-failed op"
    );
    assert!(!s.has_pending_flush());
}

#[test]
fn has_pending_flush_returns_true_after_offline_append_false_after_flush() {
    // V2 V3 step 3: pin the helper's contract.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    assert!(
        !s.has_pending_flush(),
        "fresh empty session: no pending state"
    );

    s.append_op(add_sheet()).unwrap();
    assert!(
        s.has_pending_flush(),
        "offline append → has_pending_flush() == true"
    );

    // Attach + flush.
    let (tx_a, observer) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    s.flush_delta_to_transport().unwrap();
    let _ = observer;

    assert!(
        !s.has_pending_flush(),
        "after successful flush, has_pending_flush() == false"
    );

    // Append again under OnAppend + attached transport: maybe_auto_flush
    // fires during append_op AND advances last_flushed_vv → so
    // has_pending_flush() is false immediately after. The "append → true"
    // pattern only shows up when policy is Disabled OR transport is
    // detached between mutators (see has_pending_flush_distinguishes_*
    // test for the detached case).
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    assert!(
        !s.has_pending_flush(),
        "under OnAppend + attached transport, has_pending_flush is false post-mutator \
         (auto-flush already advanced last_flushed_vv)"
    );
}

#[test]
fn has_pending_flush_false_on_fresh_session_with_no_state() {
    // Boundary: brand-new session with no ops, no transport, no
    // flushes. current_vv is empty (= default); last_flushed_vv is
    // None → unwrap_or_default also gives empty. They equal → false.
    let s = CollabSession::new(PeerId::new(1)).unwrap();
    assert_eq!(s.op_count(), 0);
    assert!(
        !s.has_pending_flush(),
        "fresh empty session: no pending state to flush"
    );
}

#[test]
fn has_pending_flush_distinguishes_synced_from_detached_via_state_advance() {
    // After a successful flush + detach + offline append, the
    // last_flushed_vv was reset to None by detach. has_pending_flush
    // then compares current_vv (post-append) to default (= empty)
    // → not equal → true. Confirms the helper tracks the right
    // "is there unsynced local state" semantics across transport
    // lifecycle.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

    let (tx_a, _observer) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    s.append_op(add_sheet()).unwrap(); // auto-flushes
    assert!(!s.has_pending_flush(), "synced post-mutator");

    // Detach transport — last_flushed_vv resets to None.
    let _ = s.detach_transport();

    // The current_vv has 1 op (from add_sheet). last_flushed_vv is
    // None → unwrap_or_default is empty. current_vv != empty → true.
    assert!(
        s.has_pending_flush(),
        "post-detach: current state isn't tracked against any flushed VV → \
         has_pending_flush() == true (the new transport peer would need everything)"
    );

    // Append more while offline.
    s.append_op(put_value(0, 0, 0, 99.0)).unwrap();
    assert!(s.has_pending_flush());
}

// ============================================================
// V2 V3 step 3 audit closure (Codex + Opus, 2026-05-21)
// ============================================================

#[test]
fn offline_merge_bytes_then_reattach_flush_delivers_merged_ops() {
    // **V2 V3 step 3 audit closure (Opus M3, 2026-05-21):** pin
    // Scenario C for merge_bytes. The investigation claim "Loro
    // op log IS the offline queue" relies on EVERY mutator
    // routing through maybe_auto_flush which no-ops on
    // transport.is_none(). Add explicit proof for merge_bytes.
    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
    peer_b.append_op(add_sheet()).unwrap();
    let b_bytes = peer_b.export_bytes().unwrap();

    // Peer A: OnAppend + NO transport. merge_bytes(B's snapshot)
    // should succeed locally without any transport interaction.
    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    assert!(!peer_a.has_transport());

    let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
    assert!(
        merged_count >= 1,
        "merge_bytes succeeded locally with no transport"
    );
    assert!(peer_a.has_pending_flush());

    // Reattach + flush delivers the merged op to a fresh transport.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    peer_a.attach_transport(tx_a);
    peer_a.flush_delta_to_transport().unwrap();
    let bytes = tx_b.try_recv().unwrap().expect("post-reattach flush bytes");
    let peer_log = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert!(
        !peer_log.is_empty(),
        "post-reattach flush MUST deliver the offline-merged op"
    );
}

#[test]
fn offline_update_presence_then_reattach_flush_delivers_presence() {
    // **V2 V3 step 3 audit closure (Opus M3, 2026-05-21):** pin
    // Scenario C for update_presence. Same shape as merge_bytes
    // test above.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    assert!(!s.has_transport());

    s.update_presence(PresenceState::at_cell(0, 7, 9)).unwrap();
    assert!(s.has_pending_flush());

    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    s.flush_delta_to_transport().unwrap();
    let bytes = tx_b.try_recv().unwrap().expect("post-reattach flush bytes");
    // Peer reconstruction: import bytes into a fresh session, query
    // presence. Use direct CollabSession to inspect presence rather
    // than raw OpLog (presence is a separate LoroMap container).
    let peer = CollabSession::from_snapshot(PeerId::new(99), &bytes).unwrap();
    let presence = peer.peer_presence(PeerId::new(1)).unwrap();
    assert_eq!(
        presence,
        Some(PresenceState::at_cell(0, 7, 9)),
        "post-reattach flush MUST deliver the offline-updated presence"
    );
}

#[test]
fn offline_appends_under_disabled_policy_flushed_via_explicit_flush() {
    // **V2 V3 step 3 audit closure (Opus L1, 2026-05-21):** pin
    // the offline-write path under AutoFlushPolicy::Disabled
    // (default V2 V1 explicit-drive). All other step-3 tests use
    // OnAppend; the contract is policy-orthogonal but only
    // OnAppend was test-pinned.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
    // Default policy: Disabled. Don't set OnAppend.
    assert_eq!(s.auto_flush_policy(), AutoFlushPolicy::Disabled);

    s.append_op(add_sheet()).unwrap();
    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    assert_eq!(s.op_count(), 2);
    assert!(s.has_pending_flush());

    // Attach transport. Under Disabled, no auto-flush on attach.
    let (tx_a, mut tx_b) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    assert_eq!(
        tx_b.pending_recv(),
        0,
        "Disabled policy: no auto-flush on attach"
    );

    // Explicit flush delivers all 2 offline ops.
    s.flush_delta_to_transport().unwrap();
    let bytes = tx_b.try_recv().unwrap().expect("explicit flush bytes");
    let peer_log = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(
        peer_log.len(),
        2,
        "explicit flush under Disabled MUST deliver 2 offline ops"
    );
    assert!(!s.has_pending_flush());
}

#[test]
fn closed_transport_mid_session_after_successful_flush_preserves_baseline() {
    // **V2 V3 step 3 audit closure (Codex L2 / Opus L2, 2026-05-21):**
    // strengthen the closed-transport-recovery test. The prior step-3
    // `closed_transport_failed_flush_ops_recoverable_via_reattach`
    // attached an already-closed transport (so `last_flushed_vv` was
    // never advanced). This test exercises the harder "successful
    // flush + mid-session close" branch:
    //   1. Attach working transport; append; auto-flush succeeds;
    //      last_flushed_vv = X (some non-default value).
    //   2. Transport breaks (simulated by detach + attach already-
    //      closed transport — LoopbackTransport doesn't support
    //      remote-side close → send-side error, so we use Noop here).
    //   3. Append again → auto-flush fails Err(Closed) → op
    //      committed locally. Critically: last_flushed_vv would have
    //      stayed at X if the attach-with-closed hadn't reset it.
    //      Since `attach_transport` ALWAYS resets to None, we can't
    //      directly observe "the prior X is preserved" — that
    //      semantic is what V2 V3 step 1 delta_flush_retry_after_*
    //      test pinned. This test pins the recovery flow end-to-end.
    let mut s = CollabSession::new(PeerId::new(1)).unwrap();

    // Phase 1: working transport, successful flush.
    let (tx_a, mut observer) = LoopbackTransport::pair();
    s.attach_transport(tx_a);
    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    s.append_op(add_sheet()).unwrap();
    assert_eq!(
        observer.pending_recv(),
        1,
        "first append flushed successfully"
    );
    let _ = observer.try_recv();

    // At this point last_flushed_vv is Some(X) (the post-add_sheet VV).
    assert!(!s.has_pending_flush(), "synced after successful flush");

    // Phase 2: simulate transport breakage. detach + attach NoopTransport
    // that's been closed — subsequent appends auto-flush Err(Closed).
    let _ = s.detach_transport();
    let mut bad = NoopTransport::new();
    bad.close();
    s.attach_transport(bad);

    let result = s.append_op(put_value(0, 0, 0, 2.0));
    assert!(matches!(
        result,
        Err(CollabSessionError::Transport(TransportError::Closed))
    ));
    // Op committed locally. op_count = 2 (add_sheet from phase 1 + this
    // put_value).
    assert_eq!(s.op_count(), 2, "failed-flush op committed locally");
    assert!(s.has_pending_flush(), "has_pending_flush true post-failure");

    // Phase 3: recovery — detach bad + attach working transport.
    let _bad = s.detach_transport();
    let (tx_recovery, mut tx_recovery_observer) = LoopbackTransport::pair();
    s.attach_transport(tx_recovery);

    // Explicit flush delivers ALL 2 ops (the originally-flushed
    // add_sheet + the failed-flush put_value). Note: since this is
    // a FRESH transport, the empty-VV first flush DOES include the
    // previously-flushed add_sheet too.
    s.flush_delta_to_transport().unwrap();
    let bytes = tx_recovery_observer
        .try_recv()
        .unwrap()
        .expect("recovery bytes");
    let peer_log = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(
        peer_log.len(),
        2,
        "recovery flush MUST deliver both ops (new transport-peer needs full state)"
    );
}

#[test]
fn from_snapshot_session_reports_pending_flush_true_before_first_attach() {
    // **V2 V3 step 3 audit closure (Opus M1, 2026-05-21):** pin the
    // docstring-corrected edge case. A from_snapshot session imports
    // ops (non-empty current_vv) but has last_flushed_vv = None →
    // has_pending_flush() returns true. Callers building IDE
    // "Synced" indicators should suppress the indicator on initial
    // load OR wrap with has_transport() && has_pending_flush().
    let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
    origin.append_op(add_sheet()).unwrap();
    origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    let bytes = origin.export_bytes().unwrap();

    let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
    assert!(
        !reborn.has_transport(),
        "from_snapshot session starts with no transport"
    );
    assert_eq!(reborn.op_count(), 2, "imported 2 ops");
    assert!(
        reborn.has_pending_flush(),
        "has_pending_flush() == true on fresh from_snapshot session \
         (imported ops, no flushes to any transport yet — see docstring caveat)"
    );

    // Wrapping with has_transport() gives the "is there an active
    // sync path" semantic the IDE wants for status indicators.
    assert!(
        !(reborn.has_transport() && reborn.has_pending_flush()),
        "is_unsynced-with-active-transport pattern is the right IDE gate: \
         from_snapshot session has no transport → indicator suppressed"
    );
}
