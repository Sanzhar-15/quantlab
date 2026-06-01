//! `quantbook._quantbook` — the thin Python (pyo3) **session facade** (Phase 6.3-4).
//!
//! The SECOND binding row of the 6.3 golden parity matrix. It wraps the SAME
//! binding-neutral `EngineSession` contract (`ql_session` trait + DTOs +
//! `EngineError`) over the SAME implementation (`ql_exec::WorkbookSession`) that
//! the napi binding (`ql-bindings-node`) wraps — so one canonical flow can run
//! through Node AND Python and prove the semantics cannot fork (entry-plan 6.3
//! §6: "the harness adds a binding by adding a row"). The contract is NOT
//! declared frozen until ≥2 structurally-different bindings pass the same rows;
//! this crate is that second binding.
//!
//! ## Scope — THIN (golden-flow only)
//!
//! Binds only the ~22 methods the golden flow exercises (entry-plan §6 / §7):
//! lifecycle/persistence, single edits, one structure op, tables, batch, recalc,
//! query/snapshot, undo/redo, function registration, events. The full authoring
//! surface (`qb.show`/`publish`/`bind` → the 5 deferred §2c bulk methods) is 6.5
//! territory and is NOT bound here. The richer session surface (transactions,
//! import/export, set_format, query_range, …) is filed forward.
//!
//! ## Design — mirrors `ql-bindings-node/src/lib.rs`
//!
//! - `Session { inner: Arc<Mutex<WorkbookSession>> }` — identical ownership to
//!   the napi `Session` (`WorkbookSession` is `Send`; `Arc<parking_lot::Mutex<
//!   Send>>` is `Send + Sync`, which `#[pyclass]` requires).
//! - `guarded(py, "method", || …)` — the pyo3 twin of the napi `guarded`:
//!   `catch_unwind` so a Rust panic surfaces as a structured `QuantbookError`
//!   with `code = "panic"` and does NOT abort the host (contract §8); the engine
//!   `FaultGuard` already sealed the session, `parking_lot` does not poison.
//! - `QuantbookError(Exception)` — carries the SAME contract-§5.1 attributes the
//!   napi native error carries (`code`/`class`/`retryable`/`details` (JSON
//!   string)/`source`), so the parity matrix reads `.code`/`.class` symmetrically.
//! - DTOs cross as **plain Python dicts** mirroring the napi JSON shape (same
//!   camelCase keys, same `kind`-tagged unions) so the cross-binding transcript
//!   comparison is structural and trivial.
//! - The same `validate_u32_index` / `validate_u16_index` / BigInt-equivalent
//!   (Python `int`) sign+range validators, and the same strict-tagged-union
//!   input converters (extraneous-for-kind field → loud `bad_argument`).
//!
//! NO engine logic changes — this is a pure binding-layer adapter.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use parking_lot::Mutex;
use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

use ql_exec::WorkbookSession as CoreWorkbookSession;
use ql_session::error::{EngineError, ErrorClass};
use ql_session::session::{EventCursor, FunctionImplHandle};
use ql_session::EngineSession;

create_exception!(
    _quantbook,
    QuantbookError,
    PyException,
    "Structured Quantbook engine error.\n\n\
     Carries the contract section-5.1 fields as instance attributes: `code` (stable\n\
     machine-matchable string), `class` (coarse category), `retryable` (bool),\n\
     `details` (a JSON string, present only when non-empty), and `source`\n\
     (present only when the engine attached a cause). Mirrors the native error\n\
     the napi binding throws, so a cross-binding harness can branch on `.code`."
);

// ============================================================================
// Error contract — the pyo3 twin of `engine_error_to_napi` / `throw_structured`.
// ============================================================================

/// Stable snake_case wire string for an [`ErrorClass`] (mirrors the napi
/// `class_str`; the engine enum's `#[serde(rename_all = "snake_case")]`).
fn class_str(c: ErrorClass) -> &'static str {
    match c {
        ErrorClass::BadArgument => "bad_argument",
        ErrorClass::Lifecycle => "lifecycle",
        ErrorClass::NotFound => "not_found",
        ErrorClass::Conflict => "conflict",
        ErrorClass::Compute => "compute",
        ErrorClass::Persistence => "persistence",
        ErrorClass::Protocol => "protocol",
        ErrorClass::Canceled => "canceled",
        ErrorClass::Capability => "capability",
        ErrorClass::Internal => "internal",
    }
}

/// Build a [`QuantbookError`] `PyErr` from an [`EngineError`], setting the
/// contract-§5.1 own-attributes on the exception value (the pyo3 twin of
/// `throw_structured`). `details` crosses as a JSON string (byte-identical to the
/// napi `details` convention — pyo3 has no native serde_json bridge here either).
fn engine_error_to_pyerr(py: Python<'_>, e: &EngineError) -> PyErr {
    let err = QuantbookError::new_err(e.message.clone());
    // Attribute-setting needs the GIL (held in `#[pymethods]`). If any setattr
    // fails (a real pyo3 defect, not an expected path), surface THAT loudly
    // rather than silently dropping the structured fields (No-Fallbacks).
    let set = (|| -> PyResult<()> {
        let val = err.value(py);
        val.setattr("code", e.code.as_str())?;
        // `class` is a Python soft keyword; settable/gettable via the string
        // name (mirrors the napi `.class` own-property). Read it from Python with
        // `getattr(err, "class")`.
        val.setattr("class", class_str(e.class))?;
        val.setattr("retryable", e.retryable)?;
        if !e.details.is_empty() {
            let details_json = serde_json::to_string(&e.details).map_err(|err| {
                engine_error_to_pyerr(
                    py,
                    &EngineError::panic(format!("EngineError.details serialize failed: {err}")),
                )
            })?;
            val.setattr("details", details_json)?;
        }
        if let Some(src) = &e.source {
            val.setattr("source", src.as_str())?;
        }
        Ok(())
    })();
    match set {
        Ok(()) => err,
        Err(set_err) => set_err,
    }
}

/// FFI arg-validation error (the pyo3 twin of the napi `bad_argument_error`).
/// Raises a structured `QuantbookError` with `code = "bad_argument"`; the parity
/// comparator recovers the code from the native `.code` attribute.
fn bad_argument(py: Python<'_>, message: impl Into<String>) -> PyErr {
    engine_error_to_pyerr(py, &EngineError::bad_argument(message.into()))
}

/// Run a method body under `catch_unwind` and map a caught panic to a structured
/// `[panic]` `QuantbookError` — the pyo3 twin of the napi `guarded`. Keeps the
/// host alive (contract §8); the engine `FaultGuard` already sealed the session
/// and `parking_lot::Mutex` does not poison, so the next call sees a consistent
/// (Faulted → `invalid_state`) session.
fn guarded<R>(py: Python<'_>, method: &str, f: impl FnOnce() -> PyResult<R>) -> PyResult<R> {
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => Err(engine_error_to_pyerr(
            py,
            &EngineError::panic(format!("{method}: {}", panic_payload_message(payload.as_ref()))),
        )),
    }
}

/// Best-effort panic message extraction (mirrors the napi `panic_payload_message`).
fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

// ============================================================================
// Numeric validators — mirror the napi `validate_u32_index` / `validate_u16_index`.
//
// Python ints do not silently coerce like napi's `ToUint32`, but a caller can
// still pass a float / negative / oversize value, so the same loud validation is
// applied for cross-binding parity (a malformed index is `bad_argument`, never a
// silently-floored write).
// ============================================================================

fn validate_u32_index(py: Python<'_>, method: &str, name: &str, value: f64) -> PyResult<u32> {
    if !value.is_finite() {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be a finite non-negative integer, got {value}"),
        ));
    }
    if value < 0.0 {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be a non-negative integer, got {value}"),
        ));
    }
    if value.fract() != 0.0 {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be an integer, got {value}"),
        ));
    }
    if value > f64::from(u32::MAX) {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be in [0, 4294967295] (u32::MAX), got {value}"),
        ));
    }
    Ok(value as u32)
}

