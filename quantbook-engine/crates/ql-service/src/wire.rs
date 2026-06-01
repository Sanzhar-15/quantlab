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

// ---- ECMAScript number rendering (the frozen wire's f64 form) ----

/// Render a finite `f64` exactly as ECMAScript `Number::toString` (radix 10) -- the
/// algorithm `JSON.stringify` applies to a JS `Number`, and therefore the frozen napi
/// wire form. This resolves the 6.2-0/6.2-1a filed-forward number-encoding divergence
/// (6.2-4): serde/ryu renders `6.0` / `-0.0` / `1e21`, whereas the freeze requires
/// `6` / `0` / `1e+21`.
///
/// Backed by the `ryu-js` crate (Boa's JS-semantics Ryu), which reproduces V8's
/// shortest-decimal algorithm EXACTLY -- INCLUDING the last-digit tie-break. A
/// hand-rolled approach over Rust's own `{:e}`/`Display` is NOT byte-identical to
/// napi: Rust's shortest formatter and V8 resolve shortest-decimal ties differently
/// for ~0.025% of `f64` (e.g. `1658206780088562.2` in V8 vs `...562.3` in Rust;
/// both round-trip), which would defeat the byte-identical golden-parity goal. This
/// was caught by the 6.2-4 closure megaudit (HIGH-1) via a Node differential fuzz.
///
/// Caller MUST pass a finite value (the only `CellValue::Number` the engine produces);
/// non-finite is rejected upstream by [`ecma_opt_number`] as a serde error (No-Fallbacks
/// -> `serde_json::to_*` returns `Err` -> the router maps it to a 500), so this fn never
/// sees `NaN`/`Inf` on the wire path.
pub fn ecma_number_string(value: f64) -> String {
    debug_assert!(
        value.is_finite(),
        "ecma_number_string requires a finite f64 (non-finite is rejected in ecma_opt_number)"
    );
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(value).to_owned()
}

/// Serde adapter for an `Option<f64>` wire field that must cross as an ECMAScript
/// `Number` token (unquoted) rather than serde/ryu's `f64` form. Serialize rejects
/// non-finite as a serde error (No-Fallbacks: surfaced as a 500, never a panic or a
/// malformed token), then routes the value through [`ecma_number_string`] and emits it
/// as a raw JSON number via [`serde_json::value::RawValue`] (the ES token is always a
/// valid JSON number literal: `6`, `0`, `0.5`, `1e+21`, `1e-7`). Deserialize reads a
/// JSON number back into `f64` unchanged. This layer is serde_json-specific by design
/// (the wire is JSON); `RawValue` requires the `serde_json` `raw_value` feature.
pub mod ecma_opt_number {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::value::RawValue;

    use super::ecma_number_string;

    pub fn serialize<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(n) => {
                if !n.is_finite() {
                    // No-Fallbacks: a non-finite cell value must not silently ship a
                    // bogus token. `serde_json::to_*` propagates this `Err`; the router's
                    // `json()` maps a serialization error to a 500 problem+json.
                    return Err(serde::ser::Error::custom(format!(
                        "non-finite f64 ({n}) cannot cross the JSON wire"
                    )));
                }
                let raw =
                    RawValue::from_string(ecma_number_string(*n)).map_err(serde::ser::Error::custom)?;
                raw.serialize(s)
            }
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        Option::<f64>::deserialize(d)
    }
}

// ---- value DTOs (mirror the napi FooJson structs) ----

/// Mirror of napi `CellValueJson`: a `kind`-tagged union. Exactly one payload
/// field is present for `number`/`boolean`/`text`/`error`; `blank`/`pending`
/// carry only `kind`.
///
/// **Number-encoding divergence RESOLVED in 6.2-4 (was 6.2-0/6.2-1a filed-forward;
/// 6.2-1a Codex HIGH).** `number` now crosses via the [`ecma_opt_number`] serde
/// adapter, which renders the `f64` with [`ecma_number_string`] (ECMAScript
/// `Number::toString`) and emits it as an UNQUOTED JSON number token. This makes
/// the service wire byte-identical to the napi row, which crosses a JS `Number`
/// via `JSON.stringify`. The cases that previously diverged are now matched:
///
/// - integer-valued floats: `6` (was serde `6.0`) -- the headline case;
/// - signed zero: `0` (was serde `-0.0`);
/// - exponent thresholds + format: `1e+21` / `1e-7` at the ECMAScript `>=1e21` /
///   `<1e-6` boundaries (was ryu's differing thresholds/format).
///
/// Non-finite (`NaN`/`Inf`) is fail-loud: [`ecma_opt_number`] returns a serde error
/// (the engine never emits them as `CellValue::Number` and `cell_value_from_wire`
/// rejects them on INPUT; the error surfaces as a 500, never a silent/malformed token).
///
/// Applies to EVERY number-emitting endpoint uniformly via [`cell_value_to_wire`]:
/// `snapshot` (6.2-0), `queryRange` (6.2-1a), `cell`, and `snapshot-delta`
/// changedCells. Gated by the `ecma_number_string` unit table + the
/// `number_encoding_http.rs` raw-bytes test + the parity matrix's service-vs-node
/// byte check (6.2-4).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValueWire {
    pub kind: String,
    #[serde(
        with = "ecma_opt_number",
        skip_serializing_if = "Option::is_none",
        default
    )]
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

// ============================================================================
// Phase 6.2-1c -- cluster E (atomic/txn + reserved bulk) + undo/redo +
// snapshotDelta + functions DTOs.
// ============================================================================

// ---- session ops (mirror napi SessionOpJson; the batch/txn op union) ----

/// Mirror of napi `SessionOpJson`: one buffered mutation in a `batch`/transaction,
/// a `kind`-tagged STRICT union over the 4-variant [`ql_session::session::SessionOp`].
/// Exactly one payload per `kind`: `setValue`->`value`, `setFormula`->`text`,
/// `setFormat`->`format`, `clear`->none. `sheet`/`row`/`col` are concrete ints
/// (serde rejects non-integer/out-of-range loudly, faithful to napi's validation).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpWire {
    pub kind: String,
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<CellValueWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub format: Option<FormatIdWire>,
}

