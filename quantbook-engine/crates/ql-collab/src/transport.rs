//! `Transport` trait — wire-byte channel for Phase 5 collaboration.
//!
//! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
//! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
//! shipped — in-process paired endpoints for 2-peer tests.
//! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
//! `CollabSession` exposes 5 typed transport methods
//! (`attach_transport` / `detach_transport` / `has_transport` /
//! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
//! V2 V1 is "explicit drive" — caller invokes flush + poll on a
//! tick.
//! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
//! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
//! after every mutator. Default is `Disabled` (V2 V1 behavior
//! preserved). See [`crate::AutoFlushPolicy`] +
//! [`crate::CollabSession::set_auto_flush_policy`].
//! **Phase 5.5 V2 V3 step 1 (2026-05-21):** version-vector tracking
//! for the **currently attached** transport baseline + delta flushes.
//! `CollabSession::flush_delta_to_transport` sends only the delta
//! since the last successful flush via `LoroDoc::ExportMode::Updates`.
//! Auto-flush routes through this delta path — wire payload is
//! O(per-op delta) instead of O(full state). Idempotency
//! short-circuit (no state change → no send) closes the V2 V2
//! echo-loop concern. The checkpoint is
//! per-session-currently-attached-transport, NOT per-transport-
//! identity (`attach_transport` resets the baseline).
//! **Phase 5.5 V2 V3 step 2 (2026-05-21):** wires `poll_remote*`
//! into auto-flush. After a successful drain (`merged > 0`), one
//! auto-flush fires per call (not per-blob — bandwidth-efficient).
//! V2 V3 step 1's idempotency guard prevents echo loops: drained
//! bytes that Loro dedupes leave the VV unchanged → flush
//! short-circuits to `Ok(false)`. 3-peer hub-fanout pattern now
//! works automatically under `OnAppend`.
//! **Phase 5.5 V2 V3 step 3 (2026-05-21):** offline-write story.
//! Investigation showed no explicit queue is needed: Loro's CRDT op
//! log IS the implicit offline queue. Append while no transport
//! attached → `maybe_auto_flush` no-ops; op committed locally. On
//! reattach: `attach_transport` resets `last_flushed_vv = None`; the
//! next mutator (or explicit `flush_delta_to_transport`) sends from
//! empty VV — delivers ALL accumulated ops including offline ones.
//! Adds `has_pending_flush() -> bool` ergonomic helper (compares
//! current VV vs last-flushed VV). 7 new integration tests pin the
//! offline-write contract.
//!
//! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
//! production-grade `Transport` impl ships as a separate crate,
//! `ql-collab-ws::WebSocketTransport`. Bridges async
//! tokio-tungstenite to the sync `Transport` trait via
//! `tokio::sync::mpsc` channels and two spawned background tasks
//! (reader and writer). Kept in a sibling crate so `ql-collab`
//! core stays runtime-agnostic; embedders needing only
//! `LoopbackTransport` or a custom impl don't pay for tokio. MVP
//! scope: client-only, plain `ws://`, NO TLS, NO auto-reconnect
//! (caller drives via detach and re-attach; V2 V3 step 1
//! baseline-reset contract delivers offline ops on reconnect).
//! 13 integration tests including 3 that verify the V2 V2 and
//! V2 V3 step 1-3 contracts hold over a real WebSocket. See
//! `ql-collab-ws` module docs for V1 limitations deferred to V2 V4
//! (TLS, auto-reconnect, bounded queue, server side, inbound
//! text/ping/pong frame dropping).
//!
//! **Phase 5.5 V2 V3 remaining (pending):** full-arc megaudit
//! (step 5) and exit packet (step 6).
//!
//! Tests can also use [`NoopTransport`] which discards traffic.
//!
//! The contract is intentionally minimal:
//!
//! - `send(&mut self, bytes: &[u8])` — push bytes to the channel.
//!   Bytes are an opaque blob (a Loro export). The transport
//!   doesn't interpret them.
//! - `try_recv(&mut self) -> Option<Vec<u8>>` — non-blocking
//!   receive. Returns `None` if no bytes are queued.
//!
//! That's enough to plumb a `CollabSession::export_bytes` →
//! transport → remote `CollabSession::merge_bytes` flow. The
//! transport handles framing / reliability / reconnect / auth as
//! its implementation details.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use thiserror::Error;

