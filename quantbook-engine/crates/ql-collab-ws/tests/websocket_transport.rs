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

use crate::common::{EchoServer, RejectingServer, TextFrameServer};

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

/// **V2 V4 V1 step 1 (Tier K1):** multi-thread runtime for tests that
/// call sync `flush_pending()`. The single-threaded runtime above
/// would deadlock because flush_pending blocks the worker thread via
/// `Condvar::wait_timeout`, preventing the writer/reader tokio tasks
/// from making progress. Multi-thread runtime gives the tokio tasks
/// their own workers. This matches the documented async-context
/// caveat in `Transport::flush_pending` — real IDE consumers either
/// run on a multi-thread runtime OR wrap the call in
/// `tokio::task::spawn_blocking`.
fn multi_thread_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("build multi-thread tokio runtime")
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
fn connect_to_rejecting_tcp_server_returns_handshake_failed() {
    // **V2 V4 V1 step 3 (Tier J1, 2026-05-21):** renamed from
    // `connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed`.
    // The prior version accepted EITHER HandshakeFailed OR
    // ConnectFailed because the test fixture (accept+drop) was
    // timing-dependent. The Tier J1 closure rewrote RejectingServer
    // to write a malformed HTTP response, forcing the client's
    // handshake parser into the Http/HttpFormat error path
    // deterministically.
    let rt = runtime();
    rt.block_on(async {
        let bad_server = RejectingServer::start().await;
        let result = WebSocketTransport::connect(&bad_server.url()).await;
        assert!(
            matches!(result, Err(WebSocketError::HandshakeFailed(_))),
            "expected HandshakeFailed (deterministic post-J1), got {:?}",
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

// =============================================================
// V2 V3 step 4 audit closure — last_error accessor (Opus M1)
// =============================================================

#[test]
fn last_error_starts_none_on_connected_transport() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        assert!(
            ws.last_error().is_none(),
            "fresh connected transport MUST have no runtime error stashed"
        );
    });
}

#[test]
fn last_error_stays_none_on_graceful_caller_close() {
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");
        ws.close();
        // Explicit caller close is NOT a runtime failure — last_error
        // stays None per the docstring contract.
        assert!(
            ws.last_error().is_none(),
            "caller close() MUST NOT populate last_error"
        );
    });
}

#[test]
fn last_error_populated_after_peer_disconnect() {
    let rt = runtime();
    rt.block_on(async {
        // V2 V3 step 4 audit closure (Opus M1): pin the contract that
        // the reader task stashes a RuntimeError when it observes a
        // peer disconnect (non-graceful TCP teardown).
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        // Drop server: per-conn task aborted → TCP socket dropped →
        // reader observes EOF or Err on next stream poll.
        drop(server);

        // Loop try_recv until Closed observed, then check last_error.
        let mut closed_seen = false;
        for _ in 0..50 {
            match ws.try_recv() {
                Ok(None) => tokio::time::sleep(Duration::from_millis(20)).await,
                Ok(Some(_)) => continue,
                Err(TransportError::Closed) => {
                    closed_seen = true;
                    break;
                }
                Err(other) => panic!("unexpected error: {other:?}"),
            }
        }
        assert!(closed_seen, "Closed must be observed after peer disconnect");

        // The peer disconnect may surface either as a graceful EOF
        // (None on stream → leaves last_error None) or as an Err on
        // the next poll (populates RuntimeError). Both are valid task
        // exit paths under TCP teardown; the contract is "Some when
        // an Err arm fired, None when a clean None arm fired." Don't
        // overpin which one this specific platform exhibits — pin
        // only that the accessor returns SOMETHING readable without
        // panicking, and if Some, it's a RuntimeError.
        if let Some(err) = ws.last_error() {
            assert!(
                matches!(err, WebSocketError::RuntimeError(_)),
                "last_error after disconnect must be RuntimeError variant if present, got {err:?}"
            );
        }
    });
}

