//! Phase 5.7 V3.1.a (2026-05-22) -- integration test for the
//! `examples/relay-server.rs` localhost broadcast relay.
//!
//! The test inlines the relay's `handle_connection` logic (the
//! binary is a `examples/*.rs` and cannot be imported as a module).
//! Any drift between the binary and this test means one was edited
//! without the other -- caller MUST keep both in sync. The relay is
//! demo-scope and small enough that this duplication is acceptable
//! (V3.1.a deferred a `pub mod relay` API into the library because
//! production code does not need it).
//!
//! What this test verifies:
//! 1. Two clients can connect to the relay simultaneously.
//! 2. Bytes sent by client A are received by client B (cross-broadcast).
//! 3. Client A does NOT receive its own bytes (self-filter).
//! 4. A third client receives both A's and B's bytes.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const BROADCAST_BUFFER: usize = 256;

/// Inline twin of `examples/relay-server.rs::handle_connection`. Keep
/// in sync. Drives one client's read+write halves; exits when either
/// side ends.
async fn handle_conn(
    stream: TcpStream,
    conn_id: usize,
    broadcast_tx: broadcast::Sender<(usize, Vec<u8>)>,
) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (mut sink, mut stream) = ws.split();
    let mut rx = broadcast_tx.subscribe();
    let tx = broadcast_tx.clone();

    let read = async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Binary(b)) => {
                    let v: Vec<u8> = b.into();
                    let _ = tx.send((conn_id, v));
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    };

    let write = async move {
        loop {
            match rx.recv().await {
                Ok((sender_id, bytes)) if sender_id != conn_id => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    tokio::select! {
        _ = read => {},
        _ = write => {},
    }
}

/// Spawn the relay on 127.0.0.1:0; return the bound address.
async fn spawn_relay() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bound = listener.local_addr().unwrap();
    let (broadcast_tx, _) = broadcast::channel::<(usize, Vec<u8>)>(BROADCAST_BUFFER);
    let next_id = Arc::new(AtomicUsize::new(0));
    tokio::spawn(async move {
        loop {
            let (stream, _peer) = match listener.accept().await {
                Ok(t) => t,
                Err(_) => break,
            };
            let conn_id = next_id.fetch_add(1, Ordering::Relaxed);
            let bt = broadcast_tx.clone();
            tokio::spawn(async move {
                handle_conn(stream, conn_id, bt).await;
            });
        }
    });
    bound
}

async fn connect_client(addr: std::net::SocketAddr) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let url = format!("ws://{addr}");
    let (ws, _resp) = connect_async(url).await.expect("connect");
    ws
}

#[tokio::test]
async fn two_clients_cross_broadcast() {
    let addr = spawn_relay().await;
    let a = connect_client(addr).await;
    let b = connect_client(addr).await;
    let (mut a_sink, mut a_stream) = a.split();
    let (_b_sink, mut b_stream) = b.split();

    // Give both connections time to subscribe to the broadcast
    // before the test sends anything; the accept-task races the
    // first send otherwise.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let payload = b"hello-from-A".to_vec();
    a_sink
        .send(Message::Binary(payload.clone().into()))
        .await
        .unwrap();

    let received = timeout(Duration::from_secs(2), b_stream.next())
        .await
        .expect("B receives within 2s")
        .expect("not None")
        .expect("not Err");
    match received {
        Message::Binary(bytes) => {
            let v: Vec<u8> = bytes.into();
            assert_eq!(v, payload, "B received A's payload verbatim");
        }
        other => panic!("expected Binary, got {other:?}"),
    }

    // And A must NOT see its own payload (self-filter).
    // Sleep briefly; if A had received it, it would arrive in < 50ms.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let a_self_echo = tokio::time::timeout(Duration::from_millis(50), a_stream.next()).await;
    assert!(
        a_self_echo.is_err(),
        "A should NOT receive its own payload; sender-side filter broken"
    );
}

#[tokio::test]
async fn third_client_receives_both_streams() {
    let addr = spawn_relay().await;
    let a = connect_client(addr).await;
    let b = connect_client(addr).await;
    let c = connect_client(addr).await;
    let (mut a_sink, _) = a.split();
    let (mut b_sink, _) = b.split();
    let (_c_sink, mut c_stream) = c.split();

    tokio::time::sleep(Duration::from_millis(50)).await;

    a_sink
        .send(Message::Binary(b"from-A".to_vec().into()))
        .await
        .unwrap();
    b_sink
        .send(Message::Binary(b"from-B".to_vec().into()))
        .await
        .unwrap();

    let mut seen: Vec<Vec<u8>> = Vec::with_capacity(2);
    for _ in 0..2 {
        let msg = timeout(Duration::from_secs(2), c_stream.next())
            .await
            .expect("C receives within 2s")
            .expect("not None")
            .expect("not Err");
        if let Message::Binary(bytes) = msg {
            seen.push(bytes.into());
        }
    }
    seen.sort();
    let expected: Vec<Vec<u8>> = {
        let mut v = vec![b"from-A".to_vec(), b"from-B".to_vec()];
        v.sort();
        v
    };
    assert_eq!(seen, expected, "C received both A's and B's payloads");
}
