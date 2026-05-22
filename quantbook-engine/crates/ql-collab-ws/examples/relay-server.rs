//! Phase 5.7 V3.1.a (2026-05-22) -- localhost WebSocket relay binary.
//!
//! Demo-only stateless broadcast relay for the V3.1 multi-window IDE
//! demo. Every binary frame received from any connected client is
//! re-broadcast to every OTHER connected client. Sender-side filtering
//! prevents a client from receiving its own frames.
//!
//! Not a production server:
//! - Bound to 127.0.0.1 only.
//! - No TLS, no auth, no session affinity.
//! - Drops text / ping / pong frames (V2 V3 step 4 V1 limitation
//!   inherited from `WebSocketTransport`).
//! - Unbounded fan-in via tokio broadcast (256-frame ring; older
//!   frames are dropped if a slow client lags).
//!
//! Build:
//!   cargo build -p ql-collab-ws --example relay-server --release
//!
//! Run:
//!   QL_RELAY_PORT=7117 cargo run -p ql-collab-ws --example relay-server --release
//!   # default port if QL_RELAY_PORT unset: 7117
//!
//! The IDE's `quantlab.quantbookDemo` command spawns this binary as a
//! child process (V3.1.b will land that work). The binary prints
//! `[ql-collab-ws relay] listening on ws://127.0.0.1:<port>` once
//! bound -- the IDE pings this line to confirm readiness before
//! spawning the second window.
//!
//! Exit: Ctrl-C (SIGINT) or kill from the IDE's child-process handle.

use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::signal;
use tokio::sync::broadcast;
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;

/// Default port if `QL_RELAY_PORT` is unset. Picked to avoid common
/// dev-server collisions (3000/8080/9000/etc).
const DEFAULT_PORT: u16 = 7117;

/// Tokio broadcast channel capacity. Each slot holds one
/// `(sender_id, bytes)` tuple. If a client lags more than this many
/// frames, `recv()` returns `Lagged(n)` and the per-client task skips
/// `n` frames -- acceptable for the demo (the CRDT layer is
/// idempotent on re-merge).
const BROADCAST_BUFFER: usize = 256;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = env::var("QL_RELAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    // Stdout line consumed by the IDE child-process handle to detect
    // readiness. Keep this format stable -- V3.1.b will regex-match.
    println!("[ql-collab-ws relay] listening on ws://{bound}");

    // Broadcast channel + connection counter, both cloned per-conn.
    let (broadcast_tx, _initial_rx) = broadcast::channel::<(usize, Vec<u8>)>(BROADCAST_BUFFER);
    let next_conn_id = Arc::new(AtomicUsize::new(0));

    // V3.1.e closure (Codex LOW-2, 2026-05-22) -- graceful shutdown
    // via tokio::signal + JoinSet. Pre-V3.1.e the accept loop was
    // unbounded and SIGTERM relied on OS socket reclaim. Now SIGINT
    // (Ctrl-C) or SIGTERM cleanly stops accepting, drains active
    // connection tasks, and returns from main so the runtime shuts
    // down without leaking tasks.
    let mut conn_set: JoinSet<()> = JoinSet::new();
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                let (stream, peer) = match accept_result {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("[ql-collab-ws relay] accept failed: {e}");
                        continue;
                    }
                };
                let conn_id = next_conn_id.fetch_add(1, Ordering::Relaxed);
                let broadcast_tx = broadcast_tx.clone();
                eprintln!("[ql-collab-ws relay] conn {conn_id} accepted from {peer}");
                conn_set.spawn(async move {
                    match handle_connection(stream, conn_id, broadcast_tx).await {
                        Ok(()) => eprintln!("[ql-collab-ws relay] conn {conn_id} closed cleanly"),
                        Err(e) => eprintln!("[ql-collab-ws relay] conn {conn_id} ended with: {e}"),
                    }
                });
            }
            _ = &mut shutdown => {
                eprintln!(
                    "[ql-collab-ws relay] shutdown signal received; aborting {} active connection(s)",
                    conn_set.len(),
                );
                break;
            }
        }
    }

    // Abort all in-flight per-connection tasks. We deliberately do
    // NOT wait for graceful WebSocket close handshakes -- the
    // shutdown semantics are "shutdown RIGHT NOW; clients observe a
    // TCP close and reconnect on their own".
    //
    // Why not a soft drain? Each per-conn task holds a
    // `broadcast::Sender` clone (the read half's `read_tx`), so
    // dropping the main `broadcast_tx` is NOT enough to wake the
    // write halves -- the receivers see "Closed" only when ALL
    // senders drop. A soft drain would block until every WebSocket
    // peer happened to close its end, which is unbounded.
    //
    // For a future production relay (NOT this demo scope), use
    // `tokio::time::timeout` around `join_next` to give peers a
    // short grace period before aborting -- typically 100-500ms.
    drop(broadcast_tx);
    conn_set.abort_all();
    while let Some(res) = conn_set.join_next().await {
        // Aborted tasks return JoinError::is_cancelled() == true,
        // which is the expected path. Only log non-cancellation
        // errors (panicked tasks).
        if let Err(e) = res {
            if !e.is_cancelled() {
                eprintln!("[ql-collab-ws relay] task ended with join error: {e}");
            }
        }
    }
    eprintln!("[ql-collab-ws relay] shutdown complete");
    Ok(())
}