/// Map a [`SessionOpWire`] to a [`ql_session::session::SessionOp`] (mirror napi
/// `session_op_from_json`). STRICT tagged union: each `kind` admits ONLY its own
/// payload; an extraneous-for-kind field or a missing required payload is a loud
/// `[bad_argument]` (No-Fallbacks). Reuses [`cell_value_from_wire`]/
/// [`format_id_from_wire`]/[`addr`].
pub fn session_op_from_wire(op: SessionOpWire) -> Result<ql_session::session::SessionOp, EngineError> {
    use ql_session::session::SessionOp;
    let SessionOpWire {
        kind,
        sheet,
        row,
        col,
        value,
        text,
        format,
    } = op;
    let addr = addr(sheet, row, col);
    let reject_extra = |present: bool, field: &str, kind: &str| -> Result<(), EngineError> {
        if present {
            return Err(EngineError::bad_argument(format!(
                "SessionOp kind '{kind}' must not carry a '{field}' field"
            )));
        }
        Ok(())
    };
    match kind.as_str() {
        "setValue" => {
            reject_extra(text.is_some(), "text", "setValue")?;
            reject_extra(format.is_some(), "format", "setValue")?;
            let value = value.ok_or_else(|| {
                EngineError::bad_argument("SessionOp kind 'setValue' requires a 'value' field")
            })?;
            Ok(SessionOp::SetValue {
                addr,
                value: cell_value_from_wire(value)?,
            })
        }
        "setFormula" => {
            reject_extra(value.is_some(), "value", "setFormula")?;
            reject_extra(format.is_some(), "format", "setFormula")?;
            let text = text.ok_or_else(|| {
                EngineError::bad_argument("SessionOp kind 'setFormula' requires a 'text' field")
            })?;
            Ok(SessionOp::SetFormula { addr, text })
        }
        "clear" => {
            reject_extra(value.is_some(), "value", "clear")?;
            reject_extra(text.is_some(), "text", "clear")?;
            reject_extra(format.is_some(), "format", "clear")?;
            Ok(SessionOp::Clear { addr })
        }
        "setFormat" => {
            reject_extra(value.is_some(), "value", "setFormat")?;
            reject_extra(text.is_some(), "text", "setFormat")?;
            let format = format.ok_or_else(|| {
                EngineError::bad_argument("SessionOp kind 'setFormat' requires a 'format' field")
            })?;
            Ok(SessionOp::SetFormat {
                addr,
                format: format_id_from_wire(format)?,
            })
        }
        other => Err(EngineError::bad_argument(format!(
            "unknown SessionOp kind '{other}' (expected setValue|setFormula|clear|setFormat)"
        ))),
    }
}

/// `batch` options (mirror napi `BatchOptionsJson`). `undoLabel` is optional.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOptionsWire {
    #[serde(default)]
    pub undo_label: Option<String>,
}

/// Result of `batch`/`commitTransaction` (mirror napi `BatchResultJson`). `applied`
/// is the op count (integer); `version` is the opaque post-batch token as hex.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResultWire {
    pub applied: u32,
    pub version: String,
}

/// Map a [`ql_session::BatchResult`] to [`BatchResultWire`] (version -> hex).
pub fn batch_result_to_wire(r: ql_session::BatchResult) -> BatchResultWire {
    BatchResultWire {
        applied: r.applied,
        version: hex_encode(&r.version.0),
    }
}

/// `beginTransaction` reply: the opaque transaction id as a decimal string (the
/// frozen u64 convention; napi crosses it as a `BigInt`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResponse {
    #[serde(with = "u64_dec")]
    pub txn: u64,
}

/// `txn-add` body: the transaction id (decimal string) + the op to stage.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnAddBody {
    #[serde(with = "u64_dec")]
    pub txn: u64,
    pub op: SessionOpWire,
}

/// `commit-transaction`/`rollback-transaction` body: the transaction id.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnIdBody {
    #[serde(with = "u64_dec")]
    pub txn: u64,
}

/// `batch` body: the ops + options.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchBody {
    pub ops: Vec<SessionOpWire>,
    pub options: BatchOptionsWire,
}

// ---- undo/redo (mirror napi UndoRedoResultJson) ----

/// Result of `undo`/`redo` (mirror napi `UndoRedoResultJson`). `consumed: false`
/// means the stack was empty (a normal outcome, NOT an error); `version` is the
/// opaque post-step token as hex.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoResultWire {
    pub consumed: bool,
    pub version: String,
}

/// Map a [`ql_session::UndoRedoResult`] to [`UndoRedoResultWire`] (version -> hex).
pub fn undo_redo_result_to_wire(r: ql_session::UndoRedoResult) -> UndoRedoResultWire {
    UndoRedoResultWire {
        consumed: r.consumed,
        version: hex_encode(&r.version.0),
    }
}

// ---- snapshot-delta (mirror napi WorkbookSnapshotDeltaJson) ----

/// A changed cell in a delta (mirror napi `ChangedCellJson`; sheet widened u16 -> u32).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedCellWire {
    pub sheet: u32,
    pub cell: CellSnapshotWire,
}

/// A removed (cleared) cell in a delta (mirror napi `RemovedCellJson`).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedCellWire {
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
}

/// Mirror of napi `WorkbookSnapshotDeltaJson` (the `snapshotDelta` return). Field
/// order matches the napi DTO (`schemaVersion` last). `version` is the opaque token
/// as hex; `fullRebuildReason` is a snake_case [`ql_session::FullRebuildReason`]
/// string, present (`skip_serializing_if`) only alongside a required rebuild.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookSnapshotDeltaWire {
    pub changed_cells: Vec<ChangedCellWire>,
    pub removed_cells: Vec<RemovedCellWire>,
    pub sheets_changed: Vec<SheetSnapshotWire>,
    pub sheets_removed: Vec<u32>,
    pub formats_added: Vec<FormatDefWire>,
    pub version: String,
    pub full_rebuild_required: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub full_rebuild_reason: Option<String>,
    pub schema_version: u16,
}

/// Stable snake_case wire string for a [`ql_session::FullRebuildReason`] (mirror
/// napi `full_rebuild_reason_str`; matches the enum's `#[serde(rename_all = "snake_case")]`).
pub fn full_rebuild_reason_str(r: ql_session::FullRebuildReason) -> &'static str {
    match r {
        ql_session::FullRebuildReason::NoPriorVersion => "no_prior_version",
        ql_session::FullRebuildReason::CacheCleared => "cache_cleared",
        ql_session::FullRebuildReason::StaleHorizon => "stale_horizon",
        ql_session::FullRebuildReason::EpochMismatch => "epoch_mismatch",
    }
}

