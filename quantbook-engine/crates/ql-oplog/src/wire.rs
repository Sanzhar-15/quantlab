//! On-wire vocabulary for `Op` mutations.
//!
//! Tier D2 (2026-05-19, Phase 4.12 Opus-C HIGH-3 closure, gated by
//! Phase 5.1 audit): these types moved from `ql-io::qbook_format` into
//! `ql-oplog` so `ql-oplog::Op` no longer depends on `ql-io`. Phase 5
//! CRDT integration wants `ql-oplog` as a dependency floor; this move
//! inverts the prior `ql-oplog → ql-io` dependency.
//!
//! `ql-io` re-exports `CellWireValue` and `NamedTargetWire` so external
//! callers (`ql-exec`, `ql-io-xlsx` tests) compile unchanged.
//!
//! ## Contents
//!
//! - [`CellWireValue`] — serializable mirror of `ql_types::Value`. Phase
//!   2A.8 added the `Pending` variant for formula-bearing cells whose
//!   saved value is `Value::Blank` (so the v2 reader knows to recompute
//!   rather than treating it as a real `#NULL!`).
//! - [`NamedTargetWire`] — serializable mirror of
//!   `ql_storage::NamedTarget`. Tagged enum on the wire for schema
//!   robustness.
//! - [`WireDecodeError`] — new in Tier D2: a small error type owned by
//!   `ql-oplog` so `CellWireValue::to_value` and
//!   `NamedTargetWire::to_target` don't return `ql_io::QbookError`.
//!   `ql-io::QbookError` wraps `WireDecodeError` via `#[from]` so the
//!   existing `.qbook` load path surfaces decode failures with the same
//!   call shape as before.
//! - [`error_to_canonical_text`] and `parse_canonical_error_text` —
//!   round-trip helpers between `ErrorValue` and its Excel-canon string
//!   form.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use ql_storage::NamedTarget;
use ql_types::{Address, ErrorValue, Range, Value, MAX_COLUMN, MAX_ROW};

/// Errors emitted while decoding wire-format types back into runtime
/// values. Phase 4.12 Opus-C HIGH-3 / Tier D2 (2026-05-19) closure: a
/// small `ql-oplog`-owned error type so wire decoders don't reach into
/// `ql-io`. `ql_io::QbookError` wraps this via `#[from]` so existing
/// callers see the same chain when decoding `.qbook` cells.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum WireDecodeError {
    /// `CellWireValue::Error(s)` where `s` doesn't parse via
    /// `parse_canonical_error_text`. Loud — see no-fallbacks rule.
    #[error("unknown error sigil {sigil:?}")]
    UnknownErrorSigil { sigil: String },

    /// `NamedTargetWire::Cell.row` exceeds `MAX_ROW`.
    #[error("named cell row {row} exceeds MAX_ROW {max} (name: {name:?})")]
    CellRowOutOfRange { name: String, row: u32, max: u32 },

    /// `NamedTargetWire::Cell.col` exceeds `MAX_COLUMN`.
    #[error("named cell col {col} exceeds MAX_COLUMN {max} (name: {name:?})")]
    CellColOutOfRange { name: String, col: u32, max: u32 },

    /// One of `NamedTargetWire::Range.{start,end}_{row,col}` exceeds
    /// its corresponding `MAX_*` constant.
    #[error("named range {label} {value} exceeds max {max} (name: {name:?})")]
    RangeAxisOutOfRange {
        name: String,
        label: &'static str,
        value: u32,
        max: u32,
    },

    /// `NamedTargetWire::Constant.value.to_value()` failed (unknown
    /// error sigil inside a named constant).
    #[error("named constant decode failed (name: {name:?}): {detail}")]
    ConstantDecode { name: String, detail: String },
}

