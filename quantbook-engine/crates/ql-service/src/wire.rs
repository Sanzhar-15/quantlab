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
}
