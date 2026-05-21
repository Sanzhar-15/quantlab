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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ql_collab::{Transport, TransportError};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// **V2 V3 step 5 megaudit closure (Opus-B M2, 2026-05-21):**
/// panic-safe task-exit guard. Held by the writer/reader tasks; its
/// `Drop` impl runs even on panic-unwinding. If the task exits
/// without calling [`Self::mark_clean_exit`], the guard treats it as
/// an unexpected exit (panic) and sets `closed = true` + records a
/// `RuntimeError` describing the panic.
///
/// Without this guard, a panic in `ws_sink.send`, `bytes.into()`, or
/// any future inner code would leave the transport in `closed=false`
/// with the task gone — callers would poll `try_recv` forever
/// returning `Ok(None)` and `send` would queue bytes into an
/// orphaned mpsc.
struct TaskExitGuard {
    task_name: &'static str,
    closed: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<WebSocketError>>>,
    /// **V2 V4 V1 step 1 audit closure (Codex L1 / Opus M2, 2026-05-21):**
    /// notify the `flush_pending` Condvar on panic exit so blocked
    /// callers wake up immediately rather than waiting for the
    /// `wait_timeout` tick. Same Arc as `WebSocketTransport::progress`.
    progress: Arc<(Mutex<u64>, Condvar)>,
    clean: bool,
}

impl TaskExitGuard {
    fn new(
        task_name: &'static str,
        closed: Arc<AtomicBool>,
        last_error: Arc<Mutex<Option<WebSocketError>>>,
        progress: Arc<(Mutex<u64>, Condvar)>,
    ) -> Self {
        Self {
            task_name,
            closed,
            last_error,
            progress,
            clean: false,
        }
    }

    /// Call before the task body exits via any normal path
    /// (Err arm, stream-end, clean recv-None). Skipping this
    /// is the signal that the task panicked.
    fn mark_clean_exit(mut self) {
        self.clean = true;
    }
}

impl Drop for TaskExitGuard {
    fn drop(&mut self) {
        if !self.clean {
            // Panic path: stash the panic signal in last_error
            // BEFORE setting closed (so a concurrent reader sees
            // the error first). Per CLAUDE.md no-fallback rule,
            // surface the panic loudly rather than swallowing.
            record_runtime_error(
                &self.last_error,
                format!("ql-collab-ws {} task panicked", self.task_name),
            );
            self.closed.store(true, Ordering::Relaxed);
            // V2 V4 V1 step 1 audit closure (Opus M2): wake any
            // flush_pending waiter so they observe the closed flag
            // without a 100ms timeout delay.
            self.progress.1.notify_all();
        }
    }
}

