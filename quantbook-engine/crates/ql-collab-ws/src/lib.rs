//! `ql-collab-ws` — WebSocket `Transport` impl for Phase 5
//! collaboration.
//!
//! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
//! production-grade [`Transport`](ql_collab::Transport) impl. Bridges
//! tokio-tungstenite's async WebSocket client to the sync `Transport`
//! trait via `tokio::sync::mpsc` channels and two spawned background
//! tasks.
//!
//! ## Crate boundary rationale
//!
//! `ql-collab` core is purely sync and embeddable in non-tokio
//! runtimes (e.g., an IDE main thread, future WASM target). Pulling
//! tokio + tokio-tungstenite into the core would force that
//! constraint on every consumer. Keeping the WebSocket impl in a
//! separate crate means:
//! - Consumers who only need `LoopbackTransport` (tests) or a custom
//!   transport (in-process IPC, gRPC streaming) don't pay for tokio.
//! - The async runtime lives at the application boundary, not in the
//!   collaboration layer.
//!
//! ## Architecture
//!
//! ```text
//!  caller (sync, e.g. inside CollabSession::append_op)
//!    │
//!    │  send(bytes)        try_recv() -> Option<bytes>
//!    ▼                            ▲
//!  WebSocketTransport             │
//!    │ outbound_tx              inbound_rx
//!    │  (mpsc::UnboundedSender)  (mpsc::UnboundedReceiver)
//!    ▼                            ▲
//!  writer_task (tokio)          reader_task (tokio)
//!    │  awaits outbound_rx        │  awaits ws_stream.next()
//!    ▼                            ▲
//!    │  ws_sink.send(Binary)      │  inbound_tx.send(bytes)
//!    ▼                            │
//!  ===================== TCP socket =====================
//! ```
//!
//! The two background tasks own the WebSocket halves
//! (`SplitSink` + `SplitStream` via `futures_util::StreamExt::split`).
//! `Drop` aborts both tasks (RAII close).
//!
//! ## V1 limitations (deferred to V2 V4)
//!
//! - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy
//!   in front, or wait for V2 V4 `rustls` feature.
//! - **No auto-reconnect.** Caller drives via `detach_transport` +
//!   new `connect` + `attach_transport`. The Phase 5.5 V2 V3 step 1
//!   `last_flushed_vv = None` reset on attach delivers all accumulated
//!   ops on reconnect (offline-write story).
//! - **Unbounded outbound mpsc queue.** Memory growth is bounded in
//!   practice for the common disconnect case: when the peer closes
//!   the TCP socket, the reader task observes EOF / `Err` and sets
//!   the closed flag; subsequent `send` calls fast-path to
//!   `Err(Closed)` before reaching the unbounded mpsc. The genuine
//!   growth window is the **dead-peer-but-not-closed** scenario
//!   (server stops draining but doesn't tear down the TCP socket):
//!   `ws_sink.send` stalls on TCP backpressure, `outbound_rx` grows
//!   unboundedly, and the reader task may still be receiving heartbeat
//!   frames so `closed` stays false. V2 V4 will switch to bounded
//!   with caller-configurable backpressure policy (clarified in
//!   V2 V3 step 4 audit closure, Opus M5).
//! - **Client-only.** Server-side WebSocket impls use other libraries
//!   (`axum-tungstenite`, `warp::ws`, etc.).
//! - **Drops text/ping/pong/close frames as inbound data.** Loro
//!   payloads are binary blobs; non-binary frames don't carry our
//!   protocol. Close frames trigger reader task exit. Inbound Ping
//!   frames: tokio-tungstenite queues a Pong response on the sink
//!   for the next write — but with no app traffic the Pong is not
//!   flushed until the next app send (clarified in V2 V3 step 4
//!   audit closure, Opus L3). Server-side idle-timeout would then
//!   close the connection. Text frames are silently dropped (a
//!   future protocol extension could add a callback hook).
//!
//! ## Example
//!
//! ```ignore
//! use ql_collab::{CollabSession, PeerId, AutoFlushPolicy};
//! use ql_collab_ws::WebSocketTransport;
//!
//! let rt = tokio::runtime::Runtime::new()?;
//! let ws = rt.block_on(WebSocketTransport::connect("ws://localhost:8080"))?;
//! let mut session = CollabSession::new(PeerId::new(1))?;
//! session.attach_transport(ws);
//! session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
//! // ... appends now propagate via WebSocket automatically ...
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use ql_collab::{Transport, TransportError};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// Errors emitted by [`WebSocketTransport`].
///
/// Distinguishes connect-time errors (`InvalidUrl`, `ConnectFailed`,
/// `HandshakeFailed`) from runtime errors observed by the background
/// reader/writer tasks (`RuntimeError`). Connect-time errors surface
/// as the `Result::Err` from [`WebSocketTransport::connect`]; runtime
/// errors are stashed on the transport and readable via
/// [`WebSocketTransport::last_error`] AFTER the trait `send`/`try_recv`
/// surface `TransportError::Closed`.
///
/// Maps tungstenite errors opaquely — we don't want to leak
/// tungstenite types into the public API.
///
/// **V2 V3 step 4 audit closure (Opus M1, 2026-05-21):** the prior
/// ship discarded background-task errors (`if let Err(_e)`), flattening
/// 8 distinct tungstenite::Error variants into a uniform `Closed` at
/// the trait boundary. This violated the CLAUDE.md no-fallbacks rule
/// (errors must be visible) and made it impossible for IDE consumers
/// driving reconnect handshakes to distinguish "connection lost" from
/// "auth failed". Adds `RuntimeError(String)` variant + `last_error()`
/// accessor; both tasks now populate the shared `last_error` slot on
/// non-graceful exit.
#[derive(Debug, Clone, Error)]
#[non_exhaustive]
pub enum WebSocketError {
    /// The URL string failed to parse or is missing required parts.
    /// Per CLAUDE.md no-fallback rule: surface clearly, don't silently
    /// retry with a "fixed up" URL.
    #[error("invalid WebSocket URL: {0}")]
    InvalidUrl(String),