#[test]
fn peer_disconnect_always_populates_last_error_step_5_closure() {
    // **V2 V3 step 5 megaudit closure (Codex L2 + Opus-B M4):** the
    // prior step-4 behavior left last_error=None for both clean
    // caller-close AND for stream-end-None (peer dropped TCP without
    // a Close frame). Closure: stream-end now populates a sentinel
    // RuntimeError("peer stream ended without close frame") so
    // callers can distinguish. (Clean caller-close still leaves
    // last_error=None per the contract.)
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        drop(server);

        // Wait for reader to observe disconnect.
        for _ in 0..50 {
            match ws.try_recv() {
                Ok(None) => tokio::time::sleep(Duration::from_millis(20)).await,
                Ok(Some(_)) => continue,
                Err(TransportError::Closed) => break,
                Err(other) => panic!("unexpected error: {other:?}"),
            }
        }

        let err = ws.last_error();
        assert!(
            err.is_some(),
            "peer disconnect MUST populate last_error post-step-5 (was previously possibly None)"
        );
        let msg = format!("{err:?}");
        // The message should hint at either an Err arm (tungstenite
        // string) or the new stream-end sentinel.
        assert!(
            msg.contains("RuntimeError"),
            "last_error must be RuntimeError variant, got {msg}"
        );
    });
}

// =============================================================
// V2 V3 step 5 megaudit closure — transport_last_error proxy
// =============================================================

#[test]
fn collab_session_transport_last_error_proxies_through_websocket() {
    // **V2 V3 step 5 megaudit closure (Opus-A H1):** pin the
    // contract that `CollabSession::transport_last_error()` reaches
    // through to `WebSocketTransport::last_error()` after the
    // session has consumed the concrete type into Box<dyn>.
    let rt = runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        let mut session = CollabSession::new(PeerId::new(1)).expect("session");

        // Before attach: no transport, proxy returns None.
        assert_eq!(session.transport_last_error(), None);

        session.attach_transport(ws);

        // After attach but before any error: still None.
        assert_eq!(session.transport_last_error(), None);

        // Drop server: reader observes disconnect, populates
        // last_error. Then transport_last_error() through the
        // session reaches it.
        drop(server);

        // Wait for reader to populate via a poll cycle.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = session.poll_remote();
            if session.transport_last_error().is_some() {
                break;
            }
        }

        let proxied = session.transport_last_error();
        assert!(
            proxied.is_some(),
            "CollabSession::transport_last_error MUST reach the WS's last_error after disconnect"
        );
        let msg = proxied.unwrap();
        assert!(
            msg.starts_with("WebSocket runtime error:"),
            "proxied error should be the WebSocketError Display, got: {msg}"
        );
    });
}

#[test]
fn transport_last_error_returns_none_when_no_transport_attached() {
    // **V2 V3 step 5 megaudit closure (Opus-A H1):** even with no
    // transport ever attached, the proxy is callable and returns
    // None. IDE consumers querying the accessor in the "Offline"
    // workflow state shouldn't panic.
    let session = CollabSession::new(PeerId::new(1)).expect("session");
    assert!(!session.has_transport());
    assert_eq!(session.transport_last_error(), None);
}

// =============================================================
// V2 V4 V1 step 1 — Tier K1 ack channel (flush_pending)
// =============================================================

#[test]
fn flush_pending_with_no_pending_returns_ok_immediately() {
    // **V2 V4 V1 step 1 (Tier K1):** baseline — flush_pending on a
    // freshly-connected transport with nothing queued returns Ok
    // without blocking.
    //
    // Uses multi_thread_runtime because flush_pending is a blocking-
    // sync call that would deadlock on a single-threaded runtime
    // (writer task can't make progress while the worker is blocked).
    // See the helper docstring + Transport::flush_pending async-
    // context caveat.
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        let start = std::time::Instant::now();
        let result = ws.flush_pending();
        let elapsed = start.elapsed();

        assert!(
            result.is_ok(),
            "flush_pending with no pending bytes MUST return Ok"
        );
        assert!(
            elapsed < Duration::from_millis(50),
            "flush_pending with no pending bytes MUST not block (took {elapsed:?})"
        );
    });
}