/// Map a [`ql_session::WorkbookSnapshotDelta`] to [`WorkbookSnapshotDeltaWire`]
/// (mirror napi `workbook_snapshot_delta_json_from_session`; reuses the cell/sheet/
/// format snapshot mappers; forwards the engine delta's own `schema_version`).
pub fn workbook_snapshot_delta_to_wire(
    delta: ql_session::WorkbookSnapshotDelta,
) -> WorkbookSnapshotDeltaWire {
    WorkbookSnapshotDeltaWire {
        changed_cells: delta
            .changed_cells
            .into_iter()
            .map(|c| ChangedCellWire {
                sheet: u32::from(c.sheet),
                cell: cell_snapshot_to_wire(c.cell),
            })
            .collect(),
        removed_cells: delta
            .removed_cells
            .into_iter()
            .map(|r| RemovedCellWire {
                sheet: u32::from(r.sheet),
                row: r.row,
                col: r.col,
            })
            .collect(),
        sheets_changed: delta
            .sheets_changed
            .into_iter()
            .map(sheet_snapshot_to_wire)
            .collect(),
        sheets_removed: delta.sheets_removed.into_iter().map(u32::from).collect(),
        formats_added: delta
            .formats_added
            .into_iter()
            .map(|fd| FormatDefWire {
                id: format_id_to_wire(fd.id),
                string: fd.string,
            })
            .collect(),
        version: hex_encode(&delta.version.0),
        full_rebuild_required: delta.full_rebuild_required,
        full_rebuild_reason: delta
            .full_rebuild_reason
            .map(|r| full_rebuild_reason_str(r).to_string()),
        schema_version: delta.schema_version,
    }
}

/// `snapshot-delta` body: the caller's opaque `version` token (hex). This is the
/// FIRST version-consuming endpoint; the hex is decoded via [`hex_decode`] into a
/// [`ql_session::SessionVersion`] (an odd-length/non-hex token is a loud
/// `invalid_version_token`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDeltaBody {
    pub version: String,
}

// ---- functions (mirror napi ArityJson + FunctionMetadataJson) ----

/// Mirror of napi `ArityJson`: a strict tagged union on `kind`. `n`/`min`/`max` are
/// concrete `u32` on the wire (serde rejects non-integer/out-of-range loudly -- no
/// ECMAScript `ToUint32` coercion hole exists here, so the napi `f64`-then-validate
/// dance is unneeded; the engine values are whole `u8`s, emitted as integers like
/// [`FormatIdWire`] `builtin`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArityWire {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub n: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub min: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max: Option<u32>,
}

/// Map an [`ArityWire`] to a [`ql_session::Arity`] (mirror napi `arity_from_json`):
/// strict tagged union (each `kind` admits ONLY its payload), `u8`-range checked,
/// inverted range rejected. Errors are `[bad_argument]` (No-Fallbacks).
pub fn arity_from_wire(a: ArityWire) -> Result<ql_session::Arity, EngineError> {
    use ql_session::Arity;
    let to_u8 = |label: &str, v: u32| -> Result<u8, EngineError> {
        u8::try_from(v).map_err(|_| {
            EngineError::bad_argument(format!("Arity '{label}': {v} exceeds u8 range (0..=255)"))
        })
    };
    match a.kind.as_str() {
        "fixed" => {
            if a.min.is_some() || a.max.is_some() {
                return Err(EngineError::bad_argument(
                    "Arity kind 'fixed' must carry only 'n' (got 'min'/'max')",
                ));
            }
            let n = a
                .n
                .ok_or_else(|| EngineError::bad_argument("Arity kind 'fixed' requires field 'n'"))?;
            Ok(Arity::Fixed { n: to_u8("n", n)? })
        }
        "range" => {
            if a.n.is_some() {
                return Err(EngineError::bad_argument(
                    "Arity kind 'range' must carry 'min'/'max', not 'n'",
                ));
            }
            let min = a.min.ok_or_else(|| {
                EngineError::bad_argument("Arity kind 'range' requires field 'min'")
            })?;
            let min = to_u8("min", min)?;
            let max = a.max.map(|m| to_u8("max", m)).transpose()?;
            if let Some(mx) = max {
                if mx < min {
                    return Err(EngineError::bad_argument(format!(
                        "Arity 'range': max ({mx}) must be >= min ({min})"
                    )));
                }
            }
            Ok(Arity::Range { min, max })
        }
        "variadic" => {
            if a.n.is_some() || a.min.is_some() || a.max.is_some() {
                return Err(EngineError::bad_argument(
                    "Arity kind 'variadic' must carry no payload (got 'n'/'min'/'max')",
                ));
            }
            Ok(Arity::Variadic)
        }
        other => Err(EngineError::bad_argument(format!(
            "Arity: unknown kind '{other}' (expected 'fixed'|'range'|'variadic')"
        ))),
    }
}

/// Map a [`ql_session::Arity`] to [`ArityWire`] (mirror napi `arity_to_json`).
pub fn arity_to_wire(a: ql_session::Arity) -> ArityWire {
    use ql_session::Arity;
    match a {
        Arity::Fixed { n } => ArityWire {
            kind: "fixed".to_string(),
            n: Some(u32::from(n)),
            min: None,
            max: None,
        },
        Arity::Range { min, max } => ArityWire {
            kind: "range".to_string(),
            n: None,
            min: Some(u32::from(min)),
            max: max.map(u32::from),
        },
        Arity::Variadic => ArityWire {
            kind: "variadic".to_string(),
            n: None,
            min: None,
            max: None,
        },
    }
}

/// Mirror of napi `FunctionMetadataJson`. The enum-valued fields are snake_case
/// strings (validated on input). `aliases`/`provenanceTags` are REQUIRED (no serde
/// default) so an omitted list is a loud deserialize error, matching napi's
/// reject-missing semantics; the `Arity` is the only nested union.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionMetadataWire {
    pub canonical_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
    pub aliases: Vec<String>,
    pub arity: ArityWire,
    pub volatility: String,
    pub determinism: bool,
    pub dep_shape: String,
    pub batch_shape: String,
    pub arg_policy: String,
    pub cancellation: String,
    pub arg_context: String,
    pub provenance_tags: Vec<String>,
}

fn volatility_from_str(s: &str) -> Result<ql_session::Volatility, EngineError> {
    use ql_session::Volatility;
    match s {
        "pure" => Ok(Volatility::Pure),
        "volatile" => Ok(Volatility::Volatile),
        "dynamic" => Ok(Volatility::Dynamic),
        other => Err(EngineError::bad_argument(format!(
            "unknown volatility '{other}' (expected 'pure'|'volatile'|'dynamic')"
        ))),
    }
}

fn volatility_to_str(v: ql_session::Volatility) -> &'static str {
    use ql_session::Volatility;
    match v {
        Volatility::Pure => "pure",
        Volatility::Volatile => "volatile",
        Volatility::Dynamic => "dynamic",
    }
}