fn validate_u16_index(py: Python<'_>, method: &str, name: &str, value: f64) -> PyResult<u16> {
    if !value.is_finite() {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be a finite non-negative integer, got {value}"),
        ));
    }
    if value < 0.0 {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be a non-negative integer, got {value}"),
        ));
    }
    if value.fract() != 0.0 {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be an integer, got {value}"),
        ));
    }
    if value > f64::from(u16::MAX) {
        return Err(bad_argument(
            py,
            format!("{method}: {name} must be in [0, 65535] (u16::MAX), got {value}"),
        ));
    }
    Ok(value as u16)
}

/// Build a validated [`ql_session::CellAddr`] from raw Python floats (the pyo3
/// twin of `session_addr_from_f64`).
fn session_addr(py: Python<'_>, method: &str, sheet: f64, row: f64, col: f64) -> PyResult<ql_session::CellAddr> {
    Ok(ql_session::CellAddr {
        sheet: validate_u16_index(py, method, "sheet", sheet)?,
        row: validate_u32_index(py, method, "row", row)?,
        col: validate_u32_index(py, method, "col", col)?,
    })
}

/// Build a validated [`ql_session::CellRange`] from a Python dict
/// (`{sheet, startRow, startCol, endRow, endCol}`; camelCase keys matching
/// the napi `CellRangeJson`). The pyo3 twin of `session_range_from_json`.
fn session_range(py: Python<'_>, method: &str, d: &Bound<'_, PyDict>) -> PyResult<ql_session::CellRange> {
    Ok(ql_session::CellRange {
        sheet: validate_u16_index(py, method, "sheet", req_f64(py, d, "sheet", method)?)?,
        start_row: validate_u32_index(py, method, "startRow", req_f64(py, d, "startRow", method)?)?,
        start_col: validate_u32_index(py, method, "startCol", req_f64(py, d, "startCol", method)?)?,
        end_row: validate_u32_index(py, method, "endRow", req_f64(py, d, "endRow", method)?)?,
        end_col: validate_u32_index(py, method, "endCol", req_f64(py, d, "endCol", method)?)?,
    })
}

// ============================================================================
// Input converters (Python dict → engine DTO). Strict tagged unions, mirroring
// the napi `session_cell_value_from_json` / `session_op_from_json`.
// ============================================================================

/// Read an optional dict key as `f64`. **MED-1 (6.3-5):** a MISSING key → `None`
/// (absent, OK); a key PRESENT with an explicit `None`/`null` value → loud
/// `bad_argument` (a present-but-null field is malformed, matching napi's
/// `Option<f64>` reject-null — napi-rs rejects an explicit `null` for an
/// `Option<f64>` DTO field). A non-number → loud.
fn opt_f64(py: Python<'_>, d: &Bound<'_, PyDict>, key: &str, ctx: &str) -> PyResult<Option<f64>> {
    match d.get_item(key)? {
        None => Ok(None),
        Some(v) => {
            if v.is_none() {
                Err(bad_argument(
                    py,
                    format!("{ctx}: field '{key}' must not be explicitly null (omit it instead)"),
                ))
            } else {
                Ok(Some(v.extract::<f64>().map_err(|_| {
                    bad_argument(py, format!("{ctx}: field '{key}' must be a number"))
                })?))
            }
        }
    }
}

/// Map a Python value-dict (`{kind, number?|boolean?|text?}`) to a
/// [`ql_session::CellValue`]. Strict: each `kind` admits ONLY its own payload;
/// an extraneous-for-kind field is a loud `bad_argument` (mirrors the napi
/// `session_cell_value_from_json` No-Fallbacks discipline). `error`/`pending`
/// are engine-produced and rejected as inputs.
fn cell_value_from_py(py: Python<'_>, v: &Bound<'_, PyAny>) -> PyResult<ql_session::CellValue> {
    let d = v
        .cast::<PyDict>()
        .map_err(|_| bad_argument(py, "setValue: value must be an object/dict"))?;
    let kind: String = d
        .get_item("kind")?
        .ok_or_else(|| bad_argument(py, "setValue: value requires a 'kind' field"))?
        .extract()
        .map_err(|_| bad_argument(py, "setValue: 'kind' must be a string"))?;

    let has = |k: &str| -> PyResult<bool> {
        Ok(match d.get_item(k)? {
            None => false,
            Some(x) => !x.is_none(),
        })
    };
    let reject_extra = |present: bool, field: &str, kind: &str| -> PyResult<()> {
        if present {
            return Err(bad_argument(
                py,
                format!("setValue: value kind '{kind}' must not carry a '{field}' field"),
            ));
        }
        Ok(())
    };

    match kind.as_str() {
        "number" => {
            reject_extra(has("boolean")?, "boolean", "number")?;
            reject_extra(has("text")?, "text", "number")?;
            reject_extra(has("error")?, "error", "number")?;
            let n: f64 = d
                .get_item("number")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "setValue: kind 'number' requires a 'number' field"))?
                .extract()
                .map_err(|_| bad_argument(py, "setValue: 'number' must be a number"))?;
            if !n.is_finite() {
                return Err(bad_argument(py, format!("setValue: number must be finite, got {n}")));
            }
            Ok(ql_session::CellValue::Number { number: n })
        }
        "boolean" => {
            reject_extra(has("number")?, "number", "boolean")?;
            reject_extra(has("text")?, "text", "boolean")?;
            reject_extra(has("error")?, "error", "boolean")?;
            let b: bool = d
                .get_item("boolean")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "setValue: kind 'boolean' requires a 'boolean' field"))?
                .extract()
                .map_err(|_| bad_argument(py, "setValue: 'boolean' must be a bool"))?;
            Ok(ql_session::CellValue::Boolean { boolean: b })
        }
        "text" => {
            reject_extra(has("number")?, "number", "text")?;
            reject_extra(has("boolean")?, "boolean", "text")?;
            reject_extra(has("error")?, "error", "text")?;
            let t: String = d
                .get_item("text")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "setValue: kind 'text' requires a 'text' field"))?
                .extract()
                .map_err(|_| bad_argument(py, "setValue: 'text' must be a string"))?;
            Ok(ql_session::CellValue::Text { text: t })
        }
        "blank" => {
            reject_extra(has("number")?, "number", "blank")?;
            reject_extra(has("boolean")?, "boolean", "blank")?;
            reject_extra(has("text")?, "text", "blank")?;
            reject_extra(has("error")?, "error", "blank")?;
            Ok(ql_session::CellValue::Blank)
        }
        other => Err(bad_argument(
            py,
            format!(
                "setValue: unsupported value kind '{other}' \
                 (expected number|boolean|text|blank; 'error'/'pending' are engine-produced, read-only)"
            ),
        )),
    }
}

// ============================================================================
// Output converters (engine DTO → Python dict). Keys mirror the napi camelCase
// JSON shape; absent (None) fields are OMITTED (matching JS `undefined`), so the
// cross-binding transcript compares structurally. Opaque ids / version tokens
// are masked by the GOLDEN-FLOW HARNESS, not here — these converters emit the
// real bytes/ints so the facade stays a faithful adapter.
// ============================================================================

/// `ql_session::CellValue` → a Python dict (`{kind, number?|boolean?|text?|error?}`).
fn cell_value_to_py<'py>(py: Python<'py>, v: &ql_session::CellValue) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    use ql_session::CellValue as V;
    match v {
        V::Number { number } => {
            d.set_item("kind", "number")?;
            d.set_item("number", *number)?;
        }
        V::Boolean { boolean } => {
            d.set_item("kind", "boolean")?;
            d.set_item("boolean", *boolean)?;
        }
        V::Text { text } => {
            d.set_item("kind", "text")?;
            d.set_item("text", text)?;
        }
        V::Error { error } => {
            d.set_item("kind", "error")?;
            d.set_item("error", error)?;
        }
        V::Blank => {
            d.set_item("kind", "blank")?;
        }
        V::Pending => {
            d.set_item("kind", "pending")?;
        }
    }
    Ok(d)
}