/// Errors emitted by `Transport` impls.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum TransportError {
    /// The underlying I/O failed (socket dead, network partition,
    /// etc.). Implementations should distinguish recoverable
    /// (reconnect) from permanent (auth rejected) failures via
    /// variant structure in their own error type, then map to this
    /// variant at the trait boundary if they don't want to expose
    /// implementation details.
    #[error("transport I/O error: {0}")]
    Io(String),

    /// The transport is closed and no further sends are accepted.
    /// Receivers should still drain any already-queued bytes via
    /// `try_recv` before considering the channel done.
    #[error("transport closed")]
    Closed,
}

/// Wire-byte channel for Phase 5 collaboration.
///
/// Implementations push and pull opaque byte blobs. The blobs ARE
/// Loro `LoroDoc::export(...)` snapshots / updates; the
/// transport doesn't interpret them. Framing (where one blob ends
/// and the next starts) is the implementation's responsibility.
pub trait Transport {
    /// Push `bytes` to the channel. Implementations may buffer
    /// internally; the call returns when the bytes are
    /// **queued for send**, not when the remote has received them.
    ///
    /// **V2 V3 step 5 megaudit closure (Codex M1 + Opus-B M1,
    /// 2026-05-21):** for buffered impls (`WebSocketTransport` and
    /// future async transports), there is a window between "send
    /// returned Ok" and "bytes on the wire" where the bytes can be
    /// silently lost (transport dropped, peer disconnect mid-flush,
    /// allocator failure during the writer task). The session's
    /// [`crate::CollabSession::flush_delta_to_transport`] advances
    /// `last_flushed_vv` immediately on `send`'s Ok return, so
    /// `has_pending_flush() == false` means "queued to the currently-
    /// attached transport," NOT "the peer has received the ops." If
    /// you need stronger delivery guarantees, the V2 V3 V1 substrate
    /// recommends: (1) keep the transport attached until you've
    /// verified peer reception out-of-band (e.g., received a
    /// peer-side ack); (2) on transport drop or `Err(Closed)`,
    /// detach + reattach a new transport — the V2 V3 step 1
    /// baseline-reset contract re-sends from empty VV. V2 V4 will
    /// add an explicit ack-channel API for true end-to-end delivery
    /// confirmation.
    ///
    /// On error, the caller should treat the byte blob as unsent
    /// and re-queue (or surface the error to the user). The
    /// transport will not retry automatically — that policy lives
    /// at the layer above (Phase 5.5 design will pick reconnect
    /// semantics).
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;

    /// Non-blocking receive. Returns `Some(bytes)` if a blob is
    /// queued, `None` otherwise. Implementations choose how often
    /// they poll the underlying channel; the contract is "if you
    /// have something, give it to me, else `None`."
    ///
    /// Returns `Err(TransportError::Closed)` only when the channel
    /// is permanently closed AND its internal queue is empty. A
    /// transient I/O failure during poll surfaces as
    /// `Err(TransportError::Io)`.
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;