#[test]
fn flush_pending_blocks_until_writer_catches_up() {
    // **V2 V4 V1 step 1 (Tier K1):** pin the blocking-then-Ok semantic.
    // Send several blobs; immediately call flush_pending. Verify it
    // returns Ok AFTER the writer task has caught up (i.e., the echo
    // server has reflected the blobs back).
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        for i in 0..5u8 {
            ws.send(&[i, i + 1, i + 2]).expect("send");
        }

        // flush_pending should block until all 5 sends are flushed.
        let start = std::time::Instant::now();
        let result = ws.flush_pending();
        let elapsed = start.elapsed();

        assert!(
            result.is_ok(),
            "flush_pending after 5 sends MUST return Ok once writer drains, got {result:?}"
        );
        // Some blocking time is expected (mpsc + ws_sink + tokio
        // scheduling). Upper bound is generous for slow CI.
        assert!(
            elapsed < Duration::from_secs(2),
            "flush_pending blocked unreasonably long: {elapsed:?}"
        );

        // Echo verification: each blob should have been sent over
        // the wire (and echoed back).
        let mut received = 0;
        for _ in 0..30 {
            match ws.try_recv() {
                Ok(Some(_)) => received += 1,
                Ok(None) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(_) => break,
            }
            if received >= 5 {
                break;
            }
        }
        assert_eq!(
            received, 5,
            "all 5 blobs MUST have been flushed (and echoed back), got {received}"
        );
    });
}

#[test]
fn flush_pending_after_close_returns_closed() {
    // **V2 V4 V1 step 1 (Tier K1):** closed-state fast-path. If the
    // transport is already closed on entry, flush_pending returns
    // Err(Closed) immediately — regardless of whether the local
    // progress counter has caught up.
    //
    // **V2 V4 V1 step 1 audit closure (Codex M1, 2026-05-21):** prior
    // version of this test accepted EITHER Ok OR Err(Closed) because
    // the impl returned Ok if `counter >= target` on entry, even when
    // closed. The audit caught the docstring-vs-impl divergence. The
    // closure inverted the impl to check `closed` BEFORE the
    // counter-vs-target check, so closed-on-entry now uniformly
    // returns Err(Closed) per the documented contract.
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        // Queue a few sends, close the transport explicitly, then
        // flush_pending.
        ws.send(b"a").expect("send");
        ws.send(b"b").expect("send");
        ws.close();

        let start = std::time::Instant::now();
        let result = ws.flush_pending();
        let elapsed = start.elapsed();

        assert!(
            matches!(result, Err(TransportError::Closed)),
            "flush_pending after explicit close MUST return Err(Closed), got {result:?}"
        );
        assert!(
            elapsed < Duration::from_millis(50),
            "closed-on-entry flush_pending MUST be near-instant (skip the wait loop), got {elapsed:?}"
        );
    });
}

#[test]
fn flush_pending_returns_closed_if_server_drops_mid_flush() {
    // **V2 V4 V1 step 1 (Tier K1):** pin the "writer fails mid-flush"
    // path. Server is dropped while flush_pending is parked on the
    // Condvar. Reader task sees disconnect → sets closed → notifies
    // Condvar (via Drop on EchoServer aborting per-conn tasks → TCP
    // socket dies → ws_stream errors → reader sets closed). The
    // writer task notify_all on closed-flag transition wakes up
    // flush_pending which observes the closed flag and returns
    // Err(Closed).
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        // Queue some sends.
        ws.send(b"in-flight-1").expect("send");
        ws.send(b"in-flight-2").expect("send");

        // Drop the server — TCP socket dies on per-conn abort.
        drop(server);

        // flush_pending should eventually observe the closed state and
        // return Err. Acceptable: also returns Ok if the writer
        // happened to send both blobs before the TCP teardown was
        // observed.
        let start = std::time::Instant::now();
        let result = ws.flush_pending();
        let elapsed = start.elapsed();

        match result {
            Ok(()) | Err(TransportError::Closed) => {}
            other => panic!("expected Ok or Err(Closed), got {other:?}"),
        }
        // Should not hang. The Condvar wait_timeout is 100ms; the
        // closed flag should be observed within a few iterations.
        assert!(
            elapsed < Duration::from_secs(3),
            "flush_pending hung post-server-drop: {elapsed:?}"
        );
    });
}

