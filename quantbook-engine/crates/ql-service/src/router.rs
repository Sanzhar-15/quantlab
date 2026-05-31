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
//!
//! 6.2-1b endpoint set (cluster C structure/sheets + cluster D tables), all -> `{ ok }`:
//! - `POST   /v1/sessions/:id/rename-sheet`, `delete-sheet`, `restore-sheet`, `move-sheet`, `set-name`
//! - `POST   /v1/sessions/:id/create-table`, `rename-table`, `rename-column`, `resize-table`, `drop-table`
//!
//! 6.2-1c endpoint set (cluster E atomic/txn + reserved bulk + undo/delta + functions):
//! - `POST   /v1/sessions/:id/batch`                -> BatchResult wire
//! - `POST   /v1/sessions/:id/begin-transaction`    -> `{ txn }` (decimal string)
//! - `POST   /v1/sessions/:id/txn-add`              -> `{ ok }`
//! - `POST   /v1/sessions/:id/commit-transaction`   -> BatchResult wire
//! - `POST   /v1/sessions/:id/rollback-transaction` -> `{ ok }`
//! - `POST   /v1/sessions/:id/write-range`, `publish-dataset`, `bind-range`, `refresh-source`,
//!   `materialize-query` -> 501 `[not_implemented_in_v1_core]` (reserved sec-3.5)
//! - `POST   /v1/sessions/:id/undo`, `redo`         -> UndoRedoResult wire
//! - `GET    /v1/sessions/:id/can-undo`, `can-redo` -> bare bool
//! - `POST   /v1/sessions/:id/snapshot-delta`       -> WorkbookSnapshotDelta wire (consumes `version` hex)
//! - `POST   /v1/sessions/:id/register-function`, `unregister-function` -> `{ ok }`
//! - `GET    /v1/sessions/:id/functions`            -> FunctionMetadata wire array

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
    self, batch_result_to_wire, cell_range_from_wire, cell_snapshot_to_wire, cell_value_from_wire,
    diagnostic_to_wire, format_id_from_wire, function_metadata_from_wire, function_metadata_to_wire,
    range_result_to_wire, session_op_from_wire, sheet_info_to_wire, table_spec_from_wire,
    undo_redo_result_to_wire, workbook_snapshot_delta_to_wire, workbook_snapshot_to_wire,
    AddSheetBody, AddSheetResponse, BatchBody, BindRangeBody, CellBody, LifecycleResponse,
    MaterializeQueryBody, MoveSheetBody, NameBody, NewSessionResponse, PathBody, PublishDatasetBody,
    QueryRangeBody, RecalcResponse, RefreshSourceBody, RegisterFormatBody, RegisterFunctionBody,
    RenameColumnBody, RenameSheetBody, RenameTableBody, ResizeTableBody, SetFormatBody,
    SetFormulaBody, SetNameBody, SetValueBody, SheetIdBody, SnapshotDeltaBody, TableSpecWire,
    TransactionResponse, TxnAddBody, TxnIdBody, UnregisterFunctionBody, ValidateFormulaBody,
    WriteRangeBody,
};
use ql_session::session::{FunctionImplHandle, SessionOp, TransactionId};
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
        // ---- 6.2-1b cluster C (structure/sheets) ----
        ("POST", ["v1", "sessions", id, "rename-sheet"]) => rename_sheet(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "delete-sheet"]) => delete_sheet(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "restore-sheet"]) => restore_sheet(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "move-sheet"]) => move_sheet(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "set-name"]) => set_name(&store, id, body).await,
        // ---- 6.2-1b cluster D (tables) ----
        ("POST", ["v1", "sessions", id, "create-table"]) => create_table(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "rename-table"]) => rename_table(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "rename-column"]) => rename_column(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "resize-table"]) => resize_table(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "drop-table"]) => drop_table(&store, id, body).await,
        // ---- 6.2-1c cluster E (atomic groups / transactions) ----
        ("POST", ["v1", "sessions", id, "batch"]) => batch(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "begin-transaction"]) => begin_transaction(&store, id),
        ("POST", ["v1", "sessions", id, "txn-add"]) => txn_add(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "commit-transaction"]) => {
            commit_transaction(&store, id, body).await
        }
        ("POST", ["v1", "sessions", id, "rollback-transaction"]) => {
            rollback_transaction(&store, id, body).await
        }
        // ---- 6.2-1c reserved sec-3.5 bulk (always not_implemented_in_v1_core -> 501) ----
        ("POST", ["v1", "sessions", id, "write-range"]) => write_range(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "publish-dataset"]) => {
            publish_dataset(&store, id, body).await
        }
        ("POST", ["v1", "sessions", id, "bind-range"]) => bind_range(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "refresh-source"]) => refresh_source(&store, id, body).await,
        ("POST", ["v1", "sessions", id, "materialize-query"]) => {
            materialize_query(&store, id, body).await
        }
        // ---- 6.2-1c undo/redo ----
        ("POST", ["v1", "sessions", id, "undo"]) => undo(&store, id),
        ("POST", ["v1", "sessions", id, "redo"]) => redo(&store, id),
        ("GET", ["v1", "sessions", id, "can-undo"]) => can_undo(&store, id),
        ("GET", ["v1", "sessions", id, "can-redo"]) => can_redo(&store, id),
        // ---- 6.2-1c snapshot-delta (first version-consuming endpoint) ----
        ("POST", ["v1", "sessions", id, "snapshot-delta"]) => snapshot_delta(&store, id, body).await,
        // ---- 6.2-1c functions ----
        ("POST", ["v1", "sessions", id, "register-function"]) => {
            register_function(&store, id, body).await
        }
        ("POST", ["v1", "sessions", id, "unregister-function"]) => {
            unregister_function(&store, id, body).await
        }
        ("GET", ["v1", "sessions", id, "functions"]) => list_functions(&store, id),
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
    // Construct under the panic boundary too (every engine call is guarded): a
    // panic in `WorkbookSession::new()` surfaces as a `[panic]`/500 problem+json,
    // not an unwound connection task. The session is only registered on success.
    match guarded("createSession", || {
        Ok::<WorkbookSession, EngineError>(WorkbookSession::new())
    }) {
        Ok(session) => json(
            StatusCode::CREATED,
            &NewSessionResponse {
                session_id: store.register(session),
            },
        ),
        Err(e) => problem(&e),
    }
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

