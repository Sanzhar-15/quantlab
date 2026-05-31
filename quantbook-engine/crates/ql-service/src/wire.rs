//! Phase 6.2-0 (2026-06-01) -- JSON wire DTOs for the HTTP+SSE service.
//!
//! These reproduce the **frozen** napi `FooJson` wire shapes (`ql-bindings-node`,
//! the 6.3-5 FROZEN v1 contract) so the service is a third binding row that emits
//! byte-identical JSON. They are NOT the `ql_session` serde DTOs: those serialize
//! u64 as JSON *numbers* (the freeze requires decimal *strings*), use
//! `snake_case`/`lowercase` keys (the freeze is *camelCase*), and serialize
//! `SessionVersion` as a number array (the freeze treats it as an opaque buffer).
//! Hence this dedicated layer + the (6.2-4) golden-parity row that proves it
//! matches the napi/pyo3 rows.
//!
//! Conventions reproduced verbatim from napi:
//! - camelCase keys (`#[serde(rename_all = "camelCase")]`).
//! - `Option::None` -> ABSENT key (`skip_serializing_if`), matching napi-rs's
//!   `Option<T>` -> `undefined` -> dropped-by-`JSON.stringify`.
//! - every `u64` id/counter as a quoted DECIMAL STRING (napi emits `BigInt`,
//!   which `JSON.stringify` renders as a quoted string) -- [`u64_dec`]/[`opt_u64_dec`].
//! - `SessionVersion(Vec<u8>)` as a lowercase **hex** string. napi crosses it as a
//!   `Buffer`; JSON has no canonical buffer form, so the service defines hex as its
//!   opaque-token encoding. The token is opaque (callers round-trip verbatim) and
//!   is masked in the parity matrix, so the encoding is a service-local choice.

use serde::{Deserialize, Serialize};

use ql_session::error::EngineError;

// ---- u64-as-decimal-string serde helpers (the frozen wire convention) ----

/// Serialize a `u64` as a quoted decimal string; deserialize from one.
pub mod u64_dec {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<u64>().map_err(serde::de::Error::custom)
    }
}

/// `Option<u64>` as an optional quoted decimal string (absent when `None`).
pub mod opt_u64_dec {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(n) => s.serialize_some(&n.to_string()),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        let opt = Option::<String>::deserialize(d)?;
        match opt {
            Some(s) => s.parse::<u64>().map(Some).map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

/// Lowercase-hex encode opaque token bytes (the service's `version` wire form).
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // two lowercase hex digits per byte; no separators. Nibbles are 0..=15 so
        // `from_digit` is always `Some` (panic-free).
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// Decode a lowercase/uppercase hex `version` string back to bytes. Fail-loud on
/// odd length or a non-hex digit (`invalid_version_token` -- No-Fallbacks). The
/// inverse of [`hex_encode`]; used by version-consuming endpoints (6.2-1
/// `snapshot-delta` onward) -- added now (Codex 6.2-0 audit MED-3) so the opaque
/// token has a tested round-trip before any consumer relies on it.
pub fn hex_decode(s: &str) -> Result<Vec<u8>, EngineError> {
    if s.len() % 2 != 0 {
        return Err(EngineError::invalid_version_token(format!(
            "version hex has odd length {}",
            s.len()
        )));
    }
    let nibble = |c: u8| -> Result<u8, EngineError> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(EngineError::invalid_version_token(format!(
                "invalid hex digit {:?}",
                c as char
            ))),
        }
    };
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        out.push((nibble(bytes[i])? << 4) | nibble(bytes[i + 1])?);
        i += 2;
    }
    Ok(out)
}

// ---- value DTOs (mirror the napi FooJson structs) ----

