//! Phase 6.2-1c HTTP integration tests -- cluster E (atomic groups /
//! transactions) + the reserved sec-3.5 bulk methods + undo/redo + snapshotDelta
//! + functions, all over REAL HTTP/1.1.
//!
//! Mirrors the napi 6.3-2e / 6.3-3 / 6.4-2 smoke for observability: batch atomicity
//! is checked all-or-nothing (a rejected batch leaves NO partial mutation, proven
//! cross-cell); transactions are observed via a committed formula + a consumed
//! handle; undo/redo round-trips with a recalc between so a no-op binding would
//! fail; snapshotDelta carries the changed cell (incremental), reports the designed
//! full-rebuild reasons (empty/epoch), and fails loud on a malformed token; function
//! register/list round-trips metadata and rejects register-over-builtin. Same
//! hand-rolled client as the other cluster tests.

use std::net::SocketAddr;

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

async fn recalc_dirty(addr: SocketAddr, base: &str) {
    let (st, _) = http(addr, "POST", &format!("{base}/recalc?kind=dirty"), None).await;
    assert_eq!(st, 200);
}

async fn cell(addr: SocketAddr, base: &str, sheet: u64, row: u64, col: u64) -> Value {
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/cell"),
        Some(&format!(r#"{{"sheet":{sheet},"row":{row},"col":{col}}}"#)),
    )
    .await;
    assert_eq!(st, 200, "cell: {body}");
    serde_json::from_str(&body).unwrap()
}

async fn snapshot_version(addr: SocketAddr, base: &str) -> String {
    let (st, body) = http(addr, "GET", &format!("{base}/snapshot"), None).await;
    assert_eq!(st, 200, "snapshot: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["version"]
        .as_str()
        .expect("version hex")
        .to_string()
}

fn code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body).ok()?["code"]
        .as_str()
        .map(str::to_string)
}