    /// Read the most recent transport-internal error, if any. Default
    /// returns `None` for impls without a runtime-error concept
    /// (`NoopTransport`, `LoopbackTransport`). Buffered async impls
    /// (`WebSocketTransport`) override to expose the underlying cause
    /// of the most recent task-observed failure.
    ///
    /// **V2 V3 step 5 megaudit closure (Opus-A H1, 2026-05-21):** the
    /// V2 V3 step 4 closure added `WebSocketTransport::last_error()`
    /// on the concrete type for IDE consumers driving reconnect
    /// handshakes — but `CollabSession::attach_transport` moves the
    /// concrete type into `Box<dyn Transport + Send>`, making it
    /// unreachable. Lifting the accessor to the trait + adding
    /// [`crate::CollabSession::transport_last_error`] proxy is the
    /// minimum-viable fix: IDE callers can now distinguish "peer
    /// reset" from "auth rejected" from "capacity exceeded" without
    /// downcasting or holding a parallel handle.
    ///
    /// Returns `Option<String>` (lossy) rather than a structured
    /// error type to keep the trait minimal and avoid leaking
    /// impl-specific types (`WebSocketError`, etc.). Consumers
    /// pattern-match on substring or just display the message.
    ///
    /// Read AFTER observing [`TransportError::Closed`] from `send`
    /// or `try_recv`. Returns `None` for clean shutdowns (caller
    /// `close()`, graceful peer Close frame, transport never failed).
    fn last_error(&self) -> Option<String> {
        None
    }

    /// Block until every byte blob previously queued via `send` has
    /// been written to the underlying transport's wire (e.g. WebSocket
    /// sink). Default `Ok(())` for synchronous transports
    /// (`LoopbackTransport`, `NoopTransport`) where `send` is already
    /// wire-delivery — there is no buffer to drain.
    ///
    /// **Phase 5.5 V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
    /// Closes the V2 V3 step 5 megaudit's convergent finding (Codex M1
    /// and Opus-B M1): buffered async transports
    /// (`WebSocketTransport`) return `Ok` from `send` once bytes are
    /// queued in an mpsc channel, NOT when bytes reach the wire.
    /// Without `flush_pending`, `CollabSession::has_pending_flush()
    /// == false` would mean "queued to currently-attached transport,"
    /// not "delivered." For IDE consumers building "safe to close
    /// window?" workflows, this is a real UX hole. `flush_pending`
    /// lets callers block until the local writer has caught up,
    /// providing a level-1 ack (bytes hit `ws_sink.send`
    /// successfully). TCP-ack (level 2) and peer-application-ack
    /// (level 3) require lower-layer hooks or custom protocols
    /// respectively.
    ///
    /// # Errors
    ///
    /// - `Err(TransportError::Closed)` if the transport is closed
    ///   (either before `flush_pending` was called OR during the wait
    ///   — e.g., writer task failed mid-flush and set the closed
    ///   flag).
    /// - `Err(TransportError::Io)` for internal synchronization
    ///   failures (mutex poisoning from a panicked task).
    ///
    /// # Async-context caveat
    ///
    /// `flush_pending` is blocking-sync (uses `Condvar::wait_timeout`).
    /// Calling it from within a tokio task body will block the
    /// runtime worker. Wrap with `tokio::task::block_in_place` (on
    /// multi-thread runtimes) or `tokio::task::spawn_blocking` (on
    /// any runtime) to avoid stalling other tasks.
    fn flush_pending(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

/// No-op `Transport` impl for tests + scaffolding.
///
/// Records every `send` call in an internal `Vec` (so tests can
/// assert what would have gone over the wire) and `try_recv`
/// returns `None` forever (no incoming bytes). Suitable for tests
/// that exercise `CollabSession::append_op` without needing a
/// real channel. For 2-peer round-trip tests, use
/// [`LoopbackTransport::pair`] instead — `NoopTransport` is for
/// "I just need a Transport-shaped object" cases.
#[derive(Debug, Default)]
pub struct NoopTransport {
    /// Bytes the consumer would have pushed to the wire. Tests
    /// inspect this to verify their `CollabSession` calls emit the
    /// expected number / shape of exports.
    pub sent: Vec<Vec<u8>>,
    closed: bool,
}

impl NoopTransport {
    /// Construct a fresh `NoopTransport` with an empty `sent` log
    /// and `closed = false`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark the channel closed. Subsequent `send` calls return
    /// `TransportError::Closed`; `try_recv` returns `Closed` since
    /// nothing's queued.
    pub fn close(&mut self) {
        self.closed = true;
    }
}

impl Transport for NoopTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        self.sent.push(bytes.to_vec());
        Ok(())
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        Ok(None)
    }
}