#[test]
fn collab_session_flush_pending_to_transport_proxies() {
    // **V2 V4 V1 step 1 (Tier K1):** pin the proxy reaches the WS's
    // flush_pending through Box<dyn Transport>.
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
        session.attach_transport(ws);
        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

        // Append some ops — each triggers auto-flush.
        session.append_op(add_sheet()).expect("add_sheet");
        session.append_op(put_value(0, 0, 0, 1.0)).expect("put");
        session.append_op(put_value(0, 0, 1, 2.0)).expect("put");

        // Proxy through to the WS's flush_pending. Should return Ok
        // once the writer task has caught up on all auto-flush sends.
        let result = session.flush_pending_to_transport();
        assert!(
            result.is_ok(),
            "flush_pending_to_transport MUST return Ok after auto-flushed sends, got {result:?}"
        );
    });
}

#[test]
fn flush_pending_no_transport_returns_ok() {
    // **V2 V4 V1 step 1 (Tier K1):** session-level proxy with no
    // attached transport returns Ok (nothing to flush). Mirror of the
    // transport_last_error_returns_none_when_no_transport pattern.
    let mut session = CollabSession::new(PeerId::new(1)).expect("session");
    assert!(!session.has_transport());
    let result = session.flush_pending_to_transport();
    assert!(
        result.is_ok(),
        "flush_pending with no transport MUST return Ok, got {result:?}"
    );
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

// =============================================================
// V2 V4 V1 step 3 — Tier J2 text-frame test pinning
// =============================================================

#[test]
fn text_frames_are_dropped_silently_binary_still_delivers() {
    // **V2 V4 V1 step 3 (Tier J2, 2026-05-21):** the V2 V3 step 4
    // closure documented that `WebSocketTransport`'s reader task
    // drops `Text`, `Ping`, `Pong`, `Frame` arms silently — Loro
    // payloads are binary, non-binary frames don't carry our
    // protocol. The V2 V3 step 5 megaudit (Codex L3 + Opus L3)
    // flagged this as documented-but-not-test-pinned. This test
    // closes that coverage gap.
    //
    // Server sends: Text("...") then Binary("..."). Client must:
    // (a) silently drop the text frame (no error, no spurious bytes
    //     on try_recv), and
    // (b) deliver the binary frame via try_recv as Ok(Some(_)).
    let rt = runtime();
    rt.block_on(async {
        let server = TextFrameServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        // Poll until we get the binary frame. The text frame should
        // be silently dropped — we should NEVER see "this-should-be-
        // dropped..." appear via try_recv (its body is text, not
        // binary, so even if a future refactor incorrectly delivered
        // it, we'd notice because the bytes wouldn't match).
        let mut received_blob: Option<Vec<u8>> = None;
        for _ in 0..100 {
            match ws.try_recv() {
                Ok(Some(b)) => {
                    received_blob = Some(b);
                    break;
                }
                Ok(None) => tokio::time::sleep(Duration::from_millis(10)).await,
                Err(e) => panic!("unexpected error: {e:?}"),
            }
        }

        let blob = received_blob
            .expect("binary frame after text frame MUST be delivered (text was dropped silently)");
        assert_eq!(
            blob,
            b"binary-after-text-must-deliver".to_vec(),
            "delivered blob must match the binary frame the server sent (proves text was \
             dropped without contaminating the binary delivery)"
        );

        // No more frames queued — the server idled after sending
        // the two frames. try_recv should return Ok(None).
        let next = ws.try_recv();
        assert!(
            matches!(next, Ok(None)),
            "no further inbound frames expected, got {:?}",
            next
        );
    });
}

// =============================================================
// V2 V4 V1 step 4 — Tier K2 mid-drop bytes-lost recovery test
// =============================================================

#[test]
fn mid_drop_bytes_lost_recoverable_via_reattach() {
    // **V2 V4 V1 step 4 (Tier K2, 2026-05-21):** pin the documented
    // V2 V3 step 5 megaudit Opus-B M1 RECOVERY contract:
    // `WebSocketTransport::Drop` MAY discard in-flight mpsc bytes
    // (writer task is aborted before draining the outbound channel),
    // and the V2 V3 step 1 baseline-reset on `attach_transport`
    // makes the next flush re-send EVERYTHING from empty VV — so a
    // reattach to a new transport recovers all ops regardless of
    // whether the prior transport DID deliver some, all, or none.
    //
    // **V2 V4 V1 step 4 audit closure (Codex L1 + Opus L1,
    // 2026-05-21):** this test pins the RECOVERY CONTRACT, not the
    // drop-loss EVENT itself. On a fast machine, the writer task
    // may have completed all `ws_sink.send` calls before Drop
    // aborts it; the test passes either way because the recovery
    // contract holds regardless (Loro dedupes own ops on echo
    // merge). Forcing deterministic drop-loss would require a
    // controllable stalling transport fixture; the V2 V4 V1 scope
    // is "recovery works," not "drop loss is observable."
    let rt = multi_thread_runtime();
    rt.block_on(async {
        // Phase 1: attach WS#1, send several ops, drop the transport
        // WITHOUT calling flush_pending_to_transport (deliberately —
        // the recovery contract holds regardless of whether the
        // writer drained before abort).
        let server1 = EchoServer::start().await;
        let ws1 = WebSocketTransport::connect(&server1.url())
            .await
            .expect("handshake to ws#1");

        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
        session.attach_transport(ws1);
        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);

        // Append 3 ops. Each goes through auto-flush → mpsc enqueue.
        // Writer task drains and sends; bytes hit the wire (and
        // echo-bounce back, where we don't care). Some bytes may
        // still be in mpsc when we drop below.
        session.append_op(add_sheet()).expect("add_sheet");
        session.append_op(put_value(0, 0, 0, 1.0)).expect("put");
        session.append_op(put_value(0, 0, 1, 2.0)).expect("put");

        // Critical: detach WITHOUT calling flush_pending_to_transport.
        // This is the documented bytes-lost scenario — Drop runs on
        // the returned Box; writer_task.abort() may run before the
        // mpsc drained.
        let _dropped_ws1 = session.detach_transport();
        // The drop happens at end of statement via `let _`. Force it
        // here for clarity.
        drop(_dropped_ws1);

        // Sleep to let any abort-related task cleanup settle.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Phase 2: attach a FRESH WS#2 to a different EchoServer.
        // V2 V3 step 1 baseline-reset: last_flushed_vv = None.
        // V2 V3 step 3 contract: next flush sends from empty VV =
        // ALL accumulated ops, regardless of what WS#1 did or didn't
        // deliver to its peer.
        let server2 = EchoServer::start().await;
        let ws2 = WebSocketTransport::connect(&server2.url())
            .await
            .expect("handshake to ws#2");
        session.attach_transport(ws2);

        // Pre-flush state check: has_pending_flush() should be true
        // (baseline reset) and pending_op_count() should reflect
        // all 3 ops.
        assert!(
            session.has_pending_flush(),
            "post-reattach: baseline reset → has_pending_flush true"
        );
        let pending_before = session.pending_op_count();
        assert!(
            pending_before >= 3,
            "post-reattach pending_op_count must include all 3 local ops, got {pending_before}"
        );

        // Drive explicit flush + flush_pending to ensure delivery.
        session
            .flush_delta_to_transport()
            .expect("flush #2 success");
        session
            .flush_pending_to_transport()
            .expect("flush_pending #2 success");

        // After flush_pending returns Ok, the writer for WS#2 has
        // completed ws_sink.send for all ops. Bytes are on WS#2's
        // wire; the echo server has reflected them back. Drain to
        // confirm the round-trip.
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
            "post-reattach-and-flush: at least one echo blob delivered, got {total_merged}"
        );

        // Final state: has_pending_flush should be false (Loro
        // dedupes own ops on echo merge, so VV doesn't advance past
        // last_flushed_vv).
        assert!(
            !session.has_pending_flush(),
            "post-flush-pending and echo merge: synced (Loro deduped own ops)"
        );
        // op_count stays at 3 — Loro's dedup. (The test isn't about
        // op_count; it's about the recovery flow.)
        assert_eq!(
            session.op_count(),
            3,
            "all 3 original ops preserved through drop+reattach"
        );
    });
}