/// Mirror of napi `CellValueJson`: a `kind`-tagged union. Exactly one payload
/// field is present for `number`/`boolean`/`text`/`error`; `blank`/`pending`
/// carry only `kind`.
///
/// **KNOWN number-encoding divergence (filed forward to 6.2-4; 6.2-1a audit
/// Codex HIGH, disposition: deferred).** `number` is an `f64` serialized by serde
/// (ryu), whereas napi crosses it as a JS `Number` that `JSON.stringify` renders
/// via the ECMAScript `Number::toString` algorithm. The serde and ECMAScript
/// renderings differ on AT LEAST these cases, so number values are NOT
/// byte-identical to the napi row today:
///
/// - integer-valued floats: serde `6.0` vs napi `6` (the headline case);
/// - signed zero: serde `-0.0` vs napi `0`;
/// - exponent thresholds + format: ECMAScript switches to exponent form at
///   `>=1e21` and `<1e-6` and writes `e+21`/`e-7`, where ryu's thresholds/format
///   differ.
///
/// Non-finite (`NaN`/`Inf`) is not a wire concern on OUTPUT (the engine does not
/// emit them as `CellValue::Number`; `cell_value_from_wire` rejects them on
/// INPUT), but the 6.2-4 serializer MUST pin a fail-loud policy if a future
/// engine/UDF path ever leaks one.
///
/// This is the 6.2-0 filed-forward item ("the whole-f64 cell-value representation
/// question for byte-identical parity (6.0 vs 6)") and already ships in the 6.2-0
/// `snapshot` endpoint; `queryRange` (6.2-1a) reuses the same
/// [`cell_value_to_wire`]. 6.2-4 resolves it against the parity matrix's ACTUAL
/// comparison mode: structural comparison treats `6.0`==`6` (no fix needed); only
/// a byte-identical mode requires a uniform ECMAScript `Number`->string serializer
/// (covering ALL the cases above) applied across ALL number-emitting endpoints
/// (here + snapshot), which is why it is NOT patched piecemeal in cluster A.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValueWire {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub number: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub boolean: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

/// Mirror of napi `FormatIdJson`. `builtin`/`customCounter` are whole `u32`s from
/// the engine, emitted as INTEGER JSON (`164`) to match napi's wire form -- napi
/// types them `f64` only so a malformed JS Number reaches its input validator
/// un-coerced, but its OUTPUT is always integer-valued and `JSON.stringify` renders
/// it without a decimal; serde would render an `f64` as `164.0`, diverging from the
/// frozen wire, so the service uses `u32`. `customPeer` is a `u64` emitted as a
/// decimal STRING (napi `BigInt`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatIdWire {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub builtin: Option<u32>,
    #[serde(with = "opt_u64_dec", skip_serializing_if = "Option::is_none", default)]
    pub custom_peer: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custom_counter: Option<u32>,
}

/// Mirror of napi `CellSnapshotJson`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellSnapshotWire {
    pub row: u32,
    pub col: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<CellValueWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub formula: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub format: Option<FormatIdWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rendered: Option<String>,
}

/// Mirror of napi `SheetSnapshotJson`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSnapshotWire {
    pub id: u32,
    pub name: String,
    pub cells: Vec<CellSnapshotWire>,
}

/// Mirror of napi `FormatDefJson`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDefWire {
    pub id: FormatIdWire,
    pub string: String,
}

/// Mirror of napi `WorkbookSnapshotJson`. `version` is the opaque token as
/// lowercase hex; `dateSystem` is `"Excel1900"`/`"Excel1904"`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookSnapshotWire {
    pub sheets: Vec<SheetSnapshotWire>,
    pub formats: Vec<FormatDefWire>,
    pub date_system: String,
    pub version: String,
    pub schema_version: u16,
}

// ---- request bodies (transport-specific; not part of the frozen DTO set) ----

/// `add-sheet` body. `chunkRows` is the per-sheet row partition size (>= 1).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSheetBody {
    pub name: String,
    pub chunk_rows: u32,
}

/// `set-value` body: a cell address + the discriminated-union value.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetValueBody {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    pub value: CellValueWire,
}

/// `set-formula` body. `text` is the formula BODY without a leading `=`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFormulaBody {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    pub text: String,
}

/// `cell` body: a cell address.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellBody {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
}

// ---- response bodies ----

/// `POST /v1/sessions` reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResponse {
    pub session_id: String,
}

/// `GET /v1/sessions/:id/lifecycle` reply.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleResponse {
    pub state: String,
}

/// `add-sheet` reply (the assigned sheet id, u16 widened to u32 like napi).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSheetResponse {
    pub sheet_id: u32,
}

/// `recalc` reply: the operation id as a decimal string (frozen u64 convention).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcResponse {
    #[serde(with = "u64_dec")]
    pub op: u64,
}

// ---- mappers: ql_session DTO -> wire (mirror the napi `*_json_from_session` fns) ----