/// **V2 V3 step 5 megaudit closure (Opus-B M3, 2026-05-21):** surface
/// poisoned-mutex condition as a `RuntimeError` rather than the
/// previous `.lock().ok()` swallow. A poisoned mutex means a holder
/// panicked while populating the slot — the caller deserves to know
/// the slot's most-recent error was lost.
fn record_runtime_error(slot: &Arc<Mutex<Option<WebSocketError>>>, message: String) {
    match slot.lock() {
        Ok(mut guard) => {
            *guard = Some(WebSocketError::RuntimeError(message));
        }
        Err(poisoned) => {
            // Recover the inner mutex despite poison; overwrite with
            // a message that explicitly notes the poisoning so the
            // caller can detect a prior panic-during-error-stash.
            let mut guard = poisoned.into_inner();
            *guard = Some(WebSocketError::RuntimeError(format!(
                "{message} (note: error slot mutex was poisoned by prior panic)"
            )));
        }
    }
}

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
/// ## Send + Sync
///
/// `WebSocketTransport: Send + Sync` (Send pinned by the V2 V3
/// step 4 manual `const _ASSERT_WEBSOCKET_TRANSPORT_SEND`, Sync
/// pinned by V2 V4 V1 step 3 `static_assertions::assert_impl_all!` —
/// both compile-time checks at the end of this file). Note: the
/// prior
/// V2 V3 step 4 docstring (and Tier J3 backlog entry) incorrectly
/// claimed `!Sync` based on the intuition that the single-consumer
/// mpsc receiver should prevent sharing. In Rust, `Sync` means "`&T`
/// can be sent across threads" — orthogonal to "`&mut T` access is
/// exclusive." `try_recv` takes `&mut self`, so concurrent receives
/// are already prevented by the borrow checker. All fields
/// (mpsc handles, `Arc<AtomicBool>`, `Arc<Mutex<_>>`, `JoinHandle`)
/// are `Send + Sync`, making the composite `Send + Sync`.
///
/// **Why this matters**: matches the `CollabSession::transport:
/// Box<dyn Transport + Send>` constraint (only `Send` is required at
/// the trait boundary; `Sync` is a bonus that allows future
/// `Arc<WebSocketTransport>` wrappers if a consumer needs them).
/// **Tier J3 closure (V2 V4 V1 step 3, 2026-05-21):** corrected the
/// docstring + the backlog entry; pinned BOTH bounds with positive
/// compile-time asserts.
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
    /// **Phase 5.5 V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
    /// Incremented by [`Transport::send`] on Ok return. Total bytes
    /// queued lifetime (monotonic, never resets). Compared against
    /// [`Self::progress.0`] in [`Transport::flush_pending`] to detect
    /// when the writer task has caught up.
    queued_count: Arc<AtomicU64>,
    /// **Phase 5.5 V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
    /// `(counter, condvar)` pair. Counter is incremented by the writer
    /// task AFTER each successful `ws_sink.send`. Condvar is notified
    /// on each counter increment AND on `closed`-flag transition (so
    /// `flush_pending` callers waiting on the Condvar wake up and
    /// observe the closed state). Sync primitives (not tokio) because
    /// `flush_pending` is called from sync caller code and needs to
    /// block synchronously without a tokio runtime context.
    progress: Arc<(Mutex<u64>, Condvar)>,
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

        // **Phase 5.5 V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
        // Track writer-task progress for `Transport::flush_pending`.
        // `queued_count` is incremented by `send()` after a successful
        // mpsc enqueue. `progress.0` is the counter of bytes
        // successfully flushed to the WebSocket sink, incremented by
        // the writer task. `progress.1` (Condvar) is notified after
        // each progress increment AND on closed-flag transitions, so
        // `flush_pending` blocked in `wait_timeout` can wake and
        // observe the new state.
        let queued_count = Arc::new(AtomicU64::new(0));
        let progress = Arc::new((Mutex::new(0u64), Condvar::new()));
        let progress_writer = Arc::clone(&progress);
        let progress_reader = Arc::clone(&progress);

        // Writer task: drains outbound mpsc, writes Binary frames to
        // the WS sink. Exits on outbound_rx close (caller dropped
        // outbound_tx, which happens when WebSocketTransport drops)
        // OR on sink error.
        //
        // **V2 V3 step 5 megaudit closure (Opus-B M2, 2026-05-21):**
        // wrap the body in a TaskExitGuard so panic-unwinding
        // sets `closed = true` + records a Panic error. Without
        // this, a panic in `ws_sink.send`/`bytes.into()` leaves the
        // transport in `closed=false` state with the writer task
        // gone — callers send-loop forever returning Ok-but-discarded
        // bytes.
        let writer_task = tokio::spawn(async move {
            let _guard = TaskExitGuard::new(
                "writer",
                Arc::clone(&closed_writer),
                Arc::clone(&last_error_writer),
                Arc::clone(&progress_writer),
            );
            while let Some(bytes) = outbound_rx.recv().await {
                if let Err(e) = ws_sink.send(Message::Binary(bytes.into())).await {
                    // V2 V3 step 4 audit closure (Opus M1): stash the
                    // tungstenite error string so callers can read it
                    // via last_error() after seeing TransportError::Closed.
                    record_runtime_error(&last_error_writer, e.to_string());
                    closed_writer.store(true, Ordering::Relaxed);
                    // V2 V4 V1 step 1: wake any flush_pending waiters
                    // so they observe the now-set closed flag.
                    progress_writer.1.notify_all();
                    _guard.mark_clean_exit();
                    return;
                }
                // V2 V4 V1 step 1 (Tier K1): writer task successfully
                // wrote one byte blob to the WS sink. Advance the
                // progress counter + notify any flush_pending waiters.
                // **Step 1 audit closure (Opus L1):** poisoned-mutex
                // handling — recover via PoisonError::into_inner()
                // so a prior panic doesn't permanently freeze the
                // counter at a stale value. Symmetric with
                // last_error mutex handling.
                let mut counter = match progress_writer.0.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *counter += 1;
                progress_writer.1.notify_all();
            }
            // outbound_rx closed (sender dropped) — clean shutdown.
            // Attempt a graceful WS close frame; ignore errors (peer
            // may already be gone). NOTE: under Drop, abort() runs
            // before outbound_tx drops in field-decl order, so this
            // arm is unreachable from Drop — see M2 closure note on
            // the Drop impl. Reachable from a future "soft close" API
            // that detaches outbound_tx explicitly.
            let _ = ws_sink.close().await;
            // V2 V4 V1 step 1: wake any flush_pending waiters on
            // clean exit too (graceful "soft close" path).
            progress_writer.1.notify_all();
            _guard.mark_clean_exit();
        });

        // Reader task: polls WS stream; pushes binary payloads into
        // inbound mpsc. Exits on stream end, error, or Close frame.
        //
        // **V2 V4 V1 step 1 audit closure (Codex L1 / Opus M1):** every
        // closed-flag transition from the reader task now also calls
        // `progress.1.notify_all()` so flush_pending waiters wake up
        // immediately, not after a 100ms timeout. The TaskExitGuard
        // also notifies on panic path via its Drop impl.
        let reader_task = tokio::spawn(async move {
            let _guard = TaskExitGuard::new(
                "reader",
                Arc::clone(&closed_reader),
                Arc::clone(&last_error_reader),
                Arc::clone(&progress_reader),
            );
            while let Some(msg_result) = ws_stream.next().await {
                match msg_result {
                    Ok(Message::Binary(bytes)) => {
                        if inbound_tx.send(bytes.to_vec()).is_err() {
                            // Receiver dropped (WebSocketTransport
                            // dropped) — exit cleanly. Set closed
                            // for state-machine symmetry (Opus-B L1).
                            closed_reader.store(true, Ordering::Relaxed);
                            progress_reader.1.notify_all();
                            _guard.mark_clean_exit();
                            return;
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        // **V2 V3 step 5 megaudit closure (Opus-B M4
                        // + Codex L2, 2026-05-21):** capture the
                        // close-frame code+reason if present. Empty
                        // / missing CloseFrame stays last_error=None
                        // for graceful close; populated CloseFrame
                        // surfaces the application-level signal
                        // (e.g., "session expired, please reauth").
                        if let Some(cf) = frame {
                            if !cf.reason.is_empty() || u16::from(cf.code) != 1000 {
                                record_runtime_error(
                                    &last_error_reader,
                                    format!(
                                        "peer close frame: code={}, reason={}",
                                        u16::from(cf.code),
                                        cf.reason
                                    ),
                                );
                            }
                        }
                        closed_reader.store(true, Ordering::Relaxed);
                        progress_reader.1.notify_all();
                        _guard.mark_clean_exit();
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
                        record_runtime_error(&last_error_reader, e.to_string());
                        closed_reader.store(true, Ordering::Relaxed);
                        progress_reader.1.notify_all();
                        _guard.mark_clean_exit();
                        return;
                    }
                }
            }
            // **V2 V3 step 5 megaudit closure (Codex L2 + Opus-B M4,
            // 2026-05-21):** stream ended without a Close frame.
            // Distinguishable from clean caller-close (last_error
            // stays None) and from explicit Close frame (last_error
            // populated above if frame had reason or non-1000 code).
            record_runtime_error(
                &last_error_reader,
                "peer stream ended without close frame".to_string(),
            );
            closed_reader.store(true, Ordering::Relaxed);
            progress_reader.1.notify_all();
            _guard.mark_clean_exit();
        });

        Ok(Self {
            outbound_tx,
            inbound_rx,
            closed,
            last_error,
            queued_count,
            progress,
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
    ///
    /// **V2 V3 step 5 megaudit closure (Opus-B M3, 2026-05-21):**
    /// poisoned mutex no longer silently returns `None`. Recovers
    /// the inner via `PoisonError::into_inner()` so the slot's
    /// most-recent contents stay readable across the poison boundary.
    pub fn last_error(&self) -> Option<WebSocketError> {
        match self.last_error.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// Explicitly mark this transport closed. Subsequent
    /// [`Transport::send`] calls return `Err(Closed)`; subsequent
    /// [`Transport::try_recv`] calls drain the inbound queue first,
    /// then return `Err(Closed)` (per trait contract).
    ///
    /// Does NOT abort the background tasks — only Drop does that. If
    /// the caller wants the tasks gone, drop the transport.
    ///
    /// **V2 V4 V1 step 1 (Tier K1):** also notifies the
    /// flush_pending Condvar so any concurrent `flush_pending` waiter
    /// wakes up and observes the new closed state.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.progress.1.notify_all();
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
        //
        // **V2 V4 V1 step 1 (Tier K1):** also notify the
        // flush_pending Condvar — a caller awaiting a long-running
        // flush would otherwise wait until the next wait_timeout
        // tick to observe the closed flag. (Unreachable in practice
        // because Drop is called on a unique `&mut self` so no
        // concurrent flush_pending can be in flight, but kept for
        // safety + future shared-reference APIs.)
        self.closed.store(true, Ordering::Relaxed);
        self.progress.1.notify_all();
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
            .map_err(|_| TransportError::Closed)?;
        // **V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
        // Bump the queued-count counter AFTER successful mpsc enqueue.
        // flush_pending() reads this as the target the writer task
        // must catch up to.
        self.queued_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
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

    /// **V2 V3 step 5 megaudit closure (Opus-A H1, 2026-05-21):**
    /// override the default `None` to expose the runtime-error cause
    /// through the trait so [`ql_collab::CollabSession::transport_last_error`]
    /// can reach it after `attach_transport` consumes the concrete
    /// type into `Box<dyn Transport + Send>`.
    ///
    /// Returns the underlying [`WebSocketError`]'s `Display` string.
    /// Consumers wanting to discriminate handshake/connect/runtime
    /// reasons can pattern-match on substrings or use the prefix
    /// (`"WebSocket runtime error: ..."`) to detect the variant —
    /// for stronger typing keep a parallel reference to the concrete
    /// transport before attach.
    fn last_error(&self) -> Option<String> {
        Self::last_error(self).map(|e| e.to_string())
    }

    /// **V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
    /// Block until every byte blob previously queued via `send` has
    /// been written to the WebSocket sink. Closes the V2 V3 step 5
    /// megaudit's convergent finding (queued-vs-acked semantics).
    ///
    /// Mechanism: reads `queued_count` as the target; locks the
    /// `progress.0` counter and uses `Condvar::wait_timeout` to wake
    /// every 100ms (so closed-flag transitions are observed promptly).
    /// The writer task increments `progress.0` + `notify_all` after
    /// each successful `ws_sink.send`, AND `notify_all` on closed-
    /// flag transitions.
    ///
    /// # Errors
    /// - `TransportError::Closed` if the transport was already closed
    ///   on entry, OR if the writer task sets closed mid-wait (e.g.,
    ///   ws_sink.send failed).
    /// - `TransportError::Io` if the progress mutex is poisoned by a
    ///   panicked writer task. The poisoned-mutex recovery via
    ///   `PoisonError::into_inner()` is intentionally NOT used here:
    ///   if the writer panicked mid-counter-increment, the counter
    ///   may be in an inconsistent state (e.g., notify_all happened
    ///   before counter increment); reading + retrying could
    ///   busy-loop forever. Surface as Io and let the caller
    ///   recover via reconnect.
    fn flush_pending(&mut self) -> Result<(), TransportError> {
        // **V2 V4 V1 step 1 audit closure (Codex M1, 2026-05-21):**
        // honor the documented contract — if the transport is closed
        // on entry, return Err(Closed) immediately, regardless of
        // whether the local progress counter has already caught up.
        // The prior impl returned Ok in this case, contradicting the
        // docstring + the closed-on-entry test which now accepts
        // both Ok and Err. After this closure, the contract is "Err
        // if closed at any point — entry or mid-wait".
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        let target = self.queued_count.load(Ordering::SeqCst);
        let (counter_lock, cv) = &*self.progress;
        let mut counter = counter_lock
            .lock()
            .map_err(|e| TransportError::Io(format!("flush_pending lock poisoned: {e}")))?;
        while *counter < target {
            if self.closed.load(Ordering::Relaxed) {
                return Err(TransportError::Closed);
            }
            let (new_counter, _timeout_result) = cv
                .wait_timeout(counter, Duration::from_millis(100))
                .map_err(|e| TransportError::Io(format!("flush_pending wait poisoned: {e}")))?;
            counter = new_counter;
        }
        Ok(())
    }
}

// Phase 5.5 V2 V3 step 4 — pin the Send invariant. CollabSession
// stores `Box<dyn Transport + Send>`; if a future refactor adds a
// non-Send field this stops compiling.
const _ASSERT_WEBSOCKET_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<WebSocketTransport>();
};

// **Phase 5.5 V2 V4 V1 step 3 (2026-05-21) — Tier J3.** Pin the
// Sync invariant too. The V2 V3 step 4 docstring + the Tier J3
// backlog entry both claimed `!Sync` (based on the intuition that
// the single-consumer mpsc receiver should prevent sharing), but
// the type is actually Sync — `try_recv`'s `&mut self` requirement
// is enforced by the borrow checker, not by `!Sync`. All fields
// happen to be Sync (mpsc handles, Arc<AtomicBool>, Arc<Mutex>,
// JoinHandle). This positive assert pins the actual contract; if a
// future refactor adds a non-Sync field (e.g., a Cell<>), it stops
// compiling — same protection level as the Send assert above.
static_assertions::assert_impl_all!(WebSocketTransport: Sync);

// **V2 V4 V1 step 3 (Tier J3) — also pin WebSocketError: Send + Sync.**
// The error type is small (4 String-carrying variants) so Send +
// Sync are both expected. Pinning prevents a future variant that
// adds a non-Send/non-Sync payload (e.g., `Rc<...>`) from silently
// breaking cross-thread error reporting via `last_error()`. This
// closes V2 V3 step 4 audit Opus L4 + V2 V3 step 5 megaudit Opus L4
// (forward-leaning bound assert) as well.
static_assertions::assert_impl_all!(WebSocketError: Send, Sync);

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