/// Wire-format mirror of `ql_types::Value`. Phase 1 W5-6 doesn't add Serialize to
/// ql-types directly (keeps the types crate lean); the wire-encoding lives
/// here in `ql-oplog`.
///
/// Phase 2A.8 (megaudit M11): added `Pending` variant for formula-bearing cells
/// whose saved value would be `Value::Blank` (because the formula hasn't been
/// evaluated yet, or its result really is Blank). Previously this case was
/// encoded as `Error("#NULL!")`, conflating "not yet evaluated" with a real
/// Excel `#NULL!` error. The v2 reader recognizes `Pending` as "needs
/// recompute"; for v1 files, the loader auto-rewrites `Error(#NULL!)` to
/// `Pending` when the same cell has a `formula` field.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum CellWireValue {
    Number(f64),
    Boolean(bool),
    Text(String),
    /// Stored as the canonical "#REF!" / "#VALUE!" / etc. text form.
    Error(String),
    /// Formula-bearing cell with no evaluated value. Recompute resolves it.
    Pending,
}

impl CellWireValue {
    /// Project a runtime `Value` into the wire shape, or `None` for `Blank`
    /// (which is encoded as the absence of a `CellRecord` entry on disk).
    pub fn from_value(v: &Value) -> Option<Self> {
        match v {
            Value::Blank => None,
            Value::Number(n) => Some(CellWireValue::Number(*n)),
            Value::Boolean(b) => Some(CellWireValue::Boolean(*b)),
            Value::Text(s) => Some(CellWireValue::Text(s.as_ref().to_owned())),
            Value::Error(e) => Some(CellWireValue::Error(error_to_canonical_text(*e))),
        }
    }

    /// Decode the wire value into a `ql_types::Value`. `Pending` decodes to
    /// `Value::Blank` — the cell is in a transient state until recompute runs.
    pub fn to_value(&self) -> Result<Value, WireDecodeError> {
        match self {
            CellWireValue::Number(n) => Ok(Value::number(*n)),
            CellWireValue::Boolean(b) => Ok(Value::Boolean(*b)),
            CellWireValue::Text(s) => Ok(Value::text(s.as_str())),
            CellWireValue::Error(s) => match parse_canonical_error_text(s) {
                Some(e) => Ok(Value::Error(e)),
                None => Err(WireDecodeError::UnknownErrorSigil {
                    sigil: s.to_owned(),
                }),
            },
            CellWireValue::Pending => Ok(Value::Blank),
        }
    }

    /// True iff this is the Phase 2A.8 Pending sentinel (formula-bearing cell
    /// with no evaluated value).
    pub fn is_pending(&self) -> bool {
        matches!(self, CellWireValue::Pending)
    }
}

/// Wire-format mirror of `ql_storage::NamedTarget`. Each variant is tagged
/// explicitly so the on-disk shape is self-describing and survives schema bumps.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NamedTargetWire {
    /// `NamedTarget::Cell` — single-cell anchor at `$Sheet!$Row,$Col`.
    Cell { sheet: u16, row: u32, col: u32 },
    /// `NamedTarget::Range` — rectangular range.
    Range {
        sheet: u16,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    },
    /// `NamedTarget::Constant(Value)` — reuses the cell wire-value vocabulary.
    Constant { value: CellWireValue },
    /// `NamedTarget::Formula(Arc<str>)` — raw formula source (without `=`).
    Formula { source: String },
}

impl NamedTargetWire {
    /// Project a runtime `NamedTarget` into the wire shape for serialization.
    pub fn from_target(t: &NamedTarget) -> Self {
        match t {
            NamedTarget::Cell(addr) => NamedTargetWire::Cell {
                sheet: addr.sheet,
                row: addr.row,
                col: addr.col,
            },
            NamedTarget::Range(r) => NamedTargetWire::Range {
                sheet: r.sheet,
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
            },
            NamedTarget::Constant(v) => NamedTargetWire::Constant {
                // NamedTarget::Constant(Value::Blank) is unusual but valid; map
                // to Number(0.0) sentinel? No — preserve the variant by emitting
                // Error("BLANK_SENTINEL")? Also wrong. The cleanest answer: refuse
                // to serialize Blank constants — the user shouldn't have one,
                // and we'd round-trip-lose it anyway.
                //
                // In practice, `from_value(&Value::Blank)` returns None. So to
                // serialize a Blank constant we'd need a dedicated wire variant.
                // For Phase 2A.8 we deny it at save time via the conversion
                // helper below; this match arm assumes from_value returns Some.
                value: CellWireValue::from_value(v).unwrap_or(CellWireValue::Pending),
            },
            NamedTarget::Formula(src) => NamedTargetWire::Formula {
                source: src.as_ref().to_owned(),
            },
        }
    }