/// **Phase 5.5 V1 (2026-05-19):** in-process paired `Transport`
/// impl for 2-peer round-trip testing.
///
/// Constructed via [`LoopbackTransport::pair`]: returns two
/// endpoints `(a, b)` where `a.send(bytes)` lands in `b`'s recv
/// queue and vice versa. The two endpoints share two
/// `Arc<Mutex<VecDeque<Vec<u8>>>>` channels via interior
/// mutability — `Send + Sync` so they can also be used across
/// threads if a future test wants that.
///
/// ## Use case
///
/// Wire two `CollabSession`s together for tests like:
/// ```ignore
/// let (mut tx_a, mut tx_b) = LoopbackTransport::pair();
/// let session_a = CollabSession::new(PeerId::new(1))?;
/// let session_b = CollabSession::new(PeerId::new(2))?;
/// // ... append ops on a, drain via tx_a.send / tx_b.try_recv ...
/// ```
///
/// **Phase 5.5 V2 V2 (2026-05-21):** `CollabSession` supports
/// opt-in auto-flush via `AutoFlushPolicy::OnAppend` — every
/// session mutator (`append_op`, `merge_bytes`, presence writes,
/// `undo` / `redo` when consumed, `sweep_presence`) then sends
/// through the attached transport automatically. Default policy
/// remains `Disabled` (V2 V1 explicit-drive behavior). Tests can
/// still drive the flow manually: append, export_bytes, send via
/// the transport, recv on the other side, merge_bytes — useful
/// when the test wants deterministic control over when bytes
/// land on the wire (e.g. ordering tests). **Phase 5.5 V2 V3 step 2
/// (2026-05-21):** `poll_remote*` now also triggers auto-flush after
/// a non-empty drain (one flush per call, not per-blob). See
/// [`crate::AutoFlushPolicy::OnAppend`] for the receive-side
/// contract.
///
/// ## Close semantics
///
/// Each endpoint has its OWN `closed` flag (separate
/// `AtomicBool`). `a.close()` shuts down endpoint A:
/// - A's `send` returns `TransportError::Closed` immediately.
/// - A's `try_recv` drains any already-queued bytes FIRST and
///   only returns `Closed` once the queue is empty (per the
///   `Transport` trait contract at the trait docstring).
/// - B is unaffected: B can still `send` (bytes land in A's
///   inbox; A drains them on the next try_recv before reporting
///   Closed) and `try_recv` (drains B's inbox).
///
/// ## Atomic ordering caveat
///
/// `close` uses `AtomicBool` with `Relaxed` ordering. For
/// cross-thread "close then send" semantics, callers must use
/// external synchronization — a thread that observes
/// `is_closed() == true` after another thread's `close()` is NOT
/// guaranteed by this transport alone (the atomic only protects
/// the flag itself, not the surrounding sequence).
pub struct LoopbackTransport {
    /// Channel WE drain via `try_recv`. The peer's `send` writes
    /// here.
    inbox: Arc<Mutex<VecDeque<Vec<u8>>>>,
    /// Channel WE write to via `send`. The peer's `try_recv`
    /// drains here.
    outbox: Arc<Mutex<VecDeque<Vec<u8>>>>,
    /// Per-endpoint close flag. Atomic so `close(&self)` doesn't
    /// need `&mut`.
    closed: AtomicBool,
}

impl std::fmt::Debug for LoopbackTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopbackTransport")
            .field(
                "inbox_len",
                &self.inbox.lock().map(|q| q.len()).unwrap_or(0),
            )
            .field(
                "outbox_len",
                &self.outbox.lock().map(|q| q.len()).unwrap_or(0),
            )
            .field("closed", &self.closed.load(Ordering::Relaxed))
            .finish()
    }
}