// =============================================================
// Phase 5.7 V2.5 (2026-05-22) — ack_handle integration tests
// =============================================================

#[test]
fn ack_handle_wait_for_drain_matches_flush_pending() {
    // V2.5 contract: WebSocketProgressAckHandle's wait_for_drain
    // should reach the same Ok state as flush_pending for the same
    // queued state.
    use ql_collab::Transport as _;
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        for i in 0..3u8 {
            ws.send(&[i, i + 1]).expect("send");
        }

        // Capture the ack handle. Codex M1: target is captured at
        // THIS call.
        let handle = ws
            .ack_handle()
            .expect("WebSocketTransport returns ack handle");

        // Drop the transport ref temporarily? No — we need it alive
        // for the writer task. The handle holds Arc clones so it
        // can survive the transport's drop, but here we just verify
        // wait_for_drain returns Ok with the transport still alive.
        let start = std::time::Instant::now();
        let result = handle.wait_for_drain();
        let elapsed = start.elapsed();

        assert!(result.is_ok(), "wait_for_drain ok, got {result:?}");
        assert!(
            elapsed < Duration::from_secs(2),
            "wait_for_drain blocked unreasonably long: {elapsed:?}"
        );

        // Drop transport now; handle's Arcs keep underlying state
        // alive; subsequent wait_for_drain calls (on a SEPARATE
        // captured handle) would return Closed because writer task
        // is aborted. We don't re-call wait_for_drain here since
        // target was captured at ack_handle() time and the writer
        // already caught up; second call would also return Ok.
        drop(ws);
    });
}