fn dep_shape_from_str(s: &str) -> Result<ql_session::DepShape, EngineError> {
    use ql_session::DepShape;
    match s {
        "value_deps" => Ok(DepShape::ValueDeps),
        "address_only" => Ok(DepShape::AddressOnly),
        "lazy_shape" => Ok(DepShape::LazyShape),
        "custom" => Ok(DepShape::Custom),
        other => Err(EngineError::bad_argument(format!(
            "unknown dep_shape '{other}' (expected 'value_deps'|'address_only'|'lazy_shape'|'custom')"
        ))),
    }
}

fn dep_shape_to_str(d: ql_session::DepShape) -> &'static str {
    use ql_session::DepShape;
    match d {
        DepShape::ValueDeps => "value_deps",
        DepShape::AddressOnly => "address_only",
        DepShape::LazyShape => "lazy_shape",
        DepShape::Custom => "custom",
    }
}

fn batch_shape_from_str(s: &str) -> Result<ql_session::BatchShape, EngineError> {
    use ql_session::BatchShape;
    match s {
        "scalar" => Ok(BatchShape::Scalar),
        "array_batch" => Ok(BatchShape::ArrayBatch),
        other => Err(EngineError::bad_argument(format!(
            "unknown batch_shape '{other}' (expected 'scalar'|'array_batch')"
        ))),
    }
}

fn batch_shape_to_str(b: ql_session::BatchShape) -> &'static str {
    use ql_session::BatchShape;
    match b {
        BatchShape::Scalar => "scalar",
        BatchShape::ArrayBatch => "array_batch",
    }
}

fn arg_policy_from_str(s: &str) -> Result<ql_session::ArgPolicy, EngineError> {
    use ql_session::ArgPolicy;
    match s {
        "strict" => Ok(ArgPolicy::Strict),
        "coercing" => Ok(ArgPolicy::Coercing),
        other => Err(EngineError::bad_argument(format!(
            "unknown arg_policy '{other}' (expected 'strict'|'coercing')"
        ))),
    }
}

fn arg_policy_to_str(a: ql_session::ArgPolicy) -> &'static str {
    use ql_session::ArgPolicy;
    match a {
        ArgPolicy::Strict => "strict",
        ArgPolicy::Coercing => "coercing",
    }
}

fn cancellation_from_str(s: &str) -> Result<ql_session::CancelPolicy, EngineError> {
    use ql_session::CancelPolicy;
    match s {
        "cooperative" => Ok(CancelPolicy::Cooperative),
        "worker_kill" => Ok(CancelPolicy::WorkerKill),
        "non_cancelable" => Ok(CancelPolicy::NonCancelable),
        other => Err(EngineError::bad_argument(format!(
            "unknown cancellation '{other}' (expected 'cooperative'|'worker_kill'|'non_cancelable')"
        ))),
    }
}

fn cancellation_to_str(c: ql_session::CancelPolicy) -> &'static str {
    use ql_session::CancelPolicy;
    match c {
        CancelPolicy::Cooperative => "cooperative",
        CancelPolicy::WorkerKill => "worker_kill",
        CancelPolicy::NonCancelable => "non_cancelable",
    }
}

fn arg_context_from_str(s: &str) -> Result<ql_session::function_meta::ArgContext, EngineError> {
    use ql_session::function_meta::ArgContext;
    match s {
        "scalar" => Ok(ArgContext::Scalar),
        "aggregate" => Ok(ArgContext::Aggregate),
        "reference" => Ok(ArgContext::Reference),
        other => Err(EngineError::bad_argument(format!(
            "unknown arg_context '{other}' (expected 'scalar'|'aggregate'|'reference')"
        ))),
    }
}

fn arg_context_to_str(a: ql_session::function_meta::ArgContext) -> &'static str {
    use ql_session::function_meta::ArgContext;
    match a {
        ArgContext::Scalar => "scalar",
        ArgContext::Aggregate => "aggregate",
        ArgContext::Reference => "reference",
    }
}

/// Map a [`FunctionMetadataWire`] to a [`ql_session::FunctionMetadata`] (mirror napi
/// `function_metadata_from_json`): validates every enum string; unknown strings are
/// loud `[bad_argument]`. The required string-lists are already enforced by serde
/// (no default), so an empty list here means the caller supplied it explicitly.
pub fn function_metadata_from_wire(
    m: FunctionMetadataWire,
) -> Result<ql_session::FunctionMetadata, EngineError> {
    Ok(ql_session::FunctionMetadata {
        canonical_name: m.canonical_name,
        display_name: m.display_name,
        aliases: m.aliases,
        arity: arity_from_wire(m.arity)?,
        volatility: volatility_from_str(&m.volatility)?,
        determinism: m.determinism,
        dep_shape: dep_shape_from_str(&m.dep_shape)?,
        batch_shape: batch_shape_from_str(&m.batch_shape)?,
        arg_policy: arg_policy_from_str(&m.arg_policy)?,
        cancellation: cancellation_from_str(&m.cancellation)?,
        arg_context: arg_context_from_str(&m.arg_context)?,
        provenance_tags: m.provenance_tags,
    })
}

/// Map a [`ql_session::FunctionMetadata`] to [`FunctionMetadataWire`] (mirror napi
/// `function_metadata_to_json`; total -- every Rust value maps to a string).
pub fn function_metadata_to_wire(
    m: ql_session::FunctionMetadata,
) -> FunctionMetadataWire {
    FunctionMetadataWire {
        canonical_name: m.canonical_name,
        display_name: m.display_name,
        aliases: m.aliases,
        arity: arity_to_wire(m.arity),
        volatility: volatility_to_str(m.volatility).to_string(),
        determinism: m.determinism,
        dep_shape: dep_shape_to_str(m.dep_shape).to_string(),
        batch_shape: batch_shape_to_str(m.batch_shape).to_string(),
        arg_policy: arg_policy_to_str(m.arg_policy).to_string(),
        cancellation: cancellation_to_str(m.cancellation).to_string(),
        arg_context: arg_context_to_str(m.arg_context).to_string(),
        provenance_tags: m.provenance_tags,
    }
}

/// `register-function` body: the metadata + the opaque `implHandle` (u64 decimal
/// string; napi crosses it as a `BigInt`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterFunctionBody {
    pub metadata: FunctionMetadataWire,
    #[serde(with = "u64_dec")]
    pub impl_handle: u64,
}