/// Wait for SIGINT (Ctrl-C) on all platforms or SIGTERM on Unix.
/// Returns when EITHER signal arrives. On Windows the SIGTERM branch
/// is never armed (kill -TERM doesn't exist there); Ctrl-C is the
/// only graceful path.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigterm = match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ql-collab-ws relay] failed to install SIGTERM handler: {e}");
                // Fall back to ctrl_c only -- the daemon still
                // shuts down on SIGINT, just not SIGTERM.
                let _ = signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = signal::ctrl_c().await;
    }
}

/// Handle a single client connection. WebSocket-upgrades the TCP
/// stream, splits into read + write halves, and bridges:
/// - read half: forward incoming binary frames into the broadcast.
/// - write half: subscribe to the broadcast; write every frame whose
///   sender_id is NOT this connection's id (sender-side filter).
async fn handle_connection(
    stream: TcpStream,
    conn_id: usize,
    broadcast_tx: broadcast::Sender<(usize, Vec<u8>)>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut ws_sink, mut ws_stream) = ws.split();
    let mut broadcast_rx = broadcast_tx.subscribe();

    // Read half: forward incoming binary frames into the broadcast.
    // Text / ping / pong / close are dropped (V2 V3 step 4 contract).
    let read_tx = broadcast_tx.clone();
    let read = async move {
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Binary(b)) => {
                    // `b` is the tungstenite payload type
                    // (`bytes::Bytes` in 0.29). Convert to Vec<u8>
                    // for the broadcast tuple. Send to broadcast;
                    // if no other subscribers exist, the send fails
                    // silently (broadcast returns Err only when ALL
                    // receivers are dropped, which we ignore -- the
                    // relay still accepts data when a peer is alone).
                    let bytes: Vec<u8> = b.into();
                    let _ = read_tx.send((conn_id, bytes));
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    };

    // Write half: forward broadcast frames (other senders) to this
    // client's sink.
    let write = async move {
        loop {
            match broadcast_rx.recv().await {
                Ok((sender_id, bytes)) if sender_id != conn_id => {
                    // Vec<u8>.into() -> tungstenite payload via the
                    // existing `From<Vec<u8>>` impl (same pattern as
                    // crates/ql-collab-ws/src/lib.rs:500).
                    if ws_sink.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_n)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    // tokio::select drives both halves; whichever exits first ends
    // the connection (the other half is dropped, releasing the
    // sink/stream).
    tokio::select! {
        _ = read => {},
        _ = write => {},
    }
    Ok(())
}