    /// TCP connect failed (refused, timeout, DNS, etc.).
    #[error("WebSocket connection failed: {0}")]
    ConnectFailed(String),

    /// WebSocket protocol handshake failed (HTTP upgrade rejected,
    /// invalid response, etc.).
    #[error("WebSocket handshake failed: {0}")]
    HandshakeFailed(String),

    /// Background reader/writer task observed a runtime failure
    /// (peer reset, IO error, protocol violation, capacity exceeded,
    /// etc.) AFTER a successful connect. Surfaces via
    /// [`WebSocketTransport::last_error`] once the trait-level
    /// `Closed` has been observed.
    #[error("WebSocket runtime error: {0}")]
    RuntimeError(String),
}

/// Phase 5.5 V2 V3 step 4 — WebSocket `Transport` impl.
///
/// Bridges async tokio-tungstenite to the sync `Transport` trait via
/// `tokio::sync::mpsc` channels and two spawned background tasks.
/// See module-level docs for architecture diagram.
///
/// ## Construction
///
/// Use [`connect`](Self::connect) — async fn that performs the WS
/// handshake. Caller pattern from sync code:
///
/// ```ignore
/// let rt = tokio::runtime::Runtime::new()?;
/// let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?;
/// session.attach_transport(ws);
/// ```
///
/// ## Send/Sync
///
/// `WebSocketTransport: Send` (asserted via compile-time const). Not
/// `Sync` — exclusive ownership is required because `try_recv` takes
/// `&mut self` (the mpsc receiver is single-consumer). This matches
/// the `CollabSession::transport: Box<dyn Transport + Send>`
/// constraint.
pub struct WebSocketTransport {
    /// Caller-side sender feeding the writer task. Sync write via
    /// `UnboundedSender::send` (which is non-blocking).
    outbound_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Caller-side receiver pulling from the reader task. Sync drain
    /// via `UnboundedReceiver::try_recv`.
    inbound_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    /// Set true when either task observes a permanent failure (WS
    /// close, IO error, peer disconnect) OR caller invokes
    /// [`close`](Self::close). Both `send` and `try_recv` honor this
    /// flag per the `Transport` trait drain-before-close contract.
    closed: Arc<AtomicBool>,
    /// **V2 V3 step 4 audit closure (Opus M1, 2026-05-21):** stash
    /// the most recent task-observed runtime error so callers can
    /// distinguish "peer reset" from "auth rejected" from "capacity
    /// exceeded" etc. Populated by the writer task on `ws_sink.send`
    /// error and the reader task on stream `Err`. Stays `None` for
    /// clean shutdowns (caller `close()`, Drop, or graceful Close
    /// frame from peer).
    last_error: Arc<Mutex<Option<WebSocketError>>>,
    /// Background tokio task that drains `outbound_rx` and writes
    /// `Message::Binary` frames to the WebSocket sink. Aborted on
    /// `Drop`.
    writer_task: JoinHandle<()>,
    /// Background tokio task that polls the WebSocket stream and
    /// pushes binary payloads into `inbound_tx`. Aborted on `Drop`.
    reader_task: JoinHandle<()>,
}