/// `unregister-function` body: the canonical (ASCII-uppercase) function name.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnregisterFunctionBody {
    pub canonical_name: String,
}

// ---- reserved sec-3.5 bulk request bodies (always -> Capability/501) ----

/// Parse a reserved-stub `data` payload (a JSON STRING carrying opaque JSON text;
/// mirror of napi `parse_reserved_json_payload`). The frozen napi convention crosses
/// opaque JSON as TEXT (the napi `serde-json` feature is off; same as the 6.3-1c
/// `details` convention), so the service reproduces it: `data` is a string field, and
/// malformed JSON text is a loud `[bad_argument]` (No-Fallbacks) BEFORE the engine
/// call -- matching napi exactly rather than letting non-JSON text ride through to the
/// `not_implemented_in_v1_core` 501.
pub fn parse_reserved_json_payload(method: &str, data: &str) -> Result<serde_json::Value, EngineError> {
    serde_json::from_str(data).map_err(|e| {
        EngineError::bad_argument(format!("{method}: data must be valid JSON text ({e})"))
    })
}

/// `write-range` body (reserved). A rectangular value matrix; always 501 in v1.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRangeBody {
    pub range: CellRangeWire,
    pub values: Vec<Vec<CellValueWire>>,
}

/// `publish-dataset` body (reserved). `data` is opaque JSON TEXT (a string carrying
/// JSON, mirroring napi). Always 501 in v1.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishDatasetBody {
    pub name: String,
    pub data: String,
    pub target: CellRangeWire,
}

/// `bind-range` body (reserved). Always 501 in v1.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindRangeBody {
    pub binding_id: String,
    pub target: CellRangeWire,
}

/// `refresh-source` body (reserved). `revision` is a u64 decimal string. Always 501.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSourceBody {
    pub source_id: String,
    #[serde(with = "u64_dec")]
    pub revision: u64,
}

/// `materialize-query` body (reserved). `data` is opaque JSON TEXT (a string carrying
/// JSON, mirroring napi). Always 501 in v1.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeQueryBody {
    pub query_id: String,
    pub target: CellRangeWire,
    pub data: String,
}

// ============================================================================
// Phase 6.2-2 -- operations/events DTOs (cancel/operationStatus/pollEvents +
// the SSE event stream).
// ============================================================================

/// Mirror of napi `OperationErrorJson`: the structured cause carried by a
/// `failed` operation state. Same own-property set as `error::ProblemJson` minus
/// `message` (matching napi's `OperationErrorJson`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationErrorWire {
    pub code: String,
    pub class: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
}

/// Map an [`EngineError`] to [`OperationErrorWire`] (mirror napi
/// `operation_error_json_from_engine_error`; `details` rendered only when non-empty).
pub fn operation_error_to_wire(e: &EngineError) -> OperationErrorWire {
    let details = if e.details.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&e.details)
                .unwrap_or_else(|err| format!("[details serialize failed: {err}]")),
        )
    };
    OperationErrorWire {
        code: e.code.clone(),
        class: crate::error::class_str(e.class).to_string(),
        retryable: e.retryable,
        details,
        source: e.source.clone(),
    }
}

/// Mirror of napi `OperationStateJson`: `state` is `running`/`completed`/
/// `canceled`/`failed`; `error` is present ONLY for `failed`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStateWire {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<OperationErrorWire>,
}

/// Map a [`ql_session::OperationState`] to [`OperationStateWire`] (mirror napi
/// `operation_state_json_from_session`).
pub fn operation_state_to_wire(s: ql_session::OperationState) -> OperationStateWire {
    use ql_session::OperationState as St;
    match s {
        St::Running => OperationStateWire {
            state: "running".to_string(),
            error: None,
        },
        St::Completed => OperationStateWire {
            state: "completed".to_string(),
            error: None,
        },
        St::Canceled => OperationStateWire {
            state: "canceled".to_string(),
            error: None,
        },
        St::Failed { error } => OperationStateWire {
            state: "failed".to_string(),
            error: Some(operation_error_to_wire(&error)),
        },
    }
}

/// Mirror of napi `EventJson`: a `kind`-tagged union over [`ql_session::session::Event`].
/// `op`/`done`/`total` are u64 decimal strings (napi `BigInt`); the optional payload
/// fields populate per `kind` (recalc_progress / cell_diagnostic / operation_completed
/// / provenance / structure_changed / full_resync_required).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWire {
    pub kind: String,
    #[serde(with = "opt_u64_dec", skip_serializing_if = "Option::is_none", default)]
    pub op: Option<u64>,
    #[serde(with = "opt_u64_dec", skip_serializing_if = "Option::is_none", default)]
    pub done: Option<u64>,
    #[serde(with = "opt_u64_dec", skip_serializing_if = "Option::is_none", default)]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diagnostic: Option<DiagnosticWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub state: Option<OperationStateWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub addr: Option<CellAddrWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub structure_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target: Option<String>,
}

/// Map a [`ql_session::session::Event`] to [`EventWire`] (mirror napi
/// `event_json_from_session`; reuses [`diagnostic_to_wire`] + the `CellAddrWire`
/// widening).
pub fn event_to_wire(e: ql_session::session::Event) -> EventWire {
    use ql_session::session::Event as Ev;
    let base = EventWire {
        kind: String::new(),
        op: None,
        done: None,
        total: None,
        diagnostic: None,
        state: None,
        addr: None,
        source: None,
        structure_kind: None,
        target: None,
    };
    match e {
        Ev::RecalcProgress { op, done, total } => EventWire {
            kind: "recalc_progress".to_string(),
            op: Some(op.0),
            done: Some(done),
            total: Some(total),
            ..base
        },
        Ev::CellDiagnostic { diagnostic } => EventWire {
            kind: "cell_diagnostic".to_string(),
            diagnostic: Some(diagnostic_to_wire(diagnostic)),
            ..base
        },
        Ev::OperationCompleted { op, state } => EventWire {
            kind: "operation_completed".to_string(),
            op: Some(op.0),
            state: Some(operation_state_to_wire(state)),
            ..base
        },
        Ev::Provenance { addr, source } => EventWire {
            kind: "provenance".to_string(),
            addr: Some(CellAddrWire {
                sheet: u32::from(addr.sheet),
                row: addr.row,
                col: addr.col,
            }),
            source: Some(source),
            ..base
        },
        Ev::StructureChanged { kind, target } => EventWire {
            kind: "structure_changed".to_string(),
            structure_kind: Some(kind),
            target: Some(target),
            ..base
        },
        Ev::FullResyncRequired => EventWire {
            kind: "full_resync_required".to_string(),
            ..base
        },
    }
}

