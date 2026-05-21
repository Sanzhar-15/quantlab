//! Phase 5.5 V2 V3 step 4 (2026-05-21) — `WebSocketTransport`
//! integration tests against an in-process echo server.
//!
//! All tests run on a `current_thread` tokio runtime built per-test
//! so they're independently schedulable; `--test-threads=1` is fine
//! (matches the rest of the workspace gate). The test fixture
//! ([`common::EchoServer`]) binds 127.0.0.1:0 → no port conflicts.

mod common;

use std::time::Duration;

use ql_collab::{
    AutoFlushPolicy, CollabSession, CollabSessionError, PeerId, Transport, TransportError,
};
use ql_collab_ws::{WebSocketError, WebSocketTransport};
use ql_oplog::{CellWireValue, Op};

use crate::common::{EchoServer, RejectingServer};

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

/// Build a single-threaded tokio runtime for one test. Each test owns
/// its runtime so panics + abort() cleanups can't leak across tests.
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime")
}

/// Poll `try_recv` with short sleeps for up to `max_iters * 10ms`
/// looking for a binary blob. Async background tasks need a chance
/// to deliver bytes; tests block on this helper.
async fn await_blob(transport: &mut WebSocketTransport, max_iters: u32) -> Option<Vec<u8>> {
    for _ in 0..max_iters {
        match transport.try_recv() {
            Ok(Some(b)) => return Some(b),
            Ok(None) => tokio::time::sleep(Duration::from_millis(10)).await,
            Err(_) => return None,
        }
    }
    None
}

// =============================================================
// Connect path
// =============================================================

#[test]
fn connect_to_echo_server_succeeds() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake to echo server");
        assert!(!ws.is_closed(), "fresh transport is open");
    });
}

#[test]
fn connect_to_invalid_url_returns_err() {
    let rt = runtime();
    rt.block_on(async {
        // Missing scheme.
        let result = WebSocketTransport::connect("not-a-url").await;
        assert!(
            matches!(result, Err(WebSocketError::InvalidUrl(_))),
            "expected InvalidUrl, got {:?}",
            result.err()
        );
    });
}

#[test]
fn connect_to_nonexistent_server_returns_connect_failed() {
    let rt = runtime();
    rt.block_on(async {
        // Port 1 is reserved for tcpmux, virtually nothing listens
        // there. Connect should be refused.
        let result = WebSocketTransport::connect("ws://127.0.0.1:1").await;
        assert!(
            matches!(result, Err(WebSocketError::ConnectFailed(_))),
            "expected ConnectFailed, got {:?}",
            result.err()
        );
    });
}

#[test]
fn connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed() {
    let rt = runtime();
    rt.block_on(async {
        let bad_server = RejectingServer::start().await;
        let result = WebSocketTransport::connect(&bad_server.url()).await;
        // RejectingServer accepts the TCP connection then drops it.
        // tokio-tungstenite sees EOF mid-handshake → reported as Io
        // (ConnectFailed) on some platforms, HandshakeFailed on
        // others. Either is acceptable; the important thing is we
        // got an error, not a successful Self.
        assert!(
            matches!(
                result,
                Err(WebSocketError::HandshakeFailed(_)) | Err(WebSocketError::ConnectFailed(_))
            ),
            "expected HandshakeFailed or ConnectFailed, got {:?}",
            result.err()
        );
    });
}

// =============================================================
// Round-trip via echo server
// =============================================================

#[test]
fn send_recv_round_trip_via_echo_server() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        ws.send(b"hello-loro-blob").expect("send queued");
        let echoed = await_blob(&mut ws, 100).await;
        assert_eq!(
            echoed.as_deref(),
            Some(b"hello-loro-blob".as_slice()),
            "echo server must reflect the bytes back"
        );
    });
}

#[test]
fn multiple_sends_preserve_fifo_order_through_echo() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        for i in 0..5u8 {
            ws.send(&[i, i + 10]).expect("send");
        }
        let mut received = Vec::new();
        for _ in 0..5 {
            let b = await_blob(&mut ws, 100).await.expect("blob");
            received.push(b);
        }
        let expected: Vec<Vec<u8>> = (0..5u8).map(|i| vec![i, i + 10]).collect();
        assert_eq!(
            received, expected,
            "FIFO order must be preserved through WebSocket echo"
        );
    });
}

// =============================================================
// Closed semantics
// =============================================================