/// `ql_session::FormatId` → a Python dict (`{kind, builtin?|customPeer?,customCounter?}`).
fn format_id_to_py<'py>(py: Python<'py>, id: &ql_session::FormatId) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    match id {
        ql_session::FormatId::Builtin { builtin } => {
            d.set_item("kind", "builtin")?;
            d.set_item("builtin", *builtin)?;
        }
        ql_session::FormatId::Custom { peer, counter } => {
            d.set_item("kind", "custom")?;
            // HIGH-A (6.3-5): u64 crosses as a DECIMAL STRING (the napi `customPeer`
            // BigInt renders to a quoted decimal string in the golden harness's
            // `stableStringify`); a Python int would render as a JSON number → a
            // cross-binding MISMATCH. `counter` is a u32 (JS number), not a u64.
            d.set_item("customPeer", peer.to_string())?;
            d.set_item("customCounter", *counter)?;
        }
    }
    Ok(d)
}

/// `ql_session::CellSnapshot` → a Python dict (`{row, col, value?, formula?, format?, rendered?}`).
fn cell_snapshot_to_py<'py>(py: Python<'py>, c: &ql_session::CellSnapshot) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("row", c.row)?;
    d.set_item("col", c.col)?;
    if let Some(v) = &c.value {
        d.set_item("value", cell_value_to_py(py, v)?)?;
    }
    if let Some(f) = &c.formula {
        d.set_item("formula", f)?;
    }
    if let Some(f) = &c.format {
        d.set_item("format", format_id_to_py(py, f)?)?;
    }
    if let Some(r) = &c.rendered {
        d.set_item("rendered", r)?;
    }
    Ok(d)
}

/// `ql_session::SheetSnapshot` → a Python dict (`{id, name, cells}`).
fn sheet_snapshot_to_py<'py>(py: Python<'py>, s: &ql_session::SheetSnapshot) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("id", u32::from(s.id))?;
    d.set_item("name", &s.name)?;
    let cells = PyList::empty(py);
    for c in &s.cells {
        cells.append(cell_snapshot_to_py(py, c)?)?;
    }
    d.set_item("cells", cells)?;
    Ok(d)
}

/// `ql_session::WorkbookSnapshot` → a Python dict mirroring `WorkbookSnapshotJson`.
fn snapshot_to_py<'py>(py: Python<'py>, snap: &ql_session::WorkbookSnapshot) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    let sheets = PyList::empty(py);
    for s in &snap.sheets {
        sheets.append(sheet_snapshot_to_py(py, s)?)?;
    }
    d.set_item("sheets", sheets)?;
    let formats = PyList::empty(py);
    for fd in &snap.formats {
        let fdd = PyDict::new(py);
        fdd.set_item("id", format_id_to_py(py, &fd.id)?)?;
        fdd.set_item("string", &fd.string)?;
        formats.append(fdd)?;
    }
    d.set_item("formats", formats)?;
    let date_system = match snap.date_system {
        ql_session::DateSystem::Excel1900 => "Excel1900",
        ql_session::DateSystem::Excel1904 => "Excel1904",
    };
    d.set_item("dateSystem", date_system)?;
    d.set_item("version", PyBytes::new(py, &snap.version.0))?;
    d.set_item("schemaVersion", snap.schema_version)?;
    Ok(d)
}

/// `ql_session::WorkbookSnapshotDelta` → a Python dict mirroring `WorkbookSnapshotDeltaJson`.
fn snapshot_delta_to_py<'py>(py: Python<'py>, delta: &ql_session::WorkbookSnapshotDelta) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    let changed = PyList::empty(py);
    for c in &delta.changed_cells {
        let cd = PyDict::new(py);
        cd.set_item("sheet", u32::from(c.sheet))?;
        cd.set_item("cell", cell_snapshot_to_py(py, &c.cell)?)?;
        changed.append(cd)?;
    }
    d.set_item("changedCells", changed)?;
    let removed = PyList::empty(py);
    for r in &delta.removed_cells {
        let rd = PyDict::new(py);
        rd.set_item("sheet", u32::from(r.sheet))?;
        rd.set_item("row", r.row)?;
        rd.set_item("col", r.col)?;
        removed.append(rd)?;
    }
    d.set_item("removedCells", removed)?;
    let sheets_changed = PyList::empty(py);
    for s in &delta.sheets_changed {
        sheets_changed.append(sheet_snapshot_to_py(py, s)?)?;
    }
    d.set_item("sheetsChanged", sheets_changed)?;
    let sheets_removed = PyList::empty(py);
    for id in &delta.sheets_removed {
        sheets_removed.append(u32::from(*id))?;
    }
    d.set_item("sheetsRemoved", sheets_removed)?;
    let formats_added = PyList::empty(py);
    for fd in &delta.formats_added {
        let fdd = PyDict::new(py);
        fdd.set_item("id", format_id_to_py(py, &fd.id)?)?;
        fdd.set_item("string", &fd.string)?;
        formats_added.append(fdd)?;
    }
    d.set_item("formatsAdded", formats_added)?;
    d.set_item("version", PyBytes::new(py, &delta.version.0))?;
    d.set_item("fullRebuildRequired", delta.full_rebuild_required)?;
    if let Some(reason) = &delta.full_rebuild_reason {
        let s = match reason {
            ql_session::FullRebuildReason::NoPriorVersion => "no_prior_version",
            ql_session::FullRebuildReason::CacheCleared => "cache_cleared",
            ql_session::FullRebuildReason::StaleHorizon => "stale_horizon",
            ql_session::FullRebuildReason::EpochMismatch => "epoch_mismatch",
        };
        d.set_item("fullRebuildReason", s)?;
    }
    d.set_item("schemaVersion", delta.schema_version)?;
    Ok(d)
}

// ---- function-metadata enum mappers (mirror the napi `*_from_str`/`*_to_str`) ----

fn arity_from_py(py: Python<'_>, a: &Bound<'_, PyDict>) -> PyResult<ql_session::function_meta::Arity> {
    use ql_session::function_meta::Arity;
    let kind: String = a
        .get_item("kind")?
        .ok_or_else(|| bad_argument(py, "arity requires a 'kind' field"))?
        .extract()
        .map_err(|_| bad_argument(py, "arity 'kind' must be a string"))?;
    let n = opt_f64(py, a, "n", "arity")?;
    let min = opt_f64(py, a, "min", "arity")?;
    let max = opt_f64(py, a, "max", "arity")?;
    match kind.as_str() {
        "fixed" => {
            if min.is_some() || max.is_some() {
                return Err(bad_argument(py, "arity kind 'fixed' must carry only 'n'"));
            }
            let n = n.ok_or_else(|| bad_argument(py, "arity kind 'fixed' requires field 'n'"))?;
            let n = validate_u32_index(py, "registerFunction", "arity.n", n)?;
            let n = u8::try_from(n)
                .map_err(|_| bad_argument(py, format!("arity 'fixed': n={n} exceeds u8 range (0..=255)")))?;
            Ok(Arity::Fixed { n })
        }
        "range" => {
            if n.is_some() {
                return Err(bad_argument(py, "arity kind 'range' must carry 'min'/'max', not 'n'"));
            }
            let min = min.ok_or_else(|| bad_argument(py, "arity kind 'range' requires field 'min'"))?;
            let min = validate_u32_index(py, "registerFunction", "arity.min", min)?;
            let min = u8::try_from(min)
                .map_err(|_| bad_argument(py, format!("arity 'range': min={min} exceeds u8 range (0..=255)")))?;
            let max = match max {
                None => None,
                Some(m) => {
                    let m = validate_u32_index(py, "registerFunction", "arity.max", m)?;
                    Some(u8::try_from(m).map_err(|_| {
                        bad_argument(py, format!("arity 'range': max={m} exceeds u8 range (0..=255)"))
                    })?)
                }
            };
            if let Some(mx) = max {
                if mx < min {
                    return Err(bad_argument(py, format!("arity 'range': max ({mx}) must be >= min ({min})")));
                }
            }
            Ok(Arity::Range { min, max })
        }
        "variadic" => {
            if n.is_some() || min.is_some() || max.is_some() {
                return Err(bad_argument(py, "arity kind 'variadic' must carry no payload"));
            }
            Ok(Arity::Variadic)
        }
        other => Err(bad_argument(
            py,
            format!("arity: unknown kind '{other}' (expected 'fixed'|'range'|'variadic')"),
        )),
    }
}