/// Mirror of napi `EventPageJson`: a non-destructive page of events read from a
/// cursor. `nextCursor` is the u64 decimal string to pass on the next read.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageWire {
    pub events: Vec<EventWire>,
    #[serde(with = "u64_dec")]
    pub next_cursor: u64,
    pub dropped: bool,
}

/// Map a [`ql_session::session::EventPage`] to [`EventPageWire`] (mirror napi
/// `event_page_json_from_session`).
pub fn event_page_to_wire(p: ql_session::session::EventPage) -> EventPageWire {
    EventPageWire {
        events: p.events.into_iter().map(event_to_wire).collect(),
        next_cursor: p.next_cursor.0,
        dropped: p.dropped,
    }
}

/// `await-recalc`/`cancel` body: the operation id as a u64 decimal string (napi
/// crosses it as a `BigInt`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpBody {
    #[serde(with = "u64_dec")]
    pub op: u64,
}

// ============================================================================
// Phase 6.5-4 — §3.5 bulk result wire types (write-range / refresh-source /
// materialize-query). Mirror the napi `WriteRangeResultJson` / `DirtyResultJson`
// / `PublishedRefJson` shapes so the service is byte-identical to the napi row.
// ============================================================================

/// Mirror of napi `WriteRangeResultJson` (result of `write-range`). `written` is an
/// INTEGER cell count; `version` is the opaque post-write version token as lowercase hex.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRangeResultWire {
    pub written: u32,
    pub version: String,
}

/// Map a [`ql_session::WriteRangeResult`] to [`WriteRangeResultWire`] (version → hex).
pub fn write_range_result_to_wire(r: ql_session::WriteRangeResult) -> WriteRangeResultWire {
    WriteRangeResultWire {
        written: r.written,
        version: hex_encode(&r.version.0),
    }
}

/// Mirror of napi `DirtyResultJson` (result of `refresh-source`). `dirtied` is an
/// INTEGER dependent-cell count; `version` is the opaque post-refresh version token as
/// lowercase hex.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyResultWire {
    pub dirtied: u32,
    pub version: String,
}

/// Map a [`ql_session::DirtyResult`] to [`DirtyResultWire`] (version → hex).
pub fn dirty_result_to_wire(r: ql_session::DirtyResult) -> DirtyResultWire {
    DirtyResultWire {
        dirtied: r.dirtied,
        version: hex_encode(&r.version.0),
    }
}

/// Mirror of napi `PublishedRefJson` (result of `materialize-query`). `id` is the
/// stable artifact id (the caller's `queryId` echoed back).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedRefWire {
    pub id: String,
}

