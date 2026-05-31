//! Phase 6.2-2 HTTP integration tests -- the operations/events surface over REAL
//! HTTP: the M2 split-recalc (`start-recalc`/`await-recalc`), op-id `cancel`/
//! `operation-status`, the one-shot `poll-events`, and the SVC-6-02 long-lived
//! `text/event-stream` events endpoint.
//!
//! The buffered endpoints reuse the same hand-rolled `http()` client as the other
//! cluster tests. The SSE endpoint never ends, so it uses a bounded `sse_read`
//! (per-read `tokio::time::timeout` + an overall iteration cap) that reads until a
//! marker appears or the deadline passes, then drops the connection.

use std::net::SocketAddr;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use ql_service::{serve, SessionStore};

async fn http(addr: SocketAddr, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read response");
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .expect("response has header/body split");
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .expect("status code");
    (status, body.to_string())
}

/// Bounded SSE reader: opens the stream, reads until `want` appears in the body or
/// the iteration budget is exhausted, then drops the connection. Returns the bytes
/// read so far (header + frames) as a string.
async fn sse_read(addr: SocketAddr, path: &str, want: &str) -> String {
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: text/event-stream\r\n\r\n"
    );
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    let mut buf = Vec::new();
    // Up to ~6s total (24 * 250ms read slices) -- generous vs the 250ms SSE cadence.
    for _ in 0..24 {
        let mut chunk = [0u8; 4096];
        match tokio::time::timeout(Duration::from_millis(250), stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break, // EOF
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                if String::from_utf8_lossy(&buf).contains(want) {
                    break;
                }
            }
            Ok(Err(_)) => break,
            Err(_) => { /* no data this slice; keep waiting */ }
        }
    }
    // Drop `stream` here -> the server's SSE loop sees the disconnect and ends.
    String::from_utf8_lossy(&buf).into_owned()
}

