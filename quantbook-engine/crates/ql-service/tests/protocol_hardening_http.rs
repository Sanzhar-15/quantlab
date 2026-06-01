//! Phase 6.2-3a HTTP integration tests -- request-path / protocol hardening over
//! REAL HTTP/1.1: the request-body size cap (413), `schemaVersion` echo + mismatch
//! (400), RFC-correct 405 + `Allow` on a known-path-wrong-method, and HTTP/1.1
//! keep-alive (two requests on one connection).
//!
//! The client is a tiny hand-rolled, Content-Length-aware HTTP/1.1 reader (so it
//! can both inspect response headers and reuse a single socket) -- no client dep.
//! The server runs via `serve_with_config` with deliberately tiny body caps.

use std::collections::HashMap;
use std::net::SocketAddr;

use ql_service::{serve_with_config, ServiceConfig, SessionStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Find the first occurrence of `needle` in `hay`.
fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Build a raw HTTP/1.1 request. `Connection: close` unless `keep_alive`.
fn build_req(
    method: &str,
    path: &str,
    body: Option<&str>,
    extra: &[(&str, &str)],
    keep_alive: bool,
) -> String {
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n");
    if !keep_alive {
        req.push_str("Connection: close\r\n");
    }
    for (k, v) in extra {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(b) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    req
}

/// Send one request on `stream` and read exactly one Content-Length-delimited
/// response, leaving the socket open for reuse. Returns `(status, headers, body)`;
/// header keys are lowercased.
async fn send_recv(stream: &mut TcpStream, req: &str) -> (u16, HashMap<String, String>, String) {
    stream.write_all(req.as_bytes()).await.expect("write");
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 2048];
    // Read until the header terminator.
    let header_end = loop {
        if let Some(pos) = find_sub(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        let n = stream.read(&mut tmp).await.expect("read headers");
        assert!(n > 0, "connection closed before response headers");
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(": ") {
            headers.insert(k.to_ascii_lowercase(), v.to_string());
        }
    }
    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_len {
        let n = stream.read(&mut tmp).await.expect("read body");
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_len);
    (status, headers, String::from_utf8_lossy(&body).to_string())
}

/// One-shot `Connection: close` request on a fresh socket.
async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    body: Option<&str>,
    extra: &[(&str, &str)],
) -> (u16, HashMap<String, String>, String) {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let req = build_req(method, path, body, extra, false);
    send_recv(&mut stream, &req).await
}

/// Spawn the service with the given config on an ephemeral port; return its addr.
async fn spawn(cfg: ServiceConfig) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move { serve_with_config(listener, SessionStore::new(), cfg).await });
    addr
}

/// Extract `"sessionId":"<id>"` from a create-session response body.
fn session_id(body: &str) -> String {
    let key = "\"sessionId\":\"";
    let start = body.find(key).expect("sessionId in body") + key.len();
    let end = body[start..].find('"').expect("closing quote") + start;
    body[start..end].to_string()
}

fn code(body: &str) -> String {
    let key = "\"code\":\"";
    match body.find(key) {
        Some(i) => {
            let s = i + key.len();
            let e = body[s..].find('"').map(|x| x + s).unwrap_or(s);
            body[s..e].to_string()
        }
        None => String::new(),
    }
}