// ---- 6.2-1b cluster C handlers (structure/sheets) ----

async fn rename_sheet(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: RenameSheetBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "renameSheet", move |s| {
        s.rename_sheet(b.id, &b.new_name)?;
        Ok(AckResponse { ok: true })
    })
}

async fn delete_sheet(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SheetIdBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "deleteSheet", move |s| {
        s.delete_sheet(b.id)?;
        Ok(AckResponse { ok: true })
    })
}

async fn restore_sheet(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SheetIdBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "restoreSheet", move |s| {
        s.restore_sheet(b.id)?;
        Ok(AckResponse { ok: true })
    })
}

async fn move_sheet(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: MoveSheetBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "moveSheet", move |s| {
        s.move_sheet(b.id, b.new_index)?;
        Ok(AckResponse { ok: true })
    })
}

async fn set_name(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SetNameBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "setName", move |s| {
        s.set_name(&b.name, cell_range_from_wire(b.target))?;
        Ok(AckResponse { ok: true })
    })
}

// ---- 6.2-1b cluster D handlers (tables) ----

async fn create_table(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: TableSpecWire = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "createTable", move |s| {
        s.create_table(table_spec_from_wire(b))?;
        Ok(AckResponse { ok: true })
    })
}

async fn rename_table(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: RenameTableBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "renameTable", move |s| {
        s.rename_table(&b.old_name, &b.new_name)?;
        Ok(AckResponse { ok: true })
    })
}

async fn rename_column(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: RenameColumnBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "renameColumn", move |s| {
        s.rename_column(&b.table, &b.old_col, &b.new_col)?;
        Ok(AckResponse { ok: true })
    })
}

async fn resize_table(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: ResizeTableBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "resizeTable", move |s| {
        s.resize_table(
            &b.name,
            b.new_rows,
            b.new_cols,
            b.added_columns,
            b.removed_columns,
        )?;
        Ok(AckResponse { ok: true })
    })
}

async fn drop_table(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: NameBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "dropTable", move |s| {
        s.drop_table(&b.name)?;
        Ok(AckResponse { ok: true })
    })
}

// ---- 6.2-1c cluster E handlers (atomic groups / transactions) ----

async fn batch(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: BatchBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "batch", move |s| {
        let ops = b
            .ops
            .into_iter()
            .map(session_op_from_wire)
            .collect::<Result<Vec<SessionOp>, EngineError>>()?;
        let options = ql_session::BatchOptions {
            undo_label: b.options.undo_label,
        };
        Ok(batch_result_to_wire(s.batch(ops, options)?))
    })
}

fn begin_transaction(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "beginTransaction", |s| {
        Ok(TransactionResponse {
            txn: s.begin_transaction()?.0,
        })
    })
}

async fn txn_add(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: TxnAddBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "txnAdd", move |s| {
        let op = session_op_from_wire(b.op)?;
        s.txn_add(TransactionId(b.txn), op)?;
        Ok(AckResponse { ok: true })
    })
}

async fn commit_transaction(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: TxnIdBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "commitTransaction", move |s| {
        Ok(batch_result_to_wire(s.commit_transaction(TransactionId(b.txn))?))
    })
}

async fn rollback_transaction(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: TxnIdBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "rollbackTransaction", move |s| {
        s.rollback_transaction(TransactionId(b.txn))?;
        Ok(AckResponse { ok: true })
    })
}

