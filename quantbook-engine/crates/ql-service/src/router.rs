//! Phase 6.2-0 (2026-06-01) -- HTTP request routing + golden-flow handlers.
//!
//! A minimal `match (method, path-segments)` dispatch under the `/v1` version
//! prefix (SVC-6-04 protocol versioning starts here). Each session handler looks
//! the session up, runs the locked engine call under [`crate::guarded`], and maps
//! the result to JSON or the error to `application/problem+json`. The engine
//! enforces lifecycle gating + argument validation and returns the structured
//! `EngineError`; the service does NOT duplicate that logic (pure transport).
//!
//! 6.2-0 endpoint set (the golden-flow surface proving SVC-6-01):
//! - `POST   /v1/sessions`                  -> create        -> `{ sessionId }`
//! - `DELETE /v1/sessions/:id`              -> close + drop  -> 204
//! - `GET    /v1/sessions/:id/lifecycle`    -> `{ state }`
//! - `POST   /v1/sessions/:id/add-sheet`    -> `{ sheetId }`
//! - `POST   /v1/sessions/:id/set-value`    -> `{ ok }`
//! - `POST   /v1/sessions/:id/set-formula`  -> `{ ok }`
//! - `POST   /v1/sessions/:id/recalc?kind=dirty|all` -> `{ op }` (decimal string)
//! - `GET    /v1/sessions/:id/snapshot`     -> WorkbookSnapshot wire
//! - `POST   /v1/sessions/:id/cell`         -> CellSnapshot wire | null
//! - `POST   /v1/sessions/:id/__force_panic` (debug builds only) -> 500 `[panic]`
//!
//! 6.2-1a endpoint set (cluster A read/format/validate/query + cluster B persistence):
//! - `POST   /v1/sessions/:id/clear`            -> `{ ok }`
//! - `POST   /v1/sessions/:id/set-format`       -> `{ ok }`
//! - `POST   /v1/sessions/:id/register-format`  -> FormatId wire
//! - `POST   /v1/sessions/:id/validate-formula` -> Diagnostic wire array
//! - `POST   /v1/sessions/:id/query-range`      -> RangeResult wire (columnar)
//! - `GET    /v1/sessions/:id/sheets`           -> SheetInfo wire array
//! - `POST   /v1/sessions/:id/mark-volatiles-dirty` -> `{ ok }`
//! - `POST   /v1/sessions/:id/open`             -> `{ ok }`
//! - `POST   /v1/sessions/:id/save`             -> `{ ok }`
//! - `POST   /v1/sessions/:id/import?format=<fmt>` -> `{ ok }` (raw bytes request body)
//! - `GET    /v1/sessions/:id/export?format=<fmt>` -> raw bytes (`application/octet-stream`)

use bytes::Bytes;
use http::{header, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use serde::de::DeserializeOwned;
use serde::Serialize;

use ql_exec::WorkbookSession;
use ql_session::{EngineError, EngineSession, ErrorClass, LifecycleState};

use crate::error::engine_error_to_problem;
use crate::guarded::guarded;
use crate::session_store::SessionStore;
use crate::wire::{
    self, cell_range_from_wire, cell_snapshot_to_wire, cell_value_from_wire, diagnostic_to_wire,
    format_id_from_wire, range_result_to_wire, sheet_info_to_wire, workbook_snapshot_to_wire,
    AddSheetBody, AddSheetResponse, CellBody, LifecycleResponse, NewSessionResponse, PathBody,
    QueryRangeBody, RecalcResponse, RegisterFormatBody, SetFormatBody, SetFormulaBody, SetValueBody,
    ValidateFormulaBody,
};
use ql_session::RangeQueryOptions;

/// Acknowledgement for a void mutation (`set-value`/`set-formula`). Not part of
/// the frozen DTO set -- a transport-level confirmation the client can parse.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AckResponse {
    ok: bool,
}

type Incoming = hyper::body::Incoming;
type Resp = Response<Full<Bytes>>;