#[tokio::test]
async fn cluster_e_batch_and_transactions() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;

    // batch applies atomically + is OBSERVABLE: A1=5, B1=A1*2 -> 10; applied==2,
    // version present.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/batch"),
        Some(&format!(
            r#"{{"ops":[
                {{"kind":"setValue","sheet":{sh},"row":0,"col":0,"value":{{"kind":"number","number":5}}}},
                {{"kind":"setFormula","sheet":{sh},"row":0,"col":1,"text":"A1*2"}}
            ],"options":{{}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200, "batch: {body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["applied"].as_u64(), Some(2), "applied==2: {body}");
    assert!(
        v["version"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        "version is a non-empty hex token: {body}"
    );
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 1).await["value"]["number"].as_f64(),
        Some(10.0),
        "batch setFormula B1 = A1*2 = 10"
    );

    // all-or-nothing: a same-cell value/formula conflict rejects the WHOLE batch
    // (409 conflicting_batch_ops); a valid op on a DIFFERENT cell (C5) in the same
    // batch also does NOT land (cross-cell atomicity).
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/batch"),
        Some(&format!(
            r#"{{"ops":[
                {{"kind":"setValue","sheet":{sh},"row":4,"col":2,"value":{{"kind":"number","number":99}}}},
                {{"kind":"setValue","sheet":{sh},"row":1,"col":0,"value":{{"kind":"number","number":1}}}},
                {{"kind":"setFormula","sheet":{sh},"row":1,"col":0,"text":"2"}}
            ],"options":{{}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 409, "conflicting batch -> 409: {body}");
    assert_eq!(code(&body).as_deref(), Some("conflicting_batch_ops"));
    recalc_dirty(addr, &base).await;
    assert!(
        cell(addr, &base, sh, 4, 2).await.is_null(),
        "rejected batch leaves C5 absent (cross-cell all-or-nothing)"
    );

    // transaction: begin -> add 2 ops -> commit (observable D2 = C2+1 = 8);
    // distinct txn ids carried as decimal strings.
    let (st, body) = http(addr, "POST", &format!("{base}/begin-transaction"), None).await;
    assert_eq!(st, 200, "begin: {body}");
    let t1 = serde_json::from_str::<Value>(&body).unwrap()["txn"]
        .as_str()
        .expect("txn decimal string")
        .to_string();
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/txn-add"),
        Some(&format!(
            r#"{{"txn":"{t1}","op":{{"kind":"setValue","sheet":{sh},"row":1,"col":2,"value":{{"kind":"number","number":7}}}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/txn-add"),
        Some(&format!(
            r#"{{"txn":"{t1}","op":{{"kind":"setFormula","sheet":{sh},"row":1,"col":3,"text":"C2+1"}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/commit-transaction"),
        Some(&format!(r#"{{"txn":"{t1}"}}"#)),
    )
    .await;
    assert_eq!(st, 200, "commit: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["applied"].as_u64(),
        Some(2)
    );
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 1, 3).await["value"]["number"].as_f64(),
        Some(8.0),
        "committed transaction: D2 = C2+1 = 8"
    );

    // a committed handle is consumed: a follow-up txn-add -> 404 transaction_not_found.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/txn-add"),
        Some(&format!(
            r#"{{"txn":"{t1}","op":{{"kind":"clear","sheet":{sh},"row":0,"col":0}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 404, "committed txn consumed -> 404: {body}");
    assert_eq!(code(&body).as_deref(), Some("transaction_not_found"));

    // rollback discards AND consumes the handle: staged op never lands, follow-up
    // txn-add -> transaction_not_found.
    let (st, body) = http(addr, "POST", &format!("{base}/begin-transaction"), None).await;
    assert_eq!(st, 200);
    let t2 = serde_json::from_str::<Value>(&body).unwrap()["txn"]
        .as_str()
        .unwrap()
        .to_string();
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/txn-add"),
        Some(&format!(
            r#"{{"txn":"{t2}","op":{{"kind":"setValue","sheet":{sh},"row":2,"col":4,"value":{{"kind":"number","number":5}}}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/rollback-transaction"),
        Some(&format!(r#"{{"txn":"{t2}"}}"#)),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;
    assert!(
        cell(addr, &base, sh, 2, 4).await.is_null(),
        "rolled-back op never lands"
    );
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/txn-add"),
        Some(&format!(
            r#"{{"txn":"{t2}","op":{{"kind":"clear","sheet":{sh},"row":0,"col":0}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 404, "rolled-back txn consumed -> 404: {body}");
    assert_eq!(code(&body).as_deref(), Some("transaction_not_found"));

    server.abort();
}

#[tokio::test]
async fn cluster_e_reserved_bulk_all_501() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;
    let range = format!(r#"{{"sheet":{sh},"startRow":0,"startCol":0,"endRow":0,"endCol":0}}"#);

    // Each reserved method takes VALID inputs (so conversion passes) and must surface
    // not_implemented_in_v1_core (Capability -> 501) -- the authoritative v1 signal.
    // `data` (publish/materialize) is opaque JSON TEXT (a string carrying JSON,
    // mirroring napi), so it is double-encoded here.
    let cases: [(&str, String); 5] = [
        (
            "write-range",
            format!(r#"{{"range":{range},"values":[[{{"kind":"number","number":1}}]]}}"#),
        ),
        (
            "publish-dataset",
            format!(r#"{{"name":"d","data":"{{\"k\":1}}","target":{range}}}"#),
        ),
        (
            "bind-range",
            format!(r#"{{"bindingId":"b","target":{range}}}"#),
        ),
        (
            "refresh-source",
            r#"{"sourceId":"s","revision":"1"}"#.to_string(),
        ),
        (
            "materialize-query",
            format!(r#"{{"queryId":"q","target":{range},"data":"{{\"rows\":[]}}"}}"#),
        ),
    ];
    for (path, payload) in cases {
        let (st, body) = http(addr, "POST", &format!("{base}/{path}"), Some(&payload)).await;
        assert_eq!(st, 501, "{path} -> 501: {body}");
        assert_eq!(
            code(&body).as_deref(),
            Some("not_implemented_in_v1_core"),
            "{path} code: {body}"
        );
    }

    // malformed `data` JSON TEXT fails loud as bad_argument BEFORE the 501 (mirrors
    // napi parse_reserved_json_payload; proves the No-Fallbacks parse path).
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/publish-dataset"),
        Some(&format!(r#"{{"name":"d","data":"not json","target":{range}}}"#)),
    )
    .await;
    assert_eq!(st, 400, "malformed data text -> 400: {body}");
    assert_eq!(code(&body).as_deref(), Some("bad_argument"));

    server.abort();
}

#[tokio::test]
async fn cluster_e_undo_redo_observable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;

    // A1 = 42.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-value"),
        Some(&format!(
            r#"{{"sheet":{sh},"row":0,"col":0,"value":{{"kind":"number","number":42}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 0).await["value"]["number"].as_f64(),
        Some(42.0)
    );

    // canUndo is true (the set-value is undoable); response is a bare bool.
    let (st, body) = http(addr, "GET", &format!("{base}/can-undo"), None).await;
    assert_eq!(st, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), Value::Bool(true));

    // undo -> consumed:true; A1 reverts to absent (a no-op undo would leave 42).
    let (st, body) = http(addr, "POST", &format!("{base}/undo"), None).await;
    assert_eq!(st, 200, "undo: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["consumed"].as_bool(),
        Some(true)
    );
    recalc_dirty(addr, &base).await;
    assert!(
        cell(addr, &base, sh, 0, 0).await.is_null(),
        "undo reverts A1 to absent"
    );

    // redo -> consumed:true; A1 restored to 42 (OBSERVABLE round-trip).
    let (st, body) = http(addr, "POST", &format!("{base}/redo"), None).await;
    assert_eq!(st, 200, "redo: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["consumed"].as_bool(),
        Some(true)
    );
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 0).await["value"]["number"].as_f64(),
        Some(42.0),
        "redo restores A1 = 42"
    );

    // after redo, the redo stack is empty -> canRedo is false.
    let (st, body) = http(addr, "GET", &format!("{base}/can-redo"), None).await;
    assert_eq!(st, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), Value::Bool(false));

    server.abort();
}

#[tokio::test]
async fn cluster_e_snapshot_delta() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;

    let v0 = snapshot_version(addr, &base).await;

    // empty token -> no_prior_version full rebuild (NOT an error; 200).
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/snapshot-delta"),
        Some(r#"{"version":""}"#),
    )
    .await;
    assert_eq!(st, 200, "empty token: {body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["fullRebuildRequired"].as_bool(), Some(true));
    assert_eq!(
        v["fullRebuildReason"].as_str(),
        Some("no_prior_version"),
        "empty token -> no_prior_version: {body}"
    );

    // garbage tokens fail loud at the wire (hex_decode) -> 400 invalid_version_token.
    for bad in ["zz", "abc"] {
        let (st, body) = http(
            addr,
            "POST",
            &format!("{base}/snapshot-delta"),
            Some(&format!(r#"{{"version":"{bad}"}}"#)),
        )
        .await;
        assert_eq!(st, 400, "garbage token {bad:?} -> 400: {body}");
        assert_eq!(code(&body).as_deref(), Some("invalid_version_token"));
    }

    // mutate D3 = 77, recalc; the delta since v0 carries the changed cell + value.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-value"),
        Some(&format!(
            r#"{{"sheet":{sh},"row":2,"col":3,"value":{{"kind":"number","number":77}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;

    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/snapshot-delta"),
        Some(&format!(r#"{{"version":"{v0}"}}"#)),
    )
    .await;
    assert_eq!(st, 200, "incremental delta: {body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["fullRebuildRequired"].as_bool(),
        Some(false),
        "well-formed in-window token -> incremental: {body}"
    );
    let carries_77 = v["changedCells"]
        .as_array()
        .expect("changedCells array")
        .iter()
        .any(|c| c["cell"]["value"]["number"].as_f64() == Some(77.0));
    assert!(carries_77, "incremental delta carries D3=77: {body}");

    // a token from BEFORE an undo full-rebuilds with epoch_mismatch (undo mints a
    // new epoch).
    let v_after = snapshot_version(addr, &base).await;
    let (st, _) = http(addr, "POST", &format!("{base}/undo"), None).await;
    assert_eq!(st, 200);
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/snapshot-delta"),
        Some(&format!(r#"{{"version":"{v_after}"}}"#)),
    )
    .await;
    assert_eq!(st, 200, "post-undo delta: {body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["fullRebuildRequired"].as_bool(), Some(true));
    assert_eq!(
        v["fullRebuildReason"].as_str(),
        Some("epoch_mismatch"),
        "pre-undo token -> epoch_mismatch: {body}"
    );

    server.abort();
}

#[tokio::test]
async fn cluster_e_functions() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");

    // register MYUDF (range 1..=3, pure) with an opaque implHandle decimal string.
    let meta = r#"{"canonicalName":"MYUDF","displayName":"My UDF","aliases":["MU"],
        "arity":{"kind":"range","min":1,"max":3},"volatility":"pure","determinism":true,
        "depShape":"value_deps","batchShape":"scalar","argPolicy":"strict",
        "cancellation":"cooperative","argContext":"scalar","provenanceTags":["udf"]}"#;
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/register-function"),
        Some(&format!(r#"{{"metadata":{meta},"implHandle":"7"}}"#)),
    )
    .await;
    assert_eq!(st, 200, "register-function: {body}");

    // listFunctions includes MYUDF with the round-tripped metadata.
    let (st, body) = http(addr, "GET", &format!("{base}/functions"), None).await;
    assert_eq!(st, 200, "functions: {body}");
    let arr = serde_json::from_str::<Value>(&body).unwrap();
    let myudf = arr
        .as_array()
        .expect("functions array")
        .iter()
        .find(|m| m["canonicalName"].as_str() == Some("MYUDF"))
        .expect("MYUDF must appear in listFunctions")
        .clone();
    assert_eq!(myudf["volatility"].as_str(), Some("pure"));
    assert_eq!(myudf["arity"]["kind"].as_str(), Some("range"));
    assert_eq!(myudf["arity"]["min"].as_u64(), Some(1));
    assert_eq!(myudf["arity"]["max"].as_u64(), Some(3));
    assert_eq!(myudf["argContext"].as_str(), Some("scalar"));
    assert_eq!(
        myudf["provenanceTags"].as_array().map(Vec::len),
        Some(1),
        "provenanceTags round-trips: {body}"
    );

    // register over a built-in (SUM) -> 409 function_exists.
    let sum_meta = r#"{"canonicalName":"SUM","aliases":[],
        "arity":{"kind":"variadic"},"volatility":"pure","determinism":true,
        "depShape":"value_deps","batchShape":"scalar","argPolicy":"strict",
        "cancellation":"cooperative","argContext":"aggregate","provenanceTags":[]}"#;
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/register-function"),
        Some(&format!(r#"{{"metadata":{sum_meta},"implHandle":"1"}}"#)),
    )
    .await;
    assert_eq!(st, 409, "register over builtin -> 409: {body}");
    assert_eq!(code(&body).as_deref(), Some("function_exists"));

    // unregister an unknown name -> 404 function_not_found.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/unregister-function"),
        Some(r#"{"canonicalName":"NOPE"}"#),
    )
    .await;
    assert_eq!(st, 404, "unregister unknown -> 404: {body}");
    assert_eq!(code(&body).as_deref(), Some("function_not_found"));

    // unregister MYUDF -> 200; it disappears from the list.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/unregister-function"),
        Some(r#"{"canonicalName":"MYUDF"}"#),
    )
    .await;
    assert_eq!(st, 200, "unregister MYUDF: {body}");
    let (_st, body) = http(addr, "GET", &format!("{base}/functions"), None).await;
    let gone = !serde_json::from_str::<Value>(&body)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["canonicalName"].as_str() == Some("MYUDF"));
    assert!(gone, "unregistered MYUDF is gone from listFunctions");

    server.abort();
}