/// Map a [`ql_session::CellValue`] to [`CellValueWire`] (mirror of napi
/// `cell_value_json_from_session`; emits `blank`/`pending`).
pub fn cell_value_to_wire(v: ql_session::CellValue) -> CellValueWire {
    use ql_session::CellValue as V;
    let (kind, number, boolean, text, error) = match v {
        V::Number { number } => ("number", Some(number), None, None, None),
        V::Boolean { boolean } => ("boolean", None, Some(boolean), None, None),
        V::Text { text } => ("text", None, None, Some(text), None),
        V::Error { error } => ("error", None, None, None, Some(error)),
        V::Blank => ("blank", None, None, None, None),
        V::Pending => ("pending", None, None, None, None),
    };
    CellValueWire {
        kind: kind.to_string(),
        number,
        boolean,
        text,
        error,
    }
}

/// Map a [`ql_session::FormatId`] to [`FormatIdWire`] (mirror of napi
/// `format_id_json_from_session`).
pub fn format_id_to_wire(id: ql_session::FormatId) -> FormatIdWire {
    match id {
        ql_session::FormatId::Builtin { builtin } => FormatIdWire {
            kind: "builtin".to_string(),
            builtin: Some(builtin),
            custom_peer: None,
            custom_counter: None,
        },
        ql_session::FormatId::Custom { peer, counter } => FormatIdWire {
            kind: "custom".to_string(),
            builtin: None,
            custom_peer: Some(peer),
            custom_counter: Some(counter),
        },
    }
}

/// Map a [`ql_session::CellSnapshot`] to [`CellSnapshotWire`].
pub fn cell_snapshot_to_wire(c: ql_session::CellSnapshot) -> CellSnapshotWire {
    CellSnapshotWire {
        row: c.row,
        col: c.col,
        value: c.value.map(cell_value_to_wire),
        formula: c.formula,
        format: c.format.map(format_id_to_wire),
        rendered: c.rendered,
    }
}

/// Map a [`ql_session::SheetSnapshot`] to [`SheetSnapshotWire`].
pub fn sheet_snapshot_to_wire(s: ql_session::SheetSnapshot) -> SheetSnapshotWire {
    SheetSnapshotWire {
        id: u32::from(s.id),
        name: s.name,
        cells: s.cells.into_iter().map(cell_snapshot_to_wire).collect(),
    }
}

/// Map a [`ql_session::WorkbookSnapshot`] to [`WorkbookSnapshotWire`] (mirror of
/// napi `workbook_snapshot_json_from_session`; the opaque `version` token crosses
/// as lowercase hex).
pub fn workbook_snapshot_to_wire(snap: ql_session::WorkbookSnapshot) -> WorkbookSnapshotWire {
    let date_system = match snap.date_system {
        ql_session::DateSystem::Excel1900 => "Excel1900",
        ql_session::DateSystem::Excel1904 => "Excel1904",
    };
    WorkbookSnapshotWire {
        sheets: snap
            .sheets
            .into_iter()
            .map(sheet_snapshot_to_wire)
            .collect(),
        formats: snap
            .formats
            .into_iter()
            .map(|fd| FormatDefWire {
                id: format_id_to_wire(fd.id),
                string: fd.string,
            })
            .collect(),
        date_system: date_system.to_string(),
        version: hex_encode(&snap.version.0),
        schema_version: snap.schema_version,
    }
}

// ---- reverse mapper: wire -> ql_session (mirror napi `session_cell_value_from_json`) ----