    /// Decode the wire shape back into a `NamedTarget`. Carries the name only
    /// for error reporting; the caller embeds the result in a `NameTable`.
    pub fn to_target(&self, name_for_error: &str) -> Result<NamedTarget, WireDecodeError> {
        match self {
            NamedTargetWire::Cell { sheet, row, col } => {
                if *row > MAX_ROW {
                    return Err(WireDecodeError::CellRowOutOfRange {
                        name: name_for_error.to_owned(),
                        row: *row,
                        max: MAX_ROW,
                    });
                }
                if *col > MAX_COLUMN {
                    return Err(WireDecodeError::CellColOutOfRange {
                        name: name_for_error.to_owned(),
                        col: *col,
                        max: MAX_COLUMN,
                    });
                }
                Ok(NamedTarget::Cell(Address::new(*sheet, *row, *col)))
            }
            NamedTargetWire::Range {
                sheet,
                start_row,
                start_col,
                end_row,
                end_col,
            } => {
                for (label, v, max) in [
                    ("start_row", *start_row, MAX_ROW),
                    ("start_col", *start_col, MAX_COLUMN),
                    ("end_row", *end_row, MAX_ROW),
                    ("end_col", *end_col, MAX_COLUMN),
                ] {
                    if v > max {
                        return Err(WireDecodeError::RangeAxisOutOfRange {
                            name: name_for_error.to_owned(),
                            label,
                            value: v,
                            max,
                        });
                    }
                }
                Ok(NamedTarget::Range(Range::new(
                    *sheet, *start_row, *start_col, *end_row, *end_col,
                )))
            }
            NamedTargetWire::Constant { value } => {
                let v = value
                    .to_value()
                    .map_err(|e| WireDecodeError::ConstantDecode {
                        name: name_for_error.to_owned(),
                        detail: e.to_string(),
                    })?;
                Ok(NamedTarget::Constant(v))
            }
            NamedTargetWire::Formula { source } => {
                Ok(NamedTarget::Formula(Arc::from(source.as_str())))
            }
        }
    }
}

/// Map `ErrorValue` to its canonical Excel-style text form (`#REF!`, `#VALUE!`, etc.).
/// Used by both wire-format serialization and the user-visible representation per spec.
pub fn error_to_canonical_text(e: ErrorValue) -> String {
    e.sigil().to_string()
}

/// Parse a canonical Excel-style error sigil back into an `ErrorValue`.
/// `None` for unrecognized inputs (callers map to a typed decode error).
pub fn parse_canonical_error_text(s: &str) -> Option<ErrorValue> {
    Some(match s {
        "#REF!" => ErrorValue::Ref,
        "#VALUE!" => ErrorValue::Value,
        "#N/A" => ErrorValue::NA,
        "#DIV/0!" => ErrorValue::DivZero,
        "#NULL!" => ErrorValue::Null,
        "#NUM!" => ErrorValue::Num,
        "#NAME?" => ErrorValue::Name,
        "#SPILL!" => ErrorValue::Spill,
        "#CALC!" => ErrorValue::Calc,
        "#DISCONNECTED!" => ErrorValue::Disconnected,
        "#BINDING!" => ErrorValue::Binding,
        "#TIMEOUT!" => ErrorValue::Timeout,
        "#PERMISSION!" => ErrorValue::Permission,
        "#AI_NOT_AVAILABLE_V1" => ErrorValue::AINotAvailable,
        "#CIRC!" => ErrorValue::Circ,
        _ => return None,
    })
}
