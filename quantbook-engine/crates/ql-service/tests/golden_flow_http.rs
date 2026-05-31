//! Phase 6.2-0 (2026-06-01) -- golden-flow HTTP integration test (SVC-6-01).
//!
//! Spins up the service on an ephemeral port and drives the golden flow over REAL
//! HTTP/1.1 (a tiny hand-rolled `Connection: close` client -- no extra client dep).
//! Asserts the freeze-critical wire properties: an OBSERVABLE recompute, u64 ids
//! as quoted DECIMAL STRINGS, errors as `problem+json`, and the panic boundary
//! returning a `[panic]` 500 WITHOUT killing the server. This is the seed of the
//! 6.2-4 golden-parity third row.

use std::net::SocketAddr;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use ql_service::{serve, SessionStore};

/// Minimal HTTP/1.1 client: send one request with `Connection: close`, read the
/// whole response to EOF, return `(status, content_type, body_string)`.
async fn http_full(
    addr: SocketAddr,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (u16, String, String) {
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
    // case-insensitive `Content-Type:` header lookup.
    let content_type = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-type") {
                Some(v.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();
    (status, content_type, body.to_string())
}

/// Convenience wrapper returning just `(status, body)` (header asserted via
/// [`http_full`] where it matters).
async fn http(addr: SocketAddr, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let (st, _ct, body) = http_full(addr, method, path, body).await;
    (st, body)
}

/// Find a cell's value-number in a snapshot body by (sheet index 0, row, col).
fn b1_number(snapshot_body: &str, row: u64, col: u64) -> Option<f64> {
    let v: Value = serde_json::from_str(snapshot_body).expect("snapshot is JSON");
    let cells = v["sheets"][0]["cells"].as_array()?;
    for c in cells {
        if c["row"].as_u64() == Some(row) && c["col"].as_u64() == Some(col) {
            return c["value"]["number"].as_f64();
        }
    }
    None
}

#[tokio::test]
async fn golden_flow_http() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let store = SessionStore::new();
    let server = tokio::spawn(async move { serve(listener, store).await });

    // 1. Create a session.
    let (st, body) = http(addr, "POST", "/v1/sessions", None).await;
    assert_eq!(st, 201, "create session: {body}");
    let sid = serde_json::from_str::<Value>(&body).unwrap()["sessionId"]
        .as_str()
        .expect("sessionId string")
        .to_string();
    let base = format!("/v1/sessions/{sid}");

    // 2. add a sheet (id 0).
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/add-sheet"),
        Some(r#"{"name":"Sheet1","chunkRows":1000}"#),
    )
    .await;
    assert_eq!(st, 200, "add-sheet: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["sheetId"].as_u64(),
        Some(0)
    );

    // 3. A1 = 6 ; B1 = A1*2.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-value"),
        Some(r#"{"sheet":0,"row":0,"col":0,"value":{"kind":"number","number":6}}"#),
    )
    .await;
    assert_eq!(st, 200);
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-formula"),
        Some(r#"{"sheet":0,"row":0,"col":1,"text":"A1*2"}"#),
    )
    .await;
    assert_eq!(st, 200);

    // 4. recalc all -> op id is a QUOTED DECIMAL STRING (frozen u64 convention).
    let (st, body) = http(addr, "POST", &format!("{base}/recalc?kind=all"), None).await;
    assert_eq!(st, 200, "recalc: {body}");
    assert!(
        body.contains(r#""op":""#),
        "op must serialize as a quoted decimal string, got: {body}"
    );
    let op_val: Value = serde_json::from_str(&body).unwrap();
    assert!(op_val["op"].is_string(), "op is a JSON string");

    // 5. snapshot -> B1 == 12. (also assert success Content-Type is application/json)
    let (st, ct, snap) = http_full(addr, "GET", &format!("{base}/snapshot"), None).await;
    assert_eq!(st, 200);
    assert!(
        ct.starts_with("application/json"),
        "success responses are application/json, got: {ct:?}"
    );
    assert_eq!(
        b1_number(&snap, 0, 1),
        Some(12.0),
        "B1 should be 12 after recalc"
    );
    // version is the opaque token as a hex string.
    let snap_v: Value = serde_json::from_str(&snap).unwrap();
    assert!(snap_v["version"].is_string(), "version is a (hex) string");
    assert_eq!(snap_v["schemaVersion"].as_u64(), Some(1));

    // 6. OBSERVABLE recompute: A1 = 7, recalc dirty -> B1 must TRACK to 14
    //    (a no-op recalc would leave the eager 12 -- this fails it).
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-value"),
        Some(r#"{"sheet":0,"row":0,"col":0,"value":{"kind":"number","number":7}}"#),
    )
    .await;
    assert_eq!(st, 200);
    let (st, _) = http(addr, "POST", &format!("{base}/recalc?kind=dirty"), None).await;
    assert_eq!(st, 200);
    let (st, snap2) = http(addr, "GET", &format!("{base}/snapshot"), None).await;
    assert_eq!(st, 200);
    assert_eq!(
        b1_number(&snap2, 0, 1),
        Some(14.0),
        "B1 must recompute to 14"
    );

    // 7. single-cell read of B1 -> value number 14.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cell"),
        Some(r#"{"sheet":0,"row":0,"col":1}"#),
    )
    .await;
    assert_eq!(st, 200, "cell: {body}");
    let cell_v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(cell_v["value"]["kind"].as_str(), Some("number"));
    assert_eq!(cell_v["value"]["number"].as_f64(), Some(14.0));

    // 8. absent cell -> null.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cell"),
        Some(r#"{"sheet":0,"row":50,"col":50}"#),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(
        body.trim(),
        "null",
        "absent cell serializes to null, got: {body}"
    );

    // 9. lifecycle read.
    let (st, body) = http(addr, "GET", &format!("{base}/lifecycle"), None).await;
    assert_eq!(st, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["state"].as_str(),
        Some("ready")
    );

    // 10. error path: 'error'/'pending' kinds are engine-produced, read-only ->
    //     loud problem+json with code/class bad_argument and a 400 status.
    let (st, ct, body) = http_full(
        addr,
        "POST",
        &format!("{base}/set-value"),
        Some(r##"{"sheet":0,"row":0,"col":0,"value":{"kind":"error","error":"#REF!"}}"##),
    )
    .await;
    assert_eq!(st, 400, "bad value kind -> 400: {body}");
    assert!(
        ct.starts_with("application/problem+json"),
        "error responses must be problem+json, got Content-Type: {ct:?}"
    );
    let prob: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(prob["code"].as_str(), Some("bad_argument"));
    assert_eq!(prob["class"].as_str(), Some("bad_argument"));
    assert_eq!(prob["retryable"].as_bool(), Some(false));

    // 11. unknown recalc kind -> bad_argument 400.
    let (st, body) = http(addr, "POST", &format!("{base}/recalc?kind=bogus"), None).await;
    assert_eq!(st, 400, "unknown kind -> 400: {body}");

    // 12. PANIC BOUNDARY: __force_panic returns a [panic] 500 and the server STAYS
    //     UP (a following request still succeeds). (debug_assertions route.)
    let (st, body) = http(addr, "POST", &format!("{base}/__force_panic"), None).await;
    assert_eq!(st, 500, "forced panic -> 500: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("panic")
    );
    // server alive + session lock not poisoned:
    let (st, _) = http(addr, "GET", &format!("{base}/lifecycle"), None).await;
    assert_eq!(st, 200, "server survives the caught panic");

    // 13. unknown session -> 404 session_not_found.
    let (st, body) = http(addr, "GET", "/v1/sessions/does-not-exist/lifecycle", None).await;
    assert_eq!(st, 404, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("session_not_found")
    );

    // 14. close + drop -> 204; the session id is then gone (404).
    let (st, _) = http(addr, "DELETE", &base, None).await;
    assert_eq!(st, 204);
    let (st, _) = http(addr, "GET", &format!("{base}/lifecycle"), None).await;
    assert_eq!(st, 404, "deleted session is gone");

    server.abort();
}