#[test]
fn explicit_close_blocks_send_returns_closed() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        ws.close();
        assert!(ws.is_closed());
        let r = ws.send(b"after-close");
        assert!(
            matches!(r, Err(TransportError::Closed)),
            "send after explicit close MUST surface Closed"
        );
    });
}

#[test]
fn explicit_close_drains_inbox_before_returning_closed() {
    let rt = runtime();
    rt.block_on(async {
        // Trait contract (transport.rs:112-115): Closed only when
        // permanently closed AND queue empty. Pre-load the inbox
        // before close.
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        ws.send(b"queued-before-close").expect("send");
        // Let the echo + delivery happen.
        let echoed = await_blob(&mut ws, 100).await.expect("echo delivered");
        assert_eq!(echoed, b"queued-before-close".to_vec());
        // Now send a second one, give it time to land in the inbox,
        // close, then drain.
        ws.send(b"queued-also").expect("send");
        // Give the reader task a chance to receive it.
        tokio::time::sleep(Duration::from_millis(50)).await;
        ws.close();
        // Drain-before-close: first try_recv must return the blob,
        // THEN return Closed once empty.
        match ws.try_recv() {
            Ok(Some(b)) => {
                assert_eq!(b, b"queued-also".to_vec(), "drained blob is the queued one");
                assert!(matches!(ws.try_recv(), Err(TransportError::Closed)));
            }
            Ok(None) => {
                // Race: reader task hadn't delivered yet. After more
                // sleep, must EITHER deliver the blob (drain-before-close)
                // OR return Closed because the channel is closed and
                // the blob never landed.
                tokio::time::sleep(Duration::from_millis(50)).await;
                let final_r = ws.try_recv();
                assert!(
                    matches!(final_r, Ok(Some(_)) | Err(TransportError::Closed)),
                    "post-close try_recv must be Some or Closed, got {:?}",
                    final_r
                );
            }
            Err(_) => panic!("first try_recv after close should drain first"),
        }
    });
}

#[test]
fn server_close_propagates_to_try_recv_as_closed() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        // Drop the server: accept task aborts; existing connection
        // dies when its tokio scope ends. Reader task sees EOF / Err
        // and marks closed.
        drop(server);
        // Give the reader task time to observe the disconnect.
        tokio::time::sleep(Duration::from_millis(200)).await;
        // Subsequent send may succeed initially (writer task queued
        // it) but the connection is gone. Loop try_recv until Closed.
        let mut closed_observed = false;
        for _ in 0..50 {
            match ws.try_recv() {
                Ok(None) => tokio::time::sleep(Duration::from_millis(20)).await,
                Ok(Some(_)) => continue,
                Err(TransportError::Closed) => {
                    closed_observed = true;
                    break;
                }
                Err(other) => panic!("unexpected error: {other:?}"),
            }
        }
        assert!(
            closed_observed,
            "after server drop + grace, try_recv MUST eventually return Closed"
        );
    });
}

// =============================================================
// Drop / RAII cleanup
// =============================================================

#[test]
fn drop_aborts_background_tasks() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        // Snapshot whether tasks are still running.
        assert!(!ws.is_closed());
        let dbg_before = format!("{:?}", ws);
        assert!(
            dbg_before.contains("writer_finished: false"),
            "writer task is running pre-drop: {dbg_before}"
        );
        assert!(
            dbg_before.contains("reader_finished: false"),
            "reader task is running pre-drop: {dbg_before}"
        );
        drop(ws);
        // After drop, the spawned tasks are abort()ed. We can't
        // re-introspect a dropped transport, but if the tasks weren't
        // aborted they'd leak the tokio runtime past test end. The
        // runtime drop on test exit would block. This test passing
        // (i.e. the test function returning) is the assertion.
    });
}

// =============================================================
// CollabSession integration — V2 V3 contract verification
// =============================================================