impl std::fmt::Debug for WebSocketTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSocketTransport")
            .field("closed", &self.closed.load(Ordering::Relaxed))
            .field("writer_finished", &self.writer_task.is_finished())
            .field("reader_finished", &self.reader_task.is_finished())
            .finish()
    }
}

impl WebSocketTransport {
    /// Connect to a WebSocket server at `url` (e.g. `ws://host:port/path`).
    ///
    /// Must be called from within a tokio runtime context (the two
    /// background tasks are spawned via `tokio::spawn`). The typical
    /// pattern from sync code is `runtime.block_on(connect(...))`.
    ///
    /// On success, returns a fully-wired transport: send/recv channels
    /// connected, background tasks running. On failure, returns one
    /// of the [`WebSocketError`] variants with the underlying cause.
    pub async fn connect(url: &str) -> Result<Self, WebSocketError> {
        // tokio-tungstenite::connect_async handles URL parse + TCP
        // connect + WS handshake in one call. Distinguish the failure
        // modes via the returned error string match — opaque to keep
        // tungstenite types out of our public API.
        let (ws_stream, _response) = tokio_tungstenite::connect_async(url).await.map_err(|e| {
            let msg = e.to_string();
            // Coarse classification — tungstenite::Error doesn't have a
            // clean discriminant for "URL parse" vs "TCP connect" vs
            // "handshake". Use the error type to route.
            match e {
                tokio_tungstenite::tungstenite::Error::Url(_) => WebSocketError::InvalidUrl(msg),
                tokio_tungstenite::tungstenite::Error::Io(_) => WebSocketError::ConnectFailed(msg),
                tokio_tungstenite::tungstenite::Error::Http(_)
                | tokio_tungstenite::tungstenite::Error::HttpFormat(_) => {
                    WebSocketError::HandshakeFailed(msg)
                }
                _ => WebSocketError::HandshakeFailed(msg),
            }
        })?;

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let closed = Arc::new(AtomicBool::new(false));
        let closed_writer = Arc::clone(&closed);
        let closed_reader = Arc::clone(&closed);
        let last_error = Arc::new(Mutex::new(None::<WebSocketError>));
        let last_error_writer = Arc::clone(&last_error);
        let last_error_reader = Arc::clone(&last_error);

        // Writer task: drains outbound mpsc, writes Binary frames to
        // the WS sink. Exits on outbound_rx close (caller dropped
        // outbound_tx, which happens when WebSocketTransport drops)
        // OR on sink error.
        let writer_task = tokio::spawn(async move {
            while let Some(bytes) = outbound_rx.recv().await {
                if let Err(e) = ws_sink.send(Message::Binary(bytes.into())).await {
                    // V2 V3 step 4 audit closure (Opus M1): stash the
                    // tungstenite error string so callers can read it
                    // via last_error() after seeing TransportError::Closed.
                    if let Ok(mut slot) = last_error_writer.lock() {
                        *slot = Some(WebSocketError::RuntimeError(e.to_string()));
                    }
                    closed_writer.store(true, Ordering::Relaxed);
                    return;
                }
            }
            // outbound_rx closed (sender dropped) — clean shutdown.
            // Attempt a graceful WS close frame; ignore errors (peer
            // may already be gone). NOTE: under Drop, abort() runs
            // before outbound_tx drops in field-decl order, so this
            // arm is unreachable from Drop — see M2 closure note on
            // the Drop impl. Reachable from a future "soft close" API
            // that detaches outbound_tx explicitly.
            let _ = ws_sink.close().await;
        });

        // Reader task: polls WS stream; pushes binary payloads into
        // inbound mpsc. Exits on stream end, error, or Close frame.
        let reader_task = tokio::spawn(async move {
            while let Some(msg_result) = ws_stream.next().await {
                match msg_result {
                    Ok(Message::Binary(bytes)) => {
                        if inbound_tx.send(bytes.to_vec()).is_err() {
                            // Receiver dropped (WebSocketTransport
                            // dropped) — exit cleanly.
                            return;
                        }
                    }
                    Ok(Message::Close(_)) => {
                        // Graceful peer close — leave last_error None.
                        closed_reader.store(true, Ordering::Relaxed);
                        return;
                    }
                    Ok(
                        Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_),
                    ) => {
                        // Non-binary frames dropped per protocol
                        // contract (see module-level V1 limits).
                    }
                    Err(e) => {
                        // V2 V3 step 4 audit closure (Opus M1): stash
                        // the tungstenite error so callers can
                        // distinguish runtime causes via last_error().
                        if let Ok(mut slot) = last_error_reader.lock() {
                            *slot = Some(WebSocketError::RuntimeError(e.to_string()));
                        }
                        closed_reader.store(true, Ordering::Relaxed);
                        return;
                    }
                }
            }
            // Stream ended (peer closed) — mark closed.
            closed_reader.store(true, Ordering::Relaxed);
        });