/// Route + handle one request. Always produces a `Response` (errors become
/// problem+json); never returns `Err` so the hyper service is infallible.
pub(crate) async fn handle(req: http::Request<Incoming>, store: SessionStore) -> Resp {
    let (parts, body) = req.into_parts();
    let method = parts.method;
    let path = parts.uri.path().to_owned();
    let query = parts.uri.query().map(str::to_owned);
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match (method.as_str(), segs.as_slice()) {
        ("POST", ["v1", "sessions"]) => create_session(&store),
        ("DELETE", ["v1", "sessions", id]) => delete_session(&store, id),
        ("GET", ["v1", "sessions", id, "lifecycle"]) => lifecycle(&store, id),
        ("POST", ["v1", "sessions", id, "add-sheet"]) => add_sheet(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "set-value"]) => set_value(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "set-formula"]) => set_formula(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "recalc"]) => recalc(&store, id, &query),
        ("GET", ["v1", "sessions", id, "snapshot"]) => snapshot(&store, id),
        ("POST", ["v1", "sessions", id, "cell"]) => cell(&store, id, body).await,
        // ---- 6.2-1a cluster A (read/format/validate/query) ----
        ("POST", ["v1", "sessions", id, "clear"]) => clear(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "set-format"]) => set_format(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "register-format"]) => {
            register_format(&store, id, body).await
        }
        ("POST", ["v1", "sessions", id, "validate-formula"]) => {
            validate_formula(&store, id, body).await
        }
        ("POST", ["v1", "sessions", id, "query-range"]) => query_range(&store, id, body).await,
        ("GET", ["v1", "sessions", id, "sheets"]) => list_sheets(&store, id),
        ("POST", ["v1", "sessions", id, "mark-volatiles-dirty"]) => mark_volatiles_dirty(&store, id),
        // ---- 6.2-1a cluster B (persistence) ----
        ("POST", ["v1", "sessions", id, "open"]) => open(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "save"]) => save(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "import"]) => import(&store, id, &query, body).await,
        ("GET", ["v1", "sessions", id, "export"]) => export(&store, id, &query),
        #[cfg(debug_assertions)]
        ("POST", ["v1", "sessions", id, "__force_panic"]) => force_panic(&store, id),
        _ => problem(&EngineError::new(
            ErrorClass::NotFound,
            "route_not_found",
            format!("no route for {} {}", method.as_str(), path),
        )),
    }
}

// ---- handlers ----

fn create_session(store: &SessionStore) -> Resp {
    let (id, _handle) = store.create();
    json(StatusCode::CREATED, &NewSessionResponse { session_id: id })
}

fn delete_session(store: &SessionStore, id: &str) -> Resp {
    let Some(handle) = store.get(id) else {
        return problem(&session_not_found(id));
    };
    // Run the engine lifecycle close (Ready -> Closed) before dropping the handle.
    let closed = guarded("close", || {
        let mut g = handle.lock();
        g.close()
    });
    store.remove(id);
    match closed {
        Ok(()) => no_content(),
        Err(e) => problem(&e),
    }
}

fn lifecycle(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "lifecycleState", |s| {
        Ok(LifecycleResponse {
            state: lifecycle_state_str(s.lifecycle_state()).to_string(),
        })
    })
}

async fn add_sheet(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: AddSheetBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if b.chunk_rows == 0 {
        return problem(&EngineError::bad_argument(
            "addSheet: chunkRows must be >= 1 (engine rejects chunk_rows == 0)",
        ));
    }
    with_session(store, id, "addSheet", move |s| {
        let sid = s.add_sheet(&b.name, b.chunk_rows)?;
        Ok(AddSheetResponse {
            sheet_id: u32::from(sid),
        })
    })
}

async fn set_value(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SetValueBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "setValue", move |s| {
        let value = cell_value_from_wire(b.value)?;
        s.set_value(wire::addr(b.sheet, b.row, b.col), value)?;
        Ok(AckResponse { ok: true })
    })
}

async fn set_formula(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SetFormulaBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "setFormula", move |s| {
        s.set_formula(wire::addr(b.sheet, b.row, b.col), &b.text)?;
        Ok(AckResponse { ok: true })
    })
}

fn recalc(store: &SessionStore, id: &str, query: &Option<String>) -> Resp {
    // `kind` selects the incremental (dirty) vs full recompute. Required + explicit
    // (No-Fallbacks: a missing/unknown kind is a loud bad_argument, not a default).
    let kind = query_value(query, "kind");
    match kind.as_deref() {
        Some("dirty") => with_session(store, id, "recalcDirty", |s| {
            Ok(RecalcResponse {
                op: s.recalc_dirty()?.0,
            })
        }),
        Some("all") => with_session(store, id, "recalcAll", |s| {
            Ok(RecalcResponse {
                op: s.recalc_all()?.0,
            })
        }),
        other => problem(&EngineError::bad_argument(format!(
            "recalc: query parameter 'kind' must be 'dirty' or 'all' (got {other:?})"
        ))),
    }
}

