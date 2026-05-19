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
/// real channel; Phase 5.5 will add a `LoopbackTransport` that
/// echoes sends back to the same peer for round-trip testing.
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

#[cfg(test)]
mod tests {
    use super::{NoopTransport, Transport, TransportError};

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
}