        Ok(Self {
            outbound_tx,
            inbound_rx,
            closed,
            last_error,
            writer_task,
            reader_task,
        })
    }

    /// True if this transport has been closed — either explicitly via
    /// [`close`](Self::close), via Drop, or by either background task
    /// observing a permanent failure (peer disconnect, WS Close frame,
    /// IO error).
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// **V2 V3 step 4 audit closure (Opus M1, 2026-05-21):** read the
    /// most recent task-observed runtime error, if any. Returns `None`
    /// for clean shutdowns (caller [`close`](Self::close), Drop, or
    /// graceful Close frame from peer); returns `Some(RuntimeError(_))`
    /// when the writer's `ws_sink.send` or the reader's `ws_stream.next`
    /// surfaced an error before exiting.
    ///
    /// Read AFTER observing [`TransportError::Closed`] from
    /// [`Transport::send`] or [`Transport::try_recv`] to distinguish
    /// "peer reset" vs "auth rejected" vs "capacity exceeded" etc.
    /// IDE consumers driving reconnect handshakes use this to choose
    /// the right user-facing message and backoff strategy.
    ///
    /// Returns a clone (cheap — `WebSocketError` is small + `Clone`).
    pub fn last_error(&self) -> Option<WebSocketError> {
        self.last_error.lock().ok().and_then(|guard| guard.clone())
    }

    /// Explicitly mark this transport closed. Subsequent
    /// [`Transport::send`] calls return `Err(Closed)`; subsequent
    /// [`Transport::try_recv`] calls drain the inbound queue first,
    /// then return `Err(Closed)` (per trait contract).
    ///
    /// Does NOT abort the background tasks — only Drop does that. If
    /// the caller wants the tasks gone, drop the transport.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }
}

impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        // **V2 V3 step 4 audit closure (Opus M2, 2026-05-21):** the
        // sole shutdown path under current design is `abort()` on both
        // task handles. The graceful `outbound_rx.recv() -> None ->
        // ws_sink.close()` branch in the writer task is UNREACHABLE
        // FROM DROP because `Drop::drop` runs before the struct's
        // fields drop (Rust drop order: body first, then fields in
        // decl order). So `outbound_tx` is still alive when we call
        // `writer_task.abort()`. The graceful arm only fires if a
        // future "soft close" API explicitly detaches `outbound_tx`
        // before drop — not part of the current MVP.
        //
        // `closed = true` ordering: set first so any concurrent
        // sync `send`/`try_recv` observes Closed via the flag check
        // before the task abort propagates.
        self.closed.store(true, Ordering::Relaxed);
        self.writer_task.abort();
        self.reader_task.abort();
    }
}

impl Transport for WebSocketTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        // **LOAD-BEARING** (V2 V3 step 4 audit closure, Opus M4): this
        // closed-flag check MUST precede `outbound_tx.send`. The
        // `collab_session_websocket_send_after_close_surfaces_closed`
        // integration test depends on observing `Closed` here (the
        // reader task sets `closed = true` on peer disconnect; the
        // writer task may still be parked on `outbound_rx.recv` and
        // hasn't yet seen the broken sink). If a future refactor
        // reorders this check (e.g., to enable an outbox-queuing-
        // while-closed feature), that test will flake.
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        // UnboundedSender::send returns Err iff the receiver dropped.
        // The receiver lives in the writer task; if it dropped, the
        // task exited (panic, abort, or graceful). Treat as Closed.
        self.outbound_tx
            .send(bytes.to_vec())
            .map_err(|_| TransportError::Closed)
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        // Drain-before-close per `Transport` trait contract
        // (transport.rs:112-115): "Closed only when channel
        // permanently closed AND internal queue is empty."
        use mpsc::error::TryRecvError;
        match self.inbound_rx.try_recv() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(TryRecvError::Empty) => {
                if self.closed.load(Ordering::Relaxed) {
                    Err(TransportError::Closed)
                } else {
                    Ok(None)
                }
            }
            Err(TryRecvError::Disconnected) => {
                // Reader task exited and dropped inbound_tx. Mark
                // closed so subsequent calls fast-path; treat as
                // Closed for this call (the queue is empty AND the
                // upstream is permanently gone).
                self.closed.store(true, Ordering::Relaxed);
                Err(TransportError::Closed)
            }
        }
    }
}

// Phase 5.5 V2 V3 step 4 — pin the Send invariant. CollabSession
// stores `Box<dyn Transport + Send>`; if a future refactor adds a
// non-Send field this stops compiling. Sync is NOT required.
const _ASSERT_WEBSOCKET_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<WebSocketTransport>();
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_error_display_includes_cause() {
        let e = WebSocketError::InvalidUrl("malformed".into());
        assert!(e.to_string().contains("malformed"));
        let e = WebSocketError::ConnectFailed("refused".into());
        assert!(e.to_string().contains("refused"));
        let e = WebSocketError::HandshakeFailed("401".into());
        assert!(e.to_string().contains("401"));
    }

    #[test]
    fn websocket_error_variants_compile() {
        // Smoke check that each variant constructs + matches. The
        // `#[non_exhaustive]` attribute is for downstream crates;
        // inside this crate the variant set is closed and `_` would
        // be unreachable.
        for e in [
            WebSocketError::InvalidUrl("x".into()),
            WebSocketError::ConnectFailed("y".into()),
            WebSocketError::HandshakeFailed("z".into()),
            WebSocketError::RuntimeError("w".into()),
        ] {
            match e {
                WebSocketError::InvalidUrl(_) => (),
                WebSocketError::ConnectFailed(_) => (),
                WebSocketError::HandshakeFailed(_) => (),
                WebSocketError::RuntimeError(_) => (),
            }
        }
    }

    #[test]
    fn runtime_error_display_includes_cause() {
        // V2 V3 step 4 audit closure (Opus M1, 2026-05-21): pin the
        // Display impl for the new variant so its surface is stable.
        let e = WebSocketError::RuntimeError("peer reset".into());
        assert!(e.to_string().contains("peer reset"));
    }
}