/// Map a [`CellValueWire`] to a [`ql_session::CellValue`] for `set-value`. STRICT
/// tagged union (a payload field foreign to the `kind` is a malformed DTO and is
/// rejected loudly -- No-Fallbacks, mirror of napi `session_cell_value_from_json`).
/// `number` must be finite. `blank` clears the cell. `error`/`pending` are
/// engine-produced read-only states and are rejected as inputs; unknown `kind` is
/// rejected. Errors are `[bad_argument]`.
pub fn cell_value_from_wire(v: CellValueWire) -> Result<ql_session::CellValue, EngineError> {
    let CellValueWire {
        kind,
        number,
        boolean,
        text,
        error,
    } = v;
    let reject_extra = |present: bool, field: &str, kind: &str| -> Result<(), EngineError> {
        if present {
            return Err(EngineError::bad_argument(format!(
                "setValue: value kind '{kind}' must not carry a '{field}' field"
            )));
        }
        Ok(())
    };
    match kind.as_str() {
        "number" => {
            reject_extra(boolean.is_some(), "boolean", "number")?;
            reject_extra(text.is_some(), "text", "number")?;
            reject_extra(error.is_some(), "error", "number")?;
            let n = number.ok_or_else(|| {
                EngineError::bad_argument("setValue: kind 'number' requires a 'number' field")
            })?;
            if !n.is_finite() {
                return Err(EngineError::bad_argument(format!(
                    "setValue: number must be finite, got {n}"
                )));
            }
            Ok(ql_session::CellValue::Number { number: n })
        }
        "boolean" => {
            reject_extra(number.is_some(), "number", "boolean")?;
            reject_extra(text.is_some(), "text", "boolean")?;
            reject_extra(error.is_some(), "error", "boolean")?;
            let b = boolean.ok_or_else(|| {
                EngineError::bad_argument("setValue: kind 'boolean' requires a 'boolean' field")
            })?;
            Ok(ql_session::CellValue::Boolean { boolean: b })
        }
        "text" => {
            reject_extra(number.is_some(), "number", "text")?;
            reject_extra(boolean.is_some(), "boolean", "text")?;
            reject_extra(error.is_some(), "error", "text")?;
            let t = text.ok_or_else(|| {
                EngineError::bad_argument("setValue: kind 'text' requires a 'text' field")
            })?;
            Ok(ql_session::CellValue::Text { text: t })
        }
        "blank" => {
            reject_extra(number.is_some(), "number", "blank")?;
            reject_extra(boolean.is_some(), "boolean", "blank")?;
            reject_extra(text.is_some(), "text", "blank")?;
            reject_extra(error.is_some(), "error", "blank")?;
            Ok(ql_session::CellValue::Blank)
        }
        other => Err(EngineError::bad_argument(format!(
            "setValue: unsupported value kind '{other}' \
             (expected number|boolean|text|blank; 'error'/'pending' are engine-produced, read-only)"
        ))),
    }
}

/// Build a validated [`ql_session::CellAddr`] from wire coordinates. `sheet`/`row`/
/// `col` already passed serde's integer-range checks (u16/u32); this only assembles
/// the address (the engine validates sheet existence + bounds downstream).
pub fn addr(sheet: u16, row: u32, col: u32) -> ql_session::CellAddr {
    ql_session::CellAddr { sheet, row, col }
}

// ============================================================================
// Phase 6.2-1a -- cluster A (read/format/validate/query) + B (persistence) DTOs.
// ============================================================================

// ---- ranges (mirror napi CellRangeJson; coords as concrete ints, like the
//      6.2-0 SetValueBody pattern -- serde rejects non-integer/out-of-range
//      numbers loudly, faithful to napi's validate_u*_index intent) ----

/// Mirror of napi `CellRangeJson`: a rectangular range within one sheet
/// (inclusive bounds). Both Serialize (echoed back by `queryRange`) and
/// Deserialize (request input for `queryRange`/`setName`/tables).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRangeWire {
    pub sheet: u16,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Map a [`CellRangeWire`] to a [`ql_session::CellRange`]. The engine validates
/// sheet existence + inverted bounds downstream (inversion is the engine's
/// `bad_argument` for `queryRange`, normalized for `setName` -- pre-existing
/// engine behavior, not a service concern).
pub fn cell_range_from_wire(r: CellRangeWire) -> ql_session::CellRange {
    ql_session::CellRange {
        sheet: r.sheet,
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

fn cell_range_to_wire(r: ql_session::CellRange) -> CellRangeWire {
    CellRangeWire {
        sheet: r.sheet,
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

// ---- query_range (columnar; mirror napi RangeQueryOptionsJson + RangeResultJson) ----

/// Mirror of napi `RangeQueryOptionsJson`. All three flags are required (No-Fallbacks:
/// a missing flag is a loud deserialize error, not a silent default).
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeQueryOptionsWire {
    pub include_formulas: bool,
    pub include_formats: bool,
    pub include_rendered: bool,
}

/// One column of a [`RangeResultWire`] (columnar layout; mirror napi `RangeColumnJson`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeColumnWire {
    pub values: Vec<CellValueWire>,
}

/// Mirror of napi `RangeResultJson` (a batch-shaped, columnar range read).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeResultWire {
    pub schema_version: u16,
    pub range: CellRangeWire,
    pub n_rows: u32,
    pub n_cols: u32,
    pub columns: Vec<RangeColumnWire>,
}

/// Map a [`ql_session::RangeResult`] to [`RangeResultWire`] (mirror of napi
/// `range_result_json_from_session`).
pub fn range_result_to_wire(r: ql_session::RangeResult) -> RangeResultWire {
    RangeResultWire {
        schema_version: r.schema_version,
        range: cell_range_to_wire(r.range),
        n_rows: r.n_rows,
        n_cols: r.n_cols,
        columns: r
            .columns
            .into_iter()
            .map(|c| RangeColumnWire {
                values: c.values.into_iter().map(cell_value_to_wire).collect(),
            })
            .collect(),
    }
}

// ---- validate_formula (mirror napi DiagnosticJson + CellAddrJson) ----

/// Mirror of napi `CellAddrJson` (sheet widened u16 -> u32).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellAddrWire {
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
}

/// Mirror of napi `DiagnosticJson`. `severity` is `"info"`/`"warning"`/`"error"`
/// (matches the `ql_session::Severity` snake_case serde rename).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticWire {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub addr: Option<CellAddrWire>,
    pub severity: String,
    pub code: String,
    pub message: String,
}