impl LoopbackTransport {
    /// Construct a pair of `LoopbackTransport` endpoints. Returns
    /// `(a, b)` where `a.send(...)` enqueues to `b.try_recv()` and
    /// `b.send(...)` enqueues to `a.try_recv()`.
    pub fn pair() -> (Self, Self) {
        let a_to_b = Arc::new(Mutex::new(VecDeque::new()));
        let b_to_a = Arc::new(Mutex::new(VecDeque::new()));
        let a = Self {
            inbox: b_to_a.clone(),
            outbox: a_to_b.clone(),
            closed: AtomicBool::new(false),
        };
        let b = Self {
            inbox: a_to_b,
            outbox: b_to_a,
            closed: AtomicBool::new(false),
        };
        (a, b)
    }

    /// Mark this endpoint closed. Subsequent `send` / `try_recv`
    /// calls return `TransportError::Closed`. The peer endpoint
    /// is NOT affected by this call (each side has its own close
    /// flag).
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }

    /// True if this endpoint has been closed.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Number of bytes blobs waiting in this endpoint's inbox
    /// (i.e. sent by the peer, not yet drained via `try_recv`).
    /// Useful for tests that want to assert "the peer sent N
    /// blobs to me" without consuming them.
    pub fn pending_recv(&self) -> usize {
        self.inbox.lock().map(|q| q.len()).unwrap_or(0)
    }
}

impl Transport for LoopbackTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        self.outbox
            .lock()
            .map_err(|e| TransportError::Io(format!("loopback outbox lock poisoned: {e}")))?
            .push_back(bytes.to_vec());
        Ok(())
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        // Trait contract (transport.rs:71-74): "Closed only when the
        // channel is permanently closed AND its internal queue is
        // empty." So drain any already-queued bytes first; only
        // return Closed when both closed AND drained.
        // Codex + Opus 5.5 V1 audit MEDIUM/HIGH closure: pre-closure
        // we returned Closed immediately on close, violating the
        // contract.
        let mut queue = self
            .inbox
            .lock()
            .map_err(|e| TransportError::Io(format!("loopback inbox lock poisoned: {e}")))?;
        if let Some(bytes) = queue.pop_front() {
            return Ok(Some(bytes));
        }
        // Queue empty — now distinguish "open but empty" from "closed".
        if self.closed.load(Ordering::Relaxed) {
            Err(TransportError::Closed)
        } else {
            Ok(None)
        }
    }
}

// Codex + Opus 5.5 V1 audit closure: pin the Send+Sync contract
// the docstring promises. If a future refactor accidentally adds
// a non-Send/Sync field, this stops compiling.
const _ASSERT_LOOPBACK_TRANSPORT_SEND_SYNC: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<LoopbackTransport>();
};

#[cfg(test)]
mod tests {
    use super::{LoopbackTransport, NoopTransport, Transport, TransportError};

    #[test]
    fn noop_send_records_bytes() {
        let mut t = NoopTransport::new();
        t.send(b"hello").unwrap();
        t.send(b"world").unwrap();
        assert_eq!(t.sent, vec![b"hello".to_vec(), b"world".to_vec()]);
    }

    #[test]
    fn noop_try_recv_returns_none_when_open() {
        let mut t = NoopTransport::new();
        assert!(matches!(t.try_recv(), Ok(None)));
    }

    #[test]
    fn noop_send_after_close_errors() {
        let mut t = NoopTransport::new();
        t.send(b"first").unwrap();
        t.close();
        assert!(matches!(t.send(b"second"), Err(TransportError::Closed)));
        // The first send still recorded.
        assert_eq!(t.sent, vec![b"first".to_vec()]);
    }

    #[test]
    fn noop_try_recv_after_close_errors() {
        let mut t = NoopTransport::new();
        t.close();
        assert!(matches!(t.try_recv(), Err(TransportError::Closed)));
    }

    // -- LoopbackTransport tests (Phase 5.5 V1) --