// ---- 6.2-1c reserved sec-3.5 bulk handlers ----
//
// These ALWAYS surface `not_implemented_in_v1_core` (Capability -> 501) in v1 --
// the authoritative v1 signal. Each converts its inputs for type honesty (a bad
// coord / cell value / enum surfaces `[bad_argument]` first, mirroring napi 6.3-2e)
// then forwards to the engine stub, which returns Capability; the Ok arm is
// unreachable in v1 and discarded with `.map(|_| ())`. A real impl (6.4/6.5) only
// swaps the return type.

async fn write_range(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: WriteRangeBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "writeRange", move |s| {
        let range = cell_range_from_wire(b.range);
        let values = b
            .values
            .into_iter()
            .map(|row| row.into_iter().map(cell_value_from_wire).collect())
            .collect::<Result<Vec<Vec<_>>, EngineError>>()?;
        s.write_range(range, values).map(|_| ())?;
        Ok(AckResponse { ok: true })
    })
}

async fn publish_dataset(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: PublishDatasetBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "publishDataset", move |s| {
        let data = wire::parse_reserved_json_payload("publishDataset", &b.data)?;
        let target = cell_range_from_wire(b.target);
        s.publish_dataset(&b.name, data, target).map(|_| ())?;
        Ok(AckResponse { ok: true })
    })
}

async fn bind_range(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: BindRangeBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "bindRange", move |s| {
        let target = cell_range_from_wire(b.target);
        s.bind_range(&b.binding_id, target).map(|_| ())?;
        Ok(AckResponse { ok: true })
    })
}

async fn refresh_source(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: RefreshSourceBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "refreshSource", move |s| {
        s.refresh_source(&b.source_id, b.revision).map(|_| ())?;
        Ok(AckResponse { ok: true })
    })
}

async fn materialize_query(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: MaterializeQueryBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "materializeQuery", move |s| {
        let data = wire::parse_reserved_json_payload("materializeQuery", &b.data)?;
        let target = cell_range_from_wire(b.target);
        s.materialize_query(&b.query_id, target, data).map(|_| ())?;
        Ok(AckResponse { ok: true })
    })
}

// ---- 6.2-1c undo/redo handlers ----

fn undo(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "undo", |s| Ok(undo_redo_result_to_wire(s.undo()?)))
}

fn redo(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "redo", |s| Ok(undo_redo_result_to_wire(s.redo()?)))
}

/// `canUndo`/`canRedo` are pure bool reads (the engine method does not return a
/// `Result`); `guarded` only provides the panic boundary. The response body is a
/// bare JSON `true`/`false` (matching the napi bool return).
fn can_undo(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "canUndo", |s| {
        Ok::<bool, EngineError>(s.can_undo())
    })
}

fn can_redo(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "canRedo", |s| {
        Ok::<bool, EngineError>(s.can_redo())
    })
}

// ---- 6.2-1c snapshot-delta handler (first version-consuming endpoint) ----

/// `snapshot-delta` is the FIRST endpoint to CONSUME a `version` token: the request
/// body carries the caller's opaque token as hex, which [`wire::hex_decode`] turns
/// back into a [`ql_session::SessionVersion`] (an odd-length / non-hex token is a
/// loud `invalid_version_token` -> 400, BEFORE the engine call). An empty/stale/
/// epoch-mismatched (but well-formed) token is NOT an error -- the engine returns a
/// `fullRebuildRequired` delta with the designed reason.
async fn snapshot_delta(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: SnapshotDeltaBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let bytes = match wire::hex_decode(&b.version) {
        Ok(v) => v,
        Err(e) => return problem(&e),
    };
    with_session(store, id, "snapshotDelta", move |s| {
        let last = ql_session::SessionVersion(bytes);
        Ok(workbook_snapshot_delta_to_wire(s.snapshot_delta(&last)?))
    })
}

// ---- 6.2-1c functions handlers ----

async fn register_function(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: RegisterFunctionBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "registerFunction", move |s| {
        let meta = function_metadata_from_wire(b.metadata)?;
        s.register_function(meta, FunctionImplHandle(b.impl_handle))?;
        Ok(AckResponse { ok: true })
    })
}

async fn unregister_function(store: &SessionStore, id: &str, body: Incoming) -> Resp {
    let b: UnregisterFunctionBody = match read_json(body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    with_session(store, id, "unregisterFunction", move |s| {
        s.unregister_function(&b.canonical_name)?;
        Ok(AckResponse { ok: true })
    })
}

fn list_functions(store: &SessionStore, id: &str) -> Resp {
    with_session(store, id, "listFunctions", |s| {
        Ok(s.list_functions()?
            .into_iter()
            .map(function_metadata_to_wire)
            .collect::<Vec<_>>())
    })
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