fn snapshot(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "snapshot", |s| {
        Ok(workbook_snapshot_to_wire(s.snapshot()?))
    })
}

async fn cell(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: CellBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "cell", move |s| {
        // Option<CellSnapshotWire> serializes to `null` when the cell is absent.
        Ok(s.cell(wire::addr(b.sheet, b.row, b.col))?
            .map(cell_snapshot_to_wire))
    })
}

// ---- 6.2-1a cluster A handlers (read/format/validate/query) ----

async fn clear(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: CellBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "clear", move |s| {
        s.clear(wire::addr(b.sheet, b.row, b.col))?;
        Ok(AckResponse { ok: true })
    })
}

async fn set_format(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SetFormatBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "setFormat", move |s| {
        let format = format_id_from_wire(b.format)?;
        s.set_format(wire::addr(b.sheet, b.row, b.col), format)?;
        Ok(AckResponse { ok: true })
    })
}

async fn register_format(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: RegisterFormatBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "registerFormat", move |s| {
        Ok(wire::format_id_to_wire(s.register_format(&b.format_string)?))
    })
}

async fn validate_formula(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: ValidateFormulaBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "validateFormula", move |s| {
        let diags = s.validate_formula(wire::addr(b.sheet, b.row, b.col), &b.text)?;
        Ok(diags.into_iter().map(diagnostic_to_wire).collect::<Vec<_>>())
    })
}

async fn query_range(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: QueryRangeBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "queryRange", move |s| {
        let range = cell_range_from_wire(b.range);
        let options = RangeQueryOptions {
            include_formulas: b.options.include_formulas,
            include_formats: b.options.include_formats,
            include_rendered: b.options.include_rendered,
        };
        Ok(range_result_to_wire(s.query_range(range, options)?))
    })
}

fn list_sheets(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "listSheets", |s| {
        Ok(s.list_sheets()?
            .into_iter()
            .map(sheet_info_to_wire)
            .collect::<Vec<_>>())
    })
}

fn mark_volatiles_dirty(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "markVolatilesDirty", |s| {
        s.mark_volatiles_dirty()?;
        Ok(AckResponse { ok: true })
    })
}

// ---- 6.2-1a cluster B handlers (persistence) ----

async fn open(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: PathBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "open", move |s| {
        s.open(&b.path)?;
        Ok(AckResponse { ok: true })
    })
}

async fn save(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: PathBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "save", move |s| {
        s.save(&b.path)?;
        Ok(AckResponse { ok: true })
    })
}

/// `import` takes the raw workbook bytes as the request body (`application/octet-stream`
/// -- the faithful transport for the contract's `Uint8Array`; no JSON shape exists for
/// the blob) and the `format` as a required query parameter.
async fn import(store: &SessionStore, id: &str, query: &Option<String>, body: Incoming) -> Resp {
    let Some(format) = query_value(query, "format") else {
        return problem(&EngineError::bad_argument(
            "import: query parameter 'format' is required",
        ));
    };
    let bytes = match read_bytes(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "import", move |s| {
        s.import(&bytes, &format)?;
        Ok(AckResponse { ok: true })
    })
}

/// `export` returns the raw workbook bytes (`application/octet-stream`); `format` is a
/// required query parameter. A serialize-free path -- the bytes are the body verbatim.
fn export(store: &SessionStore, id: &str, query: &Option<String>) -> Resp {
    let Some(format) = query_value(query, "format") else {
        return problem(&EngineError::bad_argument(
            "export: query parameter 'format' is required",
        ));
    };
    let Some(handle) = store.get(id) else {
        return problem(&session_not_found(id));
    };
    let result = guarded("export", || {
        let g = handle.lock();
        g.export(&format)
    });
    match result {
        Ok(bytes) => octet_stream(bytes),
        Err(e) => problem(&e),
    }
}

/// Debug-only panic-boundary probe: panics inside [`guarded`], which must surface
/// as a `[panic]`/500 problem+json WITHOUT killing the server (6.2-0 test).
#[cfg(debug_assertions)]
fn force_panic(store: &SessionStore, id: &str) -> Resp {
    with_session(
        store,
        id,
        "__force_panic",
        |_s| -> Result<AckResponse, EngineError> {
            panic!("forced panic for test (6.2-0 panic-boundary probe)");
        },
    )
}