    #[test]
    fn loopback_pair_a_to_b_round_trip() {
        let (mut a, mut b) = LoopbackTransport::pair();
        a.send(b"hello").unwrap();
        assert_eq!(b.try_recv().unwrap(), Some(b"hello".to_vec()));
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_pair_b_to_a_round_trip() {
        let (mut a, mut b) = LoopbackTransport::pair();
        b.send(b"world").unwrap();
        assert_eq!(a.try_recv().unwrap(), Some(b"world".to_vec()));
        assert_eq!(a.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_pair_bidirectional() {
        let (mut a, mut b) = LoopbackTransport::pair();
        a.send(b"a1").unwrap();
        b.send(b"b1").unwrap();
        a.send(b"a2").unwrap();

        assert_eq!(b.try_recv().unwrap(), Some(b"a1".to_vec()));
        assert_eq!(a.try_recv().unwrap(), Some(b"b1".to_vec()));
        assert_eq!(b.try_recv().unwrap(), Some(b"a2".to_vec()));
        assert_eq!(a.try_recv().unwrap(), None);
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_pair_fifo_order_preserved() {
        let (mut a, mut b) = LoopbackTransport::pair();
        for i in 0..10u8 {
            a.send(&[i]).unwrap();
        }
        for i in 0..10u8 {
            assert_eq!(b.try_recv().unwrap(), Some(vec![i]), "FIFO order must hold");
        }
    }

    #[test]
    fn loopback_pending_recv_reports_inbox_size() {
        let (mut a, b) = LoopbackTransport::pair();
        assert_eq!(b.pending_recv(), 0);
        a.send(b"x").unwrap();
        a.send(b"y").unwrap();
        assert_eq!(b.pending_recv(), 2);
        assert_eq!(a.pending_recv(), 0, "a's inbox unaffected by a.send");
    }

    #[test]
    fn loopback_close_one_side_does_not_affect_peer() {
        let (mut a, mut b) = LoopbackTransport::pair();
        a.close();
        assert!(a.is_closed());
        assert!(!b.is_closed(), "close is per-endpoint");
        // B can still send. Bytes land in A's inbox; A is closed so
        // any subsequent A.try_recv first drains them, then returns
        // Closed (Codex+Opus 5.5 V1 audit closure — drain-before-close
        // matches the Transport trait contract at transport.rs:71-74).
        b.send(b"orphan").unwrap();
        // A's send is blocked immediately.
        assert!(matches!(a.send(b"x"), Err(TransportError::Closed)));
        // A's try_recv drains the queued byte first (contract: only
        // return Closed when closed AND drained).
        assert_eq!(a.try_recv().unwrap(), Some(b"orphan".to_vec()));
        // Now empty + closed → Closed.
        assert!(matches!(a.try_recv(), Err(TransportError::Closed)));
        // B's recv still works (B's inbox is independent).
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_close_blocks_send_but_drains_recv() {
        // Renamed from loopback_close_blocks_own_send_and_recv — the
        // prior version asserted try_recv returned Closed immediately
        // on close, violating the trait contract that promises queue
        // drains before Closed.
        let (mut a, mut b) = LoopbackTransport::pair();
        b.send(b"first").unwrap();
        b.send(b"second").unwrap();
        a.close();
        // A drains both queued bytes first (contract: drain before Closed).
        assert_eq!(a.try_recv().unwrap(), Some(b"first".to_vec()));
        assert_eq!(a.try_recv().unwrap(), Some(b"second".to_vec()));
        // Now empty + closed → Closed.
        assert!(matches!(a.try_recv(), Err(TransportError::Closed)));
        // Send is blocked regardless of queue state.
        assert!(matches!(a.send(b"nope"), Err(TransportError::Closed)));
    }

    #[test]
    fn loopback_debug_includes_queue_sizes_and_close_state() {
        let (mut a, _b) = LoopbackTransport::pair();
        a.send(b"x").unwrap();
        a.close();
        let d = format!("{a:?}");
        assert!(d.contains("inbox_len"), "Debug must include inbox_len: {d}");
        assert!(
            d.contains("outbox_len"),
            "Debug must include outbox_len: {d}"
        );
        assert!(
            d.contains("closed: true"),
            "Debug must include closed state: {d}"
        );
    }
}
