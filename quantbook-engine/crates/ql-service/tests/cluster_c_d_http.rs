//! Phase 6.2-1b HTTP integration tests -- cluster C (structure/sheets) +
//! cluster D (tables) over REAL HTTP/1.1.
//!
//! Mirrors the napi 6.3-2c/2d smoke for observability: structure ops are checked
//! via `listSheets`/`snapshot`/a named-range SUM; table ops are checked via a
//! structured-reference `SUM(Table[Col])` that resolves/tracks/re-binds (a no-op
//! binding would leave `#NAME!`). Same hand-rolled client as the other tests.

use std::net::SocketAddr;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use ql_service::{serve, SessionStore};

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
        .unwrap()
        .to_string()
}

/// Add a sheet by name; returns its assigned id.
async fn add_sheet(addr: SocketAddr, base: &str, name: &str) -> u64 {
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/add-sheet"),
        Some(&format!(r#"{{"name":{},"chunkRows":1000}}"#, json_str(name))),
    )
    .await;
    assert_eq!(st, 200, "add-sheet: {body}");
    serde_json::from_str::<Value>(&body).unwrap()["sheetId"]
        .as_u64()
        .expect("sheetId")
}

async fn list_sheets(addr: SocketAddr, base: &str) -> Vec<Value> {
    let (st, body) = http(addr, "GET", &format!("{base}/sheets"), None).await;
    assert_eq!(st, 200, "sheets: {body}");
    serde_json::from_str::<Value>(&body)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
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

async fn set_formula(addr: SocketAddr, base: &str, sheet: u64, row: u64, col: u64, text: &str) -> u16 {
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-formula"),
        Some(&format!(
            r#"{{"sheet":{sheet},"row":{row},"col":{col},"text":{}}}"#,
            json_str(text)
        )),
    )
    .await;
    st
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

#[tokio::test]
async fn cluster_c_structure_sheets() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let s0 = add_sheet(addr, &base, "Sheet1").await;

    // rename -> listSheets reflects the new name.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/rename-sheet"),
        Some(&format!(r#"{{"id":{s0},"newName":"Renamed"}}"#)),
    )
    .await;
    assert_eq!(st, 200);
    let sheets = list_sheets(addr, &base).await;
    assert_eq!(sheets[0]["name"].as_str(), Some("Renamed"));

    // setName + a named-range SUM resolves (OBSERVABLE: a no-op setName would
    // leave SUM(Nums) unbindable / #NAME).
    set_number(addr, &base, s0, 0, 0, 10.0).await;
    set_number(addr, &base, s0, 1, 0, 20.0).await;
    set_number(addr, &base, s0, 2, 0, 30.0).await;
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/set-name"),
        Some(&format!(
            r#"{{"name":"Nums","target":{{"sheet":{s0},"startRow":0,"startCol":0,"endRow":2,"endCol":0}}}}"#
        )),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(set_formula(addr, &base, s0, 0, 1, "SUM(Nums)").await, 200);
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, s0, 0, 1).await["value"]["number"].as_f64(),
        Some(60.0),
        "named-range SUM resolves over A1:A3"
    );

    // add a 2nd sheet; move it to index 0 -> listSheets display order reflects it.
    let s1 = add_sheet(addr, &base, "Sheet2").await;
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/move-sheet"),
        Some(&format!(r#"{{"id":{s1},"newIndex":0}}"#)),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(list_sheets(addr, &base).await[0]["id"].as_u64(), Some(s1));

    // duplicate-name rename -> 409 sheet_name_duplicate.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/rename-sheet"),
        Some(&format!(r#"{{"id":{s1},"newName":"Renamed"}}"#)),
    )
    .await;
    assert_eq!(st, 409, "dup name -> 409: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("sheet_name_duplicate")
    );

    // delete -> gone from listSheets; restore -> back.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/delete-sheet"),
        Some(&format!(r#"{{"id":{s1}}}"#)),
    )
    .await;
    assert_eq!(st, 200);
    assert!(
        !list_sheets(addr, &base)
            .await
            .iter()
            .any(|s| s["id"].as_u64() == Some(s1)),
        "deleted sheet is hidden"
    );
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/restore-sheet"),
        Some(&format!(r#"{{"id":{s1}}}"#)),
    )
    .await;
    assert_eq!(st, 200);
    assert!(
        list_sheets(addr, &base)
            .await
            .iter()
            .any(|s| s["id"].as_u64() == Some(s1)),
        "restored sheet is back"
    );

    // loud negatives.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/rename-sheet"),
        Some(r#"{"id":9999,"newName":"X"}"#),
    )
    .await;
    assert_eq!(st, 404, "unknown id -> 404: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("sheet_not_found")
    );
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/move-sheet"),
        Some(&format!(r#"{{"id":{s0},"newIndex":9999}}"#)),
    )
    .await;
    assert_eq!(st, 400, "out-of-range move -> 400: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("bad_argument")
    );
    // restore of a LIVE sheet -> 409 sheet_not_deleted.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/restore-sheet"),
        Some(&format!(r#"{{"id":{s0}}}"#)),
    )
    .await;
    assert_eq!(st, 409, "restore live -> 409: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("sheet_not_deleted")
    );

    server.abort();
}

#[tokio::test]
async fn cluster_d_tables() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let server = tokio::spawn(async move { serve(listener, SessionStore::new()).await });

    let sid = new_session(addr).await;
    let base = format!("/v1/sessions/{sid}");
    let sh = add_sheet(addr, &base, "S").await;

    // data: Qty column (col 0) rows 1,2 = 10,20 (row 0 is the header).
    set_number(addr, &base, sh, 1, 0, 10.0).await;
    set_number(addr, &base, sh, 2, 0, 20.0).await;

    // create a 3x1 table "Sales" (header + 2 data) anchored at (0,0), column "Qty".
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/create-table"),
        Some(&format!(
            r#"{{"name":"Sales","sheet":{sh},"topRow":0,"topCol":0,"rows":3,"cols":1,
                "hasHeader":true,"hasTotals":false,"columnNames":["Qty"]}}"#
        )),
    )
    .await;
    assert_eq!(st, 200, "create-table: {body}");

    // OBSERVABLE: a structured-reference SUM resolves (a no-op create -> #NAME).
    assert_eq!(set_formula(addr, &base, sh, 0, 2, "SUM(Sales[Qty])").await, 200);
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 2).await["value"]["number"].as_f64(),
        Some(30.0),
        "SUM(Sales[Qty]) = 10+20"
    );

    // renameColumn: existing ref still resolves AND the new name binds while the
    // OLD name no longer binds (proves the rename really took effect).
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/rename-column"),
        Some(r#"{"table":"Sales","oldCol":"Qty","newCol":"Quantity"}"#),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 2).await["value"]["number"].as_f64(),
        Some(30.0)
    );
    assert_eq!(
        set_formula(addr, &base, sh, 0, 5, "SUM(Sales[Quantity])").await,
        200,
        "the NEW column name binds"
    );
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/set-formula"),
        Some(&format!(
            r#"{{"sheet":{sh},"row":1,"col":5,"text":"SUM(Sales[Qty])"}}"#
        )),
    )
    .await;
    assert_eq!(st, 400, "OLD column name no longer binds -> 400: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("formula_bind")
    );

    // renameTable: existing ref still resolves.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/rename-table"),
        Some(r#"{"oldName":"Sales","newName":"Revenue"}"#),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 2).await["value"]["number"].as_f64(),
        Some(30.0)
    );

    // resize: add a data row below the footprint -> the SUM range extends to it.
    set_number(addr, &base, sh, 3, 0, 40.0).await;
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/resize-table"),
        Some(r#"{"name":"Revenue","newRows":4,"newCols":1,"addedColumns":[],"removedColumns":[]}"#),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;
    assert_eq!(
        cell(addr, &base, sh, 0, 2).await["value"]["number"].as_f64(),
        Some(70.0),
        "resizeTable extends the data range -> SUM = 10+20+40"
    );

    // drop: the structured ref re-binds to a #NAME? error VALUE on recompute.
    let (st, _) = http(
        addr,
        "POST",
        &format!("{base}/drop-table"),
        Some(r#"{"name":"Revenue"}"#),
    )
    .await;
    assert_eq!(st, 200);
    recalc_dirty(addr, &base).await;
    let dropped = cell(addr, &base, sh, 0, 2).await;
    assert_eq!(dropped["value"]["kind"].as_str(), Some("error"));
    assert!(
        dropped["value"]["error"].as_str().unwrap_or("").contains("NAME"),
        "dropTable rebind is a #NAME? error: {dropped}"
    );

    // loud negatives.
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/drop-table"),
        Some(r#"{"name":"NoSuch"}"#),
    )
    .await;
    assert_eq!(st, 404, "drop unknown -> 404: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("table_not_found")
    );
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/resize-table"),
        Some(r#"{"name":"NoSuch","newRows":2,"newCols":1,"addedColumns":[],"removedColumns":[]}"#),
    )
    .await;
    assert_eq!(st, 404, "resize unknown -> 404: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("table_not_found")
    );
    // create-table omitting columnNames -> loud deserialize error (400 bad_argument).
    let (st, body) = http(
        addr,
        "POST",
        &format!("{base}/create-table"),
        Some(&format!(
            r#"{{"name":"NoCols","sheet":{sh},"topRow":10,"topCol":0,"rows":1,"cols":1,
                "hasHeader":false,"hasTotals":false}}"#
        )),
    )
    .await;
    assert_eq!(st, 400, "missing columnNames -> 400: {body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"].as_str(),
        Some("bad_argument"),
        "missing columnNames is a loud bad_argument: {body}"
    );

    server.abort();
}

/// JSON-encode a string for safe embedding in a request body.
fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