/// Stable snake_case wire string for a [`ql_session::Severity`] (mirror napi `severity_to_str`).
pub fn severity_to_str(s: ql_session::Severity) -> &'static str {
    match s {
        ql_session::Severity::Info => "info",
        ql_session::Severity::Warning => "warning",
        ql_session::Severity::Error => "error",
    }
}

/// Map a [`ql_session::Diagnostic`] to [`DiagnosticWire`] (mirror napi `diagnostic_json_from_session`).
pub fn diagnostic_to_wire(d: ql_session::Diagnostic) -> DiagnosticWire {
    DiagnosticWire {
        addr: d.addr.map(|a| CellAddrWire {
            sheet: u32::from(a.sheet),
            row: a.row,
            col: a.col,
        }),
        severity: severity_to_str(d.severity).to_string(),
        code: d.code,
        message: d.message,
    }
}

// ---- list_sheets (mirror napi SheetInfoJson) ----

/// Mirror of napi `SheetInfoJson` (lightweight sheet descriptor; id widened u16 -> u32).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfoWire {
    pub id: u32,
    pub name: String,
}

/// Map a [`ql_session::SheetInfo`] to [`SheetInfoWire`].
pub fn sheet_info_to_wire(s: ql_session::SheetInfo) -> SheetInfoWire {
    SheetInfoWire {
        id: u32::from(s.id),
        name: s.name,
    }
}

// ---- reverse mapper: FormatIdWire -> ql_session::FormatId (set_format input) ----

/// Map a [`FormatIdWire`] to a [`ql_session::FormatId`] for `set-format`. STRICT
/// tagged union (mirror napi `session_format_id_from_json`): `builtin` requires
/// `builtin` and rejects `customPeer`/`customCounter`; `custom` requires both
/// `customPeer`+`customCounter` and rejects `builtin`; unknown kind rejected.
/// Numeric ranges are enforced by serde on deserialize (u32/u64), so this only
/// validates the tagged-union shape. Errors are `[bad_argument]` (No-Fallbacks).
pub fn format_id_from_wire(id: FormatIdWire) -> Result<ql_session::FormatId, EngineError> {
    let FormatIdWire {
        kind,
        builtin,
        custom_peer,
        custom_counter,
    } = id;
    match kind.as_str() {
        "builtin" => {
            if custom_peer.is_some() || custom_counter.is_some() {
                return Err(EngineError::bad_argument(
                    "setFormat: format id kind 'builtin' must not carry 'customPeer'/'customCounter'",
                ));
            }
            let builtin = builtin.ok_or_else(|| {
                EngineError::bad_argument("setFormat: kind 'builtin' requires a 'builtin' field")
            })?;
            Ok(ql_session::FormatId::Builtin { builtin })
        }
        "custom" => {
            if builtin.is_some() {
                return Err(EngineError::bad_argument(
                    "setFormat: format id kind 'custom' must not carry 'builtin'",
                ));
            }
            let peer = custom_peer.ok_or_else(|| {
                EngineError::bad_argument("setFormat: kind 'custom' requires a 'customPeer' field")
            })?;
            let counter = custom_counter.ok_or_else(|| {
                EngineError::bad_argument(
                    "setFormat: kind 'custom' requires a 'customCounter' field",
                )
            })?;
            Ok(ql_session::FormatId::Custom { peer, counter })
        }
        other => Err(EngineError::bad_argument(format!(
            "setFormat: unsupported format id kind '{other}' (expected builtin|custom)"
        ))),
    }
}

// ---- request bodies (cluster A + B; transport-specific) ----

