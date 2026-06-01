//! Phase 6.2-4 (2026-06-01) -- end-to-end byte gate for the ECMAScript number wire.
//!
//! Drives the running service over REAL HTTP and asserts that cell numbers cross
//! the wire in the frozen napi/`JSON.stringify` form (`12`, `0.5`, `1e+21`, `1e-7`,
//! `0.000001`, `-3`) -- NOT serde/ryu's `12.0` / `1e21`. This is the raw-RESPONSE-BYTES
//! complement to the `wire::ecma_number_string` unit table: it proves the
//! `ecma_opt_number` serde adapter is actually wired onto every number-emitting
//! endpoint (`snapshot` + `cell`), through a full HTTP round-trip.
//!
//! Self-contained hand-rolled HTTP/1.1 client (`Connection: close`) -- no extra dep.

use std::net::SocketAddr;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use ql_service::{serve, SessionStore};

/// Send one request with `Connection: close`; return `(status, body_string)`.
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

#[tokio::test]
async fn cell_numbers_cross_in_ecmascript_form() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let store = SessionStore::new();
    let _server = tokio::spawn(async move { serve(listener, store).await });

    // Create a session + a sheet.
    let (st, body) = http(addr, "POST", "/v1/sessions", None).await;
    assert_eq!(st, 201, "create session: {body}");
    let sid = serde_json::from_str::<Value>(&body).unwrap()["sessionId"]
        .as_str()
        .expect("sessionId string")
        .to_string();
    let base = format!("/v1/sessions/{sid}");
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/add-sheet"),
        Some(r#"{"name":"S","chunkRows":1000}"#),
    )
    .await;
    assert_eq!(st, 200, "add-sheet: {body}");

    // (row, literal-number JSON, the EXACT token expected on the wire).
    // The literals exercise every branch of the ECMAScript algorithm reachable via
    // set-value (a finite f64 input): integer, fraction, leading-zero fraction, both
    // exponent boundaries, and a negative.
    let cases: &[(u32, &str, &str)] = &[
        (0, "12", r#""number":12"#),
        (1, "0.5", r#""number":0.5"#),
        (2, "100", r#""number":100"#),
        (3, "1e21", r#""number":1e+21"#),
        (4, "1e-7", r#""number":1e-7"#),
        (5, "1e-6", r#""number":0.000001"#),
        (6, "-3", r#""number":-3"#),
    ];
    for (row, literal, _) in cases {
        let set = format!(
            r#"{{"sheet":0,"row":{row},"col":0,"value":{{"kind":"number","number":{literal}}}}}"#
        );
        let (st, b) = http(addr, "POST", &format!("{base}/set-value"), Some(&set)).await;
        assert_eq!(st, 200, "set-value row {row}: {b}");
    }
    // Recalc so the stored literals are reflected, then read the whole snapshot once.
    let (st, _) = http(addr, "POST", &format!("{base}/recalc?kind=all"), None).await;
    assert_eq!(st, 200);
    let (st, snap) = http(addr, "GET", &format!("{base}/snapshot"), None).await;
    assert_eq!(st, 200, "snapshot: {snap}");

    for (row, _literal, token) in cases {
        assert!(
            snap.contains(token),
            "row {row}: snapshot must carry the ECMAScript token {token:?}; got: {snap}"
        );
    }
    // The serde/ryu forms must NOT appear (the headline regressions).
    for bad in [r#""number":12.0"#, r#""number":100.0"#, r#""number":-3.0"#, r#""number":1e21"#] {
        assert!(
            !snap.contains(bad),
            "snapshot must NOT carry the serde form {bad:?}; got: {snap}"
        );
    }

    // The single-cell `/cell` endpoint shares cell_value_to_wire -> same form.
    let (st, cell) = http(
        addr,
        "POST",
        &format!("{base}/cell"),
        Some(r#"{"sheet":0,"row":0,"col":0}"#),
    )
    .await;
    assert_eq!(st, 200, "cell: {cell}");
    assert!(
        cell.contains(r#""number":12"#) && !cell.contains(r#""number":12.0"#),
        "cell endpoint must also emit the ECMAScript token; got: {cell}"
    );
}
