//! Shared test fixtures for ql-collab-ws integration tests.
//!
//! In-process WebSocket echo server bound to 127.0.0.1:0 (OS-assigned
//! port). Echoes binary frames back to sender; drops text/ping/pong.
//! `Drop` aborts the listener loop.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// In-process WebSocket echo server. Echoes every binary frame back
/// to the sender. Listens on 127.0.0.1:0 (OS-assigned port). Use
/// [`url`](Self::url) to get the `ws://127.0.0.1:PORT` URL for the
/// client to connect to.
///
/// **Drop semantics:** aborts the accept loop AND every per-connection
/// task spawned during the lifetime of this server. The per-conn
/// abort is what tears down the live TCP socket → the client-side
/// reader observes EOF and marks closed. Without per-conn tracking,
/// `drop(server)` would only stop accepting NEW connections and
/// existing ones would dangle until the test process exits.
/// **V2 V4 V1 step 4 audit closure (Codex M1, 2026-05-21):** shared
/// state for accept loop + Drop, protecting against a multi-thread
/// race where:
/// 1. Accept task awaits accept().
/// 2. Accept resumes; tokio::spawn returns a handle (sync).
/// 3. **Another thread** runs `Server::drop` — aborts accept,
///    locks state, drains tasks, unlocks.
/// 4. Accept task resumes (still in sync code between spawn and
///    lock). Locks state. Pushes the handle.
/// 5. Result: the per-conn task is now in `tasks` AFTER Drop's
///    drain → leaks past test end.
///
/// The `closing` flag closes this race: Drop sets `closing = true`
/// under the lock, and the accept loop checks the flag AFTER taking
/// the lock and aborts the orphan handle directly if `closing` is
/// true. Both paths are atomic under the same mutex.
///
/// Shared between `EchoServer` and `TextFrameServer` (both use the
/// same accept→push pattern). Per V2 V4 V1 step 4 audit Opus M1:
/// any future fixture adding a similar pattern MUST use this state
/// or risk reintroducing the same race.
struct ServerState {
    closing: bool,
    tasks: Vec<JoinHandle<()>>,
}

pub struct EchoServer {
    addr: SocketAddr,
    accept_task: JoinHandle<()>,
    state: Arc<Mutex<ServerState>>,
}

impl EchoServer {
    /// Bind a TcpListener on 127.0.0.1:0 and spawn an accept loop.
    /// Each incoming connection is upgraded to a WebSocket and runs
    /// a per-connection echo loop in its own spawned task. The
    /// per-conn JoinHandle is recorded on `state.tasks` so `Drop`
    /// can abort it; the `state.closing` flag guards against the
    /// V2 V4 V1 step 4 audit closure race described on
    /// `EchoServerState`.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0 in test");
        let addr = listener
            .local_addr()
            .expect("local_addr after successful bind");
        // **V2 V4 V1 step 4 audit closure (Codex M1, 2026-05-21):**
        // see `EchoServerState` docstring for the closing-flag
        // race-protection rationale. The prior version used a bare
        // `Vec<JoinHandle>` under sync mutex; that closed the
        // single-thread interleaving (within the accept task itself)
        // but not the multi-thread interleaving (accept task vs
        // Drop on another runtime worker). The closing-flag pattern
        // serializes "is Drop done?" + "is task registered?" under
        // the same lock.
        let state = Arc::new(Mutex::new(ServerState {
            closing: false,
            tasks: Vec::new(),
        }));
        let state_in_accept = Arc::clone(&state);
        let accept_task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _peer_addr)) => {
                        let handle = tokio::spawn(handle_echo_connection(stream));
                        if let Ok(mut guard) = state_in_accept.lock() {
                            if guard.closing {
                                // Drop already ran; immediately abort
                                // this orphan handle instead of
                                // pushing it past Drop's drain.
                                handle.abort();
                            } else {
                                guard.tasks.push(handle);
                            }
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            addr,
            accept_task,
            state,
        }
    }

    /// `ws://127.0.0.1:PORT` URL the client should connect to.
    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

impl Drop for EchoServer {
    fn drop(&mut self) {
        // Abort the accept loop first so any NEW accept() return
        // observes cancellation at its next .await. Then under the
        // same lock as the accept-side push, set closing=true and
        // drain any tasks already registered. The closing flag is
        // load-bearing for the multi-thread race per V2 V4 V1 step 4
        // audit closure (Codex M1).
        self.accept_task.abort();
        if let Ok(mut guard) = self.state.lock() {
            guard.closing = true;
            for h in guard.tasks.drain(..) {
                h.abort();
            }
        }
    }
}