async fn new_session(addr: SocketAddr) -> String {
    let (st, body) = http(addr, "POST", "/v1/sessions", None).await;
    assert_eq!(st, 201, "create session: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn add_sheet(addr: SocketAddr, base: &str, name: &str) -> u64 {
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/add-sheet"),
        Some(&format!(r#"{{"name":"{name}","chunkRows":1000}}"#)),
    )
    .await;
    assert_eq!(st, 200, "add-sheet: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["sheetId"]
        .as_u64()
        .expect("sheetId")
}

async fn set_number(addr: SocketAddr, base: &str, sheet: u64, row: u64, col: u64, n: f64) {
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-value"),
        Some(&format!(
            r#"{{"sheet":{sheet},"row":{row},"col":{col},"value":{{"kind":"number","number":{n}}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
}

async fn set_formula(addr: SocketAddr, base: &str, sheet: u64, row: u64, col: u64, text: &str) {
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-formula"),
        Some(&format!(
            r#"{{"sheet":{sheet},"row":{row},"col":{col},"text":"{text}"}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
}

async fn cell_number(addr: SocketAddr, base: &str, sheet: u64, row: u64, col: u64) -> Option<f64> {
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cell"),
        Some(&format!(r#"{{"sheet":{sheet},"row":{row},"col":{col}}}"#)),
    )
    .await;
    assert_eq!(st, 200, "cell: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["value"]["number"].as_f64()
}

async fn start_recalc(addr: SocketAddr, base: &str, kind: &str) -> String {
    let (st, body) = http(addr, "POST", &format!("{base}/start-recalc?kind={kind}"), None).await;
    assert_eq!(st, 200, "start-recalc: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["op"]
        .as_str()
        .expect("op decimal string")
        .to_string()
}

async fn await_recalc(addr: SocketAddr, base: &str, op: &str) {
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/await-recalc"),
        Some(&format!(r#"{{"op":"{op}"}}"#)),
    )
    .await;
    assert_eq!(st, 200, "await-recalc: {body}");
}

async fn operation_state(addr: SocketAddr, base: &str, op: &str) -> String {
    let (st, body) = http(addr, "GET", &format!("{base}/operation-status?op={op}"), None).await;
    assert_eq!(st, 200, "operation-status: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["state"]
        .as_str()
        .unwrap()
        .to_string()
}

fn code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body).ok()?["code"]
        .as_str()
        .map(str::to_string)
}

#[tokio::test]
async fn ops_split_recalc_observable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;

    // A1=6, B1=A1*2 (eager 12), then A1=7 -> B1 is STALE at 12 until a recalc.
    set_number(addr, &base, sh, 0, 0, 6.0).await;
    set_formula(addr, &base, sh, 0, 1, "A1*2").await;
    assert_eq!(cell_number(addr, &base, sh, 0, 1).await, Some(12.0));
    set_number(addr, &base, sh, 0, 0, 7.0).await;
    assert_eq!(
        cell_number(addr, &base, sh, 0, 1).await,
        Some(12.0),
        "B1 stays the stale eager 12 until a recalc runs"
    );

    // split recalc: start (reserve op, no run) -> status running -> await (run) ->
    // B1 recomputes to 14 (OBSERVABLE: a no-op await leaves 12) -> status completed.
    let op = start_recalc(addr, &base, "dirty").await;
    assert_eq!(operation_state(addr, &base, &op).await, "running");
    await_recalc(addr, &base, &op).await;
    assert_eq!(
        cell_number(addr, &base, sh, 0, 1).await,
        Some(14.0),
        "awaitRecalc actually recomputed B1 = A1*2 = 14"
    );
    assert_eq!(operation_state(addr, &base, &op).await, "completed");

    server.abort();
}

#[tokio::test]
async fn ops_pre_start_cancel_window() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;

    // Set up a STALE dependent cell so the skip is OBSERVABLE: A1=6, B1=A1*2 (eager
    // 12), A1=7 -> B1 stale at 12 until a recalc runs (6.2-2 audit Codex LOW).
    set_number(addr, &base, sh, 0, 0, 6.0).await;
    set_formula(addr, &base, sh, 0, 1, "A1*2").await;
    set_number(addr, &base, sh, 0, 0, 7.0).await;
    assert_eq!(cell_number(addr, &base, sh, 0, 1).await, Some(12.0));

    // start reserves the op; cancel lands in the pre-start window (true); await then
    // SKIPS the recompute; status is canceled.
    let op = start_recalc(addr, &base, "dirty").await;
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cancel"),
        Some(&format!(r#"{{"op":"{op}"}}"#)),
    )
    .await;
    assert_eq!(st, 200, "cancel: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        Value::Bool(true),
        "cancel in the pre-start window registers (true)"
    );
    await_recalc(addr, &base, &op).await;
    assert_eq!(operation_state(addr, &base, &op).await, "canceled");
    // OBSERVABLE skip: the canceled recalc did NOT recompute -> B1 stays stale at 12
    // (a broken impl that recomputed but still marked the op canceled would show 14).
    assert_eq!(
        cell_number(addr, &base, sh, 0, 1).await,
        Some(12.0),
        "canceled recalc skipped the recompute -> B1 unchanged at 12"
    );

    // canceling an already-terminal op -> false (not an error).
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cancel"),
        Some(&format!(r#"{{"op":"{op}"}}"#)),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        Value::Bool(false),
        "canceling a terminal op is false"
    );

    server.abort();
}

#[tokio::test]
async fn ops_unknown_op_and_missing_cursor_negatives() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");

    // unknown op -> 404 operation_not_found on both cancel + operation-status.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cancel"),
        Some(r#"{"op":"999999"}"#),
    )
    .await;
    assert_eq!(st, 404, "cancel unknown -> 404: {body}");
    assert_eq!(code(&body).as_deref(), Some("operation_not_found"));
    let (st, body) = http(
        addr,
        "GET",
        &format!("{base}/operation-status?op=999999"),
        None,
    )
    .await;
    assert_eq!(st, 404, "status unknown -> 404: {body}");
    assert_eq!(code(&body).as_deref(), Some("operation_not_found"));

    // poll-events missing the required ?cursor= -> 400 bad_argument (No-Fallbacks).
    let (st, body) = http(addr, "GET", &format!("{base}/poll-events"), None).await;
    assert_eq!(st, 400, "poll-events missing cursor -> 400: {body}");
    assert_eq!(code(&body).as_deref(), Some("bad_argument"));

    server.abort();
}

#[tokio::test]
async fn poll_events_page_carries_operation_completed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let _sh = add_sheet(addr, &base, "S").await;

    // run a recalc to push an operation_completed event into the ring.
    let op = start_recalc(addr, &base, "all").await;
    await_recalc(addr, &base, &op).await;

    let (st, body) = http(addr, "GET", &format!("{base}/poll-events?cursor=0"), None).await;
    assert_eq!(st, 200, "poll-events: {body}");
    let page: Value = serde_json::from_str(&body).unwrap();
    let events = page["events"].as_array().expect("events array");
    assert!(
        events
            .iter()
            .any(|e| e["kind"].as_str() == Some("operation_completed")),
        "the ring carries operation_completed: {body}"
    );
    // nextCursor is a decimal STRING (the frozen u64 convention) and advanced past 0.
    let next = page["nextCursor"].as_str().expect("nextCursor decimal string");
    assert!(next.parse::<u64>().unwrap() >= 1, "nextCursor advanced: {body}");

    server.abort();
}

#[tokio::test]
async fn sse_events_stream_forwards_the_ring() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let _sh = add_sheet(addr, &base, "S").await;

    // generate an operation_completed event in the ring BEFORE connecting.
    let op = start_recalc(addr, &base, "all").await;
    await_recalc(addr, &base, &op).await;

    // connect the SSE stream from cursor 0; the first poll forwards the buffered ring.
    let got = sse_read(addr, &format!("{base}/events?cursor=0"), "operation_completed").await;
    assert!(
        got.contains("text/event-stream"),
        "response is an event-stream: {got:?}"
    );
    assert!(
        got.contains("data:") && got.contains("operation_completed"),
        "SSE stream forwarded the operation_completed event: {got:?}"
    );

    server.abort();
}
