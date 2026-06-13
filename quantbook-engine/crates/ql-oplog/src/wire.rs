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
use ql_types::{Address, ErrorValue, PeerId, Range, Value, LEGACY_PEER, MAX_COLUMN, MAX_ROW};

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

/// Wire-format mirror of the (forthcoming) `ql_storage::FormatId` tagged
/// tuple introduced in **Phase 5.2 D-1 step 3**. Step 2 (2026-05-19) ships
/// this wire type ahead of the storage-side change; step 4 wires it into
/// `Op::RegisterFormat` / `Op::SetCellFormat`.
///
/// Two variants:
/// - `Builtin { id }` — Excel-canonical built-in format ids (0..=163).
///   Stable across peers; no merge collisions possible.
/// - `Custom { peer, counter }` — peer-allocated custom format ids.
///   Each peer's allocator increments its own `counter`; concurrent
///   peers can't collide because `peer` differs.
///
/// Serde shape is `#[serde(tag = "kind", rename_all = "lowercase")]`,
/// mirroring `NamedTargetWire`: self-describing JSON for schema
/// robustness in the `.qbook` envelope. `peer` is a raw `u64`
/// (`PeerId` is `#[serde(transparent)]`).
///
/// ```text
/// {"kind": "builtin", "id": 14}
/// {"kind": "custom", "peer": 42, "counter": 7}
/// ```
///
/// The collision-freedom guarantee (Phase 5.1 audit-locked decision D-1)
/// comes from the `Custom` variant carrying the originating peer's id:
/// two concurrent peers with distinct `peer` values can both allocate
/// `counter = 0` without colliding because the full `FormatId` differs
/// in its `peer` component.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum FormatIdWire {
    Builtin { id: u32 },
    Custom { peer: PeerId, counter: u32 },
}

/// First xlsx custom-format `numFmtId`, mirroring Excel + OpenFormula
/// conventions. Built-in format ids occupy `0..=FIRST_XLSX_BUILTIN_MAX`;
/// custom format ids start at `FIRST_XLSX_CUSTOM_NUMFMT = 164`. Pre-5.2
/// `.qbook` saves used this boundary to allocate single-writer custom
/// ids; the step-5 envelope-migration `from_u32_legacy` reads it back.
const FIRST_XLSX_BUILTIN_MAX: u32 = 163;

impl FormatIdWire {
    /// **Phase 5.2 D-1 step 2 migration helper (born here, used by step
    /// 5's qbook envelope loader):** map a pre-5.2 bare-`u32` `FormatId`
    /// encoding to the new tagged-tuple wire shape.
    ///
    /// Pre-5.2 encoding: `FormatId` was `pub struct FormatId(pub u32)`.
    /// Values `0..=FIRST_XLSX_BUILTIN_MAX` are Excel-canonical built-in
    /// format ids. Values `>= FIRST_XLSX_BUILTIN_MAX + 1` were allocated
    /// by the engine's single-writer custom counter, starting at
    /// `FIRST_XLSX_BUILTIN_MAX + 1 = 164`.
    ///
    /// Migration mapping:
    /// - `n <= 163` → `Builtin { id: n }`.
    /// - `n >= 164` → `Custom { peer: LEGACY_PEER, counter: n - 164 }`.
    ///
    /// `LEGACY_PEER = PeerId(0)` is the sentinel for "this custom id
    /// was allocated by a pre-collab single-writer save"; per Phase
    /// 5.2.b's distinct-peer-id requirement, no live peer should use
    /// peer-id 0, so legacy ids can't collide with custom ids allocated
    /// by an active session.
    pub fn from_u32_legacy(n: u32) -> Self {
        if n <= FIRST_XLSX_BUILTIN_MAX {
            FormatIdWire::Builtin { id: n }
        } else {
            FormatIdWire::Custom {
                peer: LEGACY_PEER,
                counter: n - (FIRST_XLSX_BUILTIN_MAX + 1),
            }
        }
    }

