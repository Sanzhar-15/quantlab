//! Phase 6.2-1a HTTP integration tests -- cluster A (read/format/validate/query)
//! + cluster B (persistence) over REAL HTTP/1.1.
//!
//! Same hand-rolled `Connection: close` client as `golden_flow_http.rs` (no extra
//! client dep). Every assertion is OBSERVABLE -- it fails under a no-op/broken
//! binding (e.g. a `clear` that drops the value, a `setFormat` that does not
//! persist, a `queryRange` that is not columnar, a `save`/`open` that does not
//! round-trip).

use std::net::SocketAddr;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use ql_service::{serve, SessionStore};

/// Minimal HTTP/1.1 client: one request with `Connection: close`, read to EOF,
/// return `(status, content_type, body_string)`.
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

async fn http(addr: SocketAddr, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let (st, _ct, body) = http_full(addr, method, path, body).await;
    (st, body)
}

async fn new_session(addr: SocketAddr) -> String {
    let (st, body) = http(addr, "POST", "/v1/sessions", None).await;
    assert_eq!(st, 201, "create session: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["sessionId"]
        .as_str()
        .expect("sessionId string")
        .to_string()
}

async fn add_sheet0(addr: SocketAddr, base: &str) {
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
}

/// Read a single cell (sheet 0, row, col); returns the parsed JSON (`null` if absent).
async fn cell(addr: SocketAddr, base: &str, row: u64, col: u64) -> Value {
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cell"),
        Some(&format!(r#"{{"sheet":0,"row":{row},"col":{col}}}"#)),
    )
    .await;
    assert_eq!(st, 200, "cell: {body}");
    serde_json::from_str(&body).unwrap()
}

#[tokio::test]
async fn cluster_a_read_format_validate_query() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    add_sheet0(addr, &base).await;

    // ---- clear: convert-to-literal (strips formula, PRESERVES the value) ----
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-formula"),
        Some(r#"{"sheet":0,"row":0,"col":0,"text":"1 + 2"}"#),
    )
    .await;
    assert_eq!(st, 200);
    let c = cell(addr, &base, 0, 0).await;
    assert_eq!(c["formula"].as_str(), Some("1 + 2"));
    assert_eq!(c["value"]["number"].as_f64(), Some(3.0));
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/clear"),
        Some(r#"{"sheet":0,"row":0,"col":0}"#),
    )
    .await;
    assert_eq!(st, 200);
    let c = cell(addr, &base, 0, 0).await;
    assert!(c["formula"].is_null(), "clear strips the formula: {c}");
    assert_eq!(
        c["value"]["number"].as_f64(),
        Some(3.0),
        "clear PRESERVES the computed value (convert-to-literal): {c}"
    );

    // ---- registerFormat + setFormat round-trip through the cell ----
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/register-format"),
        Some(r#"{"formatString":"0.00%"}"#),
    )
    .await;
    assert_eq!(st, 200, "register-format: {body}");
    let fmt: Value = serde_json::from_str(&body).unwrap();
    assert!(
        fmt["kind"] == "builtin" || fmt["kind"] == "custom",
        "registerFormat returns a FormatId: {fmt}"
    );
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-format"),
        Some(&format!(
            r#"{{"sheet":0,"row":0,"col":0,"format":{}}}"#,
            serde_json::to_string(&fmt).unwrap()
        )),
    )
    .await;
    assert_eq!(st, 200);
    let c = cell(addr, &base, 0, 0).await;
    assert_eq!(
        c["format"], fmt,
        "the cell format round-trips the registered id: {c}"
    );
    // Observability: the registered format must appear in the session format
    // table with its exact string -- a broken registerFormat returning some
    // unrelated builtin id (without registering "0.00%") would NOT produce a
    // formats entry binding that id to "0.00%".
    let (st, snap) = http(addr, "GET", &format!("{base}/snapshot"), None).await;
    assert_eq!(st, 200);
    let formats = serde_json::from_str::<Value>(&snap).unwrap()["formats"]
        .as_array()
        .expect("snapshot has formats")
        .clone();
    assert!(
        formats
            .iter()
            .any(|f| f["string"].as_str() == Some("0.00%") && f["id"] == fmt),
        "registered format id+string must be in the session format table: {snap}"
    );

    // setFormat strict-union negative: builtin kind carrying customPeer -> 400.
    let (st, ct, body) = http_full(
        addr,
        "POST",
        &format!("{base}/set-format"),
        Some(r#"{"sheet":0,"row":0,"col":0,"format":{"kind":"builtin","builtin":0,"customPeer":"1"}}"#),
    )
    .await;
    assert_eq!(st, 400, "strict-union violation -> 400: {body}");
    assert!(ct.starts_with("application/problem+json"), "{ct:?}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("bad_argument")
    );

    // ---- validateFormula: malformed -> 1 error diagnostic; valid -> [] ----
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/validate-formula"),
        Some(r#"{"sheet":0,"row":0,"col":0,"text":"1 +* 2"}"#),
    )
    .await;
    assert_eq!(st, 200, "validate-formula: {body}");
    let diags: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(diags.as_array().unwrap().len(), 1, "{diags}");
    assert_eq!(diags[0]["severity"].as_str(), Some("error"));
    assert!(diags[0]["code"].is_string(), "{diags}");
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/validate-formula"),
        Some(r#"{"sheet":0,"row":0,"col":0,"text":"1 + 2 * 3"}"#),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()
            .as_array()
            .unwrap()
            .len(),
        0,
        "valid formula -> no diagnostics: {body}"
    );

    // ---- queryRange: columnar over a populated 2x2 rectangle ----
    // C1=1,C2=2 (col 2) and D1=3,D2=4 (col 3) -> proves column-MAJOR layout AND
    // that endCol is honored (a row-major or off-by-one binding would diverge).
    for (row, col, n) in [
        (0u64, 2u64, 1.0),
        (1, 2, 2.0),
        (0, 3, 3.0),
        (1, 3, 4.0),
    ] {
        let (st, _) = http(
            addr,
            "POST",
            &format!("{base}/set-value"),
            Some(&format!(
                r#"{{"sheet":0,"row":{row},"col":{col},"value":{{"kind":"number","number":{n}}}}}"#
            )),
        )
        .await;
        assert_eq!(st, 200);
    }
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/query-range"),
        Some(
            r#"{"range":{"sheet":0,"startRow":0,"startCol":2,"endRow":1,"endCol":3},
               "options":{"includeFormulas":false,"includeFormats":false,"includeRendered":false}}"#,
        ),
    )
    .await;
    assert_eq!(st, 200, "query-range: {body}");
    let rr: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(rr["nRows"].as_u64(), Some(2));
    assert_eq!(rr["nCols"].as_u64(), Some(2));
    assert_eq!(rr["schemaVersion"].as_u64(), Some(1));
    assert_eq!(rr["columns"].as_array().unwrap().len(), 2);
    let col0 = &rr["columns"][0]["values"];
    assert_eq!(col0[0]["kind"].as_str(), Some("number"));
    assert_eq!(col0[0]["number"].as_f64(), Some(1.0));
    assert_eq!(col0[1]["number"].as_f64(), Some(2.0));
    let col1 = &rr["columns"][1]["values"];
    assert_eq!(col1[0]["number"].as_f64(), Some(3.0));
    assert_eq!(col1[1]["number"].as_f64(), Some(4.0));

    // queryRange include-options are not implemented in v1 core -> 501 Capability.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/query-range"),
        Some(
            r#"{"range":{"sheet":0,"startRow":0,"startCol":0,"endRow":0,"endCol":0},
               "options":{"includeFormulas":true,"includeFormats":false,"includeRendered":false}}"#,
        ),
    )
    .await;
    assert_eq!(st, 501, "include_formulas -> 501: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("not_implemented_in_v1_core")
    );

    // ---- listSheets ----
    let (st, body) = http(addr, "GET", &format!("{base}/sheets"), None).await;
    assert_eq!(st, 200, "sheets: {body}");
    let sheets: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(sheets.as_array().unwrap().len(), 1);
    assert_eq!(sheets[0]["id"].as_u64(), Some(0));
    assert_eq!(sheets[0]["name"].as_str(), Some("Sheet1"));

    // ---- markVolatilesDirty ----
    // Ack-only (6.2-1a audit Codex LOW-3, accepted): the dirty-set is not exposed
    // over the wire, and the only observable signal (a volatile value changing
    // across recalc, e.g. RAND/NOW) is RNG/time-flaky -- unsuitable for a
    // deterministic test. This pins the route + lock + lifecycle + ack path; the
    // mark-volatiles-dirty SEMANTICS are covered by the engine's own ql-exec tests
    // (this binding is a thin forwarder, like the other void mutations).
    let (st, body) = http(addr, "POST", &format!("{base}/mark-volatiles-dirty"), None).await;
    assert_eq!(st, 200, "mark-volatiles-dirty: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["ok"].as_bool(),
        Some(true)
    );

    server.abort();
}

