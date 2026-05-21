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
pub struct EchoServer {
    addr: SocketAddr,
    accept_task: JoinHandle<()>,
    conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl EchoServer {
    /// Bind a TcpListener on 127.0.0.1:0 and spawn an accept loop.
    /// Each incoming connection is upgraded to a WebSocket and runs
    /// a per-connection echo loop in its own spawned task. The
    /// per-conn JoinHandle is recorded on `conn_tasks` so `Drop` can
    /// abort it.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0 in test");
        let addr = listener
            .local_addr()
            .expect("local_addr after successful bind");
        let conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let conn_tasks_in_accept = Arc::clone(&conn_tasks);
        let accept_task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _peer_addr)) => {
                        let handle = tokio::spawn(handle_echo_connection(stream));
                        if let Ok(mut tasks) = conn_tasks_in_accept.lock() {
                            tasks.push(handle);
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            addr,
            accept_task,
            conn_tasks,
        }
    }

    /// `ws://127.0.0.1:PORT` URL the client should connect to.
    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

impl Drop for EchoServer {
    fn drop(&mut self) {
        // Abort the accept loop first so no NEW per-conn tasks land
        // in conn_tasks during teardown. Then abort every per-conn
        // task — each task owns its TCP stream, so abort drops the
        // stream and the client observes a TCP RST / EOF.
        self.accept_task.abort();
        if let Ok(mut tasks) = self.conn_tasks.lock() {
            for h in tasks.drain(..) {
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
/// then closes it without completing the WebSocket handshake. Used
/// to drive `HandshakeFailed` paths without an external dependency.
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
            // Accept one TCP connection then drop it — the client's
            // WS handshake sees EOF and fails.
            if let Ok((_stream, _)) = listener.accept().await {
                // _stream drops here; client sees connection reset.
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