fn arity_to_py<'py>(py: Python<'py>, a: &ql_session::function_meta::Arity) -> PyResult<Bound<'py, PyDict>> {
    use ql_session::function_meta::Arity;
    let d = PyDict::new(py);
    match a {
        Arity::Fixed { n } => {
            d.set_item("kind", "fixed")?;
            d.set_item("n", u32::from(*n))?;
        }
        Arity::Range { min, max } => {
            d.set_item("kind", "range")?;
            d.set_item("min", u32::from(*min))?;
            if let Some(mx) = max {
                d.set_item("max", u32::from(*mx))?;
            }
        }
        Arity::Variadic => {
            d.set_item("kind", "variadic")?;
        }
    }
    Ok(d)
}

fn dict_str(py: Python<'_>, d: &Bound<'_, PyDict>, key: &str, ctx: &str) -> PyResult<String> {
    d.get_item(key)?
        .filter(|x| !x.is_none())
        .ok_or_else(|| bad_argument(py, format!("{ctx}: requires a '{key}' field")))?
        .extract()
        .map_err(|_| bad_argument(py, format!("{ctx}: '{key}' must be a string")))
}

fn function_metadata_from_py(
    py: Python<'_>,
    m: &Bound<'_, PyDict>,
) -> PyResult<ql_session::function_meta::FunctionMetadata> {
    use ql_session::function_meta::{ArgContext, ArgPolicy, BatchShape, CancelPolicy, DepShape, Volatility};

    let volatility = match dict_str(py, m, "volatility", "metadata")?.as_str() {
        "pure" => Volatility::Pure,
        "volatile" => Volatility::Volatile,
        "dynamic" => Volatility::Dynamic,
        o => return Err(bad_argument(py, format!("unknown volatility '{o}'"))),
    };
    let dep_shape = match dict_str(py, m, "depShape", "metadata")?.as_str() {
        "value_deps" => DepShape::ValueDeps,
        "address_only" => DepShape::AddressOnly,
        "lazy_shape" => DepShape::LazyShape,
        "custom" => DepShape::Custom,
        o => return Err(bad_argument(py, format!("unknown depShape '{o}'"))),
    };
    let batch_shape = match dict_str(py, m, "batchShape", "metadata")?.as_str() {
        "scalar" => BatchShape::Scalar,
        "array_batch" => BatchShape::ArrayBatch,
        o => return Err(bad_argument(py, format!("unknown batchShape '{o}'"))),
    };
    let arg_policy = match dict_str(py, m, "argPolicy", "metadata")?.as_str() {
        "strict" => ArgPolicy::Strict,
        "coercing" => ArgPolicy::Coercing,
        o => return Err(bad_argument(py, format!("unknown argPolicy '{o}'"))),
    };
    let cancellation = match dict_str(py, m, "cancellation", "metadata")?.as_str() {
        "cooperative" => CancelPolicy::Cooperative,
        "worker_kill" => CancelPolicy::WorkerKill,
        "non_cancelable" => CancelPolicy::NonCancelable,
        o => return Err(bad_argument(py, format!("unknown cancellation '{o}'"))),
    };
    let arg_context = match dict_str(py, m, "argContext", "metadata")?.as_str() {
        "scalar" => ArgContext::Scalar,
        "aggregate" => ArgContext::Aggregate,
        "reference" => ArgContext::Reference,
        o => return Err(bad_argument(py, format!("unknown argContext '{o}'"))),
    };

    let arity_obj = m
        .get_item("arity")?
        .ok_or_else(|| bad_argument(py, "metadata: requires an 'arity' field"))?;
    let arity_dict = arity_obj
        .cast::<PyDict>()
        .map_err(|_| bad_argument(py, "metadata: 'arity' must be an object/dict"))?;
    let arity = arity_from_py(py, arity_dict)?;

    // MED-1 (6.3-5): a MISSING key → None (OK); a PRESENT explicit-null →
    // loud bad_argument (matches napi `Option<String>` reject-null).
    let display_name = match m.get_item("displayName")? {
        None => None,
        Some(x) if x.is_none() => {
            return Err(bad_argument(
                py,
                "metadata: 'displayName' must not be explicitly null (omit it instead)",
            ))
        }
        Some(x) => Some(x.extract::<String>().map_err(|_| bad_argument(py, "metadata: 'displayName' must be a string"))?),
    };
    let aliases = req_str_list(py, m, "aliases", "metadata")?;
    let provenance_tags = req_str_list(py, m, "provenanceTags", "metadata")?;
    let determinism: bool = m
        .get_item("determinism")?
        .filter(|x| !x.is_none())
        .ok_or_else(|| bad_argument(py, "metadata: requires a 'determinism' field"))?
        .extract()
        .map_err(|_| bad_argument(py, "metadata: 'determinism' must be a bool"))?;

    Ok(ql_session::function_meta::FunctionMetadata {
        canonical_name: dict_str(py, m, "canonicalName", "metadata")?,
        display_name,
        aliases,
        arity,
        volatility,
        determinism,
        dep_shape,
        batch_shape,
        arg_policy,
        cancellation,
        arg_context,
        provenance_tags,
    })
}

/// Read a REQUIRED list-of-strings dict field. A missing/`None` field is a loud
/// `bad_argument` (No-Fallbacks): the napi DTOs model `aliases` /
/// `provenanceTags` / `columnNames` as non-`Option` `Vec<String>`, so a missing
/// field is a malformed DTO on the napi side too — Python must not silently
/// default it to `[]` (that would be a cross-binding divergence + a fallback).
/// An empty list is fine (the caller supplied it explicitly).
fn req_str_list(py: Python<'_>, d: &Bound<'_, PyDict>, key: &str, ctx: &str) -> PyResult<Vec<String>> {
    let item = d
        .get_item(key)?
        .filter(|x| !x.is_none())
        .ok_or_else(|| bad_argument(py, format!("{ctx}: requires a '{key}' field")))?;
    item.extract::<Vec<String>>()
        .map_err(|_| bad_argument(py, format!("{ctx}: '{key}' must be a list of strings")))
}