#[tokio::test]
async fn cluster_b_persistence_roundtrips() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    // Unique temp path for the .qbook round-trip (distinct from the other test).
    let qbook = std::env::temp_dir().join(format!(
        "ql_service_6_2_1a_{}.qbook",
        std::process::id()
    ));
    let qbook_str = qbook.to_str().unwrap().to_string();

    // session 1: A1 = 42, save to .qbook.
    let sid1 = new_session(addr).await;
    let base1 = format!("/v1/sessions/{sid1}");
    add_sheet0(addr, &base1).await;
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base1}/set-value"),
        Some(r#"{"sheet":0,"row":0,"col":0,"value":{"kind":"number","number":42}}"#),
    )
    .await;
    assert_eq!(st, 200);
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base1}/save"),
        Some(&format!(r#"{{"path":{}}}"#, json_str(&qbook_str))),
    )
    .await;
    assert_eq!(st, 200, "save: {body}");

    // session 2: open the .qbook in a FRESH session -> A1 round-trips to 42.
    let sid2 = new_session(addr).await;
    let base2 = format!("/v1/sessions/{sid2}");
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base2}/open"),
        Some(&format!(r#"{{"path":{}}}"#, json_str(&qbook_str))),
    )
    .await;
    assert_eq!(st, 200, "open: {body}");
    let c = cell(addr, &base2, 0, 0).await;
    assert_eq!(
        c["value"]["number"].as_f64(),
        Some(42.0),
        ".qbook save/open round-trips the cell value: {c}"
    );

    // export csv (GET, octet-stream) from session 1 -> bytes contain "42".
    let (st, ct, csv) = http_full(addr, "GET", &format!("{base1}/export?format=csv"), None).await;
    assert_eq!(st, 200, "export csv: {csv}");
    assert!(
        ct.starts_with("application/octet-stream"),
        "export bytes are octet-stream, got: {ct:?}"
    );
    assert!(csv.contains("42"), "csv export carries the value: {csv:?}");

    // import csv (raw bytes body + ?format=csv) into a FRESH session -> observable.
    let sid3 = new_session(addr).await;
    let base3 = format!("/v1/sessions/{sid3}");
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base3}/import?format=csv"),
        Some("7,8,9\n"),
    )
    .await;
    assert_eq!(st, 200, "import csv: {body}");
    let (st, snap) = http(addr, "GET", &format!("{base3}/snapshot"), None).await;
    assert_eq!(st, 200);
    let snap_v: Value = serde_json::from_str(&snap).unwrap();
    let cells = snap_v["sheets"][0]["cells"]
        .as_array()
        .expect("imported sheet has cells");
    assert_eq!(cells.len(), 3, "csv import created 3 cells: {snap}");
    assert!(snap.contains('7') && snap.contains('9'), "{snap}");

    // import missing ?format -> loud bad_argument 400.
    let (st, body) = http(addr, "POST", &format!("{base3}/import"), Some("x\n")).await;
    assert_eq!(st, 400, "import without format -> 400: {body}");

    // export xlsx -> 501 not_implemented_in_v1_core (default build lacks xlsx-write).
    let (st, body) = http(addr, "GET", &format!("{base1}/export?format=xlsx"), None).await;
    assert_eq!(st, 501, "export xlsx -> 501: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("not_implemented_in_v1_core")
    );

    let _ = std::fs::remove_file(&qbook);
    server.abort();
}

/// JSON-encode a string (so a Windows-style path with backslashes is escaped).
fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