/// `set-format` body: a cell address + the format id.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFormatBody {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    pub format: FormatIdWire,
}

/// `register-format` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterFormatBody {
    pub format_string: String,
}

/// `validate-formula` body: a cell address + the formula body (without leading `=`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateFormulaBody {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    pub text: String,
}

/// `query-range` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRangeBody {
    pub range: CellRangeWire,
    pub options: RangeQueryOptionsWire,
}

/// `open`/`save` body: a filesystem path.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathBody {
    pub path: String,
}

// ============================================================================
// Phase 6.2-1b -- cluster C (structure/sheets) + D (tables) DTOs.
// ============================================================================

/// Mirror of napi `TableSpecJson`: a `createTable` spec. `columnNames` is a
/// REQUIRED field (no serde default) so an omitted list is a loud deserialize
/// error -- matching napi's required-`columnNames` semantics (the engine then
/// enforces `len == cols`, zero rows/cols, overlap, etc.).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpecWire {
    pub name: String,
    pub sheet: u16,
    pub top_row: u32,
    pub top_col: u32,
    pub rows: u32,
    pub cols: u32,
    pub has_header: bool,
    pub has_totals: bool,
    pub column_names: Vec<String>,
}

/// Map a [`TableSpecWire`] to a [`ql_session::TableSpec`]. Coordinate ranges are
/// enforced by serde (u16/u32); the engine enforces the table-shape contract
/// (zero rows/cols -> `table_create_rejected`, column-name rules, overlap, etc.).
pub fn table_spec_from_wire(s: TableSpecWire) -> ql_session::TableSpec {
    ql_session::TableSpec {
        name: s.name,
        sheet: s.sheet,
        top_row: s.top_row,
        top_col: s.top_col,
        rows: s.rows,
        cols: s.cols,
        has_header: s.has_header,
        has_totals: s.has_totals,
        column_names: s.column_names,
    }
}

// ---- request bodies (cluster C + D) ----

/// `rename-sheet` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSheetBody {
    pub id: u16,
    pub new_name: String,
}

/// `delete-sheet`/`restore-sheet` body: a sheet id.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetIdBody {
    pub id: u16,
}

/// `move-sheet` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSheetBody {
    pub id: u16,
    pub new_index: u32,
}

/// `set-name` body: a defined name + its target range.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNameBody {
    pub name: String,
    pub target: CellRangeWire,
}

/// `rename-table` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTableBody {
    pub old_name: String,
    pub new_name: String,
}

/// `rename-column` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameColumnBody {
    pub table: String,
    pub old_col: String,
    pub new_col: String,
}

/// `resize-table` body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeTableBody {
    pub name: String,
    pub new_rows: u32,
    pub new_cols: u32,
    pub added_columns: Vec<String>,
    pub removed_columns: Vec<String>,
}