#[tokio::test]
async fn body_size_cap_returns_413() {
    // Tiny caps so a padded request trips the limit: JSON 512 B, blob 256 B.
    let addr = spawn(ServiceConfig {
        max_json_body_bytes: 512,
        max_blob_body_bytes: 256,
    })
    .await;

    let (st, _h, b) = http(addr, "POST", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 201, "create: {b}");
    let sid = session_id(&b);
    let base = format!("/v1/sessions/{sid}");

    // A normal-sized body UNDER the cap is read AND dispatched -- assert a concrete
    // success (add-sheet -> 200) so a regression on the small-body path is caught,
    // not merely "anything but 413".
    let small = r#"{"name":"S","chunkRows":1024}"#;
    let (st, _h, b) = http(addr, "POST", &format!("{base}/add-sheet"), Some(small), &[]).await;
    assert_eq!(st, 200, "under-limit body accepted + dispatched: {b}");

    // A padded JSON body OVER 512 B -> 413 payload_too_large (read-time cap).
    let pad = "x".repeat(1024);
    let big = format!(r#"{{"sheet":0,"row":0,"col":0,"value":{{"kind":"text","text":"{pad}"}}}}"#);
    let (st, h, b) = http(addr, "POST", &format!("{base}/set-value"), Some(&big), &[]).await;
    assert_eq!(st, 413, "oversized JSON -> 413: {b}");
    assert_eq!(code(&b), "payload_too_large", "{b}");
    // Even an error response echoes the schema version (the tail runs on every path).
    assert_eq!(
        h.get("x-ql-schema-version").map(String::as_str),
        Some("1"),
        "413 echoes schema: {h:?}"
    );

    // The raw `import` blob path uses the SEPARATE (256 B) blob cap.
    let blob = "y".repeat(512);
    let (st, _h, b) = http(
        addr,
        "POST",
        &format!("{base}/import?format=csv"),
        Some(&blob),
        &[],
    )
    .await;
    assert_eq!(st, 413, "oversized import blob -> 413: {b}");
    assert_eq!(code(&b), "payload_too_large", "{b}");
}

#[tokio::test]
async fn schema_version_echo_and_mismatch() {
    let addr = spawn(ServiceConfig::default()).await;

    // Every response echoes the server schema version.
    let (st, h, _b) = http(addr, "POST", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 201);
    assert_eq!(
        h.get("x-ql-schema-version").map(String::as_str),
        Some("1"),
        "schema version echoed: {h:?}"
    );

    // A matching declared version is accepted.
    let (st, _h, _b) = http(
        addr,
        "POST",
        "/v1/sessions",
        None,
        &[("x-ql-schema-version", "1")],
    )
    .await;
    assert_eq!(st, 201, "matching schema version accepted");

    // A mismatched declared version is rejected loudly BEFORE any work.
    let (st, _h, b) = http(
        addr,
        "POST",
        "/v1/sessions",
        None,
        &[("x-ql-schema-version", "2")],
    )
    .await;
    assert_eq!(st, 400, "mismatched schema version -> 400: {b}");
    assert_eq!(code(&b), "unsupported_schema_version", "{b}");

    // A malformed value is likewise rejected.
    let (st, _h, b) = http(
        addr,
        "POST",
        "/v1/sessions",
        None,
        &[("x-ql-schema-version", "nope")],
    )
    .await;
    assert_eq!(st, 400, "malformed schema version -> 400: {b}");
    assert_eq!(code(&b), "unsupported_schema_version", "{b}");
}

#[tokio::test]
async fn wrong_method_returns_405_with_allow() {
    let addr = spawn(ServiceConfig::default()).await;
    let (_st, _h, b) = http(addr, "POST", "/v1/sessions", None, &[]).await;
    let sid = session_id(&b);
    let base = format!("/v1/sessions/{sid}");

    // GET on a POST-only route -> 405 + Allow: POST.
    let (st, h, b) = http(addr, "GET", &format!("{base}/set-value"), None, &[]).await;
    assert_eq!(st, 405, "GET set-value -> 405: {b}");
    assert_eq!(h.get("allow").map(String::as_str), Some("POST"), "{h:?}");
    assert_eq!(code(&b), "method_not_allowed", "{b}");
    assert_eq!(
        h.get("x-ql-schema-version").map(String::as_str),
        Some("1"),
        "405 echoes schema: {h:?}"
    );

    // POST on a GET-only route -> 405 + Allow: GET.
    let (st, h, b) = http(addr, "POST", &format!("{base}/snapshot"), Some("{}"), &[]).await;
    assert_eq!(st, 405, "POST snapshot -> 405: {b}");
    assert_eq!(h.get("allow").map(String::as_str), Some("GET"), "{h:?}");

    // Wrong method on the collection path -> 405 + Allow: POST.
    let (st, h, b) = http(addr, "DELETE", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 405, "DELETE /v1/sessions -> 405: {b}");
    assert_eq!(h.get("allow").map(String::as_str), Some("POST"), "{h:?}");

    // An UNKNOWN verb on a known prefix is still a 404 route_not_found.
    let (st, _h, b) = http(addr, "GET", &format!("{base}/bogus"), None, &[]).await;
    assert_eq!(st, 404, "unknown verb -> 404: {b}");
    assert_eq!(code(&b), "route_not_found", "{b}");
}

#[tokio::test]
async fn keep_alive_two_requests_one_connection() {
    let addr = spawn(ServiceConfig::default()).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");

    // Two pipelined-sequential requests on ONE socket (no Connection: close).
    let (st1, h1, _b1) = send_recv(
        &mut stream,
        &build_req("POST", "/v1/sessions", None, &[], true),
    )
    .await;
    assert_eq!(st1, 201, "first request on the connection");
    assert_eq!(h1.get("x-ql-schema-version").map(String::as_str), Some("1"));

    let (st2, _h2, _b2) = send_recv(
        &mut stream,
        &build_req("POST", "/v1/sessions", None, &[], true),
    )
    .await;
    assert_eq!(st2, 201, "second request reuses the same connection");
}

#[tokio::test]
async fn body_cap_binds_bodyless_routes_via_content_length() {
    // The cap must bind routes that do NOT read the body (e.g. recalc reads only the
    // query string), via the Content-Length preflight -- not only the body-reading
    // handlers (audit MED). An oversized declared body is rejected up front.
    let addr = spawn(ServiceConfig {
        max_json_body_bytes: 512,
        max_blob_body_bytes: 256,
    })
    .await;
    let (_st, _h, b) = http(addr, "POST", "/v1/sessions", None, &[]).await;
    let sid = session_id(&b);

    let big = "z".repeat(2048);
    let (st, _h, b) = http(
        addr,
        "POST",
        &format!("/v1/sessions/{sid}/recalc?kind=dirty"),
        Some(&big),
        &[],
    )
    .await;
    assert_eq!(
        st, 413,
        "oversized body on a bodyless route -> 413 (preflight): {b}"
    );
    assert_eq!(code(&b), "payload_too_large", "{b}");
}