fn function_metadata_to_py<'py>(
    py: Python<'py>,
    m: &ql_session::function_meta::FunctionMetadata,
) -> PyResult<Bound<'py, PyDict>> {
    use ql_session::function_meta::{ArgContext, ArgPolicy, BatchShape, CancelPolicy, DepShape, Volatility};
    let d = PyDict::new(py);
    d.set_item("canonicalName", &m.canonical_name)?;
    if let Some(dn) = &m.display_name {
        d.set_item("displayName", dn)?;
    }
    d.set_item("aliases", m.aliases.clone())?;
    d.set_item("arity", arity_to_py(py, &m.arity)?)?;
    d.set_item(
        "volatility",
        match m.volatility {
            Volatility::Pure => "pure",
            Volatility::Volatile => "volatile",
            Volatility::Dynamic => "dynamic",
        },
    )?;
    d.set_item("determinism", m.determinism)?;
    d.set_item(
        "depShape",
        match m.dep_shape {
            DepShape::ValueDeps => "value_deps",
            DepShape::AddressOnly => "address_only",
            DepShape::LazyShape => "lazy_shape",
            DepShape::Custom => "custom",
        },
    )?;
    d.set_item(
        "batchShape",
        match m.batch_shape {
            BatchShape::Scalar => "scalar",
            BatchShape::ArrayBatch => "array_batch",
        },
    )?;
    d.set_item(
        "argPolicy",
        match m.arg_policy {
            ArgPolicy::Strict => "strict",
            ArgPolicy::Coercing => "coercing",
        },
    )?;
    d.set_item(
        "cancellation",
        match m.cancellation {
            CancelPolicy::Cooperative => "cooperative",
            CancelPolicy::WorkerKill => "worker_kill",
            CancelPolicy::NonCancelable => "non_cancelable",
        },
    )?;
    d.set_item(
        "argContext",
        match m.arg_context {
            ArgContext::Scalar => "scalar",
            ArgContext::Aggregate => "aggregate",
            ArgContext::Reference => "reference",
        },
    )?;
    d.set_item("provenanceTags", m.provenance_tags.clone())?;
    Ok(d)
}

/// Extract a non-negative `u64` from a Python object (the pyo3 twin of the napi
/// BigInt `(sign_bit, value, lossless)` discipline). Taking a `Bound<PyAny>` (not
/// a fixed-width `i128` param) means EVERY out-of-domain value — negative,
/// non-integer, or larger than `u64::MAX` (including beyond `i128::MAX`) — is
/// caught HERE and surfaced as a structured `bad_argument`, rather than as a
/// pre-`guarded` pyo3 conversion error. Mirrors the napi `BigInt`→u64 reject.
fn u64_from_pyany(py: Python<'_>, method: &str, name: &str, v: &Bound<'_, PyAny>) -> PyResult<u64> {
    v.extract::<u64>().map_err(|_| {
        bad_argument(
            py,
            format!("{method}: {name} must be a non-negative integer that fits u64"),
        )
    })
}

// ============================================================================
// The Session #[pyclass] — the thin facade.
// ============================================================================

/// The thin Python session facade over `ql_exec::WorkbookSession` (mirrors the
/// napi `Session`). `Arc<parking_lot::Mutex<…>>` for the same `Send + Sync`
/// reason as the napi binding.
#[pyclass(name = "Session")]
pub struct Session {
    inner: Arc<Mutex<CoreWorkbookSession>>,
}

#[pymethods]
impl Session {
    /// Construct a fresh, empty in-memory session (lifecycle `Ready`).
    ///
    /// **6.3-5 closure (HIGH-B):** routed through `guarded(py, ..)` like every other
    /// facade method so a construction panic becomes the structured
    /// `QuantbookError(code="panic", class="internal", ..)` instead of unwinding into
    /// CPython as a bare `PanicException`. Construction is allocation-only and
    /// realistically infallible; the guard makes the boundary uniform.
    #[new]
    fn new(py: Python<'_>) -> PyResult<Self> {
        guarded(py, "constructor", || {
            Ok(Self {
                inner: Arc::new(Mutex::new(CoreWorkbookSession::new())),
            })
        })
    }

    /// Current lifecycle state wire string (`new|ready|busy|closed|faulted`).
    fn lifecycle_state(&self, py: Python<'_>) -> PyResult<String> {
        guarded(py, "lifecycleState", || {
            use ql_session::LifecycleState as L;
            Ok(match self.inner.lock().lifecycle_state() {
                L::New => "new",
                L::Ready => "ready",
                L::Busy => "busy",
                L::Closed => "closed",
                L::Faulted => "faulted",
            }
            .to_string())
        })
    }

    /// Add a sheet; returns its assigned `SheetId` (u16 widened to u32).
    fn add_sheet(&self, py: Python<'_>, name: String, chunk_rows: f64) -> PyResult<u32> {
        guarded(py, "addSheet", || {
            let chunk_rows = validate_u32_index(py, "addSheet", "chunkRows", chunk_rows)?;
            if chunk_rows == 0 {
                return Err(bad_argument(py, "addSheet: chunkRows must be >= 1"));
            }
            let id = self
                .inner
                .lock()
                .add_sheet(&name, chunk_rows)
                .map_err(|e| engine_error_to_pyerr(py, &e))?;
            Ok(u32::from(id))
        })
    }