// ---- shared plumbing ----

/// Look up the session, run `f` under the panic boundary while holding the
/// per-session lock, and render the result (200 JSON) or error (problem+json).
fn with_session<T: Serialize>(
    store: &SessionStore,
    id: &str,
    method: &str,
    f: impl FnOnce(&mut WorkbookSession) -> Result<T, EngineError>,
) -> Resp {
    let Some(handle) = store.get(id) else {
        return problem(&session_not_found(id));
    };
    let result = guarded(method, || {
        let mut g = handle.lock();
        f(&mut g)
    });
    match result {
        Ok(v) => json(StatusCode::OK, &v),
        Err(e) => problem(&e),
    }
}

fn lifecycle_state_str(s: LifecycleState) -> &'static str {
    match s {
        LifecycleState::New => "new",
        LifecycleState::Ready => "ready",
        LifecycleState::Busy => "busy",
        LifecycleState::Closed => "closed",
        LifecycleState::Faulted => "faulted",
    }
}

fn session_not_found(id: &str) -> EngineError {
    EngineError::new(
        ErrorClass::NotFound,
        "session_not_found",
        format!("no session with id '{id}'"),
    )
}

/// Read + JSON-parse a request body, mapping any failure to a loud `[bad_argument]`
/// problem+json (No-Fallbacks).
async fn read_json<T: DeserializeOwned>(body: Incoming) -> Result<T, Resp> {
    let collected = body.collect().await.map_err(|e| {
        problem(&EngineError::bad_argument(format!(
            "failed to read request body: {e}"
        )))
    })?;
    let bytes = collected.to_bytes();
    serde_json::from_slice::<T>(&bytes).map_err(|e| {
        problem(&EngineError::bad_argument(format!(
            "invalid JSON body: {e}"
        )))
    })
}

/// Read a request body as RAW bytes (no JSON parse) -- the `import` blob path.
async fn read_bytes(body: Incoming) -> Result<Vec<u8>, Resp> {
    let collected = body.collect().await.map_err(|e| {
        problem(&EngineError::bad_argument(format!(
            "failed to read request body: {e}"
        )))
    })?;
    Ok(collected.to_bytes().to_vec())
}

/// Read a `key=value` query parameter (no percent-decoding in v1 -- values like
/// `kind=dirty` are plain ASCII; richer parsing is deferred).
fn query_value(query: &Option<String>, key: &str) -> Option<String> {
    let q = query.as_deref()?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            return Some(it.next().unwrap_or("").to_string());
        }
    }
    None
}

/// Build a JSON `application/json` response. A serialize failure of our OWN
/// response types cannot normally happen; if it ever does it is surfaced loudly as
/// a 500 problem+json rather than dropped.
fn json<T: Serialize>(status: StatusCode, body: &T) -> Resp {
    match serde_json::to_vec(body) {
        Ok(bytes) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(bytes)))
            .expect("response builder with valid status/header never fails"),
        Err(e) => problem(&EngineError::panic(format!(
            "response serialize failed: {e}"
        ))),
    }
}

/// Build an `application/problem+json` response for an [`EngineError`].
fn problem(e: &EngineError) -> Resp {
    let (status, body) = engine_error_to_problem(e);
    // 6.2-0 audit (Codex MED-2 / Opus LOW-2): a serialize failure of our OWN
    // ProblemJson is impossible, but if it ever happened the last resort must be a
    // VALID static problem+json body -- NEVER an empty body (No-Fallbacks: a silent
    // empty 500 would mask the failure).
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| {
        br#"{"code":"panic","class":"internal","message":"problem serialize failed","retryable":false}"#
            .to_vec()
    });
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/problem+json")
        .body(Full::new(Bytes::from(bytes)))
        .expect("response builder with valid status/header never fails")
}

fn no_content() -> Resp {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Full::new(Bytes::new()))
        .expect("response builder with valid status never fails")
}

/// Build a raw `application/octet-stream` 200 response (the `export` byte blob).
fn octet_stream(bytes: Vec<u8>) -> Resp {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Full::new(Bytes::from(bytes)))
        .expect("response builder with valid status/header never fails")
}
