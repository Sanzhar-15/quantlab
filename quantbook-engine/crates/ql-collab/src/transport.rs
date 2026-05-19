//! `Transport` trait — wire-byte channel for Phase 5 collaboration.
//!
//! **Phase 5.2.a (2026-05-19, scaffold ship):** defines the trait
//! shape that Phase 5.5 will implement (WebSocket or
//! Server-Sent-Events or custom protocol — the choice is 5.5's
//! call). Tests in the meantime use [`NoopTransport`] which
//! discards all traffic.
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
/// CollabSession does NOT auto-flush to its attached Transport
/// in V1 (Phase 5.5 V2 will wire append → send). For now, tests
/// drive the flow manually: append, export_bytes, send via the
/// transport, recv on the other side, merge_bytes.
///
/// ## Close semantics
///
/// Each endpoint has its OWN `closed` flag (separate
/// `AtomicBool`). `a.close()` shuts down endpoint A — A's
/// `send` + `try_recv` both return `TransportError::Closed`. B
/// is unaffected: B can still `send` (bytes land in A's inbox
/// but A won't drain them) and `try_recv` (drains any bytes
/// already in B's inbox).
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
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        Ok(self
            .inbox
            .lock()
            .map_err(|e| TransportError::Io(format!("loopback inbox lock poisoned: {e}")))?
            .pop_front())
    }
}

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
        // B can still send (bytes go into A's inbox but A won't drain).
        b.send(b"orphan").unwrap();
        // A's send and recv are both blocked.
        assert!(matches!(a.send(b"x"), Err(TransportError::Closed)));
        assert!(matches!(a.try_recv(), Err(TransportError::Closed)));
        // B's recv still works (B's inbox is independent).
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_close_blocks_own_send_and_recv() {
        let (mut a, mut b) = LoopbackTransport::pair();
        b.send(b"queued").unwrap();
        a.close();
        // A had a pending message but closing blocks even draining it.
        assert!(matches!(a.try_recv(), Err(TransportError::Closed)));
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