    /// **Phase 5.2 D-1 step 4 (2026-05-20):** project the storage-side
    /// [`ql_storage::FormatId`] into the wire shape. Each variant
    /// maps directly to its wire-side counterpart with identical
    /// payload.
    pub fn from_storage(id: ql_storage::FormatId) -> Self {
        match id {
            ql_storage::FormatId::Builtin(n) => FormatIdWire::Builtin { id: n },
            ql_storage::FormatId::Custom(peer, counter) => FormatIdWire::Custom { peer, counter },
        }
    }

    /// **Phase 5.2 D-1 step 4 (2026-05-20):** decode the wire shape
    /// into the storage-side [`ql_storage::FormatId`]. Inverse of
    /// [`from_storage`]. Lossless — both types carry the same
    /// information.
    pub fn to_storage(self) -> ql_storage::FormatId {
        match self {
            FormatIdWire::Builtin { id } => ql_storage::FormatId::Builtin(id),
            FormatIdWire::Custom { peer, counter } => ql_storage::FormatId::Custom(peer, counter),
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wire-format mirror of `ql_storage::StyleId`
/// (a peer-allocated `(peer, counter)` tuple — NO `Builtin` variant, unlike
/// [`FormatIdWire`], because styles have no Excel-canonical global registry).
///
/// Serde shape: `{ "peer": 42, "counter": 7 }` (`peer` is a raw `u64`;
/// `PeerId` is `#[serde(transparent)]`). The op-log payload for
/// `Op::RegisterStyle` / `Op::SetCellStyle`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct StyleIdWire {
    pub peer: PeerId,
    pub counter: u32,
}

impl StyleIdWire {
    /// Project the storage-side [`ql_storage::StyleId`] into the wire shape.
    pub fn from_storage(id: ql_storage::StyleId) -> Self {
        StyleIdWire {
            peer: id.peer,
            counter: id.counter,
        }
    }

    /// Decode the wire shape into the storage-side [`ql_storage::StyleId`].
    /// Inverse of [`from_storage`]; lossless.
    pub fn to_storage(self) -> ql_storage::StyleId {
        ql_storage::StyleId {
            peer: self.peer,
            counter: self.counter,
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wire-format mirror of `ql_storage::Rgb`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(deny_unknown_fields)]
pub struct RgbWire {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl RgbWire {
    fn from_storage(c: ql_storage::Rgb) -> Self {
        RgbWire {
            r: c.r,
            g: c.g,
            b: c.b,
        }
    }
    fn to_storage(self) -> ql_storage::Rgb {
        ql_storage::Rgb {
            r: self.r,
            g: self.g,
            b: self.b,
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wire-format mirror of `ql_storage::HAlign`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum HAlignWire {
    #[default]
    General,
    Left,
    Center,
    Right,
}

impl HAlignWire {
    fn from_storage(a: ql_storage::HAlign) -> Self {
        match a {
            ql_storage::HAlign::General => HAlignWire::General,
            ql_storage::HAlign::Left => HAlignWire::Left,
            ql_storage::HAlign::Center => HAlignWire::Center,
            ql_storage::HAlign::Right => HAlignWire::Right,
        }
    }
    fn to_storage(self) -> ql_storage::HAlign {
        match self {
            HAlignWire::General => ql_storage::HAlign::General,
            HAlignWire::Left => ql_storage::HAlign::Left,
            HAlignWire::Center => ql_storage::HAlign::Center,
            HAlignWire::Right => ql_storage::HAlign::Right,
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wire-format mirror of `ql_storage::BorderStyle`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum BorderStyleWire {
    #[default]
    None,
    Thin,
    Medium,
    Thick,
    Dashed,
    Dotted,
    Double,
}

impl BorderStyleWire {
    fn from_storage(s: ql_storage::BorderStyle) -> Self {
        match s {
            ql_storage::BorderStyle::None => BorderStyleWire::None,
            ql_storage::BorderStyle::Thin => BorderStyleWire::Thin,
            ql_storage::BorderStyle::Medium => BorderStyleWire::Medium,
            ql_storage::BorderStyle::Thick => BorderStyleWire::Thick,
            ql_storage::BorderStyle::Dashed => BorderStyleWire::Dashed,
            ql_storage::BorderStyle::Dotted => BorderStyleWire::Dotted,
            ql_storage::BorderStyle::Double => BorderStyleWire::Double,
        }
    }
    fn to_storage(self) -> ql_storage::BorderStyle {
        match self {
            BorderStyleWire::None => ql_storage::BorderStyle::None,
            BorderStyleWire::Thin => ql_storage::BorderStyle::Thin,
            BorderStyleWire::Medium => ql_storage::BorderStyle::Medium,
            BorderStyleWire::Thick => ql_storage::BorderStyle::Thick,
            BorderStyleWire::Dashed => ql_storage::BorderStyle::Dashed,
            BorderStyleWire::Dotted => ql_storage::BorderStyle::Dotted,
            BorderStyleWire::Double => ql_storage::BorderStyle::Double,
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wire-format mirror of `ql_storage::BorderEdge`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(deny_unknown_fields)]
pub struct BorderEdgeWire {
    pub style: BorderStyleWire,
    pub color: RgbWire,
}

impl BorderEdgeWire {
    fn from_storage(e: ql_storage::BorderEdge) -> Self {
        BorderEdgeWire {
            style: BorderStyleWire::from_storage(e.style),
            color: RgbWire::from_storage(e.color),
        }
    }
    fn to_storage(self) -> ql_storage::BorderEdge {
        ql_storage::BorderEdge {
            style: self.style.to_storage(),
            color: self.color.to_storage(),
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wire-format mirror of `ql_storage::Style`
/// (bold/italic/fill/align + per-edge borders). Serde shape carries every
/// sub-field explicitly so the op-log + `.qbook` envelope round-trip every
/// edge {style,color} losslessly (acceptance #11).
///
/// **FE-7 (2026-06-13):** adds the font attrs `underline` / `strike`
/// (clones of `bold` / `italic`) and `text_color` (clone of `fill`). The
/// three new fields are `#[serde(default)]` so OLD op-logs / OLD `.qbook`
/// envelopes (written before FE-7, lacking these keys) still decode — the
/// absent keys default to `false` / `false` / `None`. This is the ONLY
/// divergence from the `bold`/`italic`/`fill` plumbing: those pre-FE-7 fields
/// carry no `#[serde(default)]` because no on-disk log ever lacked them; the
/// new fields MUST default-on-absent or replay/load of pre-FE-7 data would
/// fail loudly under `deny_unknown_fields`'s sibling missing-field error.
/// Newly-written data always carries the keys (no `skip_serializing_if`),
/// exactly as `bold`/`italic`/`fill` always serialize.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(deny_unknown_fields)]
pub struct StyleWire {
    pub bold: bool,
    pub italic: bool,
    /// FE-7: underline toggle. `#[serde(default)]` ⇒ absent in pre-FE-7
    /// data decodes to `false`.
    #[serde(default)]
    pub underline: bool,
    /// FE-7: strikethrough toggle. `#[serde(default)]` ⇒ absent decodes to
    /// `false`.
    #[serde(default)]
    pub strike: bool,
    pub fill: Option<RgbWire>,
    /// FE-7: font color. `#[serde(default)]` ⇒ absent decodes to `None`
    /// (clone of `fill`'s `Option` shape).
    #[serde(default)]
    pub text_color: Option<RgbWire>,
    pub align: HAlignWire,
    pub border_top: BorderEdgeWire,
    pub border_bottom: BorderEdgeWire,
    pub border_left: BorderEdgeWire,
    pub border_right: BorderEdgeWire,
}

impl StyleWire {
    /// Project the storage-side [`ql_storage::Style`] into the wire shape.
    pub fn from_storage(s: ql_storage::Style) -> Self {
        StyleWire {
            bold: s.bold,
            italic: s.italic,
            underline: s.underline,
            strike: s.strike,
            fill: s.fill.map(RgbWire::from_storage),
            text_color: s.text_color.map(RgbWire::from_storage),
            align: HAlignWire::from_storage(s.align),
            border_top: BorderEdgeWire::from_storage(s.borders.top),
            border_bottom: BorderEdgeWire::from_storage(s.borders.bottom),
            border_left: BorderEdgeWire::from_storage(s.borders.left),
            border_right: BorderEdgeWire::from_storage(s.borders.right),
        }
    }

    /// Decode the wire shape into the storage-side [`ql_storage::Style`].
    /// Inverse of [`from_storage`]; lossless.
    pub fn to_storage(self) -> ql_storage::Style {
        ql_storage::Style {
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            strike: self.strike,
            fill: self.fill.map(RgbWire::to_storage),
            text_color: self.text_color.map(RgbWire::to_storage),
            align: self.align.to_storage(),
            borders: ql_storage::Borders {
                top: self.border_top.to_storage(),
                bottom: self.border_bottom.to_storage(),
                left: self.border_left.to_storage(),
                right: self.border_right.to_storage(),
            },
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

#[cfg(test)]
mod format_id_wire_tests {
    //! Phase 5.2 D-1 step 2 (2026-05-19): tests for `FormatIdWire`.
    //!
    //! Pre-step-2 the only `FormatId` shape was `u32`. Step 2 introduces
    //! the wire-side tagged tuple; storage-side change lands in step 3.
    //! Tests pin:
    //! - Serde round-trips for both variants (no drift in JSON shape
    //!   over future Loro/serde upgrades).
    //! - `from_u32_legacy` migration boundaries (0, 163, 164, large).
    //! - Equality + Hash semantics (these matter for HashMap keying
    //!   in step 3's `FormatTable`).
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn builtin_round_trips_through_json() {
        let original = FormatIdWire::Builtin { id: 14 };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(json, r#"{"kind":"builtin","id":14}"#);
        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn custom_round_trips_through_json() {
        let original = FormatIdWire::Custom {
            peer: PeerId::new(42),
            counter: 7,
        };
        let json = serde_json::to_string(&original).unwrap();
        // `peer` is serde-transparent, so it appears as a bare u64.
        assert_eq!(json, r#"{"kind":"custom","peer":42,"counter":7}"#);
        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn from_u32_legacy_maps_zero_to_builtin() {
        // Lower boundary: `0` is the General format (built-in id 0).
        assert_eq!(
            FormatIdWire::from_u32_legacy(0),
            FormatIdWire::Builtin { id: 0 }
        );
    }

    #[test]
    fn from_u32_legacy_maps_163_to_builtin() {
        // Upper boundary of built-in range. Excel's last built-in is 163.
        assert_eq!(
            FormatIdWire::from_u32_legacy(163),
            FormatIdWire::Builtin { id: 163 }
        );
    }

    #[test]
    fn from_u32_legacy_maps_164_to_custom_counter_zero() {
        // First legacy custom id. counter starts at 0 (n - 164).
        assert_eq!(
            FormatIdWire::from_u32_legacy(164),
            FormatIdWire::Custom {
                peer: LEGACY_PEER,
                counter: 0,
            }
        );
    }

    #[test]
    fn from_u32_legacy_maps_large_to_custom() {
        // Arbitrary mid-range legacy custom id.
        assert_eq!(
            FormatIdWire::from_u32_legacy(999),
            FormatIdWire::Custom {
                peer: LEGACY_PEER,
                counter: 999 - 164,
            }
        );
    }

    #[test]
    fn equality_and_hash_consistent_across_variants() {
        // Two Builtin(14) are equal + hash-equal; Builtin(14) and
        // Custom(LEGACY_PEER, 0) (legacy-mapped from u32=164) are NOT
        // equal even though the latter encodes the same xlsx numFmtId
        // pre-migration. Step 5's loader is responsible for not mixing
        // pre- and post-migration ids in the same workbook.
        let a = FormatIdWire::Builtin { id: 14 };
        let b = FormatIdWire::Builtin { id: 14 };
        let c = FormatIdWire::Custom {
            peer: LEGACY_PEER,
            counter: 0,
        };
        assert_eq!(a, b);
        assert_ne!(a, c);
        let mut set: HashSet<FormatIdWire> = HashSet::new();
        set.insert(a);
        assert!(set.contains(&b));
        assert!(!set.contains(&c));
    }

    #[test]
    fn distinct_peers_with_same_counter_dont_collide() {
        // Phase 5.1 audit-locked decision D-1: collision-freedom relies
        // on the `peer` component being distinct for concurrent peers.
        // Verify same-counter different-peer FormatIdWires are not equal.
        let a = FormatIdWire::Custom {
            peer: PeerId::new(1),
            counter: 7,
        };
        let b = FormatIdWire::Custom {
            peer: PeerId::new(2),
            counter: 7,
        };
        assert_ne!(a, b, "same counter, different peer must NOT collide");
    }

    #[test]
    fn round_trips_worst_case_through_serde_json() {
        // Renamed from `round_trips_through_loro_value_bincode` per
        // Opus D-1 step 2 audit M2 — the test uses serde_json (which
        // is the actual `Op` wire path: log.rs:94, 129 serialize via
        // serde_json::to_string into Loro's LoroList values), not
        // bincode or LoroValue's native binary format.
        //
        // FormatIdWire will live inside `Op::RegisterFormat` (step 4).
        // The same JSON path that ops use must survive worst-case
        // PeerId + counter values without overflow or truncation.
        let original = FormatIdWire::Custom {
            peer: PeerId::new(0xdead_beef_cafe_babe),
            counter: u32::MAX,
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    // ===== Codex+Opus D-1 step 2 audit M1 closure =====
    //
    // `#[serde(deny_unknown_fields)]` rejects payloads carrying fields
    // the variant doesn't expect. The audit-locked rule "no fallbacks
    // — errors must be visible" requires that producer bugs (writing
    // an extra/misnamed field) fail loudly rather than silently drop
    // the unknown data. The tests below pin the rejection contract so
    // a future serde upgrade or accidental attribute removal can't
    // weaken the schema.

    #[test]
    fn rejects_unknown_field_in_builtin_variant() {
        // `counter` is a Custom-variant field; appearing inside Builtin
        // is producer corruption.
        let json = r#"{"kind":"builtin","id":14,"counter":7}"#;
        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "deny_unknown_fields must reject unknown field; got {result:?}"
        );
    }

    #[test]
    fn rejects_unknown_field_in_custom_variant() {
        // Symmetric to the Builtin case: `id` doesn't belong in Custom.
        let json = r#"{"kind":"custom","peer":42,"counter":7,"id":99}"#;
        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "deny_unknown_fields must reject unknown field; got {result:?}"
        );
    }

    #[test]
    fn rejects_arbitrary_top_level_extra_field() {
        // A producer that drifts the schema (e.g. adds `"comment":
        // "..."` for human readability) must be rejected so we catch
        // the drift before it lands in saved `.qbook` files.
        let json = r#"{"kind":"builtin","id":14,"comment":"general format"}"#;
        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "extra fields must be rejected; got {result:?}"
        );
    }

    #[test]
    fn rejects_unknown_kind_tag() {
        // A future variant `{"kind": "tombstoned", ...}` MUST NOT
        // silently fall through. Pin that unknown `kind` tags error.
        let json = r#"{"kind":"tombstoned","id":14}"#;
        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "unknown kind tag must be rejected; got {result:?}"
        );
    }

    // ===== Step 4 audit Opus L1 closure =====
    //
    // Direct unit tests for `FormatIdWire::from_storage` /
    // `::to_storage` round-trip across all 4 boundary points. The
    // mechanical match-arm projection is unlikely to regress, but
    // these tests document the lossless-projection contract
    // explicitly so step 5+ callers can rely on it.

    #[test]
    fn from_storage_to_storage_round_trip_for_builtin() {
        for n in [0_u32, 1, 14, 163, u32::MAX] {
            let storage = ql_storage::FormatId::Builtin(n);
            let wire = FormatIdWire::from_storage(storage);
            assert_eq!(
                wire,
                FormatIdWire::Builtin { id: n },
                "from_storage mapping for Builtin({n})"
            );
            assert_eq!(
                wire.to_storage(),
                storage,
                "round-trip storage→wire→storage for Builtin({n})"
            );
        }
    }

    #[test]
    fn from_storage_to_storage_round_trip_for_custom() {
        for (peer_u64, counter) in [
            (0_u64, 0_u32),
            (0, u32::MAX),
            (u64::MAX - 1, 0),
            (u64::MAX - 1, u32::MAX),
            (42, 7),
        ] {
            let peer = PeerId::new(peer_u64);
            let storage = ql_storage::FormatId::Custom(peer, counter);
            let wire = FormatIdWire::from_storage(storage);
            assert_eq!(
                wire,
                FormatIdWire::Custom { peer, counter },
                "from_storage mapping for Custom(PeerId({peer_u64}), {counter})"
            );
            assert_eq!(
                wire.to_storage(),
                storage,
                "round-trip storage→wire→storage for Custom"
            );
        }
    }

    #[test]
    fn to_storage_from_storage_round_trip() {
        // Reverse direction: wire→storage→wire.
        let cases = [
            FormatIdWire::Builtin { id: 0 },
            FormatIdWire::Builtin { id: 163 },
            FormatIdWire::Custom {
                peer: LEGACY_PEER,
                counter: 0,
            },
            FormatIdWire::Custom {
                peer: PeerId::new(0xdead_beef_cafe_babe),
                counter: u32::MAX,
            },
        ];
        for original in cases {
            let storage = original.to_storage();
            let back = FormatIdWire::from_storage(storage);
            assert_eq!(back, original, "wire→storage→wire identity");
        }
    }
}

#[cfg(test)]
mod style_wire_tests {
    //! FE-4 W4 (2026-06-10): tests for `StyleWire` / `StyleIdWire` and the
    //! lossless storage ↔ wire round-trips (incl. every per-edge border
    //! sub-field — acceptance #11's wire half).
    use super::*;

    fn rich_style() -> ql_storage::Style {
        let edge = ql_storage::BorderEdge {
            style: ql_storage::BorderStyle::Double,
            color: ql_storage::Rgb::new(1, 2, 3),
        };
        ql_storage::Style {
            bold: true,
            italic: true,
            underline: true,
            strike: true,
            fill: Some(ql_storage::Rgb::new(0xab, 0xcd, 0xef)),
            text_color: Some(ql_storage::Rgb::new(0x12, 0x34, 0x56)),
            align: ql_storage::HAlign::Center,
            borders: ql_storage::Borders {
                top: edge,
                bottom: ql_storage::BorderEdge {
                    style: ql_storage::BorderStyle::Thin,
                    color: ql_storage::Rgb::new(9, 9, 9),
                },
                left: ql_storage::BorderEdge::NONE,
                right: edge,
            },
        }
    }

    #[test]
    fn style_id_wire_round_trips_storage() {
        let sid = ql_storage::StyleId::new(ql_types::PeerId::new(77), 13);
        let wire = StyleIdWire::from_storage(sid);
        assert_eq!(wire.to_storage(), sid);
    }

    #[test]
    fn style_id_wire_round_trips_json() {
        let wire = StyleIdWire {
            peer: PeerId::new(42),
            counter: 7,
        };
        let json = serde_json::to_string(&wire).unwrap();
        assert_eq!(json, r#"{"peer":42,"counter":7}"#);
        let back: StyleIdWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, wire);
    }

    #[test]
    fn style_wire_round_trips_storage_every_subfield() {
        let s = rich_style();
        let wire = StyleWire::from_storage(s);
        let back = wire.to_storage();
        assert_eq!(back, s, "wire→storage must preserve every style sub-field");
        // Spot-check borders explicitly (acceptance #11 wire half).
        assert_eq!(back.borders.top.style, ql_storage::BorderStyle::Double);
        assert_eq!(back.borders.top.color, ql_storage::Rgb::new(1, 2, 3));
        assert_eq!(back.borders.bottom.style, ql_storage::BorderStyle::Thin);
        assert!(back.borders.left.is_none());
        assert_eq!(back.borders.right, back.borders.top);
        // FE-7 font attrs round-trip.
        assert!(back.underline);
        assert!(back.strike);
        assert_eq!(back.text_color, Some(ql_storage::Rgb::new(0x12, 0x34, 0x56)));
    }

    #[test]
    fn old_style_wire_without_font_attrs_decodes_with_defaults() {
        // FE-7 back-compat: a pre-FE-7 op-log / .qbook StyleWire payload has
        // NO `underline` / `strike` / `text_color` keys. It MUST still decode
        // (deny_unknown_fields only rejects EXTRA keys; the new fields are
        // `#[serde(default)]` so absence is legal) — the font attrs default
        // off / no-color. No silent coercion: a present-but-malformed value
        // still errors (serde type-checks `bold`, `align`, etc.).
        let old = r#"{
            "bold": true,
            "italic": false,
            "fill": {"r":1,"g":2,"b":3},
            "align": "left",
            "border_top": {"style":"none","color":{"r":0,"g":0,"b":0}},
            "border_bottom": {"style":"none","color":{"r":0,"g":0,"b":0}},
            "border_left": {"style":"none","color":{"r":0,"g":0,"b":0}},
            "border_right": {"style":"none","color":{"r":0,"g":0,"b":0}}
        }"#;
        let wire: StyleWire = serde_json::from_str(old).expect("pre-FE-7 payload must decode");
        let s = wire.to_storage();
        assert!(s.bold);
        assert!(!s.underline, "absent underline defaults to false");
        assert!(!s.strike, "absent strike defaults to false");
        assert_eq!(s.text_color, None, "absent text_color defaults to None");
        assert_eq!(s.fill, Some(ql_storage::Rgb::new(1, 2, 3)));
    }

    #[test]
    fn malformed_font_attr_errors_loudly() {
        // FE-7 No-Fallbacks: a present-but-wrong-typed `underline` errors,
        // never silently coerces to a default.
        let bad = r#"{
            "bold": false,
            "italic": false,
            "underline": "yes",
            "fill": null,
            "align": "general",
            "border_top": {"style":"none","color":{"r":0,"g":0,"b":0}},
            "border_bottom": {"style":"none","color":{"r":0,"g":0,"b":0}},
            "border_left": {"style":"none","color":{"r":0,"g":0,"b":0}},
            "border_right": {"style":"none","color":{"r":0,"g":0,"b":0}}
        }"#;
        let result: std::result::Result<StyleWire, _> = serde_json::from_str(bad);
        assert!(
            result.is_err(),
            "a non-bool `underline` must fail loudly, got {result:?}"
        );
    }

    #[test]
    fn style_wire_round_trips_json() {
        let wire = StyleWire::from_storage(rich_style());
        let json = serde_json::to_string(&wire).unwrap();
        let back: StyleWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, wire);
    }

    #[test]
    fn default_style_wire_round_trips() {
        let wire = StyleWire::from_storage(ql_storage::Style::default());
        assert_eq!(wire.to_storage(), ql_storage::Style::default());
        assert!(wire.fill.is_none());
    }
}