async fn handle_echo_connection(stream: TcpStream) {
    let mut ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    while let Some(msg_result) = ws.next().await {
        match msg_result {
            Ok(Message::Binary(bytes)) => {
                if ws.send(Message::Binary(bytes)).await.is_err() {
                    return;
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

/// One-shot client-side TCP server that accepts a single connection,
/// writes a complete-but-non-101 HTTP response, then closes the
/// stream. Used to drive `HandshakeFailed` paths deterministically
/// without an external dependency.
///
/// **V2 V4 V1 step 3 (Tier J1, 2026-05-21):** rewritten from the
/// previous "accept then immediately drop" pattern. That version
/// was timing/platform-dependent — the client's HTTP upgrade write
/// could complete-before-FIN (HandshakeFailed) or after-FIN
/// (ConnectFailed). Tests had to accept either outcome with `_or_`
/// disjunction.
///
/// The new version writes `"HTTP/1.1 999 GARBAGE\r\n\r\n"` — a
/// **complete, parseable HTTP response with an unclassified 999
/// status code** (not a malformed status-line failure). Per
/// V2 V4 V1 step 3 audit (Codex L2, 2026-05-21): tungstenite 0.29.0
/// parses this via `Response::try_parse`'s `httparse::Response::parse`
/// which sees `\r\n\r\n` as the message terminator (no EOF needed);
/// `StatusCode::from_u16(999)` succeeds because `http` 1.4 accepts
/// 100..=999; `VerifyData::verify_response` then rejects anything
/// other than `101 Switching Protocols` and returns
/// `Error::Http(response.into())`. `WebSocketTransport::connect`
/// maps `Error::Http(_)` to `WebSocketError::HandshakeFailed`.
///
/// **Theoretical platform-dependence remaining (per V2 V4 V1 step 3
/// audit Opus M2, 2026-05-21)**: a FIN/RST race during `shutdown()`
/// could in principle surface as `tungstenite::Error::Io(_)` if the
/// kernel sends a RST before the client reads the buffered response
/// bytes. In that case `connect` maps to `ConnectFailed`, not
/// `HandshakeFailed`, and the strict test assertion would fail.
/// Empirically passes on Mac per V2 V4 V1 step 3 gate (4451/0);
/// Linux/Windows behavior not yet validated. If a future CI
/// surfaces this flake, tighten by holding the connection open
/// longer (sleep N ms before shutdown) to ensure the client reads
/// the response bytes before the FIN arrives.
pub struct RejectingServer {
    addr: SocketAddr,
    accept_task: JoinHandle<()>,
}

impl RejectingServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0 in test");
        let addr = listener
            .local_addr()
            .expect("local_addr after successful bind");
        let accept_task = tokio::spawn(async move {
            // Accept one TCP connection, write a malformed HTTP
            // response (not a valid 101 Switching Protocols), then
            // drop. The client's tokio-tungstenite handshake parser
            // sees the bad status line and surfaces Http/HttpFormat,
            // mapping to HandshakeFailed deterministically.
            if let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                // Complete-but-non-101 HTTP response: valid HTTP/1.1
                // version line + status code 999 (unclassified per
                // IANA but syntactically accepted by `http` 1.4) +
                // CRLFCRLF terminator. tungstenite 0.29.0 parses
                // this as a complete response (no EOF needed), the
                // status verifier rejects non-101, and the connect
                // path surfaces `WebSocketError::HandshakeFailed`
                // (mapped from `tungstenite::Error::Http(_)`).
                let _ = stream.write_all(b"HTTP/1.1 999 GARBAGE\r\n\r\n").await;
                // Explicit shutdown signals end-of-response to the
                // client's parser without races (the response is
                // already complete due to CRLFCRLF; shutdown is
                // defensive cleanup).
                let _ = stream.shutdown().await;
                // _stream drops here.
            }
        });
        Self { addr, accept_task }
    }

    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

impl Drop for RejectingServer {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// **V2 V4 V1 step 3 (Tier J2, 2026-05-21):** WebSocket test fixture
/// that completes the handshake, then sends ONE `Message::Text`
/// frame, then ONE `Message::Binary` frame, then idles (until
/// dropped). Pins the V2 V3 step 4 contract that
/// `WebSocketTransport` silently drops text frames from the
/// inbound stream while continuing to deliver binary frames
/// normally.
///
/// Counterpart to `EchoServer`: where Echo reflects whatever the
/// client sends, this one is a unidirectional source of specific
/// frame types for the reader-task-behavior test.
pub struct TextFrameServer {
    addr: SocketAddr,
    accept_task: JoinHandle<()>,
    state: Arc<Mutex<ServerState>>,
}

impl TextFrameServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0 in test");
        let addr = listener
            .local_addr()
            .expect("local_addr after successful bind");
        // V2 V4 V1 step 4 audit closure (Codex M1 + Opus M1): same
        // closing-flag race protection as EchoServer. See ServerState
        // docstring.
        let state = Arc::new(Mutex::new(ServerState {
            closing: false,
            tasks: Vec::new(),
        }));
        let state_in_accept = Arc::clone(&state);
        let accept_task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _peer_addr)) => {
                        let handle = tokio::spawn(handle_text_then_binary(stream));
                        if let Ok(mut guard) = state_in_accept.lock() {
                            if guard.closing {
                                handle.abort();
                            } else {
                                guard.tasks.push(handle);
                            }
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            addr,
            accept_task,
            state,
        }
    }

    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

impl Drop for TextFrameServer {
    fn drop(&mut self) {
        self.accept_task.abort();
        if let Ok(mut guard) = self.state.lock() {
            guard.closing = true;
            for h in guard.tasks.drain(..) {
                h.abort();
            }
        }
    }
}

async fn handle_text_then_binary(stream: TcpStream) {
    let mut ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    // Send one text frame — the client should drop it silently.
    if ws
        .send(Message::Text(
            "this-should-be-dropped-by-the-reader-task"
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    // Send one binary frame — the client should deliver it via
    // try_recv as Ok(Some(_)).
    if ws
        .send(Message::Binary(
            b"binary-after-text-must-deliver".to_vec().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    // Idle until client drops or test ends.
    while let Some(msg_result) = ws.next().await {
        match msg_result {
            Ok(Message::Close(_)) => return,
            Err(_) => return,
            Ok(_) => {}
        }
    }
}