/// `drop-table` body: a table name.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameBody {
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        let cases: [Vec<u8>; 4] = [
            vec![],
            vec![0x00, 0x0f, 0xff, 0xa5, 0x10],
            vec![0xde, 0xad, 0xbe, 0xef],
            (0u8..=255).collect(),
        ];
        for bytes in cases {
            let enc = hex_encode(&bytes);
            // lowercase, no uppercase, only hex digits.
            assert!(enc
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert_eq!(hex_decode(&enc).unwrap(), bytes, "round-trip {enc}");
        }
        assert!(hex_decode("0").is_err(), "odd length rejected");
        assert!(hex_decode("zz").is_err(), "non-hex digit rejected");
        assert!(hex_decode("AB").is_ok(), "uppercase accepted on decode");
    }

    #[test]
    fn format_id_custom_emits_peer_as_quoted_decimal_string() {
        let w = format_id_to_wire(ql_session::FormatId::Custom {
            peer: 18_446_744_073_709_551_615, // u64::MAX
            counter: 7,
        });
        let j = serde_json::to_string(&w).unwrap();
        assert!(j.contains(r#""kind":"custom""#), "{j}");
        // FROZEN convention: u64 customPeer is a QUOTED decimal string, not a number.
        assert!(
            j.contains(r#""customPeer":"18446744073709551615""#),
            "customPeer must be a quoted decimal string: {j}"
        );
        // customCounter is an INTEGER (not 7.0); builtin omitted when None.
        assert!(j.contains(r#""customCounter":7"#), "{j}");
        assert!(!j.contains("builtin"), "None builtin must be omitted: {j}");
    }

    #[test]
    fn format_id_builtin_emits_integer_and_omits_custom() {
        let w = format_id_to_wire(ql_session::FormatId::Builtin { builtin: 164 });
        // builtin renders as the INTEGER 164 (matches napi JSON.stringify), NOT 164.0;
        // customPeer/customCounter omitted.
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"kind":"builtin","builtin":164}"#
        );
    }

    #[test]
    fn cell_value_wire_kind_shapes() {
        assert_eq!(
            serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Number {
                number: 14.0
            }))
            .unwrap(),
            r#"{"kind":"number","number":14.0}"#
        );
        assert_eq!(
            serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Blank)).unwrap(),
            r#"{"kind":"blank"}"#
        );
        assert_eq!(
            serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Pending)).unwrap(),
            r#"{"kind":"pending"}"#
        );
        assert_eq!(
            serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Text {
                text: "hi".to_string()
            }))
            .unwrap(),
            r#"{"kind":"text","text":"hi"}"#
        );
    }

    #[test]
    fn recalc_op_is_quoted_decimal_string() {
        assert_eq!(
            serde_json::to_string(&RecalcResponse { op: 42 }).unwrap(),
            r#"{"op":"42"}"#
        );
    }

    #[test]
    fn cell_value_from_wire_strict_union() {
        let mk = |kind: &str, number, error: Option<&str>| CellValueWire {
            kind: kind.to_string(),
            number,
            boolean: None,
            text: None,
            error: error.map(str::to_string),
        };
        // engine-produced read-only states rejected as inputs:
        assert!(cell_value_from_wire(mk("error", None, Some("#REF!"))).is_err());
        assert!(cell_value_from_wire(mk("pending", None, None)).is_err());
        // extraneous-for-kind payload rejected:
        assert!(cell_value_from_wire(mk("blank", Some(1.0), None)).is_err());
        // non-finite number rejected:
        assert!(cell_value_from_wire(mk("number", Some(f64::NAN), None)).is_err());
        // unknown kind rejected:
        assert!(cell_value_from_wire(mk("frobnicate", None, None)).is_err());
        // valid inputs:
        assert!(matches!(
            cell_value_from_wire(mk("number", Some(6.0), None)).unwrap(),
            ql_session::CellValue::Number { .. }
        ));
        assert!(matches!(
            cell_value_from_wire(mk("blank", None, None)).unwrap(),
            ql_session::CellValue::Blank
        ));
    }

    // ---- 6.2-1a DTO tests ----

    #[test]
    fn cell_range_wire_round_trips_camel_case() {
        let r = CellRangeWire {
            sheet: 1,
            start_row: 0,
            start_col: 2,
            end_row: 9,
            end_col: 4,
        };
        let j = serde_json::to_string(&r).unwrap();
        assert_eq!(
            j,
            r#"{"sheet":1,"startRow":0,"startCol":2,"endRow":9,"endCol":4}"#
        );
        let back: CellRangeWire = serde_json::from_str(&j).unwrap();
        let cr = cell_range_from_wire(back);
        assert_eq!(cr.sheet, 1);
        assert_eq!(cr.end_row, 9);
        assert_eq!(cr.end_col, 4);
    }

    #[test]
    fn range_result_wire_is_columnar_with_widened_keys() {
        let r = ql_session::RangeResult {
            schema_version: 1,
            range: ql_session::CellRange {
                sheet: 0,
                start_row: 0,
                start_col: 0,
                end_row: 1,
                end_col: 0,
            },
            n_rows: 2,
            n_cols: 1,
            columns: vec![ql_session::RangeColumn {
                values: vec![
                    ql_session::CellValue::Number { number: 6.0 },
                    ql_session::CellValue::Blank,
                ],
            }],
        };
        let j = serde_json::to_string(&range_result_to_wire(r)).unwrap();
        assert!(j.contains(r#""schemaVersion":1"#), "{j}");
        assert!(j.contains(r#""nRows":2"#), "{j}");
        assert!(j.contains(r#""nCols":1"#), "{j}");
        // columnar: a `columns` array, each with a `values` array of CellValueWire.
        // NOTE: `number:6.0` is the CURRENT serde rendering; the napi row emits `6`
        // (the documented 6.2-4-deferred number-encoding divergence -- see the
        // `CellValueWire` doc). This test pins the current shape, not the final
        // byte-identical wire (which 6.2-4 reconciles uniformly if byte-identical
        // comparison is chosen).
        assert!(
            j.contains(r#""columns":[{"values":[{"kind":"number","number":6.0},{"kind":"blank"}]}]"#),
            "{j}"
        );
    }

    #[test]
    fn diagnostic_wire_severity_strings() {
        let d = ql_session::Diagnostic {
            addr: Some(ql_session::CellAddr {
                sheet: 0,
                row: 3,
                col: 4,
            }),
            severity: ql_session::Severity::Error,
            code: "syntax_error".to_string(),
            message: "bad".to_string(),
        };
        let j = serde_json::to_string(&diagnostic_to_wire(d)).unwrap();
        assert!(j.contains(r#""severity":"error""#), "{j}");
        assert!(j.contains(r#""addr":{"sheet":0,"row":3,"col":4}"#), "{j}");
        // None addr is omitted (skip_serializing_if).
        let d2 = ql_session::Diagnostic {
            addr: None,
            severity: ql_session::Severity::Warning,
            code: "w".to_string(),
            message: "m".to_string(),
        };
        let j2 = serde_json::to_string(&diagnostic_to_wire(d2)).unwrap();
        assert!(!j2.contains("addr"), "None addr must be omitted: {j2}");
        assert!(j2.contains(r#""severity":"warning""#), "{j2}");
    }

    #[test]
    fn sheet_info_wire_widens_id() {
        let s = ql_session::SheetInfo {
            id: 7,
            name: "Sheet1".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&sheet_info_to_wire(s)).unwrap(),
            r#"{"id":7,"name":"Sheet1"}"#
        );
    }

    #[test]
    fn format_id_from_wire_strict_union() {
        let mk = |kind: &str,
                  builtin: Option<u32>,
                  custom_peer: Option<u64>,
                  custom_counter: Option<u32>| FormatIdWire {
            kind: kind.to_string(),
            builtin,
            custom_peer,
            custom_counter,
        };
        // builtin requires `builtin`, rejects custom payload:
        assert!(format_id_from_wire(mk("builtin", None, None, None)).is_err());
        assert!(format_id_from_wire(mk("builtin", Some(164), Some(1), None)).is_err());
        assert!(matches!(
            format_id_from_wire(mk("builtin", Some(164), None, None)).unwrap(),
            ql_session::FormatId::Builtin { builtin: 164 }
        ));
        // custom requires both, rejects builtin:
        assert!(format_id_from_wire(mk("custom", None, Some(5), None)).is_err());
        assert!(format_id_from_wire(mk("custom", Some(1), Some(5), Some(2))).is_err());
        assert!(matches!(
            format_id_from_wire(mk("custom", None, Some(5), Some(2))).unwrap(),
            ql_session::FormatId::Custom {
                peer: 5,
                counter: 2
            }
        ));
        // unknown kind rejected:
        assert!(format_id_from_wire(mk("bogus", None, None, None)).is_err());
    }

    // ---- 6.2-1b DTO tests ----

    #[test]
    fn table_spec_wire_deserializes_camel_case_and_maps() {
        // DISTINCT nonzero coordinates so a mapper that swaps/drops
        // sheet/topRow/topCol/rows/cols cannot pass (6.2-1b audit Codex LOW-1).
        let j = r#"{"name":"Sales","sheet":2,"topRow":5,"topCol":7,"rows":3,"cols":2,
                    "hasHeader":true,"hasTotals":false,"columnNames":["Qty","Price"]}"#;
        let w: TableSpecWire = serde_json::from_str(j).unwrap();
        let spec = table_spec_from_wire(w);
        // assert ALL 9 fields:
        assert_eq!(spec.name, "Sales");
        assert_eq!(spec.sheet, 2);
        assert_eq!(spec.top_row, 5);
        assert_eq!(spec.top_col, 7);
        assert_eq!(spec.rows, 3);
        assert_eq!(spec.cols, 2);
        assert!(spec.has_header);
        assert!(!spec.has_totals);
        assert_eq!(spec.column_names, vec!["Qty".to_string(), "Price".to_string()]);
    }

    #[test]
    fn table_spec_wire_requires_column_names() {
        // omitting columnNames is a loud deserialize error (no serde default),
        // matching napi's required-columnNames semantics.
        let j = r#"{"name":"T","sheet":0,"topRow":0,"topCol":0,"rows":1,"cols":1,
                    "hasHeader":false,"hasTotals":false}"#;
        assert!(serde_json::from_str::<TableSpecWire>(j).is_err());
    }
}