    /// Set a cell's literal value (clears any formula). `value` is a value-dict.
    fn set_value(&self, py: Python<'_>, sheet: f64, row: f64, col: f64, value: Bound<'_, PyAny>) -> PyResult<()> {
        guarded(py, "setValue", || {
            let addr = session_addr(py, "setValue", sheet, row, col)?;
            let value = cell_value_from_py(py, &value)?;
            self.inner.lock().set_value(addr, value).map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// Set a cell's formula (BODY without a leading `=`).
    fn set_formula(&self, py: Python<'_>, sheet: f64, row: f64, col: f64, text: String) -> PyResult<()> {
        guarded(py, "setFormula", || {
            let addr = session_addr(py, "setFormula", sheet, row, col)?;
            self.inner.lock().set_formula(addr, &text).map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// Clear a cell's formula (convert-to-literal; preserves the cached value).
    fn clear(&self, py: Python<'_>, sheet: f64, row: f64, col: f64) -> PyResult<()> {
        guarded(py, "clear", || {
            let addr = session_addr(py, "clear", sheet, row, col)?;
            self.inner.lock().clear(addr).map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// Create a table from a spec-dict (mirrors `TableSpecJson`).
    fn create_table(&self, py: Python<'_>, spec: Bound<'_, PyDict>) -> PyResult<()> {
        guarded(py, "createTable", || {
            let name = dict_str(py, &spec, "name", "createTable")?;
            let sheet = validate_u16_index(py, "createTable", "sheet", req_f64(py, &spec, "sheet", "createTable")?)?;
            let top_row = validate_u32_index(py, "createTable", "topRow", req_f64(py, &spec, "topRow", "createTable")?)?;
            let top_col = validate_u32_index(py, "createTable", "topCol", req_f64(py, &spec, "topCol", "createTable")?)?;
            let rows = validate_u32_index(py, "createTable", "rows", req_f64(py, &spec, "rows", "createTable")?)?;
            let cols = validate_u32_index(py, "createTable", "cols", req_f64(py, &spec, "cols", "createTable")?)?;
            let has_header = req_bool(py, &spec, "hasHeader", "createTable")?;
            let has_totals = req_bool(py, &spec, "hasTotals", "createTable")?;
            let column_names = req_str_list(py, &spec, "columnNames", "createTable")?;
            let table_spec = ql_session::TableSpec {
                name,
                sheet,
                top_row,
                top_col,
                rows,
                cols,
                has_header,
                has_totals,
                column_names,
            };
            self.inner.lock().create_table(table_spec).map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// Apply ops atomically (one undo unit). `ops` is a list of op-dicts; returns
    /// `{applied, version}` (version is the opaque post-batch token as `bytes`).
    fn batch(&self, py: Python<'_>, ops: Vec<Bound<'_, PyDict>>, options: Bound<'_, PyDict>) -> PyResult<Py<PyDict>> {
        guarded(py, "batch", || {
            let mut session_ops = Vec::with_capacity(ops.len());
            for op in &ops {
                session_ops.push(session_op_from_py(py, op)?);
            }
            let undo_label = match options.get_item("undoLabel")? {
                None => None,
                Some(x) if x.is_none() => None,
                Some(x) => Some(x.extract::<String>().map_err(|_| bad_argument(py, "batch: 'undoLabel' must be a string"))?),
            };
            let result = self
                .inner
                .lock()
                .batch(session_ops, ql_session::BatchOptions { undo_label })
                .map_err(|e| engine_error_to_pyerr(py, &e))?;
            let d = PyDict::new(py);
            d.set_item("applied", result.applied)?;
            d.set_item("version", PyBytes::new(py, &result.version.0))?;
            Ok(d.unbind())
        })
    }

    /// Recompute the dirty set; returns the operation id (u64 as a DECIMAL STRING,
    /// mirroring the napi `recalcDirty` BigInt → quoted-decimal harness rendering —
    /// HIGH-A, 6.3-5).
    fn recalc_dirty(&self, py: Python<'_>) -> PyResult<String> {
        guarded(py, "recalcDirty", || {
            let op = self.inner.lock().recalc_dirty().map_err(|e| engine_error_to_pyerr(py, &e))?;
            Ok(op.0.to_string())
        })
    }

    /// Recompute everything; returns the operation id (u64 as a DECIMAL STRING,
    /// mirroring the napi `recalcAll` BigInt rendering — HIGH-A, 6.3-5).
    fn recalc_all(&self, py: Python<'_>) -> PyResult<String> {
        guarded(py, "recalcAll", || {
            let op = self.inner.lock().recalc_all().map_err(|e| engine_error_to_pyerr(py, &e))?;
            Ok(op.0.to_string())
        })
    }

    /// Full workbook snapshot (a dict; carries the opaque `version` as `bytes`).
    fn snapshot(&self, py: Python<'_>) -> PyResult<Py<PyDict>> {
        guarded(py, "snapshot", || {
            let snap = self.inner.lock().snapshot().map_err(|e| engine_error_to_pyerr(py, &e))?;
            Ok(snapshot_to_py(py, &snap)?.unbind())
        })
    }

    /// Incremental delta since `last_version` (`bytes`); returns a delta-dict.
    fn snapshot_delta(&self, py: Python<'_>, last_version: Vec<u8>) -> PyResult<Py<PyDict>> {
        guarded(py, "snapshotDelta", || {
            let last = ql_session::SessionVersion(last_version);
            let delta = self.inner.lock().snapshot_delta(&last).map_err(|e| engine_error_to_pyerr(py, &e))?;
            Ok(snapshot_delta_to_py(py, &delta)?.unbind())
        })
    }

    /// Single-cell lookup; `None` if the cell is empty/absent.
    fn cell(&self, py: Python<'_>, sheet: f64, row: f64, col: f64) -> PyResult<Option<Py<PyDict>>> {
        guarded(py, "cell", || {
            let addr = session_addr(py, "cell", sheet, row, col)?;
            let cell = self.inner.lock().cell(addr).map_err(|e| engine_error_to_pyerr(py, &e))?;
            match cell {
                None => Ok(None),
                Some(c) => Ok(Some(cell_snapshot_to_py(py, &c)?.unbind())),
            }
        })
    }

    /// List (non-tombstoned) sheets as `[{id, name}, …]`.
    fn list_sheets(&self, py: Python<'_>) -> PyResult<Py<PyList>> {
        guarded(py, "listSheets", || {
            let sheets = self.inner.lock().list_sheets().map_err(|e| engine_error_to_pyerr(py, &e))?;
            let out = PyList::empty(py);
            for s in sheets {
                let d = PyDict::new(py);
                d.set_item("id", u32::from(s.id))?;
                d.set_item("name", s.name)?;
                out.append(d)?;
            }
            Ok(out.unbind())
        })
    }

    /// Undo the last committed step; returns `{consumed, version}` (`version` as `bytes`).
    fn undo(&self, py: Python<'_>) -> PyResult<Py<PyDict>> {
        guarded(py, "undo", || {
            let r = self.inner.lock().undo().map_err(|e| engine_error_to_pyerr(py, &e))?;
            let d = PyDict::new(py);
            d.set_item("consumed", r.consumed)?;
            d.set_item("version", PyBytes::new(py, &r.version.0))?;
            Ok(d.unbind())
        })
    }

    /// Redo the last undone step; symmetric to `undo`.
    fn redo(&self, py: Python<'_>) -> PyResult<Py<PyDict>> {
        guarded(py, "redo", || {
            let r = self.inner.lock().redo().map_err(|e| engine_error_to_pyerr(py, &e))?;
            let d = PyDict::new(py);
            d.set_item("consumed", r.consumed)?;
            d.set_item("version", PyBytes::new(py, &r.version.0))?;
            Ok(d.unbind())
        })
    }

    /// Whether an undo step is available (pure read).
    fn can_undo(&self, py: Python<'_>) -> PyResult<bool> {
        guarded(py, "canUndo", || Ok(self.inner.lock().can_undo()))
    }

    /// Whether a redo step is available (pure read).
    fn can_redo(&self, py: Python<'_>) -> PyResult<bool> {
        guarded(py, "canRedo", || Ok(self.inner.lock().can_redo()))
    }

    /// Register a UDF from a metadata-dict + an `int` impl handle. Stores
    /// metadata + handle (does NOT dispatch — matches the napi 6.4-2 behavior).
    fn register_function(&self, py: Python<'_>, metadata: Bound<'_, PyDict>, impl_handle: Bound<'_, PyAny>) -> PyResult<()> {
        guarded(py, "registerFunction", || {
            let meta = function_metadata_from_py(py, &metadata)?;
            let raw = u64_from_pyany(py, "registerFunction", "implHandle", &impl_handle)?;
            self.inner
                .lock()
                .register_function(meta, FunctionImplHandle(raw))
                .map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// List every registered function (built-ins + UDFs), sorted by canonical name.
    fn list_functions(&self, py: Python<'_>) -> PyResult<Py<PyList>> {
        guarded(py, "listFunctions", || {
            let metas = self.inner.lock().list_functions().map_err(|e| engine_error_to_pyerr(py, &e))?;
            let out = PyList::empty(py);
            for m in metas {
                out.append(function_metadata_to_py(py, &m)?)?;
            }
            Ok(out.unbind())
        })
    }

    /// Drain a page of events from the ring (`cursor` as `int`); returns
    /// `{events, nextCursor, dropped}`.
    fn poll_events(&self, py: Python<'_>, cursor: Bound<'_, PyAny>) -> PyResult<Py<PyDict>> {
        guarded(py, "pollEvents", || {
            let raw = u64_from_pyany(py, "pollEvents", "cursor", &cursor)?;
            let page = self
                .inner
                .lock()
                .poll_events(EventCursor(raw))
                .map_err(|e| engine_error_to_pyerr(py, &e))?;
            Ok(event_page_to_py(py, &page)?.unbind())
        })
    }

    /// Open a `.qbook` workbook from `path` (New → Ready; the engine re-mints the
    /// epoch). Mirrors the napi `open`; a missing file / bad envelope surfaces a
    /// structured `[persistence]` error. `[invalid_state]` off an openable state.
    fn open(&self, py: Python<'_>, path: String) -> PyResult<()> {
        guarded(py, "open", || {
            self.inner.lock().open(&path).map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// Save the live workbook + this session's op-log to a `.qbook` at `path`
    /// (atomic rename). Mirrors the napi `save`. `[invalid_state]` off a readable
    /// state; I/O / serialization failures surface `[persistence]`.
    fn save(&self, py: Python<'_>, path: String) -> PyResult<()> {
        guarded(py, "save", || {
            self.inner.lock().save(&path).map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// Bulk-write a rectangular value matrix into `range`; dirties dependents. `range`
    /// is a dict `{sheet, startRow, startCol, endRow, endCol}` (same camelCase as the
    /// napi `CellRangeJson`). `values` is a list-of-rows (row-major); each cell is a
    /// value-dict (`{kind, number?|boolean?|text?}`). Returns `{written, version}`.
    fn write_range(
        &self,
        py: Python<'_>,
        range: Bound<'_, PyDict>,
        values: Vec<Vec<Bound<'_, PyAny>>>,
    ) -> PyResult<Py<PyDict>> {
        guarded(py, "writeRange", || {
            let range = session_range(py, "writeRange", &range)?;
            let values: Vec<Vec<ql_session::CellValue>> = values
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|v| cell_value_from_py(py, &v))
                        .collect::<PyResult<Vec<_>>>()
                })
                .collect::<PyResult<Vec<_>>>()?;
            let result = self
                .inner
                .lock()
                .write_range(range, values)
                .map_err(|e| engine_error_to_pyerr(py, &e))?;
            let d = PyDict::new(py);
            d.set_item("written", result.written)?;
            d.set_item("version", PyBytes::new(py, &result.version.0))?;
            Ok(d.unbind())
        })
    }

    /// Refresh an external source by revision; dirties dependent cells. `revision` is
    /// a non-negative int (mirrors the napi `BigInt`). A `revision <= last stored` is a
    /// no-op (`dirtied: 0`). Returns `{dirtied, version}`.
    fn refresh_source(
        &self,
        py: Python<'_>,
        source_id: String,
        revision: Bound<'_, PyAny>,
    ) -> PyResult<Py<PyDict>> {
        guarded(py, "refreshSource", || {
            let revision = u64_from_pyany(py, "refreshSource", "revision", &revision)?;
            let result = self
                .inner
                .lock()
                .refresh_source(&source_id, revision)
                .map_err(|e| engine_error_to_pyerr(py, &e))?;
            let d = PyDict::new(py);
            d.set_item("dirtied", result.dirtied)?;
            d.set_item("version", PyBytes::new(py, &result.version.0))?;
            Ok(d.unbind())
        })
    }

    /// Materialize a SQL query into `target`. `target` is a range-dict
    /// `{sheet, startRow, startCol, endRow, endCol}`; `data` is a JSON string (e.g.
    /// `'{"sql":"SELECT ..."}'`). Returns `{id}` (the caller's `query_id` echoed back).
    fn materialize_query(
        &self,
        py: Python<'_>,
        query_id: String,
        target: Bound<'_, PyDict>,
        data: String,
    ) -> PyResult<Py<PyDict>> {
        guarded(py, "materializeQuery", || {
            let target = session_range(py, "materializeQuery", &target)?;
            let data: serde_json::Value = serde_json::from_str(&data).map_err(|e| {
                bad_argument(py, format!("materializeQuery: data must be valid JSON text ({e})"))
            })?;
            let result = self
                .inner
                .lock()
                .materialize_query(&query_id, target, data)
                .map_err(|e| engine_error_to_pyerr(py, &e))?;
            let d = PyDict::new(py);
            d.set_item("id", result.id)?;
            Ok(d.unbind())
        })
    }

    /// Deterministically release the session (transition to Closed). Idempotent.
    fn close(&self, py: Python<'_>) -> PyResult<()> {
        guarded(py, "close", || {
            self.inner.lock().close().map_err(|e| engine_error_to_pyerr(py, &e))
        })
    }

    /// **M1 panic-boundary probe (debug-only).** A per-method
    /// `#[cfg(debug_assertions)]` (absent from release artifacts). Forces a Rust
    /// panic INSIDE `guarded` so the golden flow can assert the panic surfaces as
    /// a `QuantbookError` (code `panic`) and does NOT abort the host — and that
    /// the session stays usable afterward. **Unlike napi-derive, pyo3's
    /// `#[pymethods]` macro honors a per-method `#[cfg]`, so this lives INSIDE the
    /// single methods block — a second `#[pymethods] impl Session` would be an
    /// `E0119` conflict without the `multiple-pymethods` feature.**
    #[cfg(debug_assertions)]
    fn __force_panic_for_test(&self, py: Python<'_>) -> PyResult<()> {
        guarded(py, "__forcePanicForTest", || -> PyResult<()> {
            panic!("forced panic for the panic-boundary parity test");
        })
    }
}

// ---- small dict-read helpers used by create_table ----

fn req_f64(py: Python<'_>, d: &Bound<'_, PyDict>, key: &str, ctx: &str) -> PyResult<f64> {
    d.get_item(key)?
        .filter(|x| !x.is_none())
        .ok_or_else(|| bad_argument(py, format!("{ctx}: requires a '{key}' field")))?
        .extract()
        .map_err(|_| bad_argument(py, format!("{ctx}: '{key}' must be a number")))
}

fn req_bool(py: Python<'_>, d: &Bound<'_, PyDict>, key: &str, ctx: &str) -> PyResult<bool> {
    d.get_item(key)?
        .filter(|x| !x.is_none())
        .ok_or_else(|| bad_argument(py, format!("{ctx}: requires a '{key}' field")))?
        .extract()
        .map_err(|_| bad_argument(py, format!("{ctx}: '{key}' must be a bool")))
}

/// Map a Python format-dict (`{kind, builtin?|customPeer?,customCounter?}`) to a
/// [`ql_session::FormatId`] (the input twin of [`format_id_to_py`]; mirrors the
/// napi `session_format_id_from_json`). Strict tagged union: each `kind` admits
/// ONLY its own payload; `customPeer` is a non-negative u64.
fn format_id_from_py(py: Python<'_>, v: &Bound<'_, PyAny>) -> PyResult<ql_session::FormatId> {
    let d = v
        .cast::<PyDict>()
        .map_err(|_| bad_argument(py, "setFormat: format must be an object/dict"))?;
    let kind = dict_str(py, d, "kind", "setFormat")?;
    let has = |k: &str| -> PyResult<bool> {
        Ok(match d.get_item(k)? {
            None => false,
            Some(x) => !x.is_none(),
        })
    };
    match kind.as_str() {
        "builtin" => {
            if has("customPeer")? || has("customCounter")? {
                return Err(bad_argument(
                    py,
                    "setFormat: format id kind 'builtin' must not carry 'customPeer'/'customCounter'",
                ));
            }
            let builtin = validate_u32_index(py, "setFormat", "builtin", req_f64(py, d, "builtin", "setFormat")?)?;
            Ok(ql_session::FormatId::Builtin { builtin })
        }
        "custom" => {
            if has("builtin")? {
                return Err(bad_argument(py, "setFormat: format id kind 'custom' must not carry 'builtin'"));
            }
            let peer_obj = d
                .get_item("customPeer")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "setFormat: kind 'custom' requires a 'customPeer' field"))?;
            let peer = u64_from_pyany(py, "setFormat", "customPeer", &peer_obj)?;
            let counter = validate_u32_index(py, "setFormat", "customCounter", req_f64(py, d, "customCounter", "setFormat")?)?;
            Ok(ql_session::FormatId::Custom { peer, counter })
        }
        other => Err(bad_argument(
            py,
            format!("setFormat: unsupported format id kind '{other}' (expected builtin|custom)"),
        )),
    }
}

/// Map a Python op-dict (`{kind, sheet, row, col, value?|text?|format?}`) to a
/// [`ql_session::session::SessionOp`]. Strict tagged union (mirrors the napi
/// `session_op_from_json`): extraneous-for-kind field → loud `bad_argument`.
fn session_op_from_py(py: Python<'_>, op: &Bound<'_, PyDict>) -> PyResult<ql_session::session::SessionOp> {
    use ql_session::session::SessionOp;
    let kind = dict_str(py, op, "kind", "batch")?;
    let addr = session_addr(
        py,
        "batch",
        req_f64(py, op, "sheet", "batch")?,
        req_f64(py, op, "row", "batch")?,
        req_f64(py, op, "col", "batch")?,
    )?;
    let has = |k: &str| -> PyResult<bool> {
        Ok(match op.get_item(k)? {
            None => false,
            Some(x) => !x.is_none(),
        })
    };
    let reject_extra = |present: bool, field: &str, kind: &str| -> PyResult<()> {
        if present {
            return Err(bad_argument(
                py,
                format!("batch: SessionOp kind '{kind}' must not carry a '{field}' field"),
            ));
        }
        Ok(())
    };
    match kind.as_str() {
        "setValue" => {
            reject_extra(has("text")?, "text", "setValue")?;
            reject_extra(has("format")?, "format", "setValue")?;
            let value = op
                .get_item("value")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "batch: SessionOp kind 'setValue' requires a 'value' field"))?;
            Ok(SessionOp::SetValue {
                addr,
                value: cell_value_from_py(py, &value)?,
            })
        }
        "setFormula" => {
            reject_extra(has("value")?, "value", "setFormula")?;
            reject_extra(has("format")?, "format", "setFormula")?;
            let text = op
                .get_item("text")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "batch: SessionOp kind 'setFormula' requires a 'text' field"))?
                .extract::<String>()
                .map_err(|_| bad_argument(py, "batch: SessionOp 'text' must be a string"))?;
            Ok(SessionOp::SetFormula { addr, text })
        }
        "clear" => {
            reject_extra(has("value")?, "value", "clear")?;
            reject_extra(has("text")?, "text", "clear")?;
            reject_extra(has("format")?, "format", "clear")?;
            Ok(SessionOp::Clear { addr })
        }
        "setFormat" => {
            reject_extra(has("value")?, "value", "setFormat")?;
            reject_extra(has("text")?, "text", "setFormat")?;
            let fmt = op
                .get_item("format")?
                .filter(|x| !x.is_none())
                .ok_or_else(|| bad_argument(py, "batch: SessionOp kind 'setFormat' requires a 'format' field"))?;
            Ok(SessionOp::SetFormat {
                addr,
                format: format_id_from_py(py, &fmt)?,
            })
        }
        other => Err(bad_argument(
            py,
            format!("batch: unknown SessionOp kind '{other}' (expected setValue|setFormula|clear|setFormat)"),
        )),
    }
}

/// `ql_session::session::EventPage` → a Python dict mirroring `EventPageJson`.
fn event_page_to_py<'py>(py: Python<'py>, page: &ql_session::session::EventPage) -> PyResult<Bound<'py, PyDict>> {
    use ql_session::session::Event;
    let d = PyDict::new(py);
    let events = PyList::empty(py);
    for e in &page.events {
        let ed = PyDict::new(py);
        match e {
            Event::RecalcProgress { op, done, total } => {
                ed.set_item("kind", "recalc_progress")?;
                // HIGH-A (6.3-5): every u64 wire field crosses as a DECIMAL STRING
                // to match the napi BigInt → quoted-decimal harness rendering
                // (`op`/`done`/`total` are all `BigInt::from(...)` on the napi side —
                // no count-vs-id special-casing).
                ed.set_item("op", op.0.to_string())?;
                ed.set_item("done", done.to_string())?;
                ed.set_item("total", total.to_string())?;
            }
            Event::CellDiagnostic { diagnostic } => {
                ed.set_item("kind", "cell_diagnostic")?;
                ed.set_item("diagnostic", diagnostic_to_py(py, diagnostic)?)?;
            }
            Event::OperationCompleted { op, state } => {
                ed.set_item("kind", "operation_completed")?;
                // HIGH-A (6.3-5): u64 op id crosses as a decimal string (napi BigInt).
                ed.set_item("op", op.0.to_string())?;
                ed.set_item("state", operation_state_to_py(py, state)?)?;
            }
            Event::Provenance { addr, source } => {
                ed.set_item("kind", "provenance")?;
                ed.set_item("addr", cell_addr_to_py(py, addr)?)?;
                ed.set_item("source", source)?;
            }
            Event::StructureChanged { kind, target } => {
                ed.set_item("kind", "structure_changed")?;
                ed.set_item("structureKind", kind)?;
                ed.set_item("target", target)?;
            }
            Event::FullResyncRequired => {
                ed.set_item("kind", "full_resync_required")?;
            }
        }
        events.append(ed)?;
    }
    d.set_item("events", events)?;
    // HIGH-A (6.3-5): nextCursor is a u64 → decimal string (napi `BigInt::from`).
    // (The matrix MASKS nextCursor by value, but the WIRE TYPE must still be a
    // string so the masked placeholder substitutes a string for a string.)
    d.set_item("nextCursor", page.next_cursor.0.to_string())?;
    d.set_item("dropped", page.dropped)?;
    Ok(d)
}

fn cell_addr_to_py<'py>(py: Python<'py>, a: &ql_session::CellAddr) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("sheet", u32::from(a.sheet))?;
    d.set_item("row", a.row)?;
    d.set_item("col", a.col)?;
    Ok(d)
}

fn diagnostic_to_py<'py>(py: Python<'py>, dg: &ql_session::Diagnostic) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    if let Some(addr) = &dg.addr {
        d.set_item("addr", cell_addr_to_py(py, addr)?)?;
    }
    d.set_item(
        "severity",
        match dg.severity {
            ql_session::Severity::Info => "info",
            ql_session::Severity::Warning => "warning",
            ql_session::Severity::Error => "error",
        },
    )?;
    d.set_item("code", &dg.code)?;
    d.set_item("message", &dg.message)?;
    Ok(d)
}

fn operation_state_to_py<'py>(py: Python<'py>, s: &ql_session::OperationState) -> PyResult<Bound<'py, PyDict>> {
    use ql_session::OperationState as S;
    let d = PyDict::new(py);
    match s {
        S::Running => {
            d.set_item("state", "running")?;
        }
        S::Completed => {
            d.set_item("state", "completed")?;
        }
        S::Canceled => {
            d.set_item("state", "canceled")?;
        }
        S::Failed { error } => {
            d.set_item("state", "failed")?;
            // MED-5 (6.3-5): `error` is a NESTED structured object
            // {code, class, retryable, details?, source?} mirroring the napi
            // `OperationErrorJson` / `operation_error_json_from_engine_error` and the
            // IDE `OperationErrorJson` interface (was the legacy `[code] message`
            // string -- the retired anti-pattern). `details`/`source` are OMITTED when
            // absent so the dict matches napi's `Option<String>` -> undefined -> key
            // dropped by `JSON.stringify` (byte-parity across bindings).
            let ed = PyDict::new(py);
            ed.set_item("code", &error.code)?;
            ed.set_item("class", class_str(error.class))?;
            ed.set_item("retryable", error.retryable)?;
            if !error.details.is_empty() {
                ed.set_item(
                    "details",
                    serde_json::to_string(&error.details)
                        .unwrap_or_else(|err| format!("[details serialize failed: {err}]")),
                )?;
            }
            if let Some(src) = &error.source {
                ed.set_item("source", src)?;
            }
            d.set_item("error", ed)?;
        }
    }
    Ok(d)
}

/// The pyo3 module. MUST be named `_quantbook` so the export symbol is
/// `PyInit__quantbook` and `from quantbook import _quantbook` resolves.
#[pymodule]
fn _quantbook(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Session>()?;
    m.add("QuantbookError", m.py().get_type::<QuantbookError>())?;
    Ok(())
}

// **Send + Sync positive proof (audit Rule 4)** — mirrors the napi binding. The
// engine session is `Send`; `Arc<parking_lot::Mutex<Send>>` is `Send + Sync`,
// which `#[pyclass]` requires. If `assert_send::<CoreWorkbookSession>()` fails to
// compile, that is a REAL contract finding (the owning session is not
// FFI-shareable), not something to paper over.
const _ASSERT_PY_SESSION_SEND_SYNC: fn() = || {
    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}
    assert_send::<CoreWorkbookSession>();
    assert_send::<Session>();
    assert_sync::<Session>();
};