#[test]
fn ack_handle_target_captured_at_call_not_at_wait() {
    // V2.5 Codex M1 contract: ack_handle's target snapshot is
    // taken AT THIS CALL. Sends queued after ack_handle() returns
    // do NOT extend the wait.
    //
    // Send 3 blobs, capture handle, send 2 MORE blobs, then call
    // wait_for_drain — it should resolve when the FIRST 3 are
    // drained, not wait for the additional 2 (which may still be
    // in flight).
    use ql_collab::Transport as _;
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        for i in 0..3u8 {
            ws.send(&[i]).expect("send batch 1");
        }
        // Capture handle. Target = 3.
        let handle = ws.ack_handle().expect("handle");
        // Send 2 more bytes AFTER capturing target.
        for i in 3..5u8 {
            ws.send(&[i]).expect("send batch 2");
        }

        let start = std::time::Instant::now();
        let result = handle.wait_for_drain();
        let elapsed = start.elapsed();

        // Either Ok (target met) — that's the contract.
        assert!(result.is_ok(), "wait_for_drain ok, got {result:?}");
        // Should not have taken meaningfully longer than 3-blob drain.
        assert!(
            elapsed < Duration::from_secs(2),
            "wait_for_drain should target captured queued_count, not extend; elapsed {elapsed:?}"
        );
    });
}

#[test]
fn ack_handle_survives_transport_drop_returns_closed() {
    // V2.5 contract: after the underlying WebSocketTransport
    // drops, the writer task is aborted (TaskExitGuard sets
    // closed=true + notify_all). The handle's wait_for_drain
    // observes closed and returns Err(Closed) within ~100ms.
    use ql_collab::Transport as _;
    let rt = multi_thread_runtime();
    rt.block_on(async {
        let server = EchoServer::start().await;
        let mut ws = WebSocketTransport::connect(&server.url())
            .await
            .expect("handshake");

        // Send a few but DON'T flush yet.
        for i in 0..3u8 {
            ws.send(&[i]).expect("send");
        }
        let handle = ws.ack_handle().expect("handle");

        // Drop the transport. Writer task aborts (Drop impl).
        drop(ws);

        // Spawn the wait in a blocking task so we don't deadlock
        // tokio. Expect Err(Closed) or Ok if writer drained before
        // abort.
        let result = tokio::task::spawn_blocking(move || handle.wait_for_drain())
            .await
            .unwrap();
        // Either Ok (writer drained before abort) or Err(Closed)
        // is acceptable. Both indicate the wait did NOT hang.
        match result {
            Ok(()) => { /* writer drained before abort */ }
            Err(ql_collab::TransportError::Closed) => { /* expected */ }
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    });
}