/// Map a [`ql_session::PublishedRef`] to [`PublishedRefWire`].
pub fn published_ref_to_wire(r: ql_session::PublishedRef) -> PublishedRefWire {
    PublishedRefWire { id: r.id }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecma_number_string_matches_v8_tostring() {
        // Expected values are the exact `String(x)` / `JSON.stringify(x)` outputs in
        // V8/Node -- the frozen napi wire form. Covers every case of the ES algorithm:
        // integer, fraction, leading-zero fraction, both exponent boundaries (>=1e21,
        // <1e-6), signed zero, negatives, and IEEE-754 extremes.
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (6.0, "6"),
            (14.0, "14"),
            (10.0, "10"),
            (100.0, "100"),
            (123.0, "123"),
            (-3.0, "-3"),
            (123456789.0, "123456789"),
            (0.5, "0.5"),
            (-0.5, "-0.5"),
            (0.1, "0.1"),
            (12.5, "12.5"),
            (2.5, "2.5"),
            (0.001, "0.001"),
            (0.00001, "0.00001"),
            (1e-6, "0.000001"),   // last fixed-point case (-6 < n)
            (1e-7, "1e-7"),       // first negative-exponent case (n <= -6)
            (1.5e-7, "1.5e-7"),
            (-1e-7, "-1e-7"),
            (1e20, "100000000000000000000"), // last fixed-point integer (n == 21)
            (1e21, "1e+21"),                 // first positive-exponent case (n > 21)
            (1.5e21, "1.5e+21"),
            (1.5e300, "1.5e+300"),
            (1.7976931348623157e308, "1.7976931348623157e+308"), // f64::MAX
            (5e-324, "5e-324"),                                  // smallest subnormal
            (9007199254740992.0, "9007199254740992"),            // 2^53
            (1234567890123456.0, "1234567890123456"),
            // HIGH-1 regression pins (6.2-4 megaudit): the shortest-decimal TIE-BREAK
            // band where Rust's own `{:e}`/`Display` diverges from V8 (Rust would emit
            // the `...3` form; V8 -- and ryu-js -- emit `...2`). These must match V8.
            (1658206780088562.2, "1658206780088562.2"),
            (233115890514796.12, "233115890514796.12"),
            (871790086129008.2, "871790086129008.2"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                &ecma_number_string(*input),
                expected,
                "ecma_number_string({input:?})"
            );
        }
    }

    #[test]
    fn ecma_opt_number_emits_unquoted_token_via_cell_value() {
        // The wire field is an UNQUOTED JSON number (not a string, not `6.0`).
        let j = serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Number {
            number: 6.0,
        }))
        .unwrap();
        assert_eq!(j, r#"{"kind":"number","number":6}"#);
        // Deserialize round-trips back to the f64.
        let back: CellValueWire = serde_json::from_str(&j).unwrap();
        assert_eq!(back.number, Some(6.0));
        // A genuine fraction is preserved verbatim.
        let jf = serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Number {
            number: 0.5,
        }))
        .unwrap();
        assert_eq!(jf, r#"{"kind":"number","number":0.5}"#);
    }

    #[test]
    fn ecma_opt_number_rejects_non_finite_as_serde_error() {
        // Non-finite -> a serde error (NOT a panic, NOT a malformed token). The router's
        // json() maps a serialization error to a 500 problem+json (No-Fallbacks).
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let r = serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Number {
                number: bad,
            }));
            assert!(r.is_err(), "non-finite {bad} must fail serialization, not panic");
        }
    }

    #[test]
    fn ecma_number_string_round_trips_over_random_f64() {
        // A deterministic LCG over many f64 bit patterns: every emitted ECMAScript token
        // must parse back to the EXACT same f64 (ryu-js is shortest-round-trip). This
        // guards the wiring + the ryu-js contract without needing Node at test time.
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut checked = 0u32;
        for _ in 0..50_000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let x = f64::from_bits(state);
            if !x.is_finite() {
                continue;
            }
            let token = ecma_number_string(x);
            let back: f64 = token.parse().expect("ECMAScript token parses as f64");
            // `==` (not bits) so -0.0 round-tripping to "0"->0.0 is accepted.
            assert!(back == x, "round-trip {x} -> {token} -> {back}");
            checked += 1;
        }
        assert!(checked > 40_000, "sanity: most random bit patterns are finite");
    }

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
        // 6.2-4: integer-valued numbers cross as `14` (ECMAScript form), NOT serde `14.0`.
        assert_eq!(
            serde_json::to_string(&cell_value_to_wire(ql_session::CellValue::Number {
                number: 14.0
            }))
            .unwrap(),
            r#"{"kind":"number","number":14}"#
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
        // 6.2-4: integer numbers cross as `6` (ECMAScript form via `ecma_opt_number`),
        // byte-identical to the napi row (was serde `6.0`).
        assert!(
            j.contains(r#""columns":[{"values":[{"kind":"number","number":6},{"kind":"blank"}]}]"#),
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

    // ---- 6.2-1c DTO tests ----

    #[test]
    fn session_op_wire_strict_union_and_maps() {
        use ql_session::session::SessionOp;
        // setValue requires `value`, rejects text/format.
        let j = r#"{"kind":"setValue","sheet":1,"row":2,"col":3,
                    "value":{"kind":"number","number":6}}"#;
        let op: SessionOpWire = serde_json::from_str(j).unwrap();
        assert!(matches!(
            session_op_from_wire(op).unwrap(),
            SessionOp::SetValue { .. }
        ));
        // clear admits no payload; an extraneous `value` is rejected loudly.
        let bad = SessionOpWire {
            kind: "clear".to_string(),
            sheet: 0,
            row: 0,
            col: 0,
            value: Some(CellValueWire {
                kind: "number".to_string(),
                number: Some(1.0),
                boolean: None,
                text: None,
                error: None,
            }),
            text: None,
            format: None,
        };
        assert!(session_op_from_wire(bad).is_err());
        // setFormula requires `text`.
        let missing = SessionOpWire {
            kind: "setFormula".to_string(),
            sheet: 0,
            row: 0,
            col: 0,
            value: None,
            text: None,
            format: None,
        };
        assert!(session_op_from_wire(missing).is_err());
        // unknown kind rejected.
        let unknown = SessionOpWire {
            kind: "frob".to_string(),
            sheet: 0,
            row: 0,
            col: 0,
            value: None,
            text: None,
            format: None,
        };
        assert!(session_op_from_wire(unknown).is_err());
    }

    #[test]
    fn txn_and_batch_result_use_decimal_and_hex() {
        // beginTransaction reply: u64 txn as a QUOTED decimal string.
        assert_eq!(
            serde_json::to_string(&TransactionResponse {
                txn: 18_446_744_073_709_551_615
            })
            .unwrap(),
            r#"{"txn":"18446744073709551615"}"#
        );
        // txn-add / commit bodies parse the decimal string back.
        let b: TxnAddBody = serde_json::from_str(
            r#"{"txn":"42","op":{"kind":"clear","sheet":0,"row":0,"col":0}}"#,
        )
        .unwrap();
        assert_eq!(b.txn, 42);
        // BatchResult: applied is an INTEGER, version is lowercase hex.
        let w = batch_result_to_wire(ql_session::BatchResult {
            applied: 3,
            version: ql_session::SessionVersion(vec![0xde, 0xad]),
        });
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"applied":3,"version":"dead"}"#
        );
    }

    #[test]
    fn undo_redo_result_wire_shape() {
        let w = undo_redo_result_to_wire(ql_session::UndoRedoResult {
            consumed: false,
            version: ql_session::SessionVersion(vec![0x01, 0x02]),
        });
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"consumed":false,"version":"0102"}"#
        );
    }

    #[test]
    fn workbook_snapshot_delta_wire_camel_case_and_reason() {
        // a full-rebuild delta carries the snake_case reason + empty arrays + hex version.
        let delta = ql_session::WorkbookSnapshotDelta {
            schema_version: 1,
            changed_cells: Vec::new(),
            removed_cells: Vec::new(),
            sheets_changed: Vec::new(),
            sheets_removed: Vec::new(),
            formats_added: Vec::new(),
            version: ql_session::SessionVersion(vec![0xab, 0xcd]),
            full_rebuild_required: true,
            full_rebuild_reason: Some(ql_session::FullRebuildReason::EpochMismatch),
        };
        let j = serde_json::to_string(&workbook_snapshot_delta_to_wire(delta)).unwrap();
        assert!(j.contains(r#""fullRebuildRequired":true"#), "{j}");
        assert!(j.contains(r#""fullRebuildReason":"epoch_mismatch""#), "{j}");
        assert!(j.contains(r#""version":"abcd""#), "{j}");
        assert!(j.contains(r#""schemaVersion":1"#), "{j}");
        assert!(j.contains(r#""changedCells":[]"#), "{j}");
        // a non-rebuild delta OMITS fullRebuildReason (skip_serializing_if).
        let delta2 = ql_session::WorkbookSnapshotDelta {
            schema_version: 1,
            changed_cells: Vec::new(),
            removed_cells: Vec::new(),
            sheets_changed: Vec::new(),
            sheets_removed: Vec::new(),
            formats_added: Vec::new(),
            version: ql_session::SessionVersion(vec![0x00]),
            full_rebuild_required: false,
            full_rebuild_reason: None,
        };
        let j2 = serde_json::to_string(&workbook_snapshot_delta_to_wire(delta2)).unwrap();
        assert!(
            !j2.contains("fullRebuildReason"),
            "None reason must be omitted: {j2}"
        );
    }

    #[test]
    fn arity_wire_strict_union_and_integer_emit() {
        use ql_session::Arity;
        // fixed emits `n` as an INTEGER (not 7.0).
        assert_eq!(
            serde_json::to_string(&arity_to_wire(Arity::Fixed { n: 7 })).unwrap(),
            r#"{"kind":"fixed","n":7}"#
        );
        // range with unbounded max omits `max`.
        assert_eq!(
            serde_json::to_string(&arity_to_wire(Arity::Range { min: 1, max: None })).unwrap(),
            r#"{"kind":"range","min":1}"#
        );
        // strict: fixed rejects min/max.
        assert!(arity_from_wire(ArityWire {
            kind: "fixed".to_string(),
            n: Some(2),
            min: Some(1),
            max: None,
        })
        .is_err());
        // inverted range rejected.
        assert!(arity_from_wire(ArityWire {
            kind: "range".to_string(),
            n: None,
            min: Some(5),
            max: Some(2),
        })
        .is_err());
        // u8 overflow rejected.
        assert!(arity_from_wire(ArityWire {
            kind: "fixed".to_string(),
            n: Some(256),
            min: None,
            max: None,
        })
        .is_err());
        // variadic with payload rejected.
        assert!(arity_from_wire(ArityWire {
            kind: "variadic".to_string(),
            n: Some(1),
            min: None,
            max: None,
        })
        .is_err());
    }

    #[test]
    fn function_metadata_wire_round_trips() {
        let j = r#"{"canonicalName":"MYUDF","displayName":"My UDF","aliases":["MU"],
                    "arity":{"kind":"range","min":1,"max":3},"volatility":"pure",
                    "determinism":true,"depShape":"value_deps","batchShape":"scalar",
                    "argPolicy":"strict","cancellation":"cooperative","argContext":"scalar",
                    "provenanceTags":["udf"]}"#;
        let w: FunctionMetadataWire = serde_json::from_str(j).unwrap();
        let meta = function_metadata_from_wire(w).unwrap();
        assert_eq!(meta.canonical_name, "MYUDF");
        assert_eq!(meta.aliases, vec!["MU".to_string()]);
        assert_eq!(meta.provenance_tags, vec!["udf".to_string()]);
        assert!(matches!(meta.arity, ql_session::Arity::Range { min: 1, max: Some(3) }));
        // round-trip back to wire preserves the snake_case enum strings.
        let back = serde_json::to_string(&function_metadata_to_wire(meta)).unwrap();
        assert!(back.contains(r#""volatility":"pure""#), "{back}");
        assert!(back.contains(r#""depShape":"value_deps""#), "{back}");
        assert!(back.contains(r#""argContext":"scalar""#), "{back}");
    }

    #[test]
    fn function_metadata_wire_requires_lists_and_rejects_bad_enum() {
        // omitting aliases is a loud deserialize error (no serde default).
        let missing = r#"{"canonicalName":"F","arity":{"kind":"variadic"},"volatility":"pure",
                    "determinism":true,"depShape":"value_deps","batchShape":"scalar",
                    "argPolicy":"strict","cancellation":"cooperative","argContext":"scalar",
                    "provenanceTags":[]}"#;
        assert!(serde_json::from_str::<FunctionMetadataWire>(missing).is_err());
        // an unknown enum string is a loud bad_argument at conversion.
        let bad_enum = FunctionMetadataWire {
            canonical_name: "F".to_string(),
            display_name: None,
            aliases: Vec::new(),
            arity: ArityWire {
                kind: "variadic".to_string(),
                n: None,
                min: None,
                max: None,
            },
            volatility: "bogus".to_string(),
            determinism: true,
            dep_shape: "value_deps".to_string(),
            batch_shape: "scalar".to_string(),
            arg_policy: "strict".to_string(),
            cancellation: "cooperative".to_string(),
            arg_context: "scalar".to_string(),
            provenance_tags: Vec::new(),
        };
        assert!(function_metadata_from_wire(bad_enum).is_err());
    }

    // ---- 6.2-2 DTO tests ----

    #[test]
    fn operation_state_wire_shapes() {
        // running/completed/canceled carry no error (omitted).
        assert_eq!(
            serde_json::to_string(&operation_state_to_wire(ql_session::OperationState::Running))
                .unwrap(),
            r#"{"state":"running"}"#
        );
        assert_eq!(
            serde_json::to_string(&operation_state_to_wire(
                ql_session::OperationState::Canceled
            ))
            .unwrap(),
            r#"{"state":"canceled"}"#
        );
        // failed carries the structured error.
        let w = operation_state_to_wire(ql_session::OperationState::Failed {
            error: EngineError::bad_argument("boom"),
        });
        let j = serde_json::to_string(&w).unwrap();
        assert!(j.contains(r#""state":"failed""#), "{j}");
        assert!(j.contains(r#""code":"bad_argument""#), "{j}");
        assert!(j.contains(r#""class":"bad_argument""#), "{j}");
    }

    #[test]
    fn event_wire_recalc_progress_uses_decimal_strings() {
        let w = event_to_wire(ql_session::session::Event::RecalcProgress {
            op: ql_session::OperationId(5),
            done: 3,
            total: 10,
        });
        let j = serde_json::to_string(&w).unwrap();
        assert!(j.contains(r#""kind":"recalc_progress""#), "{j}");
        // u64 op/done/total are QUOTED decimal strings (napi BigInt).
        assert!(j.contains(r#""op":"5""#), "{j}");
        assert!(j.contains(r#""done":"3""#), "{j}");
        assert!(j.contains(r#""total":"10""#), "{j}");
        // unused payload fields omitted.
        assert!(!j.contains("diagnostic"), "{j}");
        assert!(!j.contains("addr"), "{j}");
    }

    #[test]
    fn event_wire_operation_completed_nests_state() {
        let w = event_to_wire(ql_session::session::Event::OperationCompleted {
            op: ql_session::OperationId(7),
            state: ql_session::OperationState::Completed,
        });
        let j = serde_json::to_string(&w).unwrap();
        assert!(j.contains(r#""kind":"operation_completed""#), "{j}");
        assert!(j.contains(r#""op":"7""#), "{j}");
        assert!(j.contains(r#""state":{"state":"completed"}"#), "{j}");
    }

    #[test]
    fn event_wire_full_resync_is_bare_kind() {
        let w = event_to_wire(ql_session::session::Event::FullResyncRequired);
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"kind":"full_resync_required"}"#
        );
    }

    #[test]
    fn event_page_wire_next_cursor_is_decimal_string() {
        let p = event_page_to_wire(ql_session::session::EventPage {
            events: vec![ql_session::session::Event::FullResyncRequired],
            next_cursor: ql_session::session::EventCursor(42),
            dropped: false,
        });
        let j = serde_json::to_string(&p).unwrap();
        assert!(j.contains(r#""nextCursor":"42""#), "{j}");
        assert!(j.contains(r#""dropped":false"#), "{j}");
        assert!(j.contains(r#""kind":"full_resync_required""#), "{j}");
    }

    #[test]
    fn op_body_parses_decimal_string() {
        let b: OpBody = serde_json::from_str(r#"{"op":"123"}"#).unwrap();
        assert_eq!(b.op, 123);
        // a bare JSON number is rejected (the frozen convention is a quoted string).
        assert!(serde_json::from_str::<OpBody>(r#"{"op":123}"#).is_err());
    }
}