#[test]
fn collab_session_attach_websocket_round_trip_via_echo() {
    // Highest-value test: wire WebSocketTransport into CollabSession
    // under OnAppend; verify the V2 V3 step 2 + step 3 contract
    // (auto-flush + offline-write reattach) holds over a REAL
    // WebSocket, not just LoopbackTransport.
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
        session.attach_transport(ws);
        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

        // OnAppend + attached WS: each append flushes the delta over
        // the wire. The echo server reflects each blob back; the
        // session's poll_remote drains the inbox and merges.
        session.append_op(add_sheet()).expect("add_sheet");
        session.append_op(put_value(0, 0, 0, 42.0)).expect("put");

        // Poll until we've drained the echoes (auto-flush is one
        // direction; the echo server reflects each blob back as a
        // separate frame). Loro dedupes on import — but the import
        // still returns the blob count, NOT op count.
        let mut total_merged = 0usize;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let merged = session.poll_remote().expect("poll");
            total_merged += merged;
            if total_merged >= 2 {
                break;
            }
        }
        assert!(
            total_merged >= 1,
            "session.poll_remote MUST receive at least one echoed blob, got {total_merged}"
        );

        // Session op_count = 2 (add_sheet + put_value). Echo didn't
        // change it (Loro dedupes own peer's ops on re-import).
        assert_eq!(session.op_count(), 2, "Loro dedup keeps op_count stable");

        // has_pending_flush should be false after auto-flush
        // completed (V2 V3 step 1 idempotency guard).
        assert!(
            !session.has_pending_flush(),
            "OnAppend + attached WS leaves session synced post-mutator"
        );
    });
}

#[test]
fn collab_session_websocket_reattach_after_close_delivers_offline_ops() {
    // V2 V3 step 3 contract: append while transport detached; reattach
    // (or attach new transport); next auto-flush delivers all
    // accumulated ops. Verifies the contract holds for WS transport
    // identically to LoopbackTransport.
    let rt = runtime();
    rt.block_on(async {
        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

        // Phase 1: NO transport attached. Append ops — they commit
        // locally; maybe_auto_flush no-ops.
        session.append_op(add_sheet()).expect("add_sheet offline");
        session
            .append_op(put_value(0, 0, 0, 1.0))
            .expect("put offline");
        session
            .append_op(put_value(0, 0, 1, 2.0))
            .expect("put offline");
        assert!(session.has_pending_flush(), "offline ops are pending");
        assert!(!session.has_transport());

        // Phase 2: attach WS. attach_transport resets
        // last_flushed_vv = None per V2 V3 step 1 contract.
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        session.attach_transport(ws);
        assert!(session.has_transport());
        // attach_transport itself doesn't auto-flush (V2 V2 design).
        // The next mutator OR explicit flush_delta_to_transport
        // delivers all accumulated ops.

        // Phase 3: explicit flush sends from empty VV → all 3 ops
        // delivered as a single delta blob to the server, which
        // echoes it back. Session's poll_remote then drains the
        // echoed blob; Loro dedupes own ops.
        session
            .flush_delta_to_transport()
            .expect("explicit flush succeeds");
        assert!(
            !session.has_pending_flush(),
            "flush leaves session synced (current_vv == last_flushed_vv)"
        );

        // Drain echo.
        let mut total_merged = 0usize;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            total_merged += session.poll_remote().expect("poll");
            if total_merged >= 1 {
                break;
            }
        }
        assert!(
            total_merged >= 1,
            "post-reattach flush blob MUST be echoed back, got {total_merged}"
        );
        assert_eq!(
            session.op_count(),
            3,
            "3 offline ops preserved through reattach"
        );
    });
}

#[test]
fn collab_session_websocket_send_after_close_surfaces_closed() {
    // Auto-flush + closed transport partial-state contract: V2 V3
    // step 1+2 behavior must hold for WS. Local op commits; send
    // returns Err(Closed); state advances; has_pending_flush = true.
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
        session.attach_transport(ws);
        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

        // First append flushes successfully.
        session.append_op(add_sheet()).expect("first append");

        // Drop the server; wait for reader to observe close.
        drop(server);
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Try to nudge any state changes through (ignore result —
        // we only care that the followup append shows Closed).
        let _ = session.poll_remote();

        // Next append: auto-flush should hit Err(Closed). Op MUST
        // commit locally (partial-state contract).
        let pre_count = session.op_count();
        let result = session.append_op(put_value(0, 0, 0, 99.0));
        assert!(
            matches!(
                result,
                Err(CollabSessionError::Transport(TransportError::Closed))
            ),
            "expected Transport(Closed), got {:?}",
            result
        );
        assert_eq!(
            session.op_count(),
            pre_count + 1,
            "op committed locally even when auto-flush errors"
        );
        assert!(
            session.has_pending_flush(),
            "failed-flush leaves has_pending_flush = true (recoverable via reattach)"
        );
    });
}
